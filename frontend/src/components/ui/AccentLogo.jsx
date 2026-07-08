import { memo, useMemo, useSyncExternalStore } from 'react'
import { useAccentColor, DEFAULT_ACCENT_COLOR } from '../../utils/povConstants'
import { getOvumOrangeActive, subscribeOvumOrange } from '../../effects/quarterlyForecasts'

/**
 * Original SVG purple shades mapped to their relative lightness (0=darkest, 1=lightest).
 * These proportions are preserved when remapping to a new accent colour.
 */
const ORIGINAL_COLORS = [
  { hex: '#301d6c', lightness: 0.0 },   // darkest
  { hex: '#503983', lightness: 0.21 },   // dark-fill
  { hex: '#4f3b81', lightness: 0.22 },   // dark-detail-3
  { hex: '#513d7e', lightness: 0.23 },   // dark-detail-2
  { hex: '#5b468b', lightness: 0.30 },   // dark-detail-1
  { hex: '#9981d7', lightness: 0.74 },   // detail-medium
  { hex: '#a088dc', lightness: 0.79 },   // shadow-1
  { hex: '#a18cd1', lightness: 0.80 },   // shadow-2
  { hex: '#a190c8', lightness: 0.81 },   // shadow-3
  { hex: '#aa94df', lightness: 0.87 },   // fill-medium-light
  { hex: '#b19de1', lightness: 0.92 },   // fill-light
  { hex: '#9b82da', lightness: 0.75 },   // gradient-dark
  { hex: '#bcaae4', lightness: 1.0 },    // gradient-light
]

/** Convert hex to HSL. Returns [h, s, l] where h is 0-360, s and l are 0-1. */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

