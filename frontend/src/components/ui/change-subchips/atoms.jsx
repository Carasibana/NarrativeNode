/**
 * Atomic visual primitives for change sub-chips.
 *
 * These are the smallest reusable building blocks shared across the
 * sub-chip renderers in this folder. Each atom renders a single field-
 * value visualisation; the per-type sub-chip wrappers compose them with
 * `<BaseChangeChip>` to form a row.
 *
 * Atoms are pure presentational — no store reads, no resolvers, no event
 * handlers beyond the optional click pass-through. Behaviour belongs in
 * the wrappers.
 */
import { useEffect } from 'react'
import { ACTION_COLOR, actionSymbol } from '../ChangeChipBase'

/**
 * ColourSwatch — a single 10x10 rounded swatch with the standard
 * dark-zinc border (`#52525b` = Tailwind `border-zinc-600`).
 *
 * Consumers:
 *   - `<ChangeSubChip>` `chip.isColour` modify branch — two swatches with
 *     an arrow between (old → new). Used for both entity colour changes
 *     and Knowledge colour changes (Knowledge content changes route through
 *     `<ChangeSubChip>` post-Phase-1.21d Step F).
 */
export function ColourSwatch({ hex }) {
  return (
    <span
      className="inline-block flex-shrink-0 rounded-sm"
      style={{ width: 10, height: 10, backgroundColor: hex || '#888888', border: '1px solid #52525b' }}
    />
  )
}

/**
 * ActionEventBadge — composite pill combining the action glyph and an
 * uppercase event-kind label, all tinted with the action's colour.
 *
 *   ✚ JOINED   ⚊ LEFT   ✱ ROLE   ✚ ADDED   ⚊ REMOVED   ✱ MODIFIED
 *
 * The "event kind" tells you what specifically changed in addition to
 * the generic action (e.g. "Role" was modified, vs. "Perception" was
 * modified, vs. "Title" was modified). Uppercase + tracking-wider
 * matches the canonical small-pill convention used elsewhere in the
 * app for tag-style labels.
 *
 * Replaces three inline rendering blocks across `RelationshipHistory
 * ChangeChip`, `EntityOriginJoinChip`, and similar sub-chip
 * leadings. When this badge is used as a sub-chip's leading element,
 * pair with `<BaseChangeChip showSymbol={false}>` so the wrapper's
 * default action symbol doesn't double up.
 *
 * Props:
 *   action — 'add' | 'modify' | 'remove' (drives glyph + colour)
 *   label  — uppercase string to render after the glyph
 */
export function ActionEventBadge({ action, label }) {
  const colour = ACTION_COLOR[action] || '#a1a1aa'
  const glyph = actionSymbol(action)
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] uppercase tracking-wider font-semibold flex-shrink-0"
      style={{ color: colour, backgroundColor: `${colour}22` }}
    >
      <span>{glyph}</span>
      <span>{label}</span>
    </span>
  )
}

/**
 * ActionGlyphBadge — compact pill containing ONLY the action glyph,
 * tinted with the action's colour. Use this when the chip's leading
 * badge should be a small glyph-only marker followed by separately
 * rendered plain-text field name + value transition.
 *
 *   [+]  [⚊]  [✱]
 *
 * Pair with the field-name-first plain-text shape from before the
 * pill convention:
 *   [glyph badge] FieldName : oldStrike → new
 *
 * Use `ActionEventBadge` instead when the chip carries no
 * separately-rendered field name (e.g. "✚ JOINED" / "⚊ LEFT" /
 * "✚ STARTED" / "⚊ ENDED").
 */
export function ActionGlyphBadge({ action }) {
  const colour = ACTION_COLOR[action] || '#a1a1aa'
  const glyph = actionSymbol(action)
  return (
    <span
      className="inline-flex items-center justify-center px-1 py-0 rounded text-[9px] font-bold flex-shrink-0"
      style={{ color: colour, backgroundColor: `${colour}22` }}
    >
      {glyph}
    </span>
  )
}

