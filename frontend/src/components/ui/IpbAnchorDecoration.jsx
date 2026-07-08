/**
 * IpbAnchorDecoration — TipTap extension that paints the Inline
 * Prompt Block's own anchor in the editor as a story-accent
 * ProseMirror decoration (Phase 2.9c item 2 starter; full anchor
 * management — Ctrl+click / Ctrl+drag retarget, snap-to-selection
 * toggle, section-mode range — lands in item 3).
 *
 * The IPB has its own cursor / selection (the **anchor**) tracked
 * independently of the writer's native cursor (planning doc §4.11).
 * This extension reads the anchor from `useIpbStore` and renders
 * it as a decoration in the editor so the writer always sees what
 * the IPB is targeting, separate from where their native cursor /
 * selection happens to be.
 *
 * Decoration shape (this slice — cursor mode only):
 *   - A 2px-wide vertical strip in story accent, painted across the
 *     character at the anchor position. Implemented as an inline
 *     decoration spanning the single position with a CSS class that
 *     paints a left border in story accent.
 *
 * Section mode (item 3) adds a range highlight decoration over
 * `[from, to]` — same DecorationSet, different `Decoration.inline`
 * range.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useIpbStore, IPB_FORM_KEY } from '../../store/ipbStore'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useUiStore } from '../../store/uiStore'

const PLUGIN_KEY = new PluginKey('ipbAnchorDecoration')

// Shared mutable refs for the Ctrl+click vs Ctrl+drag dispatch.
// `_dragHandledRef.current` is set by the mouseup handler when it
// converted a Ctrl+drag into a range anchor so the subsequent
// handleClick fires don't double-handle the gesture. `_pendingDrag`
// tracks an in-flight Ctrl+drag from mousedown to mouseup. Plain
// object refs (not React refs) because they live outside React's
// render cycle; the plugin's view() factory binds them.
const _dragHandledRef = { current: false }
const _pendingDrag = { active: false, fromPos: null, fromX: 0, fromY: 0 }

// Walk up from the editor's contenteditable DOM node to find the
// nearest scroll container. Used as the bounds for clamp + flip rules
// + the scroll listener target.
function _findScrollContainer(view) {
  let el = view?.dom?.parentElement
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el
    el = el.parentElement
  }
  return null
}

/**
 * Compute the IPB chrome's `{ left, top }` from the anchor's screen
 * coords with all the placement rules:
 *
 *   - **Cursor mode**: place chrome BELOW the cursor's bottom (+6px).
 *   - **Range mode (Ctrl+drag selection)**: place chrome ABOVE the
 *     top visible line of the selection (chrome bottom = range top - 6).
 *     Don't cover the selected area.
 *   - **Vertical flip**: if the chrome would extend below the editor
 *     panel's visible bottom, flip to above the anchor (and expand
 *     upward).
 *   - **Horizontal clamp**: if the chrome would extend off the
 *     panel's right or left edge, clamp horizontally so the chrome
 *     stays inside the visible editor area.
 *
 * Bounds = the editor's scroll container's bounding rect (the panel
 * that the writer can scroll to see the doc). Falls back to viewport.
 *
 * Returns `{ left, top }` in viewport coords (the chrome is
 * `position: fixed`), or null when the anchor / view can't be
 * resolved.
 */
