import { useCallback, useEffect, useRef, useState } from 'react'
import TabBar from '../ui/TabBar'
import { confirm } from '../../store/dialogStore'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import StorySettingsTab from './tabs/StorySettingsTab'
import StorySeedsTab from './tabs/StorySeedsTab'
import ProgramSettingsTab from './tabs/ProgramSettingsTab'
import McpAndApiConnectionsTab from './tabs/McpAndApiConnectionsTab'
import SystemPromptsTab from './tabs/SystemPromptsTab'
import DefaultSeedsTab from './tabs/DefaultSeedsTab'
import AboutTab from './tabs/AboutTab'
import ThanksTab from './tabs/ThanksTab'

/**
 * Umbrella Settings panel introduced in Phase 1.14 v0.1.14.3; scope
 * split for the seed tabs added in v0.1.14.4; tabs renamed to plain
 * "Story Seeds" / "Default Seeds" in v0.1.14.6 (the old "Seeded
 * Attributes" name under-sold the feature, which manages both
 * attribute stubs AND bundled preset lists). Modal that hosts five
 * tabs on a left sidebar, grouped by scope — per-project tabs first,
 * then user-level tabs, then About:
 *
 *   - Story Settings    — per-project metadata (.nnz).
 *   - Story Seeds       — this project's seeds.json: attribute stubs
 *                          + bundled preset lists (stub).
 *   - Program Settings  — user_preferences.json (stub).
 *   - Default Seeds     — `preferences/default_seeds.json`: template
 *                          that is copied into every new project's
 *                          own seeds.json at creation time (stub).
 *   - About             — logo + version + license + GitHub (stub).
 *
 * The Story / Default Seeds split reflects the two distinct scopes:
 * Story saves into the current project's `.nnz`, Default saves into a
 * local template file. Both use the IDENTICAL `SeedsFile` schema —
 * round-trip import / export works in either direction. The two tabs
 * share the same editor component once wired; only the save target
 * differs.
 *
 * The panel owns the modal chrome (backdrop, title + close button,
 * click-outside / Escape handlers). Each tab component is self-
 * contained and handles its own save/cancel if relevant — e.g. the
 * Story Settings tab keeps its original Save / Cancel footer, and
 * the About tab has no footer at all.
 *
 * Switching tabs while a tab has unsaved local state discards that
 * draft. Acceptable for now (users rarely cross-edit tabs); if this
 * becomes a problem, lift draft state into the panel with a shared
 * dirty guard.
 */
const TABS = [
  { id: 'story', label: 'Story Settings' },
  { id: 'storySeeds', label: 'Story Seeds' },
  { id: 'defaultSeeds', label: 'Default Seeds' },
  { id: 'program', label: 'Program Settings' },
  { id: 'mcpApi', label: 'MCP & API Connections' },
  { id: 'systemPrompts', label: 'System Prompts' },
  { id: 'about', label: 'About' },
  { id: 'thanks', label: 'Thanks' },
]

// Phase 5.7 — tabs hidden when AI integrations are disabled. Module-level
// so the value is stable across renders (no effect-dependency churn).
const AI_TAB_IDS = ['mcpApi', 'systemPrompts']

