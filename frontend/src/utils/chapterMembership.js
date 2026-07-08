/**
 * Chapter membership utilities for the Phase 1.11 column-division view.
 *
 * Chapter membership for plot point nodes is derived on-the-fly from the
 * node's x-position against the current chapter column boundaries — never
 * stored on the node itself. That self-healing property means insert /
 * reorder / resize / delete of chapters automatically updates which chapter
 * every node belongs to, with zero bookkeeping.
 *
 * Column layout: chapters are laid out left-to-right starting at x = 0. The
 * left edge of chapter N is the cumulative sum of `width` for chapters
 * 0..N-1; the right edge is the cumulative sum including N.
 *
 * "50/50 defaults left" rule: a node exactly centered on an internal divider
 * belongs to the chapter to the left of the divider. Equivalently, each
 * chapter's interval is left-open / right-closed `(prev_right, right]` except
 * chapter 0 which is `[0, width0]` (left-closed because there is no divider
 * at x = 0). A node centered exactly on the far-right edge of the LAST
 * chapter still belongs to the last chapter — "past the last column" means
 * `centerX > right_edge_of_last`, strict inequality.
 *
 * These functions are pure (no store reads) and cheap. Intended to be called
 * at render time from the spanning-triangle indicator (Track E), the table
 * of contents panel (Track H), and the export pipeline (Phase 1.12).
 */

import { getMeasuredWidth } from './measuredDimensionsStore'
import { getChapterIdForNodeMultiRow, rowGeometryParams, multirowHeaderRowsForStory } from './rowLayout'

/**
 * Read a node's effective width using the same fallback order as
 * `wireTidyUtils.getNodeBBox`: measured → measured-dimensions side
 * store → data.width → top-level width → 0. (Phase 4.1g #4:
 * auto-measured sizes live in the side store, not on store nodes.)
 * A width of 0 means "treat the node as a point at position.x".
 */
function _readNodeWidth(node) {
  return node.measured?.width ?? getMeasuredWidth(node.id) ?? node.data?.width ?? node.width ?? 0
}

/**
 * Return the id of the chapter containing the node's center-point x
 * (`position.x + width / 2`), or null if the center falls before the first
 * column or past the right edge of the last column.
 *
 * A center exactly on an internal divider belongs to the LEFT chapter
 * (50/50 defaults left). A center exactly on the far-right edge of the last
 * chapter belongs to that last chapter (consistent with the tie-left rule
 * at every other boundary).
 *
 * `xOffset` is the flow-space x where the first chapter's LEFT edge sits.
 * Defaults to 0 for backward compat; the Phase 1.11 overlay passes
 * `story.chapter_x_offset` (default 10 for canvas dot-grid alignment; can
 * go negative when the user drags chapter 0's left edge leftward).
 *
 * Returns null when any of:
 *   - `chapters` is empty or not provided
 *   - `node` is null/undefined
 *   - the center-point x is less than `xOffset` (before the first column)
 *   - the center-point x is strictly greater than the right edge of the
 *     last column (past the last chapter)
 */
export function getChapterIdForNode(node, chapters, xOffset = 0) {
  if (!chapters || chapters.length === 0) return null
  if (!node) return null
  const x = node.position?.x ?? 0
  const width = _readNodeWidth(node)
  const right = x + width
  const centerX = x + width / 2
  // Phantom-leading: center is left of all chapters. If the bbox
  // STILL extends into the leftmost chapter (right edge strictly past
  // xOffset), the node is treated as a member of that chapter — any
  // overlap with a single chapter wins. Otherwise it's truly phantom-
  // leading and returns null.
  if (centerX < xOffset) {
    if (right > xOffset) return chapters[0].id
    return null
  }
  let cumulative = xOffset
  for (const chapter of chapters) {
    const chapterRight = cumulative + (chapter.width || 0)
    // `centerX <= chapterRight` gives left-wins-on-tie at every boundary,
    // including the far-right edge of the last chapter (so a node centered
    // exactly at total_width belongs to the last chapter, not null).
    if (centerX <= chapterRight) return chapter.id
    cumulative = chapterRight
  }
  // Phantom-trailing: center is right of all chapters. If the bbox
  // left edge is still inside the last chapter, the node is a member
  // of that chapter (mirrors the phantom-leading rule above).
  if (x < cumulative) return chapters[chapters.length - 1].id
  return null
}

