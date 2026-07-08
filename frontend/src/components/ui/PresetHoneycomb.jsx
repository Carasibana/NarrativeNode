import { useEffect, useRef, useState } from 'react'
import { PRESET_PALETTE } from '../../utils/colorPickerPresets'
import { getHoneycombLayout, getHoneycombBounds } from '../../utils/colorPickerGeometry'
import PresetHexagon from './PresetHexagon'
import TintFlyout from './TintFlyout'
import useHoverDelay from '../../hooks/useHoverDelay'

/**
 * 19-hexagon honeycomb swatch picker. Renders the palette data
 * from `colorPickerPresets.js` at positions from
 * `colorPickerGeometry.js`, wired up to the hover-delay flyout.
 *
 * Props:
 * - `selectedHex` — if it hex-matches one of the 19 main
 *   presets (case-insensitive), that hex renders with a
 *   selected outline. Tint matches are ignored (v1 scope).
 * - `onPresetClick(hex)` — main preset clicked.
 * - `onTintClick(hex)`   — flyout tint clicked.
 * - `hexSize` — size of each preset hex in pixels (default 36).
 *
 * Hover behaviour:
 * - Per-hex `useHoverDelay` (instanced one-per-hex); only one
 *   flyout is open at a time (the hook's local state). Tracking
 *   which hex is hovered is handled by each hex reporting its
 *   own open state upward via a callback, and the parent
 *   picking the first one reporting `isOpen`.
 */
export default function PresetHoneycomb({
  selectedHex,
  onPresetClick,
  onTintClick,
  hexSize = 44,
  selectedRingColour,
}) {
  const layout = getHoneycombLayout(hexSize)
  const bounds = getHoneycombBounds(hexSize)
  const containerRef = useRef(null)

  const bySlot = Object.fromEntries(PRESET_PALETTE.map((p) => [p.slot, p]))
  const selectedSlot = findSelectedSlot(selectedHex)

  // Which hex is currently showing its flyout (by slot).
  // Only one at a time; per-hex useHoverDelay instances open
  // their own local state, then call up here so we can render
  // the single <TintFlyout> anchored to that hex.
  const [openSlot, setOpenSlot] = useState(null)
  const [openAnchor, setOpenAnchor] = useState(null)
  // Refs for the currently-open hex's hover callbacks:
  // - cancelClose: called when pointer enters a tint to veto the
  //   pending close while the cursor is browsing the ring.
  // - triggerLeave: called when pointer EXITS a tint into empty
  //   space so the source hex's close timer restarts and the
  //   flyout eventually unmounts rather than sticking forever.
  const openCancelCloseRef  = useRef(null)
  const openTriggerLeaveRef = useRef(null)

  return (
    <div
      ref={containerRef}
      data-help-region="colour-picker:honeycomb"
      style={{
        position: 'relative',
        width: bounds.width,
        height: bounds.height,
      }}
    >
      {layout.map(({ slot, x, y }) => {
        const preset = bySlot[slot]
        if (!preset) return null
        // Centre the rendered hex (width = hexSize, height =
        // hexSize * sqrt(3)/2 after the regular-hex fix) on the
        // slot's geometric position. Using hexSize/2 for both
        // axes — as we used to — assumed a square hex, which
        // the updated `<PresetHexagon>` no longer is.
        const hexHeight = hexSize * Math.sqrt(3) / 2
        return (
          <HexSlot
            key={slot}
            preset={preset}
            offsetX={bounds.width / 2 + x - hexSize / 2}
            offsetY={bounds.height / 2 + y - hexHeight / 2}
            hexSize={hexSize}
            isSelected={selectedSlot === slot}
            selectedRingColour={selectedRingColour}
            onClick={() => onPresetClick(preset.main)}
            onHoverOpen={(anchorCentre, cancelClose, triggerLeave) => {
              setOpenSlot(slot)
              setOpenAnchor(anchorCentre)
              openCancelCloseRef.current  = cancelClose
              openTriggerLeaveRef.current = triggerLeave
            }}
            onHoverClose={(thisSlot) => {
              // Only clear if we were the open one — prevents a
              // fast-move "leave A, enter B" sequence from
              // clobbering B's just-opened state with A's leave.
              setOpenSlot((current) => (current === thisSlot ? null : current))
            }}
          />
        )
      })}

      {openSlot && openAnchor && bySlot[openSlot] && (
        <TintFlyout
          tints={bySlot[openSlot].tints}
          anchorCentre={openAnchor}
          hexSize={Math.round(hexSize * 0.6)}
          onHoverEnter={() => { openCancelCloseRef.current?.() }}
          onHoverLeave={() => { openTriggerLeaveRef.current?.() }}
          onPick={(hex) => {
            // Close immediately on pick so the flyout doesn't
            // linger after the click.
            setOpenSlot(null)
            setOpenAnchor(null)
            onTintClick(hex)
          }}
        />
      )}
    </div>
  )
}

// Single hex + its hover-delay machinery. Isolated into its own
// component so the useHoverDelay hook instances don't multiply
// linearly in the parent's render tree.
function HexSlot({
  preset,
  offsetX,
  offsetY,
  hexSize,
  isSelected,
  selectedRingColour,
  onClick,
  onHoverOpen,
  onHoverClose,
}) {
  const elRef = useRef(null)
  const hover = useHoverDelay()

  // Callback refs so effects don't re-run on every parent render
  // (inline prop lambdas are not reference-stable).
  const onHoverOpenRef  = useRef(onHoverOpen)
  const onHoverCloseRef = useRef(onHoverClose)
  useEffect(() => { onHoverOpenRef.current  = onHoverOpen  }, [onHoverOpen])
  useEffect(() => { onHoverCloseRef.current = onHoverClose }, [onHoverClose])

  // Tie both open AND close signals to the debounced hover.isOpen
  // state rather than raw pointer events. This means the flyout
  // stays mounted for the full closeDelay window after the pointer
  // leaves, giving the cursor time to reach the tint ring before
  // the parent unmounts the flyout.
  const prevIsOpenRef = useRef(false)
  useEffect(() => {
    if (hover.isOpen === prevIsOpenRef.current) return
    prevIsOpenRef.current = hover.isOpen
    if (hover.isOpen && elRef.current) {
      // Query the hex <button> directly rather than the wrapper div
      // so the anchor is the button's true centre, not the wrapper's
      // centre (which is shifted by PresetHexagon's -3px margin overhang
      // for the selection ring).
      const target = elRef.current.querySelector('button') ?? elRef.current
      const rect = target.getBoundingClientRect()
      onHoverOpenRef.current(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        hover.cancelClose,
        hover.onPointerLeave,
      )
    } else if (!hover.isOpen) {
      onHoverCloseRef.current(preset.slot)
    }
  }, [hover.isOpen, hover.cancelClose, preset.slot])

  return (
    <div
      ref={elRef}
      style={{
        position: 'absolute',
        left: offsetX,
        top: offsetY,
        zIndex: isSelected ? 1 : 0,
      }}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={hover.onPointerDown}
      onTouchStart={hover.onTouchStart}
    >
      <PresetHexagon
        colour={preset.main}
        size={hexSize}
        isSelected={isSelected}
        selectedRingColour={selectedRingColour}
        isHovered={hover.isOpen}
        onClick={onClick}
        ariaLabel={`Preset ${preset.main}`}
      />
    </div>
  )
}

function findSelectedSlot(hex) {
  if (!hex) return null
  const normalized = hex.toLowerCase()
  const match = PRESET_PALETTE.find((p) => p.main.toLowerCase() === normalized)
  return match ? match.slot : null
}
