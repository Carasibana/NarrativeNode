/**
 * useStoryOrder — React hook returning the current global story order.
 *
 * Single projectStore subscription whose selector resolves through the
 * shared module cache and returns the cached RESULT OBJECT — stable
 * identity across store writes that don't change the ordering, so the
 * ~250 consumer instances (every SceneNode, EntityNode, chip, panel)
 * re-render only when the order actually changed. See the comment on
 * the hook body for the gesture / load-storm gates.
 *
 * Return shape: see computeStoryOrder in utils/storyOrder.js.
 *
 * tierById.get(id) is undefined for non-chain-participating node types
 * (genericGroupNode, referenceNode). Callers must guard.
 *
 * The compute is pure id-in / id-out — no entity names, scene titles, or
 * chapter names are resolved here. Presentation layers handle name lookup.
 */

import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { getOrComputePovChain } from '../utils/povSequence'
import { computeStoryOrder } from '../utils/storyOrder'
import { rowGeometryParams, multirowHeaderRows } from '../utils/rowLayout'

const EMPTY_CHAPTERS = Object.freeze([])

// Module-level cache shared across every consumer of the hook. There's
// exactly one story-order result per running app (it derives from a
// single project + UI store), so caching by input reference identity
// lets the FIRST consumer to render after a deps change pay the compute
// cost, and every other consumer in the same render tick reads through.
//
// Cache shape: the four input refs the hook subscribes to, plus the
// resulting story order. Identity-equal refs hit the cache; any change
// (every `projectStore` mutation produces a new array reference via
// Zustand's immutable-update discipline — same invariant relied on by
// `useKnowledgeNodeMaps` and `useRelationshipNodeMaps`) misses and
// rebuilds.
//
// The drag short-circuit (`isDraggingNodes`) is kept as a layered
// fast-path: during a 60Hz node drag, return the most recent cached
// result regardless of ref freshness. Chapter-index (tier 5) and
// canvas-x (tier 6) are position-derived and intentionally stay stale
// during the drag; they snap to current the moment the writer releases
// (drag-stop flips the flag, the next render's identity check then
// invalidates because position changes produced a new `nodes` ref).
//
// A module variable (not `useRef`) avoids the `react-hooks/refs` rule.
// `loadGeneration` mirrors `projectStore.loadGeneration` (incremented
// on every project-load action). The load-storm short-circuit checks
// it so that opening project B doesn't return project A's cached
// storyOrder during B's load storm (when `_pendingFitView` is true).
let _cache = {
  nodes: null,
  edges: null,
  chapters: null,
  chapterXOffset: null,
  layoutMode: null,
  chapterRows: null,
  loadGeneration: null,
  result: null,
}

// Dev-only recompute instrumentation. The 2026-06-11 re-baseline
// traced ~0.7-1.1 s commit costs during load to a cold story-order
// recompute paid inside the first consumer to render after a cache
// miss; the React profiler attributes that cost to whichever
// component happens to render first, hiding the real source. Logging
// every recompute with its duration and which cache-key inputs lost
// identity makes the cost and its trigger visible straight from the
// console. Recomputes above the threshold log as warnings so slow
// ones stand out during a normal session.
const SLOW_RECOMPUTE_MS = 50
const IS_DEV = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV

function _changedCacheKeys(inputs, loadGeneration) {
  const changed = []
  if (_cache.nodes !== inputs.nodes) changed.push('nodes')
  if (_cache.edges !== inputs.edges) changed.push('edges')
  if (_cache.chapters !== inputs.chapters) changed.push('chapters')
  if (_cache.chapterXOffset !== inputs.chapterXOffset) changed.push('chapterXOffset')
  if (_cache.loadGeneration !== loadGeneration) changed.push('loadGeneration')
  return changed
}

// Story-order-scoped structural equality. `computeStoryOrder` consumes
// per-node: id, type, data (chips and chapter membership ride data)
// and position.x / position.y (chapter-column resolution + canvas-x
// fallback tiers). Per-edge: id, endpoints, handles, data. Renderer
// bookkeeping that rides the same arrays (measured dimensions,
// selection flags, dragging state) deliberately does NOT participate:
// a store write that only churns those fields produces arrays this
// comparison calls equal, and the cached order is reused without
// paying the multi-hundred-ms recompute. The 2026-06-11 post-fix
// profiles showed exactly that failure mode: rhythmic store writes
// invalidating the identity-keyed cache ~13 times per minute, each
// costing ~1-1.5 s inside whichever consumer rendered first.
//
// Note: node.data DOES participate (compared by reference). A node's
// rendered height is written back into node.data by its component as it
// measures, and height CAN change chapter membership (a node growing
// across a chapter boundary), so it is a legitimate order input. The
// load-time burst of those writes is absorbed by the `_loadSettling`
// gate (see the hook below), NOT by excluding height from this compare.
export function storyOrderNodesEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === y) continue
    if (!x || !y) return false
    if (x.id !== y.id) return false
    if (x.type !== y.type) return false
    // ovum_white — decorative egg-spawned nodes (tagged data._egg) are
    // not story-order inputs; skip their data compare so egg-driven node
    // updates don't miss the cache and force a recompute.
    if (!(x.data?._egg || y.data?._egg) && x.data !== y.data) return false
    const px = x.position, py = y.position
    if (px !== py) {
      if (!px || !py) return false
      if (px.x !== py.x || px.y !== py.y) return false
    }
  }
  return true
}

