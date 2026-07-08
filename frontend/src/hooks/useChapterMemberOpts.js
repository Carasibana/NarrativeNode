/**
 * useChapterMemberOpts — reactive, store-backed `memberOpts` for the
 * mode-aware chapter resolver `resolveChapterIdForNode`.
 *
 * Recurrence guard for the "single-row membership in a multi-row context"
 * bug class: a component that reads a node's LIVE canvas position to decide
 * its chapter must NOT call the single-row `getChapterIdForNode` directly —
 * in multi-row mode the per-row display position resolves to the wrong
 * chapter. Instead:
 *
 *     const memberOpts = useChapterMemberOpts()
 *     const chapterId = resolveChapterIdForNode(node, chapters, memberOpts)
 *
 * The hook subscribes to the three story-level layout fields that drive
 * membership and returns a memoised opts object, so it recomputes only when
 * the layout mode, the row grouping, or the x-offset actually changes.
 *
 * For non-React callers (store actions, MCP tools, pure utils that already
 * receive a `story`) use the pure `resolveChapterIdForNodeForStory(node,
 * story)` / `chapterMemberOptsForStory(story)` helpers in
 * `utils/chapterMembership.js` instead.
 */
import { useMemo } from 'react'
import { useProjectStore } from '../store/projectStore'
import { chapterMemberOptsForStory } from '../utils/chapterMembership'

export function useChapterMemberOpts() {
  const layoutMode = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const chapterRows = useProjectStore((s) => s.story?.chapter_rows || null)
  const chapterXOffset = useProjectStore((s) =>
    typeof s.story?.chapter_x_offset === 'number' ? s.story.chapter_x_offset : 10,
  )
  return useMemo(
    () =>
      chapterMemberOptsForStory({
        canvas_layout_mode: layoutMode,
        chapter_rows: chapterRows,
        chapter_x_offset: chapterXOffset,
      }),
    [layoutMode, chapterRows, chapterXOffset],
  )
}
