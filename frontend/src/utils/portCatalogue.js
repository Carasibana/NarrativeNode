/**
 * Central port catalogue for Phase 1.20 drag-time transitions.
 *
 * Single source of truth for:
 *   - Payload-type derivation per source handle (what kind of wire is this drag?)
 *   - Accept rules per target handle (will this port receive that payload?)
 *   - Reject reason reporting (tooltip wording when a guard blocks a drop)
 *   - Drag-time tooltip wording per source -> target combination
 *
 * Scope (per Phase 1.20 ToDo): accept rules + tooltip wording only. No shape
 * or fill assignment here -- the static port shape vocabulary is parked per
 * the planning doc's scope narrowing.
 *
 * Central-registry design: every canvas node type that carries handles
 * declares its ports once in NODE_RESOLVERS below. Unregistered node types
 * fall through to null -- their ports are treated as "unknown semantics" and
 * no drag-time halo or tooltip fires on them. New node types must be
 * registered here explicitly before drag-time feedback will work.
 */

// ──────────────────────────────────────────────────────────────────────────
// Payload types
// ──────────────────────────────────────────────────────────────────────────

export const PAYLOAD = Object.freeze({
  NARRATIVE_FLOW: 'narrativeFlow',
  POV: 'pov',
  REL_JOIN: 'relationshipJoin',
  BROADCAST: 'broadcast',
  // Phase 1.21c Step 14 follow-up: a wire dragged out of a
  // <KnowledgeOriginNode>'s output port. Action-only (not persisted as an
  // edge) — the wire creation is itself the awareness-grant write to the
  // Knowledge's awareness dict / history.
  KNOWLEDGE_AWARENESS_GRANT: 'knowledgeAwarenessGrant',
  // Phase 8.1 (§8.1.2) , concept-wire payload. Emitted + accepted ONLY by
  // concept ports on referenceNode / genericGroupNode; no narrative port
  // accepts it, so the concept graph is a closed world by construction.
  CONCEPT: 'concept',
})

// ──────────────────────────────────────────────────────────────────────────
// Per-node-type resolvers
// ──────────────────────────────────────────────────────────────────────────
//
// A resolver takes { handleId, direction } and returns a PortDescriptor:
//
//   {
//     direction:    'source' | 'target',
//     payload?:     string, // source ports only -- what payload type this emits
//     accepts?:     string[], // target ports only -- payload types this can receive
//     persistence?: 'persistent' | 'action-only' | 'mixed',
//     kind:         string, // stable key used by describeAction to branch
//   }
//
// Returns null for an unknown handle id on a known node type (treated as
// non-accepting / non-emitting; no drag-time feedback).

