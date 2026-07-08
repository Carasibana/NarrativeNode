/**
 * Story Order — the single global ordering used by every chain walker.
 *
 * Implements a 13-tier cascade. The algorithm builds the order
 * constructively (the "bookshelf model"): each tier inserts orderings into
 * gaps prior tiers left open. No tier ever moves a pair already decided by
 * an earlier tier.
 *
 *    0. Origin vs non-origin (origin sorts first; origin-vs-origin pairs
 *       carry through to tiers 5+).
 *    1. POV chain adjacent pairs (POV[i] before POV[i+1]).
 *    2. Placeable entity chains. Closure: a chain is placeable iff one of
 *       its scenes is in the placeable scene set (seeded with POV scenes,
 *       then transitively expanded by other placeable chains). Every i<j
 *       pair within a placeable chain becomes a tier-2 fact.
 *    3. Orphan segments (chains and sub-chains step 2 didn't place). Every
 *       i<j pair within an orphan segment becomes a tier-3 fact. Orphan
 *       segments that share scenes (with each other or with the placed
 *       known order) fuse via the constraint graph's topological combination
 *       — no separate overlay pass is needed.
 *    4. POV reachability. A non-origin node is POV-reachable iff it is in
 *       the connected component of `povOriginNode` in the unified
 *       POV-path-edge + entity-chain-edge graph (treating edges as
 *       undirected for the connectivity check). POV-reachable non-origins
 *       sort before non-POV-reachable non-origins.
 *    5. Chapter index. Phantom -1 for nodes left of all chapters; phantom
 *       numChapters for nodes right of all chapters.
 *    6. Canvas x.
 *    7. Canvas y.
 *    8. Node type rank.
 *    9. Name presence (named before unnamed).
 *   10. Name numeric order.
 *   11. Name alphabetical order.
 *   12. UUID order (terminal — guarantees a unique total order).
 *
 * Algorithmic model: CONSTRAINT ACCUMULATION via a tier-priority guard.
 * Each tier contributes pairwise ordering facts `(predId, succId, tier)` to
 * a shared constraint graph. The graph rejects facts that would create a
 * cycle with already-accepted facts (transitive consistency), AND facts
 * whose pair is already covered by a stronger tier (no-override). After
 * all tiers contribute, a topological sort produces the final total order.
 *
 * Side outputs:
 *   tierById       — the decisive tier for each node (max of left/right
 *                    adjacency tiers in the final order).
 *   reasonById     — left/right adjacency reasons (id-only; name resolution
 *                    is the presentation layer's job).
 *   tierSnapshots  — array of length 13, one entry per tier. Each captures
 *                    the new pair facts at that tier and the
 *                    weakly-connected components of the cumulative subgraph.
 *
 * Wire-creation blocks may only consult tiers 0-2 — see
 * `wouldContradictStoryOrder`.
 */

import { getEntityNarrativeChain, buildChainLookupMaps, ENTITY_BUCKETS } from './narrativeChain.js'
import { getChapterIdForNode } from './chapterMembership.js'
import { toCanonicalPosition } from './rowLayout.js'

/**
 * Node types that participate in the narrative chain and receive an ordering.
 * Excluded types (genericGroupNode, referenceNode) get no tier, no index, and
 * never appear in orderedIds.
 */
export const CHAIN_PARTICIPATING_NODE_TYPES = Object.freeze(new Set([
  'sceneNode',
  'entityNode',
  'relationshipOriginNode',
  'povOriginNode',
  'knowledgeOriginNode',
]))

const ORIGIN_NODE_TYPES = new Set([
  'relationshipOriginNode',
  'povOriginNode',
  'knowledgeOriginNode',
])

function isOriginNode(node) {
  if (!node) return false
  if (ORIGIN_NODE_TYPES.has(node.type)) return true
  if (node.type === 'entityNode' && node.data?.is_modifier !== true) return true
  return false
}

function isNarrativeFlowEdge(edge) {
  return !edge.data?.is_relationship && !edge.data?.is_pov_path
}

/**
 * Edges that participate in tier-4 reachability: POV-path edges and
 * entity-chain edges (everything except relationship edges).
 */
function isStructuralEdge(edge) {
  return !edge.data?.is_relationship
}

/**
 * Node-type sort priority for tier 8. Lower sorts earlier.
 */
function nodeTypeRank(node) {
  switch (node?.type) {
    case 'sceneNode':              return 0
    case 'entityNode':             return node.data?.is_modifier ? 1 : 2
    case 'relationshipOriginNode': return 3
    case 'knowledgeOriginNode':    return 4
    case 'povOriginNode':          return 5
    default:                       return 9
  }
}

/**
 * Extract the first parseable number from a string. Returns null if none.
 */
