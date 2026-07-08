/**
 * TimelineGridView — Phase 1.12c Track 1.
 *
 * Shared presentational component extracted from `ImportTimelineGrid`
 * so the Phase 1.12c Timeline Navigator can reuse the same visual grid
 * without duplicating render logic. The Import dialog now wraps this
 * component and wires its commit-specific state + handlers in via
 * props; the Timeline Navigator wraps it with navigation-specific
 * handlers and no commit state at all.
 *
 * Architecture summary:
 *
 *   ImportTimelineGrid (thin wrapper)
 *     ↓ passes preview + gridEntities + importPicks + selectedRowIds
 *     ↓ + on*Click handlers that commit picks + tooltips
 *     TimelineGridView (this file)
 *
 *   TimelineNavigatorPanel (future, Phase 1.12c Track 4)
 *     ↓ passes preview + gridEntities + null for importPicks / selection
 *     ↓ + on*Click handlers that navigate + tooltips
 *     TimelineGridView (this file)
 *
 * What this component renders (unchanged from the pre-extract
 * ImportTimelineGrid):
 *
 *   - Three-row sticky header strip: Act banners (when present),
 *     Chapter banners (when present), Scene column titles with
 *     Origin + Final synthetic bookends.
 *   - One body row per entity with a sticky-left identity cell
 *     (thumb + name + type icon + optional remove ✕) and a body
 *     strip of scene-column cells + modifier dots + horizontal
 *     chain line.
 *   - Optional current-pick ring overlay per row when `importPicks`
 *     is supplied.
 *
 * What behaves differently from the pre-extract version:
 *
 *   - **Row selection is opt-in**. When `setSelectedRowIds` is null,
 *     identity cells render without pointer handlers / cursor-pointer
 *     / hover bg — row selection is effectively disabled for the
 *     Navigator use case where nothing operates on "selected rows".
 *   - **The "Entity" header** is a select-all toggle button when
 *     row selection is enabled; a plain label when it isn't.
 *   - **The ✕ remove button** only renders when `onRemoveEntity` is
 *     supplied. Import dialog passes it; Navigator doesn't.
 *   - **Pick-ring rendering** only happens when `importPicks` is
 *     non-null. Navigator passes null → no rings.
 *   - **Tooltip text** is customisable per-element via the
 *     `*Tooltip` props — Import dialog overrides with "Pick X for
 *     N selected"; Navigator overrides with "Navigate to X" etc.
 *     Default tooltips use the column / chapter / act title alone.
 */

import { memo, useCallback, useMemo, useRef } from 'react'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { RelationshipIcon, RelationshipLabelStack } from '../ui/IdentityBadges'
import { useEntitiesStore } from '../../store/entitiesStore'

// ── Layout constants ───────────────────────────────────────────────
// Kept as constants (not tokens) so a designer can tweak them in one
// place without reading through JSX.
export const IDENTITY_CELL_W_DEFAULT = 180
export const ORIGIN_FINAL_W  = 52
const SCENE_COL_W     = 56
const ROW_H           = 36
const DOT_SIZE        = 12
// Modifier dots are rendered smaller than scene dots so they read
// as a secondary / "inline" state-point without visually competing
// with the scene strip's rhythm. Reduced from 10 → 8 in v0.1.12.52
// to make room for multiple modifier dots between the same two
// scene columns when they're placed at evenly-spaced fractions
// instead of canvas-x-interpolated positions (the previous version
// stacked them on top of each other when their canvas x-values
// were close or identical).
const MOD_DOT_SIZE    = 8
// Origin / Final bookend dots are rendered as an inline SVG that
// mimics the `◉` (U+25C9 "fisheye") glyph — a thin outer ring with
// a filled inner disc — tinted with the entity colour. Sized slightly
// larger than the scene `DOT_SIZE` so they read clearly as terminal
// markers. Switched from the unicode character to SVG in v0.1.12.56
// because font baseline metrics put the visual centre of the glyph
// slightly below the line-box centre, so the unicode glyph never
// landed perfectly on the chain line; the SVG centres exactly inside
// its viewBox.
const BOOKEND_GLYPH_SIZE = 18
const ACT_ROW_H       = 18
const CHAPTER_ROW_H   = 18
const SCENE_HEADER_H  = 48

// Default chapter / act tint when the user hasn't set a custom
// colour. Matches `DEFAULT_CHAPTER_COLOUR` in
// `frontend/src/components/canvas/ChapterColumnsOverlay.jsx`
// (zinc-500) so the navigator's default tint visually agrees
// with the canvas.
const DEFAULT_BANNER_COLOUR = '#71717a'

/**
 * Convert a 6-character hex colour (`#RRGGBB`) plus an alpha in
 * `[0, 1]` into a CSS `rgba(r, g, b, a)` string. Used for the
 * chapter / act banner backgrounds so they tint by the user's
 * chosen `chapter.colour` / `act.colour` at the same opacity the
 * canvas uses for act headers (0.18). Falls back to
 * `DEFAULT_BANNER_COLOUR` if the input isn't a valid 6-char hex.
 */
function hexToRgba(hex, alpha) {
  const fallback = DEFAULT_BANNER_COLOUR
  const value = (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex : fallback
  const r = parseInt(value.slice(1, 3), 16)
  const g = parseInt(value.slice(3, 5), 16)
  const b = parseInt(value.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Phase 2.7c ring-style overlay. Renders one absolutely-positioned
 * accent-coloured circle centred on the parent dot, with line style
 * picked by `kind`:
 *   - 'solid'  → this entry's draft selection (Phase 2.7c selection state)
 *   - 'dashed' → another committed entry's coverage of this point
 *   - 'dotted' → a dynamic entry's current resolution lands here
 * All three share the same accent colour and ring geometry; only
 * `border-style` differentiates. Pointer-events:none so it doesn't
 * intercept clicks on the dot. Pass a unique key when used in a
 * stack so React can reconcile correctly.
 */
function _ChainPointRing({ dotSize, kind, offset = 10, dimmed = false }) {
  const styleByKind = {
    solid:  'solid',
    dashed: 'dashed',
    dotted: 'dotted',
  }
  const colour = kind === 'dotted'
    ? 'rgba(161, 161, 170, 0.85)'  // zinc-400, slightly translucent
    : 'var(--color-accent-500, #a855f7)'
  return (
    <div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: dotSize + offset,
        height: dotSize + offset,
        // `inset: 0; margin: auto` centres the ring in the offset
        // parent's padding box with integer-pixel snapping. The
        // previous `left/top: 50% + transform: translate(-50%, -50%)`
        // approach went through the transform pipeline, which rounds
        // sub-pixel positions differently than the dot's flex
        // centring does — visible as a barely-perceptible 1px halo
        // offset at 100% and 120% zoom (the cell's content width is
        // odd-pixel because of the 1px `border-r`, so the centres
        // land on .5 fractional positions and the two rounding paths
        // diverge).
        inset: 0,
        margin: 'auto',
        border: `2px ${styleByKind[kind] || 'solid'} ${colour}`,
        boxShadow: kind === 'solid' ? '0 0 0 1px rgba(0,0,0,0.4)' : 'none',
        opacity: dimmed ? 0.55 : 1,
      }}
    />
  )
}


/**
 * Inline SVG fisheye — replicates the `◉` glyph (a thin outer ring
 * + filled inner disc) at exact pixel size. Centred inside its own
 * `viewBox` so it lands precisely on whatever flex axis it's placed
 * in, regardless of font metrics.
 *
 * Geometry (viewBox 0 0 20 20):
 *   - Outer ring:  cx=10 cy=10 r=8.25, stroke=currentColor strokeWidth=1.5, fill=none
 *   - Inner disc:  cx=10 cy=10 r=4.5, fill=currentColor
 *
 * Both shapes draw in `currentColor`, so the parent button's
 * `style.color` (set to the entity colour) tints the whole glyph.
 */
function BookendDotGlyph({ size }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="4.5" fill="currentColor" />
    </svg>
  )
}

/**
 * Thumb used in the identity cell — matches the canonical pattern from
 * EntityLibraryPanel.jsx:76-90. Local to this file so the grid can
 * size the chip independently of the picker's smaller thumb (which
 * lives in ImportDialog.jsx).
 */
/**
 * Identity-cell thumbnail. Defaults to the entity's origin colour +
 * profile image; accepts optional `effectiveColour` / `effectiveSrc`
 * overrides so the caller can display effective state at the user's
 * currently-picked chain point. When either override is null /
 * undefined, falls through to the origin value.
 */
function GridThumb({ entity, effectiveColour, effectiveSrc }) {
  const colour = effectiveColour || entity.colour || '#888888'
  const src    = effectiveSrc != null ? effectiveSrc : (entity.profile_image_data_uri || null)
  return (
    <ImageHoverPreview src={src} borderColour={colour}>
      {src ? (
        <img
          src={src}
          alt=""
          className="w-7 h-7 rounded-sm object-cover flex-shrink-0"
          style={{ border: `1.5px solid ${colour}` }}
        />
      ) : (
        <span
          className="w-7 h-7 rounded-sm flex items-center justify-center flex-shrink-0 text-sm"
          style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
        >
          {entity.type === 'relationship'
            ? <RelationshipIcon size={16} />
            : (TYPE_ICONS[entity.type] || '?')}
        </span>
      )}
    </ImageHoverPreview>
  )
}

/**
 * Resolve the currently-picked chain-point's effective state for a
 * row, returning `{name, colour, src}`. Falls back to the entity's
 * origin state when no pick is set, or when the picked dot is
 * missing effective-state data (e.g. backend-built preview rows
 * before effective-state emission was wired in). Phase 1.12c
 * v0.1.12.57 / .58.
 */
function resolveIdentityState(entity, pick) {
  const originName   = entity.name || ''
  const originColour = entity.colour || '#888888'
  const originSrc    = entity.profile_image_data_uri || null
  const fallback = { name: originName, colour: originColour, src: originSrc }
  if (!pick) return fallback
  if (pick.kind === 'origin') return fallback
  if (pick.kind === 'final') {
    return {
      name:   entity.final_name   || originName,
      colour: entity.final_colour || originColour,
      src:    entity.final_profile_image_data_uri || originSrc,
    }
  }
  const dots = entity.dots || []
  if (pick.kind === 'scene') {
    const dot = dots.find((d) => !d.is_modifier && d.column_id === pick.scene_id)
    return {
      name:   dot?.effective_name   || originName,
      colour: dot?.effective_colour || originColour,
      src:    dot?.effective_profile_image_data_uri || originSrc,
    }
  }
  if (pick.kind === 'modifier') {
    const dot = dots.find((d) => d.is_modifier && d.modifier_node_id === pick.modifier_node_id)
    return {
      name:   dot?.effective_name   || originName,
      colour: dot?.effective_colour || originColour,
      src:    dot?.effective_profile_image_data_uri || originSrc,
    }
  }
  return fallback
}

