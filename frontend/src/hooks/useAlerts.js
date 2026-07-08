import { useMemo } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useProjectStore } from '../store/projectStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { useUiStore } from '../store/uiStore'

// Module-level cache of the last full `computeAlerts` result. Read
// when the AlertsPanel flyout is CLOSED — the badge only needs the
// count, and that count is the last value the writer's session
// computed; staleness across mutations is acceptable for a status
// indicator (the writer sees the live value the moment they open
// the panel). Keyed on `loadGeneration` so prior-project alerts
// don't leak into the badge count after switching projects.
//
// This is the load-perf fix shape settled per the Fix #3 verification
// gates: option (c) of the ToDo's Fix #3 — "count is NOT cheaper
// than the full walk" forces the cache-the-count shape rather than
// the split-into-cheap-count-and-heavy-detail shape.
let _closedPanelAlertsCache = { loadGeneration: null, result: [] }
const EMPTY_ALERTS = Object.freeze([])


// Custom equality for the `nodes` subscription so that position-only
// updates (canvas pan / drag, which create a new `nodes` array but
// leave every node's `data` reference untouched) DON'T re-fire this
// hook. Phase 2.11 Bugs & Fixes — profile audit showed alert
// computation re-running on every canvas pan despite alerts not
// depending on `node.position`. The 6 hook-driven `AlertsPanel`
// renders per session that each cost ~88 ms came from here.
//
// Returns `true` when `a` and `b` are structurally equal — same
// length, same per-element `id` / `type` / `data` reference. Returns
// `false` when ANY of those change, which is exactly when alert
// computation needs to re-run (node added / removed, review_fields
// updated, scene title changed, POV reassigned — all of those mutate
// `data` and therefore change the reference).
export function nodesStructurallyEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === y) continue
    if (!x || !y) return false
    if (x.id !== y.id) return false
    if (x.type !== y.type) return false
    if (x.data !== y.data) return false
  }
  return true
}


export function edgesStructurallyEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === y) continue
    if (!x || !y) return false
    if (x.id !== y.id) return false
    if (x.source !== y.source) return false
    if (x.target !== y.target) return false
    if (x.sourceHandle !== y.sourceHandle) return false
    if (x.targetHandle !== y.targetHandle) return false
    if (x.data !== y.data) return false
  }
  return true
}
import { ENTITY_BUCKETS, getRelationshipNodeOrder, computeRelationshipEffectiveState, computeEffectiveState, getKnowledgeNodeOrder, resolveAwarenessField } from '../utils/narrativeChain'
import { participantsFallbackLabel } from '../utils/entityHelpers'
import { computePovChain, getOrComputePovChain } from '../utils/povSequence'
import { resolveChapterIdForNode } from '../utils/chapterMembership'
import { rowGeometryParams, multirowHeaderRows } from '../utils/rowLayout'
import { useStoryOrder, getOrComputeStoryOrder } from './useStoryOrder'
import { buildAwarenessSourceConsumers, relationshipSourceKey, attributeSourceKey } from '../utils/awarenessSourceIndex'

// Stable empty array so the chapters store selector returns a referentially
// equal value when the story has no chapters. Keeps the useMemo from
// re-running every time an unrelated store slice changes.
const EMPTY_CHAPTERS = []

/**
 * Derives the current list of workflow alerts from node/edge state.
 *
 * Alert types:
 *   - 'uninstantiated' — entity exists in the library but has no origin node on the canvas
 *   - 'orphaned'  — entity chip in a plot point node with no incoming narrative-flow edge
 *   - 'review'    — entity chip with review_fields[] set by the downstream review flag system
 *   - 'pov_chapter_order' — consecutive scenes in the POV chain sit in chapters that
 *     go backwards (e.g. scene N is in chapter 3 but scene N+1 is in chapter 2).
 *     Flagged on the later scene of the regressing pair.
 *
 * Each alert: { id, type, nodeId, entityId, entityName, nodeSummary, fields?, details? }
 *
 * For review alerts, `details` is an array of { field, previousInherited, currentInherited, downstreamValue }
 * derived from enriched review_fields (or just { field } for legacy plain-string flags).
 */
// POV types that don't require a specific character — suppress the "no POV character" alert.
const NON_CHARACTER_POV_TYPES = new Set([
  '3rd Person',
  '3rd Person (Limited)',
  '3rd Person (Omniscient)',
])

export function useAlerts() {
  // Closed-panel short-circuit signal. The AlertsPanel flyout is
  // closed in the 99% case during project load (and in fact most of
  // the time outside the moment the writer is actively reviewing
  // alerts). The full `computeAlerts` walk costs ~2 s synchronous on
  // a large-scale project and was running THREE times during
  // load. Gating the heavy walk on `alertsPanelOpen` keeps the badge
  // count showing the last-computed value (cached in
  // `_closedPanelAlertsCache` above, invalidated on project switch
  // via `loadGeneration`) and defers the recompute until the writer
  // actually opens the panel. Chain-aware semantics are preserved:
  // the same chain-walking math runs the moment the panel opens,
  // just not eagerly while it's hidden.
  const alertsPanelOpen = useUiStore((s) => s.alertsPanelOpen)
  const loadGeneration = useProjectStore((s) => s.loadGeneration)

  // Structural subscriptions: bail out when only `node.position` /
  // edge layout meta changed. See `nodesStructurallyEqual` /
  // `edgesStructurallyEqual` above for the equality rules.
  const nodes = useStoreWithEqualityFn(useProjectStore, (s) => s.nodes, nodesStructurallyEqual)
  const edges = useStoreWithEqualityFn(useProjectStore, (s) => s.edges, edgesStructurallyEqual)
  const relationships = useProjectStore((s) => s.relationships)
  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_CHAPTERS)
  const povTypeDefault = useProjectStore((s) => s.story?.pov_type_default || '')
  const chapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })
  // Phase 4.3 — layout mode + row grouping feed chapter-membership
  // resolution in the pov_chapter_order check (multi-row needs the 2D
  // resolver; single-row x-only would mis-read multi-row positions).
  const layoutMode = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const chapterRows = useProjectStore((s) => s.story?.chapter_rows || null)
  const actsExpanded = useProjectStore((s) => !!s.story?.multirow_acts_expanded)
  // Select stable individual arrays — NEVER call allEntities() inside a selector (creates new array → infinite re-render)
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const knowledges = useProjectStore((s) => s.knowledges)
  const customCategories = useEntitiesStore((s) => s.customCategories)
  // Phase 1.21c — Knowledges are first-class objects on projectStore.
  // (entitiesStore.knowledges remains for legacy entity-shape compat
  // but post-refactor projects store them here.)
  const projectKnowledges = useProjectStore((s) => s.knowledges)

  const allEntities = useMemo(
    () => composeAllEntities({ characters, locations, items, factions, customs, knowledges }),
    [characters, locations, items, factions, customs, knowledges]
  )

  const storyOrder = useStoryOrder()

  // Hoisted sub-computations — each cached against its own narrower
  // dep set so they survive `useAlerts` recomputes triggered by an
  // UNRELATED input. Phase 2.11 Bugs & Fixes — profile showed the
  // genuine alert recomputes (post-`useStoreWithEqualityFn` fix in
  // .19) costing ~91 ms each. The big-ticket walks below run once per
  // recompute even when only one tiny piece of input changed. Hoisting
  // them means an entity-edit (changes `allEntities` ref but not
  // nodes/edges) doesn't re-run `computePovChain`; a chapters change
  // doesn't re-run the awareness-source consumer index; etc.
  //
  // Each `useMemo` carries the deps that actually affect its result.
  // Anything not in the dep list MUST NOT influence the return value.

  // `entityMap` — id → Entity (or synthetic Knowledge-as-entity). Used
  // for badge resolution by alert renderers. Pure function of the entity
  // arrays, no node/edge dependency. Composition is shared with the MCP
  // `list_alerts` path via `composeEntityMap` so the two cannot drift.
  const entityMap = useMemo(
    () => composeEntityMap({ allEntities, projectKnowledges }),
    [allEntities, projectKnowledges],
  )

  // POV chain — pure function of `(nodes, edges)`. Heavy graph walk.
  // After the .19 structural-equality fix this hook bails out on
  // position-only updates, so this memo's deps usually stay stable.
  const povChain = useMemo(() => computePovChain(nodes, edges), [nodes, edges])

  // Awareness-source consumer index — heavy walk over every entity +
  // relationship + knowledge, building the cross-reference table the
  // awareness-source alert path uses.
  const sourceConsumers = useMemo(
    () => buildAwarenessSourceConsumers(allEntities, relationships, projectKnowledges, nodes),
    [allEntities, relationships, projectKnowledges, nodes],
  )

  return useMemo(() => {
    // Closed-panel fast-path: return the last-computed result from
    // the module cache (or empty if cache is for a different project).
    // The badge consumes only the COUNT and the panel itself is
    // hidden — no chain-aware display would render either way until
    // the writer opens the panel, at which point we compute fresh.
    if (!alertsPanelOpen) {
      return _closedPanelAlertsCache.loadGeneration === loadGeneration
        ? _closedPanelAlertsCache.result
        : EMPTY_ALERTS
    }
    const result = computeAlerts({
      nodes, edges, allEntities, chapters, chapterXOffset, povTypeDefault,
      relationships, customs, customCategories, storyOrder, projectKnowledges,
      entityMap, povChain, sourceConsumers, layoutMode, chapterRows, actsExpanded,
    })
     
    _closedPanelAlertsCache = { loadGeneration, result }
    return result
  }, [alertsPanelOpen, loadGeneration, nodes, edges, allEntities, chapters, chapterXOffset, povTypeDefault, relationships, customs, customCategories, storyOrder, projectKnowledges, entityMap, povChain, sourceConsumers, layoutMode, chapterRows, actsExpanded])
}


