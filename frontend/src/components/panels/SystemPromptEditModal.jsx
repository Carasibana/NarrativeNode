import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { confirm } from '../../store/dialogStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { MarkdownBody } from '../chat/MessageBubble'
import PlaceholderPillEditor from '../ui/PlaceholderPillEditor'
import DynamicPillChip from '../ui/DynamicPillChip'
import { CueLabelChip } from '../ui/IdentityBadges'
import { AddContextPickerPopover, SceneContextIcon } from '../chat/ConversationView'
import { SimpleTogglePill, ContextPill } from '../ui/PromptBlockForm'
import { DEFAULT_N_WORDS, markerKey } from '../../utils/dynamicMarkers'
import { describeMarker } from '../../utils/markerResolver'

/**
 * SystemPromptEditModal — Phase 2.10a item 4 (planning doc §4.11).
 *
 * Bespoke modal that replaces the previous inline-accordion prompt
 * editing in the Settings → System Prompts tab. Also the future
 * surface for volatile-copy edits at chat / PBH / IPB (item 15).
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [Name] [Category ▾] [MD|Raw] [✕]                        │ header
 *   ├─────────────────────────────────────────────────────────┤
 *   │ [Compose] [Preview]                                     │ tab strip
 *   ├─────────────────────────────────────────────────────────┤
 *   │ System prompt text                                      │
 *   │ [ text body ]                                           │
 *   │                                                         │ Compose tab
 *   │ Pre-Configured Message History                          │
 *   │ [ User message ▼ ] [ body ] [×]                         │
 *   │ [ Response     ▼ ] [ body ] [×]                         │
 *   │ [+ Add message]                                         │
 *   ├─────────────────────────────────────────────────────────┤
 *   │              [Save] [Cancel] [Delete]                   │ footer (saved-prompt mode)
 *   │ [Apply to this chat] [Save changes to base prompt]      │ footer (volatile-copy mode)
 *   └─────────────────────────────────────────────────────────┘
 *
 * MD / Raw toggle behaviour (modal-level, applies to every
 * `<MarkdownTextField>` in the modal body):
 *   - Not editing + toggle is MD  → rendered markdown
 *   - Not editing + toggle is Raw → raw text
 *   - Editing (textarea focused)  → always raw textarea
 *   - On blur                     → revert to the toggle's current value
 *
 * Pre-Configured Message History (planning doc §4.5):
 *   - Optional sequence of mock User / Response turns prepended to
 *     the wire payload at chat-send time. The LLM sees them as
 *     legitimate prior chat history; they seed tone / style / format.
 *   - Each row: role toggle (User message / Response) + body
 *     `MarkdownTextField` + delete button.
 *   - "+ Add message" pushes a new row defaulting to the opposite
 *     role of the last entry (so the writer doesn't have to flip the
 *     role manually on every other add).
 *   - Send-time payload assembly (the wiring that actually injects
 *     these into outgoing requests) ships in item 12. Until then the
 *     messages are saved to disk but inert at runtime.
 *
 * Props:
 *   - mode: 'create' | 'edit' | 'volatile'
 *   - prompt: SystemPrompt | null    (null in create mode)
 *   - categories: CategoryEntry[]    (for the header dropdown)
 *   - onSave: (promptDraft) => Promise<void>
 *   - onDelete: (id) => Promise<void>
 *   - onApplyToChat: (promptDraft) => void
 *   - onSaveBackToBase: (promptDraft) => Promise<void>
 *   - onMove: (promptId, targetCategory) => Promise<void>   // Phase 2.10a item 5
 *   - onClose: () => void
 */
