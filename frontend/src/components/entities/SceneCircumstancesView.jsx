import { useState, useMemo, useCallback, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { confirm } from '../../store/dialogStore'
import { computeSceneEffectiveCircumstancePool, getEntityNarrativeChain, computeEffectiveState } from '../../utils/narrativeChain'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { IntensityBadge, INTENSITY_LABELS } from '../ui/IntensityBadge'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import CircumstanceMotivatorForm from './CircumstanceMotivatorForm'
import { useAccentColor } from '../../utils/povConstants'
import { orderedCMEntriesFromScene } from '../../utils/cmSubchipOrder'

/**
 * Phase 1.22e — Scene Detail Panel "Circumstances" sub-tab.
 *
 * Two sections:
 *
 *   1. "At the scene level" — editable list of `Scene.circumstances`,
 *      the parallel `Circumstance` data type that lives directly on
 *      the SceneNode (NOT entity attributes). NOT chain-tracked.
 *      Edits commit immediately via projectStore actions (each
 *      action takes its own _snapshot for undo).
 *
 *   2. "Per entity" — read-only summary per entity present at this
 *      scene of their carried circumstance / motivator attributes,
 *      chain-resolved at this scene anchor via the existing
 *      `computeSceneEffectiveCircumstancePool` helper. Click-through
 *      to the entity's Detail Panel Attributes tab for editing.
 *      Entities with nothing carried still appear with "(none)" so
 *      the writer can see who has been considered.
 */
export default function SceneCircumstancesView({ nodeId }) {
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const setStoreSubTab = useUiStore((s) => s.setDetailPanelActiveSubTab)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const addSceneCircumstance    = useProjectStore((s) => s.addSceneCircumstance)
  const updateSceneCircumstance = useProjectStore((s) => s.updateSceneCircumstance)
  const removeSceneCircumstance = useProjectStore((s) => s.removeSceneCircumstance)
  const reorderEntityCMs        = useProjectStore((s) => s.reorderEntityCMs)

  // Drag-to-reorder state for circumstance / motivator sub-chips at the
  // scene-level Per-entity section. The `draggedCMRef` ref carries the
  // source bucket synchronously so the very first `dragover` event
  // (which can fire before a `setState`-driven re-render lands) can
  // call `preventDefault()` and let the browser proceed with the drag.
  // The `draggedCM` state mirrors the ref for visual rendering only
  // (drop-target highlight, opacity dim, trailing drop zone visibility).
  const draggedCMRef = useRef(null)                       // {entityId, kind, id} | null
  const [draggedCM, setDraggedCM] = useState(null)        // {entityId, kind, id} | null
  const [dragOverCM, setDragOverCM] = useState(null)      // {entityId, kind, id|'__end__'} | null

  const startCMDrag = useCallback((entityId, kind, id, e) => {
    e.stopPropagation()
    const payload = { entityId, kind, id }
    draggedCMRef.current = payload
    setDraggedCM(payload)
    e.dataTransfer.effectAllowed = 'move'
    // Mark the payload so unrelated drop targets (entity-chip / library /
    // knowledge / relationship drags) ignore it.
    e.dataTransfer.setData('application/nnz-cm-subchip-id', id)
  }, [])

  const overCMRow = useCallback((entityId, kind, id, e) => {
    const src = draggedCMRef.current
    if (!src) return
    if (src.entityId !== entityId || src.kind !== kind) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverCM((prev) => {
      if (prev && prev.entityId === entityId && prev.kind === kind && prev.id === id) return prev
      return { entityId, kind, id }
    })
  }, [])

  const dropOnCMRow = useCallback((entityId, kind, targetId, currentOrderedIds, e) => {
    const src = draggedCMRef.current
    if (!src) return
    if (src.entityId !== entityId || src.kind !== kind) return
    e.preventDefault()
    e.stopPropagation()
    const fromIdx = currentOrderedIds.indexOf(src.id)
    const cleanup = () => {
      draggedCMRef.current = null
      setDraggedCM(null)
      setDragOverCM(null)
    }
    if (fromIdx === -1) { cleanup(); return }
    const newOrder = [...currentOrderedIds]
    newOrder.splice(fromIdx, 1)
    if (targetId === '__end__') {
      newOrder.push(src.id)
    } else if (targetId !== src.id) {
      const toIdx = currentOrderedIds.indexOf(targetId)
      if (toIdx === -1) { cleanup(); return }
      const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx
      newOrder.splice(insertIdx, 0, src.id)
    } else {
      // Dropped onto self — no-op.
      cleanup(); return
    }
    reorderEntityCMs(nodeId, entityId, kind, newOrder)
    cleanup()
  }, [reorderEntityCMs, nodeId])

  const endCMDrag = useCallback(() => {
    draggedCMRef.current = null
    setDraggedCM(null)
    setDragOverCM(null)
  }, [])
  // Phase 1.22h — workspace accent for temporary chevron strokes +
  // dashed row borders, anchoring temporary entries visually to the
  // scene rather than the C/M tier.
  const sceneAccentColour = useAccentColor()

  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const allEntities = useMemo(() => [
    ...characters, ...locations, ...items, ...factions, ...customs,
  ], [characters, locations, items, factions, customs])

  const node = nodes.find((n) => n.id === nodeId)
  const sceneData = node?.data || {}
  const sceneShape = useMemo(() => ({ ...sceneData, id: nodeId }), [sceneData, nodeId])
  const pool = useMemo(
    () => computeSceneEffectiveCircumstancePool(sceneShape, allEntities, nodes, edges),
    [sceneShape, allEntities, nodes, edges],
  )

  // ── Add form state (scene-level) ──────────────────────────────
  const [showAdd, setShowAdd] = useState(false)
  const [newCirc, setNewCirc] = useState({ name: '', description: '', intensity: null })
  const [newError, setNewError] = useState(null)
  function resetNewForm() {
    setNewCirc({ name: '', description: '', intensity: null })
    setNewError(null)
  }
  function confirmAdd() {
    addSceneCircumstance(nodeId, {
      name: (newCirc.name || '').trim() || null,
      description: (newCirc.description || '').trim(),
      intensity: newCirc.intensity ?? null,
    })
    setShowAdd(false)
    resetNewForm()
  }

  // ── Edit-in-place state (scene-level) ─────────────────────────
  const [editingId, setEditingId] = useState(null)
  const [editing, setEditing] = useState({ name: '', description: '', intensity: null })
  const [editingError, setEditingError] = useState(null)
  function openEdit(c) {
    setEditingId(c.id)
    setEditing({
      name: c.name || '',
      description: c.description || '',
      intensity: c.intensity ?? null,
    })
    setEditingError(null)
  }
  function cancelEdit() {
    setEditingId(null)
    setEditingError(null)
  }
  function confirmEdit() {
    if (!editingId) return
    updateSceneCircumstance(nodeId, editingId, {
      name: (editing.name || '').trim() || null,
      description: (editing.description || '').trim(),
      intensity: editing.intensity ?? null,
    })
    setEditingId(null)
    setEditingError(null)
  }
  async function handleRemove(c) {
    const result = await confirm({
      title: 'Remove circumstance',
      message: `Remove "${c.name || c.description || '(unnamed)'}" from this scene?`,
      buttons: [
        { label: 'Remove', value: 'remove', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result === 'remove') removeSceneCircumstance(nodeId, c.id)
  }

  function navigateToEntityChip(entityId, openTab = 'attributes') {
    const chain = getEntityNarrativeChain(entityId, nodes, edges)
    const idx = chain.findIndex((n) => n.id === nodeId)
    setStoreSubTab(openTab)
    setDetailPanel('entityChip', nodeId, entityId, idx)
  }

  if (!node) return <div className="p-3 text-xs text-zinc-600 italic">No scene selected.</div>

  return (
    <div className="px-3 py-2 space-y-4 overflow-y-auto" data-help-region="detail-scene:circumstances_body">
      {/* ── At the scene level ──────────────────────────────── */}
      <section data-help-region="detail-scene:circumstances_scene_level">
        <div className="flex items-center justify-between gap-1 px-1 py-1 mb-1 border-b border-zinc-800">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400">At the scene level</span>
          <button
            type="button"
            data-help-region="detail-scene:circumstances_add"
            onClick={() => { setShowAdd(true); resetNewForm() }}
            className="flex items-center gap-0.5 px-1.5 h-5 rounded border text-[10px] leading-none flex-shrink-0 transition-colors border-zinc-700 bg-zinc-800 text-accent-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300"
            title="Add a scene-level circumstance"
          >
            <span>+ Add</span>
            <CircumstanceTypeBadge size={11} />
          </button>
        </div>

        {showAdd && (
          <CircumstanceMotivatorForm
            attributeType="circumstance"
            value={newCirc}
            setValue={setNewCirc}
            error={newError}
            setError={setNewError}
            onConfirm={confirmAdd}
            onCancel={() => { setShowAdd(false); resetNewForm() }}
            confirmLabel="Add"
            headerLabel="New Scene Circumstance"
          />
        )}

        {pool.sceneLevel.length === 0 && !showAdd && (
          <p className="text-[10px] text-zinc-600 italic px-1 py-1">No scene-level circumstances yet.</p>
        )}

        <div className="space-y-1">
          {pool.sceneLevel.map((c) => (
            <div key={c.id} className="border border-zinc-800 rounded">
              <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800/50">
                <CircumstanceTypeBadge size={14} />
                <span className="text-[11px] text-zinc-200 flex-1 truncate">
                  {c.name || (c.description ? (c.description.length > 28 ? c.description.slice(0, 28) + '…' : c.description) : '(unnamed)')}
                </span>
                <button
                  onClick={() => handleRemove(c)}
                  className="text-[10px] text-zinc-600 hover:text-red-400"
                  title="Remove from scene"
                >
                  ×
                </button>
              </div>
              <div className="px-2 py-1.5">
                {editingId === c.id ? (
                  <CircumstanceMotivatorForm
                    attributeType="circumstance"
                    value={editing}
                    setValue={setEditing}
                    error={editingError}
                    setError={setEditingError}
                    onConfirm={confirmEdit}
                    onCancel={cancelEdit}
                    confirmLabel="Save"
                    headerLabel="Edit Scene Circumstance"
                  />
                ) : (
                  <div
                    className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                    onClick={() => openEdit(c)}
                    title="Click to edit"
                  >
                    <IntensityBadge level={c.intensity ?? null} size={20} />
                    <div className="flex-1 min-w-0">
                      {c.description
                        ? <span className="text-zinc-300 whitespace-pre-wrap break-words">{c.description}</span>
                        : null}
                      {c.intensity != null && (
                        <span className="text-[9px] text-zinc-500 ml-1">({INTENSITY_LABELS[c.intensity]})</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Per entity (read-only rollup) ───────────────────── */}
      <section data-help-region="detail-scene:circumstances_per_entity">
        <div className="flex items-center justify-between gap-1 px-1 py-1 mb-1 border-b border-zinc-800">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400">Per entity</span>
        </div>
        {pool.perEntity.length === 0 ? (
          <p className="text-[10px] text-zinc-600 italic px-1 py-1">No entities at this scene.</p>
        ) : (
          <div className="space-y-2">
            {pool.perEntity.map((bucketEntry) => {
              const entity = allEntities.find((e) => e.id === bucketEntry.entityId)
              if (!entity) return null
              // Chain-aware: resolve the entity's name / colour /
              // profile_image at THIS scene anchor via the chain walker
              // rather than reading entity baseline. The header sits on
              // a chain anchor (this scene), so an upstream rename /
              // recolour / profile-change should surface here.
              const eff = computeEffectiveState(entity, nodes, edges, nodeId) || {}
              const displayName = eff.name ?? entity.name ?? ''
              const colour = eff.colour ?? entity.colour ?? '#888888'
              const profileRef = eff.profile_image_ref ?? entity.profile_image_ref
              const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
              // Phase 1.22h — temporaries for this entity at this scene.
              // Scene-side data, not chain-tracked; the scene IS the
              // origin for its own temporaries list.
              const allTemp = (node?.data?.entity_temporary_circumstances || [])
              const tempForEntity = allTemp.filter((e) => e.entity_id === entity.id)
              const tempCircs = tempForEntity.filter((e) => e.attribute_type === 'circumstance')
              const tempMots  = tempForEntity.filter((e) => e.attribute_type === 'motivator')
              // Phase 1.26 — combined per-kind display lists, drag-reorderable
              // and ordered via the per-(scene, entity, kind) `cm_chip_order`
              // map. Temporaries and chain-resolved attributes share one
              // list each so the writer can mix them freely; rows still
              // visually distinguish temporary entries (dashed border +
              // accent colour) from chain entries (plain). Auto-sort
              // (descending intensity, then UUID) applies when no manual
              // order is set; manual mode appends new entries to the end.
              const taggedCircs = [
                ...tempCircs.map((e) => ({ ...e, _isTemp: true })),
                ...bucketEntry.circumstances.map((e) => ({ ...e, _isTemp: false })),
              ]
              const taggedMots = [
                ...tempMots.map((e) => ({ ...e, _isTemp: true })),
                ...bucketEntry.motivators.map((e) => ({ ...e, _isTemp: false })),
              ]
              const orderedCircs = orderedCMEntriesFromScene(taggedCircs, sceneData, entity.id, 'circumstance')
              const orderedMots  = orderedCMEntriesFromScene(taggedMots,  sceneData, entity.id, 'motivator')
              const orderedCircIds = orderedCircs.map((e) => e.id)
              const orderedMotIds  = orderedMots.map((e) => e.id)
              const hasAny = orderedCircs.length > 0 || orderedMots.length > 0
              return (
                <div key={bucketEntry.entityId} className="border border-zinc-800 rounded">
                  <button
                    type="button"
                    onClick={() => navigateToEntityChip(bucketEntry.entityId, 'attributes')}
                    className="w-full flex items-center gap-2 px-2 py-1 border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors text-left"
                    title="Open this entity's Attributes tab at this scene"
                  >
                    {assetName ? (
                      <img
                        src={`/api/project/assets/${assetName}`}
                        alt=""
                        className="rounded-sm object-cover flex-shrink-0"
                        style={{ width: 18, height: 18, border: `1.5px solid ${colour}` }}
                      />
                    ) : (
                      <span
                        className="rounded-sm flex items-center justify-center flex-shrink-0 text-[10px]"
                        style={{ width: 18, height: 18, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
                      >
                        {TYPE_ICONS[entity.type] || '?'}
                      </span>
                    )}
                    <span className="text-[11px] flex-1 truncate" style={{ color: colour }}>{displayName || '(unnamed)'}</span>
                    <span className="text-[9px] text-zinc-500">→</span>
                  </button>
                  <div className="px-2 py-1.5 space-y-1.5">
                    {!hasAny && (
                      <p className="text-[10px] text-zinc-600 italic">(none)</p>
                    )}
                    {orderedCircs.map((attr) => {
                      const isTemp = !!attr._isTemp
                      const isDragged = draggedCM?.entityId === entity.id && draggedCM?.kind === 'circumstance' && draggedCM?.id === attr.id
                      const isDropTarget = dragOverCM?.entityId === entity.id && dragOverCM?.kind === 'circumstance' && dragOverCM?.id === attr.id
                      return (
                        <div key={attr.id}>
                          {/* Insertion line indicator — same affordance the
                              scene-node entity-chip drag uses to show
                              where the dragged row will land. Rendered
                              above the row so the line appears between
                              the previous row and this one. */}
                          <div style={{ height: 0, borderTop: isDropTarget ? `2px solid ${sceneAccentColour}` : '2px solid transparent', marginBottom: isDropTarget ? 2 : 0 }} />
                        <div
                          draggable
                          onDragStart={(e) => startCMDrag(entity.id, 'circumstance', attr.id, e)}
                          onDragOver={(e) => overCMRow(entity.id, 'circumstance', attr.id, e)}
                          onDrop={(e) => dropOnCMRow(entity.id, 'circumstance', attr.id, orderedCircIds, e)}
                          onDragEnd={endCMDrag}
                          className={`flex items-start gap-1.5 text-[11px] rounded px-1.5 py-1 cursor-grab active:cursor-grabbing ${isDragged ? 'opacity-40' : ''}`}
                          style={isTemp ? { border: `1px dashed ${sceneAccentColour}` } : undefined}
                        >
                          <CircumstanceTypeBadge size={13} temporary={isTemp} temporaryColour={isTemp ? sceneAccentColour : undefined} />
                          <IntensityBadge level={attr.intensity ?? null} size={16} temporary={isTemp} temporaryColour={isTemp ? sceneAccentColour : undefined} />
                          <div className="flex-1 min-w-0">
                            <div className="text-zinc-200 truncate">
                              {attr.name || attr.description || '(unnamed)'}
                            </div>
                            {attr.description && attr.name && (
                              <div className="text-[10px] text-zinc-400 whitespace-pre-wrap break-words">{attr.description}</div>
                            )}
                            {attr.intensity != null && (
                              <span className="text-[9px] text-zinc-500">({INTENSITY_LABELS[attr.intensity]})</span>
                            )}
                          </div>
                        </div>
                        </div>
                      )
                    })}
                    {/* Trailing drop zone for the circumstance list — only visible while dragging within this kind. Hosts an insertion line indicator at the end of the list. */}
                    {draggedCM?.entityId === entity.id && draggedCM?.kind === 'circumstance' && (
                      <div
                        onDragOver={(e) => overCMRow(entity.id, 'circumstance', '__end__', e)}
                        onDrop={(e) => dropOnCMRow(entity.id, 'circumstance', '__end__', orderedCircIds, e)}
                        onDragEnd={endCMDrag}
                        className="h-3 rounded"
                        style={{ borderTop: dragOverCM?.id === '__end__' && dragOverCM?.kind === 'circumstance' ? `2px solid ${sceneAccentColour}` : '2px solid transparent' }}
                      />
                    )}
                    {orderedMots.map((attr) => {
                      const isTemp = !!attr._isTemp
                      const isDragged = draggedCM?.entityId === entity.id && draggedCM?.kind === 'motivator' && draggedCM?.id === attr.id
                      const isDropTarget = dragOverCM?.entityId === entity.id && dragOverCM?.kind === 'motivator' && dragOverCM?.id === attr.id
                      return (
                        <div key={attr.id}>
                          <div style={{ height: 0, borderTop: isDropTarget ? `2px solid ${sceneAccentColour}` : '2px solid transparent', marginBottom: isDropTarget ? 2 : 0 }} />
                        <div
                          key={attr.id}
                          draggable
                          onDragStart={(e) => startCMDrag(entity.id, 'motivator', attr.id, e)}
                          onDragOver={(e) => overCMRow(entity.id, 'motivator', attr.id, e)}
                          onDrop={(e) => dropOnCMRow(entity.id, 'motivator', attr.id, orderedMotIds, e)}
                          onDragEnd={endCMDrag}
                          className={`flex items-start gap-1.5 text-[11px] rounded px-1.5 py-1 cursor-grab active:cursor-grabbing ${isDragged ? 'opacity-40' : ''}`}
                          style={isTemp ? { border: `1px dashed ${sceneAccentColour}` } : undefined}
                        >
                          <MotivatorTypeBadge size={13} temporary={isTemp} temporaryColour={isTemp ? sceneAccentColour : undefined} />
                          <IntensityBadge level={attr.intensity ?? null} size={16} temporary={isTemp} temporaryColour={isTemp ? sceneAccentColour : undefined} />
                          <div className="flex-1 min-w-0">
                            <div className="text-zinc-200 truncate">
                              {attr.name || attr.description || '(unnamed)'}
                            </div>
                            {attr.description && attr.name && (
                              <div className="text-[10px] text-zinc-400 whitespace-pre-wrap break-words">{attr.description}</div>
                            )}
                            {attr.intensity != null && (
                              <span className="text-[9px] text-zinc-500">({INTENSITY_LABELS[attr.intensity]})</span>
                            )}
                          </div>
                      </div>
                      </div>
                      )
                    })}
                    {/* Trailing drop zone for the motivator list — only visible while dragging within this kind. Hosts an insertion line indicator at the end of the list. */}
                    {draggedCM?.entityId === entity.id && draggedCM?.kind === 'motivator' && (
                      <div
                        onDragOver={(e) => overCMRow(entity.id, 'motivator', '__end__', e)}
                        onDrop={(e) => dropOnCMRow(entity.id, 'motivator', '__end__', orderedMotIds, e)}
                        onDragEnd={endCMDrag}
                        className="h-3 rounded"
                        style={{ borderTop: dragOverCM?.id === '__end__' && dragOverCM?.kind === 'motivator' ? `2px solid ${sceneAccentColour}` : '2px solid transparent' }}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
