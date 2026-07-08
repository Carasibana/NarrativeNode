/**
 * buildStoryTimelineView — Phase 1.12c Track 2.
 *
 * Pure JS port of the backend `entity_import_service.build_import_preview`
 * pipeline, sourced from the live project store instead of a
 * freshly-parsed project file. Produces an `ImportPreview`-shaped
 * object so the shared `TimelineGridView` component can render it
 * without caring whether the grid came from an import upload or the
 * current project.
 *
 * **Pure transformation — no React / Zustand imports**. The caller
 * (Navigator component) passes in the already-computed POV sequence
 * so this file can be loaded under plain Node for unit testing
 * without pulling in the React tree via povSequence.js's `usePovChain`
 * hook. The Navigator runs `computePovChain(nodes, edges)` itself
 * via `usePovChain` (or directly) and passes `.sequence` here.
 *
 * Inputs:
 *   - story        — the Story object from `projectStore.story`.
 *                    Provides entities, chapters, acts, scenes,
 *                    entity_nodes.
 *   - povSequence  — the `{ nodeId, povEntityId, index }[]` array from
 *                    `computePovChain(nodes, edges).sequence`. Pass an
 *                    empty array when there's no POV chain — all
 *                    scenes land as non-POV sorted by canvas x.
 *
 * Returns an object with the same shape the `ImportTimelineGrid` /
 * `TimelineGridView` components consume:
 *
 *   {
 *     session_id: null,                      // no preview session for live data
 *     source_filename: null,                 // not loaded from a file
 *     story_title, story_author, story_genre,
 *     columns: [ ImportSceneColumn, ... ],
 *     chapters: [ ImportChapterMarker, ... ],
 *     acts: [ ImportActMarker, ... ],
 *     entities: [ ImportEntityRow, ... ],
 *     preset_lists: [],                      // navigator doesn't need these
 *   }
 *
 * **Asset URLs**: `profile_image_data_uri` on each entity row is set
 * to a direct `/api/project/assets/<filename>` URL instead of a
 * base64 data URI. The field name is inherited from the backend
 * preview shape; the `<img src>` attribute doesn't care whether
 * the value is a data URI or an HTTP URL, so the import dialog's
 * existing `GridThumb` + `ImageHoverPreview` rendering path Just
 * Works. Renaming the field to `profile_image_src` would be cleaner
 * but would also churn the import dialog and backend unnecessarily
 * for a cosmetic win.
 *
 * **Chapter membership** is computed via `getChapterIdForNode` using
 * the story's `chapter_x_offset` (default 10 to match the overlay's
 * canvas alignment). Chapters are laid out left-to-right starting
 * at `chapter_x_offset`; each chapter's width drives its right edge.
 *
 * **Modifier dots** come from `story.entity_nodes` filtered to
 * `is_modifier=true` + matching `entity_id`. Same canvas-x sort as
 * the backend so dots interleave with scenes in visual chain order.
 *
 * This file has no React imports — it's pure data transformation.
 * Unit test via a small in-memory fixture (see the test file).
 */

import { resolveChapterIdForNode } from './chapterMembership.js'
import { rowGeometryParams, multirowHeaderRowsForStory } from './rowLayout.js'
import { computeEffectiveState, getEntityNarrativeChain } from './narrativeChain.js'
import { ENTITY_BUCKETS } from './entityHelpers.js'
import { getMeasuredWidth } from './measuredDimensionsStore.js'

// ── Live story snapshot helper ───────────────────────────────────

