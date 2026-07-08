/**
 * Concept-layer auto-layout (Phase 8.5).
 *
 * The concept / brainstorming layer is a free-form mind-map that sits OFF the
 * narrative chain. Its nodes (concept nodes + concept groups) can be created by
 * an LLM via the MCP tools, which never hand-position anything — positioning is
 * this module's job, driven by the concept wires + a dedicated spawn region so
 * the user watching the GUI sees a readable, non-overlapping arrangement.
 *
 * This module is a PURE, store-free helper (sibling to `wireTidyUtils.js`): it
 * takes the current nodes and returns positions. The caller (the MCP concept
 * tool handlers in `mcpTools.js`) owns the store writes + session-id tracking.
 *
 * Determinism is a hard rule throughout (no `Math.random`, no `Date.now`;
 * positions derive only from the existing layout + graph structure + fixed
 * constants), so the same graph + inputs always produce the same layout.
 */

import { snapPosition, SNAP_STEP, SNAP_POS_OFFSET } from './snapUtils.js'

// Smallest grid line (≡ SNAP_POS_OFFSET mod SNAP_STEP) at or past `v` — the
// column-stacking primitive the narrative reorganize uses so a stacked card's top
// lands on a dot with a gap of >= one step and < two (never a fixed pixel gap,
// which would drift off-grid because card heights aren't grid multiples).
function _ceilToGrid(v) {
  return Math.ceil((v - SNAP_POS_OFFSET) / SNAP_STEP) * SNAP_STEP + SNAP_POS_OFFSET
}

// Nominal size of a fresh concept node before it is measured, and the spacing
// used to pack the region. Kept modest so several concepts fit in the band.
const CONCEPT_W = 240
const CONCEPT_H = 130
const GAP_X = 40
const GAP_Y = 40
// Clear air between the topmost existing node and the concept band's bottom
// edge, so concepts read as a distinct cluster ABOVE the rest of the canvas.
const FLOOR_GAP = 100
// How many concepts sit in one row of the band before wrapping to a higher row
// (concepts stack UPWARD from the floor). Keeps the band from sprawling right
// past the first chapter.
const ROW_LEN = 4

// Nominal size of a fresh concept GROUP before it is measured / grown to fit.
const GROUP_W = 400
const GROUP_H = 300

// Measured → data → top-level → fallback, matching the narrative layout helpers.
function _w(n, f = CONCEPT_W) { return n?.measured?.width ?? n?.data?.width ?? n?.width ?? f }
function _h(n, f = CONCEPT_H) { return n?.measured?.height ?? n?.data?.height ?? n?.height ?? f }

// The 8 concept ports as fractional offsets within the node box (top-left
// origin): a port's absolute position is node.position + offset · size.
const CONCEPT_PORT_OFFSETS = {
  tl: [0, 0], tm: [0.5, 0], tr: [1, 0], rm: [1, 0.5],
  br: [1, 1], bm: [0.5, 1], bl: [0, 1], lm: [0, 0.5],
}
const _MIDDLE_PORTS = new Set(['tm', 'bm', 'lm', 'rm'])
// Which node edge each port exits from — this is the React Flow `Position` the
// concept edge's bezier uses, so the wire's curve (and length) depends on it.
// Mirrors PORT_DEFS in ConceptPorts.jsx: corners sit on a side, not a diagonal.
const CONCEPT_PORT_RFPOS = {
  tl: 'left', tm: 'top', tr: 'right', rm: 'right',
  br: 'right', bm: 'bottom', bl: 'left', lm: 'left',
}
const RF_CURVATURE = 0.25   // React Flow's default bezier curvature
// Near-equal WIRES (within this many px of rendered length) prefer the
// middle-to-middle pair — the clean middle wire of an edge-aligned node pair.
const PORT_TIE_TOL = 18

function _conceptPortPos(node, key) {
  const x = node?.position?.x ?? 0, y = node?.position?.y ?? 0
  const w = _w(node), h = _h(node)
  const [fx, fy] = CONCEPT_PORT_OFFSETS[key]
  return { x: x + fx * w, y: y + fy * h }
}

// React Flow's bezier control-point offset + control point for a given exit side.
function _ctrlOffset(distance) {
  return distance >= 0 ? 0.5 * distance : RF_CURVATURE * 25 * Math.sqrt(-distance)
}
function _ctrlPoint(rfPos, x1, y1, x2, y2) {
  if (rfPos === 'left') return [x1 - _ctrlOffset(x1 - x2), y1]
  if (rfPos === 'right') return [x1 + _ctrlOffset(x2 - x1), y1]
  if (rfPos === 'top') return [x1, y1 - _ctrlOffset(y1 - y2)]
  return [x1, y1 + _ctrlOffset(y2 - y1)] // bottom
}
// Approximate rendered length of the concept edge's cubic bezier between the
// source port `sk` and target port `tk`, matching how ConceptEdge renders it.
function _wireLen(x1, y1, sk, x2, y2, tk) {
  const [c0x, c0y] = _ctrlPoint(CONCEPT_PORT_RFPOS[sk], x1, y1, x2, y2)
  const [c1x, c1y] = _ctrlPoint(CONCEPT_PORT_RFPOS[tk], x2, y2, x1, y1)
  let len = 0, px = x1, py = y1
  const N = 16
  for (let i = 1; i <= N; i++) {
    const t = i / N, mt = 1 - t
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
    const x = a * x1 + b * c0x + c * c1x + d * x2
    const y = a * y1 + b * c0y + c * c1y + d * y2
    len += Math.hypot(x - px, y - py); px = x; py = y
  }
  return len
}

/**
 * Pick the two ports (one per node) that give the shortest RENDERED concept
 * wire. Concept edges are bezier curves whose shape depends on each port's exit
 * side, so this scores every 8×8 pair by its actual bezier length (not straight
 * port distance) and takes the minimum — the wire that literally draws shortest.
 * Tie-break: among wires within `PORT_TIE_TOL` of the shortest, prefer the
 * middle-to-middle pair, so two nodes aligned on an edge connect via the clean
 * MIDDLE wire of the ~equal candidates. Deterministic: the fixed port order
 * settles any remaining tie.
 */
export function shortestConceptPorts(src, tgt) {
  const keys = Object.keys(CONCEPT_PORT_OFFSETS)
  const sp = keys.map((k) => _conceptPortPos(src, k))
  const tp = keys.map((k) => _conceptPortPos(tgt, k))
  const lens = keys.map((sk, i) => keys.map((tk, j) => _wireLen(sp[i].x, sp[i].y, sk, tp[j].x, tp[j].y, tk)))
  let bestLen = Infinity
  for (let i = 0; i < keys.length; i++) for (let j = 0; j < keys.length; j++) if (lens[i][j] < bestLen) bestLen = lens[i][j]
  let best = [keys[0], keys[0]], bestScore = -1, bestTieLen = Infinity
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      if (lens[i][j] > bestLen + PORT_TIE_TOL) continue
      const score = (_MIDDLE_PORTS.has(keys[i]) && _MIDDLE_PORTS.has(keys[j])) ? 1 : 0
      if (score > bestScore || (score === bestScore && lens[i][j] < bestTieLen)) {
        bestScore = score; bestTieLen = lens[i][j]; best = [keys[i], keys[j]]
      }
    }
  }
  return best
}