export function computeIpbChromePos(view, anchor, opts = {}) {
  if (!view || !anchor) return null

  // `opts.pinShape` switches positioning to the IPB's collapsed-
  // streaming pin (the inverted-teardrop / map-pin shape from
  // planning doc §4.10). Pin-mode differs from the form-mode in
  // three ways:
  //   1. **Width** — the pin is ~PIN_WIDTH (40-56px) instead of
  //      the form's 480px, so horizontal clamping uses a much
  //      tighter bound.
  //   2. **Horizontal anchoring** — the pin is CENTERED on the
  //      anchor's x (pin's center-x = anchorLeft) so its tip points
  //      directly at the writing cursor. The form's left edge sits
  //      at the anchor (chrome extends to the right) by contrast.
  //   3. **Vertical gap** — the pin's TIP sits at the anchor's top
  //      (no 6px gap) so it visually touches the prose. The form
  //      keeps a 6px gap.
  // Pin doesn't flip (it always sits above the anchor pointing
  // down); if the anchor is near the top of the viewport the pin
  // may go off-screen. Polishing flip-up-from-below would change
  // the pin's visual shape (needs an upward-pointing tail) so
  // it's deferred — for v1 of item 4 the writer can scroll if the
  // anchor is too close to the top.
  const pinShape = !!opts.pinShape
  // Pin dimensions MUST match the SVG viewBox + container CSS in
  // `InlinePromptBlockPin` so the pin's bottom-edge tip lands at the
  // IPB anchor's top edge. Smaller-than-the-form chrome size keeps
  // the pin visually subordinate to the editor's prose (planning
  // doc §4.10: "AI is writing at this point in the editor" — read
  // as a marker, not a panel).
  const PIN_WIDTH = 26
  const PIN_HEIGHT = 36
  const CHROME_WIDTH = pinShape ? PIN_WIDTH : 480
  const _chromeEl = pinShape ? null : document.querySelector('.nn-ipb')
  const _chromeHeight = pinShape
    ? PIN_HEIGHT
    : _chromeEl
      ? Math.ceil(_chromeEl.getBoundingClientRect().height)
      : 40  // initial-open estimate (collapsed-default form is ~36px)

  // Find the anchor's screen rect.
  let anchorTop, anchorBottom, anchorLeft
  try {
    if (anchor.kind === 'cursor') {
      const c = view.coordsAtPos(anchor.pos)
      anchorTop = c.top
      anchorBottom = c.bottom
      anchorLeft = c.left
      // Sanity floor for cursor-mode line height. `coordsAtPos` can
      // return a near-zero-height rect at structural positions (start
      // / end of a node, empty paragraph, just-inserted block) — top
      // and bottom coincide at a single y-pixel. Without this floor,
      // chrome's `top: anchorBottom + 6` would land only 6px below the
      // cursor's TOP — visually still ON the same line as the cursor.
      // The user keeps seeing this: chrome overlaps the cursor's line
      // instead of sitting below it. Expand the anchor box to at least
      // the editor's computed line-height so the chrome always clears
      // the visual line.
      if (anchorBottom - anchorTop < 8) {
        const cs = window.getComputedStyle(view.dom)
        const fs = parseFloat(cs.fontSize) || 16
        const lhRaw = cs.lineHeight
        let lh
        if (lhRaw && lhRaw !== 'normal') {
          const parsed = parseFloat(lhRaw)
          lh = Number.isFinite(parsed) ? parsed : fs * 1.5
        } else {
          lh = fs * 1.5
        }
        anchorBottom = anchorTop + Math.max(lh, 16)
      }
    } else if (anchor.kind === 'range') {
      const start = view.coordsAtPos(anchor.from)
      const end = view.coordsAtPos(anchor.to)
      anchorTop = Math.min(start.top, end.top)
      anchorBottom = Math.max(start.bottom, end.bottom)
      anchorLeft = start.left
    } else {
      return null
    }
  } catch {
    return null
  }

  const scrollContainer = _findScrollContainer(view)
  const bounds = scrollContainer
    ? scrollContainer.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }

  // Vertical positioning rules. Two CSS anchoring modes:
  //   - top-anchored (CSS `top: <px>`) — for cursor mode below the
  //     cursor. Chrome's top edge sits 6px below the anchor's
  //     bottom; chrome grows downward as it expands.
  //   - bottom-anchored (CSS `bottom: <px>`, measured from viewport
  //     bottom) — for range mode (always above selection top) and
  //     for the cursor-mode flip case (when below would overflow the
  //     panel bottom). Chrome's bottom edge sits 6px above the
  //     anchor's top; chrome grows UPWARD as it expands so the
  //     selection / cursor below stays visible no matter how tall
  //     the form gets.
  let vertical
  if (pinShape) {
    // Pin mode: bottom-anchored with the pin's TIP at the anchor's
    // top (no 6px gap) so the pin visually points AT the writing
    // cursor / selection top. Pin sits above the anchor pointing
    // down regardless of anchor mode.
    vertical = { bottom: window.innerHeight - anchorTop }
  } else if (anchor.kind === 'cursor') {
    const wantedTop = anchorBottom + 6
    if (wantedTop + _chromeHeight > bounds.bottom) {
      // Not enough room below the cursor for the chrome AT ITS
      // CURRENT SIZE — flip to bottom-anchored above the cursor.
      // Using the live height (not a max-height estimate) means a
      // collapsed chrome stays below the cursor unless the COLLAPSED
      // form itself wouldn't fit. As the writer expands the form,
      // it may flip later if expansion would overflow; that's the
      // intended behaviour — chrome stays visible regardless of size.
      vertical = { bottom: window.innerHeight - anchorTop + 6 }
    } else {
      vertical = { top: wantedTop }
    }
  } else {
    // Range mode: always bottom-anchored above the top line of the
    // selection so the chrome never covers it. Chrome grows upward
    // when expanded.
    vertical = { bottom: window.innerHeight - anchorTop + 6 }
  }

  // Horizontal clamp — keep the chrome within the panel WHEN the
  // panel is wide enough to hold it. When the panel is narrower than
  // the chrome, the bound-it-inside-the-panel goal is impossible
  // (we'd have to make the chrome narrower); fall back to a
  // viewport clamp so the chrome stays on screen and as close to the
  // anchor as possible. Earlier rev applied the panel-left clamp
  // unconditionally, which jumped the chrome to the far-left edge of
  // a narrow panel whenever the cursor sat near the right edge —
  // visually the chrome "teleported" far from its anchor.
  // Horizontal anchoring differs between pin and form modes:
  //   - Pin mode: chrome CENTERED on the anchor's x (pin's
  //     vertical-center axis = anchorLeft) so the tip points
  //     directly at the writing cursor / selection.
  //   - Form mode: chrome's LEFT edge at the anchor (form extends
  //     rightward from there).
  let left = pinShape ? (anchorLeft - CHROME_WIDTH / 2) : anchorLeft
  const panelFits = (bounds.right - bounds.left) >= (CHROME_WIDTH + 12)
  if (panelFits) {
    if (left + CHROME_WIDTH > bounds.right) {
      left = bounds.right - CHROME_WIDTH - 6
    }
    if (left < bounds.left) {
      left = bounds.left + 6
    }
  } else {
    // Panel can't hold the chrome — keep it near the anchor in the
    // viewport instead. The chrome may overflow the panel edges but
    // it will at least stay on-screen and near the cursor.
    if (left + CHROME_WIDTH > window.innerWidth) {
      left = window.innerWidth - CHROME_WIDTH - 6
    }
    if (left < 6) left = 6
  }

  return { left, ...vertical }
}