/**
 * Turn the backend preview's columns list into the frontend grid's
 * column list by flanking it with Origin + Final synthetic columns.
 *
 * The synthetic columns carry the same shape as scene columns (id,
 * title, chapter_id, is_pov_chain, chain_index, canvas_x) so the rest
 * of the render loop doesn't have to branch. They use sentinel ids
 * `__origin__` / `__final__` which never collide with a real uuid.
 */
function buildGridColumns(preview) {
  if (!preview?.columns) return []
  return [
    {
      id: '__origin__',
      title: 'Origin',
      chapter_id: null,
      is_pov_chain: false,
      chain_index: 0,
      _kind: 'origin',
    },
    ...preview.columns.map((c) => ({ ...c, _kind: 'scene' })),
    {
      id: '__final__',
      title: 'Final',
      chapter_id: null,
      is_pov_chain: false,
      chain_index: null,
      _kind: 'final',
    },
  ]
}

/**
 * Given an entity's `dots[]` from the preview and the full grid column
 * list, return a Set of column ids where the entity has a SCENE dot
 * rendered. Origin + Final are implicit — every entity renders a dot
 * at both bookends — so they always appear in the set. Modifier dots
 * are NOT tracked here (they're positioned absolutely in the row
 * body via `buildEntityModifierDots` + `modifierGridX` instead of
 * occupying a column cell).
 */
function buildEntityDotColumns(entity) {
  const set = new Set()
  set.add('__origin__')
  set.add('__final__')
  for (const dot of entity.dots || []) {
    if (dot.is_modifier) continue
    if (dot.column_id) set.add(dot.column_id)
  }
  return set
}

/**
 * Return the entity's modifier dots as a plain array, sorted in
 * global Story Order when `storyOrder` is provided (preferred path)
 * or by canvas_x otherwise (fallback for non-hook render paths).
 *
 * Spreads each source dot via `{ ...dot }` so any optional fields
 * the row builder may have attached — currently `chain_left_scene_id`
 * + `chain_right_scene_id` from `_modifierBracketing` (Phase 1.12c
 * v0.1.12.53) — survive into `placeModifierDots`'s bracketing
 * resolution. Earlier versions of this helper hand-picked only
 * `modifier_node_id` / `canvas_x` / `chain_index` and silently
 * dropped the bracketing fields, which made the v0.1.12.53 chain-
 * order bracketing fix a no-op. Bug fixed in v0.1.12.54.
 */
function buildEntityModifierDots(entity, storyOrder) {
  const mods = []
  for (const dot of entity.dots || []) {
    if (!dot.is_modifier || !dot.modifier_node_id) continue
    mods.push({ ...dot })
  }
  if (storyOrder && Array.isArray(storyOrder.orderedIds)) {
    const idx = new Map(storyOrder.orderedIds.map((id, i) => [id, i]))
    const BIG = Number.MAX_SAFE_INTEGER
    mods.sort((a, b) => {
      const ai = idx.get(a.modifier_node_id)
      const bi = idx.get(b.modifier_node_id)
      const aRank = ai == null ? BIG : ai
      const bRank = bi == null ? BIG : bi
      if (aRank !== bRank) return aRank - bRank
      return (a.canvas_x || 0) - (b.canvas_x || 0)
    })
  } else {
    mods.sort((a, b) => a.canvas_x - b.canvas_x)
  }
  return mods
}

/**
 * Place an entity's modifier dots within the scene strip. Returns
 * an array of `{ mod, fraction }` entries — one per modifier — where
 * `fraction` is in `[0, 1]` of the scene strip width. Caller renders
 * each dot with `left: <fraction * 100>%`.
 *
 * **Even spacing per bracketing pair** (Phase 1.12c v0.1.12.52 — fix
 * for the bug where multiple modifiers between the same two scenes
 * stacked on top of each other when their canvas x-values were
 * close or identical):
 *
 *   1. Group modifiers by which two scene columns bracket them
 *      (same canvas_x bracketing logic as the pre-v0.1.12.52
 *      implementation).
 *   2. Within each group, sort by `chain_index` so the visual
 *      left-to-right order matches the narrative chain order
 *      assigned by `buildEntityRows`.
 *   3. Place K modifiers in a group at evenly-spaced fractions
 *      between the bracketing scene-cell centres:
 *
 *        modifier i (1-indexed) → leftCenter + (i / (K + 1)) * (rightCenter - leftCenter)
 *
 *      So a single modifier still lands at the midpoint (i=1, K=1
 *      → t=0.5), two land at 1/3 + 2/3, three at 1/4 + 1/2 + 3/4,
 *      etc. Each gets its own visible position regardless of how
 *      close their canvas_x values are.
 *
 * Bracketing edge cases:
 *   - modifier canvas_x is LEFT of every scene column → leftIdx=-1,
 *     snap leftFrac to 0 (strip's left edge, right after Origin)
 *   - modifier canvas_x is RIGHT of every scene column → rightIdx=-1,
 *     snap rightFrac to 1 (strip's right edge, just before Final)
 *   - zero scene columns → return empty array (no place to anchor)
 */
function placeModifierDots(modDots, sceneCols, storyOrder) {
  const N = sceneCols.length
  if (N === 0 || !modDots || modDots.length === 0) return []

  // Build a sceneId → index lookup so chain-bracketed modifiers can
  // resolve their bracketing scene ids to grid column indices.
  const sceneIdToIdx = new Map()
  sceneCols.forEach((c, i) => sceneIdToIdx.set(c.id, i))

  // Global-order index lookup for the storyOrder path.
  const globalIdx = storyOrder && Array.isArray(storyOrder.orderedIds)
    ? new Map(storyOrder.orderedIds.map((id, i) => [id, i]))
    : null

  // Group modifiers by bracketing pair (leftIdx, rightIdx). Precedence:
  //   1. Global Story Order: for each modifier, its global index identifies
  //      which scene columns sit immediately before and after it in the
  //      unified 12-tier ordering. Strongest signal — agrees with the
  //      DevPreview Story Order page and every other story-order consumer.
  //   2. Explicit chain bracketing (chain_left_scene_id / chain_right_scene_id
  //      set by buildEntityRows from _modifierBracketing / buildLiveStorySnapshot).
  //      Fallback used only when a storyOrder isn't provided — e.g. the
  //      Import dialog's backend-built preview. Note this only knows the
  //      entity's private chain; scenes the modifier's entity doesn't
  //      touch can't bracket the modifier under this signal.
  //   3. Canvas-x bracketing fallback: last resort for callers with neither
  //      a storyOrder nor chain bracketing (test fixtures).
  const groups = new Map()
  for (const mod of modDots) {
    let leftIdx = -1
    let rightIdx = -1
    const hasChainBracketing = 'chain_left_scene_id' in mod
    const modGlobalIdx = globalIdx ? globalIdx.get(mod.modifier_node_id) : null
    if (globalIdx && modGlobalIdx != null) {
      // Global-order bracketing: find the scene columns whose global
      // indices immediately bracket this modifier's global index.
      for (let i = 0; i < N; i++) {
        const scIdx = globalIdx.get(sceneCols[i].id)
        if (scIdx == null) continue
        if (scIdx < modGlobalIdx) leftIdx = i
        else if (scIdx > modGlobalIdx) { rightIdx = i; break }
      }
    } else if (hasChainBracketing) {
      if (mod.chain_left_scene_id != null) {
        const idx = sceneIdToIdx.get(mod.chain_left_scene_id)
        if (idx != null) leftIdx = idx
      }
      if (mod.chain_right_scene_id != null) {
        const idx = sceneIdToIdx.get(mod.chain_right_scene_id)
        if (idx != null) rightIdx = idx
      }
    } else {
      // Canvas-x bracketing fallback for callers that don't attach chain
      // bracketing data AND don't have a storyOrder available.
      for (let i = 0; i < N; i++) {
        if (sceneCols[i].canvas_x <= mod.canvas_x) leftIdx = i
        else { rightIdx = i; break }
      }
    }
    const key = `${leftIdx}|${rightIdx}`
    if (!groups.has(key)) groups.set(key, { leftIdx, rightIdx, mods: [] })
    groups.get(key).mods.push(mod)
  }

  // For each group, compute the bracketing fraction range and
  // place modifiers at evenly-spaced fractions inside it.
  const placed = []
  for (const { leftIdx, rightIdx, mods } of groups.values()) {
    const leftFrac  = leftIdx  === -1 ? 0 : (leftIdx  + 0.5) / N
    const rightFrac = rightIdx === -1 ? 1 : (rightIdx + 0.5) / N
    // Sort within the group by chain_index for stable visual order.
    const sorted = [...mods].sort((a, b) => (a.chain_index || 0) - (b.chain_index || 0))
    const K = sorted.length
    sorted.forEach((mod, i) => {
      const t = (i + 1) / (K + 1)
      placed.push({ mod, fraction: leftFrac + t * (rightFrac - leftFrac) })
    })
  }
  return placed
}

/**
 * Module-level keyboard navigation handler attached to every dot
 * button (origin, scene, modifier, final).
 *
 * **ArrowLeft / ArrowRight** — moves within the same entity row.
 * Finds all sibling dots by matching `data-dot-key^="${entityId}|"`,
 * sorts them by visual x position via `getBoundingClientRect`,
 * advances the focus by ±1.
 *
 * **ArrowUp / ArrowDown** — moves to the adjacent row, picking the
 * dot at the nearest column to the current dot's x centre. Same-
 * column alignment (distance 0) wins automatically since the nearest-
 * neighbour selection uses euclidean-on-x distance. When two target-
 * row dots are equidistant on either side of the current x, the
 * earlier (smaller x) one wins as a "prefer earlier" tiebreaker.
 *
 * Sorting by `getBoundingClientRect()` works regardless of how each
 * dot is positioned (sticky-left Origin, flex-1 scene cells,
 * absolute-positioned modifier dots, sticky-right Final) — the
 * browser layout is the source of truth.
 *
 * Calls `scrollIntoView({block:'nearest', inline:'nearest'})` on the
 * target so off-screen dots auto-scroll into view in the navigator
 * panel's overflow container.
 */