/**
 * Mode-aware chapter-membership dispatcher (Phase 4.3).
 *
 * Single source of truth for "which chapter is this node in" that
 * honours the active canvas layout mode. In single-row mode (the
 * default, and the only mode that existed before 4.3) this is
 * `getChapterIdForNode` verbatim — byte-identical behaviour, the
 * "rows off = nothing changes" guarantee. In multi-row mode it routes
 * to the 2D resolver `getChapterIdForNodeMultiRow` in `rowLayout.js`,
 * which selects a row band by center-y then a column by center-x.
 *
 * Callers that are intrinsically single-row (export pipeline, table of
 * contents) can keep calling `getChapterIdForNode` directly. The
 * canvas / overlay / repositioning paths that must follow the active
 * view call this dispatcher instead.
 *
 * The dispatcher falls back to the single-row path whenever the mode
 * isn't `'multi'` OR `chapterRows` is absent/empty, so a half-populated
 * multi-row state can never behave worse than single-row.
 *
 * Note: chapter membership is canvas geometry — it is NOT a
 * chain-tracked entity value. `chapter_rows` / `canvas_layout_mode`
 * are deliberately not chain-tracked (no per-scene history); they are
 * story-level view state.
 *
 * @param {object} node
 * @param {Array}  chapters     canonical `chapters[]` (row-major order)
 * @param {object} opts
 * @param {'single'|'multi'} [opts.mode='single']
 * @param {Array|null} [opts.chapterRows=null]
 * @param {number} [opts.xOffset=0]   `story.chapter_x_offset`
 * @param {number} [opts.rowsTopY=0]  flow-space y of the first row band
 * @param {number} [opts.rowGap=0]    vertical gap between row bands
 * @returns {string|null} chapter id
 */
export function resolveChapterIdForNode(node, chapters, opts = {}) {
  const {
    mode = 'single',
    chapterRows = null,
    xOffset = 0,
    rowsTopY = 0,
    rowGap = 0,
  } = opts
  if (mode === 'multi' && chapterRows && chapterRows.length > 0) {
    return getChapterIdForNodeMultiRow(node, chapters, chapterRows, xOffset, rowsTopY, rowGap)
  }
  return getChapterIdForNode(node, chapters, xOffset)
}

/**
 * Build the mode-aware `memberOpts` for `resolveChapterIdForNode` from a
 * story-level layout snapshot. Pure — pass the active `story` (or any object
 * exposing `canvas_layout_mode` / `chapter_rows` / `chapter_x_offset`).
 *
 * This is the single source for the opts shape so every caller stays in
 * lockstep: `resolveChapterIdForNode(node, chapters, chapterMemberOptsForStory(story))`.
 * `xOffset` defaults to 10 (the canvas dot-grid default, matching
 * `storyLayoutArgs` and the backend port) when the story doesn't carry one.
 */
export function chapterMemberOptsForStory(story) {
  const xOffset = typeof story?.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
  const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
  return {
    mode: story?.canvas_layout_mode || 'single',
    chapterRows: story?.chapter_rows || null,
    xOffset,
    rowsTopY: geom.rowsTopY,
    rowGap: geom.rowGap,
  }
}

/**
 * Mode-aware chapter id for a node, resolving the layout straight from a
 * `story` object. Pure convenience over `resolveChapterIdForNode` +
 * `chapterMemberOptsForStory`.
 *
 * USE THIS (or the hook `useChapterMemberOpts` in components) anywhere a
 * node's LIVE / stored canvas position is read for chapter membership.
 * Raw `getChapterIdForNode` is single-row x-only and is correct ONLY on
 * canonical / projected positions (e.g. the story-order canonicalization or
 * a freshly-imported single-row story) — never on a live multi-row position.
 */
export function resolveChapterIdForNodeForStory(node, story) {
  return resolveChapterIdForNode(node, story?.chapters || [], chapterMemberOptsForStory(story))
}

/**
 * Return the x-coordinate of a chapter divider that the node's bounding box
 * strictly straddles (left edge strictly less than the divider AND right
 * edge strictly greater than the divider), or null if the node is fully
 * inside one chapter or touching a divider without crossing it.
 *
 * A node whose right edge is exactly on a divider does NOT count as
 * straddling — it is flush against the boundary but still entirely inside
 * the left chapter. Same for a node whose left edge is exactly on a divider
 * (entirely inside the right chapter).
 *
 * If the node straddles multiple dividers (a very wide node spanning more
 * than two chapters) this returns the first (leftmost) straddled divider.
 * Track E only uses this to decide whether to render the spanning-triangle
 * indicator at all; the "which chapter" decision is made by
 * `getChapterIdForNode` using the center-point rule.
 *
 * `xOffset` is the flow-space x where the first chapter's LEFT edge sits
 * (same meaning as in `getChapterIdForNode`). Defaults to 0 for backward
 * compat.
 *
 * Returns null when any of:
 *   - `chapters` is empty, missing, or has fewer than 2 chapters (no
 *     internal dividers exist)
 *   - `node` is null/undefined
 *   - the node's bbox does not strictly straddle any internal divider
 */
