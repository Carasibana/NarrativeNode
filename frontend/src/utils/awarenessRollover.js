/**
 * Awareness-rollover modal helpers — gate detection + page builder.
 *
 * The modal fires when a chain-anchor commit lands on a value whose
 * own awareness layer has tracking on at the anchor and has at least
 * one observer in the resolved entries. The writer can then adjust
 * those observers' levels for the value transition.
 *
 * Gating is universal — any field with an awareness layer is eligible;
 * no per-surface allowlist. Each value-commit setter calls
 * `buildRolloverPage` after committing; null return means "don't fire
 * a page for this commit". The caller accumulates non-null pages from
 * a multi-field commit and opens one modal carousel.
 */

import { computeEffectiveState } from './narrativeChain'
import { readEffectiveAwarenessForTarget } from './awarenessCommit'

/**
 * Read the resolved entries (flat dict of `{observerId: level}`) from a
 * walker-emitted wrapper, handling both the wrapper shape
 * `{entries, sources, history}` and the legacy flat-dict shape.
 */
function entriesOf(wrapper) {
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return {}
  if (Object.prototype.hasOwnProperty.call(wrapper, 'entries')) return wrapper.entries || {}
  return wrapper
}

/**
 * Build a rollover-modal page descriptor for a single field commit, or
 * return null when the commit shouldn't trigger a page.
 *
 * Args:
 *   entity        — the host entity (or relationship / knowledge object)
 *                   whose value is being changed. For relationship and
 *                   knowledge surfaces, pass the resolved object.
 *   target        — awareness target descriptor:
 *                   { kind: 'entity_name', entityId }
 *                   { kind: 'attribute', entityId, attributeId }
 *                   { kind: 'alias', entityId, aliasValue }
 *                   { kind: 'relationship', relationshipId }
 *                   { kind: 'knowledge', knowledgeId }
 *   anchor        — { kind: 'chain', nodeId } (origin commits don't fire pages)
 *   fieldLabel    — user-facing label for the modal title (e.g. "Name",
 *                   "Title (attribute)", "Alias 'Ali'")
 *   ctx           — { nodes, edges, allEntities, allRelationships, storyOrder }
 *                   passed to computeEffectiveState for proper chain
 *                   walking. storyOrder is required for awareness.history
 *                   resolution.
 *   storyEnabled  — boolean from story settings (`awareness_rollover_check_enabled`).
 *                   When false, the function returns null immediately.
 *
 * Returns:
 *   { fieldLabel, target, anchor, priorWrapper, draft } | null
 */
export function buildRolloverPage({ entity, target, anchor, fieldLabel, oldValue, newValue, ctx, storyEnabled }) {
  if (storyEnabled === false) return null
  if (!entity || !target || !anchor) return null
  if (anchor.kind !== 'chain' || !anchor.nodeId) return null

  // Walk entity to anchor — read the awareness wrapper for the target.
  // Entity-bound targets use the standard walker; other surfaces (rel /
  // knowledge) need their own walkers but the immediate ToDo scope is
  // entity-bound, so route those through later.
  const isEntityBound = target.kind === 'entity_name' || target.kind === 'attribute' || target.kind === 'alias' || target.kind === 'entity'
  if (!isEntityBound) return null  // relationship / knowledge surfaces wired separately

  const eff = computeEffectiveState(entity, ctx.nodes, ctx.edges, anchor.nodeId, ctx)
  const priorWrapper = readEffectiveAwarenessForTarget(eff, target)
  if (priorWrapper == null) return null  // tracking off at anchor

  const entries = entriesOf(priorWrapper)
  if (Object.keys(entries).length === 0) return null  // no observers

  return {
    fieldLabel: fieldLabel || target.kind,
    target,
    anchor,
    priorWrapper,
    draft: priorWrapper,  // initial draft = current wrapper (no change)
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
  }
}