/**
 * Build a "live story snapshot" — a story-shaped object whose
 * `scenes`, `entity_nodes`, and `entities` fields reflect
 * the CURRENT React Flow + entitiesStore state, NOT the last-saved
 * `story` object. The Phase 1.12c Timeline Navigator passes the
 * result to `buildStoryTimelineView` so the grid recomputes
 * immediately when the user drags a scene to a new chapter, wires
 * a new entity connection, renames an entity in the library, etc.
 *
 * Without this snapshot, `buildStoryTimelineView` reads stale data
 * from `story.scenes` / `story.entity_nodes` /
 * `story.entities` (only updated on save / load / explicit sync),
 * and the Navigator visibly lags behind the canvas — the bug
 * fixed in v0.1.12.47.
 *
 * Mirrors the field-pull pattern used by `buildStoryPayload` in
 * `projectStore.js` but only for the fields that
 * `buildStoryTimelineView` actually reads: positions + widths for
 * chapter membership, EntityRef buckets for dot placement,
 * is_modifier + entity_id for modifier dot grouping, entity
 * library buckets for row identity.
 *
 * Inputs:
 *   - story         — the static `projectStore.story` object
 *                     (provides title / author / genre / chapters /
 *                     acts / chapter_x_offset).
 *   - nodes         — the live React Flow `nodes` array.
 *   - edges         — the live React Flow `edges` array. Used to
 *                     walk each entity's narrative chain via
 *                     `getEntityNarrativeChain` so modifier dot
 *                     placement can use chain order (NOT canvas x)
 *                     to determine which two scenes bracket each
 *                     modifier — so dragging a modifier node to
 *                     the right of its "right" scene doesn't
 *                     visually re-bracket it (v0.1.12.53 fix).
 *   - liveEntities  — `{ characters, locations, items, factions, customs }`
 *                     pulled from `useEntitiesStore`. Provides the
 *                     live entity library after CRUD edits.
 *
 * Returns a story-shaped object suitable for direct use by
 * `buildStoryTimelineView`. Returns null when `story` is null.
 *
 * The snapshot carries an internal `_modifierBracketing` field —
 * a `{ entityId: { modifierNodeId: { leftSceneId, rightSceneId } } }`
 * map produced by walking each entity's narrative chain. This is
 * a private channel between this helper and `buildStoryTimelineView`'s
 * `buildEntityRows`; consumers (TimelineGridView) read it via the
 * `chain_left_scene_id` / `chain_right_scene_id` fields the row
 * builder attaches to each modifier dot.
 */
