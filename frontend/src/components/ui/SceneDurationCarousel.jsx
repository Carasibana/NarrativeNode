/**
 * Phase 1.23 — Scene Duration carousel.
 *
 * Seven stops in magnitude order from no commitment to largest:
 *   1. Ambiguous           (default starting position; no specifics)
 *   2. Minutes              (optional integer-minutes input)
 *   3. Hours                (optional integer-or-decimal hours input)
 *   4. All <period>         (context-aware; hidden when no start
 *                            Time of Day pinned)
 *   5. <period> → <period>  (span; context-aware; hidden when no
 *                            start Time of Day pinned)
 *   6. All Day              (no specifics)
 *   7. Days                 (optional integer-days input)
 *
 * Per-stop drafts (mirrors §2.2 / §3): the writer can rotate freely
 * between stops and set values on several within the modal session.
 * On Save only the active stop's value persists; other stops' draft
 * values are session-only.
 *
 * Magnitude-without-specifics is valid: a writer who picks "Hours"
 * but enters no number is committing to "on the order of hours,
 * length unspecified". The numeric inputs are opportunities, never
 * demands.
 *
 * Cross-magnitude conversion is NOT automatic: rotating from
 * "3 hours" to Minutes does NOT pre-fill 180 minutes. The two
 * stops describe different magnitudes; the writer's intent at one
 * does not infer their intent at the other.
 *
 * State shape (controlled component):
 *
 *   state = {
 *     activeStop: 'ambiguous' | 'minutes' | 'hours' | 'all_period'
 *               | 'span' | 'all_day' | 'days' | null,
 *     drafts: {
 *       ambiguous: {},
 *       minutes:   { value: number | null },
 *       hours:     { value: number | null },
 *       all_period: {},
 *       span:      { endPeriod: 'morning'|'noon'|'afternoon'|'evening'|'night' | null },
 *       all_day:   {},
 *       days:      { value: number | null },
 *     },
 *   }
 *
 * Props:
 *   state, onChange  — controlled state.
 *   startBucket      — one of the 5 period buckets (morning / noon /
 *                      afternoon / evening / night) or null. When
 *                      null, the All-period and Span stops are
 *                      hidden — the writer hasn't pinned a start
 *                      Time of Day, so they can't be expressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GranularityCarousel from './GranularityCarousel'
import { TIME_OF_DAY_LABELS, CELL_VISUALS, CellGlyph } from './TimeOfDayCarousel'

// 5-bucket period vocabulary (planning doc §4.1.1). Distinct from
// the 15-label Tier 2 set used by Time of Day; these wider buckets
// are what reads naturally in prose ("All Morning", "Morning →
// Evening") and what the All-period and Span stops express.
// 5-bucket period vocabulary mirrors the labelled tier's gearshift
// column layout (TimeOfDayCarousel.GEARSHIFT_COLUMNS): each bucket
// is one column, holding [early, main, late] variants. The All-Period
// stop displays exactly the column's labels and the bucket name
// matches the column's centre label.
export const PERIOD_BUCKETS = ['dawn', 'morning', 'afternoon', 'evening', 'night']

const PERIOD_LABELS = {
  dawn:      'Dawn',
  morning:   'Morning',
  afternoon: 'Afternoon',
  evening:   'Evening',
  night:     'Night',
}

// Map a Time of Day Tier-2 label to its 5-bucket period. Buckets
// match the labelled tier's gearshift columns (each column = one
// bucket of [early, main, late] variants). Tier-1 broad pins
// (Day / Night) are too coarse for either context-aware stop and
// should map to null so callers hide the All-period and Span stops
// the same as when no start is pinned at all.
const TOD_LABEL_TO_BUCKET = {
  'Pre-Dawn':       'dawn',
  'Dawn':           'dawn',
  'Sunrise':        'dawn',
  'Early Morning':  'morning',
  'Morning':        'morning',
  'Late Morning':   'morning',
  'Noon':           'afternoon',
  'Afternoon':      'afternoon',
  'Late Afternoon': 'afternoon',
  'Sunset':         'evening',
  'Evening':        'evening',
  'Dusk':           'evening',
  'Early Night':    'night',
  'Night':          'night',
  'Midnight':       'night',
}

export function timeOfDayLabelToBucket(label) {
  if (label == null) return null
  return TOD_LABEL_TO_BUCKET[label] ?? null
}

// Resolve a Time of Day draft (whichever tier is active — broad /
// labelled / exact) to a 5-bucket period. The All-Day toggle pair +
// All-Period / Span stops all need a bucket to know whether the
// scene starts during day or night, so their visibility and the
// linked-button cadence track the writer's active pin regardless of
// granularity.
//
//   broad  'day'         → 'morning'  (day-period representative)
//   broad  'night'       → 'night'
//   labelled <label>     → TOD_LABEL_TO_BUCKET lookup
//   exact  HH:MM         → 5-bucket boundaries (planning §4.1.1)
//   anything unset       → null
export function timeOfDayDraftToBucket(state) {
  if (!state) return null
  const tier = state.activeTier
  const drafts = state.drafts || {}
  if (tier === 'labelled' && drafts.labelled) {
    return TOD_LABEL_TO_BUCKET[drafts.labelled] ?? null
  }
  if (tier === 'broad' && drafts.broad) {
    return drafts.broad === 'night' ? 'night' : 'morning'
  }
  if (tier === 'exact' && drafts.exact) {
    return _bucketForExactClock(drafts.exact)
  }
  return null
}

function _bucketForExactClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  const minOfDay = Number(m[1]) * 60 + Number(m[2])
  // 5-bucket boundaries match the labelled-tier gearshift columns.
  // Pre-Dawn opens the cycle at 03:00; Midnight tail wraps back into
  // the night bucket from 00:00 through 02:59.
  if (minOfDay >= 3 * 60       && minOfDay < 6 * 60)        return 'dawn'
  if (minOfDay >= 6 * 60       && minOfDay < 11 * 60 + 30)  return 'morning'
  if (minOfDay >= 11 * 60 + 30 && minOfDay < 16 * 60 + 30)  return 'afternoon'
  if (minOfDay >= 16 * 60 + 30 && minOfDay < 22 * 60)       return 'evening'
  return 'night'
}

// Tier-2 labels later than `startLabel` in the day cycle, including
// the start itself. Drives the new Tier-2 end picker on the Span
// stop so the writer can name an end point at the same granularity
// they pinned the start at.
function tier2LabelsFromStart(startLabel) {
  if (!startLabel) return []
  const idx = TIME_OF_DAY_LABELS.indexOf(startLabel)
  if (idx < 0) return []
  // Same-day options: labels from start onwards through Midnight.
  // Next-day options: labels before start in the day cycle, tagged so
  // the writer can express "until <label> of the next day". The walker
  // already handles cross-midnight via its bucket-comparison branch
  // (an end label with a bucket earlier than the start's bucket adds
  // a full day to the span); this dropdown gives the writer a UI
  // affordance to actually pick those.
  const sameDay = TIME_OF_DAY_LABELS.slice(idx).map((label) => ({ label, nextDay: false }))
  const nextDay = TIME_OF_DAY_LABELS.slice(0, idx).map((label) => ({ label, nextDay: true }))
  return [...sameDay, ...nextDay]
}

// Inverse of TOD_LABEL_TO_BUCKET — Tier-2 labels grouped by the
// 5-bucket period they belong to. Used by the All-period widget to
// concretely name what "the morning period" / "the evening period"
// covers, since "All Evening" alone doesn't tell the writer which
// labels are spanned.
const LABELS_PER_BUCKET = (() => {
  const map = { dawn: [], morning: [], afternoon: [], evening: [], night: [] }
  for (const label of TIME_OF_DAY_LABELS) {
    const b = TOD_LABEL_TO_BUCKET[label]
    if (b && map[b]) map[b].push(label)
  }
  return map
})()

// Stop ids in display order. The combined 'numeric' stop replaced
// the v0.1.23.x split minutes / hours / days stops with a single
// "Length" widget that has a value input + unit dropdown. Persisted
// scene_duration.kind still uses 'minutes' / 'hours' / 'days' per
// the dropdown selection — the consolidation is UI-only.
const STOP_IDS = ['ambiguous', 'numeric', 'all_period', 'span', 'all_day']

const STOP_LABELS = {
  ambiguous:  'Ambiguous',
  numeric:    'Length',
  all_period: 'All …',
  span:       'Runs until …',
  all_day:    'All Day',
}

// Stops that need a pinned start period to be meaningful.
const CONTEXT_AWARE_STOPS = new Set(['all_period', 'span'])

// ── Number input helper ──────────────────────────────────────────────
//
// Optional numeric input. Supports decimal for hours; integer for
// minutes / days (caller passes `step`). Empty / NaN clears the value
// (passes null). Negative values rejected.
function NumericInput({ value, onChange, placeholder, step = 1, ariaLabel }) {
  return (
    <input
      type="number"
      min={0}
      step={step}
      value={value ?? ''}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') { onChange(null); return }
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) return
        onChange(n)
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className="w-24 h-7 text-sm text-center rounded-md bg-transparent border border-zinc-700 text-zinc-100 focus:outline-none focus:border-sky-600"
    />
  )
}

// ── Per-stop widget renderers ────────────────────────────────────────

function AmbiguousWidget() {
  return (
    <div className="text-xs text-zinc-500 italic leading-relaxed text-center">
      No commitment — this scene's duration is unspecified. The next
      scene's start floor inherits the same time as this scene's
      start.
    </div>
  )
}

// Combined Length widget — value input + unit dropdown on one line,
// hint on the line below. Replaces the v0.1.23.x split Minutes /
// Hours / Days stops. Step granularity follows the unit (1 for
// minutes / days, 0.5 for hours so writers can express 1.5 hours).
const NUMERIC_UNITS = [
  { id: 'minutes', label: 'minutes', step: 1   },
  { id: 'hours',   label: 'hours',   step: 0.5 },
  { id: 'days',    label: 'days',    step: 1   },
]

function NumericWidget({ value, unit, onChange }) {
  const safeUnit = NUMERIC_UNITS.find((u) => u.id === unit) ? unit : 'hours'
  const step = NUMERIC_UNITS.find((u) => u.id === safeUnit)?.step ?? 1
  const hasValue = Number.isFinite(value)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <NumericInput
          value={value}
          onChange={(v) => onChange({ value: v, unit: safeUnit })}
          placeholder="(optional)"
          step={step}
          ariaLabel="Length"
        />
        {/* Clear button sits OUTSIDE the input so it doesn't collide
            with the number-spinner up/down arrows the browser draws
            on `<input type=number>`. Reserved width keeps the column
            stable when the button toggles. */}
        <button
          type="button"
          onClick={() => onChange({ value: null, unit: safeUnit })}
          disabled={!hasValue}
          title='Clear value (back to "length unspecified")'
          aria-label="Clear length value"
          className={
            'w-5 h-5 inline-flex items-center justify-center rounded-full border text-[12px] leading-none transition-colors ' +
            (hasValue
              ? 'border-zinc-600 text-zinc-300 hover:text-zinc-100 hover:border-zinc-400 hover:bg-zinc-800 cursor-pointer'
              : 'border-zinc-800 text-zinc-700 cursor-default')
          }
        >
          ×
        </button>
        <select
          value={safeUnit}
          onChange={(e) => onChange({ value, unit: e.target.value })}
          className="h-7 text-xs rounded bg-zinc-900 border border-zinc-700 text-zinc-200 px-2 hover:border-zinc-600 focus:outline-none focus:border-sky-600"
          aria-label="Length unit"
        >
          {NUMERIC_UNITS.map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>
      </div>
      <div className="text-[11px] text-zinc-500 italic leading-snug text-center">
        {safeUnit === 'hours'
          ? 'Decimals allowed (e.g. 1.5). Blank = "hours, length unspecified".'
          : `Blank = "${safeUnit}, length unspecified".`}
      </div>
    </div>
  )
}

