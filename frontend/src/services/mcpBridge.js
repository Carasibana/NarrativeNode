/**
 * Frontend WebSocket client for the MCP bridge.
 *
 * Connects to the backend at `/api/mcp/bridge` (proxied to the backend
 * in dev via vite.config.js, same-origin in prod). Holds the long-lived
 * connection, handles reconnect with exponential backoff, dispatches
 * `tool_invoke` messages to the registered tool handlers, and responds
 * to heartbeat `ping` messages with `pong`.
 *
 * The MCP Control state machine is wired up in Phase C; this module is
 * Phase A scaffolding only.
 *
 * Phase A scope:
 *   - WebSocket connect / reconnect lifecycle.
 *   - `ping` / `pong` heartbeat reply (backend drives the cadence).
 *   - `tool_invoke` → registered handler → `tool_result` round-trip.
 *   - `superseded` handling — when a newer tab connects, this tab
 *     stops processing and stops reconnecting.
 *   - Tool registry pre-populated with `__noop__` (used by the
 *     backend smoke-test endpoint at `POST /api/mcp/bridge/smoke-test`).
 *
 * Phase B+ adds:
 *   - Wave 1 read tools (`get_project_summary`, `list_entities`, etc.)
 *     each registered as a thin wrapper that reads from the live
 *     Zustand store via the existing chain walkers.
 *   - Wave 2 write tools, each mapping 1:1 to an existing Zustand action.
 *   - MCP Control state machine integration (the dispatcher learns to
 *     gate write tools by current state, prompts the user via the
 *     session-start modal, etc.).
 */

// ── Tunables ────────────────────────────────────────────────────────────
const _RECONNECT_DELAY_MIN_MS = 1_000   // first reconnect attempt
const _RECONNECT_DELAY_MAX_MS = 30_000  // cap; reached after ~5 attempts
const _RECONNECT_BACKOFF_MULT = 2

/**
 * Build the WebSocket URL. Same-origin in both dev and prod:
 *   - dev: vite proxies `/api/...` (HTTP and WebSocket) to the backend.
 *   - prod: backend serves the frontend bundle from the same origin.
 */
function _bridgeUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/mcp/bridge`
}

// ── Tool registry ───────────────────────────────────────────────────────
//
// Map of `tool_name -> async (args) => result`.
// Each handler returns the raw result value; the dispatcher wraps it
// in the `tool_result` envelope. Throwing inside a handler is
// captured and surfaced as `{ ok: false, error: { code, message } }`.

const _toolRegistry = new Map()

/**
 * Register a tool handler. Idempotent — re-registering the same name
 * replaces the prior handler. Phase B / D will call this from each
 * tool module's setup hook.
 *
 * @param {string} name — exact tool name the backend will use in the
 *   `tool_invoke.tool` field.
 * @param {(args: object) => Promise<any> | any} handler — receives the
 *   `args` payload, returns the raw result. Sync or async.
 */
export function registerMcpTool(name, handler) {
  if (typeof name !== 'string' || !name) {
    throw new Error('registerMcpTool: name must be a non-empty string')
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerMcpTool(${name}): handler must be a function`)
  }
  _toolRegistry.set(name, handler)
}

/**
 * Look up an already-registered tool handler by name. Used by
 * higher-level tools that delegate to lower-level tools (e.g.
 * `add_circumstance` routing through `add_attribute` for the persistent
 * entity-circumstance path). Returns the handler function or `undefined`
 * when no tool with that name has been registered yet.
 */
export function getMcpToolHandler(name) {
  return _toolRegistry.get(name)
}

/**
 * Built-in `__noop__` tool — used by the backend smoke-test endpoint
 * to verify the bridge round-trips end-to-end. Always returns
 * `{ noop: true }`. Registered automatically when this module loads.
 */
registerMcpTool('__noop__', () => ({ noop: true }))

// ── Bridge singleton ────────────────────────────────────────────────────

let _ws = null
let _connectAttempt = 0
let _shouldReconnect = true
let _reconnectTimer = null
let _superseded = false
// True when the backend rejected this tab's bridge connection because
// another tab is currently driving an active MCP session. Stays true
// until `retryBridgeAfterSessionEnd()` is called (typically from the
// cross-tab lockout modal after the user ends the session via REST).
let _rejectedSessionActive = false

// Callback the mcpControlStore registers to mirror bridge connection
// state into its `bridgeStatus` field. Set via `_setBridgeStatusSink`
// from the store; the bridge calls it on every status transition so
// React components can subscribe through the store without each one
// needing to wire its own bridge listener. Cleared if the store
// unregisters (won't happen in production but supported for testing).
let _bridgeStatusSink = null

