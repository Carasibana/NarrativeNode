/**
 * Phase 2.5e — File attachment helpers.
 *
 * Shared utilities for the paperclip button and (later) the
 * drag-and-drop drop zone:
 *   - Map a model's `input_modalities` array to the `accept`
 *     attribute string for an `<input type="file">`.
 *   - Validate a picked File against the same capability set
 *     before staging.
 *   - Classify a File as `text` / `image` / `file` for the wire
 *     encoder to route on.
 *
 * Modality vocabulary mirrors what the adapters surface (OpenRouter
 * modality enum): `text`, `image`, `file`. (Audio / video are
 * deferred to a later phase.)
 *
 * Text-like files are universal — they're inlined as plain text in
 * the user message, so they're allowed regardless of the model's
 * `input_modalities`. The only thing that gates them is the picker
 * `accept` filter, which always includes the text extensions.
 */

// Image extensions Anthropic / OpenAI / OpenRouter / LM Studio
// vision-capable models all accept. Stays narrow on purpose —
// .webp / .gif support is universal among the four, while more
// exotic formats (.heic, .avif) are inconsistent.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// File-modality extensions. Anything in this list requires the
// active model to expose `file` in its `input_modalities` —
// `validateAttachment` enforces that gate before staging. The
// wire encoder ships these as the adapter's native `type:"file"`
// content part with the MIME embedded in the data URL.
// OpenAI extracts text from these formats automatically per the
// File Inputs guide (https://developers.openai.com/api/docs/guides/file-inputs);
// OpenRouter passes them through or invokes its file-parser
// plugin internally. LM Studio's native `/api/v1/chat` doesn't
// expose `file` in `input_modalities`, so the picker gate
// blocks them there.
const FILE_EXTENSIONS = ['.pdf', '.docx']
const FILE_MIMES = [
  'application/pdf',
  // .docx — Office Open XML wordprocessing. The browser usually
  // reports this exact MIME on a picked .docx; the extension
  // match in `classifyFile` is the primary classifier (more
  // reliable across browsers) and this MIME is the fallback
  // for files dragged from sources that strip the filename.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

// Always-allowed text extensions. These get inlined into the
// user message as text and don't need any model capability.
// Source-code extensions are included so writers can attach a
// rough scene draft, a beat sheet, an outline, etc.
const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown',
  '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.js', '.jsx', '.ts', '.tsx',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.html', '.css', '.scss', '.xml',
  '.toml', '.ini', '.cfg', '.env',
  '.sh', '.bash', '.ps1',
]

// MIME-type prefix that always counts as text-like (handles
// every `text/*` plus a few common application types files of
// .json / .xml etc. show up as).
const TEXT_MIME_PREFIXES = ['text/']
const TEXT_MIME_EXACT = [
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
]


/**
 * Build the `accept` attribute string for a file picker based on
 * the active model's capabilities. Always includes text extensions;
 * adds image extensions when `image` is in `input_modalities`; adds
 * `.pdf` when `file` is in `input_modalities`. Returns a single
 * comma-separated string the `<input>` element consumes directly.
 */
export function acceptStringForCapabilities(capabilities) {
  const inputMods = capabilities?.input_modalities || []
  const parts = [...TEXT_EXTENSIONS]
  if (inputMods.includes('image')) parts.push(...IMAGE_EXTENSIONS)
  if (inputMods.includes('file'))  parts.push(...FILE_EXTENSIONS)
  return parts.join(',')
}


/**
 * Classify a File as `text` / `image` / `file`. Extension match
 * comes first because the browser's MIME guess is unreliable for
 * uncommon extensions; MIME type is the fallback. Returns null
 * when the file matches none of our categories (the validator
 * uses that as the rejection signal).
 */
