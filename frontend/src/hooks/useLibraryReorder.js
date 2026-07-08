/**
 * Phase 2.8 — shared drag-to-reorder state machine for library
 * sections (entities, knowledge, relationships, preset lists,
 * reference notes, context cues).
 *
 * Pattern: each row carries a small ⠿ grip handle that becomes a
 * drag source on its own (separate from any whole-row chat-attach
 * drag the row already exposes). Dragging the grip writes nothing
 * to `dataTransfer` and only tracks the source index in local
 * state; the drop is resolved when `onDrop` fires on a target row
 * or the trailing hit-area below the last row. The visual cue is
 * a 2px accent-coloured line painted on the target row's TOP edge
 * for in-between drops, or BOTTOM edge of the last row for drop-
 * at-end (the trailing zone itself stays invisible — its job is
 * only to capture the cursor).
 *
 * The hook returns:
 *   - dragIdx / dragOverIdx (raw state, for tests / debug)
 *   - gripProps(idx) — spread on the ⠿ grip span; sets
 *     `draggable + onDragStart + onDragEnd + onClick stopProp`.
 *   - rowDropProps(idx) — spread on each row's outer container;
 *     sets `onDragOver + onDrop` for between-row drops.
 *   - trailingZoneProps — spread on a slim invisible div after
 *     the last row to enable drop-at-end.
 *   - indicatorStyle(idx, isLast) — returns a style object
 *     adding the top-line or bottom-line `boxShadow`/`borderTop`
 *     when this row is the active drop target.
 *
 * `onCommit(srcIdx, dstIdx)` is supplied by the caller and is
 * responsible for translating the displayed indices into a new
 * ordered id list and persisting it via the appropriate store
 * action. `srcIdx === dstIdx` is filtered by the hook (no-op).
 * `dstIdx === total` signals drop-at-end.
 */
import { useCallback, useState } from 'react'
import { useAccentColor } from '../utils/povConstants'


export default function useLibraryReorder({ total, enabled = true, onCommit }) {
  const [dragIdx, setDragIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)
  const accentColor = useAccentColor()

  const handleDragStart = useCallback((idx) => (e) => {
    e.stopPropagation()
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((idx) => (e) => {
    e.preventDefault()
    setDragOverIdx((cur) => (cur === idx ? cur : idx))
  }, [])

  const handleDrop = useCallback((idx) => (e) => {
    e.preventDefault()
    const src = dragIdx
    setDragIdx(null)
    setDragOverIdx(null)
    if (src != null && src !== idx) onCommit?.(src, idx)
  }, [dragIdx, onCommit])

  const handleDragEnd = useCallback(() => {
    setDragIdx(null)
    setDragOverIdx(null)
  }, [])

  const gripProps = useCallback((idx) => (enabled ? {
    draggable: true,
    onDragStart: handleDragStart(idx),
    onDragEnd: handleDragEnd,
    onClick: (e) => e.stopPropagation(),
  } : {}), [enabled, handleDragStart, handleDragEnd])

  const rowDropProps = useCallback((idx) => (enabled && dragIdx != null ? {
    onDragOver: handleDragOver(idx),
    onDrop: handleDrop(idx),
  } : {}), [enabled, dragIdx, handleDragOver, handleDrop])

  const trailingZoneProps = enabled && dragIdx != null && total > 0 ? {
    onDragOver: handleDragOver(total),
    onDrop: handleDrop(total),
  } : null

  const indicatorStyle = useCallback((idx, isLast) => {
    if (!enabled || dragIdx == null) return null
    if (dragOverIdx === idx && dragIdx !== idx) {
      return { boxShadow: `inset 0 2px 0 0 ${accentColor}` }
    }
    if (isLast && dragOverIdx === total && dragIdx !== idx) {
      return { boxShadow: `inset 0 -2px 0 0 ${accentColor}` }
    }
    return null
  }, [enabled, dragIdx, dragOverIdx, accentColor, total])

  return {
    dragIdx,
    dragOverIdx,
    accentColor,
    gripProps,
    rowDropProps,
    trailingZoneProps,
    indicatorStyle,
  }
}
