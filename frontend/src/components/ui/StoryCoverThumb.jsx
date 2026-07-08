import { useEffect, useState } from 'react'
import axios from 'axios'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import CoverPlaceholder from './CoverPlaceholder'

/**
 * Phase 5.2b — read-only story-cover display.
 *
 * Renders the active project's cover (or the bundled placeholder) at a
 * 2:3 portrait ratio, filling the width of its container. Fetches the
 * derived has-cover flag and refreshes whenever the project changes
 * (`story.id`) or the cover is set / cleared (`uiStore.coverVersion`),
 * so it stays in sync with the Story Settings cover control without a
 * shared cover-bytes state.
 *
 * Optional `onClick` makes the whole thumb a button (e.g. the empty
 * Detail Panel uses it to jump into Story Settings).
 */
export default function StoryCoverThumb({ onClick, className = '' }) {
  const coverVersion = useUiStore((s) => s.coverVersion)
  const storyId = useProjectStore((s) => s.story?.id)
  const [hasCover, setHasCover] = useState(null)

  useEffect(() => {
    let cancelled = false
    axios.get('/api/project/cover/status')
      .then(({ data }) => { if (!cancelled) setHasCover(!!data.has_cover) })
      .catch(() => { if (!cancelled) setHasCover(false) })
    return () => { cancelled = true }
  }, [storyId, coverVersion])

  const interactive = typeof onClick === 'function'

  return (
    <div
      className={`relative rounded overflow-hidden border border-zinc-700 bg-zinc-900 ${interactive ? 'cursor-pointer group' : ''} ${className}`}
      style={{ aspectRatio: '2 / 3', width: '100%' }}
      data-help-region="detail-panel:story_cover"
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      title={interactive ? 'Open Story Settings to set the cover' : undefined}
    >
      {hasCover ? (
        <img
          src={`/api/project/cover?v=${coverVersion}-${storyId || ''}`}
          alt="Story cover"
          className="w-full h-full object-cover"
          onError={() => setHasCover(false)}
        />
      ) : (
        <CoverPlaceholder className="w-full h-full" />
      )}

      {interactive && (
        <div className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-[11px] text-white font-medium pb-2">Edit in Story Settings</span>
        </div>
      )}
    </div>
  )
}
