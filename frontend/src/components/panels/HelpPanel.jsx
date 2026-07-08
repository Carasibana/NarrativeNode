import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { tours } from './help/helpTours'
import ScreenshotTour from './help/ScreenshotTour'
import { useAccentColor } from '../../utils/povConstants'

/**
 * Phase 1.27 — In-app Help panel.
 *
 * Layout: vertical 3-level tree in the left rail, screenshot pane on
 * the right.
 *
 *   ▾ NODES
 *      ▾ Anatomy of a Scene
 *          • Title
 *          • Description
 *          ...
 *      ▸ Flashback Scene
 *   ▸ DETAIL PANEL
 *   ▸ DIALOGS
 *
 * Selection model:
 *   - `selected`: locked (tour, section).
 *   - `hovered`:  transient preview as the mouse moves over rows /
 *                 screenshot overlays.
 *   - Active = hovered ?? selected.
 */
export default function HelpPanel() {
  const open  = useUiStore((s) => s.helpPanelOpen)
  const close = useUiStore((s) => s.closeHelpPanel)
  const helpTarget = useUiStore((s) => s.helpTarget)
  const clearHelpTarget = useUiStore((s) => s.clearHelpTarget)
  const panelRef = useRef(null)
  const accent = useAccentColor()

  // Phase 6.2b — surface nesting. A tour may declare a `parent` (another tour
  // id); it renders nested under that parent in the rail instead of as a
  // sibling. Build child / parent / membership lookups once.
  const childrenByParent = useMemo(() => {
    const m = new Map()
    for (const t of tours) {
      if (t.parent) {
        if (!m.has(t.parent)) m.set(t.parent, [])
        m.get(t.parent).push(t)
      }
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title))
    }
    return m
  }, [])
  const parentById = useMemo(() => {
    const m = new Map()
    for (const t of tours) if (t.parent) m.set(t.id, t.parent)
    return m
  }, [])
  const knownTourIds = useMemo(() => new Set(tours.map((t) => t.id)), [])

  // Top level = surfaces with no (known) parent. Everything nests under the
  // single main-UI root, so the rail is that one drill-down tree — no category
  // buckets. Roots and every child list sort by hand-set `order`.
  const roots = useMemo(
    () =>
      tours
        .filter((t) => !t.parent || !knownTourIds.has(t.parent))
        .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title)),
    [knownTourIds],
  )

  // Initial state: open the root tour.
  const initialTour   = roots[0] || null
  const initialTourId = initialTour?.id || null

  const [selected, setSelected] = useState({ tourId: initialTourId, sectionId: null })
  const [hovered,  setHovered]  = useState({ tourId: null, sectionId: null })
  const [expandedTours, setExpandedTours] = useState(() => new Set(initialTourId   ? [initialTourId]   : []))
  // Cross-link breadcrumb: the trail of surfaces reached by following links /
  // region hand-offs. Rail selection resets it; a cross-surface jump appends;
  // clicking a crumb truncates back to it.
  const [trail, setTrail] = useState(() => (initialTourId ? [initialTourId] : []))

  const activeTourId    = hovered.tourId    ?? selected.tourId
  const activeSectionId = (
    hovered.tourId
      ? hovered.sectionId
      : (selected.tourId === activeTourId ? selected.sectionId : null)
  )
  const activeTour = tours.find((t) => t.id === activeTourId) || null

  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Help-mode hand-off: when the panel is opened with a { surface, region }
  // target (click-to-inspect), jump the rail there — expand the surface and
  // all its ancestors so it's visible, set the breadcrumb to that chain, and
  // select the region (which highlights it in the screenshot). Then clear the
  // target so a later plain open (hamburger browse) starts at the root again.
  useEffect(() => {
    if (!open || !helpTarget) return undefined
    const { surface, region } = helpTarget
    if (!knownTourIds.has(surface)) { clearHelpTarget(); return undefined }
    const chain = []
    const seen = new Set()
    let id = surface
    while (id && !seen.has(id)) { chain.unshift(id); seen.add(id); id = parentById.get(id) }
    setExpandedTours((prev) => {
      const next = new Set(prev)
      chain.forEach((c) => next.add(c))
      return next
    })
    setTrail(chain)
    setSelected({ tourId: surface, sectionId: region || null })
    clearHelpTarget()
    return undefined
  }, [open, helpTarget, knownTourIds, parentById, clearHelpTarget])

  if (!open) return null

  // Tours nest, so their expand state is NOT a single-open accordion: a parent
  // and its expanded child coexist. Toggling collapses the whole subtree;
  // ensuring-open also opens every ancestor so a nested selection is visible.
  function toggleTour(id) {
    setExpandedTours((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        const stack = [id]
        while (stack.length) {
          const cur = stack.pop()
          next.delete(cur)
          for (const c of childrenByParent.get(cur) || []) stack.push(c.id)
        }
      } else {
        next.add(id)
      }
      return next
    })
  }
  function ensureTourOpen(id) {
    setExpandedTours((prev) => {
      const next = new Set(prev)
      let cur = id
      while (cur) {
        next.add(cur)
        cur = parentById.get(cur)
      }
      return next
    })
  }

  function selectSection(tourId, sectionId) {
    setSelected((prev) =>
      prev.tourId === tourId && prev.sectionId === sectionId
        ? { tourId, sectionId: null }
        : { tourId, sectionId },
    )
    ensureTourOpen(tourId)
  }

  function selectTourHeader(tourId) {
    // Clicking the tour title always: expands the section list AND
    // returns the right pane to the tour's main overview image.
    // (The expand chevron beside the title handles collapse on its own.)
    ensureTourOpen(tourId)
    setSelected({ tourId, sectionId: null })
  }

  // Map hotspot click: a lateral move on the CURRENT shot (the all-regions-live
  // overlay only shows regions of the shot you're already on). Replace the head
  // crumb so exploring same-shot surfaces never deepens the breadcrumb; if the
  // surface is already an earlier crumb, regress to it instead.
  function selectFromMap(tourId, sectionId) {
    setTrail((prev) => {
      const i = prev.indexOf(tourId)
      if (i >= 0) return prev.slice(0, i + 1)
      if (!prev.length) return [tourId]
      return [...prev.slice(0, -1), tourId]
    })
    selectSection(tourId, sectionId)
  }

  // Cross-link ("See also"): a deliberate jump to another surface. Go deeper
  // (append a crumb), or regress if we have already been there.
  function followCrossLink(tourId, sectionId) {
    setTrail((prev) => {
      const i = prev.indexOf(tourId)
      if (i >= 0) return prev.slice(0, i + 1)
      return [...prev, tourId]
    })
    selectSection(tourId, sectionId)
  }

  function onHoverSection(tourId, sectionId) {
    // sectionId === null means mouseleave — clear both fields so the
    // left rail's selected tour isn't pinned by a stale hover anchor.
    if (sectionId == null) {
      setHovered({ tourId: null, sectionId: null })
    } else {
      setHovered({ tourId, sectionId })
    }
  }

  // Recursively render a tour and (when open) its sections then its child
  // tours, each level indented one step deeper.
  function renderTour(tour, depth) {
    const isTourOpen = expandedTours.has(tour.id)
    const isTourActive = tour.id === activeTourId
    const kids = childrenByParent.get(tour.id) || []
    const pad = 8 + depth * 14
    return (
      <div key={tour.id}>
        <div
          className={`w-full flex items-center gap-1.5 pr-2 py-1 text-xs transition-colors ${
            isTourActive ? 'text-zinc-100' : 'text-zinc-300 hover:text-zinc-100'
          }`}
          style={{ paddingLeft: pad, ...(isTourActive && !activeSectionId ? { backgroundColor: accent + '15' } : {}) }}
        >
          <button
            type="button"
            onClick={() => toggleTour(tour.id)}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 w-3 flex-shrink-0 leading-none"
            aria-expanded={isTourOpen}
            aria-label={isTourOpen ? 'Collapse' : 'Expand'}
          >
            {isTourOpen ? '▾' : '▸'}
          </button>
          <button
            type="button"
            onClick={() => { setTrail([tour.id]); selectTourHeader(tour.id) }}
            className="flex-1 text-left truncate"
          >
            {tour.title}
          </button>
        </div>
        {isTourOpen && (
          <>
            <ul>
              {tour.sections.map((section) => {
                const isSectionActive = tour.id === activeTourId && section.id === activeSectionId
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => { setTrail([tour.id]); selectSection(tour.id, section.id) }}
                      className={`w-full text-left pr-2 py-0.5 text-[11px] transition-colors ${
                        isSectionActive ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      style={{ paddingLeft: pad + 18, ...(isSectionActive ? { backgroundColor: accent + '22' } : {}) }}
                    >
                      {section.label}
                    </button>
                  </li>
                )
              })}
              {tour.sections.length === 0 && kids.length === 0 && (
                <li className="pr-2 py-0.5 text-[11px] text-zinc-600 italic" style={{ paddingLeft: pad + 18 }}>
                  (no sections yet)
                </li>
              )}
            </ul>
            {kids.map((child) => renderTour(child, depth + 1))}
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div
        ref={panelRef}
        data-test-id="help-panel"
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[1440px] max-w-[97vw] h-[85vh] max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full border text-[11px] font-bold"
              style={{ borderColor: accent, color: accent }}
            >
              ?
            </span>
            Help
          </h2>
          <button
            onClick={close}
            className="text-zinc-400 hover:text-zinc-200 leading-none"
            title="Close (Esc)"
            aria-label="Close help panel"
          >
            ✕
          </button>
        </div>

        {/* Body: tree (left) + screenshot pane (right) */}
        <div className="flex flex-1 min-h-0">
          {/* Left rail — 3-level tree: category → tour → section. */}
          <nav className="w-[280px] border-r border-zinc-700 flex-shrink-0 overflow-y-auto py-1">
            {roots.map((tour) => renderTour(tour, 0))}
          </nav>

          {/* Right pane — active tour rendered as screenshot + overlays + body. */}
          {activeTour ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {trail.length > 1 && (
                <div className="flex items-center gap-1 px-4 pt-3 text-xs flex-wrap flex-shrink-0">
                  {trail.map((tid, i) => {
                    const t = tours.find((x) => x.id === tid)
                    const isLast = i === trail.length - 1
                    return (
                      <span key={`${tid}-${i}`} className="flex items-center gap-1">
                        {i > 0 && <span className="text-zinc-600">›</span>}
                        {isLast ? (
                          <span className="text-zinc-300">{t?.title || tid}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setTrail(trail.slice(0, i + 1)); selectTourHeader(tid) }}
                            className="hover:underline"
                            style={{ color: accent }}
                          >
                            {t?.title || tid}
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
              )}
              <ScreenshotTour
                tour={activeTour}
                selectedTourId={selected.tourId}
                activeSectionId={activeSectionId}
                selectedSectionId={selected.sectionId}
                onHoverSection={(tid, sid) => onHoverSection(tid, sid)}
                onClickSection={(tid, sid) => selectFromMap(tid, sid)}
                onCrossLink={(tid, sid) => followCrossLink(tid, sid)}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-6 text-sm text-zinc-400 italic">
              No help tours authored yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