const _state = {
  status: 'idle',           // 'idle' | 'connecting' | 'open' | 'closed' | 'superseded' | 'rejected_session_active'
  lastError: null,
  lastConnectedAt: null,
  lastPingAt: null,
}

function _emitBridgeStatus() {
  if (typeof _bridgeStatusSink === 'function') {
    try { _bridgeStatusSink(_state.status) } catch { /* swallow */ }
  }
}

/** Register a sink the bridge calls with its current `status` on every
 *  state transition. The mcpControlStore wires this so components can
 *  read bridge state through the store. Called once at app startup;
 *  pass null to clear. */
export function _setBridgeStatusSink(fn) {
  _bridgeStatusSink = fn
  // Fire once on registration so the sink starts in sync with the
  // bridge's current state instead of having to wait for the next
  // transition.
  _emitBridgeStatus()
}

/**
 * Read-only state snapshot for status indicators / debugging.
 * Returns a fresh object on every call so React subscribers don't
 * need to worry about referential identity.
 */
export function getMcpBridgeState() {
  return { ..._state }
}

/**
 * Open the bridge connection. Idempotent — calling while already
 * connected is a no-op. Safe to call from anywhere; meant to be
 * called once from `App.jsx`'s mount effect.
 */
export function connectMcpBridge() {
  if (_superseded) return
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return
  _shouldReconnect = true
  _openSocket()
}

/**
 * Close the bridge connection and stop reconnecting. Used during
 * teardown (e.g., explicit disconnect from a settings toggle, or in
 * tests). Production app call sites are unlikely.
 */
export function disconnectMcpBridge() {
  _shouldReconnect = false
  if (_reconnectTimer != null) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  if (_ws) {
    try { _ws.close(1000) } catch { /* nothing to do */ }
    _ws = null
  }
  _state.status = 'closed'
  _emitBridgeStatus()
}

/**
 * Re-attempt the bridge connection after the user ends the active
 * session from a locked-out tab. Called from the cross-tab lockout
 * modal's "End session" handler once the REST end-session call
 * succeeds.
 *
 * Clears BOTH the rejected-session-active flag AND the superseded
 * flag, since the modal can fire on either kind of locked-out tab:
 *   - Tab opened during an active session → rejected_session_active.
 *   - Tab superseded BEFORE the session started (two tabs open, the
 *     second became holder, the first lost bridge silently) → then
 *     a session started in the holder → modal fires on the first
 *     tab via the broader trigger.
 *
 * Triggers a fresh `_openSocket()`; if the backend accepts (no other
 * tab held the bridge in between, OR the session truly ended), the
 * 'open' handler clears the rejected flag and the modal dismisses
 * via its `bridgeStatus` subscription.
 */
export function retryBridgeAfterSessionEnd() {
  _rejectedSessionActive = false
  _superseded = false
  _shouldReconnect = true
  _connectAttempt = 0
  _openSocket()
}

function _openSocket() {
  _state.status = 'connecting'
  _state.lastError = null
  _emitBridgeStatus()

  let socket
  try {
    socket = new WebSocket(_bridgeUrl())
  } catch (err) {
    _state.lastError = String(err && err.message || err)
    _scheduleReconnect()
    return
  }
  _ws = socket

  socket.addEventListener('open', () => {
    _connectAttempt = 0
    _state.status = 'open'
    _state.lastConnectedAt = Date.now()
    _state.lastError = null
    // A successful open clears any prior rejected-session-active flag —
    // the backend is now happy to serve us, so the cross-tab lockout
    // modal (which keys off `bridgeStatus === 'rejected_session_active'`)
    // can dismiss.
    _rejectedSessionActive = false
    _emitBridgeStatus()
  })

  socket.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      // Non-JSON payload — silently ignore; the backend never sends
      // anything but JSON envelopes.
      return
    }
    _handleInbound(socket, msg)
  })

  socket.addEventListener('close', (event) => {
    if (_ws === socket) _ws = null
    // Close-code fallback: backend uses custom code 4001 for the
    // session-active rejection. If we see it here without the inbound
    // `rejected` message handler having already run (e.g. an edge
    // timing case where close fires before the message dispatch),
    // promote to rejected state anyway so the modal still renders.
    if (event.code === 4001) {
      _rejectedSessionActive = true
      _shouldReconnect = false
      _state.status = 'rejected_session_active'
      _state.lastError = _state.lastError || 'session_active_in_other_tab'
      _emitBridgeStatus()
      return
    }
    if (_rejectedSessionActive) {
      // Backend told us another tab has the bridge during an active
      // session. Keep the flag, stop reconnecting until the user
      // dismisses the cross-tab lockout modal (which calls
      // `retryBridgeAfterSessionEnd()`).
      _state.status = 'rejected_session_active'
      _emitBridgeStatus()
      return
    }
    if (_superseded) {
      _state.status = 'superseded'
      _emitBridgeStatus()
      return
    }
    _state.status = 'closed'
    _emitBridgeStatus()
    if (_shouldReconnect && event.code !== 1000) {
      _scheduleReconnect()
    }
  })

  socket.addEventListener('error', () => {
    // The 'close' event will follow with the actual disconnect reason;
    // we intentionally don't double-trigger reconnect here.
    _state.lastError = 'WebSocket error'
  })
}

