import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Shared system-prompt picker list — Phase 2.10a item 6.
 *
 * Renders a filter input + scrollable, category-grouped, collapsible
 * list of system prompts. Used by every surface that picks a system
 * prompt:
 *   - chat panel's Settings popover (`SystemPromptFlyoutBody`)
 *   - Prompt Block gear-icon popover (`PromptBlockSettingsPopover`)
 *   - Summarize-Scene gear popover (when that ships in Phase 2.10a
 *     item 7)
 *
 * Layout mirrors the existing Connection / Model flyout: per-category
 * header (chevron + colour dot + name + count), members listed under
 * each header. Categories start collapsed unless they contain the
 * relevant default for the surface (`defaultPromptId`) or the
 * currently-selected prompt (`activePromptId`) — those open
 * automatically so the writer's current state is visible without
 * an extra click.
 *
 * Filter behaviour: input is shown when total prompts > 8. When the
 * filter is non-empty, all categories with at least one matching
 * prompt expand automatically (overriding the collapsed state); empty
 * categories hide entirely until the filter clears.
 *
 * Props
 *   - `prompts: SystemPrompt[]` — list to render (with `category` set
 *     from the on-disk subfolder by `list_prompts()`).
 *   - `categories: CategoryEntry[]` — known category names + colours
 *     (used for header colour dots; orphan categories with prompts
 *     but no category entry still render).
 *   - `activePromptId: string|null` — currently-selected prompt at the
 *     surface. Drives the ● selection indicator.
 *   - `defaultPromptId: string|null` — relevant default for the
 *     surface (today: the global `default_system_prompt_id`; later:
 *     per-surface from `default_prompts_per_surface`). Used for the
 *     auto-expand-on-mount rule and a star marker on the row.
 *   - `onPick: (id|null) => void` — called when the writer picks a
 *     prompt; `null` clears the selection ("No system prompt").
 *   - `showNoPromptOption: boolean = true` — render the pinned
 *     "No system prompt" row at the top.
 *   - `noPromptLabel: string = 'No system prompt'` — text shown on
 *     the pinned no-prompt row. Story Settings overrides this with
 *     "Use Program Settings" because the row in that context clears
 *     the story-side override back to inherit-from-program-settings,
 *     which is a different semantic from picking an explicit
 *     "no prompt" everywhere else.
 *   - `filterThreshold: number = 0` — only show the filter input when
 *     the prompt count exceeds this. Defaults to 0 (always shown)
 *     because the category-grouped layout makes the filter useful
 *     even at small counts.
 *   - `emptyMessage: string = 'No prompts available.'` — shown when
 *     `prompts` is empty.
 *   - `controlledOpenKey: string|null` — optional. When provided,
 *     the open-category state is owned by the parent. Pass a value
 *     here when the picker is mounted inside a flyout that opens /
 *     closes within a longer-lived parent popover and you want the
 *     last-expanded category to persist across hover open/close
 *     cycles. The parent supplies the slot; this component reads
 *     and writes through `onOpenKeyChange`. When omitted (default)
 *     the component owns its own collapse state internally.
 *   - `onOpenKeyChange: (key|null) => void` — companion to
 *     `controlledOpenKey`. Required when controlled.
 *   - `onSetDefault: (id, event) => void` — optional. When provided,
 *     each prompt row renders a ★/☆ button on the right. Click
 *     toggles "is this prompt the default for THIS surface".
 *     Filled ★ on whichever id matches `defaultPromptId`; hollow
 *     ☆ on the rest. When omitted, the ★ is rendered as a static
 *     read-only marker (no click affordance) on `defaultPromptId`.
 */