export function classifyFile(file) {
  if (!file) return null
  const name = (file.name || '').toLowerCase()
  const mime = (file.type || '').toLowerCase()
  // Text extension match (covers .md / .json / source code, etc.).
  if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'text'
  if (IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'image'
  if (FILE_EXTENSIONS.some((ext) => name.endsWith(ext)))  return 'file'
  // MIME fallback when the extension didn't match (e.g. a file
  // named without a recognised suffix).
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return 'text'
  if (TEXT_MIME_EXACT.includes(mime)) return 'text'
  if (IMAGE_MIMES.includes(mime)) return 'image'
  if (FILE_MIMES.includes(mime))  return 'file'
  return null
}


/**
 * Validate a File against a model's capabilities. Returns:
 *   { ok: true,  kind }                              when accepted
 *   { ok: false, kind, reason }                      when rejected
 *
 * `kind` is the classification result; `reason` is a short
 * user-facing explanation suitable for an inline error chip.
 * Use the `ok` flag for gating; surface `reason` when ok is false.
 */
export function validateAttachment(file, capabilities) {
  const kind = classifyFile(file)
  if (kind === null) {
    return {
      ok: false,
      kind: null,
      reason: `Unrecognised file type for "${file?.name || 'this file'}". Allowed: text (.txt, .md, etc.), images, or PDFs.`,
    }
  }
  if (kind === 'text') {
    // Text-like is always allowed regardless of model capability.
    return { ok: true, kind }
  }
  const inputMods = capabilities?.input_modalities || []
  if (kind === 'image') {
    if (inputMods.includes('image')) return { ok: true, kind }
    return {
      ok: false,
      kind,
      reason: `This model can't accept images. Switch to a vision-capable model or attach the file as text.`,
    }
  }
  if (kind === 'file') {
    if (inputMods.includes('file')) return { ok: true, kind }
    return {
      ok: false,
      kind,
      reason: `This model can't accept PDF or Office documents (.pdf, .docx, .pptx, .xlsx). Switch to a file-capable model (OpenAI / OpenRouter) or attach the content as plain text.`,
    }
  }
  return { ok: false, kind, reason: 'File type not supported.' }
}


/**
 * "Does this model support attaching ANYTHING beyond text?" Used
 * by the paperclip button to decide whether to render disabled
 * with an explanatory tooltip. Text-only is technically supported
 * (text inlining always works), but writers reaching for a
 * paperclip button usually mean a non-text file; gating disabled
 * on "text-only" matches that intent.
 */
export function modelAcceptsNonTextAttachments(capabilities) {
  const inputMods = capabilities?.input_modalities || []
  return inputMods.includes('image') || inputMods.includes('file')
}


/**
 * Build the attachment record stored in `uiStore.chatAttachmentStaging`
 * from a picked File + its classified kind. Centralises the record
 * shape so the paperclip picker and the drag-and-drop drop zone
 * produce identical entries.
 *
 * For image files the blob URL is created here so the preview-panel
 * click handler has a stable URL to hand to `openPreview` /
 * `togglePreview` later. The store's `removeChatAttachment` /
 * `clearChatAttachments` actions revoke it.
 */
export function makeAttachmentRecord(file, kind) {
  const blobUrl = kind === 'image' && typeof URL !== 'undefined' && URL.createObjectURL
    ? URL.createObjectURL(file)
    : ''
  return {
    name: file.name,
    size: file.size,
    // Browser-reported `file.type` is often empty for `.md` and
    // many source-code extensions on Chromium/Firefox. Falling
    // through to an empty string on the wire makes the encoder
    // ship `application/octet-stream` in the data-URL prefix,
    // which OpenAI/OpenRouter then reject with HTTP 400 for
    // text-purpose `type:"file"` content parts. Derive from the
    // extension when the browser comes up empty so the wire ships
    // a sensible text MIME (e.g. `text/markdown` for `.md`).
    mimeType: file.type || _mimeFromExtension(file.name, kind) || '',
    kind,
    file,
    blobUrl,
  }
}


// Extension → MIME table for the cases browsers commonly miss.
// Only consulted when `file.type` is empty. Mirrors the extension
// sets in TEXT_EXTENSIONS / IMAGE_EXTENSIONS / FILE_EXTENSIONS at
// the top of this module. For unrecognised extensions we return
// '' so the caller can pick its own default.
const _EXT_TO_MIME = {
  // Text / markup
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.env': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  // Source code — most browsers report empty for these; standard
  // IANA registrations are inconsistent so we use `text/plain` as
  // the safest universal fallback. Upstreams handle these the same
  // way regardless (text extract for OpenAI; inline for adapters
  // without a `type:"file"` shape).
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.ps1': 'application/x-powershell',
  // Office / binary file kinds (mostly redundant — browsers fill
  // these in correctly — but kept for the rare drag-from-archive
  // edge case where `file.type` is empty).
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Images — same redundancy note.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function _mimeFromExtension(name, kind) {
  if (typeof name !== 'string' || !name) return ''
  const lower = name.toLowerCase()
  for (const ext of Object.keys(_EXT_TO_MIME)) {
    if (lower.endsWith(ext)) return _EXT_TO_MIME[ext]
  }
  // Generic text fallback — better than `application/octet-stream`
  // for files the picker classified as text-kind.
  if (kind === 'text') return 'text/plain'
  return ''
}
