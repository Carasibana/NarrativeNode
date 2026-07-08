/**
 * Gregorian Calendar — the default calendar provider for NarrativeNode.
 *
 * This file is pure data: weekday / season / month label sets, the
 * days-per-month table, and standard Earth time-unit names. It plugs
 * into `calendarConventions.js` via `setActiveCalendar()`.
 *
 * To define a custom fantasy calendar (different season counts,
 * different weekday names, 13-month world, "moons" instead of months,
 * etc.), copy the shape of this file into a new module and call
 * `setActiveCalendar(MY_CUSTOM_CALENDAR)` somewhere on app / story
 * load. The accessor API in `calendarConventions.js` doesn't change.
 *
 * Shape contract — every calendar provider must expose:
 *   weekdays:    { long: string[], short: string[] }
 *   seasons:     { long: string[] }
 *   months:      { long: string[], short: string[] }
 *   monthDays:   number[]            (length === months.long.length)
 *   februaryIndex: number | null     (index of the leap-day month, or null)
 *   timeUnits:   { [key: string]: { singular, plural, short } }
 *
 * Storage indices in the SceneNode model are integers into these arrays
 * (0-based for arrays; date_month on the backend is 1-indexed and
 * converts at the read/write boundary). Renaming a label here is purely
 * cosmetic and never invalidates a saved scene.
 */
export const GREGORIAN_CALENDAR = {
  weekdays: {
    long:  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  },
  seasons: {
    // Indices 0..3 are the four temperate seasons; 4..5 are the
    // tropical-climate Wet / Dry pair. Stories set in tropical
    // regions can pick the latter pair without remixing the
    // temperate set. Backend `SceneNode.season` is `Optional[int]`
    // so no model migration is needed.
    long: ['Spring', 'Summer', 'Fall', 'Winter', 'Wet', 'Dry'],
  },
  months: {
    long:  ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'],
    short: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  // Days-per-month base table. February uses 28 (non-leap); the 29th
  // is treated as an explicit per-scene "leap day" assertion that adds
  // one to the count when the writer picks day 29.
  monthDays:     [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  februaryIndex: 1,
  timeUnits: {
    minute: { singular: 'Minute', plural: 'Minutes', short: 'min' },
    hour:   { singular: 'Hour',   plural: 'Hours',   short: 'hr'  },
    day:    { singular: 'Day',    plural: 'Days',    short: 'd'   },
    week:   { singular: 'Week',   plural: 'Weeks',   short: 'wk'  },
  },
}