export default function SystemPromptEditModal({
  mode = 'edit',
  prompt = null,
  categories = [],
  // Phase 3.11a — NC paste-in path may seed the draft with new
  // Context Cues that don't exist on disk yet. Each entry is
  // `{id, name, body}`; their UUIDs are already pinned into
  // `prompt.static_cue_ids`. They show up in the Additional
  // Context section as draft chips and get POSTed before the
  // prompt itself when the writer hits Create.
  stagedCues = [],
  onSave,
  onDelete,
  onApplyToChat,
  onSaveBackToBase,
  onMove,
  onClose,
}) {
  const isCreate = mode === 'create'
  const isVolatile = mode === 'volatile'

  const [draftName, setDraftName] = useState(prompt?.name || (isCreate ? 'New system prompt' : ''))
  const [draftPrompt, setDraftPrompt] = useState(prompt?.prompt || '')
  const [draftMessages, setDraftMessages] = useState(
    Array.isArray(prompt?.mock_messages) ? prompt.mock_messages.map((m) => ({ ...m })) : []
  )
  // Phase 2.10b item 8 — context_markers + surface_defaults draft slots.
  const [draftContextMarkers, setDraftContextMarkers] = useState(
    Array.isArray(prompt?.context_markers) ? prompt.context_markers.map((m) => ({ ...m })) : []
  )
  const [draftSurfaceDefaults, setDraftSurfaceDefaults] = useState(
    prompt?.surface_defaults ? { ...prompt.surface_defaults } : null
  )
  // Phase 2.10 Bug 6 — static cue attachments. Cues are program-level
  // static references (live in `context_cues/` at program root). They
  // attach as static cue pill ids, NOT as dynamic markers.
  const [draftStaticCueIds, setDraftStaticCueIds] = useState(
    Array.isArray(prompt?.static_cue_ids) ? [...prompt.static_cue_ids] : []
  )
  // Phase 3.11a — Staged-cue drafts (from NC paste-in). Each entry
  // `{id, name, body}` is parked in modal state until the writer
  // confirms by hitting Create; at that point we POST every staged
  // cue to /api/ai-context-cues BEFORE the prompt itself. If the
  // writer cancels, nothing gets persisted. Removing a staged cue
  // chip in the Additional Context section drops both the staged
  // draft AND its id from `draftStaticCueIds`.
  const [draftStagedCues, setDraftStagedCues] = useState(
    Array.isArray(stagedCues) ? stagedCues.map((c) => ({ ...c })) : []
  )
  // Per-message collapse state, keyed by message id. Loaded messages
  // start COLLAPSED so the writer sees the structure at a glance;
  // freshly-added messages (via "+ Add message") start expanded so the
  // writer can begin typing immediately.
  const [collapsedMessageIds, setCollapsedMessageIds] = useState(
    () => new Set((prompt?.mock_messages || []).map((m) => m.id))
  )
  // Per-message render-mode overrides, keyed by message id. The
  // modal-level toggle (`renderMode`) is the default for any message
  // without an entry here. Per-message override comes from the chat-
  // panel pattern — each row can flip MD/Raw locally. Clicking the
  // modal-level toggle clears this map (so every message snaps to
  // the new global value).
  const [messageRenderModes, setMessageRenderModes] = useState(() => new Map())
  // Live category state in edit mode — changing it calls `onMove`
  // immediately (move is a filesystem operation, not a draft change).
  // Create mode stays display-only until the prompt actually exists.
  const [draftCategory, setDraftCategory] = useState(prompt?.category || null)
  useEffect(() => { setDraftCategory(prompt?.category || null) }, [prompt])
  const [moving, setMoving] = useState(false)
  // Phase 2.11a item 2 — Persona flag local state. Draft-only: the
  // toggle updates local state; the flag ships to disk via the
  // regular save flow (`buildDraft()` carries `is_persona` into the
  // PUT/POST payload). Mirrors the name / body / mock_messages
  // draft pattern, NOT the category-move immediate-write pattern.
  const [draftIsPersona, setDraftIsPersona] = useState(!!prompt?.is_persona)
  useEffect(() => { setDraftIsPersona(!!prompt?.is_persona) }, [prompt])
  function handlePersonaToggle() {
    setDraftIsPersona((v) => !v)
  }
  // Phase 2.11a item 5 — fetch the current effective Persona Preamble
  // so the Compose tab can show a read-only preview above the prompt
  // body when `is_persona: true`. Backend caches the value so this is
  // effectively free per modal open.
  const [personaPreamble, setPersonaPreamble] = useState('')
  // Genuine no-character fallback — the literal string the assembly
  // pipeline emits inside the `<character_context>` tags when no
  // character is selected. Fetched alongside the preamble so the
  // Preview tab shows the actual text the AI would receive in this
  // state, not preview-only fake text.
  const [characterContextFallback, setCharacterContextFallback] = useState('')
  useEffect(() => {
    let cancelled = false
    axios.get('/api/persona-preamble').then((r) => {
      if (cancelled) return
      const body = typeof r?.data?.body === 'string' ? r.data.body : ''
      const fallback = typeof r?.data?.character_context_fallback_no_character === 'string'
        ? r.data.character_context_fallback_no_character
        : ''
      setPersonaPreamble(body)
      setCharacterContextFallback(fallback)
    }).catch(() => { /* swallow — block just stays empty */ })
    return () => { cancelled = true }
  }, [])
  async function handleCategoryChange(next) {
    const target = next === '' ? null : next
    if (target === draftCategory) return
    // Create mode: no prompt on disk yet, so just update the local
    // draft. `handleModalSave` in the parent follows up with a move
    // call after the POST when the chosen category is non-null.
    if (isCreate || !prompt?.id) {
      setDraftCategory(target)
      return
    }
    // Edit mode: file already exists on disk; move immediately.
    setMoving(true)
    setSaveError(null)
    try {
      await onMove?.(prompt.id, target)
      setDraftCategory(target)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (err?.message || 'Failed to move prompt'))
    } finally {
      setMoving(false)
    }
  }
  const [activeTab, setActiveTab] = useState('compose')
  const [renderMode, setRenderMode] = useState('markdown')  // 'markdown' | 'raw'
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Reset draft when the prompt prop changes (defensive — modal
  // callers normally unmount/remount).
  useEffect(() => {
    setDraftName(prompt?.name || (isCreate ? 'New system prompt' : ''))
    setDraftPrompt(prompt?.prompt || '')
    const msgs = Array.isArray(prompt?.mock_messages) ? prompt.mock_messages.map((m) => ({ ...m })) : []
    setDraftMessages(msgs)
    setCollapsedMessageIds(new Set(msgs.map((m) => m.id)))
    setMessageRenderModes(new Map())
    setDraftContextMarkers(Array.isArray(prompt?.context_markers) ? prompt.context_markers.map((m) => ({ ...m })) : [])
    setDraftSurfaceDefaults(prompt?.surface_defaults ? { ...prompt.surface_defaults } : null)
    setDraftStaticCueIds(Array.isArray(prompt?.static_cue_ids) ? [...prompt.static_cue_ids] : [])
    setDraftStagedCues(Array.isArray(stagedCues) ? stagedCues.map((c) => ({ ...c })) : [])
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, isCreate])

  function setModalRenderMode(next) {
    setRenderMode(next)
    // Snap every message to the new global value so the writer's
    // intent ("set them all to MD/Raw") actually takes effect.
    setMessageRenderModes(new Map())
  }
  function toggleMessageRenderMode(id) {
    setMessageRenderModes((prev) => {
      const next = new Map(prev)
      const current = next.get(id) ?? renderMode
      next.set(id, current === 'markdown' ? 'raw' : 'markdown')
      return next
    })
  }
  function toggleMessageCollapse(id) {
    setCollapsedMessageIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isDirty = useMemo(() => {
    if (isCreate) {
      return Boolean(draftName.trim()) || Boolean(draftPrompt.trim()) || draftMessages.length > 0
        || draftContextMarkers.length > 0 || draftSurfaceDefaults != null
        || draftStaticCueIds.length > 0 || draftIsPersona
    }
    if ((draftName || '') !== (prompt?.name || '')) return true
    if ((draftPrompt || '') !== (prompt?.prompt || '')) return true
    const baseMsgs = prompt?.mock_messages || []
    if (JSON.stringify(baseMsgs) !== JSON.stringify(draftMessages)) return true
    // Phase 2.10b item 8 — context_markers + surface_defaults dirty
    // tracking. JSON-equality good enough — both shapes are flat dicts.
    const baseMarkers = prompt?.context_markers || []
    if (JSON.stringify(baseMarkers) !== JSON.stringify(draftContextMarkers)) return true
    const baseDefs = prompt?.surface_defaults || null
    if (JSON.stringify(baseDefs) !== JSON.stringify(draftSurfaceDefaults)) return true
    const baseCueIds = prompt?.static_cue_ids || []
    if (JSON.stringify(baseCueIds) !== JSON.stringify(draftStaticCueIds)) return true
    if (draftIsPersona !== !!prompt?.is_persona) return true
    return false
  }, [draftName, draftPrompt, draftMessages, draftContextMarkers, draftSurfaceDefaults, draftStaticCueIds, draftIsPersona, prompt, isCreate])

  async function attemptClose() {
    if (!isDirty) { onClose?.(); return }
    const ok = await confirm({
      title: 'Discard changes?',
      message: 'You have unsaved changes. Close without saving?',
      buttons: [
        { label: 'Keep editing', value: false, style: 'neutral' },
        { label: 'Discard',      value: true,  style: 'danger' },
      ],
    })
    if (ok) onClose?.()
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        attemptClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, draftName, draftPrompt, draftMessages])

  function buildDraft() {
    const trimmedName = draftName.trim() || 'Untitled system prompt'
    return {
      ...(prompt || {}),
      id: prompt?.id || newId(),
      name: trimmedName,
      prompt: draftPrompt,
      shipped: prompt?.shipped || false,
      mock_messages: draftMessages,
      // Phase 2.10b item 8 — context_markers + surface_defaults travel
      // with the saved prompt. Empty list + null are the legacy /
      // no-opinion default shapes per item 7's Pydantic model.
      context_markers: draftContextMarkers,
      surface_defaults: draftSurfaceDefaults,
      // Phase 2.10 Bug 6 — static cue attachments.
      static_cue_ids: draftStaticCueIds,
      category: draftCategory || null,
      is_persona: draftIsPersona,
    }
  }

  async function handleSave() {
    setSaveError(null)
    setSaving(true)
    try {
      // Phase 3.11a — when the modal carries staged Context Cue
      // drafts (NC paste-in path), POST every staged cue to disk
      // BEFORE the prompt itself. If any cue POST fails, abort and
      // surface the error; nothing partial gets persisted because
      // the prompt POST never fires. Reusing-existing-cue ids that
      // came in via `prompt.static_cue_ids` aren't part of this
      // list — they already exist on disk.
      if (isCreate && draftStagedCues.length > 0) {
        const created = []
        for (const cue of draftStagedCues) {
          try {
            await axios.post('/api/ai-context-cues', {
              id: cue.id,
              name: cue.name,
              body: cue.body || '',
              tags: [],
              pinned: false,
              colour: null,
            })
            created.push(cue.id)
          } catch (cueErr) {
            // Best-effort rollback: try to delete any cues we
            // already created in this batch so the writer can
            // retry from a clean state. Failures here are silent.
            for (const id of created) {
              try { await axios.delete(`/api/ai-context-cues/${id}`) } catch { /* swallow */ }
            }
            const detail = cueErr?.response?.data?.detail
            const cueMsg = typeof detail === 'string' ? detail : (cueErr?.message || 'unknown error')
            throw new Error(`Couldn't create Context Cue "${cue.name}": ${cueMsg}`)
          }
        }
        // Refresh the in-memory cue library so the new cues appear
        // in subsequent picker popovers without a manual reload.
        try { await useContextCuesStore.getState().reloadCues?.() } catch { /* non-fatal */ }
      }
      await onSave?.(buildDraft())
      onClose?.()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (err?.message || 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!prompt?.id) return
    const ok = await confirm({
      title: 'Delete system prompt',
      message: `Delete "${prompt.name || 'this system prompt'}"? This can't be undone.`,
      buttons: [
        { label: 'Cancel', value: false, style: 'neutral' },
        { label: 'Delete', value: true,  style: 'danger' },
      ],
    })
    if (!ok) return
    setSaveError(null)
    setSaving(true)
    try {
      await onDelete?.(prompt.id)
      onClose?.()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (err?.message || 'Failed to delete'))
    } finally {
      setSaving(false)
    }
  }

  function handleApplyToChat() {
    onApplyToChat?.(buildDraft())
    onClose?.()
  }

  async function handleSaveBackToBase() {
    setSaveError(null)
    setSaving(true)
    try {
      await onSaveBackToBase?.(buildDraft())
      onClose?.()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (err?.message || 'Failed to save back to base'))
    } finally {
      setSaving(false)
    }
  }

  // ── Pre-Configured Message History mutations ──────────────────

  function addMessage() {
    // Default to the opposite role of the last entry so adding several
    // in a row alternates naturally. First entry defaults to 'user'.
    const lastRole = draftMessages.length > 0 ? draftMessages[draftMessages.length - 1].role : 'assistant'
    const nextRole = lastRole === 'user' ? 'assistant' : 'user'
    setDraftMessages((ms) => [...ms, { id: newId(), role: nextRole, body: '' }])
  }
  function updateMessage(idx, patch) {
    setDraftMessages((ms) => ms.map((m, i) => (i === idx ? { ...m, ...patch } : m)))
  }
  function removeMessage(idx) {
    setDraftMessages((ms) => ms.filter((_, i) => i !== idx))
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={attemptClose}
    >
      <div
        data-help-region="system-prompt-edit:modal"
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl w-[92vw] max-w-[860px] h-[86vh] max-h-[920px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* ── Header ─────────────────────────────────────── */}
        <div className="px-4 py-2.5 border-b border-zinc-700 flex items-center gap-2 flex-shrink-0">
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Prompt name"
            data-help-region="system-prompt-edit:name"
            className="flex-1 bg-zinc-800 text-sm text-zinc-100 px-2.5 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
            autoFocus
          />
          <CategoryDropdown
            value={draftCategory}
            categories={categories}
            disabled={moving}
            onChange={handleCategoryChange}
            dataHelpRegion="system-prompt-edit:category"
            title={isCreate
              ? 'Pick the category this prompt will land in on Save.'
              : moving
                ? 'Moving…'
                : 'Change the category this prompt lives in. Moves the file on disk.'}
          />
          <button
            type="button"
            onClick={handlePersonaToggle}
            aria-pressed={draftIsPersona}
            data-help-region="system-prompt-edit:persona_toggle"
            title={draftIsPersona
              ? 'Persona prompt: eligible for use as a voice template for Character Chat. Click to remove the Persona flag (Save to commit).'
              : 'Not a Persona prompt. Click to flag this as a Persona so it can be used as a voice template for Character Chat (Save to commit).'}
            className={`flex-shrink-0 text-[10px] px-2 py-1 rounded border transition-colors ${
              draftIsPersona
                ? 'bg-accent-900/40 border-accent-600/60 text-accent-100 hover:bg-accent-900/60'
                : 'bg-zinc-800 border-zinc-600 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            🎭 Persona
          </button>
          <button
            type="button"
            onClick={() => setModalRenderMode(renderMode === 'markdown' ? 'raw' : 'markdown')}
            data-help-region="system-prompt-edit:render_mode"
            title={renderMode === 'markdown'
              ? 'Showing rendered markdown across the modal. Click to flip everything to raw text. Per-message buttons override locally.'
              : 'Showing raw text across the modal. Click to flip everything to rendered markdown. Per-message buttons override locally.'}
            aria-pressed={renderMode === 'markdown'}
            className="text-[10px] px-2 py-1 rounded border border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200 transition-colors flex-shrink-0 min-w-[34px]"
          >
            {renderMode === 'markdown' ? 'MD' : 'Raw'}
          </button>
          {prompt?.shipped && (
            <span
              className="text-[10px] text-sky-300 border border-sky-700/60 rounded px-1.5 py-0.5 flex-shrink-0"
              title="Shipped with NarrativeNode."
            >shipped</span>
          )}
          {isVolatile && (
            <span
              className="text-[10px] text-amber-300 border border-amber-700/60 rounded px-1.5 py-0.5 flex-shrink-0"
              title="Volatile copy — changes don't save back to the source prompt unless you explicitly save."
            >volatile copy</span>
          )}
          <button
            type="button"
            onClick={attemptClose}
            aria-label="Close"
            data-help-region="system-prompt-edit:close"
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-7 h-7 flex items-center justify-center flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
        </div>

        {/* Volatile-mode banner */}
        {isVolatile && (
          <div className="px-4 py-2 bg-amber-950/30 border-b border-amber-900/40 text-[11px] text-amber-200/90">
            Volatile copy — changes don&apos;t save back to the source prompt unless you explicitly save.
          </div>
        )}

        {/* ── Tab strip ──────────────────────────────────── */}
        <div data-help-region="system-prompt-edit:tab_strip" className="px-4 pt-2 border-b border-zinc-700 flex items-end gap-1 flex-shrink-0">
          <TabButton label="Compose" active={activeTab === 'compose'} onClick={() => setActiveTab('compose')} />
          <TabButton label="Preview" active={activeTab === 'preview'} onClick={() => setActiveTab('preview')} />
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {activeTab === 'compose' && (
            <ComposeTab
              draftPrompt={draftPrompt}
              setDraftPrompt={setDraftPrompt}
              messages={draftMessages}
              onAddMessage={addMessage}
              onUpdateMessage={updateMessage}
              onRemoveMessage={removeMessage}
              renderMode={renderMode}
              messageRenderModes={messageRenderModes}
              onToggleMessageRenderMode={toggleMessageRenderMode}
              collapsedMessageIds={collapsedMessageIds}
              onToggleMessageCollapse={toggleMessageCollapse}
              draftContextMarkers={draftContextMarkers}
              setDraftContextMarkers={setDraftContextMarkers}
              draftSurfaceDefaults={draftSurfaceDefaults}
              setDraftSurfaceDefaults={setDraftSurfaceDefaults}
              draftStaticCueIds={draftStaticCueIds}
              setDraftStaticCueIds={setDraftStaticCueIds}
              draftStagedCues={draftStagedCues}
              setDraftStagedCues={setDraftStagedCues}
              isPersona={draftIsPersona}
              personaPreamble={personaPreamble}
              onOpenPreambleEditor={onClose}
            />
          )}
          {activeTab === 'preview' && (
            <PreviewTab
              draftPrompt={draftPrompt}
              draftMessages={draftMessages}
              renderMode={renderMode}
              isPersona={draftIsPersona}
              personaPreamble={personaPreamble}
              characterContextFallback={characterContextFallback}
            />
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────── */}
        <div data-help-region="system-prompt-edit:footer" className="px-4 py-2.5 border-t border-zinc-700 flex items-center gap-2 flex-shrink-0">
          {saveError && (
            <span className="text-[11px] text-red-300 mr-2 truncate" title={saveError}>{saveError}</span>
          )}
          <div className="flex-1" />
          {isVolatile ? (
            <>
              <button
                type="button"
                onClick={attemptClose}
                disabled={saving}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100 rounded border border-zinc-600 transition-colors"
              >Cancel</button>
              <button
                type="button"
                onClick={handleSaveBackToBase}
                disabled={saving || !isDirty}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100 rounded border border-zinc-600 transition-colors"
              >Save changes to base prompt</button>
              <button
                type="button"
                onClick={handleApplyToChat}
                disabled={saving}
                className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 disabled:opacity-50 text-white rounded transition-colors"
              >Apply to this chat</button>
            </>
          ) : (
            <>
              {!isCreate && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-900/60 disabled:opacity-50 text-red-200 rounded border border-red-800/60 transition-colors"
                >Delete</button>
              )}
              <button
                type="button"
                onClick={attemptClose}
                disabled={saving}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100 rounded border border-zinc-600 transition-colors"
              >Cancel</button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || (!isCreate && !isDirty)}
                title={(() => {
                  if (!isCreate) return draftName.trim() ? `Save changes to "${draftName.trim()}"` : 'Save changes'
                  const promptLabel = draftName.trim() || 'Untitled system prompt'
                  if (draftStagedCues.length === 0) return `Create system prompt "${promptLabel}"`
                  const cueList = draftStagedCues.map((c) => `"${c.name}"`).join(', ')
                  const cueNoun = draftStagedCues.length === 1 ? 'Context Cue' : 'Context Cues'
                  return `Create system prompt "${promptLabel}" and ${draftStagedCues.length} new ${cueNoun}: ${cueList}`
                })()}
                className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 disabled:opacity-50 text-white rounded transition-colors"
              >{saving
                  ? 'Saving…'
                  : isCreate
                    ? (draftStagedCues.length === 0
                        ? 'Create'
                        : `Create Prompt + ${draftStagedCues.length} Context Cue${draftStagedCues.length === 1 ? '' : 's'}`)
                    : 'Save'}</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Tabs ──────────────────────────────────────────────────────

function TabButton({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs rounded-t border-b-2 transition-colors ${
        active
          ? 'border-accent-500 text-zinc-100 bg-zinc-800/40'
          : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/30'
      }`}
    >
      {label}
    </button>
  )
}