export function buildLiveStorySnapshot(story, nodes, edges, liveEntities) {
  if (!story) return null
  const safeNodes = nodes || []
  const safeEdges = edges || []

  // Pull plot point nodes from the live RF nodes array, converting
  // each into the shape `_build_columns` / `_build_entity_rows`
  // expect (top-level position + width + EntityRef buckets pulled
  // from `n.data`). The static `story.scenes` is NOT
  // used because it lags behind canvas edits.
  const liveSceneNodes = safeNodes
    .filter((n) => n.type === 'sceneNode')
    .map((n) => ({
      ...n.data,
      id: n.id,
      position: { x: n.position?.x || 0, y: n.position?.y || 0 },
      // Width fallback chain matches getChapterIdForNode's reader
      // so chapter membership picks up resizes immediately.
      width: n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 0,
    }))

  // Pull entity nodes (origin + modifier) the same way. The
  // modifier-dot builder reads `is_modifier` + `entity_id` +
  // `position` from each entity_node entry.
  const liveEntityNodes = safeNodes
    .filter((n) => n.type === 'entityNode')
    .map((n) => ({
      ...n.data,
      id: n.id,
      position: { x: n.position?.x || 0, y: n.position?.y || 0 },
    }))

  // Build a per-entity modifier bracketing map by walking each
  // entity's narrative chain. For each modifier in the chain, the
  // `leftSceneId` is the most recent plot point seen before it,
  // and `rightSceneId` is the first plot point seen after it.
  // Modifiers before any scene get leftSceneId=null; modifiers
  // after the last scene get rightSceneId=null. The chain walker
  // is the single source of truth for the entity's wiring order
  // (NOT canvas x), so dragging a modifier node anywhere on the
  // canvas doesn't re-bracket it visually.
  const modifierBracketing = {}
  // Per-entity effective state at each chain point + the final
  // chain state. Shape: { entityId: { nodeId: { colour, profile_image_ref } },
  //                                   __final__: { colour, profile_image_ref } } }
  // Consumed by `buildEntityRows` to attach `effective_colour` +
  // `effective_profile_image_data_uri` per dot and to populate the
  // row's `final_colour` + `final_profile_image_data_uri` fields.
  // Uses `computeEffectiveState` from narrativeChain.js — the
  // canonical per-entity chain walker that respects actual wire
  // topology (not POV order), so the grid reflects whatever the
  // EntityChipDetailView would show if the user clicked into the
  // same chip. Phase 1.12c v0.1.12.57.
  const effectiveDotState = {}
  const allLiveEntities = [
    ...(liveEntities?.characters || []),
    ...(liveEntities?.locations  || []),
    ...(liveEntities?.items      || []),
    ...(liveEntities?.factions   || []),
    ...(liveEntities?.customs    || []),
  ]
  for (const ent of allLiveEntities) {
    const chain = getEntityNarrativeChain(ent.id, safeNodes, safeEdges)
    if (!chain || chain.length < 2) continue  // no chain to walk
    let lastSceneId = null
    const pendingMods = []  // modifier ids waiting for a right scene
    const entBracketing = {}
    const entEffective = {}
    for (const node of chain) {
      if (node.type === 'sceneNode') {
        // Fill in the right scene for any modifier that didn't
        // have one yet.
        for (const modId of pendingMods) {
          entBracketing[modId].rightSceneId = node.id
        }
        pendingMods.length = 0
        lastSceneId = node.id
        // Compute effective state at this scene.
        const eff = computeEffectiveState(ent, safeNodes, safeEdges, node.id)
        entEffective[node.id] = {
          name: eff.name,
          colour: eff.colour,
          profile_image_ref: eff.profile_image_ref,
        }
      } else if (node.type === 'entityNode' && node.data?.is_modifier) {
        entBracketing[node.id] = {
          leftSceneId: lastSceneId,
          rightSceneId: null,
        }
        pendingMods.push(node.id)
        // Compute effective state at this modifier node.
        const eff = computeEffectiveState(ent, safeNodes, safeEdges, node.id)
        entEffective[node.id] = {
          name: eff.name,
          colour: eff.colour,
          profile_image_ref: eff.profile_image_ref,
        }
      }
      // chain[0] is the entity origin entityNode (is_modifier === false).
      // It's not a scene and not a modifier — skip (no bracketing change).
    }
    if (Object.keys(entBracketing).length > 0) {
      modifierBracketing[ent.id] = entBracketing
    }
    // Final chain state — effective state at the last node in the
    // chain. Lets the row builder populate `final_colour` +
    // `final_profile_image_data_uri` on the row so the bookend
    // Final dot + identity cell (when the user picks Final) show
    // the accumulated effective state.
    if (chain.length > 0) {
      const lastNode = chain[chain.length - 1]
      const eff = computeEffectiveState(ent, safeNodes, safeEdges, lastNode.id)
      entEffective.__final__ = {
        name: eff.name,
        colour: eff.colour,
        profile_image_ref: eff.profile_image_ref,
      }
    }
    if (Object.keys(entEffective).length > 0) {
      effectiveDotState[ent.id] = entEffective
    }
  }

  return {
    ...story,
    entities: liveEntities || story.entities || {},
    scenes: liveSceneNodes,
    entity_nodes: liveEntityNodes,
    _modifierBracketing: modifierBracketing,
    _effectiveDotState: effectiveDotState,
  }
}

// ── Entity iteration helpers ─────────────────────────────────────

// Bucket-key-to-singular-type map. Keys come from ENTITY_BUCKETS (source of
// truth); the `type` singular is per-bucket metadata that stays local.
const BUCKET_TYPE_MAP = {
  characters: 'character',
  locations:  'location',
  items:      'item',
  factions:   'faction',
  customs:    'custom',
}
const BUCKET_ORDER = ENTITY_BUCKETS.map((key) => ({ key, type: BUCKET_TYPE_MAP[key] }))

