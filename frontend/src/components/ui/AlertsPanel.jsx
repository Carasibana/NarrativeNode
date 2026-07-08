import { memo, useEffect, useMemo } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { confirm } from '../../store/dialogStore'
import { useAlerts, useAlertsCount, nodesStructurallyEqual, edgesStructurallyEqual } from '../../hooks/useAlerts'
import {
  computeEffectiveState,
  computeRelationshipEffectiveState,
  computeKnowledgeEffectiveState,
  getRelationshipNodeOrder,
  getKnowledgeNodeOrder,
} from '../../utils/narrativeChain'
import { readEffectiveAwarenessForTarget } from '../../utils/awarenessCommit'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { usePovColor } from '../../utils/povConstants'
import ImageHoverPreview from './ImageHoverPreview'
import {
  RelationshipIcon,
  RelationshipLabelChip,
  NodeBadge,
  PovStartGlyph,
  KnowledgeLabelChip,
  KNOWLEDGE_COLOUR,
  EntityAvatar,
} from './IdentityBadges'
import {
  buildDeleteRelationshipMessage,
  buildEndRelationshipMessage,
} from './popupMessages'
import { NullBadge } from './ChangeChipBase'
import { AwarenessBadge } from './AwarenessBadges'
import { walkPovChainTime, snapEffectiveFromFloor, chainPreContextForScene } from '../../utils/povChainTimeWalker'
import { computePovChain } from '../../utils/povSequence'
import {
  formatTimeOfDay,
  formatDate,
  formatSeason,
  formatSceneDuration,
  formatGapExtension,
  formatAlertTherefore,
  looserTier,
} from '../../utils/scenetimeVerbiage'

const FIELD_LABELS = { name: 'Name', colour: 'Colour', description: 'Description', profile_image: 'Profile Image', attributes: 'Attributes' }

// Local badge-style lookup used by the uninstantiated-entity alert
// renderer. Matches the green "NEW : <type>" pill that origin entity
// nodes wear elsewhere (cf. `NODE_BADGE_STYLES.originEntity` in
// IdentityBadges.jsx). This map got dropped during the v0.2.1.6
// legacy-retirement squash but two consumer lines survived; restoring
// the constant locally fixes the `BADGE_STYLES is not defined` crash
// without touching the consumer code.
const BADGE_STYLES = {
  origin: { label: 'ORIGIN', labelCls: 'text-green-400', bgCls: 'bg-green-900/30 hover:bg-green-900/50' },
}

/** Inline colour swatch + hex code. */
function ColourChip({ colour }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm border border-zinc-500 flex-shrink-0"
        style={{ backgroundColor: colour }}
      />
      <span>{colour}</span>
    </span>
  )
}

/** Inline profile image thumbnail. */
function ImageThumb({ assetRef, crossed, colour }) {
  const src = assetRef.replace(/^assets[\\/]/, '')
  const fullSrc = `/api/project/assets/${src}`
  const imgSize = 16
  const imgBorder = colour ? `1.5px solid ${colour}` : '1.5px solid #888888'
  if (crossed) {
    return (
      <ImageHoverPreview src={fullSrc} borderColour={colour} size={100}>
        <span className="relative inline-block flex-shrink-0 align-text-bottom" style={{ width: imgSize, height: imgSize }}>
          <img src={fullSrc} alt="" className="rounded-sm object-cover" style={{ width: imgSize, height: imgSize, border: imgBorder }} />
          <svg className="absolute inset-0" viewBox="0 0 16 16" style={{ width: imgSize, height: imgSize }}>
            <line x1="2" y1="2" x2="14" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="14" y1="2" x2="2" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      </ImageHoverPreview>
    )
  }
  return (
    <ImageHoverPreview src={fullSrc} borderColour={colour} size={100}>
      <img
        src={fullSrc}
        alt=""
        className="inline-block w-4 h-4 rounded-sm object-cover align-text-bottom"
        style={{ border: imgBorder }}
      />
    </ImageHoverPreview>
  )
}

function formatValue(field, value, entityType, entityColour) {
  if (field === 'profile_image') {
    if (value === undefined) return null
    if (!value) return (
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[10px] align-text-bottom"
        style={{ backgroundColor: (entityColour || '#888888') + '22', border: `1.5px solid ${entityColour || '#888888'}` }}
      >
        {TYPE_ICONS[entityType] || '?'}
      </span>
    )
    return <ImageThumb assetRef={value} colour={entityColour} />
  }
  // Phase 1.21f — awareness fields render as the level-glyph badge
  // instead of the raw level number. Done BEFORE the null-check so a
  // level of 0 (explicitly unaware — falsy) still renders the red ✕
  // glyph rather than the NullBadge.
  if (field && (field.startsWith('awareness:') || field.startsWith('awareness_set:'))) {
    if (value === undefined) return null
    if (value === null) return <NullBadge />  // entry was stripped — distinct from level=0
    return <AwarenessBadge level={value} size={12} />
  }
  if (value === undefined) return null
  // Explicit null or empty string = no value was set — show NULL badge instead of blank
  if (value === null || value === '') return <NullBadge />
  if (field === 'colour') return <ColourChip colour={value} />
  if (field === 'description') {
    const text = value.length > 30 ? value.slice(0, 30) + '...' : value
    return text
  }
  // Aliases field — `getSourceValues` JSON-stringifies the list for
  // cheap string-equality diffing. Without a renderer it falls through
  // and the alert shows raw JSON. Parse and render the alias names
  // comma-joined; hover the value to see the full JSON when the names
  // alone don't differentiate the two sides.
  if (field === 'aliases') {
    let arr = null
    if (typeof value === 'string') {
      try { arr = JSON.parse(value) } catch { arr = null }
    } else if (Array.isArray(value)) {
      arr = value
    }
    if (!Array.isArray(arr) || arr.length === 0) return <NullBadge />
    const names = arr
      .map((a) => (typeof a === 'string' ? a : (a?.value || '')))
      .filter(Boolean)
    if (names.length === 0) return <NullBadge />
    const display = names.join(', ')
    const truncated = display.length > 40 ? display.slice(0, 39) + '…' : display
    let tooltip
    try { tooltip = JSON.stringify(arr, null, 2) } catch { tooltip = display }
    return <span title={tooltip}>{truncated}</span>
  }
  return value
}

const REL_COLOUR = '#a78bfa'

// Node-identity badges (SourceNodeBadge + AlertNodeBadge) promoted to
// `ui/IdentityBadges.jsx` as a single unified `NodeBadge` component —
// covers every node type the app registers (entity origin/modifier,
// scene, scene-flashback, relationship origin, POV origin, reference,
// group) and renders as a button when an `onClick` handler is supplied.
// The previous local definitions are gone.

/** Small profile image or type icon for an entity at its effective state at a given node. */
function EntityAlertImage({ entityId, nodeId, nodes, edges, entityMap }) {
  const entity = entityMap?.get(entityId)
  if (!entity) return null
  // If nodeId is null (e.g. uninstantiated entity), use base entity state directly
  const effective = nodeId ? computeEffectiveState(entity, nodes, edges, nodeId) : null
  const colour = effective?.colour || entity.colour || '#888888'
  const imgRef = effective?.profile_image_ref ?? entity.profile_image_ref
  const imgSrc = imgRef ? `/api/project/assets/${imgRef.replace(/^assets[\\/]/, '')}` : null
  return (
    <ImageHoverPreview src={imgSrc} borderColour={colour} size={100}>
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="w-5 h-5 rounded-sm object-cover flex-shrink-0"
          style={{ border: `1.5px solid ${colour}` }}
        />
      ) : (
        <span
          className="w-5 h-5 rounded-sm flex items-center justify-center flex-shrink-0 text-[10px]"
          style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
        >
          {TYPE_ICONS[entity.type] || '?'}
        </span>
      )}
    </ImageHoverPreview>
  )
}

// AlertNodeBadge promoted to `ui/IdentityBadges.jsx` — see the comment
// above the SourceNodeBadge removal for the rationale. The shared
// `NodeBadge` component now handles every node type including the ones
// AlertNodeBadge covered (scene + flashback, entity origin, entity
// modifier, rel origin) plus three more (POV origin, reference, group).

/**
 * Amber badge showing a transition: oldVal → newVal, with oldVal struck through.
 * Styled like modifier sub-chips on canvas nodes (amber-tinted background, left border).
 */
function TransitionBadge({ from, to, field, entityType, entityColour, forceTransition = false }) {
  const isImage = field === 'profile_image'
  // If both values are absent (not just null — truly undefined/missing), show nothing
  const isEmpty = (v) => v === undefined
  if (isEmpty(from) && isEmpty(to)) return null
  // If both values are effectively "no value", show nothing (avoid NULL → NULL)
  const isNoValue = (v) => v === null || v === undefined || v === ''
  if (isNoValue(from) && isNoValue(to)) return null
  const fmtFrom = formatValue(field, from, entityType, entityColour)
  const fmtTo   = formatValue(field, to, entityType, entityColour)
  if (!fmtFrom && !fmtTo) return null

  // When from === to, there was no transition — show a single-value
  // green "established state" badge, EXCEPT when `forceTransition` is
  // set. The Therefore Changes row in review-flag alerts uses
  // forceTransition because the chain entry persists at the downstream
  // node even when its value coincidentally matches the new inherited
  // upstream value; the user needs to see the explicit "from → to"
  // rendering to recognise the override is still in place (now
  // redundant against the new inherited).
  if (!forceTransition && from === to) {
    const display = fmtTo ?? fmtFrom
    if (!display) return null
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px]"
        style={{ backgroundColor: '#4ade8018', borderLeft: '2px solid #4ade8066' }}
      >
        <span className="text-zinc-200">{display}</span>
      </span>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px]"
      style={{ backgroundColor: '#fbbf2418', borderLeft: '2px solid #fbbf2466' }}
    >
      {fmtFrom != null && (
        isImage && from && from !== '(cleared)'
          ? <ImageThumb assetRef={from} crossed />
          : <span className="text-zinc-500 line-through">{fmtFrom}</span>
      )}
      {fmtFrom != null && fmtTo != null && <span className="text-zinc-500">&rarr;</span>}
      {fmtTo != null && <span className="text-zinc-200">{fmtTo}</span>}
    </span>
  )
}

/**
 * A small chip representing a single list item — entity chip for entity_list items
 * (UUID → look up entity), tag chip for text_list items.
 */
function ListItemChip({ item, entityMap, nodes, edges, atNodeId }) {
  const entity = entityMap?.get(item)
  if (entity) {
    const effective = atNodeId ? computeEffectiveState(entity, nodes, edges, atNodeId) : null
    const colour = effective?.colour || entity.colour || '#888888'
    const imgRef = effective?.profile_image_ref ?? entity.profile_image_ref
    const name = effective?.name || entity.name || 'Unknown'
    const imgSrc = imgRef ? `/api/project/assets/${imgRef.replace(/^assets[\\/]/, '')}` : null
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-medium"
        style={{ backgroundColor: colour + '22', border: `1px solid ${colour}` }}
      >
        {imgSrc
          ? <ImageHoverPreview src={imgSrc} borderColour={colour} size={80}>
              <img src={imgSrc} alt="" className="w-3 h-3 rounded-sm object-cover flex-shrink-0" style={{ border: `1px solid ${colour}` }} />
            </ImageHoverPreview>
          : <span className="text-[8px] flex-shrink-0">{TYPE_ICONS[entity.type] || '?'}</span>
        }
        <span style={{ color: colour }}>{name}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] bg-zinc-700 text-zinc-200">
      {item}
    </span>
  )
}

/**
 * Renders a single review alert with its own header.
 * Header format: [image] D's Name in SCENE S3
 *           or:  [image] D's Attribute: Species in SCENE S3
 */
