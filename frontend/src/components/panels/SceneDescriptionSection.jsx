/**
 * SceneDescriptionSection — bespoke editing UI for `scene.description`
 * (Phase 2.9a item 7, PBH wired in Phase 2.9d item 1 / v0.2.9.42).
 *
 * Exports two named components:
 *   - `SceneDescriptionToggle` — small button that lives in the editor
 *      panel's header row (next to the close button, right-aligned).
 *      Toggles the body below.
 *   - `SceneDescriptionBody` — the editing UI itself. Rendered below
 *      the editor header when the toggle is on; sits above the
 *      TipTap main_content editor.
 *
 * Plays the Section role for AI Send / Apply purposes per the
 * Phase 2.9 planning doc §1.4 — distinct from the larger TipTap
 * main_content editor and constrained to editing only the Scene
 * Description (nothing outside it). Plain-text-only.
 *
 * Body layout (expanded):
 *
 *   ┌─[ Prompt Block Header (live PromptBlockForm) ───────────┐
 *   │   ▸ collapsed-idle bar / expanded form depending on     │
 *   │   the writer's interaction; Send dispatches streamChat  │
 *   │   with the description as system context + the writer's │
 *   │   prompt → response overwrites the description (plain-  │
 *   │   text coerced).                                        │
 *   ├─[ plain-text editor (textarea, bound to description) ]──┤
 *   │   …writer types here, debounced save…                   │
 *   ├─[ action row (Summarize Scene placeholder) ]────────────┤
 *   │ Summarize Scene  (wires in 2.9d item 3)                 │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Per-PBH state is keyed by `sd:${sceneId}` on `sectionPromptBlocksStore`
 * — the same store regular Section PBHs + the IPB use. Distinct id
 * shape (the `sd:` prefix) keeps it from colliding with real Section
 * UUIDs even though both end up in the same map.
 *
 * No new save-format field — the existing `scene.description` string
 * on the SceneNode model is the data sink. Persistence is exactly
 * as it works today; the PBH just streams responses into the same
 * field via the parent's `onChange` callback.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import DescriptionEditor from '../ui/DescriptionEditor'
import PromptBlockForm from '../ui/PromptBlockForm'
import WirePayloadPreviewModal from '../chat/WirePayloadPreviewModal'
import { preconfiguredMessageHistoryWireTurns } from '../../utils/preconfiguredMessageHistory'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useProjectStore } from '../../store/projectStore'
import { streamChat } from '../../services/chatClient'

const SAVE_DEBOUNCE_MS = 400

/**
 * Small toggle button for the editor header row. Lives next to the
 * close button, right-aligned. Active when the body below is
 * expanded; transparent / outlined when collapsed.
 */
export function SceneDescriptionToggle({ expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={expanded}
      title={expanded ? 'Collapse Scene Description' : 'Expand Scene Description'}
      className={`inline-flex items-center gap-1 flex-shrink-0 leading-none rounded transition-colors border text-[11px] px-1.5 py-0.5 ${
        expanded
          ? 'bg-accent-700/30 border-accent-500 text-accent-100 hover:bg-accent-700/50'
          : 'bg-transparent border-accent-700 text-accent-300 hover:bg-accent-900/30'
      }`}
    >
      <span aria-hidden>{expanded ? '▾' : '▸'}</span>
      <span>Description</span>
    </button>
  )
}

// XML attribute-value escape. Used when stitching the scene's
// writer-typed title into the `<Scene title="...">` tag of the
// wire payload. Without this a title containing `"` would break
// the attribute syntax and `<` / `>` / `&` would break parsing on
// any downstream consumer that processes XML/HTML.
function _xmlAttrEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Strip any HTML / Markdown formatting from an AI-streamed response
 * (or the scene's main_content HTML) so it's safe to drop into the
 * plain-text scene.description field OR ride as plain prose context
 * for the Summarize Scene flow. Same shape as `applyToEditorSection`'s
 * `plainText: true` path — markdown punctuation survives as literal
 * characters (no `marked` parse), HTML entities are decoded, tags
 * stripped via a temporary DOM node.
 *
 * Block-level close tags get a trailing `\n\n` injected BEFORE the
 * tag strip so paragraph / section / heading / list boundaries
 * survive as paragraph breaks in the resulting plain text. Without
 * this, `textContent` concatenates adjacent blocks into one run-on
 * line (e.g. `<section>Section contents</section><p>Next paragraph
 * </p>` collapsed to `Section contentsNext paragraph`).
 *
 * Idempotent on plain text input.
 */
function _toPlainText(s) {
  if (!s) return ''
  const withBreaks = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|blockquote|pre|tr|figure|figcaption|article|aside|header|footer|nav|main)>/gi, '$&\n\n')
  // Decode HTML entities + strip tags using a detached element.
  const tmp = document.createElement('div')
  tmp.innerHTML = withBreaks
  const text = tmp.textContent || tmp.innerText || ''
  // Collapse runs of 3+ newlines into 2 (paragraph spacing) and trim.
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
}

