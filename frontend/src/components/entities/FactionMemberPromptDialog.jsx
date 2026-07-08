import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'

export default function FactionMemberPromptDialog() {
  const prompt = useUiStore((s) => s.factionMemberPrompt)
  const close  = useUiStore((s) => s.closeFactionMemberPrompt)
  const resolve = useProjectStore((s) => s.resolveFactionMemberWire)

  if (!prompt) return null

  const { sourceEntityName, factionName } = prompt

  function handleChoice(addAsMember) {
    resolve(addAsMember, prompt)
    close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div data-help-region="faction-member-prompt:modal" className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-80 flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-100">Connect to Faction</h2>
        </div>
        <div className="px-4 py-3 text-sm text-zinc-300 space-y-1">
          <p>
            <span className="text-zinc-100 font-medium">{sourceEntityName}</span>
            {' was wired to '}
            <span className="text-zinc-100 font-medium">{factionName}</span>.
          </p>
          <p className="text-zinc-400 text-xs">Add as a member of the faction, or create a separate relationship?</p>
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-zinc-700">
          <button
            data-help-region="faction-member-prompt:add_as_member"
            onClick={() => handleChoice(true)}
            className="flex-1 px-3 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded"
          >
            Add as Member
          </button>
          <button
            data-help-region="faction-member-prompt:new_relationship"
            onClick={() => handleChoice(false)}
            className="flex-1 px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
          >
            New Relationship
          </button>
          <button
            data-help-region="faction-member-prompt:cancel"
            onClick={close}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