function ReviewAlertContent({ detail, nodes, edges, entityMap, entityId, entityName, alertNodeId, onNavigate }) {
  if (!detail) return 'An upstream change affects this modification.'

  const d = detail

  // Phase 1.23 — scene-level Time Since Last Scene gap-shift alert
  // (planning §10.1.1 + §10.1.2). No entity context; the alert is
  // attached to the scene itself.
  if (d.field === 'time_since_last_scene') {
    const sceneBadge = <NodeBadge nodeId={alertNodeId} nodes={nodes} entityMap={entityMap} onClick={onNavigate} />
    // Per-concept labels used in the "Changed:" group display.
    // Concepts (not raw fields) — the verbiage module collapses
    // multiple underlying fields into a single concept group.
    const CONCEPT_LABELS = {
      timeOfDay:  'Time of Day',
      date:       'Date',
      season:     'Season',
      duration:   'Scene Duration',
      gapExt:     'Time Since Last Scene',
    }

    // ── Bug 1: re-derive missing alert payload fields from current
    //          store state. Old alerts (written by an earlier code
    //          version) lack `triggerNodeId` / `fieldChanges` /
    //          floor minutes; pull live values where available so
    //          the layout still renders correctly.
    const alertNode = nodes.find((n) => n.id === alertNodeId)
    let derivedPriorScene = null
    let derivedNewFloorMinutes = null
    if (!Number.isFinite(d.previousFloorMinutes)
        || !Number.isFinite(d.newFloorMinutes)
        || !d.triggerNodeId) {
      const povChain = computePovChain(nodes, edges)
      const orderedSceneIds = povChain.sequence.map((s) => s.nodeId)
      const idx = orderedSceneIds.indexOf(alertNodeId)
      if (idx > 0) {
        const priorId = orderedSceneIds[idx - 1]
        derivedPriorScene = nodes.find((n) => n.id === priorId) || null
      }
      const sceneDataById = new Map(
        nodes.filter((n) => n.type === 'sceneNode').map((n) => [n.id, n.data || {}])
      )
      const walker = walkPovChainTime({ orderedSceneIds, scenesById: sceneDataById, allowNegative: false })
      const w = walker.get(alertNodeId)
      if (w && Number.isFinite(w.floorMinutes)) derivedNewFloorMinutes = w.floorMinutes
    }
    const previousFloorMinutes = Number.isFinite(d.previousFloorMinutes)
      ? d.previousFloorMinutes
      : (Number.isFinite(alertNode?.data?.last_known_floor_minutes) ? alertNode.data.last_known_floor_minutes : null)
    const newFloorMinutes = Number.isFinite(d.newFloorMinutes)
      ? d.newFloorMinutes
      : derivedNewFloorMinutes
    const triggerNodeId = d.triggerNodeId || derivedPriorScene?.id || null
    const priorTodTier = d.priorTodTier ?? derivedPriorScene?.data?.time_of_day_tier ?? null
    const thisTodTier = d.thisTodTier ?? alertNode?.data?.time_of_day_tier ?? null

    const headline = d.kind === 'extension_on_shifted_floor'
      ? 'Your Time Since Last Scene extension is now applied to a different earliest start.'
      : 'The earliest this scene can be has moved by more than the gap-shift threshold because of an upstream change.'
    const triggerBadge = triggerNodeId
      ? <NodeBadge nodeId={triggerNodeId} nodes={nodes} entityMap={entityMap} onClick={onNavigate} />
      : null
    // Looser tier of (prior, current) determines slot/value display
    // granularity — never claim a precision the writer didn't pin in
    // BOTH states. Exact-clock format respects the per-story
    // `time_format` setting (12h adds AM/PM).
    const tier = looserTier(priorTodTier, thisTodTier)
    const timeFormat = useProjectStore.getState().story?.time_format === '24h' ? '24h' : '12h'
    const slotOpts = { tier, timeFormat }

    // Compute the scene's EFFECTIVE start (floor + extension, then
    // snap-forward to the scene's own pinned Time of Day / weekday /
    // date) for both before and after — this is what the writer
    // perceives as "earliest this scene can be" because the scene's
    // own pin is applied. Showing raw floor would mislead when the
    // scene's pin pushes effective past the floor.
    //
    // Walker pre-context: `chainPreContextForScene` walks the POV
    // chain up to (but not including) the alert scene to gather the
    // chain anchors plus the running Feb 29 anchor. Then
    // `snapEffectiveFromFloor` runs the walker's own snap math from
    // the stored floor, so display matches the chip even for leap-
    // year (Feb 29) snap cases.
    const orderedSceneIdsForSnap = computePovChain(nodes, edges).sequence.map((s) => s.nodeId)
    const scenesByIdForSnap = new Map()
    for (const n of nodes) {
      if (n.type === 'sceneNode') scenesByIdForSnap.set(n.id, n.data)
    }
    const preCtx = chainPreContextForScene({
      orderedSceneIds: orderedSceneIdsForSnap,
      scenesById: scenesByIdForSnap,
      targetSceneId: alertNode?.id ?? null,
    })
    const snapFromFloor = (floorMinutes) => snapEffectiveFromFloor({
      floorMinutes,
      scene: alertNode?.data || {},
      allowNegative: false,
      ...preCtx,
    })
    // Prefer the stored effective baselines from the alert payload —
    // those captured the post-snap-forward effective at detection
    // time, including any leap-year / weekday / date snap that the
    // current chain context might have shifted away from. Fall back
    // to snap-from-floor only when the payload predates the
    // effective-tracking change (legacy entries before v0.1.23.23).
    const previousEffectiveMinutes = Number.isFinite(d.previousEffectiveMinutes)
      ? d.previousEffectiveMinutes
      : (Number.isFinite(previousFloorMinutes) ? snapFromFloor(previousFloorMinutes) : null)
    const newEffectiveMinutes = Number.isFinite(d.newEffectiveMinutes)
      ? d.newEffectiveMinutes
      : (Number.isFinite(newFloorMinutes) ? snapFromFloor(newFloorMinutes) : null)
    const hasEffective = Number.isFinite(previousEffectiveMinutes) && Number.isFinite(newEffectiveMinutes)

    // Build the "Changed:" display groups via the verbiage module.
    // Each underlying field that changed is rolled up into its
    // semantic concept (Time of Day / Date / Season / Scene Duration
    // / Time Since Last Scene extension) and rendered through the
    // module's per-concept formatters, which handle tier collapse,
    // value naming, and missing-field fallbacks consistently.
    const rawFieldChanges = (Array.isArray(d.fieldChanges) ? d.fieldChanges : [])
      .filter((c) => c.field !== 'time_of_day_tier' && c.field !== 'date_tier')
    const triggerSceneData = (d.triggerNodeId && nodes.find((n) => n.id === d.triggerNodeId)?.data) || {}
    const valuesFor = (field) => {
      const change = rawFieldChanges.find((c) => c.field === field)
      if (change) return { old: change.oldValue, new: change.newValue }
      const cur = triggerSceneData[field] ?? null
      return { old: cur, new: cur }
    }
    const TOD_FIELDS = ['time_of_day_tier', 'time_of_day_broad', 'time_of_day_labelled', 'time_of_day_exact']
    const DATE_FIELDS = ['weekday', 'date_month', 'date_day_of_month']
    const fmtOpts = { tier, timeFormat }
    const displayGroups = []
    const todChanged = rawFieldChanges.some((c) => TOD_FIELDS.includes(c.field))
    if (todChanged) {
      const oldScene = {
        time_of_day_tier: valuesFor('time_of_day_tier').old,
        time_of_day_broad: valuesFor('time_of_day_broad').old,
        time_of_day_labelled: valuesFor('time_of_day_labelled').old,
        time_of_day_exact: valuesFor('time_of_day_exact').old,
      }
      const newScene = {
        time_of_day_tier: valuesFor('time_of_day_tier').new,
        time_of_day_broad: valuesFor('time_of_day_broad').new,
        time_of_day_labelled: valuesFor('time_of_day_labelled').new,
        time_of_day_exact: valuesFor('time_of_day_exact').new,
      }
      const oldDisplay = formatTimeOfDay(oldScene, 'change-line', fmtOpts) ?? '(unset)'
      const newDisplay = formatTimeOfDay(newScene, 'change-line', fmtOpts) ?? '(unset)'
      if (oldDisplay !== newDisplay) displayGroups.push({ label: CONCEPT_LABELS.timeOfDay, oldDisplay, newDisplay })
    }
    const dateChanged = rawFieldChanges.some((c) => DATE_FIELDS.includes(c.field))
    if (dateChanged) {
      const oldScene = {
        weekday: valuesFor('weekday').old,
        date_month: valuesFor('date_month').old,
        date_day_of_month: valuesFor('date_day_of_month').old,
      }
      const newScene = {
        weekday: valuesFor('weekday').new,
        date_month: valuesFor('date_month').new,
        date_day_of_month: valuesFor('date_day_of_month').new,
      }
      const oldDisplay = formatDate(oldScene, 'change-line', fmtOpts) ?? '(unset)'
      const newDisplay = formatDate(newScene, 'change-line', fmtOpts) ?? '(unset)'
      if (oldDisplay !== newDisplay) displayGroups.push({ label: CONCEPT_LABELS.date, oldDisplay, newDisplay })
    }
    for (const c of rawFieldChanges) {
      if (TOD_FIELDS.includes(c.field) || DATE_FIELDS.includes(c.field)) continue
      let oldDisplay = null
      let newDisplay = null
      let label = null
      if (c.field === 'season') {
        label = CONCEPT_LABELS.season
        oldDisplay = formatSeason({ season: c.oldValue }, 'change-line', fmtOpts)
        newDisplay = formatSeason({ season: c.newValue }, 'change-line', fmtOpts)
      } else if (c.field === 'scene_duration') {
        label = CONCEPT_LABELS.duration
        oldDisplay = formatSceneDuration(c.oldValue, 'change-line', fmtOpts)
        newDisplay = formatSceneDuration(c.newValue, 'change-line', fmtOpts)
      } else if (c.field === 'gap_extension') {
        label = CONCEPT_LABELS.gapExt
        oldDisplay = formatGapExtension(c.oldValue, 'change-line', fmtOpts)
        newDisplay = formatGapExtension(c.newValue, 'change-line', fmtOpts)
      } else {
        // Unknown field; render value as-is.
        label = c.field
        oldDisplay = c.oldValue == null ? null : String(c.oldValue)
        newDisplay = c.newValue == null ? null : String(c.newValue)
      }
      const oldStr = oldDisplay ?? '(unset)'
      const newStr = newDisplay ?? '(unset)'
      if (oldStr === newStr) continue
      displayGroups.push({ label, oldDisplay: oldStr, newDisplay: newStr })
    }
    const fieldChanges = displayGroups
    return (
      <>
        <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0 flex-wrap">
          {sceneBadge}
          <span className="text-zinc-300">Earliest start moved</span>
        </div>
        <div className="text-[10px] text-zinc-400 mt-0.5">{headline}</div>
        <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
          {triggerBadge && fieldChanges.length > 0 && (
            <div>
              <div className="flex items-center gap-1">{triggerBadge} <span>Changed:</span></div>
              <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                {fieldChanges.map((g, i) => (
                  <span key={i} className="inline-flex items-center gap-1">
                    <span className="text-zinc-400">{g.label}:</span>
                    <span className="text-zinc-500 line-through">{g.oldDisplay}</span>
                    <span>→</span>
                    <span className="text-zinc-300">{g.newDisplay}</span>
                    {i < fieldChanges.length - 1 && <span className="text-zinc-600">·</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasEffective && (() => {
            // The full "Therefore:" composition lives in the verbiage
            // module — including the dual "because the prior is now
            // X, and this scene is Y" framing that explains snap-
            // forward magnitude. Caller wraps the returned strings
            // in JSX/styling.
            const therefore = formatAlertTherefore(
              triggerSceneData,
              alertNode?.data || {},
              previousEffectiveMinutes,
              newEffectiveMinutes,
              rawFieldChanges,
              slotOpts,
            )
            return (
              <div>
                <div className="flex items-center gap-1">{sceneBadge} <span>Therefore:</span></div>
                {therefore.becauseLines.map((line, i) => (
                  <div key={i} className="pl-3 mt-0.5">{line}</div>
                ))}
                <div className="pl-3 mt-0.5">{therefore.transitionPhrase}</div>
                <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                  <span className="text-zinc-500 line-through">{therefore.oldDisplay}</span>
                  <span>→</span>
                  <span className="text-zinc-300">{therefore.newDisplay}</span>
                </div>
              </div>
            )
          })()}
        </div>
      </>
    )
  }

  const entity = entityMap?.get(entityId)
  const entityType = entity?.type
  const entityEffective = entity ? computeEffectiveState(entity, nodes, edges, alertNodeId) : null
  const entityColour = entityEffective?.colour || entity?.colour || '#888888'
  const label = d.fieldLabel || FIELD_LABELS[d.field] || d.field
  // Attributes and relationship descriptions are plain text like name
  const isAttr = d.field.startsWith('attr:')
  const isRelDesc = d.field.startsWith('rel_a:') || d.field.startsWith('rel_b:')
  const isListOp = d.field.startsWith('list_add:') || d.field.startsWith('list_remove:')
  const isAwareness = d.field.startsWith('awareness:') || d.field.startsWith('awareness_set:')
  // For prefix-coded fields whose value is a plain string (attr / rel /
  // list), pass 'name' to formatValue so it doesn't try to interpret
  // the value via the prefix. Awareness keeps its full key so
  // formatValue can route to the AwarenessBadge branch.
  const displayField = isAwareness ? d.field : ((isAttr || isRelDesc || isListOp) ? 'name' : d.field)
  const source = <NodeBadge nodeId={d.sourceNodeId} nodes={nodes} entityMap={entityMap} onClick={onNavigate} />
  const alertBadge = <NodeBadge nodeId={alertNodeId} nodes={nodes} entityMap={entityMap} />
  const prev  = d.previousInherited
  const curr  = d.currentInherited
  const down  = d.downstreamValue

  // Build field label for header: "Name", "Attribute: Species", or "Relationship with Bob"
  const fieldDisplay = (isAttr || isListOp)
    ? <>Attribute: {label}</>
    : label

  // Phase 1.21f — awareness alerts read more naturally framed around the
  // OBSERVER (the entity who's becoming aware) rather than the target
  // entity whose chip the override is on. Layout:
  //   [observer avatar] [Observer]'s awareness of [target ref] in [scene]
  // where [target ref] depends on the awareness sub-kind.
  // Non-awareness alerts continue to use the original `[target avatar]
  // [Target]'s [field] in [scene]` layout below — this branch returns
  // its own header without affecting that path.
  let awarenessFieldHeader = null
  if (isAwareness) {
    const parts = d.field.split(':')
    let observerId = null
    let targetRefNode = null  // JSX/string for what comes after "awareness of"
    let targetIsRelationship = false
    // Phase 1.21g — source-mutation flag fields. Two flavours:
    //   awareness:<entity|entity_name>:source:<rel:id | attr:eid:aid>
    //   awareness:relationship:<relId>:source:<rel:id | attr:eid:aid>
    // The "observer" slot is replaced by the contributor (relationship
    // or entity-list attribute) — that's the identity whose level
    // shifted upstream. Detect by the `:source:` segment.
    let sourceContributor = null  // { kind: 'relationship', relationship_id } | { kind: 'attribute', entity_id, attribute_id }
    const sourceIdx = parts.indexOf('source')
    const isSourceField = isAwareness && sourceIdx > 0 && parts.length > sourceIdx + 1
    if (isSourceField) {
      const srcKind = parts[sourceIdx + 1]  // 'rel' | 'attr'
      if (srcKind === 'rel' && parts[sourceIdx + 2]) {
        sourceContributor = { kind: 'relationship', relationship_id: parts[sourceIdx + 2] }
      } else if (srcKind === 'attr' && parts[sourceIdx + 2] && parts[sourceIdx + 3]) {
        sourceContributor = { kind: 'attribute', entity_id: parts[sourceIdx + 2], attribute_id: parts[sourceIdx + 3] }
      }
    }
    if (d.field.startsWith('awareness_set:')) {
      // Direct-entry form:  awareness_set:<attrId>:<observerId>
      // Source-mutation form (Phase 1.21g):
      //                     awareness_set:<attrId>:source:<rel:relId | attr:eid:aid>
      const attrId = parts[1]
      const tgtEnt = entityMap?.get(entityId)
      const attr = (tgtEnt?.attributes || []).find((a) => a.id === attrId)
      const attrName = attr?.name || 'attribute'
      targetRefNode = <><span className="font-medium">{entityName}'s</span> <span>{attrName}</span></>
      if (!isSourceField) observerId = parts.slice(2).join(':')
    } else if (d.field.startsWith('awareness:')) {
      const sub = parts[1]
      if (sub === 'relationship') {
        // awareness:relationship:<relId>:<observerId>     — entries
        // awareness:relationship:<relId>:source:<srcKey>  — sources
        const relId = parts[2]
        const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === relId)
        targetRefNode = <RelationshipLabelChip name={rel?.name?.trim() || 'relationship'} />
        targetIsRelationship = true
        if (!isSourceField) observerId = parts[3]
      } else if (sub === 'entity_name') {
        // awareness:entity_name:<observerId>     — entries
        // awareness:entity_name:source:<srcKey>  — sources
        if (!isSourceField) observerId = parts[2]
        targetRefNode = <><span className="font-medium">{entityName}'s</span> <span>Name</span></>
      } else if (sub === 'knowledge') {
        // Phase 1.21h — awareness:knowledge:<knowledgeId>:<observerId>
        // Target = Knowledge (its name + 📜 avatar). Observer = entity
        // identified by the trailing observerId. The alert's `entityId`
        // is the Knowledge id (so entityName / entityMap lookup yields
        // the Knowledge), so the target slot already renders correctly
        // through the default `entityName` path below.
        if (!isSourceField) observerId = parts[3]
        targetRefNode = <span className="font-medium">{entityName}</span>
      } else if (sub === 'alias') {
        // awareness:alias:<aliasValueEncoded>:<observerId>
        // The alias value is URI-encoded so it can carry punctuation
        // safely through the field-key string.
        const aliasValue = parts[2] ? decodeURIComponent(parts[2]) : ''
        if (!isSourceField) observerId = parts[3]
        targetRefNode = <><span className="font-medium">{entityName}'s</span> <span>alias "{aliasValue}"</span></>
      } else {
        // sub === 'entity'
        if (!isSourceField) observerId = parts[2]
        targetRefNode = <span className="font-medium">{entityName}</span>
      }
    }
    let leftBadge = null
    let leftLabel = null
    if (sourceContributor) {
      if (sourceContributor.kind === 'relationship') {
        const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === sourceContributor.relationship_id)
        leftLabel = <RelationshipLabelChip name={rel?.name?.trim() || 'relationship'} />
      } else if (sourceContributor.kind === 'attribute') {
        const carrier = entityMap?.get(sourceContributor.entity_id)
        const attr = (carrier?.attributes || []).find((a) => a.id === sourceContributor.attribute_id)
        leftBadge = <EntityAlertImage entityId={sourceContributor.entity_id} nodeId={alertNodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
        leftLabel = (
          <>
            <span className="font-medium">{carrier?.name || 'Entity'}'s</span>
            <span>{attr?.name || 'attribute'}</span>
          </>
        )
      }
    } else {
      const observerEntity = observerId ? entityMap?.get(observerId) : null
      const observerName = observerEntity?.name || 'Observer'
      leftBadge = observerId
        ? <EntityAlertImage entityId={observerId} nodeId={alertNodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
        : null
      leftLabel = <span className="font-medium flex-shrink-0">{observerName}'s</span>
    }
    awarenessFieldHeader = (
      <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
        {leftBadge && <span className="flex-shrink-0 inline-flex">{leftBadge}</span>}
        <span className="flex-shrink-0 inline-flex items-center gap-1">{leftLabel}</span>
        <span className="text-zinc-400 flex-shrink-0">awareness of</span>
        {!targetIsRelationship && (
          <span className="flex-shrink-0 inline-flex">
            <EntityAlertImage entityId={entityId} nodeId={alertNodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
          </span>
        )}
        <span className="text-zinc-300 flex-shrink-0 inline-flex items-center gap-1">{targetRefNode}</span>
        <span className="text-zinc-500 flex-shrink-0">in</span>
        <span className="flex-shrink-0">{alertBadge}</span>
      </div>
    )
  }

  const fieldHeader = awarenessFieldHeader || (
    <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
      <span className="flex-shrink-0 inline-flex">
        <EntityAlertImage entityId={entityId} nodeId={alertNodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
      </span>
      <span className="font-medium flex-shrink-0">{entityName}'s</span>
      <span className="text-zinc-400 flex-shrink-0">{fieldDisplay}</span>
      <span className="text-zinc-500 flex-shrink-0">in</span>
      <span className="flex-shrink-0">{alertBadge}</span>
    </div>
  )

  const helpText = <div className="text-zinc-600 italic">Is that still correct? (Update if needed or approve to clear this alert)</div>

  // Check key existence (not value) — values like null are valid for fields like profile_image
  const hasInput = 'sourceInputValue' in d
  const hasPrev  = 'previousInherited' in d
  const hasCurr  = 'currentInherited' in d
  const hasDown  = 'downstreamValue' in d

  // Auto-resolved variant — checked first because the autoResolved flag
  // omits currentInherited/downstreamValue (it carries `aliasNames` and
  // `previousDownstreamValue` instead). Layout: a one-line summary of
  // which alias names the upstream now owns plus an explanation that
  // this scene's redundant add was removed. Resolution: Accept (dismiss,
  // override stays cleared) or Revert (restore the override and convert
  // to a normal redundant alert).
  if (d.autoResolved) {
    const names = Array.isArray(d.aliasNames) ? d.aliasNames : []
    const aliasChips = names.map((n, i) => (
      <span key={i} className="px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-200 text-[10px]">{n}</span>
    ))
    return (
      <>
        {fieldHeader}
        <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
          <div className="flex items-center gap-1 flex-wrap">
            {source} <span>added</span> {aliasChips}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {alertBadge}<span>'s add of</span> {aliasChips} <span>is redundant and was removed.</span>
          </div>
          <div className="text-zinc-600 italic">Accept to keep it removed, or Revert to restore your modification.</div>
        </div>
      </>
    )
  }

  // Fallback for legacy flags or missing data
  if (!hasCurr && !hasDown) {
    return (
      <>
        {fieldHeader}
        <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1">
          <span>changed in</span> {source}
        </div>
        {helpText}
      </>
    )
  }

  // ── List op alerts ──
  // list_add:/list_remove: field keys encode the action and item; display as entity/text chips
  if (isListOp) {
    const colonIdx1 = d.field.indexOf(':')
    const colonIdx2 = d.field.indexOf(':', colonIdx1 + 1)
    const listAction = d.field.slice(0, colonIdx1)  // 'list_add' or 'list_remove'
    const listItem = d.field.slice(colonIdx2 + 1)
    const upstreamVerb = listAction === 'list_add' ? 'added' : 'removed'
    const downstreamVerb = d.downstreamValue === 'list_add' ? 'add' : d.downstreamValue === 'list_remove' ? 'remove' : null
    const isCancelled = d.cancelled === true
    const isDangling  = d.dangling === true
    const itemChip = <ListItemChip item={listItem} entityMap={entityMap} nodes={nodes} edges={edges} atNodeId={alertNodeId} />

    return (
      <>
        {fieldHeader}
        <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
          {isCancelled ? (
            <div className="flex items-center gap-1 flex-wrap">
              {source} <span>{upstreamVerb}</span> {itemChip}
              <span className="text-amber-400">— your {upstreamVerb} was automatically cancelled since it is now {upstreamVerb} upstream</span>
            </div>
          ) : isDangling ? (
            <div className="flex items-center gap-1 flex-wrap">
              {itemChip}
              <span className="text-amber-400">is no longer added upstream — this removal is now a no-op.</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 flex-wrap">
                {source} <span>also</span>
                <span className={listAction === 'list_add' ? 'text-green-400' : 'text-red-400'}>{upstreamVerb}</span>
                {itemChip}
              </div>
              {downstreamVerb && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span>This node also</span>
                  <span className={listAction === 'list_add' ? 'text-green-400' : 'text-red-400'}>{downstreamVerb}s</span>
                  <span>this same item — review to confirm the correct state.</span>
                </div>
              )}
            </>
          )}
          {isDangling
            ? <div className="text-zinc-600 italic">Confirm to dismiss (the removal stays, harmlessly), or Undo to remove the op from this node.</div>
            : helpText
          }
        </div>
      </>
    )
  }

  // Phase 1.21h — redundancy variant. Same trigger as the standard
  // review-flag alert, but the new inherited upstream value happens to
  // equal the downstream override, so the override is technically
  // still on the chain but no longer producing any delta. Body uses
  // the same Changed / Therefore Changes layout as the standard alert
  // (full data parity — what changed upstream, what the chain resolves
  // to here) plus a "now redundant" tagline; resolution is "Remove
  // override" (strip the chain entry) or "Keep as-is" (dismiss).
  if (d.redundant) {
    const hasFullTransition = hasInput && hasPrev && hasCurr && hasDown
    return (
      <>
        {fieldHeader}
        <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
          {hasFullTransition ? (
            <>
              <div>
                <div className="flex items-center gap-1">{source} <span>Changed:</span></div>
                <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                  <TransitionBadge from={prev} to={curr} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1">{alertBadge} <span>Therefore Changes:</span></div>
                <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                  <TransitionBadge from={prev} to={down} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
                  <span>to</span>
                  <TransitionBadge from={curr} to={down} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
                </div>
              </div>
            </>
          ) : (
            <>
              {hasPrev && hasCurr && (
                <div>
                  <div className="flex items-center gap-1">{source} <span>Changed:</span></div>
                  <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                    <TransitionBadge from={prev} to={prev} field={displayField} entityType={entityType} entityColour={entityColour} />
                    <span>to</span>
                    <TransitionBadge from={prev} to={curr} field={displayField} entityType={entityType} entityColour={entityColour} />
                  </div>
                </div>
              )}
              {hasDown && (
                <div>
                  <div className="flex items-center gap-1">{alertBadge} <span>Therefore Changes:</span></div>
                  <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
                    {hasCurr && (
                      <>
                        <TransitionBadge from={curr} to={down} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
                      </>
                    )}
                    {!hasCurr && (
                      <>
                        <span>sets it to</span>
                        <TransitionBadge to={down} field={displayField} entityType={entityType} entityColour={entityColour} />
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="text-amber-400 italic">The new inherited value matches your modification, so the modification is now redundant.</div>
          <div className="text-zinc-600 italic">Remove the modification (no longer needed) or keep it as-is.</div>
        </div>
      </>
    )
  }

  // Full transition wording with stacked layout
  if (hasInput && hasPrev && hasCurr && hasDown) {
    return (
      <>
        {fieldHeader}
        <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
          <div>
            <div className="flex items-center gap-1">{source} <span>Changed:</span></div>
            <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
              <TransitionBadge from={prev} to={curr} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1">{alertBadge} <span>Therefore Changes:</span></div>
            <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
              <TransitionBadge from={prev} to={down} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
              <span>to</span>
              <TransitionBadge from={curr} to={down} field={displayField} entityType={entityType} entityColour={entityColour} forceTransition />
            </div>
          </div>
          {helpText}
        </div>
      </>
    )
  }

  // Partial data: stacked layout with what we have
  return (
    <>
      {fieldHeader}
      <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
        {hasPrev && hasCurr ? (
          <div>
            <div className="flex items-center gap-1">{source} <span>Changed:</span></div>
            <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
              <TransitionBadge from={prev} to={prev} field={displayField} entityType={entityType} entityColour={entityColour} />
              <span>to</span>
              <TransitionBadge from={prev} to={curr} field={displayField} entityType={entityType} entityColour={entityColour} />
            </div>
          </div>
        ) : hasCurr ? (
          <div className="flex items-center gap-1">
            <span>was set to</span>
            <TransitionBadge to={curr} field={displayField} entityType={entityType} entityColour={entityColour} />
            <span>in</span> {source}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span>was changed in</span> {source}
          </div>
        )}
        {hasDown && (
          <div>
            <div className="flex items-center gap-1">{alertBadge} <span>Therefore Changes:</span></div>
            <div className="pl-3 mt-0.5 flex items-center gap-1 flex-wrap">
              <span>sets it to</span>
              <TransitionBadge to={down} field={displayField} entityType={entityType} entityColour={entityColour} />
            </div>
          </div>
        )}
        {helpText}
      </div>
    </>
  )
}

/**
 * Top-bar alerts badge + flyout panel.
 *
 * Badge shows ⚠ with a count indicator. Clicking toggles the flyout open/closed.
 * The flyout stays open until the badge is clicked again (no outside-click dismiss).
 *
 * Alert types:
 *   - uninstantiated: entity exists in library but has no origin node on the canvas (auto-clears when origin node is added)
 *   - orphaned: entity chip with no incoming narrative-flow wire (auto-clears when wired)
 *   - review: downstream review flag — clearable only from this panel
 *
 * Phase 3.7 perf fix (large-project load perf #12): outer wrapper subscribes
 * only to the badge count (via `useAlertsCount` which uses
 * `requestIdleCallback` so the heavy walk never blocks the main thread)
 * + `alertsPanelOpen` + `toggleAlertsPanel`. Renders the badge button
 * always; mounts the inner `<AlertsPanelBody>` ONLY when
 * `alertsPanelOpen === true`. While closed (the 99% case during project
 * load and most normal authoring), the body — with its ~20 store
 * subscriptions, full `useAlerts()` call, chain-walker memos, and
 * action-handler selectors — doesn't exist in the React tree. Zero
 * synchronous chain-walking work fires from this component while the
 * flyout is hidden.
 *
 * Chain-aware semantics for the badge: the count comes from
 * `useAlertsCount` which calls the same `computeAlerts` function the
 * synchronous hook calls. Every chain walk inside (`computeEffectiveState`,
 * `computeRelationshipEffectiveState`, etc.) resolves at its proper
 * anchor. The hook only shifts WHEN the chain-aware computation runs
 * (idle time vs render time), not WHAT it does. Badge count is briefly
 * stale (typically ~50-200 ms) after a mutation that triggers/resolves
 * an alert; for interactive mutations this is imperceptible.
 */
function AlertsPanel() {
  const count = useAlertsCount()
  const alertsPanelOpen = useUiStore((s) => s.alertsPanelOpen)
  const toggleAlertsPanel = useUiStore((s) => s.toggleAlertsPanel)

  return (
    <div className="relative">
      {/* Badge button — always mounted */}
      <button
        onClick={() => {
          // Close the MCP control popover first if it was open — the
          // two header flyouts are mutually exclusive so they can't
          // overlap. The MCP button's onClick does the mirror close
          // for the other direction. Always close (rather than
          // toggle) regardless of whether we're opening or closing
          // alerts here, so the MCP popover never lingers open in
          // the background.
          useMcpControlStore.setState({ popoverOpen: false })
          toggleAlertsPanel()
        }}
        className={`relative px-2 py-1 text-xs rounded transition-colors ${
          alertsPanelOpen
            ? 'bg-zinc-600 text-white'
            : count > 0
              ? 'bg-zinc-700 hover:bg-zinc-600 text-amber-400'
              : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-400'
        }`}
        data-help-region="menu-bar:alerts"
        title={count > 0 ? `${count} alert${count !== 1 ? 's' : ''}` : 'No alerts'}
      >
        ⚠
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold bg-amber-500 text-zinc-900 rounded-full leading-none">
            {count}
          </span>
        )}
      </button>

      {/* Inner body — mounts ONLY when the flyout is open. Body runs
          the full `useAlerts()` synchronous compute + all action-
          handler subscriptions; absent from the tree while closed. */}
      {alertsPanelOpen && <AlertsPanelBody />}
    </div>
  )
}

function AlertsPanelBody() {
  const alerts = useAlerts()
  const povColor = usePovColor()
  const focusNode = useUiStore((s) => s._focusNode)
  const setEntityLibraryTab = useUiStore((s) => s.setEntityLibraryTab)
  const setSidebarTab = useUiStore((s) => s.setSidebarTab)
  const dismissedUninstantiatedIds = useUiStore((s) => s.dismissedUninstantiatedIds)
  const dismissUninstantiatedAlert = useUiStore((s) => s.dismissUninstantiatedAlert)
  const clearDismissedUninstantiated = useUiStore((s) => s.clearDismissedUninstantiated)
  const dismissedSoloRelIds = useUiStore((s) => s.dismissedSoloRelIds)
  const dismissSoloRelAlert = useUiStore((s) => s.dismissSoloRelAlert)
  const clearDismissedSoloRels = useUiStore((s) => s.clearDismissedSoloRels)
  const dismissedDownstreamOverlapIds = useUiStore((s) => s.dismissedDownstreamOverlapIds)
  const dismissDownstreamOverlapAlert = useUiStore((s) => s.dismissDownstreamOverlapAlert)
  const dismissedMembershipAlertIds = useUiStore((s) => s.dismissedMembershipAlertIds)
  const dismissedInconsistencyAlertIds = useUiStore((s) => s.dismissedInconsistencyAlertIds)
  const dismissInconsistencyAlert = useUiStore((s) => s.dismissInconsistencyAlert)
  const dismissMembershipAlert = useUiStore((s) => s.dismissMembershipAlert)
  const clearDismissedDownstreamOverlaps = useUiStore((s) => s.clearDismissedDownstreamOverlaps)
  const clearEntityReviewFlags = useProjectStore((s) => s.clearEntityReviewFlags)
  const clearEntityReviewField = useProjectStore((s) => s.clearEntityReviewField)
  const removeChainOverrideForField = useProjectStore((s) => s.removeChainOverrideForField)
  const removeAwarenessHistoryEntry = useProjectStore((s) => s.removeAwarenessHistoryEntry)
  const clearAwarenessHistoryReviewFlag = useProjectStore((s) => s.clearAwarenessHistoryReviewFlag)
  const undoCancelledListOp = useProjectStore((s) => s.undoCancelledListOp)
  const undoDanglingListRemove = useProjectStore((s) => s.undoDanglingListRemove)
  const undoAutoResolvedAliases = useProjectStore((s) => s.undoAutoResolvedAliases)
  const addPovOriginNode = useProjectStore((s) => s.addPovOriginNode)
  const deleteObject = useProjectStore((s) => s.deleteObject)
  const recordRelationshipChange = useProjectStore((s) => s.recordRelationshipChange)
  // Phase 3.7 perf fix (large-project load perf #6): structurally-stable
  // subscriptions for nodes / edges so position-only updates (canvas
  // pan/drag, React Flow dimension measurement) DON'T fire AlertsPanel's
  // render function. AlertsPanel reads node/edge shapes for chain-
  // resolved alert display (`computeEffectiveState`, `computePovChain`,
  // `getRelationshipNodeOrder`, etc.) — all of which depend on id/type/
  // data ref but NOT on position or measured dimensions. Same comparator
  // shape `useAlerts` itself uses (Phase 2.11.19); imports the helpers
  // from `useAlerts.js` so the two consumers share one definition and
  // can't drift.
  const nodes = useStoreWithEqualityFn(useProjectStore, (s) => s.nodes, nodesStructurallyEqual)
  const edges = useStoreWithEqualityFn(useProjectStore, (s) => s.edges, edgesStructurallyEqual)
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const knowledges = useProjectStore((s) => s.knowledges)
  // Phase 1.21h — projectStore.knowledges is the canonical Knowledge
  // store post-1.21c (entitiesStore.knowledges stays empty). Merge so
  // EntityAlertImage / NodeBadge / ListItemChip can resolve Knowledge
  // ids — used by the Knowledge awareness review alert (target slot
  // shows the 📜 avatar). Synthesized `type: 'knowledge'` so
  // TYPE_ICONS' fallback resolves to the glyph when no profile image.
  const projectKnowledges = useProjectStore((s) => s.knowledges)
  const entityMap = useMemo(() => {
    const map = new Map(
      [...characters, ...locations, ...items, ...factions, ...customs, ...(knowledges || [])]
        .map((e) => [e.id, e]),
    )
    for (const k of (projectKnowledges || [])) {
      if (!map.has(k.id)) map.set(k.id, { ...k, type: 'knowledge' })
    }
    return map
  }, [characters, locations, items, factions, customs, knowledges, projectKnowledges])

  // Clear dismissed IDs for entities that are no longer uninstantiated (got an origin node)
  const uninstantiatedIds = useMemo(
    () => new Set(alerts.filter((a) => a.type === 'uninstantiated').map((a) => a.entityId)),
    [alerts]
  )
  useEffect(() => {
    const stale = Object.keys(dismissedUninstantiatedIds).filter((id) => !uninstantiatedIds.has(id))
    if (stale.length > 0) clearDismissedUninstantiated(stale)
  }, [uninstantiatedIds, dismissedUninstantiatedIds, clearDismissedUninstantiated])

  // Clear dismissed solo-rel IDs for relationships that are no longer solo (got a second participant)
  const soloRelIds = useMemo(
    () => new Set(alerts.filter((a) => a.type === 'relationship_solo').map((a) => a.relationshipId)),
    [alerts]
  )
  useEffect(() => {
    const stale = Object.keys(dismissedSoloRelIds).filter((id) => !soloRelIds.has(id))
    if (stale.length > 0) clearDismissedSoloRels(stale)
  }, [soloRelIds, dismissedSoloRelIds, clearDismissedSoloRels])

  // Clear dismissed downstream-overlap keys when the underlying conflict no longer fires
  // (either rel's effective participants diverged, one was deleted, etc.). Same
  // auto-cleanup pattern as the solo-rel dismissal above.
  const downstreamOverlapKeys = useMemo(
    () => new Set(alerts.filter((a) => a.type === 'relationship_downstream_overlap').map((a) => a.pairKey)),
    [alerts]
  )
  useEffect(() => {
    const stale = Object.keys(dismissedDownstreamOverlapIds).filter((k) => !downstreamOverlapKeys.has(k))
    if (stale.length > 0) clearDismissedDownstreamOverlaps(stale)
  }, [downstreamOverlapKeys, dismissedDownstreamOverlapIds, clearDismissedDownstreamOverlaps])

  // Filter out dismissed uninstantiated, solo-rel, downstream-overlap,
  // and awareness-membership-change alerts.
  const visibleAlerts = useMemo(
    () => alerts.filter((a) => {
      if (a.type === 'uninstantiated' && dismissedUninstantiatedIds[a.entityId]) return false
      if (a.type === 'relationship_solo' && dismissedSoloRelIds[a.relationshipId]) return false
      if (a.type === 'relationship_downstream_overlap' && dismissedDownstreamOverlapIds[a.pairKey]) return false
      if (a.type === 'awareness_membership_change' && dismissedMembershipAlertIds[a.id]) return false
      if (a.type === 'awareness_alias_entity_inconsistency' && dismissedInconsistencyAlertIds[a.id]) return false
      return true
    }),
    [alerts, dismissedUninstantiatedIds, dismissedSoloRelIds, dismissedDownstreamOverlapIds, dismissedMembershipAlertIds, dismissedInconsistencyAlertIds]
  )

  const count = visibleAlerts.length

  function handleAlertClick(alert) {
    if (alert.type === 'uninstantiated' && alert.entityType) {
      setSidebarTab('library')
      setEntityLibraryTab(alert.entityType)
      return
    }
    if (alert.type === 'knowledge_uninstantiated') {
      setSidebarTab('library')
      setEntityLibraryTab('knowledge')
      return
    }
    if (alert.type === 'uncategorized_custom') {
      setSidebarTab('library')
      setEntityLibraryTab('custom')
      return
    }
    // Phase 2.13d — Orphaned perspective target. Two cases:
    //   - Baseline orphan (alert.nodeId == null): open the host
    //     entity's origin EntityNode detail panel, Attributes tab,
    //     so the writer sees the orphaned perspective row with the
    //     description preserved and can rewire / delete it.
    //   - Mid-chain orphan (alert.nodeId set): the perspective was
    //     added at a scene EntityRef or modifier EntityNode. Focus
    //     that node and open its detail panel pointed at the host
    //     entity's chip / modifier — same Attributes tab.
    if (alert.type === 'orphaned_perspective_target') {
      const ps = useProjectStore.getState()
      const uiStore = useUiStore.getState()
      if (!alert.nodeId) {
        const originNode = (ps.nodes || []).find((n) =>
          n && n.type === 'entityNode'
          && n.data?.entity_id === alert.entityId
          && !n.data?.is_modifier
        )
        if (originNode) {
          uiStore.setDetailPanel('entityNode', originNode.id, alert.entityId, 0, 'attributes')
          if (focusNode) focusNode(originNode.id)
        } else {
          // No origin node on canvas — surface the entity in the
          // library tab as a fallback so the writer can still reach
          // its detail.
          setSidebarTab('library')
          setEntityLibraryTab(alert.entityType || 'character')
        }
        return
      }
      const triggerNode = (ps.nodes || []).find((n) => n.id === alert.nodeId)
      if (!triggerNode) return
      const isScene = triggerNode.type === 'sceneNode'
      const mode = isScene ? 'entityChip' : 'entityNode'
      uiStore.setDetailPanel(mode, alert.nodeId, alert.entityId, -1, 'attributes')
      if (focusNode) focusNode(alert.nodeId)
      return
    }
    if (alert.type === 'pov_no_origin') {
      // Create a POV Origin Node and focus on it
      addPovOriginNode()
      // Wait for the node to be created, then focus on it
      requestAnimationFrame(() => {
        const povNode = useProjectStore.getState().nodes.find((n) => n.type === 'povOriginNode')
        if (povNode && focusNode) focusNode(povNode.id)
      })
      return
    }
    if (alert.nodeId && focusNode) focusNode(alert.nodeId)
  }

  // Build the awareness target descriptor from an alert's detail block
  // (set by the new awareness-history alert emitter). Returns null when
  // the alert isn't a new-model awareness alert.
  function awarenessTargetFromAlert(alert) {
    const d = alert?.detail
    if (!d || !d.awarenessKind) return null
    if (d.awarenessKind === 'entity_existence' && d.entityId) return { kind: 'entity', entityId: d.entityId }
    if (d.awarenessKind === 'entity_name' && d.entityId) return { kind: 'entity_name', entityId: d.entityId }
    if (d.awarenessKind === 'attribute' && d.entityId && d.attributeId) return { kind: 'attribute', entityId: d.entityId, attributeId: d.attributeId }
    if (d.awarenessKind === 'alias' && d.entityId && d.aliasValue) return { kind: 'alias', entityId: d.entityId, aliasValue: d.aliasValue }
    if (d.awarenessKind === 'relationship' && d.relationshipId) return { kind: 'relationship', relationshipId: d.relationshipId }
    if (d.awarenessKind === 'knowledge' && d.knowledgeId) return { kind: 'knowledge', knowledgeId: d.knowledgeId }
    return null
  }

  function handleDismissReview(alert, e) {
    e.stopPropagation()
    // Phase 1.23 — scene-level Time Since Last Scene gap-shift alert.
    // Accept = clear review entry + advance `last_known_gap` to the
    // current walker gap so the next save's detection treats this as
    // the new baseline.
    if (alert.field === 'time_since_last_scene' && !alert.entityId) {
      useProjectStore.getState().acceptScenetimeAlert(alert.nodeId)
      return
    }
    // Awareness alert: clear the per-entry review_flag on the
    // awareness object's history list.
    const awarenessTarget = awarenessTargetFromAlert(alert)
    if (awarenessTarget && alert.detail?.historyEntryId) {
      clearAwarenessHistoryReviewFlag({ target: awarenessTarget, entryId: alert.detail.historyEntryId })
      return
    }
    clearEntityReviewField(alert.nodeId, alert.entityId, alert.field)
  }

  // Phase 1.23 — scene-level Time Since Last Scene resolutions.
  function handleScenetimeOpenModal(alert, e) {
    e.stopPropagation()
    useUiStore.getState().openSceneTimeModal(alert.nodeId)
  }
  function handleScenetimeClearExtension(alert, e) {
    e.stopPropagation()
    useProjectStore.getState().acceptScenetimeAlert(alert.nodeId, { clearExtension: true })
  }

  function handleRemoveRedundantOverride(alert, e) {
    e.stopPropagation()
    // Awareness alert: strip the now-redundant entry from the
    // awareness object's history list. The strip helper also clears any
    // review_flag whose sourceNodeId pointed at the removed entry.
    const awarenessTarget = awarenessTargetFromAlert(alert)
    if (awarenessTarget && alert.detail?.historyEntryId) {
      removeAwarenessHistoryEntry({ target: awarenessTarget, entryId: alert.detail.historyEntryId })
      return
    }
    removeChainOverrideForField(alert.nodeId, alert.entityId, alert.field)
    clearEntityReviewField(alert.nodeId, alert.entityId, alert.field)
  }

  function handleUndoCancelledListOp(alert, e) {
    e.stopPropagation()
    undoCancelledListOp(alert.nodeId, alert.entityId, alert.field)
  }

  function handleUndoDanglingListRemove(alert, e) {
    e.stopPropagation()
    undoDanglingListRemove(alert.nodeId, alert.entityId, alert.field)
  }

  function handleRevertAutoResolved(alert, e) {
    e.stopPropagation()
    undoAutoResolvedAliases(alert.nodeId, alert.entityId)
  }

  // ── Membership-change alert handlers ─────────────────────────────────────
  // Shared: build a target descriptor from the alert's consumer surface
  // so the universal awareness setter / opener actions can be invoked
  // generically across all five consumer kinds.
  function membershipTargetFromAlert(alert) {
    const c = alert?.consumer
    if (!c) return null
    if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'awareness')      return { kind: 'entity',       entityId: c.surfaceId }
    if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'name_awareness') return { kind: 'entity_name',  entityId: c.surfaceId }
    if (c.surfaceKind === 'attribute')   return { kind: 'attribute',    entityId: c.parentEntityId, attributeId: c.surfaceId }
    if (c.surfaceKind === 'alias')       return { kind: 'alias',        entityId: c.parentEntityId, aliasValue:  c.surfaceId }
    if (c.surfaceKind === 'relationship') return { kind: 'relationship', relationshipId: c.surfaceId }
    if (c.surfaceKind === 'knowledge')    return { kind: 'knowledge',    knowledgeId:    c.surfaceId }
    return null
  }

  // Button 1 — "Confirm new level" / "Confirm no awareness". Accepts the
  // membership-driven shift; writes nothing; suppresses the alert.
  function handleMembershipConfirm(alert, e) {
    e.stopPropagation()
    dismissMembershipAlert(alert.id)
  }

  // ── Alias-linkage / entity-existence inconsistency handlers ──────────
  // Three resolution paths: dismiss (leave as is), raise existence
  // awareness to 3, or downgrade each affected alias to 2. Both write
  // paths route through the universal awareness setter at whichever
  // anchor (origin / chain) the alert is tied to.
  function inconsistencyAnchor(alert) {
    return alert.isOrigin
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: alert.nodeId }
  }

  function readPriorAwareness(target, anchorNodeId) {
    const entity = entityMap.get(target.entityId)
    if (!entity) return null
    const eff = computeEffectiveState(entity, nodes, edges, anchorNodeId)
    return readEffectiveAwarenessForTarget(eff, target)
  }

  function buildDraftWithLevel(priorWrapper, observerId, level) {
    const baseEntries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
      ? (priorWrapper.entries ?? {})
      : {}
    const baseSources = (priorWrapper && typeof priorWrapper === 'object' && Array.isArray(priorWrapper.sources)) ? priorWrapper.sources : []
    return {
      entries: { ...baseEntries, [observerId]: level },
      sources: baseSources,
    }
  }

  function handleDismissInconsistency(alert, e) {
    e.stopPropagation()
    dismissInconsistencyAlert(alert.id)
  }

  function handleRaiseEntityAwareness(alert, e) {
    e.stopPropagation()
    const target = { kind: 'entity', entityId: alert.entityId }
    const anchor = inconsistencyAnchor(alert)
    const prior = readPriorAwareness(target, alert.nodeId)
    const draft = buildDraftWithLevel(prior, alert.observerId, 3)
    useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    dismissInconsistencyAlert(alert.id)
  }

  function handleDowngradeAliases(alert, e) {
    e.stopPropagation()
    const anchor = inconsistencyAnchor(alert)
    const items = (alert.aliasValues || []).map((aliasValue) => {
      const target = { kind: 'alias', entityId: alert.entityId, aliasValue }
      const prior = readPriorAwareness(target, alert.nodeId)
      const draft = buildDraftWithLevel(prior, alert.observerId, 2)
      return { target, draft }
    })
    if (items.length === 0) return
    useProjectStore.getState().commitAwarenessBatchAtAnchor({ items, anchor })
    dismissInconsistencyAlert(alert.id)
  }

  // Button 2 — "Preserve current awareness". Pins the leaving entity at
  // their PRE-leave level via a chain entry on the consumer surface,
  // anchored at the leave scene. Compute the chain-resolved awareness
  // wrapper at the anchor and add the pinned direct-entry; the universal
  // setter diffs and writes only the new direct-entry.
  function handleMembershipPreserve(alert, e) {
    e.stopPropagation()
    const target = membershipTargetFromAlert(alert)
    if (!target) return
    const c = alert.consumer
    // Compute chain-resolved awareness wrapper at the anchor for this consumer.
    let priorWrapper = null
    if (c.surfaceKind === 'entity' || c.surfaceKind === 'attribute' || c.surfaceKind === 'alias') {
      const ownerId = c.surfaceKind === 'entity' ? c.surfaceId : c.parentEntityId
      const ent = entityMap.get(ownerId)
      if (ent) {
        const eff = computeEffectiveState(ent, nodes, edges, alert.nodeId)
        priorWrapper = readEffectiveAwarenessForTarget(eff, target)
      }
    } else if (c.surfaceKind === 'relationship') {
      const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === c.surfaceId)
      if (rel) {
        const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges)
        const eff = computeRelationshipEffectiveState(rel, nodeOrder, alert.nodeId)
        priorWrapper = eff?.awareness_raw ?? eff?.awareness ?? null
      }
    } else if (c.surfaceKind === 'knowledge') {
      const k = (useProjectStore.getState().knowledges || []).find((kk) => kk.id === c.surfaceId)
      if (k) {
        const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges)
        const eff = computeKnowledgeEffectiveState(k, nodeOrder, alert.nodeId, { nodes })
        priorWrapper = eff?.awareness ?? null
      }
    }
    // Build a draft that pins the leaving entity at beforeLevel.
    // priorWrapper may be null (untracked), a flat dict, or a wrapper
    // {entries, sources, history}. Normalise to wrapper-with-entries.
    const baseEntries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
      ? (priorWrapper.entries ?? (Object.prototype.hasOwnProperty.call(priorWrapper, 'level') ? {} : priorWrapper))
      : {}
    const baseSources = (priorWrapper && typeof priorWrapper === 'object' && Array.isArray(priorWrapper.sources)) ? priorWrapper.sources : []
    const draft = {
      entries: { ...baseEntries, [alert.leavingEntityId]: alert.beforeLevel },
      sources: baseSources,
    }
    useProjectStore.getState().commitAwarenessAtAnchor({
      target,
      anchor: { kind: 'chain', nodeId: alert.nodeId },
      draft,
    })
    dismissMembershipAlert(alert.id)
  }

  // Button 3 — "Manually adjust". Opens the appropriate awareness
  // editor for the consumer surface, pre-anchored at the alert's
  // anchor. The user can then make per-observer adjustments freely.
  function handleMembershipManualAdjust(alert, e) {
    e.stopPropagation()
    const c = alert.consumer
    const ui = useUiStore.getState()
    const anchor = { kind: 'chain', nodeId: alert.nodeId }
    if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'awareness') {
      ui.setDetailPanel('entityChip', alert.nodeId, c.surfaceId, -1, 'awareness')
    } else if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'name_awareness') {
      ui.openAliasesPanel(c.surfaceId, anchor, { kind: 'name' })
    } else if (c.surfaceKind === 'alias') {
      ui.openAliasesPanel(c.parentEntityId, anchor, { kind: 'alias', value: c.surfaceId })
    } else if (c.surfaceKind === 'attribute') {
      ui.openAttributesAwarenessPanel(c.parentEntityId, anchor, c.surfaceId)
    } else if (c.surfaceKind === 'relationship') {
      ui.openRelationshipDetail(c.surfaceId, alert.nodeId)
    } else if (c.surfaceKind === 'knowledge') {
      ui.openKnowledgeDetail(c.surfaceId, alert.nodeId)
    }
    dismissMembershipAlert(alert.id)
  }

  async function handleDeleteSoloRelationship(alert, e) {
    e.stopPropagation()
    const rel = useProjectStore.getState().relationships.find((r) => r.id === alert.relationshipId)
    const anchorNodeId = alert.endNodeId || alert.nodeId
    const resolveNameAtAlert = anchorNodeId ? (eid) => {
      const ent = entityMap.get(eid)
      if (!ent) return null
      const s = computeEffectiveState(ent, nodes, edges, anchorNodeId)
      return s?.name || ent.name || null
    } : null
    const result = await confirm({
      title: 'Delete relationship',
      message: buildDeleteRelationshipMessage({ rel, getEntity: (id) => entityMap.get(id), resolveName: resolveNameAtAlert }),
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result !== 'delete') return
    deleteObject('relationship', alert.relationshipId)
  }

  async function handleEndSoloRelationship(alert, e) {
    e.stopPropagation()
    if (!alert.endNodeId) return handleDeleteSoloRelationship(alert, e)
    const rel = useProjectStore.getState().relationships.find((r) => r.id === alert.relationshipId)
    const result = await confirm({
      title: 'End relationship',
      message: buildEndRelationshipMessage({
        rel,
        getEntity: (id) => entityMap.get(id),
        endNodeId: alert.endNodeId,
        nodes,
        entityMap,
        resolveName: (eid) => {
          const ent = entityMap.get(eid)
          if (!ent) return null
          const s = computeEffectiveState(ent, nodes, edges, alert.endNodeId)
          return s?.name || ent.name || null
        },
      }),
      buttons: [
        { label: 'End here', value: 'end', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result !== 'end') return
    recordRelationshipChange(alert.relationshipId, {
      type: 'existence',
      data: { action: 'deactivate', node_id: alert.endNodeId },
    })
    dismissSoloRelAlert(alert.relationshipId)
  }

  async function handleClearAllAlerts() {
    const reviewAlerts = visibleAlerts.filter((a) => a.type === 'review')
    const uninstantiatedAlerts = visibleAlerts.filter((a) => a.type === 'uninstantiated')
    const totalAlerts = reviewAlerts.length + uninstantiatedAlerts.length
    if (totalAlerts === 0) return
    const result = await confirm({
      title: 'Clear all alerts',
      message: `Clear all ${totalAlerts} alert${totalAlerts !== 1 ? 's' : ''}?`,
      buttons: [
        { label: 'Clear',  value: 'clear',  style: 'primary' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result !== 'clear') return
    // Clear review flags. Two dispatch paths depending on where the
    // alert's review_flag actually lives:
    //   - awareness alert → awareness.history entry's flag
    //     (per-entry strip via clearAwarenessHistoryReviewFlag)
    //   - everything else → EntityRef.review_fields (batched per entity)
    const entityBatchSeen = new Set()
    const awarenessHistorySeen = new Set()
    const sceneTimeSeen = new Set()
    for (const alert of reviewAlerts) {
      // Phase 1.23 — scene-level Time Since Last Scene alerts route
      // through their own accept action (clears the review entry +
      // advances last_known_floor_minutes baseline). They have no
      // entityId so the EntityRef-based clearEntityReviewFlags path
      // would no-op them.
      if (alert.field === 'time_since_last_scene' && !alert.entityId) {
        const key = `st:${alert.nodeId}`
        if (!sceneTimeSeen.has(key)) {
          sceneTimeSeen.add(key)
          useProjectStore.getState().acceptScenetimeAlert(alert.nodeId)
        }
        continue
      }
      const awarenessTarget = awarenessTargetFromAlert(alert)
      if (awarenessTarget && alert.detail?.historyEntryId) {
        const key = `aware:${alert.detail.historyEntryId}`
        if (!awarenessHistorySeen.has(key)) {
          awarenessHistorySeen.add(key)
          clearAwarenessHistoryReviewFlag({ target: awarenessTarget, entryId: alert.detail.historyEntryId })
        }
        continue
      }
      const key = `${alert.nodeId}:${alert.entityId}`
      if (!entityBatchSeen.has(key)) {
        entityBatchSeen.add(key)
        clearEntityReviewFlags(alert.nodeId, alert.entityId)
      }
    }
    // Dismiss uninstantiated alerts
    for (const alert of uninstantiatedAlerts) {
      dismissUninstantiatedAlert(alert.entityId)
    }
  }

  // Fix #12 (large-project load perf): this body component only mounts
  // when the flyout is open. The wrapping `<div className="relative">`
  // + badge button + `{alertsPanelOpen && …}` conditional moved to
  // the outer `AlertsPanel` above. We return the flyout div directly;
  // the outer guarantees we're only mounted while `alertsPanelOpen`
  // is true. Chain-aware semantics unchanged: every chain-walker
  // call inside resolves at its proper anchor exactly as before.
  return (
    <div data-help-region="alerts:panel" className="absolute right-0 top-full mt-1 w-96 max-h-96 overflow-y-auto bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl z-[55]" style={{ zoom: 1.5 }}>
          <div data-help-region="alerts:header" className="px-3 py-2 border-b border-zinc-700 text-xs font-semibold text-zinc-300 flex items-center justify-between">
            <span>Alerts {count > 0 && <span className="text-zinc-500">({count})</span>}</span>
            {visibleAlerts.some((a) => a.type === 'review' || a.type === 'uninstantiated') && (
              <button
                onClick={handleClearAllAlerts}
                data-help-region="alerts:clear_all"
                className="w-7 h-7 flex items-center justify-center text-zinc-600 text-[10px] rounded border border-zinc-600 bg-transparent hover:bg-zinc-600 hover:border-sky-400 hover:text-sky-400 transition-colors"
                title="Clear all alerts"
              >
                ✓✓
              </button>
            )}
          </div>

          {count === 0 ? (
            <div data-help-region="alerts:empty_state" className="px-3 py-6 text-xs text-zinc-500 text-center">
              No active alerts
            </div>
          ) : (
            <div className="py-1">
              {visibleAlerts.map((alert, i) => (
                <div key={alert.id}>
                  {i > 0 && <div className="border-t border-zinc-700 mx-3" />}
                  <div
                    data-help-region={i === 0 ? 'alerts:alert_row' : undefined}
                    className="flex items-start gap-2 px-3 py-2 hover:bg-zinc-700/50 cursor-pointer group"
                    onClick={() => handleAlertClick(alert)}
                    title="Click to navigate to this node"
                  >
                    {/* Icon */}
                    <span className="flex-shrink-0 text-sm mt-0.5">
                      {alert.type === 'uninstantiated' ? (
                        <span className="text-red-400">∅</span>
                      ) : alert.type === 'knowledge_uninstantiated' ? (
                        <span className="text-red-400">∅</span>
                      ) : alert.type === 'orphaned' ? (
                        <span className="text-amber-500">⚮</span>
                      ) : alert.type === 'pov_no_origin' || alert.type === 'pov_no_character' ? (
                        <span style={{ color: povColor }}>⚠</span>
                      ) : alert.type === 'pov_disconnected' ? (
                        <span style={{ color: povColor }}>⚠</span>
                      ) : alert.type === 'flashback_no_parent' ? (
                        <span className="text-amber-500">⚠</span>
                      ) : alert.type === 'pov_chapter_order' ? (
                        <span className="text-amber-500">⚠</span>
                      ) : alert.type === 'uncategorized_custom' ? (
                        <span className="text-amber-500">⚠</span>
                      ) : alert.type === 'orphaned_perspective_target' ? (
                        <span className="text-amber-500">⚮</span>
                      ) : alert.type === 'relationship_solo' ? (
                        <span className="text-amber-500">⚮</span>
                      ) : (
                        <span className="text-sky-400">⚑</span>
                      )}
                    </span>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {alert.type === 'review' ? (
                        <ReviewAlertContent
                          detail={alert.detail}
                          nodes={nodes}
                          edges={edges}
                          entityMap={entityMap}
                          entityId={alert.entityId}
                          entityName={alert.entityName}
                          alertNodeId={alert.nodeId}
                          onNavigate={(id) => focusNode?.(id)}
                        />
                      ) : alert.type === 'uninstantiated' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <EntityAlertImage entityId={alert.entityId} nodeId={null} nodes={nodes} edges={edges} entityMap={entityMap} />
                            <span className="font-medium flex-shrink-0">{alert.entityName}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1">
                            No
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold ${BADGE_STYLES.origin.bgCls.split(' ')[0]}`}>
                              <span className={BADGE_STYLES.origin.labelCls}>{BADGE_STYLES.origin.label} : {(alert.entityType || '').toUpperCase()}</span>
                            </span>
                            node on canvas
                          </div>
                        </>
                      ) : alert.type === 'knowledge_uninstantiated' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <KnowledgeLabelChip name={alert.knowledgeName || '(unnamed)'} />
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            No creation anchor on canvas. Add an origin point at a scene (drag from library onto a scene) or as a Knowledge origin node (drag onto empty canvas).
                          </div>
                          {alert.proposedOriginNodeId && (
                            <div className="text-[10px] mt-1 flex items-center gap-1 flex-wrap" style={{ color: KNOWLEDGE_COLOUR }}>
                              <span>Suggested:</span>
                              <NodeBadge
                                nodeId={alert.proposedOriginNodeId}
                                nodes={nodes}
                                entityMap={entityMap}
                                onClick={(id) => focusNode?.(id)}
                              />
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  const ok = await confirm({
                                    title: 'Set as Knowledge origin',
                                    message: (
                                      <span>
                                        Set this scene as the creation point of <KnowledgeLabelChip name={alert.knowledgeName || '(unnamed)'} />? The Knowledge will start to exist here; downstream chain entries continue forward as before.
                                      </span>
                                    ),
                                    buttons: [
                                      { label: 'Set as origin', value: 'ok', style: 'primary' },
                                      { label: 'Cancel', value: 'cancel', style: 'neutral' },
                                    ],
                                  })
                                  if (ok === 'ok') {
                                    useProjectStore.getState().seedKnowledgeBirthAtScene(alert.knowledgeId, alert.proposedOriginNodeId)
                                  }
                                }}
                                className="px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider hover:brightness-125 transition"
                                style={{
                                  borderColor: KNOWLEDGE_COLOUR,
                                  color: KNOWLEDGE_COLOUR,
                                  backgroundColor: `${KNOWLEDGE_COLOUR}22`,
                                }}
                                title="Set this scene as the Knowledge's creation point"
                              >Set as origin</button>
                            </div>
                          )}
                        </>
                      ) : alert.type === 'pov_no_origin' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <PovStartGlyph />
                            <span className="font-medium">No POV Start Node</span>
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: povColor }}>
                            Click to add a POV start node to the canvas.
                          </div>
                        </>
                      ) : alert.type === 'pov_no_character' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <PovStartGlyph />
                            <span className="text-zinc-500 flex-shrink-0">in</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: povColor }}>
                            {alert.sceneHasNoCharacters
                              ? 'No character in this scene. Add a character entity to assign the POV.'
                              : 'POV is not attached to any character in this scene. Drag the POV badge to a character chip to attach it.'}
                          </div>
                        </>
                      ) : alert.type === 'pov_disconnected' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <PovStartGlyph />
                            <span className="text-zinc-500 flex-shrink-0">in</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: povColor }}>
                            No path to POV start node. Wire the POV chain to connect this scene.
                          </div>
                        </>
                      ) : alert.type === 'flashback_no_parent' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold bg-purple-900/30">
                              <span className="text-purple-400">SCENE : FLASHBACK</span>
                              <span className="text-zinc-100 normal-case tracking-normal font-semibold">{alert.nodeSummary}</span>
                            </span>
                          </div>
                          <div className="text-[10px] text-amber-500 mt-0.5">
                            No parent scene. Wire a scene's output into this flashback to establish its state reference.
                          </div>
                        </>
                      ) : alert.type === 'pov_chapter_order' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <span className="text-zinc-500 flex-shrink-0">in</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                          </div>
                          <div className="text-[10px] text-amber-500 mt-0.5 flex items-center gap-1 flex-wrap">
                            <span>POV chain regresses: this scene sits in</span>
                            <span className="font-semibold text-zinc-200">{alert.currentChapterTitle}</span>
                            <span>but the previous POV scene</span>
                            <NodeBadge nodeId={alert.previousNodeId} nodes={nodes} entityMap={entityMap} onClick={(id) => focusNode?.(id)} />
                            <span>was in</span>
                            <span className="font-semibold text-zinc-200">{alert.previousChapterTitle}</span>
                            <span>.</span>
                          </div>
                        </>
                      ) : alert.type === 'uncategorized_custom' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <EntityAlertImage entityId={alert.entityId} nodeId={null} nodes={nodes} edges={edges} entityMap={entityMap} />
                            <span className="font-medium flex-shrink-0">{alert.entityName}</span>
                          </div>
                          <div className="text-[10px] text-amber-400 mt-0.5">
                            This custom entity has no valid category. Assign a new category or delete the entity to clear this alert.
                          </div>
                        </>
                      ) : alert.type === 'orphaned_perspective_target' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <EntityAlertImage entityId={alert.entityId} nodeId={null} nodes={nodes} edges={edges} entityMap={entityMap} />
                            <span className="font-medium flex-shrink-0">{alert.entityName}</span>
                            <span className="text-zinc-500 flex-shrink-0">'s</span>
                            <span className="font-medium flex-shrink-0 text-amber-300">Perspective</span>
                            <span className="text-zinc-500 flex-shrink-0">lost its target</span>
                            {alert.nodeId && (
                              <>
                                <span className="text-zinc-500 flex-shrink-0">at</span>
                                <span className="flex-shrink-0">
                                  <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                                </span>
                              </>
                            )}
                          </div>
                          {alert.perspectiveDescription && (
                            <div className="text-[10px] text-zinc-400 italic mt-0.5 truncate">
                              "{alert.perspectiveDescription}"
                            </div>
                          )}
                          <div className="text-[10px] text-amber-400 mt-0.5">
                            The target was deleted. Click to open the host's detail panel — rewire the target or delete the perspective entry.
                          </div>
                        </>
                      ) : alert.type === 'relationship_solo' ? (
                        alert.actionType === 'end_here' ? (
                          <>
                            <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                              <span className="font-medium flex-shrink-0">{alert.leaverEntityName || 'A participant'}</span>
                              {alert.leaverAlias && <span className="text-zinc-500 italic flex-shrink-0">as {alert.leaverAlias}</span>}
                              <span className="text-zinc-500 flex-shrink-0">removed from</span>
                              <span className="flex-shrink-0"><RelationshipLabelChip name={alert.relationshipName} /></span>
                              {alert.nodeId && (
                                <>
                                  <span className="text-zinc-500 flex-shrink-0">at</span>
                                  <span className="flex-shrink-0"><NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} /></span>
                                </>
                              )}
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1 flex-wrap">
                              <span className="text-zinc-300 font-medium">{alert.entityName}</span>
                              {alert.entityAlias && <span className="text-zinc-500 italic">as {alert.entityAlias}</span>}
                              is the only remaining participant.
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                              <RelationshipLabelChip name={alert.relationshipName} />
                              {alert.nodeId && (
                                <>
                                  <span className="text-zinc-500 flex-shrink-0">from</span>
                                  <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                                </>
                              )}
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1 flex-wrap">
                              Only
                              <span className="text-zinc-300 font-medium">{alert.entityName}</span>
                              {alert.entityAlias && <span className="text-zinc-500 italic">as {alert.entityAlias}</span>}
                              remains as a participant.
                            </div>
                          </>
                        )
                      ) : alert.type === 'relationship_downstream_overlap' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <span className="flex-shrink-0"><RelationshipLabelChip name={alert.relationshipName} /></span>
                            <span className="text-zinc-500 flex-shrink-0">
                              {alert.matchKind === 'exact' ? 'overlaps with' : 'is contained in'}
                            </span>
                            <span className="flex-shrink-0"><RelationshipLabelChip name={alert.conflictRelationshipName} /></span>
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1 flex-wrap">
                            <span>starting at</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                            <span>— confirm you want to keep both.</span>
                          </div>
                        </>
                      ) : alert.type === 'awareness_membership_change' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <span className="flex-shrink-0 inline-flex">
                              <EntityAlertImage entityId={alert.leavingEntityId} nodeId={alert.nodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
                            </span>
                            <span className="font-medium flex-shrink-0">{alert.leavingEntityName}</span>
                            <span className="text-zinc-500 flex-shrink-0">
                              {alert.eventKind === 'relationship_leave' ? 'left' : 'was removed from'}
                            </span>
                            {alert.eventKind === 'relationship_leave' ? (
                              <span className="flex-shrink-0"><RelationshipLabelChip name={alert.sourceLabel} /></span>
                            ) : (
                              <span className="text-zinc-300 truncate flex-shrink-0">{alert.sourceLabel}</span>
                            )}
                            <span className="text-zinc-500 flex-shrink-0">at</span>
                            <span className="flex-shrink-0"><NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} /></span>
                          </div>
                          {/* Two-line "Was / Will now have" body. Identity
                              badges follow the AwarenessSubChip rendering
                              convention so the same surface kinds render
                              the same way across canvas chips and
                              AlertsPanel rows. */}
                          {(() => {
                            const c = alert.consumer
                            const consumerBadge = (() => {
                              if (!c) return <span className="text-zinc-300">{alert.carrierLabel}</span>
                              if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'awareness') {
                                const ent = entityMap.get(c.surfaceId)
                                if (!ent) return <span className="text-zinc-300">{alert.carrierLabel}</span>
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <EntityAvatar entity={ent} size={14} />
                                    <span className="text-[10px]" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                                  </span>
                                )
                              }
                              if (c.surfaceKind === 'entity' && c.awarenessFieldPath === 'name_awareness') {
                                const ent = entityMap.get(c.surfaceId)
                                if (!ent) return <span className="text-zinc-300">{alert.carrierLabel}</span>
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <EntityAvatar entity={ent} size={14} />
                                    <span className="text-[10px]" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                                    <span className="text-[9px] text-zinc-500">·</span>
                                    <span className="text-[10px] text-zinc-300">Name</span>
                                    <span className="text-[10px] text-zinc-400 italic">"{ent.name}"</span>
                                  </span>
                                )
                              }
                              if (c.surfaceKind === 'alias') {
                                const ent = entityMap.get(c.parentEntityId)
                                if (!ent) return <span className="text-zinc-300">{alert.carrierLabel}</span>
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <EntityAvatar entity={ent} size={14} />
                                    <span className="text-[10px]" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                                    <span className="text-[9px] text-zinc-500">·</span>
                                    <span className="text-[10px] text-zinc-300">Alias</span>
                                    <span className="text-[10px] text-zinc-400 italic">"{c.surfaceId}"</span>
                                  </span>
                                )
                              }
                              if (c.surfaceKind === 'attribute') {
                                const ent = entityMap.get(c.parentEntityId)
                                const attr = (ent?.attributes || []).find((a) => a.id === c.surfaceId)
                                if (!ent) return <span className="text-zinc-300">{alert.carrierLabel}</span>
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <EntityAvatar entity={ent} size={14} />
                                    <span className="text-[10px]" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                                    <span className="text-[9px] text-zinc-500">·</span>
                                    <span className="text-[10px] text-zinc-300">{attr?.name || 'Attribute'}</span>
                                  </span>
                                )
                              }
                              if (c.surfaceKind === 'relationship') {
                                const rel = (useProjectStore.getState().relationships || []).find((r) => r.id === c.surfaceId)
                                return <RelationshipLabelChip name={rel?.name?.trim() || alert.carrierLabel} />
                              }
                              if (c.surfaceKind === 'knowledge') {
                                const k = (projectKnowledges || []).find((kk) => kk.id === c.surfaceId)
                                return <KnowledgeLabelChip name={k?.name || alert.carrierLabel} />
                              }
                              return <span className="text-zinc-300">{alert.carrierLabel}</span>
                            })()
                            const sourceBadge = alert.eventKind === 'relationship_leave'
                              ? <RelationshipLabelChip name={alert.sourceLabel} />
                              : (() => {
                                  const [eid, aid] = (alert.sourceId || '').split(':')
                                  const ent = entityMap.get(eid)
                                  const attr = (ent?.attributes || []).find((a) => a.id === aid)
                                  if (!ent) return <span className="text-zinc-300">{alert.sourceLabel}</span>
                                  return (
                                    <span className="inline-flex items-center gap-1">
                                      <EntityAvatar entity={ent} size={14} />
                                      <span className="text-[10px]" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                                      <span className="text-[9px] text-zinc-500">·</span>
                                      <span className="text-[10px] text-zinc-300">{attr?.name || alert.sourceLabel}</span>
                                    </span>
                                  )
                                })()
                            return (
                              <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
                                <div className="flex items-center gap-1 flex-wrap">
                                  {sourceBadge}
                                  <span>gave</span>
                                  <span className="font-medium text-zinc-300">{alert.leavingEntityName}</span>
                                  <span>awareness</span>
                                  {alert.beforeLevel != null && <AwarenessBadge level={alert.beforeLevel} size={11} />}
                                  <span>of</span>
                                  {consumerBadge}
                                </div>
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span className="font-medium text-zinc-300">{alert.leavingEntityName}</span>
                                  <span>will now have</span>
                                  {alert.flavour === 'full_removal' ? (
                                    <>
                                      <span>no awareness of</span>
                                      {consumerBadge}
                                    </>
                                  ) : (
                                    <>
                                      <span>awareness</span>
                                      <AwarenessBadge level={alert.afterLevel} size={11} />
                                      <span>of</span>
                                      {consumerBadge}
                                    </>
                                  )}
                                </div>
                              </div>
                            )
                          })()}
                          <div className="text-[10px] text-zinc-600 italic mt-1 flex items-center gap-1 flex-wrap">
                            <span>Manually edit, Add</span>
                            <span>{alert.leavingEntityName}</span>
                            <span>awareness</span>
                            {alert.beforeLevel != null && <AwarenessBadge level={alert.beforeLevel} size={11} />}
                            <span>individually, or confirm to clear.</span>
                          </div>
                        </>
                      ) : alert.type === 'awareness_alias_entity_inconsistency' ? (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 flex-wrap min-w-0">
                            {(() => {
                              const observer = entityMap.get(alert.observerId)
                              return observer ? (
                                <span className="inline-flex items-center gap-1 flex-shrink-0">
                                  <EntityAvatar entity={observer} size={14} />
                                  <span className="font-medium" style={{ color: observer.colour || undefined }}>{observer.name}</span>
                                </span>
                              ) : (
                                <span className="font-medium flex-shrink-0">{alert.observerName}</span>
                              )
                            })()}
                            <span className="text-zinc-500 flex-shrink-0">at</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-1 leading-snug flex flex-col gap-1">
                            {(() => {
                              const target = entityMap.get(alert.entityId)
                              const targetBadge = target ? (
                                <span className="inline-flex items-center gap-1">
                                  <EntityAvatar entity={target} size={12} />
                                  <span className="text-[10px]" style={{ color: target.colour || '#888888' }}>{target.name}</span>
                                </span>
                              ) : (
                                <span className="text-zinc-300">{alert.entityName}</span>
                              )
                              const aliasChips = (alert.aliasValues || []).map((v, i) => (
                                <span key={i} className="px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-200 text-[10px]">{v}</span>
                              ))
                              return (
                                <>
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <span>knows</span>
                                    {aliasChips}
                                    <span>is a pseudonym for</span>
                                    {targetBadge}
                                    <AwarenessBadge level={3} size={11} />
                                  </div>
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <span>but is explicitly unaware of</span>
                                    {targetBadge}
                                    <span>existing</span>
                                    <AwarenessBadge level={0} size={11} />
                                  </div>
                                </>
                              )
                            })()}
                            <div className="text-zinc-600 italic">
                              Raise existence awareness to match, downgrade {(alert.aliasValues || []).length === 1 ? 'the alias' : 'aliases'} to level 2 (knows it's a pseudonym, not whose), or leave as is.
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-zinc-200 flex items-center gap-1 min-w-0">
                            <EntityAlertImage entityId={alert.entityId} nodeId={alert.nodeId} nodes={nodes} edges={edges} entityMap={entityMap} />
                            <span className="font-medium flex-shrink-0">{alert.entityName}</span>
                            <span className="text-zinc-500 flex-shrink-0">in</span>
                            <NodeBadge nodeId={alert.nodeId} nodes={nodes} entityMap={entityMap} />
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            Orphaned: no incoming narrative-flow wire
                          </div>
                        </>
                      )}
                    </div>

                    {/* Undo button — cancelled list op alerts */}
                    {alert.type === 'review' && alert.detail?.cancelled && (
                      <button
                        onClick={(e) => handleUndoCancelledListOp(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                        title="Undo: remove the upstream addition and restore this downstream one"
                      >
                        ↩
                      </button>
                    )}
                    {/* Undo button — dangling list-remove alerts */}
                    {alert.type === 'review' && alert.detail?.dangling && (
                      <button
                        onClick={(e) => handleUndoDanglingListRemove(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                        title="Undo: remove the now-pointless removal op from this node"
                      >
                        ↩
                      </button>
                    )}
                    {/* Revert button — auto-resolved redundant override alerts */}
                    {alert.type === 'review' && alert.detail?.autoResolved && (
                      <button
                        onClick={(e) => handleRevertAutoResolved(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                        title="Revert: restore your modification at this scene"
                      >
                        ↩
                      </button>
                    )}
                    {/* Dismiss (Confirm) button — review flags and uninstantiated alerts.
                        Phase 1.21h — redundancy variant adds a sibling "Remove
                        override" button before the dismiss; the dismiss
                        wording / hover styling switches to "Keep as-is". */}
                    {alert.type === 'review' && alert.detail?.redundant && (
                      <button
                        onClick={(e) => handleRemoveRedundantOverride(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-base font-bold rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-red-400 hover:!text-red-400 transition-colors"
                        title="Remove the now-redundant modification at this scene"
                      >
                        −
                      </button>
                    )}
                    {/* Phase 1.23 — open Time Modal for scene-level
                        Time Since Last Scene gap-shift alerts.
                        "Manually review" (absorbed shift) /
                        "Adjust extension" (extension on shifted
                        floor) — same opener, different intent. */}
                    {alert.type === 'review' && alert.field === 'time_since_last_scene' && !alert.entityId && (
                      <button
                        onClick={(e) => handleScenetimeOpenModal(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                        title={
                          alert.detail?.kind === 'extension_on_shifted_floor'
                            ? 'Adjust extension: open the Time Modal'
                            : 'Manually review: open the Time Modal'
                        }
                      >
                        ✎
                      </button>
                    )}
                    {/* Phase 1.23 — Clear extension button for the
                        extension-on-shifted-floor variant only. Drops
                        gap_extension and accepts the new floor. */}
                    {alert.type === 'review' && alert.field === 'time_since_last_scene' && alert.detail?.kind === 'extension_on_shifted_floor' && !alert.entityId && (
                      <button
                        onClick={(e) => handleScenetimeClearExtension(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-base font-bold rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-red-400 hover:!text-red-400 transition-colors"
                        title="Clear extension: drop the override and use the new floor"
                      >
                        −
                      </button>
                    )}
                    {alert.type === 'review' && (
                      <button
                        onClick={(e) => handleDismissReview(alert, e)}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                        title={
                          alert.field === 'time_since_last_scene' && !alert.entityId
                            ? 'Accept the new gap'
                            : alert.detail?.autoResolved ? 'Accept: leave the modification removed'
                          : alert.detail?.redundant ? 'Keep the modification as-is'
                          : 'Confirm: this modification is still correct'
                        }
                      >
                        ✓
                      </button>
                    )}
                    {alert.type === 'uninstantiated' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); dismissUninstantiatedAlert(alert.entityId) }}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                        title="Dismiss this alert"
                      >
                        ✓
                      </button>
                    )}
                    {alert.type === 'relationship_downstream_overlap' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); dismissDownstreamOverlapAlert(alert.pairKey) }}
                        className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                        title="Dismiss: this overlap is intentional"
                      >
                        ✓
                      </button>
                    )}
                    {alert.type === 'awareness_membership_change' && (
                      <>
                        {/* Manually adjust — opens the consumer surface's
                            awareness editor pre-anchored at the leave scene. */}
                        <button
                          onClick={(e) => handleMembershipManualAdjust(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                          title="Manually adjust awareness for this surface"
                        >
                          ✎
                        </button>
                        {/* Preserve current — pin the leaving entity at
                            their pre-leave level via a chain entry on
                            this consumer at the leave scene. */}
                        <button
                          onClick={(e) => handleMembershipPreserve(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-violet-400 hover:!text-violet-400 transition-colors"
                          title={`Add ${alert.leavingEntityName} as an individual awareness entry at the pre-leave level`}
                        >
                          ✚
                        </button>
                        {/* Confirm new level / Confirm no awareness —
                            label adapts per resolved-after-leave. */}
                        <button
                          onClick={(e) => handleMembershipConfirm(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                          title={alert.flavour === 'full_removal'
                            ? `Confirm: ${alert.leavingEntityName} is no longer aware`
                            : `Confirm new level: ${alert.afterLevel}`}
                        >
                          ✓
                        </button>
                      </>
                    )}
                    {alert.type === 'awareness_alias_entity_inconsistency' && (
                      <>
                        {/* Downgrade affected aliases to 2 — preserves
                            the pseudonym claim, drops the linkage claim. */}
                        <button
                          onClick={(e) => handleDowngradeAliases(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-amber-400 hover:!text-amber-400 transition-colors"
                          title={`Downgrade ${(alert.aliasValues || []).length === 1 ? 'this alias' : 'these aliases'} to level 2 (knows it's a pseudonym, not whose)`}
                        >
                          <span className="inline-flex items-center gap-0.5">
                            <span className="text-[10px] leading-none">↓</span>
                            <AwarenessBadge level={2} size={12} />
                          </span>
                        </button>
                        {/* Raise existence awareness to 3 — the observer
                            knows the entity exists, matching the linkage. */}
                        <button
                          onClick={(e) => handleRaiseEntityAwareness(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-violet-400 hover:!text-violet-400 transition-colors"
                          title={`Raise ${alert.entityName}'s existence awareness to fully aware to match the linkage`}
                        >
                          <span className="inline-flex items-center gap-0.5">
                            <span className="text-[10px] leading-none">↑</span>
                            <AwarenessBadge level={3} size={12} />
                          </span>
                        </button>
                        {/* Leave as is — dismiss the alert. */}
                        <button
                          onClick={(e) => handleDismissInconsistency(alert, e)}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                          title="Leave as is: keep both stored values"
                        >
                          ✓
                        </button>
                      </>
                    )}
                    {alert.type === 'relationship_solo' && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); dismissSoloRelAlert(alert.relationshipId) }}
                          className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-sky-400 hover:!text-sky-400 transition-colors"
                          title="Leave this relationship as-is with one member"
                        >
                          ✓
                        </button>
                        {alert.actionType === 'end_here' ? (
                          <button
                            onClick={(e) => handleEndSoloRelationship(alert, e)}
                            className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-[10px] font-semibold rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-red-400 hover:!text-red-400 transition-colors"
                            title="End this relationship at its last active scene"
                          >
                            End
                          </button>
                        ) : (
                          <button
                            onClick={(e) => handleDeleteSoloRelationship(alert, e)}
                            className="flex-shrink-0 self-center w-7 h-7 flex items-center justify-center text-zinc-600 text-sm rounded border border-zinc-600 bg-transparent group-hover:bg-zinc-700 group-hover:border-zinc-500 hover:!bg-zinc-600 hover:!border-red-400 hover:!text-red-400 transition-colors"
                            title="Delete this relationship"
                          >
                            ✕
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}


// Wrap in `memo` so parent re-renders (anywhere in App's tree) don't
// cascade through `AlertsPanel`. Phase 2.11 Bugs & Fixes — profile
// capture `profiling-data.2026-05-31.18-18-58.json` showed 144 of
// `AlertsPanel`'s 154 renders were pure parent cascade (no hook /
// prop / context change cited in the why-data). The component takes
// no props from its parent, so default shallow-equal `memo` skips
// every cascade render. Its internal hook subscriptions still fire
// when alert-relevant store state changes — those renders are
// warranted and remain unaffected.
export default memo(AlertsPanel)
