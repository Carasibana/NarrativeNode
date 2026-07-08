import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, FontSize, FontFamily } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import CharacterCount from '@tiptap/extension-character-count'
import { EntityHighlightExtension, refreshEntityHighlights } from './EntityHighlightPlugin'
import { useAccentColor } from '../../utils/povConstants'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import { NameDetectToggle } from '../chat/AutoAttachToggle'
import { FindMatchHighlightExtension } from './FindMatchHighlightPlugin'
import { SectionExtension, createSection } from './SectionExtension'
import { IpbAnchorDecorationExtension, computeIpbChromePos } from './IpbAnchorDecoration'
import { PromptBlockAutoAttachExtension } from './PromptBlockAutoAttachExtension'
import { useUiStore } from '../../store/uiStore'
import SectionCreationChooser from './SectionCreationChooser'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import EntityHoverPreview from './EntityHoverPreview'
import FindReplacePanel from './FindReplacePanel'
import { useProjectStore } from '../../store/projectStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useIpbStore, IPB_FORM_KEY, setIpbEditor } from '../../store/ipbStore'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useEditorSurface } from './EditorSurfaceContext'

const FONT_SIZES = [
  { label: 'Small', value: '12px' },
  { label: 'Normal', value: null },
  { label: 'Large', value: '18px' },
  { label: 'Huge', value: '24px' },
]

const FONT_FAMILIES = [
  { label: 'Default', value: null },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Sans-serif', value: 'system-ui, "Segoe UI", Roboto, sans-serif' },
  { label: 'Monospace', value: 'Consolas, "Courier New", monospace' },
]

const TEXT_COLOURS = [
  { label: 'Default', value: null },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Grey', value: '#9ca3af' },
]

const HIGHLIGHT_COLOURS = [
  { label: 'None', value: null },
  { label: 'Yellow', value: '#854d0e' },
  { label: 'Green', value: '#166534' },
  { label: 'Blue', value: '#1e3a5f' },
  { label: 'Purple', value: '#581c87' },
  { label: 'Red', value: '#7f1d1d' },
  { label: 'Orange', value: '#7c2d12' },
]

// ── Toolbar primitives ──────────────────────────────────────────────────────

