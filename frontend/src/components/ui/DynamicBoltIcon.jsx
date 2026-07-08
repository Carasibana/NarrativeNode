import { useAccentColor } from '../../utils/povConstants'

/**
 * Dynamic pill bolt — Phase 2.10b item 3.
 *
 * Bespoke inline SVG (NOT the ⚡ emoji glyph) that renders in the
 * loaded story's `accent_color`. Sits at the left edge of every Phase
 * 2.10b dynamic pill (Tier 1 surface-intrinsic + Tier 2 attached) as
 * the visual signal "this pill is dynamic — its content tracks
 * context."
 *
 * The colour is intentionally story-accent so the same affordance
 * reads as visually tied to the writer's current story; on the
 * program-wide accent fallback when no story is loaded so the same
 * component works in pre-load surfaces (none today, defence-in-depth
 * for future).
 *
 * Two callsites today:
 *   - rendered automatically by `.nn-pill-dynamic` consumers (see
 *     index.css)
 *   - rendered directly by pill components that need finer control
 *     over icon size relative to label text
 *
 * Props:
 *   - `size: number = 12` — square pixel size of the SVG. Matches the
 *     existing icon-size convention in `IdentityBadges.jsx` (default 12).
 *   - `accentColour?: string` — override the accent colour explicitly;
 *     falls back to the story's accent via `useAccentColor`. Used by
 *     surfaces that want to mock the icon in a different colour (e.g.
 *     the prompt editor modal's mock affordances, item 8).
 *   - `title?: string` — passed through as the SVG's accessible title.
 *
 * Performance: this is a pure functional component reading one Zustand
 * selector via `useAccentColor`. Subscribed components re-render only
 * when `story.accent_color` changes — story-load and Story Settings
 * Save are the only sources of that change today, both rare.
 */
export default function DynamicBoltIcon({ size = 12, accentColour, title }) {
  const storyAccent = useAccentColor()
  const colour = accentColour || storyAccent
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 14"
      fill={colour}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      className="flex-shrink-0"
    >
      {title ? <title>{title}</title> : null}
      {/* Classic lightning bolt path — angular zig-zag. The points
          are tuned so the bolt reads as a unified glyph at 12px
          even after font-aware rendering snaps to half-pixels. */}
      <path d="M5.6 0 L1 7.5 L4.2 7.5 L3 14 L9 5.5 L5.4 5.5 L7 0 Z" />
    </svg>
  )
}
