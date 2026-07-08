/**
 * helpRegionResolver — maps a clicked DOM element to a help surface/region.
 *
 * Help mode (click-to-inspect) needs to turn "the user clicked this element"
 * into "open the Help panel at this surface, this region". UI elements are
 * tagged `data-help-region="<surface>:<region>"`. The tags nest in the DOM
 * the way the help tree nests, so walking up from the clicked element to the
 * nearest tag whose <surface> is a known help tour IS the nearest-covered-
 * ancestor fallback: an uncovered leaf tag (or an untagged element) simply
 * falls through to its covered parent surface.
 */
import { tours } from '../components/panels/help/helpTours'

const tourIds = new Set(tours.map((t) => t.id))
const sectionIdsByTour = new Map(
  tours.map((t) => [t.id, new Set((t.sections || []).map((s) => s.id))]),
)
// The single browse root (top-level surface with no known parent) is the
// ultimate fallback when a click lands somewhere with no help tag at all.
const rootTourId = (tours.find((t) => !t.parent || !tourIds.has(t.parent)) || {}).id || null

/**
 * Walk up the DOM from `el`, returning the nearest ancestor carrying a
 * `data-help-region` whose surface is a known tour. Returns
 * `{ surface, region }` (region is null when the surface has no matching
 * section), falling back to the root surface, or null if there are no tours.
 */
export function resolveHelpTargetFromElement(el) {
  let node = el
  while (node && node !== document.body && typeof node.getAttribute === 'function') {
    const raw = node.getAttribute('data-help-region')
    if (raw) {
      const idx = raw.indexOf(':')
      const surface = idx === -1 ? raw : raw.slice(0, idx)
      const region = idx === -1 ? '' : raw.slice(idx + 1)
      if (tourIds.has(surface)) {
        const hasRegion = !!region && sectionIdsByTour.get(surface)?.has(region)
        return { surface, region: hasRegion ? region : null }
      }
      // Surface isn't a known tour (e.g. a retired/leaf-only tag); keep
      // walking up to the nearest covered ancestor.
    }
    node = node.parentElement
  }
  return rootTourId ? { surface: rootTourId, region: null } : null
}