/**
 * Iterate every entity in the library in a stable order (characters
 * first, then locations, items, factions, customs). Returns an array
 * of `[entity, typeName]` tuples so the caller can build rows without
 * re-branching on bucket name.
 */
function iterEntitiesInLibraryOrder(story) {
  const out = []
  const entities = story?.entities || {}
  for (const { key, type } of BUCKET_ORDER) {
    const bucket = entities[key] || []
    for (const ent of bucket) out.push([ent, type])
  }
  return out
}

/**
 * True when `node` has at least one EntityRef for `entityId` across
 * any of its five buckets. Mirrors `_node_has_entity_ref` on the
 * backend.
 */
function nodeHasEntityRef(node, entityId) {
  if (!node) return false
  for (const { key } of BUCKET_ORDER) {
    const refs = node[key] || []
    for (const ref of refs) {
      if (ref.entity_id === entityId) return true
    }
  }
  return false
}

// ── Column builder ───────────────────────────────────────────────

/**
 * Build the grid's scene-column list:
 *   - POV-chain scenes first, in chain order (1, 2, 3, …)
 *   - Non-POV scenes after, in global Story Order (or canvas x as fallback)
 *
 * Mirrors `entity_import_service._build_columns` but takes a
 * pre-computed POV sequence from the caller (keeps this file free
 * of React imports so it can be unit-tested under plain Node).
 *
 * When `storyOrder` (result of `computeStoryOrder` / `useStoryOrder`)
 * is provided, the non-POV tail is ordered by filtering
 * `storyOrder.orderedIds` to the non-POV plot-point-node subset — so
 * non-POV scenes land in the same order the global Story Order page
 * shows them, not canvas-x order. When `storyOrder` is omitted, the
 * function falls back to the legacy canvas-x sort for backwards
 * compatibility with non-hook callers (tests, backend-built previews).
 */
function buildColumns(story, povSequence, storyOrder, regressedNodeIds = null) {
  const scenesById = new Map()
  for (const node of (story?.scenes || [])) {
    scenesById.set(node.id, node)
  }

  // POV index lookup: nodeId -> 1-based POV chain index, for the is_pov_chain /
  // chain_index fields on emitted columns. Every scene column gets its POV
  // status and index from this map regardless of emission order.
  const povIndexById = new Map()
  for (const entry of (povSequence || [])) {
    if (entry?.nodeId) povIndexById.set(entry.nodeId, entry.index || 0)
  }

  const makeColumn = (node) => ({
    id: node.id,
    title: (node.title || node.description || 'Untitled Scene').trim() || 'Untitled Scene',
    chapter_id: null,  // resolved below
    is_pov_chain: povIndexById.has(node.id),
    chain_index: povIndexById.get(node.id) ?? null,
    canvas_x: node.position?.x || 0,
    is_chain_regressed: false,  // resolved below (POV-chain columns only)
  })

  let columns
  if (storyOrder && Array.isArray(storyOrder.orderedIds)) {
    // Global Story Order: emit every plot-point node in orderedIds order,
    // interleaving POV and non-POV scenes by their global positions. POV
    // status is still marked via povIndexById so downstream consumers can
    // style / group by it, but it does not drive emission order.
    columns = []
    const emitted = new Set()
    for (const id of storyOrder.orderedIds) {
      const node = scenesById.get(id)
      if (!node) continue
      columns.push(makeColumn(node))
      emitted.add(id)
    }
    // Append any plot-point nodes the global order didn't place (defensive —
    // excluded node types are filtered, but every plot-point should be ranked).
    for (const node of (story?.scenes || [])) {
      if (!emitted.has(node.id)) columns.push(makeColumn(node))
    }
  } else {
    // Fallback for non-hook callers (tests, backend-built previews): legacy
    // POV-first-then-canvas-x emission order.
    columns = []
    const povEmitted = new Set()
    for (const entry of (povSequence || [])) {
      const node = scenesById.get(entry.nodeId)
      if (!node) continue
      povEmitted.add(node.id)
      columns.push(makeColumn(node))
    }
    const nonPov = []
    for (const node of (story?.scenes || [])) {
      if (!povEmitted.has(node.id)) nonPov.push(node)
    }
    nonPov.sort((a, b) => (a.position?.x || 0) - (b.position?.x || 0))
    for (const node of nonPov) columns.push(makeColumn(node))
  }

  // Resolve chapter_id for each column using the frontend chapter
  // membership helper. Matches the backend's port of the same logic
  // (both read node.position.x + node.width + chapters + offset).
  const chapters  = story?.chapters || []
  const xOffset   = typeof story?.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
  // Mode-aware chapter membership: in multi-row a node's live position is its
  // per-row display position, so the single-row x-only resolver reads the wrong
  // chapter. The dispatcher uses the 2D resolver in multi-row, x-only in single.
  const _geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
  const _memberOpts = {
    mode: story?.canvas_layout_mode || 'single',
    chapterRows: story?.chapter_rows || null,
    xOffset,
    rowsTopY: _geom.rowsTopY,
    rowGap: _geom.rowGap,
  }
  for (const col of columns) {
    const node = scenesById.get(col.id)
    col.chapter_id = resolveChapterIdForNode(node, chapters, _memberOpts)
  }

  // POV-chain regression flag comes from the canonical `pov_chapter_order`
  // alert set (passed in via usePovOrderRegressedNodeIds), NOT re-derived here.
  // A prior inline copy of the regression walk lived here and silently drifted
  // from the alert when the canonical check became multi-row-aware (it kept the
  // single-row x-only resolver and false-flagged in multi-row). One calculator,
  // many consumers: alerts panel, scene-node badge, and this timeline.
  if (regressedNodeIds && regressedNodeIds.size > 0) {
    for (const col of columns) {
      if (col.is_pov_chain && regressedNodeIds.has(col.id)) col.is_chain_regressed = true
    }
  }

  return columns
}

