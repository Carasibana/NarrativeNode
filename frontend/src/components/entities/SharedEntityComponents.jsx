import { useState, useRef, useLayoutEffect } from 'react'
import { ATTR_TYPE_COLOURS, ATTR_TYPE_LABELS, TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'

// ── CollapsibleDescription (Phase 4.2) ──────────────────────────────────────────
//
// Read-only description body for Circumstance / Motivator / Perspective
// rows in the detail sidebar, where the whole row is click-to-open-editor
// and a long description otherwise eats vertical space with no way to
// compact it. Collapsed (default): the text is clamped to `clampLines`
// lines with a trailing ellipsis. Expanded: full text. A small chevron
// toggles, and appears ONLY when the text actually overflows the clamp
// (decision 2026-06-13 — these are read-only, so there's no compose-from-
// empty case that justified the always-on chevron on editable text
// attributes; a short description that fits gets no control).
//
// The chevron's click `stopPropagation`s so it never triggers the row's
// open-editor handler. The intensity label (C/M only) rides the `footer`
// slot so it sits on the same line as the chevron, below the text, and
// is never itself clamped. Expanded state is component-local and resets
// on remount.
export function CollapsibleDescription({ text, clampLines = 2, footer = null, textClassName = '' }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => {
      // Overflow is only measurable against the clamped DOM. When
      // expanded the clamp is off (scrollHeight == clientHeight), so
      // skip — keep the flag set so the collapse chevron stays visible.
      if (expanded) return
      setOverflowing(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    // Re-measure on width change — the detail sidebar is resizable, so a
    // description that fit at one width can overflow at a narrower one.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded, clampLines])

  const clampStyle = expanded ? undefined : {
    display: '-webkit-box',
    WebkitLineClamp: clampLines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={`whitespace-pre-wrap break-words ${textClassName}`}
        style={clampStyle}
      >
        {text}
      </div>
      {(overflowing || footer) && (
        // Footer (e.g. the C/M intensity label) sits bottom-left; the
        // chevron is pinned bottom-RIGHT so it lines up with the
        // ExpandableTextField chevron on the text attributes that share
        // this panel (request 2026-06-13). `justify-between` keeps the
        // chevron flush right whether or not a footer is present.
        <div className="flex items-center justify-between gap-1.5 mt-0.5">
          <span className="min-w-0">{footer}</span>
          {overflowing && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
              title={expanded ? 'Collapse' : 'Show full text'}
              aria-label={expanded ? 'Collapse description' : 'Expand description'}
              aria-expanded={expanded}
              className="flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors inline-flex items-center"
            >
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
                <path d="M4 6 L8 10 L12 6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── ExpandableTextField (Phase 4.2) ─────────────────────────────────────────────
//
// Readable / editable field for `text` attribute values in the detail
// sidebar. Collapsed (default): today's single-line <input>, value
// visually truncated with a CSS ellipsis at rest so a long imported
// value (e.g. a ~2000-char Novelcrafter "Unique abilities" block)
// signals it's cut off instead of silently overflowing. Expanded: a
// resizable multi-line <textarea> (user drags its height) showing the
// same value, fully editable with wrapping.
//
// Expanded state is component-local and NOT persisted — every remount
// of the detail panel resets to collapsed, keeping the resting view
// compact (planning doc §A). Independent per-field toggle (not an
// accordion) so two values can be opened and compared at once.
//
// Storage is unchanged: the value stays a plain string; this is pure
// presentation. `extraProps` passes through any field-specific
// attributes (e.g. the easter-egg data-* hook) onto the active control.
export function ExpandableTextField({
  value,
  placeholder,
  onChange,
  onKeyDown,
  className = '',
  extraProps = {},
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div data-help-region="badge:expandable_text_field" className="flex items-start gap-1">
      {expanded ? (
        <textarea
          className={`flex-1 min-w-0 resize-y leading-snug ${className}`}
          rows={4}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          {...extraProps}
        />
      ) : (
        <input
          className={`flex-1 min-w-0 text-ellipsis ${className}`}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          {...extraProps}
        />
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse to a single line' : 'Expand to a resizable multi-line field'}
        aria-label={expanded ? 'Collapse field' : 'Expand field'}
        aria-expanded={expanded}
        className="mt-0.5 flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <path d="M4 6 L8 10 L12 6" />
        </svg>
      </button>
    </div>
  )
}

// ── AttrTypeTag ─────────────────────────────────────────────────────────────────

export function AttrTypeTag({ type, orphaned }) {
  if (type === 'preset' && orphaned) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-red-900/60 text-red-300" title="The preset list this attribute referenced has been deleted. Create a new list with the same name to re-link.">
        Orphaned Preset ⚠
      </span>
    )
  }
  return <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${ATTR_TYPE_COLOURS[type] || ''}`}>{ATTR_TYPE_LABELS[type]}</span>
}

// ── FileAttrPreview ─────────────────────────────────────────────────────────────

export function FileAttrPreview({ fileRef }) {
  if (!fileRef) return null
  const name = fileRef.split('/').pop()
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
  if (isImage) {
    return (
      <img
        src={`/api/project/assets/${name}`}
        alt={name}
        className="h-8 w-8 object-cover rounded border border-zinc-600"
        onError={e => { e.target.style.display = 'none' }}
      />
    )
  }
  return <span className="text-xs text-zinc-400 bg-zinc-700 px-2 py-0.5 rounded">{name}</span>
}

// ── FileAttrInput ───────────────────────────────────────────────────────────────

const FILE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/mp4,video/mp4,video/webm,video/quicktime,video/x-msvideo,application/pdf,text/plain,text/markdown,.md'

export function FileAttrInput({ fileRef, onChange, compact, triggerRef }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  // Expose the file picker trigger so parents can open it programmatically (e.g. Enter key)
  if (triggerRef) triggerRef.current = () => inputRef.current?.click()

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/project/assets/upload', { method: 'POST', body: fd })
      const data = await res.json()
      onChange(data.file_ref)
    } catch (err) {
      console.error('File upload failed:', err)
    } finally {
      setUploading(false)
      if (e.target) e.target.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={FILE_ACCEPT}
        onChange={handleFile}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className={`text-xs ${compact ? 'text-zinc-500 hover:text-zinc-300' : 'text-accent-400 hover:text-accent-300'}`}
      >
        {uploading ? 'Uploading…' : fileRef ? (compact ? 'Change…' : 'Change file…') : (compact ? 'Upload…' : 'Upload file…')}
      </button>
    </>
  )
}

// ── ChangeBadge ─────────────────────────────────────────────────────────────────
// Shared badge for add / remove / modify change indicators.
// Used in RelationshipRow, attribute lists, OverrideRow, and any other place
// in the sidebar where a change at this chain position needs to be indicated.

export function ChangeBadge({ action }) {
  if (action === 'add')    return <span data-help-region="badge:change_indicator" className="text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 text-green-400">✚ADDED</span>
  if (action === 'remove') return <span data-help-region="badge:change_indicator" className="text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 text-red-400">⚊REMOVED</span>
  if (action === 'modify') return <span data-help-region="badge:change_indicator" className="text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 text-amber-400">✱MODIFIED</span>
  if (action === 'rename') return <span data-help-region="badge:change_indicator" className="text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 text-amber-400">✱RENAMED</span>
  return null
}

// ── RelationshipRow ─────────────────────────────────────────────────────────────
// Unified display component for a single relationship row in the sidebar.
// Used by EntityNodeDetailView, EntityChipDetailView, and EntityNodeModifierView.
//
// The initial-state view format (card container, proper input, entity-name placeholder)
// is THE REFERENCE — all chain positions use this same format.

export function RelationshipRow({
  relatedEntity,
  description,
  onDescriptionChange,
  onRemove,
  isRemoved,
  onUndoRemove,
  changeAction,
  entityName,
  hasDescOverride,
  onClearDescOverride,
  onNavigate,
  partnerAliases,
  aliasOverride,
  onAliasOverrideChange,
  readOnly,
}) {
  if (!relatedEntity) return null

  const badgeAction = isRemoved ? 'remove' : changeAction
  const colour = relatedEntity.colour || '#888888'
  const profileRef = relatedEntity.profile_image_ref || null
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null

  // Normalise Alias objects to plain strings for rendering and comparison
  const aliases = (partnerAliases || []).map((a) => (typeof a === 'string' ? a : a.value))
  const showAliasDropdown = !readOnly && !isRemoved && !!onAliasOverrideChange && (aliases.length > 0 || aliasOverride != null)
  const isStaleAlias = aliasOverride != null && !aliases.includes(aliasOverride)

  return (
    <div data-help-region="badge:relationship_row" className="mb-2 bg-zinc-800/40 border border-zinc-700/50 rounded px-2 py-1.5 group">
      <div className="flex gap-2 mb-1">
        {/* Profile image (or type icon) — taller, spans both meta row and name/dropdown row */}
        {assetName ? (
          <ImageHoverPreview src={`/api/project/assets/${assetName}`} borderColour={colour} size={100}>
            <button
              type="button"
              onClick={() => onNavigate?.(relatedEntity.id)}
              disabled={!onNavigate}
              className={`flex-shrink-0 self-stretch flex items-center ${isRemoved ? 'opacity-40' : ''} ${onNavigate ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
              title={onNavigate ? `Navigate to ${relatedEntity.name}` : relatedEntity.name}
            >
              <img
                src={`/api/project/assets/${assetName}`}
                alt=""
                className="rounded-sm object-cover"
                style={{ width: 28, height: 28, border: `1.5px solid ${colour}` }}
              />
            </button>
          </ImageHoverPreview>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate?.(relatedEntity.id)}
            disabled={!onNavigate}
            className={`rounded-sm flex items-center justify-center flex-shrink-0 self-stretch text-[10px] ${isRemoved ? 'opacity-40' : ''} ${onNavigate ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
            style={{ width: 28, minHeight: 28, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
            title={onNavigate ? `Navigate to ${relatedEntity.name}` : relatedEntity.name}
          >
            {TYPE_ICONS[relatedEntity.type] || '?'}
          </button>
        )}

        {/* Right column: type+badges row on top, name/dropdown row below */}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {/* Row 1: type label, change badge, undo/remove buttons */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-zinc-600 capitalize">{relatedEntity.type}</span>
            {badgeAction && <ChangeBadge action={badgeAction} />}
            {isRemoved && onUndoRemove && (
              <button
                onClick={onUndoRemove}
                className="text-[9px] text-amber-500 hover:text-amber-300 flex-shrink-0"
                title="Undo remove"
              >
                ↩
              </button>
            )}
            {!isRemoved && onRemove && (
              <button
                onClick={onRemove}
                className="text-[11px] font-bold text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 leading-none"
                title={changeAction === 'add' ? 'Undo add' : 'Remove relationship'}
              >
                −
              </button>
            )}
          </div>

          {/* Row 2: alias dropdown (if available) or entity name button/label */}
          {showAliasDropdown ? (
            <div className="flex items-center gap-1">
              <select
                value={aliasOverride ?? ''}
                onChange={(e) => onAliasOverrideChange(e.target.value === '' ? null : e.target.value)}
                className={`flex-1 min-w-0 bg-zinc-800 border rounded px-1 py-0 text-xs focus:outline-none focus:border-accent-500 ${isStaleAlias ? 'border-amber-500 text-amber-400' : 'border-zinc-600 text-zinc-300'}`}
                title={isStaleAlias ? `Alias "${aliasOverride}" no longer exists on ${relatedEntity.name}` : `Known as...`}
              >
                <option value="">{relatedEntity.name}</option>
                {aliases.map((a) => <option key={a} value={a}>{a}</option>)}
                {isStaleAlias && <option value={aliasOverride}>{aliasOverride} (removed)</option>}
              </select>
              {isStaleAlias && (
                <span className="text-amber-500 flex-shrink-0 text-xs" title={`Alias "${aliasOverride}" no longer exists`}>⚠</span>
              )}
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate(relatedEntity.id)}
                  className="flex-shrink-0 text-zinc-500 hover:text-accent-400 text-xs leading-none"
                  title={`Navigate to ${relatedEntity.name}`}
                >
                  →
                </button>
              )}
            </div>
          ) : onNavigate ? (
            <button
              type="button"
              onClick={() => onNavigate(relatedEntity.id)}
              className={`text-xs text-left leading-tight ${isRemoved ? 'line-through text-zinc-600' : 'text-zinc-300 hover:text-accent-300'}`}
              title={`Navigate to ${relatedEntity.name}`}
            >
              <span className="block truncate">{aliasOverride ?? relatedEntity.name}</span>
              {aliasOverride != null && !isRemoved && (
                <span className="block text-[9px] italic truncate" style={{ color: colour }}>alias of {relatedEntity.name}</span>
              )}
            </button>
          ) : (
            <span className={`text-xs leading-tight ${isRemoved ? 'line-through text-zinc-600' : 'text-zinc-300'}`}>
              <span className="block truncate">{aliasOverride ?? relatedEntity.name}</span>
              {aliasOverride != null && !isRemoved && (
                <span className="block text-[9px] italic truncate" style={{ color: colour }}>alias of {relatedEntity.name}</span>
              )}
            </span>
          )}
        </div>
      </div>
      {!isRemoved && (
        <div className="flex items-center gap-1">
          <input
            className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-400 focus:outline-none focus:border-accent-500 placeholder:text-zinc-700"
            placeholder={`${entityName}'s perspective…`}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
          {hasDescOverride && onClearDescOverride && (
            <button
              onClick={onClearDescOverride}
              className="text-[11px] font-bold text-zinc-600 hover:text-red-400 flex-shrink-0 leading-none"
              title="Clear description override"
            >
              −
            </button>
          )}
        </div>
      )}
      {isRemoved && <p className="text-[9px] text-red-400 italic">Removed at this scene</p>}
    </div>
  )
}
