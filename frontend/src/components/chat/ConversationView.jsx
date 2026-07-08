import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../store/settingsStore'
import { useSystemPromptsStore } from '../../store/systemPromptsStore'
import { useConversationsStore, newMessageId } from '../../store/conversationsStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore, getLiveStoryEntitiesShape } from '../../store/entitiesStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { tiptapHtmlToPlain } from '../../utils/tiptapToMarkdown'
import { findSectionContent, findSectionHostInfo } from '../../utils/findSectionContent'
import { useUiStore } from '../../store/uiStore'
import { confirm as confirmDialog } from '../../store/dialogStore'
import { streamChat } from '../../services/chatClient'
import ToolUseButton from './ToolUseButton'
import { buildSceneContextBlock } from '../../utils/sceneContextPrompt'
import { assembleCharacterChatSystemMessage } from '../../utils/assembleCharacterChatSystemMessage'
import { hashAnchorSpec, formatAnchorSpan, buildCharacterPersonaSnapshot } from '../../utils/characterChatAnchorMeta'
import { buildStoryScopeAppendage } from '../../utils/storyScopePrompt'
import { buildStoryScopeBundle } from '../../utils/storyScopeBundleBuilder'
import { buildWireMessages, computeContextDiff, getContextAtMessage } from '../../utils/chatContextHistory'
import { preconfiguredMessageHistoryWireTurns } from '../../utils/preconfiguredMessageHistory'
import {
  computeEffectiveState,
  computeEffectiveStateWithPrior,
  computeKnowledgeEffectiveState,
  computeRelationshipEffectiveState,
  getEntityNarrativeChain,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
} from '../../utils/narrativeChain'
import { getOrComputeStoryOrderFromStore } from '../../hooks/useStoryOrder'
import { useAccentColor } from '../../utils/povConstants'
import { isDefaultEntityColour, ENTITY_BUCKETS, TYPE_ICONS } from '../../utils/entityHelpers'
import { resolveRelationshipLabel } from '../../utils/buildRelationshipRows'
import { NodeBadge, RelationshipLabelChip, RelationshipIcon, KnowledgeIcon, CueLabelChip, ConceptLabelChip, EntityAvatar } from '../ui/IdentityBadges'
import { useEntityById } from '../../hooks/useEntityById'
import EntityPickerPopover from '../entities/EntityPickerPopover'
import KnowledgePickerPopover from '../entities/KnowledgePickerPopover'
import RelationshipPickerPopover from '../entities/RelationshipPickerPopover'
import StoryScopeControls from './StoryScopeControls'
import SystemPromptPreviewModal from './SystemPromptPreviewModal'
import CharacterChatSetupModal from './CharacterChatSetupModal'
import ChainRangeSelectorModal from './ChainRangeSelectorModal'
import {
  analyzeCommitConsequences,
  formatConsequencesMessage,
  applyConsequences,
  reconcileRangePinsAgainstChain,
  applyRangePinReconciliation,
} from '../../utils/pinnedContextMerge'
import { confirm as openConfirmDialog } from '../../store/dialogStore'
import { useIsChatOpenOnConversation } from '../../hooks/useIsChatOpenOnConversation'
import MessageBubble, { MarkdownBody } from './MessageBubble'
import ChatComposerTipTapInput from './ChatComposerTipTapInput'
import DynamicBoltIcon from '../ui/DynamicBoltIcon'
import { useDynamicPillFlash } from '../../utils/useDynamicPillFlash'
import { applyPromptOnPick } from '../../utils/applyPromptOnPick'
import DynamicMarkerPickerPanel from './DynamicMarkerPickerPanel'
import PinRow from '../ui/PinRow'
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import AutoAttachToggle, { ChatAutoAttachStandaloneButton } from './AutoAttachToggle'
import { buildStoryWideNameTargets } from '../ui/EntityHighlightPlugin'
import EntityHoverPreview from '../ui/EntityHoverPreview'
import CapabilityBadges from '../ui/CapabilityBadges'
import SystemPromptPickerList from '../ui/SystemPromptPickerList'
import ConnectionModelPickerList from '../ui/ConnectionModelPickerList'
import PaperclipButton from './PaperclipButton'
import AttachedFileChips from './AttachedFileChips'
import ReasoningButton from './ReasoningButton'
import WirePayloadPreviewModal from './WirePayloadPreviewModal'
import { useActiveModelCapabilities } from '../../hooks/useActiveModelCapabilities'
import { makeAttachmentRecord, validateAttachment } from '../../utils/attachmentTypes'
import { encodeAttachmentsForWire } from '../../utils/attachmentEncoding'

/**
 * Conversation view — Phase 2.4c.
 *
 * The chat panel's main UI when a thread is open. Top bar +
 * scrollable history + input row. Sending writes both messages to
 * disk via the conversations store; the assistant turn is streamed
 * in tokens via the chat client, with the on-disk copy patched at
 * stream end so refreshing the page never loses the response.
 *
 * Minimal-2.4c scope:
 *   - Top bar: thread name (display only — rename lands later),
 *     small AI Settings shortcut.
 *   - History area: scrollable list of message bubbles + a
 *     scroll-to-bottom affordance when the writer has scrolled
 *     up.
 *   - Input row: multi-line textarea + Send/Cancel button.
 *
 * Deferred to later commits:
 *   - 2.4c: ← Conversations back button, rename inline, profile
 *     dropdown / model picker / system-prompt indicator on the top
 *     bar (all gated on the thread browser landing in 2.4f).
 *   - 2.4d: markdown rendering, hover actions, overflow menu.
 *   - 2.4e: active context strip + scene context toggle + attach
 *     file + context window stepper in the input area.
 *   - 2.4g: pinned messages strip.
 */
