// Phase 1.26a — pure helpers for the per-relationship hierarchy tree.
//
// Tree shape: forest of `HierarchyNode` objects, each `{ id, children }`.
// `id` is an entity_id in participants mode and a role-value string in
// roles mode. Helpers operate on the forest as plain JS data; no
// store coupling. Each helper returns a NEW forest (immutable update).

/** Deep-clone a node and its descendants. */
function cloneNode(node) {
  return { id: node.id, children: (node.children || []).map(cloneNode) }
}

/** Deep-clone a forest. */
export function cloneRoots(roots) {
  return (roots || []).map(cloneNode)
}

/** Walk the forest and call visit(node, parent | null) for each. */
export function walkForest(roots, visit) {
  function rec(nodes, parent) {
    for (const n of (nodes || [])) {
      visit(n, parent)
      rec(n.children, n)
    }
  }
  rec(roots, null)
}

/** Find a node by id; returns the node, or null. */
export function findNode(roots, id) {
  let found = null
  walkForest(roots, (n) => { if (n.id === id) found = n })
  return found
}

/** Find the parent of a node by child id; returns the parent node, or null
 *  if the target is a root or not found. */
export function findParent(roots, id) {
  let parent = null
  walkForest(roots, (n) => {
    if (parent) return
    if ((n.children || []).some((c) => c.id === id)) parent = n
  })
  return parent
}

/** Return true if `descendantId` is `ancestorId` or sits anywhere in the
 *  subtree rooted at the node with `ancestorId`. Used to detect cycles
 *  during reparent. */
export function isDescendantOf(roots, ancestorId, descendantId) {
  const ancestor = findNode(roots, ancestorId)
  if (!ancestor) return false
  if (ancestor.id === descendantId) return true
  let hit = false
  walkForest(ancestor.children, (n) => { if (n.id === descendantId) hit = true })
  return hit
}

/** Remove a node (and its subtree) from the forest. Returns the new forest
 *  AND the removed node (so the caller can re-insert at the new parent). */
function detachNode(roots, id) {
  let removed = null
  function rec(nodes) {
    const out = []
    for (const n of (nodes || [])) {
      if (n.id === id) {
        removed = cloneNode(n)
        continue
      }
      out.push({ id: n.id, children: rec(n.children) })
    }
    return out
  }
  return { roots: rec(roots), removed }
}

/** Reparent a node. `newParentId === null` puts the node at top level
 *  (root sibling). Cycle-safe: rejects (returns roots unchanged) when
 *  the proposed new parent is the node itself or a descendant of it. */
export function reparentNode(roots, nodeId, newParentId) {
  if (nodeId === newParentId) return roots
  if (newParentId && isDescendantOf(roots, nodeId, newParentId)) return roots
  const { roots: detached, removed } = detachNode(roots, nodeId)
  if (!removed) return roots
  if (newParentId === null) {
    return [...detached, removed]
  }
  function rec(nodes) {
    return nodes.map((n) => {
      if (n.id === newParentId) {
        return { id: n.id, children: [...(n.children || []), removed] }
      }
      return { id: n.id, children: rec(n.children) }
    })
  }
  return rec(detached)
}

/** Move a node to top level (sibling of the existing roots). */
export function moveToRoot(roots, nodeId) {
  return reparentNode(roots, nodeId, null)
}

/** Remove a node from the forest entirely. Children of the removed node
 *  are re-parented to the removed node's parent (or become roots if the
 *  removed node was a root). */
export function removeNode(roots, nodeId) {
  const target = findNode(roots, nodeId)
  if (!target) return roots
  const parent = findParent(roots, nodeId)
  function rec(nodes) {
    const out = []
    for (const n of (nodes || [])) {
      if (n.id === nodeId) {
        // Splice the removed node's children into our level
        for (const c of (n.children || [])) out.push(cloneNode(c))
        continue
      }
      out.push({ id: n.id, children: rec(n.children) })
    }
    return out
  }
  // If the parent is a root (or the target was a root), the removed
  // node's children become root siblings, which the rec above handles.
  // No special case needed for parent vs root.
  void parent
  return rec(roots)
}

