/**
 * Shared identity-header shell for every Detail Panel mode (scene / entity /
 * relationship / knowledge). Owns the container dimensions + spacing + Row 1
 * "TYPE : NAME" frame + optional Row 1.5 subtitle + Row 2 avatar slot, so
 * navigation between panels always lands those elements in the exact same
 * screen position. Each panel keeps its own interior logic (name edit
 * semantics, border colours, avatar content) and passes it in via slots.
 *
 * Layout:
 *
 *   ┌─── outer (border-b, minHeight 100, justify-center) ─────────────────┐
 *   │                                                                     │
 *   │   ┌─── Row 1 + optional Row 1.5 wrapper (no outer gap) ──────────┐  │
 *   │   │   [TYPE] : [nameSlot] [trailingAfterName]                    │  │
 *   │   │   [subtitleSlot — only relationship today]                   │  │
 *   │   └──────────────────────────────────────────────────────────────┘  │
 *   │                                                                     │
 *   │   Row 2: [row2Slot — 48px avatar / participant cascade / null]      │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * `minHeight: 100` + `justify-center` is deliberate: a scene (no avatar,
 * no subtitle) and an entity (avatar) and a relationship (subtitle +
 * participant cascade) all land inside the same reserved space, all
 * vertically centred. The header outer dimensions stay byte-identical
 * between panels.
 */
export default function DetailPanelIdentityHeader({
  typeLabel,
  typeColourClass = 'text-accent-400',
  typeColour = null,  // optional hex string; when provided, overrides typeColourClass via inline style
  typeIcon = null,
  useCompactIcon = false,
  letterSpacing = '0.25em',
  nameSlot,
  trailingAfterName = null,
  subtitleSlot = null,
  row2Slot = null,
  // Phase 2.7a — optional slot anchored to the lower-right of the
  // header band. Used today by the "Add as context" affordance, which
  // is only rendered when the chat panel is open on a conversation
  // (the caller passes null otherwise).
  cornerAction = null,
  // Phase 3.4h — optional slot anchored to the lower-left of the
  // header band, mirroring `cornerAction`. Today the Entity + Knowledge
  // detail panels mount their colour-edit chip here (relocated from the
  // scrollable body so the body's vertical real estate isn't crowded
  // by a one-row colour control). Panels that don't carry a colour
  // (relationship, scene) pass null.
  cornerActionLeft = null,
}) {
  return (
    <div
      className="px-3 py-2 border-b border-zinc-700 flex flex-col gap-1.5 flex-shrink-0 justify-center relative"
      style={{ minHeight: 100 }}
      data-help-region="detail-panel:header"
    >
      {cornerActionLeft && (
        <div className="absolute bottom-1.5 left-2 flex items-center">
          {cornerActionLeft}
        </div>
      )}
      {cornerAction && (
        <div className="absolute bottom-1.5 right-2 flex items-center">
          {cornerAction}
        </div>
      )}
      {/* Row 1 + optional Row 1.5 wrapper — no gap between them, so the
          subtitle sits tight against Row 1 while the outer gap-1.5 still
          separates the wrapper from Row 2. */}
      <div className="flex flex-col">
        {/* Row 1: TYPE : nameSlot [trailingAfterName] */}
        <div className="w-full flex justify-center" data-help-region="detail-panel:header_name">
          <div className="flex items-center gap-1 max-w-full overflow-hidden">
            {useCompactIcon && typeIcon ? (
              typeIcon
            ) : (
              <>
                <span
                  className={`text-[10px] uppercase flex-shrink-0${typeColour ? '' : ` ${typeColourClass}`}`}
                  style={typeColour ? { letterSpacing, color: typeColour } : { letterSpacing }}
                  data-help-region="detail-panel:header_type"
                >
                  {typeLabel}
                </span>
                <span className="text-[10px] text-zinc-500 flex-shrink-0">:</span>
              </>
            )}
            {nameSlot}
            {trailingAfterName}
          </div>
        </div>

        {/* Row 1.5: optional subtitle, centred. Only the relationship panel
            uses this today (participant-fallback synthesis under a custom
            name). Rendered with leading-none so the subtitle sits tight
            against Row 1 baseline. */}
        {subtitleSlot && (
          <div className="w-full flex justify-center leading-none">
            {subtitleSlot}
          </div>
        )}
      </div>

      {/* Row 2: avatar slot — 48px avatar (entity / knowledge), cascading
          participant avatars (relationship), or null (scene — reserved
          space stays centred above). */}
      {row2Slot}
    </div>
  )
}
