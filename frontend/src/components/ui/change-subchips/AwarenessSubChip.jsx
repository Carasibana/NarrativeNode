/**
 * AwarenessSubChip — Phase 1.21c Tier 4
 *
 * Renders one awareness-change row inside the "Awareness" sub-chip
 * section on an observer entity's chip at a scene (and on entity
 * origin / modifier nodes once those wirings land in follow-ups).
 *
 * Visual structure:
 *   - left: a single `<AwarenessBadge>` showing the new level glyph
 *           (✕ unaware / ⯁ nominally / ⁉ partially / ✓ fully — alias
 *           scale; ✕ / ✓ for binary). The badge is the indicator —
 *           level / colour communicate the awareness-state change
 *           (red ✕ = explicitly unaware, green ✓ = fully aware, etc.)
 *           in one glyph rather than splitting into a separate
 *           action-glyph + level-pill.
 *   - middle: target-identity badge — what the observer became aware
 *             *of* (entity avatar + name, attribute name, relationship
 *             label, or Knowledge label).
 *
 * The component is purely presentational. Source resolution happens
 * in the caller (SceneNode / EntityNode); the sub-chip just
 * renders the prepared row.
 *
 * Props:
 *   - record: a single entry from `getAwarenessChangesForObserverAtNode`
 *   - getEntity: resolver `(id) => Entity | null` for target-entity
 *                lookup (existence / attribute kinds)
 *   - getKnowledge: resolver `(id) => Knowledge | null` for the
 *                   knowledge kind (rare; record carries `.knowledge`
 *                   already so this is a fallback)
 *   - getRelationship: resolver `(id) => Relationship | null` for the
 *                      relationship kind
 */

import { useState } from 'react'
import { AwarenessBadge, awarenessLevelStyle, awarenessLabelsFor } from '../AwarenessBadges'
import { FallbackSubChip } from './atoms'
import { KnowledgeLabelChip, RelationshipLabelChip, EntityAvatar } from '../IdentityBadges'
import { participantsFallbackLabel } from '../../../utils/entityHelpers'

// Resolve a relationship's display name with the same fallback used
// throughout the app: explicit `name` first, otherwise synthesise from
// active participants (e.g. "Alice & Bob & Carol"). `getEntity` is the
// resolver passed to AwarenessSubChip so we can pull participant names
// without re-importing stores here.
function relationshipDisplayName(rel, getEntity) {
  const explicit = rel?.name?.trim()
  if (explicit) return explicit
  if (!rel) return 'Relationship'
  const joinIds = Array.from(new Set(
    ((rel.history?.participant_changes) || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id),
  ))
  const synth = participantsFallbackLabel(
    joinIds.map((eid) => ({ entity_id: eid })),
    getEntity,
    3,
    rel,
  )
  return synth || 'Relationship'
}

// Resolve the raw (untruncated) display value for an attribute. File /
// list attribute types use their content-specific shape; everything
// else falls back to the raw `value`.
function attributeRawValue(attr) {
  if (!attr) return ''
  if (attr.attribute_type === 'file') return attr.file_ref || ''
  if (attr.attribute_type === 'text_list') {
    try {
      const arr = JSON.parse(attr.value || '[]')
      return Array.isArray(arr) ? arr.join(', ') : (attr.value || '')
    } catch { return attr.value || '' }
  }
  return attr.value || ''
}

// Truncate at 24 chars (with ellipsis) so long values don't blow out
// the sub-chip width.
function truncateForChip(s, n = 24) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function tooltipForLevel(level) {
  if (level === null || level === undefined) return 'Awareness entry stripped'
  if (level === 0) return 'Explicitly unaware'
  if (level === 1) return 'Nominally aware'
  if (level === 2) return 'Partially aware'
  if (level === 3) return 'Fully aware'
  return 'Awareness change'
}

