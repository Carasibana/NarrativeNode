/**
 * Thanks tab. Credits screen listing every open-source library
 * NarrativeNode is built on, with name / license / link / short
 * note. Mirrors the "Credits and open-source libraries" section of
 * `README.md` (canonical source) plus a small handful of direct
 * dependencies the README's user-facing list omits.
 *
 * Each license label is clickable. Click fetches the upstream
 * license text from `GET /third-party-licenses/<file>.txt` (served
 * from the repo's `THIRD_PARTY_LICENSES/` directory) and renders it
 * in a modal. If the fetch fails (file missing, server down, etc.),
 * the modal switches to a fallback message with a direct link to
 * the upstream project page.
 *
 * Audit method:
 * - README.md "Credits and open-source libraries" table.
 * - `frontend/package.json` `dependencies` (TipTap and @uiw color
 *   pieces grouped under their parent packages).
 * - `backend/requirements.txt`.
 */
import { useEffect, useState } from 'react'
import axios from 'axios'

const FRONTEND = [
  { name: 'React',                  url: 'https://react.dev/',                            license: 'MIT', licenseFile: 'react.txt',                  note: 'UI framework' },
  { name: 'Vite',                   url: 'https://vitejs.dev/',                           license: 'MIT', licenseFile: 'vite.txt',                   note: 'Build tool and dev server' },
  { name: 'React Flow / xyflow',    url: 'https://reactflow.dev/',                        license: 'MIT', licenseFile: 'react-flow.txt',             note: 'Node-based canvas' },
  { name: 'TipTap',                 url: 'https://tiptap.dev/',                           license: 'MIT', licenseFile: 'tiptap.txt',                 note: 'Rich text editor (StarterKit + character-count, color, highlight, link, text-align, text-style, underline extensions)' },
  { name: 'react-easy-crop',        url: 'https://github.com/ValentinH/react-easy-crop',  license: 'MIT', licenseFile: 'react-easy-crop.txt',        note: 'Profile image cropping' },
  { name: 'Tailwind CSS',           url: 'https://tailwindcss.com/',                      license: 'MIT', licenseFile: 'tailwindcss.txt',            note: 'Utility-first CSS framework (with @tailwindcss/vite plugin)' },
  { name: 'Zustand',                url: 'https://github.com/pmndrs/zustand',             license: 'MIT', licenseFile: 'zustand.txt',                note: 'State management' },
  { name: 'Axios',                  url: 'https://axios-http.com/',                       license: 'MIT', licenseFile: 'axios.txt',                  note: 'HTTP client' },
  { name: 'Streamdown',             url: 'https://github.com/vercel/streamdown',          license: 'Apache-2.0', licenseFile: 'streamdown.txt',     note: 'Streaming-aware markdown rendering in the chat panel' },
  { name: '@streamdown/mermaid',    url: 'https://github.com/vercel/streamdown',          license: 'Apache-2.0', licenseFile: 'streamdown-mermaid.txt', note: 'Mermaid to inline SVG rendering in the chat panel' },
  { name: 'Mermaid',                url: 'https://mermaid.js.org/',                       license: 'MIT',        licenseFile: 'mermaid.txt',        note: 'Inline diagram rendering for AI-emitted character / plot / scene-flow visualisations' },
  { name: '@uiw/react-color',       url: 'https://github.com/uiwjs/react-color',          license: 'MIT', licenseFile: 'uiw-react-color.txt',        note: 'Colour picker components (saturation square, hue slider, editable input, color-convert)' },
  { name: 'marked',                 url: 'https://github.com/markedjs/marked',            license: 'MIT', licenseFile: 'marked.txt',                 note: 'Markdown to HTML conversion' },
  { name: 'DOMPurify',              url: 'https://github.com/cure53/DOMPurify',           license: 'Apache-2.0', licenseFile: 'dompurify.txt',       note: 'HTML sanitization for user-provided rich text (primary consumer: Novelcrafter prose import; defence-in-depth allow-list filter before HTML reaches TipTap)' },
]

const BACKEND = [
  { name: 'FastAPI',                url: 'https://fastapi.tiangolo.com/',                 license: 'MIT',         licenseFile: 'fastapi.txt',          note: 'Backend web framework' },
  { name: 'Pydantic',               url: 'https://docs.pydantic.dev/',                    license: 'MIT',         licenseFile: 'pydantic.txt',         note: 'Data validation and settings management' },
  { name: 'uvicorn',                url: 'https://uvicorn.dev/',                      license: 'BSD',         licenseFile: 'uvicorn.txt',          note: 'ASGI server' },
  { name: 'python-multipart',       url: 'https://github.com/Kludex/python-multipart',    license: 'Apache 2.0',  licenseFile: 'python-multipart.txt', note: 'Multipart form parsing for file uploads' },
  { name: 'aiofiles',               url: 'https://github.com/Tinche/aiofiles',            license: 'Apache 2.0',  licenseFile: 'aiofiles.txt',         note: 'Async file I/O' },
  { name: 'ReportLab',              url: 'https://www.reportlab.com/',                    license: 'BSD',         licenseFile: 'reportlab.txt',        note: 'PDF export' },
  { name: 'python-docx',            url: 'https://python-docx.readthedocs.io/',           license: 'MIT',         licenseFile: 'python-docx.txt',      note: '.docx export' },
  { name: 'keyring',                url: 'https://github.com/jaraco/keyring',             license: 'MIT',         licenseFile: 'keyring.txt',          note: 'OS keychain storage for AI provider API keys (Windows Credential Manager / macOS Keychain / Linux Secret Service)' },
  { name: 'markdown-it-py',         url: 'https://github.com/executablebooks/markdown-it-py', license: 'MIT',     licenseFile: 'markdown-it-py.txt',   note: 'Markdown to HTML for free-form export text fields (descriptions, attributes, notes, etc.); bundles mdurl (MIT)' },
]

