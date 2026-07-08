/**
 * Calendar conventions API — accessor layer over a swappable calendar
 * provider. Default provider is `gregorianCalendar.js`; custom fantasy
 * calendars plug in via `setActiveCalendar(MY_CALENDAR)`.
 *
 * Backend stores integer indices for weekday / season / month and the
 * day-of-month integer; this module only resolves those indices to UI
 * strings at render time. Renaming a label here is purely cosmetic and
 * never invalidates a saved scene.
 *
 * Usage at call sites — prefer the accessor functions or
 * `getActiveCalendar()` over reaching into a specific calendar object,
 * so a future swap is a single-point change with no consumer churn:
 *
 *   import { getActiveCalendar, weekdayName, daysInMonth } from '.../calendarConventions'
 *   const cal = getActiveCalendar()
 *   for (const idx of [0, 1, 2, ...]) ... cal.weekdays.short[idx] ...
 *   weekdayName(2, 'short')                  // "Tue"
 *   daysInMonth(1, true)                     // 29  (true = leap)
 */
import { GREGORIAN_CALENDAR } from './gregorianCalendar'

let _active = GREGORIAN_CALENDAR

// ── Provider control ─────────────────────────────────────────────────

export function setActiveCalendar(calendar) {
  if (!calendar) return
  _active = calendar
}

export function getActiveCalendar() {
  return _active
}

// ── Single-value accessors ───────────────────────────────────────────

export function weekdayName(idx, form = 'long') {
  return _active.weekdays?.[form]?.[idx] ?? ''
}

export function seasonName(idx) {
  return _active.seasons?.long?.[idx] ?? ''
}

export function monthName(idx, form = 'long') {
  return _active.months?.[form]?.[idx] ?? ''
}

export function daysInMonth(monthIdx, leap = false) {
  const base = _active.monthDays?.[monthIdx] ?? 31
  return leap && monthIdx === _active.februaryIndex ? base + 1 : base
}

export function timeUnitName(unit, count = null) {
  const entry = _active.timeUnits?.[unit]
  if (!entry) return ''
  if (count == null) return entry.plural
  return count === 1 ? entry.singular : entry.plural
}

export function timeUnitShort(unit) {
  return _active.timeUnits?.[unit]?.short ?? ''
}

// ── Counts (derived from active calendar) ────────────────────────────

export function weekdaysPerWeek() { return _active.weekdays?.long?.length ?? 0 }
export function seasonsPerYear()  { return _active.seasons?.long?.length ?? 0 }
export function monthsPerYear()   { return _active.months?.long?.length ?? 0 }
export function februaryIndex()   { return _active.februaryIndex ?? null }

// ── Weekday display order helper ─────────────────────────────────────
//
// Returns the weekday indices in render order. `weekStart` is 'sunday'
// (default) or 'monday'. Iterate this list when rendering the weekday
// button row so storage stays Sun=0…Sat=N regardless of display order.
// For non-Earth calendars with a different weekday count, the first
// index (0) is treated as the start, and 'monday' rotates by one.
export function weekdaysInDisplayOrder(weekStart = 'sunday') {
  const n = weekdaysPerWeek()
  const indices = Array.from({ length: n }, (_, i) => i)
  if (weekStart === 'monday' && n >= 2) {
    return [...indices.slice(1), 0]
  }
  return indices
}
