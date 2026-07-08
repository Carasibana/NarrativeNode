/**
 * Phase 1.22 — Circumstance / Motivator intensity badge.
 *
 * Pentagon (point-up), 5 wedges meeting at the centre. The pentagon's
 * outer border matches the fill colour at every tier so the silhouette
 * glows with the tier colour at any intensity level. Wedges fill
 * clockwise starting from the BOTTOM wedge as the level rises:
 *
 *   Level 0 (Faint)    -> bottom only,        cool blue        (#3b82f6)
 *   Level 1 (Mild)     -> bottom + left,      cyan             (#22d3ee)
 *   Level 2 (Moderate) -> + top-left,         yellow-green     (#84cc16)
 *   Level 3 (Strong)   -> + top-right,        amber            (#f59e0b)
 *   Level 4 (Intense)  -> all five wedges,    warm orange      (#f97316)
 *
 * Unset state: renders a dashed grey pentagon outline (no fill) as
 * a placeholder visual. Callers that want NO badge at all when the
 * intensity is unset should branch on null / undefined themselves
 * before rendering — the badge component renders the placeholder
 * unconditionally so size variants line up consistently in catalogue
 * views.
 *
 * Sizes scale uniformly from the same SVG; pass any pixel size via
 * the `size` prop (default 16). Stroke weight, wedge fills, and the
 * outline all scale together — proportions never change between
 * sizes.
 */

// Per-tier colour map. Index is the level (0-4); value is the tier hex.
export const INTENSITY_COLOURS = [
  '#3b82f6',  // 0 — Faint   (cool blue)
  '#22d3ee',  // 1 — Mild    (cyan)
  '#84cc16',  // 2 — Moderate (yellow-green)
  '#f59e0b',  // 3 — Strong  (amber)
  '#f97316',  // 4 — Intense (warm orange)
]

// Per-tier label map. Used for tooltips, accessibility, and any text
// rendering of the level (e.g. export output).
export const INTENSITY_LABELS = ['Faint', 'Mild', 'Moderate', 'Strong', 'Intense']

// Pentagon vertices (point-up, radius 40, centred at 0,0). Same path
// the type-badge component reuses so both visuals are guaranteed to
// share an outline silhouette.
const PENTAGON_PATH = 'M 0,-40 L 38.04,-12.36 L 23.51,32.36 L -23.51,32.36 L -38.04,-12.36 Z'

// Phase 1.22h — chevron-corner outline used when `temporary=true`.
// Instead of the full pentagon perimeter, draw 5 small chevron-shaped
// segments at each vertex (each segment occupies ~35% of each adjacent
// edge from the vertex inward). The gaps between corners signal "this
// is scoped, not full" — used on temporary circumstances / motivators
// that apply only at one scene and don't propagate downstream.
const PENTAGON_VERTICES_CW = [
  [0,      -40],     // TOP
  [38.04,  -12.36],  // upper-right
  [23.51,   32.36],  // lower-right
  [-23.51,  32.36],  // lower-left
  [-38.04, -12.36],  // upper-left
]
const CORNER_T = 0.22  // fraction of each adjacent edge the corner segment occupies (smaller = bigger gaps between corners)
function buildCornerSegmentPaths() {
  const paths = []
  const n = PENTAGON_VERTICES_CW.length
  for (let i = 0; i < n; i++) {
    const v    = PENTAGON_VERTICES_CW[i]
    const prev = PENTAGON_VERTICES_CW[(i + n - 1) % n]
    const next = PENTAGON_VERTICES_CW[(i + 1)     % n]
    // Point on the prev-edge, CORNER_T of the way from v toward prev.
    const px = v[0] + (prev[0] - v[0]) * CORNER_T
    const py = v[1] + (prev[1] - v[1]) * CORNER_T
    // Point on the next-edge, CORNER_T of the way from v toward next.
    const nx = v[0] + (next[0] - v[0]) * CORNER_T
    const ny = v[1] + (next[1] - v[1]) * CORNER_T
    paths.push(`M ${px.toFixed(2)},${py.toFixed(2)} L ${v[0]},${v[1]} L ${nx.toFixed(2)},${ny.toFixed(2)}`)
  }
  return paths
}
const CORNER_SEGMENT_PATHS = buildCornerSegmentPaths()

