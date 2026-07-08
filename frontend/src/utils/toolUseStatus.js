// Shared tool-use (MCP) capability helpers for AI provider
// connections. This is the single source of truth for "can this
// connection use tools, and are they currently on" — consumed by
// both the MCP & API Connections settings tab and the chat
// composer's tool-use button so the rule never drifts between them.

// Each entry mirrors a registered backend adapter. `supports_mcp`
// tells the UI whether a connection using this api_type can use
// tools at all (matches `LlmAdapter.supports_mcp` on the backend
// side; kept in sync by hand, small enough that drifting is obvious).
export const API_TYPE_OPTIONS = [
  { value: 'lmstudio_rest_v1', label: 'LM Studio (REST v1)', supports_mcp: true  },
  { value: 'openai_compatible', label: 'OpenAI-compatible',  supports_mcp: true  },
  { value: 'openrouter',        label: 'OpenRouter',          supports_mcp: true  },
  { value: 'anthropic',         label: 'Anthropic',           supports_mcp: false },
]

// Detect whether a base URL points at the local machine or a private
// network (loopback / RFC1918 / link-local / .local mDNS / bare
// single-label hostname). LM Studio's REST v1 server refuses the
// remote-MCP integration for such addresses, so on those connections
// the tool toggle stays disabled until a Test-Connection plugin probe
// confirms the local `mcp/narrativenode` plugin is configured.
export function isLocalOrPrivateHost(baseUrl) {
  if (!baseUrl) return false
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    const m = String(baseUrl).match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)/i)
    host = m ? m[1] : ''
  }
  host = (host || '').toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local')) return true                  // mDNS
  if (host === '::1') return true                            // IPv6 loopback
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true // IPv6 link-local / ULA
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (v4) {
    const a = parseInt(v4[1], 10), b = parseInt(v4[2], 10)
    if (a === 127 || a === 10 || a === 0) return true        // loopback / 10.0.0.0/8 / 0.0.0.0
    if (a === 192 && b === 168) return true                  // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true         // 172.16.0.0/12
    if (a === 169 && b === 254) return true                  // link-local
    return false                                             // public IPv4
  }
  if (!host.includes('.')) return true                       // bare LAN machine name
  return false
}

// Resolve the tool-use state of a connection profile.
//   supported - the connection's api_type can use tools at all
//   blocked   - tools cannot currently be turned on even though the
//               api_type supports them (LM Studio on a local/private
//               host without its plugin detected)
//   available - supported && !blocked: the toggle is interactive
//   enabled   - tools are currently on for this connection
//   reason    - short user-facing explanation when not available
export function getToolUseStatus(profile) {
  if (!profile) {
    return { supported: false, blocked: false, available: false, enabled: false, reason: 'No connection selected.' }
  }
  const opt = API_TYPE_OPTIONS.find((o) => o.value === profile.api_type)
  const supported = opt?.supports_mcp === true
  if (!supported) {
    return { supported: false, blocked: false, available: false, enabled: false, reason: 'This connection does not support tools.' }
  }
  const isLmStudioLocal = profile.api_type === 'lmstudio_rest_v1' && isLocalOrPrivateHost(profile.base_url)
  const blocked = isLmStudioLocal && profile.lmstudio_plugin_detected !== true
  const available = !blocked
  const enabled = available && !!profile.mcp_enabled
  return {
    supported: true,
    blocked,
    available,
    enabled,
    reason: blocked
      ? 'LM Studio has not confirmed the NarrativeNode plugin on this local connection. Run Test Connection in MCP & API Connections settings to enable tools.'
      : null,
  }
}