function _scheduleReconnect() {
  if (!_shouldReconnect || _superseded) return
  if (_reconnectTimer != null) return  // already scheduled
  const delay = Math.min(
    _RECONNECT_DELAY_MIN_MS * (_RECONNECT_BACKOFF_MULT ** _connectAttempt),
    _RECONNECT_DELAY_MAX_MS,
  )
  _connectAttempt += 1
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    _openSocket()
  }, delay)
}

// ── Inbound message routing ─────────────────────────────────────────────

async function _handleInbound(socket, msg) {
  const type = msg && msg.type
  if (type === 'ping') {
    _state.lastPingAt = Date.now()
    _send(socket, { type: 'pong', ts: msg.ts })
    return
  }
  if (type === 'tool_invoke') {
    await _handleToolInvoke(socket, msg)
    return
  }
  if (type === 'superseded') {
    // Another tab connected. Stop reconnecting in this tab — the user
    // can manually reconnect by reloading or via a UI affordance later.
    _superseded = true
    _shouldReconnect = false
    _state.status = 'superseded'
    _state.lastError = msg.reason || 'superseded by another tab'
    _emitBridgeStatus()
    return
  }
  if (type === 'rejected') {
    // Backend refused to connect this tab because the existing tab
    // holds an active MCP session (first-wins-during-active-session
    // policy). Mark the flag so the cross-tab lockout modal can render;
    // stop reconnecting until the user ends the session. The 'close'
    // event will follow this message and won't trigger reconnect
    // because of the `_rejectedSessionActive` check there.
    _rejectedSessionActive = true
    _shouldReconnect = false
    _state.status = 'rejected_session_active'
    _state.lastError = msg.reason || 'session_active_in_other_tab'
    _emitBridgeStatus()
    return
  }
  // Unknown type — silently ignore. Forward-compat with future server
  // messages (e.g., session_state echoes Phase C may send).
}

async function _handleToolInvoke(socket, msg) {
  const requestId = msg.requestId
  const toolName = msg.tool
  const args = (msg.args && typeof msg.args === 'object') ? msg.args : {}

  if (typeof requestId !== 'string' || !requestId) {
    // Malformed envelope — can't even respond. Drop on the floor.
    return
  }

  const handler = _toolRegistry.get(toolName)
  if (!handler) {
    _send(socket, {
      type: 'tool_result',
      requestId,
      ok: false,
      error: {
        code: 'tool_not_implemented',
        message: `MCP tool "${toolName}" is not registered on the frontend dispatcher`,
      },
    })
    return
  }

  try {
    const result = await handler(args)
    // MCP back-channel: consume any orphan-detach warnings recorded
    // by `_runEventRemovalCascade` during this tool call (chain-event
    // removals that auto-detached an attached Knowledge under the
    // MCP-active path because the UI modal can't reach the agent).
    // Merge into the response so the agent sees which Knowledges got
    // detached and can decide whether to follow up with
    // `delete_knowledge`. Only attaches when warnings exist AND the
    // result is a plain object (skip primitives / arrays — those
    // tools don't trigger the cascade in the first place).
    let payload = result === undefined ? null : result
    try {
      const { useMcpControlStore } = await import('../store/mcpControlStore')
      const warnings = useMcpControlStore.getState()._consumeMcpOrphanDetachWarnings()
      if (warnings.length > 0
          && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        payload = { ...payload, _orphan_detaches: warnings }
      }
    } catch { /* defensive: never break a tool response over a warning surface */ }
    _send(socket, {
      type: 'tool_result',
      requestId,
      ok: true,
      result: payload,
    })
  } catch (err) {
    _send(socket, {
      type: 'tool_result',
      requestId,
      ok: false,
      error: {
        code: 'tool_execution_error',
        message: String(err && err.message || err),
      },
    })
  }
}

function _send(socket, obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(obj))
  } catch {
    // Send failure means the socket is already gone; the close event
    // will fire and reconnect logic will handle the rest.
  }
}