function CreditRow({ row, onShowLicense }) {
  const { name, url, license, note } = row
  return (
    <div className="grid grid-cols-[160px_1fr_88px] gap-3 items-baseline py-1 text-xs">
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent-400 hover:text-accent-300 hover:underline truncate"
      >
        {name}
      </a>
      <span className="text-zinc-300 leading-snug">{note}</span>
      <button
        type="button"
        onClick={() => onShowLicense(row)}
        data-help-region="settings:thanks_license"
        className="text-[10px] text-accent-400/80 hover:text-accent-300 hover:underline font-mono text-right"
        title="Click to view the license text"
      >
        {license}
      </button>
    </div>
  )
}

function LicenseModal({ row, onClose }) {
  const [state, setState] = useState({ status: 'loading', text: '', error: null })

  useEffect(() => {
    if (!row) return
    let cancelled = false
    setState({ status: 'loading', text: '', error: null })
    axios
      .get(`/api/third-party-licenses/${row.licenseFile}`)
      .then((resp) => {
        if (cancelled) return
        setState({ status: 'ok', text: resp.data || '', error: null })
      })
      .catch((err) => {
        if (cancelled) return
        const msg =
          err?.response?.status === 404
            ? 'License file not found.'
            : (err?.message || 'Failed to load license.')
        setState({ status: 'error', text: '', error: msg })
      })
    return () => { cancelled = true }
  }, [row])

  // Esc to close.
  useEffect(() => {
    if (!row) return undefined
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [row, onClose])

  if (!row) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[680px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{row.name}</h3>
            <p className="text-[10px] text-zinc-500 font-mono">{row.license}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 text-lg leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-800"
            title="Close (Escape)"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {state.status === 'loading' && (
            <p className="text-xs text-zinc-500 italic">Loading license text...</p>
          )}
          {state.status === 'ok' && (
            <pre className="text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-words leading-relaxed">{state.text}</pre>
          )}
          {state.status === 'error' && (
            <div className="text-xs text-zinc-300 space-y-2">
              <p>License file not available locally.</p>
              <p className="text-zinc-500">{state.error}</p>
              <p>
                You can read the license on the project&apos;s homepage:&nbsp;
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent-400 hover:text-accent-300 hover:underline break-all"
                >
                  {row.url}
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ThanksTab() {
  const [licenseRow, setLicenseRow] = useState(null)

  return (
    <div className="px-6 py-5 overflow-y-auto h-full">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Thanks</h2>
      <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
        NarrativeNode is built on the work of many talented open-source
        contributors. A heartfelt thank-you to the authors and maintainers
        of every library below; this app couldn&apos;t exist without them.
        Click any license label to see the full text.
      </p>

      <section className="mb-6">
        <h3 className="text-sm font-semibold text-zinc-200 mb-2 uppercase tracking-wider text-[11px]">Frontend</h3>
        <ul className="border-t border-zinc-700">
          {FRONTEND.map((row) => (
            <li key={row.name} className="border-b border-zinc-800/60">
              <CreditRow row={row} onShowLicense={setLicenseRow} />
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-6">
        <h3 className="text-sm font-semibold text-zinc-200 mb-2 uppercase tracking-wider text-[11px]">Backend</h3>
        <ul className="border-t border-zinc-700">
          {BACKEND.map((row) => (
            <li key={row.name} className="border-b border-zinc-800/60">
              <CreditRow row={row} onShowLicense={setLicenseRow} />
            </li>
          ))}
        </ul>
      </section>

      <p className="text-[10px] text-zinc-500 italic leading-relaxed">
        The libraries above have their own dependencies too, like lxml, pillow, and
        charset-normalizer, plus many others, and those dependencies have dependencies
        of their own all the way down. They&apos;re not listed individually here, but they&apos;re
        still appreciated! They ride along with the parent packages above and inherit their
        license attributions.
      </p>

      <section className="mt-8 mb-6">
        <h3 className="text-sm font-semibold text-zinc-200 mb-2 uppercase tracking-wider text-[11px]">Personal</h3>
        <div className="border-t border-zinc-700 pt-3">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Thanks Nova. Yes, YOU. Thank you for humouring my craziness and being willing
            to give your time, energy, and feedback on all of my projects. 💜
          </p>
        </div>
      </section>

      <LicenseModal row={licenseRow} onClose={() => setLicenseRow(null)} />
    </div>
  )
}
