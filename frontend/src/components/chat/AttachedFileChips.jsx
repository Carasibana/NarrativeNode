import { useUiStore } from '../../store/uiStore'
import { usePreviewStore } from '../../store/previewStore'
import { useAccentColor } from '../../utils/povConstants'

// Stable empty-array reference returned by the selector when this
// thread has no attachments yet. Returning a fresh `[]` from a
// Zustand selector triggers an infinite re-render loop because
// every call produces a new reference → store thinks the value
// changed → re-render → new reference → loop. The fix is to hoist a
// single stable reference to module scope, as below.
const EMPTY_ATTACHMENTS = []

/**
 * Phase 2.5e — Attached-file chip row.
 *
 * Sits directly below the active context strip in the chat panel.
 * Renders ONLY when at least one file is attached for the current
 * thread — when the chip list is empty, this component returns
 * `null` and the row collapses out of the layout (no empty
 * placeholder).
 *
 * Chip layout, left → right:
 *   [paperclip icon] [filename (truncated)] [size] [× remove]
 *
 * Visual treatment: green outline + low-opacity green background
 * (emerald palette) — distinct from the scene-context / pinned-
 * item chips on the row above so the writer can tell at a glance
 * which row is what.
 *
 * Image chips have a body-click handler that opens the picked
 * image in an inline lightbox overlay (a simple full-screen modal
 * showing the source bitmap via its blob URL). Non-image kinds
 * have no body-click action for now — clicking does nothing.
 */
export default function AttachedFileChips({ threadId }) {
  const attachments = useUiStore((s) => s.chatAttachmentStaging?.[threadId] || EMPTY_ATTACHMENTS)
  const removeAttachment = useUiStore((s) => s.removeChatAttachment)
  const togglePreview = usePreviewStore((s) => s.togglePreview)
  // Story accent colour for the preview-panel badge chip. Resolves
  // chain-aware via the existing hook so the badge stays in sync
  // when the writer changes the active accent.
  const accent = useAccentColor() || '#7c3aed'
  if (!threadId || attachments.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 flex-wrap" data-help-region="conversation:attached_files">
      {attachments.map((a) => (
        <FileChip
          key={a.sessionId}
          attachment={a}
          onPreview={() => {
            if (a.kind === 'image' && a.blobUrl) {
              // Route through the existing Media Preview Panel
              // pipeline. The panel accepts a source identified by
              // either `fileRef` (project assets) or `url` (direct
              // — used here for the transient blob URL of a picked
              // file). `kind: 'image'` is set explicitly because the
              // blob URL has no recognisable extension for the
              // kind heuristic to read from.
              togglePreview({
                type: 'chat_attachment',
                sessionId: a.sessionId,
                url: a.blobUrl,
                kind: 'image',
                title: a.name,
                size: a.size,
                colour: accent,
              })
            }
          }}
          onRemove={() => removeAttachment(threadId, a.sessionId)}
        />
      ))}
    </div>
  )
}


// Single chip. Emerald palette; left paperclip icon, truncated
// filename, formatted size, × remove. Image kind makes the body
// (everything except the ×) clickable for the lightbox preview.
function FileChip({ attachment, onPreview, onRemove }) {
  const { name, size, kind } = attachment
  const isImage = kind === 'image'
  const titleBits = [name, _formatBytes(size)]
  if (kind === 'text')   titleBits.push('Text — will be inlined into the next user message.')
  if (kind === 'image')  titleBits.push('Image — click to preview.')
  if (kind === 'file')   titleBits.push('File attachment — included with the next message.')
  const title = titleBits.join(' · ')
  return (
    <span
      className="inline-flex items-center gap-1 border border-emerald-700/60 bg-emerald-900/25 rounded-full overflow-hidden"
      title={title}
    >
      <button
        type="button"
        onClick={isImage ? onPreview : undefined}
        aria-label={isImage ? `Preview ${name}` : name}
        className={`flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-[10px] text-emerald-100 ${
          isImage ? 'hover:bg-emerald-800/40 cursor-pointer transition-colors' : 'cursor-default'
        }`}
        disabled={!isImage}
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300 flex-shrink-0">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <span className="truncate max-w-[160px]">{name}</span>
        <span className="text-[9px] text-emerald-300/80 flex-shrink-0">{_formatBytes(size)}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${name}`}
        aria-label={`Remove ${name}`}
        className="text-emerald-300 hover:text-white hover:bg-emerald-700/60 w-4 h-4 mr-0.5 flex items-center justify-center text-[10px] leading-none rounded-full"
      >
        ✕
      </button>
    </span>
  )
}


// Bytes → "1.4 KB" / "2.3 MB" / etc. Uses 1024 as the divisor
// (binary KiB) because that matches the file-size convention most
// OSes show in their file pickers.
function _formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
}
