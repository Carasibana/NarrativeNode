import { useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import StoryCoverThumb from '../ui/StoryCoverThumb'

/**
 * Phase 5.2b — empty Detail Panel state.
 *
 * The story cover (or placeholder), title, and "By: <author>" line sit
 * at the top; the "select a node" hint is vertically centred in the
 * FULL panel (not just the space beneath the text). To keep the hint at
 * the panel's true centre without the cover overlapping it, the cover's
 * width is CAPPED so its (2:3) height keeps the cover + title + author
 * block entirely above the centred hint: cover height ≤ panelCentre −
 * (hint half-height + padding + gap + title/author height). On a short
 * panel the cover shrinks; it is never cut off and never pushes the
 * hint off-centre. Clicking the cover opens Story Settings.
 */
export default function EmptyDetailState() {
  const title = useProjectStore((s) => s.story?.title) || 'Untitled Story'
  const author = (useProjectStore((s) => s.story?.author) || '').trim()
  const description = (useProjectStore((s) => s.story?.description) || '').trim()

  const rootRef = useRef(null)
  const topRef = useRef(null)      // title + author block (height is cover-independent)
  const hintRef = useRef(null)     // the "select a node" line
  const [coverMaxW, setCoverMaxW] = useState(180)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const recompute = () => {
      const cs = getComputedStyle(root)
      const padTop = parseFloat(cs.paddingTop || '0')
      const panelH = root.clientHeight
      const topTextH = topRef.current?.offsetHeight || 0   // title + author
      const hintH = hintRef.current?.offsetHeight || 0
      const GAP = 8 // cover→title gap (gap-2)
      // Top edge of the centred hint, measured from the panel top.
      const hintTop = panelH / 2 - hintH / 2
      // Cover must fit between the top padding and the hint's top edge,
      // above the title/author block. 2:3 ⇒ width = height * 2/3.
      const maxCoverH = hintTop - padTop - GAP - topTextH
      setCoverMaxW(Math.max(48, Math.round((maxCoverH * 2) / 3)))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(root)
    if (topRef.current) ro.observe(topRef.current)
    if (hintRef.current) ro.observe(hintRef.current)
    return () => ro.disconnect()
  }, [title, author, description])

  return (
    <div ref={rootRef} data-help-region="detail-panel:empty_state" className="relative flex-1 min-h-0 p-4">
      {/* Cover + title + author, anchored at the top. */}
      <div className="w-full flex flex-col items-center gap-2">
        <div data-help-region="detail-panel:empty_cover" className="w-full flex justify-center">
          <div style={{ width: '100%', maxWidth: coverMaxW }}>
            <StoryCoverThumb onClick={() => useUiStore.getState().requestSettingsOpen('story')} />
          </div>
        </div>
        <div ref={topRef} data-help-region="detail-panel:empty_meta" className="w-full flex flex-col items-center gap-0.5 px-1">
          <div className="text-sm font-medium text-zinc-200 text-center break-words leading-snug">
            {title}
          </div>
          {author && (
            <div className="text-xs italic text-zinc-500 text-center break-words">
              By: {author}
            </div>
          )}
          <div
            data-help-region="detail-panel:empty_description"
            onClick={() => useUiStore.getState().requestSettingsOpen('story')}
            title="Click to edit in Story Settings"
            className={
              description
                ? 'mt-1.5 text-xs text-zinc-400 text-center leading-relaxed break-words whitespace-pre-line cursor-pointer hover:text-zinc-300 transition-colors'
                : 'mt-1.5 text-xs italic text-zinc-600 text-center cursor-pointer hover:text-zinc-400 transition-colors'
            }
            style={description ? { display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}
          >
            {description || 'No Story Description Set'}
          </div>
        </div>
      </div>

      {/* Hint centred in the FULL panel. */}
      <div className="absolute inset-0 flex items-center justify-center px-4 pointer-events-none">
        <span ref={hintRef} data-help-region="detail-panel:empty_hint" className="text-xs text-zinc-600 italic text-center leading-relaxed">
          Select a node on the canvas to view its details.
        </span>
      </div>
    </div>
  )
}
