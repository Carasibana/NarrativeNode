import ImageHoverPreview from '../ImageHoverPreview'
import { useEntitiesStore } from '../../../store/entitiesStore'
import { TYPE_ICONS } from '../../../utils/entityHelpers'
import { BaseChangeChip, NullBadge, OrphanInheritedBadge, trunc } from '../ChangeChipBase'
import { ColourSwatch, ActionGlyphBadge, FallbackSubChip } from './atoms'

// Classify a file_ref into an image / audio / video / null kind. Used to pick
// between thumbnail rendering and emoji icon rendering for media sub-chips.
function getMediaKindFromRef(fileRef) {
  if (!fileRef || typeof fileRef !== 'string') return null
  const dot = fileRef.lastIndexOf('.')
  if (dot === -1) return null
  const ext = fileRef.slice(dot + 1).toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video'
  return null
}

/**
 * Small square visual for a single media file_ref inside a sub-chip.
 *   - image → entity-colour-bordered thumbnail with optional hover preview
 *   - audio → 🎵 emoji icon
 *   - video → 🎬 emoji icon
 *   - null  → ∅ placeholder
 * `withRedX` overlays a red X cross (reused for the 'remove' action).
 * `onClick` — clicking the visual stops propagation and fires the callback,
 * used to open the underlying file in the Media Preview Panel.
 */

/** Resolve an image asset reference to a URL.
 *  - Refs that start with `/` are passed through verbatim (used by the
 *    dev preview panel to point at static assets in `/dev-preview/...`
 *    without going through the project assets API).
 *  - All other refs are project assets — strip any leading `assets/`
 *    and prepend the API route. */
function resolveAssetUrl(ref) {
  if (!ref) return null
  if (ref.startsWith('/')) return ref
  return `/api/project/assets/${ref.replace(/^assets\//, '')}`
}
function MediaRefVisual({ fileRef, entityColour, withRedX = false, onClick, title }) {
  const kind = getMediaKindFromRef(fileRef)
  const imgSize = 16
  const imgBorder = entityColour ? `1.5px solid ${entityColour}` : '1.5px solid #888888'
  const interactive = onClick ? ' cursor-pointer hover:opacity-80 transition-opacity' : ''

  if (!fileRef) {
    return (
      <span className="text-zinc-500 opacity-60 flex-shrink-0" title={title || 'cleared'}>∅</span>
    )
  }

  const redXOverlay = withRedX ? (
    <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 16 16" style={{ width: imgSize, height: imgSize }}>
      <line x1="2" y1="2" x2="14" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="14" y1="2" x2="2" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ) : null

  if (kind === 'image') {
    const assetUrl = resolveAssetUrl(fileRef)
    const inner = (
      <span
        className={`relative flex-shrink-0 inline-block${interactive}`}
        style={{ width: imgSize, height: imgSize }}
        onClick={onClick ? (e) => { e.stopPropagation(); onClick(fileRef) } : undefined}
        title={title}
      >
        <img
          src={assetUrl}
          alt=""
          className="rounded-sm object-cover"
          style={{ width: imgSize, height: imgSize, border: imgBorder }}
        />
        {redXOverlay}
      </span>
    )
    return (
      <ImageHoverPreview src={assetUrl} borderColour={entityColour} size={100}>
        {inner}
      </ImageHoverPreview>
    )
  }

  const emoji = kind === 'audio' ? '🎵' : kind === 'video' ? '🎬' : '📄'
  const emojiBgColour = entityColour ? `${entityColour}22` : '#3f3f4622'
  return (
    <span
      className={`relative inline-flex items-center justify-center flex-shrink-0 rounded-sm${interactive}`}
      style={{
        width: imgSize,
        height: imgSize,
        fontSize: 10,
        lineHeight: 1,
        border: imgBorder,
        backgroundColor: emojiBgColour,
      }}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(fileRef) } : undefined}
      title={title}
    >
      {emoji}
      {redXOverlay}
    </span>
  )
}

