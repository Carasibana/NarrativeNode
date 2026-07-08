/**
 * Phase 2.7c — strict no-overlap with merge + confirmation dialog.
 *
 * The pinned-context modal is a DRAFT surface: the writer makes their
 * selection without anything mutating, clicks Confirm, the program
 * analyses the consequences across the entire draft selection (every
 * new pin in one pass), shows ONE summary dialog if any overlap exists,
 * and only on Confirm of that dialog does anything actually change.
 * Cancel returns to the modal with the draft intact.
 *
 * This file ships three pure-ish helpers + one orchestrator:
 *
 *   analyzeCommitConsequences(newPins, focusedSessionId)
 *     → {
 *         groups: [{ newPin, overlappers, mergedPin, isRedundant }, ...],
 *         hasOverlap,
 *         isPureNoOp,        // every new pin is fully covered by some existing entry
 *         totalToDrop,       // count of distinct existing entries that would be removed
 *       }
 *     Pure: reads ui + project stores, returns structure, NO mutations.
 *
 *   formatConsequencesMessage(consequences)
 *     → string (multi-line, ready for the dialogStore `message` field).
 *
 *   applyConsequences(consequences, focusedSessionId)
 *     → void. Atomic: removes focused + every overlapping existing entry,
 *     adds every new/merged pin. Call only after the writer has
 *     confirmed (or when `hasOverlap` is false and no dialog is needed).
 *
 *   confirmAndApplyAnchoredCommit(newPins, focusedSessionId)
 *     → Promise<{ committed, cancelled, isPureNoOp }>. Orchestrator for
 *     the simple case (used by non-modal anchored-add surfaces like
 *     `AttachToChatButton`): analyzes, shows the dialog if needed,
 *     applies on confirm. The modal does NOT use this orchestrator —
 *     it calls analyze + format + apply directly so it can keep the
 *     modal open on cancel.
 *
 * Dynamic pins (no anchor fields) are EXEMPT from the merge rule per
 * the Phase 2.7c spec. Callers should NOT route dynamic adds through
 * here — they should call `usePinnedContextStore.getState().addPin(...)`
 * directly. As a safety net, the orchestrator no-ops cleanly if it's
 * ever passed a dynamic pin (just falls through to a direct add).
 *
 * Phase 2.10b bug 1 refactor: every public function now takes a
 * `surfaceKey` as its first argument (e.g. `'chat:<threadId>'`). The
 * internal merge / reconciliation logic is unchanged; only the data
 * source moved from `uiStore.chatPinnedContextItems` to the unified
 * `pinnedContextStore.surfaces[surfaceKey]`.
 */

import { confirm } from '../store/dialogStore'
import { usePinnedContextStore } from '../store/pinnedContextStore'
import { useProjectStore } from '../store/projectStore'
import {
  getEntityNarrativeChain,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
} from './narrativeChain'


// ── Chain + coverage resolvers ──────────────────────────────────────

function _resolveChainIds(kind, id) {
  const ps = useProjectStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []
  try {
    if (kind === 'entity') {
      const chain = getEntityNarrativeChain(id, nodes, edges) || []
      return chain.map((n) => n.id)
    }
    if (kind === 'knowledge') {
      const k = (ps.knowledges || []).find((x) => x.id === id)
      if (!k) return []
      return getKnowledgeNodeOrder(k, nodes, edges) || []
    }
    if (kind === 'relationship') {
      const r = (ps.relationships || []).find((x) => x.id === id)
      if (!r) return []
      return getRelationshipNodeOrder(r, nodes, edges) || []
    }
  } catch { /* fall through */ }
  return []
}


// Expand a pin's anchor into the set of chain ids it covers. Dynamic
// pins → empty Set.
function _coverageSet(pin, chainIds) {
  const out = new Set()
  if (!pin) return out
  if (pin.anchor_node_id) {
    out.add(pin.anchor_node_id)
    return out
  }
  if (pin.anchor_range && pin.anchor_range.start_node_id && pin.anchor_range.end_node_id) {
    const startIdx = chainIds.indexOf(pin.anchor_range.start_node_id)
    const endIdx = chainIds.indexOf(pin.anchor_range.end_node_id)
    if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
      for (let i = startIdx; i <= endIdx; i++) out.add(chainIds[i])
    }
  }
  return out
}


