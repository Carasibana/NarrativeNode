import { useState } from 'react'
import CoverPlaceholder from '../ui/CoverPlaceholder'
import ObjectTagsButton from '../tags/ObjectTagsButton'

/**
 * Phase 5.5a — the Story Library project card.
 *
 * A prop-driven, self-contained card with three layers (design doc §4.2):
 *   - resting: the cover thumbnail, a favourite star marker (when set), and
 *     (when the file is fully missing) the greyed cover + "File not found"
 *     overlay (§2.1);
 *   - hover: the cover grows slightly (a transform, so it never reflows the
 *     shelf) and overlays a quick Open action at the bottom of the cover;
 *     the favourite star also surfaces so it can be toggled without
 *     expanding;
 *   - expanded (click the cover): the details panel slides out from the
 *     cover's right edge (the cover keeps the SAME size + position it had at
 *     rest, so its top stays aligned with the other covers) showing the
 *     description, tags (verbatim), the path dropdown, and Open / Hide /
 *     Remove pinned to the bottom. Clicking the cover again collapses.
 *
 * The favourite star marker IS the favourite control: it shows the state
 * and toggles it on click (top-right of the cover, in every layer). There
 * is no separate favourite button.
 *
 * Expansion is CONTROLLED by the parent (`expanded` + `onToggleExpand`) so
 * the shelf / preview can enforce accordion behaviour (one card open at a
 * time). Internally the card runs a small open/closing phase machine so the
 * details panel animates BOTH ways: a plain flag would unmount the panel
 * instantly on collapse, leaving no close animation. The panel content is a
 * fixed width inside an animating clip, so it slides in/out rather than
 * reflowing as the box grows. The card owns only its phase + selected-path
 * UI state. It never fetches: `coverUrl` is supplied (null falls back to
 * the bundled placeholder), and `paths` / `resolvedPath` / `warning` /
 * `missing` come from the path-status backing (`GET /library/{uuid}/paths`).
 *
 * Props:
 *   - card: {
 *       id, title, series, seriesNumber, tags[], description,
 *       favourite, missing, coverUrl,
 *       paths: [{ path, lastModified, isAutosave }],  // existing only
 *       resolvedPath,  // the path Open uses, or null (then Open picks)
 *       warning,       // resolved path is a fallback
 *     }
 *   - expanded                — controlled expanded state.
 *   - onToggleExpand()        — request expand / collapse (parent enforces
 *                               accordion: at most one open).
 *   - onOpen(path)            — open from the given path (resting uses the
 *                               resolved path; expanded uses the dropdown).
 *   - onToggleFavourite()     — flip the favourite flag (the star marker).
 *   - onHide()                — hide from views.
 *   - onRemove()              — remove from the library.
 *   - onRemoveFromCollection() — remove from the custom collection this card is
 *                               being viewed in. Only supplied for collection
 *                               shelves; omitted everywhere else, where the
 *                               minus button does not render.
 */

const COVER_W = 'w-36'  // 144px — identical in resting and expanded
const DEFAULT_ACCENT = '#7c3aed'  // story default accent when none is set (matches the Story model)

function StarIcon({ filled, className = '' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

export function EyeIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function EyeOffIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

function TrashIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function formatMtime(ts) {
  if (ts === null || ts === undefined) return ''
  try {
    return new Date(ts * 1000).toLocaleString()
  } catch {
    return ''
  }
}

function formatDate(ts) {
  if (ts === null || ts === undefined) return ''
  try {
    return new Date(ts * 1000).toLocaleDateString()
  } catch {
    return ''
  }
}

function seriesLabel(series, seriesNumber) {
  if (!series) return ''
  return Number.isFinite(seriesNumber) ? `${series} #${seriesNumber}` : series
}

function CardCover({ coverUrl, missing, hidden = false, alt, accentColor, flushRight = false }) {
  const [imgError, setImgError] = useState(false)
  const showImg = coverUrl && !imgError
  // Missing fully greys the cover; a (non-missing) hidden project is muted to
  // ~50% so it reads as set-aside but still recognisable.
  const dim = missing ? 'grayscale opacity-40' : (hidden ? 'opacity-50' : '')
  // When expanded the cover abuts the details panel on its right edge, so
  // drop the right border and square that side (the accent border stays on
  // top / bottom / left); the left corners round to match the panel. Hidden
  // projects get a dashed border to mark them at a glance.
  const edges = flushRight ? 'rounded-l-lg rounded-r-none border-r-0' : 'rounded'
  return (
    <div
      className={`relative overflow-hidden border bg-zinc-900 w-full ${edges} ${hidden ? 'border-dashed' : ''}`}
      style={{ aspectRatio: '2 / 3', borderColor: accentColor || DEFAULT_ACCENT }}
    >
      {showImg ? (
        <img
          src={coverUrl}
          alt={alt || 'Story cover'}
          draggable={false}
          className={`w-full h-full object-cover ${dim}`}
          onError={() => setImgError(true)}
        />
      ) : (
        <div className={`w-full h-full ${dim}`}>
          <CoverPlaceholder className="w-full h-full" />
        </div>
      )}
      {missing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <span className="text-[10px] font-medium text-red-100 bg-red-900/80 border border-red-500/50 rounded px-1.5 py-0.5">
            File not found
          </span>
        </div>
      )}
      {hidden && !missing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
          <EyeOffIcon className="w-8 h-8 text-zinc-100/90 drop-shadow" />
        </div>
      )}
    </div>
  )
}

