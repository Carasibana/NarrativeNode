/**
 * Phase 1.23 — single source of truth for scene-time verbiage.
 *
 * ──────────────────────────────────────────────────────────────────
 *  WHY THIS MODULE EXISTS
 * ──────────────────────────────────────────────────────────────────
 *
 * Every writer-facing string derived from scene-time values flows
 * through this module. Before this consolidation the rendering logic
 * was duplicated across the AlertsPanel time-since branch, the
 * scene-card chip's leading segment, the Time Modal's prior-context
 * + floor + effective lines, and a now-retired `scenetimeDisplay.js`
 * helper file. Each site reinvented its own tier-collapse + naming +
 * pluralisation rules with subtle inconsistencies. Bugs ("Date tier:
 * month_dow → ..." leaking, minute precision showing on labelled-tier
 * scenes, weekday rendered as "3" instead of "Tuesday") all traced
 * back to those scattered helpers diverging.
 *
 * Consolidating into one module guarantees:
 *   - The combinations matrix (every prior × current granularity)
 *     is reasoned about in ONE place. Consumers don't think about it.
 *   - A change to phrasing in one surface either applies everywhere
 *     consistently OR is gated by an explicit `context` argument.
 *   - New consumers (export renderers, save-popup, future tooltips)
 *     get correct behaviour for free; they just call into the module.
 *
 * ──────────────────────────────────────────────────────────────────
 *  THE TWO ARGUMENT SHAPES
 * ──────────────────────────────────────────────────────────────────
 *
 * Per-concept formatters always come in two flavours:
 *
 *   formatXxx(value, context, opts)
 *      — render a SINGLE value for display.
 *
 *   formatXxxChange(oldValue, newValue, context, opts)
 *      — render a TRANSITION pair, returning
 *        `{ oldDisplay, newDisplay, hasChange }`.
 *        Used wherever the writer sees a before/after.
 *
 * The `value` parameter shape varies by concept:
 *   - `formatTimeOfDay`        takes a scene-shaped object with
 *                              `time_of_day_*` fields (`tier` +
 *                              one of `broad` / `labelled` / `exact`).
 *   - `formatDate`             takes a scene-shaped object with
 *                              `weekday` / `date_month` /
 *                              `date_day_of_month`.
 *   - `formatSeason`           takes a scene-shaped object with
 *                              `season` (0..3).
 *   - `formatSceneDuration`    takes the `scene_duration` object
 *                              directly (`{kind, value, ...}`).
 *   - `formatGapExtension`     takes a `TimeDelta` object
 *                              (`{unit, value}`).
 *   - `formatSlot`             takes a chain-relative minute count
 *                              (computed by the walker).
 *   - `formatPriorSceneClause` takes a scene-shaped object and
 *                              composes a sentence fragment from all
 *                              its pinned constraints.
 *
 * ──────────────────────────────────────────────────────────────────
 *  CONTEXTS — WHAT EACH ONE IS INTENDED TO CONVEY
 * ──────────────────────────────────────────────────────────────────
 *
 * Each context name describes a SURFACE the string will render on.
 * The same underlying value can read differently across surfaces
 * because the writer's eye is anchored differently in each:
 *
 *   'value'
 *      The default. A bare value with no surrounding framing —
 *      "Late Morning", "May 10", "Tuesday", "Spring", "5 hours".
 *      Used when the surrounding UI already provides a label
 *      (e.g. a settings field, a chip cell, a column header).
 *
 *   'value-with-slot'
 *      A chain-position-aware rendering — "Day 6 · Late Morning".
 *      Combines the ordinal day count from chain origin with a
 *      tier-aware Time of Day phrase. Used by the alert "earliest
 *      this scene can be" line and the modal's effective-start
 *      display where the writer needs both axes.
 *
 *   'change-line'
 *      The "old → new" rendering. Used in alert "Changed:" blocks
 *      and modal section transitions. Same as 'value' for individual
 *      reads but with extra discipline around granularity collapse:
 *      the looser of the two scenes' tiers is used so the displayed
 *      pair never claims a precision the writer didn't pin in BOTH
 *      states. Example: prior pinned "Late Afternoon" (labelled),
 *      current pinned "5:45 PM" (exact) → both rendered at labelled
 *      tier as "Late Afternoon → Late Afternoon" so the change
 *      doesn't look like a minute shift.
 *
 *   'because-clause'
 *      Composes a sentence FRAGMENT to be embedded inside a longer
 *      sentence. Examples: "set on May 10", "in Late Morning",
 *      "set on Tuesday May 10 in Sunset". The caller wraps with the
 *      framing verb (e.g. "because the previous scene is now {clause}").
 *      Different from 'value' in that the formatter chooses the
 *      preposition — "set on" for date, "in" for Time of Day —
 *      rather than just outputting the bare value.
 *
 *   'compact-gap'
 *      Used by the scene-card chip's leading segment. Granularity-
 *      aware narrative phrases for the gap between two scenes:
 *      "5 days later", "the next day", "moments later", "earlier
 *      that morning". Tightly compact for chip width. Served via
 *      `formatGap(minutes, 'compact-gap', { tier })`.
 *
 *   'gap-magnitude'
 *      Modal-section variant for absolute gap durations:
 *      "+5 days" / "+3 hours" / "no gap". Sign-prefixed because the
 *      modal context emphasises the writer's manual extension
 *      versus the floor-derived default. Served via
 *      `formatGap(minutes, 'gap-magnitude')`.
 *
 *   'narrative-gap'
 *      Export-renderer variant for prose interjection between scene
 *      bodies. "Five days later," "The next morning," etc.
 *      (V2-aspirational; export integration is a separate ToDo.)
 *
 * Most concepts share a default rendering across most contexts.
 * Where a context warrants a different rendering, the formatter
 * dispatches on the context inside its body. When a formatter
 * doesn't recognise a context, it falls back to 'value' behaviour.
 *
 * ──────────────────────────────────────────────────────────────────
 *  TIER COLLAPSE — THE GRANULARITY DISCIPLINE
 * ──────────────────────────────────────────────────────────────────
 *
 * A core invariant: never display a precision the writer didn't pin.
 *
 * If the writer pinned "Late Afternoon" (labelled tier), the
 * walker's representative minute-of-day for that label is 15:45.
 * That 15:45 is an arbitrary anchor for chain arithmetic — the
 * writer never asserted 15:45 specifically. So display must NEVER
 * show "15:45" when only "Late Afternoon" was pinned.
 *
 * Consumers pass the LOOSER tier of the relevant scenes (prior +
 * current) via `opts.tier`. Each formatter uses it to collapse
 * precise data to coarser language:
 *   exact   "15:45 PM"  → labelled "Late Afternoon" → broad "Day"
 *   exact   "23:30"     → labelled "Night"          → broad "Night"
 *   minutes 120         → hours 2                   (when tier !== exact)
 *
 * `looserTier(...tiers)` exposes this rank. `null < broad <
 * labelled < exact`.
 *
 * ──────────────────────────────────────────────────────────────────
 *  COMMON OPTION FIELDS
 * ──────────────────────────────────────────────────────────────────
 *
 *   timeFormat:           '12h' | '24h'  (default '12h')
 *      Per-story setting for exact-clock display. Storage stays
 *      24-hour; only display flips.
 *
 *   tier:                 'broad' | 'labelled' | 'exact' | null
 *      Looser tier for collapse. Concepts that don't have a tier
 *      axis (Date, Season) ignore this field but accept it for
 *      uniform call-site shape.
 *
 *   targetTier:           same as `tier`, accepted by formatTimeOfDay
 *      Provided as an explicit alias for clarity at call sites
 *      where only TOD collapse is being directed.
 *
 *   chainOriginWeekday:   0..6 (default 0 = Sunday)
 *   chainOriginDayOfYear: 0..364 (default 0 = Jan 1)
 *      Walker chain anchors. Currently consumed by `formatSlot`
 *      paths that need to map chain-relative minutes back to a
 *      weekday or month/day for richer display (future).
 *
 * ──────────────────────────────────────────────────────────────────
 *  MIGRATION STATUS
 * ──────────────────────────────────────────────────────────────────
 *
 * v0.1.23.21 introduced the module and migrated `AlertsPanel.jsx`.
 * v0.1.23.22 completed the consolidation: `SceneTimeRow.jsx` (chip
 * leading-segment + summary), `SceneTimeModal.jsx` (Section 1 prior-
 * context + Section 3 floor / effective lines) now consume this
 * module exclusively, and the legacy `scenetimeDisplay.js` helper
 * file was retired. Every writer-facing scene-time string now flows
 * through this module.
 */

import { collapseExactToLabelled, collapseLabelledToBroad } from '../components/ui/TimeOfDayCarousel'
import { minutesToTimeDelta, sceneStartMinutesOfDay, timeDeltaToMinutes } from './povChainTimeWalker'

// ──────────────────────────────────────────────────────────────────
//  Constants — writer-language tables.
//
//  Public so consumers that need raw names (e.g. dropdown options,
//  badge labels) don't reinvent the lookup. The walker / data model
//  uses 0-based indices for weekdays + seasons and 1-based for
//  months; these tables match that convention.
// ──────────────────────────────────────────────────────────────────

export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Indices 0..3 = temperate seasons; 4..5 = tropical (Wet / Dry).
// Mirrors `gregorianCalendar.GREGORIAN_CALENDAR.seasons.long`.
export const SEASON_NAMES = ['Spring', 'Summer', 'Fall', 'Winter', 'Wet', 'Dry']

