/**
 * MCP control button — Phase 2.1 Phase C1.
 *
 * Sits in the header bar to the LEFT of the alerts button. Visually
 * mirrors the alerts button's shape (square chip, optional badge),
 * but uses the story accent colour rather than amber so the two
 * buttons are visually distinct.
 *
 * Five states (1, 2, and 3 wired in this commit; 4 + 5 land in
 * subsequent Phase C commits):
 *
 *   1. Dormant            — server off; popover shows "Turn on".
 *   2. Server-on, idle    — listener bound; popover shows URL + copy
 *                           + "Turn off". No pending requests.
 *   3. Request pending    — badge with count (story accent colour);
 *                           click opens panel; first request also
 *                           pops a modal unless user hit "Stop
 *                           asking".
 *   4. Session active     — accent glow + "session running" glyph;
 *                           click opens live session view. *Phase C2.*
 *   5. Session review     — accent glow + review glyph; click opens
 *                           end-of-session summary. *Phase C3.*
 *
 * Runtime override semantics: clicking [Turn on] / [Turn off]
 * changes the listener state for THIS session only. The "Auto-start
 * on launch" link in the popover footer is informational — it shows
 * the current persistent preference value and tells the user to flip
 * it in Program Settings if they want the change to stick across
 * launches.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useAccentColor } from '../../utils/povConstants'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import ToggleInput from './ToggleInput'

/** Return 'black' or 'white' — whichever produces higher contrast
 *  against a given hex-colour background. YIQ luminance formula:
 *  `(R*299 + G*587 + B*114) / 1000`; >= 128 ≈ light enough that
 *  black text reads better, < 128 ≈ dark enough that white text
 *  wins. Used to pick the active-session button's glyph colour
 *  against the story-accent background so the logo always stands
 *  out regardless of which accent the writer has chosen. */
function _contrastingFg(hex) {
  if (typeof hex !== 'string') return '#ffffff'
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 128 ? '#000000' : '#ffffff'
}

/** Official Model Context Protocol logo (3 curved strokes). The
 *  default size matches the visual weight of `⚠` at the alerts
 *  button's `text-xs` font-size. `stroke="currentColor"` so the
 *  icon picks up the parent button's text colour — driven by
 *  `glyphColour` below per the button's state machine.
 *
 *  `inline-block align-middle` makes the SVG flow like a slightly
 *  oversized text character: it participates in the parent button's
 *  line-height box and vertical-aligns to the middle of the line.
 *  This is what lets the MCP button share the SAME class set as the
 *  alerts button (`px-2 py-1 text-xs` — no display override) and
 *  therefore sit at the exact same vertical baseline in the header. */
function McpLogo({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 180 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="inline-block align-middle"
    >
      <path d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706V16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177" stroke="currentColor" strokeWidth="18" strokeLinecap="round" />
      <path d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52" stroke="currentColor" strokeWidth="18" strokeLinecap="round" />
      <path d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087V118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822" stroke="currentColor" strokeWidth="18" strokeLinecap="round" />
    </svg>
  )
}

// Match the alerts button's outer dimensions / radius / cursor so
// the two buttons read as siblings AND line up vertically when
// sitting next to each other in the header bar.
const BTN_BASE_CLS = 'relative px-2 py-1 text-xs rounded transition-colors'


/** Request modal — fixed-overlay full-screen dialog that pops on the
 *  first pending request of a "Stop asking" window. The user must
 *  act: Grant control, Deny this request, or Stop asking (which
 *  closes the modal and quiet-modes future requests until they grant
 *  one via the popover panel). */
