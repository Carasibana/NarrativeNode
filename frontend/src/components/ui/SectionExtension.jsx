/**
 * Section — TipTap wrapper-node extension (Phase 2.9a item 1)
 *
 * Custom block-level wrapper node for the AI-assisted prose authoring
 * Section primitive. Modelled on the same pattern as TipTap's
 * blockquote — wraps `block+` children with a meaningful boundary,
 * carries `defining` so content swaps preserve the wrapper, and
 * carries `isolating` so paste-merge can't bleed across the
 * boundary.
 *
 * Per-Section state lives on the node's `attrs`:
 *   - `id`    — stable per-Section UUID for sidecar joins (Section
 *                History, Prompt Block Header binding, etc.).
 *   - `name`  — writer-editable label rendered in the Section's
 *                name bar (Section (N) by default; renamable inline
 *                via the Section UI added in Phase 2.9a item 2).
 *
 * This file is the SCHEMA-level extension only. The visual chrome
 * — what we call the **Section UI** (name bar + drag handle +
 * persistent toolbar + bordered content area), built using TipTap's
 * NodeView API — is layered in item 2. We use the in-doc name
 * "Section UI" for the chrome itself and always qualify TipTap's
 * own term as "TipTap's NodeView" so we don't collide with the
 * React Flow canvas Nodes (SceneNode / EntityNode / etc.) that
 * already populate the program. For now, an unwrapped Section
 * renders as a plain bordered div in the DOM (ProseMirror default
 * rendering of `renderHTML`).
 *
 * HTML round-trip uses `<div data-nn-section="true">` — a neutral
 * wrapper that older builds parse as a plain block container, so
 * Section-containing docs degrade gracefully when loaded by code
 * that doesn't have this extension registered.
 *
 * Nesting / overlap invariants (Phase 2.9a item 5) are NOT enforced
 * here at the schema level — `content: 'block+'` allows any block
 * child, which technically includes another `section`. The
 * Create-Section command (item 3) enforces the rejection at write
 * time; this keeps the schema permissive enough that legacy or
 * out-of-spec input can still load without TipTap throwing.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import { ReactNodeViewRenderer } from '@tiptap/react'
import SectionView from './SectionView'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'

/**
 * Recursively strip `section` wrappers out of a ProseMirror Fragment,
 * replacing each one with its inner content. Used by the
 * `transformPasted` plugin below — Sections are NEVER created via
 * paste / drop / clipboard. The only legitimate creation paths are
 * the toolbar / right-click chooser (Phase 2.9a item 3) and any
 * future programmatic path inside the app (e.g. AI-driven section
 * boundary proposals, out of scope for now).
 */
function stripSectionWrappers(fragment) {
  const out = []
  fragment.forEach((child) => {
    if (child.type.name === 'section') {
      stripSectionWrappers(child.content).forEach((c) => out.push(c))
    } else {
      const newContent = stripSectionWrappers(child.content)
      out.push(child.copy(newContent))
    }
  })
  return Fragment.from(out)
}

/**
 * Walk a ProseMirror Fragment and replace the `id` on every section
 * node with a freshly-minted UUID. Used by `handleDrop` on the
 * copy-drag path (moved=false) so the copied Section enters the
 * doc with a unique id from the start — never as a duplicate of
 * the source. Once a Section has an id, that id MUST be stable
 * (downstream features key off it: Section History, Prompt Block
 * Header binding, Attach to Chat pins, etc.) so we re-id at the
 * point of duplication, never after the fact.
 */
function regenerateSectionIds(fragment) {
  const out = []
  fragment.forEach((child) => {
    if (child.type.name === 'section') {
      const newContent = regenerateSectionIds(child.content)
      const newAttrs = { ...child.attrs, id: newSectionId() }
      out.push(child.type.create(newAttrs, newContent, child.marks))
    } else {
      const newContent = regenerateSectionIds(child.content)
      out.push(child.copy(newContent))
    }
  })
  return Fragment.from(out)
}

/**
 * Generate a stable per-Section UUID. Prefers the platform's
 * `crypto.randomUUID()`; falls back to a randomish string for
 * environments where it's unavailable (older test runners, etc.).
 */
export function newSectionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'sec-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Create a new Section in the editor. Shared entry point used by
 * both the editor toolbar's "Insert Section" button and the
 * right-click chooser's Section action.
 *
 * Behaviour:
 *   - If the writer has a non-empty selection → wrap the selection
 *     in a new Section (one transaction; Ctrl+Z restores).
 *   - If the writer's cursor is INSIDE an existing Section (no
 *     selection) → insert the new Section immediately AFTER the
 *     containing Section (no-nesting rule kicks in cleanly).
 *   - Otherwise (just a caret outside any Section) → insert a fresh
 *     empty Section at the cursor position.
 *
 * The new Section's name comes from `computeNextSectionName(editor)`
 * — "Untitled Section (N)" with N taken from the highest existing
 * pattern-matching N + 1.
 */