// ── Chapter / act markers ────────────────────────────────────────

/**
 * Build chapter markers by walking columns in display order and
 * emitting one marker per **contiguous run** of columns sharing the
 * same chapter_id. Contiguous runs collapse into a single marker
 * (the common case); non-contiguous chapters (e.g. a POV scene
 * dragged into an earlier chapter, sandwiched between later-chapter
 * scenes) emit MULTIPLE markers, one per disjoint run.
 *
 * Each marker carries the canonical `id` of its chapter (used by
 * downstream click handlers to look up the chapter's static x range
 * via `story.chapters`). When multiple markers come from the same
 * chapter they share the `id` field, so the React render in
 * `TimelineGridView` uses a compound key `${id}-${first_column_id}`
 * to keep keys unique.
 *
 * Columns with `chapter_id == null` (scenes outside every chapter)
 * BREAK the current run — the chapter banner above doesn't visually
 * cover an unchaptered column. The next chaptered column starts a
 * new marker.
 *
 * Chapters that don't have any columns in the grid simply produce
 * zero markers — same as before.
 */
function buildChapterMarkers(story, columns) {
  const chapters = story?.chapters || []
  if (chapters.length === 0) return []
  const chapterById = new Map()
  chapters.forEach((ch, i) => chapterById.set(ch.id, { ...ch, _number: i + 1 }))

  const markers = []
  let currentRun = null
  for (const col of columns) {
    const cid = col.chapter_id
    if (!cid) {
      // Unchaptered column → break any current run.
      if (currentRun) { markers.push(currentRun); currentRun = null }
      continue
    }
    if (currentRun && currentRun.id === cid) {
      // Extend the current run to cover this column too.
      currentRun.last_column_id = col.id
      continue
    }
    // Chapter changed (or first chapter we've seen) → close the
    // previous run and start a new one. Skip chapters not in the
    // chapter list (defensive — shouldn't happen since chapter_id
    // came from the same list).
    if (currentRun) markers.push(currentRun)
    const ch = chapterById.get(cid)
    if (!ch) { currentRun = null; continue }
    currentRun = {
      id: ch.id,
      title: ch.title || `Chapter ${ch._number}`,
      number: ch._number,
      // Carry the user-set chapter colour through so the navigator's
      // banner row can tint each segment with the same colour the
      // canvas uses for the chapter band. Null → caller falls back
      // to a default zinc tint.
      colour: ch.colour || null,
      first_column_id: col.id,
      last_column_id: col.id,
    }
  }
  if (currentRun) markers.push(currentRun)
  return markers
}

