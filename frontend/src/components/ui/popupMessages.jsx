/**
 * Central repository of confirm-dialog message builders. Every popup
 * dispatched via `confirm()` (from the dialog store) lands its message
 * body via one of the `buildXxxMessage()` exports below.
 *
 * Convention: one exported `buildXxxMessage()` function per popup. The
 * function returns the JSX node that becomes the dialog's `message`
 * prop. Identity references (entities, relationships, knowledges, nodes)
 * use the shared badge components from `IdentityBadges.jsx` so popups
 * read consistently with the rest of the UI.
 *
 * Adding a new popup: write a new builder here, render it via
 * `confirm({ message: buildXxxMessage(...) })`, and add a catalogue
 * entry to `PopupCatalogue` in `DevPreviewPanel.jsx` so the visual is
 * exercisable without needing to recreate the in-app trigger.
 */

import {
  RelationshipLabelChip,
  KnowledgeLabelChip,
  EntityAvatarName,
  NodeBadge,
  ParticipantsFallbackLabel,
  RelationshipBirthBadge,
} from './IdentityBadges'

/** Internal helper — wraps a badge + trailing punctuation as one flex
 *  child so the punctuation can't wrap alone. */
function BadgeWithTrailing({ children, trailing }) {
  return (
    <span className="inline-flex items-center gap-0">
      {children}
      <span className="text-zinc-300">{trailing}</span>
    </span>
  )
}

/** Internal helper — renders a relationship's label chip, pulling in the
 *  participants fallback (with aliases) when the rel has no custom name.
 *  `resolveName` forwards through to `<ParticipantsFallbackLabel>` so
 *  callers that have chain context can feed chain-resolved names. */
function RelChip({ rel, getEntity, resolveName = null }) {
  const joinIds = Array.from(new Set(
    (rel?.history?.participant_changes || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id)
  ))
  return (
    <RelationshipLabelChip name={rel?.name || 'Relationship'}>
      {rel?.name || (
        joinIds.length > 0
          ? <ParticipantsFallbackLabel
              participants={joinIds.map((id) => ({ entity_id: id }))}
              getEntity={getEntity}
              sliceMax={3}
              rel={rel}
              resolveName={resolveName}
            />
          : '(no participants)'
      )}
    </RelationshipLabelChip>
  )
}

/**
 * "Delete knowledge" confirm-dialog body. Scope: Knowledge being erased
 * from the entire story. Renders the Knowledge's name in a parchment-tan
 * chip so it reads consistently with other identity references.
 * Args: { knowledge }
 */
export function buildDeleteKnowledgeMessage({ knowledge }) {
  const name = knowledge?.name || 'this knowledge'
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-zinc-300">Delete</span>
      <BadgeWithTrailing trailing="?">
        <KnowledgeLabelChip name={name} />
      </BadgeWithTrailing>
      <span className="text-zinc-300">This cannot be undone.</span>
    </div>
  )
}

/**
 * "Delete relationship" confirm-dialog body. Scope: relationship being
 * erased from the entire story (not ended at a scene).
 * Args: { rel, getEntity }
 */
export function buildDeleteRelationshipMessage({ rel, getEntity, resolveName = null }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-zinc-300">Delete</span>
      <BadgeWithTrailing trailing="?">
        <RelChip rel={rel} getEntity={getEntity} resolveName={resolveName} />
      </BadgeWithTrailing>
      <span className="text-zinc-300">This removes it from the entire story.</span>
    </div>
  )
}

/**
 * "End relationship" confirm-dialog body — unified across callsites. The
 * end point is identified via `NodeBadge` so scene OR modifier-node end
 * points both render with correct treatment (scene title for scenes,
 * `MODIFIER : Name` for modifiers, etc.).
 * Args: { rel, getEntity, endNodeId, nodes, entityMap }
 */
export function buildEndRelationshipMessage({ rel, getEntity, endNodeId, nodes, entityMap, resolveName = null }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-zinc-300">End</span>
      <RelChip rel={rel} getEntity={getEntity} resolveName={resolveName} />
      <span className="text-zinc-300">at</span>
      <BadgeWithTrailing trailing="?">
        <NodeBadge nodeId={endNodeId} nodes={nodes} entityMap={entityMap} />
      </BadgeWithTrailing>
      <span className="text-zinc-300">The relationship remains in earlier scenes but ends from that point forward.</span>
    </div>
  )
}

