/**
 * Phase 4.3 — multi-row canvas layout geometry (pure helpers).
 *
 * These are the multi-row counterparts to the single-row helpers in
 * `chapterMembership.js`. They are PURE (no store reads beyond the
 * measured-dimension side store, same as `chapterMembership`) and cheap,
 * so they can be unit-tested without the canvas and called at render /
 * event time.
 *
 * The single-row code in `chapterMembership.js` is deliberately NOT
 * touched — when `Story.canvas_layout_mode === 'single'` (or
 * `chapter_rows` is null) callers use those x-only functions exactly as
 * today (the "rows off = byte-identical" guarantee). These multi-row
 * helpers only run when rows mode is active.
 *
 * Layout model (mirrors the single-row "derive from cumulative sums"
 * pattern, extended to 2D):
 *   - ROWS stack vertically from `rowsTopY`. Row i's top y is
 *     `rowsTopY + Σ(height_j + rowGap) for j < i`; its band is
 *     `[top, top + height_i]`. Heights live on `ChapterRow.height`;
 *     no per-row y is stored (self-healing on height/insert/delete,
 *     same as chapter x derives from widths).
 *   - COLUMNS within a row lay out left-to-right from `xOffset`
 *     (`Story.chapter_x_offset`), cumulative `Chapter.width` — exactly
 *     the single-row column rule, but restarted per row.
 *
 * A chapter belongs to exactly one row, so its cell (column × band) is
 * unambiguous; the cell's top-left is its "chapter-group origin" (§4 of
 * the planning doc).
 */

import { getMeasuredWidth, getMeasuredHeight } from './measuredDimensionsStore'

// Matches `ChapterRow.height` default in `backend/models/story.py`.
export const DEFAULT_ROW_HEIGHT = 600

// Phase 4.3 multi-row — the smallest a row's auto-fit height can be (an empty
// or very sparse row's floor). Auto-fit sizes a row to its tallest chapter's
// content, but never below this; it's also the floor the manual row-resize
// drag hard-stops at. Shared so the auto-refit and the manual drag agree.
export const MIN_ROW_HEIGHT = 120

// ── Multi-row vertical geometry (shared by the overlay render AND the
// mode-toggle repositioning, so node anchors line up with the rendered
// row bands). Defining them here keeps a single source of truth. ──
//
// `ROW_HEADER_RESERVED` is the vertical space each row reserves above its
// content band for that row's own header (act + chapter rows). It is a
// FIXED allowance (not the live `totalHeaderHeight`) so collapsing the
// acts row never reshuffles node positions. `ROWS_TOP_Y` is the flow-y
// where the first row begins; `ROW_VGAP` is the visible gap between one
// row's content-band bottom and the next row's header top.
export const ROW_HEIGHT_PX = 38.5         // one header row (matches ChapterColumnsOverlay)
// Header allowance reserved above each row's content band. Currently just
// the chapter header row (acts-per-row segments are a later 4.3d item; the
// allowance bumps when they land). `ROW_VGAP` is 0 so rows MEET — a row's
// content band bottom is flush with the next row's header top, no gap.
export const ROW_HEADER_RESERVED = ROW_HEIGHT_PX
export const ROWS_TOP_Y = 0
export const ROW_VGAP = 0

// Phase 4.3 multi-row — vertical gap between a row's content-band top (just
// under its header) and the TOP edge of the chapter's highest node, so the top
// node doesn't butt right against the header. FOUR snap increments (the 20-px
// dot grid, snapUtils.SNAP_STEP) so it reads as a clean four-cell margin. This
// is the hand-tuned value: at 20px the top node sat too close to the header and
// (because the header is a fixed on-screen height while this buffer scales with
// zoom) the header overlapped it well into the normal zoom range; 80px gives
// the cards visible breathing room and clears the overlap across the usable
// zoom range. Applied ONLY when the chapter carries a `content_origin_y` (i.e.
// once a single→multi switch has captured the chapter's content-top); when it's
// null the math falls back to today's offset-from-y=0 behaviour with no buffer.
export const ROW_CONTENT_TOP_BUFFER = 80