/**
 * The editing-area body. Rendered below the editor header when the
 * toggle is on. Returns null when not expanded so the parent can
 * unconditionally render it (the toggle controls visibility).
 *
 * `sceneId` is the canvas node id for the scene whose description
 * is being edited; used to key the PBH form state on
 * `sectionPromptBlocksStore` so each scene's PBH gets its own
 * independent draft / pinned context / settings.
 */
export function SceneDescriptionBody({ expanded, description, onChange, sceneId }) {
  const [value, setValue] = useState(description || '')
  const pending = useRef(null)
  const debounceTimer = useRef(null)
  // ToDo item 163 — Preview Message state. Same handlePbhSend
  // dispatcher routes to setPreviewPayload via previewOpts when the
  // gear popover's Preview Message entry fires. Single-mode
  // (no history concept for the scene-description PBH).
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPayload, setPreviewPayload] = useState(null)

  // Sync from upstream when the bound scene changes (e.g. the writer
  // switches to a different scene). Skip when the local value matches
  // — otherwise an in-progress edit would get clobbered each render.
  useEffect(() => {
    setValue((prev) => (prev === (description || '') ? prev : description || ''))
  }, [description])

  const flushChange = useCallback(() => {
    if (pending.current != null) {
      const v = pending.current
      pending.current = null
      onChange(v)
    }
  }, [onChange])

  const handleChange = useCallback(
    (next) => {
      setValue(next)
      pending.current = next
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(flushChange, SAVE_DEBOUNCE_MS)
    },
    [flushChange],
  )

  // Flush on unmount (collapse, scene-switch with description visible
  // and pending edits, panel close).
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      flushChange()
    }
  }, [flushChange])

  // ── PBH wiring (Phase 2.9d item 1 / v0.2.9.42) ─────────────────
  // Per-block state key. `sd:` prefix keeps the entry distinct from
  // real Section UUIDs in the same store map. Stable across re-
  // renders of the same scene; switches when the writer navigates
  // to a different scene (each scene gets its own draft).
  const sectionId = sceneId ? `sd:${sceneId}` : null
  const patchPromptBlock = useSectionPromptBlocksStore((s) => s.patch)

  // Send dispatcher. The Scene Description's PBH input is the
  // current description text (when the "Description" pill is on —
  // default ON); the writer's prompt is the user message. The
  // response is plain-text coerced and OVERWRITES the description
  // (no append/prepend mode — the writer's prompt is "do this with
  // this Description"; mid-stream output is also coerced so the
  // visible text stays plain). Manual context attachments + Scene
  // Context toggle handled by `PromptBlockForm` via the shared
  // `buildSceneContextBlock` renderer.
  const handlePbhSend = useCallback(({ systemPromptText, mockMessages, profileId, model, message, sceneContextOverride, includeSceneMainContent, previewOpts }) => {
    if (!sectionId) return
    if (!sceneId) return
    // ToDo item 163 — Preview destination. Same wire-build below
    // runs unchanged; the streaming dispatch + persistence are
    // gated by isPreview and the streamChat call is replaced with
    // a callback to `previewOpts.onPreview`.
    const isPreview = !!(previewOpts && typeof previewOpts.onPreview === 'function')

    const blockState = useSectionPromptBlocksStore.getState().blocks[sectionId]
    const pinned = blockState?.pinnedContextItems || []
    // `sceneContextOverride` is a per-send forcing flag used by the
    // collapsed-state Summarize Scene shortcut — it switches scene
    // context on for this send only WITHOUT writing back to the
    // PBH's stored toggle. Regular send paths leave it `undefined`
    // and the stored toggle wins.
    const sceneContextEnabled = sceneContextOverride !== undefined
      ? !!sceneContextOverride
      : !!blockState?.sceneContextEnabled
    const includeDescription = blockState?.includeHostSectionContent !== false  // default true
    // Persistent toggle on the Scene Description PBH for including
    // the host scene's narrative prose as additional context. Off by
    // default. Distinct from `includeSceneMainContent` which is the
    // per-send flag used by the Summarize Scene shortcut — if EITHER
    // source asks for the prose, it rides.
    const includeSceneMainProse = !!blockState?.includeSceneMainProse

    const abortController = new AbortController()
    if (!isPreview) {
      patchPromptBlock(sectionId, {
        isStreaming: true,
        abortController,
        streamError: null,
      })
    }

    // Wire shape mirrors the chat composer's: ONE role:user message
    // containing `<context>` framing, the current description
    // wrapped in `<description>` (when included), and the writer's
    // prompt wrapped in `<message>`. System prompt rides as the
    // streamChat top-level `systemPrompt` param.
    //
    // Pieces collected up-front (synchronous), assembled inside the
    // async IIFE below once the pinned + scene-context block resolves.
    const currentDescription = value || '(empty)'
    // Scene's narrative prose, rendered as its own `<Scene
    // title="...">...</Scene>` tag in the wire (parallel to the
    // `<description>` tag). The tag + title attribute is the AI's
    // semantic grounding — no need for an inline "this is the
    // narrative prose..." framing line. Resolved when either source
    // requests it:
    //   (a) the persistent Scene-prose pill on this PBH, or
    //   (b) the per-send `includeSceneMainContent` flag used by the
    //       collapsed-state Summarize Scene shortcut (always on for
    //       that path).
    // Try-catch wraps only the read; the wrap emits unconditionally
    // when one of the flags is set so the AI ALWAYS sees the prose
    // block in the wire — critical for Summarize Scene where the
    // prose IS the whole point.
    let scenePrologueWrap = ''
    if (includeSceneMainContent || includeSceneMainProse) {
      let mainPlain = ''
      let sceneTitle = ''
      let readError = false
      try {
        const projectStore = useProjectStore.getState()
        const sceneNode = (projectStore.nodes || []).find(
          (n) => n.id === sceneId && n.type === 'sceneNode',
        )
        const mainHtml = sceneNode?.data?.main_content || ''
        mainPlain = _toPlainText(mainHtml).trim()
        sceneTitle = sceneNode?.data?.title || ''
      } catch {
        readError = true
      }
      const body = readError
        ? '(scene prose could not be read; the field may be malformed)'
        : (mainPlain || '(scene is empty — no prose available)')
      const titleAttr = sceneTitle ? ` title="${_xmlAttrEscape(sceneTitle)}"` : ''
      scenePrologueWrap = `<Scene${titleAttr}>\n${body}\n</Scene>`
    }
    // `wireMessages` assembled inside the async IIFE below.
    let wireMessages = []

    let accum = ''
    let lastWriteAt = 0
    let pendingWrite = null
    // Double-flush guard (v0.2.9.45) — matches the same pattern in
    // InlinePromptBlock and SectionView. Scene Description writes
    // plain text via setValue, so the corruption mode that hit the
    // editor path doesn't strictly apply here (no ProseMirror
    // open-end merging), but the guard is cheap and keeps all three
    // streaming write paths behaviourally identical.
    let lastFlushedAccum = null
    const THROTTLE_MS = 100
    const flushWrite = () => {
      lastWriteAt = Date.now()
      pendingWrite = null
      if (accum === lastFlushedAccum) return
      try {
        const plain = _toPlainText(accum)
        // Push directly through the parent's onChange — this writes
        // back to `scene.description` via `updateNodeData` upstream.
        // The local `value` state stays synced via the useEffect on
        // `description` change.
        onChange(plain)
        setValue(plain)
        lastFlushedAccum = accum
      } catch { /* swallow per-delta render errors */ }
    }
    const scheduleWrite = () => {
      const now = Date.now()
      if (now - lastWriteAt >= THROTTLE_MS) {
        flushWrite()
      } else if (!pendingWrite) {
        pendingWrite = setTimeout(flushWrite, THROTTLE_MS - (now - lastWriteAt))
      }
    }

    ;(async () => {
      let errored = null
      // Resolve pinned + scene-context blocks via dynamic import (same
      // pattern as SectionView / InlinePromptBlock — avoids the static
      // import cycle through applyToEditorSection).
      let combinedBlock = ''
      try {
        const hasPinned = pinned.length > 0
        const hasSceneContext = sceneContextEnabled && sceneId
        if (hasPinned || hasSceneContext) {
          const mod = await import('../../utils/sceneContextPrompt')
          combinedBlock = await mod.buildSceneContextBlock({
            pinnedItems: hasPinned ? pinned : [],
            sceneId: hasSceneContext ? sceneId : null,
            // Pass structural host scene unconditionally so dynamic
            // pins (e.g. current_scene_body) resolve even when the
            // writer has the Scene Context toggle off.
            hostSceneId: sceneId,
          }) || ''
        }
      } catch { /* renderer failures non-fatal — proceed without extras */ }

      // Assemble single role:user wire message. Order:
      //   <context>      — pinned + scene-context framing block
      //   <Scene title=...> — scene's narrative prose (when on)
      //   <description>  — current description text (when on)
      //   <message>      — writer's typed instruction
      // Each wrapper omits when its content is empty.
      const contextWrap = combinedBlock
        ? `<context>\n${combinedBlock}\n</context>`
        : ''
      const descriptionWrap = includeDescription
        ? `<description>\n${currentDescription}\n</description>`
        : ''
      const messageWrap = `<message>\n${message}\n</message>`
      const userContent = [contextWrap, scenePrologueWrap, descriptionWrap, messageWrap]
        .filter(Boolean)
        .join('\n\n')
      // Splice Pre-Configured Message History (`SystemPrompt.mock_messages`)
      // at the front of the messages array — before the writer's
      // single tagged user message. PCMH rides on Summarize Scene
      // too (the collapsed-state shortcut routes through the same
      // dispatcher, so a Summarize prompt with PCMH gets its primer
      // turns automatically).
      const pcmhWireTurns = preconfiguredMessageHistoryWireTurns({ mock_messages: mockMessages })
      wireMessages = [
        ...pcmhWireTurns,
        { role: 'user', content: userContent },
      ]
      // ToDo item 163 — Preview destination. Same wire-build code
      // above ran. Hand the assembled payload off and return — no
      // streamChat dispatch, no writes to scene.description, no
      // post-stream patchPromptBlock.
      if (isPreview) {
        previewOpts.onPreview({
          profileId,
          model,
          messages: wireMessages,
          systemPrompt: systemPromptText,
        })
        return
      }
      try {
        for await (const evt of streamChat({
          profileId,
          model,
          messages: wireMessages,
          systemPrompt: systemPromptText,
          signal: abortController.signal,
        })) {
          if (evt.type === 'delta' && typeof evt.text === 'string') {
            accum += evt.text
            scheduleWrite()
          } else if (evt.type === 'end') {
            if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null }
            flushWrite()
          } else if (evt.type === 'error') {
            errored = evt.detail || 'AI request failed'
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') errored = e?.message || 'AI request failed'
      }
      if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null }
      if (accum) flushWrite()
      patchPromptBlock(sectionId, {
        isStreaming: false,
        abortController: null,
        streamError: errored,
      })
    })()
  }, [sectionId, sceneId, value, onChange, patchPromptBlock])

  const handlePbhCancel = useCallback(() => {
    if (!sectionId) return
    const blockState = useSectionPromptBlocksStore.getState().blocks[sectionId]
    if (blockState?.abortController) {
      try { blockState.abortController.abort() } catch { /* ignore */ }
    }
  }, [sectionId])

  if (!expanded) return null

  return (
    <div className="nn-scene-desc-body">
      {/* Section header — uses the same small uppercase styling the
          shared DescriptionEditor's built-in label uses. */}
      <label className="text-[10px] text-zinc-500 uppercase tracking-wider">
        Description
      </label>

      {/* Live Prompt Block Header (Phase 2.9d item 1 / v0.2.9.42).
          Uses the shared `PromptBlockForm` in 'scene-description' mode
          — Section pill labelled "Description"; Send dispatch in
          `handlePbhSend` overwrites scene.description plain-text-
          coerced. Hosted scene id passed so the Scene Context toggle
          + auto-attach scanner know which scene they're in. */}
      {sectionId && (
        <div className="nn-scene-desc-pbh">
          <PromptBlockForm
            mode="scene-description"
            sectionId={sectionId}
            surfaceType="scene_description_pbh"
            onSend={handlePbhSend}
            onCancel={handlePbhCancel}
            onSendPreview={(args) => {
              setPreviewPayload(null)
              setPreviewOpen(true)
              handlePbhSend({ ...args, previewOpts: { onPreview: setPreviewPayload } })
            }}
            hostSceneId={sceneId}
          />
        </div>
      )}

      <div data-help-region="editor-panel:scene_description_editor">
        <DescriptionEditor
          value={value}
          onChange={handleChange}
          onBlur={flushChange}
          placeholder="Write a scene description. Plain text only. Doubles as bidirectional metadata between you and the AI — your notes feed into AI context, and AI-generated summaries land here for reference."
          rows={4}
          containerClassName=""
          hideLabel
        />
      </div>

      {/* The standalone Summarize Scene button was removed in v0.2.10
          — its function is now the collapsed-state action of the
          Scene Description PBH's AI Prompt section. See
          `PromptBlockForm.jsx`'s `handleSummarizeScene`. */}

      {/* ToDo item 163 — Preview Message modal. */}
      {previewOpen && (
        <WirePayloadPreviewModal
          surface="scene-desc-pbh"
          payload={previewPayload}
          modeToggleAvailable={false}
          onClose={() => { setPreviewOpen(false); setPreviewPayload(null) }}
        />
      )}
    </div>
  )
}
