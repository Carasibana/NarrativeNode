import { useState } from 'react'
import { useAccentColor } from '../../../utils/povConstants'
import { tours } from './helpTours'

/**
 * Phase 1.27 / 6.2b — Right-pane of the Help panel.
 *
 * TWO LINKED CROP VIEWS of one surface image (the zoom is a crop of the same
 * source, not a second file):
 *
 *   MAP  — the current level: a container region cropped to fill the column,
 *          with its DIRECT CHILDREN as clickable hotspots. With nothing drilled
 *          into, the map is the whole surface and the hotspots are its
 *          TOP-LEVEL regions.
 *   ZOOM — the focused region, cropped tight, with ITS OWN children as hotspots.
 *
 * Region DEPTH is geometric: a region wholly enclosed by a larger, non-backdrop
 * region is a sub-region of it and appears only inside that parent's view, so
 * the map stays uncluttered and detail lives in the drill-down.
 *
 * DRILL-DOWN: clicking a child of the focus moves the focus down a level. Since
 * map = parent-of-focus and zoom = focus, the old zoom region slides up to
 * become the map and the clicked child becomes the new zoom — to any depth. A
 * "Back" control climbs one level out.
 *
 * The crop is PURE CSS: the pane's aspect-ratio is the region's displayed shape
 * and the image is offset by percentages, so there is NO pixel measurement that
 * could read 0 and leave the map blank.
 */