/**
 * The geometry params for `getRowBands` / `getChapterOriginMultiRow` /
 * `getChapterIdForNodeMultiRow` / `buildChapterLayout` so a node's
 * chapter-cell origin (`band.top`) is its content-band top, with the
 * row's header sitting in the `ROW_HEADER_RESERVED` band just above it.
 * `singleRowTopY` is 0: in single-row the chapter-relative offset is just
 * the node's absolute position minus the chapter's column-left, with y
 * measured from the canvas origin (see `toCanonicalPosition`).
 */
export function rowGeometryParams(xOffset = 0, headerRows = 1) {
  // `headerRows` = how many header rows each row reserves above its
  // content band: 1 (chapter header only — acts collapsed, the default)
  // or 2 (act header + chapter header — acts expanded). Defaults to 1 so
  // every caller that hasn't opted into the acts-aware geometry stays at
  // today's one-row allowance, i.e. collapsed = byte-identical to pre-acts.
  const reserved = headerRows * ROW_HEIGHT_PX
  return {
    xOffset,
    rowsTopY: ROWS_TOP_Y + reserved,
    rowGap: reserved + ROW_VGAP,
    singleRowTopY: 0,
    // The header-zone height each row owns above its content band. Pass
    // this (NOT the bare `ROW_HEADER_RESERVED` constant) to `rowIndexForTop`
    // so straddle-snap accounts for the act+chapter (2-row) header when acts
    // are expanded; with acts collapsed it equals `ROW_HEADER_RESERVED`.
    reserved,
  }
}

/**
 * The `computeStoryOrder` layout args for a story: the active mode, the
 * row grouping, and the derived vertical geometry. Spread into a
 * `computeStoryOrder({ ... })` call so order reads each node's canonical
 * (single-row) position regardless of the active mode. In single-row
 * mode this is a no-op (mode 'single', rows null). One helper so every
 * call site stays consistent.
 */
/**
 * Header rows reserved above each multi-row content band FOR THIS STORY:
 * 2 when the multi-row acts header is expanded (act row + chapter row),
 * else 1 (chapter row only — single-row, or acts collapsed, the default).
 * This is the single source the geometry helpers read so node anchors,
 * membership, story order, and the overlay all agree on the allowance.
 * `multirow_acts_expanded` is the per-story marker (also recording which
 * allowance the stored positions are anchored to).
 */
export function multirowHeaderRows(layoutMode, actsExpanded) {
  // Disaggregated variant for the compute paths (story order, alerts,
  // timeline, TOC) that thread `layoutMode` + the acts-expanded flag as
  // discrete values rather than the whole story object. 2 only when
  // multi-row AND acts expanded; 1 otherwise (single-row, or collapsed).
  return (layoutMode === 'multi' && actsExpanded) ? 2 : 1
}

export function multirowHeaderRowsForStory(story) {
  return multirowHeaderRows(story?.canvas_layout_mode, story?.multirow_acts_expanded)
}

export function storyLayoutArgs(story) {
  const xOffset = typeof story?.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
  const geom = rowGeometryParams(xOffset, multirowHeaderRowsForStory(story))
  return {
    layoutMode: story?.canvas_layout_mode || 'single',
    chapterRows: story?.chapter_rows || null,
    rowsTopY: geom.rowsTopY,
    rowGap: geom.rowGap,
    singleRowTopY: geom.singleRowTopY,
  }
}

/**
 * First-enable auto-wrap: greedily pack `chapters[]` (in order) into rows
 * so each row's cumulative `Chapter.width` stays within `wrapWidth`
 * (flow-px). Every row holds at least one chapter (a single chapter wider
 * than `wrapWidth` occupies its own row). Returns `ChapterRow`-shaped
 * objects `{ id, chapter_ids, height }`. Preserves row-major order, so
 * the flattening equals `chapters[]` (the §3 contract). `makeId` mints
 * row ids (injected so the caller controls id generation / determinism).
 */
