/**
 * MCP control store — Phase 2.1 Phase C1.
 *
 * Tracks the runtime state of the secondary static-port (13316) MCP
 * listener AND the session-control state machine (pending requests,
 * active session, review state). Backs the toolbar button + popover +
 * grant/deny modal.
 *
 * Shape:
 *   serverRunning       — bool: is the static-port listener bound?
 *   port / url          — connection details surfaced in the popover.
 *   autoStartPref       — bool: the PERSISTENT preference value (read
 *                         from /mcp/control/status). The popover shows
 *                         this so the user can see what their normal
 *                         setting is; flipping it permanently happens
 *                         in the Program Settings tab, not here.
 *   pendingRequestCount — number of unhandled MCP control requests.
 *                         Drives the badge count on the toolbar button.
 *   pendingRequests     — full request objects (id / purpose /
 *                         requested_at) so the popover panel can list
 *                         them with grant/deny per row.
 *   sessionState        — 'idle' | 'requested' | 'active' | 'review'.
 *                         Mirrors backend session manager state.
 *   activeSession       — { id, purpose, started_at, ... } when state
 *                         is 'active', null otherwise.
 *   review              — { session_id, purpose, summary, ... } when
 *                         state is 'review', null otherwise.
 *   popoverOpen         — bool: is the popover currently displayed?
 *   modalRequestId      — id of the request currently shown in the
 *                         grant/deny modal; null when modal is closed.
 *   suppressModal       — per-session "Stop asking" flag. Once set,
 *                         new pending requests update the badge but do
 *                         NOT pop the modal. Resets to false when the
 *                         user grants a request (positive engagement
 *                         signal that they're willing to be prompted
 *                         again) or when NarrativeNode restarts.
 *   loading             — bool: a server start/stop or grant/deny is
 *                         in flight.
 *   lastError           — string | null: last failure message from a
 *                         control-endpoint call.
 *
 * The store polls /mcp/control/status on a 5s cadence whenever it is
 * mounted in the page. Polling is paused when the document is hidden
 * to avoid wasted requests in background tabs.
 */

import { create } from 'zustand'
import axios from 'axios'
import { useUiStore } from './uiStore'
import { useProjectStore } from './projectStore'
import { _setBridgeStatusSink } from '../services/mcpBridge'

const POLL_INTERVAL_MS = 5000

// The canvas layout mode captured the moment an MCP session became active, so
// the session-layout guard can restore it when the session ends. Concept-group
// placement is only correct in single-row, so a session runs in single-row;
// this remembers the PRIOR mode. Only restored when it was 'multi' — a
// single-row user is never flipped into a multi-row view they weren't using.
let _modeBeforeMcpSession = null