/**
 * Chip-styled indicator for a single entity change (add / modify / remove).
 * Used by EntityChip (inside SceneNode) and EntityNode (modifier nodes).
 *
 * Props:
 *   chip — change descriptor produced by computeChangeSubChips():
 *     { action: 'add'|'modify'|'remove', field, oldValue?, newValue?, isColour?, isProfileImage?, oldImageRef?, newImageRef? }
 *     For media attributes the descriptor also carries `isFileAttribute`,
 *     `oldFileRef`, `newFileRef` — the MediaRefVisual handles both thumbnail
 *     (image) and emoji (audio/video) rendering, plus the ∅ clear sentinel.
 *   onDismiss — optional callback; when provided, a dismiss (−) button is rendered on the right,
 *               hidden by default, revealed on chip hover, turns red on button hover
 *   reviewFlagged — boolean; when true, a ⚑ flag icon is shown indicating this field has an
 *               upstream change that may need review
 *   onClick — optional callback; called when the sub-chip body is clicked (used for sidebar tab navigation)
 *   onMediaPreviewClick — optional callback; called with a fileRef when the user clicks
 *               a specific thumbnail/icon inside a media sub-chip. The parent constructs
 *               the preview source descriptor (needs entityId / atNodeId / effective state)
 *               and dispatches `previewStore.openPreview` itself.
 */