export function wrapChaptersIntoRows(chapters, wrapWidth, makeId) {
  const rows = []
  let current = null
  let currentWidth = 0
  for (const c of (chapters || [])) {
    const w = c.width || 0
    if (current && currentWidth + w > wrapWidth && current.chapter_ids.length > 0) {
      rows.push(current)
      current = null
    }
    if (!current) {
      current = { id: makeId(), chapter_ids: [], height: DEFAULT_ROW_HEIGHT }
      currentWidth = 0
    }
    current.chapter_ids.push(c.id)
    currentWidth += w
  }
  if (current && current.chapter_ids.length > 0) rows.push(current)
  return rows
}

/**
 * The inclusive `[minIdx, maxIdx]` range of chapter indices whose single-row
 * columns a horizontal x-span `[left, right]` overlaps, or `null` when it
 * overlaps no chapter (an off-strip span). Columns are cumulative
 * `Chapter.width` from `xOffset` (the single-row rule). Overlap is strict
 * (`left < colRight && right > colLeft`) so a span merely flush against a
 * column edge does not count. Because chapters are contiguous, the overlapped
 * columns are always a contiguous range.
 *
 * Used to find which chapters a group box spans (its members' chapters), so
 * the multi-row wrap can keep those chapters on one row.
 */
export function chapterIndexSpanForXRange(left, right, chapters, xOffset = 0) {
  let cum = xOffset
  let minIdx = -1, maxIdx = -1
  for (let i = 0; i < (chapters || []).length; i++) {
    const colLeft = cum
    const colRight = cum + (chapters[i].width || 0)
    if (left < colRight && right > colLeft) {
      if (minIdx === -1) minIdx = i
      maxIdx = i
    }
    cum = colRight
  }
  return minIdx === -1 ? null : [minIdx, maxIdx]
}

/**
 * Adjust `rows` (a contiguous, row-major partition of `chapters`) so that no
 * row boundary falls INSIDE any group's chapter span — i.e. every chapter a
 * group spans stays on one row. `spans` is an array of inclusive
 * `[minIdx, maxIdx]` chapter-index intervals (from `chapterIndexSpanForXRange`).
 *
 * Because rows are a contiguous partition, "a span's chapters share a row"
 * reduces to "no cut sits between two chapters that are both inside the span".
 * Any row-break landing inside a span is removed by MERGING the two rows it
 * separated (keep-together; the merged row is wider — this is the caller's
 * chosen "wider row over a split" behaviour). The merged row keeps the earlier
 * row's id/flags and the taller of the two heights (row height is recomputed by
 * the caller's content-fit pass anyway).
 *
 * Pure and idempotent: re-running leaves an already-satisfying layout
 * unchanged, since every remaining boundary sits between spans, never inside
 * one. Returns `rows` unchanged when there is nothing to do.
 */
export function constrainRowsToGroupSpans(rows, chapters, spans) {
  if (!rows || rows.length <= 1 || !spans || spans.length === 0) return rows
  const nBoundaries = Math.max(0, (chapters || []).length - 1)
  if (nBoundaries === 0) return rows
  // A boundary "after chapter i" (i in 0..N-2) is forbidden when some span
  // [a, b] has a <= i < b (both chapter i and i+1 lie inside that span).
  const forbidden = new Array(nBoundaries).fill(false)
  for (const [a, b] of spans) {
    for (let i = a; i < b; i++) if (i >= 0 && i < nBoundaries) forbidden[i] = true
  }
  const idxById = new Map((chapters || []).map((c, i) => [c.id, i]))
  const out = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    let mergeIntoPrev = false
    if (prev && prev.chapter_ids.length > 0) {
      const prevLastIdx = idxById.get(prev.chapter_ids[prev.chapter_ids.length - 1])
      if (prevLastIdx != null && prevLastIdx >= 0 && prevLastIdx < nBoundaries && forbidden[prevLastIdx]) {
        mergeIntoPrev = true
      }
    }
    if (mergeIntoPrev) {
      prev.chapter_ids = prev.chapter_ids.concat(row.chapter_ids || [])
      prev.height = Math.max(prev.height || 0, row.height || 0)
    } else {
      out.push({ ...row, chapter_ids: [...(row.chapter_ids || [])], height: row.height || DEFAULT_ROW_HEIGHT })
    }
  }
  return out
}

/** Node width with the same fallback chain `chapterMembership._readNodeWidth`
 *  uses: explicit measured → side store → data.width → top-level → 0. */