/**
 * Phase 3.7 perf fix (large-project load perf #12) — lightweight badge-count
 * hook that runs `computeAlerts` via `requestIdleCallback` instead of
 * synchronously in the render path. Designed to be consumed by the
 * always-mounted AlertsPanel outer wrapper so the badge can show an
 * accurate count without paying the ~1,030 ms blocking cost three
 * times during project load.
 *
 * Chain-aware semantics preserved verbatim: the idle callback runs
 * the same `computeAlerts` function that the synchronous `useAlerts`
 * hook calls when the flyout opens. Every chain walk inside
 * (`computeEffectiveState`, `computeRelationshipEffectiveState`,
 * `getRelationshipNodeOrder`, etc.) still resolves at its proper
 * anchor. This hook only shifts WHEN that chain-aware computation
 * runs (idle time vs render time), not WHAT it does.
 *
 * Behavior:
 *   - When `alertsPanelOpen === true`: skips scheduling its own
 *     idle compute and reads the count from `_closedPanelAlertsCache`
 *     which the `useAlerts` hook in `<AlertsPanelBody>` keeps fresh
 *     via its synchronous compute. Avoids duplicate work.
 *   - When `alertsPanelOpen === false`: schedules a
 *     `requestIdleCallback` whenever the alert-affecting subscriptions
 *     change. The callback computes the full alerts list and updates
 *     both the badge count state AND `_closedPanelAlertsCache`.
 *     Cancellation of the pending callback on dep change or unmount
 *     prevents stale writes from racing fresh ones.
 *
 * Trade-off the writer experiences:
 *   - Badge count is briefly stale (typically ~50-200 ms) after a
 *     mutation that would trigger / resolve an alert. For interactive
 *     mutations this is imperceptible; for load-storm state churn the
 *     count updates after the load storm settles.
 *   - Main thread is NEVER blocked by the heavy walk while the panel
 *     is closed (which is 99% of the time). User input, RF pan/zoom,
 *     and canvas paint can interleave with the walk.
 *
 * Stage 4.1's registry-based mutation-driven cache will eventually
 * make even this idle-deferred recompute unnecessary by maintaining
 * the count incrementally as mutations fire. Until that ships, this
 * hook is the bridge between the cache-on-open prototype's "stale
 * cached count" and the full mutation-driven count.
 */
// Module-level cache for the badge-count alert walk, mirroring the
// `useStoryOrder` cache discipline. The full `computeAlerts` walk is the
// expensive operation (~seconds on a large project), so it must run ONLY
// when an input that actually changes the alert set changes — never per
// drag frame, never during a load storm, and never on an unrelated store
// write.
//
// Cache-key strategy: the node / edge / chapter / layout surface is folded
// into the story-order RESULT identity. `getOrComputeStoryOrder` is itself
// cached and its result identity changes iff node data OR position, edges,
// chapters, x-offset, layout mode, or rows changed — which is exactly the
// canvas-side surface the alert walk depends on (crucially INCLUDING
// position, so a scene dragged into a different chapter re-triggers the
// pov_chapter_order alert). The remaining inputs (relationships, the entity
// arrays, knowledges, default POV type) are compared by reference. The
// lookup is therefore O(1) on the common path.
let _alertsCache = {
  storyOrder: null, relationships: null,
  characters: null, locations: null, items: null, factions: null, customs: null,
  customCategories: null, knowledges: null, povTypeDefault: null,
  loadGeneration: null, result: null,
}

function getOrComputeAlerts(s, entities) {
  const loadGeneration = s.loadGeneration
  const chapters = s.story?.chapters || EMPTY_CHAPTERS
  const chapterXOffset = typeof s.story?.chapter_x_offset === 'number' ? s.story.chapter_x_offset : 10
  const povTypeDefault = s.story?.pov_type_default || ''
  const layoutMode = s.story?.canvas_layout_mode || 'single'
  const chapterRows = s.story?.chapter_rows || null
  const actsExpanded = !!s.story?.multirow_acts_expanded
  const knowledges = s.knowledges
  const { characters, locations, items, factions, customs, customCategories } = entities

  // Resolve story order through its own (cached) helper — cheap on an
  // identity/structural hit. Its result identity is the canvas-side cache
  // key for the alert walk.
  const storyOrder = getOrComputeStoryOrder({ nodes: s.nodes, edges: s.edges, chapters, chapterXOffset, layoutMode, chapterRows, actsExpanded })

  const c = _alertsCache
  if (
    c.result && c.loadGeneration === loadGeneration &&
    c.storyOrder === storyOrder &&
    c.relationships === s.relationships &&
    c.characters === characters && c.locations === locations && c.items === items &&
    c.factions === factions && c.customs === customs && c.customCategories === customCategories &&
    c.knowledges === knowledges && c.povTypeDefault === povTypeDefault
  ) {
    return c.result
  }

  const allEntities = composeAllEntities({ characters, locations, items, factions, customs, knowledges })
  const entityMap = composeEntityMap({ allEntities, projectKnowledges: knowledges })
  const povChain = getOrComputePovChain(s.nodes, s.edges)
  const sourceConsumers = buildAwarenessSourceConsumers(allEntities, s.relationships, knowledges, s.nodes)
  const result = computeAlerts({
    nodes: s.nodes, edges: s.edges, allEntities, chapters, chapterXOffset, povTypeDefault,
    relationships: s.relationships, customs, customCategories, storyOrder,
    projectKnowledges: knowledges, entityMap, povChain, sourceConsumers, layoutMode, chapterRows, actsExpanded,
  })
  _alertsCache = {
    storyOrder, relationships: s.relationships,
    characters, locations, items, factions, customs, customCategories,
    knowledges, povTypeDefault, loadGeneration, result,
  }
  return result
}

export function useAlertsCount() {
  // Gesture / load-storm gates, identical in spirit to `useStoryOrder`:
  // during a node drag or canvas gesture, and during the post-load fitView
  // storm, the heavy walk is suppressed and the last cached count is served
  // (0 immediately after a project switch, before the first settled walk).
  // This preserves the load-time perf fix — the walk never runs per drag
  // frame and never piles onto the load storm. Position-derived alerts
  // (e.g. a scene dragged into a different chapter) snap to current the
  // moment the gesture ends: the flag flip re-runs the selector, which then
  // resolves against the settled positions and the story-order-keyed cache
  // misses, triggering exactly one walk.
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  // Entity arrays live on a separate store; subscribe so an entity edit
  // re-runs the selector. These refs are stable during canvas gestures, so
  // they add no per-frame cost.
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const customCategories = useEntitiesStore((s) => s.customCategories)

  // Single projectStore subscription returning the COUNT. `Object.is`
  // equality means a stable count (cache hit, or cached during a gesture /
  // load storm) does NOT re-render the always-mounted AlertsPanel wrapper.
  return useStoreWithEqualityFn(
    useProjectStore,
    (s) => {
      if (gestureActive || s._pendingFitView || s._loadSettling) {
        return _alertsCache.result && _alertsCache.loadGeneration === s.loadGeneration
          ? _alertsCache.result.length
          : 0
      }
      return getOrComputeAlerts(s, { characters, locations, items, factions, customs, customCategories }).length
    },
    Object.is,
  )
}

/**
 * Per-node POV-order alert lookup. Returns the canonical `pov_chapter_order`
 * alert object for `nodeId` (or null) from the SAME cached alert computation
 * the AlertsPanel uses — so the scene-node "⚠ POV Order" badge and the panel
 * can never disagree. ONE calculator, two consumers: the badge must NOT
 * re-derive the regression itself (a prior duplicate did, and silently drifted
 * when the canonical check became multi-row-aware). The alert object carries
 * `previousChapterTitle` / `currentChapterTitle` for the badge tooltip. Mirrors
 * `useAlerts`'s gesture / load-storm gating; the found alert keeps a stable
 * identity across renders on a cache hit, so a node re-renders only when ITS
 * regression status actually changes.
 */
export function usePovOrderAlert(nodeId) {
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const customCategories = useEntitiesStore((s) => s.customCategories)
  return useStoreWithEqualityFn(
    useProjectStore,
    (s) => {
      const list = (gestureActive || s._pendingFitView || s._loadSettling)
        ? (_alertsCache.result && _alertsCache.loadGeneration === s.loadGeneration ? _alertsCache.result : null)
        : getOrComputeAlerts(s, { characters, locations, items, factions, customs, customCategories })
      if (!list) return null
      return list.find((a) => a.type === 'pov_chapter_order' && a.nodeId === nodeId) || null
    },
    Object.is,
  )
}