/**
 * "Leave relationship" confirm-dialog body — participant leaving the rel
 * at a specific chain position. Entity rendered via `EntityAvatarName`
 * with optional alias suffix; node end point via `NodeBadge`.
 * Args: { entity, aliasOverride, rel, getEntity, leavingAtNodeId, nodes, entityMap }
 */
export function buildLeaveRelationshipMessage({ entity, aliasOverride, rel, getEntity, leavingAtNodeId, nodes, entityMap }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-zinc-300">Remove</span>
      {entity
        ? <EntityAvatarName entity={entity} aliasOverride={aliasOverride || null} />
        : <span className="text-zinc-300">this entity</span>}
      <span className="text-zinc-300">from</span>
      <RelChip rel={rel} getEntity={getEntity} />
      <span className="text-zinc-300">at</span>
      <BadgeWithTrailing trailing="?">
        <NodeBadge nodeId={leavingAtNodeId} nodes={nodes} entityMap={entityMap} />
      </BadgeWithTrailing>
      <span className="text-zinc-300">They will no longer be a participant from here forward.</span>
    </div>
  )
}

/**
 * "Remove last participant — cascade-delete warning" confirm-dialog body.
 * Args: { entity, rel, getEntity }
 */
export function buildRemoveLastParticipantMessage({ entity, rel, getEntity }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {entity
        ? <EntityAvatarName entity={entity} />
        : <span className="text-zinc-300">This participant</span>}
      <span className="text-zinc-300">is the last participant in</span>
      <BadgeWithTrailing trailing=".">
        <RelChip rel={rel} getEntity={getEntity} />
      </BadgeWithTrailing>
      <span className="text-zinc-300">Removing them will delete the entire relationship from the story.</span>
    </div>
  )
}

/**
 * "Connect to upstream source" confirm-dialog body. Describes which
 * entity is being carried forward, which node is the found source, and
 * which node will be wired. Built here so the store file can stay .js.
 * Args: { entity, sourceNodeId, targetNodeId, nodes, entityMap }
 */
export function buildUpstreamConnectMessage({ entity, sourceNodeId, targetNodeId, nodes, entityMap }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-zinc-300">Found upstream source for</span>
        {entity
          ? <EntityAvatarName entity={entity} />
          : <span className="text-zinc-300">this entity</span>}
        <span className="text-zinc-300">:</span>
        <NodeBadge nodeId={sourceNodeId} nodes={nodes} entityMap={entityMap} />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-zinc-300">Connect it to</span>
        <BadgeWithTrailing trailing="?">
          <NodeBadge nodeId={targetNodeId} nodes={nodes} entityMap={entityMap} />
        </BadgeWithTrailing>
      </div>
      <div className="text-[11px] text-zinc-500">Confirming will create a wire carrying this entity forward.</div>
    </div>
  )
}

/**
 * Rejection-dialog body for the Phase 1.19 tier-1/2 block rule. Fires when a
 * narrative-flow wire would contradict an ordering already established by the
 * POV chain (tier 1) or a connected entity chain (tier 2). Identifies source
 * and target scenes with NodeBadge so the user can see exactly which pair
 * triggered the block.
 *
 * Args: { sourceNodeId, targetNodeId, nodes, entityMap }
 */
export function buildContradictStoryOrderMessage({ sourceNodeId, targetNodeId, nodes, entityMap }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-zinc-300">Cannot create this wire:</span>
        <NodeBadge nodeId={sourceNodeId} nodes={nodes} entityMap={entityMap} />
        <span className="text-zinc-300">sits after</span>
        <NodeBadge nodeId={targetNodeId} nodes={nodes} entityMap={entityMap} />
        <span className="text-zinc-300">in the story order.</span>
      </div>
      <div className="text-[11px] text-zinc-500">
        This ordering is established by the POV chain or a connected entity chain. Wiring against it would contradict a declaration you already made. Adjust the POV chain or the entity chain first, then try again.
      </div>
    </div>
  )
}