export default function SettingsPanel({ onClose, initialTabId }) {
  // `initialTabId` lets the caller open the panel on a specific tab —
  // used by the toolbar Import/Export menu's "Import Story Seeds…"
  // entry to drop the user directly into the Story Seeds tab. Falls
  // back to the Story Settings tab (panel default).
  const [activeTabId, setActiveTabId] = useState(initialTabId || 'story')

  // Phase 5.7 — when AI integrations are disabled, drop the AI tabs
  // (MCP & API Connections, System Prompts) from the tab bar. If one
  // of them is somehow the active tab (e.g. opened directly via
  // initialTabId), fall back to Program Settings so the body isn't
  // left blank.
  const aiDisabled = useAiDisabled()
  const visibleTabs = aiDisabled ? TABS.filter((t) => !AI_TAB_IDS.includes(t.id)) : TABS
  useEffect(() => {
    if (aiDisabled && AI_TAB_IDS.includes(activeTabId)) setActiveTabId('program')
  }, [aiDisabled, activeTabId])

  // Per-tab dirty registry — tabs with draft state call
  // `registerTabDirty(tabId, isDirty)` whenever their isDirty flips.
  // Tabs that can save without closing also register a save callback
  // via `registerTabSave(tabId, saveFn)` — the panel calls it from
  // the "Save & continue" branch of the dirty-discard prompt so the
  // user can keep navigating without losing edits.
  // A ref mirror keeps the latest dirty state available inside long-
  // lived event handlers without re-binding listeners on every
  // change. forceTick re-renders so the registered children see the
  // latest snapshot.
  const dirtyRef = useRef({})
  const saveCallbacksRef = useRef({})
  const [, forceTick] = useState(0)
  const registerTabDirty = useCallback((tabId, isDirty) => {
    if (!!dirtyRef.current[tabId] === !!isDirty) return
    if (isDirty) dirtyRef.current[tabId] = true
    else delete dirtyRef.current[tabId]
    forceTick((t) => t + 1)
  }, [])
  const registerTabSave = useCallback((tabId, saveFn) => {
    if (saveFn) saveCallbacksRef.current[tabId] = saveFn
    else delete saveCallbacksRef.current[tabId]
  }, [])

  async function confirmDiscardIfDirty() {
    const dirtyIds = Object.keys(dirtyRef.current)
    if (dirtyIds.length === 0) return true
    const tabLabels = dirtyIds
      .map((id) => TABS.find((t) => t.id === id)?.label || id)
      .join(', ')
    // Only offer "Save & continue" when every dirty tab has a
    // registered save callback. If any dirty tab can't save itself
    // (none currently, but defensible), fall back to the 2-button
    // discard / keep-editing flow.
    const allSavable = dirtyIds.every((id) => typeof saveCallbacksRef.current[id] === 'function')
    const buttons = allSavable
      ? [
          { label: 'Keep editing',        value: 'cancel',  style: 'neutral' },
          { label: 'Discard & continue',  value: 'discard', style: 'danger'  },
          { label: 'Save & continue',     value: 'save',    style: 'primary' },
        ]
      : [
          { label: 'Keep editing',        value: 'cancel',  style: 'neutral' },
          { label: 'Discard & continue',  value: 'discard', style: 'danger'  },
        ]
    const result = await confirm({
      title: 'Unsaved changes',
      message: `You have unsaved changes in ${tabLabels}.`,
      buttons,
    })
    if (result === 'cancel') return false
    if (result === 'save') {
      // Run each dirty tab's save callback. They write the draft to
      // the backend and clear their dirty flag. We then proceed.
      for (const id of dirtyIds) {
        try { saveCallbacksRef.current[id]?.() } catch { /* save shouldn't block navigation */ }
      }
      dirtyRef.current = {}
      forceTick((t) => t + 1)
      return true
    }
    // 'discard'
    dirtyRef.current = {}
    forceTick((t) => t + 1)
    return true
  }

  async function tryClose() {
    if (await confirmDiscardIfDirty()) onClose()
  }

  async function trySwitchTab(nextId) {
    if (nextId === activeTabId) return
    if (await confirmDiscardIfDirty()) setActiveTabId(nextId)
  }

  const panelRef = useRef(null)
  const backdropRef = useRef(null)
  // Close on backdrop click. Earlier versions used a document-level
  // mousedown listener that fired whenever the click landed outside
  // `panelRef`, but that swallowed clicks into stacked modals — e.g.
  // the confirm dialog opened by "Delete connection" — and closed the
  // settings panel before the inner action could finish. Restricting
  // the close trigger to clicks on the settings panel's OWN backdrop
  // (the dim outer wrapper) avoids the conflict; higher-z modals
  // handle their own dismissal.
  function handleBackdropMouseDown(e) {
    if (e.target === backdropRef.current) tryClose()
  }

  // Close on Escape
  useEffect(() => {
    function handler(e) {
      if (e.key === 'Escape') tryClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={panelRef}
        data-help-region="settings:modal"
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[760px] max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button onClick={tryClose} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>

        {/* Body: left tab sidebar + right tab content */}
        <div className="flex flex-1 min-h-0">
          <div data-help-region="settings:tab_bar" className="w-[180px] border-r border-zinc-700 py-2 flex-shrink-0">
            <TabBar
              tabs={visibleTabs}
              activeTabId={activeTabId}
              onTabChange={trySwitchTab}
            />
          </div>
          <div data-help-region="settings:body" className="flex-1 min-w-0">
            {activeTabId === 'story' && <StorySettingsTab
              onClose={onClose}
              onDirtyChange={(d) => registerTabDirty('story', d)}
              registerSave={(fn) => registerTabSave('story', fn)}
            />}
            {activeTabId === 'storySeeds' && <StorySeedsTab />}
            {activeTabId === 'program' && <ProgramSettingsTab
              onClose={onClose}
              onDirtyChange={(d) => registerTabDirty('program', d)}
              registerSave={(fn) => registerTabSave('program', fn)}
            />}
            {!aiDisabled && activeTabId === 'mcpApi' && <McpAndApiConnectionsTab
              onClose={onClose}
              onDirtyChange={(d) => registerTabDirty('mcpApi', d)}
              registerSave={(fn) => registerTabSave('mcpApi', fn)}
            />}
            {!aiDisabled && activeTabId === 'systemPrompts' && <SystemPromptsTab
              onClose={onClose}
              onDirtyChange={(d) => registerTabDirty('systemPrompts', d)}
              registerSave={(fn) => registerTabSave('systemPrompts', fn)}
            />}
            {activeTabId === 'defaultSeeds' && <DefaultSeedsTab />}
            {activeTabId === 'about' && <AboutTab />}
            {activeTabId === 'thanks' && <ThanksTab />}
          </div>
        </div>
      </div>
    </div>
  )
}
