// Shared identity-badge components for consistent visual identification of
// entities, relationships, scenes, and modifier nodes across dialogs,
// alerts, and any other UI surface that references them. Extracted so the
// same visual language appears everywhere rather than being re-implemented
// per-site.
//
// Consumers today:
//   - AlertsPanel.jsx (node identity in alert bodies)
//   - projectStore.js via `buildDuplicateRelMessage` (duplicate-relationship
//     confirm dialog)

import { memo } from 'react'
import ImageHoverPreview from './ImageHoverPreview'
import { TYPE_ICONS, buildParticipantNameItems, participantsFallbackLabel } from '../../utils/entityHelpers'
import { DEFAULT_POV_COLOR } from '../../utils/povConstants'
import { useProjectStore } from '../../store/projectStore'

const REL_COLOUR = '#a78bfa'
const SCENE_COLOUR = '#a855f7' // purple-500 — matches scene badge tint in AlertsPanel
// Parchment/tan — faded soft brown, distinct from the amber used by modifier
// nodes and the POV default colour so the Knowledge identity reads at a
// glance. Exported for consumers that need the hex inline (detail panel
// headers, nav bar badges) — internal badge primitives below use it directly.
export const KNOWLEDGE_COLOUR = '#b89968'

// Phase 2.8 — Context Cue and Conversation badges. Cues use a
// green→yellow gradient (bottom-left → top-right) with a
// puzzle-piece glyph; conversations use a solid indigo tint with a
// speech-bubble glyph. Both follow the same chrome / sizing
// conventions as `RelationshipLabelChip` / `KnowledgeLabelChip` so
// every identity badge in the program reads as part of the same
// visual language.
export const CUE_COLOUR_START = '#10b981'    // emerald-500 — bottom-left of the gradient
export const CUE_COLOUR_END   = '#facc15'    // yellow-400 — top-right of the gradient
export const CONVERSATION_COLOUR = '#6366f1' // indigo-500

/** Canonical relationship identity icon — circled two-way arrow. */
/**
 * Canonical relationship arrow geometry — `↔` glyph drawn as three
 * paths inside a 16×16 viewBox, integer-aligned, symmetric about
 * (8, 8) so any rasteriser rounding is applied equally to both
 * halves. Used by:
 *   - `RelationshipIcon`        — adds an outer circular ring.
 *   - `RelationshipArrow`       — bare arrow (no ring) for callers
 *                                 that wrap it in their own framing.
 *   - Any place that draws the relationship arrow inline should
 *     use ONE of these exports rather than duplicating the path
 *     data, so visual drift between surfaces is impossible.
 */
export const RELATIONSHIP_ARROW_PATHS = (
  <>
    {/* Stem from x=3 to x=13 (arrow apex on each side). With the
        outer ring at r=7 from centre (8,8), the ring's inner stroke
        edge sits at r≈6.25 viewBox units. The arrow apex at distance
        5 from centre (plus a half-stroke of ~0.7) extends to r≈5.7
        — leaving a small clear gap (~0.55 viewBox units) between
        the arrow tip and the inner edge of the ring; close enough
        to read as a tight ↔ glyph, far enough not to actually
        touch. Tips are true 45° (3 horizontal × 3 vertical), all
        integer coordinates, symmetric about (8, 8). */}
    <path d="M3 8 H13" />
    <path d="M6 5 L3 8 L6 11" />
    <path d="M10 5 L13 8 L10 11" />
  </>
)

/**
 * Bare relationship-arrow SVG (no ring). For callers that supply
 * their own visual framing (e.g. a rounded-rectangle background)
 * or that want the arrow standalone inside a chip.
 *
 *   `size`        — SVG width / height. Accepts number (px) OR
 *                   string (e.g. "55%") for percent-of-parent
 *                   sizing.
 *   `strokeWidth` — Stroke width in viewBox units (default 1.4).
 *                   The viewBox is 16 units so each unit = size/16
 *                   pixels at render time.
 *   `colour`      — Stroke colour. Defaults to the canonical
 *                   relationship violet.
 *   `className`   — Optional class passthrough for layout (e.g.
 *                   `inline-block align-middle flex-shrink-0`).
 */
export function RelationshipArrow({ size = 12, strokeWidth = 1.4, colour = REL_COLOUR, className = '' }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke={colour} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      className={className}
    >
      {RELATIONSHIP_ARROW_PATHS}
    </svg>
  )
}

export function RelationshipIcon({ size = 12 }) {
  // Both the ring AND the arrow are drawn inside a SINGLE SVG so the
  // browser's rasteriser handles them in one pass — they're locked to
  // the same coordinate space and cannot disagree by sub-pixels.
  // Previously the ring was a CSS `border` on the outer span and the
  // arrow was an inner SVG centred via flexbox; at odd `size` values
  // (e.g. 15) the inner SVG sat at a fractional pixel offset (e.g.
  // 2.5px from the left of the container) and anti-aliasing of the
  // SVG arrow could drift relative to the integer-rounded CSS border
  // ring. Symmetric in geometry but visually misaligned because the
  // two passes use different rounding heuristics. Same class of fix
  // applied to the timeline-navigator dots.
  //
  // ViewBox is 16x16 with centre at (8, 8) — a clean integer
  // alignment point that maps cleanly to any rendered size. The
  // glyph is symmetric about (8, 8) so any rounding the rasteriser
  // applies is applied equally to both halves.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={REL_COLOUR}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block flex-shrink-0 align-middle"
      data-help-region="badge:relationship_icon"
    >
      {/* Outer ring. r=7 leaves 1px around the geometric edge of the
          viewBox so the 1.5px stroke (extending ±0.75 from r) fits
          fully inside the 16-unit box (visible band 6.25 to 7.75). */}
      <circle cx="8" cy="8" r="7" strokeWidth="1.5" />
      {/* Arrow geometry routes through `RELATIONSHIP_ARROW_PATHS` —
          the canonical source — so visual drift between ring-and-
          arrow icons and bare-arrow icons is impossible. The strokes
          here inherit `strokeWidth="1.4"` from the parent SVG below. */}
      <g strokeWidth="1.4">
        {RELATIONSHIP_ARROW_PATHS}
      </g>
    </svg>
  )
}