export default function ChangeSubChip({ chip, onDismiss, onAddKnowledge, reviewFlagged, onClick, onMediaPreviewClick, entityColour, entityId, entityName, isOrphaned = false }) {
  // Build a Media Preview Panel descriptor for a profile-image change
  // thumbnail. Used by the old / new image previews below so shift-
  // clicking either one opens it in the Media Preview Panel via the
  // same `togglePreview` flow every other "open in preview" surface
  // uses. Returns null when caller didn't supply entity context — the
  // descriptor wouldn't have an addressable source then. The image ref
  // can be either an `assets/<filename>` path or a `data:` URL; route
  // each to the right field on the descriptor.
  const _previewSourceFor = (imageRef) => {
    if (!imageRef || !entityId) return undefined
    return {
      type: 'entity_profile',
      entityId,
      ...(imageRef.startsWith('data:') ? { url: imageRef } : { fileRef: imageRef }),
      entityName: entityName || 'Entity',
      entityColour: entityColour || '#888888',
    }
  }
  // When the parent chip is orphaned (no narrative-flow wire to upstream),
  // there's no chain context to compute a meaningful "before" value, so
  // every modify-action old-value slot is replaced with an OrphanInheritedBadge
  // (`?⚮`) regardless of the field type (text / colour / image / media /
  // intensity). The `new` side still renders normally — the override on
  // the chip is real and user-set. `showOrphanOldValue` is the single
  // gate for that substitution; each modify branch checks it before
  // rendering its type-specific old-value visual.
  const showOrphanOldValue = isOrphaned && chip.action === 'modify'
  // Phase 1.21h — sub-chip layout convention for value-bearing chips:
  //   [glyph pill] FieldName : oldStrike → new
  // The leading pill is glyph-only (ActionGlyphBadge) — the field
  // name renders as plain text after it so chips with long field
  // names don't blow up into a wide uppercase label. `showSymbol={false}`
  // on BaseChangeChip suppresses the wrapper's default action symbol
  // since the pill already provides it.
  const sharedProps = { action: chip.action, showSymbol: false, onDismiss, onAddKnowledge, reviewFlagged, onClick }

  // Phase 1.21h — visually-loud catchall for unknown action values.
  // Every chip.action that lands here without a matching dispatch
  // branch below renders the fallback chip so unhandled cases are
  // immediately visible during development. Action discriminator set
  // is the closed list below; any extension to chip.action also needs
  // a matching dispatch branch.
  const KNOWN_ACTIONS = new Set(['add', 'modify', 'remove', 'list_change', 'rename'])
  if (!KNOWN_ACTIONS.has(chip.action)) {
    return <FallbackSubChip kind={`changesubchip:action=${chip.action ?? 'unknown'}`} payload={chip} />
  }

  // ── Profile image change — thumbnails instead of text ─────────────────────
  if (chip.isProfileImage) {
    const oldUrl = resolveAssetUrl(chip.oldImageRef)
    const newUrl = resolveAssetUrl(chip.newImageRef)
    const imgSize = 16
    const imgBorder = entityColour ? `1.5px solid ${entityColour}` : '1.5px solid #888888'

    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action={chip.action} />
        <span className="text-zinc-400">Profile Image:</span>
        {chip.action === 'modify' && showOrphanOldValue && (
          <>
            <OrphanInheritedBadge />
            <span className="text-zinc-500">→</span>
          </>
        )}
        {chip.action === 'modify' && !showOrphanOldValue && oldUrl && (
          <>
            <ImageHoverPreview src={oldUrl} borderColour={entityColour} size={100} previewSource={_previewSourceFor(chip.oldImageRef)}>
              <span className="relative flex-shrink-0" style={{ width: imgSize, height: imgSize }}>
                <img src={oldUrl} alt="" className="rounded-sm object-cover" style={{ width: imgSize, height: imgSize, border: imgBorder }} />
                <svg className="absolute inset-0" viewBox="0 0 16 16" style={{ width: imgSize, height: imgSize }}>
                  <line x1="2" y1="2" x2="14" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="14" y1="2" x2="2" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
            </ImageHoverPreview>
            <span className="text-zinc-500">→</span>
          </>
        )}
        {chip.action === 'remove' && oldUrl && (
          <ImageHoverPreview src={oldUrl} borderColour={entityColour} size={100} previewSource={_previewSourceFor(chip.oldImageRef)}>
            <span className="relative flex-shrink-0" style={{ width: imgSize, height: imgSize }}>
              <img src={oldUrl} alt="" className="rounded-sm object-cover" style={{ width: imgSize, height: imgSize, border: imgBorder }} />
              <svg className="absolute inset-0" viewBox="0 0 16 16" style={{ width: imgSize, height: imgSize }}>
                <line x1="2" y1="2" x2="14" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="14" y1="2" x2="2" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
          </ImageHoverPreview>
        )}
        {(chip.action === 'add' || chip.action === 'modify') && newUrl && (
          <ImageHoverPreview src={newUrl} borderColour={entityColour} size={100} previewSource={_previewSourceFor(chip.newImageRef)}>
            <img src={newUrl} alt="" className="rounded-sm object-cover flex-shrink-0" style={{ width: imgSize, height: imgSize, border: imgBorder }} />
          </ImageHoverPreview>
        )}
      </BaseChangeChip>
    )
  }

  // ── Colour change ──────────────────────────────────────────────────────────
  if (chip.isColour) {
    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action={chip.action} />
        <span className="flex items-center gap-1 text-zinc-300">
          <span className="opacity-60">Colour:</span>
          {chip.action === 'add' && chip.newValue && <ColourSwatch hex={chip.newValue} />}
          {chip.action === 'modify' && (
            <>
              {showOrphanOldValue ? <OrphanInheritedBadge /> : <ColourSwatch hex={chip.oldValue} />}
              <span className="opacity-60">→</span>
              <ColourSwatch hex={chip.newValue} />
            </>
          )}
          {chip.action === 'remove' && chip.oldValue && (
            <span className="relative inline-flex">
              <ColourSwatch hex={chip.oldValue} />
              <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 10 10" style={{ width: 10, height: 10 }}>
                <line x1="1" y1="1" x2="9" y2="9" stroke="#ef4444" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="9" y1="1" x2="1" y2="9" stroke="#ef4444" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </span>
      </BaseChangeChip>
    )
  }

  // ── Media attribute changes ────────────────────────────────────────────────
  if (chip.isFileAttribute) {
    const oldFilename = chip.oldFileRef ? chip.oldFileRef.split('/').pop() : null
    const newFilename = chip.newFileRef ? chip.newFileRef.split('/').pop() : null

    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action={chip.action} />
        <span className="text-zinc-400">{chip.field}:</span>
        {chip.action === 'modify' && (
          <>
            {showOrphanOldValue ? (
              <OrphanInheritedBadge />
            ) : (
              <MediaRefVisual
                fileRef={chip.oldFileRef}
                entityColour={entityColour}
                withRedX
                onClick={onMediaPreviewClick}
                title={oldFilename ? `${chip.field}: ${oldFilename}` : `${chip.field}: (previous)`}
              />
            )}
            <span className="text-zinc-500">→</span>
            {chip.newFileRef ? (
              <MediaRefVisual
                fileRef={chip.newFileRef}
                entityColour={entityColour}
                onClick={onMediaPreviewClick}
                title={`${chip.field}: ${newFilename}`}
              />
            ) : (
              <span className="text-zinc-500 opacity-60 flex-shrink-0" title={`${chip.field}: cleared`}>∅</span>
            )}
          </>
        )}
        {chip.action === 'add' && (
          <MediaRefVisual
            fileRef={chip.newFileRef}
            entityColour={entityColour}
            onClick={onMediaPreviewClick}
            title={newFilename ? `${chip.field}: added ${newFilename}` : `${chip.field}: added`}
          />
        )}
        {chip.action === 'remove' && (
          <MediaRefVisual
            fileRef={chip.oldFileRef}
            entityColour={entityColour}
            withRedX
            onClick={onMediaPreviewClick}
            title={oldFilename ? `${chip.field}: removed ${oldFilename}` : `${chip.field}: removed`}
          />
        )}
      </BaseChangeChip>
    )
  }

  // ── List attribute ADD (must come before generic add branch) ───────────────
  if (chip.isListAttribute && chip.action === 'add') {
    const items = chip.initialList || []
    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action="add" />
        <span className="text-zinc-400 flex-shrink-0">{chip.field}</span>
        {items.length > 0 && <span className="text-zinc-600">:</span>}
        <span className="flex flex-wrap items-center gap-0.5 min-w-0">
          {items.map((item, itemIdx) => (
            chip.isEntityList ? (
              <EntityListItemChip key={itemIdx} entityId={item} />
            ) : (
              <span
                key={itemIdx}
                className="inline-flex items-center bg-zinc-700/60 text-zinc-200 rounded px-1 py-0 text-[9px]"
                title={item}
              >
                {item}
              </span>
            )
          ))}
        </span>
      </BaseChangeChip>
    )
  }

  // ── List changes (text_list / entity_list) ─────────────────────────────────
  if (chip.action === 'list_change') {
    const ops = chip.listOps || []
    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action="modify" />
        <span className="text-zinc-400 flex-shrink-0">{chip.field}:</span>
        <span className="flex flex-wrap items-center gap-0.5 min-w-0">
          {ops.map((op, opIdx) => (
            chip.isEntityList ? (
              <EntityListOpChip key={`${op.type}-${opIdx}`} op={op} />
            ) : (
              <TextListOpChip key={`${op.type}-${opIdx}`} op={op} />
            )
          ))}
        </span>
      </BaseChangeChip>
    )
  }

  // ── Attribute rename ──────────────────────────────────────────────────────
  if (chip.action === 'rename') {
    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action="modify" />
        <span className="text-zinc-400">Attribute:</span>
        <span className="text-zinc-500 line-through text-[8px]">{chip.field}</span>
        <span className="text-zinc-500">→</span>
        {chip.newValue ? <span className="text-zinc-200">{chip.newValue}</span> : <NullBadge />}
      </BaseChangeChip>
    )
  }

  // Length guard: long values (descriptions, long names) get truncated
  // with `…`; the full text is exposed via a `title` tooltip so the user
  // can hover to read it. Threshold matches the existing `trunc` default
  // (~20 chars) so behaviour is consistent with the per-chip-type
  // renderers in RelChangeChip / RelationshipHistoryChangeChip.
  const TRUNC_LIMIT = 20
  const renderTrunc = (text, cls, style) => {
    if (text == null) return null
    const s = typeof text === 'string' ? text : String(text)
    const isTruncated = s.length > TRUNC_LIMIT
    return (
      <span className={cls} style={style} title={isTruncated ? s : undefined}>
        {isTruncated ? trunc(s, TRUNC_LIMIT) : s}
      </span>
    )
  }

  // Build the expanded-details body for a value-bearing chip when at
  // least one rendered value was actually truncated in the visible row.
  // This is "I want to see the full details" content — never used to
  // hide at-a-glance information.
  const isLongStr = (v) => typeof v === 'string' && v.length > TRUNC_LIMIT
  const buildExpandedBody = (mode) => {
    const newLong = isLongStr(chip.newValue)
    const oldLong = isLongStr(chip.oldValue)
    if (!newLong && !oldLong) return null
    if (mode === 'add') {
      return (
        <div>
          <span className="text-zinc-500">{chip.field}:</span>{' '}
          <span className="text-zinc-200">{chip.newValue}</span>
        </div>
      )
    }
    // modify
    return (
      <div className="space-y-0.5">
        <div>
          <span className="text-zinc-500">{chip.field} (was):</span>{' '}
          <span className="text-zinc-400 line-through">{chip.oldValue ?? ''}</span>
        </div>
        <div>
          <span className="text-zinc-500">{chip.field}:</span>{' '}
          <span className="text-zinc-200">{chip.newValue ?? ''}</span>
        </div>
      </div>
    )
  }

  // ── Generic add ────────────────────────────────────────────────────────────
  if (chip.action === 'add') {
    return (
      <BaseChangeChip {...sharedProps} expandedBody={buildExpandedBody('add')}>
        <ActionGlyphBadge action="add" />
        <span className="text-zinc-400">{chip.field}</span>
        {chip.newValue && (
          <>
            <span className="text-zinc-600">:</span>
            {renderTrunc(chip.newValue, 'text-zinc-200', chip.valueStyle || undefined)}
          </>
        )}
      </BaseChangeChip>
    )
  }

  // ── Generic remove ─────────────────────────────────────────────────────────
  if (chip.action === 'remove') {
    return (
      <BaseChangeChip {...sharedProps}>
        <ActionGlyphBadge action="remove" />
        <span className="text-zinc-400">{chip.field}</span>
      </BaseChangeChip>
    )
  }

  // ── Generic modify ─────────────────────────────────────────────────────────
  return (
    <BaseChangeChip {...sharedProps} expandedBody={buildExpandedBody('modify')}>
      <ActionGlyphBadge action="modify" />
      <span className="text-zinc-400">{chip.field}:</span>
      {showOrphanOldValue
        ? <OrphanInheritedBadge />
        : (chip.oldValue
            ? renderTrunc(chip.oldValue, 'text-zinc-500 line-through text-[8px]', chip.oldValueStyle || undefined)
            : <NullBadge />)}
      <span className="text-zinc-500">→</span>
      {chip.newValue
        ? renderTrunc(chip.newValue, 'text-zinc-200', chip.valueStyle || undefined)
        : <NullBadge />}
    </BaseChangeChip>
  )
}

