/**
 * NovelcrafterImportProgressModal — Phase 3.10 item 2.
 *
 * Renders a fixed-position modal overlay while an NC commit is in
 * flight. The dialog that kicked off the commit POST mounts THIS
 * component as a sibling overlay (z-index above the dialog backdrop
 * so it visually takes over) and passes the active `sessionId`.
 *
 * Polls `GET /api/novelcrafter/commit_progress?session_id=...` every
 * 500 ms. The returned slot carries:
 *   - phase / phase_index / phase_total — text + "Phase X of Y"
 *   - unit_done / unit_total — determinate bar when unit_total > 0,
 *     indeterminate when unit_total === 0
 *   - cancelled / done — terminal flags
 *
 * The actual commit POST is owned by the parent dialog (it awaits the
 * response so it can run the post-import cache refreshes). This modal
 * is read-only progress display + a Cancel button that POSTs to
 * `/commit_cancel`. The parent's pending commit POST observes the
 * cancel via the backend's progress slot and returns a
 * `{cancelled: true}` response, at which point the parent reverts the
 * frontend's Zustand snapshot and closes everything.
 *
 * 404 on the progress endpoint is treated as "stop polling" — that
 * happens after the backend cleared the slot (success / cancel /
 * server restart). In all three cases the parent's POST is already
 * resolving with the final state; the modal just stops polling and
 * lets the parent close it.
 *
 * Props:
 *   sessionId — the commit session ID, identical to the preview ID
 *               that was used to start the commit
 *   onCancelRequested — called once when the writer clicks Cancel.
 *                       Parent uses this to mark UI state "cancelling".
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'

export default function NovelcrafterImportProgressModal({
  sessionId,
  onCancelRequested,
}) {
  const [progress, setProgress] = useState({
    phase: 'Starting…',
    phase_index: 0,
    phase_total: 0,
    unit_done: 0,
    unit_total: 0,
    cancelled: false,
    done: false,
  })
  const [cancelling, setCancelling] = useState(false)
  // Polling interval ref so unmount cleans up cleanly even mid-poll.
  const pollTimerRef = useRef(null)
  // Guards the cancel POST from firing twice (writer rapid-clicks
  // before `cancelling` flips visually).
  const cancelInFlightRef = useRef(false)
  // Tracks whether we've ever seen a successful poll. Used to
  // distinguish the INITIAL-race 404 (slot not yet created by the
  // commit handler — keep polling) from the TAIL-race 404 (slot
  // existed and was cleared after the POST resolved — stop polling
  // so we don't spam the console with hundreds of 404s in the
  // brief window before the parent unmounts us).
  const seenSlotRef = useRef(false)

  // Polling loop. Async fetch wrapped in try/catch so a transient
  // network blip doesn't kill the loop. Stops on done=true OR on
  // tail-race 404 (see seenSlotRef above).
  useEffect(() => {
    if (!sessionId) return undefined
    let alive = true

    function stopPolling() {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }

    async function tick() {
      if (!alive) return
      try {
        const { data } = await axios.get(
          '/api/novelcrafter/commit_progress',
          { params: { session_id: sessionId } },
        )
        if (!alive) return
        seenSlotRef.current = true
        setProgress(data)
        if (data.done) {
          // Parent's POST is about to resolve (or just did).
          // Stop polling; parent owns the rest of the close flow.
          stopPolling()
        }
      } catch (err) {
        if (err?.response?.status === 404) {
          // Tail-race: slot was alive then cleared → stop polling.
          // Initial-race: slot doesn't exist yet → keep polling
          // silently (no log) until it appears.
          if (seenSlotRef.current) stopPolling()
          return
        }
        // Any other error — log + keep trying. Transient network
        // blips shouldn't kill the modal.
         
        console.warn('NC progress poll failed', err)
      }
    }

    // Initial tick + interval. 200 ms interval so engine sub-steps
    // (~20 of them, totalling a few seconds on small bundles) catch
    // multiple polls each instead of completing between two ticks
    // of a slower loop. Bigger NC bundles are >>1 s on the slowest
    // sub-step ("Scenes") so 200 ms still over-samples.
    tick()
    pollTimerRef.current = setInterval(tick, 200)
    return () => {
      alive = false
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [sessionId])

  const onCancel = useCallback(async () => {
    if (cancelInFlightRef.current || cancelling || progress.done) return
    cancelInFlightRef.current = true
    setCancelling(true)
    onCancelRequested?.()
    try {
      await axios.post(
        '/api/novelcrafter/commit_cancel',
        new URLSearchParams({ session_id: sessionId }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      )
      // Backend flips the flag; the in-flight commit POST will see
      // it at the next phase / per-item boundary, run the rollback,
      // and return a `{cancelled: true}` response. The parent
      // resolves that and closes us.
    } catch (err) {
       
      console.error('NC cancel POST failed', err)
      // Don't reset `cancelling` — the writer already saw the
      // intent. If the cancel really failed they can close the
      // modal manually via the eventual completion.
    }
  }, [sessionId, cancelling, progress.done, onCancelRequested])

  // ONE unified percentage across the whole import. Each parent
  // phase contributes an equal slice of the bar (phase_total chunks);
  // within a phase, unit_done / unit_total fills that slice. So an
  // import with 3 phases (apply + cues + chats):
  //   Phase 1 fills 0–33% as engine sub-steps complete
  //   Phase 2 fills 33–66% as cues are written
  //   Phase 3 fills 66–100% as chats are written
  // No "Phase X of Y" displayed — the writer cares about overall
  // progress, not the internal three-phase breakdown.
  const cancelled = progress.cancelled || cancelling
  let totalPct = 0
  if (progress.phase_total > 0) {
    const phaseWidth = 100 / progress.phase_total
    const completedPhases = Math.max(0, progress.phase_index - 1)
    const inPhaseFrac = progress.unit_total > 0
      ? Math.min(1, progress.unit_done / progress.unit_total)
      : 0
    totalPct = Math.min(100, Math.round(
      completedPhases * phaseWidth + inPhaseFrac * phaseWidth
    ))
  }
  if (progress.done && !cancelled) totalPct = 100

  // One human-readable line: what we're currently doing + the
  // within-phase counter where applicable. No phase X-of-Y. Cancel
  // takes over the line entirely.
  let activityLine
  if (cancelled) {
    activityLine = 'Cancelling — rolling back…'
  } else if (progress.done) {
    activityLine = 'Done'
  } else {
    const unitSuffix = progress.unit_total > 0
      ? ` (${progress.unit_done} / ${progress.unit_total})`
      : ''
    activityLine = `${progress.phase}${unitSuffix}`
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nc-import-progress-title"
    >
      <div className="w-[420px] max-w-[90vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-4">
        <h2
          id="nc-import-progress-title"
          className="text-sm font-semibold text-zinc-100 mb-1"
        >
          Importing Novelcrafter bundle
        </h2>
        <p className="text-[11px] text-zinc-300 mb-3 truncate">
          {activityLine}
        </p>

        <div
          className="relative h-2 w-full overflow-hidden rounded bg-zinc-800 border border-zinc-700"
          role="progressbar"
          aria-valuenow={totalPct}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            className="h-full bg-accent-500 transition-[width] duration-300"
            style={{ width: `${totalPct}%` }}
          />
        </div>

        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px] text-zinc-500">
            {totalPct}%
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelled || progress.done}
            className={`text-[11px] px-2.5 py-1 rounded border ${
              cancelled || progress.done
                ? 'border-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'border-red-800/70 bg-red-950/40 text-red-200 hover:bg-red-900/50'
            }`}
          >
            {cancelled ? 'Cancelling…' : 'Cancel import'}
          </button>
        </div>
      </div>
    </div>
  )
}