export function createSection(editor) {
  if (!editor) return
  const name = computeNextSectionName(editor)
  const hasSelection = !editor.state.selection.empty
  if (hasSelection) {
    editor.chain().focus().wrapInSection({ name }).run()
    return
  }
  const newSection = {
    type: 'section',
    attrs: { id: newSectionId(), name },
    content: [{ type: 'paragraph' }],
  }
  const { from } = editor.state.selection
  const $from = editor.state.doc.resolve(from)
  let afterSectionPos = null
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'section') {
      afterSectionPos = $from.after(depth)
      break
    }
  }
  if (afterSectionPos !== null) {
    editor.chain().focus().insertContentAt(afterSectionPos, newSection).run()
  } else {
    editor.chain().focus().insertContent(newSection).run()
  }
}

/**
 * Compute the default name for a new Section in the given editor.
 *
 * Scans the editor doc for existing `section` nodes, parses any
 * name matching `Section (N)` to extract N, and returns
 * `Section (max+1)` — or `Section (1)` when no matching names
 * exist. Sections renamed away from the `Section (N)` pattern
 * (writer-titled "Brawl", or back to the legacy `Untitled Section
 * (N)` pattern) do NOT contribute to N — so:
 *
 *   - Section (1) + Section (2), delete Section (1) → next is
 *     Section (3) (continues from most recent, no duplicate).
 *   - All Sections deleted → next is Section (1) (fresh start).
 *   - Section (1) renamed to "Brawl" + Section (2) → next is
 *     Section (3) (most-recent N from pattern-matching names is 2).
 *
 * Legacy "Untitled Section (N)" names from older saves are also
 * scanned so that re-opening a pre-rename project plus adding a
 * new Section produces a clean sequence rather than colliding
 * with the legacy numbering. The N spaces share between both
 * patterns — if a save has `Untitled Section (2)`, the next new
 * Section is `Section (3)`.
 */
export function computeNextSectionName(editor) {
  if (!editor || !editor.state) return 'Section (1)'
  let maxN = 0
  editor.state.doc.descendants((node) => {
    if (node.type && node.type.name === 'section') {
      const name = node.attrs.name || ''
      const m = name.match(/^Section\s*\((\d+)\)\s*$/)
        || name.match(/^Untitled Section\s*\((\d+)\)\s*$/)
      if (m) {
        const n = parseInt(m[1], 10)
        if (!Number.isNaN(n) && n > maxN) maxN = n
      }
    }
    return true
  })
  return `Section (${maxN + 1})`
}

