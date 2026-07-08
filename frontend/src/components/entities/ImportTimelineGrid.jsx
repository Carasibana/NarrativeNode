/**
 * ImportTimelineGrid — Phase 1.12b Track 4 (refactored for 1.12c Track 1).
 *
 * The timeline grid render for the Import dialog. Since Phase 1.12c
 * Track 1 (v0.1.12.41), the actual render tree lives in the shared
 * `TimelineGridView` under `components/timeline/`. This file is a thin
 * wrapper that:
 *
 *   1. Passes the import-specific visual state through:
 *        - `importPicks` (enables the pick-ring rendering)
 *        - `selectedRowIds` + `setSelectedRowIds` (enables drag /
 *          Ctrl / Shift row selection + the select-all "Entity (N)"
 *          header)
 *        - `previewedEntityId` + `setPreviewedEntityId` (enables the
 *          accent-500/60 "previewed row" bottom border)
 *   2. Wires the import-specific click handlers:
 *        - Scene / origin / final dot → write pick into importPicks
 *        - Modifier dot → write modifier pick into importPicks
 *        - Column header → batch-write pick for every selected row
 *        - Chapter / act header → same as clicking last-scene-in-span
 *          column header for every selected row
 *        - Row identity cell X → call the remove-entity prop
 *   3. Passes import-specific tooltip strings that reference the
 *      currently-selected row count + the commit-pick mental model
 *      ("Pick Scene N for 3 selected").
 *   4. Sets `headersRequireSelection=true` so column / chapter / act
 *      headers disable when zero rows are selected — you can't batch-
 *      pick without a target.
 *
 * The Phase 1.12c Timeline Navigator wraps `TimelineGridView`
 * independently with navigation-specific state + handlers + tooltips.
 * See [TimelineGridView.jsx](../timeline/TimelineGridView.jsx) for
 * the shared component.
 */

import { useCallback, useMemo } from 'react'
import TimelineGridView from '../timeline/TimelineGridView'

/**
 * Build a pick payload from a column click, for stashing in the
 * `importPicks` map. Returned shape matches the backend's
 * `ImportStatePoint` dataclass.
 */
function makePickForColumn(col) {
  if (col._kind === 'origin') return { kind: 'origin' }
  if (col._kind === 'final')  return { kind: 'final' }
  return { kind: 'scene', scene_id: col.id }
}

/** Build a pick payload for a modifier dot click. */
function makePickForModifier(modifier_node_id) {
  return { kind: 'modifier', modifier_node_id }
}

/**
 * Knowledge rows have no `modifier` state-point — their pick shape
 * collapses to one of `origin` / `scene` / `final`. Mirrors
 * `ImportKnowledgeStatePoint` on the backend.
 */
function makeKnowledgePickForColumn(col) {
  if (col._kind === 'origin') return { kind: 'origin' }
  if (col._kind === 'final')  return { kind: 'final' }
  return { kind: 'scene', scene_id: col.id }
}

// ── Component ───────────────────────────────────────────────────────