// Human-readable label for a chain point.
function _labelForChainPoint(nodeId, chainIds) {
  const ps = useProjectStore.getState()
  const nodes = ps.nodes || []
  const idx = chainIds.indexOf(nodeId)
  const node = nodes.find((n) => n.id === nodeId)
  if (idx === 0) return 'the initial state'
  if (node?.type === 'sceneNode') return node.data?.title ? `scene "${node.data.title}"` : `scene at position ${idx + 1}`
  if (node?.type === 'entityNode' && node?.data?.is_modifier) {
    return node.data?.title ? `the change at "${node.data.title}"` : `non-scene modifier ${idx}`
  }
  return `position ${idx + 1}`
}


// Compose a writer-facing description of a pin's coverage.
function _describePinCoverage(pin, chainIds) {
  if (pin.anchor_node_id) return `at ${_labelForChainPoint(pin.anchor_node_id, chainIds)}`
  if (pin.anchor_range) {
    const s = _labelForChainPoint(pin.anchor_range.start_node_id, chainIds)
    const e = _labelForChainPoint(pin.anchor_range.end_node_id, chainIds)
    return `from ${s} to ${e}`
  }
  return ''
}


// Build the merged-pin payload from the union of coverages. A single
// chain point → single anchor; multiple points → range from the lowest
// chain index to the highest (the chain is linear, so any union of
// overlapping coverages collapses to a contiguous range).
function _buildMergedPayload(kind, id, unionSet, chainIds) {
  const indices = []
  for (const nid of unionSet) {
    const idx = chainIds.indexOf(nid)
    if (idx >= 0) indices.push(idx)
  }
  if (indices.length === 0) return null
  indices.sort((a, b) => a - b)
  const lo = indices[0]
  const hi = indices[indices.length - 1]
  if (lo === hi) return { kind, id, anchor_node_id: chainIds[lo] }
  // `members` locks in the writer's intended scene set so a later
  // chain reorder can detect non-contiguity and auto-split this pin
  // (see `reconcileRangePinsAgainstChain` below).
  return {
    kind,
    id,
    anchor_range: {
      start_node_id: chainIds[lo],
      end_node_id: chainIds[hi],
      members: chainIds.slice(lo, hi + 1),
    },
  }
}


// ── Public API ──────────────────────────────────────────────────────

/**
 * Analyse the full consequences of a commit without mutating anything.
 *
 * `newPins`           — the pins the writer's draft commit will produce.
 *                       Dynamic pins (no anchor fields) are passed
 *                       through untouched; only anchored ones are
 *                       considered for the merge rule.
 * `focusedSessionId`  — session id of the entry the modal opened on
 *                       (null when called from a non-modal surface).
 *                       The focused entry is treated as "not yet present"
 *                       during overlap analysis — the modal logically
 *                       replaces it on commit, so its own coverage
 *                       shouldn't count as overlap with itself.
 *
 * Returns:
 *   {
 *     groups: [
 *       {
 *         newPin,              // the writer's intended new pin
 *         overlappers: [...],  // existing anchored pins for same
 *                              //   (kind, id) whose coverage intersects
 *         mergedPin,           // payload to actually add (== newPin
 *                              //   if no overlappers; union otherwise)
 *         isRedundant,         // true if newPin's coverage ⊆ some
 *                              //   single existing entry — the draft
 *                              //   adds nothing for this group.
 *         chainIds,            // chain id list used for the calc
 *       },
 *       ...
 *     ],
 *     hasOverlap,              // any group has overlappers OR isRedundant
 *     isPureNoOp,              // EVERY anchored new pin is redundant
 *                              //   (the draft, taken as a whole, adds
 *                              //   nothing the writer doesn't already
 *                              //   have).
 *     totalToDrop,             // count of distinct existing entries
 *                              //   that would be removed across all
 *                              //   merge groups.
 *     dynamicPins: [...],      // pins that bypass the merge rule
 *                              //   (no anchor); appliable as-is.
 *   }
 */
