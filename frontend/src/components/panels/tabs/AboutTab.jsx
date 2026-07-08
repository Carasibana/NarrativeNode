/**
 * About tab — shows the NarrativeNode logo, current version, a brief
 * tagline, links to the public GitHub repo and the project licence,
 * plus the credit lines.
 *
 * Version fetched via GET /api/version on mount (which returns the
 * backend's `PROGRAM_VERSION` — single source of truth). Loading
 * state is a neutral placeholder so a brief network delay doesn't
 * render a blank spot in the layout.
 *
 * Licence text fetched on demand from GET /api/license when the
 * writer clicks the "View licence" link, and rendered as plain text
 * in a modal — same pattern as the third-party licence modal on the
 * Thanks tab.
 */
import axios from 'axios'
import { useEffect, useState } from 'react'
import AccentLogo from '../../ui/AccentLogo'
import ImageHoverPreview from '../../ui/ImageHoverPreview'
import { markEggFired } from '../../../effects/quarterlyForecasts'
import { MAKER_MARK } from '../../../effects/tpsReports'

// Hardcoded public repo URL. If the repo ever moves, this is the only
// place in the frontend that needs updating; the backend doesn't know
// or care about the repo location.
const GITHUB_URL = 'https://github.com/Carasibana/NarrativeNode'

// ── The Heart Easter Egg ───────────────────────────────────────────
// The little coral heart at the end of the "with help from Claude ♥"
// credit line is a clickable easter egg. Each click picks one of
// these destinations at random and opens it in a new tab. Every
// destination is a small delight — no tracking pages, no ads, no
// politics, no rug-pulls. Just something genuinely positive and nice
// that someone lovingly put on the web.
//
// If any of these ever go down or turn sour, replace them — the list
// is ordered by nothing in particular and the picker doesn't care
// about order, length, or uniqueness of destinations (a duplicate
// would just double that site's hit probability, which is fine).
// Schemes verified against the real sites with `curl -IL`. `weavesilk`
// is the last remaining http-only host — don't "upgrade" it to https
// without re-verifying, it'll just return a connection error and the
// heart click silently fails. (The previous occupant of that category,
// thenicestplaceontheinter.net, went dark; its successor
// thenicestplace.net ships https and has taken its slot.)
const HEART_DESTINATIONS = [
  'https://pointerpointer.com/',
  'https://thenicestplace.net/',
  'https://zombo.com/',
  'https://thisissand.com/',
  'https://cat-bounce.com/',
  'https://www.koalastothemax.com/',
  'https://neal.fun/',
  'http://weavesilk.com/',
  'https://procatinator.com/',
  'https://quickdraw.withgoogle.com/',
  'https://randomstreetview.com/',
  'https://asoftmurmur.com/',
  'https://suno.com/embed/7d845ff2-ffc4-4f65-a398-e8d0461b4d19',
]

function openHeartDestination() {
  const pick = HEART_DESTINATIONS[Math.floor(Math.random() * HEART_DESTINATIONS.length)]
  window.open(pick, '_blank', 'noopener,noreferrer')
  markEggFired('coral')
}

/**
 * Format the version string for display. While we're still pre-1.0
 * (first segment of the version is 0), the label is prefixed with a
 * Greek lowercase beta to make the pre-release status explicit — so
 * `0.1.14.20` renders as `βeta v0.1.14.20`. Once the first segment
 * hits 1 or higher, the prefix drops away automatically — no manual
 * flag or config toggle needed. Single source of truth remains
 * `PROGRAM_VERSION` on the backend.
 *
 * Defensive parsing: if the version string is malformed or the first
 * segment isn't a number, we skip the prefix and just show `v{version}`.
 * Safer than rendering `NaNv0.x.x.x` on a garbage input.
 */
function formatVersionLabel(version) {
  const firstSegment = parseInt(String(version).split('.')[0], 10)
  const prefix = Number.isFinite(firstSegment) && firstSegment < 1 ? 'βeta ' : ''
  return `${prefix}v${version}`
}

/**
 * Modal rendering the project licence text. Fetches from /api/license
 * on open. Closes on backdrop click, Escape, or the X button. Plain
 * text rendering with whitespace-pre-wrap so the markdown in
 * LICENCE.md stays readable without pulling in a markdown renderer.
 */