const NODE_RESOLVERS = {
  sceneNode(handleId, direction) {
    if (direction === 'source') {
      if (handleId === 'broadcast') {
        return { direction, payload: PAYLOAD.BROADCAST, kind: 'broadcast' }
      }
      if (handleId === 'pov-out') {
        return { direction, payload: PAYLOAD.POV, kind: 'pov-out' }
      }
      // Phase 1.21c — Knowledge chip output port. Action-only awareness-
      // grant emitter. Mirrors `<KnowledgeOriginNode>` output exactly;
      // both port descriptors emit `KNOWLEDGE_AWARENESS_GRANT` and the
      // onConnect handler resolves them through a single branch.
      if (handleId && handleId.startsWith('knowledge-chip-out-')) {
        return {
          direction,
          payload: PAYLOAD.KNOWLEDGE_AWARENESS_GRANT,
          persistence: 'action-only',
          kind: 'knowledge-chip-out',
        }
      }
      if (handleId && !handleId.startsWith('chip-in-') && !handleId.startsWith('rel-in-') && handleId !== 'pov-in') {
        // Chip-out handle ids are raw entity ids (no prefix). Any source
        // handle that isn't one of the named special cases is a chip-out.
        return { direction, payload: PAYLOAD.NARRATIVE_FLOW, kind: 'chip-out' }
      }
      return null
    }
    // direction === 'target'
    if (!handleId) {
      // POV drops onto any scene target (except rel-in) succeed as
      // branch-A POV attaches -- onConnect re-targets the new povEdge at
      // pov-in regardless of where the user dropped.
      // Phase 1.21c — Knowledge awareness-grant drops onto a scene's
      // general-in handle resolve to a manual-anchor at that scene.
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW, PAYLOAD.BROADCAST, PAYLOAD.POV, PAYLOAD.KNOWLEDGE_AWARENESS_GRANT],
        persistence: 'persistent',
        kind: 'flow-in',
      }
    }
    if (handleId === 'pov-in') {
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW, PAYLOAD.POV],
        persistence: 'persistent',
        kind: 'pov-in',
      }
    }
    if (handleId.startsWith('chip-in-')) {
      // Broadcast source is explicitly rejected at the chip-in handle --
      // onConnect's broadcast branch only permits null targetHandle (the
      // scene's generic flow-in). Any specific chip-in / rel-in / pov-in
      // drop during a broadcast drag is a silent no-op.
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW, PAYLOAD.POV, PAYLOAD.KNOWLEDGE_AWARENESS_GRANT],
        persistence: 'persistent',
        kind: 'chip-in',
      }
    }
    if (handleId.startsWith('rel-in-')) {
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW],
        persistence: 'action-only',
        kind: 'rel-in-scene',
      }
    }
    return null
  },

  entityNode(handleId, direction) {
    if (direction === 'source') {
      if (!handleId) {
        return { direction, payload: PAYLOAD.NARRATIVE_FLOW, kind: 'entity-out' }
      }
      return null
    }
    if (!handleId) {
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW, PAYLOAD.KNOWLEDGE_AWARENESS_GRANT],
        persistence: 'persistent',
        kind: 'entity-in',
      }
    }
    if (handleId.startsWith('rel-in-')) {
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW],
        persistence: 'persistent',
        kind: 'rel-in-entity',
      }
    }
    return null
  },

  relationshipOriginNode(handleId, direction) {
    if (direction === 'target' && !handleId) {
      return {
        direction,
        accepts: [PAYLOAD.NARRATIVE_FLOW],
        persistence: 'persistent',
        kind: 'rel-origin-in',
      }
    }
    return null
  },

  knowledgeOriginNode(handleId, direction) {
    // Phase 1.21c Step 14 follow-up. Source-only port: dragged wires
    // emit KNOWLEDGE_AWARENESS_GRANT and are consumed at onConnect time
    // (not persisted as edges). Knowledges aren't created by other
    // narrative objects via wires, so there's no input port descriptor.
    if (direction === 'source' && !handleId) {
      return {
        direction,
        payload: PAYLOAD.KNOWLEDGE_AWARENESS_GRANT,
        persistence: 'action-only',
        kind: 'knowledge-origin-out',
      }
    }
    return null
  },

  povOriginNode(handleId, direction) {
    if (direction === 'source' && handleId === 'pov-out') {
      return { direction, payload: PAYLOAD.POV, kind: 'pov-out-origin' }
    }
    return null
  },

  // Phase 8.1 (§8.1.3) , concept ports on a concept-subtype reference node.
  // Data-agnostic: every `concept-*` handle is a universal concept connector
  // (valid as both source AND target); it emits/accepts ONLY CONCEPT. Only
  // concept nodes actually render these handles, so this is consulted for
  // them alone in practice. No narrative port accepts CONCEPT, so concept
  // <-> narrative drops reject by construction (via handleIsValidConnection).
  referenceNode(handleId, direction) {
    if (handleId && handleId.startsWith('concept-')) {
      if (direction === 'source') {
        return { direction, payload: PAYLOAD.CONCEPT, kind: 'concept-port' }
      }
      return { direction, accepts: [PAYLOAD.CONCEPT], persistence: 'persistent', kind: 'concept-port' }
    }
    return null
  },

  // Phase 8.1 (§8.1.5) , concept ports are latent on every generic group;
  // same universal-connector behaviour as the concept-node ports.
  genericGroupNode(handleId, direction) {
    if (handleId && handleId.startsWith('concept-')) {
      if (direction === 'source') {
        return { direction, payload: PAYLOAD.CONCEPT, kind: 'concept-port' }
      }
      return { direction, accepts: [PAYLOAD.CONCEPT], persistence: 'persistent', kind: 'concept-port' }
    }
    return null
  },
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the port descriptor for a given node-type + handle-id + direction.
 * Returns null when the node type is not registered or the handle is not
 * recognised on that node type.
 */
