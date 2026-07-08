import { useUiStore } from '../../store/uiStore'

/**
 * Phase 1.24b — "Show in TOC" button placed on the Entity / Relationship
 * / Knowledge detail panels. Three-way toggle behaviour:
 *
 *   1. TOC closed                              → open + filter to (type,id)
 *   2. TOC open + filter NOT this (type,id)    → apply filter to (type,id)
 *   3. TOC open + filter IS this (type,id)     → close TOC (clears filter)
 *
 * The filter composes with the existing `tocPovOnly` toggle — both can be
 * active.
 *
 * Visual: mirrors the canvas-toolbar TOC button's icon shape (the same
 * three-line-list SVG) so the writer reads the connection at a glance.
 * The accent treatment uses the source object's accent colour so the
 * button reads as part of the detail panel rather than as a generic
 * toolbar action. When the toggle is active (case 3), the swatch fills
 * harder so the writer can see the button is "engaged".
 */
export default function ShowInTocButton({ type, id, accentColour = '#71717a', typeLabel = null, size = 'md' }) {
  const setTocFilter = useUiStore((s) => s.setTocFilter)
  const tocPanelOpen = useUiStore((s) => s.tocPanelOpen)
  const tocFilter = useUiStore((s) => s.tocFilter)
  const toggleTocPanel = useUiStore((s) => s.toggleTocPanel)

  const isActive = tocPanelOpen && tocFilter && tocFilter.type === type && tocFilter.id === id

  const onClick = () => {
    if (isActive) {
      toggleTocPanel()
      return
    }
    if (!tocPanelOpen) toggleTocPanel()
    setTocFilter(type, id)
  }

  const labelText = typeLabel || 'entry'
  const tooltip = isActive
    ? 'Hide the Table of Contents.'
    : `Show this ${labelText}'s scenes in the Table of Contents.`

  const dims = size === 'sm'
    ? { box: 20, icon: 12 }
    : { box: 28, icon: 14 }

  return (
    <button
      type="button"
      onClick={onClick}
      data-toc-toggle
      data-help-region="detail-panel:nav"
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={isActive}
      className="flex items-center justify-center rounded transition-colors flex-shrink-0 hover:brightness-125"
      style={{
        width: dims.box,
        height: dims.box,
        backgroundColor: isActive ? `${accentColour}55` : `${accentColour}26`,
        border: `1px solid ${isActive ? accentColour : `${accentColour}66`}`,
        color: accentColour,
      }}
    >
      <svg width={dims.icon} height={dims.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="3" y1="4" x2="13" y2="4" />
        <line x1="5" y1="8" x2="13" y2="8" />
        <line x1="3" y1="12" x2="13" y2="12" />
      </svg>
    </button>
  )
}
