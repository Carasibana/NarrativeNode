/**
 * OriginNodeDescription — shared description block rendered on the
 * canvas for "origin" nodes (RelationshipOriginNode, KnowledgeOriginNode,
 * etc.) when the origin's object has a non-empty description set.
 *
 * Uses the same visual treatment as the entity origin node's description
 * block (rounded inner container + tinted header row + scrollable text
 * area), with the accent tint driven by the parent node's identity
 * colour. Returns null when the description is empty so the node stays
 * compact.
 *
 * Props:
 *   description    — the chain-resolved description string, or null/empty.
 *   accentColour   — hex colour used to tint the header + border.
 *   maxHeight      — text-area scroll cap in px. Defaults to 80.
 *   containerClass — optional outer wrapper className override; defaults
 *                    to `px-2 pb-2 flex flex-col`.
 */
export default function OriginNodeDescription({
  description,
  accentColour,
  maxHeight = 80,
  containerClass = 'px-2 pb-2 flex flex-col',
}) {
  if (!description) return null
  return (
    <div className={containerClass} data-help-region="entity-origin:description">
      <div
        className="rounded overflow-hidden flex flex-col"
        style={{ border: `1px solid ${accentColour}55` }}
      >
        <div
          className="flex items-center gap-1 text-[8px] select-none flex-shrink-0"
          style={{
            backgroundColor: `${accentColour}11`,
            borderBottom: `1px solid ${accentColour}33`,
            padding: '1px 6px',
          }}
        >
          <span className="text-zinc-500 uppercase tracking-wider">Description</span>
        </div>
        <div
          className="overflow-y-auto text-[9px] text-zinc-400 break-words nowheel px-1.5 py-1"
          style={{ maxHeight }}
        >
          {description}
        </div>
      </div>
    </div>
  )
}