/**
 * The concept region anchor: the BOTTOM-LEFT corner of the band the concept
 * nodes live in. Per the resolved design the band's FLOOR is the topmost
 * (smallest-y) existing node — concepts stack above it — and it is kept to the
 * LEFT, at the leftmost content edge (which, for a chaptered story, is the
 * pre-chapter area to the left of the first chapter).
 *
 * `excludeIds` (optional) lets the caller ignore a node it is about to place
 * (e.g. a freshly-created concept sitting at a placeholder position).
 *
 * Returns `{ leftX, floorY }`. When the canvas is empty, falls back to origin.
 */
export function computeConceptRegion(nodes = [], excludeIds = null) {
  const skip = excludeIds instanceof Set ? excludeIds : (excludeIds ? new Set(excludeIds) : null)
  let minY = Infinity
  let minX = Infinity
  for (const n of nodes) {
    if (skip && skip.has(n.id)) continue
    const x = n.position?.x ?? 0
    const y = n.position?.y ?? 0
    if (y < minY) minY = y
    if (x < minX) minX = x
  }
  if (!isFinite(minY)) minY = 0
  if (!isFinite(minX)) minX = 0
  return { leftX: minX, floorY: minY }
}

/**
 * Does the axis-aligned box at (x, y, w, h) overlap any node in `nodes`?
 * React Flow positions are top-left corners, so this is per-axis range overlap.
 */
function _overlapsAny(x, y, w, h, nodes, skip) {
  for (const n of nodes) {
    if (skip && skip.has(n.id)) continue
    const nx = n.position?.x ?? 0
    const ny = n.position?.y ?? 0
    const nw = _w(n)
    const nh = _h(n)
    if (x < nx + nw && x + w > nx && y < ny + nh && y + h > ny) return true
  }
  return false
}

/**
 * Compute the position for a NEW concept node the MCP just created, packing it
 * into the concept region. `nodes` is the full node list; `newId`, if given, is
 * excluded from the region + collision tests. `sessionConceptNodes` is accepted
 * for call-site compatibility but no longer drives placement (see below).
 *
 * The band is a grid that grows UPWARD from the floor: slot 0 sits just above
 * the floor at the left edge; slots fill rightward `ROW_LEN` at a time, then
 * wrap to a higher row. Placement walks those slots and takes the FIRST that
 * overlaps nothing on the canvas.
 *
 * Why free-slot scanning instead of a session-count index: the MCP session
 * id-sets get cleared when a session ends and are empty across sessions / in a
 * freshly-loaded project. A slot index derived from this session's concepts
 * would restart at 0 and could land on a concept a prior session left in the
 * band. Scanning for the first free slot (checked against EVERY node) is stable
 * regardless of session state and reuses slots freed when concepts are filed
 * into a group. The floor excludes concept-layer nodes (concepts + groups) so
 * the band stays anchored to the narrative content rather than drifting upward
 * as more concepts / groups are added. Deterministic: same canvas → same slot.
 */
export function placeMcpConceptNode(nodes = [], sessionConceptNodes = [], newId = null, { regionOverride = null, bandMaxWidth = null } = {}) { // eslint-disable-line no-unused-vars
  // Floor anchored to NARRATIVE content: exclude every concept-layer node
  // (concepts + groups) + the new node so adding concepts/groups doesn't push
  // the band upward. `regionOverride` ({ leftX, floorY }) lets a caller place the
  // node into a SPECIFIC chapter's band (above that chapter's scenes) instead of
  // the default off-to-the-side region. `bandMaxWidth` caps how wide the band may
  // grow before wrapping to a higher row — pass a chapter's scene span so concepts
  // wrap UP within the chapter instead of spilling RIGHT into the next chapter.
  const conceptLayer = new Set(
    nodes
      .filter((n) =>
        n.id === newId ||
        n.type === 'genericGroupNode' ||
        (n.type === 'referenceNode' && n.data?.sub_type === 'concept'),
      )
      .map((n) => n.id),
  )
  const { leftX, floorY } = regionOverride || computeConceptRegion(nodes, conceptLayer)
  const bandBottom = floorY - FLOOR_GAP
  // How many columns fit in the band before wrapping up. Confined to `bandMaxWidth`
  // when given (n columns span n·CONCEPT_W + (n−1)·GAP_X), else the default ROW_LEN.
  const rowLen = (bandMaxWidth != null && bandMaxWidth > 0)
    ? Math.max(1, Math.floor((bandMaxWidth + GAP_X) / (CONCEPT_W + GAP_X)))
    : ROW_LEN

  // Collision test runs against EVERY node except the new one, so a fresh
  // concept never lands on an existing concept / group / narrative node.
  const collideSkip = newId ? new Set([newId]) : null
  const MAX_SLOTS = 400
  for (let i = 0; i < MAX_SLOTS; i++) {
    const col = i % rowLen
    const row = Math.floor(i / rowLen)
    const slotX = leftX + col * (CONCEPT_W + GAP_X)
    const slotY = bandBottom - CONCEPT_H - row * (CONCEPT_H + GAP_Y)
    if (!_overlapsAny(slotX, slotY, CONCEPT_W, CONCEPT_H, nodes, collideSkip)) {
      return { x: Math.round(slotX), y: Math.round(slotY) }
    }
  }
  // Fallback (band impossibly full): park at the left edge above the band.
  return { x: Math.round(leftX), y: Math.round(bandBottom - CONCEPT_H - MAX_SLOTS * (CONCEPT_H + GAP_Y) / ROW_LEN) }
}

/**
 * Compute the position for a NEW concept GROUP the MCP just created. Groups are
 * containers (much larger than a concept node) so they get their own placement
 * rule rather than a band slot: sit just above the region floor, to the RIGHT of
 * every concept-layer node this session already placed, so a fresh empty group
 * never lands on top of the concept band. If the session has placed nothing yet,
 * the group sits at the left content edge.
 *
 * `sessionNodeIds` is the set of ALL concept-layer node ids this session created
 * (concepts + groups) — excluded from the floor computation so the floor stays
 * anchored to the underlying non-session content, and used to find the rightmost
 * already-placed session node. `newId`, if given, is excluded from both.
 *
 * Deterministic: position derives only from the existing layout + fixed spacing.
 */
