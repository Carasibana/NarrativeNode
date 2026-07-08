/**
 * SectionView — the React NodeView component for the `section`
 * TipTap node (Phase 2.9a item 2).
 *
 * Renders the Section UI chrome — our name for the visual wrapper
 * around a Section's prose children. Built on top of TipTap's
 * NodeView API; we use the in-doc name "Section UI" for the chrome
 * itself and qualify TipTap's term as "TipTap's NodeView" to avoid
 * collision with the React Flow canvas Nodes that already populate
 * the program (see Glossary).
 *
 * Layout (top to bottom):
 *
 *   ┌─ name bar + drag handle ──────────────────────────────────┐
 *   │ ⋮⋮  Section 1                                             │
 *   ├─ Prompt Block Header row (collapsed by default) ──────────┤
 *   │ ▸ AI prompt                              (wires in 2.9c)  │
 *   ├─ Section action toolbar ─────────────────────────────────┤
 *   │ Rename  Dissolve  Attach to Chat  Step back  Step fwd     │
 *   ├─ content area (NodeViewContent — TipTap children) ────────┤
 *   │   …prose children render here…                            │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Wrapped by the story-accent border.
 *
 * Scope for this item: render-only — name bar inline rename is
 * functional (click name → input → Enter to commit, Esc to cancel).
 * Action toolbar buttons are STUBS — visually present + tooltipped
 * with the item that will wire each one, but disabled. The Prompt
 * Block Header row is a placeholder strip; form rendering + Send
 * wiring lands in Phase 2.9c. Drag handle is wired via the
 * `data-drag-handle` attribute (with `draggable: true` on the
 * SectionExtension schema), so ProseMirror handles drag-and-drop
 * relocation for free.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react'
import { DOMParser as PMDOMParser, DOMSerializer, Fragment } from '@tiptap/pm/model'
import AttachToChatGlyph from '../chat/AttachToChatGlyph'
import { useIsChatOpenOnConversation } from '../../hooks/useIsChatOpenOnConversation'
import { confirm } from '../../store/dialogStore'
import { useSectionHistoryStore } from '../../store/sectionHistoryStore'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import { useEditorSurface } from './EditorSurfaceContext'
import PromptBlockForm from './PromptBlockForm'
import WirePayloadPreviewModal from '../chat/WirePayloadPreviewModal'
import { preconfiguredMessageHistoryWireTurns } from '../../utils/preconfiguredMessageHistory'
import { streamChat } from '../../services/chatClient'
import { markdownToTiptapHtml } from '../../utils/markdownToTiptapHtml'
import { tiptapHtmlToMarkdown } from '../../utils/tiptapToMarkdown'
// Phase 2.9c item 7 — `buildSceneContextBlock` is loaded via dynamic
// import inside `handleSend` below. The static-import chain
// `SectionExtension → SectionView → sceneContextPrompt →
// applyToEditorSection → SectionExtension` creates a TDZ trap (the
// chain references `SectionExtension` before its `export const`
// initialises), surfacing as a blank UI on first load. Dynamic
// import breaks the static-init dependency entirely — the module
// only resolves when the writer actually fires Send.

// XML attribute-value escape. Used when stitching the Section's
// writer-typed name into the `<selection name="...">` tag of the
// wire payload. Without this a name containing `"` would break the
// attribute syntax and `<` / `>` / `&` would break parsing on any
// downstream consumer that processes XML/HTML.
function _xmlAttrEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export default function SectionView({ node, updateAttributes, deleteNode, editor, getPos }) {
  const name = node.attrs.name || ''
  const id = node.attrs.id

  // Phase 2.7 visibility convention — every "add as context" affordance
  // in the program hides itself when no conversation is the active
  // view inside the chat panel, so the writer never sees a no-op
  // control. Mirror that here for the Section's Attach to Chat
  // button (planning doc §4.6 + Glossary "Section UI" layout note).
  const chatVisible = useIsChatOpenOnConversation()

  // Phase 2.9b — Attach to Chat from the Section's toolbar.
  // Composes the Section pill (kind 'section' + this Section's id +
  // surface ref from the EditorSurfaceContext) and dispatches to
  // uiStore. No anchor — Sections aren't chain-tracked. The pill's
  // display name + bundled content track the live Section at render /
  // send time via `findSectionContent`. Button stays disabled when no
  // surface is in scope (e.g. text-attachment viewer) since the pin
  // would have no host to resolve against.
  const editorSurface = useEditorSurface()
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  const chatSurfaceKey = activeThreadId ? `chat:${activeThreadId}` : null
  const addPin = usePinnedContextStore((s) => s.addPin)
  const handleAttachToChat = useCallback(() => {
    if (!id || !editorSurface || !chatSurfaceKey) return
    addPin(chatSurfaceKey, {
      kind: 'section',
      id,
      surface_type: editorSurface.surface_type,
      surface_host_id: editorSurface.surface_host_id,
    })
  }, [id, editorSurface, chatSurfaceKey, addPin])

  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(name)

  // ToDo item 163 — Preview Message state. Same handleSend code path
  // produces both the real send (route to streamChat) and the preview
  // (route to setPreviewPayload). Section PBH is single-mode (no
  // history concept), so the mode toggle is hidden in the modal.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPayload, setPreviewPayload] = useState(null)
  const inputRef = useRef(null)

  const commitRename = useCallback(() => {
    const trimmed = (draft || '').trim()
    if (trimmed !== name) {
      updateAttributes({ name: trimmed })
    }
    setRenaming(false)
  }, [draft, name, updateAttributes])

  const cancelRename = useCallback(() => {
    setDraft(name)
    setRenaming(false)
  }, [name])

  const startRename = useCallback(() => {
    setDraft(name)
    setRenaming(true)
  }, [name])

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  const displayName = name || 'Section'

  // Section History (Phase 2.9a item 8). Step back / Step forward
  // buttons read enabled state from the snapshot store via selectors
  // (re-render when this Section's history changes); the actual
  // snapshot triggers (Send-time pre-state + AI-response-complete)
  // live in the AI write paths — Phase 2.9b for Apply to Editor
  // Section, Phase 2.9c for Prompt Block Header Send. Until those
  // wire `pushSnapshot`, the buttons stay visually disabled.
  const canStepBack = useSectionHistoryStore((s) => {
    const h = s.history[id]
    return !!h && h.currentIndex > 0
  })
  const canStepForward = useSectionHistoryStore((s) => {
    const h = s.history[id]
    return !!h && h.currentIndex < h.snapshots.length - 1
  })
  const stepBackInStore = useSectionHistoryStore((s) => s.stepBack)
  const stepForwardInStore = useSectionHistoryStore((s) => s.stepForward)
  const clearHistory = useSectionHistoryStore((s) => s.clear)
  // Phase 2.9c — tear down the per-Section Prompt Block state when
  // the Section ceases to exist (Dissolve / Delete). Mirrors the
  // sectionHistoryStore.clear call below so the prompt-block map
  // doesn't leak entries for vanished Sections.
  const clearPromptBlock = useSectionPromptBlocksStore((s) => s.clear)

  // Apply a snapshot (the Section's children fragment as JSON) to
  // the live document — replaces just THIS Section's inner content.
  // Single transaction → one Ctrl+Z reverts. Doesn't touch attrs;
  // only what's inside.
  const applySnapshotToSection = useCallback(
    (snapshot) => {
      if (!editor || !Array.isArray(snapshot) || typeof getPos !== 'function') return
      const pos = typeof getPos === 'function' ? getPos() : null
      if (typeof pos !== 'number') return
      const sectionNode = editor.state.doc.nodeAt(pos)
      if (!sectionNode || sectionNode.type.name !== 'section') return
      const innerFrom = pos + 1
      const innerTo = pos + sectionNode.nodeSize - 1
      const nodes = snapshot
        .map((json) => {
          try {
            return editor.schema.nodeFromJSON(json)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      if (!nodes.length) return
      const fragment = Fragment.fromArray(nodes)
      const tr = editor.state.tr.replaceWith(innerFrom, innerTo, fragment)
      editor.view.dispatch(tr)
    },
    [editor, getPos],
  )

  const handleStepBack = useCallback(() => {
    if (!id) return
    const snapshot = stepBackInStore(id)
    if (snapshot) applySnapshotToSection(snapshot)
  }, [id, stepBackInStore, applySnapshotToSection])

  const handleStepForward = useCallback(() => {
    if (!id) return
    const snapshot = stepForwardInStore(id)
    if (snapshot) applySnapshotToSection(snapshot)
  }, [id, stepForwardInStore, applySnapshotToSection])

  // Dissolve — strips the wrapper, keeps the prose contents in place
  // (one ProseMirror transaction, one Ctrl+Z restores). Non-destructive
  // by design — no confirm prompt; the content survives.
  //
  // `commands.lift()` requires the editor's selection to be INSIDE the
  // node being lifted. Clicking a toolbar button doesn't move the
  // selection — the writer's cursor may be elsewhere (or nowhere at
  // all). Seed the selection just inside this Section's first child
  // (position `getPos() + 1` lands inside the wrapper's first block)
  // before running the lift command.
  const handleDissolve = useCallback(() => {
    if (!editor || typeof getPos !== 'function') return
    const pos = getPos()
    if (typeof pos !== 'number') return
    editor
      .chain()
      .focus()
      .setTextSelection(pos + 1)
      .liftSection()
      .run()
    // Section ceases to exist after lift — drop its history entry so
    // the snapshot map doesn't leak entries for a now-vanished id.
    // Also tear down the Prompt Block state (form draft, streaming
    // controller if any) for the same reason.
    if (id) {
      clearHistory(id)
      clearPromptBlock(id)
    }
  }, [editor, getPos, id, clearHistory, clearPromptBlock])

  // Delete — removes the Section AND all of its contents. Destructive,
  // but Ctrl+Z restores in one step. Still guarded by a confirm prompt
  // because the click sits adjacent to Dissolve and a misclick would
  // erase the writer's prose. `confirm()` from dialogStore returns a
  // promise that resolves to the chosen button's `value` (or
  // `cancelValue` on Escape / backdrop click).
  const handleDelete = useCallback(async () => {
    if (!deleteNode) return
    const result = await confirm({
      title: 'Delete Section?',
      message: `Delete "${displayName}" and all of its contents? You can press Ctrl+Z to undo.`,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result === 'delete') {
      deleteNode()
      if (id) {
        clearHistory(id)
        clearPromptBlock(id)
      }
    }
  }, [deleteNode, displayName, id, clearHistory, clearPromptBlock])

  // Phase 2.9c item 1 — Prompt Block Header Send dispatch.
  //
  // Pulls the current Section's content as markdown (for the AI's
  // system context), builds the wire messages, fires a streaming
  // request via `streamChat`, and writes the response back into the
  // Section's children as each delta arrives. Both Section History
  // snapshots fire — pre-Send always, post-Send on BOTH normal
  // completion AND cancel (so partial output is recoverable per
  // planning doc §1.5 revision).
  const pushHistorySnapshot = useSectionHistoryStore((s) => s.pushSnapshot)
  const patchPromptBlock = useSectionPromptBlocksStore((s) => s.patch)
  const pushPromptHistory = useSectionPromptBlocksStore((s) => s.pushPromptHistory)

  // Read the Section's CURRENT children — as a JSON array (for
  // Section History snapshots) and as a plain-html string (for the
  // markdown conversion that feeds the AI's system context).
  const readSectionState = useCallback(() => {
    if (!editor || typeof getPos !== 'function') return null
    const pos = getPos()
    if (typeof pos !== 'number') return null
    const sectionNode = editor.state.doc.nodeAt(pos)
    if (!sectionNode || sectionNode.type.name !== 'section') return null
    const childrenJson = []
    sectionNode.content.forEach((child) => { childrenJson.push(child.toJSON()) })
    // Inner HTML: serialise the section's content fragment to a
    // host-doc-style HTML string (the same shape findSectionContent
    // returns) so it can feed `tiptapHtmlToMarkdown` for the AI's
    // system context. `DOMSerializer.fromSchema(schema)` builds a
    // serializer bound to the live editor schema so all registered
    // marks / nodes round-trip correctly.
    const serializer = DOMSerializer.fromSchema(editor.state.schema)
    const dom = serializer.serializeFragment(sectionNode.content)
    const tempDiv = document.createElement('div')
    tempDiv.appendChild(dom)
    return {
      childrenJson,
      innerHtml: tempDiv.innerHTML,
      pos,
      sectionNode,
    }
  }, [editor, getPos])

  // Replace the Section's inner content with the given HTML. Wraps
  // the parse + tr.replaceWith in a single dispatch carrying the
  // `aiWrite` meta marker so the filterTransaction plugin in
  // SectionExtension lets the write through (writer's own typing
  // is rejected while streaming; the AI's writes ride this marker).
  const writeSectionFromHtml = useCallback((html) => {
    if (!editor || typeof getPos !== 'function') return
    const pos = getPos()
    if (typeof pos !== 'number') return
    const sectionNode = editor.state.doc.nodeAt(pos)
    if (!sectionNode || sectionNode.type.name !== 'section') return
    const innerFrom = pos + 1
    const innerTo = pos + sectionNode.nodeSize - 1
    // Parse the HTML into a DocumentFragment, then convert to a
    // ProseMirror fragment via PMDOMParser bound to the live schema.
    let domFragment
    try {
      const tmp = document.createElement('div')
      tmp.innerHTML = html
      domFragment = tmp
    } catch {
      return
    }
    const parser = PMDOMParser.fromSchema(editor.state.schema)
    // Default whitespace handling — inter-block newlines (the `\n`s
    // between `<p>`/`<h1>`/etc. that `innerHTML` introduces) collapse
    // away. `preserveWhitespace: 'full'` would keep them and wrap
    // them as empty text content / blank paragraphs in the slice —
    // visible as extra blank lines between stanzas in the rendered
    // Section. Default is right for prose.
    const slice = parser.parseSlice(domFragment)
    const tr = editor.state.tr
      .replaceWith(innerFrom, innerTo, slice.content)
      .setMeta('aiWrite', true)
    editor.view.dispatch(tr)
  }, [editor, getPos])

  const handleSend = useCallback(({ systemPromptText, mockMessages, profileId, model, message, previewOpts }) => {
    if (!id) return
    const pre = readSectionState()
    if (!pre) return
    // ToDo item 163 — Preview destination. When `previewOpts.onPreview`
    // is set, build the exact same wireMessages and route the payload
    // to the callback instead of dispatching streamChat. Skip every
    // persistence side effect (no history snapshot, no streaming
    // patch, no writeSectionFromHtml).
    const isPreview = !!(previewOpts && typeof previewOpts.onPreview === 'function')
    if (!isPreview) {
      // Push pre-Send snapshot — gives the writer a return point.
      pushHistorySnapshot(id, pre.childrenJson)
      pushPromptHistory(id, message.slice(0, 80))
    }

    const abortController = new AbortController()
    if (!isPreview) {
      patchPromptBlock(id, {
        isStreaming: true,
        abortController,
        streamError: null,
      })
    }

    // Build wire messages: Section's current content as a system
    // context block (when the writer hasn't toggled it off), writer's
    // composed message as the user message. Manually-attached context
    // items (Phase 2.9c item 7) prepend their own system context block
    // ahead of the Section content; Scene Context (when toggled on)
    // prepends a full-scene block in turn.
    const sectionMarkdown = tiptapHtmlToMarkdown(pre.innerHtml) || '(empty)'
    const blockState = useSectionPromptBlocksStore.getState().blocks[id]
    const pinned = blockState?.pinnedContextItems || []
    const sceneContextEnabled = !!blockState?.sceneContextEnabled
    const includeHostSectionContent = blockState?.includeHostSectionContent !== false  // default true
    // Before / After surrounding-prose toggles (v0.2.9.44 — writer
    // spec 2026-05-28: Before/After widened from IPB-cursor-only to
    // also apply in PBH). Slice N words before the Section's start
    // and N words after the Section's end from the host editor's
    // doc. Section's range in the editor: `pre.pos` to
    // `pre.pos + pre.sectionNode.nodeSize`.
    const includePreceding = blockState?.includePreceding !== false  // default true
    const includeFollowing = blockState?.includeFollowing !== false  // default true
    const precedingCount = Math.max(0, blockState?.precedingWords ?? 50)
    const followingCount = Math.max(0, blockState?.followingWords ?? 50)
    const hostSceneId = editorSurface?.surface_type === 'scene_main'
      ? editorSurface?.surface_host_id
      : null

    // Wire shape mirrors the chat composer's: ONE role:user message
    // containing every piece of framing wrapped in `<context>`, the
    // Section's current content (when included) wrapped in
    // `<selection name="...">`, and the writer's typed prompt in
    // `<message>`. The selected system prompt rides as the
    // `streamChat` top-level `systemPrompt` param (NOT inside the
    // user message). XML-tag delimiters keep the boundary clear for
    // the AI without breaking provider compatibility — consecutive
    // same-role messages aren't universally supported (Bedrock /
    // vLLM / strict-alternation local templates reject them), so a
    // single tagged user message stays portable everywhere.
    //
    // contextParts collects each framing block in display order
    // (scene/pinned first; surrounding prose around the Section
    // second). The Section's content lives in `<selection>` and is
    // NOT a context part. precedingText / followingText computed
    // synchronously up here so the IIFE below only owes the async
    // pinned + scene-context resolution.
    const sectionName = pre.sectionNode?.attrs?.name || ''
    const contextParts = []
    let precedingTextRendered = ''
    let followingTextRendered = ''
    try {
      const sectionStart = pre.pos
      const sectionEnd = pre.pos + pre.sectionNode.nodeSize
      const docSize = editor.state.doc.content.size
      if (includePreceding && precedingCount > 0 && sectionStart > 0) {
        const before = editor.state.doc.textBetween(0, sectionStart, '\n', ' ')
        const beforeWords = before.trim().split(/\s+/).filter(Boolean)
        const precedingText = beforeWords.slice(-precedingCount).join(' ')
        if (precedingText) {
          precedingTextRendered = [
            `The text below is the prose immediately BEFORE this Section`,
            `(last ${precedingCount} words). Use it for voice / tense / continuity,`,
            `but do not repeat any of it in your response.`,
            '',
            precedingText,
          ].join('\n')
        }
      }
      if (includeFollowing && followingCount > 0 && sectionEnd < docSize) {
        const after = editor.state.doc.textBetween(sectionEnd, docSize, '\n', ' ')
        const afterWords = after.trim().split(/\s+/).filter(Boolean)
        const followingText = afterWords.slice(0, followingCount).join(' ')
        if (followingText) {
          followingTextRendered = [
            `The text below is the prose immediately AFTER this Section`,
            `(first ${followingCount} words). Use it for voice / tense / continuity,`,
            `but do not repeat any of it in your response.`,
            '',
            followingText,
          ].join('\n')
        }
      }
    } catch { /* defensive — fall back to no surrounding prose */ }
    // wireMessages assembled inside the async IIFE below, AFTER the
    // pinned + scene-context block resolves. Declared here so the
    // IIFE can write to it without TDZ trap.
    let wireMessages = []

    let accum = ''
    let lastWriteAt = 0
    let pendingWrite = null
    // v0.2.9.45 — track last-flushed accum so the trailing
    // `if (accum) flushWrite()` after the loop doesn't redundantly
    // re-apply the same content (which can interact badly with
    // ProseMirror's open-end merge semantics on the second pass —
    // see the matching guard in InlinePromptBlock.jsx and the
    // garbled-text bug report it traces back to).
    let lastFlushedAccum = null
    const THROTTLE_MS = 100
    const flushWrite = () => {
      lastWriteAt = Date.now()
      pendingWrite = null
      if (accum === lastFlushedAccum) return
      try {
        const html = markdownToTiptapHtml(accum) || ''
        writeSectionFromHtml(html)
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
      // Resolve the pinned + scene-context block (if any) BEFORE we
      // assemble the final wire message. `buildSceneContextBlock`
      // reads project store state to resolve entity / knowledge /
      // relationship / cue / scene / section pins to their current
      // Markdown rendering. Returns '' when no inputs are in force.
      let combinedBlock = ''
      try {
        const hasPinned = pinned.length > 0
        const hasSceneContext = sceneContextEnabled && hostSceneId
        if (hasPinned || hasSceneContext) {
          const mod = await import('../../utils/sceneContextPrompt')
          combinedBlock = await mod.buildSceneContextBlock({
            pinnedItems: hasPinned ? pinned : [],
            sceneId: hasSceneContext ? hostSceneId : null,
            // Always pass the structural host scene id so dynamic
            // pins (e.g. `current_scene_body`) resolve against this
            // Section's surrounding scene even when the writer has
            // the Scene Context toggle off.
            hostSceneId,
          }) || ''
        }
      } catch { /* renderer failures are non-fatal — proceed without extras */ }

      // Assemble the single role:user wire message. Order inside
      // matches what makes sense for the AI to read:
      //   <context>  — scene/pinned framing, then surrounding prose
      //   <selection name="X">  — the Section content (when included)
      //   <message>  — the writer's typed instruction
      // Each wrapper omits when its content would be empty.
      if (combinedBlock) contextParts.unshift(combinedBlock)
      if (precedingTextRendered) contextParts.push(precedingTextRendered)
      if (followingTextRendered) contextParts.push(followingTextRendered)
      const contextWrap = contextParts.length > 0
        ? `<context>\n${contextParts.join('\n\n')}\n</context>`
        : ''
      const selectionWrap = includeHostSectionContent
        ? (sectionName
          ? `<selection name="${_xmlAttrEscape(sectionName)}">\n${sectionMarkdown}\n</selection>`
          : `<selection>\n${sectionMarkdown}\n</selection>`)
        : ''
      const messageWrap = `<message>\n${message}\n</message>`
      const userContent = [contextWrap, selectionWrap, messageWrap]
        .filter(Boolean)
        .join('\n\n')
      // Splice Pre-Configured Message History (`SystemPrompt.mock_messages`)
      // at the front of the messages array. PBH has no real chat
      // history, so PCMH turns ride directly before the writer's
      // single tagged user message. The LLM sees them as legitimate
      // prior turns. PCMH is invisible in the surface UI — only
      // surfaces via the Preview Message modal which renders this
      // same wire payload.
      const pcmhWireTurns = preconfiguredMessageHistoryWireTurns({ mock_messages: mockMessages })
      wireMessages = [
        ...pcmhWireTurns,
        { role: 'user', content: userContent },
      ]
      // ToDo item 163 — Preview destination. Same wire-build code
      // above ran. Instead of dispatching to streamChat, hand the
      // assembled payload to the preview callback. No persistence
      // side-effects ran (gated by isPreview), so this is read-only.
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
            // Final flush — ensures the last partial buffer lands.
            if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null }
            flushWrite()
          } else if (evt.type === 'error') {
            errored = evt.detail || 'AI request failed'
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') errored = e?.message || 'AI request failed'
      }
      // Ensure any pending throttled write lands before the post-snapshot
      if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null }
      if (accum) flushWrite()

      // Post-snapshot — captures whatever's in the Section now,
      // whether the stream finished normally OR was cancelled
      // mid-stream. Partial responses are recoverable via Step
      // forward (planning doc §1.5 revision). Skipped in preview
      // mode (the preview branch returns earlier — defensive guard).
      if (!isPreview) {
        const post = readSectionState()
        if (post) pushHistorySnapshot(id, post.childrenJson)
        patchPromptBlock(id, {
          isStreaming: false,
          abortController: null,
          streamError: errored,
        })
      }
    })()
  }, [id, readSectionState, writeSectionFromHtml, patchPromptBlock, pushHistorySnapshot, pushPromptHistory])

  const handleCancel = useCallback(() => {
    if (!id) return
    const ctl = useSectionPromptBlocksStore.getState().blocks[id]?.abortController
    if (ctl) {
      try { ctl.abort() } catch { /* ignore */ }
    }
  }, [id])

  const isStreaming = useSectionPromptBlocksStore(
    (s) => !!s.blocks[id]?.isStreaming,
  )

  return (
    <NodeViewWrapper
      as="div"
      data-nn-section="true"
      data-id={id || undefined}
      data-name={name || undefined}
      data-streaming={isStreaming ? 'true' : undefined}
      className={`nn-section${isStreaming ? ' nn-section-streaming' : ''}`}
      data-help-region="editor-section:block"
    >
      {/* Row 1: name bar + drag handle. Drag handle's `data-drag-handle`
          attribute is the wire ProseMirror reads to grant drag, so we
          gate it on `!isStreaming` per planning doc §4.14 movement
          lockdown — while an AI response is streaming into this
          Section, all relocation vectors are disabled. */}
      <div className="nn-section-row nn-section-namebar" contentEditable={false} data-help-region="editor-section:name_bar">
        <span
          className={`nn-section-drag-handle${isStreaming ? ' nn-section-drag-handle-locked' : ''}`}
          {...(isStreaming ? {} : { 'data-drag-handle': true })}
          aria-label={isStreaming ? 'Drag disabled while AI response is streaming' : 'Drag Section'}
          title={isStreaming ? 'Drag disabled while AI response is streaming' : 'Drag to move Section'}
        >
          ⋮⋮
        </span>
        {renaming ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelRename()
              }
            }}
            className="nn-section-name-input"
            placeholder="Section name"
          />
        ) : (
          <button
            type="button"
            className="nn-section-name"
            onClick={startRename}
            title="Click to rename Section"
          >
            {displayName}
          </button>
        )}
      </div>

      {/* Row 2: Prompt Block Header — the shared PromptBlockForm
          rendered in PBH mode. Lives as a persistent row in the
          Section UI's chrome per planning doc §1.3 + §4.2 + §4.10.
          Send wiring + Section content mutation + Section History
          snapshots land in subsequent passes. */}
      <div className="nn-section-row nn-section-pbh" contentEditable={false} data-help-region="editor-section:prompt_block">
        <PromptBlockForm
          mode="pbh"
          sectionId={id}
          surfaceType="section_pbh"
          onSend={handleSend}
          onCancel={handleCancel}
          onSendPreview={(args) => {
            setPreviewPayload(null)
            setPreviewOpen(true)
            handleSend({ ...args, previewOpts: { onPreview: setPreviewPayload } })
          }}
          hostSceneId={editorSurface?.surface_type === 'scene_main' ? editorSurface?.surface_host_id : null}
        />
      </div>

      {/* Row 3: Section action toolbar. Buttons are STUBS — present
          for chrome completeness, disabled until later items wire
          each action. Tooltip notes which item wires which.
          Rename does NOT live in the toolbar — clicking the name in
          the name bar above is the rename affordance. */}
      <div className="nn-section-row nn-section-toolbar" contentEditable={false} data-help-region="editor-section:toolbar">
        {/* Step back / Step forward — Section History (Phase 2.9a
            item 8). Buttons read enabled state from the
            sectionHistoryStore via selectors; on click they pull
            the next snapshot from the store and replace just this
            Section's inner content with it (one ProseMirror
            transaction; one Ctrl+Z reverts). Snapshots get PUSHED
            into the store at AI write paths — Phase 2.9b (Apply to
            Editor Section) + Phase 2.9c (Prompt Block Header Send)
            — so until those wire `pushSnapshot`, the buttons stay
            disabled in practice. The SVG paths mirror the canvas-
            toolbar undo / redo so the affordance reads consistently
            with the canvas-level Undo / Redo. */}
        <button
          type="button"
          className="nn-section-action nn-section-action-icon"
          onClick={handleStepBack}
          disabled={!canStepBack}
          title="Step back — Section History"
          aria-label="Step back"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4 L2 7 L5 10" />
            <path d="M2 7 L9 7 A3 3 0 0 1 12 10 L12 11" />
          </svg>
        </button>
        <button
          type="button"
          className="nn-section-action nn-section-action-icon"
          onClick={handleStepForward}
          disabled={!canStepForward}
          title="Step forward — Section History"
          aria-label="Step forward"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 4 L12 7 L9 10" />
            <path d="M12 7 L5 7 A3 3 0 0 0 2 10 L2 11" />
          </svg>
        </button>
        {/* Attach to Chat — sits as the rightmost button of the
            left grouping. Gated by `useIsChatOpenOnConversation()` so
            it follows the same visibility rule as every other "add
            as context" affordance in the program: hidden when no
            chat thread is the active view inside the chat panel, so
            the writer never sees a no-op control. Stub for chrome
            shape — full wiring lands in Phase 2.9b. */}
        {chatVisible && (
          <button
            type="button"
            className="nn-section-action nn-section-action-icon"
            onClick={handleAttachToChat}
            disabled={!editorSurface}
            title={editorSurface
              ? 'Attach this Section as live context on the open chat conversation'
              : 'Attach to Chat unavailable in this editor surface'}
            aria-label="Attach to Chat"
          >
            <AttachToChatGlyph size={14} mode="add" />
          </button>
        )}

        {/* Right-aligned remove-this-Section pair: Dissolve (keeps
            contents in place, strips the wrapper) sits adjacent to
            Delete (destructive — removes wrapper AND contents). Both
            are "remove this Section" actions; grouping them telegraphs
            the choice. The marginLeft:auto on Dissolve pushes the pair
            to the right edge of the toolbar. */}
        <button
          type="button"
          className="nn-section-action"
          onClick={handleDissolve}
          style={{ marginLeft: 'auto' }}
          title="Dissolve this Section — strips the boundary, keeps the prose in place (Ctrl+Z to restore)"
        >
          Dissolve
        </button>
        {/* Delete — destructive: removes the Section AND all its
            contents in a single ProseMirror transaction. One Ctrl+Z
            restores. Distinct from Dissolve (which keeps the prose
            in place and just strips the wrapper). Reuses the
            MessageBubble trash glyph for cross-program consistency.
            Guarded by a confirm prompt (handleDelete above) because
            the button sits adjacent to Dissolve and a misclick would
            erase the writer's prose. */}
        <button
          type="button"
          className="nn-section-action nn-section-action-icon nn-section-action-destructive"
          onClick={handleDelete}
          title="Delete this Section and all of its contents (Ctrl+Z to undo)"
          aria-label="Delete Section"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5h10" />
            <path d="M6.5 4V2.5h3V4" />
            <path d="M5 4.5l.5 9h5l.5-9" />
          </svg>
        </button>
      </div>

      {/* Row 4: content area — ProseMirror mounts the children here. */}
      <NodeViewContent className="nn-section-content" data-help-region="editor-section:content" />
      {/* ToDo item 163 — Preview Message modal. Same handleSend
          dispatcher the Send button uses, run with previewOpts so
          the assembled wire payload is routed to setPreviewPayload
          instead of streamChat. Single-mode (no "Message + history"
          since PBH has no conversation thread). */}
      {previewOpen && (
        <WirePayloadPreviewModal
          surface="section-pbh"
          payload={previewPayload}
          modeToggleAvailable={false}
          onClose={() => { setPreviewOpen(false); setPreviewPayload(null) }}
        />
      )}
    </NodeViewWrapper>
  )
}