/** Compact relationship-identity chip: icon + name with subtle violet
 *  border/tint. Matches the visual treatment used on relationship chips in
 *  scenes and on the relationship origin node.
 *
 *  Content can be passed as either `name` (plain string — used for the
 *  tooltip and inline display) or as `children` (ReactNode — used when the
 *  label needs styled fragments such as italic ` as {alias}` suffixes from
 *  <ParticipantsFallbackLabel>). When both are provided, `children` is
 *  rendered and `name` feeds the tooltip.
 */
export function RelationshipLabelChip({ name, children, onClick, size = 'sm' }) {
  const clickable = !!onClick
  const isLg = size === 'lg'
  // Relationship icon retains its ring border (unlike Knowledge,
  // whose 📜 emoji needs no nested framing) — the ring around the
  // arrow glyph is part of the relationship's established visual
  // identity. Pinned inside a flex-shrink-0 wrapper so the icon
  // doesn't compress when the chip is narrow. Asymmetric padding
  // (`pl-0.5 pr-1.5`) brings the icon close to the left border,
  // matching the natural top / bottom whitespace — same pattern
  // applied to `EntityLabelChip` and `KnowledgeLabelChip`.
  const iconSize = isLg ? 14 : 10
  return (
    <span
      className={
        'inline-flex items-center gap-1 pl-0.5 pr-1.5 py-0 rounded font-medium whitespace-nowrap overflow-hidden max-w-full align-middle ' +
        (isLg ? 'text-xs' : 'text-[10px]') +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{ border: `1px solid ${REL_COLOUR}66`, backgroundColor: `${REL_COLOUR}18` }}
      title={typeof name === 'string' ? name : undefined}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:relationship_chip"
    >
      <span
        className="inline-flex items-center justify-center flex-shrink-0"
        style={{ width: iconSize, height: iconSize }}
      >
        <RelationshipIcon size={iconSize} />
      </span>
      <span className="text-zinc-100 truncate min-w-0">{children ?? name}</span>
    </span>
  )
}

/** Canonical knowledge identity icon — 📜 scroll glyph in a rounded-square
 *  parchment-tinted frame. Shape matches entity-chip avatars used throughout
 *  the canvas so Knowledge reads as a first-class object alongside entities. */
export function KnowledgeIcon({ size = 12 }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm flex-shrink-0 leading-none select-none"
      style={{
        width: size,
        height: size,
        border: `1.5px solid ${KNOWLEDGE_COLOUR}`,
        backgroundColor: `${KNOWLEDGE_COLOUR}22`,
        fontSize: Math.max(7, Math.round(size * 0.65)),
      }}
      data-help-region="badge:knowledge_icon"
    >
      📜
    </span>
  )
}

/** Compact knowledge-identity chip: icon + name with subtle parchment
 *  border/tint. Mirrors `RelationshipLabelChip` — use anywhere a Knowledge
 *  is referenced inline in prose (alerts, dialogs, detail panel surfaces).
 *
 *  Content can be passed as either `name` (plain string — feeds the tooltip
 *  and inline display) or as `children` (ReactNode). When both are provided,
 *  `children` is rendered and `name` feeds the tooltip. */
export function KnowledgeLabelChip({ name, children, onClick, size = 'sm' }) {
  const clickable = !!onClick
  const isLg = size === 'lg'
  // Bare 📜 glyph (NOT the bordered+tinted `KnowledgeIcon` component) —
  // the chip's own coloured border already frames the row; nesting a
  // second border around the icon reads as visual noise. Mirrors the
  // entity library panel's Knowledge tab pattern (bare TYPE_ICONS
  // entry). Sized to match the entity-avatar visual weight at the
  // same chip size, pinned inside a flex-shrink-0 square wrapper so
  // the glyph never compresses when the chip is narrow. Asymmetric
  // padding (`pl-0.5 pr-1.5`) puts the icon close to the left border,
  // matching the natural top / bottom whitespace — same pattern used
  // by `EntityLabelChip`.
  const iconSize = isLg ? 14 : 10
  return (
    <span
      className={
        'inline-flex items-center gap-1 pl-0.5 pr-1.5 py-0 rounded font-medium whitespace-nowrap overflow-hidden max-w-full align-middle ' +
        (isLg ? 'text-xs' : 'text-[10px]') +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{ border: `1px solid ${KNOWLEDGE_COLOUR}66`, backgroundColor: `${KNOWLEDGE_COLOUR}18` }}
      title={typeof name === 'string' ? name : undefined}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:knowledge_chip"
    >
      <span
        className="inline-flex items-center justify-center flex-shrink-0 leading-none select-none"
        style={{ width: iconSize, height: iconSize, fontSize: iconSize }}
        aria-hidden="true"
      >📜</span>
      <span className="text-zinc-100 truncate min-w-0">{children ?? name}</span>
    </span>
  )
}

