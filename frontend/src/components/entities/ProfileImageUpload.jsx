import { useRef, useState } from 'react'
import axios from 'axios'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import CropModal from '../ui/CropModal'

/** Placeholder square shown when no profile image is set. */
function ImagePlaceholder({ entityType, entityColour, size = 64 }) {
  const icon = TYPE_ICONS[entityType] || '?'
  return (
    <div
      className="flex items-center justify-center rounded-sm flex-shrink-0 select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: entityColour ? entityColour + '22' : '#88888822',
        border: `2px solid ${entityColour || '#888888'}`,
        fontSize: size * 0.4,
      }}
    >
      {icon}
    </div>
  )
}

/**
 * Profile image upload component.
 *
 * Props:
 *   fileRef       — current profile_image_ref value (e.g. "assets/profile_abc.jpg") or null
 *   entityType    — entity type string for placeholder icon
 *   entityColour  — entity colour hex for placeholder background
 *   onChange      — called with new file_ref string after successful upload
 *   readOnly      — if true, only shows the current image/placeholder
 *   size          — image dimensions in px (default 64)
 *   compact       — if true, hides label text beside the image (only shows the hoverable image)
 */
export default function ProfileImageUpload({ fileRef, entityType, entityColour, onChange, readOnly, size = 64, compact = false }) {
  const fileInputRef = useRef(null)
  const [rawSrc, setRawSrc] = useState(null)
  const [showCrop, setShowCrop] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = (ev) => {
      setRawSrc(ev.target.result)
      setShowCrop(true)
      setError(null)
    }
    reader.readAsDataURL(file)
  }

  async function handleCropConfirm(blob) {
    if (!blob) return
    setUploading(true)
    try {
      const uniqueName = `profile_${crypto.randomUUID()}.jpg`
      const form = new FormData()
      form.append('file', blob, uniqueName)
      const { data } = await axios.post('/api/project/assets/upload', form)
      onChange(data.file_ref)
      setShowCrop(false)
      setRawSrc(null)
    } catch {
      setError('Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  function handleCancelCrop() {
    setShowCrop(false)
    setRawSrc(null)
  }

  const assetName = fileRef ? fileRef.replace(/^assets\//, '') : null
  const imgSrc = assetName ? `/api/project/assets/${assetName}` : null

  const sizeClass = `rounded-sm object-cover`
  const sizeStyle = { width: size, height: size }

  return (
    <div data-help-region="detail-panel:header" className="flex items-center gap-3">
      {/* Image / placeholder */}
      <div className="relative flex-shrink-0">
        {imgSrc ? (
          <img
            src={imgSrc}
            alt="Profile"
            className={sizeClass}
            style={{ ...sizeStyle, border: `2px solid ${entityColour || '#888888'}` }}
          />
        ) : (
          <ImagePlaceholder entityType={entityType} entityColour={entityColour} size={size} />
        )}

        {/* Upload overlay button */}
        {!readOnly && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/50 opacity-0 hover:opacity-100 transition-opacity text-white font-medium"
            style={{ fontSize: Math.max(9, size * 0.17) }}
            title="Upload profile image"
          >
            {imgSrc ? 'Change' : 'Upload'}
          </button>
        )}
      </div>

      {/* Label + upload button (hidden in compact mode) */}
      {!readOnly && !compact && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">Profile Image</span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-accent-400 hover:text-accent-300 text-left"
          >
            {imgSrc ? 'Change image…' : 'Upload image…'}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelect}
      />

      {showCrop && rawSrc && (
        <CropModal
          imageSrc={rawSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleCancelCrop}
          busy={uploading}
          title="Crop Profile Image"
        />
      )}
    </div>
  )
}
