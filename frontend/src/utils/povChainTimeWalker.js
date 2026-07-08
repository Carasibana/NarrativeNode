/**
 * Phase 1.23 step 9 — POV-chain time walker (planning doc §6).
 *
 * Pure utility. Given a POV chain and per-scene pinned time data,
 * walks forward through the chain and produces, for each scene:
 *   - `floorMinutes`: the earliest start time this scene can have,
 *     measured in minutes since the chain's first scene anchor.
 *   - `effectiveStartMinutes`: the floor with `gap_extension` applied
 *     and snap-forward respected (the writer's pinned Time of Day, if
 *     any, snaps the start to the next future occurrence of that
 *     label).
 *   - `gapMinutes`: effective_start - prior_effective_start.
 *   - `snapForward`: true when a pinned Time of Day forced the scene
 *     past midnight to honour the label.
 *   - `isFirstScene`: true for the first scene on the chain.
 *
 * V1 scope (per planning §6.3):
 *   - Floor = prior_start + prior_duration. Ambiguous / blank durations
 *     contribute zero (start carries forward unchanged).
 *   - Time of Day labels contribute representative minute-of-day
 *     anchors. Tier-3 exact-clock pins use their literal HH:MM. Tier-1
 *     Day / Night pins coarse-anchor at mid-day / late-evening.
 *   - Snap-forward: if a pinned Time of Day's minute-of-day is before
 *     the post-floor effective minute-of-day, the scene advances to
 *     the next day's pin time. Weekday and date pins extend snap-
 *     forward to the corresponding axes (mod 7, leap-year-aware
 *     calendar respectively).
 *   - Weekday / month / day-of-month floor inference: a downstream pin
 *     advances the floor to the next occurrence of the pinned value,
 *     using a chain-relative weekday anchor and a leap-year-aware
 *     day-of-year anchor. Date wins over weekday when both are pinned.
 *   - Feb 29 leap-year handling: when any chain scene pins Feb 29 the
 *     chain origin's year is declared a 366-day leap year and leap
 *     years recur every 4 chain-years. The first Feb 29 lands on the
 *     earliest reachable Feb 29; subsequent Feb 29 pins collapse to
 *     the same chain Feb 29 unless the floor has passed it, in which
 *     case they snap forward exactly 4 calendar years (1461 days).
 *   - Scene Duration kinds: minutes / hours / days / weeks (numeric);
 *     all_day variants (all_day = ends 16:30 same day; all_night =
 *     ends midnight; until_next_evening = 16:30 next day); all_period
 *     ("All ___" = ends at next labelled period boundary on the
 *     current day, per planning §4.3); span ("___ to ___" = ends at
 *     the named end period). Variant=null on legacy saves silently
 *     loads as 'all_day'.
 *   - `last_known_floor_minutes` + `last_known_effective_minutes`
 *     baselines persist on each scene at save time; alert detection
 *     fires when EITHER the floor delta OR the effective-start delta
 *     exceeds the per-story `gap_shift_threshold`.
 *   - Same-instance suppression: when prior + current pin the same
 *     bucket / labelled / weekday at a magnitude that fits within
 *     the same chain instance, the walker stays put instead of
 *     jumping a 7-day cycle.
 *   - Allow Negative Time off → effective is clamped to floor (gap
 *     extension can never push below the floor).
 *
 * Out of scope for V1:
 *   - Year tracking + strict Gregorian calendar (parked V2 per §1.6).
 *     Years are inferred from chain-day arithmetic only; the writer
 *     never pins a year in V1.
 *
 * The walker has zero dependencies on React; the `useScenetimeWalk`
 * hook below is the React-aware adapter.
 */

const MIN_PER_DAY = 1440

// Representative minute-of-day for each Tier-2 label. Centred inside
// the label's boundary range from `collapseExactToLabelled` so a
// round-trip back through that helper recovers the original label.
//
// Midnight is the only special case — its boundary range (00:00-02:59
// + post-cycle wrap) makes "midnight" mean post-midnight wee hours. We
// represent it at 01:30 (90 minutes), and the walker's snap-forward
// logic + day-rollover handle the wraparound naturally so a Midnight
// pin after a Night pin lands on the next day's small hours, not the
// same day's pre-dawn.
const TOD_LABEL_MINUTES = {
  'Pre-Dawn':         4 * 60,            // midpoint of 03:00-04:59
  'Dawn':             5 * 60 + 15,       // midpoint of 05:00-05:29
  'Sunrise':          5 * 60 + 45,       // midpoint of 05:30-05:59
  'Early Morning':    7 * 60,            // midpoint of 06:00-07:59
  'Morning':          9 * 60,            // midpoint of 08:00-09:59
  'Late Morning':    10 * 60 + 45,       // midpoint of 10:00-11:29
  'Noon':            12 * 60,            // midpoint of 11:30-12:30
  'Afternoon':       13 * 60 + 45,       // midpoint of 12:31-14:59
  'Late Afternoon':  15 * 60 + 45,       // midpoint of 15:00-16:29
  'Sunset':          17 * 60 + 45,       // midpoint of 16:30-18:59
  'Evening':         20 * 60,            // midpoint of 19:00-20:59
  'Dusk':            21 * 60 + 30,       // midpoint of 21:00-21:59
  'Early Night':     22 * 60 + 30,       // midpoint of 22:00-22:59
  'Night':           23 * 60 + 30,       // midpoint of 23:00-23:59
  // Midnight is the cycle's endpoint — semantically the END of the
  // current day, not the start of the next. Anchor at 24:00 (1440)
  // so a scene pinned at Midnight after a same-day prior reads as
  // the same day's end rather than wrapping back to its post-midnight
  // start. The display path is fine: 1440 % 1440 = 0, which
  // back-collapses to "Midnight" via collapseExactToLabelled('00:00').
  'Midnight':        24 * 60,             // end-of-day endpoint, 1440
}

// Tier-1 Day / Night → coarse representative minute-of-day. Used only
// when the writer pinned the broad tier and didn't refine. Day = mid-
// morning, Night = late evening — generic enough to be useful, vague
// enough not to over-claim precision the writer didn't commit to.
const TOD_BROAD_MINUTES = {
  day:    9 * 60,
  night: 22 * 60,
}

