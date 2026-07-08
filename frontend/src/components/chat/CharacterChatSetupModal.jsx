/**
 * Phase 2.11b item 9 — Character Chat Setup modal.
 *
 * Configuration surface launched by both Character Chat entry points:
 *   - Entity detail panel "🎭 Talk to this character" button (item 13)
 *     pre-populates `initialCharacterId`.
 *   - Chat panel "+ Talk to a character" entry (item 14) opens with
 *     no character pre-selected.
 *
 * Captures everything needed to create a character-chat thread: the
 * character, the chain anchor (via the embedded `ChainRangeSelector`),
 * the Persona system prompt, the connection / model pair, the thread
 * title override, and the conversation-scoped temp fields (Temporary
 * Circumstance / Motivator + Custom Instructions). On Confirm, emits
 * the assembled `CharacterChatMeta` to the parent via `onConfirm`;
 * the parent owns thread creation + opening in the chat panel.
 *
 * First-pass build — structure + functionality first, polish later.
 *
 *   ─── Props ─────────────────────────────────────────────────────
 *
 *   - open                 boolean — render gate.
 *   - initialCharacterId   string|null — pre-populate the character
 *                          picker when launched from the detail panel.
 *   - onConfirm(meta)      called with a `CharacterChatMeta`-shaped
 *                          object (matches `backend/models/conversation.py`'s
 *                          `CharacterChatMeta`). Parent creates the
 *                          thread + opens it.
 *   - onClose()            close without committing.
 */
import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useSystemPromptsStore } from '../../store/systemPromptsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useUiStore } from '../../store/uiStore'
import ChainRangeSelector from './ChainRangeSelector'
import SystemPromptPickerList from '../ui/SystemPromptPickerList'
import ConnectionModelPickerList from '../ui/ConnectionModelPickerList'
import EntityPickerPopover from '../entities/EntityPickerPopover'
import PopoverSectionRow from '../ui/PopoverSectionRow'
import CircumstanceMotivatorForm from '../entities/CircumstanceMotivatorForm'
import { computeEffectiveState } from '../../utils/narrativeChain'
import { findPersonalityAttribute, PERSONALITY_ATTR_SYNONYMS } from '../../utils/personalityAttributeMatcher'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import { IntensityBadge } from '../ui/IntensityBadge'
import { useAccentColor } from '../../utils/povConstants'


