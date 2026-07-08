/**
 * Phase 1.23 — Time Since Last Scene field (planning doc §5).
 *
 * Pinned as a relative offset beyond the floor — `+N <unit>` where
 * unit ∈ { Minutes, Hours, Days, Weeks }. Stored on the SceneNode
 * as `gap_extension: TimeDelta`. The walker (step 7) combines this
 * with the floor and applies snap-forward to produce the effective
 * gap shown in the modal.
 *
 * UX behaviour:
 *   - Single number input + unit dropdown.
 *   - Blank input = no override (gap_extension treated as 0).
 *   - Default unit auto-picks based on `defaultUnit` prop (the
 *     walker's recommendation given the inferred floor's magnitude).
 *     Writer can change the unit freely afterwards.
 *   - Disabled-with-hint on the first POV scene (no prior scene to
 *     be "since").
 *   - Negative values rejected unless `allowNegative` (the per-story
 *     §7.2 toggle) is on.
 *   - Two read-only display lines below the input:
 *       Floor:     <floorDisplay>      (always shown when known)
 *       Effective: <effectiveDisplay>  (shown when an extension is
 *                                       pinned; differs from floor
 *                                       when snap-forward applies or
 *                                       extension > 0)
 *     Until the walker (step 7) lands, these come from the parent
 *     and may be null/placeholder.
 *
 * Value shape: `{ unit, value }` matching backend TimeDelta, or null.
 */
import { useId } from 'react'
import { timeUnitName } from '../../utils/calendarConventions'

const UNIT_OPTIONS = ['minutes', 'hours', 'days', 'weeks']

export default function TimeSinceLastSceneField({
  value,
  onChange,
  disabled = false,
  defaultUnit = 'hours',
  allowNegative = false,
  floorDisplay = null,
  effectiveDisplay = null,
  // Phase 1.23 step 9 walker-derived breakdown of the effective gap.
  // Rendered as a headline ("must have passed") + a list of factors
  // explaining how that number is derived from the prior scene + the
  // current draft. The walker recomputes this on every modal render
  // so the breakdown updates live as the user edits.
  // Shape: { headline: string, factors: string[] } | null
  breakdown = null,
  isFirstScene = false,
  // Behaviour-neutral help-region passthrough so the live help layer
  // can resolve to this field's own root (the Scene Time modal mount
  // site carries the same key on its wrapper section).
  dataHelpRegion = 'scene-time:gap',
}) {
  const id = useId()

  if (disabled || isFirstScene) {
    return (
      <div className="text-[11px] text-zinc-500 italic" data-help-region={dataHelpRegion}>
        This is the first POV scene of the story — no prior scene to be 'since'.
      </div>
    )
  }

  const hasOverride = value && value.value != null
  const numericValue = hasOverride ? value.value : ''
  const currentUnit = (value && value.unit) || defaultUnit

  function commit(nextValue, nextUnit) {
    if (nextValue === '' || nextValue == null) {
      onChange(null)
      return
    }
    const n = Number(nextValue)
    if (!Number.isFinite(n)) return
    if (n < 0 && !allowNegative) return
    onChange({ unit: nextUnit, value: n })
  }

  function onValueInput(e) {
    commit(e.target.value, currentUnit)
  }

  function onUnitChange(e) {
    const nextUnit = e.target.value
    if (hasOverride) {
      commit(value.value, nextUnit)
    } else {
      // No override yet — switching the unit just changes the
      // displayed default; doesn't materialise an override.
      onChange({ unit: nextUnit, value: null })
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-help-region={dataHelpRegion}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-zinc-500 text-sm">+</span>
        <input
          id={`tslscene-value-${id}`}
          type="number"
          step={1}
          min={allowNegative ? undefined : 0}
          value={numericValue}
          onChange={onValueInput}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder="0"
          aria-label="Extra time to add since last scene — value"
          className="w-20 h-7 text-sm text-center rounded-md bg-transparent border border-zinc-700 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-sky-600"
        />
        <select
          value={currentUnit}
          onChange={onUnitChange}
          aria-label="Extra time to add since last scene — unit"
          className="h-7 text-sm rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-sky-600 pl-2 pr-7 appearance-none bg-no-repeat"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%2371717a' d='M1 3l4 4 4-4z'/></svg>\")",
            backgroundPosition: 'right 6px center',
          }}
        >
          {UNIT_OPTIONS.map((u) => (
            // Backend `TimeDelta.unit` is plural ('minutes'/'hours'/
            // 'days'/'weeks'), but the calendar provider keys
            // `timeUnits` by singular ('minute'/'hour'/'day'/'week').
            // Strip the trailing 's' to bridge them.
            <option key={u} value={u}>{timeUnitName(u.replace(/s$/, '')) || u}</option>
          ))}
        </select>
        {hasOverride && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors select-none"
            title="Remove the extra time — back to the inferred floor"
          >
            clear
          </button>
        )}
      </div>

      {/* Walker-derived breakdown: headline (effective gap) +
          factor list explaining how it's derived. Updates live as
          the user edits the surrounding draft. */}
      {breakdown ? (
        <div className="text-[11px] text-zinc-500 leading-snug space-y-1">
          <div className="text-zinc-200 font-medium">{breakdown.headline}</div>
          {breakdown.factors?.length > 0 && (
            <ul className="list-disc pl-4 marker:text-zinc-600 space-y-0.5">
              {breakdown.factors.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {!hasOverride && (
            <div className="italic text-[10px] text-zinc-600">
              Pin a value above to extend the gap further; leave blank to use the floor as-is.
            </div>
          )}
        </div>
      ) : (
        // Walker output unavailable (off-chain or no prior scene).
        // Fall back to the simpler floor / effective lines or the
        // blank-no-override hint.
        <div className="text-[11px] text-zinc-500 leading-snug space-y-0.5">
          {floorDisplay != null && (
            <div>
              Floor: <span className="text-zinc-300">{floorDisplay}</span>
            </div>
          )}
          {hasOverride && effectiveDisplay != null && (
            <div>
              Effective: <span className="text-zinc-300">{effectiveDisplay}</span>
            </div>
          )}
          {!hasOverride && (
            <div className="italic">
              Blank = no override. The walker uses the floor as-is.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
