import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Saturation from '@uiw/react-color-saturation'
import Hue from '@uiw/react-color-hue'
import { hexToHsva, hsvaToHex } from '@uiw/color-convert'
import PresetHoneycomb from './PresetHoneycomb'
import SaturationHexPointer from './SaturationHexPointer'
import TintFlyout from './TintFlyout'
import useHoverDelay from '../../hooks/useHoverDelay'
import { lighten, darken, useAccentColor } from '../../utils/povConstants'

/**
 * Bespoke colour picker — replaces every native
 * `<input type="color">` call site in the app. Two sides in a
 * single floating popover: left = 19-preset honeycomb; right =
 * HSV saturation square + hue slider + hex input.
 *
 * Staged edit flow: opening the popover snapshots the current
 * value into `originalHex`. Every interaction mutates a local
 * `workingHex` (the "working copy"). OK calls `onChange(workingHex)`
 * and closes; Cancel / Escape / click-outside close without
 * calling onChange. The parent's stored colour only changes when
 * OK is pressed.
 *
 * Props:
 * - `value` — current hex, e.g. '#7c3aed'. Not required when the
 *   picker is closed.
 * - `onChange(hex)` — committed colour. Called once on OK.
 * - `anchorEl` — DOM node the popover visually attaches to. Used
 *   for bounding-rect positioning + click-outside detection.
 * - `isOpen` — parent controls visibility.
 * - `onClose()` — notify parent to flip `isOpen` back to false.
 *   Called on OK, Cancel, Escape, click-outside.
 */
