import { useCallback, useEffect, useRef, useState } from 'react'
import DynamicBoltIcon from './DynamicBoltIcon'
import { ContextPillSliderPopover } from './PromptBlockForm'
import { useDynamicPillFlash } from '../../utils/useDynamicPillFlash'
import { useUiStore } from '../../store/uiStore'
import { useAccentColor } from '../../utils/povConstants'
import { DETAIL_LEVELS, DEFAULT_N_WORDS } from '../../utils/dynamicMarkers'

/**
 * DynamicPillChip — Phase 2.10b item 5.
 *
 * Canonical render for a Tier 2 dynamic-marker-backed pinned context
 * pill. Implements the click-region structure from planning doc §4.4b-2:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [⚡] [body / label]   [cycle badge?]   [×]                       │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   - leading bolt icon (story accent colour) → identifies the pill as
 *     dynamic (NOT a hit-target — the body button under it owns clicks)
 *   - body region → onPreview (Context Preview panel scrolled to this
 *     pill's contribution; preview wiring lands in item 9)
 *   - cycle badge → onCycle, advances enum config one notch (only
 *     rendered for markers with enumConfig — story_scope_*, adjacent
 *     scenes)
 *   - hover region (whole pill) → opens ContextPillSliderPopover for
 *     N-value markers (previous_n_words, following_n_words)
 *   - × button → onRemove
 *
 *   ─── Why three separate click regions instead of one ─────────────
 *
 * The preview tap is the most-common interaction (writers want to see
 * what's going to be sent); the cycle tap is occasional config tuning;
 * the slider tap is for finer N adjustment. Layering them onto one
 * button would mean each interaction needs a modifier key — slow,
 * undiscoverable, and at odds with the existing pill grammar in
 * PinnedContextChip (body / anchor badge / × already split that way).
 *
 *   ─── Update-flash discipline ─────────────────────────────────────
 *
 * Flash is delegated to `useDynamicPillFlash` (item 4). Direct
 * interaction (cycle click, slider commit, remove click) sets
 * `suppressNext = true` for one render so the writer-initiated
 * targetKey change doesn't read as an out-of-band update. The hook
 * clears the flag on consumption.
 *
 *   ─── Silent-skip render ──────────────────────────────────────────
 *
 * When `silentSkip` is true, the pill stays mounted but renders with
 * `.nn-pill-dynamic-silent-skip` overlaying the base `.nn-pill-dynamic`
 * styling (strike-through label + red text + reduced opacity per the
 * existing precedent). Hover slider stays armed — the writer can still
 * adjust N even while the pill's target is unavailable.
 *
 * Props:
 *   - marker          ContextMarker — the marker shape (drives kind switches)
 *   - sessionId       string — stable pinned-item sessionId (flash key)
 *   - flashScope      string — surface flash scope (chat / sectionId / '__ipb__' / 'sd:<sceneId>')
 *   - targetKey       string|null — current target identity (item 4 flash trigger)
 *   - resolvedLabel   string — caller-resolved body text (chain-aware at the boundary)
 *   - silentSkip      boolean — render strike-through when target deps unmet
 *   - tooltip         string — full `title` attribute (caller-built; includes source)
 *   - identityBadge   ReactNode|null — optional inline identity badge rendered
 *                       between the bolt and the label (e.g. POV pill shows
 *                       `<PovStartGlyph />` + entity colour swatch + entity
 *                       name). When provided, the text `resolvedLabel` is
 *                       suppressed since the badge already names the target.
 *   - onPreview()     → opens Context Preview panel scrolled to this pill
 *   - onRemove()      → removes the pill from pinnedContextItems
 *   - onConfigChange(nextMarker) → commits a marker config edit (cycle / N)
 *   - disabled?       boolean — disables interactive regions (default false)
 */