function firstNumber(s) {
  if (!s) return null
  const m = String(s).match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

function nodeName(node) {
  const d = node?.data || {}
  return d.title || d.name || ''
}

/**
 * Tier 9-12 cascade as a comparator. Kept for legacy callers.
 */
export function compareNodeName(a, b) {
  const an = nodeName(a)
  const bn = nodeName(b)
  const aNamed = an.trim().length > 0
  const bNamed = bn.trim().length > 0
  if (aNamed !== bNamed) return aNamed ? -1 : 1
  if (aNamed && bNamed) {
    const anum = firstNumber(an)
    const bnum = firstNumber(bn)
    if (anum != null && bnum != null && anum !== bnum) return anum - bnum
    const cmp = an.localeCompare(bn)
    if (cmp !== 0) return cmp
  }
  return (a.id || '').localeCompare(b.id || '')
}

/**
 * Decide which of (x, y) is the predecessor by the name cascade rules,
 * returning { predId, succId, payload }. Used for tiers 9/10/11/12.
 */
function nameCascadeOrdered(x, y) {
  const xn = nodeName(x)
  const yn = nodeName(y)
  const xNamed = xn.trim().length > 0
  const yNamed = yn.trim().length > 0
  if (xNamed !== yNamed) {
    const [pred, succ] = xNamed ? [x, y] : [y, x]
    return {
      predId: pred.id,
      succId: succ.id,
      payload: { tier: 9, kind: 'namedBeforeUnnamed', aNamed: true, bNamed: false },
    }
  }
  if (xNamed && yNamed) {
    const xnum = firstNumber(xn)
    const ynum = firstNumber(yn)
    if (xnum != null && ynum != null && xnum !== ynum) {
      const [pred, succ] = xnum < ynum ? [x, y] : [y, x]
      const predNum = Math.min(xnum, ynum)
      const succNum = Math.max(xnum, ynum)
      return {
        predId: pred.id,
        succId: succ.id,
        payload: { tier: 10, kind: 'numeric', aNumber: predNum, bNumber: succNum },
      }
    }
    const cmp = xn.localeCompare(yn)
    if (cmp !== 0) {
      const [pred, succ] = cmp < 0 ? [x, y] : [y, x]
      const predName = cmp < 0 ? xn : yn
      const succName = cmp < 0 ? yn : xn
      return {
        predId: pred.id,
        succId: succ.id,
        payload: { tier: 11, kind: 'alphabetical', aName: predName, bName: succName },
      }
    }
  }
  // UUID fallback — deterministic by id compare.
  const ids = (x.id || '').localeCompare(y.id || '')
  const [pred, succ] = ids <= 0 ? [x, y] : [y, x]
  return {
    predId: pred.id,
    succId: succ.id,
    payload: { tier: 12, kind: 'uuid' },
  }
}

/**
 * Collect the set of entity ids declared in the story.
 */
function collectEntityIds(nodes) {
  const ids = new Set()
  for (const n of nodes) {
    if (n.type === 'entityNode' && n.data?.entity_id) {
      ids.add(n.data.entity_id)
    } else if (n.type === 'sceneNode') {
      for (const b of ENTITY_BUCKETS) {
        for (const ref of (n.data?.[b] || [])) {
          if (ref?.entity_id) ids.add(ref.entity_id)
        }
      }
    }
  }
  return ids
}

/**
 * Return every node carrying a chip for the given entity id.
 */
function nodesCarryingEntity(entityId, nodes) {
  const result = []
  for (const n of nodes) {
    if (n.type === 'sceneNode') {
      const present = ENTITY_BUCKETS.some((b) =>
        (n.data?.[b] || []).some((r) => r.entity_id === entityId)
      )
      if (present) result.push(n)
    } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id === entityId) {
      result.push(n)
    }
  }
  return result
}

/**
 * Constraint graph. Each unordered pair is recorded with the strongest tier
 * that ordered it. addFact rejects (a) pairs already covered by an earlier
 * tier and (b) pairs whose acceptance would close a cycle with already-
 * accepted facts.
 */
class ConstraintGraph {
  constructor() {
    this.pairTierMap = new Map()
    this.successors = new Map()
    this.inDegree = new Map()
    this.allNodes = new Set()
    // Incrementally-maintained transitive closure as per-node bitsets.
    // `closure[i]` holds the indices of every node reachable FROM node
    // index i via accepted facts. Replaces the per-call BFS that F#3's
    // visited-table version still paid: the Phase 4.1 profiling on a
    // heavily-wired project showed the tiers 5-12 pair loop spending
    // ~650 ms of a 683 ms run inside cycle checks (~39k addFact calls,
    // each walking the accumulated successor graph). With the closure
    // maintained on accept, the cycle check is a single bit test and
    // the cost moves to a bounded row-OR per accepted fact. The
    // accept/reject decisions are identical to the BFS version:
    // reachability is reachability, computed eagerly instead of
    // re-derived per query.
    this.nodeIndex = new Map()
    this.closure = []
    this.closureWords = 1
  }

  registerNode(id) {
    if (!this.allNodes.has(id)) {
      this.allNodes.add(id)
      this.successors.set(id, new Set())
      this.inDegree.set(id, 0)
      const idx = this.nodeIndex.size
      this.nodeIndex.set(id, idx)
      const words = (idx >> 5) + 1
      if (words > this.closureWords) this.closureWords = words
      this.closure.push(new Uint32Array(this.closureWords))
    }
  }

  // Fetch node `idx`'s closure row, growing it to the current word
  // width first (rows allocated before later registrations are
  // narrower; reads tolerate short rows, writes normalise them).
  _row(idx) {
    let row = this.closure[idx]
    if (row.length < this.closureWords) {
      const next = new Uint32Array(this.closureWords)
      next.set(row)
      this.closure[idx] = next
      row = next
    }
    return row
  }

