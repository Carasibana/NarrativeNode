import { useEffect, useMemo, useRef, useState } from 'react'
import CapabilityBadges from './CapabilityBadges'
import { useUiStore } from '../../store/uiStore'

/**
 * Shared connection / model picker — extracted from
 * `ConversationView`'s private `ConnectionModelFlyoutBody` so the
 * Prompt Block gear popover (and any future surface that picks a
 * model) can use the same UI. Same structure as the chat panel:
 * filter input (rendered when total > 8), profile-grouped rows,
 * capability badges, optional "set as default" star button.
 *
 * Props
 *   - `tree: Array<{ profile, models[] }>` — profiles with at least
 *     one model surfaced.
 *   - `activeProfileId`, `activeModel` — currently-selected pair
 *     at the surface; drives the ● active-row indicator.
 *   - `defaultProfileId`, `defaultModel` — relevant default for
 *     the surface; drives the ★ filled-star marker.
 *   - `onPick(profileId, modelId)` — called when a model is picked.
 *   - `onSetDefault(profileId, modelId, event)` — optional. When
 *     omitted, the star button is not rendered (surfaces that
 *     can't set the project-wide default — e.g. PBH gear popover
 *     — should pass nothing here).
 *   - `emptyMessage` — string shown when `tree` is empty AND
 *     `hideSettingsLink` is set. When the link is shown (the default),
 *     the empty state is the single clickable sentence "Open MCP & API
 *     Connections in Settings to configure a connection." which opens
 *     that settings tab.
 *   - `hideSettingsLink` — show the plain `emptyMessage` text instead
 *     of the link (e.g. when the picker is itself rendered inside the
 *     MCP & API Connections tab).
 */
export default function ConnectionModelPickerList({
  tree,
  activeProfileId,
  activeModel,
  defaultProfileId,
  defaultModel,
  onPick,
  onSetDefault,
  emptyMessage = 'No connections configured with selected models.',
  hideSettingsLink = false,
  controlledOpenKey,
  onOpenKeyChange,
}) {
  const [filter, setFilter] = useState('')
  const totalModels = tree.reduce((sum, t) => sum + (t.models?.length || 0), 0)
  const showFilter = totalModels > 8

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return tree
    return tree
      .map(({ profile, models }) => {
        const profileMatch = (profile.name || '').toLowerCase().includes(f)
        const keep = profileMatch ? models : models.filter((m) => m.toLowerCase().includes(f))
        return { profile, models: keep }
      })
      .filter(({ models }) => models.length > 0)
  }, [tree, filter])

  // Determine which profile to auto-expand on first open. Priority:
  // active selection → relevant default. Mirrors the System Prompt
  // picker's behaviour so the writer's current state is visible
  // without an extra click.
  const initialOpenKey = useMemo(() => {
    if (activeProfileId && tree.find((t) => t.profile.id === activeProfileId)) return activeProfileId
    if (defaultProfileId && tree.find((t) => t.profile.id === defaultProfileId)) return defaultProfileId
    return null
  }, [tree, activeProfileId, defaultProfileId])

  // Single-open collapse state. `null` means every group is
  // collapsed. Controlled mode lets the parent (gear popover) hold
  // the slot across flyout hover open/close cycles.
  const controlled = controlledOpenKey !== undefined
  const [uncontrolledOpenKey, setUncontrolledOpenKey] = useState(initialOpenKey)
  const openKey = controlled ? controlledOpenKey : uncontrolledOpenKey
  const setOpenKey = controlled ? (onOpenKeyChange || (() => {})) : setUncontrolledOpenKey

  const initializedRef = useRef(false)
  useEffect(() => {
    if (initializedRef.current) return
    if (tree.length === 0) return
    if (controlled) {
      if (controlledOpenKey == null) onOpenKeyChange?.(initialOpenKey)
    } else {
      setUncontrolledOpenKey(initialOpenKey)
    }
    initializedRef.current = true
  }, [initialOpenKey, tree, controlled, controlledOpenKey, onOpenKeyChange])

  function toggleGroup(key) {
    setOpenKey(openKey === key ? null : key)
  }

  if (tree.length === 0) {
    return (
      <div className="px-2.5 py-2 text-zinc-500 italic">
        {hideSettingsLink ? (
          emptyMessage
        ) : (
          <button
            type="button"
            onClick={() => useUiStore.getState().requestSettingsOpen('mcpApi')}
            className="not-italic text-accent-300 hover:text-accent-200 underline"
          >
            Open MCP &amp; API Connections in Settings to configure a connection.
          </button>
        )}
      </div>
    )
  }

  const f = filter.trim().toLowerCase()

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
            data-help-region="connection-model-picker:filter"
          />
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="px-2.5 py-2 text-zinc-500 italic">No matches.</div>
      ) : (
        filtered.map(({ profile, models }) => {
          // Filter-active mode forces every matching group open so
          // the writer can scan results across connections.
          const expanded = f ? true : openKey === profile.id
          return (
            <div key={profile.id} className="py-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(profile.id)}
                className="w-full flex items-center gap-1.5 px-2.5 py-0.5 text-left hover:bg-zinc-800/60 transition-colors"
                title={expanded ? 'Collapse' : 'Expand'}
              >
                <span className="text-zinc-400 text-[9px] w-3 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
                <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider flex-1 min-w-0 truncate">
                  {profile.name}
                </span>
                <span className="text-[9px] text-zinc-500 flex-shrink-0">{models.length}</span>
              </button>
              {expanded && models.map((modelId) => {
                const isActive = profile.id === activeProfileId && modelId === activeModel
                const isDefault = profile.id === defaultProfileId && modelId === defaultModel
                return (
                  <div
                    key={modelId}
                    className={`flex items-center gap-1.5 pl-7 pr-2 py-1 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-accent-900/30 text-accent-100'
                        : 'text-zinc-200 hover:bg-zinc-800'
                    }`}
                    onClick={() => onPick(profile.id, modelId)}
                    title={`Switch to ${modelId} on connection ${profile.name}.`}
                    data-help-region="connection-model-picker:model_row"
                  >
                    <span className="text-[10px] flex-shrink-0 w-3 text-center">{isActive ? '●' : ''}</span>
                    <span className="flex-1 truncate font-mono">{modelId}</span>
                    <CapabilityBadges capabilities={profile.model_capabilities?.[modelId] || null} />
                    {onSetDefault && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSetDefault(isDefault ? null : profile.id, isDefault ? null : modelId, e)
                        }}
                        title={isDefault
                          ? 'Default model for this surface. Click to clear.'
                          : 'Set as the default model for this surface.'}
                        aria-label={isDefault ? 'Clear default model' : 'Set as default model'}
                        className={`flex-shrink-0 text-[12px] leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 ${
                          isDefault ? 'text-amber-300' : 'text-zinc-600 hover:text-amber-300'
                        }`}
                      >
                        {isDefault ? '★' : '☆'}
                      </button>
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
