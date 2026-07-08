/**
 * Phase 3.4e — Tag display badge.
 *
 * Display-only badge for any tag rendered as a label (NOT a filter
 * chip — see `TagFilterChip.jsx` for the filter-state-cycling variant
 * used by `TagFilterBar`). `TagBadge` is the default render shape for
 * tags on:
 *
 *   - per-host `TagsSection` chip rows (Entity / Knowledge /
 *     Relationship details panels; Reference-node footer; Preset-
 *     list rows)
 *   - the Tags & Lists library tab's pool-management rows
 *   - the Context Cue + Conversation tag chip rows once those
 *     migrate from the legacy display path
 *
 * Visual treatment baked into the component (the writer never sees a
 * tag without these affordances):
 *
 *   - leading `#` and surrounding `[...]` brackets are rendered as
 *     part of the badge; the stored `name` does NOT include them
 *     (the project / program normalisers strip a leading `#` at
 *     write time)
 *   - `text-transform: uppercase` via CSS so user casing is preserved
 *     in storage while every badge renders consistently
 *   - the badge's accent colour drives the border + a low-opacity
 *     fill; text uses a lighter variant of the colour so contrast
 *     holds on a dark canvas
 *
 * Props:
 *   - `name`        — stored tag name (without `#` or brackets)
 *   - `color`       — hex string driving the visual treatment
 *   - `chainAdded`  — boolean; when true, applies a dashed border
 *                     (instead of the default solid) as a quiet
 *                     visual differentiator for tags that landed at
 *                     a downstream scene rather than at the host's
 *                     origin. Hover tooltip spells out the meaning
 *                     ("Added at a downstream scene"). Only
 *                     meaningful on Project Tags since Program Tags
 *                     aren't chain-tracked.
 *   - `count`       — optional integer. When provided, renders
 *                     ` (N)` after the closing bracket — used ONLY by
 *                     the library row context. Per-host renders omit
 *                     it (no `count` prop = no suffix).
 *   - `size`        — `'xs' | 'sm' | 'md'` (default `'md'`). Matches
 *                     `TagFilterChip` sizing so the two components
 *                     compose visually in mixed surfaces.
 *   - `onClick`     — handler. When present, the badge becomes
 *                     interactive (cursor pointer, role=button).
 *   - `onRemove`    — handler. When present, an inline `×` button
 *                     surfaces; click bubbles to onRemove. Used on
 *                     per-host chips so the writer can detach a tag
 *                     without leaving the surface.
 *
 * The component is intentionally minimal — no internal state, no
 * filter-cycling, no awareness affordance. Tags don't carry
 * awareness in this project (`models/tag.py` design note).
 */
import { memo } from 'react'

const _SIZE_CLASS = {
  xs: 'text-[9px] px-1 py-px gap-0.5',
  sm: 'text-[10px] px-1.5 py-0.5 gap-0.5',
  md: 'text-xs px-2 py-0.5 gap-1',
}

// Hex `#RRGGBB` → `rgba(r, g, b, alpha)`. Used to derive the muted
// fill (alpha ~0.18) and the lighter text colour (no alpha; rely on
// `color-mix` via opacity is not portable so we just brighten by
// blending toward white in CSS via a slightly higher alpha on a
// near-white-saturation overlay). Returns a CSS string; falls back
// to a neutral muted grey when parsing fails.
function _hexToRgba(hex, alpha = 1) {
  if (typeof hex !== 'string') return `rgba(136, 136, 136, ${alpha})`
  const clean = hex.replace('#', '').trim()
  if (clean.length !== 6 && clean.length !== 3) return `rgba(136, 136, 136, ${alpha})`
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(136, 136, 136, ${alpha})`
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function TagBadge({
  name,
  color = '#888888',
  chainAdded = false,
  count,
  size = 'md',
  onClick,
  onRemove,
}) {
  const sizeCls = _SIZE_CLASS[size] || _SIZE_CLASS.md
  const interactive = typeof onClick === 'function'

  // Phase 3.4i — dark fill variant (zinc-900/80 + brighter tag-coloured
  // border + text). Replaces the previous "stained glass" 18%-alpha
  // tag-coloured fill, which muddied when composed against any coloured
  // background (notably the emerald / amber / red state wraps inside
  // `TagFilterChip`). The dark fill base sits cleanly on any backdrop
  // while the tag's identity remains legible via the brighter border
  // + text colour.
  const style = {
    backgroundColor: 'rgba(24, 24, 27, 0.8)',  // zinc-900/80
    borderColor: _hexToRgba(color, 0.75),
    color: _hexToRgba(color, 1),
  }

  const showSuffix = Number.isFinite(count) && count >= 0

  return (
    <span
      data-help-region="tag-badge:badge"
      className={`group relative inline-flex items-center rounded border transition-colors ${sizeCls} ${
        interactive ? 'cursor-pointer select-none hover:brightness-125' : ''
      } ${chainAdded ? 'border-dashed' : ''}`}
      style={style}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }
        : undefined
      }
      title={chainAdded ? 'Added at a downstream scene' : undefined}
    >
      <span className="font-mono leading-none flex-shrink-0">[#</span>
      <span className="truncate max-w-[14rem] uppercase tracking-wide">{name}</span>
      <span className="font-mono leading-none flex-shrink-0">]</span>
      {showSuffix && (
        <span className="font-mono leading-none flex-shrink-0 opacity-70 normal-case">
          ({count})
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="ml-0.5 text-zinc-500 hover:text-red-300 leading-none normal-case hidden group-hover:inline-block focus:inline-block focus-visible:inline-block"
          title="Detach this tag"
        >
          ×
        </button>
      )}
    </span>
  )
}

export default memo(TagBadge)