function LicenseModal({ onClose }) {
  const [state, setState] = useState({ status: 'loading', text: '', error: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', text: '', error: null })
    axios
      .get('/api/license')
      .then((resp) => {
        if (cancelled) return
        setState({ status: 'ok', text: resp.data || '', error: null })
      })
      .catch((err) => {
        if (cancelled) return
        const msg =
          err?.response?.status === 404
            ? 'Licence file not found.'
            : (err?.message || 'Failed to load licence.')
        setState({ status: 'error', text: '', error: msg })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">NarrativeNode Licence</h3>
            <p className="text-[10px] text-zinc-500 font-mono">Custom source-available</p>
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
            <p className="text-xs text-zinc-500 italic">Loading licence text...</p>
          )}
          {state.status === 'ok' && (
            <pre className="text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-words leading-relaxed">{state.text}</pre>
          )}
          {state.status === 'error' && (
            <div className="text-xs text-zinc-300 space-y-2">
              <p>The licence file could not be loaded from the local server.</p>
              <p className="text-zinc-500">{state.error}</p>
              <p>
                You can read it directly in the repository:&nbsp;
                <a
                  href={`${GITHUB_URL}/blob/master/LICENCE.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent-400 hover:text-accent-300 hover:underline break-all"
                >
                  LICENCE.md
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AboutTab() {
  const [version, setVersion] = useState(null)
  const [versionError, setVersionError] = useState(false)
  const [licenceOpen, setLicenceOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    axios
      .get('/api/version')
      .then(({ data }) => {
        if (!cancelled && data?.version) setVersion(data.version)
      })
      .catch(() => {
        if (!cancelled) setVersionError(true)
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="flex flex-col items-center text-center space-y-4 max-w-md mx-auto">
          <AccentLogo className="w-32 h-32" />

          <div data-help-region="settings:about_version">
            <h1 className="text-2xl font-semibold text-zinc-100">NarrativeNode</h1>
            <div className="text-xs text-zinc-500 mt-1 font-mono">
              {version
                ? formatVersionLabel(version)
                : versionError
                  ? 'version unavailable'
                  : 'loading version…'}
            </div>
          </div>

          <p className="text-sm text-zinc-400">
            An interactive node-based plot planner for writers &amp; storytellers.
          </p>

          {/* Credits block — author + AI attribution. Two muted lines
              matching the repo-link styling below so the bottom of
              the panel reads as a visual pair. */}
          <div data-help-region="settings:about_credits" className="text-[11px] text-zinc-500 space-y-0.5 pt-2">
            <div>
              Made by{' '}
              {/* Hovering the maker credit reveals the maker's mark, the
                  same hover-preview used for entity images elsewhere. */}
              <ImageHoverPreview src={MAKER_MARK} size={200}>
                <a
                  href="https://github.com/Carasibana"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-400 hover:text-accent-300 underline"
                >
                  Carasibana
                </a>
              </ImageHoverPreview>
            </div>
            <div>
              with help from{' '}
              <a
                href="https://claude.com/product/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-400 hover:text-accent-300 underline"
              >
                Claude
              </a>{' '}
              <button
                type="button"
                onClick={openHeartDestination}
                // Coral / orange that matches Claude's brand logo colour.
                // Inline style rather than a Tailwind utility because no
                // existing token matches it and burning a one-off
                // arbitrary-value class here would muddy the palette.
                style={{ color: '#d97757' }}
                className="inline-block align-baseline leading-none cursor-pointer hover:scale-125 transition-transform duration-150 focus:outline-none"
                // Deliberately no title / aria-label — the reveal IS
                // the point. A screen-reader user will still get the
                // "♥" character announced as "heart" which is fine.
                aria-label="♥"
              >
                ♥
              </button>
            </div>
          </div>

          <div className="text-xs text-zinc-500 space-y-1">
            <div>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-help-region="settings:about_repo_link"
                className="text-accent-400 hover:text-accent-300 underline"
              >
                github.com/Carasibana/NarrativeNode
              </a>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setLicenceOpen(true)}
                data-help-region="settings:about_view_licence"
                className="text-accent-400 hover:text-accent-300 underline"
                title="View the NarrativeNode licence"
              >
                View licence
              </button>
            </div>
          </div>
        </div>
      </div>
      {licenceOpen && <LicenseModal onClose={() => setLicenceOpen(false)} />}
    </div>
  )
}
