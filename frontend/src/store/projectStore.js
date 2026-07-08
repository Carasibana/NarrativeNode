import { create } from 'zustand'
import axios from 'axios'
import { usePreviewStore } from './previewStore'

// Module-level coalescing state for `onNodesChange` dimension-burst
// batching. RF fires ~288 individual `onNodesChange` calls during the
// post-load measurement window (one per node). The accumulator below
// collects pure-dimension changes across a frame and flushes them in a
// single rAF callback so the settle costs one array write per frame, not
// 288. Mixed batches (any non-dimension change present) flush the queue
// first and process synchronously — see `onNodesChange` for the
// coordination logic.
//
// Phase 4.1g follow-up: measured dimensions are applied back to the
// nodes again (reverting the v0.4.1.10 side-store-only routing, which
// left every node without `measured` and blanked React Flow's MiniMap +
// starved its edge routing of node sizes). The broadcast that the side
// store was avoiding is now handled upstream — every heavy consumer is
// scoped to ignore dimension changes (`storyOrderNodesEqual` and the
// other structural comparators key on id/type/data/position, never
// `measured`), so a dimension write recomputes nothing and re-renders no
// chips/edges. The side store is still mirrored as a backup for the
// width/height fallback chains during the rAF-coalescing window.
let _dimQueue = []
let _dimRaf = null
// Debounce timer that holds the `_loadSettling` flag true through the
// post-load measurement burst, cleared once node sizes stop changing (see
// `onNodesChange`).
let _loadSettleTimer = null

// ── Backend auto-sync ─────────────────────────────────────────────
//
// Keeps the FastAPI backend's in-memory state at most
// BACKEND_SYNC_DELAY_MS behind frontend mutations, so a browser
// refresh during an editing session doesn't lose work between
// explicit saves. The disk-write half (POST /api/project/save) is
// NOT part of this — that remains explicit, triggered only by
// `saveProject` / `autosaveProject`. We only PUT /api/story
// (backend in-memory) here.
//
// **Throttle: trailing-edge, BACKEND_SYNC_DELAY_MS.** First mutation
// schedules a timer; subsequent mutations during the window are
// no-ops on scheduling (the pending timer captures the latest state
// when it fires). Net: at most one PUT per BACKEND_SYNC_DELAY_MS of
// activity; zero PUTs while idle.
//
// **Race safety:** `lastMutationAt` is stamped at the moment of each
// mutation (via `detectMutationMiddleware` below); `_doBackendSync`
// snapshots that timestamp BEFORE its PUT, and on success sets
// `lastSyncedAt` to the SNAPSHOTTED value (not `Date.now()`). A
// mutation arriving during the PUT therefore correctly leaves
// `lastMutationAt > lastSyncedAt`, so the next mutation reschedules
// a sync that catches the in-flight edit.
//
// Why timestamps and not a counter: a counter would grow unbounded
// over a long editing session. Timestamps grow only with wall-clock
// time and are safe to ~285 million years before precision loss in
// a JS `Number`.
let _backendSyncTimer = null
const BACKEND_SYNC_DELAY_MS = 5000

function _scheduleBackendSync() {
  if (_backendSyncTimer) return
  _backendSyncTimer = setTimeout(() => {
    _backendSyncTimer = null
    try {
       
      useProjectStore.getState()._doBackendSync()
    } catch (e) {
      console.warn('[backend-sync] scheduling failed:', e)
    }
  }, BACKEND_SYNC_DELAY_MS)
}

// Zustand middleware: detects mutations marked via
// `set({ hasUnsavedChanges: true, ... })` and (1) stamps
// `lastMutationAt`, (2) schedules a throttled backend sync.
// Both are no-ops when the partial doesn't include
// `hasUnsavedChanges: true`. The wrapped `set` is also installed on
// `api.setState` so external callers (e.g.
// `entitiesStore._markProjectDirty()` which does
// `useProjectStore.setState({ hasUnsavedChanges: true })`) flow
// through the same detection.
const detectMutationMiddleware = (config) => (set, get, api) => {
  const wrappedSet = (partial, replace) => {
    let resolved = partial
    if (typeof partial === 'function') {
      resolved = partial(get())
    }
    const isMutation = resolved && resolved.hasUnsavedChanges === true
    if (isMutation) {
      resolved = { ...resolved, lastMutationAt: Date.now() }
    }
    set(resolved, replace)
    if (isMutation) {
      // Defer scheduling to a microtask so the new state is committed
      // before the throttle reads it. (Not strictly necessary for
      // correctness here — `_doBackendSync` reads from `getState()` at
      // PUT time — but keeps the timing intuition clean.)
      queueMicrotask(_scheduleBackendSync)
    }
  }
  api.setState = wrappedSet
  return config(wrappedSet, get, api)
}
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import { useEntitiesStore } from './entitiesStore'
import { useUiStore } from './uiStore'
import { useMcpControlStore } from './mcpControlStore'
import { useContextCuesStore } from './contextCuesStore'
import { useConversationsStore } from './conversationsStore'
import { useProgramTagsStore } from './programTagsStore'
import { confirm, useDialogStore } from './dialogStore'
import { getEntityNarrativeChain, computeEffectiveState, computeEffectiveStateWithPrior, parseListValue, computeRelationshipEffectiveState, getRelationshipNodeOrder, makeLatestPresenceNameResolver, getKnowledgeNodeOrder, computeKnowledgeEffectiveState, resolveAwarenessField, getRelationshipCreationNodeId } from '../utils/narrativeChain'
import { ENTITY_BUCKETS, participantsFallbackLabel } from '../utils/entityHelpers'
import { countHostsForTag as _countHostsForTag } from '../utils/projectTagHosts'
import { diffAwarenessDict, applyBaselineDraftToEntity, mergeBaselineAwarenessDraft, readEffectiveAwarenessForTarget, readAwarenessAtTarget, setAwarenessAtTarget, buildAwarenessHistoryEntriesFromDeltas, appendAwarenessHistoryEntries } from '../utils/awarenessCommit'
import { buildRolloverPage } from '../utils/awarenessRollover'
import { addParticipantJoin, removeParticipantAtNode, hasAnyPotentialParticipant, findDuplicateAtOrigin, findDuplicateAtScene, setParticipantInitialPerception, setParticipantInitialAlias, createEmptyRelationshipHistory } from '../utils/relationshipHistory'
import { buildDuplicateRelMessage, buildUpstreamConnectMessage, buildContradictStoryOrderMessage } from '../components/ui/popupMessages'
import { applyCreationPositionSnap, snapPosition, SNAP_STEP, SNAP_POS_OFFSET } from '../utils/snapUtils'
import { shortestConceptPorts, computeReorganizeConceptLayout } from '../utils/conceptLayout'
import { pickKnowledgeAwarenessLevel } from '../utils/knowledgeAwarenessGrant'
import { wouldCreatePovLoop, computePovChain } from '../utils/povSequence'
import { walkPovChainTime, minutesToTimeDelta, timeDeltaToMinutes, detectScenetimeAlert, detectFirstScenetimeAlert } from '../utils/povChainTimeWalker'

// Scene-data field names whose mutation should re-trigger walker +
// loose-mode notification alert detection (Phase 1.23 — planning §10).
// Listed here so updateNodeData can detect time-relevant patches without
// rebuilding the list on every call.
const SCENETIME_FIELD_KEYS = [
  'time_of_day_tier', 'time_of_day_broad', 'time_of_day_labelled', 'time_of_day_exact',
  'weekday', 'season', 'date_tier', 'date_month', 'date_day_of_month', 'date_year',
  'scene_duration', 'gap_extension',
]
import { computeStoryOrder, wouldContradictStoryOrder } from '../utils/storyOrder'
import { getOrComputeStoryOrder } from '../hooks/useStoryOrder'
import { applyMeasuredDimensionChanges, dropMeasuredDimensions, clearMeasuredDimensions, getMeasuredWidth, getMeasuredHeight } from '../utils/measuredDimensionsStore'
import { getChapterIdForNode, resolveChapterIdForNode, chapterMemberOptsForStory } from '../utils/chapterMembership'
import { getNodesInGroup } from '../utils/groupMembership'
import {
  getChapterIdForNodeMultiRow,
  getChapterOriginMultiRow,
  getChapterOriginSingleRow,
  rowGeometryParams,
  multirowHeaderRows,
  multirowHeaderRowsForStory,
  wrapChaptersIntoRows,
  chapterIndexSpanForXRange,
  constrainRowsToGroupSpans,
  DEFAULT_ROW_HEIGHT,
  ROW_CONTENT_TOP_BUFFER,
  MIN_ROW_HEIGHT,
  getRowBands,
  rowIndexForTop,
} from '../utils/rowLayout'
import { replaceMatchesInHtml } from '../utils/findReplaceUtils'
import {
  getNodeBBox, computeHandlePositions, computeTidyWaypoints,
  deconflictWaypoints, findClearDotPosition,
  estimateHandleY, simplifyPath,
} from '../utils/wireTidyUtils'
import { detectAndFireOvumRed, detectAndFireOvumWhiteAtChainAnchor, detectAndFireOvumBlack, resetOvumBlack } from '../effects/quarterlyForecasts'

const ENTITY_BUCKET_MAP = { character: 'characters', location: 'locations', item: 'items', faction: 'factions', custom: 'customs' }

/**
 * Phase 8.4 (Convert To) — snapshot the entitiesStore's five entity buckets +
 * libraryLayout by reference (Zustand shares arrays by reference until mutated,
 * so this is cheap). Used as the `_entitiesBucketsBefore` undo/redo extra for a
 * type convert, which moves an entity between buckets and may also reparent
 * location children / rewrite perspective kinds on OTHER entities. Restoring
 * this whole object reverses all of those entitiesStore-side changes at once.
 */
function _captureEntityBuckets() {
  const es = useEntitiesStore.getState()
  return {
    characters: es.characters,
    locations: es.locations,
    items: es.items,
    factions: es.factions,
    customs: es.customs,
    libraryLayout: es.libraryLayout,
  }
}

// Snapshot suppression (Phase 8.4 — batch convert). A batch action takes ONE
// `_snapshot()` up front, sets this, then loops the single-item convert actions
// (each of which would otherwise take its own snapshot). With it set, the
// per-item `_snapshot()` calls are no-ops, so the whole batch is one undo step.
// Always cleared in a `finally` by the batch action that set it.
let _snapshotSuppressed = false

// Phase 8.5 — the concept-wire port picker (shortest port-to-port pair, with a
// middle-port preference for edge-aligned nodes) lives in the pure, Node-tested
// `conceptLayout.js` as `shortestConceptPorts`, imported above.

// ── Faction-membership helpers (Phase 8.4 — entity→faction conversion) ───────
// A faction's "Members" is a single relationship with `membership_of === factionId`,
// activated at the faction's origin node; the faction never joins its own membership
// (mirrors `createFactionMembership`). These builders run INLINE inside
// `convertEntityType`'s one snapshot (no backend POST — the save-time full-story
// `PUT /story` syncs, consistent with the rest of convert).

const _DEFAULT_REL_HISTORY = () => ({
  existence_changes: [], participant_changes: [], perception_changes: [],
  alias_changes: [], role_changes: [], hierarchy_changes: [], name_changes: [],
  description_changes: [], tag_changes: [], manual_anchors: [],
})

/** Create-new: a fresh empty Members relationship for `factionId`, alive from its origin. */
function _newFactionMembershipRel(factionId, factionName, originNodeId) {
  return {
    id: crypto.randomUUID(),
    name: factionName ? `${factionName} Members` : null,
    description: '',
    participant_roles: {},
    hierarchy: null,
    membership_of: factionId,
    history: {
      ..._DEFAULT_REL_HISTORY(),
      existence_changes: originNodeId
        ? [{ id: crypto.randomUUID(), node_id: originNodeId, action: 'activate' }]
        : [],
    },
    tag_ids: [],
    awareness: null,
    creation_anchor_node_id: originNodeId,
    awareness_scale: 'binary',
  }
}

/** Adopt: point an existing (non-membership) relationship's `membership_of` at the
 *  faction. Its current participants become the faction's members. The faction itself
 *  is dropped from the participant set (a faction never joins its own membership). The
 *  relationship keeps its name, description, and full history. */
function _adoptRelAsMembership(rel, factionId) {
  const h = rel.history || _DEFAULT_REL_HISTORY()
  const participant_roles = { ...(rel.participant_roles || {}) }
  delete participant_roles[factionId]
  return {
    ...rel,
    membership_of: factionId,
    participant_roles,
    history: {
      ...h,
      participant_changes: (h.participant_changes || []).filter((c) => c.entity_id !== factionId),
    },
  }
}

/** Copy: deep-clone a relationship as the faction's Members. Fresh id everywhere
 *  (relationship + every history entry), renamed to the default membership name,
 *  alive from the faction's origin, knowledge forward-pointers cleared (the copy does
 *  not own the source's Knowledge events), and the faction dropped from participants.
 *  Non-destructive, so it may source from any relationship (even another faction's
 *  membership). Awareness is not carried onto the copy (set fresh if needed). */
function _cloneRelAsMembership(src, factionId, factionName, originNodeId) {
  const h = src.history || _DEFAULT_REL_HISTORY()
  const clone = (list, dropFaction) => (list || [])
    .filter((c) => !(dropFaction && c.entity_id === factionId))
    .map((c) => ({ ...c, id: crypto.randomUUID(), knowledge_id: null }))
  const participant_roles = { ...(src.participant_roles || {}) }
  delete participant_roles[factionId]
  return {
    ...src,
    id: crypto.randomUUID(),
    name: factionName ? `${factionName} Members` : null,
    membership_of: factionId,
    participant_roles,
    tag_ids: [...(src.tag_ids || [])],
    awareness: null,
    creation_anchor_node_id: originNodeId,
    history: {
      // Alive from the faction's origin (like create-new), not the source's anchor.
      existence_changes: originNodeId
        ? [{ id: crypto.randomUUID(), node_id: originNodeId, action: 'activate' }]
        : [],
      participant_changes: clone(h.participant_changes, true),
      perception_changes: clone(h.perception_changes, true),
      alias_changes: clone(h.alias_changes, true),
      role_changes: clone(h.role_changes, true),
      hierarchy_changes: clone(h.hierarchy_changes, false),
      // Renamed to the membership default, so drop the source's name history.
      name_changes: [],
      description_changes: clone(h.description_changes, false),
      tag_changes: clone(h.tag_changes, false),
      manual_anchors: [...(h.manual_anchors || [])],
    },
  }
}

// ── Phase 4.3 multi-row helpers (shared by the chapter/row store actions) ──

/** Insert `newId` into a copy of `oldRows` at the position that keeps the
 *  row-major flattening == the new `chapters[]`: right after `predecessorId`
 *  (the chapter at the insertion index - 1), or at the very start when
 *  `predecessorId` is null. Returns the new rows array (deep-copied ids). */
function _insertChapterIntoRows(oldRows, newId, predecessorId) {
  const newRows = (oldRows || []).map((r) => ({ ...r, chapter_ids: [...(r.chapter_ids || [])] }))
  if (predecessorId == null) {
    if (newRows.length === 0) newRows.push({ id: crypto.randomUUID(), chapter_ids: [], height: DEFAULT_ROW_HEIGHT })
    newRows[0].chapter_ids.unshift(newId)
    return newRows
  }
  for (const r of newRows) {
    const p = r.chapter_ids.indexOf(predecessorId)
    if (p >= 0) { r.chapter_ids.splice(p + 1, 0, newId); return newRows }
  }
  if (newRows.length === 0) newRows.push({ id: crypto.randomUUID(), chapter_ids: [], height: DEFAULT_ROW_HEIGHT })
  newRows[newRows.length - 1].chapter_ids.push(newId)
  return newRows
}

/** Reconcile a (possibly stale) `chapter_rows` against the canonical
 *  `chapters[]`: drop ids no longer in `chapters[]`, and splice in any
 *  chapters missing from the rows at their `chapters[]` position (right
 *  after their predecessor), so the row-major flattening == `chapters[]`.
 *  Needed because single-row chapter edits (insert / delete) intentionally
 *  leave the preserved-but-inactive `chapter_rows` untouched; this resyncs
 *  it when the user toggles back into multi-row. Empty rows are preserved. */
function _reconcileRowsWithChapters(rows, chapters) {
  const valid = new Set(chapters.map((c) => c.id))
  let next = (rows || []).map((r) => ({ ...r, chapter_ids: (r.chapter_ids || []).filter((id) => valid.has(id)) }))
  for (let i = 0; i < chapters.length; i++) {
    const id = chapters[i].id
    if (next.some((r) => r.chapter_ids.includes(id))) continue
    next = _insertChapterIntoRows(next, id, i > 0 ? chapters[i - 1].id : null)
  }
  return next
}

/** Resolve a row's height from its content-fit, honouring the user-set flag
 *  (§ dynamic row heights). `contentFit` is the height that just contains the
 *  row's tallest chapter (caller computes it). An auto-fit row (NOT user-set)
 *  sits exactly at content-fit, so it grows AND shrinks with its content. A
 *  user-set row (the user dragged it taller than content-fit) keeps its extra
 *  height, but is always clamped to >= content-fit so an incoming taller
 *  chapter can still push it up. */
function _fitRowHeight(row, contentFit) {
  return (row && row.height_user_set) ? Math.max(row.height || contentFit, contentFit) : contentFit
}

/**
 * After a layout-mode switch, re-lay each SPANNING concept group's members
 * DETERMINISTICALLY: side-by-side in per-chapter columns sharing one top edge
 * just below the group header, anchored to the group's post-switch box, then
 * refit the box (header reserved) to wrap them. A layout switch offsets every
 * node from ITS OWN chapter's content-top, which mis-places a group whose
 * members span more than one chapter (worse when two groups share a chapter
 * column and skew that column's content-top) — one member tucks under the
 * header, another is ejected above the box and geometrically dropped. Because
 * this runs in BOTH directions (single->multi and multi->single) and re-derives
 * the layout from the box rather than the members' arrived offsets, the group
 * stays intact and side-by-side across repeated toggles (the offset-preserving
 * version degraded each cycle, and once a member escaped the box the next
 * switch's geometric membership could no longer find it to fix).
 *
 * `nextNodes` — the post-switch nodes; `sourceNodes` — the pre-switch nodes
 * (geometric membership + a stable same-column ordering). `chapters` / `xOffset`
 * decide which groups span more than one chapter (single-row column x). Pure:
 * returns a new nodes array (or the same one when there's nothing to realign).
 */
function _realignSpanningConceptGroups(nextNodes, sourceNodes, chapters, xOffset) {
  const nextById = new Map(nextNodes.map((n) => [n.id, n]))
  const srcById = new Map(sourceNodes.map((n) => [n.id, n]))
  const _w = (n, f) => n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.style?.width ?? n.width ?? f
  const _h = (n, f) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.style?.height ?? n.height ?? f
  const HDR = 26, GPAD = 20, GAP = 30
  const overrides = new Map()  // id -> { x, y } for a member, or { x, y, w, h } for a refit box
  for (const g of sourceNodes) {
    if (g.type !== 'genericGroupNode' || g.data?.concept_group !== true) continue
    const members = getNodesInGroup(g, sourceNodes, { excludeGroups: false })
    if (members.length === 0) continue
    const chSet = new Set(members.map((m) => getChapterIdForNode(m, chapters, xOffset)))
    if (chSet.size <= 1) continue  // single-chapter groups already align correctly
    const boxNext = nextById.get(g.id); if (!boxNext) continue
    // Common top just below the box header; each member keeps its post-switch X
    // (its chapter column). Same-column members stack.
    const commonTopY = (boxNext.position?.y ?? 0) + HDR + GPAD
    const colsMap = new Map()  // roundedX -> member[]
    for (const m of members) {
      const mn = nextById.get(m.id); if (!mn) continue
      const key = Math.round(mn.position?.x ?? 0)
      if (!colsMap.has(key)) colsMap.set(key, [])
      colsMap.get(key).push(m)
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const col of colsMap.values()) {
      col.sort((a, b) => (srcById.get(a.id)?.position?.y ?? 0) - (srcById.get(b.id)?.position?.y ?? 0))
      let cy = commonTopY
      for (const m of col) {
        const mx = (nextById.get(m.id)?.position?.x ?? 0)
        const mw = _w(m, 240), mh = _h(m, 130)
        overrides.set(m.id, { x: mx, y: cy })
        minX = Math.min(minX, mx); minY = Math.min(minY, cy); maxX = Math.max(maxX, mx + mw); maxY = Math.max(maxY, cy + mh)
        cy += mh + GAP
      }
    }
    if (isFinite(minX)) {
      const bx = minX - GPAD, by = minY - GPAD - HDR
      overrides.set(g.id, { x: bx, y: by, w: (maxX + GPAD) - bx, h: (maxY + GPAD) - by })
    }
  }
  if (overrides.size === 0) return nextNodes
  return nextNodes.map((n) => {
    const o = overrides.get(n.id)
    if (!o) return n
    if (o.w != null) return { ...n, position: { x: o.x, y: o.y }, width: o.w, height: o.h, measured: { ...(n.measured || {}), width: o.w, height: o.h }, style: { ...(n.style || {}), width: o.w, height: o.h }, data: { ...n.data, width: o.w, height: o.h } }
    return { ...n, position: { x: o.x, y: o.y } }
  })
}

// Debounced grow-only row re-fit, scheduled when node measurements arrive
// (onNodesChange dimension changes) in multi-row. As a virtualized / just-
// rendered node reports its true height, a row sized earlier from the per-type
// SEED estimate may now be too short; this grows it to contain the real
// content (never shrinks — shrink is an explicit drag-end action). Debounced
// so a measurement burst coalesces to one re-fit; gated against the post-load
// fitView storm. Module-level timer survives re-renders.
let _growRefitTimer = null
function _scheduleGrowRefit(get) {
  if (_growRefitTimer) clearTimeout(_growRefitTimer)
  _growRefitTimer = setTimeout(() => {
    _growRefitTimer = null
    const s = get()
    if (s.story?.canvas_layout_mode === 'multi' && !s._pendingFitView) {
      s.refitRowsToContent({ growOnly: true })
    }
  }, 200)
}

/** Re-place every chapter-member node from the OLD (chapters, rows)
 *  geometry onto the NEW (chapters, rows) geometry by its mode-invariant
 *  chapter-relative offset (chapter-as-group, §4), fitting each new row to
 *  its tallest chapter's content (grow AND shrink, honouring `height_user_set`)
 *  so node centres stay inside their bands. Off-strip nodes keep their
 *  position. Mutates `newRows[*].height`; returns the new nodes array. Used by
 *  insert/edge-shuffle/etc. in multi-row mode. */
function _relayoutNodesAcrossRows(allNodes, oldChapters, oldRows, newChapters, newRows, geom) {
  const nodeHeight = (n) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 120
  const CONTENT_PAD = 40
  const offsets = new Map()
  for (const n of allNodes) {
    const cid = getChapterIdForNodeMultiRow(n, oldChapters, oldRows, geom.xOffset, geom.rowsTopY, geom.rowGap)
    if (!cid) continue
    const oc = getChapterOriginMultiRow(cid, oldRows, oldChapters, geom.xOffset, geom.rowsTopY, geom.rowGap)
    if (!oc) continue
    offsets.set(n.id, { cid, ox: (n.position?.x ?? 0) - oc.x, oy: (n.position?.y ?? 0) - oc.y })
  }
  const rowIdx = new Map()
  newRows.forEach((r, i) => (r.chapter_ids || []).forEach((cid) => rowIdx.set(cid, i)))
  const maxBottom = new Array(newRows.length).fill(0)
  for (const n of allNodes) {
    const o = offsets.get(n.id)
    if (!o) continue
    const i = rowIdx.get(o.cid)
    if (i != null) maxBottom[i] = Math.max(maxBottom[i], o.oy + nodeHeight(n))
  }
  newRows.forEach((r, i) => {
    const contentFit = Math.max(MIN_ROW_HEIGHT, maxBottom[i] + ROW_CONTENT_TOP_BUFFER + CONTENT_PAD)
    r.height = _fitRowHeight(r, contentFit)
  })
  return allNodes.map((n) => {
    const o = offsets.get(n.id)
    if (!o) return n
    const nc = getChapterOriginMultiRow(o.cid, newRows, newChapters, geom.xOffset, geom.rowsTopY, geom.rowGap)
    if (!nc) return n
    return { ...n, position: { x: nc.x + o.ox, y: nc.y + o.oy } }
  })
}

/**
 * Inspect an axios error for a structured save-format error payload
 * from the backend — returned by both the load endpoints
 * (`routers/project.py` → `_unpack_or_raise`) AND the entity-import
 * preview endpoint (`routers/entity_import.py` → `import_preview`).
 * Show the matching `confirm()` dialog if one fires, and return a
 * string describing the error for the store's `error` banner (or null
 * if no structured error was found, in which case the caller falls
 * through to its generic error message).
 *
 * Handles two shapes:
 *   { error: 'incompatible_save', capability, file_version, min_required, program_version }
 *   { error: 'corrupt_save', detail }
 *
 * Where:
 *   capability      — 'load' | 'import' — which reader path rejected the file
 *   file_version    — PROGRAM_VERSION of the build that wrote the file
 *   min_required    — minimum PROGRAM_VERSION required for that capability
 *   program_version — the running build's PROGRAM_VERSION
 *
 * The dialog phrasing switches on `capability` so a user trying to
 * IMPORT entities from a too-new file is not told to "update to open
 * the project" — the project they're loading into is fine, it's the
 * source they're importing from that's the problem.
 *
 * If you add a new save-format error shape or change one of these:
 * coordinate with `backend/routers/project.py`, `backend/routers/
 * entity_import.py`, `backend/services/file_service.py`
 * (`build_incompatible_detail`, `build_corrupt_detail`), and the
 * MAINTAINER CHECKLIST at the top of `file_service.py` (see also
 * `docs/save-format-versioning.md`). The backend error class, the
 * HTTP payload shape, and this helper must all land in the same
 * commit or the dialog falls out of sync.
 */
export async function handleSaveFormatLoadError(err) {
  const detail = err?.response?.data?.detail
  if (!detail || typeof detail !== 'object') return null
  if (detail.error === 'incompatible_save') {
    const capability = detail.capability || 'load'
    const isImport = capability === 'import'
    const title = isImport
      ? 'Source project needs a newer NarrativeNode'
      : 'This project needs a newer NarrativeNode'
    const message = isImport
      ? (
          `The source project you're trying to import from was saved by ` +
          `NarrativeNode ${detail.file_version}. Importing from it requires ` +
          `NarrativeNode ${detail.min_required} or later.\n\n` +
          `Your version of NarrativeNode is ${detail.program_version}. ` +
          `Please update and try again.`
        )
      : (
          `This project was saved by NarrativeNode ${detail.file_version}, ` +
          `and requires NarrativeNode ${detail.min_required} or later to open.\n\n` +
          `Your version of NarrativeNode is ${detail.program_version}. ` +
          `Please update and try again.`
        )
    await confirm({
      title,
      message,
      buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
    })
    return isImport
      ? `Source project needs NarrativeNode ${detail.min_required} or later to import.`
      : `This project needs NarrativeNode ${detail.min_required} or later.`
  }
  if (detail.error === 'corrupt_save') {
    await confirm({
      title: 'Project file is corrupt',
      message:
        `NarrativeNode couldn't read this file because its save format ` +
        `metadata is malformed.\n\n${detail.detail}`,
      buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
    })
    return 'Project file is corrupt.'
  }
  return null
}

/** Pull a human-readable error message out of an axios/fetch failure.
 *
 * The backend's save / export endpoints return 500 responses with a
 * `detail` field carrying either a string (`"Save failed (FooError): bar"`)
 * or a MissingAssetsError payload (`{ kind: "missing_assets", filenames: [...] }`).
 * Falls back to the axios error's `message` when the request never
 * reached the backend (e.g. uvicorn died, network blip), and to
 * `fallback` when neither is available. Used to populate the user-
 * facing banner so "Save failed" stops being a black box.
 */
function _extractErrorDetail(err, fallback) {
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    if (detail.kind === 'missing_assets' && Array.isArray(detail.filenames)) {
      const names = detail.filenames.join(', ')
      return `Save failed: missing assets (${names})`
    }
    if (detail.message && typeof detail.message === 'string') return detail.message
    try { return JSON.stringify(detail) } catch { /* fall through */ }
  }
  if (err?.message && typeof err.message === 'string') {
    return `${fallback} (${err.message})`
  }
  return fallback
}

/** Extract entity ID from a chip-in handle id (e.g. "chip-in-abc123" → "abc123"). */
function getChipEntityId(handle) {
  return handle?.startsWith('chip-in-') ? handle.slice(8) : null
}

/** Extract relationship ID from a rel-in handle id (e.g. "rel-in-abc123" → "abc123"). */
function getRelChipId(handle) {
  return handle?.startsWith('rel-in-') ? handle.slice(7) : null
}

/**
 * Build entity and scene lookup indexes from a top-level relationships array.
 * Returns { byEntity, byScene } where each value is a plain object mapping
 * id → Set of relationship ids. Rebuilt on every mutation and on project load.
 */
const REL_HISTORY_KEYS = [
  'existence_changes',
  'participant_changes',
  'perception_changes',
  'alias_changes',
  'role_changes',
  'hierarchy_changes',
  'name_changes',
  'description_changes',
]

// Phase 1.21c Tier 0 — universal event identity for EntityRef / EntityNode
// scalar change fields. These four fields are first-class chain events
// uniquely identified by a stable UUID so the attached-Knowledge layer
// (Tier 2) can resolve a `SourceEventRef` to a single change-entry
// regardless of event kind. Lazy-filled on first write; removed when the
// scalar field is cleared (set to null). The dict lives on the carrier
// object (EntityRef on a sceneNode, or modifier-node data) under
// `scalar_change_ids`, keyed by field name.
const SCALAR_CHANGE_FIELDS = ['name_change', 'colour_change', 'description_change', 'profile_image_change']

/**
 * Reconcile a carrier's `scalar_change_ids` dict with its current scalar-
 * field state. Returns a new dict reflecting:
 *   - field newly set (was null/undefined, is now non-null) → fresh UUID
 *   - field cleared (was non-null, is now null) → entry removed
 *   - field still present (value may have edited) → existing UUID kept
 * Pure function; does not mutate inputs. Pass `oldCarrier` as null when
 * applying to a brand-new carrier so every non-null scalar gets a UUID.
 */
function maintainScalarChangeIds(oldCarrier, newCarrier) {
  const oldIds = (oldCarrier?.scalar_change_ids && typeof oldCarrier.scalar_change_ids === 'object')
    ? oldCarrier.scalar_change_ids
    : {}
  const ids = { ...oldIds }
  for (const field of SCALAR_CHANGE_FIELDS) {
    const oldVal = oldCarrier?.[field]
    const newVal = newCarrier?.[field]
    const oldHas = oldVal !== null && oldVal !== undefined
    const newHas = newVal !== null && newVal !== undefined
    if (newHas && !oldHas) {
      ids[field] = crypto.randomUUID()
    } else if (!newHas && oldHas) {
      delete ids[field]
    } else if (newHas && !ids[field]) {
      // Was set in oldCarrier but had no UUID (pre-Tier-0 save loaded
      // mid-session). Lazy-fill so the event becomes addressable.
      ids[field] = crypto.randomUUID()
    }
  }
  return ids
}

/**
 * Merge new `AliasChange` awareness events into an existing
 * `EntityRef.alias_changes` array, replacing any prior event with the
 * same (action, alias_id, observer_id-or-source-key) tuple instead of
 * accumulating duplicates. Last write at the same anchor for the same
 * target wins — matches the normalised-history invariant the
 * participant / scalar paths enforce at write time.
 *
 * Pass-through for non-awareness events on the existing array (add /
 * remove / modify), so this helper only touches awareness entries.
 */
function _mergeAliasAwarenessEvents(existing, newAwarenessEvents) {
  if (!Array.isArray(existing) || existing.length === 0) {
    return [...newAwarenessEvents]
  }
  const keyFor = (ev) => {
    if (!ev || typeof ev !== 'object') return null
    if (ev.action === 'awareness_set') {
      return `set:${ev.alias_id || ''}:${ev.observer_id || ''}`
    }
    if (ev.action === 'awareness_source_add' || ev.action === 'awareness_source_remove' || ev.action === 'awareness_source_set_level') {
      const src = ev.source || {}
      // Source key mirrors the matcher in applySourceChange:
      // relationship by relationship_id, attribute by (entity_id, attribute_id).
      const srcKey = src.kind === 'relationship'
        ? `relationship:${src.relationship_id || ''}`
        : src.kind === 'attribute'
          ? `attribute:${src.entity_id || ''}:${src.attribute_id || ''}`
          : ''
      return `${ev.action}:${ev.alias_id || ''}:${srcKey}`
    }
    return null
  }
  const newByKey = new Map()
  for (const ev of newAwarenessEvents) {
    const k = keyFor(ev)
    if (k) newByKey.set(k, ev)
  }
  const merged = []
  for (const ev of existing) {
    const k = keyFor(ev)
    if (k && newByKey.has(k)) {
      merged.push(newByKey.get(k))
      newByKey.delete(k)
    } else {
      merged.push(ev)
    }
  }
  for (const ev of newByKey.values()) merged.push(ev)
  return merged
}

/** True when a relationship has no entries in any history array.
 *  Used by removal actions to auto-delete orphaned relationships that have been
 *  drained of all content (cleanup trigger for the "relationship with nothing in it"
 *  state). History-only model: there is no base `participants[]` mirror, so a
 *  relationship is empty iff all history arrays are empty. */
function _isRelationshipEmpty(rel) {
  if (!rel) return false
  const h = rel.history || {}
  return REL_HISTORY_KEYS.every((k) => !(h[k]?.length))
}

/** True when a relationship has no narrative anchor after a node deletion.
 *  History-only orphan rule:
 *   - If the relationship has no potential participants (no `join` events in
 *     history), it's orphaned regardless of other history entries. A
 *     deactivate / perception / alias / role / hierarchy / name change that
 *     references zero participants is meaningless — the relationship has
 *     nothing to be about. (Example: wiring Alice+Bob into a rel origin node,
 *     ending the rel at Scene 1 via "end here", then removing the origin
 *     node strips the join events but leaves a stale `existence_change:
 *     deactivate` behind — that deactivate is meaningless on a participant-
 *     less rel, so cascade-delete.)
 *   - Otherwise, if the relationship has ANY join event in history or
 *     remaining canvas edges, it's a meaningful anchor and stays. */
function _isRelationshipOrphanedAfterStrip(rel, remainingEdges) {
  if (!rel) return false
  if (!hasAnyPotentialParticipant(rel)) return true
  const h = rel.history || {}
  const hasAnyHistory = REL_HISTORY_KEYS.some((k) => (h[k] || []).length > 0)
  if (hasAnyHistory) return false
  return !remainingEdges.some((e) => e.data?.relationship_id === rel.id)
}

// ── Reference-stripping primitives for DELETE operations ─────────────────
//
// Each primitive takes the current store state and the id being deleted,
// returns a partial state patch. The caller (the per-type internal delete
// handler) applies the patch via set() and handles snapshot + backend ops.
//
// Adding a new reference type: find the right primitive for the deleted
// object's type and add a new filter step. This is the SINGLE location
// for that work — don't scatter cleanup across call sites.

/**
 * Phase 2.13 — null the perspective_target_* fields on every embedded
 * perspective Attribute inside an `add` AttributeChange whose target
 * matches `(kindSet, targetId)`. Operates on an array; returns the
 * modified array (same reference if nothing matched, new array
 * otherwise). The cascade contract is null-target-keep-description (see
 * Phase 2.13 planning doc, decision 3): the perspective entry survives
 * with its description text intact; the UI surfaces it as a
 * "(deleted target)" orphan. An alert is emitted from the dispatcher
 * layer in Phase 2.13d — the strip step is just the data scrub.
 *
 * Does NOT walk perspective targets on `modify` AttributeChange
 * entries — the v1 model carries no `perspective_target_change` field
 * (the perspective UI re-creates via remove + add when the writer
 * changes the target). Add such handling here when / if that field
 * lands.
 *
 * NOTE: only walks attribute_changes carried on canvas-node data
 * (EntityRef.attribute_changes on scenes, EntityNode.attribute_changes
 * on modifier nodes). Entity baseline attributes live in entitiesStore
 * and are scrubbed by `_sweepStalePerspectiveTargetsFromEntities` in
 * that store, called from the dispatcher handler.
 */
function _nullPerspectiveTargetsInChanges(changes, kindSet, targetId) {
  if (!Array.isArray(changes) || changes.length === 0) return changes
  let mutated = false
  const next = []
  for (const ac of changes) {
    if (
      ac.action === 'add' &&
      ac.attribute?.attribute_type === 'perspective' &&
      ac.attribute.perspective_target_id === targetId &&
      kindSet.has(ac.attribute.perspective_target_kind)
    ) {
      mutated = true
      next.push({
        ...ac,
        attribute: {
          ...ac.attribute,
          perspective_target_kind: null,
          perspective_target_id: null,
        },
      })
      continue
    }
    next.push(ac)
  }
  return mutated ? next : changes
}

/** Sweep all canvas nodes, nulling perspective targets matching
 *  `(kindSet, targetId)` on any attribute_changes carried by scenes
 *  (per-EntityRef per-bucket) and modifier EntityNodes. Returns a
 *  `{ nodes }` patch if anything changed, else `{}`. */
function _sweepNodesForOrphanedPerspectives(state, kindSet, targetId) {
  let anyChanged = false
  const nodes = (state.nodes || []).map((n) => {
    if (n.type === 'entityNode' && n.data?.is_modifier) {
      const scrubbed = _nullPerspectiveTargetsInChanges(
        n.data.attribute_changes, kindSet, targetId,
      )
      if (scrubbed === n.data.attribute_changes) return n
      anyChanged = true
      return { ...n, data: { ...n.data, attribute_changes: scrubbed } }
    }
    if (n.type !== 'sceneNode') return n
    let bucketsChanged = false
    const newData = { ...n.data }
    for (const b of ENTITY_BUCKETS) {
      const origRefs = newData[b] || []
      if (origRefs.length === 0) continue
      let refsChanged = false
      const newRefs = origRefs.map((r) => {
        const scrubbed = _nullPerspectiveTargetsInChanges(
          r.attribute_changes, kindSet, targetId,
        )
        if (scrubbed === r.attribute_changes) return r
        refsChanged = true
        return { ...r, attribute_changes: scrubbed }
      })
      if (refsChanged) {
        newData[b] = newRefs
        bucketsChanged = true
      }
    }
    if (!bucketsChanged) return n
    anyChanged = true
    return { ...n, data: newData }
  })
  return anyChanged ? { nodes } : {}
}

const _PERSPECTIVE_ENTITY_KINDS = new Set([
  'character', 'location', 'item', 'faction', 'custom',
])
const _PERSPECTIVE_KNOWLEDGE_KINDS = new Set(['knowledge'])
const _PERSPECTIVE_RELATIONSHIP_KINDS = new Set(['relationship'])

// ── Perspective REWRITE (Phase 8.4 — Knowledge→Entity conversion) ────────────
// The delete path NULLS perspective targets that point at a removed object.
// Conversion instead REWRITES them: the target id is reused (the entity keeps
// the knowledge's id), so only `perspective_target_kind` flips to the new
// subtype. Mirrors `_nullPerspectiveTargetsInChanges` /
// `_sweepNodesForOrphanedPerspectives` but sets the kind instead of clearing.

function _rewritePerspectiveKindInChanges(changes, kindSet, targetId, newKind) {
  if (!Array.isArray(changes) || changes.length === 0) return changes
  let mutated = false
  const next = []
  for (const ac of changes) {
    if (
      ac.action === 'add' &&
      ac.attribute?.attribute_type === 'perspective' &&
      ac.attribute.perspective_target_id === targetId &&
      kindSet.has(ac.attribute.perspective_target_kind)
    ) {
      mutated = true
      next.push({ ...ac, attribute: { ...ac.attribute, perspective_target_kind: newKind } })
      continue
    }
    next.push(ac)
  }
  return mutated ? next : changes
}

/** Sweep all canvas nodes, flipping perspective-target kind matching
 *  `(kindSet, targetId)` to `newKind` on scene EntityRef attribute_changes and
 *  modifier EntityNodes. Returns a `{ nodes }` array (unchanged ref if nothing
 *  matched). */
function _rewritePerspectiveKindInNodes(nodes, kindSet, targetId, newKind) {
  return (nodes || []).map((n) => {
    if (n.type === 'entityNode' && n.data?.is_modifier) {
      const scrubbed = _rewritePerspectiveKindInChanges(n.data.attribute_changes, kindSet, targetId, newKind)
      if (scrubbed === n.data.attribute_changes) return n
      return { ...n, data: { ...n.data, attribute_changes: scrubbed } }
    }
    if (n.type !== 'sceneNode') return n
    let bucketsChanged = false
    const newData = { ...n.data }
    for (const b of ENTITY_BUCKETS) {
      const origRefs = newData[b] || []
      if (origRefs.length === 0) continue
      let refsChanged = false
      const newRefs = origRefs.map((r) => {
        const scrubbed = _rewritePerspectiveKindInChanges(r.attribute_changes, kindSet, targetId, newKind)
        if (scrubbed === r.attribute_changes) return r
        refsChanged = true
        return { ...r, attribute_changes: scrubbed }
      })
      if (refsChanged) { newData[b] = newRefs; bucketsChanged = true }
    }
    return bucketsChanged ? { ...n, data: newData } : n
  })
}

/**
 * Strip every reference to the given relationship id from the store state.
 * Returns a partial state patch { relationships, edges, nodes } — caller applies.
 *
 * Handles: the relationship row itself, relationship-scoped canvas edges,
 * and relationship-origin nodes.
 */
function _stripReferencesToRelationship(state, relId) {
  // First, drop any relationship origin node (Phase 1.18) that references the
  // deleted relationship (cascade from relationship delete to its origin
  // node). Local only; save-time `PUT /story` syncs the backend.
  const preFilteredNodes = state.nodes.filter(
    (n) => !(n.type === 'relationshipOriginNode' && n.data?.relationship_id === relId)
  )
  // Collect any relationship origin node ids we just cascade-removed so the
  // edge filter below can drop wires that dangled to them.
  const removedRelOriginNodeIds = new Set(
    state.nodes
      .filter((n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === relId)
      .map((n) => n.id)
  )
  // Phase 2.13 — null perspective_target on any embedded perspective
  // Attribute in `add` AttributeChange entries whose target was the
  // deleted relationship. See `_nullPerspectiveTargetsInChanges` for
  // the cascade contract.
  const perspectivePatch = _sweepNodesForOrphanedPerspectives(
    { nodes: preFilteredNodes }, _PERSPECTIVE_RELATIONSHIP_KINDS, relId,
  )
  const nodes = perspectivePatch.nodes || preFilteredNodes
  // Phase 1.21 — null out any surviving relationship's `awareness` field when
  // it's an `AwarenessRef` pointing at the deleted relationship. Refs are
  // all-or-nothing, so the whole field becomes null (a stale ref would
  // resolve to an empty projection at walk time anyway).
  const relationships = state.relationships
    .filter((r) => r.id !== relId)
    .map((r) => {
      const aw = r.awareness
      if (!aw || typeof aw !== 'object') return r
      if (!('relationship_id' in aw) || !('level' in aw)) return r
      if (aw.relationship_id !== relId) return r
      return { ...r, awareness: null }
    })

  return {
    relationships,
    edges: state.edges.filter(
      (e) =>
        e.data?.relationship_id !== relId &&
        !removedRelOriginNodeIds.has(e.source) &&
        !removedRelOriginNodeIds.has(e.target)
    ),
    nodes,
  }
}

/**
 * Strip every reference to the given entity id from the store state, plus remove
 * the entity's own canvas nodes (origin + modifiers). Returns a partial state
 * patch { nodes, edges, relationships }. Does NOT remove the entity from the
 * entitiesStore bucket — caller does that via `entitiesStore._removeEntity`.
 *
 * Handles: entity origin/modifier nodes on canvas, entity chips across all plot
 * point node buckets,
 * `chip_order` entries, entity-connected + entity-scoped edges, relationship-edge
 * cleanup for deleted and stripped rels, and participant/history stripping on
 * multi-party relationships where the deleted entity was one of several participants.
 *
 * Coverage note (refreshed while scoping Phase 8.4): the sites this comment
 * once flagged as gaps are now handled. Story.pov_character_id and per-scene
 * SceneNode.pov_entity_id are nulled here; participant_roles[entityId] and the
 * relationship history entries (participant / perception / alias / role changes)
 * are stripped here; EntityRef list_add / list_remove ops are dropped by
 * stripAttrChanges. Children's parent_id, other entities' entity_list values,
 * and entity / attribute / alias awareness-observer keys are swept by
 * entitiesStore._sweepStaleEntityReferencesFromEntities; perspective targets by
 * _sweepStalePerspectiveTargetsFromEntities (both called from
 * _deleteEntityInternal alongside this primitive).
 *
 * Known remaining gap (tracked as a Bugs & Fixes item, NOT handled here): a
 * deleted entity's observer key is not stripped from a RELATIONSHIP's or a
 * KNOWLEDGE's awareness dict, only entity / attribute / alias awareness
 * observers are swept.
 */
function _stripReferencesToEntity(state, entityId) {
  const currentRels = state.relationships
  // History-only model: a relationship's participants are derived from its
  // history. The "other participants" set is every entity with a `join` event
  // whose entity_id is not `entityId`. If stripping `entityId` leaves no other
  // joiners the relationship is fully deleted; otherwise its history is
  // scrubbed of the deleted entity.
  const joinEntitiesOf = (r) => {
    const joins = (r.history?.participant_changes || []).filter((c) => c.action === 'join')
    return new Set(joins.map((c) => c.entity_id))
  }
  const relIdsToDelete = new Set(
    currentRels.filter((r) => {
      if (r.membership_of === entityId) return true
      const joinIds = joinEntitiesOf(r)
      if (!joinIds.has(entityId)) return false
      // After stripping entityId, are there any other joiners left?
      joinIds.delete(entityId)
      return joinIds.size === 0
    }).map((r) => r.id)
  )
  const relIdsToStrip = new Set(
    currentRels.filter((r) =>
      !relIdsToDelete.has(r.id) &&
      joinEntitiesOf(r).has(entityId)
    ).map((r) => r.id)
  )

  // Entity's own nodes (origin + modifier) to remove
  const removedNodeIds = new Set(
    state.nodes
      .filter((n) => n.type === 'entityNode' && n.data.entity_id === entityId)
      .map((n) => n.id)
  )

  // Helper: strip list-op attribute_changes whose list_item is the deleted entity id.
  // Applies to any carrier of an AttributeChange[] (EntityRef on plot point nodes,
  // EntityNode modifier nodes). `carrier` is the parent object; returns a patched copy
  // if any changes were stripped, else the original. Also strips `add` actions whose
  // full attribute carries the deleted id inside an entity_list initial value.
  // Phase 2.13: also nulls perspective_target on `add` actions whose embedded
  // attribute is a perspective targeting the deleted entity (description text
  // preserved per the null-target-keep-description cascade contract).
  const stripAttrChanges = (carrier) => {
    const acs = carrier.attribute_changes
    if (!Array.isArray(acs) || acs.length === 0) return carrier
    let mutated = false
    const next = []
    for (const ac of acs) {
      if ((ac.action === 'list_add' || ac.action === 'list_remove') && ac.list_item === entityId) {
        mutated = true
        continue // drop entirely — the reference is gone
      }
      if (ac.action === 'awareness_set' && ac.list_item === entityId) {
        mutated = true
        continue // Phase 1.21 — awareness_set keyed on the deleted entity
      }
      if (ac.action === 'add' && ac.attribute?.attribute_type === 'entity_list') {
        const list = parseListValue(ac.attribute.value)
        if (list.includes(entityId)) {
          mutated = true
          next.push({
            ...ac,
            attribute: { ...ac.attribute, value: JSON.stringify(list.filter((id) => id !== entityId)) },
          })
          continue
        }
      }
      if (
        ac.action === 'add' &&
        ac.attribute?.attribute_type === 'perspective' &&
        ac.attribute.perspective_target_id === entityId &&
        _PERSPECTIVE_ENTITY_KINDS.has(ac.attribute.perspective_target_kind)
      ) {
        mutated = true
        next.push({
          ...ac,
          attribute: {
            ...ac.attribute,
            perspective_target_kind: null,
            perspective_target_id: null,
          },
        })
        continue
      }
      next.push(ac)
    }
    return mutated ? { ...carrier, attribute_changes: next } : carrier
  }

  // Nodes: filter out the entity's own origin/modifier nodes; clean up plot point
  // buckets (chips + attribute_changes list ops), chip_order,
  // per-scene pov_entity_id, and attribute_changes on remaining modifier entity nodes.
  // Phase 1.18: also cascade-remove any relationship origin node whose relationship
  // is being cascade-deleted by this entity delete.
  const nodes = state.nodes
    .filter((n) => !removedNodeIds.has(n.id))
    .filter((n) => !(n.type === 'relationshipOriginNode' && relIdsToDelete.has(n.data?.relationship_id)))
    .map((n) => {
      // Modifier entity nodes for OTHER entities can also hold list_add/list_remove
      // attribute_change entries referencing the deleted entity id.
      if (n.type === 'entityNode' && n.data?.is_modifier) {
        const patched = stripAttrChanges(n.data)
        if (patched === n.data) return n
        return { ...n, data: patched }
      }
      if (n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      let changed = false

      // Entity chips across all buckets (+ strip deleted-entity list ops on remaining refs).
      for (const b of ENTITY_BUCKETS) {
        const origRefs = newData[b] || []
        let refs = origRefs.filter((r) => r.entity_id !== entityId)
        refs = refs.map(stripAttrChanges)
        if (refs !== origRefs) {
          newData[b] = refs
          changed = true
        }
      }

      // chip_order
      if (Array.isArray(newData.chip_order) && newData.chip_order.includes(entityId)) {
        newData.chip_order = newData.chip_order.filter((eid) => eid !== entityId)
        changed = true
      }

      // Per-scene POV character pointer — clear if it was the deleted entity
      if (newData.pov_entity_id === entityId) {
        newData.pov_entity_id = null
        changed = true
      }

      // Phase 1.22h — strip any temporary circumstances / motivators
      // attached to the deleted entity at this scene. Temporaries are
      // scoped to (scene, entity_id); a deleted entity leaves orphan
      // entries that should be cleaned up alongside the rest of the
      // entity's references.
      if (Array.isArray(newData.entity_temporary_circumstances)) {
        const origLen = newData.entity_temporary_circumstances.length
        newData.entity_temporary_circumstances = newData.entity_temporary_circumstances.filter(
          (t) => t.entity_id !== entityId,
        )
        if (newData.entity_temporary_circumstances.length !== origLen) changed = true
      }

      return changed ? { ...n, data: newData } : n
    })

  // Edges: connected-to-removed-nodes, entity-scoped chip wires, deleted-rel edges, stripped-rel entity-sourced edges
  const edges = state.edges.filter((e) => {
    if (removedNodeIds.has(e.source) || removedNodeIds.has(e.target)) return false
    if (e.data?.source_entity_id === entityId) return false
    if (e.sourceHandle === entityId) return false
    if (e.data?.is_relationship && relIdsToDelete.has(e.data?.relationship_id)) return false
    if (e.data?.is_relationship && relIdsToStrip.has(e.data?.relationship_id) &&
        (e.data?.entity_a_id === entityId || e.data?.source_entity_id === entityId)) return false
    return true
  })

  // Relationships: delete fully; strip entity from multi-party (history
  // entries + participant_roles dict key). History-only: no base mirror.
  const relationships = currentRels
    .filter((r) => !relIdsToDelete.has(r.id))
    .map((r) => {
      if (!relIdsToStrip.has(r.id)) return r
      let participantRoles = r.participant_roles
      if (participantRoles && Object.prototype.hasOwnProperty.call(participantRoles, entityId)) {
        participantRoles = { ...participantRoles }
        delete participantRoles[entityId]
      }
      return {
        ...r,
        participant_roles: participantRoles,
        history: r.history ? {
          ...r.history,
          participant_changes: (r.history.participant_changes || []).filter((c) => c.entity_id !== entityId),
          perception_changes:  (r.history.perception_changes  || []).filter((c) => c.entity_id !== entityId),
          alias_changes:       (r.history.alias_changes       || []).filter((c) => c.entity_id !== entityId),
          role_changes:        (r.history.role_changes        || []).filter((c) => c.entity_id !== entityId),
        } : r.history,
      }
    })

  // Story-level POV character pointer — clear if it was the deleted entity.
  const patch = { nodes, edges, relationships }
  if (state.story?.pov_character_id === entityId) {
    patch.story = { ...state.story, pov_character_id: null }
  }

  return patch
}

/**
 * Strip every reference to the given node id from the store state, plus remove
 * the node itself. Returns a partial state patch { nodes, edges, relationships }.
 * Handles: the node's own removal, edges connected to it, relationship history
 * entries referencing it, cascade-delete of any relationships left empty, and
 * orphan-fix on flashback scenes whose parent_scene_id was the deleted node.
 */
function _stripReferencesToNode(state, nodeId) {
  // 0. POV-chain auto-stitch — BEFORE we strip edges, if the deleted
  // node is a sceneNode that sits mid-chain on the POV path (has BOTH
  // an incoming and an outgoing is_pov_path edge), capture the
  // predecessor and successor scene ids so we can stitch them
  // together with a fresh prev → next POV edge after the strip.
  // Without this, deleting a mid-chain scene leaves the chain
  // severed: prev loses its outgoing edge, next loses its incoming,
  // and `next` + every scene downstream falls off the POV chain
  // silently. Surfaced 2026-05-18 in the blind-agent edit test —
  // the agent deleted a duplicate scene (created accidentally by the
  // disconnect-retry bug) and the delete severed the chain at that
  // point, knocking 3 downstream scenes off the POV path. Heal-at-
  // delete is the right default per the chain-of-history model: a
  // scene's deletion shouldn't implicitly remove every downstream
  // scene from the chain.
  const deletedNode = state.nodes.find((n) => n.id === nodeId)
  let _povStitch = null
  // Each entity-continuity stitch is keyed by entity_id; one stitch
  // per affected entity to restore that entity's chain continuity
  // after the delete. Carries the source / target node ids plus the
  // entity id needed to construct the correctly-shaped edge.
  const _entityStitches = []  // [{ entityId, sourceId, targetId }]
  if (deletedNode?.type === 'sceneNode') {
    // ── POV chain stitch ──
    const inEdge = state.edges.find(
      (e) => e.data?.is_pov_path && e.target === nodeId,
    )
    const outEdge = state.edges.find(
      (e) => e.data?.is_pov_path && e.source === nodeId,
    )
    if (inEdge && outEdge) {
      // Stitch only when BOTH neighbours are concrete sceneNodes —
      // skip when the predecessor is the POV origin node (in that
      // case the successor inherits the head position via a new
      // origin → successor edge, which is still a stitch).
      _povStitch = {
        sourceId: inEdge.source,
        targetId: outEdge.target,
      }
    } else if (inEdge && !outEdge) {
      // Mid-chain delete at the chain tail: nothing to stitch
      // (predecessor becomes the new tail, no edge needed).
    } else if (!inEdge && outEdge) {
      // Mid-chain delete at the chain head: the head was wired from
      // the POV origin node; the outgoing edge becomes orphaned.
      // Stitch with the POV origin as the source so the (new) head
      // scene stays at chain position 1.
      const povOrigin = state.nodes.find((n) => n.type === 'povOriginNode')
      if (povOrigin) {
        _povStitch = {
          sourceId: povOrigin.id,
          targetId: outEdge.target,
        }
      }
    }
    // ── Entity-continuity chain stitches ──
    // For each entity that has a continuity wire INTO the deleted
    // scene, find that entity's continuity wire OUT and stitch them
    // — mirrors the POV-chain auto-stitch but per-entity. Without
    // this, deleting a mid-chain scene leaves each affected entity's
    // chain severed at that point: `get_entity(at=<downstream>)`
    // falls into the orphan path because the chain walker can't
    // reach the downstream chip anymore. Surfaced 2026-05-18 in the
    // self-test pass: POV chain healed but entity chain didn't,
    // leaving Down the Hatch as an orphan for Alex's chain after
    // The Offer was deleted. Continuity wires are identified by
    // `source_entity_id` set + `is_pov_path`/`is_relationship` not
    // truthy.
    const continuityInEdges = state.edges.filter(
      (e) => e.data?.source_entity_id
        && !e.data?.is_pov_path
        && !e.data?.is_relationship
        && e.target === nodeId,
    )
    const continuityOutEdges = state.edges.filter(
      (e) => e.data?.source_entity_id
        && !e.data?.is_pov_path
        && !e.data?.is_relationship
        && e.source === nodeId,
    )
    // Group out-edges by entity_id for O(1) lookup per in-edge.
    const outByEntity = new Map()
    for (const e of continuityOutEdges) {
      const eid = e.data?.source_entity_id
      if (!eid) continue
      if (!outByEntity.has(eid)) outByEntity.set(eid, e)
      // (Soft-limit: one outgoing continuity wire per
      // chip per entity. If somehow there are multiple, take the
      // first — defensive; shouldn't happen in well-formed data.)
    }
    for (const inE of continuityInEdges) {
      const eid = inE.data?.source_entity_id
      if (!eid) continue
      const outE = outByEntity.get(eid)
      if (!outE) continue  // no outgoing for this entity — chain
                            // ended at the deleted scene; no stitch
                            // needed (entity's chain just gets
                            // shorter, downstream wasn't there).
      // Dedupe in case multiple in-edges target the same entity
      // (rare but defensive — a chip could theoretically have
      // multiple incoming continuity wires from a merge).
      if (_entityStitches.some((s) =>
        s.entityId === eid
        && s.sourceId === inE.source
        && s.targetId === outE.target,
      )) continue
      _entityStitches.push({
        entityId: eid,
        sourceId: inE.source,
        targetId: outE.target,
      })
    }
  }
  // 1. Remove the node itself
  let nodes = state.nodes.filter((n) => n.id !== nodeId)
  // 2. Filter edges connected to the deleted node
  let edges = state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
  // 2a. Apply POV-chain stitch — add the prev → next (or origin → head)
  // POV edge if we determined one was needed. The new edge uses the
  // same shape `_insertSceneIntoPovChain` constructs, so the chain
  // walker sees it identically to UI-driven inserts.
  if (_povStitch) {
    const stitchId = `pov-${_povStitch.sourceId}-${_povStitch.targetId}`
    edges = [
      ...edges,
      {
        id: stitchId,
        source: _povStitch.sourceId,
        target: _povStitch.targetId,
        sourceHandle: 'pov-out',
        targetHandle: 'pov-in',
        type: 'povEdge',
        data: {
          id: stitchId,
          source_node_id: _povStitch.sourceId,
          target_node_id: _povStitch.targetId,
          is_pov_path: true,
          target_handle_id: 'pov-in',
        },
      },
    ]
  }
  // 2b. Apply entity-continuity stitches — one new wire per affected
  // entity. Edge shape matches `onConnect`'s scene-to-scene chip-wire
  // construction (type='transitionEdge', `chip-in-<entityId>` target
  // handle, `source_entity_id` in data) so the chain walker reads
  // stitched continuity wires identically to UI-driven entity-chip
  // connections. Cycle-check is implicit: we only stitch when the
  // continuity wires INTO the deleted scene have a corresponding
  // OUT — meaning the entity's chain spanned through the deleted
  // scene; the new edge replaces the through-path with a direct
  // hop, which can't introduce a cycle the original chain didn't
  // already have.
  for (const stitch of _entityStitches) {
    const stitchId = `edge-stitch-${stitch.sourceId}-${stitch.targetId}-${stitch.entityId}`
    edges = [
      ...edges,
      {
        id: stitchId,
        source: stitch.sourceId,
        target: stitch.targetId,
        sourceHandle: stitch.entityId,
        targetHandle: `chip-in-${stitch.entityId}`,
        type: 'transitionEdge',
        data: {
          id: stitchId,
          source_node_id: stitch.sourceId,
          target_node_id: stitch.targetId,
          source_entity_id: stitch.entityId,
          is_pov_path: false,
          target_handle_id: `chip-in-${stitch.entityId}`,
        },
      },
    ]
  }
  // 3. Orphan-fix flashbacks whose parent was the deleted node
  if (deletedNode?.type === 'sceneNode' && !deletedNode.data?.is_flashback) {
    const orphanedFlashbackIds = new Set(
      nodes
        .filter((n) => n.type === 'sceneNode' && n.data?.is_flashback && n.data?.parent_scene_id === nodeId)
        .map((n) => n.id)
    )
    if (orphanedFlashbackIds.size > 0) {
      nodes = nodes.map((n) =>
        orphanedFlashbackIds.has(n.id)
          ? { ...n, data: { ...n.data, parent_scene_id: null, pov_entity_id: null } }
          : n
      )
      edges = edges.filter((e) => {
        if (!e.data?.is_pov_path) return true
        return !orphanedFlashbackIds.has(e.source) && !orphanedFlashbackIds.has(e.target)
      })
    }
  }
  // 4. Strip relationship history entries referencing this node.
  // Iterate every array-valued history key dynamically so any future
  // history field (e.g. `manual_anchors` added in v0.1.18.127) is
  // auto-stripped without needing this list kept in sync.
  const currentRels = state.relationships
  let relationships = currentRels.map((rel) => {
    const h = rel.history || {}
    let changed = false
    const updHistory = { ...h }
    for (const key of Object.keys(h)) {
      const arr = h[key]
      if (!Array.isArray(arr)) continue
      const filtered = arr.filter((c) => c?.node_id !== nodeId)
      if (filtered.length !== arr.length) {
        updHistory[key] = filtered
        changed = true
      }
    }
    return changed ? { ...rel, history: updHistory } : rel
  })
  // 5. Cascade-delete relationships that became orphaned by the node's deletion.
  // Orphaned = no history entries AND (no participants OR no remaining edge anchor).
  // Broader than _isRelationshipEmpty because it also catches wire-created rels
  // whose only anchor (the deleted scene's edges) is now gone, leaving participants
  // hanging without narrative context.
  const cascadeDeletedRels = relationships.filter((rel) =>
    _isRelationshipOrphanedAfterStrip(rel, edges)
  )
  const orphanedRelIds = new Set(cascadeDeletedRels.map((r) => r.id))
  if (orphanedRelIds.size > 0) {
    relationships = relationships.filter((r) => !orphanedRelIds.has(r.id))
    edges = edges.filter((e) => !orphanedRelIds.has(e.data?.relationship_id))
  }
  return { nodes, edges, relationships, _cascadeDeletedRels: cascadeDeletedRels }
}

/**
 * Phase 1.21c — strip every reference TO the given knowledge id from
 * store state, and remove the knowledge itself from `state.knowledges`.
 * Returns a partial state patch `{ knowledges }` (and fields for any
 * cross-surface sweeps as more land in Step 10+). Local-only — save-time
 * `PUT /story` syncs the backend.
 *
 * Step 3 scope: drop the knowledge from `state.knowledges`.
 * Step 10+ will extend this to sweep `source_event` back-pointers on
 * other knowledges' history entries (when events bridge across
 * knowledges), and any attached-event `knowledge_id` pointers that
 * reference the deleted knowledge. For now those fields aren't wired
 * anywhere, so the single-list strip is sufficient.
 */
function _stripReferencesToKnowledge(state, knowledgeId) {
  const knowledges = (state.knowledges || []).filter((k) => k.id !== knowledgeId)
  // Phase 1.21c Step 14: also drop the deleted Knowledge's origin node
  // (if any) and any wires emanating from it. Keeps the canvas in sync
  // with the library when a Knowledge is deleted.
  const orphanNodeIds = new Set(
    (state.nodes || [])
      .filter((n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId)
      .map((n) => n.id),
  )
  const preFilteredNodes = (state.nodes || []).filter((n) => !orphanNodeIds.has(n.id))
  // Phase 2.13 — null perspective_target on any embedded perspective
  // Attribute in `add` AttributeChange entries whose target was the
  // deleted knowledge.
  const perspectivePatch = _sweepNodesForOrphanedPerspectives(
    { nodes: preFilteredNodes }, _PERSPECTIVE_KNOWLEDGE_KINDS, knowledgeId,
  )
  const nodes = perspectivePatch.nodes || preFilteredNodes
  const edges = (state.edges || []).filter(
    (e) => !orphanNodeIds.has(e.source) && !orphanNodeIds.has(e.target),
  )
  return { knowledges, nodes, edges }
}

/**
 * Phase 3.4b — Strip every reference TO the given Project Tag id FROM
 * the projectStore-owned state: knowledges (baseline + history),
 * relationships (baseline + history), and nodes (scene EntityRefs,
 * EntityNode modifier-mode tag_changes, ReferenceNode baseline). The
 * caller is responsible for also calling `entitiesStore._sweepTagRefsFromEntitiesAndPresets(tagId)`
 * to strip the matching baseline references on entities + preset lists,
 * since those buckets live in `entitiesStore`. Mirrors the
 * `_sweepStalePresetListRefsFromAttributes` / `_stripReferencesToKnowledge`
 * shape — local-only, save-time `PUT /story` syncs the backend.
 *
 * Does NOT remove the Tag pool entry itself from `story.project_tags`
 * — that's a separate step in the dispatcher (`_deleteProjectTagInternal`)
 * because the project_tags collection lives on the Story object that
 * gets re-fetched at next save anyway.
 *
 * Returns a partial projectStore patch: `{ knowledges, relationships, nodes }`.
 */
function _stripReferencesToTag(state, tagId) {
  // Knowledges: strip baseline tag_ids + history.tag_changes events
  // referencing the deleted tag.
  const knowledges = (state.knowledges || []).map((k) => {
    const baseline = (k.tag_ids || []).filter((t) => t !== tagId)
    const baselineChanged = baseline.length !== (k.tag_ids || []).length
    const history = k.history || {}
    const tagChanges = (history.tag_changes || []).filter((c) => c?.tag_id !== tagId)
    const historyChanged = tagChanges.length !== (history.tag_changes || []).length
    if (!baselineChanged && !historyChanged) return k
    return {
      ...k,
      tag_ids: baseline,
      history: { ...history, tag_changes: tagChanges },
    }
  })

  // Relationships: same shape — baseline tag_ids + history.tag_changes.
  const relationships = (state.relationships || []).map((r) => {
    const baseline = (r.tag_ids || []).filter((t) => t !== tagId)
    const baselineChanged = baseline.length !== (r.tag_ids || []).length
    const history = r.history || {}
    const tagChanges = (history.tag_changes || []).filter((c) => c?.tag_id !== tagId)
    const historyChanged = tagChanges.length !== (history.tag_changes || []).length
    if (!baselineChanged && !historyChanged) return r
    return {
      ...r,
      tag_ids: baseline,
      history: { ...history, tag_changes: tagChanges },
    }
  })

  // Nodes: three flavours to strip.
  //   - ReferenceNode: baseline tag_ids on node.data
  //   - EntityNode (modifier): tag_changes on node.data
  //   - SceneNode: tag_changes on per-bucket EntityRefs inside node.data
  const SCENE_REF_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
  const nodes = (state.nodes || []).map((n) => {
    const data = n.data || {}

    // Reference Node: strip baseline.
    if (n.type === 'referenceNode') {
      const baseline = (data.tag_ids || []).filter((t) => t !== tagId)
      if (baseline.length === (data.tag_ids || []).length) return n
      return { ...n, data: { ...data, tag_ids: baseline } }
    }

    // Entity Node (modifier mode): strip tag_changes.
    if (n.type === 'entityNode') {
      const tagChanges = (data.tag_changes || []).filter((c) => c?.tag_id !== tagId)
      if (tagChanges.length === (data.tag_changes || []).length) return n
      return { ...n, data: { ...data, tag_changes: tagChanges } }
    }

    // Scene Node: strip tag_changes off each bucket's EntityRefs.
    if (n.type === 'sceneNode') {
      let bucketChanged = false
      const nextData = { ...data }
      for (const bucketName of SCENE_REF_BUCKETS) {
        const refs = data[bucketName] || []
        let refsChanged = false
        const nextRefs = refs.map((ref) => {
          const tagChanges = (ref.tag_changes || []).filter((c) => c?.tag_id !== tagId)
          if (tagChanges.length === (ref.tag_changes || []).length) return ref
          refsChanged = true
          return { ...ref, tag_changes: tagChanges }
        })
        if (refsChanged) {
          bucketChanged = true
          nextData[bucketName] = nextRefs
        }
      }
      return bucketChanged ? { ...n, data: nextData } : n
    }

    return n
  })

  return { knowledges, relationships, nodes }
}

/**
 * Phase 3.4c — Strip every reference TO the given Program Tag string
 * (case-insensitive) FROM the Context Cue + Conversation stores. Unlike
 * Project Tags, Program Tags are flat per-host strings with no chain
 * semantics, no baseline / change-event split, no `.nnz` involvement —
 * just a `tags: string[]` array on every ContextCue and Conversation.
 *
 * The strip operates across THREE store-owned arrays:
 *   1. `useContextCuesStore.cues[i].tags`             — full cue bodies in memory
 *   2. `useConversationsStore.index[i].tags`          — thread-browser metadata
 *   3. `useConversationsStore.byId[key].tags`         — opened-thread cache
 *
 * Case-insensitive match, drops the entry. Local-only — the backend
 * DELETE has already done the host-walk on disk via
 * `delete_program_tag_across_hosts`; this function brings the in-
 * memory stores back in line with what's on disk.
 *
 * Returns `{ affectedCues, affectedConvs }` — the pre-strip host
 * snapshots used by the undo handler (`_programTagRestore`) to re-PUT
 * each affected host on undo.
 */
function _stripReferencesToProgramTag(name) {
  if (!name || typeof name !== 'string') return { affectedCues: [], affectedConvs: [] }
  const target = name.toLowerCase()
  const matches = (t) => typeof t === 'string' && t.toLowerCase() === target

  // Context Cues — full-body store.
  const cuesStore = useContextCuesStore.getState()
  const affectedCues = []
  const nextCues = (cuesStore.cues || []).map((c) => {
    const tags = Array.isArray(c.tags) ? c.tags : []
    if (!tags.some(matches)) return c
    affectedCues.push({ id: c.id, tags: [...tags] })
    return { ...c, tags: tags.filter((t) => !matches(t)) }
  })
  if (affectedCues.length > 0) useContextCuesStore.setState({ cues: nextCues })

  // Conversations — index entries + opened-thread byId cache.
  const convStore = useConversationsStore.getState()
  const affectedConvs = []
  const nextIndex = (convStore.index || []).map((e) => {
    const tags = Array.isArray(e.tags) ? e.tags : []
    if (!tags.some(matches)) return e
    affectedConvs.push({ id: e.id, tags: [...tags] })
    return { ...e, tags: tags.filter((t) => !matches(t)) }
  })
  const nextById = { ...(convStore.byId || {}) }
  let byIdChanged = false
  for (const { id } of affectedConvs) {
    const cached = nextById[id]
    if (!cached) continue
    const cachedTags = Array.isArray(cached.tags) ? cached.tags : []
    if (cachedTags.some(matches)) {
      nextById[id] = { ...cached, tags: cachedTags.filter((t) => !matches(t)) }
      byIdChanged = true
    }
  }
  if (affectedConvs.length > 0 || byIdChanged) {
    useConversationsStore.setState({
      index: nextIndex,
      ...(byIdChanged ? { byId: nextById } : {}),
    })
  }

  return { affectedCues, affectedConvs }
}

function _buildRelIndexes(relationships) {
  const byEntity = {}
  const byScene = {}
  for (const rel of (relationships || [])) {
    // History-only: a relationship's participant set is every entity that
    // appears as a `join` subject in participant_changes.
    const joinIds = new Set(
      ((rel.history?.participant_changes) || [])
        .filter((c) => c.action === 'join')
        .map((c) => c.entity_id)
    )
    for (const eid of joinIds) {
      if (!byEntity[eid]) byEntity[eid] = new Set()
      byEntity[eid].add(rel.id)
    }
    if (rel.membership_of) {
      if (!byEntity[rel.membership_of]) byEntity[rel.membership_of] = new Set()
      byEntity[rel.membership_of].add(rel.id)
    }
    const history = rel.history || {}
    const allNodeIds = new Set()
    for (const list of Object.values(history)) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        if (entry.node_id) allNodeIds.add(entry.node_id)
      }
    }
    for (const nodeId of allNodeIds) {
      if (!byScene[nodeId]) byScene[nodeId] = new Set()
      byScene[nodeId].add(rel.id)
    }
  }
  return { byEntity, byScene }
}

/**
 * Add an entity chip (EntityRef) to a SceneNode if not already present.
 * Returns updated nodes array. No-ops if already present.
 */
function addOrphanedChipToNode(nodes, nodeId, entity, extraRefFields = {}) {
  const targetNode = nodes.find((n) => n.id === nodeId)
  if (!targetNode) return nodes
  const bucket = ENTITY_BUCKET_MAP[entity.type]
  if (!bucket) return nodes
  const currentRefs = targetNode.data[bucket] || []
  if (currentRefs.some((r) => r.entity_id === entity.id)) return nodes
  const newRef = {
    entity_id: entity.id,
    name_change: null, colour_change: null, description_change: null, profile_image_change: null,
    attribute_changes: [], awareness_changes: [], has_pov: false,
    ...extraRefFields,
  }
  return nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, [bucket]: [...currentRefs, newRef] } } : n
  )
}

/**
 * Return the list of field names that are changed in this EntityRef.
 * Used by the downstream review flag system.
 */
function getChangedFields(entityRef) {
  const fields = []
  if (entityRef.name_change    !== null && entityRef.name_change    !== undefined) fields.push('name')
  if (entityRef.colour_change  !== null && entityRef.colour_change  !== undefined) fields.push('colour')
  if (entityRef.description_change   !== null && entityRef.description_change   !== undefined) fields.push('description')
  if (entityRef.profile_image_change !== null && entityRef.profile_image_change !== undefined) fields.push('profile_image')
  // Aliases — fire 'aliases' as a changed field whenever the per-event
  // `alias_changes` array has any entries. The downstream-flag pipeline
  // keys off the 'aliases' string; this detection feeds it so editing
  // the same alias at scene N and scene N+2 surfaces a downstream
  // review flag like other scalar fields do.
  if (Array.isArray(entityRef.alias_changes) && entityRef.alias_changes.length > 0) fields.push('aliases')
  for (const ac of (entityRef.attribute_changes || [])) {
    // List ops use per-item keys so alerts are scoped to specific items, not the whole attribute.
    // Cancelled list ops are pending review — they are not "real" active changes so they are
    // excluded from changedFields (preventing double-flag generation in overlapping check).
    if (ac.action === 'list_add' && ac.attribute_id && ac.list_item != null) {
      if (!ac.cancelled) fields.push(`list_add:${ac.attribute_id}:${ac.list_item}`)
    } else if (ac.action === 'list_remove' && ac.attribute_id && ac.list_item != null) {
      if (!ac.cancelled) fields.push(`list_remove:${ac.attribute_id}:${ac.list_item}`)
    } else {
      const id = ac.action === 'add' ? ac.attribute?.id : ac.attribute_id
      if (id) fields.push(`attr:${id}`)
    }
  }
  // Awareness chain entries live on each host's `awareness.history` post
  // v0.2a.2.5. The downstream review-flag pipeline for AWARENESS rides on
  // per-entry `review_flag` stamps inside that history (see
  // `applyDownstreamAwarenessHistoryReviewFlags`), not on
  // `EntityRef.review_fields[]`. Origin-baseline awareness edits still
  // emit `awareness:*` field keys via `flagDownstreamAfterOriginEdit`;
  // those are matched against the legacy `EntityRef.review_fields[]`
  // surface, but downstream EntityRefs never write awareness chain
  // entries on themselves anymore so there is no chain-side field key
  // for this helper to emit.
  return fields
}

/**
 * Walk forwards from sourceNodeId through the connection graph (BFS) and
 * return all downstream SceneNodes that carry a chip for entityId.
 * Continues past matching nodes so the entire downstream chain is covered.
 */
function findDownstreamEntityNodes(nodes, edges, sourceNodeId, entityId) {
  const visited = new Set([sourceNodeId])
  // Only follow edges that carry this entity (source_entity_id matches) or that
  // originate from an entity node (entity nodes have no source_entity_id on their
  // outgoing edge but are always the start of exactly one entity's chain).
  const isEntityEdge = (e) =>
    e.data?.source_entity_id === entityId ||
    nodes.find((n) => n.id === e.source)?.type === 'entityNode'

  let frontier = edges
    .filter((e) => e.source === sourceNodeId && isEntityEdge(e))
    .map((e) => nodes.find((n) => n.id === e.target))
    .filter(Boolean)

  const result = []
  while (frontier.length > 0) {
    const nextFrontier = []
    for (const node of frontier) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      if (node.type === 'sceneNode') {
        const hasEntity = ENTITY_BUCKETS.some((b) =>
          (node.data[b] || []).some((r) => r.entity_id === entityId)
        )
        if (hasEntity) result.push(node)
      } else if (node.type === 'entityNode' && node.data.is_modifier && node.data.entity_id === entityId) {
        result.push(node)
      }
      // Continue downstream only along entity-scoped edges
      edges
        .filter((e) => e.source === node.id && isEntityEdge(e))
        .forEach((e) => {
          const succ = nodes.find((n) => n.id === e.target)
          if (succ && !visited.has(succ.id)) nextFrontier.push(succ)
        })
    }
    frontier = nextFrontier
  }
  return result
}

/**
 * After a mid-chain attribute removal, sweep all downstream nodes in the
 * entity's chain and drop any orphaned list_add / list_remove / modify entries
 * for those attribute IDs. These changes are unreachable once the attribute is
 * gone upstream. Re-add entries are preserved — the user may legitimately
 * re-introduce the attribute later in the chain.
 */
function sweepOrphanedAttrOpsDownstream(nodes, edges, sourceNodeId, entityId, removedAttrIds) {
  if (!removedAttrIds || removedAttrIds.size === 0) return nodes

  const isOrphaned = (ac) => {
    if (!removedAttrIds.has(ac.attribute_id)) return false
    return ac.action !== 'add'
  }

  const downstream = findDownstreamEntityNodes(nodes, edges, sourceNodeId, entityId)
  const downstreamIds = new Set(downstream.map((n) => n.id))
  if (downstreamIds.size === 0) return nodes

  return nodes.map((n) => {
    if (!downstreamIds.has(n.id)) return n
    if (n.type === 'entityNode' && n.data.is_modifier && n.data.entity_id === entityId) {
      const acs = n.data.attribute_changes || []
      const next = acs.filter((ac) => !isOrphaned(ac))
      if (next.length === acs.length) return n
      return { ...n, data: { ...n.data, attribute_changes: next } }
    }
    if (n.type === 'sceneNode') {
      let nodeChanged = false
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entityId)
        if (idx === -1) continue
        const acs = refs[idx].attribute_changes || []
        const next = acs.filter((ac) => !isOrphaned(ac))
        if (next.length === acs.length) continue
        newData[bucket] = refs.map((r, i) => i === idx ? { ...r, attribute_changes: next } : r)
        nodeChanged = true
        break
      }
      if (!nodeChanged) return n
      return { ...n, data: newData }
    }
    return n
  })
}

/**
 * Build a { field: value } map from an EntityRef-like object for review flag enrichment.
 */
function getSourceValues(ref) {
  const vals = {
    name: ref.name_change,
    colour: ref.colour_change,
    description: ref.description_change,
    profile_image: ref.profile_image_change,
    aliases: (Array.isArray(ref.alias_changes) && ref.alias_changes.length > 0)
      ? JSON.stringify(ref.alias_changes)
      : undefined,
  }
  const attrNames = {}
  for (const ac of (ref.attribute_changes || [])) {
    if (ac.action === 'list_add' && ac.attribute_id && ac.list_item != null) {
      // Sentinel '1' — the key itself encodes the item; comparison is presence not value
      vals[`list_add:${ac.attribute_id}:${ac.list_item}`] = '1'
    } else if (ac.action === 'list_remove' && ac.attribute_id && ac.list_item != null) {
      vals[`list_remove:${ac.attribute_id}:${ac.list_item}`] = '1'
    } else if (ac.action === 'add' && ac.attribute) {
      // For file-type adds, prefer file_ref (mirrored into value, but file_ref is authoritative)
      vals[`attr:${ac.attribute.id}`] = ac.attribute.file_ref !== undefined ? (ac.attribute.file_ref || ac.attribute.value) : ac.attribute.value
      attrNames[ac.attribute.id] = ac.attribute.name
    } else if (ac.action === 'modify' && ac.attribute_id) {
      // File-attribute modifications store the change in file_ref_change, not new_value
      vals[`attr:${ac.attribute_id}`] = ac.file_ref_change !== undefined ? ac.file_ref_change : ac.new_value
    } else if (ac.action === 'remove' && ac.attribute_id) {
      vals[`attr:${ac.attribute_id}`] = '(removed)'
    }
  }
  // Awareness chain-anchor values live on each host's `awareness.history`
  // post v0.2a.2.5; the alert pipeline reads them via the canonical
  // wrapper-history walker, not from EntityRef change-record fields.
  vals._attrNames = attrNames
  return vals
}

/**
 * Build a { field: value } map from a base entity object (origin-level edits).
 */
function getEntityBaseValues(entity) {
  const vals = {
    name: entity.name,
    colour: entity.colour,
    description: entity.description,
    profile_image: entity.profile_image_ref,
    aliases: entity.aliases?.length ? JSON.stringify(entity.aliases) : undefined,
  }
  for (const attr of (entity.attributes || [])) {
    if (!vals._attrNames) vals._attrNames = {}
    vals._attrNames[attr.id] = attr.name
    if (attr.attribute_type === 'text_list' || attr.attribute_type === 'entity_list') {
      // List attributes: per-item sentinel values matching the shape of getSourceValues for list ops
      const items = parseListValue(attr.value)
      for (const item of items) vals[`list_add:${attr.id}:${item}`] = '1'
    } else {
      // File-type attributes are authoritative via file_ref; value may mirror it but file_ref is canonical
      vals[`attr:${attr.id}`] = attr.attribute_type === 'file' ? (attr.file_ref || attr.value) : attr.value
    }
    // Phase 1.21f — per-attribute awareness baseline.
    // Phase 1.21g — wrapper-shape awareness: emit per-observer entries
    // AND per-source level keys so review-flag alerts can compare
    // contributor levels across the upstream / downstream pipeline.
    const _awarenessEntriesFor = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ('relationship_id' in raw && !('sources' in raw))) return null
      if ('entries' in raw || 'sources' in raw) return raw.entries || {}
      return raw
    }
    const _awarenessSourcesFor = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      return Array.isArray(raw.sources) ? raw.sources : []
    }
    const _sourceKey = (s) => {
      if (!s) return ''
      if (s.kind === 'relationship') return `rel:${s.relationship_id}`
      if (s.kind === 'attribute')    return `attr:${s.entity_id}:${s.attribute_id}`
      return ''
    }
    {
      const entries = _awarenessEntriesFor(attr.awareness)
      if (entries) for (const [obs, lvl] of Object.entries(entries)) vals[`awareness_set:${attr.id}:${obs}`] = lvl
      for (const s of _awarenessSourcesFor(attr.awareness)) {
        const k = _sourceKey(s)
        if (k) vals[`awareness_set:${attr.id}:source:${k}`] = s.level ?? null
      }
    }
  }
  // Phase 1.21f — entity-level awareness baselines.
  // Phase 1.21g — also seed source-keyed values for wrapper-shape fields.
  const _entriesOf = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ('relationship_id' in raw && !('sources' in raw))) return null
    if ('entries' in raw || 'sources' in raw) return raw.entries || {}
    return raw
  }
  const _sourcesOf = (raw) => (raw && typeof raw === 'object' && Array.isArray(raw.sources)) ? raw.sources : []
  const _srcKey = (s) => {
    if (!s) return ''
    if (s.kind === 'relationship') return `rel:${s.relationship_id}`
    if (s.kind === 'attribute')    return `attr:${s.entity_id}:${s.attribute_id}`
    return ''
  }
  {
    const entries = _entriesOf(entity.awareness)
    if (entries) for (const [obs, lvl] of Object.entries(entries)) vals[`awareness:entity:${obs}`] = lvl
    for (const s of _sourcesOf(entity.awareness)) {
      const k = _srcKey(s)
      if (k) vals[`awareness:entity:source:${k}`] = s.level ?? null
    }
  }
  {
    const entries = _entriesOf(entity.name_awareness)
    if (entries) for (const [obs, lvl] of Object.entries(entries)) vals[`awareness:entity_name:${obs}`] = lvl
    for (const s of _sourcesOf(entity.name_awareness)) {
      const k = _srcKey(s)
      if (k) vals[`awareness:entity_name:source:${k}`] = s.level ?? null
    }
  }
  return vals
}

/**
 * Compute the effective state arriving at sourceNodeId (BEFORE the source node's
 * own changes are applied) and return it as a { field: value } map.
 * Used to populate sourceInputValue in enriched review flags so alerts can show
 * "changed from X → Y to X → Z" style transitions.
 */
function getSourceInputValues(entityId, sourceNodeId, nodes, edges) {
  const es = useEntitiesStore.getState()
  const entity = [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
    .find((e) => e.id === entityId)
  if (!entity) return {}

  const chain = getEntityNarrativeChain(entityId, nodes, edges)
  const sourceIdx = chain.findIndex((n) => n.id === sourceNodeId)

  let state
  if (sourceIdx <= 0) {
    // Source is first in chain (or origin node) — input is base entity state
    state = {
      name: entity.name || '',
      colour: entity.colour || '#888888',
      description: entity.description || '',
      profile_image_ref: entity.profile_image_ref || null,
      attributes: (entity.attributes || []).map((a) => ({ ...a })),
      awareness: entity.awareness ?? null,
      name_awareness: entity.name_awareness ?? null,
    }
  } else {
    state = computeEffectiveState(entity, nodes, edges, chain[sourceIdx - 1].id)
  }

  const vals = {
    name: state.name,
    colour: state.colour,
    description: state.description,
    profile_image: state.profile_image_ref,
  }
  const attrNames = {}
  for (const attr of (state.attributes || [])) {
    // File-type attributes: effective state carries file_ref as the canonical value
    vals[`attr:${attr.id}`] = attr.file_ref !== undefined ? (attr.file_ref || attr.value) : attr.value
    attrNames[attr.id] = attr.name
    // Phase 1.21h — emit per-observer awareness keys so review-flag
    // alerts have a chain-resolved "input" value to render on the
    // upstream side of the transition. Without these the alert's
    // "Changed:" / "Therefore Changes:" rows lose the from-side glyph
    // (sourceInputValue stays undefined) and the rows collapse to a
    // single value or two identical values.
    const _attrEntries = (() => {
      const a = attr?.awareness
      if (!a || typeof a !== 'object' || Array.isArray(a)) return null
      if ('relationship_id' in a && !('entries' in a) && !('sources' in a)) return null
      if ('entries' in a || 'sources' in a) return a.entries || {}
      return a
    })()
    if (_attrEntries) {
      for (const [obs, lvl] of Object.entries(_attrEntries)) {
        vals[`awareness_set:${attr.id}:${obs}`] = lvl
      }
    }
  }
  vals._attrNames = attrNames
  // Phase 1.21h — emit per-observer awareness keys for entity-existence
  // and canonical-name awareness so review-flag alerts have a
  // chain-resolved upstream value to render on the from-side.
  const _entriesOf = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if ('relationship_id' in raw && !('entries' in raw) && !('sources' in raw)) return null
    if ('entries' in raw || 'sources' in raw) return raw.entries || {}
    return raw
  }
  {
    const entries = _entriesOf(state.awareness)
    if (entries) for (const [obs, lvl] of Object.entries(entries)) vals[`awareness:entity:${obs}`] = lvl
  }
  {
    const entries = _entriesOf(state.name_awareness)
    if (entries) for (const [obs, lvl] of Object.entries(entries)) vals[`awareness:entity_name:${obs}`] = lvl
  }
  return vals
}

/**
 * Extract the field name from a review flag entry.
 * Handles both legacy format (plain string) and enriched format (object with .field).
 */
function flagField(flag) {
  return typeof flag === 'string' ? flag : flag.field
}

/**
 * Targeted downstream review-flag update. Called after updateEntityRef to
 * reactively set/clear flags caused by a specific upstream edit.
 *
 * Only nodes DOWNSTREAM of sourceNodeId are touched. This is intentional:
 * the user's own edit at sourceNodeId is deliberate (review_fields cleared
 * at the source), and nodes upstream of sourceNodeId are unaffected.
 *
 * addedOrKeptFields — fields that now have a change in the updated EntityRef
 *   (newly added or still present after the edit); downstream refs that also
 *   change these fields will be flagged.
 *
 * removedFields — fields whose change was cleared in this edit; the downstream
 *   flag for those fields is removed (best-effort — if another upstream node
 *   independently caused the same flag, it will be restored next time that node
 *   is edited).
 *
 * sourceValues — optional { field: value } map of the NEW upstream values (after edit);
 *   when provided, flags are stored as enriched objects instead of plain strings.
 *
 * oldSourceValues — optional { field: value } map of the OLD upstream values (before edit);
 *   used to populate previousInherited so alerts can show "used to modify from X to Y".
 *
 * Does NOT call set() — caller is responsible.
 */
function applyDownstreamReviewFlags(nodes, edges, sourceNodeId, entityId, addedOrKeptFields, removedFields, sourceValues, oldSourceValues) {
  if (addedOrKeptFields.length === 0 && removedFields.length === 0) return nodes

  const downstreamNodes = findDownstreamEntityNodes(nodes, edges, sourceNodeId, entityId)
  if (downstreamNodes.length === 0) return nodes

  // Compute the effective state arriving at the source node (before its own change)
  // so review flags can show "input → output" transitions at the source.
  const sourceInputVals = sourceValues
    ? getSourceInputValues(entityId, sourceNodeId, nodes, edges)
    : undefined

  const removeSet = new Set(removedFields)
  // Track fields that have been "shielded" by an intermediate override.
  // When a downstream node overrides field X, further downstream nodes inherit
  // from THAT node — not from the original source — so they should not be flagged.
  // Entity chains are linear (one outgoing connection per chip) so BFS order is
  // equivalent to chain order and a single set suffices.
  const shieldedFields = new Set()
  let updated = nodes

  // Helper: build an enriched flag object for a given field
  function buildEnrichedFlag(f, downRef) {
    if (!sourceValues) return f  // legacy: plain string
    let downValue
    if (f === 'name') downValue = downRef.name_change
    else if (f === 'colour') downValue = downRef.colour_change
    else if (f === 'description') downValue = downRef.description_change
    else if (f === 'profile_image') downValue = downRef.profile_image_change
    else if (f.startsWith('attr:')) {
      const attrId = f.slice(5)
      const downAc = (downRef.attribute_changes || []).find(
        (ac) => (ac.action === 'add' && ac.attribute?.id === attrId) || ac.attribute_id === attrId
      )
      if (downAc) {
        if (downAc.action === 'add') {
          downValue = downAc.attribute?.file_ref !== undefined ? (downAc.attribute?.file_ref || downAc.attribute?.value) : downAc.attribute?.value
        } else if (downAc.action === 'modify') {
          // File-attribute modifications use file_ref_change; text attributes use new_value
          downValue = downAc.file_ref_change !== undefined ? downAc.file_ref_change : downAc.new_value
        } else {
          downValue = '(removed)'
        }
      }
    } else if (f.startsWith('list_add:') || f.startsWith('list_remove:')) {
      const colonIdx1 = f.indexOf(':')
      const colonIdx2 = f.indexOf(':', colonIdx1 + 1)
      const opAttrId = f.slice(colonIdx1 + 1, colonIdx2)
      const opItem = f.slice(colonIdx2 + 1)
      const downListAc = (downRef.attribute_changes || []).find(
        (ac) => (ac.action === 'list_add' || ac.action === 'list_remove') &&
                ac.attribute_id === opAttrId && ac.list_item === opItem
      )
      if (downListAc) downValue = downListAc.action  // 'list_add' or 'list_remove'
    }
    // Resolve field label for display
    let fieldLabel
    if (f.startsWith('list_add:') || f.startsWith('list_remove:')) {
      // Resolve attribute name for the list attribute
      const colonIdx1 = f.indexOf(':')
      const colonIdx2 = f.indexOf(':', colonIdx1 + 1)
      const opAttrId = f.slice(colonIdx1 + 1, colonIdx2)
      fieldLabel = sourceInputVals?._attrNames?.[opAttrId]
        || sourceValues._attrNames?.[opAttrId]
        || oldSourceValues?._attrNames?.[opAttrId]
      if (!fieldLabel) {
        const es = useEntitiesStore.getState()
        for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ent of (es[bk] || [])) {
            const a = (ent.attributes || []).find((at) => at.id === opAttrId)
            if (a) { fieldLabel = a.name; break }
          }
          if (fieldLabel) break
        }
      }
      fieldLabel = fieldLabel || 'List Attribute'
    } else if (f.startsWith('attr:')) {
      const attrId = f.slice(5)
      // sourceInputVals has names from the full effective state (most reliable for modify actions)
      fieldLabel = sourceInputVals?._attrNames?.[attrId]
        || sourceValues._attrNames?.[attrId]
        || oldSourceValues?._attrNames?.[attrId]
      if (!fieldLabel) {
        const downAc = (downRef.attribute_changes || []).find(
          (ac) => (ac.action === 'add' && ac.attribute?.id === attrId) || ac.attribute_id === attrId
        )
        fieldLabel = downAc?.attribute?.name
      }
      if (!fieldLabel) {
        const es = useEntitiesStore.getState()
        for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ent of (es[bk] || [])) {
            const a = (ent.attributes || []).find((at) => at.id === attrId)
            if (a) { fieldLabel = a.name; break }
          }
          if (fieldLabel) break
        }
      }
      fieldLabel = fieldLabel || 'Attribute'
    } else if (f.startsWith('awareness_set:')) {
      // Phase 1.21f — per-attribute per-observer awareness flag.
      //   'awareness_set:<attrId>:<observerId>'
      // Phase 1.21g — per-attribute source-mutation flag.
      //   'awareness_set:<attrId>:source:<rel:relId | attr:eid:aid>'
      const parts = f.split(':')
      const attrId = parts[1]
      const sourceIdx = parts.indexOf('source')
      const isSourceField = sourceIdx > 0 && parts.length > sourceIdx + 1
      let observerId = null
      if (isSourceField) {
        // Awareness chain-entry downstream values live on the host's
        // `awareness.history` post v0.2a.2.5; the per-entry review flag
        // pipeline reads them directly. `downValue` stays undefined here;
        // alert UI degrades gracefully when no current-value comparison
        // is available for this flag shape.
      } else {
        observerId = parts.slice(2).join(':')
      }
      // Resolve attribute name for the label (shared by both branches).
      let attrName = sourceInputVals?._attrNames?.[attrId] || sourceValues._attrNames?.[attrId] || oldSourceValues?._attrNames?.[attrId]
      const es = useEntitiesStore.getState()
      if (!attrName) {
        for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ent of (es[bk] || [])) {
            const a = (ent.attributes || []).find((at) => at.id === attrId)
            if (a) { attrName = a.name; break }
          }
          if (attrName) break
        }
      }
      if (isSourceField) {
        // Source-keyed label: "<Attribute> awareness via <source>".
        const srcKind = parts[sourceIdx + 1]
        let sourceLabel
        if (srcKind === 'rel') {
          const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === parts[sourceIdx + 2])
          sourceLabel = rel?.name?.trim() || 'relationship'
        } else if (srcKind === 'attr') {
          const eid = parts[sourceIdx + 2]
          const aid = parts[sourceIdx + 3]
          let ownerName, srcAttrName
          for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
            const e = (es[bk] || []).find((ent) => ent.id === eid)
            if (e) { ownerName = e.name; srcAttrName = (e.attributes || []).find((a) => a.id === aid)?.name; break }
          }
          sourceLabel = `${ownerName || 'Entity'} ${srcAttrName || 'attribute'}`
        }
        fieldLabel = `${attrName || 'Attribute'} awareness via ${sourceLabel || 'source'}`
      } else {
        let observerName
        for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
          const e = (es[bk] || []).find((ent) => ent.id === observerId)
          if (e) { observerName = e.name; break }
        }
        fieldLabel = `${attrName || 'Attribute'} awareness for ${observerName || 'observer'}`
      }
    } else if (f.startsWith('awareness:')) {
      // Phase 1.21f — entity-level awareness flag.
      // Direct-entry forms:
      //   'awareness:entity:<observerId>'
      //   'awareness:entity_name:<observerId>'
      //   'awareness:relationship:<relId>:<observerId>'
      // Phase 1.21g — source-mutation forms (`:source:<srcKey>` segment):
      //   'awareness:entity:source:rel:<relId>'
      //   'awareness:entity_name:source:rel:<relId>'
      //   'awareness:relationship:<relId>:source:rel:<srcRelId>'
      //   (and `attr:<eid>:<aid>` source-key variants)
      const parts = f.split(':')
      const subKind = parts[1]  // 'entity' | 'entity_name' | 'relationship'
      const sourceIdx = parts.indexOf('source')
      const isSourceField = sourceIdx > 0 && parts.length > sourceIdx + 1
      // Awareness chain-entry downstream values live on the host's
      // `awareness.history` post v0.2a.2.5; the per-entry review flag
      // pipeline reads them directly. `downValue` stays undefined here.
      if (isSourceField) {
        const srcKind = parts[sourceIdx + 1]  // 'rel' | 'attr'
        let sourceLabel
        if (srcKind === 'rel') {
          const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === parts[sourceIdx + 2])
          sourceLabel = rel?.name?.trim() || 'relationship'
        } else if (srcKind === 'attr') {
          const eid = parts[sourceIdx + 2]
          const aid = parts[sourceIdx + 3]
          const es = useEntitiesStore.getState()
          let attrName, ownerName
          for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
            const e = (es[bk] || []).find((ent) => ent.id === eid)
            if (e) { ownerName = e.name; attrName = (e.attributes || []).find((a) => a.id === aid)?.name; break }
          }
          sourceLabel = `${ownerName || 'Entity'} ${attrName || 'attribute'}`
        }
        const subjectLabel = subKind === 'entity_name' ? 'Name' : (subKind === 'relationship' ? 'Relationship' : 'Existence')
        fieldLabel = `${subjectLabel} awareness via ${sourceLabel || 'source'}`
      } else {
        const observerId = subKind === 'relationship' ? parts[3] : parts[2]
        const es = useEntitiesStore.getState()
        let observerName
        for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
          const e = (es[bk] || []).find((ent) => ent.id === observerId)
          if (e) { observerName = e.name; break }
        }
        const subjectLabel = subKind === 'entity_name' ? 'Name' : (subKind === 'relationship' ? 'Relationship' : 'Existence')
        fieldLabel = `${subjectLabel} awareness for ${observerName || 'observer'}`
      }
    }
    const previousInherited = oldSourceValues?.[f] ?? sourceInputVals?.[f]
    // When the upstream override was REMOVED (not just changed), the
    // value flowing past the source node is no longer `sourceValues[f]`
    // (which is null/undefined — there's no override anymore) but the
    // value inherited INTO the source from upstream of it. The alert
    // renderer needs that inherited value to show the user what the
    // downstream's override is now sitting on top of.
    const wasRemoved = removeSet.has(f)
    const currentInherited = wasRemoved ? sourceInputVals?.[f] : sourceValues[f]
    // Phase 1.21h — when the upstream edit produces a new inherited
    // value that equals the downstream override's value, the override
    // is technically still on the chain but no longer producing a
    // delta. Mark the flag as `redundant` so the alert renderer can
    // route it through the redundancy template (Remove / Keep buttons)
    // instead of the standard review-flag template.
    const redundant = currentInherited !== undefined
      && downValue !== undefined
      && currentInherited === downValue
    return {
      field: f,
      ...(fieldLabel ? { fieldLabel } : {}),
      sourceInputValue: sourceInputVals?.[f],
      previousInherited,
      currentInherited,
      downstreamValue: downValue,
      sourceNodeId,
      ...(redundant ? { redundant: true } : {}),
    }
  }

  for (const downNode of downstreamNodes) {
    const isModifier = downNode.type === 'entityNode' && downNode.data.is_modifier

    // Resolve the downstream ref from the current `updated` state (earlier iterations may have modified it)
    const currentDownNode = updated.find((n) => n.id === downNode.id) ?? downNode

    // Resolve the downstream ref: for modifier nodes, fields are directly on node.data;
    // for plot point nodes, they are inside an EntityRef in one of the entity buckets.
    let downRef = null
    let bucket = null
    let idx = -1
    if (isModifier) {
      downRef = currentDownNode.data
    } else {
      for (const b of ENTITY_BUCKETS) {
        const refs = currentDownNode.data[b] || []
        const i = refs.findIndex((r) => r.entity_id === entityId)
        if (i !== -1) { downRef = refs[i]; bucket = b; idx = i; break }
      }
    }
    if (!downRef) continue

    // Filter out shielded fields: already handled by an intermediate node
    const activeAdded = addedOrKeptFields.filter((f) => !shieldedFields.has(f))
    const activeRemoveSet = new Set([...removeSet].filter((f) => !shieldedFields.has(f)))

    // Aliases auto-resolve / redundant-override detection is not
    // wired for the per-event `alias_changes` model — the legacy
    // full-list `aliases_change` snapshot had a "same full list =
    // redundant" structural test that doesn't translate to per-event
    // semantics. The `'aliases'` field still feeds the normal review-
    // flag pipeline below (via `getChangedFields`); the auto-resolve
    // affordance just isn't part of that today. Future per-event-
    // specific redundancy detection (e.g. "downstream `add Ali` is
    // redundant when upstream `add Ali` for the same alias_id exists")
    // can be added here when wanted.
    const autoResolvedAliases = []

    // ── Auto-cancel duplicate list ops ──
    // When upstream adds/removes a specific list item that the downstream also adds/removes,
    // the downstream op is redundant (it would double-add or double-remove). Mark it
    // cancelled: true (keeps the sub-chip visible in a pending-review draft state) and
    // generate a cancelled review flag so the user knows what happened.
    const listConflictFields = activeAdded.filter((f) => f.startsWith('list_add:') || f.startsWith('list_remove:'))
    const cancelledListOps = []  // { key, origAction }
    if (listConflictFields.length > 0) {
      const nextAcs = (downRef.attribute_changes || []).map((ac) => {
        if (ac.action !== 'list_add' && ac.action !== 'list_remove') return ac
        const key = `${ac.action}:${ac.attribute_id}:${ac.list_item}`
        if (listConflictFields.includes(key)) {
          cancelledListOps.push({ key, origAction: ac.action })
          if (!ac.cancelled) return { ...ac, cancelled: true }
        }
        return ac
      })
      if (cancelledListOps.length > 0) {
        downRef = { ...downRef, attribute_changes: nextAcs }
        updated = updated.map((n) => {
          if (n.id !== currentDownNode.id) return n
          if (isModifier) {
            return { ...n, data: { ...n.data, attribute_changes: nextAcs } }
          }
          const newBucketAcs = (n.data[bucket] || []).map((r, i2) =>
            i2 === idx ? { ...r, attribute_changes: nextAcs } : r
          )
          return { ...n, data: { ...n.data, [bucket]: newBucketAcs } }
        })
      }
    }

    // ── Un-cancel resolved list ops ──
    // When an upstream list op is removed, any downstream op that was cancelled because of it
    // should be restored to active status (cancelled: true → removed) so the sub-chip reverts
    // to its normal appearance and the item is included in the effective state again.
    const restoreFields = new Set(
      [...activeRemoveSet].filter((f) => f.startsWith('list_add:') || f.startsWith('list_remove:'))
    )
    if (restoreFields.size > 0) {
      const needsRestore = (downRef.attribute_changes || []).some(
        (ac) => ac.cancelled && restoreFields.has(`${ac.action}:${ac.attribute_id}:${ac.list_item}`)
      )
      if (needsRestore) {
        const restoredAcs = (downRef.attribute_changes || []).map((ac) => {
          if (!ac.cancelled) return ac
          if (restoreFields.has(`${ac.action}:${ac.attribute_id}:${ac.list_item}`)) {
            const { cancelled: _cancelled, ...rest } = ac
            return rest  // remove the cancelled marker
          }
          return ac
        })
        downRef = { ...downRef, attribute_changes: restoredAcs }
        updated = updated.map((n) => {
          if (n.id !== currentDownNode.id) return n
          if (isModifier) {
            return { ...n, data: { ...n.data, attribute_changes: restoredAcs } }
          }
          const newBucketRest = (n.data[bucket] || []).map((r, i2) =>
            i2 === idx ? { ...r, attribute_changes: restoredAcs } : r
          )
          return { ...n, data: { ...n.data, [bucket]: newBucketRest } }
        })
      }
    }

    // ── Flag dangling list-remove ops ──
    // When an upstream list_add for an item is removed (removedFields contains
    // list_add:attrId:item), any active downstream list_remove for the same item
    // is now dangling — it's trying to remove something no longer added upstream.
    // Flag it so the user can Confirm (dismiss, keep as harmless no-op) or
    // Undo (remove the list_remove entry from this node entirely).
    const danglingListOps = []
    for (const f of [...activeRemoveSet]) {
      if (!f.startsWith('list_add:')) continue
      const tail = f.slice('list_add:'.length)           // 'attrId:item'
      const danglingField = `list_remove:${tail}`
      const hasActiveRemove = (downRef.attribute_changes || []).some(
        (ac) => ac.action === 'list_remove' &&
                `list_remove:${ac.attribute_id}:${ac.list_item}` === danglingField &&
                !ac.cancelled
      )
      if (hasActiveRemove) danglingListOps.push({ key: danglingField })
    }
    // When an upstream add reappears (activeAdded has list_add:attrId:item), the
    // corresponding dangling remove becomes valid again — mark for removal.
    const clearedDanglingFields = new Set()
    for (const f of activeAdded) {
      if (f.startsWith('list_add:')) clearedDanglingFields.add(`list_remove:${f.slice('list_add:'.length)}`)
    }

    const downChangedFields = getChangedFields(downRef)
    const currentFlags = downRef.review_fields || []

    // Fields that overlap with downstream overrides (normal conflict alerts)
    const overlapping = activeAdded.filter((f) => downChangedFields.includes(f))
    // Removed-field overlap: when the upstream OVERRIDE was removed
    // (the modifier is gone) AND the downstream still overrides that
    // field, the downstream's override now sits on top of a different
    // inherited base value. That's also a conflict the user should
    // review, so include those fields in the flag set.
    const overlappingFromRemoved = [...activeRemoveSet].filter((f) => downChangedFields.includes(f))
    // Set of fields to add or update
    const overlappingSet = new Set([...overlapping, ...overlappingFromRemoved])

    // Build merged flags: update existing flags with fresh data, add new ones, remove cleared ones
    const mergedFlags = [
      ...currentFlags
        .filter((flag) => {
          // Drop flags for fields removed upstream, but only when the
          // downstream no longer overrides that field. If it still
          // does, the flag is refreshed below — the conflict isn't
          // gone, it just shifted to a new inherited base.
          if (activeRemoveSet.has(flagField(flag)) && !downChangedFields.includes(flagField(flag))) return false
          // Remove stale cancelled flags for fields now being refreshed
          if (cancelledListOps.some((c) => flagField(flag) === c.key)) return false
          // Clear dangling flags when upstream add reappears, or rebuild with fresh data
          if (typeof flag === 'object' && flag.dangling) {
            if (clearedDanglingFields.has(flagField(flag))) return false
            if (danglingListOps.some((d) => d.key === flagField(flag))) return false
          }
          return true
        })
        .map((flag) => {
          // If this existing flag's field is in the current change set, refresh its data
          if (overlappingSet.has(flagField(flag))) {
            overlappingSet.delete(flagField(flag))  // mark as handled
            return buildEnrichedFlag(flagField(flag), downRef)
          }
          return flag
        }),
      // Add brand-new flags for any remaining overlapping fields not already present
      ...[...overlappingSet].map((f) => buildEnrichedFlag(f, downRef)),
      // Cancelled list ops get a special cancelled flag so the user knows why the item disappeared
      ...cancelledListOps.map(({ key, origAction }) => ({
        ...buildEnrichedFlag(key, downRef),
        downstreamValue: origAction,  // record what the downstream was doing before cancel
        cancelled: true,
      })),
      // Dangling list-remove ops — the item is no longer in the upstream list to remove
      ...danglingListOps.map(({ key }) => ({
        ...buildEnrichedFlag(key, downRef),
        dangling: true,
      })),
      // Auto-resolved redundant aliases override — strip happened above;
      // alert offers Accept (dismiss) or Revert (restore the override).
      ...autoResolvedAliases.map(({ previousDownstreamValue, names }) => ({
        field: 'aliases',
        sourceNodeId,
        autoResolved: true,
        previousDownstreamValue,
        aliasNames: names,
      })),
    ]

    // Shield further downstream nodes for any field this node overrides.
    // Also shield cancelled list op fields — they were removed from this node.
    for (const f of downChangedFields) {
      shieldedFields.add(f)
    }
    for (const { key } of cancelledListOps) {
      shieldedFields.add(key)
    }

    if (
      mergedFlags.length === currentFlags.length &&
      mergedFlags.every((flag, i) => {
        const cur = currentFlags[i]
        if (flagField(flag) !== flagField(cur)) return false
        // Deep-compare enriched flags to detect value updates (stale data fix)
        if (typeof flag === 'object' && typeof cur === 'object') {
          return flag.currentInherited === cur.currentInherited &&
                 flag.previousInherited === cur.previousInherited &&
                 flag.sourceInputValue === cur.sourceInputValue &&
                 flag.downstreamValue === cur.downstreamValue &&
                 flag.cancelled === cur.cancelled &&
                 flag.dangling === cur.dangling
        }
        return true
      })
    ) continue  // no change

    updated = updated.map((n) => {
      if (n.id !== currentDownNode.id) return n
      if (isModifier) {
        return { ...n, data: { ...n.data, review_fields: mergedFlags } }
      }
      const newBucket = (n.data[bucket] || []).map((r, i) =>
        i === idx ? { ...r, review_fields: mergedFlags } : r
      )
      return { ...n, data: { ...n.data, [bucket]: newBucket } }
    })
  }
  return updated
}

/**
 * Universal review-flag stamper for awareness-as-second-class-object
 * history. Operates on a single awareness wrapper (the kind that lives
 * on `Entity.awareness`, `Entity.name_awareness`, `Attribute.awareness`,
 * `Alias.awareness`, `Relationship.awareness`, or `Knowledge.awareness`)
 * and stamps `review_flag` on per-observer entries in `awareness.history`
 * that are downstream of a recent edit at `sourceNodeId` in STORY order.
 *
 * Awareness chain entries are walked in story order (see
 * `applyAwarenessHistoryToWrapper` in narrativeChain.js) — the awareness's
 * own chain follows the global narrative timeline, NOT the observer's or
 * host's entity chain. Review-flag propagation must use the same
 * ordering: an entry is downstream of `sourceNodeId` iff its story-order
 * index is strictly greater.
 *
 * Flag shape mirrors the EntityRef-side enriched flag so AlertsPanel
 * renders via the same templates without per-storage branching:
 *   { previousInherited, currentInherited, downstreamValue,
 *     redundant?, sourceNodeId }
 *
 * Source-mutation history entries (action add/remove/set_level on a
 * projected source) carry no `observer_id` and aren't subject to
 * per-observer flagging — they're skipped.
 *
 * Returns a new awareness wrapper if any entry was stamped, otherwise
 * the original `awareness` value unchanged.
 */
function applyDownstreamAwarenessHistoryReviewFlags(awareness, observerEntityId, sourceNodeId, storyOrder, baselineLevel) {
  if (!awareness || typeof awareness !== 'object' || Array.isArray(awareness)) return awareness
  if (!observerEntityId) return awareness
  const history = Array.isArray(awareness.history) ? awareness.history : null
  if (!history || history.length === 0) return awareness

  const orderedIds = storyOrder?.orderedIds || (Array.isArray(storyOrder) ? storyOrder : null)
  if (!orderedIds) return awareness
  const indexById = storyOrder?.indexById || new Map(orderedIds.map((id, i) => [id, i]))

  // sourceIdx: story-order index of the recent edit. For origin writes
  // (sourceNodeId == null) every entry on the awareness object qualifies,
  // so use -1 (every story-order index is greater).
  const sourceIdx = sourceNodeId == null
    ? -1
    : (indexById.get(sourceNodeId) ?? null)
  if (sourceIdx === null) return awareness

  const sorted = [...history].sort((a, b) => {
    const ai = indexById.has(a.node_id) ? indexById.get(a.node_id) : Infinity
    const bi = indexById.has(b.node_id) ? indexById.get(b.node_id) : Infinity
    return ai - bi
  })

  const sourceEntry = sourceNodeId
    ? sorted.find((c) => c.node_id === sourceNodeId && !c.source_action && c.observer_id === observerEntityId)
    : null
  const sourceEntryId = sourceEntry?.id ?? null

  function computeInheritedBefore(evalEntryId, omitSource = false) {
    let level = baselineLevel ?? null
    for (const ch of sorted) {
      if (ch.id === evalEntryId) return level
      if (omitSource && sourceEntryId && ch.id === sourceEntryId) continue
      if (ch.source_action) continue
      if (ch.observer_id !== observerEntityId) continue
      level = (ch.level == null) ? null : ch.level
    }
    return null
  }

  let changed = false
  const newHistory = history.map((ch) => {
    if (ch.source_action) return ch
    if (ch.observer_id !== observerEntityId) return ch
    const idx = indexById.has(ch.node_id) ? indexById.get(ch.node_id) : null
    if (idx === null) return ch
    if (idx <= sourceIdx) return ch

    const currentInherited = computeInheritedBefore(ch.id, false)
    const previousInherited = sourceEntryId
      ? computeInheritedBefore(ch.id, true)
      : (ch.review_flag?.currentInherited ?? null)
    const downstreamValue = ch.level
    const redundant = currentInherited !== undefined
      && downstreamValue !== undefined
      && currentInherited === downstreamValue

    const newFlag = {
      previousInherited,
      currentInherited,
      downstreamValue,
      sourceNodeId: sourceNodeId ?? null,
      ...(redundant ? { redundant: true } : {}),
    }
    const existing = ch.review_flag
    if (
      existing
      && existing.previousInherited === newFlag.previousInherited
      && existing.currentInherited === newFlag.currentInherited
      && existing.downstreamValue === newFlag.downstreamValue
      && (existing.redundant === true) === (newFlag.redundant === true)
      && existing.sourceNodeId === newFlag.sourceNodeId
    ) {
      return ch
    }
    changed = true
    return { ...ch, review_flag: newFlag }
  })
  if (!changed) return awareness
  return { ...awareness, history: newHistory }
}

/**
 * Returns true if adding a narrative-flow edge from sourceId → targetId would
 * create a directed cycle in the flow graph.
 * Only non-relationship edges are considered — relationship wires are not flow
 * connections and are exempt from cycle detection.
 */
export function wouldCreateCycle(edges, sourceId, targetId) {
  // A self-connection is trivially a cycle (though relationship self-loops are already
  // exempt because they are handled before cycle detection is reached in onConnect).
  if (sourceId === targetId) return true

  // Build adjacency map from existing narrative-flow edges
  const flowEdges = edges.filter((e) => !e.data?.is_relationship)
  const adj = new Map()
  for (const e of flowEdges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set())
    adj.get(e.source).add(e.target)
  }

  // BFS from targetId — if we can reach sourceId, a cycle would be created
  const visited = new Set()
  const queue = [targetId]
  while (queue.length > 0) {
    const curr = queue.shift()
    if (curr === sourceId) return true
    if (visited.has(curr)) continue
    visited.add(curr)
    for (const next of (adj.get(curr) || [])) {
      queue.push(next)
    }
  }
  return false
}

/**
 * Tier-1/2 block rule for `onConnect`: if the proposed narrative-flow wire from
 * `sourceId → targetId` would contradict an ordering already established by the
 * POV chain (tier 1) or a connected entity chain (tier 2), fire a user-facing
 * rejection dialog via `buildContradictStoryOrderMessage` and return `true` so
 * the caller can bail early.
 *
 * Tiers 3-11 (orphan segment, chapter, canvas-x/y, node-type, name cascade)
 * are inferred or tiebreaker-only signals and are never grounds for a block —
 * those orderings may be overridden by the very wire the user is trying to
 * create.
 *
 * Computes the story order inline from the store's current state because
 * `projectStore` is not a React context and can't call `useStoryOrder()`.
 * Cost: one full recompute per onConnect; negligible at representative story
 * sizes (<25ms on a 100-scene fixture).
 */
function _checkContradictsStoryOrder(get, sourceId, targetId) {
  const state = get()
  const nodes = state.nodes
  const edges = state.edges
  const story = state.story
  const chapters = story?.chapters || []
  const chapterXOffset = typeof story?.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
  // F#5: route through the shared module-level cache that `useStoryOrder`
  // populates. This guard fires pre-flight before every wire commit;
  // input refs are almost always identity-equal to what the cache
  // holds (the React tree just rendered with this same store state),
  // so the call is an instant cache read instead of a fresh ~50-75ms
  // graph walk. Cache miss falls through to a fresh compute.
  const storyOrder = getOrComputeStoryOrder({ nodes, edges, chapters, chapterXOffset })
  if (!wouldContradictStoryOrder(storyOrder, sourceId, targetId)) return false
  // Build entityMap for the rejection dialog's NodeBadge rendering.
  const es = useEntitiesStore.getState()
  const entityMap = new Map(
    [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
      .map((e) => [e.id, e])
  )
  confirm({
    title: 'Cannot create connection',
    message: buildContradictStoryOrderMessage({
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      nodes,
      entityMap,
    }),
    buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
  })
  return true
}

/**
 * Walk backwards from targetNodeId through the connection graph (BFS) and find
 * the closest upstream node that already has a chip for entityId.
 * Returns { sourceNode, ambiguous }:
 *   - sourceNode: the found node (or null if not found / ambiguous)
 *   - ambiguous: true if multiple equidistant candidates were found
 *
 * Note: POV-path priority (spec §upstream-search) is not yet implemented —
 * this searches all upstream paths uniformly.
 */
function findUpstreamEntitySource(nodes, edges, targetNodeId, entityId) {
  const visited = new Set([targetNodeId])

  // Build initial frontier: direct predecessors of the target node
  let frontier = edges
    .filter((e) => e.target === targetNodeId)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter(Boolean)

  while (frontier.length > 0) {
    const candidates = []
    const nextFrontier = []

    for (const node of frontier) {
      if (visited.has(node.id)) continue
      visited.add(node.id)

      let hasEntity = false
      if (node.type === 'sceneNode') {
        hasEntity = ENTITY_BUCKETS.some((b) =>
          (node.data[b] || []).some((r) => r.entity_id === entityId)
        )
      } else if (node.type === 'entityNode') {
        hasEntity = node.data.entity_id === entityId
      }

      if (hasEntity) {
        candidates.push(node)
      } else {
        // Continue searching further upstream
        edges
          .filter((e) => e.target === node.id)
          .forEach((e) => {
            const pred = nodes.find((n) => n.id === e.source)
            if (pred && !visited.has(pred.id)) nextFrontier.push(pred)
          })
      }
    }

    if (candidates.length === 1) return { sourceNode: candidates[0], ambiguous: false }
    if (candidates.length > 1) {
      // Tie-breaker: when multiple equidistant candidates exist AND
      // one of them is the immediate POV-chain predecessor of the
      // target scene, prefer that one. For linear POV chains this is
      // the natural "most recent" pick and is correct ~100% of the
      // time. Surfaced 2026-05-18 by the rom-com blind-agent tests:
      // the agent kept hitting the ambiguous-error path even when one
      // candidate was clearly the immediately-prior POV scene where
      // the entity also lived. With this fallback, the ambiguous
      // error fires only when NEITHER candidate is the prior POV
      // scene — i.e. when the disambiguation genuinely needs human
      // input. The explicit `predecessor` arg on `add_entity_to_scene`
      // still overrides this when the caller wants to disambiguate
      // manually.
      const povInEdge = edges.find(
        (e) => e.data?.is_pov_path && e.target === targetNodeId,
      )
      const povPredId = povInEdge ? povInEdge.source : null
      if (povPredId) {
        const recencyPick = candidates.find((c) => c.id === povPredId)
        if (recencyPick) return { sourceNode: recencyPick, ambiguous: false, picked_via: 'pov_recency' }
      }
      return { sourceNode: null, ambiguous: true }
    }

    frontier = nextFrontier
  }

  return { sourceNode: null, ambiguous: false }
}

/**
 * Cycle safeguard for the D2 auto-wire / auto-stitch helpers. Returns
 * true if `endNodeId` is reachable from `startNodeId` by following
 * narrative-flow edges that carry `entityId`'s chain (so adding a wire
 * from endNodeId → startNodeId would close a loop in this entity's
 * chain).
 *
 * Walks forward from `startNodeId` only through edges where the entity
 * is part of the wire's chain — narrative-flow edges from a scene's
 * per-chip handle (`sourceHandle === entityId`) or from the entity's
 * origin/modifier EntityNode (non-relationship outgoing). Relationship
 * wires are not chain links and are ignored.
 *
 * Defensive cycle guard via `visited` so the walk terminates on
 * already-existing loops (which shouldn't exist, but if they do we
 * don't want to spin forever).
 */
function _isFlowReachable(startNodeId, endNodeId, edges, entityId) {
  if (startNodeId === endNodeId) return true
  const visited = new Set([startNodeId])
  const frontier = [startNodeId]
  while (frontier.length > 0) {
    const cur = frontier.shift()
    for (const e of edges) {
      if (e.source !== cur) continue
      if (e.data?.is_relationship) continue
      // From a scene's per-chip handle, the wire is for that entity only.
      // From an entity's origin/modifier node (no sourceHandle), the wire
      // is the entity's own chain link.
      if (e.sourceHandle != null && e.sourceHandle !== entityId) continue
      const next = e.target
      if (next === endNodeId) return true
      if (visited.has(next)) continue
      visited.add(next)
      frontier.push(next)
    }
  }
  return false
}

const RECENT_KEY = 'nn_recent_projects'
const MAX_RECENT = 5

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    // Recents are POINTERS, never copies. Strip any legacy embedded
    // `story` blob written by older builds so a bloated store shrinks
    // itself the next time writeRecent persists the (now-slim) list.
    return raw.map((r) => {
      const { story, ...rest } = r || {}  // eslint-disable-line no-unused-vars
      return rest
    })
  } catch { return [] }
}

function writeRecent(list) {
  // A recents-list write is convenience bookkeeping ONLY. It must never
  // turn a successful save or load into a failure, so a localStorage
  // failure (e.g. QuotaExceededError) is swallowed: worst case the list
  // just doesn't update this time.
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch (err) {
    console.warn('[recents] list not persisted:', err?.message || err)
  }
}

/**
 * Migrate an EntityRef from old format (attribute_overrides) to new format (attribute_changes).
 * Safe to call on already-migrated refs — if attribute_changes is present, returns unchanged.
 */
function migrateEntityRef(ref) {
  if (ref.attribute_changes !== undefined) return ref
  const attribute_changes = (ref.attribute_overrides || []).map((ao) => ({
    action: 'modify',
    attribute_id: ao.attribute_id,
    attribute: null,
    new_value: ao.value,
  }))
  const { attribute_overrides, ...rest } = ref  // eslint-disable-line no-unused-vars
  return { ...rest, attribute_changes }
}

/** Convert backend story data → React Flow nodes + edges. */
// Phase 4.1g follow-up — initial dimension estimates per node type. Used
// to seed `measured` on load so React Flow's `onlyRenderVisibleElements`
// can cull off-screen nodes from the very first frame (before its
// ResizeObserver has measured anything) and so the MiniMap can size nodes
// that are virtualized out of the DOM. Real measurements overwrite these
// the moment a node renders; the estimates only ever drive virtualization
// culling and the MiniMap preview for not-yet-rendered nodes, so they err
// slightly large to avoid culling a node that should be on screen.
const NODE_DIM_DEFAULTS = {
  sceneNode: { width: 400, height: 480 },
  entityNode: { width: 250, height: 240 },
  referenceNode: { width: 320, height: 240 },
  povOriginNode: { width: 200, height: 140 },
  relationshipOriginNode: { width: 240, height: 180 },
  knowledgeOriginNode: { width: 240, height: 180 },
  genericGroupNode: { width: 400, height: 300 },
}
const DEFAULT_NODE_DIM = { width: 300, height: 220 }

function storyToFlow(story) {
  if (!story) return { nodes: [], edges: [] }
  // Phase 4.1g #4 — fresh canvas, fresh measurements. Stale ids from
  // the prior project must not satisfy dimension reads in the new one.
  clearMeasuredDimensions()
  let nodes = [
    ...(story.entity_nodes || []).map((n) => ({
      id: n.id,
      type: 'entityNode',
      position: { x: n.position.x, y: n.position.y },
      ...(n.width  ? { style: { width: n.width, height: n.height } } : {}),
      // Migration: old entity nodes used attribute_overrides — convert to attribute_changes
      data: { ...migrateEntityRef(n) },
    })),
    ...(story.scenes || []).map((n) => {
      // Migration: old nodes have no `title` field — promote summary → title
      const hasTitle = n.title !== undefined && n.title !== null
      // Migration: old EntityRefs used `attribute_overrides` — convert to `attribute_changes`
      const BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
      const migratedBuckets = Object.fromEntries(
        BUCKETS.map((b) => [b, (n[b] || []).map(migrateEntityRef)])
      )
      return {
        id: n.id,
        type: 'sceneNode',
        position: { x: n.position.x, y: n.position.y },
        ...(n.width  ? { style: { width: n.width, height: n.height } } : {}),
        data: {
          ...n,
          ...migratedBuckets,
          title:       hasTitle ? n.title       : (n.description || n.summary || ''),
          description: hasTitle ? (n.description ?? n.summary ?? '') : '',
        },
      }
    }),
    ...(story.reference_nodes || []).map((n) => {
      const isCollapsed = n.collapsed
      const cw = n.collapsed_width
      const ch = n.collapsed_height
      let style
      let measured
      if (isCollapsed && cw) {
        style = { width: cw, height: ch }
        measured = { width: cw, height: ch }
      } else if (n.width) {
        style = { width: n.width, height: n.height }
      }
      return {
        id: n.id,
        type: 'referenceNode',
        position: { x: n.position.x, y: n.position.y },
        ...(style ? { style } : {}),
        ...(measured ? { measured } : {}),
        data: { ...n },
      }
    }),
    // POV Origin Node (at most one)
    ...(story.pov_origin_node ? [{
      id: story.pov_origin_node.id,
      type: 'povOriginNode',
      position: { x: story.pov_origin_node.position.x, y: story.pov_origin_node.position.y },
      data: { ...story.pov_origin_node },
    }] : []),
    // Phase 1.18: relationship origin nodes (one per relationship with a declared origin).
    ...(story.relationship_origin_nodes || []).map((n) => ({
      id: n.id,
      type: 'relationshipOriginNode',
      position: { x: n.position.x, y: n.position.y },
      ...(n.width ? { style: { width: n.width, height: n.height } } : {}),
      data: { ...n },
    })),
    // Phase 1.21c Step 14: knowledge origin nodes (one per Knowledge with
    // a declared creation-point anchor on canvas).
    ...(story.knowledge_origin_nodes || []).map((n) => ({
      id: n.id,
      type: 'knowledgeOriginNode',
      position: { x: n.position.x, y: n.position.y },
      ...(n.width ? { style: { width: n.width, height: n.height } } : {}),
      data: { ...n },
    })),
    // Phase 1.11 Track I — generic group containers. Rendered as React Flow
    // nodes of type 'genericGroupNode' with an explicit `style` carrying
    // width/height so React Flow reports them in `measured.{width,height}`
    // for the group-membership bbox math.
    ...(story.groups || []).map((g) => ({
      id: g.id,
      type: 'genericGroupNode',
      position: { x: g.position.x, y: g.position.y },
      style: { width: g.width, height: g.height },
      data: { ...g },
      // Groups sit visually BEHIND other nodes via a lower React Flow
      // z-index. Scene / entity / reference nodes stay on top.
      zIndex: -1,
      // Drag is restricted to the header bar via dragHandle; the rest of
      // the body is click-through via CSS so nodes inside can be
      // interacted with normally.
      dragHandle: '.nn-group-drag-handle',
    })),
  ]
  // Seed an initial `measured` estimate on every node that lacks one (all
  // but the collapsed reference nodes, which already carry an exact one).
  // This lets React Flow virtualize and the MiniMap size nodes before the
  // ResizeObserver has run — see NODE_DIM_DEFAULTS. Persisted resize
  // dimensions (on `style`) are exact; everything else gets the per-type
  // estimate. Real measurements overwrite this the moment a node renders.
  nodes = nodes.map((n) => {
    if (n.measured) return n
    const pw = n.style?.width
    const ph = n.style?.height
    const d = NODE_DIM_DEFAULTS[n.type] || DEFAULT_NODE_DIM
    return {
      ...n,
      measured: {
        width: typeof pw === 'number' ? pw : d.width,
        height: typeof ph === 'number' ? ph : d.height,
      },
    }
  })
  // SceneNode entity-chip handles have named IDs (= entity ID). EntityNode handles are
  // unnamed — setting sourceHandle to the entity ID on those edges causes React Flow to
  // silently drop the edge because no handle with that ID exists on the source node.
  const sceneIds = new Set((story.scenes || []).map((n) => n.id))
  // Map entity node IDs → entity_id for Case 2 migration (see below)
  const entityNodeEntityIdMap = new Map((story.entity_nodes || []).map((n) => [n.id, n.entity_id]))
  // Wire-ID canonicalisation: pre-fix, three wire-id templates used
  // `${entityId.slice(-6)}` as the discriminator suffix. If two
  // entities in the same relationship (or same source/target pair for
  // narrative-flow wires) shared the same last 6 UUID chars, both
  // wires got the same id and React's reconciler complained about
  // duplicate keys. Generation has since switched to the full entityId
  // (collision-free). This helper rewrites any old-format id on load
  // by reconstructing it from the canonical template using fields
  // already stored on the connection. Idempotent: a new-format id
  // already in canonical form reconstructs to itself.
  const _canonicaliseWireId = (c) => {
    if (!c?.id) return c?.id
    // Order matters: `rel-origin-wire-` must be tested before `rel-wire-`.
    if (c.id.startsWith('rel-origin-wire-') && c.relationship_id && c.source_entity_id) {
      return `rel-origin-wire-${c.relationship_id}-${c.source_entity_id}`
    }
    if (c.id.startsWith('rel-wire-') && c.relationship_id && c.source_entity_id) {
      // Skip the `rel-wire-${relId}` (no-suffix) format used for membership
      // relationships with a single wire — those are already collision-free
      // by definition (one wire per rel id).
      const expectedNoSuffix = `rel-wire-${c.relationship_id}`
      if (c.id === expectedNoSuffix) return c.id
      return `rel-wire-${c.relationship_id}-${c.source_entity_id}`
    }
    if (c.id.startsWith('flow-') && c.source_node_id && c.target_node_id && c.source_entity_id) {
      return `flow-${c.source_node_id}-${c.target_node_id}-${c.source_entity_id}`
    }
    return c.id
  }
  const edges = (story.connections || []).map((c) => {
    const canonicalId = _canonicaliseWireId(c)
    // Phase 8.1 , concept wire edges. Restore the exact source/target ports so
    // the wire re-anchors to the same two concept ports (a concept id passes
    // through _canonicaliseWireId unchanged).
    if (c.kind === 'concept') {
      return {
        id: canonicalId,
        source: c.source_node_id,
        target: c.target_node_id,
        sourceHandle: c.source_handle_id,
        targetHandle: c.target_handle_id,
        type: 'conceptEdge',
        data: { ...c },
      }
    }
    // POV wire edges
    if (c.is_pov_path) {
      return {
        id: canonicalId,
        source: c.source_node_id,
        target: c.target_node_id,
        sourceHandle: 'pov-out',
        targetHandle: c.target_handle_id || 'pov-in',
        type: 'povEdge',
        data: { ...c },
      }
    }
    if (c.is_relationship) {
      // Migration: Case 2 edges (entity origin node → plot point chip) saved before v0.1.6.130
      // were missing source_entity_id. Infer it from the source entity node so the orphaned
      // check in SceneNode.jsx correctly recognises these as valid upstream connections.
      const inferredSourceEntityId = c.source_entity_id ||
        (!sceneIds.has(c.source_node_id) ? (entityNodeEntityIdMap.get(c.source_node_id) || null) : null)
      // Derive entity B ID for colour rendering:
      // - Case 1 (origin→origin): target is entity node → look up via entityNodeEntityIdMap
      // - Cases 2/3/4: targetHandle is 'chip-in-{entityId}' → parse entity ID from handle
      const inferredEntityBId = c.entity_b_id ||
        (entityNodeEntityIdMap.has(c.target_node_id)
          ? entityNodeEntityIdMap.get(c.target_node_id)
          : (c.target_handle_id?.startsWith('chip-in-') ? c.target_handle_id.slice(8) : null))
      // Relationship edges: custom RelationshipEdge component, no transition dot
      return {
        id: canonicalId,
        source: c.source_node_id,
        target: c.target_node_id,
        // Restore sourceHandle for SceneNode sources (Case 4: chip output = entity ID)
        ...(inferredSourceEntityId && sceneIds.has(c.source_node_id) ? { sourceHandle: inferredSourceEntityId } : {}),
        // Restore targetHandle (chip-in-{id} for Cases 2/4)
        ...(c.target_handle_id ? { targetHandle: c.target_handle_id } : {}),
        type: 'relationshipEdge',
        data: {
          ...c,
          source_entity_id: inferredSourceEntityId,
          entity_a_id: c.entity_a_id || inferredSourceEntityId,
          entity_b_id: inferredEntityBId,
        },
      }
    }
    // Narrative flow edges
    return {
      id: canonicalId,
      source: c.source_node_id,
      target: c.target_node_id,
      // Only restore sourceHandle for SceneNode sources — they expose named chip handles
      // whose ID equals the entity ID. EntityNode sources (origin + modifier) have unnamed
      // handles; restoring a named sourceHandle on them breaks edge rendering.
      ...(c.source_entity_id && sceneIds.has(c.source_node_id) ? { sourceHandle: c.source_entity_id } : {}),
      // Restore chip-in targetHandle so wires land on the correct entity chip input, not the scene generic input
      ...(c.target_handle_id ? { targetHandle: c.target_handle_id } : {}),
      type: 'transitionEdge',
      data: { ...c },
    }
  })
  // Defensive edge-id dedup: any two edges with the same canonical id are
  // semantically the same wire (same relationship + same source entity
  // for rel-origin-wires; same source/target/source-entity tuple for
  // flow wires; etc.). Older save files have been observed to contain
  // duplicate edge records (data anomaly from earlier code paths that
  // didn't dedup before inserting). Without this filter React's
  // reconciler complains about duplicate keys and the second wire
  // never anchors correctly. Keep the first occurrence; log dropped
  // duplicates so the writer (or a future investigator) can see how
  // many were cleaned and on which ids.
  const seenEdgeIds = new Set()
  const dedupedEdges = []
  const droppedDuplicateIds = []
  // Phase 4.1i — dangling-connection sweep. A wire whose anchor no
  // longer exists (missing endpoint node, or a chip handle whose
  // entity has no EntityRef in the scene) should have been stripped
  // when the anchor was removed; if that failed (observed in saves
  // damaged between 2026-06-06/07, ~143 connections, source under
  // investigation), discovering the dangling state at load is the
  // cleanup point. React Flow cannot anchor these edges anyway: it
  // silently drops them from the canvas and logs an error per edge
  // per validation pass (~205 errors/pass on the damaged reference
  // save). The check runs against the DATA (bucket EntityRefs), not
  // the renderer, so chip mount order cannot false-positive. Checks
  // mirror the handle-restoration rules above exactly: chip handles
  // are only expected on scene endpoints; POV handles and entity-node
  // handles are static and only need the endpoint node to exist.
  const allNodeIds = new Set(nodes.map((n) => n.id))
  const chipIdsBySceneId = new Map()
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    const set = new Set()
    for (const b of ['characters', 'locations', 'items', 'factions', 'customs']) {
      for (const ref of (n.data[b] || [])) {
        if (ref?.entity_id) set.add(ref.entity_id)
      }
    }
    chipIdsBySceneId.set(n.id, set)
  }
  const _isDanglingEdge = (edge) => {
    if (!allNodeIds.has(edge.source) || !allNodeIds.has(edge.target)) return true
    if (edge.type !== 'povEdge') {
      const srcChips = chipIdsBySceneId.get(edge.source)
      if (srcChips && typeof edge.sourceHandle === 'string' && edge.sourceHandle
          && !srcChips.has(edge.sourceHandle)) return true
      const tgtChips = chipIdsBySceneId.get(edge.target)
      if (tgtChips && typeof edge.targetHandle === 'string' && edge.targetHandle.startsWith('chip-in-')
          && !tgtChips.has(edge.targetHandle.slice(8))) return true
    }
    return false
  }
  const droppedDanglingIds = []
  for (const edge of edges) {
    if (edge?.id && seenEdgeIds.has(edge.id)) {
      droppedDuplicateIds.push(edge.id)
      continue
    }
    if (_isDanglingEdge(edge)) {
      droppedDanglingIds.push(edge?.id)
      continue
    }
    if (edge?.id) seenEdgeIds.add(edge.id)
    dedupedEdges.push(edge)
  }
  if (droppedDuplicateIds.length > 0) {
     
    console.warn(`[storyToFlow] Dropped ${droppedDuplicateIds.length} duplicate edge${droppedDuplicateIds.length === 1 ? '' : 's'} from loaded story:`, droppedDuplicateIds)
  }
  if (droppedDanglingIds.length > 0) {
     
    console.warn(`[storyToFlow] Removed ${droppedDanglingIds.length} dangling connection${droppedDanglingIds.length === 1 ? '' : 's'} (no anchor to connect to) from loaded story:`, droppedDanglingIds)
    // Mark the project as having unsaved changes so the healed state
    // persists on the next save. Deferred to a microtask: every load
    // action calls storyToFlow and then synchronously commits its
    // `set({ ... hasUnsavedChanges: false ... })`; queueing puts this
    // write after that reset. One central hook here covers every
    // load path, present and future.
    queueMicrotask(() => {
      try { useProjectStore.setState({ hasUnsavedChanges: true }) } catch { /* store not ready - drop */ }
    })
  }
  // Review flags are persisted in entity refs and restored from saved data as-is.
  // Flags are set/cleared reactively by updateEntityRef — not recomputed on load.

  // Sanitise flashback scenes: clear any dangling parent_scene_id references that point to
  // a node that no longer exists in the loaded story (e.g. the parent was deleted in a
  // previous version before v0.1.9.84 which didn't clean up the reference). Also clear
  // pov_entity_id on the orphaned flashback since the POV attachment is meaningless without
  // a parent scene. Title, description, and main_content are preserved — they belong to the
  // flashback itself.
  const nodeIdSet = new Set(nodes.map((n) => n.id))
  nodes = nodes.map((n) => {
    if (n.type !== 'sceneNode' || !n.data?.is_flashback) return n
    const parentId = n.data?.parent_scene_id
    if (parentId && !nodeIdSet.has(parentId)) {
      return { ...n, data: { ...n.data, parent_scene_id: null, pov_entity_id: null } }
    }
    return n
  })

  // `droppedDanglingCount` lets load actions flag the project as
  // having unsaved changes when the sweep healed anything, so the
  // cleanup persists on the next save.
  return { nodes, edges: dedupedEdges, droppedDanglingCount: droppedDanglingIds.length }
}

/** Given an array of chapter ids (possibly unsorted, possibly containing ids
 *  that are no longer in chapters[]) and the current chapters[] order, return
 *  the longest contiguous run of chapters from the input, in chapters[] order.
 *
 *  Used to maintain the "act.chapter_ids must be a contiguous run in chapters[]
 *  order" invariant after chapter reorder or delete, and to validate input to
 *  `addAct` (e.g. a drag-select that included non-contiguous chapters).
 *
 *  Returns [] if there is no valid chapter to include. On ties (two equally
 *  long runs), picks the leftmost for determinism.
 */
function _pruneActContiguity(chapterIds, chapters) {
  const indexById = new Map(chapters.map((c, i) => [c.id, i]))
  const indices = chapterIds
    .filter((id) => indexById.has(id))
    .map((id) => indexById.get(id))
    .sort((a, b) => a - b)
  if (indices.length === 0) return []
  let bestStart = 0, bestLen = 1
  let curStart = 0, curLen = 1
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) {
      curLen++
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart }
    } else {
      curStart = i
      curLen = 1
    }
  }
  return indices.slice(bestStart, bestStart + bestLen).map((idx) => chapters[idx].id)
}

/** Merge current React Flow nodes + edges back into a story payload for the API. */
// NB: the backend Story model still accepts a `viewport` field for
// forward/backward compat with older project files, but we no longer
// emit it here. The Canvas always runs `fitView` on load (see
// `_pendingFitView` below), so persisting the user's last pan/zoom is
// pointless — and one less thing to keep in sync.
function buildStoryPayload(story, nodes, edges, relationships, knowledges) {
  if (!story) return null
  // Pull latest entity data from entitiesStore so CRUD changes are included in saves
  const es = useEntitiesStore.getState()

  // Walk the POV chain so we can persist each chain-resident scene's
  // current Time Since Last Scene gap into `last_known_gap` (planning
  // §5.1 — the only computed-derived field saved to disk). Off-chain
  // scenes and the first scene get no walker entry, so their existing
  // `last_known_gap` value passes through untouched. This v1 always
  // overwrites at save time; the threshold-aware version (§3.4.1) lands
  // with the loose-mode notification alerts work.
  const sceneNodes = nodes.filter((n) => n.type === 'sceneNode')
  const sceneDataById = new Map(sceneNodes.map((n) => [n.id, n.data || {}]))
  const povChain = computePovChain(nodes, edges)
  const orderedSceneIds = povChain.sequence.map((s) => s.nodeId)
  const allowNegative = story.allow_negative_time === true
  const walker = walkPovChainTime({
    orderedSceneIds,
    scenesById: sceneDataById,
    allowNegative,
  })

  // Loose-mode notification alerts (planning §10.1.1 + §10.1.2 +
  // §3.4.2). Detect the earliest-affected scene per the sequential
  // cascade rule; record the alert on its `review_fields` and
  // suppress the `last_known_gap` overwrite so the comparison
  // baseline survives until the writer resolves. All other
  // chain-resident scenes overwrite as usual; any stale
  // `time_since_last_scene` review entries from a prior pass are
  // dropped from those scenes.
  const thresholdMinutes = timeDeltaToMinutes(story?.gap_shift_threshold) || 0
  const firstAlert = detectFirstScenetimeAlert({
    orderedSceneIds,
    scenesById: sceneDataById,
    walkResult: walker,
    thresholdMinutes,
  })

  return {
    ...story,
    relationships: relationships ?? [],
    // Phase 1.21c — Knowledge is now a first-class top-level list,
    // sourced from projectStore.knowledges (not the stale
    // entitiesStore.knowledges bucket, which stays empty post-refactor
    // and is scheduled for removal in Step 4).
    knowledges: knowledges ?? [],
    // Save-shape assembly: pull entities FROM the live entitiesStore
    // (the source of truth) into the nested-object shape the backend
    // `Story` model expects. This is the ONLY place that should write
    // to `story.entities` outside of full-load / full-save replacements.
    // Reads of `story.entities` for live data are bugs — see header
    // comment of `entitiesStore.js`.
    entities: {
      characters: es.characters,
      locations: es.locations,
      items: es.items,
      factions: es.factions,
      customs: es.customs,
    },
    custom_categories: es.customCategories,
    preset_lists: es.presetLists,
    project_tags: es.projectTags,
    library_layout: es.libraryLayout,
    entity_nodes: nodes
      .filter((n) => n.type === 'entityNode')
      .map((n) => ({
        ...n.data,
        // Always use the React Flow node ID — data.id may be absent for modifier nodes created
        // before v0.1.6.103, causing Pydantic to generate a new UUID and breaking connections.
        id: n.id,
        position: { x: n.position.x, y: n.position.y },
        // width/height come from n.data (set by updateNodeData during resize).
        // Do NOT read from n.style — React Flow's style can become stale after resize.
      })),
    scenes: nodes
      .filter((n) => n.type === 'sceneNode')
      .map((n) => {
        // Persist the walker's current Time Since Last Scene gap into
        // `last_known_gap` for chain-resident, non-first scenes (planning
        // §5.1). Off-chain scenes and the first scene have no walker
        // entry — keep whatever value is already on the node so the
        // joining-rejoining cycle stays stable across topology edits.
        const w = walker.get(n.id)
        const isFirstAlertScene = !!(firstAlert && firstAlert.sceneId === n.id)

        // When an alert is pending on this scene, freeze
        // `last_known_gap` at the prior baseline so the comparison
        // survives until the writer resolves. Otherwise overwrite
        // with the walker's current gap.
        const computedGap = (w && !w.isFirstScene && Number.isFinite(w.gapMinutes))
          ? minutesToTimeDelta(w.gapMinutes)
          : null
        const existingGap = n.data?.last_known_gap ?? null
        const lastKnownGap = isFirstAlertScene
          ? existingGap
          : (computedGap ?? existingGap)

        // Strip any prior `time_since_last_scene` review entries; the
        // detection pass above is the single source of truth each
        // save. Other field-keyed entries (entity-change review
        // flags, etc.) pass through untouched.
        const priorReview = Array.isArray(n.data?.review_fields) ? n.data.review_fields : []
        const otherReview = priorReview.filter((f) => {
          const field = typeof f === 'string' ? f : f?.field
          return field !== 'time_since_last_scene'
        })
        const reviewFields = isFirstAlertScene
          ? [
              ...otherReview,
              {
                field: 'time_since_last_scene',
                fieldLabel: 'Time Since Last Scene',
                kind: firstAlert.alert.kind,
                previousGap: firstAlert.alert.previousGap,
                newGap: firstAlert.alert.newGap,
              },
            ]
          : otherReview

        return {
          ...n.data,
          last_known_gap: lastKnownGap,
          review_fields: reviewFields,
          id: n.id,  // explicit: matches entity_nodes pattern; n.data.id is already correct here
          position: { x: n.position.x, y: n.position.y },
          // width/height come from n.data (set by updateNodeData during resize).
          // Do NOT read from n.style — React Flow's style can become stale after resize.
        }
      }),
    reference_nodes: nodes
      .filter((n) => n.type === 'referenceNode')
      .map((n) => ({
        ...n.data,
        id: n.id,
        position: { x: n.position.x, y: n.position.y },
      })),
    // POV Origin Node (at most one)
    pov_origin_node: (() => {
      const pov = nodes.find((n) => n.type === 'povOriginNode')
      if (!pov) return null
      return { ...pov.data, id: pov.id, position: { x: pov.position.x, y: pov.position.y } }
    })(),
    // Phase 1.18: relationship origin nodes.
    relationship_origin_nodes: nodes
      .filter((n) => n.type === 'relationshipOriginNode')
      .map((n) => ({
        ...n.data,
        id: n.id,
        node_type: 'relationship_origin',
        relationship_id: n.data?.relationship_id,
        position: { x: n.position.x, y: n.position.y },
      })),
    // Phase 1.21c Step 14: knowledge origin nodes.
    knowledge_origin_nodes: nodes
      .filter((n) => n.type === 'knowledgeOriginNode')
      .map((n) => ({
        ...n.data,
        id: n.id,
        node_type: 'knowledge_origin',
        knowledge_id: n.data?.knowledge_id,
        position: { x: n.position.x, y: n.position.y },
      })),
    // Phase 1.11 Track I — generic group containers. Read dimensions in
    // MEASURED → data → style priority order (same as `_readGroupSize` in
    // groupMembership.js). Measured reflects the real DOM after any live
    // resize; data is what `onResize` writes via `updateNodeData`; style
    // is the initial size set at creation and goes stale immediately
    // after any resize. Using `style` first (the old order) caused
    // resizes to silently fail to persist through save/load.
    groups: nodes
      .filter((n) => n.type === 'genericGroupNode')
      .map((n) => ({
        ...n.data,
        id: n.id,
        position: { x: n.position.x, y: n.position.y },
        width: n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.style?.width ?? 400,
        height: n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.style?.height ?? 300,
      })),
    connections: edges.map((e) => ({
      ...(e.data || {}),
      id: e.id,
      source_node_id: e.source,
      target_node_id: e.target,
    })),
  }
}

/** Ensure the nodes array contains a POV Origin Node. If absent, inject one.
 *  Default spawn sits below the canvas top-left toolbar (+ button, tidy wires
 *  dot, undo, redo). The toolbar's bottom edge sits around screen-y ≈ 72 px on
 *  a brand-new project (see CanvasToolbar.jsx for the offset math), so flow-y
 *  = 120 gives a comfortable gap below it at default viewport zoom/position.
 *  The toolbar still renders OVER the POV origin via its higher Panel z-order
 *  if the user later drags it under — this default just avoids the overlap on
 *  initial load. */
function ensurePovOriginNode(nodes) {
  if (nodes.some((n) => n.type === 'povOriginNode')) return nodes
  const id = crypto.randomUUID()
  const pos = { x: 50, y: 120 }
  return [
    ...nodes,
    { id, type: 'povOriginNode', position: pos, data: { id, node_type: 'pov_origin', position: pos } },
  ]
}

export const useProjectStore = create(detectMutationMiddleware((set, get) => ({
  // `story` — the canonical Story shape as it last came from / was
  // sent to the backend. Replaced WHOLESALE on full project load
  // (server returns a new Story) and on full project save (server
  // returns the just-saved Story). It is NOT updated incrementally
  // on individual entity mutations.
  //
  // ⚠️ `story.entities` is a STALE SNAPSHOT between load/save events.
  // The LIVE source of truth for entities is `entitiesStore` (which
  // is updated synchronously on every entity mutation AND fires the
  // backend `axios.X` call so the server stays current). Code that
  // wants the current entity list must read from `entitiesStore`, not
  // from `story.entities`. The save-shape builder below (search for
  // `entities: {`) populates `story.entities` FROM `entitiesStore` at
  // save-time so the on-the-wire shape stays correct. See the header
  // comment of `entitiesStore.js` for the full lifecycle. Same rule
  // applies in spirit to `story.relationships` and `story.knowledges`
  // — the live versions are `projectStore.relationships` /
  // `projectStore.knowledges` (top-level on this store), not the
  // nested copies under `story`.
  story: null,
  nodes: [],
  edges: [],
  relationships: [],
  relationshipsByEntity: {},
  relationshipsByScene: {},
  // Phase 1.21c — first-class Knowledge objects. Seeded from
  // `Story.knowledges` on project load; mutated via `createKnowledge` /
  // `updateKnowledge` / `deleteObject('knowledge', id)` /
  // `setKnowledgeAwareness` / `setKnowledgeAwarenessAtNode` /
  // `setKnowledgeContentChange`.
  knowledges: [],
  // ── Backend auto-sync state (see top-of-file BACKEND_SYNC_DELAY_MS
  // helpers + `detectMutationMiddleware`). `lastMutationAt` is stamped
  // by the middleware on every mutation that sets `hasUnsavedChanges:
  // true`. `lastSyncedAt` is updated by `_doBackendSync` (and by
  // `saveProject`) when a successful PUT /api/story completes — set to
  // the value of `lastMutationAt` AT THE START of that PUT so mutations
  // arriving during the in-flight request stay correctly marked as
  // "still ahead of backend." Both initialise to 0, which compares
  // equal at startup → no spurious initial sync.
  lastMutationAt: 0,
  lastSyncedAt: 0,
  showMinimap: true,
  // Phase 1.12c v0.1.12.63 — snap-to-grid toggle. When true, node
  // drag + resize positions snap to the 20-flow-px dot grid that the
  // <Background> component draws. Session-level UI preference — not
  // persisted to the .nnz file, matches `showMinimap`'s pattern.
  snapToGrid: false,
  recentProjects: readRecent(),
  activePath: null,
  error: null,
  hasUnsavedChanges: false,
  // Incremented on every successful project load (loadProject /
  // loadFromRecent / newProject / etc.). Components that hold local
  // measurement state (SceneNode's sectionMetrics, etc.) subscribe to
  // this and reset their state when it changes, so a stale value from
  // a previous project's incarnation of the same component instance
  // (React Flow reuses components when node ids match across loads)
  // can't leak into the new project's first render and trigger spurious
  // auto-grow / auto-shrink updates that mark the project dirty.
  loadGeneration: 0,
  // Canvas viewport handling: we deliberately do NOT persist the user's
  // last pan/zoom. Every project load triggers a `fitView` so all nodes
  // are visible regardless of where the last file's camera was sitting,
  // and the user can pan/zoom after. `_pendingFitView` is the signal
  // load actions set; Canvas.jsx reads it, runs fitView, then clears.
  _pendingFitView: false,
  // Extends the load-storm story-order short-circuit (see useStoryOrder)
  // across the FULL post-load settle. `_pendingFitView` only covers the
  // initial fitView; node measurement + the grow-refit it triggers keep
  // changing sizes / positions for a while after, each a legitimate order
  // input. This stays true until those stop (cleared on a debounce in
  // `onNodesChange`), so the dozens of measured-size writes collapse into
  // ONE recompute once the layout has settled.
  _loadSettling: false,
  // Full-screen "Opening…" overlay state — true for the duration of ANY
  // project load (every load action sets it on entry, clears it in a
  // `finally`); App.jsx renders the spinner. `_loadingProjectTitle` is the
  // name shown when known (recents / library card / dropped file), null for
  // the native picker and startup, where the overlay uses a generic message.
  _loadingProject: false,
  _loadingProjectTitle: null,
  consumePendingFitView: () => {
    if (get()._pendingFitView) set({ _pendingFitView: false })
  },

  // Recenter-on-POV-origin signal. Bumped (monotonic counter) when the canvas
  // should recenter on the single POV origin node at a medium zoom: a
  // user-initiated layout-mode switch and after a reorganize. Canvas.jsx
  // watches the counter and, IF a POV origin node exists, centers on it;
  // when absent it leaves the viewport alone (no refocus). Project LOAD does
  // NOT use this — it rides `_pendingFitView`, which prefers the POV origin
  // but falls back to fit-all when there's no POV node.
  _pendingPovFocus: 0,
  requestPovFocus: () => set((s) => ({ _pendingPovFocus: (s._pendingPovFocus || 0) + 1 })),

  // Undo/redo history — session-only, not persisted in .nnz
  history: [],  // [{nodes, edges}, ...], most recent last
  future: [],   // [{nodes, edges}, ...], next-to-redo first

  /** Fetch current story and active save path from backend (called on app mount). */
  initStory: async () => {
    try {
      set({ _loadingProject: true, _loadingProjectTitle: null })
      const [storyRes, pathRes] = await Promise.all([
        axios.get('/api/story/'),
        axios.get('/api/project/active-path'),
      ])
      const { nodes, edges } = storyToFlow(storyRes.data)
      const ensured = ensurePovOriginNode(nodes)
      const relationships = storyRes.data.relationships || []
      const knowledges = storyRes.data.knowledges || []
      const { byEntity, byScene } = _buildRelIndexes(relationships)
      set({ story: storyRes.data, nodes: ensured, edges, relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, knowledges, activePath: pathRes.data.active_path, error: null, history: [], future: [], hasUnsavedChanges: false, _pendingFitView: true, _loadSettling: true, loadGeneration: get().loadGeneration + 1 })
      usePreviewStore.getState().resetForProjectLoad()
      useEntitiesStore.getState().syncFromStory(storyRes.data)
    } catch {
      set({ error: 'Failed to connect to backend.' })
    } finally {
      set({ _loadingProject: false, _loadingProjectTitle: null })
    }
  },

  /**
   * Phase 1.23 — commit walker-derived `last_known_gap` and loose-mode
   * notification alert `review_fields` writes back into the in-memory
   * store BEFORE save. Without this step, the writes only land on the
   * saved payload, so a second save after an upstream edit can't
   * detect the shift (no baseline in memory to compare against).
   * Idempotent: safe to call multiple times in a row.
   */
  _commitScenetimeWrites: (trigger = null) => {
    const { nodes, edges, story } = get()
    const sceneNodes = nodes.filter((n) => n.type === 'sceneNode')
    if (sceneNodes.length === 0) return
    const sceneDataById = new Map(sceneNodes.map((n) => [n.id, n.data || {}]))
    const povChain = computePovChain(nodes, edges)
    const orderedSceneIds = povChain.sequence.map((s) => s.nodeId)
    const allowNegative = story?.allow_negative_time === true
    const walker = walkPovChainTime({
      orderedSceneIds,
      scenesById: sceneDataById,
      allowNegative,
    })
    const thresholdMinutes = timeDeltaToMinutes(story?.gap_shift_threshold) || 0

    // Classify each chain-resident scene before composing the output:
    //   carryover  — current detection produces the SAME alert that's
    //                already in the scene's review_fields. Pending
    //                alert from a previous pass; keep visible without
    //                blocking new alerts on other scenes.
    //   newAlert   — current detection produces an alert different
    //                from (or in addition to) the existing entry.
    //                Caused by THIS pass's change.
    //   resolved   — no current detection but an existing entry was
    //                there. Floor returned to baseline / scene left
    //                the chain. Strip the entry.
    //   none       — no current detection, no existing entry.
    //
    // Sequential cascade rule (planning §3.4.2) is scoped to "ONE
    // change triggering multiple alerts" — only the earliest scene
    // with a NEW alert in this pass writes its entry; later new
    // alerts in the same pass are suppressed. Carryovers don't
    // count for cascade purposes (they're from previous passes).
    const classify = new Map()
    let firstNewAlertId = null
    for (const sid of orderedSceneIds) {
      const scene = sceneDataById.get(sid)
      if (!scene) continue
      const w = walker.get(sid)
      const currentAlert = detectScenetimeAlert({ scene, walkEntry: w, thresholdMinutes })
      const node = nodes.find((nn) => nn.id === sid)
      const existingEntry = (node?.data?.review_fields || []).find((f) =>
        typeof f === 'object' && f && f.field === 'time_since_last_scene'
      ) || null
      let cls = 'none'
      if (currentAlert) {
        if (existingEntry
            && existingEntry.kind === currentAlert.kind
            && existingEntry.newFloorMinutes === currentAlert.newFloorMinutes
            && (existingEntry.newEffectiveMinutes ?? null) === (currentAlert.newEffectiveMinutes ?? null)) {
          cls = 'carryover'
        } else {
          cls = 'newAlert'
          if (!firstNewAlertId) firstNewAlertId = sid
        }
      } else if (existingEntry) {
        cls = 'resolved'
      }
      classify.set(sid, { cls, currentAlert, existingEntry })
    }

    set({
      nodes: nodes.map((n) => {
        if (n.type !== 'sceneNode') return n
        const w = walker.get(n.id)
        const cinfo = classify.get(n.id) || { cls: 'none', currentAlert: null, existingEntry: null }
        const isFirstNewAlertScene = !!(firstNewAlertId && firstNewAlertId === n.id)
        // Any scene with a current or pending alert keeps its baseline
        // frozen so the comparison survives until resolution.
        // Cascade-suppressed scenes (newAlert but not first) also
        // freeze so their alert can re-surface after the upstream
        // resolves.
        const isPending = cinfo.cls === 'carryover' || cinfo.cls === 'newAlert'
        const computedGap = (w && !w.isFirstScene && Number.isFinite(w.gapMinutes))
          ? minutesToTimeDelta(w.gapMinutes)
          : null
        const computedFloor = (w && !w.isFirstScene && Number.isFinite(w.floorMinutes))
          ? w.floorMinutes
          : null
        const computedEffective = (w && !w.isFirstScene && Number.isFinite(w.effectiveStartMinutes))
          ? w.effectiveStartMinutes
          : null
        const existingGap = n.data?.last_known_gap ?? null
        const existingFloor = Number.isFinite(n.data?.last_known_floor_minutes)
          ? n.data.last_known_floor_minutes
          : null
        const existingEffective = Number.isFinite(n.data?.last_known_effective_minutes)
          ? n.data.last_known_effective_minutes
          : null
        // Freeze baselines for any scene with a pending alert
        // (carryover OR new — the cascade-suppressed new alerts also
        // need their baseline preserved so they re-surface once the
        // upstream resolves). Otherwise overwrite with the walker's
        // current values (silent absorption / first-time seeding).
        const lastKnownGap = isPending
          ? existingGap
          : (computedGap ?? existingGap)
        const lastKnownFloorMinutes = isPending
          ? existingFloor
          : (computedFloor ?? existingFloor)
        const lastKnownEffectiveMinutes = isPending
          ? existingEffective
          : (computedEffective ?? existingEffective)
        const priorReview = Array.isArray(n.data?.review_fields) ? n.data.review_fields : []
        const otherReview = priorReview.filter((f) => {
          const field = typeof f === 'string' ? f : f?.field
          return field !== 'time_since_last_scene'
        })
        // Build the time_since entry for this scene per its
        // classification.
        let timeSinceEntry = null
        if (cinfo.cls === 'carryover') {
          // Pending alert from a previous pass — keep the existing
          // entry as-is so the writer's resolution UI doesn't lose
          // its context.
          timeSinceEntry = cinfo.existingEntry
        } else if (cinfo.cls === 'newAlert' && isFirstNewAlertScene) {
          // Earliest new alert in this pass — write a fresh entry
          // with current trigger metadata. Identify the prior scene
          // on the POV chain so the alert display can pick the
          // granularity matching what the writer actually pinned.
          let priorTodTier = null
          let priorDateTier = null
          const idx = orderedSceneIds.indexOf(n.id)
          if (idx > 0) {
            const priorId = orderedSceneIds[idx - 1]
            const priorScene = sceneDataById.get(priorId)
            priorTodTier = priorScene?.time_of_day_tier || null
            priorDateTier = priorScene?.date_tier || null
          }
          timeSinceEntry = {
            field: 'time_since_last_scene',
            fieldLabel: 'Time Since Last Scene',
            kind: cinfo.currentAlert.kind,
            previousFloorMinutes: cinfo.currentAlert.previousFloorMinutes,
            newFloorMinutes: cinfo.currentAlert.newFloorMinutes,
            previousEffectiveMinutes: cinfo.currentAlert.previousEffectiveMinutes,
            newEffectiveMinutes: cinfo.currentAlert.newEffectiveMinutes,
            deltaMinutes: cinfo.currentAlert.deltaMinutes,
            floorDeltaMinutes: cinfo.currentAlert.floorDeltaMinutes,
            effectiveDeltaMinutes: cinfo.currentAlert.effectiveDeltaMinutes,
            previousGap: cinfo.currentAlert.previousGap,
            newGap: cinfo.currentAlert.newGap,
            priorTodTier,
            priorDateTier,
            thisTodTier: n.data?.time_of_day_tier || null,
            thisDateTier: n.data?.date_tier || null,
            triggerNodeId: trigger?.triggerNodeId ?? null,
            fieldChanges: Array.isArray(trigger?.fieldChanges) ? trigger.fieldChanges : [],
          }
        }
        // For cls === 'newAlert' AND !isFirstNewAlertScene → cascade-
        // suppressed; no entry written this pass. Baseline freeze
        // (above) keeps re-detection live for the next pass.
        // For cls === 'resolved' → no entry (existing was filtered).
        // For cls === 'none' → no entry.
        const reviewFields = timeSinceEntry
          ? [...otherReview, timeSinceEntry]
          : otherReview
        if (
          (lastKnownGap === existingGap || JSON.stringify(lastKnownGap) === JSON.stringify(existingGap))
          && lastKnownFloorMinutes === existingFloor
          && lastKnownEffectiveMinutes === existingEffective
          && reviewFields.length === priorReview.length
          && reviewFields.every((f, i) => f === priorReview[i])
        ) {
          return n
        }
        return {
          ...n,
          data: {
            ...n.data,
            last_known_gap: lastKnownGap,
            last_known_floor_minutes: lastKnownFloorMinutes,
            last_known_effective_minutes: lastKnownEffectiveMinutes,
            review_fields: reviewFields,
          },
        }
      }),
    })
  },

  /** Backend in-memory sync — called by the trailing-edge throttle
   *  scheduled in `detectMutationMiddleware`. PUTs the current story
   *  to the FastAPI backend so a browser refresh during an editing
   *  session restores work-in-progress. Does NOT write to disk — disk
   *  writes are still gated behind explicit `saveProject` /
   *  `autosaveProject`. No-op when nothing has mutated since the last
   *  successful sync. On failure, leaves `lastSyncedAt` untouched so
   *  the next mutation reschedules a retry. */
  _doBackendSync: async () => {
    const state = get()
    if (state.lastMutationAt <= state.lastSyncedAt) return
    // Snapshot the mutation timestamp BEFORE the PUT. Any mutation
    // landing during the PUT updates `lastMutationAt` past this value,
    // which leaves the post-PUT check (`lastMutationAt > lastSyncedAt`)
    // correctly true and reschedules another sync.
    const syncStartedAt = state.lastMutationAt
    try {
      const payload = buildStoryPayload(
        state.story, state.nodes, state.edges,
        state.relationships, state.knowledges,
      )
      await axios.put('/api/story/', payload)
      // CRITICAL: don't include `hasUnsavedChanges` in this set. If
      // it were `true`, the middleware would re-stamp `lastMutationAt`
      // and reschedule a sync (infinite loop). If `false`, we'd be
      // lying about disk-vs-frontend state. Update ONLY lastSyncedAt.
      set({ lastSyncedAt: syncStartedAt })
    } catch (e) {
      // Leave `lastSyncedAt` as-is so the next mutation re-schedules.
      console.warn('[backend-sync] PUT /api/story failed; will retry on next mutation:', e)
    }
  },

  /** Write project in-place to the given path (or the stored active path).
   *  Returns true on success, false if no path is available (caller should prompt). */
  saveProject: async (filePath) => {
    get()._commitScenetimeWrites()
    const { story, nodes, edges, activePath, relationships, knowledges, lastMutationAt } = get()
    const pathToUse = filePath || activePath
    if (!pathToUse) return false   // signal: need a path
    // Snapshot the mutation timestamp at the start of the PUT (same
    // race-safety reasoning as `_doBackendSync`). Any mutation arriving
    // during the in-flight save leaves `lastMutationAt > syncStartedAt`,
    // and the next mutation will reschedule a backend-sync as expected.
    const syncStartedAt = lastMutationAt
    try {
      const payload = buildStoryPayload(story, nodes, edges, relationships, knowledges)
      const { data: savedStory } = await axios.put('/api/story/', payload)
      const { data } = await axios.post('/api/project/save', { file_path: pathToUse })
      const savedRelationships = savedStory.relationships || []
      const savedKnowledges = savedStory.knowledges || []
      const { byEntity: saveByEnt, byScene: saveBySc } = _buildRelIndexes(savedRelationships)
      // Cancel any pending throttled backend-sync — we just synced the
      // backend ourselves (the PUT above is the same call the throttle
      // would have made). Avoids a redundant PUT firing 5 seconds later.
      if (_backendSyncTimer) { clearTimeout(_backendSyncTimer); _backendSyncTimer = null }
      set({ story: savedStory, relationships: savedRelationships, relationshipsByEntity: saveByEnt, relationshipsByScene: saveBySc, knowledges: savedKnowledges, activePath: data.saved_to, error: null, hasUnsavedChanges: false, lastSyncedAt: syncStartedAt })
      const savedName = data.saved_to.split(/[\\/]/).pop()
      // Recents are POINTERS only: name + disk path + when last opened.
      // No story copy is ever cached (caching it bloated localStorage
      // until saves failed with a quota error). Save always has a path.
      const prev = readRecent().filter((r) => r.name !== savedName)
      const updated = [{ name: savedName, path: data.saved_to, openedAt: new Date().toISOString() }, ...prev].slice(0, MAX_RECENT)
      writeRecent(updated)
      set({ recentProjects: updated })
      return true
    } catch (err) {
      // Surface the backend's exception detail in the user-facing
      // banner so "Save failed" stops being a black box. The backend
      // wraps the original exception as
      // `Save failed (<ExceptionType>): <message>` for the generic
      // catch-all path, or the structured MissingAssetsError detail
      // (a string listing the missing asset filenames) for that
      // specific failure mode. Falls back to a network/axios message
      // when there's no backend response (e.g. uvicorn crashed).
      const detail = _extractErrorDetail(err, 'Save failed.')
      set({ error: detail })
      return false
    }
  },

  /** Write the current story to a sibling `<stem>_autosave.nnz` file without
   *  touching the active file path, recents, or the unsaved-changes flag. Skips
   *  silently when there is no active path or nothing has changed. Strips
   *  either `.nnz` or the legacy `.nnplot` extension from the stem so an
   *  autosave that runs before the user has re-saved a freshly-loaded legacy
   *  file still produces a sensible sibling filename. */
  autosaveProject: async () => {
    if (!get().activePath || !get().hasUnsavedChanges) return false
    get()._commitScenetimeWrites()
    const { story, nodes, edges, activePath, hasUnsavedChanges, relationships, knowledges } = get()
    if (!activePath || !hasUnsavedChanges) return false
    const sep = activePath.includes('\\') ? '\\' : '/'
    const lastSep = activePath.lastIndexOf(sep)
    const dir = lastSep >= 0 ? activePath.slice(0, lastSep) : ''
    const filename = lastSep >= 0 ? activePath.slice(lastSep + 1) : activePath
    const lower = filename.toLowerCase()
    const stem = lower.endsWith('.nnz')
      ? filename.slice(0, -4)
      : lower.endsWith('.nnplot')
        ? filename.slice(0, -7)
        : filename
    const autosavePath = (dir ? dir + sep : '') + stem + '_autosave.nnz'
    try {
      const payload = buildStoryPayload(story, nodes, edges, relationships, knowledges)
      await axios.put('/api/story/', payload)
      // Pass `recovery_source_path: activePath` so the backend can
      // pull missing assets from the main .nnz when its in-memory
      // `_assets_dir` is stale (most commonly after a uvicorn --reload
      // wiped module globals mid-session — backend state forgets the
      // active file path so autosave's own fallbacks couldn't reach
      // the source). The frontend has the path the whole time;
      // threading it through closes the loop.
      await axios.post('/api/project/save', {
        file_path: autosavePath,
        is_autosave: true,
        recovery_source_path: activePath,
      })
      return true
    } catch (err) {
      // Surface autosave failures in the banner too. Previously autosave
      // failed silently — the writer's session reported in the Discord
      // chat had autosave failing every 5 minutes for 20 minutes without
      // anybody noticing until the explicit Save also broke. Showing the
      // error here makes the next silent-failure session visible
      // immediately. Prefix with "Autosave" so the writer can tell which
      // path failed.
      const detail = _extractErrorDetail(err, 'Autosave failed.')
      set({ error: `Autosave: ${detail}` })
      return false
    }
  },

  /** Download a copy of the project as .nnz without changing the active path. */
  exportAsNnz: async () => {
    get()._commitScenetimeWrites()
    const { story, nodes, edges, relationships, knowledges } = get()
    try {
      const payload = buildStoryPayload(story, nodes, edges, relationships, knowledges)
      const { data: savedStory } = await axios.put('/api/story/', payload)
      set({ story: savedStory })
      const response = await axios.get('/api/project/export/nnz', { responseType: 'blob' })
      const filename = `${story?.title || 'narrative'}.nnz`
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      set({ error: null })
    } catch (err) {
      const detail = _extractErrorDetail(err, 'Export failed.')
      set({ error: detail })
    }
  },

  /** Upload a file to the seeds import endpoint with `preview=true`
   *  and return the server's preview structure. Used by the
   *  SeedsImportDialog to render its checkbox list. `scope` is
   *  'story' or 'default' and picks the endpoint. Throws on HTTP
   *  error so the UI can surface a toast. */
  previewSeedsImport: async (file, scope) => {
    const endpoint = scope === 'default'
      ? '/api/settings/default-seeds/import'
      : '/api/project/seeds/import'
    const form = new FormData()
    form.append('file', file)
    form.append('preview', 'true')
    const { data } = await axios.post(endpoint, form)
    return data
  },

  /** Apply a previously-previewed seeds import. `mode` is
   *  'replace' or 'append'. `selection` is the shape produced by
   *  SeedsImportDialog.buildSelection(). On success refetches the
   *  seeds from the corresponding endpoint so the tab editor shows
   *  the new state. */
  applySeedsImport: async (file, scope, mode, selection) => {
    const endpoint = scope === 'default'
      ? '/api/settings/default-seeds/import'
      : '/api/project/seeds/import'
    const form = new FormData()
    form.append('file', file)
    form.append('preview', 'false')
    form.append('mode', mode)
    if (selection) form.append('selection', JSON.stringify(selection))
    const { data } = await axios.post(endpoint, form)
    // Project-scope imports flip the dirty flag so the header Save
    // button reflects that the project has diverged from its saved
    // `.nnz`. Default-scope imports write to the user-level file
    // directly in the backend, so no project-dirty signal needed.
    if (scope !== 'default') {
      set({ hasUnsavedChanges: true })
    }
    return data
  },

  /** Export the current project's seeds (attribute stubs + bundled
   *  preset lists) as a standalone `.json` file. Triggers the
   *  browser's download flow via a blob URL + synthetic anchor
   *  click, exactly like `exportAsNnz`. The backend at
   *  `GET /project/seeds/export` already handles self-contained
   *  bundling: every preset list referenced by a preset-type stub
   *  travels with the file so the export round-trips cleanly into
   *  a different project's `POST /project/seeds/import`. */
  exportStorySeeds: async () => {
    const { story } = get()
    try {
      const response = await axios.get('/api/project/seeds/export', { responseType: 'blob' })
      const title = (story?.title || 'narrative').trim() || 'narrative'
      const filename = `${title}_seeds.json`
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      set({ error: null })
    } catch {
      set({ error: 'Seeds export failed.' })
    }
  },

  /** Download the current user-level default seeds as a standalone
   *  `.json`. Mirrors `exportStorySeeds` but points at the
   *  default-seeds endpoint and uses a fixed filename since there
   *  is no project title at this scope. */
  exportDefaultSeeds: async () => {
    try {
      const response = await axios.get('/api/settings/default-seeds/export', { responseType: 'blob' })
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url
      a.download = 'default_seeds.json'
      a.click()
      URL.revokeObjectURL(url)
      set({ error: null })
    } catch {
      set({ error: 'Default seeds export failed.' })
    }
  },

  /** Load a .nnz File object (or legacy .nnplot) from a browser file picker.
   *  Browser security means we can't recover the file's original path, so
   *  activePath is cleared — the user will be prompted on next Save. A
   *  legacy .nnplot upload is accepted as-is on the server; the subsequent
   *  save writes the .nnz extension. No in-place filesystem rename is
   *  possible on this path because browsers never expose the source
   *  file's absolute path. */
  loadProject: async (file) => {
    // Caller is responsible for showing an unsaved-changes confirm
    // if needed (Phase 1.13 v0.1.13.1 — guard moved to App.jsx so the
    // 3-button Save / Continue without saving / Cancel dialog can
    // orchestrate the Save fallback path).
    const form = new FormData()
    form.append('file', file)
    try {
      set({ _loadingProject: true, _loadingProjectTitle: file?.name ? file.name.replace(/\.(nnz|nnplot)$/i, '') : null })
      const { data } = await axios.post('/api/project/load', form)
      const { nodes, edges } = storyToFlow(data)
      const relationships = data.relationships || []
      const knowledges = data.knowledges || []
      const { byEntity, byScene } = _buildRelIndexes(relationships)
      set({ story: data, nodes, edges, relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, knowledges, activePath: null, error: null, history: [], future: [], hasUnsavedChanges: false, _pendingFitView: true, _loadSettling: true, loadGeneration: get().loadGeneration + 1 })
      usePreviewStore.getState().resetForProjectLoad()
      useEntitiesStore.getState().syncFromStory(data)
      // Phase 1.24b — project switch closes the TOC panel (regardless
      // of pin) and clears the entity-filter as part of the close.
      useUiStore.getState().closeTocPanel()
      // Phase 2.5h — wipe per-thread Story Scope context state. Scene /
      // chapter / act ids belong to one project; carrying them across a
      // project switch would have the chat panel referencing now-stale ids.
      useUiStore.getState().clearAllStoryScopeState()
      try { resetOvumBlack() } catch { /* effects must never break a load */ }
      // A browser-dropped / uploaded file has no recoverable disk path
      // (the browser hands over bytes only), so it cannot become a
      // reopenable Recents pointer. Recents holds pointers, never story
      // copies, so a path-less open simply is not added to the list. It
      // earns an entry once the user Saves it (which yields a real path).
    } catch (err) {
      const structured = await handleSaveFormatLoadError(err)
      set({ error: structured || 'Load failed — invalid project file.' })
    } finally {
      set({ _loadingProject: false, _loadingProjectTitle: null })
    }
  },

  /** Load a project file via the native OS file-open dialog (backend opens
   *  the dialog). Unlike the browser file-picker approach this preserves the
   *  full file path so in-place Save works correctly immediately after
   *  loading.
   *
   *  Two steps so the "Opening…" overlay never covers the OS file picker:
   *  the dialog runs in `pick_only` mode (returns the chosen path WITHOUT
   *  loading, so no overlay while the user is still choosing), then the
   *  chosen path is handed to `loadFromRecent`, which shows the overlay and
   *  performs the actual load + recents update through the shared load-path
   *  flow (the backend renames a legacy `.nnplot` to `.nnz` in place during
   *  that load). */
  loadProjectNative: async () => {
    // Caller is responsible for showing an unsaved-changes confirm
    // if needed — see `loadProject` comment above.
    let chosen
    try {
      const { data } = await axios.get('/api/project/native-open', { params: { pick_only: true } })
      chosen = data.path
    } catch (err) {
      const structured = await handleSaveFormatLoadError(err)
      set({ error: structured || 'Load failed — could not open file.' })
      return
    }
    if (!chosen) return  // user cancelled the dialog
    const fileName = chosen.split(/[\\/]/).pop()
    await get().loadFromRecent({ name: fileName, path: chosen })
  },

  /** Restore a recent project — prefer loading the file from disk (restores
   *  binary assets like profile images) and fall back to JSON-only if the file
   *  is not accessible. Recent entries created by legacy versions of the app
   *  may have `.nnplot` paths; the backend's load-path endpoint accepts those
   *  and renames them in place to `.nnz` on successful load, so recent
   *  entries self-heal as the user re-opens them. */
  loadFromRecent: async (entry) => {
    // Caller is responsible for showing an unsaved-changes confirm
    // if needed (see `loadProject` comment above).
    //
    // Recents are POINTERS, not copies. A recent can only be reopened
    // from its file path on disk; there is no cached-story fallback.
    // (Older builds stashed a full story copy per entry in localStorage,
    // which bloated the store until saves failed with a quota error.
    // That cache is gone.) A path-less entry, or one whose file has been
    // moved or deleted, is removed with a notice rather than opening a
    // stale ghost copy.
    if (!entry.path) {
      const updated = readRecent().filter((r) => r.name !== entry.name)
      writeRecent(updated)
      set({
        recentProjects: updated,
        error: 'This recent project has no saved file path and can no longer be opened. It has been removed from recent projects.',
      })
      return
    }
    try {
      set({ _loadingProject: true, _loadingProjectTitle: entry?.name ? entry.name.replace(/\.(nnz|nnplot)$/i, '') : null })
      let story
      try {
        const { data } = await axios.post('/api/project/load-path', { path: entry.path })
        story = data
      } catch (pathErr) {
        // File moved or deleted (404): drop the dead pointer and say so.
        if (pathErr?.response?.status === 404) {
          const updated = readRecent().filter((r) => r.path !== entry.path)
          writeRecent(updated)
          set({
            recentProjects: updated,
            error: `This project file has been moved or deleted:\n${entry.path}\nIt has been removed from recent projects.`,
          })
          return
        }
        // Incompatible / corrupt / any other failure: surface it via the
        // outer catch. There is no cached fallback any more, so we never
        // pretend to open a file we could not actually read.
        throw pathErr
      }

      const { nodes, edges } = storyToFlow(story)
      const relationships = story.relationships || []
      const knowledges = story.knowledges || []
      const { byEntity, byScene } = _buildRelIndexes(relationships)
      set({ story, nodes, edges, relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, knowledges, activePath: entry.path, error: null, history: [], future: [], hasUnsavedChanges: false, _pendingFitView: true, _loadSettling: true, loadGeneration: get().loadGeneration + 1 })
      usePreviewStore.getState().resetForProjectLoad()
      useEntitiesStore.getState().syncFromStory(story)
      // Phase 1.24b — project switch closes the TOC + clears filter (matches
      // the other load paths so a recents / native-open switch is consistent).
      useUiStore.getState().closeTocPanel()
      // Phase 2.5h — wipe per-thread Story Scope context state on
      // project switch since scene / chapter / act ids belong to one
      // project only.
      useUiStore.getState().clearAllStoryScopeState()
      // Lift the just-opened entry to the top with a fresh timestamp,
      // as a clean pointer (name + path + openedAt only).
      const prev = readRecent().filter((r) => r.path !== entry.path)
      const refreshed = { name: entry.name, path: entry.path, openedAt: new Date().toISOString() }
      const reordered = [refreshed, ...prev].slice(0, MAX_RECENT)
      writeRecent(reordered)
      set({ recentProjects: reordered })
    } catch (err) {
      const structured = await handleSaveFormatLoadError(err)
      set({ error: structured || 'Failed to restore recent project.' })
    } finally {
      set({ _loadingProject: false, _loadingProjectTitle: null })
    }
  },

  /** Reset to a blank story. */
  newProject: async () => {
    // Caller is responsible for showing an unsaved-changes confirm
    // if needed — see `loadProject` comment above.
    try {
      // Force-clear the detail panel BEFORE swapping the story so any
      // currently-open detail view (Entity / Relationship / Knowledge /
      // Scene) doesn't briefly try to render against the about-to-be-
      // gone library on its next paint. The unsaved-changes confirm
      // ran upstream in the caller, so `force: true` skips the second
      // navigation-guard prompt.
      useUiStore.getState().clearDetailPanel({ force: true })
      const { data } = await axios.post('/api/story/reset')
      const { nodes, edges } = storyToFlow(data)
      // Auto-create POV Origin Node on new stories
      const ensured = ensurePovOriginNode(nodes)
      const relationships = data.relationships || []
      const knowledges = data.knowledges || []
      const { byEntity, byScene } = _buildRelIndexes(relationships)
      set({ story: data, nodes: ensured, edges, relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, knowledges, activePath: null, error: null, history: [], future: [], hasUnsavedChanges: false, _pendingFitView: true, _loadSettling: true, loadGeneration: get().loadGeneration + 1 })
      usePreviewStore.getState().resetForProjectLoad()
      useEntitiesStore.getState().syncFromStory(data)
      // Phase 1.24b — new project closes the TOC + clears filter.
      useUiStore.getState().closeTocPanel()
      // Phase 2.5h — wipe per-thread Story Scope context state.
      useUiStore.getState().clearAllStoryScopeState()
      try { resetOvumBlack() } catch { /* effects must never break a load */ }
    } catch {
      set({ error: 'Failed to create new project.' })
    }
  },

  /** Replace the current story with one returned by the Phase 1.12b
   *  entity-import commit endpoint. Rebuilds nodes + edges from the
   *  new story (imported entities may add setup nodes), syncs the
   *  entities store so the Library panel shows the new rows, marks
   *  the project as having unsaved changes. History stack is cleared
   *  because the shape of the library changed in ways that the
   *  existing undo snapshots can't meaningfully roll back to. */
  applyImportedStory: (newStory) => {
    if (!newStory) return
    const { nodes, edges } = storyToFlow(newStory)
    const relationships = newStory.relationships || []
    const knowledges = newStory.knowledges || []
    const { byEntity, byScene } = _buildRelIndexes(relationships)
    set({
      story: newStory,
      nodes,
      edges,
      relationships,
      relationshipsByEntity: byEntity,
      relationshipsByScene: byScene,
      knowledges,
      error: null,
      history: [],
      future: [],
      hasUnsavedChanges: true,
    })
    useEntitiesStore.getState().syncFromStory(newStory)
  },

  // ── Story Settings ────────────────────────────────────────────────────────────

  /** Update story-level settings fields (title, author, tense, etc.). */
  updateStorySettings: (fields) => {
    const { story } = get()
    if (!story) return
    set({ story: { ...story, ...fields }, hasUnsavedChanges: true })
  },

  // ── Chapters & Acts (Phase 1.11, Track B) ────────────────────────────────────
  // Column-division view data model. Chapter membership for plot point nodes is
  // derived on-the-fly from node x-position via `getChapterIdForNode` (Track C)
  // — never stored on the node. All chapter/act mutations call `_snapshot()`
  // before mutating so they participate in undo/redo via the extended
  // `_storyBefore` snapshot field (see `_snapshot` / `undo` / `redo` below).
  //
  // `setChapterWidth` is called as a *commit* by the Track D divider-drag UI
  // — the UI tracks draft width in local component state during a drag and
  // only dispatches this action on mouseup (one snapshot per resize). Per-
  // pixel dispatch would flood history with 60+ entries per second and is
  // avoided at the UI layer, not the store layer.

  /** Append a new empty chapter to the end of `chapters[]` with default width,
   *  empty title (header will display the auto-numbered "Chapter N" label), and
   *  null colour. Returns the new chapter's id so the caller can immediately
   *  focus the inline title editor on it.
   *
   *  First-chapter UX guard: if this is the very FIRST chapter being
   *  created in a project that already has canvas nodes positioned past
   *  the chapter strip's starting x, `chapter_x_offset` is shifted
   *  forward so the new chapter spawns in fresh territory PAST the
   *  rightmost node. Without this, a writer who has been organising
   *  scenes loosely on the canvas creates their first chapter and is
   *  surprised that several of those scenes are now members of it just
   *  because their x-position happens to fall in the new chapter's
   *  range. With this guard the writer can deliberately drag scenes
   *  into the chapter (or drag the chapter back over scenes) instead
   *  of having membership assigned by coincidence.
   *
   *  This only fires when chapters.length is currently 0 — once any
   *  chapter exists, subsequent chapters pack onto the end of the
   *  existing strip normally (the user has already established where
   *  the chapter strip lives). */
  addChapter: () => {
    const { story, nodes } = get()
    if (!story) return null
    get()._snapshot()
    const id = crypto.randomUUID()
    // Default width 540 px ≈ 2.45 × the default scene node width of 220 px,
    // snapped to the 20 flow-px canvas dot grid so column dividers land
    // exactly on grid points. Gives a fresh chapter comfortable room for
    // a couple of scenes.
    const newChapter = { id, title: '', colour: null, width: 540 }
    const existingChapters = story.chapters || []
    const existingNodes = nodes || []
    let nextOffset = story.chapter_x_offset ?? 10
    let nextNodes = existingNodes

    // Multi-row: append the new chapter to the LAST row so it renders as a
    // column (else it's in chapters[] but no row → invisible). It joins the
    // end of the last row, after every existing node's chapter, so no node
    // needs to move (the single-row x-shift guards below don't apply).
    if (story.canvas_layout_mode === 'multi' && Array.isArray(story.chapter_rows) && story.chapter_rows.length) {
      const newRows = story.chapter_rows.map((r, i) =>
        i === story.chapter_rows.length - 1
          ? { ...r, chapter_ids: [...(r.chapter_ids || []), id] }
          : r
      )
      set({
        story: { ...story, chapters: [...existingChapters, newChapter], chapter_rows: newRows },
        hasUnsavedChanges: true,
      })
      return id
    }

    if (existingChapters.length === 0) {
      // First-chapter UX guard: shift `chapter_x_offset` forward so
      // the new chapter spawns in fresh territory past any existing
      // canvas nodes. Without this a writer who's been organising
      // scenes loosely creates their first chapter and is surprised
      // that several of those scenes are now members of it.
      if (existingNodes.length > 0) {
        let rightmost = -Infinity
        for (const n of existingNodes) {
          const nx = n.position?.x || 0
          const nw = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 220
          const right = nx + nw
          if (right > rightmost) rightmost = right
        }
        // 80 px buffer for visual separation between the rightmost node
        // and the new chapter's left edge.
        if (Number.isFinite(rightmost) && rightmost > nextOffset) {
          nextOffset = rightmost + 80
        }
      }
    } else {
      // Subsequent-chapter preservation guard: any off-chapter node
      // currently sitting past the rightmost existing chapter would
      // get absorbed by the new chapter's x-range once we append.
      // Shift those nodes right by the new chapter's width so they
      // stay past the NEW rightmost edge, preserving their off-chapter
      // status. The shift uses centre-x (same rule
      // `getChapterIdForNode` uses) so a node sitting exactly on the
      // boundary keeps the correct membership: any node whose centre
      // would land inside the new chapter's range gets shifted.
      let prevRightmost = nextOffset
      for (const c of existingChapters) prevRightmost += c.width || 0
      const shift = newChapter.width
      nextNodes = existingNodes.map((n) => {
        const nx = n.position?.x || 0
        const nw = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 220
        const centreX = nx + nw / 2
        if (centreX >= prevRightmost) {
          return { ...n, position: { ...(n.position || {}), x: nx + shift } }
        }
        return n
      })
    }

    set({
      story: {
        ...story,
        chapter_x_offset: nextOffset,
        chapters: [...existingChapters, newChapter],
      },
      nodes: nextNodes,
      hasUnsavedChanges: true,
    })
    return id
  },

  /** Insert a new empty chapter at a specific position in `chapters[]`,
   *  shifting every downstream node right by the new chapter's width
   *  so each node stays inside the chapter it was previously in, and
   *  adding the new chapter into any act whose span the insertion
   *  position strictly straddles.
   *
   *  Used by the MCP `create_chapter(before=|after=)` flow — the UI
   *  itself only appends today; this exists so an MCP client can mint
   *  a chapter mid-strip without forcing the writer (or the AI) to
   *  manually renumber every downstream chapter title and re-drag
   *  every downstream scene afterwards.
   *
   *  `index` semantics: 0-indexed insertion point. `0` inserts at the
   *  very start (before what's currently `Chapter 1`); `chapters.length`
   *  inserts at the end (same effect as `addChapter`, kept for callers
   *  passing a derived index without special-casing the boundary).
   *
   *  Node shift: every node whose CENTRE-x is ≥ insertionX shifts right
   *  by the new chapter's width. Centre-x is the same rule
   *  `getChapterIdForNode` uses, so chapter membership is preserved
   *  exactly (not just approximately by left-edge). Applies to every
   *  node type — scenes, modifier EntityNodes, entity origins,
   *  relationship origins, knowledge origins, reference nodes.
   *
   *  Act membership: for each act with leftmost-chapter-index `leftPos`
   *  and rightmost-chapter-index `rightPos` (in the OLD chapters[]
   *  indexing), the new chapter joins the act iff
   *  `leftPos < index <= rightPos`. That covers exactly the strictly-
   *  internal case — inserting at position 0 or between two acts or
   *  past the last act doesn't grow any act. Single snapshot per call. */
  insertChapterAt: (index, { title } = {}) => {
    const { story } = get()
    if (!story) return null
    const chapters = story.chapters || []
    const acts = story.acts || []
    const clampedIdx = Math.max(0, Math.min(chapters.length, Math.floor(Number(index) || 0)))
    get()._snapshot()
    const id = crypto.randomUUID()
    const newChapter = { id, title: title || '', colour: null, width: 540 }

    // Compute the flow-space x where the new chapter's LEFT edge lands.
    // Everything with centre-x ≥ this value gets shifted right by W.
    const xOffset = story.chapter_x_offset ?? 10
    let insertionX = xOffset
    for (let i = 0; i < clampedIdx; i++) insertionX += chapters[i].width || 0
    const shift = newChapter.width

    // Build the new chapters[] with the insertion applied.
    const nextChapters = [
      ...chapters.slice(0, clampedIdx),
      newChapter,
      ...chapters.slice(clampedIdx),
    ]

    // Rewrite acts: any act whose old-indexing range strictly straddles
    // the insertion point grows by one to include the new chapter id at
    // the right position. Position resolution is done by chapters[]
    // order (after insertion) so the resulting chapter_ids[] is sorted
    // identically to the canvas layout.
    const oldIndexById = new Map(chapters.map((c, i) => [c.id, i]))
    const newIndexById = new Map(nextChapters.map((c, i) => [c.id, i]))
    const nextActs = acts.map((act) => {
      const oldIndices = (act.chapter_ids || [])
        .map((cid) => oldIndexById.get(cid))
        .filter((i) => i != null && i !== undefined)
      if (oldIndices.length === 0) return act
      const leftPos = Math.min(...oldIndices)
      const rightPos = Math.max(...oldIndices)
      // Insertion strictly INSIDE the act's span — include the new chapter
      // so the chain stays contiguous.
      if (clampedIdx > leftPos && clampedIdx <= rightPos) {
        const expanded = [...(act.chapter_ids || []), id]
        // Re-sort by canvas order so `chapter_ids` matches chapters[]
        // ordering (consistent with how addAct / setActRange produce
        // chapter_ids — already sorted runs).
        expanded.sort((a, b) => (newIndexById.get(a) ?? 0) - (newIndexById.get(b) ?? 0))
        return { ...act, chapter_ids: expanded }
      }
      return act
    })

    // Multi-row: the new chapter must JOIN a row (else it's in chapters[]
    // but no row → invisible). Splice its id into chapter_rows right after
    // the predecessor chapter (keeps the row-major flattening == the new
    // chapters[]), then re-place nodes via the chapter-as-group rule so the
    // chapters after the insertion point in that row (and their nodes) shift
    // right. Other rows are untouched.
    if (story.canvas_layout_mode === 'multi' && Array.isArray(story.chapter_rows) && story.chapter_rows.length) {
      const predecessorId = clampedIdx > 0 ? chapters[clampedIdx - 1].id : null
      const newRows = _insertChapterIntoRows(story.chapter_rows, id, predecessorId)
      const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
      const nextNodesMR = _relayoutNodesAcrossRows(get().nodes || [], chapters, story.chapter_rows, nextChapters, newRows, geom)
      set({
        story: { ...story, chapters: nextChapters, acts: nextActs, chapter_rows: newRows },
        nodes: nextNodesMR,
        hasUnsavedChanges: true,
      })
      return id
    }

    // Shift every node whose CENTRE-x is at or past insertionX. Using
    // centre-x mirrors `getChapterIdForNode`'s rule so each node's
    // chapter membership is preserved exactly through the insertion.
    const nodes = get().nodes || []
    const nextNodes = nodes.map((n) => {
      const nx = n.position?.x || 0
      const nw = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 220
      const centreX = nx + nw / 2
      if (centreX >= insertionX) {
        return { ...n, position: { ...(n.position || {}), x: nx + shift } }
      }
      return n
    })

    set({
      story: { ...story, chapters: nextChapters, acts: nextActs },
      nodes: nextNodes,
      hasUnsavedChanges: true,
    })
    return id
  },

  /** Phase 4.3 — append a new empty row to `chapter_rows` (multi-row
   *  layout). Empty rows are a valid, user-managed state: the new row
   *  persists until the user moves chapters into it or removes it via
   *  the delete-row control. No chapters move and `chapters[]` is
   *  untouched, so story order is unaffected (an empty row contributes
   *  nothing to the row-major flattening). Initialises `chapter_rows`
   *  from the current `chapters[]` as a single row first if it is null
   *  (so toggling has something to grow from). Returns the new row id. */
  addChapterRow: () => {
    const { story } = get()
    if (!story) return null
    get()._snapshot()
    const existing = Array.isArray(story.chapter_rows) ? story.chapter_rows : null
    const id = crypto.randomUUID()
    const newRow = { id, chapter_ids: [], height: 600 }
    const baseRows = existing || [
      { id: crypto.randomUUID(), chapter_ids: (story.chapters || []).map((c) => c.id), height: 600 },
    ]
    set({
      story: { ...story, chapter_rows: [...baseRows, newRow] },
      hasUnsavedChanges: true,
    })
    return id
  },

  /** Phase 4.3 — remove a row from `chapter_rows`. Only EMPTY rows are
   *  removable (the delete-row control is shown only on empty rows); a
   *  request to delete a non-empty row is a no-op so chapters can never
   *  be lost this way. `chapters[]` and story order are untouched. */
  deleteChapterRow: (rowId) => {
    const { story } = get()
    if (!story || !Array.isArray(story.chapter_rows)) return
    const target = story.chapter_rows.find((r) => r.id === rowId)
    if (!target || (target.chapter_ids && target.chapter_ids.length > 0)) return
    get()._snapshot()
    set({
      story: { ...story, chapter_rows: story.chapter_rows.filter((r) => r.id !== rowId) },
      hasUnsavedChanges: true,
    })
  },

  /** Phase 4.3 — set the canvas layout mode ('single' | 'multi') and
   *  reposition every chapter-member node via the chapter-as-group rule
   *  (§4): one mode-invariant chapter-relative offset per node, the
   *  absolute position recomputed from the target mode's chapter origin.
   *  Off-strip nodes (no chapter membership) keep their absolute position.
   *  One batched `set` (no measurement storm — only positions change),
   *  one snapshot (undo restores positions + mode atomically).
   *
   *  single → multi: rows come from an existing `chapter_rows`, else a
   *  first-enable auto-wrap to `opts.wrapWidth` (flow-px). Each row's
   *  height is grown to fit its chapters' content so every member node's
   *  centre lands inside its row band — this is what keeps multi-row
   *  membership (and therefore the §2 story-order invariant + the
   *  toggle-back round-trip) exact.
   *
   *  multi → single: the inverse map (cell origin → single-row column).
   *  `chapter_rows` is KEPT so toggling back restores the arrangement. */
  setCanvasLayoutMode: (mode, opts = {}) => {
    const { story, nodes } = get()
    if (!story) return
    // A user-initiated mode switch recenters the canvas on the POV origin
    // (Canvas consumes this). The internal reorganize project/re-wrap passes
    // skipSnapshot and must NOT trigger a recenter — reorganize fires its own
    // single recenter at the end so the camera doesn't hop mid-operation.
    if (!opts.skipSnapshot) get().requestPovFocus()
    const targetMode = mode === 'multi' ? 'multi' : 'single'
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10
    // The multi-row vertical allowance for BOTH directions: when entering
    // multi we write to it, when leaving we read the current multi positions
    // out of it. Either way it's the multi-row header allowance (2 rows when
    // acts are expanded, else 1). `canvas_layout_mode` may still read 'single'
    // mid-switch, so pin the mode to 'multi' here rather than reading it off
    // the (pre-switch) story.
    const geom = rowGeometryParams(xOffset, multirowHeaderRows('multi', !!story.multirow_acts_expanded))
    const allNodes = nodes || []
    const nodeHeight = (n) =>
      n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 120
    const CONTENT_PAD = 40

    if (targetMode === 'multi') {
      // Rows: reuse an existing grouping, else first-enable auto-wrap.
      let rows = Array.isArray(story.chapter_rows) && story.chapter_rows.length > 0
        ? story.chapter_rows.map((r) => ({ ...r, chapter_ids: [...(r.chapter_ids || [])] }))
        : wrapChaptersIntoRows(chapters, opts.wrapWidth || 4000, () => crypto.randomUUID())
      if (rows.length === 0) {
        rows = [{ id: crypto.randomUUID(), chapter_ids: chapters.map((c) => c.id), height: DEFAULT_ROW_HEIGHT }]
      }
      // Resync the (possibly stale) preserved rows against chapters[] —
      // single-row chapter inserts/deletes since the last multi-row view
      // don't touch chapter_rows, so reconcile before laying out.
      rows = _reconcileRowsWithChapters(rows, chapters)
      // Group-aware row constraint (Phase 8.5): a concept group whose box spans
      // several chapters must keep those chapters on ONE row. Otherwise this
      // switch sends each member to its chapter's cell, and any member whose
      // chapter landed on a DIFFERENT row ends up outside the box and silently
      // drops out of the group (confirmed by measurement). Nodes are in
      // single-row coords at this point, so read each concept group's box x-span
      // against the single-row columns and merge rows so no break splits a span
      // (keep-together; the merged row is wider). Runs on every enter-multi-row,
      // so plain toggles AND reorganize's inner switch are both covered.
      {
        const _groupSpans = []
        for (const gn of allNodes) {
          if (gn.type !== 'genericGroupNode' || gn.data?.concept_group !== true) continue
          const gx = gn.position?.x ?? 0
          const gw = gn.measured?.width ?? getMeasuredWidth(gn.id) ?? gn.data?.width ?? gn.style?.width ?? gn.width ?? 400
          const span = chapterIndexSpanForXRange(gx, gx + gw, chapters, xOffset)
          if (span && span[0] !== span[1]) _groupSpans.push(span)
        }
        if (_groupSpans.length) rows = constrainRowsToGroupSpans(rows, chapters, _groupSpans)
      }
      // Pass 0: capture each chapter's content-top (the y of its highest
      // member node, canonical single-row space) into `content_origin_y`.
      // Member offsets are then measured from this, so the chapter's top node
      // lands just under its row header (no inherited gap) and no offset is
      // negative (nothing wraps into the row above). Recomputed every switch
      // into multi-row so it stays snug to where the nodes currently sit.
      const contentTopByChapter = new Map()
      for (const n of allNodes) {
        const cid = getChapterIdForNode(n, chapters, xOffset)
        if (!cid) continue
        const y = n.position?.y ?? 0
        const prev = contentTopByChapter.get(cid)
        if (prev == null || y < prev) contentTopByChapter.set(cid, y)
      }
      const chaptersWithOrigin = chapters.map((c) => (
        { ...c, content_origin_y: contentTopByChapter.has(c.id) ? contentTopByChapter.get(c.id) : null }
      ))
      // Pass 1: chapter-relative offsets (now measured from each chapter's
      // content-top via the origin helpers reading `content_origin_y`) + the
      // per-row content extent, so we can grow each row to fit its tallest
      // chapter.
      const rowIndexByChapter = new Map()
      rows.forEach((r, i) => (r.chapter_ids || []).forEach((cid) => rowIndexByChapter.set(cid, i)))
      const offsets = new Map()
      const rowMaxBottom = new Array(rows.length).fill(0)
      for (const n of allNodes) {
        const cid = getChapterIdForNode(n, chaptersWithOrigin, xOffset)
        if (!cid) continue
        const singleOrigin = getChapterOriginSingleRow(cid, chaptersWithOrigin, xOffset, geom.singleRowTopY)
        if (!singleOrigin) continue
        const ox = (n.position?.x ?? 0) - singleOrigin.x
        const oy = (n.position?.y ?? 0) - singleOrigin.y
        offsets.set(n.id, { cid, ox, oy })
        const ri = rowIndexByChapter.get(cid)
        if (ri != null) rowMaxBottom[ri] = Math.max(rowMaxBottom[ri], oy + nodeHeight(n))
      }
      rows.forEach((r, i) => {
        // Fit to content: the header buffer above the top node + the tallest
        // chapter's content extent + the bottom pad, floored at MIN_ROW_HEIGHT.
        // Honours `height_user_set` so a manually enlarged row keeps its extra
        // space; an auto-fit row grows AND shrinks with its content.
        const contentFit = Math.max(MIN_ROW_HEIGHT, ROW_CONTENT_TOP_BUFFER + rowMaxBottom[i] + CONTENT_PAD)
        r.height = _fitRowHeight(r, contentFit)
      })
      // Pass 2: place nodes at their cell origin + offset (final heights).
      if (!opts.skipSnapshot) get()._snapshot()
      const nextNodes = allNodes.map((n) => {
        const o = offsets.get(n.id)
        if (!o) return n
        const cellOrigin = getChapterOriginMultiRow(o.cid, rows, chaptersWithOrigin, geom.xOffset, geom.rowsTopY, geom.rowGap)
        if (!cellOrigin) return n
        return { ...n, position: { x: cellOrigin.x + o.ox, y: cellOrigin.y + o.oy } }
      })
      // Pass 3 — concept-group member realignment. Passes 1-2 offset every node
      // from ITS OWN chapter's content-top, so a concept group whose members span
      // more than one chapter (mapped from DIFFERENT chapter content-tops) lands
      // its members at mismatched Y — one tucked under the 26px header, one
      // ejected above the box and geometrically dropped — worse when two groups
      // share a chapter column and skew that column's content-top. Re-attach each
      // spanning concept group's members to its BOX in Y (keeping the switch's
      // per-chapter X so members stay in their columns), preserving the group's
      // single-row internal arrangement, then refit the box (header reserved) to
      // wrap them. Runs on every enter-multi-row incl. reorganize's inner switch.
      const finalNodes = _realignSpanningConceptGroups(nextNodes, allNodes, chaptersWithOrigin, xOffset)
      set({
        story: { ...story, chapters: chaptersWithOrigin, canvas_layout_mode: 'multi', chapter_rows: rows },
        nodes: finalNodes,
        hasUnsavedChanges: true,
      })
      return
    }

    // multi → single: map each node out of its multi-row cell back onto
    // its single-row column. `chapter_rows` is preserved.
    const rows = Array.isArray(story.chapter_rows) ? story.chapter_rows : null
    if (!opts.skipSnapshot) get()._snapshot()
    let nextNodes = allNodes
    if (rows && rows.length > 0) {
      nextNodes = allNodes.map((n) => {
        const cid = getChapterIdForNodeMultiRow(n, chapters, rows, geom.xOffset, geom.rowsTopY, geom.rowGap)
        if (!cid) return n
        const cellOrigin = getChapterOriginMultiRow(cid, rows, chapters, geom.xOffset, geom.rowsTopY, geom.rowGap)
        const singleOrigin = getChapterOriginSingleRow(cid, chapters, xOffset, geom.singleRowTopY)
        if (!cellOrigin || !singleOrigin) return n
        const px = n.position?.x ?? 0
        const py = n.position?.y ?? 0
        return { ...n, position: { x: singleOrigin.x + (px - cellOrigin.x), y: singleOrigin.y + (py - cellOrigin.y) } }
      })
    }
    // Same realignment on the way OUT of multi-row: the multi->single mapping
    // above offsets by the same per-chapter content-tops, so it would break a
    // spanning concept group in single-row (members escape the box); re-deriving
    // from the box keeps it intact so a later single->multi can find + place it.
    const singleFinal = _realignSpanningConceptGroups(nextNodes, allNodes, chapters, xOffset)
    set({
      story: { ...story, canvas_layout_mode: 'single' },
      nodes: singleFinal,
      hasUnsavedChanges: true,
    })
  },

  /** Phase 4.3 — toggle the multi-row acts header between collapsed (1 header
   *  row: chapter only) and expanded (2 header rows: act + chapter). The
   *  per-story `multirow_acts_expanded` marker is the single geometry source
   *  (membership / story-order / overlay all read it via the rowLayout
   *  helpers), so flipping it changes the header allowance every node is
   *  anchored to. Expanding therefore PUSHES scenes down to make room for the
   *  act row; collapsing pulls them back up. Each node keeps its chapter-cell
   *  offset (the mode-invariant offset rule) and is re-placed at the new cell
   *  origin, so membership and story order are unchanged across the toggle —
   *  only the vertical screen position shifts. Single snapshot for undo.
   *  No-op for x: cell-x doesn't depend on the header allowance. Outside
   *  multi-row (single-row view) there are no row-anchored nodes to move, so
   *  the marker just flips (it takes effect the next time multi-row renders). */
  toggleMultirowActsExpanded: () => {
    const { story, nodes } = get()
    if (!story) return
    const wasExpanded = !!story.multirow_acts_expanded
    if (story.canvas_layout_mode !== 'multi') {
      get()._snapshot()
      set({ story: { ...story, multirow_acts_expanded: !wasExpanded }, hasUnsavedChanges: true })
      return
    }
    const rows = Array.isArray(story.chapter_rows) ? story.chapter_rows : null
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10
    const oldGeom = rowGeometryParams(xOffset, multirowHeaderRows('multi', wasExpanded))
    const newGeom = rowGeometryParams(xOffset, multirowHeaderRows('multi', !wasExpanded))
    const allNodes = nodes || []
    get()._snapshot()
    let nextNodes = allNodes
    if (rows && rows.length > 0) {
      nextNodes = allNodes.map((n) => {
        const cid = getChapterIdForNodeMultiRow(n, chapters, rows, oldGeom.xOffset, oldGeom.rowsTopY, oldGeom.rowGap)
        if (!cid) return n
        const oldCell = getChapterOriginMultiRow(cid, rows, chapters, oldGeom.xOffset, oldGeom.rowsTopY, oldGeom.rowGap)
        const newCell = getChapterOriginMultiRow(cid, rows, chapters, newGeom.xOffset, newGeom.rowsTopY, newGeom.rowGap)
        if (!oldCell || !newCell) return n
        const px = n.position?.x ?? 0
        const py = n.position?.y ?? 0
        return { ...n, position: { x: newCell.x + (px - oldCell.x), y: newCell.y + (py - oldCell.y) } }
      })
    }
    set({
      story: { ...story, multirow_acts_expanded: !wasExpanded },
      nodes: nextNodes,
      hasUnsavedChanges: true,
    })
  },

  /** Phase 4.3 — chapter edge-shuffle between adjacent rows (§5). Moves a
   *  row's edge chapter to the adjacent end of the neighbouring row:
   *  'up' sends the row's FIRST chapter to the END of the previous row;
   *  'down' sends the row's LAST chapter to the START of the next row.
   *  Only edge chapters move, and only to the adjacent end, so the
   *  row-major chapter sequence (and therefore `chapters[]` order + story
   *  order) is unchanged — it only relocates where the row wrap falls.
   *  The moved chapter's nodes follow it into the new row (chapter-as-group):
   *  every node is re-placed at its new cell origin + its mode-invariant
   *  offset, and the destination row's height grows to fit. Single snapshot. */
  moveChapterBetweenRows: (chapterId, direction) => {
    const { story, nodes } = get()
    if (!story || !Array.isArray(story.chapter_rows)) return
    const oldRows = story.chapter_rows
    const ri = oldRows.findIndex((r) => (r.chapter_ids || []).includes(chapterId))
    if (ri < 0) return
    const posInRow = oldRows[ri].chapter_ids.indexOf(chapterId)
    const newRows = oldRows.map((r) => ({ ...r, chapter_ids: [...(r.chapter_ids || [])] }))
    if (direction === 'up') {
      if (ri === 0 || posInRow !== 0) return
      newRows[ri].chapter_ids.shift()
      newRows[ri - 1].chapter_ids.push(chapterId)
    } else if (direction === 'down') {
      if (ri === oldRows.length - 1 || posInRow !== oldRows[ri].chapter_ids.length - 1) return
      newRows[ri].chapter_ids.pop()
      newRows[ri + 1].chapter_ids.unshift(chapterId)
    } else {
      return
    }
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10
    const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
    const allNodes = nodes || []
    const nodeHeight = (n) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 120
    const CONTENT_PAD = 40
    // Offsets from OLD cell origins (chapter-relative, mode-invariant).
    const offsets = new Map()
    for (const n of allNodes) {
      const cid = getChapterIdForNodeMultiRow(n, chapters, oldRows, geom.xOffset, geom.rowsTopY, geom.rowGap)
      if (!cid) continue
      const oc = getChapterOriginMultiRow(cid, oldRows, chapters, geom.xOffset, geom.rowsTopY, geom.rowGap)
      if (!oc) continue
      offsets.set(n.id, { cid, ox: (n.position?.x ?? 0) - oc.x, oy: (n.position?.y ?? 0) - oc.y })
    }
    // Grow each destination row to fit its (new) content.
    const rowIndexByChapter = new Map()
    newRows.forEach((r, i) => r.chapter_ids.forEach((cid) => rowIndexByChapter.set(cid, i)))
    const rowMaxBottom = new Array(newRows.length).fill(0)
    for (const n of allNodes) {
      const o = offsets.get(n.id)
      if (!o) continue
      const i = rowIndexByChapter.get(o.cid)
      if (i != null) rowMaxBottom[i] = Math.max(rowMaxBottom[i], o.oy + nodeHeight(n))
    }
    newRows.forEach((r, i) => { r.height = Math.max(r.height || DEFAULT_ROW_HEIGHT, rowMaxBottom[i] + CONTENT_PAD) })
    get()._snapshot()
    const nextNodes = allNodes.map((n) => {
      const o = offsets.get(n.id)
      if (!o) return n
      const nc = getChapterOriginMultiRow(o.cid, newRows, chapters, geom.xOffset, geom.rowsTopY, geom.rowGap)
      if (!nc) return n
      return { ...n, position: { x: nc.x + o.ox, y: nc.y + o.oy } }
    })
    set({
      story: { ...story, chapter_rows: newRows },
      nodes: nextNodes,
      hasUnsavedChanges: true,
    })
  },

  /** Phase 4.3 — live row-height resize (§5). Sets one row's `height` and
   *  applies the supplied node y-shifts (rows below the dragged boundary
   *  slide down/up with their nodes). No snapshot here: the overlay
   *  snapshots once at drag start, so the whole drag collapses to one undo
   *  step (mirrors `setChapterResizeLive`). */
  setRowHeightLive: (rowId, { height, nodeUpdates, userSet } = {}) => {
    const { story, nodes } = get()
    if (!story || !Array.isArray(story.chapter_rows)) return
    // `userSet` (when provided): true once dragged ABOVE the content-fit floor
    // (sticky height), false when dragged back down TO the floor (revert to
    // auto-fit). Omitted => leave the flag untouched.
    const nextRows = story.chapter_rows.map((r) => (
      r.id === rowId
        ? { ...r, height, ...(userSet !== undefined ? { height_user_set: userSet } : {}) }
        : r
    ))
    let nextNodes = nodes
    if (nodeUpdates && nodeUpdates.length) {
      const byId = new Map(nodeUpdates.map((u) => [u.id, u.y]))
      nextNodes = (nodes || []).map((n) =>
        byId.has(n.id) ? { ...n, position: { ...(n.position || {}), y: byId.get(n.id) } } : n
      )
    }
    set({ story: { ...story, chapter_rows: nextRows }, nodes: nextNodes, hasUnsavedChanges: true })
  },

  /** Phase 4.3 multi-row — re-fit every row's height to its current content
   *  and re-stack. Called on node drag-end (a node moved up/down changes its
   *  row's content extent) so the row shrinks/grows to fit, with rows below
   *  following. Auto-fit rows track content (grow AND shrink); user-set rows
   *  keep their extra height (clamped to >= content-fit). No-op in single-row,
   *  and a no-op (no set) when nothing changed, so it's cheap to call after
   *  every drag. Not snapshotted — node drags aren't snapshotted either, so
   *  this stays consistent with the drag it follows. */
  refitRowsToContent: ({ growOnly = false } = {}) => {
    const { story, nodes } = get()
    if (!story || story.canvas_layout_mode !== 'multi') return
    const rows = story.chapter_rows
    if (!Array.isArray(rows) || rows.length === 0) return
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10
    const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
    const allNodes = nodes || []
    const CONTENT_PAD = 40
    const oldBands = getRowBands(rows, geom.rowsTopY, geom.rowGap)
    const rowIdxByChapter = new Map()
    rows.forEach((r, i) => (r.chapter_ids || []).forEach((cid) => rowIdxByChapter.set(cid, i)))
    // Height source depends on the mode:
    //  - Full fit (drag-end, growOnly=false): BEST-AVAILABLE height — real
    //    measurement when the node has rendered, else the per-type seed on
    //    `node.measured` (set on load for virtualization). Using the seed for
    //    not-yet-rendered nodes lets a row SHRINK even in a big virtualized
    //    project where most members are off-screen; the strict
    //    really-measured-only gate that used to guard this refused to shrink
    //    in that case, so an auto-grown row never came back down.
    //  - Grow-on-measure (growOnly=true): REAL measurements only
    //    (`getMeasuredHeight`); not-yet-rendered nodes are skipped. This is the
    //    safety net that GROWS a row once an off-screen node renders taller
    //    than its seed estimate, so a seed under-estimate never leaves a
    //    persistent header overlap.
    const heightOf = (n) => growOnly
      ? getMeasuredHeight(n.id)
      : (n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 120)
    const memberRow = new Map()
    const maxBottom = new Array(rows.length).fill(-Infinity)
    // A row may SHRINK only if it has at least one rendered (really-measured)
    // node — i.e. it's at least partially on screen, so its content extent is
    // trustworthy. A FULLY off-screen row keeps its height (grow-only), so a
    // seed estimate can never momentarily undersize a row you then scroll to.
    const hasReal = new Array(rows.length).fill(false)
    for (const n of allNodes) {
      const cid = getChapterIdForNodeMultiRow(n, chapters, rows, geom.xOffset, geom.rowsTopY, geom.rowGap)
      if (!cid) continue
      const i = rowIdxByChapter.get(cid)
      if (i == null) continue
      memberRow.set(n.id, i)
      // "Really rendered" = we have a trustworthy height: a side-store entry,
      // OR `node.measured` differs from the per-type SEED estimate (the
      // load-time placeholder). The side store alone is unreliable here — some
      // rendered nodes have a real `node.measured` but no side-store entry — so
      // a row whose only on-screen node was judged solely by the side store
      // would never shrink. The seed-difference check fixes that.
      const m = n.measured?.height
      const seedH = (NODE_DIM_DEFAULTS[n.type] || DEFAULT_NODE_DIM).height
      if (getMeasuredHeight(n.id) != null || (m != null && Math.abs(m - seedH) > 0.5)) hasReal[i] = true
      const h = heightOf(n)
      if (h == null) continue  // grow mode: skip not-yet-rendered nodes
      const bottom = (n.position?.y ?? 0) + h - oldBands[i].top
      if (bottom > maxBottom[i]) maxBottom[i] = bottom
    }
    const newRows = rows.map((r, i) => {
      const contentFit = Math.max(MIN_ROW_HEIGHT, (maxBottom[i] === -Infinity ? 0 : maxBottom[i]) + CONTENT_PAD)
      // Shrink/grow to content on a full fit when the row is at least partially
      // rendered, honouring the user-set flag (a manually enlarged row keeps
      // its extra height). Otherwise grow-only (never below the current height).
      const target = (!growOnly && hasReal[i]) ? _fitRowHeight(r, contentFit) : Math.max(r.height || 0, contentFit)
      return { ...r, height: target }
    })
    if (!newRows.some((r, i) => r.height !== rows[i].height)) return  // nothing changed
    const newBands = getRowBands(newRows, geom.rowsTopY, geom.rowGap)
    const deltaByRow = newRows.map((r, i) => newBands[i].top - oldBands[i].top)
    const nextNodes = allNodes.map((n) => {
      const i = memberRow.get(n.id)
      if (i == null || !deltaByRow[i]) return n
      return { ...n, position: { x: n.position?.x ?? 0, y: (n.position?.y ?? 0) + deltaByRow[i] } }
    })
    set({ story: { ...story, chapter_rows: newRows }, nodes: nextNodes, hasUnsavedChanges: true })
  },

  /** Phase 4.3 multi-row — straddle-snap on node drop. Resolves a node dropped
   *  across a row boundary into ONE row, chosen by its TOP edge (the row whose
   *  header→content zone the top lands in — robust for tall nodes, unlike the
   *  center-y test). Clamps the node into that row's content (top >= band.top +
   *  buffer, out of the header band) and grows the row to contain it (rows below
   *  shift down), so the node never sits across a divider. Downward this is the
   *  grow-or-shunt behaviour (top still in the row ⇒ the row grows; top crossed
   *  into the next row's header zone ⇒ it lands in that row). Upward it shunts
   *  the node into the row its top entered (no grow-upward). The drag-end refit
   *  runs AFTER to shrink the row the node vacated. No-op in single-row; not
   *  snapshotted (node drags aren't either). */
  snapNodeToRowOnDrop: (nodeId) => {
    const { story, nodes } = get()
    if (!story || story.canvas_layout_mode !== 'multi') return
    const rows = story.chapter_rows
    if (!Array.isArray(rows) || rows.length === 0) return
    const allNodes = nodes || []
    const node = allNodes.find((n) => n.id === nodeId)
    if (!node) return
    const xOffset = story.chapter_x_offset ?? 10
    const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
    const CONTENT_PAD = 40
    const bands = getRowBands(rows, geom.rowsTopY, geom.rowGap)
    const top = node.position?.y ?? 0
    const R = rowIndexForTop(top, bands, geom.reserved)
    if (R < 0) return
    const h = getMeasuredHeight(node.id) ?? node.measured?.height ?? node.data?.height ?? node.height ?? 120
    const newTop = Math.max(top, bands[R].top + ROW_CONTENT_TOP_BUFFER)
    // Grow row R to contain the node: header buffer + node height + bottom pad.
    // The grow condition (required > current height) is exactly the case where
    // the node's centre would otherwise spill below the band, so after the grow
    // the node's centre is inside band R and the drag-end refit (center-y) keeps
    // it there.
    const required = (newTop - bands[R].top) + h + CONTENT_PAD
    const newHeight = Math.max(rows[R].height || 0, required)
    const grew = newHeight !== (rows[R].height || 0)
    const moved = newTop !== top
    if (!grew && !moved) return  // already sits cleanly in its row
    const newRows = grew ? rows.map((r, i) => (i === R ? { ...r, height: newHeight } : r)) : rows
    const newBands = grew ? getRowBands(newRows, geom.rowsTopY, geom.rowGap) : bands
    const deltaByRow = newBands.map((b, i) => b.top - bands[i].top)  // only rows BELOW R shift
    const nextNodes = allNodes.map((n) => {
      if (n.id === nodeId) {
        // Dragged node: clamp into row R. R's top is unchanged by growing R, so
        // deltaByRow[R] === 0 and newTop is already in the (unmoved) band R.
        return { ...n, position: { x: n.position?.x ?? 0, y: newTop + deltaByRow[R] } }
      }
      const ri = rowIndexForTop(n.position?.y ?? 0, bands, geom.reserved)
      if (ri < 0 || !deltaByRow[ri]) return n
      return { ...n, position: { x: n.position?.x ?? 0, y: (n.position?.y ?? 0) + deltaByRow[ri] } }
    })
    set({ story: { ...story, chapter_rows: newRows }, nodes: nextNodes, hasUnsavedChanges: true })
  },

  /** Remove a chapter. Rewrites any acts that referenced it so their
   *  `chapter_ids` stay contiguous via `_pruneActContiguity`, and drops any
   *  act whose `chapter_ids` becomes empty. Plot point nodes whose x-position
   *  fell inside the deleted column automatically snap to whichever chapter
   *  their position now matches — no node mutation needed since chapter
   *  membership is derived. Caller is responsible for any confirmation UI. */
  deleteChapter: (chapterId) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const oldChapters = story.chapters || []
    const deleted = oldChapters.find((c) => c.id === chapterId)
    const deletedWidth = deleted?.width || 0
    const rows = (story.canvas_layout_mode === 'multi' && Array.isArray(story.chapter_rows) && story.chapter_rows.length) ? story.chapter_rows : null

    // No node moves on delete. Instead the ADJACENT chapter grows by the
    // deleted chapter's width to cover the freed space, so every node
    // stays exactly where it is (the deleted chapter's own nodes don't
    // overlap a slid-in neighbour, and chapters further along don't move
    // because the cumulative width is preserved). Prefer the RIGHT
    // neighbour (it grows leftward into the gap); fall back to the LEFT
    // neighbour (grows rightward) when the deleted chapter is the last.
    // Multi-row resolves the neighbour WITHIN the deleted chapter's row.
    // Deleting a chapter never deletes a node.
    let absorbId = null
    if (rows) {
      const row = rows.find((r) => (r.chapter_ids || []).includes(chapterId))
      if (row) {
        const ids = row.chapter_ids
        const pos = ids.indexOf(chapterId)
        absorbId = ids[pos + 1] ?? ids[pos - 1] ?? null
      }
    } else {
      const pos = oldChapters.findIndex((c) => c.id === chapterId)
      absorbId = oldChapters[pos + 1]?.id ?? oldChapters[pos - 1]?.id ?? null
    }

    const chapters = oldChapters
      .filter((c) => c.id !== chapterId)
      .map((c) => (c.id === absorbId ? { ...c, width: (c.width || 0) + deletedWidth } : c))
    const acts = (story.acts || [])
      .map((act) => {
        if (!act.chapter_ids.includes(chapterId)) return act
        const nextIds = act.chapter_ids.filter((id) => id !== chapterId)
        return { ...act, chapter_ids: _pruneActContiguity(nextIds, chapters) }
      })
      .filter((act) => act.chapter_ids.length > 0)

    const storyPatch = { ...story, chapters, acts }
    if (rows) {
      // Empty rows persist (§5); just drop the deleted id from its row.
      storyPatch.chapter_rows = rows.map((r) => ({ ...r, chapter_ids: (r.chapter_ids || []).filter((id) => id !== chapterId) }))
    }
    set({ story: storyPatch, hasUnsavedChanges: true })
  },

  /** Rename a chapter. Empty string is valid and reverts the header to just
   *  the auto-numbered "Chapter N" label per the Track D display rule. */
  renameChapter: (chapterId, title) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const chapters = (story.chapters || []).map((c) =>
      c.id === chapterId ? { ...c, title } : c
    )
    set({ story: { ...story, chapters }, hasUnsavedChanges: true })
  },

  /** Set a chapter's colour. null = default chapter tint. */
  setChapterColour: (chapterId, colour) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const chapters = (story.chapters || []).map((c) =>
      c.id === chapterId ? { ...c, colour } : c
    )
    set({ story: { ...story, chapters }, hasUnsavedChanges: true })
  },

  /** Set a chapter's title and colour atomically in a single snapshot, so
   *  one popup-editor commit produces exactly one undo step instead of
   *  two. Used by the Track D double-click popup editor which edits both
   *  fields simultaneously. Empty title is valid and reverts the header
   *  to just the auto-numbered "Chapter N" label. */
  setChapterTitleAndColour: (chapterId, title, colour) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const chapters = (story.chapters || []).map((c) =>
      c.id === chapterId ? { ...c, title, colour } : c
    )
    set({ story: { ...story, chapters }, hasUnsavedChanges: true })
  },

  /** Set a chapter's width in canvas px, clamped to a 120 px floor so columns
   *  can't collapse to nothing. This is a *commit* action — call it once on
   *  drag end, not per-pixel. The Track D UI tracks draft width in local
   *  component state during the drag and dispatches this on mouseup so one
   *  resize operation produces one undo entry. */
  setChapterWidth: (chapterId, width) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const clamped = Math.max(120, Number(width) || 0)
    const chapters = (story.chapters || []).map((c) =>
      c.id === chapterId ? { ...c, width: clamped } : c
    )
    set({ story: { ...story, chapters }, hasUnsavedChanges: true })
  },

  /** Set the story's `chapter_x_offset` AND a chapter's `width` atomically
   *  in a single snapshot. Used by the Track D first-chapter-left-edge
   *  drag: dragging chapter 0's left edge should move the left edge while
   *  leaving the right edge pinned, which requires offset += delta AND
   *  width -= delta in one commit so one drag = one undo step. Width is
   *  clamped to the 120 px minimum; offset has no constraint (can go
   *  negative to extend chapters leftward of x=0). */
  setChapterXOffsetAndWidth: (chapterId, xOffset, width) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const clampedWidth = Math.max(120, Number(width) || 0)
    const chapters = (story.chapters || []).map((c) =>
      c.id === chapterId ? { ...c, width: clampedWidth } : c
    )
    set({
      story: { ...story, chapter_x_offset: xOffset, chapters },
      hasUnsavedChanges: true,
    })
  },

  /** Live update during a chapter resize drag — writes the chapter's new
   *  width (and optionally the first-chapter xOffset) plus absolute new
   *  x-positions for a set of affected nodes, all in ONE `set` call so
   *  React Flow re-renders everything atomically every frame. Phase
   *  1.12c v0.1.12.61.
   *
   *  Does **NOT** call `_snapshot()` — the caller (ChapterColumnsOverlay
   *  mousemove handler) must have invoked `_snapshot()` once at drag
   *  start so that undo restores to the pre-drag state. Every subsequent
   *  frame updates live in place, overwriting the prior frame's values
   *  without appending to the undo stack.
   *
   *  `nodeUpdates`: `Array<{id: string, x: number}>` — absolute new
   *  `position.x` for each affected node. Y is preserved. Callers that
   *  want no node shift (e.g. user holding Shift to opt out) simply
   *  omit or empty this list — the chapter is still resized but nodes
   *  stay where they are. */
  setChapterResizeLive: (chapterId, { width, xOffset, nodeUpdates }) => {
    set((state) => {
      if (!state.story) return {}
      const clampedWidth = Math.max(120, Number(width) || 0)
      const chapters = (state.story.chapters || []).map((c) =>
        c.id === chapterId ? { ...c, width: clampedWidth } : c
      )
      const nextStory = { ...state.story, chapters }
      if (xOffset !== undefined && xOffset !== null) {
        nextStory.chapter_x_offset = xOffset
      }
      let nextNodes = state.nodes
      if (nodeUpdates && nodeUpdates.length > 0) {
        const xById = new Map(nodeUpdates.map((u) => [u.id, u.x]))
        nextNodes = state.nodes.map((n) => {
          const newX = xById.get(n.id)
          if (newX === undefined) return n
          return { ...n, position: { ...(n.position || {}), x: newX } }
        })
      }
      return {
        story: nextStory,
        nodes: nextNodes,
        hasUnsavedChanges: true,
      }
    })
  },

  /** Move a chapter to a new index in `chapters[]`. Any act whose
   *  `chapter_ids` contained the moved chapter has its list pruned by
   *  `_pruneActContiguity` against the new order — the longest contiguous
   *  run is kept; chapters past the first gap are dropped. Acts whose
   *  `chapter_ids` becomes empty are removed. */
  reorderChapter: (chapterId, newIndex) => {
    const { story } = get()
    if (!story) return
    const chapters = [...(story.chapters || [])]
    const fromIndex = chapters.findIndex((c) => c.id === chapterId)
    if (fromIndex === -1) return
    const clampedIndex = Math.max(0, Math.min(chapters.length - 1, newIndex))
    if (fromIndex === clampedIndex) return
    get()._snapshot()
    const [moved] = chapters.splice(fromIndex, 1)
    chapters.splice(clampedIndex, 0, moved)
    const acts = (story.acts || [])
      .map((act) => ({
        ...act,
        chapter_ids: _pruneActContiguity(act.chapter_ids, chapters),
      }))
      .filter((act) => act.chapter_ids.length > 0)
    set({ story: { ...story, chapters, acts }, hasUnsavedChanges: true })
  },

  /** Create a new act spanning the given chapters. The input `chapterIds` are
   *  re-sorted into chapters[] order and truncated to the longest contiguous
   *  run via `_pruneActContiguity`, so callers can pass an arbitrary set of
   *  ids from a drag-select and get a clean result. Returns the new act's id.
   *  No-op if no valid contiguous run can be formed. */
  addAct: (chapterIds) => {
    const { story } = get()
    if (!story) return null
    const contiguous = _pruneActContiguity(chapterIds || [], story.chapters || [])
    if (contiguous.length === 0) return null
    get()._snapshot()
    const id = crypto.randomUUID()
    const newAct = { id, title: '', colour: null, chapter_ids: contiguous }
    set({
      story: { ...story, acts: [...(story.acts || []), newAct] },
      hasUnsavedChanges: true,
    })
    return id
  },

  /** Remove an act from `acts[]`. Chapters are unaffected. */
  deleteAct: (actId) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const acts = (story.acts || []).filter((a) => a.id !== actId)
    set({ story: { ...story, acts }, hasUnsavedChanges: true })
  },

  /** Rename an act. Empty string is valid. */
  renameAct: (actId, title) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const acts = (story.acts || []).map((a) =>
      a.id === actId ? { ...a, title } : a
    )
    set({ story: { ...story, acts }, hasUnsavedChanges: true })
  },

  /** Set an act's colour. null = default act tint. */
  setActColour: (actId, colour) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const acts = (story.acts || []).map((a) =>
      a.id === actId ? { ...a, colour } : a
    )
    set({ story: { ...story, acts }, hasUnsavedChanges: true })
  },

  /** Set an act's title and colour atomically in a single snapshot, so
   *  one in-place act editor commit produces exactly one undo step even
   *  when both fields changed. Mirrors `setChapterTitleAndColour` for the
   *  Track D act row editor. Empty title is valid and reverts the act to
   *  the "Untitled act" display. */
  setActTitleAndColour: (actId, title, colour) => {
    const { story } = get()
    if (!story) return
    get()._snapshot()
    const acts = (story.acts || []).map((a) =>
      a.id === actId ? { ...a, title, colour } : a
    )
    set({ story: { ...story, acts }, hasUnsavedChanges: true })
  },

  /** Set an act's contiguous chapter range by specifying the leftmost and
   *  rightmost chapter ids (inclusive). Used by the drag-to-resize-act UX in
   *  Track D. If either endpoint is missing from `chapters[]` the action is a
   *  no-op. The resulting `chapter_ids` is the sequence of chapters from the
   *  leftmost to the rightmost in `chapters[]` order, regardless of which
   *  endpoint was passed as "left" vs "right" (the caller doesn't need to
   *  know). Like `setChapterWidth`, this is a commit action — the UI should
   *  dispatch it on mouseup at the end of an act-edge drag, not per-pixel. */
  setActRange: (actId, leftChapterId, rightChapterId) => {
    const { story } = get()
    if (!story) return
    const chapters = story.chapters || []
    const leftIdx = chapters.findIndex((c) => c.id === leftChapterId)
    const rightIdx = chapters.findIndex((c) => c.id === rightChapterId)
    if (leftIdx === -1 || rightIdx === -1) return
    get()._snapshot()
    const [lo, hi] = leftIdx <= rightIdx ? [leftIdx, rightIdx] : [rightIdx, leftIdx]
    const range = chapters.slice(lo, hi + 1).map((c) => c.id)
    const acts = (story.acts || []).map((a) =>
      a.id === actId ? { ...a, chapter_ids: range } : a
    )
    set({ story: { ...story, acts }, hasUnsavedChanges: true })
  },

  /** Atomically resize TWO adjacent acts by specifying the new pivot
   *  chapter at their shared boundary. The `leftAct` keeps everything
   *  from its current leftmost chapter through `pivotChapterId`
   *  (inclusive); the `rightAct` becomes everything from the chapter
   *  immediately after `pivotChapterId` in `chapters[]` order through its
   *  current rightmost chapter (inclusive).
   *
   *  Used by the drag-to-resize-shared-act-boundary UX in Track D, where
   *  two adjacent acts share a single drag handle and dragging it moves
   *  the boundary between them — the left act grows / shrinks while the
   *  right act shrinks / grows in lockstep, so no gap or overlap can ever
   *  form between them.
   *
   *  Both acts must keep at least one chapter — if the pivot lands
   *  outside the original spanning range (left of leftAct's leftmost or
   *  right of (rightAct's rightmost − 1)) the action is a no-op. Single
   *  `_snapshot()` per call so one drag = one undo step regardless of
   *  which two acts moved. */
  setAdjacentActBoundary: (leftActId, rightActId, pivotChapterId) => {
    const { story } = get()
    if (!story) return
    const chapters = story.chapters || []
    const acts = story.acts || []
    const leftAct = acts.find((a) => a.id === leftActId)
    const rightAct = acts.find((a) => a.id === rightActId)
    if (!leftAct || !rightAct) return
    const leftActLeftIdx = chapters.findIndex((c) => c.id === leftAct.chapter_ids[0])
    const leftActRightIdx = chapters.findIndex((c) => c.id === leftAct.chapter_ids[leftAct.chapter_ids.length - 1])
    const rightActLeftIdx = chapters.findIndex((c) => c.id === rightAct.chapter_ids[0])
    const rightActRightIdx = chapters.findIndex((c) => c.id === rightAct.chapter_ids[rightAct.chapter_ids.length - 1])
    const pivotIdx = chapters.findIndex((c) => c.id === pivotChapterId)
    if (leftActLeftIdx === -1 || leftActRightIdx === -1 || rightActLeftIdx === -1 || rightActRightIdx === -1 || pivotIdx === -1) return
    // Pivot must keep both acts at least 1 chapter wide. Acts must also
    // remain contiguous within their original spanning range — the union
    // of leftAct + rightAct currently spans [leftActLeftIdx, rightActRightIdx]
    // and the pivot must land somewhere in that span (excluding the very
    // last position so rightAct keeps ≥ 1 chapter).
    if (pivotIdx < leftActLeftIdx || pivotIdx >= rightActRightIdx) return
    get()._snapshot()
    const newLeftActIds = chapters.slice(leftActLeftIdx, pivotIdx + 1).map((c) => c.id)
    const newRightActIds = chapters.slice(pivotIdx + 1, rightActRightIdx + 1).map((c) => c.id)
    const nextActs = acts.map((a) => {
      if (a.id === leftActId) return { ...a, chapter_ids: newLeftActIds }
      if (a.id === rightActId) return { ...a, chapter_ids: newRightActIds }
      return a
    })
    set({ story: { ...story, acts: nextActs }, hasUnsavedChanges: true })
  },

  // ── Undo / Redo ──────────────────────────────────────────────────────────────

  /** Capture current {nodes, edges} plus story-level chapter/act state as an
   *  undo snapshot, then clear the redo stack. Every snapshot carries a
   *  `_storyBefore: { chapters, acts }` field so that undo/redo can restore
   *  chapter rename / colour / width / add / delete / reorder operations and
   *  the matching act operations. All chapter/act mutation actions in
   *  `projectStore` call this before mutating. */
  /** Patch the most recent history entry with additional extras (used
   *  by actions that need to record post-action state for redo, e.g.
   *  awareness-history edits where the post-state isn't reachable from
   *  pre-state without re-running the action). No-op if history is empty. */
  _patchLastHistoryWithExtras: (extras) => {
    const { history } = get()
    if (!history || history.length === 0 || !extras) return
    const last = history[history.length - 1]
    set({ history: [...history.slice(0, -1), { ...last, ...extras }] })
  },

  _snapshot: (extra) => {
    // Batch convert takes one snapshot up front then suppresses the per-item
    // ones so the whole batch is a single undo step.
    if (_snapshotSuppressed) return
    const { nodes, edges, story, history, relationships, knowledges } = get()
    const _storyBefore = story
      ? { chapters: story.chapters || [], acts: story.acts || [] }
      : null
    // Phase 3.4 Bugs & Fixes — capture the Project Tag pool so the
    // orphan-tag inline cleanup (`_maybeCleanupOrphanedTagInline`)
    // rides on the SAME undo entry as the originating tag-detach
    // action. Without this, splicing a pool entry from
    // `entitiesStore.projectTags` mid-record-action would survive
    // Ctrl-Z (because the projectStore undo only touches projectStore
    // state). The capture is cheap — Zustand state is shared by
    // reference until mutated.
    const _projectTagsBefore = useEntitiesStore.getState().projectTags ?? null
    set({
      history: [
        ...history,
        {
          nodes,
          edges,
          _storyBefore,
          _relationshipsBefore: relationships,
          _knowledgesBefore: knowledges,
          _projectTagsBefore,
          ...extra,
        },
      ].slice(-50),
      future: [],
      hasUnsavedChanges: true,
    })
  },

  undo: () => {
    const { history, future, nodes, edges, story, relationships, knowledges } = get()
    if (history.length === 0) return
    const prev = history[history.length - 1]
    // Capture the current (post-action, pre-undo) state for the redo stack,
    // including the current story-level chapter/act state.
    const currentStoryState = story
      ? { chapters: story.chapters || [], acts: story.acts || [] }
      : null
    // Phase 8.4 (Convert To) — capture the current POV-default + entitiesStore
    // bucket state for the redo stack when the undone action carried those
    // extras (a type convert moves an entity between buckets and can clear the
    // story-default POV, neither of which the standard snapshot covers).
    const currentPovForRedo = story ? (story.pov_character_id ?? null) : null
    const currentBucketsForRedo = prev._entitiesBucketsBefore !== undefined
      ? _captureEntityBuckets()
      : undefined
    // If prev has a stored story snapshot, restore chapters/acts from it.
    // Otherwise leave story alone (defensive, for any snapshot taken before
    // this feature landed within the current session).
    let restoredStory = (story && prev._storyBefore)
      ? { ...story, chapters: prev._storyBefore.chapters, acts: prev._storyBefore.acts }
      : story
    if (story && prev._storyPovBefore !== undefined) {
      restoredStory = { ...restoredStory, pov_character_id: prev._storyPovBefore }
    }
    const restoredRels = prev._relationshipsBefore ?? relationships
    const restoredKnowledges = prev._knowledgesBefore ?? knowledges
    const { byEntity: relsByEntity, byScene: relsByScene } = _buildRelIndexes(restoredRels)
    // Phase 3.4 Bugs & Fixes — restore Project Tag pool if the
    // snapshot captured it (orphan-cleanup undo path). Captured into
    // a local for the redo future-state via `currentProjectTags` so
    // the inverse direction also restores correctly.
    const currentProjectTags = useEntitiesStore.getState().projectTags ?? null
    if (prev._projectTagsBefore !== undefined) {
      useEntitiesStore.setState({ projectTags: prev._projectTagsBefore ?? [] })
    }
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      story: restoredStory,
      relationships: restoredRels,
      relationshipsByEntity: relsByEntity,
      relationshipsByScene: relsByScene,
      knowledges: restoredKnowledges,
      history: history.slice(0, -1),
      future: [
        {
          nodes,
          edges,
          _storyBefore: currentStoryState,
          _relationshipsBefore: relationships,
          _knowledgesBefore: knowledges,
          _projectTagsBefore: currentProjectTags,
          ...(prev._entityRestore ? { _entityRestore: prev._entityRestore } : {}),
          ...(prev._entityCreated ? { _entityCreated: prev._entityCreated } : {}),
          ...(prev._relationshipRestore ? { _relationshipRestore: prev._relationshipRestore } : {}),
          ...(prev._knowledgeRestore ? { _knowledgeRestore: prev._knowledgeRestore } : {}),
          ...(prev._entityDataRestore ? { _entityDataRestore: prev._entityDataRestore } : {}),
          ...(prev._entityDataAfter ? { _entityDataAfter: prev._entityDataAfter } : {}),
          ...(prev._sweptEntityRefId ? { _sweptEntityRefId: prev._sweptEntityRefId } : {}),
          ...(prev._sweptRelationshipRefId ? { _sweptRelationshipRefId: prev._sweptRelationshipRefId } : {}),
          ...(prev._presetListRestore ? { _presetListRestore: prev._presetListRestore } : {}),
          ...(prev._sweptPresetListId ? { _sweptPresetListId: prev._sweptPresetListId } : {}),
          ...(prev._customCategoryRestore ? { _customCategoryRestore: prev._customCategoryRestore } : {}),
          ...(prev._sweptCustomCategoryId ? { _sweptCustomCategoryId: prev._sweptCustomCategoryId } : {}),
          ...(prev._programTagRestore ? { _programTagRestore: prev._programTagRestore } : {}),
          ...(prev._storyPovBefore !== undefined ? { _storyPovBefore: currentPovForRedo } : {}),
          ...(prev._entitiesBucketsBefore !== undefined ? { _entitiesBucketsBefore: currentBucketsForRedo } : {}),
        },
        ...future,
      ].slice(0, 50),
      hasUnsavedChanges: true,
    })
    // Phase 8.4 (Convert To) — restore the entitiesStore buckets a type convert
    // moved (the moved entity's bucket + reparented location children +
    // perspective-kind rewrites on other entities), all captured by reference.
    if (prev._entitiesBucketsBefore !== undefined) {
      useEntitiesStore.setState(prev._entitiesBucketsBefore)
    }
    // Restore entities that were purged (if any) — see purgeEntity
    if (prev._entityRestore) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of prev._entityRestore) {
        const { _bucket, ...entityData } = snapshot
        // Re-add the deleted entity to its bucket
        entStore._restoreEntity(_bucket, entityData)
      }
    }
    // Revert cross-entity sweep mutations (parent_id clears, entity_list value strips)
    // on OTHER entities that were modified during the purge's reference cleanup.
    if (prev._entityDataRestore) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of prev._entityDataRestore) {
        const { _bucket, ...entityData } = snapshot
        entStore._restoreEntityData(_bucket, entityData)
      }
    }
    // Undo of an "entity created" action: remove the entity from the
    // library (local + backend) so undo symmetrically reverses the
    // creation. Redo will re-add.
    // (passes _entityDataAfter through to the future stack via the
    //  spread above so redo can restore post-action state)
    if (prev._entityCreated) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of prev._entityCreated) {
        const { _bucket } = snapshot
        entStore._removeEntity(_bucket, snapshot.id)
        axios.delete(`/api/entities/${snapshot.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    // Undo of a relationship deletion: the local relationships array is already
    // restored (via _relationshipsBefore), but the backend row is still gone.
    // Re-POST so subsequent PUT/DELETE on this relationship don't 404.
    if (prev._relationshipRestore) {
      for (const rel of prev._relationshipRestore) {
        axios.post('/api/relationships/', rel).catch(() => { /* fire-and-forget */ })
      }
    }
    // Undo of a Knowledge deletion: mirror of relationship handling.
    // Local knowledges array is already restored via _knowledgesBefore;
    // the backend row is still gone, so re-POST it.
    if (prev._knowledgeRestore) {
      for (const kn of prev._knowledgeRestore) {
        axios.post('/api/knowledges/', kn).catch(() => { /* fire-and-forget */ })
      }
    }
    // Undo of a preset list deletion: local list is gone from entitiesStore, and
    // backend row was deleted. Re-add locally and re-POST so subsequent
    // PUT/DELETE on this list don't 404. Entity attribute `preset_list_id`
    // reference restores are handled above via `_entityDataRestore`; relationship
    // participant_role restores are handled via `_relationshipsBefore`.
    if (prev._presetListRestore) {
      const entStore = useEntitiesStore.getState()
      for (const list of prev._presetListRestore) {
        entStore._restorePresetList(list)
        axios.post('/api/preset-lists/', list).catch(() => { /* fire-and-forget */ })
      }
    }
    // Undo of a custom category deletion: mirror of preset list handling.
    // Custom entity `category_id` restores are handled via `_entityDataRestore`.
    if (prev._customCategoryRestore) {
      const entStore = useEntitiesStore.getState()
      for (const cat of prev._customCategoryRestore) {
        entStore._restoreCustomCategory(cat)
        axios.post('/api/custom-categories/', cat).catch(() => { /* fire-and-forget */ })
      }
    }
    // Undo of a Program Tag deletion: re-PUT the colour-map entry (if
    // one was set pre-delete) and re-PUT each affected host's `tags`
    // list. Local-store re-add runs first so the UI reflects the
    // restore immediately; the axios calls are fire-and-forget so an
    // offline backend doesn't block the undo path (matches the
    // relationship / knowledge / preset-list undo shape).
    if (prev._programTagRestore) {
      const cuesStore = useContextCuesStore.getState()
      const convStore = useConversationsStore.getState()
      for (const restore of prev._programTagRestore) {
        const { name, color, affectedCues = [], affectedConvs = [] } = restore
        // Colour map re-PUT.
        if (color && typeof color === 'string') {
          axios.put(
            `/api/program-tags/${encodeURIComponent(name)}/color`,
            { color },
          ).catch(() => { /* fire-and-forget */ })
        }
        // Context Cues — restore the local `tags` array on each cue +
        // re-PUT the full cue body via the per-id endpoint that
        // shipped in v0.3.4.9.
        if (affectedCues.length > 0) {
          const byId = new Map(affectedCues.map((c) => [c.id, c.tags]))
          const nextCues = (cuesStore.cues || []).map((c) => (
            byId.has(c.id) ? { ...c, tags: [...byId.get(c.id)] } : c
          ))
          useContextCuesStore.setState({ cues: nextCues })
          for (const c of nextCues) {
            if (!byId.has(c.id)) continue
            axios.put(`/api/ai-context-cues/${c.id}`, c).catch(() => { /* fire-and-forget */ })
          }
        }
        // Conversations — restore the index + byId `tags` arrays + re-
        // PUT via the existing per-thread endpoint.
        if (affectedConvs.length > 0) {
          const byId = new Map(affectedConvs.map((c) => [c.id, c.tags]))
          const nextIndex = (convStore.index || []).map((e) => (
            byId.has(e.id) ? { ...e, tags: [...byId.get(e.id)] } : e
          ))
          const nextById = { ...(convStore.byId || {}) }
          for (const [id, tags] of byId.entries()) {
            const cached = nextById[id]
            if (cached) nextById[id] = { ...cached, tags: [...tags] }
          }
          useConversationsStore.setState({ index: nextIndex, byId: nextById })
          for (const [id, tags] of byId.entries()) {
            axios.put(`/api/conversations/${id}`, { tags }).catch(() => { /* fire-and-forget */ })
          }
        }
      }
    }
  },

  redo: () => {
    const { history, future, nodes, edges, story, relationships, knowledges } = get()
    if (future.length === 0) return
    const next = future[0]
    const currentStoryState = story
      ? { chapters: story.chapters || [], acts: story.acts || [] }
      : null
    // Phase 8.4 (Convert To) — mirror undo: capture the current POV-default +
    // entitiesStore buckets for the history (undo) stack, and restore them from
    // the redone entry below.
    const currentPovForUndo = story ? (story.pov_character_id ?? null) : null
    const currentBucketsForUndo = next._entitiesBucketsBefore !== undefined
      ? _captureEntityBuckets()
      : undefined
    let restoredStory = (story && next._storyBefore)
      ? { ...story, chapters: next._storyBefore.chapters, acts: next._storyBefore.acts }
      : story
    if (story && next._storyPovBefore !== undefined) {
      restoredStory = { ...restoredStory, pov_character_id: next._storyPovBefore }
    }
    const restoredRels = next._relationshipsBefore ?? relationships
    const restoredKnowledges = next._knowledgesBefore ?? knowledges
    const { byEntity: relsByEntity, byScene: relsByScene } = _buildRelIndexes(restoredRels)
    // Phase 3.4 Bugs & Fixes — mirror the undo path's projectTags
    // restore.
    const currentProjectTags = useEntitiesStore.getState().projectTags ?? null
    if (next._projectTagsBefore !== undefined) {
      useEntitiesStore.setState({ projectTags: next._projectTagsBefore ?? [] })
    }
    set({
      nodes: next.nodes,
      edges: next.edges,
      story: restoredStory,
      relationships: restoredRels,
      relationshipsByEntity: relsByEntity,
      relationshipsByScene: relsByScene,
      knowledges: restoredKnowledges,
      history: [
        ...history,
        {
          nodes,
          edges,
          _storyBefore: currentStoryState,
          _relationshipsBefore: relationships,
          _knowledgesBefore: knowledges,
          _projectTagsBefore: currentProjectTags,
          ...(next._entityRestore ? { _entityRestore: next._entityRestore } : {}),
          ...(next._entityCreated ? { _entityCreated: next._entityCreated } : {}),
          ...(next._relationshipRestore ? { _relationshipRestore: next._relationshipRestore } : {}),
          ...(next._knowledgeRestore ? { _knowledgeRestore: next._knowledgeRestore } : {}),
          ...(next._entityDataRestore ? { _entityDataRestore: next._entityDataRestore } : {}),
          ...(next._entityDataAfter ? { _entityDataAfter: next._entityDataAfter } : {}),
          ...(next._sweptEntityRefId ? { _sweptEntityRefId: next._sweptEntityRefId } : {}),
          ...(next._sweptRelationshipRefId ? { _sweptRelationshipRefId: next._sweptRelationshipRefId } : {}),
          ...(next._presetListRestore ? { _presetListRestore: next._presetListRestore } : {}),
          ...(next._sweptPresetListId ? { _sweptPresetListId: next._sweptPresetListId } : {}),
          ...(next._customCategoryRestore ? { _customCategoryRestore: next._customCategoryRestore } : {}),
          ...(next._sweptCustomCategoryId ? { _sweptCustomCategoryId: next._sweptCustomCategoryId } : {}),
          ...(next._programTagRestore ? { _programTagRestore: next._programTagRestore } : {}),
          ...(next._storyPovBefore !== undefined ? { _storyPovBefore: currentPovForUndo } : {}),
          ...(next._entitiesBucketsBefore !== undefined ? { _entitiesBucketsBefore: currentBucketsForUndo } : {}),
        },
      ].slice(-50),
      future: future.slice(1),
      hasUnsavedChanges: true,
    })
    // Phase 8.4 (Convert To) — re-apply the entitiesStore bucket state the
    // redone type convert produced (mirror of the undo restore).
    if (next._entitiesBucketsBefore !== undefined) {
      useEntitiesStore.setState(next._entitiesBucketsBefore)
    }
    // Re-apply post-action entity data for awareness / chain edits on
    // entity hosts. `_entityDataAfter` carries the post-mutation entity
    // snapshots; restore them in place via `_restoreEntityData`.
    if (next._entityDataAfter) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of next._entityDataAfter) {
        const { _bucket, ...entityData } = snapshot
        entStore._restoreEntityData(_bucket, entityData)
      }
    }
    // Re-purge entities if the redone-past snapshot had entity restore data
    // (The nodes/edges from the redo snapshot already reflect the purge;
    //  we just need to re-delete from the entity store.)
    // Uses local-only _removeEntity — no API call, persisted on next save.
    if (next._entityRestore) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of next._entityRestore) {
        const { _bucket, ...entityData } = snapshot
        entStore._removeEntity(_bucket, entityData.id)
      }
    }
    // Re-apply the cross-entity sweep that the redone purge would have done.
    // The sweep is idempotent given the current state (undo restored the
    // pre-sweep entity data; redo re-mutates it).
    if (next._sweptEntityRefId) {
      useEntitiesStore.getState()._sweepStaleEntityReferencesFromEntities(next._sweptEntityRefId)
    }
    if (next._sweptRelationshipRefId) {
      useEntitiesStore.getState()._sweepStaleRelationshipReferencesFromEntities(next._sweptRelationshipRefId)
    }
    // Redo of an "entity created" action: re-add the entity to the
    // library (local + backend). Undo had removed it.
    if (next._entityCreated) {
      const entStore = useEntitiesStore.getState()
      for (const snapshot of next._entityCreated) {
        const { _bucket, ...entityData } = snapshot
        entStore._restoreEntity(_bucket, entityData)
        axios.post('/api/entities/', entityData).catch(() => { /* fire-and-forget */ })
      }
    }
    // Redo of a relationship deletion: undo had POSTed it back to the backend,
    // so redo needs to DELETE it again to keep the backend in sync with local state.
    if (next._relationshipRestore) {
      for (const rel of next._relationshipRestore) {
        axios.delete(`/api/relationships/${rel.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    // Redo of a Knowledge deletion: mirror of relationship handling.
    // Undo had POSTed it back, so redo re-DELETEs.
    if (next._knowledgeRestore) {
      for (const kn of next._knowledgeRestore) {
        axios.delete(`/api/knowledges/${kn.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    // Redo of a preset list deletion: remove from entitiesStore locally, DELETE
    // from backend, and re-run the entity attribute sweep (the
    // `_entityDataRestore` undid the attribute clears; redo re-applies them).
    // Relationship participant_role sweep does NOT need re-running here — the
    // post-delete relationships state is already captured in
    // `_relationshipsBefore` and restored above.
    if (next._presetListRestore) {
      const entStore = useEntitiesStore.getState()
      for (const list of next._presetListRestore) {
        entStore._removePresetList(list.id)
        axios.delete(`/api/preset-lists/${list.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    if (next._sweptPresetListId) {
      useEntitiesStore.getState()._sweepStalePresetListRefsFromAttributes(next._sweptPresetListId)
    }
    // Redo of a custom category deletion: mirror of preset list handling.
    if (next._customCategoryRestore) {
      const entStore = useEntitiesStore.getState()
      for (const cat of next._customCategoryRestore) {
        entStore._removeCustomCategory(cat.id)
        axios.delete(`/api/custom-categories/${cat.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    if (next._sweptCustomCategoryId) {
      useEntitiesStore.getState()._sweepStaleCustomCategoryRefsFromEntities(next._sweptCustomCategoryId)
    }
    // Redo of a Program Tag deletion: undo had re-PUT the colour-map
    // entry + each affected host's tags, so redo needs to re-fire the
    // backend cascade-DELETE and re-strip the local stores. The
    // backend handles the full host-walk + colour-map removal in one
    // call (matches the original delete path), then the local strip
    // brings cuesStore + conversationsStore in line with disk.
    if (next._programTagRestore) {
      for (const restore of next._programTagRestore) {
        const { name } = restore
        axios.delete(`/api/program-tags/${encodeURIComponent(name)}`)
          .catch(() => { /* fire-and-forget */ })
        _stripReferencesToProgramTag(name)
      }
    }
  },

  // ── Canvas node / edge management ────────────────────────────────────────────

  /** Add an entity node to the canvas (called after entity creation).
   *  Optional `position` overrides the default random placement.
   *
   *  When the caller has JUST created the entity via the API and wants
   *  the undo/redo pair to treat the library add + canvas add as a
   *  single atomic action, pass `options.createdEntity`. Undo will then
   *  also remove the entity from the library (and the backend); redo
   *  re-adds it. When omitted, only the canvas node is undoable — use
   *  this for reuse paths (drag existing entity onto canvas, context
   *  menu reuse, etc.) where the entity already existed. */
  addEntityNodeToCanvas: (entityNode, position, options = {}) => {
    const { createdEntity, zIndex } = options
    const snapshotExtra = createdEntity
      ? { _entityCreated: [{ ...createdEntity, _bucket: createdEntity.type + 's' }] }
      : undefined
    get()._snapshot(snapshotExtra)
    const viewportCenter = useUiStore.getState()._getViewportCenter?.()
    const pos = applyCreationPositionSnap(
      position || viewportCenter || { x: 80 + Math.random() * 350, y: 80 + Math.random() * 350 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id: entityNode.id,
          type: 'entityNode',
          position: pos,
          ...(zIndex != null ? { zIndex } : {}),
          data: { ...entityNode },
        },
      ],
      hasUnsavedChanges: true,
    })
  },

  /** Place a blank modifier entity node at the given position.
   *  entity_id starts as null — assigned when an entity is wired into the node's input. */
  addModifierEntityNode: (position, entityId) => {
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 80 + Math.random() * 350, y: 80 + Math.random() * 350 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'entityNode',
          position: pos,
          data: {
            id,          // must match the React Flow node ID so buildStoryPayload serialises correctly
            node_type: 'entity',
            entity_id: entityId || null,
            is_modifier: true,
            name_change: null,
            colour_change: null,
            description_change: null,
            profile_image_change: null,
            attribute_changes: [],
          },
        },
      ],
      hasUnsavedChanges: true,
    })
  },

  /** Remove an entity node from the canvas (called after entity deletion). */
  removeEntityNodeFromCanvas: (entityId) => {
    get()._snapshot()
    set({ nodes: get().nodes.filter((n) => !(n.type === 'entityNode' && n.data.entity_id === entityId)) })
  },

  /** Count how many plot point nodes contain a chip for the given entity. */
  countEntityChips: (entityId) => {
    const { nodes } = get()
    return nodes.filter((n) => {
      if (n.type !== 'sceneNode') return false
      return ENTITY_BUCKETS.some((b) => (n.data[b] || []).some((r) => r.entity_id === entityId))
    }).length
  },

  // ── DELETE dispatcher ──────────────────────────────────────────────────────
  //
  // Single entry point for DELETE operations — erasure of a first-class object
  // from the story. The object's id is no longer valid anywhere after this runs.
  //
  // DELETE vs REMOVE:
  //   DELETE = erasure from the story (this dispatcher).
  //   REMOVE = context-scoped mutation; the object remains. `removeParticipant`,
  //            `removeRelationshipChange`, scene-level chip removal, etc. keep their
  //            own action names and never route through here. If a REMOVE action
  //            orphans an object (e.g. empties a relationship), it calls
  //            `deleteObject('relationship', id)` — an explicit cascade, not inline.
  //
  // Current shape is a skeleton that forwards to the existing per-type actions.
  // Internal consolidation (per-type handlers + shared `_stripReferencesTo<X>`
  // scan primitives) lands in follow-up phases of the refactor.
  //
  // Deletable types: 'entity', 'relationship', 'node', 'presetList',
  // 'customCategory'. Attribute / chapter / act come later.
  deleteObject: async (type, id) => {
    let result
    switch (type) {
      case 'entity':         result = await get()._deleteEntityInternal(id); break
      case 'relationship':   result = await get()._deleteRelationshipInternal(id); break
      case 'knowledge':      result = await get()._deleteKnowledgeInternal(id); break
      case 'node':           result = await get()._deleteNodeInternal(id); break
      case 'presetList':     result = await get()._deletePresetListInternal(id); break
      case 'customCategory': result = await get()._deleteCustomCategoryInternal(id); break
      case 'projectTag':     return get()._deleteProjectTagInternal(id)
      case 'programTag':     return get()._deleteProgramTagInternal(id)
      default:
        console.warn(`[deleteObject] unknown type: ${type}`)
        return
    }
    // Phase 3.4 Bugs & Fixes — host-deletion cascade-strip cleanup.
    // When an entity / knowledge / relationship / node / presetList /
    // customCategory deletion strips its tag references, any tag
    // whose host count just dropped to 0 needs its pool entry
    // removed. We don't track WHICH tags lost a carrier on the way
    // through the strip primitives — sweep every pool entry instead.
    // Each entry's gate check is fast (`countHostsForTag` short-
    // circuits as soon as it finds the first carrier). The cleanup
    // rides on the same `_snapshot()` the per-type internal handler
    // took, so Ctrl-Z restores host + every cascaded pool entry. Skip
    // for the pool-type cases above since those already manage their
    // own pool state.
    const pool = useEntitiesStore.getState().projectTags || []
    for (const t of pool) {
      get()._maybeCleanupOrphanedTagInline(t.id)
    }
    return result
  },

  /**
   * Internal per-type DELETE handler for relationships. Do not call directly —
   * go through `deleteObject('relationship', id)`. Takes snapshot with
   * `_relationshipRestore` for undo's backend re-POST, fires backend DELETE,
   * applies the relationship strip primitive, rebuilds indexes.
   */
  /** Strip every reference TO the given preset-list id FROM relationship participant
   *  roles. Called by `entitiesStore.deletePresetList` as part of the cross-store
   *  DELETE cascade. Clears `preset_list_id` on matching ParticipantRole entries
   *  while preserving the `value` string as free-form role text. Local-only —
   *  save-time `PUT /story` syncs backend. */
  _sweepStalePresetListRefsFromRelationships: (listId) => {
    const current = get().relationships
    let changed = false
    const next = current.map((rel) => {
      const origRoles = rel.participant_roles
      if (!origRoles) return rel
      let rolesChanged = false
      const newRoles = {}
      for (const [entId, role] of Object.entries(origRoles)) {
        if (role && role.preset_list_id === listId) {
          newRoles[entId] = { ...role, preset_list_id: null }
          rolesChanged = true
        } else {
          newRoles[entId] = role
        }
      }
      if (rolesChanged) {
        changed = true
        return { ...rel, participant_roles: newRoles }
      }
      return rel
    })
    if (changed) {
      const { byEntity, byScene } = _buildRelIndexes(next)
      set({ relationships: next, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    }
  },

  _deleteRelationshipInternal: async (relId) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    // A faction's membership relationship is owned by the faction's
    // existence. Refuse to delete it directly. The membership rel only
    // goes away when the faction itself is deleted (handled by the
    // faction's own delete cascade). Also blocks the auto-cascade from
    // `removeParticipant` when the membership rel hits zero members —
    // an empty membership is valid (a faction can exist with no members).
    if (rel.membership_of) {
       
      console.warn(`[deleteRelationship] refused: ${relId} is the membership relationship for entity ${rel.membership_of}; delete the faction itself instead.`)
      return rel
    }
    // Phase 1.21 — capture pre-sweep snapshots of any entity whose entity /
    // attribute / alias awareness is an `AwarenessRef` pointing at this
    // relationship. The cross-store sweep below nulls those fields; undo
    // must restore them.
    const es = useEntitiesStore.getState()
    const refsDeletedRel = (aw) =>
      !!aw && typeof aw === 'object' &&
      'relationship_id' in aw && 'level' in aw &&
      aw.relationship_id === relId
    const entitiesToRestore = []
    for (const bucket of ENTITY_BUCKETS) {
      for (const e of (es[bucket] || [])) {
        const attrHit = (e.attributes || []).some((a) => refsDeletedRel(a.awareness))
        const aliasHit = (e.aliases || []).some((al) => refsDeletedRel(al.awareness))
        // Phase 2.13 — perspective host whose target is the deleted relationship.
        const perspectiveHit = (e.attributes || []).some((a) =>
          a.attribute_type === 'perspective' &&
          a.perspective_target_kind === 'relationship' &&
          a.perspective_target_id === relId
        )
        if (refsDeletedRel(e.awareness) || attrHit || aliasHit || perspectiveHit) {
          entitiesToRestore.push({ ...e, _bucket: bucket })
        }
      }
    }
    get()._snapshot({
      _relationshipRestore: [rel],
      ...(entitiesToRestore.length > 0 ? {
        _entityDataRestore: entitiesToRestore,
        _sweptRelationshipRefId: relId,
      } : {}),
    })
    await axios.delete(`/api/relationships/${relId}`)
    const patch = _stripReferencesToRelationship(get(), relId)
    const { byEntity, byScene } = _buildRelIndexes(patch.relationships)
    set({ ...patch, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    if (entitiesToRestore.length > 0) {
      es._sweepStaleRelationshipReferencesFromEntities(relId)
      es._sweepStalePerspectiveTargetsFromEntities(_PERSPECTIVE_RELATIONSHIP_KINDS, relId)
    }
  },

  /**
   * Internal per-type DELETE handler for entities. Do not call directly —
   * go through `deleteObject('entity', id)`. Takes snapshot with `_entityRestore`
   * so undo can put the entity back in its library bucket; applies the entity
   * strip primitive; removes from the entitiesStore bucket; clears the detail
   * panel if it was showing this entity.
   */
  _deleteEntityInternal: (entityId) => {
    const es = useEntitiesStore.getState()
    const entity = es.getEntityById(entityId)
    if (!entity) return
    // Capture pre-sweep snapshots of OTHER entities that the cross-store sweep will
    // mutate (parent_id children, entity_list attribute holders, perspective hosts).
    // Stored in the snapshot extras as `_entityDataRestore` so undo can revert each
    // back to its pre-sweep state. Redo re-invokes the sweep via `_sweptEntityRefId`.
    const entitiesToRestore = []
    for (const bucket of ENTITY_BUCKETS) {
      for (const e of (es[bucket] || [])) {
        if (e.id === entityId) continue
        const hasParentRef = e.parent_id === entityId
        const hasEntityListRef = (e.attributes || []).some((a) =>
          a.attribute_type === 'entity_list' && parseListValue(a.value).includes(entityId)
        )
        // Phase 2.13 — perspective host whose target is the deleted entity.
        const hasPerspectiveTargetRef = (e.attributes || []).some((a) =>
          a.attribute_type === 'perspective' &&
          a.perspective_target_id === entityId &&
          _PERSPECTIVE_ENTITY_KINDS.has(a.perspective_target_kind)
        )
        if (hasParentRef || hasEntityListRef || hasPerspectiveTargetRef) {
          entitiesToRestore.push({ ...e, _bucket: bucket })
        }
      }
    }
    get()._snapshot({
      _entityRestore: [{ ...entity, _bucket: entity.type + 's' }],
      ...(entitiesToRestore.length > 0 ? {
        _entityDataRestore: entitiesToRestore,
        _sweptEntityRefId: entityId,
      } : {}),
    })
    const patch = _stripReferencesToEntity(get(), entityId)
    const { byEntity, byScene } = _buildRelIndexes(patch.relationships)
    set({ ...patch, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    // Cross-store cleanup: strip the deleted entity's id from other entities' parent_id
    // and entity_list attribute values; null perspective targets pointing at it.
    es._sweepStaleEntityReferencesFromEntities(entityId)
    es._sweepStalePerspectiveTargetsFromEntities(_PERSPECTIVE_ENTITY_KINDS, entityId)
    es._removeEntity(entity.type + 's', entityId)
    const uiStore = useUiStore.getState()
    if (uiStore.detailPanelEntityId === entityId) {
      uiStore.clearDetailPanel({ force: true })
    }
  },

  /**
   * Internal per-type DELETE handler for canvas nodes. Do not call directly —
   * go through `deleteObject('node', id)`. The confirm-dialog logic lives in
   * the public `deleteNode` wrapper (since it depends on node-type-specific
   * "has content" heuristics and user interaction); the internal handler just
   * does the deletion + reference-stripping assuming the decision was already
   * made. Local-state only — save-time `PUT /story` syncs backend.
   */
  _deleteNodeInternal: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node) return
    // Pre-compute the strip so we can learn which relationships (if any) will be
    // cascade-deleted by this node's removal. Those rel objects go into the
    // snapshot as `_relationshipRestore` so undo can axios.POST them back to the
    // backend and redo can axios.DELETE them again — symmetric with
    // `_deleteRelationshipInternal`'s handling of a direct rel delete. Without
    // this, cascade-deleted rel rows would linger on the backend until the next
    // save-time `PUT /story`, and undo could not restore them server-side.
    const patch = _stripReferencesToNode(get(), nodeId)
    const { _cascadeDeletedRels, ...statePatch } = patch
    get()._snapshot(
      (_cascadeDeletedRels && _cascadeDeletedRels.length > 0)
        ? { _relationshipRestore: _cascadeDeletedRels }
        : undefined
    )
    const { byEntity, byScene } = _buildRelIndexes(statePatch.relationships)
    set({ ...statePatch, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    // Issue backend DELETE for each cascade-deleted relationship so the backend
    // stays in sync with local state (matching `_deleteRelationshipInternal`).
    if (_cascadeDeletedRels && _cascadeDeletedRels.length > 0) {
      for (const rel of _cascadeDeletedRels) {
        axios.delete(`/api/relationships/${rel.id}`).catch(() => { /* fire-and-forget */ })
      }
    }
    const uiStore = useUiStore.getState()
    if (uiStore.detailPanelNodeId === nodeId) {
      uiStore.clearDetailPanel({ force: true })
    }
    // Phase 1.24c — auto-unpin the editor when its pinned scene is deleted,
    // so the editor reverts to following canvas selection.
    if (uiStore.editorPinnedSceneId === nodeId) {
      uiStore.clearEditorPinned()
    }
  },

  /**
   * Internal per-type DELETE handler for preset lists. Do not call directly —
   * go through `deleteObject('presetList', id)`. Takes snapshot with
   * `_presetListRestore` (so undo can re-POST the list to the backend + re-add
   * it locally, redo re-DELETEs + re-removes), and captures pre-sweep snapshots
   * of any entities whose `preset_list_id` attributes will be cleared as
   * `_entityDataRestore` (reusing the entity-delete pattern). Relationship
   * participant-role sweeps are covered by `_snapshot`'s automatic
   * `_relationshipsBefore` capture. Delegates actual deletion to
   * `entitiesStore.deletePresetList(id)`.
   */
  _deletePresetListInternal: async (listId) => {
    const es = useEntitiesStore.getState()
    const list = (es.presetLists || []).find((p) => p.id === listId)
    if (!list) return
    // Capture pre-sweep snapshots of entities whose attributes reference this
    // preset list. After the sweep runs inside entitiesStore.deletePresetList,
    // each such entity will have its matching attribute's `preset_list_id`
    // cleared — undo restores the pre-sweep state. Reuses the existing
    // `_entityDataRestore` extra (shape: { ..., _bucket } snapshots).
    const entitiesToRestore = []
    for (const bucket of ENTITY_BUCKETS) {
      for (const e of (es[bucket] || [])) {
        const hasRef = (e.attributes || []).some((a) => a.preset_list_id === listId)
        if (hasRef) entitiesToRestore.push({ ...e, _bucket: bucket })
      }
    }
    get()._snapshot({
      _presetListRestore: [list],
      ...(entitiesToRestore.length > 0 ? {
        _entityDataRestore: entitiesToRestore,
        _sweptPresetListId: listId,
      } : {}),
    })
    await es.deletePresetList(listId)
  },

  /**
   * Internal per-type DELETE handler for custom categories. Do not call
   * directly — go through `deleteObject('customCategory', id)`. Takes snapshot
   * with `_customCategoryRestore` (undo re-POSTs + re-adds; redo re-DELETEs +
   * re-removes), and captures pre-sweep snapshots of any custom entities whose
   * `category_id` points at this category (cleared to null by the sweep) as
   * `_entityDataRestore`. Delegates actual deletion to
   * `entitiesStore.deleteCustomCategory(id)`.
   */
  _deleteCustomCategoryInternal: async (catId) => {
    const es = useEntitiesStore.getState()
    const cat = (es.customCategories || []).find((c) => c.id === catId)
    if (!cat) return
    // Capture pre-sweep snapshots of custom entities pointing at this category.
    // After the sweep, each has `category_id` cleared to null — undo restores.
    const entitiesToRestore = []
    for (const e of (es.customs || [])) {
      if (e.category_id === catId) entitiesToRestore.push({ ...e, _bucket: 'customs' })
    }
    get()._snapshot({
      _customCategoryRestore: [cat],
      ...(entitiesToRestore.length > 0 ? {
        _entityDataRestore: entitiesToRestore,
        _sweptCustomCategoryId: catId,
      } : {}),
    })
    await es.deleteCustomCategory(catId)
  },

  /**
   * Phase 3.4b — Internal per-type DELETE handler for project tags. Do not
   * call directly — go through `deleteObject('projectTag', id)`. Takes a
   * snapshot with `_projectTagRestore` (undo re-POSTs to the backend + re-
   * adds to local state; redo re-DELETEs). Fires backend DELETE which
   * returns the affected host summary, then applies BOTH cascade-strip
   * primitives: `_stripReferencesToTag` for projectStore-owned state
   * (knowledges + relationships + scene EntityRefs + EntityNode modifier
   * tag_changes + ReferenceNode baseline) and
   * `entitiesStore._sweepStaleTagRefsFromEntitiesAndPresets` for
   * entitiesStore-owned state (every entity bucket's tag_ids + preset
   * lists' tag_ids). The deleted Tag itself is removed from
   * `entitiesStore.projectTags` after the strip.
   */
  _deleteProjectTagInternal: async (tagId) => {
    const es = useEntitiesStore.getState()
    const tag = (es.projectTags || []).find((t) => t.id === tagId)
    if (!tag) return
    get()._snapshot({
      _projectTagRestore: [tag],
    })
    // Optimistic local strip FIRST so the UI reacts immediately —
    // the snapshot above guarantees undo can restore if the backend
    // DELETE fails. Save-time `PUT /story` syncs.
    const patch = _stripReferencesToTag(get(), tagId)
    set({ ...patch, hasUnsavedChanges: true })
    es._sweepStaleTagRefsFromEntitiesAndPresets(tagId)
    useEntitiesStore.setState({
      projectTags: (useEntitiesStore.getState().projectTags || []).filter((t) => t.id !== tagId),
    })
    // Fire the backend DELETE in the background. 404 is fine (the
    // row was already gone). Other errors swallowed here keep undo
    // symmetric with `_deleteKnowledgeInternal`'s pattern; the local
    // strip stays applied.
    try {
      await axios.delete(`/api/project-tags/${tagId}`)
    } catch (err) {
      if (err?.response?.status !== 404) throw err
    }
  },

  /**
   * Phase 3.4c — Internal per-type DELETE handler for Program Tags. Do
   * not call directly — go through `deleteObject('programTag', name)`.
   *
   * Program Tags are the flat per-host string tag system on ContextCues
   * + Conversations. They have no chain semantics, no story-state
   * involvement, and no `.nnz` involvement. The backend
   * `DELETE /api/program-tags/{name}` endpoint walks both per-pool
   * indexes (cue + conversation), opens every affected host file,
   * strips the string from its `tags: list[str]`, removes the colour-
   * map entry. This handler pre-captures the affected hosts (so we
   * can build the `_programTagRestore` snapshot before the local
   * strip mutates anything), fires the backend DELETE, applies
   * `_stripReferencesToProgramTag` to bring the in-memory stores in
   * line with what's on disk.
   *
   * The `_programTagRestore` snapshot carries the pre-delete colour-
   * map value + the pre-delete tags arrays of every affected cue +
   * conversation. Undo re-PUTs the colour + each affected host's
   * tags via the existing per-id endpoints; redo re-fires the
   * cascade-DELETE.
   */
  _deleteProgramTagInternal: async (name) => {
    if (!name || typeof name !== 'string') return
    const target = name.toLowerCase()
    const matches = (t) => typeof t === 'string' && t.toLowerCase() === target

    // Capture pre-delete state for the undo snapshot. The strip
    // primitive returns the affected-host shapes after its run; we
    // want them BEFORE the strip so the snapshot reflects the
    // restore target.
    const cuesStore = useContextCuesStore.getState()
    const affectedCuesBefore = []
    for (const c of (cuesStore.cues || [])) {
      const tags = Array.isArray(c.tags) ? c.tags : []
      if (tags.some(matches)) affectedCuesBefore.push({ id: c.id, tags: [...tags] })
    }
    const convStore = useConversationsStore.getState()
    const affectedConvsBefore = []
    for (const e of (convStore.index || [])) {
      const tags = Array.isArray(e.tags) ? e.tags : []
      if (tags.some(matches)) affectedConvsBefore.push({ id: e.id, tags: [...tags] })
    }

    // Read colour from the local Program Tags pool cache — avoids
    // an extra backend round-trip just to capture undo state. If
    // the pool isn't loaded yet, the snapshot's colour is null and
    // undo re-PUT skips colour restoration (matches "no entry was
    // set" semantically).
    const programPool = useProgramTagsStore.getState().pool || []
    const poolEntry = programPool.find((p) => (p.name || '').toLowerCase() === target)
    const colorBefore = poolEntry?.color || null

    get()._snapshot({
      _programTagRestore: [{
        name,
        color: colorBefore,
        affectedCues: affectedCuesBefore,
        affectedConvs: affectedConvsBefore,
      }],
    })

    // Optimistic local strip — cuesStore + conversationsStore +
    // programTagsStore.pool — so the badge disappears from the
    // library immediately. The snapshot above guarantees undo can
    // restore if the backend DELETE fails. The backend cascade-
    // DELETE that follows asynchronously brings disk in line with
    // the in-memory state.
    _stripReferencesToProgramTag(name)
    useProgramTagsStore.setState({
      pool: programPool.filter((p) => (p.name || '').toLowerCase() !== target),
    })

    // Fire the backend cascade-DELETE in the background. 404 is
    // fine; other errors leave the local strip in place to match
    // `_deleteProjectTagInternal`'s pattern.
    try {
      await axios.delete(`/api/program-tags/${encodeURIComponent(name)}`)
    } catch (err) {
      if (err?.response?.status !== 404) throw err
    }
  },

  /** @deprecated Use `deleteObject('entity', entityId)` instead. Thin wrapper kept
   *  for existing call sites; migrates in follow-up. */
  // --- Canvas state ---

  onNodesChange: (changes) => {
    // Suppress dimension changes for collapsed reference nodes — RF's ResizeObserver
    // would overwrite the explicit collapsed dimensions we set.
    const nodes = get().nodes
    const filtered = changes.filter((c) => {
      if (c.type === 'dimensions') {
        const node = nodes.find((n) => n.id === c.id)
        if (node?.type === 'referenceNode' && node.data?.collapsed) return false
      }
      return true
    })
    if (!filtered.length) return

    // Phase 4.1g follow-up — measured dimensions are applied back to the
    // nodes (so React Flow's MiniMap and edge routing have node sizes),
    // mirrored to the side store as a fallback-chain backup. Pure-
    // dimension bursts (the ~288 RF measurement calls during the post-
    // load window) are rAF-coalesced into one array write per frame;
    // mixed batches flush the queue and process synchronously. See the
    // module-level `_dimQueue` note for why re-applying is safe now (all
    // heavy consumers are scoped to ignore dimension churn).
    const dimensionChanges = []
    const structuralChanges = []
    for (const c of filtered) {
      if (c.type === 'dimensions') dimensionChanges.push(c)
      else structuralChanges.push(c)
    }
    if (dimensionChanges.length > 0) {
      applyMeasuredDimensionChanges(dimensionChanges)
      // Phase 4.3 — a node's real height just arrived; in multi-row a row
      // sized earlier from the seed estimate may now be too short, so grow
      // affected rows to contain it (debounced, grow-only, gated vs load).
      _scheduleGrowRefit(get)
      // Hold `_loadSettling` true while measurement bursts (and the grow-refit
      // they trigger) keep changing node sizes / positions — each legitimately
      // an order input, but recomputing per frame is the load storm. Reset the
      // debounce on every burst; once they stop, clear it, and the story-order
      // gate releases for ONE recompute on the settled layout.
      if (get()._loadSettling) {
        if (_loadSettleTimer) clearTimeout(_loadSettleTimer)
        _loadSettleTimer = setTimeout(() => {
          _loadSettleTimer = null
          set({ _loadSettling: false })
        }, 350)
      }
    }

    if (structuralChanges.length === 0) {
      // Pure-dimension batch: coalesce across the frame so the post-load
      // measurement storm collapses into ~1 array write per frame.
      if (dimensionChanges.length > 0) {
        for (const c of dimensionChanges) _dimQueue.push(c)
        if (_dimRaf == null) {
          _dimRaf = requestAnimationFrame(() => {
            _dimRaf = null
            const q = _dimQueue
            _dimQueue = []
            if (q.length === 0) return
            set({ nodes: applyNodeChanges(q, get().nodes) })
          })
        }
      }
      return
    }

    // Mixed batch (structural change present): flush any queued
    // dimensions and apply everything synchronously so structural
    // changes (position / selection / remove) aren't delayed behind the
    // rAF. `filtered` already carries this call's dimension changes.
    let pendingDims = []
    if (_dimQueue.length > 0) {
      pendingDims = _dimQueue
      _dimQueue = []
      if (_dimRaf != null) { cancelAnimationFrame(_dimRaf); _dimRaf = null }
    }
    const mergedChanges = pendingDims.length > 0 ? [...pendingDims, ...filtered] : filtered

    // Detect "persistent" changes — ones that affect what gets saved
    // to disk (node positions, removals) vs purely session-state
    // changes (selection / dragging-in-progress intermediates,
    // passive ResizeObserver measurements). React Flow fires
    // `position` changes at ~60Hz during a drag with `dragging:
    // true`; we ignore those frames and only mark dirty on the
    // drag-end frame (`dragging: false`), which is the COMMITTED
    // position. The auto-sync throttle then captures it within
    // BACKEND_SYNC_DELAY_MS. Selection changes are session-only
    // and never mark dirty.
    //
    // `dimensions` changes are EXCLUDED from persistence here.
    // Every real user-driven resize routes through
    // `NodeResizeControl.onResize` → `updateNodeData(id, {width,
    // height})`, which has its own dirty-marking. The dimension
    // changes that flow through this handler are all passive RF
    // measurement bookkeeping — ResizeObserver discovering the
    // real DOM size after a node mounts, `updateNodeInternals`
    // re-measure triggers, layout-correction-induced re-measures
    // — none of which represent user intent to change anything
    // savable. Previously these flipped `hasUnsavedChanges: true`
    // on every project load, producing a spurious "discard
    // changes?" prompt on any subsequent navigation.
    const isPersistent = mergedChanges.some((c) => {
      if (c.type === 'position') return c.dragging === false
      if (c.type === 'remove') return true
      return false
    })
    const nextNodes = applyNodeChanges(mergedChanges, get().nodes)
    set(isPersistent
      ? { nodes: nextNodes, hasUnsavedChanges: true }
      : { nodes: nextNodes })
    const removedIds = new Set(mergedChanges.filter((c) => c.type === 'remove').map((c) => c.id))
    if (removedIds.size > 0) {
      for (const rid of removedIds) dropMeasuredDimensions(rid)
      const uiStore = useUiStore.getState()
      if (uiStore.detailPanelNodeId && removedIds.has(uiStore.detailPanelNodeId)) {
        uiStore.clearDetailPanel({ force: true })
      }
    }
  },

  onEdgesChange: (changes) => {
    // Snapshot before edge removals so they can be undone
    if (changes.some((c) => c.type === 'remove')) get()._snapshot()
    const { edges, nodes } = get()
    // Clear pov_entity_id on any node that loses its incoming POV wire
    const removedIds = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
    const removedPovTargets = edges
      .filter((e) => removedIds.has(e.id) && e.data?.is_pov_path)
      .map((e) => e.target)
    // Identify entity narrative-flow wire removals so we can clear
    // upstream-comparison review flags on chips that become orphaned.
    // A chip is orphaned for an entity when no incoming narrative-flow
    // wire (`source_entity_id` matching, `is_relationship` false, not
    // POV) remains targeting its node for that entity. Orphan chips
    // have no chain context, so any review_fields driven by upstream
    // comparison are no longer meaningful — clear them.
    const newEdges = applyEdgeChanges(changes, edges)
    const orphanCandidates = []  // { nodeId, entityId }
    for (const id of removedIds) {
      const removed = edges.find((e) => e.id === id)
      if (!removed) continue
      if (removed.data?.is_pov_path) continue
      if (removed.data?.is_relationship) continue
      const entityId = removed.data?.source_entity_id
      if (!entityId) continue
      const stillIncoming = newEdges.some(
        (e) => e.target === removed.target
          && e.data?.source_entity_id === entityId
          && !e.data?.is_relationship
          && !e.data?.is_pov_path,
      )
      if (!stillIncoming) {
        orphanCandidates.push({ nodeId: removed.target, entityId })
      }
    }

    let updNodes = removedPovTargets.length > 0
      ? nodes.map((n) => removedPovTargets.includes(n.id) ? { ...n, data: { ...n.data, pov_entity_id: null } } : n)
      : nodes

    if (orphanCandidates.length > 0) {
      const byNode = new Map()
      for (const c of orphanCandidates) {
        if (!byNode.has(c.nodeId)) byNode.set(c.nodeId, new Set())
        byNode.get(c.nodeId).add(c.entityId)
      }
      updNodes = updNodes.map((n) => {
        const entityIds = byNode.get(n.id)
        if (!entityIds) return n
        if (n.type === 'sceneNode') {
          let nodeChanged = false
          const newData = { ...n.data }
          for (const bucket of ENTITY_BUCKETS) {
            const refs = newData[bucket] || []
            let bucketChanged = false
            const nextRefs = refs.map((r) => {
              if (!entityIds.has(r.entity_id)) return r
              if (!(r.review_fields && r.review_fields.length > 0)) return r
              bucketChanged = true
              nodeChanged = true
              return { ...r, review_fields: [] }
            })
            if (bucketChanged) newData[bucket] = nextRefs
          }
          if (!nodeChanged) return n
          return { ...n, data: newData }
        }
        return n
      })
    }

    set({
      edges: newEdges,
      ...(updNodes !== nodes ? { nodes: updNodes } : {}),
    })
    // Phase 1.23 — POV wire removal changes downstream floors. Re-run
    // walker + alert detection so any threshold-crossing shift surfaces
    // immediately instead of waiting for the next time-field commit
    // (planning §3.4 "POV chain rewire" trigger).
    if (removedPovTargets.length > 0) get()._commitScenetimeWrites()
  },

  onConnect: async (params) => {
    // Phase 1.21c — Knowledge awareness-grant wires are action-only: the
    // wire creation IS the awareness-grant write. Resolves `<KnowledgeOriginNode>`
    // output handles AND `<KnowledgeChip>` `knowledge-chip-out-<id>` handles
    // through a single branch (both emit `KNOWLEDGE_AWARENESS_GRANT`).
    // Handled before `_snapshot()` so we don't pollute undo history with
    // an empty-edges snapshot when the drop is a no-op. The downstream
    // awareness / manual-anchor store actions take their own snapshots.
    {
      const _curNodes = get().nodes
      const srcNode = _curNodes.find((n) => n.id === params.source)
      const srcHandle = typeof params.sourceHandle === 'string' ? params.sourceHandle : null

      let knowledgeId = null
      if (srcNode?.type === 'knowledgeOriginNode') {
        knowledgeId = srcNode.data?.knowledge_id || null
      } else if (
        srcNode?.type === 'sceneNode'
        && srcHandle
        && srcHandle.startsWith('knowledge-chip-out-')
      ) {
        knowledgeId = srcHandle.slice('knowledge-chip-out-'.length) || null
      }

      if (knowledgeId) {
        const targetNode = _curNodes.find((n) => n.id === params.target)
        if (!targetNode) return

        // Resolve the observer entity (if any) so the level-picker dialog
        // can name it. `observerEntityId` is set for the three entity-
        // shaped target shapes; left null for the manual-anchor target.
        let observerEntityId = null
        let writeAt = null  // 'origin' | nodeId | null
        if (targetNode.type === 'entityNode' && targetNode.data?.entity_id) {
          observerEntityId = targetNode.data.entity_id
          writeAt = targetNode.data?.is_modifier ? targetNode.id : 'origin'
        } else if (
          targetNode.type === 'sceneNode'
          && typeof params.targetHandle === 'string'
          && params.targetHandle.startsWith('chip-in-')
        ) {
          observerEntityId = params.targetHandle.slice('chip-in-'.length) || null
          writeAt = targetNode.id
        }

        // Awareness-grant target (one of the three entity-shaped targets).
        if (observerEntityId && writeAt) {
          const knowledge = get().knowledges.find((k) => k.id === knowledgeId)
          if (!knowledge) return
          const observerEntity = useEntitiesStore.getState().getEntityById?.(observerEntityId) || null
          const result = await pickKnowledgeAwarenessLevel({ knowledge, observerEntity })
          if (!result) return  // user cancelled
          const { level, precision } = result

          const trackingOff = knowledge.awareness == null
          const currentPrecision = knowledge.awareness_scale || 'full'
          const willChangePrecision = trackingOff && precision !== currentPrecision
          // One snapshot covers up to three writes (precision +
          // tracking-toggle flip + awareness write) so a single undo
          // reverts the whole grant. The setter receives
          // `skipSnapshot: true` so it doesn't add a second snapshot
          // frame on top.
          get()._snapshot()
          // Phase 1.21h — establishment routes by anchor:
          //   writeAt === 'origin' → flip library row (origin
          //     establishment). Mirrors how an attribute is born on the
          //     entity's library row when added at the entity's origin.
          //   writeAt === <nodeId> → write a chain entry on
          //     `Knowledge.history.awareness_changes` with action='add'
          //     and the chosen precision. Library row stays null.
          //     Mirrors how `attribute_changes action='add'` records an
          //     attribute coming into existence mid-chain. Upstream of
          //     this anchor the Knowledge has no awareness tracking;
          //     downstream tracking is on with the chosen scale.
          if (trackingOff || willChangePrecision) {
            if (writeAt === 'origin') {
              set({
                knowledges: get().knowledges.map((k) => {
                  if (k.id !== knowledgeId) return k
                  return {
                    ...k,
                    ...(willChangePrecision ? { awareness_scale: precision } : {}),
                    ...(trackingOff ? { awareness: {} } : {}),
                  }
                }),
                hasUnsavedChanges: true,
              })
            } else if (trackingOff) {
              get().enableKnowledgeAwarenessAtNode(knowledgeId, writeAt, precision, { skipSnapshot: true })
            }
          }
          if (writeAt === 'origin') {
            get().setKnowledgeAwarenessOrigin(knowledgeId, observerEntityId, level, { skipSnapshot: true })
          } else {
            get().setKnowledgeAwarenessAtNode(knowledgeId, observerEntityId, writeAt, level, { skipSnapshot: true })
          }
          return
        }

        // Target = scene general-in handle (no specific handle id) — add
        // a manual anchor for this Knowledge at the dropped scene.
        // Idempotent: addKnowledgeManualAnchor no-ops when an anchor
        // already exists for (knowledgeId, sceneId).
        if (targetNode.type === 'sceneNode' && !params.targetHandle) {
          // Don't anchor on a scene where the Knowledge is already chipped
          // (via existing history or anchor) — silent no-op matches the
          // library-drop-on-scene guard in SceneNode.handleDrop.
          const k = get().knowledges.find((x) => x.id === knowledgeId)
          if (k) {
            const order = getKnowledgeNodeOrder(k, get().nodes, get().edges)
            if (!order.includes(targetNode.id)) {
              get().addKnowledgeManualAnchor(knowledgeId, targetNode.id)
            }
          }
          return
        }

        // All other target shapes (relationship origin, POV, etc.)
        // silently reject — Knowledge propagation only meaningful at
        // entity-observer or scene-anchor targets.
        return
      }
    }

    // Phase 8.1 (§8.1.2) , concept-wire branch. A drag from a concept port
    // (`concept-*` handle on a referenceNode / genericGroupNode) creates a
    // conceptEdge and returns before any narrative logic. handleIsValidConnection
    // (Canvas) already guaranteed the target is a concept port (the closed
    // world), so no cross-type check is needed here. Placed before the general
    // snapshot so non-concept drops don't take an extra snapshot frame.
    {
      const conceptSrcHandle = typeof params.sourceHandle === 'string' ? params.sourceHandle : null
      if (conceptSrcHandle && conceptSrcHandle.startsWith('concept-')) {
        // Reject a self-loop onto the same node (a drop back on the origin
        // port's co-located target handle).
        if (params.source === params.target) return
        const conceptTgtHandle = typeof params.targetHandle === 'string' ? params.targetHandle : null
        const conceptId = `concept-${params.source}-${conceptSrcHandle}-${params.target}-${conceptTgtHandle}`
        const curEdges = get().edges
        // Idempotent: the same two ports are wired at most once.
        if (curEdges.some((e) => e.id === conceptId)) return
        get()._snapshot()
        const conceptEdge = {
          id: conceptId,
          source: params.source,
          target: params.target,
          sourceHandle: conceptSrcHandle,
          targetHandle: conceptTgtHandle,
          type: 'conceptEdge',
          data: {
            id: conceptId,
            kind: 'concept',
            source_node_id: params.source,
            target_node_id: params.target,
            source_handle_id: conceptSrcHandle,
            target_handle_id: conceptTgtHandle,
          },
        }
        set({ edges: [...curEdges, conceptEdge], hasUnsavedChanges: true })
        return
      }
    }

    get()._snapshot()
    let { nodes, edges } = get()
    const id = crypto.randomUUID()

    // Same-node self-loop guard: dropping a drag onto the same node that
    // emitted it, where source-handle and target-handle would form a true
    // self-reference. Examples:
    //   - entity chip-out -> the same chip's chip-in (same entity on same scene)
    //   - entity origin default out -> the same entityNode's default in
    // These cases produce no meaningful wire and are silently dropped up
    // front so downstream branches can't accidentally create one. POV
    // intra-scene drops have their own reassignment path in the POV branch
    // below; broadcast self-loops and narrative-flow self-loops fall through
    // to the cycle guard (sourceId === targetId counts as a cycle).
    if (
      params.source === params.target &&
      params.sourceHandle !== 'pov-out' &&
      params.sourceHandle !== 'broadcast'
    ) {
      // Case A: chip-out -> chip-in of the same entity on the same scene
      if (params.sourceHandle && params.targetHandle?.startsWith('chip-in-')) {
        if (params.targetHandle.slice(8) === params.sourceHandle) return
      }
      // Case B: entity origin default out -> same entityNode default in
      //   (both handles unset; sourceHandle/targetHandle are both null/undef)
      const _srcNodeSelfCheck = nodes.find((n) => n.id === params.source)
      if (
        _srcNodeSelfCheck?.type === 'entityNode' &&
        !params.sourceHandle &&
        !params.targetHandle
      ) return
    }

    // Duplicate-relationship creation guard. Called before an auto-create
    // wiring path calls createRelationship for the first time with the
    // proposed participant set. Returns { ok, hadMatch }:
    //   ok=false  -> caller aborts silently
    //   ok=true   -> caller proceeds. hadMatch=true means the user
    //                confirmed creation despite a dup/superset match, and
    //                the caller should open the new rel's detail panel so
    //                the user can differentiate it (e.g. via aliases).
    // variant 'origin' compares against origin-state of existing rels that
    // have their own rel-origin-node; variant 'scene' compares against the
    // effective state at `sceneNodeId` of every existing rel whose chain
    // reaches that scene. See utils/relationshipHistory.js.
    const checkDuplicateRelAndConfirm = async (proposedEntityIds, variant, sceneNodeId = null) => {
      const { relationships, nodes: curNodes, edges: curEdges } = get()
      const getEntity = useEntitiesStore.getState().getEntityById
      let match = null
      if (variant === 'origin') {
        match = findDuplicateAtOrigin(proposedEntityIds, relationships, curNodes)
      } else {
        match = findDuplicateAtScene(proposedEntityIds, relationships, curNodes, curEdges, sceneNodeId)
      }
      if (!match) return { ok: true, hadMatch: false }
      const rel = match.existingRel
      const changes = rel.history?.participant_changes || []
      const aliasChanges = rel.history?.alias_changes || []
      // Per-entity alias inside the detected rel: earliest `initial_alias_override`
      // from the first `join` for that entity; fall back to most recent entry in
      // alias_changes. Null if no alias is set for that entity anywhere in the
      // existing rel's history.
      const aliasFor = (entityId) => {
        const firstJoin = changes.find((c) => c.entity_id === entityId && c.action === 'join')
        if (firstJoin?.initial_alias_override) return firstJoin.initial_alias_override
        for (let i = aliasChanges.length - 1; i >= 0; i--) {
          const a = aliasChanges[i]
          if (a.entity_id === entityId && a.alias_override) return a.alias_override
        }
        return null
      }
      const joinEntityIds = Array.from(new Set(
        changes.filter((c) => c.action === 'join').map((c) => c.entity_id)
      ))
      let resolveNameHere = null
      if (sceneNodeId) {
        resolveNameHere = (eid) => {
          const ent = getEntity(eid)
          if (!ent) return null
          const s = computeEffectiveState(ent, curNodes, curEdges, sceneNodeId)
          return s?.name || ent.name || null
        }
      } else {
        const story = get().story
        const chapters = story?.chapters || []
        const chapterXOffset = typeof story?.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
        const povChain = computePovChain(curNodes, curEdges)
        const storyOrderLocal = computeStoryOrder({ nodes: curNodes, edges: curEdges, povChain, chapters, chapterXOffset })
        resolveNameHere = makeLatestPresenceNameResolver({
          participantEntityIds: joinEntityIds,
          nodes: curNodes, edges: curEdges, storyOrder: storyOrderLocal, getEntity,
        })
      }
      const existingLabel = rel.name || participantsFallbackLabel(
        joinEntityIds.map((id) => ({ entity_id: id })),
        getEntity,
        3,
        rel,
        resolveNameHere,
      ) || 'Relationship'
      // Birth node: rel-origin-node if one exists, otherwise the earliest node
      // in the rel's chain where a join occurred.
      let birth = null
      let birthNodeId = null
      const originNode = curNodes.find(
        (n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === rel.id
      )
      if (originNode) {
        birth = { kind: 'origin', label: existingLabel }
        birthNodeId = originNode.id
      } else {
        const relNodeOrder = getRelationshipNodeOrder(rel, curNodes, curEdges)
        const joinNodeIds = new Set(
          changes.filter((c) => c.action === 'join').map((c) => c.node_id)
        )
        const firstJoinNodeId = relNodeOrder.find((nid) => joinNodeIds.has(nid))
        if (firstJoinNodeId) {
          const sceneNode = curNodes.find((n) => n.id === firstJoinNodeId)
          const title = sceneNode?.data?.title || 'Scene'
          birth = { kind: 'scene', label: title }
          birthNodeId = firstJoinNodeId
        }
      }
      // Detection node: where we saw the conflict. For scene variant that's
      // the wiring target; for origin variant it's the existing rel's
      // origin node. Used as the chain point for the entity detail panel
      // when the user clicks an entity badge.
      const detectionNodeId = variant === 'origin' ? birthNodeId : sceneNodeId
      // Navigation callbacks fired by clicks inside the dialog. Each one
      // closes the dialog (same effect as Cancel — no new rel is created)
      // and routes to the relevant detail surface.
      const dismissDialog = () => useDialogStore.getState().resolveDialog('cancel')
      const onClickRelationship = () => {
        dismissDialog()
        useUiStore.getState().openRelationshipDetail(rel.id, detectionNodeId || null)
      }
      const onClickBirth = () => {
        dismissDialog()
        if (!birthNodeId) return
        const focus = useUiStore.getState()._focusNode
        if (focus) focus(birthNodeId)
        const birthNode = get().nodes.find((n) => n.id === birthNodeId)
        if (birthNode?.type === 'relationshipOriginNode') {
          useUiStore.getState().openRelationshipDetail(rel.id, birthNodeId)
        } else if (birthNode?.type === 'sceneNode') {
          useUiStore.getState().setDetailPanel('scene', birthNodeId, null, -1)
        }
      }
      const onClickEntity = (entityId) => {
        dismissDialog()
        if (variant === 'origin') {
          // Land on the entity's own origin node — the most recent prior
          // point at which this conflicting rel exists for that entity.
          const entOrigin = get().nodes.find(
            (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId
          )
          if (entOrigin) {
            const focus = useUiStore.getState()._focusNode
            if (focus) focus(entOrigin.id)
            useUiStore.getState().setDetailPanel('entityNode', entOrigin.id, entityId, 0)
          }
        } else {
          // Scene variant — show the entity's chip state at the wiring scene.
          if (sceneNodeId) {
            const focus = useUiStore.getState()._focusNode
            if (focus) focus(sceneNodeId)
            useUiStore.getState().setDetailPanel('entityChip', sceneNodeId, entityId, -1)
          }
        }
      }
      const participants = proposedEntityIds
        .map((eid) => ({
          entity: getEntity(eid),
          aliasOverride: aliasFor(eid),
          onClick: () => onClickEntity(eid),
        }))
        .filter((p) => p.entity)
      const hasAliases = participants.some((p) => !!p.aliasOverride)
      const message = buildDuplicateRelMessage({
        participants,
        match: {
          kind: match.kind,
          existingLabel,
          existingRel: rel,
          getEntity,
          joinEntityIds,
          birth,
          onClickRelationship,
          onClickBirth,
          resolveName: resolveNameHere,
        },
        hasAliases,
      })
      const result = await confirm({
        title: 'Create duplicate relationship?',
        message,
        buttons: [
          { label: 'Create anyway', value: 'create', style: 'primary' },
          { label: 'Cancel', value: 'cancel', style: 'neutral' },
        ],
      })
      return { ok: result === 'create', hadMatch: true }
    }

    // ── POV wire ────────────────────────────────────────────────────────────
    // Handle connections from POV Origin Node or POV chip output
    const isPovSource = params.sourceHandle === 'pov-out'
    if (isPovSource) {
      const targetNode = nodes.find((n) => n.id === params.target)
      // POV wires can only target scene (plot point) nodes
      if (!targetNode || targetNode.type !== 'sceneNode') return
      // Drop silently if targeting a relationship chip input
      if (params.targetHandle?.startsWith('rel-in-')) return

      // Intra-scene POV reassignment: dragging from a scene's POV chip output
      // onto a chip on the SAME scene means "attach POV to that character",
      // not "create a new POV wire". Preserve the incoming POV edge and any
      // outgoing POV edge; only reassign `pov_entity_id` on this scene when
      // the drop target identifies a valid character chip in the scene.
      if (params.source === params.target) {
        const targetChipEid = params.targetHandle?.startsWith('chip-in-')
          ? params.targetHandle.slice(8)
          : null
        if (targetChipEid) {
          let tgtData = targetNode.data || {}
          let tgtCharacters = tgtData.characters || []
          if (tgtData.is_flashback && tgtData.parent_scene_id) {
            const parentNode = nodes.find((n) => n.id === tgtData.parent_scene_id)
            if (parentNode) tgtCharacters = parentNode.data?.characters || []
          }
          if (tgtCharacters.some((c) => c.entity_id === targetChipEid)) {
            const entity = useEntitiesStore.getState().getEntityById(targetChipEid)
            if (entity?.type === 'character') {
              set({
                nodes: nodes.map((n) =>
                  n.id === params.target
                    ? { ...n, data: { ...n.data, pov_entity_id: targetChipEid } }
                    : n
                ),
                _povInternalsUpdate: Date.now(),
                hasUnsavedChanges: true,
              })
              return
            }
          }
        }
        // Any other same-scene POV drop (non-character chip, flow-in, orphan
        // pov-in) -- silent drop, don't touch existing edges.
        return
      }

      // Remove any existing outgoing POV wire from this source node
      // (allows "re-dragging" to a different target)
      let updEdges = edges.filter((e) => !(e.data?.is_pov_path && e.source === params.source))
      // Also remove any existing incoming POV wire on the target
      // (the new wire replaces it)
      const oldIncoming = updEdges.find((e) => e.data?.is_pov_path && e.target === params.target)
      if (oldIncoming) {
        updEdges = updEdges.filter((e) => e.id !== oldIncoming.id)
      }

      // Loop guard: adding source → target must not create a cycle
      if (wouldCreatePovLoop(nodes, updEdges, params.source, params.target)) {
        confirm({
          title: 'Cannot create POV connection',
          message: 'It would create a loop in the POV chain.',
          buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
        })
        return
      }
      // Combined-cycle guard: a POV wire must not create a cycle when combined
      // with the existing entity-chain (narrative-flow) edges.
      if (wouldCreateCycle(updEdges, params.source, params.target)) {
        confirm({
          title: 'Cannot create POV connection',
          message:
            'This POV connection would run counter to an existing scene-to-scene ' +
            'connection, creating a loop between the POV chain and the entity chains.',
          buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
        })
        return
      }
      // Story-order guard: a POV wire must not contradict a tier-1 (POV) or
      // tier-2 (entity chain) ordering already established between these
      // scenes. Catches the case where the POV chain would run in the opposite
      // direction to a connected entity chain between the two scenes.
      if (_checkContradictsStoryOrder(get, params.source, params.target)) return
      edges = updEdges

      // Auto-attach: determine which character gets the POV in the target node.
      // For flashback scenes, resolve entity data from the parent scene.
      // If the default POV character or prior scene's holder isn't in the scene, auto-add them.
      let tgtData = targetNode.data || {}
      // Flashback: get characters from parent scene (flashback's own buckets are empty)
      let tgtCharacters = tgtData.characters || []
      if (tgtData.is_flashback && tgtData.parent_scene_id) {
        const parentNode = nodes.find((n) => n.id === tgtData.parent_scene_id)
        if (parentNode) tgtCharacters = parentNode.data?.characters || []
      }
      const storyPovId = get().story?.pov_character_id
      const sourceNode = nodes.find((n) => n.id === params.source)
      const priorPovEntityId = sourceNode?.data?.pov_entity_id || null

      // Determine which character to attach, auto-adding if needed
      let povEntityId = null
      let autoAddEntityId = null

      // Priority 1: user targeted a specific character chip's input port
      const targetChipId = params.targetHandle?.startsWith('chip-in-')
        ? params.targetHandle.slice(8)
        : null
      if (targetChipId && tgtCharacters.some((c) => c.entity_id === targetChipId)) {
        const entity = useEntitiesStore.getState().getEntityById(targetChipId)
        if (entity?.type === 'character') {
          povEntityId = targetChipId
        }
      }

      // Priority 2: existing POV chip assignment — if the scene already has pov_entity_id
      // set to a valid character present in the scene, preserve it. The user's prior choice
      // (or an earlier auto-attach they were happy with) must not be overridden when a new
      // POV wire is connected to the same scene.
      if (!povEntityId && tgtData.pov_entity_id && tgtCharacters.some((c) => c.entity_id === tgtData.pov_entity_id)) {
        const entity = useEntitiesStore.getState().getEntityById(tgtData.pov_entity_id)
        if (entity?.type === 'character') {
          povEntityId = tgtData.pov_entity_id
        }
      }

      // Priorities 3–5 auto-attach a character the user didn't explicitly target.
      // Skip these for POV types that don't require a specific character (e.g. 3rd Person variants).
      const NON_CHARACTER_POV_TYPES = new Set([
        '3rd Person',
        '3rd Person (Limited)',
        '3rd Person (Omniscient)',
      ])
      const povTypeDefault = get().story?.pov_type_default || ''
      const skipAutoAttach = NON_CHARACTER_POV_TYPES.has(povTypeDefault)

      // Priority 3: default POV character from Story Settings (auto-add to scene if not present)
      if (!povEntityId && !skipAutoAttach && storyPovId) {
        const entity = useEntitiesStore.getState().getEntityById(storyPovId)
        if (entity?.type === 'character') {
          if (tgtCharacters.some((c) => c.entity_id === storyPovId)) {
            povEntityId = storyPovId
          } else {
            autoAddEntityId = storyPovId
            povEntityId = storyPovId
          }
        }
      }

      // Priority 4: prior scene's POV holder from the upstream POV chain (auto-add if not present)
      if (!povEntityId && !skipAutoAttach && priorPovEntityId) {
        const entity = useEntitiesStore.getState().getEntityById(priorPovEntityId)
        if (entity?.type === 'character') {
          if (tgtCharacters.some((c) => c.entity_id === priorPovEntityId)) {
            povEntityId = priorPovEntityId
          } else {
            autoAddEntityId = priorPovEntityId
            povEntityId = priorPovEntityId
          }
        }
      }

      // Priority 5: fall back to the first character already present in the scene
      if (!povEntityId && !skipAutoAttach && tgtCharacters.length > 0) {
        povEntityId = tgtCharacters[0].entity_id
      }

      // Build updated nodes: auto-add the character EntityRef if needed, then set pov_entity_id
      // Flashback scenes: don't auto-add entities (they come from the parent); only set pov_entity_id
      const isFlashbackTarget = tgtData.is_flashback
      const updNodes = nodes.map((n) => {
        if (n.id !== params.target) return n
        let newData = { ...n.data }
        if (!isFlashbackTarget && autoAddEntityId && !(newData.characters || []).some((c) => c.entity_id === autoAddEntityId)) {
          newData.characters = [
            ...(newData.characters || []),
            {
              entity_id: autoAddEntityId,
              name_change: null, colour_change: null,
              description_change: null, profile_image_change: null,
              attribute_changes: [],
              awareness_changes: [],
              has_pov: false,
            },
          ]
        }
        newData.pov_entity_id = povEntityId
        return { ...n, data: newData }
      })

      // Auto-wire entity flow: if we auto-added a character and that character had the POV
      // in the source scene, create an entity flow wire so the character's chain is continuous.
      // Only auto-wire when the character was the POV holder — otherwise the user wires manually.
      let newEdges = edges
      if (autoAddEntityId && sourceNode?.type === 'sceneNode' && !sourceNode.data?.is_flashback && sourceNode.data?.pov_entity_id === autoAddEntityId) {
        const srcCharacters = sourceNode.data?.characters || []
        if (srcCharacters.some((c) => c.entity_id === autoAddEntityId)) {
          // Check no existing entity flow wire for this entity into the target
          const alreadyWired = newEdges.some(
            (e) => e.target === params.target && e.data?.source_entity_id === autoAddEntityId && !e.data?.is_relationship && !e.data?.is_pov_path
          )
          if (!alreadyWired) {
            newEdges = [...newEdges, {
              id: crypto.randomUUID(),
              source: params.source,
              target: params.target,
              sourceHandle: autoAddEntityId,
              type: 'transitionEdge',
              data: {
                id: crypto.randomUUID(),
                source_node_id: params.source,
                target_node_id: params.target,
                source_entity_id: autoAddEntityId,
              },
            }]
          }
        }
      }

      // Create POV edge — target the pov-in handle on the badge
      const newEdge = {
        id,
        source: params.source,
        target: params.target,
        sourceHandle: 'pov-out',
        targetHandle: 'pov-in',
        type: 'povEdge',
        data: {
          id,
          source_node_id: params.source,
          target_node_id: params.target,
          is_pov_path: true,
          target_handle_id: 'pov-in',
        },
      }
      set({ nodes: updNodes, edges: [...newEdges, newEdge], _povInternalsUpdate: Date.now() })
      // Phase 1.23 — POV wire add/reroute changes downstream floors.
      // Re-run walker + alert detection so any threshold-crossing
      // shift surfaces immediately (planning §3.4 trigger).
      get()._commitScenetimeWrites()
      return
    }

    // ── Broadcast output port — passes ALL entity chips to the target node ──
    // When the source handle is 'broadcast', iterate all entity chips in the source
    // SceneNode and create individual entity wires + chips in the target node.
    const sourceNode = nodes.find((n) => n.id === params.source)
    if (params.sourceHandle === 'broadcast' && sourceNode?.type === 'sceneNode') {
      const targetNode = nodes.find((n) => n.id === params.target)
      if (!targetNode || targetNode.type !== 'sceneNode') return
      // Only allow wiring to the scene's generic input — chip-in / rel-in / pov-in all drop silently
      if (params.targetHandle) return

      // ── Flashback target: set parent reference + create a visual wire, but do NOT create entity wires/chips ──
      if (targetNode.data?.is_flashback) {
        // Block flashback-of-flashback
        if (sourceNode.data?.is_flashback) return
        get()._snapshot()
        // Remove any existing parent wire to this flashback
        const updEdges = edges.filter((e) => !(e.target === params.target && e.sourceHandle === 'broadcast' && !e.data?.is_pov_path))
        // Create a visual connection wire (no entity flow, just shows the parent link)
        const parentEdge = {
          id: crypto.randomUUID(),
          source: params.source,
          target: params.target,
          sourceHandle: 'broadcast',
          type: 'transitionEdge',
          data: {
            id: crypto.randomUUID(),
            source_node_id: params.source,
            target_node_id: params.target,
          },
        }
        // Seed description and main_content from parent (only if flashback's are empty)
        const parentData = sourceNode.data || {}
        set({
          nodes: nodes.map((n) => {
            if (n.id !== params.target) return n
            const d = n.data
            return { ...n, data: {
              ...d,
              parent_scene_id: params.source,
              description: d.description || parentData.description || '',
              main_content: d.main_content || parentData.main_content || '',
            }}
          }),
          edges: [...updEdges, parentEdge],
        })
        return
      }

      // Block cycles
      if (wouldCreateCycle(edges, params.source, params.target)) {
        confirm({
          title: 'Cannot create connection',
          message:
            'Cannot create this connection — it would create a loop in the narrative flow.\n\n' +
            'Narrative flow must move forward. Check your existing connections and remove any that already link these nodes in the opposite direction.',
          buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
        })
        return
      }

      // Block wires that contradict tier-1 (POV chain) or tier-2 (connected
      // entity chain) ordering established by the global story order. Tiers
      // 3-11 are inferred / tiebreaker signals and may be overridden by the
      // very wire the user is trying to make — we do not block on those.
      if (_checkContradictsStoryOrder(get, params.source, params.target)) return

      // Collect all entity IDs from the source node
      const allRefs = ENTITY_BUCKETS.flatMap((b) => (sourceNode.data[b] || []))
      if (allRefs.length === 0) return

      // Soft limit: remove any existing broadcast edge from this source node
      let updEdges = edges.filter(
        (e) => !(e.source === params.source && e.sourceHandle === 'broadcast' && !e.data?.is_relationship)
      )

      // For each entity chip, create an individual entity wire + chip in the target
      let updNodes = nodes
      for (const ref of allRefs) {
        const entityId = ref.entity_id
        const entity = useEntitiesStore.getState().getEntityById(entityId)
        if (!entity) continue

        // Convergence guard: remove any existing incoming flow wire for this entity
        updEdges = updEdges.filter(
          (e) => !(e.target === params.target && !e.data?.is_relationship && e.data?.source_entity_id === entityId)
        )

        // Outgoing soft limit: remove any existing flow edge from this entity's chip handle
        updEdges = updEdges.filter(
          (e) => !(
            e.source === params.source &&
            !e.data?.is_relationship &&
            (e.sourceHandle === entityId || e.data?.source_entity_id === entityId)
          )
        )

        // Auto-create EntityRef in target if not present
        const bucketMap = { character: 'characters', location: 'locations', item: 'items', faction: 'factions', custom: 'customs' }
        const bucket = bucketMap[entity.type]
        if (bucket) {
          const tgtNode = updNodes.find((n) => n.id === params.target)
          const currentRefs = tgtNode?.data[bucket] || []
          if (!currentRefs.some((r) => r.entity_id === entityId)) {
            const newRef = {
              entity_id: entityId,
              name_change: null, colour_change: null,
              description_change: null, profile_image_change: null,
              attribute_changes: [],
              awareness_changes: [],
              has_pov: false,
            }
            updNodes = updNodes.map((n) =>
              n.id === params.target
                ? { ...n, data: { ...n.data, [bucket]: [...(n.data[bucket] || []), newRef] } }
                : n
            )
          }
        }

        // Create the individual entity wire — target the entity's chip-in handle
        updEdges = addEdge({
          id: crypto.randomUUID(),
          source: params.source,
          target: params.target,
          sourceHandle: entityId,
          targetHandle: `chip-in-${entityId}`,
          type: 'transitionEdge',
          data: {
            id: crypto.randomUUID(),
            source_node_id: params.source,
            target_node_id: params.target,
            source_entity_id: entityId,
            target_handle_id: `chip-in-${entityId}`,
          },
        }, updEdges)
      }

      // POV propagation: if the source scene is in the POV sequence, wire POV to target
      // using the same priority logic as a manual pov-out → scene-generic drag.
      const srcPovEntityId = sourceNode.data?.pov_entity_id
      if (srcPovEntityId) {
        updEdges = updEdges.filter((e) => !(e.data?.is_pov_path && e.source === params.source))
        updEdges = updEdges.filter((e) => !(e.data?.is_pov_path && e.target === params.target))
        const tgtNode = updNodes.find((n) => n.id === params.target)
        const tgtChars = tgtNode?.data?.characters || []
        const storyPovId = get().story?.pov_character_id
        const _broadcastNonCharPovTypes = new Set([
          '3rd Person',
          '3rd Person (Limited)',
          '3rd Person (Omniscient)',
        ])
        const _broadcastSkipAutoAttach = _broadcastNonCharPovTypes.has(get().story?.pov_type_default || '')
        let povEntityId = null
        let autoAddCharId = null
        if (tgtNode?.data?.pov_entity_id && tgtChars.some((c) => c.entity_id === tgtNode.data.pov_entity_id)) {
          povEntityId = tgtNode.data.pov_entity_id
        }
        if (!povEntityId && !_broadcastSkipAutoAttach && storyPovId) {
          const e = useEntitiesStore.getState().getEntityById(storyPovId)
          if (e?.type === 'character') {
            povEntityId = storyPovId
            if (!tgtChars.some((c) => c.entity_id === storyPovId)) autoAddCharId = storyPovId
          }
        }
        if (!povEntityId && !_broadcastSkipAutoAttach) {
          const e = useEntitiesStore.getState().getEntityById(srcPovEntityId)
          if (e?.type === 'character') {
            povEntityId = srcPovEntityId
            if (!tgtChars.some((c) => c.entity_id === srcPovEntityId)) autoAddCharId = srcPovEntityId
          }
        }
        if (!povEntityId && !_broadcastSkipAutoAttach && tgtChars.length > 0) povEntityId = tgtChars[0].entity_id
        if (povEntityId) {
          if (autoAddCharId) {
            updNodes = updNodes.map((n) => {
              if (n.id !== params.target) return n
              const chars = n.data.characters || []
              if (chars.some((c) => c.entity_id === autoAddCharId)) return n
              return { ...n, data: { ...n.data, characters: [...chars, { entity_id: autoAddCharId, name_change: null, colour_change: null, description_change: null, profile_image_change: null, attribute_changes: [], awareness_changes: [], has_pov: false }] } }
            })
          }
          updNodes = updNodes.map((n) => n.id === params.target ? { ...n, data: { ...n.data, pov_entity_id: povEntityId } } : n)
          const povEdgeId = crypto.randomUUID()
          updEdges = [...updEdges, { id: povEdgeId, source: params.source, target: params.target, sourceHandle: 'pov-out', targetHandle: 'pov-in', type: 'povEdge', data: { id: povEdgeId, source_node_id: params.source, target_node_id: params.target, is_pov_path: true, target_handle_id: 'pov-in' } }]
        }
      }

      set({ nodes: updNodes, edges: updEdges, _povInternalsUpdate: Date.now() })
      // Phase 1.23 — POV wire add/reroute changes downstream floors.
      // Re-run walker + alert detection so any threshold-crossing
      // shift surfaces immediately instead of waiting for the next
      // time-field commit (planning §3.4 "POV chain rewire" trigger).
      get()._commitScenetimeWrites()
      return
    }

    // Resolve which entity (if any) this connection carries.
    // - sourceHandle set  → from a chip's output handle; handle ID = entity_id
    // - EntityNode source → read entity_id from node data
    // sourceNode is hoisted here so it is in scope for the entity→entity check below
    // (declaring it inside the else-block caused a TDZ crash from v0.1.6.89).
    let sourceEntityId = null
    if (params.sourceHandle) {
      sourceEntityId = params.sourceHandle
    } else if (sourceNode?.type === 'entityNode') {
      sourceEntityId = sourceNode.data.entity_id
    }

    // Entity node → entity node connections:
    // - Target is an explicit modifier node (data.is_modifier === true): fall through and
    //   create the chain edge normally so the entity flows into the modifier node.
    // - Target is a definition/origin node: add a bidirectional relationship attribute
    //   instead of creating an edge (no modifier conversion).
    const targetNode = nodes.find((n) => n.id === params.target)

    // Reject: wiring any entity into an already-configured modifier that carries a different entity.
    // Applies regardless of source type (entity node or chip output).
    if (
      targetNode?.type === 'entityNode' && targetNode.data.is_modifier &&
      targetNode.data.entity_id && sourceEntityId &&
      targetNode.data.entity_id !== sourceEntityId
    ) {
      return  // Modifier already assigned to a different entity
    }

    // Phase 1.18 Phase C: wiring into a relationship origin node.
    // - Source = entity origin node   → add as participant at the origin node (join@originNodeId).
    // - Source = entity chip in scene → add as participant at the chip's scene (join@chipSceneId, per Q4).
    // The origin node is a passive receiver: multiple wires can converge on its single input
    // port and the semantic is always "record a participant join". No loopback wire is created.
    if (targetNode?.type === 'relationshipOriginNode' && sourceEntityId) {
      const relId = targetNode.data?.relationship_id
      if (!relId) return
      const rel = get().relationships.find((r) => r.id === relId)
      if (!rel) return
      // RULE: only entity ORIGIN nodes may wire into a relationship origin
      // node. Scene chips and modifier nodes represent mid-chain entity
      // state, so wiring them at the origin position creates a semantic
      // paradox (the chip/modifier is downstream of origin but the wire
      // claims an origin-anchored join). Mid-chain joining uses the sidebar
      // `+ Add Participant` or chip-to-chip wiring within a scene. Drop
      // silently — same UX as other invalid-wire flows.
      const sourceIsEntityOrigin = sourceNode?.type === 'entityNode' && !sourceNode.data?.is_modifier
      if (!sourceIsEntityOrigin) return
      const joinAtNodeId = targetNode.id
      const capturedSource       = params.source
      const capturedSourceHandle = params.sourceHandle
      const capturedTarget       = params.target
      const capturedTargetHandle = params.targetHandle
      const capturedEntityId     = sourceEntityId
      get().addParticipant(relId, capturedEntityId, joinAtNodeId).then(() => {
        // `addParticipant`'s `_syncOriginWireForRel` already created the
        // rel-origin wire (handle-agnostic shape). Patch it with the
        // captured drag handles so the wire visually anchors to the
        // exact ports the user dragged between, instead of falling back
        // to the source/target nodes' default handles. Idempotent re:
        // the wire's existence — if no helper-created wire exists (e.g.
        // entity has no canvas origin node), nothing to patch.
        const edges = get().edges
        const idx = edges.findIndex(
          (e) => e.source === capturedSource
              && e.target === capturedTarget
              && e.data?.is_relationship
              && e.data?.relationship_id === relId,
        )
        if (idx === -1) return
        const cur = edges[idx]
        const wantSrc = capturedSourceHandle || undefined
        const wantTgt = capturedTargetHandle || undefined
        if (cur.sourceHandle === wantSrc && cur.targetHandle === wantTgt) return
        const patched = {
          ...cur,
          ...(wantSrc ? { sourceHandle: wantSrc } : {}),
          ...(wantTgt ? { targetHandle: wantTgt } : {}),
          data: {
            ...cur.data,
            ...(wantTgt ? { target_handle_id: wantTgt } : {}),
          },
        }
        const next = [...edges]
        next[idx] = patched
        set({ edges: next })
      })
      return
    }

    if (sourceNode?.type === 'entityNode' && targetNode?.type === 'entityNode') {
      if (!targetNode.data.is_modifier) {
        // Modifier out → origin: drop silently (modifier nodes anchor to one entity only;
        // wiring a modifier into another entity's origin produces no meaningful relationship origin)
        if (sourceNode.data.is_modifier) return
        // If targeting a rel-in handle, fall through to the rel-in participant-add handler below
        if (!params.targetHandle?.startsWith('rel-in-')) {
          // Create a relationship between two origin entities. Each entity's join is recorded
          // at their own origin node — the same way an attribute declared at origin is part of
          // that entity's chain from their introduction point.
          const entityAId = sourceEntityId
          const entityBId = targetNode.data.entity_id
          if (entityAId && entityBId && entityAId !== entityBId) {
            // When the target is a faction with a membership relationship, ask the user whether
            // they want to add the source as a member or create a separate relationship.
            const targetEntity = useEntitiesStore.getState().getEntityById(entityBId)
            if (targetEntity?.type === 'faction') {
              const membershipRel = get().relationships.find((r) => r.membership_of === entityBId)
              if (membershipRel) {
                const sourceEntity = useEntitiesStore.getState().getEntityById(entityAId)
                useUiStore.getState().openFactionMemberPrompt({
                  sourceEntityId: entityAId,
                  sourceEntityName: sourceEntity?.name || 'Entity',
                  targetEntityId: entityBId,
                  factionName: targetEntity.name || 'Faction',
                  membershipRelId: membershipRel.id,
                  sourceNodeId: params.source,
                  targetNodeId: params.target,
                  capturedSourceHandle: params.sourceHandle || null,
                  context: 'entityToEntity',
                })
                return
              }
            }
            const capturedSource = params.source
            const capturedTarget = params.target
            // Duplicate guard (origin variant): compare proposed participants
            // against the origin-state of every existing rel that has its own
            // rel-origin-node. Skip `membership_of` rels. Prompt on exact/superset match.
            const dupCheck = await checkDuplicateRelAndConfirm([entityAId, entityBId], 'origin')
            if (!dupCheck.ok) return
            // Phase 1.18 Phase C: auto-create a relationship origin node between the
            // two entity origins. Both entities' `join@originNodeId` events are anchored
            // to the new origin node (Q1/Q6). The old loopback wire from capturedSource →
            // capturedTarget is gone — both participants now wire INTO the origin node.
            //
            // Position: midpoint of the two entity origins, offset +80px / +40px per Q2
            // so the node doesn't sit directly on the visual wire midpoint.
            const srcPos = sourceNode.position || { x: 0, y: 0 }
            const tgtPos = targetNode.position || { x: 0, y: 0 }
            const originPos = {
              x: (srcPos.x + tgtPos.x) / 2 + 80,
              y: (srcPos.y + tgtPos.y) / 2 + 40,
            }
            // Reserve the relationship id up-front so we can create the origin node
            // first (Phase C step 3(a)), then call createRelationship with the
            // correct `node_id` on both join events.
            const relId = crypto.randomUUID()
            const originNodeId = crypto.randomUUID()
            // Seed the origin node into local state so createRelationshipOriginNode's
            // idempotent short-circuit picks it up (also elevates z-index per Q2 so
            // it sits on top of any overlap).
            set({
              nodes: [
                ...get().nodes,
                {
                  id: originNodeId,
                  type: 'relationshipOriginNode',
                  position: originPos,
                  zIndex: 1000,
                  data: {
                    id: originNodeId,
                    node_type: 'relationship_origin',
                    relationship_id: relId,
                    position: originPos,
                  },
                },
              ],
              hasUnsavedChanges: true,
            })
            get().createRelationship({
              id: relId,
              history: {
                existence_changes: [],
                participant_changes: [
                  { node_id: originNodeId, action: 'join', entity_id: entityAId, initial_perception: '', initial_alias_override: null },
                  { node_id: originNodeId, action: 'join', entity_id: entityBId, initial_perception: '', initial_alias_override: null },
                ],
                perception_changes: [], alias_changes: [], role_changes: [], hierarchy_changes: [],
              },
            }).then((rel) => {
              if (!rel) return
              // Two wires INTO the relationship origin node — one per participant's
              // entity origin. Replaces the old single loopback wire between the two
              // entity origins.
              const wireA = {
                id: `rel-origin-wire-${rel.id}-${entityAId}`,
                source: capturedSource,
                target: originNodeId,
                type: 'relationshipEdge',
                data: {
                  is_relationship: true,
                  relationship_id: rel.id,
                  source_entity_id: entityAId,
                  source_node_id: capturedSource,
                  target_node_id: originNodeId,
                },
              }
              const wireB = {
                id: `rel-origin-wire-${rel.id}-${entityBId}`,
                source: capturedTarget,
                target: originNodeId,
                type: 'relationshipEdge',
                data: {
                  is_relationship: true,
                  relationship_id: rel.id,
                  source_entity_id: entityBId,
                  source_node_id: capturedTarget,
                  target_node_id: originNodeId,
                },
              }
              set({
                edges: [...get().edges, wireA, wireB],
                hasUnsavedChanges: true,
              })
              // Phase C step 6: land the user on the new relationship's detail panel.
              useUiStore.getState().openRelationshipDetail(rel.id, originNodeId)
            })
          }
          return
        }
        // rel-in handle on entity node: fall through to rel-in handler below
      }
      // is_modifier target: fall through to create the chain edge below
    }

    // Scene chip output → entity origin input: drop silently (no meaningful wire direction)
    if (sourceNode?.type === 'sceneNode' && targetNode?.type === 'entityNode' && !targetNode.data?.is_modifier) {
      return
    }

    // Entity/chip output → pov-in handle: add entity to target scene, attach POV if character,
    // and create a flow wire to the entity's chip-in handle (same as wiring to generic input).
    if (params.targetHandle === 'pov-in' && !isPovSource && sourceEntityId) {
      const entity = useEntitiesStore.getState().getEntityById(sourceEntityId)
      if (!entity) return
      const bucketMap = { character: 'characters', location: 'locations', item: 'items', faction: 'factions', custom: 'customs' }
      const bucket = bucketMap[entity.type]
      if (!bucket || !targetNode || targetNode.type !== 'sceneNode') return
      const updNodes = nodes.map((n) => {
        if (n.id !== params.target) return n
        let d = { ...n.data }
        if (!(d[bucket] || []).some((r) => r.entity_id === sourceEntityId)) {
          d[bucket] = [...(d[bucket] || []), { entity_id: sourceEntityId, name_change: null, colour_change: null, description_change: null, profile_image_change: null, attribute_changes: [], awareness_changes: [], has_pov: false }]
        }
        if (entity.type === 'character') d.pov_entity_id = sourceEntityId
        return { ...n, data: d }
      })
      const flowId = `flow-${params.source}-${params.target}-${sourceEntityId}`
      const updEdges = edges
        .filter((e) => !(e.target === params.target && !e.data?.is_relationship && e.data?.source_entity_id === sourceEntityId))
        .filter((e) => !(e.source === params.source && !e.data?.is_relationship && !e.data?.is_pov_path && e.data?.source_entity_id === sourceEntityId))
      set({
        nodes: updNodes,
        edges: [...updEdges, {
          id: flowId, source: params.source, target: params.target,
          ...(params.sourceHandle ? { sourceHandle: params.sourceHandle } : {}),
          targetHandle: `chip-in-${sourceEntityId}`,
          type: 'transitionEdge',
          data: { id: flowId, source_node_id: params.source, target_node_id: params.target, source_entity_id: sourceEntityId, is_pov_path: false, target_handle_id: `chip-in-${sourceEntityId}` },
        }],
        hasUnsavedChanges: true,
      })
      return
    }

    // Add participant: any source → rel-in-{relId} handle on a SceneNode or EntityNode.
    // The source entity (chip or entity node) becomes a participant in the relationship,
    // with the join recorded at the target node. For SceneNode targets the entity chip is
    // also added to the scene and a flow wire is created. For EntityNode targets (e.g. a faction
    // origin node) only the participant record and relationship wire are created.
    const relChipTargetId = getRelChipId(params.targetHandle)
    if (relChipTargetId && (targetNode?.type === 'sceneNode' || targetNode?.type === 'entityNode')) {
      const entityId = sourceEntityId
      if (entityId) {
        const rel = get().relationships.find((r) => r.id === relChipTargetId)
        // Use effective state so rejoins after a 'leave' correctly add a new
        // 'join' entry. History-only: effective state is derived purely from
        // `history.participant_changes`.
        // Graph-walk narrative order (not canvas x-position — see audit v0.1.18.120+).
        const nodeOrderForRel = rel ? getRelationshipNodeOrder(rel, get().nodes, get().edges) : []
        const relStateAtTarget = rel ? computeRelationshipEffectiveState(rel, nodeOrderForRel, params.target) : null
        const alreadyIn = (relStateAtTarget?.participants || []).some((p) => p.entity_id === entityId)
        const capturedSource = params.source
        const capturedSourceHandle = params.sourceHandle
        const capturedTarget = params.target
        const capturedTargetHandle = params.targetHandle
        const capturedIsEntityNode = targetNode?.type === 'entityNode'
        const addPromise = alreadyIn ? Promise.resolve(rel) : get().addParticipant(relChipTargetId, entityId, capturedTarget)
        addPromise.then(() => {
          const curRel = get().relationships.find((r) => r.id === relChipTargetId)
          if (!curRel) return
          if (!capturedIsEntityNode) {
            // Add entity to the scene if not already present
            const entity = useEntitiesStore.getState().getEntityById(entityId)
            if (entity) {
              const updNodes = addOrphanedChipToNode(get().nodes, capturedTarget, entity)
              if (updNodes !== get().nodes) set({ nodes: updNodes })
            }
            // Flow wire: source → chip-in-{entityId} (makes chip non-orphaned).
            // Only when source and target are different nodes (avoid self-loop on same scene).
            if (capturedSource !== capturedTarget) {
              const hasFlow = get().edges.some(
                (e) => e.target === capturedTarget && !e.data?.is_relationship && e.data?.source_entity_id === entityId
              )
              if (!hasFlow) {
                // Enforce the chip soft-limit: a chip has at most one outgoing narrative-flow
                // wire. Strip any pre-existing flow wire from the same source chip before
                // adding the new one (matches the user's intent when redirecting the chain
                // forward via a rel-input drag).
                const preFilteredEdges = get().edges.filter((e) =>
                  !(e.source === capturedSource &&
                    e.sourceHandle === capturedSourceHandle &&
                    !e.data?.is_relationship &&
                    !e.data?.is_pov_path)
                )
                const flowId = `flow-${capturedSource}-${capturedTarget}-${entityId}`
                set({
                  edges: [...preFilteredEdges, {
                    id: flowId,
                    source: capturedSource,
                    ...(capturedSourceHandle ? { sourceHandle: capturedSourceHandle } : {}),
                    target: capturedTarget,
                    targetHandle: `chip-in-${entityId}`,
                    type: 'transitionEdge',
                    data: {
                      id: flowId,
                      source_node_id: capturedSource,
                      target_node_id: capturedTarget,
                      source_entity_id: entityId,
                      target_entity_id: null,
                      transition_text: '',
                      entity_ids: [entityId],
                      is_pov_path: false,
                      target_handle_id: `chip-in-${entityId}`,
                    },
                  }],
                  hasUnsavedChanges: true,
                })
              }
            }
          }
          // Rel-wire creation — only for wires targeting a rel-in handle on
          // an EntityNode (faction-membership rel). Wires to a rel chip's
          // rel-in on a scene (sceneNode) are intentionally NOT kept:
          // the wiring gesture triggered addParticipant above, and the rel
          // chip + its participants-at-scene state are the authoritative UI
          // surfaces going forward. A persistent wire terminating on a
          // scene-level rel chip was misleading and inconsistent with the
          // "wire = chain anchor" semantic (design decision post v0.1.18.132).
          if (capturedIsEntityNode && capturedSource !== capturedTarget) {
            // `addParticipant`'s `_syncOriginWireForRel` already created
            // the entity-origin → faction-origin rel wire (matching
            // `rel-wire-{relId}-{entityId6}` shape with target handle
            // `rel-in-{relId}`). Patch it with the captured drag
            // sourceHandle so the wire visually anchors to the exact
            // port the user dragged from. Idempotent: returns silently
            // if no helper wire exists (e.g. entity has no canvas
            // origin) or if the handle is already what we want.
            const edges = get().edges
            const idx = edges.findIndex(
              (e) => e.data?.is_relationship
                  && e.data?.relationship_id === curRel.id
                  && e.target === capturedTarget
                  && e.targetHandle === capturedTargetHandle,
            )
            if (idx >= 0) {
              const cur = edges[idx]
              const wantSrc = capturedSourceHandle || undefined
              if (cur.sourceHandle !== wantSrc) {
                const patched = wantSrc
                  ? { ...cur, sourceHandle: wantSrc }
                  : (() => { const { sourceHandle: _sourceHandle, ...rest } = cur; return rest })()
                const next = [...edges]
                next[idx] = patched
                set({ edges: next })
              }
            }
          }
        })
      }
      return
    }

    // Case 2: Entity origin/modifier node → chip inside a SceneNode.
    // SAME-ENTITY EXCEPTION: if the source entity matches the target chip's entity, this
    // is the user wiring an entity into its own chip to establish/repair the narrative chain
    // for an orphaned chip. Fall through to the normal flow wire path with targetHandle cleared.
    // Cross-entity wiring is now handled via the relationship editor, not via canvas wiring.
    if (
      sourceNode?.type === 'entityNode' &&
      targetNode?.type === 'sceneNode' &&
      getChipEntityId(params.targetHandle)
    ) {
      const entityAId = sourceEntityId
      const entityBId = getChipEntityId(params.targetHandle)
      if (entityAId && entityBId && entityAId === entityBId) {
        // Same-entity: resolve orphan by treating as a flow wire
        params = { ...params, targetHandle: undefined }
        // Fall through to the normal flow wire creation below
      } else if (entityAId && entityBId) {
        // Cross-entity: create relationship with both entities joining at the target scene.
        // Also adds entity A to the scene and creates the relationship wire.
        // Exception: if entity B is a faction with a membership relationship, prompt first.
        const targetEntity = useEntitiesStore.getState().getEntityById(entityBId)
        if (targetEntity?.type === 'faction') {
          const membershipRel = get().relationships.find((r) => r.membership_of === entityBId)
          if (membershipRel) {
            const sourceEntity = useEntitiesStore.getState().getEntityById(entityAId)
            useUiStore.getState().openFactionMemberPrompt({
              sourceEntityId: entityAId,
              sourceEntityName: sourceEntity?.name || 'Entity',
              targetEntityId: entityBId,
              factionName: targetEntity.name || 'Faction',
              membershipRelId: membershipRel.id,
              sourceNodeId: params.source,
              targetNodeId: params.target,
              capturedSourceHandle: params.sourceHandle || null,
              context: 'entityToSceneChip',
            })
            return
          }
        }
        const capturedSource = params.source
        const capturedTarget = params.target
        // Duplicate guard (scene variant): compare proposed participants against
        // each existing rel's effective state at `capturedTarget`. Skip rels whose
        // chain doesn't reach this scene or that are inactive there.
        const dupCheck2 = await checkDuplicateRelAndConfirm([entityAId, entityBId], 'scene', capturedTarget)
        if (!dupCheck2.ok) return
        get().createRelationship({
          history: {
            existence_changes: [],
            participant_changes: [
              { node_id: capturedTarget, action: 'join', entity_id: entityAId, initial_perception: '', initial_alias_override: null },
              { node_id: capturedTarget, action: 'join', entity_id: entityBId, initial_perception: '', initial_alias_override: null },
            ],
            perception_changes: [], alias_changes: [], role_changes: [], hierarchy_changes: [],
          },
        }).then((rel) => {
          if (!rel) return
          // Add entity A (the origin/modifier node entity) to the target scene if absent
          const entityA = useEntitiesStore.getState().getEntityById(entityAId)
          if (entityA) {
            const updNodes = addOrphanedChipToNode(get().nodes, capturedTarget, entityA)
            if (updNodes !== get().nodes) set({ nodes: updNodes })
          }
          // Flow wire: source → chip-in-{entityAId} (makes entity A non-orphaned in the scene)
          const flowWireId = `flow-${capturedSource}-${capturedTarget}-${entityAId}`
          const edsAfterNode = get().edges.filter(
            (e) => !(e.target === capturedTarget && !e.data?.is_relationship && e.data?.source_entity_id === entityAId)
          )
          // Relationship wire: source → rel-in-{rel.id}
          set({
            edges: [
              ...edsAfterNode,
              {
                id: flowWireId,
                source: capturedSource,
                target: capturedTarget,
                targetHandle: `chip-in-${entityAId}`,
                type: 'transitionEdge',
                data: {
                  id: flowWireId,
                  source_node_id: capturedSource,
                  target_node_id: capturedTarget,
                  source_entity_id: entityAId,
                  target_entity_id: null,
                  transition_text: '',
                  entity_ids: [entityAId],
                  is_pov_path: false,
                  target_handle_id: `chip-in-${entityAId}`,
                },
              },
              // No rel-wire into the scene-level rel chip. Design decision
              // post v0.1.18.132: wires only persist into relationship origin
              // nodes; wires from an entity into a rel chip on a scene are
              // an action-trigger only (the join is recorded above; the chip
              // is the authoritative UI surface going forward).
            ],
            hasUnsavedChanges: true,
          })
          if (dupCheck2.hadMatch) useUiStore.getState().openRelationshipDetail(rel.id, capturedTarget)
        })
        return
      } else {
        return
      }
    }

    // Case 3: Chip → chip in the SAME SceneNode — create a relationship between the two entities.
    if (
      sourceNode?.type === 'sceneNode' &&
      targetNode?.type === 'sceneNode' &&
      params.source === params.target &&
      params.sourceHandle &&
      getChipEntityId(params.targetHandle)
    ) {
      const entityAId = params.sourceHandle
      const entityBId = getChipEntityId(params.targetHandle)
      if (entityAId && entityBId && entityAId !== entityBId) {
        const sceneId = params.source
        // Duplicate guard (scene variant): compare against effective state at this scene.
        const dupCheck3 = await checkDuplicateRelAndConfirm([entityAId, entityBId], 'scene', sceneId)
        if (!dupCheck3.ok) return
        get().createRelationship({
          history: {
            existence_changes: [],
            participant_changes: [
              { node_id: sceneId, action: 'join', entity_id: entityAId, initial_perception: '', initial_alias_override: null },
              { node_id: sceneId, action: 'join', entity_id: entityBId, initial_perception: '', initial_alias_override: null },
            ],
            perception_changes: [],
            alias_changes: [],
            role_changes: [],
            hierarchy_changes: [],
          },
        }).then((rel) => {
          if (!rel) return
          // Same-scene: relationship chip appears as a visual indicator; no looping wire drawn
          set({ hasUnsavedChanges: true })
          if (dupCheck3.hadMatch) useUiStore.getState().openRelationshipDetail(rel.id, sceneId)
        })
      }
      return
    }

    // Case 4: Chip → chip in a DIFFERENT SceneNode.
    // SAME-ENTITY EXCEPTION: if the source chip and target chip represent the same entity,
    // this is the user connecting an orphaned chip to its upstream state (establishing the
    // narrative chain link). Treat as a narrative flow wire — clear targetHandle so the
    // flow wire targets the scene's main input and fall through to the normal flow code.
    // Cross-entity chip-to-chip cross-scene wiring is handled via the relationship editor.
    if (
      sourceNode?.type === 'sceneNode' &&
      targetNode?.type === 'sceneNode' &&
      params.source !== params.target &&
      params.sourceHandle &&
      getChipEntityId(params.targetHandle)
    ) {
      const entityAId = params.sourceHandle
      const entityBId = getChipEntityId(params.targetHandle)
      if (entityAId && entityBId && entityAId === entityBId) {
        // Same-entity cross-scene: resolve orphan by treating as a flow wire
        params = { ...params, targetHandle: undefined }
        // Fall through to the normal flow wire creation below
      } else {
        // Cross-entity cross-scene: entityA is added to the target scene, making this
        // effectively same-scene after the fact. Both participants join at the target scene.
        // A flow wire links the source chip to chip-in-{entityAId} in the target.
        // No rel-wire is drawn (same-scene behaviour).
        if (entityAId && entityBId) {
          const capturedSource = params.source
          const capturedSourceHandle = params.sourceHandle
          const capturedTarget = params.target
          // Duplicate guard (scene variant): compare against effective state at the target scene.
          const dupCheck4 = await checkDuplicateRelAndConfirm([entityAId, entityBId], 'scene', capturedTarget)
          if (!dupCheck4.ok) return
          get().createRelationship({
            history: {
              existence_changes: [],
              participant_changes: [
                { node_id: capturedTarget, action: 'join', entity_id: entityAId, initial_perception: '', initial_alias_override: null },
                { node_id: capturedTarget, action: 'join', entity_id: entityBId, initial_perception: '', initial_alias_override: null },
              ],
              perception_changes: [],
              alias_changes: [],
              role_changes: [],
              hierarchy_changes: [],
            },
          }).then((rel) => {
            if (!rel) return
            const entityA = useEntitiesStore.getState().getEntityById(entityAId)
            let updNodes = get().nodes
            if (entityA) {
              updNodes = addOrphanedChipToNode(updNodes, capturedTarget, entityA)
            }
            const flowId = `flow-${capturedSource}-${capturedTarget}-${entityAId}`
            const updEdges = [
              ...get().edges.filter((e) => !(e.source === capturedSource && !e.data?.is_relationship && !e.data?.is_pov_path && e.data?.source_entity_id === entityAId)),
              {
                id: flowId,
                source: capturedSource,
                sourceHandle: capturedSourceHandle,
                target: capturedTarget,
                targetHandle: `chip-in-${entityAId}`,
                type: 'transitionEdge',
                data: { id: flowId, source_node_id: capturedSource, target_node_id: capturedTarget, source_entity_id: entityAId, is_pov_path: false, target_handle_id: `chip-in-${entityAId}` },
              },
            ]
            set({ nodes: updNodes, edges: updEdges, hasUnsavedChanges: true })
            if (dupCheck4.hadMatch) useUiStore.getState().openRelationshipDetail(rel.id, capturedTarget)
          })
        }
        return
      }
    }

    // ── Cycle detection — narrative flow only ────────────────────────────────
    // Relationship wires are handled above and return early, so by this point
    // we are always creating a narrative-flow edge. Block it if it would form
    // a directed cycle in the flow graph (e.g. A → B → A).
    if (wouldCreateCycle(edges, params.source, params.target)) {
      confirm({
        title: 'Cannot create connection',
        message:
          'Cannot create this connection — it would create a loop in the narrative flow.\n\n' +
          'Narrative flow must move forward. Check your existing connections and remove any that already link these nodes in the opposite direction.',
        buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
      })
      return
    }

    // Block wires that contradict tier-1 (POV chain) or tier-2 (connected
    // entity chain) ordering established by the global story order. Tiers
    // 3-11 are inferred / tiebreaker signals and may be overridden by the
    // very wire the user is trying to make — we do not block on those.
    if (_checkContradictsStoryOrder(get, params.source, params.target)) return

    // Soft limit: one outgoing narrative-flow connection per entity chip handle.
    // Replace the existing flow edge rather than blocking the new one.
    // Relationship wires from the same chip handle are exempt — they are not narrative chain
    // connections and must not be removed when a flow wire is added or replaced.
    let filteredEdges = edges
    if (sourceEntityId && params.sourceHandle) {
      filteredEdges = edges.filter(
        (e) => !(
          e.source === params.source &&
          !e.data?.is_relationship &&
          (e.sourceHandle === params.sourceHandle || e.data?.source_entity_id === params.sourceHandle)
        )
      )
    }

    // Soft limit: one outgoing narrative-flow connection per EntityNode.
    // Same behaviour: replace the existing flow edge.
    // Relationship wires from the same entity node are exempt — same reason as above.
    if (!params.sourceHandle && sourceNode?.type === 'entityNode') {
      filteredEdges = filteredEdges.filter((e) => e.source !== params.source || e.data?.is_relationship)
    }

    // Convergence guard: one incoming narrative-flow connection per entity per target node.
    // If entity X already has an incoming flow wire to the target, remove the old wire
    // so the new one replaces it (prevents ambiguous upstream state).
    if (sourceEntityId) {
      filteredEdges = filteredEdges.filter(
        (e) => !(
          e.target === params.target &&
          !e.data?.is_relationship &&
          e.data?.source_entity_id === sourceEntityId
        )
      )
    }

    // Auto-create EntityRef in target SceneNode when an entity is being carried.
    // Also: assign entity_id to a blank modifier node when first wired.
    // Re-resolve targetNode from current `nodes` — Case 2 may have updated nodes above.
    const resolvedTarget = nodes.find((n) => n.id === params.target)
    let updatedNodes = nodes
    let chipTargetHandle = null
    if (sourceEntityId) {
      if (resolvedTarget?.type === 'entityNode' && resolvedTarget.data.is_modifier && !resolvedTarget.data.entity_id) {
        // Blank modifier node — assign the incoming entity
        updatedNodes = nodes.map((n) =>
          n.id === params.target
            ? { ...n, data: { ...n.data, entity_id: sourceEntityId } }
            : n
        )
      } else if (resolvedTarget?.type === 'sceneNode' && !resolvedTarget.data?.is_flashback) {
        const entity = useEntitiesStore.getState().getEntityById(sourceEntityId)
        if (entity) {
          const bucketMap = { character: 'characters', location: 'locations', item: 'items', faction: 'factions', custom: 'customs' }
          const bucket = bucketMap[entity.type]
          if (bucket) {
            chipTargetHandle = `chip-in-${sourceEntityId}`
            const currentRefs = resolvedTarget.data[bucket] || []
            if (!currentRefs.some((r) => r.entity_id === sourceEntityId)) {
              const newRef = {
                entity_id: sourceEntityId,
                name_change: null, colour_change: null,
                description_change: null, profile_image_change: null,
                attribute_changes: [],
                awareness_changes: [],
                has_pov: false,
              }
              updatedNodes = nodes.map((n) =>
                n.id === params.target
                  ? { ...n, data: { ...n.data, [bucket]: [...currentRefs, newRef] } }
                  : n
              )
            }
          }
        }
      }
    }

    set({
      nodes: updatedNodes,
      edges: addEdge(
        {
          ...params,
          id,
          type: 'transitionEdge',
          ...(chipTargetHandle ? { targetHandle: chipTargetHandle } : {}),
          data: {
            id,
            source_node_id: params.source,
            target_node_id: params.target,
            source_entity_id: sourceEntityId,
            target_entity_id: null,
            transition_text: '',
            entity_ids: sourceEntityId ? [sourceEntityId] : [],
            is_pov_path: false,
            ...(chipTargetHandle ? { target_handle_id: chipTargetHandle } : {}),
          },
        },
        filteredEdges,
      ),
    })
  },

  addSceneNode: (position) => {
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 150 + Math.random() * 300, y: 80 + Math.random() * 200 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'sceneNode',
          position: pos,
          data: { id, node_type: 'scene', title: '', description: '', main_content: '', position: pos, characters: [], locations: [], items: [], factions: [], customs: [] },
        },
      ],
    })
    // Return the new scene's id so callers can chain follow-up
    // mutations (e.g. set its title, add chips). Original caller
    // (AddNodesMenuBody) ignores the return; safe additive change.
    return id
  },

  addFlashbackNode: (position) => {
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 150 + Math.random() * 300, y: 80 + Math.random() * 200 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'sceneNode',
          position: pos,
          data: {
            id, node_type: 'scene', title: '', description: '', main_content: '',
            position: pos, characters: [], locations: [], items: [], factions: [], customs: [],
            is_flashback: true, parent_scene_id: null,
          },
        },
      ],
    })
  },

  addReferenceNode: (position, subType, extraData) => {
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 150 + Math.random() * 300, y: 80 + Math.random() * 200 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'referenceNode',
          position: pos,
          data: {
            id, node_type: 'reference', sub_type: subType,
            // Phase 8.1 , concept nodes default to a distinct lime so they read
            // apart from the cyan reference notes/media; notes/media keep #40afd0.
            title: '', colour: subType === 'concept' ? '#a3e635' : '#40afd0', content: '', file_ref: null, position: pos,
            ...(extraData || {}),
          },
        },
      ],
    })
    return id
  },

  /**
   * Phase 8.5 — programmatically wire two concept-layer nodes (concept nodes or
   * concept groups) with a `conceptEdge`, mirroring the GUI drag path in
   * `onConnect`'s concept branch. This is the MCP `wire_concepts` path: the AI
   * names the two nodes and the app picks the facing ports + builds the edge.
   * Idempotent on the (source, target) node PAIR regardless of which ports (so
   * re-wiring the same two nodes returns the existing wire's id). Concept edges
   * live in the free-form concept layer, off the narrative chain. Returns the
   * edge id, or null if either node is missing / they are the same node.
   */
  addConceptEdge: (sourceId, targetId) => {
    if (!sourceId || !targetId || sourceId === targetId) return null
    const { nodes, edges } = get()
    const src = nodes.find((n) => n.id === sourceId)
    const tgt = nodes.find((n) => n.id === targetId)
    if (!src || !tgt) return null
    // Idempotent on the node pair (either direction) — one concept wire between
    // two nodes, matching how the closed-world concept layer reads.
    const existing = edges.find(
      (e) => e.type === 'conceptEdge'
        && ((e.source === sourceId && e.target === targetId) || (e.source === targetId && e.target === sourceId)),
    )
    if (existing) return existing.id
    const [sKey, tKey] = shortestConceptPorts(src, tgt)
    const sourceHandle = `concept-${sKey}`
    const targetHandle = `concept-${tKey}`
    const id = `concept-${sourceId}-${sourceHandle}-${targetId}-${targetHandle}`
    if (edges.some((e) => e.id === id)) return id
    get()._snapshot()
    const conceptEdge = {
      id,
      source: sourceId,
      target: targetId,
      sourceHandle,
      targetHandle,
      type: 'conceptEdge',
      data: {
        id, kind: 'concept',
        source_node_id: sourceId, target_node_id: targetId,
        source_handle_id: sourceHandle, target_handle_id: targetHandle,
      },
    }
    set({ edges: [...get().edges, conceptEdge], hasUnsavedChanges: true })
    return id
  },

  /**
   * Phase 8.5 — remove every concept wire between two concept-layer nodes
   * (either direction). The MCP `unwire_concepts` path. Returns the count removed.
   */
  removeConceptEdge: (sourceId, targetId) => {
    const { edges } = get()
    const toRemove = edges.filter(
      (e) => e.type === 'conceptEdge'
        && ((e.source === sourceId && e.target === targetId) || (e.source === targetId && e.target === sourceId)),
    )
    if (toRemove.length === 0) return 0
    get()._snapshot()
    const removeIds = new Set(toRemove.map((e) => e.id))
    set({ edges: edges.filter((e) => !removeIds.has(e.id)), hasUnsavedChanges: true })
    return toRemove.length
  },

  /**
   * Phase 8.5 item 459 — write a computed concept-layer tidy layout.
   * `positions` is a Map id -> {x,y} (top-left) containing ONLY the movable ids
   * the caller's pure `computeConceptTidyLayout` produced, so isolation (never
   * move a user-placed node) is enforced upstream — this action only applies
   * what it's handed.
   *
   * `opts.snapshot` (default true): when false the write folds into the
   * caller's existing snapshot (e.g. the wire that triggered the tidy) so a
   * single undo reverts the wire AND its layout together; the standalone
   * `tidy_concepts` tool leaves it true so its reflow is its own undo step.
   */
  applyConceptLayout: (positions, { snapshot = true } = {}) => {
    if (!positions || positions.size === 0) return 0
    if (snapshot) get()._snapshot()
    const nodes = get().nodes.map((n) => {
      const p = positions.get(n.id)
      return p ? { ...n, position: { x: p.x, y: p.y } } : n
    })
    // Re-face every concept wire touching a moved node so it exits/enters the
    // CLOSEST ports for the new positions. The wire's ports were chosen when it
    // was drawn (before the tidy moved the nodes), so without this they all
    // point the same way and the wiring reads messy. The edge id stays stable
    // (idempotency is by node pair) so React Flow re-routes rather than remounts.
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const edges = get().edges.map((e) => {
      if (e.type !== 'conceptEdge') return e
      if (!positions.has(e.source) && !positions.has(e.target)) return e
      const src = nodeById.get(e.source), tgt = nodeById.get(e.target)
      if (!src || !tgt) return e
      const [sKey, tKey] = shortestConceptPorts(src, tgt)
      const sourceHandle = `concept-${sKey}`, targetHandle = `concept-${tKey}`
      if (sourceHandle === e.sourceHandle && targetHandle === e.targetHandle) return e
      return {
        ...e,
        sourceHandle, targetHandle,
        data: { ...e.data, source_handle_id: sourceHandle, target_handle_id: targetHandle },
      }
    })
    set({ nodes, edges, hasUnsavedChanges: true })
    return positions.size
  },

  /**
   * Phase 8.4 (Convert To) — flip a reference node between the 'note' and
   * 'concept' sub_types in place. Reference / concept nodes are canvas
   * annotations with no backing first-class object and no chain history, so
   * this is a plain sub_type mutation, not an origin-node convert.
   *
   *   - note → concept is purely additive: the node keeps its title / body /
   *     colour / tags and simply gains the eight concept ports.
   *   - concept → note hides the concept ports, so any concept wires anchored
   *     to this node would dangle; they are auto-stripped here (edges with
   *     data.kind === 'concept' touching this node, the same shape the delete
   *     path removes). Callers warn the user first when wires exist.
   *
   * One `_snapshot()` = one undo step (undo restores the sub_type AND any
   * stripped concept wires). Colour is left as-is (user data): a note left on
   * the default cyan is not auto-recoloured to the concept lime. Media stays
   * out of scope. Also exposed for the Phase 8.5 MCP convert tool.
   */
  convertReferenceNodeSubType: (nodeId, targetSubType) => {
    if (targetSubType !== 'note' && targetSubType !== 'concept') return
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'referenceNode') return
    const current = node.data?.sub_type || 'note'
    if (current === targetSubType) return
    if (current !== 'note' && current !== 'concept') return  // media not convertible here
    get()._snapshot()
    // Downgrade concept → note: strip this node's concept wires (they anchor to
    // ports that stop rendering once the node is a plain note).
    const edges = targetSubType === 'note'
      ? get().edges.filter((e) => !(e.data?.kind === 'concept' && (e.source === nodeId || e.target === nodeId)))
      : get().edges
    const nodes = get().nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, sub_type: targetSubType } } : n,
    )
    set({ nodes, edges, hasUnsavedChanges: true })
  },

  /**
   * Phase 8.4 (Convert To) — convert an entity from one subtype to another
   * (character / location / item / faction / custom), KEEPING THE SAME ID. The
   * entity is MOVED between the library + scene buckets, not deleted, so every
   * by-id reference (scene chips, awareness observers, entity_list values,
   * relationship participants, connection endpoints) stays valid.
   *
   * Local-state only: the backend `PUT /entities/{id}` cannot re-bucket a type
   * change, so the full-story save is the real sync path (consistent with the
   * `_sweep*` / `_restore*` local-mutation convention).
   *
   * Reconciles the type-gated fields for the cases handled here:
   *   - leaving character: drops `has_pov` on the moved chip, nulls
   *     `pov_entity_id` on scenes it was POV of, and nulls `Story.pov_character_id`
   *     if it matched. This DETACHES the character from those scenes' POV without
   *     removing them from the POV path: the POV-chain (`is_pov_path`) edges are
   *     scene-to-scene and are deliberately left untouched, so each scene keeps its
   *     place and order on the path (now with a null `pov_entity_id`, an unattached
   *     POV). Do NOT strip POV wires here (that would push the scenes off-screen).
   *   - leaving location: reparents children to the grandparent
   *     (`options.locationChildren === 'clear'` clears them instead) and clears
   *     the entity's own `parent_id`.
   *   - custom: sets `category_id` (`options.categoryId`) on enter, clears on leave.
   *
   * One `_snapshot()` = one undo step via the `_entitiesBucketsBefore` +
   * `_storyPovBefore` extras.
   *
   * DEFERRED to a follow-up in this slice (guarded out below for now):
   *   - faction enter / leave (the Members `membership_of` relationship).
   *   - perspective attributes elsewhere that TARGET this entity keep a stale
   *     `perspective_target_kind` after the type change (the id still resolves);
   *     tracked as a Phase 8.4 Bugs & Fixes item.
   *
   * `options` also drives the Phase 8.5 MCP convert tool.
   */
  convertEntityType: (entityId, targetType, options = {}) => {
    if (!ENTITY_BUCKET_MAP[targetType]) return
    const es = useEntitiesStore.getState()
    const entity = es.getEntityById(entityId)
    if (!entity) return
    const sourceType = entity.type
    if (sourceType === targetType) return
    if (!ENTITY_BUCKET_MAP[sourceType]) return
    const oldBucketKey = ENTITY_BUCKET_MAP[sourceType]
    const newBucketKey = ENTITY_BUCKET_MAP[targetType]
    const leavingCharacter = sourceType === 'character'
    const leavingLocation = sourceType === 'location'
    const enteringFaction = targetType === 'faction'
    const leavingFaction = sourceType === 'faction'

    // The entity's origin EntityNode — where a new faction's Members relationship
    // is anchored (its `membership_of` rel activates here).
    const originNodeId = get().nodes.find(
      (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId,
    )?.id || null

    // ── Capture pre-state for the undo extras ──
    const _entitiesBucketsBefore = _captureEntityBuckets()
    const story = get().story
    const _storyPovBefore = story?.pov_character_id ?? null

    get()._snapshot({ _entitiesBucketsBefore, _storyPovBefore })

    // ── projectStore nodes: move the entity's EntityRef between scene buckets;
    //    leaving character drops has_pov on the moved chip + nulls pov_entity_id. ──
    const nodes = get().nodes.map((n) => {
      if (n.type !== 'sceneNode') return n
      let d = n.data
      let changed = false
      const oldRefs = d[oldBucketKey] || []
      const idx = oldRefs.findIndex((r) => r.entity_id === entityId)
      if (idx >= 0) {
        let ref = oldRefs[idx]
        if (leavingCharacter && ref.has_pov) ref = { ...ref, has_pov: false }
        d = {
          ...d,
          [oldBucketKey]: oldRefs.filter((_, i) => i !== idx),
          [newBucketKey]: [...(d[newBucketKey] || []), ref],
        }
        changed = true
      }
      if (leavingCharacter && d.pov_entity_id === entityId) {
        d = { ...d, pov_entity_id: null }
        changed = true
      }
      return changed ? { ...n, data: d } : n
    })

    const patch = { nodes, hasUnsavedChanges: true }
    if (leavingCharacter && story && story.pov_character_id === entityId) {
      patch.story = { ...story, pov_character_id: null }
    }

    // ── Faction Members relationship (the one non-bucket-move case) ──
    // Entering a faction requires a Members relationship (create / adopt / copy);
    // leaving one disposes of its existing Members relationship (convert to a
    // normal relationship, or delete). All inline so the whole conversion stays a
    // single undo step; the relationship side is covered by the auto `_snapshot`
    // (`_relationshipsBefore` + nodes/edges) and any entity-side awareness/perspective
    // sweep by the `_entitiesBucketsBefore` extra. Save-time `PUT /story` syncs.
    let relDeleteId = null
    if (enteringFaction) {
      const fm = options.factionMembers || {}
      const mode = fm.mode || 'create'
      let rels = get().relationships
      if (mode === 'adopt' && fm.sourceRelId) {
        rels = rels.map((r) => (r.id === fm.sourceRelId ? _adoptRelAsMembership(r, entityId) : r))
      } else if (mode === 'copy' && fm.sourceRelId) {
        const src = rels.find((r) => r.id === fm.sourceRelId)
        rels = src ? [...rels, _cloneRelAsMembership(src, entityId, entity.name, originNodeId)] : rels
      } else {
        rels = [...rels, _newFactionMembershipRel(entityId, entity.name, originNodeId)]
      }
      patch.relationships = rels
    } else if (leavingFaction) {
      const memRel = get().relationships.find((r) => r.membership_of === entityId)
      if (memRel) {
        if (options.factionLeave === 'delete') {
          const stripped = _stripReferencesToRelationship(
            { ...get(), nodes: patch.nodes, edges: get().edges, relationships: get().relationships },
            memRel.id,
          )
          patch.relationships = stripped.relationships
          patch.nodes = stripped.nodes
          patch.edges = stripped.edges
          relDeleteId = memRel.id
        } else {
          // Default: demote the Members relationship to a normal relationship.
          patch.relationships = get().relationships.map((r) =>
            r.id === memRel.id ? { ...r, membership_of: null } : r,
          )
        }
      }
    }
    if (patch.relationships) {
      const { byEntity, byScene } = _buildRelIndexes(patch.relationships)
      patch.relationshipsByEntity = byEntity
      patch.relationshipsByScene = byScene
    }
    set(patch)

    // Entity-side cleanup for a deleted Members relationship (awareness refs +
    // perspective targets that pointed at it). Local mutations, undo-covered by
    // `_entitiesBucketsBefore`. Mirrors `_deleteRelationshipInternal`.
    if (relDeleteId) {
      es._sweepStaleRelationshipReferencesFromEntities(relDeleteId)
      es._sweepStalePerspectiveTargetsFromEntities(_PERSPECTIVE_RELATIONSHIP_KINDS, relDeleteId)
    }

    // ── entitiesStore: bucket move + reconciled type-gated fields ──
    const newEntity = {
      ...entity,
      type: targetType,
      // parent_id is location-only; a converted-away location clears it, and a
      // converted-in entity had none.
      parent_id: targetType === 'location' ? (entity.parent_id ?? null) : null,
      // category_id is custom-only.
      category_id: targetType === 'custom' ? (options.categoryId ?? null) : null,
    }
    es._removeEntity(oldBucketKey, entityId)
    es._restoreEntity(newBucketKey, newEntity)

    // Leaving location: reparent children (parent_id === entityId) to the
    // grandparent (this location's own parent), or clear them if requested.
    if (leavingLocation) {
      const reparentTo = options.locationChildren === 'clear' ? null : (entity.parent_id ?? null)
      const locs = useEntitiesStore.getState().locations || []
      let anyChild = false
      const newLocs = locs.map((loc) => {
        if (loc.parent_id === entityId) { anyChild = true; return { ...loc, parent_id: reparentTo } }
        return loc
      })
      if (anyChild) useEntitiesStore.setState({ locations: newLocs })
    }
  },

  /**
   * Phase 8.4 — Convert a Knowledge into an Entity (directional; the lossy
   * reverse is out of scope). A cross-model migration: the Knowledge (a top-
   * level object with inline history, rendered as an output-only
   * `knowledgeOriginNode`) becomes an Entity (bucketed, with an origin
   * `entityNode` and history distributed across scene EntityRefs).
   *
   * Clean carries (verbatim): id, name, description, colour, profile_image_ref,
   * notes, tag_ids, awareness (+ awareness_scale — kept at the Knowledge's
   * value rather than the Entity default so no precision is lost). Dropped (no
   * Entity analogue — surfaced as losses in the modal): source_event, the
   * existence lifecycle, source-event re-bindings, manual_anchors, and every
   * knowledge_id forward-pointer (left dangling, which the app tolerates). The
   * ONE reference rewritten (not dropped) is a perspective attribute whose
   * target was this knowledge: its kind flips to the new subtype and the id is
   * kept (the entity reuses the knowledge id).
   *
   * History re-expression: each mappable KnowledgeHistory change maps to an
   * EntityRef scalar change on its scene (name/description/colour/profile_image
   * + tag_changes). Population modes:
   *   - 'auto'     : baseline + a wired chip at each change-scene, story order.
   *   - 'orphaned' : baseline + a chip at each change-scene, unwired.
   *   - 'origin'   : baseline entity only; downstream changes discarded.
   * A baseline-only Knowledge (no mappable history) needs no chain either way.
   *
   * Local-state only + one undo step: `_entitiesBucketsBefore` covers the
   * entity add + perspective rewrite on entities; the auto `_snapshot` covers
   * knowledges / nodes / edges. Save-time full-story PUT syncs the backend.
   *
   * options: { categoryId?, population?: 'auto'|'orphaned'|'origin', factionMembers? }
   */
  convertKnowledgeToEntity: (knowledgeId, targetType, options = {}) => {
    if (!ENTITY_BUCKET_MAP[targetType]) return
    const knowledge = get().knowledges.find((k) => k.id === knowledgeId)
    if (!knowledge) return
    const es = useEntitiesStore.getState()
    const bucketKey = ENTITY_BUCKET_MAP[targetType]
    const population = options.population || 'auto'

    const _entitiesBucketsBefore = _captureEntityBuckets()
    get()._snapshot({ _entitiesBucketsBefore })

    // ── 1. Build the new Entity (clean carries + awareness verbatim) ──
    const newEntity = {
      id: knowledge.id,
      type: targetType,
      name: knowledge.name,
      colour: knowledge.colour ?? '#888888',
      description: knowledge.description ?? '',
      attributes: [],
      parent_id: null,
      category_id: targetType === 'custom' ? (options.categoryId ?? null) : null,
      profile_image_ref: knowledge.profile_image_ref ?? null,
      aliases: [],
      tag_ids: [...(knowledge.tag_ids || [])],
      notes: knowledge.notes ?? '',
      awareness: knowledge.awareness ?? null,
      awareness_scale: knowledge.awareness_scale || 'full',
      name_awareness: null,
    }

    // ── 2. Node swap: drop the knowledge + its origin node + outbound wires. ──
    const knowledgeNode = get().nodes.find(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId,
    )
    const originPos = knowledgeNode?.position ? { ...knowledgeNode.position } : { x: 0, y: 0 }
    const knowledgeNodeIds = new Set(
      get().nodes
        .filter((n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId)
        .map((n) => n.id),
    )
    let nodes = get().nodes.filter((n) => !knowledgeNodeIds.has(n.id))
    let edges = get().edges.filter((e) => !knowledgeNodeIds.has(e.source) && !knowledgeNodeIds.has(e.target))
    const knowledges = get().knowledges.filter((k) => k.id !== knowledgeId)

    // ── 3. Origin EntityNode (where the old knowledge node sat). ──
    const originNodeId = crypto.randomUUID()
    nodes = [...nodes, {
      id: originNodeId, type: 'entityNode', position: originPos,
      data: { id: originNodeId, entity_id: knowledge.id, node_type: 'entity' },
    }]

    // ── 4. Population: synthesise EntityRef chips + wires per mode. ──
    if (population !== 'origin') {
      const h = knowledge.history || {}
      const perScene = new Map()
      const bagFor = (nid) => { if (!perScene.has(nid)) perScene.set(nid, {}); return perScene.get(nid) }
      for (const c of (h.name_changes || [])) bagFor(c.node_id).name_change = c.new_name
      for (const c of (h.description_changes || [])) bagFor(c.node_id).description_change = c.new_description
      for (const c of (h.colour_changes || [])) bagFor(c.node_id).colour_change = c.new_colour
      // Knowledge `new_profile_image_ref === null` = explicit clear → EntityRef "" (clear).
      for (const c of (h.profile_image_changes || [])) bagFor(c.node_id).profile_image_change = c.new_profile_image_ref ?? ''
      for (const c of (h.tag_changes || [])) {
        const bag = bagFor(c.node_id)
        if (!bag._tags) bag._tags = []
        bag._tags.push({ action: c.action, tag_id: c.tag_id })  // node_id is implicit on the EntityRef
      }
      // Only scenes that still exist as scene nodes.
      const changeSceneIds = [...perScene.keys()].filter(
        (nid) => nodes.some((n) => n.id === nid && n.type === 'sceneNode'),
      )
      const storyOrder = computeStoryOrder({ nodes, edges })
      const orderIndex = new Map((storyOrder.orderedIds || []).map((id, i) => [id, i]))
      changeSceneIds.sort((a, b) =>
        (orderIndex.has(a) ? orderIndex.get(a) : Infinity) - (orderIndex.has(b) ? orderIndex.get(b) : Infinity),
      )

      // Add a chip (EntityRef) at each change-scene.
      nodes = nodes.map((n) => {
        if (n.type !== 'sceneNode' || !perScene.has(n.id)) return n
        const existing = n.data[bucketKey] || []
        if (existing.some((r) => r.entity_id === knowledge.id)) return n
        const bag = perScene.get(n.id)
        const ref = {
          entity_id: knowledge.id,
          name_change: bag.name_change ?? null,
          colour_change: bag.colour_change ?? null,
          description_change: bag.description_change ?? null,
          profile_image_change: 'profile_image_change' in bag ? bag.profile_image_change : null,
          aliases_change: null,
          attribute_changes: [],
          awareness_changes: [],
          tag_changes: bag._tags || [],
          has_pov: false,
          review_fields: [],
        }
        return { ...n, data: { ...n.data, [bucketKey]: [...existing, ref] } }
      })

      // Auto-wire: origin → change-scenes, in story order.
      if (population === 'auto' && changeSceneIds.length > 0) {
        const chain = [originNodeId, ...changeSceneIds]
        const wires = []
        for (let i = 0; i < chain.length - 1; i++) {
          const src = chain[i], tgt = chain[i + 1]
          const eid = crypto.randomUUID()
          wires.push({
            id: eid, source: src, target: tgt, sourceHandle: null, type: 'transitionEdge',
            data: {
              id: eid, source_node_id: src, target_node_id: tgt,
              source_entity_id: knowledge.id, target_entity_id: null,
              transition_text: '', entity_ids: [knowledge.id], is_pov_path: false,
            },
          })
        }
        edges = [...edges, ...wires]
      }
      // 'orphaned': chips added above, no wires.
    }
    // 'origin': no chips, no wires — downstream changes discarded.

    // ── 5. Perspective rewrite on canvas nodes (kind 'knowledge' → subtype). ──
    nodes = _rewritePerspectiveKindInNodes(nodes, _PERSPECTIVE_KNOWLEDGE_KINDS, knowledgeId, targetType)

    // ── 5b. Target faction needs a mandatory Members relationship (create /
    //        adopt / copy) — same handling as an entity→faction conversion,
    //        anchored at the new entity origin node. ──
    const patch = { nodes, edges, knowledges, hasUnsavedChanges: true }
    if (targetType === 'faction') {
      const fm = options.factionMembers || {}
      const mode = fm.mode || 'create'
      let rels = get().relationships
      if (mode === 'adopt' && fm.sourceRelId) {
        rels = rels.map((r) => (r.id === fm.sourceRelId ? _adoptRelAsMembership(r, knowledge.id) : r))
      } else if (mode === 'copy' && fm.sourceRelId) {
        const src = rels.find((r) => r.id === fm.sourceRelId)
        rels = src ? [...rels, _cloneRelAsMembership(src, knowledge.id, knowledge.name, originNodeId)] : rels
      } else {
        rels = [...rels, _newFactionMembershipRel(knowledge.id, knowledge.name, originNodeId)]
      }
      patch.relationships = rels
      const { byEntity, byScene } = _buildRelIndexes(rels)
      patch.relationshipsByEntity = byEntity
      patch.relationshipsByScene = byScene
    }

    set(patch)

    // ── 6. entitiesStore: add the entity, then rewrite perspective attrs. ──
    es._restoreEntity(bucketKey, newEntity)
    const es2 = useEntitiesStore.getState()
    const bucketPatch = {}
    let entitiesTouched = false
    for (const b of ENTITY_BUCKETS) {
      const arr = es2[b] || []
      let changed = false
      const next = arr.map((ent) => {
        let a = false
        const nextAttrs = (ent.attributes || []).map((attr) => {
          if (attr.attribute_type === 'perspective' && attr.perspective_target_kind === 'knowledge' && attr.perspective_target_id === knowledgeId) {
            a = true
            return { ...attr, perspective_target_kind: targetType }
          }
          return attr
        })
        if (a) { changed = true; return { ...ent, attributes: nextAttrs } }
        return ent
      })
      if (changed) { bucketPatch[b] = next; entitiesTouched = true }
    }
    if (entitiesTouched) useEntitiesStore.setState(bucketPatch)
  },

  /**
   * Phase 8.4 — Batch convert a same-type multi-selection of entity origin
   * nodes to `targetType`, applying the SAME modal answers to each. One undo
   * step: a single snapshot up front, then the per-entity `convertEntityType`
   * calls run with `_snapshot` suppressed. `options` is the shared fork answer
   * set (e.g. one custom category for all, or faction Members `mode:'create'`
   * — adopt/copy are disabled in batch since they name one specific
   * relationship). Each entity's per-node targets (its own grandparent for a
   * location reparent, its own new Members relationship for a faction) are
   * resolved inside `convertEntityType` per entity.
   */
  convertEntitiesBatch: (entityIds, targetType, options = {}) => {
    if (!Array.isArray(entityIds) || entityIds.length === 0) return
    const _entitiesBucketsBefore = _captureEntityBuckets()
    const story = get().story
    const _storyPovBefore = story?.pov_character_id ?? null
    get()._snapshot({ _entitiesBucketsBefore, _storyPovBefore })
    _snapshotSuppressed = true
    try {
      for (const id of entityIds) get().convertEntityType(id, targetType, options)
    } finally {
      _snapshotSuppressed = false
    }
  },

  /**
   * Phase 8.4 — Batch convert a multi-selection of knowledge origin nodes to
   * `targetType` (all knowledges → same entity subtype), same shared answers,
   * one undo step. Mirror of `convertEntitiesBatch` over `convertKnowledgeToEntity`.
   */
  convertKnowledgesBatch: (knowledgeIds, targetType, options = {}) => {
    if (!Array.isArray(knowledgeIds) || knowledgeIds.length === 0) return
    const _entitiesBucketsBefore = _captureEntityBuckets()
    get()._snapshot({ _entitiesBucketsBefore })
    _snapshotSuppressed = true
    try {
      for (const id of knowledgeIds) get().convertKnowledgeToEntity(id, targetType, options)
    } finally {
      _snapshotSuppressed = false
    }
  },

  /** Phase 1.11 Track I — add an empty generic group container.
   *
   *  `position`, if supplied, is the group's TOP-LEFT corner in flow-space
   *  coordinates (matches every other node in the codebase — React Flow
   *  node positions are always top-left). `createGroupFromSelection` uses
   *  this path to place a group exactly where it computed the selection
   *  bbox.
   *
   *  When `position` is null (the toolbar "Add Group" path), the group is
   *  CENTRED on the current viewport centre instead, so clicking the
   *  toolbar button drops an empty box right in the middle of what the
   *  user is looking at. */
  addGroupNode: (position, { width = 400, height = 300, conceptGroup = true, title = '', colour = '#71717a' } = {}) => {
    get()._snapshot()
    const id = crypto.randomUUID()
    let pos
    if (position) {
      pos = { x: position.x, y: position.y }
    } else {
      const viewportCenter = useUiStore.getState()._getViewportCenter?.() || { x: 200, y: 200 }
      pos = { x: viewportCenter.x - width / 2, y: viewportCenter.y - height / 2 }
    }
    pos = applyCreationPositionSnap(pos, get().snapToGrid)
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'genericGroupNode',
          position: pos,
          style: { width, height },
          data: {
            id, node_type: 'generic_group',
            title, colour,
            position: pos, width, height,
            // Phase 8.5 — new groups are concept groups by default (ports on);
            // the MCP create_group tool can pass conceptGroup:false for a plain
            // organisation container.
            concept_group: conceptGroup,
          },
          zIndex: -1,
          // Restrict drag initiation to the header bar only; the rest of
          // the group body is click-through via CSS so nodes inside can
          // be interacted with normally.
          dragHandle: '.nn-group-drag-handle',
        },
      ],
    })
    return id
  },

  /**
   * Phase 8.5 — geometrically place `nodeId` inside `groupId`, growing the
   * group to contain it. The MCP `add_to_group` path: since group membership is
   * purely geometric (a node is "in" a group when its bbox sits inside the
   * group's bbox — see `groupMembership.js`), "add to group" means moving the
   * node into the group's interior. New nodes stack in a column below the
   * header; the group grows its width/height to fit. Returns true on success.
   */
  addNodeToGroup: (nodeId, groupId) => {
    const nodes = get().nodes
    const node = nodes.find((n) => n.id === nodeId)
    const group = nodes.find((n) => n.id === groupId && n.type === 'genericGroupNode')
    if (!node || !group || node.id === group.id) return false
    const PAD = 20, HEADER = 26, GAP = 30
    // Vertical margin between stacked members. Snap-honouring like the narrative
    // reorganize: with the grid on, the next member's top is the first grid line
    // at or past (previous bottom + one step), so the gap is HEIGHT-DEPENDENT —
    // always >= one step and < two — instead of a fixed pixel gap that would drift
    // tops off the dots (card heights aren't grid multiples). Off-grid: a plain gap.
    const snap = get().snapToGrid
    const ceilToGrid = (v) => Math.ceil((v - SNAP_POS_OFFSET) / SNAP_STEP) * SNAP_STEP + SNAP_POS_OFFSET
    const stackBelow = (bottom) => (snap ? ceilToGrid(bottom + SNAP_STEP) : bottom + GAP)
    // Size resolution MUST match `getNodesInGroup` / `isNodeInGroup` (which decide
    // membership) — they read the measured-dimensions SIDE STORE. Consulting it here
    // too keeps the re-packed box sized against the REAL card dimensions, so members
    // never overflow the box and get dropped from membership.
    const _w = (n, f) => n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.style?.width ?? n.width ?? f
    const _h = (n, f) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.style?.height ?? n.height ?? f
    const gx = group.position?.x ?? 0
    const gy = group.position?.y ?? 0
    const gw = _w(group, 400)
    const gh = _h(group, 300)
    const nw = _w(node, 220)
    const nh = _h(node, 140)
    // Chapter safety (Phase 8.5): filing a node into a group must NOT drag the node
    // out of the chapter it currently sits in. `nodeChapter` is its chapter now
    // (null = off-chapter → no constraint); a candidate landing spot is rejected
    // unless the node's centre would still resolve to that same chapter. Mode-aware
    // (single-row OR multi-row). The group BOX is free to span chapters — only the
    // MEMBER's landing is constrained.
    const story = get().story || {}
    const chaptersArr = story.chapters || []
    const memberOpts = chapterMemberOptsForStory(story)
    const nodeChapter = resolveChapterIdForNode(node, chaptersArr, memberOpts)
    const chapterSafe = (px, py) =>
      nodeChapter == null ||
      resolveChapterIdForNode({ position: { x: px, y: py }, measured: { width: nw, height: nh } }, chaptersArr, memberOpts) === nodeChapter
    // Current members (geometric, against the CURRENT box), excluding this node.
    const members = getNodesInGroup(group, nodes).filter((m) => m.id !== nodeId)
    const memberIds = new Set(members.map((m) => m.id))

    // ── Concept-group re-pack (Phase 8.5) ────────────────────────────────────
    // Filing a node into a concept group re-stacks ALL members into a clean COLUMN
    // inside the box, so a dense chapter can never scatter them (the plain four-side
    // grow below is only for organisation groups, and for a concept group whose
    // members span MORE THAN ONE chapter — where a single column would wrongly
    // collapse the span). The column sits at the group's x, so every member keeps its
    // chapter; the box grows down then lifts UP as a whole to clear any foreign node,
    // so it stays in the clear band and never swallows a non-member.
    if (group.data?.concept_group) {
      const ordered = [...members].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0)).concat(node)
      const chSet = new Set(ordered.map((m) => resolveChapterIdForNode(m, chaptersArr, memberOpts)))
      if (chSet.size === 1) {
        get()._snapshot()
        const boxX = gx
        const boxW = ordered.reduce((mx, m) => Math.max(mx, _w(m, 220)), 0) + 2 * PAD
        // Column member tops with grid-honouring gaps (mirrors the tidy's in-group spacing).
        const rows = []
        let cy = gy + HEADER + PAD
        for (const m of ordered) { rows.push({ id: m.id, y: cy, h: _h(m, 140) }); cy = stackBelow(cy + _h(m, 140)) }
        const last = rows[rows.length - 1]
        const boxH = (last.y + last.h + PAD) - gy
        // Lift the whole box UP until it clears every foreign node in its x-column.
        const overlapTop = (by) => {
          for (const o of nodes) {
            if (o.id === groupId || o.id === nodeId || memberIds.has(o.id)) continue
            const ox = o.position?.x ?? 0, oy = o.position?.y ?? 0
            if (boxX < ox + _w(o, 220) && boxX + boxW > ox && by < oy + _h(o, 140) && by + boxH > oy) return oy
          }
          return null
        }
        let boxY = gy, guard = 0, ov = overlapTop(boxY)
        while (ov != null && guard++ < 300) { boxY = ov - GAP - boxH; ov = overlapTop(boxY) }
        const dy = boxY - gy
        const rowById = new Map(rows.map((r) => [r.id, r]))
        const packed = nodes.map((n) => {
          if (n.id === groupId) return { ...n, position: { x: boxX, y: boxY }, width: boxW, height: boxH, measured: { width: boxW, height: boxH }, style: { ...(n.style || {}), width: boxW, height: boxH }, data: { ...n.data, width: boxW, height: boxH } }
          const r = rowById.get(n.id)
          if (r) return { ...n, position: { x: boxX + PAD, y: r.y + dy } }
          return n
        })
        set({ nodes: packed, hasUnsavedChanges: true })
        return true
      }
      // ── Spanning concept-group re-pack (Phase 8.5) ───────────────────────────
      // Members live in MORE THAN ONE chapter. Lay them out as a ROW of per-chapter
      // COLUMNS: each chapter's members stack in a column at that chapter's own x (so
      // every member keeps its chapter), and every column shares ONE top edge. The box
      // wraps the row — as wide as the chapters span, only as TALL as the tallest
      // column — so a one-member-per-chapter group is a single short row instead of a
      // tall up-and-over diagonal (the diagonal is what grew a box big enough to
      // swallow a neighbour). The box then lifts UP as a whole to clear any foreign
      // node in its x-range, so it stays in the clear band and never encloses a
      // non-member.
      {
        get()._snapshot()
        const cols = new Map()  // chapterKey -> member[] (off-chapter members share one column)
        for (const m of ordered) {
          const ch = resolveChapterIdForNode(m, chaptersArr, memberOpts)
          const key = ch == null ? '__off' : String(ch)
          if (!cols.has(key)) cols.set(key, [])
          cols.get(key).push(m)
        }
        const topY = gy + HEADER + PAD
        const placements = new Map()  // id -> { x, y }
        let left = Infinity, right = -Infinity, bottom = -Infinity
        for (const colMembers of cols.values()) {
          colMembers.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
          const colX = Math.min(...colMembers.map((m) => m.position?.x ?? gx))
          let cy = topY
          for (const m of colMembers) {
            const mw = _w(m, 220), mh = _h(m, 140)
            placements.set(m.id, { x: colX, y: cy })
            left = Math.min(left, colX); right = Math.max(right, colX + mw); bottom = Math.max(bottom, cy + mh)
            cy = stackBelow(cy + mh)
          }
        }
        const boxX = left - PAD
        const boxW = (right + PAD) - boxX
        const boxH = (bottom + PAD) - gy
        // Lift the whole box UP until it clears every foreign node overlapping its
        // x-range (mirrors the single-chapter re-pack's overlapTop).
        const overlapTop = (by) => {
          for (const o of nodes) {
            if (o.id === groupId || o.id === nodeId || memberIds.has(o.id)) continue
            const ox = o.position?.x ?? 0, oy = o.position?.y ?? 0
            if (boxX < ox + _w(o, 220) && boxX + boxW > ox && by < oy + _h(o, 140) && by + boxH > oy) return oy
          }
          return null
        }
        let boxY = gy, guard = 0, ov = overlapTop(boxY)
        while (ov != null && guard++ < 300) { boxY = ov - GAP - boxH; ov = overlapTop(boxY) }
        const dy = boxY - gy
        const packed = nodes.map((n) => {
          if (n.id === groupId) return { ...n, position: { x: boxX, y: boxY }, width: boxW, height: boxH, measured: { width: boxW, height: boxH }, style: { ...(n.style || {}), width: boxW, height: boxH }, data: { ...n.data, width: boxW, height: boxH } }
          const p = placements.get(n.id)
          if (p) return { ...n, position: { x: p.x, y: p.y + dy } }
          return n
        })
        set({ nodes: packed, hasUnsavedChanges: true })
        return true
      }
    }

    const interiorTop = gy + HEADER + PAD
    const interiorLeft = gx + PAD
    // Absolute extent of the existing members.
    let memTop = Infinity, memBottom = -Infinity, memLeft = Infinity, memRight = -Infinity
    for (const m of members) {
      const mx = m.position?.x ?? 0, my = m.position?.y ?? 0
      memTop = Math.min(memTop, my); memBottom = Math.max(memBottom, my + _h(m, 140))
      memLeft = Math.min(memLeft, mx); memRight = Math.max(memRight, mx + _w(m, 220))
    }
    if (!members.length) { memTop = interiorTop; memBottom = interiorTop; memLeft = interiorLeft; memRight = interiorLeft }

    // Grow-direction candidates. The box only EXTENDS to wrap the new member; the
    // group's origin stays put and existing members never move. Try all FOUR
    // sides — DOWN, then a new COLUMN to the right, then UP, then a column to the
    // LEFT — and take the first whose grown box doesn't cover a foreign node.
    const cDown =  { x: interiorLeft,                                       y: members.length ? stackBelow(memBottom) : interiorTop }
    const cRight = { x: members.length ? memRight + GAP : interiorLeft,     y: interiorTop }
    const cUp =    { x: interiorLeft,                                       y: members.length ? memTop - GAP - nh : interiorTop }
    const cLeft =  { x: members.length ? memLeft - GAP - nw : interiorLeft, y: interiorTop }
    // Concept groups live in the band ABOVE the scenes, so prefer growing UP into
    // that clear space; organisation groups keep the down-first stacking.
    const candidates = group.data?.concept_group ? [cUp, cDown, cRight, cLeft] : [cDown, cRight, cUp, cLeft]
    // The group box for a candidate = union of the current box and the padded bbox
    // of (members + new member), header space reserved on top. The box only grows
    // to wrap the new member; it never shrinks.
    const boxFor = (px, py) => {
      const left = Math.min(gx, Math.min(memLeft, px) - PAD)
      const top = Math.min(gy, Math.min(memTop, py) - PAD - HEADER)
      const right = Math.max(gx + gw, Math.max(memRight, px + nw) + PAD)
      const bottom = Math.max(gy + gh, Math.max(memBottom, py + nh) + PAD)
      return { x: left, y: top, w: right - left, h: bottom - top }
    }
    // A box that would cover any node other than the group, the new node, or a
    // current member would geometrically SWALLOW it — that direction is rejected.
    const overlapsForeign = (b) => {
      for (const o of nodes) {
        if (o.id === groupId || o.id === nodeId || memberIds.has(o.id)) continue
        const ox = o.position?.x ?? 0, oy = o.position?.y ?? 0
        if (b.x < ox + _w(o, 220) && b.x + b.w > ox && b.y < oy + _h(o, 140) && b.y + b.h > oy) return true
      }
      return false
    }

    get()._snapshot()
    // First side that (a) keeps the new member in its own chapter and (b) whose
    // grown box stays clear of foreign nodes.
    let placed = null
    for (const c of candidates) {
      if (!chapterSafe(c.x, c.y)) continue
      const box = boxFor(c.x, c.y)
      if (!overlapsForeign(box)) { placed = { x: c.x, y: c.y, box }; break }
    }

    let newNodes
    if (placed) {
      const b = placed.box
      newNodes = nodes.map((n) => {
        if (n.id === nodeId) return { ...n, position: { x: placed.x, y: placed.y } }
        if (n.id === groupId) {
          return {
            ...n,
            position: { x: b.x, y: b.y },
            width: b.w, height: b.h,
            measured: { width: b.w, height: b.h },
            style: { ...(n.style || {}), width: b.w, height: b.h },
            data: { ...n.data, width: b.w, height: b.h },
          }
        }
        return n
      })
    } else {
      // Boxed in on every adjacent side. Instead of flinging the group to the far
      // RIGHT of the whole canvas (which dragged it — and its members — OUT of their
      // chapters), lift it straight UP into the clear space above everything in its
      // x-columns. x is unchanged, so the group and all its members KEEP their
      // chapters, and moving above every obstacle means nothing is swallowed. The
      // member keeps its chapter too: it lands at the preferred slot if that stays
      // in-chapter, else at its own current x (the box spans up to reach it).
      const anchor = candidates[0]
      const keepX = chapterSafe(anchor.x, anchor.y) ? anchor.x : (node.position?.x ?? anchor.x)
      const b0 = boxFor(keepX, anchor.y)   // grown box, including the member at keepX
      // Carry everything whose CENTRE is inside the current box (members + straddlers)
      // so nothing inside is dropped; the foreign neighbours that boxed us in stay put.
      const carryIds = new Set()
      for (const o of nodes) {
        if (o.id === groupId || o.id === nodeId || o.type === 'genericGroupNode') continue
        const cx = (o.position?.x ?? 0) + _w(o, 220) / 2
        const cy = (o.position?.y ?? 0) + _h(o, 140) / 2
        if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) carryIds.add(o.id)
      }
      // Lift the box so its BOTTOM clears above the TOPMOST obstacle overlapping its
      // x-range — the group ends up in clear air above everything in its columns.
      let minTop = Infinity
      for (const o of nodes) {
        if (o.id === groupId || o.id === nodeId || carryIds.has(o.id)) continue
        const ox = o.position?.x ?? 0, ow = _w(o, 220)
        if (ox < b0.x + b0.w && ox + ow > b0.x) minTop = Math.min(minTop, o.position?.y ?? 0)
      }
      const dy = Number.isFinite(minTop) ? Math.min(0, (minTop - GAP * 3) - (b0.y + b0.h)) : 0
      newNodes = nodes.map((n) => {
        if (n.id === nodeId) return { ...n, position: { x: keepX, y: anchor.y + dy } }
        if (n.id === groupId) {
          return {
            ...n,
            position: { x: b0.x, y: b0.y + dy },
            width: b0.w, height: b0.h,
            measured: { width: b0.w, height: b0.h },
            style: { ...(n.style || {}), width: b0.w, height: b0.h },
            data: { ...n.data, width: b0.w, height: b0.h },
          }
        }
        if (carryIds.has(n.id)) return { ...n, position: { x: (n.position?.x ?? 0), y: (n.position?.y ?? 0) + dy } }
        return n
      })
    }
    set({ nodes: newNodes, hasUnsavedChanges: true })
    return true
  },

  /** Phase 1.11 Track I — create a new group sized to fit the currently
   *  selected nodes' combined bounding box plus padding on all sides. The
   *  group's HEADER bar sits ABOVE the topmost selected node (not over it),
   *  so the body area below the header cleanly contains the whole
   *  selection bbox. The resulting box MAY incidentally contain other
   *  (non-selected) nodes that happen to sit spatially inside the bbox —
   *  that's the accepted tradeoff of geometric membership per the Track I
   *  spec. The user can resize or reposition afterward to exclude strays. */
  createGroupFromSelection: () => {
    const nodes = get().nodes
    const selected = nodes.filter((n) => n.selected && n.type !== 'genericGroupNode')
    if (selected.length === 0) return
    // Compute bbox of the selection using the same node-size fallback chain
    // as the rest of the codebase.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of selected) {
      const w = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 0
      const h = n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 0
      const x = n.position?.x ?? 0
      const y = n.position?.y ?? 0
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x + w > maxX) maxX = x + w
      if (y + h > maxY) maxY = y + h
    }
    if (!isFinite(minX)) return
    const PAD = 20
    // Must match the header height in GenericGroupNode.jsx — the header
    // bar runs from the top of the group box down by this many pixels,
    // so to keep the header ABOVE the topmost selected node we shift the
    // group's top edge up by (HEADER_HEIGHT + PAD) instead of just PAD.
    const HEADER_HEIGHT = 26
    const boxX = minX - PAD
    const boxY = minY - PAD - HEADER_HEIGHT
    const boxW = Math.max(160, (maxX - minX) + PAD * 2)
    const boxH = Math.max(80 + HEADER_HEIGHT, (maxY - minY) + PAD * 2 + HEADER_HEIGHT)
    get().addGroupNode({ x: boxX, y: boxY }, { width: boxW, height: boxH })
  },

  /** Phase 1.11 Track I — batch delete every currently-selected node in a
   *  single operation. Single snapshot (one undo step), single confirmation
   *  prompt, single `set()` call. Skips the per-node confirm dialog that
   *  `deleteNode` would pop. Also removes any edge attached to any deleted
   *  node. */
  deleteSelectedNodes: async () => {
    const { nodes, edges } = get()
    const selectedIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
    if (selectedIds.size === 0) return
    const msg = `Delete ${selectedIds.size} selected node${selectedIds.size === 1 ? '' : 's'}?`
    const result = await confirm({
      title: 'Delete nodes',
      message: msg,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger'  },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result !== 'delete') return
    get()._snapshot()
    const nextNodes = nodes.filter((n) => !selectedIds.has(n.id))
    const nextEdges = edges.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target))
    set({ nodes: nextNodes, edges: nextEdges, hasUnsavedChanges: true })
  },

  /** Distribute every currently-selected node evenly along the given
   *  axis. Phase 1.12c v0.1.12.64 — driven by the `MultiSelectContextMenu`
   *  → Distribute nodes flyout. Single undo step.
   *
   *  `axis`: `'horizontal'` (distribute along x, gaps between left/right
   *  edges) or `'vertical'` (along y, gaps between top/bottom edges).
   *
   *  Algorithm:
   *    1. Sort the selected nodes by their position on `axis`.
   *    2. Keep the FIRST and LAST node in place — they define the bounds
   *       of the distribution span.
   *    3. Compute the total empty space between the first node's trailing
   *       edge and the last node's leading edge, minus the sum of the
   *       interior nodes' sizes. That's the total gap to distribute.
   *    4. Divide by (N - 1) to get the equal gap size between each
   *       adjacent pair.
   *    5. Place each interior node at `previous.trailing_edge + gap`.
   *    6. If `snapToGrid` is currently on, round each computed position
   *       via `snapPosition` so distributed nodes still land on dots
   *       (gaps may drift by a pixel or two but the user explicitly
   *       asked for this — "or as close as it can if snap is enabled").
   *
   *  Node widths / heights use the same `measured → data → top-level`
   *  fallback chain as `wireTidyUtils.getNodeBBox`. A no-op when fewer
   *  than three nodes are selected (you can't distribute two endpoints
   *  with nothing between them). */
  distributeSelectedNodes: (axis) => {
    const SNAP_STEP = 20
    const { nodes, snapToGrid } = get()
    const selected = nodes.filter((n) => n.selected)
    if (selected.length < 3) return
    const widthOf  = (n) => n.measured?.width ?? getMeasuredWidth(n.id)  ?? n.data?.width  ?? n.width  ?? 0
    const heightOf = (n) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 0

    // Sort by leading edge on the chosen axis.
    const sorted = [...selected].sort((a, b) => {
      const aLead = axis === 'horizontal' ? (a.position?.x || 0) : (a.position?.y || 0)
      const bLead = axis === 'horizontal' ? (b.position?.x || 0) : (b.position?.y || 0)
      return aLead - bLead
    })
    const first = sorted[0]
    const last  = sorted[sorted.length - 1]
    const sizeOf = axis === 'horizontal' ? widthOf : heightOf
    const leadOf = (n) => axis === 'horizontal' ? (n.position?.x || 0) : (n.position?.y || 0)

    // Span = last.trailing - first.leading.
    const span = (leadOf(last) + sizeOf(last)) - leadOf(first)
    // Sum of ALL node sizes along the axis (including endpoints).
    let totalSize = 0
    for (const n of sorted) totalSize += sizeOf(n)
    const totalGap = span - totalSize
    const gapSize = totalGap / (sorted.length - 1)

    // Phase 1.26 fix — when snap-to-grid is on, snap the GAP itself to
    // a multiple of SNAP_STEP (min one step so adjacent nodes don't
    // overlap), then iterate placement using that single snapped-gap
    // value. The previous implementation snapped each interior node's
    // position independently, which (with variable-width nodes) produced
    // visibly drifting inter-node gaps because rounding hit different
    // sides of the grid for each placement. Snap-off behaviour preserves
    // the floating-point equal-gap when there's room (totalGap > 0); when
    // the endpoints overlap or are too close, the gap floors to 0 (nodes
    // touching) and the last endpoint is pushed (see below).
    const placementGap = snapToGrid
      ? Math.max(SNAP_STEP, Math.round(gapSize / SNAP_STEP) * SNAP_STEP)
      : Math.max(0, gapSize)

    // Compute each interior node's new leading position.
    const newLeadById = new Map()
    let cursor = leadOf(first) + sizeOf(first) + placementGap
    for (let i = 1; i < sorted.length - 1; i++) {
      const n = sorted[i]
      newLeadById.set(n.id, cursor)
      cursor = cursor + sizeOf(n) + placementGap
    }
    // If the layout requires more span than is currently available
    // between the endpoints (cursor — which is where the last endpoint's
    // leading edge wants to be — exceeds the current last.leading),
    // push the last endpoint to make room. Otherwise the last endpoint
    // stays where it was. This covers two cases at once:
    //   - snap-on with a gap-size floor (Math.max(SNAP_STEP, ...)) that
    //     exceeds the average inter-node space.
    //   - any-mode where the user invoked Distribute on a tight or
    //     overlapping selection; nodes pack without overlap and the
    //     last endpoint slides right / down to fit.
    if (cursor > leadOf(last)) {
      newLeadById.set(last.id, cursor)
    }

    if (newLeadById.size === 0) return
    get()._snapshot()
    const nextNodes = nodes.map((n) => {
      if (!newLeadById.has(n.id)) return n
      const newLead = newLeadById.get(n.id)
      if (axis === 'horizontal') {
        return { ...n, position: { ...(n.position || {}), x: newLead } }
      }
      return { ...n, position: { ...(n.position || {}), y: newLead } }
    })
    set({ nodes: nextNodes, hasUnsavedChanges: true })
  },

  /** Align every currently-selected node to a shared edge. Phase 1.12c
   *  v0.1.12.62 — driven by the `MultiSelectContextMenu` → Align nodes
   *  D-pad submenu. Single undo step (one `_snapshot` for the whole
   *  operation).
   *
   *  `edge`: one of `'top' | 'bottom' | 'left' | 'right'` — which edge
   *  of the selected nodes all nodes should line up on.
   *
   *  `anchorNodeId`: when provided, every selected node's chosen edge
   *  is set to match the anchor node's corresponding edge. When null
   *  (right-click on empty canvas background), falls back to the
   *  extreme among selected: top → highest (smallest y); bottom →
   *  lowest (largest y + height); left → leftmost (smallest x);
   *  right → rightmost (largest x + width). Mirrors the "align to
   *  topmost/leftmost" convention in Figma, Illustrator, PowerPoint.
   *
   *  Node widths / heights fall back through `measured → data → top-
   *  level → 0` matching the same chain `wireTidyUtils.getNodeBBox`
   *  uses; a node with unknown height/width contributes a zero-size
   *  "point" for the extreme calculation, which is consistent with
   *  treating it as its top-left corner.
   *
   *  A no-op when fewer than two nodes are selected (single-node
   *  alignment has no meaning). */
  alignSelectedNodes: (edge, anchorNodeId = null) => {
    const { nodes } = get()
    const selected = nodes.filter((n) => n.selected)
    if (selected.length < 2) return
    const widthOf  = (n) => n.measured?.width ?? getMeasuredWidth(n.id)  ?? n.data?.width  ?? n.width  ?? 0
    const heightOf = (n) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 0
    const xLeft    = (n) => n.position?.x || 0
    const xRight   = (n) => (n.position?.x || 0) + widthOf(n)
    const yTop     = (n) => n.position?.y || 0
    const yBottom  = (n) => (n.position?.y || 0) + heightOf(n)

    // Resolve the target edge value. If an anchor is provided, use its
    // own edge. Otherwise pick the extreme from the selected set.
    const anchor = anchorNodeId ? nodes.find((n) => n.id === anchorNodeId) : null
    let target
    if (edge === 'top') {
      target = anchor ? yTop(anchor) : Math.min(...selected.map(yTop))
    } else if (edge === 'bottom') {
      target = anchor ? yBottom(anchor) : Math.max(...selected.map(yBottom))
    } else if (edge === 'left') {
      target = anchor ? xLeft(anchor) : Math.min(...selected.map(xLeft))
    } else if (edge === 'right') {
      target = anchor ? xRight(anchor) : Math.max(...selected.map(xRight))
    } else {
      return  // unknown edge
    }

    get()._snapshot()
    const nextNodes = nodes.map((n) => {
      if (!n.selected) return n
      if (n.id === anchorNodeId) return n  // anchor doesn't move
      if (edge === 'top') {
        return { ...n, position: { ...(n.position || {}), y: target } }
      }
      if (edge === 'bottom') {
        return { ...n, position: { ...(n.position || {}), y: target - heightOf(n) } }
      }
      if (edge === 'left') {
        return { ...n, position: { ...(n.position || {}), x: target } }
      }
      if (edge === 'right') {
        return { ...n, position: { ...(n.position || {}), x: target - widthOf(n) } }
      }
      return n
    })
    set({ nodes: nextNodes, hasUnsavedChanges: true })
  },

  addPovOriginNode: (position) => {
    // Enforce one-per-story: remove any existing POV origin node first
    const existing = get().nodes.filter((n) => n.type === 'povOriginNode')
    if (existing.length > 0) return  // already exists — do nothing
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 50 + Math.random() * 200, y: 120 + Math.random() * 200 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'povOriginNode',
          position: pos,
          data: { id, node_type: 'pov_origin', position: pos },
        },
      ],
    })
  },

  /** Create a relationship origin node on the canvas for a given relationship.
   *  Phase 1.18. Invariant: one relationship origin node per relationship. If
   *  one already exists, returns its id instead of creating a duplicate
   *  (idempotent). Local-state only; save-time `PUT /story` syncs the backend,
   *  matching the pattern used by other node-creation actions
   *  (`addEntityNodeToCanvas`, `addPovOriginNode`).
   *
   *  Returns the id of the existing-or-newly-created node. */
  createRelationshipOriginNode: ({ relationshipId, position }) => {
    if (!relationshipId) return null
    // Idempotent: if an origin node already exists for this relationship, return it.
    const existing = get().nodes.find(
      (n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === relationshipId
    )
    if (existing) return existing.id
    get()._snapshot()
    const id = crypto.randomUUID()
    const pos = applyCreationPositionSnap(
      position || { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 },
      get().snapToGrid,
    )
    set({
      nodes: [
        ...get().nodes,
        {
          id,
          type: 'relationshipOriginNode',
          position: pos,
          data: {
            id,
            node_type: 'relationship_origin',
            relationship_id: relationshipId,
            position: pos,
          },
        },
      ],
      hasUnsavedChanges: true,
    })
    return id
  },

  // Context-menu "Add Relationship" entry point: creates an empty relationship
  // (no participants yet) plus a relationship origin node at the given
  // canvas position, and opens the Relationship Detail Panel on it. The
  // user wires participants in afterwards (from entity origin nodes or from
  // chips in scenes). Until the first participant is wired, the origin node
  // renders in its faded "empty" proto state.
  addEmptyRelationshipOriginNode: async (position) => {
    const id = crypto.randomUUID()
    // Create the empty relationship. createRelationship's async await resolves
    // after the backend round-trip; only after that do we pin the origin node
    // to the canvas so we have a stable relationship id.
    const rel = await get().createRelationship({
      id,
      manual_anchors: [],
      history: {
        existence_changes: [],
        participant_changes: [],
        perception_changes: [],
        alias_changes: [],
        role_changes: [],
        hierarchy_changes: [],
        name_changes: [],
        description_changes: [],
      },
    })
    if (!rel) return null
    const nodeId = get().createRelationshipOriginNode({ relationshipId: rel.id, position })
    if (nodeId) {
      useUiStore.getState().openRelationshipDetail(rel.id, nodeId)
    }
    return nodeId
  },

  toggleReferenceCollapse: (nodeId) => {
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const wasCollapsed = n.data.collapsed
        if (wasCollapsed) {
          // Expanding — restore expanded dimensions
          const w = n.data.width || 220
          const h = n.data.height
          return {
            ...n,
            width: w,
            height: h,
            data: { ...n.data, collapsed: false },
            style: { width: w, ...(h ? { height: h } : {}) },
            measured: { width: w, height: h || 80 },
          }
        } else {
          // Collapsing — use stored collapsed dims if available
          const cw = n.data.collapsed_width
          const ch = n.data.collapsed_height
          return {
            ...n,
            width: cw || undefined,
            height: ch || undefined,
            data: { ...n.data, collapsed: true },
            ...(cw ? {
              style: { width: cw, height: ch },
              measured: { width: cw, height: ch },
            } : {
              style: {},
              measured: undefined,
            }),
          }
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  setReferenceCollapsedDims: (nodeId, width, height) => {
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        return {
          ...n,
          width,
          height,
          data: { ...n.data, collapsed_width: width, collapsed_height: height },
          style: { width, height },
          measured: { width, height },
        }
      }),
    })
  },

  /** Remove an entity chip from a plot point node, plus any edges that carried it. */
  removeEntityChip: async (nodeId, entityId, options = {}) => {
    const { autoStitchChain = false } = options
    get()._snapshot()
    const { nodes, edges, relationships, relationshipsByScene } = get()

    // Capture the entity's incoming + outgoing narrative-flow edges at
    // this scene BEFORE removal so the D2 auto-stitch step can re-wire
    // upstream → downstream after the chip leaves. Only relevant when
    // the caller opts in (`autoStitchChain: true`, MCP path); UI-driven
    // removes leave the chip orphaned-upstream / orphaned-downstream
    // as before so the user can re-wire by hand.
    const incomingFlowEdge = autoStitchChain
      ? edges.find((e) => e.target === nodeId && e.data?.source_entity_id === entityId && !e.data?.is_relationship)
      : null
    const outgoingFlowEdge = autoStitchChain
      ? edges.find((e) => e.source === nodeId && e.sourceHandle === entityId && !e.data?.is_relationship)
      : null

    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId) return n
      let newData = {
        ...n.data,
        characters: (n.data.characters || []).filter((r) => r.entity_id !== entityId),
        locations:  (n.data.locations  || []).filter((r) => r.entity_id !== entityId),
        items:      (n.data.items      || []).filter((r) => r.entity_id !== entityId),
        factions:   (n.data.factions   || []).filter((r) => r.entity_id !== entityId),
        customs:    (n.data.customs    || []).filter((r) => r.entity_id !== entityId),
      }
      if (newData.chip_order) {
        newData.chip_order = newData.chip_order.filter((eid) => eid !== entityId)
      }
      // Phase 1.22h — strip any temporary circumstances / motivators
      // attached to this entity at this scene. Temporaries are scoped
      // to (scene, entity_id); when the chip leaves the scene the
      // entries become orphaned and should be cleaned up alongside
      // the chip removal. Same _snapshot covers undo.
      if (Array.isArray(newData.entity_temporary_circumstances)) {
        newData.entity_temporary_circumstances = newData.entity_temporary_circumstances.filter(
          (t) => t.entity_id !== entityId,
        )
      }
      return { ...n, data: newData }
    })
    let updatedEdges = edges.filter((e) => {
      if (e.target === nodeId && e.data?.source_entity_id === entityId) return false
      if (e.source === nodeId && e.sourceHandle === entityId) return false
      return true
    })

    // Clean up relationships where entityId was a participant joined at this scene.
    const relIdsAtScene = relationshipsByScene[nodeId] || new Set()
    let updatedRelationships = [...relationships]
    const pendingRelDeletes = [] // rel ids to DELETE via dispatcher after main set()

    if (relIdsAtScene.size > 0) {
      const targetNodeAfter = updatedNodes.find((n) => n.id === nodeId)
      const remainingIds = new Set(
        ['characters', 'locations', 'items', 'factions', 'customs']
          .flatMap((b) => (targetNodeAfter?.data[b] || []).map((r) => r.entity_id))
      )

      for (const relId of relIdsAtScene) {
        const rel = updatedRelationships.find((r) => r.id === relId)
        if (!rel) continue
        // History-only: participants are derived from join events in history.
        const joinEntityIds = new Set(
          (rel.history?.participant_changes || [])
            .filter((c) => c.action === 'join')
            .map((c) => c.entity_id)
        )
        if (!joinEntityIds.has(entityId)) continue

        // Other participants (by derived set) still present in the scene
        const remaining = [...joinEntityIds].filter((eid) => eid !== entityId && remainingIds.has(eid))

        if (remaining.length < 1) {
          // No other participants remain in scene -- wipe the rel's history
          // entries at this node across every array-valued history key.
          // EXCEPTION: `manual_anchors` is preserved. The user explicitly
          // pinned the chip to this scene via the library-drag gesture;
          // that intent is independent of participant presence. Participant
          // drops shouldn't silently remove the user's anchor.
          const cleanHistory = {}
          for (const key of Object.keys(rel.history || {})) {
            const arr = rel.history[key]
            if (!Array.isArray(arr)) continue
            if (key === 'manual_anchors') {
              cleanHistory[key] = arr
              continue
            }
            cleanHistory[key] = arr.filter((c) => c?.node_id !== nodeId)
          }
          const hasAnyHistory = Object.values(cleanHistory).some((arr) => Array.isArray(arr) && arr.length > 0)
          // Also check if any join events remain after the strip — if none, the
          // relationship has lost all participants and should cascade-delete.
          const stillHasJoin = (cleanHistory.participant_changes || []).some((c) => c.action === 'join')
          if (!hasAnyHistory && !stillHasJoin) {
            // Cascade to DELETE via dispatcher after the main set() commits the
            // non-delete work. The dispatcher handles backend + _relationshipRestore
            // for undo. Leaving the rel in updatedRelationships here so the dispatcher
            // can find it in store state when it runs.
            pendingRelDeletes.push(relId)
          } else {
            const data = await get().updateRelationship(relId, { ...rel, history: { ...rel.history, ...cleanHistory } })
            updatedRelationships = updatedRelationships.map((r) => r.id === relId ? data : r)
          }
        } else {
          // Other participants still in scene -- only remove entityId's join entry at this node
          const updRel = {
            ...rel,
            history: {
              ...rel.history,
              participant_changes: (rel.history?.participant_changes || []).filter(
                (c) => !(c.entity_id === entityId && c.node_id === nodeId && c.action === 'join')
              ),
            },
          }
          const data = await get().updateRelationship(relId, updRel)
          updatedRelationships = updatedRelationships.map((r) => r.id === relId ? data : r)
        }
      }
    }

    const { byEntity, byScene } = _buildRelIndexes(updatedRelationships)
    set({
      nodes: updatedNodes,
      edges: updatedEdges,
      relationships: updatedRelationships,
      relationshipsByEntity: byEntity,
      relationshipsByScene: byScene,
    })

    // D2 auto-stitch: if the caller opted in AND both an incoming and
    // outgoing narrative-flow edge existed for this entity at this
    // scene, the chain has been broken by the chip removal. Rewire
    // upstream → downstream directly so the entity's chain continues
    // past the removed scene. Cycle-safeguarded: if stitching would
    // form a loop in the entity's chain, refuse with a clear error
    // (the chip is already removed at this point; the AI can re-wire
    // manually). Single-side scenarios (only incoming OR only
    // outgoing) need no stitch — the surviving end is now a chain
    // terminus, which is a legitimate state.
    if (autoStitchChain && incomingFlowEdge && outgoingFlowEdge) {
      const upstreamId = incomingFlowEdge.source
      const downstreamId = outgoingFlowEdge.target
      const upstreamNode = updatedNodes.find((n) => n.id === upstreamId)
      const downstreamNode = updatedNodes.find((n) => n.id === downstreamId)
      if (upstreamNode && downstreamNode && upstreamId !== downstreamId) {
        const wouldLoop = _isFlowReachable(downstreamId, upstreamId, get().edges, entityId)
        if (wouldLoop) {
          throw new Error(
            `auto-stitch would create a cycle in entity ${entityId}'s chain ` +
            `(upstream ${upstreamId} is already reachable downstream of ${downstreamId}). ` +
            `The chip has been removed; the chain is now severed at this scene. Re-wire ` +
            `manually in the UI if a different stitch shape is wanted.`
          )
        }
        // Route the stitch wire through the canonical onConnect
        // dispatcher (same path the auto-wire and UI-confirm flows
        // use) so the new wire lands with the proper chip-in target
        // handle + EntityRef auto-creation in the downstream scene
        // if the entity isn't already chipped there.
        await get().onConnect({
          source: upstreamId,
          sourceHandle: upstreamNode.type === 'sceneNode' ? entityId : null,
          target: downstreamId,
          targetHandle: `chip-in-${entityId}`,
        })
      }
    }

    // Deferred cascades — DELETE orphaned relationships via the dispatcher.
    // Runs after the main set() commits so the dispatcher finds each rel in state
    // (it needs to capture _relationshipRestore for undo's backend re-POST).
    for (const relId of pendingRelDeletes) {
      await get().deleteObject('relationship', relId)
    }
  },

  updateNodeData: (nodeId, dataUpdate, opts = {}) => {
    // `opts.silent`: program-driven layout corrections (the auto-grow
    // / auto-shrink effects on Scene / Entity / RelationshipOrigin /
    // KnowledgeOrigin nodes) call this with `silent: true` so they
    // don't flip `hasUnsavedChanges` for what's effectively a
    // first-render measurement pass after a project load. The
    // recomputed height lands in node state and persists on the next
    // user-driven save, but doesn't trigger the autosave / "discard
    // changes?" prompt on its own. User-driven writes (typed title,
    // chip reorder, corner-drag resize, description-handle drag end)
    // keep the default non-silent behaviour and mark dirty as before.
    const silent = !!opts.silent
    // Snapshot prior data BEFORE the patch so we can diff time-field
    // changes for the loose-mode alert payload (planning §10.1).
    const priorNode = get().nodes.find((n) => n.id === nodeId)
    const priorData = priorNode?.data || {}
    // Phase 1.23 — time-field commits must participate in undo/redo.
    // Snapshot once before the mutation so Ctrl-Z restores the prior
    // pinned state. updateNodeData runs for many field types; only
    // time-field patches need the snapshot here (other field types
    // either snapshot at their own action sites or are intentionally
    // session-only, e.g. `_povInternalsUpdate` ticks).
    // Snapshot triggers for project-level undo. The walker-driven
    // scenetime patches have always snapshotted here (Phase 1.23).
    // v0.2.9.52 — also snapshot on `title` and `description` patches
    // so canvas renames + node-description edits participate in
    // project-level Ctrl+Z. (`main_content` is intentionally
    // excluded — TipTap's ProseMirror `history` plugin owns
    // in-editor undo for prose; layering the project snapshot stack
    // on top would conflict with it.)
    if (dataUpdate && (
      SCENETIME_FIELD_KEYS.some((k) => k in dataUpdate)
      || 'title' in dataUpdate
      || 'description' in dataUpdate
    )) {
      get()._snapshot()
    }
    const nextNodes = get().nodes.map((n) => {
      if (n.id !== nodeId) return n
      const merged = { ...n, data: { ...n.data, ...dataUpdate } }
      // React Flow v12's NodeResizeControl reads node dimensions from
      // n.style and the top-level n.width / n.height — NOT from n.data.
      // Mirror dimension keys onto those fields whenever a caller passes
      // width / height through `updateNodeData` (corner-drag onResize,
      // description-drag commit, etc.) so RF's resize tracking stays in
      // sync with what we're rendering. Otherwise programmatic height
      // changes update the inner DOM but leave RF's wrapper tracking
      // stale, causing a follow-up corner drag to jump from RF's old
      // cached size.
      if (dataUpdate && ('width' in dataUpdate || 'height' in dataUpdate)) {
        const newW = dataUpdate.width  ?? n.width  ?? n.style?.width
        const newH = dataUpdate.height ?? n.height ?? n.style?.height
        if (newW != null) merged.width  = newW
        if (newH != null) merged.height = newH
        merged.style = {
          ...n.style,
          ...(newW != null ? { width:  newW } : {}),
          ...(newH != null ? { height: newH } : {}),
        }
        // For silent updates (program-driven layout corrections), also
        // pre-sync `n.measured` to the new dims when the node carries
        // one. Since Phase 4.1g #4 auto-measurements live in the
        // measured-dimensions side store (RF's post-correction
        // re-measure lands there, deduped by its own ≥1px filter), so
        // this pre-sync no longer gates dirty-marking; it keeps the
        // node's explicit `measured` (collapsed reference nodes,
        // snap-to-grid survivors) consistent with the silent write,
        // since explicit `measured` is read FIRST in the size
        // fallback chains.
        if (silent && n.measured) {
          merged.measured = {
            ...n.measured,
            ...(newW != null ? { width: newW } : {}),
            ...(newH != null ? { height: newH } : {}),
          }
        }
      }
      return merged
    })
    set(silent ? { nodes: nextNodes } : { nodes: nextNodes, hasUnsavedChanges: true })
    // Effects hook — no-op in the common case. Only fires if the
    // changed scene's title or main_content matches a trigger phrase.
    try {
      if (dataUpdate && (dataUpdate.title !== undefined || dataUpdate.main_content !== undefined)) {
        const updated = get().nodes.find((n) => n.id === nodeId)
        if (updated) detectAndFireOvumBlack(updated)
      }
    } catch { /* effects must never break a save */ }
    // Phase 1.23 — when a Time-tracking-relevant field commits, run
    // walker + alert detection immediately so the writer sees
    // gap-shift alerts the moment they hit Save in the Time Modal,
    // rather than only after a file save. Capture the trigger scene
    // + the actual time-field deltas so the alert can name the
    // upstream cause and let the writer click through to it.
    if (dataUpdate && SCENETIME_FIELD_KEYS.some((k) => k in dataUpdate)) {
      const fieldChanges = SCENETIME_FIELD_KEYS
        .filter((k) => k in dataUpdate)
        .map((k) => ({
          field: k,
          oldValue: priorData[k] ?? null,
          newValue: dataUpdate[k] ?? null,
        }))
        .filter((c) => JSON.stringify(c.oldValue) !== JSON.stringify(c.newValue))
      get()._commitScenetimeWrites({ triggerNodeId: nodeId, fieldChanges })
    }
  },

  // ── Phase 1.24c — cross-scene Find / Replace store action ──────────────
  // Replace every occurrence of `query` with `replacement` inside
  // every targeted scene's `main_content` HTML in a SINGLE atomic
  // mutation: one snapshot at the top, one set() at the bottom, so
  // undo / redo rolls back every affected scene as one step.
  //
  // Scope:
  //   { sceneIds: string[] }  — replace inside only these scenes.
  //   omit `sceneIds`         — replace inside every sceneNode.
  //
  // Returns `{ replacedCount, affectedSceneCount }` for the caller's
  // toast.
  replaceInAllSceneMainContent: ({ query, replacement, matchCase = false, wholeWord = false, sceneIds } = {}) => {
    if (!query || !query.trim()) return { replacedCount: 0, affectedSceneCount: 0 }
    const targetSet = Array.isArray(sceneIds) && sceneIds.length > 0
      ? new Set(sceneIds)
      : null
    let replacedCount = 0
    let affectedSceneCount = 0
    const currentNodes = get().nodes
    const nextNodes = currentNodes.map((n) => {
      if (n.type !== 'sceneNode') return n
      if (targetSet && !targetSet.has(n.id)) return n
      const html = n.data?.main_content || ''
      if (!html) return n
      const { html: nextHtml, replaced } = replaceMatchesInHtml(html, query, replacement, { matchCase, wholeWord })
      if (replaced === 0) return n
      replacedCount += replaced
      affectedSceneCount += 1
      return { ...n, data: { ...n.data, main_content: nextHtml } }
    })
    if (replacedCount === 0) return { replacedCount: 0, affectedSceneCount: 0 }
    get()._snapshot()
    set({ nodes: nextNodes, hasUnsavedChanges: true })
    return { replacedCount, affectedSceneCount }
  },

  // ── Phase 1.22 — scene-side circumstance CRUD ──────────────────────────
  // Scene-side circumstances live directly on Scene.circumstances (a
  // property of the scene at its single chain position; not chain-tracked
  // across entity narratives). These actions mirror the existing
  // updateNodeData pattern but provide convenience entry points so the
  // Scene Detail Panel's Circumstances sub-tab and Dev Preview can
  // manipulate the list without rebuilding the array on every call.

  addSceneCircumstance: (nodeId, circumstance) => {
    if (!nodeId || !circumstance) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.circumstances) ? n.data.circumstances : []
        const entry = {
          id: circumstance.id || crypto.randomUUID(),
          name: circumstance.name || null,
          description: circumstance.description || '',
          intensity: circumstance.intensity ?? null,
        }
        return { ...n, data: { ...n.data, circumstances: [...list, entry] } }
      }),
      hasUnsavedChanges: true,
    })
  },

  updateSceneCircumstance: (nodeId, circumstanceId, patch) => {
    if (!nodeId || !circumstanceId || !patch) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.circumstances) ? n.data.circumstances : []
        const next = list.map((c) => (c.id === circumstanceId ? { ...c, ...patch } : c))
        return { ...n, data: { ...n.data, circumstances: next } }
      }),
      hasUnsavedChanges: true,
    })
  },

  removeSceneCircumstance: (nodeId, circumstanceId) => {
    if (!nodeId || !circumstanceId) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.circumstances) ? n.data.circumstances : []
        return { ...n, data: { ...n.data, circumstances: list.filter((c) => c.id !== circumstanceId) } }
      }),
      hasUnsavedChanges: true,
    })
  },

  // ── Phase 1.22h — Temporary circumstance / motivator (per entity, per scene) ──
  // Scene-scoped data; not chain-tracked. Lives on
  // SceneNode.entity_temporary_circumstances. Each entry is scoped to
  // one entity at one scene; the chain walker doesn't see them and
  // downstream scenes don't inherit them.

  addEntityTemporaryCM: (nodeId, entityId, payload) => {
    if (!nodeId || !entityId || !payload) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.entity_temporary_circumstances) ? n.data.entity_temporary_circumstances : []
        const entry = {
          id: payload.id || crypto.randomUUID(),
          entity_id: entityId,
          attribute_type: payload.attribute_type === 'motivator' ? 'motivator' : 'circumstance',
          name: payload.name || null,
          description: payload.description || '',
          intensity: payload.intensity ?? null,
        }
        return { ...n, data: { ...n.data, entity_temporary_circumstances: [...list, entry] } }
      }),
      hasUnsavedChanges: true,
    })
  },

  updateEntityTemporaryCM: (nodeId, entryId, patch) => {
    if (!nodeId || !entryId || !patch) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.entity_temporary_circumstances) ? n.data.entity_temporary_circumstances : []
        const next = list.map((e) => (e.id === entryId ? { ...e, ...patch } : e))
        return { ...n, data: { ...n.data, entity_temporary_circumstances: next } }
      }),
      hasUnsavedChanges: true,
    })
  },

  removeEntityTemporaryCM: (nodeId, entryId) => {
    if (!nodeId || !entryId) return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const list = Array.isArray(n.data?.entity_temporary_circumstances) ? n.data.entity_temporary_circumstances : []
        return { ...n, data: { ...n.data, entity_temporary_circumstances: list.filter((e) => e.id !== entryId) } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Phase 1.26 — Persist a manual sub-chip order for circumstance /
   * motivator sub-chips at (scene, entity, kind). Writes through to
   * `SceneNode.cm_chip_order[entityId][kind]`. Passing `null` or an
   * empty array clears the manual order for that bucket, returning
   * the bucket to auto-sort mode (desc intensity, then UUID).
   *
   * The order is purely a per-scene display preference — no entity
   * baseline or chain history is touched. Mirrors the existing
   * scene-level `chip_order` mechanism that orders entity chips on
   * the scene.
   */
  reorderEntityCMs: (nodeId, entityId, kind, newOrder) => {
    if (!nodeId || !entityId) return
    if (kind !== 'circumstance' && kind !== 'motivator') return
    get()._snapshot()
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n
        const prev = (n.data?.cm_chip_order && typeof n.data.cm_chip_order === 'object')
          ? n.data.cm_chip_order
          : {}
        const prevForEntity = (prev[entityId] && typeof prev[entityId] === 'object')
          ? prev[entityId]
          : {}
        const cleanedOrder = Array.isArray(newOrder) ? newOrder.filter((id) => typeof id === 'string' && id) : []
        let nextForEntity
        if (cleanedOrder.length === 0) {
          // Clearing this kind — drop the inner key.
          const { [kind]: _drop, ...rest } = prevForEntity
          nextForEntity = rest
        } else {
          nextForEntity = { ...prevForEntity, [kind]: cleanedOrder }
        }
        // If the entity has no remaining order entries across kinds,
        // drop the outer key so the field stays minimal.
        let nextMap
        if (Object.keys(nextForEntity).length === 0) {
          const { [entityId]: _drop, ...rest } = prev
          nextMap = rest
        } else {
          nextMap = { ...prev, [entityId]: nextForEntity }
        }
        return { ...n, data: { ...n.data, cm_chip_order: nextMap } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Convert a temporary circumstance / motivator into an ongoing chain
   * entry on the entity's chain at this scene. Atomic: removes the
   * temporary entry from the scene AND adds an `action='add'` chain
   * entry on the entity_ref's `attribute_changes` at this scene with
   * a fresh attribute UUID + the temporary's payload. Single
   * `_snapshot()` covers both halves so undo restores both.
   *
   * The scene IS the attribute's new origin per the chain model — an
   * attribute introduced via `action='add'` has its origin at that
   * node, no prior chain history. Writing the add directly is the
   * canonical chain-aware path for an attribute being introduced.
   */
  convertEntityTemporaryToOngoing: (nodeId, entryId) => {
    if (!nodeId || !entryId) return
    const { nodes } = get()
    const node = nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'sceneNode') return
    const list = Array.isArray(node.data?.entity_temporary_circumstances) ? node.data.entity_temporary_circumstances : []
    const entry = list.find((e) => e.id === entryId)
    if (!entry) return
    get()._snapshot()
    // Build the `action='add'` chain entry payload — fresh attribute
    // UUID so it doesn't collide with the temporary's id (the
    // temporary will be removed in the same step, but a fresh id is
    // future-proof against any other system that might key on it).
    const newAttribute = {
      id: crypto.randomUUID(),
      attribute_type: entry.attribute_type,
      name: entry.name || '',
      description: entry.description || '',
      intensity: entry.intensity ?? null,
      value: '',
      file_ref: null,
      preset_list_id: null,
      preset_list_name: null,
    }
    const newAttrChange = {
      id: crypto.randomUUID(),
      action: 'add',
      attribute_id: newAttribute.id,
      attribute: newAttribute,
    }
    set({
      nodes: nodes.map((n) => {
        if (n.id !== nodeId || n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        // 1) Drop the temporary entry from the scene's list.
        newData.entity_temporary_circumstances = (n.data.entity_temporary_circumstances || []).filter((e) => e.id !== entryId)
        // 2) Append the `action='add'` chain entry to the matching
        //    entity_ref's attribute_changes. Search every bucket; the
        //    entity's ref lives in whichever bucket matches its type.
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entry.entity_id)
          if (idx === -1) continue
          const ref = refs[idx]
          newData[bucket] = refs.map((r, i) => i === idx
            ? { ...r, attribute_changes: [...(ref.attribute_changes || []), newAttrChange] }
            : r,
          )
          break
        }
        return { ...n, data: newData }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Bulk-update positions for every node in a group-drag gesture.
   *
   * Fires per mousemove while the user drags a multi-selection on canvas.
   * Computes each member's new position from its recorded start plus (dx, dy)
   * and commits in one `set()`. Snapshot-less by design — the undo snapshot
   * was taken at drag-start, and recording one per frame would explode the
   * undo stack. Canvas.jsx's `handleNodeDrag` is the sole caller.
   *
   * memberStartPosById: Map<nodeId, { x, y }> of each group member's
   * pre-drag position. Nodes not in the map are left untouched.
   */
  /**
   * Mark the project as having unsaved changes. Call this from non-store
   * callers (e.g. the Story Seeds tab after a server round-trip) that update
   * project state without going through a per-type canonical action. Avoids
   * direct `useProjectStore.setState({hasUnsavedChanges: true})` from
   * components which bypasses the store-action layer.
   */
  markUnsaved: () => set({ hasUnsavedChanges: true }),

  applyGroupDragPositions: (memberStartPosById, dx, dy) => {
    set({
      nodes: get().nodes.map((n) => {
        const start = memberStartPosById.get(n.id)
        if (!start) return n
        return { ...n, position: { x: start.x + dx, y: start.y + dy } }
      }),
    })
  },

  /**
   * Strip every POV-path edge touching a given scene node. Used by the
   * "detach POV" handler in SceneNode.jsx to remove all POV wires in
   * and out of a scene in one atomic step. Also clears the scene's
   * `pov_entity_id` as part of the same action so caller sites don't need
   * a separate `updateNodeData` call.
   */
  /**
   * MCP D3+D4 — insert a scene into the POV chain at a specific
   * position. Used by `create_scene` / `update_scene` when the AI
   * passes `pov_after` / `pov_before` / `off_screen` / default-append
   * args.
   *
   * Position shapes:
   *   { kind: 'off_screen' }        → strip POV wires + clear pov_entity_id
   *   { kind: 'after',  refId }     → insert sceneId between refScene and refScene's POV successor
   *   { kind: 'before', refId }     → insert sceneId between refScene's POV predecessor and refScene
   *   { kind: 'append' }            → append sceneId after the current POV chain tail (or as the first on-chain scene if chain is empty)
   *
   * All shapes start by stripping every existing POV edge touching
   * sceneId so re-inserts behave like single-step relocations.
   * Cycle-safeguarded for `after` / `before` / `append` — refuses
   * the insertion if it would create a loop in the POV chain.
   *
   * Routes through direct edge mutation (no `onConnect` dispatch
   * here — POV-edge creation in onConnect is gated on the user
   * dragging from a pov-out handle; this is a programmatic insertion).
   * Edge shape mirrors what `onConnect` produces for POV wires
   * (line 4748): `povEdge` type with `pov-out` / `pov-in` handles +
   * `is_pov_path: true`.
   */
  _insertSceneIntoPovChain: (sceneId, position) => {
    const { nodes, edges } = get()
    const sceneNode = nodes.find((n) => n.id === sceneId)
    if (!sceneNode || sceneNode.type !== 'sceneNode') {
      throw new Error(`POV insert target scene not found: ${sceneId}`)
    }

    // Strip every existing POV edge touching this scene first.
    let nextEdges = edges.filter(
      (e) => !(e.data?.is_pov_path && (e.source === sceneId || e.target === sceneId)),
    )

    if (position?.kind === 'off_screen') {
      const nextNodes = nodes.map((n) =>
        n.id === sceneId ? { ...n, data: { ...n.data, pov_entity_id: null } } : n,
      )
      set({ nodes: nextNodes, edges: nextEdges, hasUnsavedChanges: true })
      return { placed: 'off_screen' }
    }

    // Resolve the POV origin node — required for 'append' from
    // empty + 'before' when ref is the current head.
    const povOriginNode = nodes.find((n) => n.type === 'povOriginNode')
    if (!povOriginNode) {
      throw new Error(
        `POV insert failed: no POV origin node on canvas. This shouldn't ` +
        `happen for stories created post-Phase 1.9; legacy stories without ` +
        `a POV origin need one added manually before MCP-driven POV ` +
        `placement can succeed.`
      )
    }

    const _povEdge = (sourceId, targetId) => {
      const id = `pov-${sourceId}-${targetId}`
      return {
        id,
        source: sourceId,
        target: targetId,
        sourceHandle: 'pov-out',
        targetHandle: 'pov-in',
        type: 'povEdge',
        data: {
          id,
          source_node_id: sourceId,
          target_node_id: targetId,
          is_pov_path: true,
          target_handle_id: 'pov-in',
        },
      }
    }

    if (position?.kind === 'after' || position?.kind === 'before') {
      const refId = position.refId
      const refNode = nodes.find((n) => n.id === refId)
      if (!refNode || refNode.type !== 'sceneNode') {
        throw new Error(`POV insert reference scene not found: ${refId}`)
      }
      if (refId === sceneId) {
        throw new Error(`POV insert: pov_${position.kind} cannot reference the same scene being placed.`)
      }
      if (position.kind === 'after') {
        // refScene → sceneId → (refScene's old successor, if any)
        const existingOut = nextEdges.find(
          (e) => e.data?.is_pov_path && e.source === refId,
        )
        if (existingOut) {
          // Remove the old ref → next edge; insert ref → sceneId, sceneId → next
          nextEdges = nextEdges.filter((e) => e.id !== existingOut.id)
          nextEdges.push(_povEdge(refId, sceneId))
          nextEdges.push(_povEdge(sceneId, existingOut.target))
        } else {
          // refScene is the current tail — just append
          nextEdges.push(_povEdge(refId, sceneId))
        }
      } else {
        // before: (refScene's old predecessor) → sceneId → refScene
        const existingIn = nextEdges.find(
          (e) => e.data?.is_pov_path && e.target === refId,
        )
        if (existingIn) {
          nextEdges = nextEdges.filter((e) => e.id !== existingIn.id)
          nextEdges.push(_povEdge(existingIn.source, sceneId))
          nextEdges.push(_povEdge(sceneId, refId))
        } else {
          // refScene is the current head — wire from POV origin
          nextEdges.push(_povEdge(povOriginNode.id, sceneId))
          nextEdges.push(_povEdge(sceneId, refId))
        }
      }
      set({ edges: nextEdges, hasUnsavedChanges: true })
      return { placed: position.kind, ref_scene_id: refId }
    }

    if (position?.kind === 'append') {
      // Find the current POV chain tail: the last node reachable from
      // pov_origin via is_pov_path edges that has no outgoing POV edge.
      let cur = povOriginNode.id
      const visited = new Set([cur])
      while (true) {
        const out = nextEdges.find((e) => e.data?.is_pov_path && e.source === cur)
        if (!out) break
        if (visited.has(out.target)) break  // cycle guard (defensive)
        visited.add(out.target)
        cur = out.target
      }
      // `cur` is now the chain tail (or pov_origin if chain is empty).
      // Append: cur → sceneId.
      nextEdges.push(_povEdge(cur, sceneId))
      set({ edges: nextEdges, hasUnsavedChanges: true })
      return { placed: 'append', tail_source_id: cur }
    }

    throw new Error(`POV insert: unknown position kind ${position?.kind}`)
  },

  removePovWiresForScene: (sceneNodeId) => {
    const { nodes, edges } = get()
    const filteredEdges = edges.filter(
      (e) => !(e.data?.is_pov_path && (e.source === sceneNodeId || e.target === sceneNodeId))
    )
    const didDrop = filteredEdges.length !== edges.length
    const updatedNodes = nodes.map((n) =>
      n.id === sceneNodeId ? { ...n, data: { ...n.data, pov_entity_id: null } } : n
    )
    if (!didDrop && nodes === updatedNodes) return
    get()._snapshot()
    set({ nodes: updatedNodes, edges: filteredEdges, hasUnsavedChanges: true })
  },

  /**
   * Public reorganize entry point.
   *
   * Called by:
   *   - The canvas Controls cluster's "Reorganize canvas" button.
   *   - The MCP `reorganize_canvas` tool.
   *
   * The packing logic (`_reorganizeCanvasSingleRow`) lays scenes into
   * single-row chapter columns and is NOT multi-row-aware: it snapshots
   * membership with the single-row `getChapterIdForNode` and places nodes
   * at flat single-row Y coordinates. So in multi-row mode we PROJECT the
   * canvas down to single-row first (the proven `setCanvasLayoutMode`
   * `'multi'→'single'` mapping), run the single-row pack, then RE-WRAP back
   * into the existing rows (`'single'→'multi'`, which preserves `chapter_rows`
   * and recomputes each chapter's `content_origin_y` + row heights from the
   * freshly-packed positions). The whole sequence runs under ONE `_snapshot()`
   * with the inner mode switches' own snapshots suppressed, so a reorganize is
   * a single undo step regardless of mode; the visible mode never changes (it
   * ends in whatever mode it started in).
   */
  reorganizeCanvas: () => {
    const wasMulti = get().story?.canvas_layout_mode === 'multi'
    get()._snapshot()
    // Phase 8.3: in multi-row, snapshot each group's members (geometric) BEFORE
    // the multi→single projection moves anything. After the re-wrap redistributes
    // nodes back into rows (which can split a box from its members), refit every
    // group box to bound those snapshotted members so none is left outside.
    let groupMemberSnapshot = null
    if (wasMulti) {
      const cur = get().nodes
      groupMemberSnapshot = cur
        .filter((n) => n.type === 'genericGroupNode')
        .map((g) => ({ id: g.id, memberIds: getNodesInGroup(g, cur, { excludeGroups: false }).map((m) => m.id) }))
    }
    if (wasMulti) get().setCanvasLayoutMode('single', { skipSnapshot: true })
    get()._reorganizeCanvasSingleRow()
    if (wasMulti) get().setCanvasLayoutMode('multi', { skipSnapshot: true })
    if (wasMulti && groupMemberSnapshot) get()._refitGroupBoxesToMembers(groupMemberSnapshot)
    // Snap-to-grid awareness: when the grid is on, land the freshly-packed
    // layout on the grid too, so reorganize is consistent with the drag /
    // create / resize paths (which all snap). Positions ONLY — card heights
    // stay as measured (no empty space is added inside a card).
    //
    // Vertical stacking gets special handling so gaps read cleanly on the grid.
    // A naive per-node position snap would round each origin card's top to the
    // nearest dot independently; because card heights aren't grid multiples, the
    // uniform 30 px stacking gap would scatter to anywhere from ~10 to ~50 px
    // (some pairs closer than one grid cell, some further). Instead, the origin /
    // reference cards that stack in a vertical column (grouped by their shared
    // column x) are RE-STACKED: the first card's top snaps to the grid, and each
    // subsequent card's top is the first grid line at or past
    // (previous card's bottom + one increment). So every card top lands on a grid
    // line AND every gap is at least one increment and less than two — exactly one
    // increment plus however far the card above's bottom sits below its next grid
    // line. Everything else (scenes on the row, modifiers, groups, lone cards)
    // just snaps both axes. Runs inside reorganize's single snapshot.
    if (get().snapToGrid) {
      // Phase 8.5: the concept layer is positioned (and snapped) by the concept
      // re-tidy pass below, not by this narrative snap pass — so skip it here.
      // Re-stacking a concept card / concept-group member into a column now would
      // just be overwritten, and worse could shift a member off its group before
      // the concept pass reads positions.
      const clSnapNodes = get().nodes
      const conceptLayerSnapIds = new Set()
      for (const n of clSnapNodes) if (n.type === 'referenceNode' && n.data?.sub_type === 'concept') conceptLayerSnapIds.add(n.id)
      for (const g of clSnapNodes) {
        if (g.type !== 'genericGroupNode' || !g.data?.concept_group) continue
        conceptLayerSnapIds.add(g.id)
        for (const m of getNodesInGroup(g, clSnapNodes, { excludeGroups: false })) conceptLayerSnapIds.add(m.id)
      }
      set((s) => {
        const STEP = 20            // SNAP_STEP (kept in sync with utils/snapUtils.js)
        const POS_OFFSET = 10      // SNAP_POS_OFFSET — grid dots sit at ≡10 (mod 20)
        // Smallest grid line (≡ POS_OFFSET mod STEP) at or past v.
        const ceilToGrid = (v) => Math.ceil((v - POS_OFFSET) / STEP) * STEP + POS_OFFSET
        const heightOf = (n) =>
          n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 120
        // Card types that stack vertically in a column (origins + reference
        // cards). Modifier entity nodes ride the horizontal scene row, so they
        // are excluded and snapped like any other loose node.
        const STACK_TYPES = new Set(['entityNode', 'knowledgeOriginNode', 'relationshipOriginNode', 'referenceNode'])
        const isColumnCard = (n) => STACK_TYPES.has(n.type) && !(n.type === 'entityNode' && n.data?.is_modifier)
        // Bucket column cards by their snapped column x; everything else snaps
        // both axes directly.
        const columns = new Map()  // snappedX → node[]
        const newPos = new Map()   // id → { x, y }
        for (const n of s.nodes) {
          if (!n.position) continue
          if (conceptLayerSnapIds.has(n.id)) continue  // concept layer: positioned by the concept pass
          if (isColumnCard(n)) {
            const sx = snapPosition(n.position.x)
            if (!columns.has(sx)) columns.set(sx, [])
            columns.get(sx).push(n)
          } else {
            newPos.set(n.id, { x: snapPosition(n.position.x), y: snapPosition(n.position.y) })
          }
        }
        for (const [sx, colNodes] of columns) {
          if (colNodes.length === 1) {
            const n = colNodes[0]
            newPos.set(n.id, { x: sx, y: snapPosition(n.position.y) })
            continue
          }
          colNodes.sort((a, b) => a.position.y - b.position.y)
          let top = snapPosition(colNodes[0].position.y)  // anchor the column to the grid
          for (const n of colNodes) {
            newPos.set(n.id, { x: sx, y: top })
            top = ceilToGrid(top + heightOf(n) + STEP)     // ≥ one increment, < two, top on grid
          }
        }
        return {
          nodes: s.nodes.map((n) => {
            const p = newPos.get(n.id)
            return p ? { ...n, position: { ...n.position, x: p.x, y: p.y } } : n
          }),
          hasUnsavedChanges: true,
        }
      })
    }
    // Phase 8.5: re-tidy the concept layer now the narrative packing is final.
    // Runs LAST so it reads the settled scene positions (each chapter's band floor
    // is that chapter's topmost scene) and owns the final say on every concept
    // position. Held out of narrative packing above, so this is the only pass that
    // moves concepts.
    get()._reorganizeConceptClusters()
    // Recenter on the POV origin once the layout is final (the inner mode
    // switches used skipSnapshot, so they didn't request it themselves).
    get().requestPovFocus()
  },

  /**
   * Phase 8.5 — reorganize's concept-layer pass. Delegates to the pure
   * `computeReorganizeConceptLayout` (partitions the concept layer by chapter and
   * re-tidies each partition with the wire-driven layout: off-chapter concepts as
   * one off-to-the-side cluster, each chapter's concepts as a band ABOVE that
   * chapter's scenes). Passes the mode-appropriate chapter-membership fn so it works
   * in single-row AND multi-row. Runs inside the `reorganizeCanvas` single snapshot.
   */
  _reorganizeConceptClusters: () => {
    const state = get()
    const story = state.story || {}
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10
    let chapterOfNode
    if (story.canvas_layout_mode === 'multi') {
      const rows = Array.isArray(story.chapter_rows) ? story.chapter_rows : []
      const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
      chapterOfNode = (n) => getChapterIdForNodeMultiRow(n, chapters, rows, geom.xOffset, geom.rowsTopY, geom.rowGap)
    } else {
      chapterOfNode = (n) => getChapterIdForNode(n, chapters, xOffset)
    }
    const merged = computeReorganizeConceptLayout(state.nodes, state.edges, {
      chapterOfNode,
      snapToGrid: state.snapToGrid,
      chapterLeftEdge: chapters.length > 0 ? xOffset : Infinity,
    })
    if (merged.size === 0) return
    // Apply the positions AND re-face every concept wire touching a moved node to
    // its shortest ports for the new layout — reuse `applyConceptLayout` so the
    // wire re-routing is identical to the interactive tidy (without this, wires
    // keep the ports they had before the re-tidy and read messy). snapshot:false
    // folds into reorganize's single undo step.
    get().applyConceptLayout(merged, { snapshot: false })
  },

  /**
   * Phase 8.3 — refit each group box to bound a snapshotted member set. Used
   * after the multi-row reorganize re-wrap (which redistributes nodes into rows
   * by chapter and can split a box from its members) so every original member
   * stays inside its group. Runs under the reorganize wrapper's single snapshot.
   */
  _refitGroupBoxesToMembers: (snapshot) => {
    const PAD = 24
    // Reserve the group's header bar above the members so the topmost member
    // card isn't tucked partly under it (GenericGroupNode draws a 26px title bar
    // at the box top; matches addNodeToGroup / addGroupNode which already reserve it).
    const HEADER_HEIGHT = 26
    set((s) => {
      const byId = new Map(s.nodes.map((n) => [n.id, n]))
      const boxUpdates = new Map()
      for (const { id, memberIds } of (snapshot || [])) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const mid of memberIds) {
          const m = byId.get(mid)
          if (!m) continue
          const mw = m.measured?.width ?? getMeasuredWidth(m.id) ?? m.data?.width ?? m.width ?? 200
          const mh = m.measured?.height ?? getMeasuredHeight(m.id) ?? m.data?.height ?? m.height ?? 120
          const mx = m.position?.x || 0, my = m.position?.y || 0
          minX = Math.min(minX, mx); minY = Math.min(minY, my)
          maxX = Math.max(maxX, mx + mw); maxY = Math.max(maxY, my + mh)
        }
        if (minX === Infinity) continue
        boxUpdates.set(id, { x: minX - PAD, y: minY - PAD - HEADER_HEIGHT, w: (maxX - minX) + 2 * PAD, h: (maxY - minY) + 2 * PAD + HEADER_HEIGHT })
      }
      if (boxUpdates.size === 0) return {}
      return {
        nodes: s.nodes.map((n) => {
          const b = boxUpdates.get(n.id)
          if (!b) return n
          return {
            ...n, position: { x: b.x, y: b.y }, width: b.w, height: b.h,
            data: { ...n.data, width: b.w, height: b.h },
            style: { ...(n.style || {}), width: b.w, height: b.h },
            // Also write `measured` (React Flow v12 rule): geometric membership
            // reads `measured` first, and an off-screen group is never
            // re-measured by React Flow, so a stale height would silently drop a
            // member whose box we just grew. Keep it in lockstep with w/h.
            measured: { ...(n.measured || {}), width: b.w, height: b.h },
          }
        }),
      }
    })
  },

  /**
   * Single-row canvas packing (the reorganize implementation) — scenes
   * packed into their existing chapter columns in overall story order,
   * entity origin nodes placed by first-appearance per the same logic the
   * template-import service uses for `layout_mode='first_appearance'`.
   *
   * Internal: only ever invoked by `reorganizeCanvas` (above), which owns
   * the `_snapshot()` and the multi-row project/re-wrap bracketing. Assumes
   * single-row coordinate space.
   *
   * Both consumers route through this single store action so behaviour
   * is identical regardless of which surface triggered it.
   *
   * Algorithm (snapshot-then-rewrite — never queries chapter membership
   * mid-flight, since the act of moving nodes changes membership):
   *   1. SNAPSHOT each scene's CURRENT chapter membership via
   *      `getChapterIdForNode`. This is the chapter the user (or the
   *      AI) put each scene in by position. The reorganization
   *      respects these snapshotted memberships — scenes stay in their
   *      chapter, the chapter widens if it has to.
   *   2. Walk `computeStoryOrder.orderedIds` for the OVERALL canonical
   *      scene order (origins first, then POV chain, then off-chain
   *      scenes interleaved by topo constraints). For each scene in
   *      that order, record which entities have their FIRST chip
   *      appearance there — this drives origin placement (mirrors
   *      template-import's `_compute_first_appearance_layout`).
   *   3. Per chapter, pack scenes left-to-right in overall order.
   *      Reserve sub-column space LEFT of each scene that's a
   *      first-appearance host: one width-aware sub-column per entity
   *      type with at least one first-appearer at that scene, each
   *      sized to the widest origin card it holds (via
   *      `widthForBucketItem`) plus an `ORIGIN_SUBCOL_GAP` between
   *      columns and before the scene.
   *      Widen the chapter via `setChapterResizeLive` if packing
   *      overflows; downstream nodes slide right to preserve their
   *      chapter membership (same canonical resize-with-slide action
   *      the UI's chapter-drag handle uses).
   *   4. Place entity origin nodes:
   *      - First-appearance entities → sub-columns LEFT of their
   *        first-appearance scene, grouped by entity type
   *        (characters / locations / items / factions / customs).
   *      - Unreferenced entities (no chip in any scene) → pre-chapter
   *        per-type columns LEFT of chapter 1.
   *   5. Off-chapter scenes (snapshotted chapter is null because their
   *      centre fell outside all chapters) → placed past the rightmost
   *      chapter in overall order, on the scene row.
   *
   * Pure-snapshot pattern: all chapter widths and node positions are
   * computed UPFRONT against the pre-reorganization state, then
   * applied in a single setState (chapter widths via cumulative
   * `setChapterResizeLive` calls in chapter index order). One
   * `_snapshot()` for atomic undo.
   *
   * Layout constants chosen to roughly match the template-import
   * defaults so a project reorganized by this action has the same
   * visual density as a fresh template-imported one. They live here
   * (not pulled from the import service) because the import service
   * is intentionally separate per design rule — this is a parallel
   * function inspired by but not unified with template-import.
   */
  _reorganizeCanvasSingleRow: () => {
    const state = get()
    const initialNodes = state.nodes || []
    const initialEdges = state.edges || []
    const story = state.story || {}
    const chapters = story.chapters || []
    const xOffset = story.chapter_x_offset ?? 10

    // Layout constants (mirror template-import's `_Applier` constants
    // so the visual density matches a fresh template import).
    // Fallback scene width when a scene node isn't measured yet. Must match
    // the scene node's real footprint (the seed in NODE_DIM_DEFAULTS) — a too-
    // small value here packs scenes closer than they render and they overlap.
    const SCENE_WIDTH         = NODE_DIM_DEFAULTS.sceneNode.width  // 400
    const SCENE_HEIGHT_PAD    = 320  // for collision math; actual node renders shorter
    const SCENE_GAP           = 40
    const SCENE_ROW_Y         = 100
    const OFFCHAPTER_ROW_Y    = SCENE_ROW_Y                          // off-chapter scenes share the main row, just placed past the rightmost chapter
    // Non-POV scenes get a slight downward y-offset so they're
    // visually distinguishable from POV-attached scenes on the same
    // row. Per user direction: same chapter column, same row but
    // bumped down a touch.
    const NON_POV_Y_OFFSET    = 60
    const ORIGIN_NODE_WIDTH   = 220
    const ORIGIN_NODE_HEIGHT_FALLBACK = 140  // used when a node hasn't been measured yet
    const ORIGIN_Y_GAP        = 30   // vertical gap between stacked origin nodes (height-aware step = measured_height + this gap)
    // Reference-node row sits below the scene row, with buffer past
    // the non-POV offset + scene height pad so reference nodes don't
    // overlap any scene. Reference nodes stay in their snapshotted
    // chapter column (their position is informational, not part of
    // narrative order) and stack vertically without overlapping.
    const REFERENCE_ROW_Y     = SCENE_ROW_Y + NON_POV_Y_OFFSET + SCENE_HEIGHT_PAD + 40
    const REFERENCE_NODE_HEIGHT_FALLBACK = 180  // used when a ref node hasn't been measured yet
    const REFERENCE_Y_GAP     = 30   // vertical gap between stacked reference nodes (height-aware step = measured_height + this gap)
    const REFERENCE_NODE_WIDTH = 280
    const ORIGIN_ROW_Y        = -260 // entity-origin row above the scene row
    // First-appearance sub-columns and unreferenced pre-chapter columns are now
    // WIDTH-AWARE: each column is sized to the widest origin card it holds (via
    // widthForBucketItem), so the old fixed per-column widths are gone. Only the
    // inter-column / column-to-scene GAPS remain as constants.
    const ORIGIN_SUBCOL_GAP   = 30   // gap between adjacent first-appearance sub-columns (and the rightmost one and its scene)
    const PRE_CHAPTER_BUFFER  = 40   // gap between adjacent pre-chapter columns (and the rightmost one and chapter 1's left edge)
    const TYPED_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
    // Extended bucket order for the per-scene first-appearance sub-column
    // layout: entity types first, then relationships, then knowledges.
    // RelationshipOriginNode and KnowledgeOriginNode receive the same
    // "first appearance = sub-column LEFT of earliest scene where this
    // object has a chain event" treatment that entity origins get. The
    // bucket index drives left-to-right sub-column order under the scene.
    const EXTENDED_BUCKETS = [...TYPED_BUCKETS, 'relationships', 'knowledges']

    // Entity-id → origin-EntityNode map. Used by the origin-stacking
    // loops below to look up each origin node's MEASURED height
    // (`node.measured?.height ?? data.height ?? width ?? fallback`) so
    // stacked origins don't overlap when their actual rendered heights
    // exceed the fallback (entities with many attributes render taller).
    const originNodeByEntityId = new Map()
    // Parallel maps for relationship/knowledge origin nodes — looked up
    // by relationship-id / knowledge-id. Used by the same height-aware
    // stacking helper so rel/knowledge origins don't overlap either.
    const relOriginNodeByRelId = new Map()
    const knowOriginNodeByKnowId = new Map()
    for (const n of initialNodes) {
      if (n.type === 'entityNode') {
        if (n.data?.is_modifier) continue
        const eid = n.data?.entity_id
        if (eid && !originNodeByEntityId.has(eid)) originNodeByEntityId.set(eid, n)
      } else if (n.type === 'relationshipOriginNode') {
        const rid = n.data?.relationship_id
        if (rid && !relOriginNodeByRelId.has(rid)) relOriginNodeByRelId.set(rid, n)
      } else if (n.type === 'knowledgeOriginNode') {
        const kid = n.data?.knowledge_id
        if (kid && !knowOriginNodeByKnowId.has(kid)) knowOriginNodeByKnowId.set(kid, n)
      }
    }
    // Height-aware lookup for a sub-column-placed item. typeKey is one
    // of EXTENDED_BUCKETS; for entity buckets `id` is an entity id, for
    // 'relationships' a relationship id, for 'knowledges' a knowledge id.
    const heightForBucketItem = (typeKey, id) => {
      let n
      if (typeKey === 'relationships') n = relOriginNodeByRelId.get(id)
      else if (typeKey === 'knowledges') n = knowOriginNodeByKnowId.get(id)
      else n = originNodeByEntityId.get(id)
      if (!n) return ORIGIN_NODE_HEIGHT_FALLBACK
      return n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? ORIGIN_NODE_HEIGHT_FALLBACK
    }
    // Width-aware lookup for a sub-column-placed item. Same shape as
    // heightForBucketItem but returns the origin card's ACTUAL rendered
    // width so a sub-column can be sized to the WIDEST card in it (an
    // entity card with an avatar + attribute list, a knowledge card with
    // a long description) instead of a fixed constant that narrower cards
    // fit but wider ones overflow — the overflow being exactly the
    // pre-chapter column overlap. Falls back to ORIGIN_NODE_WIDTH when
    // unmeasured.
    const widthForBucketItem = (typeKey, id) => {
      let n
      if (typeKey === 'relationships') n = relOriginNodeByRelId.get(id)
      else if (typeKey === 'knowledges') n = knowOriginNodeByKnowId.get(id)
      else n = originNodeByEntityId.get(id)
      if (!n) return ORIGIN_NODE_WIDTH
      return n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? ORIGIN_NODE_WIDTH
    }

    // ── STEP 1: snapshot each scene's current chapter membership ──
    const sceneChapterIntent = new Map() // sceneId → chapterId | null
    for (const n of initialNodes) {
      if (n.type !== 'sceneNode') continue
      const chId = getChapterIdForNode(n, chapters, xOffset)
      sceneChapterIntent.set(n.id, chId || null)
    }
    // (Reference-node chapter memberships are snapshotted further down, AFTER
    // the Phase 8.3 preamble builds `excludeFromPacking`: that snapshot skips
    // frozen concept / group-member ref nodes, so it must run once the set
    // exists. It used to run here — before the set was declared — which threw
    // a TDZ ReferenceError that aborted the entire reorganize before a single
    // node was placed. See the `refNodeChapterIntent` build after the preamble.)
    // Modifier EntityNodes also snapshot chapter membership — they
    // live on the scene row alongside scenes (same chapter column) but
    // are conceptually similar to off-POV scenes: they're chain stops
    // that don't carry POV. So they get the same NON_POV_Y_OFFSET y
    // bump and pack into their snapshotted chapter just like a
    // non-POV scene would.
    const modifierNodeChapterIntent = new Map() // modifierNodeId → chapterId | null
    for (const n of initialNodes) {
      if (n.type !== 'entityNode' || !n.data?.is_modifier) continue
      const chId = getChapterIdForNode(n, chapters, xOffset)
      modifierNodeChapterIntent.set(n.id, chId || null)
    }

    // ── Phase 8.3 / 8.5: concept + group layout ──────────────────────────
    // Two of reorganize's default behaviours become wrong once concept content
    // and concept-enabled groups exist: it sweeps concept nodes into the
    // reference row, and it repositions nodes without consulting group
    // membership (which can move a node out of the box it sits in). Guard both
    // here, up front, from the frozen pre-reorganize state (group membership is
    // GEOMETRIC, so it must be read before any node moves).
    //   - The whole CONCEPT LAYER (concept cards, concept groups, and everything
    //     inside a concept group) is held OUT of narrative packing entirely; the
    //     concept re-tidy pass (`_reorganizeConceptClusters`, run afterward by the
    //     `reorganizeCanvas` wrapper) re-lays it out per chapter. So concepts never
    //     get swept into the reference row and never perturb scene / origin packing.
    //   - Each ORGANIZATION generic group (non-concept) is classified by the chapter
    //     memberships of its members: all in one chapter → LOCKED (box + members
    //     translate as one unit to that chapter's story-order slot, internal layout
    //     preserved); members span chapters → SPREAD (members repack into their
    //     chapters, the box grows to keep containing them); otherwise (all off-chapter
    //     or empty) → FROZEN (left in place). Locked / frozen members are held out of
    //     the normal packing and locked members are protected from the chapter-widening
    //     slide so a box and its members never desync.
    const groupBoxW = (g) => (g.measured?.width ?? getMeasuredWidth(g.id) ?? g.data?.width ?? g.style?.width ?? 400)
    const conceptLayerIds = new Set()
    for (const n of initialNodes) {
      if (n.type === 'referenceNode' && n.data?.sub_type === 'concept') conceptLayerIds.add(n.id)
    }
    for (const g of initialNodes) {
      if (g.type !== 'genericGroupNode' || !g.data?.concept_group) continue
      conceptLayerIds.add(g.id)
      for (const m of getNodesInGroup(g, initialNodes, { excludeGroups: false })) conceptLayerIds.add(m.id)
    }
    const groupPlans = []  // { node, memberIds:Set, kind:'locked'|'spread'|'frozen', chapterId }
    for (const g of initialNodes) {
      if (g.type !== 'genericGroupNode') continue
      if (g.data?.concept_group) continue                 // concept group: handled by the concept re-tidy pass
      const members = getNodesInGroup(g, initialNodes, { excludeGroups: false })
      const memberIds = new Set(members.map((m) => m.id))
      const chSet = new Set(members.map((m) => getChapterIdForNode(m, chapters, xOffset) || null))
      const inChapters = [...chSet].filter(Boolean)
      let kind = 'frozen'
      let chapterId = null
      if (members.length === 0) {
        kind = 'frozen'
      } else if (inChapters.length === 1 && !chSet.has(null)) {
        kind = 'locked'; chapterId = inChapters[0]
      } else if (inChapters.length >= 1) {
        kind = 'spread'
      }
      groupPlans.push({ node: g, memberIds, kind, chapterId })
    }
    // Nodes held out of the normal packing (translated / frozen with their
    // group), plus the whole concept layer.
    const excludeFromPacking = new Set(conceptLayerIds)
    const memberToLockedGroup = new Map()  // memberId → its LOCKED group plan (first writer wins on overlap)
    const slideProtectIds = new Set()      // locked box + members: placed explicitly, never slid
    const spreadGroups = []
    const lockedGroupResult = new Map()    // groupNodeId → { deltaX }
    for (const gp of groupPlans) {
      if (gp.kind === 'locked' || gp.kind === 'frozen') {
        for (const id of gp.memberIds) excludeFromPacking.add(id)
      }
      if (gp.kind === 'locked') {
        slideProtectIds.add(gp.node.id)
        for (const id of gp.memberIds) {
          if (!memberToLockedGroup.has(id)) memberToLockedGroup.set(id, gp)
          slideProtectIds.add(id)
        }
      }
      if (gp.kind === 'spread') spreadGroups.push(gp)
    }

    // Snapshot reference-node chapter memberships — reference nodes stay in
    // their snapshotted chapter column (they don't participate in narrative
    // order; their position is informational only). We stack them vertically
    // below the scene row inside their snapshotted chapter. This runs AFTER
    // the Phase 8.3 preamble so the `excludeFromPacking` guard (skip frozen
    // concept / group-member ref nodes) reads the fully-built set — running it
    // before the set was declared threw a TDZ error that aborted reorganize.
    const refNodeChapterIntent = new Map() // refNodeId → chapterId | null
    for (const n of initialNodes) {
      if (n.type !== 'referenceNode') continue
      if (excludeFromPacking.has(n.id)) continue  // Phase 8.3: frozen concept / group member — not swept
      const chId = getChapterIdForNode(n, chapters, xOffset)
      refNodeChapterIntent.set(n.id, chId || null)
    }

    // Detect which scenes are on the POV path — non-POV scenes get
    // a small downward y-offset on the scene row to visually
    // distinguish them. "On POV" = there's an `is_pov_path` edge
    // either inbound or outbound on the scene.
    const povSceneIds = new Set()
    for (const e of initialEdges) {
      if (!e.data?.is_pov_path) continue
      if (e.target) povSceneIds.add(e.target)
      if (e.source) povSceneIds.add(e.source)
    }

    // ── STEP 2: compute overall story order ──
    // Use the canonical topo-sort; this gives us origins first, then
    // POV chain, then off-chain scenes + modifier nodes interleaved
    // per chain constraints. Filter to the chain-stop items we lay
    // out on the scene row: scenes AND modifier EntityNodes. Each
    // item is shaped `{ kind: 'scene'|'modifier', id, node }` so the
    // per-chapter packing loop can branch on kind for y assignment
    // (POV row vs non-POV row) and width.
    const storyOrder = computeStoryOrder({ nodes: initialNodes, edges: initialEdges, chapters, chapterXOffset: xOffset })
    const orderedIds = storyOrder?.orderedIds || []
    const itemsInOrder = []  // { kind, id, node }[]
    for (const id of orderedIds) {
      const n = initialNodes.find((nn) => nn.id === id)
      if (!n) continue
      if (n.type === 'sceneNode') {
        itemsInOrder.push({ kind: 'scene', id, node: n })
      } else if (n.type === 'entityNode' && n.data?.is_modifier) {
        itemsInOrder.push({ kind: 'modifier', id, node: n })
      }
    }
    // Any chain-stop the topo sort didn't include (e.g. a floating off-
    // chain scene or orphan modifier with no chain wires) gets appended
    // after; otherwise it'd be silently dropped from the reorg.
    {
      const placed = new Set(itemsInOrder.map((it) => it.id))
      for (const n of initialNodes) {
        if (placed.has(n.id)) continue
        if (n.type === 'sceneNode') itemsInOrder.push({ kind: 'scene', id: n.id, node: n })
        else if (n.type === 'entityNode' && n.data?.is_modifier) itemsInOrder.push({ kind: 'modifier', id: n.id, node: n })
      }
    }
    // sceneIdsInOrder is still needed for the first-appearance walk
    // below (only scenes host first-appearance entities, not modifiers).
    const sceneIdsInOrder = itemsInOrder.filter((it) => it.kind === 'scene' && !excludeFromPacking.has(it.id)).map((it) => it.id)

    // ── STEP 3: first-appearance map ──
    // Walk scenes in overall order; for each entity with a chip on
    // a scene, record the FIRST scene where that entity appears.
    // Also covers relationships (first scene with a chain history
    // entry referencing that scene) and knowledges (first scene with
    // a chain history entry OR a manual anchor). Buckets the result
    // by (sceneId → {typeKey → [id]}) using EXTENDED_BUCKETS keys so
    // step 4 can size sub-columns per scene.
    const firstAppearanceByScene = new Map()  // sceneId → Map<typeKey, id[]>
    const firstAppearanceEntities = new Set() // entity ids that appear as a chip anywhere
    const firstAppearanceRels = new Set()     // relationship ids with at least one chain stop
    const firstAppearanceKnows = new Set()    // knowledge ids with at least one chain stop / manual anchor

    // Pre-build sceneId → {rels:Set, knows:Set} index in story order. Each
    // entry records every relationship/knowledge that has ANY history
    // entry (or knowledge manual anchor) at that scene, so the first-
    // appearance walk below picks the earliest such scene.
    const relsAtScene = new Map()   // sceneId → Set<relationshipId>
    const knowsAtScene = new Map()  // sceneId → Set<knowledgeId>
    const relationships = state.relationships || []
    const knowledges = state.knowledges || []
    for (const rel of relationships) {
      if (!relOriginNodeByRelId.has(rel.id)) continue // only place rels with an origin node on canvas
      const h = rel.history || {}
      for (const key of REL_HISTORY_KEYS) {
        const arr = h[key] || []
        for (const ev of arr) {
          if (!ev?.node_id) continue
          if (!relsAtScene.has(ev.node_id)) relsAtScene.set(ev.node_id, new Set())
          relsAtScene.get(ev.node_id).add(rel.id)
        }
      }
    }
    const KNOWLEDGE_HISTORY_KEYS = ['existence_changes', 'name_changes', 'description_changes', 'colour_changes', 'profile_image_changes', 'source_event_changes']
    for (const k of knowledges) {
      if (!knowOriginNodeByKnowId.has(k.id)) continue
      const h = k.history || {}
      for (const key of KNOWLEDGE_HISTORY_KEYS) {
        const arr = h[key] || []
        for (const ev of arr) {
          if (!ev?.node_id) continue
          if (!knowsAtScene.has(ev.node_id)) knowsAtScene.set(ev.node_id, new Set())
          knowsAtScene.get(ev.node_id).add(k.id)
        }
      }
      // Manual anchors also count as a chain-tracked presence at the scene
      // for layout purposes — the knowledge chip renders there.
      for (const a of (k.manual_anchors || [])) {
        if (!a?.node_id) continue
        if (!knowsAtScene.has(a.node_id)) knowsAtScene.set(a.node_id, new Set())
        knowsAtScene.get(a.node_id).add(k.id)
      }
    }

    for (const sceneId of sceneIdsInOrder) {
      const n = initialNodes.find((nn) => nn.id === sceneId)
      if (!n) continue
      for (const typeKey of TYPED_BUCKETS) {
        const refs = n.data?.[typeKey] || []
        for (const r of refs) {
          if (!r?.entity_id) continue
          if (firstAppearanceEntities.has(r.entity_id)) continue
          firstAppearanceEntities.add(r.entity_id)
          if (!firstAppearanceByScene.has(sceneId)) {
            firstAppearanceByScene.set(sceneId, new Map())
          }
          const byType = firstAppearanceByScene.get(sceneId)
          if (!byType.has(typeKey)) byType.set(typeKey, [])
          byType.get(typeKey).push(r.entity_id)
        }
      }
      // Relationships at this scene that haven't yet been first-placed.
      const relIdsHere = relsAtScene.get(sceneId)
      if (relIdsHere) {
        for (const rid of relIdsHere) {
          if (firstAppearanceRels.has(rid)) continue
          firstAppearanceRels.add(rid)
          if (!firstAppearanceByScene.has(sceneId)) firstAppearanceByScene.set(sceneId, new Map())
          const byType = firstAppearanceByScene.get(sceneId)
          if (!byType.has('relationships')) byType.set('relationships', [])
          byType.get('relationships').push(rid)
        }
      }
      // Knowledges at this scene that haven't yet been first-placed.
      const knowIdsHere = knowsAtScene.get(sceneId)
      if (knowIdsHere) {
        for (const kid of knowIdsHere) {
          if (firstAppearanceKnows.has(kid)) continue
          firstAppearanceKnows.add(kid)
          if (!firstAppearanceByScene.has(sceneId)) firstAppearanceByScene.set(sceneId, new Map())
          const byType = firstAppearanceByScene.get(sceneId)
          if (!byType.has('knowledges')) byType.set('knowledges', [])
          byType.get('knowledges').push(kid)
        }
      }
    }

    // Group chain-stop items (scenes + modifier EntityNodes) by
    // chapter, preserving overall order within each chapter. Each
    // chapter's bucket is a heterogeneous list of `{kind, id, node}`
    // shapes consumed by the packing loop below. Modifiers behave
    // like non-POV scenes for layout purposes (snapshot chapter,
    // non-POV-row y).
    const itemsByChapter = new Map()  // chapterId → ordered items[]
    const offChapterItems = []
    // Phase 8.3: locked/frozen group members and frozen concepts are held out
    // of the packing. When we reach the FIRST member (in story order) of a
    // LOCKED group, drop a synthetic `group` item into that group's chapter at
    // that ordinal — this reserves the group's footprint so non-member scenes
    // don't pack into the space the locked cluster will occupy.
    const lockedBlockInserted = new Set()
    for (const item of itemsInOrder) {
      if (excludeFromPacking.has(item.id)) {
        const gp = memberToLockedGroup.get(item.id)
        if (gp && gp.chapterId && !lockedBlockInserted.has(gp.node.id)) {
          lockedBlockInserted.add(gp.node.id)
          if (!itemsByChapter.has(gp.chapterId)) itemsByChapter.set(gp.chapterId, [])
          itemsByChapter.get(gp.chapterId).push({ kind: 'group', id: gp.node.id, group: gp })
        }
        continue
      }
      let chId
      if (item.kind === 'scene') chId = sceneChapterIntent.get(item.id)
      else if (item.kind === 'modifier') chId = modifierNodeChapterIntent.get(item.id)
      if (chId) {
        if (!itemsByChapter.has(chId)) itemsByChapter.set(chId, [])
        itemsByChapter.get(chId).push(item)
      } else {
        offChapterItems.push(item)
      }
    }

    // ── STEP 4: compute per-chapter target widths + per-item target x ──
    // We do this against original chapter widths first, computing each
    // chapter's needed expansion. Then apply via `setChapterResizeLive`
    // in chapter-index order so downstream nodes slide consistently.
    // The chapter's INTERNAL packing: each chain-stop item (scene or
    // modifier) sits at the cursor x; scenes that host first-appearance
    // entities advance the cursor by sub-column space BEFORE placing.
    // After placement the cursor advances by item width + SCENE_GAP.
    const chapterTargetWidth = new Map() // chapterId → final width
    const sceneTargetPosition = new Map() // sceneId → {x, y}
    const modifierTargetPosition = new Map() // modifierNodeId → {x, y}
    const originTargetPosition = new Map() // entityId → {x, y}
    const refNodeTargetPosition = new Map() // refNodeId → {x, y}
    // Relationship / knowledge origin nodes are looked up by their own
    // ids (relationship_id / knowledge_id), then placed by node id in
    // the final setState — the per-object id is the key here because the
    // first-appearance map carries object ids, not node ids.
    const relOriginTargetPosition = new Map() // relationshipId → {x, y}
    const knowOriginTargetPosition = new Map() // knowledgeId → {x, y}

    // Group reference nodes by snapshotted chapter (for placement
    // inside the chapter's column at REFERENCE_ROW_Y, stacked
    // vertically). Off-chapter reference nodes accumulate separately
    // and get placed past the rightmost chapter (same logic as
    // off-chapter scenes but on the reference row).
    const refNodesByChapter = new Map() // chapterId → ordered refNodeId[]
    const offChapterRefNodes = []
    for (const n of initialNodes) {
      if (n.type !== 'referenceNode') continue
      if (excludeFromPacking.has(n.id)) continue  // Phase 8.3: frozen concept / group member — not swept
      const chId = refNodeChapterIntent.get(n.id)
      if (chId) {
        if (!refNodesByChapter.has(chId)) refNodesByChapter.set(chId, [])
        refNodesByChapter.get(chId).push(n.id)
      } else {
        offChapterRefNodes.push(n.id)
      }
    }

    // Helper: compute y for a scene based on POV membership. POV
    // scenes sit on the base scene row; non-POV scenes are bumped
    // down by NON_POV_Y_OFFSET so they're visually distinguishable.
    const sceneYFor = (sceneId) => (
      povSceneIds.has(sceneId) ? SCENE_ROW_Y : SCENE_ROW_Y + NON_POV_Y_OFFSET
    )

    // Compute effective chapter left edges as we go (starting from
    // xOffset and adding the cumulative final widths of upstream
    // chapters). This lets per-scene x targets account for upstream
    // widenings.
    let chapterCursor = xOffset
    for (const c of chapters) {
      const chId = c.id
      const items = itemsByChapter.get(chId) || []
      const refIds = refNodesByChapter.get(chId) || []
      const originalWidth = c.width || 0
      // Build per-item placement inside this chapter, packing left
      // from `chapterCursor + SCENE_GAP`. Walks scenes + modifiers in
      // overall story order; scenes get first-appearance sub-columns
      // reserved LEFT of them when applicable; modifiers behave like
      // non-POV scenes for y placement (bumped down).
      let xInChapter = SCENE_GAP
      for (const item of items) {
        if (item.kind === 'scene') {
          // Reserve first-appearance sub-column space LEFT of this scene
          // if applicable. Sub-columns are WIDTH-AWARE: each populated
          // type gets a column sized to the WIDEST origin card in it (not
          // a fixed ORIGIN_SUBCOL_WIDTH), so a wide card — an entity with
          // an avatar + attribute list, a knowledge with a long body — no
          // longer overflows the fixed slot and collides with the column
          // beside it. The reserved block width is the sum of the real
          // column widths plus one ORIGIN_SUBCOL_GAP after each (the last
          // gap being the space between the rightmost column and the
          // scene it pairs with).
          const byType = firstAppearanceByScene.get(item.id)
          const subCols = []
          if (byType) {
            for (const typeKey of EXTENDED_BUCKETS) {
              const ids = byType.get(typeKey) || []
              if (ids.length === 0) continue
              let colW = ORIGIN_NODE_WIDTH
              for (const id of ids) colW = Math.max(colW, widthForBucketItem(typeKey, id))
              subCols.push({ typeKey, ids, colW })
            }
          }
          const subColBlockWidth = subCols.reduce((s, c) => s + c.colW + ORIGIN_SUBCOL_GAP, 0)
          if (subColBlockWidth > 0) {
            xInChapter += subColBlockWidth
          }
          sceneTargetPosition.set(item.id, {
            x: chapterCursor + xInChapter,
            y: sceneYFor(item.id),
          })
          // Record origin positions for objects first-appearing at this
          // scene. Columns laid out left-to-right in EXTENDED_BUCKETS
          // order: entity types first, then relationships, then knowledges.
          // Each column holds origins of one type stacked vertically with
          // height-aware spacing so taller origin cards don't overlap.
          if (subCols.length > 0) {
            const sceneLeftAbsolute = chapterCursor + xInChapter
            // Left edge of the first (leftmost) column: walk back from the
            // scene by the full reserved block. Each card is centred inside
            // its own column's real width, so nothing overflows sideways.
            let colLeft = sceneLeftAbsolute - subColBlockWidth
            for (const { typeKey, ids, colW } of subCols) {
              // Height-aware vertical stacking: cursor accumulates by
              // (this origin's measured height + gap) per row so taller
              // origin nodes (entities with many attributes, knowledges
              // with long descriptions, etc.) don't overlap the next
              // one stacked below.
              let yCursor = ORIGIN_ROW_Y
              for (let i = 0; i < ids.length; i++) {
                const id = ids[i]
                // Left-align every card at the column's left edge. The column is
                // sized to its widest card, so narrower cards keep their left
                // edges flush and none overflows into the neighbour column.
                const cardX = colLeft
                if (typeKey === 'relationships') {
                  relOriginTargetPosition.set(id, { x: cardX, y: yCursor })
                } else if (typeKey === 'knowledges') {
                  knowOriginTargetPosition.set(id, { x: cardX, y: yCursor })
                } else {
                  originTargetPosition.set(id, { x: cardX, y: yCursor })
                }
                yCursor += heightForBucketItem(typeKey, id) + ORIGIN_Y_GAP
              }
              colLeft += colW + ORIGIN_SUBCOL_GAP
            }
          }
          // Advance by the scene's ACTUAL width (measured, fallback to the
          // seed) — not a fixed constant — so wide scene cards don't overlap
          // the next scene. Mirrors the modifier branch below.
          const sceneW = item.node?.measured?.width ?? getMeasuredWidth(item.node?.id) ?? item.node?.data?.width ?? item.node?.width ?? SCENE_WIDTH
          xInChapter += sceneW + SCENE_GAP
        } else if (item.kind === 'modifier') {
          // Modifier nodes pack inline on the scene row at the
          // non-POV y (always bumped down — modifiers are chain
          // stops, not POV scenes). Width: measured fallback to
          // ORIGIN_NODE_WIDTH. No first-appearance sub-columns
          // (modifiers reference an already-existing entity).
          const modW = item.node.measured?.width ?? getMeasuredWidth(item.node.id) ?? item.node.data?.width ?? item.node.width ?? ORIGIN_NODE_WIDTH
          modifierTargetPosition.set(item.id, {
            x: chapterCursor + xInChapter,
            y: SCENE_ROW_Y + NON_POV_Y_OFFSET,
          })
          xInChapter += modW + SCENE_GAP
        } else if (item.kind === 'group') {
          // Phase 8.3: a LOCKED group occupies one reserved block at this
          // ordinal. Record the horizontal delta that lands its box's left
          // edge here; box + all members translate by it in the final pass,
          // so their internal layout (including y) is preserved.
          const gp = item.group
          const gw = groupBoxW(gp.node)
          const groupLeftTarget = chapterCursor + xInChapter
          lockedGroupResult.set(gp.node.id, { deltaX: groupLeftTarget - (gp.node.position?.x || 0) })
          xInChapter += gw + SCENE_GAP
        }
      }
      // Final chapter width: max(original, scene-content, ref-node-min).
      // Scene-content = the accumulated xInChapter (already includes
      // a trailing SCENE_GAP after the last scene, providing right-
      // side breathing room). Ref-node-min ensures chapters with
      // ONLY reference nodes (no scenes) still have width to host
      // them; chapters with scenes naturally have enough width
      // because reference nodes share x-space (they're stacked
      // vertically, not horizontally).
      // Scene+modifier content width = the accumulated cursor when any
      // items were placed; otherwise 0 (chapter has no chain-stop items
      // and the original width should win unless ref-node-min beats it).
      const sceneContentWidth = items.length > 0 ? xInChapter : 0
      const refNodeMinWidth = refIds.length > 0 ? (REFERENCE_NODE_WIDTH + 2 * SCENE_GAP) : 0
      const finalWidth = Math.max(originalWidth, sceneContentWidth, refNodeMinWidth)
      chapterTargetWidth.set(chId, finalWidth)
      // Place reference nodes in this chapter — stack vertically at
      // REFERENCE_ROW_Y, packing each at the chapter's left edge +
      // SCENE_GAP. Height-aware cursor accumulates measured height +
      // gap per row so taller reference nodes don't overlap the next.
      const refX = chapterCursor + SCENE_GAP
      let refYCursor = REFERENCE_ROW_Y
      for (const refId of refIds) {
        const refNode = initialNodes.find((nn) => nn.id === refId)
        const refHeight = refNode?.measured?.height ?? getMeasuredHeight(refNode?.id) ?? refNode?.data?.height ?? refNode?.height ?? REFERENCE_NODE_HEIGHT_FALLBACK
        refNodeTargetPosition.set(refId, { x: refX, y: refYCursor })
        refYCursor += refHeight + REFERENCE_Y_GAP
      }
      chapterCursor += finalWidth
    }

    // Place off-chapter items (scenes + modifiers) past the rightmost
    // chapter in overall order. Each branches on kind for width and y
    // assignment, same as the per-chapter packing loop above.
    {
      let xCursor = chapterCursor + SCENE_GAP
      for (const item of offChapterItems) {
        if (item.kind === 'scene') {
          sceneTargetPosition.set(item.id, {
            x: xCursor,
            y: sceneYFor(item.id),
          })
          const sceneW = item.node?.measured?.width ?? getMeasuredWidth(item.node?.id) ?? item.node?.data?.width ?? item.node?.width ?? SCENE_WIDTH
          xCursor += sceneW + SCENE_GAP
        } else if (item.kind === 'modifier') {
          const modW = item.node.measured?.width ?? getMeasuredWidth(item.node.id) ?? item.node.data?.width ?? item.node.width ?? ORIGIN_NODE_WIDTH
          modifierTargetPosition.set(item.id, {
            x: xCursor,
            y: SCENE_ROW_Y + NON_POV_Y_OFFSET,
          })
          xCursor += modW + SCENE_GAP
        }
      }
      // Off-chapter reference nodes are intentionally NOT placed here. Placing
      // them past the rightmost chapter stranded them far to the right — and in
      // multi-row the projected single-row strip is very wide, so they landed
      // extremely far out and blew up the canvas bounds (which broke minimap
      // scaling). They go in a left-gutter column before chapter 1 in STEP 5b.
    }

    // ── STEP 5: place unreferenced origins in pre-chapter columns ──
    // Walk entities buckets; any entity not in `firstAppearanceEntities`
    // is unreferenced. Same for relationships / knowledges that have an
    // origin node on canvas but no scene-level chain stops (the rel/
    // knowledge object exists but no scene anchors it yet). Group by
    // type, place in per-type columns left of chapter 1 (mirroring
    // template-import's `_place_pre_chapter_columns`).
    const allEntities = useEntitiesStore.getState()
    const unreferencedByType = new Map()
    for (const typeKey of TYPED_BUCKETS) {
      const list = allEntities[typeKey] || []
      const unref = list.filter((e) => !firstAppearanceEntities.has(e.id))
      if (unref.length > 0) unreferencedByType.set(typeKey, unref.map((e) => e.id))
    }
    // Unreferenced relationships / knowledges: an "object" here is one
    // that has an origin node on canvas (it WOULD be placed by the
    // first-appearance walk if any scene referenced it) but no scene
    // does. These get their own pre-chapter columns alongside the
    // entity-type columns.
    {
      const unrefRels = []
      for (const rid of relOriginNodeByRelId.keys()) {
        if (!firstAppearanceRels.has(rid)) unrefRels.push(rid)
      }
      if (unrefRels.length > 0) unreferencedByType.set('relationships', unrefRels)
    }
    {
      const unrefKnows = []
      for (const kid of knowOriginNodeByKnowId.keys()) {
        if (!firstAppearanceKnows.has(kid)) unrefKnows.push(kid)
      }
      if (unrefKnows.length > 0) unreferencedByType.set('knowledges', unrefKnows)
    }
    // Leftmost x reached by the unreferenced-origin columns (null = none
    // placed). The off-chapter reference column (below) sits further left.
    let preChapterColsLeftEdge = null
    {
      const populated = EXTENDED_BUCKETS.filter((k) => unreferencedByType.has(k))
      if (populated.length > 0) {
        const rightEdge = xOffset - PRE_CHAPTER_BUFFER
        // Width-aware columns (same fix as the first-appearance sub-columns
        // above): size each type's column to the WIDEST unreferenced card in
        // it rather than a fixed PRE_CHAPTER_COL_WIDTH. A wide card (a
        // knowledge with a long body, an entity with a full attribute list)
        // centred in the old fixed slot spilled its edges into BOTH neighbour
        // columns — that spill is the reported pre-chapter overlap (knowledge
        // cards over character cards and the reference-note gutter). Columns
        // are laid out left→right with a PRE_CHAPTER_BUFFER gap between them;
        // the whole block's right edge lands at `rightEdge` so it clears
        // chapter 1 by PRE_CHAPTER_BUFFER, and its left edge is published as
        // `preChapterColsLeftEdge` for the note gutter (STEP 5b) to sit past.
        const cols = populated.map((typeKey) => {
          const ids = unreferencedByType.get(typeKey) || []
          let colW = ORIGIN_NODE_WIDTH
          for (const id of ids) colW = Math.max(colW, widthForBucketItem(typeKey, id))
          return { typeKey, ids, colW }
        })
        const blockWidth =
          cols.reduce((s, c) => s + c.colW, 0) + Math.max(0, cols.length - 1) * PRE_CHAPTER_BUFFER
        const leftmostLeft = rightEdge - blockWidth
        preChapterColsLeftEdge = leftmostLeft
        let colLeft = leftmostLeft
        for (const { typeKey, ids, colW } of cols) {
          // Height-aware vertical stacking (same pattern as the
          // first-appearance sub-column loop above): cursor accumulates
          // by measured height + gap per row so taller origin nodes
          // don't overlap downstream stacked nodes. Each card is
          // left-aligned at the column's left edge; the column is sized to
          // its widest card, so nothing overflows into a neighbour column.
          let yCursor = SCENE_ROW_Y
          for (const id of ids) {
            // Left-align every card at the column's left edge (column sized to
            // its widest card, so nothing overflows into the neighbour column).
            const cardX = colLeft
            if (typeKey === 'relationships') {
              relOriginTargetPosition.set(id, { x: cardX, y: yCursor })
            } else if (typeKey === 'knowledges') {
              knowOriginTargetPosition.set(id, { x: cardX, y: yCursor })
            } else {
              originTargetPosition.set(id, { x: cardX, y: yCursor })
            }
            yCursor += heightForBucketItem(typeKey, id) + ORIGIN_Y_GAP
          }
          colLeft += colW + PRE_CHAPTER_BUFFER
        }
      }
    }

    // ── STEP 5b: off-chapter reference nodes in a left-gutter column ──
    // Rule: a node not wired into the chain keeps its chapter if it had one,
    // else it's parked in a per-type column left of chapter 1. Reference nodes
    // inside a chapter were stacked in that chapter above (refNodesByChapter);
    // the rest go in ONE column to the LEFT of the unreferenced-origin columns
    // (or just left of chapter 1 when there are none), stacked vertically with
    // height-aware spacing. This keeps them in a compact left gutter with the
    // other "not in the story flow" nodes instead of stranded far to the right
    // of the chapter strip (which, in multi-row, is very wide).
    if (offChapterRefNodes.length > 0) {
      const refColRight = (preChapterColsLeftEdge != null)
        ? preChapterColsLeftEdge - PRE_CHAPTER_BUFFER
        : xOffset - PRE_CHAPTER_BUFFER
      // Size the column from the WIDEST off-chapter ref card (measured), not the
      // REFERENCE_NODE_WIDTH estimate. Ref cards routinely render wider than the
      // estimate, so a fixed-width column let their right edge spill into the
      // column on the right and overlap it. Left-aligning every card at
      // (refColRight - widest) keeps the widest card's right edge exactly at
      // refColRight, so the gap to whatever's on the right is clean for all of
      // them — matching the consistent gaps the origin columns already have.
      const refWidthOf = (id) => {
        const n = initialNodes.find((nn) => nn.id === id)
        return n?.measured?.width ?? getMeasuredWidth(id) ?? n?.data?.width ?? n?.width ?? REFERENCE_NODE_WIDTH
      }
      const maxRefW = Math.max(REFERENCE_NODE_WIDTH, ...offChapterRefNodes.map(refWidthOf))
      const refColLeft = refColRight - maxRefW
      let refYCursor = SCENE_ROW_Y
      for (const refId of offChapterRefNodes) {
        const refNode = initialNodes.find((nn) => nn.id === refId)
        const refHeight = refNode?.measured?.height ?? getMeasuredHeight(refNode?.id) ?? refNode?.data?.height ?? refNode?.height ?? REFERENCE_NODE_HEIGHT_FALLBACK
        refNodeTargetPosition.set(refId, { x: refColLeft, y: refYCursor })
        refYCursor += refHeight + REFERENCE_Y_GAP
      }
    }

    // ── STEP 6: apply changes ──
    // (a) snapshot for atomic undo is taken by the public `reorganizeCanvas`
    //     wrapper (which also brackets the multi-row project/re-wrap), so this
    //     implementation must NOT snapshot — that would split one reorganize
    //     into multiple undo steps. No state has been mutated above this point
    //     (pure computation into local maps), so the wrapper's earlier snapshot
    //     captures the correct pre-reorganize state.
    // (b) apply chapter widenings via setChapterResizeLive in chapter
    //     index order — each call's nodeUpdates slides downstream
    //     nodes by THIS chapter's delta; subsequent chapters' deltas
    //     are then applied against the post-previous-widening state
    // (c) apply scene + origin position patches in one setState (this
    //     OVERRIDES the slide for any node we're explicitly placing,
    //     which is the intended behaviour)
    for (const c of chapters) {
      const target = chapterTargetWidth.get(c.id)
      if (target == null) continue
      const liveState = useProjectStore.getState()
      const liveChapter = (liveState.story?.chapters || []).find((cc) => cc.id === c.id)
      if (!liveChapter) continue
      if (Math.abs(target - (liveChapter.width || 0)) < 1) continue
      const delta = target - (liveChapter.width || 0)
      // Live right edge of this chapter (using the current store
      // state, which reflects any earlier widenings applied in this
      // loop).
      let liveRightEdge = liveState.story?.chapter_x_offset ?? 10
      for (const cc of liveState.story?.chapters || []) {
        liveRightEdge += cc.width || 0
        if (cc.id === c.id) break
      }
      const nodeUpdates = []
      for (const n of liveState.nodes || []) {
        if (slideProtectIds.has(n.id)) continue  // Phase 8.3: locked group box/members placed explicitly, never slid
        const nw = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? (n.type === 'sceneNode' ? SCENE_WIDTH : ORIGIN_NODE_WIDTH)
        const nx = n.position?.x || 0
        const centreX = nx + nw / 2
        if (centreX > liveRightEdge) {
          nodeUpdates.push({ id: n.id, x: nx + delta })
        }
      }
      get().setChapterResizeLive(c.id, { width: target, nodeUpdates })
    }
    // Phase 8.3: SPREAD groups (members span chapters) get their box grown to
    // bound where the members land. Compute each spread group's target box from
    // its members' FINAL positions (the target maps populated above); members
    // without a target keep their current position.
    const finalPosOf = (node) => {
      if (node.type === 'sceneNode') return sceneTargetPosition.get(node.id) || node.position
      if (node.type === 'entityNode' && node.data?.is_modifier) return modifierTargetPosition.get(node.id) || node.position
      if (node.type === 'entityNode' && node.data?.entity_id) return originTargetPosition.get(node.data.entity_id) || node.position
      if (node.type === 'referenceNode') return refNodeTargetPosition.get(node.id) || node.position
      if (node.type === 'relationshipOriginNode' && node.data?.relationship_id) return relOriginTargetPosition.get(node.data.relationship_id) || node.position
      if (node.type === 'knowledgeOriginNode' && node.data?.knowledge_id) return knowOriginTargetPosition.get(node.data.knowledge_id) || node.position
      return node.position
    }
    const GROUP_REFIT_PAD = 24
    // Reserve the group header bar above the members (matches addGroupNode /
    // _refitGroupBoxesToMembers) so the top member isn't tucked under the 26px header.
    const GROUP_REFIT_HEADER = 26
    const spreadBoxResult = new Map()  // groupNodeId → { x, y, w, h }
    for (const gp of spreadGroups) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const id of gp.memberIds) {
        const mn = initialNodes.find((nn) => nn.id === id)
        if (!mn) continue
        const p = finalPosOf(mn) || mn.position || { x: 0, y: 0 }
        const mw = mn.measured?.width ?? getMeasuredWidth(mn.id) ?? mn.data?.width ?? mn.width ?? 200
        const mh = mn.measured?.height ?? getMeasuredHeight(mn.id) ?? mn.data?.height ?? mn.height ?? 120
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + mw); maxY = Math.max(maxY, p.y + mh)
      }
      if (minX === Infinity) continue
      spreadBoxResult.set(gp.node.id, {
        x: minX - GROUP_REFIT_PAD, y: minY - GROUP_REFIT_PAD - GROUP_REFIT_HEADER,
        w: (maxX - minX) + 2 * GROUP_REFIT_PAD, h: (maxY - minY) + 2 * GROUP_REFIT_PAD + GROUP_REFIT_HEADER,
      })
    }

    // Now apply all scene + origin + modifier + reference-node patches. The
    // Phase 8.3 group/concept branches run FIRST so they win over the normal
    // per-type placement for any protected node.
    set((s) => ({
      nodes: s.nodes.map((n) => {
        // Locked-group member: translate with its group by the recorded deltaX.
        const lg = memberToLockedGroup.get(n.id)
        if (lg) {
          const r = lockedGroupResult.get(lg.node.id)
          if (r) return { ...n, position: { x: (n.position?.x || 0) + r.deltaX, y: n.position?.y || 0 } }
          return n
        }
        if (n.type === 'genericGroupNode') {
          const r = lockedGroupResult.get(n.id)
          if (r) return { ...n, position: { x: (n.position?.x || 0) + r.deltaX, y: n.position?.y || 0 } }
          const sr = spreadBoxResult.get(n.id)
          if (sr) return {
            ...n, position: { x: sr.x, y: sr.y }, width: sr.w, height: sr.h,
            data: { ...n.data, width: sr.w, height: sr.h },
            style: { ...(n.style || {}), width: sr.w, height: sr.h },
            // Also write `measured` (React Flow v12): membership reads it first,
            // and an off-screen spread group is never re-measured, so a stale
            // height would drop a member the grown box does contain.
            measured: { ...(n.measured || {}), width: sr.w, height: sr.h },
          }
          return n  // frozen group: left in place (slides uniformly with widening)
        }
        if (conceptLayerIds.has(n.id)) return n  // concept layer: left in place here, re-tidied by the concept pass
        if (n.type === 'sceneNode') {
          const tp = sceneTargetPosition.get(n.id)
          if (tp) return { ...n, position: tp }
        } else if (n.type === 'entityNode' && n.data?.is_modifier) {
          // Modifier EntityNode: lookup by node id (NOT entity_id —
          // multiple modifier nodes can reference the same entity).
          const tp = modifierTargetPosition.get(n.id)
          if (tp) return { ...n, position: tp }
        } else if (n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id) {
          const tp = originTargetPosition.get(n.data.entity_id)
          if (tp) return { ...n, position: tp }
        } else if (n.type === 'referenceNode') {
          const tp = refNodeTargetPosition.get(n.id)
          if (tp) return { ...n, position: tp }
        } else if (n.type === 'relationshipOriginNode' && n.data?.relationship_id) {
          // Looked up by relationship-id (one origin node per
          // relationship). Placed in a sub-column LEFT of the first
          // scene where the relationship has a chain event, or in
          // a pre-chapter column if no scene references it.
          const tp = relOriginTargetPosition.get(n.data.relationship_id)
          if (tp) return { ...n, position: tp }
        } else if (n.type === 'knowledgeOriginNode' && n.data?.knowledge_id) {
          // Same treatment as relationship origins — looked up by
          // knowledge-id, first-appearance sub-column or pre-chapter.
          const tp = knowOriginTargetPosition.get(n.data.knowledge_id)
          if (tp) return { ...n, position: tp }
        }
        return n
      }),
      hasUnsavedChanges: true,
    }))
  },

  /** Delete a node and all its attached edges. Always asks for confirmation. */
  /**
   * Public canvas-node delete entry point. Shows a confirm dialog for wired/content-bearing
   * nodes, then hands off to the dispatcher. The actual deletion + reference-stripping lives
   * in `_deleteNodeInternal` via `deleteObject('node', id)`.
   */
  deleteNode: async (nodeId) => {
    const { nodes, edges } = get()
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return

    // Relationship origin node: cascade-delete the whole relationship.
    // A rel origin node is a relationship's starting point; leaving the
    // relationship behind without its origin produces a ghost in a broken
    // state that has nowhere to hang on the canvas. Confirm + route to the
    // full relationship delete instead of a plain node strip.
    if (node.type === 'relationshipOriginNode') {
      const relId = node.data?.relationship_id
      const rel = relId ? get().relationships.find((r) => r.id === relId) : null
      const result = await confirm({
        title: 'Delete relationship',
        message:
          'Removing a relationship\u2019s origin node deletes the relationship itself. ' +
          'This removes it from the entire story \u2014 every chip, every history event, everywhere it appears.',
        buttons: [
          { label: 'Delete relationship', value: 'delete', style: 'danger' },
          { label: 'Cancel',               value: 'cancel', style: 'neutral' },
        ],
      })
      if (result !== 'delete') return
      if (rel) return get().deleteObject('relationship', relId)
      // Fallback: orphan origin node with no backing rel — just strip the node.
      return get().deleteObject('node', nodeId)
    }

    const isWired = edges.some((e) => e.source === nodeId || e.target === nodeId)

    // Determine whether the node has meaningful content
    let hasContent = false
    if (node.type === 'sceneNode') {
      const d = node.data || {}
      hasContent = !!(d.title || d.description || d.main_content) ||
        ['characters', 'locations', 'items', 'factions', 'customs']
          .some((b) => (d[b] || []).length > 0)
    } else if (node.type === 'entityNode' && node.data?.is_modifier) {
      const d = node.data || {}
      hasContent = d.name_change != null || d.colour_change != null ||
        d.description_change != null || d.profile_image_change != null ||
        (d.attribute_changes && d.attribute_changes.length > 0)
    } else if (node.type === 'referenceNode') {
      const d = node.data || {}
      hasContent = !!(d.title || d.content || d.file_ref)
    }

    // No content and not wired → delete silently
    // Has content or wired → simple confirmation
    if (hasContent || isWired) {
      const reasons = []
      if (hasContent) reasons.push('has changes that will be lost')
      if (isWired) reasons.push('is wired into the narrative chain')
      const msg = `Delete this node?\n\nThis node ${reasons.join(' and ')}.`
      const result = await confirm({
        title: 'Delete node',
        message: msg,
        buttons: [
          { label: 'Delete', value: 'delete', style: 'danger'  },
          { label: 'Cancel', value: 'cancel', style: 'neutral' },
        ],
      })
      if (result !== 'delete') return
    }

    return get().deleteObject('node', nodeId)
  },

  /** Update the data payload of a specific edge (e.g. transition_text). */
  updateEdgeData: (edgeId, dataUpdate) => {
    set({
      edges: get().edges.map((e) =>
        e.id === edgeId ? { ...e, data: { ...e.data, ...dataUpdate } } : e,
      ),
      hasUnsavedChanges: true,
    })
  },

  // ── Wire routing waypoint actions ─────────────────────────────────────────

  /** Remove a waypoint by index from an edge's waypoints array. */
  removeWaypoint: (edgeId, waypointIndex) => {
    get()._snapshot()
    set({
      edges: get().edges.map((e) => {
        if (e.id !== edgeId) return e
        const wps = (e.data?.waypoints || []).filter((_, i) => i !== waypointIndex)
        return { ...e, data: { ...e.data, waypoints: wps } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Toggle a waypoint's type between 'curve' and 'sharp'. */
  toggleWaypointType: (edgeId, waypointIndex) => {
    get()._snapshot()
    set({
      edges: get().edges.map((e) => {
        if (e.id !== edgeId) return e
        const wps = (e.data?.waypoints || []).map((wp, i) =>
          i === waypointIndex ? { ...wp, type: wp.type === 'curve' ? 'sharp' : 'curve' } : wp,
        )
        return { ...e, data: { ...e.data, waypoints: wps } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Update a waypoint's position (called on every mousemove during drag — no snapshot).
   *  Does NOT re-sort by t to avoid index instability mid-drag. Sort on drag end via sortEdgeWaypoints. */
  updateWaypointPosition: (edgeId, waypointIndex, newRelative) => {
    set({
      edges: get().edges.map((e) => {
        if (e.id !== edgeId) return e
        const wps = (e.data?.waypoints || []).map((wp, i) =>
          i === waypointIndex ? { ...wp, ...newRelative } : wp,
        )
        return { ...e, data: { ...e.data, waypoints: wps } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Re-sort an edge's waypoints by t. Called once at the end of a waypoint drag. */
  sortEdgeWaypoints: (edgeId) => {
    set({
      edges: get().edges.map((e) => {
        if (e.id !== edgeId) return e
        const wps = [...(e.data?.waypoints || [])].sort((a, b) => a.t - b.t)
        return { ...e, data: { ...e.data, waypoints: wps } }
      }),
    })
  },

  /** Capture undo snapshot before a waypoint drag begins. */
  snapshotForWaypointDrag: () => {
    get()._snapshot()
  },

  /** Auto-route wires around non-connected nodes using visibility-graph pathfinding.
   *
   *  Pipeline:
   *    1. Sort edges by source handle Y (top-of-node first) for natural track ordering
   *    2. Group sibling edges (same source+target pair) for parallel routing
   *    3. Route groups sequentially — each solved route becomes an obstacle for later wires
   *    4. Within each group: compute base route, simplify, apply parallel offsets
   *    5. Cross-wire waypoint deconfliction
   *    6. Position transition-note dots at visible path locations
   *
   *  @param {object[]} measuredNodes — nodes from useReactFlow().getNodes() with .measured dims
   *  @param {Map<string, {sourceX, sourceY, targetX, targetY}>} [handlePositions] —
   *         real handle positions from buildHandlePositionMap(); falls back to computeHandlePositions() */
  tidyWires: (measuredNodes, handlePositions) => {
    get()._snapshot()
    const { nodes, edges } = get()

    // Merge store nodes with measured dimensions
    const nodeMap = new Map()
    for (const n of nodes) nodeMap.set(n.id, n)
    if (measuredNodes) {
      for (const mn of measuredNodes) {
        const existing = nodeMap.get(mn.id)
        if (existing) nodeMap.set(mn.id, { ...existing, measured: mn.measured })
      }
    }

    // Select edges to tidy
    const selectedEdges = edges.filter((e) => e.selected && e.type === 'transitionEdge')
    const edgesToTidy = selectedEdges.length > 0
      ? selectedEdges
      : edges.filter((e) => e.type === 'transitionEdge')

    if (edgesToTidy.length === 0) return

    // ── Phase 1: sort by source handle Y (top chips route first → upper tracks) ──
    edgesToTidy.sort((a, b) => {
      const ay = handlePositions?.get(a.id)?.sourceY ?? estimateHandleY(a, nodeMap)
      const by = handlePositions?.get(b.id)?.sourceY ?? estimateHandleY(b, nodeMap)
      return ay - by
    })

    // ── Phase 2: group siblings preserving handle-Y order ────────────────
    const groupMap = new Map()
    const groupOrder = []
    for (const edge of edgesToTidy) {
      const key = `${edge.source}::${edge.target}`
      if (!groupMap.has(key)) { groupMap.set(key, []); groupOrder.push(key) }
      groupMap.get(key).push(edge)
    }

    // Unpadded node bboxes for dot-visibility checks
    const allNodeBBoxes = [...nodeMap.values()].map((n) => getNodeBBox(n, 0))

    // ── Phase 3: route each edge around non-connected node obstacles ─────
    const edgeRoutes = []

    for (const key of groupOrder) {
      const group = groupMap.get(key)
      const first = group[0]
      const sourceNode = nodeMap.get(first.source)
      const targetNode = nodeMap.get(first.target)
      if (!sourceNode || !targetNode) continue

      // Obstacles = all nodes except source and target (node bounding boxes only)
      const obstacles = [...nodeMap.values()]
        .filter((n) => n.id !== first.source && n.id !== first.target)
        .map((n) => getNodeBBox(n))

      // Route each edge individually using its real handle positions
      for (let i = 0; i < group.length; i++) {
        const edge = group[i]

        // Use real handle positions from React Flow when available; fall back to estimate
        const pos = handlePositions?.get(edge.id) || computeHandlePositions(sourceNode, targetNode)
        const { sourceX, sourceY, targetX, targetY } = pos

        // Compute and simplify the route for this specific edge
        const baseWaypoints = computeTidyWaypoints(sourceX, sourceY, targetX, targetY, obstacles)
        const waypoints = simplifyPath(baseWaypoints, sourceX, sourceY, targetX, targetY, obstacles)

        edgeRoutes.push({ edgeId: edge.id, waypoints, sourceX, sourceY, targetX, targetY })
      }
    }

    // ── Phase 4: cross-wire waypoint deconfliction ───────────────────────
    deconflictWaypoints(edgeRoutes)

    // ── Phase 5: position transition-note dots at visible locations ──────
    let updatedEdges = [...edges]
    for (const route of edgeRoutes) {
      const { label_offset_x, label_offset_y } = findClearDotPosition(
        route.sourceX, route.sourceY, route.targetX, route.targetY,
        route.waypoints, allNodeBBoxes,
      )
      updatedEdges = updatedEdges.map((e) =>
        e.id === route.edgeId
          ? { ...e, data: { ...e.data, waypoints: route.waypoints, label_offset_x, label_offset_y, label_waypoint_type: 'sharp' } }
          : e,
      )
    }

    set({ edges: updatedEdges, hasUnsavedChanges: true })
  },

  toggleMinimap: () => set({ showMinimap: !get().showMinimap }),
  toggleSnapToGrid: () => set({ snapToGrid: !get().snapToGrid }),

  /** Bulk-snap every node on the canvas to the 20-flow-px grid —
   *  positions rounded to the nearest dot (with a half-cell offset to
   *  match the `<Background gap={20}>` pattern), widths / heights
   *  rounded UP to the next grid step so nothing gets smaller than
   *  its current size. Single undo step. Phase 1.12c v0.1.12.63 —
   *  triggered by Ctrl/Cmd+click on the snap-to-grid toggle button.
   *  Runs regardless of whether `snapToGrid` is currently enabled
   *  (it's a one-shot "clean up the canvas" operation).
   *
   *  Grid constants are duplicated here from `Canvas.jsx` instead of
   *  imported to avoid introducing a circular dependency between the
   *  store and the canvas component; they must be kept in sync. */
  snapAllNodesToGrid: () => {
    const SNAP_STEP = 20
    const SNAP_POS_OFFSET = 10
    const SNAP_DIM_TOLERANCE = 2
    const { nodes } = get()
    if (!nodes || nodes.length === 0) return
    get()._snapshot()
    const snapPos = (v) => Math.round((v - SNAP_POS_OFFSET) / SNAP_STEP) * SNAP_STEP + SNAP_POS_OFFSET
    // Tolerance-aware ceiling-round: if a node's measured dimension
    // sits within SNAP_DIM_TOLERANCE px ABOVE a lower grid step, snap
    // DOWN to that step; otherwise ceiling-round UP. Handles the
    // 1-2 px drift RF's `measured.*` reports from border / padding /
    // sub-pixel rounding, so minimal entity nodes at 81 px snap to
    // 80 (not 100), without breaking content-safety for nodes at
    // 147 px that need to round up to 160.
    const snapUp = (v) => {
      const floor = Math.floor(v / SNAP_STEP) * SNAP_STEP
      if (v - floor <= SNAP_DIM_TOLERANCE) return Math.max(SNAP_STEP, floor)
      return Math.max(SNAP_STEP, Math.ceil(v / SNAP_STEP) * SNAP_STEP)
    }
    const nextNodes = nodes.map((n) => {
      const out = { ...n }
      if (n.position) {
        out.position = {
          ...n.position,
          x: snapPos(n.position.x || 0),
          y: snapPos(n.position.y || 0),
        }
      }
      // Snap the effective width / height UP to the next grid step
      // and write it back into `data.width` / `data.height` — the
      // authoritative slot NarrativeNode's custom nodes (Scene,
      // Entity, Reference, GenericGroup) all pass `{width, height}`
      // through `updateNodeData` on resize, so `data.*` is what the
      // node components READ for their effective dimensions.
      //
      // Critically, `data.width` / `data.height` is written
      // **unconditionally** when the node has a measurable size —
      // NOT gated on whether the slot was previously set. Auto-sized
      // plot point nodes have `data.height === null` before bulk
      // snap, and the earlier version of this code skipped them,
      // leaving React Flow's next ResizeObserver pass to re-measure
      // the node back to its natural content height (whatever that
      // happens to be, not a grid multiple). Always writing
      // `data.height` forces the node to adopt the snapped value;
      // the custom min-height effect in `SceneNode.jsx:805` will
      // only override if `data.height < naturalMinHeight`, which is
      // impossible here because we snap UP from the currently
      // rendered height (so snapped value >= naturalMinHeight).
      //
      // `measured`, `style`, and top-level slots are also updated
      // when present so RF's next render pass agrees with the new
      // dimensions without flickering back to the pre-snap values.
      const curW = n.measured?.width ?? getMeasuredWidth(n.id)  ?? n.data?.width  ?? n.style?.width  ?? n.width
      const curH = n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.style?.height ?? n.height
      if (typeof curW === 'number' && curW > 0) {
        const newW = snapUp(curW)
        out.data = { ...(out.data || n.data || {}), width: newW }
        if (n.width       != null)      out.width    = newW
        if (n.style?.width != null)     out.style    = { ...(out.style || n.style || {}), width: newW }
        if (n.measured?.width != null)  out.measured = { ...(out.measured || n.measured || {}), width: newW }
      }
      if (typeof curH === 'number' && curH > 0) {
        const newH = snapUp(curH)
        out.data = { ...(out.data || n.data || {}), height: newH }
        if (n.height       != null)     out.height   = newH
        if (n.style?.height != null)    out.style    = { ...(out.style || n.style || {}), height: newH }
        if (n.measured?.height != null) out.measured = { ...(out.measured || n.measured || {}), height: newH }
      }
      return out
    })
    set({ nodes: nextNodes, hasUnsavedChanges: true })
  },

  clearError: () => set({ error: null }),

  /**
   * Create an origin entity node to the left of a scene node, wire it in,
   * and add the entity chip to the scene — all in one atomic operation.
   * Called when dragging an uninstantiated entity onto a scene node.
   */
  createOriginAndWireToScene: (sceneNodeId, entityId) => {
    get()._snapshot()
    const { nodes, edges } = get()
    const sceneNode = nodes.find((n) => n.id === sceneNodeId)
    if (!sceneNode) return

    const entity = useEntitiesStore.getState().getEntityById(entityId)
    if (!entity) return

    const bucketMap = {
      character: 'characters', location: 'locations',
      item: 'items', faction: 'factions', custom: 'customs',
    }
    const bucket = bucketMap[entity.type]
    if (!bucket) return

    const currentRefs = sceneNode.data[bucket] || []
    if (currentRefs.some((r) => r.entity_id === entityId)) return // already present

    // Position origin node to the left of the scene node
    const originPos = {
      x: sceneNode.position.x - 200,
      y: sceneNode.position.y,
    }

    // Create the origin node
    const originNodeId = crypto.randomUUID()
    const originNode = {
      id: originNodeId,
      type: 'entityNode',
      position: originPos,
      data: {
        id: originNodeId,
        entity_id: entityId,
        node_type: 'entity',
      },
    }

    // Create the wire from origin to scene
    const edgeId = crypto.randomUUID()
    const newEdge = {
      id: edgeId,
      source: originNodeId,
      target: sceneNodeId,
      sourceHandle: null,
      type: 'transitionEdge',
      data: {
        id: edgeId,
        source_node_id: originNodeId,
        target_node_id: sceneNodeId,
        source_entity_id: entityId,
        target_entity_id: null,
        transition_text: '',
        entity_ids: [entityId],
        is_pov_path: false,
      },
    }

    // Create the entity chip ref
    const newRef = {
      entity_id: entityId,
      name_change: null, colour_change: null,
      description_change: null, profile_image_change: null,
      attribute_changes: [],
      awareness_changes: [],
      has_pov: false,
    }

    set({
      nodes: [
        ...nodes.map((n) =>
          n.id === sceneNodeId
            ? { ...n, data: { ...n.data, [bucket]: [...currentRefs, newRef] } }
            : n
        ),
        originNode,
      ],
      edges: addEdge(newEdge, edges),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Secondary add method: add an entity chip to a plot point node immediately,
   * then run the upstream search + confirm flow to wire it.
   * Called by drag-from-library and right-click > Add Entity.
   */
  addEntityChipToNode: (targetNodeId, entityId, options = {}) => {
    const { skipUpstreamConfirm = false } = options
    get()._snapshot()
    const { nodes } = get()
    const targetNode = nodes.find((n) => n.id === targetNodeId)
    if (!targetNode || targetNode.type !== 'sceneNode') return

    const entity = useEntitiesStore.getState().getEntityById(entityId)
    if (!entity) return

    const bucketMap = {
      character: 'characters', location: 'locations',
      item: 'items', faction: 'factions', custom: 'customs',
    }
    const bucket = bucketMap[entity.type]
    if (!bucket) return

    const currentRefs = targetNode.data[bucket] || []
    if (currentRefs.some((r) => r.entity_id === entityId)) return  // already present

    const newRef = {
      entity_id: entityId,
      name_change: null, colour_change: null,
      description_change: null, profile_image_change: null,
      attribute_changes: [],
      awareness_changes: [],
      has_pov: false,
    }

    set({
      nodes: nodes.map((n) =>
        n.id === targetNodeId
          ? { ...n, data: { ...n.data, [bucket]: [...currentRefs, newRef] } }
          : n
      ),
    })

    // Run the upstream-search + connect-prompt flow unless the caller
    // opts out. MCP-driven chip adds skip this because (a) the AI's
    // intent is explicit (it asked to make a change AT this scene)
    // and (b) popping a confirm dialog mid-tool-call interleaves
    // with the MCP session lockout overlay in confusing ways. The
    // chip stays "orphaned" without a backwards wire; the user can
    // add wires later via dedicated tools or by hand. UI-driven
    // adds keep the existing behaviour by default.
    if (!skipUpstreamConfirm) {
      get()._confirmUpstreamConnection(targetNodeId, entityId)
    }
  },

  /**
   * Update an EntityRef override at a specific node. Clears review_fields on
   * the updated ref (the user's deliberate edit counts as "reviewed"), then
   * reactively updates flags on nodes DOWNSTREAM of this node only.
   *
   * Flags are NOT recomputed for the entire graph — only nodes downstream of
   * nodeId are touched. This means creating a downstream change never flags
   * that downstream node for pre-existing upstream changes; only modifying an
   * upstream change causes flags to fire on nodes below it.
   */
  updateEntityRef: (nodeId, entityId, changes) => {
    get()._snapshot()
    const { nodes, edges } = get()

    // Capture old changed fields before applying the edit
    let oldEntityRef = null
    outer: for (const n of nodes) {
      if (n.id !== nodeId || n.type !== 'sceneNode') continue
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (n.data[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { oldEntityRef = ref; break outer }
      }
    }
    const oldChangedFields = oldEntityRef ? getChangedFields(oldEntityRef) : []

    // Apply changes + clear review_fields on the updated ref
    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId || n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entityId)
        if (idx !== -1) {
          // Preserve review_fields — upstream flags are cleared selectively below, not wiped wholesale.
          // Wiping them here would clear flags for unrelated fields every time any field is edited.
          newData[bucket] = refs.map((r, i) => {
            if (i !== idx) return r
            const merged = { ...r, ...changes }
            // Reconcile scalar_change_ids so each scalar field has a
            // stable UUID addressable for Knowledge tracking / source
            // event back-pointers. Same maintenance the
            // saveEntityChipDraft path performs.
            return { ...merged, scalar_change_ids: maintainScalarChangeIds(r, merged) }
          })
          break
        }
      }
      return { ...n, data: newData }
    })

    // Derive new changed fields from the updated ref
    let newEntityRef = null
    outer2: for (const n of updatedNodes) {
      if (n.id !== nodeId || n.type !== 'sceneNode') continue
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (n.data[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { newEntityRef = ref; break outer2 }
      }
    }
    const newChangedFields = newEntityRef ? getChangedFields(newEntityRef) : []
    const removedFields = oldChangedFields.filter((f) => !newChangedFields.includes(f))
    const newVals = newEntityRef ? getSourceValues(newEntityRef) : {}
    const oldVals = oldEntityRef ? getSourceValues(oldEntityRef) : {}

    // Drop a flag on this node when either:
    // (a) the field is no longer overridden here (conflict gone), OR
    // (b) the user actively changed the override VALUE for that field
    //     (updating the value = reviewing and deciding on a new response, which resolves the conflict)
    // Cancelled list op flags are always preserved here — they are only cleared when the user
    // explicitly dismisses the alert (via clearEntityReviewField).
    if (newEntityRef) {
      const newChangedFieldsSet = new Set(newChangedFields)
      updatedNodes = updatedNodes.map((n) => {
        if (n.id !== nodeId || n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx !== -1) {
            const currentFlags = refs[idx].review_fields || []
            const filtered = currentFlags.filter((flag) => {
              // Cancelled list op flags persist until explicitly dismissed
              if (typeof flag === 'object' && flag.cancelled) return true
              const f = flagField(flag)
              if (!newChangedFieldsSet.has(f)) return false  // (a) override removed
              if (newVals[f] !== oldVals[f]) return false    // (b) override value changed
              return true
            })
            if (filtered.length === currentFlags.length) break
            newData[bucket] = refs.map((r, i) => i === idx ? { ...r, review_fields: filtered } : r)
            break
          }
        }
        return { ...n, data: newData }
      })
    }

    // Only flag downstream fields whose VALUE actually changed — not all fields with overrides
    const actuallyChanged = newChangedFields.filter((f) => newVals[f] !== oldVals[f])

    // Apply flags reactively: only downstream nodes are affected
    const nodesWithFlags = applyDownstreamReviewFlags(
      updatedNodes, edges, nodeId, entityId, actuallyChanged, removedFields,
      newEntityRef ? getSourceValues(newEntityRef) : undefined,
      oldEntityRef ? getSourceValues(oldEntityRef) : undefined
    )
    set({ nodes: nodesWithFlags, hasUnsavedChanges: true })

    // Awareness-rollover modal — fire for value-commits that touch a
    // field whose own awareness layer has tracking on at the anchor.
    // Story-settings gate suppresses; chain anchor only.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false) {
        const es = useEntitiesStore.getState()
        const entity = (es.getEntityById && es.getEntityById(entityId))
          || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs].find((e) => e.id === entityId)
        if (entity) {
          const ctx = {
            allEntities: [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs],
            allRelationships: get().relationships,
            nodes: get().nodes,
            edges: get().edges,
            anchorNodeId: nodeId,
            storyOrder: computeStoryOrder({ nodes: get().nodes, edges: get().edges }),
          }
          const anchor = { kind: 'chain', nodeId }
          const pages = []
          if (changes.name_change != null && changes.name_change !== '') {
            const page = buildRolloverPage({
              entity, target: { kind: 'entity_name', entityId }, anchor,
              fieldLabel: 'Name',
              oldValue: oldEntityRef?.name_change ?? entity.name ?? null,
              newValue: changes.name_change,
              ctx, storyEnabled: story?.awareness_rollover_check_enabled !== false,
            })
            if (page) pages.push(page)
          }
          for (const ac of (changes.attribute_changes || [])) {
            if (ac?.action !== 'modify' || !ac.attribute_id) continue
            const attr = (entity.attributes || []).find((a) => a.id === ac.attribute_id)
            const baselineVal = attr?.attribute_type === 'file' ? (attr?.file_ref || attr?.value) : attr?.value
            const oldAc = (oldEntityRef?.attribute_changes || []).find((x) => x?.action === 'modify' && x.attribute_id === ac.attribute_id)
            const oldVal = oldAc
              ? (oldAc.file_ref_change !== undefined ? oldAc.file_ref_change : oldAc.new_value)
              : baselineVal
            const newVal = ac.file_ref_change !== undefined ? ac.file_ref_change : ac.new_value
            const page = buildRolloverPage({
              entity, target: { kind: 'attribute', entityId, attributeId: ac.attribute_id }, anchor,
              fieldLabel: attr?.name || 'Attribute',
              oldValue: oldVal ?? null,
              newValue: newVal ?? null,
              ctx, storyEnabled: story?.awareness_rollover_check_enabled !== false,
            })
            if (page) pages.push(page)
          }
          if (pages.length > 0) {
            useUiStore.getState().openAwarenessRolloverModal({ pages, currentPageIdx: 0 })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }
  },

  /**
   * Sweep the canvas graph and drop any `attribute_changes[]` entries whose
   * `attribute_id` (or `attribute.id` for 'add' actions) is in `deletedAttributeIds`.
   *
   * Call this immediately after an attribute is deleted from an entity's ORIGIN state
   * (i.e. removed from `entity.attributes`). Without this cascade, orphaned change
   * records downstream would keep referencing a non-existent attribute, which (a)
   * produces ghost sub-chips on scene nodes, and (b) blocks the asset cleanup sweep
   * from pruning media files whose only remaining reference is an orphaned change
   * record.
   *
   * Scope: walks every entity_node's modifier-mode attribute_changes AND every
   * EntityRef inside every scene. A single store mutation so undo captures
   * the whole cascade as one operation.
   */
  cascadeDropAttributeChanges: (deletedAttributeIds) => {
    if (!deletedAttributeIds || deletedAttributeIds.size === 0) return
    const deleted = deletedAttributeIds instanceof Set ? deletedAttributeIds : new Set(deletedAttributeIds)

    const matches = (ac) => {
      if (ac.action === 'add') return ac.attribute && deleted.has(ac.attribute.id)
      // modify / remove / list_add / list_remove all use attribute_id
      return ac.attribute_id && deleted.has(ac.attribute_id)
    }

    let mutated = false
    const updatedNodes = get().nodes.map((n) => {
      if (n.type === 'entityNode') {
        const acs = n.data.attribute_changes || []
        const next = acs.filter((ac) => !matches(ac))
        if (next.length === acs.length) return n
        mutated = true
        return { ...n, data: { ...n.data, attribute_changes: next } }
      }
      if (n.type === 'sceneNode') {
        let nodeChanged = false
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          let bucketChanged = false
          const nextRefs = refs.map((ref) => {
            const acs = ref.attribute_changes || []
            const nextAcs = acs.filter((ac) => !matches(ac))
            if (nextAcs.length === acs.length) return ref
            bucketChanged = true
            return { ...ref, attribute_changes: nextAcs }
          })
          if (bucketChanged) {
            newData[bucket] = nextRefs
            nodeChanged = true
          }
        }
        if (!nodeChanged) return n
        mutated = true
        return { ...n, data: newData }
      }
      return n
    })

    if (mutated) set({ nodes: updatedNodes, hasUnsavedChanges: true })
  },

  /**
   * Write a new file_ref for a media attribute at a specific chain position.
   * Handles all three possible `atNodeId` contexts:
   *
   *   1. Origin entity_node (`type: 'entityNode' && !is_modifier`):
   *      mutates the entity's own `attributes[]` directly via entitiesStore —
   *      the attribute's `file_ref` and mirror-`value` are updated in place.
   *
   *   2. Modifier entity_node (`type: 'entityNode' && is_modifier`):
   *      writes a `modify` action into the modifier node's `data.attribute_changes`
   *      with `file_ref_change` set to the new ref. If a `modify` entry already
   *      exists for this attribute, its `file_ref_change` is overwritten in place
   *      so the modifier ends up with a single entry per attribute.
   *
   *   3. Plot-point (scene) node (`type: 'sceneNode'`):
   *      finds the entity's `EntityRef` in the scene's bucket and writes a
   *      `modify` action into its `attribute_changes` with `file_ref_change` set.
   *      Same de-dup-by-attribute rule as modifier nodes.
   *
   * Pass an empty string `""` for `newFileRef` to clear the file at this chain
   * position without removing the attribute, matching the profile_image_change
   * sentinel pattern. Pass `null` to fully clear the modify entry.
   *
   * This is the canonical write path for the Media Preview Panel's "Replace
   * Media" button when the source is an attribute (reference_node sources use
   * the simpler `updateNodeData(nodeId, { file_ref })` path instead).
   */
  writeAttributeFileRef: (entityId, attributeId, atNodeId, newFileRef) => {
    if (!entityId || !attributeId || !atNodeId) return
    const { nodes } = get()
    const node = nodes.find((n) => n.id === atNodeId)
    if (!node) return

    // Case 1 — Origin entity_node: mutate the entity's attribute directly
    if (node.type === 'entityNode' && !node.data?.is_modifier) {
      const entStore = useEntitiesStore.getState()
      const entity = entStore.getEntityById(entityId)
      if (!entity) return
      const newAttributes = (entity.attributes || []).map((a) =>
        a.id === attributeId
          ? { ...a, file_ref: newFileRef || null, value: newFileRef || '' }
          : a
      )
      entStore.updateEntity(entityId, { ...entity, attributes: newAttributes })
      return
    }

    // Helper: merge a file_ref_change into an existing attribute_changes list,
    // de-duping by attribute_id so a single modify entry per attribute is kept.
    function mergeFileRefChange(existingChanges) {
      const modifyIdx = (existingChanges || []).findIndex(
        (ac) => ac.action === 'modify' && ac.attribute_id === attributeId
      )
      if (modifyIdx >= 0) {
        return existingChanges.map((ac, i) =>
          i === modifyIdx ? { ...ac, file_ref_change: newFileRef } : ac
        )
      }
      return [...(existingChanges || []), {
        action: 'modify',
        attribute_id: attributeId,
        file_ref_change: newFileRef,
      }]
    }

    // Case 2 — Modifier entity_node: write to node.data.attribute_changes
    if (node.type === 'entityNode' && node.data?.is_modifier) {
      const nextChanges = mergeFileRefChange(node.data.attribute_changes || [])
      get().updateNodeData(atNodeId, { attribute_changes: nextChanges })
      return
    }

    // Case 3 — Plot-point (scene) node: find the EntityRef and update its changes
    if (node.type === 'sceneNode') {
      let currentRef = null
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (node.data[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { currentRef = ref; break }
      }
      if (!currentRef) return  // No chip at this scene — shouldn't happen if Detail Panel was navigating correctly
      const nextChanges = mergeFileRefChange(currentRef.attribute_changes || [])
      get().updateEntityRef(atNodeId, entityId, { attribute_changes: nextChanges })
    }
  },

  /**
   * Commit a draft EntityRef update for an entity chip inside a plot point node.
   * Handles all relationship-removal side-effects (partner EntityRef sync + canvas
   * edge removal) atomically in a single undo snapshot.
   *
   * This is the canonical save path for EntityChipDetailView — use this instead of
   * calling updateEntityRef followed by separate edge-removal logic.
   *
   * effectiveRelationships — the entity's computed relationship list at this node,
   * used to resolve partner entity IDs for removed relationships.
   */
  saveEntityChipDraft: (nodeId, entityId, draft) => {
    get()._snapshot()
    const { nodes, edges } = get()

    // ── Capture old ref for review-flag diff ──
    let oldEntityRef = null
    outer: for (const n of nodes) {
      if (n.id !== nodeId || n.type !== 'sceneNode') continue
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (n.data[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { oldEntityRef = ref; break outer }
      }
    }
    const oldChangedFields = oldEntityRef ? getChangedFields(oldEntityRef) : []

    // ── Apply draft to this entity's EntityRef ──
    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId || n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entityId)
        if (idx !== -1) {
          // Preserve review_fields — upstream flags are cleared selectively after newChangedFields
          // is computed, not wiped wholesale. Wiping here clears flags for unrelated fields.
          newData[bucket] = refs.map((r, i) => {
            if (i !== idx) return r
            const merged = { ...r, ...draft }
            return { ...merged, scalar_change_ids: maintainScalarChangeIds(r, merged) }
          })
          break
        }
      }
      return { ...n, data: newData }
    })

    // ── Cascade-clean orphaned list/modify ops downstream when attributes removed ──
    const newlyRemovedAttrIds = new Set(
      (draft.attribute_changes || [])
        .filter((ac) => ac.action === 'remove')
        .map((ac) => ac.attribute_id)
    )
    if (newlyRemovedAttrIds.size > 0) {
      updatedNodes = sweepOrphanedAttrOpsDownstream(updatedNodes, edges, nodeId, entityId, newlyRemovedAttrIds)
    }

    // ── Review flags (downstream only) ──
    let newEntityRef = null
    outer2: for (const n of updatedNodes) {
      if (n.id !== nodeId || n.type !== 'sceneNode') continue
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (n.data[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { newEntityRef = ref; break outer2 }
      }
    }
    const newChangedFields = newEntityRef ? getChangedFields(newEntityRef) : []
    const removedFields = oldChangedFields.filter((f) => !newChangedFields.includes(f))
    const newVals2 = newEntityRef ? getSourceValues(newEntityRef) : {}
    const oldVals2 = oldEntityRef ? getSourceValues(oldEntityRef) : {}

    // Drop a flag on this node when either:
    // (a) the field is no longer overridden here (conflict gone), OR
    // (b) the user actively changed the override VALUE for that field
    //     (updating the value = reviewing and deciding on a new response, which resolves the conflict)
    // Cancelled list op flags are always preserved here — they are only cleared when the user
    // explicitly dismisses the alert (via clearEntityReviewField).
    if (newEntityRef) {
      const newChangedFieldsSet = new Set(newChangedFields)
      updatedNodes = updatedNodes.map((n) => {
        if (n.id !== nodeId || n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx !== -1) {
            const currentFlags = refs[idx].review_fields || []
            const filtered = currentFlags.filter((flag) => {
              // Cancelled list op flags persist until explicitly dismissed
              if (typeof flag === 'object' && flag.cancelled) return true
              const f = flagField(flag)
              if (!newChangedFieldsSet.has(f)) return false  // (a) override removed
              if (newVals2[f] !== oldVals2[f]) return false  // (b) override value changed
              return true
            })
            if (filtered.length === currentFlags.length) break
            newData[bucket] = refs.map((r, i) => i === idx ? { ...r, review_fields: filtered } : r)
            break
          }
        }
        return { ...n, data: newData }
      })
    }

    // Only flag downstream fields whose VALUE actually changed — not all fields with overrides
    const actuallyChanged2 = newChangedFields.filter((f) => newVals2[f] !== oldVals2[f])
    const nodesWithFlags = applyDownstreamReviewFlags(
      updatedNodes, edges, nodeId, entityId, actuallyChanged2, removedFields,
      newEntityRef ? getSourceValues(newEntityRef) : undefined,
      oldEntityRef ? getSourceValues(oldEntityRef) : undefined
    )

    set({ nodes: nodesWithFlags, hasUnsavedChanges: true })

    // Awareness-rollover modal — same hook as updateEntityRef, applied
    // to chip-detail draft commits. Chain anchor only; story-settings
    // gate suppresses; build a page per touched tracked field that has
    // observers in the resolved entries.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false && oldEntityRef && newEntityRef) {
        const es = useEntitiesStore.getState()
        const entity = (es.getEntityById && es.getEntityById(entityId))
          || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs].find((e) => e.id === entityId)
        if (entity) {
          const ctx = {
            allEntities: [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs],
            allRelationships: get().relationships,
            nodes: get().nodes,
            edges: get().edges,
            anchorNodeId: nodeId,
            storyOrder: computeStoryOrder({ nodes: get().nodes, edges: get().edges }),
          }
          const anchor = { kind: 'chain', nodeId }
          const pages = []
          if (newEntityRef.name_change != null && newEntityRef.name_change !== oldEntityRef.name_change) {
            const page = buildRolloverPage({
              entity, target: { kind: 'entity_name', entityId }, anchor,
              fieldLabel: 'Name',
              oldValue: oldEntityRef.name_change ?? entity.name ?? null,
              newValue: newEntityRef.name_change,
              ctx, storyEnabled: true,
            })
            if (page) pages.push(page)
          }
          const oldAttrModifyById = new Map()
          for (const ac of (oldEntityRef.attribute_changes || [])) {
            if (ac?.action === 'modify' && ac.attribute_id) oldAttrModifyById.set(ac.attribute_id, ac)
          }
          for (const ac of (newEntityRef.attribute_changes || [])) {
            if (ac?.action !== 'modify' || !ac.attribute_id) continue
            const oldAc = oldAttrModifyById.get(ac.attribute_id)
            if (oldAc && oldAc.new_value === ac.new_value && oldAc.file_ref_change === ac.file_ref_change) continue
            const attr = (entity.attributes || []).find((a) => a.id === ac.attribute_id)
            const baselineVal = attr?.attribute_type === 'file' ? (attr?.file_ref || attr?.value) : attr?.value
            const oldVal = oldAc
              ? (oldAc.file_ref_change !== undefined ? oldAc.file_ref_change : oldAc.new_value)
              : baselineVal
            const newVal = ac.file_ref_change !== undefined ? ac.file_ref_change : ac.new_value
            const page = buildRolloverPage({
              entity, target: { kind: 'attribute', entityId, attributeId: ac.attribute_id }, anchor,
              fieldLabel: attr?.name || 'Attribute',
              oldValue: oldVal ?? null,
              newValue: newVal ?? null,
              ctx, storyEnabled: true,
            })
            if (page) pages.push(page)
          }
          // Alias rename detection — per-event `AliasChange.modify`
          // events explicitly identify the alias_id and new_value;
          // resolve old_value by looking up the alias in the prior
          // effective state at this anchor.
          const newAliasModifyEvents = (newEntityRef.alias_changes || []).filter(
            (ev) => ev && ev.action === 'modify' && ev.alias_id && typeof ev.new_value === 'string',
          )
          const oldAliasModifyEventIds = new Set(
            (oldEntityRef.alias_changes || []).filter((ev) => ev?.action === 'modify' && ev.alias_id).map((ev) => `${ev.alias_id}:${ev.new_value}`),
          )
          for (const ev of newAliasModifyEvents) {
            const key = `${ev.alias_id}:${ev.new_value}`
            if (oldAliasModifyEventIds.has(key)) continue   // already existed; not a new rename
            // Look up prior alias value from the effective state at the anchor.
            const effPrior = computeEffectiveState(entity, nodes, edges, nodeId)
            const priorAlias = (effPrior?.aliases || []).find((a) => a && typeof a === 'object' && a.id === ev.alias_id)
            const oldValue = priorAlias?.value || ''
            if (!oldValue || oldValue === ev.new_value) continue
            const page = buildRolloverPage({
              entity, target: { kind: 'alias', entityId, aliasValue: ev.new_value }, anchor,
              fieldLabel: `Alias "${ev.new_value}"`,
              oldValue,
              newValue: ev.new_value,
              ctx, storyEnabled: true,
            })
            if (page) pages.push(page)
          }
          if (pages.length > 0) {
            useUiStore.getState().openAwarenessRolloverModal({ pages, currentPageIdx: 0 })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }

    // Phase 1.21c Tier 2 — collect change_ids of events removed by this
    // draft save (attribute_changes entries that disappeared, plus
    // scalar fields that went from non-null to null) and fire the
    // cleanup cascade. No-op in the common case where nothing was
    // removed and no Knowledges are attached.
    const removedChangeIds = []
    if (oldEntityRef && newEntityRef) {
      const newAttrIds = new Set((newEntityRef.attribute_changes || []).map((c) => c?.id).filter(Boolean))
      for (const c of (oldEntityRef.attribute_changes || [])) {
        if (c?.id && !newAttrIds.has(c.id)) removedChangeIds.push(c.id)
      }
      for (const field of SCALAR_CHANGE_FIELDS) {
        const oldHas = oldEntityRef[field] !== null && oldEntityRef[field] !== undefined
        const newHas = newEntityRef[field] !== null && newEntityRef[field] !== undefined
        if (oldHas && !newHas) {
          const oid = oldEntityRef.scalar_change_ids?.[field]
          if (oid) removedChangeIds.push(oid)
        }
      }
    }
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)

    // Phase 2.5g follow-up — strip any downstream profile_image
    // entries this save just made redundant (and the save itself if
    // it landed an `""` clear when the upstream value was already
    // null-like).
    get()._sweepRedundantNullProfileImageEntries({ entityId })

    // Effects hook — runs after save. No-op in the common case.
    try {
      const sourceEntity = useEntitiesStore.getState().getEntityById?.(entityId)
      if (sourceEntity) {
        detectAndFireOvumRed({ draft, entity: sourceEntity, sourceEntityId: entityId })
        detectAndFireOvumWhiteAtChainAnchor({ draft, entity: sourceEntity, sourceEntityId: entityId, nodeId })
      }
    } catch { /* effects must never break saves */ }
  },

  /**
   * Phase 1.22d follow-up — Revoke an attribute Add that was previously
   * saved at a chain anchor. The "Revoke Add" button in the entity
   * Detail Panel's Attributes tab fires this when the user has
   * confirmed the destructive intent (the row's confirm dialog reads
   * "This will delete this attribute from this point in the chain —
   * all downstream uses will also be removed").
   *
   * Why this is a direct projectStore action and not a draft mutation:
   *   The previous implementation filtered the `action='add'` entry out
   *   of the React-local draft only (`revokeAttrAdd` in
   *   `entityHelpers.js`). The committed state (entity_ref on the node)
   *   wasn't touched until the user clicked Save. That divergence broke
   *   undo/redo: pressing undo without first saving rolled back the
   *   previous projectStore change (the original Add's save), leaving
   *   the local draft stale and the canvas chip's subchip stripped
   *   without a corresponding sidebar update.
   *
   * Caller responsibilities: also strip the local draft entry so the
   * sidebar matches what just landed in committed state. (See
   * `EntityDetailView.jsx` revoke handler.)
   *
   * Cascade: the attribute no longer exists from this anchor forward,
   * so any downstream modify / list_add / list_remove ops that
   * reference this attr_id are now orphaned. `sweepOrphanedAttrOpsDownstream`
   * is the same helper saveEntityChipDraft uses for chip-side removes.
   */
  revokeAttributeAddAtChainAnchor: (nodeId, entityId, attrId) => {
    get()._snapshot()
    const { nodes, edges } = get()
    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId || n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entityId)
        if (idx === -1) continue
        const ref = refs[idx]
        const filtered = (ref.attribute_changes || []).filter(
          (ac) => !(ac.action === 'add' && ac.attribute?.id === attrId)
        )
        if (filtered.length === (ref.attribute_changes || []).length) break
        newData[bucket] = refs.map((r, i) => i === idx ? { ...r, attribute_changes: filtered } : r)
        break
      }
      return { ...n, data: newData }
    })
    updatedNodes = sweepOrphanedAttrOpsDownstream(updatedNodes, edges, nodeId, entityId, new Set([attrId]))
    set({ nodes: updatedNodes, hasUnsavedChanges: true })
  },

  /**
   * Modifier-node variant of `revokeAttributeAddAtChainAnchor`. Modifier
   * nodes carry their attribute_changes directly on `node.data`, not
   * on a bucket entity_ref.
   */
  revokeAttributeAddAtModifier: (nodeId, entityId, attrId) => {
    get()._snapshot()
    const { nodes, edges } = get()
    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId || n.type !== 'entityNode' || !n.data?.is_modifier) return n
      const filtered = (n.data.attribute_changes || []).filter(
        (ac) => !(ac.action === 'add' && ac.attribute?.id === attrId)
      )
      if (filtered.length === (n.data.attribute_changes || []).length) return n
      return { ...n, data: { ...n.data, attribute_changes: filtered } }
    })
    updatedNodes = sweepOrphanedAttrOpsDownstream(updatedNodes, edges, nodeId, entityId, new Set([attrId]))
    set({ nodes: updatedNodes, hasUnsavedChanges: true })
  },

  /**
   * Clear review flags for an entity chip — user has reviewed and confirmed
   * the downstream override is intentional.
   */
  clearEntityReviewFlags: (nodeId, entityId) => {
    const { nodes } = get()
    set({
      nodes: nodes.map((n) => {
        if (n.id !== nodeId) return n
        // Modifier node: review_fields directly on node.data
        if (n.type === 'entityNode' && n.data.is_modifier) {
          return { ...n, data: { ...n.data, review_fields: [] } }
        }
        // Plot point node: review_fields on the EntityRef in a bucket
        if (n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx !== -1) {
            const ref = refs[idx]
            // Also remove all cancelled list op entries from attribute_changes
            const cleanedAcs = (ref.attribute_changes || []).filter((ac) => !ac.cancelled)
            newData[bucket] = refs.map((r, i) =>
              i === idx ? { ...r, review_fields: [], attribute_changes: cleanedAcs } : r
            )
            break
          }
        }
        return { ...n, data: newData }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Clear a single review flag field for an entity chip.
   * Used when alerts are split one-per-field and the user dismisses one.
   */
  clearEntityReviewField: (nodeId, entityId, field) => {
    const { nodes } = get()
    // For cancelled list op fields, also remove the cancelled marker from attribute_changes
    // (user dismissed the alert = acknowledges the op was superseded upstream)
    const isCancelledListField = field.startsWith('list_add:') || field.startsWith('list_remove:')
    set({
      nodes: nodes.map((n) => {
        if (n.id !== nodeId) return n
        if (n.type === 'entityNode' && n.data.is_modifier) {
          return { ...n, data: { ...n.data, review_fields: (n.data.review_fields || []).filter((f) => flagField(f) !== field) } }
        }
        if (n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx !== -1) {
            const ref = refs[idx]
            const newRef = { ...ref, review_fields: (ref.review_fields || []).filter((f) => flagField(f) !== field) }
            // For cancelled list op fields: remove the cancelled entry from attribute_changes
            // (user confirmed the op is superseded — remove the pending-review sub-chip)
            if (isCancelledListField) {
              const colonIdx1 = field.indexOf(':')
              const colonIdx2 = field.indexOf(':', colonIdx1 + 1)
              const opAction = field.slice(0, colonIdx1)  // 'list_add' or 'list_remove'
              const opAttrId = field.slice(colonIdx1 + 1, colonIdx2)
              const opItem   = field.slice(colonIdx2 + 1)
              newRef.attribute_changes = (ref.attribute_changes || []).filter((ac) =>
                !(ac.cancelled && ac.action === opAction && ac.attribute_id === opAttrId && ac.list_item === opItem)
              )
            }
            newData[bucket] = refs.map((r, i) => i === idx ? newRef : r)
            break
          }
        }
        return { ...n, data: newData }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Accept a Time Since Last Scene gap-shift alert (planning §10.1.1
   * + §10.1.2). Clears the `time_since_last_scene` review entry on
   * the scene AND advances `last_known_gap` to the current walker
   * gap, so the next save's detection pass treats the current gap
   * as the new baseline. With the alert resolved, the cascade rule
   * (§3.4.2) lets the next still-warranted downstream alert surface
   * on the next save.
   *
   * @param {string} sceneId
   * @param {Object} [opts]
   * @param {boolean} [opts.clearExtension] — also null the scene's
   *   `gap_extension` (the "Clear extension" resolution path for
   *   §10.1.2 alerts).
   */
  acceptScenetimeAlert: (sceneId, opts = {}) => {
    get()._snapshot()
    const { nodes, edges, story } = get()
    const sceneNodes = nodes.filter((n) => n.type === 'sceneNode')
    const sceneDataById = new Map(sceneNodes.map((n) => [n.id, n.data || {}]))
    const povChain = computePovChain(nodes, edges)
    const orderedSceneIds = povChain.sequence.map((s) => s.nodeId)
    const allowNegative = story?.allow_negative_time === true
    const walker = walkPovChainTime({
      orderedSceneIds,
      scenesById: sceneDataById,
      allowNegative,
    })
    const w = walker.get(sceneId)
    const newGap = (w && !w.isFirstScene && Number.isFinite(w.gapMinutes))
      ? minutesToTimeDelta(w.gapMinutes)
      : null
    const newFloorMinutes = (w && !w.isFirstScene && Number.isFinite(w.floorMinutes))
      ? w.floorMinutes
      : null
    const newEffectiveMinutes = (w && !w.isFirstScene && Number.isFinite(w.effectiveStartMinutes))
      ? w.effectiveStartMinutes
      : null

    set({
      nodes: nodes.map((n) => {
        if (n.id !== sceneId) return n
        if (n.type !== 'sceneNode') return n
        const review = (n.data?.review_fields || []).filter((f) => {
          const field = typeof f === 'string' ? f : f?.field
          return field !== 'time_since_last_scene'
        })
        const nextData = {
          ...n.data,
          review_fields: review,
          last_known_gap: newGap ?? (n.data?.last_known_gap ?? null),
          last_known_floor_minutes: newFloorMinutes ?? (n.data?.last_known_floor_minutes ?? null),
          last_known_effective_minutes: newEffectiveMinutes ?? (n.data?.last_known_effective_minutes ?? null),
        }
        if (opts.clearExtension) nextData.gap_extension = null
        return { ...n, data: nextData }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Undo an auto-cancelled list op.
   *
   * When an upstream node adds/removes a list item that a downstream node also had queued,
   * the downstream op is auto-cancelled and a cancelled review flag is added. This action
   * reverses that: removes the upstream list op that triggered the cancellation, restoring
   * the downstream op to active status and clearing the cancelled review flag.
   *
   * NOT tied to the undo/redo system — it is a targeted edit, not a snapshot revert.
   */
  undoCancelledListOp: (nodeId, entityId, field) => {
    get()._snapshot()
    const { nodes, edges } = get()

    // Parse the field key: 'list_add:${attrId}:${item}' or 'list_remove:${attrId}:${item}'
    const colonIdx1 = field.indexOf(':')
    const colonIdx2 = field.indexOf(':', colonIdx1 + 1)
    const opAction  = field.slice(0, colonIdx1)  // 'list_add' or 'list_remove'
    const opAttrId  = field.slice(colonIdx1 + 1, colonIdx2)
    const opItem    = field.slice(colonIdx2 + 1)

    // Find the sourceNodeId from the cancelled review flag on the downstream node
    let sourceNodeId = null
    outer: for (const n of nodes) {
      if (n.id !== nodeId) continue
      if (n.type === 'sceneNode') {
        for (const bk of ENTITY_BUCKETS) {
          const ref = (n.data[bk] || []).find((r) => r.entity_id === entityId)
          if (ref) {
            const cancelledFlag = (ref.review_fields || []).find(
              (f) => typeof f === 'object' && f.cancelled && flagField(f) === field
            )
            if (cancelledFlag) { sourceNodeId = cancelledFlag.sourceNodeId; break outer }
          }
        }
      }
      if (n.type === 'entityNode' && n.data.is_modifier && n.data.entity_id === entityId) {
        const cancelledFlag = (n.data.review_fields || []).find(
          (f) => typeof f === 'object' && f.cancelled && flagField(f) === field
        )
        if (cancelledFlag) { sourceNodeId = cancelledFlag.sourceNodeId; break outer }
      }
    }

    if (!sourceNodeId) return  // Safety: no upstream source found

    // Remove the upstream list op from the source node's attribute_changes
    let updatedNodes = nodes.map((n) => {
      if (n.id !== sourceNodeId) return n
      if (n.type === 'sceneNode') {
        const newData = { ...n.data }
        for (const bk of ENTITY_BUCKETS) {
          const refs = newData[bk] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx !== -1) {
            const ref = refs[idx]
            const newAcs = (ref.attribute_changes || []).filter(
              (ac) => !(ac.action === opAction && ac.attribute_id === opAttrId && ac.list_item === opItem)
            )
            newData[bk] = refs.map((r, i) => i === idx ? { ...r, attribute_changes: newAcs } : r)
            break
          }
        }
        return { ...n, data: newData }
      }
      if (n.type === 'entityNode' && n.data.is_modifier) {
        const newAcs = (n.data.attribute_changes || []).filter(
          (ac) => !(ac.action === opAction && ac.attribute_id === opAttrId && ac.list_item === opItem)
        )
        return { ...n, data: { ...n.data, attribute_changes: newAcs } }
      }
      return n
    })

    // Re-run applyDownstreamReviewFlags for the source node with the op listed as removed.
    // This triggers the "Un-cancel resolved list ops" logic: removes cancelled: true from the
    // downstream attribute_changes (restoring the op to active) and drops the cancelled flag
    // from review_fields.
    const nodesWithFlags = applyDownstreamReviewFlags(
      updatedNodes, edges, sourceNodeId, entityId,
      [],      // no newly added fields
      [field]  // the upstream op field being removed
    )

    set({ nodes: nodesWithFlags, hasUnsavedChanges: true })
  },

  /**
   * Undo a dangling list-remove op: removes the list_remove entry from the
   * downstream node's attribute_changes and clears the dangling review flag.
   * The list_remove was for an item that is no longer added upstream, so it
   * had become a no-op. Undo means: "don't bother removing it here either."
   * NOT tied to the undo/redo system — it is a targeted edit.
   */
  undoDanglingListRemove: (nodeId, entityId, field) => {
    get()._snapshot()
    const { nodes } = get()
    // field = 'list_remove:attrId:item'
    const colonIdx1 = field.indexOf(':')
    const colonIdx2 = field.indexOf(':', colonIdx1 + 1)
    const attrId = field.slice(colonIdx1 + 1, colonIdx2)
    const listItem = field.slice(colonIdx2 + 1)

    const updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId) return n
      if (n.type === 'entityNode' && n.data.is_modifier && n.data.entity_id === entityId) {
        const newAcs = (n.data.attribute_changes || []).filter(
          (ac) => !(ac.action === 'list_remove' && ac.attribute_id === attrId && ac.list_item === listItem)
        )
        const newFlags = (n.data.review_fields || []).filter(
          (f) => !(typeof f === 'object' && f.dangling && f.field === field)
        )
        return { ...n, data: { ...n.data, attribute_changes: newAcs, review_fields: newFlags } }
      }
      if (n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entityId)
        if (idx === -1) continue
        const ref = refs[idx]
        const newAcs = (ref.attribute_changes || []).filter(
          (ac) => !(ac.action === 'list_remove' && ac.attribute_id === attrId && ac.list_item === listItem)
        )
        const newFlags = (ref.review_fields || []).filter(
          (f) => !(typeof f === 'object' && f.dangling && f.field === field)
        )
        newData[bucket] = refs.map((r, i) => i === idx ? { ...r, attribute_changes: newAcs, review_fields: newFlags } : r)
        break
      }
      return { ...n, data: newData }
    })

    set({ nodes: updatedNodes, hasUnsavedChanges: true })
  },

  /**
   * Dead post-v0.2.1.91: autoResolved aliases flags are no longer
   * generated (the per-event `alias_changes` model has no equivalent
   * to the legacy full-list "structurally redundant" detection that
   * fed this undo handler). Kept as a no-op stub so the AlertsPanel's
   * handler binding doesn't error if a stale flag from a pre-cleanup
   * session is ever encountered. Safe to remove entirely once the
   * AlertsPanel binding is also removed.
   */
  // eslint-disable-next-line no-unused-vars
  undoAutoResolvedAliases: (nodeId, entityId) => {
    // No-op stub — see docstring above.
  },

  /**
   * Save a modifier node draft with downstream review-flag propagation.
   * Modifier nodes store entity changes directly on nodeData (same field
   * names as EntityRef: name_change, colour_change, etc.).
   * After updating, walk downstream and flag any SceneNode EntityRef
   * that also overrides the same fields.
   */
  saveModifierNodeDraft: (nodeId, entityId, draft) => {
    get()._snapshot()
    const { nodes, edges } = get()

    // Capture old changed fields and values from current node data
    const modNode = nodes.find((n) => n.id === nodeId)
    const oldData = modNode?.data || {}
    const oldChangedFields = getChangedFields(oldData)

    // Pre-compute new changed fields and values for flag filtering + downstream propagation
    const newChangedFields = getChangedFields(draft)
    const removedFields = oldChangedFields.filter((f) => !newChangedFields.includes(f))
    const newVals3 = getSourceValues(draft)
    const oldVals3 = getSourceValues(oldData)
    const actuallyChanged3 = newChangedFields.filter((f) => newVals3[f] !== oldVals3[f])

    // Selectively filter review_fields: same logic as saveEntityDraft — preserve flags
    // for overrides the modifier still holds with the same value (upstream conflict unresolved),
    // always preserve cancelled list-op flags, clear flags for removed or value-changed overrides.
    const currentFlags = oldData.review_fields || []
    const newChangedFieldsSet = new Set(newChangedFields)
    const filteredFlags = currentFlags.filter((flag) => {
      if (typeof flag === 'object' && flag.cancelled) return true
      const f = flagField(flag)
      if (!newChangedFieldsSet.has(f)) return false  // override removed
      if (newVals3[f] !== oldVals3[f]) return false   // user changed override value (responding to flag)
      return true
    })

    // Update the node data with selectively filtered flags
    let updatedNodes = nodes.map((n) => {
      if (n.id !== nodeId) return n
      const merged = { ...n.data, ...draft, review_fields: filteredFlags }
      return { ...n, data: { ...merged, scalar_change_ids: maintainScalarChangeIds(n.data, merged) } }
    })

    // ── Cascade-clean orphaned list/modify ops downstream when attributes removed ──
    const newlyRemovedAttrIds2 = new Set(
      (draft.attribute_changes || [])
        .filter((ac) => ac.action === 'remove')
        .map((ac) => ac.attribute_id)
    )
    if (newlyRemovedAttrIds2.size > 0) {
      updatedNodes = sweepOrphanedAttrOpsDownstream(updatedNodes, edges, nodeId, entityId, newlyRemovedAttrIds2)
    }

    // Flag downstream nodes
    const nodesWithFlags = applyDownstreamReviewFlags(
      updatedNodes, edges, nodeId, entityId, actuallyChanged3, removedFields,
      getSourceValues(draft), getSourceValues(oldData)
    )

    set({ nodes: nodesWithFlags, hasUnsavedChanges: true })

    // Phase 1.21c Tier 2 — collect change_ids of events removed by this
    // modifier-node draft save and fire the cleanup cascade. Same diff
    // logic as saveEntityChipDraft, applied to nodeData scalar fields
    // and attribute_changes.
    const removedChangeIds3 = []
    const newAttrIdSet = new Set((draft.attribute_changes || []).map((c) => c?.id).filter(Boolean))
    for (const c of (oldData.attribute_changes || [])) {
      if (c?.id && !newAttrIdSet.has(c.id)) removedChangeIds3.push(c.id)
    }
    for (const field of SCALAR_CHANGE_FIELDS) {
      const oldHas = oldData[field] !== null && oldData[field] !== undefined
      const newHas = draft[field] !== null && draft[field] !== undefined
      if (oldHas && !newHas) {
        const oid = oldData?.scalar_change_ids?.[field]
        if (oid) removedChangeIds3.push(oid)
      }
    }
    if (removedChangeIds3.length) get()._runEventRemovalCascade(removedChangeIds3)

    // Awareness-rollover modal — same hook as updateEntityRef, applied
    // to modifier-node value commits.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false) {
        const es = useEntitiesStore.getState()
        const entity = (es.getEntityById && es.getEntityById(entityId))
          || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs].find((e) => e.id === entityId)
        if (entity) {
          const ctx = {
            allEntities: [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs],
            allRelationships: get().relationships,
            nodes: get().nodes,
            edges: get().edges,
            anchorNodeId: nodeId,
            storyOrder: computeStoryOrder({ nodes: get().nodes, edges: get().edges }),
          }
          const anchor = { kind: 'chain', nodeId }
          const pages = []
          if (draft.name_change != null && draft.name_change !== '' && draft.name_change !== oldData.name_change) {
            const page = buildRolloverPage({
              entity, target: { kind: 'entity_name', entityId }, anchor,
              fieldLabel: 'Name',
              oldValue: oldData.name_change ?? entity.name ?? null,
              newValue: draft.name_change,
              ctx, storyEnabled: true,
            })
            if (page) pages.push(page)
          }
          const oldAttrModifyById = new Map()
          for (const ac of (oldData.attribute_changes || [])) {
            if (ac?.action === 'modify' && ac.attribute_id) oldAttrModifyById.set(ac.attribute_id, ac)
          }
          for (const ac of (draft.attribute_changes || [])) {
            if (ac?.action !== 'modify' || !ac.attribute_id) continue
            const oldAc = oldAttrModifyById.get(ac.attribute_id)
            if (oldAc && oldAc.new_value === ac.new_value && oldAc.file_ref_change === ac.file_ref_change) continue
            const attr = (entity.attributes || []).find((a) => a.id === ac.attribute_id)
            const baselineVal = attr?.attribute_type === 'file' ? (attr?.file_ref || attr?.value) : attr?.value
            const oldVal = oldAc
              ? (oldAc.file_ref_change !== undefined ? oldAc.file_ref_change : oldAc.new_value)
              : baselineVal
            const newVal = ac.file_ref_change !== undefined ? ac.file_ref_change : ac.new_value
            const page = buildRolloverPage({
              entity, target: { kind: 'attribute', entityId, attributeId: ac.attribute_id }, anchor,
              fieldLabel: attr?.name || 'Attribute',
              oldValue: oldVal ?? null,
              newValue: newVal ?? null,
              ctx, storyEnabled: true,
            })
            if (page) pages.push(page)
          }
          if (pages.length > 0) {
            useUiStore.getState().openAwarenessRolloverModal({ pages, currentPageIdx: 0 })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }
    // Phase 2.5g follow-up — strip any downstream profile_image
    // entries this modifier-node save just made redundant.
    get()._sweepRedundantNullProfileImageEntries({ entityId })
  },

  /**
   * Flag downstream EntityRef overrides after an origin-level entity edit.
   * Called from EntityChipDetailView.handleSave when isOrigin=true.
   *
   * oldEntity — entity data before the edit (snapshot taken before updateEntity)
   * newEntity — entity data after the edit
   *
   * Compares which base fields changed (name, colour, description, profile_image,
   * attributes) and flags any downstream node whose EntityRef also overrides
   * those same fields.
   */
  /**
   * Phase 2.5g — chain-aware avatar write for an Entity.
   *
   * Routes the write based on which kind of node the anchor is:
   *   - The entity's origin EntityNode (is_modifier=false, entity_id
   *     matches): write `entity.profile_image_ref` on baseline and
   *     flag any downstream EntityRef that also overrides
   *     profile_image. Snapshots `_entityDataRestore` /
   *     `_entityDataAfter` so undo / redo restore the baseline.
   *   - A modifier EntityNode (is_modifier=true, entity_id matches):
   *     write `data.profile_image_change` on the node and run the
   *     existing modifier-draft pipeline (review flags + scalar
   *     change-id maintenance) by handing a minimal draft to
   *     `saveModifierNodeDraft`.
   *   - A SceneNode that already contains an EntityRef for this
   *     entity: write `profile_image_change` on the EntityRef and
   *     run the chip-draft pipeline.
   *
   * Passing `fileRef = ''` (empty string) clears the change at the
   * anchor — matching the "clear file without replacement" semantic
   * the existing detail-panel UI uses. Passing `null` likewise
   * clears the field. Passing a `"assets/..."` ref writes that
   * asset as the new value.
   *
   * Used by Phase 2.5g drag-and-drop / apply-from-chat affordances
   * to commit the avatar change immediately, bypassing the draft +
   * save UI flow the EntityDetailView uses for in-panel editing.
   */
  setEntityProfileImageAtAnchor: (entityId, anchorNodeId, fileRef) => {
    if (!entityId || !anchorNodeId) return
    const { nodes } = get()
    const anchor = nodes.find((n) => n.id === anchorNodeId)
    if (!anchor) return

    // Origin EntityNode — baseline write.
    if (anchor.type === 'entityNode'
      && !anchor.data?.is_modifier
      && anchor.data?.entity_id === entityId
    ) {
      const es = useEntitiesStore.getState()
      const entity = (es.getEntityById && es.getEntityById(entityId))
        || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
          .find((e) => e.id === entityId)
      if (!entity) return
      const oldEntity = { ...entity }
      const newEntity = { ...entity, profile_image_ref: fileRef || null }
      if ((oldEntity.profile_image_ref || null) === (newEntity.profile_image_ref || null)) return
      const bucket = entity.type ? `${entity.type}s` : null
      if (bucket) {
        get()._snapshot({ _entityDataRestore: [{ ...oldEntity, _bucket: bucket }] })
      } else {
        get()._snapshot()
      }
      // updateEntity is async (POSTs to /api/entities/:id); fire it
      // and let the resolved data land via the store's set(). The
      // downstream review-flag walk reads from the projectStore
      // `nodes` (not the entity bucket), so it can run synchronously.
      es.updateEntity(entityId, newEntity)
      get().flagDownstreamAfterOriginEdit(entityId, oldEntity, newEntity)
      if (bucket) {
        get()._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...newEntity, _bucket: bucket }] })
      }
      set({ hasUnsavedChanges: true })
      // Phase 2.5g follow-up — baseline change may have rendered
      // downstream explicit-clear entries redundant. Sweep them.
      get()._sweepRedundantNullProfileImageEntries({ entityId })
      return
    }

    // Modifier EntityNode — chain-entry on the node itself.
    if (anchor.type === 'entityNode'
      && anchor.data?.is_modifier
      && anchor.data?.entity_id === entityId
    ) {
      const oldData = anchor.data || {}
      // `''` is a valid sentinel for "clear at this anchor"; pass
      // through verbatim. null also clears.
      const next = fileRef === null || fileRef === undefined ? null : fileRef
      if ((oldData.profile_image_change ?? null) === (next ?? null)) return
      const draft = { ...oldData, profile_image_change: next }
      get().saveModifierNodeDraft(anchorNodeId, entityId, draft)
      return
    }

    // SceneNode — chain-entry on the EntityRef for this entity.
    if (anchor.type === 'sceneNode') {
      let oldRef = null
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (anchor.data?.[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { oldRef = ref; break }
      }
      if (!oldRef) return  // entity isn't on this scene — caller bug
      const next = fileRef === null || fileRef === undefined ? null : fileRef
      if ((oldRef.profile_image_change ?? null) === (next ?? null)) return
      const draft = { ...oldRef, profile_image_change: next }
      get().saveEntityChipDraft(anchorNodeId, entityId, draft)
      return
    }
  },

  /**
   * Phase 2.5g — chain-aware avatar write for a Knowledge.
   *
   * Knowledge's origin is the scene node recorded in its
   * `source_event.node_id` (the scene where the knowledge was first
   * manifested). Writes at that origin go to
   * `knowledge.profile_image_ref` on baseline; writes at any other
   * anchor land as a `profile_image_changes` history entry via the
   * existing `setKnowledgeContentChangeAtNode` action.
   *
   * Passing `fileRef = null` / `''` clears the value (baseline path
   * stores `null`; chain-entry path stores `null` in
   * `new_profile_image_ref` so the entry replaces forward).
   */
  setKnowledgeProfileImageAtAnchor: (knowledgeId, anchorNodeId, fileRef) => {
    if (!knowledgeId || !anchorNodeId) return
    const k = get().knowledges.find((kk) => kk.id === knowledgeId)
    if (!k) return
    const next = fileRef === undefined ? null : fileRef
    const originNodeId = k.source_event?.node_id || null
    if (originNodeId && originNodeId === anchorNodeId) {
      if ((k.profile_image_ref || null) === (next || null)) return
      get()._snapshot()
      // Wholesale replace at baseline. updateKnowledge is async — fire
      // and forget; the resolved data lands via its own set(). For
      // optimistic UI we patch locally too so the avatar updates
      // before the round-trip.
      const optimistic = { ...k, profile_image_ref: next || null }
      set({
        knowledges: get().knowledges.map((kk) => kk.id === knowledgeId ? optimistic : kk),
        hasUnsavedChanges: true,
      })
      get().updateKnowledge(knowledgeId, optimistic).catch(() => { /* keep optimistic */ })
      return
    }
    // Chain-entry path. setKnowledgeContentChangeAtNode handles its
    // own snapshot + history-list maintenance.
    get().setKnowledgeContentChangeAtNode(knowledgeId, 'profile_image', anchorNodeId, next)
  },

  /**
   * Phase 2.5g follow-up — strip redundant null / empty profile-image
   * chain entries that no longer differ from their inherited value.
   *
   * Why this exists: profile_image is the one chain-tracked scalar
   * field where an "explicit clear" value (`""` on EntityRef
   * `profile_image_change`, `null` on Knowledge
   * `profile_image_changes[].new_profile_image_ref`) is distinct from
   * "no override". The clear writes forward and BLOCKS inheritance —
   * so when the writer sets up a "clear at every downstream scene"
   * stack and then changes the upstream value so those clears become
   * identity ops, the stale clears keep blocking. The writer would
   * otherwise have to remove every redundant entry by hand. This
   * sweep removes them silently in one pass.
   *
   * Rule: a chain entry on profile_image is redundant when its
   * value is null-like (`null` OR `""`) AND the value resolved at
   * the chain step IMMEDIATELY BEFORE the entry is also null-like.
   * Stripping a redundant entry doesn't change the resolved state
   * at downstream entries (a no-op is a no-op), so all redundant
   * entries can be flagged in a single pass and stripped at once.
   *
   * Pass `{ entityId }` to sweep an entity's chain entries (across
   * sceneNode EntityRefs + modifier EntityNodes) OR `{ knowledgeId }`
   * to sweep a Knowledge's `history.profile_image_changes[]`. Both
   * branches are safe no-ops when nothing is redundant.
   *
   * Does NOT take a snapshot — the triggering save already did. This
   * is an extension of that save, not its own undo step. Hooks the
   * existing `_runEventRemovalCascade` for any attached Knowledges
   * on entity-side strips.
   */
  _sweepRedundantNullProfileImageEntries: ({ entityId = null, knowledgeId = null } = {}) => {
    const isNullLike = (v) => v === null || v === undefined || v === ''

    // ── Entity branch ──
    if (entityId) {
      const es = useEntitiesStore.getState()
      const entity = (es.getEntityById && es.getEntityById(entityId))
        || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
          .find((e) => e.id === entityId)
      if (!entity) return
      const { nodes, edges } = get()
      // Collect every chain entry on profile_image_change for this
      // entity. Field is null when no entry exists; `""` is the
      // explicit-clear sentinel (the bug pattern), `"assets/..."` is
      // a real set.
      const candidates = []
      for (const n of nodes) {
        if (n.type === 'sceneNode') {
          for (const bucket of ENTITY_BUCKETS) {
            const refs = n.data?.[bucket] || []
            for (const ref of refs) {
              if (ref.entity_id !== entityId) continue
              const v = ref.profile_image_change
              if (v === null || v === undefined) continue
              if (isNullLike(v)) candidates.push({ nodeId: n.id, bucket })
            }
          }
        } else if (n.type === 'entityNode'
          && n.data?.is_modifier
          && n.data?.entity_id === entityId
        ) {
          const v = n.data?.profile_image_change
          if (v === null || v === undefined) continue
          if (isNullLike(v)) candidates.push({ nodeId: n.id, modifier: true })
        }
      }
      if (candidates.length === 0) return
      // For each candidate, walk the chain to the step IMMEDIATELY
      // before this anchor and check whether the inherited
      // profile_image_ref there is also null-like. Compute against
      // the CURRENT chain (which still includes the other candidate
      // entries) — stripping any of them in the same pass won't
      // change the resolved state at the remaining candidates,
      // since stripping a redundant entry by definition doesn't
      // change downstream resolved values.
      const toStrip = []
      for (const c of candidates) {
        const { prior } = computeEffectiveStateWithPrior(entity, nodes, edges, c.nodeId)
        const priorImage = prior?.profile_image_ref ?? null
        if (isNullLike(priorImage)) toStrip.push(c)
      }
      if (toStrip.length === 0) return
      const stripByNode = new Map()
      for (const c of toStrip) {
        if (!stripByNode.has(c.nodeId)) stripByNode.set(c.nodeId, [])
        stripByNode.get(c.nodeId).push(c)
      }
      const removedChangeIds = []
      const updNodes = nodes.map((n) => {
        if (!stripByNode.has(n.id)) return n
        const strips = stripByNode.get(n.id)
        if (n.type === 'sceneNode') {
          const newData = { ...n.data }
          for (const s of strips) {
            if (!s.bucket) continue
            newData[s.bucket] = (newData[s.bucket] || []).map((r) => {
              if (r.entity_id !== entityId) return r
              const oldId = r.scalar_change_ids?.profile_image_change
              if (oldId) removedChangeIds.push(oldId)
              const cleared = { ...r, profile_image_change: null }
              return { ...cleared, scalar_change_ids: maintainScalarChangeIds(r, cleared) }
            })
          }
          return { ...n, data: newData }
        }
        if (n.type === 'entityNode') {
          const oldId = n.data?.scalar_change_ids?.profile_image_change
          if (oldId) removedChangeIds.push(oldId)
          const cleared = { ...n.data, profile_image_change: null }
          return { ...n, data: { ...cleared, scalar_change_ids: maintainScalarChangeIds(n.data, cleared) } }
        }
        return n
      })
      set({ nodes: updNodes, hasUnsavedChanges: true })
      if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
      return
    }

    // ── Knowledge branch ──
    if (knowledgeId) {
      const k = get().knowledges.find((kk) => kk.id === knowledgeId)
      if (!k) return
      const list = (k.history?.profile_image_changes || [])
      if (list.length === 0) return
      const { nodes, edges } = get()
      const storyOrder = computeStoryOrder({ nodes, edges })
      const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      const positionByNodeId = new Map(nodeOrder.map((id, i) => [id, i]))
      const toStripIds = new Set()
      for (const entry of list) {
        if (!entry) continue
        const v = entry.new_profile_image_ref
        if (!isNullLike(v)) continue
        const pos = positionByNodeId.has(entry.node_id)
          ? positionByNodeId.get(entry.node_id) : -1
        let priorImage = null
        if (pos <= 0) {
          // First chain step — inherited from the Knowledge's baseline.
          priorImage = k.profile_image_ref ?? null
        } else {
          const priorNodeId = nodeOrder[pos - 1]
          const priorState = computeKnowledgeEffectiveState(
            k, nodeOrder, priorNodeId, { nodes, ctx: { storyOrder } },
          )
          priorImage = priorState?.profile_image_ref ?? null
        }
        if (isNullLike(priorImage)) toStripIds.add(entry.id)
      }
      if (toStripIds.size === 0) return
      set({
        knowledges: get().knowledges.map((kk) => {
          if (kk.id !== knowledgeId) return kk
          const history = kk.history || {}
          return {
            ...kk,
            history: {
              ...history,
              profile_image_changes: (history.profile_image_changes || []).filter(
                (c) => !toStripIds.has(c.id),
              ),
            },
          }
        }),
        hasUnsavedChanges: true,
      })
    }
  },

  /**
   * Phase 1.21f — companion to `flagDownstreamAfterOriginEdit`, for the
   * chain-anchor case. Awareness modals (and similar panels that bypass
   * `updateEntityRef` and write chain-time mutations directly via
   * `useProjectStore.setState`) must call this after their edit so
   * downstream review flags fire on EntityRefs that override the same
   * awareness keys.
   *
   * `oldRef` is the EntityRef snapshot taken BEFORE the edit. The
   * caller already wrote the new ref into `state.nodes`; this action
   * reads the current ref by `(nodeId, entityId)`, diffs it against
   * `oldRef`, and applies the standard downstream-flag propagation.
   *
   * Works for both sceneNode bucket entries and entityNode `data`
   * (modifier-node case). Origin nodes go through
   * `flagDownstreamAfterOriginEdit` instead.
   */
  flagDownstreamAfterChainAnchorEdit: (nodeId, entityId, oldRef) => {
    const { nodes, edges } = get()
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return

    let newRef = null
    if (node.type === 'sceneNode') {
      for (const bucket of ENTITY_BUCKETS) {
        const ref = (node.data?.[bucket] || []).find((r) => r.entity_id === entityId)
        if (ref) { newRef = ref; break }
      }
    } else if (node.type === 'entityNode' && node.data?.entity_id === entityId) {
      newRef = node.data
    }
    if (!newRef) return

    const oldChangedFields = oldRef ? getChangedFields(oldRef) : []
    const newChangedFields = getChangedFields(newRef)
    const oldVals = oldRef ? getSourceValues(oldRef) : {}
    const newVals = getSourceValues(newRef)

    const removedFields = oldChangedFields.filter((f) => !newChangedFields.includes(f))
    const actuallyChanged = newChangedFields.filter((f) => newVals[f] !== oldVals[f])

    if (actuallyChanged.length === 0 && removedFields.length === 0) return

    const updatedNodes = applyDownstreamReviewFlags(
      nodes, edges, nodeId, entityId,
      actuallyChanged, removedFields, newVals, oldVals,
    )
    if (updatedNodes !== nodes) {
      set({ nodes: updatedNodes, hasUnsavedChanges: true })
    }
  },

  flagDownstreamAfterOriginEdit: (entityId, oldEntity, newEntity) => {
    const { nodes, edges } = get()
    // Find the entity's origin node
    const originNode = nodes.find((n) => n.type === 'entityNode' && n.data.entity_id === entityId)
    if (!originNode) return

    // Determine which base fields changed, split into addedOrKept vs. removed so
    // applyDownstreamReviewFlags can auto-cancel conflicting downstream list ops (addedOrKept)
    // and restore previously-cancelled downstream ops (removed).
    const addedOrKeptFields = []
    const removedFields = []

    if ((oldEntity.name || '') !== (newEntity.name || ''))               addedOrKeptFields.push('name')
    if ((oldEntity.colour || '') !== (newEntity.colour || ''))           addedOrKeptFields.push('colour')
    if ((oldEntity.description || '') !== (newEntity.description || '')) addedOrKeptFields.push('description')
    if ((oldEntity.profile_image_ref || '') !== (newEntity.profile_image_ref || '')) addedOrKeptFields.push('profile_image')
    if (JSON.stringify(oldEntity.aliases || []) !== JSON.stringify(newEntity.aliases || [])) addedOrKeptFields.push('aliases')

    const oldAttrMap = new Map((oldEntity.attributes || []).map((a) => [a.id, a]))
    const newAttrMap = new Map((newEntity.attributes || []).map((a) => [a.id, a]))

    for (const [id, attr] of newAttrMap) {
      const oldAttr = oldAttrMap.get(id)
      if (attr.attribute_type === 'text_list' || attr.attribute_type === 'entity_list') {
        // Per-item keys so downstream list_add/list_remove ops are matched precisely
        const oldItems = new Set(oldAttr ? parseListValue(oldAttr.value) : [])
        const newItems = parseListValue(attr.value)
        for (const item of newItems) {
          if (!oldItems.has(item)) addedOrKeptFields.push(`list_add:${id}:${item}`)
        }
        const newItemsSet = new Set(newItems)
        for (const item of oldItems) {
          if (!newItemsSet.has(item)) removedFields.push(`list_add:${id}:${item}`)
        }
      } else {
        // Non-list: compare file_ref for file attributes, value otherwise
        const oldVal = oldAttr
          ? (oldAttr.attribute_type === 'file' ? (oldAttr.file_ref || oldAttr.value) : oldAttr.value)
          : null
        const newVal = attr.attribute_type === 'file' ? (attr.file_ref || attr.value) : attr.value
        if (!oldAttr || oldVal !== newVal) addedOrKeptFields.push(`attr:${id}`)
      }
    }
    for (const [id, oldAttr] of oldAttrMap) {
      if (!newAttrMap.has(id)) {
        if (oldAttr.attribute_type === 'text_list' || oldAttr.attribute_type === 'entity_list') {
          // Attribute removed: all its base items disappear → restore any downstream cancelled ops
          for (const item of parseListValue(oldAttr.value)) removedFields.push(`list_add:${id}:${item}`)
        } else {
          removedFields.push(`attr:${id}`)
        }
      }
    }

    // Phase 1.21f — origin-baseline awareness delta detection.
    // Per-attribute awareness, entity-existence awareness, canonical-name
    // awareness. Per-observer keys so a change to one observer doesn't
    // shadow another.
    //
    // Phase 1.21g — awareness fields can now be either a flat per-observer
    // dict OR a wrapper { entries, sources } where sources project levels
    // onto every member of a referenced relationship / entity-list. The
    // diff resolves both shapes through `resolveAwarenessField` so a
    // source add / remove / re-level that changes a member's effective
    // level fires the same per-observer flag a direct dict edit would.
    // Source-only edits whose membership doesn't actually shift any
    // observer's level produce no diff and no flag, by design.
    const awarenessCtx = (() => {
      const es = useEntitiesStore.getState()
      const allEntities = [
        ...(es.characters || []), ...(es.locations || []), ...(es.items || []),
        ...(es.factions || []),  ...(es.customs || []),
      ]
      return {
        nodes, edges,
        allEntities,
        allRelationships: get().relationships,
        anchorNodeId: originNode.id,
      }
    })()
    const resolveDict = (raw) => resolveAwarenessField(raw, awarenessCtx) || {}
    const awarenessDictKeys = (oldDict, newDict) => {
      const out = new Set()
      for (const k of Object.keys(oldDict || {})) out.add(k)
      for (const k of Object.keys(newDict || {})) out.add(k)
      return out
    }

    // Phase 1.21g — diff the SOURCES list of an awareness wrapper.
    // Origin-baseline source mutations (add / remove / level change) emit
    // source-keyed field keys that match the chain-time source-mutation
    // events `getChangedFields` emits on downstream chain anchors. This
    // is what lets a downstream `set_level` override on the same source
    // get a review flag when the upstream baseline of that source
    // shifts.
    const wrapperSources = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      if ('relationship_id' in raw && !('sources' in raw)) return []
      return Array.isArray(raw.sources) ? raw.sources : []
    }
    const sourceKey = (s) => {
      if (!s) return ''
      if (s.kind === 'relationship') return `rel:${s.relationship_id}`
      if (s.kind === 'attribute')    return `attr:${s.entity_id}:${s.attribute_id}`
      return ''
    }
    const diffSources = (target, oldRaw, newRaw, prefix) => {
      const oldByKey = new Map()
      for (const s of wrapperSources(oldRaw)) {
        const k = sourceKey(s)
        if (k) oldByKey.set(k, s)
      }
      const newByKey = new Map()
      for (const s of wrapperSources(newRaw)) {
        const k = sourceKey(s)
        if (k) newByKey.set(k, s)
      }
      for (const [k, s] of newByKey) {
        const before = oldByKey.get(k)
        if (!before) addedOrKeptFields.push(`${prefix}source:${k}`)
        else if (before.level !== s.level) addedOrKeptFields.push(`${prefix}source:${k}`)
      }
      for (const [k] of oldByKey) {
        if (!newByKey.has(k)) removedFields.push(`${prefix}source:${k}`)
      }
    }
    diffSources('entity', oldEntity?.awareness, newEntity?.awareness, 'awareness:entity:')
    diffSources('entity_name', oldEntity?.name_awareness, newEntity?.name_awareness, 'awareness:entity_name:')
    for (const [id, attr] of newAttrMap) {
      const oldAttr = oldAttrMap.get(id)
      diffSources('attribute', oldAttr?.awareness, attr?.awareness, `awareness_set:${id}:`)
    }
    for (const [id, attr] of newAttrMap) {
      const oldAttr = oldAttrMap.get(id)
      const oldAware = resolveDict(oldAttr?.awareness)
      const newAware = resolveDict(attr?.awareness)
      for (const obs of awarenessDictKeys(oldAware, newAware)) {
        if ((oldAware?.[obs] ?? null) !== (newAware?.[obs] ?? null)) {
          if (obs in newAware) addedOrKeptFields.push(`awareness_set:${id}:${obs}`)
          else                  removedFields.push(`awareness_set:${id}:${obs}`)
        }
      }
    }
    // entity-existence awareness
    {
      const oldAware = resolveDict(oldEntity?.awareness)
      const newAware = resolveDict(newEntity?.awareness)
      for (const obs of awarenessDictKeys(oldAware, newAware)) {
        if ((oldAware?.[obs] ?? null) !== (newAware?.[obs] ?? null)) {
          if (obs in newAware) addedOrKeptFields.push(`awareness:entity:${obs}`)
          else                  removedFields.push(`awareness:entity:${obs}`)
        }
      }
    }
    // canonical-name awareness
    {
      const oldAware = resolveDict(oldEntity?.name_awareness)
      const newAware = resolveDict(newEntity?.name_awareness)
      for (const obs of awarenessDictKeys(oldAware, newAware)) {
        if ((oldAware?.[obs] ?? null) !== (newAware?.[obs] ?? null)) {
          if (obs in newAware) addedOrKeptFields.push(`awareness:entity_name:${obs}`)
          else                  removedFields.push(`awareness:entity_name:${obs}`)
        }
      }
    }

    if (addedOrKeptFields.length === 0 && removedFields.length === 0) return

    const updatedNodes = applyDownstreamReviewFlags(
      nodes, edges, originNode.id, entityId,
      addedOrKeptFields, removedFields,
      getEntityBaseValues(newEntity), getEntityBaseValues(oldEntity)
    )
    if (updatedNodes !== nodes) {
      set({ nodes: updatedNodes, hasUnsavedChanges: true })
    }
    // Phase 2.5g follow-up — a baseline profile-image change can
    // make downstream explicit-clear (`""`) entries redundant. Sweep
    // them so the writer doesn't have to hand-strip each scene.
    get()._sweepRedundantNullProfileImageEntries({ entityId })
  },

  /**
   * Clear profile_image_change from the EntityRef for a specific entity in a node.
   * Used by the dismiss (−) button on profile image change sub-chips.
   */
  clearProfileImageChange: (nodeId, entityId) => {
    get()._snapshot()
    const { nodes } = get()
    // Phase 1.21c Tier 2 — collect change_ids of any scalar event being
    // nulled here so the cleanup cascade can detect attached Knowledges.
    const removedChangeIds = []
    const updNodes = nodes.map((n) => {
      if (n.id !== nodeId) return n
      // SceneNode: EntityRef in entity buckets
      if (n.type === 'sceneNode') {
        const updData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          updData[bucket] = (updData[bucket] || []).map((ref) => {
            if (ref.entity_id !== entityId) return ref
            const oldId = ref.scalar_change_ids?.profile_image_change
            if (oldId) removedChangeIds.push(oldId)
            const cleared = { ...ref, profile_image_change: null }
            return { ...cleared, scalar_change_ids: maintainScalarChangeIds(ref, cleared) }
          })
        }
        return { ...n, data: updData }
      }
      // EntityNode modifier: profile_image_change on node data directly
      if (n.type === 'entityNode' && n.data.entity_id === entityId) {
        const oldId = n.data?.scalar_change_ids?.profile_image_change
        if (oldId) removedChangeIds.push(oldId)
        const cleared = { ...n.data, profile_image_change: null }
        return { ...n, data: { ...cleared, scalar_change_ids: maintainScalarChangeIds(n.data, cleared) } }
      }
      return n
    })
    set({ nodes: updNodes, hasUnsavedChanges: true })
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
    // Phase 2.5g follow-up — clearing one anchor can leave further
    // downstream `""` entries (or this same entry on a sibling chain
    // branch) redundant. Sweep them.
    get()._sweepRedundantNullProfileImageEntries({ entityId })
  },

  /**
   * Clear a specific first-class change (name, colour, description, aliases) or
   * attribute change from an EntityRef in a sceneNode or entityNode.
   * Chip object fields used: isProfileImage, attributeId, field.
   */
  /**
   * Phase 1.21h — strip the chain-time override for a given field key
   * on the given carrier. Used by the redundancy alert's "Remove
   * override" button to drop a chain entry whose value now matches the
   * inherited upstream value (so the override is a no-op).
   *
   * Handles every field-key shape emitted by `getChangedFields`:
   *   - Scalar EntityRef fields: name, colour, description,
   *     profile_image, aliases — sets the matching `*_change` slot
   *     to null and reconciles `scalar_change_ids`.
   *   - `attr:<id>` — strips matching `attribute_changes` entries.
   *   - `list_add:<attrId>:<item>` / `list_remove:<attrId>:<item>` —
   *     strips the matching list-op entry.
   *   - `awareness_set:<attrId>:<observerId>` — strips the matching
   *     per-observer awareness entry.
   *   - `awareness_set:<attrId>:source:<srcKey>` — strips the matching
   *     per-attribute awareness source mutation.
   *   - `awareness:entity:<observerId>` / `awareness:entity_name:<observerId>` /
   *     `awareness:relationship:<relId>:<observerId>` — strips the
   *     matching `awareness_changes` direct entry.
   *   - `awareness:<target>:source:<srcKey>` /
   *     `awareness:relationship:<relId>:source:<srcKey>` — strips the
   *     matching `awareness_changes` source mutation.
   */
  removeChainOverrideForField: (nodeId, entityId, fieldKey) => {
    get()._snapshot()
    const removedChangeIds = []
    const SCALAR_MAP = {
      name: 'name_change',
      colour: 'colour_change',
      description: 'description_change',
      profile_image: 'profile_image_change',
    }
    const parts = fieldKey.split(':')
    const sourceIdx = parts.indexOf('source')
    const isSourceField = sourceIdx > 0 && parts.length > sourceIdx + 1
    const matchSource = (s) => {
      if (!s || !isSourceField) return false
      const srcKind = parts[sourceIdx + 1]
      if (srcKind === 'rel') return s.kind === 'relationship' && s.relationship_id === parts[sourceIdx + 2]
      if (srcKind === 'attr') return s.kind === 'attribute'
        && s.entity_id === parts[sourceIdx + 2]
        && s.attribute_id === parts[sourceIdx + 3]
      return false
    }

    const patchCarrier = (carrier) => {
      // Scalar field strip.
      if (SCALAR_MAP[fieldKey]) {
        const slot = SCALAR_MAP[fieldKey]
        const oldId = carrier?.scalar_change_ids?.[slot]
        if (oldId) removedChangeIds.push(oldId)
        const cleared = { ...carrier, [slot]: null }
        return { ...cleared, scalar_change_ids: maintainScalarChangeIds(carrier, cleared) }
      }

      // Aliases — per-event field; clear the array. Knowledge
      // attachment ids on `alias_changes[*].knowledge_id` are
      // collected as removed change ids so the attached-Knowledge
      // cleanup cascade fires for every dropped event.
      if (fieldKey === 'aliases') {
        const evs = carrier?.alias_changes || []
        for (const ev of evs) {
          if (ev?.id) removedChangeIds.push(ev.id)
        }
        return { ...carrier, alias_changes: [] }
      }

      // attr:<id> — full attribute add/modify/remove entry strip.
      if (fieldKey.startsWith('attr:')) {
        const attrId = fieldKey.slice('attr:'.length)
        const acs = carrier?.attribute_changes || []
        const removed = acs.filter((ac) =>
          (ac.action === 'add' && ac.attribute?.id === attrId) || ac.attribute_id === attrId
        )
        for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
        return { ...carrier, attribute_changes: acs.filter((ac) =>
          !((ac.action === 'add' && ac.attribute?.id === attrId) || ac.attribute_id === attrId)
        ) }
      }

      // list_add / list_remove — single-item strip by (attrId, item).
      if (fieldKey.startsWith('list_add:') || fieldKey.startsWith('list_remove:')) {
        const action = fieldKey.startsWith('list_add:') ? 'list_add' : 'list_remove'
        const rest = fieldKey.slice(action.length + 1)  // <attrId>:<item>
        const colonIdx = rest.indexOf(':')
        const attrId = rest.slice(0, colonIdx)
        const item   = rest.slice(colonIdx + 1)
        const acs = carrier?.attribute_changes || []
        const removed = acs.filter((ac) => ac.action === action && ac.attribute_id === attrId && ac.list_item === item)
        for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
        return { ...carrier, attribute_changes: acs.filter((ac) =>
          !(ac.action === action && ac.attribute_id === attrId && ac.list_item === item)
        ) }
      }

      // awareness_set:<attrId>:<observerId>  — per-observer entry strip.
      // awareness_set:<attrId>:source:<srcKey>  — per-attribute source mutation strip.
      if (fieldKey.startsWith('awareness_set:')) {
        const attrId = parts[1]
        const acs = carrier?.attribute_changes || []
        let nextAcs
        if (isSourceField) {
          const removed = acs.filter((ac) =>
            (ac.action === 'awareness_source_add' || ac.action === 'awareness_source_remove' || ac.action === 'awareness_source_set_level')
            && ac.attribute_id === attrId
            && matchSource(ac.source),
          )
          for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
          nextAcs = acs.filter((ac) =>
            !((ac.action === 'awareness_source_add' || ac.action === 'awareness_source_remove' || ac.action === 'awareness_source_set_level')
              && ac.attribute_id === attrId
              && matchSource(ac.source)),
          )
        } else {
          const observerId = parts.slice(2).join(':')
          const removed = acs.filter((ac) => ac.action === 'awareness_set' && ac.attribute_id === attrId && ac.list_item === observerId)
          for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
          nextAcs = acs.filter((ac) =>
            !(ac.action === 'awareness_set' && ac.attribute_id === attrId && ac.list_item === observerId),
          )
        }
        return { ...carrier, attribute_changes: nextAcs }
      }

      // Awareness chain entries live on `host.awareness.history` post
      // v0.2a.2.5 and are stripped by id via `removeAwarenessHistoryEntry`.
      // No legacy `awareness:*` field-key arm here; the canonical
      // strip path is taken by `SceneNode` chip-dismiss and
      // `AlertsPanel` redundant-override resolution.

      // Unknown field key — no-op. Caller passed something unexpected.
      return carrier
    }

    const updNodes = get().nodes.map((n) => {
      if (n.id !== nodeId) return n
      if (n.type === 'sceneNode') {
        const updData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          updData[bucket] = (updData[bucket] || []).map((r) =>
            r.entity_id === entityId ? patchCarrier(r) : r,
          )
        }
        return { ...n, data: updData }
      }
      if (n.type === 'entityNode' && n.data?.entity_id === entityId) {
        return { ...n, data: patchCarrier(n.data) }
      }
      return n
    })
    set({ nodes: updNodes, hasUnsavedChanges: true })
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
  },

  clearEntityRefChange: (nodeId, entityId, chip) => {
    get()._snapshot()
    const FIELD_MAP = { Name: 'name_change', Colour: 'colour_change', Description: 'description_change', 'Profile Image': 'profile_image_change' }
    // Phase 1.21c Tier 2 — capture change_ids of any event being removed
    // by this clear so the cascade can detect Knowledge attachments.
    const removedChangeIds = []
    // Aliases dismiss — clear the entire `alias_changes` array on the
    // carrier and collect every dropped event id for the cascade. The
    // sub-chip dismiss action treats "Aliases" as a single field that
    // packs all per-event alias mutations at this scene.
    const clearAliasChangesOn = (carrier) => {
      const evs = carrier?.alias_changes || []
      for (const ev of evs) {
        if (ev?.id) removedChangeIds.push(ev.id)
      }
      return { ...carrier, alias_changes: [] }
    }
    const patchRef = (ref) => {
      if (ref.entity_id !== entityId) return ref
      if (chip.isProfileImage) {
        const oldId = ref.scalar_change_ids?.profile_image_change
        if (oldId) removedChangeIds.push(oldId)
        const cleared = { ...ref, profile_image_change: null }
        return { ...cleared, scalar_change_ids: maintainScalarChangeIds(ref, cleared) }
      }
      if (chip.attributeId) {
        // `add` entries carry the attribute id on `ac.attribute.id` (the
        // attribute itself doesn't exist on the entity yet); modify /
        // remove / list_* / rename entries carry it on `ac.attribute_id`.
        // Match either shape so the dismiss action removes add chips too.
        const matchesChip = (ac) =>
          (ac?.action === 'add' ? ac.attribute?.id === chip.attributeId : ac.attribute_id === chip.attributeId)
        const removed = (ref.attribute_changes || []).filter(matchesChip)
        for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
        return { ...ref, attribute_changes: (ref.attribute_changes || []).filter((ac) => !matchesChip(ac)) }
      }
      if (chip.field === 'Aliases') {
        return clearAliasChangesOn(ref)
      }
      const key = FIELD_MAP[chip.field]
      if (!key) return ref
      const oldId = ref.scalar_change_ids?.[key]
      if (oldId) removedChangeIds.push(oldId)
      const cleared = { ...ref, [key]: null }
      return { ...cleared, scalar_change_ids: maintainScalarChangeIds(ref, cleared) }
    }
    const updNodes = get().nodes.map((n) => {
      if (n.id !== nodeId) return n
      if (n.type === 'sceneNode') {
        const updData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) updData[bucket] = (updData[bucket] || []).map(patchRef)
        return { ...n, data: updData }
      }
      if (n.type === 'entityNode' && n.data.entity_id === entityId) {
        if (chip.isProfileImage) {
          const oldId = n.data?.scalar_change_ids?.profile_image_change
          if (oldId) removedChangeIds.push(oldId)
          const cleared = { ...n.data, profile_image_change: null }
          return { ...n, data: { ...cleared, scalar_change_ids: maintainScalarChangeIds(n.data, cleared) } }
        }
        if (chip.attributeId) {
          // Match `add` entries by `ac.attribute.id` and other actions by
          // `ac.attribute_id` — same shape as the EntityRef branch above.
          const matchesChip = (ac) =>
            (ac?.action === 'add' ? ac.attribute?.id === chip.attributeId : ac.attribute_id === chip.attributeId)
          const removed = (n.data.attribute_changes || []).filter(matchesChip)
          for (const r of removed) if (r?.id) removedChangeIds.push(r.id)
          return { ...n, data: { ...n.data, attribute_changes: (n.data.attribute_changes || []).filter((ac) => !matchesChip(ac)) } }
        }
        if (chip.field === 'Aliases') {
          return { ...n, data: clearAliasChangesOn(n.data) }
        }
        const key = FIELD_MAP[chip.field]
        if (!key) return n
        const oldId = n.data?.scalar_change_ids?.[key]
        if (oldId) removedChangeIds.push(oldId)
        const cleared = { ...n.data, [key]: null }
        return { ...n, data: { ...cleared, scalar_change_ids: maintainScalarChangeIds(n.data, cleared) } }
      }
      return n
    })
    set({ nodes: updNodes, hasUnsavedChanges: true })
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
  },

  /**
   * Phase 1.21k — Remove a baseline attribute from an entity at its
   * origin. Mirrors what the sidebar's pending-remove + Save flow does
   * for a single attribute, but runs immediately (no draft step) so a
   * sub-chip "Remove this change" ✕ on the origin EntityNode (or the
   * sidebar's "Additions at this point" subchip) can do an instant
   * remove with the same UX as the chain-anchor `clearEntityRefChange`
   * path. Snapshots, mutates the entity baseline via `updateEntity`,
   * cascades downstream `attribute_changes` cleanup, applies origin
   * downstream review flags, and fires the Knowledge cascade keyed
   * off the attribute id (entity_baseline source events use
   * `change_id: attribute.id`).
   */
  removeBaselineAttribute: async (entityId, attributeId) => {
    if (!entityId || !attributeId) return
    const es = useEntitiesStore.getState()
    const entity = es.getEntityById ? es.getEntityById(entityId) : null
    if (!entity) return
    const oldEntity = { ...entity }
    const newAttrs = (entity.attributes || []).filter((a) => a.id !== attributeId)
    if (newAttrs.length === (entity.attributes || []).length) return  // attr not present
    const newEntityData = { ...entity, attributes: newAttrs }

    const entityBucket = oldEntity?.type ? `${oldEntity.type}s` : null
    if (entityBucket) {
      get()._snapshot({ _entityDataRestore: [{ ...oldEntity, _bucket: entityBucket }] })
    } else {
      get()._snapshot()
    }

    await es.updateEntity(entityId, newEntityData)
    get().cascadeDropAttributeChanges(new Set([attributeId]))
    if (typeof get().flagDownstreamAfterOriginEdit === 'function') {
      get().flagDownstreamAfterOriginEdit(entityId, oldEntity, newEntityData)
    }

    if (entityBucket) {
      get()._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...newEntityData, _bucket: entityBucket }] })
    }

    get()._runEventRemovalCascade([attributeId])
  },

  /**
   * Remove all canvas edges with the given relationshipId regardless of which node they
   * connect. Used by EntityNode origin/modifier removeHandlers (no node scope needed).
   */
  removeRelationshipEdgeById: (relationshipId) => {
    const { edges } = get()
    const filtered = edges.filter((e) => e.data?.relationship_id !== relationshipId)
    if (filtered.length === edges.length) return  // no-op when no matching edges
    get()._snapshot()
    set({ edges: filtered, hasUnsavedChanges: true })
  },

  /**
   * After a chip is added via a secondary method, look upstream for an existing
   * node carrying this entity and offer to create the wire.
   * If not found or ambiguous the chip stays Orphaned.
   */
  _confirmUpstreamConnection: async (targetNodeId, entityId) => {
    const { nodes, edges } = get()
    const { sourceNode } = findUpstreamEntitySource(nodes, edges, targetNodeId, entityId)

    if (!sourceNode) return  // not found or ambiguous — chip stays Orphaned

    // Build an entityMap for NodeBadge lookups — gathered on demand so the
    // store doesn't carry a persistent map just for this dialog.
    const es = useEntitiesStore.getState()
    const entityMap = new Map(
      [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
        .map((e) => [e.id, e])
    )
    const result = await confirm({
      title: 'Connect to upstream source',
      message: buildUpstreamConnectMessage({
        entity: entityMap.get(entityId),
        sourceNodeId: sourceNode.id,
        targetNodeId,
        nodes,
        entityMap,
      }),
      buttons: [
        { label: 'Connect', value: 'connect', style: 'primary' },
        { label: 'Cancel',  value: 'cancel',  style: 'neutral' },
      ],
    })
    if (result !== 'connect') return  // chip stays Orphaned

    // Route the actual wire creation through `onConnect` — the canonical
    // wire-creation handler. It applies the chip-in-{entityId} target
    // handle, auto-creates the EntityRef in the target if missing, applies
    // soft-limits + convergence guards, and runs cycle / story-order
    // checks. Faking the `params` shape as if the user had dragged from
    // the upstream's entity-chip-out handle to the target scene's
    // chip-in-{entityId} handle gives onConnect's Case 2 / Case 4
    // same-entity fallthroughs and lands the wire in the correct shape.
    await get().onConnect({
      source: sourceNode.id,
      sourceHandle: sourceNode.type === 'sceneNode' ? entityId : null,
      target: targetNodeId,
      targetHandle: `chip-in-${entityId}`,
    })
  },

  /**
   * MCP-driven auto-wire: find an upstream source for `entityId` and
   * connect it to `targetNodeId` through the canonical `onConnect`
   * dispatcher (which carries the chip-in-{entityId} target handle,
   * EntityRef auto-creation, soft-limit + convergence guard, and
   * cycle / story-order checks).
   *
   * Upstream resolution combines two passes:
   *   1. `findUpstreamEntitySource` — BFS backwards through existing
   *      narrative-flow edges to find a previously-wired prior
   *      appearance. Picks this up when the entity already has a
   *      chain that connects into the target.
   *   2. Story-order fallback — if (1) returns nothing (entity has
   *      independent chips not wired to the target), find the entity's
   *      MOST RECENT scene in global story order strictly before the
   *      target. This catches the common case where the AI builds
   *      scenes in story order, adds entity chips to each, and
   *      expects the chain to follow that order without needing the
   *      AI to manually wire each one. Falls back to the entity's
   *      origin EntityNode if no prior scene exists.
   *
   * Ambiguous BFS results throw with the suggested-correction text
   * per D2's "violations surface error + suggested corrections"
   * verdict.
   *
   * Cycle-safeguarded both client-side here and again inside
   * `onConnect` (defence in depth — our pre-check throws cleanly
   * without a UI modal; onConnect's would pop a `confirm` dialog
   * which interleaves badly with the MCP session lockout overlay).
   *
   * Used by the MCP `add_entity_to_scene` handler so chips land
   * already-wired into the entity's chain instead of staying
   * orphaned. UI-driven chip adds still go through
   * `_confirmUpstreamConnection` to ask the user.
   */
  _autoConnectUpstreamForChain: async (targetNodeId, entityId, opts = {}) => {
    const { nodes, edges } = get()
    const targetNode = nodes.find((n) => n.id === targetNodeId)
    if (!targetNode) {
      throw new Error(`auto-wire target scene not found: ${targetNodeId}`)
    }

    // When the caller explicitly named a predecessor scene (the
    // `predecessor` arg on `add_entity_to_scene`'s per-item payload),
    // skip both passes below and route the wire directly from it.
    // The predecessor must (a) exist as a sceneNode, (b) carry a chip
    // for this entity already — otherwise the auto-wire would chain
    // from a scene where the entity isn't actually present, which is
    // exactly the kind of inconsistency the upstream search exists to
    // prevent. We still run the same cycle pre-check + onConnect path
    // below so the wire creation is identical to the auto-path's.
    let resolvedSource = null
    const explicitPredecessor = opts?.predecessorNodeId || null
    if (explicitPredecessor) {
      const predNode = nodes.find((n) => n.id === explicitPredecessor)
      if (!predNode || predNode.type !== 'sceneNode') {
        throw new Error(
          `predecessor scene not found: ${explicitPredecessor}. Pass the predecessor's scene ` +
          `UUID or exact title via the per-item 'predecessor' field on add_entity_to_scene.`
        )
      }
      const predHasChip = ENTITY_BUCKETS.some(
        (b) => (predNode.data?.[b] || []).some((r) => r.entity_id === entityId),
      )
      if (!predHasChip) {
        throw new Error(
          `predecessor scene '${predNode.data?.title || explicitPredecessor}' does not have a chip ` +
          `for this entity. Pick a predecessor where the entity is already present in the scene.`
        )
      }
      resolvedSource = predNode
    } else {
      // Pass 1: existing-chain BFS from target.
      const { sourceNode: bfsSource, ambiguous } = findUpstreamEntitySource(nodes, edges, targetNodeId, entityId)
      if (ambiguous) {
        throw new Error(
          `auto-wire upstream search ambiguous: multiple equidistant chain candidates for this entity ` +
          `lead into the target scene. Resolve by retrying with the per-item 'predecessor' field on ` +
          `add_entity_to_scene to name the upstream scene explicitly, or by adding the wire ` +
          `manually in the UI.`
        )
      }
      resolvedSource = bfsSource
    }
    // Pass 2: story-order fallback when no existing chain reaches the
    // target. Find the entity's chip-bearing scenes (excluding the
    // target itself), sort by story order, pick the most recent
    // strictly before the target. Origin EntityNode is the floor when
    // no prior chip exists.
    if (!resolvedSource) {
      const storyOrder = computeStoryOrder({ nodes, edges })
      const orderedIds = storyOrder?.orderedIds || []
      const targetIdx = orderedIds.indexOf(targetNodeId)
      const entitySceneIds = new Set()
      for (const n of nodes) {
        if (n.type !== 'sceneNode') continue
        if (n.id === targetNodeId) continue
        const hasChip = ENTITY_BUCKETS.some(
          (b) => (n.data?.[b] || []).some((r) => r.entity_id === entityId),
        )
        if (hasChip) entitySceneIds.add(n.id)
      }
      if (targetIdx >= 0 && entitySceneIds.size > 0) {
        // Walk story-order backwards from the target, return the first
        // chip-bearing scene found.
        for (let i = targetIdx - 1; i >= 0; i--) {
          const candidateId = orderedIds[i]
          if (entitySceneIds.has(candidateId)) {
            resolvedSource = nodes.find((n) => n.id === candidateId) || null
            break
          }
        }
      }
      // Final fallback: the entity's origin EntityNode.
      if (!resolvedSource) {
        resolvedSource = nodes.find(
          (n) => n.type === 'entityNode' && n.data?.entity_id === entityId && !n.data?.is_modifier,
        ) || null
      }
      if (!resolvedSource) {
        throw new Error(
          `auto-wire failed: entity has no origin EntityNode on canvas. ` +
          `This shouldn't happen for entities created via create_entity; ` +
          `it can occur on legacy projects where the origin node was deleted manually.`
        )
      }
    }

    // Cycle pre-check (defence in depth — onConnect also detects
    // cycles, but pops a UI modal we want to avoid in the MCP flow).
    if (resolvedSource.id === targetNodeId) {
      throw new Error(
        `auto-wire would create a self-loop on scene ${targetNodeId}. Refused.`
      )
    }
    if (_isFlowReachable(targetNodeId, resolvedSource.id, edges, entityId)) {
      throw new Error(
        `auto-wire would create a cycle: the chosen upstream source ` +
        `(${resolvedSource.id}) is already reachable downstream of the target scene ` +
        `via existing narrative-flow edges for this entity. Refused. Resolve manually by ` +
        `re-organising the entity's chain in the UI.`
      )
    }

    // Route the wire creation through the canonical `onConnect`
    // dispatcher. The same-entity sourceHandle / targetHandle combo
    // hits the Case 2 (entityNode → scene chip) or Case 4 (scene
    // chip → scene chip) same-entity fallthrough, which clears
    // targetHandle and runs the general flow-wire path. That path
    // applies the chip-in-{entityId} target handle, auto-creates
    // the EntityRef in the target if missing, applies soft-limit
    // replacement, and writes a properly-shaped edge.
    await get().onConnect({
      source: resolvedSource.id,
      sourceHandle: resolvedSource.type === 'sceneNode' ? entityId : null,
      target: targetNodeId,
      targetHandle: `chip-in-${entityId}`,
    })
    return { sourceNodeId: resolvedSource.id, fromOrigin: resolvedSource.type === 'entityNode' }
  },

  /**
   * Find the current POV chain neighbours of a scene. Returns
   * `{ predecessorId, successorId }` — either may be null if the scene
   * is at chain head / tail / off-chain. Used by the MCP POV-reorg
   * rewire flow (D2-part-two) to capture state both BEFORE and AFTER
   * an `_insertSceneIntoPovChain` call so the affected-scene set can
   * be computed.
   */
  _getPovNeighboursOfScene: (sceneId) => {
    const { edges } = get()
    const incoming = edges.find((e) => e.data?.is_pov_path && e.target === sceneId)
    const outgoing = edges.find((e) => e.data?.is_pov_path && e.source === sceneId)
    // Filter out predecessor that's actually the POV origin node — for
    // entity continuity purposes, "predecessor" means a scene neighbour,
    // not the chain's origin marker.
    let predecessorId = null
    if (incoming) {
      const srcNode = get().nodes.find((n) => n.id === incoming.source)
      if (srcNode?.type === 'sceneNode') predecessorId = incoming.source
    }
    const successorId = outgoing ? outgoing.target : null
    return { predecessorId, successorId }
  },

  /**
   * MCP-only POV-reorganization entity-continuity rewire (D2-part-two).
   *
   * Called by mcpTools.js AFTER `_insertSceneIntoPovChain` has applied
   * a POV chain change driven by `update_scene(pov_after=…)` or
   * `update_scene(pov_before=…)`. Reconstructs entity-continuity wires
   * so each affected entity's chain matches the new POV temporal order.
   *
   * Scope (per the audit verdict + user clarification): all entities
   * present on the moved scene PLUS its OLD POV neighbours (captured
   * before the reorg) PLUS its NEW POV neighbours (computed after).
   * Up to 5 affected scenes max (deduped); usually fewer.
   *
   * Algorithm:
   *   1. Walk the new POV chain in order, build the full POV-scene id
   *      sequence + the POV-scene set.
   *   2. For each affected entity:
   *      a. Filter the POV order to scenes where the entity has a chip
   *         → that's the entity's new POV-chain wire sequence.
   *      b. Strip the entity's existing continuity wires where BOTH
   *         source and target are POV-chain scenes AND at least one is
   *         in the affected scene set. Off-chain branches survive.
   *      c. For each consecutive (src, tgt) pair in the new sequence
   *         where at least one is affected, route a wire via the
   *         canonical `onConnect` dispatcher. Skip when the source chip
   *         already has an outgoing wire to a non-POV-chain (off-chain)
   *         scene — preserves user-meaningful off-chain branches at the
   *         cost of a POV-chain gap (rare; documented limitation).
   *
   * Off-chain entity wires are never touched. Off-screen transitions
   * (off_screen=true / pov_character clear) DO NOT trigger this rewire
   * — that's the second half of the user's D2-part-two decision.
   *
   * MCP-only by design — UI's POV-reorganization flows do NOT call this
   * helper; they're left to user-managed wire control.
   */
  _rewireEntityChainsForMcpPovReorg: async (movedSceneId, oldPredId, oldSuccId) => {
    const { nodes, edges } = get()

    // Walk the new POV chain in order to build (a) the POV scene
    // sequence and (b) the POV-chain scene set.
    const povOriginNode = nodes.find((n) => n.type === 'povOriginNode')
    if (!povOriginNode) return

    const povOrder = []
    const povScenes = new Set()
    {
      let cur = povOriginNode.id
      const visited = new Set([cur])
      while (true) {
        const out = edges.find((e) => e.data?.is_pov_path && e.source === cur)
        if (!out) break
        if (visited.has(out.target)) break
        visited.add(out.target)
        const tgtNode = nodes.find((n) => n.id === out.target)
        if (tgtNode?.type === 'sceneNode') {
          povOrder.push(out.target)
          povScenes.add(out.target)
        }
        cur = out.target
      }
    }

    // New POV neighbours of the moved scene.
    const movedIdx = povOrder.indexOf(movedSceneId)
    const newPredId = (movedIdx > 0) ? povOrder[movedIdx - 1] : null
    const newSuccId = (movedIdx >= 0 && movedIdx < povOrder.length - 1) ? povOrder[movedIdx + 1] : null

    // Affected scene set.
    const affected = new Set([movedSceneId])
    if (oldPredId) affected.add(oldPredId)
    if (oldSuccId) affected.add(oldSuccId)
    if (newPredId) affected.add(newPredId)
    if (newSuccId) affected.add(newSuccId)

    // Affected entity set: union of chips on every affected scene.
    const affectedEntityIds = new Set()
    for (const sid of affected) {
      const n = nodes.find((nn) => nn.id === sid)
      if (!n || n.type !== 'sceneNode') continue
      for (const bucket of ENTITY_BUCKETS) {
        for (const ref of n.data?.[bucket] || []) {
          if (ref?.entity_id) affectedEntityIds.add(ref.entity_id)
        }
      }
    }

    for (const entityId of affectedEntityIds) {
      // Strip existing POV-chain continuity wires for this entity that
      // touch any affected scene. Wires where source OR target is
      // off-chain survive — that preserves entity wires that branch
      // off into off-chain scenes.
      {
        const curEdges = get().edges
        const stripIds = new Set()
        for (const e of curEdges) {
          if (e.data?.source_entity_id !== entityId) continue
          if (e.data?.is_pov_path) continue
          if (e.data?.is_relationship) continue
          if (!povScenes.has(e.source)) continue   // off-chain source — keep
          if (!povScenes.has(e.target)) continue   // off-chain target — keep
          if (!affected.has(e.source) && !affected.has(e.target)) continue
          stripIds.add(e.id)
        }
        if (stripIds.size > 0) {
          set({ edges: get().edges.filter((e) => !stripIds.has(e.id)) })
        }
      }

      // New POV-chain wire sequence for this entity: POV order filtered
      // to scenes where the entity has a chip.
      const entityPovSeq = povOrder.filter((sid) => {
        const n = get().nodes.find((nn) => nn.id === sid)
        if (!n || n.type !== 'sceneNode') return false
        return ENTITY_BUCKETS.some(
          (b) => (n.data?.[b] || []).some((r) => r.entity_id === entityId),
        )
      })

      // Wire consecutive pairs that touch the affected set.
      for (let i = 0; i < entityPovSeq.length - 1; i++) {
        const srcId = entityPovSeq[i]
        const tgtId = entityPovSeq[i + 1]
        if (!affected.has(srcId) && !affected.has(tgtId)) continue

        // Preserve off-chain branches: if the source chip already has a
        // continuity outgoing wire to an off-chain scene, leave it alone.
        const curEdges = get().edges
        const srcHasOffChainOut = curEdges.some((e) =>
          e.source === srcId
          && e.data?.source_entity_id === entityId
          && !e.data?.is_pov_path
          && !e.data?.is_relationship
          && !povScenes.has(e.target),
        )
        if (srcHasOffChainOut) continue

        // Skip if the desired wire already exists (idempotency).
        const alreadyWired = curEdges.some((e) =>
          e.source === srcId
          && e.target === tgtId
          && e.data?.source_entity_id === entityId
          && !e.data?.is_pov_path
          && !e.data?.is_relationship,
        )
        if (alreadyWired) continue

        try {
          await get().onConnect({
            source: srcId,
            sourceHandle: entityId,
            target: tgtId,
            targetHandle: `chip-in-${entityId}`,
          })
        } catch (err) {
          // Best-effort — cycle detection or other onConnect rejection
          // skips this wire but doesn't abort the rewire of other
          // entities or other wires for this entity.
          console.warn(`[mcp-pov-reorg] rewire skipped for entity ${entityId} ${srcId}→${tgtId}: ${err.message}`)
        }
      }

      // ── Origin EntityNode fix-up ───────────────────────────────────
      // The strip pass above only touched POV-chain-to-POV-chain wires
      // (per the off-chain-preservation rule). Origin EntityNode wires
      // were left intact — but if the entity's POV-chain head changed,
      // the origin's outgoing wire still points at the old head and
      // the new head has no incoming wire (orphaned chip). Detect that
      // case and rewire: strip origin→affected-scene wires where the
      // target is NOT the new head, then ensure the new head has an
      // incoming continuity wire via _autoConnectUpstreamForChain
      // (which routes from origin when no upstream chip predecessor
      // exists).
      const originNode = get().nodes.find(
        (n) => n.type === 'entityNode' && n.data?.entity_id === entityId && !n.data?.is_modifier,
      )
      if (originNode) {
        const newHeadId = entityPovSeq[0] || null

        // Strip origin→affected-scene wires that no longer match the
        // new head. Off-chain origin-out wires are left alone.
        const curEdges = get().edges
        const stripIds = new Set()
        for (const e of curEdges) {
          if (e.source !== originNode.id) continue
          if (e.data?.source_entity_id !== entityId) continue
          if (e.data?.is_pov_path) continue
          if (e.data?.is_relationship) continue
          if (!affected.has(e.target)) continue        // off-affected stays
          if (e.target === newHeadId) continue         // correct origin→head stays
          stripIds.add(e.id)
        }
        if (stripIds.size > 0) {
          set({ edges: get().edges.filter((e) => !stripIds.has(e.id)) })
        }

        // Ensure the new POV-chain head has an incoming continuity
        // wire. If not, route via _autoConnectUpstreamForChain — which
        // walks story order back to a prior chip-bearing scene, falling
        // through to the origin EntityNode when none exists.
        if (newHeadId) {
          const curEdges2 = get().edges
          const hasIncoming = curEdges2.some((e) =>
            e.target === newHeadId
            && e.data?.source_entity_id === entityId
            && !e.data?.is_pov_path
            && !e.data?.is_relationship,
          )
          if (!hasIncoming) {
            try {
              await get()._autoConnectUpstreamForChain(newHeadId, entityId)
            } catch (err) {
              console.warn(`[mcp-pov-reorg] auto-connect new head failed for entity ${entityId} → ${newHeadId}: ${err.message}`)
            }
          }
        }
      }
    }
  },

  // ── Relationship actions ──────────────────────────────────────────────────────

  createRelationship: async (relData) => {
    get()._snapshot()
    // History-only model: strip any caller-supplied `participants` field.
    // The canonical participant state lives exclusively in
    // history.participant_changes; any base mirror is ignored at the store
    // boundary.
     
    const { participants: _ignoredParticipants, ...cleaned } = relData || {}
    // Phase 1.21h Fix #3 — derive `creation_anchor_node_id` from the
    // initial participant joins (or existence_changes) so anchor-aware
    // setters can route baseline-vs-chain-entry writes deterministically
    // without a heuristic.
    //
    // v0.3.4.31 — `membership_of`-gated. Faction-membership relationships
    // are activated at the faction's origin INDEPENDENT of any
    // participant joins (members can later join the membership rel via
    // the canvas without re-creating it). For those, the activate event
    // is the origin. For regular relationships, the design assumption
    // ("all existing creation paths anchor every initial join to the
    // same node") still holds — the join IS the origin. Mirrors the
    // gated fallback in `getRelationshipCreationNodeId`.
    if (!cleaned.creation_anchor_node_id) {
      const joins = (cleaned.history?.participant_changes || []).filter((c) => c?.action === 'join')
      const joinNodeIds = [...new Set(joins.map((c) => c.node_id).filter(Boolean))]
      const activates = (cleaned.history?.existence_changes || []).filter((c) => c?.action === 'activate')
      const activateNodeIds = [...new Set(activates.map((c) => c.node_id).filter(Boolean))]
      if (cleaned.membership_of) {
        // Faction-membership: prefer the activate event.
        if (activateNodeIds.length === 1) cleaned.creation_anchor_node_id = activateNodeIds[0]
        // Multi-activate at creation (very unusual): leave null and let
        // the helper sort by story order at read time.
      } else if (joinNodeIds.length === 1) {
        // Regular single-node creation (the common case): use that node.
        cleaned.creation_anchor_node_id = joinNodeIds[0]
      } else if (joinNodeIds.length === 0 && activateNodeIds.length === 1) {
        cleaned.creation_anchor_node_id = activateNodeIds[0]
      }
      // Multi-node creations (rare; canvas-built relationships where
      // joins land at distinct entity-origin nodes): leave null so the
      // helper's fallback heuristic fires.
    }
    const { data } = await axios.post('/api/relationships/', cleaned)
    const relationships = [...get().relationships, data]
    const { byEntity, byScene } = _buildRelIndexes(relationships)
    set({ relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    return data
  },

  updateRelationship: async (relId, relData) => {
    const { data } = await axios.put(`/api/relationships/${relId}`, relData)
    const relationships = get().relationships.map((r) => r.id === relId ? data : r)
    const { byEntity, byScene } = _buildRelIndexes(relationships)
    set({ relationships, relationshipsByEntity: byEntity, relationshipsByScene: byScene, hasUnsavedChanges: true })
    return data
  },

  // ── Knowledge actions (Phase 1.21c) ──────────────────────────────────────
  //
  // CRUD + chain-mutation actions for the first-class Knowledge object.
  // Backend CRUD routes through /api/knowledges/ (the Step 2 router).
  // Chain mutations (awareness at a scene, content changes at a scene) are
  // local-only writes to Knowledge.history arrays — synced to the backend
  // on the next save, same way Relationship history mutations work.
  //
  // Undo / redo use the standard `_snapshot()` pattern.
  //
  // Normalised-history invariant: at most one entry per (entity_id,
  // node_id) in awareness_changes; at most one entry per node_id in
  // name_changes / description_changes / colour_changes. Re-edit at the
  // same node replaces in place.

  /** Create a new Knowledge via the backend router and append it locally. */
  createKnowledge: async (knowledgeData) => {
    get()._snapshot()
    const { data } = await axios.post('/api/knowledges/', knowledgeData || {})
    set({
      knowledges: [...get().knowledges, data],
      hasUnsavedChanges: true,
    })
    return data
  },

  /** Phase 1.21c — create a Knowledge whose **origin IS a specific scene**.
   *  Mirrors the relationship "+ Create relationship" born-at-scene flow
   *  (`createEmptyRelationshipHistory({ bornAtSceneId })` seeding an
   *  `existence_changes: activate@scene` event). The activate event makes
   *  this scene the Knowledge's chain-birth — distinct from a
   *  manual-anchor pin (which is a "show me here too" affordance for a
   *  Knowledge whose origin already lives elsewhere). One snapshot
   *  covers create + birth-event so undo reverts the full action in one
   *  step. */
  createKnowledgeAtScene: async (knowledgeData, sceneNodeId) => {
    get()._snapshot()
    const { data } = await axios.post('/api/knowledges/', knowledgeData || {})
    const born = sceneNodeId
      ? {
          ...data,
          history: {
            ...(data.history || {}),
            existence_changes: [
              ...((data.history?.existence_changes || [])),
              { id: crypto.randomUUID(), node_id: sceneNodeId, action: 'activate', source_event: null },
            ],
          },
        }
      : data
    set({
      knowledges: [...get().knowledges, born],
      hasUnsavedChanges: true,
    })
    return born
  },

  /** Phase 1.21c Tier 3 — mark an existing Knowledge as scene-born by
   *  appending an `existence_changes: activate@scene` event. Used by the
   *  drag-from-library → drop-on-scene path when the Knowledge has no
   *  prior creation anchor (no `<KnowledgeOriginNode>` on canvas, no
   *  prior activate event). Returns true on success, false if the
   *  Knowledge already had a creation anchor or the args were invalid. */
  seedKnowledgeBirthAtScene: (knowledgeId, sceneNodeId) => {
    if (!knowledgeId || !sceneNodeId) return false
    const state = get()
    const k = (state.knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return false
    const hasOriginNode = (state.nodes || []).some(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId,
    )
    if (hasOriginNode) return false
    const existing = Array.isArray(k.history?.existence_changes)
      ? k.history.existence_changes
      : []
    if (existing.some((c) => c?.action === 'activate')) return false
    state._snapshot()
    set({
      knowledges: state.knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        return {
          ...kk,
          // Auto-upgrade: birth event at this scene supersedes any prior
          // manual anchor on the same scene.
          manual_anchors: (kk.manual_anchors || []).filter((a) => a?.node_id !== sceneNodeId),
          history: {
            ...(kk.history || {}),
            existence_changes: [
              ...existing,
              { id: crypto.randomUUID(), node_id: sceneNodeId, action: 'activate', source_event: null },
            ],
          },
        }
      }),
      hasUnsavedChanges: true,
    })
    return true
  },

  /** Phase 1.21c Step 14 — Add a `<KnowledgeOriginNode>` to the canvas
   *  for an existing Knowledge. One per Knowledge — no-op if one already
   *  exists. Position defaults to the canvas viewport centre when not
   *  supplied. Returns the new node, or the existing one if there was
   *  already an origin node for this Knowledge. */
  addKnowledgeOriginNodeToCanvas: (knowledgeId, position = null) => {
    const state = get()
    const existing = (state.nodes || []).find(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId,
    )
    if (existing) return existing
    const pos = position || (() => {
      const vp = useUiStore.getState()._getViewportCenter?.()
      return vp ? { x: Math.round(vp.x - 100), y: Math.round(vp.y - 30) } : { x: 0, y: 0 }
    })()
    state._snapshot()
    const newNode = {
      id: crypto.randomUUID(),
      type: 'knowledgeOriginNode',
      position: pos,
      data: {
        node_type: 'knowledge_origin',
        knowledge_id: knowledgeId,
        position: pos,
      },
    }
    set({
      nodes: [...(state.nodes || []), newNode],
      hasUnsavedChanges: true,
    })
    return newNode
  },

  /** Replace a Knowledge wholesale (used by the detail panel Save flow). */
  updateKnowledge: async (knowledgeId, knowledgeData) => {
    get()._snapshot()
    const { data } = await axios.put(`/api/knowledges/${knowledgeId}`, knowledgeData)
    set({
      knowledges: get().knowledges.map((k) => k.id === knowledgeId ? data : k),
      hasUnsavedChanges: true,
    })
    // Phase 2.5g follow-up — a baseline replace may have changed
    // `profile_image_ref`, leaving downstream chain entries on
    // `history.profile_image_changes` redundant (when both baseline
    // and the entry resolve to null/empty). Sweep them.
    get()._sweepRedundantNullProfileImageEntries({ knowledgeId })
    return data
  },

  /**
   * Internal per-type DELETE handler for Knowledges. Do not call directly —
   * go through `deleteObject('knowledge', id)`. Takes snapshot with
   * `_knowledgeRestore` for undo's backend re-POST, fires backend DELETE
   * (swallows 404 — the row may already be gone), applies the Knowledge
   * strip primitive. Mirror of `_deleteRelationshipInternal`.
   */
  _deleteKnowledgeInternal: async (knowledgeId) => {
    const kn = get().knowledges.find((k) => k.id === knowledgeId)
    if (!kn) return
    // Phase 2.13 — capture pre-sweep snapshots of any entity that hosts a
    // perspective attribute whose target is the deleted knowledge. Undo
    // restores the orphaned target ids from these snapshots.
    const es = useEntitiesStore.getState()
    const entitiesToRestore = []
    for (const bucket of ENTITY_BUCKETS) {
      for (const e of (es[bucket] || [])) {
        const hasPerspectiveTargetRef = (e.attributes || []).some((a) =>
          a.attribute_type === 'perspective' &&
          a.perspective_target_kind === 'knowledge' &&
          a.perspective_target_id === knowledgeId
        )
        if (hasPerspectiveTargetRef) {
          entitiesToRestore.push({ ...e, _bucket: bucket })
        }
      }
    }
    get()._snapshot({
      _knowledgeRestore: [kn],
      ...(entitiesToRestore.length > 0 ? {
        _entityDataRestore: entitiesToRestore,
        _sweptKnowledgeRefId: knowledgeId,
      } : {}),
    })
    try {
      await axios.delete(`/api/knowledges/${knowledgeId}`)
    } catch (err) {
      // Backend may 404 if the row was already gone — swallow so the
      // local strip still runs and the undo/redo machinery stays
      // symmetric.
      if (err?.response?.status !== 404) throw err
    }
    const patch = _stripReferencesToKnowledge(get(), knowledgeId)
    set({ ...patch, hasUnsavedChanges: true })
    if (entitiesToRestore.length > 0) {
      es._sweepStalePerspectiveTargetsFromEntities(_PERSPECTIVE_KNOWLEDGE_KINDS, knowledgeId)
    }
  },

  /** Set (or remove) an observer's origin awareness level for a Knowledge.
   *  Writes to `knowledge.awareness` dict directly (origin state, not
   *  chain-time). Passing `level=null` strips the observer key; empty
   *  dicts collapse to null. Ignored if the Knowledge's awareness is an
   *  AwarenessRef (refs are all-or-nothing — swapping to dict is a
   *  separate op). */
  setKnowledgeAwarenessOrigin: (knowledgeId, observerEntityId, level, opts = {}) => {
    if (!knowledgeId || !observerEntityId) return
    const k = get().knowledges.find((x) => x.id === knowledgeId)
    if (!k) return
    // AwarenessRef baselines (legacy single-source) are not editable here.
    if (k.awareness && typeof k.awareness === 'object'
      && 'relationship_id' in k.awareness
      && 'level' in k.awareness) return
    const dict = (k.awareness && typeof k.awareness === 'object' && !Array.isArray(k.awareness)) ? { ...k.awareness } : {}
    if (level == null) delete dict[observerEntityId]
    else dict[observerEntityId] = level
    const draft = Object.keys(dict).length > 0 ? dict : null
    return get().commitAwarenessAtAnchor({
      target: { kind: 'knowledge', knowledgeId },
      anchor: { kind: 'origin', nodeId: null },
      draft,
      opts,
    })
  },

  /** Record an observer-awareness mutation on a Knowledge at a specific
   *  chain position. Writes into `knowledge.history.awareness_changes`
   *  with normalised-history invariant: at most one entry per
   *  (observer, node) — re-edit at the same node replaces in place.
   *  Passing `level=null` records an explicit "remove the key" mutation
   *  at that chain position. */
  setKnowledgeAwarenessAtNode: (knowledgeId, observerEntityId, nodeId, level, opts = {}) => {
    if (!knowledgeId || !observerEntityId || !nodeId) return
    const k = get().knowledges.find((x) => x.id === knowledgeId)
    if (!k) return
    // Compute the new effective awareness wrapper at this anchor by
    // taking the chain-resolved prior and overriding one observer.
    //
    // CRITICAL: pass `storyOrder` into both `getKnowledgeNodeOrder`
    // AND the walker's `ctx`. Without storyOrder the wrapper-history
    // walk in `applyAwarenessHistoryToWrapper` skips its per-observer
    // entries entirely (the walk gate at line ~213 requires
    // `ctx?.storyOrder`), so the prior comes back as the baseline
    // `entries` dict only, missing all chain-added observers. The
    // draft is then built from that broken prior, and the downstream
    // `commitAwarenessBatchAtAnchor` (which DOES compute prior with
    // storyOrder correctly) diffs against the incomplete draft and
    // sees prior observers as "missing from draft" — emitting
    // `level: null` clear entries for each one. Net effect: every
    // new observer write also CLEARS every previously-set observer,
    // so only the most-recent observer survives. Surfaced 2026-05-18
    // by the blind-agent rom-com test (`get_knowledge(at=...)`
    // returned only the most-recently-set observer instead of the
    // cumulative map the model promises).
    const storyOrder = computeStoryOrder({ nodes: get().nodes, edges: get().edges })
    const nodeOrder = getKnowledgeNodeOrder(k, get().nodes, get().edges, storyOrder)
    const eff = computeKnowledgeEffectiveState(k, nodeOrder, nodeId, { nodes: get().nodes, ctx: { storyOrder } })
    const priorWrapper = eff?.awareness ?? null
    const dict = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper)
      && !('relationship_id' in priorWrapper && 'level' in priorWrapper))
      ? { ...priorWrapper } : {}
    if (level == null) delete dict[observerEntityId]
    else dict[observerEntityId] = level
    const draft = Object.keys(dict).length > 0 ? dict : null
    return get().commitAwarenessAtAnchor({
      target: { kind: 'knowledge', knowledgeId },
      anchor: { kind: 'chain', nodeId },
      draft,
      opts,
    })
  },

  /** Strip the per-observer awareness-change entry for (observer, node)
   *  on a Knowledge. Used when the user clears an explicit mutation at
   *  a chain position without replacing it. Distinct from writing
   *  `level=null` — this removes the entry entirely, returning the
   *  effective state to whatever it was before this entry was written
   *  (origin or a prior mutation).
   *
   *  Operates on canonical `k.awareness.history` (matches the
   *  observer-set shape: `observer_id === observerEntityId`,
   *  `node_id === nodeId`, no `tracking_action`, no `source_action`).
   *  Mirrors `removeAwarenessHistoryEntry`'s convention of NOT
   *  re-running downstream review-flag propagation post-strip —
   *  review flags are event-based (recorded at edit time), not derived
   *  from current state, so a re-run would stamp flags pointing at
   *  the now-removed entry. The strip also clears any review_flag on
   *  remaining entries whose `sourceNodeId` was the removed entry's
   *  node — those flags were stamped by the now-removed upstream edit
   *  and have no source any more. */
  removeKnowledgeAwarenessAtNode: (knowledgeId, observerEntityId, nodeId) => {
    if (!knowledgeId || !observerEntityId || !nodeId) return
    let mutated = false
    const next = get().knowledges.map((k) => {
      if (k.id !== knowledgeId) return k
      const aw = k.awareness
      if (!aw || typeof aw !== 'object' || Array.isArray(aw)) return k
      const history = Array.isArray(aw.history) ? aw.history : null
      if (!history) return k
      const removed = history.find((e) =>
        e?.observer_id === observerEntityId
        && e?.node_id === nodeId
        && !e?.tracking_action
        && !e?.source_action,
      )
      if (!removed) return k
      const removedNodeId = removed.node_id
      const filtered = history
        .filter((e) => e?.id !== removed.id)
        .map((e) => {
          if (e?.review_flag && e.review_flag.sourceNodeId === removedNodeId) {
            const { review_flag: _review_flag, ...rest } = e
            return rest
          }
          return e
        })
      mutated = true
      return { ...k, awareness: { ...aw, history: filtered } }
    })
    if (!mutated) return
    get()._snapshot()
    set({ knowledges: next, hasUnsavedChanges: true })
  },

  /** Clear the per-entry `review_flag` on a Knowledge awareness chain
   *  entry. Used by the AlertsPanel "Keep" / dismiss button when the
   *  user wants to leave the override in place but silence the
   *  review-flag indicator. The chain entry itself is not removed.
   *
   *  Operates on canonical `k.awareness.history`. The per-observer
   *  entry is identified by `(observer_id, node_id)` because
   *  AlertsPanel dispatches the legacy-shape descriptor for any
   *  Knowledge alert that doesn't carry a canonical
   *  `historyEntryId` (single-host fallback path). */
  clearKnowledgeAwarenessReviewFlag: (knowledgeId, observerEntityId, nodeId) => {
    if (!knowledgeId || !observerEntityId || !nodeId) return
    set({
      knowledges: get().knowledges.map((k) => {
        if (k.id !== knowledgeId) return k
        const aw = k.awareness
        if (!aw || typeof aw !== 'object' || Array.isArray(aw)) return k
        const history = Array.isArray(aw.history) ? aw.history : null
        if (!history) return k
        let changed = false
        const nextHistory = history.map((e) => {
          if (e?.observer_id === observerEntityId && e?.node_id === nodeId && e?.review_flag) {
            changed = true
            const { review_flag: _review_flag, ...rest } = e
            return rest
          }
          return e
        })
        if (!changed) return k
        return { ...k, awareness: { ...aw, history: nextHistory } }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Establish (enable) tracking for this Knowledge at a non-origin chain
   *  anchor. Writes a `tracking_action: 'on'` entry to the Knowledge's
   *  awareness chain (`k.awareness.history`) carrying the user's precision
   *  choice — `awareness_scale` is chain-tracked per anchor for Knowledge.
   *  The library row's `k.awareness_scale` stays untouched
   *  (origin-establishment is a separate path that flips it directly).
   *  `appendAwarenessHistoryEntries` dedups tracking events per node, so
   *  re-toggling at the same anchor replaces in place. */
  enableKnowledgeAwarenessAtNode: (knowledgeId, nodeId, awarenessScale = 'full', opts = {}) => {
    if (!knowledgeId || !nodeId) return
    if (!opts.skipSnapshot) get()._snapshot()
    set({
      knowledges: get().knowledges.map((k) => {
        if (k.id !== knowledgeId) return k
        const trackingEntry = {
          id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          node_id: nodeId,
          observer_id: '',
          level: null,
          source_action: null,
          source: null,
          tracking_action: 'on',
          awareness_scale: awarenessScale,
        }
        const nextAware = appendAwarenessHistoryEntries(k.awareness ?? null, [trackingEntry])
        return {
          ...k,
          awareness: nextAware,
          manual_anchors: (k.manual_anchors || []).filter((a) => a?.node_id !== nodeId),
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Phase 3.4f Item 3 — record an add / remove Project Tag membership
   * mutation on a Knowledge. Routes by `atNodeId`:
   *   - null / falsy → BASELINE write at the Knowledge's origin
   *     (mutates `knowledge.tag_ids`). Used by the Knowledge detail
   *     panel when `atOrigin` is true.
   *   - non-null     → CHAIN event in `knowledge.history.tag_changes`
   *     at that node, with same-node opposite-pair cancellation:
   *       - add@N where remove@N exists for the same tag → strip both
   *       - remove@N where add@N exists for the same tag → strip both
   *     Same-action duplicate is a no-op (writing add@N when add@N
   *     already exists doesn't accumulate). Mirrors the normalised-
   *     history invariant the Entity v0.3.4.24 mount established.
   *
   * `action` must be 'add' or 'remove'. Sets `hasUnsavedChanges`;
   * the next project save flushes both baseline + history changes
   * via the standard PUT /api/story path.
   */
  recordKnowledgeTagChange: (knowledgeId, action, tagId, atNodeId) => {
    if (!knowledgeId || !tagId) return
    if (action !== 'add' && action !== 'remove') return
    // Phase 3.4 Bugs & Fixes — track whether this call's net effect
    // is to REMOVE the tag from this knowledge so the orphan-tag
    // cleanup gate fires at the end. A `'remove'` write at any anchor
    // counts, AND a `'add'` write that pair-cancels an existing
    // `'remove'` at the same node ALSO counts (the pair-cancel
    // restores the prior add state; but the prior add was already
    // counted when it was originally recorded — net effect on host
    // membership is 0). So the trigger is just `action === 'remove'`
    // OR `action === 'add' && opposite event at same anchor exists`,
    // and the cleanup-gate at end checks if no other hosts remain.
    // Cheaper to just call the gate unconditionally on every write —
    // the gate's own early-exit on `remaining > 0` is fast.
    get()._snapshot()
    set({
      knowledges: get().knowledges.map((k) => {
        if (k.id !== knowledgeId) return k

        // Baseline (origin) write — mutate `tag_ids` directly. Same-id
        // duplicate is a no-op (add when present, remove when absent);
        // this mirrors the picker's already-attached short-circuit but
        // is kept as a belt-and-braces guard against a stale UI re-
        // dispatch.
        if (!atNodeId) {
          const baseline = k.tag_ids || []
          if (action === 'add') {
            if (baseline.includes(tagId)) return k
            return { ...k, tag_ids: [...baseline, tagId] }
          }
          // remove
          if (!baseline.includes(tagId)) return k
          return { ...k, tag_ids: baseline.filter((id) => id !== tagId) }
        }

        // Chain event write — apply pair-cancellation + duplicate-drop
        // against the existing `history.tag_changes` entries at this
        // node for this tag.
        const history = k.history || {}
        const events = history.tag_changes || []
        const oppositeAction = action === 'add' ? 'remove' : 'add'
        const oppositeIdx = events.findIndex(
          (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === oppositeAction
        )
        if (oppositeIdx >= 0) {
          // Pair-cancel — strip the existing opposite event, write
          // nothing new. Net effect at this anchor: as if neither
          // event ever happened.
          const next = events.filter((_, i) => i !== oppositeIdx)
          return { ...k, history: { ...history, tag_changes: next } }
        }
        const sameIdx = events.findIndex(
          (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === action
        )
        if (sameIdx >= 0) {
          // Duplicate same-action write — no-op.
          return k
        }
        const newEvent = {
          id: crypto.randomUUID(),
          action,
          tag_id: tagId,
          node_id: atNodeId,
        }
        return { ...k, history: { ...history, tag_changes: [...events, newEvent] } }
      }),
      hasUnsavedChanges: true,
    })
    // Phase 3.4 Bugs & Fixes — orphan-cleanup gate. Fires when no
    // host carries `tagId` after this write; rides on the `_snapshot()`
    // above for atomic Ctrl-Z undo.
    get()._maybeCleanupOrphanedTagInline(tagId)
  },

  /**
   * Anchor-aware record-action for Project Tag membership on an
   * Entity. Mirrors `recordKnowledgeTagChange` /
   * `recordRelationshipTagChange` so all three chain-trackable host
   * kinds share the same `(hostId, action, tagId, atNodeId)`
   * signature instead of forcing callers into the spread-host PUT
   * shim pattern.
   *
   * Routes by `atNodeId`:
   *   - **null / falsy → BASELINE write** on `entity.tag_ids` via the
   *     `entitiesStore.updateEntity` full-body PUT. Async because the
   *     PUT round-trips to the backend (unlike Knowledge /
   *     Relationship which live inside the project payload and flush
   *     on the next /api/story save).
   *   - **non-null → CHAIN event write**, routed by the anchor node's
   *     shape:
   *       - **`sceneNode`** → write into the matching EntityRef's
   *         `tag_changes` on the right bucket within `node.data`.
   *         Caller is responsible for ensuring the entity is chipped
   *         at the scene before calling (the MCP `add_tags` handler
   *         does the auto-add + D2-wire upstream of this action, same
   *         pattern `_appendAliasChainEntries` uses for aliases).
   *       - **modifier `entityNode`** (where
   *         `data.is_modifier && data.entity_id === entityId`) →
   *         write into `node.data.tag_changes` directly.
   *     Both apply the same-node opposite-pair cancellation +
   *     duplicate-drop invariants as the Knowledge / Relationship
   *     equivalents (writing `add@N` against an existing `remove@N`
   *     for the same `tag_id` strips both; duplicate same-action is
   *     a no-op).
   *
   * `action` must be 'add' or 'remove'. Sets `hasUnsavedChanges`
   * (via `updateEntity` for baseline, directly for chain-anchor).
   * Snapshot for undo is taken at action entry.
   */
  recordEntityTagChange: async (entityId, action, tagId, atNodeId) => {
    if (!entityId || !tagId) return
    if (action !== 'add' && action !== 'remove') return
    get()._snapshot()

    // Baseline (origin) write — find the entity across all five
    // buckets in entitiesStore, then PUT the full body with updated
    // tag_ids. Same-id duplicate-on-add / same-id missing-on-remove
    // is a no-op (matches the Knowledge / Relationship equivalents).
    if (!atNodeId) {
      const entitiesState = useEntitiesStore.getState()
      let entity = null
      for (const bk of ENTITY_BUCKETS) {
        const found = (entitiesState[bk] || []).find((e) => e.id === entityId)
        if (found) { entity = found; break }
      }
      if (!entity) return
      const baseline = entity.tag_ids || []
      if (action === 'add') {
        if (baseline.includes(tagId)) return
        await entitiesState.updateEntity(entityId, { ...entity, tag_ids: [...baseline, tagId] })
        return
      }
      // remove
      if (!baseline.includes(tagId)) return
      await entitiesState.updateEntity(entityId, { ...entity, tag_ids: baseline.filter((id) => id !== tagId) })
      // Phase 3.4 Bugs & Fixes — orphan-cleanup gate (entity baseline
      // remove branch).
      get()._maybeCleanupOrphanedTagInline(tagId)
      return
    }

    // Chain anchor write — figure out if atNodeId is a sceneNode
    // (write to EntityRef.tag_changes on the matching bucket) or a
    // modifier EntityNode (write to node.data.tag_changes).
    const nodes = get().nodes || []
    const anchorNode = nodes.find((n) => n.id === atNodeId)
    if (!anchorNode) return

    // Shared transform: pair-cancel against an existing opposite-
    // action event at the same anchor for the same tag; drop dup
    // same-action; else append a fresh event. Returns the new events
    // array, OR `null` as a sentinel meaning "no change needed".
    const transformEvents = (events) => {
      const oppositeAction = action === 'add' ? 'remove' : 'add'
      const oppositeIdx = events.findIndex(
        (ev) => ev?.tag_id === tagId && ev?.action === oppositeAction
      )
      if (oppositeIdx >= 0) {
        return events.filter((_, i) => i !== oppositeIdx)
      }
      const sameIdx = events.findIndex(
        (ev) => ev?.tag_id === tagId && ev?.action === action
      )
      if (sameIdx >= 0) return null
      return [...events, { id: crypto.randomUUID(), action, tag_id: tagId }]
    }

    if (anchorNode.type === 'sceneNode') {
      // Find the EntityRef inside the scene; write to its tag_changes.
      let touched = false
      const updatedNodes = nodes.map((n) => {
        if (n.id !== atNodeId || n.type !== 'sceneNode') return n
        const newData = { ...n.data }
        for (const bucket of ENTITY_BUCKETS) {
          const refs = newData[bucket] || []
          const idx = refs.findIndex((r) => r.entity_id === entityId)
          if (idx === -1) continue
          const existing = refs[idx].tag_changes || []
          const next = transformEvents(existing)
          if (next === null) return n  // no-op
          newData[bucket] = refs.map((r, i) => i === idx ? { ...r, tag_changes: next } : r)
          touched = true
          return { ...n, data: newData }
        }
        return n  // entity not chipped at this scene — caller must add first
      })
      if (touched) {
        set({ nodes: updatedNodes, hasUnsavedChanges: true })
        // Phase 3.4 Bugs & Fixes — orphan-cleanup gate (scene-anchor
        // EntityRef write branch). Fires whether `action` was 'remove'
        // OR 'add' (pair-cancel of an existing 'remove' can also alter
        // the entity's effective ever-tagged set).
        get()._maybeCleanupOrphanedTagInline(tagId)
      }
      return
    }

    if (anchorNode.type === 'entityNode'
      && anchorNode.data?.is_modifier
      && anchorNode.data?.entity_id === entityId) {
      const existing = anchorNode.data?.tag_changes || []
      const next = transformEvents(existing)
      if (next === null) return
      const updatedNodes = nodes.map((n) =>
        n.id !== atNodeId ? n : { ...n, data: { ...n.data, tag_changes: next } }
      )
      set({ nodes: updatedNodes, hasUnsavedChanges: true })
      // Phase 3.4 Bugs & Fixes — orphan-cleanup gate (modifier
      // EntityNode write branch).
      get()._maybeCleanupOrphanedTagInline(tagId)
      return
    }

    // Anchor doesn't match a known shape — silent no-op with warn.
     
    console.warn(
      `recordEntityTagChange: atNodeId ${atNodeId} is not a sceneNode (with entity ${entityId} chipped) ` +
      `or a matching modifier EntityNode. No write performed.`
    )
  },

  /** Record a content mutation on a Knowledge at a chain position.
   *  `field` is 'name' | 'description' | 'colour' | 'profile_image'.
   *  At most one entry per (field, node) — re-edit at the same node
   *  replaces in place. */
  setKnowledgeContentChangeAtNode: (knowledgeId, field, nodeId, newValue) => {
    if (!knowledgeId || !nodeId) return
    const listKey = field === 'name' ? 'name_changes'
      : field === 'description' ? 'description_changes'
      : field === 'colour' ? 'colour_changes'
      : field === 'profile_image' ? 'profile_image_changes'
      : null
    if (!listKey) return
    const valueKey = field === 'profile_image' ? 'new_profile_image_ref' : 'new_' + field
    get()._snapshot()
    // Capture old chain-resolved value for the rollover modal's
    // "Was: <old> → Now: <new>" reminder line.
    let oldValue = null
    try {
      const k0 = get().knowledges.find((kk) => kk.id === knowledgeId)
      if (k0) {
        // Pass storyOrder through so the chain walk applies entries
        // in story order. Without it, nodeOrder degrades to insertion
        // order which mis-orders cross-scene history entries — the
        // same root cause as the awareness bug fixed in
        // setKnowledgeAwarenessAtNode below.
        const storyOrder = computeStoryOrder({ nodes: get().nodes, edges: get().edges })
        const nodeOrder = getKnowledgeNodeOrder(k0, get().nodes, get().edges, storyOrder)
        const eff0 = computeKnowledgeEffectiveState(k0, nodeOrder, nodeId, { nodes: get().nodes, ctx: { storyOrder } })
        oldValue = (field === 'profile_image' ? eff0?.profile_image_ref : eff0?.[field]) ?? null
      }
    } catch { /* ignore */ }
    set({
      knowledges: get().knowledges.map((k) => {
        if (k.id !== knowledgeId) return k
        const history = k.history || {}
        const existing = history[listKey] || []
        const filtered = existing.filter((c) => c.node_id !== nodeId)
        const newEntry = {
          id: crypto.randomUUID(),
          node_id: nodeId,
          [valueKey]: newValue,
          source_event: null,
        }
        return {
          ...k,
          // Auto-upgrade: a real history entry lands at this node, so any
          // manual anchor at the same node is now redundant.
          manual_anchors: (k.manual_anchors || []).filter((a) => a?.node_id !== nodeId),
          history: { ...history, [listKey]: [...filtered, newEntry] },
        }
      }),
      hasUnsavedChanges: true,
    })
    // Awareness-rollover modal — chain-anchor knowledge content change.
    // Only fire for the three content fields that have an awareness
    // surface attached (name / description / colour). profile_image is
    // author-meta and isn't tracked.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false && field !== 'profile_image') {
        const updatedK = get().knowledges.find((kk) => kk.id === knowledgeId)
        if (updatedK) {
          const nodeOrder = getKnowledgeNodeOrder(updatedK, get().nodes, get().edges)
          const storyOrder = computeStoryOrder({ nodes: get().nodes, edges: get().edges })
          const eff = computeKnowledgeEffectiveState(updatedK, nodeOrder, nodeId, { nodes: get().nodes, ctx: { storyOrder } })
          const priorWrapper = eff?.awareness ?? null
          const entries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
            ? (priorWrapper.entries ?? (Object.prototype.hasOwnProperty.call(priorWrapper, 'entries') ? {} : priorWrapper))
            : {}
          if (priorWrapper != null && Object.keys(entries).length > 0) {
            const labelByField = { name: 'Name', description: 'Description', colour: 'Colour' }
            useUiStore.getState().openAwarenessRolloverModal({
              pages: [{
                fieldLabel: labelByField[field] || field,
                target: { kind: 'knowledge', knowledgeId },
                anchor: { kind: 'chain', nodeId },
                priorWrapper,
                draft: priorWrapper,
                oldValue,
                newValue,
              }],
              currentPageIdx: 0,
            })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }
    // Phase 2.5g follow-up — if the write was on profile_image and
    // landed null/empty against a null-like inherited value, strip
    // it (and any downstream redundant siblings).
    if (field === 'profile_image') {
      get()._sweepRedundantNullProfileImageEntries({ knowledgeId })
    }
  },

  /** Strip any existing content-mutation entry for a Knowledge at a chain
   *  position (revert-to-inherited). `field` is 'name' | 'description' |
   *  'colour' | 'profile_image'. No-op if there's no entry at (field, node). */
  removeKnowledgeContentChangeAtNode: (knowledgeId, field, nodeId) => {
    if (!knowledgeId || !nodeId) return
    const listKey = field === 'name' ? 'name_changes'
      : field === 'description' ? 'description_changes'
      : field === 'colour' ? 'colour_changes'
      : field === 'profile_image' ? 'profile_image_changes'
      : null
    if (!listKey) return
    get()._snapshot()
    set({
      knowledges: get().knowledges.map((k) => {
        if (k.id !== knowledgeId) return k
        const history = k.history || {}
        const existing = history[listKey] || []
        const filtered = existing.filter((c) => c.node_id !== nodeId)
        if (filtered.length === existing.length) return k
        return {
          ...k,
          history: { ...history, [listKey]: filtered },
        }
      }),
      hasUnsavedChanges: true,
    })
    // Phase 2.5g follow-up — removing one anchor's profile_image
    // entry can leave further downstream entries redundant.
    if (field === 'profile_image') {
      get()._sweepRedundantNullProfileImageEntries({ knowledgeId })
    }
  },

  /** Attach a chain-tracked rebinding of a Knowledge's `source_event`
   *  back-pointer at a chain anchor (Path B of the "Add knowledge of
   *  this change" flow). Appends-or-replaces an entry in
   *  `knowledge.history.source_event_changes` for the given node so
   *  the Knowledge from this anchor forward represents the supplied
   *  triggering change. At-most-one entry per node — re-attaching at
   *  the same scene replaces the existing rebinding in place.
   *
   *  Pass `sourceEvent: null` to explicitly decouple at this anchor.
   *
   *  Args:
   *    knowledgeId  — target Knowledge.
   *    sourceEvent  — SourceEventRef or null.
   *    nodeId       — chain anchor (typically the trigger change's scene).
   */
  attachKnowledgeSourceEvent: (knowledgeId, sourceEvent, nodeId) => {
    if (!knowledgeId || !nodeId) return
    const k = (get().knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return
    get()._snapshot()
    const existing = k.history?.source_event_changes || []
    const filtered = existing.filter((c) => c?.node_id !== nodeId)
    const newEntry = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      node_id: nodeId,
      new_source_event: sourceEvent ?? null,
    }
    set({
      knowledges: get().knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        return {
          ...kk,
          // Auto-upgrade: a real history entry lands at this node, so
          // any prior manual_anchor at the same node is now redundant.
          manual_anchors: (kk.manual_anchors || []).filter((a) => a?.node_id !== nodeId),
          history: { ...(kk.history || {}), source_event_changes: [...filtered, newEntry] },
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Phase 1.21c — pin a Knowledge to a scene without recording any
   *  chain-history change there. Mirrors `Relationship.manual_anchors`.
   *  Idempotent: no-op if the (knowledgeId, nodeId) anchor already exists. */
  addKnowledgeManualAnchor: (knowledgeId, nodeId) => {
    if (!knowledgeId || !nodeId) return
    const k = (get().knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return
    const existing = Array.isArray(k.manual_anchors) ? k.manual_anchors : []
    if (existing.some((a) => a?.node_id === nodeId)) return
    get()._snapshot()
    set({
      knowledges: get().knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        return {
          ...kk,
          manual_anchors: [...(kk.manual_anchors || []), { node_id: nodeId }],
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Phase 1.21c Tier 3 — strip every reference to a Knowledge that
   *  contributes to the chip rendering at a given scene: manual anchor at
   *  the scene + every history entry (existence / awareness / name /
   *  description / colour / profile_image change) whose `node_id` is the
   *  scene id. Single snapshot for unified undo. After this runs the
   *  Knowledge chip vanishes from that scene. If the stripped entries
   *  included the only `existence_changes: activate` event AND the
   *  Knowledge has no origin node, the Knowledge becomes anchorless
   *  (library row reverts to "no anchor"). */
  removeKnowledgeReferencesAtScene: (knowledgeId, sceneNodeId) => {
    if (!knowledgeId || !sceneNodeId) return
    const state = get()
    const k = (state.knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return
    state._snapshot()
    const filterAtNode = (list) =>
      Array.isArray(list) ? list.filter((c) => c?.node_id !== sceneNodeId) : []
    const oldHistory = k.history || {}
    set({
      knowledges: state.knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        return {
          ...kk,
          manual_anchors: (kk.manual_anchors || []).filter(
            (a) => a?.node_id !== sceneNodeId,
          ),
          history: {
            ...oldHistory,
            existence_changes:     filterAtNode(oldHistory.existence_changes),
            name_changes:          filterAtNode(oldHistory.name_changes),
            description_changes:   filterAtNode(oldHistory.description_changes),
            colour_changes:        filterAtNode(oldHistory.colour_changes),
            profile_image_changes: filterAtNode(oldHistory.profile_image_changes),
            source_event_changes:  filterAtNode(oldHistory.source_event_changes),
          },
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Phase 1.21c Tier 2 — Demote a Knowledge from event-precision to
   *  scene-precision. Idempotent: ensure `existence_changes` carries an
   *  `activate@source_event.node_id` entry (add only if missing), then
   *  null `Knowledge.source_event`. The chip stays anchored at the same
   *  scene because the existence-event carries the scene-anchor
   *  independently of the (now severed) source-event tie. Used by the
   *  Detach branch of the cleanup-cascade prompt. Takes its own snapshot
   *  when called standalone; pass `{ skipSnapshot: true }` when calling
   *  from inside another action that already snapshotted. */
  detachKnowledgeFromOriginEvent: (knowledgeId, opts = {}) => {
    if (!knowledgeId) return
    const state = get()
    const k = (state.knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return
    if (!k.source_event) return  // already detached
    const sceneId = k.source_event.node_id
    if (!opts.skipSnapshot) state._snapshot()
    set({
      knowledges: state.knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        const history = kk.history || {}
        const existing = history.existence_changes || []
        const hasActivateAtScene = sceneId && existing.some(
          (c) => c?.action === 'activate' && c?.node_id === sceneId,
        )
        const newExistence = (sceneId && !hasActivateAtScene)
          ? [
              ...existing,
              { id: crypto.randomUUID(), node_id: sceneId, action: 'activate', source_event: null },
            ]
          : existing
        return {
          ...kk,
          source_event: null,
          history: { ...history, existence_changes: newExistence },
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /** Phase 1.21c Tier 2 — Scan all Knowledges for any whose
   *  `source_event.change_id` (origin) OR `history.*_changes[i].source_event.change_id`
   *  (downstream) matches one of the supplied removed-event change ids.
   *  Returns `{ origin: [...], downstream: [...] }`. Pure read — no state
   *  mutation. Used by the cleanup-cascade orchestrator. */
  _findKnowledgesAffectedByEventRemoval: (removedChangeIds) => {
    const idSet = removedChangeIds instanceof Set ? removedChangeIds : new Set(removedChangeIds || [])
    if (idSet.size === 0) return { origin: [], downstream: [] }
    const origin = []
    const downstream = []
    const HISTORY_LISTS = ['existence_changes', 'name_changes', 'description_changes', 'colour_changes', 'profile_image_changes']
    for (const k of (get().knowledges || [])) {
      const oid = k.source_event?.change_id
      if (oid && idSet.has(oid)) origin.push({ knowledgeId: k.id, changeId: oid })
      const history = k.history || {}
      for (const listKey of HISTORY_LISTS) {
        for (const entry of (history[listKey] || [])) {
          const eid = entry?.source_event?.change_id
          if (eid && idSet.has(eid)) {
            downstream.push({ knowledgeId: k.id, listKey, entryId: entry.id, changeId: eid })
          }
        }
      }
      // Canonical awareness history (k.awareness.history). Knowledge
      // awareness mutations carry their Knowledge-attachment back-pointer
      // on `AwarenessHistoryEntry.source_event`. Sentinel listKey
      // `awareness.history` (with the dot) keys the strip step in
      // `_runEventRemovalCascade`.
      const awarenessHistory = (k.awareness && typeof k.awareness === 'object' && !Array.isArray(k.awareness))
        ? (k.awareness.history || [])
        : []
      for (const entry of awarenessHistory) {
        const eid = entry?.source_event?.change_id
        if (eid && idSet.has(eid)) {
          downstream.push({ knowledgeId: k.id, listKey: 'awareness.history', entryId: entry.id, changeId: eid })
        }
      }
    }
    return { origin, downstream }
  },

  /** Phase 1.21c Tier 2 — Cleanup cascade orchestrator. Called from
   *  every store action that removes a chain-tracked event (array-based
   *  change entry OR scalar EntityRef / EntityNode field nulled). Two
   *  concurrent behaviours:
   *    - **Downstream history strip**: any Knowledge.history.X_changes[i]
   *      whose source_event.change_id matches one of `removedChangeIds`
   *      is silently dropped. Atomic with the calling action's snapshot
   *      (no separate undo step).
   *    - **Origin-event prompt**: if any Knowledge.source_event.change_id
   *      matches a removed id, opens a Delete / Detach / Cancel prompt.
   *      Cancel calls `undo()` to revert the calling action. Delete
   *      cascade-deletes via `deleteObject('knowledge', id)`. Detach
   *      calls `detachKnowledgeFromOriginEvent` for each affected Knowledge.
   *  Fire-and-forget — calling actions don't await this; the prompt
   *  appears asynchronously. The calling action MUST have taken a
   *  snapshot before its own mutations so a Cancel-undo reverts cleanly.
   *  No-op when nothing matches (the cheap common case). */
  _runEventRemovalCascade: async (removedChangeIds) => {
    const idSet = removedChangeIds instanceof Set ? removedChangeIds : new Set(removedChangeIds || [])
    if (idSet.size === 0) return
    const { origin, downstream } = get()._findKnowledgesAffectedByEventRemoval(idSet)
    if (origin.length === 0 && downstream.length === 0) return

    // Silent downstream strip — runs synchronously in the same React
    // tick as the calling action's mutations so the existing snapshot
    // covers both.
    if (downstream.length > 0) {
      const downstreamByKnowledge = new Map()
      for (const d of downstream) {
        if (!downstreamByKnowledge.has(d.knowledgeId)) downstreamByKnowledge.set(d.knowledgeId, [])
        downstreamByKnowledge.get(d.knowledgeId).push(d)
      }
      set({
        knowledges: get().knowledges.map((k) => {
          const ds = downstreamByKnowledge.get(k.id)
          if (!ds || ds.length === 0) return k
          const history = { ...(k.history || {}) }
          // Canonical-awareness-history entries strip from `k.awareness.history`
          // (sentinel listKey `awareness.history`); legacy-history entries
          // strip from `k.history[listKey]`. Both kinds may appear in the
          // same batch when an event removal hits both shapes.
          let nextAwareness = k.awareness
          let awarenessChanged = false
          for (const d of ds) {
            if (d.listKey === 'awareness.history') {
              if (nextAwareness && typeof nextAwareness === 'object' && !Array.isArray(nextAwareness)) {
                const filtered = (nextAwareness.history || []).filter((e) => e?.id !== d.entryId)
                nextAwareness = { ...nextAwareness, history: filtered }
                awarenessChanged = true
              }
            } else {
              history[d.listKey] = (history[d.listKey] || []).filter((e) => e?.id !== d.entryId)
            }
          }
          return awarenessChanged
            ? { ...k, history, awareness: nextAwareness }
            : { ...k, history }
        }),
        hasUnsavedChanges: true,
      })
    }

    if (origin.length === 0) return

    // Origin-event prompt. Resolve current Knowledge names for the
    // message body (the user knows their Knowledges by name, not id).
    const liveKnowledges = get().knowledges
    const namedOrigin = origin
      .map((o) => liveKnowledges.find((k) => k.id === o.knowledgeId))
      .filter(Boolean)
    if (namedOrigin.length === 0) return  // all already gone — nothing to prompt

    // MCP-active short-circuit: when an MCP agent is the active session
    // driver, the UI modal can't surface to them (the modal awaits
    // human input on the canvas; the agent's tool call would return
    // before the user clicks anything). Auto-choose 'detach' as the
    // safe default — it preserves the Knowledge (no destructive
    // delete) and re-anchors it at the same scene via an activate
    // existence event, so the Knowledge transitions from "scene-born-
    // from-this-event" to "scene-anchored-at-this-scene" without
    // losing the writer's content. Without this short-circuit, the
    // Knowledge keeps a `source_event.change_id` pointer at the
    // stripped chain entry — silently dangling. Surfaced 2026-05-18
    // by the freeform v8 blind-agent test (recipe: track_as_knowledge
    // creates K bound to change X1 → pair-cancel strips X1 → re-apply
    // creates new change X2 → K.source_event still points at the
    // gone-X1, never re-binds). Bug #1 (separate ToDo) adds an
    // `on_knowledge_orphan` arg that lets the agent override this
    // default with 'delete' or explicit 'detach' / 'cancel'; this
    // commit just makes 'detach' the implicit default when MCP is
    // driving so no dangling pointer is ever left behind.
    const isMcpActive = useMcpControlStore.getState().sessionState === 'active'
    const choice = isMcpActive
      ? 'detach'
      : await confirm({
          title: 'Knowledge attached to removed event',
          message: namedOrigin.length === 1
            ? `The Knowledge "${namedOrigin[0].name || '(unnamed)'}" was created by the event you just removed. Choose what to do with it.`
            : `${namedOrigin.length} Knowledges were created by events you just removed. Choose what to do (the same choice applies to all).`,
          buttons: [
            { label: 'Delete', value: 'delete', style: 'danger' },
            { label: 'Detach', value: 'detach', style: 'default' },
            { label: 'Cancel', value: 'cancel', style: 'default' },
          ],
        })

    if (choice === 'cancel') {
      get().undo()
      return
    }

    if (choice === 'delete') {
      // Sequential delete via the dispatcher so each axios.delete
      // round-trip and reference strip happens cleanly. Each call
      // snapshots, so each Knowledge delete is its own undo step (the
      // event removal is the previous step). Acceptable: the user
      // explicitly chose Delete after a prompt, so multi-step undo is
      // expected.
      for (const o of origin) {
        const stillThere = get().knowledges.some((k) => k.id === o.knowledgeId)
        if (stillThere) await get().deleteObject('knowledge', o.knowledgeId)
      }
      return
    }

    if (choice === 'detach') {
      // Capture the pre-detach scene id per affected Knowledge BEFORE
      // the detach nulls source_event. The cascade's `origin` entries
      // only carry `{knowledgeId, changeId}` — the scene lives on
      // `k.source_event.node_id` which gets cleared by the detach
      // mutation below. The MCP warning surface (further down) reads
      // this map to build a self-describing message with the scene
      // title.
      const preDetachSceneByKId = new Map()
      for (const o of origin) {
        const preK = liveKnowledges.find((x) => x.id === o.knowledgeId)
        const sId = preK?.source_event?.node_id || null
        if (sId) preDetachSceneByKId.set(o.knowledgeId, sId)
      }
      // Single batched mutation — one undo step for "detach all
      // affected Knowledges". The event removal is the previous step.
      get()._snapshot()
      set({
        knowledges: get().knowledges.map((k) => {
          const m = origin.find((o) => o.knowledgeId === k.id)
          if (!m) return k
          if (!k.source_event) return k
          const sceneId = k.source_event.node_id
          const history = k.history || {}
          const existing = history.existence_changes || []
          const hasActivateAtScene = sceneId && existing.some(
            (c) => c?.action === 'activate' && c?.node_id === sceneId,
          )
          const newExistence = (sceneId && !hasActivateAtScene)
            ? [
                ...existing,
                { id: crypto.randomUUID(), node_id: sceneId, action: 'activate', source_event: null },
              ]
            : existing
          return {
            ...k,
            source_event: null,
            history: { ...history, existence_changes: newExistence },
          }
        }),
        hasUnsavedChanges: true,
      })
      // MCP back-channel: when the detach happened on the MCP-active
      // auto-route (not via the user dialog), record each detached
      // Knowledge in the per-call warning buffer. The bridge consumes
      // this buffer after the tool handler returns and merges the
      // list into the response so the calling agent sees which
      // Knowledges got auto-detached and can decide whether to follow
      // up with `delete_knowledge`. No-op on the UI path (user
      // explicitly chose detach via the dialog; no agent to inform).
      if (isMcpActive) {
        const nodes = get().nodes || []
        const postKnowledges = get().knowledges
        for (const o of origin) {
          const k = postKnowledges.find((x) => x.id === o.knowledgeId)
          if (!k) continue
          const sceneId = preDetachSceneByKId.get(o.knowledgeId) || null
          const sceneNode = sceneId ? nodes.find((n) => n.id === sceneId) : null
          const sceneTitle = sceneNode?.data?.title || ''
          const kName = k.name || ''
          useMcpControlStore.getState()._recordMcpOrphanDetach({
            knowledge_id: k.id,
            knowledge_name: kName,
            scene_id: sceneId,
            scene_title: sceneTitle,
            message: (
              `Knowledge "${kName || '(unnamed)'}" was created by the chain event you just removed; ` +
              `auto-detached and re-anchored at scene "${sceneTitle || sceneId || '(unknown)'}" via an ` +
              `activate event. The Knowledge still exists. Call delete_knowledge(knowledge='${k.id}') ` +
              `if you wanted it removed entirely instead.`
            ),
          })
        }
      }
    }
  },

  /** Phase 1.21c — release a Knowledge's manual anchor at a scene. The
   *  Knowledge chip on that scene also disappears IF there are no history
   *  entries at the same node (the chip's auto-lifecycle covers both
   *  conditions). No-op if no anchor exists for (knowledgeId, nodeId). */
  removeKnowledgeManualAnchor: (knowledgeId, nodeId) => {
    if (!knowledgeId || !nodeId) return
    const k = (get().knowledges || []).find((x) => x.id === knowledgeId)
    if (!k) return
    const existing = Array.isArray(k.manual_anchors) ? k.manual_anchors : []
    if (!existing.some((a) => a?.node_id === nodeId)) return
    get()._snapshot()
    set({
      knowledges: get().knowledges.map((kk) => {
        if (kk.id !== knowledgeId) return kk
        return {
          ...kk,
          manual_anchors: (kk.manual_anchors || []).filter((a) => a?.node_id !== nodeId),
        }
      }),
      hasUnsavedChanges: true,
    })
  },

  /**
   * Create a relationship whose birth point is a freshly-spawned rel origin
   * node, with every participant's entity origin auto-wired into it. Used by
   * the "+ Add Relationship" flow on an Entity Detail Panel when the panel
   * is showing an entity at its origin node — the sibling flow to the
   * onConnect entity-origin-to-entity-origin wiring, just triggered from
   * the sidebar instead of by dragging a wire.
   *
   * Args:
   *   - ownerEntityId:     the entity the detail panel is showing
   *   - partnerEntityIds:  additional participants selected in the picker
   *   - name:              optional custom relationship name
   *
   * Steps (mirrors `onConnect` Phase C):
   *   1. Resolve each participant's canvas origin node; bail if any is
   *      missing (library-only entity — can't auto-wire without a canvas
   *      anchor).
   *   2. Compute a midpoint position for the rel origin node based on the
   *      participant origins' centroid, offset +80 / +40 per the existing
   *      convention so it doesn't overlap any single origin node.
   *   3. Allocate rel id + origin node id up front, seed the origin node
   *      into local state so wiring has a stable target.
   *   4. Create the relationship with `join@originNodeId` events for every
   *      participant.
   *   5. Wire each entity origin to the rel origin via the canonical
   *      `ensureRelationshipOriginWire` action.
   *   6. Open the Relationship Detail Panel at the new origin.
   */
  createRelationshipViaEntityOrigin: async (ownerEntityId, partnerEntityIds, name) => {
    const allIds = Array.from(new Set([ownerEntityId, ...(partnerEntityIds || [])])).filter(Boolean)
    if (allIds.length < 2) return null
    const stateNodes = get().nodes
    const originNodes = allIds.map((eid) =>
      stateNodes.find((n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === eid)
    )
    if (originNodes.some((n) => !n)) return null

    const avgX = originNodes.reduce((sum, n) => sum + (n.position?.x || 0), 0) / originNodes.length
    const avgY = originNodes.reduce((sum, n) => sum + (n.position?.y || 0), 0) / originNodes.length
    const originPos = { x: avgX + 80, y: avgY + 40 }

    const relId = crypto.randomUUID()
    const originNodeId = crypto.randomUUID()

    get()._snapshot()
    set({
      nodes: [
        ...get().nodes,
        {
          id: originNodeId,
          type: 'relationshipOriginNode',
          position: originPos,
          zIndex: 1000,
          data: {
            id: originNodeId,
            node_type: 'relationship_origin',
            relationship_id: relId,
            position: originPos,
          },
        },
      ],
      hasUnsavedChanges: true,
    })

    const rel = await get().createRelationship({
      id: relId,
      name: name || null,
      history: {
        ...createEmptyRelationshipHistory(),
        participant_changes: allIds.map((eid) => ({
          node_id: originNodeId,
          action: 'join',
          entity_id: eid,
          initial_perception: '',
          initial_alias_override: null,
        })),
      },
    })
    if (!rel) return null

    for (const eid of allIds) {
      get().ensureRelationshipOriginWire(eid, rel.id, originNodeId)
    }

    useUiStore.getState().openRelationshipDetail(rel.id, originNodeId)
    return rel
  },

  /**
   * Ensure a relationship-origin wire exists running from an entity's canvas
   * origin node into a relationship origin node. Idempotent — silently no-ops
   * when the wire already exists or when the entity has no canvas origin
   * (library-only). Used by `onConnect`'s entity-origin→entity-origin
   * auto-create flow AND by the drag-entity-onto-rel-origin-node gesture
   * (`RelationshipOriginNode.jsx`) which previously reached into
   * `useProjectStore.setState` directly and bypassed the store-action layer.
   */
  ensureRelationshipOriginWire: (entityId, relationshipId, relOriginNodeId) => {
    const { nodes, edges } = get()
    const entityOrigin = nodes.find(
      (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId
    )
    if (!entityOrigin) return
    const wireExists = edges.some(
      (e) =>
        e.source === entityOrigin.id &&
        e.target === relOriginNodeId &&
        e.data?.relationship_id === relationshipId
    )
    if (wireExists) return
    const newEdge = {
      id: `rel-origin-wire-${relationshipId}-${entityId}`,
      source: entityOrigin.id,
      target: relOriginNodeId,
      type: 'relationshipEdge',
      data: {
        is_relationship: true,
        relationship_id: relationshipId,
        source_entity_id: entityId,
        source_node_id: entityOrigin.id,
        target_node_id: relOriginNodeId,
      },
    }
    set({ edges: [...edges, newEdge], hasUnsavedChanges: true })
  },

  /**
   * Sync the persistent origin wire for a (entity, relationship) pair so
   * its presence matches the relationship's current history state. Called
   * from `addParticipant` / `removeParticipant` after the rel is updated,
   * so every participant-mutating path keeps the on-canvas wire aligned
   * with the canonical history truth.
   *
   * Origin-context geometry:
   *   - Regular rels: wire connects the entity's origin EntityNode →
   *     the rel's RelationshipOriginNode.
   *   - Faction membership rels (`rel.membership_of` set): wire connects
   *     the entity's origin EntityNode → the faction's origin EntityNode,
   *     with target handle `rel-in-{relId}` (the faction-membership chip).
   *
   * Sync rule: the entity has an origin wire IFF the rel.history.participant_changes
   * contains a `join@<origin-context-node>` entry for this entity. If yes
   * and no wire exists → create. If no and a wire exists → remove. Else
   * no-op. At-scene join events have no persistent wire (per the design:
   * scene-level wires are creation gestures only) and are ignored here.
   *
   * Idempotent. No-ops cleanly when:
   *   - the entity has no canvas origin (library-only entity)
   *   - the rel has no origin context (born inside a scene, neither
   *     a rel-origin-node nor a faction membership)
   *   - the wire's presence already matches the desired state
   */
  _syncOriginWireForRel: (entityId, rel) => {
    if (!rel || !entityId) return
    const { nodes, edges } = get()
    const entityOrigin = nodes.find(
      (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId,
    )
    if (!entityOrigin) return

    // Resolve the origin-context node and the wire shape it requires.
    let originNode = null
    let edgeId = null
    let targetHandle = null
    if (rel.membership_of) {
      originNode = nodes.find(
        (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === rel.membership_of,
      )
      if (originNode) {
        targetHandle = `rel-in-${rel.id}`
        edgeId = `rel-wire-${rel.id}-${entityId}`
      }
    } else {
      originNode = nodes.find(
        (n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === rel.id,
      )
      if (originNode) {
        edgeId = `rel-origin-wire-${rel.id}-${entityId}`
      }
    }
    if (!originNode) return

    // Does the entity have a join event anchored at the origin context?
    const hasOriginJoin = (rel.history?.participant_changes || []).some(
      (c) => c?.action === 'join' && c?.entity_id === entityId && c?.node_id === originNode.id,
    )

    // Locate any existing origin wire for this (entity, rel) pair —
    // matched by source/target geometry plus the relationship_id payload,
    // not by edgeId (so a wire created by a different code path with a
    // collision-equivalent id is still found and reconciled).
    const existingIdx = edges.findIndex(
      (e) => e.source === entityOrigin.id
          && e.target === originNode.id
          && e.data?.relationship_id === rel.id,
    )

    if (hasOriginJoin && existingIdx === -1) {
      const newEdge = {
        id: edgeId,
        source: entityOrigin.id,
        target: originNode.id,
        ...(targetHandle ? { targetHandle } : {}),
        type: 'relationshipEdge',
        data: {
          is_relationship: true,
          relationship_id: rel.id,
          source_entity_id: entityId,
          source_node_id: entityOrigin.id,
          target_node_id: originNode.id,
          ...(targetHandle ? { target_handle_id: targetHandle } : {}),
        },
      }
      set({ edges: [...edges, newEdge], hasUnsavedChanges: true })
    } else if (!hasOriginJoin && existingIdx >= 0) {
      const filtered = edges.filter((_, i) => i !== existingIdx)
      set({ edges: filtered, hasUnsavedChanges: true })
    }
  },

  /**
   * Add an entity as a participant of a relationship AT a scene node AND ensure
   * the entity's chip is present in that scene, as a single undoable unit.
   * Used by the "drag entity onto rel chip in scene" gesture where both
   * actions must happen atomically — the entity joins the rel at that scene
   * AND is added as a scene participant so the chip renders locally.
   *
   * Calls `addParticipant` first (which snapshots + updates the rel). Then
   * mutates `nodes` to add the chip without a second snapshot, so undo
   * rolls back both in one step. Idempotent: noop join + already-present
   * chip = full noop.
   */
  addEntityAsParticipantAtScene: async (relId, entityId, sceneNodeId) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const entity = useEntitiesStore.getState().getEntityById(entityId)
    if (!entity) return
    const sceneNode = get().nodes.find((n) => n.id === sceneNodeId)
    if (!sceneNode || sceneNode.type !== 'sceneNode') return

    // addParticipant handles its own snapshot + noop check; returns the
    // updated rel (or the original on noop).
    await get().addParticipant(relId, entityId, sceneNodeId)

    // Then add the chip without a second snapshot — the one taken inside
    // addParticipant (or the one we take below if addParticipant no-op'd)
    // covers both changes.
    const current = get().nodes
    const updNodes = addOrphanedChipToNode(current, sceneNodeId, entity)
    if (updNodes !== current) {
      // If addParticipant noop'd (no snapshot taken inside), snapshot here
      // so the chip-only add remains undoable. The helper returns the
      // original nodes array identity on noop, so this branch only fires
      // when a chip was actually added.
      const participantJoinExists = (rel.history?.participant_changes || []).some(
        (c) => c.action === 'join' && c.entity_id === entityId && c.node_id === sceneNodeId
      )
      if (participantJoinExists) get()._snapshot()
      set({ nodes: updNodes, hasUnsavedChanges: true })
    }
  },

  /**
   * Add a manual-anchor entry that pins the relationship's chip to a given
   * scene regardless of ambient-participant-presence. Companion to the
   * drag-relationship-from-library-to-scene UX: the chip renders at this
   * scene so the user can navigate there via the Rel Detail Panel and
   * record changes even when not all participants are present.
   *
   * Idempotent:
   *   - no-op if the relationship already has a manual_anchor for this node
   *   - no-op if the relationship already has ANY history event at this node
   *     (the chip is already rendering — no need for a duplicate anchor)
   *   - no-op if the scene is ambient for this rel (all participants present)
   *     — caller is expected to pre-check or accept the no-op silently
   */
  addManualAnchor: async (relId, nodeId) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel || !nodeId) return
    const history = rel.history || {}
    // Duplicate anchor at this node
    if ((history.manual_anchors || []).some((a) => a.node_id === nodeId)) return
    // Already have any history event at this node → chip already renders; skip
    for (const list of Object.values(history)) {
      if (!Array.isArray(list)) continue
      if (list.some((entry) => entry?.node_id === nodeId)) return
    }
    get()._snapshot()
    const updated = {
      ...rel,
      history: {
        ...history,
        manual_anchors: [...(history.manual_anchors || []), { node_id: nodeId }],
      },
    }
    return get().updateRelationship(relId, updated)
  },

  setRelationshipName: async (relId, name, atNodeId = null) => {
    get()._snapshot()
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const oldName = rel.name
    if (!atNodeId) {
      return get().updateRelationship(relId, { ...rel, name: name || null })
    }
    // Phase 1.21h Fix #3 — use the explicit creation anchor (or the
    // back-compat heuristic for pre-1.21h saves) rather than re-running
    // a creation-node heuristic inline.
    const creationNodeId = getRelationshipCreationNodeId(rel, get().nodes, atNodeId)
    if (creationNodeId === atNodeId) {
      return get().updateRelationship(relId, { ...rel, name: name || null })
    }
    const nameChange = { node_id: atNodeId, new_name: name || null }
    const existingIdx = (rel.history?.name_changes || []).findIndex((c) => c.node_id === atNodeId)
    let updNameChanges
    if (existingIdx >= 0) {
      updNameChanges = (rel.history.name_changes).map((c, i) => i === existingIdx ? nameChange : c)
    } else {
      updNameChanges = [...(rel.history?.name_changes || []), nameChange]
    }
    const updHistory = { ...rel.history, name_changes: updNameChanges }
    const result = await get().updateRelationship(relId, { ...rel, history: updHistory })
    // Awareness-rollover modal — chain-anchor name change on a
    // tracked relationship. Build a single-page rollover when the
    // relationship's awareness layer is on with at least one observer.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false) {
        const updatedRel = get().relationships.find((r) => r.id === relId)
        if (updatedRel) {
          const nodeOrder = getRelationshipNodeOrder(updatedRel, get().nodes, get().edges)
          const eff = computeRelationshipEffectiveState(updatedRel, nodeOrder, atNodeId)
          const priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
          const entries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
            ? (priorWrapper.entries ?? (Object.prototype.hasOwnProperty.call(priorWrapper, 'entries') ? {} : priorWrapper))
            : {}
          if (priorWrapper != null && Object.keys(entries).length > 0) {
            useUiStore.getState().openAwarenessRolloverModal({
              pages: [{
                fieldLabel: 'Name',
                target: { kind: 'relationship', relationshipId: relId },
                anchor: { kind: 'chain', nodeId: atNodeId },
                priorWrapper,
                draft: priorWrapper,
                oldValue: oldName ?? null,
                newValue: name || null,
              }],
              currentPageIdx: 0,
            })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }
    return result
  },

  /**
   * Phase 3.4f Item 4 — anchor-aware Project Tag membership mutation on
   * a Relationship. Mirrors `recordKnowledgeTagChange` but with the
   * creation-anchor check `setRelationshipName` / `setRelationshipDescription`
   * use to detect "is this the relationship's origin":
   *   - `atNodeId === null` OR `atNodeId === creationNodeId` → BASELINE
   *     write (mutates `relationship.tag_ids`).
   *   - Any other chain anchor → chain event in
   *     `relationship.history.tag_changes` at that node, with same-node
   *     opposite-pair cancellation + same-action duplicate drop.
   *
   * `action` must be 'add' or 'remove'. Sets `hasUnsavedChanges`; the
   * next project save flushes both branches via PUT /api/story.
   */
  recordRelationshipTagChange: (relId, action, tagId, atNodeId) => {
    if (!relId || !tagId) return
    if (action !== 'add' && action !== 'remove') return
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const creationNodeId = getRelationshipCreationNodeId(rel, get().nodes, atNodeId)
    const isBaselineWrite = !atNodeId || creationNodeId === atNodeId

    get()._snapshot()
    set({
      relationships: get().relationships.map((r) => {
        if (r.id !== relId) return r

        if (isBaselineWrite) {
          const baseline = r.tag_ids || []
          if (action === 'add') {
            if (baseline.includes(tagId)) return r
            return { ...r, tag_ids: [...baseline, tagId] }
          }
          if (!baseline.includes(tagId)) return r
          return { ...r, tag_ids: baseline.filter((id) => id !== tagId) }
        }

        // Chain event write — pair-cancel + duplicate-drop against
        // existing events at this anchor for this tag.
        const history = r.history || {}
        const events = history.tag_changes || []
        const oppositeAction = action === 'add' ? 'remove' : 'add'
        const oppositeIdx = events.findIndex(
          (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === oppositeAction
        )
        if (oppositeIdx >= 0) {
          const next = events.filter((_, i) => i !== oppositeIdx)
          return { ...r, history: { ...history, tag_changes: next } }
        }
        const sameIdx = events.findIndex(
          (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === action
        )
        if (sameIdx >= 0) return r
        const newEvent = {
          id: crypto.randomUUID(),
          action,
          tag_id: tagId,
          node_id: atNodeId,
        }
        return { ...r, history: { ...history, tag_changes: [...events, newEvent] } }
      }),
      hasUnsavedChanges: true,
    })
    // Phase 3.4 Bugs & Fixes — orphan-cleanup gate (parallel to
    // `recordKnowledgeTagChange`).
    get()._maybeCleanupOrphanedTagInline(tagId)
  },

  /**
   * Phase 3.4 Bugs & Fixes — atomic orphan-tag inline cleanup.
   *
   * Call from any record-action that strips a Project Tag membership
   * (the `'remove'` branch of `recordEntityTagChange` /
   * `recordKnowledgeTagChange` / `recordRelationshipTagChange`, the
   * Reference-Node tag-detach path, and `deleteObject` for host kinds
   * whose `_strip*` walker drops their `tag_ids` / `tag_changes`).
   *
   * If `tagId` has zero hosts remaining in live project state, splice
   * its pool entry from `entitiesStore.projectTags` IN-LINE — same
   * synchronous tick as the originating record-action's `set()`. The
   * pool deletion rides on the SAME `_snapshot()` entry the caller
   * already took, so Ctrl-Z restores both the host membership AND the
   * pool entry in one step (per the Phase 3.4 Bugs & Fixes ToDo's
   * atomic-undo requirement). The snapshot capture is handled by
   * `_snapshot()`'s `_projectTagsBefore` extra (always present);
   * undo/redo restore via the matching slot.
   *
   * Fires the backend `DELETE /api/project-tags/{id}` in the
   * background so the on-disk pool stays in sync. Errors are swallowed
   * (404 is fine — the row may already be gone if a concurrent
   * `_deleteProjectTagInternal` raced us); the next project save also
   * syncs via the `project_tags` field on the story payload.
   *
   * Returns `true` when cleanup fired, `false` otherwise. Callers
   * generally ignore the return — it's exposed for the MCP path that
   * surfaces a `pool_deleted` flag.
   *
   * Designed for the `>0 → 0` transition ONLY: does NOT fire when a
   * tag is minted with zero attached hosts (find-or-create + no
   * `attach_to`). The check happens AFTER the originating mutation
   * has been written, so a tag created without hosts in the same
   * tick wouldn't yet be on `projectTags`.
   */
  _maybeCleanupOrphanedTagInline: (tagId) => {
    if (!tagId) return false
    const es = useEntitiesStore.getState()
    const pool = es.projectTags || []
    if (!pool.some((t) => t.id === tagId)) return false
    const { knowledges, relationships, nodes } = get()
    const remaining = _countHostsForTag(tagId, {
      entities: es,
      knowledges,
      relationships,
      nodes,
    }, 0)
    if (remaining > 0) return false
    // Splice the pool entry out of entitiesStore. The originating
    // record-action's `_snapshot()` already captured the projectTags
    // array via `_projectTagsBefore`, so undo restores.
    useEntitiesStore.setState({
      projectTags: pool.filter((t) => t.id !== tagId),
    })
    // Fire the backend DELETE in the background. Errors swallowed —
    // the local strip stays applied; the next project save will sync
    // via `project_tags` on the story payload if the backend missed.
    axios.delete(`/api/project-tags/${tagId}`).catch((err) => {
      if (err?.response?.status !== 404) {
         
        console.warn('[_maybeCleanupOrphanedTagInline] backend DELETE failed', tagId, err)
      }
    })
    return true
  },

  /**
   * Anchor-aware setter for the Relationship description (chain-tracked
   * scalar field, mirrors setRelationshipName).
   *   - At creation anchor (or atNodeId === null): write baseline via
   *     updateRelationship.
   *   - At any other chain anchor: append-or-replace a `description_changes`
   *     entry on the relationship's history (at-most-one per node).
   */
  setRelationshipDescription: async (relId, description, atNodeId = null) => {
    get()._snapshot()
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const oldDescription = rel.description ?? ''
    const desc = description == null ? '' : description
    if (!atNodeId) {
      return get().updateRelationship(relId, { ...rel, description: desc })
    }
    const creationNodeId = getRelationshipCreationNodeId(rel, get().nodes, atNodeId)
    if (creationNodeId === atNodeId) {
      return get().updateRelationship(relId, { ...rel, description: desc })
    }
    const descChange = { node_id: atNodeId, new_description: desc || null }
    const existing = rel.history?.description_changes || []
    const idx = existing.findIndex((c) => c.node_id === atNodeId)
    const updDescChanges = idx >= 0
      ? existing.map((c, i) => i === idx ? descChange : c)
      : [...existing, descChange]
    const updHistory = { ...rel.history, description_changes: updDescChanges }
    const result = await get().updateRelationship(relId, { ...rel, history: updHistory })
    // Awareness-rollover modal — chain-anchor description change on a
    // tracked relationship.
    try {
      const story = get().story
      if (story?.awareness_rollover_check_enabled !== false) {
        const updatedRel = get().relationships.find((r) => r.id === relId)
        if (updatedRel) {
          const nodeOrder = getRelationshipNodeOrder(updatedRel, get().nodes, get().edges)
          const eff = computeRelationshipEffectiveState(updatedRel, nodeOrder, atNodeId)
          const priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
          const entries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
            ? (priorWrapper.entries ?? (Object.prototype.hasOwnProperty.call(priorWrapper, 'entries') ? {} : priorWrapper))
            : {}
          if (priorWrapper != null && Object.keys(entries).length > 0) {
            useUiStore.getState().openAwarenessRolloverModal({
              pages: [{
                fieldLabel: 'Description',
                target: { kind: 'relationship', relationshipId: relId },
                anchor: { kind: 'chain', nodeId: atNodeId },
                priorWrapper,
                draft: priorWrapper,
                oldValue: oldDescription,
                newValue: desc,
              }],
              currentPageIdx: 0,
            })
          }
        }
      }
    } catch { /* never break a value commit on rollover failure */ }
    return result
  },

  // Unified participant add — canonical store action. Wraps the pure
  // `addParticipantJoin` helper which enforces normalized-history invariants
  // (at-most-one join@N, same-node leave/join pair cancellation). Callers
  // must never append to `participant_changes` directly.
  addParticipant: async (relId, entityId, atNodeId, role) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const { relationship: helperResult, mode, removedChangeId } = addParticipantJoin(rel, entityId, atNodeId)
    if (mode === 'noop') return rel
    get()._snapshot()
    const updated = role
      ? { ...helperResult, participant_roles: { ...(helperResult.participant_roles || {}), [entityId]: role } }
      : helperResult
    const result = await get().updateRelationship(relId, updated)
    // Origin-wire side effect: align the persistent entity-origin → origin
    // wire with the new history state. Idempotent — creates the wire when
    // the entity now has a join@origin and none exists, no-ops at-scene
    // joins (no persistent wire), no-ops when wire is already in place.
    get()._syncOriginWireForRel(entityId, result)
    // Fire the orphan-Knowledge cleanup cascade when a pair-cancel
    // stripped a chain entry. The cascade is idempotent and a no-op
    // when no Knowledge had its source_event pointing at this entry.
    // v8 bug #3: without this, Knowledges created via
    // `track_as_knowledge` on the now-stripped change end up as
    // dangling pointers.
    if (removedChangeId) get()._runEventRemovalCascade([removedChangeId])
    return result
  },

  // Unified participant remove — canonical store action. Wraps the pure
  // `removeParticipantAtNode` helper which enforces normalized-history
  // invariants (same-node join/leave pair cancellation, mirror-strip at
  // origin when cancelled join leaves no remaining joins, origin-only
  // base strip when entity has no history joins). Cascades to
  // `deleteObject('relationship', relId)` when the relationship has no
  // remaining potential participants.
  removeParticipant: async (relId, entityId, atNodeId) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const { relationship: helperResult, mode, shouldCascade, removedChangeId } = removeParticipantAtNode(rel, entityId, atNodeId)
    if (mode === 'noop') return rel
    if (shouldCascade) {
      return get().deleteObject('relationship', relId)
    }
    get()._snapshot()
    const result = await get().updateRelationship(relId, helperResult)
    // Origin-wire side effect: align the persistent entity-origin → origin
    // wire with the new history state. When the pair-cancel branch stripped
    // the join@origin, this removes the wire; when the additive-leave branch
    // appended a leave somewhere downstream, the join@origin is untouched
    // and the wire stays. Idempotent.
    get()._syncOriginWireForRel(entityId, result)
    // Fire the orphan-Knowledge cleanup cascade when a pair-cancel
    // stripped a chain entry. v8 bug #3 fix.
    if (removedChangeId) get()._runEventRemovalCascade([removedChangeId])
    return result
  },

  // Resolves the faction-member wire prompt. Called by FactionMemberPromptDialog.
  // addAsMember=true  → add source as participant in the membership relationship + create rel wire
  // addAsMember=false → create a new independent relationship between the two entities
  // context: 'entityToEntity' | 'entityToSceneChip'
  resolveFactionMemberWire: async (addAsMember, { sourceEntityId, targetEntityId, membershipRelId, sourceNodeId, targetNodeId, capturedSourceHandle, context }) => {
    if (addAsMember) {
      await get().addParticipant(membershipRelId, sourceEntityId, targetNodeId)
      const curRel = get().relationships.find((r) => r.id === membershipRelId)
      if (!curRel) return
      const relHandle = `rel-in-${membershipRelId}`
      if (context === 'entityToSceneChip') {
        // Add source entity chip to the scene, create flow wire + rel wire
        const sourceEntity = useEntitiesStore.getState().getEntityById(sourceEntityId)
        if (sourceEntity) {
          const updNodes = addOrphanedChipToNode(get().nodes, targetNodeId, sourceEntity)
          if (updNodes !== get().nodes) set({ nodes: updNodes })
        }
        const flowWireId = `flow-${sourceNodeId}-${targetNodeId}-${sourceEntityId}`
        const edsWithout = get().edges.filter(
          (e) => !(e.target === targetNodeId && !e.data?.is_relationship && e.data?.source_entity_id === sourceEntityId)
        )
        set({
          edges: [
            ...edsWithout,
            {
              id: flowWireId,
              source: sourceNodeId,
              target: targetNodeId,
              targetHandle: `chip-in-${sourceEntityId}`,
              type: 'transitionEdge',
              data: { id: flowWireId, source_node_id: sourceNodeId, target_node_id: targetNodeId, source_entity_id: sourceEntityId, target_entity_id: null, transition_text: '', entity_ids: [sourceEntityId], is_pov_path: false, target_handle_id: `chip-in-${sourceEntityId}` },
            },
            {
              id: `rel-wire-${membershipRelId}-${sourceEntityId}`,
              source: sourceNodeId,
              target: targetNodeId,
              targetHandle: relHandle,
              type: 'relationshipEdge',
              data: { is_relationship: true, relationship_id: membershipRelId, entity_a_id: sourceEntityId, source_entity_id: sourceEntityId, source_node_id: sourceNodeId, target_node_id: targetNodeId, target_handle_id: relHandle },
            },
          ],
          hasUnsavedChanges: true,
        })
      } else {
        // entityToEntity: just the rel wire (entity nodes have no scene chips)
        if (!get().edges.some((e) => e.source === sourceNodeId && e.target === targetNodeId && e.targetHandle === relHandle)) {
          set({
            edges: [...get().edges, {
              id: `rel-wire-${membershipRelId}-${sourceEntityId}`,
              source: sourceNodeId,
              ...(capturedSourceHandle ? { sourceHandle: capturedSourceHandle } : {}),
              target: targetNodeId,
              targetHandle: relHandle,
              type: 'relationshipEdge',
              data: { is_relationship: true, relationship_id: membershipRelId, entity_a_id: sourceEntityId, source_entity_id: sourceEntityId, source_node_id: sourceNodeId, target_node_id: targetNodeId, target_handle_id: relHandle },
            }],
            hasUnsavedChanges: true,
          })
        }
      }
    } else {
      // "New Relationship" path — replicate the original handler for each context
      if (context === 'entityToSceneChip') {
        get().createRelationship({
          history: {
            existence_changes: [],
            participant_changes: [
              { node_id: targetNodeId, action: 'join', entity_id: sourceEntityId, initial_perception: '', initial_alias_override: null },
              { node_id: targetNodeId, action: 'join', entity_id: targetEntityId, initial_perception: '', initial_alias_override: null },
            ],
            perception_changes: [], alias_changes: [], role_changes: [], hierarchy_changes: [],
          },
        }).then((rel) => {
          if (!rel) return
          const sourceEntity = useEntitiesStore.getState().getEntityById(sourceEntityId)
          if (sourceEntity) {
            const updNodes = addOrphanedChipToNode(get().nodes, targetNodeId, sourceEntity)
            if (updNodes !== get().nodes) set({ nodes: updNodes })
          }
          const flowWireId = `flow-${sourceNodeId}-${targetNodeId}-${sourceEntityId}`
          const edsAfterNode = get().edges.filter(
            (e) => !(e.target === targetNodeId && !e.data?.is_relationship && e.data?.source_entity_id === sourceEntityId)
          )
          set({
            edges: [
              ...edsAfterNode,
              { id: flowWireId, source: sourceNodeId, target: targetNodeId, targetHandle: `chip-in-${sourceEntityId}`, type: 'transitionEdge', data: { id: flowWireId, source_node_id: sourceNodeId, target_node_id: targetNodeId, source_entity_id: sourceEntityId, target_entity_id: null, transition_text: '', entity_ids: [sourceEntityId], is_pov_path: false, target_handle_id: `chip-in-${sourceEntityId}` } },
              // No rel-wire to the scene's rel chip. Design decision post
              // v0.1.18.132: wires only persist on rel origin nodes and on
              // faction-membership EntityNode targets. Scene-level rel chips
              // are the authoritative UI surface for in-scene participation.
            ],
            hasUnsavedChanges: true,
          })
        })
      } else {
        // entityToEntity
        get().createRelationship({
          history: {
            existence_changes: [],
            participant_changes: [
              { node_id: sourceNodeId, action: 'join', entity_id: sourceEntityId, initial_perception: '', initial_alias_override: null },
              { node_id: targetNodeId, action: 'join', entity_id: targetEntityId, initial_perception: '', initial_alias_override: null },
            ],
            perception_changes: [], alias_changes: [], role_changes: [], hierarchy_changes: [],
          },
        }).then((rel) => {
          if (!rel) return
          set({
            edges: [...get().edges, {
              id: `rel-wire-${rel.id}`,
              source: sourceNodeId,
              ...(capturedSourceHandle ? { sourceHandle: capturedSourceHandle } : {}),
              target: targetNodeId,
              type: 'relationshipEdge',
              data: { is_relationship: true, relationship_id: rel.id, entity_a_id: sourceEntityId, entity_b_id: targetEntityId, source_entity_id: sourceEntityId, source_node_id: sourceNodeId, target_node_id: targetNodeId },
            }],
            hasUnsavedChanges: true,
          })
        })
      }
    }
  },

  recordRelationshipChange: async (relId, change) => {
    get()._snapshot()
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    const changeType = change.type
    const changeData = change.data
    const historyKey = {
      existence: 'existence_changes',
      participant: 'participant_changes',
      perception: 'perception_changes',
      alias: 'alias_changes',
      role: 'role_changes',
      hierarchy: 'hierarchy_changes',
      // `name` and `description` were missing from this map — write
      // calls with those types fell through to the silent-return guard
      // below, so chain entries for `update_relationship(at=...,
      // name=..., description=...)` were never being recorded even
      // though the MCP tool returned success. Surfaced by the blind
      // usability test in v0.2.1.133. Both fields are scalar-per-
      // relationship (one canonical value) and use the byNodeUpsert
      // rule below to enforce at-most-one entry per scene per field.
      name: 'name_changes',
      description: 'description_changes',
    }[changeType]
    if (!historyKey) return
    // Upsert rules by change type:
    //   - perEntityUpsert — at-most-one per (node_id, entity_id); used for
    //     scalar-per-participant fields.
    //   - byNodeUpsert — at-most-one per node_id; used for relationship-wide
    //     scalars (hierarchy is a single value on the rel).
    //   - existence is a SECOND paired-change type (alongside
    //     participant join/leave): activate ↔ deactivate at the same
    //     node_id pair-cancel and BOTH entries are stripped from history,
    //     mirroring the participant_changes invariant. Same-action
    //     duplicate at the same node_id is a no-op.
    //   - participant is the original paired-change type and routes
    //     through its own dedicated helper (`addParticipantJoin` via
    //     `addParticipant`); it never comes through this dispatcher.
    const perEntityUpsert = new Set(['perception', 'alias', 'role'])
    // `name` and `description` are relationship-wide scalars (one
    // canonical value across the rel, not per-participant), so they
    // upsert by node — re-editing at the same scene replaces the
    // existing entry instead of stacking duplicates. Matches the
    // normalized-history rule for scalar chain types.
    const byNodeUpsert    = new Set(['hierarchy', 'name', 'description'])
    const existing = rel.history?.[historyKey] || []
    let updArray
    // Track entries removed by pair-cancellation so the event-removal
    // cascade can detach any Knowledges attached to them.
    const removedChangeIds = []
    if (perEntityUpsert.has(changeType)) {
      const idx = existing.findIndex((c) => c.node_id === changeData.node_id && c.entity_id === changeData.entity_id)
      updArray = idx >= 0 ? existing.map((c, i) => i === idx ? changeData : c) : [...existing, changeData]
    } else if (byNodeUpsert.has(changeType)) {
      const idx = existing.findIndex((c) => c.node_id === changeData.node_id)
      updArray = idx >= 0 ? existing.map((c, i) => i === idx ? changeData : c) : [...existing, changeData]
    } else if (changeType === 'existence') {
      // Pair-cancellation: a same-node opposite-action write strips
      // BOTH the existing entry and the incoming write. Same-action
      // duplicate is idempotent (no-op). Otherwise append.
      const idx = existing.findIndex((c) => c.node_id === changeData.node_id)
      if (idx >= 0) {
        const existingAction = existing[idx]?.action
        const incomingAction = changeData.action
        if (existingAction === incomingAction) {
          // Duplicate same-action — no-op, history unchanged.
          updArray = existing
        } else {
          // Opposite actions at the same node — strip the existing entry
          // and discard the incoming write (pair-cancel).
          updArray = existing.filter((_, i) => i !== idx)
          if (existing[idx]?.id) removedChangeIds.push(existing[idx].id)
        }
      } else {
        updArray = [...existing, changeData]
      }
    } else {
      updArray = [...existing, changeData]
    }
    const updHistory = { ...rel.history, [historyKey]: updArray }
    const result = await get().updateRelationship(relId, { ...rel, history: updHistory })
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
    return result
  },

  // Sets or clears the hierarchy element on a relationship.
  // atNodeId null = edit base relationship (creation-node context); non-null = record history change.
  setRelationshipHierarchy: async (relId, hierarchyConfig, atNodeId) => {
    get()._snapshot()
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    if (!atNodeId) {
      return get().updateRelationship(relId, { ...rel, hierarchy: hierarchyConfig ?? null })
    }
    // Phase 1.21h Fix #3 — anchor-aware. Internal branching mirrors
    // setRelationshipName / setParticipantRole: write baseline at the
    // creation anchor, otherwise append a `hierarchy_changes` entry.
    // Callers can pass `currentNodeId` unconditionally; the action
    // makes the routing decision so a future call site can't
    // accidentally rewrite baseline from a non-creation anchor.
    const creationNodeId = getRelationshipCreationNodeId(rel, get().nodes, atNodeId)
    if (creationNodeId === atNodeId) {
      return get().updateRelationship(relId, { ...rel, hierarchy: hierarchyConfig ?? null })
    }
    return get().recordRelationshipChange(relId, {
      type: 'hierarchy',
      data: { node_id: atNodeId, new_hierarchy: hierarchyConfig ?? null },
    })
  },

  /**
   * Anchor-aware setter for Relationship awareness. Awareness lives on
   * the relationship's own host (post-Phase-1.21g awareness-as-
   * second-class-object model):
   * - At the relationship's creation anchor (or atNodeId === null), the
   *   per-observer level is written to `Relationship.awareness`
   *   baseline (a normal dict-merge — `level=null` strips the observer
   *   key).
   * - At any non-creation chain anchor, an awareness history entry is
   *   appended to `Relationship.awareness.history[]` via the canonical
   *   `commitAwarenessAtAnchor` pipeline. The relationship's library
   *   row stays untouched.
   *
   * Callers: any UI write path mutating relationship awareness, plus
   * the MCP `set_relationship_awareness` handler. Replaces the
   * previous fragile path where callers handed a partial body to
   * `updateRelationship`, which has no anchor check and rewrites the
   * library row regardless of context.
   *
   * Args:
   *   relId             — relationship id
   *   observerEntityId  — observer id (key in awareness dict)
   *   level             — new level (0 / 3 binary scale) or null to
   *                       strip the observer's entry
   *   atNodeId          — chain anchor id; null routes to baseline
   */
  setRelationshipAwareness: async (relId, observerEntityId, level, atNodeId = null) => {
    if (!relId || !observerEntityId) return
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return

    // Resolve anchor: baseline if atNodeId is null OR if it IS the
    // relationship's creation anchor.
    const atCreationAnchor = !!(atNodeId
      && getRelationshipCreationNodeId(rel, get().nodes, atNodeId) === atNodeId)
    const isOriginAnchor = !atNodeId || atCreationAnchor

    // Build the draft wrapper from the current effective awareness with
    // one observer's level swapped in. The universal setter then diffs
    // and produces the right write descriptors.
    let priorWrapper
    if (isOriginAnchor) {
      const a = rel.awareness
      priorWrapper = (a && typeof a === 'object' && !('relationship_id' in a && 'level' in a))
        ? a : null
    } else {
      const eff = computeRelationshipEffectiveState(rel, get().nodes, get().edges, atNodeId)
      priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
    }

    const priorEntries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper)
      && !('relationship_id' in priorWrapper && 'level' in priorWrapper))
      ? (priorWrapper.entries ?? priorWrapper)
      : {}
    const priorSources = (priorWrapper && typeof priorWrapper === 'object' && Array.isArray(priorWrapper.sources))
      ? priorWrapper.sources : []
    const nextEntries = { ...priorEntries }
    if (level == null) delete nextEntries[observerEntityId]
    else nextEntries[observerEntityId] = level

    let draft
    if (priorSources.length > 0) {
      draft = { entries: nextEntries, sources: priorSources }
    } else if (Object.keys(nextEntries).length > 0) {
      draft = nextEntries
    } else {
      draft = null
    }

    return get().commitAwarenessAtAnchor({
      target: { kind: 'relationship', relationshipId: relId },
      anchor: { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: isOriginAnchor ? null : atNodeId },
      draft,
    })
  },

  /**
   * Strip an entry from an awareness object's `history` list by id, then
   * re-run downstream review-flag propagation for the affected observer
   * (so existing flags rebuild against the post-strip state). Universal
   * across all six awareness target kinds — dispatch via the `target`
   * descriptor.
   *
   * Used by the awareness sub-chip's "Remove this change" affordance.
   * The chain entry is identified by `entryId` (the history entry's
   * stable id, rendered as `record.changeId` on sub-chips).
   */
  removeAwarenessHistoryEntry: async ({ target, entryId, opts = {} } = {}) => {
    if (!target || !entryId) return
    const isEntityKind = target.kind === 'entity' || target.kind === 'entity_name'
      || target.kind === 'attribute' || target.kind === 'alias'

    // stripFromHistory removes the entry by id AND clears any review_flag
    // on remaining entries whose `sourceNodeId` was the removed entry's
    // node — those flags were stamped by the now-removed upstream edit
    // and have no source any more.
    const stripFromHistory = (awareness) => {
      if (!awareness || typeof awareness !== 'object' || Array.isArray(awareness)) return { next: awareness, removed: null }
      const history = Array.isArray(awareness.history) ? awareness.history : null
      if (!history) return { next: awareness, removed: null }
      const removed = history.find((e) => e?.id === entryId) || null
      if (!removed) return { next: awareness, removed: null }
      const removedNodeId = removed.node_id
      const filtered = history
        .filter((e) => e?.id !== entryId)
        .map((e) => {
          if (e?.review_flag && e.review_flag.sourceNodeId === removedNodeId) {
            const { review_flag: _review_flag, ...rest } = e
            return rest
          }
          return e
        })
      return { next: { ...awareness, history: filtered }, removed }
    }

    if (isEntityKind) {
      if (!target.entityId) return
      const entitiesStore = useEntitiesStore.getState()
      const findEntity = (id) => entitiesStore.getEntityById?.(id)
        || [...entitiesStore.characters, ...entitiesStore.locations, ...entitiesStore.items, ...entitiesStore.factions, ...entitiesStore.customs].find((e) => e.id === id)
      const entity = findEntity(target.entityId)
      if (!entity) return
      const currentAware = readAwarenessAtTarget(entity, target)
      const { next, removed } = stripFromHistory(currentAware)
      if (!removed) return
      // Snapshot entity pre-mutation so undo can restore via _restoreEntityData.
      const bucket = entity?.type ? `${entity.type}s` : null
      if (!opts.skipSnapshot) get()._snapshot({
        _entityDataRestore: bucket ? [{ ...entity, _bucket: bucket }] : undefined,
      })
      // Note: do NOT re-run applyDownstreamAwarenessHistoryReviewFlags
      // after the strip. Review flags are event-based (recorded at edit
      // time), not derived from current state, so re-running would
      // stamp new flags with sourceNodeId pointing at the now-removed
      // entry's node and bogus null previousInherited values. The strip
      // helper already cleared any flag whose sourceNodeId matched the
      // removed entry's node — that's the correct cleanup.
      const working = setAwarenessAtTarget(entity, target, next)
      await entitiesStore.updateEntity(target.entityId, working)
      if (bucket) get()._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...working, _bucket: bucket }] })
      set({ hasUnsavedChanges: true })
      return
    }
    if (target.kind === 'relationship') {
      if (!target.relationshipId) return
      const rel = get().relationships.find((r) => r.id === target.relationshipId)
      if (!rel) return
      const { next, removed } = stripFromHistory(rel.awareness)
      if (!removed) return
      // Relationships are captured by base _snapshot via _relationshipsBefore.
      if (!opts.skipSnapshot) get()._snapshot()
      const working = { ...rel, awareness: next }
      await get().updateRelationship(target.relationshipId, working)
      set({ hasUnsavedChanges: true })
      return
    }
    if (target.kind === 'knowledge') {
      if (!target.knowledgeId) return
      const k = get().knowledges.find((x) => x.id === target.knowledgeId)
      if (!k) return
      const { next, removed } = stripFromHistory(k.awareness)
      if (!removed) return
      // Knowledges are captured by base _snapshot via _knowledgesBefore.
      if (!opts.skipSnapshot) get()._snapshot()
      set({
        knowledges: get().knowledges.map((x) => x.id === target.knowledgeId ? { ...x, awareness: next } : x),
        hasUnsavedChanges: true,
      })
      return
    }
  },

  /** Clear the per-entry `review_flag` on a single awareness.history
   *  entry without removing the entry itself. Used by AlertsPanel
   *  Confirm / Keep-as-is dismissals for new-model awareness alerts. */
  clearAwarenessHistoryReviewFlag: ({ target, entryId } = {}) => {
    if (!target || !entryId) return
    const stripFlag = (awareness) => {
      if (!awareness || typeof awareness !== 'object' || Array.isArray(awareness)) return { next: awareness, changed: false }
      const history = Array.isArray(awareness.history) ? awareness.history : null
      if (!history) return { next: awareness, changed: false }
      let changed = false
      const filtered = history.map((e) => {
        if (e?.id === entryId && e.review_flag) {
          changed = true
          const { review_flag: _review_flag, ...rest } = e
          return rest
        }
        return e
      })
      return { next: changed ? { ...awareness, history: filtered } : awareness, changed }
    }
    const isEntityKind = target.kind === 'entity' || target.kind === 'entity_name'
      || target.kind === 'attribute' || target.kind === 'alias'
    // Review-flag dismissals are one-way "I saw it" actions, NOT
    // undoable — matches the convention used by clearEntityReviewFlags
    // / clearEntityReviewField / clearKnowledgeAwarenessReviewFlag.
    // No `_snapshot()` is taken; Ctrl-Z does not bring the badge back.
    if (isEntityKind && target.entityId) {
      const entitiesStore = useEntitiesStore.getState()
      const findEntity = (id) => entitiesStore.getEntityById?.(id)
        || [...entitiesStore.characters, ...entitiesStore.locations, ...entitiesStore.items, ...entitiesStore.factions, ...entitiesStore.customs].find((e) => e.id === id)
      const entity = findEntity(target.entityId)
      if (!entity) return
      const currentAware = readAwarenessAtTarget(entity, target)
      const { next, changed } = stripFlag(currentAware)
      if (!changed) return
      const working = setAwarenessAtTarget(entity, target, next)
      entitiesStore.updateEntity(target.entityId, working)
      set({ hasUnsavedChanges: true })
      return
    }
    if (target.kind === 'relationship' && target.relationshipId) {
      const rel = get().relationships.find((r) => r.id === target.relationshipId)
      if (!rel) return
      const { next, changed } = stripFlag(rel.awareness)
      if (!changed) return
      get().updateRelationship(target.relationshipId, { ...rel, awareness: next })
      set({ hasUnsavedChanges: true })
      return
    }
    if (target.kind === 'knowledge' && target.knowledgeId) {
      const k = get().knowledges.find((x) => x.id === target.knowledgeId)
      if (!k) return
      const { next, changed } = stripFlag(k.awareness)
      if (!changed) return
      set({
        knowledges: get().knowledges.map((x) => x.id === target.knowledgeId ? { ...x, awareness: next } : x),
        hasUnsavedChanges: true,
      })
    }
  },

  /**
   * Universal anchor-aware awareness setter. ONE function, kind dispatch
   * via the `target` descriptor. Single-item entry point; for atomic
   * batch commits (panel OK clicks editing many surfaces), use
   * `commitAwarenessBatchAtAnchor`.
   *
   * Args:
   *   target  — kind-discriminated descriptor:
   *               { kind: 'entity',         entityId }
   *               { kind: 'entity_name',    entityId }
   *               { kind: 'attribute',      entityId, attributeId }
   *               { kind: 'alias',          entityId, aliasValue }
   *               { kind: 'relationship',   relationshipId }
   *               { kind: 'knowledge',      knowledgeId }
   *             Future kinds add their own dispatch branches in
   *             `readEffectiveAwarenessForTarget` /
   *             `readAwarenessAtTarget` / `setAwarenessAtTarget` /
   *             `applyBaselineDraftToEntity` in
   *             utils/awarenessCommit.js.
   *   anchor  — { kind: 'origin' | 'chain', nodeId? } — at chain,
   *             nodeId is the scene / modifier node that hosts the
   *             chain entry.
   *   draft   — wrapper-shape value the picker emitted (or null).
   *   opts    — { skipSnapshot?: boolean }
   *
   * Returns: a Promise that resolves once the write completes (origin
   * path awaits updateEntity; chain path resolves immediately after
   * setState).
   */
  commitAwarenessAtAnchor: ({ target, anchor, draft, opts = {} } = {}) => {
    return get().commitAwarenessBatchAtAnchor({ items: [{ target, draft }], anchor, opts })
  },

  /**
   * Toggle the awareness layer's tracking on/off at an anchor. Tracking
   * is itself a chain-tracked value: each toggle writes a `tracking_on`
   * or `tracking_off` event to the awareness object's history. The
   * walker resolves "is tracking on at anchor X?" by reading the most-
   * recent tracking event up to X.
   *
   *   - Origin anchor: clears the wrapper (off) or seeds an empty
   *     wrapper `{}` (on). Mirrors the legacy library-row toggle.
   *   - Chain anchor: appends a single tracking_on / tracking_off
   *     history entry at the anchor (deduped per node).
   *
   * Args:
   *   target — same target descriptor shape as commitAwarenessAtAnchor
   *   anchor — { kind: 'origin' | 'chain', nodeId? }
   *   action — 'on' | 'off'
   */
  commitAwarenessTrackingAtAnchor: async ({ target, anchor, action, opts = {} } = {}) => {
    if (action !== 'on' && action !== 'off') return
    if (!target || !anchor) return
    const isOriginAnchor = anchor.kind === 'origin' || !anchor.nodeId
    if (isOriginAnchor) {
      // Origin: legacy null-or-{} semantics on the host's baseline wrapper.
      return get().commitAwarenessBatchAtAnchor({
        items: [{ target, draft: action === 'off' ? null : {} }],
        anchor,
        opts,
      })
    }
    // Chain anchor: write a single tracking history entry to the
    // awareness object's history list. No diff — explicit on/off event.
    const entitiesStore = useEntitiesStore.getState()
    const findEntity = (entityId) => entitiesStore.getEntityById?.(entityId)
      || [...entitiesStore.characters, ...entitiesStore.locations, ...entitiesStore.items, ...entitiesStore.factions, ...entitiesStore.customs].find((e) => e.id === entityId)
    const isEntityBoundKind = (k) => k === 'entity' || k === 'entity_name' || k === 'attribute' || k === 'alias'
    if (!opts.skipSnapshot) {
      const entityDataRestore = []
      if (isEntityBoundKind(target.kind) && target.entityId) {
        const e = findEntity(target.entityId)
        if (e?.type) entityDataRestore.push({ ...e, _bucket: `${e.type}s` })
      }
      get()._snapshot(entityDataRestore.length > 0 ? { _entityDataRestore: entityDataRestore } : undefined)
    }
    const newEntry = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      node_id: anchor.nodeId,
      observer_id: '',
      level: null,
      source_action: null,
      source: null,
      tracking_action: action,
    }
    if (isEntityBoundKind(target.kind)) {
      const entity = findEntity(target.entityId)
      if (!entity) return
      const currentAware = readAwarenessAtTarget(entity, target)
      const nextAware = appendAwarenessHistoryEntries(currentAware, [newEntry])
      const updated = setAwarenessAtTarget(entity, target, nextAware)
      await entitiesStore.updateEntity(target.entityId, updated)
      if (updated?.type) {
        get()._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...updated, _bucket: `${updated.type}s` }] })
      }
      return
    }
    if (target.kind === 'relationship') {
      const rel = get().relationships.find((r) => r.id === target.relationshipId)
      if (!rel) return
      const nextAware = appendAwarenessHistoryEntries(rel.awareness, [newEntry])
      const updated = { ...rel, awareness: nextAware }
      set({ relationships: get().relationships.map((r) => r.id === rel.id ? updated : r), hasUnsavedChanges: true })
      return
    }
    if (target.kind === 'knowledge') {
      const k = get().knowledges.find((kk) => kk.id === target.knowledgeId)
      if (!k) return
      const nextAware = appendAwarenessHistoryEntries(k.awareness, [newEntry])
      const updated = { ...k, awareness: nextAware }
      set({ knowledges: get().knowledges.map((kk) => kk.id === k.id ? updated : kk), hasUnsavedChanges: true })
      return
    }
  },

  /**
   * Atomic batch sibling: applies many awareness writes from one OK
   * click in a single _snapshot + setState. Items can target different
   * surfaces on the same or different entities. Origin baseline writes
   * are grouped per-entity into a single updateEntity call per affected
   * entity; chain writes are merged into one setState across all
   * carriers; downstream-flag propagation fires once per affected entity.
   *
   * Args:
   *   items   — Array<{ target, draft }>  (see commitAwarenessAtAnchor
   *             for the target descriptor shape)
   *   anchor  — { kind: 'origin' | 'chain', nodeId? }
   *   opts    — { skipSnapshot?: boolean }
   */
  commitAwarenessBatchAtAnchor: async ({ items, anchor, opts = {} } = {}) => {
    if (!Array.isArray(items) || items.length === 0) return
    if (!anchor) return
    const isOriginAnchor = anchor.kind === 'origin' || !anchor.nodeId
    const entitiesStore = useEntitiesStore.getState()
    const findEntity = (entityId) => entitiesStore.getEntityById?.(entityId)
      || [...entitiesStore.characters, ...entitiesStore.locations, ...entitiesStore.items, ...entitiesStore.factions, ...entitiesStore.customs].find((e) => e.id === entityId)

    const isEntityBoundKind = (k) => k === 'entity' || k === 'entity_name' || k === 'attribute' || k === 'alias'

    if (isOriginAnchor) {
      // Group entity-bound items by entityId; relationship items by
      // relationshipId; knowledge items by knowledgeId.
      const entityItemsById = new Map()
      const relItemsById = new Map()
      const knowledgeItemsById = new Map()
      for (const item of items) {
        const k = item.target?.kind
        if (isEntityBoundKind(k)) {
          const eid = item.target.entityId
          if (!eid) continue
          if (!entityItemsById.has(eid)) entityItemsById.set(eid, [])
          entityItemsById.get(eid).push(item)
        } else if (k === 'relationship') {
          const rid = item.target.relationshipId
          if (!rid) continue
          if (!relItemsById.has(rid)) relItemsById.set(rid, [])
          relItemsById.get(rid).push(item)
        } else if (k === 'knowledge') {
          const kid = item.target.knowledgeId
          if (!kid) continue
          if (!knowledgeItemsById.has(kid)) knowledgeItemsById.set(kid, [])
          knowledgeItemsById.get(kid).push(item)
        }
      }
      if (entityItemsById.size === 0 && relItemsById.size === 0 && knowledgeItemsById.size === 0) return

      // Snapshot affected entities pre-mutation so undo can restore via
      // _restoreEntityData. Relationships / knowledges are captured by
      // base _snapshot.
      if (!opts.skipSnapshot) {
        const entityDataRestore = []
        for (const eid of entityItemsById.keys()) {
          const e = findEntity(eid)
          if (e?.type) entityDataRestore.push({ ...e, _bucket: `${e.type}s` })
        }
        get()._snapshot(entityDataRestore.length > 0 ? { _entityDataRestore: entityDataRestore } : undefined)
      }

      // Story order is shared across all origin-edit review-flag stamping
      // (origin-anchor flagging uses sourceNodeId=null, story order
      // determines which history entries qualify as downstream).
      const originStoryOrder = computeStoryOrder({ nodes: get().nodes, edges: get().edges })

      const originPostStates = []
      for (const [entityId, entityItems] of entityItemsById) {
        const entity = findEntity(entityId)
        if (!entity) continue
        const oldSnap = entity
        let working = entity
        for (const item of entityItems) {
          working = applyBaselineDraftToEntity(working, item.target, item.draft)
        }
        // Origin-edit downstream review-flag stamping (awareness.history).
        // For each item, diff old vs new baseline entries per target;
        // for every observer whose baseline level changed, walk the
        // awareness object's history forward (sourceNodeId=null →
        // every history entry on that observer qualifies) and stamp
        // review_flag on entries that override.
        for (const item of entityItems) {
          const t = item.target
          const oldAware = readAwarenessAtTarget(oldSnap, t)
          const newAware = readAwarenessAtTarget(working, t)
          if (!newAware || typeof newAware !== 'object' || Array.isArray(newAware)) continue
          if (!Array.isArray(newAware.history) || newAware.history.length === 0) continue
          const oldEntries = (oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware) && oldAware.entries) ? oldAware.entries : (oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware) ? oldAware : {})
          const newEntries = newAware.entries ?? {}
          const changedObservers = new Set()
          for (const obs of new Set([...Object.keys(oldEntries || {}), ...Object.keys(newEntries || {})])) {
            if ((oldEntries?.[obs] ?? null) !== (newEntries?.[obs] ?? null)) changedObservers.add(obs)
          }
          if (changedObservers.size === 0) continue
          let nextAware = newAware
          for (const obs of changedObservers) {
            const baseline = nextAware?.entries?.[obs] ?? null
            nextAware = applyDownstreamAwarenessHistoryReviewFlags(
              nextAware, obs, null, originStoryOrder, baseline,
            )
          }
          if (nextAware !== newAware) {
            working = setAwarenessAtTarget(working, t, nextAware)
          }
        }
        await entitiesStore.updateEntity(entityId, working)
        get().flagDownstreamAfterOriginEdit(entityId, oldSnap, working)
        if (working?.type) originPostStates.push({ ...working, _bucket: `${working.type}s` })
      }
      if (originPostStates.length > 0) {
        get()._patchLastHistoryWithExtras({ _entityDataAfter: originPostStates })
      }

      for (const [relId, relItems] of relItemsById) {
        const rel = get().relationships.find((r) => r.id === relId)
        if (!rel) continue
        const oldRel = rel
        let working = rel
        for (const item of relItems) {
          working = { ...working, awareness: mergeBaselineAwarenessDraft(working.awareness ?? null, item.draft) }
        }
        // Origin-edit downstream review-flag stamping for relationship
        // awareness — same diff-and-stamp pattern as entities above.
        const newAware = working.awareness
        if (newAware && typeof newAware === 'object' && !Array.isArray(newAware) && Array.isArray(newAware.history) && newAware.history.length > 0) {
          const oldAware = oldRel.awareness
          const oldEntries = (oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware) && oldAware.entries) ? oldAware.entries : (oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware) ? oldAware : {})
          const newEntries = newAware.entries ?? {}
          const changedObservers = new Set()
          for (const obs of new Set([...Object.keys(oldEntries || {}), ...Object.keys(newEntries || {})])) {
            if ((oldEntries?.[obs] ?? null) !== (newEntries?.[obs] ?? null)) changedObservers.add(obs)
          }
          let nextAware = newAware
          for (const obs of changedObservers) {
            const baseline = nextAware?.entries?.[obs] ?? null
            nextAware = applyDownstreamAwarenessHistoryReviewFlags(
              nextAware, obs, null, originStoryOrder, baseline,
            )
          }
          if (nextAware !== newAware) {
            working = { ...working, awareness: nextAware }
          }
        }
        await get().updateRelationship(relId, working)
      }

      if (knowledgeItemsById.size > 0) {
        let nextKnowledges = get().knowledges
        for (const [kid, kItems] of knowledgeItemsById) {
          const k = nextKnowledges.find((x) => x.id === kid)
          if (!k) continue
          const oldAware = k.awareness
          const priorEntries = (oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware)
            && !('relationship_id' in oldAware && 'level' in oldAware))
            ? (oldAware.entries ?? oldAware) : {}
          let working = oldAware ?? null
          for (const item of kItems) working = mergeBaselineAwarenessDraft(working, item.draft)
          let newAwareness = working
          const newEntries = (newAwareness && typeof newAwareness === 'object' && !Array.isArray(newAwareness)
            && !('relationship_id' in newAwareness && 'level' in newAwareness))
            ? (newAwareness.entries ?? newAwareness) : {}
          const allObservers = new Set([...Object.keys(priorEntries || {}), ...Object.keys(newEntries || {})])
          // Diff baseline entries and stamp downstream review flags on
          // canonical `awareness.history` entries for any observer
          // whose level changed.
          if (newAwareness && typeof newAwareness === 'object' && !Array.isArray(newAwareness)
              && Array.isArray(newAwareness.history) && newAwareness.history.length > 0) {
            const changedObservers = new Set()
            for (const obs of allObservers) {
              if ((priorEntries?.[obs] ?? null) !== (newEntries?.[obs] ?? null)) changedObservers.add(obs)
            }
            let nextAware = newAwareness
            for (const obs of changedObservers) {
              const baseline = nextAware?.entries?.[obs] ?? null
              nextAware = applyDownstreamAwarenessHistoryReviewFlags(
                nextAware, obs, null, originStoryOrder, baseline,
              )
            }
            newAwareness = nextAware
          }
          nextKnowledges = nextKnowledges.map((kn) => kn.id === kid ? { ...kn, awareness: newAwareness } : kn)
        }
        set({ knowledges: nextKnowledges })
      }

      set({ hasUnsavedChanges: true })
      return
    }

    // Chain anchor path — awareness-as-second-class-object model.
    //
    // Awareness is attached to its host (Entity / Attribute / Alias /
    // Relationship / Knowledge) and has its OWN chain history list,
    // independent of the host's chain. Chain entries land on
    // `awareness.history` (the awareness object's own chain) — NOT on
    // EntityRef carriers, NOT on scene nodes. The host's presence at
    // the anchor is irrelevant; the awareness's chain is what matters.
    //
    // For each item:
    //   - Resolve prior effective awareness at anchor (via the new
    //     walker with storyOrder).
    //   - Diff prior vs draft → write descriptors.
    //   - Convert descriptors to AwarenessHistoryEntry objects.
    //   - Append to the awareness sub-object's history list.
    // Persist host once per host via updateEntity / updateRelationship /
    // updateKnowledge.
    const storyOrder = computeStoryOrder({ nodes: get().nodes, edges: get().edges })
    const itemsByEntityId = new Map()
    const itemsByRelId = new Map()
    const itemsByKnowledgeId = new Map()
    for (const item of items) {
      const t = item.target
      if (!t) continue
      if (isEntityBoundKind(t.kind)) {
        if (!t.entityId) continue
        if (!itemsByEntityId.has(t.entityId)) itemsByEntityId.set(t.entityId, [])
        itemsByEntityId.get(t.entityId).push(item)
      } else if (t.kind === 'relationship') {
        if (!t.relationshipId) continue
        if (!itemsByRelId.has(t.relationshipId)) itemsByRelId.set(t.relationshipId, [])
        itemsByRelId.get(t.relationshipId).push(item)
      } else if (t.kind === 'knowledge') {
        if (!t.knowledgeId) continue
        if (!itemsByKnowledgeId.has(t.knowledgeId)) itemsByKnowledgeId.set(t.knowledgeId, [])
        itemsByKnowledgeId.get(t.knowledgeId).push(item)
      }
    }
    if (itemsByEntityId.size === 0 && itemsByRelId.size === 0 && itemsByKnowledgeId.size === 0) return

    if (!opts.skipSnapshot) {
      const entityDataRestore = []
      for (const eid of itemsByEntityId.keys()) {
        const e = findEntity(eid)
        if (e?.type) entityDataRestore.push({ ...e, _bucket: `${e.type}s` })
      }
      get()._snapshot(entityDataRestore.length > 0 ? { _entityDataRestore: entityDataRestore } : undefined)
    }

    // Process entity-host writes
    const chainPostStates = []
    for (const [entityId, entityItems] of itemsByEntityId) {
      const entity = findEntity(entityId)
      if (!entity) continue
      let working = entity
      // Chain-only aliases (alias added via a chain-time
      // `AliasChange(action='add')` event, not on entity.aliases
      // baseline) have no `entity.aliases[i]` slot for their
      // awareness wrapper. The universal setter can't write there.
      // Collect those items and write per-event `AliasChange`
      // awareness mutations on the EntityRef's `alias_changes` at
      // the anchor instead. Same per-event mechanism the inline
      // aliases editor uses for add / remove / modify; see the
      // `awareness_set` / `awareness_source_*` dispatcher branches
      // in `narrativeChain.js#applyChangeSet` for the read path.
      const aliasChangeItems = []
      for (const item of entityItems) {
        const t = item.target
        if (t.kind === 'alias') {
          const aliasInBaseline = (working.aliases || []).some(
            (a) => (typeof a === 'string' ? a : a?.value) === t.aliasValue,
          )
          if (!aliasInBaseline) {
            aliasChangeItems.push(item)
            continue
          }
        }
        const eff = computeEffectiveState(working, get().nodes, get().edges, anchor.nodeId, { storyOrder })
        const priorWrapper = readEffectiveAwarenessForTarget(eff, t)
        // Chain-tracked tracking on/off detection — the picker's toggle
        // emits null (off) or empty `{}` (on). Encode as a single
        // tracking history entry, never as per-observer level diffs;
        // observer entries underneath are preserved while tracking is
        // off and reappear when it's flipped back on.
        const priorIsTrackingOff = priorWrapper == null
        if (item.draft == null) {
          if (priorIsTrackingOff) continue   // already off
          const trackingEntry = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            node_id: anchor.nodeId,
            observer_id: '',
            level: null,
            source_action: null,
            source: null,
            tracking_action: 'off',
          }
          const currentAware = readAwarenessAtTarget(working, t)
          const nextAware = appendAwarenessHistoryEntries(currentAware, [trackingEntry])
          working = setAwarenessAtTarget(working, t, nextAware)
          continue
        }
        // Drafted non-null. If prior was tracking-off, the user is
        // flipping it back on — emit a tracking_on event. The diff
        // below applies for any new observer levels in the draft.
        let prefixEntries = []
        if (priorIsTrackingOff) {
          prefixEntries.push({
            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            node_id: anchor.nodeId,
            observer_id: '',
            level: null,
            source_action: null,
            source: null,
            tracking_action: 'on',
          })
        }
        const deltas = diffAwarenessDict(priorWrapper, item.draft)
        if (deltas.length === 0 && prefixEntries.length === 0) continue
        const newEntries = [...prefixEntries, ...buildAwarenessHistoryEntriesFromDeltas(deltas, anchor.nodeId)]
        const currentAware = readAwarenessAtTarget(working, t)
        let nextAware = appendAwarenessHistoryEntries(currentAware, newEntries)
        // Stamp review flags on downstream history entries for each
        // observer this commit touched.
        const observerIds = Array.from(new Set(deltas.filter((d) => !d.source_action && d.entity_id).map((d) => d.entity_id)))
        for (const obs of observerIds) {
          const baseline = nextAware?.entries?.[obs] ?? null
          nextAware = applyDownstreamAwarenessHistoryReviewFlags(
            nextAware, obs, anchor.nodeId, storyOrder, baseline,
          )
        }
        working = setAwarenessAtTarget(working, t, nextAware)
      }
      if (working !== entity) {
        await entitiesStore.updateEntity(entityId, working)
        if (working?.type) chainPostStates.push({ ...working, _bucket: `${working.type}s` })
      }
      // Chain-only-alias path: write per-event `AliasChange` awareness
      // mutations on the EntityRef carrier's `alias_changes` at the
      // anchor. Was previously a legacy `aliases_change` full-list
      // snapshot writer (v0.2.1.x) — migrated to per-event in v0.2.1.89
      // so per-alias awareness rides the same chain mechanism `add` /
      // `remove` / `modify` already use. The walker dispatcher
      // (`narrativeChain.js#applyChangeSet` alias_changes loop, and its
      // backend counterpart) materialises each event into a mutation on
      // the alias's awareness wrapper at chain walk time.
      //
      // Per-item diff: prior chain-resolved awareness vs item.draft →
      // one `awareness_set` event per observer-level delta, plus
      // `awareness_source_*` events per source delta. Same diff helper
      // (`diffAwarenessDict`) the baseline-alias path uses.
      //
      // Same-anchor write merging: the existing alias_changes array on
      // the ref may already carry awareness events from a prior commit at
      // this anchor (e.g. earlier this session). Merge by replacing any
      // existing event matching (action, alias_id, observer_id) or
      // (action, alias_id, source-key) — last write at the same anchor
      // for the same target wins. Matches the normalised-history
      // invariant the participant / scalar paths enforce at write time.
      if (aliasChangeItems.length > 0) {
        const eff = computeEffectiveState(working, get().nodes, get().edges, anchor.nodeId, { storyOrder })
        // Resolve target alias_id by value from effective state. Chain-
        // only aliases carry their id (baked into the AliasChange.add
        // event that introduced them); baseline aliases that somehow
        // landed here also have an id (assigned by the migration shim).
        const effAliasByValue = new Map()
        for (const a of (eff.aliases || [])) {
          if (typeof a === 'string' || !a) continue
          if (a.value && a.id) effAliasByValue.set(a.value, a)
        }
        const newEvents = []
        for (const item of aliasChangeItems) {
          const target = effAliasByValue.get(item.target.aliasValue)
          if (!target) continue   // alias not in effective state at anchor — skip
          const priorWrapper = target.awareness_raw ?? target.awareness ?? null
          const deltas = diffAwarenessDict(priorWrapper, item.draft)
          for (const d of deltas) {
            if (d.source_action) {
              const actionMap = {
                add: 'awareness_source_add',
                remove: 'awareness_source_remove',
                set_level: 'awareness_source_set_level',
              }
              newEvents.push({
                id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
                action: actionMap[d.source_action],
                alias_id: target.id,
                source: { ...d.source },
              })
            } else if (d.entity_id) {
              newEvents.push({
                id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
                action: 'awareness_set',
                alias_id: target.id,
                observer_id: d.entity_id,
                level: d.level,
              })
            }
          }
        }
        if (newEvents.length > 0) {
          set((s) => ({
            nodes: s.nodes.map((n) => {
              if (n.id !== anchor.nodeId) return n
              if (n.type === 'sceneNode') {
                const newData = { ...n.data }
                let updated = false
                for (const bucket of ENTITY_BUCKETS) {
                  const refs = newData[bucket]
                  if (!refs) continue
                  const idx = refs.findIndex((r) => r.entity_id === entityId)
                  if (idx >= 0) {
                    const oldRef = refs[idx]
                    const merged = _mergeAliasAwarenessEvents(oldRef.alias_changes || [], newEvents)
                    newData[bucket] = refs.map((r, i) => i === idx ? { ...r, alias_changes: merged } : r)
                    updated = true
                    break
                  }
                }
                return updated ? { ...n, data: newData } : n
              }
              if (n.type === 'entityNode' && n.data?.entity_id === entityId) {
                const merged = _mergeAliasAwarenessEvents(n.data.alias_changes || [], newEvents)
                return { ...n, data: { ...n.data, alias_changes: merged } }
              }
              return n
            }),
            hasUnsavedChanges: true,
          }))
        }
      }
    }
    if (chainPostStates.length > 0) {
      get()._patchLastHistoryWithExtras({ _entityDataAfter: chainPostStates })
    }

    // Process relationship-host writes
    for (const [relId, relItems] of itemsByRelId) {
      const rel = get().relationships.find((r) => r.id === relId)
      if (!rel) continue
      let working = rel
      for (const item of relItems) {
        const nodeOrder = getRelationshipNodeOrder(rel, get().nodes, get().edges)
        const eff = computeRelationshipEffectiveState(working, nodeOrder, anchor.nodeId, { storyOrder })
        const priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
        const priorIsTrackingOff = priorWrapper == null
        if (item.draft == null) {
          if (priorIsTrackingOff) continue
          const trackingEntry = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            node_id: anchor.nodeId, observer_id: '', level: null,
            source_action: null, source: null, tracking_action: 'off',
          }
          working = { ...working, awareness: appendAwarenessHistoryEntries(working.awareness ?? null, [trackingEntry]) }
          continue
        }
        let prefixEntries = []
        if (priorIsTrackingOff) {
          prefixEntries.push({
            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            node_id: anchor.nodeId, observer_id: '', level: null,
            source_action: null, source: null, tracking_action: 'on',
          })
        }
        const deltas = diffAwarenessDict(priorWrapper, item.draft)
        if (deltas.length === 0 && prefixEntries.length === 0) continue
        const newEntries = [...prefixEntries, ...buildAwarenessHistoryEntriesFromDeltas(deltas, anchor.nodeId)]
        const currentAware = working.awareness ?? null
        let nextAware = appendAwarenessHistoryEntries(currentAware, newEntries)
        const observerIds = Array.from(new Set(deltas.filter((d) => !d.source_action && d.entity_id).map((d) => d.entity_id)))
        for (const obs of observerIds) {
          const baseline = nextAware?.entries?.[obs] ?? null
          nextAware = applyDownstreamAwarenessHistoryReviewFlags(
            nextAware, obs, anchor.nodeId, storyOrder, baseline,
          )
        }
        working = { ...working, awareness: nextAware }
      }
      if (working !== rel) {
        await get().updateRelationship(relId, working)
      }
    }

    // Process knowledge-host writes
    if (itemsByKnowledgeId.size > 0) {
      let nextKnowledges = get().knowledges
      for (const [kid, kItems] of itemsByKnowledgeId) {
        const k = nextKnowledges.find((x) => x.id === kid)
        if (!k) continue
        let working = k
        for (const item of kItems) {
          const nodeOrder = getKnowledgeNodeOrder(working, get().nodes, get().edges)
          const eff = computeKnowledgeEffectiveState(working, nodeOrder, anchor.nodeId, { nodes: get().nodes, ctx: { storyOrder } })
          // Use the wrapper view (`awareness_raw`) so the diff
          // detects source mutations (add / remove / level-change)
          // alongside direct-entry mutations. With the flat
          // `awareness` projection alone, a source removal would
          // never be diffed because `awarenessSources(flat_dict)`
          // returns []. The wrapper preserves direct entries +
          // sources at this anchor and lets `diffAwarenessDict`
          // emit clean `source_action` deltas in both directions.
          const priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
          const priorIsTrackingOff = priorWrapper == null
          if (item.draft == null) {
            if (priorIsTrackingOff) continue
            const trackingEntry = {
              id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
              node_id: anchor.nodeId, observer_id: '', level: null,
              source_action: null, source: null, tracking_action: 'off',
            }
            working = { ...working, awareness: appendAwarenessHistoryEntries(working.awareness ?? null, [trackingEntry]) }
            continue
          }
          let prefixEntries = []
          if (priorIsTrackingOff) {
            prefixEntries.push({
              id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
              node_id: anchor.nodeId, observer_id: '', level: null,
              source_action: null, source: null, tracking_action: 'on',
            })
          }
          const deltas = diffAwarenessDict(priorWrapper, item.draft)
          if (deltas.length === 0 && prefixEntries.length === 0) continue
          const newEntries = [...prefixEntries, ...buildAwarenessHistoryEntriesFromDeltas(deltas, anchor.nodeId)]
          const currentAware = working.awareness ?? null
          let nextAware = appendAwarenessHistoryEntries(currentAware, newEntries)
          const observerIds = Array.from(new Set(deltas.filter((d) => !d.source_action && d.entity_id).map((d) => d.entity_id)))
          for (const obs of observerIds) {
            const baseline = nextAware?.entries?.[obs] ?? null
            nextAware = applyDownstreamAwarenessHistoryReviewFlags(
              nextAware, obs, anchor.nodeId, storyOrder, baseline,
            )
          }
          working = { ...working, awareness: nextAware }
        }
        if (working !== k) {
          nextKnowledges = nextKnowledges.map((x) => x.id === kid ? working : x)
        }
      }
      set({ knowledges: nextKnowledges })
    }

    set({ hasUnsavedChanges: true })
  },


  // Moves childEntityId under newParentEntityId in the location hierarchy.
  // Uses the entity parent_id field (the active hierarchy system throughout the app).
  // newParentEntityId null = remove parent (location becomes top-level).
  createFactionMembership: async (factionId, originNodeId, factionName) => {
    // The membership relationship is "alive" from the faction's origin
    // (the existence_changes entry below) but the faction itself does NOT
    // join its own membership — that was a leftover from an earlier
    // (worse) approach to faction membership and is counter-intuitive
    // to writers. Real members join later via wire-draw / sidebar add.
    // The faction origin node still displays this relationship: the
    // `relationshipsByScene` index in this store includes membership
    // rels via `rel.membership_of`, not via participants.
    return get().createRelationship({
      name: factionName ? `${factionName} Members` : null,
      membership_of: factionId,
      // Explicit creation anchor — without it, anchor-aware lookups
      // (RelationshipDetailView nav-bar, getRelationshipCreationNodeId,
      // etc.) would have to fall back to inferring from
      // participant_changes joins, which are now empty. The fallback
      // also reads `existence_changes`, but setting the field
      // explicitly keeps the lookup path simple and matches the
      // 1.21h+ canonical shape.
      creation_anchor_node_id: originNodeId,
      history: {
        existence_changes: [{ node_id: originNodeId, action: 'activate' }],
        participant_changes: [],
        perception_changes: [], alias_changes: [], role_changes: [], hierarchy_changes: [],
      },
    })
  },

  setHierarchyParent: async (childEntityId, newParentEntityId) => {
    const es = useEntitiesStore.getState()
    const child = es.getEntityById(childEntityId)
    if (!child) return
    if (newParentEntityId) {
      // Reject if the proposed parent is the child itself or a descendant of it (cycle guard).
      // Walk upward from newParentEntityId following existing parent_id links; if we
      // encounter childEntityId before reaching a root, the move would create a cycle.
      let cur = newParentEntityId
      const seen = new Set()
      while (cur && !seen.has(cur)) {
        if (cur === childEntityId) return
        seen.add(cur)
        cur = es.getEntityById(cur)?.parent_id || null
      }
    }
    // Reassigning parent_id mutates entity baseline state — same lifecycle
    // category as renaming or changing description. Use the existing
    // `_entityDataRestore` / `_entityDataAfter` extras pattern (mirrors
    // `removeBaselineAttribute`) so undo restores the prior parent and
    // redo re-applies the new one.
    const oldEntity = { ...child }
    const newEntityData = { ...child, parent_id: newParentEntityId || null }
    if (oldEntity.parent_id === newEntityData.parent_id) return  // no-op
    const entityBucket = oldEntity?.type ? `${oldEntity.type}s` : null
    if (entityBucket) {
      get()._snapshot({ _entityDataRestore: [{ ...oldEntity, _bucket: entityBucket }] })
    } else {
      get()._snapshot()
    }
    await es.updateEntity(childEntityId, newEntityData)
    if (entityBucket) {
      get()._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...newEntityData, _bucket: entityBucket }] })
    }
  },

  /**
   * Update a participant's `initial_perception` across every join event for
   * that entity in the relationship's history. Used when the user edits the
   * perception field on a participant from the Relationship Detail Panel
   * at a creation-node context (no base mirror to write to — the value
   * travels on the join events).
   *
   * Thin wrapper over `setParticipantInitialPerception` in
   * `utils/relationshipHistory.js`.
   */
  setParticipantPerception: async (relId, entityId, perception) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    get()._snapshot()
    return get().updateRelationship(relId, setParticipantInitialPerception(rel, entityId, perception))
  },

  /**
   * Update a participant's `initial_alias_override` across every join event
   * for that entity. Passing an empty string or null clears the override.
   * Thin wrapper over `setParticipantInitialAlias`.
   */
  setParticipantAlias: async (relId, entityId, alias) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    get()._snapshot()
    return get().updateRelationship(relId, setParticipantInitialAlias(rel, entityId, alias))
  },

  // Phase 1.21h Fix #2 — anchor-aware. Takes `atNodeId`; branches
  // internally: at the relationship's creation-node context (atNodeId
  // is null OR resolves to the relationship's creation node via the
  // same heuristic `setRelationshipName` uses) the role mutates the
  // baseline `participant_roles` dict; at any non-creation chain
  // anchor a `role_changes` chain entry is appended via
  // `recordRelationshipChange`. Callers should pass the panel's
  // `currentNodeId` unconditionally; the action makes the routing
  // decision so future call sites can't accidentally rewrite baseline
  // from a non-creation anchor.
  setParticipantRole: (relId, entityId, role, atNodeId = null) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    if (atNodeId) {
      // Phase 1.21h Fix #3 — share the creation-anchor resolution helper
      // with setRelationshipName so the routing decision is consistent.
      const creationNodeId = getRelationshipCreationNodeId(rel, get().nodes, atNodeId)
      if (creationNodeId !== atNodeId) {
        return get().recordRelationshipChange(relId, {
          type: 'role',
          data: { node_id: atNodeId, entity_id: entityId, new_role: role?.value ? role : null },
        })
      }
    }
    get()._snapshot()
    const updRoles = { ...(rel.participant_roles || {}) }
    if (role?.value) updRoles[entityId] = role
    else delete updRoles[entityId]
    return get().updateRelationship(relId, { ...rel, participant_roles: updRoles })
  },

  removeRelationshipChange: (relId, change, nodeId) => {
    const rel = get().relationships.find((r) => r.id === relId)
    if (!rel) return
    // Participant-type changes (join/leave) route through the unified
    // removeParticipant action so the full normalized-history semantics
    // apply: pair-cancel strips the join AND mirror-strips base when the
    // entity has no remaining joins. A plain history-array filter here
    // would leave a dangling base mirror (the §249 desync bug).
    if (change.type === 'participant' && change.action === 'join') {
      return get().removeParticipant(relId, change.entity_id, change.node_id || nodeId)
    }
    const h = rel.history || {}
    let updHistory = { ...h }
    const { type, entity_id, action } = change
    // Phase 1.21c Tier 2 — capture removed entries' change_ids so the
    // cleanup cascade can detect Knowledge attachments to them.
    const removedChangeIds = []
    const captureRemoved = (oldList, newList) => {
      const newIds = new Set((newList || []).map((c) => c?.id).filter(Boolean))
      for (const c of (oldList || [])) {
        if (c?.id && !newIds.has(c.id)) removedChangeIds.push(c.id)
      }
    }
    if (type === 'name') {
      updHistory.name_changes = (h.name_changes || []).filter((c) => c.node_id !== nodeId)
      captureRemoved(h.name_changes, updHistory.name_changes)
    } else if (type === 'existence') {
      updHistory.existence_changes = (h.existence_changes || []).filter((c) => c.node_id !== nodeId)
      captureRemoved(h.existence_changes, updHistory.existence_changes)
    } else if (type === 'participant') {
      // Leave-entry removal: strip via simple filter. Leaves don't touch base.
      updHistory.participant_changes = (h.participant_changes || []).filter(
        (c) => !(c.node_id === nodeId && c.entity_id === entity_id && c.action === action)
      )
      captureRemoved(h.participant_changes, updHistory.participant_changes)
    } else if (type === 'perception') {
      updHistory.perception_changes = (h.perception_changes || []).filter(
        (c) => !(c.node_id === nodeId && c.entity_id === entity_id)
      )
      captureRemoved(h.perception_changes, updHistory.perception_changes)
    } else if (type === 'alias') {
      updHistory.alias_changes = (h.alias_changes || []).filter(
        (c) => !(c.node_id === nodeId && c.entity_id === entity_id)
      )
      captureRemoved(h.alias_changes, updHistory.alias_changes)
    } else if (type === 'role') {
      updHistory.role_changes = (h.role_changes || []).filter(
        (c) => !(c.node_id === nodeId && c.entity_id === entity_id)
      )
      captureRemoved(h.role_changes, updHistory.role_changes)
    } else if (type === 'hierarchy') {
      updHistory.hierarchy_changes = (h.hierarchy_changes || []).filter((c) => c.node_id !== nodeId)
      captureRemoved(h.hierarchy_changes, updHistory.hierarchy_changes)
    }
    const updRel = { ...rel, history: updHistory }
    // Auto-delete if this removal drained the relationship of every participant and
    // every history entry — an orphaned shell with nothing to show or track.
    // deleteRelationship handles its own snapshot with _relationshipRestore for undo.
    if (_isRelationshipEmpty(updRel)) {
      const result = get().deleteObject('relationship', relId)
      if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
      return result
    }
    get()._snapshot()
    const result = get().updateRelationship(relId, updRel)
    if (removedChangeIds.length) get()._runEventRemovalCascade(removedChangeIds)
    return result
  },

  /**
   * Phase 3.10 Layer 5 item #8 — apply an AI-scene-wiring refinement
   * diff to the canvas. Mirrors the backend `apply_refinement_diff`
   * helper in `services/scene_wiring.py` so the in-memory frontend
   * state stays consistent with what /apply just wrote to
   * `state.story`. Called by `SceneRefinementModal` after the
   * backend confirms the apply succeeded.
   *
   * Diff shape (matches the /refine + /apply payload):
   *   { scene_diffs: [{
   *       scene_uuid,
   *       chip_changes: [{ kind: 'add'|'remove', entity_type,
   *                        entity_id, entity_name }],
   *       pov_change:   null | { new_pov_entity_id,
   *                              new_pov_entity_name,
   *                              previous_pov_entity_id },
   *     }] }
   *
   * Mutations are scene-baseline only — the scene IS its own
   * anchor, and chips + pov_entity_id are SceneNode fields. No
   * entity-chain-tracked values are touched here. `has_pov` flips
   * on EntityRefs (the scene's per-character chain entries), not
   * the entity baseline.
   *
   * Returns the number of scene nodes actually mutated.
   */
  applyRefinementDiff: (diff) => {
    if (!diff || !Array.isArray(diff.scene_diffs) || diff.scene_diffs.length === 0) return 0
    get()._snapshot()
    const sceneTypeFields = {
      character: 'characters',
      location:  'locations',
      item:      'items',
      faction:   'factions',
      custom:    'customs',
    }
    let touched = 0
    // Collect every entity_id touched by this diff (chip add OR
    // chip remove). After all node mutations land we do a single
    // chain-repair pass per affected entity — rebuild the entity's
    // chip-chain edges from scratch using the import's scene-order
    // rule (chapter index, then position.x). This mirrors the
    // backend `_repair_entity_chain` in `services/scene_wiring.py`
    // so the canvas + backend state stay consistent regardless of
    // which side first observes the change.
    const affectedEntityIds = new Set()
    set((state) => {
      const byUuid = new Map(diff.scene_diffs.map((sd) => [sd.scene_uuid, sd]))
      const nextNodes = state.nodes.map((n) => {
        if (n.type !== 'sceneNode') return n
        const sd = byUuid.get(n.id)
        if (!sd) return n
        let mutated = false
        const data = { ...n.data }
        // Chip changes per type.
        for (const change of (sd.chip_changes || [])) {
          const field = sceneTypeFields[change.entity_type]
          if (!field) continue
          const list = Array.isArray(data[field]) ? [...data[field]] : []
          if (change.kind === 'add') {
            if (list.some((ref) => ref.entity_id === change.entity_id)) continue
            list.push({
              entity_id: change.entity_id,
              name_change: null, colour_change: null, description_change: null,
              profile_image_change: null, attribute_changes: [], awareness_changes: [],
              has_pov: false,
            })
            data[field] = list
            mutated = true
            affectedEntityIds.add(change.entity_id)
          } else if (change.kind === 'remove') {
            const idx = list.findIndex((ref) => ref.entity_id === change.entity_id)
            if (idx === -1) continue
            list.splice(idx, 1)
            data[field] = list
            mutated = true
            affectedEntityIds.add(change.entity_id)
          }
        }
        // POV change — strip has_pov from prior POV character, set
        // on new POV character, update SceneNode.pov_entity_id.
        if (sd.pov_change) {
          const prevId = sd.pov_change.previous_pov_entity_id || null
          const newId  = sd.pov_change.new_pov_entity_id || null
          if (Array.isArray(data.characters)) {
            data.characters = data.characters.map((ref) => {
              if (prevId && ref.entity_id === prevId && ref.has_pov) {
                return { ...ref, has_pov: false }
              }
              if (newId && ref.entity_id === newId && !ref.has_pov) {
                return { ...ref, has_pov: true }
              }
              return ref
            })
          }
          if (data.pov_entity_id !== newId) {
            data.pov_entity_id = newId
            mutated = true
          }
        }
        if (mutated) {
          touched += 1
          return { ...n, data }
        }
        return n
      })
      // ── Chain-repair pass ──────────────────────────────────────
      // For every entity whose chips changed, rebuild that entity's
      // chip-chain edges from scratch:
      //   1. Strip every existing chip-chain edge whose
      //      source_entity_id matches the affected entity (POV +
      //      relationship edges left alone).
      //   2. Walk scenes in canvas order (chapter index, then x).
      //   3. For each scene that NOW carries the entity's chip,
      //      wire from `previous_carrier_or_SetupNode → this scene`
      //      with the canonical transition-edge shape — same as
      //      the import pipeline's `_wire_connections` and the
      //      backend's `_repair_entity_chain`.
      let nextEdges = state.edges
      if (affectedEntityIds.size > 0) {
        // Build scene order using the same canvas-x rule as the
        // backend (`_compute_scene_order_ids` in scene_wiring.py).
        const chapters = state.story?.chapters || []
        const chapterIndex = new Map(chapters.map((ch, i) => [ch.id, i]))
        const xOffset = state.story?.chapter_x_offset ?? 10
        const sceneNodesById = new Map(
          nextNodes.filter((n) => n.type === 'sceneNode').map((n) => [n.id, n]),
        )
        const sceneOrderIds = Array.from(sceneNodesById.keys()).sort((a, b) => {
          const na = sceneNodesById.get(a)
          const nb = sceneNodesById.get(b)
          const chA = chapterIndex.get(getChapterIdForNode(na, chapters, xOffset)) ?? chapters.length
          const chB = chapterIndex.get(getChapterIdForNode(nb, chapters, xOffset)) ?? chapters.length
          if (chA !== chB) return chA - chB
          return (na.position?.x ?? 0) - (nb.position?.x ?? 0)
        })

        // 1. Drop every existing chip-chain edge for the affected
        //    entities. POV (is_pov_path) and relationship
        //    (is_relationship) edges stay intact.
        nextEdges = state.edges.filter((e) => {
          const eid = e.data?.source_entity_id
          if (!eid || !affectedEntityIds.has(eid)) return true
          if (e.data?.is_pov_path) return true
          if (e.data?.is_relationship) return true
          return false
        })

        // 2. Look up each affected entity's origin EntityNode (the
        //    SetupNode the chain starts at). Non-modifier
        //    entityNodes only — modifier nodes are downstream stops.
        const setupNodeByEntityId = new Map()
        for (const n of nextNodes) {
          if (n.type !== 'entityNode') continue
          const eid = n.data?.entity_id
          if (!eid) continue
          if (n.data?.is_modifier) continue
          if (!setupNodeByEntityId.has(eid)) setupNodeByEntityId.set(eid, n.id)
        }

        // 3. For each affected entity, walk the scene order and
        //    create the chain edges.
        const sceneTypeBuckets = ['characters', 'locations', 'items', 'factions', 'customs']
        const sceneHasChip = (scene, eid) => {
          for (const bk of sceneTypeBuckets) {
            const refs = scene.data?.[bk] || []
            if (refs.some((r) => r.entity_id === eid)) return true
          }
          return false
        }
        const newEdges = []
        for (const eid of affectedEntityIds) {
          let prevNodeId = setupNodeByEntityId.get(eid) || null
          for (const sid of sceneOrderIds) {
            const scene = sceneNodesById.get(sid)
            if (!scene || !sceneHasChip(scene, eid)) continue
            if (prevNodeId) {
              const edgeId = `flow-${prevNodeId}-${sid}-${eid}`
              newEdges.push({
                id: edgeId,
                source: prevNodeId,
                target: sid,
                sourceHandle: eid,
                targetHandle: `chip-in-${eid}`,
                type: 'transitionEdge',
                data: {
                  id: edgeId,
                  source_node_id: prevNodeId,
                  target_node_id: sid,
                  source_entity_id: eid,
                  is_pov_path: false,
                  target_handle_id: `chip-in-${eid}`,
                },
              })
            }
            prevNodeId = sid
          }
        }
        if (newEdges.length > 0) nextEdges = [...nextEdges, ...newEdges]
      }
      return { nodes: nextNodes, edges: nextEdges, hasUnsavedChanges: true }
    })
    return touched
  },
})))
