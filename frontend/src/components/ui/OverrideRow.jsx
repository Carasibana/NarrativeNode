/**
 * OverrideRow — Phase 1.21d Step E
 *
 * Layer 2 detail-panel-section component. One editable field with an
 * inherited-from-upstream fallback value. Used by every detail view
 * that lets the user override a chain-tracked scalar field at a
 * specific chain anchor (entity name / colour / description at a
 * scene chip or modifier; same shape applies to other surfaces if /
 * when they wire chain-time overrides).
 *
 * Renders:
 *   - Label row with `<ChangeBadge action="modify" />` + bare `✕`
 *     revert button shown only when an override is active.
 *   - Inherited-from-upstream hint (italic `↳ {inheritedValue}`)
 *     shown only when there's no override AND the inherited value is
 *     actual prose the user can't see in the input's placeholder.
 *   - The input itself — text input, textarea, or colour swatch +
 *     picker depending on `type`.
 *
 * Behaviour:
 *   - On focus with no override: pre-populates local state with the
 *     inherited value so the user sees real editable text rather than
 *     a placeholder ghost. On blur-without-changes, this matches
 *     `inheritedValue` so `commit` calls `onClear` rather than creating
 *     a spurious override entry. (The previous behaviour started the
 *     input empty, so blur committed `''` which never matched
 *     inheritedValue and produced false-dirty drafts — see in-file
 *     comments below for the original bug context.)
 *   - On Enter in a text input: blur the field (commits whatever's
 *     typed). Textareas keep Enter for newlines.
 *
 * Type-agnostic — Pattern B per the planning doc § "Discriminator
 * pattern". Caller resolves `inheritedValue` and `overrideValue` from
 * its own chain walker, passes resolved values + `onChange` / `onClear`
 * handler closures. The component itself has no surface discriminator.
 */

import { useState, useEffect, useRef } from 'react'
import { ChangeBadge } from '../entities/SharedEntityComponents'
import EntityColorPicker from './EntityColorPicker'
import DescriptionEditor from './DescriptionEditor'

export default function OverrideRow({ label, inheritedValue, overrideValue, onChange, onClear, type = 'text' }) {
  const hasOverride = overrideValue !== null && overrideValue !== undefined
  const [local, setLocal] = useState(hasOverride ? String(overrideValue) : '')
  const colourAnchorRef = useRef(null)
  const [colourPickerOpen, setColourPickerOpen] = useState(false)

  useEffect(() => {
    setLocal(hasOverride ? String(overrideValue) : '')
  }, [hasOverride, overrideValue])

  function commit(val) {
    if (val === inheritedValue) { onClear(); return }
    onChange(val)
  }

  // When the field gains focus and there's no current override, pre-populate
  // with the inherited value so the user sees real editable text instead of a
  // blank input with only a placeholder ghost. This way blur-without-changes
  // calls `commit(inheritedValue)` which matches → `onClear()` → no false
  // dirty state. Previously the field started empty, so blur would call
  // `commit('')` which didn't match the inherited value and created a spurious
  // override entry in the draft — making the sidebar ask "discard changes?"
  // even though the user never typed anything.
  function handleFocus() {
    if (!hasOverride && inheritedValue) {
      setLocal(String(inheritedValue))
    }
  }

  // On blur, if the user didn't change anything and local still matches
  // inherited, reset local back to '' so the ghost placeholder re-appears.
  function handleBlur(e) {
    const val = e.target.value
    commit(val)
    // If commit resulted in onClear (val === inherited), reset local so the
    // ghost placeholder re-appears instead of showing the inherited text as
    // if it were a user-typed override.
    if (val === inheritedValue) {
      setLocal('')
    }
  }

  // Description-textarea path: render the unified `DescriptionEditor`
  // so chain-anchor descriptions visually match the origin description
  // editor. Override-context affordances (Modify badge + revert ✕ +
  // inherited-fallback hint) hook into DescriptionEditor's labelExtra
  // and belowLabel slots; the textarea itself is the same component
  // everywhere.
  if (type === 'textarea') {
    return (
      <DescriptionEditor
        value={local}
        onChange={(val) => setLocal(val)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={!hasOverride ? (inheritedValue || '') : ''}
        labelExtra={hasOverride ? (
          <span className="flex items-center gap-1">
            <ChangeBadge action="modify" />
            <button onClick={onClear} className="text-[11px] font-bold text-zinc-600 hover:text-red-400 leading-none" title="Clear override">−</button>
          </span>
        ) : null}
        belowLabel={(!hasOverride && inheritedValue) ? (
          <div className="text-[10px] text-zinc-600 italic mb-1 truncate" title="Inherited — click field to override">
            ↳ {inheritedValue}
          </div>
        ) : null}
      />
    )
  }

  return (
    <div className="mb-3" data-help-region="detail-panel:details_changes">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider flex-1">{label}</span>
        {hasOverride && <ChangeBadge action="modify" />}
        {hasOverride && (
          <button onClick={onClear} className="text-[9px] text-zinc-600 hover:text-red-400" title="Clear override">✕</button>
        )}
      </div>

      {/* Inherited indicator — skipped for `color` (swatch shows the value),
          and skipped when the inherited value is empty (a literal `↳ none`
          adds no information over the empty input below). */}
      {!hasOverride && type !== 'color' && inheritedValue && (
        <div className="text-[10px] text-zinc-600 italic mb-1 truncate" title="Inherited — click field to override">
          ↳ {inheritedValue}
        </div>
      )}

      {type === 'color' ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            ref={colourAnchorRef}
            onClick={() => setColourPickerOpen((o) => !o)}
            className="w-8 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
            style={{ background: hasOverride ? String(overrideValue) : (inheritedValue || '#888888') }}
            aria-label={`Colour: ${hasOverride ? String(overrideValue) : inheritedValue}. Click to open picker.`}
          />
          <EntityColorPicker
            value={hasOverride ? String(overrideValue) : (inheritedValue || '#888888')}
            onChange={onChange}
            anchorEl={colourAnchorRef.current}
            isOpen={colourPickerOpen}
            onClose={() => setColourPickerOpen(false)}
          />
          <span className="text-xs text-zinc-400">{hasOverride ? String(overrideValue) : inheritedValue}</span>
          {!hasOverride && <span className="text-[9px] text-zinc-600 italic">(inherited)</span>}
        </div>
      ) : (
        <input
          type="text"
          className={`w-full bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none focus:border-accent-500 ${
            hasOverride ? 'border-zinc-500 text-zinc-100' : 'border-zinc-700 text-zinc-500'
          }`}
          value={local}
          placeholder={!hasOverride ? (inheritedValue || '') : ''}
          onFocus={handleFocus}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
        />
      )}
    </div>
  )
}
