/**
 * Phase 1.21c — Knowledge wire-grant level picker.
 *
 * Helper invoked from `projectStore.onConnect`'s knowledge-grant branch.
 * Opens a small modal letting the writer pick the awareness level being
 * granted to the target entity. Defaults to the top positive level
 * (matches the silent-grant behaviour shipped in v0.1.21.36 / .43) but
 * exposes the alternatives so the writer can mark partial / explicit-
 * unaware grants without having to navigate into a panel afterward.
 *
 * Combines two flows in one dialog:
 *
 *  1. **Tracking on, picking a level** — the common case. Writer wires
 *     from a Knowledge output port onto an entity-shaped target; modal
 *     prompts for the level. Level rows render at the Knowledge's
 *     existing precision scale; precision toggle is hidden (the
 *     Knowledge Detail Panel already exposes precision changes).
 *
 *  2. **Tracking off, enabling-and-granting** — when the source
 *     Knowledge's `awareness === null` (the "Track who knows this"
 *     toggle is off), the modal prepends a sentence offering to enable
 *     tracking AND commit the grant atomically. This is the Knowledge's
 *     first-time-setup moment so the dialog ALSO exposes an inline
 *     precision toggle (Binary / Full) above the level rows. Picking a
 *     level handles all three writes (precision change + tracking on +
 *     grant) atomically; cancelling makes none of them.
 *
 * Returns `null` on cancel, or `{ level, precision }` on confirm.
 * `precision` is always the user's chosen value — for the tracking-on
 * variant where the toggle is hidden, it equals the Knowledge's
 * existing scale (caller writes it as a no-op).
 *
 * Layout: levels render as full-width stacked rows inside the message
 * body, ordered top-positive-first so the visually-prominent option is
 * the historical silent-grant default. The dialog's footer button area
 * carries only Cancel. Each level row is clickable and resolves the
 * dialog directly via `useDialogStore.resolveDialog({ level, precision })`.
 */

import { useEffect, useRef, useState } from 'react'
import { confirm, useDialogStore } from '../store/dialogStore'
import {
  SCALE_BINARY,
  SCALE_ALIAS,
  awarenessLabelsFor,
  awarenessLevelStyle,
  AwarenessBadge,
} from '../components/ui/AwarenessBadges'
import { KnowledgeLabelChip } from '../components/ui/IdentityBadges'

// Visual mirrors the precision toggle in `KnowledgeDetailPanel.jsx`
// (line 583-): "Precision" uppercase label + two inline buttons whose
// content is the level-badge glyphs themselves. Active button gets a
// zinc-700 fill with an accent-500 inset ring; inactive sits at 50%
// opacity. Order: binary first (0 / 3), full second (0 / 1 / 2 / 3).
function PrecisionToggle({ value, onChange }) {
  const opts = [
    { key: 'binary', levels: [0, 3] },
    { key: 'full',   levels: [0, 1, 2, 3] },
  ]
  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0">Precision</label>
      <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
        {opts.map((opt) => {
          const active = value === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              title={opt.key === 'binary' ? 'Binary — known / not known' : 'Graduated — four awareness levels'}
              className={`inline-flex items-center gap-0.5 px-1.5 py-1 transition-colors ${
                active
                  ? 'bg-zinc-700 ring-2 ring-inset ring-accent-500'
                  : 'bg-zinc-900 opacity-50 hover:opacity-80 hover:bg-zinc-800'
              }`}
            >
              {opt.levels.map((lvl) => (
                <AwarenessBadge key={lvl} level={lvl} size={12} />
              ))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LevelRow({ level, scale, knowledgeName, autoFocus, onPick }) {
  const style = awarenessLevelStyle(level)
  const labels = awarenessLabelsFor('knowledge', { parentName: knowledgeName })
  const ref = useRef(null)
  useEffect(() => {
    if (autoFocus && ref.current) {
      // Defer to the next frame so ConfirmDialog's own first-button focus
      // (which runs on mount) doesn't fight with us. The level row wins.
      const id = requestAnimationFrame(() => ref.current?.focus())
      return () => cancelAnimationFrame(id)
    }
  }, [autoFocus])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(level)}
      className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded border ${style.border} ${style.bg} hover:brightness-125 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-zinc-900 focus:ring-zinc-400 transition`}
    >
      <span
        className={`flex-shrink-0 inline-flex items-center justify-center font-bold ${style.text}`}
        style={{
          width: 16,
          height: 16,
          fontSize: 11,
          lineHeight: 1,
          border: '1px solid currentColor',
          borderRadius: 2,
        }}
      >
        {style.icon}
      </span>
      <span className={`text-[12px] font-medium ${style.text} flex-shrink-0`}>
        {scale.shortLabels[level]}
      </span>
      <span className="text-zinc-500 text-[11px] italic ml-1 truncate">
        {labels[level]}
      </span>
    </button>
  )
}

function GrantPickerBody({ knowledge, observerEntity, trackingOff }) {
  const resolveDialog = useDialogStore((s) => s.resolveDialog)
  const [precision, setPrecision] = useState(knowledge?.awareness_scale || 'full')
  const scale = precision === 'binary' ? SCALE_BINARY : SCALE_ALIAS
  const knowledgeName = knowledge?.name || '(unnamed)'
  const observerName = observerEntity?.name || 'this entity'

  // Top-positive first so the visually-prominent option is the historical
  // silent-grant default and the Tab-traversal order matches reading order.
  const orderedLevels = [...scale.levels].reverse()

  const handlePick = (level) => resolveDialog({ level, precision })

  return (
    <div className="space-y-2.5">
      <div className="text-[12px] leading-snug">
        {trackingOff ? (
          <>
            Awareness tracking is not enabled for{' '}
            <KnowledgeLabelChip name={knowledgeName} />.
            {' '}Pick a level to enable tracking and grant{' '}
            <span className="text-zinc-200 font-medium">{observerName}</span>{' '}
            this awareness.
          </>
        ) : (
          <>
            Pick how much{' '}
            <span className="text-zinc-200 font-medium">{observerName}</span>{' '}
            knows about{' '}
            <KnowledgeLabelChip name={knowledgeName} />.
          </>
        )}
      </div>
      {trackingOff && (
        <PrecisionToggle value={precision} onChange={setPrecision} />
      )}
      <div className="space-y-1">
        {orderedLevels.map((lvl, i) => (
          <LevelRow
            key={`${precision}-${lvl}`}
            level={lvl}
            scale={scale}
            knowledgeName={knowledgeName}
            autoFocus={i === 0}
            onPick={handlePick}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Open the level-picker modal.
 *
 * @param {object} args
 * @param {object} args.knowledge       The source Knowledge object.
 * @param {object} args.observerEntity  The target entity object (can be null).
 * @returns {Promise<{ level: number, precision: 'binary' | 'full' } | null>}
 *          Picked level + precision, or null on cancel.
 */
export async function pickKnowledgeAwarenessLevel({ knowledge, observerEntity }) {
  const trackingOff = knowledge?.awareness == null

  const result = await confirm({
    title: trackingOff ? 'Enable awareness tracking?' : 'Grant awareness',
    message: (
      <GrantPickerBody
        knowledge={knowledge}
        observerEntity={observerEntity}
        trackingOff={trackingOff}
      />
    ),
    buttons: [{ label: 'Cancel', value: 'cancel', style: 'neutral' }],
    cancelValue: 'cancel',
  })

  if (!result || typeof result !== 'object' || typeof result.level !== 'number') {
    return null
  }
  return { level: result.level, precision: result.precision }
}