function parseExactClock(hhmm) {
  if (typeof hhmm !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/**
 * Convert a scene's pinned Time of Day to a representative minute-
 * of-day (0..1439), or null if no Time of Day is pinned. Tier
 * discriminator (`time_of_day_tier`) decides which leaf field to
 * read; pre-1.23 scenes load with all fields null and return null.
 */
export function sceneStartMinutesOfDay(scene) {
  if (!scene) return null
  const tier = scene.time_of_day_tier
  if (tier === 'exact')    return parseExactClock(scene.time_of_day_exact)
  if (tier === 'labelled') return TOD_LABEL_MINUTES[scene.time_of_day_labelled] ?? null
  if (tier === 'broad')    return TOD_BROAD_MINUTES[scene.time_of_day_broad] ?? null
  return null
}

/**
 * Convert a scene's `scene_duration` to elapsed minutes, or null
 * when the duration contributes nothing to the floor (Ambiguous,
 * unset, or a kind whose duration depends on context the V1 walker
 * doesn't yet resolve — see module header).
 */
export function sceneDurationMinutes(scene) {
  const d = scene?.scene_duration
  if (!d || !d.kind || d.kind === 'ambiguous') return null
  if (d.kind === 'minutes')  return Number.isFinite(d.value) ? d.value      : null
  if (d.kind === 'hours')    return Number.isFinite(d.value) ? d.value * 60 : null
  if (d.kind === 'days')     return Number.isFinite(d.value) ? d.value * MIN_PER_DAY : null
  if (d.kind === 'all_day') {
    // Variant-aware "All Day" — variable duration anchored to the
    // scene's start. v0.1.23.x toggle-pair semantics: "All Day"
    // alone means "ends at end of daytime" (16:30 same day), not
    // a 24-hour block. The legacy variant=null state (pre-toggle-
    // pair saves) is silently repurposed to 'all_day' here so a
    // Sunday-all-day prior naturally ends at 16:30 Sunday rather
    // than Sunday+24h. Per the audit step (7) writer decision the
    // load-path-preserving normalisation is more important than the
    // old end-time semantic.
    const variant = d.all_day_variant || 'all_day'
    const start = sceneStartMinutesOfDay(scene)
    if (start == null) return MIN_PER_DAY
    let target
    if (variant === 'all_day')        target = 16 * 60 + 30   // start of evening period
    else if (variant === 'all_night') target = MIN_PER_DAY    // midnight (end of day cycle)
    else if (variant === 'until_next_evening' || variant === 'until_next_day') {
      // 'until_next_evening' is the v0.1.23.24+ name for the cross-
      // midnight variant. Legacy 'until_next_day' saves silently load
      // under the same end-of-next-day-evening semantic (16:30 of the
      // following day = 1440 + 990 = 2430 minutes from start of the
      // current chain-day). Pre-v0.1.23.24 saves end at ~6am next day
      // historically; those scenes shift forward by ~10.5h on load.
      target = MIN_PER_DAY + 16 * 60 + 30
    }
    else return MIN_PER_DAY
    const span = target - start
    // If start has already passed the variant's target on this day,
    // the writer's input is inconsistent with the chosen variant.
    // Fall back to a 24-hour block rather than producing a negative
    // duration.
    return span > 0 ? span : MIN_PER_DAY
  }
  // Context-aware kinds — both anchored to the 5-bucket period
  // vocabulary (planning doc §4.1.1). Implemented per §4.3 floor-
  // contribution table:
  //   'all_period' → next labelled period boundary on the current day
  //   'span'       → start of the named end period on the current day
  if (d.kind === 'all_period' || d.kind === 'span') {
    const startMin = sceneStartMinutesOfDay(scene)
    if (startMin == null) return null
    const startBucket = bucketForMinutes(startMin)
    if (!startBucket) return null
    if (d.kind === 'all_period') {
      const endMin = BUCKET_END_MINUTES[startBucket]
      const span = endMin - startMin
      return span > 0 ? span : null
    }
    // 'span' — needs end_period; if missing or same as start, behaves
    // identically to all_period (per the carousel comment that
    // "Morning → Morning" reads as "all Morning").
    const endPeriod = d.end_period
    if (!endPeriod || endPeriod === startBucket) {
      const endMin = BUCKET_END_MINUTES[startBucket]
      const span = endMin - startMin
      return span > 0 ? span : null
    }
    const endMin = BUCKET_START_MINUTES[endPeriod]
    if (!Number.isFinite(endMin)) return null
    let span = endMin - startMin
    // If the end period is earlier in the day than the start, the
    // span crosses midnight; add a full day so the floor lands the
    // following day's named period start.
    if (span <= 0) span += MIN_PER_DAY
    return span
  }
  return null
}

// 5-bucket period vocabulary boundaries. Buckets match the labelled
// tier's gearshift columns (TimeOfDayCarousel): each bucket's three
// labels span the bucket's start..end range. Closed-open intervals;
// each bucket's end is the next bucket's start. Night wraps midnight,
// so its END lives in the next day at 03:00 (when dawn starts again).
const BUCKET_START_MINUTES = {
  dawn:       3 * 60,          // 180   (Pre-Dawn opens cycle at 03:00)
  morning:    6 * 60,          // 360
  afternoon: 11 * 60 + 30,     // 690
  evening:   16 * 60 + 30,     // 990
  night:     22 * 60,          // 1320
}
const BUCKET_END_MINUTES = {
  dawn:       6 * 60,          // 360
  morning:   11 * 60 + 30,     // 690
  afternoon: 16 * 60 + 30,     // 990
  evening:   22 * 60,          // 1320
  night:     MIN_PER_DAY + 3 * 60,  // 1620 (next day's dawn start)
}

// Phantom-year calendar for date-pin floor inference (planning §3.4.1
// snap-forward). Cumulative day counts at the START of each month
// (0-indexed Jan = 0, Feb = 31, ...) in a NON-LEAP year. Leap-year
// math shifts March onwards by +1 to make room for Feb 29.
const MONTH_CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
const DAYS_IN_NORMAL_YEAR = 365
const DAYS_IN_LEAP_YEAR = 366
const FOUR_YEAR_LEAP_CYCLE = DAYS_IN_LEAP_YEAR + 3 * DAYS_IN_NORMAL_YEAR  // 1461
const FEB_29_DOY_LEAP = 31 + 28  // 59 (0-indexed Feb 29 in a leap year)
// Backwards-compat alias retained for any callers reaching for the
// old name; new code should use DAYS_IN_NORMAL_YEAR.
const DAYS_IN_PHANTOM_YEAR = DAYS_IN_NORMAL_YEAR

/**
 * Convert (month, day-of-month) to a 0-indexed day-of-year, leap-
 * year-aware. In a leap year, Feb 29 maps to day 59 and Mar onwards
 * shift by +1 to accommodate the extra Feb 29. In a non-leap year,
 * Feb 29 is invalid — returns null so the caller can decide whether
 * to treat the scene as "needs a leap year" or fall back.
 */
function monthDayToDayOfYear(month, day, isLeap = false) {
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12) return null
  const m = Math.floor(month)
  const d = Math.floor(day)
  if (m === 2 && d === 29) {
    return isLeap ? FEB_29_DOY_LEAP : null
  }
  const base = MONTH_CUMULATIVE_DAYS[m - 1] + (d - 1)
  return (isLeap && m >= 3) ? base + 1 : base
}

/**
 * True iff the given chain-year-index is a leap year. The chain's
 * leap-year cadence is anchored at year 0: when `originIsLeap` is
 * true, leap years are 0, 4, 8, 12, … When false, no chain year is
 * leap and Feb 29 pins are unreachable.
 */
function isChainLeapYear(yearIdx, originIsLeap) {
  return !!originIsLeap && (yearIdx % 4 === 0)
}

/**
 * Convert an "absolute" chain-day count (0 = year 0's day-of-year 0
 * = Jan 1 of the chain's first year) to `{ yearIdx, dayOfYear }`.
 * Year lengths follow the leap-year cadence above.
 */
function absChainDayToYearDoy(absDay, originIsLeap) {
  if (!originIsLeap) {
    const y = Math.floor(absDay / DAYS_IN_NORMAL_YEAR)
    const d = ((absDay % DAYS_IN_NORMAL_YEAR) + DAYS_IN_NORMAL_YEAR) % DAYS_IN_NORMAL_YEAR
    return { yearIdx: y, dayOfYear: d }
  }
  // 4-year cycle of 1461 days. Each cycle's first year (4k) is leap
  // (366 days); the rest (4k+1, 4k+2, 4k+3) are 365 days each.
  const cycle = Math.floor(absDay / FOUR_YEAR_LEAP_CYCLE)
  let res = absDay - cycle * FOUR_YEAR_LEAP_CYCLE
  if (res < 0) res += FOUR_YEAR_LEAP_CYCLE
  if (res < DAYS_IN_LEAP_YEAR) {
    return { yearIdx: cycle * 4, dayOfYear: res }
  }
  res -= DAYS_IN_LEAP_YEAR
  const yearInCycle = Math.floor(res / DAYS_IN_NORMAL_YEAR) + 1  // 1, 2, or 3
  return { yearIdx: cycle * 4 + yearInCycle, dayOfYear: res % DAYS_IN_NORMAL_YEAR }
}

/**
 * Inverse of `absChainDayToYearDoy`: chain-day where the given year
 * starts (its Jan 1 / day-of-year 0).
 */
function yearStartAbsChainDay(yearIdx, originIsLeap) {
  if (!originIsLeap) return yearIdx * DAYS_IN_NORMAL_YEAR
  const cycle = Math.floor(yearIdx / 4)
  const r = yearIdx % 4
  return cycle * FOUR_YEAR_LEAP_CYCLE + (r === 0 ? 0 : DAYS_IN_LEAP_YEAR + (r - 1) * DAYS_IN_NORMAL_YEAR)
}

// Resolve a minute-of-day to its 5-bucket period via the half-open
// interval boundaries above. Used by the all_period / span Scene
// Duration kinds to identify which bucket the scene's start time
// falls in. Labelled-tier and exact-tier scenes both feed through
// `sceneStartMinutesOfDay` first, so this single minute-based
// mapping covers every TOD tier.
function bucketForMinutes(minutesOfDay) {
  const m = ((minutesOfDay % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY
  if (m >= BUCKET_START_MINUTES.dawn      && m < BUCKET_START_MINUTES.morning)   return 'dawn'
  if (m >= BUCKET_START_MINUTES.morning   && m < BUCKET_START_MINUTES.afternoon) return 'morning'
  if (m >= BUCKET_START_MINUTES.afternoon && m < BUCKET_START_MINUTES.evening)   return 'afternoon'
  if (m >= BUCKET_START_MINUTES.evening   && m < BUCKET_START_MINUTES.night)     return 'evening'
  return 'night'
}

/**
 * Convert a `TimeDelta` ({unit, value}) to a signed minute count.
 * Null / missing input returns 0.
 */
export function timeDeltaToMinutes(delta) {
  if (!delta) return 0
  const v = Number(delta.value) || 0
  if (delta.unit === 'minutes') return v
  if (delta.unit === 'hours')   return v * 60
  if (delta.unit === 'days')    return v * MIN_PER_DAY
  if (delta.unit === 'weeks')   return v * 7 * MIN_PER_DAY
  return 0
}

/**
 * Format a minute count back as a `TimeDelta` {unit, value}, picking
 * the largest unit the value cleanly divides into (weeks → days →
 * hours → minutes). Useful for default-unit selection on the
 * Time-Since-Last-Scene field.
 */
export function minutesToTimeDelta(minutes) {
  if (!Number.isFinite(minutes) || minutes === 0) return { unit: 'minutes', value: 0 }
  const sign = minutes < 0 ? -1 : 1
  const abs = Math.abs(minutes)
  if (abs % (7 * MIN_PER_DAY) === 0) return { unit: 'weeks',   value: sign * (abs / (7 * MIN_PER_DAY)) }
  if (abs % MIN_PER_DAY === 0)        return { unit: 'days',    value: sign * (abs / MIN_PER_DAY) }
  if (abs % 60 === 0)                 return { unit: 'hours',   value: sign * (abs / 60) }
  return { unit: 'minutes', value: sign * abs }
}

/**
 * Recommended unit for the Time-Since-Last-Scene field's default
 * dropdown selection — picks Minutes for sub-hour gaps, Hours for
 * sub-day, Days for sub-week, Weeks for week-or-longer (per planning
 * doc §5).
 */
export function recommendedUnitForGap(minutes) {
  if (!Number.isFinite(minutes) || minutes === 0) return 'hours'
  const abs = Math.abs(minutes)
  if (abs >= 7 * MIN_PER_DAY) return 'weeks'
  if (abs >= MIN_PER_DAY)     return 'days'
  if (abs >= 60)              return 'hours'
  return 'minutes'
}

/**
 * Compute one scene's walker output given the prior scene's
 * effective start + duration and this scene's pinned fields. Pure
 * — no chain traversal. The chain walker calls this in a loop;
 * UI surfaces (e.g. the Time Modal's live preview) call it
 * directly to recompute floor / effective as the writer edits a
 * draft, without re-walking the whole chain.
 *
 * @param {Object} args
 * @param {number} args.priorEffectiveMinutes
 * @param {?number} args.priorDurationMinutes  null = no duration
 *   contribution (start carries forward unchanged).
 * @param {Object} args.scene  scene-shaped fields (`time_of_day_*`,
 *   `scene_duration`, `gap_extension`). Same shape the persisted
 *   `SceneNode.data` carries; `draftToSceneNodePatch` produces a
 *   compatible object from a modal draft.
 * @param {boolean} args.allowNegative
 * @returns {{floorMinutes:number, effectiveStartMinutes:number,
 *   gapMinutes:number, snapForward:boolean}}
 */
export function walkOneStep({
  priorEffectiveMinutes,
  priorDurationMinutes,
  priorScene = null,
  scene,
  allowNegative = false,
  chainOriginWeekday = 0,
  chainOriginDayOfYear = 0,
  originIsLeap = false,
  prevFeb29ChainDay = null,
  hasUpstreamDateAnchor = false,
}) {
  const floor = priorEffectiveMinutes + (priorDurationMinutes ?? 0)
  const gapDelta = timeDeltaToMinutes(scene?.gap_extension)
  let effective = floor + gapDelta

  const pinTodMinutes = sceneStartMinutesOfDay(scene)
  const pinWeekday = (typeof scene?.weekday === 'number') ? scene.weekday : null
  const priorWeekday = (typeof priorScene?.weekday === 'number') ? priorScene.weekday : null
  // Date pin: scene's date_month + date_day_of_month (V2-reserved
  // date_year ignored for V1). When date is pinned, it WINS over
  // weekday — the walker snaps to the next occurrence of the date,
  // ignoring weekday-axis snap. This matches V1's "loose mode"
  // behaviour. Strict-mode date+weekday conflict resolution is
  // V2-parked (see Parked Ideas section in ToDo.md).
  //
  // CRITICAL: a date pin only triggers snap-forward when the chain
  // has an established upstream date anchor (set when the chain's
  // first scene pins a date, or when an earlier downstream scene's
  // date pin retroactively anchored the calendar — see
  // `walkPovChainTime` / `chainPreContextForScene`). Without an
  // anchor, treating chainOriginDayOfYear as Jan 1 by default would
  // make a downstream "Oct 17" pin snap 289 days forward as if the
  // chain started on Jan 1 — incorrect because the writer never
  // committed to a Jan 1 origin. When this scene is the FIRST date
  // pin in the chain, the pin is informational (it establishes the
  // calendar position at THIS scene); the floor advances only by
  // the natural prior_effective + prior_duration + gap_extension +
  // TOD snap. Subsequent date pins THEN have an anchor to snap
  // relative to.
  const pinDateMonth = (typeof scene?.date_month === 'number') ? scene.date_month : null
  const pinDateDay = (typeof scene?.date_day_of_month === 'number') ? scene.date_day_of_month : null
  const hasDatePinRaw = pinDateMonth != null && pinDateDay != null
  const hasDatePin = hasDatePinRaw && hasUpstreamDateAnchor
  let snapForward = false
  // Track WHICH pin kind caused the snap so readers can surface a
  // human-readable explanation. The three branches below each set
  // `snapForward = true` for distinct reasons; without the kind tag
  // the consumer can't tell whether the snap was a date pin, a
  // weekday pin, or a time-of-day pin. Surfaced 2026-05-18 in the
  // blind-agent rom-com test: agent saw snap_forward fire but the
  // response didn't explain why. NOTE: a snap means the FLOOR
  // (earliest possible start) moved forward to honour the pin — any
  // pinned `gap` is still applied ADDITIVELY on top of the snapped
  // floor, not in place of it.
  let snapReasonKind = null
  let snapReasonValue = null  // optional context: weekday name / TOD label / date string

  if (pinTodMinutes != null || pinWeekday != null || hasDatePin) {
    // Same-label / same-broad / same-weekday suppression.
    //
    // The walker's representative minute-of-day anchors (Late
    // Afternoon = 15:45, etc.) are arbitrary points the writer
    // never asserted. When both scenes are pinned at the SAME
    // Tier-2 label, the writer's intent is "these are in the same
    // instance of that label" — even if strict arithmetic on the
    // representative anchor would push past the label's boundary.
    // Forcing a next-day snap there falsely claims a precision
    // the writer didn't commit to. Same logic for broad-tier and
    // weekday pins (matching weekday on prior + current = "same
    // instance of that weekday", no week-jump).
    const sameLabel = !!(
      priorScene
      && priorScene.time_of_day_tier === 'labelled'
      && scene?.time_of_day_tier === 'labelled'
      && priorScene.time_of_day_labelled
      && priorScene.time_of_day_labelled === scene.time_of_day_labelled
    )
    const sameBroad = !!(
      priorScene
      && priorScene.time_of_day_tier === 'broad'
      && scene?.time_of_day_tier === 'broad'
      && priorScene.time_of_day_broad
      && priorScene.time_of_day_broad === scene.time_of_day_broad
    )
    const sameWeekday = !!(
      priorWeekday != null
      && pinWeekday != null
      && priorWeekday === pinWeekday
    )

    let dayBoundary = Math.floor(effective / MIN_PER_DAY) * MIN_PER_DAY
    if (hasDatePin) {
      // Date snap (date wins over weekday): advance the day-index to
      // the next occurrence of the pinned (month, day-of-month).
      //
      // Calendar model: the chain has variable-length years. When the
      // chain contains any Feb 29 pin, year 0 (the chain's first year)
      // is declared a 366-day leap year and subsequent leap years
      // recur on a 4-year cadence (years 0, 4, 8, …). Otherwise every
      // year is 365 days and Feb 29 pins are unreachable.
      //
      // Feb 29 special case: the FIRST Feb 29 pin lands on the earliest
      // reachable Feb 29 from the chain origin (origin year's Feb 29
      // when it's reachable, else year 4's). Subsequent Feb 29 pins
      // collapse to the same chain Feb 29 when the floor hasn't passed
      // it; otherwise they snap forward exactly 4 calendar years
      // (FOUR_YEAR_LEAP_CYCLE = 1461 days) to the next leap year.
      const effectiveDayIndex = Math.floor(effective / MIN_PER_DAY)
      const floorAbsDay = chainOriginDayOfYear + effectiveDayIndex
      const isFeb29Pin = pinDateMonth === 2 && pinDateDay === 29

      let targetAbsDay = null
      if (isFeb29Pin) {
        if (prevFeb29ChainDay == null) {
          // First Feb 29 in the chain. originIsLeap is true here
          // (pre-scan in walkPovChainTime sets it whenever any chain
          // scene pins Feb 29). Find the earliest leap year whose
          // Feb 29 is at-or-after the floor.
          const floorYearDoy = absChainDayToYearDoy(floorAbsDay, originIsLeap)
          const inLeap = isChainLeapYear(floorYearDoy.yearIdx, originIsLeap)
          let leapYearIdx
          if (inLeap && floorYearDoy.dayOfYear <= FEB_29_DOY_LEAP) {
            leapYearIdx = floorYearDoy.yearIdx
          } else {
            // Round up to next leap year (next multiple of 4 strictly
            // greater than the floor's current leap year, or the next
            // multiple of 4 strictly greater than the floor's year
            // index when the floor sits in a non-leap year).
            leapYearIdx = (Math.floor(floorYearDoy.yearIdx / 4) + 1) * 4
          }
          targetAbsDay = yearStartAbsChainDay(leapYearIdx, originIsLeap) + FEB_29_DOY_LEAP
        } else {
          const prevAbsDay = chainOriginDayOfYear + prevFeb29ChainDay
          if (floorAbsDay <= prevAbsDay) {
            targetAbsDay = prevAbsDay
          } else {
            targetAbsDay = prevAbsDay + FOUR_YEAR_LEAP_CYCLE
          }
        }
      } else {
        // Non-Feb-29 date: target is the next occurrence of (month,
        // day-of-month), respecting variable year lengths. Compute the
        // target's day-of-year relative to whichever year (floor's or
        // the next) it falls in, since leap years shift March-onwards
        // by +1 day.
        const floorYearDoy = absChainDayToYearDoy(floorAbsDay, originIsLeap)
        const isFloorYearLeap = isChainLeapYear(floorYearDoy.yearIdx, originIsLeap)
        const targetDoyThisYear = monthDayToDayOfYear(pinDateMonth, pinDateDay, isFloorYearLeap)
        if (targetDoyThisYear != null && targetDoyThisYear >= floorYearDoy.dayOfYear) {
          targetAbsDay = yearStartAbsChainDay(floorYearDoy.yearIdx, originIsLeap) + targetDoyThisYear
        } else {
          const nextYearIdx = floorYearDoy.yearIdx + 1
          const isNextYearLeap = isChainLeapYear(nextYearIdx, originIsLeap)
          const targetDoyNext = monthDayToDayOfYear(pinDateMonth, pinDateDay, isNextYearLeap)
          if (targetDoyNext != null) {
            targetAbsDay = yearStartAbsChainDay(nextYearIdx, originIsLeap) + targetDoyNext
          }
        }
      }

      if (targetAbsDay != null) {
        const targetChainDay = targetAbsDay - chainOriginDayOfYear
        const deltaDays = targetChainDay - effectiveDayIndex
        if (deltaDays > 0) {
          dayBoundary += deltaDays * MIN_PER_DAY
          snapForward = true
          snapReasonKind = 'date_pin'
          snapReasonValue = { month: pinDateMonth, day: pinDateDay }
        }
      }
    } else if (pinWeekday != null && !sameWeekday) {
      // Weekday snap: advance the floor day-index forward to the next
      // occurrence of the pinned weekday. Skipped when same-weekday
      // suppression applies, when a date is also pinned (date wins),
      // or when no weekday is pinned.
      const effectiveDayIndex = Math.floor(effective / MIN_PER_DAY)
      const effectiveWeekday = ((chainOriginWeekday + effectiveDayIndex) % 7 + 7) % 7
      const deltaDays = ((pinWeekday - effectiveWeekday) % 7 + 7) % 7
      if (deltaDays > 0) {
        dayBoundary += deltaDays * MIN_PER_DAY
        snapForward = true
        snapReasonKind = 'weekday_pin'
        snapReasonValue = pinWeekday
      }
    }

    // Time-of-day snap within the (possibly date- or weekday-shifted)
    // day.
    if (pinTodMinutes != null) {
      const candidate = dayBoundary + pinTodMinutes
      // Same-instance suppression: when prior + current pin matching
      // labels, broad values, OR weekday on the same chain-day, the
      // writer is treating both scenes as the same instance of that
      // anchor. The TOD pin then labels the scene without forcing a
      // day-jump even if its representative anchor lands earlier than
      // the post-floor effective minute. Without this rule a prior
      // Morning + 2hr → current Late Morning (representative 10:45 <
      // floor 11:00) would jump 7 days when weekday is matched, which
      // contradicts the writer's same-weekday intent.
      const suppressTodJump = sameLabel || sameBroad || sameWeekday
      if (suppressTodJump) {
        // Keep effective at floor + extension. The writer's matching
        // pin treats this as the same instance — no day jump for TOD.
        // Note: date / weekday snap above still applies if pinned.
        if (dayBoundary !== Math.floor(effective / MIN_PER_DAY) * MIN_PER_DAY) {
          // Date or weekday already pushed us forward; honour it.
          effective = candidate
        }
        // else: no change.
      } else if (candidate >= effective) {
        effective = candidate
      } else {
        // TOD pin lands earlier than effective on the snapped day.
        // If a date is pinned: jump forward to the next occurrence
        // of (date, TOD). For non-Feb-29 dates this is one calendar
        // year (year length depends on whether the candidate's year
        // is leap). For Feb 29 it is the 4-year leap cycle (1461
        // days). If a weekday is pinned: jump 7 days. Otherwise:
        // jump 1 day (existing TOD-only behaviour).
        if (hasDatePin) {
          const isFeb29Pin = pinDateMonth === 2 && pinDateDay === 29
          if (isFeb29Pin) {
            effective = candidate + FOUR_YEAR_LEAP_CYCLE * MIN_PER_DAY
          } else {
            const candidateAbsDay = chainOriginDayOfYear + Math.floor(candidate / MIN_PER_DAY)
            const candidateYear = absChainDayToYearDoy(candidateAbsDay, originIsLeap).yearIdx
            const yearLen = isChainLeapYear(candidateYear, originIsLeap)
              ? DAYS_IN_LEAP_YEAR
              : DAYS_IN_NORMAL_YEAR
            effective = candidate + yearLen * MIN_PER_DAY
          }
        } else if (pinWeekday != null) {
          effective = candidate + 7 * MIN_PER_DAY
        } else {
          effective = candidate + MIN_PER_DAY
        }
        snapForward = true
        // Only set the kind here if a prior branch (date/weekday)
        // didn't already classify it — those snaps are the deeper
        // cause when both are present.
        if (snapReasonKind == null) {
          snapReasonKind = 'time_of_day_pin'
          snapReasonValue = pinTodMinutes
        }
      }
    } else if (dayBoundary > Math.floor(effective / MIN_PER_DAY) * MIN_PER_DAY) {
      // Date- or weekday-only pin shifted us forward; effective
      // lands at the new day boundary, preserving the within-day
      // offset of the original effective minute.
      const effectiveTimeOfDay = effective % MIN_PER_DAY
      effective = dayBoundary + effectiveTimeOfDay
    }
  }

  if (!allowNegative && effective < floor) effective = floor

  // When this scene pinned Feb 29, report the chain-day index where
  // its Feb 29 landed so `walkPovChainTime` can thread the value into
  // `prevFeb29ChainDay` for the next step. Same Feb 29 vs +4 leap-
  // year decisions are made from this running anchor.
  let feb29ChainDayUsed = null
  if (scene?.date_month === 2 && scene?.date_day_of_month === 29) {
    feb29ChainDayUsed = Math.floor(effective / MIN_PER_DAY)
  }

  return {
    floorMinutes: floor,
    effectiveStartMinutes: effective,
    gapMinutes: effective - priorEffectiveMinutes,
    snapForward,
    snapReasonKind,
    snapReasonValue,
    feb29ChainDayUsed,
  }
}

/**
 * Walk the POV chain and produce per-scene time data.
 *
 * @param {Object} args
 * @param {string[]} args.orderedSceneIds  scene ids in POV chain order.
 * @param {Map<string, Object>} args.scenesById  scene id → scene `data` object.
 * @param {boolean} [args.allowNegative]  when true, gap_extension can
 *   drive effective below floor (time travel).
 * @returns {Map<string, Object>} per-scene walker output (see module header).
 */
export function walkPovChainTime({ orderedSceneIds, scenesById, allowNegative = false }) {
  const result = new Map()
  let prev = null

  // Pre-scan: declare the chain origin's year as a 366-day leap year
  // whenever ANY chain scene pins Feb 29. Otherwise every chain year
  // stays 365 days and Feb 29 pins are unreachable. The Gregorian
  // 4-year leap cadence then kicks in from year 0; subsequent leap
  // years occur at chain-year indices 4, 8, 12, …
  let originIsLeap = false
  for (const id of orderedSceneIds) {
    const s = scenesById.get(id)
    if (s?.date_month === 2 && s?.date_day_of_month === 29) {
      originIsLeap = true
      break
    }
  }

  // Chain-origin weekday anchor: if the first scene pins a weekday,
  // chain minute 0 corresponds to that weekday's 00:00. Otherwise
  // default to 0 (Sunday) — weekday math still works, downstream
  // weekday pins fire snap-forward against that implicit anchor.
  const firstScene = scenesById.get(orderedSceneIds[0])
  const chainOriginWeekday = (typeof firstScene?.weekday === 'number')
    ? firstScene.weekday
    : 0
  // Chain-origin day-of-year anchor: if the first scene pins a date
  // (month + day_of_month), chain minute 0 corresponds to that date
  // in the chain's first year. Origin Feb 29 only resolves to a real
  // day-of-year when origin is leap (always true at this point if the
  // origin scene itself pins Feb 29, since the pre-scan saw it).
  //
  // When the first scene has no date pin, chainOriginDayOfYear stays
  // unanchored — initialised to 0 only as a placeholder for downstream
  // arithmetic that will use it AFTER an anchor is established. The
  // `hasUpstreamDateAnchor` flag below gates date-snap behaviour in
  // walkOneStep so the unanchored placeholder is never used to drive
  // a snap (which would arbitrarily treat chain-minute 0 as Jan 1 and
  // make a downstream "Oct 17" pin jump the floor by 289 days). When
  // the FIRST downstream date pin lands, we retroactively compute
  // chainOriginDayOfYear so the chain becomes anchored at that scene
  // — subsequent date pins then snap normally relative to the now-
  // established anchor.
  const firstSceneDayOfYear = (
    typeof firstScene?.date_month === 'number'
    && typeof firstScene?.date_day_of_month === 'number'
  )
    ? monthDayToDayOfYear(firstScene.date_month, firstScene.date_day_of_month, originIsLeap)
    : null
  let chainOriginDayOfYear = firstSceneDayOfYear ?? 0
  let hasUpstreamDateAnchor = firstSceneDayOfYear != null

  // Running anchor for Feb 29 snap decisions: chain-day index where the
  // most recent Feb 29 was placed. null until the first Feb 29 is seen.
  let prevFeb29ChainDay = null

  for (let i = 0; i < orderedSceneIds.length; i++) {
    const id = orderedSceneIds[i]
    const scene = scenesById.get(id)
    if (!scene) continue

    if (prev == null) {
      // First scene anchors the chain. Effective start = its own
      // pinned Time of Day if any, else 0. Floor matches effective
      // (no prior to push it forward).
      const start = sceneStartMinutesOfDay(scene) ?? 0
      result.set(id, {
        isFirstScene: true,
        floorMinutes: start,
        effectiveStartMinutes: start,
        gapMinutes: 0,
        snapForward: false,
      })
      prev = { sceneId: id, scene, effectiveStartMinutes: start }
      // First-scene Feb 29 pin seeds the running anchor at chain-day 0
      // (origin year's Feb 29 lands exactly at the chain's day 0).
      if (scene?.date_month === 2 && scene?.date_day_of_month === 29) {
        prevFeb29ChainDay = Math.floor(start / MIN_PER_DAY)
      }
      continue
    }

    const step = walkOneStep({
      priorEffectiveMinutes: prev.effectiveStartMinutes,
      priorDurationMinutes:  sceneDurationMinutes(prev.scene),
      priorScene:            prev.scene,
      scene,
      allowNegative,
      chainOriginWeekday,
      chainOriginDayOfYear,
      originIsLeap,
      prevFeb29ChainDay,
      hasUpstreamDateAnchor,
    })
    result.set(id, { isFirstScene: false, ...step })
    prev = { sceneId: id, scene, effectiveStartMinutes: step.effectiveStartMinutes }
    if (step.feb29ChainDayUsed != null) {
      prevFeb29ChainDay = step.feb29ChainDayUsed
    }
    // Retroactive chain-origin anchor: when this scene is the FIRST
    // date pin in the chain, its effective minute landed at "wherever
    // the natural floor + TOD/weekday snap put it" without a date jump.
    // Establish chainOriginDayOfYear such that this scene's effective
    // chain-day maps to its pinned (month, day-of-month). Subsequent
    // downstream date pins then snap relative to this now-anchored
    // origin. Year-rollover for the retroactive math: if the pinned
    // day-of-year is less than the scene's chain-day-index (i.e. the
    // chain would need to wrap to "negative" days before the origin),
    // walk the origin's day-of-year BACKWARDS by adjusting modulo the
    // origin year's length. Multi-year backward walks are rare in
    // practice; clamp simple wrap once and trust subsequent date pins
    // to resolve via the normal forward arithmetic.
    if (!hasUpstreamDateAnchor
        && typeof scene?.date_month === 'number'
        && typeof scene?.date_day_of_month === 'number') {
      const sceneChainDay = Math.floor(step.effectiveStartMinutes / MIN_PER_DAY)
      const isOriginYearLeap = isChainLeapYear(0, originIsLeap)
      const pinnedDoy = monthDayToDayOfYear(scene.date_month, scene.date_day_of_month, isOriginYearLeap)
      if (pinnedDoy != null) {
        let originDoy = pinnedDoy - sceneChainDay
        // Single-year wrap if scene lands "after" the origin's year boundary.
        const yearLen = isOriginYearLeap ? DAYS_IN_LEAP_YEAR : DAYS_IN_NORMAL_YEAR
        while (originDoy < 0) originDoy += yearLen
        chainOriginDayOfYear = originDoy
      }
      hasUpstreamDateAnchor = true
    }
  }

  return result
}

/**
 * Helper used by AlertsPanel display to convert a stored floor
 * minute count back into the scene's effective start (with snap-
 * forward applied). Mirrors `walkOneStep`'s post-floor math without
 * needing a prior scene — pass the floor directly and the walker
 * applies extension + TOD / weekday / date snap as if it had just
 * computed the floor itself. Use this when you have a pre-computed
 * floor (e.g. captured at alert-detection time) and want the
 * effective value rendered consistently with the chip.
 *
 * Pre-context (`originIsLeap` and `prevFeb29ChainDay`) MUST come from
 * the actual chain walk up to (but not including) `scene` so Feb 29
 * decisions match what the chip is showing. Pass the values straight
 * through from `chainPreContextForScene`.
 */
export function snapEffectiveFromFloor({
  floorMinutes,
  scene,
  allowNegative = false,
  chainOriginWeekday = 0,
  chainOriginDayOfYear = 0,
  originIsLeap = false,
  prevFeb29ChainDay = null,
}) {
  if (!Number.isFinite(floorMinutes)) return null
  const step = walkOneStep({
    priorEffectiveMinutes: floorMinutes,
    priorDurationMinutes: 0,
    priorScene: null,
    scene,
    allowNegative,
    chainOriginWeekday,
    chainOriginDayOfYear,
    originIsLeap,
    prevFeb29ChainDay,
  })
  return step.effectiveStartMinutes
}

/**
 * Compute the chain pre-context an `snapEffectiveFromFloor` caller
 * needs to make Feb 29 decisions consistent with the chain's running
 * walk. Walks the POV chain up to (but not including) `targetSceneId`
 * and reports `{ originIsLeap, prevFeb29ChainDay, chainOriginWeekday,
 * chainOriginDayOfYear }`. When the target isn't on the chain or
 * isn't found, returns the chain's anchor values with
 * `prevFeb29ChainDay = null`.
 */
export function chainPreContextForScene({ orderedSceneIds, scenesById, targetSceneId }) {
  // Pre-scan for originIsLeap mirrors walkPovChainTime.
  let originIsLeap = false
  for (const id of orderedSceneIds) {
    const s = scenesById.get(id)
    if (s?.date_month === 2 && s?.date_day_of_month === 29) {
      originIsLeap = true
      break
    }
  }
  const firstScene = scenesById.get(orderedSceneIds[0])
  const chainOriginWeekday = (typeof firstScene?.weekday === 'number')
    ? firstScene.weekday
    : 0
  const firstSceneDayOfYear = (
    typeof firstScene?.date_month === 'number'
    && typeof firstScene?.date_day_of_month === 'number'
  )
    ? monthDayToDayOfYear(firstScene.date_month, firstScene.date_day_of_month, originIsLeap)
    : null
  // Mirror walkPovChainTime's hasUpstreamDateAnchor gating + retroactive
  // chainOriginDayOfYear update so the pre-context handed back for the
  // target scene matches what the main walker would produce when it
  // reaches the same point in the chain. Without this, alert-time
  // display rendering for downstream scenes would diverge from chip-
  // time display.
  let chainOriginDayOfYear = firstSceneDayOfYear ?? 0
  let hasUpstreamDateAnchor = firstSceneDayOfYear != null

  let prevFeb29ChainDay = null
  let prev = null
  for (const id of orderedSceneIds) {
    if (id === targetSceneId) break
    const scene = scenesById.get(id)
    if (!scene) continue
    if (prev == null) {
      const start = sceneStartMinutesOfDay(scene) ?? 0
      prev = { scene, effectiveStartMinutes: start }
      if (scene?.date_month === 2 && scene?.date_day_of_month === 29) {
        prevFeb29ChainDay = Math.floor(start / MIN_PER_DAY)
      }
      continue
    }
    const step = walkOneStep({
      priorEffectiveMinutes: prev.effectiveStartMinutes,
      priorDurationMinutes:  sceneDurationMinutes(prev.scene),
      priorScene:            prev.scene,
      scene,
      allowNegative: false,
      chainOriginWeekday,
      chainOriginDayOfYear,
      originIsLeap,
      prevFeb29ChainDay,
      hasUpstreamDateAnchor,
    })
    prev = { scene, effectiveStartMinutes: step.effectiveStartMinutes }
    if (step.feb29ChainDayUsed != null) prevFeb29ChainDay = step.feb29ChainDayUsed
    // Retroactive chain-origin anchor when this is the FIRST date pin.
    // Same logic as walkPovChainTime so the pre-context matches.
    if (!hasUpstreamDateAnchor
        && typeof scene?.date_month === 'number'
        && typeof scene?.date_day_of_month === 'number') {
      const sceneChainDay = Math.floor(step.effectiveStartMinutes / MIN_PER_DAY)
      const isOriginYearLeap = isChainLeapYear(0, originIsLeap)
      const pinnedDoy = monthDayToDayOfYear(scene.date_month, scene.date_day_of_month, isOriginYearLeap)
      if (pinnedDoy != null) {
        let originDoy = pinnedDoy - sceneChainDay
        const yearLen = isOriginYearLeap ? DAYS_IN_LEAP_YEAR : DAYS_IN_NORMAL_YEAR
        while (originDoy < 0) originDoy += yearLen
        chainOriginDayOfYear = originDoy
      }
      hasUpstreamDateAnchor = true
    }
  }
  return { originIsLeap, prevFeb29ChainDay, chainOriginWeekday, chainOriginDayOfYear }
}

// ── Loose-mode notification alert detection ──────────────────────
//
// Per planning §3.4.1 + §5.4 + §10.1.1 + §10.1.2:
//
//   (a) Significant absorbed shift — `gap_extension == 0` AND the
//       walker's recomputed gap differs from the persisted
//       `last_known_gap` by more than `gap_shift_threshold`.
//
//   (b) Extension applied to a shifted floor — `gap_extension > 0`
//       AND the floor changed (any non-zero delta vs the gap baseline
//       implied by `last_known_gap` minus gap_extension).
//
// Both share the universal §10.2 rules. Sequential cascade rule
// §3.4.2: only the earliest-affected scene gets its alert recorded;
// downstream scenes wait until the upstream resolves and the next
// detection pass surfaces the next still-warranted alert.
//
// Pure utility — caller is responsible for storing the returned alert
// payload onto the scene's `review_fields`. Returns null when no
// alert triggers, or when the scene has no `last_known_gap` baseline
// (first-time-on-chain rule §3.4.1: nothing to compare against).

/**
 * Detect a loose-mode notification alert for one scene's walker
 * output.
 *
 * Threshold check applies to BOTH the floor delta AND the effective-
 * start delta. From the writer's view, both kinds of upstream-driven
 * shifts move the scene's start time: an upstream change can push
 * the floor directly, OR push the floor just enough to cross a
 * snap-forward boundary on the downstream scene's own pin (TOD,
 * weekday, date, leap-year Feb 29 cycle), producing a much larger
 * effective shift. The writer cares about the larger of the two —
 * either is "the scene moved past my tolerance".
 *
 * @param {Object} args
 * @param {Object} args.scene                 the scene `data` object (has `gap_extension`, `last_known_gap`, `last_known_floor_minutes`, `last_known_effective_minutes`)
 * @param {Object} args.walkEntry             walker output for this scene ({ floorMinutes, effectiveStartMinutes, gapMinutes, isFirstScene })
 * @param {number} args.thresholdMinutes      gap-shift threshold in minutes
 * @returns {{ kind:'absorbed_shift'|'extension_on_shifted_floor', ... }|null}
 */
export function detectScenetimeAlert({ scene, walkEntry, thresholdMinutes }) {
  if (!walkEntry || walkEntry.isFirstScene) return null
  const newFloorMinutes = walkEntry.floorMinutes
  const newEffectiveMinutes = walkEntry.effectiveStartMinutes
  if (!Number.isFinite(newFloorMinutes)) return null

  // No baseline yet → nothing to compare. First-time pin on chain
  // seeds the baselines silently.
  const previousFloorMinutes = scene?.last_known_floor_minutes
  if (!Number.isFinite(previousFloorMinutes)) return null
  // Effective baseline may be missing on legacy saves that predate
  // its introduction; fall back to the floor baseline so detection
  // still produces SOMETHING reasonable. Once a write commits, the
  // effective baseline is seeded.
  const previousEffectiveMinutes = Number.isFinite(scene?.last_known_effective_minutes)
    ? scene.last_known_effective_minutes
    : previousFloorMinutes

  const floorDelta = newFloorMinutes - previousFloorMinutes
  const effectiveDelta = Number.isFinite(newEffectiveMinutes)
    ? newEffectiveMinutes - previousEffectiveMinutes
    : 0
  if (floorDelta === 0 && effectiveDelta === 0) return null

  const extensionMinutes = timeDeltaToMinutes(scene?.gap_extension)

  // The reported "delta" picks the larger-magnitude of (floor,
  // effective) so the alert headline / display reflects the bigger
  // shift the writer actually perceives.
  const reportedDelta = Math.abs(effectiveDelta) > Math.abs(floorDelta) ? effectiveDelta : floorDelta

  if (extensionMinutes > 0) {
    // Any floor change with a non-zero extension surfaces — the
    // writer's relative intent should be reviewed.
    if (floorDelta === 0 && effectiveDelta === 0) return null
    return {
      kind: 'extension_on_shifted_floor',
      previousFloorMinutes,
      newFloorMinutes,
      previousEffectiveMinutes,
      newEffectiveMinutes,
      deltaMinutes: reportedDelta,
      floorDeltaMinutes: floorDelta,
      effectiveDeltaMinutes: effectiveDelta,
      previousGap: minutesToTimeDelta(walkEntry.gapMinutes - floorDelta),
      newGap: minutesToTimeDelta(walkEntry.gapMinutes),
    }
  }

  // Threshold check applies to the LARGER of the two deltas. Either
  // the floor moved past the writer's tolerance, or the floor moved
  // just enough to cross a snap-boundary that pushed effective past
  // tolerance — either way, alert.
  if (Math.abs(floorDelta) > thresholdMinutes || Math.abs(effectiveDelta) > thresholdMinutes) {
    return {
      kind: 'absorbed_shift',
      previousFloorMinutes,
      newFloorMinutes,
      previousEffectiveMinutes,
      newEffectiveMinutes,
      deltaMinutes: reportedDelta,
      floorDeltaMinutes: floorDelta,
      effectiveDeltaMinutes: effectiveDelta,
      previousGap: minutesToTimeDelta(walkEntry.gapMinutes - floorDelta),
      newGap: minutesToTimeDelta(walkEntry.gapMinutes),
    }
  }

  return null
}

/**
 * Run alert detection across every chain-resident scene and return
 * the earliest-affected scene's alert per the §3.4.2 sequential
 * cascade rule. Subsequent affected scenes wait until this one
 * resolves and a fresh detection pass runs.
 *
 * @param {Object} args
 * @param {string[]} args.orderedSceneIds   scenes in POV chain order
 * @param {Map<string, Object>} args.scenesById
 * @param {Map<string, Object>} args.walkResult  output of `walkPovChainTime`
 * @param {number} args.thresholdMinutes
 * @returns {{ sceneId:string, alert:object }|null}
 */
export function detectFirstScenetimeAlert({ orderedSceneIds, scenesById, walkResult, thresholdMinutes }) {
  for (const sceneId of orderedSceneIds) {
    const scene = scenesById.get(sceneId)
    if (!scene) continue
    const walkEntry = walkResult.get(sceneId)
    const alert = detectScenetimeAlert({ scene, walkEntry, thresholdMinutes })
    if (alert) return { sceneId, alert }
  }
  return null
}

// ── React hook ────────────────────────────────────────────────────

import { useProjectStore } from '../store/projectStore'
import { usePovChain } from './povSequence'

// Phase 4.1g follow-up — stable-identity scene-time walk. The old hook
// held a raw `s.nodes` subscription AND a `useMemo` keyed on the nodes
// array identity, so every SceneTimeRow instance (174 of them on the
// reference project) both re-rendered AND re-ran the full chain time
// walk on every nodes-array write. The walk depends only on the chain
// order and each sceneNode's `data` reference — NOT on position (which
// `applyNodeChanges` carries forward as the same `data` ref) and not on
// any non-scene node. So an array-identity churn that doesn't touch a
// scene's time data cannot change the walk result. This module cache
// returns the prior result object on such writes, so consumers re-render
// only when the walk actually changes. No gesture gate needed: the
// structural compare keys on `data`, which a position drag never
// touches.
let _walkCache = { chain: null, nodes: null, allowNegative: null, scenes: null, result: null }

function _sceneDataUnchanged(prevScenes, nodes) {
  if (!prevScenes) return false
  let count = 0
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    count++
    if (prevScenes.get(n.id) !== n.data) return false
  }
  return count === prevScenes.size
}

/**
 * Cached scene-time walk: identity-keyed on `(chain, nodes,
 * allowNegative)`, with a structural fallback on the per-scene `data`
 * references so the returned Map identity survives nodes-array churn
 * that leaves every scene's time data untouched. The module cache means
 * only the FIRST consumer per store change pays the structural compare.
 */
export function getOrComputeScenetimeWalk(chain, nodes, allowNegative) {
  if (
    _walkCache.result
    && _walkCache.chain === chain
    && _walkCache.nodes === nodes
    && _walkCache.allowNegative === allowNegative
  ) {
    return _walkCache.result
  }
  if (
    _walkCache.result
    && _walkCache.chain === chain
    && _walkCache.allowNegative === allowNegative
    && _sceneDataUnchanged(_walkCache.scenes, nodes)
  ) {
    _walkCache = { ..._walkCache, nodes }
    return _walkCache.result
  }
  const orderedSceneIds = chain.sequence.map((s) => s.nodeId)
  const scenesById = new Map()
  for (const n of nodes) {
    if (n.type === 'sceneNode') scenesById.set(n.id, n.data)
  }
  const result = walkPovChainTime({ orderedSceneIds, scenesById, allowNegative })
  _walkCache = { chain, nodes, allowNegative, scenes: scenesById, result }
  return result
}

/**
 * React hook returning the per-scene walker output for the current POV
 * chain. Stable object identity: consumers re-render only when the walk
 * result actually changes.
 */
export function useScenetimeWalk(allowNegative = false) {
  const chain = usePovChain()
  return useProjectStore((s) => getOrComputeScenetimeWalk(chain, s.nodes, allowNegative))
}
