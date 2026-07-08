/**
 * InlinePromptBlock — floating chrome wrapper for the Inline Prompt
 * Block (Phase 2.9c items 2 + 4).
 *
 * Renders the shared `PromptBlockForm` (PBH and IPB share form
 * chrome — see planning doc §4.10 shared-form architecture) inside
 * a floating React UI portaled to document.body. Singleton across
 * the editor — controlled by `useIpbStore`.
 *
 * Item 2 scope (chrome + creation entry points):
 *   - Floating chrome with explicit close (×) affordance
 *   - Drag-handle stub (functional drag lands in item 6)
 *   - Esc dismisses when not streaming (cancels stream otherwise —
 *     handled inside `PromptBlockForm`)
 *
 * Item 4 scope (this file's Send dispatch path):
 *   - `handleSend` — fires a streaming LLM request via `streamChat`,
 *     applies the response to the editor at the IPB's anchor:
 *       * cursor mode → INSERTS at the anchor pos
 *       * section mode → OVERWRITES the anchor range
 *   - Pin-follows-cursor: IPB's anchor tracks the advancing
 *     insertion-end on every flush so the chrome (positioned via
 *     `IpbAnchorDecoration`'s tracker) trails the prose being written.
 *   - Containing-Section detection: walks up from the write position
 *     to find a `section` node ancestor; if found, pre-Send AND
 *     post-Send Section History snapshots are pushed against that
 *     Section's id so the writer can step-back / step-forward the
 *     IPB write the same way they would a PBH write (planning doc
 *     §1.5 + the user's confirmation 2026-05-27).
 *   - Position mapping through intervening user transactions: while
 *     the IPB streams, the writer may still type elsewhere in the
 *     doc. Any non-AI transaction during the stream is run through
 *     `tr.mapping.map` to keep the IPB's insertion range valid.
 *   - Collapse on Send: the form patches `expanded: false` so the
 *     chrome shrinks to the collapsed-streaming visual during the
 *     stream (the actual inverted-teardrop pin lands in item 6;
 *     for now the IPB shares the PBH's collapsed-streaming bar
 *     with a streaming indicator).
 *
 * Out of scope (lands in subsequent items):
 *   - Context window slider — wires in item 5 (cursor mode only).
 *     For now the cursor-mode context window is a fixed 50/50 words.
 *   - Draggable chrome (item 6) — drag handle wiring + the
 *     inverted-teardrop streaming pin visual + the streaming
 *     movement lockdown on the chrome.
 *
 * Mounted at the App level so the portal target survives editor
 * remounts when the writer switches between editor surfaces. The
 * editor instance the IPB is scoped to is registered into the
 * module-level `_ipbEditorRef` in `ipbStore.js` by `RichTextEditor`
 * — `handleSend` reads it via `getIpbEditor()` to dispatch
 * transactions against the right editor.
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model'
import { useIpbStore, IPB_FORM_KEY, getIpbEditor } from '../../store/ipbStore'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useSectionHistoryStore } from '../../store/sectionHistoryStore'
import { streamChat } from '../../services/chatClient'
import { markdownToTiptapHtml } from '../../utils/markdownToTiptapHtml'
// Phase 2.9c item 7 — `buildSceneContextBlock` is loaded via dynamic
// import inside `handleSend` below to avoid a circular-import TDZ
// trap (sceneContextPrompt → applyToEditorSection → SectionExtension
// → SectionView → ... InlinePromptBlock chain references the editor
// extension's exports while the module is still initialising). See
// SectionView.jsx for the longer explanation.
import { tiptapHtmlToMarkdown } from '../../utils/tiptapToMarkdown'
import PromptBlockForm from './PromptBlockForm'
import WirePayloadPreviewModal from '../chat/WirePayloadPreviewModal'
import { preconfiguredMessageHistoryWireTurns } from '../../utils/preconfiguredMessageHistory'
import { computeIpbChromePos } from './IpbAnchorDecoration'

// Fallback cursor-mode context-window values for the case where the
// per-form block entry hasn't materialised yet in
// `sectionPromptBlocksStore`. The slider-adjustable per-instance
// counts (writer spec 2026-05-27) live on the block entry as
// `precedingWords` / `followingWords` and are read on Send below.
const FALLBACK_PRECEDING_WORDS = 50
const FALLBACK_FOLLOWING_WORDS = 50

// Marker used in the cursor-mode system block to tell the AI where
// its response will land. The model sees this verbatim so it can
// shape its response to fit the insertion point. Bracket characters
// chosen to be visually distinct from anything that would appear in
// natural prose (NOT angle-brackets — those collide with HTML).
const CURSOR_MARKER = '⟪HERE⟫'

export default function InlinePromptBlock() {
  const active = useIpbStore((s) => s.active)
  const chromePos = useIpbStore((s) => s.chromePos)
  const dismiss = useIpbStore((s) => s.dismiss)
  // ToDo item 163 — Preview Message state. Same handleSend dispatcher
  // routes to setPreviewPayload via previewOpts when the gear popover's
  // Preview Message entry fires. IPB is single-mode (no history).
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPayload, setPreviewPayload] = useState(null)
  // The anchor's kind ('cursor' or 'range') gates the form's
  // before/after surrounding-prose toggles. Tracked as a primitive
  // string so the selector returns a stable value (the anchor
  // object reference changes on every retarget + every flush, which
  // would re-render the form on every keystroke during streaming).
  const anchorKind = useIpbStore((s) => s.anchor?.kind || null)
  // Phase 2.9c item 7 — derive the host scene id for the Scene Context
  // toggle. The IPB was opened on some editor surface (scene main /
  // cue body / etc.); only `scene_main` surfaces have a scene id to
  // include. Other surfaces leave hostSceneId null and the toggle
  // hides.
  const ipbHostSceneId = useIpbStore((s) =>
    (s.surface_type === 'scene_main' ? (s.surface_host_id || null) : null)
  )
  // Screen pos of the IPB text cursor (cursor mode only). Driven by
  // `IpbAnchorDecoration`'s position tracker — null when the cursor
  // shouldn't render (range mode, non-textblock anchor, scrolled
  // outside the editor's visible area). Rendered as a portal'd
  // `position: fixed` div below so the cursor is OUTSIDE the editor's
  // contentEditable — fixes spell-check word splitting that the
  // earlier in-doc widget decoration caused, AND fixes the gutter
  // phantom-blank-line issue more cleanly.
  const cursorScreenPos = useIpbStore((s) => s.cursorScreenPos)

  // Form-state isStreaming for the IPB lives in
  // `sectionPromptBlocksStore` under the sentinel id. Esc semantics
  // differ based on streaming state: cancel stream when active,
  // otherwise dismiss the IPB. The cancel-on-streaming case is
  // already wired inside PromptBlockForm's own Esc listener — here
  // we only handle the dismiss case.
  const isStreaming = useSectionPromptBlocksStore(
    (s) => !!s.blocks[IPB_FORM_KEY]?.isStreaming,
  )
  const expanded = useSectionPromptBlocksStore(
    (s) => !!s.blocks[IPB_FORM_KEY]?.expanded,
  )
  // Active-drag flag — flipped by the drag handle's pointer handlers.
  // While true the chrome morphs to the pin shape so the writer can
  // see the text under the pointer; the spinning coin stays OFF
  // because no AI work is actually happening.
  const isDragging = useIpbStore((s) => s.isDragging)
  // Pin shape applies when the IPB is streaming AND the form is
  // collapsed (the inverted-teardrop / map-pin visual from planning
  // doc §4.10 — writer can click the pin to re-expand the form and
  // see the in-form Stop button without cancelling the stream), OR
  // while the writer is actively dragging the chrome (so the wide
  // form doesn't block their view of the underlying text). The two
  // sources are visually identical EXCEPT for the spinning coin —
  // streaming shows it, dragging doesn't.
  const pinShape = (isStreaming && !expanded) || isDragging
  const pinShowCoin = isStreaming && !expanded

  useEffect(() => {
    if (!active) return undefined
    function onKey(e) {
      if (e.key !== 'Escape') return
      // Don't intercept Esc while streaming — PromptBlockForm's own
      // Esc listener handles the cancel path. Dismiss is the
      // when-idle behaviour only.
      if (isStreaming) return
      e.preventDefault()
      e.stopPropagation()
      dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, isStreaming, dismiss])

  // Clear any leftover IPB form-state when dismissing so a fresh
  // open starts blank per planning doc §4.10 ("Re-opening starts
  // fresh"). Triggered when active flips false. `clearPromptBlock`
  // also aborts any in-flight abortController so dismiss-while-
  // streaming cancels the stream automatically.
  const clearPromptBlock = useSectionPromptBlocksStore((s) => s.clear)
  useEffect(() => {
    if (!active) clearPromptBlock(IPB_FORM_KEY)
  }, [active, clearPromptBlock])

  // Stable references to store actions for `handleSend` closure deps.
  const patchPromptBlock = useSectionPromptBlocksStore((s) => s.patch)
  const pushPromptHistory = useSectionPromptBlocksStore((s) => s.pushPromptHistory)
  const pushHistorySnapshot = useSectionHistoryStore((s) => s.pushSnapshot)

  const handleSend = useCallback(({ systemPromptText, mockMessages, profileId, model, message, previewOpts }) => {
    // ToDo item 163 — Preview destination. Same wire-build below
    // runs unchanged; the IIFE just routes the assembled payload to
    // `previewOpts.onPreview` instead of streamChat when set, and
    // skips persistence side effects (no anchor advance, no
    // patchPromptBlock, no Section snapshot, no writeAtCursor).
    const isPreview = !!(previewOpts && typeof previewOpts.onPreview === 'function')
    const editor = getIpbEditor()
    if (!editor) return
    const initialAnchor = useIpbStore.getState().anchor
    if (!initialAnchor) return

    const docSize = editor.state.doc.content.size

    // Resolve the initial write range from the IPB's anchor.
    //   cursor mode → empty range at the cursor pos (insertion)
    //   section mode → non-empty range covering the selection (overwrite)
    let writeFrom, writeTo
    if (initialAnchor.kind === 'cursor' && typeof initialAnchor.pos === 'number') {
      writeFrom = Math.max(0, Math.min(initialAnchor.pos, docSize))
      writeTo = writeFrom
    } else if (
      initialAnchor.kind === 'range'
      && typeof initialAnchor.from === 'number'
      && typeof initialAnchor.to === 'number'
    ) {
      writeFrom = Math.max(0, Math.min(initialAnchor.from, docSize))
      writeTo = Math.max(writeFrom, Math.min(initialAnchor.to, docSize))
    } else {
      return
    }

    // Walk up from the write position to find a containing Section
    // (if any). Used for Section History snapshots — pre-Send and
    // post-Send (planning doc §1.5 + user confirmation 2026-05-27:
    // IPB writes inside a Section push to that Section's history so
    // step-back/forward work the same as for PBH writes).
    let containingSectionId = null
    try {
      const $pos = editor.state.doc.resolve(writeFrom)
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d)
        if (node && node.type.name === 'section' && node.attrs?.id) {
          containingSectionId = node.attrs.id
          break
        }
      }
    } catch { /* stale anchor — proceed without Section history */ }

    // Snapshot the containing Section's pre-Send state (if any).
    // Skipped in preview mode (read-only — preview doesn't mutate
    // any persisted history).
    if (containingSectionId && !isPreview) {
      const sectionPos = _findSectionPosById(editor, containingSectionId)
      if (sectionPos !== null) {
        const sectionNode = editor.state.doc.nodeAt(sectionPos)
        if (sectionNode && sectionNode.type.name === 'section') {
          const childrenJson = []
          sectionNode.content.forEach((child) => { childrenJson.push(child.toJSON()) })
          pushHistorySnapshot(containingSectionId, childrenJson)
        }
      }
    }

    // Build the AI's system-context block describing what the writer
    // is targeting. Differs by anchor mode:
    //   - cursor mode: preceding and/or following word windows around
    //     the insertion point, gated by the form's
    //     `includePreceding` / `includeFollowing` toggles (writer
    //     spec 2026-05-27 — neither / one / both). The marker
    //     ⟪HERE⟫ indicates where the response will land when at
    //     least one window is included; if both are off, the system
    //     block is just a short instruction with no surrounding
    //     prose.
    //   - section mode: the selected range serialised as markdown,
    //     framed as "rewrite this". No before/after gates apply
    //     (section anchor IS the context per planning doc §4.11).
    // Surrounding-prose context blocks (Before / After toggles).
    // Cursor mode bakes them into `contextSystemBlock` with a
    // ⟪HERE⟫ marker; section mode appends them as separate system
    // messages so the model sees the framing as additional context,
    // not part of the "rewrite this passage" instruction. v0.2.9.44
    // extended Before/After to section mode (previously cursor-only).
    // Wire shape mirrors the chat composer's: ONE role:user message
    // with framing wrapped in `<context>`, the selected range (when
    // present, section-mode only) wrapped in `<selection>`, and the
    // writer's typed prompt in `<message>`. Cursor mode has no
    // `<selection>` (the framing's ⟪HERE⟫ markers are all the AI
    // needs to know where to write). System prompt rides as the
    // streamChat top-level `systemPrompt` param.
    const surroundingProseBlocks = []
    let contextSystemBlock
    let selectionMarkdown = ''  // section-mode + includeSelection only
    if (initialAnchor.kind === 'cursor') {
      const form = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
      const includePreceding = form?.includePreceding !== false
      const includeFollowing = form?.includeFollowing !== false
      const precedingCount = Math.max(0, form?.precedingWords ?? FALLBACK_PRECEDING_WORDS)
      const followingCount = Math.max(0, form?.followingWords ?? FALLBACK_FOLLOWING_WORDS)
      if (!includePreceding && !includeFollowing) {
        contextSystemBlock = [
          'You are continuing the writer\'s prose. The writer has chosen NOT',
          'to include any surrounding prose as context. Respond fresh, matching',
          'the writer\'s likely voice + style; the response will be inserted at',
          'their cursor in the editor.',
        ].join('\n')
      } else {
        const before = includePreceding
          ? editor.state.doc.textBetween(0, writeFrom, '\n', ' ')
          : ''
        const after = includeFollowing
          ? editor.state.doc.textBetween(writeFrom, docSize, '\n', ' ')
          : ''
        const beforeWords = before.trim().split(/\s+/).filter(Boolean)
        const afterWords = after.trim().split(/\s+/).filter(Boolean)
        const precedingText = includePreceding && precedingCount > 0
          ? beforeWords.slice(-precedingCount).join(' ')
          : ''
        const followingText = includeFollowing && followingCount > 0
          ? afterWords.slice(0, followingCount).join(' ')
          : ''
        let label
        let contextLine
        if (includePreceding && includeFollowing) {
          label = `The text below is the surrounding context around an insertion point marked ${CURSOR_MARKER}.`
          contextLine = `${precedingText} ${CURSOR_MARKER} ${followingText}`
        } else if (includePreceding) {
          label = `The text below is the prose immediately BEFORE the insertion point (marked ${CURSOR_MARKER} at the end). Your response continues from there.`
          contextLine = `${precedingText} ${CURSOR_MARKER}`
        } else {
          label = `The text below is the prose immediately AFTER the insertion point (marked ${CURSOR_MARKER} at the start). Your response will be inserted before it.`
          contextLine = `${CURSOR_MARKER} ${followingText}`
        }
        contextSystemBlock = [
          'You are continuing the writer\'s prose.',
          `${label} Your response will replace ${CURSOR_MARKER} in place. Match the`,
          'surrounding voice, tense, and style. Do not repeat the surrounding text',
          'in your response.',
          '',
          contextLine,
        ].join('\n')
      }
    } else {
      // Section mode. The Selection pill on the form (Phase 2.9c item
      // 7) lets the writer toggle whether the selected range's
      // existing content is shown to the AI. ON (default) frames the
      // request as "rewrite THIS passage"; OFF asks for fresh prose
      // to drop in WITHOUT showing what's there — useful for "ignore
      // what I have here and write something new in this slot".
      //
      // The Before/After toggles (v0.2.9.44 — writer spec 2026-05-28)
      // ALSO apply in section mode now (previously cursor-mode-only).
      // When on, N words from before the selected range and / or N
      // words from after it ride along as additional context blocks
      // so the model knows the surrounding voice without being asked
      // to rewrite the prose outside the selection.
      const sectionForm = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
      const includeSelection = sectionForm?.includeHostSectionContent !== false
      const includePrecedingS = sectionForm?.includePreceding !== false
      const includeFollowingS = sectionForm?.includeFollowing !== false
      const precedingCountS = Math.max(0, sectionForm?.precedingWords ?? FALLBACK_PRECEDING_WORDS)
      const followingCountS = Math.max(0, sectionForm?.followingWords ?? FALLBACK_FOLLOWING_WORDS)
      if (includeSelection) {
        const slice = editor.state.doc.slice(writeFrom, writeTo)
        const tmp = document.createElement('div')
        const serializer = DOMSerializer.fromSchema(editor.state.schema)
        tmp.appendChild(serializer.serializeFragment(slice.content))
        selectionMarkdown = tiptapHtmlToMarkdown(tmp.innerHTML) || '(empty)'
        contextSystemBlock = [
          'You are rewriting a passage of the writer\'s prose. The text inside',
          '<selection> below is the EXACT passage your response will replace, in',
          'full. Match the surrounding voice, tense, and style.',
        ].join('\n')
      } else {
        contextSystemBlock = [
          'You are writing a passage of the writer\'s prose. Your response will',
          'REPLACE a selected passage in the editor. The writer has chosen NOT',
          'to include the existing passage as context — respond fresh, matching',
          'the writer\'s likely voice + style for the broader work.',
        ].join('\n')
      }
      // Add surrounding-prose context when Before / After toggles are on.
      // Sliced from the editor's textBetween — outside the selected
      // range. N words before / N words after.
      if (includePrecedingS && precedingCountS > 0) {
        const before = editor.state.doc.textBetween(0, writeFrom, '\n', ' ')
        const beforeWords = before.trim().split(/\s+/).filter(Boolean)
        const precedingText = beforeWords.slice(-precedingCountS).join(' ')
        if (precedingText) {
          surroundingProseBlocks.push([
            `The text below is the prose immediately BEFORE the passage you're rewriting`,
            '(last ' + precedingCountS + ' words). Use it for voice / tense / continuity, but',
            'do not repeat any of it in your response.',
            '',
            precedingText,
          ].join('\n'))
        }
      }
      if (includeFollowingS && followingCountS > 0) {
        const after = editor.state.doc.textBetween(writeTo, docSize, '\n', ' ')
        const afterWords = after.trim().split(/\s+/).filter(Boolean)
        const followingText = afterWords.slice(0, followingCountS).join(' ')
        if (followingText) {
          surroundingProseBlocks.push([
            `The text below is the prose immediately AFTER the passage you're rewriting`,
            '(first ' + followingCountS + ' words). Use it for voice / tense / continuity, but',
            'do not repeat any of it in your response.',
            '',
            followingText,
          ].join('\n'))
        }
      }
    }

    // Stream session state. Form collapses while streaming so the
    // chrome shrinks to the collapsed-streaming visual (the
    // inverted-teardrop pin lands in item 6; for now the IPB shares
    // the PBH's collapsed-streaming bar via the shared form).
    const abortController = new AbortController()
    if (!isPreview) {
      patchPromptBlock(IPB_FORM_KEY, {
        isStreaming: true,
        abortController,
        streamError: null,
        expanded: false,
      })
      pushPromptHistory(IPB_FORM_KEY, message.slice(0, 80))
    }

    // Force `chromePos` into pin-shape coordinates synchronously.
    // The IpbAnchorDecoration plugin will recompute this on its own
    // when its sectionPromptBlocksStore subscriber fires, but Zustand
    // doesn't guarantee subscriber ORDER vs the InlinePromptBlock's
    // own `useSyncExternalStore` re-render trigger. Without this
    // explicit synchronous update, the first render after Send may
    // see `pinShape=true` while `chromePos` still holds the form's
    // old top-anchored value (`{ left, top: anchorBottom + 6 }`,
    // form sits BELOW the cursor). The pin then renders with that
    // stale top — placing the pin one line BELOW the IPB cursor for
    // a frame before the recompute lands the correct
    // bottom-anchored coords. Doing the recompute here ensures the
    // store already holds pin-mode coordinates by the time React
    // reads `chromePos` on the next render.
    // Preview is read-only — skip the pin-shape collapse + chromePos
    // update so the IPB form stays expanded under the writer.
    if (!isPreview) {
      try {
        const pinPos = computeIpbChromePos(editor.view, initialAnchor, { pinShape: true })
        if (pinPos) useIpbStore.getState().setChromePos(pinPos)
      } catch { /* defensive — fall back to the subscriber's recompute */ }
    }

    // `wireMessages` is assembled below inside the async IIFE, AFTER
    // the pinned + scene-context block resolves. Declared here as a
    // placeholder so subsequent code can append/replace without TDZ.
    // Pieces feeding into the eventual single role:user message:
    //   - contextSystemBlock   (instructional framing)
    //   - surroundingProseBlocks (Before / After prose, section mode)
    //   - combinedBlock         (pinned + scene context, async)
    //   - selectionMarkdown     (section-mode + includeSelection only)
    //   - message               (writer's typed prompt)
    let wireMessages = []
    // Manually-attached context items + Scene Context toggle (Phase
    // 2.9c item 7). Read live from the IPB's per-block form state.
    // Async-resolved + spliced in below right before streamChat fires
    // so the LLM sees these context blocks FIRST, then the
    // cursor/section context block.
    const ipbBlockState = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
    const pinned = ipbBlockState?.pinnedContextItems || []
    const sceneContextEnabled = !!ipbBlockState?.sceneContextEnabled
    const ipbSceneId = useIpbStore.getState().surface_type === 'scene_main'
      ? (useIpbStore.getState().surface_host_id || null)
      : null

    // Mutable position trackers — mapped through any intervening
    // non-AI transactions via the listener below. Without this
    // mapping, a single keystroke by the writer elsewhere in the doc
    // during the stream would shift the IPB's insertion range and
    // every subsequent flush would target the wrong position.
    let currentFrom = writeFrom
    let currentEnd = writeTo
    const trListener = ({ transaction }) => {
      try {
        if (!transaction || !transaction.docChanged) return
        if (transaction.getMeta('aiWrite')) return // our own writes — manual update below
        currentFrom = transaction.mapping.map(currentFrom)
        currentEnd = transaction.mapping.map(currentEnd)
      } catch { /* ignore mapping errors — flushWrite re-clamps */ }
    }
    if (!isPreview) editor.on('transaction', trListener)

    // Streaming delta accumulator + 100ms throttled flush. Matches
    // the PBH's SectionView.handleSend cadence.
    let accum = ''
    let lastWriteAt = 0
    let pendingWrite = null
    // v0.2.9.45 — track the last `accum` value that landed in the
    // editor via a successful flush. Without this guard, the
    // trailing `if (accum) flushWrite()` after the for-await loop
    // exits double-flushes the same content (because evt.type 'end'
    // already flushed). Re-applying the same slice with open ends
    // at the now-modified range can produce unexpected merges with
    // surrounding content — the symptom reported was character-
    // scrambled gibberish appended to the doc after a clean rewrite.
    let lastFlushedAccum = null
    const THROTTLE_MS = 100

    const flushWrite = () => {
      lastWriteAt = Date.now()
      pendingWrite = null
      // Skip when nothing new has accumulated since the last flush —
      // re-running tr.replace with the same slice on the same range
      // is meant to be idempotent but ProseMirror's open-end merge
      // semantics make that a "usually fine, sometimes not" promise.
      // Safer to short-circuit.
      if (accum === lastFlushedAccum) return
      try {
        const html = markdownToTiptapHtml(accum) || ''
        const tmp = document.createElement('div')
        tmp.innerHTML = html
        const parser = PMDOMParser.fromSchema(editor.state.schema)
        // Default whitespace handling — inter-block newlines from
        // `innerHTML` collapse away. `preserveWhitespace: 'full'` would
        // wrap them as extra blank paragraphs in the slice (see PBH's
        // matching note in SectionView.jsx). Default is right for prose.
        const slice = parser.parseSlice(tmp)
        // Clamp positions against live doc — defensive in case the
        // doc shrunk while we were off-CPU.
        const ds = editor.state.doc.content.size
        const safeFrom = Math.max(0, Math.min(currentFrom, ds))
        const safeEnd = Math.max(safeFrom, Math.min(currentEnd, ds))
        // Use `tr.replace(from, to, slice)` with the slice's OWN
        // open ends rather than `tr.replaceWith(from, to, fragment)`
        // (which treats the content as closed). `parser.parseSlice`
        // returns a slice with `openStart` / `openEnd` set via
        // `Slice.maxOpen`, so the parsed paragraph block is "open"
        // on both ends. With `replace`, those open ends MERGE the
        // slice's paragraph into the surrounding paragraph at the
        // cursor — exactly what we want for cursor-mode insert.
        //
        // The earlier `replaceWith(safeFrom, safeEnd, slice.content)`
        // version treated the parsed paragraph as a closed block.
        // When the IPB cursor sat at the start of an empty paragraph
        // at end-of-doc, ProseMirror had to "lift" the new closed
        // paragraph out to the doc level (since `<p>` can't contain
        // `<p>`), inserting it BEFORE the empty paragraph. The cursor
        // anchor at `safeFrom + content.size` then landed inside the
        // still-present empty paragraph one line below the inserted
        // text — visually "stuck on the blank line" as the user
        // reported, with subsequent deltas continuing to lift and
        // shift, never tracking the writing point.
        const oldDocSize = editor.state.doc.content.size
        const tr = editor.state.tr
          .replace(safeFrom, safeEnd, slice)
          .setMeta('aiWrite', true)
        editor.view.dispatch(tr)
        // Record what we just wrote so the next flush short-circuits
        // if accum hasn't changed (see double-flush guard above).
        lastFlushedAccum = accum
        currentFrom = safeFrom
        // **Compute currentEnd from the actual doc-size delta**, not
        // from `slice.size`. `slice.size = content.size - openStart -
        // openEnd` ASSUMES the open ends fully merge with surrounding
        // content — but when safeFrom / safeEnd sit at a block
        // boundary (no paragraph to merge into on that side), the
        // open end can't fully collapse and the actual inserted
        // character count exceeds `slice.size`. Using `slice.size`
        // then leaves currentEnd SHORT of the real insertion end;
        // the next flush replaces a smaller range than the previous
        // one wrote, orphaning the tail in the doc as gibberish past
        // the AI's content. Fixed v0.2.9.45 by measuring the doc-size
        // delta after dispatch: chars-added = newDocSize - oldDocSize
        // + chars-removed; new end = safeFrom + chars-added.
        const newDocSize = editor.state.doc.content.size
        const charsRemoved = safeEnd - safeFrom
        const charsAdded = newDocSize - oldDocSize + charsRemoved
        currentEnd = safeFrom + charsAdded
        // Pin-follows-cursor: update the IPB's anchor to the new
        // insertion-end so `IpbAnchorDecoration`'s position tracker
        // reflows the chrome to trail the prose being written
        // (planning doc §4.10 "pin follows the insertion-point
        // cursor during streaming").
        if (useIpbStore.getState().active) {
          useIpbStore.getState().setAnchor({ kind: 'cursor', pos: currentEnd })
        }
      } catch { /* swallow per-delta render errors — the next delta will retry */ }
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
      // Resolve the pinned-context block (if any) before streamChat
      // fires. Same one-shot render the PBH uses. No-op when there
      // are no pins. Render failures are non-fatal — the send
      // proceeds without the pinned block rather than aborting.
      // Resolve the pinned + scene-context block (if any) BEFORE we
      // assemble the final wire message.
      let combinedBlock = ''
      try {
        const hasPinned = pinned.length > 0
        const hasSceneContext = sceneContextEnabled && ipbSceneId
        if (hasPinned || hasSceneContext) {
          const mod = await import('../../utils/sceneContextPrompt')
          combinedBlock = await mod.buildSceneContextBlock({
            pinnedItems: hasPinned ? pinned : [],
            sceneId: hasSceneContext ? ipbSceneId : null,
            // Pass structural host scene unconditionally so dynamic
            // pins (e.g. current_scene_body) resolve even when the
            // writer has the Scene Context toggle off.
            hostSceneId: ipbSceneId,
          }) || ''
        }
      } catch { /* swallow — proceed without the extra blocks */ }

      // Assemble single role:user wire message. <context> carries
      // every piece of framing (instructional block, surrounding
      // prose, pinned + scene). <selection> carries the section-
      // mode selected range when included. <message> carries the
      // writer's typed prompt. Each wrapper omits when empty.
      const contextParts = []
      if (combinedBlock) contextParts.push(combinedBlock)
      if (contextSystemBlock) contextParts.push(contextSystemBlock)
      for (const p of surroundingProseBlocks) contextParts.push(p)
      const contextWrap = contextParts.length > 0
        ? `<context>\n${contextParts.join('\n\n')}\n</context>`
        : ''
      const selectionWrap = selectionMarkdown
        ? `<selection>\n${selectionMarkdown}\n</selection>`
        : ''
      const messageWrap = `<message>\n${message}\n</message>`
      const userContent = [contextWrap, selectionWrap, messageWrap]
        .filter(Boolean)
        .join('\n\n')
      // Splice Pre-Configured Message History (`SystemPrompt.mock_messages`)
      // at the front of the messages array — before the writer's
      // single tagged user message. PCMH always rides in full;
      // IPB has no rolling-window concept, so no cap interaction.
      const pcmhWireTurns = preconfiguredMessageHistoryWireTurns({ mock_messages: mockMessages })
      wireMessages = [
        ...pcmhWireTurns,
        { role: 'user', content: userContent },
      ]
      // ToDo item 163 — Preview destination. Same wire-build code
      // above ran. Hand the assembled payload to the preview
      // callback and bail — no streamChat dispatch, no writes to
      // the editor, no post-send persistence.
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
      // Final flush — ensures the trailing buffer lands before the
      // post-snapshot reads the doc.
      if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null }
      if (accum) flushWrite()

      editor.off('transaction', trListener)

      // Post-Send Section History snapshot — captures the Section's
      // state AFTER the AI's writes landed, even when cancelled mid-
      // stream (partial output is recoverable via Step forward per
      // §1.5 revision). Re-resolve the Section's position because
      // intervening transactions may have shifted it.
      if (containingSectionId) {
        const postPos = _findSectionPosById(editor, containingSectionId)
        if (postPos !== null) {
          const postNode = editor.state.doc.nodeAt(postPos)
          if (postNode && postNode.type.name === 'section') {
            const childrenJson = []
            postNode.content.forEach((c) => { childrenJson.push(c.toJSON()) })
            pushHistorySnapshot(containingSectionId, childrenJson)
          }
        }
      }

      // Final IPB state — only patch if the IPB is still active.
      // Dismiss-while-streaming clears the form state via
      // clearPromptBlock (which also aborts); patching after that
      // would resurrect a stale entry.
      if (useIpbStore.getState().active) {
        // Final anchor lands at the end of the inserted text (per
        // user spec 2026-05-27: "Moves to end of inserted text").
        useIpbStore.getState().setAnchor({ kind: 'cursor', pos: currentEnd })
        patchPromptBlock(IPB_FORM_KEY, {
          isStreaming: false,
          abortController: null,
          streamError: errored,
        })
      }
    })()
  }, [patchPromptBlock, pushPromptHistory, pushHistorySnapshot])

  const handleCancel = useCallback(() => {
    try {
      const ctl = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]?.abortController
      if (ctl) ctl.abort()
    } catch { /* ignore */ }
  }, [])

  if (!active) return null

  // IPB text cursor — portal'd `position: fixed` div anchored to
  // the cursor's screen position (computed by `IpbAnchorDecoration`
  // and pushed to `ipbStore.cursorScreenPos`). Rendered OUTSIDE the
  // editor's contentEditable so the browser's spell checker doesn't
  // see it (the earlier in-doc widget decoration split words at the
  // cursor, red-squiggling correctly-spelled prose). Same visual as
  // before — 2px story-accent vertical bar with a slow blink.
  // Rendered alongside the chrome (or pin) below.
  // v0.2.9.45 — render the floating cursor only when its coords
  // are inside the editor's scroll-container visible area. The
  // position itself is kept in the store even when off-screen (so
  // the sticky-scroll subsystem in IpbAnchorDecoration can still
  // chase the anchor during fast streaming), but rendering an
  // off-screen cursor would float a blinking bar over whatever
  // happens to sit below the editor in the viewport.
  const cursorPortal = (cursorScreenPos && cursorScreenPos.visible !== false) ? createPortal(
    <div
      className="nn-ipb-anchor-cursor-floating"
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: cursorScreenPos.left,
        top: cursorScreenPos.top,
        height: cursorScreenPos.height,
      }}
    />,
    document.body,
  ) : null

  // Pin shape — the IPB's collapsed-streaming visual (inverted-
  // teardrop / map-pin) from planning doc §4.10. Replaces the
  // normal chrome+form when the IPB is streaming AND collapsed.
  // The pin's tip points at the IPB anchor (positioning handled by
  // `computeIpbChromePos` with `pinShape: true`), the spinning-coin
  // sits in the head, and clicking the pin re-expands the form
  // (writer can review prompt + use Stop without cancelling
  // implicitly). The pin does NOT have an explicit dismiss button —
  // dismiss-while-streaming is suppressed per planning doc.
  if (pinShape) {
    return (
      <>
        {cursorPortal}
        {createPortal(
          <InlinePromptBlockPin chromePos={chromePos} showCoin={pinShowCoin} />,
          document.body,
        )}
      </>
    )
  }

  // Position fallback when no chromePos is set (defensive). The
  // `chromePos` may be either top-anchored (`{ left, top }`) for the
  // cursor-mode-below case, or bottom-anchored (`{ left, bottom }`)
  // for range-mode-above and cursor-mode-flipped cases. Bottom-
  // anchored values are distances from the VIEWPORT BOTTOM, so the
  // chrome's BOTTOM edge sits at the anchor's top; the chrome grows
  // UPWARD when expanded, never covering the selected text below.
  const positionStyle = (() => {
    // ALWAYS include both `top` and `bottom`, with the unused one
    // set to `'auto'` so React explicitly clears any value left over
    // from a prior render. Without this, switching from top-anchored
    // to bottom-anchored (or vice versa) can leave the previous
    // value pinned in the DOM style, which would cause the chrome
    // to render in the wrong vertical position.
    if (!chromePos) {
      return { left: 100, top: 100, bottom: 'auto' }
    }
    const left = chromePos.left ?? 100
    if (typeof chromePos.bottom === 'number') {
      return { left, top: 'auto', bottom: chromePos.bottom }
    }
    return { left, top: chromePos.top ?? 100, bottom: 'auto' }
  })()

  return (<>
    {cursorPortal}
    {createPortal(
    <div
      className="nn-ipb"
      style={{ ...positionStyle, position: 'fixed' }}
      role="dialog"
      aria-label="Inline Prompt Block"
      data-help-region="inline-prompt-block:chrome"
    >
      <div className="nn-ipb-chrome-row">
        <span
          className="nn-ipb-drag-handle"
          title="Drag to move the IPB text cursor (the chrome follows automatically)"
          aria-label="Drag Inline Prompt Block"
          data-help-region="inline-prompt-block:drag_handle"
          onPointerDown={(e) => {
            // Drag handle = continuous cursor-mode retarget. The
            // pointer's doc position becomes the new IPB anchor (and
            // therefore the new chrome position via the auto-follow
            // tracker). Mirrors Ctrl+click in semantics but without
            // the modifier key — the writer can just grab the handle
            // and drag the IPB text cursor around the editor.
            //
            // Section drag handle moves the SECTION through the
            // doc (ProseMirror transaction); IPB drag handle moves
            // the IPB TEXT CURSOR (anchor retarget). Symmetric in
            // spirit, different mechanism.
            //
            // While dragging, the chrome morphs into the pin shape
            // (no spinning coin — that's reserved for actual AI
            // streaming) so the wide form doesn't block the writer's
            // view of the text under the pointer. The pin remounts
            // in place of the form's React tree, which is why
            // `setPointerCapture` is NOT used here — captured pointer
            // routing is on a specific element, and our drag handle
            // unmounts when the chrome morphs. Window-bound listeners
            // survive the morph cleanly and fire on every pointer
            // move regardless of what element is under the cursor.
            const editor = getIpbEditor()
            if (!editor) return
            e.preventDefault()
            useIpbStore.getState().setIsDragging(true)

            const onMove = (ev) => {
              const posInfo = editor.view.posAtCoords({ left: ev.clientX, top: ev.clientY })
              if (!posInfo) return
              const docSize = editor.state.doc.content.size
              const pos = Math.max(0, Math.min(posInfo.pos, docSize))
              // Skip gutter / non-textblock positions. When the
              // pointer sweeps between paragraphs, `posAtCoords`
              // briefly returns the position AT the boundary (the
              // start of the next block, left≈0). Using that pos
              // (a) hides the cursor widget (no textblock parent so
              // the `_buildDecorations` guard skips the widget) and
              // (b) makes the chrome tracker compute coords at
              // left≈0 (the next paragraph's leading-edge x),
              // jumping the chrome to the left side of the editor
              // for a frame. Holding the last-good anchor while the
              // pointer is in a gutter keeps the visual stable —
              // the chrome and cursor stay where they were until
              // the pointer reaches the next textblock.
              try {
                if (!editor.state.doc.resolve(pos).parent?.isTextblock) return
              } catch { return }
              const current = useIpbStore.getState().anchor
              if (current && current.kind === 'cursor' && current.pos === pos) return
              useIpbStore.getState().setAnchor({ kind: 'cursor', pos })
            }
            const onUp = () => {
              useIpbStore.getState().setIsDragging(false)
              window.removeEventListener('pointermove', onMove)
              window.removeEventListener('pointerup', onUp)
              window.removeEventListener('pointercancel', onUp)
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
            window.addEventListener('pointercancel', onUp)
          }}
        >
          ⋮⋮
        </span>
        <span className="nn-ipb-chrome-spacer" />
        <button
          type="button"
          className="nn-ipb-close-btn"
          onClick={dismiss}
          disabled={isStreaming}
          data-help-region="inline-prompt-block:dismiss"
          title={isStreaming
            ? 'Stop the stream first (Esc / the in-form Stop button) before dismissing the Inline Prompt Block.'
            : 'Dismiss the Inline Prompt Block (Esc)'}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <PromptBlockForm
        mode="ipb"
        sectionId={IPB_FORM_KEY}
        surfaceType="ipb"
        onSend={handleSend}
        onCancel={handleCancel}
        onSendPreview={(args) => {
          setPreviewPayload(null)
          setPreviewOpen(true)
          handleSend({ ...args, previewOpts: { onPreview: setPreviewPayload } })
        }}
        anchorKind={anchorKind}
        hostSceneId={ipbHostSceneId}
      />
    </div>,
    document.body,
  )}
  {previewOpen && (
    <WirePayloadPreviewModal
      surface="ipb"
      payload={previewPayload}
      modeToggleAvailable={false}
      onClose={() => { setPreviewOpen(false); setPreviewPayload(null) }}
    />
  )}
  </>)
}

