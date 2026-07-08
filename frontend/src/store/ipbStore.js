/**
 * ipbStore — Inline Prompt Block singleton state (Phase 2.9c item 2).
 *
 * The IPB is a session-only floating React UI — at most one exists
 * across the whole editor at a time (planning doc §4.10 "singleton").
 * This store holds the IPB's wrapper state: whether it's active,
 * where its chrome sits on screen, which editor surface it was
 * created against, and (in item 3) its anchor in the doc.
 *
 * Per planning doc §4.10:
 *   - Singleton across the editor.
 *   - NOT a TipTap document node — chrome lives outside the doc
 *     tree as a floating React UI portaled to body.
 *   - Session-only — never persisted, cleared on reload.
 *
 * The IPB's FORM state (the prompt picker / message / model picker
 * etc. — the same fields the Prompt Block Header has) lives in
 * `sectionPromptBlocksStore` keyed by the sentinel id
 * `'__ipb__'` (exported from this module as `IPB_FORM_KEY`) so the
 * shared `PromptBlockForm` component reads from the same store
 * shape regardless of whether it's rendering for PBH or IPB. This
 * store covers only the wrapper concerns: position, surface,
 * anchor.
 *
 * State shape:
 *
 *   {
 *     active: boolean,                      // null|true; true when IPB is mounted
 *     chromePos: { left, top } | null,      // screen coords of the chrome
 *     surface_type: string | null,          // editor surface tuple — captured at creation,
 *     surface_host_id: string | null,       //   used to scope edits to the right surface
 *     anchor: null,                         // item 3: cursor or range anchor in the doc
 *   }
 */

import { create } from 'zustand'

/**
 * Sentinel id used as the `sectionId` for the IPB's form state inside
 * `sectionPromptBlocksStore`. The store is keyed by Section id; this
 * sentinel is reserved so IPB form state coexists cleanly with PBH
 * entries (no real Section will ever own this id — section ids are
 * UUIDs).
 */
export const IPB_FORM_KEY = '__ipb__'

/**
 * Module-level non-reactive handle on the TipTap editor instance the
 * IPB is currently scoped to. Set by `RichTextEditor` when the IPB is
 * opened from its toolbar / right-click chooser, cleared on dismiss /
 * editor unmount. `InlinePromptBlock` (which mounts at the App level
 * and otherwise has no editor reference because it lives outside the
 * editor's React tree) reads this on Send to dispatch transactions
 * against the right editor.
 *
 * Held outside Zustand state so writes to it don't trigger re-renders —
 * the editor instance is a stable handle, not a piece of reactive UI
 * state.
 */
const _ipbEditorRef = { current: null }

export function setIpbEditor(editor) {
  _ipbEditorRef.current = editor || null
}

export function getIpbEditor() {
  return _ipbEditorRef.current
}