export function analyzeCommitConsequences(surfaceKey, newPins, focusedSessionId) {
  const groups = []
  const dynamicPins = []
  const dropIds = new Set()
  const allPins = usePinnedContextStore.getState().getPins(surfaceKey)

  for (const newPin of (newPins || [])) {
    if (!newPin || !newPin.kind || !newPin.id) continue
    const isAnchored = !!(newPin.anchor_node_id || newPin.anchor_range)
    if (!isAnchored) {
      dynamicPins.push(newPin)
      continue
    }
    const chainIds = _resolveChainIds(newPin.kind, newPin.id)
    const newCoverage = _coverageSet(newPin, chainIds)

    const overlappers = []
    let isRedundant = false
    for (const existing of allPins) {
      if (!existing) continue
      if (existing.sessionId === focusedSessionId) continue
      if (existing.kind !== newPin.kind || existing.id !== newPin.id) continue
      if (!(existing.anchor_node_id || existing.anchor_range)) continue
      // The same existing entry might overlap MULTIPLE new pins in the
      // batch; mark it for drop only once.
      const existingCoverage = _coverageSet(existing, chainIds)
      let intersects = false
      for (const x of newCoverage) {
        if (existingCoverage.has(x)) { intersects = true; break }
      }
      if (!intersects) continue
      overlappers.push({ pin: existing, coverage: existingCoverage })
      // Check subset: is newPin's coverage ⊆ this existing entry's coverage?
      let isSubset = true
      for (const x of newCoverage) {
        if (!existingCoverage.has(x)) { isSubset = false; break }
      }
      if (isSubset) isRedundant = true
    }

    let mergedPin = newPin
    if (overlappers.length > 0 && !isRedundant) {
      const union = new Set(newCoverage)
      for (const { coverage } of overlappers) {
        for (const x of coverage) union.add(x)
      }
      mergedPin = _buildMergedPayload(newPin.kind, newPin.id, union, chainIds) || newPin
    } else if (isRedundant && overlappers.length > 0) {
      // The newPin adds nothing; the merged "result" is the single
      // existing entry that already covers it. Pick the first
      // overlapper as the canonical existing entry to reference.
      // applyConsequences won't drop or re-add anything for this group.
      mergedPin = null
    }

    for (const { pin } of overlappers) {
      if (!isRedundant) dropIds.add(pin.sessionId)
    }

    groups.push({ newPin, overlappers, mergedPin, isRedundant, chainIds })
  }

  const anchoredGroups = groups.filter(() => true)
  const hasOverlap = anchoredGroups.some((g) => g.overlappers.length > 0)
  const isPureNoOp = anchoredGroups.length > 0 && anchoredGroups.every((g) => g.isRedundant)

  return {
    groups,
    hasOverlap,
    isPureNoOp,
    totalToDrop: dropIds.size,
    dynamicPins,
  }
}


/**
 * Build the writer-facing dialog message string from the consequences.
 * Returns a plain string suitable for `dialogStore.confirm({message})`
 * (whitespace-pre-line so `\n` becomes line breaks). For the pure
 * no-op case the message reads as an inform-only acknowledgement.
 */
export function formatConsequencesMessage(consequences) {
  if (!consequences) return ''
  if (consequences.isPureNoOp) {
    // Single-pin no-op vs multi-pin all-redundant — phrase accordingly.
    if (consequences.groups.length === 1) {
      const g = consequences.groups[0]
      const cov = g.overlappers[0]
      const existingDesc = cov ? _describePinCoverage(cov.pin, g.chainIds) : 'an existing entry'
      const newDesc = _describePinCoverage(g.newPin, g.chainIds)
      return [
        `Your selection ${newDesc} is already covered by an existing piece of context (${existingDesc}).`,
        '',
        'Nothing will change if you confirm.',
      ].join('\n')
    }
    return 'Every point in your selection is already covered by existing context. Nothing will change if you confirm.'
  }

  const sections = []
  for (const g of consequences.groups) {
    if (g.overlappers.length === 0) continue
    const newDesc = _describePinCoverage(g.newPin, g.chainIds)
    const bullets = g.overlappers
      .map(({ pin }) => `  • ${_describePinCoverage(pin, g.chainIds)}`)
      .join('\n')
    const mergedDesc = g.mergedPin ? _describePinCoverage(g.mergedPin, g.chainIds) : '(unchanged)'
    sections.push([
      `Your new selection ${newDesc} overlaps with:`,
      bullets,
      `If you confirm, ${g.overlappers.length === 1 ? 'that entry' : 'those entries'} will be replaced with a single piece of context ${mergedDesc}.`,
    ].join('\n'))
  }
  if (sections.length === 0) return 'Confirm your selection?'
  return sections.join('\n\n')
}