export function storyOrderEdgesEqual(a, b) {
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
    // ovum_white — decorative egg-spawned edges (tagged data._egg) get a
    // fresh data object every frame; that churn is not a story-order
    // input, so skip the data compare and don't let it miss the cache
    // and force a full recompute each frame it runs.
    if (x.data?._egg || y.data?._egg) continue
    if (x.data !== y.data) return false
  }
  return true
}

// Shared cache lookup: fast identity check first, then the structural
// fallback above. Returns the cached result or null. On a structural
// hit the cached input refs are refreshed to the new identities so the
// NEXT lookup takes the fast identity path again.
function _cacheLookup(inputs, loadGeneration, caller) {
  if (_cache.loadGeneration !== loadGeneration || !_cache.result) return null
  if (_cache.chapters !== inputs.chapters || _cache.chapterXOffset !== inputs.chapterXOffset) return null
  // Phase 4.3 — the layout mode + row grouping feed `computeStoryOrder`'s
  // position canonicalization, so a change to either must recompute. The
  // acts-expanded flag changes the header allowance the canonicalization
  // subtracts, so it's part of the key too.
  if (_cache.layoutMode !== inputs.layoutMode || _cache.chapterRows !== inputs.chapterRows) return null
  if (_cache.actsExpanded !== inputs.actsExpanded) return null
  if (_cache.nodes === inputs.nodes && _cache.edges === inputs.edges) return _cache.result
  if (storyOrderNodesEqual(_cache.nodes, inputs.nodes) && storyOrderEdgesEqual(_cache.edges, inputs.edges)) {
    if (IS_DEV) {
      console.debug(`[storyOrder] identity miss, structural hit - cache reused (caller=${caller})`)
    }
    _cache = { ..._cache, nodes: inputs.nodes, edges: inputs.edges }
    return _cache.result
  }
  return null
}

// Single recompute path shared by the React hook and the non-React
// helper below, so the instrumentation covers every recompute
// regardless of entry point. `caller` tags where the cost was paid:
// 'render' = inside a component render via `useStoryOrder`,
// 'event' = an event-handler / idle-callback path via
// `getOrComputeStoryOrder`.
function _recomputeStoryOrder(inputs, loadGeneration, caller) {
  const changed = IS_DEV ? _changedCacheKeys(inputs, loadGeneration) : null
  const t0 = IS_DEV ? performance.now() : 0
  const povChain = getOrComputePovChain(inputs.nodes, inputs.edges)
  // Phase 4.3 — pass the live layout mode + row grouping so order reads
  // each node's canonical (single-row) position. The geometry's vertical
  // allowance depends on whether the acts header is expanded (2 header
  // rows) or collapsed (1) — order canonicalization must subtract the
  // SAME allowance the node positions were anchored to, or the geometry
  // delta won't cancel. `actsExpanded` rides the cache key for that
  // reason. In single-row mode (the default) headerRows is always 1.
  const geom = rowGeometryParams(
    inputs.chapterXOffset,
    multirowHeaderRows(inputs.layoutMode, inputs.actsExpanded),
  )
  const result = computeStoryOrder({
    nodes: inputs.nodes, edges: inputs.edges, povChain,
    chapters: inputs.chapters, chapterXOffset: inputs.chapterXOffset,
    layoutMode: inputs.layoutMode, chapterRows: inputs.chapterRows,
    rowsTopY: geom.rowsTopY, rowGap: geom.rowGap, singleRowTopY: geom.singleRowTopY,
  })
  if (IS_DEV) {
    const ms = performance.now() - t0
    const msg = `[storyOrder] recompute ${ms.toFixed(1)}ms`
      + ` (changed: ${changed.length ? changed.join(', ') : 'none/cold'};`
      + ` nodes=${inputs.nodes.length}, edges=${inputs.edges.length}, caller=${caller})`
    if (ms >= SLOW_RECOMPUTE_MS) console.warn(msg)
    else console.debug(msg)
    // Tier-5 sanity check (moved here from the old hook body so it
    // covers every recompute path): a large share of nodes resolving
    // at the canvas-x fallback tier usually means missing POV /
    // chapter signals.
    const total = result.orderedIds.length
    if (total > 0) {
      let tier5 = 0
      for (const t of result.tierById.values()) if (t === 5) tier5++
      if (tier5 > total * 0.2) {
        console.warn(`[storyOrder] ${tier5}/${total} nodes resolved at tier 5 (canvas-x). Investigate for missing POV / chapter signals.`)
      }
    }
  }
  _cache = { ...inputs, loadGeneration, result }
  return result
}

