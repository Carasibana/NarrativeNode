/**
 * Phase 1.23 — Scene Time Modal (canonical editor).
 *
 * Four sections matching planning doc §9.1:
 *   1. Prior scene context  — read-only floor summary (placeholder
 *      until step 7's POV-chain time walker lands).
 *   2. When this scene takes place — Time of Day + Day-of-week +
 *      Season + Date carousels.
 *   3. Time passed between scenes — Time Since Last Scene field
 *      (placeholder until step 6).
 *   4. This scene's duration — Scene Duration carousel.
 *
 * Modal chrome: Save / Cancel buttons in the footer. Cancel discards
 * in-modal edits and closes. ✕ in the header behaves the same as
 * Cancel. Internal draft state — caller passes `initialState` and
 * receives the final state via `onSave`.
 */
import { useState, useEffect } from 'react'
import { confirm } from '../../store/dialogStore'
import TimeOfDayCarousel, { collapseExactToLabelled } from '../ui/TimeOfDayCarousel'
import { SeasonRow, DateCarousel } from '../ui/DayCarousels'
import SceneDurationCarousel, {
  timeOfDayDraftToBucket,
} from '../ui/SceneDurationCarousel'
import TimeSinceLastSceneField from '../ui/TimeSinceLastSceneField'
import { walkOneStep, timeDeltaToMinutes } from '../../utils/povChainTimeWalker'
import { formatGap, formatTimeAtTier, looserTier, sceneBucket } from '../../utils/scenetimeVerbiage'
import { useAccentColor } from '../../utils/povConstants'
import { weekdayName } from '../../utils/calendarConventions'
import { NodeBadge } from '../ui/IdentityBadges'
import { SceneTimeChipContent, ClockIcon } from '../nodes/SceneTimeRow'
import ScenetimePassedVisual from '../ui/ScenetimePassedVisual'

// Build the modal's internal draft shape from a SceneNode's pinned
// time fields. Produces an empty draft if `node` is null / has no
// time data, so the modal opens cleanly on a brand-new scene.
export function sceneNodeToDraft(node) {
  if (!node) return emptyDraft()
  const d = node
  return {
    timeOfDay: {
      activeTier: d.time_of_day_tier ?? 'labelled',
      drafts: {
        broad:    d.time_of_day_broad    ?? null,
        labelled: d.time_of_day_labelled ?? null,
        exact:    d.time_of_day_exact    ?? null,
      },
    },
    weekday: d.weekday ?? null,
    season:  d.season  ?? null,
    date: {
      enabled: {
        // Weekday latch defaults on so a fresh / no-date scene opens
        // with the weekday picker visible. Stays on whenever weekday
        // is pinned, and stays on when no date data is pinned at all.
        // It only switches off when the writer pinned month / day
        // without a weekday.
        weekday: d.weekday != null
          || (d.date_month == null && d.date_day_of_month == null),
        month:   d.date_month != null,
        day:     d.date_day_of_month != null,
      },
      values: {
        weekday:  d.weekday ?? null,
        monthIdx: d.date_month != null ? d.date_month - 1 : null,
        day:      d.date_day_of_month ?? null,
      },
    },
    gapExtension: d.gap_extension ?? null,
    duration: durationToDraft(d.scene_duration),
  }
}

function durationToDraft(persisted) {
  // Combined "Length" stop (numeric) replaces the v0.1.23.x split
  // minutes / hours / days stops with one stop carrying a value +
  // unit dropdown. Persisted shape stays per-unit (kind:'minutes' /
  // 'hours' / 'days') for backwards compat; the draft's numeric.unit
  // selects which one we save under.
  const drafts = {
    ambiguous:  {},
    numeric:    { value: null, unit: 'hours' },
    all_period: {},
    span:       { endPeriod: null },
    all_day:    { variant: null },
  }
  let activeStop = 'ambiguous'
  if (persisted && persisted.kind) {
    if (persisted.kind === 'minutes' || persisted.kind === 'hours' || persisted.kind === 'days') {
      activeStop = 'numeric'
      drafts.numeric = { value: persisted.value ?? null, unit: persisted.kind }
    } else if (persisted.kind === 'span') {
      activeStop = 'span'
      drafts.span = { endPeriod: persisted.end_period ?? null }
    } else if (persisted.kind === 'all_day') {
      activeStop = 'all_day'
      drafts.all_day = { variant: persisted.all_day_variant ?? null }
    } else {
      activeStop = persisted.kind
    }
  }
  return { activeStop, drafts }
}

