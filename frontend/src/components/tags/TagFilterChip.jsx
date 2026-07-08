/**
 * Phase 3.4i — Tag filter chip.
 *
 * Wraps the display-only `TagBadge` with a state-coloured outer
 * wrap so the inner badge keeps its per-tag colour while the wrap
 * communicates the chip's filter participation (null / AND / OR / NOT).
 *
 * Visual states:
 *
 *   | State | Wrap                                  | Glyph |
 *   |-------|---------------------------------------|-------|
 *   | null  | none (bare TagBadge, no wrap)         | —     |
 *   | AND   | emerald — `bg-emerald-900/40 ...`     | `+`   |
 *   | OR    | amber   — `bg-amber-900/40 ...`       | `|`   |
 *   | NOT   | red     — `bg-red-900/40 ...`         | `−`   |
 *
 * Two cycle modes via the `mode` prop:
 *   - `'popover'`     — full 4-state cycle: null → AND → OR → NOT → null.
 *                       All four states reachable via click alone. Used
 *                       inside `TagFilterBar`'s popover.
 *   - `'active-row'`  — 3-state cycle: AND → OR → NOT → AND (skip null).
 *                       The `×` button is the only way to remove the tag
 *                       from the filter (locked Pre-Prep decision so a
 *                       click can't accidentally drop the filter).
 *
 * Props:
 *   - `tag`:      `{ id?, name, color, count? }` — `id` for Project Tags,
 *                  bare `name` as identifier for Program Tags.
 *   - `state`:    `'null' | 'and' | 'or' | 'not'`
 *   - `mode`:     `'popover' | 'active-row'` (default `'popover'`)
 *   - `onCycle(nextState)`: called when the writer clicks the chip body.
 *   - `onRemove?`: only rendered in `active-row` mode — `×` button sets
 *                  the tag's state to null (removes from active filter).
 *   - `size?`:    passes through to inner `TagBadge`. Defaults to `'sm'`
 *                  to fit the filter row.
 *
 * Reuses the per-tag colour from the inner `TagBadge` so each filter
 * chip carries BOTH its filter state (via the wrap) AND its visual
 * identity (via the inner colour) at the same time.
 */
import { memo } from 'react'
import TagBadge from './TagBadge'

const _STATE_WRAP = {
  null: '',  // null state renders bare TagBadge with no wrap
  and:  'bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-800/50',
  or:   'bg-amber-900/40 border border-amber-700/60 text-amber-200 hover:bg-amber-800/50',
  not:  'bg-red-900/40 border border-red-700/60 text-red-200 hover:bg-red-800/50',
}

// Heavy Unicode variants of +, |, − so the state glyph reads as
// bolder than the inner badge text. The U+FE0E variation selector
// after each codepoint FORCES TEXT presentation — without it,
// platforms with emoji-default rendering (notably Windows /
// Segoe UI Emoji) render `➖` U+2796 as a purplish-pink emoji
// dash instead of a text glyph picking up the per-state colour.
// `✚` U+271A and `❚` U+275A are TEXT-by-default but `︎` is
// harmless on them — applied to all three for consistency.
const _STATE_GLYPH = {
  null: null,
  and:  '✚︎',  // ✚︎  HEAVY GREEK CROSS (text presentation)
  or:   '❚︎',  // ❚︎  HEAVY VERTICAL BAR (text presentation)
  not:  '➖︎',  // ➖︎  HEAVY MINUS SIGN (text presentation)
}

// Per-state glyph text colour — vibrant mid-shade that matches the
// border's saturation rather than the muted wrap-fill text colour
// (200). Tailwind's 400 shade reads as roughly equivalent to the
// `*-700/60` border at-the-eye, so the glyph and border carry the
// same per-state colour signal.
const _STATE_GLYPH_COLOR = {
  null: '',
  and:  'text-emerald-400',
  or:   'text-amber-400',
  not:  'text-red-400',
}

const _STATE_TOOLTIP_POPOVER = {
  null: 'Click to require (AND)',
  and:  'Required — click for OR',
  or:   'Any of — click for NOT',
  not:  'Excluded — click to remove',
}

const _STATE_TOOLTIP_ACTIVE_ROW = {
  // null state isn't reachable in active-row mode; the chip is removed
  // from the row when state goes to null.
  and:  'Required — click for OR',
  or:   'Any of — click for NOT',
  not:  'Excluded — click for AND',
}

// 4-state cycle (popover): null → and → or → not → null
const _CYCLE_POPOVER = { null: 'and', and: 'or', or: 'not', not: 'null' }
// 3-state cycle (active-row): and → or → not → and (skip null; × removes)
const _CYCLE_ACTIVE_ROW = { and: 'or', or: 'not', not: 'and' }

function TagFilterChip({
  tag,
  state = 'null',
  mode = 'popover',
  onCycle,
  onRemove,
  size = 'sm',
  dataHelpRegion = null,
}) {
  const isPopover = mode === 'popover'
  const cycle = isPopover ? _CYCLE_POPOVER : _CYCLE_ACTIVE_ROW
  const nextState = cycle[state] ?? 'null'
  const tooltip = isPopover ? _STATE_TOOLTIP_POPOVER[state] : _STATE_TOOLTIP_ACTIVE_ROW[state]
  const glyph = _STATE_GLYPH[state]

  const handleClick = () => {
    if (typeof onCycle === 'function') onCycle(nextState)
  }

  // null state in popover mode → bare TagBadge with onClick wired to
  // start the cycle. No wrap, no glyph.
  if (state === 'null') {
    return (
      <TagBadge
        name={tag?.name || ''}
        color={tag?.color || '#888888'}
        count={tag?.count}
        size={size}
        onClick={handleClick}
      />
    )
  }

  // Active state (AND / OR / NOT) → wrap the badge so the inner per-tag
  // colour stays intact while the outer wrap signals filter participation.
  return (
    <span
      role="button"
      tabIndex={0}
      data-help-region={dataHelpRegion || undefined}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() }
      }}
      title={tooltip}
      className={`group inline-flex items-center gap-1 px-1 py-px rounded cursor-pointer select-none transition-colors ${_STATE_WRAP[state]}`}
    >
      {/* Fixed w-3 slot keeps the chip width stable as the writer
          cycles between states — ✚︎ / ❚︎ / ➖︎ each have slightly
          different intrinsic widths and without a reserved slot the
          chip resizes on every click. */}
      <span className={`inline-flex items-center justify-center w-3 font-mono leading-none flex-shrink-0 text-[11px] font-bold ${_STATE_GLYPH_COLOR[state] || ''}`}>{glyph}</span>
      <TagBadge
        name={tag?.name || ''}
        color={tag?.color || '#888888'}
        count={tag?.count}
        size={size}
      />
      {!isPopover && typeof onRemove === 'function' && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="ml-0.5 hidden group-hover:inline-block focus:inline-block focus-visible:inline-block text-zinc-500 hover:text-red-300 leading-none normal-case text-[11px]"
          title="Remove from filter"
          aria-label="Remove from filter"
        >
          ×
        </button>
      )}
    </span>
  )
}

export default memo(TagFilterChip)
