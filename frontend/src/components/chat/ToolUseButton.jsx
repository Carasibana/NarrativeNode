import { useConversationsStore } from '../../store/conversationsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { getToolUseStatus } from '../../utils/toolUseStatus'

/**
 * Tool-use toggle (hammer) for the chat composer. Reflects and flips
 * the active connection's tool use (`mcp_enabled`), persisting
 * immediately exactly like the toggle in the MCP & API Connections
 * settings tab. Disabled (not interactive) whenever tool use cannot
 * be turned on for the connection: the api_type does not support
 * tools, or it is an LM Studio connection on a local/private host
 * whose NarrativeNode plugin has not been detected.
 *
 * The connection toggled is the same one the next send will use:
 * the thread's `profile_id` (or the program default when the thread
 * carries none).
 */
export default function ToolUseButton({ threadId, dataHelpRegion }) {
  const thread = useConversationsStore((s) => (threadId ? s.byId[threadId] : null))
  const profiles = useSettingsStore((s) => s.preferences.ai_provider_profiles || [])
  const defaultProfileId = useSettingsStore((s) => s.preferences.ai_default_profile_id)
  const setProfileMcpEnabled = useSettingsStore((s) => s.setProfileMcpEnabled)

  const profile = profiles.find((p) => p.id === (thread?.profile_id || defaultProfileId)) || profiles[0] || null
  const status = getToolUseStatus(profile)
  const disabled = !status.available
  const on = status.enabled

  const title = disabled
    ? `Tool use unavailable. ${status.reason || ''}`.trim()
    : on
      ? 'Tool use is ON for this connection. Tools are sent to the model. Click to turn off (saved to the connection).'
      : 'Tool use is OFF for this connection. No tools are sent to the model. Click to turn on (saved to the connection).'

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      aria-label="Tool use"
      title={title}
      data-help-region={dataHelpRegion}
      onClick={() => { if (!disabled && profile) setProfileMcpEnabled(profile.id, !profile.mcp_enabled) }}
      className={`flex items-center justify-center w-5 h-5 rounded border transition-colors ${
        disabled
          ? 'border-zinc-800 bg-zinc-900/30 text-zinc-700 cursor-not-allowed'
          : on
            ? 'border-accent-700/60 bg-accent-900/30 text-accent-200'
            : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
      }`}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
        <path d="m18 15 4-4" />
        <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
      </svg>
    </button>
  )
}