export function resolvePort({ nodeType, handleId, direction }) {
  const resolver = NODE_RESOLVERS[nodeType]
  if (!resolver) return null
  if (direction !== 'source' && direction !== 'target') return null
  return resolver(handleId ?? null, direction)
}

/**
 * Derive the payload type of an in-flight drag given its source port.
 * Returns one of the PAYLOAD.* constants, or null if the source port is
 * unregistered or is not a source at all.
 */
export function derivePayloadType({ sourceNodeType, sourceHandleId }) {
  const port = resolvePort({
    nodeType: sourceNodeType,
    handleId: sourceHandleId,
    direction: 'source',
  })
  return port?.payload ?? null
}

/**
 * Would the given target port accept a drag of the given payload type?
 * Pure lookup against the catalogue; does NOT consult runtime guards
 * (cycle / pov-loop / story-order) -- those are layered separately in the
 * drag-time halo component via describeRejectReason().
 */
export function accepts({ targetNodeType, targetHandleId, payloadType }) {
  if (!payloadType) return false
  const port = resolvePort({
    nodeType: targetNodeType,
    handleId: targetHandleId,
    direction: 'target',
  })
  if (!port?.accepts) return false
  return port.accepts.includes(payloadType)
}

/**
 * Describe the action that will fire if the user releases the current drag
 * on the given target. Returns a short human-readable string suitable for a
 * hover tooltip, or null for combinations that silently drop.
 *
 * The context object carries the names and situational flags the wording
 * needs; callers resolve these via the existing entity / scene lookups
 * (IdentityBadges / entitiesStore) and pass them in. The catalogue stays
 * id-only -- same rule as utils/storyOrder.js.
 *
 * context fields (all optional unless noted):
 *   entityName         -- source entity name (for entity / chip sources)
 *   targetEntityName   -- entity name owning the target chip (chip-in targets)
 *   sceneTitle         -- target scene title (sceneNode targets)
 *   sourceSceneTitle   -- source scene title (sceneNode sources)
 *   relLabel           -- relationship label (rel-in targets)
 *   isCharacter        -- source entity is a character (affects pov-in branch)
 *   isSameEntity       -- source entity id === target chip entity id
 *   isSameScene        -- source node id === target node id
 *   isFlashbackTarget  -- target sceneNode has is_flashback=true
 *   isEntityOrigin     -- source entityNode is an origin (not a modifier)
 *   isFactionRel       -- rel-in target is on an entityNode (faction membership)
 *   blockedBy          -- null | 'cycle' | 'pov-loop' | 'story-order'
 */
