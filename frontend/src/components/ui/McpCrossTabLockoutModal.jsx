/**
 * MCP cross-tab lockout modal — Phase 2.1 follow-up.
 *
 * Renders when an MCP session is active somewhere AND this tab isn't
 * the bridge holder. Covers two distinct paths that lead here:
 *
 *   1. **Tab opened during an active session.** Backend rejects this
 *      tab's bridge with `reason='session_active_in_other_tab'` per
 *      the first-wins-during-active-session policy in
 *      `backend/routers/mcp_bridge.py::BridgeManager.connect`. Bridge
 *      status becomes `'rejected_session_active'`.
 *
 *   2. **Tab was superseded BEFORE the session started, then a
 *      session started in the holder tab.** Two tabs were open; Tab B
 *      opened later and superseded Tab A's bridge (newest-wins is the
 *      no-session policy). Session then started in Tab B. Tab A's
 *      bridge status is `'superseded'`, not `'rejected_session_active'`
 *      — but the SAME user-facing fact holds: another tab is driving
 *      an active MCP session and this tab can't compete. The modal
 *      should fire here too.
 *
 * Single robust trigger covering both: `sessionState === 'active'
 * AND bridgeStatus !== 'open'`. If a session is running and this tab
 * doesn't hold the bridge, lock it out. The session-state half is
 * polled by `mcpControlStore` every 5s; the bridge-status half is
 * mirrored live from `mcpBridge.js` via the `_setBridgeStatusSink`
 * hook the store registers at module load.
 *
 * Modal dismissal paths:
 *   1. Session ends in the other tab (or is force-ended via the
 *      MCP control button there) — `sessionState` drops to `'review'`
 *      or `'idle'`; the trigger condition becomes false; modal
 *      dismisses.
 *   2. "End MCP session now" button here — calls `endActiveSession`
 *      REST then `retryBridgeAfterSessionEnd()`. Once the bridge
 *      re-opens, status → `'open'` and the trigger condition becomes
 *      false; modal dismisses.
 *   3. User closes this tab and returns to the holder tab — modal
 *      goes with the tab.
 *
 * Paired with the backend's REST gate middleware
 * (`_mcp_session_rest_gate` in `backend/main.py`), which returns 423
 * Locked from every write route during an active session — together
 * the two layers mean: the user sees a clear lockout explanation in
 * the affected tab AND any REST write that slips through the frontend
 * lockout (devtools, stale fetch retry, second-tab axios) is rejected
 * server-side.
 */

import { useEffect, useRef } from 'react'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { retryBridgeAfterSessionEnd } from '../../services/mcpBridge'
import { useAccentColor } from '../../utils/povConstants'

export default function McpCrossTabLockoutModal() {
  const bridgeStatus = useMcpControlStore((s) => s.bridgeStatus)
  const sessionState = useMcpControlStore((s) => s.sessionState)
  const endActiveSession = useMcpControlStore((s) => s.endActiveSession)
  const loading = useMcpControlStore((s) => s.loading)
  const accentColour = useAccentColor()

  // Lock out this tab whenever an MCP session is running somewhere
  // AND this tab isn't the bridge holder. Covers both the "rejected
  // during active session" case (new tab opened mid-session) and the
  // "superseded before the session started" case (two tabs open
  // before a session, second became holder, first lost bridge silently
  // — then session started in the holder).
  const shouldShow = sessionState === 'active' && bridgeStatus !== 'open'

  // Auto-retry-once when we render in `'superseded'` state. This
  // handles the case where another tab held the bridge BEFORE the
  // session started, that tab was then closed (leaving no actual
  // bridge holder), and a session was subsequently started in this
  // tab via the polling-derived pending-request popup. Without this
  // retry, the modal would render forever even though no other tab
  // actually competes for the bridge — bridgeStatus is just stale at
  // `'superseded'` from earlier in this tab's life.
  //
  // Outcomes of the retry:
  //   - No other tab actually holds the bridge → backend accepts →
  //     status → `'open'`, modal dismisses naturally via its trigger.
  //   - Another tab really does hold the bridge during an active
  //     session → backend rejects with code 4001 → status →
  //     `'rejected_session_active'`. Modal stays, but the auto-retry
  //     condition (`'superseded'`) is no longer met, so no loop.
  //
  // Guard with a ref so a transient re-render mid-retry doesn't
  // re-fire `_openSocket()` in the middle of a connect attempt.
  const retryFired = useRef(false)
  useEffect(() => {
    if (!shouldShow) {
      // Reset for future open cycles.
      retryFired.current = false
      return
    }
    if (bridgeStatus === 'superseded' && !retryFired.current) {
      retryFired.current = true
      retryBridgeAfterSessionEnd()
    }
  }, [shouldShow, bridgeStatus])

  if (!shouldShow) return null

  async function handleEndSession() {
    // End the session via the existing REST endpoint, then retry the
    // bridge connection. The bridge's 'open' handler clears the
    // rejected-session-active flag and emits the new status, which
    // dismisses this modal automatically.
    try {
      await endActiveSession()
    } catch {
      // Swallow — the session may have already ended on the backend
      // between this tab's last poll and the click. Either way, the
      // retry below will sort the bridge state out.
    }
    retryBridgeAfterSessionEnd()
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-cross-tab-lockout-title"
    >
      <div
        className="bg-zinc-900 border-2 rounded-lg shadow-2xl max-w-md mx-4 p-6 space-y-4"
        style={{ borderColor: accentColour }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: accentColour }}
            aria-hidden="true"
          />
          <h2
            id="mcp-cross-tab-lockout-title"
            className="text-sm font-semibold"
            style={{ color: accentColour }}
          >
            MCP Control is active in another tab
          </h2>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          An MCP session is currently running in another browser tab or
          window. To prevent two tabs from competing for control while
          the AI is driving the canvas, this tab is locked out for the
          duration of the session.
        </p>

        <p className="text-xs text-zinc-400 leading-relaxed">
          Switch to the other tab to continue watching the session, or
          end the session from here to regain control of this tab.
        </p>

        <div className="flex justify-end pt-2">
          <button
            onClick={handleEndSession}
            disabled={loading}
            className="px-4 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-100 text-xs font-medium disabled:opacity-50 transition-colors"
            title="End the running MCP session and re-enable edits in this tab."
          >
            End MCP session now
          </button>
        </div>
      </div>
    </div>
  )
}