// Pentagon perimeter vertices, ordered clockwise starting from
// lower-right (where W1's outer edge begins). Each subsequent vertex
// extends the filled region by one wedge clockwise.
//
//   index 0 : lower-right  (23.51, 32.36)   ← starting radius for W1
//   index 1 : lower-left   (-23.51, 32.36)  ← outer edge of W1 / start of W2
//   index 2 : upper-left   (-38.04, -12.36) ← outer edge of W2 / start of W3
//   index 3 : top          (0, -40)         ← outer edge of W3 / start of W4
//   index 4 : upper-right  (38.04, -12.36)  ← outer edge of W4 / start of W5
//
// For level N (0-3) the filled region is a single polygon defined by
// `centre + perimeter[0..N+2]`. Drawing it as ONE continuous path
// (M centre, L p0, L p1, ..., Z) avoids the anti-aliased hairline
// seams that show up when butting multiple triangle wedges together.
const PERIMETER = [
  [23.51,  32.36],   // 0 — lower-right
  [-23.51, 32.36],   // 1 — lower-left
  [-38.04, -12.36],  // 2 — upper-left
  [0,      -40],     // 3 — top
  [38.04,  -12.36],  // 4 — upper-right
]
function combinedFillPath(level) {
  // level is 0..3 here; level 4 is handled separately as the solid
  // pentagon (no central seam to worry about).
  const verts = PERIMETER.slice(0, level + 2)  // N+2 perimeter points
  const segs = verts.map(([x, y]) => `L ${x},${y}`).join(' ')
  return `M 0,0 ${segs} Z`
}

/**
 * Render the intensity badge for a given level.
 *
 * Props:
 *   level:           integer 0-4, OR null / undefined → unset placeholder.
 *   size:            pixel width / height (default 16).
 *   title:           optional tooltip; defaults to the level's label.
 *   temporary:       Phase 1.22h — when true, the pentagon outline is
 *                    replaced with five small chevron-shaped corner
 *                    segments (gaps along the edges between corners).
 *                    Used for temporary circumstance / motivator
 *                    entries that apply at one scene only and don't
 *                    propagate downstream. Inner fill polygon is
 *                    unchanged so the tier colour still reads at a
 *                    glance.
 *   temporaryColour: optional override colour for the chevron-corner
 *                    strokes when `temporary=true`. Typically the
 *                    scene's default canvas colour so temporary
 *                    badges visually anchor to the scene rather than
 *                    the tier. Falls back to the tier colour when
 *                    omitted.
 */
export function IntensityBadge({ level, size = 16, title, temporary = false, temporaryColour = null, dataHelpRegion = 'badge:intensity' }) {
  // Unset state — render a dashed grey pentagon outline as a placeholder.
  // Same silhouette as the filled tiers so the trailing-edge slot stays
  // visually consistent across rows.
  if (level === null || level === undefined) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="-50 -50 100 100"
        width={size}
        height={size}
        style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
        role="img"
        aria-label={title || (temporary ? 'Temporary intensity unset' : 'Intensity unset')}
        data-help-region={dataHelpRegion || undefined}
      >
        <title>{title || (temporary ? 'Temporary intensity unset' : 'Intensity unset')}</title>
        {temporary ? (
          // Corner-segment outline only, dashed. The chevron-corner-
          // only shape is the temporary signal; the dashes carry the
          // unset signal. Stroke uses `temporaryColour` (typically the
          // scene's default canvas colour) when provided so the badge
          // anchors visually to the scene; falls back to grey.
          CORNER_SEGMENT_PATHS.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={temporaryColour || '#71717a'}
              strokeWidth="6"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray="4 3"
              opacity="0.7"
            />
          ))
        ) : (
          <path
            d={PENTAGON_PATH}
            fill="none"
            stroke="#71717a"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeDasharray="6 5"
            opacity="0.7"
          />
        )}
      </svg>
    )
  }
  const lv = Math.max(0, Math.min(4, Math.round(level)))
  const colour = INTENSITY_COLOURS[lv]
  // Intense (level 4) fills the entire pentagon — render it as a
  // single solid pentagon rather than five wedges so seam artefacts
  // along the centre never show through at small sizes.
  const renderIntense = lv === 4
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      role="img"
      aria-label={title || (temporary ? `Temporary ${INTENSITY_LABELS[lv]}` : INTENSITY_LABELS[lv])}
      data-help-region={dataHelpRegion || undefined}
    >
      <title>{title || (temporary ? `Temporary ${INTENSITY_LABELS[lv]}` : INTENSITY_LABELS[lv])}</title>
      {renderIntense ? (
        <path d={PENTAGON_PATH} fill={colour} />
      ) : (
        <path d={combinedFillPath(lv)} fill={colour} />
      )}
      {temporary ? (
        CORNER_SEGMENT_PATHS.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={temporaryColour || colour}
            strokeWidth="6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))
      ) : (
        <path d={PENTAGON_PATH} fill="none" stroke={colour} strokeWidth="3" strokeLinejoin="round" />
      )}
    </svg>
  )
}

/**
 * Helper to convert a level integer into a `"<Label> (<level+1>/5)"`
 * string for export / AI context. Returns null when level is null /
 * undefined; returns the label-only form when used without the
 * quantitative half (callers can drop the parenthetical).
 *
 * Example: `formatIntensityForExport(3)` → `"Strong (4/5)"`.
 */
export function formatIntensityForExport(level) {
  if (level === null || level === undefined) return null
  const lv = Math.max(0, Math.min(4, Math.round(level)))
  return `${INTENSITY_LABELS[lv]} (${lv + 1}/5)`
}

export default IntensityBadge
