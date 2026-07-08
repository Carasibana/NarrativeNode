import { useMemo, useState } from 'react'

/**
 * Standalone Scene picker popover — search input + filtered list
 * of pickable scenes. Parallel to `KnowledgePickerPopover` in
 * shape; lists every scene node in the project (or a caller-
 * supplied subset) and returns the picked scene id via `onPick`.
 *
 * Initial caller: the chat panel's "Add context" affordance
 * (Phase 2.5c manual context attach) pins a scene's content into
 * the outgoing message context. Designed to be reusable from
 * anywhere else that needs to pick a scene from the project.
 *
 * Props:
 *   allScenes — flat array of scene nodes. Caller usually passes
 *               `projectStore.nodes.filter((n) => n.type === 'sceneNode')`.
 *   excludeIds — Set / array of scene ids to hide (already-picked
 *                ids in the caller's strip, for example).
 *   onPick     — (sceneId) => void. The popover stays open so the
 *                caller chooses when to close.
 *   onClose    — () => void. Called by the "Close picker" footer button.
 */
export default function ScenePickerPopover({ allScenes, excludeIds, onPick, onClose }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const excl = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
    return (allScenes || [])
      .filter((n) => n && !excl.has(n.id))
      .filter((n) => !s || ((n.data?.title || '').toLowerCase().includes(s)))
      .slice(0, 50)
  }, [allScenes, search, excludeIds])

  return (
    <div data-help-region="scene-picker:popover" className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden">
      <div className="p-1.5 space-y-1">
        <input
          data-help-region="scene-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search scenes…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {filtered.map((n) => {
            const title = n.data?.title || ''
            const description = n.data?.description || ''
            return (
              <button
                key={n.id}
                data-help-region="scene-picker:scene_row"
                type="button"
                onClick={() => onPick(n.id)}
                className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
                title={description || undefined}
              >
                <span
                  className="rounded-sm flex-shrink-0 flex items-center justify-center"
                  style={{ width: 16, height: 16, border: '1.5px solid #93c5fd', backgroundColor: '#1e3a8a33' }}
                >
                  <span className="text-[10px] leading-none select-none text-sky-200">▭</span>
                </span>
                <span className="text-[10px] text-zinc-200 truncate flex-1">
                  {title || <em className="text-zinc-500">(untitled scene)</em>}
                </span>
              </button>
            )
          })}
        </div>
        <button
          data-help-region="scene-picker:close"
          type="button"
          onClick={onClose}
          className="w-full text-[9px] text-zinc-500 hover:text-zinc-300 text-center"
        >
          Close picker
        </button>
      </div>
    </div>
  )
}