export const IpbAnchorDecorationExtension = Extension.create({
  name: 'ipbAnchorDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        state: {
          // The decoration set IS derived directly from the live
          // ipbStore — every props.decorations(state) call reads it
          // fresh. We don't cache the set in plugin state, so there's
          // no chance of stale state after the IPB is dismissed.
          // (Earlier revisions cached + relied on a subscribe-driven
          // meta dispatch to clear; that path proved unreliable in
          // practice — the decoration persisted after dismiss.)
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldSet) {
            // Map the IPB's anchor through any non-AI doc change so
            // the anchor stays at the same relative content position
            // as the writer types / deletes / pastes elsewhere in the
            // doc. Without this, the anchor's absolute `pos` would
            // remain unchanged while the surrounding content shifts,
            // so the IPB would visually drift away from the content
            // it was originally targeting.
            //
            // Biases:
            //   - cursor mode → bias 1 (default): insertion AT the
            //     anchor's position pushes the anchor forward past
            //     the insertion. Matches a typical text-caret's
            //     behaviour, which is the natural mental model for
            //     "the IPB sits where my caret was".
            //   - range mode → from with bias 1, to with bias -1:
            //     "stable selection that doesn't expand". Insertions
            //     immediately adjacent to either end of the range
            //     stay outside the range rather than enlarging it,
            //     so the IPB keeps targeting the same selected
            //     content even as the doc grows around it.
            //
            // Our own AI writes carry `aiWrite` meta — they're
            // skipped here because the streaming write path in
            // `InlinePromptBlock.handleSend` maintains the anchor
            // manually (sets it to the post-flush insertion-end so
            // the chrome trails the prose being written).
            if (tr.docChanged && !tr.getMeta('aiWrite')) {
              const { anchor, active } = useIpbStore.getState()
              if (active && anchor) {
                let mapped = null
                if (anchor.kind === 'cursor' && typeof anchor.pos === 'number') {
                  const next = tr.mapping.map(anchor.pos)
                  if (next !== anchor.pos) mapped = { kind: 'cursor', pos: next }
                } else if (
                  anchor.kind === 'range'
                  && typeof anchor.from === 'number'
                  && typeof anchor.to === 'number'
                ) {
                  const nextFrom = tr.mapping.map(anchor.from, 1)
                  const nextTo = tr.mapping.map(anchor.to, -1)
                  if (nextFrom !== anchor.from || nextTo !== anchor.to) {
                    mapped = (nextFrom < nextTo)
                      ? { kind: 'range', from: nextFrom, to: nextTo }
                      : { kind: 'cursor', pos: nextFrom }
                  }
                }
                if (mapped) {
                  // Defer the store write to a microtask so we don't
                  // mutate external state inside ProseMirror's
                  // synchronous reducer. The deferral also avoids
                  // re-entering the plugin's apply via the store
                  // subscriber on the same tick.
                  queueMicrotask(() => {
                    if (useIpbStore.getState().active) {
                      useIpbStore.getState().setAnchor(mapped)
                    }
                  })
                }
              }
            }
            if (!tr.docChanged) return oldSet
            return oldSet.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) {
            const { active, anchor, contextPreview } = useIpbStore.getState()
            if (!active) return DecorationSet.empty
            return _buildDecorations(anchor, state.doc, contextPreview)
          },
          // Ctrl+click / Ctrl+drag retarget (planning doc §4.11).
          // Active only when the IPB is active — otherwise the
          // gesture falls through to native browser behaviour. Ctrl
          // chosen over Alt because Alt collides with OS-level
          // window controls (e.g. PowerToys "Grab and Move").
          //
          // Ctrl+click behaviour:
          //   - Click outside any native selection → cursor mode at
          //     the clicked pos.
          //   - Click INSIDE an existing native selection → section
          //     mode adopting the selection range (convenience so
          //     the writer doesn't have to redo the drag).
          //
          // Ctrl+drag behaviour:
          //   - Drag from A to B → section mode range [A..B].
          //   - Handled via mousedown/mousemove/mouseup tracking in
          //     view(), not via handleClick (which only fires on a
          //     completed click without drag).
          handleClick(view, pos, event) {
            if (!(event.ctrlKey || event.metaKey)) return false
            const { active } = useIpbStore.getState()
            if (!active) return false
            // Ignore the click if a drag was just completed — the
            // mouseup path in view() handled it and set a guard.
            if (_dragHandledRef.current) {
              _dragHandledRef.current = false
              return true
            }
            const sel = view.state.selection
            let anchor
            if (sel && !sel.empty && pos >= sel.from && pos <= sel.to) {
              anchor = { kind: 'range', from: sel.from, to: sel.to }
            } else {
              anchor = { kind: 'cursor', pos }
            }
            useIpbStore.getState().setAnchor(anchor)
            const chromePos = computeIpbChromePos(view, anchor)
            if (chromePos) useIpbStore.getState().setChromePos(chromePos)
            event.preventDefault()
            return true
          },
        },
        view(editorView) {
          // `props.decorations(state)` reads `useIpbStore` live each
          // call, but ProseMirror only fires it on state-change
          // dispatches. Subscribe to the IPB store and dispatch a
          // no-op meta tx whenever the IPB state changes so the
          // editor re-renders and `props.decorations` picks up the
          // new active / anchor. The dispatch carries no doc change
          // — it only triggers the re-render path.
          //
          // Also: keep the chrome position attached to the anchor's
          // current screen coords across editor scrolls / doc edits
          // / window resizes. Without this, scrolling the editor
          // would leave the chrome static while the cursor moves
          // out from under it.
          // Sticky auto-scroll for IPB streaming (writer spec
          // 2026-05-27): while the IPB is actively streaming a
          // response, if a newly added line at the IPB text cursor
          // would land below the editor's visible bottom, scroll
          // just enough to bring that line into view. Writer's own
          // scroll (wheel / touch / keyboard) BREAKS the sticky;
          // scrolling back so the IPB cursor is visible again
          // RE-ARMS it. Outside streaming the writer's navigation
          // is untouched. The IPB pin's own position tracking is
          // unchanged — it continues to follow the cursor via the
          // existing chrome-position rules; this sticky logic only
          // controls the scroll container.
          let stickyAutoScroll = true
          let userScrollIntentExpires = 0
          // Timestamp of our own last `scrollIntoView`. Used to
          // distinguish OUR programmatic scrolls from USER-driven
          // ones (including scrollbar-drag — which fires scroll
          // events but no wheel / touch / keydown). Without this,
          // the `onScroll` handler couldn't tell drag-scrolls from
          // our own scroll-into-view and either always or never
          // broke sticky on them.
          let lastProgrammaticScrollAt = 0

          function markUserScrollIntent() {
            userScrollIntentExpires = performance.now() + 250
            // Break sticky IMMEDIATELY on any user scroll input.
            // Re-arm decisions wait until the gesture has ended
            // (the 250ms grace expires) — re-evaluating visibility
            // DURING the wheel/drag let sticky re-arm a tick later
            // and the next flush's auto-scroll fought the writer.
            stickyAutoScroll = false
          }
          // Resolve the scroll container LAZILY at call time. The
          // closure-captured `scrollContainer` (below) is set once when
          // `view()` runs — but in TipTap's React adapter the editor's
          // DOM is created BEFORE it's attached to its final parent
          // (the EditorContent ref gets `editor.view.dom` appended on a
          // later effect tick). The init-time walk from `view.dom`
          // would either return null or walk up through the wrong
          // ancestors. By the time streaming actually runs, the editor
          // is in its final DOM position and the lookup succeeds.
          // Falling back to the captured one when the live lookup fails
          // keeps the legacy wiring valid for edge cases.
          function _resolveScrollContainer() {
            return _findScrollContainer(editorView) || scrollContainer || null
          }
          function _cursorVisibleInScrollContainer() {
            // The IPB cursor is rendered as a portal'd `position: fixed`
            // div outside the editor's DOM (see `_updateCursorScreenPos`).
            // Visibility checks read its viewport-px rect directly from
            // the store and compare against the editor's scroll
            // container — no DOM query needed.
            const pos = useIpbStore.getState().cursorScreenPos
            if (!pos) return false
            const ancestor = _resolveScrollContainer()
            const aRect = ancestor
              ? ancestor.getBoundingClientRect()
              : { top: 0, bottom: window.innerHeight }
            // Visible if any part of the cursor's vertical extent is
            // inside the scroll container's clip range.
            return (pos.top + pos.height) > aRect.top && pos.top < aRect.bottom
          }
          function maintainStickyScroll() {
            const form = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
            if (!form?.isStreaming) return
            // While the writer is actively scrolling (wheel / touch
            // / keyboard / scrollbar drag — see `onScroll` for the
            // drag-detection path), bail out entirely. This is the
            // chat-panel pattern: no sticky logic runs during the
            // gesture, so we never fight the writer. Re-arm
            // decisions happen AFTER the 250ms gesture grace has
            // expired, when the scroll has settled.
            if (performance.now() < userScrollIntentExpires) return
            // Re-arm: gesture has ended; if the writer scrolled
            // back so the IPB cursor is visible, re-engage sticky
            // for the remainder of this stream.
            if (!stickyAutoScroll) {
              if (_cursorVisibleInScrollContainer()) {
                stickyAutoScroll = true
              } else {
                return
              }
            }
            // Sticky is engaged — pull the cursor into view if it
            // would land outside. The cursor lives outside the editor
            // DOM now, so we can't use Element.scrollIntoView on it;
            // compute the delta manually and apply it to the scroll
            // container. Only act when the cursor is OUT of view (any
            // part below or above the container) — match the
            // `block: 'nearest'` semantics: scroll the minimum amount
            // needed to bring it into view.
            const pos = useIpbStore.getState().cursorScreenPos
            if (!pos) return
            const ancestor = _resolveScrollContainer()
            if (!ancestor) return
            const aRect = ancestor.getBoundingClientRect()
            const cursorTop = pos.top
            const cursorBottom = pos.top + pos.height
            let delta = 0
            if (cursorBottom > aRect.bottom) {
              delta = cursorBottom - aRect.bottom
            } else if (cursorTop < aRect.top) {
              delta = cursorTop - aRect.top
            }
            if (delta === 0) return
            lastProgrammaticScrollAt = performance.now()
            try {
              ancestor.scrollBy({ top: delta, left: 0, behavior: 'auto' })
            } catch { /* ignore */ }
          }
          const updateChromeFromAnchor = () => {
            const { active, anchor, isDragging } = useIpbStore.getState()
            if (!active || !anchor) return
            // Pin shape applies when the IPB form is COLLAPSED while
            // a stream is in flight — the inverted-teardrop / map-pin
            // visual from planning doc §4.10. Read the IPB's per-
            // form state from sectionPromptBlocksStore (the same
            // store the form component reads). If the writer
            // manually expands mid-stream the chrome reverts to the
            // normal form-positioning rules.
            //
            // Also applies while the writer is actively dragging the
            // chrome — same visual shape (so chrome positioning uses
            // the same centered-on-anchor / no-gap geometry) but
            // the spinning coin is gated separately in
            // `InlinePromptBlockPin` so it doesn't show during drag.
            const form = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
            const pinShape = !!(form?.isStreaming && !form?.expanded) || !!isDragging
            const pos = computeIpbChromePos(editorView, anchor, { pinShape })
            if (!pos) return
            // Skip if the chrome is already at this position. Position
            // can be top-anchored OR bottom-anchored — compare all
            // three fields to detect a real change. Prevents a no-op
            // write from waking the store subscribers (which would
            // re-call refresh; see the prevAnchor / prevActive guard
            // in `refresh` below for the primary loop-break).
            const cur = useIpbStore.getState().chromePos
            if (
              cur
              && cur.left === pos.left
              && cur.top === pos.top
              && cur.bottom === pos.bottom
            ) return
            useIpbStore.getState().setChromePos(pos)
            // Also push the IPB cursor's own screen position to the
            // store so `InlinePromptBlock` can render the cursor as
            // a portal'd `position: fixed` div outside the editor's
            // DOM (avoids the spell-check word-split issue and the
            // gutter phantom-blank-line issue that the in-editor
            // widget decoration caused — see `_buildDecorations`
            // for the historical context). Only set when the anchor
            // is a cursor at a textblock position AND its screen
            // rect is INSIDE the editor's scroll-container visible
            // area; otherwise null so the cursor disappears.
            _updateCursorScreenPos(editorView, anchor)
            // After the chrome position has been recomputed for the
            // new anchor, also pull the scroll container along if
            // the writer is still pinned to the IPB cursor (sticky
            // auto-scroll). The function is a no-op outside
            // streaming and when sticky is broken.
            maintainStickyScroll()
          }
          // `refresh` runs on every IPB-store change. We MUST ignore
          // changes to `chromePos` here, or we'd recurse:
          //   refresh → updateChromeFromAnchor → setChromePos →
          //   subscribe fires → refresh → loop. The first cut shipped
          //   that loop and the UI thread pinned; toolbar dismiss
          //   stopped working because click handlers couldn't get a
          //   turn. Guard: only act when `active` or `anchor` actually
          //   changed since the previous refresh.
          let prevActive = useIpbStore.getState().active
          let prevAnchor = useIpbStore.getState().anchor
          let prevContextPreview = useIpbStore.getState().contextPreview
          let prevIsDragging = useIpbStore.getState().isDragging
          const refresh = () => {
            const { active, anchor, contextPreview, isDragging } = useIpbStore.getState()
            // Skip if NEITHER active / anchor NOR the context-preview
            // NOR the drag flag changed. `contextPreview` is included
            // so the editor decoration repaints when the writer hovers
            // a Before/After pill (or drags the slider) — without
            // that, the preview range wouldn't appear until some
            // unrelated store change fired the next refresh.
            // `isDragging` is included so the chrome's pin-vs-form
            // morph happens immediately on pointerdown — without it
            // the morph only fires once the writer's pointer moves
            // (the drag handler updates the anchor on each move),
            // leaving the freshly mounted pin reading stale top-
            // anchored chromePos for a frame and hiding at -9999.
            if (
              active === prevActive
              && anchor === prevAnchor
              && contextPreview === prevContextPreview
              && isDragging === prevIsDragging
            ) return
            prevActive = active
            prevAnchor = anchor
            prevContextPreview = contextPreview
            prevIsDragging = isDragging
            try {
              editorView.dispatch(editorView.state.tr.setMeta(PLUGIN_KEY, { tick: Date.now() }))
            } catch { /* editor torn down — destroy handler cleans up the subscription next */ }
            updateChromeFromAnchor()
          }
          const unsubscribe = useIpbStore.subscribe(refresh)

          const scrollContainer = _findScrollContainer(editorView)
          const onScroll = () => {
            // Distinguish OUR programmatic scroll (from
            // `maintainStickyScroll`'s `scrollIntoView`) from a
            // user-driven scroll. Wheel / touch / keydown listeners
            // already mark intent BEFORE their scroll event fires;
            // this gate also catches SCROLLBAR DRAG, which doesn't
            // fire any of those — but it does fire scroll events
            // that aren't within our 100ms programmatic window.
            // Treating any non-programmatic scroll as user intent
            // means dragging the scrollbar breaks sticky exactly
            // like a wheel does.
            const isProgrammatic = performance.now() - lastProgrammaticScrollAt < 100
            if (!isProgrammatic) {
              const form = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
              if (form?.isStreaming) markUserScrollIntent()
            }
            updateChromeFromAnchor()
          }
          const onResize = () => {
            // Resize alone never marks scroll intent — only chrome
            // reposition. (Some browsers fire scroll on resize
            // anyway, which `onScroll` handles; this path covers
            // the resize-without-scroll case.)
            updateChromeFromAnchor()
          }
          // Document-level scroll listener with capture: true catches
          // scroll events on any descendant (scroll doesn't bubble by
          // default but the capture phase fires on document for ALL
          // scrollable descendants regardless). Safety net for cases
          // where `_findScrollContainer` returns the wrong element or
          // the layout uses an unexpected scroll mechanism.
          document.addEventListener('scroll', onScroll, { passive: true, capture: true })
          // Window-level resize for browser-window resizes.
          window.addEventListener('resize', onResize)
          // ResizeObserver catches PANEL resizes (e.g., the writer
          // drags the right-sidebar's resize handle to widen / narrow
          // the editor panel) — `window`'s resize event doesn't fire
          // for in-page resizes like that. Observe BOTH the scroll
          // container AND the editor's own contentEditable DOM — when
          // the panel changes width the content reflows (line wraps
          // change, anchor screen coords shift), and one or the other
          // is guaranteed to report a size change.
          let resizeObserver = null
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(onResize)
            if (scrollContainer) resizeObserver.observe(scrollContainer)
            if (editorView.dom) resizeObserver.observe(editorView.dom)
          }
          // Belt-and-braces: subscribe to `uiStore.rightSidebarWidth`
          // directly. The sidebar resize handle drags this state, so
          // any drag tick fires our update. Some browsers throttle /
          // batch ResizeObserver callbacks aggressively during drags,
          // so the explicit state subscription guarantees a smooth
          // re-position regardless.
          let prevWidth = useUiStore.getState().rightSidebarWidth
          const unsubscribeUi = useUiStore.subscribe(() => {
            const w = useUiStore.getState().rightSidebarWidth
            if (w !== prevWidth) {
              prevWidth = w
              onResize()
            }
          })
          // Re-position when the IPB transitions in / out of the
          // pin-shape (collapsed-streaming) state. Triggered when:
          //   - Send fires → isStreaming flips true + expanded false
          //   - Stream ends → isStreaming flips false
          //   - Writer expands the pin mid-stream → expanded flips true
          //   - Writer collapses back → expanded flips false
          // Each transition changes the chrome's dimensions + anchor
          // offsets, so the position computed by `computeIpbChromePos`
          // is now stale; `updateChromeFromAnchor` recomputes with
          // the right `pinShape` value.
          const formInitial = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
          let prevStreaming = !!formInitial?.isStreaming
          let prevExpanded = !!formInitial?.expanded
          const unsubscribeForm = useSectionPromptBlocksStore.subscribe(() => {
            const form = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]
            const streaming = !!form?.isStreaming
            const expanded = !!form?.expanded
            if (streaming !== prevStreaming || expanded !== prevExpanded) {
              // Reset sticky auto-scroll on each stream start so a
              // broken sticky from a previous stream doesn't carry
              // over. The writer's intent at the moment of Send is
              // to follow the prose being written; if they want to
              // navigate elsewhere they can scroll once the stream
              // is underway and the new sticky=false sticks for the
              // rest of THIS stream.
              if (streaming && !prevStreaming) {
                stickyAutoScroll = true
              }
              prevStreaming = streaming
              prevExpanded = expanded
              updateChromeFromAnchor()
            }
          })

          // Mark user-driven scroll intent so `checkStickyOnUserScroll`
          // can distinguish writer-initiated scrolls (wheel / touch /
          // keyboard) from our own programmatic scroll in
          // `maintainStickyScroll` (which doesn't fire any of these
          // input events). Listeners are wired for the lifetime of
          // the editor view — the cost outside streaming is just a
          // timestamp write; the gate in `checkStickyOnUserScroll`
          // bails out if no stream is active.
          if (scrollContainer) {
            scrollContainer.addEventListener('wheel', markUserScrollIntent, { passive: true })
            scrollContainer.addEventListener('touchmove', markUserScrollIntent, { passive: true })
          }
          function onScrollKeyDown(e) {
            if (
              e.key === 'ArrowUp'
              || e.key === 'ArrowDown'
              || e.key === 'PageUp'
              || e.key === 'PageDown'
              || e.key === 'Home'
              || e.key === 'End'
              || e.key === ' '
            ) {
              markUserScrollIntent()
            }
          }
          document.addEventListener('keydown', onScrollKeyDown)

          // Ctrl+drag retarget: select a range in the doc while
          // holding Ctrl to set the IPB to section-mode on [from..to].
          // ProseMirror's handleClick only fires for completed clicks
          // (no drag), so we track mousedown / move / up directly on
          // the editor DOM element. handleClick covers the no-drag
          // case (cursor-mode at pos, or selection-adoption if
          // clicking inside a native selection).
          const DRAG_THRESHOLD_PX = 4

          function onMouseDown(e) {
            if (!(e.ctrlKey || e.metaKey)) return
            if (!useIpbStore.getState().active) return
            const posInfo = editorView.posAtCoords({ left: e.clientX, top: e.clientY })
            if (!posInfo) return
            _pendingDrag.active = true
            _pendingDrag.fromPos = posInfo.pos
            _pendingDrag.fromX = e.clientX
            _pendingDrag.fromY = e.clientY
            // Suppress native selection's "Ctrl+click selects word"
            // browser default. Without preventDefault the browser
            // can start a selection that competes with ours.
            e.preventDefault()
          }
          function onMouseMove(e) {
            if (!_pendingDrag.active) return
            const dx = Math.abs(e.clientX - _pendingDrag.fromX)
            const dy = Math.abs(e.clientY - _pendingDrag.fromY)
            if (dx + dy < DRAG_THRESHOLD_PX) return
            // Crossed the drag threshold — paint the in-flight range
            // by updating the store anchor live. Lets the writer see
            // the range expand as they drag.
            const posInfo = editorView.posAtCoords({ left: e.clientX, top: e.clientY })
            if (!posInfo) return
            const from = Math.min(_pendingDrag.fromPos, posInfo.pos)
            const to = Math.max(_pendingDrag.fromPos, posInfo.pos)
            if (from === to) {
              useIpbStore.getState().setAnchor({ kind: 'cursor', pos: from })
            } else {
              useIpbStore.getState().setAnchor({ kind: 'range', from, to })
            }
            e.preventDefault()
          }
          function onMouseUp(e) {
            if (!_pendingDrag.active) return
            const dx = Math.abs(e.clientX - _pendingDrag.fromX)
            const dy = Math.abs(e.clientY - _pendingDrag.fromY)
            const wasDrag = (dx + dy) >= DRAG_THRESHOLD_PX
            _pendingDrag.active = false
            const posInfo = editorView.posAtCoords({ left: e.clientX, top: e.clientY })
            if (!posInfo) return
            let anchor
            if (wasDrag) {
              const from = Math.min(_pendingDrag.fromPos, posInfo.pos)
              const to = Math.max(_pendingDrag.fromPos, posInfo.pos)
              anchor = (from === to)
                ? { kind: 'cursor', pos: from }
                : { kind: 'range', from, to }
            } else {
              // Just a Ctrl+click. Handle here (not via handleClick)
              // because handleClick only fires when the click TARGET
              // is the editor's contenteditable — Ctrl+clicks on the
              // IPB chrome (portaled fixed-position div) never trigger
              // it. If the click lands inside an existing native
              // selection, adopt that range; otherwise cursor mode.
              const sel = editorView.state.selection
              if (sel && !sel.empty && posInfo.pos >= sel.from && posInfo.pos <= sel.to) {
                anchor = { kind: 'range', from: sel.from, to: sel.to }
              } else {
                anchor = { kind: 'cursor', pos: posInfo.pos }
              }
            }
            useIpbStore.getState().setAnchor(anchor)
            const chromePos = computeIpbChromePos(editorView, anchor)
            if (chromePos) useIpbStore.getState().setChromePos(chromePos)
            // Mark this gesture handled so the trailing handleClick
            // (if it does fire because the click was on editor text)
            // doesn't double-handle it.
            _dragHandledRef.current = true
            e.preventDefault()
          }

          // Document-level capture so Ctrl+click is intercepted even
          // when it lands on the IPB chrome itself (which is portaled
          // over the editor at `position: fixed` and would otherwise
          // swallow the event). `posAtCoords` resolves the doc
          // position UNDER the chrome — if the chrome sits over
          // editor text, the writer can Ctrl+click on the chrome to
          // retarget to that underlying text. Bails harmlessly if
          // the click is outside the editor area.
          document.addEventListener('mousedown', onMouseDown, true)
          window.addEventListener('mousemove', onMouseMove)
          window.addEventListener('mouseup', onMouseUp)

          return {
            // Fires on every editor state update — including doc edits
            // and selection changes. Reposition the chrome whenever
            // the doc shifts under the anchor (typing, deletes, etc.).
            update(_view, prevState) {
              if (prevState.doc !== _view.state.doc) {
                updateChromeFromAnchor()
              }
            },
            destroy() {
              unsubscribe()
              unsubscribeUi()
              unsubscribeForm()
              document.removeEventListener('mousedown', onMouseDown, true)
              window.removeEventListener('mousemove', onMouseMove)
              window.removeEventListener('mouseup', onMouseUp)
              document.removeEventListener('scroll', onScroll, { capture: true })
              window.removeEventListener('resize', onResize)
              if (resizeObserver) resizeObserver.disconnect()
              if (scrollContainer) {
                scrollContainer.removeEventListener('wheel', markUserScrollIntent)
                scrollContainer.removeEventListener('touchmove', markUserScrollIntent)
              }
              document.removeEventListener('keydown', onScrollKeyDown)
            },
          }
        },
      }),
    ]
  },
})

