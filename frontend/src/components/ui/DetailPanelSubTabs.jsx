/**
 * DetailPanelSubTabs — shared sub-tab bar for left-sidebar detail
 * panels (entity / relationship / knowledge). Replaces the three
 * near-identical inline tab-bar JSX blocks the panels each had.
 *
 * Width sizing: each tab's width is proportional to its label's
 * character count divided by the total character count across all
 * tabs. Implemented via `flex-grow: <length>` + `flex-basis: 0` so
 * the bar fills any width the sidebar offers and reflows when the
 * sidebar resizes — no fixed pixel widths.
 *
 * Example: `Details (7) / Attributes (10) / Relationships (13) /
 * Awareness (9)` → 7/39, 10/39, 13/39, 9/39 of the row.
 *
 * Props:
 *   tabs     — string[]; tab ids in render order.
 *   active   — currently-active tab id.
 *   onChange — fired with the next id when a tab is clicked.
 *   labelFor — optional `(id) => label` formatter; defaults to
 *              capitalising the first character of `id`.
 */
export default function DetailPanelSubTabs({ tabs, active, onChange, labelFor }) {
  const formatLabel = labelFor || ((t) => (t.charAt(0).toUpperCase() + t.slice(1)))
  const labels = tabs.map(formatLabel)
  return (
    <div className="flex border-b border-zinc-700 flex-shrink-0" data-help-region="detail-panel:subtabs">
      {tabs.map((t, i) => {
        const label = labels[i]
        const grow = Math.max(1, label.length)
        const isActive = active === t
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{ flexGrow: grow, flexBasis: 0 }}
            className={`py-1.5 text-[10px] transition-colors ${
              isActive
                ? 'text-accent-400 border-b-2 border-accent-400'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