function _readNodeWidth(node) {
  return node.measured?.width ?? getMeasuredWidth(node.id) ?? node.data?.width ?? node.width ?? 0
}

/** Node height with the parallel fallback chain. */
function _readNodeHeight(node) {
  return node.measured?.height ?? getMeasuredHeight(node.id) ?? node.data?.height ?? node.height ?? 0
}

/**
 * Derive each row's vertical band from cumulative heights.
 *
 * @param {Array<{id, chapter_ids, height}>} chapterRows
 * @param {number} rowsTopY  flow-space y where the first row's band starts
 * @param {number} rowGap    vertical gap between consecutive row bands
 * @returns {Array<{rowId, chapterIds, top, bottom, height}>}
 */
export function getRowBands(chapterRows, rowsTopY = 0, rowGap = 0) {
  const bands = []
  let top = rowsTopY
  for (const row of (chapterRows || [])) {
    const height = row.height || DEFAULT_ROW_HEIGHT
    bands.push({
      rowId: row.id,
      chapterIds: row.chapter_ids || [],
      top,
      bottom: top + height,
      height,
    })
    top += height + rowGap
  }
  return bands
}

/**
 * Phase 4.3 straddle-snap — the row index for a node by its TOP edge. Each row
 * owns the vertical zone `[band.top - headerReserve, band.bottom)`: its header
 * reserve plus its content band. Those zones tile contiguously, so a node's
 * top edge lands in exactly one row's zone, which is more robust than the
 * center-y test for a tall node that spans a divider (the top edge stays in
 * the intended row even when the center spills below the band). Returns the
 * row index clamped to `[0, bands.length-1]` (above the first zone ⇒ 0, below
 * the last ⇒ the last row), or -1 when there are no bands.
 */
export function rowIndexForTop(top, bands, headerReserve = 0) {
  if (!bands || bands.length === 0) return -1
  let r = 0
  for (let i = 0; i < bands.length; i++) {
    if (top >= bands[i].top - headerReserve) r = i
    else break
  }
  return r
}

/**
 * Column extents (left/right/width) for one row's chapters, laid out
 * left-to-right from `xOffset` with cumulative `Chapter.width`.
 *
 * @param {string[]} rowChapterIds
 * @param {Map<string, {width}>} chaptersById
 * @param {number} xOffset
 * @returns {Array<{chapterId, left, right, width}>}
 */
export function getRowColumns(rowChapterIds, chaptersById, xOffset = 0) {
  const cols = []
  let left = xOffset
  for (const cid of (rowChapterIds || [])) {
    const width = chaptersById.get(cid)?.width || 0
    cols.push({ chapterId: cid, left, right: left + width, width })
    left += width
  }
  return cols
}

/**
 * The chapter-group origin (cell top-left) for `chapterId` in multi-row
 * geometry: the chapter's column-left within its row + the row's band
 * top. Returns null when the chapter isn't in any row.
 */
export function getChapterOriginMultiRow(chapterId, chapterRows, chapters, xOffset = 0, rowsTopY = 0, rowGap = 0) {
  if (!chapterId || !chapterRows) return null
  const chaptersById = new Map((chapters || []).map((c) => [c.id, c]))
  const bands = getRowBands(chapterRows, rowsTopY, rowGap)
  for (const band of bands) {
    if (!band.chapterIds.includes(chapterId)) continue
    const cols = getRowColumns(band.chapterIds, chaptersById, xOffset)
    const col = cols.find((c) => c.chapterId === chapterId)
    if (col) {
      // Phase 4.3 — when the chapter has a captured content-top
      // (`content_origin_y`), its members are offset from `content_origin_y`
      // (see `getChapterOriginSingleRow`), so the cell's Y origin sits a small
      // buffer below the band top: the chapter's highest node lands just under
      // its row header. When null (legacy), no buffer — today's band-top math.
      const ch = chaptersById.get(chapterId)
      const buffer = (ch?.content_origin_y != null && Number.isFinite(ch.content_origin_y)) ? ROW_CONTENT_TOP_BUFFER : 0
      return { x: col.left, y: band.top + buffer }
    }
  }
  return null
}

