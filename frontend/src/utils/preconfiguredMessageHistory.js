// preconfiguredMessageHistory.js — wire-turn helper for the
// `SystemPrompt.mock_messages` field (Pre-Configured Message
// History, PCMH).
//
// Every surface that sends a message to the LLM with an active
// system prompt calls this to splice the prompt-author's seeded
// turns into the outgoing wire payload BEFORE the writer's actual
// user message. The LLM sees the turns as legitimate prior chat
// history per planning doc §4.5: tone / style / format seeding via
// apparent conversational precedent.
//
// PCMH turns:
//   - DO ride on every send when the active prompt has them.
//   - DO appear in the Preview Message modal (which renders the
//     same wire payload streamChat would receive).
//   - DO NOT count toward the chat composer's rolling Message
//     History cap — the cap protects the WRITER's real conversation
//     turns, not authorial primer content.
//   - DO NOT appear in the chat panel's bubble list — they are
//     spliced at wire-build time, never persisted to thread.messages.
//   - DO NOT carry framing wrappers (no `<context>` / `<message>`
//     tags) — they ride as plain `{role, content}` wire entries.
//
// Defensive filtering: empty bodies skip silently (the prompt
// editor allows them, but emitting an empty turn would just
// confuse the model). Role must be one of 'user' / 'assistant';
// anything else (e.g. legacy 'system' from a different shape)
// silent-skips.

const ALLOWED_ROLES = new Set(['user', 'assistant'])

/**
 * Return the active prompt's PCMH as an array of wire turns ready
 * to splice into the messages array. Returns [] when the prompt is
 * null, mock_messages is missing / empty, or every entry was
 * filtered out.
 *
 * @param {object|null} activeSystemPrompt — the resolved active
 *   SystemPrompt object (the same shape the chat / PBH dispatchers
 *   already consume).
 * @returns {Array<{role: 'user' | 'assistant', content: string}>}
 */
export function preconfiguredMessageHistoryWireTurns(activeSystemPrompt) {
  if (!activeSystemPrompt) return []
  const mocks = activeSystemPrompt.mock_messages
  if (!Array.isArray(mocks) || mocks.length === 0) return []
  const out = []
  for (const m of mocks) {
    if (!m) continue
    if (!ALLOWED_ROLES.has(m.role)) continue
    const body = typeof m.body === 'string' ? m.body : ''
    if (!body) continue
    out.push({ role: m.role, content: body })
  }
  return out
}