/**
 * Build act markers by walking columns in display order and emitting
 * one marker per **contiguous run** of columns whose chapter belongs
 * to the same act. Same rationale as `buildChapterMarkers`: contiguous
 * acts collapse into a single marker; an act split by a
 * regression-induced chapter shuffle emits multiple markers.
 *
 * Walks columns directly (NOT chapter markers) so the act run logic
 * stays consistent with the chapter run logic — both walk the same
 * sequence and break on the same boundaries (unchaptered columns,
 * chapter changes that move into a different act).
 */
function buildActMarkers(story, columns) {
  const acts = story?.acts || []
  if (acts.length === 0) return []
  // Build a chapter_id → { actId, title, colour, _number } lookup.
  const actByChapter = new Map()
  acts.forEach((act, i) => {
    for (const cid of (act.chapter_ids || [])) {
      actByChapter.set(cid, {
        id: act.id,
        title: act.title,
        colour: act.colour || null,
        _number: i + 1,
      })
    }
  })

  const markers = []
  let currentRun = null
  for (const col of columns) {
    const cid = col.chapter_id
    if (!cid) {
      if (currentRun) { markers.push(currentRun); currentRun = null }
      continue
    }
    const actInfo = actByChapter.get(cid)
    if (!actInfo) {
      // Chapter not in any act — break the run.
      if (currentRun) { markers.push(currentRun); currentRun = null }
      continue
    }
    if (currentRun && currentRun.id === actInfo.id) {
      currentRun.last_column_id = col.id
      continue
    }
    if (currentRun) markers.push(currentRun)
    currentRun = {
      id: actInfo.id,
      title: actInfo.title || `Act ${actInfo._number}`,
      number: actInfo._number,
      // Carry the user-set act colour — same reason as chapter
      // markers above. Matches the colour applied in the canvas
      // act header overlay.
      colour: actInfo.colour || null,
      first_column_id: col.id,
      last_column_id: col.id,
    }
  }
  if (currentRun) markers.push(currentRun)
  return markers
}

// ── Entity rows ──────────────────────────────────────────────────

/**
 * For every entity in the library, emit an `ImportEntityRow`-shaped
 * object with:
 *   - identity fields (id / name / type / colour / description)
 *   - profile_image_data_uri: the `/api/project/assets/<filename>`
 *     URL for the entity's profile image, or null
 *   - dots[]: combined scene + modifier dots sorted by canvas x,
 *     with 1-based chain_index assigned in sorted order
 *   - preset_list_ids_used[]: preset_list ids referenced by the
 *     entity's preset-type attributes at origin state
 */
