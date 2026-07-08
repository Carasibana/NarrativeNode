/**
 * Custom `pointer` render-prop for `@uiw/react-color-saturation`.
 * Draws a small hexagon aligned with the `<PresetHexagon>` visual
 * language rather than the library's default circular pointer.
 *
 * The library positions the pointer via `left` / `top` CSS
 * percentages on the wrapping div (passed as `prefixCls` styles),
 * so this component just renders the hex silhouette at the
 * origin of its own positioning box.
 *
 * Border is a contrasting colour derived from the current colour
 * under the pointer so the hex is visible against any background
 * patch of the saturation square.
 */
const HEX_CLIP_PATH = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)'

export default function SaturationHexPointer({
  // The library injects these (see node_modules/@uiw/react-color-
  // saturation/src/Pointer.tsx — PointerProps). `top` and `left`
  // are CSS percentage strings like "12.3%"; `color` is a CSS
  // colour STRING (hsla(...)), not an object.
  top,
  left,
  color,
  size = 22,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onTouchStart,
}) {
  // `color` is a CSS string; use it directly as the fill. For
  // the outline, fall back to white — we can't cheaply compute
  // luminance from an hsla(...) string without a parser, and
  // the outline's job is just to make the pointer visible
  // against the saturation square's background regardless.
  const fill = typeof color === 'string' ? color : '#ffffff'
  const outlineColour = '#ffffff'
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        transform: 'translate(-50%, -50%)',
        width: size,
        height: size * Math.sqrt(3) / 2,
        pointerEvents: 'auto',
        // Stack: outer clipped hex = outline, inner clipped hex = fill.
        // Nesting gives us a clean 2 px border inside the silhouette.
        filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.7))',
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onTouchStart={onTouchStart}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          clipPath: HEX_CLIP_PATH,
          background: outlineColour,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 2,
          clipPath: HEX_CLIP_PATH,
          background: fill,
        }}
      />
    </div>
  )
}