/**
 * Flatten the row+column geometry into one per-chapter cell list for
 * rendering. Each entry is the chapter plus where its column sits within
 * its row and where that row's band sits vertically:
 *
 *   { id, title, colour, width, rowIndex, colIndex, left, rowTop, rowHeight,
 *     isRowFirst, isRowLast }
 *
 * `left` is the column-left WITHIN the row (cumulative widths from
 * `xOffset`, restarted per row); `rowTop` / `rowHeight` come from the
 * row band stacking. Chapters not present in any row (shouldn't happen
 * once `_repair_chapter_rows` has run, but defended here) are skipped.
 *
 * Pure: it only reads `chapters` (for width/title/colour) and
 * `chapterRows` (for grouping/heights). Used by the multi-row overlay
 * render; the single-row overlay keeps its own `edges` memo untouched.
 */
export function buildChapterLayout(chapters, chapterRows, xOffset = 0, rowsTopY = 0, rowGap = 0) {
  const chaptersById = new Map((chapters || []).map((c) => [c.id, c]))
  const bands = getRowBands(chapterRows, rowsTopY, rowGap)
  const cells = []
  bands.forEach((band, rowIndex) => {
    const cols = getRowColumns(band.chapterIds, chaptersById, xOffset)
    cols.forEach((col, colIndex) => {
      const chapter = chaptersById.get(col.chapterId)
      if (!chapter) return
      cells.push({
        id: chapter.id,
        title: chapter.title,
        colour: chapter.colour,
        width: col.width,
        rowIndex,
        colIndex,
        left: col.left,
        rowTop: band.top,
        rowHeight: band.height,
        isRowFirst: colIndex === 0,
        isRowLast: colIndex === cols.length - 1,
      })
    })
  })
  return { cells, bands }
}

/**
 * The single-row chapter origin (cell top-left) for `chapterId`: its
 * column-left in the canonical left-to-right strip (cumulative
 * `Chapter.width` from `xOffset`) and the single-row strip top `topY`.
 * Returns null when the chapter isn't in `chapters`.
 *
 * This is the single-row counterpart to `getChapterOriginMultiRow`; the
 * pair are the two anchors `toCanonicalPosition` maps a node between.
 */
export function getChapterOriginSingleRow(chapterId, chapters, xOffset = 0, topY = 0) {
  if (!chapterId) return null
  let left = xOffset
  for (const c of (chapters || [])) {
    if (c.id === chapterId) {
      // Phase 4.3 — Y origin is the chapter's content-top when captured
      // (`content_origin_y`), else the strip top `topY` (legacy / single-row
      // default). This is the single-row half of the content-relative offset;
      // its multi-row counterpart is `getChapterOriginMultiRow` (band top +
      // buffer). When null, both halves fall back to today's y=0 math.
      const oy = (c.content_origin_y != null && Number.isFinite(c.content_origin_y)) ? c.content_origin_y : topY
      return { x: left, y: oy }
    }
    left += c.width || 0
  }
  return null
}

/**
 * The CANONICAL (single-row) position of a node, given the active
 * layout. This is the position that story order must read so that
 * toggling layout modes never changes the computed order (the §2 hard
 * invariant): a node carries one mode-invariant chapter-relative offset,
 * and its absolute position is that offset applied to whichever mode's
 * chapter origin is active. Canonicalizing maps the live position back
 * onto the single-row strip so order always sees the same coordinates.
 *
 *   canonical = singleRowOrigin(chapter) + (livePosition - cellOrigin(chapter))
 *
 * Behaviour:
 *   - Single-row mode (or `chapterRows` absent/empty): identity. The
 *     live position already IS the canonical single-row position, so
 *     this returns it unchanged (the "rows off = nothing changes"
 *     guarantee — story order is byte-identical to today).
 *   - Multi-row mode, node is a chapter member: map out of the node's
 *     multi-row cell and back into its single-row column via the
 *     mode-invariant offset.
 *   - Multi-row mode, node is off-strip (no chapter): identity. Off-strip
 *     nodes keep their absolute position across modes (§4), so their
 *     canonical position is their live position.
 *
 * `singleRowTopY` is the y the single-row strip sits at; it cancels out
 * of the order computation (it shifts every member's canonical y by the
 * same constant), so its exact value only matters for round-tripping
 * with the repositioning code, which shares these origin helpers.
 *
 * @returns {{x:number, y:number}}
 */