// Compute + push the IPB cursor's screen position to ipbStore so
// `InlinePromptBlock` can render the cursor as a portal'd
// `position: fixed` div (writer spec 2026-05-27 — moved out of the
// editor DOM to fix spell-check word-splitting + gutter phantom
// blank-line). Sets null when the cursor shouldn't render: anchor
// is in range mode, anchor is at a non-textblock position, or the
// resolved screen rect is OUTSIDE the editor's scroll-container
// visible area (cursor scrolled off-screen).
function _updateCursorScreenPos(view, anchor) {
  const set = useIpbStore.getState().setCursorScreenPos
  if (!anchor || anchor.kind !== 'cursor' || typeof anchor.pos !== 'number') {
    set(null)
    return
  }
  try {
    const { doc } = view.state
    if (anchor.pos < 0 || anchor.pos > doc.content.size) { set(null); return }
    if (!doc.resolve(anchor.pos).parent?.isTextblock) { set(null); return }
    const c = view.coordsAtPos(anchor.pos)
    const left = c.left
    const top = c.top
    let height = c.bottom - c.top
    // Sanity floor for structural / empty-paragraph positions where
    // `coordsAtPos` returns a near-zero-height rect. Use the editor's
    // computed line-height so the cursor remains visible.
    if (height < 8) {
      const cs = window.getComputedStyle(view.dom)
      const fs = parseFloat(cs.fontSize) || 16
      const lhRaw = cs.lineHeight
      let lh
      if (lhRaw && lhRaw !== 'normal') {
        const parsed = parseFloat(lhRaw)
        lh = Number.isFinite(parsed) ? parsed : fs * 1.5
      } else {
        lh = fs * 1.5
      }
      height = Math.max(lh, 16)
    }
    // v0.2.9.45 — store the real coords even when the cursor is
    // scrolled off-screen, with a separate `visible` flag the render
    // side reads. Previously the function set `cursorScreenPos = null`
    // when off-screen — but `maintainStickyScroll` reads the same
    // field for its scroll-into-view math and would silently bail
    // ("no cursor pos to chase"). Net effect: as soon as the AI's
    // streaming writes pushed the cursor past the visible bottom,
    // sticky-scroll stopped firing and the editor never caught up.
    // Render-side visibility now depends on `visible`, not on the
    // field being null.
    const scrollContainer = _findScrollContainer(view)
    let visible = true
    if (scrollContainer) {
      const rect = scrollContainer.getBoundingClientRect()
      if (top + height < rect.top || top > rect.bottom) visible = false
    }
    set({ left, top, height, visible })
  } catch {
    set(null)
  }
}

