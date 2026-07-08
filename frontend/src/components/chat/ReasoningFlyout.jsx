import { useUiStore } from '../../store/uiStore'

/**
 * Phase 2.5f — Reasoning flyout.
 *
 * Hover popover anchored above the ReasoningButton. Contents adapt
 * to the active adapter + model:
 *
 *   - Enum-based adapters (LM Studio / OpenRouter / openai_compatible):
 *     draggable slider with one tick per option in `options`. The
 *     literal `"off"` is already filtered out upstream — the button
 *     handles off-state. Slider sets `chatReasoningLevel` to the
 *     selected option string.
 *
 *   - Numeric-budget adapter (Anthropic when it ships): continuous
 *     slider over `[budgetRange.min, budgetRange.max]` with a
 *     readout showing the current token-budget value.
 *
 *   - OpenRouter additionally exposes a small Verbosity picker below
 *     the slider — sets `chatReasoningVerbosity` to one of `auto` /
 *     `concise` / `none`. Concise carries a tooltip warning about
 *     possible extra summarisation tokens on some providers.
 *
 * Rendered as a child of the button's hover-wrapper div so the
 * shared hover state keeps it visible while the cursor is over
 * either the button OR the flyout.
 */
export default function ReasoningFlyout({ threadId, options, budgetRange, apiType, accent }) {
  const level = useUiStore((s) => threadId ? (s.chatReasoningLevel || {})[threadId] : null)
  const verbosity = useUiStore((s) => threadId ? (s.chatReasoningVerbosity || {})[threadId] : null)
  const enabled = useUiStore((s) => threadId ? !!(s.chatReasoningEnabled || {})[threadId] : false)
  const setEnabled = useUiStore((s) => s.setChatReasoningEnabled)
  const setLevel = useUiStore((s) => s.setChatReasoningLevel)
  const setVerbosity = useUiStore((s) => s.setChatReasoningVerbosity)

  // Implicit enable: any interaction with the flyout (dragging the
  // slider, cycling the verbosity chip) auto-turns the reasoning
  // button ON if it was off. The writer can still toggle it back off
  // via the button click. Saves a click for the common "drag to set
  // and use" flow.
  function ensureEnabled() {
    if (threadId && !enabled) setEnabled(threadId, true)
  }

  const isNumeric = !!(budgetRange && typeof budgetRange === 'object' && Number.isFinite(budgetRange.min) && Number.isFinite(budgetRange.max))
  const isEnum = !isNumeric && Array.isArray(options) && options.length >= 2

  // Find the current slider position. For enum: index in `options`.
  // For numeric: the raw numeric value (clamped to range when out of
  // bounds). Defaults: enum → middle option; numeric → range.min.
  let enumIndex = 0
  if (isEnum) {
    if (typeof level === 'string') {
      const found = options.indexOf(level)
      enumIndex = found >= 0 ? found : Math.floor(options.length / 2)
    } else {
      enumIndex = Math.floor(options.length / 2)
    }
  }
  const numericValue = isNumeric
    ? (typeof level === 'number' ? Math.max(budgetRange.min, Math.min(budgetRange.max, level)) : budgetRange.min)
    : 0

  // Tick width is whatever fits — slider is fixed-width inside the
  // flyout; ticks distribute evenly. Each tick label sits below its
  // tick mark.
  const sliderId = `nn-reasoning-slider-${threadId || 'noop'}`

  function onSliderChange(e) {
    if (!threadId) return
    if (isEnum) {
      const idx = parseInt(e.target.value, 10)
      if (Number.isFinite(idx) && idx >= 0 && idx < options.length) {
        setLevel(threadId, options[idx])
        ensureEnabled()
      }
    } else if (isNumeric) {
      const v = parseInt(e.target.value, 10)
      if (Number.isFinite(v)) {
        setLevel(threadId, v)
        ensureEnabled()
      }
    }
  }

  const showVerbosity = apiType === 'openrouter'

  return (
    // Wrapped in a hover-buffer container with `pb-1` so the
    // flyout's hit-test region extends right down to the top of
    // the button — without this gap-bridge, the cursor crosses an
    // unhovered zone moving from button to flyout and the parent's
    // onMouseLeave dismisses the flyout mid-traversal.
    <div className="absolute bottom-full right-0 z-30 pb-1">
    <div
      role="dialog"
      aria-label="Reasoning effort"
      data-help-region="conversation:composer_reasoning_flyout"
      className="bg-zinc-900 border rounded shadow-xl px-2 py-1.5 w-[170px]"
      style={{ borderColor: `${accent || '#7c3aed'}55` }}
    >
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">Reasoning effort</div>
      {/* Slider visual mirrors the button's on/off state: accent
          colour when reasoning is ON, muted zinc when OFF. Touching
          the slider still works (and auto-enables via ensureEnabled),
          but the dimmed look signals "this isn't currently riding
          your sends." */}
      {(() => {
        const sliderAccent = enabled ? (accent || '#7c3aed') : '#71717a'  // zinc-500 when off
        const tickActiveColour = enabled ? (accent || '#a78bfa') : '#a1a1aa'  // zinc-400 when off
        if (isEnum) {
          return (
            <>
              <input
                id={sliderId}
                type="range"
                min={0}
                max={options.length - 1}
                step={1}
                value={enumIndex}
                onChange={onSliderChange}
                data-help-region="conversation:reasoning_level_slider"
                className="w-full nn-reasoning-slider"
                style={{ accentColor: sliderAccent }}
                aria-label="Reasoning effort level"
              />
              <div className="flex justify-between mt-1 text-[9px] text-zinc-500">
                {options.map((opt, idx) => (
                  <span
                    key={opt}
                    className={idx === enumIndex ? 'font-semibold' : ''}
                    style={idx === enumIndex ? { color: tickActiveColour } : undefined}
                  >
                    {opt}
                  </span>
                ))}
              </div>
            </>
          )
        }
        if (isNumeric) {
          return (
            <>
              <input
                id={sliderId}
                type="range"
                min={budgetRange.min}
                max={budgetRange.max}
                step={Math.max(256, Math.floor((budgetRange.max - budgetRange.min) / 64))}
                value={numericValue}
                onChange={onSliderChange}
                data-help-region="conversation:reasoning_level_slider"
                className="w-full"
                style={{ accentColor: sliderAccent }}
                aria-label="Reasoning token budget"
              />
              <div className="flex justify-between mt-1 text-[9px] text-zinc-500">
                <span>{budgetRange.min.toLocaleString()}</span>
                <span style={{ color: tickActiveColour }} className="font-semibold">
                  {numericValue.toLocaleString()} tokens
                </span>
                <span>{budgetRange.max.toLocaleString()}</span>
              </div>
            </>
          )
        }
        return null
      })()}
      {showVerbosity && (
        <div className="mt-1.5 pt-1.5 border-t border-zinc-800 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Verbosity</span>
          <VerbosityCycleButton
            value={verbosity}
            accent={accent}
            onCycle={(next) => {
              if (!threadId) return
              setVerbosity(threadId, next)
              ensureEnabled()
            }}
          />
        </div>
      )}
    </div>
    </div>
  )
}