// Build the persisted SceneNode patch (subset of fields) from a
// modal draft. Tier discriminators control which leaf fields are
// written; null clears the pin.
export function draftToSceneNodePatch(draft) {
  const patch = {}

  // Time of Day
  const todTier = draft.timeOfDay?.activeTier ?? null
  const todDrafts = draft.timeOfDay?.drafts ?? {}
  if (todTier && todDrafts[todTier] != null) {
    patch.time_of_day_tier     = todTier
    patch.time_of_day_broad    = todTier === 'broad'    ? todDrafts.broad    : null
    patch.time_of_day_labelled = todTier === 'labelled' ? todDrafts.labelled : null
    patch.time_of_day_exact    = todTier === 'exact'    ? todDrafts.exact    : null
  } else {
    patch.time_of_day_tier     = null
    patch.time_of_day_broad    = null
    patch.time_of_day_labelled = null
    patch.time_of_day_exact    = null
  }

  // Date latches — independent toggles for weekday / month / day.
  const dateEnabled = draft.date?.enabled ?? { weekday: false, month: false, day: false }
  const dateValues  = draft.date?.values  ?? { weekday: null, monthIdx: null, day: null }
  patch.weekday = dateEnabled.weekday ? dateValues.weekday : null
  patch.date_month = dateEnabled.month && dateValues.monthIdx != null
    ? dateValues.monthIdx + 1 : null
  patch.date_day_of_month = dateEnabled.day ? dateValues.day : null
  // Tier discriminator so loaders know which leaves are populated.
  if (patch.date_day_of_month != null) {
    patch.date_tier = 'month_day_dow'
  } else if (patch.date_month != null) {
    patch.date_tier = 'month_dow'
  } else if (patch.weekday != null) {
    patch.date_tier = 'weekday'
  } else {
    patch.date_tier = null
  }

  patch.season = draft.season ?? null
  patch.gap_extension = draft.gapExtension ?? null
  patch.scene_duration = draftToDuration(draft.duration)
  return patch
}

function draftToDuration(durDraft) {
  if (!durDraft || !durDraft.activeStop) return null
  const stop = durDraft.activeStop
  const stopDraft = durDraft.drafts?.[stop] ?? {}
  if (stop === 'ambiguous') return null
  if (stop === 'numeric') {
    // Numeric stop persists per-unit (kind: 'minutes' | 'hours' |
    // 'days') so existing walker / display code keeps working without
    // a model migration. The unit comes from the draft's dropdown.
    const unit = stopDraft.unit || 'hours'
    return { kind: unit, value: stopDraft.value ?? null }
  }
  if (stop === 'span') {
    return { kind: 'span', end_period: stopDraft.endPeriod ?? null }
  }
  if (stop === 'all_day') {
    return { kind: 'all_day', all_day_variant: stopDraft.variant ?? null }
  }
  return { kind: stop }
}

// Default empty draft state — all carousels at their default tier /
// stop with no values pinned.
function emptyDraft() {
  return {
    timeOfDay: {
      activeTier: 'labelled',
      drafts: { broad: null, labelled: null, exact: null },
    },
    weekday: null,
    season: null,
    date: {
      enabled: { weekday: true, month: false, day: false },
      values:  { weekday: null, monthIdx: null, day: null },
    },
    gapExtension: null,  // TimeDelta | null  — Time Since Last Scene override
    duration: {
      activeStop: 'ambiguous',
      drafts: {
        ambiguous:  {},
        numeric:    { value: null, unit: 'hours' },
        all_period: {},
        span:       { endPeriod: null },
        all_day:    { variant: null },
      },
    },
  }
}

// Section header — small uppercase label + a thin divider underneath.
function SectionHeader({ children, disabled = false }) {
  return (
    <div className={`flex items-center gap-2 mb-2 ${disabled ? 'opacity-50' : ''}`}>
      <h3 className="text-[10px] uppercase tracking-widest font-semibold text-zinc-400">
        {children}
      </h3>
      <div className="flex-1 border-t border-zinc-800" />
    </div>
  )
}

