/**
 * Chat streaming client — Phase 2.4a.
 *
 * Wraps the backend `POST /api/ai/chat-stream` SSE proxy as an
 * async generator. The chat panel `for await`s the generator and
 * consumes one normalised event at a time.
 *
 * Normalised event shape (matches the backend):
 *   { type: 'start' | 'delta' | 'end' | 'error' | 'tool_call',
 *     text?: '<token-chunk for delta, accumulated text for end>',
 *     message_id?: '<provider id when supplied>',
 *     finish_reason?: '<provider finish reason>',
 *     detail?: '<error message>',
 *     // For type === 'tool_call':
 *     tool_call_id?: '<stable correlation id across phases>',
 *     tool_call_phase?: 'start' | 'arguments' | 'success' | 'failure',
 *     tool_name?: string,
 *     tool_provider_type?: 'ephemeral_mcp' | 'plugin' | string,
 *     tool_server_label?: string,
 *     tool_plugin_id?: string,
 *     tool_arguments?: object,
 *     tool_output?: string,
 *     tool_error_reason?: string,
 *     tool_error_type?: 'invalid_name' | 'invalid_arguments' | string }
 *
 * Cancellation: pass an `AbortSignal`. Aborting closes the upstream
 * fetch; the backend proxy detects the client disconnect and
 * tears down its upstream stream too. The generator returns
 * gracefully (no thrown error from the abort itself).
 *
 * Errors: surface as a final `{ type: 'error', detail }` event
 * rather than thrown exceptions — the caller can handle them
 * uniformly with upstream-reported errors.
 */
import { recordChatPayload } from '../utils/chatDebugLog'

export async function* streamChat({ profileId, model, messages, systemPrompt, attachments, reasoningLevel, reasoningSummary, enableTools = false, signal }) {
  // The caller (chat panel) is responsible for building the full
  // `messages` array per Phase 2.5d spec — including any `system`
  // entries for in-place `system_context` emissions and ride-along
  // baseline blocks. This client just forwards the array verbatim;
  // no splicing or rewrite happens here.
  //
  // Attachments (Phase 2.5e): the caller hands us a pre-encoded
  // list of `ChatAttachment` records (kind / name / mime_type /
  // data_base64). We splice them onto the LATEST user message in
  // the wire array so the adapter sees them riding with the turn
  // the writer just sent. Older user/assistant turns and system
  // entries are never touched — attachments are session-only and
  // not persisted into chat history.
  const wireMessages = _attachToLatestUserMessage(messages, attachments)
  // Session-only debug capture — exposes the exact payload in the
  // Dev Panel's "Chat Payloads" tab. No persistence, no network
  // overhead beyond an in-memory ring buffer of the last 5 entries.
  try {
    recordChatPayload({
      profile_id: profileId,
      model,
      system_prompt: systemPrompt || null,
      messages: wireMessages,
    })
  } catch { /* never let debug capture break a send */ }
  let response
  try {
    response = await fetch('/api/ai/chat-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        profile_id: profileId,
        model,
        messages: wireMessages,
        system_prompt: systemPrompt || null,
        // Phase 2.5f — reasoning controls. None / undefined / empty
        // string means OFF for this send; the adapter omits the
        // field from the upstream request.
        reasoning_level: (reasoningLevel === undefined || reasoningLevel === null || reasoningLevel === '') ? null : reasoningLevel,
        reasoning_summary: (reasoningSummary === undefined || reasoningSummary === null || reasoningSummary === '') ? null : reasoningSummary,
        // Tool use is opt-in per send. Only the main chat composer
        // passes `enableTools: true`; every other surface (prompt
        // blocks, scene-description, inline) leaves it false so the
        // backend never attaches tool definitions to prose generation
        // and wastes no context on tools that will never be called
        // there. When true the backend still gates on the connection's
        // `mcp_enabled` + adapter support.
        disable_tools: !enableTools,
      }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') return
    yield { type: 'error', detail: err?.message || 'Network error' }
    return
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch { /* keep status-line fallback */ }
    yield { type: 'error', detail }
    return
  }

  // Stream the response body. TextDecoderStream gives us UTF-8 text
  // chunks; we accumulate into a buffer and split on the SSE
  // event-terminator `\n\n`. Each event chunk may carry multiple
  // `data:` lines (rare in practice; the backend emits one per
  // event); we yield each one as its own parsed JSON payload.
  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader()

  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value

      let sepIdx
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const eventChunk = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)

        for (const line of eventChunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payloadText = line.slice(5).trim()
          if (!payloadText) continue
          try {
            yield JSON.parse(payloadText)
          } catch {
            // malformed payload — skip silently. The upstream proxy
            // shouldn't emit invalid JSON, but be tolerant.
          }
        }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      yield { type: 'error', detail: err?.message || 'Stream read error' }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}


/**
 * Attach a list of pre-encoded `ChatAttachment` records to the
 * LATEST user message in the wire array. Returns a new array
 * (non-mutating) so the caller's `messages` reference stays clean.
 *
 * No-op when `attachments` is empty / null. If the wire array
 * happens to have no user message (shouldn't happen in practice
 * but defensively), the attachments are dropped — they can't ride
 * a system or assistant turn.
 */
function _attachToLatestUserMessage(messages, attachments) {
  if (!attachments || attachments.length === 0) return messages
  // Walk backwards to find the last user message.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      const next = messages.slice()
      next[i] = { ...messages[i], attachments }
      return next
    }
  }
  return messages
}