export function describeAction({ source, target, context = {} }) {
  if (context.blockedBy) return describeRejectReason(context.blockedBy)

  const src = resolvePort({ nodeType: source.nodeType, handleId: source.handleId, direction: 'source' })
  const tgt = resolvePort({ nodeType: target.nodeType, handleId: target.handleId, direction: 'target' })
  if (!src || !tgt) return null
  if (!accepts({ targetNodeType: target.nodeType, targetHandleId: target.handleId, payloadType: src.payload })) {
    return null
  }

  const entityName = context.entityName || 'entity'
  const sceneTitle = context.sceneTitle || 'scene'
  const sourceSceneTitle = context.sourceSceneTitle || 'scene'
  const relLabel = context.relLabel || 'relationship'

  // POV source branches (branch A). Any scene target except rel-in routes
  // through the POV attach handler in onConnect.
  if (src.payload === PAYLOAD.POV) {
    if (target.nodeType === 'sceneNode' && tgt.kind !== 'rel-in-scene') {
      return `Attach POV chain to ${sceneTitle}`
    }
    return null
  }

  // Broadcast source branches
  if (src.kind === 'broadcast') {
    if (context.isFlashbackTarget) {
      // Branch B: broadcast -> flashback scene
      return `Mark ${sceneTitle} as flashback of ${sourceSceneTitle}`
    }
    // Branch C: broadcast -> regular scene
    return `Broadcast all entities from ${sourceSceneTitle} to ${sceneTitle}`
  }

  // Narrative-flow source branches (entity-out / chip-out)
  // Target: relationship origin (Branch D)
  if (tgt.kind === 'rel-origin-in') {
    if (src.kind === 'entity-out' && context.isEntityOrigin) {
      return `Add ${entityName} as participant (at relationship origin)`
    }
    return null // silent drop: only entity origins wire into rel-origin
  }

  // Target: rel-in on entityNode (faction membership, Branch M')
  if (tgt.kind === 'rel-in-entity') {
    return `Add ${entityName} as faction member`
  }

  // Target: rel-in on sceneNode (action-only, Branch M)
  if (tgt.kind === 'rel-in-scene') {
    return `Add ${entityName} as participant in ${relLabel}`
  }

  // Target: entityNode unnamed in
  if (tgt.kind === 'entity-in') {
    // Modifier target: the action differs depending on whether the
    // modifier already has an entity assigned.
    //   - blank modifier -> the drop BECOMES the modifier's entity
    //     (modifier gains its entity identity from this wire).
    //   - same-entity modifier -> purely chain-forward wiring.
    if (context.isTargetModifier) {
      if (context.isTargetModifierBlank) {
        return `Turns this node into a modifier for ${entityName}`
      }
      return `Wire ${entityName} through this modifier`
    }
    if (src.kind === 'entity-out') {
      // Origin -> origin (different entities) creates a relationship (branch E).
      return `Create relationship between ${entityName} and ${context.targetEntityName || 'entity'}`
    }
    // Chip-out -> entityNode origin -> silent drop (Branch K)
    return null
  }

  // Target: chip-in on sceneNode (Branches F / G / I / J)
  if (tgt.kind === 'chip-in') {
    if (context.isSameEntity) {
      // Branches G / I -- same-entity wire across scenes (orphan resolution).
      return `Wire ${entityName} into ${sceneTitle}`
    }
    // Branches F / J -- cross-entity drop creates a relationship. When the
    // source entity is ALREADY in the target scene we only create the
    // relationship; no chip is added. Wording shifts to match.
    if (context.isSourceEntityInTargetScene) {
      const targetEntityName = context.targetEntityName || 'entity'
      return `Create relationship between ${entityName} and ${targetEntityName} at ${sceneTitle}`
    }
    return `Create relationship + add ${entityName} to ${sceneTitle}`
  }

  // Target: pov-in on sceneNode (Branch L -- non-POV source)
  if (tgt.kind === 'pov-in') {
    // If the source entity is already in the target scene, this drop only
    // attaches POV (for characters) or is a no-op (non-characters); nothing
    // gets "added" to the scene.
    if (context.isSourceEntityInTargetScene) {
      if (context.isCharacter) return `Attach POV to ${entityName}`
      return null
    }
    if (context.isCharacter) {
      return `Add ${entityName} to ${sceneTitle} and attach POV`
    }
    return `Add ${entityName} to ${sceneTitle}`
  }

  // Target: flow-in on sceneNode (Branch P -- generic fallthrough)
  if (tgt.kind === 'flow-in') {
    // Same-scene chip-to-chip (Branch H) is routed via chip-in / flow-in
    // depending on how the user drags; the same-scene chip-to-chip rel
    // creation path is caught by the chip-in branch above when the target
    // handle is a chip. When same-scene drags land on flow-in there is no
    // cross-entity rel semantic -- treat as a flow wire.
    return `Wire ${entityName} into ${sceneTitle}`
  }

  return null
}

