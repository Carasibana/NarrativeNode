/**
 * PromptBlockForm — shared form component for Prompt Blocks
 * (Phase 2.9c item 1).
 *
 * Renders the form chrome shared by both the Prompt Block Header
 * (PBH — lives inside every Section UI's persistent header row) and
 * the Inline Prompt Block (IPB — wrapped in floating chrome,
 * lands in item 2).
 *
 * Layout mirrors the chat composer (per planning doc §4.10 shared-
 * form architecture):
 *
 *   ┌─[ message textarea ]───────────┬─[ Send / Stop button ]─┐
 *   │                                │                         │
 *   └────────────────────────────────┴─────────────────────────┘
 *   ┌─[ icon-button toolbar row ]───────────────────────────────┐
 *   │ [Settings gear]  [Add Context]                            │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Three display states the wrapper switches between (planning
 * doc §4.10):
 *
 *   - Expanded — full form, dynamic width
 *   - Collapsed idle — small bar with the most-recently-fired
 *     prompt's title + expand control
 *   - Collapsed streaming — PBH variant: thin single-line summary
 *     with a status indicator inside the Section header row.
 *     IPB variant (item 2): inverted-teardrop / location-pin pill
 *     with the chat panel's spinning-coin animation.
 *
 * Per-block state lives in `sectionPromptBlocksStore` keyed by the
 * Section's stable id. Reopening a Section later re-reads from the
 * store; defaults to a blank form (session-only, never persisted).
 *
 * Send dispatch + Section History snapshots + streaming lockdown
 * are wired by the caller (SectionView) via the `onSend` /
 * `onCancel` callbacks. This component is the form chrome only.
 *
 * The Settings gear button + Add Context button mirror the chat
 * composer's `InputToolbarRow` visual (same 20x20 chrome, same
 * tooltip pattern). The chat composer's paperclip, favourites,
 * scene context, auto-attach, and reasoning buttons are
 * intentionally excluded — they're not relevant to a Prompt Block.
 *
 * The Settings popover is intentionally a small inline implementation
 * for v1; the cross-cutting volatile-copy editing item (Phase 2.9c
 * cross-cutting) will refactor `ChatSettingsPopover`'s model / system-
 * prompt picker rows into a shared component that both surfaces use.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { useSystemPromptsStore } from '../../store/systemPromptsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useIpbStore } from '../../store/ipbStore'
// Reuse the chat composer's add-context UI directly (Phase 2.9c
// item 7). All three components accept store-binding overrides
// (`pinned` / `onAdd` / `onClearAll` / `pinCount`) so the Prompt
// Block can drive them against its per-block `pinnedContextItems`
// list in `sectionPromptBlocksStore` instead of the chat-composer
// store's `chatPinnedContextItems`. `LIBRARY_DRAG_MIMES` is reused
// for the drop-handler in the next step.
import {
  AddContextButton,
  AddContextPickerPopover,
  PinnedContextChip,
  SceneContextButton,
  SceneContextPreviewModal,
  LIBRARY_DRAG_MIMES,
} from '../chat/ConversationView'
// PBH-only auto-attach toggle (Phase 2.9c — writer spec 2026-05-27).
// Reuses the chat composer's `NameDetectToggle` primitive directly.
// PBH wraps it WITHOUT the subtoggle (chat's "highlight + auto-attach"
// split doesn't apply — the editor's prose highlight is always-on via
// `EntityHighlightExtension`, so the master toggle here directly
// controls the auto-attach behaviour).
import { NameDetectToggle, AutoAttachReticleIcon } from '../chat/AutoAttachToggle'
import { useUiStore } from '../../store/uiStore'
// Name-detection scanner — shared with the chat composer + the
// PromptBlockAutoAttachExtension. The PRIMARY auto-attach scan
// (the form's prompt textarea) runs as a debounced useEffect
// below; the SECONDARY scan (Section prose for PBH, selected range
// for IPB section mode) is handled by the extension on editor
// transactions.
import { buildStoryWideNameTargets } from './EntityHighlightPlugin'
import SystemPromptPickerList from './SystemPromptPickerList'
import ConnectionModelPickerList from './ConnectionModelPickerList'
import PopoverSectionRow from './PopoverSectionRow'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { useEditorSurface } from './EditorSurfaceContext'
import ChatComposerTipTapInput from '../chat/ChatComposerTipTapInput'
import { useAccentColor } from '../../utils/povConstants'
import { NodeBadge } from './IdentityBadges'
import { applyPromptOnPick } from '../../utils/applyPromptOnPick'
import PinRow from './PinRow'
import { usePinnedContextStore } from '../../store/pinnedContextStore'

// Stable empty array used as the fallback when no block entry exists
// yet for the section id. Returning a fresh `[]` literal inside a
// Zustand selector triggers the "result of getSnapshot should be
// cached" warning and an infinite re-render loop, since each call
// yields a new array reference.
const _EMPTY_PINS = Object.freeze([])

export default function PromptBlockForm({
  mode = 'pbh',           // 'pbh' | 'ipb' (ipb variant lands in item 2)
  sectionId,
  // Caller-provided dispatcher. Invoked when the writer clicks Send
  // (or hits a future keyboard shortcut). Receives the composed
  // request: { systemPromptText, profileId, model, message }.
  // The caller wires this to `streamChat` + applies the response to
  // the Section + handles Section History snapshots. PromptBlockForm
  // only manages the form state + UI; it doesn't dispatch the LLM
  // request itself so the same form can be reused for PBH (writes
  // into a Section) and IPB (writes at a cursor / overwrites a range).
  onSend,
  // ToDo item 163 — Preview destination. When supplied, the gear
  // popover surfaces a "Preview Message" entry that fires this
  // callback with the SAME { systemPromptText, profileId, model,
  // message } payload `onSend` would have received. Caller routes
  // it through its handleSend with a previewOpts callback so the
  // wire payload is captured into a modal instead of dispatched.
  onSendPreview,
  // Caller-provided cancel handler. Aborts the in-flight stream.
  // Wired to the in-form Stop button + Esc shortcut + (item 2) the
  // editor toolbar's Stop state for IPB.
  onCancel,
  // Phase 2.9c item 7 — the scene id that the Prompt Block is hosted
  // inside (PBH: the scene the Section lives in; IPB: the scene the
  // editor is mounted on, when `surface_type === 'scene_main'`).
  // Drives the Scene Context toggle button — null/undefined disables
  // it (no parent scene to include). Caller derives this from
  // `editorSurface` for PBH and from `ipbStore` for IPB.
  hostSceneId = null,
  // The IPB's current anchor kind — 'cursor' or 'range', null when
  // not applicable (PBH passes null since PBH writes always target
  // the host Section). Drives whether the before/after surrounding-
  // prose context-window toggles render: visible only when
  // `mode === 'ipb' && anchorKind === 'cursor'` (planning doc §4.11:
  // "in section mode the preceding / following slider is hidden —
  // the section anchor IS the context.").
  anchorKind = null,
  // Phase 2.10a item 9 — which per-surface defaults slot this Prompt
  // Block reads from / writes to. One of:
  //   'section_pbh'           — regular Section's Prompt Block Header
  //   'scene_description_pbh' — Scene Description's Prompt Block Header
  //   'ipb'                   — Inline Prompt Block
  // Drives the gear popover's per-surface default reads (auto-expand
  // category + ★ marker placement) and per-surface default writes
  // (clicking ★ on a row sets it as the default for THIS surface).
  // Defaults to 'section_pbh' for backward-compatibility with any
  // caller that hasn't been updated yet, but every caller in this
  // codebase passes an explicit value.
  surfaceType = 'section_pbh',
}) {
  const block = useSectionPromptBlocksStore((s) => s.blocks[sectionId])
  const ensure = useSectionPromptBlocksStore((s) => s.ensure)
  const patch = useSectionPromptBlocksStore((s) => s.patch)
  // Per-block pinned-context actions (Phase 2.9c item 7). The
  // pinned-items array itself is read off `block` below alongside
  // other fields. These actions are stable function references.
  // Phase 2.10b bug 1 refactor — pin storage migrated to the unified
  // pinnedContextStore. PBH / IPB use `'block:<sectionId>'` surface key.
  // PromptBlockForm only adds + clears at the form level; per-pill
  // remove / config-change wiring lives inside `<PinRow>` directly.
  const addPin = usePinnedContextStore((s) => s.addPin)
  const flashPill = useUiStore((s) => s.flashPill)
  const clearPins = usePinnedContextStore((s) => s.clearPins)

  const systemPrompts = useSystemPromptsStore((s) => s.prompts)
  const prefs = useSettingsStore((s) => s.preferences)
  // Phase 2.10a item 13 — story-side per-surface prompt override.
  // Resolution adds a third step at the top of the chain (above the
  // program-wide per-surface default). Story overrides are
  // session-validated: a stored override id that doesn't resolve
  // against the local `system_prompts/` is silently skipped this
  // session (NOT cleared from `narrative.json`; re-opening on the
  // original install still uses it). That's the cross-install
  // portability guarantee.
  const story = useProjectStore((s) => s.story)
  const storyOverrideRaw = story?.default_prompt_overrides?.[surfaceType] || null
  const storyOverride = storyOverrideRaw && systemPrompts.find((p) => p.id === storyOverrideRaw)
    ? storyOverrideRaw
    : null

  // v0.2.9.72 — when an MCP session has the editor lock active (Phase
  // 2.1 lockout), the Prompt Block's Send is disabled because firing
  // it would stream a response that mutates the Section concurrently
  // with the AI's in-flight edits. Composition (typing into the
  // textarea, picking model / system prompt, adding context) stays
  // live; only the dispatch is gated. Lock releases → Send re-enables.
  const isMcpEditLocked = useMcpControlStore((s) => s.sessionState === 'active')

  // Materialise the block entry on first interaction.
  useEffect(() => {
    if (sectionId) ensure(sectionId)
  }, [sectionId, ensure])

  const expanded = !!block?.expanded
  const isStreaming = !!block?.isStreaming
  const message = block?.message || ''
  // Resolution chain: per-block override → per-surface default
  // (Phase 2.10a item 9) → legacy global (one-cycle compat) → null.
  // Writers who set a per-surface default in Settings expect the
  // PBH to use it even if they never touched the gear popover;
  // dropping the per-surface step would silently route through the
  // legacy global and the new Settings UI wouldn't take effect.
  const surfaceDefaultModelPair = prefs.default_models_per_surface?.[surfaceType] || null
  const systemPromptId = block?.system_prompt_id
    ?? storyOverride
    ?? prefs.default_prompts_per_surface?.[surfaceType]
    ?? prefs.default_system_prompt_id
    ?? null
  const profileId = block?.profile_id ?? surfaceDefaultModelPair?.profile_id ?? prefs.ai_default_profile_id ?? null
  const model = block?.model ?? surfaceDefaultModelPair?.model ?? prefs.ai_default_model?.model ?? null
  const lastFiredTitle = block?.lastFiredTitle || ''
  const streamError = block?.streamError || null
  // IPB cursor-mode context window toggles. Default ON when the
  // block entry hasn't materialised yet — matches the always-include
  // behaviour of v0.2.9.28-.30 so opening a fresh IPB doesn't strip
  // surrounding-prose context the writer didn't intend to drop.
  const includePreceding = block?.includePreceding ?? true
  const includeFollowing = block?.includeFollowing ?? true
  const precedingWords = block?.precedingWords ?? 50
  const followingWords = block?.followingWords ?? 50
  // Before/After surrounding-prose toggles. v0.2.9.42 widened from
  // IPB-cursor-mode-only to ANY surface that lives inside scene prose
  // (writer spec 2026-05-28): IPB cursor mode (prose around the
  // cursor), IPB section mode (prose around the selected range), and
  // PBH (prose around the host Section). Scene Description PBH stays
  // excluded — the description is a standalone field, not embedded
  // in prose.
  const showContextToggles = mode === 'ipb' || mode === 'pbh'
  // Auto-attach toggle state (Phase 2.9c — writer spec 2026-05-27).
  // PBH-only. Per-Section autoAttachEnabled (default true) gates
  // whether name-detection scans on writer transactions auto-pin
  // matched library objects to this block's pinnedContextItems.
  // Per-type kinds selection (`pbhAutoAttachTypes`) is global across
  // all PBHs (lives on uiStore), separate from `chatAutoAttachTypes`
  // so changing PBH kinds doesn't affect the chat composer.
  const autoAttachEnabled = block?.autoAttachEnabled !== false  // default true
  const pbhAutoAttachTypes = useUiStore((s) => s.pbhAutoAttachTypes)
  const setPbhAutoAttachType = useUiStore((s) => s.setPbhAutoAttachType)

  // Editor highlight state (Phase 2.9c v0.2.9.39 — writer spec
  // 2026-05-27 follow-up: "the overall editor level 'highlight
  // detected names' toggle also works inside the PBH prompt input").
  // The PBH textarea is now a `ChatComposerTipTapInput` instance, so
  // it gets the same `EntityHighlightExtension` the editor uses;
  // wiring the same uiStore toggle + per-type filter means the
  // master toggle on the editor toolbar controls inline name
  // colouring across BOTH surfaces in lockstep.
  const editorHighlightEnabled = useUiStore((s) => s.editorHighlightEnabled)
  const editorHighlightTypes = useUiStore((s) => s.editorHighlightTypes)
  const accentColorForHighlight = useAccentColor() || '#7c3aed'
  // Build name targets for the message input. PBH lives inside a
  // scene's `main_content` (the host editor surface) — use the
  // story-wide builder for now since the form doesn't have a clean
  // scene-id hook from the EditorSurface context shape; the editor's
  // own targets are scene-anchored when applicable but that's an
  // incremental refinement that can land later. Per-type filter
  // applied at build time.
  useEditorSurface()
  // Read store slices that drive the targets so the memo invalidates
  // when characters / locations / cues / etc. change.
  const _characters = useEntitiesStore((s) => s.characters)
  const _locations = useEntitiesStore((s) => s.locations)
  const _items = useEntitiesStore((s) => s.items)
  const _factions = useEntitiesStore((s) => s.factions)
  const _customs = useEntitiesStore((s) => s.customs)
  const _knowledges = useProjectStore((s) => s.knowledges)
  const _relationships = useProjectStore((s) => s.relationships)
  const _nodes = useProjectStore((s) => s.nodes)
  const _edges = useProjectStore((s) => s.edges)
  const _cues = useContextCuesStore((s) => s.cues)
  // Active-scene chip data (Phase 2.9d v0.2.9.42 — writer spec
  // 2026-05-28). When Scene Context is toggled ON, surface a pill at
  // the top of the context strip identifying which scene's state
  // will be sent. Mirrors the chat composer's "Current Scene:" chip
  // but uses **"Active Scene:"** phrasing — Prompt Blocks are always
  // tied to whichever scene is open in the editor (the scene doesn't
  // change per-block as it can in the chat panel, where a single
  // conversation can persist across scene navigation).
  const activeSceneTitle = useProjectStore((s) => {
    if (!hostSceneId) return ''
    const node = (s.nodes || []).find((n) => n.id === hostSceneId)
    return node?.data?.title || 'Untitled scene'
  })
  const projectNodes = useProjectStore((s) => s.nodes)

  const messageNameTargets = useMemo(() => {
    if (!editorHighlightEnabled) return _EMPTY_PINS
    try {
      const targets = buildStoryWideNameTargets(editorHighlightTypes || {}, {
        entities: { characters: _characters, locations: _locations, items: _items, factions: _factions, customs: _customs },
        project:  { knowledges: _knowledges, relationships: _relationships, nodes: _nodes, edges: _edges },
        cues:     { cues: _cues },
      })
      // Filter by per-type enabled flags (buildStoryWideNameTargets
      // already does this internally via its `types` arg).
      return targets || _EMPTY_PINS
    } catch { return _EMPTY_PINS }
  }, [
    editorHighlightEnabled, editorHighlightTypes,
    _characters, _locations, _items, _factions, _customs,
    _knowledges, _relationships, _nodes, _edges, _cues,
  ])

  // Scene Context toggle (Phase 2.9c item 7 — writer spec 2026-05-27).
  // OFF by default; ON includes the host scene's full resolved state
  // (entity chip states, scene description, etc.) via the same
  // renderer the chat composer's scene-context toggle uses.
  const sceneContextEnabled = block?.sceneContextEnabled ?? false
  // Section / Selection content toggle (writer spec 2026-05-27). ON
  // by default — preserves the existing behaviour (the Section's
  // content / IPB's selection range are the implicit context).
  // Hidden in IPB cursor mode (the Before/After toggles cover this).
  const includeHostSectionContent = block?.includeHostSectionContent ?? true
  // Scene Description PBH only — toggle for including the host scene's
  // narrative prose (the scene node's `main_content`) as additional
  // context alongside the description. Off by default; flips on when
  // the writer wants the AI to see the actual prose they've written
  // for the scene, not just the metadata description.
  const includeSceneMainProse = !!block?.includeSceneMainProse
  // Label shown on the Section/Selection pill — "Section" for PBH,
  // "Selection" for IPB section mode (the IPB is rewriting a selected
  // range, not a structural Section), "Description" for the Scene
  // Description Section's PBH (plain-text scene description as input,
  // overwritten on apply).
  const showSectionPill = (mode === 'pbh')
    || (mode === 'ipb' && anchorKind === 'range')
    || (mode === 'scene-description')
  const sectionPillLabel = mode === 'pbh'
    ? 'Section'
    : mode === 'scene-description'
      ? 'Description'
      : 'Selection'
  // Per-block pinned-context list (Phase 2.9c item 7). Bound to the
  // per-block store entry — distinct lists for each PBH and the IPB,
  // session-only, never persisted to `.nnz`.
  // Pin list now lives on the unified pinnedContextStore keyed
  // `'block:<sectionId>'`. Reactive subscription so the form's pin
  // strip + downstream consumers re-render when pins change.
  const pinnedContextItems = usePinnedContextStore(
    (s) => (sectionId ? (s.surfaces[`block:${sectionId}`] || _EMPTY_PINS) : _EMPTY_PINS)
  )
  const handleAddPinned = useCallback((item) => {
    if (sectionId) addPin(`block:${sectionId}`, item)
  }, [sectionId, addPin])
  const handleClearPinned = useCallback(() => {
    if (sectionId) clearPins(`block:${sectionId}`)
  }, [sectionId, clearPins])
  // AddContext popover open/close state + trigger ref (the popover
  // positions itself relative to the trigger via `triggerRef`).
  const [pinOpen, setPinOpen] = useState(false)
  const pinTriggerRef = useRef(null)
  // Context preview modal state (Phase 2.9c item 7 — writer spec
  // 2026-05-27 follow-up). Clicking a pinned-context pill opens the
  // same `SceneContextPreviewModal` the chat composer uses so the
  // writer can see EXACTLY how their pinned context resolves at the
  // host scene (and, if Scene Context is ON, what the scene block
  // looks like). `previewFocusItem` carries the clicked chip so the
  // modal can scroll-and-highlight its heading.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewFocusItem, setPreviewFocusItem] = useState(null)
  const closePreview = useCallback(() => {
    setPreviewOpen(false)
    setPreviewFocusItem(null)
  }, [])
  // Close the popover when the form collapses (writer can't see the
  // popover anchor any more); also close on Section dissolve via
  // the block state going away.
  useEffect(() => {
    if (!expanded && pinOpen) setPinOpen(false)
  }, [expanded, pinOpen])

  const systemPromptName = useMemo(() => {
    if (systemPromptId == null) return 'No system prompt'
    const found = systemPrompts.find((p) => p.id === systemPromptId)
    return found?.name || '(unknown prompt)'
  }, [systemPromptId, systemPrompts])

  const handleToggleExpand = useCallback(() => {
    if (isStreaming) return
    patch(sectionId, { expanded: !expanded })
  }, [sectionId, expanded, isStreaming, patch])

  // PBH prompt-textarea auto-attach scanner (Phase 2.9c — writer
  // spec 2026-05-27). PRIMARY scan target: the "What should the AI
  // do with this section's content?" textarea (this `message` state).
  // The Section's prose is SECONDARY — scanned by the separate
  // `PromptBlockAutoAttachExtension` on editor transactions. PBH only;
  // IPB skipped for now per writer scope.
  //
  // Mirrors the chat composer's scanner pattern in `ConversationView`
  // (lines ~260-330): 400ms debounce; build the same regex (longest
  // names first); diff against `prevPromptMatchedKeysRef` so only
  // NEW matches dispatch addPinnedItem. The Section-prose scanner's
  // diff is independent — both feed the same per-block
  // `pinnedContextItems` list with store-side dedupe catching
  // duplicates.
  const prevPromptMatchedKeysRef = useRef(new Set())
  useEffect(() => {
    if (!autoAttachEnabled || isStreaming) {
      prevPromptMatchedKeysRef.current = new Set()
      return undefined
    }
    const enabledAny = Object.values(pbhAutoAttachTypes || {}).some(Boolean)
    if (!enabledAny) return undefined
    const t = setTimeout(() => {
      try {
        const targets = buildStoryWideNameTargets(pbhAutoAttachTypes || {}, {
          entities: useEntitiesStore.getState(),
          project: useProjectStore.getState(),
          cues: useContextCuesStore.getState(),
        })
        const currentKeys = new Set()
        if (message && targets.length) {
          const sorted = [...targets].sort((a, b) => b.name.length - a.name.length)
          const escaped = sorted.map((x) => x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
          const lookup = new Map()
          for (const x of targets) {
            const k = x.name.toLowerCase()
            const arr = lookup.get(k) || []
            arr.push(x)
            lookup.set(k, arr)
          }
          let m
          while ((m = regex.exec(message)) !== null) {
            const matchKey = m[0].toLowerCase()
            const matchedTargets = lookup.get(matchKey)
            if (!matchedTargets) continue
            for (const target of matchedTargets) {
              let kind
              if (target.entityType === 'cue') kind = 'cue'
              else if (target.entityType === 'knowledge') kind = 'knowledge'
              else if (target.entityType === 'relationship') kind = 'relationship'
              else kind = 'entity'
              const key = `${kind}:${target.entityId}`
              if (currentKeys.has(key)) continue
              currentKeys.add(key)
              if (!prevPromptMatchedKeysRef.current.has(key)) {
                addPin(`block:${sectionId}`, { kind, id: target.entityId })
                flashPill(sectionId, kind, target.entityId)
              }
            }
          }
        }
        // Flash-on-name-removed: keys present last scan but gone this
        // scan = the writer deleted that name from the prompt. If the
        // pin is still on the strip (the writer didn't also ✕-remove
        // it), flash it as a hint that the auto-attached context is
        // still being sent. Mirrors the chat composer's diff-pass.
        const pinned = usePinnedContextStore.getState().getPins(`block:${sectionId}`)
        const pinnedKeys = new Set(pinned.map((p) => `${p.kind}:${p.id}`))
        for (const prevKey of prevPromptMatchedKeysRef.current) {
          if (currentKeys.has(prevKey)) continue
          if (!pinnedKeys.has(prevKey)) continue
          const idx = prevKey.indexOf(':')
          if (idx < 0) continue
          const kind = prevKey.slice(0, idx)
          const id = prevKey.slice(idx + 1)
          flashPill(sectionId, kind, id)
        }
        prevPromptMatchedKeysRef.current = currentKeys
      } catch { /* defensive — scanner failures are non-fatal */ }
    }, 400)
    return () => clearTimeout(t)
  }, [mode, message, autoAttachEnabled, isStreaming, pbhAutoAttachTypes, sectionId, addPin, flashPill])

  const handleSend = useCallback(() => {
    if (isStreaming) return
    if (!message.trim()) return
    if (!model || !profileId) return
    // v0.2.9.72 — MCP edit-lock check covers BOTH button-click and the
    // ChatComposerTipTapInput's Ctrl+Enter shortcut (which routes
    // through this same handler). Early-return makes the keyboard
    // path consistent with the visually-disabled buttons.
    if (isMcpEditLocked) return
    const activeSystemPrompt = systemPromptId == null
      ? null
      : (systemPrompts.find((p) => p.id === systemPromptId) || null)
    const systemPromptText = activeSystemPrompt?.prompt || null
    const mockMessages = Array.isArray(activeSystemPrompt?.mock_messages)
      ? activeSystemPrompt.mock_messages
      : []
    onSend?.({
      systemPromptText,
      mockMessages,
      profileId,
      model,
      message,
    })
  }, [isStreaming, message, model, profileId, systemPromptId, systemPrompts, isMcpEditLocked, onSend])

  // ToDo item 163 — Preview Message dispatch. Same payload shape as
  // handleSend; routed to `onSendPreview` instead of `onSend`. No
  // gates on `message` or `isStreaming` — writers can preview an
  // empty message ("[no message typed yet]" placeholder lives in
  // the caller's handleSend preview branch) or peek at the wire
  // while a stream is in flight. The MCP edit-lock still blocks
  // (the lock is about preventing concurrent writes; a read-only
  // preview is fine but matching the chat composer's behaviour
  // keeps the rules consistent across surfaces).
  const handlePreview = useCallback(() => {
    if (!model || !profileId) return
    if (isMcpEditLocked) return
    const activeSystemPrompt = systemPromptId == null
      ? null
      : (systemPrompts.find((p) => p.id === systemPromptId) || null)
    const systemPromptText = activeSystemPrompt?.prompt || null
    const mockMessages = Array.isArray(activeSystemPrompt?.mock_messages)
      ? activeSystemPrompt.mock_messages
      : []
    onSendPreview?.({
      systemPromptText,
      mockMessages,
      profileId,
      model,
      message,
    })
  }, [message, model, profileId, systemPromptId, systemPrompts, isMcpEditLocked, onSendPreview])

  // Summarize Scene — collapsed-state shortcut on the Scene
  // Description PBH only. Fires the per-surface default prompt +
  // model with no typed message and scene context forced on for
  // the send. The AI Prompt section stays collapsed; the streamed
  // response lands in the description field via the parent's
  // `handlePbhSend` (it honours the `sceneContextOverride` flag on
  // the payload). Disabled when the per-surface model isn't set —
  // the tooltip points the writer to Settings.
  const handleSummarizeScene = useCallback(() => {
    if (isStreaming) return
    if (!model || !profileId) return
    if (isMcpEditLocked) return
    const activeSystemPrompt = systemPromptId == null
      ? null
      : (systemPrompts.find((p) => p.id === systemPromptId) || null)
    const systemPromptText = activeSystemPrompt?.prompt || null
    const mockMessages = Array.isArray(activeSystemPrompt?.mock_messages)
      ? activeSystemPrompt.mock_messages
      : []
    onSend?.({
      systemPromptText,
      mockMessages,
      profileId,
      model,
      // Most providers (OpenAI, LM Studio, Anthropic, OpenRouter,
      // etc.) reject an empty `role: user` message with 400. A
      // minimal instruction here gives the wire a non-empty user
      // turn while the system prompt + scene context blocks
      // carry the actual summarisation directives.
      message: 'Summarize this scene.',
      sceneContextOverride: true,
      includeSceneMainContent: true,
    })
  }, [isStreaming, model, profileId, systemPromptId, systemPrompts, isMcpEditLocked, onSend])

  // Drop handlers for the expanded-form drag-to-attach path
  // (Phase 2.9c item 7). Sniff the same library MIME types the chat
  // composer accepts so the existing entity / knowledge / relationship
  // / cue drag sources work as drop sources for the Prompt Block with
  // no changes to those sources. `onDragOver` must call `preventDefault`
  // so the drop is accepted (default browser behaviour rejects drops);
  // `onDrop` reads the appropriate dataTransfer field by kind and
  // routes through `addPinnedItem` (dedupe applied in the store).
  // Declared HERE — above the collapsed-state early return below —
  // so the hook count stays stable across expanded / collapsed
  // renders (Rules of Hooks).
  //
  // `stopPropagation` on the drop event so the editor's own drop
  // handler doesn't ALSO fire (the form lives inside a ProseMirror
  // NodeView for PBH; without this the editor might try to insert
  // the dataTransfer's text/plain fallback into the prose).
  const handleDragOver = useCallback((e) => {
    const types = Array.from(e.dataTransfer?.types || [])
    if (!LIBRARY_DRAG_MIMES.some((m) => types.includes(m))) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])
  const handleDrop = useCallback((e) => {
    const types = Array.from(e.dataTransfer?.types || [])
    if (!LIBRARY_DRAG_MIMES.some((m) => types.includes(m))) return
    e.preventDefault()
    // Do NOT stopPropagation here. The prosemirror-dropcursor plugin
    // installs its `drop` listener on the editor's DOM; stopping
    // propagation prevented that listener from firing, so its
    // `scheduleRemoval(20)` never ran and the cursor element stayed
    // on its 5-second `dragover`-set fallback timeout (visible as a
    // bar across the form for several seconds after drop).
    // `preventDefault` on its own is enough to block the editor's
    // content-insertion path; ProseMirror's handleDOMEvents("drop")
    // checks `event.defaultPrevented` and bails when true.
    const eid = e.dataTransfer.getData('application/nnz-entity-id')
    const kid = e.dataTransfer.getData('application/nnz-knowledge-id')
    const rid = e.dataTransfer.getData('application/nnz-relationship-id')
    const cid = e.dataTransfer.getData('application/nnz-cue-id')
    if (eid) handleAddPinned({ kind: 'entity', id: eid })
    if (kid) handleAddPinned({ kind: 'knowledge', id: kid })
    if (rid) handleAddPinned({ kind: 'relationship', id: rid })
    if (cid) handleAddPinned({ kind: 'cue', id: cid })
    // Writer spec 2026-05-27 — when the drop lands on a COLLAPSED bar
    // (writer can drop on the small bar without expanding it first),
    // auto-expand so the writer sees the dropped pill land + can
    // tweak before firing. Streaming blocks don't auto-expand
    // (`isStreaming` keeps the bar locked to its streaming form).
    if (!expanded && !isStreaming && sectionId) {
      patch(sectionId, { expanded: true })
    }
  }, [handleAddPinned, expanded, isStreaming, sectionId, patch])

  // Document-level tracking for the library-drag in-flight state
  // (Phase 2.9c item 7). Drives two pieces of UI feedback:
  //   (1) the dashed-outline drop overlay on the form below — so the
  //       writer can see WHERE to drop the dragged item;
  //   (2) a body class `nn-library-drag-in-flight` that CSS uses to
  //       hide the editor's `.ProseMirror-dropcursor` indicator
  //       during library drags. The dropcursor's prose-insertion-point
  //       preview is meaningful for Section drag-handle moves, but
  //       library items don't get inserted into prose — they pin as
  //       context — so showing it confuses the drop target.
  // Multiple PromptBlockForm instances may be mounted (multiple
  // expanded PBHs in different Sections); each adds its own
  // listeners. classList mutations are idempotent so duplicated
  // body-class adds / removes are harmless.
  const [libraryDragInFlight, setLibraryDragInFlight] = useState(false)
  const [libraryDragKind, setLibraryDragKind] = useState(null)
  const [isDragOverForm, setIsDragOverForm] = useState(false)
  useEffect(() => {
    function libraryDragKindFor(e) {
      const types = Array.from(e?.dataTransfer?.types || [])
      if (types.includes('application/nnz-entity-id')) return 'entity'
      if (types.includes('application/nnz-knowledge-id')) return 'knowledge'
      if (types.includes('application/nnz-relationship-id')) return 'relationship'
      if (types.includes('application/nnz-cue-id')) return 'cue'
      return null
    }
    function onDragEnter(e) {
      const kind = libraryDragKindFor(e)
      if (!kind) return
      setLibraryDragInFlight(true)
      setLibraryDragKind(kind)
      document.body.classList.add('nn-library-drag-in-flight')
    }
    // Body class removal is deferred two animation frames after the
    // drag ends so the editor's `prosemirror-dropcursor` element gets
    // a chance to remove itself BEFORE our `display: none` rule
    // lifts. Without the deferral, drop fires → we clear the class
    // synchronously → ProseMirror's dropcursor still in the DOM for
    // one paint → cursor line flashes visibly during expand-after-
    // drop. Two RAFs is the common belt-and-braces "after the next
    // paint" gap.
    function clearBodyClassDeferred() {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.body.classList.remove('nn-library-drag-in-flight')
        })
      })
    }
    function onDragLeave(e) {
      // dragleave fires on every child crossing too; only treat it as
      // "left the window" when relatedTarget is null (browser
      // convention for cross-window-boundary leaves).
      if (e.relatedTarget != null) return
      setLibraryDragInFlight(false)
      setLibraryDragKind(null)
      setIsDragOverForm(false)
      clearBodyClassDeferred()
    }
    function onEnd() {
      setLibraryDragInFlight(false)
      setLibraryDragKind(null)
      setIsDragOverForm(false)
      clearBodyClassDeferred()
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onEnd)
    document.addEventListener('dragend', onEnd)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onEnd)
      document.removeEventListener('dragend', onEnd)
      document.body.classList.remove('nn-library-drag-in-flight')
    }
  }, [])
  // Form-level dragenter / dragleave: when the pointer crosses into
  // the form's bounds, intensify the drop overlay so the writer can
  // see they're over a valid target. dragleave with relatedTarget
  // pointing OUTSIDE the form clears it.
  const handleFormDragEnter = useCallback((e) => {
    const types = Array.from(e.dataTransfer?.types || [])
    if (!LIBRARY_DRAG_MIMES.some((m) => types.includes(m))) return
    setIsDragOverForm(true)
  }, [])
  const handleFormDragLeave = useCallback((e) => {
    // Only clear when the related target is OUTSIDE the form (the
    // browser fires dragleave on every child crossing; ignore those).
    if (e.currentTarget?.contains(e.relatedTarget)) return
    setIsDragOverForm(false)
  }, [])

  // Escape cancels a streaming send.
  useEffect(() => {
    if (!isStreaming) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel?.()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isStreaming, onCancel])

  // ── Collapsed states ───────────────────────────────────────────
  if (!expanded) {
    // Preview text shown on the collapsed bar. Prefer the CURRENT
    // unsent message draft (so the writer sees what would fire if
    // they click the inline Write button) — falls back to the most-
    // recently-fired prompt title, then to a generic placeholder.
    // While streaming the label shows the last-fired title (or a
    // generic "AI is writing…" placeholder) since the current draft
    // may already be wiped or stale.
    const previewText = isStreaming
      ? (lastFiredTitle || 'AI is writing…')
      : (message.trim() || lastFiredTitle || 'AI prompt')
    const canSend = !!message.trim() && !!model && !!profileId && !isMcpEditLocked
    return (
      <div
        className={`nn-pbf nn-pbf-collapsed nn-pbf-mode-${mode}${isDragOverForm ? ' is-drag-over' : ''}`}
        contentEditable={false}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnter={handleFormDragEnter}
        onDragLeave={handleFormDragLeave}
        data-help-region="prompt-block-form:form"
      >
        {/* Drop overlay also surfaces on the COLLAPSED bar so the
            writer can drop directly onto it without expanding first
            (writer spec 2026-05-27). Drop on the collapsed bar
            auto-expands the form (see handleDrop above) so the
            writer can see the pill land + tweak before firing. */}
        {libraryDragInFlight && (
          <div
            className={`nn-pbf-drop-overlay${isDragOverForm ? ' is-active' : ''}`}
            aria-hidden="true"
          >
            <span className="nn-pbf-drop-label">
              {isDragOverForm
                ? `Drop to attach this ${libraryDragKind || 'item'}`
                : `Drop here to attach this ${libraryDragKind || 'item'}`}
            </span>
          </div>
        )}
        <button
          type="button"
          className="nn-pbf-collapsed-bar"
          onClick={handleToggleExpand}
          title={isStreaming
            ? 'AI prompt is streaming a response into this Section. Click to expand.'
            : 'AI prompt — click to expand and compose a prompt for this Section.'}
        >
          <span className="nn-pbf-caret">{isStreaming ? '●' : '▸'}</span>
          <span className="nn-pbf-collapsed-label">{previewText}</span>
          {isStreaming && (
            <span className="nn-pbf-streaming-indicator" aria-hidden="true" />
          )}
          {streamError && !isStreaming && (
            <span className="nn-pbf-error-indicator" title={`Last send errored: ${streamError}`}>!</span>
          )}
        </button>
        {/* Inline Write / Stop button on the right edge of the
            collapsed row — lets the writer re-fire (or cancel) the
            prompt that's currently in the form WITHOUT having to
            expand the form first. Send button morph mirrors the
            expanded form: idle → "Write" label, streaming → media-
            stop square (same red-tinted style as the expanded
            form's Stop variant). Renders in BOTH PBH and IPB
            collapsed-idle states. (The IPB's collapsed-streaming
            state never reaches this code path because
            `InlinePromptBlock` renders the inverted-teardrop pin
            in place of the form when streaming + collapsed, so
            this branch only fires for IPB when it's collapsed-
            idle — exactly when we want the Write button to be
            available for re-fire.) */}
        {isStreaming ? (
          <button
            type="button"
            className="nn-pbf-collapsed-send nn-pbf-collapsed-stop"
            onClick={onCancel}
            title="Stop the streaming response (Esc also cancels)"
            aria-label="Stop"
          >
            <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="0.8" />
            </svg>
          </button>
        ) : mode === 'scene-description' ? (
          <button
            type="button"
            className="nn-pbf-collapsed-send"
            onClick={handleSummarizeScene}
            disabled={isMcpEditLocked || !model || !profileId}
            title={isMcpEditLocked
              ? 'Summarize Scene unavailable while an MCP session is active. End or pause the session to re-enable.'
              : !model || !profileId
                ? 'Set a default model for Scene Description in Settings → MCP & API Connections to enable Summarize Scene'
                : 'Summarize Scene — fires the per-surface default prompt + model with scene context, no typed message needed.'}
            aria-label="Summarize Scene"
          >
            Summarize Scene
          </button>
        ) : (
          <button
            type="button"
            className="nn-pbf-collapsed-send"
            onClick={handleSend}
            disabled={!canSend}
            title={isMcpEditLocked
              ? 'Write unavailable while an MCP session is active. End or pause the session to re-enable.'
              : !model || !profileId
                ? 'Set a default model in Settings → MCP & API Connections to enable Write'
                : !message.trim()
                  ? 'Type a prompt in the expanded form to enable Write'
                  : 'Write — fires the previewed prompt without expanding the form.'}
            aria-label="Write"
          >
            Write
          </button>
        )}
      </div>
    )
  }

  // ── Expanded form — chat-composer-style layout ────────────────
  return (
    <div
      className={`nn-pbf nn-pbf-expanded nn-pbf-mode-${mode}${isDragOverForm ? ' is-drag-over' : ''}`}
      contentEditable={false}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnter={handleFormDragEnter}
      onDragLeave={handleFormDragLeave}
      data-help-region="prompt-block-form:form"
    >
      {/* Library-drag drop overlay (Phase 2.9c item 7). Shown
          whenever a library item is being dragged anywhere in the
          window so the writer can SEE where to drop. Intensifies
          when the pointer is directly over this form. Pointer-events
          none on the overlay so the underlying drag events still
          reach the form (otherwise the overlay would intercept them
          and the form's own dragenter/drop wouldn't fire). */}
      {libraryDragInFlight && (
        <div
          className={`nn-pbf-drop-overlay${isDragOverForm ? ' is-active' : ''}`}
          aria-hidden="true"
        >
          <span className="nn-pbf-drop-label">
            {isDragOverForm
              ? `Drop to attach this ${libraryDragKind || 'item'}`
              : `Drop here to attach this ${libraryDragKind || 'item'}`}
          </span>
        </div>
      )}
      {/* Top row: collapse button (top-left corner) + context pills
          strip placeholder. Pinned-context pill rendering lands in
          Phase 2.9c item 7 (manual context attachment). For now the
          strip is empty but reserves vertical space + provides the
          row anchor for the collapse affordance. */}
      <div className="nn-pbf-top-row">
        <button
          type="button"
          className="nn-pbf-collapse-btn-tb"
          onClick={handleToggleExpand}
          title="Collapse the AI prompt"
          aria-label="Collapse"
          disabled={isStreaming}
        >
          ▾
        </button>
        <div className="nn-pbf-context-strip" aria-label="Attached context pills">
          {/* Active Scene chip (Phase 2.9d v0.2.9.42). Surfaces at
              the top of the strip, separated from the manual /
              section pills below, whenever Scene Context is ON AND
              there's a host scene. Mirrors the chat composer's
              "Current Scene:" chip but uses **"Active Scene:"**
              phrasing — Prompt Blocks are always tied to the scene
              currently open in the editor (the scene doesn't shift
              per-block as it can in chat, where a single
              conversation can persist across scene navigation, so
              "Active" is the more accurate descriptor here).
              Click the chip → open the context preview modal
              (showing the scene-context block the LLM will see).
              ✕ → turn off the Scene Context toggle. */}
          {sceneContextEnabled && hostSceneId && (
            <ActiveSceneDynamicRow
              hostSceneId={hostSceneId}
              activeSceneTitle={activeSceneTitle}
              projectNodes={projectNodes}
              flashScope={sectionId}
              onPreview={() => {
                setPreviewFocusItem(null)
                setPreviewOpen(true)
              }}
              onRemove={() => patch(sectionId, { sceneContextEnabled: false })}
            />
          )}
          {/* Manually-attached context pills (Phase 2.9c item 7).
              Delegates to the unified `<PinRow>` component (Phase 2.10b
              bug 1 refactor) which subscribes to the block's bucket on
              the unified pinnedContextStore. PBH / IPB don't surface
              the chat anchor picker, so `onOpenAnchorPicker` is omitted. */}
          {pinnedContextItems.length > 0 && (
            <div className="nn-pbf-pinned-row">
              <PinRow
                surfaceKey={`block:${sectionId}`}
                flashScope={sectionId}
                anchorSceneId={hostSceneId || null}
                onPreview={(item) => {
                  setPreviewFocusItem(item)
                  setPreviewOpen(true)
                }}
              />
            </div>
          )}
          {/* Implicit-context toggles row (Phase 2.9c item 7 / writer
              spec 2026-05-28). Pills here are SPECIAL CASE — always
              present (regardless of pinned items) but toggleable on /
              off. Carries the Section/Selection/Description content
              toggle (when applicable) and the Before/After surrounding-
              prose toggles (when the block lives in scene prose).
              Rendered as its own row at the bottom of the strip with
              a smaller corner radius on the pills (CSS modifier
              `nn-pbf-implicit-row`) to telegraph the "always-present
              + toggleable" role distinct from the manual-attach pills
              above. Hidden in Scene Description PBH for Before/After
              specifically — the description is a standalone field
              with no surrounding prose to slice. */}
          {(showSectionPill || showContextToggles) && (
            <div className="nn-pbf-implicit-row">
              {showSectionPill && (
                <SimpleTogglePill
                  label={sectionPillLabel}
                  on={includeHostSectionContent}
                  disabled={isStreaming}
                  title={includeHostSectionContent
                    ? `${sectionPillLabel} content is included as context. Click to exclude it (the AI will write without seeing what's there).`
                    : `${sectionPillLabel} content is NOT included. Click to include it as context.`}
                  onToggle={() => patch(sectionId, { includeHostSectionContent: !includeHostSectionContent })}
                />
              )}
              {/* Scene Description PBH only — toggle to include the
                  host scene's narrative prose (the scene node's
                  `main_content`) as context alongside the
                  description. Off by default; lets the writer share
                  the actual scene text without manually pinning a
                  `current_scene_body` dynamic pill. */}
              {mode === 'scene-description' && (
                <SimpleTogglePill
                  label="Scene prose"
                  on={includeSceneMainProse}
                  disabled={isStreaming}
                  title={includeSceneMainProse
                    ? 'The scene\'s narrative prose is included as context. Click to exclude it.'
                    : 'The scene\'s narrative prose is NOT included. Click to include it as context.'}
                  onToggle={() => patch(sectionId, { includeSceneMainProse: !includeSceneMainProse })}
                />
              )}
              {showContextToggles && (
                <>
                  <ContextPill
                    label="Before"
                    on={includePreceding}
                    count={precedingWords}
                    disabled={isStreaming}
                    directionLabel="BEFORE"
                    onToggle={() => patch(sectionId, { includePreceding: !includePreceding })}
                    onCountChange={(n) => patch(sectionId, { precedingWords: n })}
                  />
                  <ContextPill
                    label="After"
                    on={includeFollowing}
                    count={followingWords}
                    disabled={isStreaming}
                    directionLabel="AFTER"
                    onToggle={() => patch(sectionId, { includeFollowing: !includeFollowing })}
                    onCountChange={(n) => patch(sectionId, { followingWords: n })}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="nn-pbf-composer-row">
        {/* Phase 2.9c v0.2.9.39 — replaced plain <textarea> with the
            chat composer's TipTap-based input (per planning doc §4.10
            "shared form architecture"). Inherits the editor's
            "highlight detected names" toggle + per-type filter from
            uiStore so library-object names typed here get the same
            inline colour they'd get in the Section's prose. Ctrl+Enter
            send is wired via ChatComposerTipTapInput's KeyboardHandler
            (sendOnEnter=false → Mod+Enter fires onSend). */}
        <div className="nn-pbf-message" data-help-region="prompt-block-form:message">
          <ChatComposerTipTapInput
            value={message}
            onChange={(text) => patch(sectionId, { message: text })}
            onSend={handleSend}
            sendOnEnter={false}
            placeholder="What should the AI do with this Section's content?"
            disabled={isStreaming}
            nameTargets={messageNameTargets}
            highlightEnabled={editorHighlightEnabled}
            accentColor={accentColorForHighlight}
            innerClassName="nn-pbf-message-inner"
          />
        </div>
        <div className="nn-pbf-send-col">
          {isStreaming ? (
            <button
              type="button"
              className="nn-pbf-send-btn nn-pbf-stop-btn"
              onClick={onCancel}
              title="Stop the streaming response (Esc also cancels)"
              aria-label="Stop"
            >
              {/* Filled square — same media-stop glyph the chat
                  composer uses for its in-flight Stop button. Icon
                  only, no text label, to match. */}
              <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" rx="0.8" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="nn-pbf-send-btn"
              onClick={handleSend}
              disabled={!message.trim() || !model || !profileId || isMcpEditLocked}
              data-help-region="prompt-block-form:send"
              title={isMcpEditLocked
                ? 'Write unavailable while an MCP session is active. End or pause the session to re-enable.'
                : !model || !profileId
                  ? 'Set a default model in Settings → MCP & API Connections to enable Write'
                  : !message.trim()
                    ? 'Type a prompt to enable Write'
                    : 'Write — fires the prompt; the response will overwrite this Section\'s content. (Ctrl+Enter also fires.)'}
            >
              Write
            </button>
          )}
        </div>
      </div>
      <div className="nn-pbf-toolbar-row">
        <SettingsGearButton
          systemPromptName={systemPromptName}
          modelName={model || '(no model)'}
          sectionId={sectionId}
          systemPromptId={systemPromptId}
          profileId={profileId}
          model={model}
          surfaceType={surfaceType}
          onRequestPreview={handlePreview}
        />
        {/* Live AddContext button + popover (Phase 2.9c item 7).
            Both reuse the chat composer's components directly with
            the per-block store as the binding source. Popover is
            rendered as a positioned sibling — the parent
            `.nn-pbf-toolbar-row` provides the relative anchor since
            the popover uses `bottom-full / left-2` absolute
            positioning. Wrapped in its own relative-positioned span
            so the popover anchors to the button, not the whole
            toolbar row. */}
        <span className="relative inline-flex">
          <AddContextButton
            ref={pinTriggerRef}
            open={pinOpen}
            onToggle={() => setPinOpen((v) => !v)}
            pinCount={pinnedContextItems.length}
            onClearAll={handleClearPinned}
          />
          {pinOpen && (
            <AddContextPickerPopover
              threadId={null}
              triggerRef={pinTriggerRef}
              onClose={() => setPinOpen(false)}
              pinned={pinnedContextItems}
              onAdd={handleAddPinned}
              hideStoryScope
            />
          )}
        </span>
        {/* Scene Context toggle (Phase 2.9c item 7 — writer spec
            2026-05-27). Reuses the chat composer's SceneContextButton
            directly with per-block state + the host scene id (the
            scene this Section / IPB lives in). Hidden when there's no
            parent scene (e.g. the host surface is cue body / entity
            notes / knowledge notes / reference note — no scene). */}
        {hostSceneId && (
          <SceneContextButton
            enabled={sceneContextEnabled}
            onToggle={(next) => patch(sectionId, { sceneContextEnabled: !!next })}
            sceneId={hostSceneId}
          />
        )}
        {/* Auto-attach toggle (Phase 2.9c — writer spec 2026-05-27).
            PRIMARY scan: this form's prompt textarea. SECONDARY scan:
            for PBH = the host Section's prose; for IPB = the selected
            range (only in section mode; IPB cursor mode has no
            secondary scan because the Before/After window already
            covers surrounding-prose context). Master toggle drives
            THIS block's autoAttachEnabled (per-block, session-only);
            flyout's per-type checkboxes drive the global
            pbhAutoAttachTypes (shared across all PBHs and the IPB).
            NO subtoggle (editor prose highlight is always-on via
            EntityHighlightExtension, so this master directly gates
            auto-attach). */}
        <NameDetectToggle
          enabled={autoAttachEnabled}
          onToggle={(next) => patch(sectionId, { autoAttachEnabled: !!next })}
          selectedTypes={pbhAutoAttachTypes}
          onToggleType={setPbhAutoAttachType}
          toggleTooltipOn="Auto-attach detected names: ON. Names you type in this Prompt Block auto-pin as context. Click to disable; click ▾ to pick kinds."
          toggleTooltipOff="Auto-attach detected names: OFF. Click to enable; click ▾ to pick kinds."
          flyoutHeading="Detect names of"
          renderIcon={AutoAttachReticleIcon}
          iconSize={16}
        />
        {streamError && !isStreaming && (
          <span className="nn-pbf-error-message" title={streamError}>
            Last send errored: {streamError}
          </span>
        )}
        {/* Reasoning lives on the far right (matches chat composer's
            `ml-auto` placement of ReasoningButton). */}
        <div className="nn-pbf-toolbar-spacer" />
        <ReasoningStubButton />
      </div>
      {/* Context preview modal (Phase 2.9c item 7 — writer spec
          2026-05-27 follow-up). Reuses the chat composer's
          `SceneContextPreviewModal` with per-block pinned items via
          the `pinnedItems` prop override. Opens when the writer
          clicks a pinned-context chip; `focusItem` carries the
          clicked chip so the modal scrolls-and-highlights its
          heading. The modal renders the EXACT context block the LLM
          will see (resolved via `buildSceneContextBlock`), including
          the scene block when Scene Context is ON. */}
      {previewOpen && (
        <SceneContextPreviewModal
          sceneId={sceneContextEnabled ? hostSceneId : null}
          sceneTitle=""
          focusItem={previewFocusItem}
          pinnedItems={pinnedContextItems}
          onClose={closePreview}
        />
      )}
    </div>
  )
}

// ── Settings gear button + inline picker popover ────────────────
// Mirrors the chat composer's `ChatSettingsButton` visual chrome
// (20x20 gear icon, accent-tinted when open). For v1 the popover is
// a simple inline implementation; the cross-cutting volatile-copy
// editing item refactors `ChatSettingsPopover`'s model / system-prompt
// picker into a shared component both surfaces use.
function SettingsGearButton({ systemPromptName, modelName, sectionId, systemPromptId, profileId, model, surfaceType, onRequestPreview }) {
  const buttonRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ left: 0, top: 0 })

  useEffect(() => {
    if (!open) return
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    // Anchor above the button so the popover doesn't extend off the
    // bottom of small panels (matches chat composer's "above the
    // gear" convention).
    setPopoverPos({ left: rect.left, top: rect.top })
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Prompt Block settings — current: ${systemPromptName} · ${modelName}. Click to change.`}
        aria-label="Prompt Block settings"
        className={`nn-pbf-icon-btn ${open ? 'nn-pbf-icon-btn-active' : ''}`}
        data-help-region="prompt-block-form:settings"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {open && (
        <PromptBlockSettingsPopover
          sectionId={sectionId}
          systemPromptId={systemPromptId}
          profileId={profileId}
          model={model}
          surfaceType={surfaceType}
          left={popoverPos.left}
          top={popoverPos.top}
          onClose={() => setOpen(false)}
          buttonRef={buttonRef}
          onRequestPreview={onRequestPreview}
        />
      )}
    </>
  )
}

function PromptBlockSettingsPopover({ sectionId, systemPromptId, profileId, model, surfaceType, left, top, onClose, buttonRef, onRequestPreview }) {
  // Phase 2.10a item 13 — story-side per-surface prompt override
  // sits at the top of the picker's defaultPromptId chain too, so
  // the ★ marker + auto-expand category reflect what would actually
  // get sent. Session-validated (stale ids silently skip).
  const story = useProjectStore((s) => s.story)
  const popoverRef = useRef(null)
  const patch = useSectionPromptBlocksStore((s) => s.patch)
  const systemPrompts = useSystemPromptsStore((s) => s.prompts)
  const systemPromptCategories = useSystemPromptsStore((s) => s.categories)
  const loadSystemPrompts = useSystemPromptsStore((s) => s.loadPrompts)
  const loadSystemPromptCategories = useSystemPromptsStore((s) => s.loadCategories)
  const prefs = useSettingsStore((s) => s.preferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)

  // The popover is on-demand UI — Settings tab + chat panel are the
  // other surfaces that trigger these loads, but neither may have
  // run yet by the time the writer clicks the PBH gear. Kick them
  // off on mount; idempotent loaders no-op if already in flight.
  useEffect(() => { loadSystemPrompts() }, [loadSystemPrompts])
  useEffect(() => { loadSystemPromptCategories() }, [loadSystemPromptCategories])

  useEffect(() => {
    function onDocClick(e) {
      if (popoverRef.current?.contains(e.target)) return
      if (buttonRef?.current?.contains(e.target)) return
      // Flyouts (Connection / Model and System Prompt) render via a
      // React Portal to document.body so they can escape the
      // popover's clipping context — they're NOT inside the
      // popover's DOM subtree, but they ARE part of the popover
      // semantically. Treat a click inside the flyout portal as
      // "inside" so the popover doesn't close mid-interaction.
      if (e.target?.closest && e.target.closest('[data-prompt-block-flyout]')) return
      onClose()
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, buttonRef])

  const tree = useMemo(() => {
    const profiles = prefs.ai_provider_profiles || []
    return profiles
      .map((profile) => {
        const selected = profile.selected_models || []
        const manual = profile.manually_added_models || []
        const models = Array.from(new Set([...selected, ...manual]))
        return { profile, models }
      })
      .filter(({ models }) => models.length > 0)
  }, [prefs.ai_provider_profiles])

  // Hover-flyout state — same shape as the chat panel's
  // `ChatSettingsPopover`. Grace timer (400ms) keeps the flyout
  // open while the cursor crosses from row → flyout and tolerates
  // brief layout shifts inside the System Prompt picker (category
  // collapse shrinks the flyout vertically).
  const [hoverFlyout, setHoverFlyout] = useState(null)
  const closeTimerRef = useRef(null)
  // Remembered open category for the System Prompt picker. Lives
  // for the lifetime of this popover so the writer can flip the
  // flyout closed (e.g. to inspect the row above), reopen, and find
  // the same category still expanded. Closing the gear popover
  // unmounts this and the next open auto-picks from default/active.
  // Starts as `null` (NOT `undefined`) so the picker reads this as
  // a controlled slot from the very first render.
  const [promptPickerOpenKey, setPromptPickerOpenKey] = useState(null)
  // Same shape for the Connection / Model picker — last-expanded
  // profile persists across hover open/close while the gear
  // popover stays mounted.
  const [modelPickerOpenKey, setModelPickerOpenKey] = useState(null)
  function openFlyout(name) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setHoverFlyout(name)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setHoverFlyout(null)
      closeTimerRef.current = null
    }, 500)
  }

  // Per-surface defaults from preferences — used for the ★ markers
  // and the initial auto-expand category / profile on each picker.
  // Resolution: surface-specific slot → legacy global field (one-cycle
  // compat per the no-cliffs rule).
  const surfaceDefaultModel = prefs.default_models_per_surface?.[surfaceType] || null
  const defaultProfileId = surfaceDefaultModel?.profile_id || prefs.ai_default_model?.profile_id || null
  const defaultModel = surfaceDefaultModel?.model || prefs.ai_default_model?.model || null
  const storyOverrideRaw = story?.default_prompt_overrides?.[surfaceType] || null
  const storyOverride = storyOverrideRaw && systemPrompts.find((p) => p.id === storyOverrideRaw)
    ? storyOverrideRaw
    : null
  const defaultPromptId = storyOverride
    ?? prefs.default_prompts_per_surface?.[surfaceType]
    ?? prefs.default_system_prompt_id
    ?? null

  // ★ click handlers — write the per-surface slot, leave legacy
  // globals untouched (the chat panel mirrors into the legacy
  // fields for now; PBH surfaces don't, so the chat-panel default
  // isn't accidentally overwritten by a PBH ★ click).
  function setModelAsSurfaceDefault(pId, m, event) {
    event?.stopPropagation()
    // Toggle semantics: picker passes `null`+`null` when the writer
    // clicks the already-default row's ★ — clears the surface slot.
    const slotValue = (pId && m) ? { profile_id: pId, model: m } : null
    const next = { ...(prefs.default_models_per_surface || {}), [surfaceType]: slotValue }
    updatePreferences({ default_models_per_surface: next })
  }
  function setPromptAsSurfaceDefault(pId, event) {
    event?.stopPropagation()
    // Toggle semantics: picker passes `null` when the writer clicks
    // the already-default prompt's ★ — clears the surface slot.
    const next = { ...(prefs.default_prompts_per_surface || {}), [surfaceType]: pId || null }
    updatePreferences({ default_prompts_per_surface: next })
  }

  // Display labels for the section rows so the writer sees the
  // active state without having to open each flyout.
  const activeProfileName = tree.find((t) => t.profile.id === profileId)?.profile?.name || null
  const modelLabel = model || '(use project default)'
  const promptLabel = systemPromptId == null
    ? 'No system prompt'
    : (systemPrompts.find((p) => p.id === systemPromptId)?.name || '(unknown prompt)')

  function pickModel(pId, m) {
    patch(sectionId, { profile_id: pId, model: m })
  }
  function pickPrompt(pId) {
    patch(sectionId, { system_prompt_id: pId })
    // Phase 2.10b item 11 — at every prompt-pick (including
    // re-picking the currently active prompt) run the apply-on-pick
    // dispatcher to (A) clear prior prompt-attached pills + add the
    // new prompt's `context_markers` as dynamic pills, and (B)
    // populate the surface's Tier 1 affordances from
    // `prompt.surface_defaults`. Manual pins are never touched;
    // surface affordances the prompt is silent on are preserved.
    const surfaceKey = `block:${sectionId}`
    const pinStore = usePinnedContextStore.getState()
    const currentPins = pinStore.getPins(surfaceKey)
    const picked = pId
      ? (systemPrompts || []).find((p) => p.id === pId) || null
      : null
    applyPromptOnPick({
      prompt: picked,
      currentPins,
      addPin: (item) => pinStore.addPin(surfaceKey, item),
      removePin: (sid) => pinStore.removePin(surfaceKey, sid),
      applySurfaceDefaults: (defs) => _applySurfaceDefaultsToBlock(sectionId, defs, patch),
      sourcePromptId: pId,
    })
  }
  function resetToDefaults() {
    patch(sectionId, { profile_id: null, model: null, system_prompt_id: null })
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[60] w-[290px] rounded border border-zinc-700 bg-zinc-900 shadow-xl py-1 text-[11px]"
      style={{ left, top, transform: 'translateY(calc(-100% - 4px))' }}
      data-help-region="prompt-block-form:settings_popover"
    >
      <PopoverSectionRow
        label="Connection / Model"
        value={modelLabel}
        secondary={activeProfileName}
        isOpen={hoverFlyout === 'model'}
        onEnter={() => openFlyout('model')}
        onLeave={scheduleCloseFlyout}
        flyoutWidth={300}
        flyoutDataAttr="prompt-block-flyout"
      >
        <ConnectionModelPickerList
          tree={tree}
          activeProfileId={profileId}
          activeModel={model}
          defaultProfileId={defaultProfileId}
          defaultModel={defaultModel}
          onPick={pickModel}
          onSetDefault={setModelAsSurfaceDefault}
          controlledOpenKey={modelPickerOpenKey}
          onOpenKeyChange={setModelPickerOpenKey}
        />
      </PopoverSectionRow>

      <PopoverSectionRow
        label="System Prompt"
        value={promptLabel}
        isOpen={hoverFlyout === 'prompt'}
        onEnter={() => openFlyout('prompt')}
        onLeave={scheduleCloseFlyout}
        flyoutWidth={260}
        flyoutDataAttr="prompt-block-flyout"
      >
        <SystemPromptPickerList
          prompts={systemPrompts}
          categories={systemPromptCategories}
          activePromptId={systemPromptId}
          defaultPromptId={defaultPromptId}
          onPick={pickPrompt}
          onSetDefault={setPromptAsSurfaceDefault}
          controlledOpenKey={promptPickerOpenKey}
          onOpenKeyChange={setPromptPickerOpenKey}
        />
      </PopoverSectionRow>

      {/* ToDo item 163 — Preview Message. Opens a popup modal that
          shows exactly what would be sent to the LLM if the writer
          clicked Write right now. Same dispatcher the Write button
          uses, just with previewOpts so the wire payload is routed
          to the modal instead of dispatched to streamChat. */}
      {typeof onRequestPreview === 'function' && (
        <div className="border-t border-zinc-800 mt-1 pt-1">
          <button
            type="button"
            onClick={() => { onClose(); onRequestPreview() }}
            className="w-full text-left px-2.5 py-1 text-zinc-200 hover:bg-zinc-800/60 transition-colors flex items-center gap-2"
          >
            <span className="text-[11px]">Preview Message</span>
            <span className="ml-auto text-[10px] text-zinc-500">what's about to be sent</span>
          </button>
        </div>
      )}

      <div className="border-t border-zinc-800 mt-1 pt-1 px-2.5 py-1 flex justify-end">
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-[10px] text-zinc-400 hover:text-zinc-200"
          title="Use the project's default model + system prompt instead of overriding per-block."
        >
          Reset to project defaults
        </button>
      </div>
    </div>,
    document.body,
  )
}

// Disabled stub for Reasoning controls — mirrors the chat composer's
// ReasoningButton glyph (split-brain shape). Full wiring lands when /
// if Prompt Blocks gain reasoning-level controls (out of scope for
// item 1).
function ReasoningStubButton() {
  return (
    <button
      type="button"
      disabled
      title="Reasoning controls. Wires up in a later Phase 2.9c item."
      aria-label="Reasoning"
      className="nn-pbf-icon-btn nn-pbf-icon-btn-disabled"
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.5A3 3 0 0 0 5 18v1a3 3 0 0 0 4 1V3z" />
        <path d="M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 2 5.5A3 3 0 0 1 19 18v1a3 3 0 0 1-4 1V3z" />
      </svg>
    </button>
  )
}

// ── IPB cursor-mode context window toggle pill + hover popover ──
// One pill per direction (Before / After). Click the pill to toggle
// inclusion on/off; hover the pill to reveal a popover above it
// containing a 0–500 word slider + a click-to-edit numeric input
// for entering custom counts outside the slider's typical range or
// just precise values. The popover is portaled to body so it
// overflows the form's bounds cleanly; close is 150ms-delayed so
// the writer can move from pill → popover without it flashing
// closed. (Writer spec 2026-05-27 — folds the item-5 slider into
// the item-4 toggle pills rather than putting the slider on a
// separate row.)
const CONTEXT_WORD_MIN = 0
const CONTEXT_WORD_MAX = 500

// Phase 2.9c item 7 — simple on/off toggle pill (no slider / popover /
// word count). Used for the Section / Selection content pill in the
// form's context strip. Visually matches the Before/After ContextPills'
// chrome via the shared `.nn-pbf-context-pill` / `.nn-pbf-context-pill-on`
// classes so the strip reads as one consistent row of toggles.
// Phase 2.10b item 11 — Tier 1 surface defaults applier for the
// PBH / IPB block surface. Called from `pickPrompt` with a
// `SurfaceDefaults` payload (per the Pydantic shape in item 7).
// Walks each non-null slot and writes the explicit opinion to the
// block's existing state bucket via `patch()`. Slots the prompt is
// silent on (null) are skipped so the surface's current state is
// preserved. The whole payload may be applied in one `patch()` call
// for efficiency.
function _applySurfaceDefaultsToBlock(sectionId, defs, patch) {
  if (!defs || !sectionId || typeof patch !== 'function') return
  const merged = {}
  if (defs.scene_context !== null && defs.scene_context !== undefined) {
    merged.sceneContextEnabled = !!defs.scene_context
  }
  if (defs.host_section_content !== null && defs.host_section_content !== undefined) {
    merged.includeHostSectionContent = !!defs.host_section_content
  }
  if (defs.before && typeof defs.before === 'object') {
    if (defs.before.enabled !== undefined) merged.includePreceding = !!defs.before.enabled
    if (typeof defs.before.n === 'number') merged.precedingWords = defs.before.n
  }
  if (defs.after && typeof defs.after === 'object') {
    if (defs.after.enabled !== undefined) merged.includeFollowing = !!defs.after.enabled
    if (typeof defs.after.n === 'number') merged.followingWords = defs.after.n
  }
  if (Object.keys(merged).length > 0) patch(sectionId, merged)
}

export function SimpleTogglePill({ label, on, disabled, title, onToggle }) {
  return (
    <button
      type="button"
      className={`nn-pbf-context-pill${on ? ' nn-pbf-context-pill-on' : ''}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={!!on}
      title={title}
    >
      {label}
    </button>
  )
}

// Phase 2.10b — Tier 1 Active Scene chip for PBH / IPB surfaces. The
// PBH lives inside a specific scene's editor panel, so its
// `hostSceneId` is structurally fixed for the lifetime of the
// component — the scene reference cannot change. No bolt icon
// (the bolt identifies pills whose reference IS dynamic) and no
// useDynamicPillFlash subscription (nothing to flash for, ever).
// Per Bug 3 (Phase 2.10).
function ActiveSceneDynamicRow({ hostSceneId, activeSceneTitle, projectNodes, onPreview, onRemove }) {
  return (
    <div className="nn-pbf-active-scene-row">
      <span className="nn-pbf-active-scene-label">Active Scene:</span>
      <span
        className="nn-pbf-active-scene-chip"
        title={`Scene context for "${activeSceneTitle}" will be sent with each prompt until you toggle it off. Click the pill to preview the exact text.`}
      >
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Preview scene context for ${activeSceneTitle}`}
          className="nn-pbf-active-scene-chip-btn"
        >
          <NodeBadge nodeId={hostSceneId} nodes={projectNodes} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Stop sending scene context with prompts"
          aria-label="Remove scene context"
          className="nn-pbf-active-scene-chip-x"
        >
          ✕
        </button>
      </span>
    </div>
  )
}

export function ContextPill({ label, on, count, disabled, directionLabel, onToggle, onCountChange, noPreviewSync = false }) {
  const pillRef = useRef(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const closeTimerRef = useRef(null)
  // `noPreviewSync` suppresses the IPB editor-decoration side-effect.
  // The prompt editor's Surface Defaults pills use this — they're a
  // configuration UI for a SAVED prompt, not pointing at any live
  // editor, so they shouldn't paint preview tints over an unrelated
  // scene editor that happens to have an IPB cursor active.
  const _setContextPreview = useIpbStore((s) => s.setContextPreview)
  // Stable reference per `noPreviewSync` value so the hooks below
  // don't see a fresh function reference each render — without this,
  // the downstream useCallback / useEffect deps cycle on every render.
  const setContextPreview = useMemo(
    () => (noPreviewSync ? () => {} : _setContextPreview),
    [noPreviewSync, _setContextPreview],
  )

  // Side string used by the editor decoration plugin to compute the
  // word range. Stable per-render derivative of the immutable
  // direction prop.
  const side = directionLabel === 'BEFORE' ? 'preceding' : 'following'

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      setPopoverOpen(false)
      // Clear the editor preview tint when the hover ends — matches
      // the popover's close timing (150ms grace).
      setContextPreview(null)
    }, 150)
  }, [cancelClose, setContextPreview])
  const openNow = useCallback(() => {
    cancelClose()
    setPopoverOpen(true)
    // Paint the editor preview tint over the words that WILL be
    // sent as context. Story-accent inline range (same visual as the
    // section-mode anchor) — separate function from Ctrl+drag, this
    // is a transient hover hint that doesn't change the IPB anchor.
    // `count` is the live value: when the writer drags the slider,
    // the parent re-renders with the new count → this effect re-
    // fires through `useEffect` below.
    setContextPreview({ side, count })
  }, [cancelClose, setContextPreview, side, count])

  // Keep the preview in sync with `count` while the popover is open
  // (slider drag changes count without firing onMouseEnter again).
  useEffect(() => {
    if (popoverOpen) setContextPreview({ side, count })
  }, [popoverOpen, side, count, setContextPreview])

  // Wheel-on-pill → 1-step fine adjustment. Mirrors the slider's
  // wheel behaviour so the writer can adjust the count without
  // even moving to the popover — hovering the pill itself is enough
  // (writer spec 2026-05-27). Attached via ref + non-passive
  // `addEventListener` so `preventDefault` blocks the page-scroll
  // fallback (React 17+ makes synthetic `onWheel` listeners
  // passive — preventing default on a JSX `onWheel` is a no-op).
  useEffect(() => {
    const el = pillRef.current
    if (!el) return undefined
    function handleWheel(e) {
      if (disabled) return
      e.preventDefault()
      const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? +1 : 0
      if (dir === 0) return
      // Clamp to the slider's bounds (0-500 typical; custom typed
      // values can exceed 500 but the wheel respects the slider
      // ceiling for predictability).
      const next = Math.max(0, Math.min(500, count + dir))
      if (next !== count) onCountChange(next)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [disabled, count, onCountChange])

  // Tidy on unmount: clear timer + tear down any lingering preview
  // so unmounting the form while hovered doesn't leave the editor
  // permanently tinted.
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    setContextPreview(null)
  }, [setContextPreview])

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className={`nn-pbf-context-pill${on ? ' nn-pbf-context-pill-on' : ''}`}
        onClick={onToggle}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={scheduleClose}
        disabled={disabled}
        title={on
          ? `Including the ${count} word${count === 1 ? '' : 's'} ${directionLabel} the IPB cursor as context for the AI. Click to omit. Hover for slider.`
          : `Click to include the ${count} word${count === 1 ? '' : 's'} ${directionLabel} the IPB cursor as context for the AI. Hover for slider.`}
        aria-pressed={on}
      >
        {/* Direction-specific chunky arrow: up for "Before" (the
            context that comes BEFORE the cursor / appears above in
            the doc), down for "After" (below). On/off state is
            communicated by the pill's filled-vs-outline background;
            the arrow itself stays constant so the writer can tell
            the two pills apart at a glance. Unicode BLACK ARROW
            glyphs (U+2B06 / U+2B07) have a solid stem + arrowhead
            shape (vs. the prior bare triangles) and inherit colour
            so they track the story accent in the ON state. */}
        <span aria-hidden="true">{directionLabel === 'BEFORE' ? '⬆' : '⬇'}</span> {label} · {count}w
      </button>
      {popoverOpen && pillRef.current && (
        <ContextPillSliderPopover
          anchorEl={pillRef.current}
          count={count}
          onCountChange={onCountChange}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
          directionLabel={directionLabel}
          disabled={disabled}
        />
      )}
    </>
  )
}

export function ContextPillSliderPopover({ anchorEl, count, onCountChange, onMouseEnter, onMouseLeave, directionLabel, disabled }) {
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [editingCustom, setEditingCustom] = useState(false)
  const popoverRef = useRef(null)
  const customInputRef = useRef(null)
  const [customDraft, setCustomDraft] = useState(String(count))

  // Position once on mount + on any anchor / window-size change so
  // the popover stays above the pill across scroll / resize.
  useEffect(() => {
    if (!anchorEl) return undefined
    const reposition = () => {
      const rect = anchorEl.getBoundingClientRect()
      setPosition({
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
      })
    }
    reposition()
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
    }
  }, [anchorEl])

  // Sync the local custom-input draft with the prop value when the
  // popover is not actively being edited (slider drag updates count
  // → input should reflect it).
  useEffect(() => {
    if (!editingCustom) setCustomDraft(String(count))
  }, [count, editingCustom])

  // Focus the input when entering edit mode.
  useEffect(() => {
    if (editingCustom && customInputRef.current) {
      customInputRef.current.focus()
      customInputRef.current.select()
    }
  }, [editingCustom])

  const commitCustom = () => {
    const parsed = Number(customDraft)
    const clamped = Number.isFinite(parsed)
      ? Math.max(CONTEXT_WORD_MIN, Math.min(CONTEXT_WORD_MAX * 4, Math.round(parsed)))
      : count
    onCountChange(clamped)
    setEditingCustom(false)
  }
  const cancelCustom = () => {
    setCustomDraft(String(count))
    setEditingCustom(false)
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="nn-pbf-context-popover"
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        transform: 'translate(-50%, -100%)',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={`${directionLabel === 'BEFORE' ? 'Preceding' : 'Following'} word count`}
    >
      {/* Count display / click-to-edit input sits ABOVE the slider
          so the text "N words" doubles as the popover's header — no
          separate "Words" label needed. */}
      <div className="nn-pbf-context-popover-row">
        {editingCustom ? (
          <input
            ref={customInputRef}
            type="number"
            min={CONTEXT_WORD_MIN}
            // Allow typed values above the slider's max (writer's
            // request: custom amounts beyond the typical range). Hard
            // cap at 4× the slider max as a sanity ceiling.
            max={CONTEXT_WORD_MAX * 4}
            step={1}
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitCustom() }
              else if (e.key === 'Escape') { e.preventDefault(); cancelCustom() }
            }}
            disabled={disabled}
            className="nn-pbf-context-popover-input"
            aria-label="Custom word count"
          />
        ) : (
          <button
            type="button"
            className="nn-pbf-context-popover-count-btn"
            onClick={() => setEditingCustom(true)}
            disabled={disabled}
            title="Click to type a custom word count (can exceed the slider's 500-word range)"
          >
            {count} word{count === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <SliderWithSmartStep
        min={CONTEXT_WORD_MIN}
        max={CONTEXT_WORD_MAX}
        coarseStep={5}
        value={Math.min(count, CONTEXT_WORD_MAX)}
        onChange={onCountChange}
        disabled={disabled}
        className="nn-pbf-context-popover-slider"
      />
    </div>,
    document.body,
  )
}

// Native `<input type="range">` with TWO speed-aware mechanics layered
// on top of the standard browser drag (writer spec 2026-05-27):
//
//   1. **Wheel-over-or-mid-drag → 1-step fine.** A non-passive wheel
//      handler always increments by ±1 per tick, bypassing the snap
//      grid. Works whether the writer is hovering the slider or
//      actively dragging the thumb (the wheel event lands on the
//      slider element either way). `preventDefault` blocks page
//      scroll. React's `onWheel` is passive in React 17+ — must be
//      attached via `addEventListener` with `passive: false`.
//
//   2. **Drag speed-aware step.** The element keeps `step={1}` so the
//      browser reports every raw integer the writer's pointer
//      crosses; the `onChange` handler then decides whether to snap
//      to the coarse grid or use the raw value, based on the
//      magnitude of recent per-event deltas. Small / slow drag deltas
//      (each <= coarseStep-1) commit as fine 1-unit moves; big / fast
//      drag deltas snap to the nearest multiple of `coarseStep`. A
//      3-event hysteresis window keeps the writer in "snap mode" for
//      a few events after a fast tick, so a borderline-speed drag
//      doesn't strobe between modes. Pointerdown resets the window so
//      a fresh drag starts clean. Approach is the delta-magnitude
//      pattern from the research (2026-05-27 agent summary): no new
//      dependency, no Pointer Event rework, ~20 lines on top of the
//      native input.
function SliderWithSmartStep({ min, max, coarseStep, value, onChange, disabled, className }) {
  const ref = useRef(null)
  const lastValueRef = useRef(value)
  const recentDeltasRef = useRef([])
  // Wheel-lock + drag-state refs (writer spec 2026-05-27 — when the
  // writer wheels mid-drag for fine control, releasing the drag
  // without moving the cursor far enough to genuinely change the
  // value must NOT snap away from the wheel-set value). The browser
  // tracks cursor position independently of the controlled `value`
  // prop, so as soon as the wheel moves the value, the cursor is
  // sitting at a "stale" slider position; the next browser-fired
  // `onChange` (from the slightest cursor wiggle or the mouseup
  // itself) reports a value from THAT cursor position, undoing the
  // wheel. The lock holds the wheel value until either (a) the writer
  // releases the drag or (b) drags the cursor far enough to cross
  // `coarseStep` units away from the wheel value — i.e., a clearly
  // intentional override.
  const isDraggingRef = useRef(false)
  const wheelLockRef = useRef(null)
  // Release-freeze window. When the writer wheels mid-drag and then
  // releases, the browser ALWAYS fires one final `input` event from
  // the cursor's current pixel position (which corresponds to the
  // PRE-wheel value, since the cursor hasn't moved). That release-
  // time event has the full coarseStep gap between cursor-value and
  // wheel-value — the threshold-only suppression on `wheelLockRef`
  // would let it through. The freeze gates `handleInput` entirely
  // for a short window after the release that triggered it, so the
  // release-time cursor-position read can't overwrite the wheel
  // value regardless of how far apart they are.
  const releaseFreezeUntilRef = useRef(0)

  // Keep the ref in sync with the prop so wheel-driven changes (which
  // don't go through onChange below) don't desync the snap logic's
  // "previous value" baseline.
  useEffect(() => { lastValueRef.current = value }, [value])

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    function handleWheel(e) {
      if (disabled) return
      e.preventDefault()
      const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? +1 : 0
      if (dir === 0) return
      const next = Math.max(min, Math.min(max, value + dir))
      if (next === value) return
      onChange(next)
      if (isDraggingRef.current) {
        // Wheel happened DURING a drag — engage the lock so the
        // browser's next cursor-derived onChange (which will report
        // a value based on cursor position, NOT this wheel value)
        // doesn't immediately overwrite the wheel adjustment.
        wheelLockRef.current = next
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [disabled, min, max, value, onChange])

  const handleInput = (e) => {
    // Release-freeze: if the writer just released after wheel-mid-
    // drag, suppress ALL onChange events for a short window so the
    // browser's release-time cursor-derived event (regardless of
    // its value) can't overwrite the wheel-set value.
    if (performance.now() < releaseFreezeUntilRef.current) {
      return
    }
    const raw = Number(e.target.value)
    // Wheel-lock check: if the writer wheeled mid-drag, ignore
    // drag-induced onChange events whose raw value is within
    // `coarseStep` of the wheel-set value (the cursor is just
    // sitting where it was when the wheel fired — that's not a
    // deliberate override). Once the cursor moves far enough to
    // cross the threshold, release the lock and accept the new
    // value via the normal snap path.
    if (wheelLockRef.current !== null) {
      if (Math.abs(raw - wheelLockRef.current) < coarseStep) {
        return
      }
      wheelLockRef.current = null
    }
    const prev = lastValueRef.current
    const delta = Math.abs(raw - prev)
    // Hysteresis window — last 3 deltas. If any recent tick was a
    // big jump, stay in snap mode for the next couple ticks so a
    // borderline-speed drag reads cleanly. Without this, fast drag
    // ticks (delta 5+) and slow trailing ticks (delta 1-2) would
    // alternate the value between "60" and "63" as the writer's
    // hand decelerates.
    const recent = recentDeltasRef.current
    recent.push(delta)
    if (recent.length > 3) recent.shift()
    const maxRecent = Math.max(...recent, 0)
    let next
    if (maxRecent >= coarseStep) {
      // Big / fast move (now or recently) → snap to nearest
      // multiple of `coarseStep`. Math.round vs Math.floor: round
      // is closer to writer intent — landing nearest, not
      // truncating downward.
      next = Math.round(raw / coarseStep) * coarseStep
    } else {
      // Small / slow move → keep the raw 1-step value for fine
      // adjustments.
      next = raw
    }
    next = Math.max(min, Math.min(max, next))
    lastValueRef.current = next
    if (next !== prev) onChange(next)
  }

  const handlePointerDown = () => {
    // Each fresh drag starts with an empty hysteresis window + no
    // wheel lock, so a long-paused-then-resumed slow drag isn't
    // classified as "fast" because of stale deltas from the
    // previous gesture.
    recentDeltasRef.current = []
    wheelLockRef.current = null
    isDraggingRef.current = true
    // Document-level pointerup so the drag-end is detected even if
    // the writer releases the mouse outside the slider element
    // (common during fast drags). On release, the wheel lock is
    // cleared — the post-release "settled" value is whatever the
    // controlled `value` prop currently holds, which is exactly
    // the wheel-set value (or the latest accepted drag value).
    // On release: if the writer wheel-tuned mid-drag, arm a release-
    // freeze window. Browser fires one final `input` event reading
    // the cursor's pixel position (which is the PRE-wheel position
    // since the cursor never moved during the wheel adjustment); the
    // freeze suppresses that event entirely so the wheel-set value
    // survives the release. 150ms is long enough to absorb the
    // release-tick + any tail input events but short enough that the
    // next deliberate interaction isn't blocked.
    const onUp = () => {
      isDraggingRef.current = false
      if (wheelLockRef.current !== null) {
        releaseFreezeUntilRef.current = performance.now() + 150
      }
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointerup', onUp)
  }

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      onChange={handleInput}
      onPointerDown={handlePointerDown}
      disabled={disabled}
      className={className}
    />
  )
}
