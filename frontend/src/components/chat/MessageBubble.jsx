import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { createMermaidPlugin } from '@streamdown/mermaid'

// Phase 2.5i follow-up — Mermaid diagram rendering. Configured for
// our dark chat panel (`theme: 'dark'`) and locked to Mermaid's
// strict security level (no click handlers, no foreign content) since
// the source is an unverified LLM response. Plugin instance is
// module-scope so every bubble re-uses the same Mermaid engine
// instance — initialising it per-bubble was wasteful.
//
// IMPORTANT: Streamdown's `plugins` prop takes a `PluginConfig`
// OBJECT keyed by plugin name (`{ mermaid, math, code, cjk, ... }`),
// NOT an array. The internal renderer reads `plugins.mermaid` to
// route `language-mermaid` blocks to the diagram path; passing an
// array silently leaves caching off because `[].mermaid` is
// undefined.
const _MERMAID_PLUGIN = createMermaidPlugin({
  config: {
    theme: 'dark',
    securityLevel: 'strict',
  },
})
const _STREAMDOWN_PLUGINS = { mermaid: _MERMAID_PLUGIN }
import { HighlightChildren } from './MessageHighlight'
import { EntityAvatar } from '../ui/IdentityBadges'
import { useAccentColor } from '../../utils/povConstants'
import { useSettingsStore } from '../../store/settingsStore'
import { usePreviewStore } from '../../store/previewStore'
import { useUiStore } from '../../store/uiStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { useApplyImageToOpenTarget } from '../../hooks/useApplyImageToOpenTarget'
import { makeProfileImageDragStart } from '../../utils/profileImageDrag'
import ApplyToSectionMenu from './ApplyToSectionMenu'
import ApplyToSectionPicker from './ApplyToSectionPicker'

// Collapsed-message preview height. Approx three lines of the
// body's 12px / leading-relaxed text. Used as the max-height when
// the writer collapses a bubble via the hover action row; click
// "Show more" or the collapse toggle again to restore.
const COLLAPSED_PX = 56

/**
 * Single message bubble.
 *
 * Visual contract:
 *   - Every bubble has a thin border in the active story accent
 *     colour as a consistent visual signature tying the chat to
 *     the project.
 *   - User vs assistant differentiated by:
 *       · alignment (user right, assistant left)
 *       · width behaviour (assistant always spans full panel
 *         width; user uses natural width up to full width)
 *       · background tint (user = low-opacity accent wash;
 *         assistant = neutral zinc)
 *       · role label (`You` / model name) — right-aligned for
 *         user, left-aligned for assistant
 *   - In-progress streaming message shows a blinking cursor at
 *     the tail.
 *
 * Markdown rendering — three-layer override system:
 *
 *   Layer 1: conversation-level toggle (top bar). Resolved upstream
 *            by ConversationView and passed down as
 *            `conversationRenderMode` ('rendered' | 'raw').
 *   Layer 2: per-message override. If the message carries a
 *            non-null `render_mode`, it wins over the conversation
 *            default. Toggled via the small "MD/Raw" pill in the
 *            bubble header.
 *   Layer 3: per-code-block toggle. Each fenced code block in
 *            rendered mode gets a small "Raw" button in its
 *            corner; flipping it shows the verbatim ``` source
 *            for that one block. Session-only — resets on reload.
 *
 * `onSetMessageRenderMode` is invoked when the writer flips the
 * per-message toggle. The parent persists the change via the
 * conversations store. Passing `null` clears the override (back
 * to inheriting from the conversation level).
 */
