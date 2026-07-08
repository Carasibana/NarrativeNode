import { useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import CropModal from './CropModal'

/**
 * Phase 2.5g — app-root singleton crop modal host.
 *
 * Mounted once at the App root. Reads `imageCropRequest` from uiStore;
 * when non-null, renders the shared `CropModal` against that request.
 * Call `useUiStore.getState().openImageCropModal({ imageSrc, onConfirm, title? })`
 * from anywhere to drive it. Cancel and post-confirm both clear the
 * request via `closeImageCropModal`.
 *
 * Pairs with the `useApplyImageToOpenTarget` hook and the apply-as-
 * avatar / drag-and-drop flows added in Phase 2.5g.
 *
 * `busy` is a host-local flag flipped on while the caller's
 * `onConfirm(blob)` promise is in flight. The modal greys its Confirm
 * button + shows a "Working…" label during that window so the writer
 * sees feedback for the upload / store-write round-trip.
 */
export default function ImageCropHost() {
  const req = useUiStore((s) => s.imageCropRequest)
  const closeModal = useUiStore((s) => s.closeImageCropModal)
  const [busy, setBusy] = useState(false)

  if (!req) return null

  async function handleConfirm(blob) {
    setBusy(true)
    try {
      await req.onConfirm(blob)
    } finally {
      setBusy(false)
      closeModal()
    }
  }

  function handleCancel() {
    if (busy) return
    closeModal()
  }

  return (
    <CropModal
      imageSrc={req.imageSrc}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      busy={busy}
      title={req.title || 'Crop Image'}
      confirmLabel={req.confirmLabel || 'Apply'}
      aspect={req.aspect ?? 1}
      output={req.output}
    />
  )
}
