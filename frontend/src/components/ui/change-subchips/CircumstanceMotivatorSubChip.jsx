import { useState } from 'react'
import { BaseChangeChip } from '../ChangeChipBase'
import { ActionGlyphBadge } from './atoms'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../TypeBadges'
import { IntensityBadge, INTENSITY_LABELS, INTENSITY_COLOURS } from '../IntensityBadge'

/**
 * Phase 1.22 — Circumstance / Motivator subchip.
 *
 * The single subchip used in every surface where a circumstance or
 * motivator is rendered:
 *   - Detail Panel attribute rows in the entity Attributes tab.
 *   - Scene Detail Panel "At the scene level" rows.
 *   - Scene Detail Panel "Per entity" rollup rows.
 *   - Canvas SceneNode scene-level rows.
 *   - Canvas entity chip carried rows.
 *   - Scene Changes tab change-event rows.
 *   - Dev Preview catalogue.
 *
 * Same convention as `ChangeSubChip` / `AwarenessSubChip` /
 * `RelationshipHistoryChangeChip`: one component, consumed from BOTH
 * `frontend/src/components/nodes/*` (canvas) AND
 * `frontend/src/components/entities/*` (sidebar).
 *
 * Two render modes, driven by the optional `action` prop:
 *
 *   - **current-state row** (`action` not set): renders
 *       `[type badge] [name (or trunc desc)] [IntensityBadge if set] [chevron]`
 *     Used wherever the row represents a currently-active item.
 *
 *   - **change-event row** (`action` set to `'add' | 'modify' | 'remove'`):
 *     leading-glyph layout, awareness-style:
 *       - `add`    : `✚ [IntensityBadge] [type badge] [name]`
 *       - `remove` : `⚊ [IntensityBadge] [type badge] [name]`
 *       - `modify` (intensity-only): `[IntensityBadge] [type badge] [name]`
 *         (no `✱`; the badge IS the action signal — same convention as
 *         awareness subchips where the awareness icon leads). The new
 *         intensity is the leading badge.
 *       - `modify` (name / description, no intensity change):
 *         `✱ [type badge] [name]  [oldValue → newValue]`
 *     When the IntensityBadge is the leading signal, the row's
 *     background tint follows the tier colour rather than the action
 *     colour, so the tier is readable at a glance.
 *
 * Props (all optional except `attributeType`):
 *   attributeType: 'circumstance' | 'motivator'  (selects type badge)
 *   name:          compact label (optional for circumstance; renders
 *                  description fallback if absent)
 *   description:   the body text (used as fallback when name is empty,
 *                  also expandable from the chevron)
 *   intensity:     0-4 or null (drives IntensityBadge)
 *   action:        'add' | 'modify' | 'remove' — enables change-event mode
 *   oldValue:      pre-change value for text-modify transitions
 *   newValue:      post-change value for text-modify transitions
 *   oldIntensity:  pre-change intensity for intensity-modify transitions
 *   newIntensity:  post-change intensity for intensity-modify transitions
 *   onClick:       optional row-level click handler
 *   onDismiss:     optional hover-reveal `−` (remove this change) handler
 *   onAddKnowledge: optional hover-reveal `+ Knowledge` handler
 *   reviewFlagged: optional ⚑ flag display
 */