export const SectionExtension = Node.create({
  name: 'section',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  // Enables ProseMirror's drag/drop for the Section. The Section UI
  // NodeView renders a `data-drag-handle` element that ProseMirror
  // picks up as the drag affordance.
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id') || null,
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-name') || '',
        renderHTML: (attrs) => (attrs.name ? { 'data-name': attrs.name } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-nn-section]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(
        { 'data-nn-section': 'true', class: 'nn-section' },
        HTMLAttributes,
      ),
      0,
    ]
  },

  addCommands() {
    return {
      // Wrap the current block selection in a Section, minting a
      // fresh id when one isn't supplied. Falls back to TipTap's
      // built-in `wrapIn` which handles the selection-vs-empty
      // cases — if there's nothing wrappable at the current
      // position, the command no-ops cleanly and returns false.
      wrapInSection:
        (attrs = {}) =>
        ({ commands }) => {
          const id = attrs.id || newSectionId()
          const name = attrs.name || ''
          return commands.wrapIn(this.name, { id, name })
        },

      // Dissolve — replace the Section wrapper with its content in
      // a single ProseMirror transaction. Inverse of
      // `wrapInSection`; a single Ctrl+Z restores the wrap.
      //
      // NOTE: cannot use `commands.lift(this.name)` here. ProseMirror's
      // standard `lift` is silently blocked by the section's
      // `isolating: true` flag (the flag exists to prevent edits like
      // backspacing across the boundary; lift counts as such an edit
      // and is rejected). Instead we build the transaction explicitly:
      // find the section node at the selection's containing depth,
      // then replace its [pos, pos + nodeSize] range with its
      // content fragment so the children land in the parent context.
      //
      // The `defining: true` + `isolating: true` flags on the section
      // stay in place — they protect against ACCIDENTAL merging /
      // backspacing across boundaries. This explicit dissolve is a
      // deliberate writer action, not an accidental edit, so the
      // protections don't apply.
      liftSection:
        () =>
        ({ state, dispatch, tr }) => {
          // Walk up from the selection to find the containing section.
          const $from = state.selection.$from
          let sectionPos = -1
          let sectionNode = null
          for (let d = $from.depth; d >= 0; d--) {
            const node = $from.node(d)
            if (node.type.name === this.name) {
              sectionPos = $from.before(d)
              sectionNode = node
              break
            }
          }
          if (sectionPos < 0 || !sectionNode) return false
          if (dispatch) {
            dispatch(tr.replaceWith(
              sectionPos,
              sectionPos + sectionNode.nodeSize,
              sectionNode.content,
            ).scrollIntoView())
          }
          return true
        },
    }
  },

  // The Section UI — name bar / drag handle / Prompt Block Header
  // placeholder / Section action toolbar / content area — rendered
  // via TipTap's NodeView API. See `SectionView.jsx` for the chrome
  // layout; `data-drag-handle` in the wrapper picks up ProseMirror's
  // drag/drop because `draggable: true` is set above.
  addNodeView() {
    return ReactNodeViewRenderer(SectionView)
  },

  // Sections never come in via clipboard paste. Whole-Section drags
  // get different treatment — the wrapper survives, and the drop
  // is redirected if it would land inside another Section.
  //
  // **Hook order matters.** Per ProseMirror 1.x (`prosemirror-view`
  // 1.40+), the drop dispatcher runs `transformPasted` FIRST and
  // then `handleDrop`. So a `transformPasted` that strips Section
  // wrappers would mutate the slice before `handleDrop` ever sees
  // a Section — making any drag-relocation logic in `handleDrop`
  // impossible. To avoid that ordering trap, we don't use
  // `transformPasted` at all; instead we use the hook-pair below:
  //
  // (1) `handleDrop` — sees the raw slice. Drops whose slice has
  //     a `section` at top level (typical of a whole-Section drag
  //     by its drag handle) are intercepted. If the drop position
  //     lands inside another Section, the insertion is redirected
  //     to the position immediately AFTER the containing Section
  //     (sibling, not nested). For `moved` drops (intra-editor
  //     drag) the source is deleted in the same transaction.
  //     Returns `true` so the default drop logic is skipped.
  //
  // (2) `handlePaste` — sees the raw slice. Strips every Section
  //     wrapper (recursively) and dispatches the stripped slice
  //     via `replaceSelection`. So copying text out of a Section
  //     and pasting it anywhere yields plain prose — no new
  //     Section ever comes from a clipboard paste. Returns `true`
  //     so the default paste logic is skipped.
  //
  // (3) `appendTransaction` — backstop. Anything that slips through
  //     (e.g. a future programmatic insertion path that bypasses
  //     the chooser) and lands a Section inside another Section
  //     is detected after the fact and unwrapped. Runs iteratively
  //     — ProseMirror re-invokes `appendTransaction` after applying
  //     the returned tr — so deeply-nested cases flatten one level
  //     per pass.
  //
  // Sections can only be created via the toolbar / right-click
  // chooser (Phase 2.9a item 3) and `wrapInSection` /
  // `insertContent` commands the chooser dispatches.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDrop(view, event, slice, moved) {
            let hasTopLevelSection = false
            slice.content.forEach((child) => {
              if (child.type.name === 'section') hasTopLevelSection = true
            })
            if (!hasTopLevelSection) return false

            const dropPos = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            })
            if (!dropPos) return false
            let insertPos = dropPos.pos

            // If the drop lands inside an existing Section, redirect
            // to the position immediately AFTER that Section so the
            // dragged Section becomes a sibling, not a nested child.
            const $pos = view.state.doc.resolve(insertPos)
            for (let depth = $pos.depth; depth > 0; depth--) {
              if ($pos.node(depth).type.name === 'section') {
                insertPos = $pos.after(depth)
                break
              }
            }

            // For `moved` drops, delete the source. The source is
            // tracked on `view.dragging.node` (a NodeSelection captured
            // at dragstart time) — NOT `view.state.selection`, which
            // may have moved by drop time and would mis-target.
            //
            // For copy drops (moved=false; modifier-key drag), the
            // source stays. The dragged slice carries the original
            // Section's id, so the copy would land with a duplicate
            // id — unique-id invariant broken. Regenerate the section
            // ids in the slice BEFORE inserting so the copy enters
            // the doc with a fresh id from the start (ids are stable
            // identifiers; never reassign one after the fact).
            let tr = view.state.tr
            let contentToInsert = slice.content
            if (moved && view.dragging && view.dragging.node) {
              const sourceSel = view.dragging.node
              tr = tr.delete(sourceSel.from, sourceSel.to)
              insertPos = tr.mapping.map(insertPos)
            } else if (!moved) {
              contentToInsert = regenerateSectionIds(slice.content)
            }
            tr = tr.insert(insertPos, contentToInsert)
            view.dispatch(tr)
            event.preventDefault()
            return true
          },
          handlePaste(view, event, slice) {
            const stripped = new Slice(
              stripSectionWrappers(slice.content),
              slice.openStart,
              slice.openEnd,
            )
            view.dispatch(view.state.tr.replaceSelection(stripped).scrollIntoView())
            return true
          },
        },
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null

          // Unwrap any section that ended up inside another section
          // (the no-nesting invariant). Section id uniqueness is
          // enforced at the duplication point (handleDrop's copy
          // path regenerates ids in the inserted slice) — NOT here,
          // because once a section has an id, that id MUST be
          // stable. Reassigning it post-hoc would break anything
          // that has already stored a reference.
          let nestedPos = null
          let nestedNode = null
          newState.doc.descendants((child, pos) => {
            if (nestedPos !== null) return false
            if (child.type.name !== 'section') return true
            const $pos = newState.doc.resolve(pos)
            for (let depth = $pos.depth; depth > 0; depth--) {
              if ($pos.node(depth).type.name === 'section') {
                nestedPos = pos
                nestedNode = child
                return false
              }
            }
            return true
          })

          if (nestedPos === null) return null

          const tr = newState.tr.replaceWith(
            nestedPos,
            nestedPos + nestedNode.nodeSize,
            nestedNode.content,
          )
          return tr.steps.length ? tr : null
        },
      }),
      // Phase 2.9c item 1 — Section content edit-lockout while a
      // Prompt Block Header is streaming a response into a Section.
      // The writer must not be able to type / paste / delete inside
      // a Section that the AI is actively writing to, or the streams
      // would interleave and corrupt the doc.
      //
      // Implementation: a separate Plugin whose filterTransaction
      // rejects any transaction whose steps touch a streaming
      // Section's content range. Our own AI-write transactions ride
      // a `tr.setMeta('aiWrite', true)` marker that bypasses the
      // filter. The PBH form's controls (Stop button, picker, etc.)
      // are React UI outside the editor so they're unaffected.
      //
      // Streaming-set source: `sectionPromptBlocksStore.blocks` —
      // every entry whose `isStreaming` is true contributes its
      // Section id. Zustand's `getState()` is synchronous + cheap
      // so reading on every filterTransaction call is fine; the
      // common case (no streaming) early-exits in O(1).
      new Plugin({
        filterTransaction(tr, state) {
          // Our own AI writes always pass — they carry the meta marker.
          if (tr.getMeta('aiWrite')) return true
          // No doc change? Selection-only transactions etc. always pass.
          if (!tr.docChanged) return true

          const blocks = useSectionPromptBlocksStore.getState().blocks || {}
          const streamingIds = new Set()
          for (const [id, b] of Object.entries(blocks)) {
            if (b && b.isStreaming) streamingIds.add(id)
          }
          if (streamingIds.size === 0) return true

          // Find each streaming Section's range in the doc. Walk top-
          // level descendants only — Sections are top-level wrapper
          // nodes (the no-nesting invariant from §4.13 holds), so we
          // don't need a deep walk.
          const streamingRanges = []
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'section') {
              if (node.attrs && streamingIds.has(node.attrs.id)) {
                // The CONTENT range is `[pos + 1, pos + nodeSize - 1]`
                // — the writer is allowed to delete the whole Section
                // wrapper (handled separately by Section toolbar's
                // Delete button), but not edit prose INSIDE it.
                streamingRanges.push({
                  from: pos + 1,
                  to: pos + node.nodeSize - 1,
                })
              }
              // Sections don't contain Sections (no-nesting invariant)
              // so no need to recurse into them.
              return false
            }
            // Recurse into other top-level nodes (none should contain
            // Sections, but be defensive).
            return true
          })
          if (streamingRanges.length === 0) return true

          // Check each step's modification range against the streaming
          // ranges. ReplaceStep / ReplaceAroundStep both expose `from`
          // and `to`; other step types fall back to the step's overall
          // map range via `getMap().mapResult` checks. Simple overlap
          // test: `step.from < range.to && step.to > range.from`.
          for (const step of tr.steps) {
            const stepFrom = typeof step.from === 'number' ? step.from : null
            const stepTo = typeof step.to === 'number' ? step.to : stepFrom
            if (stepFrom === null) continue
            for (const r of streamingRanges) {
              if (stepFrom < r.to && stepTo > r.from) return false
            }
          }
          return true
        },
      }),
    ]
  },
})

export default SectionExtension
