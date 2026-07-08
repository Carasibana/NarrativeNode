import { useState, useRef, useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useAccentColor } from '../../utils/povConstants'
import { useActiveModelCapabilities } from '../../hooks/useActiveModelCapabilities'
import ReasoningFlyout from './ReasoningFlyout'

/**
 * Translate a `#RRGGBB` hex into a CSS `rgba(r, g, b, a)` string.
 * Used only for the hint's glow shadow / conic accent — accepts any
 * 6-digit hex and falls back to a violet rgba if parsing fails so
 * the animation still looks sensible if the accent isn't wired up.
 */
function _accentRgba(hex, alpha) {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(124, 58, 237, ${alpha})`
}

/**
 * Decide whether the new model's declared `reasoning_default` calls
 * for a different writer-side state than what's currently set.
 *
 * - If `reasoning_default` is null/missing the model didn't declare
 *   a preference (only LM Studio currently declares one): return
 *   `null` meaning no hint.
 * - If the default is `"off"` and reasoning is currently on, hint
 *   "this model suggests off".
 * - If the default is anything else (`"low"` / `"medium"` /
 *   `"high"` / numeric tier name) and reasoning is currently off,
 *   hint "this model suggests on".
 * - Otherwise no hint (already aligned).
 */
function _hintDirection(reasoningDefault, currentlyEnabled) {
  if (typeof reasoningDefault !== 'string' || reasoningDefault === '') return null
  const defaultIsOff = reasoningDefault === 'off'
  if (defaultIsOff && currentlyEnabled) return 'off'
  if (!defaultIsOff && !currentlyEnabled) return 'on'
  return null
}

/**
 * Phase 2.5f — Reasoning toggle button.
 *
 * Sits on the right side of the chat composer toolbar, immediately
 * next to the Send button. Single icon (brain glyph, reused from
 * `CapabilityBadges.jsx`) that:
 *
 *   - greys out + tooltip when the active model doesn't support
 *     reasoning (`supports_reasoning === false` or `null`),
 *   - tints with the story accent colour at full saturation + soft
 *     accent glow when reasoning is currently ON,
 *   - tints with a muted version of the accent when reasoning is
 *     currently OFF but the model supports it,
 *   - flips `chatReasoningEnabled[threadId]` on click.
 *
 * Hover surfaces the flyout (slider + optional verbosity picker —
 * built in item 8). The flyout's render condition mirrors the
 * button's enabled state: only shown when reasoning is supported AND
 * the model has ≥2 effort options to choose between (after filtering
 * out the literal `"off"` value — the button handles off-state by
 * itself). Binary models like LM Studio's Gemma 4 render the button
 * alone with no flyout.
 *
 * The button does NOT auto-set a level when toggled on — the slider
 * value persists across button toggles. Items 6 (uiStore) and 8
 * (flyout / slider) own that wiring.
 */
export default function ReasoningButton({
  threadId,
  // Optional override hooks for non-thread surfaces (Phase 3.10 Layer 5
  // scene-refinement modal). When `caps` + `enabled` + `onToggle` are
  // supplied, the threadId-driven state is bypassed and the button
  // becomes fully controlled. The flyout is suppressed in that mode
  // — the modal only needs the binary on/off toggle, not the per-
  // thread level slider.
  caps: capsOverride = null,
  enabled: enabledOverride = null,
  onToggle = null,
  dataHelpRegion,
}) {
  const accent = useAccentColor() || '#7c3aed'
  const capsFromThread = useActiveModelCapabilities(threadId)
  const enabledFromThread = useUiStore((s) => threadId ? !!(s.chatReasoningEnabled || {})[threadId] : false)
  const setEnabled = useUiStore((s) => s.setChatReasoningEnabled)
  // Controlled-mode flag lets us route both the click handler and the
  // flyout-render gate to the right state source.
  const controlled = capsOverride !== null && typeof onToggle === 'function'
  const caps = controlled ? capsOverride : capsFromThread
  const enabled = controlled ? !!enabledOverride : enabledFromThread

  const buttonRef = useRef(null)
  const [hovering, setHovering] = useState(false)

  // One-shot model-default hint. When the writer switches the
  // active (profile, model) combo AND the new model declared a
  // `reasoning_default` that disagrees with `chatReasoningEnabled`,
  // we briefly highlight the button and float a tooltip explaining
  // the suggestion. The hint is purely informational — we never
  // mutate `chatReasoningEnabled` automatically. Currently only LM
  // Studio surfaces a `default` per model; other adapters omit the
  // field and so this never fires for them.
  //
  // We skip the very first render so opening the panel doesn't
  // greet the writer with an unsolicited animation on every mount.
  const prevModelKeyRef = useRef(null)
  const [hint, setHint] = useState(null)  // null | 'on' | 'off'
  useEffect(() => {
    const profileId = caps.profile_id || null
    const modelId = caps.model || null
    const key = profileId && modelId ? `${profileId}::${modelId}` : null
    const prev = prevModelKeyRef.current
    prevModelKeyRef.current = key
    if (prev === null) return            // initial mount, no hint
    if (key === null) return             // no model resolved, nothing to suggest
    if (prev === key) return             // model unchanged
    if (caps.supports_reasoning !== true) return
    const direction = _hintDirection(caps.reasoning_default, enabled)
    if (!direction) return
    setHint(direction)
    const t = setTimeout(() => setHint(null), 2400)
    return () => clearTimeout(t)
    // We deliberately key only on model-switch signals — depending
    // on `enabled` would re-fire the hint mid-animation if the
    // writer clicked the button while it was already showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.profile_id, caps.model])

  const supported = caps.supports_reasoning === true
  // Filter the literal "off" out of the model's allowed options —
  // the button handles off-state; the slider only renders intensity
  // levels. After filtering, the flyout only shows when there are
  // 2+ levels left (binary models reduce to a single non-off value
  // and don't need a slider at all).
  const filteredOptions = Array.isArray(caps.reasoning_options)
    ? caps.reasoning_options.filter((opt) => opt !== 'off')
    : null
  const showFlyout = supported && (
    (filteredOptions && filteredOptions.length >= 2)
    || (caps.reasoning_budget_range && typeof caps.reasoning_budget_range === 'object')
    || (caps.api_type === 'openrouter')  // exposes the verbosity picker even on binary
  )

  const title = !supported
    ? 'This model does not support reasoning.'
    : enabled
      ? 'Reasoning is on for the next send. Click to turn off; hover for level options.'
      : 'Reasoning is off. Click to turn on; hover for level options.'

  // Visual style mirrors `SceneContextButton`'s three-state pattern
  // for consistency: greyed-disabled for unsupported, filled-accent
  // for ON, neutral zinc for supported-but-OFF. Icon colour follows
  // the button's text colour via `currentColor`.
  let buttonClass
  if (!supported) {
    buttonClass = 'inline-flex items-center justify-center w-5 h-5 rounded border border-zinc-800 bg-zinc-900/30 text-zinc-600 opacity-50 cursor-not-allowed'
  } else if (enabled) {
    buttonClass = 'inline-flex items-center justify-center w-5 h-5 rounded border border-accent-600 bg-accent-700/80 text-white hover:bg-accent-600 transition-colors cursor-pointer'
  } else {
    buttonClass = 'inline-flex items-center justify-center w-5 h-5 rounded border border-zinc-700 bg-zinc-900/30 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 transition-colors cursor-pointer'
  }

  function onClick() {
    if (!supported) return
    if (controlled) {
      onToggle(!enabled)
      return
    }
    if (!threadId) return
    setEnabled(threadId, !enabled)
  }

  const hintStyle = hint
    ? { '--reasoning-hint-accent': _accentRgba(accent, 0.85) }
    : undefined
  const hintTipText = hint === 'on'
    ? 'This model suggests turning thinking on.'
    : hint === 'off'
      ? 'This model suggests turning thinking off.'
      : null

  return (
    <div
      className="relative inline-flex"
      data-help-region={dataHelpRegion}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        disabled={!supported}
        title={title}
        aria-label={title}
        aria-pressed={supported ? enabled : undefined}
        className={`${buttonClass}${hint ? ' nn-reasoning-hint' : ''}`}
        style={hintStyle}
      >
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.5A3 3 0 0 0 5 18v1a3 3 0 0 0 4 1V3z" />
          <path d="M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 2 5.5A3 3 0 0 1 19 18v1a3 3 0 0 1-4 1V3z" />
        </svg>
      </button>
      {hint && hintTipText && (
        <div className="nn-reasoning-hint-tip" role="status" aria-live="polite">
          {hintTipText}
        </div>
      )}
      {!controlled && hovering && showFlyout && (
        <ReasoningFlyout
          threadId={threadId}
          options={filteredOptions}
          budgetRange={caps.reasoning_budget_range}
          apiType={caps.api_type}
          accent={accent}
        />
      )}
    </div>
  )
}
