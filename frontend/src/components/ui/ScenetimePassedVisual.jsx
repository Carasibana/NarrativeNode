/**
 * Phase 1.23 audit step (9) — reusable time-passed visual.
 *
 * Three-block display showing the prior scene's pinned summary, a
 * prominent gap descriptor, and the current scene's pinned summary
 * (typically the writer's draft):
 *
 *   horizontal:  [ prior summary ]   [ gap descriptor ]   [ current summary ]
 *   vertical:    [ prior summary ]
 *                [ gap descriptor ]
 *                [ current summary ]
 *
 * Both summary blocks reuse the existing `SceneTimeChipContent` so
 * the visual matches the scene-card chip + Time Modal Section 1
 * exactly. The middle gap descriptor is the prominent element —
 * larger, semibold — using the granularity-aware compact-gap phrase
 * from `formatGap` (the same phrasing the chip's leading "gap from
 * prior" segment uses, just bigger).
 *
 * Pure presentation. The component takes prior-scene data, current-
 * scene data, and a signed gap minute count; it does not read the
 * walker or any store. Items (10) Time Modal Section 3 header and
 * (11) save-draft confirmation popup both consume this component.
 *
 * Props:
 *   priorSceneData     scene data object for the prior scene, or null
 *                      when there is no prior (first scene of chain
 *                      or off-chain). When null, the prior block is
 *                      omitted entirely — no placeholder is invented.
 *   currentSceneData   scene data object for the current scene
 *                      (typically the writer's draft).
 *   gapMinutes         signed minute count for the gap. Sign convention:
 *                      positive = current effective is after prior
 *                      effective end; negative = before (Allow Negative
 *                      Time, V2-parked but rendered).
 *   accentColour       optional; passed through to the SceneTimeChip
 *                      content for icon tint.
 *   orientation        'horizontal' (default; for wide containers like
 *                      the save-popup dialog) or 'vertical' (for
 *                      narrow contexts like the Time Modal's left
 *                      sidebar where 3 columns won't fit).
 *   className          extra class names appended to the outer flex
 *                      container.
 */
import { useProjectStore } from '../../store/projectStore'
import { SceneTimeChipContent, hasSceneTimeData } from '../nodes/SceneTimeRow'
import { formatGap, looserTier, sceneBucket } from '../../utils/scenetimeVerbiage'

