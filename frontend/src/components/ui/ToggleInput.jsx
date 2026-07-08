import { useAccentColor } from '../../utils/povConstants'

/**
 * Binary toggle switch (iOS style).
 *
 * Props:
 *   value        — true | false | null. Null is treated as defaultValue for display.
 *   defaultValue — true | false — what to show when value is null (default false).
 *   onLabel      — text shown when the toggle is on.
 *   offLabel     — text shown when the toggle is off.
 *   onCommit     — called with true or false (never null).
 *   onColor      — optional CSS colour string for the ON state. Defaults to
 *                  the story accent. Used by the MCP popover's "pre-approve
 *                  destructive" toggle (red) to colour-code the toggle as a
 *                  warning affordance rather than a neutral preference.
 */
export default function ToggleInput({ value, defaultValue = false, onLabel, offLabel, onCommit, disabled = false, title, onColor, dataHelpRegion = 'toggle:switch' }) {
  const accentColor = useAccentColor()
  const onColorResolved = onColor || accentColor
  const effective = value ?? defaultValue
  const label = effective ? onLabel : offLabel

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={effective}
        aria-disabled={disabled}
        disabled={disabled}
        title={title}
        data-help-region={dataHelpRegion || undefined}
        onClick={() => { if (!disabled) onCommit(!effective) }}
        className="relative flex-shrink-0 focus:outline-none"
        style={{
          width: 34,
          height: 18,
          borderRadius: 9,
          backgroundColor: effective ? onColorResolved : '#3f3f46',
          border: '1px solid rgba(255,255,255,0.1)',
          transition: 'background-color 0.15s ease',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: effective ? 'calc(100% - 16px)' : '2px',
            width: 14,
            height: 14,
            borderRadius: '50%',
            backgroundColor: '#fff',
            transition: 'left 0.15s ease',
          }}
        />
      </button>
      {label && <span className="text-xs text-zinc-300">{label}</span>}
    </div>
  )
}