function buildEntityRows(story, columns, storyOrder) {
  const scenesById = new Map()
  for (const node of (story?.scenes || [])) {
    scenesById.set(node.id, node)
  }

  // Precompute a global-order index lookup for the per-entity dot
  // ordering below. When `storyOrder` is provided, each entity's
  // combined scene + modifier dot list is sorted by walking
  // `storyOrder.orderedIds` and assigning 1-based `chain_index` in
  // global-order position instead of canvas-x position. This aligns
  // the modifier dot ordering with the Story Order page so moving a
  // modifier node on the canvas doesn't re-order it visually.
  const globalIndexById = (storyOrder && Array.isArray(storyOrder.orderedIds))
    ? new Map(storyOrder.orderedIds.map((id, i) => [id, i]))
    : null

  // Group modifier nodes by the entity they modify so the row loop
  // is O(1) per entity.
  const modifiersByEntity = new Map()
  for (const node of (story?.entity_nodes || [])) {
    if (!node.is_modifier) continue
    if (!node.entity_id) continue
    const list = modifiersByEntity.get(node.entity_id) || []
    list.push(node)
    modifiersByEntity.set(node.entity_id, list)
  }

  // Helper — convert a `profile_image_ref` (either `assets/foo.png`
  // or bare `foo.png`) to the `/api/project/assets/<file>` URL the
  // frontend uses. Returns null when the ref is missing.
  const refToAssetUrl = (ref) => {
    if (!ref) return null
    const filename = ref.startsWith('assets/') ? ref.slice('assets/'.length) : ref
    return `/api/project/assets/${filename}`
  }

  const rows = []
  for (const [entity, typeName] of iterEntitiesInLibraryOrder(story)) {
    const candidates = []
    const entEffective = story?._effectiveDotState?.[entity.id]

    // Scene dots: one per column where the entity has an EntityRef.
    for (const col of columns) {
      const node = scenesById.get(col.id)
      if (!node) continue
      if (nodeHasEntityRef(node, entity.id)) {
        const dot = {
          column_id: col.id,
          is_modifier: false,
          modifier_node_id: null,
          chain_index: 0,  // filled in below
          canvas_x: node.position?.x || 0,
        }
        // Attach per-dot effective colour + profile image from the
        // live chain walk (Phase 1.12c v0.1.12.57) so the grid can
        // render each scene dot in the entity's effective colour at
        // that chain point, and so the identity cell / importer
        // preview pane can show the effective profile image when
        // the user picks this dot.
        const eff = entEffective?.[col.id]
        if (eff) {
          dot.effective_name = eff.name || null
          dot.effective_colour = eff.colour || null
          dot.effective_profile_image_data_uri = refToAssetUrl(eff.profile_image_ref)
        }
        candidates.push(dot)
      }
    }

    // Modifier dots: one per entity_node with is_modifier=true and
    // matching entity_id. Dots carry the source modifier node's
    // canvas x for fallback positioning, plus chain-order
    // bracketing scene ids when the snapshot has them. The shared
    // view's `placeModifierDots` helper prefers chain bracketing
    // over canvas-x bracketing, so dragging a modifier node anywhere
    // on the canvas doesn't visually re-bracket it (v0.1.12.53 fix).
    const entBracketing = story?._modifierBracketing?.[entity.id]
    const mods = modifiersByEntity.get(entity.id) || []
    for (const mod of mods) {
      const dot = {
        column_id: null,
        is_modifier: true,
        modifier_node_id: mod.id,
        chain_index: 0,
        canvas_x: mod.position?.x || 0,
      }
      const bracket = entBracketing?.[mod.id]
      if (bracket) {
        // Attach chain-order bracketing when available. Both fields
        // can be null (modifier before any scene → leftSceneId=null;
        // modifier after the last scene → rightSceneId=null). The
        // placement helper handles those edge cases by snapping to
        // the strip's left/right edge respectively.
        dot.chain_left_scene_id  = bracket.leftSceneId
        dot.chain_right_scene_id = bracket.rightSceneId
      }
      // Per-dot effective state for modifier picks. Modifier dots
      // render amber regardless of effective colour (conventional
      // "state-change" marker), but the identity cell + preview
      // pane read these fields when the user picks a modifier dot.
      const effMod = entEffective?.[mod.id]
      if (effMod) {
        dot.effective_name = effMod.name || null
        dot.effective_colour = effMod.colour || null
        dot.effective_profile_image_data_uri = refToAssetUrl(effMod.profile_image_ref)
      }
      candidates.push(dot)
    }

    // Sort combined dots in global Story Order (scenes by their own
    // id; modifier dots by their modifier node id), with canvas-x as
    // a fallback when no `storyOrder` is supplied. 1-based chain_index
    // is assigned in the final sort order. Entries the global order
    // doesn't place fall back to canvas-x relative to placed entries
    // (conservative — should not trigger in practice since every
    // scene / modifier node is tier-ranked by computeStoryOrder).
    if (globalIndexById) {
      const idForDot = (dot) => (dot.is_modifier ? dot.modifier_node_id : dot.column_id)
      const BIG = Number.MAX_SAFE_INTEGER
      candidates.sort((a, b) => {
        const ai = globalIndexById.get(idForDot(a))
        const bi = globalIndexById.get(idForDot(b))
        const aRank = (ai == null ? BIG : ai)
        const bRank = (bi == null ? BIG : bi)
        if (aRank !== bRank) return aRank - bRank
        // Stable tie-break on canvas x so unplaced dots keep a
        // deterministic order.
        return (a.canvas_x || 0) - (b.canvas_x || 0)
      })
    } else {
      candidates.sort((a, b) => a.canvas_x - b.canvas_x)
    }
    candidates.forEach((dot, i) => { dot.chain_index = i + 1 })

    // Preset list ids referenced by preset-type attributes at origin
    // state. Useful for future features; the navigator doesn't use
    // this, but the shape stays consistent with the backend preview.
    const presetIds = []
    const seenPreset = new Set()
    for (const attr of (entity.attributes || [])) {
      if (attr.attribute_type === 'preset' && attr.preset_list_id) {
        if (!seenPreset.has(attr.preset_list_id)) {
          presetIds.push(attr.preset_list_id)
          seenPreset.add(attr.preset_list_id)
        }
      }
    }

    // Profile image URL — direct asset URL, NOT a base64 data URI.
    // The grid's GridThumb uses this as an <img src> which works
    // for both data URIs and HTTP URLs without branching.
    const profileSrc = refToAssetUrl(entity.profile_image_ref)

    // Final effective state — walked to the end of the entity's
    // chain. Populated from the snapshot's `_effectiveDotState`
    // map. Used by the Final bookend dot + identity cell when the
    // user picks the Final state (Phase 1.12c v0.1.12.57).
    const effFinal = entEffective?.__final__
    const finalName = effFinal?.name || null
    const finalColour = effFinal?.colour || null
    const finalProfileSrc = refToAssetUrl(effFinal?.profile_image_ref)

    rows.push({
      id: entity.id,
      name: entity.name,
      type: typeName,
      colour: entity.colour || '#888888',
      description: entity.description || '',
      profile_image_data_uri: profileSrc,
      final_name: finalName,
      final_colour: finalColour,
      final_profile_image_data_uri: finalProfileSrc,
      dots: candidates,
      preset_list_ids_used: presetIds,
    })
  }
  return rows
}