export default function CircumstanceMotivatorSubChip({
  attributeType,
  name,
  description,
  intensity,
  action = null,
  oldValue,
  newValue,
  oldIntensity,
  newIntensity,
  onClick,
  onDismiss,
  onAddKnowledge,
  reviewFlagged,
  // Phase 1.22h — when true, type badge + intensity badge render in
  // chevron-corner pentagon variant (corner segments only) instead of
  // the full perimeter outline. Used for temporary circumstances /
  // motivators that apply at one scene only and don't propagate
  // downstream.
  temporary = false,
  // Optional override colour for the chevron-corner strokes when
  // `temporary=true`. Typically the scene's default canvas accent
  // colour so temporary badges visually anchor to the scene rather
  // than the tier. Falls back to per-badge default when omitted.
  temporaryColour = null,
  // Optional colour for a dashed outline on the chip's top / right /
  // bottom edges (left edge keeps the action-colour swatch). Used
  // by the canvas-side temporary C/M render so the dashed scoping
  // signal applies directly to the chip rather than to a wrapping
  // container.
  dashedOutline = null,
}) {
  const [expanded, setExpanded] = useState(false)
  const isChangeEvent = !!action
  const TypeBadge = attributeType === 'motivator' ? MotivatorTypeBadge : CircumstanceTypeBadge
  const typeLabel = attributeType === 'motivator' ? 'Motivator' : 'Circumstance'

  // Choose what to show as the row's primary label.
  // Motivator rows always have a name (validator-enforced); circumstance
  // rows may not, in which case we fall back to a truncated description.
  const trimmedName = (name || '').trim()
  const trimmedDesc = (description || '').trim()
  const hasName = trimmedName.length > 0
  const labelText = hasName
    ? trimmedName
    : (trimmedDesc.length > 26 ? trimmedDesc.slice(0, 26) + '…' : trimmedDesc)
  const fallbackPlaceholder = !labelText ? '(unnamed)' : null

  // Intensity-only modify transition (no name / description change).
  const isIntensityOnlyModify = action === 'modify'
    && oldValue == null && newValue == null
    && (oldIntensity !== undefined || newIntensity !== undefined)

  // Text-only modify transition (name or description changed; intensity
  // didn't).
  const hasTextTransition = action === 'modify' && !isIntensityOnlyModify
    && (oldValue != null || newValue != null)

  // Leading-glyph rule for change events:
  //   - add    : ✚ followed by IntensityBadge (if set), then chip
  //   - remove : ⚊ followed by IntensityBadge (if set), then chip
  //   - modify (intensity-only): IntensityBadge only (no ✱ glyph;
  //     awareness-style — the badge IS the action signal). Suppresses
  //     the inline old → new pair since the leading badge is the new
  //     value, which is what you want to read at a glance.
  //   - modify (text-only): ✱ glyph as before; no leading IntensityBadge.
  // The leading IntensityBadge level for add/remove uses the row's
  // current `intensity` prop (the value at this chain step). For
  // intensity-only modify, it's the new intensity.
  const leadIntensity = isIntensityOnlyModify
    ? (newIntensity ?? null)
    : ((action === 'add' || action === 'remove') ? intensity : null)
  const showLeadIntensityBadge = isChangeEvent && leadIntensity != null
  // Suppress the action symbol on intensity-only modify (badge replaces
  // the ✱ glyph). For other change events we render our own
  // ActionGlyphBadge inside the children block instead of letting
  // BaseChangeChip render its plain leading symbol — the styled pill
  // matches the standard ChangeSubChip look (icon + tinted background)
  // AND keeps the action colour green / red / amber even when the
  // chip's overall background tint is set to the intensity tier
  // colour (which would otherwise leak into BaseChangeChip's symbol
  // via its `color` override).
  const showOwnActionGlyph = isChangeEvent && !isIntensityOnlyModify
  // Tier-tinted background when the intensity badge is the leading
  // signal — gives the row a tier read at a glance even before parsing
  // the text. Falls back to the standard action-tinted background
  // (handled inside BaseChangeChip) when no leading intensity badge.
  const tierTint = showLeadIntensityBadge ? INTENSITY_COLOURS[leadIntensity] : undefined

  // Description expand/collapse toggle is only meaningful when there's
  // a description AND it's distinct from what's already shown as the
  // label (i.e. either the name surfaces and the description is
  // separate, OR no name is set and label is the truncated description
  // and there's more to show).
  const fullDescAvailable = trimmedDesc.length > 0
    && (hasName || trimmedDesc.length > labelText.length)
  const showChevron = fullDescAvailable && !isChangeEvent

  function handleChevronClick(e) {
    e.stopPropagation()
    setExpanded((v) => !v)
  }

  // Tooltip combines type label + (name) + (intensity label) so a hover
  // reveal hint is informative even at small sizes.
  const tooltipBits = [typeLabel]
  if (labelText) tooltipBits.push(labelText)
  if (intensity != null) tooltipBits.push(INTENSITY_LABELS[intensity])
  const titleAttr = tooltipBits.join(' · ')

  // Text-modify expandedBody — when the inline old → new transition
  // truncated either side at 18 chars, surface the full untruncated
  // text via BaseChangeChip's expand chevron. Mutually exclusive with
  // the current-state description chevron handled below: text-modify
  // is a change event (`action === 'modify'`), current-state chevron
  // requires `!isChangeEvent`.
  const TEXT_TRUNC_LIMIT = 18
  const oldStr = oldValue == null ? null : String(oldValue)
  const newStr = newValue == null ? null : String(newValue)
  const textOldLong = hasTextTransition && oldStr && oldStr.length > TEXT_TRUNC_LIMIT
  const textNewLong = hasTextTransition && newStr && newStr.length > TEXT_TRUNC_LIMIT
  const textTransitionExpand = (textOldLong || textNewLong) ? (
    <div className="space-y-0.5">
      {oldStr != null && (
        <div>
          <span className="text-zinc-500">Was:</span>{' '}
          <span className="text-zinc-400 line-through">"{oldStr}"</span>
        </div>
      )}
      {newStr != null && (
        <div>
          <span className="text-zinc-500">Now:</span>{' '}
          <span className="text-zinc-200">"{newStr}"</span>
        </div>
      )}
    </div>
  ) : null

  return (
    <div className="select-none" title={titleAttr}>
      <BaseChangeChip
        action={action}
        color={tierTint}
        showSymbol={false}
        onDismiss={onDismiss}
        onAddKnowledge={onAddKnowledge}
        reviewFlagged={reviewFlagged}
        onClick={onClick}
        expandedBody={textTransitionExpand}
        dashedOutline={dashedOutline}
        dataHelpRegion="change-subchip:circumstance_motivator"
      >
        <span className="flex items-center gap-1 min-w-0">
          {/* Action glyph badge — uses the standard ActionGlyphBadge so
              the icon stays in the action's standard colour (green for
              add, red for remove, amber for modify) regardless of the
              chip's tier-tinted background. Matches the visual style
              used by the standard ChangeSubChip. */}
          {showOwnActionGlyph && <ActionGlyphBadge action={action} />}
          {/* Leading IntensityBadge (add / remove / intensity-only modify) */}
          {showLeadIntensityBadge && (
            <IntensityBadge level={leadIntensity} size={14} temporary={temporary} temporaryColour={temporaryColour} />
          )}
          <TypeBadge size={15} temporary={temporary} temporaryColour={temporaryColour} />
          {/* Current-state row: intensity badge sits between the type
              badge and the name (after the C/M icon, before the text). */}
          {!isChangeEvent && intensity != null && (
            <IntensityBadge level={intensity} size={15} temporary={temporary} temporaryColour={temporaryColour} />
          )}
          <span className={`truncate ${fallbackPlaceholder ? 'italic text-zinc-500' : 'text-zinc-200'}`}>
            {labelText || fallbackPlaceholder}
          </span>

          {/* Intensity-only modify: trailing oldBadge → newBadge transition
              after the name, in addition to the leading IntensityBadge. */}
          {isIntensityOnlyModify && (
            <span className="flex items-center gap-0.5 flex-shrink-0">
              <IntensityBadge level={oldIntensity ?? null} size={12} />
              <span className="text-zinc-500">→</span>
              <IntensityBadge level={newIntensity ?? null} size={12} />
            </span>
          )}

          {/* Text-modify transition: oldValue → newValue */}
          {hasTextTransition && (
            <span className="flex items-center gap-1 min-w-0">
              {oldValue != null && (
                <span className="line-through text-zinc-500 truncate">
                  "{String(oldValue).length > 18 ? String(oldValue).slice(0, 18) + '…' : oldValue}"
                </span>
              )}
              <span className="text-zinc-500 flex-shrink-0">→</span>
              {newValue != null && (
                <span className="text-zinc-200 truncate">
                  "{String(newValue).length > 18 ? String(newValue).slice(0, 18) + '…' : newValue}"
                </span>
              )}
            </span>
          )}

          {/* Expand-for-description chevron (current-state mode only) */}
          {showChevron && (
            <button
              type="button"
              onClick={handleChevronClick}
              className="nodrag flex-shrink-0 text-zinc-500 hover:text-zinc-300 leading-none"
              style={{ fontSize: 10 }}
              title={expanded ? 'Hide description' : 'Show description'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
        </span>
      </BaseChangeChip>

      {/* Expanded description body — pure presentation, no value writes */}
      {showChevron && expanded && (
        <div
          className="mt-0.5 ml-4 pr-2 text-[9px] text-zinc-400 leading-snug whitespace-pre-wrap"
          style={{ borderLeft: '1px dashed #3f3f46', paddingLeft: 6 }}
        >
          {trimmedDesc}
        </div>
      )}
    </div>
  )
}