const MIN_PER_DAY = 1440
const DAYS_IN_PHANTOM_YEAR = 365  // 365-day phantom-year used by walker date math; future Feb 29 work may make this variable.

// ──────────────────────────────────────────────────────────────────
//  Tier ladder.
//
//  The Time of Day data model has three concrete tiers — broad
//  (Day/Night), labelled (15 named periods like "Late Afternoon"),
//  and exact (HH:MM clock). Display logic frequently needs the
//  LOOSER of two scenes' tiers so output never claims more precision
//  than was pinned in BOTH states. Used by 'change-line' contexts
//  and combined slot displays.
// ──────────────────────────────────────────────────────────────────

const TIER_RANK = { exact: 3, labelled: 2, broad: 1 }

/**
 * Pick the looser of any number of tiers. Null inputs are skipped.
 * Returns null only when every input was null.
 *
 *   looserTier('labelled', 'exact')        → 'labelled'
 *   looserTier('exact', 'broad')           → 'broad'
 *   looserTier(null, 'labelled')           → 'labelled'
 *   looserTier(null, null)                 → null
 */
export function looserTier(...tiers) {
  let best = null
  for (const t of tiers) {
    if (!t) continue
    if (best == null || TIER_RANK[t] < TIER_RANK[best]) best = t
  }
  return best
}

// ──────────────────────────────────────────────────────────────────
//  Time of Day formatter.
// ──────────────────────────────────────────────────────────────────

/**
 * Internal helper: render an "HH:MM" string at the requested
 * timeFormat. 12h adds AM/PM; 24h zero-pads. Used by exact-tier
 * display + by `formatSlot` when the scene was pinned at exact.
 */
function formatExactClock(hhmm, timeFormat = '12h') {
  if (typeof hhmm !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h24 = Number(m[1])
  const mm = m[2]
  if (timeFormat === '24h') return `${String(h24).padStart(2, '0')}:${mm}`
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24)
  return `${h12}:${mm} ${ampm}`
}

/**
 * Render a scene's pinned Time of Day at the granularity it was
 * committed at (or collapsed to a coarser target tier).
 *
 * Rendering matrix:
 *
 *   sceneTier   targetTier  output example
 *   ─────────   ──────────  ──────────────────────────────
 *   exact       exact       "5:45 PM" (or "17:45" in 24h)
 *   exact       labelled    "Sunset"   (collapsed via Tier-2 boundaries)
 *   exact       broad       "Day" / "Night"
 *   labelled    labelled    "Late Afternoon"
 *   labelled    broad       "Day" / "Night"
 *   broad       broad       "Day" / "Night"
 *   null/none   *           null
 *
 * The targetTier defaults to the scene's own tier; pass a coarser
 * one (e.g. via `opts.tier` or `opts.targetTier`) to force collapse.
 *
 * Context behaviour: 'value', 'change-line', 'because-clause' all
 * produce the same string — TOD doesn't change wording across these
 * surfaces, only the surrounding framing does (which is handled by
 * the caller, e.g. `formatPriorSceneClause` adds "in" before this).
 *
 * @param {object} scene  scene-shaped object with `time_of_day_*` fields
 * @param {string} context  see module header
 * @param {object} opts
 * @param {'broad'|'labelled'|'exact'|null} opts.targetTier  collapse to this tier
 * @param {'broad'|'labelled'|'exact'|null} opts.tier        synonym for targetTier
 * @param {string} opts.timeFormat  '12h' | '24h'
 * @returns {string|null}
 */
// eslint-disable-next-line no-unused-vars -- uniform (scene, context, opts) signature; context unused here
export function formatTimeOfDay(scene, context = 'value', opts = {}) {
  if (!scene) return null
  const sceneTier = scene.time_of_day_tier || null
  // `opts.tier` (from caller's `fmtOpts` shared across concepts) acts
  // as a synonym for `opts.targetTier`. Both can drive collapse.
  const targetTier = opts.targetTier ?? opts.tier ?? sceneTier
  const tf = opts.timeFormat || '12h'
  if (sceneTier === 'exact' && scene.time_of_day_exact) {
    if (targetTier === 'exact')    return formatExactClock(scene.time_of_day_exact, tf)
    if (targetTier === 'labelled') return collapseExactToLabelled(scene.time_of_day_exact)
    if (targetTier === 'broad') {
      const lab = collapseExactToLabelled(scene.time_of_day_exact)
      const broad = lab ? collapseLabelledToBroad(lab) : null
      if (broad === 'day')   return 'Day'
      if (broad === 'night') return 'Night'
      return null
    }
    return formatExactClock(scene.time_of_day_exact, tf)
  }
  if (sceneTier === 'labelled' && scene.time_of_day_labelled) {
    if (targetTier === 'broad') {
      const broad = collapseLabelledToBroad(scene.time_of_day_labelled)
      if (broad === 'day')   return 'Day'
      if (broad === 'night') return 'Night'
      return null
    }
    return scene.time_of_day_labelled
  }
  if (sceneTier === 'broad' && scene.time_of_day_broad) {
    return scene.time_of_day_broad === 'night' ? 'Night' : 'Day'
  }
  return null
}

/**
 * Compute the "old → new" pair for a Time of Day change. Tier is
 * automatically derived as the looser of the two scenes' own tiers
 * — display never claims a precision the writer didn't pin in BOTH
 * states. e.g. prior "Late Afternoon" + new "5:45 PM" renders both
 * at labelled tier to keep the change line readable.
 *
 * Returns `{ oldDisplay, newDisplay, hasChange }`. Empty values
 * substitute "(unset)" so callers can render the transition pair
 * uniformly without null-checks.
 */
