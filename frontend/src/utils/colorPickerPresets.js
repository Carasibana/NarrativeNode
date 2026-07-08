/**
 * Preset palette data for the 19-hex honeycomb swatch picker.
 *
 * Layout: JWST-style 1 centre + 6 inner ring + 12 outer ring.
 * Ring indices are clockwise from the 12 o'clock position.
 *
 *                      o0
 *              o11            o1
 *         o10     i0      i1     o2
 *              i5  centre  i2
 *         o9      i4      i3     o3
 *              o8              o4
 *                      o7           -- wait, outer is 12 slots not 8
 *
 * The real outer ring has 12 positions at 30° intervals:
 * o0=12h, o1=1h, o2=2h, o3=3h (right), o4=4h, o5=5h,
 * o6=6h (bottom), o7=7h, o8=8h, o9=9h (left), o10=10h, o11=11h.
 * Inner ring positions are at 60° intervals starting from 12h:
 * i0=12h, i1=2h, i2=4h, i3=6h (bottom), i4=8h, i5=10h.
 *
 * Locked anchors (never change — each serves a specific role):
 * - centre: `#888888` (neutral 50% grey, matches the existing entity default).
 * - o0 (top outer): `#ffffff` (white).
 * - o6 (bottom outer): `#000000` (black).
 *
 * Must-include existing project defaults:
 * - POV gold `#eab308` → o5 (bottom-right warm slot).
 * - Setup cyan-teal `#40afd0` → o9 (left-middle cool slot).
 * - Accent violet `#7c3aed` → o11 (top-left cool slot).
 *
 * Remaining 13 slots hold distinct hues drawn from the Tailwind
 * v4 500-shade defaults (or close) so the palette reads
 * consistently with the rest of the UI. Arrangement rule: right
 * half of the ring holds the warm spectrum descending white → gold
 * → black; left half holds the cool spectrum rising black → violet
 * → white; inner-ring hues bridge neighbouring outer-ring pairs
 * to keep hue families clustered.
 *
 * Each entry also carries 6 pre-computed tint variants surfaced by
 * the hover-delay flyout: [lighter, darker, more-saturated,
 * less-saturated, warm-shift, cool-shift]. Non-grayscale tints
 * are computed algorithmically from the main hex via
 * `makeTints()` below; the three grayscale anchors get hand-picked
 * shade-ladders appropriate to a value-only preset.
 */
import { lighten, darken } from './povConstants'

// ── HSV helpers (self-contained) ─────────────────────────────────
// Kept local to this file so the palette data has zero external
// dependencies beyond `povConstants`. The bundle-level picker
// uses `@uiw/color-convert` for the live colour conversions
// driving the saturation square; this file just needs cheap one-
// shot conversions at module-init time.

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

function rgbToHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function rgbToHsv({ r, g, b }) {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === rr)      h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else                 h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, v }
}

function hsvToRgb({ h, s, v }) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rr = 0, gg = 0, bb = 0
  if      (h < 60)  { rr = c; gg = x }
  else if (h < 120) { rr = x; gg = c }
  else if (h < 180) { gg = c; bb = x }
  else if (h < 240) { gg = x; bb = c }
  else if (h < 300) { rr = x; bb = c }
  else              { rr = c; bb = x }
  return { r: (rr + m) * 255, g: (gg + m) * 255, b: (bb + m) * 255 }
}

function shiftHue(hex, degrees) {
  const hsv = rgbToHsv(hexToRgb(hex))
  hsv.h = (hsv.h + degrees + 360) % 360
  return rgbToHex(hsvToRgb(hsv))
}

function shiftSat(hex, delta) {
  const hsv = rgbToHsv(hexToRgb(hex))
  hsv.s = Math.max(0, Math.min(1, hsv.s + delta))
  return rgbToHex(hsvToRgb(hsv))
}