  _pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /**
   * Returns true iff `to` is reachable from `from` via accepted facts.
   * O(1): a single bit test against the maintained closure.
   */
  _reaches(from, to) {
    if (from === to) return true
    const fi = this.nodeIndex.get(from)
    const ti = this.nodeIndex.get(to)
    if (fi == null || ti == null) return false
    const row = this.closure[fi]
    const word = ti >> 5
    if (word >= row.length) return false
    return (row[word] & (1 << (ti & 31))) !== 0
  }

  /**
   * Contribute a pair fact. No-op if a stronger tier already covers the pair
   * or if the fact would close a cycle with already-accepted facts.
   */
  addFact(predId, succId, tier, payload) {
    if (predId === succId) return
    this.registerNode(predId)
    this.registerNode(succId)
    const key = this._pairKey(predId, succId)
    if (this.pairTierMap.has(key)) return
    if (this._reaches(succId, predId)) return
    this.pairTierMap.set(key, { tier, predId, payload })
    const outs = this.successors.get(predId)
    if (!outs.has(succId)) {
      outs.add(succId)
      this.inDegree.set(succId, this.inDegree.get(succId) + 1)
      // Closure maintenance: every node that reaches `pred` (plus
      // `pred` itself) now also reaches `succ` and everything `succ`
      // reaches. `succ`'s own row is never in that ancestor set here:
      // succ reaching pred was rejected as a cycle above.
      const pi = this.nodeIndex.get(predId)
      const si = this.nodeIndex.get(succId)
      const succRow = this._row(si)
      const w = succRow.length
      const sWord = si >> 5
      const sBit = 1 << (si & 31)
      const pWord = pi >> 5
      const pBit = 1 << (pi & 31)
      const n = this.closure.length
      for (let x = 0; x < n; x++) {
        const xr = this.closure[x]
        const reachesPred = x === pi || (pWord < xr.length && (xr[pWord] & pBit) !== 0)
        if (!reachesPred) continue
        const target = this._row(x)
        for (let k = 0; k < w; k++) target[k] |= succRow[k]
        target[sWord] |= sBit
      }
    }
  }

  has(a, b) {
    return this.pairTierMap.has(this._pairKey(a, b))
  }

  get(a, b) {
    return this.pairTierMap.get(this._pairKey(a, b)) || null
  }
}

/**
 * Deterministic topological sort using Kahn's algorithm with smallest-id
 * tiebreaker. Tier 12 (UUID) ensures a complete DAG, so the result is unique.
 */
function topologicalSort(graph) {
  const inDeg = new Map()
  for (const [id, d] of graph.inDegree) inDeg.set(id, d)
  const succ = graph.successors

  const ready = []
  for (const [id, d] of inDeg) if (d === 0) ready.push(id)
  ready.sort()

  const ordered = []
  while (ready.length > 0) {
    const id = ready.shift()
    ordered.push(id)
    for (const next of succ.get(id) || []) {
      const d = inDeg.get(next) - 1
      inDeg.set(next, d)
      if (d === 0) {
        let i = 0
        while (i < ready.length && ready[i] < next) i++
        ready.splice(i, 0, next)
      }
    }
  }

  if (ordered.length < graph.allNodes.size) {
    const placed = new Set(ordered)
    const leftovers = []
    for (const id of graph.allNodes) if (!placed.has(id)) leftovers.push(id)
    leftovers.sort()
    ordered.push(...leftovers)
  }
  return ordered
}

/**
 * Main entry point.
 */