function _anchorsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'cursor') return a.pos === b.pos
  if (a.kind === 'range') return a.from === b.from && a.to === b.to
  return false
}

function _buildDecorations(anchor, doc, contextPreview) {
  if (!anchor) return DecorationSet.empty
  const docSize = doc.content.size
  const out = []
  if (anchor.kind === 'cursor' && typeof anchor.pos === 'number') {
    if (anchor.pos < 0 || anchor.pos > docSize) return DecorationSet.empty
    // NOTE: the IPB text cursor was historically rendered here as a
    // `Decoration.widget` (a `<span>` inserted INTO the editor's
    // text content). Two problems with that:
    //   1. The browser's spell checker treated the surrounding text
    //      as two separate words (`hel<span/>lo` → "hel" + "lo"),
    //      red-squiggling correctly-spelled words mid-cursor.
    //   2. At block boundaries, the `inline-block` span between two
    //      `<p>` siblings triggered an anonymous line box, painting
    //      as a phantom blank line that shifted layout.
    // The cursor is now rendered as a portal'd `position: fixed`
    // div in `InlinePromptBlock`, anchored to `ipbStore.cursorScreenPos`
    // (set by the position tracker in this plugin's `view()`).
    // Editor's text content is untouched — spell-check works.
    // Context-window preview range (writer spec 2026-05-27). When
    // the writer is hovering a Before/After context pill (or has
    // its slider popover open), paint the words that WILL be sent
    // as context in the same story-accent tint as the section-mode
    // anchor range. Separate function from Ctrl+drag — this is a
    // transient preview that doesn't change the IPB anchor itself.
    if (contextPreview && contextPreview.count > 0) {
      const range = contextPreview.side === 'preceding'
        ? _findPrecedingWordRange(doc, anchor.pos, contextPreview.count)
        : _findFollowingWordRange(doc, anchor.pos, contextPreview.count)
      if (range && range.from !== range.to) {
        out.push(Decoration.inline(range.from, range.to, {
          class: 'nn-ipb-anchor-range',
        }))
      }
    }
    return DecorationSet.create(doc, out)
  }
  if (anchor.kind === 'range' && typeof anchor.from === 'number' && typeof anchor.to === 'number') {
    // Section mode (item 3) — inline range decoration with a CSS
    // class that paints a story-accent tinted background.
    const from = Math.max(0, Math.min(anchor.from, docSize))
    const to = Math.max(from, Math.min(anchor.to, docSize))
    if (from === to) return DecorationSet.empty
    return DecorationSet.create(doc, [Decoration.inline(from, to, { class: 'nn-ipb-anchor-range' })])
  }
  return DecorationSet.empty
}