/**
 * Set of node ids that have a `pov_chapter_order` alert, from the SAME cached
 * alert computation the AlertsPanel + scene-node badge use. The Timeline
 * Navigator consumes this for its ⚠ regression indicator instead of
 * re-deriving the regression (a prior inline copy in buildStoryTimelineView
 * drifted when the canonical check became multi-row-aware). The returned Set is
 * memoised on the alert-list identity, so it's reference-stable across renders
 * on a cache hit (the timeline's `buildStoryTimelineView` memo won't churn).
 */
export function usePovOrderRegressedNodeIds() {
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const customCategories = useEntitiesStore((s) => s.customCategories)
  const alerts = useStoreWithEqualityFn(
    useProjectStore,
    (s) => (gestureActive || s._pendingFitView || s._loadSettling)
      ? ((_alertsCache.result && _alertsCache.loadGeneration === s.loadGeneration) ? _alertsCache.result : EMPTY_ALERTS)
      : getOrComputeAlerts(s, { characters, locations, items, factions, customs, customCategories }),
    Object.is,
  )
  return useMemo(() => {
    const set = new Set()
    for (const a of alerts) if (a.type === 'pov_chapter_order') set.add(a.nodeId)
    return set
  }, [alerts])
}


/**
 * Compose the `allEntities` array consumed by `computeAlerts` (and by
 * a handful of utility helpers). Single source of truth for the spread
 * order plus the `type: 'knowledge'` injection on knowledges.
 *
 * Knowledges don't carry a `type` field natively (the projectStore
 * keeps them type-less; see `globalSearch.js:1304-1308` for the same
 * pattern documentation). Injecting `type: 'knowledge'` here makes the
 * `if (entity.type === 'knowledge') continue` skip guards inside
 * `computeAlerts` (at the uninstantiated / perspective-orphan /
 * attribute-walk / awareness-contradiction passes) actually fire as
 * intended. Without the injection those guards evaluate
 * `undefined === 'knowledge'` → false and treat knowledges as
 * entities.
 *
 * Use this in BOTH the React hook AND any non-React consumer (e.g.
 * the MCP `list_alerts` handler) so the two paths can never drift.
 */
export function composeAllEntities({ characters, locations, items, factions, customs, knowledges }) {
  return [
    ...(characters || []),
    ...(locations  || []),
    ...(items      || []),
    ...(factions   || []),
    ...(customs    || []),
    ...((knowledges || []).map((k) => ({ ...k, type: 'knowledge' }))),
  ]
}

/**
 * Compose the `entityMap` lookup consumed by `computeAlerts`. Mirrors
 * the `composeAllEntities` knowledge-type-injection rule so downstream
 * lookups (EntityAlertImage badge resolver, TYPE_ICONS → 📜 glyph, etc.)
 * find the right `type` on a Knowledge id.
 */
export function composeEntityMap({ allEntities, projectKnowledges }) {
  const m = new Map((allEntities || []).map((e) => [e.id, e]))
  for (const k of (projectKnowledges || [])) {
    if (!m.has(k.id)) m.set(k.id, { ...k, type: 'knowledge' })
  }
  return m
}

/**
 * Phase 2.13e+ — pure alert-derivation extracted from `useAlerts`. The
 * React hook wraps this in a `useMemo`; the `list_alerts` MCP tool calls
 * it directly with inputs gathered from the live stores. Keeping both
 * paths through one function guarantees the MCP catalogue and the
 * sidebar Alerts panel never drift.
 *
 * Inputs are the same as the hook's outer closures — pass them
 * explicitly so this function stays pure and testable without React /
 * Zustand context.
 */
