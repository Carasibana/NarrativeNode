/**
 * Phase 2.8 — Name-detection toggle button family.
 *
 * Two surfaces share this button design:
 *   - Chat composer (this file's default export, `AutoAttachToggle`)
 *     — when ON, names of selected types are detected in the chat
 *     input, inline-coloured AND auto-attached as pinned context
 *     pills above. Adds an "always highlight regardless of auto-
 *     attach" subtoggle in its popover.
 *   - Scene editor "Names" button (future consumer) — when ON,
 *     names of selected types are inline-coloured in the editor's
 *     text. No auto-attach behaviour; no subtoggle needed.
 *
 * The base component `NameDetectToggle` is surface-agnostic: it
 * renders the split button (icon + chevron, matching the rich-text
 * editor's existing Names button shape) and the popover; consumers
 * wire their own state via props. The icon is design #18a from the
 * UI Ideation dev panel — tag-chip silhouette with a smooth conic
 * gradient walking around the stroke band when ON.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../store/uiStore'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { RelationshipIcon, CueIcon, KnowledgeIcon } from '../ui/IdentityBadges'


// Vivid type-colour palette for the icon's rainbow border.
const VIVID = { ent: '#f97316', cue: '#10b981', know: '#f59e0b', rel: '#8b5cf6' }


// Default rows for the per-type checkbox list. Order + icons match
// the Entity Library tab strip's left-to-right sequence exactly:
// Character → Location → Item → Faction → Custom → Knowledge →
// Relationship → Context Cues. (Preset Lists + References tabs in
// the library aren't detection targets, so they're omitted here.)
// A writer scanning the flyout sees the same kinds in the same
// order as the library tabs they navigate every day.
const DEFAULT_TYPE_ROWS = [
  { kind: 'character',    label: 'Characters'    },
  { kind: 'location',     label: 'Locations'     },
  { kind: 'item',         label: 'Items'         },
  { kind: 'faction',      label: 'Factions'      },
  { kind: 'custom',       label: 'Custom'        },
  { kind: 'knowledge',    label: 'Knowledge'     },
  { kind: 'relationship', label: 'Relationships' },
  { kind: 'cue',          label: 'Context Cues'  },
]


/**
 * Renders the small leading icon beside each checkbox in the
 * flyout. Picks the matching library-tab icon per kind:
 *   - cue → 🧩 (CueIcon — bare puzzle emoji)
 *   - knowledge → 📜 (KnowledgeIcon — emoji on tinted frame)
 *   - relationship → circled two-way arrow SVG (RelationshipIcon)
 *   - entity subtypes → TYPE_ICONS emoji (👤 / 📍 / 🎒 / 🚩 / 🔧)
 *
 * Wrapped in a fixed-width span so the checkbox + label columns
 * stay aligned across rows whose icons render at different glyph
 * widths.
 */
function TypeIconForFlyout({ kind }) {
  let inner
  if (kind === 'relationship') inner = <RelationshipIcon size={13} />
  else if (kind === 'cue')     inner = <CueIcon size={13} />
  // Knowledge uses the bare 📜 emoji like cue does — `KnowledgeIcon`
  // wraps the emoji in a parchment-tinted square frame which looks
  // out of place here next to the unframed cue / entity emoji.
  else if (kind === 'knowledge') inner = <span className="text-[12px] leading-none">📜</span>
  else inner = <span className="text-[12px] leading-none">{TYPE_ICONS[kind] || '?'}</span>
  return (
    <span className="w-4 h-4 inline-flex items-center justify-center flex-shrink-0" aria-hidden="true">
      {inner}
    </span>
  )
}


/**
 * The auto-attach icon — tag-chip silhouette with a hole-punch on
 * the left. When `on === false`: mono outline (uses `currentColor`).
 * When `on === true`: stroke band is a smooth CSS conic-gradient
 * painted via `<foreignObject>` + SVG `<mask>`, interior tinted with
 * the supplied `accent` colour at low alpha.
 *
 * `maskId` is required because the SVG `<mask>` must have a unique
 * id when multiple instances render simultaneously.
 */