// Walk the doc backward from `anchor` collecting text + its source
// doc positions; find the start position of the Nth-to-last word and
// return `{ from, to }` covering the last N words.
//
// `doc.textBetween(0, anchor)` collapses the position-to-text mapping
// (block boundaries become single space characters but consume more
// doc-position) so a plain text-offset → doc-position conversion
// doesn't work. Instead, walk text nodes via `nodesBetween` and build
// a parallel array of (char, doc-pos) so the lookup is exact.
function _findPrecedingWordRange(doc, anchor, n) {
  const a = Math.max(0, Math.min(anchor, doc.content.size))
  const allText = []
  const posMap = []
  doc.nodesBetween(0, a, (node, pos) => {
    if (node.isText) {
      const text = node.text || ''
      // Only count text up to anchor — the last text node may extend
      // past it, in which case trim to (anchor - node-pos) chars.
      const maxLen = Math.min(text.length, Math.max(0, a - pos))
      for (let i = 0; i < maxLen; i++) {
        allText.push(text[i])
        posMap.push(pos + i)
      }
    }
    return true
  })
  // Find word boundaries in the collected text.
  const wordStarts = []
  let inWord = false
  for (let i = 0; i < allText.length; i++) {
    const isSpace = /\s/.test(allText[i])
    if (!isSpace && !inWord) {
      wordStarts.push(i)
      inWord = true
    } else if (isSpace) {
      inWord = false
    }
  }
  if (wordStarts.length === 0) return null
  const startIdx = Math.max(0, wordStarts.length - n)
  const charStart = wordStarts[startIdx]
  const docStart = posMap[charStart]
  if (typeof docStart !== 'number') return null
  return { from: docStart, to: a }
}