/**
 * The favourite marker AND control in one. Always visible (amber, filled)
 * when favourited; otherwise hidden until the cover is hovered (resting) or
 * always shown faintly (`forceVisible`, used while expanded). Click toggles;
 * the click never bubbles to the cover's expand / collapse.
 */
function FavStar({ favourite, onToggle, forceVisible = false }) {
  const restState = forceVisible ? 'opacity-90' : 'opacity-0 group-hover:opacity-100'
  return (
    <button
      type="button"
      data-help-region="projects:card_favourite"
      onClick={(e) => { e.stopPropagation(); onToggle?.() }}
      title={favourite ? 'Remove from favourites' : 'Add to favourites'}
      className={`absolute top-1 right-1 p-0.5 rounded drop-shadow transition-opacity ${
        favourite ? 'text-amber-400 opacity-100' : `text-white hover:text-amber-300 ${restState}`
      }`}
    >
      <StarIcon filled={favourite} className="w-5 h-5" />
    </button>
  )
}

export default function ProjectCard({
  card,
  expanded = false,
  onToggleExpand,
  onOpen,
  onToggleFavourite,
  onHide,
  onRemove,
  onRemoveFromCollection,
  onLocate,
}) {
  const {
    title = 'Untitled',
    series,
    seriesNumber,
    tags = [],
    description,
    favourite = false,
    hidden = false,
    missing = false,
    coverUrl = null,
    paths = [],
    resolvedPath = null,
    warning = false,
    accentColor = null,
  } = card || {}

  const accent = accentColor || DEFAULT_ACCENT

  const [selectedPath, setSelectedPath] = useState(resolvedPath || (paths[0] && paths[0].path) || '')

  // Open / closing phase so the panel animates both ways. `expanded` true →
  // 'open'; → false collapses through 'closing' (the panel stays mounted
  // until the close animation ends, then 'collapsed' unmounts it). Synced
  // from the prop via the "adjust state during render" pattern (a
  // previous-value guard) rather than an effect, avoiding the extra render
  // pass an effect would add.
  const [phase, setPhase] = useState(expanded ? 'open' : 'collapsed')
  const [prevExpanded, setPrevExpanded] = useState(expanded)
  if (expanded !== prevExpanded) {
    setPrevExpanded(expanded)
    if (expanded) setPhase('open')
    else if (phase !== 'collapsed') setPhase('closing')
  }

  const showPanel = phase === 'open' || phase === 'closing'
  const canOpen = paths.length > 0
  const subtitle = seriesLabel(series, seriesNumber)

  // The file last-modified date shown under the resting cover: the resolved
  // path's mtime, else the most-recent path's.
  const displayPath = paths.find((p) => p.path === resolvedPath) || paths[0]
  const lastModified = displayPath ? displayPath.lastModified : null

  return (
    <div data-help-region="projects:project_card" className="flex flex-col flex-shrink-0">
      {/* Cover row: the cover, plus the details panel to its right when expanded. */}
      <div className={showPanel ? 'flex items-start' : undefined}>
      {/* Cover — the same element across states (no remount, no flicker). It
          keeps its size + position; only the resting hover-scale toggles. */}
      <div
        data-help-region="projects:card_cover"
        className={`group relative ${COVER_W} flex-shrink-0 cursor-pointer ${
          showPanel ? '' : 'origin-center transition-transform duration-150 hover:scale-105 hover:z-10'
        }`}
        onClick={() => onToggleExpand?.()}
        role="button"
        title={showPanel ? 'Collapse' : title}
      >
        <CardCover coverUrl={coverUrl} missing={missing} hidden={hidden} alt={title} accentColor={accent} flushRight={showPanel} />

        {!showPanel && (
          <div className="absolute inset-0 rounded opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/75 via-black/25 to-transparent pointer-events-none">
            {/* Quick actions: button centre sits on the lower rule-of-thirds
                line (2/3 down from the top), via top-2/3 + a half-height
                upward shift to centre on that line. */}
            <div data-help-region="projects:card_quick_actions" className="absolute inset-x-0 top-2/3 -translate-y-1/2 flex justify-center gap-1.5">
            {missing ? (
              // A missing card offers Locate (point at the moved file) +
              // Remove directly from the cover, since Open has no file to open.
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onLocate?.() }}
                  className="pointer-events-auto text-xs px-2.5 py-1 rounded bg-accent-600 hover:bg-accent-500 active:bg-accent-700 active:scale-95 transition text-white"
                >
                  Locate
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRemove?.() }}
                  className="pointer-events-auto text-xs px-2.5 py-1 rounded border border-red-500/60 text-red-200 bg-black/40 hover:bg-red-900/50 active:bg-red-900/70 active:scale-95 transition"
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpen?.(resolvedPath) }}
                disabled={!canOpen}
                className="pointer-events-auto text-xs px-3 py-1 rounded bg-accent-600 hover:bg-accent-500 active:bg-accent-700 active:scale-95 transition text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Open
              </button>
            )}
            </div>
          </div>
        )}

        <FavStar favourite={favourite} onToggle={onToggleFavourite} forceVisible={showPanel} />
      </div>

      {showPanel && (
        <div
          className={`nn-accordion-clip min-w-0 ${phase === 'closing' ? 'nn-accordion-close' : 'nn-accordion-open'}`}
          onAnimationEnd={() => { if (phase === 'closing') setPhase('collapsed') }}
        >
          <div
            data-help-region="projects:card_details"
            className={`w-72 h-[13.5rem] flex flex-col gap-2 bg-zinc-800/70 border border-l-0 rounded-r-lg p-3 ${hidden ? 'border-dashed' : ''}`}
            style={{ borderColor: accent }}
          >
            <div className="flex-shrink-0 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-100 break-words">{title}</div>
                {subtitle && <div className="text-xs text-zinc-400 italic truncate">{subtitle}</div>}
              </div>
              {/* Tags are always shown via the glance popover (no inline
                  badges) — its icon sits in the top-right of the panel. */}
              {tags.length > 0 && (
                <div className="flex-shrink-0">
                  <ObjectTagsButton pool="program" tagNames={tags} size="sm" />
                </div>
              )}
            </div>

            {/* Description body — the flexible region; scrolls when the text
                is long so the card keeps the cover's height. Always rendered
                (even when empty) so it absorbs the slack and the footer stays
                pinned to the bottom. */}
            <div className="flex-1 min-h-0 overflow-y-auto text-xs text-zinc-300 leading-snug whitespace-pre-wrap">
              {description}
            </div>

            {/* Footer — path + actions, pinned to the bottom (aligned with
                the cover's bottom edge). Tags are not here; they live in the
                top-right glance icon. */}
            <div className="flex-shrink-0 flex flex-col gap-1">
              {canOpen ? (
                <select
                  data-help-region="projects:card_path_select"
                  value={selectedPath}
                  onChange={(e) => setSelectedPath(e.target.value)}
                  className="w-full text-[11px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-zinc-200"
                  title="Choose which file to open"
                >
                  {paths.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path}
                      {p.isAutosave ? '  (autosave)' : ''}
                      {p.lastModified ? `  ·  ${formatMtime(p.lastModified)}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-[11px] text-red-300">No file found at any known path.</div>
              )}
              {warning && canOpen && (
                <div className="text-[11px] text-amber-300">Preferred path missing; using a fallback.</div>
              )}

              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  data-help-region="projects:card_open"
                  onClick={(e) => { e.stopPropagation(); onOpen?.(selectedPath || resolvedPath) }}
                  disabled={!canOpen}
                  className="text-xs px-3 py-1 rounded bg-accent-600 hover:bg-accent-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Open
                </button>
                {onRemoveFromCollection && (
                  <button
                    type="button"
                    data-help-region="projects:card_remove_from_collection"
                    onClick={(e) => { e.stopPropagation(); onRemoveFromCollection() }}
                    title="Remove from this collection. The project stays in your library and on its other shelves."
                    className="ml-auto text-xs px-2 py-1 rounded border border-zinc-600 text-zinc-300 hover:text-zinc-100 leading-none"
                  >
                    −
                  </button>
                )}
                <button
                  type="button"
                  data-help-region="projects:card_hide"
                  onClick={(e) => { e.stopPropagation(); onHide?.() }}
                  title={hidden
                    ? 'Show this project in the library again'
                    : 'Hide this project from the library views. The project is not deleted; you can show it again later.'}
                  className={`p-1 rounded border border-zinc-600 text-zinc-300 hover:text-zinc-100 ${onRemoveFromCollection ? '' : 'ml-auto'}`}
                >
                  {hidden ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  data-help-region="projects:card_remove"
                  onClick={(e) => { e.stopPropagation(); onRemove?.() }}
                  title="Remove this project from the NarrativeNode library. The project file on disk is NOT deleted."
                  className="p-1 rounded border border-red-700/60 text-red-300 hover:bg-red-900/40 hover:text-red-200"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Title + last-modified, centred under the whole card (the cover, or
          the cover + panel when expanded). `w-0 min-w-full` fills the card
          width to centre under it without widening the card on a long title. */}
      <div className="mt-1 text-center w-0 min-w-full">
        <div className="text-xs text-zinc-200 truncate" title={title}>{title}</div>
        {/* The series + last-modified lines are ALWAYS rendered (blank, via a
            non-breaking space, when absent) so every card is the same height —
            otherwise a row without a series-bearing card is shorter and the
            layout jumps when paging between rows. The reserved blank space
            now lands below the date, not between the title and date. */}
        <div className="text-[10px] italic text-zinc-600 truncate">
          {lastModified ? formatDate(lastModified) : ' '}
        </div>
        <div className="text-[10px] text-zinc-500 truncate">{subtitle || ' '}</div>
      </div>
    </div>
  )
}
