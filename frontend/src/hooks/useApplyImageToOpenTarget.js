import { useCallback } from 'react'
import axios from 'axios'
import { useUiStore } from '../store/uiStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { useProjectStore } from '../store/projectStore'

/**
 * Phase 2.5g — drives the "apply this image as an avatar" affordance.
 *
 * Inspects the left-sidebar Detail Panel state and resolves what's
 * currently open:
 *   - An entity on a canvas anchor (origin / modifier / scene chip),
 *     via `detailPanelMode` + `detailPanelEntityId` + `detailPanelNodeId`.
 *   - A library-only entity selection (no canvas anchor), via
 *     `activeSelection.kind === 'entity'`. Treated as the entity's
 *     origin anchor when applying.
 *   - A knowledge open in the panel via
 *     `activeSelection.kind === 'knowledge'`. Anchor is
 *     `activeSelection.atNodeId` when set, otherwise the knowledge's
 *     own origin (its `source_event.node_id`).
 *
 * Returns:
 *   - canApply: boolean — whether there's a valid target.
 *   - targetLabel: string — short human-readable label for the button
 *     tooltip ("Apply as avatar for Mina Murray (at this scene)").
 *     Empty when canApply is false.
 *   - applyImageDataUrl: (dataUrl) => Promise<void> — opens the
 *     shared crop modal with the supplied image source. On confirm,
 *     uploads the cropped 256×256 JPEG to `/api/project/assets/upload`,
 *     then routes the resulting `file_ref` through the matching
 *     chain-aware store action.
 *
 * The returned function captures the target + anchor it resolved at
 * call time, so a target switch mid-crop doesn't redirect the apply
 * to the new target.
 */
export function useApplyImageToOpenTarget() {
  const detailPanelMode = useUiStore((s) => s.detailPanelMode)
  const detailPanelEntityId = useUiStore((s) => s.detailPanelEntityId)
  const detailPanelNodeId = useUiStore((s) => s.detailPanelNodeId)
  const activeSelection = useUiStore((s) => s.activeSelection)

  // Resolve the current target. Entity-canvas open beats library
  // open when both are set (shouldn't normally happen — setDetailPanel
  // clears activeSelection — but be defensive).
  let target = null
  if (detailPanelEntityId && (detailPanelMode === 'entityNode' || detailPanelMode === 'entityChip')) {
    target = { kind: 'entity', id: detailPanelEntityId, anchorNodeId: detailPanelNodeId || null }
  } else if (activeSelection?.kind === 'entity' && activeSelection.id) {
    target = { kind: 'entity', id: activeSelection.id, anchorNodeId: activeSelection.atNodeId || null }
  } else if (activeSelection?.kind === 'knowledge' && activeSelection.id) {
    target = { kind: 'knowledge', id: activeSelection.id, anchorNodeId: activeSelection.atNodeId || null }
  }

  // Look up the named subject + figure out whether the resolved
  // anchor IS that subject's origin. Used to build the tooltip and
  // (for entities with no anchor at all) to fill the anchor with the
  // entity's origin node id so the apply still routes correctly.
  let canApply = false
  let targetLabel = ''
  let resolvedAnchorNodeId = null
  let isAtOrigin = false

  if (target?.kind === 'entity') {
    const es = useEntitiesStore.getState()
    const entity = (es.getEntityById && es.getEntityById(target.id))
      || [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
        .find((e) => e.id === target.id)
    if (entity) {
      const nodes = useProjectStore.getState().nodes || []
      const originNode = nodes.find(
        (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entity.id,
      )
      // Fall back to the entity's own origin node when no canvas
      // anchor is supplied (library-only selection).
      resolvedAnchorNodeId = target.anchorNodeId || originNode?.id || null
      isAtOrigin = resolvedAnchorNodeId && originNode && resolvedAnchorNodeId === originNode.id
      if (resolvedAnchorNodeId) {
        canApply = true
        const label = entity.name || 'this entity'
        targetLabel = `Apply as avatar for ${label} (${isAtOrigin ? 'origin' : 'at this scene'})`
      }
    }
  } else if (target?.kind === 'knowledge') {
    const k = (useProjectStore.getState().knowledges || []).find((kk) => kk.id === target.id)
    if (k) {
      resolvedAnchorNodeId = target.anchorNodeId || k.source_event?.node_id || null
      isAtOrigin = resolvedAnchorNodeId && k.source_event?.node_id && resolvedAnchorNodeId === k.source_event.node_id
      if (resolvedAnchorNodeId) {
        canApply = true
        const label = k.name || 'this knowledge'
        targetLabel = `Apply as avatar for ${label} (${isAtOrigin ? 'origin' : 'at this scene'})`
      }
    }
  }

  // Capture in stable closure so a target switch during cropping
  // doesn't redirect the eventual write.
  const capturedTargetKind = target?.kind || null
  const capturedTargetId = target?.id || null
  const capturedAnchor = resolvedAnchorNodeId

  const applyImageDataUrl = useCallback((dataUrl) => {
    if (!capturedTargetKind || !capturedTargetId || !capturedAnchor) return Promise.resolve()
    if (!dataUrl) return Promise.resolve()
    return new Promise((resolve) => {
      useUiStore.getState().openImageCropModal({
        imageSrc: dataUrl,
        title: 'Crop Profile Image',
        confirmLabel: 'Apply',
        onConfirm: async (blob) => {
          try {
            const uniqueName = `profile_${crypto.randomUUID()}.jpg`
            const form = new FormData()
            form.append('file', blob, uniqueName)
            const { data } = await axios.post('/api/project/assets/upload', form)
            const fileRef = data?.file_ref
            if (!fileRef) return
            const ps = useProjectStore.getState()
            if (capturedTargetKind === 'entity') {
              ps.setEntityProfileImageAtAnchor(capturedTargetId, capturedAnchor, fileRef)
            } else if (capturedTargetKind === 'knowledge') {
              ps.setKnowledgeProfileImageAtAnchor(capturedTargetId, capturedAnchor, fileRef)
            }
          } catch (err) {
            console.error('Apply-as-avatar upload failed:', err)
          } finally {
            resolve()
          }
        },
      })
    })
  }, [capturedTargetKind, capturedTargetId, capturedAnchor])

  return { canApply, targetLabel, applyImageDataUrl }
}