export function placeMcpGroupNode(nodes = [], sessionNodeIds = null, newId = null, { height = GROUP_H, regionOverride = null } = {}) { // eslint-disable-line no-unused-vars
  // Overlap avoidance must consider EVERY existing group on the canvas, not
  // just this MCP session's. The `sessionNodeIds` id-sets get cleared when a
  // session ends (and are empty across sessions or in a freshly-loaded
  // project). A group placed relative only to session groups would then land
  // in an already-occupied column and overlap an existing group — and because
  // group membership is geometric, nodes in the overlap get filed under BOTH.
  // So place each new group to the RIGHT of every existing group, tops aligned,
  // forming a neat row that never overlaps however tall any group grows.
  const existingGroups = nodes.filter((n) => n.type === 'genericGroupNode' && n.id !== newId)

  // Chapter placement: anchor above that chapter's scenes at its left edge,
  // then shift RIGHT past any group already sitting in that band row so two
  // chapter groups never stack. Membership stays in the chapter (x-range).
  if (regionOverride) {
    const topY = Math.round(regionOverride.floorY - FLOOR_GAP - height)
    let x = Math.round(regionOverride.leftX)
    let moved = true, guard = 0
    while (moved && guard++ < 300) {
      moved = false
      for (const g of existingGroups) {
        const gx = g.position?.x ?? 0, gy = g.position?.y ?? 0, gw = _w(g, GROUP_W), gh = _h(g, GROUP_H)
        if (x < gx + gw && x + GROUP_W > gx && topY < gy + gh && topY + height > gy) {
          x = Math.round(gx + gw + GAP_X); moved = true
        }
      }
    }
    return { x, y: topY }
  }

  // Off-chapter: keep the box entirely ABOVE all non-group content (concepts +
  // narrative) so it can NEVER enclose a pre-existing node it wasn't meant to —
  // its BOTTOM sits just above that content's top edge, and everything else is at
  // or below that edge, so nothing (however wide the box) falls inside it. Groups
  // are excluded from the floor so the anchor stays stable — groups spread RIGHT in
  // a row rather than each new one rising above the last. First group at the left
  // content edge; each subsequent group to the right of every existing group.
  const floorExclude = new Set(nodes.filter((n) => n.type === 'genericGroupNode').map((n) => n.id))
  if (newId) floorExclude.add(newId)
  const { leftX, floorY } = computeConceptRegion(nodes, floorExclude)
  const boxTopY = Math.round(floorY - FLOOR_GAP - height)
  if (existingGroups.length === 0) {
    return { x: Math.round(leftX), y: boxTopY }
  }
  let rightmost = -Infinity
  for (const g of existingGroups) {
    const right = (g.position?.x ?? 0) + _w(g, GROUP_W)
    if (right > rightmost) rightmost = right
  }
  return { x: Math.round(rightmost + GAP_X), y: boxTopY }
}

// ── Relational concept tidy layout (Phase 8.5 item 459) ─────────────────────
// The INTELLIGENT, wire-driven layout the place-on-create packing lacks. It uses
// the deterministic 3-stage pipeline the layout research recommended, because a
// single force pass tangles on mixed topologies:
//
//   1. SEED   — a deterministic radial-BFS starting layout (no Math.random).
//   2. STRESS — stress majorization (SMACOF): position nodes so on-screen
//               distances match graph-theoretic (shortest-path) distances. This
//               is a GLOBAL objective, so a hub lands central (short paths to
//               all), a chain reads as a line, and two clusters joined by a
//               bridge separate (long cross-paths) — far fewer crossings than a
//               local spring/repulsion model, and it decreases monotonically.
//   3. SEPARATE — a guaranteed overlap-removal sweep: push any two boxes that
//               still overlap apart along their least-penetration axis until
//               none intersect. Nodes are large rectangles, which force / stress
//               models (points) never clear on their own.
//
// Everything is deterministic (no Math.random, no Date.now) so the same graph +
// inputs always produce the same layout. Isolation is by construction: only ids
// in the movable set are ever repositioned; user-placed bodies are fixed anchors
// that still shape the layout (a wired session node is drawn to its ideal
// distance from them) but never move.

const IDEAL_LEN = 360        // on-screen centre distance for graph-ADJACENT nodes (1 hop)
const CLUSTER_GAP = 120      // gap between separate components packed in the band
const CHAPTER_GAP = 160      // clear gap kept between the concept map's right edge and the first chapter
const SMACOF_ITERS = 220     // stress-majorization iterations (deterministic, monotone)
const SEP_PAD = 34           // min clear gap the overlap-removal sweep enforces between boxes
const SEP_ITERS = 300        // overlap-removal sweep cap (converges well before this)
const OFF_EDGE_ITERS = 10    // node-off-edge declutter sweep cap
const OFF_EDGE_MARGIN = 14   // clearance a node keeps from any wire it isn't an endpoint of

function _isConceptNodeBody(n) { return n?.type === 'referenceNode' && n?.data?.sub_type === 'concept' }
function _isConceptGroupBody(n) { return n?.type === 'genericGroupNode' && n?.data?.concept_group === true }
function _isConceptBody(n) { return _isConceptNodeBody(n) || _isConceptGroupBody(n) }
function _isConceptEdge(e) { return e?.type === 'conceptEdge' || e?.data?.kind === 'concept' }

/** Build the closed-world concept graph: bodies (concept nodes + concept groups)
 *  and undirected adjacency over concept wires whose BOTH endpoints are bodies. */
export function buildConceptGraph(nodes = [], edges = []) {
  const bodyById = new Map()
  for (const n of nodes) if (_isConceptBody(n)) bodyById.set(n.id, n)
  const adj = new Map()
  for (const id of bodyById.keys()) adj.set(id, new Set())
  for (const e of edges) {
    if (!_isConceptEdge(e)) continue
    if (e.source !== e.target && bodyById.has(e.source) && bodyById.has(e.target)) {
      adj.get(e.source).add(e.target)
      adj.get(e.target).add(e.source)
    }
  }
  return { bodyById, adj }
}

/** A concept group's AUTHORITATIVE box size. A group that just grew has its true
 *  size in `data.*`, but React Flow's `measured.*` can lag a frame, so take the
 *  MAX — otherwise overlap-removal (and containment) clears / tests the pre-grown
 *  box and groups end up touching or a member reads as outside. */
function _groupSize(node) {
  const w = Math.max(node?.measured?.width ?? 0, node?.data?.width ?? 0, node?.width ?? 0) || GROUP_W
  const h = Math.max(node?.measured?.height ?? 0, node?.data?.height ?? 0, node?.height ?? 0) || GROUP_H
  return { w, h }
}

/** Pure geometric containment (mirrors `groupMembership.isNodeInGroup` but
 *  store-free, using THIS module's own size resolver so the layout stays a pure
 *  helper): is `node`'s box fully inside `group`'s box? Inclusive on all edges. */
function _isInsideGroup(node, group) {
  const nx = node?.position?.x ?? 0, ny = node?.position?.y ?? 0
  const nw = _w(node), nh = _h(node)
  const gx = group?.position?.x ?? 0, gy = group?.position?.y ?? 0
  const { w: gw, h: gh } = _groupSize(group)
  return nx >= gx && ny >= gy && nx + nw <= gx + gw && ny + nh <= gy + gh
}

