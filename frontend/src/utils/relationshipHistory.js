import { getRelationshipNodeOrder, computeRelationshipEffectiveState } from './narrativeChain'

// Pure domain helpers for relationship.history mutations.
//
// Layer 1 of the three-layer write convention: these are pure functions that
// take a relationship object (plus args) and return an updated relationship
// object, enforcing normalized-history invariants. No React, no store, no I/O.
// Store actions in projectStore.js wrap these helpers with _snapshot() /
// axios / undo-redo plumbing.
//
// History-only model: there is no `participants[]` base mirror on the
// relationship. The canonical participant state is derived by walking
// `history.participant_changes`.
//
// Normalized-history invariants enforced at write time:
//
// Paired change types (participant_changes; join <-> leave):
//   - At most one `join@N` per entity per node; at most one `leave@N`.
//   - Same-node opposite pair cancels: writing `leave@N` when a `join@N` for
//     the same entity exists strips both entries (no leave written).
//     Writing `join@N` when a `leave@N` exists strips both entries.
//   - Cross-node entries coexist: join@N, leave@N+1, join@N+2 is valid.
//   - Duplicate same-kind write drops (no-op).
//
// Cascade:
//   - Callers inspect `shouldCascade` on the return value and route to
//     `deleteObject('relationship', id)` when the relationship no longer has
//     any potential participants (no join events remain in history).


/**
 * Canonical factory for a fresh, empty `Relationship.history` object with
 * every array-valued field present. Use this everywhere a new relationship
 * is created — never hand-roll the history shape at the call site.
 *
 * Keeping the shape in one place prevents schema drift: when a new history
 * array is added (e.g. `manual_anchors` in v0.1.18.127), every creation path
 * picks it up automatically instead of the shape diverging by site.
 *
 * Optional opts:
 *   - bornAtSceneId — when set, seeds an `existence_changes: [{node_id, action:'activate'}]`
 *     entry so the relationship is "born active" at that scene. Mirrors the
 *     old hand-crafted pattern in `EntityDetailPanel.jsx`'s `+ Create Relationship`.
 */
export function createEmptyRelationshipHistory({ bornAtSceneId = null } = {}) {
  return {
    existence_changes:   bornAtSceneId ? [{ node_id: bornAtSceneId, action: 'activate' }] : [],
    participant_changes: [],
    perception_changes:  [],
    alias_changes:       [],
    role_changes:        [],
    hierarchy_changes:   [],
    name_changes:        [],
    manual_anchors:      [],
  }
}

/**
 * Domain helper: update a participant's `initial_perception` (seeded at their
 * first join) across every `join` event for that entity in the rel's history.
 * Used by participant-perception edits made at the creation-node context —
 * there's no base mirror, so the initial_perception travels on the join events.
 */
export function setParticipantInitialPerception(relationship, entityId, perception) {
  const history = relationship.history || {}
  const changes = (history.participant_changes || []).map((c) =>
    (c.action === 'join' && c.entity_id === entityId)
      ? { ...c, initial_perception: perception }
      : c
  )
  return { ...relationship, history: { ...history, participant_changes: changes } }
}

/**
 * Domain helper: update a participant's `initial_alias_override` across every
 * `join` event for that entity. Mirrors `setParticipantInitialPerception`.
 * Passing null (or an empty string, which we normalize to null) clears the
 * alias override on each join.
 */
export function setParticipantInitialAlias(relationship, entityId, alias) {
  const normalized = alias || null
  const history = relationship.history || {}
  const changes = (history.participant_changes || []).map((c) =>
    (c.action === 'join' && c.entity_id === entityId)
      ? { ...c, initial_alias_override: normalized }
      : c
  )
  return { ...relationship, history: { ...history, participant_changes: changes } }
}


/** Returns true if the relationship has any potential participant — i.e. any
 *  `join` event in its history. With no base mirror, this is purely a
 *  history-driven check. */
export function hasAnyPotentialParticipant(relationship) {
  const changes = relationship.history?.participant_changes || []
  return changes.some((c) => c.action === 'join')
}

// ── Duplicate-relationship detection helpers ────────────────────────────
// Used by wiring paths in `projectStore.onConnect` that auto-create a new
// relationship from a drag gesture, to prompt the user before silently
// creating a duplicate of an already-existing active relationship.
//
// Two semantic variants based on the creation path — see the ToDo item
// "Duplicate-relationship creation guard" for the full rationale:
//   - `findDuplicateAtOrigin`: entity-origin → entity-origin wiring. Both
//     the new rel and the candidates have their own relationship-origin-
//     node. Compare origin-state participants (origin-anchored joins only).
//   - `findDuplicateAtScene`:  in-scene wiring (entity → scene-chip rel-in,
//     chip-to-chip within a scene). Compare effective state at THAT SCENE
//     for each existing rel whose chain includes that scene. Skip ended
//     rels and rels where participants have since left.
//
// Return shape for both: `null` (no duplicate) or
//   `{ kind: 'exact' | 'superset', existingRel }`.
// Exact beats superset when both apply to the same rel.
//
// `membership_of` rels are always skipped — they're semantically different
// (faction-membership containers, not ad-hoc social relationships).

