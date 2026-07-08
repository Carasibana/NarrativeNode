/**
 * Phase 1.26 — POV-only navigation toggle button.
 *
 * Lives in the bottom-left `leftSlot` of every Detail Panel nav bar
 * (Scene / Entity / Relationship / Knowledge). When ON, the host
 * detail view filters its back/forward sequence to: the chain's origin
 * stop + scenes that lie on the POV chain. When OFF (default), the
 * full sequence is used. Each host owns its own seq computation; this
 * component is purely presentational + click dispatch.
 *
 * Visual:
 *   - OFF, enabled        → outlined zinc-500 border, "POV" in zinc-500
 *   - ON,  enabled        → POV-coloured fill, dark "POV" text
 *   - disabled (no POV)   → faded grey, cursor not-allowed
 */

export default function PovNavToggleButton({
  hasAnyPov,
  povNavOnly,
  onToggle,
  povColor,
}) {
  return (
    <button
      type="button"
      onClick={hasAnyPov ? onToggle : undefined}
      disabled={!hasAnyPov}
      title={
        !hasAnyPov
          ? 'No POV defined yet — assign POV to a character on a scene to enable POV-only navigation.'
          : povNavOnly
            ? 'POV-only navigation: ON. Click to step through every chain stop.'
            : 'POV-only navigation: OFF. Click to step through only origin + POV-linked scenes.'
      }
      aria-pressed={povNavOnly}
      data-help-region="detail-panel:pov_nav_toggle"
      className="px-1 rounded flex items-center justify-center text-[9px] font-bold leading-none transition-colors flex-shrink-0"
      style={{
        height: 20,
        border: `1px solid ${povNavOnly && hasAnyPov ? povColor : '#52525b'}`,
        backgroundColor: povNavOnly && hasAnyPov ? povColor : 'transparent',
        color: povNavOnly && hasAnyPov ? '#18181b' : '#52525b',
        cursor: hasAnyPov ? 'pointer' : 'not-allowed',
        opacity: hasAnyPov ? 1 : 0.5,
      }}
    >
      POV
    </button>
  )
}