function McpRequestModal() {
  const {
    pendingRequests,
    modalRequestId,
    loading,
    grantRequest,
    denyRequest,
    stopAsking,
  } = useMcpControlStore()
  // A session runs the canvas in single-row (concept-group placement is only
  // correct there); warn a multi-row user before their view changes — it
  // restores automatically when the session ends.
  const inMultiRow = useProjectStore((s) => s.story?.canvas_layout_mode === 'multi')

  if (!modalRequestId) return null
  const request = pendingRequests.find((r) => r.id === modalRequestId)
  if (!request) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-request-modal-title"
    >
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[460px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent strip across the top — same pattern as
            DeleteEntityDialog / ConfirmDialog. */}
        <div className="h-1" style={{ backgroundColor: 'var(--color-accent-400)' }} />

        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className="text-accent-400 mt-0.5" aria-hidden="true">
              <McpLogo size={18} />
            </span>
            <div className="flex-1">
              <h2
                id="mcp-request-modal-title"
                className="text-sm font-semibold text-zinc-100"
              >
                MCP control requested
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                An MCP client is asking permission to make changes in this project.
              </p>
            </div>
          </div>

          {/* Purpose — the AI-supplied description of what they want
              to do. Renders prominently so the user sees it before
              acting. */}
          <div className="bg-zinc-900/60 border border-zinc-700 rounded p-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Purpose</div>
            <div className="text-xs text-zinc-200 whitespace-pre-line">
              {request.purpose || <span className="italic text-zinc-500">(no purpose given)</span>}
            </div>
          </div>

          <div className="text-[11px] text-zinc-500 leading-relaxed">
            Granting lets the client write changes for one session. You can end the session at any time from the toolbar button.
          </div>

          {inMultiRow && (
            <div className="flex items-start gap-2 rounded border border-amber-800/60 bg-amber-950/40 p-2.5 text-[11px] leading-relaxed text-amber-200/90">
              <span aria-hidden="true" className="mt-px">⚠</span>
              <span>The canvas will switch to single-row while the session runs, then return to multi-row automatically when it ends.</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => denyRequest(request.id)}
              disabled={loading}
              className="px-3 py-1.5 rounded border border-zinc-600 text-zinc-300 text-xs hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              Deny
            </button>
            <button
              onClick={stopAsking}
              disabled={loading}
              className="px-3 py-1.5 rounded text-zinc-400 text-xs hover:text-zinc-200 disabled:opacity-50 transition-colors"
              title="Suppress this modal for the rest of this session. Future requests will still update the toolbar badge."
            >
              Stop asking
            </button>
            <div className="flex-1" />
            <button
              onClick={() => grantRequest(request.id)}
              disabled={loading}
              className="px-4 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              Grant control
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


/** Review summary panel inside the popover. Visible whenever the
 *  session manager is in `'review'` state. Shows the just-ended
 *  session's purpose, start/end times, AI-supplied summary, and a
 *  Done button that dismisses back to idle. */
function ReviewPanel() {
  const {
    review,
    sessionState,
    loading,
    dismissReview,
  } = useMcpControlStore()

  if (sessionState !== 'review' || !review) return null

  const fmt = (iso) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }
  const started = fmt(review.started_at)
  const ended = fmt(review.ended_at)

  return (
    <div data-help-region="mcp-control:session_review" className="px-3 py-3 space-y-2 border-t border-zinc-700">
      <div className="text-[10px] uppercase tracking-wide text-accent-400 font-semibold">
        Session ended · review
      </div>

      <div className="bg-zinc-900/60 border border-zinc-700 rounded p-2 space-y-1">
        {review.purpose && (
          <>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Purpose</div>
            <div className="text-xs text-zinc-200 break-words">{review.purpose}</div>
          </>
        )}
        <div className="text-[10px] uppercase tracking-wide text-zinc-500 mt-2">Summary</div>
        <div className="text-xs text-zinc-200 whitespace-pre-line break-words max-h-48 overflow-y-auto">
          {review.summary || <span className="italic text-zinc-500">(no summary given)</span>}
        </div>
        <div className="text-[10px] text-zinc-500 mt-2">
          {started}–{ended} · {review.tool_call_count ?? 0} tool call{review.tool_call_count === 1 ? '' : 's'}
        </div>
      </div>

      <button
        onClick={dismissReview}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white text-xs font-medium disabled:opacity-50 transition-colors"
      >
        Done
      </button>
    </div>
  )
}


/** Active session panel inside the popover. Visible whenever the
 *  session manager is in `'active'` state. Shows the session's
 *  purpose + start time + tool-call count, plus a force-end button
 *  for the user to revoke control mid-session. */
function ActiveSessionPanel() {
  const {
    activeSession,
    sessionState,
    loading,
    endActiveSession,
  } = useMcpControlStore()

  if (sessionState !== 'active' || !activeSession) return null

  const started = activeSession.started_at
    ? new Date(activeSession.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div data-help-region="mcp-control:active_session" className="px-3 py-3 space-y-2 border-t border-zinc-700">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: 'var(--color-accent-400)' }}
          aria-hidden="true"
        />
        <div className="text-[10px] uppercase tracking-wide text-accent-400 font-semibold">
          Session active
        </div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-700 rounded p-2 space-y-1">
        <div className="text-xs text-zinc-200 break-words">
          {activeSession.purpose || <span className="italic text-zinc-500">(no purpose given)</span>}
        </div>
        <div className="text-[10px] text-zinc-500">
          Started {started} · {activeSession.tool_call_count ?? 0} tool call{activeSession.tool_call_count === 1 ? '' : 's'}
        </div>
      </div>

      <button
        onClick={endActiveSession}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded border border-zinc-600 hover:bg-zinc-700 text-zinc-300 text-xs font-medium disabled:opacity-50 transition-colors"
        title="End this MCP session immediately. The MCP client will get a write-block error on any further write calls until they request a new session."
      >
        End session
      </button>
    </div>
  )
}