/** Renders a relationship's participants-fallback label as JSX, with each
 *  participant's ` as {alias}` suffix shown in subtle italic grey to match
 *  the Participants list in the relationship detail panel. Drop-in
 *  replacement for `{participantsFallbackLabel(...)}` in JSX contexts.
 *
 *  Props mirror the string helper's arguments:
 *    - participants: array of { entity_id }
 *    - getEntity: (id) => entity | undefined
 *    - sliceMax: optional truncation threshold
 *    - rel: optional relationship; when provided, aliases from its history
 *      are included (see `buildAliasMap` in entityHelpers.js).
 */
// `memo` wrap so this component doesn't re-render on every parent
// commit. Phase 2.11 Bugs & Fixes — profile capture
// `profiling-data.2026-05-31.19-51-32.json` showed
// `ParticipantsFallbackLabel` at 233 renders / 64 ms self. It's used
// inside `RelationshipLabelStack` which renders inside
// `TimelineGridView`'s relationship rows, so every drag-selection
// mousemove cascades through it for every relationship row visible.
// Most callers pass stable `getEntity` (Zustand action) and
// `resolveName` (`useCallback`-wrapped or omitted); when `participants`
// is also a stable array, the memo bails out.
export const ParticipantsFallbackLabel = memo(function ParticipantsFallbackLabel({ participants, getEntity, sliceMax = Infinity, rel = null, resolveName = null }) {
  const { items, truncated } = buildParticipantNameItems(participants, getEntity, sliceMax, rel, resolveName)
  if (items.length === 0) return null
  // Alias suffix scales with the surrounding font size via `em` units (0.85em
  // → always ~85% of whatever the parent chip / badge is using). Subtle grey
  // italic, matching the participants list in the relationship detail panel.
  const nodes = items.map((it, i) => (
    <span key={i}>
      {it.name}
      {it.alias && (
        <span className="text-zinc-500 italic" style={{ fontSize: '0.85em' }}>
          {' '}as {it.alias}
        </span>
      )}
    </span>
  ))
  if (truncated > 0) {
    return (
      <>
        {nodes.map((n, i) => (
          <span key={i}>
            {n}
            {i < nodes.length - 1 && ', '}
          </span>
        ))}
        {` + ${truncated} more`}
      </>
    )
  }
  if (nodes.length === 1) return nodes[0]
  if (nodes.length === 2) return <>{nodes[0]} & {nodes[1]}</>
  const last = nodes[nodes.length - 1]
  return (
    <>
      {nodes.slice(0, -1).map((n, i) => (
        <span key={i}>
          {n}
          {', '}
        </span>
      ))}
      & {last}
    </>
  )
})

/**
 * Relationship label with optional participant-synthesis subtitle.
 *
 * - When `name` is set → renders `name` as the primary line with
 *   <ParticipantsFallbackLabel> stacked below as a smaller italic subtitle.
 *   The subtitle uses `em`-based sizing relative to parent font so each
 *   consumer controls line height via its own class (canvas chip vs. sidebar
 *   vs. timeline row differ in base size).
 * - When `name` is null/empty → renders ONLY the <ParticipantsFallbackLabel>
 *   as the primary line (no subtitle). Matches the previous single-line
 *   participant-synthesis behavior so there's never a redundant duplicate.
 *
 * The caller controls vertical alignment and outer height via flex classes.
 */
export function RelationshipLabelStack({
  name,
  participants,
  getEntity,
  sliceMax = 3,
  rel = null,
  primaryClass = '',
  subtitleClass = '',
  resolveName = null,
}) {
  const hasName = name && String(name).trim().length > 0
  if (!hasName) {
    return (
      <ParticipantsFallbackLabel
        participants={participants}
        getEntity={getEntity}
        sliceMax={sliceMax}
        rel={rel}
        resolveName={resolveName}
      />
    )
  }
  return (
    <span className="flex flex-col min-w-0 leading-tight">
      <span className={`truncate ${primaryClass}`}>{name}</span>
      <span className={`truncate text-zinc-500 italic ${subtitleClass}`} style={{ fontSize: '0.72em' }}>
        <ParticipantsFallbackLabel
          participants={participants}
          getEntity={getEntity}
          sliceMax={sliceMax}
          rel={rel}
          resolveName={resolveName}
        />
      </span>
    </span>
  )
}

/** Small rounded-rectangle avatar with entity-colour border and
 *  hover-to-enlarge preview. Falls back to a type-icon badge when the
 *  entity has no profile image. Shape matches entity-chip avatars used
 *  throughout the canvas and entity library. */
