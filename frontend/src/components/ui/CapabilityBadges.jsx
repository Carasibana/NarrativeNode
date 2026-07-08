/**
 * Phase 2.5e — Model capability badges.
 *
 * Compact icon row showing what an AI model can do: vision (image
 * input), tool use, and reasoning. Mirrors the LM Studio model-
 * picker convention so writers familiar with that UI recognise
 * the icons at a glance.
 *
 * Capability sources (from `DiscoveredModel` / `ModelCapabilities`):
 *   - vision     → `input_modalities` array contains 'image'
 *   - tool use   → `supports_tool_use === true`
 *   - reasoning  → `supports_reasoning === true`
 *
 * Each badge only renders when its capability is explicitly known
 * to be supported. `null` / undefined / false → hidden (no icon).
 * The component returns null entirely when nothing's known, so
 * callers can drop it inline without conditional wrappers.
 *
 * Colours mirror the LM Studio palette:
 *   - amber for vision
 *   - sky for tool use
 *   - emerald for reasoning
 */
export default function CapabilityBadges({ capabilities, size = 'sm' }) {
  if (!capabilities) return null
  const inputMods = capabilities.input_modalities
  const hasVision = Array.isArray(inputMods) && inputMods.includes('image')
  const hasTools  = capabilities.supports_tool_use === true
  const hasReason = capabilities.supports_reasoning === true
  if (!hasVision && !hasTools && !hasReason) return null

  const dim = size === 'sm' ? 12 : 14
  const wrap = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'

  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0" data-help-region="badge:capabilities">
      {hasVision && (
        <span
          title="Vision: this model accepts image inputs."
          aria-label="Vision capable"
          className={`inline-flex items-center justify-center ${wrap} rounded border border-amber-700/50 bg-amber-900/20 text-amber-300`}
        >
          <svg viewBox="0 0 24 24" width={dim} height={dim} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
      )}
      {hasTools && (
        <span
          title="Tool use: this model was trained for function / tool calling."
          aria-label="Tool use capable"
          className={`inline-flex items-center justify-center ${wrap} rounded border border-sky-700/50 bg-sky-900/20 text-sky-300`}
        >
          <svg viewBox="0 0 24 24" width={dim} height={dim} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-7 7 2 2 7-7a4 4 0 0 0 5.4-5.4l-3 3-1.4-1.4 3-3z" />
          </svg>
        </span>
      )}
      {hasReason && (
        <span
          title="Reasoning: this model supports an explicit reasoning / thinking mode."
          aria-label="Reasoning capable"
          className={`inline-flex items-center justify-center ${wrap} rounded border border-emerald-700/50 bg-emerald-900/20 text-emerald-300`}
        >
          <svg viewBox="0 0 24 24" width={dim} height={dim} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.5A3 3 0 0 0 5 18v1a3 3 0 0 0 4 1V3z" />
            <path d="M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 2 5.5A3 3 0 0 1 19 18v1a3 3 0 0 1-4 1V3z" />
          </svg>
        </span>
      )}
    </span>
  )
}
