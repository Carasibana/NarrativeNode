import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import IntensitySlider from '../ui/IntensitySlider'

/**
 * Phase 1.22d — Inline form for creating OR editing a Circumstance /
 * Motivator attribute. Same UI for both flows so the writer sees one
 * affordance, not two.
 *
 * Fields:
 *   name        — optional
 *   description — optional
 *   intensity   — optional (null = unset)
 *
 * At least one of name / description must be filled in. Validation
 * lives in this component (sets `error='both'` when both are blank);
 * other validation (e.g. duplicate name when creating) is the caller's
 * responsibility.
 *
 * Pure presentational component — no chain reads or writes. Callers
 * supply the in-progress draft as `value`, write back via `setValue`,
 * and decide what to do with the confirmed payload via `onConfirm`.
 *
 * Props:
 *   attributeType : 'circumstance' | 'motivator' (selects the type badge
 *                   and the section header label).
 *   value         : { name, description, intensity } — the in-progress
 *                   draft state.
 *   setValue      : function ((prev) => next) — React-style updater.
 *   error         : null | 'both'  — current validation error key.
 *   setError      : function (key | null) — clear / set the error.
 *   onConfirm     : function () — called when the user clicks Confirm
 *                   AND validation passes. Caller reads `value` for the
 *                   payload.
 *   onCancel      : function () — called when the user clicks Cancel.
 *   confirmLabel  : string — text on the confirm button. Defaults to
 *                   'Add' (create flow); pass 'Save' for edit.
 *   headerLabel   : string — section header text (e.g. "New
 *                   Circumstance" / "Edit Motivator"). Optional.
 */
export default function CircumstanceMotivatorForm({
  attributeType,
  value,
  setValue,
  error,
  setError,
  onConfirm,
  onCancel,
  confirmLabel = 'Add',
  headerLabel = null,
}) {
  const TypeBadge = attributeType === 'motivator' ? MotivatorTypeBadge : CircumstanceTypeBadge
  const defaultHeader = attributeType === 'motivator' ? 'New Motivator' : 'New Circumstance'
  const showHeader = headerLabel ?? defaultHeader

  function handleConfirm() {
    const hasName = !!(value.name || '').trim()
    const hasDesc = !!(value.description || '').trim()
    if (!hasName && !hasDesc) {
      setError('both')
      return
    }
    setError(null)
    onConfirm()
  }

  return (
    <div className="border border-zinc-600 rounded p-2 space-y-1.5 mb-2" data-help-region="circumstance-motivator-form:form">
      <div className="flex items-center gap-1" data-help-region="circumstance-motivator-form:type">
        <TypeBadge size={14} />
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider">{showHeader}</span>
      </div>
      <input
        data-help-region="circumstance-motivator-form:name"
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 placeholder:italic placeholder:text-zinc-500"
        value={value.name || ''}
        placeholder="Name (optional)"
        onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleConfirm() } }}
      />
      <textarea
        data-help-region="circumstance-motivator-form:description"
        className={`w-full bg-zinc-800 border ${error === 'both' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500`}
        rows={3}
        value={value.description || ''}
        placeholder="Description (optional)"
        onChange={(e) => { setValue((v) => ({ ...v, description: e.target.value })); if (error === 'both') setError(null) }}
      />
      {error === 'both' && (
        <p className="text-[9px] text-red-400 whitespace-nowrap">Enter a name or a description (at least one).</p>
      )}
      <div data-help-region="circumstance-motivator-form:intensity" className="contents">
        <IntensitySlider
          level={value.intensity ?? null}
          onChange={(v) => setValue((s) => ({ ...s, intensity: v }))}
        />
      </div>
      <div className="flex gap-1.5">
        <button
          data-help-region="circumstance-motivator-form:confirm"
          onClick={handleConfirm}
          className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
        >
          {confirmLabel}
        </button>
        <button
          data-help-region="circumstance-motivator-form:cancel"
          onClick={onCancel}
          className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