export default function ImportTimelineGrid({
  preview,
  gridEntities,
  gridKnowledges = [],
  selectedRowIds,
  setSelectedRowIds,
  importPicks,
  setImportPicks,
  knowledgePicks = new Map(),
  setKnowledgePicks = null,
  onRemoveEntity,
  onRemoveKnowledge = null,
  previewedEntityId,
  setPreviewedEntityId,
}) {
  // Knowledge ids the shared TimelineGridView is seeing as rows — used
  // by the click handlers to route writes to the right pick map.
  const knowledgeIdSet = useMemo(
    () => new Set(gridKnowledges.map((k) => k.id)),
    [gridKnowledges],
  )

  // Cast Knowledge rows into the shape `TimelineGridView` expects
  // (mirrors `ImportEntityRow`): same id, `type='knowledge'`,
  // `preset_list_ids_used=[]`, and dots normalised to include the
  // missing-on-Knowledge `is_modifier=false` / `modifier_node_id=null`
  // fields so the shared dot-render path doesn't need to branch.
  const knowledgeRowsAsEntities = useMemo(() => {
    return gridKnowledges.map((k) => ({
      id: k.id,
      name: k.name,
      type: 'knowledge',
      colour: k.colour,
      description: k.description || '',
      profile_image_data_uri: k.profile_image_data_uri || null,
      final_name: k.final_name,
      final_colour: k.final_colour,
      final_profile_image_data_uri: k.final_profile_image_data_uri,
      preset_list_ids_used: [],
      dots: (k.dots || []).map((d) => ({
        column_id: d.column_id,
        is_modifier: false,
        modifier_node_id: null,
        chain_index: d.chain_index,
        canvas_x: d.canvas_x,
        effective_name: d.effective_name,
        effective_colour: d.effective_colour,
        effective_profile_image_data_uri: d.effective_profile_image_data_uri,
      })),
    }))
  }, [gridKnowledges])

  // Combined row list — entities first (in their existing order), then
  // Knowledge rows. The shared grid renders them as a single contiguous
  // list of rows sharing the same scene columns / chapter markers.
  const combinedRows = useMemo(
    () => [...gridEntities, ...knowledgeRowsAsEntities],
    [gridEntities, knowledgeRowsAsEntities],
  )

  // Combined pick map — passed to the shared view for pick-ring
  // rendering. Knowledge ids and entity ids are guaranteed-unique
  // (UUIDs), so union semantics are safe.
  const combinedPicks = useMemo(() => {
    const out = new Map(importPicks)
    for (const [kid, pick] of knowledgePicks) out.set(kid, pick)
    return out
  }, [importPicks, knowledgePicks])
  // ── Click handlers that translate user intent into pick writes ──

  const handleDotClick = useCallback((rowId, col) => {
    if (knowledgeIdSet.has(rowId)) {
      setKnowledgePicks?.((prev) => {
        const next = new Map(prev)
        next.set(rowId, makeKnowledgePickForColumn(col))
        return next
      })
    } else {
      setImportPicks((prev) => {
        const next = new Map(prev)
        next.set(rowId, makePickForColumn(col))
        return next
      })
    }
    setPreviewedEntityId?.(rowId)
  }, [knowledgeIdSet, setImportPicks, setKnowledgePicks, setPreviewedEntityId])

  const handleModifierDotClick = useCallback((rowId, modifierNodeId) => {
    // Knowledge rows have no modifier dots — guard so the handler is
    // a no-op if one ever fires from a synthesised row.
    if (knowledgeIdSet.has(rowId)) return
    setImportPicks((prev) => {
      const next = new Map(prev)
      next.set(rowId, makePickForModifier(modifierNodeId))
      return next
    })
    setPreviewedEntityId?.(rowId)
  }, [knowledgeIdSet, setImportPicks, setPreviewedEntityId])

  const handleColumnHeaderClick = useCallback((col) => {
    if (!selectedRowIds || selectedRowIds.size === 0) return
    // Split selection into entity ids vs knowledge ids and write to
    // the matching pick map.
    const entityIds = []
    const knowledgeIds = []
    for (const id of selectedRowIds) {
      if (knowledgeIdSet.has(id)) knowledgeIds.push(id)
      else entityIds.push(id)
    }
    if (entityIds.length) {
      const pick = makePickForColumn(col)
      setImportPicks((prev) => {
        const next = new Map(prev)
        for (const id of entityIds) next.set(id, pick)
        return next
      })
    }
    if (knowledgeIds.length && setKnowledgePicks) {
      const pick = makeKnowledgePickForColumn(col)
      setKnowledgePicks((prev) => {
        const next = new Map(prev)
        for (const id of knowledgeIds) next.set(id, pick)
        return next
      })
    }
  }, [selectedRowIds, knowledgeIdSet, setImportPicks, setKnowledgePicks])

  // Route row-remove (the × on each identity cell) to the correct
  // remover based on whether the id is in the Knowledge set.
  const handleRemoveRow = useCallback((rowId) => {
    if (knowledgeIdSet.has(rowId)) {
      onRemoveKnowledge?.(rowId)
    } else {
      onRemoveEntity?.(rowId)
    }
  }, [knowledgeIdSet, onRemoveEntity, onRemoveKnowledge])

  const handleChapterOrActHeaderClick = useCallback((_chapterOrActId, lastColumnId) => {
    // Resolve the last column in the chapter / act span to a pick by
    // reusing the column-header handler. This gives chapter / act
    // headers the same "batch-pick for selected rows" semantics as
    // clicking the last scene column header directly.
    if (!selectedRowIds || selectedRowIds.size === 0) return
    // The shared view passes us the last_column_id directly — look
    // it up in the preview's columns (or use the bookend sentinels).
    let col = null
    if (lastColumnId === '__origin__') col = { _kind: 'origin', id: '__origin__' }
    else if (lastColumnId === '__final__') col = { _kind: 'final', id: '__final__' }
    else {
      const match = (preview?.columns || []).find((c) => c.id === lastColumnId)
      if (match) col = { ...match, _kind: 'scene' }
    }
    if (!col) return
    handleColumnHeaderClick(col)
  }, [preview, selectedRowIds, handleColumnHeaderClick])

  // ── Tooltip strings ─────────────────────────────────────────────
  // Import-specific: reference the currently-selected row count and
  // the commit-pick mental model. The shared view falls back to
  // title-only tooltips when these aren't supplied, so if we ever
  // drop them things still render sensibly.

  const columnHeaderTooltip = useCallback((col, selectedCount) => {
    if (selectedCount === 0) return `${col.title} — select at least one row first`
    return `Pick ${col.title} for ${selectedCount} selected`
  }, [])

  const chapterHeaderTooltip = useCallback((ch, selectedCount) => {
    const label = ch.title || `Chapter ${ch.number}`
    if (selectedCount === 0) return `${label} — select at least one row first`
    return `Pick end-of-chapter state for ${selectedCount} selected`
  }, [])

  const actHeaderTooltip = useCallback((act, selectedCount) => {
    const label = act.title || `Act ${act.number}`
    if (selectedCount === 0) return `${label} — select at least one row first`
    return `Pick end-of-act state for ${selectedCount} selected`
  }, [])

  return (
    <TimelineGridView
      preview={preview}
      gridEntities={combinedRows}
      selectedRowIds={selectedRowIds}
      setSelectedRowIds={setSelectedRowIds}
      previewedEntityId={previewedEntityId}
      setPreviewedEntityId={setPreviewedEntityId}
      importPicks={combinedPicks}
      onRemoveEntity={handleRemoveRow}
      onDotClick={handleDotClick}
      onModifierDotClick={handleModifierDotClick}
      onColumnHeaderClick={handleColumnHeaderClick}
      onChapterHeaderClick={handleChapterOrActHeaderClick}
      onActHeaderClick={handleChapterOrActHeaderClick}
      columnHeaderTooltip={columnHeaderTooltip}
      chapterHeaderTooltip={chapterHeaderTooltip}
      actHeaderTooltip={actHeaderTooltip}
      headersRequireSelection
    />
  )
}
