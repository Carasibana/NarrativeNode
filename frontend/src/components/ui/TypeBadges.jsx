/**
 * Phase 1.22 — Circumstance / Motivator type badges.
 *
 * Pentagon outline (same shape family as the IntensityBadge) with a
 * single character centred inside:
 *   - Circumstance: `C` in slate (#64748b).
 *   - Motivator:    `M` in rust  (#a17a6e).
 *
 * The shape continuity links these badges to the IntensityBadge as a
 * visual family, but the outline-only-with-letter form keeps them
 * visually distinct from the intensity badge's filled-wedge form.
 *
 * Both colours are unclaimed elsewhere in the program (existing
 * identity colours: tan for knowledge, violet for relationship,
 * purple for scene, blue/cyan/yellow-green/amber/orange used by the
 * IntensityBadge gradient). Cool slate vs warm rust quietly carries
 * the external-vs-internal asymmetry without being literal.
 *
 * Sizes scale uniformly from the same SVG; pass any pixel size via
 * the `size` prop (default 16). Stroke weight, letter font, and the
 * outline all scale together — proportions never change.
 */

export const CIRCUMSTANCE_COLOUR = '#94a3b8'  // brightened slate (Tailwind slate-400)
export const MOTIVATOR_COLOUR    = '#c89078'  // brightened terracotta-rust

// Shared pentagon outline path (matches IntensityBadge silhouette).
const PENTAGON_PATH = 'M 0,-40 L 38.04,-12.36 L 23.51,32.36 L -23.51,32.36 L -38.04,-12.36 Z'

// Phase 1.22h — chevron-corner outline used when `temporary=true`.
// Same five corner segments as IntensityBadge; kept independent here
// to avoid a circular import between the two badge components.
const PENTAGON_VERTICES_CW = [
  [0,      -40],
  [38.04,  -12.36],
  [23.51,   32.36],
  [-23.51,  32.36],
  [-38.04, -12.36],
]
const CORNER_T = 0.22  // smaller = bigger gaps between corners; matches IntensityBadge
const CORNER_SEGMENT_PATHS = (() => {
  const paths = []
  const n = PENTAGON_VERTICES_CW.length
  for (let i = 0; i < n; i++) {
    const v    = PENTAGON_VERTICES_CW[i]
    const prev = PENTAGON_VERTICES_CW[(i + n - 1) % n]
    const next = PENTAGON_VERTICES_CW[(i + 1)     % n]
    const px = v[0] + (prev[0] - v[0]) * CORNER_T
    const py = v[1] + (prev[1] - v[1]) * CORNER_T
    const nx = v[0] + (next[0] - v[0]) * CORNER_T
    const ny = v[1] + (next[1] - v[1]) * CORNER_T
    paths.push(`M ${px.toFixed(2)},${py.toFixed(2)} L ${v[0]},${v[1]} L ${nx.toFixed(2)},${ny.toFixed(2)}`)
  }
  return paths
})()

