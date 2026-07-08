import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useSettingsStore } from '../../../store/settingsStore'
import { confirm } from '../../../store/dialogStore'
import ToggleInput from '../../ui/ToggleInput'
import SettingsTabFooter from './SettingsTabFooter'
import CapabilityBadges from '../../ui/CapabilityBadges'
import PopoverSectionRow from '../../ui/PopoverSectionRow'
import ConnectionModelPickerList from '../../ui/ConnectionModelPickerList'
import { API_TYPE_OPTIONS, isLocalOrPrivateHost } from '../../../utils/toolUseStatus'

/**
 * MCP & API Connections tab — Phase 2.3b / 2.3c.
 *
 * Single home for everything that talks to an outside connection.
 * Three sections:
 *
 *   Section A -- MCP Server
 *     Relocated wholesale from the Program Settings tab. The MCP
 *     auto-start toggle keeps its existing semantics (persistent
 *     default consulted at launch; the runtime override lives in
 *     the toolbar MCP control popover and does not write back here).
 *
 *   Section B -- AI Provider Connections (Phase 2.3c)
 *     Saved AI provider profiles. Each profile expands into an edit
 *     form with name / API type / base URL / optional API key, plus
 *     placeholder slots for the model discovery (Phase 2.3c step 3)
 *     and connection test (Phase 2.3d) work that comes next.
 *     The API key is OPTIONAL throughout -- local endpoints (LM
 *     Studio, Ollama) do not require auth, and the connection code
 *     omits the Authorization header entirely when the key is empty.
 *
 *   Section C -- System Prompts (Phase 2.3e placeholder)
 *     Fleshed out later.
 *
 * Mirrors the StorySettingsTab / ProgramSettingsTab draft pattern:
 * field edits accumulate locally; Save commits to the backend via
 * the settings store, Cancel discards and closes.
 */
function shallowEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

const sectionCls    = 'rounded border border-zinc-700/60 bg-zinc-900/40 px-4 py-3 space-y-3'
const sectionHdrCls = 'text-[11px] font-semibold text-zinc-300 uppercase tracking-wider pb-1 mb-2 border-b border-zinc-700/60'
const labelCls      = 'text-[11px] text-zinc-400'
const inputCls      = 'w-full bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500'
const selectCls     = inputCls + ' appearance-none'

// API_TYPE_OPTIONS + isLocalOrPrivateHost now live in
// utils/toolUseStatus.js (imported above) so the chat composer's
// tool-use button shares the exact same capability rules.

// Sensible defaults seeded when the writer picks an API type. Writer
// can edit; these are starting points, not enforced. LM Studio
// default port is 1234; Ollama uses 11434; OpenRouter / OpenAI /
// Anthropic use their official cloud URLs.
const DEFAULT_BASE_URL_BY_API_TYPE = {
  lmstudio_rest_v1:   'http://localhost:1234',
  openai_compatible: 'http://localhost:11434',
  openrouter:        'https://openrouter.ai/api',
  anthropic:         'https://api.anthropic.com',
}

// Default display name used when the writer first picks this API
// type for a connection (or when they switch a "New connection" /
// generic-named profile over to it). Only applied when the current
// name is still the blank-form default or matches the previous
// type's preset name — never when the writer has typed something
// custom. Empty string = no auto-fill, keep whatever's there.
const DEFAULT_NAME_BY_API_TYPE = {
  lmstudio_rest_v1:  '',
  openai_compatible: '',
  openrouter:        'OpenRouter',
  anthropic:         '',
}

function newProfileId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'profile_' + Math.random().toString(36).slice(2, 10)
}

function newBlankProfile() {
  return {
    id: newProfileId(),
    name: 'New connection',
    api_type: 'openai_compatible',
    base_url: DEFAULT_BASE_URL_BY_API_TYPE.openai_compatible,
    api_key: null,
    selected_models: [],
    manually_added_models: [],
    last_used_model: null,
    lmstudio_mcp_enabled: null,
    lmstudio_plugin_detected: null,
  }
}

export default function McpAndApiConnectionsTab({ onClose, onDirtyChange, registerSave }) {
  const loaded    = useSettingsStore((s) => s.loaded)
  const loadError = useSettingsStore((s) => s.loadError)
  const loading   = useSettingsStore((s) => s.loading)
  const saveError = useSettingsStore((s) => s.saveError)
  const prefs     = useSettingsStore((s) => s.preferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)

  const [draft, setDraft] = useState(prefs)
  useEffect(() => { setDraft(prefs) }, [prefs])

  const isDirty = !shallowEqual(draft, prefs)
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => { onDirtyChangeRef.current?.(isDirty) }, [isDirty])
  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  function commit(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  function saveDraft() {
    updatePreferences(draft)
    onDirtyChangeRef.current?.(false)
  }
  const saveDraftRef = useRef(saveDraft)
  saveDraftRef.current = saveDraft
  const registerSaveRef = useRef(registerSave)
  useEffect(() => { registerSaveRef.current = registerSave }, [registerSave])
  useEffect(() => {
    registerSaveRef.current?.(() => saveDraftRef.current?.())
    return () => registerSaveRef.current?.(null)
  }, [])

  function handleSave() {
    // Commit only — Save no longer closes the panel. The writer
    // stays on the tab to keep editing or browse other tabs. Close
    // paths remain Cancel / Esc / the X in the panel header.
    updatePreferences(draft)
    onDirtyChange?.(false)
  }
  function handleCancel() {
    onDirtyChange?.(false)
    onClose?.()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <ScopeBanner />

        {loadError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            Couldn&apos;t load user preferences: {loadError}
          </div>
        )}
        {saveError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            Couldn&apos;t save: {saveError}
          </div>
        )}
        {!loaded && !loadError && loading && (
          <div className="text-xs text-zinc-500">Loading preferences…</div>
        )}

        {loaded && (
          <>
            <McpServerSection prefs={draft} commit={commit} />
            <AiProviderConnectionsSection prefs={draft} commit={commit} />
            <DefaultModelPerSurfaceSection prefs={draft} commit={commit} />
            <ToolCallDetailSection prefs={draft} commit={commit} />
          </>
        )}
      </div>

      <SettingsTabFooter isDirty={isDirty} onSave={handleSave} onCancel={handleCancel} />
    </div>
  )
}

// ── Section A: MCP Server ────────────────────────────────────────
function McpServerSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:mcp_server" className={sectionCls}>
      <header className={sectionHdrCls}>MCP Server</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        MCP (Model Context Protocol) is a standard that lets AI assistants and other tools, like Claude Desktop, connect to an app and use its features. NarrativeNode can run a small local server those tools connect to, letting them read your story and make changes for you (creating scenes, characters, relationships, and so on) using NarrativeNode&rsquo;s own tools. It only accepts connections from this computer, never the internet.
      </p>
      <p className="text-[11px] text-zinc-500 leading-relaxed mt-1.5">
        This setting controls whether that server starts automatically when NarrativeNode launches. You can also turn it on or off any time from the MCP button in the toolbar, but that toolbar switch only affects the current session and won&rsquo;t change this saved setting.
      </p>

      <div className="flex items-center gap-2">
        <ToggleInput
          value={prefs.mcp_auto_start}
          defaultValue={false}
          onLabel="Start MCP server automatically on launch"
          offLabel="Don't start MCP server automatically on launch"
          onCommit={(v) => commit('mcp_auto_start', v)}
        />
        {prefs.mcp_auto_start != null && (
          <ResetBtn onClick={() => commit('mcp_auto_start', null)} />
        )}
      </div>
    </section>
  )
}