export default function ScreenshotTour({
  tour,
  selectedTourId,
  activeSectionId,
  selectedSectionId,
  onHoverSection,
  onClickSection,
  onCrossLink,
}) {
  const accent = useAccentColor()
  // Source image native pixels: only used for the displayed aspect ratio.
  const [nativeW, setNativeW] = useState(0)
  const [nativeH, setNativeH] = useState(0)
  if (!tour) return null

  const activeSection = tour.sections.find((s) => s.id === activeSectionId) || null
  // The MAP is anchored to the SELECTED location, which may live on a different
  // tour than the one being hovered (the main-app screenshot is shared by many
  // surfaces). Resolve the selection from the full tour set so hovering a
  // cross-surface hotspot only drives the zoom and never moves the map.
  const selTour = tours.find((t) => t.id === selectedTourId) || tour
  const selectedSection = selTour?.sections.find((s) => s.id === selectedSectionId) || null
  const activeScreenshot = selectedSection?.screenshot || selTour?.screenshot || tour.screenshot
  const activeAlt = selectedSection?.screenshotAlt || selTour?.screenshotAlt || tour.screenshotAlt

  // Every region on the current image, gathered across EVERY tour sharing it, so
  // a click can hand off to its owning surface.
  const overlays = []
  for (const t of tours) {
    for (const s of t.sections) {
      const sImg = s.screenshot || t.screenshot
      if (sImg === activeScreenshot && s.region) {
        overlays.push({ tour: t, section: s, region: s.region })
      } else if (activeScreenshot === t.screenshot && s.mainRegion) {
        overlays.push({ tour: t, section: s, region: s.mainRegion })
      }
    }
  }
  overlays.sort((a, b) => b.region.w * b.region.h - a.region.w * a.region.h)

  // --- Region depth (geometry) ---
  const rArea = (r) => r.w * r.h
  const encloses = (a, b, tol = 0.6) =>
    a.x - tol <= b.x &&
    a.y - tol <= b.y &&
    a.x + a.w + tol >= b.x + b.w &&
    a.y + a.h + tol >= b.y + b.h
  // A region wholly enclosing a smaller one is its CONTAINER (parent), at ANY
  // size. A full-surface region (the canvas workspace, a panel or node body) is
  // the parent of everything drawn on top of it, so the map shows it as one
  // clickable container that drills into its contents.
  const containsR = (a, b) =>
    a !== b && rArea(a) > rArea(b) + 0.01 && encloses(a, b)
  // Hand-authored nesting wins over geometry (Phase 6.2c). A region's section
  // MAY carry an explicit `parent` ("surface:key" ref, or "" for forced
  // top-level) set in the nesting editor; when present it overrides containment.
  // Otherwise the parent is the smallest enclosing region (geometric).
  const regionToOverlay = new Map(overlays.map((o) => [o.region, o]))
  const regionByRef = new Map(overlays.map((o) => [o.tour.id + ':' + o.section.id, o.region]))
  const geomParentOf = (region) => {
    let best = null
    for (const o of overlays) {
      if (containsR(o.region, region) && (!best || rArea(o.region) < rArea(best))) best = o.region
    }
    return best
  }
  const parentOf = (region) => {
    const o = regionToOverlay.get(region)
    const ref = o && o.section ? o.section.parent : undefined
    if (ref === '') return null
    if (ref) {
      const key = ref.indexOf(':') >= 0 ? ref : o.tour.id + ':' + ref
      return regionByRef.get(key) || null
    }
    return geomParentOf(region)
  }
  const topOverlays = overlays.filter((o) => !parentOf(o.region))
  const directChildren = (R) => overlays.filter((o) => parentOf(o.region) === R)
  const hasKids = (region) => directChildren(region).length > 0

  // --- Focus / level resolution ---
  // The MAP is the navigator. Clicking a region that HAS children drills the map
  // into it: the map crops to that region and shows ITS children as the next
  // clickable hotspots. A leaf keeps the map at its container (siblings shown,
  // leaf highlighted). Nothing selected = the surface's top-level regions. The
  // zoom is a tight close-up of whatever is hovered or selected.
  const onShot = (s) => s && (s.screenshot || tour.screenshot) === activeScreenshot && s.region
  // Selected focus is the locked map anchor: find it among the gathered overlays
  // (which span every tour on this screenshot), keyed by the selection — NOT by
  // whatever tour is currently hovered. This is what keeps hover from moving the
  // map. Active focus (the zoom) follows the hover, falling back to the anchor.
  const selFocus =
    overlays.find((o) => o.tour.id === selTour?.id && o.section.id === selectedSectionId) || null
  const actFocus = (onShot(activeSection) ? activeSection : null) || selFocus
  const mapCropRegion = selFocus
    ? hasKids(selFocus.region)
      ? selFocus.region
      : parentOf(selFocus.region)
    : null
  const mapChildren = mapCropRegion ? directChildren(mapCropRegion) : topOverlays
  const zoomRegion = actFocus?.region || null

  const AR = nativeW && nativeH ? nativeW / nativeH : 1922 / 1082
  const FULL = { x: 0, y: 0, w: 100, h: 100 }
  const setNative = (e) => {
    setNativeW(e.target.naturalWidth)
    setNativeH(e.target.naturalHeight)
  }

  const goUp = () => {
    if (!mapCropRegion) return
    const target = parentOf(mapCropRegion)
    if (target) {
      const o = overlays.find((ov) => ov.region === target)
      if (o) onClickSection?.(o.tour.id, o.section.id)
    } else if (selectedSection) {
      // Already at a top-level container: deselect to return to the full surface.
      onClickSection?.(tour.id, selectedSection.id)
    }
  }
  const crossLink =
    activeSection?.target && ['surface', 'concept'].includes(activeSection.target.type)
      ? tours.find((t) => t.id === activeSection.target.ref) || null
      : null

  // Crop `region` of the surface to fill its pane, with `children` as hotspots.
  // Pure CSS: pane aspect-ratio = region's displayed shape; the image is sized
  // and offset as a percentage of the pane; children positioned as a percentage
  // of the crop. No pixel reads, so it can never stall blank.
  const renderCrop = (region, children, { maxH, keyPrefix, dashedBig }) => {
    const regAR = (region.w * AR) / region.h // displayed width / height of the crop
    return (
      <div
        className="relative overflow-hidden rounded border border-zinc-700 bg-zinc-900 mx-auto"
        style={{ width: '100%', maxWidth: `${maxH * regAR}px`, aspectRatio: `${region.w * AR} / ${region.h}` }}
      >
        <img
          src={activeScreenshot}
          alt={activeAlt || ''}
          draggable={false}
          onLoad={setNative}
          style={{
            position: 'absolute',
            width: `${10000 / region.w}%`,
            height: `${10000 / region.h}%`,
            left: `${(-region.x / region.w) * 100}%`,
            top: `${(-region.y / region.h) * 100}%`,
            maxWidth: 'none',
          }}
        />
        {children.flatMap(({ tour: t, section, region: C }) => {
          const isActive = t.id === tour.id && section.id === activeSectionId
          // One section may cover several non-contiguous areas: the main box plus
          // any section.extras[]. All share the same label / hover / click.
          const boxes = [C, ...(Array.isArray(section.extras) ? section.extras : [])]
          return boxes.map((B, bi) => {
            const big = dashedBig && B.w * B.h > 5000
            return (
              <button
                key={`${keyPrefix}-${t.id}:${section.id}:${bi}`}
                type="button"
                aria-label={section.label}
                onMouseEnter={() => onHoverSection?.(t.id, section.id)}
                onMouseLeave={() => onHoverSection?.(null, null)}
                onClick={() =>
                  section.link
                    ? onCrossLink?.(section.link, null)
                    : onClickSection?.(t.id, section.id)
                }
                className="absolute rounded transition-all duration-150 focus:outline-none"
                style={{
                  left: `${((B.x - region.x) / region.w) * 100}%`,
                  top: `${((B.y - region.y) / region.h) * 100}%`,
                  width: `${(B.w / region.w) * 100}%`,
                  height: `${(B.h / region.h) * 100}%`,
                  cursor: 'pointer',
                  border: isActive
                    ? big
                      ? `2px dashed ${accent}`
                      : `2px solid ${accent}`
                    : big
                      ? `1px dashed ${accent}66`
                      : `1px solid ${accent}5a`,
                  boxShadow: isActive && !big ? `0 0 12px 2px ${accent}aa, inset 0 0 8px ${accent}55` : 'none',
                  backgroundColor: isActive && !big ? `${accent}11` : 'transparent',
                }}
              />
            )
          })
        })}
      </div>
    )
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-4 flex flex-col gap-4">
      {/* Reserve a fixed block for the description so switching to another
          surface (with a different-length text) never shifts the map below it. */}
      <p className="text-xs text-zinc-400 italic min-h-[3.5rem] flex-shrink-0">{tour.intro}</p>

      <div className="flex gap-4 items-start min-w-0">
        {/* Map — the current level. */}
        <div className="flex-1 min-w-0 flex flex-col items-center gap-2">
          {activeScreenshot ? (
            <>
              {mapCropRegion && (
                <button
                  type="button"
                  onClick={goUp}
                  className="self-start text-[11px] hover:underline focus:outline-none"
                  style={{ color: accent }}
                >
                  ⤺ Back
                </button>
              )}
              {renderCrop(mapCropRegion || FULL, mapChildren, { maxH: 600, keyPrefix: 'map', dashedBig: true })}
            </>
          ) : (
            <div className="flex-1 w-full rounded border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center text-xs text-zinc-500 italic">
              Screenshot pending. The section outline in the left rail is the
              planned content for this tour.
            </div>
          )}
        </div>

        {/* Zoom — the focused region, cropped tight. */}
        <div className="flex-shrink-0 w-[360px]">
          {zoomRegion ? (
            renderCrop(zoomRegion, directChildren(zoomRegion), { maxH: 540, keyPrefix: 'zoom', dashedBig: false })
          ) : (
            <div
              className="rounded border border-zinc-700 bg-zinc-900 w-full flex items-center justify-center text-[11px] text-zinc-600 italic px-4 text-center"
              style={{ height: 120 }}
            >
              Hover or click a region to zoom in.
            </div>
          )}
        </div>
      </div>

      {/* Detail text. */}
      <div className="min-h-[5rem] text-sm leading-relaxed">
        {activeSection ? (
          <>
            <div className="text-zinc-100 font-medium mb-1">{activeSection.label}</div>
            <p className="text-zinc-300">{activeSection.body}</p>
            {crossLink && (
              <button
                type="button"
                onClick={() => onCrossLink?.(crossLink.id, null)}
                className="mt-2 text-xs hover:underline focus:outline-none"
                style={{ color: accent }}
              >
                See also: {crossLink.title} →
              </button>
            )}
          </>
        ) : (
          <p className="text-zinc-500 italic text-xs">
            Hover or click a highlighted region, or a section in the list, to read about it.
          </p>
        )}
      </div>
    </div>
  )
}