/**
 * Build the COMPOUND concept graph: a concept-mode group is a cohesive
 * super-body that swallows its member concepts. Bodies = concept-mode groups +
 * concepts NOT inside any concept group. Adjacency contracts every concept wire
 * to its endpoints' REPRESENTATIVE body (a member concept -> its group), so a
 * member's external wire (and the group's own wires, once groups are wireable)
 * pull the GROUP; wires internal to one group, self-loops, and wires to
 * non-body endpoints are dropped.
 *
 * Overlapping groups can't double-claim a member: each node is assigned to the
 * SMALLEST-area group that fully contains it (deterministic tie-break by group
 * id). Returns `{ bodyById, adj, groupOfMember, membersByGroup, containedByGroup,
 * nodeById }`: `membersByGroup` (groupId -> id-sorted [conceptId]) is the CONCEPT
 * members used for adjacency; `containedByGroup` (groupId -> id-sorted [any
 * non-group node id]) is EVERY contained node (concepts AND entities / others) so
 * the caller can translate the whole interior rigidly with the group.
 */
function _buildCompoundConceptGraph(nodes = [], edges = []) {
  const nodeById = new Map()
  for (const n of nodes) nodeById.set(n.id, n)
  const groups = nodes.filter(_isConceptGroupBody)

  // Smallest-area concept group that fully contains `node` (deterministic tie by
  // id); null when it sits in no concept group.
  const smallestContaining = (node) => {
    let best = null, bestArea = Infinity
    for (const g of groups) {
      if (node.id === g.id || !_isInsideGroup(node, g)) continue
      const gs = _groupSize(g); const area = gs.w * gs.h
      if (area < bestArea || (area === bestArea && (best === null || g.id < best.id))) { bestArea = area; best = g }
    }
    return best
  }

  const groupOfMember = new Map()      // conceptId -> groupId (adjacency contraction)
  const membersByGroup = new Map()     // groupId -> [conceptId] (concepts, for adjacency)
  const containedByGroup = new Map()   // groupId -> [any non-group node id] (rigid translation)
  for (const g of groups) { membersByGroup.set(g.id, []); containedByGroup.set(g.id, []) }
  for (const n of nodes) {
    if (_isConceptGroupBody(n)) continue                 // a group is never a member of a group
    const g = smallestContaining(n)
    if (!g) continue
    containedByGroup.get(g.id).push(n.id)                // EVERY contained node rides with the group
    if (_isConceptNodeBody(n)) {                         // only concepts contract into the wire graph
      groupOfMember.set(n.id, g.id)
      membersByGroup.get(g.id).push(n.id)
    }
  }
  for (const arr of membersByGroup.values()) arr.sort()
  for (const arr of containedByGroup.values()) arr.sort()

  const bodyById = new Map()
  for (const g of groups) bodyById.set(g.id, g)
  for (const n of nodes) if (_isConceptNodeBody(n) && !groupOfMember.has(n.id)) bodyById.set(n.id, n)

  const repOf = (id) => groupOfMember.get(id) || id
  const adj = new Map()
  for (const id of bodyById.keys()) adj.set(id, new Set())
  for (const e of edges) {
    if (!_isConceptEdge(e)) continue
    if (e.source === e.target) continue
    const rs = repOf(e.source), rt = repOf(e.target)
    if (rs === rt) continue                          // internal to one group / self
    if (!bodyById.has(rs) || !bodyById.has(rt)) continue
    adj.get(rs).add(rt); adj.get(rt).add(rs)
  }
  return { bodyById, adj, groupOfMember, membersByGroup, containedByGroup, nodeById }
}

/** Connected components via union-find, fully deterministic: edges + members are
 *  processed in id-sorted order and each component is keyed by its min id, so the
 *  result is independent of the input node/edge array order. */
function _components(bodyById, adj) {
  const parent = new Map()
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx }
    return r
  }
  for (const id of bodyById.keys()) parent.set(id, id)
  const ids = [...bodyById.keys()].sort()
  for (const a of ids) {
    for (const b of [...adj.get(a)].sort()) {
      const ra = find(a), rb = find(b)
      if (ra !== rb) { if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb) }
    }
  }
  const groups = new Map()
  for (const id of ids) {
    const r = find(id)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(id)
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([root, members]) => ({ root, ids: members.sort() }))
}