export function toCanonicalPosition(node, opts = {}) {
  const {
    mode = 'single',
    chapters = [],
    chapterRows = null,
    xOffset = 0,
    rowsTopY = 0,
    rowGap = 0,
    singleRowTopY = 0,
  } = opts
  const pos = node?.position || { x: 0, y: 0 }
  if (mode !== 'multi' || !chapterRows || chapterRows.length === 0) return pos
  const chapterId = getChapterIdForNodeMultiRow(node, chapters, chapterRows, xOffset, rowsTopY, rowGap)
  if (!chapterId) return pos  // off-strip: keeps its absolute position
  const cell = getChapterOriginMultiRow(chapterId, chapterRows, chapters, xOffset, rowsTopY, rowGap)
  const single = getChapterOriginSingleRow(chapterId, chapters, xOffset, singleRowTopY)
  if (!cell || !single) return pos
  return { x: pos.x - cell.x + single.x, y: pos.y - cell.y + single.y }
}

/**
 * 2D chapter membership for a node in multi-row mode: the node's
 * center-y selects the row band; its center-x then selects the column
 * within that row's chapters. Returns the chapter id, or null when the
 * node's center is outside every row band (an "off-strip" node, which
 * keeps its absolute position — §4).
 *
 * Tie rules mirror the single-row `getChapterIdForNode` per axis:
 *   - Column: left-wins-on-tie; bbox overlapping into the leftmost /
 *     rightmost column (phantom-leading / -trailing) still counts as
 *     that column (any overlap with a single column wins).
 *   - Row: center-y in `[top, bottom)` selects the row; a center exactly
 *     on the bottom edge of the last row still belongs to the last row.
 *     A center above the first band or below the last band → null.
 *     (Node straddle-snap, which prevents a node ever sitting across a
 *     row divider, is an interaction concern handled at drop time in
 *     4.3e; this resolver just reads whatever position it's given.)
 *
 * @returns {string|null} chapter id
 */
export function getChapterIdForNodeMultiRow(node, chapters, chapterRows, xOffset = 0, rowsTopY = 0, rowGap = 0) {
  if (!node || !chapterRows || chapterRows.length === 0) return null
  const x = node.position?.x ?? 0
  const y = node.position?.y ?? 0
  const width = _readNodeWidth(node)
  const height = _readNodeHeight(node)
  const centerX = x + width / 2
  const centerY = y + height / 2
  const chaptersById = new Map((chapters || []).map((c) => [c.id, c]))
  const bands = getRowBands(chapterRows, rowsTopY, rowGap)
  if (bands.length === 0) return null

  // ── Row selection by center-y ──
  let band = null
  for (const b of bands) {
    // `centerY < bottom` for all but the last band gives a clean
    // top-closed / bottom-open interval; the last band is bottom-closed
    // so a center exactly on the final edge still resolves.
    const isLast = b === bands[bands.length - 1]
    if (centerY >= b.top && (isLast ? centerY <= b.bottom : centerY < b.bottom)) {
      band = b
      break
    }
  }
  if (!band) return null  // off-strip vertically → null membership

  // ── Column selection by center-x within the row (mirrors single-row) ──
  const cols = getRowColumns(band.chapterIds, chaptersById, xOffset)
  if (cols.length === 0) return null
  const firstLeft = cols[0].left
  const lastRight = cols[cols.length - 1].right
  const right = x + width
  // Phantom-leading: center left of the row's columns but bbox overlaps
  // the leftmost column → first column wins.
  if (centerX < firstLeft) {
    if (right > firstLeft) return cols[0].chapterId
    return null
  }
  for (const col of cols) {
    if (centerX <= col.right) return col.chapterId
  }
  // Phantom-trailing: center past the row's right edge but bbox still
  // overlaps the last column → last column wins.
  if (x < lastRight) return cols[cols.length - 1].chapterId
  return null
}
