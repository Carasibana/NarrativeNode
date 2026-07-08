import { useSettingsStore } from '../store/settingsStore'

/**
 * Phase 5.7 — true when the writer has turned on "Disable AI
 * integrations" in Program Settings. Every AI-related UI surface reads
 * this and hides itself when it is on. Reads the persisted preference;
 * defaults to false (AI surfaces visible) before settings load.
 *
 * Returns a primitive boolean so the selector is render-stable.
 */
export function useAiDisabled() {
  return useSettingsStore((s) => s.preferences?.disable_ai_integrations === true)
}
