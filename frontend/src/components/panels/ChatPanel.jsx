import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import { useSettingsStore } from '../../store/settingsStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { useSystemPromptsStore } from '../../store/systemPromptsStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { buildCharacterPersonaSnapshot } from '../../utils/characterChatAnchorMeta'
import { ROW_HEIGHT_PX } from '../canvas/ChapterColumnsOverlay'
import ConversationView from '../chat/ConversationView'
import ThreadBrowser from '../chat/ThreadBrowser'
import { hasMarkdownSyntax } from '../chat/MessageBubble'
import { EntityAvatar } from '../ui/IdentityBadges'
import TagPicker from '../tags/TagPicker'
import TagBadge from '../tags/TagBadge'
import { useProgramTagsStore } from '../../store/programTagsStore'


// Anchor helpers + the chain-resolved persona snapshot builder live
// in [characterChatAnchorMeta.js](../../utils/characterChatAnchorMeta.js)
// so the header (here), the message-list re-anchor divider, and the
// assistant-bubble character-mode renderer all read from the same
// shape-aware label format and the same latest-anchor selection
// rule.

const MIN_WIDTH = 280
// Dynamic max — matches RightSidebar's `MIN_CANVAS_WIDTH` reservation so
// the chat panel can't grow wide enough to push the canvas's top-left
// toolbar (undo / redo / "+") out of reach.
const MIN_CANVAS_WIDTH = 320
function getMaxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_CANVAS_WIDTH)
}

// ── Right-edge resize handle (for right-zone mode) ──────────────────────────
function RightResizeHandle({ onResize }) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = useUiStore.getState().chatPanelWidth

    function onMouseMove(ev) {
      if (!dragging.current) return
      const delta = startX.current - ev.clientX
      const newWidth = Math.min(getMaxWidth(), Math.max(MIN_WIDTH, startWidth.current + delta))
      onResize(newWidth)
    }

    function onMouseUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [onResize])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent-700/40 transition-colors z-10"
    />
  )
}