// ── Helpers for list sub-chip variants ──────────────────────────────────────

/** Text list op chip (used when chip.isEntityList is false). */
function TextListOpChip({ op }) {
  if (op.cancelled) {
    return (
      <span
        className="inline-flex items-center gap-0.5 bg-amber-900/20 border border-amber-700/50 text-amber-500/70 rounded px-1 py-0 text-[9px]"
        title={`Auto-cancelled: was ${op.type === 'add' ? 'added' : 'removed'} here but superseded upstream. Review in Alerts panel.`}
      >
        <span className="font-bold opacity-60">⊘</span>
        <span className="line-through opacity-60">{op.item}</span>
      </span>
    )
  }
  if (op.type === 'add') {
    return (
      <span
        className="inline-flex items-center gap-0.5 bg-green-900/30 border border-green-800/60 text-green-300 rounded px-1 py-0 text-[9px]"
        title={`Added: ${op.item}`}
      >
        <span className="font-bold">+</span>
        <span>{op.item}</span>
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 bg-red-900/30 border border-red-800/60 text-red-300 rounded px-1 py-0 text-[9px]"
      title={`Removed: ${op.item}`}
    >
      <span className="font-bold">−</span>
      <span className="line-through opacity-80">{op.item}</span>
    </span>
  )
}

/**
 * Entity list op chip — looks up the entity by id from entitiesStore and
 * renders a compact chip with the entity's profile image (or type icon),
 * coloured border matching the entity's colour, and the entity name tinted
 * to the op action colour. Used inside list_change sub-chips when the
 * attribute is an entity_list.
 */
function EntityListOpChip({ op }) {
  const entity = useEntitiesStore((s) => {
    const id = op.item
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs]) {
      const found = bucket.find((e) => e.id === id)
      if (found) return found
    }
    return null
  })
  const isAdd = op.type === 'add'
  const isRemove = op.type === 'remove'
  const isCancelled = op.cancelled === true
  const name = entity?.name || '(deleted)'
  const colour = entity?.colour || '#888888'
  const profileRef = entity?.profile_image_ref || null
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null

  if (isCancelled) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1 py-0 text-[9px] border border-amber-700/50 bg-amber-900/20"
        title={`Auto-cancelled: was ${isAdd ? 'added' : 'removed'} here but superseded upstream. Review in Alerts panel.`}
      >
        <span className="text-amber-500/60 font-bold">⊘</span>
        {assetName ? (
          <ImageHoverPreview src={`/api/project/assets/${assetName}`} borderColour={colour} size={80}>
            <img
              src={`/api/project/assets/${assetName}`}
              alt=""
              className="rounded-sm object-cover flex-shrink-0 opacity-40"
              style={{ width: 12, height: 12, border: `1px solid ${colour}66` }}
            />
          </ImageHoverPreview>
        ) : (
          <span
            className="rounded-sm flex items-center justify-center flex-shrink-0 text-[8px] opacity-40"
            style={{ width: 12, height: 12, backgroundColor: colour + '22', border: `1px solid ${colour}66` }}
          >
            {TYPE_ICONS[entity?.type] || '?'}
          </span>
        )}
        <span className="line-through opacity-50" style={{ color: colour }}>{name}</span>
      </span>
    )
  }

  const borderCls = isAdd ? 'border border-green-800/60 bg-green-900/20' : 'border border-red-800/60 bg-red-900/20'
  const prefix = isAdd ? '✚' : '⚊'
  const prefixCls = isAdd ? 'text-green-400 font-bold' : 'text-red-400 font-bold'
  const nameCls = isRemove ? 'line-through opacity-80' : ''
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1 py-0 text-[9px] ${borderCls}`}
      title={isAdd ? `Added: ${name}` : `Removed: ${name}`}
    >
      <span className={prefixCls}>{prefix}</span>
      {assetName ? (
        <ImageHoverPreview src={`/api/project/assets/${assetName}`} borderColour={colour} size={80}>
          <img
            src={`/api/project/assets/${assetName}`}
            alt=""
            className="rounded-sm object-cover flex-shrink-0"
            style={{ width: 12, height: 12, border: `1px solid ${colour}` }}
          />
        </ImageHoverPreview>
      ) : (
        <span
          className="rounded-sm flex items-center justify-center flex-shrink-0 text-[8px]"
          style={{ width: 12, height: 12, backgroundColor: colour + '22', border: `1px solid ${colour}` }}
        >
          {TYPE_ICONS[entity?.type] || '?'}
        </span>
      )}
      <span className={nameCls} style={{ color: isRemove ? undefined : colour }}>{name}</span>
    </span>
  )
}

/**
 * Entity list item chip used inside the initial-add sub-chip (when the
 * entity_list attribute is being introduced at this node). Same look as
 * EntityListOpChip but without the +/− prefix since the entire attribute is
 * green via the parent chip's `+` symbol.
 */
function EntityListItemChip({ entityId }) {
  const entity = useEntitiesStore((s) => {
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs]) {
      const found = bucket.find((e) => e.id === entityId)
      if (found) return found
    }
    return null
  })
  const name = entity?.name || '(deleted)'
  const colour = entity?.colour || '#888888'
  const profileRef = entity?.profile_image_ref || null
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
  return (
    <span
      className="inline-flex items-center gap-1 bg-zinc-700/60 rounded px-1 py-0 text-[9px]"
      title={name}
    >
      {assetName ? (
        <img
          src={`/api/project/assets/${assetName}`}
          alt=""
          className="rounded-sm object-cover flex-shrink-0"
          style={{ width: 12, height: 12, border: `1px solid ${colour}` }}
        />
      ) : (
        <span
          className="rounded-sm flex items-center justify-center flex-shrink-0 text-[8px]"
          style={{ width: 12, height: 12, backgroundColor: colour + '22', border: `1px solid ${colour}` }}
        >
          {TYPE_ICONS[entity?.type] || '?'}
        </span>
      )}
      <span style={{ color: colour }}>{name}</span>
    </span>
  )
}