/**
 * Wording for drag-time reject feedback when a normally-accepting port is
 * blocked by a runtime guard. The halo component invokes this when its
 * accept() check returns true but a guard (cycle / pov-loop / story-order)
 * would reject the drop.
 */
export function describeRejectReason(blockedBy) {
  if (blockedBy === 'cycle') return 'Cannot: would create a narrative-flow cycle'
  if (blockedBy === 'pov-loop') return 'Cannot: would create a loop in the POV chain'
  if (blockedBy === 'story-order') return 'Cannot: would contradict POV or entity-chain order'
  return null
}

/**
 * Same-node self-loop detection. Given an in-flight drag's source port and
 * a candidate target port on the SAME node, returns true when the drop
 * would be a self-loop that should be rejected:
 *
 *   - chip-out -> chip-in of the same entity
 *   - chip-out -> flow-in / pov-in (would cycle the scene on itself)
 *   - broadcast -> any target on the same scene
 *   - entity-out -> same entityNode's default in
 *   - entity-out -> rel-in on the same entityNode (self-faction)
 *
 * Valid same-node targets (NOT self-loops) returned false:
 *   - chip-out -> chip-in of a different entity (Case 3 cross-entity rel)
 *   - chip-out -> rel-in on the same scene (branch M participant add)
 *   - pov-out -> anything on the same scene (Issue 2 POV reassignment)
 */
export function isSameNodeSelfLoop({ sourceNodeType, sourceHandleId, targetNodeType, targetHandleId }) {
  const src = resolvePort({ nodeType: sourceNodeType, handleId: sourceHandleId ?? null, direction: 'source' })
  const tgt = resolvePort({ nodeType: targetNodeType, handleId: targetHandleId ?? null, direction: 'target' })
  if (!src || !tgt) return false

  // Phase 8.1 , a concept port never wires to another port on the SAME node
  // (the caller has already established source and target share a node).
  // Concept nodes / groups render only concept-* handles, so a concept source
  // here implies a concept target.
  if (src.kind === 'concept-port') return true

  // POV source: any same-scene target is a valid reassignment, never a self-loop.
  if (src.kind === 'pov-out' || src.kind === 'pov-out-origin') return false

  if (src.kind === 'chip-out' && tgt.kind === 'chip-in') {
    return targetHandleId.slice(8) === sourceHandleId
  }
  if (src.kind === 'chip-out' && (tgt.kind === 'flow-in' || tgt.kind === 'pov-in')) return true
  if (src.kind === 'chip-out' && tgt.kind === 'rel-in-scene') return false
  if (src.kind === 'broadcast') return true
  if (src.kind === 'entity-out' && tgt.kind === 'entity-in') return true
  if (src.kind === 'entity-out' && tgt.kind === 'rel-in-entity') return true

  return false
}

/**
 * Utility exported for tests / DevPreview: enumerate every (nodeType,
 * handleId, direction) triple the catalogue recognises by kind. The
 * port-wrapper component does NOT use this -- it calls resolvePort at
 * render time with its own handle id. This is purely a diagnostic aid.
 */
export const KNOWN_PORT_KINDS = Object.freeze([
  'broadcast',
  'pov-out',
  'pov-out-origin',
  'chip-out',
  'entity-out',
  'flow-in',
  'pov-in',
  'chip-in',
  'rel-in-scene',
  'entity-in',
  'rel-in-entity',
  'rel-origin-in',
])