// ── Public entry point ───────────────────────────────────────────

/**
 * Build an `ImportPreview`-shaped object from the live project's
 * story + a pre-computed POV sequence. Pure function — no state
 * reads, no side effects, no React imports. Memoise at the call
 * site on the inputs that actually affect the output (typically
 * story + povSequence + storyOrder).
 *
 * The optional `storyOrder` argument is the `computeStoryOrder` /
 * `useStoryOrder` result `{ orderedIds, indexById, tierById, ... }`.
 * When supplied, non-POV column order and per-entity dot chain_index
 * assignment both filter over the global Story Order instead of
 * canvas x. When omitted, both fall back to canvas-x ordering —
 * preserved for non-hook callers (tests, backend-built previews).
 */
export default function buildStoryTimelineView(story, povSequence, storyOrder, regressedNodeIds = null) {
  if (!story) {
    return {
      session_id: null,
      source_filename: null,
      story_title: '',
      story_author: null,
      story_genre: null,
      chapters: [],
      acts: [],
      columns: [],
      entities: [],
      preset_lists: [],
    }
  }

  const columns        = buildColumns(story, povSequence || [], storyOrder, regressedNodeIds)
  const chapterMarkers = buildChapterMarkers(story, columns)
  const actMarkers     = buildActMarkers(story, columns)
  const entityRows     = buildEntityRows(story, columns, storyOrder)

  return {
    session_id: null,
    source_filename: null,
    story_title: story.title || '',
    story_author: story.author || null,
    story_genre: story.genre || null,
    chapters: chapterMarkers,
    acts: actMarkers,
    columns,
    entities: entityRows,
    preset_lists: [],
  }
}