// Capital "A" framed inside a square targeting reticle with four
// short tick marks at the cardinal edges. Reads as "auto-detect a
// name". Chosen from the dev-panel UI Ideation candidates
// (Feature C #22, Agent 2) for the PBH's per-Section auto-attach
// toggle, then promoted to the chat composer's standalone
// auto-attach button so both surfaces share one visual for the
// same concept. Distinct from:
//   - the chat composer's existing `AutoAttachIcon` (tag-chip +
//     rainbow conic stroke) — that's the "highlight detected
//     names" button's icon, which is a different feature (visual
//     highlighting, not auto-attach as context).
//   - paperclip (chat file attach), bold plus (AddContext popover
//     trigger), magnet + sparkle (chat-side rejected candidate).
//
// Stroke colour inherits from the parent button's chrome
// (`currentColor`), so the icon picks up accent tint when the
// master toggle is ON. ON state adds a subtle accent-tinted fill
// behind the reticle frame to communicate "engaged" without
// changing the silhouette.
export function AutoAttachReticleIcon({ on, size = 12 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Reticle frame + four tick marks at the cardinal edges +
          capital A inside. Geometry matches candidate #22 from the
          dev panel UI Ideation page exactly — the overall icon size
          is grown by passing `iconSize={14}` from the consumer (vs
          the chat highlight button's default 12), not by stretching
          this viewBox content. */}
      <rect x="5" y="5" width="14" height="14" rx="1.5" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.18 : 0} />
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="M9 16l3-8 3 8" />
      <path d="M10.2 13.5h3.6" />
    </svg>
  )
}

export function AutoAttachIcon({ on, size = 16, accent = '#a78bfa', maskId }) {
  if (!on) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
        <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
        <circle cx="7" cy="12" r="1.4" strokeWidth="1.3" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="black" />
          <path d="M3 4 h11 l6 8 l-6 8 H3 z" fill="none" stroke="white" strokeWidth="2.6" strokeLinejoin="round" />
          <circle cx="7" cy="12" r="1.4" fill="none" stroke="white" strokeWidth="1.5" />
        </mask>
      </defs>
      <path
        d="M3 4 h11 l6 8 l-6 8 H3 z M7 12 m-1.4 0 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"
        fill={accent}
        fillOpacity="0.22"
        fillRule="evenodd"
        stroke="none"
      />
      <foreignObject x="0" y="0" width="24" height="24" mask={`url(#${maskId})`}>
        <div xmlns="http://www.w3.org/1999/xhtml" style={{
          width: '100%', height: '100%',
          background: `conic-gradient(from 225deg, ${VIVID.ent}, ${VIVID.cue}, ${VIVID.know}, ${VIVID.rel}, ${VIVID.ent})`,
        }} />
      </foreignObject>
    </svg>
  )
}


/**
 * Reusable popover for the per-type checkboxes + optional always-
 * highlight subtoggle. Surface-agnostic; the host wires the state.
 *
 *  - `selectedTypes`: { [kind]: boolean }
 *  - `onToggleType(kind, nextBool)`: called when a checkbox flips
 *  - `alwaysHighlight` / `onSetAlwaysHighlight`: when BOTH supplied,
 *    the subtoggle row renders below the type list; when either is
 *    null/undefined, the subtoggle row is hidden (editor surface
 *    consumers omit it).
 *  - `heading`: small uppercase row at the top of the popover.
 *  - `typeRows`: optional override of `DEFAULT_TYPE_ROWS`.
 */
