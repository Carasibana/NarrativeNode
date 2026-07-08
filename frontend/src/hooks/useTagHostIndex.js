/**
 * useTagHostIndex — project-level cached tag-host index.
 *
 * Hosted alongside `useStoryOrder` / `useKnowledgeNodeMaps` /
 * `useRelationshipNodeMaps`. Same convention: a module-level cache
 * shared across every consumer so the first hook call after a
 * deps change pays the rebuild, every other consumer in the same
 * render tick reads through, popover opens are O(1).
 *
 * Two split memos with different dependency surfaces:
 *
 *   - membershipIndex: depends only on tag-bearing fields of the
 *     project. Stable across position drags, name edits, wire
 *     reroutes — anything that isn't a tag mutation.
 *
 *   - anchorIndex: depends on membershipIndex + project-wide story
 *     order. Rebuilds when membership changes OR canvas structure
 *     changes (anchor positions can shift even without a tag
 *     mutation).
 *
 * The split is realised structurally as two separate module caches;
 * React `useMemo` deps narrow each cache's invalidation surface to
 * the inputs that actually feed it. Anchor recompute does NOT pay
 * for an unnecessary membership rebuild when only positions change,
 * and membership recompute does NOT trigger an anchor rebuild when
 * tag data changed but story order didn't.
 *
 * Replaces the per-popover-open `collectHostsForProjectTag` plus
 * per-host `findEarliestProjectTagAnchor` walks in TagPopover.
 * Pure functions live in `utils/tagHostIndex.js`; this hook is the
 * subscribe-and-cache layer.
 */

import { useMemo } from 'react'
import { useEntitiesStore } from '../store/entitiesStore'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { buildMembershipIndex, buildAnchorIndex } from '../utils/tagHostIndex'
import { useStoryOrder } from './useStoryOrder'

const EMPTY_ARRAY = Object.freeze([])

// Module-level shared caches. Identity-equal inputs hit; any single
// ref change rebuilds. The drag short-circuit (`isDraggingNodes`)
// reuses the latest cached result so 60Hz position updates during a
// drag don't thrash the rebuild — anchor positions update on
// drag-release, which is when the writer can act on them anyway.
//
 
let _membershipCache = {
  characters: null,
  locations: null,
  items: null,
  factions: null,
  customs: null,
  presetLists: null,
  knowledges: null,
  relationships: null,
  nodes: null,
  result: null,
}
 
let _anchorCache = {
  membershipIndex: null,
  storyOrder: null,
  characters: null,
  locations: null,
  items: null,
  factions: null,
  customs: null,
  presetLists: null,
  knowledges: null,
  relationships: null,
  nodes: null,
  result: null,
}

function _getOrBuildMembership({ characters, locations, items, factions, customs, presetLists, knowledges, relationships, nodes }) {
  if (
    _membershipCache.characters === characters
    && _membershipCache.locations === locations
    && _membershipCache.items === items
    && _membershipCache.factions === factions
    && _membershipCache.customs === customs
    && _membershipCache.presetLists === presetLists
    && _membershipCache.knowledges === knowledges
    && _membershipCache.relationships === relationships
    && _membershipCache.nodes === nodes
    && _membershipCache.result
  ) {
    return _membershipCache.result
  }
  const result = buildMembershipIndex({
    entities: { characters, locations, items, factions, customs, presetLists },
    knowledges,
    relationships,
    nodes,
  })
   
  _membershipCache = {
    characters, locations, items, factions, customs, presetLists,
    knowledges, relationships, nodes, result,
  }
  return result
}

function _getOrBuildAnchor({ membershipIndex, storyOrder, characters, locations, items, factions, customs, presetLists, knowledges, relationships, nodes }) {
  if (
    _anchorCache.membershipIndex === membershipIndex
    && _anchorCache.storyOrder === storyOrder
    && _anchorCache.characters === characters
    && _anchorCache.locations === locations
    && _anchorCache.items === items
    && _anchorCache.factions === factions
    && _anchorCache.customs === customs
    && _anchorCache.presetLists === presetLists
    && _anchorCache.knowledges === knowledges
    && _anchorCache.relationships === relationships
    && _anchorCache.nodes === nodes
    && _anchorCache.result
  ) {
    return _anchorCache.result
  }
  const orderedIds = (storyOrder && storyOrder.orderedIds) || EMPTY_ARRAY
  const result = buildAnchorIndex({
    storyOrder: orderedIds,
    entities: { characters, locations, items, factions, customs, presetLists },
    knowledges,
    relationships,
    nodes,
  })
   
  _anchorCache = {
    membershipIndex, storyOrder, characters, locations, items, factions,
    customs, presetLists, knowledges, relationships, nodes, result,
  }
  return result
}

/**
 * Returns `{ membershipIndex, anchorIndex }`. Both are
 * structurally-stable across renders with unchanged inputs so
 * downstream `useMemo`s keyed off the index don't re-run unless
 * the underlying tag/anchor data actually changed.
 */
export function useTagHostIndex() {
  const characters    = useEntitiesStore((s) => s.characters)
  const locations     = useEntitiesStore((s) => s.locations)
  const items         = useEntitiesStore((s) => s.items)
  const factions      = useEntitiesStore((s) => s.factions)
  const customs       = useEntitiesStore((s) => s.customs)
  const presetLists   = useEntitiesStore((s) => s.presetLists)
  const knowledges    = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const nodes         = useProjectStore((s) => s.nodes)
  const isDraggingNodes = useUiStore((s) => s.isDraggingNodes)

  const storyOrder = useStoryOrder()

  const membershipIndex = useMemo(() => {
    if (isDraggingNodes && _membershipCache.result) return _membershipCache.result
    return _getOrBuildMembership({
      characters, locations, items, factions, customs, presetLists,
      knowledges, relationships, nodes,
    })
  }, [characters, locations, items, factions, customs, presetLists, knowledges, relationships, nodes, isDraggingNodes])

  const anchorIndex = useMemo(() => {
    if (isDraggingNodes && _anchorCache.result) return _anchorCache.result
    return _getOrBuildAnchor({
      membershipIndex, storyOrder,
      characters, locations, items, factions, customs, presetLists,
      knowledges, relationships, nodes,
    })
  }, [membershipIndex, storyOrder, characters, locations, items, factions, customs, presetLists, knowledges, relationships, nodes, isDraggingNodes])

  return useMemo(() => ({ membershipIndex, anchorIndex }), [membershipIndex, anchorIndex])
}

/**
 * Non-React helper for hot-path callers in event handlers, store
 * actions, and the MCP `list_tags` / `list_alerts` paths that need
 * the index outside the render tree. Reads the same module-level
 * caches the hook populates: identity-equal inputs return the cached
 * result; any single ref change recomputes, updates the cache, and
 * returns the new result.
 *
 * Mirrors `getOrComputeStoryOrder` in `useStoryOrder.js`. No drag
 * short-circuit — callers fire from user actions whose correctness
 * depends on current state, not the deliberately-stale mid-drag
 * snapshot.
 */
export function getOrComputeTagHostIndex({
  characters, locations, items, factions, customs, presetLists,
  knowledges, relationships, nodes, storyOrder,
}) {
  const membershipIndex = _getOrBuildMembership({
    characters, locations, items, factions, customs, presetLists,
    knowledges, relationships, nodes,
  })
  const anchorIndex = _getOrBuildAnchor({
    membershipIndex, storyOrder,
    characters, locations, items, factions, customs, presetLists,
    knowledges, relationships, nodes,
  })
  return { membershipIndex, anchorIndex }
}
