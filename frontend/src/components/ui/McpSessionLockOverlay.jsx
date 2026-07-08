/**
 * MCP session edit-lockout banner — Phase 2.1 Phase C follow-up.
 *
 * Renders nothing when the MCP session manager isn't in `'active'`
 * state. When a session is in flight, paints a thin strip across
 * the top of the main content area (above the canvas + sidebars)
 * announcing the lockout and offering an inline End session button.
 *
 * Why a banner rather than a full-page overlay (the original
 * v0.2.1.33 design):
 *
 *   - The user wants to be able to PAN AND ZOOM on the canvas while
 *     the AI is working so they can watch updates land in real time.
 *     A full-page overlay blocked all canvas events; this banner
 *     leaves the canvas open and the canvas's own React Flow props
 *     (`nodesDraggable={!isMcpEditLocked}` etc) + handler gates
 *     (`handleContextMenu`, `handleNodeContextMenu`,
 *     `handleCanvasDrop`) prevent the EDIT-causing interactions.
 *   - Sidebars get their own per-component edit-lock styling so
 *     the user can't reach the entity library / detail panel /
 *     editor write affordances while a session is active.
 *
 * The banner is rendered as a sibling above the main content row
 * inside the outer column flex (alongside the error and
 * backendDisconnected banners), so when it appears it pushes the
 * canvas + sidebars down instead of overlaying them. The original
 * design had this absolutely-positioned inside the main row to
 * avoid layout reflow — but that overlapped the canvas's chapter /
 * act header strip, hiding the chapter labels mid-session. Pushing
 * the row down is the correct tradeoff.
 */

import { useMcpControlStore } from '../../store/mcpControlStore'
import { useAccentColor } from '../../utils/povConstants'

export default function McpSessionLockOverlay() {
  // The session purpose is shown in the banner alongside the static
  // announcement, but as a CLEARLY-SEPARATED chip (its own pill with
  // a subtle dark backdrop) — not inlined into the explanation prose.
  // Inlining caused the AI's purpose text to run together with the
  // static "Your edits are paused..." sentence into a single
  // unreadable wall of text. Truncated with ellipsis so a long
  // purpose can't push the End session button off-screen; full text
  // is in the title attribute (hover) and the popover's
  // ActiveSessionPanel.
  const sessionState = useMcpControlStore((s) => s.sessionState)
  const activeSession = useMcpControlStore((s) => s.activeSession)
  const endActiveSession = useMcpControlStore((s) => s.endActiveSession)
  const loading = useMcpControlStore((s) => s.loading)
  const accentColour = useAccentColor()

  if (sessionState !== 'active') return null

  return (
    <div
      className="px-3 py-2 flex items-center gap-3 text-xs shadow-md flex-shrink-0"
      style={{ backgroundColor: accentColour }}
      role="status"
      aria-live="polite"
    >
      <span className="font-semibold text-zinc-900 flex-shrink-0">
        MCP session active.
      </span>
      <span className="text-zinc-900/80 flex-shrink-0">
        Your edits are paused. The canvas is read-only; you can pan and zoom
        to watch updates as they land.
      </span>
      {/* Session purpose as its own clearly-separated pill: dark
          translucent backdrop, rounded, max-width with truncate so
          a long purpose can't push the End session button off the
          banner. Full text in the title attribute (hover) and the
          popover's ActiveSessionPanel. */}
      {activeSession?.purpose && (
        <span
          className="px-2 py-0.5 rounded text-zinc-900 text-[11px] truncate min-w-0 flex-1"
          style={{ backgroundColor: 'rgba(0,0,0,0.15)' }}
          title={activeSession.purpose}
        >
          {activeSession.purpose}
        </span>
      )}
      <button
        onClick={endActiveSession}
        disabled={loading}
        className="px-2 py-0.5 rounded border border-zinc-900/40 hover:bg-zinc-900/20 text-zinc-900 text-[11px] font-medium disabled:opacity-50 transition-colors flex-shrink-0"
        title="End the MCP session now. The MCP client will see a session-ended error on its next write call."
      >
        End session
      </button>
    </div>
  )
}