export function computeAlerts({
  nodes,
  edges,
  allEntities,
  chapters,
  chapterXOffset,
  povTypeDefault,
  relationships,
  customs,
  customCategories,
  storyOrder,
  projectKnowledges,
  entityMap,
  povChain,
  sourceConsumers,
  layoutMode = 'single',
  chapterRows = null,
  actsExpanded = false,
}) {
    const alerts = []

    // Uninstantiated: entities with no origin node on the canvas
    const originEntityIds = new Set(
      nodes.filter((n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id)
        .map((n) => n.data.entity_id)
    )
    for (const entity of allEntities) {
      // Knowledges are first-class objects, NOT entities — they live in
      // `allEntities` for shared iteration convenience but use the
      // `knowledgeOriginNode` canvas type, not `entityNode`. The
      // `knowledge_uninstantiated` pass below handles them. Other
      // `allEntities` consumers apply the same skip (see lines ~412,
      // ~686, ~1168).
      if (entity?.type === 'knowledge') continue
      if (!originEntityIds.has(entity.id)) {
        alerts.push({
          id: `uninstantiated-${entity.id}`,
          type: 'uninstantiated',
          nodeId: null,
          entityId: entity.id,
          entityName: entity.name,
          entityType: entity.type,
          nodeSummary: null,
        })
      }
    }

    // Phase 1.21c — Knowledge equivalent of the uninstantiated alert.
    // A Knowledge has a creation anchor IFF it has either:
    //   - a `<KnowledgeOriginNode>` on canvas, OR
    //   - an `existence_changes: activate` event in its history (scene-
    //     born — the earliest activate event is the birth scene).
    // Anything else (chain involvement via manual_anchor, content
    // change, awareness change at downstream scenes) does NOT count
    // as a creation anchor — those are mutations on a Knowledge whose
    // first-existence point is undefined. Surface the alert so the
    // user can decide where to anchor it. Mirrors the entity
    // "uninstantiated" alert shape.
    const knowledgeOriginIds = new Set(
      nodes
        .filter((n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id)
        .map((n) => n.data.knowledge_id)
    )
    for (const k of (projectKnowledges || [])) {
      if (knowledgeOriginIds.has(k.id)) continue
      const hasActivate = (k.history?.existence_changes || [])
        .some((c) => c?.action === 'activate' && c?.node_id)
      if (hasActivate) continue
      // Find the earliest chain-relevant node for this Knowledge (in
      // story order). If one exists, surface it as a one-click
      // resolution: "set this as the origin" — promoting the scene
      // to a creation anchor doesn't orphan anything because it's
      // already the earliest position. If the Knowledge has no chain
      // involvement at all the field stays null and the alert offers
      // no inline suggestion (user adds an origin node manually).
      const order = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      const proposedOriginNodeId = (order && order.length > 0) ? order[0] : null
      alerts.push({
        id: `knowledge_uninstantiated-${k.id}`,
        type: 'knowledge_uninstantiated',
        nodeId: null,
        knowledgeId: k.id,
        knowledgeName: k.name,
        knowledgeColour: k.colour,
        proposedOriginNodeId,
        nodeSummary: null,
      })
    }

    for (const node of nodes) {
      // --- Plot point nodes: scan entity buckets ---
      if (node.type === 'sceneNode') {
        // Flashback scenes: entities are inherited from parent, skip orphan/review checks
        if (node.data.is_flashback) continue

        const nodeSummary = node.data.title || node.data.description || 'Untitled Scene'

        // Scene-level review fields — Phase 1.23 loose-mode notification
        // alerts (Time Since Last Scene gap shifts). Same review-flag
        // shape as EntityRef.review_fields, but keyed to the scene
        // itself (no entity). The 'time_since_last_scene' field is
        // the only kind currently produced; future scene-level
        // reviews would also surface here.
        const sceneReview = node.data.review_fields || []
        for (const f of sceneReview) {
          const detail = typeof f === 'string' ? { field: f } : f
          alerts.push({
            id: `review-scene-${node.id}-${detail.field}`,
            type: 'review',
            nodeId: node.id,
            entityId: null,
            entityName: null,
            nodeSummary,
            field: detail.field,
            detail,
          })
        }

        for (const bucket of ENTITY_BUCKETS) {
          const refs = node.data[bucket] || []
          for (const ref of refs) {
            const entity = entityMap.get(ref.entity_id)
            const entityName = ref.name_change || entity?.name || 'Unknown'

            // Orphaned: no incoming narrative-flow edge carrying this entity
            const hasIncoming = edges.some(
              (e) => e.target === node.id && e.data?.source_entity_id === ref.entity_id && !e.data?.is_relationship
            )
            if (!hasIncoming) {
              alerts.push({
                id: `orphaned-${node.id}-${ref.entity_id}`,
                type: 'orphaned',
                nodeId: node.id,
                entityId: ref.entity_id,
                entityName,
                nodeSummary,
              })
            }

            // Downstream review flags — one alert per field
            if (ref.review_fields?.length > 0) {
              for (const f of ref.review_fields) {
                const detail = typeof f === 'string' ? { field: f } : f
                alerts.push({
                  id: `review-${node.id}-${ref.entity_id}-${detail.field}`,
                  type: 'review',
                  nodeId: node.id,
                  entityId: ref.entity_id,
                  entityName,
                  nodeSummary,
                  field: detail.field,
                  detail,
                })
              }
            }
          }
        }
        continue
      }

      // --- Modifier nodes: review_fields directly on node.data ---
      if (node.type === 'entityNode' && node.data.is_modifier && node.data.entity_id) {
        const reviewFields = node.data.review_fields || []
        if (reviewFields.length > 0) {
          const entity = entityMap.get(node.data.entity_id)
          const entityName = node.data.name_change || entity?.name || 'Unknown'
          const nodeSummary = entityName + ' (modifier)'
          for (const f of reviewFields) {
            const detail = typeof f === 'string' ? { field: f } : f
            alerts.push({
              id: `review-${node.id}-${node.data.entity_id}-${detail.field}`,
              type: 'review',
              nodeId: node.id,
              entityId: node.data.entity_id,
              entityName,
              nodeSummary,
              field: detail.field,
              detail,
            })
          }
        }
      }
    }

    // --- Awareness-history review flags ---
    // Awareness-as-second-class-object model: review flags live on each
    // awareness object's own `history[]` list. Walk every awareness
    // surface across entities (existence / canonical-name / attributes /
    // aliases) and relationships, emitting `type: 'review'` alerts that
    // share the same panel section as the EntityRef-keyed and Knowledge-
    // keyed review alerts above. Field-key namespacing per surface so
    // AlertsPanel can route to the right framing.
    const emitAwarenessHistoryAlerts = (history, ctx) => {
      if (!Array.isArray(history)) return
      for (const entry of history) {
        if (!entry?.review_flag) continue
        if (entry.source_action) continue
        if (!entry.observer_id || !entry.node_id) continue
        const node = nodes.find((n) => n.id === entry.node_id)
        if (!node) continue
        const observer = entityMap.get(entry.observer_id)
        const observerName = observer?.name || 'Observer'
        const nodeSummary = (node.type === 'sceneNode'
          ? (node.data?.title || 'Scene')
          : node.type === 'entityNode'
            ? `${(observer?.name || '')} (modifier)`
            : 'Node')
        const fieldKey = ctx.fieldKeyFor(entry.observer_id)
        const detail = {
          field: fieldKey,
          // sourceInputValue mirrors the legacy EntityRef-side flag so
          // the alert renders via the full Changed / Therefore Changes
          // layout (`hasInput && hasPrev && hasCurr && hasDown`). For
          // awareness, the source-input value at the upstream anchor is
          // the new effective level — the same as currentInherited.
          sourceInputValue: entry.review_flag.currentInherited,
          previousInherited: entry.review_flag.previousInherited,
          currentInherited: entry.review_flag.currentInherited,
          downstreamValue: entry.review_flag.downstreamValue,
          ...(entry.review_flag.redundant ? { redundant: true } : {}),
          sourceNodeId: entry.review_flag.sourceNodeId ?? null,
          observerId: entry.observer_id,
          observerName,
          awarenessKind: ctx.kind,
          ...ctx.detailExtras,
          historyEntryId: entry.id,
        }
        alerts.push({
          id: `review-aware-${ctx.kind}-${ctx.alertKeySuffix}-${entry.id}`,
          type: 'review',
          nodeId: entry.node_id,
          entityId: ctx.alertEntityId,
          entityName: ctx.alertEntityName,
          nodeSummary,
          field: fieldKey,
          detail,
          ...ctx.alertExtras,
        })
      }
    }
    for (const ent of allEntities) {
      if (!ent?.id) continue
      // Skip merged-in knowledges — they're handled via projectKnowledges below.
      if (ent.type === 'knowledge') continue
      emitAwarenessHistoryAlerts(ent.awareness?.history, {
        kind: 'entity_existence',
        alertEntityId: ent.id,
        alertEntityName: ent.name || 'Entity',
        alertKeySuffix: ent.id,
        fieldKeyFor: (obsId) => `awareness:entity:${obsId}`,
        detailExtras: { entityId: ent.id },
        alertExtras: {},
      })
      emitAwarenessHistoryAlerts(ent.name_awareness?.history, {
        kind: 'entity_name',
        alertEntityId: ent.id,
        alertEntityName: ent.name || 'Entity',
        alertKeySuffix: ent.id,
        fieldKeyFor: (obsId) => `awareness:entity_name:${obsId}`,
        detailExtras: { entityId: ent.id },
        alertExtras: {},
      })
      for (const attr of (ent.attributes || [])) {
        if (!attr?.id) continue
        emitAwarenessHistoryAlerts(attr.awareness?.history, {
          kind: 'attribute',
          alertEntityId: ent.id,
          alertEntityName: ent.name || 'Entity',
          alertKeySuffix: `${ent.id}:${attr.id}`,
          fieldKeyFor: (obsId) => `awareness_set:${attr.id}:${obsId}`,
          detailExtras: { entityId: ent.id, attributeId: attr.id, attributeName: attr.name || '' },
          alertExtras: {},
        })
      }
      for (const a of (ent.aliases || [])) {
        if (a == null || typeof a === 'string' || !a.value) continue
        emitAwarenessHistoryAlerts(a.awareness?.history, {
          kind: 'alias',
          alertEntityId: ent.id,
          alertEntityName: ent.name || 'Entity',
          alertKeySuffix: `${ent.id}:${a.value}`,
          fieldKeyFor: (obsId) => `awareness:alias:${encodeURIComponent(a.value)}:${obsId}`,
          detailExtras: { entityId: ent.id, aliasValue: a.value },
          alertExtras: {},
        })
      }
    }
    for (const rel of (relationships || [])) {
      if (!rel?.id) continue
      emitAwarenessHistoryAlerts(rel.awareness?.history, {
        kind: 'relationship',
        alertEntityId: rel.id,
        alertEntityName: rel.name || 'Relationship',
        alertKeySuffix: rel.id,
        fieldKeyFor: (obsId) => `awareness:relationship:${rel.id}:${obsId}`,
        detailExtras: { relationshipId: rel.id },
        alertExtras: { relationshipId: rel.id },
      })
    }
    for (const k of (projectKnowledges || [])) {
      if (!k?.id) continue
      emitAwarenessHistoryAlerts(k.awareness?.history, {
        kind: 'knowledge',
        alertEntityId: k.id,
        alertEntityName: k.name || 'Knowledge',
        alertKeySuffix: k.id,
        fieldKeyFor: (obsId) => `awareness:knowledge:${k.id}:${obsId}`,
        detailExtras: { knowledgeId: k.id },
        alertExtras: { knowledgeId: k.id },
      })
    }

    // --- POV alerts (uses shared povSequence utility) ---
    // `povChain` is now hoisted to its own useMemo above; consumed here.
    const povEdges = edges.filter((e) => e.data?.is_pov_path)
    const anySceneHasPov = nodes.some((n) => n.type === 'sceneNode' && n.data.pov_entity_id)

    // "No POV Start Node" alert — when there's no POV origin but scenes have POV chips
    if (!povChain.originId && anySceneHasPov) {
      alerts.push({
        id: 'pov_no_origin',
        type: 'pov_no_origin',
        nodeId: null,
        entityId: null,
        entityName: null,
        nodeSummary: null,
      })
    }

    // POV disconnected: scenes with POV chip but not reachable from origin.
    // Alert only on break point (no incoming POV wire); visual warning on all downstream.
    for (const node of nodes) {
      if (node.type !== 'sceneNode') continue
      if (!node.data.pov_entity_id) continue
      if (povChain.reachable.has(node.id)) continue
      // Only create an alert for the break point (no incoming POV wire)
      const hasIncomingPov = povEdges.some((e) => e.target === node.id)
      if (hasIncomingPov) continue
      const nodeSummary = node.data.title || node.data.description || 'Untitled Scene'
      alerts.push({
        id: `pov_disconnected-${node.id}`,
        type: 'pov_disconnected',
        nodeId: node.id,
        entityId: node.data.pov_entity_id,
        entityName: entityMap.get(node.data.pov_entity_id)?.name || 'Unknown',
        nodeSummary,
      })
    }

    // POV no character: scene has a POV chip (incoming wire or pov_entity_id) but no character
    // attached. Two distinct scenarios produce this alert:
    //   - sceneHasNoCharacters: there are no character-type entities in the scene at all
    //   - povNotAttached: characters exist, but the POV chip isn't attached to any of them
    //     (happens when the user ejects the POV, or pov_entity_id points to a removed entity)
    // For flashback scenes, the effective character list comes from the parent scene (live ref).
    // Suppressed entirely for POV types that don't require a specific character (e.g. 3rd Person).
    if (!NON_CHARACTER_POV_TYPES.has(povTypeDefault)) {
    for (const node of nodes) {
      if (node.type !== 'sceneNode') continue
      const hasPovIncoming = povEdges.some((e) => e.target === node.id) || !!node.data.pov_entity_id
      if (!hasPovIncoming) continue
      // Resolve characters: flashback scenes mirror their parent scene's characters
      let characters = node.data.characters || []
      if (node.data.is_flashback && node.data.parent_scene_id) {
        const parentNode = nodes.find((n) => n.id === node.data.parent_scene_id)
        if (parentNode) characters = parentNode.data?.characters || []
      }
      // Check if pov_entity_id is null or doesn't match any character in the scene
      if (!node.data.pov_entity_id || !characters.some((c) => c.entity_id === node.data.pov_entity_id)) {
        const nodeSummary = node.data.title || node.data.description || 'Untitled Scene'
        const sceneHasNoCharacters = characters.length === 0
        alerts.push({
          id: `pov_no_character-${node.id}`,
          type: 'pov_no_character',
          nodeId: node.id,
          entityId: null,
          entityName: null,
          nodeSummary,
          sceneHasNoCharacters,
        })
      }
    }
    } // end NON_CHARACTER_POV_TYPES guard

    // Flashback no parent: flashback scenes with no parent_scene_id set, or pointing to a
    // deleted/nonexistent scene. These need a parent wired in before they're usable.
    const nodeIdSet = new Set(nodes.map((n) => n.id))
    for (const node of nodes) {
      if (node.type !== 'sceneNode') continue
      if (!node.data?.is_flashback) continue
      const parentId = node.data?.parent_scene_id
      const hasValidParent = parentId && nodeIdSet.has(parentId)
      if (!hasValidParent) {
        const nodeSummary = node.data.title || 'Untitled Flashback'
        alerts.push({
          id: `flashback_no_parent-${node.id}`,
          type: 'flashback_no_parent',
          nodeId: node.id,
          entityId: null,
          entityName: null,
          nodeSummary,
        })
      }
    }

    // POV chapter order: walk the POV chain in sequence order; if a scene sits
    // in an EARLIER chapter than the previous scene in the chain, the later
    // scene is flagged. Scenes outside all chapters (null chapter id) are
    // skipped — an ungrouped scene doesn't count as a regression.
    if (chapters.length > 0 && povChain.sequence.length > 1) {
      const chapterIndex = new Map(chapters.map((c, i) => [c.id, i]))
      // Phase 4.3 — resolve membership mode-aware: in multi-row the node's
      // live position is its display (per-row) position, so the x-only
      // single-row test would read the wrong chapter and falsely flag the
      // whole POV chain as regressing. The dispatcher uses the 2D resolver
      // in multi-row and is a no-op in single-row.
      const _geom = rowGeometryParams(chapterXOffset, multirowHeaderRows(layoutMode, actsExpanded))
      const _memberOpts = {
        mode: layoutMode,
        chapterRows,
        xOffset: chapterXOffset,
        rowsTopY: _geom.rowsTopY,
        rowGap: _geom.rowGap,
      }
      let lastChapterIdx = -1
      let lastNodeId = null
      for (const entry of povChain.sequence) {
        const node = nodes.find((n) => n.id === entry.nodeId)
        if (!node || node.type !== 'sceneNode') continue
        const chapterId = resolveChapterIdForNode(node, chapters, _memberOpts)
        if (!chapterId) continue
        const idx = chapterIndex.get(chapterId)
        if (idx == null) continue
        if (lastChapterIdx !== -1 && idx < lastChapterIdx) {
          const nodeSummary = node.data.title || node.data.description || 'Untitled Scene'
          alerts.push({
            id: `pov_chapter_order-${node.id}`,
            type: 'pov_chapter_order',
            nodeId: node.id,
            entityId: null,
            entityName: null,
            nodeSummary,
            previousNodeId: lastNodeId,
            previousChapterTitle: chapters[lastChapterIdx]?.title || `Chapter ${lastChapterIdx + 1}`,
            currentChapterTitle: chapters[idx]?.title || `Chapter ${idx + 1}`,
          })
        }
        lastChapterIdx = idx
        lastNodeId = node.id
      }
    }

    // Uncategorized custom entity: custom entity's category_id does not match any
    // existing CustomCategory. Happens when a category is deleted while custom entities
    // still reference it; `_sweepStaleCustomCategoryRefsFromEntities` nulls the id, leaving
    // the entity in a broken state until the user reassigns or deletes it. Resolves
    // automatically when category_id is reassigned or the entity is deleted.
    const categoryIdSet = new Set((customCategories || []).map((c) => c.id))
    for (const entity of customs) {
      if (!entity.category_id || !categoryIdSet.has(entity.category_id)) {
        alerts.push({
          id: `uncategorized_custom-${entity.id}`,
          type: 'uncategorized_custom',
          nodeId: null,
          entityId: entity.id,
          entityName: entity.name,
          nodeSummary: null,
        })
      }
    }

    // Phase 2.13d — Orphaned perspective target. Fires when a
    // perspective attribute's target was cascade-nulled by the
    // target object's deletion (Phase 2.13a's null-target-keep-
    // description cascade). The perspective entry itself survives
    // with its description text intact, but its
    // `perspective_target_kind` / `perspective_target_id` are both
    // null.
    //
    // A perspective attribute has its OWN origin — the chain stop
    // where it was created. The cascade strips the target at that
    // origin (mutates the Attribute's baseline fields directly).
    // For chain-awareness this means we walk three locations, each
    // of which is a possible perspective origin:
    //   (a) Entity baseline `attributes[]` — perspectives created
    //       at the entity's own origin (baseline IS the perspective's
    //       origin here; reading directly is chain-aware).
    //   (b) Scene EntityRef `attribute_changes` of `action='add'`
    //       with embedded perspective attribute — perspectives
    //       created at that scene anchor (the `add` entry IS the
    //       perspective's origin; reading from the embedded
    //       attribute is chain-aware).
    //   (c) Modifier EntityNode `attribute_changes` of `action='add'`
    //       with embedded perspective — perspectives created at
    //       that modifier (same origin semantics as (b)).
    // Modify entries (`new_perspective_target_*`) are NOT walked
    // here — those are downstream rewires layered on top of the
    // perspective's origin baseline; if the writer explicitly wires
    // a downstream null, that's a deliberate authoring choice the
    // alert shouldn't second-guess.
    const pushPerspectiveAlert = (entity, attr, originNodeId) => {
      const descPreview = (attr.description || '').trim().replace(/\s+/g, ' ')
      const truncDesc = descPreview.length > 80
        ? descPreview.slice(0, 80) + '…'
        : descPreview
      alerts.push({
        // Include originNodeId in the alert id so a perspective whose
        // origin moved from baseline to a scene (or between scenes)
        // generates a fresh alert rather than colliding with a stale
        // one.
        id: `orphaned_perspective_target-${entity.id}-${attr.id}-${originNodeId || 'origin'}`,
        type: 'orphaned_perspective_target',
        nodeId: originNodeId,
        entityId: entity.id,
        entityName: entity.name,
        entityType: entity.type,
        perspectiveId: attr.id,
        perspectiveDescription: truncDesc,
        nodeSummary: null,
      })
    }
    const isOrphanedPerspective = (attr) =>
      attr
      && attr.attribute_type === 'perspective'
      && !attr.perspective_target_kind
      && !attr.perspective_target_id
    // (a) Entity baseline attributes.
    for (const entity of allEntities) {
      if (!entity || entity.type === 'knowledge') continue
      for (const attr of (entity.attributes || [])) {
        if (!isOrphanedPerspective(attr)) continue
        pushPerspectiveAlert(entity, attr, null)
      }
    }
    // (b) + (c) Mid-chain perspective origins via `add` actions in
    // attribute_changes on scene EntityRefs and modifier EntityNodes.
    for (const node of nodes) {
      if (node.type === 'sceneNode') {
        for (const bucket of ENTITY_BUCKETS) {
          for (const ref of (node.data?.[bucket] || [])) {
            const entity = entityMap.get(ref.entity_id)
            if (!entity || entity.type === 'knowledge') continue
            for (const ac of (ref.attribute_changes || [])) {
              if (ac?.action !== 'add' || !ac.attribute) continue
              if (!isOrphanedPerspective(ac.attribute)) continue
              pushPerspectiveAlert(entity, ac.attribute, node.id)
            }
          }
        }
      } else if (node.type === 'entityNode' && node.data?.is_modifier && node.data?.entity_id) {
        const entity = entityMap.get(node.data.entity_id)
        if (!entity || entity.type === 'knowledge') continue
        for (const ac of (node.data?.attribute_changes || [])) {
          if (ac?.action !== 'add' || !ac.attribute) continue
          if (!isOrphanedPerspective(ac.attribute)) continue
          pushPerspectiveAlert(entity, ac.attribute, node.id)
        }
      }
    }

    // Relationship solo: non-membership relationships whose effective participant count
    // at the end of their chain is exactly 1.
    //
    // The chain is simulated by starting from origin-count (participants with no 'join' entry)
    // and walking participant_changes (join/leave) sorted by node x-position. This correctly
    // handles:
    //   - Manual leave via removeParticipant (records a 'leave' entry at a specific node) —
    //     the simulation shows the 2→1 transition; actionType='end_here' at that drop node.
    //   - purgeEntity (entity deleted from story) — the entity and its history entries are
    //     wiped, so the chain shows origin-count=1 with no transitions. actionType='delete'.
    //   - Detail-panel relationship with only 1 participant added — origin-count=0 with one
    //     join; chain never exceeds 1. actionType='delete'.
    for (const rel of relationships) {
      if (rel.membership_of) continue

      const pChanges = (rel.history?.participant_changes || []).filter(
        (c) => c.action === 'join' || c.action === 'leave'
      )

      // History-only: every participant enters via a `join` event; there are
      // no implicit-origin participants, so origin-count is always 0.
      const originCount = 0

      // Graph-walk narrative order — canvas x-position is NEVER used for
      // chain ordering (audit v0.1.18.120+). Sort changes by their node's
      // position in the relationship's topological node order.
      const relNodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder)
      const nodeOrderIdx = new Map(relNodeOrder.map((id, i) => [id, i]))
      const ordered = pChanges
        .map((c) => ({ ...c, _idx: nodeOrderIdx.get(c.node_id) ?? Infinity }))
        .sort((a, b) => a._idx - b._idx)

      // Walk the chain, tracking count and active entity set at each step.
      // History-only: no implicit-origin participants, so the active set starts empty
      // and gets populated by join events as the chain walks.
      const activeIds = new Set()
      const chain = [{ count: originCount, nodeId: null }]
      let running = originCount
      for (const ch of ordered) {
        if (ch.action === 'join') {
          if (!activeIds.has(ch.entity_id)) { activeIds.add(ch.entity_id); running++ }
        } else {
          if (activeIds.has(ch.entity_id)) { activeIds.delete(ch.entity_id); running-- }
        }
        chain.push({ count: running, nodeId: ch.node_id })
      }

      // Alert fires only when the simulated final count is exactly 1.
      if (running !== 1) continue

      // Drop point = the earliest chain step from which count stays ≤ 1 forward.
      // Walk backward to find the last step with count > 1; the next step is the drop point.
      let dropIdx = 0
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].count > 1) { dropIdx = i + 1; break }
      }
      const hadMultiple = dropIdx > 0
      const endNodeId = hadMultiple ? (chain[dropIdx]?.nodeId || null) : null

      // The change that caused the final drop to 1 is ordered[dropIdx - 1] — its entity is the
      // participant who left. (chain[dropIdx] is the state AFTER ordered[dropIdx - 1] is applied.)
      const leaverChange = hadMultiple ? ordered[dropIdx - 1] : null
      const leaverEntityId = leaverChange?.entity_id || null
      const leaverEntity = leaverEntityId ? entityMap.get(leaverEntityId) : null

      // Earliest canvas node associated with the relationship — used as nav target for the
      // 'delete' case where there's no meaningful drop node.
      const relNodeIdSet = new Set()
      for (const e of edges) {
        if (e.data?.relationship_id === rel.id) {
          relNodeIdSet.add(e.source)
          relNodeIdSet.add(e.target)
        }
      }
      for (const c of pChanges) {
        if (c.node_id) relNodeIdSet.add(c.node_id)
      }
      // Prefer the relationship's own origin node when one exists — it's the
      // canonical "this is the relationship" canvas surface. Falls back to the
      // leftmost associated node (entity origin, scene) only when no origin
      // node exists (scene-born relationships).
      let triggerNodeId = null, triggerX = Infinity
      for (const nid of relNodeIdSet) {
        const n = nodes.find((x) => x.id === nid)
        if (!n) continue
        if (n.type === 'relationshipOriginNode' && n.data?.relationship_id === rel.id) {
          triggerNodeId = nid
          triggerX = -Infinity
          break
        }
        if ((n.position?.x ?? Infinity) < triggerX) {
          triggerX = n.position.x
          triggerNodeId = nid
        }
      }

      // History-only: the base `participants[]` mirror has been removed. The
      // solo-entity fallback now just uses the first still-active id if any.
      const soloEntityId = [...activeIds][0] ?? null
      const soloEntity = soloEntityId ? entityMap.get(soloEntityId) : null

      // Resolve a participant's effective alias_override at a given chain node.
      // Graph-walk narrative order — canvas x-position is NEVER used for chain
      // ordering (audit v0.1.18.120+). Uses the `relNodeOrder` / `nodeOrderIdx`
      // already computed above (topological sort via edges).
      const resolveAlias = (entId, atNodeId) => {
        const joinEvents = (rel.history?.participant_changes || [])
          .filter((c) => c.action === 'join' && c.entity_id === entId)
          .map((c) => ({ ...c, _idx: nodeOrderIdx.get(c.node_id) ?? Infinity }))
          .sort((a, b) => a._idx - b._idx)
        let alias = joinEvents[0]?.initial_alias_override ?? null
        if (!atNodeId) return alias
        const targetIdx = nodeOrderIdx.get(atNodeId) ?? Infinity
        const aliasChanges = (rel.history?.alias_changes || [])
          .filter((c) => c.entity_id === entId)
          .map((c) => ({ ...c, _idx: nodeOrderIdx.get(c.node_id) ?? Infinity }))
          .sort((a, b) => a._idx - b._idx)
        for (const c of aliasChanges) {
          if (c._idx <= targetIdx) alias = c.new_alias_override ?? null
        }
        return alias
      }

      const aliasAnchor = endNodeId || triggerNodeId
      const soloAlias = soloEntityId ? resolveAlias(soloEntityId, aliasAnchor) : null
      const leaverAlias = leaverEntityId ? resolveAlias(leaverEntityId, endNodeId) : null

      // Relationship label: custom name, or participants fallback built from
      // the history join ids (history-only model — no base mirror).
      let resolvedRelName = rel.name
      if (!resolvedRelName) {
        const joinIds = Array.from(new Set(
          (rel.history?.participant_changes || [])
            .filter((c) => c.action === 'join')
            .map((c) => c.entity_id)
        ))
        const soloAnchorNodeId = endNodeId || triggerNodeId
        const resolveSoloName = (eid) => {
          const ent = entityMap.get(eid)
          if (!ent) return null
          const s = computeEffectiveState(ent, nodes, edges, soloAnchorNodeId)
          return s?.name || ent.name || null
        }
        resolvedRelName = participantsFallbackLabel(
          joinIds.map((eid) => ({ entity_id: eid })),
          (eid) => entityMap.get(eid),
          3,
          rel,
          resolveSoloName,
        ) || 'Unnamed'
      }
      alerts.push({
        id: `relationship_solo-${rel.id}`,
        type: 'relationship_solo',
        nodeId: endNodeId || triggerNodeId,
        endNodeId,
        actionType: hadMultiple ? 'end_here' : 'delete',
        relationshipId: rel.id,
        relationshipName: resolvedRelName,
        entityId: soloEntityId,
        entityName: soloEntity?.name || 'Unknown',
        entityAlias: soloAlias,
        leaverEntityId,
        leaverEntityName: leaverEntity?.name || null,
        leaverAlias,
        nodeSummary: null,
      })
    }

    // ── Relationship downstream overlap ──────────────────────────────────────
    // Fires when an existing relationship R' contains every participant of
    // another relationship R (exact match or strict superset) at some node in
    // R's effective chain. Flags the earliest such node — not every
    // subsequent scene — matching the upstream-change anti-spam pattern.
    //
    // Rule (mirrors the duplicate-creation guard at write time):
    //   - For every pair (R, R'), at each node N in R's chain where R is
    //     active: if R's effective participant set ⊆ R's effective set
    //     (i.e. R' contains all of R's participants), it's a match.
    //   - Partial overlap (1-of-3 shared) and R-is-larger are NOT matches.
    //   - Equal-set pairs dedupe to a single alert keyed on the
    //     lexicographically-smaller rel id so the user doesn't see two
    //     mirrored alerts for the same conflict.
    //   - Membership-of rels skipped (faction containers are semantically
    //     different — see findDuplicateAt{Origin,Scene} in
    //     utils/relationshipHistory.js for the same skip).
    //
    // Precomputed per rel: node order, its set, and per-node effective
    // state — so the N² pair sweep is linear in chain-node count.
    const relInfo = new Map()
    for (const rel of relationships) {
      if (rel.membership_of) continue
      const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder)
      const nodeOrderSet = new Set(nodeOrder)
      const stateByNode = new Map()
      for (const nid of nodeOrder) {
        stateByNode.set(nid, computeRelationshipEffectiveState(rel, nodeOrder, nid))
      }
      relInfo.set(rel.id, { rel, nodeOrder, nodeOrderSet, stateByNode })
    }

    const labelForRel = (rel, anchorNodeId) => {
      if (rel.name) return rel.name
      const joinIds = Array.from(new Set(
        (rel.history?.participant_changes || [])
          .filter((c) => c.action === 'join')
          .map((c) => c.entity_id)
      ))
      const resolveHere = anchorNodeId ? (eid) => {
        const ent = entityMap.get(eid)
        if (!ent) return null
        const s = computeEffectiveState(ent, nodes, edges, anchorNodeId)
        return s?.name || ent.name || null
      } : null
      return participantsFallbackLabel(
        joinIds.map((eid) => ({ entity_id: eid })),
        (eid) => entityMap.get(eid),
        3,
        rel,
        resolveHere,
      ) || 'Unnamed'
    }

    const emitted = new Set()
    for (const [relAId, infoA] of relInfo) {
      for (const nodeId of infoA.nodeOrder) {
        const stateA = infoA.stateByNode.get(nodeId)
        if (!stateA?.is_active) continue
        const setA = new Set((stateA.participants || []).map((p) => p.entity_id))
        if (setA.size === 0) continue

        for (const [relBId, infoB] of relInfo) {
          if (relBId === relAId) continue
          if (!infoB.nodeOrderSet.has(nodeId)) continue
          const key = `${relAId}:${relBId}`
          if (emitted.has(key)) continue
          const stateB = infoB.stateByNode.get(nodeId)
          if (!stateB?.is_active) continue
          const setB = new Set((stateB.participants || []).map((p) => p.entity_id))
          if (setB.size === 0) continue

          // Is setB ⊇ setA? (setB contains every participant of setA)
          let isSuperset = true
          for (const id of setA) if (!setB.has(id)) { isSuperset = false; break }
          if (!isSuperset) continue

          // Equal-set case: only emit for the lex-smaller rel id so we don't
          // double-fire on the symmetric pair (R,R') / (R',R).
          if (setB.size === setA.size && relBId < relAId) continue

          emitted.add(key)
          alerts.push({
            id: `relationship_downstream_overlap-${key}`,
            type: 'relationship_downstream_overlap',
            nodeId,
            relationshipId: relAId,
            relationshipName: labelForRel(infoA.rel, nodeId),
            conflictRelationshipId: relBId,
            conflictRelationshipName: labelForRel(infoB.rel, nodeId),
            matchKind: setB.size === setA.size ? 'exact' : 'superset',
            pairKey: key,
            nodeSummary: null,
          })
        }
      }
    }

    // ── Phase 1.21g — membership-change alerts ────────────────────────
    // Walk every leave / list_remove that affects a referenced
    // awareness source. For each affected awareness field, compute the
    // departing entity's resolved level on that field at the chain
    // stop just BEFORE the event versus AT the event. If the level
    // didn't change (entity still covered at >= prior level via another
    // contributor or a winning direct entry), suppress. Otherwise fire
    // a 'full_removal' alert (level drops to absent) or 'downgrade'
    // alert (level drops to a lower non-null value).
    // `sourceConsumers` is now hoisted to its own useMemo above; consumed here.
    if (sourceConsumers.size > 0) {
      // Resolve a consumer descriptor's awareness field shape for
      // before/after comparison. Returns the raw wrapper (or null /
      // flat dict) on the carrier surface.
      function readConsumerAwareness(consumer) {
        if (consumer.surfaceKind === 'entity') {
          const ent = entityMap.get(consumer.surfaceId)
          if (!ent) return null
          return consumer.awarenessFieldPath === 'name_awareness' ? (ent.name_awareness ?? null) : (ent.awareness ?? null)
        }
        if (consumer.surfaceKind === 'attribute') {
          const owner = entityMap.get(consumer.parentEntityId)
          if (!owner) return null
          const attr = (owner.attributes || []).find((a) => a.id === consumer.surfaceId)
          return attr?.awareness ?? null
        }
        if (consumer.surfaceKind === 'alias') {
          const owner = entityMap.get(consumer.parentEntityId)
          if (!owner) return null
          const alias = (owner.aliases || []).find((a) => (typeof a === 'string' ? a : a.value) === consumer.surfaceId)
          if (!alias || typeof alias === 'string') return null
          return alias.awareness ?? null
        }
        if (consumer.surfaceKind === 'relationship') {
          const rel = (relationships || []).find((r) => r.id === consumer.surfaceId)
          return rel?.awareness ?? null
        }
        if (consumer.surfaceKind === 'knowledge') {
          const k = (projectKnowledges || []).find((k2) => k2.id === consumer.surfaceId)
          return k?.awareness ?? null
        }
        return null
      }

      // Story-order index for "scene just before this scene" lookups.
      const storyOrderIndex = new Map((storyOrder?.orderedIds || []).map((id, i) => [id, i]))
      function priorSceneIdOf(nodeId) {
        const idx = storyOrderIndex.get(nodeId)
        if (!Number.isFinite(idx) || idx <= 0) return null
        return storyOrder.orderedIds[idx - 1]
      }

      function pushMembershipAlert({ event, sourceLabel, consumer, leavingEntity, beforeLevel, afterLevel }) {
        const flavour = (afterLevel === null || afterLevel === undefined) ? 'full_removal' : 'downgrade'
        const carrierLabel = describeConsumer(consumer, entityMap, relationships, projectKnowledges)
        alerts.push({
          id: `awareness_membership_change-${event.kind}-${event.sourceId}-${leavingEntity.id}-${event.atNodeId}-${consumer.surfaceKind}-${consumer.surfaceId}-${consumer.awarenessFieldPath}`,
          type: 'awareness_membership_change',
          flavour,
          nodeId: event.atNodeId,
          eventKind: event.kind,                    // 'relationship_leave' | 'attribute_list_remove'
          sourceKind: event.kind === 'relationship_leave' ? 'relationship' : 'attribute',
          sourceId: event.sourceId,                  // relationship id, or `${entityId}:${attributeId}`
          sourceLabel,                               // human-readable name of the source
          leavingEntityId: leavingEntity.id,
          leavingEntityName: leavingEntity.name,
          consumer: {
            surfaceKind: consumer.surfaceKind,
            surfaceId: consumer.surfaceId,
            parentEntityId: consumer.parentEntityId || null,
            awarenessFieldPath: consumer.awarenessFieldPath,
          },
          carrierLabel,
          beforeLevel: beforeLevel ?? null,
          afterLevel:  afterLevel  ?? null,
          nodeSummary: null,
        })
      }

      // ── Relationship leave events ─────────────────────────────────
      for (const rel of (relationships || [])) {
        const sourceKey = relationshipSourceKey(rel.id)
        const consumers = sourceConsumers.get(sourceKey)
        if (!consumers || consumers.size === 0) continue
        const leaves = (rel.history?.participant_changes || []).filter((c) => c?.action === 'leave' && c?.entity_id && c?.node_id)
        if (leaves.length === 0) continue
        const sourceLabel = labelForRel(rel, null)
        for (const ev of leaves) {
          const leaving = entityMap.get(ev.entity_id)
          if (!leaving) continue
          const priorNodeId = priorSceneIdOf(ev.node_id) || null
          const ctx = { allEntities, allRelationships: relationships, nodes, edges, anchorNodeId: ev.node_id }
          const ctxPrior = { ...ctx, anchorNodeId: priorNodeId }
          for (const consumer of consumers) {
            const aware = readConsumerAwareness(consumer)
            const beforeResolved = resolveAwarenessField(aware, ctxPrior) || {}
            const afterResolved  = resolveAwarenessField(aware, ctx)      || {}
            const before = beforeResolved[ev.entity_id]
            const after  = afterResolved[ev.entity_id]
            // Suppress if no effective change.
            if (before === after) continue
            // Suppress when after >= before (unrelated rise; not a removal).
            if (typeof before === 'number' && typeof after === 'number' && after >= before) continue
            pushMembershipAlert({
              event: { kind: 'relationship_leave', sourceId: rel.id, atNodeId: ev.node_id },
              sourceLabel,
              consumer,
              leavingEntity: leaving,
              beforeLevel: before,
              afterLevel: after,
            })
          }
        }
      }

      // ── Entity-list-attribute removal events ───────────────────────
      // Walk every node looking for `attribute_changes` with action='list_remove'
      // on an entity_list attribute that's referenced as a source.
      function* iterateAttributeChanges() {
        for (const n of nodes) {
          if (n.type === 'sceneNode') {
            for (const bucket of ENTITY_BUCKETS) {
              for (const ref of (n.data?.[bucket] || [])) {
                for (const ac of (ref.attribute_changes || [])) {
                  yield { entityId: ref.entity_id, atNodeId: n.id, ac }
                }
              }
            }
          } else if (n.type === 'entityNode' && n.data?.entity_id) {
            for (const ac of (n.data?.attribute_changes || [])) {
              yield { entityId: n.data.entity_id, atNodeId: n.id, ac }
            }
          }
        }
      }
      for (const { entityId, atNodeId, ac } of iterateAttributeChanges()) {
        if (ac?.action !== 'list_remove' || !ac.attribute_id || ac.list_item == null) continue
        const owner = entityMap.get(entityId)
        if (!owner) continue
        const attr = (owner.attributes || []).find((a) => a.id === ac.attribute_id)
        if (!attr || attr.attribute_type !== 'entity_list') continue
        const sourceKey = attributeSourceKey(entityId, ac.attribute_id)
        const consumers = sourceConsumers.get(sourceKey)
        if (!consumers || consumers.size === 0) continue
        const removed = entityMap.get(ac.list_item)
        if (!removed) continue
        const priorNodeId = priorSceneIdOf(atNodeId) || null
        const ctx = { allEntities, allRelationships: relationships, nodes, edges, anchorNodeId: atNodeId }
        const ctxPrior = { ...ctx, anchorNodeId: priorNodeId }
        const sourceLabel = `${owner.name || 'Entity'}'s ${attr.name || 'list'}`
        for (const consumer of consumers) {
          const aware = readConsumerAwareness(consumer)
          const beforeResolved = resolveAwarenessField(aware, ctxPrior) || {}
          const afterResolved  = resolveAwarenessField(aware, ctx)      || {}
          const before = beforeResolved[ac.list_item]
          const after  = afterResolved[ac.list_item]
          if (before === after) continue
          if (typeof before === 'number' && typeof after === 'number' && after >= before) continue
          pushMembershipAlert({
            event: { kind: 'attribute_list_remove', sourceId: `${entityId}:${ac.attribute_id}`, atNodeId },
            sourceLabel,
            consumer,
            leavingEntity: removed,
            beforeLevel: before,
            afterLevel: after,
          })
        }
      }
    }

    // ── Alias-linkage ↔ entity-existence inconsistency ──
    // When an observer has entity-existence awareness = 0 (explicitly
    // unaware that the entity exists) but alias-linkage awareness = 3
    // (knows it's a pseudonym for the entity) for any of that entity's
    // aliases, the writer has declared a contradiction. Two passes:
    // (a) baseline pass — read raw `entries` from each wrapper; emit
    //     anchored at the entity origin (or null when no origin exists
    //     on canvas yet — resolution still works via {kind:'origin'}).
    // (b) chain-history pass — every node where either entity-existence
    //     or any alias-linkage was set to a contradiction-relevant
    //     level, recheck the resolved state at that node and emit if
    //     the contradiction is freshly true.
    // Fix #4 (Phase 3.7 perf — large-project load perf #4): inline helper to
    // detect "this awareness field has at least one entry in any shape".
    // Used by the early-skip guard below; the pass body needs at least
    // one populated entries-dict (baseline contradictions) OR at least
    // one history entry with an observer (chain anchors) on either the
    // entity or any of its aliases to produce any alert at all.
    const _hasAnyAwarenessOn = (aware) => {
      if (!aware) return false
      if (Array.isArray(aware.history) && aware.history.length > 0) return true
      const entries = aware.entries || aware
      // entries could be the awareness wrapper itself (flat dict shape)
      // OR a sub-field on a wrapper. Either way: any own key means data.
      for (const k in entries) {
        if (k === 'entries' || k === 'sources' || k === 'history') continue
        if (entries[k] !== undefined) return true
      }
      if (aware.entries && typeof aware.entries === 'object') {
        for (const _ in aware.entries) return true
      }
      return false
    }

    for (const entity of allEntities) {
      if (!entity?.id) continue
      if (entity.type === 'knowledge') continue

      // Fix #4: early-skip entities that have no awareness data anywhere
      // on themselves OR on any of their aliases. Without entity-level
      // existence awareness AND without alias-linkage awareness, neither
      // the baseline contradiction check (line ~1294) nor the chain-
      // history check (line ~1318) can produce an alert — both `entries`
      // and `history` are empty so every loop body is skipped. The
      // `nodes.find()` lookup below is O(N) per entity, so skipping it
      // for entities the pass already doesn't act on saves real time on
      // NC-imported projects (large-project shape: 47 entities × ~290 nodes =
      // ~13k unnecessary comparisons per `useAlerts` re-render).
      const _aliases = entity.aliases || []
      const hasAwarenessData = _hasAnyAwarenessOn(entity.awareness)
        || _aliases.some((a) => a != null && typeof a !== 'string' && _hasAnyAwarenessOn(a.awareness))
      if (!hasAwarenessData) continue

      const originNode = nodes.find(
        (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entity.id,
      )
      const originNodeId = originNode?.id || null

      const emitInconsistencyAlert = (nodeId, observerId, aliasValues, isOrigin) => {
        const node = nodeId ? nodes.find((n) => n.id === nodeId) : null
        const nodeSummary = node?.type === 'sceneNode'
          ? (node.data?.title || node.data?.description || 'Untitled Scene')
          : null
        const observer = entityMap.get(observerId)
        alerts.push({
          id: `awareness_alias_entity_inconsistency-${entity.id}-${observerId}-${nodeId || 'baseline'}`,
          type: 'awareness_alias_entity_inconsistency',
          nodeId,
          entityId: entity.id,
          entityName: entity.name || 'Entity',
          observerId,
          observerName: observer?.name || 'Observer',
          aliasValues,
          isOrigin,
          nodeSummary,
        })
      }

      // (a) Baseline pass — direct read of entries. The awareness field
      // can be either a flat dict `{obsId: level}` (no sources) or a
      // wrapper `{entries, sources, history}` (sources / history present).
      const readBaselineEntries = (awareness) => {
        if (!awareness || typeof awareness !== 'object') return {}
        if (Object.prototype.hasOwnProperty.call(awareness, 'entries')) return awareness.entries || {}
        return awareness
      }
      const baselineEntityEntries = readBaselineEntries(entity.awareness)
      for (const observerId of Object.keys(baselineEntityEntries)) {
        if (baselineEntityEntries[observerId] !== 0) continue
        const aliasesAt3 = []
        for (const alias of (entity.aliases || [])) {
          if (alias == null || typeof alias === 'string') continue
          const aliasEntries = readBaselineEntries(alias.awareness)
          if (aliasEntries[observerId] === 3) aliasesAt3.push(alias.value)
        }
        if (aliasesAt3.length > 0) {
          emitInconsistencyAlert(originNodeId, observerId, aliasesAt3, true)
        }
      }

      // (b) Chain-history pass — every history entry on entity-existence
      // or any alias's linkage that sets a contradiction-relevant level
      // is a candidate anchor; recompute resolved state at that node
      // and emit if the contradiction holds.
      const chainAnchors = new Map()  // nodeId -> Set<observerId>
      const considerEntry = (entry) => {
        if (!entry?.observer_id || !entry?.node_id) return
        if (entry.source_action) return
        if (!chainAnchors.has(entry.node_id)) chainAnchors.set(entry.node_id, new Set())
        chainAnchors.get(entry.node_id).add(entry.observer_id)
      }
      for (const h of (entity.awareness?.history || [])) considerEntry(h)
      for (const a of (entity.aliases || [])) {
        if (a == null || typeof a === 'string') continue
        for (const h of (a.awareness?.history || [])) considerEntry(h)
      }
      for (const [nodeId, observers] of chainAnchors) {
        for (const observerId of observers) {
          let entityLevel
          let aliasesAt3 = []
          try {
            const ctx = { allEntities, allRelationships: relationships, nodes, edges, anchorNodeId: nodeId, storyOrder }
            const eff = computeEffectiveState(entity, nodes, edges, nodeId, ctx)
            entityLevel = eff?.awareness?.[observerId]
            for (const alias of (eff?.aliases || [])) {
              if (alias == null || typeof alias === 'string' || !alias.value) continue
              if (alias?.awareness?.[observerId] === 3) aliasesAt3.push(alias.value)
            }
          } catch {
            continue
          }
          if (entityLevel === 0 && aliasesAt3.length > 0) {
            // Skip duplicates: if this matches the baseline alert (same
            // observer, same alias names) emit only the baseline one.
            const sameAsBaseline = (() => {
              const baselineLevel = baselineEntityEntries[observerId]
              if (baselineLevel !== 0) return false
              const baselineAliases = new Set()
              for (const alias of (entity.aliases || [])) {
                if (alias == null || typeof alias === 'string') continue
                if (alias.awareness?.entries?.[observerId] === 3) baselineAliases.add(alias.value)
              }
              if (baselineAliases.size !== aliasesAt3.length) return false
              for (const v of aliasesAt3) if (!baselineAliases.has(v)) return false
              return true
            })()
            if (sameAsBaseline) continue
            emitInconsistencyAlert(nodeId, observerId, aliasesAt3, false)
          }
        }
      }
    }

    return alerts
}