export function computeStoryOrder({ nodes = [], edges = [], povChain = null, chapters = [], chapterXOffset = 10, includeTierSnapshots = false, layoutMode = 'single', chapterRows = null, rowsTopY = 0, rowGap = 0, singleRowTopY = 0 } = {}) {
  // Dev-only phase profiler. A full run costs ~0.6-1.7 s on heavily
  // wired projects and blocks the commit that pays it; the breakdown
  // identifies which phase carries the cost so optimization is
  // evidence-driven. Logs once per run when the total crosses the
  // threshold; silent otherwise and absent from production builds.
  const PROFILE = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
  const phaseTimes = PROFILE ? [] : null
  let _phaseT = PROFILE ? performance.now() : 0
  const _profStart = _phaseT
  const markPhase = (label) => {
    if (!PROFILE) return
    const now = performance.now()
    phaseTimes.push([label, now - _phaseT])
    _phaseT = now
  }

  const includedNodes = nodes.filter((n) => CHAIN_PARTICIPATING_NODE_TYPES.has(n.type))
  const nodeById = new Map(includedNodes.map((n) => [n.id, n]))
  const narrativeEdges = edges.filter(isNarrativeFlowEdge)
  // F#8: build the id-keyed lookup maps used by `getEntityNarrativeChain`
  // once at outer scope; every chain walk inside this function reuses
  // them. Without this the per-entity loop below would have the chain
  // walker rebuild local maps on every invocation. Built from the FULL
  // `nodes` / `edges` arrays so the walker can traverse through any
  // node type, not just the `CHAIN_PARTICIPATING_NODE_TYPES` subset.
  const chainLookupMaps = buildChainLookupMaps(nodes, edges)

  const graph = new ConstraintGraph()
  for (const n of includedNodes) graph.registerNode(n.id)

  // Chapter rank lookup. Phantom -1 for nodes positioned left of all chapters,
  // phantom numChapters for nodes positioned right of all chapters.
  const chaptersList = chapters || []
  const numChapters = chaptersList.length
  const chapterIndexById = new Map()
  for (let i = 0; i < numChapters; i++) chapterIndexById.set(chaptersList[i].id, i)

  // ── Mode-invariant canonical positions (Phase 4.3 §2 hard invariant) ──
  // Tiers 5-7 (chapter index, canvas-x, canvas-y) are the only
  // position-sensitive tiers. Story order must read each node's CANONICAL
  // (single-row) position so toggling layout modes never changes the
  // computed order. In single-row mode (the default, and the only mode
  // before 4.3) `multiRow` is false: `posOf` returns the live position
  // unchanged and `stripChapters` is `chaptersList` verbatim, so this
  // whole block is a no-op and tiers 5-7 are byte-identical to before.
  // In multi-row mode every node's live position is mapped back onto the
  // single-row strip via `toCanonicalPosition`, and the chapter strip used
  // for membership + phantom extents is rebuilt at its single-row lefts.
  const multiRow = layoutMode === 'multi' && Array.isArray(chapterRows) && chapterRows.length > 0
  let stripChapters = chaptersList
  let canonPosById = null
  if (multiRow) {
    let left = chapterXOffset
    stripChapters = chaptersList.map((c) => {
      const entry = { ...c, position: { x: left, y: singleRowTopY } }
      left += c.width || 0
      return entry
    })
    canonPosById = new Map()
    const canonOpts = { mode: 'multi', chapters: chaptersList, chapterRows, xOffset: chapterXOffset, rowsTopY, rowGap, singleRowTopY }
    for (const n of includedNodes) canonPosById.set(n.id, toCanonicalPosition(n, canonOpts))
  }
  const posOf = multiRow
    ? (n) => (n && canonPosById.get(n.id)) || (n && n.position) || {}
    : (n) => (n && n.position) || {}

  // Pre-compute chapter horizontal extents for phantom-rank assignment.
  const allLefts = stripChapters.map((c) => (c.position?.x ?? 0))
  const allRights = stripChapters.map((c) => (c.position?.x ?? 0) + (c.width ?? 0))
  const minLeft = allLefts.length ? Math.min(...allLefts) : null
  const maxRight = allRights.length ? Math.max(...allRights) : null

  // In multi-row mode membership is resolved on the node's canonical
  // single-row position against the single-row strip (x-only, the same
  // rule as today); the per-call shallow clone only carries the canonical
  // position into the existing x-only resolver. Single-row keeps the exact
  // pre-4.3 call (no clone, `chaptersList`).
  const chapterIdForNode = multiRow
    ? (n) => (n ? getChapterIdForNode({ ...n, position: posOf(n) }, stripChapters, chapterXOffset) : null)
    : (n) => (n ? getChapterIdForNode(n, chaptersList, chapterXOffset) : null)
  const chapterRankForNode = (n) => {
    const cid = chapterIdForNode(n)
    if (cid != null) {
      const idx = chapterIndexById.get(cid)
      if (idx != null) return idx
    }
    if (minLeft == null) return null
    const x = posOf(n).x ?? 0
    if (x < minLeft) return -1
    if (x >= maxRight) return numChapters
    return null
  }

  const originNodes = includedNodes.filter(isOriginNode)
  const originIdSet = new Set(originNodes.map((n) => n.id))
  markPhase('setup')

  // ── Tier 0 — origin before non-origin ──────────────────────────────────────
  for (const o of originNodes) {
    for (const n of includedNodes) {
      if (originIdSet.has(n.id)) continue
      graph.addFact(o.id, n.id, 0, { kind: 'origin' })
    }
  }
  markPhase('tier0-origins')

  // ── Tier 1 — POV chain adjacent pairs ──────────────────────────────────────
  const povIndexByNodeId = new Map()
  const povSeqIds = []
  if (povChain?.sequence) {
    let idx = 0
    for (const entry of povChain.sequence) {
      const n = nodeById.get(entry.nodeId)
      if (!n) continue
      idx += 1
      povIndexByNodeId.set(entry.nodeId, idx)
      povSeqIds.push(entry.nodeId)
    }
  }
  for (let i = 0; i < povSeqIds.length - 1; i++) {
    const sa = povSeqIds[i]
    const sb = povSeqIds[i + 1]
    graph.addFact(sa, sb, 1, { kind: 'pov', povIndex: povIndexByNodeId.get(sa) })
  }
  markPhase('tier1-pov')

  // ── Compute entity chains and orphan chips ────────────────────────────────
  const entityIds = collectEntityIds(nodes)
  const entityIdsSorted = Array.from(entityIds).sort()
  const connectedChainByEntity = new Map()
  const chainOrphansByEntity = new Map()

  for (const eid of entityIdsSorted) {
    const chain = getEntityNarrativeChain(eid, nodes, edges, chainLookupMaps)
    const chainIds = chain.map((n) => n.id).filter((id) => nodeById.has(id))
    connectedChainByEntity.set(eid, chainIds)

    const chainIdSet = new Set(chainIds)
    const all = nodesCarryingEntity(eid, nodes)
    const orphanIds = new Set()
    for (const n of all) {
      if (!chainIdSet.has(n.id) && nodeById.has(n.id)) orphanIds.add(n.id)
    }
    if (orphanIds.size > 0) chainOrphansByEntity.set(eid, orphanIds)
  }

  // ── Closure: which entity chains are placeable? ───────────────────────────
  // A chain is placeable iff it shares a scene with the placeable scene set.
  // Seed with POV scenes; expand transitively as new placeable chains drop
  // their scenes into the set.
  const placeableScenes = new Set(povSeqIds)
  const placeableEntityIds = new Set()
  let added = true
  while (added) {
    added = false
    for (const eid of entityIdsSorted) {
      if (placeableEntityIds.has(eid)) continue
      const chainIds = connectedChainByEntity.get(eid) || []
      let hasShared = false
      for (const id of chainIds) {
        if (placeableScenes.has(id)) { hasShared = true; break }
      }
      if (hasShared) {
        placeableEntityIds.add(eid)
        for (const id of chainIds) {
          const n = nodeById.get(id)
          if (n?.type === 'sceneNode') placeableScenes.add(id)
        }
        added = true
      }
    }
  }

  markPhase('entity-chains')
  // ── Tier 2 — placeable entity chains, adjacent-pair facts ─────────────────
  //
  // Phase 3.7 perf fix (large-project load perf #2): historic emission was the full
  // O(L²) transitive closure (every i<j pair within the chain). The
  // topological sort (Kahn over `graph.successors`) propagates transitively
  // anyway — adjacent pairs (A→B, B→C, C→D) are mathematically sufficient
  // to determine the chain order [A, B, C, D]. For the reference project's 172-chip
  // default-POV chain (Alice on every scene via Phase 3.7N Layer 2),
  // adjacent-pair emission drops fact count from 14,706 to 171 (~86x
  // reduction). `_reaches()` cycle detection still works correctly because
  // it walks the successor chain transitively. Final `orderedIds` and
  // `tierById` outputs identical — verified against the existing fixture
  // tests (`storyOrder.test.js`). One observable change: DevPreviewPanel
  // (`includeTierSnapshots: true` path) shows fewer pair facts at tier 2;
  // logically equivalent display.
  for (const eid of placeableEntityIds) {
    const chainIds = connectedChainByEntity.get(eid) || []
    for (let i = 0; i < chainIds.length - 1; i++) {
      graph.addFact(chainIds[i], chainIds[i + 1], 2, { kind: 'chain', entityId: eid })
    }
  }
  markPhase('tier2-chains')

  // ── Tier 3 — orphan segments ──────────────────────────────────────────────
  // For each entity:
  //   (a) if the entity's connected chain wasn't placed at tier 2, that
  //       chain itself is an orphan-entity-chain segment.
  //   (b) any chips disconnected from the entity's connected chain form
  //       additional orphan-sub-chain segments (grouped via union-find on
  //       narrative-flow edges).
  // Every i<j pair within a segment becomes a tier-3 fact. Segments that
  // share a scene (with each other or with the placed known order) fuse via
  // the constraint graph's topological combination.
  const orphanSegmentsByEntityId = new Map()
  const allSegments = []
  const segmentByNodeId = new Map()
  const segmentIndexByNodeId = new Map()

  for (const eid of entityIdsSorted) {
    const segs = []

    // (a) Whole connected chain is orphan.
    if (!placeableEntityIds.has(eid)) {
      const chainIds = connectedChainByEntity.get(eid) || []
      if (chainIds.length > 1) {
        segs.push({
          entityId: eid,
          nodeIds: chainIds,
          anchorNodeId: chainIds[0],
          kind: 'orphanEntityChain',
        })
      }
    }

    // (b) Orphan sub-chains: chips wired to each other but not to origin.
    const orphanSet = chainOrphansByEntity.get(eid)
    if (orphanSet && orphanSet.size > 0) {
      const parent = new Map()
      const find = (x) => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)))
          x = parent.get(x)
        }
        return x
      }
      for (const id of orphanSet) parent.set(id, id)
      for (const e of narrativeEdges) {
        if (orphanSet.has(e.source) && orphanSet.has(e.target)) {
          const ra = find(e.source), rb = find(e.target)
          if (ra !== rb) parent.set(ra, rb)
        }
      }
      const groups = new Map()
      for (const id of orphanSet) {
        const root = find(id)
        if (!groups.has(root)) groups.set(root, [])
        groups.get(root).push(id)
      }
      for (const [, ids] of groups) {
        const ordered = kahnSortSegment(ids, narrativeEdges, nodeById)
        segs.push({
          entityId: eid,
          nodeIds: ordered,
          anchorNodeId: ordered[0],
          kind: 'orphanSubChain',
        })
      }
    }

    if (segs.length > 0) {
      orphanSegmentsByEntityId.set(eid, segs)
      for (const s of segs) {
        allSegments.push(s)
        for (let i = 0; i < s.nodeIds.length; i++) {
          for (let j = i + 1; j < s.nodeIds.length; j++) {
            // Same redundancy skip as tiers 5-12 (provably output-
            // identical): drop pairs already ordered transitively.
            if (graph._reaches(s.nodeIds[i], s.nodeIds[j])) continue
            graph.addFact(s.nodeIds[i], s.nodeIds[j], 3, {
              kind: 'orphanSegment',
              entityId: eid,
              segmentIndex: i,
              segmentSize: s.nodeIds.length,
              segmentKind: s.kind,
            })
          }
        }
      }
    }
  }

  // Side tables for adjacency reasoning: pick the longest segment when a
  // node appears in more than one (rare; possible when an orphan sub-chain
  // overlaps with another entity's chain through a shared scene).
  for (const s of allSegments) {
    for (let i = 0; i < s.nodeIds.length; i++) {
      const id = s.nodeIds[i]
      const prev = segmentByNodeId.get(id)
      if (!prev || s.nodeIds.length > prev.nodeIds.length) {
        segmentByNodeId.set(id, s)
        segmentIndexByNodeId.set(id, i)
      }
    }
  }

  markPhase('tier3-orphans')
  // ── Tier 4 — POV reachability ─────────────────────────────────────────────
  // Connectivity in the unified POV-path-edge + entity-chain-edge graph,
  // treating edges as undirected. POV-reachable non-origins sort before
  // non-POV-reachable non-origins. Origin pairs don't see this tier (the
  // step 0 partition invariant).
  const povOriginNode = includedNodes.find((n) => n.type === 'povOriginNode')
  const povReachableSet = new Set()
  if (povOriginNode) {
    const adj = new Map()
    for (const id of nodeById.keys()) adj.set(id, new Set())
    for (const e of edges) {
      if (!isStructuralEdge(e)) continue
      if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue
      adj.get(e.source).add(e.target)
      adj.get(e.target).add(e.source)
    }
    // Defensive: stitch consecutive POV scenes in the sequence. Normally these
    // are connected via is_pov_path edges, but if the data lacks them (or the
    // sequence was synthesised), this guarantees POV chain connectivity.
    for (let i = 0; i < povSeqIds.length - 1; i++) {
      const a = povSeqIds[i], b = povSeqIds[i + 1]
      if (adj.has(a) && adj.has(b)) {
        adj.get(a).add(b)
        adj.get(b).add(a)
      }
    }
    const queue = [povOriginNode.id]
    povReachableSet.add(povOriginNode.id)
    while (queue.length > 0) {
      const x = queue.shift()
      for (const n of adj.get(x) || []) {
        if (!povReachableSet.has(n)) {
          povReachableSet.add(n)
          queue.push(n)
        }
      }
    }
  }

  const povReachableNonOrigin = []
  const nonReachableNonOrigin = []
  for (const n of includedNodes) {
    if (originIdSet.has(n.id)) continue
    if (povReachableSet.has(n.id)) povReachableNonOrigin.push(n.id)
    else nonReachableNonOrigin.push(n.id)
  }
  for (const x of povReachableNonOrigin) {
    for (const y of nonReachableNonOrigin) {
      // Same redundancy skip as tiers 5-12 (provably output-identical):
      // drop pairs an earlier tier already ordered transitively.
      if (graph._reaches(x, y) || graph._reaches(y, x)) continue
      graph.addFact(x, y, 4, { kind: 'povReachable', reachableId: x, otherId: y })
    }
  }
  markPhase('tier4-reachability')

  // ── Tiers 5-12 — pairwise tiebreakers over remaining pairs ────────────────
  for (let i = 0; i < includedNodes.length; i++) {
    const a = includedNodes[i]
    const aRank = chapterRankForNode(a)
    const aChapterId = chapterIdForNode(a)
    const aPos = posOf(a)
    const ax = aPos.x ?? 0
    const ay = aPos.y ?? 0
    for (let j = i + 1; j < includedNodes.length; j++) {
      const b = includedNodes[j]
      if (graph.has(a.id, b.id)) continue
      // Phase 4.1g perf — skip pairs an earlier tier already ordered
      // transitively (POV chain, entity chains) or an earlier iteration
      // of this loop established. The constraint graph maintains a full
      // transitive closure, so a redundant direct fact changes NEITHER
      // `orderedIds` NOR `tierById`: in Kahn's sort a node becomes ready
      // exactly when all its transitive predecessors are placed, and two
      // output-adjacent nodes always retain a real direct fact (any
      // intermediate would force a non-adjacent placement). Adding the
      // implied fact only pays a wasted O(n) closure update. For
      // the reference project's 172-scene default-POV chain this drops ~14.7k
      // redundant canvas-x facts (the dominant slice of the tiers5-12
      // phase). `_reaches` is an O(1) bit test.
      if (graph._reaches(a.id, b.id) || graph._reaches(b.id, a.id)) continue

      const bRank = chapterRankForNode(b)
      const bChapterId = chapterIdForNode(b)
      const bPos = posOf(b)
      const bx = bPos.x ?? 0
      const by = bPos.y ?? 0

      // Tier 5 — chapter index. null vs null falls through; null vs number
      // means the null one is positioned "between" (not in any phantom region)
      // — fall through to canvas-x.
      const aRk = aRank == null ? Number.POSITIVE_INFINITY : aRank
      const bRk = bRank == null ? Number.POSITIVE_INFINITY : bRank
      if (aRank != null && bRank != null && aRk !== bRk) {
        if (aRk < bRk) graph.addFact(a.id, b.id, 5, { kind: 'chapter', chapterId: aChapterId })
        else graph.addFact(b.id, a.id, 5, { kind: 'chapter', chapterId: bChapterId })
        continue
      }

      // Tier 6 — canvas x.
      if (ax !== bx) {
        if (ax < bx) graph.addFact(a.id, b.id, 6, { kind: 'canvasX', x: Math.round(ax), chapterId: aChapterId })
        else graph.addFact(b.id, a.id, 6, { kind: 'canvasX', x: Math.round(bx), chapterId: bChapterId })
        continue
      }

      // Tier 7 — canvas y.
      if (ay !== by) {
        if (ay < by) graph.addFact(a.id, b.id, 7, { kind: 'canvasY', y: Math.round(ay) })
        else graph.addFact(b.id, a.id, 7, { kind: 'canvasY', y: Math.round(by) })
        continue
      }

      // Tier 8 — node type rank.
      const ar = nodeTypeRank(a)
      const br = nodeTypeRank(b)
      if (ar !== br) {
        if (ar < br) graph.addFact(a.id, b.id, 8, { kind: 'nodeType', nodeType: a?.type || 'unknown' })
        else graph.addFact(b.id, a.id, 8, { kind: 'nodeType', nodeType: b?.type || 'unknown' })
        continue
      }

      // Tiers 9-12 — name cascade.
      const { predId, succId, payload } = nameCascadeOrdered(a, b)
      graph.addFact(predId, succId, payload.tier, payload)
    }
  }
  markPhase('tiers5-12-pairs')

  // ── Build per-tier snapshots ──────────────────────────────────────────────
  // F#2: gated behind `includeTierSnapshots` — the only consumer is the
  // `DevPreviewPanel`'s "Decision tree (per-tier resolution log)" view,
  // which calls `computeStoryOrder` directly with the flag set. Every
  // other caller (the `useStoryOrder` hook, `Canvas.handleConnectStart`,
  // `projectStore._checkContradictsStoryOrder`) takes the default and
  // skips the 13-tier sub-graph builds + Kahn + reachability + O(N²)
  // ambiguous-pair scans.
  const NUM_TIERS = 13
  const tierSnapshots = includeTierSnapshots ? [] : null
  const allIds = includeTierSnapshots ? Array.from(graph.allNodes) : null

  const entriesByTier = includeTierSnapshots ? Array.from({ length: NUM_TIERS }, () => []) : null
  if (includeTierSnapshots) {
    for (const [key, entry] of graph.pairTierMap) {
      if (entry.tier >= 0 && entry.tier < NUM_TIERS) {
        const [lo, hi] = key.split('|')
        entriesByTier[entry.tier].push({ lo, hi, predId: entry.predId, payload: entry.payload })
      }
    }
  }

  for (let T = 0; includeTierSnapshots && T < NUM_TIERS; T++) {
    const subSucc = new Map()
    const subInDeg = new Map()
    const subUndirected = new Map()
    for (const id of allIds) {
      subSucc.set(id, new Set())
      subInDeg.set(id, 0)
      subUndirected.set(id, new Set())
    }
    for (let t = 0; t <= T; t++) {
      for (const e of entriesByTier[t]) {
        const pred = e.predId
        const succ = pred === e.lo ? e.hi : e.lo
        const outs = subSucc.get(pred)
        if (!outs.has(succ)) {
          outs.add(succ)
          subInDeg.set(succ, subInDeg.get(succ) + 1)
        }
        subUndirected.get(pred).add(succ)
        subUndirected.get(succ).add(pred)
      }
    }

    const compOf = new Map()
    let compIdx = 0
    const components = []
    for (const id of allIds) {
      if (compOf.has(id)) continue
      const queue = [id]
      const members = []
      compOf.set(id, compIdx)
      while (queue.length) {
        const x = queue.shift()
        members.push(x)
        for (const n of subUndirected.get(x) || []) {
          if (!compOf.has(n)) {
            compOf.set(n, compIdx)
            queue.push(n)
          }
        }
      }
      components.push(members)
      compIdx += 1
    }

    const tierGroups = []
    for (const members of components) {
      const memberSet = new Set(members)
      const localIn = new Map()
      for (const m of members) localIn.set(m, 0)
      for (const m of members) {
        for (const s of subSucc.get(m) || []) {
          if (memberSet.has(s)) localIn.set(s, (localIn.get(s) || 0) + 1)
        }
      }
      const ready = []
      for (const m of members) if (localIn.get(m) === 0) ready.push(m)
      ready.sort()
      const ordered = []
      while (ready.length > 0) {
        const m = ready.shift()
        ordered.push(m)
        for (const s of subSucc.get(m) || []) {
          if (!memberSet.has(s)) continue
          const d = localIn.get(s) - 1
          localIn.set(s, d)
          if (d === 0) {
            let i = 0
            while (i < ready.length && ready[i] < s) i++
            ready.splice(i, 0, s)
          }
        }
      }
      if (ordered.length < members.length) {
        const placed = new Set(ordered)
        const rest = members.filter((m) => !placed.has(m)).sort()
        ordered.push(...rest)
      }

      const reach = new Map()
      for (const m of members) reach.set(m, new Set())
      for (const start of members) {
        const stack = [start]
        const seen = reach.get(start)
        while (stack.length) {
          const x = stack.pop()
          for (const s of subSucc.get(x) || []) {
            if (!memberSet.has(s) || seen.has(s)) continue
            seen.add(s)
            stack.push(s)
          }
        }
      }

      const ambiguousPairs = []
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i], b = members[j]
          const aToB = reach.get(a).has(b)
          const bToA = reach.get(b).has(a)
          if (!aToB && !bToA) ambiguousPairs.push([a, b])
        }
      }

      tierGroups.push({
        nodeIds: ordered,
        internallyResolved: ambiguousPairs.length === 0,
        ambiguousPairs,
      })
    }

    const newPairs = entriesByTier[T].map((e) => ({
      predId: e.predId,
      succId: e.predId === e.lo ? e.hi : e.lo,
      payload: e.payload,
    }))

    tierSnapshots.push({ tier: T, newPairs, groups: tierGroups })
  }

  markPhase('snapshots')
  // ── Topological sort ──────────────────────────────────────────────────────
  const orderedIds = topologicalSort(graph)
  markPhase('toposort')

  // ── Build reasonById / tierById from adjacent pair facts ─────────────────
  const reasonById = new Map()
  const tierById = new Map()
  const indexById = new Map()

  for (let i = 0; i < orderedIds.length; i++) indexById.set(orderedIds[i], i)

  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]
    let leftReason = null
    let rightReason = null
    if (i > 0) {
      const prev = orderedIds[i - 1]
      const entry = graph.get(prev, id)
      if (entry) {
        leftReason = { ...entry.payload, tier: entry.tier, neighbourId: prev }
      }
    }
    if (i < orderedIds.length - 1) {
      const next = orderedIds[i + 1]
      const entry = graph.get(id, next)
      if (entry) {
        rightReason = { ...entry.payload, tier: entry.tier, neighbourId: next }
      }
    }
    reasonById.set(id, { leftReason, rightReason })
    const decisiveTier = Math.max(leftReason?.tier ?? 0, rightReason?.tier ?? 0)
    tierById.set(id, decisiveTier)
  }

  if (PROFILE) {
    markPhase('annotate')
    const total = performance.now() - _profStart
    if (total >= 100) {
      const breakdown = phaseTimes
        .filter(([, ms]) => ms >= 1)
        .map(([label, ms]) => `${label}=${ms.toFixed(0)}ms`)
        .join(', ')
      console.warn(
        `[storyOrder] phase breakdown (total ${total.toFixed(0)}ms, nodes=${includedNodes.length}, facts=${graph.pairTierMap?.size ?? '?'}): ${breakdown}`
      )
    }
  }

  return { orderedIds, indexById, tierById, reasonById, orphanSegmentsByEntityId, tierSnapshots }
}

