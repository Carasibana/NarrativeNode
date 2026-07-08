/**
 * Shared Save / Cancel footer for Settings panel tabs that use the
 * draft pattern (Story Settings, Program Settings, MCP & API
 * Connections).
 *
 * Provides consistent save-state feedback across tabs:
 *
 *   - When the draft is dirty: "Unsaved changes" label appears
 *     beside the buttons, and the Save button gets the full accent
 *     treatment.
 *   - When the draft is clean: the Save button visibly dims so the
 *     writer knows there is nothing pending to commit. Still
 *     clickable (it just closes the panel) so writers who instinct-
 *     click Save to leave do not feel blocked.
 *
 * The tab owns the actual save / cancel logic and passes callbacks
 * in. The footer is purely presentational — it doesn't manage draft
 * state itself.
 */
export default function SettingsTabFooter({ isDirty, onSave, onCancel }) {
  return (
    <div data-help-region="settings:tab_footer" className="flex items-center gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
      <div className="flex-1 text-[11px]">
        {isDirty
          ? <span className="text-amber-300">Unsaved changes</span>
          : <span className="text-zinc-500">No unsaved changes</span>}
      </div>
      <button
        onClick={onCancel}
        className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100"
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        className={`px-4 py-1.5 text-sm text-white rounded transition-colors ${
          isDirty
            ? 'bg-accent-700 hover:bg-accent-600'
            : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
        }`}
      >
        Save
      </button>
    </div>
  )
}