export default function ConversationView({ threadId }) {
  const prefs              = useSettingsStore((s) => s.preferences)
  const thread             = useConversationsStore((s) => s.byId[threadId] || null)
  const openThread         = useConversationsStore((s) => s.openThread)
  const appendMessage      = useConversationsStore((s) => s.appendMessage)
  const appendLocalMessage = useConversationsStore((s) => s.appendLocalMessage)
  const updateLocalMessage = useConversationsStore((s) => s.updateLocalMessage)
  const persistPatch       = useConversationsStore((s) => s.persistMessagePatch)
  const deleteMessageAct   = useConversationsStore((s) => s.deleteMessage)
  const updateThread       = useConversationsStore((s) => s.updateThread)
  const createThread       = useConversationsStore((s) => s.createThread)
  const lastError          = useConversationsStore((s) => s.lastError)

  // Conversation-level markdown render mode. Layer 1 of the three-
  // tier override system; per-message overrides + per-code-block
  // toggles live in MessageBubble. Default is 'rendered' (markdown).
  // The toggle that flips this value lives in the unified ChatPanel
  // header (see `ChatHeader` in ChatPanel.jsx); here we just read
  // the resolved mode to forward into each bubble.
  const conversationRenderMode = thread?.render_mode || 'rendered'
  // Stable reference so MessageBubble's `React.memo` prop check
  // doesn't false-fire on every parent render.
  const setMessageRenderMode = useCallback((messageId, mode) => {
    // `mode` is 'rendered' | 'raw' | null. null clears the per-
    // message override so the message follows the conversation
    // default again.
    persistPatch(threadId, messageId, {
      render_mode: mode === null ? '__clear__' : mode,
    })
  }, [persistPatch, threadId])

  const systemPrompts      = useSystemPromptsStore((s) => s.prompts)
  const loadSystemPrompts  = useSystemPromptsStore((s) => s.loadPrompts)
  useEffect(() => { loadSystemPrompts() }, [loadSystemPrompts])

  // Fetch the thread on mount / when threadId changes. Optimistic
  // local state may already have it (createThread seeds byId) but
  // openThread is idempotent and no-ops in that case.
  useEffect(() => {
    if (threadId) openThread(threadId)
  }, [threadId, openThread])

  // Phase 2.7b Q9 — stale-anchor auto-detach + Phase 2.10 Bug 4 —
  // stale-static-story-id auto-strip. Combined into one effect that
  // runs on (a) thread open / change, (b) story switch while this
  // thread is the active one. Lazy-strip per Bug 4 design: only the
  // currently-open thread's bucket is walked; dormant threads' pins
  // wait until those threads are next opened (no upfront cost on
  // story-switch for closed threads).
  //
  // Two staleness checks combined:
  //   - Anchor-stale (Phase 2.7b): pin's `anchor_node_id` or
  //     `anchor_range` endpoints no longer resolve to any canvas node.
  //   - Story-stale (Phase 2.10 Bug 4): static pin's `(kind, id)`
  //     doesn't resolve in the loaded story. Strips entity / knowledge
  //     / relationship / scene pins whose id is gone, and all
  //     `section` pins (their refs are essentially story-scoped via
  //     their scene/entity-notes/knowledge-notes host). Cue pins are
  //     program-level (live in `context_cues/` at program root, survive
  //     story switches) — never strip. Freetext pins carry no story
  //     id — never strip. Dynamic pins (pin_kind === 'dynamic') always
  //     survive; they re-resolve naturally and the `useDynamicPillFlash`
  //     hook fires on the targetKey change (which now incorporates
  //     story.id where appropriate).
  //
  // Writer sees one fewer pill than they last pinned (rather than a
  // broken-state badge) on thread open / story switch.
  const storyIdForStrip = useProjectStore((s) => s.story?.id || null)
  useEffect(() => {
    if (!threadId) return
    const surfaceKey = `chat:${threadId}`
    const pinStore = usePinnedContextStore.getState()
    const list = pinStore.getPins(surfaceKey)
    if (list.length === 0) return
    const ps = useProjectStore.getState()
    const nodes = ps.nodes || []
    const nodeIds = new Set(nodes.map((n) => n.id))
    // Build (kind, id) resolver lookups for the loaded story state.
    const story = ps.story || {}
    const entityIds = new Set()
    for (const bucket of ENTITY_BUCKETS) {
      for (const e of (story.entities?.[bucket] || [])) {
        if (e?.id) entityIds.add(e.id)
      }
    }
    const knowledgeIds = new Set((ps.knowledges || []).map((k) => k?.id).filter(Boolean))
    const relationshipIds = new Set((ps.relationships || []).map((r) => r?.id).filter(Boolean))
    // Concept pins are `referenceNode`s (sub_type 'concept') on the canvas, so
    // unlike a program-level cue they CAN be deleted with the story and need
    // stale-sweeping when the thread opens / the story switches.
    const conceptIds = new Set(
      nodes.filter((n) => n.type === 'referenceNode' && n.data?.sub_type === 'concept').map((n) => n.id)
    )
    for (const item of list) {
      if (!item) continue
      // Anchor-stale check first (cheap, applies regardless of kind).
      if (item.anchor_range) {
        const startGone = !nodeIds.has(item.anchor_range.start_node_id)
        const endGone = !nodeIds.has(item.anchor_range.end_node_id)
        if (startGone || endGone) {
          pinStore.removePin(surfaceKey, item.sessionId)
          continue
        }
      } else if (item.anchor_node_id && !nodeIds.has(item.anchor_node_id)) {
        pinStore.removePin(surfaceKey, item.sessionId)
        continue
      }
      // Story-stale check for static pins. Dynamic pins survive
      // unconditionally; they re-resolve against whatever's loaded.
      if (item.pin_kind === 'dynamic') continue
      let storyStale = false
      if (item.kind === 'entity' && item.id && !entityIds.has(item.id)) storyStale = true
      else if (item.kind === 'knowledge' && item.id && !knowledgeIds.has(item.id)) storyStale = true
      else if (item.kind === 'relationship' && item.id && !relationshipIds.has(item.id)) storyStale = true
      else if (item.kind === 'scene' && item.id && !nodeIds.has(item.id)) storyStale = true
      else if (item.kind === 'section') storyStale = true  // section refs are story-scoped via their host
      else if (item.kind === 'toc' && item.id && item.id !== storyIdForStrip) storyStale = true
      else if (item.kind === 'concept' && item.id && !conceptIds.has(item.id)) storyStale = true
      // 'cue' and 'freetext' always survive.
      if (storyStale) {
        pinStore.removePin(surfaceKey, item.sessionId)
      }
    }
  }, [threadId, storyIdForStrip])

  const accent = useAccentColor() || '#7c3aed'

  // Phase 2.8 — name-highlight pipeline for the chat TipTap input.
  // Pulls store slices via Zustand selectors so changes to the
  // story's entities / knowledges / relationships / cues, or to
  // the writer's flyout filter / master toggle, recompute the
  // target list and trigger a TipTap decoration refresh. No chain
  // anchor is involved (chat input is a meta tool — see
  // `buildStoryWideNameTargets` doc).
  const chatHighlightNamesEnabled = useUiStore((s) => s.chatHighlightNamesEnabled)
  const chatAutoAttachTypes = useUiStore((s) => s.chatAutoAttachTypes)
  const charactersForHighlight = useEntitiesStore((s) => s.characters)
  const locationsForHighlight = useEntitiesStore((s) => s.locations)
  const itemsForHighlight = useEntitiesStore((s) => s.items)
  const factionsForHighlight = useEntitiesStore((s) => s.factions)
  const customsForHighlight = useEntitiesStore((s) => s.customs)
  const knowledgesForHighlight = useProjectStore((s) => s.knowledges)
  const relationshipsForHighlight = useProjectStore((s) => s.relationships)
  // `nodesForHighlight` + `edgesForHighlight` let the builder walk
  // each object's narrative chain so each emitted name target is
  // tagged with the colour / profile image that were effective at
  // the chain stop where that name first appeared. Without these,
  // baseline colour would be used uniformly for every name —
  // including chain renames whose accompanying colour change the
  // writer expects to track.
  const nodesForHighlight = useProjectStore((s) => s.nodes)
  const edgesForHighlight = useProjectStore((s) => s.edges)
  const cuesForHighlight = useContextCuesStore((s) => s.cues)
  const chatNameTargets = useMemo(() => buildStoryWideNameTargets(
    chatAutoAttachTypes,
    {
      entities: {
        characters: charactersForHighlight,
        locations: locationsForHighlight,
        items: itemsForHighlight,
        factions: factionsForHighlight,
        customs: customsForHighlight,
      },
      project: {
        knowledges: knowledgesForHighlight,
        relationships: relationshipsForHighlight,
        nodes: nodesForHighlight,
        edges: edgesForHighlight,
      },
      cues: { cues: cuesForHighlight },
    },
  ), [
    chatAutoAttachTypes,
    charactersForHighlight, locationsForHighlight, itemsForHighlight,
    factionsForHighlight, customsForHighlight,
    knowledgesForHighlight, relationshipsForHighlight,
    nodesForHighlight, edgesForHighlight, cuesForHighlight,
  ])

  // Phase 2.11b item 13 — chain-resolved character persona snapshot
  // for character-mode chat bubbles. One snapshot per render, shared
  // across every assistant bubble in the thread; the bubble component
  // branches on `characterPersona !== null` to swap in the chain-
  // resolved name + colour + avatar. Recomputes whenever the
  // thread's character_chat metadata changes (including a re-anchor)
  // or the underlying entity / node / edge state changes. Returns
  // null on regular threads — bubbles render byte-for-byte as today.
  const characterPersona = useMemo(() => {
    return buildCharacterPersonaSnapshot(
      thread?.character_chat || null,
      charactersForHighlight,
      nodesForHighlight,
      edgesForHighlight,
    )
  }, [thread?.character_chat, charactersForHighlight, nodesForHighlight, edgesForHighlight])

  // Phase 2.12 — two persona snapshots for two-character chats. One
  // per character at their OWN latest anchor. `twoCharPersonas.char1`
  // = Character 1 (assistant-side, always left); `.char2` = Character
  // 2 (user-side, always right). Bubble lookup is by
  // `speaker_character_id`, NOT by message role: the bubble renderer
  // (see the message map below) reads `m.speaker_character_id` and
  // picks the matching persona. UI position is then fixed by which
  // character the persona belongs to, never by which role label the
  // wire-builder synthesised for the outgoing turn.
  // Returns null in regular + single-character chats; the message
  // map below also passes null in those cases so `MessageBubble`
  // renders byte-for-byte as today.
  const twoCharPersonas = useMemo(() => {
    const twoMeta = thread?.two_character_chat || null
    if (!twoMeta || !Array.isArray(twoMeta.characters) || twoMeta.characters.length !== 2) return null
    const char1Meta = twoMeta.characters[0]
    const char2Meta = twoMeta.characters[1]
    if (!char1Meta || !char2Meta) return null
    return {
      char1: buildCharacterPersonaSnapshot(char1Meta, charactersForHighlight, nodesForHighlight, edgesForHighlight),
      char2: buildCharacterPersonaSnapshot(char2Meta, charactersForHighlight, nodesForHighlight, edgesForHighlight),
    }
  }, [thread?.two_character_chat, charactersForHighlight, nodesForHighlight, edgesForHighlight])

  // Phase 2.12f — composer mode for two-character chats.
  // Two layers, per the backend model docstring:
  //   * `composer_mode` persisted on the thread: 'single' | 'dual'
  //     (the writer's preferred MANUAL mode).
  //   * `twoCharAutoMode` session-local boolean: auto-send overlay
  //     layered on top of the manual mode. Not persisted — reverts
  //     to the saved manual mode when the writer stops it or
  //     switches threads.
  // The cycle pip exposes three effective states (Single → Dual →
  // Auto → Single):
  //   * Single → persist `composer_mode = 'single'`, auto OFF.
  //   * Dual   → persist `composer_mode = 'dual'`,   auto OFF.
  //   * Auto   → leave persisted mode alone, set auto ON.
  // The Send-column UI gates entirely on the effective mode and
  // `thread.two_character_chat` so regular + single-character chats
  // render byte-for-byte as today (Rule 4).
  const [twoCharAutoMode, setTwoCharAutoMode] = useState(false)
  // Auto-send counter — default 10 per the ToDo spec; freely editable
  // by the writer at any time (including during an active loop).
  // Decrements once per LLM call (counts both characters' turns —
  // each round contributes 2 to the decrement). Reaches 0 → loop
  // stops and reverts to the saved manual mode.
  const [autoSendCount, setAutoSendCount] = useState(10)
  // `autoSendActive` is the "loop is running right now" flag. The
  // effect below drives the loop: whenever it's true, the loop fires
  // the next turn each time streaming wraps up, until the counter
  // hits 0 or the writer clicks Stop.
  const [autoSendActive, setAutoSendActive] = useState(false)
  // Auto state is session-local and per-thread — switching threads
  // should reset to manual so the writer doesn't end up auto-sending
  // the moment a different two-character thread opens.
  useEffect(() => {
    setTwoCharAutoMode(false)
    setAutoSendActive(false)
    setAutoSendCount(10)
  }, [threadId])
  const persistedComposerMode = useMemo(() => {
    const twoMeta = thread?.two_character_chat || null
    if (!twoMeta) return 'single'
    return twoMeta.composer_mode === 'dual' ? 'dual' : 'single'
  }, [thread?.two_character_chat])
  const composerMode = twoCharAutoMode ? 'auto' : persistedComposerMode

  // Phase 2.12f — derive whoever spoke last in the two-character
  // thread. Used to (a) put the Enter-key marker on the OTHER
  // character's button in dual mode and (b) light the Single-mode
  // button title with whose turn it is. Walks history backwards
  // for the most recent `speaker_character_id`; empty thread →
  // Character 1 speaks next (matches the wire path's default).
  const twoCharTurnInfo = useMemo(() => {
    if (!twoCharPersonas) return null
    const char1Id = twoCharPersonas.char1?.synthEntity?.id || null
    const char2Id = twoCharPersonas.char2?.synthEntity?.id || null
    if (!char1Id || !char2Id) return null
    const msgs = thread?.messages || []
    let lastSpeaker = null
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i]
      const sid = m?.speaker_character_id
      if (sid === char1Id || sid === char2Id) {
        lastSpeaker = sid
        break
      }
    }
    const nextSpeaker = lastSpeaker === char1Id ? char2Id : char1Id
    return { char1Id, char2Id, lastSpeaker, nextSpeaker }
  }, [twoCharPersonas, thread?.messages])

  const cycleComposerMode = useCallback(() => {
    if (!thread?.two_character_chat) return
    // Cycle: single → dual → auto → single. Single and Dual persist
    // to the backend's `composer_mode` field; Auto is a session-only
    // overlay that doesn't touch the persisted shape.
    const meta = thread.two_character_chat
    if (composerMode === 'single') {
      setTwoCharAutoMode(false)
      updateThread(thread.id, {
        two_character_chat: { ...meta, composer_mode: 'dual' },
      })
    } else if (composerMode === 'dual') {
      setTwoCharAutoMode(true)
    } else {
      // 'auto' → back to Single. Persist the manual mode AND clear
      // the auto overlay. (If the saved manual mode is already
      // 'single' the PUT is a no-op shape-wise but still cheap.)
      setTwoCharAutoMode(false)
      if (meta.composer_mode !== 'single') {
        updateThread(thread.id, {
          two_character_chat: { ...meta, composer_mode: 'single' },
        })
      }
    }
  }, [thread, composerMode, updateThread])

  // Phase 2.8 — auto-attach detection scanner. Watches `prompt`
  // and, with a debounce so prefix-of-a-word matches don't pre-
  // attach mid-word (e.g. "Abl" → "Able" — the timer resets on
  // every keystroke), fires `addPinnedContextItem` for every
  // matched name in the input. Gated by both the master toggle
  // (highlight names) AND the flyout subtoggle (auto-attach as
  // context). Ambiguous matches attach ALL colliding objects;
  // the store's own dedup prevents re-attaching the same id on
  // subsequent scans. Pills, once attached, stay until the writer
  // manually removes them via the ✕ on the chip (text-delete pill
  // flash is a separate pending todo).
  const chatAutoAttachEnabled = useUiStore((s) => s.chatAutoAttachEnabled)
  const addPin = usePinnedContextStore((s) => s.addPin)
  const flashChatPill = useUiStore((s) => s.flashChatPill)

  const [prompt, setPrompt]     = useState('')

  // ToDo item 163 — Preview Message state. The Send and Preview
  // operations share the same `sendText` code path; preview just
  // routes the assembled payload to `setPreviewPayload` instead of
  // streamChat. Opening / mode-toggling sets `previewOpen` and
  // `previewMode`; an effect re-fires sendText whenever those
  // change while open. `previewDraft` is a snapshot captured at
  // open-time so subsequent typing in the composer doesn't mutate
  // what the modal is previewing (the writer's draft in the
  // composer is NOT cleared by previewing — `setPrompt('')` only
  // fires in the Send wrapper, not in sendText itself).
  const [previewOpen, setPreviewOpen]     = useState(false)
  const [previewDraft, setPreviewDraft]   = useState('')
  const [previewMode, setPreviewMode]     = useState('with-history')
  const [previewPayload, setPreviewPayload] = useState(null)

  // Phase 2.12g — Re-anchor modal state. Open state is paired with a
  // target descriptor:
  //   * `{ kind: 'single' }`             — re-anchor a single-character
  //                                        chat's `character_chat` meta.
  //   * `{ kind: 'twoChar', charIdx: N }` — re-anchor one slot of a
  //                                        two-character chat's
  //                                        `two_character_chat
  //                                        .characters[charIdx]`.
  // The gear popover's Re-anchor button(s) signal up via the
  // `onRequestReanchor(target)` prop on the toolbar row and set this
  // state. The modal mount picks `initialMeta` from the matching
  // slot and the confirm handler writes it back in place.
  const [reanchorTarget, setReanchorTarget] = useState(null)

  // Tracks the set of (kind, id) keys the scanner matched in its
  // previous pass. On the next scan, any key in prev but not in
  // current → "the writer deleted a name that we'd auto-attached"
  // → fire a pill flash on that pill as a reminder it's still
  // attached (per the spec: pills stay until manually removed).
  const prevMatchedKeysRef = useRef(new Set())

  // Auto-attach matcher — the regex + lookup map the scanner uses
  // to detect entity / cue / knowledge / relationship names in the
  // composer's prompt text. Memoised on `chatNameTargets` (and
  // gated on `chatAutoAttachEnabled` so we don't pay the build cost
  // when the feature is off). Previously these structures were
  // rebuilt inside the debounce setTimeout body on every typing
  // pause; now they only rebuild when the underlying name-target
  // list actually changes (which happens when the writer adds /
  // renames / deletes an entity, cue, knowledge, or relationship).
  // Sorting by descending name length is the same trick the
  // highlighter uses so a longer match like "Mina Murray" wins
  // over the alias "Mina" when both are present.
  const autoAttachMatcher = useMemo(() => {
    if (!chatAutoAttachEnabled || !chatNameTargets.length) return null
    const sorted = [...chatNameTargets].sort((a, b) => b.name.length - a.name.length)
    const escaped = sorted.map((x) => x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
    // Group targets by lowercased name so ambiguous matches
    // surface ALL colliding objects for attach.
    const lookup = new Map()
    for (const x of chatNameTargets) {
      const k = x.name.toLowerCase()
      const arr = lookup.get(k) || []
      arr.push(x)
      lookup.set(k, arr)
    }
    return { regex, lookup }
  }, [chatAutoAttachEnabled, chatNameTargets])

  // Core auto-attach scan, extracted so it can run BOTH on the
  // typing-pause debounce AND synchronously on send. The send-path
  // flush is what saves a name typed in the last 500ms before the
  // writer hits Enter: without it the pending debounce is cancelled
  // (prompt clears / unmount) and the name never attaches before the
  // wire is built.
  //
  // For each FULL match in `text`, attaches a pin for every target the
  // match resolves to (ambiguous matches attach ALL colliding objects,
  // per the design decision); the store's own duplicate check makes a
  // re-typed already-pinned name a no-op. A freshly-detected name
  // flashes its pill. The scan also diffs against the previous-pass key
  // set in `prevMatchedKeysRef`: a key matched last pass but not this
  // one means the writer just deleted that name from the input — if its
  // pill is still pinned we flash it as a "still attached" reminder.
  const runAutoAttachScan = useCallback((text) => {
    if (!chatAutoAttachEnabled) {
      prevMatchedKeysRef.current = new Set()
      return
    }
    const currentKeys = new Set()
    if (text && autoAttachMatcher) {
      const { regex, lookup } = autoAttachMatcher
      // Regex carries the `/g` flag so `lastIndex` is stateful; reset
      // before each scan because the same regex instance is reused
      // across calls (persisted by the `autoAttachMatcher` useMemo).
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(text)) !== null) {
        const matchKey = m[0].toLowerCase()
        const matchedTargets = lookup.get(matchKey)
        if (!matchedTargets) continue
        for (const target of matchedTargets) {
          // Map `entityType` (character / location / item / faction /
          // custom / knowledge / relationship / cue) to the pin kind;
          // entity subtypes all collapse to 'entity'.
          let kind
          if (target.entityType === 'cue') kind = 'cue'
          else if (target.entityType === 'knowledge') kind = 'knowledge'
          else if (target.entityType === 'relationship') kind = 'relationship'
          else kind = 'entity'
          const k = `${kind}:${target.entityId}`
          if (currentKeys.has(k)) continue
          currentKeys.add(k)
          addPin(`chat:${threadId}`, { kind, id: target.entityId })
          if (!prevMatchedKeysRef.current.has(k)) {
            flashChatPill(kind, target.entityId)
          }
        }
      }
    }
    const pinned = usePinnedContextStore.getState().getPins(`chat:${threadId}`)
    const pinnedKeys = new Set(pinned.map((p) => `${p.kind}:${p.id}`))
    for (const prevKey of prevMatchedKeysRef.current) {
      if (currentKeys.has(prevKey)) continue
      if (!pinnedKeys.has(prevKey)) continue
      const idx = prevKey.indexOf(':')
      if (idx < 0) continue
      const kind = prevKey.slice(0, idx)
      const id = prevKey.slice(idx + 1)
      flashChatPill(kind, id)
    }
    prevMatchedKeysRef.current = currentKeys
  }, [chatAutoAttachEnabled, autoAttachMatcher, addPin, flashChatPill, threadId])

  // Debounced auto-attach scanner (typing pauses). Each keystroke
  // resets the 500ms timer so mid-word prefix matches don't fire
  // premature attaches (e.g. typing "Abl" → "Able": the "Abl" alias
  // match never fires because the writer types "e" before the settle).
  // The settled text is scanned by `runAutoAttachScan`; `send` flushes
  // the same scan synchronously so a name typed inside this window
  // isn't missed.
  useEffect(() => {
    if (!chatAutoAttachEnabled) {
      prevMatchedKeysRef.current = new Set()
      return
    }
    const t = setTimeout(() => runAutoAttachScan(prompt), 500)
    return () => clearTimeout(t)
  }, [prompt, chatAutoAttachEnabled, runAutoAttachScan])

  // Relationship + faction auto-attach. A relationship is auto-pinned
  // when at least TWO of its participants are "present" in the chat,
  // where present means: pinned as an entity (works in ANY chat), OR
  // the chat's own character in a character chat (it is implicitly in
  // the conversation). So:
  //   - General chat: pin two entities that share a relationship and
  //     that relationship attaches itself.
  //   - Character chat: pinning one entity the chat character shares a
  //     relationship with attaches it (the character is the second
  //     present participant) — preserving the original behaviour.
  // For a faction-membership relationship the faction entity is pinned
  // too (the dossier renders it by name). Gated on the per-type
  // Relationships / Factions auto-attach toggles. Watches the pin SET
  // so it covers every attach path; the already-pinned dedup keeps the
  // re-render loop terminating (a newly-pinned relationship/faction is
  // skipped on the next pass).
  const _chatPinsForRelAutoAttach = usePinnedContextStore((s) => (threadId ? (s.surfaces[`chat:${threadId}`] || _EMPTY_PINS) : _EMPTY_PINS))
  // Relationships already auto-attached for the CURRENT trigger state, so a
  // relationship the writer deliberately removed is NOT force-re-added while
  // its participants stay pinned. Cleared per relationship when it drops
  // below two present participants, so re-pinning a participant re-triggers a
  // fresh auto-attach. (We ADD when the triggering entity is added; we never
  // enforce the relationship's presence.)
  const _relAutoAttached = useRef(new Set())
  useEffect(() => { _relAutoAttached.current = new Set() }, [threadId])
  useEffect(() => {
    if (!threadId) return
    const types = useUiStore.getState().chatAutoAttachTypes || {}
    if (!types.relationship) return // relationship auto-attach must be on
    const th = useConversationsStore.getState().byId[threadId]
    const charId = th?.character_chat?.character_id || null
    const pins = usePinnedContextStore.getState().getPins(`chat:${threadId}`)
    const rels = useProjectStore.getState().relationships || []
    const hasPin = (kind, id) => pins.some((p) => p.kind === kind && p.id === id)
    const relHasEntity = (r, eid) => {
      if (!r || !eid) return false
      if (Array.isArray(r.participants) && r.participants.some((p) => (p?.entity_id || p) === eid)) return true
      if (r.participant_roles && typeof r.participant_roles === 'object' && eid in r.participant_roles) return true
      // Participants are recorded as `join` events on the relationship's
      // history. A freshly created relationship has NO base mirror
      // (`participant_roles` is unset) — its participants live ONLY on
      // history.participant_changes join events — so this is the check
      // that actually matches them. Without it the baseline checks above
      // return false for any in-session-created relationship.
      const pc = r.history && r.history.participant_changes
      if (Array.isArray(pc) && pc.some((c) => c && c.action === 'join' && c.entity_id === eid)) return true
      return false
    }
    // "Present" participants: every pinned entity, plus the chat
    // character (implicitly in the conversation in a character chat).
    const present = new Set(pins.filter((p) => p.kind === 'entity' && p.id).map((p) => p.id))
    if (charId) present.add(charId)
    const seen = _relAutoAttached.current
    for (const r of rels) {
      let count = 0
      for (const id of present) {
        if (relHasEntity(r, id)) count++
        if (count >= 2) break
      }
      if (count < 2) {
        // Trigger no longer holds — forget it so re-adding a participant
        // later re-triggers a fresh auto-attach.
        seen.delete(r.id)
        continue
      }
      // Trigger holds. Auto-attach ONCE; if the writer has since removed the
      // pill, `seen` remembers and we do NOT force it back.
      if (!seen.has(r.id) && !hasPin('relationship', r.id)) {
        addPin(`chat:${threadId}`, { kind: 'relationship', id: r.id, source: 'prompt' })
        const factionId = r.membership_of
        if (factionId && types.faction && !hasPin('entity', factionId)) {
          addPin(`chat:${threadId}`, { kind: 'entity', id: factionId, source: 'prompt' })
        }
      }
      seen.add(r.id)
    }
  }, [_chatPinsForRelAutoAttach, threadId, addPin])

  const [streaming, setStreaming] = useState(false)
  const [error, setError]       = useState(null)
  const abortRef                = useRef(null)
  const streamingMessageIdRef   = useRef(null)

  // Magnetic auto-scroll. When the toggle is on AND the writer is
  // already pinned to the bottom, the panel snaps along as new
  // tokens stream in. As soon as they scroll up, the pinned flag
  // drops and the panel stops fighting their reading; scrolling
  // back down re-engages. When the toggle is off, scroll position
  // is left strictly under writer control. Toggle state lives on
  // user_preferences so it persists across sessions.
  const autoScroll = prefs.chat_auto_scroll !== false
  const listRef = useRef(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  // Phase 2.5i — latest prompt-cache hit count from the most recent
  // assistant turn. Session-only, not persisted on the thread. Set
  // from the `end` event's `cached_input_tokens` field; rendered as
  // a small subtle indicator at the bottom-left of the bubble area.
  // Three values:
  //   * positive integer  → "cached: N tokens" (cache hit)
  //   * `0`               → "first send" / no cache hit (e.g. prompt
  //                         below the upstream's minimum, or first
  //                         send of this thread)
  //   * `null`            → indicator hidden (no data yet, or adapter
  //                         doesn't report — e.g. LM Studio)
  const [latestCachedTokens, setLatestCachedTokens] = useState(null)
  // Phase 2.5d — id of the user message whose attached-context
  // modal is currently open, or null when no modal is up. Lets a
  // single AttachedContextModal instance handle every per-message
  // "view context" affordance in the chat view.
  const [viewContextMessageId, setViewContextMessageId] = useState(null)
  // Phase 2.5e — attachment-rejection messages are routed through
  // the app-wide `transientAlert` banner in uiStore so the chat
  // composer drop and the canvas drop share one canonical banner
  // (rendered by `TransientAlertBanner` at the top of the app).
  const showTransientAlert = useUiStore((s) => s.showTransientAlert)
  // Phase 2.5e — drag-and-drop drop zone over the composer. Two
  // separate active states so the overlay can appear the moment a
  // file enters the WINDOW (so the writer immediately sees where
  // to drop), with stronger styling once they're actually over the
  // composer.
  //   - `fileDragInWindow`: a file drag is in progress somewhere
  //     in the page. Document-level listener watches `dragenter` for
  //     `'Files'` in `dataTransfer.types`. Cleared on drop / dragend
  //     / file-leaves-window. Drives the always-on overlay.
  //   - `libraryDragInWindow`: a Phase 2.7a library drag (entity /
  //     knowledge / relationship from the Entity Library) is in
  //     progress. Same purpose as `fileDragInWindow` but for the
  //     `application/nnz-*` MIME types. Drives the composer overlay
  //     so the writer can drop on the big target instead of aiming
  //     at the strip.
  //   - `libraryDragKind`: which kind is being dragged, so the
  //     overlay copy can adapt ("Drop to attach this character" vs.
  //     "Drop to attach this knowledge").
  //   - `dragOverComposer`: the cursor is currently over the
  //     composer drop region. Composer-level handlers manage it via
  //     a depth counter to dodge React's leave-on-every-child quirk.
  const [fileDragInWindow, setFileDragInWindow] = useState(false)
  const [libraryDragInWindow, setLibraryDragInWindow] = useState(false)
  const [libraryDragKind, setLibraryDragKind] = useState(null)
  const [dragOverComposer, setDragOverComposer] = useState(false)
  const dragDepth = useRef(0)
  useEffect(() => {
    function isFileDrag(e) {
      const types = Array.from(e?.dataTransfer?.types || [])
      return types.includes('Files')
    }
    function libraryDragKindFor(e) {
      const types = Array.from(e?.dataTransfer?.types || [])
      if (types.includes('application/nnz-entity-id')) return 'entity'
      if (types.includes('application/nnz-knowledge-id')) return 'knowledge'
      if (types.includes('application/nnz-relationship-id')) return 'relationship'
      if (types.includes('application/nnz-cue-id')) return 'cue'
      return null
    }
    function onDragEnter(e) {
      if (isFileDrag(e)) {
        setFileDragInWindow(true)
        return
      }
      const kind = libraryDragKindFor(e)
      if (kind) {
        setLibraryDragInWindow(true)
        setLibraryDragKind(kind)
      }
    }
    function onDragLeave(e) {
      // File leaves the window when relatedTarget is null AND the
      // event's coordinates are outside the viewport. Some browsers
      // fire `dragleave` on every child crossing too — those have a
      // non-null relatedTarget, ignore.
      if (e.relatedTarget != null) return
      setFileDragInWindow(false)
      setLibraryDragInWindow(false)
      setLibraryDragKind(null)
    }
    function onEnd() {
      setFileDragInWindow(false)
      setLibraryDragInWindow(false)
      setLibraryDragKind(null)
      setDragOverComposer(false)
      dragDepth.current = 0
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
    }
  }, [])
  const composerCapabilities = useActiveModelCapabilities(threadId)
  const addChatAttachmentAction = useUiStore((s) => s.addChatAttachment)
  const isPinnedToBottomRef = useRef(true)

  const messages = thread?.messages || []

  // Phase 2.5i — id of the most-recent assistant message in the
  // thread. Used to pin the cache-hit indicator to that one bubble
  // only; older assistant turns render no indicator. Recomputed
  // every render against the live messages array so the indicator
  // tracks the latest reply through retries / resends naturally.
  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  // Message-history cutoff divider. Walks the thread newest-to-oldest
  // counting only user/assistant turns (system messages do NOT count
  // toward the cap). When the count reaches `chatHistoryWindowN` we
  // mark the message at that point as the earliest INCLUDED turn;
  // the divider renders just before it in the message list. If there
  // are fewer user/assistant turns than the cap, no divider is shown.
  const historyN = useUiStore((s) => s.chatHistoryWindowN)
  const cutoff = useMemo(() => {
    if (historyN == null || historyN < 0) return { kind: 'none' }
    if (historyN === 0) {
      // Everything excluded; divider sits at the very bottom (after
      // the last message in the list). Sentinel handled by the
      // renderer below the .map().
      const hasAny = messages.some((m) => m.role === 'user' || m.role === 'assistant')
      return hasAny ? { kind: 'bottom' } : { kind: 'none' }
    }
    let count = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'user' && m.role !== 'assistant') continue
      count++
      if (count === historyN) {
        // m is the earliest included user/assistant turn. Only
        // render the divider if there's any earlier user/assistant
        // turn that's being cut off; otherwise we have exactly N
        // turns and nothing to cut.
        const hasExcludedAbove = messages
          .slice(0, i)
          .some((mm) => mm.role === 'user' || mm.role === 'assistant')
        return hasExcludedAbove ? { kind: 'before', messageId: m.id } : { kind: 'none' }
      }
    }
    return { kind: 'none' }
  }, [messages, historyN])

  // Set of user/assistant message ids that sit ABOVE the cutoff
  // divider and therefore will NOT be sent in the next request.
  // Used to render them with reduced opacity so the writer can
  // tell at a glance which turns the model won't see. Excluded:
  //   - System messages (always sent regardless of cap).
  //   - Sticky favourites (`pinned && context_sticky`) — they bypass
  //     the cap by design, so they're always sent and should not
  //     read as out-of-window even when they sit above the divider.
  const aboveCutoffIds = useMemo(() => {
    const out = new Set()
    if (cutoff.kind === 'none') return out
    let cutoffIndex
    if (cutoff.kind === 'bottom') cutoffIndex = messages.length
    else cutoffIndex = messages.findIndex((m) => m.id === cutoff.messageId)
    if (cutoffIndex < 0) return out
    for (let i = 0; i < cutoffIndex; i++) {
      const m = messages[i]
      if (m.role !== 'user' && m.role !== 'assistant') continue
      if (m.pinned && m.context_sticky) continue
      out.add(m.id)
    }
    return out
  }, [messages, cutoff])

  useEffect(() => {
    // Re-run on every token. `messages` is a fresh array reference
    // on each `updateLocalMessage` call (the store spreads the
    // messages list), so depending on the array itself triggers the
    // pull-to-bottom on every streamed delta. Depending on
    // `messages.length` alone is NOT enough — during streaming the
    // length stays constant while the last message's content grows,
    // and the panel would scroll off the bottom instead of following.
    //
    // `conversationRenderMode` is in the dep list because flipping
    // between Markdown and Raw changes the rendered height of every
    // bubble; without re-snapping, a writer pinned to the bottom
    // gets nudged off-bottom by the layout shift and auto-scroll
    // stops following the in-progress stream.
    if (autoScroll && isPinnedToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, streaming, autoScroll, conversationRenderMode])

  // Phase 2.5 perf fix — Streamdown does async layout work after the
  // React render commits (Mermaid SVG generation, Shiki syntax
  // highlighting, table reflow, etc.). The `messages`-dep useEffect
  // above only fires on store updates, so any height growth that
  // happens BETWEEN store updates (or after the final one) leaves the
  // bubble bottom drifting below the viewport while the writer is
  // technically still pinned. ResizeObserver on the scroll container's
  // children catches every height change regardless of cause — sync
  // render commits, async highlighter passes, mermaid renders, image
  // loads, font swaps. When the writer is pinned + auto-scroll is on,
  // we snap to bottom. When they've manually scrolled up, we don't.
  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    let raf = null
    const ro = new ResizeObserver(() => {
      if (!autoScroll || !isPinnedToBottomRef.current) return
      // Coalesce multiple resize entries into a single rAF snap so
      // bulk layout passes (e.g. a code block highlighter touching
      // every line) don't fight each other on the scroll write.
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        if (!autoScroll || !isPinnedToBottomRef.current) return
        if (!listRef.current) return
        listRef.current.scrollTop = listRef.current.scrollHeight
      })
    })
    // Observe every direct child + the container itself. Children
    // come and go (new bubbles, deleted bubbles); a MutationObserver
    // re-attaches the ResizeObserver as the child list mutates.
    function attachAll() {
      for (const child of Array.from(el.children)) {
        try { ro.observe(child) } catch { /* already observed */ }
      }
    }
    attachAll()
    const mo = new MutationObserver(attachAll)
    mo.observe(el, { childList: true })
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
    }
  }, [autoScroll])

  // Tracks whether the writer is far enough down to make a jump-
  // to-top affordance useful. Hidden when already at the top so
  // the chip never overlaps the first message in a short thread.
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  // Phase 2.5 perf fix — tracks whether the most recent scroll event
  // came from real user input (wheel / touch / keyboard) vs. a
  // layout-induced scroll (browser clamping `scrollTop` when content
  // shrinks, like the reasoning disclosure auto-collapsing when the
  // answer content starts arriving). Only user-input scrolls are
  // allowed to break the pin; layout shifts let the ResizeObserver-
  // driven snap handle them. Without this gate, a bubble that shrinks
  // mid-stream — disclosure collapse, image load completing into a
  // smaller container, code block re-highlighting to a smaller
  // height — fires a 'scroll' event whose measurements (against the
  // 24px slack) sometimes evaluate to unpinned even though the writer
  // never touched anything. We treat user-input scrolls as
  // authoritative for up to 250 ms after the input fires.
  const userScrollIntentExpiresRef = useRef(0)
  function markUserScrollIntent() {
    userScrollIntentExpiresRef.current = performance.now() + 250
  }

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const slack = 24
    const pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - slack
    const userDriven = performance.now() < userScrollIntentExpiresRef.current
    // Only let user-driven scrolls change the pin state. Layout-
    // induced scrolls (height grew / shrunk under the cursor without
    // any input) reuse the prior pin state so the ResizeObserver
    // snap can re-stick the bottom on the next frame.
    if (userDriven) {
      isPinnedToBottomRef.current = pinned
    }
    // The "Latest" / scroll-to-bottom chip's visibility follows the
    // same gate: layout-induced scrolls can transiently compute
    // `pinned = false` (slack threshold tripped during a height
    // jump) which previously caused the chip to flash on mid-stream.
    // When NOT userDriven, fall back to the persistent pin state so
    // the chip only shows when the writer is actually scrolled away.
    setShowScrollToBottom(!(userDriven ? pinned : isPinnedToBottomRef.current))
    setShowScrollToTop(el.scrollTop > slack)
  }
  function scrollToBottom() {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    isPinnedToBottomRef.current = true
    setShowScrollToBottom(false)
  }
  function scrollToTop() {
    if (listRef.current) listRef.current.scrollTop = 0
    isPinnedToBottomRef.current = false
    setShowScrollToTop(false)
  }
  // Jump to a favourited message + brief accent-coloured glow on
  // the target bubble. The bubble carries `data-message-id` so we
  // can find it by query selector without having to thread refs
  // for every message all the way down the tree. The class is
  // removed after the keyframe finishes so a second click on the
  // same chip re-fires the animation.
  function scrollToMessage(messageId) {
    if (!listRef.current) return
    const el = listRef.current.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.style.setProperty('--message-highlight-accent', withAccentAlpha(accent, 0.85))
    el.classList.remove('nn-message-highlight')
    // Force a reflow so the animation restarts even when the class
    // is already present from a recent previous click.
     
    void el.offsetWidth
    el.classList.add('nn-message-highlight')
    window.setTimeout(() => {
      el.classList.remove('nn-message-highlight')
      el.style.removeProperty('--message-highlight-accent')
    }, 1700)
  }

  // Phase 2.8a — hover-preview state for the chat bubble highlight
  // spans. Mirrors the scene editor's behaviour: hovering a
  // coloured name pops a 80x80 avatar (or 40x40 type-icon
  // placeholder when no profile image) above / below the name.
  // The shared `<EntityHoverPreview>` component reads the data
  // attributes (`data-entity-image` / `data-entity-colour` /
  // `data-entity-type`) off the hovered span — same contract as
  // the scene editor.
  const [bubbleHoverTarget, setBubbleHoverTarget] = useState(null)
  const [bubbleHoverRect, setBubbleHoverRect] = useState(null)
  // Bail early when the hovered span is the SAME element we
  // already have in state. React's `onMouseOver` bubbles, so just
  // wiggling the cursor inside a span fires repeatedly; without
  // this guard each mouse-move triggers `setBubbleHoverRect` with
  // a fresh `getBoundingClientRect()` object, re-rendering the
  // (large) ConversationView component every single tick. The
  // guard collapses that to a single state update per actual
  // span-enter — no per-movement cost while hovering, no work
  // when the cursor isn't over a highlight at all.
  function handleBubbleHighlightMouseOver(e) {
    const el = e.target.closest && e.target.closest('.nn-entity-highlight')
    if (!el) return
    if (el.dataset.ambiguous === 'true') return
    if (el === bubbleHoverTarget) return
    setBubbleHoverTarget(el)
    setBubbleHoverRect(el.getBoundingClientRect())
  }
  function handleBubbleHighlightMouseOut(e) {
    const el = e.target.closest && e.target.closest('.nn-entity-highlight')
    if (!el && bubbleHoverTarget) {
      setBubbleHoverTarget(null)
      setBubbleHoverRect(null)
    }
  }

  // Phase 2.8a — single click delegate for the highlight spans
  // painted by `<HighlightChildren>` inside every chat bubble.
  // Routes to the correct detail panel based on the span's
  // `data-entity-type`. For chain-tracked kinds (entity /
  // knowledge / relationship) we open at the object's ORIGIN
  // node — chat bubbles aren't anchored to a specific scene's
  // chain position the way scene-editor bodies are, so the
  // origin is the safest universal anchor (the writer can step
  // forward through the chain from there in the detail panel
  // chain navigator). Cues open in the right-sidebar cue editor.
  // Ambiguous matches (data-ambiguous="true") have no single
  // resolution target so we treat the click as no-op; the
  // tooltip already lists the colliding objects so the writer
  // can adjust the surrounding text to disambiguate.
  function handleBubbleHighlightClick(e) {
    const el = e.target.closest && e.target.closest('.nn-entity-highlight')
    if (!el) return
    if (el.dataset.ambiguous === 'true') return
    const entityId = el.dataset.entityId
    const entityType = el.dataset.entityType
    if (!entityId || !entityType) return
    e.stopPropagation()
    const ui = useUiStore.getState()
    const ps = useProjectStore.getState()
    if (entityType === 'cue') {
      ui.openContextCueEditor?.(entityId)
      return
    }
    if (entityType === 'knowledge') {
      const k = (ps.knowledges || []).find((x) => x.id === entityId)
      const originId = k?.history?.source_events?.[0]?.node_id
        || (ps.nodes || []).find((n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === entityId)?.id
        || null
      ui.openKnowledgeDetail?.(entityId, originId)
      return
    }
    if (entityType === 'relationship') {
      const originId = (ps.nodes || []).find((n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === entityId)?.id
        || null
      ui.openRelationshipDetail?.(entityId, originId)
      return
    }
    // Entity kinds — open at the origin EntityNode.
    const originNode = (ps.nodes || []).find((n) => (
      n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId
    ))
    if (originNode) {
      ui.setDetailPanel?.('entityNode', originNode.id, entityId, 0)
    }
  }
  // Sticky chatActiveSceneId — Phase 2.5d.
  //
  // The writer's "active scene for chat context" should NOT flicker
  // off when they wander into the detail panel for a character that
  // belongs to that scene. Live-derive priority (editor pin →
  // detail-panel scene → null) was correct for the moment but too
  // jittery for context provision: the moment the writer clicked an
  // entity chip the detail panel switched modes and the next send
  // would drop scene context entirely.
  //
  // The store now holds a sticky `chatActiveSceneId`. We update it
  // here, on the only signals that should change it:
  //   - The editor pin opens a scene → take that.
  //   - The detail panel anchors on a scene → take that.
  //   - Otherwise → leave the previous value alone (sticky).
  //
  // The sticky value only clears when the writer explicitly picks a
  // DIFFERENT scene, or via an explicit `setChatActiveSceneId(null)`
  // (e.g. closing the active conversation, swapping threads).
  const rightSidebarOpen     = useUiStore((s) => s.rightSidebarOpen)
  const rightSidebarNodeId   = useUiStore((s) => s.rightSidebarNodeId)
  const detailPanelMode      = useUiStore((s) => s.detailPanelMode)
  const detailPanelNodeId    = useUiStore((s) => s.detailPanelNodeId)
  const setChatActiveSceneId = useUiStore((s) => s.setChatActiveSceneId)
  useEffect(() => {
    let next = null
    if (rightSidebarOpen && rightSidebarNodeId) {
      next = rightSidebarNodeId
    } else if (detailPanelMode === 'scene' && detailPanelNodeId) {
      next = detailPanelNodeId
    }
    // Sticky: only overwrite the store when a new scene is resolved.
    // Wandering into an entity (no scene resolved) leaves the
    // previous active scene in place so chat context stays bound to
    // it until the writer actually picks something else.
    if (next != null) {
      const curr = useUiStore.getState().chatActiveSceneId
      if (next !== curr) setChatActiveSceneId(next)
    }
  }, [rightSidebarOpen, rightSidebarNodeId, detailPanelMode, detailPanelNodeId, setChatActiveSceneId])

  // Resolve the connection + model + system prompt for the
  // current send. Threads carry the seed values they were created
  // with; if those are missing or stale, fall back to the global
  // program defaults.
  const profile = useMemo(() => {
    const profiles = prefs.ai_provider_profiles || []
    return profiles.find((p) => p.id === (thread?.profile_id || prefs.ai_default_profile_id)) || profiles[0] || null
  }, [prefs, thread])
  const model = thread?.model || prefs.ai_default_model?.model || null
  const activeSystemPrompt = useMemo(() => {
    const id = thread?.system_prompt_id || prefs.default_system_prompt_id || null
    if (!id) return null
    return systemPrompts.find((p) => p.id === id) || null
  }, [systemPrompts, thread, prefs])

  // Shared assistant-streaming helper used by send, retry, and the
  // edit-user-and-resubmit flow. Caller supplies the full history
  // the model should see; we append a local-only assistant stub,
  // run the stream into it, then persist the final content (or
  // drop the stub on empty / cancel).
  //
  // Optional `wireAttachments` (Phase 2.5e): pre-encoded
  // `ChatAttachment` records. `streamChat` splices them onto the
  // latest user message in the wire array so the adapter sees them
  // riding with that turn. Encoding happens in `sendText` BEFORE
  // staging is cleared so a transient encode failure can't drop
  // the writer's files into the void.
  const streamAssistantReply = useCallback(async (historyMessages, wireAttachments, previewOpts, twoCharOpts) => {
    // ToDo item 163 — Preview destination. When `previewOpts.onPreview`
    // is supplied, this call is a dry-run: build the exact same wire
    // payload the LLM would receive, hand it to the callback, and
    // return without persisting an assistant placeholder or calling
    // `streamChat`. Same wire-build code path as a real send so the
    // preview can never drift from the real send semantically.
    const isPreview = !!(previewOpts && typeof previewOpts.onPreview === 'function')
    if (!profile || !model || !threadId) return null
    if (!isPreview) setStreaming(true)
    // Phase 2.11b item 12 — re-anchor divider metadata, stamped on
    // the assistant message at send time. See the matching block on
    // the user message creation for the rationale; both halves of
    // the turn carry the same `anchor_dossier_hash` + `anchor_label`
    // pair so the divider renders correctly regardless of whether
    // it falls before the user or the assistant message.
    const _charChatForReply = thread?.character_chat || null
    const _replyAnchorHash = _charChatForReply ? hashAnchorSpec(_charChatForReply.anchor_spec) : null
    const _replyAnchorLabel = _charChatForReply
      ? formatAnchorSpan(_charChatForReply.anchor_spec, useProjectStore.getState().nodes || [])
      : null

    // Phase 2.12 — two-character mode context. When the thread carries
    // a `two_character_chat` meta block, this send is one turn in an
    // AI-to-AI conversation. Resolve the current speaker via
    // `next_turn_index` (0 = Character 1 = assistant-side; 1 =
    // Character 2 = user-side). The OTHER character is whichever
    // index this isn't. Both indexes point at full
    // `CharacterChatMeta` shapes so each character carries its own
    // anchor / persona prompt / model override / temp fields.
    //
    // Single-character chats and regular chats see `_twoCharCtx` as
    // null; every downstream branch below treats null as "use the
    // existing pre-Phase-2.12 path" so the no-regression invariant
    // holds.
    const _twoCharChat = thread?.two_character_chat || null
    let _twoCharCtx = null
    if (_twoCharChat && Array.isArray(_twoCharChat.characters) && _twoCharChat.characters.length === 2) {
      // Phase 2.12 — speaker resolution by "who spoke last". Walks
      // the history backwards to find the most recent message with a
      // `speaker_character_id` field; the OTHER character speaks next.
      // Falls through to Character 1 (index 0) when no prior speaker
      // is recorded — empty threads always open on Character 1.
      //
      // This replaces the original strict-alternation `next_turn_index`
      // counter: derivation from history naturally handles deletions
      // (the counter would drift on delete), retries (the deleted-tail
      // history points at the correct prior speaker without needing an
      // override), and the dual-button mode in Track 2.12f (clicked
      // button overrides via `speakerCharacterIdOverride`).
      //
      // `speakerCharacterIdOverride` still wins when provided: dual-
      // button mode in Track 2.12f and any future explicit "send to
      // <char>" path can pass it to force a specific speaker.
      const overrideId = twoCharOpts && twoCharOpts.speakerCharacterIdOverride
      const c0 = _twoCharChat.characters[0]
      const c1 = _twoCharChat.characters[1]
      let idx = 0
      if (overrideId) {
        const overrideIdx = _twoCharChat.characters.findIndex((c) => c && c.character_id === overrideId)
        if (overrideIdx === 0 || overrideIdx === 1) idx = overrideIdx
      } else {
        // Walk history backwards for the most recent speaker. The
        // OTHER character is up next.
        const hist = Array.isArray(historyMessages) ? historyMessages : []
        let lastSpeakerIdx = -1
        for (let i = hist.length - 1; i >= 0; i--) {
          const m = hist[i]
          if (!m || (m.role !== 'assistant' && m.role !== 'user')) continue
          if (!m.speaker_character_id) continue
          if (c0 && m.speaker_character_id === c0.character_id) { lastSpeakerIdx = 0; break }
          if (c1 && m.speaker_character_id === c1.character_id) { lastSpeakerIdx = 1; break }
        }
        if (lastSpeakerIdx === 0) idx = 1
        else if (lastSpeakerIdx === 1) idx = 0
        else idx = 0  // No history → Character 1 starts.
      }
      const speaker = _twoCharChat.characters[idx]
      const other = _twoCharChat.characters[idx === 0 ? 1 : 0]
      if (speaker && other && speaker.character_id && other.character_id) {
        _twoCharCtx = {
          speakerIdx: idx,
          otherIdx: idx === 0 ? 1 : 0,
          speaker,
          other,
          inlineSystemText: (twoCharOpts && typeof twoCharOpts.inlineSystemText === 'string')
            ? twoCharOpts.inlineSystemText.trim()
            : '',
        }
      }
    }

    const assistantMessage = {
      id: newMessageId(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      pinned: false,
      collapsed: false,
      tool_calls: [],
      attachments: [],
      // Phase 2.5f — reasoning trace, populated by `reasoning_delta`
      // / `reasoning_end` SSE events. `reasoning_text` holds the
      // assistant's chain-of-thought verbatim (the disclosure widget
      // in item 12 renders it), `reasoning_token_count` and
      // `reasoning_duration_ms` are footer metadata for that widget.
      // Persistence (item 11) carries these fields through to disk
      // and the system-prompt contract ensures NONE of these are
      // ever re-sent on subsequent turns — they are display-only.
      reasoning_text: '',
      reasoning_token_count: null,
      reasoning_duration_ms: null,
      anchor_dossier_hash: _replyAnchorHash,
      anchor_label: _replyAnchorLabel,
      // Phase 2.12 — stamp the current speaker on the assistant
      // message so the bubble renderer (Track 2.12e) can place it in
      // the correct UI slot and the wire-builder (next turn) can
      // relabel its role correctly. Null in regular + single-
      // character chats.
      speaker_character_id: _twoCharCtx ? _twoCharCtx.speaker.character_id : null,
      // Phase 2.12 — per-character anchor snapshot for the re-anchor
      // divider in two-character chats. We stamp BOTH characters'
      // anchor hashes + labels on every persisted message so the
      // message-list renderer can detect "which character was
      // re-anchored between this bubble and the previous one" by
      // comparing the dicts entry-by-entry. Null in regular +
      // single-character chats.
      two_char_anchor_hashes: _twoCharCtx ? {
        [_twoCharCtx.speaker.character_id]: hashAnchorSpec(_twoCharCtx.speaker.anchor_spec),
        [_twoCharCtx.other.character_id]: hashAnchorSpec(_twoCharCtx.other.anchor_spec),
      } : null,
      two_char_anchor_labels: _twoCharCtx ? {
        [_twoCharCtx.speaker.character_id]: formatAnchorSpan(_twoCharCtx.speaker.anchor_spec, useProjectStore.getState().nodes || []),
        [_twoCharCtx.other.character_id]: formatAnchorSpan(_twoCharCtx.other.anchor_spec, useProjectStore.getState().nodes || []),
      } : null,
    }
    if (!isPreview) {
      appendLocalMessage(threadId, assistantMessage)
      streamingMessageIdRef.current = assistantMessage.id
    }
    const controller = new AbortController()
    if (!isPreview) abortRef.current = controller
    // Single try / finally wraps both the stream pump and the
    // post-stream persistence so `streaming` only flips back to
    // false once the assistant message is fully written. That lets
    // the queued-messages flush effect trust the flag.

    let accumulated = ''
    let reasoningAccumulated = ''
    let reasoningTokenCount = null
    let reasoningDurationMs = null
    let streamError = null
    // In-order list of tool calls the assistant ran during this
    // message, keyed by the adapter-assigned correlation id. We
    // fold each `tool_call` event into the matching record (or
    // append a new one on first sight of an id) and push the
    // mutated list to the live message so the bubble UI can render
    // chips as the call progresses.
    const toolCalls = []
    const toolCallIndex = new Map()
    // Phase 2.5e — images the assistant returned during this turn.
    // Each `type:'image'` SSE event becomes one StoredAttachment-shape
    // entry. `data_url` is the local copy (downloaded server-side if
    // the upstream gave us a hosted URL) used for the bubble
    // thumbnail; `wire_url` preserves the original upstream URL so
    // subsequent turns re-forward whatever shape the model gave us
    // verbatim instead of re-encoding bytes.
    const receivedImages = []
    function recordImageEvent(event) {
      const dataUrl = event.image_data_url
      if (!dataUrl || typeof dataUrl !== 'string') return
      const idx = receivedImages.length + 1
      const mime = event.image_mime_type || _mimeFromDataUrl(dataUrl) || 'image/png'
      const ext = _extFromMime(mime)
      receivedImages.push({
        kind: 'image',
        name: `generated-${idx}${ext}`,
        mime_type: mime,
        size: _approxDataSize(_base64FromDataUrl(dataUrl)),
        data_url: dataUrl,
        wire_url: event.image_wire_url || dataUrl,
        text_content: null,
      })
      updateLocalMessage(threadId, assistantMessage.id, { attachments: [...receivedImages] })
    }
    function recordToolCall(event) {
      const callId = event.tool_call_id
      if (!callId) return
      let idx = toolCallIndex.get(callId)
      if (idx === undefined) {
        idx = toolCalls.length
        toolCallIndex.set(callId, idx)
        toolCalls.push({
          id: callId,
          tool: event.tool_name || null,
          status: 'running',
          provider_type: event.tool_provider_type || null,
          server_label: event.tool_server_label || null,
          plugin_id: event.tool_plugin_id || null,
          arguments: null,
          output: null,
          error_reason: null,
          error_type: null,
        })
      }
      const existing = toolCalls[idx]
      const next = { ...existing }
      // Always upgrade the tool name when a later event carries one
      // — LM Studio sometimes ships the name on `tool_call.arguments`
      // or `tool_call.success` but not on `tool_call.start`, so we
      // can't lock the first value we see.
      if (event.tool_name) next.tool = event.tool_name
      if (event.tool_provider_type) next.provider_type = event.tool_provider_type
      if (event.tool_server_label) next.server_label = event.tool_server_label
      if (event.tool_plugin_id) next.plugin_id = event.tool_plugin_id
      if (event.tool_arguments && typeof event.tool_arguments === 'object') {
        next.arguments = event.tool_arguments
      }
      if (event.tool_call_phase === 'success') {
        next.status = 'success'
        if (typeof event.tool_output === 'string') next.output = event.tool_output
      } else if (event.tool_call_phase === 'failure') {
        next.status = 'failure'
        if (typeof event.tool_error_reason === 'string') next.error_reason = event.tool_error_reason
        if (typeof event.tool_error_type === 'string') next.error_type = event.tool_error_type
      }
      toolCalls[idx] = next
      // Patch the live message so the bubble re-renders with the
      // updated chip set. We send a fresh array reference so
      // shallow-equal checks down the tree notice the change.
      updateLocalMessage(threadId, assistantMessage.id, { tool_calls: [...toolCalls] })
    }
    // Phase 2.5d wire-builder (rebuilt): walk the thread, emit each
    // in-window `system_context` message as a `role: system` wire
    // entry at its NATURAL POSITION. The original `scene_full` rides
    // with the turn it was first emitted alongside; each subsequent
    // `*_diff` rides with the turn that triggered the change. Ride-
    // along ensures every in-force part's chain is in the wire even
    // when its originating messages have rolled outside the window.
    const ui = useUiStore.getState()
    const ps = useProjectStore.getState()
    // Same strict gate as in `sendText` — only consider the scene
    // in-force when the toggle is ON AND the sticky id resolves
    // to a real scene node in the current project.
    const stickyId = ui.chatActiveSceneId
    const sceneExists = stickyId
      ? (ps.nodes || []).some((n) => n.id === stickyId && n.type === 'sceneNode')
      : false
    const sceneIsActive = !!(ui.chatSceneContextEnabled && sceneExists)
    const activeSceneId = sceneIsActive ? stickyId : null
    const pinnedItems = usePinnedContextStore.getState().getPins(`chat:${threadId}`)
    const rollingN = ui.chatHistoryWindowN
    // Phase 2.5g follow-up — historical image / file attachments are
    // stripped from the wire payload when the active model lacks the
    // matching input modality. Persisted message data is untouched —
    // the bubble still shows the historical attachment so the writer
    // sees the full conversation; only the model's view of THIS send
    // omits it. A small inline notice on the bubble's attachment
    // (driven by the same flag, passed below) tells the writer that
    // the model can't see this image.
    const capsInputModalities = Array.isArray(composerCapabilities?.input_modalities)
      ? composerCapabilities.input_modalities : ['text']
    const supportsImageInput = capsInputModalities.includes('image')
    const supportsFileInput = capsInputModalities.includes('file')
    // Phase 2.12 — two-character wire-role rewriting. UI position of
    // each bubble is FIXED by `speaker_character_id` (Character 1 =
    // assistant slot, Character 2 = user slot, never changes). The
    // WIRE role label flips per turn: for the speaking character,
    // their own prior bubbles are `role: 'assistant'`, the OTHER
    // character's bubbles are `role: 'user'`. Done by rewriting the
    // history list's `role` field BEFORE `buildWireMessages` runs.
    // Messages without `speaker_character_id` (regular user-typed
    // messages, system_context blocks, edge cases) pass through with
    // their existing role. Outside two-character mode this is a
    // no-op — the no-regression invariant for single-character and
    // regular chats holds.
    const _historyForWire = _twoCharCtx
      ? (historyMessages || []).map((m) => {
          if (!m || (m.role !== 'user' && m.role !== 'assistant')) return m
          const sid = m.speaker_character_id
          if (!sid) return m
          if (sid === _twoCharCtx.speaker.character_id) return { ...m, role: 'assistant' }
          if (sid === _twoCharCtx.other.character_id) return { ...m, role: 'user' }
          return m
        })
      : historyMessages
    const realHistoryWireMessages = buildWireMessages(
      { messages: _historyForWire },
      { rollingN, activeSceneId, pinnedItems, supportsImageInput, supportsFileInput },
    )
    // Splice the active prompt's Pre-Configured Message History
    // (`SystemPrompt.mock_messages`) at the FRONT of the wire
    // messages array — before any real thread history. The rolling-
    // Message-History cap protects the writer's actual conversation
    // turns ONLY; PCMH is authorial primer content (part of the
    // prompt's payload, not the writer's chat), so it always rides
    // in full regardless of the cap. PCMH turns are NOT persisted
    // to thread.messages — they're invisible in the chat panel's
    // bubble list and only surface in the Preview Message modal
    // (which renders this same wire payload).
    const pcmhWireTurns = preconfiguredMessageHistoryWireTurns(activeSystemPrompt)
    let wireMessages = pcmhWireTurns.length > 0
      ? [...pcmhWireTurns, ...realHistoryWireMessages]
      : realHistoryWireMessages

    // Phase 2.12 — two-character wire-payload finalisation.
    //   1. Inline director cue from the composer: if the writer
    //      typed a stage cue, it rides as a `{role: 'user'}` entry
    //      at the END of the messages array (the turn-trigger slot
    //      most chat-completion APIs are designed around). Wrapped
    //      in a `<director>` block with an explicit "must be acted
    //      on" instruction — the XML framing flags it as
    //      out-of-character even though it's wearing the `user`
    //      role, so the model treats it as a non-negotiable
    //      instruction rather than dialogue from the other
    //      character. Bare text at this position was routinely
    //      shrugged off as low-priority background when it rode the
    //      system role; user role + explicit framing solves both
    //      issues. One-shot path — the text isn't persisted on the
    //      thread, isn't counted against the history limit, and
    //      isn't shown in the message list.
    //   2. First-turn placeholder: if after all the above there's
    //      still NO `role: 'user'` message in the payload (a blank
    //      thread getting its first turn), append a synthetic
    //      `Begin` user message. Most provider adapters reject a
    //      messages array that ends on `role: 'assistant'` or that
    //      has no user role at all; the synthetic prompt also gives
    //      the LLM a clear "open the scene" instruction.
    // Outside two-character mode this block is a no-op.
    if (_twoCharCtx) {
      if (_twoCharCtx.inlineSystemText) {
        const _wrapped = (
          '<director>\n'
          + 'The director (the human running this scene) has given '
          + 'the following cue. The character speaking next MUST '
          + 'honour it in their reply — treat it as a non-negotiable '
          + 'instruction from the director, not as dialogue from '
          + "another character. Act on it in-fiction through the "
          + "character's next action, dialogue, reaction, or thought, "
          + 'but do NOT address the director directly or reference '
          + 'these tags.\n\n'
          + 'Cue:\n'
          + _twoCharCtx.inlineSystemText
          + '\n</director>'
        )
        wireMessages = [
          ...wireMessages,
          { role: 'user', content: _wrapped },
        ]
      }
      const hasUserMessage = wireMessages.some((m) => m && m.role === 'user')
      if (!hasUserMessage) {
        wireMessages = [...wireMessages, { role: 'user', content: 'Begin.' }]
      }
    }
    // Phase 2.5f — read the writer's reasoning button + slider
    // state for THIS thread. `reasoning_level` only goes on the
    // wire when the button is currently on; otherwise we omit the
    // field. `reasoning_summary` is OpenRouter-specific verbosity
    // (the flyout only surfaces the picker for that adapter).
    const reasoningOn = !!(ui.chatReasoningEnabled || {})[threadId]
    const reasoningLevel = reasoningOn
      ? ((ui.chatReasoningLevel || {})[threadId] ?? null)
      : null
    const reasoningSummary = reasoningOn
      ? ((ui.chatReasoningVerbosity || {})[threadId] ?? null)
      : null
    // Phase 2.5 perf fix — SSE token coalescing. Without this, every
    // `delta` / `reasoning_delta` event triggered an immediate
    // `updateLocalMessage` (Zustand `set`) which fanned out to a full
    // React render pass. At 100+ tokens/sec the render storm
    // dominated CPU + drove GC pressure that ballooned the browser
    // tab's working set. We now buffer text deltas locally and flush
    // at most once per animation frame (~16 ms in practice), cutting
    // store updates by ~5-6x without affecting the live-streaming feel.
    //
    // Force-flush hooks: any terminal event (`reasoning_end`,
    // `tool_call`, `image`, `error`, stream end, exception) flushes
    // synchronously so downstream code observes the final accumulated
    // state — never a half-flushed buffer.
    let pendingFlush = null
    let pendingContentDirty = false
    let pendingReasoningDirty = false
    // `skipIndexPreview` toggles whether the underlying
    // `updateLocalMessage` runs `bumpIndex` (which walks the full
    // accumulated content to recompute the thread-browser preview).
    // Per-rAF flushes set it true to skip the expensive preview
    // recompute while the writer is in the chat panel; terminal
    // flushes (force-flush from non-delta events, end-of-stream)
    // set it false so the index is up to date before persistence.
    function applyFlush(skipIndexPreview) {
      const patch = {}
      if (pendingContentDirty) {
        patch.content = accumulated
        pendingContentDirty = false
      }
      if (pendingReasoningDirty) {
        patch.reasoning_text = reasoningAccumulated
        pendingReasoningDirty = false
      }
      if (Object.keys(patch).length > 0) {
        updateLocalMessage(threadId, assistantMessage.id, patch, { skipIndexPreview })
      }
    }
    function scheduleFlush() {
      if (pendingFlush !== null) return
      pendingFlush = requestAnimationFrame(() => {
        pendingFlush = null
        applyFlush(true)
      })
    }
    function forceFlush() {
      if (pendingFlush !== null) {
        cancelAnimationFrame(pendingFlush)
        pendingFlush = null
      }
      applyFlush(false)
    }
    // Phase 2.5h — compose the Story Scope appendage onto the writer's
    // chosen system prompt at send time. Pure system-prompt side; never
    // appended to messages[], never persisted on the thread. Empty
    // appendage → no separator, system prompt rides as-is.
    //
    // Phase 2.11b — branch on `thread.character_chat` metadata. When
    // present, this is a character-chat thread; the assembled system
    // message follows the four-section Persona Preamble +
    // `<character_context>` + `<system_prompt>` + optional
    // `<custom_instructions>` shape from
    // `assembleCharacterChatSystemMessage`. The Persona prompt body
    // lives at `character_chat.system_prompt_id` (not the
    // thread.system_prompt_id), which is the Persona-flagged prompt
    // the writer picked in the Setup modal; that's the body the
    // assembly function wraps in `<system_prompt>` tags. The regular-
    // chat Story Scope appendage path is skipped — character chats
    // build their context via the focal-character dossier instead.
    const characterChatMeta = thread?.character_chat || null
    let composedSystemPrompt
    if (_twoCharCtx) {
      // Phase 2.12 — two-character chat assembly. Use the CURRENT
      // speaker's meta as the focal character; pass the OTHER
      // character's meta into the assembler so it can render the new
      // awareness-filtered `<other_character_context>` block. Persona
      // prompt body comes from the speaker's `system_prompt_id`
      // (each character has their own Persona prompt pick).
      const speakerMeta = _twoCharCtx.speaker
      const speakerPersonaPrompt = (systemPrompts || []).find(
        (p) => p && p.id === speakerMeta.system_prompt_id,
      ) || null
      try {
        composedSystemPrompt = await assembleCharacterChatSystemMessage({
          character_id:        speakerMeta.character_id || null,
          pins:                Array.isArray(speakerMeta.anchor_spec) ? speakerMeta.anchor_spec : [],
          persona_prompt_body: speakerPersonaPrompt?.prompt || '',
          temp_circumstances:  Array.isArray(speakerMeta.temp_circumstances) ? speakerMeta.temp_circumstances : [],
          temp_motivators:     Array.isArray(speakerMeta.temp_motivators) ? speakerMeta.temp_motivators : [],
          custom_instructions: speakerMeta.custom_instructions || null,
          other_character: {
            character_id: _twoCharCtx.other.character_id || null,
            pins: Array.isArray(_twoCharCtx.other.anchor_spec) ? _twoCharCtx.other.anchor_spec : [],
          },
        })
      } catch (err) {
        console.warn('Two-character chat assembly failed; falling back to vanilla persona prompt body.', err)
        composedSystemPrompt = speakerPersonaPrompt?.prompt || activeSystemPrompt?.prompt || null
      }
    } else if (characterChatMeta) {
      const personaPrompt = (systemPrompts || []).find(
        (p) => p && p.id === characterChatMeta.system_prompt_id,
      ) || null
      try {
        composedSystemPrompt = await assembleCharacterChatSystemMessage({
          character_id:        characterChatMeta.character_id || null,
          pins:                Array.isArray(characterChatMeta.anchor_spec) ? characterChatMeta.anchor_spec : [],
          persona_prompt_body: personaPrompt?.prompt || '',
          temp_circumstances:  Array.isArray(characterChatMeta.temp_circumstances) ? characterChatMeta.temp_circumstances : [],
          temp_motivators:     Array.isArray(characterChatMeta.temp_motivators) ? characterChatMeta.temp_motivators : [],
          custom_instructions: characterChatMeta.custom_instructions || null,
        })
      } catch (err) {
        // Fall through to the regular-chat composition path on any
        // assembly error so the send still works rather than silently
        // dropping the message. The bubble's preview link will let the
        // writer inspect what reached the model.
        console.warn('Character chat assembly failed; falling back to vanilla system prompt path.', err)
        composedSystemPrompt = personaPrompt?.prompt || activeSystemPrompt?.prompt || null
      }
    } else {
      composedSystemPrompt = (() => {
        const writerPrompt = activeSystemPrompt?.prompt?.trim() || ''
        const scopeBundle = buildStoryScopeBundle({
          mode:           (ui.chatStoryScopeMode || {})[threadId] || null,
          // Per-scene picks are now `kind: 'scene'` pins on the unified
          // pinnedContextStore — they emit via the pinned-section
          // renderer in `sceneContextPrompt._renderPinnedSection`
          // (each pin calls `buildStoryScopeBundle` for its own
          // single-scene render). The Story Scope bundle here only
          // covers the scope-wide concepts (whole-story / chapter /
          // act modes + prev/next neighbour toggles).
          scopeScenes:    [],
          scopeChapter:   (ui.chatStoryScopeChapter || {})[threadId] || null,
          scopeAct:       (ui.chatStoryScopeAct || {})[threadId] || null,
          includePrev:    !!(ui.chatStoryScopeIncludePrev || {})[threadId],
          includeNext:    !!(ui.chatStoryScopeIncludeNext || {})[threadId],
          activeSceneId,
          // `ps.story.entities` is a load-time / save-time snapshot — it does
          // NOT include entities created mid-session. Override with the live
          // entitiesStore shape so newly-created entities are present in the
          // bundle this builder produces (otherwise they'd be missing from
          // the story-scope context the AI receives). See
          // `entitiesStore.js` header comment for the two-store lifecycle.
          story: { ...(ps.story || {}), entities: getLiveStoryEntitiesShape() },
          nodes: ps.nodes || [],
          edges: ps.edges || [],
          // Share the cached story order so this once-per-send bundle reuses
          // the same walk as the rest of the send rather than recomputing.
          storyOrder: getOrComputeStoryOrderFromStore(),
          // Phase 2.13c — pass live knowledges + relationships so the
          // perspective target lookup (in storyScopeBundleBuilder's
          // change-line walker) resolves against current state, not
          // the stale `ps.story.*` snapshot.
          knowledges: ps.knowledges || [],
          relationships: ps.relationships || [],
        })
        const appendage = buildStoryScopeAppendage(scopeBundle)
        if (!appendage) return writerPrompt || null
        return writerPrompt
          ? `${writerPrompt}\n\n## Additional story context\n\n${appendage}`
          : `## Additional story context\n\n${appendage}`
      })()
    }
    // ToDo item 163 — per-character model resolution for character /
    // two-character chats. The thread-level `profile.id` / `model` are
    // the fallback. When the active character (or the current speaker
    // in a two-character turn) has a `model_id_override` set via the
    // gear menu, use that instead so each character's gear pick
    // actually takes effect on the wire. Falls back to the thread-
    // level pair when no override exists. Regular chats land in this
    // resolution with no character meta and use thread-level
    // unchanged.
    let _streamProfileId = profile.id
    let _streamModel = model
    if (_twoCharCtx) {
      const ov = _twoCharCtx.speaker?.model_id_override
      if (ov?.profile_id && ov?.model) {
        _streamProfileId = ov.profile_id
        _streamModel = ov.model
      }
    } else if (characterChatMeta) {
      const ov = characterChatMeta.model_id_override
      if (ov?.profile_id && ov?.model) {
        _streamProfileId = ov.profile_id
        _streamModel = ov.model
      }
    }
    // ToDo item 163 — Preview branch. Same wire-build code above
    // ran. Instead of dispatching the streamChat request, hand the
    // assembled payload to the preview destination and return. No
    // assistant placeholder was persisted (gated by isPreview), no
    // SSE pump runs, no result persistence runs.
    if (isPreview) {
      previewOpts.onPreview({
        profileId: _streamProfileId,
        model: _streamModel,
        messages: wireMessages,
        systemPrompt: composedSystemPrompt,
        attachments: wireAttachments,
        reasoningLevel,
        reasoningSummary,
      })
      return null
    }
    try {
      try {
        for await (const event of streamChat({
          profileId: _streamProfileId,
          model: _streamModel,
          messages: wireMessages,
          systemPrompt: composedSystemPrompt,
          attachments: wireAttachments,
          reasoningLevel,
          reasoningSummary,
          // Main chat is the only surface that opts into tools; the
          // backend still gates on the connection's mcp_enabled.
          enableTools: true,
          signal: controller.signal,
        })) {
          if (event.type === 'delta' && event.text) {
            accumulated += event.text
            pendingContentDirty = true
            scheduleFlush()
          } else if (event.type === 'end') {
            // Phase 2.5f legacy: some adapters ship the full text only
            // on the terminal event. Seed `accumulated` then so the
            // bubble has content even though no `delta` events arrived.
            if (event.text && !accumulated) {
              accumulated = event.text
              pendingContentDirty = true
              forceFlush()
            }
            // Phase 2.5i — terminal cache-hit report. Adapters that
            // can report (OpenAI-compatible, OpenRouter) set the field
            // from the final streaming usage chunk; adapters that can't
            // (LM Studio per upstream bug 778) leave it None.
            if (typeof event.cached_input_tokens === 'number') {
              setLatestCachedTokens(event.cached_input_tokens)
            }
          } else if (event.type === 'reasoning_delta' && event.text) {
            // Phase 2.5f — assistant's chain-of-thought chunk.
            // Accumulated into a SEPARATE buffer from `content` so
            // the bubble's disclosure widget (item 12) renders it
            // distinctly and so subsequent turns never re-send it
            // as part of `content`.
            reasoningAccumulated += event.text
            pendingReasoningDirty = true
            scheduleFlush()
          } else if (event.type === 'reasoning_end') {
            // Final reasoning snapshot. If the adapter shipped the
            // full text only here (some adapters don't deltaify
            // reasoning), seed it now. Token-count + duration are
            // footer metadata for the disclosure widget. Force-flush
            // here so the metadata patch lands together with any
            // pending text rather than racing against the next rAF.
            if (typeof event.text === 'string' && event.text && !reasoningAccumulated) {
              reasoningAccumulated = event.text
              pendingReasoningDirty = true
            }
            if (typeof event.reasoning_token_count === 'number') {
              reasoningTokenCount = event.reasoning_token_count
            }
            if (typeof event.reasoning_duration_ms === 'number') {
              reasoningDurationMs = event.reasoning_duration_ms
            }
            forceFlush()
            updateLocalMessage(threadId, assistantMessage.id, {
              reasoning_text: reasoningAccumulated,
              reasoning_token_count: reasoningTokenCount,
              reasoning_duration_ms: reasoningDurationMs,
            })
          } else if (event.type === 'tool_call') {
            forceFlush()
            recordToolCall(event)
          } else if (event.type === 'image') {
            forceFlush()
            recordImageEvent(event)
          } else if (event.type === 'error') {
            streamError = event.detail || 'Unknown error'
          }
        }
      } catch (e) {
        // Stream-pump exceptions become an inline error event so the
        // outer flow still runs the persistence step and clears the
        // streaming flag at the end.
        streamError = streamError || (e && e.message) || 'Stream failed'
      }

      // Drain any final buffered tokens before we evaluate persistence.
      forceFlush()

      if (streamError) setError(streamError)

      // Persist the assistant message if we have anything worth
      // keeping — accumulated content OR at least one tool call ran
      // OR at least one image came back OR the model emitted some
      // reasoning text (rare but possible if the writer cancelled
      // mid-think; we still want a record of what the model thought
      // before the cancel). A cancelled stream with no output, tool
      // calls, images, or reasoning drops cleanly with no on-disk
      // record.
      if (accumulated || toolCalls.length > 0 || receivedImages.length > 0 || reasoningAccumulated) {
        const finalMessage = {
          ...assistantMessage,
          content: accumulated,
          timestamp: new Date().toISOString(),
          tool_calls: toolCalls,
          attachments: receivedImages,
          reasoning_text: reasoningAccumulated || '',
          reasoning_token_count: reasoningTokenCount,
          reasoning_duration_ms: reasoningDurationMs,
        }
        useConversationsStore.setState((s) => {
          const t = s.byId[threadId]
          if (!t) return s
          return {
            byId: { ...s.byId, [threadId]: { ...t, messages: t.messages.filter((m) => m.id !== assistantMessage.id) } },
          }
        })
        await appendMessage(threadId, finalMessage)
        // Phase 2.12 — `next_turn_index` is no longer write-back-
        // synced post-stream. The next-speaker resolution at the
        // start of `streamAssistantReply` now derives "who spoke
        // last" from the history's `speaker_character_id` fields,
        // which naturally handles deletions, retries (no override
        // needed — the deleted-tail history points at the correct
        // prior speaker), and dual-button mode (clicked button
        // overrides via `speakerCharacterIdOverride`). The field
        // stays on the Pydantic model for save-format-compat with
        // legacy threads, but no live code reads or writes it.
        return accumulated
      }
      // Drop the empty stub.
      useConversationsStore.setState((s) => {
        const t = s.byId[threadId]
        if (!t) return s
        return {
          byId: { ...s.byId, [threadId]: { ...t, messages: t.messages.filter((m) => m.id !== assistantMessage.id) } },
        }
      })
      return null
    } finally {
      setStreaming(false)
      abortRef.current = null
      streamingMessageIdRef.current = null
    }
  }, [profile, model, threadId, appendLocalMessage, updateLocalMessage, appendMessage, activeSystemPrompt])

  // Queued user messages — written to while a stream is in flight,
  // then drained as a single combined send once the assistant
  // finishes. Mirrors the dashed faded bubbles below the streaming
  // response so the writer can see what's lined up. The ref keeps
  // the latest queue value visible inside the flush effect without
  // making the effect depend on `queuedMessages` (which would
  // re-fire mid-flush and risk a double-send).
  const [queuedMessages, setQueuedMessages] = useState([])
  const queueRef = useRef([])
  useEffect(() => { queueRef.current = queuedMessages }, [queuedMessages])
  function removeFromQueue(index) {
    setQueuedMessages((q) => q.filter((_, i) => i !== index))
  }

  // Core send flow, parameterised by the text to send. Used by the
  // regular Send button and by the queue-flush effect (which calls
  // it with the joined queued messages once the previous stream
  // finishes).
  const sendText = useCallback(async (text, opts) => {
    // ToDo item 163 — Preview destination. When `opts.onPreview` is
    // supplied, sendText runs the same context-diff + virtual-history
    // assembly it always runs, BUT skips every persistence side
    // effect: no system_context appendMessage, no user appendMessage,
    // no attachment encoding, no chip-clear. Builds an in-memory
    // virtual thread and passes it to streamAssistantReply (also in
    // preview mode), which routes the assembled wire payload to
    // `opts.onPreview` instead of dispatching to streamChat.
    //
    // Two preview shapes:
    //   - opts.includeHistory === true  → virtual history =
    //                                     thread.messages +
    //                                     synthetic system_context +
    //                                     synthetic user.
    //   - opts.includeHistory === false → virtual history =
    //                                     synthetic system_context +
    //                                     synthetic user (no prior
    //                                     thread turns).
    //
    // An empty draft is rendered as the placeholder "[no message
    // typed yet]" so writers can preview the standing system + context
    // without having to type something first.
    const isPreview = !!(opts && typeof opts.onPreview === 'function')
    if (!profile || !model || !threadId || !thread) return
    const rawText = (text || '').trim()
    const trimmed = isPreview ? (rawText || '[no message typed yet]') : rawText
    // Phase 2.12 — in two-character mode, empty composer text is a
    // legitimate Send (advances the turn without injecting an inline
    // system message). In regular and single-character chats, empty
    // text still early-returns per the existing rule.
    const _twoCharForEmptyCheck = !!thread?.two_character_chat
    if (!isPreview && !rawText && !_twoCharForEmptyCheck) return
    setError(null)
    const messages = thread.messages || []

    // ── Preview branch ──────────────────────────────────────────────
    // Builds synthetic system_context + synthetic user message in
    // memory (no persistence). Calls streamAssistantReply with the
    // virtual history + preview destination so the wire payload gets
    // assembled by the exact same code the real send uses.
    if (isPreview) {
      const includeHistory = opts.includeHistory !== false
      const ui = useUiStore.getState()
      const ps = useProjectStore.getState()
      const stickyId = ui.chatActiveSceneId
      const sceneExists = stickyId
        ? (ps.nodes || []).some((n) => n.id === stickyId && n.type === 'sceneNode')
        : false
      const sceneOn = !!(ui.chatSceneContextEnabled && sceneExists)
      const ctxSceneId = sceneOn ? stickyId : null
      const ctxPinned = _sortPinsByChainPosition(usePinnedContextStore.getState().getPins(`chat:${threadId}`), ps)
      let syntheticSystemContext = null
      try {
        const ctxBlocks = await computeContextDiff(thread, ctxSceneId, ctxPinned)
        if (ctxBlocks && ctxBlocks.length > 0) {
          syntheticSystemContext = {
            id: newMessageId(),
            role: 'system_context',
            content: '',
            timestamp: new Date().toISOString(),
            pinned: false,
            context_sticky: false,
            collapsed: false,
            render_mode: null,
            tool_calls: [],
            blocks: ctxBlocks,
          }
        }
      } catch { /* skip on error */ }
      // Phase 2.12 — preview must mirror the real-send two-character
      // path: the writer's composer text DOES NOT become a synthetic
      // user message in the virtual history. Instead it rides through
      // `twoCharOpts.inlineSystemText`, where `streamAssistantReply`
      // wraps it in the `<director>` block and appends it as a
      // `{role: 'user', ...}` entry at the END of the assembled
      // payload. Without this branch the preview shows the writer's
      // text as a bare user message and the `<director>` framing
      // never appears.
      const _isTwoCharPreview = !!thread?.two_character_chat
      if (_isTwoCharPreview) {
        const virtualHistory = includeHistory
          ? [...messages, ...(syntheticSystemContext ? [syntheticSystemContext] : [])]
          : [...(syntheticSystemContext ? [syntheticSystemContext] : [])]
        // Match the real send's behaviour: empty composer is allowed
        // (advances the turn with no director cue). The placeholder
        // `[no message typed yet]` we substituted in `trimmed` above
        // would otherwise turn an empty composer preview into a
        // misleading "the writer typed nothing yet" cue — strip back
        // to the bare draft and let inlineSystemText be empty so the
        // wire-builder skips the `<director>` block.
        const _cueText = rawText
        const _twoCharOpts = _cueText ? { inlineSystemText: _cueText } : {}
        await streamAssistantReply(virtualHistory, [], { onPreview: opts.onPreview }, _twoCharOpts)
        return
      }
      const syntheticUser = {
        id: newMessageId(),
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
        pinned: false,
        collapsed: false,
        attachments: [],
      }
      const virtualHistory = includeHistory
        ? [...messages, ...(syntheticSystemContext ? [syntheticSystemContext] : []), syntheticUser]
        : [...(syntheticSystemContext ? [syntheticSystemContext] : []), syntheticUser]
      await streamAssistantReply(virtualHistory, [], { onPreview: opts.onPreview })
      return
    }

    // Duplicate-suppression: if the most recent user message in the
    // thread has identical content, treat this send as a Resend —
    // drop any subsequent assistant reply and re-stream from the
    // existing user message instead of appending a second visually
    // identical bubble. Keeps the thread tidy without making the
    // writer think about it.
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx >= 0 && messages[lastUserIdx].content === trimmed) {
      const tail = messages.slice(lastUserIdx + 1)
      for (const m of tail) {
         
        await deleteMessageAct(threadId, m.id)
      }
      // Resend should refresh the conversation's context against the
      // writer's CURRENT pinned state (pins may have changed between
      // the original send and the resend). computeContextDiff walks
      // the thread's prior system_context blocks and emits diff /
      // full / removed blocks against the new pinned set. If there's
      // any change the new system_context gets appended BEFORE the
      // existing user message in the wire (system_context blocks ride
      // as a prefix on the next user message at wire-build time;
      // re-streaming with the same user message picks them up).
      try {
        const ui = useUiStore.getState()
        const ps = useProjectStore.getState()
        const stickyId = ui.chatActiveSceneId
        const sceneExists = stickyId
          ? (ps.nodes || []).some((n) => n.id === stickyId && n.type === 'sceneNode')
          : false
        const sceneOn = !!(ui.chatSceneContextEnabled && sceneExists)
        const ctxSceneId = sceneOn ? stickyId : null
        const ctxPinned = _sortPinsByChainPosition(usePinnedContextStore.getState().getPins(`chat:${threadId}`), ps)
        const liveThreadForDiff = useConversationsStore.getState().byId[threadId] || { messages: messages.slice(0, lastUserIdx + 1) }
        const ctxBlocks = await computeContextDiff(liveThreadForDiff, ctxSceneId, ctxPinned)
        if (ctxBlocks && ctxBlocks.length > 0) {
          await appendMessage(threadId, {
            id: newMessageId(),
            role: 'system_context',
            content: '',
            timestamp: new Date().toISOString(),
            pinned: false,
            context_sticky: false,
            collapsed: false,
            render_mode: null,
            tool_calls: [],
            blocks: ctxBlocks,
          })
        }
      } catch { /* skip on error */ }
      // Pass full message objects (not pre-mapped); streamAssistantReply
      // applies the rolling-window cap + sticky-favourite preservation
      // before mapping to {role, content}.
      const liveThread = useConversationsStore.getState().byId[threadId] || { messages: messages.slice(0, lastUserIdx + 1) }
      const history = liveThread.messages || messages.slice(0, lastUserIdx + 1)
      await streamAssistantReply(history)
      return
    }

    // Phase 2.5d — emit a `system_context` message into the thread
    // BEFORE the new user message, if the writer's currently-in-
    // force context set has changed since the last stored
    // emission. Per-part state-machine diffing decides whether to
    // emit `*_full` / `*_diff` / `*_removed` blocks. Stored only;
    // the wire builder consumes these blocks in a later 2.5d item.
    try {
      const ui = useUiStore.getState()
      const ps = useProjectStore.getState()
      // Strict gate per writer requirement: scene context only
      // rides with a message when (a) the toggle is ON in state AND
      // (b) `chatActiveSceneId` resolves to a real scene node in
      // the CURRENT project. (b) defends against stale sticky id
      // from a prior session / different project / deleted scene.
      // Without (b), the toggle's auto-on effect could engage on a
      // ghost id and emit a scene_full block referencing a scene
      // that doesn't exist.
      const stickyId = ui.chatActiveSceneId
      const sceneExists = stickyId
        ? (ps.nodes || []).some((n) => n.id === stickyId && n.type === 'sceneNode')
        : false
      const sceneOn = !!(ui.chatSceneContextEnabled && sceneExists)
      const ctxSceneId = sceneOn ? stickyId : null
      // Sort same-(kind, id) pins by their chain position so the
      // model receives state in narrative order (e.g. Adam at origin
      // → Adam at scene 3 → Adam at scene 7), not in click order.
      const ctxPinned = _sortPinsByChainPosition(usePinnedContextStore.getState().getPins(`chat:${threadId}`), ps)
      const ctxBlocks = await computeContextDiff(thread, ctxSceneId, ctxPinned)
      if (ctxBlocks && ctxBlocks.length > 0) {
        await appendMessage(threadId, {
          id: newMessageId(),
          role: 'system_context',
          content: '',
          timestamp: new Date().toISOString(),
          pinned: false,
          context_sticky: false,
          collapsed: false,
          render_mode: null,
          tool_calls: [],
          blocks: ctxBlocks,
        })
      }
    } catch (err) {
      // Skip persisting the system_context diff on error; the fresh-build
      // sceneContextBlock path in streamAssistantReply still delivers the
      // current context to the model for this turn. Log it so a silent
      // context-diff failure (a suspected cause of pinned context not
      // reaching the model on later turns) is diagnosable.
      try {
        console.warn('[context] computeContextDiff failed; system_context diff not persisted this turn', err)
      } catch { /* never let logging break the send */ }
    }

    // Phase 2.5e — encode staged attachments BEFORE we append the
    // user message + clear staging, so a transient encode failure
    // can't leave the writer's files orphaned. Failure surfaces as
    // a transient alert and the send is aborted (chips persist for
    // retry). Image resizing happens inside the encoder per
    // Anthropic's published vision guidance (1568 px on long edge).
    const stagedAttachments = useUiStore.getState().chatAttachmentStaging?.[threadId] || []
    let wireAttachments = []
    if (stagedAttachments.length > 0) {
      try {
        wireAttachments = await encodeAttachmentsForWire(stagedAttachments)
      } catch (err) {
        useUiStore.getState().showTransientAlert(
          `Could not prepare attachment${stagedAttachments.length === 1 ? '' : 's'} for sending: ${err?.message || 'encode failed'}`,
        )
        return
      }
    }

    // Build the persisted-on-message form. Images carry their
    // post-resize data URL (so the bubble thumbnail survives
    // reloads); text-kind attachments carry their decoded UTF-8
    // content (so the bubble's pill can open the file in the
    // editor panel in read-only mode); file-kind attachments
    // persist metadata only since their content rode the wire
    // once and isn't needed for replay.
    const storedAttachments = wireAttachments.map((a) => {
      const size = _approxDataSize(a.data_base64)
      const record = {
        kind: a.kind,
        name: a.name,
        mime_type: a.mime_type,
        size,
        data_url: a.kind === 'image' ? `data:${a.mime_type};base64,${a.data_base64}` : null,
        text_content: null,
      }
      if (a.kind === 'text') {
        try {
          record.text_content = _decodeBase64Utf8(a.data_base64)
        } catch {
          // Decode failure leaves text_content null; the pill
          // renders non-clickable rather than crashing.
        }
      }
      return record
    })

    // Phase 2.11b item 12 — stamp the current anchor on the message
    // when this is a character chat. Hash drives the re-anchor
    // divider in the message list (when consecutive char-chat
    // messages disagree); label is the writer-visible span text
    // captured at send time so the divider doesn't have to
    // re-resolve against drifting project state. Regular threads
    // leave both fields null.
    const _charChatNow = thread?.character_chat || null
    const _anchorHash = _charChatNow ? hashAnchorSpec(_charChatNow.anchor_spec) : null
    const _anchorLabel = _charChatNow
      ? formatAnchorSpan(_charChatNow.anchor_spec, useProjectStore.getState().nodes || [])
      : null
    // Phase 2.12 — in two-character mode the composer text DOES NOT
    // become a persisted user message. Instead it rides as a one-shot
    // inline system message into the next turn's wire payload (see
    // `streamAssistantReply`'s `twoCharOpts.inlineSystemText` path).
    // Empty composer text is allowed and simply advances the turn
    // without injecting any system message. The writer's stage
    // direction is fire-and-forget — not displayed in the message
    // list, not counted against the history limit, not persisted on
    // the thread.
    const _isTwoCharacterChat = !!thread?.two_character_chat
    if (_isTwoCharacterChat) {
      useUiStore.getState().clearChatAttachments(threadId)
      const liveThreadForTwoChar = useConversationsStore.getState().byId[threadId] || thread
      const historyForTwoChar = liveThreadForTwoChar?.messages || messages
      // Phase 2.12f — in dual-button mode the writer picks WHICH
      // character takes the next turn. The character_id ride
      // through `opts.speakerCharacterIdOverride` so
      // `streamAssistantReply` fires the requested character
      // regardless of the natural alternation. In single-button
      // manual mode and auto-send, no override is passed and the
      // history-derivation in `streamAssistantReply` picks the
      // last-not-spoken character.
      const _twoCharOpts = { inlineSystemText: trimmed }
      if (opts && opts.speakerCharacterIdOverride) {
        _twoCharOpts.speakerCharacterIdOverride = opts.speakerCharacterIdOverride
      }
      await streamAssistantReply(
        historyForTwoChar,
        wireAttachments,
        null,
        _twoCharOpts,
      )
      return
    }
    const userMessage = {
      id: newMessageId(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
      pinned: false,
      collapsed: false,
      attachments: storedAttachments,
      anchor_dossier_hash: _anchorHash,
      anchor_label: _anchorLabel,
    }
    const afterUser = await appendMessage(threadId, userMessage)
    if (!afterUser) {
      setError('Failed to send message.')
      return
    }
    // Phase 2.5e — clear the attachment chip row now that the
    // user message has been successfully appended. On send failure
    // (the early-return above) the chips persist so the writer can
    // retry without re-attaching.
    useUiStore.getState().clearChatAttachments(threadId)
    // Re-read the thread from the store so the just-appended
    // system_context message (and the just-appended user message)
    // are in the history passed to the wire builder. The closure's
    // `messages` was captured before both appends.
    const liveThread = useConversationsStore.getState().byId[threadId] || thread
    const conversationHistory = liveThread?.messages || [...messages, userMessage]
    await streamAssistantReply(conversationHistory, wireAttachments)
  }, [profile, model, threadId, thread, appendMessage, deleteMessageAct, streamAssistantReply])

  // The Send-button entry point. If a stream is in flight, the
  // typed text is appended to the queue and the input clears so
  // the writer can keep typing; the queued message renders as a
  // dashed faded bubble below the streaming AI message. The flush
  // effect drains the queue (joined with paragraph breaks) into
  // sendText once streaming wraps up.
  const send = useCallback((opts) => {
    // Phase 2.12 — in two-character mode, empty composer Send is
    // legitimate: it advances the turn without injecting a stage
    // direction. Regular + single-character chats keep the existing
    // non-empty requirement so the writer's user message has content.
    // Phase 2.12f — `opts.speakerCharacterIdOverride` is set when
    // the writer clicks one of the dual-button mode's two Send
    // buttons; threaded through to `sendText` so `streamAssistantReply`
    // fires the requested character.
    const _isTwoCharForSend = !!thread?.two_character_chat
    if (!profile || !model || !threadId || !thread) return
    if (!_isTwoCharForSend && !prompt.trim()) return
    const trimmed = prompt.trim()
    if (trimmed) {
      // Flush any pending auto-attach before the message goes out: a
      // name typed inside the last 500ms (the debounce window) would
      // otherwise never be scanned before the wire is built. addPin is
      // synchronous, so the names are pinned in time for sendText
      // (covers both the immediate send and a queued send).
      runAutoAttachScan(trimmed)
    }
    if (streaming) {
      // Queueing requires actual text — empty queued sends would just
      // pile up no-ops. Two-character empty sends fire only when not
      // streaming.
      if (!trimmed) return
      setQueuedMessages((q) => [...q, trimmed])
      setPrompt('')
      return
    }
    setPrompt('')
    const sendOpts = opts && opts.speakerCharacterIdOverride
      ? { speakerCharacterIdOverride: opts.speakerCharacterIdOverride }
      : undefined
    void sendText(trimmed, sendOpts)
  }, [profile, model, prompt, streaming, threadId, thread, sendText, runAutoAttachScan])

  // Phase 2.12f items 207 + 208 — Auto-send loop driver. When the
  // writer flips auto mode ON and clicks Start, this effect drives
  // the back-and-forth: each time the prior turn wraps up, fire the
  // next one (history-derived alternation — no explicit speaker
  // override) and decrement the counter. When the counter reaches
  // 0, halt the loop and revert to the saved manual mode visually
  // (the persisted `composer_mode` is untouched, so closing the
  // overlay just lands back on Single or Dual depending on what was
  // saved).
  //
  // Stop semantics: clicking Stop sets `autoSendActive` to false.
  // The in-flight turn keeps streaming — we don't cancel it — but
  // the effect no longer fires the next turn when streaming wraps.
  // Matches the ToDo spec: "The writer can stop auto-send mid-run
  // via the same toggle; the in-flight turn finishes, the loop
  // halts."
  //
  // Race control: the effect only fires a new turn when both
  // `autoSendActive` AND `!streaming` are true. Once `sendText`
  // kicks off (synchronously calls `setStreaming(true)` inside
  // `streamAssistantReply`), the effect re-runs with `streaming`
  // true and returns early — no double-fire.
  //
  // Gating: every check gates on `thread?.two_character_chat` non-
  // null. Single-character and regular chats can never enter this
  // path (Rule 4).
  useEffect(() => {
    if (!autoSendActive) return
    if (!thread?.two_character_chat) return
    if (streaming) return
    if (autoSendCount <= 0) {
      // Counter hit 0 — halt the loop AND drop the auto-mode UI
      // overlay so the composer reverts to the saved manual mode.
      setAutoSendActive(false)
      setTwoCharAutoMode(false)
      return
    }
    // Fire the next turn. Decrement BEFORE the send so a fast
    // re-render with `streaming` true doesn't double-decrement.
    setAutoSendCount((c) => Math.max(0, c - 1))
    // Empty composer text (auto-send is hands-off — the writer
    // isn't typing per-turn cues), no speaker override (history
    // derivation picks the natural-next character).
    void sendText('')
  }, [autoSendActive, streaming, autoSendCount, thread?.two_character_chat, sendText])

  // Phase 2.12f item 207 — Start/Stop the auto-send loop. The
  // editable counter lives in its own `setAutoSendCount` setter
  // attached to the number input.
  const toggleAutoSend = useCallback(() => {
    if (!thread?.two_character_chat) return
    if (autoSendActive) {
      // Halt — in-flight turn finishes naturally; loop stops.
      setAutoSendActive(false)
      return
    }
    // Start. If the counter was somehow at 0 (writer manually set
    // to 0 or a prior loop ended), bump it back to the spec default
    // so Start always does something useful.
    if (autoSendCount <= 0) setAutoSendCount(10)
    setAutoSendActive(true)
  }, [thread, autoSendActive, autoSendCount])

  // ToDo item 163 — Preview Message dispatch. While the modal is
  // open, run sendText in preview mode whenever the mode or draft
  // changes. Cancellable so a fast mode-flip can't race a stale
  // payload into state. The dispatcher mirrors what the Send button
  // does, only the destination differs: streamChat → setPreviewPayload.
  useEffect(() => {
    if (!previewOpen) return undefined
    let cancelled = false
    setPreviewPayload(null)
    void sendText(previewDraft, {
      includeHistory: previewMode === 'with-history',
      onPreview: (payload) => {
        if (!cancelled) setPreviewPayload(payload)
      },
    })
    return () => { cancelled = true }
  }, [previewOpen, previewMode, previewDraft, sendText])

  // Drain the queue once streaming ends. Joined with double newlines
  // so distinct queued messages read as separate paragraphs to the
  // model — closer to the writer's mental model of "I sent these
  // one after another" than running them all into one line.
  useEffect(() => {
    if (streaming) return
    if (queuedMessages.length === 0) return
    const combined = queuedMessages.join('\n\n')
    setQueuedMessages([])
    void sendText(combined)
  }, [streaming, queuedMessages, sendText])

  // Retry an assistant message: delete that message + anything
  // after, then re-stream a fresh reply from the same preceding
  // user message. Used by the bubble overflow `···` menu (AI only).
  const retryMessage = useCallback(async (messageId) => {
    if (streaming || !threadId || !thread) return
    const messages = thread.messages || []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = messages[idx]
    if (target.role !== 'assistant') return
    setError(null)
    // Delete the assistant message + everything that came after it.
    const toDelete = messages.slice(idx)
    for (const m of toDelete) {
       
      await deleteMessageAct(threadId, m.id)
    }
    const history = messages.slice(0, idx)
    // Phase 2.12 — in two-character mode, the speaker derivation now
    // walks the post-deletion `history` backwards to find the most
    // recent `speaker_character_id`. The OTHER character speaks next.
    // For retry, the post-deletion history's last speaker is whoever
    // spoke BEFORE the target — so the derived next speaker is the
    // SAME character whose bubble was being retried. No explicit
    // override needed.
    await streamAssistantReply(history)
  }, [streaming, threadId, thread, deleteMessageAct, streamAssistantReply])

  // Edit + resubmit a user message: persist the new content,
  // delete every later message in the thread, then re-stream a
  // fresh assistant reply. AI message editing uses a separate
  // text-only path (see saveAssistantEdit below).
  const editUserAndResubmit = useCallback(async (messageId, newContent) => {
    if (streaming || !threadId || !thread) return
    const messages = thread.messages || []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = messages[idx]
    if (target.role !== 'user') return
    const hasFollowing = idx < messages.length - 1
    if (hasFollowing) {
      const choice = await confirmDialog({
        title: 'Resubmit edited message',
        message: 'Editing will remove all messages after this point and resend.',
        buttons: [
          { label: 'Cancel', value: 'cancel', style: 'secondary' },
          { label: 'Resubmit', value: 'resubmit', style: 'primary' },
        ],
      })
      if (choice !== 'resubmit') return
    }
    setError(null)
    // Patch the user message content first so the disk copy reflects
    // the edit even if the stream is later cancelled. `edited_at`
    // stamps the message so the bubble header annotates "<Edited
    // DTS>" — also set here even though the immediate effect of a
    // resubmit is a fresh reply that supersedes the prior tail.
    const editedAt = new Date().toISOString()
    await persistPatch(threadId, messageId, { content: newContent, edited_at: editedAt })
    // Drop every message that came after — they belong to the old
    // branch of the conversation.
    const after = messages.slice(idx + 1)
    for (const m of after) {
       
      await deleteMessageAct(threadId, m.id)
    }
    const history = [
      ...messages.slice(0, idx),
      { ...target, content: newContent, edited_at: editedAt },
    ]
    await streamAssistantReply(history)
  }, [streaming, threadId, thread, persistPatch, deleteMessageAct, streamAssistantReply])

  // Phase 2.5 follow-up — save a user-message edit WITHOUT resubmitting.
  // The downstream messages stay intact; only the user message's
  // content + `edited_at` change. Used by the "Save" button next to
  // the Resubmit button in the user-message inline editor.
  const editUserSaveOnly = useCallback(async (messageId, newContent) => {
    if (!threadId) return
    await persistPatch(threadId, messageId, { content: newContent, edited_at: new Date().toISOString() })
  }, [threadId, persistPatch])

  // Save an inline-edited assistant message. Text cleanup only —
  // never re-streams, never touches surrounding messages. Also stamps
  // `edited_at` so the bubble header reflects the edit.
  const saveAssistantEdit = useCallback(async (messageId, newContent) => {
    if (!threadId) return
    await persistPatch(threadId, messageId, { content: newContent, edited_at: new Date().toISOString() })
  }, [threadId, persistPatch])

  // Resend a user message verbatim. Mirrors Retry on AI messages —
  // drops any subsequent messages and re-streams a fresh reply from
  // this message's existing content. Prompts to confirm when there's
  // a tail to discard so the writer doesn't lose work by accident.
  const resendUserMessage = useCallback(async (messageId) => {
    if (streaming || !threadId || !thread) return
    const messages = thread.messages || []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = messages[idx]
    if (target.role !== 'user') return
    const hasFollowing = idx < messages.length - 1
    if (hasFollowing) {
      const choice = await confirmDialog({
        title: 'Resend message',
        message: 'Resending will remove all messages after this point and stream a fresh reply.',
        buttons: [
          { label: 'Cancel', value: 'cancel', style: 'secondary' },
          { label: 'Resend', value: 'resend', style: 'primary' },
        ],
      })
      if (choice !== 'resend') return
    }
    setError(null)
    const after = messages.slice(idx + 1)
    for (const m of after) {
       
      await deleteMessageAct(threadId, m.id)
    }
    const history = messages.slice(0, idx + 1)
    await streamAssistantReply(history)
  }, [streaming, threadId, thread, deleteMessageAct, streamAssistantReply])

  // Set the favourite-star state on a message. Tri-state cycle:
  //   off ({pinned:false, context_sticky:false})
  //     → favourite ({pinned:true, context_sticky:false})
  //       → favourite + sticky ({pinned:true, context_sticky:true})
  //         → off (full clear)
  // Left-click in MessageBubble advances one step in the cycle by
  // computing the next state and calling this action; right-click
  // calls it with {pinned:false, context_sticky:false} for a hard
  // clear regardless of the current state.
  //
  // Sticky semantics: when a message has `context_sticky=true` AND
  // `pinned=true`, the wire builder includes it regardless of the
  // rolling-window cap (in addition to the regular N user/assistant
  // turns). Clearing pinned also clears sticky here — they can't
  // coexist independently.
  //
  // Over-5 warning: when the writer is about to flip sticky ON and
  // the resulting sticky count would exceed 5, a confirmation
  // dialog runs first. The dialog includes a "stop warning this
  // session" option that flips `chatStickyWarningSuppressed` in
  // uiStore.
  const setStarState = useCallback(async (messageId, nextState) => {
    if (!threadId || !thread) return
    const target = (thread.messages || []).find((m) => m.id === messageId)
    if (!target) return
    const nextPinned = !!nextState.pinned
    const nextSticky = !!nextState.context_sticky && nextPinned
    const isAddingSticky = nextSticky && !target.context_sticky
    if (isAddingSticky) {
      const ui = useUiStore.getState()
      if (!ui.chatStickyWarningSuppressed) {
        const stickyCount = (thread.messages || []).filter((m) => m && m.context_sticky).length
        const willBeSticky = stickyCount + 1
        if (willBeSticky > 5) {
          const limit = ui.chatHistoryWindowN
          const limitLabel = limit == null
            ? '(all messages: uncapped)'
            : `${limit}`
          const totalLabel = limit == null
            ? `${willBeSticky} pinned + every message`
            : `${willBeSticky} pinned + ${limit} regular = ${willBeSticky + limit} messages`
          // Closure variable the dialog's checkbox writes back to via
          // its onChange callback; we read it after the dialog
          // resolves so a real <input type="checkbox"> controls the
          // suppression flag instead of a third button.
          let suppressRequested = false
          const summary =
            `You'll have ${willBeSticky} pinned favourite${willBeSticky === 1 ? '' : 's'} after this. Pinned favourites are always sent with every message, in addition to your message-history limit.\n\n` +
            `Your message-history limit is ${limitLabel}.\n` +
            `After this change, ${totalLabel} will be sent with every request.\n\n` +
            `Each extra pinned favourite means noticeably more tokens with every message you send.`
          const choice = await confirmDialog({
            title: 'Adding more pinned favourites',
            message: <PinnedWarningBody summary={summary} onSuppressChange={(v) => { suppressRequested = v }} />,
            buttons: [
              { label: 'Cancel', value: 'cancel', style: 'neutral' },
              { label: 'Pin it', value: 'confirm', style: 'primary' },
            ],
            cancelValue: 'cancel',
          })
          if (choice === 'cancel') return
          if (suppressRequested) {
            useUiStore.getState().setChatStickyWarningSuppressed(true)
          }
        }
      }
    }
    await persistPatch(threadId, messageId, {
      pinned: nextPinned,
      context_sticky: nextSticky,
    })
  }, [threadId, thread, persistPatch])

  // Fork from a message: create a new thread pre-loaded with the
  // history up to AND including the clicked message, then make it
  // the active conversation. Per the Phase 2.4 spec this replaces
  // the current session (the source thread keeps its own saved
  // copy on disk — only the active view switches).
  const forkFromMessage = useCallback(async (messageId) => {
    if (streaming || !threadId || !thread) return
    const messages = thread.messages || []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const choice = await confirmDialog({
      title: 'Fork conversation',
      message: 'This will start a new conversation from that point. The current conversation will be cleared from the panel (its saved copy stays in the thread browser).',
      buttons: [
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
        { label: 'Fork', value: 'fork', style: 'primary' },
      ],
    })
    if (choice !== 'fork') return
    const slice = messages.slice(0, idx + 1)
    const created = await createThread({
      name: `${thread.name || 'Conversation'} (fork)`,
      profile_id: thread.profile_id || null,
      model: thread.model || null,
      system_prompt_id: thread.system_prompt_id || null,
      // Phase 2.12 — character + two-character chat metadata MUST
      // ride the fork verbatim. Without these the forked thread
      // drops back to a regular chat, losing each persona's
      // anchor_spec, persona prompt, model override, temp fields,
      // custom instructions, and (for two-character) the entire
      // dual-character setup. Mutually exclusive on the source
      // thread, so at most one is non-null.
      character_chat: thread.character_chat || null,
      two_character_chat: thread.two_character_chat || null,
    })
    if (!created) {
      setError('Failed to fork conversation.')
      return
    }
    for (const m of slice) {
       
      await appendMessage(created.id, { ...m, id: newMessageId() })
    }
  }, [streaming, threadId, thread, createThread, appendMessage])

  // Delete a message. User messages prompt for confirmation and
  // also remove the paired AI reply that immediately follows
  // (if there is one). Assistant messages delete silently.
  const deleteOneMessage = useCallback(async (messageId) => {
    if (!threadId || !thread) return
    const messages = thread.messages || []
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = messages[idx]
    if (target.role === 'user') {
      const paired = messages[idx + 1]
      const willCascade = paired && paired.role === 'assistant'
      const choice = await confirmDialog({
        title: 'Delete message',
        message: willCascade
          ? 'Delete this message and the AI reply that followed?'
          : 'Delete this message?',
        buttons: [
          { label: 'Cancel', value: 'cancel', style: 'secondary' },
          { label: 'Delete', value: 'delete', style: 'danger' },
        ],
      })
      if (choice !== 'delete') return
      if (willCascade) await deleteMessageAct(threadId, paired.id)
      await deleteMessageAct(threadId, messageId)
    } else {
      await deleteMessageAct(threadId, messageId)
    }
  }, [threadId, thread, deleteMessageAct])

  function cancel() {
    abortRef.current?.abort()
  }

  // Used by the Send-disabled tooltip + the placeholder text.
  const cantSendReason = !profile
    ? 'No AI connection configured. Open Settings → MCP & API Connections to add one.'
    : !model
      ? 'No model selected.'
      : !prompt.trim()
        ? null
        : null

  // Phase 2.4 chat-input keybind preference. null / true → Enter
  // sends, Shift+Enter or Ctrl+Enter inserts a newline. False →
  // Ctrl+Enter sends, Enter inserts a newline. Controlled from
  // Program Settings → Application → "AI chat input keybind".
  const sendOnEnter = prefs.chat_send_on_enter !== false
  const placeholderHint = sendOnEnter
    ? '(Enter to send, Shift+Enter for newline)'
    : '(Ctrl+Enter to send, Enter for newline)'

  return (
    <div data-help-region="conversation:panel" className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
        <div
          ref={listRef}
          data-help-region="conversation:thread"
          onScroll={handleScroll}
          // Phase 2.5 perf fix — `markUserScrollIntent` flags real
          // user-input scrolls so `handleScroll` only changes pin
          // status when the user actually intended to move. Wheel +
          // touch cover mouse-wheel, trackpad two-finger, and touch
          // drag. `onMouseDown` catches scrollbar-track / thumb drag
          // — clicking inside a message bubble also fires it, but
          // since the only effect is allowing the next scroll event
          // to update pin (which it will compute correctly against
          // current position), the false-positive is harmless. Key
          // input handled via `tabIndex` + `onKeyDown` only when the
          // writer has navigated focus into the panel.
          onWheel={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          onMouseDown={markUserScrollIntent}
          onKeyDown={(e) => {
            if ([ 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ' ].includes(e.key)) {
              markUserScrollIntent()
            }
          }}
          // Phase 2.8a — name-highlight click delegate. The
          // `<HighlightChildren>` walker wraps matched names in
          // `<span class="nn-entity-highlight">` with data
          // attributes; this single delegate catches clicks on any
          // of them and routes to the right detail panel by kind.
          // Ambiguous matches (`data-ambiguous="true"`) are tooltip-
          // only and don't navigate — the writer picks which one
          // they meant by adjusting the surrounding text.
          onClick={handleBubbleHighlightClick}
          // Hover-preview delegate — pops the shared
          // `<EntityHoverPreview>` popover (avatar / type icon) when
          // the cursor is over a coloured name. Same component the
          // scene editor uses; same data-attribute contract.
          onMouseOver={handleBubbleHighlightMouseOver}
          onMouseOut={handleBubbleHighlightMouseOut}
          className="absolute inset-0 overflow-y-auto px-3 py-3 space-y-2"
        >
          {messages.every((m) => m.role !== 'user' && m.role !== 'assistant') && (
            <div className="text-[11px] text-zinc-500 italic text-center pt-4">
              No messages yet. Type a prompt below to start.
            </div>
          )}
          {messages.map((m, idx) => {
            // Phase 2.5d — system_context messages are stored inline
            // in the thread so they survive reload, but they are NOT
            // rendered in the chat view. The "View attached context"
            // popover on each user message surfaces them; the wire
            // builder consumes them when assembling the outgoing
            // request. Anywhere else they'd just be wall-of-text noise.
            if (m.role === 'system_context') return null
            const fade = aboveCutoffIds.has(m.id)
            // Phase 2.11b item 12 — re-anchor divider. When the most
            // recent prior renderable message was sent under a
            // DIFFERENT character-chat anchor spec (different hash),
            // drop an informational divider before this message
            // captioned with the new anchor label. Skipped when the
            // prior message has no stamped hash (legacy / non-
            // character thread) — no boundary to mark there.
            //
            // Phase 2.12 — extended to two-character mode by
            // comparing per-character hash dicts on consecutive
            // messages. When EITHER character's hash changed, divider
            // fires with a caption naming which character was
            // re-anchored.
            let showReanchorDivider = false
            let reanchorLabel = ''
            // Find the most recent renderable predecessor for the
            // comparison.
            let prevForDivider = null
            for (let p = idx - 1; p >= 0; p--) {
              const prev = messages[p]
              if (!prev || prev.role === 'system_context') continue
              prevForDivider = prev
              break
            }
            // Two-character per-character hash comparison (preferred
            // when both messages carry the dicts).
            if (prevForDivider && m.two_char_anchor_hashes && prevForDivider.two_char_anchor_hashes) {
              const reanchoredNames = []
              for (const charId of Object.keys(m.two_char_anchor_hashes)) {
                const curHash = m.two_char_anchor_hashes[charId]
                const prevHash = prevForDivider.two_char_anchor_hashes[charId]
                if (prevHash && curHash !== prevHash) {
                  const newLabel = (m.two_char_anchor_labels && m.two_char_anchor_labels[charId]) || 'a new anchor'
                  // Resolve the character's name via the per-bubble
                  // persona lookup if available.
                  let charName = 'a character'
                  if (twoCharPersonas) {
                    if (twoCharPersonas.char1?.synthEntity?.id === charId) {
                      charName = twoCharPersonas.char1.characterName || charName
                    } else if (twoCharPersonas.char2?.synthEntity?.id === charId) {
                      charName = twoCharPersonas.char2.characterName || charName
                    }
                  }
                  reanchoredNames.push(`${charName} to ${newLabel}`)
                }
              }
              if (reanchoredNames.length > 0) {
                showReanchorDivider = true
                reanchorLabel = reanchoredNames.join(' · ')
              }
            }
            // Single-character fall-through (Phase 2.11b semantic).
            else if (m.anchor_dossier_hash && prevForDivider) {
              if (prevForDivider.anchor_dossier_hash && prevForDivider.anchor_dossier_hash !== m.anchor_dossier_hash) {
                showReanchorDivider = true
                reanchorLabel = m.anchor_label || 'a new anchor'
              }
            }
            return (
              <Fragment key={m.id}>
                {cutoff.kind === 'before' && cutoff.messageId === m.id && (
                  <HistoryCutoffDivider />
                )}
                {showReanchorDivider && (
                  <ReanchorDivider label={reanchorLabel} />
                )}
                <div
                  className={`transition-opacity duration-200 ${fade ? 'opacity-50' : 'opacity-100'}`}
                  title={fade ? 'Outside the current message-history window. This turn will not be sent with the next request.' : undefined}
                >
                  <MessageBubble
                    message={m}
                    model={model}
                    streaming={streaming && streamingMessageIdRef.current === m.id}
                    conversationRenderMode={conversationRenderMode}
                    onSetMessageRenderMode={setMessageRenderMode}
                    onRetry={retryMessage}
                    onResend={resendUserMessage}
                    onEditUserResubmit={editUserAndResubmit}
                    onEditUserSaveOnly={editUserSaveOnly}
                    onEditAssistantSave={saveAssistantEdit}
                    onSetStarState={setStarState}
                    onFork={forkFromMessage}
                    onViewContext={setViewContextMessageId}
                    onDelete={deleteOneMessage}
                    canMutate={!streaming}
                    activeSupportsImageInput={Array.isArray(composerCapabilities?.input_modalities) && composerCapabilities.input_modalities.includes('image')}
                    activeSupportsFileInput={Array.isArray(composerCapabilities?.input_modalities) && composerCapabilities.input_modalities.includes('file')}
                    cachedInputTokens={m.id === latestAssistantId ? latestCachedTokens : null}
                    nameTargets={chatNameTargets}
                    highlightEnabled={chatHighlightNamesEnabled}
                    characterPersona={(() => {
                      // Phase 2.12 — bubble persona resolution. In a
                      // two-character chat, look up which character
                      // spoke this message via `speaker_character_id`
                      // and return THAT character's snapshot. The
                      // bubble's UI side (left / right) is also
                      // driven by speaker identity via the
                      // `twoCharForceUserSide` prop below. In single-
                      // character chats, return the existing
                      // single-`characterPersona` snapshot. In regular
                      // chats, both are null.
                      if (twoCharPersonas && m.speaker_character_id) {
                        const c1 = twoCharPersonas.char1
                        const c2 = twoCharPersonas.char2
                        if (c1 && m.speaker_character_id === c1.synthEntity?.id) return c1
                        if (c2 && m.speaker_character_id === c2.synthEntity?.id) return c2
                      }
                      return characterPersona
                    })()}
                    twoCharForceUserSide={(() => {
                      // Phase 2.12 — UI position is FIXED by speaker
                      // identity in two-character mode (Character 1 =
                      // always left/assistant slot; Character 2 =
                      // always right/user slot). When this message
                      // was spoken by Character 2, force the bubble
                      // into user-side rendering even though the
                      // persisted role might be 'assistant' (the wire-
                      // builder rewrites roles per turn; the persisted
                      // role doesn't follow speaker identity). Null
                      // in regular + single-character chats.
                      if (twoCharPersonas && m.speaker_character_id) {
                        const c2 = twoCharPersonas.char2
                        if (c2 && m.speaker_character_id === c2.synthEntity?.id) return true
                        return false
                      }
                      return null
                    })()}
                  />
                </div>
              </Fragment>
            )
          })}
          {cutoff.kind === 'bottom' && <HistoryCutoffDivider />}
          {queuedMessages.map((text, idx) => (
            <QueuedMessageBubble
              key={`queued-${idx}`}
              content={text}
              onRemove={() => removeFromQueue(idx)}
            />
          ))}
        </div>
        {showScrollToTop && (
          <button
            type="button"
            onClick={scrollToTop}
            className="absolute right-3 top-3 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-[10px] rounded-full px-2.5 py-1 border border-zinc-600 shadow-lg transition-colors"
            title="Jump to the start of the conversation"
          >
            ↑ Top
          </button>
        )}
        {showScrollToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute right-3 bottom-3 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-[10px] rounded-full px-2.5 py-1 border border-zinc-600 shadow-lg transition-colors"
            title="Jump to the newest message"
          >
            ↓ Latest
          </button>
        )}
      </div>

      {(error || lastError) && (
        <div className="px-3 py-1.5 text-[10px] text-red-200 bg-red-900/20 border-t border-red-700/40 break-words">
          ✗ {error || lastError}
        </div>
      )}

      <div
        className="border-t border-zinc-700 flex-shrink-0 relative"
        onDragEnter={(e) => {
          // Two recognised drag sources land on the composer:
          //   - OS file drags carry `'Files'` in dataTransfer.types.
          //   - Entity Library drags carry one of the project's
          //     `application/nnz-*` MIME types (entity / knowledge /
          //     relationship).
          // Both activate the same overlay; the overlay copy adapts
          // below based on which kind is active.
          const types = Array.from(e?.dataTransfer?.types || [])
          const isFile = types.includes('Files')
          const isLib = types.includes('application/nnz-entity-id')
            || types.includes('application/nnz-knowledge-id')
            || types.includes('application/nnz-relationship-id')
            || types.includes('application/nnz-cue-id')
          if (!isFile && !isLib) return
          e.preventDefault()
          dragDepth.current += 1
          if (!dragOverComposer) setDragOverComposer(true)
        }}
        onDragOver={(e) => {
          const types = Array.from(e?.dataTransfer?.types || [])
          const isFile = types.includes('Files')
          const isLib = types.includes('application/nnz-entity-id')
            || types.includes('application/nnz-knowledge-id')
            || types.includes('application/nnz-relationship-id')
            || types.includes('application/nnz-cue-id')
          if (!isFile && !isLib) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          const types = Array.from(e?.dataTransfer?.types || [])
          const isFile = types.includes('Files')
          const isLib = types.includes('application/nnz-entity-id')
            || types.includes('application/nnz-knowledge-id')
            || types.includes('application/nnz-relationship-id')
            || types.includes('application/nnz-cue-id')
          if (!isFile && !isLib) return
          dragDepth.current -= 1
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragOverComposer(false)
          }
        }}
        onDrop={(e) => {
          // Strip-level drop handler runs first and calls
          // `e.preventDefault()` + `e.stopPropagation()` for library
          // drops it accepts. Bubbled drops still arrive here for the
          // bigger composer-area drop target, but the dedup guard in
          // `addPinnedContextItem` makes a double-fire a silent no-op
          // anyway. The `e.defaultPrevented` check below keeps us
          // from re-firing when the strip already handled the drop.
          const types = Array.from(e?.dataTransfer?.types || [])
          const isFile = types.includes('Files')
          const isLib = types.includes('application/nnz-entity-id')
            || types.includes('application/nnz-knowledge-id')
            || types.includes('application/nnz-relationship-id')
            || types.includes('application/nnz-cue-id')
          if (!isFile && !isLib) return
          if (e.defaultPrevented) {
            dragDepth.current = 0
            setDragOverComposer(false)
            return
          }
          e.preventDefault()
          dragDepth.current = 0
          setDragOverComposer(false)
          setFileDragInWindow(false)
          setLibraryDragInWindow(false)
          setLibraryDragKind(null)
          if (isLib) {
            const eid = e.dataTransfer.getData('application/nnz-entity-id')
            const kid = e.dataTransfer.getData('application/nnz-knowledge-id')
            const rid = e.dataTransfer.getData('application/nnz-relationship-id')
            const cid = e.dataTransfer.getData('application/nnz-cue-id')
            const sk = `chat:${threadId}`
            if (eid) addPin(sk, { kind: 'entity', id: eid })
            else if (kid) addPin(sk, { kind: 'knowledge', id: kid })
            else if (rid) addPin(sk, { kind: 'relationship', id: rid })
            else if (cid) addPin(sk, { kind: 'cue', id: cid })
            return
          }
          const dropped = Array.from(e.dataTransfer?.files || [])
          if (!threadId || dropped.length === 0) return
          for (const file of dropped) {
            const result = validateAttachment(file, composerCapabilities)
            if (result.ok) {
              addChatAttachmentAction(threadId, makeAttachmentRecord(file, result.kind))
            } else {
              showTransientAlert(`${file.name}: ${result.reason}`)
            }
          }
        }}
      >
        {(fileDragInWindow || libraryDragInWindow) && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none rounded transition-colors"
            style={{
              backgroundColor: withAccentAlpha(accent, dragOverComposer ? 0.28 : 0.12),
              outline: `${dragOverComposer ? '2px' : '1.5px'} dashed ${accent}`,
              outlineOffset: '-4px',
              opacity: dragOverComposer ? 1 : 0.85,
            }}
          >
            <span
              className="text-xs font-semibold uppercase tracking-wider px-3 py-1.5 rounded bg-zinc-900/85 border transition-colors"
              style={{ color: accent, borderColor: accent }}
            >
              {libraryDragInWindow
                ? (dragOverComposer
                    ? `Drop to attach this ${libraryDragKind || 'item'}`
                    : `Drop here to attach this ${libraryDragKind || 'item'}`)
                : (dragOverComposer ? 'Drop to attach' : 'Drop here to attach')}
            </span>
          </div>
        )}
        <ActiveContextStrip threadId={threadId} />
        <AttachedFileChips threadId={threadId} />
        <div data-help-region="conversation:composer" className="px-2 pb-2 pt-1 flex gap-2 items-start">
        {/* Left column: textarea on top, toolbar below. The toolbar
            sits inside the textarea's column so its right edge
            aligns with the textarea's right edge (not extending into
            the Send column). */}
        <div className="flex-1 flex flex-col gap-1 min-w-0">
        {/* Phase 2.8 — the chat composer input was a plain
            `<textarea>` until v0.2.8.14. Swapped to a minimal
            TipTap editor so the input can host inline coloured
            name-highlight decorations (auto-detected library
            object names) without losing IME / paste / caret /
            undo behaviour. Send-on-Enter / Shift+Enter / Ctrl+Enter
            keybinds are routed through the component's custom
            keymap; the parent's `send()` and `setPrompt('')` calls
            unchanged so queue handling / streaming gating / etc.
            don't shift. `resize-y` from the textarea is gone (no
            equivalent in TipTap); height is bounded by the
            min/max-h classes on the wrapper. */}
        <ChatComposerTipTapInput
          value={prompt}
          onChange={setPrompt}
          onSend={send}
          dataHelpRegion="conversation:composer_input"
          sendOnEnter={sendOnEnter}
          placeholder={cantSendReason || `Type a message… ${placeholderHint}`}
          disabled={!profile}
          // Phase 2.8 — feed the story-wide name-highlight pipeline.
          // The chat input's `EntityHighlightExtension` paints any
          // typed name that matches one of these targets in the
          // target's colour. Master toggle gates whether decorations
          // are painted at all; the per-type filter already
          // narrows `chatNameTargets` upstream.
          nameTargets={chatNameTargets}
          highlightEnabled={chatHighlightNamesEnabled}
          accentColor={accent}
          className="w-full bg-zinc-800 text-xs text-zinc-100 rounded border border-zinc-600 focus-within:border-accent-500 min-h-[52px] max-h-[180px] overflow-y-auto [&_.ProseMirror]:px-2 [&_.ProseMirror]:py-1.5 [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[40px] [&_.ProseMirror_p]:m-0"
        />
        <InputToolbarRow
          threadId={threadId}
          messages={messages}
          onJumpToMessage={scrollToMessage}
          onUnfavourite={(messageId) => setStarState(messageId, { pinned: false, context_sticky: false })}
          // ToDo item 163 — Preview Message: gear popover signals
          // here; we snapshot the draft, set previewOpen, and the
          // effect downstream fires sendText in preview mode.
          onRequestPreview={() => {
            setPreviewDraft(prompt)
            setPreviewMode('with-history')
            setPreviewOpen(true)
          }}
          // Phase 2.12g — Re-anchor: the gear popover renders a
          // Re-anchor button for single-character chats and two
          // (one per character) for two-character chats. Each
          // click signals here with the corresponding target; the
          // modal mount at the end of this component opens against
          // that target.
          onRequestReanchor={(target) => setReanchorTarget(target)}
        />
        </div>
        {/* Send column. items-start on the parent keeps the button
            anchored to the top of the row at its fixed 52px height,
            matching the textarea's starting height. When the writer
            drags the textarea taller, Send stays put at 52px. */}
        {/* Send column: Send/Queue button on top (fixed 52px to
            match the textarea's starting height), Stop button below
            (small, only renders while streaming — sits in line with
            the toolbar row on the left so the two rows align).
            Phase 2.12f — two-character chats render a small mode-
            cycle button above (Single / Dual / Auto), and dual mode
            renders two Send-to-character buttons side-by-side
            in place of the single Send. Regular + single-character
            chats fall through to the original single-button layout
            unchanged. While streaming, BOTH layouts collapse to a
            single Queue button + Stop sub-button (no per-character
            buttons during streaming — only one reply is in flight,
            and the queue is a single bucket). */}
        <div className="flex flex-col gap-1 flex-shrink-0">
          {/* Mode cycle pip — two-character only, non-streaming,
              loop-not-running. Hidden while the auto-send loop is
              actively cycling so the writer can't accidentally cycle
              modes mid-loop and orphan the running counter. */}
          {twoCharPersonas && !streaming && !autoSendActive && (
            <button
              type="button"
              onClick={cycleComposerMode}
              title={`Send mode: ${composerMode === 'single' ? 'Single (one Send button, auto-alternates)' : composerMode === 'dual' ? 'Dual (pick which character speaks)' : 'Auto (counter-driven loop)'}. Click to cycle.`}
              className="h-5 px-2 text-[10px] text-zinc-300 bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-600 rounded transition-colors flex items-center justify-center gap-1 font-medium"
            >
              <span className="text-accent-300">🎭⇆🎭</span>
              <span>{composerMode === 'single' ? 'Single' : composerMode === 'dual' ? 'Dual' : 'Auto'}</span>
            </button>
          )}
          {/* Auto-send row — Start/Stop + counter input. Renders
              when composer mode is auto, both before AND during the
              loop. Counter remains editable during a running loop
              (writer can extend or shorten the queue mid-run).
              While the in-flight turn is streaming, the counter
              shows the remaining decrement count and the toggle
              shows "Stop". */}
          {twoCharPersonas && composerMode === 'auto' ? (
            <div className="flex flex-row gap-1 items-center">
              <button
                type="button"
                onClick={toggleAutoSend}
                disabled={!profile || !model}
                title={autoSendActive
                  ? `Stop the auto-send loop. The in-flight turn will finish; the next one will not fire. ${autoSendCount} turn${autoSendCount === 1 ? '' : 's'} remaining.`
                  : `Start the auto-send loop. Will fire ${autoSendCount} turn${autoSendCount === 1 ? '' : 's'} (alternating characters), then revert to the saved manual mode.`}
                className={`h-[52px] px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center justify-center gap-1 ${
                  autoSendActive
                    ? 'bg-red-700 hover:bg-red-600'
                    : 'bg-accent-700 hover:bg-accent-600'
                }`}
              >
                {autoSendActive ? (
                  <>
                    <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="0.8" /></svg>
                    <span>Stop</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor"><polygon points="3,2 3,10 10,6" /></svg>
                    <span>Start</span>
                  </>
                )}
              </button>
              <input
                type="number"
                min="1"
                value={autoSendCount}
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') { setAutoSendCount(0); return }
                  const n = parseInt(raw, 10)
                  if (Number.isFinite(n) && n >= 0) setAutoSendCount(n)
                }}
                title={autoSendActive
                  ? 'Turns remaining. Editable mid-run — bump it up to extend the loop, drop it to stop sooner.'
                  : 'Number of turns the auto-send loop will fire (alternating characters).'}
                className="h-[52px] w-12 px-1 text-xs text-center bg-zinc-800 border border-zinc-600 text-zinc-100 rounded focus:border-accent-500 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          ) : null}
          {/* Dual-button row — only when not streaming. The auto-mode
              row above already handled `composerMode === 'auto'`;
              this branch must NOT also render the single Send button
              when auto is active, otherwise the column shows two
              competing send affordances. The fallback below adds the
              auto-suppression guard. */}
          {twoCharPersonas && composerMode === 'auto' ? null : twoCharPersonas && composerMode === 'dual' && !streaming ? (
            <div className="flex flex-row gap-1">
              {[twoCharPersonas.char1, twoCharPersonas.char2].map((persona, idx) => {
                if (!persona) return null
                const charId = persona.synthEntity?.id || null
                const charName = persona.characterName || `Character ${idx + 1}`
                const isEnterTarget = twoCharTurnInfo && charId && charId === twoCharTurnInfo.nextSpeaker
                const handleClick = () => {
                  if (!charId) return
                  send({ speakerCharacterIdOverride: charId })
                }
                const disabled = !profile || !model
                return (
                  <button
                    key={charId || `char-${idx}`}
                    type="button"
                    onClick={handleClick}
                    disabled={disabled}
                    title={`Send ${prompt.trim() ? 'message' : 'turn'} to ${charName}${isEnterTarget ? ' (Enter)' : ''}`}
                    className="relative h-[52px] px-2 text-xs disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors bg-accent-700 hover:bg-accent-600 flex flex-col items-center justify-center gap-0.5 min-w-[64px]"
                  >
                    {isEnterTarget && (
                      <span
                        className="absolute -top-1 -right-1 px-1 text-[8px] font-bold bg-accent-300 text-accent-900 rounded leading-tight pointer-events-none"
                        aria-label="Enter sends to this character"
                      >
                        ⏎
                      </span>
                    )}
                    {/* EntityAvatar handles profile_image_ref resolution
                        (`assets/...` → `/api/project/assets/...`, data: URLs
                        passthrough) AND the initial-on-colour fallback when
                        the character has no profile image. Same component
                        the chat header + bubble strips use. */}
                    {persona.synthEntity && (
                      <EntityAvatar entity={persona.synthEntity} size={24} />
                    )}
                    <span className="text-[9px] leading-none truncate max-w-[56px]">{charName.split(' ')[0]}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => send()}
              data-help-region="conversation:composer_send"
              disabled={
                !profile
                || !model
                // Phase 2.12 — in two-character mode, empty composer
                // Send is a legitimate "advance the turn" action.
                // Regular + single-character chats keep requiring
                // text in the composer.
                || (!thread?.two_character_chat && !prompt.trim())
              }
              title={streaming
                ? 'Queue this message. It will send (combined with any other queued messages) once the current reply finishes.'
                : (cantSendReason || 'Send (Enter)')}
              className={`h-[52px] px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors ${
                streaming
                  ? 'bg-zinc-700 hover:bg-zinc-600 border border-zinc-600'
                  : 'bg-accent-700 hover:bg-accent-600'
              }`}
            >
              {streaming ? 'Queue' : 'Send'}
            </button>
          )}
          {streaming && (
            <button
              type="button"
              onClick={cancel}
              data-help-region="conversation:composer_stop"
              title="Stop the in-flight AI response"
              aria-label="Stop"
              className="h-5 w-full flex items-center justify-center bg-red-900/50 hover:bg-red-900/70 text-red-100 border border-red-800/60 rounded transition-colors"
            >
              {/* Filled square — standard media stop glyph. */}
              <svg viewBox="0 0 12 12" width="9" height="9" fill="currentColor">
                <rect x="2" y="2" width="8" height="8" rx="0.8" />
              </svg>
            </button>
          )}
        </div>
        </div>
      </div>
      {viewContextMessageId && (
        <AttachedContextModal
          thread={thread}
          messageId={viewContextMessageId}
          onClose={() => setViewContextMessageId(null)}
        />
      )}
      {/* ToDo item 163 — Preview Message modal. Owned at the
          ConversationView level so it has direct access to `prompt`
          (the writer's draft) and `sendText` (the chat composer's
          dispatcher). Same dispatcher the Send button uses, run in
          preview mode — the wire payload is routed to setPreviewPayload
          instead of streamChat. */}
      {previewOpen && (
        <WirePayloadPreviewModal
          surface="chat"
          payload={previewPayload}
          mode={previewMode}
          onModeChange={setPreviewMode}
          modeToggleAvailable={true}
          onClose={() => { setPreviewOpen(false); setPreviewPayload(null) }}
        />
      )}
      {/* Phase 2.12g — Re-anchor modal. Opens from the gear popover's
          Re-anchor button(s). Picks initialMeta from the matching
          slot — `character_chat` for single-character chats,
          `two_character_chat.characters[charIdx]` for two-character
          chats. On Confirm, writes back to the same slot, preserving
          the OTHER slot in the two-character case. `allowAdd2nd` is
          false: re-anchor never converts a single-character chat
          into a two-character one (and vice versa). */}
      {reanchorTarget && (() => {
        const isSingle = reanchorTarget.kind === 'single'
        const initialMeta = isSingle
          ? (thread?.character_chat || null)
          : (thread?.two_character_chat?.characters?.[reanchorTarget.charIdx] || null)
        if (!initialMeta) return null
        const handleConfirm = (nextMeta) => {
          if (!threadId) { setReanchorTarget(null); return }
          if (isSingle) {
            updateThread(threadId, { character_chat: nextMeta })
          } else {
            const meta = thread?.two_character_chat
            if (!meta || !Array.isArray(meta.characters)) {
              setReanchorTarget(null)
              return
            }
            const nextCharacters = meta.characters.map((c, i) =>
              i === reanchorTarget.charIdx ? nextMeta : c,
            )
            updateThread(threadId, { two_character_chat: { ...meta, characters: nextCharacters } })
          }
          setReanchorTarget(null)
        }
        return (
          <CharacterChatSetupModal
            open={true}
            initialCharacterId={initialMeta.character_id || null}
            initialMeta={initialMeta}
            applyToExisting
            onConfirm={handleConfirm}
            onClose={() => setReanchorTarget(null)}
            allowAdd2nd={false}
          />
        )
      })()}
      <EntityHoverPreview target={bubbleHoverTarget} rect={bubbleHoverRect} />
    </div>
  )
}

// ── Queued user-message bubble ────────────────────────────────
//
// Pseudo-bubble rendered below the streaming AI response while a
// user message sits in the send queue. Visually mirrors the real
// user-message bubble (right-aligned, accent-tinted wash, role
// label "QUEUED") but with a dashed border + faded opacity to
// signal "not yet sent". The × button on hover lets the writer
// pull the message back out of the queue before it dispatches.
// Visual divider in the message list marking where the message-
// history cutoff sits at the current `chatHistoryWindowN` setting.
// User and assistant messages above the divider are NOT included
// in the next outgoing request; system messages anywhere in the
// thread are always included (they don't count toward the cap).
// The divider moves as new turns arrive (more turns above the
// window edge get pushed out as the window slides forward).
function HistoryCutoffDivider() {
  const accent = useAccentColor() || '#7c3aed'
  // Subtle glow uses a soft accent-tinted blur — a clear visual
  // beat in the message list without being loud. Larger vertical
  // padding so the divider breathes between bubbles and reads as
  // a deliberate section break rather than spacing noise.
  const lineGlow = `0 0 6px ${_hexToRgba(accent, 0.55)}, 0 0 12px ${_hexToRgba(accent, 0.25)}`
  const textGlow = `0 0 8px ${_hexToRgba(accent, 0.45)}`
  return (
    <div
      className="flex items-center gap-3 my-5 px-1 select-none"
      title="User and assistant messages above this line are outside the current history window and won't be sent with the next request. System messages are always included regardless."
    >
      <div
        className="flex-1 h-px"
        style={{ backgroundColor: accent, boxShadow: lineGlow }}
      />
      <span
        className="text-[10px] uppercase tracking-wider font-bold whitespace-nowrap"
        style={{ color: accent, textShadow: textGlow }}
      >
        Message history cutoff
      </span>
      <div
        className="flex-1 h-px"
        style={{ backgroundColor: accent, boxShadow: lineGlow }}
      />
    </div>
  )
}


/**
 * Phase 2.11b item 12 — re-anchor divider.
 *
 * Rendered between two consecutive character-chat messages when their
 * stamped `anchor_dossier_hash` values disagree (the writer re-anchored
 * mid-conversation). Visually distinct from the history-cutoff divider:
 * a softer dashed line + an explicit "Re-anchored to <label>" caption.
 * The label is the writer-visible anchor span captured at send time —
 * scene title, "origin", "modifier", a range, or "N anchors" — see
 * `formatAnchorSpan` in `characterChatAnchorMeta.js`.
 */
function ReanchorDivider({ label }) {
  const accent = useAccentColor() || '#7c3aed'
  return (
    <div
      className="flex items-center gap-3 my-4 px-1 select-none"
      title="The writer re-anchored the conversation here. Messages above were sent against an earlier anchor; messages below use the new one."
    >
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage: `linear-gradient(to right, ${withAccentAlpha(accent, 0.55)} 50%, transparent 50%)`,
          backgroundSize: '8px 1px',
          backgroundRepeat: 'repeat-x',
        }}
      />
      <span
        className="text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap"
        style={{ color: withAccentAlpha(accent, 0.9) }}
      >
        Re-anchored to {label || 'a new anchor'}
      </span>
      <div
        className="flex-1 h-px"
        style={{
          backgroundImage: `linear-gradient(to right, ${withAccentAlpha(accent, 0.55)} 50%, transparent 50%)`,
          backgroundSize: '8px 1px',
          backgroundRepeat: 'repeat-x',
        }}
      />
    </div>
  )
}


function QueuedMessageBubble({ content, onRemove }) {
  const accent = useAccentColor() || '#7c3aed'
  return (
    <div className="group/queued flex justify-end">
      <div
        className="max-w-full rounded-lg border-2 border-dashed px-3 py-2 space-y-1 shadow-sm opacity-60 hover:opacity-80 transition-opacity relative"
        style={{
          borderColor: withAccentAlpha(accent, 0.6),
          backgroundColor: withAccentAlpha(accent, 0.06),
        }}
      >
        <div className="flex items-baseline gap-2 justify-end">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: withAccentAlpha(accent, 0.85) }}
          >
            Queued
          </span>
        </div>
        <div className="text-[12px] text-zinc-100 leading-relaxed break-words whitespace-pre-wrap italic">
          {content}
        </div>
        <button
          type="button"
          onClick={onRemove}
          title="Remove from queue: pull this message back before it sends."
          aria-label="Remove queued message"
          className="absolute top-1 right-1 text-zinc-400 hover:text-red-200 text-[12px] leading-none w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover/queued:opacity-100 transition-opacity hover:bg-red-900/30"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// Local alpha helper duplicated from MessageBubble — keeps the
// queued-bubble styling self-contained in this file without a
// cross-component import for a four-line maths helper.
function withAccentAlpha(hex, alpha) {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// ── Favourites button + popover ───────────────────────────────
//
// Companion to the Chat Settings gear — sits in the input toolbar
// row and surfaces every favourited message in this thread as a
// click-to-jump dropdown. The button itself carries a small count
// badge so the writer can see at a glance how many bookmarks are
// in the current thread without opening anything. Filled-yellow
// star when there are favourites, outline when zero (matches the
// per-message star indicator language).
function FavouritesButton({ open, count, stickyCount = 0, onToggle, ref }) {
  // Tooltip mentions both counts when relevant. The sticky figure
  // gets its own line so the writer can see at a glance how many
  // pinned-sticky messages are riding along with every request.
  const titleParts = []
  if (count > 0) titleParts.push(`${count} favourite${count === 1 ? '' : 's'}`)
  if (stickyCount > 0) titleParts.push(`${stickyCount} pinned (always sent, in addition to your message-history limit)`)
  const title = titleParts.length === 0
    ? 'Favourites: bookmark messages with the star in their header. The list opens here once you have at least one.'
    : `Favourites: ${titleParts.join(' · ')}. Open the bookmark list for this conversation.`
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-help-region="conversation:composer_favourites"
      title={title}
      aria-label="Favourites"
      className={`relative flex items-center justify-center w-5 h-5 rounded border transition-colors ${
        open
          ? 'border-accent-700/60 bg-accent-900/30 text-accent-200'
          : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill={stickyCount > 0 ? '#fbbf24' : 'none'}
        stroke="#fbbf24"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={stickyCount > 0
          ? { filter: 'drop-shadow(0 0 2px rgba(252, 211, 77, 0.7))' }
          : undefined}
      >
        <path d="M8 1.8l1.9 4 4.4.5-3.3 3 1 4.3L8 11.4 3.9 13.6l1-4.3-3.3-3 4.4-.5z" />
      </svg>
      {stickyCount > 0 && (
        <span
          className="absolute -top-1 -right-1 text-[8px] leading-none px-0.5 rounded-full bg-emerald-600 text-zinc-50 font-semibold"
          title={`${stickyCount} pinned favourite${stickyCount === 1 ? '' : 's'}: always sent in addition to the message-history limit.`}
        >
          +{stickyCount}
        </span>
      )}
    </button>
  )
}

function FavouritesPopover({ messages, triggerRef, onJump, onUnfavourite, onClose }) {
  const containerRef = useRef(null)
  useEffect(() => {
    function onDocDown(e) {
      if (!containerRef.current) return
      if (containerRef.current.contains(e.target)) return
      if (triggerRef?.current?.contains(e.target)) return
      onClose()
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Split into sticky-favourites and regular favourites. Each
  // section preserves the natural message order from the thread
  // (oldest first, matching the chat scroll direction). Stickies
  // surface first because they're the ones bypassing the cap and
  // the writer usually cares about the always-included ones more.
  const stickyFavs = (messages || []).filter((m) => m && m.pinned && m.context_sticky)
  const regularFavs = (messages || []).filter((m) => m && m.pinned && !m.context_sticky)
  const total = stickyFavs.length + regularFavs.length
  return (
    <div
      ref={containerRef}
      className="absolute left-8 bottom-full mb-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl w-[340px] max-h-[360px] overflow-y-auto py-1 text-[11px]"
    >
      <div className="px-2.5 py-1 text-zinc-500 text-[9px] uppercase tracking-wider border-b border-zinc-800 flex items-center justify-between">
        <span>★ Favourites</span>
        <span>{total}{stickyFavs.length > 0 ? ` · ${stickyFavs.length} pinned` : ''}</span>
      </div>
      {total === 0 && (
        <div className="px-2.5 py-2 text-zinc-500 italic">
          No favourites yet. Click the ★ in any message header to bookmark it for quick navigation.
        </div>
      )}
      {stickyFavs.length > 0 && (
        <>
          <div className="px-2.5 pt-1.5 pb-0.5 text-emerald-400 text-[9px] uppercase tracking-wider font-semibold">
            Pinned · always sent
          </div>
          {stickyFavs.map((m) => (
            <FavouriteRow
              key={m.id}
              message={m}
              isSticky
              onJump={() => onJump(m.id)}
              onRemove={() => onUnfavourite(m.id)}
            />
          ))}
        </>
      )}
      {regularFavs.length > 0 && (
        <>
          <div
            className={`px-2.5 pt-1.5 pb-0.5 text-zinc-500 text-[9px] uppercase tracking-wider font-semibold ${
              stickyFavs.length > 0 ? 'border-t border-zinc-800 mt-1' : ''
            }`}
          >
            Favourites
          </div>
          {regularFavs.map((m) => (
            <FavouriteRow
              key={m.id}
              message={m}
              onJump={() => onJump(m.id)}
              onRemove={() => onUnfavourite(m.id)}
            />
          ))}
        </>
      )}
    </div>
  )
}

function FavouriteRow({ message, isSticky = false, onJump, onRemove }) {
  const label = _favouritePreview(message)
  // Star icon mirrors the per-message header treatment: outline ☆
  // for regular favourites, filled ★ with a soft amber glow for
  // pinned favourites. Both gold-coloured so the row reads as a
  // favourite entry at a glance; the fill+glow distinction signals
  // pinned status.
  const starTitle = isSticky
    ? 'Pinned favourite: always sent with every request.'
    : 'Favourite: bookmarked for quick navigation.'
  const starAria = isSticky ? 'Pinned favourite' : 'Favourite'
  return (
    <div className="group/favrow flex items-start gap-1.5 px-2.5 py-1 hover:bg-zinc-800 transition-colors">
      <span
        className="flex-shrink-0 mt-1 text-amber-300 leading-none"
        style={isSticky ? { filter: 'drop-shadow(0 0 2px rgba(252, 211, 77, 0.65))' } : undefined}
        title={starTitle}
        aria-label={starAria}
      >
        <svg viewBox="0 0 16 16" width="10" height="10" fill={isSticky ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.8l1.9 4 4.4.5-3.3 3 1 4.3L8 11.4 3.9 13.6l1-4.3-3.3-3 4.4-.5z" />
        </svg>
      </span>
      <button
        type="button"
        onClick={onJump}
        title={message.content || ''}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">
          {message.role === 'user' ? 'You' : 'AI'}
        </div>
        <div className="text-zinc-200 truncate">{label}</div>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Unfavourite: remove this message from your bookmarks (clears the pinned state too if set)."
        aria-label="Unfavourite"
        className="flex-shrink-0 mt-1 text-zinc-500 hover:text-red-300 leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-red-900/30 opacity-0 group-hover/favrow:opacity-100 transition-opacity"
      >
        ✕
      </button>
    </div>
  )
}


// Body of the over-5 pinned-favourites confirmation dialog. Renders
// the explanation text from the caller plus a real <input type=
// "checkbox"> for the "don't warn me again this session" toggle.
// On change, the checkbox calls `onSuppressChange(boolean)` so the
// caller's closure can capture the latest value and read it back
// after the dialog resolves (dialogStore doesn't natively surface
// arbitrary form fields; the callback is the bridge).
function PinnedWarningBody({ summary, onSuppressChange }) {
  const [checked, setChecked] = useState(false)
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-line">{summary}</div>
      <label className="flex items-center gap-2 text-zinc-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            setChecked(e.target.checked)
            if (onSuppressChange) onSuppressChange(e.target.checked)
          }}
          className="w-3.5 h-3.5 cursor-pointer"
        />
        <span>Don't warn me again this session</span>
      </label>
    </div>
  )
}

// ── Scene Context provider — Phase 2.5c ──────────────────────────
//
// The toggle button + active-context-strip chip + auto-on effect
// share the same `useActiveSceneId` hook so they stay consistent
// when the writer changes selection. The hook returns null when
// no scene is currently active by the sticky `chatActiveSceneId`
// in uiStore (populated by the update effect at the top of
// `ConversationView`); the button dims and the chip strip hides
// themselves in that case.

// Returns the sticky `chatActiveSceneId` from uiStore — populated
// by the update effect in ConversationView. Consumers don't need
// to know about the sticky semantics; they just read the value
// here and trust it stays valid while the writer pokes around
// the detail panel.
function useActiveSceneId() {
  // Validate the sticky id against the current project's scene
  // nodes. If `chatActiveSceneId` was set in a prior session or
  // points to a deleted/missing scene (e.g. the writer switched
  // projects since), return null so the SceneContextButton greys
  // out, the auto-on effect flips off, and the send-time gate
  // refuses to emit scene_context. The sticky value in the store
  // is left alone — it'll get overwritten the next time a real
  // scene is actually focused, which is the cheapest way to
  // self-heal without an explicit reset hook.
  const stickyId = useUiStore((s) => s.chatActiveSceneId)
  const nodes = useProjectStore((s) => s.nodes)
  return useMemo(() => {
    if (!stickyId) return null
    const has = (nodes || []).some((n) => n.id === stickyId && n.type === 'sceneNode')
    return has ? stickyId : null
  }, [stickyId, nodes])
}

function useActiveSceneTitle(sceneId) {
  return useProjectStore((s) => {
    if (!sceneId) return ''
    const node = (s.nodes || []).find((n) => n.id === sceneId)
    return node?.data?.title || 'Untitled scene'
  })
}


// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — Prompt
// Block scene context toggle). Three optional overrides let a host
// outside the chat composer drive the button against its own state
// instead of the global chat-store toggle:
//   - `enabled` (bool) — replaces `chatSceneContextEnabled` reading
//   - `onToggle` (function) — replaces the `setChatSceneContextEnabled`
//     dispatch on click
//   - `sceneId` (string | null) — replaces the `useActiveSceneId()`
//     hook. When null/undefined the button is disabled.
// When all three are omitted (the chat composer's call site), the
// button reads from / writes to `uiStore` exactly as before AND runs
// the auto-on / auto-off effect — no behaviour change at the chat
// composer's existing call site.
// Canonical "Scene context" icon — small framed box with a header bar
// echoing the canvas's scene-node shape. Used by the chat composer's
// SceneContextButton AND by the system-prompt editor's Surface
// Defaults pill so the writer recognises the affordance across
// surfaces.
export function SceneContextIcon({ size = 12 }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="11" height="10" rx="1.2" />
      <path d="M2.5 6.2h11" />
    </svg>
  )
}


export function SceneContextButton({ enabled: enabledProp, onToggle, sceneId: sceneIdProp }) {
  const chatStoreEnabled = useUiStore((s) => s.chatSceneContextEnabled)
  const chatStoreSetEnabled = useUiStore((s) => s.setChatSceneContextEnabled)
  const autoSetEnabled = useUiStore((s) => s.autoSetChatSceneContextEnabled)
  const activeSceneId = useActiveSceneId()
  // Whether this instance is driven by overrides or by the chat store.
  // Used to gate the auto-on effect — that effect is chat-specific
  // (manages the chat composer's persisted toggle in uiStore) and
  // would clobber a host's own state if it ran on every instance.
  const isOverride = typeof enabledProp === 'boolean' || typeof onToggle === 'function' || sceneIdProp !== undefined
  const enabled = isOverride ? !!enabledProp : chatStoreEnabled
  const setEnabled = isOverride ? (onToggle || (() => {})) : chatStoreSetEnabled
  const sceneId = isOverride ? (sceneIdProp || null) : activeSceneId

  // Auto-on / auto-off effect (chat composer only). When a scene
  // becomes active and the writer hasn't manually touched the toggle
  // this session, flip it on. When the active scene goes away, flip
  // it off. The store's `autoSetChatSceneContextEnabled` is a no-op
  // once the writer has manually toggled, so this never overrides
  // their explicit choice. SKIPPED for override hosts — they manage
  // their own toggle state and shouldn't have the chat-side effect
  // mutating it.
  useEffect(() => {
    if (isOverride) return
    autoSetEnabled(!!activeSceneId)
  }, [activeSceneId, autoSetEnabled, isOverride])

  const noScene = !sceneId
  const title = noScene
    ? 'Select a scene on the canvas or open one in the Editor to include scene context.'
    : enabled
      ? 'Scene context: ON. Click to stop sending the current scene’s resolved state with each message.'
      : 'Scene context: OFF. Click to send the current scene’s resolved state (name, description, every entity at effective state, in-scene changes, story-level voice settings) with each message.'

  let className
  if (noScene) {
    className = 'flex items-center justify-center w-5 h-5 rounded border border-zinc-800 bg-zinc-900/30 text-zinc-600 opacity-50 cursor-not-allowed'
  } else if (enabled) {
    className = 'flex items-center justify-center w-5 h-5 rounded border border-accent-600 bg-accent-700/80 text-white hover:bg-accent-600 transition-colors'
  } else {
    className = 'flex items-center justify-center w-5 h-5 rounded border border-zinc-700 bg-zinc-900/30 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 transition-colors'
  }

  return (
    <button
      type="button"
      onClick={noScene ? undefined : () => setEnabled(!enabled)}
      disabled={noScene}
      data-help-region={isOverride ? undefined : 'conversation:composer_scene_context'}
      title={title}
      aria-label="Toggle scene context"
      aria-pressed={!!enabled}
      className={className}
    >
      <SceneContextIcon size={12} />
    </button>
  )
}


// Toolbar button that opens the add-context picker popover.
// Always available regardless of scene-context state — writers can
// add items even without a scene active (those resolve to origin
// baseline per the storage rule).
//
// Right-click opens a small menu with bulk actions (currently just
// "Remove all added context"). The menu only appears when there's
// at least one pin; right-clicking an empty button is a no-op so
// the browser context menu still shows for accessibility tooling.
// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — IPB /
// PBH manual context attachment). Two optional overrides let a host
// outside the chat composer drive the button against its own pinned-
// items list instead of the chat store's `chatPinnedContextItems`:
//   - `pinCount` (number) — replaces the badge count + ARIA label
//   - `onClearAll` (function) — replaces the right-click "Remove all"
//     action's handler
// When both are omitted (the chat composer's call site), the button
// reads from / writes to `uiStore` exactly as before — no behaviour
// change at the chat composer's existing call site.
export function AddContextButton({ open, onToggle, ref, pinCount: pinCountProp, onClearAll, surfaceKey: surfaceKeyProp }) {
  const internalBtnRef = useRef(null)
  const menuRef = useRef(null)
  // Phase 2.10b bug 1 refactor — chat surface uses per-thread keying.
  // When the host omits `surfaceKey` (chat composer call site), fall
  // back to the active chat thread's key. PBH / IPB hosts pass their
  // own `'block:<sectionId>'` key explicitly.
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  const fallbackSurfaceKey = activeThreadId ? `chat:${activeThreadId}` : null
  const surfaceKey = surfaceKeyProp || fallbackSurfaceKey
  const chatStorePinCount = usePinnedContextStore((s) => (surfaceKey ? (s.surfaces[surfaceKey] ? s.surfaces[surfaceKey].length : 0) : 0))
  const pinStoreClearPins = usePinnedContextStore((s) => s.clearPins)
  const pinCount = typeof pinCountProp === 'number' ? pinCountProp : chatStorePinCount
  const clearPinned = onClearAll || (() => { if (surfaceKey) pinStoreClearPins(surfaceKey) })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  useEffect(() => {
    if (!menuOpen) return
    function onDocDown(e) {
      if (menuRef.current && menuRef.current.contains(e.target)) return
      setMenuOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
  function handleContextMenu(e) {
    if (pinCount === 0) return
    e.preventDefault()
    const rect = (internalBtnRef.current || e.currentTarget).getBoundingClientRect()
    setMenuPos({ x: rect.left, y: rect.top })
    setMenuOpen(true)
  }
  function handleClearAll() {
    clearPinned()
    setMenuOpen(false)
  }
  // Combine the external (forwarded) ref with the internal one we
  // need for menu positioning. Supports both function refs and
  // ref objects.
  function setRefs(el) {
    internalBtnRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref && typeof ref === 'object') ref.current = el
  }
  const title = pinCount > 0
    ? `Add context (${pinCount} pinned). Pinned items ride along with every message until removed. Right-click for more options.`
    : 'Add context. Pin entities, knowledge, relationships, or scenes so they ride along with every message until removed.'
  return (
    <>
      <button
        ref={setRefs}
        type="button"
        onClick={onToggle}
        onContextMenu={handleContextMenu}
        aria-pressed={!!open}
        aria-label="Add context"
        data-help-region={(surfaceKeyProp === undefined && pinCountProp === undefined && onClearAll === undefined) ? 'conversation:composer_add_context' : undefined}
        title={title}
        className={`relative flex items-center justify-center w-5 h-5 rounded border transition-colors ${
          open
            ? 'border-accent-600 bg-accent-700/80 text-white hover:bg-accent-600'
            : (pinCount > 0
                ? 'border-accent-700/60 bg-accent-900/30 text-accent-200 hover:bg-accent-800/40'
                : 'border-zinc-700 bg-zinc-900/30 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100')
        }`}
      >
        {/* Bold plus — "add" semantics, distinct from the scene-node
            icon next to it which means "include scene context". */}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {pinCount > 0 && !open && (
          <span className="absolute -top-1 -right-1 text-[8px] leading-none px-0.5 rounded-full bg-accent-700 text-white font-semibold">
            {pinCount}
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded shadow-xl text-[11px]"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            transform: 'translateY(calc(-100% - 4px))',
          }}
        >
          <button
            type="button"
            onClick={handleClearAll}
            className="block w-full text-left px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap"
          >
            Remove all added context ({pinCount})
          </button>
        </div>
      )}
    </>
  )
}


// Picker popover for adding items to the pinned-context list.
// Reuses the existing single-kind picker components (one each for
// Entity / Knowledge / Relationship / Scene) — no bespoke picker
// here.
//
// Phase 2.5h restructure — the popup has two top-level tabs:
//   1. Scenes & Story Scope (first / default) — the Scene picker
//      plus the new whole-story / chapter / act / prev / next
//      controls (see `StoryScopeControls` below).
//   2. Story Objects — Entity / Knowledge / Relationship combined
//      under a single tab with a kind sub-switcher.
// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — IPB /
// PBH manual context attachment). Three optional overrides let a host
// outside the chat composer drive the popover against its own pinned-
// items list instead of the chat store's `chatPinnedContextItems`:
//   - `pinned` (array) — replaces the dedupe input (the "exclude items
//     already pinned" computation)
//   - `onAdd` (function) — replaces the `addPinnedContextItem` call
//     fired when the writer picks an item
//   - `hideStoryScope` (bool) — hides the Scenes & Story Scope tab.
//     The chat composer's scope sub-system is conversation-scoped and
//     doesn't apply to a one-shot Prompt Block; the IPB / PBH host
//     passes this flag so the writer doesn't see an irrelevant tab.
// When all three are omitted (the chat composer's call site), the
// popover reads from / writes to `uiStore` exactly as before — no
// behaviour change at the chat composer's existing call site.
export function AddContextPickerPopover({ threadId, triggerRef, onClose, pinned: pinnedProp, onAdd, hideStoryScope = false, hideStoryObjects = false }) {
  const ref = useRef(null)
  // Default to 'objects' when the Scenes tab is hidden (Prompt Block);
  // 'scenes' is the chat composer's default first tab.
  const [tab, setTab] = useState('dynamic')
  const [objectKind, setObjectKind] = useState('character')  // sub-kind inside Story Objects
  const [conceptSearch, setConceptSearch] = useState('')     // References sub-tab search
  // Phase 2.10b bug 1 refactor — chat surface key is per-thread.
  const chatStoreAddPin = usePinnedContextStore((s) => s.addPin)
  const addPinned = onAdd || ((item) => { if (threadId) chatStoreAddPin(`chat:${threadId}`, item) })

  // Click-outside (capture phase to dodge any stopPropagation), plus
  // Escape. The triggerRef exclusion lets the toggle button drive
  // open/close without fighting this handler.
  useEffect(() => {
    function onDocDown(e) {
      if (!ref.current) return
      if (ref.current.contains(e.target)) return
      if (triggerRef?.current && triggerRef.current.contains(e.target)) return
      onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Phase 2.9c v0.2.9.41 — viewport-fixed position computed from the
  // trigger's bounding rect. The popover renders via `createPortal`
  // to `document.body` so the host surface's overflow / clip box can
  // never crop it. Was previously `absolute bottom-full left-2`
  // relative to the trigger's wrapper, which got clipped by the
  // PBH host Section's `.nn-section { overflow: hidden }` — the chat
  // composer's call site never noticed because its layout has no
  // ancestor clip box around the toolbar. Position recomputes on
  // window scroll / resize so the popover stays anchored to the
  // trigger across editor scrolling.
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    function recompute() {
      if (!triggerRef?.current) return
      const r = triggerRef.current.getBoundingClientRect()
      setPos({
        left: r.left,
        bottom: window.innerHeight - r.top + 4,  // 4px gap above trigger
      })
    }
    recompute()
    window.addEventListener('scroll', recompute, true)  // capture phase catches scrollable ancestors
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [triggerRef])

  // Source data for the existing pickers. Pulled once at render
  // time; the popover is short-lived enough that resubscribing
  // per-keystroke would be wasteful (the inner pickers handle
  // their own filter state).
  const allEntities = useMemo(() => {
    const es = useEntitiesStore.getState()
    return [...es.characters, ...es.locations, ...es.items, ...es.factions, ...es.customs]
  }, [])
  const allKnowledges = useMemo(() => useProjectStore.getState().knowledges || [], [])
  const allRelationships = useMemo(() => useProjectStore.getState().relationships || [], [])
  // Concept nodes (Phase 8.7) — canvas referenceNodes with sub_type 'concept'.
  // Snapshot at open like knowledges / relationships; the popover is short-lived.
  const allConcepts = useMemo(() => (useProjectStore.getState().nodes || []).filter((n) => n.type === 'referenceNode' && n.data?.sub_type === 'concept'), [])
  const filteredConcepts = useMemo(() => {
    const q = conceptSearch.trim().toLowerCase()
    if (!q) return allConcepts
    return allConcepts.filter((n) => (n.data?.title || '').toLowerCase().includes(q))
  }, [allConcepts, conceptSearch])
  // Context Cues live in their own store. Subscribe so the picker
  // re-renders when the writer adds / renames / deletes cues in the
  // library section while this popover is open. `loadCues` is
  // idempotent; we kick it on mount so a fresh app load has the
  // cue list available the first time the picker opens.
  const allCues = useContextCuesStore((s) => s.cues)
  const loadCues = useContextCuesStore((s) => s.loadCues)
  useEffect(() => { loadCues() }, [loadCues])

  // Exclude items that ALREADY have a dynamic (non-anchored) pill —
  // the popover's add path produces dynamic pills, and the store's
  // duplicate guard would silently drop a second dynamic add for the
  // same `(kind, id)`. Items with ONLY anchored pills (single-anchor
  // or range) stay in the picker so the writer can still add a
  // dynamic alongside their existing anchored coverage — the two
  // pill shapes are semantically distinct (anchored = locked to a
  // chain position, dynamic = follow the conversation's current
  // scene). Scene scope picks are managed inside the Story Scope
  // controls, not here.
  const chatStorePinned = usePinnedContextStore((s) => (threadId ? (s.surfaces[`chat:${threadId}`] || _EMPTY_PINS) : _EMPTY_PINS))
  const pinned = pinnedProp || chatStorePinned
  const excludeByKind = useMemo(() => {
    const out = { entity: new Set(), knowledge: new Set(), relationship: new Set(), cue: new Set(), concept: new Set() }
    for (const p of (pinned || [])) {
      if (!p || !out[p.kind] || !p.id) continue
      const isDynamic = !p.anchor_node_id && !p.anchor_range
      // Cues are exempt from the merge / anchor model entirely —
      // they're always pinned in their bare `{kind, id}` shape, so
      // any pinned cue with this id is a duplicate.
      if (p.kind === 'cue' || isDynamic) out[p.kind].add(p.id)
    }
    return out
  }, [pinned])

  function pickAndClose(item) {
    addPinned(item)
    onClose()
  }

  // Top-level tabs (Phase 2.5h restructure, extended Phase 2.8).
  // Scenes & Story Scope is the first / default tab; Story Objects
  // rolls Entity / Knowledge / Relationship together under one tab;
  // Context Cues (Phase 2.8) replaces what was originally a separate
  // puzzle-piece toolbar button — folded into this picker as a tab
  // for one writer-facing entry point. The tab carries the puzzle-
  // piece glyph so the affordance stays visually recognisable.
  // Scenes & Story Scope tab is conversation-scoped (per-thread scope
  // settings, scene anchoring, prev/next inclusion). When
  // `hideStoryScope` is set the host (e.g. a Prompt Block) doesn't want
  // any of that — the tab is omitted entirely so the writer sees only
  // the controls that map cleanly to their one-shot send.
  // Phase 2.10b items 9 + 10 — Dynamic tab + tab reorganization.
  //   - Dynamic tab (new, every surface) — marker-type picker that
  //     produces `pin_kind: 'dynamic'` pills with `source: 'manual'`.
  //   - Story Structure tab (renamed from Scenes & Story Scope) —
  //     keeps the chat composer's per-thread Story Scope controls
  //     (by-chapter / by-act / + Add Scene). Hidden on PBH / IPB via
  //     `hideStoryScope` since those surfaces are one-shot.
  //   - Story Objects + Context Cues tabs unchanged.
  const TOP_TABS = [
    { key: 'dynamic', label: 'Dynamic' },
    !hideStoryScope && { key: 'scenes', label: 'Story Structure' },
    !hideStoryObjects && { key: 'objects', label: 'Story Objects' },
    { key: 'cues', label: 'Context Cues', icon: 'puzzle' },
  ].filter(Boolean)
  // Story Objects sub-kind switcher (only rendered inside the objects tab).
  // Icon-only sub-kind tabs mirroring the Entity Library's tab bar (same
  // order + glyphs): the five entity subtypes, then Knowledge, Relationship,
  // and Concept. The entity subtypes all pin as `kind: 'entity'`; the picker
  // filters to the active subtype via EntityPickerPopover's `lockedType`.
  const OBJECT_SUB_KINDS = [
    { key: 'character',    label: 'Characters',    icon: TYPE_ICONS.character },
    { key: 'location',     label: 'Locations',     icon: TYPE_ICONS.location },
    { key: 'item',         label: 'Items',         icon: TYPE_ICONS.item },
    { key: 'faction',      label: 'Factions',      icon: TYPE_ICONS.faction },
    { key: 'custom',       label: 'Custom',        icon: TYPE_ICONS.custom },
    { key: 'knowledge',    label: 'Knowledge',     icon: TYPE_ICONS.knowledge },
    { key: 'relationship', label: 'Relationships', icon: <RelationshipIcon size={13} /> },
    { key: 'reference',    label: 'References',     icon: '📌' },
  ]

  // Don't render until the position has been computed — first render
  // happens with `pos=null`, the useLayoutEffect fills it synchronously
  // before paint. This avoids a one-frame flash at (0,0).
  if (!pos) return null
  return createPortal(
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[70] bg-zinc-900 border border-zinc-700 rounded shadow-xl w-[320px] text-[11px]"
      style={{ left: pos.left, bottom: pos.bottom }}
    >
      <div className="flex border-b border-zinc-800">
        {TOP_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide transition-colors ${
              tab === t.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
          >
            {t.icon === 'puzzle' && (
              <span className="text-[11px] leading-none" aria-hidden="true">🧩</span>
            )}
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-1">
        {tab === 'dynamic' && (
          <div>
            <div className="px-1.5 pt-1 pb-1 text-[9px] uppercase tracking-wide text-zinc-500">
              Dynamic Context Markers
            </div>
            <DynamicMarkerPickerPanel
              pinned={pinned}
              onPick={(marker) => {
                // Phase 2.10b items 1 + 9 — convert marker to a
                // dynamic pinned-item shape. `addPinned` is the
                // surface adapter (chat → uiStore.addPinnedContextItem;
                // PBH / IPB → onAdd prop wired by the host).
                addPinned({
                  sessionId: _newDynamicSessionId(),
                  pin_kind: 'dynamic',
                  marker,
                  source: 'manual',
                  source_prompt_id: null,
                })
                onClose()
              }}
            />
          </div>
        )}
        {tab === 'scenes' && (
          <div>
            <div className="px-1.5 pt-1 pb-1 text-[9px] uppercase tracking-wide text-zinc-500">
              Story Structure
            </div>
            <StoryScopeControls threadId={threadId} />
          </div>
        )}
        {tab === 'objects' && (
          <div className="space-y-1">
            <div className="flex border-b border-zinc-800">
              {OBJECT_SUB_KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setObjectKind(k.key)}
                  title={k.label}
                  className={`flex-1 flex items-center justify-center px-1 py-1.5 text-sm transition-colors ${
                    objectKind === k.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
                  }`}
                >
                  {typeof k.icon === 'string' ? <span className="leading-none">{k.icon}</span> : k.icon}
                </button>
              ))}
            </div>
            <div className="p-1">
              {['character', 'location', 'item', 'faction', 'custom'].includes(objectKind) && (
                <EntityPickerPopover
                  allEntities={allEntities}
                  lockedType={objectKind}
                  excludeIds={excludeByKind.entity}
                  onPick={(id) => pickAndClose({ kind: 'entity', id })}
                  onClose={onClose}
                />
              )}
              {objectKind === 'knowledge' && (
                <KnowledgePickerPopover
                  allKnowledges={allKnowledges}
                  excludeIds={excludeByKind.knowledge}
                  onPick={(id) => pickAndClose({ kind: 'knowledge', id })}
                  onClose={onClose}
                />
              )}
              {objectKind === 'relationship' && (
                <RelationshipPickerPopover
                  allRelationships={allRelationships}
                  allEntities={allEntities}
                  excludeIds={excludeByKind.relationship}
                  onPick={(id) => pickAndClose({ kind: 'relationship', id })}
                  onClose={onClose}
                />
              )}
              {objectKind === 'reference' && (
                <div className="p-1.5 space-y-1">
                  <input
                    data-help-region="concept-picker:search"
                    autoFocus
                    value={conceptSearch}
                    onChange={(e) => setConceptSearch(e.target.value)}
                    placeholder="Search…"
                    className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  />
                  <div className="max-h-[280px] overflow-y-auto space-y-0.5">
                    {filteredConcepts.length === 0 ? (
                      <p className="text-[10px] text-zinc-600 italic px-1">
                        {allConcepts.length === 0
                          ? 'No concept nodes on the canvas yet. Add a Concept node to attach one as context.'
                          : 'No matches.'}
                      </p>
                    ) : filteredConcepts.map((node) => {
                      const isPinned = excludeByKind.concept.has(node.id)
                      const title = (node.data?.title || '').trim() || 'Untitled concept'
                      const colour = node.data?.colour || '#40afd0'
                      return (
                        <button
                          key={node.id}
                          type="button"
                          disabled={isPinned}
                          onClick={() => pickAndClose({ kind: 'concept', id: node.id })}
                          title={isPinned
                            ? `${title} — already pinned to this conversation.`
                            : `Pin "${title}" to this conversation.`}
                          className={`w-full text-left px-2 py-1 flex items-center gap-1.5 rounded transition-colors ${
                            isPinned ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                          }`}
                          style={{ backgroundColor: colour + '24' }}
                        >
                          <span className="text-[11px] leading-none" aria-hidden="true">💡</span>
                          <span className="text-[11px] text-zinc-100 truncate">{title}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {tab === 'cues' && (
          <div className="space-y-1">
            <div className="px-1.5 pt-1 pb-1 text-[9px] uppercase tracking-wide text-zinc-500">
              Saved Cues
            </div>
            {(allCues || []).length === 0 ? (
              <div className="px-1.5 pb-2 text-[10px] italic text-zinc-500 leading-snug">
                No Context Cues saved yet. Open the Library panel's Cues section to compose one.
              </div>
            ) : (
              <div className="max-h-[280px] overflow-y-auto">
                {(allCues || []).map((cue) => {
                  const isPinned = excludeByKind.cue.has(cue.id)
                  // Cue bodies are stored as TipTap HTML (rich-text
                  // editing landed in v0.2.5.42). Use the canonical
                  // `tiptapHtmlToPlain` helper to strip tags and
                  // decode entities so the writer sees rendered
                  // text, not raw markup. The same module exposes
                  // `tiptapHtmlToMarkdown` for the LLM-facing
                  // rendering in `sceneContextPrompt.js`.
                  const previewBody = tiptapHtmlToPlain(cue.body)
                  // Per-cue colour tint mirrors the library list /
                  // editor header / pinned-context chip. Inline
                  // backgroundColor at ~14% alpha so the row reads
                  // tinted without overpowering the dropdown chrome;
                  // inline style overrides the default `hover:bg-`
                  // class so the hover-bg effect doesn't apply when
                  // a colour is set (the writer already has strong
                  // visual identification from the tint itself).
                  const hasColour = !!cue.colour
                  const rowStyle = hasColour
                    ? { backgroundColor: cue.colour + '24' }
                    : undefined
                  return (
                    <button
                      key={cue.id}
                      type="button"
                      disabled={isPinned}
                      onClick={() => pickAndClose({ kind: 'cue', id: cue.id })}
                      title={isPinned
                        ? `${cue.name} — already pinned to this conversation.`
                        : `Pin "${cue.name}" to this conversation.`}
                      className={`w-full text-left px-2 py-1 flex flex-col gap-0.5 transition-colors ${
                        isPinned
                          ? 'opacity-40 cursor-not-allowed'
                          : hasColour
                            ? 'cursor-pointer'
                            : 'hover:bg-zinc-800/60 cursor-pointer'
                      }`}
                      style={rowStyle}
                    >
                      <span className="text-[11px] text-zinc-100 truncate">
                        {cue.name || '(unnamed cue)'}
                      </span>
                      {previewBody && (
                        <span className="text-[10px] text-zinc-500 truncate">
                          {previewBody.length > 60 ? previewBody.slice(0, 60) + '…' : previewBody}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}


// MIME types the Entity Library hands off via drag-and-drop. Used
// by both the dragenter detector (to show the strip as a drop zone
// when otherwise empty) and the actual drop handler.
// Phase 2.5h — mode-badge hover tooltip. Used by the in-strip
// Description / Desc+Chng / Full badges; clicking the badge cycles
// to the next mode, hovering shows what each level represents.
// Labels mirror the Scenes & Story Scope popup so the writer learns
// one vocabulary and sees it everywhere. Labels say "Description"
// because that's literally what the lightest level sends (the
// scene's `description` field — not a generated summary).
// Phase 2.10b items 1 + 9 — stable session id for a freshly-added
// dynamic pinned-context pill. Mirrors the helper in
// `applyPromptOnPick.js`; kept module-local here to avoid a
// cross-package import for one one-liner.
function _newDynamicSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'dyn_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function _modeBadgeTooltip(badge) {
  const lines = []
  lines.push(`Current: ${badge}`)
  lines.push('')
  lines.push('Description — scene title, position in the story, and the scene\'s short description.')
  lines.push('Desc+Chng — Description, plus the chain events recorded at this scene (entity, relationship, knowledge, and awareness changes).')
  lines.push('Full — Desc+Chng, plus the scene\'s full main_content body. Token-heavy.')
  lines.push('')
  const nextBadge = badge === 'Description' ? 'Desc+Chng' : badge === 'Desc+Chng' ? 'Full' : 'Description'
  lines.push(`Click to cycle to: ${nextBadge}.`)
  return lines.join('\n')
}


// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — IPB /
// PBH manual context attachment). Same MIME set the chat composer's
// drop zone listens for; the library cards / chips that emit these
// payloads (entity / knowledge / relationship / cue drag sources)
// don't need any changes — the Prompt Block just listens for the
// same payloads.
export const LIBRARY_DRAG_MIMES = [
  'application/nnz-entity-id',
  'application/nnz-knowledge-id',
  'application/nnz-relationship-id',
  'application/nnz-cue-id',
]
const _LIBRARY_DRAG_MIMES = LIBRARY_DRAG_MIMES

// Stable empty array used by per-thread story-scope selectors as the
// fallback when no entry exists for the active thread. Returning a
// fresh `[]` literal inside a Zustand selector triggers the
// "result of getSnapshot should be cached" warning and an infinite
// re-render loop, since each call yields a new array reference.
const _EMPTY_SCENE_IDS = Object.freeze([])
// Stable empty array for pinned-context selectors. Returning a fresh
// `[]` literal inside a Zustand selector triggers React's
// "getSnapshot should be cached" warning and an infinite re-render
// loop. Every selector that falls back when the surface bucket is
// absent must return this same reference.
const _EMPTY_PINS = Object.freeze([])

function ActiveContextStrip({ threadId }) {
  const enabled = useUiStore((s) => s.chatSceneContextEnabled)
  const setEnabled = useUiStore((s) => s.setChatSceneContextEnabled)
  // Phase 2.10b bug 1 refactor — pin storage is on the unified
  // pinnedContextStore, keyed per-thread.
  const pinnedItems = usePinnedContextStore((s) => (threadId ? (s.surfaces[`chat:${threadId}`] || _EMPTY_PINS) : _EMPTY_PINS))
  const removePinnedItem = usePinnedContextStore((s) => s.removePin)
  const addPinnedItem = usePinnedContextStore((s) => s.addPin)
  // Phase 2.5h — Story Scope summary chip surface. Reads the writer's
  // per-thread scope settings and builds a one-line label (e.g.
  // "Story summary", "Chapter 3 + Prev"). When no scope is active the
  // chip is hidden and the strip falls through to its existing logic.
  const storyScopeMode      = useUiStore((s) => (threadId ? s.chatStoryScopeMode?.[threadId] || null : null))
  const storyScopeChapterId = useUiStore((s) => (threadId ? s.chatStoryScopeChapter?.[threadId] || null : null))
  const storyScopeActId     = useUiStore((s) => (threadId ? s.chatStoryScopeAct?.[threadId] || null : null))
  const storyScopePrev      = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludePrev?.[threadId] : false))
  const storyScopeNext      = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludeNext?.[threadId] : false))
  const storyChapters       = useProjectStore((s) => s.story?.chapters)
  const storyActs           = useProjectStore((s) => s.story?.acts)
  const setStoryScopeMode      = useUiStore((s) => s.setChatStoryScopeMode)
  const setStoryScopeChapter   = useUiStore((s) => s.setChatStoryScopeChapter)
  const setStoryScopeAct       = useUiStore((s) => s.setChatStoryScopeAct)
  const setStoryScopeIncPrev   = useUiStore((s) => s.setChatStoryScopeIncludePrev)
  const setStoryScopeIncNext   = useUiStore((s) => s.setChatStoryScopeIncludeNext)
  const activeSceneId = useActiveSceneId()
  const sceneTitle = useActiveSceneTitle(activeSceneId)
  // Pull the canvas-state inputs `NodeBadge` needs: the full nodes
  // list (so it can find the scene by id) and the entity map (so it
  // can resolve EntityRefs to colour / name on the badge). Returned
  // verbatim from the store; NodeBadge handles its own missing-data
  // fallbacks.
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const [previewOpen, setPreviewOpen] = useState(false)

  // Phase 2.7c — range-pin reconciliation on chain reorder. When the
  // writer reorders the canvas such that a range pin's originally-
  // selected scene set is no longer contiguous in the new chain
  // order, the pin auto-splits into the necessary mix of contiguous
  // range pins + single-anchor pins so the writer's original intent
  // (which specific scenes were attached) is preserved.
  //
  // Gated on the chat panel being open on a conversation. This
  // component is already only rendered in that state, so the gate is
  // mostly defensive — but it also makes the contract explicit: the
  // reconciler runs ONLY while chat is open (so we never do
  // background work the writer isn't seeing the result of) and runs
  // on FIRST open after a closed-period reorder (the effect fires on
  // mount with current inputs, catching any pins that became
  // non-contiguous while the panel was hidden). Self-stabilising —
  // if no ops are returned, nothing mutates and the next render
  // passes through.
  const _chatOpenForReconcile = useIsChatOpenOnConversation()
  useEffect(() => {
    if (!_chatOpenForReconcile || !threadId) return
    const { changed, ops } = reconcileRangePinsAgainstChain(pinnedItems)
    if (changed) applyRangePinReconciliation(`chat:${threadId}`, ops)
  }, [_chatOpenForReconcile, pinnedItems, nodes, edges, threadId])
  // When the modal is opened by clicking a pinned-context chip,
  // this carries the item so the modal can scroll-and-highlight
  // its heading after the body renders. null when the modal was
  // opened from the scene pill or any other generic entry point.
  const [previewFocusItem, setPreviewFocusItem] = useState(null)
  // Phase 2.7c — range-selector modal carries the focused pinned-
  // context entry whose anchor is being edited. Opens when the
  // anchor badge on any entry is clicked; closes via Cancel, Esc,
  // backdrop click, or successful Confirm.
  const [rangeSelectorItem, setRangeSelectorItem] = useState(null)
  // Phase 2.5h — system-prompt preview modal (writer's prompt + story-
  // scope appendage). Independent of the per-message scene-context
  // preview above. `systemPromptFocusKey` carries the chip type
  // (`mode` / `chapter` / `act` / `scenes` / `prev` / `next` / null)
  // so the modal can scroll-and-highlight the section that chip
  // represents, matching the scene-context preview's click-to-anchor
  // interaction.
  const [systemPromptPreviewOpen, setSystemPromptPreviewOpen] = useState(false)
  const [systemPromptFocusKey, setSystemPromptFocusKey] = useState(null)
  // Drag-and-drop affordance — show the strip as a drop zone whenever
  // Library-drag drop is now handled exclusively by the larger
  // composer-area drop zone (around the message input). The strip
  // used to render its own dashed-outline drop region + "Drop here
  // to pin as context" placeholder when a drag was in progress,
  // but it overlapped the composer drop zone and added no
  // functional benefit — the composer drop already calls
  // `addPinnedContextItem` for the same MIMEs. The strip-level
  // `dragActive` / `dragOverStrip` state + global drag listeners
  // are gone.
  const sceneChipVisible = !!(enabled && activeSceneId)
  const pinnedVisible = (pinnedItems || []).length > 0
  // Phase 2.5h — one chip per active story-scope axis so the writer
  // can remove each individually. The whole-story radio is mutually
  // exclusive so it contributes at most one chip; the rest contribute
  // one chip each when active. Each carries its own remove handler
  // that zeroes out just that axis.
  const storyScopeChips = []
  if (storyScopeMode === 'summary' || storyScopeMode === 'summary_with_changes' || storyScopeMode === 'full_content') {
    const modeLabel = storyScopeMode === 'summary' ? 'Story descriptions'
      : storyScopeMode === 'summary_with_changes' ? 'Story descriptions + changes'
      : 'Whole story content'
    storyScopeChips.push({
      key: 'mode',
      label: modeLabel,
      onRemove: () => threadId && setStoryScopeMode(threadId, null),
    })
  }
  if (storyScopeChapterId) {
    const chap = (storyChapters || []).find((c) => c.id === storyScopeChapterId)
    const chapTitle = chap?.title || chap?.name || 'Untitled'
    storyScopeChips.push({
      key: 'chapter',
      label: `Chapter: ${chapTitle}`,
      focusLabel: chapTitle,
      onRemove: () => threadId && setStoryScopeChapter(threadId, null),
    })
  }
  if (storyScopeActId) {
    const act = (storyActs || []).find((a) => a.id === storyScopeActId)
    const actTitle = act?.title || act?.name || 'Untitled'
    storyScopeChips.push({
      key: 'act',
      label: `Act: ${actTitle}`,
      focusLabel: actTitle,
      onRemove: () => threadId && setStoryScopeAct(threadId, null),
    })
  }
  // Picker-added scene picks are no longer rendered as Story-Scope
  // dynamic chips here — they're proper static `kind: 'scene'` pins
  // on the unified `pinnedContextStore` and render via the standard
  // `PinRow` / `PinnedContextChip` path with the same cycle-button
  // affordance every other scene pin gets. One pill type, one
  // storage, one renderer regardless of add-path (canvas Attach or
  // Story Structure tab picker).
  if (storyScopePrev) {
    storyScopeChips.push({
      key: 'prev',
      label: '+ Prev',
      onRemove: () => threadId && setStoryScopeIncPrev(threadId, false),
    })
  }
  if (storyScopeNext) {
    storyScopeChips.push({
      key: 'next',
      label: '+ Next',
      onRemove: () => threadId && setStoryScopeIncNext(threadId, false),
    })
  }
  const storyScopeChipVisible = storyScopeChips.length > 0
  // Hide entirely only when there's nothing to show. The strip no
  // longer renders an empty placeholder during library drags — the
  // composer-area drop zone (around the message input) is the
  // single drop target for library DnD.
  if (!sceneChipVisible && !pinnedVisible && !storyScopeChipVisible) return null
  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 pt-1.5 pb-0.5 transition-colors">
        {sceneChipVisible && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] uppercase tracking-wide font-semibold text-zinc-400">
              Current Scene:
            </span>
            <span
              className="inline-flex items-center gap-1 border border-accent-700/60 bg-accent-900/30 rounded-full overflow-hidden"
              title={`Scene context for "${sceneTitle}" will be sent with each new message until you toggle it off. Auto-updates when you navigate to a different scene. Click the pill to preview the exact text.`}
            >
              {/* Bug 3 (Phase 2.10) — bolt identifies that this pill's
                  reference is dynamic. The chat's active scene IS the
                  one Tier 1 toggle whose target can change (the writer
                  navigates the canvas; the chip auto-updates). PBH/IPB
                  Tier 1 toggles live in a fixed scene's editor so they
                  carry no bolt. */}
              <span className="inline-flex items-center pl-1.5" aria-hidden="true">
                <DynamicBoltIcon size={10} />
              </span>
              <button
                type="button"
                onClick={() => { setPreviewFocusItem(null); setPreviewOpen(true) }}
                aria-label={`Preview scene context for ${sceneTitle}`}
                className="flex items-center gap-1 pr-1 py-0.5 hover:bg-accent-800/40 transition-colors cursor-pointer text-left"
              >
                <NodeBadge nodeId={activeSceneId} nodes={nodes} />
              </button>
              <button
                type="button"
                onClick={() => setEnabled(false)}
                title="Stop sending scene context with messages"
                aria-label="Remove scene context"
                className="text-accent-300 hover:text-white hover:bg-accent-700/60 w-4 h-4 mr-0.5 flex items-center justify-center text-[10px] leading-none rounded-full"
              >
                ✕
              </button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
        {storyScopeChips.map((chip) => (
          <StoryScopeDynamicChip
            key={chip.key}
            chip={chip}
            nodes={nodes}
            activeSceneId={activeSceneId}
            setSystemPromptFocusKey={setSystemPromptFocusKey}
            setSystemPromptPreviewOpen={setSystemPromptPreviewOpen}
          />
        ))}
        {threadId && (
          <PinRow
            surfaceKey={`chat:${threadId}`}
            flashScope="chat"
            anchorSceneId={enabled ? activeSceneId : null}
            onPreview={(item) => { setPreviewFocusItem(item); setPreviewOpen(true) }}
            onOpenAnchorPicker={(item) => setRangeSelectorItem(item)}
          />
        )}
        </div>
      </div>
      {previewOpen && (
        <SceneContextPreviewModal
          // Match the send path: only pass the active scene when
          // scene context is actually enabled. Passing it whenever
          // the sticky id is set (even with the toggle off) made the
          // preview render scene-context-aware resolutions for origin
          // pins, which the send path would never emit.
          sceneId={enabled ? activeSceneId : null}
          sceneTitle={sceneTitle}
          focusItem={previewFocusItem}
          onClose={() => { setPreviewOpen(false); setPreviewFocusItem(null) }}
        />
      )}
      {systemPromptPreviewOpen && (
        <SystemPromptPreviewModal
          threadId={threadId}
          focusKey={systemPromptFocusKey}
          onClose={() => { setSystemPromptPreviewOpen(false); setSystemPromptFocusKey(null) }}
        />
      )}
      {rangeSelectorItem && (
        <ChainRangeSelectorModal
          item={rangeSelectorItem}
          otherPinMarkers={_computeOtherPinMarkers(rangeSelectorItem, pinnedItems)}
          otherPinRangeFillSpans={(() => {
            // Dashed-bar visualisation: one entry per OTHER range pin
            // for the same `(kind, id)` so the writer can see the
            // dashed-ringed dots connected as a single range entry
            // (parallel to the solid in-flight fill bar).
            const ranges = (pinnedItems || [])
              .filter((p) => p && p.sessionId !== rangeSelectorItem.sessionId
                && p.kind === rangeSelectorItem.kind
                && p.id === rangeSelectorItem.id
                && p.anchor_range?.start_node_id
                && p.anchor_range?.end_node_id)
              .map((p) => ({
                startChainPointId: p.anchor_range.start_node_id,
                endChainPointId: p.anchor_range.end_node_id,
              }))
            return ranges.length > 0 ? new Map([[rangeSelectorItem.id, ranges]]) : null
          })()}
          dynamicResolutionPoint={_computeDynamicResolutionPoint(rangeSelectorItem, pinnedItems, activeSceneId, enabled)}
          dynamicPinSessionId={(() => {
            const match = (pinnedItems || []).find((p) => (
              p && p.kind === rangeSelectorItem.kind
              && p.id === rangeSelectorItem.id
              && p.sessionId !== rangeSelectorItem.sessionId
              && !p.anchor_node_id && !p.anchor_range
            ))
            return match?.sessionId || null
          })()}
          onAddDynamicPin={() => {
            // Ctrl-click on the "Dynamically match" button — add a
            // dynamic context entry alongside whatever the writer's
            // draft selection is, without touching the modal's draft.
            // Dynamic pills are exempt from the merge rule per spec,
            // so we add via the store action directly. The button is
            // gated on `hasDynamicPin` being false; the store also
            // dedups by identity so a double-fire is harmless.
            addPinnedItem(`chat:${threadId}`, { kind: rangeSelectorItem.kind, id: rangeSelectorItem.id })
          }}
          onClose={() => setRangeSelectorItem(null)}
          onClearOtherPin={(sessionId) => removePinnedItem(`chat:${threadId}`, sessionId)}
          onCommit={async (newPins) => {
            // DRAFT semantics: nothing in the pinned-context list
            // mutates until we know what the writer wants to do with
            // overlaps. Analyze the consequences ACROSS THE WHOLE
            // BATCH first, surface ONE dialog if anything overlaps,
            // then either apply atomically (Confirm) or leave the
            // modal open so the writer can adjust (Cancel).
            const focusedSessionId = rangeSelectorItem?.sessionId || null
            const surfaceKey = `chat:${threadId}`
            const consequences = analyzeCommitConsequences(surfaceKey, newPins || [], focusedSessionId)
            const hasAnchored = consequences.groups.length > 0

            if (!hasAnchored || (!consequences.hasOverlap && !consequences.isPureNoOp)) {
              applyConsequences(surfaceKey, consequences, focusedSessionId)
              setRangeSelectorItem(null)
              return
            }

            const message = formatConsequencesMessage(consequences)
            const result = await openConfirmDialog({
              title: consequences.isPureNoOp
                ? 'Already covered'
                : 'Merge with existing context?',
              message,
              buttons: consequences.isPureNoOp
                ? [{ label: 'OK', value: 'ok', style: 'primary' }]
                : [
                    { label: 'Confirm and merge', value: 'confirm', style: 'primary' },
                    { label: 'Cancel', value: 'cancel', style: 'neutral' },
                  ],
              cancelValue: 'cancel',
            })

            if (consequences.isPureNoOp) {
              // Inform-only — close the modal without changes so the
              // writer's acknowledgement dismisses the picker. (If we
              // ever want to keep the modal open here too, swap this
              // for a no-op return; for now the OK button reads as
              // "I see, I'm done".)
              setRangeSelectorItem(null)
              return
            }
            if (result !== 'confirm') {
              // Cancel → modal stays open, draft selection intact.
              return
            }
            applyConsequences(surfaceKey, consequences, focusedSessionId)
            setRangeSelectorItem(null)
          }}
        />
      )}
    </>
  )
}


// Build the `otherPinMarkers` map the range-selector modal hands
// through to `TimelineGridView` so dashed rings render at every
// chain point covered by ANOTHER pinned-context entry for the same
// `(kind, id)`. Single-anchor entries contribute their one anchor;
// range entries expand into every chain point in [start..end] via
// the chain walker. Dynamic entries contribute nothing here — they
// surface through `dynamicResolutionPoint` instead.
function _computeOtherPinMarkers(focused, allPins) {
  if (!focused || !Array.isArray(allPins)) return null
  const others = allPins.filter((p) => (
    p && p.sessionId !== focused.sessionId
    && p.kind === focused.kind
    && p.id === focused.id
  ))
  if (others.length === 0) return null
  // Resolve the kind's chain id ordering once so we can expand
  // each range into per-point sets.
  const ps = useProjectStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []
  let chainIds = []
  try {
    if (focused.kind === 'entity') {
      const chain = getEntityNarrativeChain(focused.id, nodes, edges) || []
      chainIds = chain.map((n) => n.id)
    } else if (focused.kind === 'knowledge') {
      const k = (ps.knowledges || []).find((x) => x.id === focused.id)
      if (k) chainIds = getKnowledgeNodeOrder(k, nodes, edges) || []
    } else if (focused.kind === 'relationship') {
      const r = (ps.relationships || []).find((x) => x.id === focused.id)
      if (r) chainIds = getRelationshipNodeOrder(r, nodes, edges) || []
    }
  } catch { chainIds = [] }
  const markers = []
  for (const p of others) {
    if (!p.anchor_node_id && !p.anchor_range) continue  // dynamic, skip
    const entry = {
      sessionId: p.sessionId,
      label: '(other entry)',  // first-pass; modal renders this in the right-click hint
      origin: false,
      final: false,
      scenes: new Set(),
      modifiers: new Set(),
    }
    if (p.anchor_node_id) _classifyMarkerNode(p.anchor_node_id, entry, nodes, chainIds)
    if (p.anchor_range && p.anchor_range.start_node_id && p.anchor_range.end_node_id) {
      const startIdx = chainIds.indexOf(p.anchor_range.start_node_id)
      const endIdx = chainIds.indexOf(p.anchor_range.end_node_id)
      if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
        for (let i = startIdx; i <= endIdx; i++) {
          _classifyMarkerNode(chainIds[i], entry, nodes, chainIds)
        }
      }
    }
    markers.push(entry)
  }
  return markers
}


function _classifyMarkerNode(nodeId, entry, nodes, chainIds) {
  if (!nodeId) return
  // Origin = first chain id; final = last chain id (when chain has >1).
  if (chainIds.length > 0 && nodeId === chainIds[0]) {
    entry.origin = true
    return
  }
  if (chainIds.length > 1 && nodeId === chainIds[chainIds.length - 1]) {
    entry.final = true
    return
  }
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return
  if (node.type === 'sceneNode') entry.scenes.add(nodeId)
  else if (node.type === 'entityNode' && node.data?.is_modifier) entry.modifiers.add(nodeId)
}


// Dynamic-resolution chain point — the chain point the focused
// object's dynamic entry currently resolves to. Returns null unless
// ALL of: scene context is on, there's an active scene, a dynamic
// entry exists for the same `(kind, id)`, and that active scene is
// on the focused object's narrative chain. Surfaces as the dotted
// zinc ring in the modal.
function _computeDynamicResolutionPoint(focused, allPins, activeSceneId, sceneContextEnabled) {
  if (!focused || !activeSceneId || !sceneContextEnabled) return null
  if (!Array.isArray(allPins)) return null
  const hasDynamic = allPins.some((p) => (
    p && p.kind === focused.kind && p.id === focused.id
    && !p.anchor_node_id && !p.anchor_range
  ))
  if (!hasDynamic) return null
  // Verify the active scene is on the focused object's chain.
  const ps = useProjectStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []
  let chainIds = []
  try {
    if (focused.kind === 'entity') {
      chainIds = (getEntityNarrativeChain(focused.id, nodes, edges) || []).map((n) => n.id)
    } else if (focused.kind === 'knowledge') {
      const k = (ps.knowledges || []).find((x) => x.id === focused.id)
      if (k) chainIds = getKnowledgeNodeOrder(k, nodes, edges) || []
    } else if (focused.kind === 'relationship') {
      const r = (ps.relationships || []).find((x) => x.id === focused.id)
      if (r) chainIds = getRelationshipNodeOrder(r, nodes, edges) || []
    }
  } catch { chainIds = [] }
  return chainIds.includes(activeSceneId) ? activeSceneId : null
}


// One chip per writer-pinned context item. Kind-colour-coded so
// the writer can scan the strip at a glance and tell apart
// pinned entities / scenes / chapters / free text. Clicking the
// chip opens the preview modal (so writers can see how their pin
// resolves at the current anchor). ✕ removes the pin.
//
// Three pin shapes, each with its own anchor badge:
//   - `item.anchor_node_id` set         → anchored. Label resolves
//                                         at that chain anchor. The
//                                         badge text + colour are
//                                         dispatched on the anchor
//                                         node's type (scene → purple
//                                         `@ <SceneName>`; entity
//                                         origin → green `@ NEW :
//                                         <TYPE>`; modifier → amber
//                                         `@ <modifier label>`; etc).
//   - No `anchor_node_id`               → dynamic legacy. Follows the
//                                         conversation's active scene,
//                                         origin fallback. Badge reads
//                                         `@ Current Scene` (struck
//                                         through when scene context
//                                         is off — the pin would
//                                         resolve at baseline).
//   - kind === 'scene'                  → no badge regardless. The
//                                         scene IS its own anchor;
//                                         `Scene: <title>` already
//                                         carries that meaning.
// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — IPB /
// PBH manual context attachment). Already fully prop-driven — no
// store reads of its own beyond the per-item flash-timestamp slot in
// `uiStore.chatPillFlashAt` (the chat-composer's name-detection
// scanner publishes flashes there; harmless for the Prompt Block use
// case since no flash for the block's pins will ever be written).
// The `onPreview` and `onOpenAnchorPicker` callbacks can be passed as
// no-ops when the host (e.g. Prompt Block) doesn't surface those UIs.
export function PinnedContextChip({ item, anchorSceneId, sceneContextEnabled, onPreview, onRemove, onCycleMode, onOpenAnchorPicker, flashScope = 'chat' }) {
  const pinAnchor = item.anchor_node_id || null
  const pinRange = item.anchor_range || null
  // Chain-aware entity identity for entity-kind pins. Walks the entity's
  // chain to the pin's effective anchor so the avatar / name / colour
  // reflect the entity's appearance AT the pinned chain position.
  // - pinAnchor set → walk to that node (the pin's explicit anchor).
  // - pinAnchor null + sceneContextEnabled → walk to anchorSceneId.
  // - pinAnchor null + !sceneContextEnabled → walk to null (= baseline,
  //   which is the chain-aware path at origin per the chain rule).
  // Range pins walk to the range's start node, matching the
  // wrapper-heading convention in `_renderPinnedSection`.
  const entity = useEntityById(item.kind === 'entity' ? item.id : null)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  // Anchor resolution for the pill's display:
  //   - range pin → walk to range start
  //   - explicit pin anchor → walk to that node
  //   - scene context on → walk to the active scene
  //   - otherwise (writer hasn't anchored AND no active scene) →
  //     `null`, which `computeEffectiveStateWithPrior` interprets as
  //     "walk every change in the entity's main forward chain" —
  //     i.e. the entity's LATEST state. Matches the wire-side
  //     fallback in `sceneContextPrompt.js` so the pill avatar /
  //     name / colour stay in lock-step with what the model sees.
  const entityChainWalkAnchor = item.kind === 'entity'
    ? (pinRange?.start_node_id || pinAnchor || (sceneContextEnabled ? anchorSceneId : null))
    : null
  const entityResolved = useMemo(() => {
    if (item.kind !== 'entity' || !entity) return null
    try {
      const storyOrder = getOrComputeStoryOrderFromStore()
      const { current } = computeEffectiveStateWithPrior(
        entity, nodes, edges, entityChainWalkAnchor, { storyOrder },
      )
      return current || null
    } catch {
      return null
    }
  }, [item.kind, entity, entityChainWalkAnchor, nodes, edges])
  // Phase 2.8 — flash-on-text-delete reminder. The chat composer's
  // detection scanner fires `flashChatPill(kind, id)` when the
  // writer deletes a previously-detected name from the input while
  // the corresponding pill is still pinned. We subscribe to the
  // chip's own timestamp slot so unrelated flashes don't re-render
  // every chip on the strip. The local `flashing` flag drives the
  // `nn-chat-pill-flash` keyframe and clears itself after the
  // animation finishes so a second flash on the same chip
  // re-triggers cleanly.
  const flashAt = useUiStore((s) => s.pillFlashAt?.[flashScope]?.[`${item.kind}:${item.id}`] || 0)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (!flashAt) return undefined
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 1400)
    return () => clearTimeout(t)
  }, [flashAt])
  const flashCls = flashing ? 'nn-chat-pill-flash' : ''
  // Flash colour — the entity's own colour if it's been customised
  // (NOT the default grey), otherwise the story accent. Looked up
  // live each render so re-pickering the entity's colour mid-flash
  // would also update the flash (rare but cheap). Baseline colour
  // is correct for this read: the chat-context pill represents the
  // entity as a whole (its identity), not a chain-anchored value at
  // some specific scene.
  const _storyAccent = useAccentColor() || '#7c3aed'
  const flashEntityColour = (() => {
    if (!flashing) return null  // no need to look up when not flashing
    if (item.kind === 'entity') {
      const es = useEntitiesStore.getState()
      for (const bucket of ENTITY_BUCKETS) {
        const ent = (es[bucket] || []).find((e) => e.id === item.id)
        if (ent) return ent.colour
      }
      return null
    }
    if (item.kind === 'knowledge') {
      const k = (useProjectStore.getState().knowledges || []).find((x) => x.id === item.id)
      return k?.colour
    }
    if (item.kind === 'relationship') {
      const r = (useProjectStore.getState().relationships || []).find((x) => x.id === item.id)
      return r?.colour
    }
    // scenes / cues don't have their own customisable colour for our purposes
    return null
  })()
  const flashColour = (flashEntityColour && !isDefaultEntityColour(flashEntityColour))
    ? flashEntityColour
    : _storyAccent
  const flashStyle = flashing ? { '--nn-pill-flash-colour': flashColour } : undefined
  // Label resolves at:
  //   - the range's start node (for range pins) — earliest covered
  //     state matches the renderer's wrapper-heading convention,
  //   - the pin's own anchor (for single-anchor pins),
  //   - the conversation's active scene (for dynamic pins when scene
  //     context is on; null otherwise — wire path resolves at origin
  //     baseline, mirror that here for preview parity).
  let labelAnchor
  if (pinRange) labelAnchor = pinRange.start_node_id
  else if (pinAnchor) labelAnchor = pinAnchor
  else labelAnchor = sceneContextEnabled ? anchorSceneId : null
  const labelInfo = _pinnedChipLabel(item, labelAnchor)
  const colourCls = _pinnedChipColour(item.kind)
  // Cues and scenes both render without an anchor badge — scenes ARE
  // their own anchor (badge would be redundant), and cues are
  // program-level objects with no chain so anchoring doesn't apply
  // (the chip is always a dynamic-style payload).
  const skipAnchorBadge = item.kind === 'scene' || item.kind === 'cue' || item.kind === 'toc' || item.kind === 'concept'
  const anchorBadge = skipAnchorBadge
    ? null
    : _resolvePinAnchorBadge(item, pinAnchor, sceneContextEnabled, anchorSceneId, pinRange)
  const tooltip = anchorBadge?.tooltip
    ? `Pinned ${item.kind} (${anchorBadge.tooltip}): ${labelInfo.full}. Sent with every message until removed.`
    : `Pinned ${item.kind}: ${labelInfo.full}. Sent with every message until removed.`
  // Cue pills render the canonical CueLabelChip identity (puzzle
  // icon + green→yellow gradient) instead of the generic teal pill
  // chrome the other kinds use. Keeps the cue visually identified
  // the same way it reads in the Library, the editor header, and
  // the AddContext popover. The outer wrapper drops its own
  // border / bg so the chip's chrome stands on its own.
  if (item.kind === 'cue') {
    return (
      <span className={`inline-flex items-center gap-0.5 rounded-full ${flashCls}`} style={flashStyle} title={tooltip}>
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Preview pinned cue: ${labelInfo.full}`}
          className="cursor-pointer hover:brightness-110 transition-[filter]"
        >
          <CueLabelChip name={labelInfo.short} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Unpin this cue"
          aria-label="Unpin"
          className="w-4 h-4 flex items-center justify-center text-[10px] leading-none rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700/60"
        >
          ✕
        </button>
      </span>
    )
  }
  // Concept pills render the canonical ConceptLabelChip identity (lightbulb
  // icon + cyan chrome) instead of the generic teal pill, matching how the
  // cue pill works — a concept is a program-level, no-chain object too.
  if (item.kind === 'concept') {
    return (
      <span className={`inline-flex items-center gap-0.5 rounded-full ${flashCls}`} style={flashStyle} title={tooltip}>
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Preview pinned concept: ${labelInfo.full}`}
          className="cursor-pointer hover:brightness-110 transition-[filter]"
        >
          <ConceptLabelChip name={labelInfo.short} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Unpin this concept"
          aria-label="Unpin"
          className="w-4 h-4 flex items-center justify-center text-[10px] leading-none rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700/60"
        >
          ✕
        </button>
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-1 border rounded-full overflow-hidden ${colourCls.border} ${colourCls.bg} ${flashCls}`}
      style={flashStyle}
      title={tooltip}
    >
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview pinned ${item.kind}: ${labelInfo.full}`}
        className={`flex items-center gap-1 pl-2 pr-1 py-0.5 text-[10px] ${colourCls.hover} transition-colors cursor-pointer`}
      >
        {item.kind === 'entity' && entity ? (
          // Entity pins render the standard EntityAvatar (entity-colour
          // border + profile image / type-icon glyph) in place of the
          // generic kind-short label. Values are chain-resolved at the
          // pin's anchor via `entityResolved` so a mid-story rename /
          // colour-change / profile-image-change at or before the
          // anchor reflects in the chip.
          <>
            <EntityAvatar
              entity={{
                id: entity.id,
                type: entity.type,
                colour: entityResolved?.colour || entity.colour,
                profile_image_ref: entityResolved?.profile_image_ref ?? entity.profile_image_ref,
              }}
              size={14}
            />
            <span
              className="truncate max-w-[160px] font-medium"
              style={(entityResolved?.colour || entity.colour) ? { color: entityResolved?.colour || entity.colour } : undefined}
            >
              {entityResolved?.name || labelInfo.short}
            </span>
          </>
        ) : (
          <>
            <span className={`text-[9px] uppercase tracking-wide font-semibold ${colourCls.label}`}>
              {labelInfo.kindShort}
            </span>
            <span className={`${colourCls.text} truncate max-w-[160px]`}>{labelInfo.short}</span>
          </>
        )}
      </button>
      {anchorBadge && item.kind === 'section' && (
        // Section pills are host-locked — no chain, no anchor picker.
        // Render the badge as a non-interactive label that just
        // identifies the owning surface.
        <span
          title={anchorBadge.tooltip}
          className={`inline-flex items-center px-1 py-0.5 text-[9px] uppercase tracking-wide font-semibold ${anchorBadge.className}`}
        >
          <span aria-hidden="true">@</span>
          <span className="ml-0.5 normal-case font-medium tracking-normal truncate max-w-[120px]">
            {anchorBadge.text}
          </span>
        </span>
      )}
      {/* Scene pill detail-level cycle badge. Cycles
          summary → summary_with_changes → full_content → summary.
          Labels DESC / DESC+ / FULL match the dynamic-pill cycle
          badges. Click is a writer-initiated config change (not a
          target identity change), so no flash needed. */}
      {item.kind === 'scene' && onCycleMode && (() => {
        const currentMode = item.mode || 'summary'
        const nextMode = currentMode === 'summary' ? 'summary_with_changes'
          : currentMode === 'summary_with_changes' ? 'full_content'
          : 'summary'
        const label = currentMode === 'summary_with_changes' ? 'DESC+'
          : currentMode === 'full_content' ? 'FULL'
          : 'DESC'
        const tooltip = currentMode === 'summary_with_changes'
          ? 'Description plus per-scene changes. Click to cycle to Full content.'
          : currentMode === 'full_content'
            ? 'Full scene content (description + narrative prose). Click to cycle back to Description only.'
            : 'Description only. Click to cycle to Description + Changes.'
        return (
          <button
            type="button"
            onClick={onCycleMode.bind(null, nextMode)}
            title={tooltip}
            aria-label={`Cycle scene detail level (currently ${label})`}
            className="px-1 py-0.5 text-[9px] uppercase tracking-wide font-semibold bg-zinc-700/60 border border-zinc-600 rounded hover:bg-zinc-600/60 text-zinc-100 cursor-pointer"
          >
            {label}
          </button>
        )
      })()}
      {anchorBadge && item.kind !== 'section' && (
        <button
          type="button"
          onClick={onOpenAnchorPicker}
          title={`${anchorBadge.tooltip}\n(Click to choose a different anchor point or range.)`}
          aria-label="Choose context anchor"
          className={`inline-flex items-center px-1 py-0.5 text-[9px] uppercase tracking-wide font-semibold cursor-pointer hover:brightness-125 transition-[filter] ${anchorBadge.className}`}
        >
          <span aria-hidden="true">{anchorBadge.prefixGlyph || '@'}</span>
          <span className={`ml-0.5 normal-case font-medium tracking-normal truncate ${anchorBadge.isRange ? 'max-w-[200px]' : 'max-w-[90px]'} ${anchorBadge.textStrike ? 'line-through italic text-red-400' : ''}`}>
            {anchorBadge.text}
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title={`Unpin this ${item.kind}`}
        aria-label="Unpin"
        className={`${colourCls.x} w-4 h-4 mr-0.5 flex items-center justify-center text-[10px] leading-none rounded-full`}
      >
        ✕
      </button>
    </span>
  )
}

// Phase 2.10b item 6 — Tier 2 chat composer Story Scope chip. Same
// content/layout as before; adds the unified dynamic-pill treatment
// (DynamicBoltIcon + `.nn-pill-dynamic` italic+dashed-border + flash
// on out-of-band target identity change). Behaviour unchanged — the
// underlying `chatStoryScope*` uiStore state buckets still drive
// what gets sent.
//
// Per-chip target identity keys are derived cheaply from the chip's
// shape (no chain walks): chip.sceneId for scene chips, chip.key for
// the rest. Prev / Next chips use `prev:<activeSceneId>` /
// `next:<activeSceneId>` so navigating to a different active scene
// changes the resolved target identity and flashes the chip (the
// proper "what is the previous scene right now" walk lands later
// in item 12; the chip's job here is to surface visual feedback).
// Cycle clicks on scene chips with a modeBadge are direct
// interactions — wrapped through `setSuppressNextFlash` so the
// granularity change doesn't read as out-of-band.
function StoryScopeDynamicChip({ chip, nodes, activeSceneId, setSystemPromptFocusKey, setSystemPromptPreviewOpen }) {
  const [suppressNextFlash, setSuppressNextFlash] = useState(false)
  // Cheap target identity per chip kind. Stable within the chip's
  // lifetime for scene / chapter / act / mode chips (those keys
  // identify a single object that doesn't change while the chip
  // exists); dynamic on Prev/Next so active-scene nav fires the flash.
  let targetKey
  if (chip.key === 'prev') targetKey = `prev:${activeSceneId || ''}`
  else if (chip.key === 'next') targetKey = `next:${activeSceneId || ''}`
  else if (chip.sceneId) targetKey = `scene:${chip.sceneId}`
  else targetKey = chip.key
  // Subscribe to the flash slot the hook writes to. Mirrors the
  // pattern in PinnedContextChip; key format matches what
  // `useDynamicPillFlash` writes (`dynamic:<sessionId>`). sessionId
  // here is the chip.key — stable across renders for the chip's
  // lifetime, unique within the Story Scope strip.
  const flashAt = useUiStore((s) => s.pillFlashAt?.chat?.[`dynamic:${chip.key}`] || 0)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (!flashAt) return undefined
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 1400)
    return () => clearTimeout(t)
  }, [flashAt])
  useDynamicPillFlash({
    scope: 'chat',
    sessionId: chip.key,
    targetKey,
    suppressNext: suppressNextFlash,
  })
  useEffect(() => {
    if (suppressNextFlash) {
      const id = setTimeout(() => setSuppressNextFlash(false), 0)
      return () => clearTimeout(id)
    }
    return undefined
  }, [suppressNextFlash])
  const flashCls = flashing ? 'nn-chat-pill-flash' : ''
  return (
    <span
      className={`inline-flex items-center gap-1 border border-zinc-600 bg-zinc-800/70 rounded-full overflow-hidden nn-pill-dynamic ${flashCls}`}
      title={`Story-scope section: ${chip.label}. Auto-updates when the active scene or story structure changes. Click to preview exactly what the model sees for this section. ✕ removes this section only.`}
    >
      <span className="inline-flex items-center gap-1 pl-1.5 py-0.5">
        <DynamicBoltIcon size={10} />
        <span className="text-[9px] uppercase tracking-wide font-semibold text-zinc-400">Story Scope</span>
      </span>
      {chip.modeBadge && chip.onCycleMode && (
        <button
          type="button"
          onClick={() => { setSuppressNextFlash(true); chip.onCycleMode() }}
          className="text-[8px] uppercase tracking-wider font-semibold px-1 py-0 rounded bg-zinc-700/70 border border-zinc-600 text-zinc-200 hover:bg-zinc-600/80 transition-colors"
          title={_modeBadgeTooltip(chip.modeBadge)}
          aria-label={`Cycle granularity. Currently ${chip.modeBadge}.`}
        >
          {chip.modeBadge}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setSystemPromptFocusKey(chip.key)
          setSystemPromptPreviewOpen(true)
        }}
        aria-label={`Preview system prompt: ${chip.label}`}
        className="flex items-center gap-1 pr-1 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700/60 transition-colors cursor-pointer text-left"
      >
        {chip.sceneId ? (
          <NodeBadge nodeId={chip.sceneId} nodes={nodes} />
        ) : (
          <span className="truncate max-w-[220px]">{chip.label}</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => { setSuppressNextFlash(true); chip.onRemove() }}
        title={`Remove "${chip.label}" from story-scope context`}
        aria-label={`Remove ${chip.label}`}
        className="text-zinc-400 hover:text-white hover:bg-zinc-700 w-4 h-4 mr-0.5 flex items-center justify-center text-[10px] leading-none rounded-full"
      >
        ✕
      </button>
    </span>
  )
}

// Build the anchor-badge descriptor for a pin. Returns
// `{ text, className, tooltip, textStrike }` or null when there's
// nothing to show (scene pins). Dispatch order:
//   1. Range pin (`anchor_range` set) → purple "<start> → <end>".
//   2. No anchor_node_id → dynamic legacy. "@ Current Scene", with
//      strike-through on the label when scene context is off / no
//      active scene (matches what the wire builder will actually do).
//   3. anchor_node_id points at a sceneNode → purple "@ <SceneName>".
//   4. anchor_node_id points at an entity origin EntityNode → green
//      "NEW : <TYPE>" matching the canvas origin-node badge.
//   5. anchor_node_id points at a modifier EntityNode → amber, label
//      includes the modifier's display name when available.
//   6. anchor_node_id points at a knowledge / relationship origin
//      node → green "NEW : KNOWLEDGE" / "NEW : RELATIONSHIP".
//   7. anchor_node_id doesn't resolve to a node at all → fallback
//      "(missing anchor)" in red so the writer notices.
function _resolvePinAnchorBadge(item, pinAnchor, sceneContextEnabled, activeSceneId, pinRange) {
  // Section pills are host-locked, NOT chain-tracked. The badge shows
  // the owning surface (scene / cue / reference / entity Notes /
  // knowledge Notes), resolved live each render so renames track in
  // real-time. Independent of the chat's active scene — a Section
  // attached from scene A still reads "@ scene A" even when the
  // writer navigates to scene B in the editor.
  if (item.kind === 'section') {
    const info = findSectionHostInfo(item.surface_type, item.surface_host_id)
    if (!info) {
      return {
        text: '(missing host)',
        className: 'text-red-200 bg-red-900/40 border-l border-red-700/60',
        tooltip: 'The Section\'s host surface no longer exists.',
      }
    }
    const palette = {
      scene:     'text-purple-200 bg-purple-900/50 border-l border-purple-700/60',
      cue:       'text-teal-200 bg-teal-900/40 border-l border-teal-700/60',
      reference: 'text-orange-200 bg-orange-900/40 border-l border-orange-700/60',
      entity:    'text-emerald-200 bg-emerald-900/40 border-l border-emerald-700/60',
      knowledge: 'text-amber-200 bg-amber-900/40 border-l border-amber-700/60',
    }
    return {
      text: info.hostName,
      className: palette[info.hostKind] || 'text-zinc-200 bg-zinc-700/60 border-l border-zinc-600',
      tooltip: `Section from ${info.hostPhrase}.`,
    }
  }
  if (pinRange) {
    const nodes = useProjectStore.getState().nodes || []
    const startNode = nodes.find((n) => n.id === pinRange.start_node_id)
    const endNode = nodes.find((n) => n.id === pinRange.end_node_id)
    function _labelFor(node) {
      if (!node) return '(missing)'
      if (node.type === 'sceneNode') return node.data?.title || 'Untitled'
      if (node.type === 'entityNode') {
        return node.data?.is_modifier ? 'Modifier' : `NEW : ${_pinOriginTypeForEntity(item)}`
      }
      if (node.type === 'knowledgeOriginNode') return 'NEW : KNOWLEDGE'
      if (node.type === 'relationshipOriginNode') return 'NEW : RELATIONSHIP'
      return 'anchor'
    }
    const startLabel = _labelFor(startNode)
    const endLabel = _labelFor(endNode)
    return {
      text: `${startLabel} → ${endLabel}`,
      className: 'text-purple-200 bg-purple-900/50 border-l border-purple-700/60',
      tooltip: `Anchored across ${startLabel} → ${endLabel} (every chain point in between is included).`,
      // Range pins use a solid right-arrow glyph in place of the
      // default `@` so the badge reads as a span rather than a single
      // point. Glyph convention: solid `→` for contiguous ranges,
      // dashed `⇢` reserved for any future non-contiguous range
      // representation (storage today always expands non-contiguous
      // selections into multiple pills, so the dashed glyph isn't
      // currently used).
      prefixGlyph: '→',
      isRange: true,
    }
  }
  if (!pinAnchor) {
    // Dynamic legacy pin. Resolves at the conversation's active scene
    // when scene context is on; otherwise falls back to the entity's
    // LATEST state on its narrative chain (every chain change applied
    // forward from origin). Render `@ Current Scene` with strike-
    // through + red italic when the effective resolve target is the
    // fallback, so the writer can see at a glance that the dynamic
    // pin isn't pointing at a scene.
    const sceneActive = !!(sceneContextEnabled && activeSceneId)
    return {
      text: 'Current Scene',
      className: 'text-zinc-200 bg-zinc-700/60 border-l border-zinc-600',
      tooltip: sceneActive
        ? 'Dynamic attachment: follows the conversation\'s active scene.'
        : 'Dynamic attachment: scene context is off; will resolve to the entity\'s latest state on its narrative chain.',
      textStrike: !sceneActive,
    }
  }
  const nodes = useProjectStore.getState().nodes || []
  const node = nodes.find((n) => n.id === pinAnchor)
  if (!node) {
    return {
      text: '(missing anchor)',
      className: 'text-red-200 bg-red-900/40 border-l border-red-700/60',
      tooltip: 'The anchor node for this attachment no longer exists.',
    }
  }
  if (node.type === 'sceneNode') {
    const title = node.data?.title || 'Untitled scene'
    return {
      text: title,
      className: 'text-purple-200 bg-purple-900/50 border-l border-purple-700/60',
      tooltip: `Anchored to scene: ${title}`,
    }
  }
  if (node.type === 'entityNode') {
    if (node.data?.is_modifier) {
      // A modifier doesn't have a name of its own — show the kind
      // suffix so the writer recognises it as a modifier stop.
      return {
        text: 'Modifier',
        className: 'text-amber-200 bg-amber-900/40 border-l border-amber-700/60',
        tooltip: 'Anchored at a modifier node on the chain',
      }
    }
    return {
      text: `NEW : ${_pinOriginTypeForEntity(item)}`,
      className: 'text-green-200 bg-green-900/40 border-l border-green-700/60',
      tooltip: 'Anchored at the entity\'s origin (baseline state)',
    }
  }
  if (node.type === 'knowledgeOriginNode') {
    return {
      text: 'NEW : KNOWLEDGE',
      className: 'text-green-200 bg-green-900/40 border-l border-green-700/60',
      tooltip: 'Anchored at the knowledge\'s origin (baseline state)',
    }
  }
  if (node.type === 'relationshipOriginNode') {
    return {
      text: 'NEW : RELATIONSHIP',
      className: 'text-green-200 bg-green-900/40 border-l border-green-700/60',
      tooltip: 'Anchored at the relationship\'s origin (baseline state)',
    }
  }
  return {
    text: 'anchor',
    className: 'text-zinc-200 bg-zinc-700/60 border-l border-zinc-600',
    tooltip: 'Anchored to a canvas node',
  }
}

// Sort pinned items so that same-(kind, id) pins are emitted in
// chain order — earliest chain position first, then in chain order.
// Different (kind, id) groups keep their original click order so a
// writer's intentional sequencing across distinct objects survives.
// Dynamic pins (no anchor_node_id) sort before anchored pins for the
// same object (chain position -1 < any real index).
function _sortPinsByChainPosition(pinnedItems, projectStoreSnapshot) {
  if (!Array.isArray(pinnedItems) || pinnedItems.length <= 1) return pinnedItems
  const ps = projectStoreSnapshot || useProjectStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []
  const knowledges = ps.knowledges || []
  const relationships = ps.relationships || []
  // Cache the chain (as an array of node ids) per (kind, id) so we
  // only walk each chain once per send.
  const chainCache = new Map()
  function chainIdsFor(item) {
    const cacheKey = `${item.kind}:${item.id}`
    if (chainCache.has(cacheKey)) return chainCache.get(cacheKey)
    let ids = []
    try {
      if (item.kind === 'entity') {
        const chain = getEntityNarrativeChain(item.id, nodes, edges)
        ids = (chain || []).map((n) => n.id)
      } else if (item.kind === 'knowledge') {
        const k = knowledges.find((x) => x.id === item.id)
        if (k) ids = getKnowledgeNodeOrder(k, nodes, edges) || []
      } else if (item.kind === 'relationship') {
        const r = relationships.find((x) => x.id === item.id)
        if (r) ids = getRelationshipNodeOrder(r, nodes, edges) || []
      }
    } catch { ids = [] }
    chainCache.set(cacheKey, ids)
    return ids
  }
  function chainPosition(item) {
    if (!item.anchor_node_id) return -1
    const ids = chainIdsFor(item)
    const idx = ids.indexOf(item.anchor_node_id)
    return idx
  }
  // Stable sort against original index for non-same-group pairs.
  const origIdx = new Map(pinnedItems.map((it, i) => [it, i]))
  return [...pinnedItems].sort((a, b) => {
    if (a.kind !== b.kind || a.id !== b.id) {
      return (origIdx.get(a) ?? 0) - (origIdx.get(b) ?? 0)
    }
    return chainPosition(a) - chainPosition(b)
  })
}


// Heading-prefix check for the preview's focus-to-heading jump.
// Matches the renderer's emitted headings precisely so a pin only
// lands on a heading that actually corresponds to its kind:
//   - Scene pin     → "Additional Scene:" (h3 only)
//   - Knowledge pin → "Additional Knowledge:" / "Same knowledge:"
//   - Relationship  → "Additional Relationship:" / "Same relationship:"
//   - Entity pin    → "Additional <Type>:" with <Type> NOT being one
//                     of the reserved kinds, OR "Same <type>:" for
//                     entity subtypes (character/location/item/...)
// Any heading whose prefix doesn't match the focused pin's kind is
// rejected so clicking a Character pill can never land on a Scene
// or Knowledge heading just because they share a substring.
function _focusKindMatches(itemKind, tagName, headingText) {
  const t = headingText || ''
  if (tagName === 'H3') {
    if (!/^Additional /.test(t)) return false
    if (itemKind === 'knowledge')    return /^Additional Knowledge[ :]/i.test(t)
    if (itemKind === 'relationship') return /^Additional Relationship[ :]/i.test(t)
    if (itemKind === 'scene')        return /^Additional Scene[ :]/i.test(t)
    if (itemKind === 'entity') {
      return !/^Additional Knowledge[ :]/i.test(t)
        && !/^Additional Relationship[ :]/i.test(t)
        && !/^Additional Scene[ :]/i.test(t)
    }
    return false
  }
  if (tagName === 'H4') {
    if (!/^Same /.test(t)) return false
    if (itemKind === 'knowledge')    return /^Same knowledge[ :]/i.test(t)
    if (itemKind === 'relationship') return /^Same relationship[ :]/i.test(t)
    if (itemKind === 'entity') {
      // Entity subtypes match by their lowercase form: "Same character",
      // "Same location", "Same item", "Same faction", "Same custom".
      return /^Same (character|location|item|faction|custom)[ :]/i.test(t)
    }
    // Scenes don't group into H4 subsections; no h4 should match.
    return false
  }
  return false
}


// Build the heading-suffix marker for the FOCUSED pin so the
// preview can pick out the specific subsection inside a multi-
// anchor group whose suffix matches. Returns '' for pins without
// an anchor (dynamic) or scene pins (no suffix). Matches the
// renderer's `_anchorSuffix` output minus the surrounding markdown
// italics, since `heading.textContent` returns plain text.
function _focusAnchorMarker(focusItem, focusAnchor) {
  if (!focusItem || !focusAnchor) return ''
  if (focusItem.kind === 'scene') return ''
  const nodes = useProjectStore.getState().nodes || []
  const node = nodes.find((n) => n.id === focusAnchor)
  if (!node) {
    return focusItem.kind === 'entity'
      ? 'in their initial state at the start of the narrative'
      : 'in its initial state at the start of the narrative'
  }
  if (node.type === 'sceneNode') {
    return `at scene "${node.data?.title || 'Untitled'}"`
  }
  if (node.type === 'entityNode') {
    return node.data?.is_modifier
      ? 'at a state-change point between scenes'
      : 'in their initial state at the start of the narrative'
  }
  if (node.type === 'knowledgeOriginNode' || node.type === 'relationshipOriginNode') {
    return 'in its initial state at the start of the narrative'
  }
  return ''
}


// Bucket-aware type label for a pin's `NEW : <TYPE>` badge / tooltip.
// Mirrors the canvas origin-node badge text byte-for-byte:
//   - entity     → CHARACTER / LOCATION / ITEM / FACTION / CUSTOM
//   - knowledge  → KNOWLEDGE
//   - relationship → RELATIONSHIP
// Falls back to a generic ENTITY when an entity isn't found in any
// bucket (rare, stale pin).
function _pinOriginTypeForEntity(item) {
  if (!item) return 'ENTITY'
  if (item.kind === 'knowledge') return 'KNOWLEDGE'
  if (item.kind === 'relationship') return 'RELATIONSHIP'
  if (item.kind !== 'entity') return (item.kind || 'item').toUpperCase()
  const es = useEntitiesStore.getState()
  const buckets = [
    { type: 'CHARACTER', list: es.characters },
    { type: 'LOCATION',  list: es.locations  },
    { type: 'ITEM',      list: es.items      },
    { type: 'FACTION',   list: es.factions   },
    { type: 'CUSTOM',    list: es.customs    },
  ]
  for (const b of buckets) {
    if ((b.list || []).some((e) => e.id === item.id)) return b.type
  }
  return 'ENTITY'
}


// Per-kind colour tokens. Mirrors the canvas's existing palette:
// entity = emerald, knowledge = amber (knowledge accent colour),
// relationship = violet (relationship chip colour), scene = sky.
function _pinnedChipColour(kind) {
  if (kind === 'entity') return {
    border: 'border-emerald-700/60', bg: 'bg-emerald-900/25',
    text: 'text-emerald-100', label: 'text-emerald-300',
    hover: 'hover:bg-emerald-800/40', x: 'text-emerald-300 hover:text-white hover:bg-emerald-700/60',
  }
  if (kind === 'knowledge') return {
    border: 'border-amber-700/60', bg: 'bg-amber-900/25',
    text: 'text-amber-100', label: 'text-amber-300',
    hover: 'hover:bg-amber-800/40', x: 'text-amber-300 hover:text-white hover:bg-amber-700/60',
  }
  if (kind === 'relationship') return {
    border: 'border-violet-700/60', bg: 'bg-violet-900/25',
    text: 'text-violet-100', label: 'text-violet-300',
    hover: 'hover:bg-violet-800/40', x: 'text-violet-300 hover:text-white hover:bg-violet-700/60',
  }
  if (kind === 'scene') return {
    border: 'border-sky-700/60', bg: 'bg-sky-900/25',
    text: 'text-sky-100', label: 'text-sky-300',
    hover: 'hover:bg-sky-800/40', x: 'text-sky-300 hover:text-white hover:bg-sky-700/60',
  }
  if (kind === 'cue') return {
    border: 'border-teal-700/60', bg: 'bg-teal-900/25',
    text: 'text-teal-100', label: 'text-teal-300',
    hover: 'hover:bg-teal-800/40', x: 'text-teal-300 hover:text-white hover:bg-teal-700/60',
  }
  if (kind === 'section') return {
    // Phase 2.9b — Sections pin from the editor side. Cyan to
    // distinguish from the existing chain-tracked kinds (entity /
    // knowledge / relationship / scene) and from cues (teal).
    border: 'border-cyan-700/60', bg: 'bg-cyan-900/25',
    text: 'text-cyan-100', label: 'text-cyan-300',
    hover: 'hover:bg-cyan-800/40', x: 'text-cyan-300 hover:text-white hover:bg-cyan-700/60',
  }
  if (kind === 'toc') return {
    // Phase 2.10 — Story Table of Contents pin. Fuchsia, distinct
    // from all the chain-tracked kinds + cue / section so the chip
    // reads as a structural-overview pill in the strip.
    border: 'border-fuchsia-700/60', bg: 'bg-fuchsia-900/25',
    text: 'text-fuchsia-100', label: 'text-fuchsia-300',
    hover: 'hover:bg-fuchsia-800/40', x: 'text-fuchsia-300 hover:text-white hover:bg-fuchsia-700/60',
  }
  return {
    border: 'border-zinc-700', bg: 'bg-zinc-800/40',
    text: 'text-zinc-200', label: 'text-zinc-400',
    hover: 'hover:bg-zinc-700/60', x: 'text-zinc-400 hover:text-white hover:bg-zinc-700/60',
  }
}


// Resolve the chip's display label from the pinned item. For
// entity / scene / chapter the id is resolved via the project /
// entities store at chip-render time so the label always reflects
// current names (mid-session renames). Free text shows a short
// one-line snippet. Returns `{ kindShort, short, full }` —
// `kindShort` is the 4-6-char kind label in the chip;
// `short` is the truncate-fitting label; `full` is the full
// label for the tooltip.
// Tiny hex -> rgba helper for the focus highlight tint. Tolerates
// short (#abc) and long (#aabbcc) hex; falls back to violet when
// the input is unrecognised.
function _hexToRgba(hex, alpha) {
  const s = (hex || '').replace('#', '').trim()
  if (s.length !== 3 && s.length !== 6) return `rgba(124, 58, 237, ${alpha})`
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return `rgba(124, 58, 237, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}


function _pinnedChipLabel(item, anchorSceneId) {
  // Chain-aware name resolution at the active scene anchor for
  // every chain-tracked object kind. Origin fallback (no anchor)
  // returns the baseline name — which is the chain-aware path at
  // origin per the model. Scenes use their canonical
  // first-class `data.title` (not chain-tracked).
  const ps = useProjectStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []

  if (item.kind === 'entity') {
    // Look up the entity in each bucket so we know its subtype
    // (character / location / item / faction / custom). The chip
    // label uses that subtype instead of the generic "ENTITY" so
    // the writer can scan the strip and tell at a glance which
    // kind of entity each pinned chip is.
    const es = useEntitiesStore.getState()
    const buckets = [
      { type: 'character', list: es.characters },
      { type: 'location',  list: es.locations  },
      { type: 'item',      list: es.items      },
      { type: 'faction',   list: es.factions   },
      { type: 'custom',    list: es.customs    },
    ]
    let e = null
    let subtype = 'entity'
    for (const b of buckets) {
      const found = (b.list || []).find((x) => x.id === item.id)
      if (found) { e = found; subtype = b.type; break }
    }
    const kindShort = subtype.toUpperCase()
    if (!e) return { kindShort, short: '(missing entity)', full: '(missing entity)' }
    let name = e.name || '(unnamed)'
    if (anchorSceneId) {
      try {
        const eff = computeEffectiveState(e, nodes, edges, anchorSceneId)
        if (eff?.name) name = eff.name
      } catch { /* baseline fallback already set */ }
    }
    return { kindShort, short: name, full: name }
  }
  if (item.kind === 'knowledge') {
    const k = (ps.knowledges || []).find((x) => x.id === item.id)
    if (!k) return { kindShort: 'KNOWLEDGE', short: '(missing knowledge)', full: '(missing knowledge)' }
    let name = k.name || '(unnamed)'
    if (anchorSceneId) {
      try {
        const order = getKnowledgeNodeOrder(k, nodes, edges)
        const eff = computeKnowledgeEffectiveState(k, order, anchorSceneId, { nodes })
        if (eff?.name) name = eff.name
      } catch { /* baseline fallback */ }
    }
    return { kindShort: 'KNOWLEDGE', short: name, full: name }
  }
  if (item.kind === 'relationship') {
    const rel = (ps.relationships || []).find((x) => x.id === item.id)
    if (!rel) return { kindShort: 'RELATIONSHIP', short: '(missing relationship)', full: '(missing relationship)' }
    let name = rel.name || ''
    if (anchorSceneId) {
      try {
        const order = getRelationshipNodeOrder(rel, nodes, edges)
        const eff = computeRelationshipEffectiveState(rel, order, anchorSceneId)
        if (eff?.name) name = eff.name
      } catch { /* baseline fallback */ }
    }
    if (!name) {
      // Unnamed relationship: synthesize the participant-based placeholder
      // ("A & B") the rest of the app uses, instead of a raw id. Participants
      // live on history join events, which `resolveRelationshipLabel` reads.
      const es = useEntitiesStore.getState()
      const getEntityById = (id) => {
        for (const list of [es.characters, es.locations, es.items, es.factions, es.customs]) {
          const f = (list || []).find((x) => x.id === id)
          if (f) return f
        }
        return null
      }
      name = resolveRelationshipLabel(rel, getEntityById)
    }
    if (!name) name = `Relationship ${(rel.id || '').slice(0, 6)}…`
    return { kindShort: 'RELATIONSHIP', short: name, full: name }
  }
  if (item.kind === 'scene') {
    const node = nodes.find((n) => n.id === item.id && n.type === 'sceneNode')
    const title = node?.data?.title || '(missing scene)'
    return { kindShort: 'SCENE', short: title, full: title }
  }
  if (item.kind === 'cue') {
    // Cues are program-level and live in their own store. They have
    // no chain so `anchorSceneId` is irrelevant — the name is just
    // the saved cue's `name` field.
    const cue = useContextCuesStore.getState().getCueById(item.id)
    const name = cue?.name || '(missing cue)'
    return { kindShort: 'CUE', short: name, full: name }
  }
  if (item.kind === 'concept') {
    // Concept — a `referenceNode` with sub_type 'concept'. No chain, so
    // `anchorSceneId` is irrelevant; the name is the node's `data.title`.
    const node = nodes.find((n) => n.id === item.id && n.type === 'referenceNode' && n.data?.sub_type === 'concept')
    const title = (node?.data?.title || '').trim() || (node ? 'Untitled concept' : '(missing concept)')
    return { kindShort: 'CONCEPT', short: title, full: title }
  }
  if (item.kind === 'toc') {
    // Story Table of Contents — story-level structural overview. No
    // chain. The chip shows the story title for context (since the
    // TOC pin is tied to a specific story.id). On story-switch the
    // pin is stripped (see strip logic above), so labelling with the
    // current loaded story title is always correct.
    const title = (ps.story?.title || '').trim() || 'Story'
    return { kindShort: 'TOC', short: title, full: `Table of contents for "${title}"` }
  }
  if (item.kind === 'section') {
    // Phase 2.9b — Sections pin from the editor side (Attach to Chat
    // button on the Section's own toolbar). No chain — `anchorSceneId`
    // is irrelevant. Display name = the Section's `name` attr resolved
    // by walking the host surface's TipTap content via
    // `findSectionContent`. Re-resolves on every render so writer
    // renames + content edits propagate to the chip automatically.
    const found = findSectionContent(
      item.surface_type,
      item.surface_host_id,
      item.id,
    )
    if (!found) return { kindShort: 'SECTION', short: '(missing section)', full: '(missing section)' }
    const name = found.name || '(unnamed section)'
    return { kindShort: 'SECTION', short: name, full: name }
  }
  return { kindShort: '?', short: '(unknown)', full: '(unknown)' }
}


// Modal that renders the exact context block the chat panel will
// inject just before the writer's next outgoing message. The
// preview is rebuilt every time the modal opens — same builder the
// send path uses, so what the writer sees here matches what the
// model will see byte-for-byte. Closed via ✕ button, Escape, or
// backdrop click. Pure preview; no editing.
// Per-message "View attached context" modal — Phase 2.5d. Shows
// the exact context that was in force at the point the given user
// message was sent, reconstructed from stored `system_context`
// blocks via `getContextAtMessage`. Independent of the active
// scene / pinned items state — this is a historical view.
function AttachedContextModal({ thread, messageId, onClose }) {
  const [renderMode, setRenderMode] = useState('markdown')
  const accent = useAccentColor() || '#7c3aed'
  const body = useMemo(
    () => getContextAtMessage(thread, messageId),
    [thread, messageId],
  )
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl max-w-[640px] w-[90vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-zinc-300 font-semibold truncate">Attached Context</div>
            <div className="text-[10px] text-zinc-500 truncate">
              The context that was sent with this message.
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setRenderMode((m) => (m === 'markdown' ? 'raw' : 'markdown'))}
              title={renderMode === 'markdown'
                ? 'Currently rendered as Markdown. Click to flip to the raw text that was sent on the wire.'
                : 'Currently showing raw wire text. Click to flip to rendered Markdown.'}
              aria-pressed={renderMode === 'markdown'}
              className="text-[9px] px-1.5 py-px rounded border border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
            >
              {renderMode === 'markdown' ? 'MD' : 'Raw'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close attached-context view"
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {body
            ? (renderMode === 'markdown' ? (
                <div className="text-[11px] text-zinc-200 leading-relaxed">
                  <MarkdownBody content={body} accent={accent} />
                </div>
              ) : (
                <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-words font-mono leading-relaxed">{body}</pre>
              ))
            : (
              <div className="text-[11px] text-zinc-500 italic">
                No context was attached when this message was sent.
              </div>
            )}
        </div>
      </div>
    </div>
  )
}


// Exported for reuse in non-chat contexts (Phase 2.9c item 7 — Prompt
// Block context preview). Optional `pinnedItems` prop lets a host
// outside the chat composer drive the preview against its own list
// instead of `uiStore.chatPinnedContextItems`. When omitted the
// chat composer's call site reads from `uiStore` exactly as before.
export function SceneContextPreviewModal({ sceneId, sceneTitle, focusItem, onClose, pinnedItems: pinnedItemsProp }) {
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  // Render-mode toggle. Default to markdown since the block is
  // authored as markdown and reads better that way; writers
  // debugging exactly-what-gets-sent flip to raw.
  const [renderMode, setRenderMode] = useState('markdown')
  // Pinned items are part of the same block the model receives —
  // the preview rebuilds the exact text from the same builder the
  // send path uses, so it includes the additional-context section too.
  // Always subscribe to the chat store (so the chat composer's call
  // site stays reactive); the prop override wins when supplied.
  // Phase 2.10b bug 1 refactor — chat surface key is per-thread; read
  // the active conversation's bucket from the unified pinnedContextStore.
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  const chatStorePinnedItems = usePinnedContextStore((s) => (activeThreadId ? (s.surfaces[`chat:${activeThreadId}`] || _EMPTY_PINS) : _EMPTY_PINS))
  const pinnedItems = pinnedItemsProp != null ? pinnedItemsProp : chatStorePinnedItems
  // Story accent colour — used to tint the section-highlight when
  // the writer clicks a pinned-context chip to jump in.
  const accent = useAccentColor() || '#7c3aed'
  // Scroll container ref so the focus-to-heading effect can scope
  // its h3 query to the rendered body (not the whole document).
  const bodyRef = useRef(null)
  // Tracks which focusItem we've already scrolled-and-highlighted
  // for. Lets the user flip MD/Raw or scroll around without the
  // jump retriggering on every render; resets when focusItem
  // changes so each click on a different chip jumps again.
  const lastFocusedRef = useRef(null)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    buildSceneContextBlock({ sceneId, pinnedItems }).then((text) => {
      if (cancelled) return
      setBody(text || '(empty: the scene has nothing to surface yet.)')
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setBody('(error building scene context)')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [sceneId, pinnedItems])
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  // Focus-to-heading. Runs once per distinct focusItem after the
  // body has rendered in markdown mode. Reuses the chain-aware
  // name resolution that the pinned chips already do, so the
  // heading text we look up matches the renderer byte-for-byte.
  useEffect(() => {
    if (!focusItem) { lastFocusedRef.current = null; return }
    if (loading || renderMode !== 'markdown' || !bodyRef.current) return
    if (lastFocusedRef.current === focusItem.sessionId) return
    const root = bodyRef.current
    // Resolve the heading name at the FOCUSED pin's own anchor so it
    // matches what the renderer produced.
    const focusAnchor = focusItem.anchor_node_id || sceneId || null
    const label = _pinnedChipLabel(focusItem, focusAnchor)
    const name = (label?.full || '').trim()
    if (!name) return
    // Anchor-suffix marker — matches the renderer's _anchorSuffix
    // output (minus the surrounding "*(" / ")*" markdown markers,
    // since heading.textContent gives us plain text). Used to pick
    // out the correct subsection within a multi-anchor group.
    const anchorMarker = _focusAnchorMarker(focusItem, focusAnchor)
    const raf = requestAnimationFrame(() => {
      // Headings come in two shapes:
      //   ### Additional Character: <name> ... (single-anchor pin)
      //   #### Same character: <name> ...     (subsection inside a
      //                                         multi-anchor group)
      // For a multi-anchor focus, prefer the H4 subsection whose
      // suffix matches the focused pin's anchor; fall back to a
      // name-only match if no anchor-marker is available (dynamic
      // pin, or scene pin which has no suffix).
      const headings = root.querySelectorAll('h3, h4')
      let target = null
      let fallback = null
      for (const h of headings) {
        const t = (h.textContent || '').trim()
        if (!t.includes(name)) continue
        const tagName = h.tagName
        if (!_focusKindMatches(focusItem.kind, tagName, t)) continue
        if (anchorMarker && t.includes(anchorMarker)) { target = h; break }
        if (!fallback) fallback = h
      }
      if (!target) target = fallback
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Collect the heading PLUS every following sibling up to (but
      // not including) the next heading of equal or higher rank.
      // For a H3 wrapper that means stop at the next H1/H2/H3; for
      // an H4 subsection inside a group, stop at the next H1/H2/H3/H4
      // so we only highlight this one subsection, not the entire
      // group's body.
      const targetTag = target.tagName
      const stopAt = targetTag === 'H4' ? new Set(['H1', 'H2', 'H3', 'H4']) : new Set(['H1', 'H2', 'H3'])
      const sectionNodes = [target]
      let next = target.nextElementSibling
      while (next) {
        if (stopAt.has(next.tagName)) break
        sectionNodes.push(next)
        next = next.nextElementSibling
      }
      const tint = _hexToRgba(accent, 0.18)
      for (const el of sectionNodes) {
        el.style.transition = 'background-color 400ms ease'
        el.style.backgroundColor = tint
      }
      setTimeout(() => {
        for (const el of sectionNodes) el.style.backgroundColor = 'transparent'
        setTimeout(() => {
          for (const el of sectionNodes) {
            el.style.transition = ''
            el.style.backgroundColor = ''
          }
        }, 450)
      }, 1500)
      lastFocusedRef.current = focusItem.sessionId
    })
    return () => cancelAnimationFrame(raf)
  }, [focusItem, body, loading, renderMode, sceneId, accent])
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl max-w-[640px] w-[90vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-zinc-300 font-semibold truncate">Context Preview</div>
            {sceneTitle && (
              <div className="text-[10px] text-zinc-500 truncate">{sceneTitle}</div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* MD/Raw toggle — same single-button shape as the per-
                message pill on chat bubbles. Click flips modes; the
                label shows the CURRENT mode. */}
            <button
              type="button"
              onClick={() => setRenderMode((m) => (m === 'markdown' ? 'raw' : 'markdown'))}
              title={renderMode === 'markdown'
                ? 'Currently rendered as Markdown. Click to flip to the raw text that goes on the wire.'
                : 'Currently showing raw wire text. Click to flip to rendered Markdown.'}
              aria-pressed={renderMode === 'markdown'}
              className="text-[9px] px-1.5 py-px rounded border border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
            >
              {renderMode === 'markdown' ? 'MD' : 'Raw'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="px-4 py-3 border-b border-zinc-800 text-[10px] text-zinc-500 leading-relaxed">
          This is the exact text that will be sent as a <code className="px-1 bg-zinc-800 rounded">system</code> message just before your next outgoing user message. Rebuilt fresh each time, so anything you change on the scene between now and Send is included.
        </div>
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="text-[11px] text-zinc-500 italic">Building preview…</div>
          ) : renderMode === 'markdown' ? (
            <div className="text-[11px] text-zinc-200 leading-relaxed">
              <MarkdownBody content={body} accent="#a78bfa" />
            </div>
          ) : (
            <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-words font-mono leading-relaxed">{body}</pre>
          )}
        </div>
      </div>
    </div>
  )
}


// Decode a base64 string as UTF-8 text. Used by the text-kind
// attachment path to recover the file's content for persistence
// on the stored message (so the bubble pill can open it in the
// editor panel later). Goes through atob → percent-decode so
// multi-byte UTF-8 characters round-trip correctly.
function _decodeBase64Utf8(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return ''
  const binary = atob(b64)
  let percent = ''
  for (let i = 0; i < binary.length; i += 1) {
    percent += `%${binary.charCodeAt(i).toString(16).padStart(2, '0')}`
  }
  return decodeURIComponent(percent)
}


// Parse a `data:<mime>;...,<payload>` URL prefix for the MIME type.
// Used by the assistant-image accumulator when the SSE event omits
// `image_mime_type` (rare — the scanner usually fills it). Falls
// back to null for hosted-URL display copies that aren't `data:`.
function _mimeFromDataUrl(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/^data:([^;,]+)(?:;[^,]*)?,/i)
  return m ? m[1] : null
}


// MIME → file extension for the synthetic filename we attach to
// assistant images (the upstream doesn't give us a filename so we
// generate one). Covers the formats models actually emit in
// practice; falls back to `.bin` for anything else so the chip's
// subtitle still reads sensibly.
function _extFromMime(mime) {
  if (typeof mime !== 'string') return ''
  if (mime === 'image/png')  return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif')  return '.gif'
  return ''
}


// Strip the `data:<mime>;base64,` prefix from a data URL and return
// the bare base64 payload. Used to feed `_approxDataSize` so the
// size estimate matches what the bytes actually weigh on disk.
function _base64FromDataUrl(url) {
  if (typeof url !== 'string') return ''
  const commaIdx = url.indexOf(',')
  return commaIdx >= 0 ? url.slice(commaIdx + 1) : ''
}


// Approximate decoded byte count of a base64 string without
// actually decoding it: each 4-character base64 group encodes
// 3 bytes, minus 1 byte per trailing `=`. Good enough for the
// chip subtitle (we just want "approximately how big").
function _approxDataSize(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return 0
  let pad = 0
  if (b64.endsWith('==')) pad = 2
  else if (b64.endsWith('=')) pad = 1
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}


function _favouritePreview(message) {
  const raw = (message.content || '').replace(/\s+/g, ' ').trim()
  if (!raw) return '(empty)'
  // First ~8 words; collapse newlines / runs of whitespace into
  // single spaces so the chip stays a single readable line.
  const words = raw.split(' ')
  const slice = words.slice(0, 8).join(' ')
  return words.length > 8 ? `${slice}…` : slice
}

// ── Input toolbar row ─────────────────────────────────────────
//
// Strip above the textarea hosting per-turn affordances. v1 ships
// the **Chat Settings** gear (popover for connection / model /
// system-prompt switching + AI Settings shortcut) plus a stubbed
// **Add Context Cue** puzzle-piece button (filled in by 2.5e). The
// rest of the spec — Scene context toggle, Attach file, Context
// window stepper — lands with Phase 2.5.
function InputToolbarRow({ threadId, messages, onJumpToMessage, onUnfavourite, onRequestPreview, onRequestReanchor }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [favouritesOpen, setFavouritesOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const settingsTriggerRef = useRef(null)
  const favouritesTriggerRef = useRef(null)
  const pinTriggerRef = useRef(null)
  // Open-from-header signal: the chat header's model / system-prompt
  // indicators dispatch `requestOpenChatSettings` so the writer can
  // jump straight into the popover from the display chips at the
  // top of the panel. Bumps a counter so a repeat click re-opens
  // the popover even if it was just closed.
  const pendingOpen = useUiStore((s) => s.pendingChatSettingsOpen)
  const lastSeenOpenRef = useRef(pendingOpen)
  useEffect(() => {
    if (pendingOpen !== lastSeenOpenRef.current) {
      lastSeenOpenRef.current = pendingOpen
      setSettingsOpen(true)
    }
  }, [pendingOpen])

  const favouriteCount = (messages || []).filter((m) => m && m.pinned).length
  const stickyCount = (messages || []).filter((m) => m && m.pinned && m.context_sticky).length

  // Phase 2.5e — paperclip attachment button. Capabilities come
  // from the active thread's (profile, model) pair so the picker
  // only offers what the model can actually accept. Rejection
  // messages fire into the app-wide `transientAlert` banner so the
  // picker, drag-drop drop zone, and the canvas drop all share the
  // same error surface.
  const activeCapabilities = useActiveModelCapabilities(threadId)
  const addChatAttachment = useUiStore((s) => s.addChatAttachment)
  const showTransientAlert = useUiStore((s) => s.showTransientAlert)

  return (
    <div className="flex items-center gap-1 pt-1.5 pb-0.5 relative">
      <ChatSettingsButton
        ref={settingsTriggerRef}
        open={settingsOpen}
        onToggle={() => setSettingsOpen((v) => !v)}
      />
      <PaperclipButton
        capabilities={activeCapabilities}
        dataHelpRegion="conversation:composer_attach_file"
        onAttach={(file, kind) => {
          if (!threadId) return
          addChatAttachment(threadId, makeAttachmentRecord(file, kind))
        }}
        onReject={(file, reason) => showTransientAlert(`${file.name}: ${reason}`)}
      />
      <FavouritesButton
        ref={favouritesTriggerRef}
        open={favouritesOpen}
        count={favouriteCount}
        stickyCount={stickyCount}
        onToggle={() => setFavouritesOpen((v) => !v)}
      />
      <SceneContextButton />
      <AddContextButton
        ref={pinTriggerRef}
        open={pinOpen}
        onToggle={() => setPinOpen((v) => !v)}
      />
      <AutoAttachToggle />
      <ChatAutoAttachStandaloneButton />
      <div className="ml-auto flex items-center gap-1">
        <ToolUseButton threadId={threadId} dataHelpRegion="conversation:composer_tool_use" />
        <ReasoningButton threadId={threadId} dataHelpRegion="conversation:composer_reasoning" />
      </div>
      {pinOpen && (
        <AddContextPickerPopover
          threadId={threadId}
          triggerRef={pinTriggerRef}
          onClose={() => setPinOpen(false)}
        />
      )}
      {settingsOpen && (
        <ChatSettingsPopover
          threadId={threadId}
          triggerRef={settingsTriggerRef}
          onClose={() => setSettingsOpen(false)}
          onRequestPreview={onRequestPreview}
          onRequestReanchor={onRequestReanchor}
        />
      )}
      {favouritesOpen && (
        <FavouritesPopover
          messages={messages}
          triggerRef={favouritesTriggerRef}
          onJump={(id) => { onJumpToMessage(id); setFavouritesOpen(false) }}
          onUnfavourite={onUnfavourite}
          onClose={() => setFavouritesOpen(false)}
        />
      )}
    </div>
  )
}

function ChatSettingsButton({ open, onToggle, ref }) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-help-region="conversation:composer_settings"
      title="Chat Settings: switch connection, model, or system prompt for this conversation."
      aria-label="Chat Settings"
      className={`flex items-center justify-center w-5 h-5 rounded border transition-colors ${
        open
          ? 'border-accent-700/60 bg-accent-900/30 text-accent-200'
          : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60'
      }`}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  )
}

// ── Chat Settings popover ─────────────────────────────────────
//
// Anchored above the gear button. Lists every configured AI
// provider connection that has at least one selected model, with
// the model children clickable to switch the thread's active
// (connection, model) pair. Selecting "Set as default" via the ★
// icon on a model row writes through to user preferences and is
// reflected by a filled star on the now-default row.
//
// The system prompt picker below shows every saved prompt plus a
// "No system prompt" sentinel; selecting one writes the thread's
// `system_prompt_id` (via `__clear__` for the no-prompt case so
// the backend distinguishes "use no prompt" from "leave alone").
//
// "Open MCP & API Connections" at the bottom jumps the writer to the
// Settings panel's MCP & API Connections tab via the uiStore
// pending-open signal — saves a click vs navigating Settings
// → tab manually.
function ChatSettingsPopover({ threadId, triggerRef, onClose, onRequestPreview, onRequestReanchor }) {
  const containerRef = useRef(null)
  const prefs = useSettingsStore((s) => s.preferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const thread = useConversationsStore((s) => threadId ? (s.byId[threadId] || null) : null)
  const updateThread = useConversationsStore((s) => s.updateThread)
  const systemPrompts = useSystemPromptsStore((s) => s.prompts)
  const systemPromptCategories = useSystemPromptsStore((s) => s.categories)
  const loadSystemPromptCategories = useSystemPromptsStore((s) => s.loadCategories)
  useEffect(() => { loadSystemPromptCategories() }, [loadSystemPromptCategories])
  const requestSettingsOpen = useUiStore((s) => s.requestSettingsOpen)
  const historyN = useUiStore((s) => s.chatHistoryWindowN)
  const setHistoryN = useUiStore((s) => s.setChatHistoryWindowN)
  // Count of sticky favourites in the active thread — surfaced as
  // a `+M sticky` annotation under the Message History row so the
  // writer can see the effective wire length at a glance.
  const stickyCount = useMemo(
    () => (thread?.messages || []).filter((m) => m && m.pinned && m.context_sticky).length,
    [thread?.messages],
  )

  // Flyout state — which section's submenu is currently expanded.
  // Hover-driven with a small grace timer so the cursor can travel
  // from row to flyout without it closing mid-traverse. Mirrors the
  // pattern HamburgerMenu uses for its Import / Export flyouts.
  const [hoverFlyout, setHoverFlyout] = useState(null)
  const closeTimerRef = useRef(null)
  // Remembered open category for the System Prompt picker. Survives
  // hover open/close cycles while the chat-settings popover stays
  // mounted — closing the popover unmounts this state and the next
  // open auto-picks from default / active again. Starts as `null`
  // (NOT `undefined`) so the picker reads this as a controlled slot
  // from the very first render; an `undefined` initial value would
  // make the picker fall back to uncontrolled internal state.
  const [promptPickerOpenKey, setPromptPickerOpenKey] = useState(null)
  // Same shape for the Connection / Model picker — the active
  // profile / default profile's connection auto-expands on first
  // open, and any subsequent writer toggle persists for the
  // lifetime of this popover.
  const [modelPickerOpenKey, setModelPickerOpenKey] = useState(null)
  // Two-character chat (ToDo item 163) renders a second pair of
  // Connection/Model + System Prompt sections — one per character.
  // Each picker keeps its own remembered open-category state so
  // hovering between the two character sections doesn't collapse
  // the other's expanded category.
  const [promptPickerOpenKey1, setPromptPickerOpenKey1] = useState(null)
  const [modelPickerOpenKey1, setModelPickerOpenKey1] = useState(null)
  function openFlyout(name) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setHoverFlyout(name)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    // Long enough that toggling a category collapse inside the
    // System Prompt picker (which shrinks the flyout vertically and
    // can leave the cursor briefly outside the new bounds) doesn't
    // race the close — the writer almost always re-enters within
    // this window if they're still interacting.
    closeTimerRef.current = setTimeout(() => {
      setHoverFlyout(null)
      closeTimerRef.current = null
    }, 500)
  }

  useEffect(() => {
    function onDocDown(e) {
      if (!containerRef.current) return
      // Click inside the popover stays open (selecting a model /
      // prompt should not dismiss the surrounding panel).
      if (containerRef.current.contains(e.target)) return
      // Flyouts (Connection / Model and System Prompt) render via
      // a React Portal to document.body so they can escape the
      // chat panel's overflow-hidden — they're NOT inside the
      // popover's DOM subtree, but they ARE part of the popover
      // semantically. A click inside a flyout (picking a model,
      // typing in the filter search, etc.) must be treated as
      // "inside the popover" so the popover doesn't close mid-
      // interaction. Detected via the `data-chat-settings-flyout`
      // marker the portal element carries.
      if (e.target?.closest && e.target.closest('[data-chat-settings-flyout]')) return
      // Click on the trigger button shouldn't close the popover via
      // the document listener — the button has its own onClick that
      // owns the toggle. Without this guard, the document mousedown
      // fires first (close), then React click fires (re-open), and
      // the popover flashes shut and back open.
      if (triggerRef?.current?.contains(e.target)) return
      onClose()
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    // Capture-phase mousedown so we catch the click before any
    // descendant (notably React Flow on the canvas) can call
    // `stopPropagation` and prevent the document-level bubble-phase
    // listener from running. Without capture, clicking the canvas
    // while the popover is open does nothing — React Flow swallows
    // the bubble — and the popover stays stuck open.
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Build the connection / model tree. Only profiles with at least
  // one model surfaced via `selected_models` or
  // `manually_added_models` get a group — empty connections add
  // nothing useful to the picker.
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

  // Per-surface defaults (Phase 2.10a item 9 + 13). Resolution:
  //   - prompt: story override → chat_panel surface slot → legacy
  //     `default_system_prompt_id` → null.
  //   - model:  chat_panel surface slot → legacy `ai_default_model`
  //     → null. (No story-level model overrides — models are
  //     install-local; a story doesn't dictate what model the
  //     writer must run on this machine.)
  // Story-side prompt overrides are session-validated: a stored
  // override id that doesn't resolve against the local
  // `system_prompts/` is silently skipped this session (NOT cleared
  // from `narrative.json`) — the cross-install portability guarantee.
  const story = useProjectStore((s) => s.story)
  const popoverNodes = useProjectStore((s) => s.nodes)
  const popoverEdges = useProjectStore((s) => s.edges)
  const surfaceDefaultModel = prefs.default_models_per_surface?.chat_panel || null
  const defaultProfileId = surfaceDefaultModel?.profile_id || prefs.ai_default_model?.profile_id || null
  const defaultModel = surfaceDefaultModel?.model || prefs.ai_default_model?.model || null
  const storyOverrideRaw = story?.default_prompt_overrides?.chat_panel || null
  const storyOverride = storyOverrideRaw && systemPrompts.find((p) => p.id === storyOverrideRaw)
    ? storyOverrideRaw
    : null
  const surfaceDefaultPromptId = prefs.default_prompts_per_surface?.chat_panel
  const programDefaultPromptId = (surfaceDefaultPromptId === undefined ? prefs.default_system_prompt_id : surfaceDefaultPromptId) || null
  const defaultSystemPromptId = storyOverride || programDefaultPromptId

  // Chat-kind detection. Single-character chats route Connection /
  // Model / System Prompt writes through `character_chat.*` since
  // those are the fields the wire-builder consumes. Two-character
  // chats expose a per-character pair of rows, each binding to
  // `two_character_chat.characters[idx].*`. Regular chats use the
  // existing thread-level fields.
  const characterChat = thread?.character_chat || null
  const twoCharacterChat = thread?.two_character_chat || null
  const isTwoChar = !!twoCharacterChat
  const isCharChat = !isTwoChar && !!characterChat
  const isPersonaMode = isTwoChar || isCharChat

  // Filter the System Prompt picker list to is_persona prompts only
  // when in character chat or two-character chat mode. Per ToDo item
  // 163: persona-typed prompts are the only valid choice for these
  // modes since the wire-builder treats the picked prompt as the
  // character's voice. Regular chats see the full list unchanged.
  const charactersList = useEntitiesStore((s) => s.characters)
  const promptsForPicker = useMemo(() => {
    if (isPersonaMode) return (systemPrompts || []).filter((p) => p && p.is_persona)
    return systemPrompts
  }, [systemPrompts, isPersonaMode])

  // Active value resolution per chat kind.
  //   - Regular chat: thread.profile_id / thread.model / thread.system_prompt_id.
  //   - Single-character chat: character_chat.model_id_override + character_chat.system_prompt_id.
  //     model_id_override is optional; falls through to thread / default when null.
  //   - Two-character chat: per-character via the helper below.
  const _scActiveProfileId = isCharChat
    ? (characterChat.model_id_override?.profile_id || thread?.profile_id || defaultProfileId || null)
    : (thread?.profile_id || defaultProfileId || null)
  const _scActiveModel = isCharChat
    ? (characterChat.model_id_override?.model || thread?.model || defaultModel || null)
    : (thread?.model || defaultModel || null)
  const _scActiveSystemPromptId = isCharChat
    ? characterChat.system_prompt_id
    : (thread?.system_prompt_id ?? defaultSystemPromptId ?? null)

  // For two-char mode, build per-character settings (active values +
  // handlers) that bind to that character's slot. Returns null when
  // not in two-char mode. The two characters render INDEPENDENT
  // Connection/Model + System Prompt sections — each writes to its
  // own `two_character_chat.characters[idx]` entry.
  function buildCharacterSettings(charIdx) {
    if (!isTwoChar) return null
    const charMeta = twoCharacterChat.characters[charIdx]
    if (!charMeta) return null
    // Resolve the character's name + colour CHAIN-AWARE at their
    // anchor (matches the chat header strip's persona snapshot). The
    // baseline `character.name` would show the origin name and would
    // miss any name change applied between origin and the chat's
    // anchor pin. `buildCharacterPersonaSnapshot` walks the chain to
    // the latest anchor pin and returns the resolved name / colour
    // (content-memoised, so re-renders bail cleanly when the
    // resolved values haven't changed).
    const snapshot = buildCharacterPersonaSnapshot(
      charMeta, charactersList, popoverNodes, popoverEdges,
    )
    const charName = snapshot?.characterName || `Character ${charIdx + 1}`
    const charColour = snapshot?.characterColour || '#7c3aed'
    const activeProfileId = charMeta.model_id_override?.profile_id || defaultProfileId || null
    const activeModel = charMeta.model_id_override?.model || defaultModel || null
    const activeSystemPromptId = charMeta.system_prompt_id
    const activeProfileLabel = tree.find((t) => t.profile.id === activeProfileId)?.profile?.name || null
    const activeModelLabel = activeModel || '(no model)'
    const activePromptLabel = activeSystemPromptId == null
      ? '(no persona prompt)'
      : ((systemPrompts || []).find((p) => p.id === activeSystemPromptId)?.name || '(unknown prompt)')
    function pickModel(profileId, modelId) {
      if (!threadId) return
      const override = (profileId && modelId) ? { profile_id: profileId, model: modelId } : null
      const newCharacters = twoCharacterChat.characters.map((c, i) =>
        i === charIdx ? { ...c, model_id_override: override } : c,
      )
      updateThread(threadId, { two_character_chat: { ...twoCharacterChat, characters: newCharacters } })
    }
    function pickSystemPrompt(promptId) {
      if (!threadId || !promptId) return  // system_prompt_id is required on character meta
      const newCharacters = twoCharacterChat.characters.map((c, i) =>
        i === charIdx ? { ...c, system_prompt_id: promptId } : c,
      )
      updateThread(threadId, { two_character_chat: { ...twoCharacterChat, characters: newCharacters } })
    }
    return {
      charName, charColour,
      activeProfileId, activeModel, activeSystemPromptId,
      activeProfileLabel, activeModelLabel, activePromptLabel,
      pickModel, pickSystemPrompt,
    }
  }

  const activeProfileId = _scActiveProfileId
  const activeModel = _scActiveModel
  const activeSystemPromptId = _scActiveSystemPromptId

  // Display labels surfaced on the menu rows so the writer sees the
  // active setting without having to open each flyout.
  const activeProfileLabel = tree.find((t) => t.profile.id === activeProfileId)?.profile?.name || null
  const activeModelLabel = activeModel || '(no model)'
  const activePromptLabel = activeSystemPromptId == null
    ? (isPersonaMode ? '(no persona prompt)' : 'No system prompt')
    : (systemPrompts.find((p) => p.id === activeSystemPromptId)?.name || '(unknown prompt)')

  function pickModel(profileId, modelId) {
    if (!threadId) return
    if (isCharChat) {
      // Single-character chat: persist model as character_chat.model_id_override.
      // The wire-builder reads this override at send time (per Part D).
      const override = (profileId && modelId) ? { profile_id: profileId, model: modelId } : null
      updateThread(threadId, { character_chat: { ...characterChat, model_id_override: override } })
      return
    }
    updateThread(threadId, { profile_id: profileId, model: modelId })
  }
  function setAsDefault(profileId, modelId, event) {
    event?.stopPropagation()
    // Write the chat_panel per-surface slot AND mirror into the
    // legacy global fields so v0.2.9.x and earlier reads (one-cycle
    // compat) see the same value. When item 11's Settings section
    // ships and the legacy fields retire, drop the mirror writes.
    // Toggle semantics: picker passes `null`+`null` when the
    // writer clicks the already-default row's ★ — clears all slots.
    const slotValue = (profileId && modelId) ? { profile_id: profileId, model: modelId } : null
    const next = { ...(prefs.default_models_per_surface || {}), chat_panel: slotValue }
    updatePreferences({
      default_models_per_surface: next,
      ai_default_profile_id: profileId || null,
      ai_default_model: slotValue,
    })
  }
  function setSystemPromptAsDefault(promptId, event) {
    event?.stopPropagation()
    // Same mirror + toggle pattern for the system prompt slot.
    const next = { ...(prefs.default_prompts_per_surface || {}), chat_panel: promptId || null }
    updatePreferences({
      default_prompts_per_surface: next,
      default_system_prompt_id: promptId || null,
    })
  }
  function pickSystemPrompt(promptId) {
    if (!threadId) return
    if (isCharChat) {
      // Single-character chat: system_prompt_id is required on the
      // character_chat meta (it IS the persona). Skip null clears.
      // No applyPromptOnPick — pills / scene_context apply-on-pick
      // are regular-chat concepts; the persona prompt has its own
      // dossier-based assembly path.
      if (!promptId) return
      updateThread(threadId, { character_chat: { ...characterChat, system_prompt_id: promptId } })
      return
    }
    // `null` ("No system prompt") rides through as the explicit
    // `__clear__` sentinel; passing null directly would be treated
    // as "leave alone" by the backend.
    updateThread(threadId, { system_prompt_id: promptId == null ? '__clear__' : promptId })
    // Phase 2.10b item 11 — apply-on-pick dispatcher. Tier 2: clear
    // prior prompt-attached pills + add the new prompt's
    // `context_markers` as dynamic pills. Tier 1 (chat surface only
    // exposes `scene_context` — Section/Before/After don't apply to
    // chat): write the prompt's explicit Tier 1 opinion to the chat-
    // scene-context toggle when set; preserve current state when the
    // slot is silent. Manual pins never touched; chat composer's
    // existing Story Scope state buckets are independent of this flow.
    const picked = promptId
      ? (systemPrompts || []).find((p) => p.id === promptId) || null
      : null
    const ui = useUiStore.getState()
    const pinStore = usePinnedContextStore.getState()
    const surfaceKey = `chat:${threadId}`
    applyPromptOnPick({
      prompt: picked,
      currentPins: pinStore.getPins(surfaceKey),
      addPin: (item) => pinStore.addPin(surfaceKey, item),
      removePin: (sid) => pinStore.removePin(surfaceKey, sid),
      applySurfaceDefaults: (defs) => {
        if (!defs) return
        if (defs.scene_context !== null && defs.scene_context !== undefined) {
          ui.setChatSceneContextEnabled(!!defs.scene_context)
        }
      },
      sourcePromptId: promptId,
    })
  }
  function openAiSettings() {
    requestSettingsOpen('mcpApi')
    onClose()
  }

  return (
    <div
      ref={containerRef}
      className="absolute left-2 bottom-full mb-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl w-[290px] py-1 text-[11px]"
    >
      {isTwoChar ? (
        // ToDo item 163 — two-character chat: render TWO Connection /
        // Model + System Prompt section pairs, one per character.
        // Each pair writes to its character's slot in
        // `two_character_chat.characters[idx]` so per-character
        // overrides actually take effect when the wire-builder reads
        // them (see Part D in `streamAssistantReply`'s
        // `_twoCharCtx.speaker.model_id_override` resolution).
        [0, 1].map((charIdx) => {
          const cs = buildCharacterSettings(charIdx)
          if (!cs) return null
          const modelKey = `model:${charIdx}`
          const promptKey = `prompt:${charIdx}`
          return (
            <Fragment key={charIdx}>
              <div
                className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide truncate"
                style={{ color: cs.charColour }}
                title={cs.charName}
              >
                {cs.charName}
              </div>
              <SectionRow
                label="Connection / Model"
                value={cs.activeModelLabel}
                secondary={cs.activeProfileLabel}
                isOpen={hoverFlyout === modelKey}
                onEnter={() => openFlyout(modelKey)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={300}
              >
                <ConnectionModelFlyoutBody
                  tree={tree}
                  activeProfileId={cs.activeProfileId}
                  activeModel={cs.activeModel}
                  defaultProfileId={defaultProfileId}
                  defaultModel={defaultModel}
                  onPick={cs.pickModel}
                  onSetDefault={setAsDefault}
                  openKey={charIdx === 0 ? modelPickerOpenKey : modelPickerOpenKey1}
                  onOpenKeyChange={charIdx === 0 ? setModelPickerOpenKey : setModelPickerOpenKey1}
                />
              </SectionRow>
              <SectionRow
                label="System Prompt"
                value={cs.activePromptLabel}
                isOpen={hoverFlyout === promptKey}
                onEnter={() => openFlyout(promptKey)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={260}
              >
                <SystemPromptFlyoutBody
                  prompts={promptsForPicker}
                  categories={systemPromptCategories}
                  activeSystemPromptId={cs.activeSystemPromptId}
                  defaultSystemPromptId={defaultSystemPromptId}
                  onPick={cs.pickSystemPrompt}
                  onSetDefault={setSystemPromptAsDefault}
                  openKey={charIdx === 0 ? promptPickerOpenKey : promptPickerOpenKey1}
                  onOpenKeyChange={charIdx === 0 ? setPromptPickerOpenKey : setPromptPickerOpenKey1}
                />
              </SectionRow>
            </Fragment>
          )
        })
      ) : (
        <>
          <SectionRow
            label="Connection / Model"
            value={activeModelLabel}
            secondary={activeProfileLabel}
            isOpen={hoverFlyout === 'model'}
            onEnter={() => openFlyout('model')}
            onLeave={scheduleCloseFlyout}
            flyoutWidth={300}
          >
            <ConnectionModelFlyoutBody
              tree={tree}
              activeProfileId={activeProfileId}
              activeModel={activeModel}
              defaultProfileId={defaultProfileId}
              defaultModel={defaultModel}
              onPick={pickModel}
              onSetDefault={setAsDefault}
              openKey={modelPickerOpenKey}
              onOpenKeyChange={setModelPickerOpenKey}
            />
          </SectionRow>

          <SectionRow
            label="System Prompt"
            value={activePromptLabel}
            isOpen={hoverFlyout === 'prompt'}
            onEnter={() => openFlyout('prompt')}
            onLeave={scheduleCloseFlyout}
            flyoutWidth={260}
          >
            <SystemPromptFlyoutBody
              prompts={promptsForPicker}
              categories={systemPromptCategories}
              activeSystemPromptId={activeSystemPromptId}
              defaultSystemPromptId={defaultSystemPromptId}
              onPick={pickSystemPrompt}
              onSetDefault={setSystemPromptAsDefault}
              openKey={promptPickerOpenKey}
              onOpenKeyChange={setPromptPickerOpenKey}
            />
          </SectionRow>
        </>
      )}

      <MessageHistorySection historyN={historyN} setHistoryN={setHistoryN} stickyCount={stickyCount} />

      {/* Phase 2.12g — Re-anchor. Single-character chats get a single
          "⚓ Re-anchor" button; two-character chats get one button
          per character, labelled with the character's chain-resolved
          name. Each opens the Character Chat Setup modal seeded with
          that character's existing meta; Confirm writes back to the
          matching slot (`character_chat` for single-character, or
          `two_character_chat.characters[idx]` for two-character).
          Regular chats render nothing here. */}
      {(isCharChat || isTwoChar) && (
        <div className="border-t border-zinc-800 mt-1 pt-1">
          {isCharChat && (
            <button
              type="button"
              onClick={() => {
                onClose()
                onRequestReanchor?.({ kind: 'single' })
              }}
              title="Re-anchor this character chat. Reopens the Character Chat setup with this thread's current configuration prepopulated; on Confirm, the change is saved back to this thread and the next message uses the new anchor / persona prompt / model / temp fields."
              className="w-full text-left px-2.5 py-1 text-zinc-200 hover:bg-zinc-800/60 transition-colors flex items-center gap-2"
            >
              <span className="text-[11px]">⚓ Re-anchor</span>
              <span className="ml-auto text-[10px] text-zinc-500">change anchor / persona / model</span>
            </button>
          )}
          {isTwoChar && [0, 1].map((charIdx) => {
            const cs = buildCharacterSettings(charIdx)
            if (!cs) return null
            return (
              <button
                key={charIdx}
                type="button"
                onClick={() => {
                  onClose()
                  onRequestReanchor?.({ kind: 'twoChar', charIdx })
                }}
                title={`Re-anchor ${cs.charName}. Reopens the setup for this character only; on Confirm, the other character's slot is preserved.`}
                className="w-full text-left px-2.5 py-1 text-zinc-200 hover:bg-zinc-800/60 transition-colors flex items-center gap-2"
              >
                <span className="text-[11px]">⚓ Re-anchor</span>
                <span
                  className="text-[11px] font-semibold truncate"
                  style={{ color: cs.charColour }}
                  title={cs.charName}
                >
                  {cs.charName}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* ToDo item 163 — Preview Message. Signals up to the
          ConversationView, which owns the modal state and dispatches
          a preview-mode `sendText` to assemble the wire payload via
          the same code path the Send button uses. */}
      <div className="border-t border-zinc-800 mt-1 pt-1">
        <button
          type="button"
          onClick={() => {
            onClose()
            onRequestPreview?.()
          }}
          className="w-full text-left px-2.5 py-1 text-zinc-200 hover:bg-zinc-800/60 transition-colors flex items-center gap-2"
        >
          <span className="text-[11px]">Preview Message</span>
          <span className="ml-auto text-[10px] text-zinc-500">what's about to be sent</span>
        </button>
      </div>

      <div className="border-t border-zinc-800 mt-1 pt-1 px-2.5 py-1">
        <button
          type="button"
          onClick={openAiSettings}
          className="text-accent-300 hover:text-accent-200 underline text-[10px]"
        >
          Open MCP &amp; API Connections →
        </button>
      </div>
    </div>
  )
}


