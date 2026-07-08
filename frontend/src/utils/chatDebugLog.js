/**
 * Session-only ring buffer of the last N raw chat payloads sent to
 * the LLM adapter. Populated from `streamChat` (frontend/src/
 * services/chatClient.js) just before the outgoing fetch, consumed
 * by the Dev Panel's "Chat Payloads" tab so the writer can see
 * EXACTLY what was sent to the model.
 *
 * Session-only and module-scoped — nothing persisted, nothing
 * shipped on the wire. Lost on reload. Capped at 5 entries by
 * default; older entries fall off the front as new ones come in.
 *
 * Mirrors the `getFiredEggs` / `subscribeFiredEggs` pattern used
 * elsewhere in the project for simple subscribe-and-render
 * module-level state.
 */

const MAX_ENTRIES = 5

const _buffer = []
const _listeners = new Set()

function _notify() {
  for (const cb of _listeners) {
    try { cb() } catch { /* ignore listener errors */ }
  }
}

/** Record one outgoing chat payload. */
export function recordChatPayload(payload) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    payload: payload || null,
  }
  _buffer.push(entry)
  if (_buffer.length > MAX_ENTRIES) _buffer.splice(0, _buffer.length - MAX_ENTRIES)
  _notify()
}

/** Get a copy of the current ring-buffer contents, oldest first. */
export function getChatPayloads() {
  return [..._buffer]
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeChatPayloads(cb) {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}

/** Manually clear the buffer (useful for the Dev Panel "Clear" button). */
export function clearChatPayloads() {
  _buffer.length = 0
  _notify()
}