/** Pre-prepped action pills for the common generic verbs. Use these
 *  when the chip's leading badge should read as the action itself
 *  rather than a specific event kind. */
export function ActionAddedBadge() { return <ActionEventBadge action="add"    label="ADDED" /> }
export function ActionRemovedBadge() { return <ActionEventBadge action="remove" label="REMOVED" /> }
export function ActionModifiedBadge() { return <ActionEventBadge action="modify" label="MODIFIED" /> }
export function ActionJoinedBadge() { return <ActionEventBadge action="add"    label="JOINED" /> }
export function ActionLeftBadge()   { return <ActionEventBadge action="remove" label="LEFT" /> }
export function ActionStartedBadge() { return <ActionEventBadge action="add"    label="STARTED" /> }
export function ActionEndedBadge()   { return <ActionEventBadge action="remove" label="ENDED" /> }

/**
 * FallbackSubChip — visually-loud default sub-chip for unhandled
 * dispatch cases. When a sub-chip renderer's kind / shape lookup
 * doesn't match any known branch, render this instead of silently
 * dropping the record so the gap is immediately visible during
 * development.
 *
 * Styling: gray fill + red border + ⚠ glyph. Deliberately ugly so it
 * stands out next to the canonical sub-chip styles. Renders the
 * record's kind + a developer-facing "TODO" message (passed via
 * `reason`). Optional `payload` echoes any context-specific data the
 * dispatcher couldn't render so the gap is debuggable from the chip
 * itself.
 *
 * Use as the catchall in any sub-chip dispatch (`AwarenessSubChip`,
 * `RelChangeChip`, `ChangeSubChip`, etc.) and any consumer that maps
 * over a kind-keyed record stream.
 *
 * Props:
 *   kind     — the unhandled record kind (e.g. 'alias' if a renderer
 *              hasn't shipped that branch yet)
 *   reason   — short developer-facing description; defaults to
 *              "kind=<kind> renderer not implemented"
 *   payload  — optional object; rendered as a small JSON-ish summary
 *              for debugging
 */
// Module-level signature set — dedupes console warnings so the same
// unhandled (kind, reason) combo isn't logged on every render. Cleared
// only on full page reload, which matches when a dev would notice the
// gap and act on it.
const _LOGGED_FALLBACK_SIGNATURES = new Set()

export function FallbackSubChip({ kind, reason, payload }) {
  const message = reason || `kind=${kind ?? 'unknown'} renderer not implemented`
  let payloadStr = null
  if (payload) {
    try {
      payloadStr = JSON.stringify(payload, (k, v) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 37) + '…' : v))
      if (payloadStr.length > 80) payloadStr = payloadStr.slice(0, 77) + '…'
    } catch { /* ignore */ }
  }
  // Console.warn on first render of each unique (kind, reason) pair.
  // Mirrors the visual fallback chip so devs get parallel signals
  // (in-app + devtools console). Deduped per-signature to avoid
  // spamming on rerenders. Pull a stack-trace into the warn body so
  // the dev can jump to the dispatcher that emitted the fallback.
  const signature = `${kind ?? 'unknown'}::${reason ?? ''}`
  useEffect(() => {
    if (_LOGGED_FALLBACK_SIGNATURES.has(signature)) return
    _LOGGED_FALLBACK_SIGNATURES.add(signature)
     
    console.warn(
      `[FallbackSubChip] ${message}`,
      { kind, reason, payload },
      '\n(dispatcher caller stack:)',
      new Error().stack,
    )
  }, [signature, kind, reason, payload, message])
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono"
      style={{
        backgroundColor: '#3f3f46',
        border: '1.5px solid #ef4444',
        color: '#fef2f2',
      }}
      title={`Sub-chip dispatch fallback: ${message}${payloadStr ? `  payload: ${payloadStr}` : ''}`}
    >
      <span style={{ color: '#fbbf24' }}>⚠</span>
      <span>TODO: {message}</span>
    </span>
  )
}