// Generic flyout-style menu row used inside ChatSettingsPopover.
// Shows the section label as a small uppercase eyebrow, the active
// value as the primary line, an optional secondary line (e.g. the
// active connection name under the model), and a ▸ chevron. Hovering
// (or hovering the flyout panel) keeps the flyout open via the
// parent's grace-timer logic.
//
// When the flyout would clip the right edge of the viewport, it
// flips to open on the left instead. Maximum height adapts to the
// available vertical space below the row so long contents (e.g. a
// big Connection / Model list) scroll inside the flyout rather than
// disappearing below the fold.
function SectionRow({ label, value, secondary, isOpen, onEnter, onLeave, flyoutWidth = 280, children }) {
  const rowRef = useRef(null)
  // Position is computed in viewport coordinates and the flyout is
  // rendered via a portal to `document.body`. This is needed because
  // the chat panel has `overflow-hidden` to keep its bubbles from
  // bleeding into the canvas; an absolutely-positioned flyout inside
  // that panel would be clipped at the panel edge whenever it opened
  // to the left of the row. Portal-rendered + position:fixed both
  // escapes the overflow context and stays anchored on scroll.
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0, maxH: 400 })
  function handleEnter() {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect()
      const wouldClipRight = rect.right + flyoutWidth + 16 > window.innerWidth
      const left = wouldClipRight
        ? Math.max(8, rect.left - flyoutWidth - 4)
        : rect.right + 4
      const avail = window.innerHeight - rect.top - 16
      setFlyoutPos({
        top: rect.top,
        left,
        maxH: Math.max(160, Math.min(400, avail)),
      })
    }
    onEnter && onEnter()
  }
  return (
    <div ref={rowRef} className="relative" onMouseEnter={handleEnter} onMouseLeave={onLeave}>
      <div
        className={`flex items-center gap-2 px-2.5 py-1.5 transition-colors cursor-default ${
          isOpen ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
          <div className="text-[11px] text-zinc-200 truncate">{value}</div>
          {secondary && (
            <div className="text-[10px] text-zinc-500 truncate">{secondary}</div>
          )}
        </div>
        <span className="text-zinc-500 text-[10px] flex-shrink-0">▸</span>
      </div>
      {isOpen && createPortal(
        // Portal renders to document.body, so we lose the parent
        // popover's `text-[11px]` class inheritance — apply it
        // explicitly here so flyout content reads at the same size
        // as the main menu rows.
        //
        // `data-chat-settings-flyout` flags this element to the
        // owning ChatSettingsPopover's click-outside handler so
        // clicks inside the portal (e.g. picking a model) are not
        // treated as "outside the popover" and don't close it
        // before the click registers.
        <div
          data-chat-settings-flyout="true"
          className="fixed z-40 bg-zinc-900 border border-zinc-700 rounded shadow-xl overflow-y-auto py-1 text-[11px]"
          style={{
            top: flyoutPos.top,
            left: flyoutPos.left,
            width: flyoutWidth,
            maxHeight: flyoutPos.maxH,
          }}
          onMouseEnter={handleEnter}
          onMouseLeave={onLeave}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}


// Body of the Connection / Model flyout. Collapsible-per-profile
// per Phase 2.10a item 6 — delegates to the shared
// `<ConnectionModelPickerList>`. One profile expanded at a time;
// the parent (`ChatSettingsPopover`) holds the open-key slot so the
// last expanded profile persists across flyout open/close while the
// popover stays mounted.
function ConnectionModelFlyoutBody({ tree, activeProfileId, activeModel, defaultProfileId, defaultModel, onPick, onSetDefault, openKey, onOpenKeyChange }) {
  return (
    <ConnectionModelPickerList
      tree={tree}
      activeProfileId={activeProfileId}
      activeModel={activeModel}
      defaultProfileId={defaultProfileId}
      defaultModel={defaultModel}
      onPick={onPick}
      onSetDefault={onSetDefault}
      controlledOpenKey={openKey}
      onOpenKeyChange={onOpenKeyChange}
    />
  )
}


// Body of the System Prompt flyout. Category-grouped + collapsible
// per Phase 2.10a item 6 — delegates to the shared
// `<SystemPromptPickerList>`. The chat surface's default prompt is
// the global `default_system_prompt_id` from UserPreferences (the
// per-surface `default_prompts_per_surface.chat_panel` arrives in
// Phase 2.10a items 9 + 11 and will swap in here).
function SystemPromptFlyoutBody({ prompts, categories, activeSystemPromptId, defaultSystemPromptId, onPick, onSetDefault, openKey, onOpenKeyChange }) {
  return (
    <SystemPromptPickerList
      prompts={prompts}
      categories={categories}
      activePromptId={activeSystemPromptId}
      defaultPromptId={defaultSystemPromptId}
      onPick={onPick}
      onSetDefault={onSetDefault}
      controlledOpenKey={openKey}
      onOpenKeyChange={onOpenKeyChange}
    />
  )
}


// Message-history section. Inline (NOT a flyout, unlike the
// Connection/Model and System Prompt sections above) because it's
// a single setting that fits compactly. Preset chips for the common
// multiples-of-14 values plus a custom number input for anything
// else. Sets `chatHistoryWindowN` on the uiStore; the wire builder
// in the chat-context-history work will start consuming it.
function MessageHistorySection({ historyN, setHistoryN, stickyCount = 0 }) {
  // Default is 16 (8 user+assistant pairs); other presets give the
  // writer common steps up to a generous-but-not-huge 64.
  const PRESETS = [8, 16, 24, 32, 64]
  const DEFAULT_N = 16
  const isPreset = PRESETS.includes(historyN)
  // Initialise from the current store value. After mount, the input
  // is its own source of truth — chip clicks call setCustomInput('')
  // directly via their onClick handler, and typing / arrowing in
  // the input writes through to the store via handleCustomChange.
  // A sync useEffect from `historyN` would CLOBBER the input the
  // moment the writer arrows or types a value that happens to
  // match a preset (e.g. arrowing up from 7 to 8) — the effect
  // would fire, see `8` is a preset, and clear the input back to
  // empty mid-keystroke. Skipping the effect entirely keeps that
  // path stable.
  const [customInput, setCustomInput] = useState(isPreset ? '' : String(historyN))

  function commitCustom() {
    const trimmed = customInput.trim()
    if (!trimmed) return
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    setHistoryN(Math.floor(n))
  }
  // Live-commit on every change so the up/down spinner arrows and
  // each keystroke flow into the store immediately. The chip
  // highlight + active-input styling stay in sync with what the
  // writer sees in the input field. Empty / invalid values are
  // skipped so a transient backspace-to-zero doesn't clobber the
  // stored value.
  function handleCustomChange(e) {
    const value = e.target.value
    setCustomInput(value)
    const trimmed = value.trim()
    if (!trimmed) return
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    setHistoryN(Math.floor(n))
  }

  return (
    <div className="px-2.5 py-1.5 border-t border-zinc-800">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">
          Message History
        </div>
        {stickyCount > 0 && (
          <div
            className="text-[9px] text-emerald-400"
            title={`${stickyCount} pinned favourite${stickyCount === 1 ? '' : 's'} ride along with every request, in addition to the history limit.`}
          >
            +{stickyCount} pinned
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {PRESETS.map((n) => {
          const isActive = historyN === n
          const isDefault = n === DEFAULT_N
          return (
            <button
              key={n}
              type="button"
              onClick={() => { setHistoryN(n); setCustomInput('') }}
              title={isDefault ? `${n} (default)` : `${n}`}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                isActive
                  ? 'border-accent-600 bg-accent-700/80 text-white'
                  : `border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-600 ${isDefault ? 'underline decoration-dotted underline-offset-2' : ''}`
              }`}
            >
              {n}
            </button>
          )
        })}
        <span className="text-[10px] text-zinc-400 ml-1">Custom:</span>
        <input
          type="number"
          min="0"
          value={customInput}
          onChange={handleCustomChange}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitCustom()
              e.currentTarget.blur()
            }
          }}
          className={`w-12 text-[11px] px-1.5 py-0.5 rounded border focus:outline-none transition-colors ${
            !isPreset
              ? 'border-accent-600 bg-accent-700/80 text-white'
              : 'border-zinc-700 bg-zinc-800 text-zinc-100 focus:border-zinc-500'
          }`}
        />
      </div>
      <div className="text-[9px] text-amber-400/80 italic mt-1.5 leading-tight">
        Higher values include more conversation history but use noticeably more tokens with every message.
      </div>
    </div>
  )
}
