/**
 * Phase 7.2 — Export Character Card modal.
 *
 * Pick any entity, choose a snapshot scene (single anchor), preview and edit
 * the composed description plus an authored first message, then export a
 * SillyTavern-importable card PNG. Composition is chain-aware: the entity's
 * effective state at the chosen anchor drives every field (see
 * `composeCharacterCard.js`). The thin backend `/character-card/export`
 * endpoint embeds the composed card-data + the profile image into the PNG.
 *
 * The chain anchor uses the same reusable `ChainRangeSelector` the chat setup
 * uses; for a card we read the latest selected anchor as the single snapshot
 * point (a card is one static moment, not a window).
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import ChainRangeSelector from '../chat/ChainRangeSelector'
import EntityPickerPopover from '../entities/EntityPickerPopover'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import ConnectionModelPickerList from '../ui/ConnectionModelPickerList'
import { useSettingsStore } from '../../store/settingsStore'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import { streamChat } from '../../services/chatClient'
import {
  effectiveStateForCard,
  composeInitialDescription,
  assembleCardData,
  DEFAULT_FIRST_MES,
} from '../../utils/composeCharacterCard'


export default function ExportCharacterCardModal({ open, onClose }) {
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const projectTags = useEntitiesStore((s) => s.projectTags)
  const prefs = useSettingsStore((s) => s.preferences)
  const aiDisabled = useAiDisabled()
  const storyOrder = useStoryOrder()

  const allEntities = useMemo(
    () => [
      ...(characters || []),
      ...(locations || []),
      ...(items || []),
      ...(factions || []),
      ...(customs || []),
    ],
    [characters, locations, items, factions, customs],
  )
  const entityById = useMemo(() => new Map(allEntities.map((e) => [e.id, e])), [allEntities])

  const [selectedEntityId, setSelectedEntityId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [firstMes, setFirstMes] = useState(DEFAULT_FIRST_MES)
  const [includeRelationships, setIncludeRelationships] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [enhancing, setEnhancing] = useState(false)

  // AI connection + model for the greeting enhancer. Defaults to the writer's
  // global default; the picker below lets them choose a different pair.
  const defaultProfileId = prefs?.ai_default_profile_id || null
  const defaultModel = prefs?.ai_default_model?.model || null
  const [pickedProfileId, setPickedProfileId] = useState(defaultProfileId)
  const [pickedModel, setPickedModel] = useState(defaultModel)
  const modelTree = useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    return profiles
      .map((profile) => ({
        profile,
        models: Array.from(new Set([
          ...(profile.selected_models || []),
          ...(profile.manually_added_models || []),
        ])),
      }))
      .filter(({ models }) => models.length > 0)
  }, [prefs?.ai_provider_profiles])

  const selectorRef = useRef(null)
  const [previewPins, setPreviewPins] = useState([])
  const handleSelectorChange = useCallback(() => {
    if (!selectorRef.current) { setPreviewPins([]); return }
    setPreviewPins(selectorRef.current.getCurrentPins() || [])
  }, [])

  // Reset every field when the modal closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setSelectedEntityId(null)
      setPickerOpen(false)
      setDescription('')
      setFirstMes(DEFAULT_FIRST_MES)
      setIncludeRelationships(true)
      setPreviewPins([])
    }
  }, [open])

  // Stable `item` reference for the selector (resets selection by reference).
  const selectorItem = useMemo(
    () => (selectedEntityId ? { kind: 'entity', id: selectedEntityId } : null),
    [selectedEntityId],
  )

  const selectedEntity = selectedEntityId ? entityById.get(selectedEntityId) : null

  // The card is a single static snapshot: take the latest selected anchor.
  const latestAnchor = useMemo(() => {
    let a = null
    for (const pin of previewPins) {
      if (pin?.anchor_range?.end_node_id) a = pin.anchor_range.end_node_id
      else if (pin?.anchor_node_id) a = pin.anchor_node_id
    }
    return a
  }, [previewPins])

  // Effective state at the anchor, used for the prominent profile image +
  // name preview. The image embedded into the card comes from this same ref.
  const eff = useMemo(() => {
    const entity = selectedEntityId ? entityById.get(selectedEntityId) : null
    if (!entity) return null
    const proj = useProjectStore.getState()
    return effectiveStateForCard(entity, latestAnchor, proj.nodes || [], proj.edges || [])
  }, [selectedEntityId, latestAnchor, entityById])

  const profileImageSrc = useMemo(() => {
    const ref = eff?.profile_image_ref
      || (selectedEntityId ? entityById.get(selectedEntityId)?.profile_image_ref : null)
    if (!ref) return null
    if (ref.startsWith('data:')) return ref
    return `/api/project/assets/${ref.replace(/^assets\//, '')}`
  }, [eff, selectedEntityId, entityById])

  // The AI-enhance button needs a chosen connection + model.
  const canEnhance = !!(pickedProfileId && pickedModel)

  // Recompose the editable description preview whenever the entity, anchor,
  // or relationships toggle change. User edits are intentionally reset when
  // the source they were composed from changes.
  useEffect(() => {
    const entity = selectedEntityId ? entityById.get(selectedEntityId) : null
    if (!entity) { setDescription(''); return }
    const proj = useProjectStore.getState()
    const nodes = proj.nodes || []
    const edges = proj.edges || []
    const eff = effectiveStateForCard(entity, latestAnchor, nodes, edges)
    if (!eff) { setDescription(''); return }
    const ctx = { relationships: proj.relationships || [], nodes, edges, storyOrder, entityById }
    // Story bundle for resolving perspective target names (entities +
    // knowledges + relationships), matching the chat-context formatter shape.
    const ent = useEntitiesStore.getState()
    const story = {
      entities: {
        characters: ent.characters || [],
        locations: ent.locations || [],
        items: ent.items || [],
        factions: ent.factions || [],
        customs: ent.customs || [],
      },
      knowledges: proj.knowledges || [],
      relationships: proj.relationships || [],
    }
    setDescription(composeInitialDescription(eff, {
      includeRelationships,
      relationshipCtx: ctx,
      entityId: entity.id,
      anchorNodeId: latestAnchor,
      story,
      entityName: eff.name || entity.name || '',
    }))
  }, [selectedEntityId, latestAnchor, includeRelationships, storyOrder, entityById])

  const handleExport = useCallback(async () => {
    const entity = selectedEntityId ? entityById.get(selectedEntityId) : null
    if (!entity || exporting) return
    setExporting(true)
    try {
      const proj = useProjectStore.getState()
      const eff = effectiveStateForCard(entity, latestAnchor, proj.nodes || [], proj.edges || [])
      const { card_data, profile_image_ref } = assembleCardData({
        entity,
        eff,
        anchorNodeId: latestAnchor,
        description,
        firstMes,
        projectTags,
      })
      const response = await fetch('/api/character-card/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_data, profile_image_ref }),
      })
      if (!response.ok) throw new Error('export failed')
      const blob = await response.blob()
      const cd = response.headers.get('content-disposition') || ''
      const m = /filename="([^"]+)"/.exec(cd)
      const filename = m ? m[1] : `${card_data.name || 'character'}.png`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      // No success banner: the file download plus the modal closing are the
      // success indicators. The transient banner is the red failure bar, so
      // it is reserved for the catch path below.
      onClose?.()
    } catch {
      useUiStore.getState().showTransientAlert('Could not export the character card.')
    } finally {
      setExporting(false)
    }
  }, [selectedEntityId, entityById, exporting, latestAnchor, description, firstMes, projectTags, onClose])

  // "Enhance with AI": generate / improve the opening greeting using the
  // writer's default AI connection. Streams the result into the field so it
  // fills in live. Reuses the existing chat client; no tools.
  const handleEnhanceGreeting = useCallback(async () => {
    const entity = selectedEntityId ? entityById.get(selectedEntityId) : null
    if (!entity || enhancing) return
    const profileId = pickedProfileId
    const model = pickedModel
    if (!profileId || !model) {
      useUiStore.getState().showTransientAlert('Pick an AI connection and model first.')
      return
    }
    setEnhancing(true)
    try {
      const proj = useProjectStore.getState()
      const effNow = effectiveStateForCard(entity, latestAnchor, proj.nodes || [], proj.edges || [])
      const name = effNow?.name || entity.name
      const systemPrompt =
        'You write the opening message (greeting) for a roleplay character card. ' +
        'Using only the character details provided, write a short, in-character greeting ' +
        'that addresses the user directly and invites interaction. Use {{char}} for the ' +
        'character name and {{user}} for the user. Return ONLY the greeting itself: one to ' +
        'three short paragraphs, no preamble, no surrounding quotes, no commentary.'
      const userMsg =
        `Character name: ${name}\n\n` +
        `Character details:\n${description || '(none provided)'}\n\n` +
        `Current draft greeting to improve or replace:\n${firstMes || '(none)'}`
      let acc = ''
      for await (const event of streamChat({
        profileId,
        model,
        messages: [{ role: 'user', content: userMsg }],
        systemPrompt,
        enableTools: false,
      })) {
        if (event.type === 'delta' && event.text) {
          acc += event.text
          setFirstMes(acc)
        } else if (event.type === 'end') {
          if (event.text) acc = event.text
          setFirstMes(acc)
        } else if (event.type === 'error') {
          throw new Error(event.detail || 'AI error')
        }
      }
    } catch {
      useUiStore.getState().showTransientAlert('Could not enhance the greeting with AI.')
    } finally {
      setEnhancing(false)
    }
  }, [selectedEntityId, entityById, enhancing, pickedProfileId, pickedModel, latestAnchor, description, firstMes])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-[640px] max-w-[92vw] max-h-[88vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-100">Export Character Card</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Entity picker. The popover renders IN FLOW (not absolute) so it
              is never clipped by this scroll container when the modal is
              short on first open. */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Entity</label>
            {/* Nothing selected yet: the picker is the only action, so it
                stays expanded (no collapse button). Once an entity is chosen,
                a compact button lets the user reopen it to change. */}
            {selectedEntity && !pickerOpen && (
              <button
                onClick={() => setPickerOpen(true)}
                className="w-full text-left px-3 py-2 rounded border border-zinc-700 bg-zinc-800 text-sm text-zinc-100 hover:border-zinc-500"
              >
                {selectedEntity.name} <span className="text-zinc-500">(change)</span>
              </button>
            )}
            {(!selectedEntity || pickerOpen) && (
              <EntityPickerPopover
                allEntities={allEntities}
                excludeIds={[]}
                onPick={(id) => { setSelectedEntityId(id); setPickerOpen(false) }}
                onClose={() => { if (selectedEntity) setPickerOpen(false) }}
              />
            )}
          </div>

          {selectedEntity && (
            <>
              <div className="flex flex-col items-center gap-2">
                {profileImageSrc ? (
                  <ImageHoverPreview
                    src={profileImageSrc}
                    borderColour={eff?.colour || selectedEntity.colour || '#52525b'}
                    size={240}
                  >
                    <img
                      src={profileImageSrc}
                      alt={eff?.name || selectedEntity.name}
                      className="w-28 h-28 rounded-lg object-cover border-2"
                      style={{ borderColor: eff?.colour || selectedEntity.colour || '#52525b' }}
                    />
                  </ImageHoverPreview>
                ) : (
                  <div className="w-28 h-28 rounded-lg border-2 border-dashed border-zinc-700 flex items-center justify-center text-center text-[10px] text-zinc-500 px-2">
                    No profile image. A name placeholder is embedded.
                  </div>
                )}
                <div className="text-sm font-medium text-zinc-100">{eff?.name || selectedEntity.name}</div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Snapshot at scene</label>
                <div className="border border-zinc-700 rounded bg-zinc-900/40 flex flex-col">
                  <ChainRangeSelector
                    ref={selectorRef}
                    item={selectorItem}
                    singleSelect
                    otherPinMarkers={null}
                    dynamicResolutionPoint={null}
                    dynamicPinSessionId={null}
                    onClearOtherPin={null}
                    onAddDynamicPin={null}
                    hideDynamicOption
                    identityCellWidth={0}
                    onSelectionChange={handleSelectorChange}
                  />
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">
                  The card captures the entity exactly as it stands at this scene. No scene selected uses its starting state.
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-300 select-none">
                <input
                  type="checkbox"
                  checked={includeRelationships}
                  onChange={(e) => setIncludeRelationships(e.target.checked)}
                />
                Include a relationships section in the description
              </label>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Description (editable)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={10}
                  className="w-full px-3 py-2 rounded border border-zinc-700 bg-zinc-800 text-sm text-zinc-100 resize-y"
                  placeholder="Composed from the entity's state at the chosen scene."
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-zinc-400">First message</label>
                  {/* The greeting enhancer + its connection picker are AI
                      surfaces: hidden entirely when AI integrations are off. */}
                  {!aiDisabled && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={handleEnhanceGreeting}
                        disabled={!canEnhance || enhancing}
                        title={canEnhance
                          ? 'Generate a greeting with the selected AI connection'
                          : 'Pick a connection and model first'}
                        className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        {enhancing ? 'Enhancing…' : 'Enhance with AI'}
                      </button>
                      <ConnectionGearButton
                        modelTree={modelTree}
                        pickedProfileId={pickedProfileId}
                        pickedModel={pickedModel}
                        defaultProfileId={defaultProfileId}
                        defaultModel={defaultModel}
                        onPick={(p, m) => { setPickedProfileId(p); setPickedModel(m) }}
                      />
                    </div>
                  )}
                </div>
                <textarea
                  value={firstMes}
                  onChange={(e) => setFirstMes(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 rounded border border-zinc-700 bg-zinc-800 text-sm text-zinc-100 resize-y"
                  placeholder="The character's opening message. {{char}} is replaced with the name."
                />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={!selectedEntity || exporting}
            className="px-3 py-1.5 rounded text-sm bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export Card'}
          </button>
        </div>
      </div>
    </div>
  )
}


// Gear button beside "Enhance with AI" that opens a portalled connection /
// model picker. Portals to document.body so the modal's scroll container can't
// clip it; React-tree bubbling still stops inside the modal, so picking a model
// never reaches the backdrop close-handler.
function ConnectionGearButton({ modelTree, pickedProfileId, pickedModel, defaultProfileId, defaultModel, onPick }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const flyoutRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0, maxH: 360 })

  function recompute() {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const width = 320
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const avail = window.innerHeight - rect.bottom - 16
    setPos({ top: rect.bottom + 4, left, maxH: Math.max(160, Math.min(360, avail)) })
  }

  useEffect(() => {
    if (!open) return
    function onDocDown(e) {
      if (btnRef.current?.contains(e.target)) return
      if (flyoutRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { if (open) { setOpen(false) } else { recompute(); setOpen(true) } }}
        title={pickedModel ? `AI connection: ${pickedModel}` : 'Choose AI connection and model'}
        className="text-[12px] leading-none px-1.5 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        aria-label="Choose AI connection and model"
      >
        ⚙
      </button>
      {open && createPortal(
        <div
          ref={flyoutRef}
          className="fixed z-[1600] bg-zinc-900 border border-zinc-700 rounded shadow-xl overflow-y-auto py-1 text-[11px]"
          style={{ top: pos.top, left: pos.left, width: 320, maxHeight: pos.maxH }}
        >
          <ConnectionModelPickerList
            tree={modelTree}
            activeProfileId={pickedProfileId}
            activeModel={pickedModel}
            defaultProfileId={defaultProfileId}
            defaultModel={defaultModel}
            onPick={(p, m) => { onPick(p, m); setOpen(false) }}
            emptyMessage="No connections configured."
          />
        </div>,
        document.body,
      )}
    </>
  )
}