export const useMcpControlStore = create((set, get) => ({
  serverRunning: false,
  port: 13316,
  url: 'http://127.0.0.1:13316/mcp/server/',
  autoStartPref: false,
  pendingRequestCount: 0,
  pendingRequests: [],
  sessionState: 'idle',
  activeSession: null,
  review: null,
  popoverOpen: false,
  modalRequestId: null,
  suppressModal: false,
  loading: false,
  lastError: null,
  // Phase D destructive-action gate — separate queue from
  // `pendingRequests`. Each entry is `{id, action, object_type,
  // object_name, detail, requested_at}` and represents a write
  // tool blocked on the user's per-action approval.
  pendingDestructive: [],
  autoApproveDestructive: false,

  // ── User-driven pre-approve toggles ─────────────────────────────
  // Both are PROCESS-lifetime, in-memory only — NOT persisted to
  // user_preferences.json. Default OFF on every NN process start;
  // the user toggles them on manually each launch when they want
  // the convenience.
  //
  // preApproveConnections: when ON, any incoming session-grant
  // request is auto-granted immediately (no modal pop, no queue
  // wait). _applyStatus calls grantRequest as soon as it sees a
  // new pending request id.
  //
  // preApproveDestructive: when ON, any incoming destructive
  // approval request is auto-approved immediately by calling
  // approveDestructive(id) per pending entry. Kept SEPARATE from
  // the existing session-scoped `autoApproveDestructive` flag —
  // that one is the "Approve all for this session" granular control
  // set from inside the destructive modal, and it resets on session
  // end; the pre-approve toggle persists across sessions until the
  // user toggles it off or NN restarts. Destructive actions are
  // auto-approved when EITHER flag is true.
  preApproveConnections: false,
  preApproveDestructive: false,

  // ── Per-call orphan-detach warning buffer ──────────────────────
  // When a chain mutation triggers `_runEventRemovalCascade` and an
  // origin Knowledge attached to the removed event has to be
  // auto-detached (MCP-active path, see projectStore.js — the UI
  // modal can't reach the agent so the cascade applies the safe
  // 'detach' default), each affected Knowledge is recorded here so
  // the MCP bridge can surface them in the tool-call response. The
  // agent then knows which Knowledges got auto-detached and can
  // follow up with `delete_knowledge` if they wanted destructive
  // removal instead of the safe-default detach. Buffer is cleared
  // by the bridge before each tool call and consumed-and-cleared
  // after the call returns. Fire-and-forget from the cascade's
  // perspective (it can't propagate back to the calling action's
  // promise; the buffer is the back-channel).
  mcpOrphanDetachWarnings: [],
  _recordMcpOrphanDetach(warning) {
    if (!warning) return
    set((s) => ({ mcpOrphanDetachWarnings: [...s.mcpOrphanDetachWarnings, warning] }))
  },
  _consumeMcpOrphanDetachWarnings() {
    const warnings = get().mcpOrphanDetachWarnings
    if (warnings.length === 0) return []
    set({ mcpOrphanDetachWarnings: [] })
    return warnings
  },
  togglePreApproveConnections() {
    const next = !get().preApproveConnections
    set({ preApproveConnections: next })
    // If the user flips this on while a request is already pending,
    // grant them immediately instead of waiting for the next poll.
    if (next) {
      const pending = get().pendingRequests || []
      for (const req of pending) {
        get().grantRequest(req.id)
      }
    }
  },
  togglePreApproveDestructive() {
    const next = !get().preApproveDestructive
    set({ preApproveDestructive: next })
    // Same idea: flipping on while destructive actions are queued
    // approves them right away. Per-entry approveDestructive (not
    // approveAllDestructive) so the backend's session-scoped
    // auto-approve flag stays decoupled from this toggle.
    if (next) {
      const pending = get().pendingDestructive || []
      for (const d of pending) {
        get().approveDestructive(d.id)
      }
    }
  },

  // Bridge connection status mirrored from `mcpBridge.js` via the
  // `_setBridgeStatusSink` callback registered at store init. Values:
  // 'idle' | 'connecting' | 'open' | 'closed' | 'superseded' |
  // 'rejected_session_active'. The last one means the backend
  // refused this tab's bridge because another tab is currently
  // driving an active MCP session — drives the cross-tab lockout
  // modal (first-wins-during-active-session policy).
  bridgeStatus: 'idle',
  _setBridgeStatus(status) {
    const prev = get().bridgeStatus
    if (prev === status) return
    set({ bridgeStatus: status })
    // Any bridge transition is a strong signal that session state
    // may have flipped server-side too — e.g. a locked-out tab just
    // took over the bridge after its End-session click, which means
    // THIS tab (the previous holder) just got superseded AND the
    // session that was running here is now ended. Without this
    // refresh the cross-tab lockout modal can flash briefly on the
    // superseded tab because its `sessionState` is still 'active'
    // from the last poll (up to 5s stale) even though the bridge has
    // already moved. Calling refreshStatus immediately closes that
    // gap. Fire-and-forget — the next regular poll catches any
    // failure.
    try { get().refreshStatus() } catch { /* swallow */ }
  },

  /** Apply a status snapshot from the backend. Used by polling and
   *  by every control endpoint (all endpoints return the current
   *  status so the store can update without an extra GET). Also
   *  contains the modal-trigger logic: when a NEW pending request
   *  appears AND `suppressModal` is false AND the modal isn't already
   *  showing, auto-open it on the most-recent pending request. */
  _applyStatus(status) {
    if (!status) return
    const prev = get()
    const nextPending = Array.isArray(status.pending_requests) ? status.pending_requests : []
    const nextPendingIds = new Set(nextPending.map((r) => r.id))
    const nextSessionState = status.session_state || 'idle'
    const nextPendingDestructive = Array.isArray(status.pending_destructive) ? status.pending_destructive : []
    const prevPendingIds = new Set((prev.pendingRequests || []).map((r) => r.id))
    const prevPendingDestructiveIds = new Set((prev.pendingDestructive || []).map((d) => d.id))

    // Pre-approve toggles — fire-and-forget grants for any pending
    // entry that's NEW since the last snapshot. Only act on new ids
    // so we don't re-grant the same request repeatedly while the
    // poll loop catches up.
    if (prev.preApproveConnections) {
      for (const req of nextPending) {
        if (!prevPendingIds.has(req.id)) get().grantRequest(req.id)
      }
    }
    if (prev.preApproveDestructive) {
      for (const d of nextPendingDestructive) {
        if (!prevPendingDestructiveIds.has(d.id)) get().approveDestructive(d.id)
      }
    }

    // Auto-open the modal on a new pending request, unless the user
    // has hit "Stop asking" or there's already a modal up. A request
    // is "new" if its id wasn't present in our last snapshot. Skip
    // entirely when pre-approve-connections is on — the request is
    // being auto-granted above; popping the modal would just flash
    // and dismiss.
    let modalRequestId = prev.modalRequestId
    if (modalRequestId && !nextPendingIds.has(modalRequestId)) {
      // The request currently displayed in the modal has been
      // resolved (granted/denied by another path, or timed out).
      // Close the modal.
      modalRequestId = null
    }
    if (!modalRequestId && !prev.suppressModal && !prev.preApproveConnections && nextPending.length > 0) {
      const newRequest = nextPending.find((r) => !prevPendingIds.has(r.id)) || nextPending[0]
      modalRequestId = newRequest.id
    }

    // Auto-open the popover when the session manager transitions
    // INTO `'review'`. Without this, `end_mcp_session` lands silently
    // — the toolbar button picks up the review-state accent dot but
    // the user has to click to see what the MCP client summarized.
    // Opening the popover automatically (and closing the alerts panel
    // via the existing mutex behaviour) puts the review summary in
    // front of the user the moment the session ends.
    //
    // Exception — when `preApproveConnections` is on, the user has
    // opted into a hands-off flow and does NOT want the popover
    // popping up unprompted every time a session ends. The
    // review-state accent dot still appears (review data is set
    // below regardless of this branch), so the pending summary stays
    // discoverable on their own terms; we just don't force it open.
    let popoverOpen = prev.popoverOpen
    if (nextSessionState === 'review' && prev.sessionState !== 'review' && !prev.preApproveConnections) {
      popoverOpen = true
      // Mirror the alerts↔MCP mutex from the click handlers — close
      // alerts if it was up so the popovers don't overlap.
      useUiStore.setState({ alertsPanelOpen: false })
    }

    // ── MCP-session layout guard (Phase 8.5) ─────────────────────────────────
    // Concept-group placement is only correct in single-row, so hold the canvas
    // in single-row for the lifetime of an MCP session and restore the prior mode
    // when it ends. On grant: remember the current mode; if it was multi-row,
    // switch to single-row. On end (any exit from 'active'): restore multi-row
    // ONLY when the user was in multi-row at grant time — never flip a single-row
    // user into a multi-row view they weren't using.
    if (prev.sessionState !== 'active' && nextSessionState === 'active') {
      const priorMode = useProjectStore.getState().story?.canvas_layout_mode || 'single'
      _modeBeforeMcpSession = priorMode
      if (priorMode === 'multi') useProjectStore.getState().setCanvasLayoutMode('single')
    } else if (prev.sessionState === 'active' && nextSessionState !== 'active') {
      if (_modeBeforeMcpSession === 'multi') useProjectStore.getState().setCanvasLayoutMode('multi')
      _modeBeforeMcpSession = null
    }

    set({
      serverRunning: !!status.server_running,
      port: status.port || 13316,
      url: status.url || `http://127.0.0.1:${status.port || 13316}/mcp/server/`,
      autoStartPref: !!status.auto_start_pref,
      pendingRequestCount: status.pending_request_count || 0,
      pendingRequests: nextPending,
      sessionState: nextSessionState,
      activeSession: status.active_session || null,
      review: status.review || null,
      modalRequestId,
      popoverOpen,
      pendingDestructive: Array.isArray(status.pending_destructive) ? status.pending_destructive : [],
      autoApproveDestructive: !!status.auto_approve_destructive,
    })
  },

  /** Approve a single destructive operation by id. The awaiting
   *  write tool wakes up with 'approved' and proceeds with the
   *  operation. Does NOT change the auto-approve flag — this is a
   *  one-shot approval for THIS specific delete. */
  async approveDestructive(approvalId) {
    if (!approvalId) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post(`/api/mcp/control/destructive/${approvalId}/approve`)
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to approve'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Deny a single destructive operation by id. The awaiting
   *  write tool wakes up with 'denied' and surfaces an error to
   *  the MCP client. */
  async denyDestructive(approvalId) {
    if (!approvalId) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post(`/api/mcp/control/destructive/${approvalId}/deny`)
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to deny'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Set the session-scoped auto-approve-destructive flag. Every
   *  pending destructive approval resolves immediately as
   *  'approved_all', and every subsequent destructive op this
   *  session skips the modal entirely. Resets when the session
   *  ends. */
  async approveAllDestructive() {
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/destructive/approve_all')
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to set auto-approve'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Fetch the latest status. Failures are logged but do NOT throw
   *  (polling must keep ticking). */
  async refreshStatus() {
    try {
      const res = await axios.get('/api/mcp/control/status')
      get()._applyStatus(res.data)
      if (get().lastError) set({ lastError: null })
    } catch (e) {
      // Don't surface transient poll failures to the popover — they
      // happen during startup and on every dev-server restart. The
      // status will catch up on the next tick.
       
      console.debug('[mcp] status poll failed:', e?.message)
    }
  },

  /** Runtime override: turn the static-port listener ON for this
   *  session. Does NOT touch the persistent preference. */
  async startServer() {
    if (get().loading) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/server/start')
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to start MCP server'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Runtime override: turn the static-port listener OFF for this
   *  session. Does NOT touch the persistent preference. */
  async stopServer() {
    if (get().loading) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/server/stop')
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to stop MCP server'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Grant a pending request by id. Resolves the awaiting MCP tool
   *  with 'granted' and transitions the session manager to 'active'.
   *  Also resets `suppressModal` — granting is the user's positive
   *  engagement signal, so future requests can pop the modal again. */
  async grantRequest(requestId) {
    if (!requestId) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post(`/api/mcp/control/requests/${requestId}/grant`)
      get()._applyStatus(res.data)
      set({ suppressModal: false, modalRequestId: null })
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to grant request'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Deny a pending request by id. Resolves the awaiting MCP tool
   *  with 'denied'. Does NOT reset `suppressModal` — denying is a
   *  "not interested" signal, so keep the quiet mode active. */
  async denyRequest(requestId) {
    if (!requestId) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post(`/api/mcp/control/requests/${requestId}/deny`)
      get()._applyStatus(res.data)
      // Close the modal if it was showing THIS request.
      if (get().modalRequestId === requestId) set({ modalRequestId: null })
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to deny request'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Deny every pending request at once. Backs the panel's "Dismiss
   *  all" affordance. */
  async denyAllRequests() {
    if (get().pendingRequestCount === 0) return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/requests/deny_all')
      get()._applyStatus(res.data)
      set({ modalRequestId: null })
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to deny requests'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** "Stop asking" — close the modal without granting/denying, and
   *  suppress future modal pops for this session. New pending requests
   *  will still update the badge count; the user handles them via the
   *  popover panel from this point forward (or until they grant a
   *  request, which resets the suppress flag). */
  stopAsking() {
    set({ suppressModal: true, modalRequestId: null })
  },

  /** User force-end the currently active session from the toolbar.
   *  Transitions backend 'active' → 'review' with a fixed "ended by
   *  user" summary. The MCP client's `end_mcp_session` tool covers
   *  the AI-driven end path; this is the user-driven equivalent. */
  async endActiveSession() {
    if (get().sessionState !== 'active') return
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/session/end')
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to end session'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  /** Dismiss the post-session review view. Transitions backend
   *  'review' → 'idle'. */
  async dismissReview() {
    set({ loading: true, lastError: null })
    try {
      const res = await axios.post('/api/mcp/control/session/dismiss_review')
      get()._applyStatus(res.data)
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to dismiss review'
      set({ lastError: msg })
    } finally {
      set({ loading: false })
    }
  },

  setPopoverOpen(open) {
    set({ popoverOpen: !!open })
  },

  togglePopover() {
    set({ popoverOpen: !get().popoverOpen })
  },
}))


/** Module-level polling driver. Started on first import; the store
 *  is a singleton so this runs exactly once per page load. */
let _pollHandle = null

function _startPolling() {
  if (_pollHandle) return
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    useMcpControlStore.getState().refreshStatus()
  }
  // Fire once immediately so the button paints with real state, not
  // the default fallback shape.
  tick()
  _pollHandle = setInterval(tick, POLL_INTERVAL_MS)
}

if (typeof window !== 'undefined') {
  // Defer the first poll + bridge-status sink registration to AFTER React's
  // initial commit settles. On page refresh both fire immediately on module
  // import, each triggering a `set(...)` on this store. App.jsx subscribes
  // here, so each set causes an App re-render → CanvasInner re-render →
  // fresh nodes/edges refs into React Flow's `StoreUpdater` → re-measurement
  // pass. Pre-this-deferral the F5 boot path racked up ~26 StoreUpdater
  // bursts vs 4 on load-from-disk; this initial-poll burst was 2-3 of those.
  // The single 5s window before the first poll is a UX no-op — the status
  // button paints with default-fallback shape until then, same as it did
  // before this store was added.
  const _initMcp = () => {
    _startPolling()
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) useMcpControlStore.getState().refreshStatus()
    })
    _setBridgeStatusSink((status) => {
      useMcpControlStore.getState()._setBridgeStatus(status)
    })
  }
  // requestIdleCallback when available (Chromium / Firefox); fallback to a
  // long-enough setTimeout that we're past App's initial-commit work.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(_initMcp, { timeout: 2000 })
  } else {
    setTimeout(_initMcp, 500)
  }
}
