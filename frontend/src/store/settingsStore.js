import { create } from 'zustand'
import axios from 'axios'

/**
 * User-level preferences — local-machine defaults that seed new
 * projects. Backed by `preferences/user_preferences.json` via
 * `GET /settings` and `PUT /settings`. See
 * `backend/models/user_preferences.py` + `backend/services/
 * user_preferences_service.py` for the full contract.
 *
 * Loaded once on app mount (via App.jsx calling `loadPreferences`)
 * and cached here. `newProject()` and the Program Settings form UI
 * both read from this store. Writes round-trip through `PUT /settings`
 * and the backend response is trusted as canonical.
 *
 * Every field on the cached `preferences` object is a string / bool /
 * int OR `null`. `null` means "no user-level override, use the
 * application's built-in default." Consumers should treat a null
 * value as absent, not as a real empty string / false / 0.
 */

// Mirror of backend `UserPreferences` defaults. Keeps the store
// populated with the full schema shape even before the first load
// completes, so consumers can `useSettingsStore((s) => s.preferences)`
// without null-guarding each read.
const BLANK_PREFS = {
  version: '0.1.14.0',
  author_name: null,
  default_tense: null,
  default_pov_type: null,
  default_language: null,
  default_chapter_label: null,
  default_act_label: null,
  default_accent_color: null,
  default_pov_color: null,
  default_autosave_enabled: null,
  default_autosave_interval_minutes: null,
  snap_to_grid_default: null,
  default_wire_visibility_mode: null,
  default_wire_visibility_types: null,
  default_chapter_tint_behind_nodes: null,
  // Phase 5.3c — master toggle for the story library (ON by default).
  use_project_library: true,
  default_awareness_rollover_check_enabled: null,
  // Phase 1.22j — Tidy Wires gate. null / false = button hidden.
  // true = button shown on the canvas toolbar. Toggled from the
  // Dev Settings tab in the Dev Preview panel.
  dev_show_tidy_wires_button: null,
  // Phase 1.26 — left sidebar logical width in px. null = use the
  // built-in default (224). Floor is the built-in default — the
  // resize handle prevents the writer from dragging narrower.
  left_sidebar_width: null,
  // Phase 2.9a item 10 — default zoom level (percent) for the
  // editor panel's prose area. Integer 50-200 in 10% increments.
  // null = use the built-in default (100%). Set from the Program
  // Settings tab; the editor footer's session slider starts at
  // this value on mount, and its reset button reverts to it.
  editor_default_zoom_level: null,
  // Phase 5.5c — open the Story Library on app launch (over a fresh
  // blank story). ON by default; mirrored by the library's bottom-left
  // checkbox and the Program Settings toggle. false = opted out.
  show_library_on_startup: true,
  // Phase 5.7 — when true, hide every AI-related UI surface (MCP
  // controls, AI chat panel + its toggle, character-chat and
  // add-as-context buttons, editor AI insert buttons, MCP / System
  // Prompts settings tabs, Novelcrafter AI-refine option). Off by
  // default. Turning it on ends any active MCP session and stops the
  // MCP server.
  disable_ai_integrations: false,
  // Deletion confirmation: when true (the default, and the fallback
  // when a prefs file has no entry), the delete dialog requires typing
  // the object's name before the delete button activates. false = the
  // dialog still appears but the delete button is enabled immediately.
  require_typed_name_to_delete: true,
  // Phase 2.4 — magnetic auto-scroll for the chat conversation
  // view. null / true = follow the tail when pinned to bottom,
  // stop following when scrolled up. false = never auto-scroll.
  chat_auto_scroll: null,
  // Phase 2.4 — chat input keybind. null / true = Enter sends,
  // Shift+Enter or Ctrl+Enter inserts a newline. false = Ctrl+Enter
  // sends, Enter inserts a newline.
  chat_send_on_enter: null,
  // Phase 2.4 — tool-call chip detail level.
  //   null / "name" → chips show tool name + status only.
  //   "full"        → chips are expandable; click reveals the full
  //                    arguments JSON + raw tool output.
  tool_call_detail: null,
  // Phase 2.3a — saved panel layout default. Opaque snapshot dict;
  // see `uiStore.getCurrentLayoutSnapshot()` / `applyLayoutSnapshot()`
  // for the shape. `null` = writer hasn't saved a layout; the
  // built-in defaults apply at boot.
  default_panel_layout: null,
  // Phase 2.3c — AI provider profiles. Saved AI connection profiles
  // (LM Studio, Ollama, OpenAI, Anthropic, custom OpenAI-compatible
  // endpoints). Each entry shape:
  //   { id, name, api_type, base_url, api_key, selected_models[],
  //     manually_added_models[], last_used_model, lmstudio_mcp_enabled }
  // Empty list = writer has not added any profiles yet.
  ai_provider_profiles: [],
  // Default profile id; `null` when there is zero or one profile
  // (no choice to make).
  ai_default_profile_id: null,
  // Global default model: `{ profile_id, model }` or `null` for "no
  // default set, fall back to last-used".
  ai_default_model: null,
  // Phase 2.3e — Pointer to the default system prompt id. The
  // prompt collection itself lives one-file-per-prompt under
  // `system_prompts/{slug}__{id}.json` (Phase 2.10a moved this out
  // of `preferences/`) and is fetched on demand via
  // `systemPromptsStore.js` — only this pointer lives in
  // user_preferences.json. `null` = "No system prompt" (skip the
  // system-role message entirely).
  default_system_prompt_id: null,
}