/**
 * Atomically apply the consequences. Call after the writer has
 * confirmed (or unconditionally when `hasOverlap` is false). Order:
 *   1. Remove the focused entry (if any).
 *   2. Remove every overlapping existing entry across all groups.
 *   3. Add every merged / new pin.
 *   4. Add every dynamic pin (exempt; passed through).
 *
 * Steps 2 and 3 use the same store actions the rest of the program
 * uses, but called back-to-back in one synchronous batch so the
 * pinned-context list snapshots as the writer expects.
 */
export function applyConsequences(surfaceKey, consequences, focusedSessionId) {
  if (!surfaceKey || !consequences) return
  const pinStore = usePinnedContextStore.getState()

  if (focusedSessionId) pinStore.removePin(surfaceKey, focusedSessionId)

  const droppedIds = new Set()
  for (const g of consequences.groups) {
    if (g.isRedundant) continue
    for (const { pin } of g.overlappers) {
      if (pin?.sessionId && !droppedIds.has(pin.sessionId)) {
        pinStore.removePin(surfaceKey, pin.sessionId)
        droppedIds.add(pin.sessionId)
      }
    }
  }

  for (const g of consequences.groups) {
    if (g.isRedundant) continue
    const payload = g.mergedPin || g.newPin
    if (payload) pinStore.addPin(surfaceKey, payload)
  }
  for (const dyn of consequences.dynamicPins) {
    pinStore.addPin(surfaceKey, dyn)
  }
}


/**
 * Convenience orchestrator for non-modal anchored-add surfaces. The
 * modal owns its own orchestration (analyze + dialog + apply, with the
 * modal staying open on cancel), so the modal does NOT use this — but
 * `AttachToChatButton` and any future single-pin anchored-add path
 * does. Returns `{ committed, cancelled, isPureNoOp }`.
 */
export async function confirmAndApplyAnchoredCommit(surfaceKey, newPin, focusedSessionId = null) {
  if (!surfaceKey || !newPin) return { committed: false, cancelled: false, isPureNoOp: false }
  const consequences = analyzeCommitConsequences(surfaceKey, [newPin], focusedSessionId)
  if (!consequences.hasOverlap) {
    applyConsequences(surfaceKey, consequences, focusedSessionId)
    return { committed: true, cancelled: false, isPureNoOp: false }
  }
  const message = formatConsequencesMessage(consequences)
  const result = await confirm({
    title: consequences.isPureNoOp ? 'Already covered' : 'Merge with existing context?',
    message,
    buttons: consequences.isPureNoOp
      ? [{ label: 'OK', value: 'ok', style: 'primary' }]
      : [
          { label: 'Confirm and merge', value: 'confirm', style: 'primary' },
          { label: 'Cancel', value: 'cancel', style: 'neutral' },
        ],
    cancelValue: 'cancel',
  })
  if (consequences.isPureNoOp) {
    return { committed: false, cancelled: false, isPureNoOp: true }
  }
  if (result !== 'confirm') {
    return { committed: false, cancelled: true, isPureNoOp: false }
  }
  applyConsequences(surfaceKey, consequences, focusedSessionId)
  return { committed: true, cancelled: false, isPureNoOp: false }
}


// ── Range-pin reconciliation on chain reorder ────────────────────────
//
// A range pin's `anchor_range.members` array locks in the writer's
// intended scene set at the moment the pin was created. If the chain
// is later reordered such that those members are no longer all
// contiguous (some moved outside the [start..end] span, or scenes
// were inserted between them that the writer didn't intend), the pin
// auto-splits into whatever combination of contiguous range pins +
// isolated single-anchor pins preserves the original intent in the
// new chain order.
//
// Trigger: a useEffect in `ConversationView` watches the project's
// nodes / edges + the pinned-context list and invokes
// `reconcileRangePinsAgainstChain` → applies any returned ops.


