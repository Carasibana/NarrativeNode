// Shared navigation bar used by EntityDetailPanel and RelationshipDetailPanel.
// Renders a two-row strip: a context block (fixed-height; chapter subtitle
// above the context badge, both vertically centred in the available space)
// and a controls row. All visual sizing is defined here so both panels are
// pixel-identical.
//
// The context block reserves a uniform height so that content below the nav
// bar doesn't shift when navigating between nodes that are / aren't in a
// chapter. When `chapterLabel` is null/empty, the subtitle row is omitted
// and the context badge sits vertically centred alone; when present, the
// subtitle + badge stack centres together. This eliminates the visible gap
// that would show if we reserved fixed space for the subtitle text itself.

const CONTEXT_BLOCK_MIN_H = 34  // px — reserved height regardless of chapter presence

export default function DetailPanelNavBar({
  contextBadge,
  chapterLabel = null,
  canUp, onUp, upTitle = 'Go to parent scene',
  canBack, onBack, onFirst,
  canForward, onForward, onLast,
  position,
  onFocus,
  cornerSlot = null,
  // Phase 1.26 — optional slot rendered absolutely on the bottom-LEFT
  // edge so it doesn't push the centred nav-button row. Used by the
  // SceneDetailView POV-only nav toggle; keeping it as a generic
  // affordance leaves the door open for future per-view left-side
  // controls without forcing each view to absolutely-position its own
  // wrapper.
  leftSlot = null,
}) {
  const btn = (enabled, px = 'px-1.5') =>
    `text-[10px] ${px} py-0.5 rounded ${enabled
      ? 'text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700'
      : 'text-zinc-700 cursor-default'}`

  const trimmedChapter = chapterLabel && String(chapterLabel).trim()

  return (
    <div className="relative px-2 pt-1 pb-0 border-b border-zinc-700 flex-shrink-0" data-help-region="detail-panel:nav">
      {cornerSlot && (
        <div className="absolute bottom-1 right-1 z-10 pointer-events-auto">
          {cornerSlot}
        </div>
      )}
      {leftSlot && (
        <div className="absolute bottom-1 left-1 z-10 pointer-events-auto">
          {leftSlot}
        </div>
      )}
      <div
        className="flex flex-col items-center justify-center pb-0.5"
        style={{ minHeight: CONTEXT_BLOCK_MIN_H }}
      >
        {trimmedChapter && (
          <div
            className="text-[9px] text-zinc-500 italic truncate w-full text-center leading-tight"
            title={trimmedChapter}
          >
            {trimmedChapter}
          </div>
        )}
        <div className="flex items-center justify-center min-h-[18px] max-w-full">
          {contextBadge}
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 py-1">
        <button onClick={canUp ? onUp : undefined} disabled={!canUp}
          className={btn(canUp)}
          title={canUp ? upTitle : ''}
          data-help-region="detail-panel:nav_up">↑</button>
        <button onClick={canBack ? onFirst : undefined} disabled={!canBack}
          className={btn(canBack, 'px-1')}
          title="Skip to first"
          data-help-region="detail-panel:nav_first">⇤</button>
        <button onClick={canBack ? onBack : undefined} disabled={!canBack}
          className={btn(canBack)}
          title="Previous"
          data-help-region="detail-panel:nav_prev">←</button>
        <span className="text-[10px] text-zinc-600" data-help-region="detail-panel:nav_position">{position}</span>
        <button onClick={canForward ? onForward : undefined} disabled={!canForward}
          className={btn(canForward)}
          title="Next"
          data-help-region="detail-panel:nav_next">→</button>
        <button onClick={canForward ? onLast : undefined} disabled={!canForward}
          className={btn(canForward, 'px-1')}
          title="Skip to last"
          data-help-region="detail-panel:nav_last">⇥</button>
        {onFocus && (
          <button onClick={onFocus}
            className="text-[10px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 ml-0.5"
            title="Centre canvas on this node"
            data-help-region="detail-panel:nav_focus">👁</button>
        )}
      </div>
    </div>
  )
}
