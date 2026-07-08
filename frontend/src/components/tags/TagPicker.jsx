/**
 * Phase 2.6 — Object-type-agnostic tag picker.
 *
 * Type-ahead UI for attaching one or more tags to a single object.
 * Renders the object's currently-attached tags as a strip of small
 * "attached" chips at the top (each with a × to detach), then a
 * text input below for typing a new tag. The input shows
 * suggestions filtered from `suggestedTags` (typically the union
 * of all known tags across the calling subsystem) — clicking a
 * suggestion adds it to the object. Enter on a non-matching string
 * adds it as a brand-new tag.
 *
 * Props:
 *   currentTags    — tags currently attached to the object (string[])
 *   suggestedTags  — known tag pool to suggest from (string[]). May
 *                    include tags already in `currentTags` — the
 *                    component filters them out of suggestions.
 *   onAdd(tag)     — called when the writer attaches a tag.
 *   onRemove(tag)  — called when the writer detaches a tag.
 *   placeholder    — input placeholder; default "Add tag…".
 *   maxSuggestions — cap the suggestion list (default 20) so a huge
 *                    tag pool doesn't blow out the dropdown.
 *   renderAttachedChip(tag, { onRemove })  — optional. Override the
 *                    default muted-chip rendering for an attached
 *                    tag. Used by `ProjectTagPicker` (Phase 3.4e) to
 *                    render `TagBadge`s in the pool's tag colour.
 *                    When omitted, falls back to the default chip.
 *   addNewLabelFor(query)  — optional. Returns the hint text shown
 *                    in the dropdown when the typed query doesn't
 *                    match any suggestion (defaults to the existing
 *                    'Press Enter to add "X" as a new tag.'). Used
 *                    by `ProjectTagPicker` to phrase the find-or-
 *                    create hint per pool (e.g. "Press Enter to
 *                    create a new Project Tag").
 *   chipsPosition  — `'above' | 'below'`, default `'above'`. Where
 *                    the attached-tag chip strip renders relative to
 *                    the type-ahead input. Existing program-tag
 *                    callers keep `'above'`; `ProjectTagPicker`
 *                    (Phase 3.4e) uses `'below'`.
 *
 * Caller owns persistence — this component is pure UI. Typical
 * pattern: caller's `onAdd` writes the tag to the object's
 * `tags: List[str]` field via its own store action.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

function _norm(t) {
  return (typeof t === 'string' ? t : '').trim().toLowerCase()
}

export default function TagPicker({
  currentTags,
  suggestedTags,
  onAdd,
  onRemove,
  placeholder = 'Add tag…',
  maxSuggestions = 20,
  autoFocus = false,
  renderAttachedChip,
  addNewLabelFor,
  chipsPosition = 'above',
  compact = false,
  showAddButton = false,
}) {
  const [query, setQuery] = useState('')
  // -1 = no suggestion explicitly highlighted; Enter in this state
  // commits the literal typed query (find-or-create). ArrowDown
  // moves into the suggestion list; ArrowUp from index 0 returns to
  // -1 so the writer can fall back to the literal-query commit
  // without leaving the input.
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  // Lower-cased set of already-attached tags, used to filter
  // suggestions and to short-circuit the "add new" path when the
  // writer types a name that matches an attached tag.
  const attachedLowerSet = useMemo(() => {
    const s = new Set()
    for (const t of (currentTags || [])) s.add(_norm(t))
    return s
  }, [currentTags])

  // Suggestion list: union of suggestedTags minus already-attached,
  // filtered by query substring. Lower-cased dedup keyed; original
  // casing preserved for display via a first-seen map.
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const seen = new Map()
    for (const t of (suggestedTags || [])) {
      if (typeof t !== 'string') continue
      const key = _norm(t)
      if (!key) continue
      if (attachedLowerSet.has(key)) continue
      if (seen.has(key)) continue
      if (q && !key.includes(q)) continue
      seen.set(key, t.trim())
    }
    const out = Array.from(seen.values())
    out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    return out.slice(0, maxSuggestions)
  }, [suggestedTags, attachedLowerSet, query, maxSuggestions])

  // Visual highlight index inside the dropdown. -1 = no suggestion
  // is the active target; in that state, Enter commits the literal
  // typed query (find-or-create) rather than the first substring
  // match. Avoids the surprise of typing "C" and getting "Come on"
  // committed just because "Come on" happens to substring-match.
  // ArrowDown moves into the list; the clamp also keeps the visual
  // sane if the suggestion set shrinks under a previously-valid
  // highlight (the index gets pulled to the new last row).
  const visualHighlight =
    highlightIdx < 0 || suggestions.length === 0
      ? -1
      : Math.min(highlightIdx, suggestions.length - 1)

  function commit(tagText) {
    const trimmed = (tagText || '').trim()
    if (!trimmed) return
    if (attachedLowerSet.has(trimmed.toLowerCase())) {
      // Already attached — clear the input so the writer can move on.
      setQuery('')
      return
    }
    onAdd?.(trimmed)
    setQuery('')
    setHighlightIdx(-1)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Commit the highlighted suggestion only when the writer has
      // explicitly arrowed into it. Otherwise commit the literal
      // typed query — Enter means "go with what I typed".
      if (visualHighlight >= 0 && suggestions.length > 0) {
        commit(suggestions[visualHighlight])
      } else {
        commit(query)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestions.length === 0) return
      // From -1 (no highlight) ArrowDown moves into the first row;
      // subsequent ArrowDowns walk further; clamps at the last row.
      setHighlightIdx((i) => Math.min(suggestions.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestions.length === 0) return
      // ArrowUp from index 0 returns to -1 (no highlight) so the
      // writer can fall back to literal-query Enter without leaving
      // the input.
      setHighlightIdx((i) => Math.max(-1, i - 1))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      setHighlightIdx(-1)
    }
  }

  // Attached tag chips — each with × to detach. When the caller
  // supplies a `renderAttachedChip` render-prop, defer to it so
  // callers like `ProjectTagPicker` can render `TagBadge`s in the
  // pool's tag colour instead of the default muted chip.
  const chipsBlock = (currentTags || []).length > 0 ? (
    <div className="flex flex-wrap gap-1">
      {(currentTags || []).map((tag) => (
        renderAttachedChip
          ? <span key={tag}>{renderAttachedChip(tag, { onRemove: () => onRemove?.(tag) })}</span>
          : (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 bg-zinc-800/70 text-zinc-300 text-[10px] px-1.5 py-0.5 rounded border border-zinc-700"
            >
              <span className="truncate max-w-[12rem]">{tag}</span>
              <button
                type="button"
                onClick={() => onRemove?.(tag)}
                className="ml-0.5 text-zinc-500 hover:text-red-300 leading-none"
                title="Detach this tag"
              >
                ✕
              </button>
            </span>
          )
      ))}
    </div>
  ) : null

  // `compact` matches the inline aliases-editor sizing so the Tags row
  // visually rhymes with the Aliases row in the entity detail panel
  // (text-[10px] + py-0.5 instead of text-xs + py-1). Program-tag
  // callers (cues, conversations) leave it false and keep the
  // original chunkier sizing.
  const inputSizeCls = compact ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2 py-1'
  const buttonSizeCls = compact ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2 py-1'

  const inputBlock = (
    <div className="relative">
      <div className={showAddButton ? 'flex gap-1' : ''}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHighlightIdx(-1) }}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setQuery(''); setHighlightIdx(-1) }}
          placeholder={placeholder}
          className={`${showAddButton ? 'flex-1' : 'w-full'} bg-zinc-800 text-zinc-100 ${inputSizeCls} rounded border border-zinc-700 focus:outline-none focus:border-accent-500 placeholder:text-zinc-600`}
        />
        {showAddButton && (
          // `onMouseDown` default-prevented so clicking the button
          // doesn't blur the input (which would clear the query
          // before our onClick fires). Same trick the suggestion
          // dropdown uses.
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(query)}
            className={`inline-flex items-center justify-center ${buttonSizeCls} leading-none font-bold rounded border border-zinc-700 bg-zinc-800 text-accent-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300 transition-colors`}
            title="Add tag"
          >
            {/* `+` glyph sits visually low in most sans-serif fonts
                because flex-centering the line-box doesn't account
                for the character's own typographic offset. A 1px
                lift pulls it onto the optical centre, matching the
                same fix used by other button glyphs in this file. */}
            <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1px)' }}>+</span>
          </button>
        )}
      </div>
      {focused && query.trim() && suggestions.length > 0 && (
        // `onMouseDown` default-prevented so clicking a suggestion
        // doesn't blur the input mid-click (which would kill the
        // dropdown before the click handler fires). Standard pattern.
        <div
          className="absolute left-0 right-0 top-full mt-0.5 bg-zinc-900 border border-zinc-700 rounded shadow-lg z-10 max-h-48 overflow-y-auto"
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s}
              onClick={() => commit(s)}
              onMouseEnter={() => setHighlightIdx(i)}
              className={`w-full text-left text-xs px-2 py-1 truncate ${
                i === visualHighlight
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {focused && query.trim() && suggestions.length === 0 && (
        <div className="absolute left-0 right-0 top-full mt-0.5 bg-zinc-900 border border-zinc-700 rounded shadow-lg z-10 px-2 py-1 text-[10px] text-zinc-500 italic">
          {addNewLabelFor
            ? addNewLabelFor(query.trim())
            : <>Press Enter to add &quot;{query.trim()}&quot; as a new tag.</>}
        </div>
      )}
    </div>
  )

  // Order the two blocks based on `chipsPosition`. The 'below' path
  // means the chip strip renders UNDER the input row; useful when
  // the picker sits in a section where attached badges are the
  // visual focus AFTER the writer commits a new tag (Phase 3.4e).
  return (
    <div className="space-y-1.5" data-help-region="tag-picker:input">
      {chipsPosition === 'below' ? inputBlock : chipsBlock}
      {chipsPosition === 'below' ? chipsBlock : inputBlock}
    </div>
  )
}