function NameDetectFlyout({
  anchorRef,
  onClose,
  selectedTypes,
  onToggleType,
  subtoggleValue,
  onSetSubtoggle,
  subtoggleLabel,
  subtoggleDisabled,
  subtoggleDisabledHint,
  heading = 'Detect names of',
  typeRows = DEFAULT_TYPE_ROWS,
  direction = 'down',
}) {
  const ref = useRef(null)
  // Initial render is hidden via `visibility: 'hidden'` — useLayoutEffect
  // measures the popover after mount and positions it before paint,
  // so the user never sees an unpositioned flash. After the first
  // measure, `ready` flips to true and the popover becomes visible.
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [ready, setReady] = useState(false)
  const showSubtoggle = subtoggleValue !== undefined && typeof onSetSubtoggle === 'function'

  useLayoutEffect(() => {
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const popoverRect = ref.current?.getBoundingClientRect()
    if (!anchorRect || !popoverRect) return
    const POPOVER_W = 220
    const left = Math.max(8, Math.min(anchorRect.right - POPOVER_W, window.innerWidth - POPOVER_W - 8))
    // `direction === 'up'` anchors the popover's BOTTOM edge at the
    // button's TOP edge minus a 4px gap. Used by the chat composer
    // where the button is near the bottom of the panel and a down-
    // opening popover would clip past the input. `direction === 'down'`
    // (default) anchors the popover's TOP edge at the button's BOTTOM
    // edge plus a 4px gap — the rich-text editor toolbar's idiom.
    const top = direction === 'up'
      ? anchorRect.top - popoverRect.height - 4
      : anchorRect.bottom + 4
    setPos({ top, left })
    setReady(true)
  }, [anchorRef, direction])

  useEffect(() => {
    function onDown(e) {
      if (ref.current?.contains(e.target)) return
      if (anchorRef.current?.contains(e.target)) return
      onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 60,
        width: 220,
        visibility: ready ? 'visible' : 'hidden',
      }}
      className="bg-zinc-900 border border-zinc-700 rounded shadow-xl"
    >
      <div className="px-2 py-1.5 border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
        {heading}
      </div>
      <div className="py-1">
        {typeRows.map((row) => (
          <label
            key={row.kind}
            className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800/60 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={!!selectedTypes?.[row.kind]}
              onChange={(e) => onToggleType(row.kind, e.target.checked)}
              className="accent-accent-500"
            />
            <TypeIconForFlyout kind={row.kind} />
            <span className="flex-1">{row.label}</span>
          </label>
        ))}
      </div>
      {showSubtoggle && (
        <div className={`border-t border-zinc-800 px-2 py-1.5 ${subtoggleDisabled ? 'opacity-50' : ''}`}>
          <label className={`flex items-center gap-2 text-[11px] text-zinc-200 ${subtoggleDisabled ? 'cursor-not-allowed' : 'hover:text-zinc-50 cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={!!subtoggleValue}
              disabled={!!subtoggleDisabled}
              onChange={(e) => onSetSubtoggle(e.target.checked)}
              className="accent-accent-500"
            />
            <span className="flex-1 leading-snug">
              {subtoggleLabel}
              {subtoggleDisabled && subtoggleDisabledHint && (
                <> <span className="text-zinc-500">{subtoggleDisabledHint}</span></>
              )}
            </span>
          </label>
        </div>
      )}
    </div>,
    document.body,
  )
}


/**
 * Reusable split-button + flyout. Left half = master toggle (click =
 * flip `enabled`). Right half = ▾ chevron that opens the popover.
 * Surface-agnostic — every piece of state and every label is a prop.
 */
export function NameDetectToggle({
  enabled,
  onToggle,
  selectedTypes,
  onToggleType,
  // Optional subtoggle in the flyout. Both `subtoggleValue` and
  // `onSetSubtoggle` must be supplied to render the row. Used by
  // the chat consumer to add an "also auto-attach" checkbox; the
  // future editor consumer omits these props and the row hides.
  subtoggleValue,
  onSetSubtoggle,
  subtoggleLabel,
  subtoggleDisabled,
  subtoggleDisabledHint,
  toggleTooltipOn = 'Name detection: ON. Click to disable; click ▾ to pick kinds.',
  toggleTooltipOff = 'Name detection: OFF. Click to enable; click ▾ to pick kinds.',
  flyoutHeading,
  typeRows,
  // `flyoutDirection` controls which way the flyout opens relative
  // to the button. Chat composer passes `'up'` (button sits near
  // the bottom of the panel); the editor toolbar consumer uses
  // the default `'down'` (button sits near the top of the panel).
  flyoutDirection = 'down',
  // Optional icon override. When omitted the default `AutoAttachIcon`
  // (tag-chip silhouette with rainbow conic-gradient stroke) is used
  // — that visual is associated with the chat-side "highlight detected
  // names" feature, which is FULL-EDITOR-WIDE (not per-Section). The
  // PBH's auto-attach toggle is per-Section, so it passes a distinct
  // icon to avoid confusing the writer about scope. `renderIcon` is
  // called with `({ on, size })` so the consumer can style its glyph
  // based on the master toggle's state.
  renderIcon,
  // Pixel size passed to the icon (default 12). The auto-attach
  // button bumps this to 14 so the reticle + A composition reads
  // clearly at toolbar size — the chat-side highlight button keeps
  // the default since its tag-chip glyph is simpler at small sizes.
  iconSize = 12,
  // Optional help-region tag applied to the toggle's root wrapper.
  // Behaviour-neutral passthrough so the help-system live layer can
  // resolve the chat composer's two consumers; editor-surface
  // consumers omit it and the attribute simply doesn't render.
  dataHelpRegion,
}) {
  const wrapperRef = useRef(null)
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const maskId = `nameDetectIconMask-${useStableId()}`

  // Match the chat composer's other toolbar buttons (AddContextButton,
  // PaperclipButton, SceneContextButton, etc.) which all use a
  // bordered chrome: `border border-zinc-700 bg-zinc-900/30` for the
  // inactive state, accent-tinted bg + border for active. The toggle
  // is also usable in the rich-text editor toolbar (future
  // consumer); that surface uses a borderless toolbar style, but
  // since the chat is the first live surface and a bordered button
  // doesn't look out of place in the editor toolbar either, we go
  // with bordered as the unified shape.
  // Backgrounds are applied per-button (not on the wrapper) so the
  // active state can use a darker, more transparent backdrop on the
  // ICON half (`bg-accent-900/40` — matches the dev panel preview
  // and lets the icon's rainbow conic stroke pop) while the
  // chevron half keeps the solid accent fill (`bg-accent-700/80`).
  // A wrapper-level bg would either wash out the icon (if solid)
  // or fail to give the chevron its distinct fill.
  return (
    <span
      ref={wrapperRef}
      data-help-region={dataHelpRegion}
      className={`relative inline-flex items-stretch h-5 rounded border transition-colors ${
        enabled
          ? 'border-accent-600 text-white'
          : 'border-zinc-700 text-zinc-300 hover:text-zinc-100'
      }`}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggle(!enabled)}
        title={enabled ? toggleTooltipOn : toggleTooltipOff}
        className={`px-1 rounded-l text-inherit inline-flex items-center transition-colors ${
          enabled
            ? 'bg-accent-900/40 hover:bg-accent-900/60'
            : 'bg-zinc-900/30 hover:bg-zinc-800/60'
        }`}
      >
        {renderIcon
          ? renderIcon({ on: enabled, size: iconSize })
          : <AutoAttachIcon on={enabled} size={iconSize} accent="currentColor" maskId={maskId} />}
      </button>
      <button
        type="button"
        onClick={() => setFlyoutOpen((v) => !v)}
        title="Pick which kinds of names to detect"
        className={`px-0.5 text-[9px] rounded-r border-l flex items-center text-inherit transition-colors ${
          enabled
            ? 'border-accent-600 bg-accent-700/80 hover:bg-accent-600'
            : 'border-zinc-700 bg-zinc-900/30 hover:bg-zinc-800/60'
        }`}
      >
        ▾
      </button>
      {flyoutOpen && (
        <NameDetectFlyout
          anchorRef={wrapperRef}
          onClose={() => setFlyoutOpen(false)}
          selectedTypes={selectedTypes}
          onToggleType={onToggleType}
          subtoggleValue={subtoggleValue}
          onSetSubtoggle={onSetSubtoggle}
          subtoggleLabel={subtoggleLabel}
          subtoggleDisabled={subtoggleDisabled}
          subtoggleDisabledHint={subtoggleDisabledHint}
          heading={flyoutHeading}
          typeRows={typeRows}
          direction={flyoutDirection}
        />
      )}
    </span>
  )
}


/**
 * Chat-composer consumer. Wires the chat-specific uiStore state to
 * the reusable `NameDetectToggle`. Includes the always-highlight
 * subtoggle in the popover (chat-specific — the editor's consumer
 * will omit those props).
 */
export default function AutoAttachToggle() {
  // Master toggle = name HIGHLIGHTING (visual in chat input). Auto-
  // attach behaviour was originally a subtoggle inside this flyout
  // but moved to a standalone button (`ChatAutoAttachStandaloneButton`
  // in v0.2.9.38) so the writer can toggle each independently.
  const enabled = useUiStore((s) => s.chatHighlightNamesEnabled)
  const setEnabled = useUiStore((s) => s.setChatHighlightNamesEnabled)
  const types = useUiStore((s) => s.chatAutoAttachTypes)
  const setType = useUiStore((s) => s.setChatAutoAttachType)

  return (
    <NameDetectToggle
      enabled={enabled}
      onToggle={setEnabled}
      selectedTypes={types}
      onToggleType={setType}
      // Subtoggle removed in v0.2.9.38 — auto-attach now has its own
      // standalone toolbar button (`ChatAutoAttachStandaloneButton`)
      // with its own chevron flyout. Keeping a second control inside
      // this flyout would have driven the same state from two places
      // for no UX benefit.
      toggleTooltipOn="Highlight detected names in colour: ON. Click to disable; click ▾ to pick kinds."
      toggleTooltipOff="Highlight detected names in colour: OFF. Click to enable; click ▾ to pick kinds."
      flyoutHeading="Detect names of"
      flyoutDirection="up"
      dataHelpRegion="conversation:composer_highlight_names"
    />
  )
}


/**
 * Chat composer's STANDALONE auto-attach button. Drives the same
 * `chatAutoAttachEnabled` state as the "Also auto-attach detected
 * names as context" subtoggle inside the highlight-names flyout,
 * but surfaced as its own toolbar button (writer doesn't have to
 * navigate into the highlight button's flyout to toggle auto-attach).
 *
 * Independent of the highlight master toggle — auto-attach fires
 * whenever this button is ON, regardless of whether highlighting is
 * on. (The scanner's `useEffect` gate was reduced to
 * `chatAutoAttachEnabled` only.)
 *
 * Has its OWN chevron + flyout that opens the SAME per-type filter
 * the highlight button's flyout drives (`chatAutoAttachTypes`).
 * Editing kinds here also affects the highlight button's filter and
 * vice-versa — one shared "which kinds count as names" setting,
 * two buttons that can each open it.
 *
 * Reuses the reticle-with-A icon promoted from the PBH so both
 * auto-attach surfaces share one visual for the same concept.
 */
export function ChatAutoAttachStandaloneButton() {
  const enabled = useUiStore((s) => s.chatAutoAttachEnabled)
  const setEnabled = useUiStore((s) => s.setChatAutoAttachEnabled)
  const types = useUiStore((s) => s.chatAutoAttachTypes)
  const setType = useUiStore((s) => s.setChatAutoAttachType)
  return (
    <NameDetectToggle
      enabled={enabled}
      onToggle={setEnabled}
      selectedTypes={types}
      onToggleType={setType}
      toggleTooltipOn="Auto-attach detected names: ON. Names you type in the chat input auto-pin as context. Click to disable; click ▾ to pick kinds."
      toggleTooltipOff="Auto-attach detected names: OFF. Click to enable; click ▾ to pick kinds."
      flyoutHeading="Auto-attach kinds"
      flyoutDirection="up"
      renderIcon={({ on, size }) => <AutoAttachReticleIcon on={on} size={size} />}
      iconSize={16}
      dataHelpRegion="conversation:composer_auto_attach"
    />
  )
}


// Stable per-instance id so the SVG `<mask>`'s id doesn't collide
// across multiple toggle instances on the same page (dev panel
// preview alongside the live composer + future editor instance).
let _idCounter = 0
function useStableId() {
  const ref = useRef(null)
  if (ref.current == null) {
    _idCounter += 1
    ref.current = `nd${_idCounter}`
  }
  return ref.current
}