/**
 * Segment-internal Kahn's sort for tier-3 orphan segments. Narrative-flow
 * edges only; tiebreaker canvas-x then id.
 */
function kahnSortSegment(nodeIds, narrativeEdges, nodeById) {
  const set = new Set(nodeIds)
  const adj = new Map()
  const inDeg = new Map()
  for (const id of set) {
    adj.set(id, new Set())
    inDeg.set(id, 0)
  }
  for (const e of narrativeEdges) {
    if (!set.has(e.source) || !set.has(e.target)) continue
    const outs = adj.get(e.source)
    if (!outs.has(e.target)) {
      outs.add(e.target)
      inDeg.set(e.target, inDeg.get(e.target) + 1)
    }
  }
  const cmp = (a, b) => {
    const na = nodeById.get(a), nb = nodeById.get(b)
    const ax = na?.position?.x ?? 0, bx = nb?.position?.x ?? 0
    if (ax !== bx) return ax - bx
    return (a || '').localeCompare(b || '')
  }
  const ready = []
  for (const id of set) if (inDeg.get(id) === 0) ready.push(id)
  ready.sort(cmp)
  const ordered = []
  while (ready.length > 0) {
    const id = ready.shift()
    ordered.push(id)
    for (const next of adj.get(id) || []) {
      const d = inDeg.get(next) - 1
      inDeg.set(next, d)
      if (d === 0) {
        let i = 0
        while (i < ready.length && cmp(ready[i], next) <= 0) i++
        ready.splice(i, 0, next)
      }
    }
  }
  if (ordered.length < set.size) {
    const placed = new Set(ordered)
    const leftovers = []
    for (const id of set) if (!placed.has(id)) leftovers.push(id)
    leftovers.sort(cmp)
    ordered.push(...leftovers)
  }
  return ordered
}

/**
 * Block-time check: returns true iff a proposed narrative-flow connection
 * `source → target` would contradict a tier-1 or tier-2 ordering. Only
 * those two tiers have authoritative chain semantics and warrant blocks;
 * tiers 3-12 are inferred / tiebreaker signals.
 */
export function wouldContradictStoryOrder(storyOrder, sourceId, targetId) {
  if (!storyOrder) return false
  const ts = storyOrder.tierById.get(sourceId)
  const tt = storyOrder.tierById.get(targetId)
  if (ts == null || tt == null) return false
  if (ts > 2 || tt > 2) return false
  const is = storyOrder.indexById.get(sourceId)
  const it = storyOrder.indexById.get(targetId)
  if (is == null || it == null) return false
  return is > it
}