function handleDotKeyDown(e) {
  const isHorizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
  const isVertical = e.key === 'ArrowUp' || e.key === 'ArrowDown'
  if (!isHorizontal && !isVertical) return

  const currentKey = e.currentTarget.dataset.dotKey
  if (!currentKey) return
  const entId = currentKey.split('|')[0]
  e.preventDefault()

  const escapeId = (id) => (window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id

  if (isHorizontal) {
    // Same-row nav: original left/right implementation.
    const all = document.querySelectorAll(`[data-dot-key^="${escapeId(entId)}|"]`)
    if (all.length === 0) return
    const sorted = Array.from(all).sort((a, b) => {
      return a.getBoundingClientRect().left - b.getBoundingClientRect().left
    })
    const idx = sorted.findIndex((el) => el === e.currentTarget)
    if (idx < 0) return
    const targetIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= sorted.length) return
    const target = sorted[targetIdx]
    target.focus()
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    target.click()
    return
  }

  // Vertical nav (ArrowUp / ArrowDown). Header and entity rows are handled
  // as two explicit layers rather than sorted-by-y together — that was
  // producing occasional misroutes (e.g. Up from an entity row landing on
  // a header cell because the row grouping's y-sort put Alice's row at an
  // unexpected index in degenerate fixtures). The explicit split makes
  // transitions unambiguous:
  //   - Up from the top entity row -> jumps into the header row
  //   - Up from header row -> no-op (already at top)
  //   - Down from header row -> jumps into the top entity row
  //   - Down from the bottom entity row -> no-op
  //   - All other Up / Down within the entity layer moves one row.
  const allDots = Array.from(document.querySelectorAll('[data-dot-key]'))
  if (allDots.length === 0) return

  const headerDots = []
  const byEntity = new Map()
  for (const el of allDots) {
    const key = el.dataset.dotKey
    if (!key) continue
    const eid = key.split('|')[0]
    if (eid === '__header__') {
      headerDots.push(el)
      continue
    }
    if (!byEntity.has(eid)) byEntity.set(eid, [])
    byEntity.get(eid).push(el)
  }

  // Sort entity rows by each row's top-most dot y-centre so ordering matches
  // the grid's visible top-to-bottom layout (robust against any absolute-
  // positioned dot offset via the `yMin` reduction).
  const entityRowEntries = []
  for (const [eid, dots] of byEntity.entries()) {
    let yMin = Infinity
    for (const d of dots) {
      const r = d.getBoundingClientRect()
      const yC = r.top + r.height / 2
      if (yC < yMin) yMin = yC
    }
    entityRowEntries.push({ eid, y: yMin, dots })
  }
  entityRowEntries.sort((a, b) => a.y - b.y)

  // Current dot's x centre — the anchor for nearest-x picking in the target row.
  const curRect = e.currentTarget.getBoundingClientRect()
  const curX = curRect.left + curRect.width / 2

  // Nearest-x picker. Sort ascending by x first so ties between two equally
  // distant dots on either side resolve to the earlier one (smaller x).
  const pickNearest = (dots) => {
    if (!dots || dots.length === 0) return null
    const sorted = dots.slice().sort((a, b) => {
      return a.getBoundingClientRect().left - b.getBoundingClientRect().left
    })
    let best = null
    let bestDist = Infinity
    for (const d of sorted) {
      const r = d.getBoundingClientRect()
      const x = r.left + r.width / 2
      const dist = Math.abs(x - curX)
      if (dist < bestDist) {
        best = d
        bestDist = dist
      }
    }
    return best
  }

  const focusTarget = (target) => {
    if (!target) return
    target.focus()
    // Vertical: `block: 'center'` (not 'nearest') so when the new row
    // is scrolled off the top/bottom of the grid's viewport the
    // browser actually scrolls. The Navigator + Import grid both
    // stack sticky overlays (act row + chapter row + scene-title row,
    // and identity column on the left), and `block: 'nearest'` would
    // scroll just enough to make the dot technically-visible but
    // hidden underneath the sticky header strip — the writer saw
    // "nothing scrolled" because the target landed in the dead zone.
    // Horizontal stays `'nearest'` so left/right nav doesn't yank the
    // grid around when the target column is already on-screen.
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    target.click()
  }

  if (entId === '__header__') {
    if (e.key === 'ArrowUp') return  // already at top
    // ArrowDown from header -> top entity row
    if (entityRowEntries.length === 0) return
    focusTarget(pickNearest(entityRowEntries[0].dots))
    return
  }

  // Current dot belongs to an entity row.
  const curIdx = entityRowEntries.findIndex((r) => r.eid === entId)
  if (curIdx < 0) return

  if (e.key === 'ArrowUp') {
    if (curIdx === 0) {
      // Top entity row -> header row
      focusTarget(pickNearest(headerDots))
    } else {
      focusTarget(pickNearest(entityRowEntries[curIdx - 1].dots))
    }
    return
  }
  // ArrowDown
  if (curIdx >= entityRowEntries.length - 1) return  // bottom entity row -> no-op
  focusTarget(pickNearest(entityRowEntries[curIdx + 1].dots))
}

// ── Component ───────────────────────────────────────────────────────