export default function EntityColorPicker({
  value,
  onChange,
  anchorEl,
  isOpen,
  onClose,
}) {
  const [workingHsva, setWorkingHsva] = useState(() => safeHexToHsva(value))
  const [hexDraft,    setHexDraft]    = useState(() => normalizeHex(value) || '#000000')
  const popoverRef = useRef(null)
  const accentColour = useAccentColor()

  // Snapshot-on-open: when `isOpen` transitions from false to
  // true, load the current value as the staged working copy.
  // This is intentional — the popover doesn't react to prop
  // changes while already open, so the parent can't "sneak" a
  // colour change past the user's staged edit.
  const wasOpenRef = useRef(isOpen)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      // Deferred via setTimeout so the setState doesn't fire
      // synchronously in the effect body (react-hooks/set-state-
      // in-effect). Microtask would also work; setTimeout is
      // the established pattern in this codebase.
      const t = setTimeout(() => {
        setWorkingHsva(safeHexToHsva(value))
        setHexDraft(normalizeHex(value) || '#000000')
      }, 0)
      wasOpenRef.current = isOpen
      return () => clearTimeout(t)
    }
    wasOpenRef.current = isOpen
    return undefined
  }, [isOpen, value])

  // Derived hex from the working HSV (for the preset match
  // highlight + pointer colour readout).
  const workingHex = hsvaToHex(workingHsva).toLowerCase()

  // ── Action handlers ────────────────────────────────────────
  const commit = useCallback(() => {
    onChange(workingHex)
    onClose()
  }, [onChange, workingHex, onClose])

  const cancel = useCallback(() => {
    onClose()
  }, [onClose])

  // @uiw/react-color-saturation fires onChange with a raw
  // `{h, s, v, a}` object — NOT a ColorResult wrapper. Previous
  // versions of this handler read `colour.hsva` / `colour.hex`
  // off a non-existent wrapper, which set workingHsva to
  // undefined and crashed the next render (hsvaToHex(undefined)
  // destructures undefined → TypeError → blank UI).
  const handleSaturationChange = useCallback((hsva) => {
    setWorkingHsva(hsva)
    setHexDraft(hsvaToHex(hsva).toLowerCase())
  }, [])

  // @uiw/react-color-hue fires onChange with `{h}` only. Keep
  // the existing s/v/a from workingHsva when only the hue
  // changes.
  const handleHueChange = useCallback(({ h }) => {
    setWorkingHsva((prev) => {
      const next = { ...prev, h }
      setHexDraft(hsvaToHex(next).toLowerCase())
      return next
    })
  }, [])

  const handleHexCommit = useCallback((raw) => {
    const clean = normalizeHex(raw)
    if (clean) {
      setWorkingHsva(safeHexToHsva(clean))
      setHexDraft(clean)
    } else {
      // Invalid — revert to the last valid working hex.
      setHexDraft(workingHex)
    }
  }, [workingHex])

  const handlePresetClick = useCallback((hex) => {
    const clean = normalizeHex(hex)
    if (!clean) return
    setWorkingHsva(safeHexToHsva(clean))
    setHexDraft(clean)
  }, [])

  // ── Escape + click-outside close ───────────────────────────
  useEffect(() => {
    if (!isOpen) return undefined
    function handleKey(e) {
      if (e.key === 'Escape') cancel()
    }
    function handleMouseDown(e) {
      if (!popoverRef.current) return
      if (popoverRef.current.contains(e.target)) return
      if (anchorEl && anchorEl.contains(e.target)) return
      // The tint flyout is portaled separately (to document.body)
      // so it's NOT inside popoverRef. Without this check a click
      // on a tint hex would be treated as outside the picker and
      // close it before the tint-click handler can fire.
      if (e.target && e.target.closest?.('[data-tint-flyout="true"]')) return
      cancel()
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [isOpen, cancel, anchorEl])

  // ── Positioning ────────────────────────────────────────────
  const [position, setPosition] = useState({ top: 0, left: 0 })
  useEffect(() => {
    if (!isOpen || !anchorEl) return undefined
    const t = setTimeout(() => {
      const rect = anchorEl.getBoundingClientRect()
      // Anchor below the trigger; flip above if too close to
      // the viewport bottom. Conservative estimates — 420 px
      // tall, 560 px wide — cover the layout at default hex
      // sizes.
      const PICKER_HEIGHT_ESTIMATE = 420
      const PICKER_WIDTH_ESTIMATE = 560
      const viewportH = window.innerHeight
      const viewportW = window.innerWidth
      let top = rect.bottom + 8
      if (top + PICKER_HEIGHT_ESTIMATE > viewportH) {
        top = Math.max(8, rect.top - PICKER_HEIGHT_ESTIMATE - 8)
      }
      let left = rect.left
      if (left + PICKER_WIDTH_ESTIMATE > viewportW) {
        left = Math.max(8, viewportW - PICKER_WIDTH_ESTIMATE - 8)
      }
      setPosition({ top, left })
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, anchorEl])

  if (!isOpen) return null

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Colour picker"
      data-nested-modal="true"
      data-help-region="colour-picker:popover"
      // Stop mousedown from bubbling up to document-level listeners
      // on wrapping panels (e.g. SettingsPanel, EntityModal). Without
      // this, a click on any preset hex or the saturation square is
      // treated as "outside the settings panel" by those listeners —
      // which closes the whole panel and drops the picker with it.
      // Mirrors the pattern SeedsImportDialog uses for the same reason.
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 9999,
        background: '#18181b',
        border: '1px solid #3f3f46',
        borderRadius: 8,
        boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Left: preset honeycomb */}
        <div data-help-region="colour-picker:presets">
          <PresetHoneycomb
            selectedHex={workingHex}
            onPresetClick={handlePresetClick}
            onTintClick={handlePresetClick}
            selectedRingColour={accentColour}
          />
        </div>

        {/* Right: saturation / hue / hex */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 240 }} data-help-region="colour-picker:spectrum">
          <SaturationWithFlyout
            hsva={workingHsva}
            onChange={handleSaturationChange}
          />
          <Hue
            hue={workingHsva.h}
            onChange={handleHueChange}
            width="100%"
            height={14}
          />
        </div>
      </div>

      {/* Action bar: live swatch left, OK then Cancel right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #3f3f46', paddingTop: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            background: workingHex,
            borderRadius: 4,
            border: '1px solid #3f3f46',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <HexInput value={hexDraft} onCommit={handleHexCommit} />
        </div>
        <button
          type="button"
          onClick={commit}
          style={actionButtonStyle(accentColour, '#ffffff')}
          data-help-region="colour-picker:ok"
        >
          OK
        </button>
        <button
          type="button"
          onClick={cancel}
          style={actionButtonStyle('#27272a', '#e4e4e7')}
          data-help-region="colour-picker:cancel"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  )
}

/** Saturation square wrapped with the hex pointer + hover-delay
 *  tint flyout. Kept here (rather than in its own file) because
 *  the glue to `useHoverDelay` + computed tints is specific to
 *  this composition and not reused elsewhere. */
function SaturationWithFlyout({ hsva, onChange }) {
  const containerRef = useRef(null)
  const hover = useHoverDelay()
  const [anchorCentre, setAnchorCentre] = useState(null)

  useEffect(() => {
    if (!hover.isOpen || !containerRef.current) return undefined
    const t = setTimeout(() => {
      const sq = containerRef.current?.getBoundingClientRect()
      if (!sq) return
      setAnchorCentre({
        x: sq.left + sq.width * (hsva.s / 100),
        y: sq.top + sq.height * (1 - hsva.v / 100),
      })
    }, 0)
    return () => clearTimeout(t)
  }, [hover.isOpen, hsva.s, hsva.v])

  // Pointer component that forwards hover handlers to the hex
  // indicator. Stored in a ref so it never changes identity —
  // React remounts the Saturation library's internal DOM whenever
  // the `pointer` render-prop gets a new function reference, which
  // would cause a visible flash on every re-render.
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const SaturationPointer = useRef((props) => (
    <SaturationHexPointer
      {...props}
      onPointerEnter={() => hoverRef.current.onPointerEnter()}
      onPointerLeave={() => hoverRef.current.onPointerLeave()}
    />
  )).current

  const currentHex = hsvaToHex(hsva).toLowerCase()
  const tints = [
    lighten(currentHex, 0.35),
    darken(currentHex, 0.35),
    shiftSat(currentHex, +0.30),
    shiftSat(currentHex, -0.30),
    shiftHue(currentHex, -25),
    shiftHue(currentHex, +25),
  ]

  function pickTint(hex) {
    onChange(safeHexToHsva(hex))
  }

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: 240, height: 180 }}
    >
      <Saturation
        hsva={hsva}
        onChange={onChange}
        style={{ width: 240, height: 180, borderRadius: 4 }}
        pointer={SaturationPointer}
      />
      {hover.isOpen && anchorCentre && (
        <TintFlyout
          tints={tints}
          anchorCentre={anchorCentre}
          hexSize={24}
          onHoverEnter={hover.cancelClose}
          onHoverLeave={hover.onPointerLeave}
          onPick={pickTint}
        />
      )}
    </div>
  )
}

