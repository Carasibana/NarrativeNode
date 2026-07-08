/**
 * Vertical tab-bar primitive used by SettingsPanel (and any future
 * multi-tab container). Renders each tab as a left-aligned button in
 * a column. Active tab gets an accent-coloured left border + filled
 * background; inactive tabs are flat text that highlights on hover.
 *
 * Props:
 *   tabs         — [{ id: string, label: string }]
 *   activeTabId  — string
 *   onTabChange  — (id) => void
 *   className    — optional extra classes for the outer container
 *
 * Keep the component deliberately simple — no dropdown fallback, no
 * horizontal orientation, no keyboard focus ring beyond the browser
 * default. If those needs materialise, add them behind props so the
 * simple call sites don't have to opt in.
 */
export default function TabBar({ tabs, activeTabId, onTabChange, className = '' }) {
  return (
    <div className={`flex flex-col ${className}`} data-help-region="tab-bar:bar">
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTabId
        const stateCls = isActive
          ? 'bg-zinc-700/60 text-zinc-100 border-l-accent-500'
          : 'text-zinc-400 hover:bg-zinc-700/30 hover:text-zinc-200 border-l-transparent'
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            data-help-region={i === 0 ? 'tab-bar:tab' : undefined}
            className={`text-left text-sm px-3 py-2 border-l-2 transition-colors ${stateCls}`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