// ── Section C: Tool-call chip detail level ───────────────────────
//
// Phase 2.4 — controls how the inline tool-call chips under
// streaming / saved assistant messages render. "Name only" shows
// just the tool name + status (running / success / failure).
// "Full" makes the chip expandable so the writer can audit the
// exact arguments JSON the model sent and the raw text the tool
// returned. Stored on user_preferences as `tool_call_detail` so
// the choice is global across every connection.
// ── Phase 2.10a item 11 — Default Connection / Model per Surface ─
// Sibling of the prompts-side section in the System Prompts tab.
// Four horizontal columns, one per surface (chat panel / scene
// description summary / section PBH / inline PB). Each column shows
// the surface label, the currently-selected default's model id (or
// "No default"), and on hover opens the bespoke
// `<ConnectionModelPickerList>` flyout — same picker used by every
// surface's gear/settings popover.
//
// Writes go through `updatePreferences` directly (immediate, no
// batched save) so the change takes effect right away.
// Two-row layout matching the System Prompts tab: row 1 = Chat Panel
// + Character Chat (centred); row 2 = Scene Description, Section
// Prompt, Inline Prompt. Rendered via a 6-column grid with col-span-2
// per cell; the top row's first cell is `col-start-2` to centre.
const MODEL_SURFACES_TOP = [
  { key: 'chat_panel',     label: 'Chat Panel' },
  { key: 'character_chat', label: 'Character Chat' },
]
const MODEL_SURFACES_BOTTOM = [
  { key: 'scene_description_pbh', label: 'Scene Description' },
  { key: 'section_pbh',           label: 'Section Prompt' },
  { key: 'ipb',                   label: 'Inline Prompt' },
]
const MODEL_SURFACES = [...MODEL_SURFACES_TOP, ...MODEL_SURFACES_BOTTOM]