/** Pending requests list inside the popover. Visible whenever
 *  `pendingRequestCount > 0`. Renders each request as a row with
 *  per-row Grant / Deny buttons plus a "Dismiss all" affordance.
 *  This is the fallback UX after the user has hit "Stop asking" — or
 *  the primary UX for the second-and-later pending request (the
 *  first request pops the modal). */
function PendingRequestsList() {
  const {
    pendingRequests,
    pendingRequestCount,
    loading,
    grantRequest,
    denyRequest,
    denyAllRequests,
  } = useMcpControlStore()

  if (pendingRequestCount === 0) return null

  return (
    <div data-help-region="mcp-control:pending_requests" className="px-3 py-3 space-y-2 border-t border-zinc-700">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-zinc-400">
          Pending requests ({pendingRequestCount})
        </div>
        {pendingRequestCount > 1 && (
          <button
            onClick={denyAllRequests}
            disabled={loading}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            title="Deny every pending request"
          >
            Dismiss all
          </button>
        )}
      </div>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {pendingRequests.map((r) => (
          <div
            key={r.id}
            className="bg-zinc-900/60 border border-zinc-700 rounded p-2 space-y-1.5"
          >
            <div className="text-xs text-zinc-200 break-words">
              {r.purpose || <span className="italic text-zinc-500">(no purpose given)</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => denyRequest(r.id)}
                disabled={loading}
                className="px-2 py-0.5 text-[10px] rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                Deny
              </button>
              <div className="flex-1" />
              <button
                onClick={() => grantRequest(r.id)}
                disabled={loading}
                className="px-2 py-0.5 text-[10px] rounded bg-accent-700 hover:bg-accent-600 text-white font-medium disabled:opacity-50"
              >
                Grant
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


function McpControlButton() {
  const {
    serverRunning,
    port,
    url,
    autoStartPref,
    pendingRequestCount,
    sessionState,
    activeSession,
    suppressModal,
    popoverOpen,
    loading,
    lastError,
    startServer,
    stopServer,
    togglePopover,
    setPopoverOpen,
    preApproveConnections,
    preApproveDestructive,
    togglePreApproveConnections,
    togglePreApproveDestructive,
  } = useMcpControlStore()

  const containerRef = useRef(null)
  const [copyFlash, setCopyFlash] = useState(false)
  const accentColour = useAccentColor()
  // Phase 5.7 — the MCP control button is an AI surface; hide it when
  // AI integrations are disabled.
  const aiDisabled = useAiDisabled()

  // Close the popover when a click lands outside it. Same UX as
  // most flyout panels in the app.
  useEffect(() => {
    if (!popoverOpen) return
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [popoverOpen, setPopoverOpen])

  if (aiDisabled) return null

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url)
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 1200)
    } catch {
      // Clipboard API blocked (non-https in some contexts). The
      // user can select the URL text manually as a fallback.
    }
  }

  // Button colour state. Active session = accent BACKGROUND with a
  // contrast-picked glyph so the toolbar reads "MCP is live and
  // doing work" at a glance regardless of which accent the writer
  // has chosen. All other states keep the zinc chrome with the
  // glyph itself in accent (server on / pending) or faint zinc
  // (dormant).
  const hasPending = pendingRequestCount > 0
  const isActive = sessionState === 'active'
  let glyphColour = ''
  let bgColour = ''
  let inlineStyle = undefined
  if (isActive) {
    // Inline-style background = accent hex; glyph colour = computed
    // contrast (black or white). Skips Tailwind classes so the
    // background follows the story accent directly rather than the
    // resolved `bg-accent-400` palette.
    inlineStyle = {
      backgroundColor: accentColour,
      color: _contrastingFg(accentColour),
    }
  } else if (popoverOpen) {
    glyphColour = 'text-white'
    bgColour = 'bg-zinc-600'
  } else if (serverRunning || hasPending) {
    glyphColour = 'text-accent-400'
    bgColour = 'bg-zinc-700 hover:bg-zinc-600'
  } else {
    glyphColour = 'text-zinc-500'
    bgColour = 'bg-zinc-700 hover:bg-zinc-600'
  }

  const overrideTag = serverRunning !== autoStartPref ? ' (override)' : ''

  let title = 'MCP server: Off'
  if (sessionState === 'active') {
    title = 'MCP session active'
  } else if (sessionState === 'review') {
    title = 'MCP session ended — review pending'
  } else if (serverRunning) {
    title = hasPending
      ? `${pendingRequestCount} pending MCP request${pendingRequestCount !== 1 ? 's' : ''}`
      : 'MCP server: On'
  } else if (hasPending) {
    title = `${pendingRequestCount} pending MCP request${pendingRequestCount !== 1 ? 's' : ''}`
  }

  return (
    <>
      <div className="relative" ref={containerRef}>
        <button
          onClick={() => {
            // Close the alerts panel first if it was open — the two
            // header flyouts are mutually exclusive.
            useUiStore.setState({ alertsPanelOpen: false })
            togglePopover()
          }}
          className={`${BTN_BASE_CLS} ${bgColour} ${glyphColour}`}
          style={inlineStyle}
          data-help-region="menu-bar:mcp_status"
          title={title}
        >
          <McpLogo />
          {/* Pending-request count badge: shown when there are
              unhandled control requests AND no session is active.
              The badge sits in the top-right corner with the accent
              colour as its background — the button is in its
              regular zinc chrome during this state, so the accent
              badge pops on dark. */}
          {hasPending && !isActive && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold text-zinc-900 rounded-full leading-none"
              style={{ backgroundColor: 'var(--color-accent-400)' }}
            >
              {pendingRequestCount}
            </span>
          )}
          {/* Session-active tool-call count badge: shown whenever
              a session is granted, REPLACING the pending-request
              badge (the manager refuses new requests during an
              active session, so the two counts are mutually
              exclusive). Inverts the badge styling — the button
              itself is now accent-coloured, so the badge uses the
              contrast colour as its background and the accent
              colour for its text, keeping it legible on either
              palette. The 0 case is intentionally NOT hidden — a
              "0" badge during an active session communicates
              "session is granted, no writes yet" which is a real
              state the user benefits from seeing. */}
          {isActive && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold rounded-full leading-none"
              style={{
                backgroundColor: _contrastingFg(accentColour),
                color: accentColour,
                // 1.5px accent outline so the badge has a clean
                // boundary against the accent-coloured button
                // behind it. Without the outline a contrast-black
                // badge bleeds visually into the accent button —
                // the outline reinforces the badge as its own
                // pill. 1px (v0.2.1.40) was too thin, 2px
                // (v0.2.1.41) too chunky on the small badge
                // footprint; 1.5 lands in the middle.
                border: `1.5px solid ${accentColour}`,
              }}
              title={`${activeSession?.tool_call_count ?? 0} tool call${activeSession?.tool_call_count === 1 ? '' : 's'} in this session`}
            >
              {activeSession?.tool_call_count ?? 0}
            </span>
          )}
          {/* Review-state indicator: small accent dot in the
              top-right slot. Visible only when sessionState is
              'review' (session ended, user is reviewing the
              summary). No count to display — the review panel
              inside the popover surfaces the final tool-call
              total. */}
          {sessionState === 'review' && (
            <span
              className="absolute -top-1 -right-1 w-2 h-2 rounded-full ring-1 ring-zinc-800"
              style={{ backgroundColor: 'var(--color-accent-400)' }}
              aria-hidden="true"
            />
          )}
        </button>

        {popoverOpen && (
          <div data-help-region="mcp-control:popover" className="absolute right-0 top-full mt-1 w-80 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl z-[55] text-xs" style={{ zoom: 1.5 }}>
            <div data-help-region="mcp-control:status" className="px-3 py-2 border-b border-zinc-700 flex items-center justify-between">
              <span className="font-semibold text-zinc-200">
                MCP server
                {serverRunning ? (
                  <span className="ml-2 text-accent-400 font-normal">On</span>
                ) : (
                  <span className="ml-2 text-zinc-500 font-normal">Off</span>
                )}
              </span>
              {loading && <span className="text-zinc-500 text-[10px]">working…</span>}
            </div>

            {!serverRunning && (
              <div className="px-3 py-3 space-y-2">
                <p className="text-zinc-400 leading-relaxed">
                  External MCP clients can't connect right now. Tool use from inside the NarrativeNode chat still works regardless; this only affects outside clients. Turn the server on for this session if you want to grant an external client control.
                </p>
                <button
                  onClick={startServer}
                  disabled={loading}
                  data-help-region="mcp-control:turn_on"
                  className="w-full px-3 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white text-xs font-medium disabled:opacity-50 transition-colors"
                >
                  Turn on
                </button>
              </div>
            )}

            {serverRunning && (
              <div className="px-3 py-3 space-y-3">
                <div data-help-region="mcp-control:listening_url">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Listening at</div>
                  <div className="flex items-center gap-1.5">
                    <code className="flex-1 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono text-[10px] truncate" title={url}>
                      {url}
                    </code>
                    <button
                      onClick={copyUrl}
                      data-help-region="mcp-control:copy_url"
                      className="px-2 py-1 text-[10px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
                      title="Copy URL"
                    >
                      {copyFlash ? '✓' : 'Copy'}
                    </button>
                  </div>
                  <div className="mt-1 text-[10px] text-zinc-500">
                    Port {port}. Add this URL to your MCP client's config (e.g. Claude Desktop's <code className="text-zinc-400">mcp-remote</code> shim).
                  </div>
                </div>

                {/* "Turn off" only available when no session is in
                    flight. Disabling the listener mid-session would
                    orphan the MCP client — they'd see their next
                    tool call drop with a connection error. The user
                    can force-end the session first (from the active
                    session panel below) and then turn the server
                    off. */}
                {sessionState !== 'active' && (
                  <button
                    onClick={stopServer}
                    disabled={loading}
                    data-help-region="mcp-control:turn_off"
                    className="w-full px-3 py-1.5 rounded border border-zinc-600 hover:bg-zinc-700 text-zinc-300 text-xs font-medium disabled:opacity-50 transition-colors"
                  >
                    Turn off
                  </button>
                )}
              </div>
            )}

            {/* Active session panel — visible whenever session state
                is 'active'. Shows the session purpose, when it
                started, the tool-call count, and a force-end button. */}
            <ActiveSessionPanel />

            {/* Review panel — visible whenever session state is
                'review' (just-ended session waiting on user
                acknowledgement). Shows AI-supplied summary + Done
                button to dismiss back to idle. */}
            <ReviewPanel />

            {/* Pending requests panel — visible regardless of server
                on/off state so an unhandled request can never be
                hidden by toggling the server off. */}
            <PendingRequestsList />

            {/* Pre-approve toggles. PROCESS-lifetime, default OFF, no
                persistence — the user toggles them on each launch when
                they want the convenience. Always surfaced, even when
                the server is off, so the preference can be set ahead of
                time; the connections toggle also governs whether an
                incoming request is auto-granted. Colour-coded:
                connections toggle uses the story accent (neutral
                preference); destructive toggle uses red as a warning
                that flipping it on bypasses the per-action delete
                prompt. Two columns, side-by-side — full descriptions
                live in each toggle's hover-tooltip to keep the row
                compact. */}
            <div data-help-region="mcp-control:pre_approve" className="px-3 py-2 border-t border-zinc-700 grid grid-cols-2 gap-2">
              <div data-help-region="mcp-control:pre_approve_connections" className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-300 leading-tight">
                  Pre-approve<br />connections
                </span>
                <ToggleInput
                  value={preApproveConnections}
                  onCommit={togglePreApproveConnections}
                  title="When on, MCP session-grant requests bypass the modal and are granted immediately. Resets to off on NN restart."
                />
              </div>
              <div data-help-region="mcp-control:pre_approve_destructive" className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-300 leading-tight">
                  Pre-approve<br />destructive
                </span>
                <ToggleInput
                  value={preApproveDestructive}
                  onCommit={togglePreApproveDestructive}
                  onColor="#dc2626"
                  title="When on, every destructive MCP action (entity / scene / relationship / etc. deletes) is auto-approved without the red confirmation modal. Resets to off on NN restart."
                />
              </div>
            </div>

            {/* Quiet-mode indicator. Only surface when "Stop asking"
                has been engaged AND there's at least one pending
                request the user can still act on; otherwise it's
                noise. */}
            {suppressModal && pendingRequestCount > 0 && (
              <div className="px-3 py-2 border-t border-zinc-700 text-[10px] text-zinc-500 leading-relaxed">
                Quiet mode is on. The modal won't pop for new requests until you grant one.
              </div>
            )}

            {lastError && (
              <div className="px-3 py-2 border-t border-red-900/60 bg-red-900/30 text-red-300 text-[10px] leading-relaxed">
                {lastError}
              </div>
            )}

            <div className="px-3 py-2 border-t border-zinc-700 text-[10px] text-zinc-500">
              Auto-start on launch:{' '}
              <span className="text-zinc-400">{autoStartPref ? 'On' : 'Off'}</span>
              <span className="text-zinc-600">{overrideTag}</span>
              {' — '}change in <span className="text-zinc-400">Program Settings</span>.
            </div>
          </div>
        )}
      </div>

      <McpRequestModal />
    </>
  )
}


// Wrap in `memo` so App-level re-renders (the top of every commit)
// don't propagate through this component. Profile capture at
// v0.2.11.16 showed it rendering 606 times across one session — once
// per commit — because it sits in App's top bar and has no
// memoisation. Takes no props from App, so default `memo` shallow-
// equal is sufficient; the button's own state changes (server status,
// pending request count, popover open) come from its internal hook
// subscriptions, which fire only when the underlying values actually
// change.
export default memo(McpControlButton)