// Section 1 — prior scene context (planning doc §9.1, fed by the
// step 9 POV-chain walker). Renders the prior scene's NodeBadge +
// the same compact time chip used on the scene-card row, so the
// writer sees a faithful echo of how the prior scene's pinned time
// data looks. Both pieces are imported from their canonical
// sources — no duplication.
function PriorSceneContextSection({
  isFirstScene = false,
  priorNodeId = null,
  priorSceneData = null,
  currentSceneData = null,
  gapMinutes = 0,
  dayShift = null,
  accentColour = null,
}) {
  return (
    <section data-help-region="scene-time:prior_context">
      <SectionHeader disabled={isFirstScene}>Prior scene context</SectionHeader>
      {isFirstScene ? (
        <p className="text-[11px] text-zinc-500 italic">
          This is the first POV scene of the story — no prior scene to reference.
        </p>
      ) : !priorNodeId ? (
        <p className="text-[11px] text-zinc-500 italic">
          This scene isn't on the POV chain yet — no prior scene to reference.
        </p>
      ) : (
        <ScenetimePassedVisual
          priorSceneData={priorSceneData}
          currentSceneData={currentSceneData}
          gapMinutes={gapMinutes}
          dayShift={dayShift}
          accentColour={accentColour}
          orientation="vertical"
          priorLabel="Previous scene"
          currentLabel="This scene"
        />
      )}
    </section>
  )
}

// Section 2 — When this scene takes place. Holds the four
// independent carousels: Time of Day, Season, Date. Day-of-week is
// folded into the Date carousel as its least-granular tier.
//
// Time of Day uses the tilted-branch variant; the carousel and
// the Season row are centred horizontally within the section.
function WhenSection({
  timeOfDayState, onTimeOfDayChange,
  season, onSeasonChange,
  dateState, onDateChange,
  weekStart, timeFormat, bgColour,
  priorSceneData, priorAccent,
}) {
  // Phase 1.23 audit step (12) — prior-spot indicator. Pull the
  // immediate prior POV-chain scene's pinned values for weekday /
  // month / day so the Date carousel can render a dashed accent
  // ring on the matching button(s) — visual hint of where the chain
  // currently sits regardless of what the writer's about to pick.
  const priorValues = {
    weekday:  (typeof priorSceneData?.weekday === 'number') ? priorSceneData.weekday : null,
    monthIdx: (typeof priorSceneData?.date_month === 'number') ? priorSceneData.date_month - 1 : null,
    day:      (typeof priorSceneData?.date_day_of_month === 'number') ? priorSceneData.date_day_of_month : null,
  }
  return (
    <section data-help-region="scene-time:when">
      <SectionHeader>When this scene takes place</SectionHeader>
      <div className="space-y-4">
        <div data-help-region="scene-time:time_of_day">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 text-center">Time of Day</div>
          <div className="flex justify-center">
            <TimeOfDayCarousel
              state={timeOfDayState}
              onChange={onTimeOfDayChange}
              timeFormat={timeFormat}
              bgColour={bgColour}
              tilted
            />
          </div>
        </div>
        <div data-help-region="scene-time:season">
          <div className="relative text-[11px] uppercase tracking-wider text-zinc-500 mb-1 text-center">
            Season
            {/* Season is non-constraining context. The "i" badge
                anchors absolutely after the centred header so it
                doesn't push "Season" off centre. */}
            <span
              className="absolute top-1/2 -translate-y-1/2 ml-1.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-zinc-600 text-zinc-500 text-[8px] leading-none cursor-help font-bold"
              title={
                'Season is non-constraining context. It does not affect when this scene can happen. '
                + 'Different parts of the world experience different seasons at the same time of year '
                + '(a protagonist flying from Canada to Australia in January goes from winter to summer).'
              }
              aria-label="Season is non-constraining context and does not affect scene time"
            >
              i
            </span>
          </div>
          <div className="flex justify-center">
            <SeasonRow value={season} onChange={onSeasonChange} />
          </div>
        </div>
        <div data-help-region="scene-time:date">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Date</div>
          <DateCarousel
            state={dateState}
            onChange={onDateChange}
            weekStart={weekStart}
            priorValues={priorValues}
            priorAccent={priorAccent}
          />
        </div>
      </div>
    </section>
  )
}

// Section 3 — Time Since Last Scene extension. The time-passed
// visual moved up into the Prior Scene Context section to eliminate
// duplication of the prior chip; this section now carries just the
// extension input + breakdown.
function TimeSinceSection({
  value,
  onChange,
  isFirstScene = false,
  allowNegative = false,
  defaultUnit = 'hours',
  breakdown = null,
}) {
  return (
    <section data-help-region="scene-time:gap">
      <SectionHeader disabled={isFirstScene}>Add extra time since last scene</SectionHeader>
      <TimeSinceLastSceneField
        value={value}
        onChange={onChange}
        isFirstScene={isFirstScene}
        allowNegative={allowNegative}
        defaultUnit={defaultUnit}
        breakdown={breakdown}
      />
    </section>
  )
}

function DurationSection({ state, onChange, startBucket, startTimeOfDayLabel }) {
  return (
    <section data-help-region="scene-time:duration">
      <SectionHeader>This scene's duration</SectionHeader>
      <SceneDurationCarousel
        state={state}
        onChange={onChange}
        startBucket={startBucket}
        startTimeOfDayLabel={startTimeOfDayLabel}
      />
    </section>
  )
}