export function EntityAvatar({ entity, size = 18 }) {
  if (!entity) return null
  const colour = entity.colour || '#888888'
  const profileRef = entity.profile_image_ref || null
  // profile_image_ref can be either an `assets/<filename>` path that
  // resolves through the backend's project-asset endpoint, OR an inline
  // `data:` URL passed through directly (data URLs are valid <img src>
  // values). Data URLs let callers attach an image without writing to
  // the project asset store — useful for transient / runtime-supplied
  // images that don't need to round-trip through save.
  let src = null
  if (profileRef) {
    if (profileRef.startsWith('data:')) {
      src = profileRef
    } else {
      const assetName = profileRef.replace(/^assets\//, '')
      src = `/api/project/assets/${assetName}`
    }
  }
  const border = `1.5px solid ${colour}`
  if (src) {
    // Shift-click → open in Media Preview Panel. Descriptor mirrors
    // the shape every other "open in preview" call site (chat
    // attachments, attribute file pills, etc.) uses — `type` is the
    // discriminator the panel's source badge branches on; `fileRef`
    // / `url` is what the media-element pool resolves to an asset
    // URL. The entity context fields (`entityName`, `entityColour`,
    // `entityId`) ride along so the preview panel's badge can show
    // who this image belongs to and offer click-to-navigate back to
    // the entity. We pass the caller's already-chain-resolved values
    // through verbatim — `entity` reaching this component is the
    // already-resolved object for whichever anchor the surface above
    // cares about, baseline or scene-walked.
    const previewSource = profileRef.startsWith('data:')
      ? {
          type: 'entity_profile',
          entityId: entity.id,
          url: profileRef,
          entityName: entity.name,
          entityColour: colour,
        }
      : {
          type: 'entity_profile',
          entityId: entity.id,
          fileRef: profileRef,
          entityName: entity.name,
          entityColour: colour,
        }
    return (
      <ImageHoverPreview src={src} borderColour={colour} size={100} previewSource={previewSource}>
        <img
          src={src}
          alt=""
          className="inline-block rounded-sm object-cover align-middle flex-shrink-0"
          style={{ width: size, height: size, border }}
          data-help-region="badge:entity_avatar"
        />
      </ImageHoverPreview>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm flex-shrink-0 align-middle"
      style={{
        width: size, height: size, border,
        backgroundColor: `${colour}22`,
        fontSize: Math.max(9, Math.round(size * 0.55)),
      }}
      data-help-region="badge:entity_avatar"
    >
      {TYPE_ICONS[entity.type] || '?'}
    </span>
  )
}

/** Compact entity-identity chip: small avatar + name with entity-coloured
 *  border / tint. Mirrors `KnowledgeLabelChip` / `RelationshipLabelChip`
 *  — use anywhere an Entity is referenced inline in prose (alerts,
 *  dialogs, detail panel surfaces, perspective target chips).
 *
 *  Content can be passed as either `name` (plain string — feeds the
 *  tooltip and inline display) or as `children` (ReactNode). When both
 *  are provided, `children` is rendered and `name` feeds the tooltip.
 *  The frame colour comes from `entity.colour`; falls back to neutral
 *  grey if absent. */
export function EntityLabelChip({ entity, name, children, onClick, size = 'sm', suffix = null }) {
  if (!entity && !name && !children) return null
  const clickable = !!onClick
  const isLg = size === 'lg'
  const colour = entity?.colour || '#888888'
  const displayName = children ?? name ?? entity?.name
  const avatarSize = isLg ? 16 : 10
  // Asymmetric horizontal padding: left padding sits at 2px so the
  // avatar's left edge mirrors the natural ~2px gap from the avatar's
  // top / bottom to the chip border (the avatar is the tallest inline
  // child and there's no explicit vertical padding). Right padding
  // stays at 6px to give the name string a more comfortable breathing
  // room from the right border. When there's no entity / no avatar
  // (name-only render), fall back to symmetric px-1.5 so the name
  // string isn't sitting flush against the left border.
  const horizontalPad = entity ? 'pl-0.5 pr-1.5' : 'px-1.5'
  return (
    <span
      className={
        'inline-flex items-center gap-1 ' + horizontalPad + ' py-0 rounded font-medium whitespace-nowrap overflow-hidden max-w-full align-middle ' +
        (isLg ? 'text-xs' : 'text-[10px]') +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{ border: `1px solid ${colour}66`, backgroundColor: `${colour}18` }}
      title={typeof name === 'string' ? name : (typeof entity?.name === 'string' ? entity.name : undefined)}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:entity_chip"
    >
      {entity && (
        // The EntityAvatar wraps its img in `<ImageHoverPreview>` which
        // is an `inline-flex` <span> without `flex-shrink-0`. Inside a
        // chip whose horizontal space is constrained by a longer name,
        // that wrapper can squeeze the square img into a non-square
        // rectangle. Pin the avatar inside a fixed-dimension
        // flex-shrink-0 container so the profile image always reads
        // as a clean square regardless of available chip width.
        <span
          className="inline-flex items-center justify-center flex-shrink-0"
          style={{ width: avatarSize, height: avatarSize }}
        >
          <EntityAvatar entity={entity} size={avatarSize} />
        </span>
      )}
      <span className="text-zinc-100 truncate min-w-0">{displayName}</span>
      {/* Optional inline suffix — rendered INSIDE the chip border so
          additional badges (e.g. a `[POV]` marker for the POV
          character on a scene refinement card) sit visually inside
          the same enclosure as the name + avatar, rather than
          floating beside the chip as a separate element. */}
      {suffix && (
        <span className="flex-shrink-0 inline-flex items-center">
          {suffix}
        </span>
      )}
    </span>
  )
}

/** Entity display used inside the duplicate-rel confirm dialog: small
 *  avatar (with hover preview) + entity name, optionally followed by a
 *  subtle italic `as {alias}` when the entity is currently represented
 *  under an alias in the detected relationship. */
export function EntityAvatarName({ entity, aliasOverride, onClick }) {
  if (!entity) return null
  const clickable = !!onClick
  return (
    <span
      className={
        'inline-flex items-center gap-1 align-middle whitespace-nowrap' +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      onClick={onClick}
      role={clickable ? 'button' : undefined}
    >
      <EntityAvatar entity={entity} />
      <span className="text-zinc-100 font-medium">{entity.name}</span>
      {aliasOverride && (
        <span className="text-zinc-500 italic" style={{ fontSize: '0.85em' }}>
          as {aliasOverride}
        </span>
      )}
    </span>
  )
}

/** "Where was this rel born?" badge. Two variants, matching the on-canvas
 *  node identity of the birth node:
 *    - 'origin' → `NEW : RELATIONSHIP [name]`  (rel-origin-node)
 *    - 'scene'  → `SCENE : [title]`            (plot-point node)
 */
export function RelationshipBirthBadge({ kind, label, labelNode, onClick }) {
  const clickable = !!onClick
  const tint = kind === 'origin' ? REL_COLOUR : SCENE_COLOUR
  const typeLabel = kind === 'origin' ? 'NEW : RELATIONSHIP' : 'SCENE'
  return (
    <span
      className={
        'inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold whitespace-nowrap overflow-hidden max-w-full align-middle' +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{ backgroundColor: `${tint}22`, border: `1px solid ${tint}66` }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      title={typeof label === 'string' ? label : undefined}
    >
      <span style={{ color: tint }} className="flex-shrink-0">{typeLabel}</span>
      <span className="text-zinc-100 normal-case tracking-normal font-semibold truncate min-w-0">
        {labelNode ?? label}
      </span>
    </span>
  )
}

/**
 * Canonical POV glyph — the tiny pill marked `POV` in the story's POV
 * colour that the alerts panel and canvas use to represent the POV origin
 * node / POV system at-a-glance. Dimensions and styling mirror the POV
 * chip as it appears inside a scene's POV bar so the glyph reads as a
 * miniature of the same thing.
 *
 * Callers: anywhere referring to "the POV" at inline/text scale (e.g.
 * `<PovStartGlyph /> in <NodeBadge for scene />`). The `povOriginNode`
 * case of `NodeBadge` uses this directly, producing a glyph-style render
 * rather than a labeled `POV : START` badge — matches the design choice
 * already established in the alerts panel.
 */
export function PovStartGlyph() {
  const povColour = useProjectStore.getState().story?.pov_color || DEFAULT_POV_COLOR
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm text-[8px] font-bold flex-shrink-0 align-middle"
      style={{
        width: 24, height: 13,
        color: povColour,
        backgroundColor: '#27272a',
        border: `1.5px solid ${povColour}`,
        borderRadius: 3,
        lineHeight: 1,
      }}
      data-help-region="badge:pov_start_glyph"
    >POV</span>
  )
}

// ── Shared badge style presets (canvas node identity bar / alert references) ──
// Keep in sync with the on-canvas node headers. Each preset is `{ label,
// labelCls, bgCls }` where labelCls colours the type-label prefix and bgCls
// carries the background tint. Additional label text (e.g. `: CHARACTER`) is
// concatenated onto `label` per-node-type by the consumer.
const NODE_BADGE_STYLES = {
  scene:          { label: 'SCENE',             labelCls: 'text-purple-400',  bgCls: 'bg-purple-900/30 hover:bg-purple-900/50' },
  flashback:      { label: 'SCENE : FLASHBACK', labelCls: 'text-purple-400',  bgCls: 'bg-purple-900/30 hover:bg-purple-900/50' },
  originEntity:   { label: 'NEW',               labelCls: 'text-green-400',   bgCls: 'bg-green-900/30 hover:bg-green-900/50'   },
  modifierEntity: { label: 'MODIFIER',          labelCls: 'text-amber-400',   bgCls: 'bg-amber-900/30 hover:bg-amber-900/50'   },
  originRel:      { label: 'NEW : RELATIONSHIP',labelCls: 'text-violet-400',  bgCls: 'bg-violet-900/30 hover:bg-violet-900/50' },
  reference:      { label: 'REFERENCE',         labelCls: 'text-sky-400',     bgCls: 'bg-sky-900/30 hover:bg-sky-900/50'       },
  group:          { label: 'GROUP',             labelCls: 'text-zinc-400',    bgCls: 'bg-zinc-800/50 hover:bg-zinc-700/60'     },
  // POV uses an inline style (dynamic per-story POV colour) instead of Tailwind
  // classes; `label` + `bgCls` are placeholder values not used when pov=true.
  pov:            { label: 'POV : START',       labelCls: '',                  bgCls: '' },
  // Fallback for nodes the component can't identify (defensive — shouldn't
  // trigger in practice).
  unknown:        { label: 'NODE',              labelCls: 'text-zinc-400',    bgCls: 'bg-zinc-800/50 hover:bg-zinc-700/60'     },
}

/**
 * Resolve a node to a `{ style, name, isPov }` tuple for rendering.
 * Internal helper — callers use `<NodeBadge>` below. Exported so the
 * occasional non-Badge caller (e.g. a text-only alert-list summary) can
 * derive the same label/style without rebuilding the dispatch logic.
 */
export function resolveNodeBadge(node, entityMap) {
  if (!node) return { style: NODE_BADGE_STYLES.unknown, name: 'Unknown node', isPov: false }
  if (node.type === 'sceneNode') {
    const style = node.data?.is_flashback ? NODE_BADGE_STYLES.flashback : NODE_BADGE_STYLES.scene
    const name = node.data?.title || node.data?.description || 'Untitled Scene'
    return { style, name, isPov: false }
  }
  if (node.type === 'entityNode') {
    const hasEntityId = !!node.data?.entity_id
    const entity = hasEntityId ? entityMap?.get(node.data.entity_id) : null
    const typeName = entity?.type ? entity.type.toUpperCase() : ''
    const base = node.data?.is_modifier ? NODE_BADGE_STYLES.modifierEntity : NODE_BADGE_STYLES.originEntity
    const style = { ...base, label: base.label + (typeName ? ` : ${typeName}` : '') }
    // Blank modifier (no entity_id yet) has no meaningful name -- render
    // just the "MODIFIER" label pill, not "MODIFIER : Unknown". Resolves
    // to empty string which the NodeBadge render treats as "skip the name
    // span entirely".
    let name
    if (node.data?.is_modifier) {
      name = node.data?.name_change || entity?.name || (hasEntityId ? 'Unknown' : '')
    } else {
      name = entity?.name || 'Unknown'
    }
    return { style, name, isPov: false }
  }
  if (node.type === 'relationshipOriginNode') {
    const rels = useProjectStore.getState().relationships || []
    const rel = rels.find((r) => r.id === node.data?.relationship_id)
    let name = 'Relationship'
    if (rel?.name) {
      name = rel.name
    } else if (rel) {
      const joinIds = Array.from(new Set(
        (rel.history?.participant_changes || [])
          .filter((c) => c.action === 'join')
          .map((c) => c.entity_id)
      ))
      name = participantsFallbackLabel(
        joinIds.map((eid) => ({ entity_id: eid })),
        (eid) => entityMap?.get(eid),
        3,
        rel,
      ) || 'Relationship'
    }
    return { style: NODE_BADGE_STYLES.originRel, name, isPov: false }
  }
  if (node.type === 'povOriginNode') {
    return { style: NODE_BADGE_STYLES.pov, name: 'Start', isPov: true }
  }
  if (node.type === 'referenceNode') {
    const name = node.data?.title || 'Untitled Reference'
    return { style: NODE_BADGE_STYLES.reference, name, isPov: false }
  }
  if (node.type === 'genericGroupNode') {
    const name = node.data?.title || 'Untitled Group'
    return { style: NODE_BADGE_STYLES.group, name, isPov: false }
  }
  return { style: NODE_BADGE_STYLES.unknown, name: node.id || 'Unknown node', isPov: false }
}

/**
 * Canonical node-identity badge — the shared "SCENE : Title" /
 * "NEW : CHARACTER : Alice" / "NEW : RELATIONSHIP : label" / etc. visual
 * used across alerts, dialogs, and error messages to reference a specific
 * canvas node. Extracts + generalises the `AlertNodeBadge` / `SourceNodeBadge`
 * pattern that previously lived as local helpers inside `AlertsPanel.jsx`.
 *
 * Props:
 *   - nodeId:    id of the node to render
 *   - nodes:     full nodes array (looked up by id)
 *   - entityMap: optional Map<entityId, entity> — required for entityNode
 *                lookups; optional otherwise
 *   - onClick:   optional; when present, the badge renders as a button
 *                (typical use: navigate viewport to the node). Matches the
 *                clickable-via-onClick pattern used by `RelationshipLabelChip`,
 *                `EntityAvatarName`, and `RelationshipBirthBadge` in this
 *                same module.
 *   - fallback:  optional node to render when lookup fails (default: null,
 *                renders nothing; `SourceNodeBadge` historically rendered
 *                the string 'upstream' as its fallback — callers needing
 *                that behaviour pass it explicitly).
 *
 * Returns null when the node can't be resolved AND no fallback is given,
 * so callers don't have to null-guard.
 *
 * Covers every node type the app currently registers: sceneNode
 * (including the flashback variant), entityNode (origin + modifier),
 * relationshipOriginNode, povOriginNode, referenceNode, genericGroupNode.
 */
export function NodeBadge({ nodeId, nodes, entityMap, onClick, fallback = null }) {
  if (!nodeId || !nodes) return fallback
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return fallback

  const { style, name, isPov } = resolveNodeBadge(node, entityMap)
  const clickable = !!onClick
  const baseCls = 'inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold whitespace-nowrap overflow-hidden max-w-full align-middle'
  const interactionCls = clickable ? ' cursor-pointer transition-colors' : ''
  const title = clickable ? `Navigate to ${style.label.toLowerCase()} on canvas` : name

  // POV origin node has a purpose-built glyph-style render — a miniature
  // of the POV chip from the canvas scene header, not the labeled-pill
  // treatment the other node types use. Matches the existing inline
  // treatment in `AlertsPanel.jsx` for POV-related alerts.
  if (isPov) {
    if (clickable) {
      return (
        <button
          type="button"
          className="inline-flex items-center gap-0 p-0 bg-transparent border-0 cursor-pointer align-middle"
          onClick={(e) => { e.stopPropagation(); onClick(nodeId) }}
          title="Navigate to POV start node on canvas"
        >
          <PovStartGlyph />
        </button>
      )
    }
    return <PovStartGlyph />
  }

  const inner = (
    <>
      {style.label && <span className={`${style.labelCls} whitespace-nowrap flex-shrink-0`}>{style.label}</span>}
      {name && <span className="text-zinc-100 normal-case tracking-normal font-semibold whitespace-nowrap truncate min-w-0" title={name}>{name}</span>}
    </>
  )
  if (clickable) {
    return (
      <button
        type="button"
        className={`${baseCls}${interactionCls} ${style.bgCls}`}
        onClick={(e) => { e.stopPropagation(); onClick(nodeId) }}
        title={title}
        data-help-region="badge:node_badge"
      >
        {inner}
      </button>
    )
  }
  return <span className={`${baseCls} ${style.bgCls.split(' ')[0]}`} title={title} data-help-region="badge:node_badge">{inner}</span>
}


/**
 * EventBadge — multi-line composite badge representing a chain-tracked
 * change event. Wraps the existing single-line badges (NodeBadge,
 * EntityAvatar) inside a cohesive container bordered with the
 * subject entity's colour, plus a change-indicator row showing the
 * value transition.
 *
 *   ┌─────────────────────────────────┐  ← border tinted entity.colour
 *   │ SCENE Scene 2                   │  ← NodeBadge (where it happened)
 *   │ [img] Alice                     │  ← entity row
 *   │ ✱ Title: Knight → Princess      │  ← change indicator + field + transition
 *   └─────────────────────────────────┘
 *
 * Props:
 *   entity          — resolved entity object (provides avatar, name, colour
 *                     for both border tint and name colour)
 *   nodeId          — the change's anchor scene id (drives the NodeBadge row)
 *   nodes           — project nodes (for NodeBadge to resolve)
 *   entityMap       — id → entity map for NodeBadge label fallbacks
 *   fieldLabel      — e.g. "Title", "Name", "Description"
 *   action          — 'add' | 'modify' | 'remove' (drives the indicator glyph + tint)
 *   oldValue        — pre-change value (string-ish; rendered as-is, italic when null)
 *   newValue        — post-change value
 *   onClick         — optional click handler (e.g. navigate to source change on canvas)
 */
export function EventBadge({ entity, nodeId, nodes, entityMap, fieldLabel, action, oldValue, newValue, onClick }) {
  const colour = entity?.colour || '#888888'
  const indicator = action === 'add' ? { glyph: '✚', cls: 'text-green-400' }
    : action === 'remove' ? { glyph: '⚊', cls: 'text-red-400' }
    : { glyph: '✱', cls: 'text-amber-400' }
  const clickable = typeof onClick === 'function'

  const fmtValue = (v) => {
    if (v == null || v === '') return <span className="italic text-zinc-500">(none)</span>
    return <span className="text-zinc-100">{String(v)}</span>
  }

  return (
    <div
      className={`inline-flex flex-col gap-1.5 px-2 py-1.5 rounded-md border-2 bg-zinc-800/60 text-[11px] max-w-full${clickable ? ' cursor-pointer hover:bg-zinc-800 transition-colors' : ''}`}
      style={{ borderColor: colour + 'aa' }}
      onClick={onClick}
      title={clickable ? 'Navigate to source change' : undefined}
    >
      {/* Top half: avatar on the left spans both rows; right column
          stacks the NodeBadge over the entity name. Avatar is larger
          (36px) so it reads as a portrait, not an inline glyph. */}
      <div className="flex items-center gap-2">
        {entity && (
          <EntityAvatar entity={entity} size={36} />
        )}
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          {nodeId && nodes && (
            <div className="flex items-center gap-1 flex-wrap">
              <NodeBadge nodeId={nodeId} nodes={nodes} entityMap={entityMap} />
            </div>
          )}
          {entity && (
            <span className="font-semibold truncate" style={{ color: colour }}>{entity.name || '(unnamed)'}</span>
          )}
        </div>
      </div>
      {/* Bottom row: change indicator + field + (optional) value
          transition. Full width across the badge.
            - modify with both sides defined → `Field: old → new`
            - add with only newValue       → `Field: newValue`
            - remove with only oldValue    → `Field: oldValue` (strike)
            - neither side supplied        → `Field` only
          Skipped entirely when neither action nor fieldLabel is set. */}
      {(action || fieldLabel) && (() => {
        const hasOld = oldValue !== undefined
        const hasNew = newValue !== undefined
        const hasTransition = hasOld && hasNew
        const showSingle = !hasTransition && (hasOld || hasNew)
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`${indicator.cls} font-bold leading-none`}>{indicator.glyph}</span>
            {fieldLabel && <span className="text-zinc-300 font-medium">{fieldLabel}{(hasTransition || showSingle) ? ':' : ''}</span>}
            {hasTransition && (
              <>
                {fmtValue(oldValue)}
                <span className="text-zinc-500">→</span>
                {fmtValue(newValue)}
              </>
            )}
            {showSingle && hasNew && fmtValue(newValue)}
            {showSingle && hasOld && (
              <span className="line-through text-zinc-400">
                {typeof oldValue === 'string' ? oldValue : String(oldValue)}
              </span>
            )}
          </div>
        )
      })()}
    </div>
  )
}


/** Canonical Context Cue identity icon — bare 🧩 puzzle-piece emoji.
 *  Unlike `RelationshipIcon` / `KnowledgeIcon`, the cue icon ships no
 *  surrounding frame: the emoji itself carries the colour and shape,
 *  matching how the Entity Library's cue tab renders it (see
 *  `EntityLibraryPanel.jsx`). */
export function CueIcon({ size = 12 }) {
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 leading-none select-none align-middle"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.95)),
      }}
    >
      🧩
    </span>
  )
}

