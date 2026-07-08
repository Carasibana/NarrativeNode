import { create } from 'zustand'

// Phase 2.10b bug 1 refactor — pinned-context dedup / anchor identity
// helpers (`_pinAnchorIdentityKey` + `_markerKey`) moved to the unified
// `pinnedContextStore`. Chat pin storage + actions removed from this
// module; see `store/pinnedContextStore.js`.

export const useUiStore = create((set, get) => ({
  // True while React Flow is firing a node-drag (between
  // `onNodeDragStart` and `onNodeDragStop` on the canvas). Heavy
  // hooks that depend on `s.nodes` (notably `useStoryOrder` and its
  // O(N²) 13-tier constraint walk) check this flag and short-circuit
  // to their last cached result for the duration of the drag instead
  // of re-running on every frame. Drag fires position changes at ~60
  // Hz; without this gate, big projects become unusable mid-drag
  // because every drag frame triggers 45+ store subscribers AND a
  // full graph-ordering recompute. Position-derived results (tier 5
  // chapter index, tier 6 canvas-x) only update on drag stop, which
  // is the moment the writer cares about anyway.
  isDraggingNodes: false,
  setIsDraggingNodes: (value) => set({ isDraggingNodes: !!value }),

  // Phase 4.1g follow-up — same stale-while-gesturing gate as
  // `isDraggingNodes`, for the OTHER continuous canvas gestures that
  // write the store per frame: node corner-resize and chapter-border
  // drags. While true, `useStoryOrder` serves its cached result so a
  // gesture costs one ordering recompute at gesture end instead of
  // one per frame (~150 ms each on large projects).
  canvasGestureActive: false,
  setCanvasGestureActive: (value) => set({ canvasGestureActive: !!value }),

  entityLibraryOpen: true,
  entityLibraryTab: 'character',
  entityModalOpen: false,
  entityModalEntityId: null,      // null = create new (only mode now; editing is in sidebar)
  entityModalInitialType: 'character',

  toggleEntityLibrary: () => set((s) => ({ entityLibraryOpen: !s.entityLibraryOpen })),
  setEntityLibraryTab: (tab) => set({ entityLibraryTab: tab }),

  // One-shot signal from the toolbar Import/Export menu: when the
  // user picks "Import Story Seeds…", we flip this to 'import' AND
  // open the Settings panel on the Story Seeds tab. The Story Seeds
  // tab watches this flag, triggers its Import button, and clears.
  // Null = no pending action.
  pendingStorySeedsAction: null,
  requestStorySeedsImport: () => set({ pendingStorySeedsAction: 'import' }),
  clearPendingStorySeedsAction: () => set({ pendingStorySeedsAction: null }),

  // Phase 2.4 — request the Settings panel be opened to a specific
  // tab. `App` watches this flag and opens the panel + seeds the
  // initial tab, then clears the request. Lets nested components
  // (the chat settings popover, future hover-actions, etc.) jump
  // into Settings without having to drill an `onOpenSettings`
  // callback all the way down the tree.
  pendingSettingsOpen: null,
  requestSettingsOpen: (tabId) => set({ pendingSettingsOpen: tabId || true }),
  clearPendingSettingsOpen: () => set({ pendingSettingsOpen: null }),

  // Phase 2.4 — request the Chat Settings popover be opened. The
  // popover lives inside the conversation view (`InputToolbarRow`);
  // this flag lets the chat header — which sits one level up — ask
  // it to open without lifting popover state all the way up the
  // tree. Bumped (rather than just toggled) so repeated requests
  // re-fire the open even if the popover was just closed; the
  // watcher resets the counter on consume.
  pendingChatSettingsOpen: 0,
  requestOpenChatSettings: () => set((s) => ({ pendingChatSettingsOpen: s.pendingChatSettingsOpen + 1 })),

  // Phase 2.5c — Scene context provider. When the toggle is on AND
  // there's an active scene (canvas selection or editor-open), the
  // chat panel injects a system message carrying the scene's
  // resolved context just before the latest user message on every
  // send. Never persisted on the saved conversation — the writer's
  // history shows only what they typed. Per-session, defaults to
  // off; the auto-on effect in the chat panel sets it true when a
  // scene becomes active and the writer hasn't manually touched it.
  chatSceneContextEnabled: false,
  // Tracks whether the writer has explicitly clicked the toggle
  // this session. Once true, the auto-on effect no longer
  // overrides the writer's choice — they decide for the rest of
  // the session. Reset to false when the chat panel mounts (or on
  // a "clear my context choices" affordance if we ever add one).
  chatSceneContextManuallyToggled: false,
  /** Writer-initiated toggle. Flips the flag AND marks manually
   *  toggled so subsequent scene-selection events don't auto-
   *  override the writer's preference. */
  setChatSceneContextEnabled: (value) => set({
    chatSceneContextEnabled: !!value,
    chatSceneContextManuallyToggled: true,
  }),
  /** Auto-on / auto-off path driven by the scene-active effect.
   *  No-op once the writer has manually toggled this session — we
   *  honour their explicit choice over the auto behaviour. */
  autoSetChatSceneContextEnabled: (value) => {
    const s = get()
    if (s.chatSceneContextManuallyToggled) return
    if (!!value === !!s.chatSceneContextEnabled) return
    set({ chatSceneContextEnabled: !!value })
  },

  // Phase 2.5c — manual context attach. Writer-pinned items that
  // ride along with the scene context every send until removed.
  // Per-session, not persisted across reloads (no disk-write path
  // for these). Items are kind-discriminated:
  //   { kind: 'entity', id, sessionId, addedAt }
  //   { kind: 'scene',  id, sessionId, addedAt }
  //   { kind: 'chapter', id, sessionId, addedAt }
  // Phase 2.10b bug 1 refactor — chat pinned-context state moved to
  // the unified `pinnedContextStore` keyed `'chat:<threadId>'`. The
  // legacy `chatPinnedContextItems` field + actions
  // (`addPinnedContextItem` / `removePinnedContextItem` /
  // `updatePinnedContextItemMarker` / `clearPinnedContextItems`) have
  // been retired. Callers now use `usePinnedContextStore.addPin(...)`
  // etc. with the per-thread surface key.

  // Phase 2.5d — Message-history rolling-window cap. The number of
  // prior user/assistant turns to re-send with each request, set by
  // the writer via the Message History section in Chat Settings.
  // Default 16 (8 user+assistant pairs). UI preset chips are 8, 16,
  // 24, 32, 64; any non-negative integer is allowed via the custom
  // input; 0 means "current message only".
  // System messages do NOT count toward this cap; only user and
  // assistant turns. Wired into the wire builder in the chat-
  // context-history work; until then it's stored but not yet
  // consumed by send.
  chatHistoryWindowN: 16,
  setChatHistoryWindowN: (n) => set({ chatHistoryWindowN: n }),

  // Phase 2.5d sticky-favourite warning suppression. When the writer
  // ticks "Don't warn me again" in the over-5-stickies confirmation
  // dialog, this flag flips to true and remaining warnings for the
  // session are skipped. Resets to false on app reload (deliberately
  // session-only — the warning is a one-time-per-session safety net,
  // not a permanent preference).
  chatStickyWarningSuppressed: false,
  setChatStickyWarningSuppressed: (v) => set({ chatStickyWarningSuppressed: !!v }),

  // Phase 2.5d — sticky active scene id for the chat panel's
  // context resolution. The chat panel previously derived the
  // active scene LIVE from the editor / detail panel state, which
  // meant the moment the writer clicked an entity in the detail
  // panel (to edit a character that lives in the scene) the scene
  // dropped out of the context resolution.
  //
  // This value is updated by an effect in ConversationView when
  // either:
  //   - The Editor sidebar opens a scene (rightSidebarOpen +
  //     rightSidebarNodeId — editor pin is authoritative).
  //   - The Detail Panel is showing a scene
  //     (detailPanelMode === 'scene').
  // When the resolution comes up null (neither is showing a
  // scene — e.g. the writer is editing an entity in the Detail
  // Panel), the prior value STICKS. So poking around inside the
  // scene's entities / knowledges / relationships doesn't drop
  // the scene from chat-context resolution.
  chatActiveSceneId: null,
  setChatActiveSceneId: (id) => set({ chatActiveSceneId: id || null }),

  // Phase 2.9b — Current editor surface tuple. Published by
  // `RightSidebar` whenever an editor is mounted (scene main /
  // cue body / reference note / entity notes / knowledge notes);
  // cleared to null when the right sidebar closes or no editor
  // surface is active.
  //
  // Consumed by the chat panel's Apply-to-Editor-Section flow
  // (whole-message and excerpt). The Apply menu is only available
  // when this is non-null — symmetric with Attach-to-Chat being
  // unavailable from the editor when the chat panel isn't open.
  //
  // Shape: `{ surface_type, surface_host_id }` matching the
  // EditorSurfaceContext payload. surface_type is one of
  // `'scene_main' | 'cue_body' | 'reference_note' | 'entity_notes'
  // | 'knowledge_notes'`. surface_host_id is the host object's id
  // (scene node id, cue id, reference node id, entity id,
  // knowledge id).
  currentEditorSurface: null,
  setCurrentEditorSurface: (tuple) => set({
    currentEditorSurface: tuple && tuple.surface_type && tuple.surface_host_id
      ? { surface_type: tuple.surface_type, surface_host_id: tuple.surface_host_id }
      : null,
  }),

  // Phase 2.9d v0.2.9.71 — Scene Description's expanded/collapsed
  // state, lifted from local RightSidebar state into the store so
  // off-tree consumers can gate affordances on it. Specifically the
  // chat panel's Apply to Editor Section picker only offers "Scene
  // Description" as a target when the description is currently
  // expanded in the editor — writers shouldn't be writing into a
  // surface they can't see at the moment. Persists across scene
  // switches per the writer-preference convention.
  sceneDescriptionExpanded: false,
  // Accepts a value OR a functional updater (mirrors React useState's
  // setter shape) — the toggle button calls `setDescriptionExpanded(v => !v)`.
  setSceneDescriptionExpanded: (val) => set((s) => ({
    sceneDescriptionExpanded: typeof val === 'function'
      ? !!val(s.sceneDescriptionExpanded)
      : !!val,
  })),

  // Phase 2.5e — Per-thread file-attachment chip list. The chips
  // themselves ARE the attachment state — there's no separate
  // "staging area" concept. When at least one entry is present for
  // a thread, the chip row appears beneath the active context strip
  // in the chat panel; on successful send the list clears.
  //
  // Shape: `{ [threadId]: Attachment[] }`. Each Attachment:
  //   {
  //     sessionId: string,      // stable React key + remove handle
  //     name:      string,      // filename as picked from disk
  //     size:      number,      // bytes
  //     mimeType:  string,      // e.g. 'image/png'
  //     kind:      'text'|'image'|'file',  // wire-routing tag
  //     file:      File,        // the raw File for wire encoding
  //     blobUrl:   string,      // URL.createObjectURL — revoke
  //                             // when removed
  //   }
  //
  // The `file` reference and `blobUrl` are session-only — they
  // disappear on reload. Wire encoding (a later 2.5e item) reads
  // the File directly when packing the outgoing payload.
  chatAttachmentStaging: {},
  addChatAttachment: (threadId, attachment) => set((s) => {
    if (!threadId || !attachment) return s
    const list = s.chatAttachmentStaging?.[threadId] || []
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
    const entry = { ...attachment, sessionId: attachment.sessionId || newId }
    return {
      chatAttachmentStaging: {
        ...(s.chatAttachmentStaging || {}),
        [threadId]: [...list, entry],
      },
    }
  }),
  removeChatAttachment: (threadId, sessionId) => set((s) => {
    if (!threadId || !sessionId) return s
    const list = s.chatAttachmentStaging?.[threadId] || []
    const target = list.find((a) => a.sessionId === sessionId)
    if (target?.blobUrl) {
      try { URL.revokeObjectURL(target.blobUrl) } catch { /* ignore */ }
    }
    const remaining = list.filter((a) => a.sessionId !== sessionId)
    const next = { ...(s.chatAttachmentStaging || {}) }
    if (remaining.length === 0) delete next[threadId]
    else next[threadId] = remaining
    return { chatAttachmentStaging: next }
  }),
  clearChatAttachments: (threadId) => set((s) => {
    if (!threadId) return s
    const list = s.chatAttachmentStaging?.[threadId] || []
    for (const a of list) {
      if (a.blobUrl) {
        try { URL.revokeObjectURL(a.blobUrl) } catch { /* ignore */ }
      }
    }
    const next = { ...(s.chatAttachmentStaging || {}) }
    delete next[threadId]
    return { chatAttachmentStaging: next }
  }),

  // ── Phase 2.5f — per-thread reasoning state ────────────────
  //
  // Two maps, both keyed by threadId. State follows the writer
  // across model switches within a thread: picking a new model
  // NEVER resets reasoning on/off or the chosen level. Session-only
  // — not persisted to disk. Cleared on thread delete by the
  // conversations store (mirrors how chatAttachmentStaging is
  // handled at thread-close time).
  //
  //   chatReasoningEnabled[threadId] = boolean
  //     Whether the writer has reasoning ON for this thread.
  //     Default: false (treated as off when the key is absent).
  //
  //   chatReasoningLevel[threadId] = string | number | null
  //     The slider value. String for enum adapters
  //     (LM Studio / OpenRouter / openai_compatible — e.g.
  //     "medium"); number for adapters that take a numeric
  //     budget (Anthropic, when shipped). Null while the writer
  //     hasn't picked a value yet; the adapter then omits the
  //     reasoning field from the outgoing request even if
  //     `chatReasoningEnabled` is true (defensive — UI should
  //     keep the level set whenever the button is on).
  //
  //   chatReasoningVerbosity[threadId] = string | null
  //     OpenRouter-only sidecar — `reasoning.summary` value
  //     (`"auto" | "concise" | "detailed" | "none"`). Default
  //     null = omit the field, get the upstream's default
  //     surfaced reasoning content. UI surfaces this picker
  //     inside the reasoning flyout only when the active adapter
  //     is OpenRouter.
  chatReasoningEnabled: {},
  chatReasoningLevel: {},
  chatReasoningVerbosity: {},
  setChatReasoningEnabled: (threadId, value) => set((s) => {
    if (!threadId) return s
    const v = !!value
    const next = { ...(s.chatReasoningEnabled || {}) }
    if (v) next[threadId] = true
    else delete next[threadId]
    return { chatReasoningEnabled: next }
  }),
  setChatReasoningLevel: (threadId, value) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatReasoningLevel || {}) }
    if (value === null || value === undefined || value === '') delete next[threadId]
    else next[threadId] = value
    return { chatReasoningLevel: next }
  }),
  setChatReasoningVerbosity: (threadId, value) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatReasoningVerbosity || {}) }
    if (value === null || value === undefined || value === '') delete next[threadId]
    else next[threadId] = value
    return { chatReasoningVerbosity: next }
  }),
  clearReasoningStateForThread: (threadId) => set((s) => {
    if (!threadId) return s
    const enabled = { ...(s.chatReasoningEnabled || {}) }
    const level   = { ...(s.chatReasoningLevel   || {}) }
    const verb    = { ...(s.chatReasoningVerbosity || {}) }
    delete enabled[threadId]
    delete level[threadId]
    delete verb[threadId]
    return {
      chatReasoningEnabled: enabled,
      chatReasoningLevel: level,
      chatReasoningVerbosity: verb,
    }
  }),

  // ── Phase 2.5h — per-thread Story Scope context state ─────────
  //
  // Session-only, per-thread maps that drive the "Story Scope"
  // appendage which rides alongside the Scene Context block on
  // every send. Defaults are null / empty / false — the appendage
  // is omitted entirely when `chatStoryScopeMode[threadId]` is null.
  // Never persisted to disk; wiped on project switch (the scene /
  // chapter / act ids these reference belong to one project only).
  //
  //   chatStoryScopeMode[threadId] = null | 'summary' | 'summary_with_changes' | 'full_content'
  //     What to include for each scene in the story scope. Null
  //     means the story scope context is off for this thread.
  //
  //   chatStoryScopeScenes[threadId] = string[]
  //     Explicit list of scene ids to include. When non-empty, the
  //     chapter / act fields are ignored — the writer's hand-picked
  //     set wins.
  //
  //   chatStoryScopeChapter[threadId] = string | null
  //     Chapter id whose scenes are included. Used only when
  //     `chatStoryScopeScenes` is empty.
  //
  //   chatStoryScopeAct[threadId] = string | null
  //     Act id whose scenes (across its chapters) are included.
  //     Used only when `chatStoryScopeScenes` and
  //     `chatStoryScopeChapter` are both empty.
  //
  //   chatStoryScopeIncludePrev[threadId] = bool
  //     When true AND the active scene context is also on, prepend
  //     every scene that comes before the active scene in story
  //     order. Composes with the explicit / chapter / act selection.
  //
  //   chatStoryScopeIncludeNext[threadId] = bool
  //     Mirror of includePrev for downstream scenes.
  chatStoryScopeMode: {},
  chatStoryScopeScenes: {},
  chatStoryScopeChapter: {},
  chatStoryScopeAct: {},
  chatStoryScopeIncludePrev: {},
  chatStoryScopeIncludeNext: {},
  setChatStoryScopeMode: (threadId, value) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeMode || {}) }
    if (value === null || value === undefined || value === '') delete next[threadId]
    else next[threadId] = value
    return { chatStoryScopeMode: next }
  }),
  // Phase 2.5h follow-up — each hand-picked scene carries its OWN
  // mode (`summary` / `summary_with_changes` / `full_content`)
  // independent of the whole-story radio. New picks default to
  // `'summary'`. Per-scene mode overrides the whole-story mode for
  // that specific scene when both are active. The chip strip and
  // bundle builder both normalise pre-Phase-2.5h string entries
  // (raw scene id) on read; writers shouldn't see any disruption.
  setChatStoryScopeScenes: (threadId, sceneEntries) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeScenes || {}) }
    const list = Array.isArray(sceneEntries)
      ? sceneEntries
          .map((e) => (typeof e === 'string'
            ? { id: e, mode: 'summary' }
            : (e && e.id ? { id: e.id, mode: e.mode || 'summary' } : null)))
          .filter(Boolean)
      : []
    if (list.length === 0) delete next[threadId]
    else next[threadId] = list
    return { chatStoryScopeScenes: next }
  }),
  addChatStoryScopeScene: (threadId, sceneId, mode = 'summary') => set((s) => {
    if (!threadId || !sceneId) return s
    const next = { ...(s.chatStoryScopeScenes || {}) }
    const list = next[threadId] || []
    if (list.some((e) => (typeof e === 'string' ? e === sceneId : e?.id === sceneId))) return s
    next[threadId] = [...list, { id: sceneId, mode: mode || 'summary' }]
    return { chatStoryScopeScenes: next }
  }),
  removeChatStoryScopeScene: (threadId, sceneId) => set((s) => {
    if (!threadId || !sceneId) return s
    const next = { ...(s.chatStoryScopeScenes || {}) }
    const list = (next[threadId] || []).filter(
      (e) => (typeof e === 'string' ? e !== sceneId : e?.id !== sceneId)
    )
    if (list.length === 0) delete next[threadId]
    else next[threadId] = list
    return { chatStoryScopeScenes: next }
  }),
  /** Set the per-scene mode for a hand-picked scene. No-op when the
   *  scene isn't in the writer's picks. `mode` is one of the three
   *  per-scene modes. */
  setChatStoryScopeSceneMode: (threadId, sceneId, mode) => set((s) => {
    if (!threadId || !sceneId) return s
    const next = { ...(s.chatStoryScopeScenes || {}) }
    const list = (next[threadId] || [])
    const idx = list.findIndex((e) => (typeof e === 'string' ? e === sceneId : e?.id === sceneId))
    if (idx < 0) return s
    const newList = [...list]
    newList[idx] = { id: sceneId, mode: mode || 'summary' }
    next[threadId] = newList
    return { chatStoryScopeScenes: next }
  }),
  setChatStoryScopeChapter: (threadId, chapterId) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeChapter || {}) }
    if (!chapterId) delete next[threadId]
    else next[threadId] = chapterId
    return { chatStoryScopeChapter: next }
  }),
  setChatStoryScopeAct: (threadId, actId) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeAct || {}) }
    if (!actId) delete next[threadId]
    else next[threadId] = actId
    return { chatStoryScopeAct: next }
  }),
  setChatStoryScopeIncludePrev: (threadId, value) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeIncludePrev || {}) }
    if (!value) delete next[threadId]
    else next[threadId] = true
    return { chatStoryScopeIncludePrev: next }
  }),
  setChatStoryScopeIncludeNext: (threadId, value) => set((s) => {
    if (!threadId) return s
    const next = { ...(s.chatStoryScopeIncludeNext || {}) }
    if (!value) delete next[threadId]
    else next[threadId] = true
    return { chatStoryScopeIncludeNext: next }
  }),
  clearStoryScopeStateForThread: (threadId) => set((s) => {
    if (!threadId) return s
    const mode  = { ...(s.chatStoryScopeMode  || {}) }
    const sc    = { ...(s.chatStoryScopeScenes || {}) }
    const chap  = { ...(s.chatStoryScopeChapter || {}) }
    const act   = { ...(s.chatStoryScopeAct || {}) }
    const prev  = { ...(s.chatStoryScopeIncludePrev || {}) }
    const nxt   = { ...(s.chatStoryScopeIncludeNext || {}) }
    delete mode[threadId]
    delete sc[threadId]
    delete chap[threadId]
    delete act[threadId]
    delete prev[threadId]
    delete nxt[threadId]
    return {
      chatStoryScopeMode: mode,
      chatStoryScopeScenes: sc,
      chatStoryScopeChapter: chap,
      chatStoryScopeAct: act,
      chatStoryScopeIncludePrev: prev,
      chatStoryScopeIncludeNext: nxt,
    }
  }),
  /** Wipe ALL per-thread story-scope state. Called on project
   *  switch since scene / chapter / act ids belong to one project
   *  and can't carry over. */
  clearAllStoryScopeState: () => set({
    chatStoryScopeMode: {},
    chatStoryScopeScenes: {},
    chatStoryScopeChapter: {},
    chatStoryScopeAct: {},
    chatStoryScopeIncludePrev: {},
    chatStoryScopeIncludeNext: {},
  }),

  // Transient alert banner — single shared slot for short-lived,
  // auto-dismissing messages that appear as a thin strip across the
  // top of the app (sibling above the main row, same layout family
  // as the error / backendDisconnected / MCP session banners). Used
  // by the canvas + chat composer when a dropped file is rejected;
  // future callers can fire into the same slot.
  //
  // Shape: `{ id, message, kind: 'error' | 'info' }` or null. The
  // `id` exists so a stale auto-dismiss timer can no-op when a newer
  // alert has replaced it.
  transientAlert: null,
  _transientAlertTimer: null,
  showTransientAlert: (message, opts) => {
    if (!message) return
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
    const kind = (opts && opts.kind) || 'error'
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 6000
    const prev = get()._transientAlertTimer
    if (prev) { try { clearTimeout(prev) } catch { /* ignore */ } }
    const t = setTimeout(() => {
      const current = get().transientAlert
      if (current && current.id === id) set({ transientAlert: null, _transientAlertTimer: null })
    }, timeoutMs)
    set({ transientAlert: { id, message, kind }, _transientAlertTimer: t })
  },
  clearTransientAlert: () => {
    const t = get()._transientAlertTimer
    if (t) { try { clearTimeout(t) } catch { /* ignore */ } }
    set({ transientAlert: null, _transientAlertTimer: null })
  },

  // Request signal — a `.nnz` file dropped onto the canvas needs to
  // route through the same guard-unsaved-then-load flow the hamburger
  // menu's Open uses. That flow lives in App.jsx (closure over the
  // confirm dialog + saveProject + activePath etc), so the canvas
  // can't call it directly. Drop handler fires this signal; App.jsx
  // watches and consumes it. Shape: `{ id, file }` or null. The `id`
  // exists so a back-to-back second drop displaces the first cleanly
  // (the in-flight effect short-circuits when it sees a newer id).
  pendingDroppedProjectFile: null,
  requestOpenDroppedProject: (file) => {
    if (!file) return
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
    set({ pendingDroppedProjectFile: { id, file } })
  },
  clearPendingDroppedProject: () => set({ pendingDroppedProjectFile: null }),

  // Phase 1.11 — Chapters & Acts column header collapse state. When true,
  // the overlay's Act row is hidden and the total header shrinks to just
  // the Chapter row height (one-row strip). Users can still add / edit /
  // reorder chapters while collapsed; only the Act row visibility changes.
  // Default: collapsed, since most users won't define acts.
  chapterHeaderActsCollapsed: true,
  toggleChapterHeaderActs: () =>
    set((s) => ({ chapterHeaderActsCollapsed: !s.chapterHeaderActsCollapsed })),

  // Phase 1.11 Bug 3 — full chapter-header-row collapse. When true, the
  // entire chapter/acts overlay is hidden and the canvas toolbar shifts up
  // into the space it freed. Intended for users who don't plan to use
  // chapters or acts at all. Only meaningful / settable when the story has
  // zero chapters — the top-header re-expand button and the in-overlay
  // collapse chevron are both gated on `chapters.length === 0`. Default:
  // expanded so new users see the feature exists.
  chapterHeaderCollapsed: false,
  toggleChapterHeaderCollapsed: () =>
    set((s) => ({ chapterHeaderCollapsed: !s.chapterHeaderCollapsed })),

  entityModalPendingPosition: null,

  // Phase 1.24d — Global Search modal (Ctrl+F).
  // Centred modal that searches all writer-authored text across the
  // project: entities, scenes, relationships, knowledges, attributes,
  // aliases, transitions, chapters, acts, etc. Three discovery
  // affordances flip the same flag: keyboard shortcut (Ctrl+F /
  // Cmd+F), hamburger menu Find entry, and a top-bar quick-find
  // button. Closing (Esc, ✕, click-outside, or after navigating to a
  // result) flips back to false; the modal also clears its query on
  // close so the next open starts blank.
  globalSearchOpen: false,
  openGlobalSearch: () => {
    // Flush any not-yet-debounced editor edits so the search engine
    // sees the latest text on first keystroke. The right-sidebar
    // TipTap editor (RightSidebar.jsx) holds in-flight content in a
    // `pendingContent` ref and only pushes to the store on a 400ms
    // debounce — without this nudge, a writer who hits Ctrl+F right
    // after typing wouldn't see the just-typed text in results.
    const flushers = get()._pendingEditFlushers
    if (flushers) for (const fn of flushers) { try { fn() } catch { /* best-effort */ } }
    set({ globalSearchOpen: true })
  },
  closeGlobalSearch: () => set({ globalSearchOpen: false }),

  // Phase 1.26 — Input-port wire-list popup. Clicking a target Handle
  // that has at least one connected wire opens this popup at the port,
  // listing each incoming wire (with source label, go-to-source action,
  // and sever action). Anchor is captured at click time as a screen-space
  // rect; the popup positions itself in fixed coordinates and closes on
  // outside click / Escape. `hoveredWireId` is the row currently
  // hover-highlighted in the popup; edge components subscribe to it and
  // light up when matched, so the user can identify which wire each
  // popup row refers to before acting.
  wireListPopup: null,           // null | { nodeId, handleId, anchorRect: {left, top, right, bottom, width, height} }
  hoveredWireId: null,           // null | string
  openWireListPopup: ({ nodeId, handleId, anchorRect }) => set({
    wireListPopup: { nodeId, handleId: handleId ?? null, anchorRect },
    hoveredWireId: null,
  }),
  closeWireListPopup: () => set({ wireListPopup: null, hoveredWireId: null }),
  setHoveredWireId: (id) => set({ hoveredWireId: id ?? null }),

  // Phase 1.26 — Scene Detail Panel POV-only navigation toggle. When true,
  // the scene nav bar's back / forward arrows step through ONLY scenes
  // that have at least one character with `has_pov === true`; when false
  // (default), they step through every scene in global story order.
  // Session-only — resets to false on program start. Auto-flipped to
  // false when the writer navigates to a non-POV scene with the toggle
  // on (the SceneDetailView watches for this and resets the flag, so
  // the writer always sees a coherent nav universe).
  povNavOnly: false,
  setPovNavOnly: (v) => set({ povNavOnly: !!v }),
  togglePovNavOnly: () => set((s) => ({ povNavOnly: !s.povNavOnly })),

  toggleGlobalSearch: () => {
    const next = !get().globalSearchOpen
    if (next) {
      const flushers = get()._pendingEditFlushers
      if (flushers) for (const fn of flushers) { try { fn() } catch { /* best-effort */ } }
    }
    set({ globalSearchOpen: next })
  },

  // Pending-edit flushers — components with debounced edit state
  // (e.g. the right-sidebar TipTap editor's `pendingContent`)
  // register a function here; `openGlobalSearch` (and any other
  // caller that needs latest text) invokes them all before reading
  // store state. Set, not array, so re-registration is idempotent.
  _pendingEditFlushers: new Set(),
  registerPendingEditFlusher: (fn) => {
    if (typeof fn !== 'function') return () => {}
    const flushers = get()._pendingEditFlushers
    flushers.add(fn)
    return () => flushers.delete(fn)
  },

  // ── Canvas viewport center callback ──────────────────────────────────────────
  // Registered by the Canvas component; returns { x, y } in flow coordinates
  // for the center of the current viewport. Used as default position for new nodes.
  _getViewportCenter: null,
  setGetViewportCenter: (fn) => set({ _getViewportCenter: fn }),

  // ── Canvas focus-node callback ────────────────────────────────────────────────
  // Registered by the Canvas component; pans/zooms the viewport to center on a node.
  _focusNode: null,
  setFocusNode: (fn) => set({ _focusNode: fn }),

  // Pans/zooms the viewport to fit a list of node ids with optional padding.
  // Registered by Canvas alongside _focusNode. Used when an effect needs
  // to frame multiple nodes simultaneously (e.g. an egg-spawned pair).
  _fitViewToNodes: null,
  setFitViewToNodes: (fn) => set({ _fitViewToNodes: fn }),

  // ── Alerts panel ──────────────────────────────────────────────────────────────
  alertsPanelOpen: false,
  toggleAlertsPanel: () => set((s) => ({ alertsPanelOpen: !s.alertsPanelOpen })),

  // ── Table of contents panel (Phase 1.11 Track H) ──────────────────────────
  // Floating flyout anchored to the TOC button on the LEFT side of the
  // chapter header row. Lists acts → chapters → POV-chain scenes and lets
  // the user click any level to refocus the viewport onto that scope.
  tocPanelOpen: false,
  toggleTocPanel: () =>
    set((s) => ({
      tocPanelOpen: !s.tocPanelOpen,
      // Mutual exclusion with the Timeline Navigator — only one of
      // these two flyouts should be visible at a time since they
      // anchor to the same region of the chapter header row.
      timelineNavPanelOpen: s.tocPanelOpen ? s.timelineNavPanelOpen : false,
      // Phase 1.24b — toggling the TOC panel via the canvas toolbar
      // (or any other surface that calls `toggleTocPanel`) clears the
      // entity-filter so the panel shows its full unfiltered listing.
      // The POV-only toggle is independent and stays at the writer's
      // current preference.
      tocFilter: null,
    })),
  closeTocPanel: () =>
    set({
      tocPanelOpen: false,
      // Phase 1.24b — closing the TOC always clears the entity-filter.
      // Project switches call this directly (regardless of pin) so a
      // stale filter never survives a project switch.
      tocFilter: null,
    }),

  // Table of Contents panel filter: when true, only POV-chain scenes are
  // listed; when false (default), every sceneNode in global story
  // order is listed, including non-POV and flashback scenes. Persisted in
  // the ui slice so the user's preference survives close / reopen of the
  // panel.
  tocPovOnly: false,
  setTocPovOnly: (val) => set({ tocPovOnly: !!val }),

  // Phase 1.24b — Filtered TOC ("Appearances"). When set, the TOC
  // panel only lists scenes that contain the source object (entity /
  // relationship / knowledge); composes with `tocPovOnly` so a writer
  // can have BOTH active and see "POV-chain scenes containing Alice".
  // Set by `ShowInTocButton` on Detail Panels; cleared by the canvas-
  // toolbar TOC toggle, the TOC panel close, or a project switch.
  // Replace-on-second-click is implicit because `setTocFilter`
  // overwrites without merging.
  tocFilter: null,
  setTocFilter: (type, id) => {
    const validType = type === 'entity' || type === 'relationship' || type === 'knowledge'
    if (!validType || !id) return
    set({ tocFilter: { type, id } })
  },
  clearTocFilter: () => set({ tocFilter: null }),

  // ── Timeline Navigator panel (Phase 1.12c) ────────────────────────────────
  // Floating flyout anchored to the Timeline button on the LEFT side of
  // the chapter header row, sibling to the TOC button. Reuses the
  // Phase 1.12b Entity Import `TimelineGridView` component as a canvas
  // navigation surface: the grid shows every entity row with its scene
  // + modifier dots, clicking a dot pans + zooms the canvas to that
  // node and opens the entity's Detail Panel in the left sidebar.
  // Mutually exclusive with the TOC panel — opening one closes the
  // other via the toggle actions below.
  timelineNavPanelOpen: false,
  toggleTimelineNavPanel: () =>
    set((s) => ({
      timelineNavPanelOpen: !s.timelineNavPanelOpen,
      tocPanelOpen: s.timelineNavPanelOpen ? s.tocPanelOpen : false,
    })),
  closeTimelineNavPanel: () => set({ timelineNavPanelOpen: false }),

  // ── Export dialog (Phase 1.12a Track 5) ────────────────────────────────
  // Modal picker for HTML / Markdown / PDF narrative export. Opens via
  // the Export button in the top header bar; reads the currently-loaded
  // story from projectStore, posts the user's chosen options to the
  // backend, and triggers a download of the resulting file.
  exportDialogOpen: false,
  openExportDialog: () => set({ exportDialogOpen: true }),
  closeExportDialog: () => set({ exportDialogOpen: false }),

  // ── Import dialog (Phase 1.12b Track 3) ────────────────────────────────
  // Modal picker for importing entities from a source `.nnz` file.
  // Opens via the Import / Export dropdown in the top header bar.
  importDialogOpen: false,
  openImportDialog: () => set({ importDialogOpen: true }),
  closeImportDialog: () => set({ importDialogOpen: false }),

  // ── Novelcrafter import dialog (Phase 3.1) ──────────────────────────────
  // Modal for importing a Novelcrafter `.zip` export bundle into a fresh
  // NarrativeNode project. Opens via the Import flyout in the hamburger menu.
  ncImportDialogOpen: false,
  openNcImportDialog: () => set({ ncImportDialogOpen: true }),
  closeNcImportDialog: () => set({ ncImportDialogOpen: false }),

  // ── Template import dialog (Phase 1.25h) ────────────────────────────────
  // Modal for importing a populated markdown story template.
  templateImportDialogOpen: false,
  openTemplateImportDialog: () => set({ templateImportDialogOpen: true }),
  closeTemplateImportDialog: () => set({ templateImportDialogOpen: false }),

  // ── Help panel + help mode (Phase 1.27 / 6.2) ──────────────────────────
  // In-app help modal (browse layer). Opens via the hamburger menu's Help
  // entry (no target = browse from the root surface).
  helpPanelOpen: false,
  // Optional { surface, region } the panel should jump to on open — set by
  // help mode's click-to-inspect so the panel lands on the clicked element's
  // surface with its region pre-selected. null = open to the browse root.
  helpTarget: null,
  openHelpPanel: (target = null) => set({ helpPanelOpen: true, helpTarget: target }),
  closeHelpPanel: () => set({ helpPanelOpen: false }),
  clearHelpTarget: () => set({ helpTarget: null }),

  // Help mode: click-to-inspect. While active, the next click on any UI
  // element opens the Help panel jumped to that element's surface, then
  // exits (one-shot). Entered via the menu-bar Help button or Ctrl+H;
  // cancelled with Esc. Uncovered elements fall back to their nearest
  // covered ancestor surface (resolved in utils/helpRegionResolver.js).
  helpMode: false,
  setHelpMode: (v) => set({ helpMode: !!v }),
  toggleHelpMode: () => set((s) => ({ helpMode: !s.helpMode })),

  // ── Hierarchy editor modal (Phase 1.18B Track 5) ────────────────────────
  // Tree-view popup for editing location / faction hierarchy. Entity type
  // determines which HierarchyTreeView filter is used.
  hierarchyEditorOpen: false,
  hierarchyEditorEntityType: null,  // 'location' | 'faction' | null
  openHierarchyEditor: (entityType) => set({ hierarchyEditorOpen: true, hierarchyEditorEntityType: entityType }),
  closeHierarchyEditor: () => set({ hierarchyEditorOpen: false, hierarchyEditorEntityType: null }),

  // ── Scene time modal (Phase 1.23 step 8) ────────────────────────────────
  // Canonical editor for a scene's time-tracking fields. While the
  // POV-chain walker (step 7) and persistence (step 9) are under
  // construction, opening with `sceneId = null` shows the modal in
  // preview mode against transient draft state — useful for evaluating
  // layout in real modal context, decoupled from any scene's data.
  sceneTimeModalOpen: false,
  sceneTimeModalSceneId: null,
  openSceneTimeModal: (sceneId = null) => set({ sceneTimeModalOpen: true, sceneTimeModalSceneId: sceneId }),
  closeSceneTimeModal: () => set({ sceneTimeModalOpen: false, sceneTimeModalSceneId: null }),

  // ── Faction member wire prompt ────────────────────────────────────────────
  // Shown when wiring any entity origin node → a faction origin node.
  // Params: { sourceEntityId, sourceEntityName, targetEntityId, factionName,
  //           membershipRelId, sourceNodeId, targetNodeId, capturedSourceHandle }
  factionMemberPrompt: null,
  openFactionMemberPrompt: (params) => set({ factionMemberPrompt: params }),
  closeFactionMemberPrompt: () => set({ factionMemberPrompt: null }),


  openNewEntityModal: (type = 'character', position = null) =>
    set({ entityModalOpen: true, entityModalEntityId: null, entityModalInitialType: type, entityModalPendingPosition: position }),

  closeEntityModal: () =>
    set({ entityModalOpen: false, entityModalEntityId: null, entityModalPendingPosition: null }),

  // ── Knowledge create modal (Phase 1.21c) ──────────────────────────────────
  // Knowledge is a first-class object (not an Entity subtype) post-Phase 1.21c
  // refactor. Create flow parallels openNewEntityModal but mounts a separate
  // component (KnowledgeModal) since Knowledge has no type / parent / category
  // / attributes — only name, colour, description, profile image, awareness.
  knowledgeModalOpen: false,
  // `knowledgeModalPendingPosition` mirrors `entityModalPendingPosition`.
  // Set when the user opens the modal from a canvas right-click (via
  // `AddNodesMenuBody`); KnowledgeModal reads it on save and passes it
  // to `addKnowledgeOriginNodeToCanvas` so the origin node spawns where
  // the user clicked. Null when the modal was opened from the library
  // row (origin node falls back to viewport centre).
  knowledgeModalPendingPosition: null,
  // Optional back-pointer + suggested-name carried in when the modal
  // is opened from a change sub-chip's "Add knowledge of this change"
  // → "Make a new Knowledge" path. The modal pre-fills the name with
  // `suggestedName` and persists `sourceEvent` onto the new
  // Knowledge's `source_event` baseline. Null on the standard
  // library / canvas "+ New Knowledge" path.
  knowledgeModalPendingSource: null,
  openNewKnowledgeModal: (position = null, pendingSource = null) =>
    set({
      knowledgeModalOpen: true,
      knowledgeModalPendingPosition: position,
      knowledgeModalPendingSource: pendingSource,
    }),
  closeKnowledgeModal: () =>
    set({
      knowledgeModalOpen: false,
      knowledgeModalPendingPosition: null,
      knowledgeModalPendingSource: null,
    }),

  // ── Aliases Panel modal (Phase 1.21e) ───────────────────────────────────────
  // Tabbed modal for editing an entity's aliases — one tab per alias + a
  // trailing "+" tab to add. Each tab body has the alias value field, an
  // `<AwarenessPicker surface="alias">` bound to that alias's `awareness`
  // field (4-level scale), and a "Remove this alias" button.
  // Coexists with the inline `AliasTagEditor` in the entity Detail Panel —
  // the tag editor remains for value-only quick edits, the panel adds the
  // awareness controls.
  // ── Awareness Surface Panel (universal) ─────────────────────────────
  // Single uiStore slice driving the unified `AwarenessSurfacePanel`
  // — replaces the legacy aliasesPanel* + attributesAwarenessPanel*
  // slices. Kind-aware: handles every awareness-bearing surface in
  // the project through one panel and one shell.
  //
  // Shape when open:
  //   {
  //     kind:    'aliases' | 'attributes' | 'entity' | 'relationship' | 'knowledge',
  //     ids:     { entityId? | relationshipId? | knowledgeId? },
  //     anchor:  { kind: 'origin' | 'chain', nodeId? },
  //     initialItem?: (kind-specific) — pre-select a sub-item:
  //                   attributes → attributeId
  //                   aliases    → { kind: 'name' } | { kind: 'alias', value }
  //   }
  awarenessSurfacePanel: null,
  openAwarenessSurfacePanel: (config) => set({ awarenessSurfacePanel: config }),
  closeAwarenessSurfacePanel: () => set({ awarenessSurfacePanel: null }),

  // ── Add-Knowledge-From-Change popover ────────────────────────────
  // Driven by the hover-revealed "Add knowledge of this change" button
  // on each value/structural-change sub-chip. Opens a small popover
  // anchored to the click point with two options: make a new Knowledge
  // representing the change (Path A) or attach this change as a chain
  // entry on an existing Knowledge (Path B).
  //
  // Shape when open: {
  //   anchorRect: DOMRect,                  // for popover positioning
  //   sourceEvent: SourceEventRef,          // back-pointer to the triggering change
  //   suggestedName: string,                // auto-suggested Knowledge name (Path A)
  //   triggerNodeId: string,                // scene the change is anchored at
  // }
  addKnowledgeFromChangePopover: null,
  openAddKnowledgeFromChangePopover: (config) => set({ addKnowledgeFromChangePopover: config }),
  closeAddKnowledgeFromChangePopover: () => set({ addKnowledgeFromChangePopover: null }),

  // Back-compat shims for callers that haven't migrated yet — open the
  // unified panel with the matching kind. New callers should use
  // `openAwarenessSurfacePanel` directly with an explicit kind.
  openAliasesPanel: (entityId, anchor = { kind: 'origin', nodeId: null }, initialItem = null) =>
    set({ awarenessSurfacePanel: { kind: 'aliases', ids: { entityId }, anchor, initialItem } }),
  openAttributesAwarenessPanel: (entityId, anchor = { kind: 'origin', nodeId: null }, initialAttrId = null) =>
    set({ awarenessSurfacePanel: { kind: 'attributes', ids: { entityId }, anchor, initialItem: initialAttrId } }),

  // ── Delete Entity Dialog (shared across Canvas, EntityNode, EntityLibraryPanel) ──
  deleteEntityDialog: null, // { entityId, entityName, entityColour, chipCount, nodeId (optional), isOrigin }

  openDeleteEntityDialog: (data) => set({ deleteEntityDialog: data }),
  closeDeleteEntityDialog: () => set({ deleteEntityDialog: null }),

  // ── Convert Entity Dialog (Phase 8.4 Convert To) ──
  // { entityId, entityName, entityColour, sourceType, targetType }
  convertEntityDialog: null,
  openConvertEntityDialog: (data) => set({ convertEntityDialog: data }),
  closeConvertEntityDialog: () => set({ convertEntityDialog: null }),

  // ── Dismissed uninstantiated alerts ────────────────────────────────────────────
  // Tracks entity IDs whose "no origin node" alert has been dismissed by the user.
  // Cleared automatically when the entity gains an origin node (so removal triggers a fresh alert).
  dismissedUninstantiatedIds: {},
  dismissUninstantiatedAlert: (entityId) =>
    set((s) => ({ dismissedUninstantiatedIds: { ...s.dismissedUninstantiatedIds, [entityId]: true } })),
  clearDismissedUninstantiated: (entityIds) =>
    set((s) => {
      const next = { ...s.dismissedUninstantiatedIds }
      let changed = false
      for (const id of entityIds) { if (next[id]) { delete next[id]; changed = true } }
      return changed ? { dismissedUninstantiatedIds: next } : {}
    }),

  // ── Dismissed solo-relationship alerts ────────────────────────────────────────
  // Tracks relationship IDs whose "only 1 participant remains" alert has been
  // dismissed by the user ("Keep as-is"). Cleared automatically if the relationship
  // gains a second participant (so a new solo-drop fires a fresh alert).
  dismissedSoloRelIds: {},
  dismissSoloRelAlert: (relId) =>
    set((s) => ({ dismissedSoloRelIds: { ...s.dismissedSoloRelIds, [relId]: true } })),
  clearDismissedSoloRels: (relIds) =>
    set((s) => {
      const next = { ...s.dismissedSoloRelIds }
      let changed = false
      for (const id of relIds) { if (next[id]) { delete next[id]; changed = true } }
      return changed ? { dismissedSoloRelIds: next } : {}
    }),

  // ── Dismissed downstream-overlap alerts ──────────────────────────────────────
  // Tracks `${relId}:${conflictRelId}` pair keys whose "relationship X overlaps
  // with Y starting at scene Z" alert has been dismissed (user acknowledging
  // the overlap is intentional, e.g. parallel rels by design). Cleared
  // automatically when the superset relation no longer holds — either rel's
  // participants diverge such that the conflict set no longer contains all
  // of the flagged rel's participants.
  // Dismissed awareness-membership-change alerts. Keyed on the alert's
  // `id` (which encodes event kind + source id + leaving entity id +
  // node + consumer surface id). When the user clicks "Confirm new
  // level" / "Confirm no awareness" the alert is suppressed for the
  // session. Not persisted to disk — same volatility as the other
  // dismissed-alert sets above.
  dismissedMembershipAlertIds: {},
  dismissMembershipAlert: (alertId) =>
    set((s) => ({ dismissedMembershipAlertIds: { ...s.dismissedMembershipAlertIds, [alertId]: true } })),

  // Dismissed alias-linkage / entity-existence inconsistency alerts.
  // Keyed on the alert's id (encodes entity + observer + anchor node).
  dismissedInconsistencyAlertIds: {},
  dismissInconsistencyAlert: (alertId) =>
    set((s) => ({ dismissedInconsistencyAlertIds: { ...s.dismissedInconsistencyAlertIds, [alertId]: true } })),

  // Awareness-rollover modal state. Null when closed. When open, holds a
  // paginated list of awareness rollover pages — one per tracked field
  // touched by the most recent value commit. Each page renders the
  // universal AwarenessPicker pre-populated with the resolved entries
  // at the anchor; OK iterates pages and writes per-page diffs through
  // commitAwarenessAtAnchor. Single-page commits skip the carousel
  // chrome (no Next / Prev / counter).
  // Shape: {
  //   pages: [{
  //     fieldLabel,        // user-facing label for the title
  //     target,            // awareness target descriptor (entity_name / attribute / alias / relationship / knowledge)
  //     anchor,            // { kind: 'chain', nodeId }
  //     priorWrapper,      // resolved wrapper at the anchor BEFORE the commit
  //     draft,             // wrapper reflecting user's picker edits this session
  //   }],
  //   currentPageIdx: 0,
  // }
  // ── Phase 2.5g image-crop modal request ─────────────────────────
  // App-root `<ImageCropHost />` reads this and renders a `CropModal`
  // when set. Call `openImageCropModal({ imageSrc, onConfirm, title? })`
  // to drive it from any code path (the apply-as-avatar flow and the
  // drag-and-drop drop targets in Phase 2.5g both go through here).
  // `onConfirm` receives a 256×256 JPEG Blob; the caller does the
  // upload + chain-aware store write. Cleared on cancel / confirm by
  // the host component.
  imageCropRequest: null,
  openImageCropModal: (config) => set({ imageCropRequest: config }),
  closeImageCropModal: () => set({ imageCropRequest: null }),

  // ── Phase 5.2b story-cover refresh signal ───────────────────────
  // The active project's cover lives in the backend working dir, not in
  // any store. Components that display it (the Story Settings control,
  // the empty Detail Panel) fetch the has-cover flag and cache-bust the
  // <img> off this counter. Bump it whenever the cover is set / cleared
  // so every cover view refreshes without a shared cover-bytes state.
  coverVersion: 0,
  bumpCoverVersion: () => set((s) => ({ coverVersion: s.coverVersion + 1 })),

  // ── Phase 5.5 story library view ────────────────────────────────
  // Full-screen library surface, opened on demand from the hamburger
  // "Library" entry (and, later, shown on startup). Covers the canvas
  // while open; Close returns to the editor.
  libraryOpen: false,
  openLibrary: () => set({ libraryOpen: true }),
  closeLibrary: () => set({ libraryOpen: false }),

  // ── Phase 2.5g avatar drop-target hover counter ──────────────────
  // Incremented by `useProfileImageDropTarget`'s `onDragEnter` when
  // an avatar target accepts the current drag; decremented on
  // `onDragLeave` / `onDrop`. Canvas.jsx's "Drop to create a media
  // reference" overlay hides itself when this count is > 0, since
  // the writer is targeting an avatar (which paints its own dashed
  // highlight) — the canvas-wide overlay text would be misleading
  // there. Reset to 0 on any document-level drag end so a stuck
  // counter from a bug or detached element doesn't strand the
  // overlay state.
  avatarDropOverCount: 0,
  incAvatarDropOver: () => set((s) => ({ avatarDropOverCount: s.avatarDropOverCount + 1 })),
  decAvatarDropOver: () => set((s) => ({ avatarDropOverCount: Math.max(0, s.avatarDropOverCount - 1) })),
  resetAvatarDropOver: () => set({ avatarDropOverCount: 0 }),

  awarenessRolloverModal: null,
  openAwarenessRolloverModal: (config) => set({ awarenessRolloverModal: config }),
  setAwarenessRolloverDraft: (pageIdx, draft) =>
    set((s) => {
      const m = s.awarenessRolloverModal
      if (!m) return {}
      const pages = m.pages.map((p, i) => i === pageIdx ? { ...p, draft } : p)
      return { awarenessRolloverModal: { ...m, pages } }
    }),
  setAwarenessRolloverPage: (pageIdx) =>
    set((s) => {
      const m = s.awarenessRolloverModal
      if (!m) return {}
      if (pageIdx < 0 || pageIdx >= m.pages.length) return {}
      return { awarenessRolloverModal: { ...m, currentPageIdx: pageIdx } }
    }),
  closeAwarenessRolloverModal: () => set({ awarenessRolloverModal: null }),

  dismissedDownstreamOverlapIds: {},
  dismissDownstreamOverlapAlert: (key) =>
    set((s) => ({ dismissedDownstreamOverlapIds: { ...s.dismissedDownstreamOverlapIds, [key]: true } })),
  clearDismissedDownstreamOverlaps: (keys) =>
    set((s) => {
      const next = { ...s.dismissedDownstreamOverlapIds }
      let changed = false
      for (const k of keys) { if (next[k]) { delete next[k]; changed = true } }
      return changed ? { dismissedDownstreamOverlapIds: next } : {}
    }),

  // ── Sidebar top-level tab ─────────────────────────────────────────────────────
  // 'library' = entity library view; 'details' = entity/scene detail view
  sidebarTab: 'library',
  setSidebarTab: async (tab) => {
    const s = get()
    // Phase 3.4 Bugs & Fixes — when switching AWAY from the Details
    // tab (where the in-flight draft lives), route through the same
    // unsaved-changes navigation guard the entity-switch + panel-
    // close paths use. Without this, clicking the "Library" tab
    // silently discarded any dirty draft on the active detail view.
    // Switching INTO Details is always safe (the draft is preserved
    // by being shell-level state on `_detailPanelDraft`).
    const leavingDetails = s.sidebarTab === 'details' && tab !== 'details'
    if (leavingDetails && s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
      set({ sidebarTab: tab, _navigationGuard: null })
      return
    }
    set({ sidebarTab: tab })
  },

  // ── Library selection (tagged) ─────────────────────────────────────────────
  // Used to select an entity or relationship in the library tab and route
  // to the correct detail panel. Separate from detailPanelEntityId which
  // manages the entity/scene detail view for canvas selections.
  activeSelection: null,  // { kind: 'entity' | 'relationship', id: string, atNodeId?: string } | null
  setActiveSelection: (selection) => set({ activeSelection: selection }),
  clearActiveSelection: () => set({ activeSelection: null }),
  // Both `openRelationshipDetail` / `openKnowledgeDetail` consult the nav
  // guard before switching the panel's active subject — so a dirty draft
  // on whatever's currently displayed (entity / relationship / knowledge /
  // scene) gets the same Unsaved-changes popup the navigate-away paths
  // do. On Cancel, no state change. On Save / Discard, the slot is
  // already cleaned by the hook's resolver, then the `set` proceeds.
  openRelationshipDetail: async (relId, atNodeId = null) => {
    const s = get()
    if (s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
    }
    set({
      activeSelection: { kind: 'relationship', id: relId, atNodeId },
      sidebarTab: 'details',
      detailPanelMode: null,
      detailPanelNodeId: null,
      detailPanelEntityId: null,
      detailPanelChainIndex: -1,
      detailPanelSubTab: null,
      _navigationGuard: null,
    })
  },
  openKnowledgeDetail: async (knowledgeId, atNodeId = null) => {
    const s = get()
    if (s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
    }
    set({
      activeSelection: { kind: 'knowledge', id: knowledgeId, atNodeId },
      sidebarTab: 'details',
      detailPanelMode: null,
      detailPanelNodeId: null,
      detailPanelEntityId: null,
      detailPanelChainIndex: -1,
      detailPanelSubTab: null,
      _navigationGuard: null,
    })
  },
  // Phase 8.6 — open the left-sidebar detail panel for a Concept / Note
  // reference node. `nodeId` is the referenceNode's own id (concepts / notes
  // are not chain-tracked, so there is no separate chain anchor). Mirrors
  // openKnowledgeDetail: nav-guard-aware, drives selection through
  // `activeSelection` and clears the entity/scene mode slots.
  openReferenceDetail: async (nodeId) => {
    const s = get()
    if (s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
    }
    set({
      activeSelection: { kind: 'reference', id: nodeId },
      sidebarTab: 'details',
      detailPanelMode: null,
      detailPanelNodeId: null,
      detailPanelEntityId: null,
      detailPanelChainIndex: -1,
      detailPanelSubTab: null,
      _navigationGuard: null,
    })
  },

  openEntityAtRelationshipsTab: (entityId, atNodeId = null, chainIndex = -1) =>
    get().setDetailPanel(atNodeId ? 'entityChip' : 'entityNode', atNodeId, entityId, chainIndex, 'relationships'),

  // One-shot: open an entity at its ORIGIN on the Attributes tab and
  // auto-start the Add Attribute form, optionally pre-seeding the new
  // attribute's name/type via `detailPanelAddAttrPrefill` (consumed and
  // cleared by EntityDetailView when the form opens). Used by the
  // Character Chat setup modal's "Add Personality at Origin" shortcut.
  openEntityAttributeAddAtOrigin: async (entityId, prefill = null) => {
    if (!entityId) return
    set({ entityLibraryOpen: true })
    await get().setDetailPanel('entityNode', null, entityId, -1, 'attributes')
    set({ detailPanelShowAddAttr: true, detailPanelAddAttrPrefill: { entityId, ...(prefill || {}) } })
  },

  // ── Right sidebar (text editor / entity notes / knowledge notes) ───────────
  rightSidebarOpen: false,
  rightSidebarNodeId: null,            // which node is being edited (scene or reference note)
  rightSidebarEntityNotesId: null,     // entity whose author notes are open
  rightSidebarKnowledgeNotesId: null,  // knowledge whose author notes are open
  // Phase 2.5e — read-only text-attachment viewer. Populated when
  // the writer clicks a text-file pill on a chat message bubble;
  // the editor panel renders the file content as a read-only
  // TipTap code block. Shape: `{ name, content }` or null.
  // Mutually exclusive with the other context fields here.
  rightSidebarTextAttachment: null,
  // Phase 2.6 — Context Cue body editor. Populated when the writer
  // selects a Cue in the Entity Library's 🧩 section; the editor
  // panel loads the cue's TipTap-HTML body via `contextCuesStore`
  // and auto-saves on edit. Cue bodies were originally edited
  // inline in the library section, but the textarea felt too
  // cramped for substantial cues — routing through the right-
  // sidebar Editor panel gives the writer the same rich-text
  // surface used for scene main_content.
  rightSidebarContextCueId: null,
  // The five context fields above are mutually exclusive — only one is
  // non-null at a time; setters clear the other four.
  rightSidebarWidth: parseInt(localStorage.getItem('nn_rightSidebarWidth') || '400', 10),

  // Phase 2.8 — chat composer name detection + (optional) auto-
  // attach. Program-wide preference (localStorage-backed). Held in
  // uiStore not settingsStore so it doesn't surface in the Settings
  // modal — the toggle UI lives only in the in-composer popover.
  //
  // Semantics:
  //   - `chatHighlightNamesEnabled` (master) — when true, names of
  //     the configured types get detected and inline-coloured in
  //     the chat input. Visual only. This is what the main button
  //     toggles.
  //   - `chatAutoAttachEnabled` (subtoggle in the flyout) — when
  //     true AND the master is on, detected names additionally
  //     get auto-attached as pinned context pills above the input.
  //     The subtoggle has no effect when the master is off — it's
  //     a strict additive behaviour layered on top of the highlight.
  //   - `chatAutoAttachTypes` — per-type filter (cue / character /
  //     location / item / faction / custom / knowledge / relationship).
  //     Applies to both highlighting AND auto-attach; only kinds
  //     with `true` participate. All on by default.
  //
  // Effective behaviour for any given type T:
  //     highlight(T)  = chatHighlightNamesEnabled && chatAutoAttachTypes[T]
  //     autoAttach(T) = highlight(T) && chatAutoAttachEnabled
  // Defaults to ON for new installs: highlighting recognised names
  // is a low-cost visual aid that's discoverable through use. The
  // localStorage check uses `!== 'false'` so an explicit "false"
  // value persists across reloads but the absence of any value
  // means "default on".
  chatHighlightNamesEnabled: localStorage.getItem('nn_chatHighlightNamesEnabled') !== 'false',
  chatAutoAttachEnabled: localStorage.getItem('nn_chatAutoAttachEnabled') === 'true',
  chatAutoAttachTypes: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('nn_chatAutoAttachTypes') || 'null')
      if (stored && typeof stored === 'object') {
        return {
          cue: stored.cue !== false,
          character: stored.character !== false,
          location: stored.location !== false,
          item: stored.item !== false,
          faction: stored.faction !== false,
          custom: stored.custom !== false,
          knowledge: stored.knowledge !== false,
          relationship: stored.relationship !== false,
        }
      }
    } catch { /* fall through to defaults */ }
    return {
      cue: true, character: true, location: true, item: true,
      faction: true, custom: true, knowledge: true, relationship: true,
    }
  })(),
  setChatHighlightNamesEnabled: (v) => {
    const next = !!v
    localStorage.setItem('nn_chatHighlightNamesEnabled', String(next))
    set({ chatHighlightNamesEnabled: next })
  },
  setChatAutoAttachEnabled: (v) => {
    const next = !!v
    localStorage.setItem('nn_chatAutoAttachEnabled', String(next))
    set({ chatAutoAttachEnabled: next })
  },
  setChatAutoAttachType: (kind, v) => {
    const cur = get().chatAutoAttachTypes || {}
    const next = { ...cur, [kind]: !!v }
    localStorage.setItem('nn_chatAutoAttachTypes', JSON.stringify(next))
    set({ chatAutoAttachTypes: next })
  },

  // Phase 2.9c (writer spec 2026-05-27 follow-up) — editor's
  // "highlight detected names" toggle, lifted out of `RightSidebar`'s
  // local `useState` so the PBH prompt input (a TipTap-based
  // `ChatComposerTipTapInput`) can share the same on/off state and
  // per-type filter as the editor's `EntityHighlightExtension`.
  // localStorage-persisted so the writer's preference carries across
  // reloads. `editorHighlightEnabled` default TRUE (matches the
  // legacy RightSidebar.useState(true) initialiser).
  editorHighlightEnabled: localStorage.getItem('nn_editorHighlightEnabled') !== 'false',
  editorHighlightTypes: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('nn_editorHighlightTypes') || 'null')
      if (stored && typeof stored === 'object') {
        return {
          cue: stored.cue !== false,
          character: stored.character !== false,
          location: stored.location !== false,
          item: stored.item !== false,
          faction: stored.faction !== false,
          custom: stored.custom !== false,
          knowledge: stored.knowledge !== false,
          relationship: stored.relationship !== false,
        }
      }
    } catch { /* fall through to defaults */ }
    return {
      cue: true, character: true, location: true, item: true,
      faction: true, custom: true, knowledge: true, relationship: true,
    }
  })(),
  setEditorHighlightEnabled: (v) => {
    const next = !!v
    localStorage.setItem('nn_editorHighlightEnabled', String(next))
    set({ editorHighlightEnabled: next })
  },
  setEditorHighlightType: (kind, v) => {
    const cur = get().editorHighlightTypes || {}
    const next = { ...cur, [kind]: !!v }
    localStorage.setItem('nn_editorHighlightTypes', JSON.stringify(next))
    set({ editorHighlightTypes: next })
  },

  // Phase 2.9c — PBH (Prompt Block Header) auto-attach per-type
  // filter. Mirrors `chatAutoAttachTypes` for the same name-detection
  // kinds but lives separately so changing the PBH's kinds doesn't
  // affect the chat composer's selection (writers may want different
  // defaults across the two surfaces). The per-Section on/off master
  // toggle lives on `sectionPromptBlocksStore` (per-block, session-
  // only). All eight kinds default ON — writers can prune via the
  // toggle's flyout. localStorage-persisted (carries across reloads
  // like the chat-side equivalent).
  pbhAutoAttachTypes: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('nn_pbhAutoAttachTypes') || 'null')
      if (stored && typeof stored === 'object') {
        return {
          cue: stored.cue !== false,
          character: stored.character !== false,
          location: stored.location !== false,
          item: stored.item !== false,
          faction: stored.faction !== false,
          custom: stored.custom !== false,
          knowledge: stored.knowledge !== false,
          relationship: stored.relationship !== false,
        }
      }
    } catch { /* fall through to defaults */ }
    return {
      cue: true, character: true, location: true, item: true,
      faction: true, custom: true, knowledge: true, relationship: true,
    }
  })(),
  setPbhAutoAttachType: (kind, v) => {
    const cur = get().pbhAutoAttachTypes || {}
    const next = { ...cur, [kind]: !!v }
    localStorage.setItem('nn_pbhAutoAttachTypes', JSON.stringify(next))
    set({ pbhAutoAttachTypes: next })
  },

  // Phase 2.8 / v0.2.9.53 — pill-flash reminder map. Two-level shape:
  // `pillFlashAt[scope][key]` → timestamp. `scope` identifies the
  // surface that owns the flash (chat composer, a specific Prompt
  // Block Header, the Inline Prompt Block, the Scene Description
  // Section's PBH, etc.), so a flash fired by one surface never
  // bleeds into another surface's chips even if both have a pill
  // for the same (kind, id) at the same time. `key` is the
  // `${kind}:${id}` of the pill being flashed. `PinnedContextChip`
  // reads `pillFlashAt[flashScope]?.[key]` and, when the timestamp
  // is recent (< 1.2s), renders the flash CSS animation.
  //
  // Scope conventions:
  //   - 'chat'             → chat composer at the bottom of the chat panel
  //   - sectionId (UUID)   → Prompt Block Header on that Section
  //   - '__ipb__'          → Inline Prompt Block (singleton)
  //   - 'sd:<sceneId>'     → Scene Description Section's PBH
  //
  // Not persisted — purely a transient UI signal, lost on reload.
  pillFlashAt: {},
  flashPill: (scope, kind, id) => {
    if (!scope || !kind || !id) return
    const key = `${kind}:${id}`
    set((s) => ({
      pillFlashAt: {
        ...s.pillFlashAt,
        [scope]: { ...(s.pillFlashAt[scope] || {}), [key]: Date.now() },
      },
    }))
  },
  // Backwards-compat: legacy callers do `flashChatPill(kind, id)`.
  // Routes through the new scoped `flashPill` with the canonical
  // 'chat' scope so call sites that haven't been migrated still
  // behave correctly. New callers should use `flashPill` directly.
  flashChatPill: (kind, id) => {
    if (!kind || !id) return
    const key = `${kind}:${id}`
    set((s) => ({
      pillFlashAt: {
        ...s.pillFlashAt,
        chat: { ...(s.pillFlashAt.chat || {}), [key]: Date.now() },
      },
    }))
  },

  // Phase 1.24c — Editor scene-pin. When non-null, the editor stays
  // locked to that scene against AUTOMATIC switches (canvas selection
  // changing the editor target). Explicit button-driven navigation
  // (top-bar Editor button, "open notes" buttons, "open in editor"
  // buttons on scene / reference nodes, etc.) clears the pin and
  // swaps the editor as usual. Cleared on: pin button toggle off,
  // pinned scene deletion, project switch, right sidebar close.
  editorPinnedSceneId: null,
  setEditorPinnedScene: (sceneId) => set({ editorPinnedSceneId: sceneId || null }),
  clearEditorPinned: () => set({ editorPinnedSceneId: null }),
  toggleEditorPinned: () => set((s) => {
    if (s.editorPinnedSceneId) return { editorPinnedSceneId: null }
    // Pin to whichever scene the editor is currently showing. If the
    // editor isn't on a scene (entity / knowledge notes, reference
    // note, or empty), there's nothing to pin to.
    return { editorPinnedSceneId: s.rightSidebarNodeId || null }
  }),

  // Manual button-driven open: clears any pin (the user is intentionally
  // swapping the editor target). The Canvas auto-follow path uses the
  // separate `openRightSidebarAuto` so it can honour the pin.
  openRightSidebar: (nodeId) => set({ rightSidebarOpen: true, rightSidebarNodeId: nodeId, rightSidebarEntityNotesId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }),
  // Canvas auto-follow path: respects the pin. When pinned to a
  // different scene, this is a no-op so the editor keeps its loaded
  // scene while the writer navigates other scenes on the canvas /
  // detail panel for reference.
  openRightSidebarAuto: (nodeId) => set((s) => {
    if (s.editorPinnedSceneId && s.editorPinnedSceneId !== nodeId) return {}
    return { rightSidebarOpen: true, rightSidebarNodeId: nodeId, rightSidebarEntityNotesId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null }
  }),
  openEntityNotes: (entityId) => set({ rightSidebarOpen: true, rightSidebarEntityNotesId: entityId, rightSidebarNodeId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }),
  openKnowledgeNotes: (knowledgeId) => set({ rightSidebarOpen: true, rightSidebarKnowledgeNotesId: knowledgeId, rightSidebarNodeId: null, rightSidebarEntityNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }),
  // Phase 2.5e — read-only text-attachment viewer. Click toggles
  // closed when the same file is already showing (parity with other
  // open-foo-in-editor affordances). Clears any scene pin since the
  // writer is intentionally swapping the editor target.
  openTextAttachmentInEditor: (name, content) => set((s) => {
    const cur = s.rightSidebarTextAttachment
    if (s.rightSidebarOpen && cur && cur.name === name && cur.content === content) {
      return { rightSidebarOpen: false, rightSidebarTextAttachment: null }
    }
    return {
      rightSidebarOpen: true,
      rightSidebarTextAttachment: { name, content },
      rightSidebarNodeId: null,
      rightSidebarEntityNotesId: null,
      rightSidebarKnowledgeNotesId: null,
      rightSidebarContextCueId: null,
      editorPinnedSceneId: null,
    }
  }),
  // Phase 2.6 — Context Cue body editor. Same mutex pattern as the
  // other open-foo-in-editor setters: clears the other right-sidebar
  // context fields and any editor scene-pin (the writer is
  // intentionally swapping the editor target). Click-to-toggle the
  // same cue closes the editor again (matches the entity-notes /
  // knowledge-notes / text-attachment affordances).
  openContextCueEditor: (cueId) => set((s) => {
    if (s.rightSidebarOpen && s.rightSidebarContextCueId === cueId) {
      return {
        rightSidebarOpen: false,
        rightSidebarContextCueId: null,
      }
    }
    return {
      rightSidebarOpen: true,
      rightSidebarContextCueId: cueId,
      rightSidebarNodeId: null,
      rightSidebarEntityNotesId: null,
      rightSidebarKnowledgeNotesId: null,
      rightSidebarTextAttachment: null,
      editorPinnedSceneId: null,
    }
  }),
  closeRightSidebar: () => set({ rightSidebarOpen: false, rightSidebarNodeId: null, rightSidebarEntityNotesId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }),
  toggleRightSidebar: () => set((s) => {
    if (s.rightSidebarOpen) return { rightSidebarOpen: false, rightSidebarNodeId: null, rightSidebarEntityNotesId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }
    // Opening from the top-bar Editor button: pre-populate from the
    // currently-selected scene if the detail panel is on a scene. Without
    // this, the editor opened blank ("Select a scene node…") even when a
    // scene was visibly selected, forcing the user to deselect + reselect
    // to populate it.
    const seedNodeId = (s.detailPanelMode === 'scene' && s.detailPanelNodeId) ? s.detailPanelNodeId : null
    return { rightSidebarOpen: true, rightSidebarNodeId: seedNodeId, rightSidebarEntityNotesId: null, rightSidebarKnowledgeNotesId: null, rightSidebarTextAttachment: null, rightSidebarContextCueId: null, editorPinnedSceneId: null }
  }),
  setRightSidebarWidth: (w) => {
    localStorage.setItem('nn_rightSidebarWidth', String(w))
    set({ rightSidebarWidth: w })
  },

  // ── Chat panel (Phase 2.3a — placeholder, coexists with Editor) ────────────
  // Open/closed state is independent of the Editor's right-sidebar state:
  // both panels can be open at the same time per the planning-doc design
  // (right sidebar zone holds either panel or both, each with its own
  // collapse toggle, divider between them when both open). Panel body is
  // currently a placeholder; real chat UI lands in Phase 2.4. Drag-drop
  // docking and the orientation toggle are subsequent Phase 2.3a steps.
  chatPanelOpen: false,
  chatPanelWidth: parseInt(localStorage.getItem('nn_chatPanelWidth') || '400', 10),
  openChatPanel: () => set({ chatPanelOpen: true }),
  closeChatPanel: () => set({ chatPanelOpen: false }),
  toggleChatPanel: () => set((s) => ({ chatPanelOpen: !s.chatPanelOpen })),
  setChatPanelWidth: (w) => {
    localStorage.setItem('nn_chatPanelWidth', String(w))
    set({ chatPanelWidth: w })
  },

  // ── Phase 2.6 — Chat thread browser state (per-session) ────────────────────
  // Three writer-driven slots that drive the new tag-aware thread
  // browser. All session-only — never persisted to localStorage, lost
  // on reload so each session starts on the natural defaults.
  //
  //   chatBrowserActiveTab — 'all' or a `story_id` string. Picks
  //     which top-level grouping the browser shows. Reset to 'all'
  //     each session unless the project-load hook (Phase 2.6g)
  //     auto-selects the loaded story's tab.
  //   chatBrowserTagFilter — `{ and: string[], or: string[], not: string[] }`
  //     matching the `utils/tagFilter.js` predicate shape from
  //     Phase 2.6a. Combines with the active-tab filter via AND
  //     (planning doc: tab and tags are orthogonal). Defaults to
  //     the frozen EMPTY_TAG_FILTER's value-equivalent fresh
  //     object (own array refs so consumer mutations don't leak
  //     into the shared empty constant).
  //   chatBrowserExpandedCategories — `{ [story_id]: bool }` for
  //     the All-view grouped tree's per-parent expand/collapse
  //     state. Missing key = expanded (default-on so newly-seen
  //     categories don't hide their threads on first load).
  chatBrowserActiveTab: 'all',
  chatBrowserTagFilter: { and: [], or: [], not: [] },
  chatBrowserExpandedCategories: {},
  setChatBrowserActiveTab: (tab) => set({
    chatBrowserActiveTab: tab || 'all',
  }),
  setChatBrowserTagFilter: (filter) => set({
    chatBrowserTagFilter: filter || { and: [], or: [], not: [] },
  }),
  clearChatBrowserTagFilter: () => set({
    chatBrowserTagFilter: { and: [], or: [], not: [] },
  }),

  // Phase 2.8 — Context Cue library tag filter. Same `{and, or, not}`
  // shape the conversation browser uses (filtered through the same
  // `utils/tagFilter.js:matchesTagFilter` predicate). Defaults to
  // no filter; persists across renders within a session but is not
  // saved to disk.
  contextCuesTagFilter: { and: [], or: [], not: [] },
  setContextCuesTagFilter: (filter) => set({
    contextCuesTagFilter: filter || { and: [], or: [], not: [] },
  }),
  clearContextCuesTagFilter: () => set({
    contextCuesTagFilter: { and: [], or: [], not: [] },
  }),

  // Phase 3.4i — Entity Library tag filter. ONE shared filter state
  // that applies across EVERY entity-family library tab (Characters /
  // Locations / Items / Factions / Customs / Knowledge / Relationships
  // / Preset Lists / Reference Nodes). Persists across tab switches:
  // setting `#MAGIC` AND in the Characters tab still filters when the
  // writer switches to Locations. Deliberate cross-cutting state for
  // tag-driven discovery — "show me everything tagged #MAGIC" works
  // regardless of which entity-type tab is active.
  //
  // Filter arrays contain Project Tag UUIDs (NOT name strings — the
  // conversation / cue browsers use name strings because Program Tags
  // are per-host string lists; Project Tags are pool-id references).
  // Consumers feed the filter through `matchesProjectTagFilterBySet`
  // from `utils/tagFilter.js`, with the host's tag-id Set computed via
  // `chainWideTagIdsForHost` (chain-wide ever-tagged semantics).
  entityLibraryTagFilter: { and: [], or: [], not: [] },
  setEntityLibraryTagFilter: (filter) => set({
    entityLibraryTagFilter: filter || { and: [], or: [], not: [] },
  }),
  clearEntityLibraryTagFilter: () => set({
    entityLibraryTagFilter: { and: [], or: [], not: [] },
  }),

  // Phase 2.8 — Context Cue library sort. Pinned cues always group
  // at the top regardless of sort; within both pinned and unpinned
  // groups, this key drives the order.
  //   'manual'      — insertion order (newest-created at the
  //                   bottom) — the original behaviour and current
  //                   default
  //   'alpha-asc'   — name A → Z (case-insensitive)
  //   'alpha-desc'  — name Z → A
  //   'recent-desc' — `updated_at` newest → oldest
  //   'recent-asc'  — `updated_at` oldest → newest
  contextCuesSort: 'manual',
  setContextCuesSort: (key) => set({ contextCuesSort: key || 'manual' }),
  /** Toggle the expand / collapse state of one category in the
   *  All-view grouped tree. `story_id = null` is the "Untitled"
   *  pseudo-category; the JSON key is the literal string
   *  "__untitled__" so the object isn't sparse-keyed by `null`. */
  toggleChatBrowserCategoryExpanded: (storyId) => set((s) => {
    const key = storyId == null ? '__untitled__' : String(storyId)
    const current = s.chatBrowserExpandedCategories[key]
    // Missing key = expanded by default; the first click collapses.
    const next = current === false ? true : false
    return {
      chatBrowserExpandedCategories: {
        ...s.chatBrowserExpandedCategories,
        [key]: next,
      },
    }
  }),

  // ── Dock system: per-panel zone + per-zone orientation ──────────────────────
  // Phase 2.3a — items 3, 4, 5 of the panel layout sequence.
  // Each tab button (editor, chat) has a zone it's docked to. The panel renders
  // in whatever zone its button is docked to. Default for both: 'right'.
  // Each zone also has an orientation (side-by-side vs stacked) used when both
  // panels share that zone. Orientation set here but the visual toggle between
  // the two layouts is later sequence item 7 — for now stacked behaves the same
  // as side-by-side visually, the state just records the writer's preference.
  editorZone: 'right',                  // 'right' | 'bottom'
  chatZone: 'right',                    // 'right' | 'bottom'
  rightZoneOrientation: 'side-by-side', // 'side-by-side' | 'stacked'
  bottomZoneOrientation: 'side-by-side',
  bottomZoneHeight: parseInt(localStorage.getItem('nn_bottomZoneHeight') || '300', 10),

  setEditorZone: (zone) => set({ editorZone: zone }),
  setChatZone: (zone) => set({ chatZone: zone }),
  setRightZoneOrientation: (o) => set({ rightZoneOrientation: o }),
  setBottomZoneOrientation: (o) => set({ bottomZoneOrientation: o }),
  setBottomZoneHeight: (h) => {
    localStorage.setItem('nn_bottomZoneHeight', String(h))
    set({ bottomZoneHeight: h })
  },

  // Inter-panel split fractions for the zones where the editor + chat
  // panels share a single dimension. A value of 0.5 means an even 50/50
  // split between editor (first panel) and chat (second). Clamped to
  // [0.1, 0.9] at the drag callsite so neither panel can be shrunk to
  // zero. Stored as fractions so the layout stays sensible across
  // window resizes.
  // - bottomZoneEditorShare: editor's share of the bottom zone (width
  //   when side-by-side, height when stacked).
  // - rightZoneEditorShare: editor's share of the right zone when
  //   stacked vertically (height share). Right zone side-by-side uses
  //   each panel's own width so no shared split is needed there.
  bottomZoneEditorShare: parseFloat(localStorage.getItem('nn_bottomZoneEditorShare') || '0.5'),
  rightZoneEditorShare: parseFloat(localStorage.getItem('nn_rightZoneEditorShare') || '0.5'),
  setBottomZoneEditorShare: (f) => {
    localStorage.setItem('nn_bottomZoneEditorShare', String(f))
    set({ bottomZoneEditorShare: f })
  },
  setRightZoneEditorShare: (f) => {
    localStorage.setItem('nn_rightZoneEditorShare', String(f))
    set({ rightZoneEditorShare: f })
  },

  // ── Layout snapshot (Save / Reset default layout) ─────────────────────────
  // Phase 2.3a — the writer can save the current panel layout as a
  // default from Program Settings; it then auto-applies on app boot
  // when the localStorage session state hasn't been populated yet
  // (first install, or right after the writer hits Reset). The
  // snapshot is an opaque dict on `user_preferences.json`; the
  // frontend owns the schema.

  /** Capture the current layout state as a plain object suitable for
   *  round-tripping through `user_preferences.json`. Read by the
   *  "Save current layout as default" button in Program Settings. */
  getCurrentLayoutSnapshot: () => {
    const s = get()
    return {
      editor_zone: s.editorZone,
      chat_zone: s.chatZone,
      editor_open: s.rightSidebarOpen,
      chat_open: s.chatPanelOpen,
      right_zone_orientation: s.rightZoneOrientation,
      bottom_zone_orientation: s.bottomZoneOrientation,
      right_sidebar_width: s.rightSidebarWidth,
      chat_panel_width: s.chatPanelWidth,
      bottom_zone_height: s.bottomZoneHeight,
      right_zone_editor_share: s.rightZoneEditorShare,
      bottom_zone_editor_share: s.bottomZoneEditorShare,
    }
  },

  /** Apply a snapshot dict to the layout state. Each field is
   *  optional — missing fields leave their current values alone, so
   *  this stays forward-compatible if the snapshot schema grows.
   *  Writes to localStorage too via the existing setters so the
   *  applied layout persists as the new session state. */
  applyLayoutSnapshot: (snap) => {
    if (!snap || typeof snap !== 'object') return
    const updates = {}
    if (snap.editor_zone === 'right' || snap.editor_zone === 'bottom') {
      updates.editorZone = snap.editor_zone
    }
    if (snap.chat_zone === 'right' || snap.chat_zone === 'bottom') {
      updates.chatZone = snap.chat_zone
    }
    if (typeof snap.editor_open === 'boolean') {
      updates.rightSidebarOpen = snap.editor_open
    }
    if (typeof snap.chat_open === 'boolean') {
      updates.chatPanelOpen = snap.chat_open
    }
    if (snap.right_zone_orientation === 'side-by-side' || snap.right_zone_orientation === 'stacked') {
      updates.rightZoneOrientation = snap.right_zone_orientation
    }
    if (snap.bottom_zone_orientation === 'side-by-side' || snap.bottom_zone_orientation === 'stacked') {
      updates.bottomZoneOrientation = snap.bottom_zone_orientation
    }
    if (Number.isFinite(snap.right_sidebar_width)) {
      updates.rightSidebarWidth = snap.right_sidebar_width
      localStorage.setItem('nn_rightSidebarWidth', String(snap.right_sidebar_width))
    }
    if (Number.isFinite(snap.chat_panel_width)) {
      updates.chatPanelWidth = snap.chat_panel_width
      localStorage.setItem('nn_chatPanelWidth', String(snap.chat_panel_width))
    }
    if (Number.isFinite(snap.bottom_zone_height)) {
      updates.bottomZoneHeight = snap.bottom_zone_height
      localStorage.setItem('nn_bottomZoneHeight', String(snap.bottom_zone_height))
    }
    if (Number.isFinite(snap.right_zone_editor_share)) {
      updates.rightZoneEditorShare = snap.right_zone_editor_share
      localStorage.setItem('nn_rightZoneEditorShare', String(snap.right_zone_editor_share))
    }
    if (Number.isFinite(snap.bottom_zone_editor_share)) {
      updates.bottomZoneEditorShare = snap.bottom_zone_editor_share
      localStorage.setItem('nn_bottomZoneEditorShare', String(snap.bottom_zone_editor_share))
    }
    // Mark localStorage as initialised so the boot-time
    // "apply saved default if localStorage is empty" check won't
    // re-apply on top of the now-restored session state.
    localStorage.setItem('nn_layout_session_initialized', '1')
    set(updates)
  },

  /** True iff localStorage holds any session layout state — used by
   *  the boot logic to decide whether to fall back to the user's
   *  saved default (or built-in defaults) on a clean install /
   *  post-reset boot. Checks every layout-related localStorage key,
   *  not just the explicit init flag, so users carrying forward
   *  from earlier versions (where the flag didn't exist yet) still
   *  count as initialised. */
  hasLayoutSessionState: () => {
    const keys = [
      'nn_layout_session_initialized',
      'nn_rightSidebarWidth',
      'nn_chatPanelWidth',
      'nn_bottomZoneHeight',
      'nn_rightZoneEditorShare',
      'nn_bottomZoneEditorShare',
    ]
    return keys.some((k) => localStorage.getItem(k) !== null)
  },

  /** Wipe all layout-related localStorage keys and reset the
   *  in-memory layout state back to the built-in shipped defaults.
   *  Used by the "Reset layout to default" button in Program
   *  Settings, paired with a PUT that clears the saved snapshot on
   *  the backend. */
  resetLayoutToFactoryDefaults: () => {
    [
      'nn_rightSidebarWidth',
      'nn_chatPanelWidth',
      'nn_bottomZoneHeight',
      'nn_rightZoneEditorShare',
      'nn_bottomZoneEditorShare',
      'nn_layout_session_initialized',
    ].forEach((k) => localStorage.removeItem(k))
    set({
      editorZone: 'right',
      chatZone: 'right',
      rightSidebarOpen: false,
      chatPanelOpen: false,
      rightZoneOrientation: 'side-by-side',
      bottomZoneOrientation: 'side-by-side',
      rightSidebarWidth: 400,
      chatPanelWidth: 400,
      bottomZoneHeight: 300,
      rightZoneEditorShare: 0.5,
      bottomZoneEditorShare: 0.5,
    })
  },

  // Composite dock action: sets the panel's zone AND the destination zone's
  // orientation in one atomic update. Right-click menu items and (eventually)
  // drag-drop both route through this.
  dockPanel: (panel, zone, orientation) => set(() => {
    const update = {}
    if (panel === 'editor') update.editorZone = zone
    if (panel === 'chat') update.chatZone = zone
    if (zone === 'right') update.rightZoneOrientation = orientation
    if (zone === 'bottom') update.bottomZoneOrientation = orientation
    return update
  }),

  // Drag-and-drop state for tab buttons. When a tab button is being
  // actively dragged (mouse moved past the click-vs-drag threshold), this
  // holds the panel id ('editor' | 'chat'). The `<DockDropTargets>`
  // component subscribes to this to know whether to paint the dashed
  // drop-target outlines, and which zone-of-origin to omit. Cleared on
  // mouseup regardless of whether the drop landed on a target.
  dragTabPanel: null,
  setDragTabPanel: (panel) => set({ dragTabPanel: panel }),

  // ── Entity Detail Panel (left sidebar, context-aware) ───────────────────────
  // mode: null | 'scene' | 'entityNode' | 'entityNodeModifier' | 'entityChip'
  // nodeId: the canvas node currently viewed in the panel
  // entityId: which entity is being viewed (chip or entityNode modes)
  // chainIndex: position in the entity's narrative chain (−1 when not in chain mode)
  detailPanelMode: null,
  detailPanelNodeId: null,
  detailPanelEntityId: null,
  detailPanelChainIndex: -1,
  detailPanelSubTab: null,  // one-shot: 'details' | 'attributes' | 'relationships' — consumed by EntityDetailPanel
  // Persistent active sub-tab. Survives DetailPanel unmount/remount
  // (e.g. the brief sidebar 'library' flip during a canvas selection
  // transition that previously blew away the local-useState 'awareness'
  // pick on every entity-origin click). Reset only when the panel
  // navigates to a *different* entity. Default 'details' for fresh
  // openings.
  detailPanelActiveSubTab: 'details',
  setDetailPanelActiveSubTab: (tab) => set({ detailPanelActiveSubTab: tab }),
  // Awareness sub-tab section expansion state. Lives at the store
  // level (not in EntityDetailView's local state) so it survives the
  // unmount/remount that happens when the user navigates between an
  // entity's origin node, a chip on a scene, and modifier nodes — those
  // are rendered as separate `<EntityDetailView>` siblings inside
  // `DetailPanel.jsx`, so React unmounts the previous and mounts a new
  // one on mode change. Same pattern as `detailPanelActiveSubTab`.
  detailPanelKnownByExpanded: false,
  setDetailPanelKnownByExpanded: (v) => set({ detailPanelKnownByExpanded: v }),
  detailPanelShowAddAttr: false, // one-shot: when true, auto-open the "Add Attribute" form in EntityDetailPanel
  requestAddAttributeForm: () => set({ detailPanelShowAddAttr: true }),
  // Optional pre-seed ({ entityId, name, type }) for the auto-opened
  // Add Attribute form; consumed and cleared by EntityDetailView.
  detailPanelAddAttrPrefill: null,

  // ── Navigation guard ─────────────────────────────────────────────────────────
  // A view component with unsaved draft changes registers a guard function
  // here. `setDetailPanel` / `clearDetailPanel` invoke the guard before
  // navigating away; if the guard resolves to `false`, navigation is blocked.
  //
  // Phase 1.13 v0.1.13.3: the guard callback's return type is now
  // `boolean | Promise<boolean>`. Both `setDetailPanel` and
  // `clearDetailPanel` are async and `await` the guard, so guard callbacks
  // can open an async dialog (e.g. the shared `confirm()` helper from
  // `dialogStore.js`) and return a Promise<boolean> for the user's choice.
  // Legacy sync boolean-returning guards continue to work unchanged — `await`
  // on a non-promise just resolves immediately.
  //
  // All existing call sites of `setDetailPanel` / `clearDetailPanel` are
  // fire-and-forget (event handlers) — none chain synchronous operations
  // that depend on the guard resolving before the next line runs — so the
  // async cascade is invisible at the call sites.
  _navigationGuard: null,

  registerNavigationGuard: (guardFn) => set({ _navigationGuard: guardFn }),
  clearNavigationGuard: () => set({ _navigationGuard: null }),

  // ── Detail Panel draft (shell-level, single active draft at a time) ─────────
  // Holds the in-flight draft for whichever detail-view subject is currently
  // displayed. Lives in the store rather than in the active view's local
  // state so that:
  //   (a) the draft survives transient view unmount during canvas-click
  //       deselection (same reason `detailPanelActiveSubTab` lives here);
  //   (b) every detail-view kind shares ONE mechanism instead of forking a
  //       per-view useState(draft) block.
  // Consumed exclusively via the `useDetailPanelDraft` hook
  // (`frontend/src/hooks/useDetailPanelDraft.js`); store actions below are
  // the hook's read / write primitives — call sites in views should use the
  // hook, not these actions directly.
  _detailPanelDraft: null,
  _detailPanelDraftKey: null,
  _setDetailPanelDraft: (draft, draftKey = null) => set({
    _detailPanelDraft: draft,
    _detailPanelDraftKey: draftKey,
  }),

  setDetailPanel: async (mode, nodeId, entityId = null, chainIndex = -1, subTab = null) => {
    const s = get()
    // Only check the guard when the context is actually changing
    const isContextChange = s.detailPanelNodeId !== nodeId || s.detailPanelEntityId !== entityId || s.activeSelection != null
    if (isContextChange && s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
    }
    // Clear the nav guard ONLY when the context is actually changing —
    // on a same-node click the detail panel component is still mounted
    // on the same entity with its dirty draft intact, so its guard
    // registration must be preserved. The guard `useEffect` is keyed
    // on `isDirty`, which doesn't change on a same-node click, so the
    // panel wouldn't re-register a guard after the store nulled it,
    // and subsequent clicks would silently discard the draft. Phase
    // 1.13 v0.1.13.3 bug fix.
    const prevEntityId = s.detailPanelEntityId
    const update = {
      detailPanelMode: mode,
      detailPanelNodeId: nodeId,
      detailPanelEntityId: entityId,
      detailPanelChainIndex: chainIndex,
      detailPanelSubTab: subTab,
      sidebarTab: 'details',
    }
    // Persistent active sub-tab routing:
    //   - explicit `subTab` arg always wins (sub-chip click "open
    //     panel and switch to attributes" pattern).
    //   - otherwise, only reset to 'details' when navigating to a
    //     genuinely different entity. A null→same-entity transition
    //     (transient deselection during canvas click) preserves the
    //     user's current tab.
    if (subTab) {
      update.detailPanelActiveSubTab = subTab
    } else if (entityId && prevEntityId && entityId !== prevEntityId) {
      update.detailPanelActiveSubTab = 'details'
    }
    if (isContextChange) {
      update._navigationGuard = null
      update.activeSelection = null
    }
    set(update)
  },

  /**
   * Close the detail panel. Pass `{ force: true }` to bypass the registered
   * navigation guard — used by `projectStore` when the entity / node the
   * panel was showing has just been deleted out from under the user; at
   * that point the panel is stale and the guard prompt would point at
   * ghost data.
   */
  clearDetailPanel: async ({ force = false } = {}) => {
    const s = get()
    if (!force && s._navigationGuard) {
      const ok = await s._navigationGuard()
      if (!ok) return
    }
    set({
      detailPanelMode: null,
      detailPanelNodeId: null,
      detailPanelEntityId: null,
      detailPanelChainIndex: -1,
      detailPanelSubTab: null,
      // Atomic with detail-panel clear so Canvas-level deselection paths
      // don't need to fire `clearActiveSelection` separately (which used
      // to bypass the nav guard and blank a relationship/knowledge
      // panel even after the user picked Cancel).
      activeSelection: null,
      sidebarTab: 'library',
      _navigationGuard: null,
    })
  },

  // ── Developer preview panel ──────────────────────────────────────────────
  // Hidden reusable preview surface toggled via Ctrl+` from anywhere in the
  // app. Intended as a controlled space to render UI elements in isolation
  // while developing / reviewing visual consistency. Not surfaced in any
  // menu; the keyboard shortcut is the sole entry point. Panel content is
  // static (configured inline in `DevPreviewPanel.jsx`).
  devPreviewOpen: false,
  toggleDevPreview: () => set((s) => ({ devPreviewOpen: !s.devPreviewOpen })),
  closeDevPreview: () => set({ devPreviewOpen: false }),

  // ── Single-selected node (for wire highlighting) ─────────────────────────
  // Set to a node's ID when exactly one node is selected on the canvas and
  // it is NOT a sceneNode (those are already handled via detailPanelMode).
  // Set to null when selection is cleared, multiple nodes are selected, or
  // a sceneNode is selected. Used by edge components to highlight wires
  // connected to the selected node.
  singleSelectedNodeId: null,
  setSingleSelectedNodeId: (id) => set({ singleSelectedNodeId: id }),

  // Phase 8.2 — canvas wire-visibility filter. Session state (resets each
  // load); the program-settings default seeds it on launch. The two "chosen"
  // modes use `wireVisibilityTypes` to pick which wire kinds show (relationship
  // wires count as narrative); 'selection_chosen' also shows the current
  // selection's wires on top of the chosen types.
  wireVisibilityMode: 'all',   // 'all' | 'chosen' | 'selection_chosen' | 'hide'
  wireVisibilityTypes: { pov: true, narrative: true, concept: true },
  setWireVisibilityMode: (m) => set({ wireVisibilityMode: m }),
  setWireVisibilityType: (type, on) => set((s) => ({
    wireVisibilityTypes: { ...s.wireVisibilityTypes, [type]: !!on },
  })),
  setWireVisibilityTypes: (types) => set({
    wireVisibilityTypes: { pov: !!types?.pov, narrative: !!types?.narrative, concept: !!types?.concept },
  }),

  // ── Phase 1.20 drag-time port feedback ───────────────────────────────────
  // Populated by Canvas onConnectStart when the user starts dragging a wire
  // from a port, cleared by onConnectEnd (both success and abort paths).
  // Port-wrapper components subscribe to this slice to decide whether to
  // render the drag-time accept halo or reject overlay on themselves.
  //
  // Shape:
  //   null                        -- no drag in progress
  //   {
  //     sourceNodeId:         string,
  //     sourceHandleId:       string | null,
  //     sourceNodeType:       string,           -- 'sceneNode' | 'entityNode' | etc.
  //     payloadType:          string,           -- PAYLOAD.* from utils/portCatalogue.js
  //     blockedTargetNodeIds: Set<string>,      -- target nodes where a normally-accepting
  //                                                port would be rejected at the node level
  //                                                (cycle / pov-loop / story-order /
  //                                                direction-semantic silent drop).
  //     blockedTargetHandles: Set<string>,      -- specific ports keyed by
  //                                                `${nodeId}:${handleId}` that are rejected
  //                                                (currently: rel-in handles whose rel
  //                                                already has the source entity as an
  //                                                active participant at that chain position).
  //                                                Both sets precomputed once at drag start
  //                                                via utils/portDragState.computeBlockedTargets.
  //   }
  //
  // `payloadType` is derived at drag-start via portCatalogue.derivePayloadType
  // so port components never compute it themselves.
  activeDrag: null,
  setActiveDrag: (drag) => set({ activeDrag: drag }),
  clearActiveDrag: () => set({ activeDrag: null }),
}))