function AllPeriodWidget({ startBucket }) {
  const label = PERIOD_LABELS[startBucket]
  const labels = LABELS_PER_BUCKET[startBucket] ?? []
  return (
    <div className="text-zinc-200 space-y-2 text-center">
      <div className="text-base flex items-center justify-center gap-1.5">
        <span>All</span>
        {/* Headline period name picks up the Tier-2 visual (CellGlyph
            + accent colour) since the 5-bucket period names match
            their representative Tier-2 labels (Dawn / Morning /
            Afternoon / Evening / Night). */}
        <LabelRow label={label} />
      </div>
      {labels.length > 0 && (
        <div className="text-[11px] text-zinc-500 italic leading-snug flex items-center justify-center gap-1 flex-wrap">
          <span>covers</span>
          {labels.map((l, i) => {
            const isLast = i === labels.length - 1
            const sep = isLast
              ? null
              : (i === labels.length - 2 ? (labels.length === 2 ? ' and ' : ', and ') : ', ')
            return (
              <span key={l} className="inline-flex items-center gap-1">
                <LabelRow label={l} />
                {sep && <span>{sep}</span>}
              </span>
            )
          })}
          <span>. Scene runs through all of them.</span>
        </div>
      )}
    </div>
  )
}

// Single Tier-2 label row with its CellGlyph + accent-coloured text.
// Used inside the Span stop's custom dropdown.
function LabelRow({ label, withGlyph = true }) {
  const visual = CELL_VISUALS[label]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {withGlyph && visual && (
        <CellGlyph
          base={visual.base}
          modifier={visual.modifier}
          colour={visual.colour}
          size={14}
        />
      )}
      <span style={visual?.colour ? { color: visual.colour } : undefined}>
        {label}
      </span>
    </span>
  )
}

