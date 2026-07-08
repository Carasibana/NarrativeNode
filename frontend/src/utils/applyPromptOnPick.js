/**
 * Apply-prompt-on-pick dispatcher — Phase 2.10b item 11.
 *
 * Called every time the writer picks a system prompt at any surface
 * (including re-picking the currently active prompt). Runs three steps
 * in order per planning doc §4.4f + Phase 2.10 Bug 6:
 *
 *   (A) Tier 2 dynamic markers — attached markers, clear-then-add.
 *       Step (A.i) clears every dynamic pill with `source === 'prompt'`;
 *       step (A.ii-iv) walks `prompt.context_markers` and pushes a new
 *       dynamic pill per marker with `source: 'prompt'`, deduping
 *       against any remaining manual pills with the same marker key.
 *       Manual pills (`source !== 'prompt'`) are NEVER touched.
 *
 *   (A2) Static cue attachments — cue pill clear-then-add (Bug 6).
 *       Clears every static `kind === 'cue'` pin with
 *       `source === 'prompt'`, then walks `prompt.static_cue_ids` and
 *       pushes one static cue pin per id with `source: 'prompt'`.
 *       Manual cue pins (`source !== 'prompt'`) survive. De-dup by cue
 *       id against the remaining manual cue pins so a duplicate
 *       attachment doesn't add a second pin.
 *
 *   (B) Tier 1 — surface-intrinsic settings, populate-on-explicit-value.
 *       Walk `prompt.surface_defaults`. For each slot the prompt
 *       explicitly sets, write the value to the surface's existing
 *       state bucket. Slots the prompt is silent on (null) do NOT
 *       reset — current state preserved. Settings for affordances not
 *       viable on this surface silently no-op (the surface's
 *       `applySurfaceDefaults` adapter only writes the buckets it has).
 *
 * Net effect:
 *   - Switching prompts swaps Tier 2 cleanly,
 *   - sets Tier 1 explicitly per the prompt's opinions,
 *   - leaves Tier 1 alone when silent,
 *   - manual pins always persist.
 *
 * Surface-agnostic via adapter functions — each surface plugs in its
 * own `listPins` / `addPin` / `removePin` / `applySurfaceDefaults`
 * implementations. The dispatcher itself only knows about the
 * `pinnedContextItems` SHAPE (item 1) and the `SystemPrompt` SHAPE
 * (item 7); the storage paths are surface-local.
 *
 * @param {object} args
 * @param {object | null} args.prompt — the newly-picked SystemPrompt
 *   (or null when the writer picked "No system prompt"). On null the
 *   dispatcher still runs step (A.i) to clear prior prompt-attached
 *   pills; step (A.ii) is a no-op (no markers to add); step (B) is a
 *   no-op (no defaults to write).
 * @param {Array<object>} args.currentPins — current `pinnedContextItems`
 *   on this surface. Used to identify prompt-sourced pills and to
 *   dedup against manual pills.
 * @param {(item: object) => void} args.addPin — adapter that pushes
 *   a new pin onto the surface's pinned-items list.
 * @param {(sessionId: string) => void} args.removePin — adapter that
 *   removes the pin with the given sessionId.
 * @param {(defaults: object) => void} [args.applySurfaceDefaults] —
 *   adapter that applies a SurfaceDefaults payload to the surface's
 *   existing Tier 1 state buckets. Omitting it skips step (B) entirely
 *   (used by surfaces that don't expose any Tier 1 affordances, e.g.
 *   surfaces that only carry attached pills).
 * @param {string | null} [args.sourcePromptId] — overrides
 *   `prompt.id` as the value stored in `source_prompt_id` on the new
 *   pills. Useful when the caller has the id but not the full prompt
 *   payload yet.
 */
import { markerKey, isContextMarker } from './dynamicMarkers'

export function applyPromptOnPick({
  prompt,
  currentPins,
  addPin,
  removePin,
  applySurfaceDefaults,
  sourcePromptId,
}) {
  if (typeof addPin !== 'function' || typeof removePin !== 'function') return

  const pins = Array.isArray(currentPins) ? currentPins : []

  // (A.i) Strip prior prompt-attached pills. Manual pins
  // (`source !== 'prompt'`) are never touched.
  for (const p of pins) {
    if (p && p.source === 'prompt' && p.sessionId) {
      removePin(p.sessionId)
    }
  }

  // (A.ii-iv) Add new prompt-attached markers as dynamic pills.
  // De-dup against the MANUAL pins that remain (prompt-sourced pins
  // were just stripped above). The dedup runs against the local
  // working set — we don't re-read the store mid-loop because the
  // caller's addPin may be batched / async.
  const remainingManual = pins.filter((p) => p && p.source !== 'prompt')
  const remainingKeys = new Set(
    remainingManual
      .filter((p) => p.pin_kind === 'dynamic' && p.marker)
      .map((p) => markerKey(p.marker)),
  )

  const markers = (prompt && Array.isArray(prompt.context_markers))
    ? prompt.context_markers
    : []
  const seenInThisBatch = new Set()
  for (const marker of markers) {
    if (!isContextMarker(marker)) continue
    const key = markerKey(marker)
    if (remainingKeys.has(key) || seenInThisBatch.has(key)) continue
    seenInThisBatch.add(key)
    addPin({
      sessionId: _newSessionId(),
      pin_kind: 'dynamic',
      marker,
      source: 'prompt',
      source_prompt_id: sourcePromptId || prompt?.id || null,
    })
  }

  // (A2) Static cue attachments — Phase 2.10 Bug 6. Walk
  // `prompt.static_cue_ids` and add one static cue pin per id with
  // `source: 'prompt'`. Manual cue pins (filtered into `remainingManual`
  // above) survive; dedup by cue id against them so a duplicate
  // attachment doesn't add a second pin.
  const staticCueIds = (prompt && Array.isArray(prompt.static_cue_ids))
    ? prompt.static_cue_ids
    : []
  const remainingCueIds = new Set(
    remainingManual
      .filter((p) => p.kind === 'cue' && p.id)
      .map((p) => p.id),
  )
  const seenCueIdsInThisBatch = new Set()
  for (const cueId of staticCueIds) {
    if (!cueId || typeof cueId !== 'string') continue
    if (remainingCueIds.has(cueId) || seenCueIdsInThisBatch.has(cueId)) continue
    seenCueIdsInThisBatch.add(cueId)
    addPin({
      sessionId: _newSessionId(),
      kind: 'cue',
      id: cueId,
      source: 'prompt',
      source_prompt_id: sourcePromptId || prompt?.id || null,
    })
  }

  // (B) Surface defaults — populate-on-explicit-value.
  if (typeof applySurfaceDefaults === 'function' && prompt?.surface_defaults) {
    applySurfaceDefaults(prompt.surface_defaults)
  }
}

function _newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'pp_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