export default function SceneTimeModal({
  open,
  onClose,
  onSave,
  initialState = null,
  sceneTitle = 'Untitled Scene',
  sceneId = null,
  isFirstScene = false,
  weekStart = 'sunday',
  timeFormat = '12h',
  allowNegative = false,
  priorNodeId = null,
  priorSceneData = null,
  priorEffectiveMinutes = null,
  priorDurationMinutes = null,
  chainOriginWeekday = 0,
  chainOriginDayOfYear = 0,
  originIsLeap = false,
  prevFeb29ChainDay = null,
  nodes = null,
  entityMap = null,
  accentColour = null,
  defaultGapUnit = 'hours',
}) {
  // Internal draft state. Resets to `initialState` whenever the modal
  // re-opens (handled via the `key` trick on the calling site, or by
  // re-mounting the component).
  const [draft, setDraft] = useState(() => initialState ?? emptyDraft())
  // Story accent colour for the prior-spot dashed indicator on the
  // Date carousel button rows (audit step 12). Falls back to the
  // accent palette default when no story accent is configured.
  const storyAccent = useAccentColor()

  // Dirty-guard baseline — frozen at mount via the same source as
  // the draft initialiser. JSON.stringify-compare is fine here: the
  // draft is a small structured object with no functions / Map /
  // Set values.
  const baselineSnapshot = JSON.stringify(initialState ?? emptyDraft())
  const isDirty = JSON.stringify(draft) !== baselineSnapshot

  // Esc key intercept — only registered while open. Routes through
  // tryClose so the dirty prompt fires when there are unsaved edits.
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        tryClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDirty, draft])

  if (!open) return null

  const bgColour = '#18181b'

  const startTimeOfDayLabel = draft.timeOfDay?.drafts?.labelled ?? null
  // startBucket is derived from whichever tier is currently ACTIVE on
  // the timeOfDay carousel — broad / labelled / exact each map to a
  // 5-bucket period via timeOfDayDraftToBucket. This drives the
  // All-Day toggle pair's day-vs-night layout (and its visibility
  // gate) so the writer's tier choice + value choice both flow into
  // the variant widget without going stale on tier switches.
  const startBucket = timeOfDayDraftToBucket(draft.timeOfDay)

  // Live walker breakdown for Section 3. Recomputed every render
  // so the headline + factor list update in real time as the writer
  // edits Time of Day / Duration / Gap Extension. Tells the writer
  // (and downstream AI context) exactly how much time MUST have
  // passed since the prior scene given their current draft, plus
  // why — so they can either treat it as constraint context or
  // adjust pinned values to match their intent.
  let breakdown = null
  let livePatchForVisual = null
  let liveGapMinutes = 0
  let liveDayShift = null
  if (!isFirstScene && Number.isFinite(priorEffectiveMinutes)) {
    const livePatch = draftToSceneNodePatch(draft)
    livePatchForVisual = livePatch
    const step = walkOneStep({
      priorEffectiveMinutes,
      priorDurationMinutes,
      priorScene: priorSceneData,
      scene: livePatch,
      allowNegative,
      chainOriginWeekday,
      chainOriginDayOfYear,
      originIsLeap,
      prevFeb29ChainDay,
    })
    const priorEndAbs = priorEffectiveMinutes + (priorDurationMinutes ?? 0)
    liveGapMinutes = step.effectiveStartMinutes - priorEndAbs
    // Calendar-day shift between prior_end and current_start. Drives
    // "later that day" vs "the next day" vs "{N} days later" without
    // mis-classifying boundary cases (e.g., prior 8 AM + 12h = 8 PM
    // same day, gap = 12h, but dayShift = 0 → "later that day").
    liveDayShift = Math.floor(step.effectiveStartMinutes / (24 * 60))
                 - Math.floor(priorEndAbs / (24 * 60))
    // The walker's clock is internally minute-precise so floor /
    // snap math works, but the breakdown must NEVER claim more
    // precision than the writer committed to. e.g. if the prior
    // scene was pinned at "Sunset" (Tier-2 label), saying
    // "5:45 PM (Sunset)" would falsely assert the writer chose
    // 5:45. The label alone is what they pinned. Tier-aware
    // formatting downgrades each rendered time to the writer's
    // actual granularity.
    const priorTier = priorSceneData?.time_of_day_tier ?? null
    const thisTier  = livePatch.time_of_day_tier ?? null
    // The floor's expression-tier is the prior's tier — the floor
    // is derived from the prior scene's start, never more precise
    // than that pin.
    const floorTier = looserTier(priorTier)

    const factors = []
    const priorTimeText = formatTimeAtTier(priorEffectiveMinutes, 'value', { tier: priorTier, timeFormat })
    if (priorTimeText) {
      factors.push(`Prior scene started at ${priorTimeText}`)
    } else {
      factors.push(`Prior scene's start time isn't pinned, so the floor is fuzzy`)
    }
    if (priorDurationMinutes != null && priorDurationMinutes > 0) {
      factors.push(`Prior scene took ${formatGap(priorDurationMinutes, 'gap-magnitude').replace(/^\+/, '')}`)
    } else {
      factors.push(`Prior scene's duration is unspecified, so the floor stays at the prior scene's start time`)
    }
    // Floor factor — suppressed in same-label / same-broad cases
    // because the floor's representative-minute can land in a
    // neighbouring label that the writer never asserted (e.g. LA
    // + 1hr → 16:45 = Sunset). When the writer pinned both scenes
    // at the same label / broad value, the walker has already
    // rejected the snap; leaking the boundary-derived label here
    // would re-introduce false precision.
    const sameLabel = !!(
      priorTier === 'labelled' && thisTier === 'labelled'
      && priorSceneData?.time_of_day_labelled
      && priorSceneData.time_of_day_labelled === livePatch.time_of_day_labelled
    )
    const sameBroad = !!(
      priorTier === 'broad' && thisTier === 'broad'
      && priorSceneData?.time_of_day_broad
      && priorSceneData.time_of_day_broad === livePatch.time_of_day_broad
    )
    if (!sameLabel && !sameBroad) {
      const floorText = formatTimeAtTier(step.floorMinutes, 'value', { tier: floorTier, timeFormat })
      if (floorText) {
        factors.push(`Earliest possible start (floor): ${floorText}`)
      }
    }
    if (step.snapForward) {
      const snapText = formatTimeAtTier(step.effectiveStartMinutes, 'value', { tier: thisTier, timeFormat })
      factors.push(
        snapText
          ? `Your Time of Day pin is earlier in the day than the floor — snap-forward to the next day's ${snapText}`
          : `Your Time of Day pin is earlier in the day than the floor — snap-forward to the next day's pin time`
      )
    }
    const ext = timeDeltaToMinutes(livePatch.gap_extension)
    if (ext > 0)      factors.push(`Manual extension applied: ${formatGap(ext, 'gap-magnitude')}`)
    else if (ext < 0) factors.push(`Manual extension applied (time travel): ${formatGap(ext, 'gap-magnitude')}`)
    // Headline gap respects the looser of the two scenes' tiers — a
    // labelled→broad span shouldn't claim minute precision the
    // writer never committed to. e.g. Late Afternoon (labelled) +
    // 1hr → Day (broad) lands at +17h internally but reads as
    // "the next day" because Day-tier is the looser anchor.
    //
    // The phrasing reports a CONSTRAINT, never a declaration. The
    // program tells the writer what their inputs imply about the
    // earliest the scene can be; what the scene actually is in the
    // story is the writer's call.
    // When BOTH scenes are at labelled tier, the writer is thinking
    // in label-of-day terms — say "Evening, same day" instead of
    // "6 hours after the previous scene ends". The day-offset comes
    // from comparing the day index of the effective start against
    // the prior's start.
    const gapTier = looserTier(priorTier, thisTier)
    const displayGapMinutes = step.effectiveStartMinutes - step.floorMinutes
    const bothLabelled = priorTier === 'labelled' && thisTier === 'labelled'
    let headline
    if (bothLabelled && livePatch.time_of_day_labelled) {
      const MIN_PER_DAY = 1440
      let dayOffset = Math.floor(step.effectiveStartMinutes / MIN_PER_DAY)
        - Math.floor(priorEffectiveMinutes / MIN_PER_DAY)
      // Midnight's representative anchor is the day's endpoint
      // (1440 minutes = 24:00). The day-floor math therefore
      // ticks the day index up by one when a scene lands exactly
      // on Midnight — but the writer means the END of the current
      // day, not the start of the next. Walk it back when the
      // effective lands at a day boundary AND this scene is
      // Midnight.
      if (
        livePatch.time_of_day_labelled === 'Midnight'
        && step.effectiveStartMinutes > 0
        && step.effectiveStartMinutes % MIN_PER_DAY === 0
      ) {
        dayOffset -= 1
      }
      // If the writer pinned a weekday on BOTH scenes, that
      // implies a specific day-offset (e.g. Sunday → Tuesday = 2
      // days). Use the larger of the writer's intended weekday
      // offset and the minute-derived offset — the writer's pin
      // pushes the floor up to that day, never down.
      const priorWd = priorSceneData?.weekday
      const thisWd  = livePatch.weekday
      let useOffset = dayOffset
      let weekdayPinName = null
      if (Number.isInteger(priorWd) && Number.isInteger(thisWd)) {
        let weekdayOffset = ((thisWd - priorWd) % 7 + 7) % 7
        // Same weekday + non-zero minute offset implies "next
        // [weekday]" a week later, not same day.
        if (weekdayOffset === 0 && dayOffset > 0) weekdayOffset = 7
        if (weekdayOffset > useOffset) useOffset = weekdayOffset
        weekdayPinName = weekdayName(thisWd)
      }
      let dayPhrase
      if (useOffset === 0) {
        dayPhrase = 'same day'
      } else if (useOffset === -1) {
        dayPhrase = 'the previous day'
      } else if (useOffset < 0) {
        dayPhrase = `${Math.abs(useOffset)} days earlier`
      } else if (weekdayPinName && useOffset >= 1 && useOffset <= 6) {
        // Same calendar week — natural prose anchors on the day name.
        dayPhrase = `on ${weekdayPinName}`
      } else if (weekdayPinName && useOffset >= 7 && useOffset <= 13) {
        // Next week — distinguish from same-week.
        dayPhrase = `the following ${weekdayPinName}`
      } else if (weekdayPinName) {
        // 14+ days out — fall back to explicit count for clarity.
        dayPhrase = `${weekdayPinName}, ${useOffset} days later`
      } else if (useOffset === 1) {
        dayPhrase = 'the next day'
      } else {
        dayPhrase = `${useOffset} days later`
      }
      headline = `Earliest this scene can be: ${livePatch.time_of_day_labelled}, ${dayPhrase}.`
    } else {
      // dayShift consistent with displayGapMinutes (overshoot from
      // floor) — "5 days later" here means 5 days beyond the natural
      // floor, not 5 days from prior end. Other enrichment opts are
      // threaded so multi-day overshoot phrases collapse correctly
      // (idiom collapses, anniversary detection, sub-bucket).
      const MIN_PER_DAY = 1440
      const overshootDayShift = Math.floor(step.effectiveStartMinutes / MIN_PER_DAY)
                              - Math.floor(step.floorMinutes / MIN_PER_DAY)
      const priorWeekday = (typeof priorSceneData?.weekday === 'number'
        && priorSceneData.weekday >= 0 && priorSceneData.weekday <= 6) ? priorSceneData.weekday : null
      const currentWeekday = (typeof livePatch?.weekday === 'number'
        && livePatch.weekday >= 0 && livePatch.weekday <= 6) ? livePatch.weekday : null
      const gapText = formatGap(displayGapMinutes, 'narrative-gap', {
        tier: gapTier,
        timeFormat,
        priorBucket: sceneBucket(priorSceneData),
        currentBucket: sceneBucket(livePatch),
        priorWeekday,
        currentWeekday,
        priorLabel: priorSceneData?.time_of_day_labelled ?? null,
        currentLabel: livePatch?.time_of_day_labelled ?? null,
        priorDateMonth: (typeof priorSceneData?.date_month === 'number') ? priorSceneData.date_month : null,
        priorDateDay: (typeof priorSceneData?.date_day_of_month === 'number') ? priorSceneData.date_day_of_month : null,
        currentDateMonth: (typeof livePatch?.date_month === 'number') ? livePatch.date_month : null,
        currentDateDay: (typeof livePatch?.date_day_of_month === 'number') ? livePatch.date_day_of_month : null,
        dayShift: overshootDayShift,
      })
      headline = `Earliest this scene can be: ${gapText}.`
    }
    breakdown = {
      headline,
      factors,
    }
  }

  const setTimeOfDayState = (next) => setDraft((d) => ({ ...d, timeOfDay: next }))
  const setSeason = (next) => setDraft((d) => ({ ...d, season: next }))
  const setDateState = (next) => setDraft((d) => ({ ...d, date: next }))
  const setDurationState = (next) => setDraft((d) => ({ ...d, duration: next }))
  const setGapExtension = (next) => setDraft((d) => ({ ...d, gapExtension: next }))

  async function handleSave() {
    // Save-draft confirmation popup (planning §10.1.X). Surfaces the
    // time-passed visual at the natural commitment point so the
    // writer sees the magnitude their settings imply BEFORE the
    // commit hits the chain. Skipped on the first POV-chain scene
    // (no prior to show a gap from) and when the prior's effective
    // start isn't pinned (the visual would have nothing meaningful
    // to render).
    const showPopup = !isFirstScene
      && Number.isFinite(priorEffectiveMinutes)
      && livePatchForVisual != null
    if (showPopup) {
      const result = await confirm({
        title: 'Confirm scene time',
        message: (
          <div className="space-y-2">
            <div className="text-[12px] text-zinc-300 leading-snug">
              Your settings mean:
            </div>
            <ScenetimePassedVisual
              priorSceneData={priorSceneData}
              currentSceneData={livePatchForVisual}
              gapMinutes={liveGapMinutes}
              dayShift={liveDayShift}
              accentColour={accentColour}
            />
          </div>
        ),
        buttons: [
          { label: 'Cancel',  value: 'cancel',  style: 'neutral' },
          { label: 'Confirm', value: 'confirm', style: 'primary' },
        ],
      })
      if (result !== 'confirm') return
    }
    if (typeof onSave === 'function') onSave(draft)
    onClose?.()
  }
  // Footer Cancel button — explicit user intent to discard, no prompt.
  function handleCancel() {
    onClose?.()
  }
  // Backdrop / Esc / ✕ — implicit dismissal. Prompt when there are
  // unsaved edits; clean dismissal closes immediately.
  async function tryClose() {
    if (!isDirty) {
      onClose?.()
      return
    }
    const result = await confirm({
      title: 'Unsaved changes',
      message: 'You have unsaved changes to this scene’s time data.',
      buttons: [
        { label: 'Keep editing',       value: 'cancel',  style: 'neutral' },
        { label: 'Discard & continue', value: 'discard', style: 'danger'  },
        { label: 'Save & continue',    value: 'save',    style: 'primary' },
      ],
    })
    if (result === 'cancel') return
    if (result === 'save' && typeof onSave === 'function') onSave(draft)
    onClose?.()
  }

  // ── "Set this scene to follow the previous scene" ─────────────
  // Computes the floor (prior_start + prior_duration), then writes
  // a new draft expressing that floor at the prior scene's tier
  // and copying the prior's date / weekday / season so the scene
  // reads as a same-day follow-on. Day rollover (floor crosses
  // midnight) advances weekday + day-of-month by one. The current
  // draft is replaced wholesale; if the writer already has time
  // settings, we prompt before overwriting.
  const priorTodTier = priorSceneData?.time_of_day_tier ?? null
  const followPrevAvailable =
    !isFirstScene
    && Number.isFinite(priorEffectiveMinutes)
    && priorTodTier != null

  function buildFollowPrevDraft() {
    const floorTotal = priorEffectiveMinutes + (priorDurationMinutes ?? 0)
    const minOfDay = ((floorTotal % 1440) + 1440) % 1440
    const dayRolled = floorTotal >= 1440
    const hh = String(Math.floor(minOfDay / 60)).padStart(2, '0')
    const mm = String(minOfDay % 60).padStart(2, '0')
    const hhmm = `${hh}:${mm}`

    let newTimeOfDay = null
    if (priorTodTier === 'broad') {
      const broad = (minOfDay >= 6 * 60 && minOfDay < 19 * 60) ? 'day' : 'night'
      newTimeOfDay = { activeTier: 'broad', drafts: { broad, labelled: null, exact: null } }
    } else if (priorTodTier === 'labelled') {
      const label = collapseExactToLabelled(hhmm)
      newTimeOfDay = { activeTier: 'labelled', drafts: { broad: null, labelled: label, exact: null } }
    } else if (priorTodTier === 'exact') {
      newTimeOfDay = { activeTier: 'exact', drafts: { broad: null, labelled: null, exact: hhmm } }
    }

    let newWeekday = priorSceneData?.weekday ?? null
    if (newWeekday != null && dayRolled) newWeekday = (newWeekday + 1) % 7
    const priorMonthIdx = (priorSceneData?.date_month != null) ? priorSceneData.date_month - 1 : null
    let newDayOfMonth = priorSceneData?.date_day_of_month ?? null
    if (newDayOfMonth != null && dayRolled) newDayOfMonth += 1
    const newSeason = priorSceneData?.season ?? null

    return {
      ...draft,
      timeOfDay: newTimeOfDay ?? draft.timeOfDay,
      weekday:   newWeekday,
      season:    newSeason,
      date: {
        enabled: {
          weekday: newWeekday != null,
          month:   priorMonthIdx != null,
          day:     newDayOfMonth != null,
        },
        values: {
          weekday:  newWeekday,
          monthIdx: priorMonthIdx,
          day:      newDayOfMonth,
        },
      },
      gapExtension: null,
    }
  }

  // Detect existing pinned data on the draft. If anything's already
  // set, we prompt before overwriting so the writer doesn't lose
  // edits accidentally.
  function draftHasTimeData() {
    const tod = draft.timeOfDay?.drafts ?? {}
    const todPinned = !!(tod.broad || tod.labelled || tod.exact)
    const datePinned = !!(draft.weekday != null || draft.season != null
      || draft.date?.values?.weekday != null
      || draft.date?.values?.monthIdx != null
      || draft.date?.values?.day != null)
    const gapPinned = !!draft.gapExtension
    return todPinned || datePinned || gapPinned
  }

  async function handleFollowPrevious() {
    if (!followPrevAvailable) return
    if (draftHasTimeData()) {
      const result = await confirm({
        title: 'Override scene time?',
        message: 'This will replace the time settings on this scene with values that follow on from the previous scene. Your current edits will be lost.',
        buttons: [
          { label: 'Cancel',           value: 'cancel',  style: 'neutral' },
          { label: 'Override',         value: 'confirm', style: 'danger'  },
        ],
      })
      if (result !== 'confirm') return
    }
    setDraft(buildFollowPrevDraft())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={tryClose}
    >
      <div
        data-help-region="scene-time:modal"
        className="w-[920px] max-h-[88vh] flex flex-col rounded shadow-2xl border border-zinc-700 overflow-hidden"
        style={{ backgroundColor: bgColour }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-3 py-2 border-b border-zinc-800 flex-shrink-0 gap-2">
          <ClockIcon size={14} style={accentColour ? { color: accentColour } : undefined} />
          <span className="text-[9px] text-accent-400 uppercase tracking-widest font-semibold bg-accent-900/30 px-1.5 py-0.5 rounded">
            Scene Time
          </span>
          <div className="flex-1 min-w-0 ml-3 flex items-center">
            {sceneId && nodes && entityMap ? (
              <NodeBadge nodeId={sceneId} nodes={nodes} entityMap={entityMap} />
            ) : (
              <span className="text-sm text-zinc-200 truncate">{sceneTitle}</span>
            )}
          </div>
          <button
            onClick={tryClose}
            className="text-zinc-500 hover:text-zinc-200 text-sm leading-none ml-2"
            title="Close"
          >✕</button>
        </div>

        {/* Body — two-column split.
            LEFT sidebar: prior scene context (top) + time since
            last scene (bottom) — both contextual / read-leaning,
            stacked.
            RIGHT main pane: when this scene takes place (top) +
            scene duration (bottom) — the writer's primary inputs.
            Sidebar is fixed-width; main pane gets the rest. */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <aside className="w-[260px] flex-shrink-0 border-r border-zinc-800 overflow-y-auto p-4 space-y-6 bg-zinc-950/40">
            <PriorSceneContextSection
              isFirstScene={isFirstScene}
              priorNodeId={priorNodeId}
              priorSceneData={priorSceneData}
              currentSceneData={livePatchForVisual}
              gapMinutes={liveGapMinutes}
              dayShift={liveDayShift}
              nodes={nodes}
              entityMap={entityMap}
              accentColour={accentColour}
            />
            {followPrevAvailable && (
              <button
                type="button"
                onClick={handleFollowPrevious}
                data-help-region="scene-time:follow_previous"
                className="w-full text-[11px] px-2 py-1.5 rounded border border-zinc-700 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 transition-colors text-left leading-snug"
                title="Set this scene's time to the earliest possible follow-on from the previous scene, at the previous scene's granularity."
              >
                Set this scene to follow the previous scene
              </button>
            )}
            <TimeSinceSection
              value={draft.gapExtension}
              onChange={setGapExtension}
              isFirstScene={isFirstScene}
              allowNegative={allowNegative}
              defaultUnit={defaultGapUnit}
              breakdown={breakdown}
            />
          </aside>
          <main className="flex-1 overflow-y-auto p-4 space-y-6">
            <WhenSection
              timeOfDayState={draft.timeOfDay}
              onTimeOfDayChange={setTimeOfDayState}
              season={draft.season}
              onSeasonChange={setSeason}
              dateState={draft.date}
              onDateChange={setDateState}
              weekStart={weekStart}
              timeFormat={timeFormat}
              bgColour={bgColour}
              priorSceneData={priorSceneData}
              priorAccent={storyAccent}
            />
            <DurationSection
              state={draft.duration}
              onChange={setDurationState}
              startBucket={startBucket}
              startTimeOfDayLabel={startTimeOfDayLabel}
            />
          </main>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-zinc-800 flex-shrink-0">
          <button
            type="button"
            onClick={handleCancel}
            className="text-xs px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="text-xs px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