/**
 * Read range pins out of `allPins`, evaluate each against the current
 * chain, and return a list of ops to atomically remove the now-stale
 * range and replace it with the right set of contiguous range pins +
 * single-anchor pins. Returns `{ changed, ops }`.
 *
 * Pure: reads the current project store but does NOT mutate. Caller
 * applies via `applyRangePinReconciliation`.
 */
export function reconcileRangePinsAgainstChain(allPins) {
  const ops = []
  for (const pin of (allPins || [])) {
    if (!pin || !pin.anchor_range) continue
    const startId = pin.anchor_range.start_node_id
    const endId = pin.anchor_range.end_node_id
    if (!startId || !endId) continue
    const chainIds = _resolveChainIds(pin.kind, pin.id)
    if (chainIds.length === 0) continue

    // Backwards-compat for any pin missing the `members` array: derive
    // it from the current chain's [start..end] expansion at first
    // sight. Locks in that expansion as the baseline going forward.
    let members = pin.anchor_range.members
    if (!Array.isArray(members) || members.length === 0) {
      const sIdx = chainIds.indexOf(startId)
      const eIdx = chainIds.indexOf(endId)
      if (sIdx < 0 || eIdx < 0 || sIdx > eIdx) continue
      members = chainIds.slice(sIdx, eIdx + 1)
    }

    // Surviving members in the current chain, with their current
    // chain indices. Anything no longer in the chain gracefully drops
    // out (the wider stale-handler removes pins whose endpoints are
    // entirely gone; here we just narrow the surviving set).
    const surviving = []
    for (const m of members) {
      const idx = chainIds.indexOf(m)
      if (idx >= 0) surviving.push({ id: m, idx })
    }
    if (surviving.length === 0) continue
    surviving.sort((a, b) => a.idx - b.idx)

    // Detect contiguous runs by chain index.
    const runs = []
    let runStart = 0
    for (let i = 1; i < surviving.length; i++) {
      if (surviving[i].idx !== surviving[i - 1].idx + 1) {
        runs.push([runStart, i - 1])
        runStart = i
      }
    }
    runs.push([runStart, surviving.length - 1])

    // No-op when nothing changed: a single contiguous run whose
    // endpoints + length match the stored payload. The pin's current
    // shape already matches the chain — leave it alone.
    if (
      runs.length === 1
      && surviving.length === members.length
      && surviving[runs[0][0]].id === startId
      && surviving[runs[0][1]].id === endId
    ) {
      continue
    }

    // Otherwise split into the necessary mix of new pins.
    const newPins = []
    for (const [rs, re] of runs) {
      const subMembers = surviving.slice(rs, re + 1).map((s) => s.id)
      if (subMembers.length === 1) {
        newPins.push({
          kind: pin.kind,
          id: pin.id,
          anchor_node_id: subMembers[0],
        })
      } else {
        newPins.push({
          kind: pin.kind,
          id: pin.id,
          anchor_range: {
            start_node_id: subMembers[0],
            end_node_id: subMembers[subMembers.length - 1],
            members: subMembers,
          },
        })
      }
    }
    ops.push({ removeSessionId: pin.sessionId, addPins: newPins })
  }
  return { changed: ops.length > 0, ops }
}


/**
 * Apply the ops returned by `reconcileRangePinsAgainstChain`. Removes
 * the stale range pin, then adds each replacement pin. The store's
 * existing dedup short-circuits any structurally-identical add so a
 * benign no-change reconciliation never grows the strip.
 */
export function applyRangePinReconciliation(surfaceKey, ops) {
  if (!surfaceKey || !Array.isArray(ops) || ops.length === 0) return
  const pinStore = usePinnedContextStore.getState()
  for (const op of ops) {
    if (op.removeSessionId) pinStore.removePin(surfaceKey, op.removeSessionId)
    for (const pin of (op.addPins || [])) {
      pinStore.addPin(surfaceKey, pin)
    }
  }
}