/** Convert HSL to hex. h is 0-360, s and l are 0-1. */
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60)       { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else              { r = c; g = 0; b = x }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Generate a colour map from the original purple shades to new accent-based shades.
 * The base colour's lightness determines where it sits in the range, and all other
 * shades are distributed proportionally within the available lightness range.
 */
function buildColorMap(accentHex) {
  const [h, s, baseL] = hexToHsl(accentHex)

  // The available lightness range: darkest shade goes to min 0.08, lightest to max 0.92
  // The base colour sits proportionally in this range based on its own lightness.
  const minL = Math.max(0.06, baseL * 0.3)
  const maxL = Math.min(0.94, baseL + (1 - baseL) * 0.7)

  const map = {}
  for (const { hex, lightness } of ORIGINAL_COLORS) {
    // Map the original relative lightness (0-1) into the new range [minL, maxL]
    const newL = minL + lightness * (maxL - minL)
    // Desaturate slightly at extremes for more natural look
    const satMult = lightness < 0.2 ? 0.7 : lightness > 0.9 ? 0.6 : 1.0
    map[hex] = hslToHex(h, s * satMult, newL)
  }
  return map
}

/**
 * The NN logo rendered as inline SVG with colours dynamically mapped to the accent colour.
 * The original NN.svg file on disk is never modified.
 */
function AccentLogo({ className }) {
  const baseAccent = useAccentColor()
  // ovum_orange — when active, override the logo's accent to the brand
  // colour so it matches the rest of the orange-tinted UI for the
  // duration of the egg.
  const orangeActive = useSyncExternalStore(subscribeOvumOrange, getOvumOrangeActive)
  const accentColor = orangeActive ? '#ff9000' : baseAccent
  const colorMap = useMemo(() => buildColorMap(accentColor), [accentColor])

  // Helper to remap a colour
  const c = (original) => colorMap[original] || original

  return (
    <svg
      className={className}
      width="512"
      height="512"
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
    >
      <defs>
        <linearGradient
          id="accentLogoGrad"
          x1="165.65382" y1="91.168564"
          x2="350.92999" y2="425.41559"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(-1.9537975,1.1722768)"
        >
          <stop offset="0" stopColor={c('#bcaae4')} />
          <stop offset="1" stopColor={c('#9b82da')} />
        </linearGradient>
        <filter id="accentLogoShadow1" colorInterpolationFilters="sRGB" x="-0.013" y="-0.017" width="1.03" height="1.04">
          <feFlood result="flood" floodOpacity="0.498" floodColor="rgb(0,0,0)" />
          <feGaussianBlur result="blur" in="SourceGraphic" stdDeviation="1" />
          <feOffset result="offset" in="blur" dx="1.5" dy="1.5" />
          <feComposite result="comp1" operator="in" in="flood" in2="offset" />
          <feComposite operator="over" in="SourceGraphic" in2="comp1" />
        </filter>
        <filter id="accentLogoShadow2" colorInterpolationFilters="sRGB" x="-0.006" y="-0.013" width="1.014" height="1.035">
          <feFlood result="flood" floodOpacity="0.498" floodColor="rgb(0,0,0)" />
          <feGaussianBlur result="blur" in="SourceGraphic" stdDeviation="1" />
          <feOffset result="offset" in="blur" dx="1.5" dy="1.5" />
          <feComposite result="comp1" operator="in" in="flood" in2="offset" />
          <feComposite operator="over" in="SourceGraphic" in2="comp1" />
        </filter>
        <filter id="accentLogoShadow3" colorInterpolationFilters="sRGB" x="-0.006" y="-0.008" width="1.013" height="1.018">
          <feFlood result="flood" floodOpacity="0.498" floodColor="rgb(0,0,0)" />
          <feGaussianBlur result="blur" in="SourceGraphic" stdDeviation="1" />
          <feOffset result="offset" in="blur" dx="0" dy="0.461538" />
          <feComposite result="comp1" operator="in" in="flood" in2="offset" />
          <feComposite operator="over" in="SourceGraphic" in2="comp1" />
        </filter>
      </defs>

      {/* White outline/swirl */}
      <path fill="#ffffff" d="m 430.58928,159.82756 -4.03553,20.12216 c 0,0 37.21612,17.97478 35.87928,58.07986 -1.06445,31.93327 -20.58184,47.36424 -42.49023,56.66992 -10.9542,4.65284 -22.31118,7.3174 -31.19922,8.73828 -4.44402,0.71044 -8.27366,1.1159 -11.10352,1.32812 -2.82986,0.21223 -5.22272,0.1676 -4.62305,0.20508 -3.76428,-0.23527 -7.38895,0.0568 -14.74609,-0.52344 -7.35714,-0.58019 -17.00536,-1.91756 -27.64453,-5.00976 -21.27834,-6.18441 -46.33264,-19.12626 -66.06836,-47.6211 -36.51421,-52.71996 -81.69829,-63.50585 -122.71289,-63.50585 -27.5876,0 -54.82655,6.75458 -75.87695,20.77539 -21.05041,14.0208 -35.77409,36.34257 -35.32813,64.21484 0.90272,56.41981 48.15217,76.67406 48.15217,76.67406 l 4.16848,-20.70026 c 0,0 -31.59988,-11.12371 -32.3226,-56.29411 -0.33557,-20.97267 9.62789,-36.06682 26.41797,-47.25 16.79008,-11.18318 40.54367,-17.41992 64.78906,-17.41992 37.98068,0 73.23051,7.18733 106.27148,54.89257 22.67109,32.73298 52.40271,48.31142 76.92774,55.43946 12.26251,3.56401 23.26856,5.08088 31.65429,5.74218 8.38574,0.66131 15.59112,0.57931 15.07227,0.54688 2.16271,0.13517 3.992,0.0303 7.36523,-0.22266 3.37324,-0.25298 7.72655,-0.71591 12.76563,-1.52148 10.07816,-1.61114 22.8876,-4.57027 35.85937,-10.08008 25.94355,-11.01962 53.31764,-34.07812 54.66211,-74.41211 1.78925,-53.67721 -51.83398,-78.86804 -51.83398,-78.86803 z" />

      {/* Shadow layer */}
      <g filter="url(#accentLogoShadow2)">
        <path fill={c('#5b468b')} d="m 463.32617,260.0332 c -7.47312,20.11742 -24.03684,31.88269 -41.42773,39.26953 -9.13046,3.8782 -18.42691,6.40457 -26.47461,8.01368 v 10.18554 c 8.99726,-1.68221 19.6822,-4.45097 30.38281,-8.99609 19.8001,-8.41017 39.90002,-23.47904 47.97656,-48.47266 z" />
        <path fill={c('#4f3b81')} d="m 38.183594,293.18945 c 9.977747,38.33063 41.74414,51.14649 41.74414,51.14649 l 2.023438,-10.04688 c 0,0 -24.144522,-8.98427 -33.546875,-41.09961 z" />
        <path fill={c('#513d7e')} d="m 266.9082,278.26953 c 19.10643,19.70581 40.82729,30.13413 59.53125,35.57031 8.26772,2.40296 15.95585,3.84751 22.60938,4.71875 l 0.0664,-10.08203 c -5.93662,-0.82906 -12.68581,-2.14595 -19.88476,-4.23828 -15.07686,-4.38199 -32.07954,-12.10801 -47.86328,-25.96875 z" />
        <path fill={c('#a088dc')} d="m 163.74023,194.45312 v 9.95118 c 22.79138,2.52738 45.03618,10.13088 66.13868,29.74023 H 243.9082 C 218.75772,207.57806 191.08327,197.5202 163.74023,194.45312 Z" />
        <path fill={c('#a18cd1')} d="m 115.94141,195.4375 c -17.40602,2.92028 -33.749278,8.85079 -47.201176,17.81055 -13.546641,9.02285 -24.130078,21.35519 -29.412109,36.50781 H 49.90625 c 4.762642,-11.45811 13.275697,-20.79016 24.378906,-28.18555 11.611982,-7.73426 26.087784,-13.13212 41.689454,-15.96093 z" />
        <path fill={c('#a190c8')} d="m 429.66797,164.41211 -2.10547,10.50781 c 0,0 26.22496,12.46181 36.41602,40.98828 h 10.55078 c -10.47995,-34.87135 -44.86133,-51.49609 -44.86133,-51.49609 z" />
      </g>

      {/* Rectangles layer */}
      <g>
        <path fill="#ffffff" fillOpacity="1" d="m 115.86914,172.94336 0.16992,52.96484 h 47.70117 v -52.96484 z m 320.71289,42.96484 -0.35742,44.125 h 68.89453 v -44.125 z m -211.29883,18.23633 0.17774,44.125 h 60.26953 v -44.125 z M 4.8085938,249.75586 v 43.43359 H 75.181641 v -43.43359 z m 344.4511762,36.88867 -0.3418,51.85938 h 46.50586 v -51.85938 z" />
        <path fill={c('#503983')} d="M 9.8089585,254.75661 H 70.182407 v 33.43335 H 9.8089585 Z" />
        <path fill={c('#b19de1')} d="m 120.88505,177.9428 h 37.85429 v 42.966 h -37.71613 z" />
        <path fill={c('#aa94df')} d="m 230.30329,239.14517 h 50.42634 v 34.12412 h -50.28818 z" />
        <path fill={c('#503983')} d="m 354.22774,291.64382 h 36.19644 v 41.86077 h -36.47275 z" />
        <path fill={c('#503983')} d="m 441.54128,220.9088 h 58.57745 v 34.12412 h -58.85375 z" />
      </g>

      {/* Main gradient + detail layer */}
      <g filter="url(#accentLogoShadow1)">
        <path fill="url(#accentLogoGrad)" filter="url(#accentLogoShadow3)" d="m 127.30859,109.02148 -16.56445,82.26758 c 1.71688,-0.33914 3.44468,-0.64888 5.18164,-0.92968 l -0.0566,-17.41602 h 47.87109 v 16.53125 c 29.50477,3.32428 59.95295,14.6355 86.91797,44.66992 h 35.07227 v 41.30859 c 14.8471,12.73529 30.71113,19.8615 44.89648,23.98438 6.67041,1.93871 12.95056,3.18721 18.52149,3.99219 l 0.11133,-16.78516 h 46.16406 v 6.70313 l 9.04101,-3.25586 22.08985,-110.14258 1.00781,-5.0293 2.10547,-10.50781 h 0.002 l 0.91992,-4.58399 10.1875,-50.80664 H 342.30469 L 314.16992,249.69531 219.86914,109.02148 Z m 36.43164,100.35547 v 16.53125 h -47.70117 l -0.0488,-15.20312 c -3.26232,0.616 -6.46746,1.34772 -9.59765,2.1914 l -23.431642,116.37891 -1.009766,5.01367 -2.023438,10.04688 -1.134765,5.63867 -9.628907,47.81836 36.634768,-0.14258 69.13867,-24.89844 23.17773,-115.24218 57.08204,86.33789 69.92382,-25.18164 c -0.0257,-0.007 -0.0504,-0.016 -0.0762,-0.0234 -20.41085,-5.93228 -44.42837,-17.7173 -64.98047,-40.37305 h -34.60351 l -0.16797,-41.65625 c -19.70542,-17.95529 -40.18925,-24.8843 -61.55274,-27.23633 z" />
        <path fill={c('#301d6c')} d="m 167.52344,226.02148 c -12.48459,0 -51.18085,-7.13111 -95.730471,171.76172 l 0.804687,-0.004 87.109374,-135.5625 32.67383,23.80664 5.73437,-28.51367 0.0117,0.0176 c -3.83796,-7.86361 -16.54649,-31.50586 -30.60351,-31.50586 z" />
        <path fill={c('#9981d7')} d="m 437.37109,126.00586 c -35.78153,83.58471 -57.86868,126.48494 -86.73632,125.98828 -16.81219,-2.27321 -27.04695,-18.27861 -29.97513,-34.74741 l -6.48972,32.44858 c 7.50773,19.44335 31.9836,36.3027 48.88189,18.37692 37.20429,-39.46648 53.3233,-82.14204 72.28413,-131.91793 z" />
        <path fill={c('#503983')} d="m 437.18164,126.94727 c -11.21362,35.8561 -45.71417,131.3678 -105.875,172.68554 6.417,1.82747 12.46079,3.01934 17.8418,3.79688 l 0.11133,-16.78516 h 46.16406 v 15.56641 c 2.23138,-0.46242 4.55309,-0.99598 6.93359,-1.61133 l 24.19727,-120.65039 1.00781,-5.0293 2.10547,-10.50781 h 0.002 l 0.91992,-4.58399 z M 161.36523,255.0332 c -42.11106,-0.47208 -83.33519,92.59266 -91.281246,142.75586 l 99.896486,-0.38672 23.50586,-116.8789 v -0.002 c -6.13156,-12.42511 -15.28328,-25.29952 -32.1211,-25.48828 z m 49.57813,21.87891 79.91992,120.88086 h 92.00195 l 11.89063,-59.28906 h -45.83789 l 0.0976,-14.90821 c -7.00552,-0.88921 -15.1637,-2.39342 -23.9707,-4.95312 -5.59435,-1.62596 -11.46059,-3.69211 -17.45117,-6.30078 -7.34843,2.87163 -15.01273,4.91118 -22.99609,5.96484 -37.76544,4.98434 -60.1823,-23.93939 -73.6543,-41.39453 z m 187.10352,45.17969 c -0.88955,0.17553 -1.76385,0.34045 -2.62305,0.49609 v 12.58594 z" />
      </g>
    </svg>
  )
}

// Wrap in `memo` so App-level re-renders (the top of every commit)
// don't propagate through this component. Profile capture at
// v0.2.11.16 showed it rendering 606 times across one session — once
// per commit — because it sits in App's top bar and has no
// memoisation. Its only prop is `className`, a string literal passed
// from App, so default `memo` shallow-equal is sufficient.
export default memo(AccentLogo)