// Collapsed-streaming pin (planning doc §4.10 "inverted-teardrop /
// location-pin pill with the chat panel's spinning-coin animation").
// Rendered in place of the normal chrome+form when the IPB is
// streaming AND collapsed. The pin's TIP points at the IPB anchor
// in the editor (positioning is computed by `IpbAnchorDecoration`'s
// `computeIpbChromePos` with `pinShape: true` — bottom-anchored
// with no gap, centered horizontally on the anchor). The spinning-
// coin sits in the head and reuses the existing `.nn-streaming-coin`
// styles + SVG from `MessageBubble.jsx` (chat-bubble streaming
// indicator) for cross-program consistency.
//
// Click handler re-expands the form so the writer can review their
// prompt / hit the in-form Stop button without the stream cancelling.
// Esc still cancels the stream (handled inside PromptBlockForm).
function InlinePromptBlockPin({ chromePos, showCoin = true }) {
  const patch = useSectionPromptBlocksStore((s) => s.patch)
  const handleExpand = useCallback(() => {
    patch(IPB_FORM_KEY, { expanded: true })
  }, [patch])

  // Pin position style — `chromePos` from `computeIpbChromePos` with
  // `pinShape: true` is ALWAYS bottom-anchored (pin's tip-edge sits
  // at the anchor's top). A top-anchored chromePos means the value
  // is stale from the form's last render (e.g., the very first
  // frame after Send, before the position recompute lands). Render
  // off-screen on stale values so the pin doesn't flash at the
  // form's old position one line BELOW the cursor.
  const positionStyle = (() => {
    if (!chromePos) return { left: -9999, top: -9999, bottom: 'auto' }
    if (typeof chromePos.bottom !== 'number') {
      return { left: -9999, top: -9999, bottom: 'auto' }
    }
    const left = chromePos.left ?? -9999
    return { left, top: 'auto', bottom: chromePos.bottom }
  })()

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={showCoin ? handleExpand : undefined}
      className="nn-ipb-streaming-pin"
      data-help-region="inline-prompt-block:streaming_pin"
      title={showCoin
        ? 'AI is writing. Click to expand the prompt. Esc cancels the stream.'
        : 'Repositioning the Inline Prompt Block.'}
      aria-label={showCoin
        ? 'AI prompt streaming. Click to expand.'
        : 'Repositioning the Inline Prompt Block.'}
      style={{ ...positionStyle, position: 'fixed' }}
    >
      {/* Pin silhouette as a single SVG path so the fill (zinc-900)
          and stroke (story accent) work together as one shape. The
          path data MUST stay in lockstep with PIN_WIDTH / PIN_HEIGHT
          in `computeIpbChromePos` (26 × 36) so the pin's bottom-edge
          tip lands exactly at the IPB anchor's top.
          Path geometry — tangent teardrop:
            - tip at (13, 36) — pin's bottom-center
            - circle center (13, 12), radius 10
            - tangent points where the tail lines TOUCH the circle
              smoothly (no kink): (22.1, 16.2) and (3.9, 16.2). These
              come from the tangent-from-external-point formula —
              `sin θ = r / d` where d = 24 (tip-to-center distance),
              r = 10, so θ ≈ 24.62°; tangent points = center + r ×
              (cos θ, sin θ). Earlier rev used base endpoints (19, 20)
              and (7, 20) which sat INSIDE the circle, creating an
              "ice-cream cone" seam where the tail's straight lines
              broke into the head's arc.
            - arc connecting the tangent points over the top of the
              head, radius 10, large-arc + counterclockwise so the
              arc curves UP and over. */}
      <svg
        className="nn-ipb-streaming-pin-shape"
        viewBox="0 0 26 36"
        width="26"
        height="36"
        aria-hidden="true"
      >
        <path
          d="M 13 36 L 22.1 16.2 A 10 10 0 1 0 3.9 16.2 Z"
          fill="#18181b"
          stroke="var(--color-accent-500, #a78bfa)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      {/* Spinning coin overlaid on the head's center (head center
          in SVG coords ≈ (13, 12); the container below covers the
          head's bounding box and centers the coin inside). Coin
          color in the accent palette so it reads as "the IPB is
          working" with the same hue as the pin border. The coin is
          ONLY shown during actual AI streaming — when the pin is
          rendered for drag-positioning instead, the coin stays
          hidden so the writer doesn't misread it as an active
          response. */}
      {showCoin && (
        <span className="nn-ipb-streaming-pin-coin" aria-hidden="true">
          <span className="nn-streaming-coin">
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
        </span>
      )}
    </button>
  )
}

// Resolve the document position of a Section by its stable id. Used
// by Section History snapshot capture so intervening transactions
// (e.g. typing earlier in the doc during the IPB stream) don't break
// the pre-Send / post-Send pairing.
function _findSectionPosById(editor, id) {
  if (!editor || !id) return null
  let found = null
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.type.name === 'section' && node.attrs?.id === id) {
      found = pos
      return false
    }
    return true
  })
  return found
}