/** Compact Context Cue identity chip: puzzle-piece icon + name with
 *  a green→yellow gradient backdrop (bottom-left → top-right). Use
 *  anywhere a Cue is referenced inline — chat-panel pinned-context
 *  chip, right-sidebar editor header, library row identity,
 *  alerts, etc. Mirrors `RelationshipLabelChip` / `KnowledgeLabelChip`
 *  chrome so all identity chips read as part of the same visual
 *  language.
 *
 *  Content can be passed as either `name` (plain string — feeds the
 *  tooltip and inline display) or as `children` (ReactNode). When
 *  both are provided, `children` is rendered and `name` feeds the
 *  tooltip. */
export function CueLabelChip({ name, children, onClick }) {
  const clickable = !!onClick
  return (
    <span
      className={
        'inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-medium whitespace-nowrap overflow-hidden max-w-full align-middle' +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{
        backgroundImage: `linear-gradient(to top right, ${CUE_COLOUR_START}33, ${CUE_COLOUR_END}33)`,
        border: `1px solid ${CUE_COLOUR_END}66`,
      }}
      title={typeof name === 'string' ? name : undefined}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:cue_chip"
    >
      <CueIcon size={10} />
      <span className="text-zinc-100 truncate min-w-0">{children ?? name}</span>
    </span>
  )
}


