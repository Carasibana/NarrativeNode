/**
 * HelpModeController — click-to-inspect "help mode".
 *
 * Mounted once at app root. When help mode is active, the next click on any
 * UI element opens the Help panel jumped to that element's surface (one-shot),
 * then exits. Ctrl+H (Cmd+H) toggles help mode from anywhere; Esc cancels.
 * A dashed outline tracks the tagged element under the cursor so the writer
 * sees exactly what a click will inspect.
 *
 * Entered via the menu-bar Help button (which calls toggleHelpMode) or Ctrl+H.
 * Uncovered / untagged targets resolve to their nearest covered ancestor
 * surface (see utils/helpRegionResolver.js), so a click never dead-ends.
 */
import { useEffect, useState } from 'react'
import { useUiStore } from '../store/uiStore'
import { resolveHelpTargetFromElement } from '../utils/helpRegionResolver'

export default function HelpModeController() {
  const helpMode = useUiStore((s) => s.helpMode)
  const toggleHelpMode = useUiStore((s) => s.toggleHelpMode)
  const setHelpMode = useUiStore((s) => s.setHelpMode)
  const openHelpPanel = useUiStore((s) => s.openHelpPanel)
  const [hoverRect, setHoverRect] = useState(null)

  // Ctrl+H (Cmd+H) toggles help mode from anywhere. Capture phase so we beat
  // the browser's built-in Ctrl+H (Firefox history sidebar) and any bubble
  // handlers. Plain Ctrl+H only — Ctrl+Shift+H is the editor's Find/Replace.
  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'h') return
      e.preventDefault()
      e.stopPropagation()
      toggleHelpMode()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [toggleHelpMode])

  // While active: intercept the next click, resolve it to a surface, open the
  // panel there, and exit (one-shot). Track the hovered element for the
  // outline, and let Esc cancel.
  useEffect(() => {
    if (!helpMode) { setHoverRect(null); return undefined }

    function onClick(e) {
      e.preventDefault()
      e.stopPropagation()
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
      const target = resolveHelpTargetFromElement(e.target)
      setHelpMode(false)
      if (target) openHelpPanel(target)
    }
    function onMove(e) {
      // Outline the nearest tagged ancestor — that's what a click resolves to,
      // so the highlight matches what will actually be inspected.
      let node = e.target
      while (
        node && node !== document.body &&
        typeof node.getAttribute === 'function' && !node.getAttribute('data-help-region')
      ) {
        node = node.parentElement
      }
      if (node && typeof node.getAttribute === 'function' && node.getAttribute('data-help-region')) {
        const r = node.getBoundingClientRect()
        setHoverRect({ left: r.left, top: r.top, width: r.width, height: r.height })
      } else {
        setHoverRect(null)
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setHelpMode(false) }
    }

    window.addEventListener('click', onClick, { capture: true })
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('keydown', onKey, { capture: true })
    document.body.classList.add('help-mode-active')
    return () => {
      window.removeEventListener('click', onClick, { capture: true })
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('keydown', onKey, { capture: true })
      document.body.classList.remove('help-mode-active')
    }
  }, [helpMode, setHelpMode, openHelpPanel])

  if (!helpMode) return null

  return (
    <>
      {hoverRect && (
        <div
          className="fixed pointer-events-none z-[9998] border-2 border-accent-400 bg-accent-400/10 rounded-sm"
          style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }}
        />
      )}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none px-3 py-1.5 rounded-full bg-accent-700 text-white text-xs shadow-lg flex items-center gap-2 whitespace-nowrap">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
        Help mode: click any element for its help. Esc to cancel.
      </div>
    </>
  )
}
