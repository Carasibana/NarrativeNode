import { useMemo } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { useConversationsStore } from '../store/conversationsStore'

/**
 * Phase 2.5e — Active model capability lookup.
 *
 * Resolves the (profile_id, model) pair active for a given chat
 * thread (or the global default when no thread is supplied) against
 * `AiProviderProfile.model_capabilities`, and returns the structured
 * capability record.
 *
 * Return shape: an object with always-present arrays so callers
 * don't have to defend against `undefined`. When the lookup fails
 * (profile gone, model never discovered, manually-added model with
 * no cached capability info) the result defaults to `text`-only —
 * file-attach UI should treat that as the safe minimum.
 *
 *   {
 *     input_modalities:  ['text', ...],
 *     output_modalities: ['text', ...],
 *     supports_tool_use: true | false | null,
 *     resolved:          true  // a cached entry was found
 *                      | false // fell back to text-only default
 *   }
 *
 * Usage:
 *   const caps = useActiveModelCapabilities(threadId)
 *   const canImage = caps.input_modalities.includes('image')
 *
 * The hook is selector-based on the settings + conversations stores
 * so it re-renders cleanly when the writer switches connection /
 * model or re-runs discovery.
 */
export function useActiveModelCapabilities(threadId) {
  const prefs = useSettingsStore((s) => s.preferences)
  const thread = useConversationsStore((s) => threadId ? (s.byId[threadId] || null) : null)
  return useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    // Resolve the (profile, model) pair. Threads carry the values
    // they were created with; missing values fall back to the
    // global defaults so chats started without a stored profile
    // still resolve to something.
    const profileId = thread?.profile_id || prefs?.ai_default_profile_id || null
    const modelId   = thread?.model      || prefs?.ai_default_model?.model || null
    const profile   = profileId ? profiles.find((p) => p.id === profileId) : null
    const entry     = (profile?.model_capabilities && modelId)
      ? profile.model_capabilities[modelId]
      : null
    // Adapter api_type — needed for downstream components to pick
    // their wire-shape conditionally (e.g. OpenRouter exposes a
    // `summary` verbosity field in the reasoning flyout, others
    // don't).
    const apiType = profile?.api_type || null
    if (entry && (Array.isArray(entry.input_modalities) || Array.isArray(entry.output_modalities))) {
      return {
        api_type: apiType,
        profile_id: profileId,
        model: modelId,
        input_modalities:  Array.isArray(entry.input_modalities)  ? entry.input_modalities  : ['text'],
        output_modalities: Array.isArray(entry.output_modalities) ? entry.output_modalities : ['text'],
        supports_tool_use:  typeof entry.supports_tool_use  === 'boolean' ? entry.supports_tool_use  : null,
        supports_reasoning: typeof entry.supports_reasoning === 'boolean' ? entry.supports_reasoning : null,
        reasoning_options:  Array.isArray(entry.reasoning_options) ? entry.reasoning_options : null,
        reasoning_budget_range: (entry.reasoning_budget_range && typeof entry.reasoning_budget_range === 'object')
          ? entry.reasoning_budget_range
          : null,
        reasoning_default: typeof entry.reasoning_default === 'string' ? entry.reasoning_default : null,
        resolved: true,
      }
    }
    return {
      api_type: apiType,
      profile_id: profileId,
      model: modelId,
      input_modalities:  ['text'],
      output_modalities: ['text'],
      supports_tool_use:  null,
      supports_reasoning: null,
      reasoning_options: null,
      reasoning_budget_range: null,
      reasoning_default: null,
      resolved: false,
    }
  }, [prefs, thread])
}