/** Collect every id that appears anywhere in the forest. */
export function collectIds(roots) {
  const ids = new Set()
  walkForest(roots, (n) => { ids.add(n.id) })
  return ids
}

/** Add a new top-level node with the given id (skips if already in forest). */
export function addTopLevelIfMissing(roots, id) {
  const ids = collectIds(roots)
  if (ids.has(id)) return roots
  return [...roots, { id, children: [] }]
}

/** Auto-include rule: every id in `desiredIds` that isn't already in the
 *  forest is appended as a top-level orphan. Existing tree positions are
 *  left untouched. */
export function autoIncludeMissing(roots, desiredIds) {
  let next = roots
  for (const id of desiredIds) {
    next = addTopLevelIfMissing(next, id)
  }
  return next
}

/** Auto-prune rule: every id present in the forest but NOT in `keepIds`
 *  is removed. Children of removed nodes are re-parented (see removeNode). */
export function autoPruneMissing(roots, keepIds) {
  const present = collectIds(roots)
  const keep = new Set(keepIds)
  let next = roots
  for (const id of present) {
    if (!keep.has(id)) next = removeNode(next, id)
  }
  return next
}

// ── Mode conversions ────────────────────────────────────────────────────
//
// Sentinel for the synthetic Unassigned pool in roles mode. UI-only — never
// stored in the tree. The pool is a list of participants with no role,
// rendered separately above the tree.
export const UNASSIGNED_ROLE = '__unassigned__'

/** Build a depth + parent-role map by walking a participants-mode forest,
 *  keyed by entity_id. Internal helper for participantsToRoles. */
function _walkDepthAndParentRole(roots, getRoleForEntity) {
  const map = new Map()  // entityId -> { depth, parentRole }
  function rec(nodes, depth, parentRole) {
    for (const n of (nodes || [])) {
      map.set(n.id, { depth, parentRole })
      const myRole = getRoleForEntity(n.id)
      rec(n.children, depth + 1, myRole)
    }
  }
  rec(roots, 0, null)
  return map
}

/** Convert a participants-mode forest into a roles-mode forest.
 *
 *  Rule (from the planning doc):
 *  - For each unique role value, gather its members.
 *  - If all members sit at the same depth in the participants tree AND
 *    their parents in the participants tree all share the same role
 *    (or all have null parent role, i.e. are top-level), the role-node
 *    is placed at that depth with that role as its parent.
 *  - Otherwise, the role is parked at the top level for manual fix-up.
 *
 *  Roles tree contains ONLY role-value nodes; participants-without-a-role
 *  are surfaced via the Unassigned pool, not as tree members. The pool
 *  lookup is the caller's responsibility (UI side).
 *
 *  `participantRoles` is the relationship's `participant_roles` dict
 *  (`{entity_id: ParticipantRole}`); we read each participant's role
 *  via its `.value` field. */