function PentagonLetterBadge({ letter, colour, size, title, temporary, temporaryColour, dataHelpRegion }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      role="img"
      aria-label={title}
      data-help-region={dataHelpRegion}
    >
      <title>{title}</title>
      {temporary ? (
        // Chevron-corner outline only — solid corner segments at each
        // pentagon vertex with gaps along the edges between. Visually
        // signals "this is scoped, not full" — used for temporary
        // circumstances / motivators that apply at one scene only.
        // Stroke uses `temporaryColour` (typically the scene's default
        // canvas colour) when provided; falls back to the type colour
        // (slate/rust) so the variant degrades gracefully.
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
      <text
        x="0"
        y="17"
        fill={colour}
        fontSize="50"
        fontWeight="700"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}

export function CircumstanceTypeBadge({ size = 16, title = 'Circumstance', temporary = false, temporaryColour = null }) {
  const fullTitle = temporary ? `Temporary ${title}` : title
  return <PentagonLetterBadge letter="C" colour={CIRCUMSTANCE_COLOUR} size={size} title={fullTitle} temporary={temporary} temporaryColour={temporaryColour} dataHelpRegion="badge:circumstance_type" />
}

export function MotivatorTypeBadge({ size = 16, title = 'Motivator', temporary = false, temporaryColour = null }) {
  const fullTitle = temporary ? `Temporary ${title}` : title
  return <PentagonLetterBadge letter="M" colour={MOTIVATOR_COLOUR} size={size} title={fullTitle} temporary={temporary} temporaryColour={temporaryColour} dataHelpRegion="badge:motivator_type" />
}

/* ────────────────────────────────────────────────────────────────────
 * Phase 2.13 — Perspective type badge.
 *
 * Rounded-diamond outline (square rotated 45° on centre, with corner
 * radius 14.14 so the orthogonal offset r/√2 lands at exactly 10).
 * Shape was picked specifically to be visually distinct from the
 * pentagon-family C/M badges: a different polygon count, rotated
 * orientation, and no possibility of being misread as an axis-aligned
 * UI button.
 *
 * Colour is antique gold — the third metallic note in the dull-silver
 * (Circumstance) / dull-bronze (Motivator) / dull-gold (Perspective)
 * trio. Sits in a hue band unclaimed by any existing identity colour
 * (violet=relationship, purple=scene, tan=knowledge, indigo=
 * conversation, amber=broad day, deep indigo=broad night,
 * emerald+yellow=cues, slate=circumstance, rust=motivator, red=reject).
 *
 * No `temporary` variant in v1 — perspectives are not scoped to a
 * single scene (the C/M temporary pattern). If a future change wants
 * scene-scoped perspectives, mirror the chevron-corner variant from
 * PentagonLetterBadge here.
 * ──────────────────────────────────────────────────────────────────── */

export const PERSPECTIVE_COLOUR = '#a89150'  // antique gold

// Rounded-diamond outline path. Vertices at (±50, 0) and (0, ±50);
// corner radius softens each tip. See Phase 2.13 ideation grid in
// DevPreviewPanel.jsx for the design rationale.
const ROUNDED_DIAMOND_PATH = 'M 10,-40 L 40,-10 Q 50,0 40,10 L 10,40 Q 0,50 -10,40 L -40,10 Q -50,0 -40,-10 L -10,-40 Q 0,-50 10,-40 Z'

function RoundedDiamondLetterBadge({ letter, colour, size, title, dataHelpRegion }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      role="img"
      aria-label={title}
      data-help-region={dataHelpRegion}
    >
      <title>{title}</title>
      <path d={ROUNDED_DIAMOND_PATH} fill="none" stroke={colour} strokeWidth="3" strokeLinejoin="round" />
      <text
        x="0"
        y="17"
        fill={colour}
        fontSize="50"
        fontWeight="700"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}

export function PerspectiveTypeBadge({ size = 16, title = 'Perspective' }) {
  return <RoundedDiamondLetterBadge letter="P" colour={PERSPECTIVE_COLOUR} size={size} title={title} dataHelpRegion="badge:perspective_type" />
}

/**
 * Generic dispatcher — given an attribute_type string, returns the
 * appropriate type badge (or null for unrecognised types). Useful
 * when a renderer doesn't know which specialised type it has up
 * front. Name retained for backward compatibility with existing
 * callers; the dispatch covers `circumstance` / `motivator` /
 * `perspective` now.
 */
export function CMTypeBadge({ attributeType, size = 16, title, temporary = false, temporaryColour = null }) {
  if (attributeType === 'circumstance') return <CircumstanceTypeBadge size={size} title={title} temporary={temporary} temporaryColour={temporaryColour} />
  if (attributeType === 'motivator')    return <MotivatorTypeBadge    size={size} title={title} temporary={temporary} temporaryColour={temporaryColour} />
  if (attributeType === 'perspective')  return <PerspectiveTypeBadge  size={size} title={title} />
  return null
}
