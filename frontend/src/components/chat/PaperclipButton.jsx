import { useRef } from 'react'
import { acceptStringForCapabilities, validateAttachment, modelAcceptsNonTextAttachments } from '../../utils/attachmentTypes'

/**
 * Phase 2.5e — Paperclip attachment button.
 *
 * Lives left of the Send button in the chat composer. Click opens
 * a native file picker whose `accept` attribute is derived from
 * the active model's capabilities (text always, image only when
 * the model supports vision, PDF only when the model accepts the
 * `file` modality). On selection each file is validated against
 * those same capabilities — accepted files raise `onAttach`,
 * rejected files raise `onReject` with a user-facing reason
 * string the caller can surface as an inline error.
 *
 * The button itself is enabled whenever a profile is present —
 * text-file attachment always works regardless of model. The
 * `disabled` prop accepts the same gate the Send button uses
 * (no active profile / model) so the picker doesn't open into
 * a dead conversation.
 *
 * Visual treatment matches the other input-toolbar buttons in
 * the chat panel: small square button, zinc background, accent
 * border on hover.
 */
export default function PaperclipButton({ capabilities, onAttach, onReject, disabled = false, dataHelpRegion }) {
  const inputRef = useRef(null)
  const accept = acceptStringForCapabilities(capabilities)
  const hasNonText = modelAcceptsNonTextAttachments(capabilities)

  // Tooltip lists what the active model accepts so the writer
  // knows before they pick. Always mentions text; conditionally
  // adds images and PDFs.
  const acceptLabel = (() => {
    if (!capabilities?.resolved && !hasNonText) {
      return 'Attach a file. The active model\'s capabilities haven\'t been verified — text files are guaranteed to work; images / PDFs may be rejected by the upstream.'
    }
    const inputMods = capabilities?.input_modalities || []
    const bits = ['text files']
    if (inputMods.includes('image')) bits.push('images')
    if (inputMods.includes('file'))  bits.push('PDFs')
    return `Attach a file. This model accepts: ${bits.join(', ')}.`
  })()

  function handleClick() {
    if (disabled) return
    inputRef.current?.click()
  }

  function handleChange(e) {
    const files = Array.from(e.target.files || [])
    for (const file of files) {
      const result = validateAttachment(file, capabilities)
      if (result.ok) {
        onAttach?.(file, result.kind)
      } else {
        onReject?.(file, result.reason)
      }
    }
    // Reset so re-picking the same file fires `change` again.
    if (e.target) e.target.value = ''
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        data-help-region={dataHelpRegion}
        title={acceptLabel}
        aria-label="Attach a file"
        className={`flex items-center justify-center w-5 h-5 rounded border transition-colors flex-shrink-0 ${
          disabled
            ? 'border-zinc-800 bg-zinc-900/30 text-zinc-700 cursor-not-allowed'
            : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
        }`}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  )
}