function capitalizeFirst(s) {
  if (typeof s !== 'string' || s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

// Small "● Previous scene" / "● This scene" label rendered at the
// top-left of each summary block when labels are provided. Bullet
// glyph is just punctuation — keeps the badge compact at small sizes.
function SceneBadgeLabel({ text }) {
  return (
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
      <span aria-hidden>●</span>
      <span>{text}</span>
    </div>
  )
}

export default function ScenetimePassedVisual({
  priorSceneData = null,
  currentSceneData = null,
  gapMinutes = 0,
  dayShift = null,
  accentColour = null,
  orientation = 'horizontal',
  priorLabel = null,
  currentLabel = null,
  className = '',
  // Behaviour-neutral help-region passthrough. Defaults to the shared
  // concept key for this reused visual; the Scene Time modal's
  // prior-context section also carries its own mount-site key.
  dataHelpRegion = 'scene-time:time_passed_visual',
}) {
  const timeFormat = useProjectStore((s) => (s.story?.time_format === '24h' ? '24h' : '12h'))

  const priorTier   = priorSceneData?.time_of_day_tier ?? null
  const currentTier = currentSceneData?.time_of_day_tier ?? null
  const tier = looserTier(priorTier, currentTier)
  // Bucket-aware phrasing: when both scenes have a TOD pin, derive
  // their 5-bucket period names. dayShift carries the integer
  // calendar-day shift so formatGap can decide same-day / next-day /
  // multi-day from the actual chain-day positions instead of
  // approximating from gap_minutes alone.
  const priorBucket   = sceneBucket(priorSceneData)
  const currentBucket = sceneBucket(currentSceneData)
  // Slice 3 — weekday-only Family 3 phrasing fires when current scene
  // pinned a weekday but no TOD bucket. Pass both weekdays so future
  // slices can combine bucket + weekday.
  const priorWeekday = (typeof priorSceneData?.weekday === 'number'
    && priorSceneData.weekday >= 0 && priorSceneData.weekday <= 6)
    ? priorSceneData.weekday : null
  const currentWeekday = (typeof currentSceneData?.weekday === 'number'
    && currentSceneData.weekday >= 0 && currentSceneData.weekday <= 6)
    ? currentSceneData.weekday : null
  // Labelled TOD names — formatGap uses these for sub-bucket
  // preservation when both scenes pin the same labelled name (e.g.
  // both at "Sunset" → "the next day, at sunset" rather than
  // collapsing to the 5-bucket "evening"). Locally-named variables
  // because the `priorLabel` / `currentLabel` props above are
  // block-heading text ("Previous scene" / "This scene") used by
  // SceneBadgeLabel — distinct from the TOD label.
  const priorTodLabel   = priorSceneData?.time_of_day_labelled ?? null
  const currentTodLabel = currentSceneData?.time_of_day_labelled ?? null
  // Slice 4 — date-only Family 4 fires when the current scene pins a
  // month + day_of_month but no TOD bucket and no weekday. Pass both
  // sides so future slices can combine date with bucket / weekday.
  const priorDateMonth   = (typeof priorSceneData?.date_month === 'number') ? priorSceneData.date_month : null
  const priorDateDay     = (typeof priorSceneData?.date_day_of_month === 'number') ? priorSceneData.date_day_of_month : null
  const currentDateMonth = (typeof currentSceneData?.date_month === 'number') ? currentSceneData.date_month : null
  const currentDateDay   = (typeof currentSceneData?.date_day_of_month === 'number') ? currentSceneData.date_day_of_month : null
  const gapPhrase = capitalizeFirst(formatGap(gapMinutes, 'compact-gap', {
    tier,
    timeFormat,
    priorBucket,
    currentBucket,
    priorWeekday,
    currentWeekday,
    priorLabel: priorTodLabel,
    currentLabel: currentTodLabel,
    priorDateMonth,
    priorDateDay,
    currentDateMonth,
    currentDateDay,
    dayShift,
  }))

  const hasPrior   = !!priorSceneData && hasSceneTimeData(priorSceneData)
  const hasCurrent = !!currentSceneData && hasSceneTimeData(currentSceneData)

  const isVertical = orientation === 'vertical'
  const containerClass = isVertical
    ? 'flex flex-col items-stretch gap-2'
    : 'flex flex-row items-stretch gap-3'

  const summaryBoxClass = isVertical
    ? 'w-full flex flex-col rounded-md border border-zinc-700/60 bg-zinc-900/40 px-3 py-2'
    : 'flex-1 min-w-0 flex flex-col rounded-md border border-zinc-700/60 bg-zinc-900/40 px-3 py-2'

  const gapBlockClass = isVertical
    ? 'flex flex-col items-center justify-center py-1'
    : 'flex flex-col items-center justify-center px-2'

  return (
    <div className={`${containerClass} ${className}`} data-help-region={dataHelpRegion}>
      {priorSceneData ? (
        <div className={summaryBoxClass}>
          {priorLabel ? <SceneBadgeLabel text={priorLabel} /> : null}
          <div className="flex items-center justify-center flex-1">
            {hasPrior ? (
              <SceneTimeChipContent
                sceneData={priorSceneData}
                accentColour={accentColour}
              />
            ) : (
              <span className="flex-1 text-[10px] italic text-zinc-500 text-center">
                No time data pinned
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Middle: prominent gap descriptor. Same phrase the scene-card
          chip uses for its leading segment, just rendered at a larger
          size + semibold weight so the writer's eye lands on the
          magnitude first. */}
      <div className={gapBlockClass}>
        <div className="text-base font-semibold text-zinc-100 text-center leading-snug">
          {gapPhrase}
        </div>
      </div>

      {currentSceneData ? (
        <div className={summaryBoxClass}>
          {currentLabel ? <SceneBadgeLabel text={currentLabel} /> : null}
          <div className="flex items-center justify-center flex-1">
            {hasCurrent ? (
              <SceneTimeChipContent
                sceneData={currentSceneData}
                accentColour={accentColour}
              />
            ) : (
              <span className="flex-1 text-[10px] italic text-zinc-500 text-center">
                No time data pinned
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