function DefaultModelPerSurfaceSection({ prefs, commit }) {
  // Build the (profile, models[]) tree for the picker. Same shape
  // every other ConnectionModelPickerList consumer uses; profiles
  // with no surfaced models are dropped.
  const tree = useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    return profiles
      .map((profile) => {
        const selected = profile.selected_models || []
        const manual = profile.manually_added_models || []
        const models = Array.from(new Set([...selected, ...manual]))
        return { profile, models }
      })
      .filter(({ models }) => models.length > 0)
  }, [prefs?.ai_provider_profiles])

  // Shared hover-flyout state across the four columns — only one
  // open at a time. 500ms close grace mirrors the chat panel + PBH
  // gear popover.
  const [hoverFlyout, setHoverFlyout] = useState(null)
  const closeTimerRef = useRef(null)
  function openFlyout(key) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setHoverFlyout(key)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setHoverFlyout(null)
      closeTimerRef.current = null
    }, 500)
  }

  // Per-surface remembered-open-profile so the writer's last
  // expanded profile persists across hover open / close cycles.
  const [openKeys, setOpenKeys] = useState({
    chat_panel: null,
    scene_description_pbh: null,
    section_pbh: null,
    ipb: null,
    character_chat: null,
  })
  function setOpenKey(surfaceKey, next) {
    setOpenKeys((prev) => ({ ...prev, [surfaceKey]: next }))
  }

  function setSurfaceModelDefault(surfaceKey, profileId, modelId) {
    // Edits accumulate in the tab's draft via `commit`; nothing
    // hits the backend until the writer presses Save.
    const slotValue = (profileId && modelId) ? { profile_id: profileId, model: modelId } : null
    const next = { ...(prefs?.default_models_per_surface || {}), [surfaceKey]: slotValue }
    commit('default_models_per_surface', next)
    if (surfaceKey === 'chat_panel') {
      // Mirror into the legacy globals for one-cycle backward
      // compat. Both fields are part of the same draft snapshot
      // and flush together on Save.
      commit('ai_default_profile_id', profileId || null)
      commit('ai_default_model', slotValue)
    }
    // Picking a default is a definitive action — close the flyout
    // so the writer sees the new selection on the column row
    // without having to dismiss it manually.
    setHoverFlyout(null)
  }

  return (
    <section data-help-region="settings:mcp_default_model_per_surface" className={sectionCls}>
      <header className={sectionHdrCls}>Default Connection / Model per Surface</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Each of the four AI-aware surfaces in NarrativeNode picks up this default model when its picker opens. Surfaces can still override per-session via their own gear / Settings popovers. Click any column to change the default; click the currently-selected row again to clear it.
      </p>
      <div className="grid grid-cols-6 gap-2">
        {MODEL_SURFACES_TOP.map((s, i) => {
          const pair = prefs?.default_models_per_surface?.[s.key] ?? null
          const profileObj = pair ? tree.find((t) => t.profile.id === pair.profile_id)?.profile : null
          const stale = pair != null && (!profileObj || !tree.find((t) => t.profile.id === pair.profile_id)?.models?.includes(pair.model))
          const value = pair == null ? 'No default' : pair.model
          const secondary = pair == null ? null : (profileObj?.name || null)
          return (
            <div key={s.key} className={`col-span-2 ${i === 0 ? 'col-start-2' : ''}`}>
              <PopoverSectionRow
                label={s.label}
                value={value}
                secondary={stale ? 'Model is no longer configured.' : secondary}
                isOpen={hoverFlyout === s.key}
                onEnter={() => openFlyout(s.key)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={300}
                flyoutDataAttr="default-model-flyout"
                hideChevron
                centerContent
                trigger="click"
              >
                <ConnectionModelPickerList
                  tree={tree}
                  hideSettingsLink
                  activeProfileId={pair?.profile_id || null}
                  activeModel={pair?.model || null}
                  defaultProfileId={pair?.profile_id || null}
                  defaultModel={pair?.model || null}
                  onPick={(pId, m) => {
                    const isCurrent = pair?.profile_id === pId && pair?.model === m
                    setSurfaceModelDefault(s.key, isCurrent ? null : pId, isCurrent ? null : m)
                  }}
                  controlledOpenKey={openKeys[s.key]}
                  onOpenKeyChange={(k) => setOpenKey(s.key, k)}
                />
              </PopoverSectionRow>
            </div>
          )
        })}
        {MODEL_SURFACES_BOTTOM.map((s) => {
          const pair = prefs?.default_models_per_surface?.[s.key] ?? null
          const profileObj = pair ? tree.find((t) => t.profile.id === pair.profile_id)?.profile : null
          const stale = pair != null && (!profileObj || !tree.find((t) => t.profile.id === pair.profile_id)?.models?.includes(pair.model))
          const value = pair == null ? 'No default' : pair.model
          const secondary = pair == null ? null : (profileObj?.name || null)
          return (
            <div key={s.key} className="col-span-2">
              <PopoverSectionRow
                label={s.label}
                value={value}
                secondary={stale ? 'Model is no longer configured.' : secondary}
                isOpen={hoverFlyout === s.key}
                onEnter={() => openFlyout(s.key)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={300}
                flyoutDataAttr="default-model-flyout"
                hideChevron
                centerContent
                trigger="click"
              >
                <ConnectionModelPickerList
                  tree={tree}
                  hideSettingsLink
                  activeProfileId={pair?.profile_id || null}
                  activeModel={pair?.model || null}
                  defaultProfileId={pair?.profile_id || null}
                  defaultModel={pair?.model || null}
                  onPick={(pId, m) => {
                    const isCurrent = pair?.profile_id === pId && pair?.model === m
                    setSurfaceModelDefault(s.key, isCurrent ? null : pId, isCurrent ? null : m)
                  }}
                  controlledOpenKey={openKeys[s.key]}
                  onOpenKeyChange={(k) => setOpenKey(s.key, k)}
                />
              </PopoverSectionRow>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ToolCallDetailSection({ prefs, commit }) {
  const value = prefs.tool_call_detail || 'name'
  return (
    <section data-help-region="settings:mcp_tool_call_detail" className={sectionCls}>
      <header className={sectionHdrCls}>Tool-call chip detail</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        When the AI uses an MCP tool during a chat reply, each invocation appears as a chip under the assistant message. This setting controls how much information those chips reveal.
      </p>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="radio"
            name="tool_call_detail"
            value="name"
            checked={value === 'name'}
            onChange={() => commit('tool_call_detail', null)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-zinc-100">Name only (default)</div>
            <div className="text-[11px] text-zinc-500 leading-relaxed">Chip shows the tool name and status (running, success, or failure). Failure chips also surface the failure reason.</div>
          </div>
        </label>
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="radio"
            name="tool_call_detail"
            value="full"
            checked={value === 'full'}
            onChange={() => commit('tool_call_detail', 'full')}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-zinc-100">Full detail (expandable)</div>
            <div className="text-[11px] text-zinc-500 leading-relaxed">Chip becomes clickable. Expanding reveals the arguments JSON the model sent and the raw tool output, so you can audit exactly what the AI saw.</div>
          </div>
        </label>
      </div>
    </section>
  )
}

// ── Section B: AI Provider Connections ───────────────────────────
function AiProviderConnectionsSection({ prefs, commit }) {
  const profiles = prefs.ai_provider_profiles || []
  const defaultProfileId = prefs.ai_default_profile_id || null
  const defaultModel = prefs.ai_default_model || null
  // Track which profile is currently expanded. Starts at `null` so
  // every profile is collapsed when the tab opens — writers usually
  // want to scan the list before drilling into one.
  const [expandedId, setExpandedId] = useState(null)
  // If the expanded profile was just deleted, fall back to nothing
  // (rather than auto-expanding a sibling — keeps the collapse-by-
  // default contract honest).
  useEffect(() => {
    if (expandedId && !profiles.find((p) => p.id === expandedId)) {
      setExpandedId(null)
    }
  }, [profiles, expandedId])

  function updateProfile(id, patch) {
    commit('ai_provider_profiles', profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }
  function addProfile() {
    const next = newBlankProfile()
    commit('ai_provider_profiles', [...profiles, next])
    setExpandedId(next.id)
  }
  async function deleteProfile(id) {
    const profile = profiles.find((p) => p.id === id)
    const label = profile?.name || 'this connection'
    const ok = await confirm({
      title: 'Delete connection',
      message: `Delete "${label}"? Saved models and other details for this connection will be lost.`,
      buttons: [
        { label: 'Cancel',  value: false, style: 'neutral' },
        { label: 'Delete',  value: true,  style: 'danger' },
      ],
    })
    if (!ok) return
    const nextProfiles = profiles.filter((p) => p.id !== id)
    commit('ai_provider_profiles', nextProfiles)
    // Clear the default pointer if it was pointing at this profile.
    if (defaultProfileId === id) {
      commit('ai_default_profile_id', null)
    }
    // Clear the global default-model pointer if it referenced this
    // profile.
    if (defaultModel?.profile_id === id) {
      commit('ai_default_model', null)
    }
  }
  // Set the global default to (this connection, this model). Sets
  // BOTH `ai_default_profile_id` AND `ai_default_model` so callers
  // don't have to think about the two pointers as separate concepts.
  // Passing `null` for `modelId` clears both pointers when they
  // referenced this connection.
  function setDefaultModel(profileId, modelId) {
    if (modelId == null) {
      // Clear default if it was pointing at this connection.
      if (defaultProfileId === profileId) commit('ai_default_profile_id', null)
      if (defaultModel?.profile_id === profileId) commit('ai_default_model', null)
      return
    }
    commit('ai_default_profile_id', profileId)
    commit('ai_default_model', { profile_id: profileId, model: modelId })
  }

  return (
    <section data-help-region="settings:mcp_connections" className={sectionCls}>
      <header className={sectionHdrCls}>AI Provider Connections</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Saved AI provider connections. Each connection holds a name, API type, base URL, and an <span className="italic">optional</span> API key (whether one is required depends on the endpoint). Configure a connection here, then pick its models from the chat panel.
      </p>

      {profiles.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-700 bg-zinc-900/40 px-3 py-4 text-[11px] text-zinc-500 text-center">
          No connections configured yet. Click <span className="font-semibold text-zinc-300">Add connection</span> to add your first one.
        </div>
      ) : (
        <ul className="space-y-2">
          {profiles.map((profile) => {
            const isThisDefault = defaultProfileId === profile.id
            const thisDefaultModelId = (defaultModel && defaultModel.profile_id === profile.id) ? defaultModel.model : null
            return (
              <ProfileCard
                key={profile.id}
                profile={profile}
                expanded={expandedId === profile.id}
                onExpand={() => setExpandedId(expandedId === profile.id ? null : profile.id)}
                onUpdate={(patch) => updateProfile(profile.id, patch)}
                onDelete={() => deleteProfile(profile.id)}
                isDefault={isThisDefault}
                defaultModelId={thisDefaultModelId}
                onSetDefaultModel={(modelId) => setDefaultModel(profile.id, modelId)}
              />
            )
          })}
        </ul>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={addProfile}
          data-help-region="settings:mcp_add_connection"
          className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded transition-colors"
        >
          + Add connection
        </button>
      </div>
    </section>
  )
}

function ProfileCard({ profile, expanded, onExpand, onUpdate, onDelete, isDefault, defaultModelId, onSetDefaultModel }) {
  return (
    <li data-help-region="settings:mcp_connection_card" className="rounded border border-zinc-700 bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={onExpand}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-zinc-800/60 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-zinc-400 text-[10px] w-3">{expanded ? '▾' : '▸'}</span>
          <span className="text-xs text-zinc-100 font-medium truncate">{profile.name || 'Untitled connection'}</span>
          {isDefault && (
            <span
              className="text-[9px] text-amber-300 border border-amber-700/60 rounded px-1.5 py-0.5 max-w-[160px] truncate"
              title={defaultModelId ? `Default model: ${defaultModelId}` : 'Default connection'}
            >
              ★ default{defaultModelId ? ` · ${defaultModelId}` : ''}
            </span>
          )}
          <span className="text-[10px] text-zinc-500 truncate">{profile.base_url}</span>
        </div>
        <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0">
          {API_TYPE_OPTIONS.find((o) => o.value === profile.api_type)?.label || profile.api_type}
        </span>
      </button>
      {expanded && (
        <div className="px-3 py-3 border-t border-zinc-700 space-y-3 bg-zinc-900/20">
          <ProfileEditForm
            profile={profile}
            onUpdate={onUpdate}
            onDelete={onDelete}
            defaultModelId={defaultModelId}
            onSetDefaultModel={onSetDefaultModel}
          />
        </div>
      )}
    </li>
  )
}

// Inline note below the Base URL field, shown for a short window
// after the backend trims a writer-pasted URL (typically a paste of
// the full chat-completions endpoint or a trailing `/v1`). The
// notice teaches the convention — adapters append the path
// themselves, so the base URL should end at the host — and clears
// itself after a few seconds so it doesn't linger forever in the
// form. The trim list comes from the settings store and is
// repopulated on every save.
function BaseUrlTrimNotice({ profileId }) {
  const trims = useSettingsStore((s) => s.lastBaseUrlNormalisations)
  const trim = (trims || []).find((t) => t.profile_id === profileId)
  const [visible, setVisible] = useState(false)
  // Show the notice when a fresh trim lands for this profile, then
  // auto-clear after 12s so it doesn't haunt the form. Clears earlier
  // if a subsequent save replaces or drops the trim.
  useEffect(() => {
    if (!trim) {
      setVisible(false)
      return undefined
    }
    setVisible(true)
    const handle = window.setTimeout(() => setVisible(false), 12000)
    return () => window.clearTimeout(handle)
  }, [trim?.profile_id, trim?.old_base_url, trim?.new_base_url])
  if (!visible || !trim) return null
  return (
    <div className="mt-1 text-[10px] text-sky-200 border border-sky-700/50 bg-sky-900/20 rounded px-2 py-1 leading-relaxed">
      We trimmed your URL from{' '}
      <code className="px-1 py-0.5 bg-zinc-800 rounded text-[9px] text-zinc-300">{trim.old_base_url}</code>{' '}
      to{' '}
      <code className="px-1 py-0.5 bg-zinc-800 rounded text-[9px] text-zinc-100">{trim.new_base_url}</code>{' '}
      so the adapter doesn&apos;t duplicate the path when it appends its own.
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="ml-1 text-sky-400 hover:text-sky-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}


const MCP_JSON_EXAMPLE = `{
  "mcpServers": {
    "narrativenode": {
      "url": "http://127.0.0.1:13316/mcp/server/"
    }
  }
}`

// Shown under the (disabled) tool toggle on a local LM Studio REST v1
// connection: explains why tool access is off there and how to turn it
// on (register the local mcp.json plugin named `narrativenode`, then
// Test Connection), plus the OpenAI-compatible alternative. The
// `mcp.json` text reveals the exact config on hover / click.
function LmStudioToolAccessNotice({ notFound }) {
  const [showCfg, setShowCfg] = useState(false)
  const [copied, setCopied] = useState(false)
  const closeTimerRef = useRef(null)
  const copiedTimerRef = useRef(null)
  const openCfg = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    setShowCfg(true)
  }
  // Delay the close so the writer can move the cursor off "mcp.json"
  // and onto the popup (e.g. to reach the copy button) without it
  // vanishing. Re-entering either the text or the popup cancels it.
  const scheduleCloseCfg = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setShowCfg(false), 250)
  }
  const copyCfg = (e) => {
    e?.stopPropagation?.()
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(MCP_JSON_EXAMPLE).then(() => {
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
  }, [])
  return (
    <div className="mt-1 text-[10px] leading-relaxed text-amber-300/90 bg-amber-900/10 border border-amber-800/40 rounded px-2 py-1.5 space-y-1">
      <div>
        {notFound
          ? 'NarrativeNode is not registered as an MCP plugin in this LM Studio. '
          : 'LM Studio blocks tool access over its API to a server on a local or private address. '}
        To use its tools here, add NarrativeNode to LM Studio&rsquo;s{' '}
        <span
          className="relative underline decoration-dotted cursor-pointer text-amber-200"
          onMouseEnter={openCfg}
          onMouseLeave={scheduleCloseCfg}
          onClick={copyCfg}
          title="Click to copy the configuration"
        >
          mcp.json
          {showCfg && (
            <span
              className="absolute left-0 top-full z-50 mt-1 w-[290px] rounded border border-zinc-600 bg-zinc-900 p-2 shadow-lg font-normal text-left"
              style={{ display: 'block' }}
              onMouseEnter={openCfg}
              onMouseLeave={scheduleCloseCfg}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="block text-[9px] text-zinc-400 mb-1">Add to LM Studio&rsquo;s mcp.json:</span>
              <span className="block text-[9px] text-zinc-200 font-mono" style={{ whiteSpace: 'pre' }}>{MCP_JSON_EXAMPLE}</span>
              <button
                type="button"
                onClick={copyCfg}
                className="mt-1.5 w-full text-[9px] px-1.5 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </button>
            </span>
          )}
        </span>{' '}
        named <span className="text-amber-200 font-mono">narrativenode</span>. Then click{' '}
        <span className="text-amber-200">Test Connection</span> below to re-check, if the plugin is
        found, this toggle unlocks.
      </div>
      <div className="text-zinc-400">
        Or use an <span className="text-zinc-300">OpenAI-compatible</span> connection to this same LM Studio. It does tool calls a different way that works on local addresses.
      </div>
    </div>
  )
}

function ProfileEditForm({ profile, onUpdate, onDelete, defaultModelId, onSetDefaultModel }) {
  // LM Studio (REST v1) on a local/private address can't use the remote
  // MCP path; tool access there needs the local `mcp/narrativenode`
  // plugin in LM Studio's mcp.json, verified by the Test-Connection
  // probe. Until that probe confirms it (`lmstudio_plugin_detected ===
  // true`), the tool toggle is forced off and disabled.
  const isLmStudioLocal = profile.api_type === 'lmstudio_rest_v1' && isLocalOrPrivateHost(profile.base_url)
  const toolToggleBlocked = isLmStudioLocal && profile.lmstudio_plugin_detected !== true
  // Force the flag off whenever the toggle is blocked so a stale "on"
  // never makes the adapter send the (rejected) integration.
  useEffect(() => {
    if (toolToggleBlocked && profile.mcp_enabled) onUpdate({ mcp_enabled: false })
  }, [toolToggleBlocked, profile.mcp_enabled, onUpdate])

  return (
    <>
      <div>
        <label className={`${labelCls} block mb-1`}>Name</label>
        <TextInput value={profile.name} onCommit={(v) => onUpdate({ name: v || 'Untitled connection' })} placeholder="e.g. Local LM Studio" />
      </div>

      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div data-help-region="settings:mcp_api_type">
          <label className={`${labelCls} block mb-1`}>API type</label>
          <select
            value={profile.api_type}
            onChange={(e) => {
              const nextType = e.target.value
              // Auto-swap the base URL when the current value still
              // matches the previous type's default — writer hasn't
              // touched it yet, so we can move them to the new
              // default. If they've typed something custom we leave
              // it alone (URL normalisation on save / 404 retry will
              // catch obvious mistakes).
              const prevBaseDefault = DEFAULT_BASE_URL_BY_API_TYPE[profile.api_type]
              const nextBaseUrl =
                profile.base_url === prevBaseDefault
                  ? DEFAULT_BASE_URL_BY_API_TYPE[nextType]
                  : profile.base_url
              // Same idea for the name: when it's still the blank
              // form default ("New connection") OR matches the
              // previous type's preset display name, swap to the
              // new type's preset name. A writer-typed custom name
              // is preserved. This is what lights up "OpenRouter"
              // automatically when the writer picks that api_type.
              const prevNameDefault = DEFAULT_NAME_BY_API_TYPE[profile.api_type] || ''
              const nextNameDefault = DEFAULT_NAME_BY_API_TYPE[nextType] || ''
              const currentNameLooksGeneric =
                !profile.name ||
                profile.name === 'New connection' ||
                (prevNameDefault && profile.name === prevNameDefault)
              const nextName = (nextNameDefault && currentNameLooksGeneric)
                ? nextNameDefault
                : profile.name
              // Reset the LM Studio plugin-probe result on any api type
              // change — a different api type / server needs re-probing.
              const patch = { api_type: nextType, base_url: nextBaseUrl, name: nextName, lmstudio_plugin_detected: null }
              // When switching to / from an MCP-supporting type,
              // clear the mcp_enabled flag if the new type doesn't
              // support it — keeps the writer's intent visible and
              // prevents a stale "on" flag from confusing them.
              const nextOpt = API_TYPE_OPTIONS.find((o) => o.value === nextType)
              if (nextOpt && !nextOpt.supports_mcp && profile.mcp_enabled) {
                patch.mcp_enabled = false
              }
              onUpdate(patch)
            }}
            className={selectCls}
          >
            {API_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div data-help-region="settings:mcp_base_url">
          <label className={`${labelCls} block mb-1`}>Base URL</label>
          <TextInput value={profile.base_url} onCommit={(v) => onUpdate({ base_url: v || '', lmstudio_plugin_detected: null })} placeholder="http://localhost:1234" />
          <BaseUrlTrimNotice profileId={profile.id} />
        </div>
      </div>

      <div data-help-region="settings:mcp_api_key">
        <label className={`${labelCls} block mb-1`}>
          API Key <span className="text-zinc-600">(optional here; some endpoints require one)</span>
        </label>
        <ApiKeyInput value={profile.api_key} onCommit={(v) => onUpdate({ api_key: v })} />
      </div>

      {API_TYPE_OPTIONS.find((o) => o.value === profile.api_type)?.supports_mcp && (
        <div data-help-region="settings:mcp_tool_access">
          <label
            className={`${labelCls} block mb-1`}
            title={
              profile.api_type === 'openrouter'
                ? "When on, models can call NarrativeNode's tools during chat. OpenRouter executes calls server-side and folds results into the reply."
                : "When on, models can call NarrativeNode's tools during chat. NarrativeNode runs each call locally and feeds the result back, so the model never connects to your tool server."
            }
          >
            Allow Tool access via API
          </label>
          <ToggleInput
            value={toolToggleBlocked ? false : !!profile.mcp_enabled}
            defaultValue={false}
            onLabel="Enabled"
            offLabel="Disabled"
            disabled={toolToggleBlocked}
            onCommit={(v) => onUpdate({ mcp_enabled: v })}
          />
          {isLmStudioLocal && profile.lmstudio_plugin_detected !== true ? (
            <LmStudioToolAccessNotice notFound={profile.lmstudio_plugin_detected === false} />
          ) : (
            <p className="text-[10px] text-zinc-500 mt-1">
              Lets models call NarrativeNode tools during chat.
            </p>
          )}

          {!toolToggleBlocked && profile.mcp_enabled && (
            <MaxToolRoundsSlider
              value={profile.mcp_max_tool_rounds}
              onCommit={(v) => onUpdate({ mcp_max_tool_rounds: v })}
            />
          )}
        </div>
      )}

      <ModelsSubsection
        profile={profile}
        onUpdate={onUpdate}
        defaultModelId={defaultModelId}
        onSetDefaultModel={onSetDefaultModel}
      />

      <TestConnectionRow profile={profile} onUpdate={onUpdate} />

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          data-help-region="settings:mcp_delete_connection"
          className="px-2.5 py-1 text-[11px] bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded border border-red-800/60 transition-colors"
        >
          Delete connection
        </button>
      </div>
    </>
  )
}

// ── Max Tool Rounds slider ──────────────────────────────────────
// Per-connection cap on how many tool-call rounds a single chat
// turn may go through before the OpenRouter adapter (and any
// future MCP-looping adapter) cuts the loop short with the
// "Tool-call loop exceeded N rounds without a final reply." error.
// Snaps at powers of 2 (2..128) with a final "No limit" position.
// Stored as `profile.mcp_max_tool_rounds`:
//   - null / undefined → use the adapter's built-in default (8)
//   - -1              → no limit
//   - 2, 4, ... 128   → use this exact value
// Hidden from the panel until `mcp_enabled` is true (the parent
// gates this section on the toggle).
const _MAX_TOOL_ROUNDS_STOPS = [2, 4, 8, 16, 32, 64, 128, -1]
const _MAX_TOOL_ROUNDS_DEFAULT_INDEX = _MAX_TOOL_ROUNDS_STOPS.indexOf(8)

function _formatMaxToolRoundsValue(stored) {
  if (stored === -1) return 'No limit'
  if (stored === null || stored === undefined) return '8'
  return String(stored)
}

function _storedValueToStopIndex(stored) {
  if (stored === null || stored === undefined) return _MAX_TOOL_ROUNDS_DEFAULT_INDEX
  const exact = _MAX_TOOL_ROUNDS_STOPS.indexOf(stored)
  if (exact !== -1) return exact
  // Stored value isn't one of the snap stops (legacy save with a
  // custom value, e.g. from before this slider shipped). Pick the
  // nearest snap stop so the slider has a valid position; the next
  // commit will normalise it to a stop value.
  if (stored < 0) return _MAX_TOOL_ROUNDS_STOPS.length - 1  // any negative → no limit
  let bestIdx = 0
  let bestDelta = Math.abs(_MAX_TOOL_ROUNDS_STOPS[0] - stored)
  for (let i = 1; i < _MAX_TOOL_ROUNDS_STOPS.length - 1; i += 1) {
    const delta = Math.abs(_MAX_TOOL_ROUNDS_STOPS[i] - stored)
    if (delta < bestDelta) { bestDelta = delta; bestIdx = i }
  }
  return bestIdx
}

function MaxToolRoundsSlider({ value, onCommit }) {
  const stopIndex = _storedValueToStopIndex(value)
  const display = _formatMaxToolRoundsValue(value)
  const maxIdx = _MAX_TOOL_ROUNDS_STOPS.length - 1

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between mb-1">
        <label
          className="text-[10px] uppercase tracking-wide text-zinc-500"
          title="Caps the model's tool-call rounds per chat turn. Sequential-tool models (Llama, many Mistral routes) often need 32–128 for multi-step authoring; parallel-batch models (Anthropic, some GPT) rarely need more than 8. ∞ removes the cap."
        >
          Max tool-call rounds per turn
        </label>
        <span className="text-[11px] font-mono text-accent-300">{display}</span>
      </div>
      <input
        type="range"
        min={0}
        max={maxIdx}
        step={1}
        value={stopIndex}
        onChange={(e) => {
          const idx = parseInt(e.target.value, 10)
          const newStored = _MAX_TOOL_ROUNDS_STOPS[idx]
          if (newStored !== value) onCommit(newStored)
        }}
        className="w-full accent-accent-500"
      />
      {/* Tick labels positioned absolutely at the native range
          thumb's centre-of-thumb x-coordinates so each label sits
          directly under the handle when the slider snaps to that
          stop. Thumb width varies by browser (Chromium ~16px,
          Firefox ~18px); the 9px half-width constant below is a
          best-fit empirical default. Each label is transformed via
          inline `translateX(-50%)` so the glyph centre — not its
          left edge — lands on the calc position. The selected stop
          gets the accent colour so the writer sees the snap point
          highlighted in addition to the live value above the slider.
          The ∞ glyph renders smaller than the digit characters in
          most monospace fonts, so we bump its font-size to match
          the digits' visual weight. */}
      <div className="relative w-full h-3 mt-0.5 text-[9px] text-zinc-600 font-mono select-none">
        {_MAX_TOOL_ROUNDS_STOPS.map((v, i) => {
          const frac = i / (_MAX_TOOL_ROUNDS_STOPS.length - 1)
          const isSelected = i === stopIndex
          const isInfinity = v === -1
          return (
            <span
              key={v}
              className={isSelected ? 'absolute text-accent-300 font-semibold' : 'absolute'}
              style={{
                left: `calc(${frac} * (100% - 18px) + 9px)`,
                transform: 'translateX(-50%)',
                ...(isInfinity ? { fontSize: '13px', lineHeight: 1 } : null),
              }}
            >
              {isInfinity ? '∞' : v}
            </span>
          )
        })}
      </div>
      <p className="text-[10px] text-zinc-500 mt-1">
        Caps sequential tool-call rounds per turn.
      </p>
    </div>
  )
}

// ── Test Connection ─────────────────────────────────────────────
// "Test connection" button + inline result. Uses the current draft
// values from the connection card (base_url / api_key / api_type)
// so the writer can probe without having to Save first. Result
// renders below the button as a green "Connected" line or a red
// error message — no modal.
function TestConnectionRow({ profile, onUpdate }) {
  const [busy, setBusy]       = useState(false)
  const [result, setResult]   = useState(null) // null | { ok, detail, fell_back, model_count }
  const noteBaseUrlNormalisation = useSettingsStore((s) => s.noteBaseUrlNormalisation)

  async function runTest() {
    if (!profile.base_url) {
      setResult({ ok: false, detail: 'Set a Base URL before testing.' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const { data } = await axios.post('/api/ai/test-connection', {
        base_url: profile.base_url,
        api_key:  profile.api_key || null,
        api_type: profile.api_type,
      })
      // The backend retries 404s against the adapter's normalised URL.
      // If `base_url_used` differs from what we sent, apply the fix to
      // the profile so the form input reflects the working URL, and
      // surface a brief inline note explaining what happened.
      if (data?.base_url_used && data.base_url_used !== profile.base_url) {
        noteBaseUrlNormalisation({
          profile_id: profile.id,
          old_base_url: profile.base_url,
          new_base_url: data.base_url_used,
        })
        onUpdate?.({ base_url: data.base_url_used })
      }
      // LM Studio (REST v1): record the plugin-probe result so the tool
      // toggle unlocks when the local `mcp/narrativenode` plugin is found
      // (and re-locks if a later probe no longer finds it).
      if (data && Object.prototype.hasOwnProperty.call(data, 'plugin_available')) {
        onUpdate?.({ lmstudio_plugin_detected: data.plugin_available ?? null })
      }
      setResult(data)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setResult({
        ok: false,
        detail: typeof detail === 'string' ? detail : (err.message || 'Test failed'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-help-region="settings:mcp_test_connection" className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={runTest}
          disabled={busy || !profile.base_url}
          title={!profile.base_url ? 'Set a Base URL first' : 'Probe this connection — primary check is GET /models with a chat-completion fallback.'}
          className="px-2.5 py-1 text-[11px] bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 rounded border border-zinc-600 transition-colors"
        >
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {result && (
        <div
          className={`text-[10px] leading-relaxed break-words px-2 py-1 rounded border ${
            result.ok
              ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-200'
              : 'border-red-700/50 bg-red-900/20 text-red-200'
          }`}
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.detail}
        </div>
      )}
    </div>
  )
}

function ModelsSubsection({ profile, onUpdate, defaultModelId, onSetDefaultModel }) {
  // Discovered model list is per-session only. Each "Discover models"
  // click overwrites this with the latest result from the upstream
  // /models endpoint. The persisted state is purely the writer's
  // selection of which model ids to expose (`profile.selected_models`)
  // + the optional manually-added ids (`profile.manually_added_models`)
  // — the metadata that flavoured the checklist (display_name,
  // publisher, capabilities, params_string) is re-fetched on demand
  // and not stored.
  const [discovered, setDiscovered] = useState(null) // null = never discovered this session
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)
  const [manualDraft, setManualDraft] = useState('')
  // Substring filter applied across model id / display name /
  // publisher. Needed because some upstreams (OpenRouter, openai
  // bigger plans) return 300+ models and scrolling to find one is
  // a chore. Empty filter = show everything. Case-insensitive.
  const [filterDraft, setFilterDraft] = useState('')
  const noteBaseUrlNormalisation = useSettingsStore((s) => s.noteBaseUrlNormalisation)

  const selected = profile.selected_models || []
  const manual   = profile.manually_added_models || []

  async function discoverModels() {
    if (!profile.base_url) {
      setError('Set a Base URL before discovering models.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { data } = await axios.post('/api/ai/discover-models', {
        base_url: profile.base_url,
        api_key:  profile.api_key || null,
        api_type: profile.api_type,
      })
      // The backend retries 404s against the adapter's normalised URL.
      // If `base_url_used` differs from what we sent, apply the fix to
      // the profile so the form input reflects the working URL, and
      // surface a brief inline note explaining what happened.
      if (data?.base_url_used && data.base_url_used !== profile.base_url) {
        noteBaseUrlNormalisation({
          profile_id: profile.id,
          old_base_url: profile.base_url,
          new_base_url: data.base_url_used,
        })
        onUpdate?.({ base_url: data.base_url_used })
      }
      // Phase 2.5e — persist discovered model capabilities on the
      // profile so the chat panel can gate file-attach UI without
      // re-querying upstream. Each entry mirrors the structured
      // fields returned by the adapter; entries with all-null
      // capability fields are skipped (no useful info to cache).
      const caps = {}
      for (const m of (data.models || [])) {
        if (!m || !m.id) continue
        const entry = {}
        if (Array.isArray(m.input_modalities))  entry.input_modalities  = m.input_modalities
        if (Array.isArray(m.output_modalities)) entry.output_modalities = m.output_modalities
        if (typeof m.supports_tool_use === 'boolean')  entry.supports_tool_use  = m.supports_tool_use
        if (typeof m.supports_reasoning === 'boolean') entry.supports_reasoning = m.supports_reasoning
        // Phase 2.5f — per-model reasoning catalogue. LM Studio
        // populates `reasoning_options` directly from its declared
        // `allowed_options`; openai_compatible / openrouter / future
        // Anthropic populate at different points (lazy probe / adapter-
        // static enum / hardcoded numeric range respectively).
        if (Array.isArray(m.reasoning_options)) entry.reasoning_options = m.reasoning_options
        if (m.reasoning_budget_range && typeof m.reasoning_budget_range === 'object') {
          entry.reasoning_budget_range = m.reasoning_budget_range
        }
        if (typeof m.reasoning_default === 'string' && m.reasoning_default) {
          entry.reasoning_default = m.reasoning_default
        }
        // Phase 3.10 Layer 5 — `context_window` (token count) when
        // the upstream surfaces it (LM Studio's `max_context_length`,
        // OpenRouter's `context_length`). Scene wiring reads this
        // out of the cache to size its prompt chunks; falls back to
        // a conservative 16k default when the field is missing.
        if (typeof m.context_window === 'number' && m.context_window > 0) {
          entry.context_window = m.context_window
        }
        if (Object.keys(entry).length > 0) caps[m.id] = entry
      }
      if (Object.keys(caps).length > 0) {
        // Merge into existing map — keeps cached entries for models
        // that aren't in this discovery payload (manually-added,
        // unselected-but-known) and overwrites entries for models
        // that ARE in the payload with the fresh capability info.
        onUpdate?.({
          model_capabilities: { ...(profile.model_capabilities || {}), ...caps },
        })
      }
      setDiscovered(data.models || [])
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : (err.message || 'Discovery failed'))
      setDiscovered(null)
    } finally {
      setLoading(false)
    }
  }

  function toggleSelected(modelId) {
    const next = selected.includes(modelId)
      ? selected.filter((id) => id !== modelId)
      : [...selected, modelId]
    onUpdate({ selected_models: next })
  }

  // Add a manually-typed model id. Pushes into BOTH
  // `manually_added_models` (so we know it's hand-added and survives
  // a refresh where /models no longer mentions it) AND
  // `selected_models` (so it's ticked by default — manual additions
  // are an explicit "I want this exposed" signal). Idempotent on
  // duplicate ids.
  function addManualModel() {
    const id = manualDraft.trim()
    if (!id) return
    const nextManual = manual.includes(id) ? manual : [...manual, id]
    const nextSelected = selected.includes(id) ? selected : [...selected, id]
    onUpdate({ manually_added_models: nextManual, selected_models: nextSelected })
    setManualDraft('')
  }

  // Build the display list. Three categories merged into one ordered
  // list so the writer sees everything they care about in one place:
  //   1. Discovered (from the latest API fetch)
  //   2. Manually-added but NOT in discovered (hand-typed ids,
  //      including ids that were once discovered but are no longer)
  //   3. Selected but NOT in discovered AND NOT in manual — these
  //      are ids the writer ticked in an earlier discovery that the
  //      current /models endpoint no longer lists. We mark them
  //      "no longer listed" so the writer knows their selection is
  //      stale, but we don't unilaterally uncheck them. Only flagged
  //      once a discovery HAS run this session; before that, they're
  //      just the persisted state.
  const discoveredIds = new Set((discovered || []).map((m) => m.id))
  const manualIds = new Set(manual)
  const lines = []
  for (const m of (discovered || [])) {
    lines.push({ ...m, status: 'discovered' })
  }
  for (const id of manual) {
    if (!discoveredIds.has(id)) {
      lines.push({ id, status: 'manual' })
    }
  }
  for (const id of selected) {
    if (!discoveredIds.has(id) && !manualIds.has(id)) {
      lines.push({ id, status: discovered != null ? 'missing' : 'unverified' })
    }
  }
  // Apply the substring filter, if any. Matched against the model's
  // id, display name, and publisher (all the user-visible text) so
  // either typing the short id or a vendor name pulls the right row.
  // The selected-count badge in the header stays based on the
  // unfiltered set so the writer can see at a glance how many
  // selections survive across the whole library.
  const filterQuery = filterDraft.trim().toLowerCase()
  const displayList = filterQuery
    ? lines.filter((m) => {
        if ((m.id || '').toLowerCase().includes(filterQuery)) return true
        if ((m.display_name || '').toLowerCase().includes(filterQuery)) return true
        if ((m.publisher || '').toLowerCase().includes(filterQuery)) return true
        return false
      })
    : lines
  const hasContent = displayList.length > 0
  const totalUnfiltered = lines.length

  return (
    <div data-help-region="settings:mcp_models" className="rounded border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className={labelCls}>
          Models
          {selected.length > 0 && (
            <span className="text-zinc-500 ml-1">({selected.length} selected)</span>
          )}
        </span>
        <button
          type="button"
          onClick={discoverModels}
          disabled={loading || !profile.base_url}
          title={!profile.base_url ? 'Set a Base URL first' : 'Fetch the model list from this connection'}
          className="px-2.5 py-1 text-[11px] bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 rounded border border-zinc-600 transition-colors"
        >
          {loading ? 'Discovering…' : (discovered != null ? 'Refresh' : 'Discover models')}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-700/50 bg-red-900/20 px-2 py-1.5 text-[10px] text-red-200 break-words">
          {error}
        </div>
      )}

      {/* Filter input — only shown once there's at least one model
          to filter. Some upstreams (OpenRouter especially) return
          hundreds of models; matching by id / display name /
          publisher substring is faster than scrolling. */}
      {totalUnfiltered > 0 && (
        <div className="relative">
          <input
            type="text"
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            placeholder={`Filter models${totalUnfiltered > 1 ? ` (${totalUnfiltered})` : ''}…`}
            className={inputCls + ' pr-12'}
          />
          {filterDraft && (
            <button
              type="button"
              onClick={() => setFilterDraft('')}
              title="Clear filter"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700/60 rounded px-1.5 py-0.5 transition-colors"
            >
              ✕
            </button>
          )}
          {filterDraft && (
            <div className="text-[9px] text-zinc-500 mt-0.5 px-0.5">
              {displayList.length} of {totalUnfiltered} matches
              {displayList.length === 0 && ' — selected models still count toward the connection, even when filtered out.'}
            </div>
          )}
        </div>
      )}

      {!hasContent && !error && (
        <div className="text-[10px] text-zinc-500">
          {filterDraft && totalUnfiltered > 0
            ? 'No models match the filter.'
            : (discovered != null
                ? 'No models returned from this endpoint.'
                : 'Click Discover models to fetch the model list from this connection.')}
        </div>
      )}

      {hasContent && (
        <ul className="space-y-0.5 max-h-64 overflow-y-auto">
          {displayList.map((m) => {
            const isChecked = selected.includes(m.id)
            const isDefault = defaultModelId === m.id
            return (
              <ModelChecklistRow
                key={m.id}
                model={m}
                status={m.status}
                checked={isChecked}
                onToggle={() => toggleSelected(m.id)}
                isDefault={isDefault}
                canToggleDefault={isChecked}
                onToggleDefault={() => onSetDefaultModel?.(isDefault ? null : m.id)}
                cachedCapabilities={profile.model_capabilities?.[m.id] || null}
              />
            )
          })}
        </ul>
      )}

      {/* Manual-add input. Always visible (even when discovery
          succeeded) so the writer can add ids that aren't in the
          /models response — e.g. providers that gate certain models
          behind paid tiers but don't list them, or LM Studio models
          that haven't been loaded into memory yet. */}
      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={manualDraft}
          onChange={(e) => setManualDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManualModel() } }}
          placeholder="Add model manually (e.g. gpt-4o)"
          className={inputCls + ' flex-1'}
        />
        <button
          type="button"
          onClick={addManualModel}
          disabled={!manualDraft.trim()}
          className="px-2.5 py-1 text-[11px] bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 rounded border border-zinc-600 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function ModelChecklistRow({ model, status, checked, onToggle, isDefault, canToggleDefault, onToggleDefault, cachedCapabilities }) {
  // Capability info: prefer fields on the freshly-discovered model
  // object (it carries the structured fields directly), fall back
  // to the profile's persisted cache for selected-but-not-rediscovered
  // models. Manually-added entries with no cache entry render no badges.
  const capabilities = (
    (model.input_modalities || model.output_modalities ||
     typeof model.supports_tool_use === 'boolean' ||
     typeof model.supports_reasoning === 'boolean')
      ? {
          input_modalities:  model.input_modalities  || null,
          output_modalities: model.output_modalities || null,
          supports_tool_use:  typeof model.supports_tool_use  === 'boolean' ? model.supports_tool_use  : null,
          supports_reasoning: typeof model.supports_reasoning === 'boolean' ? model.supports_reasoning : null,
        }
      : cachedCapabilities
  )
  const primary = model.display_name || model.id
  const metaBits = [
    model.publisher,
    model.capabilities?.length ? model.capabilities.join(' · ') : null,
    model.params_string,
  ].filter(Boolean)
  // When display_name differs from id, surface the raw id underneath
  // so the writer knows what they'll see in API calls.
  const showRawId = model.display_name && model.display_name !== model.id

  // Status modifiers:
  //   - 'discovered': came back from the latest /models fetch. Plain
  //     row, no special chrome.
  //   - 'manual': hand-typed by the writer via the "Add manually"
  //     field. Tagged with a small "manual" badge so the writer can
  //     tell their handwritten entries apart from discovered ones.
  //   - 'missing': in `selected_models` but not in the most-recent
  //     discovery payload. The upstream /models response no longer
  //     mentions this id, so the writer's selection is stale. Greyed
  //     out + "no longer listed" caption.
  //   - 'unverified': in `selected_models` from a prior session and
  //     discovery hasn't run yet this session. Not flagged as
  //     missing because we haven't actually checked.
  const isMissing = status === 'missing'
  const isManual  = status === 'manual'
  const primaryCls = isMissing
    ? 'text-[11px] text-zinc-500 truncate line-through decoration-zinc-700'
    : 'text-[11px] text-zinc-200 truncate'
  const metaCls = isMissing ? 'text-[9px] text-zinc-600 truncate' : 'text-[9px] text-zinc-500 truncate'

  // Default-star is meaningful only when the row is selected. Setting
  // the default on a row that hasn't been picked makes no sense — the
  // chat panel wouldn't see the model in its picker. Disable the
  // star until the writer ticks the checkbox.
  const starTitle = !canToggleDefault
    ? 'Pick this model first (tick its checkbox) to make it the program default.'
    : isDefault
      ? 'Clear program default model.'
      : 'Set this model as the program default.'

  return (
    <li className="flex items-start gap-2 px-1.5 py-1 rounded hover:bg-zinc-800/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 accent-accent-600 cursor-pointer flex-shrink-0"
      />
      <button
        type="button"
        onClick={onToggle}
        className="flex-1 text-left min-w-0"
      >
        <div className="flex items-center gap-1.5">
          <span className={primaryCls}>{primary}</span>
          {isManual && (
            <span
              className="text-[8px] text-sky-300 border border-sky-700/60 rounded px-1 py-px flex-shrink-0"
              title="Added manually — not from the upstream /models response."
            >manual</span>
          )}
          {isMissing && (
            <span
              className="text-[8px] text-amber-400/80 border border-amber-700/40 rounded px-1 py-px flex-shrink-0"
              title="The upstream /models endpoint no longer lists this id. Your selection still references it; remove it (untick) or accept that it may not be reachable."
            >no longer listed</span>
          )}
        </div>
        {showRawId && (
          <div className={metaCls + ' font-mono'}>{model.id}</div>
        )}
        {metaBits.length > 0 && (
          <div className={metaCls}>{metaBits.join(' • ')}</div>
        )}
      </button>
      <CapabilityBadges capabilities={capabilities} />
      <button
        type="button"
        onClick={onToggleDefault}
        disabled={!canToggleDefault}
        title={starTitle}
        className={`mt-0.5 flex-shrink-0 text-base leading-none transition-colors ${
          isDefault
            ? 'text-amber-300 hover:text-amber-200'
            : 'text-zinc-600 hover:text-zinc-300 disabled:text-zinc-800 disabled:hover:text-zinc-800 disabled:cursor-not-allowed'
        }`}
        aria-label={isDefault ? 'Clear program default model' : 'Set as program default model'}
      >
        {isDefault ? '★' : '☆'}
      </button>
    </li>
  )
}

// ── Shared helpers ───────────────────────────────────────────────
function ResetBtn({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] text-zinc-600 hover:text-zinc-400 leading-none"
      title="Clear this override"
    >↺</button>
  )
}

function TextInput({ value, placeholder, onCommit }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])

  function handleBlur() {
    const next = draft.trim() === '' ? null : draft
    if ((next ?? '') !== (value ?? '')) onCommit(next || '')
  }
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={inputCls}
    />
  )
}

// Masked API key field with reveal toggle + clear button. Stores
// `null` when empty (so the connection code can skip the
// Authorization header entirely) rather than an empty string. The
// masked display shows `sk-••••••••1234` style — last 4 characters
// in cleartext, the rest replaced with bullets, regardless of the
// real key's length.
function ApiKeyInput({ value, onCommit }) {
  const [revealed, setRevealed] = useState(false)
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])

  const hasValue = !!(value && value.length > 0)

  function handleBlur() {
    // When showing a masked placeholder, don't overwrite the real
    // key on blur — the writer hasn't typed anything.
    if (!revealed && !hasValue) {
      if (draft === '') return
    }
    if (!revealed && draft === maskKey(value)) {
      // Writer focused but didn't edit — leave the stored value.
      setDraft(value || '')
      return
    }
    const next = draft === '' ? null : draft
    if (next !== (value || null)) onCommit(next)
  }
  function handleClear() {
    setDraft('')
    onCommit(null)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type={revealed ? 'text' : 'password'}
        value={revealed ? draft : (draft || (hasValue ? maskKey(value) : ''))}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          // On focus, swap masked placeholder for the real value so
          // the writer can edit it.
          if (!revealed && hasValue && draft === '') setDraft(value || '')
        }}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        placeholder="Optional — sk-..., bearer token, etc."
        className={inputCls + ' font-mono'}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        title={revealed ? 'Hide key' : 'Show key'}
        className="px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 border border-zinc-600 rounded"
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
      <button
        type="button"
        onClick={handleClear}
        disabled={!hasValue && !draft}
        title="Clear key"
        className="px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 border border-zinc-600 rounded disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Clear
      </button>
    </div>
  )
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 4) return '•'.repeat(key.length)
  // Show the leading "sk-" / "Bearer "-style prefix up to the first
  // dash if present (so OpenAI keys still look obviously OpenAI),
  // then bullets, then the last 4 chars.
  const dashIdx = key.indexOf('-')
  const prefix = dashIdx >= 0 && dashIdx <= 6 ? key.slice(0, dashIdx + 1) : ''
  const tail = key.slice(-4)
  return prefix + '•'.repeat(8) + tail
}

function ScopeBanner() {
  return (
    <div className="rounded border border-sky-700/50 bg-sky-900/20 px-3 py-2 text-[11px] text-sky-200 space-y-1.5">
      <div>
        <span className="font-semibold">Whole-program connections.</span>{' '}
        These settings configure how this app talks to outside services (MCP clients, AI providers). They apply across every project on this machine.
      </div>
      <div className="text-sky-300/80">
        Stored in{' '}
        <code className="px-1 py-0.5 bg-sky-950/60 rounded text-[10px]">preferences/user_preferences.json</code>{' '}
        alongside the app, outside any project.
      </div>
    </div>
  )
}
