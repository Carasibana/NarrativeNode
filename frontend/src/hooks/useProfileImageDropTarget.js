import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useUiStore } from '../store/uiStore'
import { useProjectStore } from '../store/projectStore'
import { classifyProfileImageDrag, readProfileImageDrop } from '../utils/profileImageDrag'

/**
 * Phase 2.5g — drop-target wiring for an avatar surface.
 *
 * Pass `{ kind, id, anchorNodeId }` identifying which object's
 * avatar this site is and which chain anchor the write should land
 * at. `kind` is 'entity' or 'knowledge'; the hook routes through
 * the matching `setEntityProfileImageAtAnchor` /
 * `setKnowledgeProfileImageAtAnchor` projectStore action.
 *
 * Returns:
 *   - dropHandlers: bundle of `{ onDragEnter, onDragOver, onDragLeave,
 *     onDrop }` to spread onto the drop-target element.
 *   - isDragOver: boolean — true while a valid drop is hovering this
 *     target. Caller renders its own visual highlight using this.
 *
 * The handlers stop event propagation on every drag-related event
 * AND `preventDefault` where needed. This is deliberate: the canvas
 * pane has its own drop handler that creates Reference Media nodes
 * from OS-dragged image files. Without `stopPropagation`, a drop on
 * a node avatar would ALSO spawn a Reference Media node next to it.
 * Stopping the bubble keeps the avatar drop scoped to the avatar.
 *
 * `enabled = false` makes the handlers no-ops without unmounting
 * the wrapper. Useful when the caller has a target id but the
 * resolved anchor is null (e.g. a knowledge with no source_event).
 */
export function useProfileImageDropTarget({ kind, id, anchorNodeId, enabled = true }) {
  const [isDragOver, setIsDragOver] = useState(false)

  // Tracks whether this target has currently incremented the global
  // `avatarDropOverCount`. We need to balance increments / decrements
  // exactly even when dragenter / dragleave fire multiple times due to
  // child element transitions; the boolean acts as a debouncer so we
  // only touch the counter at the actual outer enter / leave.
  const incrementedRef = useRef(false)

  // Safety net: if the drop target unmounts (e.g. the writer switches
  // scenes mid-drag and the chip disappears) while we have a pending
  // increment, decrement it on the way out so the canvas overlay
  // doesn't get stuck suppressed.
  useEffect(() => () => {
    if (incrementedRef.current) {
      incrementedRef.current = false
      useUiStore.getState().decAvatarDropOver()
    }
  }, [])

  const onDragEnter = useCallback((e) => {
    if (!enabled || !id || !anchorNodeId) return
    if (!classifyProfileImageDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
    if (!incrementedRef.current) {
      incrementedRef.current = true
      useUiStore.getState().incAvatarDropOver()
    }
  }, [enabled, id, anchorNodeId])

  const onDragOver = useCallback((e) => {
    if (!enabled || !id || !anchorNodeId) return
    if (!classifyProfileImageDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [enabled, id, anchorNodeId])

  const onDragLeave = useCallback((e) => {
    if (!enabled || !id || !anchorNodeId) return
    // Only react to drags we actually care about so we don't paint
    // hover state during a non-image drag passing over.
    if (!classifyProfileImageDrag(e)) return
    e.stopPropagation()
    setIsDragOver(false)
    if (incrementedRef.current) {
      incrementedRef.current = false
      useUiStore.getState().decAvatarDropOver()
    }
  }, [enabled, id, anchorNodeId])

  const onDrop = useCallback(async (e) => {
    if (!enabled || !id || !anchorNodeId) return
    const dragKind = classifyProfileImageDrag(e)
    if (!dragKind) return
    // Stop propagation BEFORE any async work so the canvas-wide
    // OS-file drop handler (which spawns Reference Media nodes)
    // doesn't also fire for this drop.
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    // Balance the increment we logged on dragenter so the canvas
    // overlay (which reads avatarDropOverCount > 0 as a suppression
    // signal) clears once this drop is handled. Canvas.jsx ALSO
    // listens to document-level `drop` in capture phase as a
    // backstop in case the increment / decrement go out of balance.
    if (incrementedRef.current) {
      incrementedRef.current = false
      useUiStore.getState().decAvatarDropOver()
    }
    let dataUrl = null
    try {
      dataUrl = await readProfileImageDrop(e)
    } catch (err) {
      console.error('Failed to read dropped image:', err)
      return
    }
    if (!dataUrl) return
    // Open the shared crop modal with this drop's image. On
    // confirm, upload + dispatch to the chain-aware store action.
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
          if (kind === 'entity') {
            ps.setEntityProfileImageAtAnchor(id, anchorNodeId, fileRef)
          } else if (kind === 'knowledge') {
            ps.setKnowledgeProfileImageAtAnchor(id, anchorNodeId, fileRef)
          }
        } catch (err) {
          console.error('Avatar drop upload failed:', err)
        }
      },
    })
  }, [enabled, kind, id, anchorNodeId])

  return {
    isDragOver,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