function MessageBubble({
  message,
  streaming = false,
  model = null,
  conversationRenderMode = 'rendered',
  onSetMessageRenderMode,
  onRetry,
  onResend,
  onEditUserResubmit,
  onEditUserSaveOnly,
  onEditAssistantSave,
  onSetStarState,
  onFork,
  onViewContext,
  onDelete,
  canMutate = true,
  // Phase 2.5g follow-up — capability gate for the active model.
  // When `activeSupportsImageInput` is false, image attachments on
  // this message are stripped from the wire on the next send, and
  // the bubble paints a small inline notice ("Hidden from this
  // model") on the affected thumbnail so the writer knows the
  // upstream isn't seeing what they're seeing. Same shape for file.
  // Both default to `true` so older callers / non-chat usages of
  // the bubble keep the pre-fix forward-everything appearance.
  activeSupportsImageInput = true,
  activeSupportsFileInput = true,
  // Phase 2.5i — prompt-cache hit count from the most recent
  // assistant turn's terminal `end` event. Optional integer.
  // Only the latest assistant bubble in the conversation receives
  // a non-null value; all other bubbles get null and render no
  // indicator. The HoverActionRow paints it at the far left of
  // the action-button row, always visible (not gated on hover).
  cachedInputTokens = null,
  // Phase 2.8a — name-highlight props. `nameTargets` is the
  // shared `chatNameTargets` builder output (story-wide, chain-
  // aware) the chat composer also uses, so the bubble paints
  // the same name → colour mapping. `highlightEnabled` is the
  // composer's master toggle (`chatHighlightNamesEnabled`); when
  // false, MarkdownBody renders without the highlight wrapper.
  // Both props default to noop so callers that don't yet thread
  // them through (system-context summaries, etc.) see plain
  // bubbles.
  nameTargets = null,
  highlightEnabled = false,
  // Phase 2.11b item 13 — character-mode persona snapshot. Optional
  // bundle of chain-resolved name / colour / profile image plus a
  // synthetic entity that `<EntityAvatar>` can render. Computed once
  // per ConversationView render via `buildCharacterPersonaSnapshot`
  // and shared across every assistant bubble in the thread; for
  // range / multi anchors the values resolve at the END of the
  // latest contiguous run (same point the dossier resolves to). When
  // null (regular thread, OR character thread with a missing
  // character_id that the gate would normally block), the bubble
  // renders byte-for-byte as today. User bubbles always render as
  // today regardless — the asymmetry is intentional.
  characterPersona = null,
  // Phase 2.12 — two-character chat UI-position override. When
  // non-null, this bubble's UI slot is determined by speaker identity
  // (Character 1 = always left/assistant slot; Character 2 = always
  // right/user slot), NOT by the persisted `message.role` field
  // (which the wire-builder rewrites per turn and doesn't follow
  // speaker identity in storage). True → render in the user slot.
  // False → render in the assistant slot. Null → fall back to
  // `message.role === 'user'` (regular + single-character chats).
  twoCharForceUserSide = null,
}) {
  const accent = useAccentColor() || '#7c3aed'
  // Phase 2.12 — speaker-identity overrides message.role for layout
  // purposes in two-character chats. `twoCharForceUserSide` is null
  // outside two-character mode, so single-character + regular chats
  // continue to use the message's stored role.
  const isUser = (twoCharForceUserSide !== null)
    ? !!twoCharForceUserSide
    : (message.role === 'user')

  const effectiveMode = message.render_mode || conversationRenderMode || 'rendered'
  const renderAsMarkdown = effectiveMode === 'rendered'
  const hasFormatting = hasMarkdownSyntax(message.content || '') || !!message.render_mode

  // Character-mode active when a persona is provided AND either:
  //  - this is an assistant-side bubble in single-character mode
  //    (the pre-Phase-2.12 path), OR
  //  - this bubble is in a two-character thread (any side — both
  //    Characters 1 and 2 wear their persona styling).
  // The `twoCharForceUserSide !== null` check is the two-character
  // marker — it's non-null only when ConversationView passed a value.
  const isTwoCharBubble = twoCharForceUserSide !== null
  const isCharacterMode = !!characterPersona && (isTwoCharBubble || !isUser)
  const characterColour = isCharacterMode ? (characterPersona.characterColour || '#7c3aed') : null

  const alignmentClass = isUser ? 'justify-end' : 'justify-start'
  const bubbleStyle = {
    borderColor: isCharacterMode ? withAlpha(characterColour, 0.65) : withAlpha(accent, 0.55),
    // Phase 2.12 — in two-character mode both sides get the
    // character-tinted background. In single-character mode the
    // user-side keeps the accent wash (writer is themselves, not a
    // character). Regular chats keep the existing user-accent /
    // assistant-zinc treatment.
    backgroundColor: isCharacterMode
      ? withAlpha(characterColour, 0.06)
      : (isUser ? withAlpha(accent, 0.08) : 'rgba(39, 39, 42, 0.45)'),
  }
  // Phase 2.12 — in two-character mode the user-side bubble shows
  // the character's name (Character 2's), NOT "You" — the writer
  // isn't speaking, Character 2 is. In single-character mode and
  // regular chats, user-side keeps "You" (the writer is themselves).
  const roleLabel = isCharacterMode
    ? (characterPersona.characterName || 'Untitled')
    : (isUser ? 'You' : (model || 'Assistant'))

  // Per-session, per-message UI state. Collapse and edit-mode are
  // intentionally NOT persisted — they're scratch UI affordances
  // that reset on reload, so a writer who collapses a long bubble
  // during one session doesn't have to re-expand it next time.
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [copiedFlash, setCopiedFlash] = useState(false)

  // Phase 2.9b item 5 — excerpt apply via right-click on a non-empty
  // selection inside this bubble. State holds the in-flight picker's
  // viewport position and the selected text. Reset on any close.
  // Bound to the rendered-body div so we can scope the selection
  // check (only right-clicks LANDING on the bubble body open the
  // excerpt picker — clicks on the hover toolbar / tag chips fall
  // through to the browser default).
  const [excerptApply, setExcerptApply] = useState(null)
  const closeExcerptApply = useCallback(() => setExcerptApply(null), [])
  const bodyRef = useRef(null)
  const handleExcerptContextMenu = useCallback((e) => {
    // Only assistant bubbles support excerpt apply; user bubbles fall
    // through to the browser default. Also requires an editor surface
    // active (the picker would be empty otherwise).
    if (isUser) return
    if (!useUiStore.getState().currentEditorSurface) return
    // v0.2.9.72 — when the MCP edit-lock is active, fall through to
    // the browser default context menu rather than opening the
    // excerpt-apply picker. The Apply button on the hover toolbar is
    // disabled for the same reason; suppressing the right-click path
    // keeps the two affordances consistent.
    if (useMcpControlStore.getState().sessionState === 'active') return
    // Need a non-empty selection that's actually inside this bubble's
    // body. Cross-bubble selections fall through.
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (!sel || sel.isCollapsed) return
    const text = (sel.toString() || '').trim()
    if (!text) return
    let inside = false
    try {
      for (let i = 0; i < sel.rangeCount; i += 1) {
        const r = sel.getRangeAt(i)
        if (bodyRef.current && bodyRef.current.contains(r.commonAncestorContainer)) {
          inside = true
          break
        }
      }
    } catch { /* swallow — fall through to browser default */ }
    if (!inside) return
    e.preventDefault()
    e.stopPropagation()
    // Anchor the picker at the click point so it appears near the
    // writer's cursor — feels like a custom context menu.
    setExcerptApply({
      left: Math.max(8, e.clientX),
      top: e.clientY + 2,
      text,
    })
  }, [isUser])

  // During inline edit, force the bubble to fill the available
  // width so the textarea isn't squeezed down to whatever width
  // the original short user-message content happened to render at.
  // Without this, editing "yes." on a user bubble produced a
  // textarea ~30 px wide. Assistant bubbles already use `w-full`
  // (always); user bubbles use `max-w-full` (natural width) except
  // during edit, when they flip to `w-full` so the editor has room.
  const widthClass = isEditing ? 'w-full' : (isUser ? 'max-w-full' : 'w-full')

  function togglePerMessageRenderMode() {
    if (!onSetMessageRenderMode) return
    onSetMessageRenderMode(message.id, renderAsMarkdown ? 'raw' : 'rendered')
  }

  function beginEdit() {
    setEditDraft(message.content || '')
    setIsEditing(true)
  }
  function cancelEdit() {
    setIsEditing(false)
    setEditDraft('')
  }
  async function saveEdit() {
    const next = editDraft
    setIsEditing(false)
    setEditDraft('')
    if (next === (message.content || '')) return
    if (isUser) {
      if (onEditUserResubmit) await onEditUserResubmit(message.id, next)
    } else {
      if (onEditAssistantSave) await onEditAssistantSave(message.id, next)
    }
  }

  // Phase 2.5 follow-up — secondary "Save without resubmit" action
  // for user messages. Editing a typo on a long-running thread
  // shouldn't force a fresh model round-trip + drop downstream
  // messages; this gives the writer a way to fix the wording in
  // place. Persists the new content + an `edited_at` timestamp via
  // `onEditUserSaveOnly` (see ConversationView). Assistant messages
  // don't need this path — their existing Save IS the save-only
  // action (they never re-stream from a content edit).
  async function saveEditNoResubmit() {
    const next = editDraft
    setIsEditing(false)
    setEditDraft('')
    if (next === (message.content || '')) return
    if (onEditUserSaveOnly) await onEditUserSaveOnly(message.id, next)
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(message.content || '')
      setCopiedFlash(true)
      setTimeout(() => setCopiedFlash(false), 1200)
    } catch {
      // Older browsers / non-secure contexts: clipboard may be
      // unavailable. Surface the failure silently — the bubble
      // text remains selectable for manual copy.
    }
  }

  // The hover action row is gated against streaming so a writer
  // can't kick off Retry/Edit/Delete on a half-streamed message.
  // Copy and Collapse are read-only and safe during streaming.
  const showMutatingActions = canMutate && !streaming
  const isPinned = !!message.pinned
  const isSticky = isPinned && !!message.context_sticky
  // Star state computation. Tri-state cycle: off → fav → sticky → off.
  // Left-click on the star advances one step; right-click jumps
  // directly back to off regardless of current state.
  function cycleStar() {
    if (!onSetStarState) return
    let next
    if (!isPinned) next = { pinned: true, context_sticky: false }
    else if (!isSticky) next = { pinned: true, context_sticky: true }
    else next = { pinned: false, context_sticky: false }
    onSetStarState(message.id, next)
  }
  function clearStar(e) {
    if (e?.preventDefault) e.preventDefault()
    if (!onSetStarState) return
    if (!isPinned && !isSticky) return
    onSetStarState(message.id, { pinned: false, context_sticky: false })
  }
  const starTitle = isSticky
    ? 'Pinned favourite: always kept in the message history sent to the AI, in addition to your message-history limit. Click to clear; right-click also clears.'
    : isPinned
      ? 'Favourite: bookmarked for quick navigation. Click again to pin it (always sent in addition to the history limit); right-click clears.'
      : 'Click to favourite: bookmark this message for quick navigation. Click again to pin it (always sent in addition to the history limit). Right-click clears.'

  return (
    <div className={`group/bubble flex ${alignmentClass}`} data-message-id={message.id}>
      <div
        data-help-region="message-bubble:bubble"
        className={`${widthClass} rounded-lg border px-3 py-2 space-y-1 shadow-sm relative`}
        style={bubbleStyle}
      >
        <div data-help-region="message-bubble:header" className={`flex ${isCharacterMode ? 'items-center' : 'items-baseline'} gap-2 ${isUser ? 'justify-end' : ''}`}>
          {/* Phase 2.11b item 13 — chain-resolved avatar prefix for
              character-mode assistant bubbles. The avatar is sized
              generously (36px) so the writer reads it as the speaker
              identifier rather than a decorative chip; falls back to
              `EntityAvatar`'s built-in silhouette when no profile
              image exists at the resolved anchor. `items-center`
              switches the header row from baseline to vertical-
              middle alignment so the larger avatar lines up against
              the two-line name + model block beside it. */}
          {isCharacterMode && characterPersona.synthEntity && (
            <span className="inline-flex items-center flex-shrink-0">
              <EntityAvatar entity={characterPersona.synthEntity} size={36} />
            </span>
          )}
          {isCharacterMode ? (
            <div className="flex flex-col min-w-0 leading-tight">
              <span
                className="text-[14px] font-semibold truncate"
                style={{ color: characterColour }}
                title={characterPersona.characterName}
              >
                {characterPersona.characterName}
              </span>
              {/* Second row: model name + timestamp + edited marker,
                  inline so the header doesn't span three rows. Same
                  base style as the standalone non-character header
                  bits (text-[10px] / text-[9px] zinc-500); model in
                  italics to flag it as auxiliary metadata, the
                  middle-dot separators keep the row reading as one
                  identity-and-provenance line. */}
              <span className="flex items-baseline gap-1.5 min-w-0 text-zinc-500">
                <span
                  className="text-[10px] italic truncate"
                  title={`Model: ${model || 'Assistant'}`}
                >
                  {model || 'Assistant'}
                </span>
                {message.timestamp && (
                  <>
                    <span className="text-[9px] opacity-70">·</span>
                    <span className="text-[9px] truncate">{formatTimestamp(message.timestamp)}</span>
                  </>
                )}
                {message.edited_at && (
                  <>
                    <span className="text-[9px] opacity-70">·</span>
                    <span
                      className="text-[9px] italic truncate"
                      title={`Last edited: ${message.edited_at}`}
                    >
                      &lt;Edited {formatTimestamp(message.edited_at)}&gt;
                    </span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <>
              <span
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: withAlpha(accent, 0.85) }}
              >
                {roleLabel}
              </span>
              {message.timestamp && (
                <span className="text-[9px] text-zinc-500">{formatTimestamp(message.timestamp)}</span>
              )}
              {message.edited_at && (
                // Phase 2.5 follow-up — annotate edited messages so the
                // writer can tell at a glance which messages have been
                // changed after their original send. `formatTimestamp`
                // already collapses to time-only when the edit happened
                // today, expanding to full DTS otherwise.
                <span
                  className="text-[9px] text-zinc-500 italic"
                  title={`Last edited: ${message.edited_at}`}
                >
                  &lt;Edited {formatTimestamp(message.edited_at)}&gt;
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          {onSetStarState && (
            <button
              type="button"
              onClick={cycleStar}
              onContextMenu={clearStar}
              title={starTitle}
              aria-label={isSticky ? 'Pinned favourite: click to clear' : (isPinned ? 'Favourite: click to pin, right-click to clear' : 'Click to favourite')}
              aria-pressed={isPinned}
              className={`text-[10px] leading-none flex-shrink-0 px-1 rounded transition-colors ${
                isPinned
                  ? 'text-amber-300 hover:text-amber-200 hover:bg-amber-900/30'
                  : 'text-zinc-600 hover:text-amber-300 hover:bg-zinc-800/60'
              }`}
              style={isSticky ? { filter: 'drop-shadow(0 0 3px rgba(252, 211, 77, 0.7))' } : undefined}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill={isSticky ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.8l1.9 4 4.4.5-3.3 3 1 4.3L8 11.4 3.9 13.6l1-4.3-3.3-3 4.4-.5z" />
              </svg>
            </button>
          )}
          {onSetMessageRenderMode && hasFormatting && (
            <button
              type="button"
              onClick={togglePerMessageRenderMode}
              title={message.render_mode
                ? `Pinned to ${message.render_mode === 'rendered' ? 'Markdown' : 'Raw'} for this message (overrides the conversation default). Click to flip.`
                : `Following the conversation default (${conversationRenderMode === 'rendered' ? 'Markdown' : 'Raw'}). Click to pin the opposite for this message.`}
              className={`text-[9px] px-1.5 py-px rounded border transition-colors flex-shrink-0 ${
                message.render_mode
                  ? 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50'
                  : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {renderAsMarkdown ? 'MD' : 'Raw'}
            </button>
          )}
        </div>

        {!isUser && typeof message.reasoning_text === 'string' && message.reasoning_text.length > 0 && (
          <ReasoningDisclosure
            reasoningText={message.reasoning_text}
            tokenCount={message.reasoning_token_count}
            durationMs={message.reasoning_duration_ms}
            streaming={streaming}
            hasContent={typeof message.content === 'string' && message.content.length > 0}
            accent={accent}
          />
        )}

        {(() => {
          // Phase 2.5f — inline-positioned image rendering.
          //
          // Multimodal models like Gemini 2.5 Flash Image emit a
          // literal `<image>` text marker in their response content
          // to signal "an image was placed at this position in the
          // text flow". We split the content at these markers and
          // interleave image thumbnails between text segments so
          // images appear at the position the model intended.
          //
          // Only applies to ASSISTANT messages with image
          // attachments. User messages don't emit positional markers
          // (the writer just types text and attaches files); their
          // images stay below the text via the AttachmentStrip.
          // Non-image attachments (text / file chips) always go
          // below regardless of markers.
          const allAttachments = Array.isArray(message.attachments) ? message.attachments : []
          const imageAttachments = allAttachments.filter((a) => a && a.kind === 'image' && a.data_url)
          const nonImageAttachments = allAttachments.filter((a) => a && a.kind !== 'image')
          const useInline = !isUser && imageAttachments.length > 0
          const inlineSplit = useInline
            ? _splitContentByImageMarkers(message.content || '', imageAttachments)
            : null
          const inlineSegments = inlineSplit ? inlineSplit.segments : null
          // Images that didn't get a positional marker (or extras
          // beyond what the markers consumed) overflow into the
          // existing AttachmentStrip below the text — preserves the
          // "all images appended at the bottom" fallback when the
          // model didn't emit markers at all OR emitted fewer
          // markers than it returned images.
          const overflowImages = inlineSplit ? inlineSplit.overflow : imageAttachments
          const stripAttachments = useInline
            ? [...overflowImages, ...nonImageAttachments]
            : allAttachments

          if (isEditing) {
            return (
              <InlineEditor
                value={editDraft}
                onChange={setEditDraft}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saveLabel={isUser ? 'Resubmit' : 'Save'}
                onSecondary={isUser && onEditUserSaveOnly ? saveEditNoResubmit : null}
                secondaryLabel={isUser && onEditUserSaveOnly ? 'Save' : null}
              />
            )
          }

          return (
            <>
              <div
                ref={bodyRef}
                data-help-region="message-bubble:body"
                onContextMenu={handleExcerptContextMenu}
                className={`text-[12px] text-zinc-100 leading-relaxed break-words ${isCollapsed ? 'overflow-hidden relative' : ''}`}
                style={isCollapsed ? { maxHeight: COLLAPSED_PX } : undefined}
              >
                {inlineSegments
                  ? inlineSegments.map((seg, idx) => (
                      seg.type === 'text'
                        ? (seg.content
                            ? (renderAsMarkdown
                                ? <MarkdownBody key={`seg-${idx}`} content={seg.content} accent={accent} nameTargets={nameTargets} highlightEnabled={highlightEnabled} />
                                : <RawBody     key={`seg-${idx}`} content={seg.content} />)
                            : null)
                        : <InlineImage
                            key={`seg-${idx}`}
                            attachment={seg.attachment}
                            accent={accent}
                            sessionKey={`${message.id}-inline-${idx}`}
                            hiddenFromModel={!activeSupportsImageInput}
                          />
                    ))
                  : (renderAsMarkdown
                      ? <MarkdownBody content={message.content || ''} accent={accent} nameTargets={nameTargets} highlightEnabled={highlightEnabled} />
                      : <RawBody     content={message.content || ''} />)}
                {streaming && !(message.reasoning_text && !(message.content || '').length) && (
                  // Suppress the tail coin during the "thinking" phase — the
                  // disclosure header above is already showing its own coin
                  // for that. Re-appears as soon as the first answer-content
                  // token arrives so the writer sees the "still streaming"
                  // signal at the tail of the answer.
                  <span
                    className="nn-streaming-coin"
                    style={{ color: accent || '#a78bfa' }}
                    aria-label="Waiting for AI response"
                    title="Waiting for the AI response."
                  >
                    <svg viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
                    </svg>
                  </span>
                )}
                {isCollapsed && (
                  <button
                    type="button"
                    onClick={() => setIsCollapsed(false)}
                    className="absolute bottom-0 left-0 right-0 text-[10px] text-accent-300 hover:text-accent-200 bg-gradient-to-t from-zinc-900/90 via-zinc-900/70 to-transparent pt-2 pb-0.5 text-center"
                  >
                    Show more ↓
                  </button>
                )}
              </div>
              {stripAttachments.length > 0 && (
                <AttachmentStrip
                  attachments={stripAttachments}
                  accent={accent}
                  isUser={isUser}
                  imageHiddenFromModel={!activeSupportsImageInput}
                  fileHiddenFromModel={!activeSupportsFileInput}
                />
              )}
            </>
          )
        })()}

        {Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && (
          <ToolCallStrip toolCalls={message.tool_calls} />
        )}

        {!isEditing && (
          <HoverActionRow
            isUser={isUser}
            isCollapsed={isCollapsed}
            isPinned={isPinned}
            isSticky={isSticky}
            copiedFlash={copiedFlash}
            showMutatingActions={showMutatingActions}
            onCopy={copyContent}
            onEdit={beginEdit}
            onToggleCollapse={() => setIsCollapsed((v) => !v)}
            onRetry={isUser ? null : (() => onRetry && onRetry(message.id))}
            onResend={isUser ? (() => onResend && onResend(message.id)) : null}
            onCycleStar={cycleStar}
            onClearStar={clearStar}
            starTitle={starTitle}
            onFork={() => onFork && onFork(message.id)}
            onViewContext={isUser && onViewContext ? () => onViewContext(message.id) : null}
            onDelete={() => onDelete && onDelete(message.id)}
            cachedInputTokens={cachedInputTokens}
            messageContent={message.content || ''}
          />
        )}
        <ApplyToSectionPicker
          open={!!excerptApply}
          left={excerptApply?.left || 0}
          top={excerptApply?.top || 0}
          sourceMarkdown={excerptApply?.text || ''}
          plainText
          showInitialActions
          onClose={closeExcerptApply}
        />
      </div>
    </div>
  )
}

// Phase 2.5 perf fix — `React.memo` on the default export so a
// re-render of the parent (`ConversationView`) doesn't cascade through
// every bubble when only one message's content has changed. The
// referentially-stable callbacks the parent passes (`onRetry`,
// `onResend`, `setMessageRenderMode`, etc. — all `useCallback`-wrapped
// in `ConversationView`) make the shallow prop-equality check work.
// During streaming, only the streaming bubble's `message` prop
// changes; every other bubble's props are unchanged and skip render.
export default memo(MessageBubble)

// ── Reasoning disclosure ──────────────────────────────────────
//
// Phase 2.5f. Collapsible widget showing the assistant's chain-of-
// thought above the main answer. Only renders for assistant
// messages that actually have reasoning text on file.
//
// Open-state model:
//   - While the model is mid-thinking (the stream has shipped
//     reasoning chunks but no answer content yet) the widget is
//     auto-open so the writer can watch the thinking arrive live.
//   - As soon as the first answer-content chunk lands, the widget
//     auto-collapses so the answer is the focal point.
//   - At any moment the writer can click the header to override
//     the auto-state. Once they've manually clicked, their choice
//     wins for the rest of the session (this message instance).
//     A reload resets the override (collapse state isn't persisted).
//
// Footer: token-count + duration where the adapter supplies them.
// LM Studio reports token count, both LM Studio and OpenRouter
// report duration. Anything missing just doesn't render.
function ReasoningDisclosure({ reasoningText, tokenCount, durationMs, streaming, hasContent, accent }) {
  // null = follow auto-state; true / false = locked by writer click.
  const [userOpen, setUserOpen] = useState(null)
  const autoOpen = streaming && !hasContent
  const open = userOpen === null ? autoOpen : userOpen

  // Footer metadata bits, joined by middle-dots when both present.
  const footerBits = []
  if (typeof tokenCount === 'number' && tokenCount > 0) {
    footerBits.push(`${tokenCount} tokens`)
  }
  if (typeof durationMs === 'number' && durationMs > 0) {
    if (durationMs < 1000) footerBits.push(`${durationMs}ms`)
    else footerBits.push(`${(durationMs / 1000).toFixed(1)}s`)
  }

  return (
    <div
      className="rounded border text-zinc-300"
      style={{
        borderColor: withAlpha(accent, 0.3),
        backgroundColor: 'rgba(24, 24, 27, 0.5)',
      }}
    >
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200 cursor-pointer"
        aria-expanded={open}
        title={open ? 'Hide the model\'s thinking trace.' : 'Show the model\'s thinking trace.'}
      >
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
        >
          <path d="M5 3l5 5-5 5" />
        </svg>
        <span>Thinking</span>
        {/* Phase 2.5f item 13 — streaming coin on the disclosure
            header. Renders WHILE the model is mid-think: the
            stream has already shipped reasoning chunks but no
            answer content yet. As soon as content arrives the
            coin falls off here (thinking is done) and the
            existing main-content tail coin takes over. */}
        {streaming && !hasContent && (
          <span
            className="nn-streaming-coin"
            style={{ color: accent || '#a78bfa' }}
            aria-label="Thinking"
            title="The model is currently thinking."
          >
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
        )}
        {footerBits.length > 0 && (
          <span className="ml-auto normal-case tracking-normal text-[9px] text-zinc-500">
            {footerBits.join(' · ')}
          </span>
        )}
      </button>
      {open && (
        <div
          className="px-2 py-1.5 text-[11px] text-zinc-400 italic leading-relaxed whitespace-pre-wrap break-words border-t"
          style={{ borderColor: withAlpha(accent, 0.2) }}
        >
          {reasoningText}
        </div>
      )}
    </div>
  )
}


// ── Hover action row ──────────────────────────────────────────
//
// Sits along the bottom of the bubble, hidden until the bubble is
// hovered (via the parent's `group/bubble` class). All actions
// live as single icon buttons here — no nested overflow menu.
// Tooltips on each button spell out exactly what the action does.
// Read-only actions (Copy, Collapse) stay available during
// streaming; mutating actions (Edit, Retry, Pin, Fork, Delete)
// are gated on `showMutatingActions`. Forward-looking actions
// (Apply to editor → Phase 2.7, Add as Context Cue → Phase 2.5e)
// render as disabled buttons whose tooltips point at the phase
// that wires them up.
function HoverActionRow({
  isUser,
  isCollapsed,
  isPinned,
  isSticky,
  copiedFlash,
  showMutatingActions,
  onCopy,
  onEdit,
  onToggleCollapse,
  onRetry,
  onResend,
  onCycleStar,
  onClearStar,
  starTitle,
  onFork,
  onViewContext,
  onDelete,
  // Phase 2.5i — optional cache-hit indicator (latest bubble only).
  // Integer or null. Renders at the far left of the row, inline
  // with the action buttons but visually distinct (smaller, muted,
  // always visible — not gated on hover). Null hides it entirely.
  cachedInputTokens,
  // Phase 2.9b — message content forwarded to ApplyToSectionMenu so
  // the Apply popover can hand it to the dispatcher on click.
  messageContent,
}) {
  const cacheText = typeof cachedInputTokens === 'number'
    ? (cachedInputTokens > 0
        ? `cached: ${cachedInputTokens.toLocaleString()} tokens`
        : 'no cached tokens this turn')
    : null
  return (
    <div data-help-region="message-bubble:actions" className="flex items-center justify-between gap-2 pt-1 opacity-0 group-hover/bubble:opacity-100 focus-within:opacity-100 transition-opacity">
      {cacheText ? (
        <span className="text-[9.5px] text-zinc-600 select-none">{cacheText}</span>
      ) : (
        <span />
      )}
      <div className="flex justify-end gap-1">
      <ApplyToSectionMenu
        messageContent={messageContent}
        ApplyIcon={Icons.apply}
        dataHelpRegion="message-bubble:action_apply"
      />
      <IconButton
        title={copiedFlash ? 'Copied!' : 'Copy message text to clipboard'}
        onClick={onCopy}
        dataHelpRegion="message-bubble:action_copy"
      >{copiedFlash ? <Icons.check /> : <Icons.copy />}</IconButton>
      {showMutatingActions && (
        <IconButton
          title={isUser
            ? 'Edit and resubmit this message. Resubmitting drops any messages after this one and re-streams the reply.'
            : 'Edit this message in place (text only; does not regenerate).'}
          onClick={onEdit}
          dataHelpRegion="message-bubble:action_edit"
        ><Icons.edit /></IconButton>
      )}
      <IconButton
        title={isCollapsed ? 'Expand to full height' : 'Collapse to a short preview'}
        onClick={onToggleCollapse}
        dataHelpRegion="message-bubble:action_collapse"
      >{isCollapsed ? <Icons.expand /> : <Icons.collapse />}</IconButton>
      {!isUser && (
        <IconButton
          disabled={!showMutatingActions}
          title="Retry: discard this response and re-stream a fresh reply from the preceding user message."
          onClick={onRetry}
          dataHelpRegion="message-bubble:action_retry"
        ><Icons.retry /></IconButton>
      )}
      {isUser && (
        <IconButton
          disabled={!showMutatingActions}
          title="Resend: re-send this message and stream a fresh reply. If there's already a reply below this message, it will be discarded first."
          onClick={onResend}
          dataHelpRegion="message-bubble:action_resend"
        ><Icons.retry /></IconButton>
      )}
      <IconButton
        title={starTitle}
        accent={isPinned}
        goldFlavor
        glow={isSticky}
        onClick={onCycleStar}
        onContextMenu={onClearStar}
        dataHelpRegion="message-bubble:action_favourite"
      ><Icons.star filled={isSticky} /></IconButton>
      <IconButton
        disabled={!showMutatingActions}
        title="Fork conversation: start a new thread pre-loaded with the history up to and including this message. The current conversation will be cleared from the panel (its saved copy stays in the thread browser)."
        onClick={onFork}
        dataHelpRegion="message-bubble:action_fork"
      ><Icons.fork /></IconButton>
      {onViewContext && (
        <IconButton
          title="View attached context: open the exact context that was sent with this message (scene + pinned items in force at that point in the conversation)."
          onClick={onViewContext}
          dataHelpRegion="message-bubble:action_view_context"
        ><Icons.context /></IconButton>
      )}
      <IconButton
        disabled
        title="Add as Context Cue: available in Phase 2.5e once the Context Cue Library ships."
        dataHelpRegion="message-bubble:action_add_cue"
      ><Icons.puzzle /></IconButton>
      <IconButton
        danger
        disabled={!showMutatingActions}
        title={isUser
          ? 'Delete this message (and the paired AI reply, if any, after confirmation).'
          : 'Delete this message.'}
        onClick={onDelete}
        dataHelpRegion="message-bubble:action_delete"
      ><Icons.trash /></IconButton>
      </div>
    </div>
  )
}

// Small square icon button used throughout the hover action row.
// `accent` lights the button up in the active accent for "on"
// states (pinned). `danger` swaps the hover to red for destructive
// actions. `disabled` greys it out and blocks clicks.
function IconButton({ children, title, onClick, onContextMenu, disabled, danger, accent, goldFlavor, glow, dataHelpRegion }) {
  let className = 'flex items-center justify-center w-5 h-5 rounded border transition-colors '
  if (disabled) {
    className += 'border-zinc-800 bg-zinc-900/30 text-zinc-600 cursor-not-allowed opacity-50'
  } else if (danger) {
    className += 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-red-200 hover:bg-red-900/40 hover:border-red-700/60'
  } else if (accent && goldFlavor) {
    className += 'border-amber-700/60 bg-amber-900/20 text-amber-300 hover:bg-amber-900/40'
  } else if (accent) {
    className += 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50'
  } else {
    className += 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
  }
  // `glow` adds a soft amber drop-shadow on the icon for sticky
  // favourites — sits on top of the gold colour so the difference
  // between "fav" (outline gold) and "fav + sticky" (filled gold
  // with a halo) reads at a glance.
  const style = glow
    ? { filter: 'drop-shadow(0 0 3px rgba(252, 211, 77, 0.75))' }
    : undefined
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      onContextMenu={disabled ? undefined : onContextMenu}
      title={title}
      aria-label={title}
      disabled={disabled}
      data-help-region={dataHelpRegion}
      className={className}
      style={style}
    >
      {children}
    </button>
  )
}

// ── Icons ─────────────────────────────────────────────────────
// Inline SVGs sized at 12px with currentColor stroke so they
// inherit the IconButton's text colour. Kept here (rather than a
// shared icon library) because they're scoped to the chat panel
// and tuned to its 20px button size.
const Icons = {
  copy: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M3 10.5V3.5a1 1 0 011-1h7" />
    </svg>
  ),
  check: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ),
  edit: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z" />
      <path d="M9.5 4l2.5 2.5" />
    </svg>
  ),
  collapse: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5l4-3 4 3" />
      <path d="M4 6l4-3 4 3" />
    </svg>
  ),
  expand: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5l4 3 4-3" />
      <path d="M4 10l4 3 4-3" />
    </svg>
  ),
  retry: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8a5 5 0 11-1.5-3.5" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  ),
  star: ({ filled }) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.8l1.9 4 4.4.5-3.3 3 1 4.3L8 11.4 3.9 13.6l1-4.3-3.3-3 4.4-.5z" />
    </svg>
  ),
  // Phase 2.5d "view attached context" icon — stacked-document
  // glyph signalling "see what context was sent with this turn".
  context: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="2.5" width="8" height="9" rx="1" />
      <path d="M5.5 5h4M5.5 7h4M5.5 9h2.5" />
      <path d="M5 4V13a1 1 0 001 1h6.5" />
    </svg>
  ),
  fork: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3.5" r="1.3" />
      <circle cx="12" cy="3.5" r="1.3" />
      <circle cx="8" cy="12.5" r="1.3" />
      <path d="M4 4.8v2a2 2 0 002 2h4a2 2 0 002-2v-2" />
      <path d="M8 8.8v2.4" />
    </svg>
  ),
  apply: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
      <path d="M5.5 8.5h5" />
      <path d="M7.5 6.5l-2 2 2 2" />
    </svg>
  ),
  puzzle: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5h2.5a1.5 1.5 0 113 0H10v2.5a1.5 1.5 0 100 3V13.5H3v-2.5a1.5 1.5 0 110-3z" />
    </svg>
  ),
  trash: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5h10" />
      <path d="M6.5 4V2.5h3V4" />
      <path d="M5 4.5l.5 9h5l.5-9" />
    </svg>
  ),
}

// ── Inline editor ─────────────────────────────────────────────
//
// Replaces the body of a bubble when the writer chooses Edit.
// Textarea + Save/Cancel buttons. Auto-focus and Ctrl+Enter to
// save / Escape to cancel keep the flow fast.
function InlineEditor({ value, onChange, onSave, onCancel, saveLabel, onSecondary = null, secondaryLabel = null }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.focus()
      const len = ref.current.value.length
      ref.current.setSelectionRange(len, len)
    }
  }, [])
  // Auto-grow the textarea to fit content. The previous `rows={...}`
  // estimate only counted newline characters, which under-counted
  // wrapped lines (a long single-line message that wraps onto 8
  // visual lines was rendered as a 3-row textarea, forcing the
  // writer to scroll within the editor to see their own message).
  // Reset height to `auto` first so shrinks work too, then set to
  // `scrollHeight`. CSS `max-height` caps the growth so a very long
  // message doesn't dominate the panel; the textarea scrolls
  // internally past that point. `resize-y` still lets the writer
  // override manually, but a subsequent keystroke will re-auto-grow.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px` // +2 = border allowance
  }, [value])
  return (
    <div className="space-y-1">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSave()
          }
        }}
        rows={3}
        className="w-full bg-zinc-900 text-[12px] text-zinc-100 px-2 py-1.5 rounded border border-zinc-700 focus:outline-none focus:border-accent-500 resize-y leading-relaxed font-mono"
        style={{ maxHeight: '60vh' }}
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700/60"
          title="Cancel edit (Escape)"
        >Cancel</button>
        {onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700/60"
            title="Save the edit without re-sending the message. Downstream messages are kept."
          >{secondaryLabel}</button>
        )}
        <button
          type="button"
          onClick={onSave}
          className="text-[10px] px-2 py-0.5 rounded border border-accent-700/60 bg-accent-900/40 text-accent-100 hover:bg-accent-900/60"
          title="Save edit (Ctrl+Enter)"
        >{saveLabel}</button>
      </div>
    </div>
  )
}

// ── Raw render ─────────────────────────────────────────────────
function RawBody({ content }) {
  return <span className="whitespace-pre-wrap">{content}</span>
}

// ── Markdown render ───────────────────────────────────────────
// Custom component overrides give markdown elements styling that
// fits the chat panel (the codebase doesn't have tailwind-typography
// installed so we provide our own tight, dark-theme-friendly styles).
//
// Phase 2.8a — name-highlight pass. When `highlightEnabled` is on
// AND `nameTargets` is non-empty, each block-level component
// (`p`, `li`, `td`, `th`, `h1`-`h6`, `blockquote`) routes its
// `children` through `<HighlightChildren>` which walks the React
// children tree once per render and wraps text-node match runs
// in styled spans (skipping `<a>` / `<code>` / `<pre>` subtrees).
// The wrap is a no-op when either flag is off, so existing chat
// bubbles render unchanged when the writer disables highlighting.
export function MarkdownBody({ content, accent, nameTargets, highlightEnabled }) {
  // Phase 2.8a perf-fix — Streamdown wraps each markdown block in
  // its own `React.memo` so previously-rendered blocks skip
  // re-parse as streaming continues. That memo keys on the block's
  // content, NOT on the `components` prop, so when name targets
  // rotate (e.g. the writer changes a character's colour) the
  // cached block output keeps its STALE closure over the highlight
  // values — the colour painted on the highlight span stays at the
  // old value. The `key` here changes whenever the highlight target
  // set changes (we hash the targets' identity + colour pairs),
  // which forces Streamdown to discard its cached block memo and
  // re-render with the fresh components / closures. Cost: only
  // pays when the target set actually rotates (rare relative to
  // streaming token deltas), so the streaming-perf win is
  // preserved for the common case.
  const highlightKey = highlightEnabled && nameTargets && nameTargets.length
    ? `${nameTargets.length}|${nameTargets.map((t) => `${t.entityId}:${t.colour}`).join(',')}|${accent}`
    : 'off'
  // v0.2.9.47 perf-fix — the `components` object + the inner
  // `HWrap` wrapper used to be reconstructed on every MarkdownBody
  // render with fresh function references. Streamdown's trailing-
  // block-being-streamed re-renders on every token, and each
  // render passed it a new `components` reference; the markdown
  // element overrides inside (h1 / p / li / blockquote / th / td
  // etc.) are React component types as far as Streamdown's
  // renderer is concerned, so a new function reference means React
  // treats them as a different component type and tears down +
  // rebuilds their DOM on each token. Same anti-pattern as the
  // editor toolbar's `G` wrapper (v0.2.9.46). Fix: memoise the
  // components object on the inputs that actually drive its
  // closures (`accent`, `nameTargets`, `highlightEnabled`). When
  // those values stay stable across renders (the common case
  // mid-stream), the components object and its inner functions
  // keep stable identities and React reconciles in place rather
  // than tearing down. When those values DO change (writer rotates
  // a character's colour, toggles highlight, etc.), the closures
  // rebuild and the `highlightKey` mechanism above forces
  // Streamdown to re-mount the cached blocks too — correct
  // behaviour preserved.
  const components = useMemo(() => {
    const HWrap = (props) => (
      <HighlightChildren targets={nameTargets} enabled={highlightEnabled} accentColor={accent}>
        {props.children}
      </HighlightChildren>
    )
    return {
      h1: (props) => <h1 className="text-[15px] font-semibold mt-2 mb-1 text-zinc-100" {...props}><HWrap>{props.children}</HWrap></h1>,
      h2: (props) => <h2 className="text-[14px] font-semibold mt-2 mb-1 text-zinc-100" {...props}><HWrap>{props.children}</HWrap></h2>,
      h3: (props) => <h3 className="text-[13px] font-semibold mt-1.5 mb-1 text-zinc-100" {...props}><HWrap>{props.children}</HWrap></h3>,
      h4: (props) => <h4 className="text-[12px] font-semibold mt-1.5 mb-1 text-zinc-100" {...props}><HWrap>{props.children}</HWrap></h4>,
      h5: (props) => <h5 className="text-[12px] font-semibold mt-1 mb-0.5 text-zinc-200" {...props}><HWrap>{props.children}</HWrap></h5>,
      h6: (props) => <h6 className="text-[11px] font-semibold mt-1 mb-0.5 text-zinc-300" {...props}><HWrap>{props.children}</HWrap></h6>,
      p:  (props) => <p className="my-1 whitespace-pre-wrap" {...props}><HWrap>{props.children}</HWrap></p>,
      ul: (props) => <ul className="list-disc pl-5 my-1 space-y-0.5" {...props} />,
      ol: (props) => <ol className="list-decimal pl-5 my-1 space-y-0.5" {...props} />,
      li: (props) => <li className="leading-snug" {...props}><HWrap>{props.children}</HWrap></li>,
      strong: (props) => <strong className="font-semibold text-zinc-50" {...props} />,
      em: (props) => <em className="italic" {...props} />,
      a: (props) => <a className="text-accent-300 underline hover:text-accent-200" target="_blank" rel="noreferrer" {...props} />,
      blockquote: (props) => (
        <blockquote
          className="border-l-2 pl-2 my-1 italic text-zinc-300"
          style={{ borderColor: withAlpha(accent, 0.55) }}
          {...props}
        >
          <HWrap>{props.children}</HWrap>
        </blockquote>
      ),
      hr: () => <hr className="my-2 border-zinc-700" />,
      code: CodeRenderer,
      pre: ({ children }) => <>{children}</>, // CodeRenderer handles the block wrapper itself
      table: (props) => <table className="my-1 border-collapse text-[11px]" {...props} />,
      th: (props) => <th className="border border-zinc-700 px-1.5 py-0.5 text-left bg-zinc-800/60" {...props}><HWrap>{props.children}</HWrap></th>,
      td: (props) => <td className="border border-zinc-700 px-1.5 py-0.5" {...props}><HWrap>{props.children}</HWrap></td>,
    }
  }, [accent, nameTargets, highlightEnabled])
  // Phase 2.5 perf fix — Streamdown is Vercel's drop-in replacement
  // for `react-markdown` tuned for LLM streaming: bundles `remark-gfm`
  // by default, splits message content into markdown blocks and wraps
  // each one in `React.memo` so previously-stable blocks skip re-parse
  // as new tokens land in the trailing in-progress block. Also auto-
  // closes mid-stream unterminated `**` / `` ``` `` / `[...](...)` so
  // the writer doesn't see broken markdown flash. Same `components`
  // override prop shape as the previous `<ReactMarkdown>` call so
  // nothing else in this file needs changing.
  //
  // Phase 2.5i follow-up — `plugins={[_MERMAID_PLUGIN]}` wires
  // `@streamdown/mermaid` into Streamdown's Block component. When a
  // fenced code block carries `language-mermaid`, Streamdown takes its
  // own diagram-render path and bypasses our `components.code`
  // override entirely. Useful for character / plot / scene-flow
  // visualisations the model produces.
  return (
    <Streamdown key={highlightKey} components={components} plugins={_STREAMDOWN_PLUGINS}>
      {content}
    </Streamdown>
  )
}

// Code block renderer. Inline code stays inline with a small tint;
// fenced code blocks render as a bordered, monospace block with a
// per-block "Raw" toggle in the top-right corner that flips JUST
// that one block to verbatim ``` source. Per-block state is
// session-only and lives in the component instance.
function CodeRenderer({ inline, className, children, ...props }) {
  const text = String(children ?? '').replace(/\n$/, '')
  // react-markdown v9 doesn't pass an `inline` prop reliably; we
  // detect inline vs block by checking whether there's a language
  // class (block code always carries `language-*`) or whether the
  // content has a newline (block code typically does). Defensive
  // fallback: items inside a <pre> are always block.
  const isBlock = !inline && (
    (className && className.startsWith('language-')) || text.includes('\n')
  )
  if (!isBlock) {
    return (
      <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-100 text-[11px] font-mono" {...props}>
        {children}
      </code>
    )
  }
  return <CodeBlock text={text} className={className} />
}

// Unicode box-drawing + block-element ranges. If a fenced code block's
// content uses any of these, treat it as an ASCII-art diagram: NC's
// export inserts a blank line after every line (fine for prose, breaks
// the visual continuity of a diagram). For the rendered view we
// strip blank lines that sit BETWEEN two box-drawing lines. The Raw
// toggle keeps showing the verbatim source so nothing is hidden.
const _BOX_DRAWING_RE = /[─-▟]/

function _stripAsciiArtBlanks(text) {
  if (!_BOX_DRAWING_RE.test(text)) return text
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' && i > 0 && i < lines.length - 1) {
      const prev = lines[i - 1]
      const next = lines[i + 1]
      if (_BOX_DRAWING_RE.test(prev) && _BOX_DRAWING_RE.test(next)) continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function CodeBlock({ text, className }) {
  const [showRaw, setShowRaw] = useState(false)
  const lang = className?.replace(/^language-/, '') || ''
  const displayText = useMemo(() => _stripAsciiArtBlanks(text), [text])
  // Phase 2.5i follow-up — Mermaid blocks render as SVG via the
  // `@streamdown/mermaid` plugin's `getMermaid()` API. The Raw / Code
  // toggle still works (Raw shows the fenced source), but the default
  // view is the rendered diagram. Routing happens in-place inside the
  // existing CodeBlock wrapper so the surrounding chrome (header
  // strip, toggle button) stays consistent with other code blocks.
  // Reason we don't lean on Streamdown's own gating: our
  // `components.code` override replaces Streamdown's internal `ss`
  // renderer entirely, and the `if (m === "mermaid" && d)` gate lives
  // INSIDE `ss`. Calling the plugin directly is simpler than
  // round-tripping back through Streamdown for one code path.
  if (lang === 'mermaid' && !showRaw) {
    return <MermaidBlock source={text} onToggleRaw={() => setShowRaw(true)} />
  }
  // Raw view shows the ``` fences + language tag so the writer
  // sees the exact source the AI sent, character-for-character.
  // Toggle does NOT alter the underlying message content; it's
  // purely a display switch for this one block in this session.
  const rawSource = lang
    ? '```' + lang + '\n' + text + '\n```'
    : '```\n' + text + '\n```'

  return (
    <div className="relative my-1.5 rounded border border-zinc-700 bg-zinc-900/70 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-700 bg-zinc-800/40">
        <span className="text-[9px] text-zinc-500 uppercase tracking-wider">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          title={showRaw
            ? 'Showing raw fenced source for this code block. Click to render.'
            : 'Showing rendered code. Click to see the verbatim ``` source for this block.'}
          className={`text-[9px] px-1.5 py-px rounded border transition-colors ${
            showRaw
              ? 'border-amber-700/60 bg-amber-900/30 text-amber-200 hover:bg-amber-900/50'
              : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {showRaw ? 'Raw' : 'Code'}
        </button>
      </div>
      <pre className="px-2 py-1.5 overflow-x-auto text-[11px] font-mono text-zinc-100 whitespace-pre">
        <code>{showRaw ? rawSource : displayText}</code>
      </pre>
    </div>
  )
}


// ── Mermaid block (Phase 2.5i) ────────────────────────────────
//
// Renders a Mermaid diagram from a fenced `language-mermaid` code
// block. Calls the @streamdown/mermaid plugin's `getMermaid()` to
// obtain a Mermaid instance configured with our dark-theme / strict-
// security settings, then runs `mermaid.render(id, source)` to get
// the SVG and drops it into a div via dangerouslySetInnerHTML.
//
// Async render is wrapped in an effect with a `cancelled` flag so a
// re-render mid-flight (e.g. streaming content mutating the source)
// doesn't write stale SVG into the DOM. Error state surfaces a small
// inline notice with the underlying error text so the writer sees
// invalid Mermaid syntax instead of a silent blank block.
//
// `onToggleRaw` is the same Raw toggle pattern as the rest of the
// code-block chrome — clicking it flips this block to source view
// without affecting other blocks in the conversation.
function MermaidBlock({ source, onToggleRaw }) {
  const [svg, setSvg] = useState(null)
  const [error, setError] = useState(null)
  // Stable id per instance so Mermaid's internal element-id machinery
  // doesn't collide when several diagrams render on the same page.
  // Computed once via useState's lazy initialiser so the ref's value
  // is stable across renders without calling impure functions during
  // the render itself (StrictMode double-render would otherwise burn
  // an extra random per dev render).
  const [diagramId] = useState(() => `nn-mermaid-${Math.random().toString(36).slice(2, 10)}`)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setSvg(null)
    const trimmed = (source || '').trim()
    if (!trimmed) return undefined
    let mermaidInstance
    try {
      mermaidInstance = _MERMAID_PLUGIN.getMermaid()
    } catch (e) {
      setError(e?.message || String(e))
      return undefined
    }
    mermaidInstance.render(diagramId, trimmed).then((result) => {
      if (cancelled) return
      setSvg(result?.svg || '')
    }).catch((e) => {
      if (cancelled) return
      setError(e?.message || String(e))
    })
    return () => { cancelled = true }
  }, [source])

  return (
    <div className="relative my-1.5 rounded border border-zinc-700 bg-zinc-900/70 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-700 bg-zinc-800/40">
        <span className="text-[9px] text-zinc-500 uppercase tracking-wider">mermaid</span>
        <button
          type="button"
          onClick={onToggleRaw}
          title="Currently rendered as a diagram. Click to view the verbatim ``` source for this block."
          className="text-[9px] px-1.5 py-px rounded border border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Code
        </button>
      </div>
      <div className="px-2 py-2 overflow-x-auto">
        {error ? (
          <div className="text-[11px] text-red-300 font-mono whitespace-pre-wrap">
            Mermaid render failed: {error}
          </div>
        ) : svg ? (
          <div className="[&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="text-[11px] text-zinc-500 italic">Rendering diagram…</div>
        )}
      </div>
    </div>
  )
}


// ── Tool-call strip ───────────────────────────────────────────
//
// Surfaces the MCP / plugin tool calls the assistant made during
// this message. The latest call is always rendered as a full chip
// with the tool name and a short preview of the arguments (so the
// writer can see *what* the AI is doing, not just that something
// is happening). Any prior calls collapse into a single stacked
// "N earlier tool calls" pill that expands on click to show the
// full list. The detail level is gated on a user preference
// (`tool_call_detail`):
//   "name" / null → chips are status + tool name + brief args
//                    preview; the prior-calls list shows tool
//                    names + status only.
//   "full"        → chips become expandable; click reveals the
//                    full arguments JSON the model sent and the
//                    raw output the tool returned, both on the
//                    latest chip and on every entry in the
//                    prior-calls list.
// ── Attachment strip ──────────────────────────────────────────
//
// Renders the files that rode with this message — image
// attachments as moderate-sized clickable thumbnails (click opens
// the Media Preview Panel via the existing `chat_attachment`
// source type), text + file kinds as small chip badges with
// filename + size (no click action for now; their content was
// inlined into the model's view at send time, not preserved
// separately for replay).
function AttachmentStrip({ attachments, accent, isUser = true, imageHiddenFromModel = false }) {
  const togglePreview = usePreviewStore((s) => s.togglePreview)
  const openTextAttachmentInEditor = useUiStore((s) => s.openTextAttachmentInEditor)
  if (!attachments || attachments.length === 0) return null
  // User attachments hug the right edge (matching the right-aligned
  // user bubble); assistant attachments — Phase 2.5e received images
  // — hug the left edge so they read as part of the assistant's
  // left-aligned reply.
  const alignClass = isUser ? 'justify-end' : 'justify-start'
  return (
    <div className={`flex flex-wrap items-start ${alignClass} gap-1.5 pt-1`}>
      {attachments.map((a, idx) => {
        const key = `${a.name || 'att'}-${idx}`
        if (a.kind === 'image' && a.data_url) {
          return (
            <div
              key={key}
              className="group/imgthumb relative rounded border overflow-hidden"
              style={{ borderColor: accent || '#7c3aed' }}
            >
              <button
                type="button"
                onClick={() => togglePreview({
                  type: 'chat_attachment',
                  sessionId: key,
                  url: a.data_url,
                  kind: 'image',
                  title: a.name,
                  size: a.size,
                  colour: accent,
                })}
                title={`${a.name}${a.size ? ` · ${_formatBytes(a.size)}` : ''} · click to preview`}
                className="block hover:opacity-90 transition-opacity"
              >
                <img
                  src={a.data_url}
                  alt={a.name || 'attached image'}
                  className="block max-h-64 max-w-[280px] object-contain"
                  draggable
                  onDragStart={makeProfileImageDragStart(a.data_url)}
                />
              </button>
              {imageHiddenFromModel && <HiddenFromModelStripe />}
              <a
                href={a.data_url}
                download={a.name || 'image'}
                onClick={(e) => e.stopPropagation()}
                title={`Download ${a.name || 'image'}`}
                aria-label={`Download ${a.name || 'image'}`}
                className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded bg-zinc-900/40 text-zinc-100 border border-zinc-700/60 opacity-0 group-hover/imgthumb:opacity-100 transition-colors transition-opacity hover:bg-zinc-900/70 hover:text-[var(--nn-accent)]"
                style={{ '--nn-accent': accent || '#7c3aed' }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
            </div>
          )
        }
        // Text-kind pill — clickable when `text_content` was
        // persisted with the message. Opens the file in the
        // editor panel in read-only mode via `openTextAttachmentInEditor`
        // (toggles closed when clicked again on the same file).
        // File-kind (PDF) stays non-interactive; their bytes
        // rode the wire once and aren't persisted for replay.
        const canOpenTextInEditor = a.kind === 'text' && typeof a.text_content === 'string' && a.text_content.length > 0
        const baseClasses = 'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full border border-emerald-700/60 bg-emerald-900/25 text-emerald-100'
        const interactiveClasses = canOpenTextInEditor
          ? ' hover:bg-emerald-800/40 cursor-pointer transition-colors'
          : ''
        const titleText = canOpenTextInEditor
          ? `${a.name}${a.size ? ` · ${_formatBytes(a.size)}` : ''} · click to open in editor (read-only)`
          : `${a.name}${a.size ? ` · ${_formatBytes(a.size)}` : ''}`
        if (canOpenTextInEditor) {
          return (
            <button
              key={key}
              type="button"
              onClick={() => openTextAttachmentInEditor(a.name, a.text_content)}
              className={`${baseClasses}${interactiveClasses}`}
              title={titleText}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300 flex-shrink-0">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="truncate max-w-[160px]">{a.name}</span>
              {a.size > 0 && (
                <span className="text-emerald-300/80 flex-shrink-0">{_formatBytes(a.size)}</span>
              )}
            </button>
          )
        }
        return (
          <span
            key={key}
            className={baseClasses}
            title={titleText}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300 flex-shrink-0">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <span className="truncate max-w-[160px]">{a.name}</span>
            {a.size > 0 && (
              <span className="text-emerald-300/80 flex-shrink-0">{_formatBytes(a.size)}</span>
            )}
          </span>
        )
      })}
    </div>
  )
}


// Bytes → human label. Matches the formatter in AttachedFileChips
// so the chip-in-staging and the bubble-thumbnail report sizes the
// same way.
function _formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
}


function ToolCallStrip({ toolCalls }) {
  const detailMode = useSettingsStore((s) => s.preferences?.tool_call_detail) || 'name'
  const allowExpand = detailMode === 'full'
  if (!toolCalls.length) return null
  const latest = toolCalls[toolCalls.length - 1]
  const earlier = toolCalls.slice(0, -1)
  return (
    <div className="flex flex-wrap items-stretch gap-1 pt-1">
      {earlier.length > 0 && (
        <EarlierCallsPill calls={earlier} allowExpand={allowExpand} />
      )}
      <ToolCallChip call={latest} allowExpand={allowExpand} />
    </div>
  )
}

function ToolCallChip({ call, allowExpand }) {
  const accent = useAccentColor() || '#7c3aed'
  const [expanded, setExpanded] = useState(false)
  const status = call.status || 'running'
  const isRunning = status === 'running'
  const tone = isRunning ? '' : _toneFor(status)
  const glyph = _glyphFor(status)
  const toolName = call.tool && call.tool !== 'tool' ? call.tool : 'tool call'
  const argsPreview = _summarizeArguments(call.arguments)
  const titleText = _composeChipTitle(call, status, toolName, allowExpand)

  const clickable = allowExpand && (status === 'success' || status === 'failure')

  // While the call is in flight we paint the chip in the story
  // accent and tag it with the `nn-tool-active` class for the
  // soft glow + travelling border highlight defined in
  // `src/index.css`. The `--tool-active-accent` custom property
  // is read by that animation; we set it inline so the highlight
  // tracks whatever the active story's accent happens to be.
  const runningStyle = isRunning ? {
    '--tool-active-accent': withAlpha(accent, 0.95),
    borderColor: withAlpha(accent, 0.65),
    backgroundColor: withAlpha(accent, 0.15),
    color: withAlpha(accent, 0.95),
  } : undefined

  return (
    <div
      data-help-region="tool-call-chip:chip"
      className={`rounded border text-[10px] ${tone} max-w-full ${isRunning ? 'nn-tool-active' : ''}`}
      style={runningStyle}
    >
      <button
        type="button"
        onClick={clickable ? () => setExpanded((v) => !v) : undefined}
        title={titleText}
        className={`flex items-start gap-1.5 px-1.5 py-0.5 leading-tight max-w-full text-left ${clickable ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`}
      >
        <span className="font-mono flex-shrink-0 leading-tight">{glyph}</span>
        <span className="flex-1 min-w-0 break-words" style={_clampStyle(2)}>
          {isRunning && <span className="uppercase tracking-wider opacity-80 mr-1">Using</span>}
          <span className="font-medium">{toolName}</span>
          {argsPreview && (
            <span className="opacity-80 font-mono"> · {argsPreview}</span>
          )}
        </span>
        {call.provider_type === 'ephemeral_mcp' && (
          <span className="opacity-60 text-[9px] flex-shrink-0 leading-tight">MCP</span>
        )}
        {clickable && (
          <span className="opacity-60 text-[9px] flex-shrink-0 leading-tight">{expanded ? '▴' : '▾'}</span>
        )}
      </button>
      {expanded && allowExpand && (
        <ToolCallDetail call={call} />
      )}
      {!allowExpand && status === 'failure' && call.error_reason && (
        <div className="border-t border-current/30 px-2 py-0.5 text-[10px] font-mono break-words">
          {call.error_reason}
        </div>
      )}
    </div>
  )
}

// Compact stack of every tool call before the latest. Always shown
// as a single pill regardless of how many earlier calls there were;
// click to expand a list view. The overall pill colour reflects the
// worst status in the group (failure > running > success) so the
// writer can spot a failure that scrolled out of the latest slot at
// a glance.
function EarlierCallsPill({ calls, allowExpand }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const summaryTone = _toneFor(_worstStatus(calls))

  useEffect(() => {
    if (!open) return undefined
    function onDocDown(e) {
      if (!containerRef.current) return
      if (containerRef.current.contains(e.target)) return
      setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${calls.length} earlier tool call${calls.length === 1 ? '' : 's'}: click to expand`}
        data-help-region="tool-call-chip:earlier_calls"
        className={`flex items-center gap-1.5 px-1.5 py-0.5 leading-tight rounded border text-[10px] ${summaryTone} hover:brightness-110`}
      >
        <span className="font-mono">{open ? '⏶' : '⏷'}</span>
        <span className="font-medium">earlier tools</span>
        <span className="inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full bg-zinc-900/60 text-[9px] font-semibold">
          {calls.length}
        </span>
      </button>
      {open && (
        // Expands UPWARD from the pill rather than down so the
        // dropdown doesn't crash into the input area / hover row
        // immediately below the message bubble. `bottom-full` anchors
        // the bottom edge of the popover to the top of the pill;
        // `mb-1` keeps a small gap.
        <div className="absolute left-0 bottom-full mb-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl w-[440px] max-w-[min(560px,calc(100vw-2rem))] max-h-[320px] overflow-y-auto py-1 text-[10px]">
          <div className="px-2 py-1 text-zinc-500 text-[9px] uppercase tracking-wider border-b border-zinc-800">
            Earlier tool calls
          </div>
          {calls.map((call) => (
            <EarlierCallRow key={call.id} call={call} allowExpand={allowExpand} />
          ))}
        </div>
      )}
    </div>
  )
}

function EarlierCallRow({ call, allowExpand }) {
  const [open, setOpen] = useState(false)
  const status = call.status || 'running'
  const tone = _rowToneFor(status)
  const glyph = _glyphFor(status)
  const toolName = call.tool && call.tool !== 'tool' ? call.tool : 'tool call'
  const argsPreview = _summarizeArguments(call.arguments)
  const canExpand = allowExpand && (status === 'success' || status === 'failure')
  return (
    <div className={`px-2 py-1 ${tone}`}>
      <button
        type="button"
        onClick={canExpand ? () => setOpen((v) => !v) : undefined}
        title={_composeChipTitle(call, status, toolName, allowExpand)}
        className={`flex items-start gap-1.5 w-full text-left ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className="font-mono flex-shrink-0 leading-tight">{glyph}</span>
        <span className="flex-1 min-w-0 break-words" style={_clampStyle(2)}>
          <span className="font-medium">{toolName}</span>
          {argsPreview && (
            <span className="opacity-70 font-mono"> · {argsPreview}</span>
          )}
        </span>
        {canExpand && <span className="opacity-60 ml-auto flex-shrink-0">{open ? '▴' : '▾'}</span>}
      </button>
      {open && allowExpand && <ToolCallDetail call={call} />}
      {!allowExpand && status === 'failure' && call.error_reason && (
        <div className="text-[10px] font-mono break-words mt-0.5 opacity-90">{call.error_reason}</div>
      )}
    </div>
  )
}

function ToolCallDetail({ call }) {
  return (
    <div className="border-t border-current/30 px-2 py-1 space-y-1 text-[10px]">
      {call.error_reason && (
        <div>
          <div className="opacity-70 uppercase tracking-wide text-[9px]">Failure reason</div>
          <div className="font-mono whitespace-pre-wrap break-words">{call.error_reason}</div>
        </div>
      )}
      {call.arguments && (
        <div>
          <div className="opacity-70 uppercase tracking-wide text-[9px]">Arguments</div>
          <pre className="font-mono whitespace-pre-wrap break-words bg-zinc-900/40 rounded px-1.5 py-1 max-h-[160px] overflow-auto">
            {safeStringify(call.arguments)}
          </pre>
        </div>
      )}
      {call.output != null && (
        <div>
          <div className="opacity-70 uppercase tracking-wide text-[9px]">Output</div>
          <pre className="font-mono whitespace-pre-wrap break-words bg-zinc-900/40 rounded px-1.5 py-1 max-h-[240px] overflow-auto">
            {call.output}
          </pre>
        </div>
      )}
    </div>
  )
}

// Build the native `title` tooltip for a tool-call chip. In name-
// only mode it stays short ("Tool call succeeded: tool_name"). In
// full-detail mode the tooltip expands to include the full args
// JSON and tool output, so the writer can quickly peek at what
// ran without clicking through to expand — clicking still opens
// the persistent inline panel for longer inspection.
function _composeChipTitle(call, status, toolName, allowExpand) {
  const verb = status === 'failure'
    ? 'failed'
    : status === 'success'
      ? 'succeeded'
      : 'in progress'
  const head = `Tool call ${verb}: ${toolName}`
  if (!allowExpand) {
    if (status === 'failure' && call.error_reason) {
      return `${head} — ${call.error_reason}`
    }
    return head
  }
  // Full-detail mode — append args + output / error so a quick
  // hover reveals everything without needing to click.
  const lines = [head]
  if (call.error_reason) {
    lines.push('', `Failure reason: ${call.error_reason}`)
  }
  if (call.arguments) {
    lines.push('', 'Arguments:', safeStringify(call.arguments))
  }
  if (call.output != null) {
    const out = String(call.output)
    const truncated = out.length > 800 ? `${out.slice(0, 800)}…` : out
    lines.push('', 'Output:', truncated)
  }
  return lines.join('\n')
}

// Inline `-webkit-line-clamp` style so wrapped chip content gets
// truncated to at most N lines with a trailing ellipsis. Used by
// the latest-call chip and the earlier-calls dropdown rows so the
// tool name + args preview can occupy up to two lines without
// ever overflowing into a third. Living in inline style (rather
// than a Tailwind class) keeps the property set compact and
// avoids depending on `@tailwindcss/line-clamp` being installed.
function _clampStyle(maxLines) {
  return {
    display: '-webkit-box',
    WebkitLineClamp: maxLines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  }
}

function _toneFor(status) {
  if (status === 'success') return 'border-emerald-700/60 bg-emerald-900/30 text-emerald-200'
  if (status === 'failure') return 'border-red-700/60 bg-red-900/30 text-red-200'
  return 'border-amber-700/60 bg-amber-900/20 text-amber-200 animate-pulse'
}

function _rowToneFor(status) {
  // Tone used inside the earlier-calls dropdown rows. Less saturated
  // than the standalone chip background since the dropdown itself is
  // dark; we just paint the foreground.
  if (status === 'success') return 'text-emerald-200'
  if (status === 'failure') return 'text-red-200'
  return 'text-amber-200'
}

function _glyphFor(status) {
  if (status === 'success') return '✓'
  if (status === 'failure') return '✗'
  return '⟳'
}

function _worstStatus(calls) {
  if (calls.some((c) => (c.status || 'running') === 'failure')) return 'failure'
  if (calls.some((c) => (c.status || 'running') === 'running')) return 'running'
  return 'success'
}

// Pick a short, human-readable description of what the tool was
// called with, so the chip surfaces "what command did it do" not
// just "a tool ran". Returns null when there's nothing useful to
// show (no args yet, or every value is empty). The output is
// truncated by the surrounding span's `truncate` class — we just
// keep the payload compact rather than capping characters here.
//
// Identity-bearing keys (name, title, id, type, ...) are surfaced
// first regardless of the order the model emitted them in.
// Long-form prose fields (description, main_content, purpose, ...)
// are pushed to the tail so the chip reads "create_entity · name:
// Alice" instead of "create_entity · description: A weary traveller…".
// Object key order is insertion order in JS, and the model frequently
// lists description before name in tool-call JSON; this reorder is a
// presentation-only sort so the chip surfaces identity first.
const _IDENTITY_KEYS = ['name', 'title', 'id', 'type', 'kind', 'entity_id', 'scene_id', 'thread_id', 'key', 'category', 'category_id', 'role']
const _LONG_FORM_KEYS = ['description', 'main_content', 'content', 'body', 'text', 'prompt', 'purpose', 'notes', 'summary']

function _argKeyRank(k) {
  const i = _IDENTITY_KEYS.indexOf(k)
  if (i >= 0) return i
  const j = _LONG_FORM_KEYS.indexOf(k)
  if (j >= 0) return 1000 + j
  // Anything else sits between identity and long-form so it still
  // beats a description-only chip but doesn't push out name/title.
  return 500
}

function _summarizeArguments(args) {
  if (!args || typeof args !== 'object') return null
  const entries = Object.entries(args).filter(([, v]) => v != null && v !== '')
  if (entries.length === 0) return null
  entries.sort(([a], [b]) => _argKeyRank(a) - _argKeyRank(b))
  // Single-arg case is by far the most common; render bare so it
  // reads as "tool_name · the-value" rather than "tool · key=value".
  if (entries.length === 1) {
    const [k, v] = entries[0]
    return `${k}: ${_formatArgValue(v)}`
  }
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${_formatArgValue(v)}`)
    .join(', ')
    + (entries.length > 2 ? `, +${entries.length - 2}` : '')
}

function _formatArgValue(v) {
  if (typeof v === 'string') {
    return v.length > 60 ? `${v.slice(0, 57)}…` : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return '{…}'
  return String(v)
}

function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// ── Helpers ──────────────────────────────────────────────────

// Cheap detection for whether a string contains anything the markdown
// renderer would treat differently from raw text. Used to suppress
// the MD/Raw toggle when flipping it would be a no-op (plain prose
// with no syntax). The intent is "is there at least one thing here
// that would render differently between Markdown and Raw?" — false
// positives cost a redundant button; false negatives hide the
// toggle on content the writer might want to flip. Tuned toward
// false-positive over false-negative.
export function hasMarkdownSyntax(s) {
  if (!s) return false
  // Fenced code blocks
  if (/```/.test(s)) return true
  // Inline code
  if (/`[^`\n]+`/.test(s)) return true
  // ATX headings
  if (/^#{1,6} /m.test(s)) return true
  // Bullet lists
  if (/^[ \t]*[-*+] /m.test(s)) return true
  // Numbered lists
  if (/^[ \t]*\d+\. /m.test(s)) return true
  // Bold / strong
  if (/\*\*[^*\n]+\*\*/.test(s)) return true
  if (/__[^_\n]+__/.test(s)) return true
  // Italic / emphasis (single-token forms)
  if (/(^|[\s(])\*[^*\n]+\*(?=[\s).,!?:;]|$)/.test(s)) return true
  if (/(^|[\s(])_[^_\n]+_(?=[\s).,!?:;]|$)/.test(s)) return true
  // Strikethrough (GFM)
  if (/~~[^~\n]+~~/.test(s)) return true
  // Inline links and images
  if (/!?\[[^\]\n]*\]\([^)\n]+\)/.test(s)) return true
  // Blockquote
  if (/^> /m.test(s)) return true
  // Horizontal rule
  if (/^(?:---+|\*\*\*+|___+)\s*$/m.test(s)) return true
  // GFM table (a row with at least two pipes, plus a separator row
  // somewhere — the separator is what react-markdown actually keys
  // on, so check for it explicitly)
  if (/^\s*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?\s*$/m.test(s)) return true
  // GFM task list
  if (/^[ \t]*[-*+] \[[ xX]\] /m.test(s)) return true
  return false
}

function withAlpha(hex, alpha) {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Format an ISO timestamp for chat-bubble display. Behaviour:
//   - If the message was sent TODAY → time only, "HH:MM".
//   - Otherwise → "YYYY-MM-DD HH:MM" so the writer can tell at a
//     glance how stale a message is when scrolling through long
//     threads spanning multiple days.
// Returns empty string on parse failure rather than throwing.
function formatTimestamp(iso) {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const now = new Date()
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate()
    if (sameDay) return `${hh}:${mm}`
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day} ${hh}:${mm}`
  } catch {
    return ''
  }
}


// ── Inline-positioned image rendering (Phase 2.5f) ────────────
//
// Multimodal models like Gemini 2.5 Flash Image emit a literal
// `<image>` text marker in their response content to signal "an
// image was placed at this position in the text flow". This helper
// splits the assistant's content at those markers and pairs each
// marker with one image attachment in order. Text between markers
// renders as normal markdown/raw blocks; images render inline as
// `<InlineImage>` thumbnails at their marker positions.
//
// Marker pattern: `<image>` case-insensitively. Standalone token —
// not preceded by `<` (so HTML-like input like `<images>` doesn't
// accidentally match), but we keep this loose for now since the
// model rarely emits adversarial content. Easy to tighten the regex
// later.
//
// Match counts:
//   - markers == images: every marker consumes one image, no overflow
//   - markers <  images: first N images go inline, rest go to overflow
//   - markers >  images: extra markers become empty (filtered out)
//
// Returns `{segments, overflow}`. `segments` is an array of
// `{type:'text', content}` and `{type:'image', attachment}` entries
// in render order. `overflow` is the list of image attachments not
// placed inline (rendered below via the AttachmentStrip fallback).
const _IMAGE_MARKER_RE = /<image\s*\/?>/gi

function _splitContentByImageMarkers(content, imageAttachments) {
  const text = typeof content === 'string' ? content : ''
  const images = Array.isArray(imageAttachments) ? imageAttachments : []
  // No content OR no images → degenerate fast path: render content
  // as a single text segment, all images overflow to the strip.
  if (!text || images.length === 0) {
    return { segments: [{ type: 'text', content: text }], overflow: images }
  }
  // Find every `<image>` marker position in the text.
  const matches = []
  let m
  _IMAGE_MARKER_RE.lastIndex = 0
  while ((m = _IMAGE_MARKER_RE.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length })
  }
  // No markers found → degenerate path. Content renders as one
  // text segment; all images appended via overflow strip below.
  if (matches.length === 0) {
    return { segments: [{ type: 'text', content: text }], overflow: images }
  }
  // Walk through matches, slicing text segments + injecting image
  // segments. Markers beyond the available image count are stripped
  // (they'd render as empty placeholders otherwise).
  const segments = []
  let cursor = 0
  let imageIdx = 0
  for (const match of matches) {
    // Text before this marker.
    if (match.start > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, match.start) })
    }
    // Image attachment paired with this marker (if available).
    if (imageIdx < images.length) {
      segments.push({ type: 'image', attachment: images[imageIdx] })
      imageIdx += 1
    }
    // If no image is available for this marker, the marker is
    // silently dropped — better than rendering `<image>` literal
    // text that the writer didn't intend.
    cursor = match.end
  }
  // Trailing text after the last marker.
  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) })
  }
  // Trim leading/trailing whitespace-only text segments and
  // collapse mid-string whitespace runs that arose from `\n<image>\n`
  // patterns — the marker carried its own surrounding newlines from
  // the model, which would otherwise look like extra blank space
  // around the inline image.
  const cleaned = segments.map((seg) => (
    seg.type === 'text'
      ? { type: 'text', content: seg.content.replace(/^\s+|\s+$/g, '') }
      : seg
  )).filter((seg) => seg.type !== 'text' || seg.content.length > 0)
  return {
    segments: cleaned,
    overflow: images.slice(imageIdx),
  }
}