export const CONCEPT_COLOUR = '#40afd0' // cyan — the concept referenceNode default colour

/** Canonical Concept identity icon — bare 💡 lightbulb emoji (a concept is a
 *  brainstorming node), matching the frameless style of `CueIcon`. */
export function ConceptIcon({ size = 12 }) {
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 leading-none select-none align-middle"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.95)),
      }}
    >
      💡
    </span>
  )
}

/** Compact Concept identity chip: lightbulb icon + name on the concept's cyan
 *  backdrop. Use anywhere a Concept is referenced inline — chat-panel pinned-
 *  context chip, etc. Mirrors `CueLabelChip` chrome so all identity chips read
 *  as part of the same visual language. Content passed as `name` (string,
 *  feeds tooltip + display) or `children` (ReactNode). */
export function ConceptLabelChip({ name, children, onClick }) {
  const clickable = !!onClick
  return (
    <span
      className={
        'inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-medium whitespace-nowrap overflow-hidden max-w-full align-middle' +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{
        backgroundColor: `${CONCEPT_COLOUR}18`,
        border: `1px solid ${CONCEPT_COLOUR}66`,
      }}
      title={typeof name === 'string' ? name : undefined}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:concept_chip"
    >
      <ConceptIcon size={10} />
      <span className="text-zinc-100 truncate min-w-0">{children ?? name}</span>
    </span>
  )
}