function _setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
function _isSupersetOf(sup, sub) {
  if (sup.size <= sub.size) return false
  for (const x of sub) if (!sup.has(x)) return false
  return true
}

/** Entity-origin-to-entity-origin wiring variant. Compares proposed
 *  participants against origin-state participants of every existing rel
 *  that has its own `relationshipOriginNode`. Rels born at a scene (no
 *  origin node) are skipped — different semantic footing.
 */
export function findDuplicateAtOrigin(proposedEntityIds, existingRels, nodes) {
  const proposedSet = new Set(proposedEntityIds)
  if (proposedSet.size === 0) return null

  const originNodeByRelId = new Map()
  for (const n of (nodes || [])) {
    if (n.type === 'relationshipOriginNode' && n.data?.relationship_id) {
      originNodeByRelId.set(n.data.relationship_id, n.id)
    }
  }

  let supersetMatch = null
  for (const rel of (existingRels || [])) {
    if (rel.membership_of) continue
    const originNodeId = originNodeByRelId.get(rel.id)
    if (!originNodeId) continue  // rel-origin-nodeless rels don't qualify

    const originSet = new Set(
      (rel.history?.participant_changes || [])
        .filter((c) => c.action === 'join' && c.node_id === originNodeId)
        .map((c) => c.entity_id)
    )
    if (originSet.size === 0) continue

    if (_setsEqual(originSet, proposedSet)) return { kind: 'exact', existingRel: rel }
    if (!supersetMatch && _isSupersetOf(originSet, proposedSet)) {
      supersetMatch = { kind: 'superset', existingRel: rel }
    }
  }
  return supersetMatch
}

/** In-scene-wiring variant. Compares proposed participants against each
 *  existing rel's effective state at `sceneNodeId`. Skips rels whose chain
 *  doesn't reach that scene, rels with `is_active === false` at that scene,
 *  and rels whose effective participant set at that scene doesn't contain
 *  all the proposed participants (= not a duplicate by the current rule).
 *
 *  Imports from `narrativeChain.js` — no circular dependency because
 *  `narrativeChain.js` does not import `relationshipHistory.js`.
 */
export function findDuplicateAtScene(proposedEntityIds, existingRels, nodes, edges, sceneNodeId) {
  const proposedSet = new Set(proposedEntityIds)
  if (proposedSet.size === 0 || !sceneNodeId) return null

  let supersetMatch = null
  for (const rel of (existingRels || [])) {
    if (rel.membership_of) continue
    const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges)
    if (!nodeOrder.includes(sceneNodeId)) continue  // rel's chain doesn't reach this scene
    const state = computeRelationshipEffectiveState(rel, nodeOrder, sceneNodeId)
    if (!state || !state.is_active) continue

    const effectiveSet = new Set((state.participants || []).map((p) => p.entity_id))
    if (effectiveSet.size === 0) continue

    if (_setsEqual(effectiveSet, proposedSet)) return { kind: 'exact', existingRel: rel }
    if (!supersetMatch && _isSupersetOf(effectiveSet, proposedSet)) {
      supersetMatch = { kind: 'superset', existingRel: rel }
    }
  }
  return supersetMatch
}

function omitParticipantRole(roles, entityId) {
  if (!roles || roles[entityId] === undefined) return roles || {}
  const next = { ...roles }
  delete next[entityId]
  return next
}

/**
 * Add a participant join at a given node, enforcing the normalized-history
 * invariants. History-only: no base mirror is updated.
 *
 * Returns: { relationship, mode }
 *   - mode: 'noop' | 'pair-cancel' | 'appended'
 *       'noop'          duplicate join@N, OR entity is already an active
 *                       participant (joins > leaves across all history)
 *                       — relationship unchanged
 *       'pair-cancel'   existing leave@N stripped; no new join written
 *       'appended'      new join@N added (fresh join, or a legitimate rejoin
 *                       after a balanced leave somewhere upstream)
 */