function TimelineGridView({
  // Required data
  preview,
  gridEntities,

  // Optional row-selection state + handler. When setSelectedRowIds is
  // null, identity cells are non-interactive (no cursor-pointer, no
  // hover bg, no pointer handlers). When provided, drag-select /
  // Ctrl+click / Shift+click patterns are enabled.
  selectedRowIds = null,
  setSelectedRowIds = null,

  // Optional "previewed row" visual highlight — draws an accent-500/60
  // bottom border on the matching row.
  previewedEntityId = null,
  setPreviewedEntityId = null,

  // Optional pick visualization: when non-null, render the accent-ring
  // overlay on whichever cell matches each entity's pick.
  importPicks = null,

  // Optional EXTRA selection highlight (Phase 2.7c) — adds an
  // accent-coloured **solid** ring on additional dots beyond what
  // `importPicks` highlights. Shape:
  //   Map<entityId, {
  //     origin: boolean,
  //     final: boolean,
  //     scenes: Set<sceneNodeId>,
  //     modifiers: Set<modifierNodeId>,
  //   }>
  // Used by the chain-range selector modal to draw range / multi-
  // select state. Default null (no extra rings).
  extraSelectedDots = null,

  // Optional OTHER-PIN coverage markers (Phase 2.7c) — adds an
  // accent-coloured **dashed** ring on chain points covered by
  // OTHER pinned-context entries for the same object (anchored,
  // single or range). Multiple entries can stack; each carries the
  // sessionId of its source pin so right-click can target the right
  // one for removal. Shape:
  //   Map<entityId, Array<{
  //     sessionId,
  //     label,        // writer-facing label for the right-click popover
  //     origin: boolean,
  //     final: boolean,
  //     scenes: Set<sceneNodeId>,
  //     modifiers: Set<modifierNodeId>,
  //   }>>
  // Suppressed at chain points where `extraSelectedDots` (solid)
  // also marks the same point — the solid ring already conveys
  // the writer's draft selection at that point. Default null.
  otherPinMarkers = null,

  // Optional DYNAMIC-RESOLUTION marker (Phase 2.7c) — adds a
  // **dotted zinc-grey** ring at the single chain point a dynamic
  // pinned-context entry for the same object currently resolves to
  // (when scene context is on and the active scene is on the
  // object's chain). Map<entityId, chainPointId | null>. Stacks
  // with the solid / dashed rings on the same point (different
  // line style, all three readable simultaneously). Default null.
  dynamicResolutionPoint = null,

  // Optional right-click handler for dashed-ringed dots (other-pin
  // coverage). Fires with `(sessionId, chainPointId)` so the modal
  // can pop up its "Remove that pin?" popover anchored to the
  // cursor. Default null (no right-click action).
  onOtherPinMarkerContextMenu = null,

  // Hide the Final bookend column entirely (Phase 2.7c — used by
  // the chain-range selector modal). Final exists in the Navigator
  // / Import grid so a writer can select multiple entities' final
  // positions even when those positions differ scene-to-scene; in
  // the single-object modal the Final bookend is structurally
  // redundant with the entity's actual last chain stop, which is
  // already rendered as a scene or modifier dot. Default false
  // (Navigator / Import dialog keep the Final bookend visible).
  hideFinalBookend = false,

  // Optional range-fill span (Phase 2.7c). When set, renders an
  // accent-coloured fill bar across the chain line between the
  // two chain points, visualizing a contiguous range selection.
  // Mirrors the intensity-slider fill-bar pattern. Shape:
  //   Map<entityId, {
  //     startChainPointId: <node id at the left edge of the range>,
  //     endChainPointId:   <node id at the right edge of the range>,
  //   }>
  // The renderer maps both endpoints to scene-column or modifier-dot
  // positions in the scene strip; Origin endpoint snaps the fill bar
  // to the strip's left edge. Default null.
  rangeFillSpans = null,

  // Optional dashed fill spans for OTHER-pin range coverage. Renders
  // a dashed accent bar between the endpoints of each range pin owned
  // by a different pinned-context entry for the same `(kind, id)`,
  // parallel to (and below) the solid `rangeFillSpans` bar so the
  // writer can see at a glance which dashed-ringed dots belong to the
  // same range entry. Shape:
  //   Map<entityId, Array<{ startChainPointId, endChainPointId }>>
  // Multiple range pins for the same object → multiple bars stacked.
  // Default null.
  otherPinRangeFillSpans = null,

  // Optional remove-entity callback. When null, the ✕ button on the
  // identity cell is not rendered.
  onRemoveEntity = null,

  // Click handlers. Defaults are no-ops so the component works even
  // when none are wired.
  onDotClick = null,              // (entityId, col)
  onModifierDotClick = null,      // (entityId, modifier_node_id)
  onColumnHeaderClick = null,     // (col)
  onChapterHeaderClick = null,    // (chapter_id, last_column_id, chapterMarker)
  onActHeaderClick = null,        // (act_id, last_column_id, actMarker)

  // Tooltip overrides — each function receives the relevant object
  // plus ambient state (e.g. selection size) and returns the string
  // to render in `title`. When omitted, defaults use the title alone.
  columnHeaderTooltip = null,     // (col, selectedCount) => string
  chapterHeaderTooltip = null,    // (chapterMarker, selectedCount) => string
  actHeaderTooltip = null,        // (actMarker, selectedCount) => string
  dotTooltip = null,              // (entity, col) => string
  modifierDotTooltip = null,      // (entity, mod) => string

  // Header label override. Default "Entity". Ignored when
  // `identityHeaderContent` is provided.
  identityHeaderLabel = 'Entity',

  // When non-null, takes over the entire identity-column header
  // area — replacing the default "Entity" label and visually
  // SPANNING the act + chapter + scene-title rows. Used by the
  // Phase 1.12c Timeline Navigator to embed its filter UI (type
  // tabs + search) inline with the header rows instead of as a
  // separate strip above the grid. The content is rendered inside
  // a sticky-positioned overlay so it stays pinned to the top-left
  // corner of the scroll viewport when the user scrolls vertically.
  identityHeaderContent = null,

  // Should column / chapter / act headers disable when zero rows are
  // selected? Import dialog wants this (can't batch-pick without a
  // target). Navigator does not (column-click = navigate regardless).
  headersRequireSelection = false,

  // Optional grid-wide column highlight — when non-null, the scene
  // column header matching this id renders with an accent-500 outline.
  // Used by the Timeline Navigator (Phase 1.12c v0.1.12.58) to show
  // the user's "current position" when a plot point node is the
  // active canvas selection (no specific row pick). Independent of
  // `importPicks`, which drives per-row dot rings.
  highlightedColumnId = null,

  // Override for the sticky-left identity column width. Default 180 px
  // matches the Timeline Navigator + Import dialog. Callers that have
  // their own identity surface above the grid (e.g. the Character Chat
  // Setup modal's avatar + name header) pass 0 to collapse the column
  // entirely — the grid skips rendering the identity-cell contents
  // (header label + per-row avatar + name) at width 0 so nothing
  // overflows.
  identityCellWidth = null,
}) {
  const rowSelectionEnabled = setSelectedRowIds != null

  // Resolved identity-column width — either the prop override or the
  // default. Used everywhere inside this component in place of the
  // historical module-level constant.
  const IDENTITY_CELL_W = identityCellWidth != null ? identityCellWidth : IDENTITY_CELL_W_DEFAULT
  const identityVisible = IDENTITY_CELL_W > 0

  // Global Story Order — used to sort modifier dot render order so
  // dots appear in narrative-chain order rather than canvas-x order.
  // The preview's `columns` (built by `buildStoryTimelineView` with
  // the same `storyOrder`) is already consistent with this ordering,
  // so every downstream computation here sees a coherent order.
  const storyOrder = useStoryOrder()

  // Reactive getter for relationship-row fallback-label rendering. Only reads
  // the getter function reference from entitiesStore; the actual label JSX is
  // rebuilt per render so any entity name / alias changes flow through.
  const getEntityById = useEntitiesStore((s) => s.getEntityById)

  const gridColumns = useMemo(() => {
    const all = buildGridColumns(preview)
    if (hideFinalBookend) return all.filter((c) => c._kind !== 'final')
    return all
  }, [preview, hideFinalBookend])

  // Scene-only subset — needed for modifier dot interpolation.
  const sceneOnlyColumns = useMemo(
    () => gridColumns.filter((c) => c._kind === 'scene'),
    [gridColumns],
  )

  // Precompute per-entity dot column sets so the body render loop
  // doesn't re-scan `dots[]` for every cell.
  const dotColumnsByEntity = useMemo(() => {
    const m = new Map()
    for (const ent of gridEntities) {
      m.set(ent.id, buildEntityDotColumns(ent, gridColumns))
    }
    return m
  }, [gridEntities, gridColumns])

  // Precompute per-entity modifier dot lists (sorted in global
  // Story Order when available; canvas_x fallback otherwise) so the
  // row render loop doesn't re-sort on every render.
  const modifiersByEntity = useMemo(() => {
    const m = new Map()
    for (const ent of gridEntities) {
      m.set(ent.id, buildEntityModifierDots(ent, storyOrder))
    }
    return m
  }, [gridEntities, storyOrder])

  // Columns that belong to a given chapter (scene cols only — Origin
  // + Final are never in a chapter). Used for (a) rendering the
  // chapter banner spans and (b) resolving chapter-header clicks
  // to "last scene in this chapter".
  const chapterColumnSpans = useMemo(() => {
    if (!preview?.chapters) return []
    const sceneCols = gridColumns.filter((c) => c._kind === 'scene')
    return preview.chapters
      .map((ch) => {
        // A chapter marker carries first_column_id + last_column_id.
        // Map these to grid indices. Non-POV cols after the last
        // POV-chain col may not fall inside any chapter span — safe,
        // they just don't get a banner above them.
        const firstIdx = sceneCols.findIndex((c) => c.id === ch.first_column_id)
        const lastIdx  = sceneCols.findIndex((c) => c.id === ch.last_column_id)
        if (firstIdx < 0 || lastIdx < 0) return null
        return {
          id: ch.id,
          title: ch.title,
          number: ch.number,
          colour: ch.colour || null,
          span: lastIdx - firstIdx + 1,
          offsetFromFirstScene: firstIdx,
          first_column_id: ch.first_column_id,
          last_column_id: ch.last_column_id,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.offsetFromFirstScene - b.offsetFromFirstScene)
  }, [preview, gridColumns])

  // Act banners — each marker is one contiguous run of columns
  // whose chapters belong to the same act. The marker carries
  // first_column_id + last_column_id directly (same shape as
  // chapter markers since v0.1.12.50), so we just resolve the
  // span the same way: find the column indices, compute span +
  // offset. A non-contiguous act (rare — needs a regression that
  // also crosses an act boundary) emits multiple markers, one per
  // disjoint run.
  const actColumnSpans = useMemo(() => {
    if (!preview?.acts) return []
    const sceneCols = gridColumns.filter((c) => c._kind === 'scene')
    return preview.acts
      .map((act) => {
        const firstIdx = sceneCols.findIndex((c) => c.id === act.first_column_id)
        const lastIdx  = sceneCols.findIndex((c) => c.id === act.last_column_id)
        if (firstIdx < 0 || lastIdx < 0) return null
        return {
          id: act.id,
          title: act.title,
          number: act.number,
          colour: act.colour || null,
          span: lastIdx - firstIdx + 1,
          offsetFromFirstScene: firstIdx,
          first_column_id: act.first_column_id,
          last_column_id: act.last_column_id,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.offsetFromFirstScene - b.offsetFromFirstScene)
  }, [preview, gridColumns])

  // Number of scene columns (Origin + Final bookends excluded).
  const sceneColCount = preview?.columns?.length || 0
  // Minimum scene-strip width — sum of every scene cell's minimum
  // width. Used for the grid container's `min-width`. The actual
  // rendered scene strip width is dynamic: when the panel is wider
  // than the min total, the strip flex-grows to fill spare room.
  const minSceneStripWidth = sceneColCount * SCENE_COL_W

  // Minimum total grid width — identity + origin + min scene strip
  // + final. Sets the grid container's `min-width` so the strip
  // can shrink down to (but no smaller than) the per-cell minimum
  // before the parent's overflow-x scroll kicks in. The container's
  // actual width is `100%` so it stretches to the available panel
  // width when the scene strip's natural minimum is smaller.
  const minTotalWidth = IDENTITY_CELL_W + ORIGIN_FINAL_W + minSceneStripWidth + ORIGIN_FINAL_W

  // ── Row selection interaction (internal to this component) ────
  // Three patterns:
  //   - Plain click / drag  → reset selection to this row, then
  //                           drag-extend live to hovered rows.
  //   - Ctrl / Cmd + click   → toggle one row in/out of the selection.
  //   - Shift + click        → inclusive range from the last plain
  //                           click (stored in `lastAnchorRef`) to
  //                           this row, REPLACING the current set.
  //
  // All three paths are no-ops when `rowSelectionEnabled` is false.
  const anchorRef = useRef(null)            // drag anchor
  const dragActiveRef = useRef(false)
  const lastAnchorRef = useRef(null)         // persistent anchor for Shift+click

  const handleRowPointerDown = useCallback((entityId, e) => {
    if (!rowSelectionEnabled) return
    if (e.button !== 0) return
    // Shift+click: inclusive range from last anchor to this row.
    if (e.shiftKey && lastAnchorRef.current) {
      const ids = gridEntities.map((ee) => ee.id)
      const a = ids.indexOf(lastAnchorRef.current)
      const b = ids.indexOf(entityId)
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        setSelectedRowIds(new Set(ids.slice(lo, hi + 1)))
      }
      setPreviewedEntityId?.(entityId)
      return
    }
    // Ctrl/Cmd+click: toggle this row, don't start a drag, don't
    // move the anchor.
    if (e.ctrlKey || e.metaKey) {
      setSelectedRowIds((prev) => {
        const next = new Set(prev)
        if (next.has(entityId)) next.delete(entityId)
        else next.add(entityId)
        return next
      })
      setPreviewedEntityId?.(entityId)
      return
    }
    // Plain click / start of drag: reset to just this row, remember
    // it as the drag anchor AND the persistent Shift anchor.
    anchorRef.current = entityId
    lastAnchorRef.current = entityId
    dragActiveRef.current = true
    setSelectedRowIds(new Set([entityId]))
    setPreviewedEntityId?.(entityId)
    // Capture pointer so drag-over-bounds still fires pointermove
    // on THIS element.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [rowSelectionEnabled, gridEntities, setSelectedRowIds, setPreviewedEntityId])

  const handleRowPointerEnter = useCallback((entityId) => {
    if (!rowSelectionEnabled) return
    if (!dragActiveRef.current || !anchorRef.current) return
    // Range select from anchor → this row, in row order.
    const ids = gridEntities.map((e) => e.id)
    const a = ids.indexOf(anchorRef.current)
    const b = ids.indexOf(entityId)
    if (a < 0 || b < 0) return
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const range = new Set(ids.slice(lo, hi + 1))
    setSelectedRowIds(range)
  }, [rowSelectionEnabled, gridEntities, setSelectedRowIds])

  const handleRowPointerUp = useCallback(() => {
    dragActiveRef.current = false
    anchorRef.current = null
  }, [])

  // ── Click handlers ────────────────────────────────────────────
  // Each wraps the optional external callback in a safety check so
  // nothing throws when the caller doesn't provide one.

  const handleDotClickWrapped = useCallback((entityId, col) => {
    onDotClick?.(entityId, col)
  }, [onDotClick])

  const handleModifierDotClickWrapped = useCallback((entityId, modId) => {
    onModifierDotClick?.(entityId, modId)
  }, [onModifierDotClick])

  const handleColumnHeaderClickWrapped = useCallback((col) => {
    if (headersRequireSelection && (!selectedRowIds || selectedRowIds.size === 0)) return
    onColumnHeaderClick?.(col)
  }, [headersRequireSelection, selectedRowIds, onColumnHeaderClick])

  const handleChapterHeaderClickWrapped = useCallback((ch) => {
    if (headersRequireSelection && (!selectedRowIds || selectedRowIds.size === 0)) return
    onChapterHeaderClick?.(ch.id, ch.last_column_id, ch)
  }, [headersRequireSelection, selectedRowIds, onChapterHeaderClick])

  const handleActHeaderClickWrapped = useCallback((act) => {
    if (headersRequireSelection && (!selectedRowIds || selectedRowIds.size === 0)) return
    onActHeaderClick?.(act.id, act.last_column_id, act)
  }, [headersRequireSelection, selectedRowIds, onActHeaderClick])

  // ── Render ─────────────────────────────────────────────────────

  if (!preview) {
    // No preview at all — caller renders an empty-state placeholder.
    return null
  }
  // NOTE: we deliberately render the grid even when `gridEntities`
  // is empty, so the header rows + identityHeaderContent overlay
  // (the Navigator's filter UI lives there) stay visible. A filter
  // that produces zero rows used to early-return null here, which
  // hid the filter UI itself and trapped the user — fixed in
  // v0.1.12.45.

  // Current-pick cell index per row — used for the column-cell ring
  // indicator. Returns the grid column index whose id matches the
  // pick, or -1 when no pick is set OR when the pick is a modifier
  // (modifier picks get their own ring, rendered at the interpolated
  // modifier x-position, not inside a column cell). Returns -1 for
  // every row when importPicks is null (Navigator case).
  function pickedColumnIndex(entityId) {
    if (!importPicks) return -1
    const pick = importPicks.get(entityId)
    if (!pick) return -1
    if (pick.kind === 'origin') return 0
    if (pick.kind === 'final')  return gridColumns.length - 1
    if (pick.kind === 'modifier') return -1   // rendered by the modifier loop
    return gridColumns.findIndex((c) => c._kind === 'scene' && c.id === pick.scene_id)
  }

  // Default tooltip generators — used when the caller didn't provide
  // an override. Keep these conservative (title only) so the import
  // dialog's more informative strings are always a pure override.
  const selectedCount = selectedRowIds?.size || 0
  const defaultColumnTooltip  = (col) => col.title
  const defaultChapterTooltip = (ch) => ch.title || `Chapter ${ch.number}`
  const defaultActTooltip     = (act) => act.title || `Act ${act.number}`
  const defaultDotTooltip     = (_ent, col) => col.title
  const defaultModifierDotTooltip = (_ent, mod) => `Modifier #${mod.chain_index}`

  // Sum of the heights of each header row that's actually rendered.
  // Used by the optional `identityHeaderContent` overlay to span all
  // three rows when present.
  const totalHeaderHeight =
    (actColumnSpans.length > 0 ? ACT_ROW_H : 0)
    + (chapterColumnSpans.length > 0 ? CHAPTER_ROW_H : 0)
    + SCENE_HEADER_H

  return (
    <div
      className="relative"
      onPointerUp={handleRowPointerUp}
      style={{ width: '100%', minWidth: minTotalWidth }}
    >
      {/* ── Identity-column header overlay ──────────────────────── */}
      {/* When `identityHeaderContent` is provided, render it as a
          single sticky-positioned overlay spanning the full vertical
          height of the header strip (acts + chapters + scene titles).
          The wrapper has `height: 0` so it doesn't push subsequent
          rows down; the inner absolute child paints downward into
          the header rows' identity-column area. Sticky top:0 + left:0
          keeps it pinned to the top-left corner of the scroll
          viewport regardless of horizontal/vertical scroll. z-index
          higher than the rows (z-20) so it overlays them cleanly.
          Used by the Phase 1.12c Timeline Navigator to embed its
          filter UI inline with the header rows. */}
      {identityHeaderContent && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            width: IDENTITY_CELL_W,
            height: 0,
            zIndex: 30,
          }}
        >
          <div
            className="bg-zinc-900/95 border-r border-b border-zinc-700 overflow-hidden"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: IDENTITY_CELL_W,
              height: totalHeaderHeight,
            }}
          >
            {identityHeaderContent}
          </div>
        </div>
      )}

      {/* ── Header strip ────────────────────────────────────────── */}
      {/* Three stacked rows: Act banners, Chapter banners, Scene
          titles. The first two only render above the scene strip;
          the identity / origin / final columns get empty spacer
          cells so the strip aligns horizontally. */}

      {/* Act row — only shown when the source story has at least one act.
          Layout (Phase 1.12c v0.1.12.46):
            [identity sticky-left:0]
            [origin spacer sticky-left:IDENTITY_CELL_W]
            [scene strip flex-1 with min-width, banners absolute-positioned by % of strip]
            [final spacer sticky-right:0]
          When identityHeaderContent is provided, the identity spacer is
          a transparent placeholder (the overlay above covers it). */}
      {actColumnSpans.length > 0 && (
        <div className="flex sticky top-0 z-20" style={{ height: ACT_ROW_H }}>
          {!identityHeaderContent && (
            <div
              className="bg-zinc-900/90 sticky left-0 z-10"
              style={{ width: IDENTITY_CELL_W, height: ACT_ROW_H, flexShrink: 0 }}
            />
          )}
          {identityHeaderContent && (
            <div style={{ width: IDENTITY_CELL_W, height: ACT_ROW_H, flexShrink: 0 }} />
          )}
          <div
            className="bg-zinc-900/80 sticky z-10"
            style={{ left: IDENTITY_CELL_W, width: ORIGIN_FINAL_W, height: ACT_ROW_H, flexShrink: 0 }}
          />
          <div
            className="relative bg-zinc-900/80"
            style={{ flex: '1 1 0', minWidth: minSceneStripWidth, height: ACT_ROW_H }}
          >
            {actColumnSpans.map((act) => {
              const disabled = headersRequireSelection && selectedCount === 0
              const title = (actHeaderTooltip || defaultActTooltip)(act, selectedCount)
              // Per-act colour at 18% opacity matches the canvas
              // act-header overlay (ChapterColumnsOverlay.jsx:937-940).
              // Default to zinc-500 when the user hasn't set one.
              const baseBg  = hexToRgba(act.colour, 0.18)
              const hoverBg = hexToRgba(act.colour, 0.32)
              return (
                <button
                  // Compound key — multiple non-contiguous runs of the
                  // same act emit markers sharing `id`, so we
                  // disambiguate via first_column_id.
                  key={`${act.id}-${act.first_column_id}`}
                  type="button"
                  onClick={() => handleActHeaderClickWrapped(act)}
                  disabled={disabled}
                  title={title}
                  className="absolute text-[10px] text-zinc-200 border-r border-zinc-700 flex items-center justify-center px-1.5 truncate disabled:cursor-not-allowed"
                  style={{
                    left:  `${(act.offsetFromFirstScene / sceneColCount) * 100}%`,
                    width: `${(act.span / sceneColCount) * 100}%`,
                    height: ACT_ROW_H,
                    backgroundColor: baseBg,
                  }}
                  onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.backgroundColor = hoverBg }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = baseBg }}
                >
                  {act.title || `Act ${act.number}`}
                </button>
              )
            })}
          </div>
          {!hideFinalBookend && (
            <div
              className="bg-zinc-900/80 sticky z-10"
              style={{ right: 0, width: ORIGIN_FINAL_W, height: ACT_ROW_H, flexShrink: 0 }}
            />
          )}
        </div>
      )}

      {/* Chapter row — only shown when the source story has at least one chapter. */}
      {chapterColumnSpans.length > 0 && (
        <div className="flex sticky z-20" style={{ top: actColumnSpans.length > 0 ? ACT_ROW_H : 0, height: CHAPTER_ROW_H }}>
          {!identityHeaderContent && (
            <div
              className="bg-zinc-900/90 sticky left-0 z-10"
              style={{ width: IDENTITY_CELL_W, height: CHAPTER_ROW_H, flexShrink: 0 }}
            />
          )}
          {identityHeaderContent && (
            <div style={{ width: IDENTITY_CELL_W, height: CHAPTER_ROW_H, flexShrink: 0 }} />
          )}
          <div
            className="bg-zinc-900/80 sticky z-10"
            style={{ left: IDENTITY_CELL_W, width: ORIGIN_FINAL_W, height: CHAPTER_ROW_H, flexShrink: 0 }}
          />
          <div
            className="relative bg-zinc-900/80"
            style={{ flex: '1 1 0', minWidth: minSceneStripWidth, height: CHAPTER_ROW_H }}
          >
            {chapterColumnSpans.map((ch) => {
              const disabled = headersRequireSelection && selectedCount === 0
              const title = (chapterHeaderTooltip || defaultChapterTooltip)(ch, selectedCount)
              // Per-chapter colour at 18% opacity. Canvas uses 6%
              // for the in-canvas chapter band, but the navigator's
              // chapter banner is a smaller surface and benefits from
              // the same 18% opacity the canvas uses for act headers
              // — visually consistent treatment for both navigator
              // banner rows.
              const baseBg  = hexToRgba(ch.colour, 0.18)
              const hoverBg = hexToRgba(ch.colour, 0.32)
              return (
                <button
                  // Compound key — multiple non-contiguous runs of the
                  // same chapter (POV chain regression) emit markers
                  // sharing `id`, so we disambiguate via first_column_id.
                  key={`${ch.id}-${ch.first_column_id}`}
                  type="button"
                  onClick={() => handleChapterHeaderClickWrapped(ch)}
                  disabled={disabled}
                  title={title}
                  className="absolute text-[10px] text-zinc-200 border-r border-zinc-700 flex items-center justify-center px-1.5 truncate disabled:cursor-not-allowed"
                  style={{
                    left:  `${(ch.offsetFromFirstScene / sceneColCount) * 100}%`,
                    width: `${(ch.span / sceneColCount) * 100}%`,
                    height: CHAPTER_ROW_H,
                    backgroundColor: baseBg,
                  }}
                  onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.backgroundColor = hoverBg }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = baseBg }}
                >
                  {ch.title || `Chapter ${ch.number}`}
                </button>
              )
            })}
          </div>
          {!hideFinalBookend && (
            <div
              className="bg-zinc-900/80 sticky z-10"
              style={{ right: 0, width: ORIGIN_FINAL_W, height: CHAPTER_ROW_H, flexShrink: 0 }}
            />
          )}
        </div>
      )}

      {/* Scene column title row — one header cell per grid column
          (including the synthetic Origin + Final bookends). The
          "Entity" label cell is sticky-left so it stays pinned above
          the sticky identity column during horizontal scroll. It's
          a select-all toggle button when rowSelectionEnabled; a
          plain label otherwise. */}
      <div
        className="flex sticky bg-zinc-900/80 z-20 border-b border-zinc-700"
        style={{
          top: (actColumnSpans.length > 0 ? ACT_ROW_H : 0) + (chapterColumnSpans.length > 0 ? CHAPTER_ROW_H : 0),
          height: SCENE_HEADER_H,
        }}
      >
        {/* Identity-column header — suppressed entirely when the
            caller has collapsed the identity column to width 0 (the
            Character Chat Setup modal does this because its own
            avatar + name header sits above the grid). */}
        {identityVisible && (identityHeaderContent ? (
          // Transparent placeholder — the sticky overlay above
          // covers this area with the caller's custom content.
          <div style={{ width: IDENTITY_CELL_W, height: SCENE_HEADER_H, flexShrink: 0 }} />
        ) : rowSelectionEnabled ? (
          <button
            type="button"
            onClick={() => {
              // Toggle select-all: if every row is already selected,
              // clear; otherwise select every row.
              if ((selectedRowIds?.size || 0) === gridEntities.length) {
                setSelectedRowIds(new Set())
              } else {
                setSelectedRowIds(new Set(gridEntities.map((e) => e.id)))
              }
            }}
            title={(selectedRowIds?.size || 0) === gridEntities.length
              ? 'Deselect all rows'
              : 'Select all rows'}
            className="sticky left-0 z-10 bg-zinc-900/95 hover:bg-zinc-800 flex items-end px-2 pb-1 text-[10px] font-semibold text-zinc-500 hover:text-zinc-200 uppercase tracking-wider border-r border-zinc-700 transition-colors"
            style={{ width: IDENTITY_CELL_W, height: SCENE_HEADER_H }}
          >
            {identityHeaderLabel} {selectedCount > 0 && <span className="ml-1 text-accent-400 normal-case">({selectedCount})</span>}
          </button>
        ) : (
          <div
            className="sticky left-0 z-10 bg-zinc-900/95 flex items-end px-2 pb-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider border-r border-zinc-700"
            style={{ width: IDENTITY_CELL_W, height: SCENE_HEADER_H }}
          >
            {identityHeaderLabel}
          </div>
        ))}
        {/* Origin column header — sticky-left right after the
            identity column. Fixed width. */}
        {(() => {
          const col = gridColumns.find((c) => c._kind === 'origin')
          if (!col) return null
          const disabled = headersRequireSelection && selectedCount === 0
          const title = (columnHeaderTooltip || defaultColumnTooltip)(col, selectedCount)
          return (
            <button
              key={col.id}
              type="button"
              onClick={() => handleColumnHeaderClickWrapped(col)}
              onKeyDown={handleDotKeyDown}
              data-dot-key={`__header__|origin|${col.id}`}
              data-help-region="timeline-navigator:bookend_column"
              disabled={disabled}
              title={title}
              className="sticky z-10 flex flex-col items-center justify-end pb-1 px-0.5 border-r border-zinc-800 transition-colors disabled:cursor-not-allowed bg-zinc-800 hover:bg-zinc-700 disabled:hover:bg-zinc-800"
              style={{ left: IDENTITY_CELL_W, width: ORIGIN_FINAL_W, height: SCENE_HEADER_H, flexShrink: 0 }}
            >
              <span
                className="text-[9px] truncate w-full text-center text-accent-300 font-semibold"
                title={col.title}
              >
                {col.title}
              </span>
            </button>
          )
        })()}

        {/* Scene-only column headers — flex-grow strip between the
            sticky Origin and Final headers. Each scene cell is
            `flex: 1 1 SCENE_COL_W` so they grow proportionally
            when there's spare panel width and shrink to the
            per-cell minimum when the strip overflows horizontally. */}
        <div
          className="flex bg-zinc-900/80"
          style={{ flex: '1 1 0', minWidth: minSceneStripWidth, height: SCENE_HEADER_H }}
        >
          {gridColumns.filter((c) => c._kind === 'scene').map((col) => {
            const disabled = headersRequireSelection && selectedCount === 0
            const baseTitle = (columnHeaderTooltip || defaultColumnTooltip)(col, selectedCount)
            // POV chain regression: this scene's chapter index is
            // less than the immediately previous POV scene's chapter
            // index. Same rule as the alerts panel
            // (`hooks/useAlerts.js:240-268`). Render an amber ⚠
            // overlay on the scene header when flagged. The tooltip
            // gets a regression note appended so the user can hover
            // for context without opening the alerts panel.
            const isRegressed = col.is_chain_regressed
            const isColHighlighted = highlightedColumnId === col.id
            const title = isRegressed
              ? `${baseTitle} — POV chain regresses here (this scene is in an earlier chapter than the previous POV scene)`
              : baseTitle
            return (
              <button
                key={col.id}
                type="button"
                onClick={() => handleColumnHeaderClickWrapped(col)}
                onKeyDown={handleDotKeyDown}
                data-dot-key={`__header__|scene|${col.id}`}
                data-help-region="timeline-navigator:scene_header"
                disabled={disabled}
                title={title}
                className={`relative flex flex-col items-center justify-end pb-1 px-0.5 border-r border-zinc-800 transition-colors disabled:cursor-not-allowed focus:outline-none ${
                  col.is_pov_chain
                    ? 'bg-zinc-900/60 hover:bg-zinc-700/60 disabled:hover:bg-zinc-900/60'
                    : 'bg-zinc-900/30 hover:bg-zinc-700/60 disabled:hover:bg-zinc-900/30'
                }`}
                style={{ flex: '1 1 0', minWidth: SCENE_COL_W, height: SCENE_HEADER_H }}
              >
                {isColHighlighted && (
                  <span
                    className="absolute pointer-events-none rounded-sm"
                    style={{
                      inset: 2,
                      border: '1.5px solid var(--color-accent-500, #a855f7)',
                    }}
                    aria-hidden="true"
                  />
                )}
                {isRegressed && (
                  <span
                    className="absolute text-[10px] leading-none pointer-events-none"
                    style={{
                      color: '#f59e0b' /* amber-500 */,
                      top: 2,
                      left: '50%',
                      transform: 'translateX(-50%)',
                    }}
                    aria-label="POV chain regresses at this scene"
                  >
                    ⚠
                  </span>
                )}
                <span
                  className="text-[9px] truncate w-full text-center text-zinc-300"
                  title={col.title}
                >
                  {col.title}
                </span>
                {col.is_pov_chain ? (
                  <span className="text-[8px] text-zinc-600 leading-none mt-0.5">#{col.chain_index}</span>
                ) : (
                  <span className="text-[8px] text-zinc-600 leading-none mt-0.5" title="Non-POV">·</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Final column header — sticky-right at 0. Fixed width. */}
        {(() => {
          const col = gridColumns.find((c) => c._kind === 'final')
          if (!col) return null
          const disabled = headersRequireSelection && selectedCount === 0
          const title = (columnHeaderTooltip || defaultColumnTooltip)(col, selectedCount)
          return (
            <button
              key={col.id}
              type="button"
              onClick={() => handleColumnHeaderClickWrapped(col)}
              onKeyDown={handleDotKeyDown}
              data-dot-key={`__header__|final|${col.id}`}
              data-help-region="timeline-navigator:bookend_column"
              disabled={disabled}
              title={title}
              className="sticky z-10 flex flex-col items-center justify-end pb-1 px-0.5 border-l border-zinc-800 transition-colors disabled:cursor-not-allowed bg-zinc-800 hover:bg-zinc-700 disabled:hover:bg-zinc-800"
              style={{ right: 0, width: ORIGIN_FINAL_W, height: SCENE_HEADER_H, flexShrink: 0 }}
            >
              <span
                className="text-[9px] truncate w-full text-center text-accent-300 font-semibold"
                title={col.title}
              >
                {col.title}
              </span>
            </button>
          )
        })()}
      </div>

      {/* ── Body rows ─────────────────────────────────────────── */}
      {gridEntities.map((ent) => {
        const dotCols   = dotColumnsByEntity.get(ent.id) || new Set()
        const modDots   = modifiersByEntity.get(ent.id) || []
        const originColour = ent.colour || '#888888'
        const finalColour  = ent.final_colour || originColour
        const isSel     = selectedRowIds?.has(ent.id) || false
        const isPreviewed = previewedEntityId === ent.id
        const pickIdx   = pickedColumnIndex(ent.id)
        const pick      = importPicks?.get(ent.id) || null
        const pickedModifierId = pick?.kind === 'modifier' ? pick.modifier_node_id : null
        // Phase 2.7c ring resolvers. All three default to null when
        // the corresponding props aren't passed; the existing Import
        // dialog and Timeline Navigator callers see no behavioural
        // change. Returned helper functions answer "should this cell
        // get an extra solid / dashed / dotted ring?" per chain
        // point.
        const _extra = extraSelectedDots?.get(ent.id) || null
        const _others = otherPinMarkers?.get(ent.id) || null
        const _dynPoint = dynamicResolutionPoint?.get(ent.id) || null
        const _extraSolidAtScene = (sceneId) => !!_extra?.scenes?.has(sceneId)
        const _extraSolidAtModifier = (modId) => !!_extra?.modifiers?.has(modId)
        const _extraSolidAtOrigin = !!_extra?.origin
        const _extraSolidAtFinal = !!_extra?.final
        const _otherCoversScene = (sceneId) => {
          if (!_others) return null
          for (const m of _others) if (m?.scenes?.has(sceneId)) return m
          return null
        }
        const _otherCoversModifier = (modId) => {
          if (!_others) return null
          for (const m of _others) if (m?.modifiers?.has(modId)) return m
          return null
        }
        const _otherCoversOrigin = (() => {
          if (!_others) return null
          for (const m of _others) if (m?.origin) return m
          return null
        })()
        const _otherCoversFinal = (() => {
          if (!_others) return null
          for (const m of _others) if (m?.final) return m
          return null
        })()
        // Identity-cell colour + image track the picked chain point's
        // effective state (Phase 1.12c v0.1.12.57). Falls back to
        // origin when no pick is set.
        const identityState = resolveIdentityState(ent, pick)
        // Chain-line colour uses origin — the line runs the full
        // row and any per-dot tint is applied at the dots themselves.
        const chainLineColour = originColour
        // Per-scene-dot lookup so the render loop can read each
        // scene dot's `effective_colour` without re-scanning
        // `ent.dots` inside the cell loop.
        const sceneDotByColumnId = new Map()
        for (const d of (ent.dots || [])) {
          if (!d.is_modifier && d.column_id) sceneDotByColumnId.set(d.column_id, d)
        }

        return (
          <div
            key={ent.id}
            className={`flex border-b transition-colors ${
              isPreviewed
                ? 'border-accent-500/60'
                : 'border-zinc-800'
            } ${
              isSel ? 'bg-accent-900/20' : 'hover:bg-zinc-800/40'
            }`}
            style={{ height: ROW_H }}
          >
            {/* Identity cell — sticky-left so it stays pinned during
                horizontal scroll of the origin / scenes / final
                strip. z-10 so body dot cells pass UNDER it. Solid
                bg so scrolling cells don't bleed through.

                Pointer handlers power the Import dialog's drag-to-
                select-rows UX, and are attached only when
                `rowSelectionEnabled` is true.

                When row-select is OFF (the Timeline Navigator path),
                clicking the identity cell acts as clicking the Origin
                dot: it navigates to the entity's / relationship's
                origin node and opens the detail panel at origin
                position. Same handler as the origin dot itself
                (`handleDotClickWrapped` with the origin grid column)
                so the two affordances stay in sync. */}
            {identityVisible && (<div
              data-help-region="timeline-navigator:identity_cell"
              onPointerDown={rowSelectionEnabled ? (e) => handleRowPointerDown(ent.id, e) : undefined}
              onPointerEnter={rowSelectionEnabled ? () => handleRowPointerEnter(ent.id) : undefined}
              onClick={rowSelectionEnabled ? undefined : () => {
                const originCol = gridColumns.find((c) => c._kind === 'origin')
                if (originCol) handleDotClickWrapped(ent.id, originCol)
              }}
              className={`flex items-center gap-2 px-2 border-r border-zinc-800 select-none sticky left-0 z-10 ${
                rowSelectionEnabled ? 'cursor-pointer' : 'cursor-pointer'
              } ${
                isSel ? 'bg-accent-900/80' : 'bg-zinc-800 hover:bg-zinc-700/60'
              }`}
              style={{ width: IDENTITY_CELL_W }}
              title={pick
                ? `${ent.name} — picked: ${pick.kind === 'scene' ? 'scene' : pick.kind}`
                : `${ent.name} — click to navigate to origin`}
            >
              <GridThumb
                entity={ent}
                effectiveColour={identityState.colour}
                effectiveSrc={identityState.src}
              />
              <div className="flex-1 text-xs text-zinc-200 min-w-0">
                {ent.type === 'relationship' && Array.isArray(ent._fallbackParticipants) && ent._fallbackParticipants.length > 0
                  ? <RelationshipLabelStack
                      name={ent._relationshipRef?.name || null}
                      participants={ent._fallbackParticipants}
                      getEntity={getEntityById}
                      sliceMax={Infinity}
                      rel={ent._relationshipRef}
                      resolveName={ent._resolveName || null}
                    />
                  : <span className="truncate block">{identityState.name}</span>}
              </div>
              <span className="text-[10px] opacity-60" title={ent.type}>
                {TYPE_ICONS[ent.type] || '?'}
              </span>
              {onRemoveEntity && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRemoveEntity(ent.id) }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="text-zinc-500 hover:text-red-400 text-sm font-bold leading-none"
                  title="Remove from grid"
                >
                  −
                </button>
              )}
            </div>)}

            {/* Body strip — Origin (sticky-left) + Scene strip
                (flex-grow, holds the chain line + scene dot cells +
                modifier dots) + Final (sticky-right). Each is an
                immediate child of the row's flex container so sticky
                positioning works against the panel's scroll viewport. */}

            {/* Origin cell — sticky-left right after the identity column. */}
            {(() => {
              const col = gridColumns.find((c) => c._kind === 'origin')
              if (!col) return null
              const colIdx = 0
              const hasDot = dotCols.has(col.id)
              const isPicked = colIdx === pickIdx
              const dotTitleText = (dotTooltip || defaultDotTooltip)(ent, col)
              const _originSpan = rangeFillSpans?.get(ent.id)
              const _originFillIncludes = !!_originSpan && (
                _originSpan.startChainPointId === '__origin__' ||
                _originSpan.endChainPointId === '__origin__'
              )
              return (
                <div
                  key={col.id}
                  className="sticky z-10 relative border-r border-zinc-800 flex items-center justify-center bg-zinc-800"
                  style={{ left: IDENTITY_CELL_W, width: ORIGIN_FINAL_W, height: ROW_H, flexShrink: 0 }}
                >
                  {/* Phase 2.7c — range-fill bar segment inside the origin
                      cell so the slider-style stripe connects visually
                      from the origin dot's centre out to the cell's
                      right edge when the range covers origin. Without
                      this the opaque `bg-zinc-800` background of the
                      origin cell clips the fill bar that lives in the
                      scene strip. */}
                  {_originFillIncludes && (
                    <div
                      className="absolute rounded-full pointer-events-none"
                      style={{
                        top: ROW_H / 2 - 2,
                        left: '50%',
                        right: 0,
                        height: 4,
                        backgroundColor: 'var(--color-accent-500, #a855f7)',
                        opacity: 0.7,
                      }}
                    />
                  )}
                  {hasDot && (
                    <button
                      type="button"
                      onClick={() => handleDotClickWrapped(ent.id, col)}
                      onKeyDown={handleDotKeyDown}
                      data-dot-key={`${ent.id}|scene|${col.id}`}
                      className="absolute inline-flex items-center justify-center bg-transparent border-0 p-0 transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-accent-400 rounded-full z-10"
                      style={{
                        width: BOOKEND_GLYPH_SIZE,
                        height: BOOKEND_GLYPH_SIZE,
                        inset: 0,
                        margin: 'auto',
                        color: originColour,
                      }}
                      title={dotTitleText}
                    >
                      <BookendDotGlyph size={BOOKEND_GLYPH_SIZE} />
                    </button>
                  )}
                  {(() => {
                    // Phase 2.7c — Origin bookend ring stacking.
                    const rings = []
                    const showSolid = isPicked || _extraSolidAtOrigin
                    const showDashed = !!_otherCoversOrigin && !showSolid
                    if (showSolid) rings.push(<_ChainPointRing key="solid" dotSize={BOOKEND_GLYPH_SIZE} kind="solid" offset={6} />)
                    if (showDashed) rings.push(<_ChainPointRing key="dashed" dotSize={BOOKEND_GLYPH_SIZE} kind="dashed" offset={6} />)
                    return rings.length === 0 ? null : rings
                  })()}
                  {(() => {
                    if (!_otherCoversOrigin || !onOtherPinMarkerContextMenu) return null
                    return (
                      <div
                        className="absolute inset-0"
                        onContextMenu={(e) => {
                          e.preventDefault()
                          onOtherPinMarkerContextMenu(_otherCoversOrigin.sessionId, '__origin__', { x: e.clientX, y: e.clientY }, _otherCoversOrigin)
                        }}
                        title={`Already attached as context: ${_otherCoversOrigin.label || ''}. Right-click to remove.`}
                        style={{ pointerEvents: 'auto' }}
                      />
                    )
                  })()}
                </div>
              )
            })()}

            {/* Scene strip — flex-grow container holding the chain
                line, all scene dot cells, and all modifier dots.
                Each scene cell is `flex: 1 1 SCENE_COL_W` so they
                grow proportionally when there's spare panel width
                and shrink to the per-cell minimum when the strip
                overflows horizontally. */}
            <div
              className="relative flex"
              style={{ flex: '1 1 0', minWidth: minSceneStripWidth, height: ROW_H }}
            >
              {/* Chain line — runs the full width of the scene strip
                  at row mid-height. Together with the half-segments
                  inside the Origin and Final cells (rendered below
                  via separate absolute lines), it visually connects
                  origin → final centre to centre. */}
              <div
                className="absolute pointer-events-none"
                style={{
                  top: ROW_H / 2 - 1,
                  left: 0,
                  right: 0,
                  height: 2,
                  backgroundColor: chainLineColour,
                  opacity: 0.35,
                }}
              />
              {/* Phase 2.7c — range-fill bar across the chain line.
                  Visually mirrors the IntensitySlider fill-bar pattern:
                  an accent-coloured stripe along the track between the
                  two endpoints. Endpoints are computed as fractional
                  positions in the scene strip; Origin snaps to 0 (the
                  strip's left edge) since Origin lives in its own
                  sticky-left cell. */}
              {(() => {
                const span = rangeFillSpans?.get(ent.id)
                if (!span || !span.startChainPointId || !span.endChainPointId) return null
                const placedMods = placeModifierDots(modDots, sceneOnlyColumns, storyOrder)
                function _fractionOf(chainPointId) {
                  if (chainPointId === '__origin__') return 0
                  if (chainPointId === '__final__') return 1
                  const sceneIdx = sceneOnlyColumns.findIndex((c) => c.id === chainPointId)
                  if (sceneIdx >= 0) {
                    const n = sceneOnlyColumns.length
                    return n > 0 ? (sceneIdx + 0.5) / n : 0
                  }
                  const modEntry = placedMods.find((m) => m.mod?.modifier_node_id === chainPointId)
                  if (modEntry) return modEntry.fraction
                  // Caller passed an unknown chain point — snap to 0 so
                  // the fill bar still renders at the strip's start
                  // rather than disappearing.
                  return 0
                }
                const startFrac = _fractionOf(span.startChainPointId)
                const endFrac = _fractionOf(span.endChainPointId)
                const lo = Math.min(startFrac, endFrac)
                const hi = Math.max(startFrac, endFrac)
                if (hi <= lo) return null
                return (
                  <div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      top: ROW_H / 2 - 2,
                      left: `${lo * 100}%`,
                      width: `${(hi - lo) * 100}%`,
                      height: 4,
                      backgroundColor: 'var(--color-accent-500, #a855f7)',
                      opacity: 0.7,
                    }}
                  />
                )
              })()}
              {/* Phase 2.7c — dashed fill bars for OTHER-pin range
                  coverage. Each range pin owned by a different pinned-
                  context entry for the same `(kind, id)` gets a dashed
                  accent stripe spanning its endpoints, parallel to
                  (and slightly above) the solid in-flight fill bar so
                  both can be visible at once. Lets the writer see
                  which dashed-ringed dots belong together as one
                  range entry vs which are independent single-anchor
                  entries. */}
              {(() => {
                const spans = otherPinRangeFillSpans?.get(ent.id)
                if (!spans || spans.length === 0) return null
                const placedMods = placeModifierDots(modDots, sceneOnlyColumns, storyOrder)
                function _fractionOf(chainPointId) {
                  if (chainPointId === '__origin__') return 0
                  if (chainPointId === '__final__') return 1
                  const sceneIdx = sceneOnlyColumns.findIndex((c) => c.id === chainPointId)
                  if (sceneIdx >= 0) {
                    const n = sceneOnlyColumns.length
                    return n > 0 ? (sceneIdx + 0.5) / n : 0
                  }
                  const modEntry = placedMods.find((m) => m.mod?.modifier_node_id === chainPointId)
                  if (modEntry) return modEntry.fraction
                  return 0
                }
                return spans.map((span, i) => {
                  if (!span?.startChainPointId || !span?.endChainPointId) return null
                  const startFrac = _fractionOf(span.startChainPointId)
                  const endFrac = _fractionOf(span.endChainPointId)
                  const lo = Math.min(startFrac, endFrac)
                  const hi = Math.max(startFrac, endFrac)
                  if (hi <= lo) return null
                  return (
                    <div
                      key={`other-range-${i}`}
                      className="absolute pointer-events-none"
                      style={{
                        top: ROW_H / 2 - 6,
                        left: `${lo * 100}%`,
                        width: `${(hi - lo) * 100}%`,
                        height: 3,
                        // Repeating dash pattern in accent colour: 6px
                        // visible, 4px gap. Picks up the accent the
                        // dashed rings use so the eye groups the bar
                        // with the rings it connects.
                        backgroundImage: 'repeating-linear-gradient(to right, var(--color-accent-500, #a855f7) 0 6px, transparent 6px 10px)',
                        opacity: 0.8,
                      }}
                    />
                  )
                })
              })()}
              {sceneOnlyColumns.map((col) => {
                // Scene cells live between origin (idx 0) and final
                // (last idx). For pickedColumnIndex matching, find
                // the absolute index in gridColumns.
                const colIdx = gridColumns.findIndex((c) => c.id === col.id)
                const hasDot = dotCols.has(col.id)
                const isPicked = colIdx === pickIdx
                const dotTitleText = (dotTooltip || defaultDotTooltip)(ent, col)
                // Each scene dot is coloured by the entity's effective
                // colour at that chain point (Phase 1.12c v0.1.12.57).
                // Falls back to origin colour when effective-state
                // isn't populated (e.g. test fixtures / backend
                // previews built before the backend mirror lands).
                const sceneDot = sceneDotByColumnId.get(col.id)
                const dotColour = sceneDot?.effective_colour || originColour
                return (
                  <div
                    key={col.id}
                    // The right divider is drawn with an inset box-
                    // shadow instead of `border-r`. A real 1px border
                    // would consume layout space inside the padding
                    // box (with box-sizing: border-box), making the
                    // cell's padding-box width odd and forcing the
                    // dot + halo to centre on a `.5` fractional
                    // position. Browser banker's rounding then snaps
                    // the two elements to different integer pixels,
                    // producing a visible 1px misalignment of the
                    // halo around the dot. Box-shadow draws the same
                    // visual line without consuming layout space, so
                    // the padding box stays at the cell's full
                    // (typically even) width and both elements share
                    // an integer-pixel centre.
                    className="relative flex items-center justify-center"
                    style={{ flex: '1 1 0', minWidth: SCENE_COL_W, height: ROW_H, boxShadow: 'inset -1px 0 0 0 #27272a' }}
                  >
                    {hasDot && (
                      <button
                        type="button"
                        onClick={() => handleDotClickWrapped(ent.id, col)}
                        onKeyDown={handleDotKeyDown}
                        data-dot-key={`${ent.id}|scene|${col.id}`}
                        data-help-region="timeline-navigator:entity_dot"
                        className="absolute rounded-full border-2 transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-accent-400"
                        style={{
                          width: DOT_SIZE,
                          height: DOT_SIZE,
                          inset: 0,
                          margin: 'auto',
                          backgroundColor: dotColour,
                          borderColor: dotColour,
                        }}
                        title={dotTitleText}
                      />
                    )}
                    {(() => {
                      // Phase 2.7c ring stacking. The primary
                      // `importPicks` ring still wins; Phase 2.7c
                      // adds extra solid (this entry's selection
                      // extras), dashed (other-pin coverage), and
                      // dotted (dynamic-resolution) rings. Solid
                      // suppresses dashed at the same point; dotted
                      // stacks with whichever solid/dashed is active.
                      const rings = []
                      const isExtraSolid = _extraSolidAtScene(col.id)
                      const showSolid = isPicked || isExtraSolid
                      const otherMatch = _otherCoversScene(col.id)
                      const showDashed = !!otherMatch && !showSolid
                      const showDotted = _dynPoint === col.id
                      if (showSolid) rings.push(<_ChainPointRing key="solid" dotSize={DOT_SIZE} kind="solid" />)
                      if (showDashed) rings.push(<_ChainPointRing key="dashed" dotSize={DOT_SIZE} kind="dashed" />)
                      if (showDotted) rings.push(<_ChainPointRing key="dotted" dotSize={DOT_SIZE} kind="dotted" offset={showSolid || showDashed ? 18 : 10} dimmed />)
                      return rings.length === 0 ? null : rings
                    })()}
                    {/* Right-click target for dashed-ringed scene cells —
                        offer to remove the OTHER pin that covers this
                        chain point. Invisible overlay that only catches
                        contextmenu when there's an other-pin match. */}
                    {(() => {
                      if (!hasDot) return null
                      const otherMatch = _otherCoversScene(col.id)
                      if (!otherMatch || !onOtherPinMarkerContextMenu) return null
                      return (
                        <div
                          className="absolute inset-0"
                          onContextMenu={(e) => {
                            e.preventDefault()
                            onOtherPinMarkerContextMenu(otherMatch.sessionId, col.id, { x: e.clientX, y: e.clientY }, otherMatch)
                          }}
                          title={`Already attached as context: ${otherMatch.label || ''}. Right-click to remove.`}
                          style={{ pointerEvents: 'auto' }}
                        />
                      )
                    })()}
                  </div>
                )
              })}

              {/* Modifier dots — amber circles positioned via
                  percentage of the scene strip width. Each modifier
                  group (sharing a bracketing scene pair) is laid
                  out at evenly-spaced fractions between the
                  bracketing scene-cell centres via `placeModifierDots`,
                  so two modifiers with the same canvas x sit at 1/3
                  and 2/3 instead of stacking on top of each other.
                  Centered on the chain line via `top: ROW_H/2` +
                  transform translate -50%. */}
              {placeModifierDots(modDots, sceneOnlyColumns, storyOrder).map(({ mod, fraction }) => {
                const isPickedMod = pickedModifierId === mod.modifier_node_id
                const modTitleText = (modifierDotTooltip || defaultModifierDotTooltip)(ent, mod)
                return (
                  <div
                    key={mod.modifier_node_id}
                    className="absolute"
                    style={{
                      left: `${fraction * 100}%`,
                      top: ROW_H / 2,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleModifierDotClickWrapped(ent.id, mod.modifier_node_id)}
                      onKeyDown={handleDotKeyDown}
                      data-dot-key={`${ent.id}|mod|${mod.modifier_node_id}`}
                      data-help-region="timeline-navigator:modifier_dot"
                      title={modTitleText}
                      className="block rounded-full border-2 transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-accent-400"
                      style={{
                        width: MOD_DOT_SIZE,
                        height: MOD_DOT_SIZE,
                        backgroundColor: '#f59e0b',     // amber-500 — matches MODIFIER badge
                        borderColor: '#fbbf24',          // amber-400
                      }}
                    />
                    {(() => {
                      // Phase 2.7c — same ring stacking rule as the
                      // scene-dot cell, just keyed off the modifier's
                      // own node id.
                      const rings = []
                      const isExtraSolid = _extraSolidAtModifier(mod.modifier_node_id)
                      const showSolid = isPickedMod || isExtraSolid
                      const otherMatch = _otherCoversModifier(mod.modifier_node_id)
                      const showDashed = !!otherMatch && !showSolid
                      // Dynamic-resolution typically lands on a sceneNode,
                      // but if a writer's dynamic pin ever resolves to a
                      // modifier (forward-compat for future MCP / API
                      // shapes that allow it), surface it consistently.
                      const showDotted = _dynPoint === mod.modifier_node_id
                      if (showSolid) rings.push(<_ChainPointRing key="solid" dotSize={MOD_DOT_SIZE} kind="solid" />)
                      if (showDashed) rings.push(<_ChainPointRing key="dashed" dotSize={MOD_DOT_SIZE} kind="dashed" />)
                      if (showDotted) rings.push(<_ChainPointRing key="dotted" dotSize={MOD_DOT_SIZE} kind="dotted" offset={showSolid || showDashed ? 18 : 10} dimmed />)
                      return rings.length === 0 ? null : rings
                    })()}
                    {(() => {
                      const otherMatch = _otherCoversModifier(mod.modifier_node_id)
                      if (!otherMatch || !onOtherPinMarkerContextMenu) return null
                      return (
                        <div
                          className="absolute inset-0"
                          onContextMenu={(e) => {
                            e.preventDefault()
                            onOtherPinMarkerContextMenu(otherMatch.sessionId, mod.modifier_node_id, { x: e.clientX, y: e.clientY }, otherMatch)
                          }}
                          title={`Already attached as context: ${otherMatch.label || ''}. Right-click to remove.`}
                          style={{ pointerEvents: 'auto' }}
                        />
                      )
                    })()}
                  </div>
                )
              })}
            </div>

            {/* Final cell — sticky-right at 0. */}
            {(() => {
              const col = gridColumns.find((c) => c._kind === 'final')
              if (!col) return null
              const colIdx = gridColumns.length - 1
              const hasDot = dotCols.has(col.id)
              const isPicked = colIdx === pickIdx
              const dotTitleText = (dotTooltip || defaultDotTooltip)(ent, col)
              return (
                <div
                  key={col.id}
                  className="sticky z-10 relative border-l border-zinc-800 flex items-center justify-center bg-zinc-800"
                  style={{ right: 0, width: ORIGIN_FINAL_W, height: ROW_H, flexShrink: 0 }}
                >
                  {hasDot && (
                    <button
                      type="button"
                      onClick={() => handleDotClickWrapped(ent.id, col)}
                      onKeyDown={handleDotKeyDown}
                      data-dot-key={`${ent.id}|scene|${col.id}`}
                      className="absolute inline-flex items-center justify-center bg-transparent border-0 p-0 transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-accent-400 rounded-full z-10"
                      style={{
                        width: BOOKEND_GLYPH_SIZE,
                        height: BOOKEND_GLYPH_SIZE,
                        inset: 0,
                        margin: 'auto',
                        color: finalColour,
                      }}
                      title={dotTitleText}
                    >
                      <BookendDotGlyph size={BOOKEND_GLYPH_SIZE} />
                    </button>
                  )}
                  {(() => {
                    // Phase 2.7c — Final bookend ring stacking.
                    const rings = []
                    const showSolid = isPicked || _extraSolidAtFinal
                    const showDashed = !!_otherCoversFinal && !showSolid
                    if (showSolid) rings.push(<_ChainPointRing key="solid" dotSize={BOOKEND_GLYPH_SIZE} kind="solid" offset={6} />)
                    if (showDashed) rings.push(<_ChainPointRing key="dashed" dotSize={BOOKEND_GLYPH_SIZE} kind="dashed" offset={6} />)
                    return rings.length === 0 ? null : rings
                  })()}
                  {(() => {
                    if (!_otherCoversFinal || !onOtherPinMarkerContextMenu) return null
                    return (
                      <div
                        className="absolute inset-0"
                        onContextMenu={(e) => {
                          e.preventDefault()
                          onOtherPinMarkerContextMenu(_otherCoversFinal.sessionId, '__final__', { x: e.clientX, y: e.clientY }, _otherCoversFinal)
                        }}
                        title={`Already attached as context: ${_otherCoversFinal.label || ''}. Right-click to remove.`}
                        style={{ pointerEvents: 'auto' }}
                      />
                    )
                  })()}
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}


// Wrap in `memo` so parent re-renders don't cascade through. Phase
// 2.11 Bugs & Fixes — profile `profiling-data.2026-05-31.19-28-15.json`
// showed `TimelineGridView` rendering 170 times for 158 ms self, with
// 137 / 170 renders citing `Props changed: [gridEntities, importPicks,
// extraSelectedDots, rangeFillSpans, dotTooltip, modifierDotTooltip]`.
// Callers must pass stable refs for these props for the bailout to
// fire — `ChainRangeSelector` was updated alongside this commit to
// memoise its `gridEntities`, `dotTooltip` and `modifierDotTooltip`
// values; other consumers (Timeline Navigator + Import dialog) already
// pass stable references via their own `useMemo` / `useCallback`.
export default memo(TimelineGridView)