// Format a consumer descriptor as a short human-readable label for the
// membership-change alert. Used to identify "which awareness field is
// affected" when the user reads the alert.
function describeConsumer(consumer, entityMap, relationships, projectKnowledges) {
  if (!consumer) return null
  if (consumer.surfaceKind === 'entity') {
    const ent = entityMap.get(consumer.surfaceId)
    const name = ent?.name || 'Entity'
    if (consumer.awarenessFieldPath === 'name_awareness') return `${name}'s name awareness`
    return `${name}'s awareness`
  }
  if (consumer.surfaceKind === 'attribute') {
    const owner = entityMap.get(consumer.parentEntityId)
    const attr = (owner?.attributes || []).find((a) => a.id === consumer.surfaceId)
    return `${owner?.name || 'Entity'}'s ${attr?.name || 'attribute'} awareness`
  }
  if (consumer.surfaceKind === 'alias') {
    const owner = entityMap.get(consumer.parentEntityId)
    return `${owner?.name || 'Entity'}'s alias "${consumer.surfaceId}" awareness`
  }
  if (consumer.surfaceKind === 'relationship') {
    const rel = (relationships || []).find((r) => r.id === consumer.surfaceId)
    return `Relationship "${rel?.name?.trim() || rel?.id || 'unknown'}" awareness`
  }
  if (consumer.surfaceKind === 'knowledge') {
    const k = (projectKnowledges || []).find((kk) => kk.id === consumer.surfaceId)
    return `Knowledge "${k?.name || 'unknown'}" awareness`
  }
  return null
}