export function addParticipantJoin(relationship, entityId, atNodeId, opts = {}) {
  const { initialPerception = '', initialAliasOverride = null } = opts
  const history = relationship.history || {}
  const changes = history.participant_changes || []

  // Branch 1: duplicate join@atNodeId -> no-op
  if (changes.some((c) => c.entity_id === entityId && c.action === 'join' && c.node_id === atNodeId)) {
    return { relationship, mode: 'noop' }
  }

  // Branch 2: existing leave@atNodeId -> pair-cancel (strip leave, don't write join)
  const leaveIdx = changes.findIndex((c) => c.entity_id === entityId && c.action === 'leave' && c.node_id === atNodeId)
  if (leaveIdx >= 0) {
    const stripped = changes[leaveIdx]
    const updatedChanges = changes.filter((_, i) => i !== leaveIdx)
    return {
      relationship: { ...relationship, history: { ...history, participant_changes: updatedChanges } },
      mode: 'pair-cancel',
      // Caller fires `_runEventRemovalCascade([removedChangeId])` so any
      // Knowledge whose source_event referenced this leave gets
      // auto-detached (the v8 bug #3 fix; without this id, the cascade
      // can't find the orphan).
      removedChangeId: stripped?.id || null,
    }
  }

  // Branch 3: active-participant guard. An entity whose joins outnumber leaves
  // across the rel's history is currently "in" the relationship — a second
  // join event for the same entity without an intervening leave is
  // semantically meaningless and would produce a duplicate `+ Joined`
  // indicator at the new node. Legitimate rejoins (left, then returned) have
  // balanced counts and pass through.
  const joinCount = changes.reduce(
    (n, c) => n + (c.entity_id === entityId && c.action === 'join' ? 1 : 0), 0
  )
  const leaveCount = changes.reduce(
    (n, c) => n + (c.entity_id === entityId && c.action === 'leave' ? 1 : 0), 0
  )
  if (joinCount > leaveCount) {
    return { relationship, mode: 'noop' }
  }

  // Branch 4: standard append (fresh join, or rejoin after a balanced leave)
  const newJoin = {
    node_id: atNodeId,
    action: 'join',
    entity_id: entityId,
    initial_perception: initialPerception,
    initial_alias_override: initialAliasOverride,
  }
  const updatedChanges = [...changes, newJoin]
  return {
    relationship: {
      ...relationship,
      history: { ...history, participant_changes: updatedChanges },
    },
    mode: 'appended',
  }
}

/**
 * Remove a participant at a given node. History-only model: there is no base
 * mirror to strip from. Semantic branches:
 *   - If a join@atNodeId exists -> pair-cancel (strip the join). If the entity
 *     has no remaining joins anywhere, also drop its participant_roles entry.
 *   - If a leave@atNodeId already exists -> no-op.
 *   - Otherwise -> append a leave@atNodeId entry (additive remove).
 *
 * Returns: { relationship, mode, shouldCascade }
 *   - mode: 'pair-cancel' | 'noop' | 'additive-leave'
 *   - shouldCascade: true when the relationship no longer has any potential
 *                    participants and caller should delete it.
 */
export function removeParticipantAtNode(relationship, entityId, atNodeId) {
  const history = relationship.history || {}
  const changes = history.participant_changes || []

  // Branch 1: join@atNodeId exists -> pair-cancel
  const joinIdx = changes.findIndex((c) => c.entity_id === entityId && c.action === 'join' && c.node_id === atNodeId)
  if (joinIdx >= 0) {
    const stripped = changes[joinIdx]
    const updatedChanges = changes.filter((_, i) => i !== joinIdx)
    const stillHasJoin = updatedChanges.some((c) => c.entity_id === entityId && c.action === 'join')
    let updatedRoles = relationship.participant_roles || {}
    if (!stillHasJoin) {
      updatedRoles = omitParticipantRole(updatedRoles, entityId)
    }
    const updated = {
      ...relationship,
      participant_roles: updatedRoles,
      history: { ...history, participant_changes: updatedChanges },
    }
    return {
      relationship: updated,
      mode: 'pair-cancel',
      shouldCascade: !hasAnyPotentialParticipant(updated),
      // Caller fires `_runEventRemovalCascade([removedChangeId])` so
      // any Knowledge whose source_event referenced this join gets
      // auto-detached (the v8 bug #3 fix).
      removedChangeId: stripped?.id || null,
    }
  }

  // Branch 2: leave@atNodeId already exists -> duplicate, no-op
  const hasLeaveHere = changes.some((c) => c.entity_id === entityId && c.action === 'leave' && c.node_id === atNodeId)
  if (hasLeaveHere) {
    return { relationship, mode: 'noop', shouldCascade: false }
  }

  // Branch 3: standard additive leave
  const newLeave = { node_id: atNodeId, action: 'leave', entity_id: entityId }
  const updatedChanges = [...changes, newLeave]
  const updated = {
    ...relationship,
    history: { ...history, participant_changes: updatedChanges },
  }
  // Additive leave means the relationship still has a corresponding `join`
  // somewhere upstream, so shouldCascade is always false for this branch.
  return {
    relationship: updated,
    mode: 'additive-leave',
    shouldCascade: false,
  }
}