function ToolbarButton({ active, onClick, title, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      title={title}
      className={`px-1.5 py-1 text-xs rounded transition-colors ${
        active
          ? 'bg-accent-700 text-white'
          : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-4 bg-zinc-700 mx-1" />
}

// Toolbar group wrapper. Keeps a set of buttons together as a single
// inline-flex unit so they wrap as a group (not individually) when the
// toolbar row narrows. Hoisted to module scope so its component
// identity is stable across re-renders — defining it inside the
// `EditorToolbar` function body re-created a new component reference
// on every editor transaction, which during IPB streaming caused React
// to unmount + remount every `<G>` subtree ~10x/second. The remount
// reset the browser's hover state on enclosed buttons (visible as a
// slight bg-dim flicker on the IPB Stop button during streaming) and
// occasionally dropped clicks that landed mid-remount.
function G({ children }) {
  return <span className="inline-flex items-center gap-0.5 flex-nowrap">{children}</span>
}

// ── Entity type filter context menu (right-click on Names button) ───────────

const ENTITY_TYPE_OPTIONS = [
  { key: 'character', icon: TYPE_ICONS.character, label: 'Characters' },
  { key: 'location',  icon: TYPE_ICONS.location,  label: 'Locations' },
  { key: 'item',      icon: TYPE_ICONS.item,      label: 'Items' },
  { key: 'faction',   icon: TYPE_ICONS.faction,    label: 'Factions' },
  { key: 'custom',    icon: TYPE_ICONS.custom,     label: 'Custom' },
]

function EntityTypeFilterMenu({ position, enabledTypes, onToggleType, onClose, excludeRef }) {
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target) && !(excludeRef?.current && excludeRef.current.contains(e.target))) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, excludeRef])

  return (
    <div
      ref={ref}
      className="fixed bg-zinc-800 border border-zinc-600 rounded shadow-lg z-50 py-1 min-w-[150px]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wider">Highlight Types</div>
      {ENTITY_TYPE_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onToggleType(opt.key)}
          className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
        >
          <span className="w-4 text-center">{enabledTypes[opt.key] ? '☑' : '☐'}</span>
          <span>{opt.icon}</span>
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

// ── Colour picker dropdown ──────────────────────────────────────────────────

function ColourPicker({ colours, activeValue, onSelect, title, icon, dataHelpRegion }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={ref} data-help-region={dataHelpRegion}>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v) }}
        title={title}
        className="px-1.5 py-1 text-xs rounded transition-colors font-bold"
        style={{
          backgroundColor: activeValue || '#3f3f46',
          color: activeValue ? '#fff' : '#a1a1aa',
        }}
      >
        {icon}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-600 rounded shadow-lg z-50 p-1.5 flex gap-1 flex-wrap min-w-[120px]">
          {colours.map((c) => (
            <button
              key={c.label}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onSelect(c.value); setOpen(false) }}
              title={c.label}
              className={`w-6 h-6 rounded border transition-colors ${
                activeValue === c.value ? 'border-white ring-1 ring-white' : 'border-zinc-600 hover:border-zinc-400'
              }`}
              style={{ backgroundColor: c.value || '#3f3f46' }}
            >
              {!c.value && <span className="text-[9px] text-zinc-400 leading-none">✕</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Font family dropdown ────────────────────────────────────────────────────

function FontFamilySelect({ editor }) {
  const currentFamily = editor.getAttributes('textStyle').fontFamily || null

  return (
    <select
      value={currentFamily || ''}
      onChange={(e) => {
        const val = e.target.value || null
        if (val) {
          editor.chain().focus().setFontFamily(val).run()
        } else {
          editor.chain().focus().unsetFontFamily().run()
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title="Font"
      name="editor-font-family"
      aria-label="Font family"
      data-help-region="editor-panel:font_family"
      className="bg-zinc-800 text-zinc-300 text-xs border border-zinc-700 rounded px-1 py-0.5 cursor-pointer hover:border-zinc-500 focus:outline-none focus:border-accent-500 max-w-[90px]"
    >
      {FONT_FAMILIES.map((f) => (
        <option key={f.label} value={f.value || ''} style={f.value ? { fontFamily: f.value } : undefined}>{f.label}</option>
      ))}
    </select>
  )
}

// ── Font size dropdown ──────────────────────────────────────────────────────

function FontSizeSelect({ editor }) {
  const currentSize = editor.getAttributes('textStyle').fontSize || null

  return (
    <select
      value={currentSize || ''}
      onChange={(e) => {
        const val = e.target.value || null
        if (val) {
          editor.chain().focus().setFontSize(val).run()
        } else {
          editor.chain().focus().unsetFontSize().run()
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title="Font Size"
      name="editor-font-size"
      aria-label="Font size"
      data-help-region="editor-panel:font_size"
      className="bg-zinc-800 text-zinc-300 text-xs border border-zinc-700 rounded px-1 py-0.5 cursor-pointer hover:border-zinc-500 focus:outline-none focus:border-accent-500"
    >
      {FONT_SIZES.map((s) => (
        <option key={s.label} value={s.value || ''}>{s.label}</option>
      ))}
    </select>
  )
}

// ── (link button removed; the Link extension is also no longer registered) ──

// ── Formatting toolbar ──────────────────────────────────────────────────────

function EditorToolbar({ editor, entityHighlight, entityHighlightEnabled, onToggleEntityHighlight, lightMode, onToggleLightMode, enabledEntityTypes, onToggleEntityType, findReplaceOpen, onToggleFindReplace, ipbActive, ipbIsStreaming, onIpbToolbarClick }) {
  // Phase 5.7 — hide the AI insert buttons (Section + Inline Prompt
  // Block) when AI integrations are disabled.
  const aiDisabled = useAiDisabled()
  // Force re-render on every editor transaction (selection change, formatting change, etc.)
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (!editor) return
    const handler = () => forceUpdate((n) => n + 1)
    editor.on('transaction', handler)
    return () => editor.off('transaction', handler)
  }, [editor])

  if (!editor) return null

  // Returns the colour if consistent across the selection, or null if mixed/absent.
  // Ignores default (null) — only falls back to null if two or more distinct custom colours exist.
  const getConsistentMark = (markName, attrName) => {
    const { from, to, empty } = editor.state.selection
    if (empty) return editor.getAttributes(markName)[attrName] || null
    const values = new Set()
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return
      const mark = node.marks.find((m) => m.type.name === markName)
      values.add(mark ? (mark.attrs[attrName] || null) : null)
    })
    const customColours = [...values].filter(Boolean)
    if (customColours.length === 1) return customColours[0]
    if (customColours.length > 1) return null
    return null // all default
  }

  const textColour = getConsistentMark('textStyle', 'color')
  const highlightColour = getConsistentMark('highlight', 'color')

  return (
    <div className="border-b border-zinc-700 bg-zinc-900/60 flex-shrink-0 px-2 py-1 space-y-0.5" data-help-region="editor-panel:toolbar">
      {/* ── Row 1: headings, font, inline style, colour, alignment — Names pinned right ── */}
      <div className="flex items-start gap-0.5">
        <div className="flex items-center gap-0.5 flex-wrap flex-1 min-w-0">
          <G>
            <ToolbarButton active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1" data-help-region="editor-panel:heading_1">H1</ToolbarButton>
            <ToolbarButton active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2" data-help-region="editor-panel:heading_2">H2</ToolbarButton>
            <ToolbarButton active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3" data-help-region="editor-panel:heading_3">H3</ToolbarButton>
          </G>

          <Divider />

          <G>
            <FontFamilySelect editor={editor} />
            <FontSizeSelect editor={editor} />
          </G>

          <Divider />

          <G>
            <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)" data-help-region="editor-panel:bold"><strong>B</strong></ToolbarButton>
            <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)" data-help-region="editor-panel:italic"><em>I</em></ToolbarButton>
            <ToolbarButton active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (Ctrl+U)" data-help-region="editor-panel:underline"><span className="underline">U</span></ToolbarButton>
            <ToolbarButton active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough" data-help-region="editor-panel:strikethrough"><s>S</s></ToolbarButton>
          </G>

          <Divider />

          <G>
            <ColourPicker colours={TEXT_COLOURS} activeValue={textColour} onSelect={(val) => { if (val) { editor.chain().focus().setColor(val).run() } else { editor.chain().focus().unsetColor().run() } }} title="Text Colour" icon="A" dataHelpRegion="editor-panel:text_colour" />
            <ColourPicker colours={HIGHLIGHT_COLOURS} activeValue={highlightColour} onSelect={(val) => { if (val) { editor.chain().focus().toggleHighlight({ color: val }).run() } else { editor.chain().focus().unsetHighlight().run() } }} title="Highlight" icon="H" dataHelpRegion="editor-panel:highlight_colour" />
          </G>

          <Divider />

          <G>
            <ToolbarButton active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Align Left" data-help-region="editor-panel:align_left">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="1" y1="3" x2="13" y2="3"/><line x1="1" y1="7" x2="9" y2="7"/><line x1="1" y1="11" x2="13" y2="11"/></svg>
            </ToolbarButton>
            <ToolbarButton active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Align Centre" data-help-region="editor-panel:align_centre">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="1" y1="3" x2="13" y2="3"/><line x1="3" y1="7" x2="11" y2="7"/><line x1="1" y1="11" x2="13" y2="11"/></svg>
            </ToolbarButton>
            <ToolbarButton active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Align Right" data-help-region="editor-panel:align_right">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="1" y1="3" x2="13" y2="3"/><line x1="5" y1="7" x2="13" y2="7"/><line x1="1" y1="11" x2="13" y2="11"/></svg>
            </ToolbarButton>
            <ToolbarButton active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()} title="Justify" data-help-region="editor-panel:align_justify">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="1" y1="3" x2="13" y2="3"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="11" x2="13" y2="11"/></svg>
            </ToolbarButton>
          </G>
        </div>

        <span className="inline-flex items-center gap-0.5 flex-shrink-0 ml-auto">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleLightMode}
            data-help-region="editor-panel:light_mode"
            title={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}
            className={`w-7 py-1 text-xs text-center rounded transition-colors ${
              lightMode
                ? 'hover:brightness-90'
                : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
            style={lightMode
              ? { backgroundColor: '#e4e4e7', color: '#27272a' }
              : { outline: '1px solid #3f3f46' }
            }
          >
            {lightMode ? '☾' : '☼'}
          </button>
          {entityHighlight && (
            // Phase 2.8 — the legacy `🖍 Names` button + bespoke
            // `EntityTypeFilterMenu` popover have been replaced by
            // the shared `<NameDetectToggle>` used in the chat
            // composer. Same icon design (rainbow-edged tag-chip),
            // same split-button + chevron + flyout layout. The
            // editor consumer omits the subtoggle props so the
            // "also auto-attach" row doesn't render — auto-attach
            // isn't a concept that applies here. Flyout defaults to
            // opening downward, suiting the editor's top-anchored
            // toolbar.
            <span data-help-region="editor-panel:highlight_names">
              <NameDetectToggle
                enabled={entityHighlightEnabled}
                onToggle={onToggleEntityHighlight}
                selectedTypes={enabledEntityTypes}
                onToggleType={onToggleEntityType}
                toggleTooltipOn="Highlight detected names: ON. Click to disable; click ▾ to pick kinds."
                toggleTooltipOff="Highlight detected names: OFF. Click to enable; click ▾ to pick kinds."
                flyoutHeading="Highlight names of"
              />
            </span>
          )}
        </span>
      </div>

      {/* ── Row 2: lists, block elements, link ── */}
      <div className="flex items-center gap-0.5 flex-wrap">
        {/* Phase 1.24c — TipTap-scoped undo / redo. These walk the
            editor's internal history (per-keystroke) and are
            independent of the canvas-level undo. Ctrl+Z / Ctrl+Y
            already route to the editor when focus is in the editor
            body (canvas keydown handler short-circuits on
            contenteditable / input focus), so no double-fire risk. */}
        <G>
          <ToolbarButton
            active={false}
            onClick={() => {
              // Editor's per-scene history first; if there's nothing
              // for this scene to undo (e.g. a Find/Replace happened
              // in a different scene before navigation), fall back to
              // the canvas-level snapshot stack so cross-scene replaces
              // can be rolled back from this button. Find/Replace
              // takes a canvas snapshot before each Replace so this
              // fallback restores the affected scene's main_content.
              if (editor.can().undo()) {
                editor.chain().focus().undo().run()
              } else {
                useProjectStore.getState().undo()
              }
            }}
            title="Undo (Ctrl+Z) — editor history, falls through to canvas undo for cross-scene Find/Replace"
            data-help-region="editor-panel:undo"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 L2 7 L5 10" />
              <path d="M2 7 L9 7 A3 3 0 0 1 12 10 L12 11" />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            active={false}
            onClick={() => {
              if (editor.can().redo()) {
                editor.chain().focus().redo().run()
              } else {
                useProjectStore.getState().redo()
              }
            }}
            title="Redo (Ctrl+Y) — editor history, falls through to canvas redo for cross-scene Find/Replace"
            data-help-region="editor-panel:redo"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4 L12 7 L9 10" />
              <path d="M12 7 L5 7 A3 3 0 0 0 2 10 L2 11" />
            </svg>
          </ToolbarButton>
        </G>

        <Divider />

        <G>
          <ToolbarButton active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List" data-help-region="editor-panel:bullet_list">&#8226; List</ToolbarButton>
          <ToolbarButton active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered List" data-help-region="editor-panel:numbered_list">1. List</ToolbarButton>
        </G>

        <Divider />

        <G>
          <ToolbarButton active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote" data-help-region="editor-panel:blockquote">&ldquo; Quote</ToolbarButton>
          <ToolbarButton active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code Block" data-help-region="editor-panel:code_block">{'</>'}</ToolbarButton>
          <ToolbarButton active={false} onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule" data-help-region="editor-panel:horizontal_rule">―</ToolbarButton>
        </G>

        <Divider />

        {/* Phase 2.9a item 3 — Insert Section + Insert Inline Prompt
            Block as two side-by-side direct buttons in the toolbar
            (the earlier single-button-opens-chooser approach was
            split per the writer's call in v0.2.9.15). The right-click
            context menu in the editor's prose area still uses the
            shared chooser (rendered by the parent) so the two
            creation paths stay listed together in one menu there. */}
        {!aiDisabled && (<>
        <G>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => createSection(editor)}
            title="Insert Section"
            data-help-region="editor-panel:insert_section"
            className="px-1.5 py-1 text-xs rounded transition-colors text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" />
              <line x1="7" y1="4.5" x2="7" y2="9.5" />
              <line x1="4.5" y1="7" x2="9.5" y2="7" />
            </svg>
          </button>
          {/* Phase 2.9c item 2 — Inline Prompt Block contextual
              button. Three states driven by the live IPB state:
              (1) No IPB → create. (2) IPB idle → dismiss toggle.
              (3) IPB streaming → stop (Send wiring lands in item 4
              alongside the actual stream-cancel). */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onIpbToolbarClick}
            data-help-region="editor-panel:inline_prompt_block"
            title={
              ipbIsStreaming
                ? 'Stop the Inline Prompt Block\'s streaming response'
                : ipbActive
                  ? 'Dismiss the Inline Prompt Block'
                  : 'Insert an Inline Prompt Block at the cursor'
            }
            aria-label={
              ipbIsStreaming ? 'Stop' : ipbActive ? 'Dismiss' : 'Insert Inline Prompt Block'
            }
            className={`px-1.5 py-1 text-xs rounded transition-colors ${
              ipbIsStreaming
                ? 'text-red-200 bg-red-900/40 hover:bg-red-900/60 border border-red-800/60'
                : ipbActive
                  ? 'text-accent-200 bg-accent-900/30 hover:bg-accent-900/50 border border-accent-700/60'
                  : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            {ipbIsStreaming ? (
              /* Filled square — same media-stop glyph everywhere. */
              <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" rx="0.8" />
              </svg>
            ) : ipbActive ? (
              /* × — dismiss affordance. */
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" />
              </svg>
            ) : (
              /* Inverted-teardrop pin — same geometry as the IPB's
                 streaming / drag visual (InlinePromptBlockPin's SVG
                 path) so this toolbar button visually represents
                 the element it creates. Stroke uses currentColor
                 so it picks up the button's idle / hover tint. */
              <svg width="10" height="14" viewBox="0 0 26 36" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" aria-hidden="true">
                <path d="M 13 36 L 22.1 16.2 A 10 10 0 1 0 3.9 16.2 Z" />
              </svg>
            )}
          </button>
        </G>

        <Divider />
        </>)}

        {/* Phase 1.24c — Find & Replace toggle. One button opens a
            unified panel with both Find-next and Replace-and-next
            actions inside, so the writer can use it for read-only
            search OR search-with-replace from the same panel. Both
            Ctrl+F and Ctrl+H route to the same panel. */}
        <G>
          <ToolbarButton
            active={!!findReplaceOpen}
            onClick={onToggleFindReplace}
            title="Find and replace (Ctrl+Shift+H)"
            data-help-region="editor-panel:find_replace"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3.5" />
              <line x1="8.7" y1="8.7" x2="12.5" y2="12.5" />
            </svg>
          </ToolbarButton>
        </G>
      </div>
    </div>
  )
}

// ── Editor footer ───────────────────────────────────────────────────────────
// Footer bar across the bottom of the editor panel. Holds the word /
// character count (left) and the Phase 2.9a item 10 read-aid zoom
// controls (right): slider snapping to 10% increments + percent
// label + reset-to-default button.

const ZOOM_MIN = 50
const ZOOM_MAX = 200
const ZOOM_STEP = 10

function EditorFooter({ editor, zoom, defaultZoom, onZoomChange }) {
  if (!editor) return null
  const chars = editor.storage.characterCount.characters()
  const words = editor.storage.characterCount.words()
  const showReset = zoom !== defaultZoom
  return (
    <div
      data-help-region="editor-panel:footer"
      className="flex items-center gap-3 px-3 py-1 border-t border-zinc-700 bg-zinc-900/60 flex-shrink-0 text-[10px] text-zinc-500"
    >
      <span data-help-region="editor-panel:word_count">{words.toLocaleString()} {words === 1 ? 'word' : 'words'}</span>
      <span data-help-region="editor-panel:character_count">{chars.toLocaleString()} {chars === 1 ? 'character' : 'characters'}</span>
      <div className="ml-auto flex items-center gap-2">
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom}
          onChange={(e) => onZoomChange && onZoomChange(Number(e.target.value))}
          className="nn-editor-zoom-slider"
          name="editor-zoom"
          data-help-region="editor-panel:zoom_slider"
          aria-label="Editor zoom"
          title={`Editor zoom — ${zoom}% (drag to adjust between ${ZOOM_MIN}-${ZOOM_MAX}% in ${ZOOM_STEP}% steps)`}
        />
        <span className="tabular-nums" style={{ minWidth: 32, textAlign: 'right' }}>{zoom}%</span>
        <button
          type="button"
          onClick={() => onZoomChange && onZoomChange(defaultZoom)}
          disabled={!showReset}
          data-help-region="editor-panel:zoom_reset"
          title={showReset
            ? `Reset to default (${defaultZoom}%)`
            : `Already at the default (${defaultZoom}%)`}
          className={`leading-none rounded transition-colors text-[10px] px-1 py-0.5 ${
            showReset
              ? 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
              : 'text-zinc-700 cursor-not-allowed'
          }`}
          aria-label="Reset editor zoom"
        >
          ↺
        </button>
      </div>
    </div>
  )
}

// ── Entity hover preview (floating, appears above the hovered entity name) ──

// EntityHoverPreview extracted to its own module so the chat-bubble
// highlight pass (Phase 2.8a) can share the same popover.

// ── Rich Text Editor ────────────────────────────────────────────────────────

export default function RichTextEditor({
  content,
  onUpdate,
  placeholder = 'Start writing…',
  entityHighlight = false,
  entityHighlightEnabled = false,
  onToggleEntityHighlight,
  nameTargets = [],
  onEntityClick,
  outputJson = false,
  // When true, the editor is rendered in read-only mode: TipTap's
  // `editable: false` blocks typing, the formatting toolbar is
  // hidden so its buttons can't programmatically mutate the doc,
  // and the user can still scroll, select text, and use Find &
  // Replace navigation. Used by the MCP session edit-lockout
  // (Phase 2.1 Phase C) so the user can READ what the AI is
  // writing into a scene's main content without being able to
  // change it themselves.
  readOnly = false,
}) {
  // Story accent — used as the visual cue for AMBIGUOUS name
  // highlights (typed name matches more than one distinct object).
  // Threaded through `refreshEntityHighlights` so the
  // `EntityHighlightExtension`'s decoration code can pick it up.
  const editorAccentColor = useAccentColor()

  // Light/dark mode toggle for the editor text area (not persisted)
  const [lightMode, setLightMode] = useState(false)

  // Phase 1.24c — Find & Replace panel open state. Panel-local
  // (per planning §5.4). One panel covers both find-only and
  // find-with-replace use cases via separate buttons inside it.
  // Both Ctrl+F and Ctrl+H route to the same panel.
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const toggleFindReplace = useCallback(() => setFindReplaceOpen((v) => !v), [])
  const closeFindReplace = useCallback(() => setFindReplaceOpen(false), [])

  // Per-type filter for name highlighting. All on by default; the
  // writer narrows the set via the flyout's per-type checkboxes.
  // Covers the full range of kinds the new `<NameDetectToggle>`
  // exposes (cue / 5 entity subtypes / knowledge / relationship) so
  // the editor's flyout offers the same checkboxes the chat
  // composer's does. The `typeFilterMenu` state slot is gone — the
  // new toggle manages its own flyout open/position internally.
  //
  // The name `enabledEntityTypes` is mildly historical: it used to
  // only track entity subtypes (Phase 1.21+ scene-editor highlight
  // feature). Kept the field name for diff minimisation; consumers
  // treat it as a generic kind→bool map.
  // Lifted to uiStore in v0.2.9.39 so the PBH prompt textarea (now a
  // TipTap-based `ChatComposerTipTapInput`) can share the same per-
  // type filter as the editor's toolbar toggle + EntityHighlightExtension.
  // localStorage-persisted via `nn_editorHighlightTypes`.
  const enabledEntityTypes = useUiStore((s) => s.editorHighlightTypes)
  const setEditorHighlightType = useUiStore((s) => s.setEditorHighlightType)
  const toggleEntityType = useCallback((type) => {
    setEditorHighlightType(type, !enabledEntityTypes[type])
  }, [enabledEntityTypes, setEditorHighlightType])

  // Filter name targets by enabled entity types
  const filteredNameTargets = useMemo(() => nameTargets.filter((t) => enabledEntityTypes[t.entityType]), [nameTargets, enabledEntityTypes])

  // Track whether the content prop changed externally (e.g. switching nodes)
  const lastExternalContent = useRef(content)
  const editorContainerRef = useRef(null)

  // Hover state for entity name preview
  const [hoverTarget, setHoverTarget] = useState(null)
  const [hoverRect, setHoverRect] = useState(null)

  // Phase 2.9a item 3 — Section / Inline Prompt Block creation chooser.
  // `chooserPosition` is `{ left, top }` (viewport coords) when open,
  // null when closed. Set by the toolbar button (anchored below its
  // rect) and the right-click context-menu handler (anchored at the
  // click point).
  const [chooserPosition, setChooserPosition] = useState(null)
  const closeChooser = useCallback(() => setChooserPosition(null), [])

  // Phase 2.9c item 2 — Inline Prompt Block contextual toolbar
  // button. Three-state read of the IPB store + per-form streaming.
  // (The actual hooks + handlers are declared AFTER the `useEditor`
  // call below so the `editor` reference inside the position-cascade
  // callback is defined when this useCallback evaluates — TDZ-safe.)
  const ipbActive = useIpbStore((s) => s.active)
  const ipbOpen = useIpbStore((s) => s.open)
  const ipbDismiss = useIpbStore((s) => s.dismiss)
  const ipbIsStreaming = useSectionPromptBlocksStore(
    (s) => !!s.blocks[IPB_FORM_KEY]?.isStreaming,
  )
  const editorSurface = useEditorSurface()

  // Phase 2.9a item 10 — editor read-aid zoom. Session-only — every
  // editor mount starts at the writer's persisted default (Program
  // Settings → "Default editor zoom level", saved to
  // user_preferences.json as `editor_default_zoom_level`; null →
  // built-in 100%). The footer's slider mutates `editorZoom`; the
  // CSS variable `--nn-editor-zoom` applied to the editor container
  // propagates the scale to prose-node selectors only (chrome
  // elements with explicit rem / px font-sizes don't pick it up).
  const persistedDefaultZoom = useSettingsStore(
    (s) => s.preferences?.editor_default_zoom_level ?? 100,
  )
  const [editorZoom, setEditorZoom] = useState(persistedDefaultZoom)

  const editor = useEditor({
    // Read-only mode for the MCP session edit-lockout. TipTap blocks
    // typing + IME when `editable: false`. The toolbar is also
    // hidden below to prevent the toolbar's button-driven commands
    // (`editor.chain().focus().toggleBold().run()` etc.) from
    // mutating the doc programmatically — TipTap's `editable`
    // flag only blocks USER input, not API calls.
    editable: !readOnly,
    extensions: [
      // StarterKit v3 bundles both Underline + Link. Disable both inside
      // StarterKit v3 bundles Underline + Link. Link is fully disabled
      // here (the toolbar link button was removed for being too
      // inconsistent to ship); Underline is disabled inside StarterKit
      // so the explicit Underline import below is the single registered
      // copy.
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      FontSize,
      FontFamily,
      Color,
      CharacterCount,
      EntityHighlightExtension,
      FindMatchHighlightExtension,
      SectionExtension,
      IpbAnchorDecorationExtension,
      PromptBlockAutoAttachExtension,
    ],
    content: (() => {
      if (!content) return ''
      if (outputJson && typeof content === 'string' && content.startsWith('{')) {
        try { return JSON.parse(content) } catch { return content }
      }
      return content
    })(),
    editorProps: {
      attributes: {
        class: 'nn-tiptap-content outline-none min-h-full px-3 py-2',
        'data-placeholder': placeholder,
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Tab') return false
        // Check if cursor is inside a list item — if so, let TipTap handle indent/outdent
        const { $from } = view.state.selection
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'listItem') return false
        }
        // Not in a list — capture Tab and insert a tab character
        event.preventDefault()
        if (!event.shiftKey) {
          view.dispatch(view.state.tr.insertText('\t'))
        }
        return true
      },
    },
    onUpdate: ({ editor: ed }) => {
      const output = outputJson ? JSON.stringify(ed.getJSON()) : ed.getHTML()
      lastExternalContent.current = output
      // `onUpdate` is optional — read-only callers (e.g. the
      // text-attachment viewer in `RightSidebar`) intentionally
      // pass `undefined` because there's nothing to persist back.
      // TipTap still fires this event for in-editor side-effects
      // like FindReplace highlight refreshes, so we have to guard
      // the call rather than blocking the event.
      if (typeof onUpdate === 'function') onUpdate(output)
    },
  })

  // Phase 2.9c item 2 — IPB position cascade + toolbar click handler.
  // Declared AFTER `useEditor` above so the `editor` reference is
  // initialised when these closures evaluate (TDZ-safe).
  const computeIpbInitialPosition = useCallback(() => {
    if (editor) {
      try {
        const head = editor.state?.selection?.head
        if (typeof head === 'number') {
          const coords = editor.view.coordsAtPos(head)
          if (coords && typeof coords.left === 'number') {
            return { left: coords.left, top: coords.bottom + 6 }
          }
        }
      } catch { /* fall through to viewport rule */ }
    }
    const rect = editorContainerRef.current?.getBoundingClientRect()
    if (rect) return { left: rect.left + 24, top: rect.top + 24 }
    return { left: 100, top: 100 }
  }, [editor])

  const handleIpbToolbarClick = useCallback(() => {
    if (ipbIsStreaming) {
      // Phase 2.9c item 4 — third toolbar state: cancel the IPB's
      // in-flight stream. Reads the abortController stowed on the
      // IPB's per-form state in sectionPromptBlocksStore (the same
      // place the in-form Stop button + Esc shortcut read from).
      // The IPB returns to idle after cancel — chrome stays mounted
      // per planning doc §4.10 (cancel → idle, not cancel → dismiss).
      try {
        const ctl = useSectionPromptBlocksStore.getState().blocks[IPB_FORM_KEY]?.abortController
        if (ctl) ctl.abort()
      } catch { /* ignore */ }
      return
    }
    if (ipbActive) {
      ipbDismiss()
      setIpbEditor(null)
      return
    }
    // Capture the IPB's initial anchor from the editor's current
    // selection — non-empty selection becomes a section-mode range
    // anchor; just a caret becomes a cursor-mode anchor (planning
    // doc §4.10 + §4.11). Full Ctrl+click / Ctrl+drag retarget lands
    // with item 3.
    let initialAnchor = null
    if (editor && editor.state) {
      const sel = editor.state.selection
      if (sel && typeof sel.head === 'number') {
        if (typeof sel.from === 'number' && typeof sel.to === 'number' && sel.from !== sel.to) {
          initialAnchor = { kind: 'range', from: sel.from, to: sel.to }
        } else {
          initialAnchor = { kind: 'cursor', pos: sel.head }
        }
      }
    }
    // Position the chrome via the shared placement rules
    // (cursor-mode below, range-mode above, flip if it'd go off the
    // bottom, clamp if it'd go off the side). Falls back to the
    // viewport-top cascade if we can't resolve the anchor's coords.
    const chromePos =
      (editor && initialAnchor && computeIpbChromePos(editor.view, initialAnchor))
      || computeIpbInitialPosition()
    ipbOpen({
      chromePos,
      surface_type: editorSurface?.surface_type || null,
      surface_host_id: editorSurface?.surface_host_id || null,
      anchor: initialAnchor,
    })
    // Register this RichTextEditor's TipTap instance as the IPB's
    // scoped editor — the InlinePromptBlock mounts at the App level
    // (so its portal target survives editor remounts) and therefore
    // can't reach the editor through React props / context. The
    // module-level ref in ipbStore.js is the bridge: Send / cancel
    // paths in InlinePromptBlock read this via `getIpbEditor()` to
    // dispatch transactions against the right editor. Cleared on
    // dismiss (above) + on RichTextEditor unmount (effect below).
    setIpbEditor(editor)
  }, [ipbIsStreaming, ipbActive, ipbDismiss, ipbOpen, computeIpbInitialPosition, editorSurface, editor])

  // Clear the IPB editor ref when THIS RichTextEditor unmounts so a
  // stale handle doesn't outlive its TipTap view. If the IPB was
  // active against this editor when unmounting (e.g. writer switched
  // surfaces mid-IPB-session), also dismiss the IPB — its anchor
  // refers to the unmounting editor's doc and has no meaning against
  // whatever editor replaces it.
  useEffect(() => {
    return () => {
      if (useIpbStore.getState().active) {
        try { ipbDismiss() } catch { /* ignore */ }
      }
      setIpbEditor(null)
    }
  }, [ipbDismiss])

  // Sync editor content when the external content changes (e.g. switching to a different node)
  useEffect(() => {
    if (!editor) return
    if (content !== lastExternalContent.current) {
      lastExternalContent.current = content
      // Parse JSON content if outputJson mode (TipTap JSON stored as string)
      let parsed = content || ''
      if (outputJson && typeof parsed === 'string' && parsed.startsWith('{')) {
        try { parsed = JSON.parse(parsed) } catch { /* use as-is */ }
      }
      editor.commands.setContent(parsed)
    }
  }, [content, editor, outputJson])

  // Sync entity highlight state — pass filtered targets, enabled
  // flag, and the story accent (used as the ambiguous-match
  // visual) via transaction metadata.
  useEffect(() => {
    if (!editor) return
    refreshEntityHighlights(editor, filteredNameTargets, entityHighlightEnabled, editorAccentColor)
  }, [editor, filteredNameTargets, entityHighlightEnabled, editorAccentColor])

  // Handle hover and click on highlighted entity names
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    function handleMouseOver(e) {
      const el = e.target.closest('.nn-entity-highlight')
      if (el) {
        setHoverTarget(el)
        setHoverRect(el.getBoundingClientRect())
      }
    }

    function handleMouseOut(e) {
      const el = e.target.closest('.nn-entity-highlight')
      if (!el) {
        setHoverTarget(null)
        setHoverRect(null)
      }
    }

    function handleClick(e) {
      const el = e.target.closest('.nn-entity-highlight')
      if (el && onEntityClick) {
        e.preventDefault()
        e.stopPropagation()
        const entityId = el.dataset.entityId
        if (entityId) onEntityClick(entityId)
      }
    }

    container.addEventListener('mouseover', handleMouseOver)
    container.addEventListener('mouseout', handleMouseOut)
    container.addEventListener('click', handleClick, true)

    return () => {
      container.removeEventListener('mouseover', handleMouseOver)
      container.removeEventListener('mouseout', handleMouseOut)
      container.removeEventListener('click', handleClick, true)
    }
  }, [onEntityClick])

  // Phase 1.24c / 6.2 — Ctrl+Shift+H toggles the find/replace panel whenever
  // the editor sidebar is open, regardless of focus location. Plain Ctrl+H is
  // reserved for the global help mode (Phase 6.2), so Find/Replace moved to
  // Ctrl+Shift+H; the toolbar button is the discoverable affordance.
  //
  // Listener is attached to window in CAPTURE phase so we can call
  // preventDefault BEFORE the browser dispatches its built-in shortcut. The
  // component only mounts while the right-sidebar editor is open, so the
  // binding implicitly scopes to that surface — no focus check needed.
  const editorRootRef = useRef(null)
  useEffect(() => {
    function handler(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) return
      if (e.key.toLowerCase() !== 'h') return
      e.preventDefault()
      e.stopPropagation()
      setFindReplaceOpen((v) => !v)
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [])

  return (
    <div ref={editorRootRef} className="flex flex-col flex-1 min-h-0">
      {/* Toolbar is hidden in readOnly mode — its commands operate
          via direct TipTap API calls which would mutate the doc
          even with `editable: false`, defeating the read-only
          contract. Find & Replace would also be useful in read-only
          mode, but it's bundled into the same toolbar; deferred to
          a follow-up split if a user asks. */}
      {!readOnly && (
        <EditorToolbar
          editor={editor}
          entityHighlight={entityHighlight}
          entityHighlightEnabled={entityHighlightEnabled}
          onToggleEntityHighlight={onToggleEntityHighlight}
          lightMode={lightMode}
          onToggleLightMode={() => setLightMode((v) => !v)}
          enabledEntityTypes={enabledEntityTypes}
          onToggleEntityType={toggleEntityType}
          findReplaceOpen={findReplaceOpen}
          onToggleFindReplace={toggleFindReplace}
          ipbActive={ipbActive}
          ipbIsStreaming={ipbIsStreaming}
          onIpbToolbarClick={handleIpbToolbarClick}
        />
      )}
      <FindReplacePanel open={findReplaceOpen} onClose={closeFindReplace} editor={editor} />
      <div
        ref={editorContainerRef}
        data-help-region="editor-panel:content"
        className={`flex-1 overflow-y-auto min-h-0 ${lightMode ? 'nn-tiptap-light' : ''}`}
        style={{ '--nn-editor-zoom': editorZoom / 100 }}
        onContextMenu={(e) => {
          // Phase 2.9a item 3 + Phase 2.9b polish — right-click context
          // menu entry point. Opens the editor's combined menu: Cut /
          // Copy / Paste (mouse-first writers still need clipboard
          // access since we suppress the browser default below) + the
          // Section / Inline Prompt Block creation rows. Skip in read-
          // only mode (MCP session edit-lockout): no writes allowed,
          // let the browser default through so the writer can still
          // use Inspect / Copy from there. Also skip if the click
          // landed on existing Section chrome (name bar, Prompt Block
          // Header placeholder, action toolbar) — those rows have
          // their own intent and shouldn't open this menu.
          //
          // Spell-check escape hatch (writer spec 2026-05-27):
          // Shift+RightClick bypasses our custom menu entirely so the
          // browser's native context menu (with spell-check suggestions
          // for misspelled words) appears instead. No browser JS API
          // exposes the spell checker's suggestions, and bundling a
          // dictionary would lose multi-language support; the Shift
          // modifier is the convention used by Slack / Notion / Google
          // Docs for the same reason — preserve our right-click entry
          // point while giving writers a one-key path to native spell
          // suggestions.
          if (readOnly) return
          if (e.shiftKey) return
          if (e.target.closest('.nn-section-namebar, .nn-section-pbh-placeholder, .nn-section-toolbar')) return
          e.preventDefault()
          setChooserPosition({ left: e.clientX, top: e.clientY, fromContextMenu: true })
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <EditorFooter
        editor={editor}
        zoom={editorZoom}
        defaultZoom={persistedDefaultZoom}
        onZoomChange={setEditorZoom}
      />
      <EntityHoverPreview target={hoverTarget} rect={hoverRect} />
      {chooserPosition && (
        <SectionCreationChooser
          editor={editor}
          position={chooserPosition}
          onClose={closeChooser}
          showClipboardActions={!!chooserPosition.fromContextMenu}
          readOnly={readOnly}
        />
      )}
    </div>
  )
}