// Verbosity cycle states. Walks Default → Concise → Hidden → Default.
// `value` in uiStore is `null` for Default, `'concise'` for Concise,
// `'none'` for Hidden.
const _VERBOSITY_CYCLE = [
  { value: null,      label: 'Default', tooltip: 'Default reasoning verbosity from the provider. No extra summarisation tokens. Click to cycle.' },
  { value: 'concise', label: 'Concise', tooltip: 'Summarized reasoning trail. May use extra tokens on some providers. Click to cycle.' },
  { value: 'none',    label: 'Hidden',  tooltip: 'Reasoning content suppressed. Reasoning tokens are still billed. Click to cycle.' },
]

function VerbosityCycleButton({ value, accent, onCycle }) {
  // Normalise null / undefined / '' / 'auto' to the Default entry.
  const currentIdx = (() => {
    if (value == null || value === '' || value === 'auto') return 0
    const i = _VERBOSITY_CYCLE.findIndex((s) => s.value === value)
    return i >= 0 ? i : 0
  })()
  const state = _VERBOSITY_CYCLE[currentIdx]
  const next = _VERBOSITY_CYCLE[(currentIdx + 1) % _VERBOSITY_CYCLE.length]
  return (
    <button
      type="button"
      onClick={() => onCycle(next.value)}
      title={state.tooltip}
      data-help-region="conversation:reasoning_verbosity"
      className="text-[10px] px-1.5 py-0.5 rounded border text-zinc-100 transition-colors hover:opacity-80"
      style={{
        borderColor: accent || '#7c3aed',
        backgroundColor: `${accent || '#7c3aed'}22`,
      }}
    >
      {state.label}
    </button>
  )
}