// Phase 2.5g follow-up — tiny inline strip overlaid at the bottom
// of an image thumbnail when the currently-active chat model
// doesn't accept image input. The image stays visible in the
// bubble so the writer can still see what was shared, but this
// stripe tells them the model isn't going to see it on the next
// send. Used by `InlineImage` and the `AttachmentStrip` image
// branch.
function HiddenFromModelStripe() {
  return (
    <div
      className="absolute bottom-0 left-0 right-0 px-1.5 py-[2px] text-[9px] uppercase tracking-wider font-medium text-amber-100 bg-amber-900/85 border-t border-amber-700/70 flex items-center gap-1 pointer-events-none"
      title="The currently selected model does not have vision support, so this image won't be included in the next request. The image stays in your chat history; switching back to a vision-capable model restores it on the wire."
    >
      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        {/* eye-off icon */}
        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.79 19.79 0 0 1 4.22-5.53" />
        <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.65 19.65 0 0 1-3.17 4.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      </svg>
      <span>Selected model does not have vision support</span>
    </div>
  )
}


// One inline image rendered between text segments in an assistant
// bubble. Same click-to-preview + hover-download affordances as
// the bottom-strip thumbnails, just positioned in the text flow.
// Wrapped in a block-level container so the surrounding text segments
// don't try to flow around it (chat bubbles are narrow; floats here
// would do more harm than good).
function InlineImage({ attachment: a, accent, sessionKey, hiddenFromModel = false }) {
  const togglePreview = usePreviewStore((s) => s.togglePreview)
  // Phase 2.5g — apply-as-avatar affordance. The hook resolves
  // what's currently open in the left-sidebar Detail Panel and
  // returns a stable `applyImageDataUrl(dataUrl)` closure. Button
  // hides itself when there's no valid target.
  const { canApply, targetLabel, applyImageDataUrl } = useApplyImageToOpenTarget()
  if (!a || !a.data_url) return null
  return (
    <div className="py-1.5 flex justify-start">
      <div
        className="group/imgthumb relative rounded border overflow-hidden"
        style={{ borderColor: accent || '#7c3aed' }}
      >
        <button
          type="button"
          onClick={() => togglePreview({
            type: 'chat_attachment',
            sessionId: sessionKey,
            url: a.data_url,
            kind: 'image',
            title: a.name,
            size: a.size,
            colour: accent,
          })}
          title={`${a.name || 'generated image'}${a.size ? ` · ${_formatBytes(a.size)}` : ''}. Click to preview.${hiddenFromModel ? ' The currently selected model does not have vision support, so this image won\'t be sent in the next request.' : ''}`}
          className="block hover:opacity-90 transition-opacity"
        >
          <img
            src={a.data_url}
            alt={a.name || 'generated image'}
            className="block max-h-64 max-w-[280px] object-contain"
            draggable
            onDragStart={makeProfileImageDragStart(a.data_url)}
          />
        </button>
        {hiddenFromModel && <HiddenFromModelStripe />}
        <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover/imgthumb:opacity-100 transition-opacity">
          {canApply && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                applyImageDataUrl(a.data_url)
              }}
              title={targetLabel}
              aria-label={targetLabel}
              className="w-6 h-6 flex items-center justify-center rounded bg-zinc-900/40 text-zinc-100 border border-zinc-700/60 transition-colors hover:bg-zinc-900/70 hover:text-[var(--nn-accent)]"
              style={{ '--nn-accent': accent || '#7c3aed' }}
            >
              {/* arrow-left: applies image into the sidebar to the left */}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
            </button>
          )}
          <a
            href={a.data_url}
            download={a.name || 'image'}
            onClick={(e) => e.stopPropagation()}
            title={`Download ${a.name || 'image'}`}
            aria-label={`Download ${a.name || 'image'}`}
            className="w-6 h-6 flex items-center justify-center rounded bg-zinc-900/40 text-zinc-100 border border-zinc-700/60 transition-colors hover:bg-zinc-900/70 hover:text-[var(--nn-accent)]"
            style={{ '--nn-accent': accent || '#7c3aed' }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}