export default function DynamicPillChip({
  marker,
  sessionId,
  flashScope = 'chat',
  targetKey,
  resolvedLabel,
  silentSkip = false,
  tooltip,
  identityBadge = null,
  onPreview,
  onRemove,
  onConfigChange,
  disabled = false,
}) {
  const outerRef = useRef(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const closeTimerRef = useRef(null)
  // Story accent colour drives both the dashed-outline border and
  // the flash pulse colour so the dynamic-pill identity reads as
  // tied to the loaded story. `useAccentColor()` returns a stable
  // string primitive, so the component only re-renders when the
  // story's accent_color actually changes (rare — Story Settings
  // save). Falls back to the program-wide accent when no story is
  // loaded, matching DynamicBoltIcon's behaviour.
  const accent = useAccentColor()
  // Suppress-next flag for `useDynamicPillFlash`. Set true immediately
  // before any direct-interaction commit (cycle / slider / remove);
  // hook consumes + clears on the next render so subsequent out-of-band
  // changes still flash normally.
  const [suppressNextFlash, setSuppressNextFlash] = useState(false)

  // Marker-kind classifications. Stable per render — derived purely
  // from `marker.type`, no Zustand reads.
  const isEnumConfig = marker?.type === 'story_scope_whole_story'
    || marker?.type === 'story_scope_current_chapter'
    || marker?.type === 'story_scope_current_act'
    || marker?.type === 'previous_scene'
    || marker?.type === 'next_scene'
  const isNValue = marker?.type === 'previous_n_words' || marker?.type === 'following_n_words'
  const directionLabel = marker?.type === 'previous_n_words' ? 'BEFORE'
    : marker?.type === 'following_n_words' ? 'AFTER'
    : null

  // Flash subscription — mirrors PinnedContextChip's pattern but keyed
  // as `dynamic:<sessionId>` to match the `useDynamicPillFlash` writes.
  const flashAt = useUiStore((s) => s.pillFlashAt?.[flashScope]?.[`dynamic:${sessionId}`] || 0)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (!flashAt) return undefined
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 1400)
    return () => clearTimeout(t)
  }, [flashAt])
  const flashCls = flashing ? 'nn-chat-pill-flash' : ''

  // Wire the flash detection. Caller supplies `targetKey`; hook does
  // mount-suppression + direct-interaction-suppression + diff.
  useDynamicPillFlash({
    scope: flashScope,
    sessionId,
    targetKey,
    suppressNext: suppressNextFlash,
  })
  // Clear the suppress flag once it's been observed by the hook so the
  // next render can flash normally on a genuine out-of-band update.
  useEffect(() => {
    if (suppressNextFlash) {
      const id = setTimeout(() => setSuppressNextFlash(false), 0)
      return () => clearTimeout(id)
    }
    return undefined
  }, [suppressNextFlash])

  // Hover-popover open/close — same 150ms grace as the existing
  // ContextPill (PromptBlockForm.jsx). Only armed for N-value markers.
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setPopoverOpen(false), 150)
  }, [cancelClose])
  const openNow = useCallback(() => {
    cancelClose()
    setPopoverOpen(true)
  }, [cancelClose])
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  // Cycle handler — advances detail-level for enum markers in
  // DETAIL_LEVELS order, wrapping at the end.
  const handleCycle = useCallback(() => {
    if (!isEnumConfig || !marker || disabled) return
    const current = marker.detail || DETAIL_LEVELS[0]
    const idx = DETAIL_LEVELS.indexOf(current)
    const next = DETAIL_LEVELS[(idx + 1) % DETAIL_LEVELS.length]
    setSuppressNextFlash(true)
    onConfigChange?.({ ...marker, detail: next })
  }, [isEnumConfig, marker, disabled, onConfigChange])

  // Slider commit — fires through onConfigChange with new n.
  const handleNChange = useCallback((next) => {
    if (!isNValue || !marker) return
    setSuppressNextFlash(true)
    onConfigChange?.({ ...marker, n: next })
  }, [isNValue, marker, onConfigChange])

  // Remove handler — sets suppress so the targetKey transition to null
  // (caused by the pill being unmounted) doesn't queue a flash on the
  // way out. (Hook teardown means the flash wouldn't render anyway,
  // but suppressing it is the symmetric thing to do.)
  const handleRemove = useCallback(() => {
    setSuppressNextFlash(true)
    onRemove?.()
  }, [onRemove])

  // Body click — preview. No suppress (the preview panel doesn't
  // change targetKey on its own).
  const handlePreview = useCallback(() => {
    onPreview?.()
  }, [onPreview])

  // Visual class composition. `.nn-pill-dynamic` carries the italic +
  // dashed-border treatment from item 3; `.nn-pill-dynamic-silent-skip`
  // overlays strike-through + red + dimmed for unmet-deps state.
  const baseClass = 'inline-flex items-center gap-1 border rounded-full overflow-hidden border-zinc-700/60 bg-zinc-800/40 text-zinc-200'
  const dynamicClass = 'nn-pill-dynamic' + (silentSkip ? ' nn-pill-dynamic-silent-skip' : '')

  // Cycle-badge label — short token signalling the current detail
  // level. Matches the planning doc's terse style.
  const cycleBadgeText = (() => {
    if (!isEnumConfig) return null
    switch (marker.detail) {
      case 'descriptions_and_changes': return 'DESC+'
      case 'full_content': return 'FULL'
      case 'descriptions_only':
      default: return 'DESC'
    }
  })()

  return (
    <span
      ref={outerRef}
      data-help-region="badge:dynamic_pill"
      className={`${baseClass} ${dynamicClass} ${flashCls}`}
      style={{
        // Dashed-outline border colour comes from the story accent.
        // Overrides the neutral `border-zinc-700/60` token in baseClass
        // so the dashed identity reads in the writer's chosen accent.
        borderColor: accent,
        // CSS variable consumed by the `nn-chat-pill-flash` keyframe
        // (see index.css). Without this the keyframe falls back to its
        // hardcoded amber; with it, the pulse pulses in the writer's
        // accent so the flash visually matches the rest of the
        // dynamic-pill identity.
        '--nn-pill-flash-colour': accent,
      }}
      title={tooltip}
      onMouseEnter={isNValue && !disabled ? openNow : undefined}
      onMouseLeave={isNValue && !disabled ? scheduleClose : undefined}
    >
      <button
        type="button"
        onClick={handlePreview}
        disabled={disabled}
        aria-label={`Preview: ${resolvedLabel}`}
        className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-[10px] hover:bg-zinc-700/30 transition-colors cursor-pointer"
      >
        <DynamicBoltIcon size={10} />
        {identityBadge}
        {!identityBadge && (
          <span className="truncate max-w-[160px]">{resolvedLabel}</span>
        )}
      </button>

      {isEnumConfig && (
        <button
          type="button"
          onClick={handleCycle}
          disabled={disabled}
          title="Click to cycle detail level."
          aria-label={`Cycle detail level. Current: ${cycleBadgeText}.`}
          className="inline-flex items-center px-1 py-0.5 text-[9px] uppercase tracking-wide font-semibold cursor-pointer hover:brightness-125 transition-[filter] text-zinc-300 bg-zinc-900/40 border-l border-zinc-700/60"
        >
          {cycleBadgeText}
        </button>
      )}

      {isNValue && (
        <span
          className="inline-flex items-center px-1 py-0.5 text-[9px] uppercase tracking-wide font-semibold text-zinc-300 bg-zinc-900/40 border-l border-zinc-700/60"
          aria-hidden="true"
          title="Hover to adjust word count."
        >
          {(marker.n ?? DEFAULT_N_WORDS)}w
        </span>
      )}

      <button
        type="button"
        onClick={handleRemove}
        disabled={disabled}
        title="Remove this dynamic pill."
        aria-label="Remove"
        className="w-4 h-4 mr-0.5 flex items-center justify-center text-[10px] leading-none rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700/60"
      >
        ✕
      </button>

      {popoverOpen && isNValue && outerRef.current && (
        <ContextPillSliderPopover
          anchorEl={outerRef.current}
          count={marker.n ?? DEFAULT_N_WORDS}
          onCountChange={handleNChange}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
          directionLabel={directionLabel}
          disabled={disabled}
        />
      )}
    </span>
  )
}
