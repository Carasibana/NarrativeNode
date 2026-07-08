/**
 * Phase 5.2b — bundled default book-cover placeholder.
 *
 * Rendered wherever a story has no cover image. A self-contained SVG
 * (no binary asset to bundle) at a 2:3 portrait ratio so it drops into
 * the same slots a real cover fills: the Story Settings cover control
 * now, the Story Library cards later. Fills its container; give the
 * wrapping element the size / aspect.
 *
 * The backend's separate "bundled default cover" used for thumbnail
 * caching (the library cover-resolution fallback) arrives with Phase
 * 5.3 — this component is the frontend display placeholder.
 */
export default function CoverPlaceholder({ className = '', title }) {
  return (
    <svg
      viewBox="0 0 200 300"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={title || 'No cover image'}
    >
      <rect x="0" y="0" width="200" height="300" fill="#27272a" />
      <rect x="0.5" y="0.5" width="199" height="299" fill="none" stroke="#3f3f46" />
      {/* spine */}
      <rect x="14" y="0" width="3" height="300" fill="#3f3f46" />
      {/* simple "open book" glyph, centred */}
      <g stroke="#52525b" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M58 120 q42 -16 42 0 v60 q-42 -16 -42 0 z" />
        <path d="M142 120 q-42 -16 -42 0 v60 q42 -16 42 0 z" />
        <line x1="100" y1="120" x2="100" y2="180" />
      </g>
      <text
        x="100"
        y="212"
        textAnchor="middle"
        fontSize="12"
        fill="#52525b"
        fontFamily="system-ui, sans-serif"
      >
        No cover
      </text>
    </svg>
  )
}
