/**
 * Phase 1.23 — reusable granularity carousel primitive.
 *
 * Used by Time of Day, Day, and Scene Duration to let the writer
 * choose how precise / what magnitude they want their commitment to
 * be. The carousel handles tier-rotation UI and active-tier visibility
 * only; per-tier draft values live in the parent (so each tier's
 * widget is free to be whatever shape makes sense — a 2-button row,
 * a 12-label gearshift, a clock picker, a numeric input plus
 * dropdown, etc.).
 *
 * Design rules:
 *   - Multi-tier draft is session-only; on Save, only the currently-
 *     active tier's value is persisted; on reload, only that tier
 *     populates.
 *   - The carousel itself does NOT manage which tiers are
 *     "available" beyond `tiers[]` — context-aware availability
 *     (e.g. Scene Duration's All-period stop hidden when no start
 *     Time of Day is pinned) is the parent's responsibility; pass a
 *     filtered `tiers` list.
 *
 * API:
 *   - `tiers`: array of `{ id: string, label: string }` describing
 *     each stop in left-to-right order. Required, non-empty.
 *   - `activeTierId`: which tier is currently displayed. Required.
 *   - `onActiveTierChange(newTierId)`: called when the writer
 *     rotates to a different tier (left-arrow, right-arrow, or
 *     direct stop click). Required.
 *   - `hint`: optional ReactNode rendered as a subtle line beneath
 *     the carousel chrome (e.g. "retained value at adjacent stop").
 *   - `children`: the active tier's widget. The parent typically
 *     conditionally renders `{activeTierId === 'broad' && <Foo />}`.
 *   - `compact` (optional): renders a tighter layout for use inside
 *     dense scene-detail panels. Default false.
 */
import { useCallback } from 'react'

export default function GranularityCarousel({
  tiers,
  activeTierId,
  onActiveTierChange,
  hint = null,
  children,
  compact = false,
  // Behaviour-neutral help-region passthrough: the concrete carousels
  // (Time of Day / Scene Duration) return this primitive as their own
  // root, so the help tag for those surfaces has to land on the root
  // div here.
  dataHelpRegion = null,
}) {
  // Rules of Hooks: compute (null-safe) and define the callbacks BEFORE any
  // early return, then guard. `validTiers` is the same reference as `tiers`
  // when valid, so the callback deps stay stable across renders.
  const validTiers = Array.isArray(tiers) ? tiers : null
  const activeIndex = validTiers ? validTiers.findIndex((t) => t.id === activeTierId) : -1
  const safeIndex = activeIndex === -1 ? 0 : activeIndex
  const canLeft = !!validTiers && safeIndex > 0
  const canRight = !!validTiers && safeIndex < validTiers.length - 1

  const goLeft = useCallback(() => {
    if (validTiers && canLeft) onActiveTierChange(validTiers[safeIndex - 1].id)
  }, [validTiers, canLeft, onActiveTierChange, safeIndex])

  const goRight = useCallback(() => {
    if (validTiers && canRight) onActiveTierChange(validTiers[safeIndex + 1].id)
  }, [validTiers, canRight, onActiveTierChange, safeIndex])

  if (!validTiers || validTiers.length === 0) return null

  return (
    <div
      className={`flex flex-col gap-${compact ? 1 : 2} w-full`}
      data-help-region={dataHelpRegion || undefined}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goLeft}
          disabled={!canLeft}
          title={canLeft ? `Less granular: ${tiers[safeIndex - 1].label}` : 'Already at the least-granular stop'}
          className={`w-6 h-6 flex items-center justify-center rounded text-zinc-400 ${
            canLeft ? 'hover:bg-zinc-800 hover:text-zinc-200' : 'opacity-30 cursor-default'
          }`}
        >
          ◀
        </button>
        <div className="flex items-center gap-1 flex-1 justify-center">
          {tiers.map((t, i) => {
            const active = i === safeIndex
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onActiveTierChange(t.id)}
                title={t.label}
                className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded transition-colors ${
                  active
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={goRight}
          disabled={!canRight}
          title={canRight ? `More granular: ${tiers[safeIndex + 1].label}` : 'Already at the most-granular stop'}
          className={`w-6 h-6 flex items-center justify-center rounded text-zinc-400 ${
            canRight ? 'hover:bg-zinc-800 hover:text-zinc-200' : 'opacity-30 cursor-default'
          }`}
        >
          ▶
        </button>
      </div>
      <div className="flex flex-col gap-1 px-1">
        {children}
        {/* Reserve a single line of vertical space for the hint even
            when none is present, so the surrounding modal layout
            doesn't jump as the writer rotates between stops with
            and without retained-drafts hints. */}
        <div className="text-[10px] text-zinc-500 italic" style={{ minHeight: 14 }}>
          {hint || ' '}
        </div>
      </div>
    </div>
  )
}
