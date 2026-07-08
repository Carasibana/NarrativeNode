// WirePayloadPreview — shared component that renders any wire
// payload as bordered bubbles per role.
//
// Surface-side (chat composer + every prompt block header) consumes
// this via `<WirePayloadPreviewModal>` to show writers exactly what
// they're about to send. Item 174's in-editor Preview tab will
// consume it too (with an author-time payload simulated against the
// current resolution context + a "[your message here]" placeholder
// where the writer's draft would go).
//
// Shape contract — `payload` is whatever the surface's builder
// returns. Required fields:
//   - composedSystemPrompt: string | null
//   - wireMessages: Array<{ role, content, ... }>
//   - reasoningLevel?: string | null
//   - reasoningSummary?: string | null
//
// Mode toggle ("Just this message" / "Message + history") is owned
// by the modal wrapper, not this component. This component just
// renders whatever payload it's given.

import { useMemo } from 'react'
import { Streamdown } from 'streamdown'

const ROLE_STYLES = {
  system: {
    border: 'border-amber-700/40',
    bg: 'bg-amber-900/10',
    label: 'System',
    labelColour: 'text-amber-300',
  },
  system_context: {
    border: 'border-amber-700/40',
    bg: 'bg-amber-900/10',
    label: 'System (context)',
    labelColour: 'text-amber-300',
  },
  user: {
    border: 'border-accent-700/40',
    bg: 'bg-accent-900/10',
    label: 'User',
    labelColour: 'text-accent-300',
  },
  assistant: {
    border: 'border-zinc-600',
    bg: 'bg-zinc-800/60',
    label: 'Assistant',
    labelColour: 'text-zinc-300',
  },
}

function _styleFor(role) {
  return ROLE_STYLES[role] || ROLE_STYLES.system
}

function _stringifyContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && part.type === 'image_url') return '[image]'
        if (part && part.type === 'image') return '[image]'
        if (part && part.type === 'file') return part.filename ? `[file: ${part.filename}]` : '[file]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function MessageBubble({ role, content, viewMode }) {
  const style = _styleFor(role)
  const text = _stringifyContent(content)
  return (
    <div className={`rounded border ${style.border} ${style.bg} px-3 py-2`}>
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${style.labelColour} mb-1`}>
        {style.label}
      </div>
      {viewMode === 'raw' ? (
        <pre className="whitespace-pre-wrap text-xs text-zinc-200 font-mono leading-relaxed m-0">{text}</pre>
      ) : (
        <div className="text-xs text-zinc-200 leading-relaxed [&_p]:m-0 [&_p+p]:mt-2 [&_pre]:my-2 [&_code]:text-[11px]">
          <Streamdown>{text}</Streamdown>
        </div>
      )}
    </div>
  )
}

export default function WirePayloadPreview({
  payload,
  viewMode,
  onViewModeChange,
  mode,
  onModeChange,
  modeToggleAvailable,
}) {
  // Payload shape mirrors `streamChat`'s input verbatim: the very
  // same object the chat composer's preview-mode `streamAssistantReply`
  // would have handed to `streamChat`. `systemPrompt` is the
  // composed prompt (writer's text + story-scope appendage);
  // `messages` is the wire-builder's output array.
  const bubbles = useMemo(() => {
    if (!payload) return []
    const out = []
    if (payload.systemPrompt) {
      out.push({ role: 'system', content: payload.systemPrompt, key: 'system-prompt' })
    }
    for (let i = 0; i < (payload.messages || []).length; i += 1) {
      const m = payload.messages[i]
      out.push({ role: m.role, content: m.content, key: `wire-${i}` })
    }
    return out
  }, [payload])

  return (
    <div className="flex flex-col h-full min-h-0" data-help-region="wire-payload-preview:body">
      {/* Top toolbar — mode toggle (when available) + MD/Raw toggle */}
      <div className="flex-shrink-0 flex items-center gap-3 border-b border-zinc-700 px-3 py-1.5">
        {modeToggleAvailable && onModeChange && (
          <div className="flex items-center gap-1 text-[11px]" data-help-region="wire-payload-preview:scope_toggle">
            <span className="text-zinc-500">Show:</span>
            <button
              type="button"
              onClick={() => onModeChange('single')}
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === 'single'
                  ? 'bg-accent-700/30 text-accent-200 border border-accent-700/50'
                  : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              Just this message
            </button>
            <button
              type="button"
              onClick={() => onModeChange('with-history')}
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === 'with-history'
                  ? 'bg-accent-700/30 text-accent-200 border border-accent-700/50'
                  : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              Message + history
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 text-[11px]" data-help-region="wire-payload-preview:view_mode">
          <span className="text-zinc-500">View:</span>
          <button
            type="button"
            onClick={() => onViewModeChange('markdown')}
            className={`px-2 py-0.5 rounded transition-colors ${
              viewMode === 'markdown'
                ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            Markdown
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('raw')}
            className={`px-2 py-0.5 rounded transition-colors ${
              viewMode === 'raw'
                ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            Raw
          </button>
        </div>
      </div>

      {/* Scrolling bubble list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2" data-help-region="wire-payload-preview:messages">
        {!payload && (
          <div className="text-xs text-zinc-500 italic">Computing preview…</div>
        )}
        {payload && bubbles.length === 0 && (
          <div className="text-xs text-zinc-500 italic">
            No wire content. The send would fire with an empty payload.
          </div>
        )}
        {bubbles.map((b) => (
          <MessageBubble key={b.key} role={b.role} content={b.content} viewMode={viewMode} />
        ))}
      </div>

      {/* Footer — reasoning indicator (when set) */}
      {payload && (payload.reasoningLevel || payload.reasoningSummary) && (
        <div className="flex-shrink-0 border-t border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-400 flex items-center gap-3">
          {payload.reasoningLevel && (
            <span>Reasoning: <span className="text-zinc-200">{payload.reasoningLevel}</span></span>
          )}
          {payload.reasoningSummary && (
            <span>Verbosity: <span className="text-zinc-200">{payload.reasoningSummary}</span></span>
          )}
        </div>
      )}
    </div>
  )
}
