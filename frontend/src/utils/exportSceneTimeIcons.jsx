/**
 * Phase 1.25c — render scene-time icons (season + time-of-day) into
 * inline SVG strings for the Export payload.
 *
 * The dialog calls these helpers per scene before POSTing; the SVG
 * strings travel inside `pre_computed_scene_times[scene_id].{season_svg,
 * tod_svg}`. Renderers consume them as-is for HTML, or rasterise them
 * through `services.export_icons.svg_to_png_bytes` for PDF / DOCX.
 *
 * Implementation strategy: rather than duplicate the path geometry
 * already encoded in `<TimeOfDayCarousel>` and `<DayCarousels>`, we
 * mount the existing React components into an off-DOM tree via
 * `react-dom/server`'s `renderToStaticMarkup` and lift the resulting
 * SVG markup. That keeps the on-canvas glyphs as the single source of
 * truth — any future redesign of the carousel icons automatically
 * propagates to exports.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { CellGlyph, CELL_VISUALS } from '../components/ui/TimeOfDayCarousel.jsx'
import { SeasonGlyph, SEASON_ACCENTS } from '../components/ui/DayCarousels.jsx'

const ICON_SIZE = 32

/**
 * Inline SVG markup for a labelled time-of-day, e.g. "Morning" / "Late
 * Afternoon". Returns "" when the label isn't a known cell label.
 *
 * The inline SVG uses the labelled cell's accent colour for the glyph.
 * Width / height are baked in at 32px; size at render time via the
 * caller (HTML wraps in a `<span>` styled to the line height; PDF /
 * DOCX rasterise then scale).
 */
export function getTimeOfDaySvg(label) {
  if (!label) return ''
  const visual = CELL_VISUALS[label]
  if (!visual) return ''
  const inner = renderToStaticMarkup(
    <CellGlyph
      base={visual.base}
      modifier={visual.modifier}
      colour={visual.colour}
      size={ICON_SIZE}
    />,
  )
  // CellGlyph returns a `<g>` — wrap in a complete `<svg>` so backend
  // rasterisers (svglib) and HTML parsers see a real document.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" `
    + `width="${ICON_SIZE}" height="${ICON_SIZE}" role="img" aria-label="${escapeAttr(label)}">`
    + `<title>${escapeText(label)}</title>`
    + inner
    + `</svg>`
  )
}

/**
 * Inline SVG markup for a season index (0..5: Spring / Summer / Fall /
 * Winter / Wet / Dry). Returns "" when the index is out of range.
 */
export function getSeasonSvg(seasonIdx) {
  if (typeof seasonIdx !== 'number' || seasonIdx < 0 || seasonIdx > 5) return ''
  const colour = SEASON_ACCENTS[seasonIdx] || '#71717a'
  const inner = renderToStaticMarkup(
    <SeasonGlyph index={seasonIdx} size={ICON_SIZE} colour={colour} />,
  )
  // SeasonGlyph already renders an `<svg>` element — return as-is, but
  // make sure the xmlns is present (svglib needs it on the root).
  if (inner.startsWith('<svg ') && !inner.includes('xmlns=')) {
    return inner.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  }
  return inner
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