function _sizeOf(node) { return _isConceptGroupBody(node) ? _groupSize(node) : { w: _w(node), h: _h(node) } }
function _degIn(id, adj, idSet) { let d = 0; for (const nb of adj.get(id)) if (idSet.has(nb)) d++; return d }
function _edgeKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}` }

/** All-pairs shortest-path HOP distances within one component (BFS from each
 *  node). Returns a Map keyed by `_edgeKey(i,j)` -> hop count. Within a connected
 *  component every pair is reachable, so every pair gets a finite distance. */
function _allPairsShortest(ids, adj) {
  const idSet = new Set(ids)
  const dist = new Map()
  for (const s of ids) {
    const d = new Map([[s, 0]])
    const queue = [s]
    while (queue.length) {
      const u = queue.shift()
      for (const v of adj.get(u)) {
        if (!idSet.has(v) || d.has(v)) continue
        d.set(v, d.get(u) + 1); queue.push(v)
      }
    }
    for (const [t, h] of d) if (s < t) dist.set(_edgeKey(s, t), h)
  }
  return dist
}

/** Deterministic radial-BFS seed (STAGE 1): root at origin, each BFS depth on a
 *  ring, members spread around the ring in id order with a per-ring phase so
 *  deeper rings don't hide behind shallower ones. Just a good starting point;
 *  stress majorization does the real structural work. */
function _seedRadial(ids, adj, root) {
  const idSet = new Set(ids)
  const level = new Map([[root, 0]])
  const queue = [root]
  while (queue.length) {
    const u = queue.shift()
    for (const v of [...adj.get(u)].filter((x) => idSet.has(x)).sort()) {
      if (!level.has(v)) { level.set(v, level.get(u) + 1); queue.push(v) }
    }
  }
  const byLevel = new Map()
  for (const id of ids) { const L = level.get(id) ?? 1; if (!byLevel.has(L)) byLevel.set(L, []); byLevel.get(L).push(id) }
  const centres = new Map()
  for (const [L, members] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    members.sort()
    if (L === 0) { centres.set(members[0], { x: 0, y: 0 }); continue }
    const R = L * IDEAL_LEN
    members.forEach((id, i) => {
      const theta = -Math.PI / 2 + (i * 2 * Math.PI) / members.length + L * 0.7
      centres.set(id, { x: R * Math.cos(theta), y: R * Math.sin(theta) })
    })
  }
  return centres
}

/** Stress majorization (STAGE 2). Mutate `bodies` (Map id -> {x,y (CENTRE), w, h,
 *  movable}) so pairwise on-screen distances approach `ideal` (Map _edgeKey ->
 *  target distance). Guttman transform with weights 1/ideal², applied Jacobi-style
 *  (all new positions computed from ONE snapshot then written) so the result is
 *  independent of iteration order. Fixed anchors contribute to others' targets
 *  but never move. Monotonically decreases stress; deterministic. */
function _stressMajorize(bodies, ideal, iters = SMACOF_ITERS) {
  const ids = [...bodies.keys()].sort()
  for (let t = 0; t < iters; t++) {
    const next = new Map()
    for (const i of ids) {
      const bi = bodies.get(i)
      if (!bi.movable) { next.set(i, { x: bi.x, y: bi.y }); continue }
      let sx = 0, sy = 0, sw = 0
      for (const j of ids) {
        if (j === i) continue
        const dGoal = ideal.get(_edgeKey(i, j))
        if (!dGoal) continue
        const w = 1 / (dGoal * dGoal)
        const bj = bodies.get(j)
        const dx = bi.x - bj.x, dy = bi.y - bj.y
        const dist = Math.hypot(dx, dy) || 1e-6
        sx += w * (bj.x + (dGoal * dx) / dist)
        sy += w * (bj.y + (dGoal * dy) / dist)
        sw += w
      }
      next.set(i, sw > 0 ? { x: sx / sw, y: sy / sw } : { x: bi.x, y: bi.y })
    }
    for (const i of ids) { const b = bodies.get(i), n = next.get(i); b.x = n.x; b.y = n.y }
  }
}

/** Guaranteed overlap removal (STAGE 3). Repeatedly find any two boxes that
 *  overlap (with `pad` clearance) and push them apart along their least-
 *  penetration axis until none intersect. Movable-only; a fixed anchor absorbs
 *  none of the push (its partner moves the full amount). Deterministic (sorted
 *  order); converges well before the iteration cap for the small graphs here. */
function _separateOverlaps(bodies, { pad = SEP_PAD, iters = SEP_ITERS } = {}) {
  const ids = [...bodies.keys()].sort()
  for (let t = 0; t < iters; t++) {
    let any = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = bodies.get(ids[i]), B = bodies.get(ids[j])
        if (!A.movable && !B.movable) continue
        const dx = B.x - A.x, dy = B.y - A.y
        const ox = (A.w + B.w) / 2 + pad - Math.abs(dx)
        const oy = (A.h + B.h) / 2 + pad - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        any = true
        let px = 0, py = 0
        if (ox < oy) px = (dx >= 0 ? 1 : -1) * ox
        else py = (dy >= 0 ? 1 : -1) * oy
        if (A.movable && B.movable) { A.x -= px / 2; A.y -= py / 2; B.x += px / 2; B.y += py / 2 }
        else if (B.movable) { B.x += px; B.y += py }
        else { A.x -= px; A.y -= py }
      }
    }
    if (!any) break
  }
}

/** Node-off-edge declutter (STAGE 2.5). Push any body that sits ON a wire it is
 *  NOT an endpoint of off to the side, so an unrelated wire stops cutting across a
 *  card (the "wire runs through Betrayal" problem). Each `segment` carries its two
 *  endpoints as `{ id, offx, offy }` — the live point is `bodies.get(id) centre +
 *  (offx, offy)`, so a wire that meets a MEMBER inside a group uses the member's
 *  true position (group body centre + its fixed interior offset), not the group
 *  centre. `segment.exclude` is the set of body ids that must not be shoved (the
 *  endpoints, plus a member endpoint's own group). For each OTHER movable body
 *  whose centre projects onto the segment (not past its ends) and lies within
 *  `clearance`, shove it perpendicular until it clears. Deterministic (sorted ids,
 *  fixed segment order, fixed perpendicular side). */
function _pushNodesOffEdges(bodies, segments, { iters = OFF_EDGE_ITERS, margin = OFF_EDGE_MARGIN } = {}) {
  if (!segments.length) return
  const ids = [...bodies.keys()].sort()
  for (let t = 0; t < iters; t++) {
    let moved = false
    for (const seg of segments) {
      const A = bodies.get(seg.a.id), B = bodies.get(seg.b.id)
      if (!A || !B) continue
      const ax = A.x + seg.a.offx, ay = A.y + seg.a.offy
      const bx = B.x + seg.b.offx, by = B.y + seg.b.offy
      const abx = bx - ax, aby = by - ay
      const abLen2 = abx * abx + aby * aby || 1e-6
      for (const k of ids) {
        if (seg.exclude.has(k)) continue
        const K = bodies.get(k)
        if (!K.movable) continue
        const s = ((K.x - ax) * abx + (K.y - ay) * aby) / abLen2
        if (s <= 0.05 || s >= 0.95) continue         // near/past an endpoint — skip
        const projx = ax + s * abx, projy = ay + s * aby
        let dx = K.x - projx, dy = K.y - projy
        let d = Math.hypot(dx, dy)
        // clearance so the node clears the wire, using the SMALLER half-extent so
        // a wide card isn't shoved a full half-width off every near-horizontal wire.
        const clearance = Math.min(K.w, K.h) / 2 + margin
        if (d >= clearance) continue
        if (d < 1e-6) { dx = -aby; dy = abx; d = Math.hypot(dx, dy) || 1e-6 }  // exactly on the line
        const push = clearance - d
        K.x += (dx / d) * push; K.y += (dy / d) * push
        moved = true
      }
    }
    if (!moved) break
  }
}

/** Bounding box (top-left + size) of a set of centre-bodies. */
function _bboxOf(bodyIds, bodies) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const id of bodyIds) {
    const b = bodies.get(id)
    minX = Math.min(minX, b.x - b.w / 2); minY = Math.min(minY, b.y - b.h / 2)
    maxX = Math.max(maxX, b.x + b.w / 2); maxY = Math.max(maxY, b.y + b.h / 2)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Compute an intelligent, wire-driven layout for the concept layer. Pure and
 * store-free. For each connected component it runs the pipeline (radial seed →
 * stress majorization → overlap removal), then packs disconnected components
 * into the concept band. Returns `{ positions: Map<id,{x,y}> }` (TOP-LEFT
 * positions, movable ids only) — the caller writes them.
 *
 * Options:
 *   - `movableConceptIds` / `movableGroupIds` — the only ids that may move
 *     (the MCP session's own nodes). Everything else is a fixed anchor.
 *   - `warmStart` (default false) — seed from the CURRENT positions (a gentle
 *     incremental settle) instead of a fresh radial seed.
 *   - `iterations` — stress-majorization iteration count.
 *   - `snapToGrid` — snap final positions to the grid.
 */
export function computeConceptTidyLayout(nodes = [], edges = [], {
  movableConceptIds = new Set(),
  movableGroupIds = new Set(),
  warmStart = false,
  iterations = SMACOF_ITERS,
  snapToGrid = false,
  chapterLeftEdge = Infinity,
  // Reorganize's per-partition pass overrides where the band anchors and how wide
  // it may grow before wrapping, so a chapter's concepts tidy into a band ABOVE
  // that chapter's scenes, confined to the chapter's x-span. `regionOverride` is
  // `{ leftX, floorY }` (band bottom-left; concepts stack UP from the floor);
  // `bandMaxWidth` caps the shelf-wrap width. Both null = the standard behaviour
  // (region derived from the narrative content, default wrap width).
  regionOverride = null,
  bandMaxWidth = null,
} = {}) {
  const movable = new Set([...movableConceptIds, ...movableGroupIds])
  // Compound graph: concept-mode groups are cohesive super-bodies that swallow
  // their member concepts (contracted out of the flat body set). See
  // `_buildCompoundConceptGraph`.
  const { bodyById, adj, groupOfMember, membersByGroup, containedByGroup, nodeById } = _buildCompoundConceptGraph(nodes, edges)
  const positions = new Map()
  if (bodyById.size === 0) return { positions }

  // Effective body movability: a concept moves iff it's in the movable set; a
  // GROUP moves iff it's movable AND every member is movable, so the layout
  // never drags a fixed (user-placed) member to keep the box coherent — such a
  // group is a fixed anchor that still shapes the rest.
  const bodyMovable = (id) => {
    if (!movable.has(id)) return false
    const members = membersByGroup.get(id)
    return !(members && members.some((m) => !movable.has(m)))
  }

  const comps = _components(bodyById, adj)
  // The band floor must ignore EVERY node positioned as part of the concept map
  // — concepts, concept groups, AND anything contained in a concept group (entity
  // origins etc.) — otherwise a prior tidy's placements read as "floor" and the
  // band ratchets upward on each successive tidy. Only true narrative content
  // (scenes, POV, ungrouped entities) anchors the floor.
  const regionExclude = new Set(nodes.filter(_isConceptBody).map((n) => n.id))
  for (const ids of containedByGroup.values()) for (const id of ids) regionExclude.add(id)
  const region = regionOverride || computeConceptRegion(nodes, regionExclude)
  // Free (no-anchor) components get packed into the band on shelves stacking up
  // from the floor; anchored / warm components keep their world positions.
  let shelfX = region.leftX
  let shelfTopY = region.floorY - FLOOR_GAP        // bottom edge of the current shelf row
  let shelfRowMaxH = 0
  const SHELF_MAX_W = bandMaxWidth != null ? bandMaxWidth : (CONCEPT_W + GAP_X) * ROW_LEN * 2

  const writeMovable = (ids, bodies) => {
    for (const id of ids) if (bodyMovable(id)) {
      const b = bodies.get(id)
      positions.set(id, { x: Math.round(b.x - b.w / 2), y: Math.round(b.y - b.h / 2) })
    }
  }

  const freeComps = []
  for (const comp of comps) {
    const ids = comp.ids
    const idSet = new Set(ids)
    const hasAnchor = ids.some((id) => !bodyMovable(id))
    const bodies = new Map()
    for (const id of ids) {
      const node = bodyById.get(id)
      const { w, h } = _sizeOf(node)
      bodies.set(id, { x: (node.position?.x ?? 0) + w / 2, y: (node.position?.y ?? 0) + h / 2, w, h, movable: bodyMovable(id) })
    }
    // Ideal target distances = IDEAL_LEN × shortest-path hops.
    const ideal = new Map()
    if (ids.length > 1) for (const [k, hopN] of _allPairsShortest(ids, adj)) ideal.set(k, IDEAL_LEN * hopN)

    // Wire segments within this component for the node-off-edge pass, using the
    // TRUE endpoints: an endpoint inside a group resolves to that group's body +
    // the member's fixed interior offset, so a member-external wire (e.g.
    // Trust→Redemption) pushes intervening cards off its REAL line, not the
    // contracted group-centre line.
    const resolveEnd = (nodeId) => {
      if (idSet.has(nodeId)) return { id: nodeId, offx: 0, offy: 0 }
      const g = groupOfMember.get(nodeId)
      if (!g || !idSet.has(g)) return null
      const gN = nodeById.get(g), mN = nodeById.get(nodeId)
      const gs = _sizeOf(gN), ms = _sizeOf(mN)
      return {
        id: g,
        offx: (mN.position?.x ?? 0) + ms.w / 2 - ((gN.position?.x ?? 0) + gs.w / 2),
        offy: (mN.position?.y ?? 0) + ms.h / 2 - ((gN.position?.y ?? 0) + gs.h / 2),
      }
    }
    const segments = []
    for (const e of edges) {
      if (!_isConceptEdge(e) || e.source === e.target) continue
      const a = resolveEnd(e.source), b = resolveEnd(e.target)
      if (!a || !b || a.id === b.id) continue    // unresolved, or internal to one group
      segments.push({ a, b, exclude: new Set([a.id, b.id]) })
    }

    // STRESS → node-off-edge declutter → overlap removal. The declutter nudges
    // any card off a wire it isn't part of; the final separate cleans up any
    // overlap the nudge introduced.
    const stressAndSeparate = () => {
      _stressMajorize(bodies, ideal, iterations)
      _pushNodesOffEdges(bodies, segments)
      _separateOverlaps(bodies)
    }

    if (ids.length === 1) {
      // Unwired singleton: fresh-free ones get packed into the band below; a warm
      // or anchored singleton just stays where it is.
      if (!warmStart && !hasAnchor) freeComps.push({ ids, bodies })
      else writeMovable(ids, bodies)
      continue
    }

    if (!warmStart && !hasAnchor) {
      // Fresh, free component: radial seed (local frame) → stress → separate → pack.
      const root = ids.slice().sort((a, b) => (_degIn(b, adj, idSet) - _degIn(a, adj, idSet)) || (a < b ? -1 : 1))[0]
      const seed = _seedRadial(ids, adj, root)
      for (const id of ids) { const b = bodies.get(id), c = seed.get(id); b.x = c.x; b.y = c.y }
      stressAndSeparate()
      freeComps.push({ ids, bodies })
      continue
    }

    if (!warmStart && hasAnchor) {
      // Fresh, but pinned to a user node: seed movers around the anchor centroid
      // (world frame), keep anchors put, stress + separate in place.
      const anchors = ids.filter((id) => !bodyMovable(id))
      let ax = 0, ay = 0
      for (const id of anchors) { const b = bodies.get(id); ax += b.x; ay += b.y }
      ax /= anchors.length; ay /= anchors.length
      const movers = ids.filter((id) => bodyMovable(id)).sort()
      movers.forEach((id, i) => {
        const theta = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(movers.length, 1)
        const b = bodies.get(id); b.x = ax + IDEAL_LEN * Math.cos(theta); b.y = ay + IDEAL_LEN * Math.sin(theta)
      })
      stressAndSeparate()
    } else {
      // Warm start: stress from the current positions (gentle incremental settle).
      stressAndSeparate()
    }
    writeMovable(ids, bodies)
  }

  // Pack the free components into the band, left-to-right then up, no overlap.
  // Bigger components first so the shelf rows stay tight.
  freeComps.sort((a, b) => (b.ids.length - a.ids.length) || (a.ids[0] < b.ids[0] ? -1 : 1))
  for (const comp of freeComps) {
    const bbox = _bboxOf(comp.ids, comp.bodies)
    if (shelfX > region.leftX && shelfX + bbox.w > region.leftX + SHELF_MAX_W) {
      shelfX = region.leftX
      shelfTopY -= shelfRowMaxH + CLUSTER_GAP
      shelfRowMaxH = 0
    }
    const dx = shelfX - bbox.x
    const dy = (shelfTopY - bbox.h) - bbox.y
    for (const id of comp.ids) if (comp.bodies.get(id).movable) {
      const b = comp.bodies.get(id)
      positions.set(id, { x: Math.round(b.x + dx - b.w / 2), y: Math.round(b.y + dy - b.h / 2) })
    }
    shelfRowMaxH = Math.max(shelfRowMaxH, bbox.h)
    shelfX += bbox.w + CLUSTER_GAP
  }

  // Group-aware finish: a concept group is a cohesive body, so EVERYTHING inside
  // it — member concepts AND non-concept members (entity origins etc.) — rides
  // RIGIDLY with it. For every group that MOVED, translate each contained node by
  // the group's top-left delta, preserving the interior arrangement (grow-to-fit
  // already sized the box) so containment holds. No movable gate: a contained
  // node must follow its group to stay inside (the group only moves when it is
  // itself movable). Runs before the snap so interior + group land on-grid.
  for (const [gid, containedIds] of containedByGroup) {
    if (containedIds.length === 0) continue
    const gpos = positions.get(gid)
    if (!gpos) continue                              // group didn't move (anchored / unmoved)
    const gNode = nodeById.get(gid)
    const dx = gpos.x - (gNode.position?.x ?? 0)
    const dy = gpos.y - (gNode.position?.y ?? 0)
    if (dx === 0 && dy === 0) continue
    for (const cid of containedIds) {
      const cNode = nodeById.get(cid)
      positions.set(cid, { x: Math.round((cNode.position?.x ?? 0) + dx), y: Math.round((cNode.position?.y ?? 0) + dy) })
    }
  }

  // Keep the whole concept map LEFT of the first chapter's left edge. Chapters
  // extend RIGHT from `chapterLeftEdge` in BOTH single-row and multi-row layouts,
  // so if any concept / group / member drifted past it (the wire-driven stress can
  // spread clusters wide), shift EVERY position left by just enough to bring the
  // rightmost edge back to `chapterLeftEdge - CHAPTER_GAP`. The pre-chapter zone is
  // unbounded leftward, so this parks the map clear of the chapter columns without
  // squeezing it. Runs before the snap so the shifted map still lands on the grid.
  if (Number.isFinite(chapterLeftEdge) && positions.size) {
    let maxRight = -Infinity
    for (const [id, p] of positions) {
      const node = nodeById.get(id)
      const w = node ? _sizeOf(node).w : CONCEPT_W
      if (p.x + w > maxRight) maxRight = p.x + w
    }
    const limit = chapterLeftEdge - CHAPTER_GAP
    if (maxRight > limit) {
      const shift = maxRight - limit
      for (const [id, p] of positions) positions.set(id, { x: p.x - shift, y: p.y })
    }
  }

  // Snap finish: land every moved node on the grid when the user has snap on.
  // Non-member bodies snap per-node. Group MEMBERS are RE-STACKED per column
  // (mirrors the narrative reorganize snap pass): each member's top lands on a
  // grid line via `_ceilToGrid(prevBottom + SNAP_STEP)`, so the vertical margin is
  // HEIGHT-DEPENDENT — always >= one grid step and < two — rather than a fixed
  // pixel gap, which would drift the tops off the dots because card heights aren't
  // grid multiples.
  if (snapToGrid) {
    const memberOf = new Map()
    for (const [gid, ids] of containedByGroup) for (const id of ids) memberOf.set(id, gid)
    for (const [id, p] of positions) {
      if (!memberOf.has(id)) positions.set(id, { x: snapPosition(p.x), y: snapPosition(p.y) })
    }
    for (const ids of containedByGroup.values()) {
      const moved = ids.filter((id) => positions.has(id))
      if (!moved.length) continue
      const cols = new Map()                              // snapped column x -> member ids
      for (const id of moved) {
        const sx = snapPosition(positions.get(id).x)
        if (!cols.has(sx)) cols.set(sx, [])
        cols.get(sx).push(id)
      }
      for (const [sx, colIds] of cols) {
        colIds.sort((a, b) => positions.get(a).y - positions.get(b).y)
        let top = snapPosition(positions.get(colIds[0]).y)  // anchor the column to the grid
        for (const id of colIds) {
          positions.set(id, { x: sx, y: top })
          top = _ceilToGrid(top + _h(nodeById.get(id)) + SNAP_STEP)  // >= one step, < two, on grid
        }
      }
    }
  }

  return { positions }
}

/**
 * Reorganize's concept-layer pass (Phase 8.5). Re-tidies the concept layer with
 * the SAME wire-driven layout as the interactive tidy, but PARTITIONED by chapter
 * so a concept wire never drags a concept across a chapter boundary:
 *   - Off-chapter concepts (+ off-chapter concept groups) tidy as ONE cluster,
 *     placed off to the side above the narrative and left of the chapters (the
 *     standard concept region + `chapterLeftEdge` bound).
 *   - Each chapter's in-chapter concepts tidy as their OWN cluster, in a band
 *     ABOVE that chapter's scene row, x-anchored to the chapter's scene span so
 *     they stay inside the chapter and clear of its scenes.
 *
 * `chapterOfNode(node) -> chapterId | null` classifies a node's chapter; the
 * caller passes the single-row or multi-row membership fn so this stays layout-
 * mode agnostic. A concept group takes its own chapter; a concept card inside a
 * group inherits the group's chapter (so a group and its members never split
 * across partitions). Returns a merged `Map<id, {x, y}>`; ids absent from the map
 * keep their current position. Pure + deterministic (partitions and per-partition
 * calls run in id-sorted order).
 */
export function computeReorganizeConceptLayout(nodes = [], edges = [], {
  chapterOfNode = () => null,
  snapToGrid = false,
  chapterLeftEdge = Infinity,
  // Optional movable filters. null = ALL concepts / groups in each partition move
  // (the reorganize-canvas behaviour). A Set restricts movement to those ids
  // (the on-wire session tidy: only THIS session's nodes move, user-placed ones
  // stay put but still anchor the partition's layout).
  movableConceptIds = null,
  movableGroupIds = null,
} = {}) {
  const merged = new Map()
  const conceptBodies = nodes.filter(_isConceptBody)
  if (conceptBodies.length === 0) return merged
  const filterMov = (ids, filter) => (filter ? new Set([...ids].filter((id) => filter.has(id))) : ids)

  // Group memberships: a member card shares its group's partition (and rides with
  // it), rather than being partitioned by its own position.
  const { containedByGroup } = _buildCompoundConceptGraph(nodes, edges)
  const groupOfContained = new Map()
  for (const [gid, ids] of containedByGroup) for (const id of ids) groupOfContained.set(id, gid)

  // A concept group whose members span MORE THAN ONE chapter must NOT be
  // collapsed into a single chapter's cluster: assigning every member the
  // group's one partition would pull an off-chapter member out of its chapter
  // (the reorganize "span collapse"). Such a group is left exactly where it is
  // — the mode-switch pass already placed it spanning the (kept-together) row —
  // by excluding it AND its members from the partitioning below, so they never
  // enter the merged result and their positions are kept unchanged. A group all
  // of whose members share one chapter (or is fully off-chapter) still tidies
  // normally.
  const _rzNodeById = new Map(nodes.map((n) => [n.id, n]))
  const spanningExcluded = new Set()
  for (const [gid, ids] of containedByGroup) {
    const chaps = new Set()
    for (const id of ids) {
      const m = _rzNodeById.get(id)
      if (m) { const c = chapterOfNode(m); chaps.add(c == null ? '' : String(c)) }
    }
    if (chaps.size > 1) { spanningExcluded.add(gid); for (const id of ids) spanningExcluded.add(id) }
  }

  // partitionOf: every concept-layer node -> its chapter key (chapterId | null).
  const partitionOf = new Map()
  for (const n of conceptBodies) {
    if (spanningExcluded.has(n.id)) continue
    if (_isConceptGroupBody(n)) partitionOf.set(n.id, chapterOfNode(n) || null)
  }
  for (const n of conceptBodies) {
    if (spanningExcluded.has(n.id)) continue
    if (_isConceptGroupBody(n)) continue
    const gid = groupOfContained.get(n.id)
    partitionOf.set(n.id, (gid && partitionOf.has(gid)) ? partitionOf.get(gid) : (chapterOfNode(n) || null))
  }

  const keyOf = (k) => (k == null ? '' : String(k))

  // Bucket concept bodies by partition key ('' = off-chapter).
  const parts = new Map()  // key -> { conceptIds:Set, groupIds:Set }
  for (const n of conceptBodies) {
    if (!partitionOf.has(n.id)) continue  // spanning-group node → excluded, stays put
    const k = keyOf(partitionOf.get(n.id))
    if (!parts.has(k)) parts.set(k, { conceptIds: new Set(), groupIds: new Set() })
    const p = parts.get(k)
    if (_isConceptGroupBody(n)) p.groupIds.add(n.id); else p.conceptIds.add(n.id)
  }

  // Per-chapter scene bbox: the in-chapter band's floor (topmost scene y) and
  // x-span (left edge + width). Uses scene node positions only, like the region.
  const chapterSceneBox = new Map()  // key -> { minX, minY, maxX }
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    const cid = chapterOfNode(n)
    if (!cid) continue
    const k = keyOf(cid)
    const x = n.position?.x ?? 0, y = n.position?.y ?? 0, w = _w(n, 320)
    const b = chapterSceneBox.get(k) || { minX: Infinity, minY: Infinity, maxX: -Infinity }
    b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x + w)
    chapterSceneBox.set(k, b)
  }

  const partOfEndpoint = (id) => (partitionOf.has(id) ? keyOf(partitionOf.get(id)) : null)

  for (const [k, part] of [...parts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (part.conceptIds.size === 0 && part.groupIds.size === 0) continue
    // Apply the optional movable filter: only these ids move within the partition;
    // the rest stay put but still anchor the layout. Skip a partition with nothing
    // movable in it.
    const cMov = filterMov(part.conceptIds, movableConceptIds)
    const gMov = filterMov(part.groupIds, movableGroupIds)
    if (cMov.size === 0 && gMov.size === 0) continue
    // Only wires wholly inside this partition shape its layout — a cross-partition
    // wire is dropped so it can't pull a concept out of its chapter.
    const partEdges = edges.filter((e) => _isConceptEdge(e) && partOfEndpoint(e.source) === k && partOfEndpoint(e.target) === k)
    let opts
    if (k === '') {
      // Off-chapter cluster: standard region (above + left of the narrative),
      // kept left of the chapters by the chapterLeftEdge bound.
      opts = { movableConceptIds: cMov, movableGroupIds: gMov, snapToGrid, chapterLeftEdge }
    } else {
      // In-chapter cluster: band ABOVE this chapter's scenes, x-confined to the
      // chapter's scene span. If the chapter has concepts but no scenes, fall back
      // to the concepts' own current top-left so they tidy roughly in place.
      const box = chapterSceneBox.get(k)
      let regionOverride, bandMaxWidth
      if (box && isFinite(box.minX)) {
        regionOverride = { leftX: box.minX, floorY: box.minY }
        bandMaxWidth = Math.max(box.maxX - box.minX, CONCEPT_W + GAP_X)
      } else {
        let fbMinX = Infinity, fbMaxY = -Infinity
        for (const n of conceptBodies) {
          if (keyOf(partitionOf.get(n.id)) !== k) continue
          const s = _sizeOf(n)
          fbMinX = Math.min(fbMinX, n.position?.x ?? 0)
          fbMaxY = Math.max(fbMaxY, (n.position?.y ?? 0) + s.h)
        }
        regionOverride = { leftX: isFinite(fbMinX) ? fbMinX : 0, floorY: isFinite(fbMaxY) ? fbMaxY + FLOOR_GAP : 0 }
        bandMaxWidth = null
      }
      opts = { movableConceptIds: cMov, movableGroupIds: gMov, snapToGrid, chapterLeftEdge: Infinity, regionOverride, bandMaxWidth }
    }
    const { positions } = computeConceptTidyLayout(nodes, partEdges, opts)
    for (const [id, p] of positions) merged.set(id, p)
  }
  return merged
}

/**
 * The concept-band region for a SPECIFIC chapter: the anchor a caller passes to
 * `placeMcpConceptNode` / `placeMcpGroupNode` (via `regionOverride`) to drop a
 * new concept / group into a band ABOVE that chapter's scenes, x-anchored to the
 * chapter's scene span. Returns `{ leftX, floorY, maxX }` (scene left, scene top,
 * scene right) from the chapter's scene nodes, or null when the chapter has no
 * scenes yet (caller falls back to a chapter-centre placement). `chapterOfNode`
 * is the mode-aware membership fn (single-row or multi-row).
 */
export function computeChapterConceptRegion(nodes = [], chapterOfNode = () => null, chapterId = null) {
  if (!chapterId) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    if (chapterOfNode(n) !== chapterId) continue
    const x = n.position?.x ?? 0, y = n.position?.y ?? 0, w = _w(n, 320)
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w)
  }
  if (!isFinite(minX)) return null
  return { leftX: minX, floorY: minY, maxX }
}