export default function SystemPromptPickerList({
  prompts,
  categories,
  activePromptId,
  defaultPromptId,
  onPick,
  showNoPromptOption = true,
  noPromptLabel = 'No system prompt',
  filterThreshold = 0,
  emptyMessage = 'No prompts available.',
  controlledOpenKey,
  onOpenKeyChange,
  onSetDefault,
}) {
  const [filter, setFilter] = useState('')

  // Group prompts by category. Uncategorized (category=null) first,
  // then categories in the order the backend returned them, then any
  // orphan groups whose prompts reference a folder we don't know
  // about (matching the Settings tab's promptGroups builder).
  const groups = useMemo(() => {
    const UNCAT = '__uncategorized__'
    const byCategory = new Map()
    byCategory.set(null, [])
    for (const c of (categories || [])) byCategory.set(c.name, [])
    for (const p of (prompts || [])) {
      const key = p.category || null
      if (!byCategory.has(key)) byCategory.set(key, [])
      byCategory.get(key).push(p)
    }
    const out = []
    const uncategorized = byCategory.get(null) || []
    if (uncategorized.length > 0) {
      out.push({ key: UNCAT, name: null, colour: null, prompts: uncategorized })
    }
    for (const c of (categories || [])) {
      const list = byCategory.get(c.name) || []
      if (list.length === 0) continue
      out.push({ key: c.name, name: c.name, colour: c.colour, prompts: list })
    }
    for (const [key, list] of byCategory.entries()) {
      if (key === null) continue
      if ((categories || []).find((c) => c.name === key)) continue
      out.push({ key, name: key, colour: null, prompts: list, orphan: true })
    }
    return out
  }, [prompts, categories])

  // Determine which category should auto-expand on first render.
  // Only one group is open at a time. Priority: the active
  // selection's category (so the writer sees their current state),
  // falling back to the relevant default's category (so the most
  // likely pick is in view). Keyed by the group `key` (the category
  // name, or the UNCAT sentinel for root prompts).
  const initialOpenKey = useMemo(() => {
    function categoryKeyForPrompt(id) {
      if (id == null) return null
      const found = (prompts || []).find((p) => p.id === id)
      if (!found) return null
      return found.category || '__uncategorized__'
    }
    return categoryKeyForPrompt(activePromptId) || categoryKeyForPrompt(defaultPromptId) || null
  }, [prompts, defaultPromptId, activePromptId])

  // Single-open collapse state. `null` means every group is
  // collapsed. The init ref guards against re-applying the initial
  // pick after the writer's manual toggles. In controlled mode the
  // parent owns the slot — the picker stays a pure read/write of
  // the prop pair.
  const controlled = controlledOpenKey !== undefined
  const [uncontrolledOpenKey, setUncontrolledOpenKey] = useState(initialOpenKey)
  const openKey = controlled ? controlledOpenKey : uncontrolledOpenKey
  const setOpenKey = controlled ? (onOpenKeyChange || (() => {})) : setUncontrolledOpenKey

  const initializedRef = useRef(false)
  useEffect(() => {
    if (initializedRef.current) return
    if ((prompts?.length || 0) === 0 && (categories?.length || 0) === 0) return
    // Initial seed only applies in uncontrolled mode and when the
    // parent hasn't supplied a remembered key — otherwise the
    // parent's controlled value (or the writer's prior choice) wins.
    if (controlled) {
      if (controlledOpenKey == null) onOpenKeyChange?.(initialOpenKey)
    } else {
      setUncontrolledOpenKey(initialOpenKey)
    }
    initializedRef.current = true
  }, [initialOpenKey, prompts, categories, controlled, controlledOpenKey, onOpenKeyChange])

  function toggleGroup(key) {
    // Clicking the open one closes it; clicking a different one
    // switches the single-open slot to it.
    setOpenKey(openKey === key ? null : key)
  }

  // Apply the filter. When filter is active any matching group opens
  // automatically regardless of `openKeys`. Empty groups hide.
  const f = filter.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!f) return groups
    return groups
      .map((g) => ({ ...g, prompts: g.prompts.filter((p) => (p.name || '').toLowerCase().includes(f)) }))
      .filter((g) => g.prompts.length > 0)
  }, [groups, f])

  const total = (prompts || []).length
  const showFilter = total > filterThreshold

  if (total === 0) {
    return (
      <div className="px-2.5 py-2 text-zinc-500 italic">
        {emptyMessage}
      </div>
    )
  }

  return (
    <>
      {showFilter && (
        <div className="px-2 pb-1 sticky top-0 bg-zinc-900 z-10 pt-1 border-b border-zinc-800">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full text-[11px] px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
            onClick={(e) => e.stopPropagation()}
            data-help-region="system-prompt-picker:filter"
          />
        </div>
      )}
      {showNoPromptOption && (
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 cursor-pointer transition-colors ${
            activePromptId == null
              ? 'bg-accent-900/30 text-accent-100'
              : 'text-zinc-200 hover:bg-zinc-800'
          }`}
          onClick={() => onPick(null)}
        >
          <span className="text-[10px] flex-shrink-0 w-3 text-center">{activePromptId == null ? '●' : ''}</span>
          <span className="flex-1 truncate italic">{noPromptLabel}</span>
        </div>
      )}
      {filteredGroups.length === 0 ? (
        <div className="px-2.5 py-2 text-zinc-500 italic">No matches.</div>
      ) : (
        filteredGroups.map((g) => {
          const expanded = f ? true : openKey === g.key
          const colour = g.colour || DEFAULT_COLOUR
          return (
            <div key={g.key} className="py-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(g.key)}
                className="w-full flex items-center gap-1.5 px-2.5 py-0.5 text-left hover:bg-zinc-800/60 transition-colors"
                title={expanded ? 'Collapse' : 'Expand'}
              >
                <span className="text-zinc-400 text-[9px] w-3 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0 border border-zinc-700"
                  style={{ backgroundColor: colour }}
                />
                <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider flex-1 min-w-0 truncate">
                  {g.name === null ? 'Uncategorized' : g.name}
                  {g.orphan && (
                    <span className="ml-1.5 text-[8px] text-amber-300 normal-case tracking-normal italic">
                      (orphan)
                    </span>
                  )}
                </span>
                <span className="text-[9px] text-zinc-500 flex-shrink-0">{g.prompts.length}</span>
              </button>
              {expanded && g.prompts.map((p) => {
                const isActive = activePromptId === p.id
                const isDefault = defaultPromptId === p.id
                return (
                  <div
                    key={p.id}
                    className={`flex items-center gap-1.5 pl-7 pr-2 py-1 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-accent-900/30 text-accent-100'
                        : 'text-zinc-200 hover:bg-zinc-800'
                    }`}
                    onClick={() => onPick(p.id)}
                    title={p.prompt ? p.prompt.slice(0, 200) : '(empty prompt body)'}
                    data-help-region="system-prompt-picker:prompt_row"
                  >
                    <span className="text-[10px] flex-shrink-0 w-3 text-center">{isActive ? '●' : ''}</span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {onSetDefault ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onSetDefault(isDefault ? null : p.id, e) }}
                        title={isDefault
                          ? 'Default system prompt for this surface. Click to clear.'
                          : 'Set as the default system prompt for this surface.'}
                        aria-label={isDefault ? 'Clear default system prompt' : 'Set as default system prompt'}
                        className={`flex-shrink-0 text-[12px] leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 ${
                          isDefault ? 'text-amber-300' : 'text-zinc-600 hover:text-amber-300'
                        }`}
                      >
                        {isDefault ? '★' : '☆'}
                      </button>
                    ) : isDefault && (
                      <span
                        className="text-[10px] text-amber-300 flex-shrink-0"
                        title="Default for this surface"
                        aria-label="Default"
                      >★</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })
      )}
    </>
  )
}

const DEFAULT_COLOUR = '#888888'  // matches backend `categories_service.DEFAULT_COLOUR`