export const useSettingsStore = create((set, get) => ({
  preferences: BLANK_PREFS,
  // `loaded` flips true once the first GET resolves. Consumers
  // that need to wait for preferences before doing something
  // (e.g. newProject seeding from them) should check this first.
  loaded: false,
  loading: false,
  saving: false,
  loadError: null,
  saveError: null,
  // Transient diff between the base_urls the writer sent on the
  // most recent save and the normalised forms the backend returned.
  // Populated by `updatePreferences` when an adapter trimmed any
  // `/v1[/...]` tail off a profile's URL. The connections settings
  // tab reads this to surface a brief inline "we trimmed your URL"
  // note next to each affected profile. Each entry:
  //   { profile_id, old_base_url, new_base_url }
  // Cleared at the start of the next save attempt.
  lastBaseUrlNormalisations: [],

  /** Fetch preferences from the backend. Safe to call repeatedly —
   *  idempotent. Sets `loaded: true` on success (even if the server
   *  returned an all-nulls blank — that's still a valid loaded
   *  state, just means the user has no overrides configured). */
  loadPreferences: async () => {
    set({ loading: true, loadError: null })
    try {
      const { data } = await axios.get('/api/settings')
      set({
        preferences: { ...BLANK_PREFS, ...data },
        loaded: true,
        loading: false,
      })
    } catch (err) {
      set({
        loadError: err?.response?.data?.detail || err.message || 'Failed to load preferences',
        loading: false,
      })
    }
  },

  /** Merge a partial patch into the current preferences and PUT the
   *  result. The backend PUT is a full replacement — we always send
   *  the complete current shape, not just the patch.
   *
   *  The local cache is set optimistically BEFORE the PUT and NOT
   *  overwritten on the server echo. Two reasons:
   *    1. The backend's PUT returns exactly what was sent (no
   *       normalisation, no derived fields), so the echo is
   *       redundant.
   *    2. If the user rapid-fires a second change while PUT 1 is
   *       in flight, echoing back PUT 1's response after PUT 2's
   *       optimistic update would briefly un-apply PUT 2's edit in
   *       the UI until PUT 2's own response arrived — a visible
   *       flicker. Skipping the echo avoids it.
   *  On PUT failure we surface `saveError` but leave the optimistic
   *  state in place — user sees a warning, can retry, and a
   *  subsequent successful PUT overwrites the dud attempt. */
  updatePreferences: async (patch) => {
    const merged = { ...get().preferences, ...patch }
    set({ preferences: merged, saving: true, saveError: null, lastBaseUrlNormalisations: [] })
    try {
      const { data } = await axios.put('/api/settings', merged)
      // The backend may normalise some `ai_provider_profiles[].base_url`
      // fields (e.g. trim a writer-pasted `/v1/chat/completions` tail
      // so it doesn't get duplicated when the adapter appends its own
      // path). Reconcile those specific URLs back into local state so
      // the form input reflects the canonical value going forward, and
      // capture the diff in `lastBaseUrlNormalisations` so the
      // connections tab can surface a brief inline note. Only base_urls
      // are reconciled — every other field stays optimistic, preserving
      // the rapid-fire-edit behaviour the comment above describes.
      const sentProfiles = (merged.ai_provider_profiles || [])
      const receivedProfiles = (data?.ai_provider_profiles || [])
      const receivedById = {}
      for (const p of receivedProfiles) receivedById[p.id] = p
      const trims = []
      const reconciledProfiles = sentProfiles.map((sent) => {
        const received = receivedById[sent.id]
        if (!received) return sent
        if (received.base_url && received.base_url !== sent.base_url) {
          trims.push({
            profile_id: sent.id,
            old_base_url: sent.base_url,
            new_base_url: received.base_url,
          })
          return { ...sent, base_url: received.base_url }
        }
        return sent
      })
      set({
        preferences: { ...get().preferences, ai_provider_profiles: reconciledProfiles },
        saving: false,
        lastBaseUrlNormalisations: trims,
      })
    } catch (err) {
      set({
        saveError: err?.response?.data?.detail || err.message || 'Failed to save preferences',
        saving: false,
      })
    }
  },

  /** Toggle tool use (`mcp_enabled`) on a single connection profile
   *  and persist immediately. Mirrors the per-connection toggle in the
   *  MCP & API Connections settings tab so the chat composer's tool-use
   *  button saves the exact same way. No-op for an unknown id. */
  setProfileMcpEnabled: (profileId, enabled) => {
    const profiles = get().preferences.ai_provider_profiles || []
    if (!profiles.some((p) => p.id === profileId)) return
    const next = profiles.map((p) => (p.id === profileId ? { ...p, mcp_enabled: !!enabled } : p))
    return get().updatePreferences({ ai_provider_profiles: next })
  },

  /** Push a base-URL trim into the transient notice list so the
   *  connections form can show "we trimmed your URL" inline. Called
   *  by the discover-models / test-connection handlers when an
   *  upstream retry against the normalised URL succeeded — the
   *  `lastBaseUrlNormalisations` channel is normally populated by
   *  `updatePreferences`, but discovery/test happen outside the
   *  save round-trip and still want to surface the same hint. */
  noteBaseUrlNormalisation: ({ profile_id, old_base_url, new_base_url }) => {
    if (!profile_id || !old_base_url || !new_base_url) return
    if (old_base_url === new_base_url) return
    set((s) => ({
      lastBaseUrlNormalisations: [
        ...(s.lastBaseUrlNormalisations || []).filter((t) => t.profile_id !== profile_id),
        { profile_id, old_base_url, new_base_url },
      ],
    }))
  },

  /** Reset a single field to `null` (no override). Thin convenience
   *  wrapper around `updatePreferences` for the per-field reset
   *  buttons on the Program Settings form. */
  resetField: async (fieldName) => {
    return get().updatePreferences({ [fieldName]: null })
  },

  /** Reset the entire preferences file to the blank schema. Not
   *  exposed on the UI yet but useful for tests and a future
   *  "reset all" affordance. */
  resetAll: async () => {
    return get().updatePreferences({
      author_name: null,
      default_tense: null,
      default_pov_type: null,
      default_language: null,
      default_chapter_label: null,
      default_act_label: null,
      default_accent_color: null,
      default_pov_color: null,
      default_autosave_enabled: null,
      default_autosave_interval_minutes: null,
      snap_to_grid_default: null,
      default_wire_visibility_mode: null,
      default_wire_visibility_types: null,
      default_chapter_tint_behind_nodes: null,
      use_project_library: true,
    })
  },
}))