// ── Chat header ────────────────────────────────────────────────
//
// Unified header that previously lived as two separate strips —
// the chat-panel chrome (badge + close) and the conversation top
// bar (name, model, system prompt, MD/Raw, auto-scroll). They are
// merged here so the panel never wastes vertical space on two
// header bars. Layout:
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ [CHAT]  ←  Thread name                  [MD] [↓auto] [✕]│
//   │           profile / model   ★ active system prompt      │
//   └─────────────────────────────────────────────────────────┘
//
// When no thread is active, only row 1 is shown and just renders
// the badge + close button (no name, no toggles). The back arrow
// `←` clears the active thread id so ChatPanelInner falls back to
// the thread browser without deleting the open conversation.
function ChatHeader() {
  const closeChatPanel       = useUiStore((s) => s.closeChatPanel)
  const activeThreadId       = useConversationsStore((s) => s.activeThreadId)
  const setActiveThreadId    = useConversationsStore((s) => s.setActiveThreadId)
  const thread               = useConversationsStore((s) => activeThreadId ? (s.byId[activeThreadId] || null) : null)
  const renameThread         = useConversationsStore((s) => s.renameThread)
  const updateThread         = useConversationsStore((s) => s.updateThread)
  const persistPatch         = useConversationsStore((s) => s.persistMessagePatch)
  const prefs                = useSettingsStore((s) => s.preferences)
  const updatePreferences    = useSettingsStore((s) => s.updatePreferences)
  const systemPrompts        = useSystemPromptsStore((s) => s.prompts)
  const requestOpenChatSettings = useUiStore((s) => s.requestOpenChatSettings)
  // Phase 2.6f — tag editor for the open thread. Subscribes to the
  // thread index too (not just the byId entry) so the picker's
  // suggestion pool reflects every known tag across every saved
  // thread, even ones the writer hasn't opened this session.
  const conversationIndex    = useConversationsStore((s) => s.index)
  const addTagToThread       = useConversationsStore((s) => s.addTagToThread)
  const removeTagFromThread  = useConversationsStore((s) => s.removeTagFromThread)
  const indexEntry           = useConversationsStore((s) => activeThreadId ? (s.index || []).find((e) => e.id === activeThreadId) || null : null)

  const hasThread = !!thread
  const conversationRenderMode = thread?.render_mode || 'rendered'
  const renderingMd = conversationRenderMode !== 'raw'
  const hasAnyMarkdown = useMemo(
    () => hasThread && (!!thread?.render_mode || (thread?.messages || []).some((m) => hasMarkdownSyntax(m.content || ''))),
    [hasThread, thread?.messages, thread?.render_mode],
  )
  const profile = useMemo(() => {
    if (!hasThread) return null
    const profiles = prefs.ai_provider_profiles || []
    return profiles.find((p) => p.id === (thread?.profile_id || prefs.ai_default_profile_id)) || profiles[0] || null
  }, [hasThread, prefs, thread])
  const model = thread?.model || prefs.ai_default_model?.model || null
  const activeSystemPrompt = useMemo(() => {
    if (!hasThread) return null
    const id = thread?.system_prompt_id || prefs.default_system_prompt_id || null
    if (!id) return null
    return systemPrompts.find((p) => p.id === id) || null
  }, [hasThread, systemPrompts, thread, prefs])
  const autoScroll = prefs.chat_auto_scroll !== false

  // ── Phase 2.11b — character chat header branch ─────────────────
  // When the active thread carries `character_chat` metadata, the
  // middle column flips to a character-mode display: avatar +
  // chain-resolved character name + anchor span text + character
  // colour accent. Right column gains "Re-anchor" + "Restart from
  // this anchor" buttons. Regular chat threads (`character_chat ==
  // null`) render the existing layout byte-for-byte — every branch
  // below early-outs when `characterChat` is null.
  const characterChat = thread?.character_chat || null
  // Phase 2.12 — two-character chat metadata + per-character
  // persona snapshots for the two-character header. Same pattern as
  // ConversationView's twoCharPersonas — one snapshot per character
  // at THEIR OWN latest anchor. Null in regular + single-character
  // chats; the header below falls through to the existing branches.
  const twoCharacterChat = thread?.two_character_chat || null
  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const loadedStoryId = useProjectStore((s) => s.story?.id || null)

  // When a different project is loaded (or the loaded project clears
  // to null), close the active chat IF it's a character chat or
  // two-character chat tied to a different story_id. Character /
  // two-character chats depend on character details from their
  // owning project's chain; leaving one open against a different
  // loaded project produces empty dossier walks and a no-character
  // fallback at send time. Same rationale as the `openThreadGuarded`
  // gate in `ThreadBrowser` — that gate prevents OPENING a mismatched
  // chat; this effect handles the converse case where the chat was
  // already open when the project switch happens.
  // Regular chats (`is_character_chat` and `is_two_character_chat`
  // both false) stay open across project switches as before — their
  // wire-builder doesn't depend on the loaded story.
  useEffect(() => {
    if (!activeThreadId) return
    if (!indexEntry) return
    const isCharKind = indexEntry.is_character_chat || indexEntry.is_two_character_chat
    if (!isCharKind) return
    if (!indexEntry.story_id) return
    if (indexEntry.story_id === loadedStoryId) return
    // Mismatch — close the chat. Falls back to the thread browser.
    setActiveThreadId(null)
  }, [loadedStoryId, activeThreadId, indexEntry, setActiveThreadId])
  const characters = useEntitiesStore((s) => s.characters)
  // Chain-resolved character state at the latest pin anchor in the
  // thread's `anchor_spec`. Reuses the same resolution rule the
  // assembly function applies to pick a single point for character-
  // identity reads (end of range / single / last multi-pick / null
  // when dynamic). `computeEffectiveState` is the chain-aware walker;
  // there's no baseline shortcut here — the writer's anchor selection
  // drives every value displayed.
  const characterHeaderInfo = useMemo(
    () => buildCharacterPersonaSnapshot(characterChat, characters, projectNodes, projectEdges),
    [characterChat, characters, projectNodes, projectEdges],
  )
  // Phase 2.12 — two persona snapshots for the two-character header.
  // Each character resolves at THEIR own latest anchor (independent),
  // so a thread where Char 1 is at Scene 3 and Char 2 is at Scene 7
  // displays both with their respective chain-resolved name / colour
  // / avatar / anchor label.
  const twoCharacterHeaderInfo = useMemo(() => {
    if (!twoCharacterChat || !Array.isArray(twoCharacterChat.characters) || twoCharacterChat.characters.length !== 2) {
      return null
    }
    const char1Meta = twoCharacterChat.characters[0]
    const char2Meta = twoCharacterChat.characters[1]
    if (!char1Meta || !char2Meta) return null
    return {
      char1: buildCharacterPersonaSnapshot(char1Meta, characters, projectNodes, projectEdges),
      char2: buildCharacterPersonaSnapshot(char2Meta, characters, projectNodes, projectEdges),
    }
  }, [twoCharacterChat, characters, projectNodes, projectEdges])

  // Phase 2.12g — Re-anchor state moved from this header into the
  // chat gear popover (ConversationView's `ChatSettingsPopover`).
  // Modal mount + confirm handler live alongside the popover trigger
  // in ConversationView so the writer-facing button is under the
  // gear menu for BOTH single-character and two-character chats.
  // ChatHeader no longer owns this state — there's nothing to render
  // here.

  // Phase 2.6f — tag editor popover. Open state + outside-click
  // dismiss; the picker pool unions every tag known across the
  // index so the writer can resurface previously-used tags.
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const tagPopoverRef = useRef(null)
  useEffect(() => {
    if (!tagPickerOpen) return undefined
    function onDocClick(e) {
      if (!tagPopoverRef.current) return
      if (tagPopoverRef.current.contains(e.target)) return
      setTagPickerOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setTagPickerOpen(false) }
    document.addEventListener('mousedown', onDocClick, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [tagPickerOpen])

  // Current thread's tags: prefer the byId copy (kept in sync by
  // streaming + edit flows), fall back to the index entry. Both
  // mirror the same canonical `Conversation.tags` field on disk.
  const currentTags = useMemo(() => {
    const fromById = Array.isArray(thread?.tags) ? thread.tags : null
    if (fromById) return fromById
    return Array.isArray(indexEntry?.tags) ? indexEntry.tags : []
  }, [thread, indexEntry])

  // Phase 3.4e — Program Tag pool colour lookup for the header
  // popover's read-only chip strip. Subscribes to the pool (preloaded
  // at app startup); builds a case-insensitive name → hex map once
  // per pool change.
  const programTagPool = useProgramTagsStore((s) => s.pool)
  const tagColourLookup = useMemo(() => {
    const m = new Map()
    for (const t of (programTagPool || [])) {
      if (t?.name) m.set(t.name.toLowerCase(), t.color || '#888888')
    }
    return m
  }, [programTagPool])
  const colourForTag = (tag) => tagColourLookup.get((tag || '').toLowerCase()) || '#888888'

  const allKnownTags = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const e of (conversationIndex || [])) {
      for (const t of (e.tags || [])) {
        if (typeof t !== 'string') continue
        const trimmed = t.trim()
        if (!trimmed) continue
        const k = trimmed.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        out.push(trimmed)
      }
    }
    out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    return out
  }, [conversationIndex])

  function backToBrowser() {
    setActiveThreadId(null)
  }
  function toggleRenderMode() {
    if (!activeThreadId) return
    const next = conversationRenderMode === 'rendered' ? 'raw' : 'rendered'
    updateThread(activeThreadId, { render_mode: next })
    // Hard override: clear any per-message overrides so every
    // bubble follows the new conversation mode rather than staying
    // pinned to whatever the writer had set them to before.
    const pinned = (thread?.messages || []).filter((m) => m.render_mode)
    for (const m of pinned) {
      persistPatch(activeThreadId, m.id, { render_mode: '__clear__' })
    }
  }
  function toggleAutoScroll() {
    updatePreferences({ chat_auto_scroll: autoScroll ? false : null })
  }

  return (
    <div
      data-help-region="chat-panel:header"
      className="relative border-b border-zinc-700 flex-shrink-0 overflow-hidden bg-zinc-900/40"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <div
        className="grid items-center h-full px-3 gap-2"
        style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto' }}
      >
        {/* Left column — badge + (when in a thread) back arrow,
            inline horizontally so the row height stays locked to a
            single ROW_HEIGHT_PX strip. */}
        <div className="flex items-center gap-1.5 self-center">
          <span className="text-[9px] text-accent-400 uppercase tracking-widest font-semibold bg-accent-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            Chat
          </span>
          {hasThread && (
            <button
              type="button"
              onClick={backToBrowser}
              data-help-region="chat-panel:back"
              className="text-zinc-500 hover:text-zinc-100 text-[11px] leading-none px-1 py-0.5 rounded hover:bg-zinc-800/60 transition-colors"
              title="Back to conversations. Closes this view without deleting the thread; the saved copy stays in the browser list."
              aria-label="Back to conversations"
            >
              ←
            </button>
          )}
        </div>

        {/* Middle column — thread name on top, model + active system
            prompt below, both stacked vertically inside the locked
            ROW_HEIGHT_PX strip. Tight leading on the two lines lets
            them fit without the header growing taller than a single
            row (matches the editor header thickness). */}
        <div className="min-w-0 flex flex-col justify-center leading-tight">
          {hasThread && twoCharacterChat && twoCharacterHeaderInfo && (
            <>
              {/* Phase 2.12 — two-character header: `🎭⇆🎭` glyph
                  leading both characters' identity strips. Each
                  character is rendered with their own avatar +
                  chain-resolved name + anchor label, separated by
                  `⇆` to match the badge glyph. Fixed framing:
                  Character 1 always left, Character 2 always right
                  (matches the bubble layout). */}
              <div className="flex items-center gap-1.5 min-w-0 leading-tight whitespace-nowrap">
                <span className="text-[10px] flex-shrink-0" title="Two-character chat">🎭⇆🎭</span>
                {twoCharacterHeaderInfo.char1?.synthEntity && (
                  <span className="flex-shrink-0 inline-flex items-center">
                    <EntityAvatar entity={twoCharacterHeaderInfo.char1.synthEntity} size={14} />
                  </span>
                )}
                <span
                  className="text-[11px] font-semibold truncate min-w-0"
                  style={{ color: twoCharacterHeaderInfo.char1?.characterColour || '#7c3aed' }}
                  title={twoCharacterHeaderInfo.char1?.characterName}
                >
                  {twoCharacterHeaderInfo.char1?.characterName || '(Character 1)'}
                </span>
                <span className="text-[11px] text-zinc-500 truncate" title={`Anchored to: ${twoCharacterHeaderInfo.char1?.anchorLabel || ''}`}>
                  @ {twoCharacterHeaderInfo.char1?.anchorLabel || ''}
                </span>
                <span className="text-[11px] text-zinc-500 flex-shrink-0 px-0.5">⇆</span>
                {twoCharacterHeaderInfo.char2?.synthEntity && (
                  <span className="flex-shrink-0 inline-flex items-center">
                    <EntityAvatar entity={twoCharacterHeaderInfo.char2.synthEntity} size={14} />
                  </span>
                )}
                <span
                  className="text-[11px] font-semibold truncate min-w-0"
                  style={{ color: twoCharacterHeaderInfo.char2?.characterColour || '#7c3aed' }}
                  title={twoCharacterHeaderInfo.char2?.characterName}
                >
                  {twoCharacterHeaderInfo.char2?.characterName || '(Character 2)'}
                </span>
                <span className="text-[11px] text-zinc-500 truncate" title={`Anchored to: ${twoCharacterHeaderInfo.char2?.anchorLabel || ''}`}>
                  @ {twoCharacterHeaderInfo.char2?.anchorLabel || ''}
                </span>
              </div>
              <div className="flex items-center gap-2 min-w-0 leading-tight">
                <button
                  type="button"
                  onClick={requestOpenChatSettings}
                  title={`${profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}. Click to switch connection or model.`}
                  className="text-[10px] text-zinc-500 truncate leading-tight text-left hover:text-zinc-200 hover:bg-zinc-800/60 rounded px-1 -mx-1 transition-colors min-w-0"
                >
                  {profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}
                </button>
                {profile?.api_type && (
                  <span
                    className="text-[9px] text-sky-300 border border-sky-700/60 rounded px-1 leading-tight flex-shrink-0"
                    title={`Backend adapter handling this conversation: ${_apiTypeLabel(profile.api_type)} (${profile.api_type}).`}
                  >
                    {_apiTypeLabel(profile.api_type)}
                  </span>
                )}
              </div>
            </>
          )}
          {hasThread && !twoCharacterChat && characterChat && characterHeaderInfo && (
            <>
              <div className="flex items-center gap-1.5 min-w-0 leading-tight">
                <span className="text-[10px] flex-shrink-0" title="Character chat">🎭</span>
                {characterHeaderInfo.synthEntity && (
                  <span className="flex-shrink-0 inline-flex items-center">
                    <EntityAvatar entity={characterHeaderInfo.synthEntity} size={14} />
                  </span>
                )}
                <span className="text-[11px] text-zinc-400 flex-shrink-0">Talking with:</span>
                <span
                  className="text-[11px] font-semibold truncate min-w-0"
                  style={{ color: characterHeaderInfo.characterColour }}
                  title={characterHeaderInfo.characterName}
                >
                  {characterHeaderInfo.characterName}
                </span>
                <span className="text-[11px] text-zinc-500 truncate min-w-0" title={`Anchored to: ${characterHeaderInfo.anchorLabel}`}>
                  @ {characterHeaderInfo.anchorLabel}
                </span>
              </div>
              <div className="flex items-center gap-2 min-w-0 leading-tight">
                <button
                  type="button"
                  onClick={requestOpenChatSettings}
                  title={`${profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}. Click to switch connection or model.`}
                  className="text-[10px] text-zinc-500 truncate leading-tight text-left hover:text-zinc-200 hover:bg-zinc-800/60 rounded px-1 -mx-1 transition-colors min-w-0"
                >
                  {profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}
                </button>
                {profile?.api_type && (
                  <span
                    className="text-[9px] text-sky-300 border border-sky-700/60 rounded px-1 leading-tight flex-shrink-0"
                    title={`Backend adapter handling this conversation: ${_apiTypeLabel(profile.api_type)} (${profile.api_type}).`}
                  >
                    {_apiTypeLabel(profile.api_type)}
                  </span>
                )}
              </div>
            </>
          )}
          {hasThread && !characterChat && !twoCharacterChat && (
            <>
              <ThreadNameEditor
                threadName={thread.name || ''}
                onSave={(next) => renameThread(activeThreadId, next)}
              />
              <div className="flex items-center gap-2 min-w-0 leading-tight">
                <button
                  type="button"
                  onClick={requestOpenChatSettings}
                  data-help-region="chat-panel:model_connection"
                  title={`${profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}. Click to switch connection or model.`}
                  className="text-[10px] text-zinc-500 truncate leading-tight text-left hover:text-zinc-200 hover:bg-zinc-800/60 rounded px-1 -mx-1 transition-colors min-w-0"
                >
                  {profile?.name && model ? `${profile.name} / ${model}` : (model || 'no model')}
                </button>
                {profile?.api_type && (
                  <span
                    data-help-region="chat-panel:adapter_badge"
                    className="text-[9px] text-sky-300 border border-sky-700/60 rounded px-1 leading-tight flex-shrink-0"
                    title={`Backend adapter handling this conversation: ${_apiTypeLabel(profile.api_type)} (${profile.api_type}).`}
                  >
                    {_apiTypeLabel(profile.api_type)}
                  </span>
                )}
                {activeSystemPrompt && (
                  <button
                    type="button"
                    onClick={requestOpenChatSettings}
                    data-help-region="chat-panel:system_prompt"
                    className="text-[9px] text-amber-300 border border-amber-700/60 rounded px-1 truncate max-w-[140px] flex-shrink-0 leading-tight hover:bg-amber-900/30 transition-colors"
                    title={`Active system prompt: ${activeSystemPrompt.name}. Click to switch.`}
                  >★ {activeSystemPrompt.name}</button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right column — conversation-scoped toggles + close. The
            toggles are only meaningful inside an open thread, so
            they appear only when `hasThread`. */}
        <div className="flex items-center gap-2 flex-shrink-0 self-center">
          {/* Phase 2.12g — Re-anchor button moved to the chat gear
              popover (ConversationView's `ChatSettingsPopover`) so
              single-character AND two-character chats share one
              affordance under the gear menu. Header no longer
              renders a Re-anchor button. */}
          {hasThread && hasAnyMarkdown && (
            <button
              type="button"
              onClick={toggleRenderMode}
              data-help-region="chat-panel:render_mode"
              title={renderingMd
                ? 'Messages render as Markdown. Click to switch the whole conversation to verbatim Raw text. This clears any per-message overrides.'
                : 'Messages render as Raw verbatim text. Click to switch the whole conversation back to Markdown. This clears any per-message overrides.'}
              aria-label="Toggle conversation markdown rendering"
              className={`text-[10px] rounded px-1.5 py-0.5 border transition-colors flex-shrink-0 ${
                renderingMd
                  ? 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50'
                  : 'border-zinc-600 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {renderingMd ? 'MD' : 'Raw'}
            </button>
          )}
          {hasThread && (
            <button
              type="button"
              onClick={toggleAutoScroll}
              data-help-region="chat-panel:auto_scroll"
              title={autoScroll
                ? 'Magnetic auto-scroll is on — the panel follows the latest message while you’re pinned to the bottom. Click to turn off.'
                : 'Magnetic auto-scroll is off — scroll position is fully under your control. Click to turn on.'}
              aria-label="Toggle magnetic auto-scroll"
              className={`text-[10px] rounded px-1.5 py-0.5 border transition-colors flex-shrink-0 ${
                autoScroll
                  ? 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50'
                  : 'border-zinc-600 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {autoScroll ? '↓ auto' : '↓ off'}
            </button>
          )}
          {hasThread && (
            <div className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setTagPickerOpen((v) => !v)}
                data-help-region="chat-panel:tags"
                title={`Tags on this conversation${currentTags.length ? `: ${currentTags.join(', ')}` : ' — none yet. Click to add.'}`}
                aria-label="Edit conversation tags"
                aria-expanded={tagPickerOpen}
                className={`text-[10px] rounded px-1.5 py-0.5 border transition-colors ${
                  currentTags.length > 0
                    ? 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50'
                    : 'border-zinc-600 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                🏷 {currentTags.length || '+'}
              </button>
              {tagPickerOpen && (
                <div
                  ref={tagPopoverRef}
                  className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 w-72 space-y-1.5"
                >
                  {/* Read-only chip strip at the top for at-a-glance
                      visibility; the TagPicker below it owns the
                      detach affordance via its own × buttons. We
                      keep both because the chip strip surfaces every
                      tag in original casing even when the writer is
                      mid-type in the picker's filter input. */}
                  {currentTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pb-1.5 border-b border-zinc-800">
                      {currentTags.map((tag) => (
                        <TagBadge
                          key={tag}
                          name={tag}
                          color={colourForTag(tag)}
                          size="sm"
                        />
                      ))}
                    </div>
                  )}
                  <TagPicker
                    currentTags={currentTags}
                    suggestedTags={allKnownTags}
                    onAdd={(t) => { if (activeThreadId) addTagToThread(activeThreadId, t) }}
                    onRemove={(t) => { if (activeThreadId) removeTagFromThread(activeThreadId, t) }}
                    placeholder="Add tag…"
                    autoFocus
                  />
                </div>
              )}
            </div>
          )}
          <button
            onClick={closeChatPanel}
            data-help-region="chat-panel:close"
            className="text-zinc-500 hover:text-zinc-200 text-sm leading-none flex-shrink-0"
            title="Close chat panel"
            aria-label="Close chat panel"
          >
            ✕
          </button>
        </div>
      </div>
      {/* Phase 2.12g — Re-anchor modal moved to ConversationView
          (alongside the gear popover that triggers it). Mount is
          gated on `reanchorTarget` there; the modal handles both
          single-character (`character_chat`) and two-character
          (`two_character_chat.characters[idx]`) re-anchor confirmations. */}
    </div>
  )
}

// ── Inline rename for the thread name in the chat header ──────
//
// Click-to-edit affordance over the conversation name. Reads as a
// plain span until clicked, then swaps to a text input that auto-
// focuses and selects the existing name. Enter or blur commits;
// Escape cancels. Empty / whitespace-only names are rejected
// (revert to the previous name). Matches the surrounding text
// style so the swap is visually unobtrusive.
// Short, writer-readable label for the api_type literal so the
// chat header can surface which backend adapter is actually
// handling the conversation. Different connections can speak
// HTTP to the same endpoint via different shapes (e.g. LM Studio's
// native REST v1 vs its OpenAI-compatible path), and from the
// chat panel alone the difference is invisible without a badge.
function _apiTypeLabel(apiType) {
  if (apiType === 'lmstudio_rest_v1')   return 'LM Studio'
  if (apiType === 'openai_compatible')  return 'OpenAI-compat'
  if (apiType === 'anthropic')          return 'Anthropic'
  return apiType
}


function ThreadNameEditor({ threadName, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  function begin() {
    setDraft(threadName)
    setEditing(true)
  }
  function commit() {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === threadName) return
    onSave(next)
  }
  function cancel() {
    setEditing(false)
    setDraft('')
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        className="text-xs text-zinc-100 font-medium bg-zinc-800 border border-accent-700/60 rounded px-1 py-0 leading-tight min-w-0 w-full focus:outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={begin}
      data-help-region="chat-panel:thread_name"
      title={`${threadName || 'New conversation'}. Click to rename.`}
      className="text-xs text-zinc-100 font-medium truncate leading-tight text-left hover:bg-zinc-800/60 rounded px-1 -mx-1 transition-colors"
    >
      {threadName || 'New conversation'}
    </button>
  )
}

// ── Inner content ──────────────────────────────────────────────────────────
// The watermark + body. Header is the unified ChatHeader above.
// Shared between right-zone and bottom-zone renderings — only the
// outer container differs by zone.
function ChatPanelInner() {
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  return (
    <>
      {/* Speech-bubble watermark — fills the whole panel, behind content. */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          width="65%"
          height="65%"
          preserveAspectRatio="xMidYMid meet"
          fill="none"
          stroke="rgb(212, 212, 216)" /* zinc-300 */
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: 0.06 }}
        >
          <path d="M6 4 H18 A4 4 0 0 1 22 8 V12 A4 4 0 0 1 18 16 H11 L7 20 L8 16 H6 A4 4 0 0 1 2 12 V8 A4 4 0 0 1 6 4 Z" />
          <line x1="6" y1="9" x2="18" y2="9" />
          <line x1="6" y1="13" x2="15" y2="13" />
        </svg>
      </div>

      <ChatHeader />

      {/* Body — if a thread is active, render the conversation view;
          otherwise the thread browser handles tabs / categories /
          per-thread actions (Phase 2.4f). */}
      <div data-help-region="chat-panel:content" className="relative flex-1 overflow-hidden">
        {activeThreadId ? <ConversationView threadId={activeThreadId} /> : <ThreadBrowser />}
      </div>
    </>
  )
}

// ── Chat Panel ──────────────────────────────────────────────────────────────

/**
 * Chat panel. Hosts the thread-browser stub (until 2.4f) or the
 * conversation view depending on whether a thread is active in
 * the conversations store.
 *
 * `zone` prop ('right' | 'bottom') indicates which dock zone is
 * asking the panel to render. The component returns null if its
 * stored `chatZone` doesn't match the prop, so the same panel can
 * be rendered in both App.jsx (zone='right') and BottomZone
 * (zone='bottom') and only the matching one actually paints.
 * Default `zone` is 'right' for backwards compatibility with
 * callers that don't specify.
 */
export default function ChatPanel({ zone = 'right', share }) {
  const open = useUiStore((s) => s.chatPanelOpen)
  const storedZone = useUiStore((s) => s.chatZone)
  const width = useUiStore((s) => s.chatPanelWidth)
  const setChatPanelWidth = useUiStore((s) => s.setChatPanelWidth)
  // Phase 5.7 — the chat panel is an AI surface; hide it entirely when
  // AI integrations are disabled (the open flag is preserved, so the
  // panel returns once the writer turns AI back on).
  const aiDisabled = useAiDisabled()

  if (aiDisabled || !open || storedZone !== zone) return null

  if (zone === 'right') {
    // Shared-zone variant: when `share` is provided, the parent `RightZone`
    // owns the container width, borders, and outer resize handle. This
    // panel just contributes as a flex child with `share` controlling
    // main-axis distribution (width when parent is flex-row, height when
    // flex-col). Skip own width, border, and resize handle.
    if (share != null) {
      return (
        <div
          className="relative min-w-0 min-h-0 bg-zinc-900 flex flex-col overflow-hidden"
          style={{ flex: share }}
        >
          <ChatPanelInner />
        </div>
      )
    }
    // Solo variant: this panel is the only one in the right zone, so it
    // owns its width, border-left, and left-edge resize handle.
    return (
      <div
        data-help-region="chat-panel:panel"
        className="relative flex-shrink-0 bg-zinc-900 border-l border-zinc-700 flex flex-col h-full overflow-hidden"
        style={{ width }}
      >
        <RightResizeHandle onResize={setChatPanelWidth} />
        <ChatPanelInner />
      </div>
    )
  }

  // zone === 'bottom' — fills its share of the BottomZone container.
  // Vertical/horizontal sizing is handled by the BottomZone wrapper; this
  // outer just becomes a flex item with overflow control. `share` controls
  // flex-grow vs. the editor's complementary share so the divider can
  // resize their split.
  return (
    <div
      className="relative min-w-0 min-h-0 bg-zinc-900 flex flex-col overflow-hidden"
      style={{ flex: share != null ? share : '1 1 0%' }}
    >
      <ChatPanelInner />
    </div>
  )
}