function ComposeTab({
  draftPrompt,
  setDraftPrompt,
  messages,
  onAddMessage,
  onUpdateMessage,
  onRemoveMessage,
  renderMode,
  messageRenderModes,
  onToggleMessageRenderMode,
  collapsedMessageIds,
  onToggleMessageCollapse,
  draftContextMarkers,
  setDraftContextMarkers,
  draftSurfaceDefaults,
  setDraftSurfaceDefaults,
  draftStaticCueIds,
  setDraftStaticCueIds,
  draftStagedCues,
  setDraftStagedCues,
  isPersona,
  personaPreamble,
  onOpenPreambleEditor,
}) {
  return (
    <div className="space-y-4">
      {/* Phase 2.11a item 5 — Persona Preamble preview. Rendered ONLY
          when the prompt being edited has `is_persona: true`. Shows
          the current global preamble (with `{{character_name}}` pills)
          as a dimmed, read-only block ABOVE the editable prompt body
          so the writer sees what gets prepended at send time without
          being able to edit it from here. The "Edit in Settings ↗"
          link closes the modal — the Persona Preamble editor lives
          at the bottom of the same Settings → System Prompts tab. */}
      {isPersona && (
        <section data-help-region="system-prompt-edit:persona_preamble_preview" className="rounded border border-accent-700/40 bg-zinc-900/50">
          <header className="px-2.5 py-1.5 flex items-baseline gap-2 flex-wrap border-b border-zinc-800/60">
            <span className="text-[10px] uppercase tracking-wide text-accent-300 font-semibold">🎭 Persona Preamble</span>
            <span className="text-[9px] text-zinc-500">prepended automatically at send time</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onOpenPreambleEditor}
              title="Close this editor. The Persona Preamble lives at the bottom of Settings → System Prompts."
              className="text-[10px] text-accent-300 hover:text-accent-200 underline-offset-2 hover:underline"
            >
              Edit in Settings ↗
            </button>
          </header>
          <div className="opacity-70 pointer-events-none">
            <PlaceholderPillEditor
              value={personaPreamble}
              onChange={() => { /* read-only */ }}
              disabled
              minHeight="3rem"
            />
          </div>
        </section>
      )}

      {/* System prompt body */}
      <div data-help-region="system-prompt-edit:prompt_body">
        <div className="text-[11px] text-zinc-400 mb-1">System prompt text</div>
        <MarkdownTextField
          value={draftPrompt}
          onChange={setDraftPrompt}
          renderMode={renderMode}
          placeholder="Enter your system prompt instructions here."
        />
        <p className="text-[10px] text-zinc-500 mt-1">
          Sent as the <code className="px-1 bg-zinc-800 rounded text-[10px]">system</code> role message at the start of every chat session that uses this prompt.
        </p>
      </div>

      {/* Pre-Configured Message History */}
      <div data-help-region="system-prompt-edit:message_history" className="border-t border-zinc-800 pt-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">Pre-Configured Message History</div>
            <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">
              Optional. Sent to the LLM as if the conversation had already happened — seeds tone, style, and format via apparent prior turns.
            </div>
          </div>
          <button
            type="button"
            onClick={onAddMessage}
            className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded border border-zinc-700 transition-colors flex-shrink-0"
          >
            + Add message
          </button>
        </div>

        {messages.length === 0 ? (
          <div className="rounded border border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-3 text-center text-[11px] text-zinc-500 italic">
            No messages configured.
          </div>
        ) : (
          <ul className="space-y-2">
            {messages.map((m, idx) => {
              const effectiveMode = messageRenderModes.get(m.id) ?? renderMode
              return (
                <MockMessageRow
                  key={m.id}
                  message={m}
                  onChange={(patch) => onUpdateMessage(idx, patch)}
                  onRemove={() => onRemoveMessage(idx)}
                  collapsed={collapsedMessageIds.has(m.id)}
                  onToggleCollapse={() => onToggleMessageCollapse(m.id)}
                  renderMode={effectiveMode}
                  onToggleRenderMode={() => onToggleMessageRenderMode(m.id)}
                />
              )
            })}
          </ul>
        )}
      </div>

      {/* Phase 2.10 Bug 8 — Additional Context. Replaces the bespoke
          Context Markers section with the same DynamicPillChip rendering
          + Add Context popover writers see on every surface. Author
          declares dynamic context pills (auto-attached when a writer
          picks this prompt) AND static cue attachments (program-level
          cue ids in `static_cue_ids`). Pickers feed via
          AddContextPickerPopover with hideStoryScope + hideStoryObjects
          so only Dynamic + Context Cues tabs are in scope. */}
      <AdditionalContextSection
        markers={draftContextMarkers || []}
        cueIds={draftStaticCueIds || []}
        stagedCues={draftStagedCues || []}
        onChangeMarkers={setDraftContextMarkers}
        onChangeCueIds={setDraftStaticCueIds}
        onChangeStagedCues={setDraftStagedCues}
      />

      {/* Phase 2.10b item 8 — Surface defaults (Tier 1). Tri-state per
          slot via a leading "[ ] Set this default" checkbox. Unchecked
          = slot null (no opinion; preserve surface state at select-
          time). Checked = the prompt has an explicit opinion; the row's
          ON/OFF + N controls go live. */}
      <SurfaceDefaultsSection
        defs={draftSurfaceDefaults}
        onChange={setDraftSurfaceDefaults}
      />
    </div>
  )
}