export default function AwarenessSubChip({ record, getEntity, getKnowledge, getRelationship, observerName, onClick, reviewFlagged = false, onRemove = null }) {
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState(false)
  if (!record) return null
  const showLevel = record.level !== null && record.level !== undefined
  // Phase 1.21h Fix #4 — for attribute awareness, look up the
  // attribute's `awareness_scale` so `AwarenessBadge` can collapse
  // non-zero stored levels onto the level-3 ✓ glyph in binary mode
  // (non-destructive view filter; data on disk unchanged).
  const attrScale = (record.kind === 'attribute' && record.targetEntityId && record.attributeId)
    ? (() => {
        const ent = getEntity?.(record.targetEntityId)
        const attr = (ent?.attributes || []).find((a) => a.id === record.attributeId)
        return attr?.awareness_scale || 'binary'
      })()
    : null

  // Target-identity badge selection — varies by record.kind.
  // `customTitle`, when set, replaces the default level-only tooltip
  // with one that includes the full untruncated value (used for kinds
  // whose value can get cut off in the chip).
  //
  // ─── EXTENSION POINT: adding a new awareness sub-chip kind ────────
  // If a new awareness surface lands in the walker
  // (`getAwarenessChangesForObserverAtNode` in `narrativeChain.js`),
  // add a matching branch below for the new `record.kind === '<kind>'`.
  // Conventions:
  //   - Compose the row from the parent identity chip on the LEFT
  //     (entity avatar+name, relationship chip, knowledge chip), then
  //     a `·` separator, then a short type label (e.g. "Name", "Alias",
  //     attribute name) and the value if applicable.
  //   - Long text should pass through `truncateForChip(...)`; when a
  //     truncation actually occurs, set `customTitle` so the hover
  //     tooltip reveals the full value.
  //   - Keep the level-glyph rendering (the `<AwarenessBadge>` at the
  //     end of the function) intact — it's surface-agnostic and applies
  //     uniformly to every kind.
  // Also add a row to `AwarenessSubChipsPage` in `DevPreviewPanel.jsx`
  // so the new kind can be reviewed in isolation.
  // Each kind populates `surface` + `pickerContext` so the default row
  // title resolves through `awarenessLabelsFor(surface, context)` —
  // giving the user a context-aware sentence ("Knows Alice exists",
  // "Doesn't know Alice's Age", "Knows 'Ali' is Alice", etc.) instead
  // of the bare scale label ("Fully aware" / "Explicitly unaware").
  let target = null
  let surface = null
  let pickerContext = null
  // Per-segment overrides — when set, an inner span uses its own title
  // (e.g. the truncated-value span shows the full untruncated value).
  let valueOverrideTitle = null

  if (record.kind === 'entity_existence') {
    const ent = getEntity?.(record.targetEntityId) || null
    const colour = ent?.colour || '#888888'
    surface = 'entity'
    pickerContext = { parentName: ent?.name || null }
    target = (
      <span className="inline-flex items-center gap-1 min-w-0">
        <EntityAvatar entity={ent} size={14} />
        <span className="text-[10px] text-zinc-200 truncate" style={{ color: colour }}>
          {ent?.name || '(entity)'}
        </span>
      </span>
    )
  } else if (record.kind === 'relationship') {
    const rel = getRelationship?.(record.relationshipId) || null
    const relName = relationshipDisplayName(rel, getEntity)
    surface = 'relationship'
    pickerContext = { relationshipName: relName }
    target = <RelationshipLabelChip name={relName} />
  } else if (record.kind === 'knowledge') {
    const k = record.knowledge || getKnowledge?.(record.knowledgeId) || null
    surface = 'knowledge'
    pickerContext = { parentName: k?.name || null }
    target = <KnowledgeLabelChip name={k?.name || '(knowledge)'} />
  } else if (record.kind === 'attribute') {
    const ent = getEntity?.(record.targetEntityId) || null
    const colour = ent?.colour || '#888888'
    const attr = (ent?.attributes || []).find((a) => a.id === record.attributeId)
    // Attribute: parent entity chip + attribute name; show the value too
    // when awareness level is partial (2) or full (3). At unaware (0) /
    // nominal (1) the observer doesn't know the value, so suppress it.
    // Phase 1.21h Fix #4 — in binary mode, any non-zero stored level
    // (1, 2, or 3) is rendered as fully aware (✓), so values display.
    const effectiveLevel = (attrScale === 'binary' && typeof record.level === 'number' && record.level > 0)
      ? 3
      : record.level
    const showValue = effectiveLevel === 2 || effectiveLevel === 3
    const rawValue = showValue ? attributeRawValue(attr) : ''
    const valueDisplay = rawValue ? truncateForChip(rawValue) : ''
    surface = 'attribute'
    pickerContext = { parentName: ent?.name || null, attributeName: attr?.name || null }
    if (showValue && rawValue && rawValue.length > valueDisplay.length) {
      const aname = attr?.name || 'Attribute'
      valueOverrideTitle = `${aname}: "${rawValue}"`
    }
    target = (
      <span className="inline-flex items-center gap-1 min-w-0">
        <EntityAvatar entity={ent} size={14} />
        <span className="text-[10px] truncate" style={{ color: colour }}>
          {ent?.name || '(entity)'}
        </span>
        <span className="text-[9px] text-zinc-500">·</span>
        <span className="text-[10px] text-zinc-300 truncate">
          {attr?.name || '(attribute)'}
        </span>
        {valueDisplay && (
          <span
            className="text-[10px] text-zinc-400 truncate italic"
            title={valueOverrideTitle || undefined}
          >"{valueDisplay}"</span>
        )}
      </span>
    )
  } else if (record.kind === 'entity_name') {
    const ent = getEntity?.(record.targetEntityId) || null
    const colour = ent?.colour || '#888888'
    const rawName = ent?.name || ''
    const nameDisplay = truncateForChip(rawName)
    surface = 'entity_name'
    pickerContext = { parentName: ent?.name || null, nameValue: rawName || null }
    if (rawName && rawName.length > nameDisplay.length) {
      valueOverrideTitle = `Name: "${rawName}"`
    }
    target = (
      <span className="inline-flex items-center gap-1 min-w-0">
        <EntityAvatar entity={ent} size={14} />
        <span className="text-[10px] truncate" style={{ color: colour }}>
          {ent?.name || '(entity)'}
        </span>
        <span className="text-[9px] text-zinc-500">·</span>
        <span className="text-[10px] text-zinc-300 truncate">Name</span>
        <span
          className="text-[10px] text-zinc-400 truncate italic"
          title={valueOverrideTitle || undefined}
        >"{nameDisplay || '(unnamed)'}"</span>
      </span>
    )
  } else if (record.kind === 'alias') {
    const ent = getEntity?.(record.targetEntityId) || null
    const colour = ent?.colour || '#888888'
    const rawAlias = record.aliasValue || ''
    const aliasDisplay = truncateForChip(rawAlias)
    surface = 'alias'
    pickerContext = { parentName: ent?.name || null, aliasValue: rawAlias || null }
    if (rawAlias && rawAlias.length > aliasDisplay.length) {
      valueOverrideTitle = `Alias: "${rawAlias}"`
    }
    target = (
      <span className="inline-flex items-center gap-1 min-w-0">
        <EntityAvatar entity={ent} size={14} />
        <span className="text-[10px] truncate" style={{ color: colour }}>
          {ent?.name || '(entity)'}
        </span>
        <span className="text-[9px] text-zinc-500">·</span>
        <span className="text-[10px] text-zinc-300 truncate">Alias</span>
        <span
          className="text-[10px] text-zinc-400 truncate italic"
          title={valueOverrideTitle || undefined}
        >"{aliasDisplay || '(empty)'}"</span>
      </span>
    )
  } else {
    // Phase 1.21h — visually-loud fallback so unhandled awareness kinds
    // are immediately visible during development instead of silently
    // dropping. Bare-return short-circuits the rest of the row build
    // (level glyph, review-flag, etc.) since those don't apply when
    // the kind isn't dispatched.
    return <FallbackSubChip kind={record.kind} payload={record} />
  }

  // Resolve the row's main tooltip from the surface + context. Falls
  // back to the bare scale label if the surface didn't supply context
  // (defensive — every kind branch above should populate one).
  // Phase 1.21g — `observerName` is folded into the picker context so
  // tooltips read as "Preston doesn't know Alice's name 'Alice'"
  // rather than the impersonal "Doesn't know Alice's name 'Alice'".
  const ctxWithObserver = pickerContext
    ? (observerName ? { ...pickerContext, observerName } : pickerContext)
    : null
  const rowTitle = (surface && ctxWithObserver)
    ? (awarenessLabelsFor(surface, ctxWithObserver)[record.level] ?? tooltipForLevel(record.level))
    : tooltipForLevel(record.level)

  const interactive = typeof onClick === 'function'
  const handleClick = interactive
    ? (e) => { e.stopPropagation(); onClick(e) }
    : undefined

  // Per-level visual: the row's background tint + left-border colour
  // both come from `awarenessLevelStyle(level)` so the chip reads in
  // the same visual language as the level-badge glyph itself
  // (red ✕ tier 0 → red bg + border, green ✓ tier 3 → green bg +
  // border, etc.). Mirrors the entity-side `<BaseChangeChip>` pattern
  // (left-border accent + tinted bg keyed off the change action).
  const levelStyle = (record.level !== null && record.level !== undefined)
    ? awarenessLevelStyle(record.level)
    : null
  const bgCls = levelStyle ? levelStyle.bg : 'bg-zinc-800/30'
  const borderLeftCls = levelStyle ? `border-l-2 ${levelStyle.border}` : 'border-l-2 border-zinc-700/40'

  // Phase 1.21g — when the awareness change came via a projected source
  // (relationship participants / entity-list attribute entries), the
  // record carries a `via` payload. Render a "via [chip]" suffix after
  // the target identity so the user can see the contributing source.
  let viaSuffix = null
  if (record.via) {
    if (record.via.kind === 'relationship') {
      const rel = getRelationship?.(record.via.relationship_id) || null
      viaSuffix = (
        <span className="inline-flex items-center gap-1 ml-1">
          <span className="text-[9px] text-zinc-500">via</span>
          <RelationshipLabelChip name={relationshipDisplayName(rel, getEntity)} />
        </span>
      )
    } else if (record.via.kind === 'attribute') {
      const carrier = getEntity?.(record.via.entity_id) || null
      const carrierColour = carrier?.colour || '#888888'
      const carrierAttr = (carrier?.attributes || []).find((a) => a.id === record.via.attribute_id)
      viaSuffix = (
        <span className="inline-flex items-center gap-1 ml-1">
          <span className="text-[9px] text-zinc-500">via</span>
          <EntityAvatar entity={carrier} size={12} />
          <span className="text-[10px] truncate max-w-[80px]" style={{ color: carrierColour }}>
            {carrier?.name || '(entity)'}
          </span>
          <span className="text-[9px] text-zinc-500">·</span>
          <span className="text-[10px] text-zinc-300 truncate max-w-[80px]">
            {carrierAttr?.name || '(attribute)'}
          </span>
        </span>
      )
    }
  }

  const prCls = onRemove ? 'pr-5' : 'pr-1.5'
  // Show an inline expand chevron only when a rendered value was
  // actually truncated in the visible row (`valueOverrideTitle` is the
  // signal — set above whenever a truncation actually occurred). The
  // expanded body shows the full untruncated label : "value" pair so
  // the user can read the full value without leaving the chip.
  const showExpand = !!valueOverrideTitle

  const row = (
    <div
      data-help-region="detail-panel:details_changes"
      className={`relative flex items-center gap-1.5 pl-1.5 ${prCls} py-0.5 rounded leading-none ${bgCls} ${borderLeftCls}${
        interactive ? ' cursor-pointer hover:brightness-125 transition' : ''
      }`}
      title={rowTitle}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {showLevel && (
        <span className="flex-shrink-0 inline-flex items-center">
          <AwarenessBadge
            level={record.level}
            size={12}
            scale={record.kind === 'attribute' ? attrScale : undefined}
          />
        </span>
      )}
      {viaSuffix ? (
        // Phase 2.12 — when an awareness change came via a projected
        // source (relationship participants / entity-list attribute
        // entries), render the "via [chip]" on a SECOND line so the
        // target identity on line 1 gets the full chip width and
        // doesn't truncate the moment the via suffix is wider than a
        // few characters. Bumps to a 2-line layout only when via is
        // present; single-line layout preserved for direct changes.
        <span className="flex-1 min-w-0 flex flex-col items-start gap-0.5 py-0.5">
          <span className="max-w-full truncate inline-flex items-center">{target}</span>
          <span className="max-w-full truncate inline-flex items-center">{viaSuffix}</span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 truncate inline-flex items-center">{target}</span>
      )}
      {reviewFlagged && (
        <span
          className={`text-sky-400 flex-shrink-0 ${onRemove ? '' : 'ml-auto'} text-[9px]`}
          title="Upstream change: this awareness was modified earlier in the chain. Open Alerts panel to review."
        >⚑</span>
      )}
      {showExpand && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          className={`nodrag flex-shrink-0 text-zinc-500 hover:text-zinc-300 leading-none ${reviewFlagged ? '' : 'ml-auto'}`}
          style={{ fontSize: 10 }}
          title={expanded ? 'Hide details' : 'Show details'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
      {onRemove && (
        <button
          className={`nodrag absolute right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded text-[9px] leading-none transition-all hover:bg-red-500/25 hover:text-red-400 ${hovered ? 'opacity-100 text-zinc-500' : 'opacity-0 pointer-events-none'}`}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title="Remove this change"
        >−</button>
      )}
    </div>
  )

  if (!showExpand) return row

  return (
    <div className="select-none">
      {row}
      {expanded && (
        <div
          className="mt-0.5 ml-4 pr-2 text-[10px] text-zinc-300 leading-snug whitespace-pre-wrap break-words"
          style={{ borderLeft: '1px dashed #3f3f46', paddingLeft: 6 }}
        >
          {valueOverrideTitle}
        </div>
      )}
    </div>
  )
}