/** Canonical Conversation identity icon — indigo speech-bubble SVG,
 *  no surrounding frame. The SVG art carries the colour and shape;
 *  the wrapper just sizes the slot. */
export function ConversationIcon({ size = 12 }) {
  const stroke = Math.max(1, size / 9)
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 leading-none align-middle"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke={CONVERSATION_COLOUR} strokeWidth={stroke * 1.3} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 4.5C2.5 3.4 3.4 2.5 4.5 2.5h7c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H7l-3 2.5V10.5H4.5c-1.1 0-2-.9-2-2v-4z" />
      </svg>
    </span>
  )
}

/** Compact Conversation identity chip: speech-bubble icon + name
 *  with a subtle indigo border / tint. Mirrors the other
 *  `*LabelChip` primitives. Use anywhere a chat conversation /
 *  thread is referenced inline — thread browser identity rows
 *  (eventually), alerts that mention a specific thread, the
 *  active-context strip if a thread is ever attached as context,
 *  etc. */
export function ConversationLabelChip({ name, children, onClick }) {
  const clickable = !!onClick
  return (
    <span
      className={
        'inline-flex items-center gap-1 px-1.5 py-0 rounded text-[12px] font-medium whitespace-nowrap overflow-hidden max-w-full align-middle' +
        (clickable ? ' cursor-pointer hover:brightness-125' : '')
      }
      style={{ border: `1px solid ${CONVERSATION_COLOUR}66`, backgroundColor: `${CONVERSATION_COLOUR}18` }}
      title={typeof name === 'string' ? name : undefined}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      data-help-region="badge:conversation_chip"
    >
      {/* Conversation chip uses `text-[12px]` (vs the cue chip's
          `text-[10px]`) to compensate for the SVG icon not bleeding
          beyond its box the way the cue chip's 🧩 emoji does. With
          text-[10px] the conversation chip rendered visibly shorter
          than the cue chip at the same nominal size — bumping the
          text-size raises the chip's line-box height enough to
          match the cue chip's visual footprint. Icon size 14 keeps
          the SVG visually proportionate to the larger text. */}
      <ConversationIcon size={14} />
      <span className="text-zinc-100 truncate min-w-0">{children ?? name}</span>
    </span>
  )
}


// Confirm-dialog message builders moved to `popupMessages.jsx` (the
// central popup-message repository). Import them from there instead.