// Phase 2.10 Bug 8 — Additional Context section. Replaces the previous
// bespoke ContextMarkersSection with the same DynamicPillChip rendering
// + Add Context popover writers see on every surface. Renders both
// `draftContextMarkers` (dynamic pills) and `draftStaticCueIds` (static
// cue attachments) in a single chip row. The popover surfaces the
// Dynamic + Context Cues tabs only; its onAdd callback routes by item
// shape to the appropriate state list.
function AdditionalContextSection({ markers, cueIds, stagedCues = [], onChangeMarkers, onChangeCueIds, onChangeStagedCues }) {
  const triggerRef = useRef(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const cuesList = useContextCuesStore((s) => s.cues) || []
  const loadCues = useContextCuesStore((s) => s.loadCues)
  // Kick a load so the cue tab + chip labels have data on first open.
  useEffect(() => { loadCues?.() }, [loadCues])

  // Synthetic `pinned` array for the popover's dedup computation —
  // matches the shape the popover expects (`{ pin_kind: 'dynamic',
  // marker }` for dynamic, `{ kind: 'cue', id }` for cues).
  const pinned = useMemo(() => {
    const out = []
    for (const m of (markers || [])) out.push({ pin_kind: 'dynamic', marker: m })
    for (const id of (cueIds || [])) out.push({ kind: 'cue', id })
    return out
  }, [markers, cueIds])

  function handleAdd(item) {
    if (!item) return
    if (item.pin_kind === 'dynamic' && item.marker) {
      const key = markerKey(item.marker)
      const seen = new Set((markers || []).map((m) => markerKey(m)))
      if (!seen.has(key)) onChangeMarkers([...(markers || []), { ...item.marker }])
    } else if (item.kind === 'cue' && item.id) {
      if (!(cueIds || []).includes(item.id)) onChangeCueIds([...(cueIds || []), item.id])
    }
  }

  function removeMarker(idx) {
    onChangeMarkers((markers || []).filter((_, i) => i !== idx))
  }
  function updateMarker(idx, next) {
    onChangeMarkers((markers || []).map((m, i) => (i === idx ? next : m)))
  }
  function removeCueId(id) {
    onChangeCueIds((cueIds || []).filter((x) => x !== id))
    // Phase 3.11a — if this id matches a staged-draft cue, drop the
    // staged entry too so the writer's intent ("don't want this
    // cue") removes both the attachment AND the to-be-created cue
    // in one click. Reused-existing cue ids aren't in stagedCues,
    // so this is a no-op for them — only the attachment goes.
    if (onChangeStagedCues && (stagedCues || []).some((c) => c.id === id)) {
      onChangeStagedCues((stagedCues || []).filter((c) => c.id !== id))
    }
  }

  const isEmpty = (markers || []).length === 0 && (cueIds || []).length === 0

  return (
    <div data-help-region="system-prompt-edit:additional_context" className="border-t border-zinc-800 pt-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">Additional Context</div>
          <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">
            Optional. Dynamic context pills and static cue attachments auto-attach to the surface when a writer picks this prompt. Writers can tweak each pill afterward.
          </div>
        </div>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setPopoverOpen((v) => !v)}
          className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded border border-zinc-700 transition-colors flex-shrink-0"
        >
          + Add Context
        </button>
      </div>
      {popoverOpen && (
        <AddContextPickerPopover
          triggerRef={triggerRef}
          onClose={() => setPopoverOpen(false)}
          pinned={pinned}
          onAdd={handleAdd}
          hideStoryScope
          hideStoryObjects
        />
      )}
      {isEmpty ? (
        <div className="rounded border border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-3 text-center text-[11px] text-zinc-500 italic">
          No context attached.
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1 p-2 rounded border border-zinc-700 bg-zinc-900/30">
          {(markers || []).map((m, idx) => {
            // Author mode — no host context to resolve against. Compute
            // label from `describeMarker` with empty ctx (LABEL_FNs
            // fall through to their generic labels). Force
            // `silentSkip: false` so the chip renders as an authored
            // marker, not a dead unresolved pill. `targetKey: null`
            // means the flash hook stays inert (no real target to
            // track in author mode).
            const desc = describeMarker(m, null)
            const sessionId = `author-${idx}-${markerKey(m)}`
            return (
              <DynamicPillChip
                key={sessionId}
                marker={m}
                sessionId={sessionId}
                flashScope="author"
                targetKey={null}
                resolvedLabel={desc.label}
                silentSkip={false}
                tooltip={`Dynamic context: ${desc.label}`}
                onPreview={() => {}}
                onRemove={() => removeMarker(idx)}
                onConfigChange={(next) => updateMarker(idx, next)}
              />
            )
          })}
          {(cueIds || []).map((id) => {
            // Phase 3.11a — look up the cue first in the existing
            // library (already-on-disk cues), then in stagedCues
            // (NC paste-in drafts not yet POSTed). Staged ones get
            // a "(new)" suffix + a dashed border so the writer can
            // see at a glance which chips will create a new cue
            // when Create is hit vs. which already exist.
            const cue = cuesList.find((c) => c && c.id === id)
            const staged = !cue && (stagedCues || []).find((c) => c.id === id)
            const isStaged = !!staged
            const rawName = cue?.name || staged?.name || '(missing cue)'
            const name = isStaged ? `${rawName} (new)` : rawName
            const removeTitle = isStaged
              ? 'Remove this draft Context Cue — it will not be created.'
              : 'Remove this cue attachment'
            return (
              <span
                key={`c-${id}`}
                className={`inline-flex items-center gap-0.5${isStaged ? ' rounded border border-dashed border-accent-600/60 px-0.5' : ''}`}
                title={isStaged ? 'New Context Cue — will be created when you click Create' : undefined}
              >
                <CueLabelChip name={name} />
                <button
                  type="button"
                  onClick={() => removeCueId(id)}
                  className="w-4 h-4 flex items-center justify-center text-[10px] leading-none rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700/60"
                  title={removeTitle}
                  aria-label="Remove cue"
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Phase 2.10b item 8 — Tier 1 surface-intrinsic defaults section.
// Renders four tri-state rows (Active Scene, Section content, Before,
// After). Unchecked = slot null (no opinion); checked = the slot
// carries an explicit value the prompt writes at select-time.
// Phase 2.10 Bug 8 — Surface Defaults section. Replaces the previous
// bespoke tri-state checkbox + slot rows with the same SimpleTogglePill
// + ContextPill UI writers use on PBH / IPB surfaces. Pill states:
//   - "Off" (slot null): the prompt has no opinion about this
//     affordance; loading the prompt leaves the writer's surface state
//     alone.
//   - "On" (slot non-null): the prompt has an opinion; loading the
//     prompt sets the surface affordance to the pill's value. For
//     boolean slots, "on" means "force the affordance enabled". For
//     N-value slots (Before / After), the slot carries `{enabled: true,
//     n: <pill count>}` and the applier writes both fields.
//
// Surface applicability — pills group by where they apply. "All
// surfaces" holds defaults that take effect on every writer surface
// (chat, Section prompts, scene description). "Section Prompt" holds
// defaults that only make sense where there's a Section host (Section
// PBH + IPB). Non-applicable surfaces aren't enumerated — the
// grouping itself communicates scope.
function SurfaceDefaultsSection({ defs, onChange }) {
  const safe = defs || {}
  function setSlot(key, value) {
    const next = { ...(defs || {}) }
    next[key] = value
    // Prune null slots; if every slot is null, drop the whole
    // SurfaceDefaults to `null` so the prompt's "no opinion" state
    // matches the legacy on-disk shape.
    let allNull = true
    for (const k of ['scene_context', 'host_section_content', 'before', 'after']) {
      if (next[k] !== null && next[k] !== undefined) allNull = false
    }
    onChange(allNull ? null : next)
  }
  const sceneOn = !!safe.scene_context
  const sectionOn = !!safe.host_section_content
  const beforeOn = !!safe.before
  const afterOn = !!safe.after
  const beforeN = safe.before?.n ?? DEFAULT_N_WORDS
  const afterN = safe.after?.n ?? DEFAULT_N_WORDS
  return (
    <div data-help-region="system-prompt-edit:surface_defaults" className="border-t border-zinc-800 pt-4 space-y-2">
      <div>
        <div className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">Surface Defaults</div>
        <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">
          Optional. Click a pill to make the prompt opinionated about that surface affordance. An "on" pill forces the writer's surface to enable that affordance at prompt-pick time; an "off" pill leaves the writer's surface alone. Hover the Before / After pills for a word-count slider.
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-center gap-6 px-2 py-3 rounded border border-zinc-700 bg-zinc-900/30">
        <div className="flex flex-col items-center gap-1">
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">All surfaces</div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <SimpleTogglePill
              label={<span className="inline-flex items-center gap-1"><SceneContextIcon size={10} /> Scene context</span>}
              on={sceneOn}
              onToggle={() => setSlot('scene_context', sceneOn ? null : true)}
              title={sceneOn
                ? 'On — picking this prompt enables Scene Context on the writer\'s surface. Click to remove the prompt\'s opinion.'
                : 'Off — the prompt has no opinion about Scene Context. Click to force it on at pick-time.'}
            />
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">Section Prompt</div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <SimpleTogglePill
              label="Section content"
              on={sectionOn}
              onToggle={() => setSlot('host_section_content', sectionOn ? null : true)}
              title={sectionOn
                ? 'On — picking this prompt includes the host Section\'s content. Click to remove the prompt\'s opinion.'
                : 'Off — the prompt has no opinion about Section content. Click to force it on at pick-time.'}
            />
            <ContextPill
              label="Before"
              directionLabel="BEFORE"
              on={beforeOn}
              count={beforeN}
              onToggle={() => setSlot('before', beforeOn ? null : { enabled: true, n: beforeN })}
              onCountChange={(next) => setSlot('before', { enabled: true, n: Math.max(1, Math.min(2000, next | 0)) })}
              noPreviewSync
            />
            <ContextPill
              label="After"
              directionLabel="AFTER"
              on={afterOn}
              count={afterN}
              onToggle={() => setSlot('after', afterOn ? null : { enabled: true, n: afterN })}
              onCountChange={(next) => setSlot('after', { enabled: true, n: Math.max(1, Math.min(2000, next | 0)) })}
              noPreviewSync
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function MockMessageRow({ message, onChange, onRemove, collapsed, onToggleCollapse, renderMode, onToggleRenderMode }) {
  const isUser = message.role === 'user'
  // One-line preview for the collapsed header so the writer can still
  // tell messages apart without expanding.
  const previewLine = (message.body || '').split('\n').find((l) => l.trim()) || ''
  return (
    <li data-help-region="system-prompt-edit:message_row" className="rounded border border-zinc-700 bg-zinc-900/30">
      <div className="px-2.5 py-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand message' : 'Collapse message'}
          title={collapsed ? 'Expand message' : 'Collapse message'}
          className="text-zinc-400 hover:text-zinc-100 w-4 flex-shrink-0 text-[11px]"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          onClick={() => onChange({ role: isUser ? 'assistant' : 'user' })}
          title="Click to toggle role"
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex-shrink-0 ${
            isUser
              ? 'border-sky-700/60 bg-sky-900/30 text-sky-200 hover:bg-sky-900/50'
              : 'border-violet-700/60 bg-violet-900/30 text-violet-200 hover:bg-violet-900/50'
          }`}
        >
          {isUser ? 'User message' : 'Response'}
        </button>
        {collapsed && previewLine && (
          <span className="text-[10px] text-zinc-500 truncate italic flex-1 min-w-0">&ldquo;{previewLine}&rdquo;</span>
        )}
        {!collapsed && <div className="flex-1" />}
        <button
          type="button"
          onClick={onToggleRenderMode}
          title={renderMode === 'markdown'
            ? 'Showing rendered markdown. Click to flip this message to raw text.'
            : 'Showing raw text. Click to flip this message to rendered markdown.'}
          aria-pressed={renderMode === 'markdown'}
          className="text-[9px] px-1.5 py-px rounded border border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
        >
          {renderMode === 'markdown' ? 'MD' : 'Raw'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove message"
          title="Remove message"
          className="text-zinc-500 hover:text-red-300 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center flex-shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
      </div>
      {!collapsed && (
        <div className="px-2.5 pb-2.5">
          <MarkdownTextField
            value={message.body}
            onChange={(v) => onChange({ body: v })}
            renderMode={renderMode}
            placeholder={isUser ? 'What the user would say…' : 'How the assistant would respond…'}
          />
        </div>
      )}
    </li>
  )
}

/**
 * Preview tab — renders the current draft state in chat-bubble form:
 *   1. System prompt row.
 *      - Non-Persona prompt: the draft body, sent to the model as-is.
 *      - Persona prompt: the literal three-section assembly that gets
 *        sent at send time — Persona Preamble + `<character_context>`
 *        block + `<system_prompt>` block — composed as a single string
 *        and rendered through the same PreviewRow as the non-Persona
 *        case. RAW mode shows the literal text the AI receives;
 *        markdown mode renders it as markdown. The character context
 *        block carries a placeholder note explaining the chain-resolved
 *        content is filled in at send time (the editor has no character
 *        / anchor — that's the Character Chat Setup modal's job).
 *   2. One row per pre-configured message (alternating user / assistant).
 *   3. A stand-in placeholder for the writer's eventual user message.
 *
 * No marker / surface-default resolution — the editor has no thread /
 * scene anchor. This is a shape preview, not the resolved wire payload.
 *
 * Honours the modal-level MD / Raw toggle via the `renderMode` prop.
 */
function PreviewTab({ draftPrompt, draftMessages, renderMode, isPersona, personaPreamble, characterContextFallback }) {
  const promptBody = (draftPrompt || '').trim()
  const systemBody = isPersona
    ? _composePersonaSystemMessage(personaPreamble, promptBody, characterContextFallback)
    : promptBody
  return (
    <div data-help-region="system-prompt-edit:preview" className="space-y-3">
      <PreviewRow role="system" body={systemBody} renderMode={renderMode} emptyHint="(No system prompt content yet.)" />
      {draftMessages.map((m) => (
        <PreviewRow key={m.id} role={m.role} body={m.body || ''} renderMode={renderMode} />
      ))}
      <PreviewRow role="user" body="" renderMode={renderMode} emptyHint="Your message would appear here." placeholder />
    </div>
  )
}

// Compose the literal three-section system message the assembly
// pipeline produces. The editor has no character selected, so the
// `<character_context>` block carries the genuine no-character
// fallback (fetched from the backend, defined once for the whole
// program in `backend/services/persona_preamble_service.py`). This is
// the actual string the AI would receive — `{{character_name}}` is
// left literal because no character is in play, just as it would be
// in any send path that hits this state.
function _composePersonaSystemMessage(preamble, promptBody, characterContextFallback) {
  const pre = (preamble || '').trim()
  const body = (promptBody || '').trim()
  const ctx = (characterContextFallback || '').trim()
  return [
    pre,
    '',
    '<character_context>',
    ctx,
    '</character_context>',
    '',
    '<system_prompt>',
    body,
    '</system_prompt>',
  ].join('\n')
}

const _PREVIEW_ROLE_STYLES = {
  system:    { label: 'System',    bar: 'border-amber-700/60',    badge: 'bg-amber-900/40 text-amber-200' },
  user:      { label: 'User',      bar: 'border-sky-700/60',      badge: 'bg-sky-900/40 text-sky-200' },
  assistant: { label: 'Assistant', bar: 'border-emerald-700/60',  badge: 'bg-emerald-900/40 text-emerald-200' },
}

function PreviewRow({ role, body, renderMode, emptyHint, placeholder }) {
  const style = _PREVIEW_ROLE_STYLES[role] || _PREVIEW_ROLE_STYLES.system
  const isEmpty = !body
  return (
    <section className={`rounded border ${style.bar} bg-zinc-900/30 overflow-hidden`}>
      <header className="px-2.5 py-1 flex items-center gap-2 bg-zinc-900/60 border-b border-zinc-800">
        <span className={`text-[9px] uppercase tracking-wide px-1.5 py-px rounded ${style.badge}`}>{style.label}</span>
      </header>
      <div className="px-3 py-2">
        {isEmpty ? (
          <div className={`text-[11px] ${placeholder ? 'text-zinc-500' : 'text-zinc-500'} italic`}>{emptyHint}</div>
        ) : renderMode === 'markdown' ? (
          <div className="text-[12px] text-zinc-200 leading-relaxed">
            <MarkdownBody content={body} />
          </div>
        ) : (
          <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-words font-mono leading-relaxed">{body}</pre>
        )}
      </div>
    </section>
  )
}

// ── Markdown-aware text field ─────────────────────────────────

/**
 * Click the rendered body to enter edit mode (raw textarea, focused
 * with the caret at the end). On blur, the textarea exits edit mode
 * and the body re-renders per the parent's `renderMode` prop. The
 * MD / Raw toggles (modal-level + per-message) drive that prop, so
 * the choice applies per surface.
 *
 * Empty bodies show a clickable placeholder so the writer can enter
 * the field even before there's any text to render.
 *
 * Textarea auto-grows to its content height — the writer doesn't
 * have to scroll inside the field to see what they've typed. The
 * rendered body naturally grows to fit its content too.
 */
function MarkdownTextField({ value, onChange, renderMode, placeholder }) {
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef(null)

  function autoGrow(el) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    try { el.setSelectionRange(len, len) } catch { /* not all browsers */ }
    autoGrow(el)
  }, [editing])

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={value || ''}
        onChange={(e) => {
          onChange(e.target.value)
          autoGrow(e.target)
        }}
        onBlur={() => setEditing(false)}
        placeholder={placeholder}
        rows={2}
        className="w-full bg-zinc-800 text-sm text-zinc-100 px-2.5 py-2 rounded border border-accent-500 focus:outline-none font-mono resize-none leading-relaxed overflow-hidden"
      />
    )
  }

  const empty = !value || !value.trim()
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="w-full text-left bg-zinc-900/40 hover:bg-zinc-800/60 hover:border-zinc-500 text-sm text-zinc-100 px-2.5 py-2 rounded border border-zinc-700 transition-colors cursor-text"
    >
      {empty ? (
        <span className="text-zinc-500 italic font-normal">{placeholder || '(empty — click to edit)'}</span>
      ) : renderMode === 'markdown' ? (
        <div className="prose-sm text-sm">
          <MarkdownBody content={value} />
        </div>
      ) : (
        <pre className="text-sm font-mono whitespace-pre-wrap text-zinc-100 m-0">{value}</pre>
      )}
    </button>
  )
}

// ── Header bits ───────────────────────────────────────────────

function CategoryDropdown({ value, categories, disabled, onChange, title, dataHelpRegion }) {
  return (
    <div className="relative flex-shrink-0" title={title} data-help-region={dataHelpRegion}>
      <select
        value={value || ''}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        className={`bg-zinc-800 text-xs text-zinc-100 px-2 py-1 pr-6 rounded border border-zinc-600 appearance-none ${disabled ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'} disabled:opacity-80`}
      >
        <option value="">Uncategorized</option>
        {categories.map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] text-zinc-500 pointer-events-none">▾</span>
    </div>
  )
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'sp_' + Math.random().toString(36).slice(2, 10)
}