function HexInput({ value, onCommit }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  function handleBlur() {
    onCommit(draft)
  }
  function handleKey(e) {
    if (e.key === 'Enter') {
      onCommit(draft)
      e.currentTarget.blur()
    }
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKey}
      spellCheck={false}
      autoCapitalize="off"
      data-help-region="colour-picker:hex_input"
      style={{
        width: '100%',
        padding: '6px 8px',
        background: '#27272a',
        border: '1px solid #3f3f46',
        borderRadius: 4,
        color: '#e4e4e7',
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    />
  )
}

// ── Helpers ────────────────────────────────────────────────────

function normalizeHex(raw) {
  if (typeof raw !== 'string') return null
  let v = raw.trim().toLowerCase()
  if (!v) return null
  if (!v.startsWith('#')) v = `#${v}`
  // Expand 3-char shorthand to 6-char.
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  if (!/^#[0-9a-f]{6}$/.test(v)) return null
  return v
}

function safeHexToHsva(hex) {
  const clean = normalizeHex(hex)
  if (!clean) return { h: 0, s: 0, v: 0, a: 1 }
  return hexToHsva(clean)
}

function shiftHue(hex, degrees) {
  const hsva = safeHexToHsva(hex)
  hsva.h = (hsva.h + degrees + 360) % 360
  return hsvaToHex(hsva)
}

function shiftSat(hex, delta) {
  // delta is a 0-1 fraction. @uiw/color-convert stores s/v as
  // 0-100, so scale the delta up before adding + clamping.
  const hsva = safeHexToHsva(hex)
  hsva.s = Math.max(0, Math.min(100, hsva.s + delta * 100))
  return hsvaToHex(hsva)
}

function actionButtonStyle(bg, fg) {
  return {
    padding: '6px 14px',
    background: bg,
    color: fg,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
  }
}