export function getSpanningDividerX(node, chapters, xOffset = 0) {
  if (!chapters || chapters.length < 2) return null
  if (!node) return null
  const x = node.position?.x ?? 0
  const width = _readNodeWidth(node)
  const left = x
  const right = x + width
  let cumulative = xOffset
  for (let i = 0; i < chapters.length - 1; i++) {
    cumulative += chapters[i].width || 0
    // `cumulative` is now the x-coordinate of the divider between chapter i
    // and chapter i + 1. Strict inequalities: a node flush against the
    // divider is NOT straddling.
    if (left < cumulative && cumulative < right) {
      return cumulative
    }
  }
  return null
}

/**
 * Like `getSpanningDividerX` but also covers the two phantom-region
 * boundaries: the LEFT edge of the leftmost chapter (where the bbox
 * extends into the phantom-leading region beside `chapters[0]`) and
 * the RIGHT edge of the last chapter (where the bbox extends into the
 * phantom-trailing region). Returns
 *
 *     { x, chapterSide, kind }
 *
 * where:
 *   - `x` is the boundary's flow-space x-coordinate.
 *   - `chapterSide` is which side of the node's bbox the chapter
 *     portion occupies. For internal dividers (chapter on both sides)
 *     this is decided by the center-point rule that
 *     `getChapterIdForNode` uses (left-wins-on-tie). For phantom
 *     boundaries the chapter is unambiguously on one side: 'right'
 *     for the leftmost boundary, 'left' for the rightmost.
 *   - `kind` is 'internal' | 'leftmost' | 'rightmost' — lets the
 *     caller pick a positioning rule appropriate to the boundary
 *     type. The leftmost/rightmost boundary indicator should always
 *     fire when the bbox straddles, regardless of where the center
 *     sits, because the existence of any overlap with the chapter
 *     side IS the signal the writer needs to see (they may have
 *     dragged a scene partly off the chapter strip).
 *   - `chapterIdx` is the index of the chapter the bbox is overlapping
 *     INTO on the `chapterSide` side of the boundary. For 'leftmost'
 *     this is always 0; for 'rightmost' always `chapters.length - 1`;
 *     for 'internal' it's the chapter index decided by the center-rule
 *     above (i.e. the chapter the node "belongs" to). Lets callers
 *     compute that chapter's far edge for clamping rules without
 *     re-walking widths.
 *
 * Trigger conditions:
 *   - Internal divider: bbox strictly straddles the divider.
 *   - Phantom boundary: bbox strictly straddles the boundary. (No
 *     center check — see kind contract above.)
 *
 * If the bbox straddles multiple boundaries (e.g. a very wide node
 * spanning more than two chapters), the leftmost-encountered match
 * wins — same convention as `getSpanningDividerX`.
 *
 * Returns null when `chapters` is empty / missing, `node` is null, or
 * the bbox doesn't strictly straddle any boundary.
 */
export function getSpanningBoundary(node, chapters, xOffset = 0) {
  if (!chapters || chapters.length === 0) return null
  if (!node) return null
  const x = node.position?.x ?? 0
  const width = _readNodeWidth(node)
  const left = x
  const right = x + width
  const centerX = x + width / 2

  // Leftmost boundary: chapters[0]'s left edge | phantom-leading.
  // Fires whenever the bbox straddles, regardless of center — the
  // partial overlap IS what we want to surface.
  if (left < xOffset && xOffset < right) {
    return { x: xOffset, chapterSide: 'right', kind: 'leftmost', chapterIdx: 0 }
  }

  // Internal dividers between adjacent chapters. Center-rule decides
  // which chapter the node belongs to (left-wins-on-tie).
  let cumulative = xOffset
  for (let i = 0; i < chapters.length - 1; i++) {
    cumulative += chapters[i].width || 0
    if (left < cumulative && cumulative < right) {
      const side = centerX <= cumulative ? 'left' : 'right'
      return {
        x: cumulative,
        chapterSide: side,
        kind: 'internal',
        // Chapter index the bbox is in on the chosen side: side='left'
        // → chapter i (the chapter to the left of the divider); side='right'
        // → chapter i+1.
        chapterIdx: side === 'left' ? i : i + 1,
      }
    }
  }

  // Rightmost boundary: last chapter's right edge | phantom-trailing.
  // Fires whenever the bbox straddles, regardless of center.
  cumulative += chapters[chapters.length - 1].width || 0
  if (left < cumulative && cumulative < right) {
    return { x: cumulative, chapterSide: 'left', kind: 'rightmost', chapterIdx: chapters.length - 1 }
  }

  return null
}