// Mirror of `_findPrecedingWordRange` but forward from `anchor`. Finds
// the END position of the Nth word after the anchor.
function _findFollowingWordRange(doc, anchor, n) {
  const a = Math.max(0, Math.min(anchor, doc.content.size))
  const allText = []
  const posMap = []
  doc.nodesBetween(a, doc.content.size, (node, pos) => {
    if (node.isText) {
      const text = node.text || ''
      const startOffset = Math.max(0, a - pos)
      for (let i = startOffset; i < text.length; i++) {
        allText.push(text[i])
        posMap.push(pos + i)
      }
    }
    return true
  })
  // Find word END positions in the collected text.
  const wordEnds = []
  let inWord = false
  for (let i = 0; i < allText.length; i++) {
    const isSpace = /\s/.test(allText[i])
    if (!isSpace && !inWord) {
      inWord = true
    } else if (isSpace && inWord) {
      wordEnds.push(i)
      inWord = false
    }
  }
  if (inWord) wordEnds.push(allText.length)
  if (wordEnds.length === 0) return null
  const endIdx = Math.min(wordEnds.length - 1, n - 1)
  const charEnd = wordEnds[endIdx]
  // `posMap` indexes the char itself; the end position is
  // one past the last char. For chars in the middle of the array,
  // `posMap[charEnd - 1] + 1` is the position just after that char.
  if (charEnd <= 0) return null
  const docEnd = (posMap[charEnd - 1] ?? a) + 1
  return { from: a, to: docEnd }
}

export default IpbAnchorDecorationExtension