// Tier-2-aware end-label picker for the Span stop. Custom dropdown
// rather than native <select> so each option can render its
// CellGlyph + accent-coloured text. When the writer pinned a Tier-2
// label as the start, options span from that label through Midnight
// (the day cycle's end).
function SpanLabelPicker({ startLabel, value, onChange }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const options = useMemo(() => tier2LabelsFromStart(startLabel), [startLabel])

  // Fixed-position dropdown anchored to the trigger's bbox. The
  // alternative — `position: absolute` relative to the picker's
  // wrap div — is clipped by ancestor `overflow-hidden` (the modal
  // shell) and `overflow-y-auto` (the modal's main pane). Fixed
  // positioning escapes those clips. Recalculated on open / scroll
  // / resize so the dropdown follows the trigger when the modal
  // body scrolls.
  const [dropdownStyle, setDropdownStyle] = useState(null)
  useEffect(() => {
    if (!open) return
    function recompute() {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // Open downward unless the dropdown's max-height (~256px) would
      // fall off the viewport bottom; in that case open upward.
      const ESTIMATED_HEIGHT = 256 + 8
      const flipUp = rect.bottom + ESTIMATED_HEIGHT > window.innerHeight
      const top = flipUp ? rect.top - 4 : rect.bottom + 4
      setDropdownStyle({
        position: 'fixed',
        left: rect.left,
        top,
        minWidth: rect.width,
        transform: flipUp ? 'translateY(-100%)' : undefined,
      })
    }
    recompute()
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDocPointer(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      // The fixed-position dropdown lives outside wrapRef; check it
      // separately via a dedicated ref or `data-` marker. For
      // simplicity here we close on any outside-click; clicks INSIDE
      // the dropdown handle their own onClick before propagation.
      const dd = document.getElementById('span-label-dropdown')
      if (dd && dd.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocPointer)
    return () => document.removeEventListener('mousedown', onDocPointer)
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-7 inline-flex items-center gap-2 px-2 text-sm rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 hover:border-zinc-600 focus:outline-none focus:border-sky-600"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value ? <LabelRow label={value} /> : <span className="text-zinc-500 italic">(pick end point)</span>}
        <span className="text-zinc-500 text-[10px]">▾</span>
      </button>
      {open && dropdownStyle && (
        <div
          id="span-label-dropdown"
          role="listbox"
          style={{ ...dropdownStyle, zIndex: 100 }}
          className="rounded-md border border-zinc-700 bg-zinc-900 shadow-xl py-1 max-h-64 overflow-y-auto"
        >
          {options.map(({ label, nextDay }) => {
            const key = nextDay ? `nd:${label}` : label
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={label === value}
                onClick={() => { onChange(label); setOpen(false) }}
                className={
                  'w-full text-left px-2 py-1 text-sm flex items-center gap-2 ' +
                  (label === value
                    ? 'bg-zinc-800'
                    : 'hover:bg-zinc-800/70')
                }
              >
                <LabelRow label={label} />
                {nextDay && (
                  <span className="text-[10px] text-zinc-500 italic ml-auto">
                    The Next Day
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SpanWidget({ startTimeOfDayLabel, endLabel, onChange }) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      <LabelRow label={startTimeOfDayLabel} />
      <span className="text-zinc-500">→</span>
      <SpanLabelPicker
        startLabel={startTimeOfDayLabel}
        value={endLabel}
        onChange={onChange}
      />
    </div>
  )
}

// Day-vs-night classification for the All-Day variant gating.
// "Day-period start" scenes (dawn / morning / afternoon) get the
// [All Day][All Night] toggle pair; "night-period start" scenes
// (evening / night) get the [All Night][Next Day] pair. The widget
// hides itself when no start TOD is pinned (the carousel hides the
// All-Day stop in that case via the SceneDurationCarousel filter
// logic).
const DAY_BUCKETS   = new Set(['dawn', 'morning', 'afternoon'])
const NIGHT_BUCKETS = new Set(['evening', 'night'])

// Tooltip explaining the link chord on the right-hand button.
const LINK_TOOLTIP_DAY_START =
  'Linked to All Day. Turning All Night on automatically turns All Day on; turning All Day off automatically turns All Night off.'
const LINK_TOOLTIP_NIGHT_START =
  'Linked to All Night. Turning Next Day on automatically turns All Night on; turning All Night off automatically turns Next Day off.'

// Variant descriptions shown beneath the toggle pair when a variant
// is active. Keyed by the active variant string the toggle pair
// resolves to.
const ALL_DAY_VARIANT_DESCRIPTIONS = {
  all_day:            "Runs from the scene's start until the daytime ends (just before evening begins).",
  all_night:          "Runs from the scene's start until the day cycle ends at midnight.",
  until_next_evening: 'Crosses midnight and runs into the following day, ending at the next day’s evening.',
}

// Accent colours mirroring the BroadPicker (Time of Day Tier 1).
const DAY_ACCENT   = '#f59e0b'  // amber
const NIGHT_ACCENT = '#4338ca'  // indigo

// Small chain-link badge sitting on the linked button. The circle
// outline + 🔗 glyph signals "this button is chorded to its partner";
// the writer hovers for the full explanation. Anchored top-left so
// the badge sits on the side that faces the partner button (which is
// always to the LEFT for the chorded buttons in our layouts).
function LinkBadge({ title }) {
  return (
    <span
      title={title}
      aria-label={title}
      className="absolute -top-1.5 -left-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full border border-zinc-500 bg-zinc-900 text-[8px] leading-none cursor-help"
    >
      🔗
    </span>
  )
}

// Square 64x64 button matching the BroadPicker (Tier 1 of the Time of
// Day carousel). Renders glyph above small label; accent fill when
// active, transparent + outlined when inactive. Optional link badge
// in the top-left corner for chorded buttons.
function VariantButton({ label, active, accent, glyphBase, onClick, linkBadgeTitle = null }) {
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={active ? 'Click again to clear' : `Set to ${label}`}
        className={`flex flex-col items-center justify-center gap-1 w-16 h-16 rounded-md transition-colors select-none ${
          active ? '' : 'text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800'
        }`}
        style={{
          backgroundColor: active ? accent : 'transparent',
          border: `1px solid ${active ? accent : '#3f3f46'}`,
          color: active ? '#fafafa' : undefined,
        }}
      >
        <svg width={32} height={32} viewBox="0 0 32 32">
          <CellGlyph base={glyphBase} modifier="plain" colour={active ? '#fafafa' : accent} size={32} />
        </svg>
        <span className="text-[10px] font-medium leading-none">{label}</span>
      </button>
      {linkBadgeTitle ? <LinkBadge title={linkBadgeTitle} /> : null}
    </span>
  )
}

function AllDayWidget({ startBucket, variant, onChange }) {
  // Without a start bucket pinned the toggle pair has no meaningful
  // reading; the parent carousel already hides the All-Day stop in
  // that case, so this is just defensive.
  if (!startBucket) return null

  const isDayStart   = DAY_BUCKETS.has(startBucket)
  const isNightStart = NIGHT_BUCKETS.has(startBucket)
  if (!isDayStart && !isNightStart) return null

  // Resolve the abstract variant string to the on/off state of each
  // toggle. Legacy 'until_next_day' is treated as 'until_next_evening'
  // for display purposes; the walker maps both to the same result so
  // load-time normalisation isn't strictly needed.
  const v = variant === 'until_next_day' ? 'until_next_evening' : variant

  if (isDayStart) {
    // Toggle pair: [All Day] [All Night]. All Night is linked to
    // All Day (chord rules below). Header above: a single "Same Day"
    // line spanning both buttons.
    const allDayOn   = v === 'all_day' || v === 'all_night'
    const allNightOn = v === 'all_night'

    function toggleAllDay() {
      // Turning All Day OFF auto-clears All Night (chord cascade).
      // Turning All Day ON leaves All Night where it is.
      if (allDayOn) onChange(null)
      else onChange('all_day')
    }
    function toggleAllNight() {
      // Turning All Night ON forces All Day ON (chord); turning OFF
      // returns to All Day (the upstream toggle's state).
      if (allNightOn) onChange('all_day')
      else onChange('all_night')
    }

    return (
      <div className="flex flex-col items-center space-y-2">
        <div className="inline-block">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 text-center pb-1 border-b border-zinc-800 mb-1.5">
            Same Day
          </div>
          <div className="flex items-center justify-center gap-2">
            <VariantButton label="All Day"   active={allDayOn}   accent={DAY_ACCENT}   glyphBase="noon"      onClick={toggleAllDay} />
            <VariantButton label="All Night" active={allNightOn} accent={NIGHT_ACCENT} glyphBase="moon-star" onClick={toggleAllNight} linkBadgeTitle={LINK_TOOLTIP_DAY_START} />
          </div>
        </div>
        {/* Reserve description height even when no variant is active so
            toggling on/off doesn't shift the rest of the modal. */}
        <div className="text-[11px] text-zinc-500 italic leading-snug text-center" style={{ minHeight: 30 }}>
          {v ? ALL_DAY_VARIANT_DESCRIPTIONS[v] : ' '}
        </div>
      </div>
    )
  }

  // Night-period start. Toggle pair: [All Night] [Next Day]. Next
  // Day is linked to All Night (chord rules below). Header above
  // splits at the midpoint: "Same Day" centered above All Night,
  // "Next Day" centered above Next Day.
  const allNightOn = v === 'all_night' || v === 'until_next_evening'
  const nextDayOn  = v === 'until_next_evening'

  function toggleAllNight() {
    if (allNightOn) onChange(null)
    else onChange('all_night')
  }
  function toggleNextDay() {
    if (nextDayOn) onChange('all_night')
    else onChange('until_next_evening')
  }

  return (
    <div className="flex flex-col items-center space-y-2">
      <div className="inline-block">
        <div className="grid grid-cols-2 gap-2 mb-1.5">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 text-center pb-1 border-b border-zinc-800">
            Same Day
          </div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 text-center pb-1 border-b border-zinc-800">
            Next Day
          </div>
        </div>
        <div className="flex items-center justify-center gap-2">
          <VariantButton label="All Night" active={allNightOn} accent={NIGHT_ACCENT} glyphBase="moon-star" onClick={toggleAllNight} />
          <VariantButton label="Next Day"  active={nextDayOn}  accent={DAY_ACCENT}   glyphBase="sunrise"   onClick={toggleNextDay} linkBadgeTitle={LINK_TOOLTIP_NIGHT_START} />
        </div>
      </div>
      {v && (
        <div className="text-[11px] text-zinc-500 italic leading-snug text-center">
          {ALL_DAY_VARIANT_DESCRIPTIONS[v]}
        </div>
      )}
    </div>
  )
}

// ── SceneDurationCarousel ────────────────────────────────────────────

export default function SceneDurationCarousel({ state, onChange, startBucket = null, startTimeOfDayLabel = null }) {
  const drafts = state?.drafts ?? {
    ambiguous:  {},
    minutes:    { value: null },
    hours:      { value: null },
    all_period: {},
    span:       { endPeriod: null },
    all_day:    { variant: null },
    days:       { value: null },
  }
  const activeStop = state?.activeStop ?? 'ambiguous'

  // Filter out context-aware stops when their context isn't met.
  // Hidden stops are skipped on rotation rather than rendered as a
  // disabled state (planning doc §4.1). All-period needs a 5-bucket
  // start (any TOD pin); Span needs a Tier-2 label specifically (so
  // its end picker can offer matching-granularity options).
  const stops = useMemo(() => {
    return STOP_IDS
      .filter((id) => {
        if (id === 'all_period') return startBucket != null
        if (id === 'all_day')    return startBucket != null
        if (id === 'span')       return startTimeOfDayLabel != null
        return true
      })
      .map((id) => ({ id, label: STOP_LABELS[id] }))
  }, [startBucket, startTimeOfDayLabel])

  // If the currently-active stop just became hidden (start TOD got
  // unpinned), fall back to Ambiguous on the next render. This stops
  // the carousel locking into an invisible-tier state.
  const safeActive = stops.find((t) => t.id === activeStop) ? activeStop : 'ambiguous'

  const setActiveStop = useCallback((nextStop) => {
    if (nextStop === safeActive) return
    onChange({ activeStop: nextStop, drafts })
  }, [safeActive, drafts, onChange])

  const setDraft = useCallback((stopId, nextDraft) => {
    onChange({
      activeStop: safeActive,
      drafts: { ...drafts, [stopId]: nextDraft },
    })
  }, [safeActive, drafts, onChange])

  // Hint text — surfaces when retained drafts at OTHER stops would
  // be discarded on Save (matches Time of Day's hint pattern).
  const otherStopsWithDrafts = STOP_IDS.filter((id) => {
    if (id === safeActive) return false
    const d = drafts[id]
    if (!d) return false
    if (id === 'numeric') return d.value != null
    if (id === 'span') return d.endPeriod != null
    if (id === 'all_day') return d.variant != null
    return false
  })
  const hint = otherStopsWithDrafts.length > 0
    ? `Retained drafts at: ${otherStopsWithDrafts.map((id) => STOP_LABELS[id]).join(', ')} (only the active stop saves)`
    : null

  return (
    <GranularityCarousel
      tiers={stops}
      activeTierId={safeActive}
      onActiveTierChange={setActiveStop}
      hint={hint}
      dataHelpRegion="scene-time:duration"
    >
      {/* Reserve enough vertical space for the tallest stop widget
          (the All-Day toggle pair: header + 64px buttons + 2-line
          description) so rotating between stops doesn't cause the
          surrounding modal layout to jump. */}
      <div style={{ minHeight: 130 }} className="w-full">
        {safeActive === 'ambiguous'  && <AmbiguousWidget />}
        {safeActive === 'numeric'    && (
          <NumericWidget
            value={drafts.numeric?.value ?? null}
            unit={drafts.numeric?.unit ?? 'hours'}
            onChange={(next) => setDraft('numeric', next)}
          />
        )}
        {safeActive === 'all_period' && (
          <AllPeriodWidget startBucket={startBucket} />
        )}
        {safeActive === 'span'       && (
          <SpanWidget
            startTimeOfDayLabel={startTimeOfDayLabel}
            endLabel={drafts.span?.endPeriod ?? null}
            onChange={(end) => setDraft('span', { endPeriod: end })}
          />
        )}
        {safeActive === 'all_day'    && (
          <AllDayWidget
            startBucket={startBucket}
            variant={drafts.all_day?.variant ?? null}
            onChange={(v) => setDraft('all_day', { variant: v })}
          />
        )}
      </div>
    </GranularityCarousel>
  )
}
