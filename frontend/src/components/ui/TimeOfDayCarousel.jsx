/**
 * Phase 1.23 — Time of Day carousel.
 *
 * Three tiers wrapped around the shared `<GranularityCarousel>` primitive:
 *
 *   Tier 1 — Broad     (Day / Night, 2 buttons)
 *   Tier 2 — Labelled  (12 labels in a 4-column gearshift grid, default
 *                       starting tier when nothing is pinned)
 *   Tier 3 — Exact     (HH:MM picker; renders per the per-story 12h/24h
 *                       setting; internal storage is always 24h)
 *
 * Per the planning doc (§2.2):
 *   - Within the modal session, each tier holds its own independent draft.
 *   - On Save, only the currently-active tier's draft persists.
 *   - On reload, only the saved tier-and-value populates.
 *   - Cross-tier collapse (Tier 3 → Tier 2 → Tier 1) is offered as a
 *     pre-fill when rotating to a tier whose draft is empty AND coming
 *     FROM a more-precise tier. Coarse → fine produces no pre-fill.
 *   - If the target tier already has a draft, rotation restores it;
 *     pre-fill never overwrites an existing draft.
 *
 * API (controlled component): the parent owns state; this component
 * renders the carousel with the active tier's widget and proposes
 * mutations via `onChange(nextState)`.
 *
 *   state = {
 *     activeTier: 'broad' | 'labelled' | 'exact' | null,
 *     drafts: {
 *       broad: 'day' | 'night' | null,
 *       labelled: <one of the 12 labels> | null,
 *       exact: 'HH:MM' (24h) | null,
 *     },
 *   }
 *
 *   timeFormat: '12h' | '24h' (controls Tier 3 display only)
 */
import { useCallback, useRef, useState } from 'react'
import GranularityCarousel from './GranularityCarousel'

// ── 15 labels in time order (cycle starts at Pre-Dawn ~3am → ends at Midnight) ──
//
// Column structure uses five day-period anchors (Dawn / Morning /
// Afternoon / Evening / Night) reading left-to-right in time order.
// Each column has a centre and two branches; specific moment-labels
// replace generic Early/Late prefixes where everyday vocabulary
// already gives the moment its own name:
//   - Dawn column: Pre-Dawn (early) / Dawn (centre) / Sunrise (late)
//   - Afternoon column: Noon (early) / Afternoon / Late Afternoon
//   - Night column: Early Night / Night / Midnight (late)
//
// **Midnight ↔ Noon symmetry**: Midnight (12 AM) and Noon (12 PM) are
// the day's two clock-hour anchors. Midnight sits at the very END of
// the gearshift cycle (bottom-right cell) — it's both the close of one
// day and the open of the next, the natural way most people think of
// "midnight" as the transition between days.
export const TIME_OF_DAY_LABELS = [
  'Pre-Dawn',
  'Dawn',
  'Sunrise',
  'Early Morning',
  'Morning',
  'Late Morning',
  'Noon',
  'Afternoon',
  'Late Afternoon',
  'Sunset',
  'Evening',
  'Dusk',
  'Early Night',
  'Night',
  'Midnight',
]

// Input synonyms: common terms a user / MCP client reaches for that map onto a
// canonical label. "Late Night" is the natural phrase for the Midnight tier
// (MCP clients in sessions 006 / 010 / 012 kept reaching for it); it resolves
// to the canonical 'Midnight' value, which is what gets STORED — no save-format
// change. Keyed lowercase for case-insensitive matching.
export const TIME_OF_DAY_LABEL_SYNONYMS = {
  'late night': 'Midnight',
  // The compound display label itself is accepted verbatim, so a client that
  // echoes back the label shown in the picker / help / error also resolves.
  'late night / midnight': 'Midnight',
}

// Display labels: a tier can show a compound user-facing label that names a
// common synonym alongside the canonical name. The STORED value is always the
// canonical label (TIME_OF_DAY_LABELS); this only affects DISPLAY text.
const TIME_OF_DAY_DISPLAY_LABELS = {
  Midnight: 'Late Night / Midnight',
}

/** User-facing display text for a canonical time-of-day label. Returns the
 *  compound "Late Night / Midnight" for Midnight, else the label unchanged. */
export function displayTimeOfDayLabel(label) {
  return TIME_OF_DAY_DISPLAY_LABELS[label] || label
}

// 5-column gearshift layout. Each column has [top early, centre plain,
// bottom late]. Specific moment-labels (Pre-Dawn / Sunrise / Noon /
// Midnight) replace generic prefixes where everyday vocabulary already
// gives the moment a name. Night stays on the right; Midnight is the
// day-cycle's endpoint at the bottom-right cell.
const GEARSHIFT_COLUMNS = [
  { top: 'Pre-Dawn',      centre: 'Dawn',      bottom: 'Sunrise'        },
  { top: 'Early Morning', centre: 'Morning',   bottom: 'Late Morning'   },
  { top: 'Noon',          centre: 'Afternoon', bottom: 'Late Afternoon' },
  { top: 'Sunset', centre: 'Evening',   bottom: 'Dusk'   },
  { top: 'Early Night',   centre: 'Night',     bottom: 'Midnight'       },
]