function makeTints(hex) {
  // Larger shift amounts so tints are visually distinct from the
  // parent and from each other — especially on saturated or dark
  // presets where ±15° / ±20% are barely perceptible.
  return [
    lighten(hex, 0.35),   // lighter
    darken(hex, 0.35),    // darker
    shiftSat(hex, +0.30), // more saturated
    shiftSat(hex, -0.30), // less saturated (desaturated)
    shiftHue(hex, -25),   // warm shift (rotate toward red)
    shiftHue(hex, +25),   // cool shift (rotate toward blue)
  ]
}

// Grayscale anchors get wide-spread value-ladder tints so the
// flyout shows clearly distinct steps rather than near-identical
// near-matches. Hue/saturation shifts don't apply to pure greys.
const WHITE_TINTS = ['#e0e0e0', '#b8b8b8', '#909090', '#606060', '#303030', '#0a0a0a']
const BLACK_TINTS = ['#1a1a1a', '#383838', '#606060', '#909090', '#b8b8b8', '#e0e0e0']
const GREY_TINTS  = ['#e0e0e0', '#b4b4b4', '#606060', '#303030', '#d4c4b4', '#b4c4d4']

// ── Palette ──────────────────────────────────────────────────────
// Array order is arbitrary — consumers look up entries by `slot`.
// Keeping them grouped (centre → inner → outer) aids readability.

export const PRESET_PALETTE = [
  // Centre — grey anchor, matches existing entity default.
  { slot: 'center', main: '#888888', tints: GREY_TINTS },

  // Inner ring (6 hues bridging neighbouring outer-ring pairs).
  { slot: 'inner-0', main: '#a855f7', tints: makeTints('#a855f7') }, // top: purple (between violet and rose)
  { slot: 'inner-1', main: '#ec4899', tints: makeTints('#ec4899') }, // 2h: pink (between rose and red)
  { slot: 'inner-2', main: '#fb923c', tints: makeTints('#fb923c') }, // 4h: orange-bright (between orange and amber)
  { slot: 'inner-3', main: '#a3e635', tints: makeTints('#a3e635') }, // 6h bottom: lime-yellow (between gold and lime)
  { slot: 'inner-4', main: '#10b981', tints: makeTints('#10b981') }, // 8h: emerald (between green and teal)
  { slot: 'inner-5', main: '#6366f1', tints: makeTints('#6366f1') }, // 10h: indigo (between blue and violet)

  // Outer ring (12 positions — white and black lock top and bottom).
  { slot: 'outer-0',  main: '#ffffff', tints: WHITE_TINTS },         // 12h — anchor
  { slot: 'outer-1',  main: '#f43f5e', tints: makeTints('#f43f5e') }, // 1h: rose
  { slot: 'outer-2',  main: '#ef4444', tints: makeTints('#ef4444') }, // 2h: red
  { slot: 'outer-3',  main: '#f97316', tints: makeTints('#f97316') }, // 3h: orange
  { slot: 'outer-4',  main: '#f59e0b', tints: makeTints('#f59e0b') }, // 4h: amber
  { slot: 'outer-5',  main: '#eab308', tints: makeTints('#eab308') }, // 5h: POV gold (locked)
  { slot: 'outer-6',  main: '#000000', tints: BLACK_TINTS },         // 6h — anchor
  { slot: 'outer-7',  main: '#84cc16', tints: makeTints('#84cc16') }, // 7h: lime
  { slot: 'outer-8',  main: '#22c55e', tints: makeTints('#22c55e') }, // 8h: green
  { slot: 'outer-9',  main: '#40afd0', tints: makeTints('#40afd0') }, // 9h: Setup cyan-teal (locked)
  { slot: 'outer-10', main: '#3b82f6', tints: makeTints('#3b82f6') }, // 10h: blue
  { slot: 'outer-11', main: '#7c3aed', tints: makeTints('#7c3aed') }, // 11h: Accent violet (locked)
]

/** Case-insensitive hex match against the 19 main preset colours.
 *  Used by the picker to highlight the selected preset when the
 *  current colour exactly matches one of the anchors. Tint matches
 *  are deliberately ignored — v1 doesn't highlight flyout matches. */
export function findMatchingPreset(hex) {
  if (!hex) return null
  const normalized = hex.toLowerCase()
  return PRESET_PALETTE.find((p) => p.main.toLowerCase() === normalized) || null
}