/** Compose the duplicate-relationship confirm-dialog message.
 *
 *  - participants: array of { entity, aliasOverride, onClick } — onClick
 *    fires when the user clicks that entity's avatar+name; typically
 *    closes the dialog and opens the entity detail panel at the chain
 *    point where the conflict was detected.
 *  - match:
 *      kind:              'exact' | 'superset'
 *      existingLabel:     plain-string display name of the detected rel (for tooltip / scene-birth fallback)
 *      existingRel:       the conflicting relationship object (used for alias resolution)
 *      getEntity:         (id) => entity | undefined
 *      joinEntityIds:     unique entity ids of current join events in the rel (for the fallback label)
 *      birth:             { kind: 'origin' | 'scene', label } | null
 *      onClickRelationship: handler for the rel badge (navigates to rel detail)
 *      onClickBirth:        handler for the birth badge (focuses + opens birth node)
 *  - hasAliases: bool — show the alias-tip hint when true.
 */
export function buildDuplicateRelMessage({ participants, match, hasAliases }) {
  // Flatten participants + "and" separators into siblings of the outer
  // `flex items-center` so every piece lands on the same vertical centre
  // line. Wrapping each participant in its own span would carry the raw
  // "and" text on a lower baseline than the avatar-centred names.
  const entityList = participants.flatMap((p, i) => {
    const nodes = [
      <EntityAvatarName
        key={p.entity.id + ':name'}
        entity={p.entity}
        aliasOverride={p.aliasOverride}
        onClick={p.onClick}
      />,
    ]
    if (i < participants.length - 1) {
      nodes.push(
        <span key={p.entity.id + ':and'} className="text-zinc-300">and</span>
      )
    }
    return nodes
  })

  // Rel badge content: custom rel name when set, otherwise the JSX
  // participants-fallback label (italic `as {alias}` for each participant
  // who carries one in this rel).
  const relLabelNode = match.existingRel?.name
    ? match.existingRel.name
    : (
      <ParticipantsFallbackLabel
        participants={(match.joinEntityIds || []).map((id) => ({ entity_id: id }))}
        getEntity={match.getEntity}
        sliceMax={3}
        rel={match.existingRel}
        resolveName={match.resolveName || null}
      />
    )
  const relBadge = (
    <RelationshipLabelChip name={match.existingLabel} onClick={match.onClickRelationship}>
      {relLabelNode}
    </RelationshipLabelChip>
  )

  // Birth badge: for origin variant, render the same rel label (name or
  // participants fallback). For scene variant, use the scene title as-is.
  let birthBadge = null
  if (match.birth) {
    const birthLabelNode = match.birth.kind === 'origin' ? relLabelNode : match.birth.label
    birthBadge = (
      <RelationshipBirthBadge
        kind={match.birth.kind}
        label={match.birth.label}
        labelNode={birthLabelNode}
        onClick={match.onClickBirth}
      />
    )
  }

  const leadLine = match.kind === 'exact' ? (
    <>
      {entityList}
      <span className="text-zinc-300">already have a relationship</span>
      {relBadge}
      <span className="text-zinc-300">together</span>
    </>
  ) : (
    <>
      {entityList}
      <span className="text-zinc-300">are already participants in</span>
      {relBadge}
      <span className="text-zinc-300">together (along with others)</span>
    </>
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {leadLine}
        {birthBadge && (
          <>
            <span className="text-zinc-300">that started at</span>
            {birthBadge}
          </>
        )}
        <span className="text-zinc-300">.</span>
      </div>
      <div className="text-zinc-300">
        {match.kind === 'exact'
          ? 'Create a separate relationship between them anyway?'
          : 'Create a separate, narrower relationship between just them?'}
      </div>
      {hasAliases && (
        <div className="text-[10px] text-zinc-500 italic">
          Tip: you can change which alias an entity appears as in the new relationship from the Detail Panel after creation.
        </div>
      )}
    </div>
  )
}

/**
 * "You have unsaved changes" confirm-dialog body — fires when the user
 * tries to navigate away from a Detail Panel subject while a draft is
 * pending (the panel-shell-level draft introduced for the Detail Panel
 * shell refactor; previously the entity Detail Panel's local draft).
 *
 * Three buttons: Confirm-and-continue (commit then navigate), Discard-
 * and-continue (drop the draft, navigate), Cancel (stay).
 *
 * Body has no entity / relationship / scene context — it's just the
 * generic "you have unsaved work" prompt. Kept here for catalogue parity
 * even though it's plain text; future variations (per-subject summaries,
 * counts of changed fields, etc.) can layer on without touching the
 * call sites.
 */
export function buildUnsavedChangesMessage() {
  return 'You have unsaved changes in this Detail Panel. Discard and continue?'
}
