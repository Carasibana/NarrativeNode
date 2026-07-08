/**
 * Group membership utilities — Phase 1.11 Track I.
 *
 * Generic group containers use PURELY GEOMETRIC derived membership: a node
 * belongs to a group iff the node's bounding box is FULLY CONTAINED inside
 * the group's bounding box. No `node_ids[]` list is stored anywhere — the
 * group model only carries its own position + size, and membership is
 * computed on demand from geometry.
 *
 * Pure functions, zero store reads. Safe to call at render time, at
 * drag-start to snapshot members, or in the save pipeline.
 *
 * Design rationale: this mirrors how chapter membership works
 * (`getChapterIdForNode`) and eliminates the entire stale-reference bug
 * class. See the Phase 1.11 Track I ToDo block for full design notes,
 * including drag semantics (mid-drag freeze, post-drop re-derive).
 */

import { getMeasuredWidth, getMeasuredHeight } from './measuredDimensionsStore'

/**
 * Read a node's effective width/height using the same fallback chain as
 * the rest of the codebase (`getNodeBBox`, `_readNodeWidth`): prefer
 * `measured.*` (explicit pre-seeded sizes), then the measured-dimensions
 * side store (what React Flow actually rendered — Phase 4.1g #4), then
 * `data.*`, then the top-level prop. If none are set yet, returns a rough default so
 * the containment check still produces a sensible result — otherwise
 * a node whose dimensions haven't been measured yet by React Flow's
 * ResizeObserver would be invisible to `isNodeInGroup` and silently
 * excluded from any group it sits inside. Defaults are slightly
 * generous so early-render edge cases don't under-count membership.
 */
function _readNodeSize(node) {
  const w = node.measured?.width ?? getMeasuredWidth(node.id)  ?? node.data?.width  ?? node.width  ?? _defaultSize(node).w
  const h = node.measured?.height ?? getMeasuredHeight(node.id) ?? node.data?.height ?? node.height ?? _defaultSize(node).h
  return { w, h }
}

function _defaultSize(node) {
  switch (node?.type) {
    case 'sceneNode':   return { w: 220, h: 160 }
    case 'referenceNode':   return { w: 220, h: 140 }
    case 'entityNode':      return { w: 180, h: 100 }
    case 'povOriginNode':   return { w:  60, h:  60 }
    case 'genericGroupNode':return { w: 400, h: 300 }
    default:                return { w: 120, h:  60 }
  }
}

/**
 * Read a group's effective size. Priority is MEASURED first (reflects
 * the real DOM, updated by React Flow's ResizeObserver whenever the
 * node wrapper resizes — this is what's actually live on screen), then
 * `data` (the authoritative field `onResize` writes to via
 * `updateNodeData` — always up-to-date after a user resize), then
 * `style` (the initial size set at group creation — goes stale
 * immediately after any resize since the resize handler doesn't touch
 * style), then the top-level `width`/`height`, then the default.
 *
 * The old version of this helper preferred `style` first, which made
 * the reader lag behind every resize — the group visually grew but
 * membership was still checked against the initial 400 × 300 box.
 */
function _readGroupSize(group) {
  const w = group.measured?.width ?? getMeasuredWidth(group.id)  ?? group.data?.width  ?? group.style?.width  ?? group.width  ?? _defaultSize(group).w
  const h = group.measured?.height ?? getMeasuredHeight(group.id) ?? group.data?.height ?? group.style?.height ?? group.height ?? _defaultSize(group).h
  return { w, h }
}

/**
 * Return `true` iff `node`'s bounding box is fully contained inside
 * `group`'s bounding box. All four corners of the node must be at or
 * inside the group's four edges (inclusive). A node exactly flush with
 * the group edge counts as contained.
 *
 * `node` and `group` are React Flow node objects — both have `position`
 * and (via the helpers above) a resolvable width/height. The `group`
 * must be a node with `type === 'genericGroupNode'` but this function
 * doesn't check — callers pass the right shape or they don't.
 *
 * Nulls / non-objects return false. Otherwise the check is purely
 * arithmetic — no zero-dimension short-circuit, because an unmeasured
 * node still has a valid position and a reasonable default size, and
 * shouldn't be silently excluded from a group it geometrically sits in.
 */
export function isNodeInGroup(node, group) {
  if (!node || !group) return false
  const nx = node.position?.x ?? 0
  const ny = node.position?.y ?? 0
  const { w: nw, h: nh } = _readNodeSize(node)
  const gx = group.position?.x ?? 0
  const gy = group.position?.y ?? 0
  const { w: gw, h: gh } = _readGroupSize(group)
  return (
    nx >= gx &&
    ny >= gy &&
    nx + nw <= gx + gw &&
    ny + nh <= gy + gh
  )
}

/**
 * Return every node in `nodes` that is a member of `group` (per
 * `isNodeInGroup`). The group itself is excluded from the result even
 * if its id happens to match a geometric check — groups don't contain
 * themselves.
 *
 * Callers typically want to exclude OTHER groups from the result too
 * (a group inside another group during a header drag would cause
 * cascading moves). The `excludeGroups` option defaults to true for
 * that reason.
 */
export function getNodesInGroup(group, nodes, { excludeGroups = true } = {}) {
  if (!group || !nodes) return []
  const out = []
  for (const n of nodes) {
    if (n.id === group.id) continue
    if (excludeGroups && n.type === 'genericGroupNode') continue
    if (isNodeInGroup(n, group)) out.push(n)
  }
  return out
}

/**
 * Convenience: return every group in `nodes` that contains `node`.
 * Useful for "which groups is this node in?" queries. A node may be
 * in zero, one, or multiple groups simultaneously (groups can overlap).
 */
export function getGroupsForNode(node, nodes) {
  if (!node || !nodes) return []
  const out = []
  for (const g of nodes) {
    if (g.type !== 'genericGroupNode') continue
    if (g.id === node.id) continue
    if (isNodeInGroup(node, g)) out.push(g)
  }
  return out
}