export default function CharacterChatSetupModal({
  open,
  initialCharacterId = null,
  // Phase 2.11b item 11 — when present, pre-populates EVERY draft
  // field from a saved `CharacterChatMeta` block (re-anchor flow
  // from the conversation header). When null, the modal opens with
  // surface defaults (new-chat flow from the chat-panel button).
  // `initialCharacterId` is still honoured when `initialMeta` is null
  // (the entity-detail-panel entry point uses it).
  initialMeta = null,
  // Confirm-button label control, decoupled from `initialMeta`:
  // true = apply to the CURRENT thread ("Apply to Chat", the re-anchor
  // flow from the chat header); false (default) = create a new thread
  // ("Start Chat"). The entity-detail entry pre-seeds character/anchor
  // via `initialMeta` yet is a new chat, so it relies on this default.
  applyToExisting = false,
  onConfirm,
  onClose,
  // Phase 2.12 — two-character chat entry. When `allowAdd2nd` is
  // true AND `onConfirmAddSecond` is provided, the modal footer
  // grows an `Add 2nd Character: AI to AI Chat` button beside
  // `Start Chat`. Click validates the same way Start Chat does
  // (canConfirm) and emits the same meta shape, but routes to
  // `onConfirmAddSecond` instead of `onConfirm` so the parent can
  // open a second modal instance for Character 2 without closing
  // this one. The second instance receives `allowAdd2nd=false` to
  // cap the flow at two characters (no nested "Add 3rd").
  //
  // Re-anchor flow (ChatPanel header) passes `allowAdd2nd=false`
  // because re-anchor edits an existing thread's single character;
  // adding a second character to an existing single-character chat
  // isn't supported in v1 (out-of-scope by design — converting chat
  // kinds mid-conversation is a different feature).
  allowAdd2nd = true,
  onConfirmAddSecond = null,
}) {
  const accent = useAccentColor() || '#7c3aed'

  // ── Picker source data ─────────────────────────────────────────
  const characters     = useEntitiesStore((s) => s.characters)
  const systemPrompts  = useSystemPromptsStore((s) => s.prompts)
  const categories     = useSystemPromptsStore((s) => s.categories)
  const loadPrompts    = useSystemPromptsStore((s) => s.loadPrompts)
  const loadCategories = useSystemPromptsStore((s) => s.loadCategories)
  const prefs          = useSettingsStore((s) => s.preferences)

  // Load prompts + categories once when the modal opens — same lazy
  // pattern as Settings → System Prompts tab.
  useEffect(() => {
    if (!open) return
    loadPrompts()
    loadCategories()
  }, [open, loadPrompts, loadCategories])

  // Persona-only prompt list. Filter is_persona === true.
  const personaPrompts = useMemo(
    () => (systemPrompts || []).filter((p) => p && p.is_persona === true),
    [systemPrompts],
  )

  // Build the connection / model tree the picker consumes.
  const modelTree = useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    return profiles
      .map((profile) => {
        const selected = profile.selected_models || []
        const manual = profile.manually_added_models || []
        const models = Array.from(new Set([...selected, ...manual]))
        return { profile, models }
      })
      .filter(({ models }) => models.length > 0)
  }, [prefs?.ai_provider_profiles])

  // Per-surface defaults (Phase 2.11b item 4) — character_chat slot.
  const surfaceDefaultPromptId = prefs?.default_prompts_per_surface?.character_chat || null
  const surfaceDefaultModel    = prefs?.default_models_per_surface?.character_chat || null

  // ── Local draft state ──────────────────────────────────────────
  const [selectedCharacterId, setSelectedCharacterId] = useState(initialCharacterId)
  // One picker open at a time — flyout from PopoverSectionRow.
  // 'character' | 'prompt' | 'model' | null
  const [openPicker, setOpenPicker] = useState(null)
  const [selectedPromptId, setSelectedPromptId] = useState(null)
  const [selectedModel, setSelectedModel] = useState(null)  // {profile_id, model} | null
  // Temp Circumstance / Motivator share the in-program C/M form shape
  // ({name, description, intensity}) so we can reuse
  // `CircumstanceMotivatorForm` — same affordance as the entity / scene
  // C/M editors, just conversation-scoped. `null` means "no temp set",
  // an object means a draft is being edited or has been confirmed.
  // Phase 2.12g+ — plural lists. Each list holds zero-or-more
  // `{name, description, intensity}` entries. The Add form / Edit
  // form is a single overlay state — at most one entry is in
  // edit mode at any time; editingIdx === -1 = adding a new
  // entry, otherwise it's the index of the entry being edited.
  const [tempCircumstances, setTempCircumstances] = useState([])
  const [tempMotivators, setTempMotivators] = useState([])
  const [tempCircumstanceDraft, setTempCircumstanceDraft] = useState({ name: '', description: '', intensity: null })
  const [tempMotivatorDraft, setTempMotivatorDraft] = useState({ name: '', description: '', intensity: null })
  // `null` = no form open; `-1` = adding new; `>=0` = editing entry idx.
  const [tempCircumstanceFormIdx, setTempCircumstanceFormIdx] = useState(null)
  const [tempMotivatorFormIdx, setTempMotivatorFormIdx] = useState(null)
  const [tempCircumstanceError, setTempCircumstanceError] = useState(null)
  const [tempMotivatorError, setTempMotivatorError] = useState(null)
  const [customInstructions, setCustomInstructions] = useState('')

  // Reset draft when the modal opens. Two open shapes:
  //   1. `initialMeta` present — re-anchor flow. Seed every field
  //      from the saved CharacterChatMeta block so the writer sees
  //      their current configuration and only adjusts what they want
  //      to change.
  //   2. `initialMeta` null — new-chat flow. Use surface defaults
  //      for prompt + model, honour `initialCharacterId` for the
  //      character pre-pick (detail-panel entry point), leave temp
  //      fields + custom instructions empty.
  // The ChainRangeSelector's selection IS NOT seeded here — the
  // selector reads its initial state from `selectorItem` (memoised
  // below) which carries the meta's `anchor_pins` shape that the
  // selector knows how to expand into a selection.
  useEffect(() => {
    if (!open) return
    if (initialMeta) {
      setSelectedCharacterId(initialMeta.character_id || null)
      setSelectedPromptId(initialMeta.system_prompt_id || surfaceDefaultPromptId || null)
      setSelectedModel(initialMeta.model_id_override ? { ...initialMeta.model_id_override } : null)
      // Phase 2.12g+ — plural lists. Tolerate legacy singular shapes
      // (singular `temp_circumstance` / `temp_motivator`) for any
      // local-state seed path that hasn't migrated; the backend
      // Pydantic model handles the on-disk migration.
      const _circList = Array.isArray(initialMeta.temp_circumstances)
        ? initialMeta.temp_circumstances
        : (initialMeta.temp_circumstance ? [initialMeta.temp_circumstance] : [])
      const _motList = Array.isArray(initialMeta.temp_motivators)
        ? initialMeta.temp_motivators
        : (initialMeta.temp_motivator ? [initialMeta.temp_motivator] : [])
      setTempCircumstances(_circList)
      setTempMotivators(_motList)
      setTempCircumstanceDraft({ name: '', description: '', intensity: null })
      setTempMotivatorDraft({ name: '', description: '', intensity: null })
      setTempCircumstanceFormIdx(null)
      setTempMotivatorFormIdx(null)
      setTempCircumstanceError(null)
      setTempMotivatorError(null)
      setCustomInstructions(initialMeta.custom_instructions || '')
    } else {
      setSelectedCharacterId(initialCharacterId)
      setSelectedPromptId(surfaceDefaultPromptId || null)
      setSelectedModel(surfaceDefaultModel ? { ...surfaceDefaultModel } : null)
      setTempCircumstances([])
      setTempMotivators([])
      setTempCircumstanceDraft({ name: '', description: '', intensity: null })
      setTempMotivatorDraft({ name: '', description: '', intensity: null })
      setTempCircumstanceFormIdx(null)
      setTempMotivatorFormIdx(null)
      setTempCircumstanceError(null)
      setTempMotivatorError(null)
      setCustomInstructions('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCharacterId, initialMeta])

  // ── Esc to close ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // ── Selected character + chain-resolved description ────────────
  const selectedCharacter = useMemo(
    () => (characters || []).find((c) => c.id === selectedCharacterId) || null,
    [characters, selectedCharacterId],
  )

  // Anchor selector ref — we read `getCurrentPins()` on Confirm to
  // get the pins array (matches the selectionToPins format
  // ChainRangeSelector emits). Owned at modal scope so `handleConfirm`
  // can read it; passed down to `CharacterPreviewBlock` which actually
  // mounts the selector.
  const selectorRef = useRef(null)
  // Stable `item` reference for ChainRangeSelector. The selector
  // resets its internal selection whenever the `item` prop changes
  // BY REFERENCE — passing a fresh object literal each render would
  // wipe the writer's range every time the parent re-renders.
  // Memoising keeps the reference stable until the chosen character
  // actually changes.
  // Carry the initial-meta's `anchor_spec` into the selector via an
  // `anchor_pins` field on the item shape. `ChainRangeSelector` reads
  // it (when present) to seed its multi-pin selection on first mount;
  // otherwise it falls back to its existing single-pin auto-init
  // (`item.anchor_node_id` / `item.anchor_range`). The pins ride only
  // on the FIRST open of the modal for a given character — once the
  // writer interacts with the timeline, the selector owns the
  // selection state and the seed is ignored.
  const selectorItem = useMemo(() => {
    if (!selectedCharacterId) return null
    const seed = initialMeta && initialMeta.character_id === selectedCharacterId
      ? { anchor_pins: Array.isArray(initialMeta.anchor_spec) ? initialMeta.anchor_spec : [] }
      : {}
    return { kind: 'entity', id: selectedCharacterId, ...seed }
  }, [selectedCharacterId, initialMeta])

  // Stable picker handlers so `CharacterPreviewBlock`'s memo can bail
  // out when the modal re-renders for unrelated reasons.
  const handleOpenCharacterPicker = useCallback(() => setOpenPicker('character'), [])
  const handleCloseAnyPicker = useCallback(() => setOpenPicker(null), [])
  const handlePickCharacter = useCallback((id) => {
    setSelectedCharacterId(id)
    setOpenPicker(null)
  }, [])
  const characterPickerOpen = openPicker === 'character'

  // ── Confirm ────────────────────────────────────────────────────
  const canConfirm = !!selectedCharacterId && !!selectedPromptId
  function _buildMeta() {
    const pins = selectorRef.current ? selectorRef.current.getCurrentPins() : []
    return {
      character_id: selectedCharacterId,
      anchor_spec: pins,
      system_prompt_id: selectedPromptId,
      model_id_override: selectedModel ? { profile_id: selectedModel.profile_id, model: selectedModel.model } : null,
      temp_circumstances: tempCircumstances,
      temp_motivators:    tempMotivators,
      custom_instructions: customInstructions.trim() || null,
      anchor_dossier_hash: null,  // computed by send path on first turn
    }
  }
  function handleConfirm() {
    if (!canConfirm) return
    // Title is auto-generated by the parent at thread-create time;
    // the writer can rename the thread from the chat side panel after
    // opening it. No title-override field captured here.
    onConfirm?.(_buildMeta(), {})
  }
  // Phase 2.12 — "Add 2nd Character: AI to AI Chat" footer button.
  // Builds the same `CharacterChatMeta` shape `handleConfirm` would
  // emit and hands it to the parent. The parent is responsible for
  // opening the second modal instance (with `allowAdd2nd=false` to
  // cap the flow at two) and assembling the final
  // `TwoCharacterChatMeta` from both modals' snapshots on the second
  // modal's own Confirm. This modal stays mounted in the background
  // while the second modal is open so closing the second via X / Esc
  // returns to it (the writer can still hit Start Chat here for a
  // single-character chat at that point).
  function handleAddSecond() {
    if (!canConfirm) return
    onConfirmAddSecond?.(_buildMeta())
  }
  const showAddSecondButton = allowAdd2nd && typeof onConfirmAddSecond === 'function'

  if (!open) return null

  // ── Render ─────────────────────────────────────────────────────
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl w-[92vw] max-w-[860px] h-[86vh] max-h-[920px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-help-region="character-chat-setup:modal"
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-zinc-700 flex items-center gap-2 flex-shrink-0">
          <span className="text-sm text-zinc-100 font-semibold">🎭 Set up Character Chat</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close setup"
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
          {/* Character header + anchor selector + chain-resolved description
              and personality previews — all the surfaces that depend on the
              writer's live drag-selection live in this child block. It owns
              the `previewPins` state internally so the rest of the modal
              (prompt picker, model picker, temp C/M, custom instructions)
              doesn't re-render on every drag mousemove. See
              CharacterPreviewBlock below. */}
          <CharacterPreviewBlock
            selectedCharacter={selectedCharacter}
            selectorRef={selectorRef}
            selectorItem={selectorItem}
            characters={characters || []}
            pickerOpen={characterPickerOpen}
            onOpenPicker={handleOpenCharacterPicker}
            onClosePicker={handleCloseAnyPicker}
            onPickCharacter={handlePickCharacter}
            onAddPersonality={() => {
              onClose()
              useUiStore.getState().openEntityAttributeAddAtOrigin(selectedCharacter?.id, { name: 'Personality', type: 'text' })
            }}
          />

          {/* Persona prompt + Model — side by side. Each PopoverSectionRow
              still opens its own flyout to the side, but the row chrome
              sits in a two-column grid. */}
          <div className="grid grid-cols-2 gap-3">
            <div data-help-region="character-chat-setup:persona_prompt">
            <PopoverSectionRow
              label="Persona system prompt"
              value={(() => {
                const p = (personaPrompts || []).find((x) => x.id === selectedPromptId)
                return p?.name || '(pick a Persona prompt)'
              })()}
              isOpen={openPicker === 'prompt'}
              onEnter={() => setOpenPicker('prompt')}
              onLeave={() => setOpenPicker(null)}
              trigger="click"
              flyoutWidth={320}
              flyoutDataAttr="character-chat-setup-flyout"
              flyoutZClass="z-[70]"
            >
              <SystemPromptPickerList
                prompts={personaPrompts}
                categories={categories || []}
                activePromptId={selectedPromptId}
                defaultPromptId={surfaceDefaultPromptId}
                onPick={(id) => { setSelectedPromptId(id); setOpenPicker(null) }}
                showNoPromptOption={false}
                emptyMessage="No Persona-flagged prompts available. Flag one in Settings → System Prompts."
              />
            </PopoverSectionRow>
            </div>

            <div data-help-region="character-chat-setup:model">
            <PopoverSectionRow
              label="Model"
              value={selectedModel?.model || '(pick a model)'}
              secondary={selectedModel
                ? (modelTree.find((t) => t.profile.id === selectedModel.profile_id)?.profile?.name || null)
                : null}
              isOpen={openPicker === 'model'}
              onEnter={() => setOpenPicker('model')}
              onLeave={() => setOpenPicker(null)}
              trigger="click"
              flyoutWidth={320}
              flyoutDataAttr="character-chat-setup-flyout"
              flyoutZClass="z-[70]"
            >
              <ConnectionModelPickerList
                tree={modelTree}
                activeProfileId={selectedModel?.profile_id || null}
                activeModel={selectedModel?.model || null}
                defaultProfileId={surfaceDefaultModel?.profile_id || null}
                defaultModel={surfaceDefaultModel?.model || null}
                onPick={(pId, m) => {
                  setSelectedModel(pId && m ? { profile_id: pId, model: m } : null)
                  setOpenPicker(null)
                }}
              />
            </PopoverSectionRow>
            </div>
          </div>

          {/* Temp Circumstance + Temp Motivator — side by side.
              Phase 2.12g+ — each side is a LIST of entries (was a
              single optional entry). Each entry renders as a card in
              the same style the entity detail panel uses for temp
              C/Ms: dashed border in the character's accent colour,
              name on top, description with intensity inline, and
              Edit / Remove buttons on the right. An Add form opens
              below the list when "+ Add" is clicked or above the
              edited entry when one is opened for edit. */}
          <div className="grid grid-cols-2 gap-3">
            <Section title="Temporary Circumstances (conversation-scoped)">
              <div data-help-region="character-chat-setup:temp_circumstances">
              <TempCMList
                attributeType="circumstance"
                entries={tempCircumstances}
                setEntries={setTempCircumstances}
                draft={tempCircumstanceDraft}
                setDraft={setTempCircumstanceDraft}
                formIdx={tempCircumstanceFormIdx}
                setFormIdx={setTempCircumstanceFormIdx}
                error={tempCircumstanceError}
                setError={setTempCircumstanceError}
                accent={accent}
              />
              </div>
            </Section>

            <Section title="Temporary Motivators (conversation-scoped)">
              <div data-help-region="character-chat-setup:temp_motivators">
              <TempCMList
                attributeType="motivator"
                entries={tempMotivators}
                setEntries={setTempMotivators}
                draft={tempMotivatorDraft}
                setDraft={setTempMotivatorDraft}
                formIdx={tempMotivatorFormIdx}
                setFormIdx={setTempMotivatorFormIdx}
                error={tempMotivatorError}
                setError={setTempMotivatorError}
                accent={accent}
              />
              </div>
            </Section>
          </div>

          <Section title="Custom Instructions (conversation-scoped)">
            <textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder={`e.g. "Be unusually terse in this chat; the writer is workshopping pacing."`}
              rows={3}
              data-help-region="character-chat-setup:custom_instructions"
              className="w-full bg-zinc-800 border border-zinc-700 rounded text-[11px] text-zinc-100 px-2 py-1 resize-y focus:outline-none focus:border-accent-500"
            />
            <div className="text-[10px] text-zinc-500 mt-1">Layered on top of the Persona prompt as its own block at send time. Never modifies the Persona prompt on disk.</div>
          </Section>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-zinc-700 flex items-center justify-end gap-2 flex-shrink-0">
          {!canConfirm && (
            <span className="text-[10px] text-zinc-500 mr-2">
              {!selectedCharacterId ? 'Pick a character.' : 'Pick a Persona system prompt.'}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] px-2.5 py-1 rounded border border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/60"
          >
            Cancel
          </button>
          {showAddSecondButton && (
            <button
              type="button"
              onClick={handleAddSecond}
              disabled={!canConfirm}
              title="Set up a second character to chat with this one through the AI. Opens a second setup window for Character 2."
              data-help-region="character-chat-setup:add_second"
              className="text-[11px] px-3 py-1 rounded border font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: accent, color: accent, backgroundColor: 'transparent' }}
            >
              🎭⇆🎭 Add 2nd Character: AI to AI Chat
            </button>
          )}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            data-help-region="character-chat-setup:start"
            className="text-[11px] px-3 py-1 rounded text-zinc-900 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: accent }}
          >
            {applyToExisting ? 'Apply to Chat' : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}


function Section({ title, children }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1 font-semibold">{title}</div>
      {children}
    </section>
  )
}


// Live-drag-preview block. Phase 2.11 Bugs & Fixes — profile
// `profiling-data.2026-05-31.19-28-15.json` showed the modal proper
// re-rendering 198 times in a single drag-anchor session (167 driven
// by the `previewPins` `useState` it used to own). Isolating those
// reads to this child component (memoised) means the rest of the
// modal — prompt picker, model picker, temp C/M, custom instructions —
// stops re-rendering on every drag mousemove. Only this block + the
// `ChainRangeSelector` itself need to track the live selection state.
const CharacterPreviewBlock = memo(function CharacterPreviewBlock({
  selectedCharacter,
  selectorRef,
  selectorItem,
  characters,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onPickCharacter,
  onAddPersonality,
}) {
  // Live preview pins — owned here so the modal parent doesn't
  // re-render on every drag mousemove. The chain-resolved character
  // header + description + personality previews all read from this.
  const [previewPins, setPreviewPins] = useState([])
  const handleSelectorSelectionChange = useCallback(() => {
    if (!selectorRef.current) { setPreviewPins([]); return }
    setPreviewPins(selectorRef.current.getCurrentPins() || [])
  }, [selectorRef])

  // Chain-resolved character state at the LATEST anchor across the
  // current selection (range end / single / last multi-pick). No
  // anchor selected → walker returns baseline (origin), which is
  // correct: that's exactly the state "at origin" we want to show
  // when a character is picked but nothing's anchored yet.
  const characterEffective = useMemo(() => {
    if (!selectedCharacter) return null
    try {
      const proj = useProjectStore.getState()
      const nodes = proj.nodes || []
      const edges = proj.edges || []
      let latestAnchor = null
      for (const pin of previewPins) {
        if (pin?.anchor_range?.end_node_id) latestAnchor = pin.anchor_range.end_node_id
        else if (pin?.anchor_node_id) latestAnchor = pin.anchor_node_id
      }
      return computeEffectiveState(selectedCharacter, nodes, edges, latestAnchor || null)
    } catch {
      return null
    }
  }, [selectedCharacter, previewPins])

  const characterDescription = characterEffective?.description || ''
  const characterDisplayName = characterEffective?.name || ''
  const characterDisplayColour = characterEffective?.colour || '#7c3aed'
  const characterDisplayImageRef = characterEffective?.profile_image_ref || null

  const characterDisplayImageSrc = useMemo(() => {
    if (!characterDisplayImageRef) return null
    if (characterDisplayImageRef.startsWith('data:')) return characterDisplayImageRef
    const assetName = characterDisplayImageRef.replace(/^assets\//, '')
    return `/api/project/assets/${assetName}`
  }, [characterDisplayImageRef])

  const personalityHit = useMemo(
    () => findPersonalityAttribute(selectedCharacter, previewPins),
    [selectedCharacter, previewPins],
  )

  return (
    <>
      <CharacterHeader
        character={selectedCharacter}
        displayName={characterDisplayName}
        displayColour={characterDisplayColour}
        displayImageSrc={characterDisplayImageSrc}
        characters={characters}
        pickerOpen={pickerOpen}
        onOpenPicker={onOpenPicker}
        onClosePicker={onClosePicker}
        onPick={onPickCharacter}
      />

      {selectedCharacter && (
        <Section title="Anchor to scene(s)">
          <div className="border border-zinc-700 rounded bg-zinc-900/40 flex flex-col" data-help-region="character-chat-setup:anchor">
            <ChainRangeSelector
              ref={selectorRef}
              item={selectorItem}
              otherPinMarkers={null}
              dynamicResolutionPoint={null}
              dynamicPinSessionId={null}
              onClearOtherPin={null}
              onAddDynamicPin={null}
              hideDynamicOption
              showFinalBookend
              identityCellWidth={0}
              onSelectionChange={handleSelectorSelectionChange}
            />
          </div>
        </Section>
      )}

      {selectedCharacter && (
        <>
          <Section title="Character Description">
            {characterDescription ? (
              <div className="text-[11px] text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {characterDescription}
              </div>
            ) : (
              <div className="text-[11px] text-zinc-500 italic">(No description set on this character.)</div>
            )}
          </Section>

          <Section title="Personality attribute">
            {personalityHit ? (
              <div className="text-[11px] text-zinc-300">
                <span className="font-semibold text-accent-200">{personalityHit.name}:</span>{' '}
                <span className="whitespace-pre-wrap">{String(personalityHit.value || '')}</span>
              </div>
            ) : (
              <div className="text-[11px] text-zinc-500 leading-snug space-y-1.5">
                <div>
                  This character has no <code className="text-[10px] bg-zinc-800 px-1 rounded">Personality</code> attribute yet. Add one, a text attribute named Personality describing how they think, talk, and behave, so the chat can stay in character. (Also recognised: {PERSONALITY_ATTR_SYNONYMS.join(', ')}.)
                </div>
                {onAddPersonality && (
                  <button
                    type="button"
                    onClick={onAddPersonality}
                    title="Closes this setup and opens the character at its origin on the Attributes tab, ready to add a Personality attribute."
                    className="text-[11px] px-2 py-1 rounded bg-accent-700 hover:bg-accent-600 text-white font-semibold transition-colors"
                  >
                    + Add Personality at Origin
                  </button>
                )}
              </div>
            )}
          </Section>
        </>
      )}
    </>
  )
})


// Large avatar (left) + name area (right) header. Both halves trigger
// the character picker. When unselected, the avatar shows a "?"
// placeholder and the name area reads "Click to Select a Character".
// Once a character is picked, the avatar shows the chain-resolved
// profile image bordered with the chain-resolved colour, and the
// name reads at the chain-resolved name in the same colour.
function CharacterHeader({
  character,
  displayName,
  displayColour,
  displayImageSrc,
  characters,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onPick,
}) {
  const triggerRef = useRef(null)
  const flyoutRef = useRef(null)
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0, maxH: 360 })

  function recomputePosition(clickX, clickY) {
    const W = 300
    // Anchor the flyout at the click point. Top-left of the flyout
    // sits at the cursor by default; clipping fallbacks slide /
    // flip when the cursor is near a viewport edge so the flyout
    // stays fully visible.
    let left = clickX
    if (left + W + 8 > window.innerWidth) {
      left = Math.max(8, window.innerWidth - W - 8)
    }
    if (left < 8) left = 8
    const spaceBelow = window.innerHeight - clickY - 16
    const spaceAbove = clickY - 16
    let top, maxH
    if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
      top = clickY
      maxH = Math.max(200, Math.min(440, spaceBelow))
    } else {
      maxH = Math.max(200, Math.min(440, spaceAbove))
      top = Math.max(8, clickY - maxH)
    }
    setFlyoutPos({ top, left, maxH })
  }

  function handleOpen(e) {
    // Capture the click point so the flyout opens AT the cursor
    // instead of attached to the trigger's bounding box.
    recomputePosition(e.clientX, e.clientY)
    onOpenPicker?.()
  }

  // Outside-click closes the flyout. Same shape PopoverSectionRow uses.
  useEffect(() => {
    if (!pickerOpen) return
    function onDocDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (flyoutRef.current?.contains(e.target)) return
      onClosePicker?.()
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [pickerOpen, onClosePicker])

  const avatarSize = 80
  const isSelected = !!character

  return (
    <div ref={triggerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        data-help-region="character-chat-setup:character"
        className={`w-full flex items-stretch gap-3 rounded p-2 text-left transition-colors ${
          pickerOpen ? 'bg-zinc-800' : 'bg-zinc-800/40 hover:bg-zinc-800/80'
        }`}
      >
        {/* Avatar square */}
        <div
          className="flex-shrink-0 rounded flex items-center justify-center overflow-hidden"
          style={{
            width: avatarSize,
            height: avatarSize,
            border: `2px solid ${isSelected ? displayColour : '#52525b'}`,
            backgroundColor: isSelected ? `${displayColour}22` : '#27272a',
          }}
        >
          {isSelected && displayImageSrc ? (
            <img
              src={displayImageSrc}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <span
              className="font-bold"
              style={{
                // No profile image yet: show the Character type icon
                // (👤) at chain-resolved colour so the slot reads as
                // "a character placeholder" rather than the generic
                // "?" used when no character is picked at all.
                fontSize: Math.round(avatarSize * (isSelected ? 0.7 : 0.55)),
                color: isSelected ? displayColour : '#71717a',
                lineHeight: 1,
              }}
            >
              {isSelected ? TYPE_ICONS.character : '?'}
            </span>
          )}
        </div>

        {/* Name area */}
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mb-1">
            Character
          </div>
          {isSelected ? (
            <div
              className="text-base font-semibold truncate"
              style={{ color: displayColour }}
            >
              {displayName || 'Untitled'}
            </div>
          ) : (
            <div className="text-base font-medium text-zinc-400 italic">
              Click to Select a Character
            </div>
          )}
        </div>
      </button>

      {pickerOpen && createPortal(
        <div
          ref={flyoutRef}
          data-character-chat-setup-flyout="true"
          className="fixed z-[70] bg-zinc-900 border border-zinc-700 rounded shadow-xl overflow-hidden"
          style={{
            top: flyoutPos.top,
            left: flyoutPos.left,
            width: 300,
            maxHeight: flyoutPos.maxH,
          }}
        >
          <EntityPickerPopover
            allEntities={characters}
            excludeIds={[]}
            onPick={onPick}
            onClose={onClosePicker}
            lockedType="character"
          />
        </div>,
        document.body,
      )}
    </div>
  )
}


// One conversation-scoped Temp Circumstance / Motivator slot. Shows a
// summary chip when set, or a "+ Add" button when unset; both open the
// inline `CircumstanceMotivatorForm`. Same shape the entity / scene C/M
// editors use — the only difference is that the captured value lives
// on the conversation, not on the entity chain.
// Phase 2.12g+ — multi-entry temp C/M list. Each entry renders as a
// compact card with the entity-detail-panel pattern (dashed border in
// the chat's accent colour, name on top, description with intensity
// inline, Edit / Remove buttons). Below the list, an Add form opens
// from the "+ Add" button at the bottom; when the writer clicks Edit
// on an existing entry, that entry's card is replaced by the same
// form in-place.
//
// `formIdx` controls the form overlay:
//   null  → no form visible
//   -1    → adding a new entry (form appears below the list)
//   N>=0  → editing entries[N] (form replaces that entry's card)
function TempCMList({
  attributeType,
  entries,
  setEntries,
  draft,
  setDraft,
  formIdx,
  setFormIdx,
  error,
  setError,
  accent,
}) {
  const addLabel = attributeType === 'motivator' ? '+ Add Temporary Motivator' : '+ Add Temporary Circumstance'
  const INTENSITY_LABELS = ['Faint', 'Mild', 'Moderate', 'Strong', 'Intense']
  const isEditing = typeof formIdx === 'number' && formIdx >= 0
  const isAdding = formIdx === -1
  const showForm = isEditing || isAdding

  function commitFromDraft() {
    const next = {
      name: draft.name?.trim() || null,
      description: draft.description?.trim() || null,
      intensity: draft.intensity ?? null,
    }
    if (!next.name && !next.description && next.intensity == null) {
      setError('Add a name, description, or intensity.')
      return
    }
    if (isEditing) {
      setEntries(entries.map((e, i) => (i === formIdx ? next : e)))
    } else {
      setEntries([...entries, next])
    }
    setFormIdx(null)
    setDraft({ name: '', description: '', intensity: null })
    setError(null)
  }

  function cancelForm() {
    setFormIdx(null)
    setDraft({ name: '', description: '', intensity: null })
    setError(null)
  }

  function startAdd() {
    setDraft({ name: '', description: '', intensity: null })
    setError(null)
    setFormIdx(-1)
  }

  function startEdit(idx) {
    const e = entries[idx]
    if (!e) return
    setDraft({
      name: e.name || '',
      description: e.description || '',
      intensity: e.intensity ?? null,
    })
    setError(null)
    setFormIdx(idx)
  }

  function removeEntry(idx) {
    setEntries(entries.filter((_, i) => i !== idx))
    if (isEditing && formIdx === idx) cancelForm()
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, idx) => {
        if (isEditing && formIdx === idx) {
          return (
            <div key={idx} style={{ border: `1px dashed ${accent}`, borderRadius: 4, padding: 1 }}>
              <CircumstanceMotivatorForm
                attributeType={attributeType}
                value={draft}
                setValue={setDraft}
                error={error}
                setError={setError}
                onConfirm={commitFromDraft}
                onCancel={cancelForm}
                confirmLabel="Save"
                headerLabel={`Edit Temporary ${attributeType === 'motivator' ? 'Motivator' : 'Circumstance'}`}
              />
            </div>
          )
        }
        const displayName = entry.name?.trim()
          || (entry.description
            ? (entry.description.length > 28 ? entry.description.slice(0, 28) + '…' : entry.description)
            : '(unnamed)')
        const TypeBadge = attributeType === 'motivator' ? MotivatorTypeBadge : CircumstanceTypeBadge
        const typeLabel = attributeType === 'motivator' ? 'Motivator' : 'Circumstance'
        return (
          <div
            key={idx}
            className="rounded p-1.5"
            style={{ border: `1px dashed ${accent}` }}
          >
            <div className="flex items-center gap-1 mb-0.5">
              <span
                className="text-[10px] flex-1 truncate text-zinc-300 cursor-text hover:text-zinc-100"
                onClick={() => startEdit(idx)}
                title={`Click to edit this Temporary ${typeLabel}`}
              >
                {displayName}
              </span>
              <TypeBadge size={14} temporary temporaryColour={accent} />
              <button
                type="button"
                onClick={() => removeEntry(idx)}
                className="text-[9px] text-zinc-700 hover:text-red-400 leading-none"
                title={`Remove this Temporary ${typeLabel}`}
              >
                −
              </button>
            </div>
            <div
              className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
              onClick={() => startEdit(idx)}
              title={`Click to edit this Temporary ${typeLabel}`}
            >
              <IntensityBadge level={entry.intensity ?? null} size={20} temporary temporaryColour={accent} />
              <div className="flex-1 min-w-0">
                {entry.description
                  ? <span className="text-zinc-300 whitespace-pre-wrap break-words">{entry.description}</span>
                  : null}
                {entry.intensity != null && (
                  <span className="text-[9px] text-zinc-500 ml-1">({INTENSITY_LABELS[entry.intensity]})</span>
                )}
              </div>
            </div>
          </div>
        )
      })}
      {isAdding && (
        <div style={{ border: `1px dashed ${accent}`, borderRadius: 4, padding: 1 }}>
          <CircumstanceMotivatorForm
            attributeType={attributeType}
            value={draft}
            setValue={setDraft}
            error={error}
            setError={setError}
            onConfirm={commitFromDraft}
            onCancel={cancelForm}
            confirmLabel="Add"
            headerLabel={`New Temporary ${attributeType === 'motivator' ? 'Motivator' : 'Circumstance'}`}
          />
        </div>
      )}
      {!showForm && (
        <button
          type="button"
          onClick={startAdd}
          className="text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 w-full text-left"
        >
          {addLabel}
        </button>
      )}
    </div>
  )
}


