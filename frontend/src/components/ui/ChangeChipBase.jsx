import { useState } from 'react'

/**
 * Shared primitives used by all change sub-chip components.
 *
 * Consumers: ChangeSubChip, RelChangeChip, RelationshipSubChip,
 * RelationshipChangeChip (EntityDetailPanel), AlertsPanel.
 */

export const ACTION_COLOR = { add: '#4ade80', modify: '#fbbf24', remove: '#f87171', list_change: '#fbbf24', rename: '#fbbf24' }

export function actionSymbol(action) {
  return action === 'add' ? '✚' : action === 'remove' ? '⚊' : '✱'
}

export function trunc(s, n = 20) {
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '')
}

/** Compact NULL badge — shown when a field value is explicitly null. */
export function NullBadge() {
  return (
    <span
      className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold tracking-wider"
      style={{ color: '#ef4444', backgroundColor: '#ef444418', border: '1px solid #ef4444' }}
    >
      NULL
    </span>
  )
}

/**
 * Compact "orphaned — no inherited value" badge — shown in the
 * old-value slot of a modify sub-chip when its parent chip is
 * orphaned (no narrative-flow wire connecting it to upstream). The
 * chip still carries the override (visible on the new-value side),
 * but there is no chain context to compute a meaningful "before"
 * value, so the slot reads as `?⚮` with a tooltip explaining why.
 *
 * Visually neutral (zinc) so it doesn't read as an error like the
 * red NULL badge — orphan-state is a writer-driven choice, not a
 * fault.
 */
export function OrphanInheritedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-1 py-0 rounded text-[9px] font-bold tracking-wider"
      style={{ backgroundColor: '#52525b22', border: '1px solid #52525b' }}
      title="Orphaned — no inherited value (chip is not connected to upstream)"
    >
      <span style={{ color: '#ef4444' }}>?</span>
      <span style={{ color: '#fbbf24' }}>⚮</span>
    </span>
  )
}

/**
 * Shared wrapper for all change sub-chips.
 *
 * Renders: tinted background + coloured left border, action symbol,
 * optional review flag (⚑), and hover-reveal dismiss button.
 *
 * Props:
 *   action        — 'add' | 'modify' | 'remove' | 'list_change' (drives colour + symbol)
 *   color         — optional colour override (for non-action chips, e.g. existing-state)
 *   showSymbol    — default true; set false to suppress the leading action symbol
 *   onDismiss     — optional; renders hover-reveal − button
 *   onAddKnowledge — optional; renders hover-reveal "Add knowledge of this change" button
 *                    (composite green ✚ + Knowledge icon glyph). Hidden by default,
 *                    revealed on chip hover, overlays trailing content rather than
 *                    forcing it to wrap. Callsites pass a click handler that opens
 *                    the create / attach Knowledge popover for this change.
 *   reviewFlagged — optional; renders ⚑ flag
 *   onClick       — optional; makes chip clickable
 *   id            — optional HTML id (for canvas wire targeting)
 *   expandedBody  — optional ReactNode. When non-empty, an inline ▸/▾ expand
 *                   chevron is rendered at the trailing edge of the row. Clicking
 *                   it toggles a dashed-left-border body below the row showing
 *                   `expandedBody`. Use this for "I want to see the full details"
 *                   — never for at-a-glance info that should stay visible. Each
 *                   sub-chip family decides when to pass it (typically: when one
 *                   of the rendered values was truncated in the visible row).
 *   children      — chip content after the symbol
 */
export function BaseChangeChip({ action, color, showSymbol = true, onDismiss, onAddKnowledge, reviewFlagged, onClick, id, expandedBody, children, dashedOutline = null, dataHelpRegion = null }) {
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const showExpand = expandedBody !== null && expandedBody !== undefined && expandedBody !== false
  const actionColor = color ?? (ACTION_COLOR[action] || '#a1a1aa')
  // Right padding budget — leaves room for whichever buttons are
  // present without forcing the chip text to wrap. Both buttons + 2px
  // gap need about 36px of clearance.
  const prCls = (onDismiss && onAddKnowledge)
    ? 'pr-[36px]'
    : onDismiss
      ? 'pr-5'
      : onAddKnowledge
        ? 'pr-5'
        : reviewFlagged ? 'pr-4' : 'pr-2'

  const row = (
    <div
      id={id}
      data-help-region={dataHelpRegion || 'change-subchip:base'}
      className={`relative flex items-center gap-1 pl-1.5 ${prCls} py-0.5 rounded text-[9px] select-none${onClick ? ' cursor-pointer' : ''}`}
      style={{
        backgroundColor: actionColor + '18',
        borderLeft: `2px solid ${actionColor}66`,
        ...(dashedOutline ? {
          borderTop: `1px dashed ${dashedOutline}`,
          borderRight: `1px dashed ${dashedOutline}`,
          borderBottom: `1px dashed ${dashedOutline}`,
        } : null),
      }}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {showSymbol && action && (
        <span className="font-bold flex-shrink-0" style={{ color: actionColor }}>{actionSymbol(action)}</span>
      )}
      {children}
      {reviewFlagged && (
        <span
          className="text-sky-400 flex-shrink-0 ml-auto"
          title="Upstream change: this field was modified earlier in the chain. Open Alerts panel to review."
        >⚑</span>
      )}
      {showExpand && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          className="nodrag flex-shrink-0 text-zinc-500 hover:text-zinc-300 leading-none ml-auto"
          style={{ fontSize: 10 }}
          title={expanded ? 'Hide details' : 'Show details'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
      {onAddKnowledge && (
        <button
          className={`nodrag absolute right-[18px] w-3.5 h-3.5 rounded border border-zinc-600 leading-none transition-all hover:!border-green-400 ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ backgroundColor: 'transparent' }}
          onClick={(e) => { e.stopPropagation(); onAddKnowledge(e) }}
          title="Add knowledge of this change"
        >
          <span className="absolute inset-[1px] flex items-center justify-center leading-none" style={{ fontSize: 9 }}>📜</span>
          <span
            className="absolute top-0 left-0 text-green-400 font-bold leading-none"
            style={{ fontSize: 8, lineHeight: 1, textShadow: '0 0 2px #000, 0 0 2px #000' }}
          >✚</span>
        </button>
      )}
      {onDismiss && (
        <button
          className={`nodrag absolute right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded border border-zinc-600 text-red-400 leading-none transition-all hover:!border-red-400 ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ backgroundColor: 'transparent', fontSize: 10, lineHeight: 1 }}
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          title="Remove this change"
        >⚊</button>
      )}
    </div>
  )

  if (!showExpand) return row

  return (
    <div className="select-none">
      {row}
      {expanded && (
        <div
          className="mt-0.5 ml-4 pr-2 text-[10px] text-zinc-300 leading-snug whitespace-pre-wrap break-words"
          style={{ borderLeft: '1px dashed #3f3f46', paddingLeft: 6 }}
        >
          {expandedBody}
        </div>
      )}
    </div>
  )
}