export function participantsToRoles(participantsRoots, participantRoles) {
  const getRoleForEntity = (entityId) => {
    const r = participantRoles?.[entityId]
    return r?.value || null
  }
  const depthAndParent = _walkDepthAndParentRole(participantsRoots, getRoleForEntity)

  // Group entities by role.
  const roleMembers = new Map()  // roleValue -> entityId[]
  for (const [entityId] of depthAndParent) {
    const role = getRoleForEntity(entityId)
    if (!role) continue  // unassigned — pool, not tree
    if (!roleMembers.has(role)) roleMembers.set(role, [])
    roleMembers.get(role).push(entityId)
  }

  // For each role, classify: clean (uniform depth + uniform parent-role) or scattered.
  const roleClassification = new Map()  // roleValue -> { depth, parentRole, scattered: bool }
  for (const [role, members] of roleMembers) {
    const depths = new Set()
    const parentRoles = new Set()
    for (const eid of members) {
      const info = depthAndParent.get(eid)
      depths.add(info.depth)
      parentRoles.add(info.parentRole)
    }
    if (depths.size === 1 && parentRoles.size === 1) {
      roleClassification.set(role, {
        depth: [...depths][0],
        parentRole: [...parentRoles][0],
        scattered: false,
      })
    } else {
      roleClassification.set(role, { depth: 0, parentRole: null, scattered: true })
    }
  }

  // Build the roles forest. Place top-level (parentRole === null OR scattered) first,
  // then attach children iteratively until stable. Parent roles must be placed before
  // children so the lookup succeeds.
  const placed = new Map()  // roleValue -> HierarchyNode
  const remaining = new Set(roleClassification.keys())
  const rootsOut = []

  // First pass: top-level (clean with parentRole === null OR scattered).
  for (const [role, c] of roleClassification) {
    if (c.scattered || c.parentRole === null) {
      const node = { id: role, children: [] }
      placed.set(role, node)
      rootsOut.push(node)
      remaining.delete(role)
    }
  }

  // Subsequent passes: attach children whose parent is now placed.
  let progress = true
  while (progress && remaining.size > 0) {
    progress = false
    for (const role of [...remaining]) {
      const c = roleClassification.get(role)
      const parentNode = placed.get(c.parentRole)
      if (parentNode) {
        const node = { id: role, children: [] }
        parentNode.children.push(node)
        placed.set(role, node)
        remaining.delete(role)
        progress = true
      }
    }
  }

  // Anything still in `remaining` references a parent role that doesn't
  // exist (e.g. dangling). Promote to top level for manual fix-up.
  for (const role of remaining) {
    const node = { id: role, children: [] }
    placed.set(role, node)
    rootsOut.push(node)
  }

  return rootsOut
}

/** Convert a roles-mode forest into a participants-mode forest.
 *
 *  Rule (from the planning doc):
 *  - Each role node is replaced with its members.
 *  - Members of a role become siblings at that role's depth.
 *  - Children of a role (sub-roles) attach under the FIRST member of
 *    the parent role (single-parent constraint of trees). User can
 *    manually adjust which specific member parents which child after.
 *
 *  Participants whose role is in the tree get placed accordingly.
 *  Participants with no role, or with a role that doesn't appear in
 *  the role tree, are NOT placed by this conversion — auto-include
 *  in participants mode will surface them as orphans.
 *
 *  `participantRoles` is the same `participant_roles` dict used above. */
export function rolesToParticipants(rolesRoots, participantRoles) {
  // Group entities by role for fast lookup.
  const membersByRole = new Map()  // roleValue -> entityId[]
  for (const [entityId, role] of Object.entries(participantRoles || {})) {
    const r = role?.value
    if (!r) continue
    if (!membersByRole.has(r)) membersByRole.set(r, [])
    membersByRole.get(r).push(entityId)
  }

  function buildBranch(roleNode) {
    // Returns participant nodes representing this role's contribution to the tree.
    const members = (membersByRole.get(roleNode.id) || []).slice()
    const memberNodes = members.map((eid) => ({ id: eid, children: [] }))

    // Walk children roles and gather their participant-node branches.
    const childBranches = []
    for (const childRole of (roleNode.children || [])) {
      const branch = buildBranch(childRole)
      childBranches.push(...branch)
    }

    if (memberNodes.length > 0) {
      // Attach all child branches under the FIRST member node.
      memberNodes[0].children.push(...childBranches)
      return memberNodes
    }
    // No members in this role — its child branches bubble up to be siblings here.
    return childBranches
  }

  const out = []
  for (const root of (rolesRoots || [])) {
    out.push(...buildBranch(root))
  }
  return out
}
