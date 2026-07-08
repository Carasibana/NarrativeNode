import { useMemo, useState } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { participantsFallbackLabel } from '../../utils/entityHelpers'
import ContributorPickerPopover from './ContributorPickerPopover'
import { RelationshipLabelChip, EntityAvatar } from '../ui/IdentityBadges'
import ToggleInput from '../ui/ToggleInput'
import {
  scaleFor,
  DEFAULT_AWARENESS_LEVEL,
  AwarenessLevelSelector,
  awarenessLabelsFor,
  awarenessLevelStyle,
} from '../ui/AwarenessBadges'

function isAwarenessRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'relationship_id')
    && Object.prototype.hasOwnProperty.call(value, 'level')
    && Object.keys(value).length === 2
}

// Phase 1.21g — decode the awareness value into a uniform internal
// representation `{ entries, sources }`. Accepts every valid on-disk
// shape (null, flat dict, wrapper, legacy single ref) and produces a
// shape the rest of the picker can operate on uniformly.
export function decodeAwareness(value) {
  if (value == null) return { entries: {}, sources: [] }
  if (isAwarenessRef(value)) {
    return {
      entries: {},
      sources: [{ kind: 'relationship', relationship_id: value.relationship_id, level: value.level }],
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { entries: {}, sources: [] }
  // Wrapper shape — has `entries` and/or `sources` keys
  if (Object.prototype.hasOwnProperty.call(value, 'entries')
      || Object.prototype.hasOwnProperty.call(value, 'sources')) {
    return { entries: value.entries ? { ...value.entries } : {}, sources: Array.isArray(value.sources) ? [...value.sources] : [] }
  }
  // Flat dict
  return { entries: { ...value }, sources: [] }
}

// Build the output value from the current internal entries + sources.
// Cleanest valid shape per the Phase 1.21g design:
//   - empty entries + empty sources → null (tracking off)
//   - entries only → flat dict
//   - sources non-empty → wrapper, with `entries` only when populated.
export function buildOutValue(entries, sources) {
  const hasEntries = entries && Object.keys(entries).length > 0
  const hasSources = sources && sources.length > 0
  if (!hasEntries && !hasSources) return null
  if (!hasSources) return { ...entries }
  const out = {}
  if (hasEntries) out.entries = { ...entries }
  out.sources = [...sources]
  return out
}

function sourceMatches(a, b) {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'relationship') return a.relationship_id === b.relationship_id
  if (a.kind === 'attribute') return a.entity_id === b.entity_id && a.attribute_id === b.attribute_id
  return false
}

/**
 * Awareness picker — pure controlled component.
 *
 * Two presentation modes, picked by the caller via the `mode` prop:
 *
 *  - `mode="pills"` (default) — one chip row with a per-chip `AwarenessLevelSelector`
 *    (the 4 level pills inline on each entity). Compact; fits modals + tight spaces.
 *
 *  - `mode="groups"` — one framed group per level in the scale; each observer
 *    appears as a single chip (no level pills) inside its current level's
 *    group. The user drags a chip from one group to another to change that
 *    observer's level. A per-group "+ Add" button adds observers straight
 *    at that group's level. Fits sidebar/panel surfaces where the scale has
 *    3+ levels and there's enough room for the grid.
 *
 * Phase 1.21g — the picker now supports projected sources (relationships +
 * entity-list attributes) alongside direct entity contributors. The
 * `+ Add` affordance opens a unified ContributorPickerPopover with kind
 * tabs; picking an entity adds a direct entry (entries dict), picking a
 * relationship or entity-list attribute adds a projected source. All
 * three coexist on the same field; resolution in the walker applies the
 * direct-wins-then-highest-projection rule.
 *
 * A top-level "Track who knows this" toggle flips the whole field on / off:
 *  - Off → `value === null`, picker collapsed.
 *  - On  → `value` is a flat dict (no projections) or wrapper (with
 *          projections). Toggling on self-seeds the parent entity at
 *          the surface-appropriate level.
 *
 * Props:
 *   value           — current awareness value: null / flat dict / wrapper / legacy single-ref
 *   onChange        — (newValue) => void
 *   surface         — 'entity' | 'attribute' | 'alias' | 'relationship' | 'knowledge' | 'entity_name'
 *   mode            — 'pills' (default) | 'groups'
 *   parentEntityId  — id of the entity the field lives on (or would be
 *                     self-seeded under); nullable for relationship surfaces
 *   extraExcludeIds — optional Set of entity ids to hide from the "+ Add"
 *                     popover beyond those already in the dict
 *   label           — optional header label (default "Known by…")
 *   context         — optional surface-context object for per-chip tooltip
 *                     wording: { parentName?, aliasValue?, attributeName?,
 *                     relationshipName? }. Each field is optional — fields
 *                     absent for the current surface fall back to generic
 *                     static labels.
 *   disabled        — optional read-only mode
 */
const DRAG_MIME = 'application/nn-awareness-observer'
const DRAG_SOURCE_MIME = 'application/nn-awareness-source'

export default function AwarenessPicker({
  value,
  onChange,
  surface,
  mode = 'pills',
  scale: scaleOverride = null,
  parentEntityId = null,
  extraExcludeIds = null,
  label = 'Known by…',
  context = null,
  disabled = false,
  extraTrackingRow = null,
  trackToggleDisabled = false,
  trackToggleDisabledTitle = null,
  // Per-surface label for the "Track who knows this" toggle. Defaults to
  // the generic phrasing; surface call sites can pass a personalised
  // variant (e.g. `Track who knows ${entity.name}` for entity-existence).
  trackToggleLabel = 'Track who knows this',
  // When true, suppress the picker's own toggle row (label + on/off
  // switch). The calling panel renders its own toggle elsewhere — used
  // by `KnownBySection` to host the toggle inside its collapsible
  // section header so the picker's body shows ONLY the drag-and-drop
  // levels + Precision row when expanded.
  hideToggleRow = false,
  // Chip size profile. 'sm' (default) matches the compact panel
  // surfaces; 'lg' bumps avatar size + observer text up for surfaces
  // that need more visual weight (e.g. the awareness-rollover modal).
  chipSize = 'sm',
}) {
  const avatarPx = chipSize === 'lg' ? 22 : 16
  const obsTextCls = chipSize === 'lg' ? 'text-sm' : 'text-[10px]'
  const obsSepCls  = chipSize === 'lg' ? 'text-xs' : 'text-[9px]'
  const characters  = useEntitiesStore((s) => s.characters)
  const locations_  = useEntitiesStore((s) => s.locations)
  const items_      = useEntitiesStore((s) => s.items)
  const factions_   = useEntitiesStore((s) => s.factions)
  const customs_    = useEntitiesStore((s) => s.customs)
  const knowledges_ = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const allEntities = useMemo(
    () => [...characters, ...locations_, ...items_, ...factions_, ...customs_, ...(knowledges_ || [])],
    [characters, locations_, items_, factions_, customs_, knowledges_],
  )
  const getEntity = (id) => allEntities.find((e) => e.id === id) || null
  const getRelationship = (id) => (relationships || []).find((r) => r.id === id) || null

  const [pickerOpen, setPickerOpen] = useState(false)
  const [addGroupLevel, setAddGroupLevel] = useState(null)
  const [dragOverLevel, setDragOverLevel] = useState(null)

  const isTracking = value != null
  const decoded = useMemo(() => decodeAwareness(value), [value])
  const entries = decoded.entries
  const sources = decoded.sources
  const dictKeys = Object.keys(entries)
  const baseScale  = scaleOverride || scaleFor(surface)
  const scale = useMemo(
    () => ({
      ...baseScale,
      labels: awarenessLabelsFor(surface, context),
      shortLabels: baseScale.shortLabels || baseScale.labels,
    }),
    [baseScale, surface, context],
  )
  const isBinaryScale = scale.levels.length === 2

  // Normalise level for binary-scale group placement: any positive
  // stored level (1/2/3) reads as the "aware" group at level 3.
  const groupLevelFor = (lvl) => {
    if (typeof lvl !== 'number') return null
    if (isBinaryScale && lvl > 0) return 3
    return lvl
  }

  function handleToggleTrack() {
    if (disabled || trackToggleDisabled) return
    if (isTracking) {
       
      console.debug('[AwarenessPicker] toggle OFF', { surface, parentEntityId })
      onChange(null)
      setPickerOpen(false)
      return
    }
    // Toggling ON: emit a non-null empty dict. We do NOT seed the parent
    // entity as a self-observer — a character's awareness of their own
    // name / alias / attribute is a tracking artifact, not narrative
    // state, and clutters the picker with an entry that's never
    // meaningful. The downstream setter sees null → empty dict and
    // (at chain anchors) emits a tracking_on history event so the
    // toggle is itself chain-tracked.
     
    console.debug('[AwarenessPicker] toggle ON (empty)', { surface, parentEntityId })
    onChange({})
  }

  // ── Direct-entry handlers ───────────────────────────────────────────────
  function handleSetLevel(entityId, level) {
    if (disabled) return
    const next = buildOutValue({ ...entries, [entityId]: level }, sources)
     
    console.debug('[AwarenessPicker] set observer level', { surface, parentEntityId, entityId, level, emit: next })
    onChange(next)
  }

  function handleRemove(entityId) {
    if (disabled) return
    const next = { ...entries }
    delete next[entityId]
    onChange(buildOutValue(next, sources))
  }

  function handlePickEntity(entityId, level = DEFAULT_AWARENESS_LEVEL) {
    if (disabled) return
    if (dictKeys.includes(entityId)) return
    onChange(buildOutValue({ ...entries, [entityId]: level }, sources))
  }

  // ── Source handlers ─────────────────────────────────────────────────────
  function handleAddSource(newSource) {
    if (disabled) return
    if (sources.some((s) => sourceMatches(s, newSource))) return
    onChange(buildOutValue(entries, [...sources, newSource]))
  }

  function handleRemoveSource(idx) {
    if (disabled) return
    const next = sources.filter((_, i) => i !== idx)
    onChange(buildOutValue(entries, next))
  }

  function handleSetSourceLevel(idx, level) {
    if (disabled) return
    const next = sources.map((s, i) => (i === idx ? { ...s, level } : s))
    onChange(buildOutValue(entries, next))
  }

  // Unified pick handler — receives a contributor object from the popover
  // and routes to the right handler by kind.
  function handlePickContributor(pick, level = DEFAULT_AWARENESS_LEVEL) {
    if (!pick) return
    if (pick.kind === 'entity') return handlePickEntity(pick.entity_id, level)
    if (pick.kind === 'relationship') return handleAddSource({ kind: 'relationship', relationship_id: pick.relationship_id, level })
    if (pick.kind === 'attribute') return handleAddSource({ kind: 'attribute', entity_id: pick.entity_id, attribute_id: pick.attribute_id, level })
  }

  // ── Drag-and-drop handlers (groups mode) ────────────────────────────────
  function handleDragStart(e, entityId) {
    if (disabled) return
    e.dataTransfer.setData(DRAG_MIME, entityId)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleSourceDragStart(e, sourceIdx) {
    if (disabled) return
    e.dataTransfer.setData(DRAG_SOURCE_MIME, String(sourceIdx))
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleGroupDragOver(e, level) {
    if (disabled) return
    if (!e.dataTransfer.types.includes(DRAG_MIME) && !e.dataTransfer.types.includes(DRAG_SOURCE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverLevel !== level) setDragOverLevel(level)
  }

  function handleGroupDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverLevel(null)
  }

  function handleGroupDrop(e, targetLevel) {
    if (disabled) return
    e.preventDefault()
    setDragOverLevel(null)
    const entityId = e.dataTransfer.getData(DRAG_MIME)
    const sourceIdxStr = e.dataTransfer.getData(DRAG_SOURCE_MIME)
    if (entityId) {
      const currentLevel = entries[entityId]
      if (isBinaryScale) {
        const currentGroup = (typeof currentLevel === 'number' && currentLevel > 0) ? 3 : 0
        if (currentGroup === targetLevel) return
      } else {
        if (currentLevel === targetLevel) return
      }
      handleSetLevel(entityId, targetLevel)
      return
    }
    if (sourceIdxStr !== '') {
      const idx = Number(sourceIdxStr)
      if (!Number.isFinite(idx) || idx < 0 || idx >= sources.length) return
      const currentLevel = sources[idx].level
      if (isBinaryScale) {
        const currentGroup = (typeof currentLevel === 'number' && currentLevel > 0) ? 3 : 0
        if (currentGroup === targetLevel) return
      } else if (currentLevel === targetLevel) return
      handleSetSourceLevel(idx, targetLevel)
    }
  }

  const excludeIds = useMemo(() => {
    const set = new Set(dictKeys)
    if (extraExcludeIds) for (const id of extraExcludeIds) set.add(id)
    return set
  }, [dictKeys, extraExcludeIds])

  const excludeRelIds = useMemo(() => {
    const set = new Set()
    for (const s of sources) if (s.kind === 'relationship') set.add(s.relationship_id)
    return set
  }, [sources])

  const excludeAttrKeys = useMemo(() => {
    const set = new Set()
    for (const s of sources) if (s.kind === 'attribute') set.add(`${s.entity_id}:${s.attribute_id}`)
    return set
  }, [sources])

  // Render helper for a source chip body (used in both pills + groups
  // modes). Variants:
  //   - relationship — RelationshipLabelChip with relationship name in violet
  //   - attribute    — [entity avatar] entity name · attribute name
  function renderSourceChipBody(src) {
    if (src.kind === 'relationship') {
      const rel = getRelationship(src.relationship_id)
      const explicit = rel?.name?.trim()
      let name = explicit
      if (!name && rel) {
        const joinIds = Array.from(new Set(
          ((rel.history?.participant_changes) || [])
            .filter((c) => c.action === 'join')
            .map((c) => c.entity_id),
        ))
        name = participantsFallbackLabel(
          joinIds.map((eid) => ({ entity_id: eid })),
          getEntity,
          3,
          rel,
        )
      }
      if (!name) name = 'Relationship'
      return <RelationshipLabelChip name={name} />
    }
    if (src.kind === 'attribute') {
      const ent = getEntity(src.entity_id)
      const colour = ent?.colour || '#888888'
      const attr = (ent?.attributes || []).find((a) => a.id === src.attribute_id)
      return (
        <span className="inline-flex items-center gap-1">
          <EntityAvatar entity={ent} size={avatarPx} />
          <span className={`${obsTextCls} truncate max-w-[100px]`} style={{ color: colour }}>
            {ent?.name || '(entity)'}
          </span>
          <span className={`${obsSepCls} text-zinc-500`}>·</span>
          <span className={`${obsTextCls} text-zinc-300 truncate max-w-[100px]`}>
            {attr?.name || '(attribute)'}
          </span>
        </span>
      )
    }
    return null
  }

  return (
    <div className="space-y-1" data-help-region="awareness-picker:picker">
      {!hideToggleRow && (
        <div className="flex items-center justify-between gap-2" data-help-region="awareness-picker:track_toggle">
          <label className="text-xs text-zinc-400 select-none whitespace-nowrap truncate min-w-0">{label}</label>
          <div className="flex items-center gap-1 flex-shrink-0">
            {(() => {
              // When the label is the personalised "Track who knows
              // <Name>" form, split it onto two stacked lines so long
              // entity / relationship / knowledge names don't get
              // clipped in narrow detail-panel headers — matches the
              // pattern KnownBySection uses for its standalone toggle.
              const stacked = typeof trackToggleLabel === 'string' && trackToggleLabel.startsWith('Track who knows ')
                ? trackToggleLabel.slice('Track who knows '.length)
                : null
              const baseCls = `text-[9px] select-none ${trackToggleDisabled ? 'text-zinc-600' : 'text-zinc-500'}`
              const titleAttr = trackToggleDisabled && trackToggleDisabledTitle ? trackToggleDisabledTitle : undefined
              if (stacked) {
                return (
                  <span className={`flex flex-col items-end leading-tight ${baseCls}`} title={titleAttr}>
                    <span className="whitespace-nowrap">Track who knows</span>
                    <span className="whitespace-nowrap">{stacked}</span>
                  </span>
                )
              }
              return (
                <span className={`${baseCls} whitespace-nowrap`} title={titleAttr}>
                  {trackToggleLabel}
                </span>
              )
            })()}
            <ToggleInput
              value={isTracking}
              onCommit={() => handleToggleTrack()}
              disabled={trackToggleDisabled}
              title={trackToggleDisabled && trackToggleDisabledTitle ? trackToggleDisabledTitle : undefined}
            />
          </div>
        </div>
      )}

      {/* Optional extra row directly below the track toggle.
          Surface-specific controls (e.g. Precision: binary vs full
          scale) render here when supplied by the calling panel. Only
          visible while tracking is on — when tracking is off the section
          is collapsed and surface-specific controls aren't relevant. */}
      {isTracking && extraTrackingRow}

      {isTracking && (
        <div className="bg-zinc-800/50 border border-zinc-700 rounded p-1.5 space-y-1.5">
          {mode === 'groups' ? (
            // ── Groups mode: one framed drop-target per level ───────────────
            <div className="space-y-1">
              {[...scale.levels].reverse().map((level) => {
                const style = awarenessLevelStyle(level)
                const observersAtLevel = dictKeys.filter((eid) => {
                  const lvl = entries[eid]
                  if (isBinaryScale && level === 3) {
                    return typeof lvl === 'number' && lvl > 0
                  }
                  return lvl === level
                })
                const sourcesAtLevel = sources
                  .map((s, i) => ({ source: s, idx: i }))
                  .filter(({ source }) => {
                    const g = groupLevelFor(source.level)
                    if (isBinaryScale && level === 3) return g === 3
                    return source.level === level
                  })
                const totalCount = observersAtLevel.length + sourcesAtLevel.length
                const levelLabelShort = scale.shortLabels?.[level] || scale.labels?.[level] || ''
                const levelLabelLong  = scale.labels?.[level] || ''
                const isDragOver = dragOverLevel === level
                const addOpen = addGroupLevel === level
                return (
                  <div
                    key={level}
                    onDragOver={(e) => handleGroupDragOver(e, level)}
                    onDragLeave={handleGroupDragLeave}
                    onDrop={(e) => handleGroupDrop(e, level)}
                    className={`rounded border overflow-hidden transition-colors ${style.border} ${isDragOver ? 'ring-2 ring-inset ring-white/40' : ''}`}
                  >
                    <div className={`flex items-center gap-1 px-1.5 py-1 text-[10px] leading-none ${style.bg} ${style.text}`}>
                      <span className="inline-flex items-center justify-center w-4 h-4 leading-none flex-shrink-0">{style.icon}</span>
                      <span className="italic truncate min-w-0" title={levelLabelLong}>{levelLabelShort}</span>
                      <span className="flex-1" />
                      <span className="text-[9px] opacity-80 flex-shrink-0">{totalCount}</span>
                      {!disabled && (
                        <button
                          type="button"
                          onClick={() => setAddGroupLevel(addOpen ? null : level)}
                          className="inline-flex items-center justify-center w-4 h-4 rounded text-[11px] leading-none bg-white/10 hover:bg-white/20 transition-colors flex-shrink-0"
                          title={addOpen ? 'Close picker' : 'Add at this level'}
                        >{addOpen ? '✕' : '✚'}</button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 items-center p-1.5 bg-zinc-900/40">
                      {totalCount === 0 && !addOpen && (
                        <span className="text-[9px] italic text-zinc-600 leading-tight">
                          use ✚ above to add an entity; drag chips between levels to move them
                        </span>
                      )}
                      {observersAtLevel.map((eid) => {
                        const entity = getEntity(eid)
                        if (!entity) {
                          return (
                            <span
                              key={eid}
                              draggable={!disabled}
                              onDragStart={(e) => handleDragStart(e, eid)}
                              className="inline-flex items-center gap-1 rounded px-1 py-0.5 border border-red-500/40 bg-red-500/10 text-[10px] text-red-300 cursor-grab"
                              title="Entity no longer exists"
                            >
                              (missing)
                              {!disabled && (
                                <button onClick={() => handleRemove(eid)} className="text-zinc-500 hover:text-red-400 leading-none">×</button>
                              )}
                            </span>
                          )
                        }
                        const colour    = entity.colour || '#888888'
                        return (
                          <span
                            key={eid}
                            draggable={!disabled}
                            onDragStart={(e) => handleDragStart(e, eid)}
                            className={`inline-flex items-center gap-1 rounded px-1 py-0.5 border border-zinc-700 bg-zinc-900/70 ${disabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
                            title={levelLabelLong}
                          >
                            <EntityAvatar entity={entity} size={avatarPx} />
                            <span className={`${obsTextCls} truncate max-w-[100px]`} style={{ color: colour }}>
                              {entity.name}
                            </span>
                            {!disabled && (
                              <button
                                onClick={() => handleRemove(eid)}
                                className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                                title="Remove from list"
                              >×</button>
                            )}
                          </span>
                        )
                      })}
                      {sourcesAtLevel.map(({ source, idx }) => (
                        <span
                          key={`source-${idx}`}
                          draggable={!disabled}
                          onDragStart={(e) => handleSourceDragStart(e, idx)}
                          className={`inline-flex items-center gap-1 rounded px-1 py-0.5 border border-zinc-700 bg-zinc-900/70 ${disabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
                          title={levelLabelLong}
                        >
                          {renderSourceChipBody(source)}
                          {!disabled && (
                            <button
                              onClick={() => handleRemoveSource(idx)}
                              className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                              title="Remove this source"
                            >×</button>
                          )}
                        </span>
                      ))}
                      {!disabled && addOpen && (
                        <ContributorPickerPopover
                          allEntities={allEntities}
                          allRelationships={relationships || []}
                          excludeEntityIds={excludeIds}
                          excludeRelationshipIds={excludeRelIds}
                          excludeAttributeKeys={excludeAttrKeys}
                          onPick={(pick) => { handlePickContributor(pick, level); setAddGroupLevel(null) }}
                          onClose={() => setAddGroupLevel(null)}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            // ── Pills mode (default): one chip row with per-chip level pills ─
            <>
              <div className="flex flex-wrap gap-1">
                {dictKeys.length === 0 && sources.length === 0 && (
                  <span className="text-[10px] text-zinc-600 italic">No contributors yet.</span>
                )}
                {dictKeys.map((eid) => {
                  const entity = getEntity(eid)
                  if (!entity) {
                    return (
                      <span
                        key={eid}
                        className="inline-flex items-center gap-1 rounded px-1 py-0.5 border border-red-500/40 bg-red-500/10 text-[10px] text-red-300"
                        title="Entity no longer exists"
                      >
                        (missing)
                        {!disabled && (
                          <button onClick={() => handleRemove(eid)} className="text-zinc-500 hover:text-red-400 leading-none">×</button>
                        )}
                      </span>
                    )
                  }
                  const colour    = entity.colour || '#888888'
                  const currentLevel = entries[eid]
                  return (
                    <span
                      key={eid}
                      data-help-region="awareness-picker:observer_row"
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 border border-zinc-700 bg-zinc-800/70"
                    >
                      <EntityAvatar entity={entity} size={avatarPx} />
                      <span className={`${obsTextCls} truncate max-w-[100px]`} style={{ color: colour }}>
                        {entity.name}
                      </span>
                      <AwarenessLevelSelector
                        scale={scale}
                        value={currentLevel}
                        onChange={(lvl) => handleSetLevel(eid, lvl)}
                        disabled={disabled}
                      />
                      {!disabled && (
                        <button
                          onClick={() => handleRemove(eid)}
                          className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                          title="Remove from list"
                        >×</button>
                      )}
                    </span>
                  )
                })}
                {sources.map((src, idx) => (
                  <span
                    key={`source-${idx}`}
                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 border border-zinc-700 bg-zinc-800/70"
                  >
                    {renderSourceChipBody(src)}
                    <AwarenessLevelSelector
                      scale={scale}
                      value={src.level}
                      onChange={(lvl) => handleSetSourceLevel(idx, lvl)}
                      disabled={disabled}
                    />
                    {!disabled && (
                      <button
                        onClick={() => handleRemoveSource(idx)}
                        className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                        title="Remove this source"
                      >×</button>
                    )}
                  </span>
                ))}
              </div>

              {!disabled && (
                <div>
                  {!pickerOpen ? (
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      data-help-region="awareness-picker:add_contributor"
                      className="text-[10px] text-accent-400 hover:text-accent-300"
                    >
                      + Add…
                    </button>
                  ) : (
                    <ContributorPickerPopover
                      allEntities={allEntities}
                      allRelationships={relationships || []}
                      excludeEntityIds={excludeIds}
                      excludeRelationshipIds={excludeRelIds}
                      excludeAttributeKeys={excludeAttrKeys}
                      onPick={(pick) => handlePickContributor(pick)}
                      onClose={() => setPickerOpen(false)}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
