/**
 * MCP destructive-action approval modal — Phase 2.1 Phase D.
 *
 * Pops whenever the backend session manager has at least one pending
 * destructive approval AND the user hasn't yet opted into "Approve
 * all destructive actions this session". Each pending approval
 * represents an MCP write tool blocked on user consent for a SINGLE
 * destructive operation (delete an entity, delete a scene, delete a
 * relationship, etc.).
 *
 * Shows ONE pending approval at a time — the oldest in the queue.
 * The user picks one of three options:
 *
 *   - **Deny**: backend resolves the awaiting tool with `'denied'`.
 *     The MCP client gets a `[destructive_denied]` error and decides
 *     what to do.
 *   - **Approve**: backend resolves the awaiting tool with
 *     `'approved'`. Tool proceeds with the operation. Other pending
 *     approvals (if any) keep waiting and pop on the next cycle.
 *   - **Approve all destructive this session**: backend sets the
 *     session-scoped `auto_approve_destructive` flag AND resolves
 *     every currently-pending approval as `'approved_all'`. Every
 *     subsequent destructive op this session skips the modal and
 *     proceeds immediately. Resets when the session ends.
 *
 * The modal is intentionally NOT dismissible by clicking outside or
 * pressing Esc — destructive ops require an explicit decision. The
 * only escape is the End session button on the toolbar banner,
 * which force-ends the session and unwedges any waiting tool.
 */

import { useMcpControlStore } from '../../store/mcpControlStore'
import { useAccentColor } from '../../utils/povConstants'

export default function McpDestructiveApprovalModal() {
  const pendingDestructive = useMcpControlStore((s) => s.pendingDestructive)
  const loading = useMcpControlStore((s) => s.loading)
  const approveDestructive = useMcpControlStore((s) => s.approveDestructive)
  const denyDestructive = useMcpControlStore((s) => s.denyDestructive)
  const approveAllDestructive = useMcpControlStore((s) => s.approveAllDestructive)
  const accentColour = useAccentColor()

  if (!pendingDestructive || pendingDestructive.length === 0) return null
  // Pop the oldest in the queue first. If multiple destructive ops
  // are pending, the user resolves them one at a time (or hits
  // Approve-all to flush them all at once).
  const approval = pendingDestructive[0]

  // Tone-driven styling. 'red' (default) for data-deletion-style
  // destructive actions (delete entity / scene / relationship etc).
  // 'amber' for non-deletion destructive actions that rewrite
  // something the user invested in but don't lose data (e.g.
  // reorganize_canvas overwriting the user's layout — no data lost,
  // but the layout the writer crafted is gone). The amber tone
  // signals "this is significant but not catastrophic", visually
  // distinct from the red "this destroys data" framing.
  const isAmber = approval.tone === 'amber'
  const stripClass    = isAmber ? 'h-1 bg-amber-500' : 'h-1 bg-red-500'
  const iconClass     = isAmber ? 'text-amber-400 mt-0.5 text-lg' : 'text-red-400 mt-0.5 text-lg'
  const approveBtnClass = isAmber
    ? 'px-4 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors'
    : 'px-4 py-1.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs font-semibold disabled:opacity-50 transition-colors'
  const titleText = isAmber
    ? 'Layout-changing action requires approval'
    : 'Destructive action requires approval'
  // Amber actions don't get the "Approve all destructive this session" affordance —
  // they're typically rare per-call invocations (e.g. reorganize_canvas), and
  // batch-approving rare-but-impactful actions defeats the point. Red ops
  // continue to expose it as before.

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-destructive-modal-title"
    >
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[520px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top strip colour signals tone. Destructive (red) for
            data-deletion ops; amber for layout-rewrite or other
            non-deletion-but-still-significant actions. Both go
            through the same approval flow + queue. */}
        <div className={stripClass} />

        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className={iconClass} aria-hidden="true">⚠</span>
            <div className="flex-1">
              <h2
                id="mcp-destructive-modal-title"
                className="text-sm font-semibold text-zinc-100"
              >
                {titleText}
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                The MCP client wants to {approval.action}{' '}
                {approval.object_type}{' '}
                <span className="font-medium text-zinc-200">
                  &quot;{approval.object_name}&quot;
                </span>
                .
              </p>
            </div>
          </div>

          <div className="bg-zinc-900/60 border border-zinc-700 rounded p-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
              What this does
            </div>
            <div className="text-xs text-zinc-200">
              {approval.detail || (
                <span className="italic text-zinc-500">
                  (no consequence summary provided)
                </span>
              )}
            </div>
          </div>

          <div className="text-[11px] text-zinc-500 leading-relaxed">
            {isAmber ? (
              <>
                This rewrites part of the project the way you set it up. The
                MCP API won&apos;t undo it for you — use the canvas Undo if
                you change your mind after approving.
              </>
            ) : (
              <>
                This cannot be undone via the MCP API. If you opt in to the
                &quot;Approve all&quot; choice, every subsequent destructive
                action this session will skip this modal until the session
                ends.
              </>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              onClick={() => denyDestructive(approval.id)}
              disabled={loading}
              className="px-3 py-1.5 rounded border border-zinc-600 text-zinc-300 text-xs hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              Deny
            </button>
            {!isAmber && (
              <button
                onClick={() => approveAllDestructive()}
                disabled={loading}
                className="px-3 py-1.5 rounded text-zinc-400 text-xs hover:text-zinc-200 disabled:opacity-50 transition-colors"
                title="Skip this modal for every destructive action for the rest of this session. Resets when the session ends."
                style={{ borderColor: accentColour }}
              >
                Approve all destructive this session
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={() => approveDestructive(approval.id)}
              disabled={loading}
              className={approveBtnClass}
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
