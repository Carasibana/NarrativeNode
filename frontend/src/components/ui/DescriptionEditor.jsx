/**
 * DescriptionEditor — shared description-field editor used wherever an
 * object's description is shown / edited (Detail Panels for entities,
 * relationships, knowledges, scenes; modals for entities and knowledges).
 *
 * Controlled component: caller owns the draft / dirty state and the
 * commit timing (commit-on-blur, draft + Save button, etc). The
 * component renders the label + textarea and forwards changes via
 * `onChange`. Visual treatment is unified — same focus border colour
 * (accent), same background, same text colour everywhere — so
 * descriptions feel like the same field across surfaces.
 *
 * Props:
 *   value              — current text (controlled).
 *   onChange           — fired with the next string on every keystroke.
 *   onBlur             — optional; fires when textarea loses focus
 *                        (commit-on-blur consumers hook here).
 *   placeholder        — empty-state placeholder text.
 *   rows               — initial textarea row count.
 *   disabled           — read-only mode.
 *   labelExtra         — optional node rendered after the "Description"
 *                        label (e.g. an inline badge or revert button).
 *   belowLabel         — optional node rendered between the label row
 *                        and the textarea (e.g. an "inherited from
 *                        upstream" hint when used as a chain-anchor
 *                        override editor).
 *   resize             — 'y' (default; user can drag-resize vertically)
 *                        or 'none' (fixed height; consumers driving
 *                        height externally pass 'none').
 *   textareaStyle      — optional inline style applied to the textarea
 *                        (e.g. consumers driving a custom height pass
 *                        `{ height: <px> }` here alongside resize='none').
 *   containerClassName — outer wrapper className override; defaults to
 *                        a `mb-3` block. Pass an empty string when the
 *                        consumer manages spacing externally.
 */
export default function DescriptionEditor({
  value,
  onChange,
  onFocus,
  onBlur,
  placeholder = 'Description…',
  rows = 4,
  disabled = false,
  labelExtra = null,
  belowLabel = null,
  resize = 'y',
  textareaStyle = undefined,
  containerClassName = 'mb-3',
  // When true, suppresses the built-in "DESCRIPTION" label row.
  // Consumers driving their own external section header (e.g. the
  // Scene Description Section in the editor panel) pass true so the
  // label can sit alongside other rows rather than be welded above
  // the textarea.
  hideLabel = false,
}) {
  const resizeCls = resize === 'none' ? 'resize-none' : 'resize-y'
  return (
    <div className={containerClassName}>
      {!hideLabel && (
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Description</label>
          {labelExtra}
        </div>
      )}
      {belowLabel}
      <textarea
        data-help-region="detail-panel:details_description"
        name="description"
        aria-label={placeholder}
        className={`w-full text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-500 ${resizeCls} leading-snug disabled:opacity-60 disabled:cursor-not-allowed`}
        rows={rows}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        style={textareaStyle}
      />
    </div>
  )
}