// Tier 3 → Tier 2 collapse (per planning doc §2.3 mapping table).
// Returns one of the 15 Tier-2 labels or null if input is invalid.
export function collapseExactToLabelled(hhmm) {
  if (typeof hhmm !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  const total = h * 60 + min   // minutes since midnight (0..1439)
  // Boundaries (inclusive lower, inclusive upper) covering 24h cleanly.
  // Cycle order: Pre-Dawn → Dawn → Sunrise → Early Morning → Morning →
  // Late Morning → Noon → Afternoon → Late Afternoon → Sunset →
  // Evening → Dusk → Early Night → Night → Midnight → loop.
  if (total >= 3*60     && total <= 4*60+59)   return 'Pre-Dawn'
  if (total >= 5*60     && total <= 5*60+29)   return 'Dawn'
  if (total >= 5*60+30  && total <= 5*60+59)   return 'Sunrise'
  if (total >= 6*60     && total <= 7*60+59)   return 'Early Morning'
  if (total >= 8*60     && total <= 9*60+59)   return 'Morning'
  if (total >= 10*60    && total <= 11*60+29)  return 'Late Morning'
  if (total >= 11*60+30 && total <= 12*60+30)  return 'Noon'
  if (total >= 12*60+31 && total <= 14*60+59)  return 'Afternoon'
  if (total >= 15*60    && total <= 16*60+29)  return 'Late Afternoon'
  if (total >= 16*60+30 && total <= 18*60+59)  return 'Sunset'
  if (total >= 19*60    && total <= 20*60+59)  return 'Evening'
  if (total >= 21*60    && total <= 21*60+59)  return 'Dusk'
  if (total >= 22*60    && total <= 22*60+59)  return 'Early Night'
  if (total >= 23*60    && total <= 23*60+59)  return 'Night'
  // 00:00 – 02:59 → Midnight (the post-midnight tail of the day cycle).
  return 'Midnight'
}

// Tier 2 → Tier 1 collapse. Pre-Dawn collapses to 'night' (still dark);
// Dawn and Sunrise are 'day' (sky lightening into day). Everything in
// the Morning / Afternoon columns collapses to 'day'; Evening and Night
// columns to 'night' (Midnight included — it's part of the night
// column's late branch).
export function collapseLabelledToBroad(label) {
  if (!label) return null
  if (label === 'Pre-Dawn'                                                          ) return 'night'
  if (label === 'Dawn'          || label === 'Sunrise'                              ) return 'day'
  if (label === 'Early Morning' || label === 'Morning'  || label === 'Late Morning' ) return 'day'
  if (label === 'Noon'          || label === 'Afternoon' || label === 'Late Afternoon') return 'day'
  if (label === 'Dusk' || label === 'Evening'  || label === 'Sunset' ) return 'night'
  if (label === 'Early Night'   || label === 'Night'    || label === 'Midnight'     ) return 'night'
  return null
}

// Tier 3 → Tier 1 collapse, via Tier 2.
function collapseExactToBroad(hhmm) {
  const labelled = collapseExactToLabelled(hhmm)
  return collapseLabelledToBroad(labelled)
}

// Format a 24h "HH:MM" string for display per the format setting.
export function formatExact(hhmm, timeFormat = '12h') {
  if (typeof hhmm !== 'string') return ''
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  const h = Number(m[1])
  const min = Number(m[2])
  const minStr = String(min).padStart(2, '0')
  if (timeFormat === '24h') {
    return `${String(h).padStart(2, '0')}:${minStr}`
  }
  // 12h
  let h12 = h % 12
  if (h12 === 0) h12 = 12
  const ampm = h < 12 ? 'AM' : 'PM'
  return `${h12}:${minStr} ${ampm}`
}

// ── Tier widgets ──────────────────────────────────────────────────────

// Broad-tier (Day / Night) two-button picker. Styled to match the
// SeasonRow pattern: fixed-size square buttons (64×64), 32 px glyph
// stacked above a small label, accent colour fills the button when
// active, with the icon + text rendered in the dark UI bg colour
// (zinc-900) so they read as cut-outs against the active fill.
function BroadPicker({ value, onChange }) {
  // Reuse the existing Time of Day base icons: a full Segoe sun for
  // Day, the Segoe crescent moon for Night. Tinted in the cell's
  // accent colour at rest, dark bg-colour when active.
  const OPTIONS = [
    { id: 'day',   label: 'Day',   accent: '#f59e0b', Icon: BaseNoon },
    { id: 'night', label: 'Night', accent: '#4338ca', Icon: BaseMoonStar },
  ]
  return (
    <div className="flex items-center justify-center gap-2">
      {OPTIONS.map((opt) => {
        const { id, label, accent } = opt
        // Icon is rendered as a JSX element below; bind it as a local so it
        // is recognised as used (the lint config does not count JSX
        // element-tag usage of destructured parameters).
        const Icon = opt.Icon
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(active ? null : id)}
            className={`flex flex-col items-center justify-center gap-1 w-16 h-16 rounded-md transition-colors select-none ${
              active
                ? ''
                : 'text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
            style={{
              backgroundColor: active ? accent : 'transparent',
              border: `1px solid ${active ? accent : '#3f3f46'}`,
              color: active ? '#fafafa' : undefined,
            }}
            title={active ? 'Click again to clear' : `Set to ${displayTimeOfDayLabel(label)}`}
          >
            <svg width={32} height={32} viewBox="0 0 32 32">
              <Icon size={32} colour={active ? '#fafafa' : accent} />
            </svg>
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Tier 2 gearshift dimensions — used by both the visual track and the
// click / drag math. Branch length (vertical span between top and bottom
// rows) is intentionally short — early/late are gentle nudges off the
// centre row, not full-height excursions.
const GS = {
  width: 440,
  height: 160,
  rowYTop: 50,
  rowYMid: 90,
  // Bot row sits 48 px below mid (vs. 40 px for top → mid), giving
  // bot-row icons ~20% extra clearance from the centre-row labels
  // that sit just below the mid icons. Especially helps the tilted-
  // branch variant where bot tips swing closer to centre.
  rowYBot: 138,
  // Column centre x for the 5 day-period anchors (Dawn / Morning /
  // Afternoon / Evening / Night), 80 px apart, with 60 px margin on
  // each side. Vertical branch range is 40 px above and 48 px below
  // (mid→bot) so cell labels can sit fully outside the active
  // selector ring without overlapping each other or the ring.
  colsX: [60, 140, 220, 300, 380],
  handleR: 9,
  iconSize: 14,
}

// Per-cell visual: colour swatch + icon type. Colours form a gradient
// through the day cycle (cool dawn → warm midday → warm dusk → cool
// nighttime). Icon types: 'sunrise' = half-disc above a horizon line,
// 'sun' = filled circle, 'sun-rays' = filled circle with rays, 'sunset'
// = same as sunrise (the colour communicates direction), 'moon-rising'
// = crescent low, 'moon' = full disc, 'moon-crescent' = crescent.
// Following the conventional UI iconography pattern (Lucide / Phosphor /
// Heroicons all use this canonical 4-icon set for time of day): one base
// icon per column, with an early/late modifier overlay differentiating
// the cells WITHIN a column.
//
//   base = 'sunrise'   → Morning column   (sun rising over horizon)
//   base = 'noon'      → Noon column      (sun centred + rays)
//   base = 'sunset'    → Evening column   (sun setting over horizon, downward rays)
//   base = 'moon-star' → Night column     (crescent moon + star)
//
//   modifier = 'early'  → small ▲ chevron upper-left of icon
//   modifier = 'plain'  → no modifier (column centre)
//   modifier = 'late'   → small ▼ chevron lower-right of icon
//
// Slider position in the gearshift already tells the writer which branch
// they're on (top = early, bottom = late); the modifier glyph is for
// out-of-context displays (icons catalogue, scene-card summary).
export const CELL_VISUALS = {
  // Dawn column — pre-sunrise period. Distinct base icon (`dawn`) shows
  // a horizon line with rising rays but no visible sun (sun is still
  // below horizon). Colour gradient flows deep-indigo → dusky purple →
  // warm sunrise orange, then bridges through peach into morning yellow.
  'Pre-Dawn':        { colour: '#4f2bad', base: 'dawn',      modifier: 'early' },
  'Dawn':            { colour: '#7c3aed', base: 'dawn',      modifier: 'plain' },
  'Sunrise':         { colour: '#fb923c', base: 'dawn',      modifier: 'late'  },
  'Early Morning':   { colour: '#fdba74', base: 'sunrise',   modifier: 'early' },
  'Morning':         { colour: '#fde047', base: 'sunrise',   modifier: 'plain' },
  'Late Morning':    { colour: '#fbbf24', base: 'sunrise',   modifier: 'late'  },
  // Afternoon column. Noon is the column's "early" branch — the
  // transitional moment that opens the afternoon period.
  'Noon':            { colour: '#facc15', base: 'noon',      modifier: 'early' },
  'Afternoon':       { colour: '#f59e0b', base: 'noon',      modifier: 'plain' },
  'Late Afternoon':  { colour: '#d97706', base: 'noon',      modifier: 'late'  },
  'Sunset':          { colour: '#ea580c', base: 'sunset',    modifier: 'early' },
  'Evening':         { colour: '#db2777', base: 'sunset',    modifier: 'plain' },
  'Dusk':            { colour: '#a855f7', base: 'sunset',    modifier: 'late'  },
  // Night column. Midnight is the column's "late" branch — the day-
  // cycle's transition into the next day, sitting at the bottom-right
  // cell as the natural endpoint of the gearshift.
  'Early Night':     { colour: '#6366f1', base: 'moon-star', modifier: 'early' },
  'Night':           { colour: '#2563eb', base: 'moon-star', modifier: 'plain' },
  'Midnight':        { colour: '#4338ca', base: 'moon-star', modifier: 'late'  },
}

// ── Base icon renderers ───────────────────────────────────────────────
// Each base is an SVG <g> drawn into a viewBox of `size` × `size`.
// Stylistically modeled after Lucide's time-of-day icon set: filled
// shapes for the disc/moon, optional thin lines for horizon and rays.

// Shared Segoe sun renderer — used directly by BaseNoon (full sun) and
// re-used (via clip-path) by BaseDawn (sun below horizon, only top
// rays peek up) and BaseSunrise (sun cresting horizon, top half + top
// rays visible). Centred at (cx, cy) with the given radius `r`; the
// underlying viewBox is positioned so the Segoe sun's intrinsic
// (centre-x, centre-y) ≈ (512, 745) lands on (cx, cy).
function SegoeSun({ cx, cy, r, colour }) {
  // Segoe sun viewBox is "116 348 793 793" (793×793) with the disc
  // centred near (512, 745). To place the sun's centre at our (cx,cy)
  // and scale to radius r (i.e. half-width = r), we use a nested SVG
  // sized 2r × 2r whose viewBox is shifted/scaled so the Segoe centre
  // (512, 745) maps to our centre (cx, cy).
  const segoeCx = 512
  const segoeCy = 745
  const segoeHalfW = 793 / 2          // half the Segoe canvas width = radius equivalent
  return (
    <svg
      x={cx - r}
      y={cy - r}
      width={r * 2}
      height={r * 2}
      viewBox={`${segoeCx - segoeHalfW} ${segoeCy - segoeHalfW} ${segoeHalfW * 2} ${segoeHalfW * 2}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d="M719,745C719,773.667 713.5,800.5 702.5,825.5C691.5,850.5 676.667,872.333 658,891C639.333,909.667 617.333,924.417 592,935.25C566.667,946.083 539.833,951.5 511.5,951.5C482.833,951.5 455.917,946.083 430.75,935.25C405.583,924.417 383.667,909.667 365,891C346.333,872.333 331.583,850.5 320.75,825.5C309.917,800.5 304.5,773.667 304.5,745C304.5,716.333 309.917,689.417 320.75,664.25C331.583,639.083 346.333,617.083 365,598.25C383.667,579.417 405.583,564.583 430.75,553.75C455.917,542.917 482.833,537.5 511.5,537.5C539.833,537.5 566.667,542.917 592,553.75C617.333,564.583 639.333,579.417 658,598.25C676.667,617.083 691.5,639.083 702.5,664.25C713.5,689.417 719,716.333 719,745ZM266,702.5C265,709.167 264.083,716.083 263.25,723.25C262.417,730.417 262,737.667 262,745C262,751.667 262.417,758.583 263.25,765.75C264.083,772.917 265,779.833 266,786.5L158,786.5C152,786.5 146.417,785.417 141.25,783.25C136.083,781.083 131.583,778.083 127.75,774.25C123.917,770.417 120.917,766 118.75,761C116.583,756 115.5,750.667 115.5,745C115.5,733.333 119.667,723.333 128,715C136.333,706.667 146.333,702.5 158,702.5ZM368,541C344.333,557.667 324.5,577.667 308.5,601L231.5,525C222.833,516.333 218.5,506.333 218.5,495C218.5,483.667 222.833,473.333 231.5,464C235.5,460 240.083,457.083 245.25,455.25C250.417,453.417 255.833,452.5 261.5,452.5C266.833,452.5 272.083,453.417 277.25,455.25C282.417,457.083 287,460.333 291,465ZM655.5,948C666.833,939.667 677.583,930.5 687.75,920.5C697.917,910.5 707,899.667 715,888L791.5,965C795.5,969 798.583,973.75 800.75,979.25C802.917,984.75 804,990.333 804,996C804,1006.33 800,1016 792,1025C782.667,1033.33 772.5,1037.5 761.5,1037.5C749.833,1037.5 739.833,1033.33 731.5,1025ZM865.5,702.5C877.167,702.5 887.167,706.667 895.5,715C903.833,723.333 908,733.333 908,745C908,750.667 906.917,756 904.75,761C902.583,766 899.583,770.417 895.75,774.25C891.917,778.083 887.417,781.083 882.25,783.25C877.083,785.417 871.5,786.5 865.5,786.5L757,786.5C758.333,779.833 759.25,772.917 759.75,765.75C760.25,758.583 760.5,751.667 760.5,745C760.5,737.667 760.25,730.417 759.75,723.25C759.25,716.083 758.333,709.167 757,702.5ZM554,499.5C547.333,497.833 540.417,496.833 533.25,496.5C526.083,496.167 518.833,496 511.5,496C504.5,496 497.417,496.167 490.25,496.5C483.083,496.833 476.167,497.833 469.5,499.5L469.5,390.5C469.5,378.833 473.583,368.833 481.75,360.5C489.917,352.167 499.833,348 511.5,348C523.167,348 533.167,352.167 541.5,360.5C549.833,368.833 554,378.833 554,390.5ZM469.5,989.5C476.167,991.167 483.083,992.167 490.25,992.5C497.417,992.833 504.5,993 511.5,993C518.833,993 526.083,992.833 533.25,992.5C540.417,992.167 547.333,991.167 554,989.5L554,1098.5C554,1110.17 549.833,1120.17 541.5,1128.5C533.167,1136.83 523.167,1141 511.5,1141C499.833,1141 489.917,1136.83 481.75,1128.5C473.583,1120.17 469.5,1110.17 469.5,1098.5ZM715,601C707,589.333 697.917,578.5 687.75,568.5C677.583,558.5 666.833,549.333 655.5,541L732.5,465C736.833,460.667 741.667,457.5 747,455.5C752.333,453.5 757.667,452.5 763,452.5C768,452.5 773.083,453.417 778.25,455.25C783.417,457.083 788,460 792,464C800,472.667 804,482.667 804,494C804,505 799.833,515 791.5,524ZM308.5,888C324.5,911.333 344.333,931.333 368,948L291,1025C282.667,1033.33 272.833,1037.5 261.5,1037.5C249.833,1037.5 239.833,1033.33 231.5,1025C222.833,1016.33 218.5,1006.33 218.5,995C218.5,989.333 219.583,983.917 221.75,978.75C223.917,973.583 227.167,969 231.5,965Z"
        fill={colour}
        fillRule="evenodd"
      />
    </svg>
  )
}

function BaseDawn({ size, colour }) {
  // Sun is BELOW the horizon (pre-sunrise). Only the three top rays
  // are visible — vertical, top-left at +45°, top-right at -45° —
  // all 84.5-unit wide with rounded Segoe tips. Bottoms of the rays
  // meet a horizon pill at y=702.5 so everything seals cleanly.
  // Sourced from `.References/dawn.svg`.
  return (
    <svg
      x={0}
      y={0}
      width={size}
      height={size}
      viewBox="116 348 793 793"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d="M469.5,702.5L469.5,390.5C469.5,378.833 473.583,368.833 481.75,360.5C489.917,352.167 499.833,348 511.5,348C523.167,348 533.167,352.167 541.5,360.5C549.833,368.833 554,378.833 554,390.5L554,702.5ZM409,702.5L231.5,525C222.833,516.333 218.5,506.333 218.5,495C218.5,483.667 222.833,473.333 231.5,464C235.5,460 240.083,457.083 245.25,455.25C250.417,453.417 255.833,452.5 261.5,452.5C266.833,452.5 272.083,453.417 277.25,455.25C282.417,457.083 287,460.333 291,465L528.5,702.5ZM613,702.5L791.5,524C799.833,515 804,505 804,494C804,482.667 800,472.667 792,464C788,460 783.417,457.083 778.25,455.25C773.083,453.417 768,452.5 763,452.5C757.667,452.5 752.333,453.5 747,455.5C741.667,457.5 736.833,460.667 732.5,465L495,702.5ZM157,702.5H865C876.667,702.5 886.667,706.667 895,715C903.333,723.333 907.5,733.333 907.5,745C907.5,750.667 906.417,756 904.25,761C902.083,766 899.083,770.417 895.25,774.25C891.417,778.083 886.917,781.083 881.75,783.25C876.583,785.417 871,786.5 865,786.5H157C151,786.5 145.417,785.417 140.25,783.25C135.083,781.083 130.583,778.083 126.75,774.25C122.917,770.417 119.917,766 117.75,761C115.583,756 114.5,750.667 114.5,745C114.5,733.333 118.667,723.333 127,715C135.333,706.667 145.333,702.5 157,702.5Z"
        fill={colour}
      />
    </svg>
  )
}

function BaseSunrise({ size, colour }) {
  // Full Segoe sun above a horizon. The three BOTTOM rays
  // (bottom-vertical, bottom-left diagonal, bottom-right diagonal)
  // are intentionally omitted so nothing pokes below the horizon
  // bar. The horizon pill covers a small lower slice of the disc,
  // giving a "rising" feel. Sourced from `.References/morning.svg`.
  return (
    <svg
      x={0}
      y={0}
      width={size}
      height={size}
      viewBox="116 348 793 793"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d="M719,745C719,773.667 713.5,800.5 702.5,825.5C691.5,850.5 676.667,872.333 658,891C639.333,909.667 617.333,924.417 592,935.25C566.667,946.083 539.833,951.5 511.5,951.5C482.833,951.5 455.917,946.083 430.75,935.25C405.583,924.417 383.667,909.667 365,891C346.333,872.333 331.583,850.5 320.75,825.5C309.917,800.5 304.5,773.667 304.5,745C304.5,716.333 309.917,689.417 320.75,664.25C331.583,639.083 346.333,617.083 365,598.25C383.667,579.417 405.583,564.583 430.75,553.75C455.917,542.917 482.833,537.5 511.5,537.5C539.833,537.5 566.667,542.917 592,553.75C617.333,564.583 639.333,579.417 658,598.25C676.667,617.083 691.5,639.083 702.5,664.25C713.5,689.417 719,716.333 719,745ZM266,702.5C265,709.167 264.083,716.083 263.25,723.25C262.417,730.417 262,737.667 262,745C262,751.667 262.417,758.583 263.25,765.75C264.083,772.917 265,779.833 266,786.5L158,786.5C152,786.5 146.417,785.417 141.25,783.25C136.083,781.083 131.583,778.083 127.75,774.25C123.917,770.417 120.917,766 118.75,761C116.583,756 115.5,750.667 115.5,745C115.5,733.333 119.667,723.333 128,715C136.333,706.667 146.333,702.5 158,702.5ZM368,541C344.333,557.667 324.5,577.667 308.5,601L231.5,525C222.833,516.333 218.5,506.333 218.5,495C218.5,483.667 222.833,473.333 231.5,464C235.5,460 240.083,457.083 245.25,455.25C250.417,453.417 255.833,452.5 261.5,452.5C266.833,452.5 272.083,453.417 277.25,455.25C282.417,457.083 287,460.333 291,465ZM865.5,702.5C877.167,702.5 887.167,706.667 895.5,715C903.833,723.333 908,733.333 908,745C908,750.667 906.917,756 904.75,761C902.583,766 899.583,770.417 895.75,774.25C891.917,778.083 887.417,781.083 882.25,783.25C877.083,785.417 871.5,786.5 865.5,786.5L757,786.5C758.333,779.833 759.25,772.917 759.75,765.75C760.25,758.583 760.5,751.667 760.5,745C760.5,737.667 760.25,730.417 759.75,723.25C759.25,716.083 758.333,709.167 757,702.5ZM554,499.5C547.333,497.833 540.417,496.833 533.25,496.5C526.083,496.167 518.833,496 511.5,496C504.5,496 497.417,496.167 490.25,496.5C483.083,496.833 476.167,497.833 469.5,499.5L469.5,390.5C469.5,378.833 473.583,368.833 481.75,360.5C489.917,352.167 499.833,348 511.5,348C523.167,348 533.167,352.167 541.5,360.5C549.833,368.833 554,378.833 554,390.5ZM715,601C707,589.333 697.917,578.5 687.75,568.5C677.583,558.5 666.833,549.333 655.5,541L732.5,465C736.833,460.667 741.667,457.5 747,455.5C752.333,453.5 757.667,452.5 763,452.5C768,452.5 773.083,453.417 778.25,455.25C783.417,457.083 788,460 792,464C800,472.667 804,482.667 804,494C804,505 799.833,515 791.5,524Z"
        fill={colour}
        fillRule="evenodd"
      />
      <path
        d="M158.5,876.377C146.833,876.377 136.833,880.544 128.5,888.877C120.167,897.21 116,907.21 116,918.877C116,924.544 117.083,929.877 119.25,934.877C121.417,939.877 124.417,944.294 128.25,948.127C132.083,951.96 136.583,954.96 141.75,957.127C146.917,959.294 152.5,960.377 158.5,960.377H866.5C878.167,960.377 888.167,956.21 896.5,947.877C904.833,939.544 909,929.544 909,917.877C909,912.21 907.917,906.877 905.75,901.877C903.583,896.877 900.583,892.46 896.75,888.627C892.917,884.794 888.417,881.794 883.25,879.627C878.083,877.46 872.5,876.377 866.5,876.377Z"
        fill={colour}
      />
    </svg>
  )
}

function BaseNoon({ size, colour }) {
  // Sun with rays — exact path from `.References/Segoe UI Symbol
  // Regular - Black Sun With Rays.svg`, the text-style ☀ (U+2600)
  // glyph as monochrome SVG. Embedded as a nested SVG so the original
  // viewBox handles scaling without manual transform math;
  // preserveAspectRatio centres the glyph in the icon box.
  return (
    <svg
      x={0}
      y={0}
      width={size}
      height={size}
      viewBox="116 348 793 793"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d="M719,745C719,773.667 713.5,800.5 702.5,825.5C691.5,850.5 676.667,872.333 658,891C639.333,909.667 617.333,924.417 592,935.25C566.667,946.083 539.833,951.5 511.5,951.5C482.833,951.5 455.917,946.083 430.75,935.25C405.583,924.417 383.667,909.667 365,891C346.333,872.333 331.583,850.5 320.75,825.5C309.917,800.5 304.5,773.667 304.5,745C304.5,716.333 309.917,689.417 320.75,664.25C331.583,639.083 346.333,617.083 365,598.25C383.667,579.417 405.583,564.583 430.75,553.75C455.917,542.917 482.833,537.5 511.5,537.5C539.833,537.5 566.667,542.917 592,553.75C617.333,564.583 639.333,579.417 658,598.25C676.667,617.083 691.5,639.083 702.5,664.25C713.5,689.417 719,716.333 719,745ZM266,702.5C265,709.167 264.083,716.083 263.25,723.25C262.417,730.417 262,737.667 262,745C262,751.667 262.417,758.583 263.25,765.75C264.083,772.917 265,779.833 266,786.5L158,786.5C152,786.5 146.417,785.417 141.25,783.25C136.083,781.083 131.583,778.083 127.75,774.25C123.917,770.417 120.917,766 118.75,761C116.583,756 115.5,750.667 115.5,745C115.5,733.333 119.667,723.333 128,715C136.333,706.667 146.333,702.5 158,702.5ZM368,541C344.333,557.667 324.5,577.667 308.5,601L231.5,525C222.833,516.333 218.5,506.333 218.5,495C218.5,483.667 222.833,473.333 231.5,464C235.5,460 240.083,457.083 245.25,455.25C250.417,453.417 255.833,452.5 261.5,452.5C266.833,452.5 272.083,453.417 277.25,455.25C282.417,457.083 287,460.333 291,465ZM655.5,948C666.833,939.667 677.583,930.5 687.75,920.5C697.917,910.5 707,899.667 715,888L791.5,965C795.5,969 798.583,973.75 800.75,979.25C802.917,984.75 804,990.333 804,996C804,1006.33 800,1016 792,1025C782.667,1033.33 772.5,1037.5 761.5,1037.5C749.833,1037.5 739.833,1033.33 731.5,1025ZM865.5,702.5C877.167,702.5 887.167,706.667 895.5,715C903.833,723.333 908,733.333 908,745C908,750.667 906.917,756 904.75,761C902.583,766 899.583,770.417 895.75,774.25C891.917,778.083 887.417,781.083 882.25,783.25C877.083,785.417 871.5,786.5 865.5,786.5L757,786.5C758.333,779.833 759.25,772.917 759.75,765.75C760.25,758.583 760.5,751.667 760.5,745C760.5,737.667 760.25,730.417 759.75,723.25C759.25,716.083 758.333,709.167 757,702.5ZM554,499.5C547.333,497.833 540.417,496.833 533.25,496.5C526.083,496.167 518.833,496 511.5,496C504.5,496 497.417,496.167 490.25,496.5C483.083,496.833 476.167,497.833 469.5,499.5L469.5,390.5C469.5,378.833 473.583,368.833 481.75,360.5C489.917,352.167 499.833,348 511.5,348C523.167,348 533.167,352.167 541.5,360.5C549.833,368.833 554,378.833 554,390.5ZM469.5,989.5C476.167,991.167 483.083,992.167 490.25,992.5C497.417,992.833 504.5,993 511.5,993C518.833,993 526.083,992.833 533.25,992.5C540.417,992.167 547.333,991.167 554,989.5L554,1098.5C554,1110.17 549.833,1120.17 541.5,1128.5C533.167,1136.83 523.167,1141 511.5,1141C499.833,1141 489.917,1136.83 481.75,1128.5C473.583,1120.17 469.5,1110.17 469.5,1098.5ZM715,601C707,589.333 697.917,578.5 687.75,568.5C677.583,558.5 666.833,549.333 655.5,541L732.5,465C736.833,460.667 741.667,457.5 747,455.5C752.333,453.5 757.667,452.5 763,452.5C768,452.5 773.083,453.417 778.25,455.25C783.417,457.083 788,460 792,464C800,472.667 804,482.667 804,494C804,505 799.833,515 791.5,524ZM308.5,888C324.5,911.333 344.333,931.333 368,948L291,1025C282.667,1033.33 272.833,1037.5 261.5,1037.5C249.833,1037.5 239.833,1033.33 231.5,1025C222.833,1016.33 218.5,1006.33 218.5,995C218.5,989.333 219.583,983.917 221.75,978.75C223.917,973.583 227.167,969 231.5,965Z"
        fill={colour}
        fillRule="evenodd"
      />
    </svg>
  )
}

function BaseSunset({ size, colour }) {
  // Half-disc sun resting on the horizon (top half visible above)
  // plus three small downward rays from the disc top, identical to
  // the previous icon's geometry. The thin horizon stroke has been
  // swapped for the same pill-shape horizon as BaseDawn / BaseSunrise.
  // Disc radius and ray positions match the prior s*0.28 / s*0.16
  // ratios, scaled into the standard 116..909 / 348..1141 viewBox.
  return (
    <svg
      x={0}
      y={0}
      width={size}
      height={size}
      viewBox="116 348 793 793"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Top half of disc (sweep=1 = top half in y-down SVG) */}
      <path
        d="M289.5,876.377A222,222 0 0 1 733.5,876.377Z"
        fill={colour}
      />
      {/* Three small downward rays from disc top */}
      <line x1="511.5" y1="754.277" x2="511.5" y2="831.977" stroke={colour} strokeWidth="60" strokeLinecap="round" />
      <line x1="384.62" y1="783.137" x2="337.04" y2="854.177" stroke={colour} strokeWidth="60" strokeLinecap="round" />
      <line x1="638.38" y1="783.137" x2="685.96" y2="854.177" stroke={colour} strokeWidth="60" strokeLinecap="round" />
      {/* Pill horizon (matches BaseDawn / BaseSunrise) */}
      <path
        d="M158.5,876.377C146.833,876.377 136.833,880.544 128.5,888.877C120.167,897.21 116,907.21 116,918.877C116,924.544 117.083,929.877 119.25,934.877C121.417,939.877 124.417,944.294 128.25,948.127C132.083,951.96 136.583,954.96 141.75,957.127C146.917,959.294 152.5,960.377 158.5,960.377H866.5C878.167,960.377 888.167,956.21 896.5,947.877C904.833,939.544 909,929.544 909,917.877C909,912.21 907.917,906.877 905.75,901.877C903.583,896.877 900.583,892.46 896.75,888.627C892.917,884.794 888.417,881.794 883.25,879.627C878.083,877.46 872.5,876.377 866.5,876.377Z"
        fill={colour}
      />
    </svg>
  )
}

function BaseMoonStar({ size, colour }) {
  // Crescent moon — exact path from `.References/Segoe UI Symbol
  // Regular - Crescent Moon.svg`, which is the text-style 🌙 glyph
  // rendered as monochrome SVG. No star, intrinsic Segoe orientation
  // (tips up-right, opening lower-right). Embedded as a nested SVG so
  // the original viewBox handles scaling without manual transform
  // math; preserveAspectRatio centres the glyph in the icon box.
  return (
    <svg
      x={0}
      y={0}
      width={size}
      height={size}
      viewBox="197 263 776 925"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d="M577.5,840.5C601.5,801.167 619.333,760.333 631,718C642.667,675.667 648.5,633.167 648.5,590.5C648.5,560.167 645.583,530.083 639.75,500.25C633.917,470.417 625.333,441.5 614,413.5C602.667,385.5 588.667,358.833 572,333.5C555.333,308.167 536,284.5 514,262.5C554.667,263.167 595.333,268.917 636,279.75C676.667,290.583 715.833,307.667 753.5,331C788.833,353 820.083,378.583 847.25,407.75C874.417,436.917 897.25,468.583 915.75,502.75C934.25,536.917 948.333,572.833 958,610.5C967.667,648.167 972.5,686.5 972.5,725.5C972.5,767.167 966.917,808.5 955.75,849.5C944.583,890.5 927.167,930.167 903.5,968.5C881.833,1003.83 856.417,1035.17 827.25,1062.5C798.083,1089.83 766.417,1112.75 732.25,1131.25C698.083,1149.75 662.167,1163.75 624.5,1173.25C586.833,1182.75 548.667,1187.5 510,1187.5C468.333,1187.5 426.917,1181.92 385.75,1170.75C344.583,1159.58 304.833,1142.17 266.5,1118.5C253.5,1110.5 241.25,1101.92 229.75,1092.75C218.25,1083.58 207.167,1074.17 196.5,1064.5C233.833,1062.83 270.667,1056.75 307,1046.25C343.333,1035.75 378,1021.08 411,1002.25C444,983.417 474.583,960.417 502.75,933.25C530.917,906.083 555.833,875.167 577.5,840.5Z"
        fill={colour}
      />
    </svg>
  )
}

// ── Modifier overlay ──────────────────────────────────────────────────
// `early` and `late` overlay a small chevron indicator on the icon
// corner. `plain` is no overlay.

function ModifierOverlay({ size, modifier, colour }) {
  if (modifier === 'plain' || !modifier) return null
  const s = size
  const tick = s * 0.18
  if (modifier === 'early') {
    // Upward chevron in the top-left corner.
    const cx = s * 0.18
    const cy = s * 0.16
    return (
      <g>
        <path
          d={`M ${cx - tick * 0.5} ${cy + tick * 0.4} L ${cx} ${cy - tick * 0.4} L ${cx + tick * 0.5} ${cy + tick * 0.4}`}
          fill="none"
          stroke={colour}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    )
  }
  if (modifier === 'late') {
    // Downward chevron in the bottom-right corner.
    const cx = s * 0.84
    const cy = s * 0.86
    return (
      <g>
        <path
          d={`M ${cx - tick * 0.5} ${cy - tick * 0.4} L ${cx} ${cy + tick * 0.4} L ${cx + tick * 0.5} ${cy - tick * 0.4}`}
          fill="none"
          stroke={colour}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    )
  }
  return null
}

// ── CellGlyph — composes a base icon + optional modifier overlay ─────
//
// Backwards-compat: callers can pass either:
//   { icon: <legacy single-string icon name> }    — falls back to the
//     pre-redesign single-icon set,
//   { base, modifier }                            — current API,
//   or both, in which case `base` + `modifier` win.
//
// All glyphs render in `colour` at full opacity. The `dim` prop is
// retained for callers that still pass it but no longer alters
// rendering — the carousel relies on the active selector ring and
// label colour for active-cell emphasis instead.

export function CellGlyph({ base, modifier, colour, size = GS.iconSize }) {
  let BaseIcon = null
  if (base === 'dawn')           BaseIcon = BaseDawn
  else if (base === 'sunrise')   BaseIcon = BaseSunrise
  else if (base === 'noon')      BaseIcon = BaseNoon
  else if (base === 'sunset')    BaseIcon = BaseSunset
  else if (base === 'moon-star') BaseIcon = BaseMoonStar

  if (!BaseIcon) {
    // Fallback small dot for any unknown base.
    return <circle cx={size / 2} cy={size / 2} r={3} fill={colour} />
  }

  return (
    <g>
      <BaseIcon size={size} colour={colour} />
      <ModifierOverlay size={size} modifier={modifier} colour={colour} />
    </g>
  )
}

// Map (col index 0..3, row 'top' | 'mid' | 'bot') → label.
function cellLabel(colIdx, row) {
  const col = GEARSHIFT_COLUMNS[colIdx]
  if (!col) return null
  if (row === 'top') return col.top
  if (row === 'bot') return col.bottom
  return col.centre
}

// Inverse: label → (col index, row).
function labelToCell(label) {
  for (let i = 0; i < GEARSHIFT_COLUMNS.length; i += 1) {
    const col = GEARSHIFT_COLUMNS[i]
    if (label === col.top) return { colIdx: i, row: 'top' }
    if (label === col.centre) return { colIdx: i, row: 'mid' }
    if (label === col.bottom) return { colIdx: i, row: 'bot' }
  }
  return null
}

// Curve: subtle parabolic "sun arc" that lifts the middle columns
// upward, peaking at the centre column (Afternoon, where Noon lives as
// the column's early branch and ends up the visible peak of the
// gearshift). Endpoints (Dawn left, Night right) sit at baseline y.
const ARC_PEAK_LIFT = 14  // px the peak column rises above baseline
function liftAtColumn(colIdx) {
  const colCount = GS.colsX.length
  const mid = (colCount - 1) / 2          // peak index (e.g. 2 for 5 cols)
  const halfWidth = mid                    // distance from edge to peak
  const distFromMid = Math.abs(colIdx - mid)
  const t = distFromMid / halfWidth        // 0 at peak, 1 at edges
  return ARC_PEAK_LIFT * (1 - t * t)       // parabolic falloff
}

function rowToY(colIdx, row) {
  const lift = liftAtColumn(colIdx)
  if (row === 'top') return GS.rowYTop - lift
  if (row === 'bot') return GS.rowYBot - lift
  return GS.rowYMid - lift
}

// ── Tilted-branch variant ────────────────────────────────────────────
//
// Optional 30° counter-clockwise tilt for ALL top-row branches and
// 30° clockwise tilt for ALL bot-row branches. The pivot is each
// column's mid-cell centre; only the tip position moves — icons
// and labels stay upright at the new (x, y) the tilted-branch tip
// ends up at.
const TILT_DEG = 30
const TILT_SIN = Math.sin((TILT_DEG * Math.PI) / 180)  // 0.5
const TILT_COS = Math.cos((TILT_DEG * Math.PI) / 180)  // 0.866

function cellPos(colIdx, row, tilted = false) {
  const xc = GS.colsX[colIdx]
  if (row === 'mid') return [xc, rowToY(colIdx, 'mid')]
  if (!tilted) return [xc, rowToY(colIdx, row)]
  const yMid = rowToY(colIdx, 'mid')
  const yRow = rowToY(colIdx, row)
  const L = Math.abs(yRow - yMid)
  if (row === 'top') return [xc - L * TILT_SIN, yMid - L * TILT_COS]
  return [xc + L * TILT_SIN, yMid + L * TILT_COS]
}

// Snap an arbitrary (x, y) within the gearshift to the nearest cell.
//
// Both tilted and non-tilted modes use the same row-stable algorithm:
//   1. Pick the nearest column by x against the un-tilted column
//      anchors (`GS.colsX`). Tilt only displaces top/bot TIP positions
//      visually — the column's vertical "spine" still lives at
//      `GS.colsX[c]`, so column-by-x snap is the natural mental model
//      ("which column am I in?") regardless of tilt.
//   2. Determine the row by y-threshold against that column's
//      tilt-aware row positions: cursor below (top+mid)/2 → top,
//      between (top+mid)/2 and (mid+bot)/2 → mid, otherwise bot.
//      This gives a thick mid-row band so dragging horizontally near
//      mid stays on mid even with small y jitter, instead of jumping
//      to a tilted top/bot icon that happens to be near the cursor.
function snapToCell(x, y, tilted = false) {
  let bestCol = 0
  let bestDx = Math.abs(x - GS.colsX[0])
  for (let i = 1; i < GS.colsX.length; i += 1) {
    const d = Math.abs(x - GS.colsX[i])
    if (d < bestDx) { bestDx = d; bestCol = i }
  }
  const colTopY = cellPos(bestCol, 'top', tilted)[1]
  const colMidY = cellPos(bestCol, 'mid', tilted)[1]
  const colBotY = cellPos(bestCol, 'bot', tilted)[1]
  const midTopMid = (colTopY + colMidY) / 2
  const midMidBot = (colMidY + colBotY) / 2
  const row = y < midTopMid ? 'top' : (y > midMidBot ? 'bot' : 'mid')
  return { colIdx: bestCol, row }
}

function LabelledPicker({ value, onChange, bgColour = '#18181b', tilted = false }) {
  const containerRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  function pickCell(colIdx, row) {
    const label = cellLabel(colIdx, row)
    if (!label) return
    onChange(value === label ? null : label)
  }

  function pickFromPointer(clientX, clientY, allowDeselect = false) {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // SVG is drawn with an internal coordinate system; the visible size
    // is `width=100%` so we map pointer-px → svg-px.
    const xRel = ((clientX - rect.left) / rect.width)  * GS.width
    const yRel = ((clientY - rect.top)  / rect.height) * GS.height
    const snapped = snapToCell(xRel, yRel, tilted)
    const label = cellLabel(snapped.colIdx, snapped.row)
    if (!label) return
    // Only the initial pointer-down (a click on the active cell)
    // can deselect. Drag-move events repeatedly hit the same cell
    // while the cursor is hovering it, so toggling-off there would
    // make drags oscillate the value.
    if (allowDeselect && label === value) onChange(null)
    else if (label !== value) onChange(label)
  }

  function onPointerDown(ev) {
    ev.preventDefault()
    setDragging(true)
    ev.currentTarget.setPointerCapture(ev.pointerId)
    pickFromPointer(ev.clientX, ev.clientY, /* allowDeselect */ true)
  }
  function onPointerMove(ev) {
    if (!dragging) return
    pickFromPointer(ev.clientX, ev.clientY)
  }
  function onPointerUp(ev) {
    if (dragging) {
      try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
    }
    setDragging(false)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none"
      style={{ aspectRatio: `${GS.width} / ${GS.height}`, maxWidth: GS.width, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <svg
        viewBox={`0 0 ${GS.width} ${GS.height}`}
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="none"
      >
        {(() => {
          // ── Central sun-arc track (back layer, always grey) ──────
          // Quadratic Bezier through the 5 mid points. Kept thin and
          // neutral; never gets the active-colour overlay so it just
          // reads as the structural baseline behind everything.
          const x0 = GS.colsX[0]
          const xMid = GS.colsX[Math.floor(GS.colsX.length / 2)]
          const xN = GS.colsX[GS.colsX.length - 1]
          const y0 = rowToY(0, 'mid')
          const yMidArc = rowToY(Math.floor(GS.colsX.length / 2), 'mid')
          const yN = rowToY(GS.colsX.length - 1, 'mid')
          const ctrlX = 2 * xMid - 0.5 * (x0 + xN)
          const ctrlY = 2 * yMidArc - 0.5 * (y0 + yN)
          const arcD = `M ${x0} ${y0} Q ${ctrlX} ${ctrlY} ${xN} ${yN}`

          // ── Zigzag time-flow path (front layer, gets active colour) ──
          // Traces all 15 cells in time order:
          //   Pre-Dawn → Dawn → Sunrise (col 0 top→mid→bot)
          //   Sunrise ↗ Early Morning (inter-column arc)
          //   Early Morning → Morning → Late Morning (col 1)
          //   Late Morning ↗ Noon
          //   ...etc through Midnight (col 4 bot)
          // Inter-column links use a quadratic Bezier with a small
          // upward bulge (peak above the chord midpoint) so each
          // transition reads as a gentle "hill" between columns.
          //
          // While building the path we also accumulate per-cell
          // cumulative path lengths so the active-colour fill can
          // stop EXACTLY at the active cell position rather than
          // approximating with even-cell-spacing.
          const ARC_BULGE = 10
          const lineLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])
          const quadLen = (P0, P1, P2, samples = 8) => {
            let total = 0
            let prev = P0
            for (let i = 1; i <= samples; i += 1) {
              const t = i / samples
              const u = 1 - t
              const x = u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0]
              const y = u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1]
              total += Math.hypot(x - prev[0], y - prev[1])
              prev = [x, y]
            }
            return total
          }
          const zigParts = []
          const cumLengths = [0] // cumLengths[i] = path length from start to cell-time-index i
          let cumLen = 0
          for (let c = 0; c < GS.colsX.length; c += 1) {
            const top = cellPos(c, 'top', tilted)
            const mid = cellPos(c, 'mid', tilted)
            const bot = cellPos(c, 'bot', tilted)
            if (c === 0) {
              zigParts.push(`M ${top[0]} ${top[1]}`)
              // cumLengths[0] = 0 already pushed
            } else {
              const prevBot = cellPos(c - 1, 'bot', tilted)
              const cpx = (prevBot[0] + top[0]) / 2
              const cpy = (prevBot[1] + top[1]) / 2 - ARC_BULGE
              zigParts.push(`Q ${cpx} ${cpy} ${top[0]} ${top[1]}`)
              cumLen += quadLen(prevBot, [cpx, cpy], top)
              cumLengths.push(cumLen) // top of this col
            }
            zigParts.push(`L ${mid[0]} ${mid[1]}`)
            cumLen += lineLen(top, mid)
            cumLengths.push(cumLen) // mid of this col
            zigParts.push(`L ${bot[0]} ${bot[1]}`)
            cumLen += lineLen(mid, bot)
            cumLengths.push(cumLen) // bot of this col
          }
          const zigD = zigParts.join(' ')
          const totalLen = cumLen

          // Active cell + colour for the zigzag fill overlay.
          const activeCell = value ? labelToCell(value) : null
          const activeVisual = value ? CELL_VISUALS[value] : null
          const activeColour = activeVisual?.colour
          const activeColIdx = activeCell ? activeCell.colIdx : 0
          const activeRow = activeCell ? activeCell.row : 'mid'
          // Fill ratio along the zigzag — uses ACTUAL cumulative
          // path length to the active cell, so the colour stops
          // precisely at the icon regardless of segment length
          // mismatches between within-column lines and inter-
          // column arcs.
          const cellTimeIdx = value ? TIME_OF_DAY_LABELS.indexOf(value) : -1
          const fillPct = cellTimeIdx > 0 && totalLen > 0
            ? (cumLengths[cellTimeIdx] / totalLen) * 100
            : 0

          return (
            <>
              {/* Central sun-arc baseline — thin, grey, no fill
                  overlay. Drawn first so the zigzag (and any inter-
                  column arcs that cross it) reads above it. */}
              <path
                d={arcD}
                fill="none"
                stroke="#52525b"
                strokeWidth={1}
                strokeLinecap="round"
              />
              {/* Zigzag time-flow base track */}
              <path
                d={zigD}
                fill="none"
                stroke="#52525b"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Zigzag colour fill — same path, active cell colour,
                  dasharray draws the first `fillPct` units (out of
                  pathLength=100) so the colour walks the zigzag
                  from Pre-Dawn forward as the slider moves. */}
              {activeColour && fillPct > 0 && (
                <path
                  d={zigD}
                  fill="none"
                  stroke={activeColour}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={100}
                  strokeDasharray={`${fillPct} ${100 - fillPct + 0.5}`}
                  style={{ transition: dragging ? 'none' : 'stroke 0.12s, stroke-dasharray 0.18s ease-out' }}
                />
              )}
              {/* Per-cell background discs hide the track passing through
                  each cell so the line reads as living in the gaps
                  between icons rather than behind them. Disc colour
                  matches the modal/panel background. */}
              {GEARSHIFT_COLUMNS.map((_, colIdx) =>
                ['top', 'mid', 'bot'].map((row) => {
                  const label = cellLabel(colIdx, row)
                  if (!label) return null
                  const [cx, cy] = cellPos(colIdx, row, tilted)
                  return (
                    <circle
                      key={`bg-${colIdx}-${row}`}
                      cx={cx}
                      cy={cy}
                      r={GS.iconSize / 2 + 3}
                      fill={bgColour}
                      style={{ pointerEvents: 'none' }}
                    />
                  )
                }),
              )}
              {/* Cell glyphs — always in their native cell colour, never
                  recoloured. The active cell's icon stays the same; the
                  ring (below) just outlines it. */}
              {GEARSHIFT_COLUMNS.map((_, colIdx) =>
                ['top', 'mid', 'bot'].map((row) => {
                  const label = cellLabel(colIdx, row)
                  const visual = CELL_VISUALS[label]
                  if (!visual) return null
                  const [cx, cy] = cellPos(colIdx, row, tilted)
                  const active = value === label
                  return (
                    <g
                      key={`glyph-${colIdx}-${row}`}
                      transform={`translate(${cx - GS.iconSize / 2} ${cy - GS.iconSize / 2})`}
                      style={{ pointerEvents: 'none' }}
                    >
                      <CellGlyph
                        base={visual.base}
                        modifier={visual.modifier}
                        colour={visual.colour}
                        size={GS.iconSize}
                        dim={!active}
                      />
                    </g>
                  )
                }),
              )}
              {/* Active selector ring — circles the active icon with a
                  2 px stroke in that cell's colour. Transparent middle
                  so the icon underneath stays in its native colour
                  (matches the IntensitySlider thumb pattern). */}
              {activeCell && activeColour && (() => {
                const [acx, acy] = cellPos(activeColIdx, activeRow, tilted)
                return (
                  <>
                    <circle
                      cx={acx}
                      cy={acy}
                      r={GS.iconSize / 2 + 3}
                      fill="none"
                      stroke={activeColour}
                      strokeWidth={2}
                      style={{
                        transition: dragging ? 'none' : 'cx 0.18s ease-out, cy 0.18s ease-out, stroke 0.12s',
                      }}
                    />
                  </>
                )
              })()}
            </>
          )
        })()}
      </svg>

      {/* Cell labels (clickable; rendered above the SVG) */}
      {GEARSHIFT_COLUMNS.map((col, colIdx) =>
        ['top', 'mid', 'bot'].map((row) => {
          const label = cellLabel(colIdx, row)
          const [px, py] = cellPos(colIdx, row, tilted)
          const cx = (px / GS.width) * 100
          const cy = (py / GS.height) * 100
          const active = value === label
          // Label position relative to the cell. Top-row labels sit
          // fully ABOVE the active selector ring (radius ~11 px from
          // cell centre); mid + bot labels sit fully BELOW the ring.
          // Values give ~3-4 px of clearance from the ring's outer edge
          // so the label never overlaps the ring or the icon underneath.
          const yOffset = row === 'top' ? -28 : 14
          // Inactive labels keep their compact size; active labels bump
          // up ~2 px so the selected cell's title reads slightly larger
          // than its neighbours.
          const baseSize = row === 'mid' ? 11 : 10
          const fontSize = active ? baseSize + 2 : baseSize
          // Active labels bold (700) and tinted in the cell's own
          // accent colour. Mid stays slightly heavier than the
          // edge rows when inactive, otherwise normal weight.
          const fontWeight = active ? 700 : (row === 'mid' ? 600 : 400)
          const activeColour = CELL_VISUALS[label]?.colour
          return (
            <button
              key={label}
              type="button"
              onClick={(e) => { e.stopPropagation(); pickCell(colIdx, row) }}
              className={`absolute -translate-x-1/2 transition-colors px-1 ${
                active
                  ? ''
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
              style={{
                left: `${cx}%`,
                top: `calc(${cy}% + ${yOffset}px)`,
                fontSize,
                fontWeight,
                color: active ? bgColour : undefined,
                background: 'transparent',
                pointerEvents: 'auto',
                whiteSpace: 'nowrap',
                // 1 px halo around the label. Inactive labels get the
                // bg-colour halo so they stay legible when they overlap
                // the sun-arc track or a tilted branch line behind
                // them. Active labels swap that halo for the inactive
                // text colour (zinc-400) so the bright accent-coloured
                // text reads with a thin neutral outline. Eight-
                // direction text-shadow simulates a uniform stroke
                // around each character without needing
                // -webkit-text-stroke.
                textShadow: (() => {
                  const haloColour = active ? activeColour : bgColour
                  return [
                    `1px 0 0 ${haloColour}`,
                    `-1px 0 0 ${haloColour}`,
                    `0 1px 0 ${haloColour}`,
                    `0 -1px 0 ${haloColour}`,
                    `1px 1px 0 ${haloColour}`,
                    `-1px -1px 0 ${haloColour}`,
                    `1px -1px 0 ${haloColour}`,
                    `-1px 1px 0 ${haloColour}`,
                  ].join(', ')
                })(),
              }}
              title={
                label === 'Midnight'
                  ? 'Midnight: the end of the current day, just before the next day begins.'
                  : `Set Time of Day to ${label}`
              }
            >
              {label}
            </button>
          )
        }),
      )}
    </div>
  )
}

function ExactPicker({ value, onChange, timeFormat }) {
  // value is "HH:MM" 24h, or null
  let h24 = 12
  let min = 0
  if (value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (m) {
      h24 = Number(m[1])
      min = Number(m[2])
    }
  }
  function commit(newH24, newMin) {
    const hh = String(((newH24 % 24) + 24) % 24).padStart(2, '0')
    const mm = String(((newMin % 60) + 60) % 60).padStart(2, '0')
    onChange(`${hh}:${mm}`)
  }
  function bumpHour(delta) {
    commit(h24 + delta, min)
  }
  function bumpMin(delta) {
    commit(h24, min + delta)
  }
  function setHourFromInput(raw) {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    if (timeFormat === '12h') {
      // raw is 1..12; preserve AM/PM by reading the current AM/PM band
      const isPM = h24 >= 12
      let h12 = ((n - 1) % 12 + 12) % 12 + 1   // clamp to 1..12
      let newH24 = isPM ? (h12 % 12) + 12 : h12 % 12
      commit(newH24, min)
    } else {
      commit(n, min)
    }
  }
  function setMinFromInput(raw) {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    commit(h24, n)
  }
  function toggleAmPm() {
    commit(h24 + (h24 < 12 ? 12 : -12), min)
  }
  // Display values
  let dispH
  if (timeFormat === '12h') {
    dispH = h24 % 12
    if (dispH === 0) dispH = 12
  } else {
    dispH = h24
  }
  const ampm = h24 < 12 ? 'AM' : 'PM'

  return (
    <div className="flex items-center gap-2">
      {/* Hour stepper */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={() => bumpHour(1)}
          className="w-14 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded text-sm"
          title="+1 hour"
        >
          ▲
        </button>
        <input
          type="number"
          min={timeFormat === '12h' ? 1 : 0}
          max={timeFormat === '12h' ? 12 : 23}
          value={dispH}
          onChange={(e) => setHourFromInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className="w-16 text-center bg-zinc-900 border border-zinc-700 rounded text-zinc-100 font-mono text-2xl py-1 focus:outline-none focus:border-accent-400"
        />
        <button
          type="button"
          onClick={() => bumpHour(-1)}
          className="w-14 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded text-sm"
          title="-1 hour"
        >
          ▼
        </button>
      </div>
      <div className="text-zinc-300 font-mono text-2xl pb-1">:</div>
      {/* Minute stepper */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={() => bumpMin(5)}
          className="w-14 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded text-sm"
          title="+5 min"
        >
          ▲
        </button>
        <input
          type="number"
          min={0}
          max={59}
          value={String(min).padStart(2, '0')}
          onChange={(e) => setMinFromInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className="w-16 text-center bg-zinc-900 border border-zinc-700 rounded text-zinc-100 font-mono text-2xl py-1 focus:outline-none focus:border-accent-400"
        />
        <button
          type="button"
          onClick={() => bumpMin(-5)}
          className="w-14 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded text-sm"
          title="-5 min"
        >
          ▼
        </button>
      </div>
      {/* AM/PM toggle (12h mode only) */}
      {timeFormat === '12h' && (
        <button
          type="button"
          onClick={toggleAmPm}
          className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ${
            ampm === 'AM'
              ? 'bg-zinc-700 text-zinc-100'
              : 'bg-accent-600 text-white'
          }`}
          title="Toggle AM / PM"
        >
          {ampm}
        </button>
      )}
    </div>
  )
}

// ── Main carousel component ──────────────────────────────────────────

const TIERS = [
  { id: 'broad',    label: 'Broad' },
  { id: 'labelled', label: 'Labelled' },
  { id: 'exact',    label: 'Exact' },
]

export default function TimeOfDayCarousel({ state, onChange, timeFormat = '12h', bgColour = '#18181b', tilted = false }) {
  const activeTier = state?.activeTier ?? 'labelled'  // default starting tier per §2.1
  const drafts = state?.drafts ?? { broad: null, labelled: null, exact: null }

  const setActiveTier = useCallback((newTier) => {
    if (newTier === activeTier) return
    // Cross-tier collapse pre-fill: only when rotating from MORE precise
    // to LESS precise AND the target tier currently has no draft. Never
    // overwrite an existing target draft (per §2.2 "pre-fill never
    // overwrites").
    let nextDrafts = drafts
    if (drafts[newTier] == null) {
      let prefill = null
      if (newTier === 'labelled' && drafts.exact)        prefill = collapseExactToLabelled(drafts.exact)
      else if (newTier === 'broad' && drafts.exact)      prefill = collapseExactToBroad(drafts.exact)
      else if (newTier === 'broad' && drafts.labelled)   prefill = collapseLabelledToBroad(drafts.labelled)
      if (prefill != null) {
        nextDrafts = { ...drafts, [newTier]: prefill }
      }
    }
    onChange({ activeTier: newTier, drafts: nextDrafts })
  }, [activeTier, drafts, onChange])

  const setDraft = useCallback((tierId, value) => {
    onChange({ activeTier, drafts: { ...drafts, [tierId]: value } })
  }, [activeTier, drafts, onChange])

  // Hint text — show when the target tier was prefilled or when other tiers have stored values.
  const otherDrafts = []
  if (activeTier !== 'broad'    && drafts.broad != null)    otherDrafts.push('broad')
  if (activeTier !== 'labelled' && drafts.labelled != null) otherDrafts.push('labelled')
  if (activeTier !== 'exact'    && drafts.exact != null)    otherDrafts.push('exact')
  const hint = otherDrafts.length > 0
    ? `Retained drafts at: ${otherDrafts.join(', ')} (only the active tier saves)`
    : null

  return (
    <GranularityCarousel
      tiers={TIERS}
      activeTierId={activeTier}
      onActiveTierChange={setActiveTier}
      hint={hint}
      dataHelpRegion="scene-time:time_of_day"
    >
      {/* Reserve enough vertical space for the tallest tier widget
          (Tier 2 gearshift) so rotating between tiers doesn't cause
          the surrounding modal layout to jump in height. */}
      <div style={{ minHeight: 190 }} className="flex items-center justify-center w-full">
        {activeTier === 'broad' && (
          <BroadPicker
            value={drafts.broad}
            onChange={(v) => setDraft('broad', v)}
          />
        )}
        {activeTier === 'labelled' && (
          <LabelledPicker
            value={drafts.labelled}
            onChange={(v) => setDraft('labelled', v)}
            bgColour={bgColour}
            tilted={tilted}
          />
        )}
        {activeTier === 'exact' && (
          <ExactPicker
            value={drafts.exact}
            onChange={(v) => setDraft('exact', v)}
            timeFormat={timeFormat}
          />
        )}
      </div>
    </GranularityCarousel>
  )
}
