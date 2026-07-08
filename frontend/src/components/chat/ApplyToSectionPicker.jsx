/**
 * ApplyToSectionPicker — Phase 2.9b shared picker popover.
 *
 * The two-panel popover (Section picker → mode chooser) used by both:
 *   - `ApplyToSectionMenu` (whole-message apply, item 4) — opens from
 *     the Apply icon button in each assistant bubble's hover toolbar.
 *   - MessageBubble's right-click excerpt-apply handler (item 5) —
 *     opens at the click point when the writer right-clicks on a
 *     non-empty text selection inside an assistant bubble.
 *
 * Pure UI shell — `applyToEditorSection` does the actual work. The
 * picker only listed the targets, captured the mode pick, and called
 * the dispatcher with the supplied `sourceMarkdown` (+ optional
 * `plainText` flag for Scene Description targets when those land).
 *
 * Caller is responsible for:
 *   - open / close state (the picker calls `onClose` on apply / cancel)
 *   - position (passed via `left` / `top` props in viewport coords)
 *   - source markdown content (whole message OR excerpt)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../store/uiStore'
import {
  applyToEditorSection,
  listSectionsInSurface,
  SCENE_DESCRIPTION_SECTION_ID,
} from '../../utils/applyToEditorSection'

const MODES = [
  {
    key: 'prepend',
    label: 'Prepend',
    description: "Add this content before the Section's current content.",
  },
  {
    key: 'overwrite',
    label: 'Overwrite',
    description: "Replace the Section's content with this content.",
  },
  {
    key: 'append',
    label: 'Append',
    description: "Add this content after the Section's current content.",
  },
]

export default function ApplyToSectionPicker({
  open,
  left,
  top,
  sourceMarkdown,
  plainText = false,
  onClose,
  // Optional refs whose contents should NOT count as outside-clicks.
  // Used by the button-driven entry point so clicking the open-toggle
  // button doesn't immediately re-close the picker.
  ignoreOutsideClickRefs = [],
  // When true, the picker opens at a small "context actions" prelude
  // (Copy + Apply to Section...) before advancing into the section
  // picker. Used by MessageBubble's right-click excerpt handler so
  // mouse-first writers still have a Copy affordance in place of
  // the suppressed browser default context menu. The toolbar Apply
  // button (whole-message path) skips this — bubble already has a
  // Copy icon in its hover toolbar.
  showInitialActions = false,
}) {
  const editorSurface = useUiStore((s) => s.currentEditorSurface)
  const sceneDescriptionExpanded = useUiStore((s) => s.sceneDescriptionExpanded)
  const popoverRef = useRef(null)
  const [pickedSectionId, setPickedSectionId] = useState(null)
  // Three-state flow: 'initial' (context actions prelude) → 'sections'
  // (section picker) → driven by pickedSectionId for 'modes' (mode
  // chooser). `'initial'` only used when showInitialActions is true;
  // skipped otherwise so the button-driven path opens straight at the
  // section picker as before.
  const [step, setStep] = useState('sections')

  // Reset on each re-open. When the prelude is active, start there;
  // otherwise skip straight to the section picker.
  useEffect(() => {
    if (open) {
      setPickedSectionId(null)
      setStep(showInitialActions ? 'initial' : 'sections')
    }
  }, [open, showInitialActions])

  const handleCopy = useCallback(() => {
    if (typeof sourceMarkdown === 'string' && navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(sourceMarkdown).catch(() => {
        // Best-effort — older browsers / non-secure contexts may
        // reject. We don't surface an error here; the writer can
        // fall back to Ctrl+C if the clipboard write silently fails.
      })
    }
    onClose?.()
  }, [sourceMarkdown, onClose])

  const sections = useMemo(() => {
    if (!open || !editorSurface) return []
    const base = listSectionsInSurface(editorSurface.surface_type, editorSurface.surface_host_id)
    // v0.2.9.71 — Scene Description target. Offered ONLY when:
    //   (a) the active editor surface is a scene's main content, AND
    //   (b) the Scene Description block is currently EXPANDED in the
    //       editor (the writer is actively looking at it).
    // Collapsed → not offered, on the principle that AI-applied
    // content should land somewhere the writer can immediately see.
    if (
      editorSurface.surface_type === 'scene_main'
      && sceneDescriptionExpanded === true
    ) {
      return [
        { id: SCENE_DESCRIPTION_SECTION_ID, name: 'Scene Description', isDescription: true },
        ...base,
      ]
    }
    return base
  }, [open, editorSurface, sceneDescriptionExpanded])

  const handleApply = useCallback((sectionId, mode) => {
    if (!editorSurface || typeof sourceMarkdown !== 'string') {
      onClose?.()
      return
    }
    // Scene Description target is plain-text-only — coerce the
    // dispatcher's plainText flag on so the writer doesn't get HTML /
    // markdown formatting bled into a plain-text field even if the
    // caller didn't set it.
    const forcePlain = sectionId === SCENE_DESCRIPTION_SECTION_ID
    applyToEditorSection({
      surface_type: editorSurface.surface_type,
      surface_host_id: editorSurface.surface_host_id,
      section_id: sectionId,
      sourceMarkdown,
      mode,
      plainText: forcePlain || plainText,
    })
    onClose?.()
  }, [editorSurface, sourceMarkdown, plainText, onClose])

  // Click-outside + Escape close.
  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (popoverRef.current?.contains(e.target)) return
      for (const r of ignoreOutsideClickRefs) {
        if (r?.current?.contains(e.target)) return
      }
      onClose?.()
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, ignoreOutsideClickRefs])

  if (!open) return null

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[60] min-w-[240px] max-w-[280px] rounded-md border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur-sm py-1 text-[11px]"
      style={{ left, top }}
      role="menu"
      aria-label="Apply to Editor Section"
      data-help-region="apply-to-section:popover"
    >
      {pickedSectionId
        ? <ModePickerPanel
            sectionName={sections.find((s) => s.id === pickedSectionId)?.name || ''}
            onPick={(mode) => handleApply(pickedSectionId, mode)}
            onBack={() => setPickedSectionId(null)}
          />
        : step === 'initial'
          ? <InitialActionsPanel
              onCopy={handleCopy}
              onApply={() => setStep('sections')}
            />
          : <SectionPickerPanel
              sections={sections}
              onPick={setPickedSectionId}
              onBack={showInitialActions ? () => setStep('initial') : null}
            />}
    </div>,
    document.body,
  )
}

function InitialActionsPanel({ onCopy, onApply }) {
  return (
    <ul className="py-0.5">
      <li>
        <button
          type="button"
          onClick={onCopy}
          className="w-full text-left px-3 py-1.5 hover:bg-zinc-800/70 text-zinc-200 flex items-center gap-2"
        >
          <span className="text-zinc-200">Copy</span>
          <span className="ml-auto text-[10px] text-zinc-500 normal-case">selection to clipboard</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          onClick={onApply}
          className="w-full text-left px-3 py-1.5 hover:bg-zinc-800/70 text-zinc-200 flex items-center gap-2"
        >
          <span className="text-zinc-200">Apply to Section…</span>
          <span className="ml-auto text-zinc-500">›</span>
        </button>
      </li>
    </ul>
  )
}

function SectionPickerPanel({ sections, onPick, onBack }) {
  if (!sections.length) {
    return (
      <>
        {onBack && (
          <div className="px-3 py-1.5 text-[9.5px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            <button
              type="button"
              onClick={onBack}
              className="text-zinc-400 hover:text-zinc-200 normal-case tracking-normal"
              title="Back"
            >
              ← Back
            </button>
          </div>
        )}
        <div className="px-3 py-2 text-zinc-400 italic">
          No Sections in the open editor surface.
          <div className="mt-1 text-[10px] text-zinc-500 normal-case">
            Insert a Section in the editor first (Section button in the editor toolbar, or right-click in the editor area).
          </div>
        </div>
      </>
    )
  }
  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 text-[9.5px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        {onBack
          ? (
            <button
              type="button"
              onClick={onBack}
              className="text-zinc-400 hover:text-zinc-200 normal-case tracking-normal"
              title="Back"
            >
              ← Back
            </button>
          ) : <span />}
        <span>Pick a Section to apply to</span>
      </div>
      <ul className="py-0.5 max-h-[280px] overflow-y-auto" data-help-region="apply-to-section:section_list">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s.id)}
              className="w-full text-left px-3 py-1.5 hover:bg-zinc-800/70 text-zinc-200 flex items-center gap-2"
            >
              {s.isDescription
                ? <span className="text-amber-400/80 text-[10px] uppercase tracking-wide">Description</span>
                : <span className="text-cyan-400/80 text-[10px] uppercase tracking-wide">Section</span>}
              <span className="truncate">{s.name || '(unnamed)'}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function ModePickerPanel({ sectionName, onPick, onBack }) {
  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 text-[9.5px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        <button
          type="button"
          onClick={onBack}
          className="text-zinc-400 hover:text-zinc-200 normal-case tracking-normal"
          title="Back to section picker"
        >
          ← Back
        </button>
        <span className="truncate text-cyan-400/80 max-w-[150px]" title={sectionName}>
          {sectionName || '(unnamed)'}
        </span>
      </div>
      <ul className="py-0.5" data-help-region="apply-to-section:mode_chooser">
        {MODES.map((m) => (
          <li key={m.key}>
            <button
              type="button"
              onClick={() => onPick(m.key)}
              className="w-full text-left px-3 py-1.5 hover:bg-zinc-800/70 text-zinc-200"
              title={m.description}
            >
              <div className="font-semibold">{m.label}</div>
              <div className="text-[10px] text-zinc-500 leading-snug">{m.description}</div>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