export function useStoryOrder() {
  // Phase 4.1g follow-up — single-subscription shape. The hook used to
  // hold raw `s.nodes` + `s.edges` subscriptions (plus five more), so
  // EVERY consumer instance — 173 SceneNodes, 47 EntityNodes, every
  // chip — re-rendered on every nodes/edges identity write even when
  // the ordering result was unchanged. The 2026-06-12 action-test
  // forensics measured exactly that: each gesture frame's store write
  // re-rendered all consumers (~450-700 ms commits) on top of a
  // ~150 ms recompute. Now there is ONE projectStore subscription
  // whose selector resolves through the shared module cache and
  // returns the RESULT OBJECT: identity-stable across writes that
  // hit the cache (identity or structural), so consumers re-render
  // only when the story order actually changed.
  //
  // Gesture gates are subscribed reactively: `isDraggingNodes` (node
  // drags, ~60 Hz position writes) and `canvasGestureActive` (corner
  // resize, chapter-border drags — Phase 4.1g follow-up) serve the
  // cached result mid-gesture regardless of content changes, so a
  // continuous gesture costs ONE recompute at gesture end (the flag
  // flip re-renders consumers, whose selector then resolves fresh).
  // Position-derived tiers (5 chapter-index, 6 canvas-x) are
  // deliberately stale mid-gesture and snap on release — the moment
  // the writer cares about. `_pendingFitView` plus `_loadSettling` keep
  // the load-storm short-circuit across the WHOLE post-load settle:
  // `_pendingFitView` covers the initial fitView, and `_loadSettling`
  // extends the gate through the measurement + grow-refit window (cleared
  // on a debounce in `projectStore` once node sizes stop changing). Each
  // measured-height write could legitimately shift chapter membership, so
  // rather than ignore them, the gate serves the cached order until the
  // layout settles, then releases for ONE recompute. The generation match
  // stops a prior project's cache leaking into a new load.
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  return useProjectStore((s) => {
    if ((gestureActive || s._pendingFitView || s._loadSettling) && _cache.result && _cache.loadGeneration === s.loadGeneration) {
      return _cache.result
    }
    return getOrComputeStoryOrder({
      nodes: s.nodes,
      edges: s.edges,
      chapters: s.story?.chapters || EMPTY_CHAPTERS,
      chapterXOffset: typeof s.story?.chapter_x_offset === 'number' ? s.story.chapter_x_offset : 10,
      layoutMode: s.story?.canvas_layout_mode || 'single',
      chapterRows: s.story?.chapter_rows || null,
      actsExpanded: !!s.story?.multirow_acts_expanded,
    })
  })
}

/**
 * Non-React helper for hot-path callers in event handlers and store
 * actions (F#4, F#5): pre-flight `computeStoryOrder` invocations that
 * fire outside the React render tree and previously paid the full
 * graph walk every time. Reads the same module-level cache the hook
 * populates: identity-equal inputs return the cached result; any
 * single ref change recomputes, updates the cache, and returns the
 * new result.
 *
 * Callers should pass the current store state for `nodes` / `edges` /
 * `chapters` / `chapterXOffset` (e.g. `useProjectStore.getState()`-
 * derived). The drag short-circuit applied by the hook is NOT mirrored
 * here — these callers (Canvas connect-start, edge-validation guards)
 * fire from user actions whose correctness depends on current order,
 * not the deliberately-stale mid-drag snapshot.
 */
export function getOrComputeStoryOrder({ nodes, edges, chapters, chapterXOffset, layoutMode = 'single', chapterRows = null, actsExpanded = false }) {
  // Pull `loadGeneration` from the current project-store state so the
  // cache write here stays consistent with the React-hook path's
  // cache shape. Without this, the helper would overwrite the cache
  // with `loadGeneration: undefined`, causing the React hook's next
  // identity check to miss and force a recompute even when no
  // structural input changed.
  const loadGeneration = useProjectStore.getState().loadGeneration
  const inputs = { nodes, edges, chapters, chapterXOffset, layoutMode, chapterRows, actsExpanded }
  const cached = _cacheLookup(inputs, loadGeneration, 'event')
  if (cached) return cached
  return _recomputeStoryOrder(inputs, loadGeneration, 'event')
}

/**
 * Convenience variant of `getOrComputeStoryOrder` that derives its
 * inputs from the current project-store state. For event handlers
 * that don't already subscribe to `chapters` / `chapter_x_offset`:
 * deriving them here (with the shared `EMPTY_CHAPTERS` fallback)
 * keeps the cache key consistent with the React-hook path, so a
 * handler call never poisons the cache with a fresh empty-array
 * reference.
 */
export function getOrComputeStoryOrderFromStore() {
  const s = useProjectStore.getState()
  return getOrComputeStoryOrder({
    nodes: s.nodes,
    edges: s.edges,
    chapters: s.story?.chapters || EMPTY_CHAPTERS,
    chapterXOffset: typeof s.story?.chapter_x_offset === 'number' ? s.story.chapter_x_offset : 10,
    layoutMode: s.story?.canvas_layout_mode || 'single',
    chapterRows: s.story?.chapter_rows || null,
    actsExpanded: !!s.story?.multirow_acts_expanded,
  })
}
