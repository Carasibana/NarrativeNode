/**
 * ApplyToSectionMenu — Phase 2.9b item 4 (whole-message apply).
 *
 * The Apply icon button in each assistant message bubble's hover
 * action row. Click opens the shared `ApplyToSectionPicker` popover
 * with the WHOLE message as the source. Item 5 (excerpt apply via
 * right-click on a selection) uses the same picker with the
 * selection text as the source — see `MessageBubble.jsx`'s
 * contextmenu handler.
 *
 * Availability rule: the button is only usable when an editor surface
 * is mounted in the right sidebar (i.e. `uiStore.currentEditorSurface`
 * is non-null). Disabled with explanatory tooltip otherwise. Symmetric
 * with Attach-to-Chat being unavailable from the editor when the
 * chat panel isn't open.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import ApplyToSectionPicker from './ApplyToSectionPicker'

export default function ApplyToSectionMenu({ messageContent, dataHelpRegion, ...props }) {
  // ApplyIcon is rendered as a JSX element below; destructure it in the
  // body so it is recognised as a used local (the lint config does not
  // count JSX element-tag usage of destructured parameters).
  const { ApplyIcon } = props
  const editorSurface = useUiStore((s) => s.currentEditorSurface)
  // v0.2.9.72 — when an MCP session has the editor lock active (Phase
  // 2.1 lockout), the chat panel's Apply-to-Editor-Section affordance
  // is disabled because applying would mutate the editor concurrently
  // with the AI's in-flight edits. Chat-conversation exchanges
  // themselves remain available (the writer can keep talking to the
  // AI), only the editor-mutating action is gated off. Lock releases
  // → button re-enables.
  const isMcpEditLocked = useMcpControlStore((s) => s.sessionState === 'active')
  const buttonRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ left: 0, top: 0 })

  const disabled = !editorSurface || !messageContent || isMcpEditLocked

  const handleToggle = useCallback(() => {
    if (disabled) return
    setOpen((v) => !v)
  }, [disabled])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  // Anchor popover under the button on open.
  useEffect(() => {
    if (!open) return
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverPos({
      left: Math.max(8, rect.right - 240),
      top: rect.bottom + 4,
    })
  }, [open])

  const title = disabled
    ? (isMcpEditLocked
        ? 'Apply to Editor Section unavailable while an MCP session is active. End or pause the session to re-enable.'
        : !editorSurface
          ? 'Apply to Editor Section unavailable: open the editor panel on a scene / cue / reference / entity notes / knowledge notes to enable this.'
          : 'Nothing to apply (empty message).')
    : 'Apply this message to a Section in the open editor surface (Overwrite / Append / Prepend).'

  const buttonClass = disabled
    ? 'flex items-center justify-center w-5 h-5 rounded border border-zinc-800 bg-zinc-900/30 text-zinc-600 cursor-not-allowed opacity-50 transition-colors'
    : 'flex items-center justify-center w-5 h-5 rounded border border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 transition-colors'

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : handleToggle}
        title={title}
        aria-label={title}
        data-help-region={dataHelpRegion}
        className={buttonClass}
      ><ApplyIcon /></button>
      <ApplyToSectionPicker
        open={open}
        left={popoverPos.left}
        top={popoverPos.top}
        sourceMarkdown={messageContent || ''}
        onClose={handleClose}
        ignoreOutsideClickRefs={[buttonRef]}
      />
    </>
  )
}