export const useIpbStore = create((set) => ({
  active: false,
  chromePos: null,
  surface_type: null,
  surface_host_id: null,
  anchor: null,

  /**
   * Transient context-preview hint for the IPB cursor-mode
   * Before/After context pills (writer spec 2026-05-27). When the
   * writer hovers a pill or has its slider popover open, the form
   * sets `{ side: 'preceding' | 'following', count }` here so the
   * editor decoration paints the corresponding word range in
   * story-accent tint — same visual as the section-mode anchor
   * range, separate function (this is a transient preview, the
   * anchor itself isn't changed). Cleared on hover-out (with the
   * pill's existing 150ms debounce) so the preview goes away when
   * the writer moves on.
   *
   * The decoration plugin computes the actual `{ from, to }`
   * doc-position range from `{ side, count }` against the current
   * anchor position — the store doesn't carry positions because
   * (a) they'd go stale as the writer types elsewhere and (b)
   * positions belong to the editor, not the IPB chrome state.
   */
  contextPreview: null,

  /**
   * Screen coords of the IPB text cursor (cursor mode only) —
   * `{ left, top, height }` in viewport pixels, or null when the
   * cursor isn't visible (no anchor, anchor at a non-textblock
   * position, anchor scrolled outside the editor's visible area).
   * Computed by `IpbAnchorDecoration`'s position tracker on every
   * editor scroll / resize / doc change / anchor change.
   *
   * Rendered by `InlinePromptBlock` as a portal'd `position: fixed`
   * div (NOT a ProseMirror widget decoration). Two reasons we
   * moved the cursor OUT of the editor's DOM:
   *   1. **Spell-check word splitting.** The earlier widget was a
   *      `<span>` inserted into the text content; the browser's
   *      spell checker treated the surrounding text as two
   *      separate words (`hel<span/>lo` → "hel" + "lo"), red-
   *      squiggling correctly-spelled words mid-cursor.
   *   2. **Layout impact at block boundaries.** An `inline-block`
   *      widget at a gutter position would trigger an anonymous
   *      line box, painting as a phantom blank line.
   * The position-fixed div is outside the contentEditable, so the
   * spell checker never sees it and the editor's layout is
   * untouched.
   */
  cursorScreenPos: null,

  /**
   * Transient flag set while the writer is actively dragging the
   * IPB's drag handle. When true, the chrome morphs into the pin
   * shape (without the spinning coin — that's reserved for actual
   * AI streaming) so the writer can position the IPB precisely
   * without the wide form covering the text underneath. Cleared on
   * pointerup / pointercancel; reverts the chrome to whatever shape
   * it was in before the drag started (form OR streaming pin if a
   * stream is somehow in flight — though the drag handle isn't
   * reachable during streaming).
   */
  isDragging: false,

  setIsDragging: (v) => set({ isDragging: !!v }),

  /**
   * Create / re-open the IPB at the given chrome position + surface
   * tuple. Caller (the editor toolbar's IPB button or the right-click
   * chooser) computes the position via the cascade rule in planning
   * doc §4.10: IPB's prior anchor screen coords → writer's current
   * native cursor → top of visible editor viewport.
   *
   * `anchor` (optional) — the IPB's own anchor in the doc. Cursor
   * mode is `{ kind: 'cursor', pos }`; section mode (item 3) is
   * `{ kind: 'range', from, to }`. The anchor is painted as a
   * story-accent ProseMirror decoration in the editor so the writer
   * always sees what the IPB is targeting, distinct from the
   * browser-native cursor.
   */
  open: ({ chromePos, surface_type, surface_host_id, anchor }) => set({
    active: true,
    chromePos: chromePos && typeof chromePos.left === 'number' && typeof chromePos.top === 'number'
      ? { left: chromePos.left, top: chromePos.top }
      : null,
    surface_type: surface_type || null,
    surface_host_id: surface_host_id || null,
    anchor: anchor || null,
  }),

  /**
   * Patch the anchor — used by Ctrl+click / Ctrl+drag retarget
   * (item 3). Caller passes the new anchor shape directly.
   */
  setAnchor: (anchor) => set({ anchor: anchor || null }),

  /**
   * Set / clear the cursor-mode Before/After context-pill hover
   * preview. Pass `{ side: 'preceding' | 'following', count }` to
   * show the preview, or `null` to clear it. The decoration plugin
   * watches this state and paints the word-range when set.
   */
  setContextPreview: (preview) => {
    if (!preview) return set({ contextPreview: null })
    if (preview.side !== 'preceding' && preview.side !== 'following') return
    if (typeof preview.count !== 'number' || preview.count <= 0) return set({ contextPreview: null })
    return set({ contextPreview: { side: preview.side, count: preview.count } })
  },

  /**
   * Set / clear the IPB cursor's screen position. Pass
   * `{ left, top, height, visible? }` (viewport pixels) when the
   * cursor's anchor is resolvable; null when there's no resolvable
   * anchor at all (anchor cleared, range mode, non-textblock position).
   *
   * `visible` (v0.2.9.45) — true when the cursor's screen rect is
   * inside the editor's scroll-container visible area; false when
   * scrolled off-screen. The render side (InlinePromptBlock) gates
   * cursor display on this flag. The sticky-scroll subsystem in
   * `IpbAnchorDecoration` reads the position UNCONDITIONALLY so it
   * can still chase the cursor when it's off-screen — that was the
   * previous bug where streaming writes pushed the cursor past the
   * visible bottom + sticky-scroll silently bailed because the
   * position field was being nulled on visibility loss.
   */
  setCursorScreenPos: (pos) => {
    if (!pos) return set({ cursorScreenPos: null })
    if (typeof pos.left !== 'number' || typeof pos.top !== 'number' || typeof pos.height !== 'number') return
    return set({ cursorScreenPos: {
      left: pos.left,
      top: pos.top,
      height: pos.height,
      visible: pos.visible !== false,
    } })
  },

  /**
   * Dismiss the IPB — clears the singleton. Anchor + form state are
   * also cleared (the IPB lifecycle ends when dismissed; reopening
   * starts fresh).
   */
  dismiss: () => set({
    active: false,
    chromePos: null,
    surface_type: null,
    surface_host_id: null,
    anchor: null,
    contextPreview: null,
    cursorScreenPos: null,
    isDragging: false,
  }),

  /**
   * Patch chrome position on drag. Item 6 wires the drag handle to
   * call this; for v1 of item 2 we just expose the action.
   */
  /**
   * Set the chrome position. Accepts either:
   *   - `setChromePos({ left, top })` — top-edge-anchored
   *   - `setChromePos({ left, bottom })` — bottom-edge-anchored
   *     (chrome's bottom sits at `bottom` px from the viewport bottom)
   *   - `setChromePos(left, top)` — legacy two-arg shape (top-anchored)
   *
   * Bottom-anchoring is used in range mode (chrome sits above the
   * selection top, grows upward as it expands) and in the cursor-mode
   * vertical-flip case. Top-anchoring is the normal cursor-mode-below
   * case.
   */
  setChromePos: (a, b) => {
    if (a && typeof a === 'object') {
      const { left, top, bottom } = a
      if (typeof left !== 'number') return
      if (typeof top === 'number') return set({ chromePos: { left, top } })
      if (typeof bottom === 'number') return set({ chromePos: { left, bottom } })
      return
    }
    if (typeof a === 'number' && typeof b === 'number') {
      return set({ chromePos: { left: a, top: b } })
    }
  },
}))