export function formatTimeOfDayChange(oldVals, newVals, context = 'change-line', opts = {}) {
  const oldTier = oldVals?.time_of_day_tier || null
  const newTier = newVals?.time_of_day_tier || null
  const tier = looserTier(oldTier, newTier)
  const oldDisplay = formatTimeOfDay(oldVals, context, { ...opts, targetTier: tier ?? oldTier })
  const newDisplay = formatTimeOfDay(newVals, context, { ...opts, targetTier: tier ?? newTier })
  return {
    oldDisplay: oldDisplay ?? '(unset)',
    newDisplay: newDisplay ?? '(unset)',
    hasChange: oldDisplay !== newDisplay,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Date formatter (weekday + month + day-of-month combinations).
// ──────────────────────────────────────────────────────────────────

/**
 * Render a scene's pinned date as a writer-language phrase. The
 * combination renders include only the parts the writer pinned —
 * unpinned parts are silently omitted, NOT filled with placeholders.
 * Outputs:
 *
 *   weekday only          → "Tuesday"
 *   month only            → "May"
 *   month + day           → "May 10"
 *   weekday + month       → "Tuesday May"
 *   weekday + month + day → "Tuesday May 10"
 *   nothing pinned        → null
 *
 * Returns null when no parts are pinned. Callers typically substitute
 * "(unset)" or skip rendering entirely.
 *
 * Context behaviour: 'value', 'change-line', 'because-clause' all
 * produce the same string. The "set on " prefix used in
 * because-clauses comes from `formatPriorSceneClause`, not here.
 */
// eslint-disable-next-line no-unused-vars -- uniform (scene, context, opts) signature; both unused here
export function formatDate(scene, context = 'value', _opts = {}) {
  if (!scene) return null
  const wd = (typeof scene.weekday === 'number' && scene.weekday >= 0 && scene.weekday <= 6)
    ? WEEKDAY_NAMES[scene.weekday] : null
  const mm = (typeof scene.date_month === 'number' && scene.date_month >= 1 && scene.date_month <= 12)
    ? MONTH_NAMES[scene.date_month - 1] : null
  const dd = (typeof scene.date_day_of_month === 'number') ? String(scene.date_day_of_month) : null
  let datePart = null
  if (mm && dd) datePart = `${mm} ${dd}`
  else if (mm) datePart = mm
  if (wd && datePart) return `${wd} ${datePart}`
  if (wd) return wd
  if (datePart) return datePart
  return null
}

/**
 * Render the "old → new" pair for a date change. Like Date itself,
 * each side is rendered independently with whatever parts were
 * pinned at that time. Empty values substitute "(unset)".
 */
export function formatDateChange(oldVals, newVals, context = 'change-line', opts = {}) {
  const oldDisplay = formatDate(oldVals, context, opts)
  const newDisplay = formatDate(newVals, context, opts)
  return {
    oldDisplay: oldDisplay ?? '(unset)',
    newDisplay: newDisplay ?? '(unset)',
    hasChange: oldDisplay !== newDisplay,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Season formatter.
//
//  Note: per writer's decision (Phase 1.23 audit step 8), season is
//  ornamental / independent context — it does NOT contribute to the
//  walker's floor math. This formatter just translates the stored
//  numeric value (0-3) to the writer-facing name. No tier collapse
//  applies; seasons are atomic.
// ──────────────────────────────────────────────────────────────────

/**
 * "Spring" / "Summer" / "Fall" / "Winter", or null if unpinned.
 */
// eslint-disable-next-line no-unused-vars -- uniform (scene, context, opts) signature; both unused here
export function formatSeason(scene, _context = 'value', _opts = {}) {
  if (!scene) return null
  const s = scene.season
  if (typeof s !== 'number' || s < 0 || s >= SEASON_NAMES.length) return null
  return SEASON_NAMES[Math.floor(s)]
}

export function formatSeasonChange(oldVals, newVals, context = 'change-line', opts = {}) {
  const oldDisplay = formatSeason(oldVals, context, opts)
  const newDisplay = formatSeason(newVals, context, opts)
  return {
    oldDisplay: oldDisplay ?? '(unset)',
    newDisplay: newDisplay ?? '(unset)',
    hasChange: oldDisplay !== newDisplay,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Scene Duration formatter.
// ──────────────────────────────────────────────────────────────────

/**
 * Render a scene's `scene_duration` discriminated-union object in
 * writer-language. Output examples by `kind`:
 *
 *   { kind: 'minutes', value: 120 }    → "120 minutes" (or "2 hours" at non-exact tier)
 *   { kind: 'hours',   value: 5 }      → "5 hours"
 *   { kind: 'days',    value: 3 }      → "3 days"
 *   { kind: 'all_day' }                → "All day"
 *   { kind: 'all_period' }             → "All …" (placeholder, period filled by carousel UI)
 *   { kind: 'span',    end_period: 'evening' } → "until Evening"
 *   { kind: 'ambiguous' } / null       → null
 *
 * Tier-awareness:
 *   When the looser tier is broad / labelled (i.e. neither scene
 *   pinned exact-tier Time of Day), minute-pinned durations round
 *   UP to the largest unit the value cleanly divides into. e.g.
 *   `{ kind: 'minutes', value: 120 }` becomes "2 hours" not
 *   "120 minutes" — keeping precision proportional to surrounding
 *   pins. Pass `opts.tier` (or omit it for raw display).
 *
 * @param {object|null} value  the `scene_duration` field
 * @param {string} context  see module header
 * @param {object} opts
 * @param {string} opts.tier  looser tier for granularity collapse
 */
// eslint-disable-next-line no-unused-vars -- uniform (value, context, opts) signature; context unused here
export function formatSceneDuration(value, _context = 'value', opts = {}) {
  if (!value || typeof value !== 'object') return null
  const { kind, value: v } = value
  const tier = opts.tier ?? null
  if (!kind || kind === 'ambiguous') return null
  if (kind === 'minutes') {
    if (!Number.isFinite(v)) return null
    if (tier && tier !== 'exact') {
      // Surrounding pins don't justify minute precision — round up
      // to hours/days when cleanly divisible.
      const cleaned = minutesToTimeDelta(Number(v) || 0)
      return formatTimeDelta(cleaned)
    }
    return `${v} ${pluralUnit('minute', v)}`
  }
  if (kind === 'hours') {
    if (!Number.isFinite(v)) return null
    return `${v} ${pluralUnit('hour', v)}`
  }
  if (kind === 'days') {
    if (!Number.isFinite(v)) return null
    return `${v} ${pluralUnit('day', v)}`
  }
  if (kind === 'all_day') {
    const variant = value.all_day_variant || null
    if (variant === 'all_night') return 'All night'
    if (variant === 'until_next_evening' || variant === 'until_next_day') return 'Until next evening'
    return 'All day'
  }
  if (kind === 'all_period') return 'All …'
  if (kind === 'span') {
    if (value.end_period) return `until ${capitalize(value.end_period)}`
    return null
  }
  return null
}

export function formatSceneDurationChange(oldVal, newVal, context = 'change-line', opts = {}) {
  const oldDisplay = formatSceneDuration(oldVal, context, opts)
  const newDisplay = formatSceneDuration(newVal, context, opts)
  return {
    oldDisplay: oldDisplay ?? '(unset)',
    newDisplay: newDisplay ?? '(unset)',
    hasChange: oldDisplay !== newDisplay,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Gap Extension formatter (Time Since Last Scene override).
//
//  This is the writer's manual "+N <unit>" pin that extends beyond
//  the floor-derived gap. Stored as a `TimeDelta` `{unit, value}`.
//  Tier-aware just like Scene Duration's minute-pinned case: at
//  non-exact tier, minute-pinned extensions round up to the largest
//  unit they cleanly divide into.
// ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- uniform (value, context, opts) signature; context unused here
export function formatGapExtension(value, _context = 'value', opts = {}) {
  if (!value || typeof value !== 'object') return null
  const tier = opts.tier ?? null
  if (value.unit === 'minutes' && tier !== 'exact') {
    const mins = Number(value.value) || 0
    if (mins === 0) return null
    return formatTimeDelta(minutesToTimeDelta(mins))
  }
  return formatTimeDelta(value)
}

export function formatGapExtensionChange(oldVal, newVal, context = 'change-line', opts = {}) {
  const oldDisplay = formatGapExtension(oldVal, context, opts)
  const newDisplay = formatGapExtension(newVal, context, opts)
  return {
    oldDisplay: oldDisplay ?? '(unset)',
    newDisplay: newDisplay ?? '(unset)',
    hasChange: oldDisplay !== newDisplay,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Slot formatter — chain-position rendering.
//
//  Takes a chain-relative minute count (computed by the walker) and
//  renders it as "Day N · <within-day>". The within-day piece is
//  granularity-aware via opts.tier (mirrors formatTimeOfDay's tier
//  collapse). When no tier is provided, only "Day N" is rendered.
//
//  This is the canonical "earliest this scene can be" line for the
//  alert "Therefore" section and the modal effective-start display.
// ──────────────────────────────────────────────────────────────────

// Slot-position scale picker. The ordinal "day count" portion of a
// formatSlot output collapses to a coarser unit at higher magnitudes
// so a "Year 5, Month 2, Day 30" reading replaces an unwieldy
// "Day 1521".
//
//   < 14 days     → 'day'    ("Day 7")
//   14 to 89      → 'week'   ("Week 10")
//   90 to 364     → 'month'  ("Month 3, Day 4")
//   ≥ 365         → 'year'   ("Year 5, Month 2, Day 30")
//
// Year math uses a 365.25-day average so leap-cycle round trips land
// on whole-year boundaries (1461 days = exactly 4 years; day 1462
// starts year 5). Month math uses a 30.4375-day average (= 365.25/12)
// so 12 months sum to a year. At precise year / month boundaries
// these can be off by one day compared to the chain's actual
// calendar cadence, but the writer-readable output remains correct
// in scale and the magnitude is what matters for these displays.
const _DAYS_PER_MONTH_AVG = 365.25 / 12   // 30.4375
const _DAYS_PER_YEAR_AVG  = 365.25

function _slotScaleForDay(day) {
  if (day >= 365) return 'year'
  if (day >= 90)  return 'month'
  if (day >= 14)  return 'week'
  return 'day'
}

const _SLOT_SCALE_RANK = { day: 0, week: 1, month: 2, year: 3 }

function _coarserSlotScale(a, b) {
  return _SLOT_SCALE_RANK[a] >= _SLOT_SCALE_RANK[b] ? a : b
}

function _renderSlotDayLabel(day, scale) {
  if (scale === 'year') {
    const yearOrdinal = Math.floor((day - 1) / _DAYS_PER_YEAR_AVG) + 1
    const yearStartDay = Math.floor((yearOrdinal - 1) * _DAYS_PER_YEAR_AVG) + 1
    const dayWithinYear = day - yearStartDay + 1
    // Subdivide year by month so the writer reads "Year 5, Month 2,
    // Day 30" instead of "Year 5, Day 60". Month math uses the same
    // 30.4375-day average that the month scale uses standalone, so
    // year-internal month numbers line up consistently.
    const monthOrdinal = Math.floor((dayWithinYear - 1) / _DAYS_PER_MONTH_AVG) + 1
    const monthStartInYear = Math.floor((monthOrdinal - 1) * _DAYS_PER_MONTH_AVG) + 1
    const dayWithinMonth = dayWithinYear - monthStartInYear + 1
    return `Year ${yearOrdinal}, Month ${monthOrdinal}, Day ${dayWithinMonth}`
  }
  if (scale === 'month') {
    const monthOrdinal = Math.floor((day - 1) / _DAYS_PER_MONTH_AVG) + 1
    const monthStartDay = Math.floor((monthOrdinal - 1) * _DAYS_PER_MONTH_AVG) + 1
    const dayWithinMonth = day - monthStartDay + 1
    return `Month ${monthOrdinal}, Day ${dayWithinMonth}`
  }
  if (scale === 'week') {
    const week = Math.ceil(day / 7)
    return `Week ${week}`
  }
  return `Day ${day}`
}

/**
 * Render an absolute minute-from-chain-origin as a slot phrase. The
 * ordinal-day portion picks an appropriate unit based on magnitude:
 *
 *   minutes=750     → "Day 1 · …"            (1 day in)
 *   minutes=92160   → "Week 10 · …"           (64 days in)
 *   minutes=2190240 → "Year 5, Day 60 · …"    (1521 days in)
 *
 * Day / week / year unit boundaries are <14, 14-364, ≥365 days
 * respectively. The time portion is granularity-aware via opts.tier
 * (exact / labelled / broad) — never claims a precision the writer
 * didn't pin.
 *
 * Negative minutes (Allow Negative Time, parked V2) map to Day 0 /
 * Day −1 / etc. by integer floor — caller may want to special-case.
 *
 * @param {number} minutes  chain-relative minutes from origin
 * @param {string} context  see module header
 * @param {object} opts
 * @param {'broad'|'labelled'|'exact'|null} opts.tier  granularity for the within-day phrase
 * @param {string} opts.timeFormat  '12h' | '24h'
 * @param {'day'|'week'|'year'|null} opts.scaleHint  force a specific
 *   slot scale even when the magnitude alone would pick a finer one.
 *   Used by paired displays (e.g. alert From → To) so both sides
 *   render at the same scale; the larger side's natural scale wins.
 * @returns {string|null}
 */
// eslint-disable-next-line no-unused-vars -- uniform (minutes, context, opts) signature; context unused here
export function formatSlot(minutes, _context = 'value-with-slot', opts = {}) {
  if (!Number.isFinite(minutes)) return null
  const day = Math.floor(minutes / MIN_PER_DAY) + 1
  const minuteOfDay = ((minutes % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY
  const tier = opts.tier ?? null
  const tf = opts.timeFormat || '12h'
  let timePart = null
  const hhmm = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
  if (tier === 'exact') {
    timePart = formatExactClock(hhmm, tf)
  } else if (tier === 'labelled') {
    timePart = collapseExactToLabelled(hhmm)
  } else if (tier === 'broad') {
    const lab = collapseExactToLabelled(hhmm)
    const broad = lab ? collapseLabelledToBroad(lab) : null
    timePart = broad === 'day' ? 'Day' : broad === 'night' ? 'Night' : null
  }
  const scale = opts.scaleHint || _slotScaleForDay(day)
  const dayLabel = _renderSlotDayLabel(day, scale)
  return timePart ? `${dayLabel} · ${timePart}` : dayLabel
}

/**
 * Render JUST the within-day time portion of a chain-relative or
 * within-day minute count, at the requested tier. The companion to
 * `formatSlot` for callers that want only the time-of-day phrase
 * without the "Day N · " prefix — e.g. the modal Section 3 floor /
 * effective lines that sit inside their own framing ("Prior scene
 * started at <time>").
 *
 * Input is interpreted modulo 1440 so passing chain-relative minutes
 * (which may exceed a day) returns the within-day portion only.
 *
 * Tier-aware (mirrors `formatTimeOfDay` collapse rules):
 *   'exact'    → "5:45 PM" / "17:45"
 *   'labelled' → "Sunset" / "Late Afternoon" (collapsed via Tier-2 boundaries)
 *   'broad'    → "Day" / "Night"
 *   null       → null (caller decides whether to skip the line)
 *
 * @param {number} minutes  minute-of-day OR chain-relative minutes (mod 1440 applied)
 * @param {string} context  see module header ('value' default)
 * @param {object} opts
 * @param {'broad'|'labelled'|'exact'|null} opts.tier  granularity
 * @param {string} opts.timeFormat  '12h' | '24h'
 * @returns {string|null}
 */
// eslint-disable-next-line no-unused-vars -- uniform (minutes, context, opts) signature; context unused here
export function formatTimeAtTier(minutes, _context = 'value', opts = {}) {
  if (!Number.isFinite(minutes)) return null
  const m = ((minutes % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY
  const tier = opts.tier ?? null
  const tf = opts.timeFormat || '12h'
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  if (tier === 'exact')    return formatExactClock(hhmm, tf)
  if (tier === 'labelled') return collapseExactToLabelled(hhmm)
  if (tier === 'broad') {
    const lab = collapseExactToLabelled(hhmm)
    const broad = lab ? collapseLabelledToBroad(lab) : null
    if (broad === 'day')   return 'Day'
    if (broad === 'night') return 'Night'
    return null
  }
  return null
}

/**
 * Render the "old → new" slot pair. Currently a thin wrapper —
 * exists so call sites use the consistent `formatXxxChange` shape
 * across all concepts. Returns `{ oldDisplay, newDisplay, hasChange }`.
 */
export function formatSlotChange(oldMinutes, newMinutes, context = 'change-line', opts = {}) {
  return {
    oldDisplay: formatSlot(oldMinutes, context, opts) ?? '?',
    newDisplay: formatSlot(newMinutes, context, opts) ?? '?',
    hasChange: oldMinutes !== newMinutes,
  }
}

// ──────────────────────────────────────────────────────────────────
//  Gap formatter — time elapsed between two scenes.
//
//  Takes a minute-count (gap from the END of the prior scene to
//  the start of THIS one — i.e. `effectiveStart - floor` where
//  `floor = priorStart + priorDuration`) and renders it in the
//  flavour appropriate to the rendering surface.
//
//  Tier-aware: at non-exact tier, sub-day gaps round to the nearest
//  hour; cross-day gaps render at whole-day scale. At broad / null
//  tier, gaps below half a day collapse to "later the same day"
//  (or "earlier the same day" for negative gaps under Allow Negative
//  Time, V2-parked).
//
//  CONSTRAINT-FRAMED, never declarative: phrases like "the next day"
//  describe what the writer's settings IMPLY, not what the story IS.
//  Callers wrap with a constraint frame ("Earliest this scene can
//  be: ${phrase}") rather than presenting as fact.
// ──────────────────────────────────────────────────────────────────

/**
 * Render an elapsed-minutes gap as writer-language, dispatched by
 * context.
 *
 * @param {number} minutes  signed gap from prior scene end → this start
 * @param {string} context
 *   'compact-gap'     — chip leading segment (default).
 *                       Tight phrases anchored by the day frame:
 *                         0           → "right after"
 *                         <12h        → "later the same day" / "earlier the same day"
 *                         12h..36h    → "the next day" / "the previous day"
 *                         else        → "5 days later" / "5 days earlier"
 *                       At labelled tier, sub-day gaps render in hours
 *                       ("3 hours later"). At exact tier, in minutes
 *                       ("47 minutes later"). At broad / null, only
 *                       day-scale phrases.
 *
 *   'narrative-gap'   — full anchor-tail form for the modal Section 3
 *                       floor / effective lines:
 *                         "5 days after the previous scene ends"
 *                         "47 minutes after the previous scene ends"
 *                         "right when the previous scene ends"
 *                       Negative gaps swap to "before the previous scene ends".
 *
 *   'gap-magnitude'   — sign-prefixed magnitude, used by the modal
 *                       Time-Since-Last-Scene field's display rows
 *                       ("+5 days" / "+3 hours" / "-1 day"). Zero
 *                       gap renders as "no gap".
 *
 * @param {object} opts
 * @param {'broad'|'labelled'|'exact'|null} opts.tier  granularity
 * @returns {string}
 */
export function formatGap(minutes, context = 'compact-gap', opts = {}) {
  const tier = opts.tier ?? null
  if (context === 'gap-magnitude') return _gapMagnitude(minutes)
  if (context === 'narrative-gap') return _gapNarrative(minutes, tier, opts)
  return _gapCompact(minutes, tier, opts)
}

// Bucket-name → writer-language nominal form. The 5-bucket period
// vocabulary ('dawn', 'morning', 'afternoon', 'evening', 'night')
// matches the gearshift-column buckets the rest of the time system
// uses; each is a noun the writer can read inline ("that morning",
// "the next afternoon").
const _BUCKET_NOUNS = {
  dawn:      'dawn',
  morning:   'morning',
  afternoon: 'afternoon',
  evening:   'evening',
  night:     'night',
}

// "In the {noun}" reads natural for morning/afternoon/evening but
// awkward for dawn/night — English uses bare "at" there. The
// multi-day tail ("3 weeks later, in the morning" vs "3 weeks
// later, at night") picks per-bucket via this table; sub-day
// templates ("later that night", "the next dawn") work for all
// five and don't need it.
const _BUCKET_TAIL_PREP = {
  dawn:      'at',
  morning:   'in the',
  afternoon: 'in the',
  evening:   'in the',
  night:     'at',
}

// 5-bucket period boundaries (mirrors the walker / SceneDurationCarousel
// definitions). Used by `sceneBucket` to derive a current scene's
// bucket from its pinned TOD so callers don't have to import the
// walker's internal table or replicate it.
const _BUCKET_RANGES = [
  { name: 'dawn',      lo: 3 * 60,       hi: 6 * 60 },
  { name: 'morning',   lo: 6 * 60,       hi: 11 * 60 + 30 },
  { name: 'afternoon', lo: 11 * 60 + 30, hi: 16 * 60 + 30 },
  { name: 'evening',   lo: 16 * 60 + 30, hi: 22 * 60 },
  // Night wraps midnight; covered explicitly below.
]

/**
 * Resolve a scene's pinned Time of Day to a 5-bucket period name
 * (`dawn` / `morning` / `afternoon` / `evening` / `night`), or null
 * when no TOD is pinned. Tier-aware via `sceneStartMinutesOfDay`,
 * which handles broad / labelled / exact identically.
 */
export function sceneBucket(scene) {
  const min = sceneStartMinutesOfDay(scene)
  if (min == null) return null
  for (const r of _BUCKET_RANGES) {
    if (min >= r.lo && min < r.hi) return r.name
  }
  // Night wraps: minutes from 22:00 onward through 02:59 next day.
  return 'night'
}

// Phrase a gap in bucket-aware writer-language when both prior and
// current have a TOD bucket and the writer is at labelled tier (or
// finer collapsed to labelled). Returns null when the inputs aren't
// rich enough to use bucket phrasing — caller falls back to the
// hour / day ladder.
//
// Day buckets:
//   < 0.5 days   → "right after" (gap == 0) /
//                  "later that {currentBucket}" /
//                  "{currentBucket}" plain when prior+current share bucket
//   0.5 .. 1.5  → "the next {currentBucket}"
//   > 1.5 days  → null (caller uses days/weeks/months/years ladder)
//
// All phrases are NEUTRAL — they don't claim a precise number of
// hours, only that the scene falls in the named bucket relative to
// the prior. Sign convention: positive = forward in time.
// Slice 2 — Family 2: bucket-aware phrasing.
//
// Triggered when:
//   - looser tier is `labelled` (caller checks)
//   - current scene has a derivable TOD bucket (currentBucket non-null)
//
// Templates:
//   gap == 0                                  → "right after"
//   dayShift == 0, sameBucket as prior        → "still that {bucket}"
//   dayShift == 0, different/no prior bucket  → "later that {bucket}"
//   dayShift == 1                             → "the next {bucket}"
//   dayShift >= 2                             → "{N} {unit} later, in the {bucket}"
//                                                where {unit} = days / weeks / months / years
//
// Returns null if the function isn't applicable (no current bucket,
// or invalid minutes); caller falls back to Family 1.
// Labelled TOD names that read as natural noun phrases ("at sunset",
// "at noon"). When BOTH scenes share the same labelled name and it's
// in this set, the phrasing preserves the labelled name instead of
// collapsing to its 5-bucket noun ("a week later, at sunset" rather
// than "...in the evening"). Compound names like "Late Morning" or
// "Pre-Dawn" are excluded because "the next late morning" reads
// awkwardly; those continue to collapse.
const _NATURAL_LABEL_NOUNS = new Set([
  'Sunset', 'Sunrise', 'Noon', 'Midnight', 'Dawn', 'Dusk',
])

function _matchedLabelNoun(opts) {
  const a = opts.priorLabel
  const b = opts.currentLabel
  if (!a || a !== b) return null
  if (!_NATURAL_LABEL_NOUNS.has(a)) return null
  return a.toLowerCase()
}

function _gapPhraseFamily2(minutes, mode = 'compact', opts = {}) {
  const currentBucket = opts.currentBucket ?? null
  const priorBucket   = opts.priorBucket ?? null
  if (!currentBucket || !_BUCKET_NOUNS[currentBucket]) return null
  if (!Number.isFinite(minutes)) return null
  if (minutes === 0) {
    return mode === 'narrative'
      ? 'right when the previous scene ends'
      : 'right after'
  }
  const abs = Math.abs(minutes)
  const days = abs / MIN_PER_DAY
  const dayShift = Number.isFinite(opts.dayShift) ? Math.abs(opts.dayShift) : null
  const noun = _BUCKET_NOUNS[currentBucket]
  const labelNoun = _matchedLabelNoun(opts)

  // Same-day: "still that morning" (same bucket continuation) or
  // "later that morning" (different / no prior bucket). Same-day
  // skips label preservation because "still at sunset" reads
  // weaker than "still that evening" for a continuation feel.
  const isSameDay = dayShift != null ? dayShift === 0 : days < 0.5
  if (isSameDay) {
    if (priorBucket && priorBucket === currentBucket) {
      return `still that ${noun}`
    }
    return `later that ${noun}`
  }

  // Adjacent day. Three sub-cases:
  //   1. Narrative-continuous-night (stayed up past midnight): a
  //      short cross-midnight gap from an evening/night prior into
  //      the post-midnight pre-dawn window. The 5-bucket "night"
  //      noun is reserved for the pre-bedtime evening hours; the
  //      writer thinks of the post-midnight period as one continuous
  //      run from the prior scene. Split at the night/dawn bucket
  //      boundary (03:00):
  //        currentBucket=night (00:00 - 02:59) → "past midnight"
  //        currentBucket=dawn  (03:00 - 05:59) → "before dawn"
  //   2. Sub-bucket preservation: both scenes pinned the same
  //      single-noun labelled TOD ("at sunset the next day").
  //   3. Default: "the next morning/afternoon/evening". Dawn and
  //      night fall back to the "at {bucket} the next day" form
  //      because "the next dawn"/"the next night" reads awkwardly.
  const isAdjacentDay = dayShift != null ? dayShift === 1 : days < 1.5
  if (isAdjacentDay) {
    const isContinuousNight = abs <= 6 * 60
      && (priorBucket === 'evening' || priorBucket === 'night')
      && (currentBucket === 'night' || currentBucket === 'dawn')
    if (isContinuousNight) {
      return currentBucket === 'night' ? 'past midnight' : 'before dawn'
    }
    if (labelNoun) {
      return `at ${labelNoun} the next day`
    }
    if (currentBucket === 'dawn' || currentBucket === 'night') {
      return `${_BUCKET_TAIL_PREP[currentBucket]} ${noun} the next day`
    }
    return `the next ${noun}`
  }

  // Multi-day. Sub-bucket preservation: "a week later, at sunset"
  // when both pins match a single-noun labelled TOD. Otherwise
  // collapse to the 5-bucket noun via the per-bucket preposition.
  const dayCount = dayShift != null ? dayShift : days
  const dayUnit = _dayScaleUnitPhrase(dayCount)
  const tail = mode === 'narrative' ? 'after the previous scene ends' : 'later'
  if (labelNoun) {
    return `${dayUnit} ${tail}, at ${labelNoun}`
  }
  const prep = _BUCKET_TAIL_PREP[currentBucket] || 'in the'
  return `${dayUnit} ${tail}, ${prep} ${noun}`
}

/**
 * Render the "old → new" gap pair. Each side rendered independently
 * via `formatGap` with the same context + tier.
 */
export function formatGapChange(oldMinutes, newMinutes, context = 'compact-gap', opts = {}) {
  return {
    oldDisplay: formatGap(oldMinutes, context, opts),
    newDisplay: formatGap(newMinutes, context, opts),
    hasChange: oldMinutes !== newMinutes,
  }
}

function _gapMagnitude(minutes) {
  if (!Number.isFinite(minutes) || minutes === 0) return 'no gap'
  const sign = minutes < 0 ? '-' : '+'
  const { unit, value } = minutesToTimeDelta(Math.abs(minutes))
  const u = unit.replace(/s$/, '')
  return `${sign}${Math.abs(value)} ${pluralUnit(u, value)}`
}

// Day-scale unit ladder for gap phrasing. Returns "N days" / "N weeks"
// / "N months" / "N years" depending on magnitude — picks the unit
// with the most natural reading at each scale rather than always
// reporting days. Bucket boundaries:
//   < 14 days       → "N days"
//   14 to 89        → "N weeks"
//   90 to 364       → "N months"
//   ≥ 365           → "N years"
// Year math uses 365.25 average so leap-year cycles round cleanly
// (1461 / 365.25 = 4.0). Month math uses 30.4375 (= 365.25 / 12) so
// 12 months sum to a year. Bucket cutoffs match the slot-scale
// ladder so a single chain magnitude reads consistently across
// formatGap and formatSlot displays.
// Spell-out for 2..9 (English journalism convention: spell out small
// numbers in prose, numerals from 10 up). Returns null for counts
// outside that range so callers fall through to numeric.
function _smallCount(n) {
  switch (n) {
    case 2: return 'two'
    case 3: return 'three'
    case 4: return 'four'
    case 5: return 'five'
    case 6: return 'six'
    case 7: return 'seven'
    case 8: return 'eight'
    case 9: return 'nine'
    default: return null
  }
}
function _countWord(n) {
  return _smallCount(n) ?? String(n)
}

function _dayScaleUnitPhrase(absDays) {
  // Idiom collapse for clean calendar boundaries: 7 days reads as
  // "a week", 14 as "two weeks", ~30 as "a month", ~365 as "a year".
  // Falls through to numeric counts for off-boundary values.
  const n = Math.round(absDays)
  if (n === 7)  return 'a week'
  if (n === 14) return 'two weeks'
  if (n === 21) return 'three weeks'
  if (n >= 28 && n <= 31)   return 'a month'
  if (n >= 358 && n <= 372) return 'a year'
  if (absDays < 14) {
    return `${_countWord(n)} ${pluralUnit('day', n)}`
  }
  // 14 .. 55 days: weeks reads naturally. Above 56 (~8 weeks) the
  // writer thinks in months, so switch over earlier than the
  // arithmetic month boundary.
  if (absDays < 56) {
    const weeks = Math.round(absDays / 7)
    if (weeks === 1) return 'a week'
    return `${_countWord(weeks)} ${pluralUnit('week', weeks)}`
  }
  if (absDays < 365) {
    const months = Math.round(absDays / (365.25 / 12))
    if (months === 1) return 'a month'
    return `${_countWord(months)} ${pluralUnit('month', months)}`
  }
  const years = Math.round(absDays / 365.25)
  if (years === 1) return 'a year'
  return `${_countWord(years)} ${pluralUnit('year', years)}`
}

// Slice 1 — Family 1: universal day-scale ladder.
//
// Used as the FALLBACK for every (tier, magnitude) combination when
// the current scene has no TOD bucket / weekday / date enrichment
// pinned. Same output across all tiers because without enrichment
// data, granularity has nowhere to land beyond "later that day" /
// "the next day" / day-scale units. The looser TOD tier doesn't
// change the phrasing here — only enrichment data does, and that's
// added in Slices 2+ (bucket / weekday / date / exact clock).
//
// Magnitude bands:
//   < 30 min      → "right after"  /  base = no anchor; narrative wraps
//   < 12 hr       → "later that day" / "earlier that day"
//   12 – 36 hr    → "the next day" / "the previous day"
//   1.5 – 14 d    → "{N} days later"
//   14 – 90 d     → "{N} weeks later"
//   90 – 365 d    → "{N} months later"
//   ≥ 365 d       → "{N} years later"
//
// Multi-day phrasing uses `_dayScaleUnitPhrase` which rolls days →
// weeks → months → years at the right thresholds. No tier fires
// minute / hour units in this family — that's Slice 6 (exact clock).
//
// `compact` mode is the chip / inline display ("3 days later"). The
// `narrative` mode appends "after the previous scene ends" /
// "before the previous scene ends" for the modal Section 3 / alert
// "Therefore" headline framing.
function _gapPhraseFamily1(minutes, mode = 'compact', opts = {}) {
  // Positive gap only — current scene is forward in time from prior
  // scene's end. Allow Negative Time (current before prior) is
  // V2-parked; if a negative gap shows up we treat the magnitude
  // as positive rather than emit time-travel phrases like "the
  // previous day". Negative-gap phrasing belongs in Slice 7.
  if (!Number.isFinite(minutes) || minutes === 0) {
    return mode === 'narrative'
      ? 'right when the previous scene ends'
      : 'right after'
  }
  const abs = Math.abs(minutes)
  const days = abs / MIN_PER_DAY
  const tail = mode === 'narrative' ? 'after the previous scene ends' : 'later'

  // Calendar day shift between prior_end and current_start. Prefer
  // caller-supplied `dayShift` (computed from absolute chain-day
  // indices) over magnitude-derived approximation, because a 12-hour
  // gap from prior_end at 8 AM to current at 8 PM is the SAME day,
  // not "the next day". Without dayShift, fall back to the magnitude
  // bands (which can mis-classify boundary cases).
  const dayShift = Number.isFinite(opts.dayShift) ? Math.abs(opts.dayShift) : null

  // Same-day: dayShift === 0 (caller knows the calendar didn't roll
  // over) or — fallback — magnitude is < half a day.
  const isSameDay = dayShift != null
    ? dayShift === 0
    : days < 0.5
  if (isSameDay) return 'later that day'

  // Adjacent day: dayShift === 1, or — fallback — magnitude lands
  // in the 0.5–1.5-day band.
  const isAdjacentDay = dayShift != null
    ? dayShift === 1
    : days < 1.5
  if (isAdjacentDay) return 'the next day'

  // Multi-day: prefer the integer dayShift over magnitude/1440 so
  // boundary cases (gap straddles midnight by minutes) round to the
  // calendar truth instead of the float approximation.
  const dayCount = dayShift != null ? dayShift : days
  return `${_dayScaleUnitPhrase(dayCount)} ${tail}`
}

// Slice 3 — Family 3: current scene has a weekday pin (no TOD bucket).
//
// Currently a passthrough to Family 1. The destination scene card
// shows the weekday prominently, so appending "the next Tuesday" or
// "{N} days later, on Tuesday" duplicates info the writer can already
// see. Day-count phrasing from Family 1 ("the next day", "two days
// later", "a week later", "two weeks later", ...) carries everything
// the gap descriptor needs to convey on its own.
//
// "The next Tuesday" specifically reads ambiguously in colloquial
// English — readers often parse it as "Tuesday of next week" rather
// than "this coming Tuesday in 2 days" — another reason to skip the
// weekday tail and let the day-count idioms speak.
//
// Slice 5 will revisit when combining weekday + bucket / weekday +
// date pins, where the combination may carry information the day
// count alone doesn't (e.g. anchoring a multi-week jump to a specific
// weekday-of-week destination). For pure weekday-only, deferring to
// Family 1 is correct.
// eslint-disable-next-line no-unused-vars -- stub: deferred to a future slice; keeps the (minutes, mode, opts) call signature
function _gapPhraseFamily3(_minutes, _mode = 'compact', _opts = {}) {
  return null
}

// Slice 4 — Family 4: current scene has a date pin (month + day) but
// no TOD bucket and no weekday.
//
// Triggered when:
//   - opts.currentDateMonth + opts.currentDateDay are both set
//   - opts.currentBucket is NOT set (Family 2 handles bucket cases)
//   - opts.currentWeekday is NOT set (Family 3 handles weekday-only;
//     Slice 5 will combine weekday + date)
//
// Heuristic for when to APPEND the date tail:
//   - The destination scene card already shows the date prominently,
//     so adding "on May 10" to a precise day count ("5 days later",
//     "a week later", "two weeks later") is just belt-and-braces.
//   - For fuzzy month-tier and year-tier counts ("a month later",
//     "3 months later", "5 years later") the day count alone is
//     ambiguous (could land anywhere within ~30 days), so the date
//     tail genuinely disambiguates.
//   - Year-tier anniversaries (same month + day across years) are
//     tautological — "a year later, on July 4" when prior was Jul 4
//     repeats the calendar pin verbatim. Skip the tail for those;
//     the day count alone reads as "anniversary" naturally.
//
// Returns null when not applicable; caller falls back to Family 1.
function _gapPhraseFamily4(minutes, mode = 'compact', opts = {}) {
  const mm = opts.currentDateMonth
  const dd = opts.currentDateDay
  if (typeof mm !== 'number' || mm < 1 || mm > 12) return null
  if (typeof dd !== 'number' || dd < 1 || dd > 31) return null
  if (!Number.isFinite(minutes) || minutes === 0) return null
  const dayShift = Number.isFinite(opts.dayShift) ? Math.abs(opts.dayShift) : null
  if (dayShift == null) return null
  // Day / week tier — Family 1's "{N} days later" / "a week later" /
  // "two weeks later" / "three weeks later" already gives a precise
  // count; let it stand alone.
  if (dayShift < 56) return null
  // Year-tier anniversary — drop the tail since "a year later" /
  // "{N} years later" already implies same calendar date.
  const priorMm = opts.priorDateMonth
  const priorDd = opts.priorDateDay
  const isAnniversary = (
    typeof priorMm === 'number' && typeof priorDd === 'number'
    && priorMm === mm && priorDd === dd
  )
  if (isAnniversary && dayShift >= 358) return null
  const dateLabel = `${MONTH_NAMES[mm - 1]} ${dd}`
  const dayUnit = _dayScaleUnitPhrase(dayShift)
  const tail = mode === 'narrative' ? 'after the previous scene ends' : 'later'
  return `${dayUnit} ${tail}, on ${dateLabel}`
}

// Slice 5 — combination cases.
//
// Almost every "combination" of pinned signals (bucket + weekday,
// bucket + date, weekday + date, all-three) collapses cleanly:
//
//   - bucket + anything: Family 2's bucket tail carries the meaningful
//     anchor; the weekday or date is on the destination scene card so
//     duplicating it in the gap descriptor adds noise.
//   - weekday + date: weekday is calendar-derivable from date and is
//     visible on the card; date is the more useful anchor for fuzzy
//     month / year spans. Family 4 should fire even when weekday is
//     also pinned — letting it fire is the only Slice 5 routing
//     change.
//
// The routing functions below now: try Family 2 (bucket); fall through
// to Family 4 (date) on any date pin (regardless of weekday); finally
// Family 1 (day-scale ladder). Family 3 stays a no-op placeholder.

function _gapNarrative(minutes, tier, opts = {}) {
  // Family 2 — bucket-aware phrasing dominates when a bucket is pinned;
  // weekday and date pins ride along on the scene card.
  if ((tier === 'labelled' || tier === 'exact') && opts.currentBucket) {
    const f2 = _gapPhraseFamily2(minutes, 'narrative', opts)
    if (f2) return f2
  }
  // Family 3 — weekday-only is currently a no-op (defers to Family 1).
  // The destination card carries the weekday; "{N} days later" reads
  // cleaner than appending a redundant tail. Slot kept for future
  // combination cases that might re-enter it.
  if (typeof opts.currentWeekday === 'number' && !opts.currentBucket) {
    const f3 = _gapPhraseFamily3(minutes, 'narrative', opts)
    if (f3) return f3
  }
  // Family 4 — date-pinned (month + day) without a bucket. Fires on
  // any date pin regardless of weekday: weekday is calendar-derivable
  // from date and is on the destination card; date is the more useful
  // anchor at fuzzy month / year spans.
  if (
    typeof opts.currentDateMonth === 'number'
    && typeof opts.currentDateDay === 'number'
    && !opts.currentBucket
  ) {
    const f4 = _gapPhraseFamily4(minutes, 'narrative', opts)
    if (f4) return f4
  }
  // Family 1 fallback — universal day-scale ladder.
  return _gapPhraseFamily1(minutes, 'narrative', opts)
}

function _gapCompact(minutes, tier, opts = {}) {
  // Family 2 — bucket-aware phrasing dominates when a bucket is pinned;
  // weekday and date pins ride along on the scene card.
  if ((tier === 'labelled' || tier === 'exact') && opts.currentBucket) {
    const f2 = _gapPhraseFamily2(minutes, 'compact', opts)
    if (f2) return f2
  }
  // Family 3 — weekday-only is currently a no-op (defers to Family 1).
  if (typeof opts.currentWeekday === 'number' && !opts.currentBucket) {
    const f3 = _gapPhraseFamily3(minutes, 'compact', opts)
    if (f3) return f3
  }
  // Family 4 — date-pinned (month + day) without a bucket. Fires on
  // any date pin regardless of weekday: weekday is calendar-derivable
  // from date and is on the destination card; date is the more useful
  // anchor at fuzzy month / year spans.
  if (
    typeof opts.currentDateMonth === 'number'
    && typeof opts.currentDateDay === 'number'
    && !opts.currentBucket
  ) {
    const f4 = _gapPhraseFamily4(minutes, 'compact', opts)
    if (f4) return f4
  }
  // Slice 1 — Family 1 fallback. Slice 5 will combine pinned signals;
  // Slice 6 will add exact-tier clock phrasing.
  return _gapPhraseFamily1(minutes, 'compact', opts)
}

// ──────────────────────────────────────────────────────────────────
//  Composite: prior-scene "because…" clause.
// ──────────────────────────────────────────────────────────────────

/**
 * Compose a sentence FRAGMENT describing a scene's pinned constraints
 * in writer-language, intended to be embedded inside a longer
 * sentence by the caller.
 *
 * The clause selects prepositions per concept ("set on" for date,
 * "in" for Time of Day) so the resulting string reads naturally when
 * wrapped:
 *
 *   pinned date only        → "set on May 10"
 *   pinned weekday only     → "set on Monday"
 *   pinned weekday + date   → "set on Tuesday May 10"
 *   pinned TOD only         → "in Late Morning"
 *   pinned date + TOD       → "set on May 10 in Late Morning"
 *   pinned weekday + TOD    → "set on Monday in Late Morning"
 *   pinned everything       → "set on Tuesday May 10 in Sunset"
 *   nothing pinned          → null
 *
 * Caller wraps with a leading verb / framing as needed:
 *
 *   `because the previous scene is now ${clause},`
 *   `the prior scene is ${clause}.`
 *   `your settings mean: ${clause}.`
 *
 * Returns null when nothing is pinned so the caller can skip the
 * wrapping entirely (e.g. omit the "because…" line).
 */
export function formatPriorSceneClause(scene, opts = {}) {
  if (!scene) return null
  const datePart = formatDate(scene, 'because-clause', opts)
  const todPart = formatTimeOfDay(scene, 'because-clause', opts)
  const parts = []
  if (datePart) parts.push(`set on ${datePart}`)
  if (todPart)  parts.push(`in ${todPart}`)
  return parts.length > 0 ? parts.join(' ') : null
}

// ──────────────────────────────────────────────────────────────────
//  Context-specific composites.
//
//  Per-concept formatters above answer "given a value, render it."
//  But each rendering surface ALSO has a higher-level composition
//  shape — how the concepts string together into a full multi-line
//  message for that surface. Those composites live here.
//
//  Each composite returns STRUCTURED output (arrays of strings or
//  named pieces) rather than concrete JSX, so the caller still
//  controls styling / spans / line-break visualisation. The module
//  owns the words; the caller owns the markup.
// ──────────────────────────────────────────────────────────────────

/**
 * Compose the alert "Therefore:" block — the multi-line explanation
 * the writer reads when a downstream scene's earliest start has
 * moved past threshold because of an upstream change.
 *
 * The block is composed in three parts:
 *
 *   1. CAUSAL LINE(S)  — one per concept that changed on the prior.
 *      Each line names the changed concept and shows old → new
 *      ("because the previous scene's date moved from May 10 to
 *      May 1, …"). Phrasing varies by concept and granularity:
 *
 *        Date changed         "the previous scene's date moved from {old} to {new}"
 *        Weekday changed      "the previous scene's weekday moved from {old} to {new}"
 *        Time of Day changed  "the previous scene now occurs in {new} (was {old})"
 *        Duration changed     "the previous scene's duration is now {new} (was {old})"
 *        Gap extension chgd   "the previous scene now has {new} extra time (was {old})"
 *
 *      Multiple causes compose with " and the previous scene's …" tails.
 *
 *   2. CONSTRAINT LINE — describes the affected scene's own pin if
 *      any, since the magnitude of the floor shift depends on the
 *      snap-forward through THIS scene's constraints too. Skipped
 *      when the affected scene has no pinned constraints (in which
 *      case the cause line alone explains the shift).
 *
 *        "and this scene is set on {affectedClause},"
 *
 *   3. EFFECT — the transition phrase + From → To slot pair, owned
 *      by this composite so the wording is consistent across
 *      surfaces.
 *
 * Returns:
 *
 *   {
 *     becauseLines: string[],     // 0..N causal + constraint lines
 *     transitionPhrase: string,   // "the earliest this scene can be:"
 *     oldDisplay: string,         // "Day 5"
 *     newDisplay: string,         // "Day 26"
 *   }
 *
 * Caller renders becauseLines as a stacked list, then the
 * transitionPhrase, then the From → To pair. The module owns the
 * words; the caller owns the markup.
 *
 * @param {object} priorScene     trigger scene's CURRENT data (post-change)
 * @param {object} affectedScene  alert scene's data (downstream, where the alert lives)
 * @param {number} oldEffectiveMinutes  affected scene's effective start before the upstream change
 * @param {number} newEffectiveMinutes  affected scene's effective start after the upstream change
 * @param {Array<{field: string, oldValue: any, newValue: any}>} fieldChanges
 *        the upstream change deltas captured by `_commitScenetimeWrites`
 *        when the alert was raised. Empty array OK — falls back to
 *        the prior's current-state phrasing.
 * @param {object} opts
 * @param {'broad'|'labelled'|'exact'|null} opts.tier
 * @param {string} opts.timeFormat
 */
export function formatAlertTherefore(priorScene, affectedScene, oldEffectiveMinutes, newEffectiveMinutes, fieldChanges = [], opts = {}) {
  const becauseLines = []

  // Group fieldChanges by writer-facing concept. We only care about
  // floor-affecting concepts here; ornamental fields (season) are
  // skipped because they don't move the floor. Discriminator fields
  // (`date_tier`, `time_of_day_tier`) are filtered before this
  // function — see AlertsPanel's call site.
  //
  // Date concept includes weekday + month + day-of-month: the
  // writer thinks of "Tuesday May 10" as a single date, not three
  // separate constraints. Any change to ANY of those fields fires
  // ONE combined Date causal line ("from Tuesday May 10 to
  // Wednesday June 11"). formatDate handles partial pins naturally
  // ("Tuesday" / "Tuesday May" / "Tuesday May 10" etc).
  const TOD_FIELDS = new Set(['time_of_day_broad', 'time_of_day_labelled', 'time_of_day_exact'])
  const DATE_FIELDS = new Set(['weekday', 'date_month', 'date_day_of_month'])
  const todChanges = fieldChanges.filter((c) => TOD_FIELDS.has(c.field))
  const dateChanges = fieldChanges.filter((c) => DATE_FIELDS.has(c.field))
  const durationChange = fieldChanges.find((c) => c.field === 'scene_duration')
  const gapExtChange = fieldChanges.find((c) => c.field === 'gap_extension')

  // Causal phrases, in writer-natural order. Each phrase covers ONE
  // concept. We list:
  //   - CHANGED concepts as "X moved from {old} to {new}" — these
  //     are the active causes of the alert.
  //   - UNCHANGED-BUT-PINNED concepts as "its X is {current}" —
  //     these still contribute to the floor math even though they
  //     didn't change in this pass. Without them the writer can't
  //     reconcile the magnitude (e.g. a +11d date shift might
  //     produce a +16d floor shift because the prior's unchanged
  //     5-day duration is part of the calculation).
  // The writer reads CHANGED first, then UNCHANGED context, so the
  // active cause is foregrounded but the full math is visible.
  const causalPhrases = []
  const contextPhrases = []

  // Date change — combine weekday + date_* fields into a single
  // before/after using the scene's pre/post state. Only fire when
  // at least one date-concept field changed. Unchanged fields are
  // pulled from the prior's CURRENT data so the rendering reflects
  // the full date picture in both old + new states.
  //
  // Combinations handled (`formatDate` handles all of these):
  //   - weekday only           "Tuesday"
  //   - month only             "May"
  //   - month + day            "May 10"
  //   - weekday + month        "Tuesday May"
  //   - weekday + month + day  "Tuesday May 10"
  //
  // Example outputs:
  //   weekday only changed:    "from Tuesday to Wednesday"
  //   day-of-month changed:    "from Tuesday May 10 to Tuesday May 1"
  //   month + day both pinned, day changed: "from May 10 to May 1"
  //   weekday + day both changed: "from Tuesday May 10 to Wednesday May 25"
  if (dateChanges.length > 0) {
    const dateChangeFor = (field) => dateChanges.find((c) => c.field === field)
    const oldDateScene = {
      weekday: dateChangeFor('weekday')?.oldValue ?? priorScene?.weekday,
      date_month: dateChangeFor('date_month')?.oldValue ?? priorScene?.date_month,
      date_day_of_month: dateChangeFor('date_day_of_month')?.oldValue ?? priorScene?.date_day_of_month,
    }
    const newDateScene = {
      weekday: priorScene?.weekday,
      date_month: priorScene?.date_month,
      date_day_of_month: priorScene?.date_day_of_month,
    }
    const oldStr = formatDate(oldDateScene, 'value', opts) ?? '(unset)'
    const newStr = formatDate(newDateScene, 'value', opts) ?? '(unset)'
    if (oldStr !== newStr) {
      causalPhrases.push(`the previous scene's date moved from ${oldStr} to ${newStr}`)
    }
  }

  // Duration change — uses tier-aware Scene Duration formatter.
  if (durationChange) {
    const oldStr = formatSceneDuration(durationChange.oldValue, 'value', opts) ?? '(unset)'
    const newStr = formatSceneDuration(durationChange.newValue, 'value', opts) ?? '(unset)'
    if (oldStr !== newStr) {
      causalPhrases.push(`the previous scene's duration changed from ${oldStr} to ${newStr}`)
    }
  }

  // Time of Day change — pick the looser tier of (old, new) so we
  // don't claim precision the writer didn't pin in BOTH states.
  if (todChanges.length > 0) {
    const oldTodScene = {
      time_of_day_tier: todChanges.find((c) => c.field.endsWith('_tier'))?.oldValue ?? priorScene?.time_of_day_tier,
      time_of_day_broad: todChanges.find((c) => c.field === 'time_of_day_broad')?.oldValue ?? priorScene?.time_of_day_broad,
      time_of_day_labelled: todChanges.find((c) => c.field === 'time_of_day_labelled')?.oldValue ?? priorScene?.time_of_day_labelled,
      time_of_day_exact: todChanges.find((c) => c.field === 'time_of_day_exact')?.oldValue ?? priorScene?.time_of_day_exact,
    }
    // The OLD scene's tier is whichever leaf was non-null then;
    // walker convention is to keep `tier` consistent with the
    // populated leaf. We don't have explicit old-tier here so we
    // infer from the leaf populated.
    if (oldTodScene.time_of_day_exact && !oldTodScene.time_of_day_tier) oldTodScene.time_of_day_tier = 'exact'
    else if (oldTodScene.time_of_day_labelled && !oldTodScene.time_of_day_tier) oldTodScene.time_of_day_tier = 'labelled'
    else if (oldTodScene.time_of_day_broad && !oldTodScene.time_of_day_tier) oldTodScene.time_of_day_tier = 'broad'
    const newTodScene = priorScene
    const tier = looserTier(oldTodScene.time_of_day_tier, newTodScene.time_of_day_tier)
    const todOpts = { ...opts, targetTier: tier }
    const oldStr = formatTimeOfDay(oldTodScene, 'value', todOpts) ?? '(unset)'
    const newStr = formatTimeOfDay(newTodScene, 'value', todOpts) ?? '(unset)'
    if (oldStr !== newStr) {
      causalPhrases.push(`the previous scene's time of day moved from ${oldStr} to ${newStr}`)
    }
  }

  // Gap-extension change.
  if (gapExtChange) {
    const oldStr = formatGapExtension(gapExtChange.oldValue, 'value', opts) ?? 'no extension'
    const newStr = formatGapExtension(gapExtChange.newValue, 'value', opts) ?? 'no extension'
    if (oldStr !== newStr) {
      causalPhrases.push(`the previous scene's extra time changed from ${oldStr} to ${newStr}`)
    }
  }

  // ── Unchanged-but-pinned context phrases ────────────────────
  // Concepts that are pinned on the prior but DIDN'T change in this
  // pass still contribute to the floor math. List them after the
  // causal phrases so the writer can reconcile the magnitude.
  // Skipped per concept when that concept also appears in causal
  // phrases (no double-mention).
  const dateConceptPinned = priorScene && (
    typeof priorScene.weekday === 'number'
    || typeof priorScene.date_month === 'number'
    || typeof priorScene.date_day_of_month === 'number'
  )
  const dateConceptChanged = dateChanges.length > 0
  if (dateConceptPinned && !dateConceptChanged) {
    const cur = formatDate(priorScene, 'value', opts)
    if (cur) contextPhrases.push(`its date is still ${cur}`)
  }

  const todConceptPinned = priorScene?.time_of_day_tier
  const todConceptChanged = todChanges.length > 0
  if (todConceptPinned && !todConceptChanged) {
    const cur = formatTimeOfDay(priorScene, 'value', opts)
    if (cur) contextPhrases.push(`it still occurs in ${cur}`)
  }

  const durationPinned = priorScene?.scene_duration && priorScene.scene_duration.kind && priorScene.scene_duration.kind !== 'ambiguous'
  if (durationPinned && !durationChange) {
    const cur = formatSceneDuration(priorScene.scene_duration, 'value', opts)
    if (cur) contextPhrases.push(`its ${cur} duration still applies`)
  }

  const gapExtPinned = priorScene?.gap_extension
  if (gapExtPinned && !gapExtChange) {
    const cur = formatGapExtension(priorScene.gap_extension, 'value', opts)
    if (cur) contextPhrases.push(`it still carries ${cur} of extra time`)
  }

  // Compose the causal line(s). When multiple concepts changed
  // (a common case — duration AND date BOTH contribute to the
  // floor shift in some scenarios), the writer needs to see each
  // cause explicitly so the magnitude makes sense.
  //
  // Unchanged-but-pinned context phrases follow the causal phrases
  // so the writer can reconcile the FULL math, not just the active
  // changes. e.g. "because the date moved from May 10 to May 1, and
  // its 5-day duration still applies, …" — the unchanged 5-day
  // duration is part of the floor calculation even though it didn't
  // change in this pass.
  //
  // To avoid the repetitive "the previous scene's date moved … and
  // the previous scene's duration changed …", subsequent phrases
  // substitute "its" for "the previous scene's" so the sentence
  // reads naturally:
  //
  //   "because the previous scene's date moved from May 10 to May 1,
  //   and its duration changed from 2 hours to 5 days,"
  //
  // Three or more phrases use Oxford-comma style.
  const allPhrases = [...causalPhrases, ...contextPhrases]
  if (allPhrases.length > 0) {
    const reduced = allPhrases.map((p, idx) => idx === 0
      ? p
      : p.replace(/^the previous scene's/, 'its'))
    let joined
    if (reduced.length === 1) joined = reduced[0]
    else if (reduced.length === 2) joined = `${reduced[0]}, and ${reduced[1]}`
    else joined = reduced.slice(0, -1).join(', ') + ', and ' + reduced[reduced.length - 1]
    becauseLines.push(`because ${joined},`)
  } else if (causalPhrases.length === 0) {
    // Fallback: no fieldChanges available (old alerts written before
    // trigger info was captured). Use the prior's CURRENT state as
    // the cause framing — less informative but better than nothing.
    const priorClause = formatPriorSceneClause(priorScene, opts)
    if (priorClause) becauseLines.push(`because the previous scene is now ${priorClause},`)
  }

  // Constraint line — the affected scene's own pin, which determines
  // how the upstream change magnifies into a multi-day jump via
  // snap-forward.
  const affectedClause = formatPriorSceneClause(affectedScene, opts)
  if (affectedClause) becauseLines.push(`and this scene is ${affectedClause},`)

  // Edge case: if NO causal line and an affected clause, normalise
  // wording so the lone constraint line reads as a complete cause.
  if (causalPhrases.length === 0 && becauseLines.length === 1 && !formatPriorSceneClause(priorScene, opts)) {
    becauseLines[0] = `because this scene is ${affectedClause},`
  }

  // Pick a single slot scale for both From → To displays so the
  // writer reads them on the same axis. The coarser of the two
  // sides' natural scales wins — e.g. a transition from "Day 64"
  // (week-scale) to "Day 1521" (year-scale) renders both as
  // "Year 1, Day 64 → Year 5, Day 60" so the magnitude lands.
  const oldDay = Number.isFinite(oldEffectiveMinutes)
    ? Math.floor(oldEffectiveMinutes / MIN_PER_DAY) + 1
    : 1
  const newDay = Number.isFinite(newEffectiveMinutes)
    ? Math.floor(newEffectiveMinutes / MIN_PER_DAY) + 1
    : 1
  const slotScale = _coarserSlotScale(_slotScaleForDay(oldDay), _slotScaleForDay(newDay))
  const slotOpts = { ...opts, scaleHint: slotScale }

  return {
    becauseLines,
    transitionPhrase: 'the earliest this scene can be:',
    oldDisplay: formatSlot(oldEffectiveMinutes, 'value-with-slot', slotOpts) ?? '?',
    newDisplay: formatSlot(newEffectiveMinutes, 'value-with-slot', slotOpts) ?? '?',
  }
}

// ──────────────────────────────────────────────────────────────────
//  Internal helpers.
// ──────────────────────────────────────────────────────────────────

/**
 * "1 hour" / "2 hours" — singular vs plural. Used everywhere a
 * unit gets attached to a count.
 */
function pluralUnit(unit, value) {
  return Math.abs(value) === 1 ? unit : `${unit}s`
}

function capitalize(s) {
  if (typeof s !== 'string' || s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Render a `TimeDelta` `{unit, value}` as "N units" or "1 unit".
 * Returns null for zero or invalid values so callers can short-
 * circuit.
 */
function formatTimeDelta(td) {
  if (!td || !Number.isFinite(td.value)) return null
  const v = Number(td.value)
  if (v === 0) return null
  const u = (td.unit || '').replace(/s$/, '')
  return `${v} ${pluralUnit(u, v)}`
}

// ──────────────────────────────────────────────────────────────────
//  Re-exports for caller convenience.
//
//  Consumers that need both walker primitives + verbiage formatters
//  can import everything from this module rather than threading two
//  imports per file.
// ──────────────────────────────────────────────────────────────────

export { sceneStartMinutesOfDay, timeDeltaToMinutes, minutesToTimeDelta }
