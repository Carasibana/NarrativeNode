import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { usePreviewStore } from '../../store/previewStore'
import { confirm } from '../../store/dialogStore'
import { getEntityNarrativeChain, computeEffectiveState, computeEffectiveStateWithPrior, computeChangeSubChips, computeRelationshipEffectiveState, getRelationshipChangesAtNode, getAwarenessChangesForObserverAtNode, getEntityRelationshipChangesAtNode, formatNumberForChip } from '../../utils/narrativeChain'
import { ENTITY_BUCKETS, TYPE_ICONS, ATTR_TYPE_COLOURS, emptyAttr, getEntityRefAtNode, changesDraftIsClean, makeChangesDraftHelpers, participantsFallbackLabel, applyAttributeOrder } from '../../utils/entityHelpers'
import useLibraryReorder from '../../hooks/useLibraryReorder'
import { buildSourceEventFromEntityRefChip, buildSourceEventFromOriginAttribute, buildSuggestedKnowledgeName } from '../../utils/sourceEventBuilder'
import { createEmptyRelationshipHistory } from '../../utils/relationshipHistory'
import { useEntityById } from '../../hooks/useEntityById'
import { FileAttrInput, ChangeBadge, ExpandableTextField, CollapsibleDescription } from './SharedEntityComponents'
import TextListAttribute, { getTextListPendingSets, parseListValue } from './TextListAttribute'
import EntityListAttribute from './EntityListAttribute'
import ProfileImageUpload from './ProfileImageUpload'
import { useProfileImageDropTarget } from '../../hooks/useProfileImageDropTarget'
import { OvumRedAvatar, isOvumRedEntity, getOvumRedAttributeStyle, ovumTealHandleAttributeKeydown } from '../../effects/quarterlyForecasts'
import EntityColorPicker from '../ui/EntityColorPicker'
import { RelChangeChip } from '../nodes/RelationshipChip'
import { orderedCMEntriesFromScene } from '../../utils/cmSubchipOrder'
import EntityPickerPopover from './EntityPickerPopover'
import PerspectiveTargetPicker from './PerspectiveTargetPicker'
import { computePovChain } from '../../utils/povSequence'
import { usePovColor } from '../../utils/povConstants'
import PovNavToggleButton from '../ui/PovNavToggleButton'
import RelationshipSummaryHeader from './RelationshipSummaryHeader'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import DetailPanelNavBar from '../ui/DetailPanelNavBar'
import DetailPanelIdentityHeader from '../ui/DetailPanelIdentityHeader'
import AttachToChatButton from '../chat/AttachToChatButton'
import CharacterChatSetupModal from '../chat/CharacterChatSetupModal'
import { createCharacterChatThread, createTwoCharacterChatThread } from '../../utils/createCharacterChatThread'
import { useSettingsStore } from '../../store/settingsStore'
import { useConversationsStore } from '../../store/conversationsStore'
import DetailPanelShell from '../ui/DetailPanelShell'
import DescriptionEditor from '../ui/DescriptionEditor'
import ShowInTocButton from '../ui/ShowInTocButton'
import DetailPanelSubTabs from '../ui/DetailPanelSubTabs'
import NotesFooterButton from '../ui/NotesFooterButton'
import { CircumstanceTypeBadge, MotivatorTypeBadge, PerspectiveTypeBadge } from '../ui/TypeBadges'
import { IntensityBadge, INTENSITY_LABELS } from '../ui/IntensityBadge'
import IntensitySlider from '../ui/IntensitySlider'
import CircumstanceMotivatorForm from './CircumstanceMotivatorForm'
import { useAccentColor } from '../../utils/povConstants'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import PresetListPicker from '../ui/PresetListPicker'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { useChapterMemberOpts } from '../../hooks/useChapterMemberOpts'
import KnownBySection from '../ui/KnownBySection'
import AwareOfSection from '../ui/AwareOfSection'
import { RelationshipLabelStack, EntityLabelChip, KnowledgeLabelChip, RelationshipLabelChip, RelationshipIcon } from '../ui/IdentityBadges'
import {
  buildDeleteRelationshipMessage, buildEndRelationshipMessage, buildLeaveRelationshipMessage,
} from '../ui/popupMessages'
import {
  ChangesSummarySection,
  AliasesOverrideRow,
  navigateToChainStop,
} from './EntityDetailPanelShared'
import DraftSaveBar from '../ui/DraftSaveBar'
import OverrideRow from '../ui/OverrideRow'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import TagPopover from '../tags/TagPopover'
import { useTagBrowsePopover } from '../tags/useTagBrowsePopover'
import { useDetailPanelDraft } from '../../hooks/useDetailPanelDraft'

const EMPTY_CHAPTERS = []

// ── AliasTagEditor — inline tag-chip list editor (origin mode) ───────────────
// Quick value-only editor for the entity's aliases — adds, renames (via
// remove+add), and removes alias entries. Per-alias awareness controls
// live in the dedicated `<AliasesPanel>` modal (Phase 1.21e). The tag
// editor preserves each alias's existing `awareness` dict on every
// edit; only `value` changes here.

function AliasTagEditor({ aliases: aliasesProp, onAdd, onRemove }) {
  const [inputVal, setInputVal] = useState('')

  // Normalise to `{ id?, value, awareness }` objects internally so
  // legacy string-form aliases (very old saves) round-trip cleanly and
  // so callers can match on id when removing (per-alias chain events
  // need stable ids — 2026-05-17 refactor).
  const aliases = (aliasesProp || []).map((a) => (
    typeof a === 'string'
      ? { id: null, value: a, awareness: null }
      : { id: a.id || null, value: a.value || '', awareness: a.awareness ?? null }
  ))

  function addAlias() {
    const trimmed = inputVal.trim()
    if (!trimmed || aliases.some((a) => a.value === trimmed)) { setInputVal(''); return }
    onAdd(trimmed)
    setInputVal('')
  }

  function removeAlias(alias) {
    // Pass the full alias object (with id when present) so the parent
    // can record a per-alias chain event keyed on the id.
    onRemove(alias)
  }

  return (
    <div>
      {/* Input row first, chips below — visually rhymes with the Tags
          section (which uses `chipsPosition='below'`). Placeholder
          colour matches the Tags input. */}
      <div className="flex gap-1 mb-1.5">
        <input
          type="text"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-zinc-100 focus:outline-none focus:border-accent-500 placeholder:text-zinc-600"
          placeholder="Add alias…"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias() } }}
        />
        <button
          onClick={addAlias}
          className="inline-flex items-center justify-center px-2 py-0.5 text-[10px] leading-none font-bold rounded border border-zinc-700 bg-zinc-800 text-accent-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300 transition-colors"
        >
          {/* 1px lift to put `+` on the optical centre — same fix used
              by other button glyphs in this file (e.g. line ~2087). */}
          <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1px)' }}>+</span>
        </button>
      </div>
      <div className="flex flex-wrap gap-1 min-h-[20px]">
        {aliases.map((alias) => (
          <span key={alias.id || alias.value} className="group flex items-center gap-1 pl-1.5 pr-1 py-0.5 bg-zinc-700 rounded text-[10px] text-zinc-300">
            {alias.value}
            <button
              onClick={() => removeAlias(alias)}
              className="text-zinc-500 hover:text-red-400 leading-none ml-0.5 hidden group-hover:inline-block focus:inline-block focus-visible:inline-block"
            >×</button>
          </span>
        ))}
        {aliases.length === 0 && <span className="text-[10px] text-zinc-600 italic">None</span>}
      </div>
    </div>
  )
}

// ── Entity Detail View ────────────────────────────────────────────────────────
// Unified component handling all three chain-anchor positions:
//   - anchorKind="origin"   → entity origin node (initial-state editor)
//   - anchorKind="chip"     → entity chip on a scene
//   - anchorKind="modifier" → entity modifier node (chain-mid override only)
//
// Origin and chip share most of the editor surface; the modifier is a chain
// mid-point that mirrors chip semantics with a smaller scope (no relationship
// editor, no upstream search/wire flow). Branches are gated on `isOrigin`,
// `isChip`, `isModifier` only at the genuinely-divergent points.

function EntityDetailView({ anchorKind = 'chip', subTab, setSubTab, showAddAttr, setShowAddAttr }) {
  const isOrigin   = anchorKind === 'origin'
  const isModifier = anchorKind === 'modifier'
  const isChip     = anchorKind === 'chip'
  // Phase 1.22h — workspace accent colour, used as the "scene's
  // default colour" for temporary C/M chevron-corner outlines and
  // dashed row borders. Anchors temporary entries visually to the
  // scene rather than the C/M tier or the entity colour.
  const sceneAccentColour = useAccentColor()
  // Phase 5.7 — when AI integrations are disabled, the "talk to this
  // character" button is hidden (see talkButton below).
  const aiDisabled = useAiDisabled()

  const nodeId              = useUiStore((s) => s.detailPanelNodeId)
  const entityId            = useUiStore((s) => s.detailPanelEntityId)

  // Phase 2.5g — accept chat-image / OS-file drops onto the avatar
  // in the Detail Panel. The drop commits immediately via the
  // chain-aware store action (bypassing the panel's draft pattern);
  // anchor is the panel's current `detailPanelNodeId`, which the
  // store action routes correctly (baseline write at origin, chain
  // entry at any other anchor).
  const avatarDrop = useProfileImageDropTarget({
    kind: 'entity',
    id: entityId,
    anchorNodeId: nodeId,
  })
  const setDetailPanel      = useUiStore((s) => s.setDetailPanel)
  const focusNode           = useUiStore((s) => s._focusNode)
  const openRelationshipDetail       = useUiStore((s) => s.openRelationshipDetail)
  const openEntityAtRelationshipsTab = useUiStore((s) => s.openEntityAtRelationshipsTab)
  const openHierarchyEditor          = useUiStore((s) => s.openHierarchyEditor)
  const nodes               = useProjectStore((s) => s.nodes)
  const edges               = useProjectStore((s) => s.edges)
  const storyChapters       = useProjectStore((s) => s.story?.chapters || EMPTY_CHAPTERS)
  const chapterMemberOpts   = useChapterMemberOpts()
  const saveEntityChipDraft        = useProjectStore((s) => s.saveEntityChipDraft)
  const saveModifierNodeDraft      = useProjectStore((s) => s.saveModifierNodeDraft)
  const flagDownstreamAfterOrigin  = useProjectStore((s) => s.flagDownstreamAfterOriginEdit)
  const cascadeDropAttributeChanges = useProjectStore((s) => s.cascadeDropAttributeChanges)
  // Phase 1.22h — projectStore actions for scene-scoped temporary
  // circumstances / motivators. These are NOT chain-tracked: they
  // live on Scene.entity_temporary_circumstances; each action takes
  // its own _snapshot for undo. Convert is atomic.
  const addEntityTemporaryCM         = useProjectStore((s) => s.addEntityTemporaryCM)
  const updateEntityTemporaryCM      = useProjectStore((s) => s.updateEntityTemporaryCM)
  const removeEntityTemporaryCM      = useProjectStore((s) => s.removeEntityTemporaryCM)
  const convertEntityTemporaryToOngoing = useProjectStore((s) => s.convertEntityTemporaryToOngoing)
  const reorderEntityCMs                = useProjectStore((s) => s.reorderEntityCMs)
  const addParticipant          = useProjectStore((s) => s.addParticipant)
  const togglePreview       = usePreviewStore((s) => s.togglePreview)
  const entity              = useEntityById(entityId)
  const updateEntity        = useEntitiesStore((s) => s.updateEntity)
  const reorderEntityAttributes = useEntitiesStore((s) => s.reorderEntityAttributes)
  const entCharacters       = useEntitiesStore((s) => s.characters)
  const entLocations        = useEntitiesStore((s) => s.locations)
  const entItems            = useEntitiesStore((s) => s.items)
  const entFactions         = useEntitiesStore((s) => s.factions)
  const entCustoms          = useEntitiesStore((s) => s.customs)
  const presetLists         = useEntitiesStore((s) => s.presetLists)
  const allEntities         = useMemo(
    () => [...entCharacters, ...entLocations, ...entItems, ...entFactions, ...entCustoms],
    [entCharacters, entLocations, entItems, entFactions, entCustoms]
  )
  const allRelationships         = useProjectStore((s) => s.relationships)
  const allKnowledgesPS          = useProjectStore((s) => s.knowledges)
  const relationshipsByEntity    = useProjectStore((s) => s.relationshipsByEntity)
  const recordRelationshipChange = useProjectStore((s) => s.recordRelationshipChange)
  const removeRelationshipChange = useProjectStore((s) => s.removeRelationshipChange)
  const createRelationship       = useProjectStore((s) => s.createRelationship)
  const createRelationshipViaEntityOrigin = useProjectStore((s) => s.createRelationshipViaEntityOrigin)
  const deleteObjectInChip       = useProjectStore((s) => s.deleteObject)
  const removeParticipantInChip  = useProjectStore((s) => s.removeParticipant)
  const setRelationshipName      = useProjectStore((s) => s.setRelationshipName)

  const [newAttr, setNewAttr]         = useState(emptyAttr)
  const [attrNameError, setAttrNameError] = useState(null)  // null | 'blank' | 'duplicate'
  // One-shot pre-seed of the Add Attribute form. The Character Chat
  // setup modal's "Add Personality at Origin" shortcut sets a
  // `detailPanelAddAttrPrefill` ({ entityId, name, type }) and
  // navigates here; when the form opens for the matching entity we
  // populate the new attribute's name/type, then clear the prefill.
  const _addAttrPrefillSeeded = useRef(false)
  useEffect(() => {
    if (!showAddAttr) { _addAttrPrefillSeeded.current = false; return }
    if (_addAttrPrefillSeeded.current) return
    _addAttrPrefillSeeded.current = true
    const ui = useUiStore.getState()
    const pf = ui.detailPanelAddAttrPrefill
    if (pf && pf.entityId && pf.entityId === ui.detailPanelEntityId) {
      const type = pf.type || 'text'
      setNewAttr({ ...emptyAttr(), name: pf.name || '', attribute_type: type })
      useUiStore.setState({ detailPanelAddAttrPrefill: null })
      // Name is already filled in, so drop the cursor straight into the
      // Value field (text attrs) so the writer can start typing the
      // description, overriding the name input's autoFocus.
      if (type === 'text') setTimeout(() => valueInputRef.current?.focus(), 0)
    }
  }, [showAddAttr])
  const valueInputRef                  = useRef(null)
  const fileUploadTrigger              = useRef(null)
  const [newAttrPickerOpen, setNewAttrPickerOpen] = useState(false)

  // Phase 2.11b item 14 — "🎭 Talk to this character" entry point.
  // Only the character branch of the detail panel ever opens this
  // modal; the button itself is gated on `entity.type === 'character'`
  // so the state hook is dead-weight on every other entity type. The
  // initial meta is built at click-time (anchor depends on the
  // detail panel's current `nodeId`); the modal itself drives the
  // rest of the setup before handing back a CharacterChatMeta via
  // `onConfirm`.
  const [talkSetupOpen, setTalkSetupOpen] = useState(false)
  const [talkInitialMeta, setTalkInitialMeta] = useState(null)
  // Phase 2.12 — two-modal flow state for the detail-panel AI-to-AI
  // entry. Mirrors the ThreadBrowser pattern: `firstCharacterMetaForTalk`
  // snapshots modal 1's draft when the writer clicks "Add 2nd
  // Character: AI to AI Chat"; the second modal layers over the first
  // with `allowAdd2nd=false`. Modal 2's Confirm assembles the
  // `TwoCharacterChatMeta` and creates the thread.
  const [talkSecondSetupOpen, setTalkSecondSetupOpen] = useState(false)
  const [firstCharacterMetaForTalk, setFirstCharacterMetaForTalk] = useState(null)
  const prefs                = useSettingsStore((s) => s.preferences)
  const createThread         = useConversationsStore((s) => s.createThread)
  const _entCharsForTalk     = useEntitiesStore((s) => s.characters)
  // Awareness sub-tab — Known By is independently collapsible (default
  // collapsed; only expandable when tracking is on). State lives in
  // `uiStore` (not local) so it survives the unmount/remount that
  // happens when the user navigates between an entity's origin node,
  // chip, and modifier views — those are separate `<EntityDetailView>`
  // siblings under `DetailPanel.jsx` and React resets local state on
  // the swap. Aware Of is NOT collapsible — it renders unconditionally.
  const knownByExpanded    = useUiStore((s) => s.detailPanelKnownByExpanded)
  const setKnownByExpanded = useUiStore((s) => s.setDetailPanelKnownByExpanded)
  const newAttrPresetAnchorRef         = useRef(null)

  // ── Draft state ─────────────────────────────────────────────────────────────
  // Backed by the shared `useDetailPanelDraft` hook. The hook's slot
  // semantics match the legacy `useState(null)` pattern exactly: `draft`
  // is null when clean, populated when dirty; `setDraft(updater)` passes
  // the current slot value (possibly null) to the updater so the
  // existing `(d) => ({ ...(d ?? initDraft()), ... })` patterns continue
  // to work unchanged.
  const _draftKey = entityId ? `entity:${anchorKind}:${entityId}:${nodeId ?? 'origin'}` : null
  const _entityDraftHandle = useDetailPanelDraft({
    draftKey: _draftKey,
    save: () => handleSave(),
    discard: () => handleDiscard(),
  })
  const draft     = _entityDraftHandle.draft
  const setDraft  = _entityDraftHandle.setDraft
  const isDirty   = _entityDraftHandle.isDirty
  const tryProceed = _entityDraftHandle.tryProceed

  // Relationship sub-editor (chip/origin only — modifier shows read-only summary)
  const [relDraft,            setRelDraft]            = useState({})
  const [relRolePickerOpenId, setRelRolePickerOpenId] = useState(null)
  const relRoleAnchorRefs = useRef({})
  const [editingRelNameId,    setEditingRelNameId]    = useState(null)
  const [relNameVal,          setRelNameVal]          = useState('')

  function openRelDraft(rid, initPerception, initRole, initAlias) {
    setRelDraft((d) => ({ ...d, [rid]: {
      perception: initPerception || '',
      role: initRole ? { value: initRole.value || '', preset_list_id: initRole.preset_list_id || null } : { value: '', preset_list_id: null },
      alias: initAlias || '',
    } }))
  }
  function updateRelDraftField(rid, field, value) {
    setRelDraft((d) => ({ ...d, [rid]: { ...d[rid], [field]: value } }))
  }
  function cancelRelDraft(rid) {
    setRelDraft((d) => { const n = { ...d }; delete n[rid]; return n })
    setRelRolePickerOpenId(null)
  }
  function saveRelDraft(rid, storedPerception, storedRole, storedAlias) {
    const d = relDraft[rid]
    if (!d) return
    if (d.perception !== (storedPerception || '')) {
      recordRelationshipChange(rid, { type: 'perception', data: { node_id: nodeId, entity_id: entityId, new_perception: d.perception } })
    }
    const dRoleVal = d.role?.value || ''
    const dRolePid = d.role?.preset_list_id || null
    if (dRoleVal !== (storedRole?.value || '') || dRolePid !== (storedRole?.preset_list_id || null)) {
      recordRelationshipChange(rid, { type: 'role', data: { node_id: nodeId, entity_id: entityId, new_role: dRoleVal.trim() ? d.role : null } })
    }
    if ((d.alias || '') !== (storedAlias || '')) {
      recordRelationshipChange(rid, { type: 'alias', data: { node_id: nodeId, entity_id: entityId, new_alias_override: d.alias?.trim() || null } })
    }
    cancelRelDraft(rid)
  }
  const [showCreateRel, setShowCreateRel] = useState(false)
  const [newRelName, setNewRelName] = useState('')
  const [newRelPartnerSearch, setNewRelPartnerSearch] = useState('')
  const [newRelSelectedPartnerIds, setNewRelSelectedPartnerIds] = useState([])
  const [overflowOpenForRel, setOverflowOpenForRel] = useState(null)
  const [showAddMember, setShowAddMember] = useState(false)

  // ── Inline name editing ─────────────────────────────────────────────────────
  const [editingName, setEditingName] = useState(false)
  const [nameEditVal, setNameEditVal] = useState('')
  const nameInputRef                  = useRef(null)

  function startEditName() {
    const current = isOrigin
      ? (isDirty ? draft.name : (entity?.name || ''))
      : effectiveState.name
    setNameEditVal(current)
    setEditingName(true)
  }

  function commitNameEdit() {
    setEditingName(false)
    if (isOrigin) {
      const original = isDirty ? draft.name : (entity?.name || '')
      if (nameEditVal === original) return
      setDraft((d) => ({ ...(d ?? initDraft()), name: nameEditVal }))
    } else {
      // chip uses entityRef.name_change; modifier uses nodeData.name_change
      const savedNameChange = isModifier ? (nodeData?.name_change ?? null) : (entityRef?.name_change ?? null)
      const currentOverride = isDirty ? draft.name_change : savedNameChange
      const newOverride = nameEditVal === priorEffectiveState?.name ? null : nameEditVal
      if (newOverride === currentOverride) return
      setDraft((d) => ({ ...(d ?? initDraft()), name_change: newOverride }))
    }
  }

  useEffect(() => { if (editingName) nameInputRef.current?.focus() }, [editingName])

  // ── Attribute name inline editing ──────────────────────────────────────────
  const [editingAttrNameId,    setEditingAttrNameId]    = useState(null)
  const [editingAttrNameValue, setEditingAttrNameValue] = useState('')
  // Captures the displayed name at editing-start so we can short-circuit
  // commitAttrNameEdit when the user opens the inline editor and tabs /
  // blurs out without actually changing the text. Without this guard,
  // every blur fires a draft mutation (`updateAddedAttr` at origin or
  // `renameAttr` at chain anchor) which marks the draft dirty and
  // pops the unsaved-changes bar even though nothing changed.
  const [editingAttrNameOriginal, setEditingAttrNameOriginal] = useState('')

  // Phase 1.22d — Attributes-tab section collapse state. Three sections:
  // attributes / circumstances / motivators. Default expanded.
  const [attrSectionExpanded, setAttrSectionExpanded] = useState({
    attributes: true,
    circumstances: true,
    motivators: true,
  })
  // Phase 1.22d step 2 — dedicated `+ Add Circumstance` form state. Lives
  // alongside the existing `showAddAttr` / `newAttr` for vanilla attributes.
  // Routes through the same `addAttrChange` wrapper so origin and chain-
  // anchor edits flow through the existing draft + Save / Discard
  // machinery unchanged — the form just composes a fully-typed
  // circumstance Attribute and hands it off.
  const [showAddCircumstance, setShowAddCircumstance] = useState(false)
  const emptyCircumstance = () => ({
    id: crypto.randomUUID(),
    attribute_type: 'circumstance',
    name: '',                  // optional for circumstances
    description: '',           // required
    intensity: null,           // unset by default
    value: '',                 // unused for circumstances; kept for shape
    file_ref: null,
    preset_list_id: null,
    preset_list_name: null,
  })
  const [newCircumstance, setNewCircumstance] = useState(emptyCircumstance)
  const [circumstanceError, setCircumstanceError] = useState(null)
  // Phase 1.22d step 3 — dedicated `+ Add Motivator` form. Symmetric
  // to the circumstance form except the name is required (motivators
  // always carry a label such as "Honour the bet"; circumstances may
  // be unnamed because their description is the focal phrase).
  const [showAddMotivator, setShowAddMotivator] = useState(false)
  const emptyMotivator = () => ({
    id: crypto.randomUUID(),
    attribute_type: 'motivator',
    name: '',                  // required for motivators
    description: '',           // required
    intensity: null,           // unset by default
    value: '',
    file_ref: null,
    preset_list_id: null,
    preset_list_name: null,
  })
  const [newMotivator, setNewMotivator] = useState(emptyMotivator)
  const [motivatorError, setMotivatorError] = useState(null)
  // Phase 2.13b — dedicated `+ Add Perspective` form. Structurally
  // similar to the C / M forms (name optional, description required)
  // but with a target picker in place of the intensity slider. No
  // intensity field — perspectives convey strength via their
  // description text (planning doc decision 4). Target picker covers
  // all 7 viable kinds (character / location / item / faction /
  // custom / knowledge / relationship); body of the form lives in the
  // Attributes-tab section render below.
  const [showAddPerspective, setShowAddPerspective] = useState(false)
  const emptyPerspective = () => ({
    id: crypto.randomUUID(),
    attribute_type: 'perspective',
    name: '',                          // optional
    description: '',                   // required
    perspective_target_kind: null,     // set by the target picker
    perspective_target_id: null,       // set by the target picker
    value: '',                         // unused for perspective
    intensity: null,                   // unused for perspective
    file_ref: null,
    preset_list_id: null,
    preset_list_name: null,
  })
  const [newPerspective, setNewPerspective] = useState(emptyPerspective)
  const [perspectiveError, setPerspectiveError] = useState(null)
  // Phase 2.13b — controls visibility of the inline target picker
  // popover inside the perspective add form. Separate from the
  // form-visibility state so the picker can collapse on pick without
  // closing the whole form.
  const [perspectiveTargetPickerOpen, setPerspectiveTargetPickerOpen] = useState(false)
  // Phase 2.13d follow-up — controls visibility of the inline target
  // picker for a SPECIFIC draft +ADD perspective entry (keyed by
  // attribute id). When set, the matching draft's row swaps its
  // compact null-target badge for the full picker; clicking the
  // badge sets this to the attr.id, picking or cancelling resets to
  // null. Only one draft picker can be open at a time — the writer's
  // attention is single-focus anyway.
  const [draftPerspectivePickerOpenId, setDraftPerspectivePickerOpenId] = useState(null)

  // Phase 3.4f Item 7 — host-side TagBadge click-through to the
  // read-only TagPopover host browser. Pure UI state; never reads
  // or writes any chain-tracked value.
  const {
    target: _tagPopoverTarget,
    open: _openTagPopover,
    close: _closeTagPopover,
  } = useTagBrowsePopover()
  // Phase 2.13b — perspective EDIT state. Mirrors the C / M edit
  // machinery (`editingCMAttrId` / `openEditCM` / `confirmEditCM`):
  // clicking a saved perspective's card body enters edit mode for
  // that row; on Save, the diff is routed chain-aware via
  // `setAttrPerspectiveOverride` — mutates the add entry's embedded
  // baseline at the perspective's own origin, writes a `modify`
  // chain entry with new_description / new_perspective_target_*
  // downstream.
  const [editingPerspectiveAttrId, setEditingPerspectiveAttrId] = useState(null)
  const [editingPerspective, setEditingPerspective] = useState({
    description: '', perspective_target_kind: null, perspective_target_id: null,
  })
  const [editingPerspectiveOriginal, setEditingPerspectiveOriginal] = useState({
    description: '', perspective_target_kind: null, perspective_target_id: null,
  })
  const [editingPerspectiveError, setEditingPerspectiveError] = useState(null)
  const [editingPerspectivePickerOpen, setEditingPerspectivePickerOpen] = useState(false)
  function openEditPerspective(attr) {
    setEditingPerspectiveAttrId(attr.id)
    const initial = {
      description: attr.description || '',
      perspective_target_kind: attr.perspective_target_kind ?? null,
      perspective_target_id: attr.perspective_target_id ?? null,
    }
    setEditingPerspective(initial)
    setEditingPerspectiveOriginal(initial)
    setEditingPerspectiveError(null)
    setEditingPerspectivePickerOpen(false)
  }
  function cancelEditPerspective() {
    setEditingPerspectiveAttrId(null)
    setEditingPerspectiveError(null)
    setEditingPerspectivePickerOpen(false)
  }
  function confirmEditPerspective() {
    if (!editingPerspectiveAttrId) return
    const newDesc = (editingPerspective.description || '').trim()
    const newKind = editingPerspective.perspective_target_kind ?? null
    const newId   = editingPerspective.perspective_target_id ?? null
    const origDesc = (editingPerspectiveOriginal.description || '').trim()
    const origKind = editingPerspectiveOriginal.perspective_target_kind ?? null
    const origId   = editingPerspectiveOriginal.perspective_target_id ?? null
    // Validation: a perspective always needs a target AND a
    // description. Pre-existing orphaned-target perspectives (kind/id
    // null from the cascade) can be re-targeted in this edit form,
    // but the user cannot Save while it's still target-less.
    if (!newId || !newKind) { setEditingPerspectiveError('noTarget'); return }
    if (!newDesc) { setEditingPerspectiveError('noDescription'); return }
    const patch = {}
    if (newDesc !== origDesc) patch.description = newDesc
    if (newKind !== origKind) patch.perspective_target_kind = newKind
    if (newId   !== origId)   patch.perspective_target_id   = newId
    if (Object.keys(patch).length > 0) {
      setAttrPerspectiveOverride(editingPerspectiveAttrId, patch)
    }
    setEditingPerspectiveAttrId(null)
    setEditingPerspectiveError(null)
    setEditingPerspectivePickerOpen(false)
  }
  // Phase 1.22h — temporary circumstance / motivator form state.
  // Temporaries are scene-scoped; storage is on Scene.entity_temporary_circumstances,
  // not on the entity's chain. Only meaningful at chain anchors (chip /
  // modifier mode); origin doesn't have a scene scope so the buttons
  // are hidden there.
  const emptyTempCM = (attribute_type) => ({
    name: '',
    description: '',
    intensity: null,
    attribute_type,
  })
  const [showAddTempCircumstance, setShowAddTempCircumstance] = useState(false)
  const [newTempCircumstance, setNewTempCircumstance] = useState(() => emptyTempCM('circumstance'))
  const [tempCircumstanceError, setTempCircumstanceError] = useState(null)
  const [showAddTempMotivator, setShowAddTempMotivator] = useState(false)
  const [newTempMotivator, setNewTempMotivator] = useState(() => emptyTempCM('motivator'))
  const [tempMotivatorError, setTempMotivatorError] = useState(null)
  // Edit-in-place state for an existing temporary entry. One slot
  // because only one row is in edit mode at a time.
  const [editingTempId, setEditingTempId] = useState(null)
  const [editingTemp, setEditingTemp] = useState({ name: '', description: '', intensity: null, attribute_type: 'circumstance' })
  const [editingTempError, setEditingTempError] = useState(null)
  function openEditTemp(entry) {
    setEditingTempId(entry.id)
    setEditingTemp({
      name: entry.name || '',
      description: entry.description || '',
      intensity: entry.intensity ?? null,
      attribute_type: entry.attribute_type,
    })
    setEditingTempError(null)
  }
  function cancelEditTemp() {
    setEditingTempId(null)
    setEditingTempError(null)
  }
  function confirmEditTemp() {
    if (!editingTempId) return
    updateEntityTemporaryCM(nodeId, editingTempId, {
      name: (editingTemp.name || '').trim() || null,
      description: (editingTemp.description || '').trim(),
      intensity: editingTemp.intensity ?? null,
    })
    setEditingTempId(null)
    setEditingTempError(null)
  }
  function confirmAddTempCircumstance() {
    addEntityTemporaryCM(nodeId, entityId, {
      attribute_type: 'circumstance',
      name: (newTempCircumstance.name || '').trim() || null,
      description: (newTempCircumstance.description || '').trim(),
      intensity: newTempCircumstance.intensity ?? null,
    })
    setShowAddTempCircumstance(false)
    setNewTempCircumstance(emptyTempCM('circumstance'))
    setTempCircumstanceError(null)
  }
  function confirmAddTempMotivator() {
    addEntityTemporaryCM(nodeId, entityId, {
      attribute_type: 'motivator',
      name: (newTempMotivator.name || '').trim() || null,
      description: (newTempMotivator.description || '').trim(),
      intensity: newTempMotivator.intensity ?? null,
    })
    setShowAddTempMotivator(false)
    setNewTempMotivator(emptyTempCM('motivator'))
    setTempMotivatorError(null)
  }
  async function handleRemoveTemp(entry) {
    const typeLabel = entry.attribute_type === 'motivator' ? 'Temporary Motivator' : 'Temporary Circumstance'
    const result = await confirm({
      title: `Remove ${typeLabel}`,
      message: `Remove ${typeLabel.toLowerCase()} "${entry.name || entry.description || '(unnamed)'}" from this scene?`,
      buttons: [
        { label: 'Remove', value: 'remove', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result === 'remove') removeEntityTemporaryCM(nodeId, entry.id)
  }
  function handleConvertTempToOngoing(entry) {
    convertEntityTemporaryToOngoing(nodeId, entry.id)
  }
  // Phase 1.22d edit affordance — track which existing C/M row is in
  // edit mode (if any) and its in-progress draft. The form component
  // is the same one used for + Add. On Confirm, we route through
  // `setAttrCMOverride(attrId, patch)` which is chain-aware: mutates
  // the `add` entry's embedded attribute when one exists for this
  // attrId in draft (origin or added-here), otherwise writes a
  // `modify` chain entry with `new_*` per-field overrides at the
  // current anchor. Re-edits at the same anchor replace the existing
  // modify entry in place rather than appending — see the helper for
  // the at-most-one-per-(attr, anchor) invariant.
  const [editingCMAttrId, setEditingCMAttrId] = useState(null)
  const [editingCM, setEditingCM] = useState({ name: '', description: '', intensity: null })
  // Captures the chain-resolved values at edit-start so confirmEditCM
  // can diff against them and only emit changes for fields the user
  // actually modified — without this, every Save wrote new_name /
  // new_description / new_intensity unconditionally, producing
  // spurious ~MODIFIED indicators (and NULL → NULL change chips) for
  // fields the user never touched.
  const [editingCMOriginal, setEditingCMOriginal] = useState({ name: '', description: '', intensity: null })
  const [editingCMError, setEditingCMError] = useState(null)

  // Phase 1.26 — Drag-to-reorder for circumstance / motivator sub-chip
  // rows in the Attributes tab's C / M sections. The order is persisted
  // on the active anchor's node (`cm_chip_order` field on SceneNode for
  // chip mode, on EntityNode for modifier / origin mode), keyed by
  // (entity_id, kind). The synchronous ref lets the very first
  // `dragover` after `dragstart` call `preventDefault()` before
  // React's state-update propagates — without it the browser would
  // sometimes refuse the first drop attempt. The state mirror exists
  // only for visual feedback (dragged-row dim + drop-target highlight).
  const draggedAttrCMRef = useRef(null)                     // {kind, id} | null
  const [draggedAttrCM, setDraggedAttrCM] = useState(null)
  const [dragOverAttrCM, setDragOverAttrCM] = useState(null)
  const startAttrCMDrag = useCallback((kind, id, e) => {
    e.stopPropagation()
    const payload = { kind, id }
    draggedAttrCMRef.current = payload
    setDraggedAttrCM(payload)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/nnz-cm-subchip-id', id)
  }, [])
  const overAttrCMRow = useCallback((kind, id, e) => {
    const src = draggedAttrCMRef.current
    if (!src || src.kind !== kind) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverAttrCM((prev) => {
      if (prev && prev.kind === kind && prev.id === id) return prev
      return { kind, id }
    })
  }, [])
  const dropOnAttrCMRow = useCallback((kind, targetId, currentOrderedIds, e) => {
    const src = draggedAttrCMRef.current
    const cleanup = () => {
      draggedAttrCMRef.current = null
      setDraggedAttrCM(null)
      setDragOverAttrCM(null)
    }
    if (!src || src.kind !== kind) { cleanup(); return }
    e.preventDefault()
    e.stopPropagation()
    const fromIdx = currentOrderedIds.indexOf(src.id)
    if (fromIdx === -1) { cleanup(); return }
    const newOrder = [...currentOrderedIds]
    newOrder.splice(fromIdx, 1)
    if (targetId === '__end__') {
      newOrder.push(src.id)
    } else if (targetId !== src.id) {
      const toIdx = currentOrderedIds.indexOf(targetId)
      if (toIdx === -1) { cleanup(); return }
      const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx
      newOrder.splice(insertIdx, 0, src.id)
    } else {
      cleanup(); return
    }
    if (nodeId && entityId) reorderEntityCMs(nodeId, entityId, kind, newOrder)
    cleanup()
  }, [reorderEntityCMs, nodeId, entityId])
  const endAttrCMDrag = useCallback(() => {
    draggedAttrCMRef.current = null
    setDraggedAttrCM(null)
    setDragOverAttrCM(null)
  }, [])
  function openEditCM(attr) {
    setEditingCMAttrId(attr.id)
    // Initialize from the chain-resolved values at this anchor — the
    // `attr` passed in IS the chain-resolved attribute the row is
    // already rendering (when called from the effective-rows render
    // branch) OR the embedded attribute on the in-progress draft `add`
    // entry (when called from the +ADD entries render branch). Both
    // are chain-aware reads at the active anchor.
    const initial = {
      name: attr.name || '',
      description: attr.description || '',
      intensity: attr.intensity ?? null,
    }
    setEditingCM(initial)
    setEditingCMOriginal(initial)
    setEditingCMError(null)
  }
  function cancelEditCM() {
    setEditingCMAttrId(null)
    setEditingCMError(null)
  }
  function confirmEditCM() {
    if (!editingCMAttrId) return
    const newName = (editingCM.name || '').trim()
    const newDesc = (editingCM.description || '').trim()
    const newInt  = editingCM.intensity ?? null
    const origName = (editingCMOriginal.name || '').trim()
    const origDesc = (editingCMOriginal.description || '').trim()
    const origInt  = editingCMOriginal.intensity ?? null
    // Validation — preserve the at-least-one-of-name-or-description
    // rule against the post-edit effective values.
    const effName = newName
    const effDesc = newDesc
    if (!effName && !effDesc) {
      setEditingCMError('both')
      return
    }
    // Diff: include only fields the user actually changed. Empty patch
    // is a no-op (closes the form, no draft mutation).
    const patch = {}
    if (newName !== origName) patch.name        = newName
    if (newDesc !== origDesc) patch.description = newDesc
    if (newInt  !== origInt)  patch.intensity   = newInt
    if (Object.keys(patch).length > 0) {
      setAttrCMOverride(editingCMAttrId, patch)
    }
    setEditingCMAttrId(null)
    setEditingCMError(null)
  }

  // ── Media attribute Replace: hidden file input + per-attribute state ───────
  const mediaReplaceInputRef = useRef(null)
  const [mediaReplaceTargetId, setMediaReplaceTargetId] = useState(null)
  const [mediaReplaceUploading, setMediaReplaceUploading] = useState(null)
  const setupColourAnchorRef = useRef(null)
  const [setupColourPickerOpen, setSetupColourPickerOpen] = useState(false)

  const chain = useMemo(
    () => (entity ? getEntityNarrativeChain(entityId, nodes, edges) : []),
    [entityId, nodes, edges, entity]
  )

  // Modifier nodes resolve their chainIndex by lookup (the dispatcher may not
  // pass a known chainIndex). Chip / origin always trust the ui-store value.
  // Resolve current + prior chain-resolved state at the active anchor
  // in one helper call. `computeEffectiveStateWithPrior` handles the
  // sub-chain backward walk for both views and unifies the "no prior"
  // fallback through the entity's origin EntityNode — see its
  // docstring in narrativeChain.js for full context.
  //
  // The origin path is special-cased here: when `isOrigin`, the panel
  // is editing the entity's baseline directly, so `effectiveState`
  // surfaces baseline fields with an EMPTY attributes list (the panel
  // separately renders attribute-add draft rows for origin) and
  // `priorEffectiveState` is also empty (no prior to diff against —
  // origin IS the entity's first chain stop). This is the chain-aware
  // path for the entity-at-origin case per the same per-object
  // exemption the chain-aware check describes.
  const { effectiveState, priorEffectiveState } = useMemo(() => {
    if (!entity) return { effectiveState: null, priorEffectiveState: null }
    if (isOrigin) {
      return {
        effectiveState: {
          name:              entity.name              || '',
          colour:            entity.colour            || '#888888',
          description:       entity.description       || '',
          profile_image_ref: entity.profile_image_ref || null,
          attributes:  [],
        },
        priorEffectiveState: {
          name: '', colour: '#888888', description: '',
          attributes: [],
        },
      }
    }
    const { current, prior } = computeEffectiveStateWithPrior(entity, nodes, edges, nodeId)
    return { effectiveState: current, priorEffectiveState: prior }
  }, [entity, nodes, edges, nodeId, isOrigin])

  // Anchor-mode change-source adapter:
  //   chip     → EntityRef bucket entry on the scene's scene node
  //   modifier → modifier node's `data` block
  //   origin   → no per-node change record; treat as null
  const entityNode = isModifier ? nodes.find((n) => n.id === nodeId) : null
  const nodeData   = isModifier ? (entityNode?.data || {}) : null
  const entityRef = useMemo(
    () => isChip ? getEntityRefAtNode(nodeId, entityId, nodes) : null,
    [isChip, nodeId, entityId, nodes]
  )
  // Single read-source for saved change records — branched by anchor kind
  const savedChangeSource = isOrigin ? null : (isModifier ? nodeData : entityRef)

  const currentNode = nodes.find((n) => n.id === nodeId)

  // Chapter label for the nav bar subtitle. Origin view has no scene context.
  const chapterLabel = useMemo(() => {
    if (isOrigin) return null
    if (!storyChapters || storyChapters.length === 0) return null
    if (!currentNode) return null
    const chapterId = resolveChapterIdForNode(currentNode, storyChapters, chapterMemberOpts)
    if (!chapterId) return null
    const idx = storyChapters.findIndex((c) => c.id === chapterId)
    if (idx < 0) return null
    const c = storyChapters[idx]
    return c.title || `Chapter ${idx + 1}`
  }, [isOrigin, currentNode, storyChapters, chapterMemberOpts])

  // Node-order for relationship-state queries (used by the awareness/rel-history
  // chip set in the Details tab and by the Relationships tab).
  const nodeOrder = useMemo(() => chain.map((n) => n.id), [chain])

  // ── Change sub-chips ─────────────────────────────────────────────────────────
  const changeSubChips = useMemo(() => {
    if (!entity) return []
    if (isOrigin) {
      const chips = []
      const trunc = (s, n = 22) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''))
      for (const attr of (entity.attributes || [])) {
        const chip = { action: 'add', field: attr.name, newValue: trunc(attr.value), attributeId: attr.id }
        const extraStyle = getOvumRedAttributeStyle(entity, attr.name, attr.value)
        if (extraStyle) chip.valueStyle = extraStyle
        if (attr.attribute_type === 'file') {
          chip.isFileAttribute = true
          chip.newFileRef = attr.file_ref || null
        }
        if (attr.attribute_type === 'text_list' || attr.attribute_type === 'entity_list') {
          chip.isListAttribute = true
          chip.isTextList   = attr.attribute_type === 'text_list'
          chip.isEntityList = attr.attribute_type === 'entity_list'
          let list = []
          try { list = JSON.parse(attr.value || '[]') } catch { /* noop */ }
          if (!Array.isArray(list)) list = []
          chip.initialList = list
        }
        // A perspective attribute at the entity's origin must render via
        // PerspectiveSubChip (target badge + description), not the generic
        // value chip: perspectives store their content on `description` +
        // `perspective_target_*`, not `value`, so without this they show
        // as an empty generic chip. Mirror the chain-walker add-chip shape
        // (computeChangeSubChips in narrativeChain.js) so origin and
        // downstream chain points present perspectives identically.
        // Reading the baseline attribute is the chain-aware path at origin.
        if (attr.attribute_type === 'perspective') {
          chip.isPerspective = true
          chip.description = attr.description || ''
          chip.perspectiveTargetKind = attr.perspective_target_kind ?? null
          chip.perspectiveTargetId   = attr.perspective_target_id ?? null
        }
        chips.push(chip)
      }
      return chips
    }
    if (!savedChangeSource || !priorEffectiveState) return []
    // For the alias sub-chip specifically, override the draft's
    // alias-change fields with the saved ref's values so the chip
    // only reflects what's actually persisted — matching the
    // scene-node entity chip's "only after confirm" behaviour. The
    // editor itself already shows the pending add/remove in its
    // tag display; a previewed sub-chip below it would duplicate
    // the cue AND visually desync from the scene node. Other
    // fields (name, colour, description, etc.) continue to preview
    // their draft state for in-editor feedback.
    const sourceForChips = isDirty
      ? {
          ...draft,
          alias_changes: savedChangeSource?.alias_changes || [],
        }
      : savedChangeSource
    return computeChangeSubChips(sourceForChips, priorEffectiveState, entity, allEntities)
  }, [isOrigin, entity, savedChangeSource, isDirty, draft, priorEffectiveState, allEntities])

  // ── Location hierarchy (origin only) ────────────────────────────────────────
  const locationParentPath = []
  const locationChildren   = []
  if (isOrigin && entity?.type === 'location') {
    let cur = entity
    const visited = new Set()
    while (cur?.parent_id && !visited.has(cur.parent_id)) {
      visited.add(cur.parent_id)
      const parent = entLocations.find((l) => l.id === cur.parent_id)
      if (!parent) break
      locationParentPath.unshift(parent)
      cur = parent
    }
    locationChildren.push(...entLocations.filter((l) => l.parent_id === entity.id))
  }

  // Navigation guard + draft-reset on subject change are owned by
  // `useDetailPanelDraft` (above). The hook registers the guard when
  // `isDirty` is true and clears the slot when `draftKey` changes.

  // View-local "Add attribute" form should still close when the
  // subject changes (the form's transient open state is per-view, not
  // part of the draft slot).
  useEffect(() => {
    setShowAddAttr(false)
  }, [nodeId, entityId])

  // ── Navigation hooks declared BEFORE early returns ──────────────────────────
  // The Rules of Hooks require unconditional declaration order. The
  // `_navRef.current = {...}` assignment below is a property write
  // (not a hook), so it can live after the early returns; the keyboard
  // listener reads `_navRef.current` at event time and tolerates the
  // null shape pre-assignment.
  const _navRef = useRef(null)
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp') return
      const el = document.activeElement
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      if (e.target?.closest?.('[data-dot-key]')) return
      const nav = _navRef.current
      if (!nav) return
      if (e.key === 'ArrowLeft'  && nav.canBack)    { e.preventDefault(); nav.goBack() }
      if (e.key === 'ArrowRight' && nav.canForward) { e.preventDefault(); nav.goForward() }
      if (e.key === 'ArrowUp'    && nav.canUp)      { e.preventDefault(); nav.goUp() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])  

  // ── Navigation hooks (must run before the early-return guards below
  // so the hook-call count stays stable when `entity` transiently goes
  // null — e.g. immediately after a `newProject()` that clears the
  // library while this panel is still mounted). Non-hook derived
  // locals + function declarations stay below the guards. ────────────
  // Phase 1.26 — POV-only nav toggle. When ON, filter the entity's chain
  // to: the chain's origin (chain[0] — the entity's origin EntityNode)
  // PLUS scene chips at scenes that lie on the POV chain. Modifier nodes
  // are dropped. When OFF (default), full entity chain is used.
  const povNavOnly    = useUiStore((s) => s.povNavOnly)
  const setPovNavOnly = useUiStore((s) => s.setPovNavOnly)
  const povColor      = usePovColor()

  const { effectiveChain, hasAnyPov, povSet } = useMemo(() => {
    const povChain = computePovChain(nodes, edges)
    const povSetLocal = new Set(povChain.sequence.map((s) => s.nodeId))
    if (!povNavOnly || povSetLocal.size === 0 || chain.length === 0) {
      return { effectiveChain: chain, hasAnyPov: povSetLocal.size > 0, povSet: povSetLocal }
    }
    // Filter when ON: keep chain[0] (entity origin) + sceneNode stops in POV.
    const filtered = chain.filter((n, i) => {
      if (i === 0) return true            // origin always kept
      if (n.type !== 'sceneNode') return false  // drop modifier / non-scene
      return povSetLocal.has(n.id)
    })
    return { effectiveChain: filtered, hasAnyPov: true, povSet: povSetLocal }
  }, [nodes, edges, chain, povNavOnly])

  // Auto-flip the POV toggle OFF when the writer navigates to a chain
  // stop that's NOT in the filtered set (e.g. clicked a modifier node
  // on canvas while toggle was on). The ref guards against firing on
  // toggle-on clicks from a non-eligible stop — those route through
  // `handlePovToggle` below, which jumps to the entity's origin first.
  const _prevEntityNavNodeIdRef = useRef(nodeId)
  useEffect(() => {
    const navigatedAway = _prevEntityNavNodeIdRef.current !== nodeId
    _prevEntityNavNodeIdRef.current = nodeId
    if (!povNavOnly || !hasAnyPov || !nodeId) return
    const inSet = effectiveChain.some((n) => n.id === nodeId)
    if (navigatedAway && !inSet) setPovNavOnly(false)
  }, [povNavOnly, nodeId, hasAnyPov, effectiveChain, setPovNavOnly])

  // ── Navigation (non-hook derived locals + function declarations) ────────────
  // Resolve current index against the (possibly-filtered) chain.
  const resolvedNavIdx = effectiveChain.findIndex((n) => n.id === nodeId)
  const navIdx     = resolvedNavIdx
  const canBack    = navIdx > 0
  const canForward = navIdx >= 0 && navIdx < effectiveChain.length - 1

  function goBack()    { if (canBack)    navigateToChainStop(setDetailPanel, effectiveChain[navIdx - 1], entityId, navIdx - 1) }
  function goForward() { if (canForward) navigateToChainStop(setDetailPanel, effectiveChain[navIdx + 1], entityId, navIdx + 1) }
  function goUp()      { setDetailPanel('scene', nodeId) }

  function handlePovToggle() {
    if (!hasAnyPov) return
    if (!povNavOnly) {
      // Turning ON. If the current node isn't going to be in the filtered
      // chain, jump to the entity's origin (always allowed when toggle is
      // on) before flipping the toggle so the auto-flip-off effect doesn't
      // fire on the next render.
      const willBeInSet = nodeId && (
        chain[0]?.id === nodeId ||
        (chain.find((n) => n.id === nodeId)?.type === 'sceneNode' && povSet.has(nodeId))
      )
      if (!willBeInSet && chain[0]) {
        navigateToChainStop(setDetailPanel, chain[0], entityId, 0)
      }
    }
    setPovNavOnly(!povNavOnly)
  }

  // Modifier mode does NOT support ArrowUp navigation (no parent scene to ascend to).
  _navRef.current = { canBack, canForward, canUp: isChip, goBack, goForward, goUp }

  // ── Draft helpers (shared via makeChangesDraftHelpers) ───────────────────────
  function initDraft() {
    if (isOrigin) {
      return {
        name:              entity?.name              || '',
        colour:            entity?.colour            || '#888888',
        description:       entity?.description       || '',
        profile_image_ref: entity?.profile_image_ref ?? null,
        aliases:           [...(entity?.aliases || [])],
        tag_ids:           [...(entity?.tag_ids || [])],
        attribute_changes: (entity?.attributes || []).map((a) => ({
          action: 'add', attribute_id: a.id, attribute: { ...a },
        })),
      }
    }
    const src = savedChangeSource || {}
    return {
      name_change:          src.name_change          ?? null,
      colour_change:        src.colour_change        ?? null,
      description_change:   src.description_change   ?? null,
      profile_image_change: src.profile_image_change ?? null,
      alias_changes:        [...(src.alias_changes        || [])],
      tag_changes:          [...(src.tag_changes          || [])],
      attribute_changes:    [...(src.attribute_changes    || [])],
    }
  }

  // Active change arrays — draft when dirty, savedChangeSource when clean
  const draftAttrChanges = isDirty ? draft.attribute_changes
    : isOrigin ? (entity?.attributes || []).map((a) => ({ action: 'add', attribute_id: a.id, attribute: { ...a } }))
    : (savedChangeSource?.attribute_changes || [])

  const draftIsClean = isOrigin
    ? (d) => !d || JSON.stringify(d) === JSON.stringify(initDraft())
    : (d) => changesDraftIsClean(d, initDraft)
  const {
    updateDraftOverride,
    setAttrOverride, setAttrFileRefOverride, setAttrNumberOverride, setAttrCMOverride, setAttrPerspectiveOverride, addListItem, removeListItem, clearAttrOverride, addAttrChange: addAttrChangeRaw, removeAttrChange, undoAttrRemove, revokeAttrAdd,
    renameAttr, clearAttrRename,
  } = makeChangesDraftHelpers(setDraft, initDraft, draftIsClean, entityId)

  // ── Phase 4.2 — attribute reorder ────────────────────────────────
  // `attribute_order` is a single shared per-entity display preference
  // (NOT chain-tracked — see entitiesStore.reorderEntityAttributes).
  // The Attributes-section rows the user sees at any anchor come from
  // two render regions: the effective-state main map (saved attrs
  // present at this position) and the draft-add block (origin's full
  // baseline list, or downstream pending adds). Both are ordered by
  // attribute_order and share ONE drag index space — effective rows
  // occupy 0.._effAttrCount-1, draft-add rows occupy the range after —
  // so a single grip-handle reorder works across both. onCommit writes
  // the one shared baseline list, merging in any order ids not visible
  // at this anchor (removed here, or added at a later scene) so the
  // shared order still carries them.
  const _attrOrder = entity?.attribute_order || null
  const isAttrSectionType = (t) => t !== 'circumstance' && t !== 'motivator' && t !== 'perspective'
  const orderedEffectiveSectionAttrs = useMemo(
    () => applyAttributeOrder(
      (effectiveState?.attributes || []).filter((a) => isAttrSectionType(a.attribute_type)),
      _attrOrder,
    ),
    [effectiveState, _attrOrder],
  )
  const orderedAddSectionAcs = useMemo(
    () => applyAttributeOrder(
      (draftAttrChanges || []).filter((ac) => ac.action === 'add' && ac.attribute && !ac.pending_remove
        && !(effectiveState?.attributes || []).some((a) => a.id === ac.attribute.id)
        && isAttrSectionType(ac.attribute.attribute_type)),
      _attrOrder,
      (ac) => ac.attribute.id,
    ),
    [draftAttrChanges, effectiveState, _attrOrder],
  )
  const _effAttrCount = orderedEffectiveSectionAttrs.length
  const _attrReorderTotal = _effAttrCount + orderedAddSectionAcs.length

  function commitAttributeReorder(srcIdx, dstIdx) {
    const combinedIds = [
      ...orderedEffectiveSectionAttrs.map((a) => a.id),
      ...orderedAddSectionAcs.map((ac) => ac.attribute.id),
    ]
    if (srcIdx < 0 || srcIdx >= combinedIds.length) return
    const next = [...combinedIds]
    const [moved] = next.splice(srcIdx, 1)
    let insertAt = dstIdx >= combinedIds.length ? next.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
    if (insertAt < 0) insertAt = 0
    if (insertAt > next.length) insertAt = next.length
    next.splice(insertAt, 0, moved)
    // Keep any existing order ids not visible at this anchor, in their
    // old relative order, appended after the visible sequence.
    const visibleSet = new Set(combinedIds)
    const leftovers = (entity?.attribute_order || []).filter((id) => !visibleSet.has(id))
    reorderEntityAttributes(entityId, [...next, ...leftovers])
  }

  const attrReorder = useLibraryReorder({
    total: _attrReorderTotal,
    onCommit: commitAttributeReorder,
  })

  // Render guards: these MUST come after every Hook above (Rules of Hooks).
  // The reorder / draft computations between the Hooks above and here are
  // null-safe (optional chaining; reorder fns only run on user action), so
  // they run harmlessly in the cases these guards bail out of.
  if (isModifier && entityNode?.data?.is_modifier && !entityId) {
    return <div className="p-3 text-xs text-zinc-500 italic">Wire an entity to this node to configure it.</div>
  }
  if (!entity || !effectiveState || !priorEffectiveState) {
    return <div className="p-3 text-xs text-zinc-600 italic">Entity not found.</div>
  }
  if (isChip && (!entityRef || !currentNode)) {
    return <div className="p-3 text-xs text-zinc-600 italic">Entity not found at this node.</div>
  }
  if (isModifier && !entityNode) {
    return <div className="p-3 text-xs text-zinc-600 italic">Entity node not found.</div>
  }

  function commitAttrNameEdit(attrId) {
    const trimmed = editingAttrNameValue.trim()
    // No-op short-circuit: if the user opened the editor and blurred /
    // pressed Enter without changing the text, don't fire any draft
    // mutation. Without this, every blur unconditionally wrote through
    // the same code path, marking the draft dirty even though nothing
    // was changed and popping the unsaved-changes bar spuriously.
    // `editingAttrNameOriginal` was captured at edit-start from
    // `displayAttrName`, the chain-resolved displayed name at the
    // active anchor — so the comparison is chain-aware, not baseline.
    if (trimmed === (editingAttrNameOriginal || '').trim()) {
      setEditingAttrNameId(null)
      return
    }
    if (trimmed) {
      if (isOrigin) {
        updateAddedAttr(attrId, { name: trimmed })
      } else {
        renameAttr(attrId, trimmed)
      }
    }
    setEditingAttrNameId(null)
  }

  async function dismissChangeChip(chip) {
    // Origin attribute removal — fires the immediate baseline-delete
    // action with a confirm prompt (same UX as the chain-anchor path:
    // sub-chip × removes immediately, no draft commit needed). Chain-
    // anchor and modifier paths continue to use the draft mutation
    // pattern so save can run the diff + Knowledge cascade.
    if (isOrigin && chip.attributeId) {
      const result = await confirm({
        title: 'Delete attribute',
        message: `Delete "${chip.field}" from this entity? Any downstream changes to this attribute will also be removed.`,
        buttons: [
          { label: 'Delete', value: 'delete', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'neutral' },
        ],
      })
      if (result === 'delete') useProjectStore.getState().removeBaselineAttribute(entityId, chip.attributeId)
      return
    }
    setDraft((d) => {
      const base = d ?? initDraft()
      if (chip.isProfileImage) return { ...base, profile_image_change: null }
      if (chip.attributeId) {
        // `add` entries carry the attribute id on `ac.attribute.id`; modify
        // / remove / list_* / rename entries carry it on `ac.attribute_id`.
        // Match either shape so dismiss works for add chips too (mirrors
        // the fix in clearEntityRefChange).
        const matchesChip = (ac) =>
          (ac?.action === 'add' ? ac.attribute?.id === chip.attributeId : ac.attribute_id === chip.attributeId)
        return { ...base, attribute_changes: (base.attribute_changes || []).filter((ac) => !matchesChip(ac)) }
      }
      if (chip.field === 'Aliases') {
        return { ...base, alias_changes: [] }
      }
      const KEY = { Name: 'name_change', Colour: 'colour_change', Description: 'description_change' }
      const key = KEY[chip.field]
      return key ? { ...base, [key]: null } : base
    })
  }

  // Wrap addAttrChange to also reset the add-attribute form state
  function addAttrChange(attr) {
    addAttrChangeRaw(attr)
    setShowAddAttr(false)
    setNewAttr(emptyAttr())
    setShowAddCircumstance(false)
    setNewCircumstance(emptyCircumstance())
    setCircumstanceError(null)
    setShowAddMotivator(false)
    setNewMotivator(emptyMotivator())
    setMotivatorError(null)
  }

  // ── Origin / Modifier: update +ADDED attribute value/name inline ─────────────
  function updateAddedAttr(attrId, patch) {
    setDraft((d) => {
      const base = d ?? initDraft()
      return {
        ...base,
        attribute_changes: base.attribute_changes.map((ac) =>
          ac.action === 'add' && ac.attribute?.id === attrId
            ? { ...ac, attribute: { ...ac.attribute, ...patch } }
            : ac
        ),
      }
    })
  }

  // ── Mid-chain media Replace: open picker → upload → draft override ─────────
  function handleMediaReplaceClick(attrId) {
    setMediaReplaceTargetId(attrId)
    setTimeout(() => mediaReplaceInputRef.current?.click(), 0)
  }

  function navigateToReferencedEntity(refEntityId, subTab = 'details') {
    if (!refEntityId) return
    const originNode = nodes.find(
      (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === refEntityId
    )
    if (originNode) {
      setDetailPanel('entityNode', originNode.id, refEntityId, 0, subTab)
    }
  }

  async function handleMediaReplaceFileChosen(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const targetId = mediaReplaceTargetId
    if (!file || !targetId) return
    setMediaReplaceUploading(targetId)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await axios.post('/api/project/assets/upload', formData)
      const newFileRef = res.data.file_ref
      if (newFileRef) {
        setAttrFileRefOverride(targetId, newFileRef)
        const ps = usePreviewStore.getState()
        const exp = ps.expanded
        if (exp?.source?.type === 'attribute' && exp.source.entityId === entityId && exp.source.attributeId === targetId) {
          ps.replaceExpandedSource({ ...exp.source, fileRef: newFileRef })
        }
      }
    } catch (err) {
      console.error('Sidebar media replace upload failed:', err)
    } finally {
      setMediaReplaceUploading(null)
      setMediaReplaceTargetId(null)
    }
  }

  // ── Save / Discard ──────────────────────────────────────────────────────────
  async function handleSave() {
    if (!draft) return

    if (isOrigin) {
      const savedAttrs = draft.attribute_changes
        .filter((ac) => ac.action === 'add' && ac.attribute && !ac.pending_remove)
        .map((ac) => ac.attribute)

      const oldEntity = { ...entity }

      const savedAttrIds = new Set(savedAttrs.map((a) => a.id))
      const deletedAttrIds = new Set(
        (entity.attributes || []).filter((a) => !savedAttrIds.has(a.id)).map((a) => a.id)
      )

      const newEntityData = {
        ...entity,
        name:              draft.name,
        colour:            draft.colour,
        description:       draft.description,
        profile_image_ref: draft.profile_image_ref,
        aliases:           draft.aliases || [],
        tag_ids:           draft.tag_ids || [],
        attributes:        savedAttrs,
      }

      // Snapshot the pre-edit entity into history so undo can restore
      // it via `_restoreEntityData`. Without this, origin entity edits
      // were silently non-undoable (the snapshot taken inside
      // `flagDownstreamAfterOriginEdit` only captures `nodes`, not the
      // entity bucket).
      const entityBucket = oldEntity?.type ? `${oldEntity.type}s` : null
      const projectStore = useProjectStore.getState()
      if (entityBucket) {
        projectStore._snapshot({ _entityDataRestore: [{ ...oldEntity, _bucket: entityBucket }] })
      } else {
        projectStore._snapshot()
      }

      await updateEntity(entityId, newEntityData)

      if (deletedAttrIds.size > 0) cascadeDropAttributeChanges(deletedAttrIds)

      flagDownstreamAfterOrigin(entityId, oldEntity, newEntityData)

      // Patch the just-pushed history entry with post-mutation entity
      // state so redo can re-apply via `_restoreEntityData`.
      if (entityBucket) {
        projectStore._patchLastHistoryWithExtras({ _entityDataAfter: [{ ...newEntityData, _bucket: entityBucket }] })
      }

      setDraft(null)
      return
    }

    if (isModifier) {
      saveModifierNodeDraft(nodeId, entityId, draft)
      setDraft(null)
      return
    }

    saveEntityChipDraft(nodeId, entityId, draft)
    setDraft(null)
  }

  function handleDiscard() {
    setDraft(null)
    setShowAddAttr(false)
  }

  const profileRef = effectiveState.profile_image_ref
  const displayedImageRef = isDirty
    ? (isOrigin ? draft.profile_image_ref : (draft.profile_image_change ?? profileRef))
    : profileRef

  // Header context badge per anchor mode
  const navContextBadge = isOrigin ? (
    <span className="text-[9px] text-green-400 uppercase tracking-widest font-semibold bg-green-900/30 px-1.5 py-0.5 rounded">
      NEW : {entity?.type?.toUpperCase() || 'ENTITY'}
    </span>
  ) : isModifier ? (
    <span className="text-[9px] text-amber-400 uppercase tracking-widest font-semibold bg-amber-900/30 px-1.5 py-0.5 rounded">
      MODIFIER : {entity?.type?.toUpperCase() || 'ENTITY'}
    </span>
  ) : (
    <button onClick={goUp} className="flex items-center min-w-0 text-left hover:opacity-80" title="Go to parent scene">
      <span className="flex items-center gap-1 bg-purple-900/30 px-1.5 py-0.5 rounded min-w-0">
        <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold flex-shrink-0">SCENE</span>
        <span className="text-[9px] text-zinc-100 uppercase tracking-widest font-semibold truncate">: {currentNode?.data?.title || 'Scene'}</span>
      </span>
    </button>
  )

  return (
    <>
    <DetailPanelShell
      navBar={(
      <DetailPanelNavBar
        contextBadge={navContextBadge}
        chapterLabel={chapterLabel}
        canUp={isChip}
        onUp={isChip ? goUp : null}
        upTitle={isChip ? 'Go to parent scene' : undefined}
        canBack={canBack}
        onBack={goBack}
        onFirst={() => { if (canBack) navigateToChainStop(setDetailPanel, effectiveChain[0], entityId, 0) }}
        canForward={canForward}
        onForward={goForward}
        onLast={() => { if (canForward) navigateToChainStop(setDetailPanel, effectiveChain[effectiveChain.length - 1], entityId, effectiveChain.length - 1) }}
        position={navIdx >= 0 ? `${navIdx + 1} / ${effectiveChain.length}` : '—'}
        onFocus={() => focusNode?.(nodeId)}
        leftSlot={(
          <PovNavToggleButton
            hasAnyPov={hasAnyPov}
            povNavOnly={povNavOnly}
            onToggle={handlePovToggle}
            povColor={povColor}
          />
        )}
        cornerSlot={entity ? (
          <ShowInTocButton
            type="entity"
            id={entity.id}
            accentColour={effectiveState?.colour || entity.colour || '#71717a'}
            typeLabel={entity.type === 'custom' ? 'custom entity' : entity.type}
            size="sm"
          />
        ) : null}
      />
      )}
      header={(() => {
        // At a chain anchor with a dirty draft, the displayed name must
        // come from the DRAFT's effective state, not the saved
        // effectiveState. If the user has just typed back the inherited
        // value (draft.name_change === null), the draft effectively has
        // no override at this node and the displayed name should be
        // priorEffectiveState.name (the inherited value from upstream),
        // not effectiveState.name (which still reflects the saved
        // override). Without this fallback the field keeps showing the
        // pre-edit override until the user clicks Save.
        const _hn  = (isOrigin
          ? (isDirty && draft?.name != null ? draft.name : effectiveState.name)
          : (isDirty
              ? (draft?.name_change != null
                  ? draft.name_change
                  : (priorEffectiveState?.name ?? effectiveState.name))
              : effectiveState.name)
        ) || ''
        const _hm  = entity.type.length + _hn.length
        const _hIc = _hm > 33
        const _hSq = !_hIc && _hm > 22

        // Phase 2.11b item 14 — "🎭 Talk to this character" entry
        // point. Sits to the right of the AttachToChatButton (when
        // present) on the chip / origin layouts; rendered alone on
        // the modifier layout (which has no AttachToChatButton today).
        // Always visible for character entities; hidden everywhere
        // else. The handler builds the Setup modal's `initialMeta` at
        // click-time from the panel's current anchor:
        //   - At origin (or when no node is navigated): single pin
        //     `{kind, id, anchor_node_id: <origin>}`.
        //   - At any downstream node (scene chip / modifier): range
        //     pin `{anchor_range: {start_node_id: <origin>,
        //     end_node_id: <current>, members: <chain slice>}}`.
        // The range's `members` walks the entity's narrative chain
        // from origin to the current anchor — same shape the
        // ChainRangeSelector emits when the writer manually picks a
        // range, so the modal can seed its selection from the spec
        // without modification.
        const handleOpenTalkSetup = () => {
          if (entity?.type !== 'character' || !entity?.id) return
          const originNode = (nodes || []).find(
            (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entity.id,
          )
          const originNodeId = originNode?.id || null
          if (!originNodeId) return
          const targetNodeId = nodeId || originNodeId
          let pin
          if (targetNodeId === originNodeId) {
            pin = { kind: 'character', id: entity.id, anchor_node_id: originNodeId }
          } else {
            let chainIds = []
            try {
              const chain = getEntityNarrativeChain(entity.id, nodes || [], edges || [])
              chainIds = (chain || []).map((n) => n.id)
            } catch { chainIds = [] }
            const startIdx = chainIds.indexOf(originNodeId)
            const endIdx = chainIds.indexOf(targetNodeId)
            if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
              pin = { kind: 'character', id: entity.id, anchor_node_id: targetNodeId }
            } else {
              pin = {
                kind: 'character',
                id: entity.id,
                anchor_range: {
                  start_node_id: originNodeId,
                  end_node_id: targetNodeId,
                  members: chainIds.slice(startIdx, endIdx + 1),
                },
              }
            }
          }
          setTalkInitialMeta({
            character_id: entity.id,
            anchor_spec: [pin],
            system_prompt_id: null,
            model_id_override: null,
            temp_circumstances: [],
            temp_motivators: [],
            custom_instructions: '',
          })
          setTalkSetupOpen(true)
        }
        const talkButton = entity?.type === 'character' && !aiDisabled ? (
          <button
            type="button"
            onClick={handleOpenTalkSetup}
            title="Talk to this character through the AI, anchored from origin to the scene you're viewing"
            className="w-5 h-5 inline-flex items-center justify-center text-[13px] leading-none flex-shrink-0 rounded hover:bg-zinc-700/60 text-zinc-300 hover:text-zinc-100 transition-colors"
            aria-label="Talk to this character"
          >
            🎭
          </button>
        ) : null

        // Phase 3.4h — colour chip slot, lifted from the scrollable
        // section into the identity-header bottom-left corner. Shared
        // by the chip/origin DetailPanelIdentityHeader branch AND the
        // modifier inline-header branch so navigation between panel
        // modes leaves the chip in the same screen position.
        // Anchor-aware: at origin reads/writes `draft.colour` baseline;
        // at a chain anchor reads/writes `draft.colour_change`
        // override. Same routing the scrollable-section row used.
        const _colourChipValue = isOrigin
          ? (isDirty ? draft.colour : (entity?.colour || '#888888'))
          : (isDirty
              ? (draft.colour_change ?? priorEffectiveState.colour ?? '#888888')
              : (savedChangeSource?.colour_change ?? priorEffectiveState.colour ?? '#888888'))
        const _colourChipWrite = (hex) => isOrigin
          ? setDraft((d) => ({ ...(d ?? initDraft()), colour: hex }))
          : updateDraftOverride('colour_change', hex)
        const colourChipSlot = (
          <>
            <button
              type="button"
              ref={setupColourAnchorRef}
              onClick={() => setSetupColourPickerOpen((o) => !o)}
              className="w-6 h-6 rounded border border-zinc-600 hover:border-zinc-400 cursor-pointer flex-shrink-0 transition-colors"
              style={{ background: _colourChipValue }}
              aria-label={`Colour: ${_colourChipValue}. Click to edit.`}
              title="Edit colour"
            />
            <EntityColorPicker
              value={_colourChipValue}
              onChange={_colourChipWrite}
              anchorEl={setupColourAnchorRef.current}
              isOpen={setupColourPickerOpen}
              onClose={() => setSetupColourPickerOpen(false)}
            />
          </>
        )

        // Modifier mode preserves its inline header (different visual layout)
        if (isModifier) {
          return (
            <div
              className="px-3 py-2 border-b border-zinc-700 flex flex-col gap-1.5 flex-shrink-0 justify-center relative"
              style={{ minHeight: 100 }}
            >
              {/* Phase 3.4h — colour chip mirrors the chip/origin
                  branch's cornerActionLeft slot positioning so the
                  chip lands in the same screen location across modes. */}
              <div className="absolute bottom-1.5 left-2 flex items-center">
                {colourChipSlot}
              </div>
              {talkButton && (
                <div className="absolute bottom-1.5 right-2 flex items-center">
                  {talkButton}
                </div>
              )}
              {/* Row 1: type : name */}
              <div className="w-full flex justify-center">
                <div className="flex items-center gap-1 max-w-full overflow-hidden">
                  {_hIc ? (
                    <span className="inline-flex items-center justify-center rounded flex-shrink-0 text-[11px]"
                      style={{ width: 16, height: 16, color: effectiveState.colour }}>
                      {TYPE_ICONS[entity.type] || '★'}
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px] uppercase text-accent-400 flex-shrink-0" style={{ letterSpacing: _hSq ? '-0.03em' : '0.25em' }}>{entity.type}</span>
                      <span className="text-[10px] text-zinc-500 flex-shrink-0">:</span>
                    </>
                  )}
                  {editingName ? (
                    <input
                      ref={nameInputRef}
                      className="text-sm font-medium leading-tight w-36 bg-transparent border-b focus:outline-none"
                      style={{ color: effectiveState.colour, borderColor: effectiveState.colour }}
                      value={nameEditVal}
                      onChange={(e) => setNameEditVal(e.target.value)}
                      onBlur={commitNameEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitNameEdit() }
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                      onFocus={(e) => e.target.select()}
                    />
                  ) : (
                    <div
                      className="text-sm font-medium leading-tight truncate min-w-0 cursor-text hover:opacity-75"
                      style={{ color: effectiveState.colour }}
                      onClick={startEditName}
                      title="Click to edit name"
                    >
                      {_hn}
                    </div>
                  )}
                  {isDirty && <span className="text-[9px] text-amber-400 flex-shrink-0 ml-1">Unsaved</span>}
                </div>
              </div>
              {/* Row 2: avatar */}
              <div className="flex justify-center">
                {isOvumRedEntity(entity) ? (
                  <OvumRedAvatar entityId={entity.id} colour={effectiveState.colour} size={48} showSplash={false} showBubble={false} />
                ) : (
                  <div
                    className="relative flex-shrink-0 group w-fit"
                    {...avatarDrop.dropHandlers}
                    style={avatarDrop.isDragOver ? {
                      outline: `2px dashed ${sceneAccentColour || '#a855f7'}`,
                      outlineOffset: 2,
                      borderRadius: 4,
                    } : undefined}
                    title={avatarDrop.isDragOver ? 'Drop to apply as avatar at this anchor' : undefined}
                  >
                    <ProfileImageUpload
                      fileRef={displayedImageRef}
                      entityType={entity.type}
                      entityColour={effectiveState.colour}
                      size={48}
                      compact
                      onChange={(newRef) => {
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          const newDraft = { ...base, profile_image_change: newRef }
                          return draftIsClean(newDraft) ? null : newDraft
                        })
                      }}
                    />
                    {displayedImageRef && (
                      <button
                        type="button"
                        title="Remove profile image"
                        onClick={() => {
                          setDraft((d) => ({ ...(d ?? initDraft()), profile_image_change: '' }))
                        }}
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 hover:bg-red-700 hover:text-white hidden group-hover:flex items-center justify-center text-[9px] leading-none"
                      >×</button>
                    )}
                    {(() => {
                      const _resolvedPic = isDirty ? draft?.profile_image_change : nodeData?.profile_image_change
                      if (_resolvedPic === null || _resolvedPic === undefined) return null
                      return (
                        <button
                          type="button"
                          title="Modified at this scene. Click to revert to the upstream inherited value."
                          onClick={() => {
                            setDraft((d) => {
                              const base = d ?? initDraft()
                              const newDraft = { ...base, profile_image_change: null }
                              return draftIsClean(newDraft) ? null : newDraft
                            })
                          }}
                          className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-amber-900/40 text-amber-400 hover:bg-red-900/40 hover:text-red-300 flex items-center justify-center text-[9px] leading-none border border-amber-500/40"
                        >✱</button>
                      )
                    })()}
                  </div>
                )}
              </div>
            </div>
          )
        }

        // Chip / Origin: shared DetailPanelIdentityHeader
        const compactIcon = (
          <span
            className="inline-flex items-center justify-center rounded flex-shrink-0 text-[11px]"
            style={{ width: 16, height: 16, color: effectiveState.colour }}
          >
            {TYPE_ICONS[entity.type] || '★'}
          </span>
        )
        const nameSlot = editingName ? (
          <input
            ref={nameInputRef}
            className="text-sm font-medium leading-tight w-36 bg-transparent border-b focus:outline-none"
            style={{ color: effectiveState.colour, borderColor: effectiveState.colour }}
            value={nameEditVal}
            onChange={(e) => setNameEditVal(e.target.value)}
            onBlur={commitNameEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitNameEdit() }
              if (e.key === 'Escape') setEditingName(false)
            }}
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <div
            className="text-sm font-medium leading-tight truncate min-w-0 cursor-text hover:opacity-75"
            style={{ color: effectiveState.colour }}
            onClick={startEditName}
            title="Click to edit name"
          >
            {_hn}
          </div>
        )
        // Modified-here detection for the avatar at non-origin chain nodes.
        const _resolvedPic = isDirty ? draft?.profile_image_change : entityRef?.profile_image_change
        const profileImageModHere = isChip && _resolvedPic !== null && _resolvedPic !== undefined
        const row2Slot = (
          <div className="flex justify-center">
            {isOvumRedEntity(entity) ? (
              <OvumRedAvatar entityId={entity.id} colour={effectiveState.colour} size={48} showSplash={false} showBubble={false} />
            ) : (
              <div
                className="relative flex-shrink-0 group w-fit"
                {...avatarDrop.dropHandlers}
                style={avatarDrop.isDragOver ? {
                  outline: `2px dashed ${sceneAccentColour || '#a855f7'}`,
                  outlineOffset: 2,
                  borderRadius: 4,
                } : undefined}
                title={avatarDrop.isDragOver ? `Drop to apply as avatar at ${isOrigin ? 'origin' : 'this anchor'}` : undefined}
              >
                <ProfileImageUpload
                  fileRef={displayedImageRef}
                  entityType={entity.type}
                  entityColour={effectiveState.colour}
                  size={48}
                  compact
                  onChange={(newRef) => {
                    if (isOrigin) {
                      setDraft((d) => ({ ...(d ?? initDraft()), profile_image_ref: newRef }))
                    } else {
                      setDraft((d) => {
                        const base = d ?? initDraft()
                        const newDraft = { ...base, profile_image_change: newRef }
                        return draftIsClean(newDraft) ? null : newDraft
                      })
                    }
                  }}
                />
                {displayedImageRef && (
                  <button
                    type="button"
                    title="Remove profile image"
                    onClick={() => {
                      if (isOrigin) {
                        setDraft((d) => ({ ...(d ?? initDraft()), profile_image_ref: null }))
                      } else {
                        setDraft((d) => ({ ...(d ?? initDraft()), profile_image_change: '' }))
                      }
                    }}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 hover:bg-red-700 hover:text-white hidden group-hover:flex items-center justify-center text-[9px] leading-none"
                  >×</button>
                )}
                {profileImageModHere && (
                  <button
                    type="button"
                    title="Modified at this scene. Click to revert to the upstream inherited value."
                    onClick={() => {
                      setDraft((d) => {
                        const base = d ?? initDraft()
                        const newDraft = { ...base, profile_image_change: null }
                        return draftIsClean(newDraft) ? null : newDraft
                      })
                    }}
                    className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-amber-900/40 text-amber-400 hover:bg-red-900/40 hover:text-red-300 flex items-center justify-center text-[9px] leading-none border border-amber-500/40"
                  >✱</button>
                )}
              </div>
            )}
          </div>
        )
        // Phase 2.7a/b — "Add as context" affordance in the lower-right
        // of the identity header. Anchored to whichever node the
        // detail panel is currently focused on: the entity's origin
        // EntityNode at origin, the modifier EntityNode on a modifier
        // view, the scene node when viewing a chip. All three feed
        // the chain walker uniformly via the node id.
        const attachTitle = isOrigin
          ? 'Add this entity at its origin as context to the open conversation'
          : (isModifier
              ? 'Add this entity at this modifier as context to the open conversation'
              : 'Add this entity at this scene as context to the open conversation')
        // `talkButton` is built once at the top of this IIFE — see
        // the matching `if (isModifier)` branch above for the
        // construction. Here we just splice it into the chip/origin
        // cornerAction Fragment alongside the existing
        // AttachToChatButton, with a small left margin so the two
        // glyphs don't touch.
        const cornerAction = (
          <>
            <AttachToChatButton
              kind="entity"
              id={entity.id}
              anchorNodeId={nodeId}
              title={attachTitle}
              className="w-5 h-5"
            />
            {talkButton && <span className="ml-1 inline-flex">{talkButton}</span>}
          </>
        )
        return (
          <DetailPanelIdentityHeader
            typeLabel={entity.type}
            typeIcon={compactIcon}
            useCompactIcon={_hIc}
            letterSpacing={_hSq ? '-0.03em' : '0.25em'}
            nameSlot={nameSlot}
            trailingAfterName={isDirty ? <span className="text-[9px] text-amber-400 flex-shrink-0 ml-1">Unsaved</span> : null}
            row2Slot={row2Slot}
            cornerAction={cornerAction}
            cornerActionLeft={colourChipSlot}
          />
        )
      })()}
      subTabs={(
        <DetailPanelSubTabs
          tabs={['details', 'attributes', 'relationships', 'awareness']}
          active={subTab}
          onChange={setSubTab}
        />
      )}
      body={(<>

        {subTab === 'awareness' && (
          <div className="space-y-2">
            {/* Known By — owns its own header (label + tracking toggle
                + chevron). Independently collapsible; default collapsed.
                Only expandable when tracking is on (gated inside
                KnownBySection's `canExpand` check). */}
            <div data-help-region="detail-panel:awareness_known_by">
              <KnownBySection
                entity={entity}
                anchorKind={isOrigin ? 'origin' : (isModifier ? 'modifier' : 'chip')}
                anchorNodeId={isOrigin ? null : nodeId}
                isExpanded={knownByExpanded}
                onToggleExpand={() => setKnownByExpanded(!knownByExpanded)}
              />
            </div>

            {/* Aware Of — always rendered, no collapsible header. The
                section's own italic blurb provides its context. */}
            <div className="border-t border-zinc-700/50 mt-3 pt-3" data-help-region="detail-panel:awareness_aware_of">
              <AwareOfSection
                entityId={entityId}
                nodeId={isOrigin ? null : nodeId}
                entityName={entity?.name || ''}
              />
            </div>
          </div>
        )}

        {subTab === 'details' && (
          <>
            {/* Description — ONE plain editor regardless of anchor. The
                writer here is the only context-aware piece: at origin
                it routes to the entity baseline draft; at any chain
                anchor it routes to the EntityRef override draft. The
                field itself doesn't know or care which. */}
            <div data-help-region="detail-panel:details_description">
              <DescriptionEditor
                value={isOrigin
                  ? (isDirty ? draft.description : (entity?.description || ''))
                  : (isDirty && draft?.description_change != null
                      ? draft.description_change
                      : (savedChangeSource?.description_change != null
                          ? savedChangeSource.description_change
                          : (priorEffectiveState?.description ?? '')))}
                onChange={(val) => isOrigin
                  ? setDraft((d) => ({ ...(d ?? initDraft()), description: val }))
                  : updateDraftOverride('description_change', val)}
              />
            </div>

            {/* Aliases — ONE editor regardless of anchor. Writer routes
                onChange to baseline draft at origin / chain-time
                aliases_change override at chain. The displayed list at
                chain falls back to the chain-resolved upstream list
                when no override exists, so the user is editing the
                effective list directly; their edits become a chain-
                time full-replacement override. */}
            <div className="mb-3" data-help-region="detail-panel:details_aliases">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Aliases</label>
                <button
                  type="button"
                  onClick={() => tryProceed(() => useUiStore.getState().openAliasesPanel(entityId, { kind: anchorKind, nodeId }))}
                  className="w-6 h-6 flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300 transition-colors text-[12px] leading-none"
                  title="Manage Awareness"
                >
                  <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1.5px)' }}>👥</span>
                </button>
              </div>
              <AliasTagEditor
                aliases={(() => {
                  if (isOrigin) {
                    return isDirty ? (draft.aliases || []) : (entity?.aliases || [])
                  }
                  // Scene path: when no draft edits in flight, the saved
                  // walker-resolved state at this scene IS the display.
                  // When the draft has alias_changes from in-flight edits,
                  // we apply the draft's events on top of the UPSTREAM
                  // state (state at this scene with this scene's alias
                  // contribution removed) so the preview reflects what
                  // the writer's about to save, NOT a stale saved state.
                  if (!isDirty || !Array.isArray(draft?.alias_changes)) {
                    return effectiveState?.aliases ?? []
                  }
                  if (!entity) return []
                  // Compute upstream state — same trick the save handler
                  // uses: blank this entity's alias contribution at this
                  // scene, then walk.
                  const upstreamNodes = nodes.map((n) => {
                    if (n.id !== nodeId || n.type !== 'sceneNode') return n
                    const newData = { ...n.data }
                    for (const bucket of ENTITY_BUCKETS) {
                      const refs = newData[bucket] || []
                      const idx = refs.findIndex((r) => r.entity_id === entityId)
                      if (idx !== -1) {
                        newData[bucket] = refs.map((r, i) =>
                          i === idx ? { ...r, alias_changes: [] } : r
                        )
                        break
                      }
                    }
                    return { ...n, data: newData }
                  })
                  const upstreamState = computeEffectiveState(entity, upstreamNodes, edges, nodeId)
                  let result = [...(upstreamState?.aliases || [])]
                  // Apply draft events on top.
                  for (const ev of draft.alias_changes) {
                    if (!ev || typeof ev !== 'object') continue
                    if (ev.action === 'add' && ev.alias?.id) {
                      if (!result.some((a) => a.id === ev.alias.id)) {
                        result.push({ ...ev.alias })
                      }
                    } else if (ev.action === 'remove' && ev.alias_id) {
                      result = result.filter((a) => a.id !== ev.alias_id)
                    } else if (ev.action === 'modify' && ev.alias_id && ev.new_value != null) {
                      result = result.map((a) => a.id === ev.alias_id ? { ...a, value: ev.new_value } : a)
                    }
                  }
                  return result
                })()}
                onAdd={(value) => {
                  if (isOrigin) {
                    // Origin path: append to baseline aliases list in draft
                    // with a fresh UUID. Origin is the alias's chain origin
                    // (per the chain rule); baseline write is correct here.
                    setDraft((d) => {
                      const base = d ?? initDraft()
                      const newAlias = { id: crypto.randomUUID(), value, awareness: null }
                      return { ...base, aliases: [...(base.aliases || []), newAlias] }
                    })
                  } else {
                    // Scene path: append an `add` chain event to
                    // `draft.alias_changes`. The walker / save path
                    // treats this as additive — no prior alias of this
                    // value is overwritten. Seed alias_changes from the
                    // saved ref's existing events if the draft hasn't
                    // touched the field yet, so we don't clobber
                    // pre-existing events at this scene.
                    setDraft((d) => {
                      const base = d ?? initDraft()
                      const seedEvents = ('alias_changes' in base)
                        ? base.alias_changes
                        : (savedChangeSource?.alias_changes || [])
                      const newAlias = { id: crypto.randomUUID(), value, awareness: null }
                      const event = {
                        id: crypto.randomUUID(),
                        action: 'add',
                        alias: newAlias,
                      }
                      return { ...base, alias_changes: [...seedEvents, event] }
                    })
                  }
                }}
                onRemove={(alias) => {
                  if (isOrigin) {
                    // Origin path: remove from baseline aliases list by id
                    // (fall back to value-match for legacy id-less aliases).
                    setDraft((d) => {
                      const base = d ?? initDraft()
                      const filtered = (base.aliases || []).filter((a) =>
                        alias.id ? a.id !== alias.id : a.value !== alias.value
                      )
                      return { ...base, aliases: filtered }
                    })
                  } else {
                    // Scene path: append a `remove` chain event keyed on
                    // the alias's id. If the alias being removed was
                    // added in this same editing session (we have a
                    // matching add event in draft.alias_changes), strip
                    // the add event instead of recording a paired
                    // remove — same-session add+remove resolves to a
                    // no-op, keeping draft history minimal.
                    setDraft((d) => {
                      const base = d ?? initDraft()
                      const seedEvents = ('alias_changes' in base)
                        ? base.alias_changes
                        : (savedChangeSource?.alias_changes || [])
                      const targetId = alias.id
                      if (!targetId) {
                        // Legacy id-less alias (e.g. from a stale
                        // effectiveState fallback). Without an id we
                        // can't address it via a chain event; leave
                        // the draft untouched. The walker's transitional
                        // fallback handles this case via the legacy
                        // `aliases_change` path (which the save handler
                        // also still covers).
                        return base
                      }
                      // Strip a same-session add event for the same id
                      // instead of pushing a remove event.
                      const sameSessionAddIdx = seedEvents.findIndex(
                        (ev) => ev && ev.action === 'add' && ev.alias?.id === targetId
                      )
                      if (sameSessionAddIdx >= 0) {
                        const next = seedEvents.filter((_, i) => i !== sameSessionAddIdx)
                        return { ...base, alias_changes: next }
                      }
                      const event = {
                        id: crypto.randomUUID(),
                        action: 'remove',
                        alias_id: targetId,
                      }
                      return { ...base, alias_changes: [...seedEvents, event] }
                    })
                  }
                }}
              />
            </div>

            {/* Tags — Project Tag picker. Mounts at every anchor
                (origin / chip / modifier) mirroring the AliasTagEditor
                pattern: callbacks branch on `isOrigin` to route writes
                to the right carrier.
                  - Origin: mutate `draft.tag_ids` (baseline). Save
                    flushes via the existing `updateEntity` PUT.
                  - Chip / modifier: mutate `draft.tag_changes` with
                    same-node opposite-pair cancellation (writing
                    `add@N` where `remove@N` exists, OR `remove@N`
                    where `add@N` exists, strips both events instead
                    of accumulating noise). `saveEntityChipDraft` /
                    `saveModifierNodeDraft` spread `draft.tag_changes`
                    onto the EntityRef / modifier-node data
                    automatically (the `{...r, ...draft}` line).
                `baselineTagIds` is always the host's raw `entity.tag_ids`
                so the picker's solid-vs-dashed rule lands per chip:
                solid when the id is in baseline, dashed when it isn't. */}
            <div className="mb-3" data-help-region="detail-panel:details_tags">
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Tags</label>
              {(() => {
                // Read side. At origin draft.tag_ids is the live edit
                // buffer; at chain anchors we recover the effective set
                // by stripping the saved tag_changes off the walker
                // output and then overlaying the draft's tag_changes.
                // Mirrors how the aliases section computes its
                // "upstream + draft events" preview.
                let currentTagIds
                if (isOrigin) {
                  currentTagIds = isDirty ? (draft?.tag_ids || []) : (entity?.tag_ids || [])
                } else {
                  const savedEvents = savedChangeSource?.tag_changes || []
                  const upstreamSet = new Set(effectiveState?.tag_ids || [])
                  for (const ev of savedEvents) {
                    if (!ev || !ev.tag_id) continue
                    if (ev.action === 'add') upstreamSet.delete(ev.tag_id)
                    else if (ev.action === 'remove') upstreamSet.add(ev.tag_id)
                  }
                  const events = (isDirty && Array.isArray(draft?.tag_changes))
                    ? draft.tag_changes
                    : savedEvents
                  const final = new Set(upstreamSet)
                  for (const ev of events) {
                    if (!ev || !ev.tag_id) continue
                    if (ev.action === 'add') final.add(ev.tag_id)
                    else if (ev.action === 'remove') final.delete(ev.tag_id)
                  }
                  currentTagIds = Array.from(final)
                }
                // At origin, a draft add lands in baseline on save —
                // so the prospective baseline IS `draft.tag_ids`, not
                // the still-unsaved `entity.tag_ids`. Reading the
                // saved baseline here would render every just-added
                // chip as dashed (id in currentTagIds but not yet in
                // entity.tag_ids) until the writer saved. At chain
                // anchors `entity.tag_ids` stays correct because adds
                // there go to `draft.tag_changes`, never baseline.
                const baselineTagIds = isOrigin
                  ? (isDirty ? (draft?.tag_ids || []) : (entity?.tag_ids || []))
                  : (entity?.tag_ids || [])

                return (
                  <ProjectTagPicker
                    currentTagIds={currentTagIds}
                    baselineTagIds={baselineTagIds}
                    onTagClick={_openTagPopover}
                    onAdd={(tagId) => {
                      if (isOrigin) {
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          const list = base.tag_ids || []
                          if (list.includes(tagId)) return base
                          return { ...base, tag_ids: [...list, tagId] }
                        })
                      } else {
                        // Chain anchor add: pair-cancel against an
                        // existing remove@N for the same tag, else
                        // append a fresh add event.
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          const seed = ('tag_changes' in base)
                            ? base.tag_changes
                            : (savedChangeSource?.tag_changes || [])
                          const oppositeIdx = seed.findIndex(
                            (ev) => ev && ev.tag_id === tagId && ev.action === 'remove'
                          )
                          if (oppositeIdx >= 0) {
                            return { ...base, tag_changes: seed.filter((_, i) => i !== oppositeIdx) }
                          }
                          // Skip same-anchor duplicate adds — picker
                          // already short-circuits on currentTagIds,
                          // belt-and-braces for store re-entry.
                          if (seed.some((ev) => ev && ev.tag_id === tagId && ev.action === 'add')) {
                            return { ...base, tag_changes: seed }
                          }
                          const event = { id: crypto.randomUUID(), action: 'add', tag_id: tagId }
                          return { ...base, tag_changes: [...seed, event] }
                        })
                      }
                    }}
                    onRemove={(tagId) => {
                      if (isOrigin) {
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          const list = base.tag_ids || []
                          return { ...base, tag_ids: list.filter((id) => id !== tagId) }
                        })
                      } else {
                        // Chain anchor remove: pair-cancel against an
                        // existing add@N for the same tag, else append
                        // a fresh remove event.
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          const seed = ('tag_changes' in base)
                            ? base.tag_changes
                            : (savedChangeSource?.tag_changes || [])
                          const oppositeIdx = seed.findIndex(
                            (ev) => ev && ev.tag_id === tagId && ev.action === 'add'
                          )
                          if (oppositeIdx >= 0) {
                            return { ...base, tag_changes: seed.filter((_, i) => i !== oppositeIdx) }
                          }
                          if (seed.some((ev) => ev && ev.tag_id === tagId && ev.action === 'remove')) {
                            return { ...base, tag_changes: seed }
                          }
                          const event = { id: crypto.randomUUID(), action: 'remove', tag_id: tagId }
                          return { ...base, tag_changes: [...seed, event] }
                        })
                      }
                    }}
                  />
                )
              })()}
            </div>

            {/* Phase 3.4h — Colour control relocated to the identity
                header's bottom-left corner (`cornerActionLeft` slot).
                See the `colourChipSlot` definition in the header IIFE
                above. Routing is identical: at origin writes
                `draft.colour` baseline; at chain anchor writes
                `draft.colour_change` override via `updateDraftOverride`. */}

            {/* Hierarchy: location-type only AND origin-only (location
                hierarchy is a baseline-only field today). */}
            {isOrigin && entity.type === 'location' && (
              <div className="mb-3" data-help-region="detail-panel:details_hierarchy">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Hierarchy</label>
                  <button
                    className="text-[9px] text-zinc-500 hover:text-accent-400 px-1.5 py-0.5 rounded hover:bg-zinc-700 transition-colors"
                    onClick={() => tryProceed(() => openHierarchyEditor('location'))}
                    title="Open full location hierarchy tree"
                  >
                    Open as tree...
                  </button>
                </div>
                <div className="text-xs mb-1">
                  {locationParentPath.length > 0
                    ? (
                      <span className="text-zinc-400">
                        {locationParentPath.map((p) => p.name).join(' › ')} ›{' '}
                        <span className="text-zinc-200">{entity.name}</span>
                      </span>
                    )
                    : <span className="text-zinc-600 italic">Top-level location</span>
                  }
                </div>
                {locationChildren.length > 0 && (
                  <div className="mt-1">
                    <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1">Children</div>
                    {locationChildren.map((child) => (
                      <div key={child.id} className="text-xs text-zinc-400 py-0.5 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: child.colour || '#888' }} />
                        <span className="truncate">{child.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Sub-chips section: same component, props composed per anchor. */}
            <div data-help-region="detail-panel:details_changes">
            <ChangesSummarySection
              chips={changeSubChips}
              tempCMChips={isChip
                ? (currentNode?.data?.entity_temporary_circumstances || []).filter((t) => t.entity_id === entityId)
                : []}
              tempCMAccentColour={sceneAccentColour}
              onDismissTempCM={(t) => removeEntityTemporaryCM(nodeId, t.id)}
              onTempCMClick={() => useUiStore.getState().setDetailPanelActiveSubTab('attributes')}
              awarenessChips={isOrigin ? undefined : getAwarenessChangesForObserverAtNode({
                observerEntityId: entityId,
                nodeId,
                allNodes: nodes,
                allEdges: edges,
                allEntities: [...entCharacters, ...entLocations, ...entItems, ...entFactions, ...entCustoms],
                allRelationships,
                allKnowledges: allKnowledgesPS,
              })}
              relationshipHistoryChips={isOrigin ? undefined : getEntityRelationshipChangesAtNode(entityId, nodeId, allRelationships, isModifier ? nodeOrder : null)}
              entityColour={isOrigin ? (effectiveState?.colour || entity?.colour) : effectiveState?.colour}
              observerName={isOrigin ? undefined : (effectiveState?.name || entity?.name)}
              allEntities={allEntities}
              allRelationships={isOrigin ? undefined : allRelationships}
              allKnowledges={isOrigin ? undefined : allKnowledgesPS}
              onDismissChip={dismissChangeChip}
              onAddKnowledge={(chip, e) => {
                // Mirror the on-node chip's "Add knowledge of this change"
                // wiring. Origin: build from the entity's baseline
                // attribute. Chip / Modifier: build from the carrier ref's
                // attribute_changes entry.
                const carrier = isOrigin ? null : (isModifier ? nodeData : entityRef)
                let sourceEvent = null
                if (isOrigin && chip.attributeId) {
                  const attr = (entity?.attributes || []).find((a) => a.id === chip.attributeId)
                  if (attr) sourceEvent = buildSourceEventFromOriginAttribute(attr, entity, nodeId)
                } else if (carrier) {
                  sourceEvent = buildSourceEventFromEntityRefChip(chip, carrier, nodeId)
                }
                if (!sourceEvent) return
                const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                useUiStore.getState().openAddKnowledgeFromChangePopover({
                  anchorRect: rect,
                  sourceEvent,
                  suggestedName: buildSuggestedKnowledgeName(chip, carrier, entity),
                  triggerNodeId: nodeId,
                  isOrigin: !!isOrigin,
                  eventDisplay: {
                    ownerEntityId: entityId,
                    action: chip.action,
                    fieldLabel: chip.field,
                    oldValue: chip.oldValue,
                    newValue: chip.newValue,
                  },
                })
              }}
              onMediaPreview={(chip, fileRef) => {
                togglePreview({
                  type: 'attribute',
                  entityId,
                  attributeId: chip.attributeId,
                  atNodeId: nodeId,
                  fileRef,
                  attributeName: chip.field,
                  entityName: isOrigin ? entity?.name : effectiveState?.name,
                  entityColour: isOrigin ? entity?.colour : effectiveState?.colour,
                  profileImageRef: isOrigin ? entity?.profile_image_ref : effectiveState?.profile_image_ref,
                })
              }}
              sectionTitle={isOrigin ? 'Additions at this point' : undefined}
              onSwitchTab={setSubTab}
            />
            </div>
          </>
        )}

        {subTab === 'attributes' && (() => {
          // Phase 1.22d — Attributes tab partitioned into three collapsible
          // sections by attribute_type:
          //   1. Attributes     — every type that isn't circumstance/motivator
          //   2. Circumstances  — attribute_type === 'circumstance'
          //   3. Motivators     — attribute_type === 'motivator'
          // Each section emits its own filtered slice of the same five
          // sub-lists the original single block emitted: effective rows,
          // pending +ADD drafts, origin pending-remove, removed-at-this-
          // node, and restored-via-↩. The `+ Add Attribute` UI lives only
          // in the Attributes section for now; dedicated `+ Add
          // Circumstance` / `+ Add Motivator` forms land in 1.22d step 2/3.
          const isCircumstance = (t) => t === 'circumstance'
          const isMotivator    = (t) => t === 'motivator'
          const isPerspective  = (t) => t === 'perspective'
          const SECTIONS = [
            { id: 'attributes',    title: 'Attributes',    typeFilter: (t) => !isCircumstance(t) && !isMotivator(t) && !isPerspective(t) },
            { id: 'circumstances', title: 'Circumstances', typeFilter: isCircumstance },
            { id: 'motivators',    title: 'Motivators',    typeFilter: isMotivator    },
            { id: 'perspectives',  title: 'Perspectives',  typeFilter: isPerspective  },
          ]
          return (
          <>
            {SECTIONS.map((section, sectionIdx) => (
            <div key={section.id} className="mb-3" data-help-region={`detail-panel:attributes_${section.id}`}>
              {sectionIdx > 0 && (
                <div className="border-t border-zinc-700 mb-3" />
              )}
              {(() => null)()/* count rendered inline below — count of chain-resolved entries
                  matching this section's type filter. Temp C/Ms are not
                  counted here; they're per-scene scratch entries surfaced
                  separately in the section body and don't belong in the
                  baseline-style header total. */}
              <div className="flex items-start justify-between gap-1 px-1 py-1 mb-1">
                <button
                  type="button"
                  onClick={() => setAttrSectionExpanded((m) => ({ ...m, [section.id]: !(m[section.id] ?? true) }))}
                  className="flex-1 flex items-center h-6 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200 text-left"
                >
                  <span>
                    {(attrSectionExpanded[section.id] ?? true) ? '▾' : '▸'} {section.title}
                    <span className="ml-1 text-zinc-500 normal-case tracking-normal">
                      ({
                        // Count the rows actually shown for this section:
                        // effective attrs present at this anchor PLUS the
                        // +ADDED draft-add entries not already effective
                        // (and not pending-remove). At origin every
                        // baseline attribute is a draft-add entry and
                        // `effectiveState.attributes` is empty, so the old
                        // effective-only count read 0; this includes them.
                        (effectiveState?.attributes || []).filter((a) => section.typeFilter(a.attribute_type)).length
                        + (draftAttrChanges || []).filter((ac) => ac.action === 'add' && ac.attribute && !ac.pending_remove && !(effectiveState?.attributes || []).some((a) => a.id === ac.attribute.id) && section.typeFilter(ac.attribute.attribute_type)).length
                      })
                    </span>
                  </span>
                </button>
                {/* Right cluster: top row holds the awareness 👥 button
                    and the regular `+ Add` button side-by-side; bottom
                    row (C/M sections only, chain anchor only) holds the
                    `+ Add Temporary` button. */}
                <div className="flex flex-col gap-0.5 flex-shrink-0 items-end">
                  <div className="flex items-center gap-0.5">
                    {/* Perspectives don't carry per-observer awareness in v1
                        (planning doc decision 1) so the 👥 affordance is
                        hidden for that section. */}
                    {section.id !== 'perspectives' && (
                      <button
                        type="button"
                        onClick={() => {
                          const firstInSection = (effectiveState?.attributes || []).find(
                            (a) => section.typeFilter(a.attribute_type),
                          )
                          tryProceed(() => useUiStore.getState().openAttributesAwarenessPanel(
                            entityId,
                            { kind: anchorKind, nodeId },
                            firstInSection?.id ?? null,
                          ))
                        }}
                        className="w-6 h-6 flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300 transition-colors text-[10px] leading-none flex-shrink-0"
                        title={`Manage ${section.title} Awareness`}
                      >
                        <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1px)' }}>👥</span>
                      </button>
                    )}
                    <button
                      type="button"
                      data-help-region={`detail-panel:attributes_${section.id}_add`}
                      onClick={() => {
                        if (section.id === 'attributes')      setShowAddAttr(true)
                        else if (section.id === 'circumstances') setShowAddCircumstance(true)
                        else if (section.id === 'motivators')    setShowAddMotivator(true)
                        else if (section.id === 'perspectives')  setShowAddPerspective(true)
                      }}
                      className="flex items-center gap-0.5 px-1.5 h-6 rounded border text-[10px] leading-none transition-colors border-zinc-700 bg-zinc-800 text-accent-400 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300"
                      title={
                        section.id === 'attributes'    ? 'Add Attribute'
                      : section.id === 'circumstances' ? 'Add Circumstance'
                      : section.id === 'motivators'    ? 'Add Motivator'
                      : 'Add Perspective'
                      }
                    >
                      <span>+ Add</span>
                      {section.id === 'circumstances' && <CircumstanceTypeBadge size={14} />}
                      {section.id === 'motivators' && <MotivatorTypeBadge size={14} />}
                      {section.id === 'perspectives' && <PerspectiveTypeBadge size={14} />}
                    </button>
                  </div>
                  {/* Phase 1.22h — `+ Add Temporary` button, only at
                      chain anchor (chip / modifier mode) and only on
                      C/M sections. Origin doesn't have a scene scope
                      so the button is hidden there. The button visual
                      uses the chevron-corner pentagon variant of the
                      type badge + dashed accent border to telegraph
                      the temporary visual language. */}
                  {!isOrigin && (section.id === 'circumstances' || section.id === 'motivators') && (
                    <button
                      type="button"
                      data-help-region={`detail-panel:attributes_${section.id}_add_temporary`}
                      onClick={() => {
                        if (section.id === 'circumstances') setShowAddTempCircumstance(true)
                        else setShowAddTempMotivator(true)
                      }}
                      className="flex items-center gap-0.5 px-1.5 h-6 rounded text-[10px] leading-none transition-colors bg-zinc-800 text-accent-400 hover:bg-accent-900/30 hover:text-accent-300"
                      style={{ border: `1px dashed ${sceneAccentColour}` }}
                      title={
                        section.id === 'circumstances'
                          ? 'Add Temporary Circumstance (this scene only)'
                          : 'Add Temporary Motivator (this scene only)'
                      }
                    >
                      <span>+ Add</span>
                      {section.id === 'circumstances' && <CircumstanceTypeBadge size={14} temporary temporaryColour={sceneAccentColour} />}
                      {section.id === 'motivators' && <MotivatorTypeBadge size={14} temporary temporaryColour={sceneAccentColour} />}
                    </button>
                  )}
                </div>
              </div>
              {(attrSectionExpanded[section.id] ?? true) && (<>
            {section.id === 'motivators' && showAddMotivator && (
              <div className="border border-zinc-600 rounded p-2 space-y-1.5 mb-2">
                <div className="flex items-center gap-1">
                  <MotivatorTypeBadge size={14} />
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider">New Motivator</span>
                </div>
                <input
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 placeholder:italic placeholder:text-zinc-500"
                  value={newMotivator.name}
                  placeholder="Name (optional)"
                  onChange={(e) => setNewMotivator((m) => ({ ...m, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    const hasName = !!newMotivator.name.trim()
                    const hasDesc = !!newMotivator.description.trim()
                    if (!hasName && !hasDesc) { setMotivatorError('both'); return }
                    setMotivatorError(null)
                    addAttrChange({
                      ...newMotivator,
                      id: crypto.randomUUID(),
                      name: newMotivator.name.trim(),
                      description: newMotivator.description.trim(),
                    })
                  }}
                />
                <textarea
                  className={`w-full bg-zinc-800 border ${motivatorError === 'both' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500`}
                  rows={3}
                  value={newMotivator.description}
                  placeholder="Description (optional)"
                  onChange={(e) => { setNewMotivator((m) => ({ ...m, description: e.target.value })); if (motivatorError === 'both') setMotivatorError(null) }}
                />
                {motivatorError === 'both' && (
                  <p className="text-[9px] text-red-400 whitespace-nowrap">Enter a name or a description (at least one).</p>
                )}
                <IntensitySlider
                  level={newMotivator.intensity}
                  onChange={(v) => setNewMotivator((m) => ({ ...m, intensity: v }))}
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      const hasName = !!newMotivator.name.trim()
                      const hasDesc = !!newMotivator.description.trim()
                      if (!hasName && !hasDesc) { setMotivatorError('both'); return }
                      setMotivatorError(null)
                      addAttrChange({
                        ...newMotivator,
                        id: crypto.randomUUID(),
                        name: newMotivator.name.trim(),
                        description: newMotivator.description.trim(),
                      })
                    }}
                    className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowAddMotivator(false); setNewMotivator(emptyMotivator()); setMotivatorError(null) }}
                    className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {section.id === 'circumstances' && showAddCircumstance && (
              <div className="border border-zinc-600 rounded p-2 space-y-1.5 mb-2">
                <div className="flex items-center gap-1">
                  <CircumstanceTypeBadge size={14} />
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider">New Circumstance</span>
                </div>
                <input
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 placeholder:italic placeholder:text-zinc-500"
                  value={newCircumstance.name}
                  placeholder="Name (optional)"
                  onChange={(e) => setNewCircumstance((c) => ({ ...c, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    const hasName = !!newCircumstance.name.trim()
                    const hasDesc = !!newCircumstance.description.trim()
                    if (!hasName && !hasDesc) { setCircumstanceError('both'); return }
                    setCircumstanceError(null)
                    addAttrChange({
                      ...newCircumstance,
                      id: crypto.randomUUID(),
                      name: newCircumstance.name.trim(),
                      description: newCircumstance.description.trim(),
                    })
                  }}
                />
                <textarea
                  className={`w-full bg-zinc-800 border ${circumstanceError === 'both' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500`}
                  rows={3}
                  value={newCircumstance.description}
                  placeholder="Description (optional)"
                  onChange={(e) => { setNewCircumstance((c) => ({ ...c, description: e.target.value })); if (circumstanceError === 'both') setCircumstanceError(null) }}
                />
                {circumstanceError === 'both' && (
                  <p className="text-[9px] text-red-400 whitespace-nowrap">Enter a name or a description (at least one).</p>
                )}
                <IntensitySlider
                  level={newCircumstance.intensity}
                  onChange={(v) => setNewCircumstance((c) => ({ ...c, intensity: v }))}
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      const hasName = !!newCircumstance.name.trim()
                      const hasDesc = !!newCircumstance.description.trim()
                      if (!hasName && !hasDesc) { setCircumstanceError('both'); return }
                      setCircumstanceError(null)
                      addAttrChange({
                        ...newCircumstance,
                        id: crypto.randomUUID(),
                        name: newCircumstance.name.trim(),
                        description: newCircumstance.description.trim(),
                      })
                    }}
                    className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowAddCircumstance(false); setNewCircumstance(emptyCircumstance()); setCircumstanceError(null) }}
                    className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {section.id === 'perspectives' && showAddPerspective && (
              <div className="border border-zinc-600 rounded p-2 space-y-1.5 mb-2">
                <div className="flex items-center gap-1">
                  <PerspectiveTypeBadge size={14} />
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider">New Perspective</span>
                </div>
                {/* Perspectives don't have a name field — the structure
                    is (1) the thing this is a perspective ON (target),
                    positioned first, and (2) the description text
                    that IS the perspective. Target on top so the
                    writer commits to who/what they're describing
                    BEFORE writing the description (otherwise the
                    description loses its anchor in the writer's
                    mental model). */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-0.5">Perspective on</div>
                  {newPerspective.perspective_target_id ? (
                    (() => {
                      // Click handler shared across all three badge kinds:
                      // clears the picked target back to null AND opens
                      // the picker. The badge IS the change affordance —
                      // no separate `✎ change` button.
                      const changeTarget = () => {
                        setNewPerspective((p) => ({ ...p, perspective_target_kind: null, perspective_target_id: null }))
                        setPerspectiveTargetPickerOpen(true)
                      }
                      const k  = newPerspective.perspective_target_kind
                      const id = newPerspective.perspective_target_id
                      if (k === 'knowledge') {
                        const kn = useProjectStore.getState().knowledges?.find((x) => x.id === id)
                        return <KnowledgeLabelChip size="lg" name={kn?.name || '(missing)'} onClick={changeTarget} />
                      }
                      if (k === 'relationship') {
                        const r = useProjectStore.getState().relationships?.find((x) => x.id === id)
                        let label = '(missing)'
                        if (r) {
                          if (r.title?.trim()) label = r.title.trim()
                          else {
                            const joins = (r.history?.participant_changes || []).filter((c) => c.action === 'join').map((c) => c.entity_id)
                            const uniq  = Array.from(new Set(joins))
                            const names = uniq.slice(0, 2).map((eid) => useEntitiesStore.getState().getEntityById(eid)?.name || '?')
                            label = uniq.length <= 2 ? names.join(' ↔ ') : `${names.join(' ↔ ')} + ${uniq.length - 2} more`
                          }
                        }
                        return <RelationshipLabelChip size="lg" name={label} onClick={changeTarget} />
                      }
                      const e = useEntitiesStore.getState().getEntityById(id)
                      return e
                        ? <EntityLabelChip size="lg" entity={e} onClick={changeTarget} />
                        : <span className="text-[11px] text-zinc-500 italic">(missing)</span>
                    })()
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPerspectiveTargetPickerOpen((v) => !v)}
                      className={`w-full px-2 py-1 rounded border text-[11px] text-left transition-colors ${perspectiveError === 'noTarget' ? 'border-red-500 text-red-300' : 'border-zinc-700 text-accent-400 hover:border-accent-500'}`}
                    >
                      {perspectiveTargetPickerOpen ? '× Close picker' : '+ Pick target…'}
                    </button>
                  )}
                  {perspectiveTargetPickerOpen && !newPerspective.perspective_target_id && (
                    <div className="mt-1">
                      <PerspectiveTargetPicker
                        onPick={({ kind, id }) => {
                          setNewPerspective((p) => ({ ...p, perspective_target_kind: kind, perspective_target_id: id }))
                          setPerspectiveTargetPickerOpen(false)
                          if (perspectiveError === 'noTarget') setPerspectiveError(null)
                        }}
                        onClose={() => setPerspectiveTargetPickerOpen(false)}
                      />
                    </div>
                  )}
                </div>
                <textarea
                  className={`w-full bg-zinc-800 border ${perspectiveError === 'noDescription' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500`}
                  rows={3}
                  value={newPerspective.description}
                  placeholder="Description (the perspective)"
                  onChange={(e) => { setNewPerspective((p) => ({ ...p, description: e.target.value })); if (perspectiveError === 'noDescription') setPerspectiveError(null) }}
                />
                {perspectiveError === 'noDescription' && (
                  <p className="text-[9px] text-red-400 whitespace-nowrap">A perspective needs a description.</p>
                )}
                {perspectiveError === 'noTarget' && (
                  <p className="text-[9px] text-red-400 whitespace-nowrap">Pick a target for this perspective.</p>
                )}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      const hasDesc = !!newPerspective.description.trim()
                      const hasTarget = !!newPerspective.perspective_target_id
                      if (!hasTarget) { setPerspectiveError('noTarget'); return }
                      if (!hasDesc)   { setPerspectiveError('noDescription'); return }
                      setPerspectiveError(null)
                      addAttrChange({
                        ...newPerspective,
                        id: crypto.randomUUID(),
                        // Name is intentionally blank — perspectives
                        // don't carry a name field. The target +
                        // description ARE the perspective's identity
                        // and content.
                        name: '',
                        description: newPerspective.description.trim(),
                      })
                      setShowAddPerspective(false)
                      setNewPerspective(emptyPerspective())
                      setPerspectiveTargetPickerOpen(false)
                    }}
                    className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => {
                      setShowAddPerspective(false)
                      setNewPerspective(emptyPerspective())
                      setPerspectiveError(null)
                      setPerspectiveTargetPickerOpen(false)
                    }}
                    className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {section.id === 'attributes' && showAddAttr && (
              <div className="border border-zinc-600 rounded p-2 space-y-1.5 mt-1">
                <div className="flex items-center gap-1">
                  {newAttr.attribute_type === 'preset' ? (
                    <>
                      <button
                        ref={newAttrPresetAnchorRef}
                        type="button"
                        onClick={() => setNewAttrPickerOpen(true)}
                        className="min-w-0 flex-1 max-w-[140px] text-left bg-zinc-700 text-xs px-2 py-1 rounded border border-zinc-600 hover:border-accent-500 focus:outline-none truncate"
                      >
                        {newAttr.preset_list_id
                          ? <span className="text-zinc-100">{presetLists.find((pl) => pl.id === newAttr.preset_list_id)?.name ?? '?'}</span>
                          : <span className="text-zinc-500">— select list —</span>}
                      </button>
                      <PresetListPicker
                        value={newAttr.preset_list_id || null}
                        onChange={(listId) => {
                          const list = presetLists.find((pl) => pl.id === listId)
                          setNewAttr((a) => ({ ...a, preset_list_id: listId || null, preset_list_name: list?.name || '', name: list?.name || a.name, value: '' }))
                        }}
                        anchorEl={newAttrPresetAnchorRef.current}
                        isOpen={newAttrPickerOpen}
                        onClose={() => setNewAttrPickerOpen(false)}
                      />
                    </>
                  ) : (
                    <input
                      autoFocus
                      className={`flex-1 bg-zinc-800 border ${attrNameError === 'blank' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500 min-w-0`}
                      value={newAttr.name}
                      placeholder="Attribute name"
                      onChange={(e) => { setNewAttr((a) => ({ ...a, name: e.target.value })); setAttrNameError(null) }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        if (!newAttr.name.trim()) { setAttrNameError('blank'); return }
                        if (newAttr.attribute_type === 'text') { valueInputRef.current?.focus(); return }
                        if (newAttr.attribute_type === 'file') { fileUploadTrigger.current?.(); return }
                        const existingNames = new Set([
                          ...(effectiveState?.attributes || []).map(a => a.name.trim().toLowerCase()),
                          ...(draftAttrChanges || []).filter(ac => ac.action === 'add' && ac.attribute && !ac.pending_remove).map(ac => ac.attribute.name.trim().toLowerCase()),
                        ])
                        if (existingNames.has(newAttr.name.trim().toLowerCase())) { setAttrNameError('duplicate'); return }
                        setAttrNameError(null)
                        addAttrChange({ ...newAttr, id: crypto.randomUUID(), value: '[]' })
                      }}
                    />
                  )}
                  <select
                    value={newAttr.attribute_type}
                    onChange={(e) => setNewAttr((a) => ({ ...a, attribute_type: e.target.value, value: '', file_ref: null, preset_list_id: null, preset_list_name: null, name: '' }))}
                    tabIndex={-1}
                    className="bg-zinc-700 text-xs text-zinc-100 px-1.5 py-0.5 rounded border border-zinc-600 focus:outline-none flex-shrink-0"
                  >
                    <option value="text">Text</option>
                    <option value="preset">Preset</option>
                    <option value="file">Media</option>
                    <option value="text_list">Text List</option>
                    <option value="entity_list">Entity List</option>
                    <option value="number">Number</option>
                  </select>
                </div>
                {attrNameError === 'duplicate' && (
                  <p className="text-[10px] text-red-400">An attribute with this name already exists.</p>
                )}
                {newAttr.attribute_type === 'text' && (
                  <input
                    ref={valueInputRef}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                    value={newAttr.value}
                    placeholder="Value (optional)"
                    onChange={(e) => setNewAttr((a) => ({ ...a, value: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      if (!newAttr.name.trim()) return
                      addAttrChange({ ...newAttr, id: crypto.randomUUID(), value: newAttr.value })
                    }}
                  />
                )}
                {newAttr.attribute_type === 'preset' && newAttr.preset_list_id && (() => {
                  const list = presetLists.find((pl) => pl.id === newAttr.preset_list_id)
                  return list ? (
                    <select
                      value={newAttr.value || ''}
                      onChange={(e) => setNewAttr((a) => ({ ...a, value: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        if (!newAttr.preset_list_id || !newAttr.value) return
                        addAttrChange({ ...newAttr, id: crypto.randomUUID(), value: newAttr.value })
                      }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                    >
                      <option value="">— select value —</option>
                      {list.values.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  ) : null
                })()}
                {newAttr.attribute_type === 'file' && (
                  <div className="flex items-center gap-2">
                    {newAttr.file_ref && (
                      <span className="text-[10px] text-zinc-400 truncate flex-1">{newAttr.file_ref.split('/').pop()}</span>
                    )}
                    <FileAttrInput
                      fileRef={newAttr.file_ref}
                      onChange={(ref) => setNewAttr((a) => ({ ...a, file_ref: ref, value: ref || '' }))}
                      triggerRef={fileUploadTrigger}
                    />
                  </div>
                )}
                {newAttr.attribute_type === 'number' && (
                  <input
                    type="number"
                    step="any"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                    value={newAttr.number_value ?? ''}
                    placeholder="Number value"
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') { setNewAttr((a) => ({ ...a, number_value: null })); return }
                      const n = Number(raw)
                      setNewAttr((a) => ({ ...a, number_value: Number.isFinite(n) ? n : null }))
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      if (!newAttr.name.trim()) return
                      if (newAttr.number_value == null) return
                      addAttrChange({ ...newAttr, id: crypto.randomUUID(), value: '' })
                    }}
                  />
                )}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      if (!newAttr.name.trim() && newAttr.attribute_type !== 'preset') { setAttrNameError('blank'); return }
                      if (newAttr.attribute_type === 'preset' && (!newAttr.preset_list_id || !newAttr.value)) return
                      if (newAttr.attribute_type === 'file' && !newAttr.file_ref) return
                      if (newAttr.attribute_type === 'number' && newAttr.number_value == null) return
                      const existingNames = new Set([
                        ...(effectiveState?.attributes || []).map(a => a.name.trim().toLowerCase()),
                        ...(draftAttrChanges || []).filter(ac => ac.action === 'add' && ac.attribute && !ac.pending_remove).map(ac => ac.attribute.name.trim().toLowerCase()),
                      ])
                      if (existingNames.has(newAttr.name.trim().toLowerCase())) { setAttrNameError('duplicate'); return }
                      setAttrNameError(null)
                      const initialValue = (newAttr.attribute_type === 'text_list' || newAttr.attribute_type === 'entity_list')
                        ? '[]'
                        : (newAttr.attribute_type === 'number' ? '' : newAttr.value)
                      addAttrChange({ ...newAttr, id: crypto.randomUUID(), value: initialValue })
                    }}
                    className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowAddAttr(false); setNewAttr(emptyAttr()); setAttrNameError(null) }}
                    className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {/* Phase 1.22h — Temporary circumstances / motivators for
                this entity at this scene. Read from the SCENE'S
                temporary list (not chain-tracked) and filtered to
                this entity + this section's type. Sorted to the TOP
                of the section so they read as "current scene's
                local additions" before the entity's ongoing rows
                below. Only meaningful at chain anchor (chip /
                modifier mode); origin doesn't have a scene scope. */}
            {!isOrigin && (section.id === 'circumstances' || section.id === 'motivators') && (() => {
              const sceneNode = nodes.find((n) => n.id === nodeId)
              const allTemp = (sceneNode?.data?.entity_temporary_circumstances || [])
              const tempForSection = allTemp.filter(
                (e) => e.entity_id === entityId
                    && e.attribute_type === (section.id === 'circumstances' ? 'circumstance' : 'motivator'),
              )
              const TypeBadgeForSection = section.id === 'circumstances' ? CircumstanceTypeBadge : MotivatorTypeBadge
              const showAddTempForm = section.id === 'circumstances' ? showAddTempCircumstance : showAddTempMotivator
              const newTempForSection = section.id === 'circumstances' ? newTempCircumstance : newTempMotivator
              const setNewTempForSection = section.id === 'circumstances' ? setNewTempCircumstance : setNewTempMotivator
              const tempErrorForSection = section.id === 'circumstances' ? tempCircumstanceError : tempMotivatorError
              const setTempErrorForSection = section.id === 'circumstances' ? setTempCircumstanceError : setTempMotivatorError
              const confirmAddTempForSection = section.id === 'circumstances' ? confirmAddTempCircumstance : confirmAddTempMotivator
              const cancelAddTemp = () => {
                if (section.id === 'circumstances') {
                  setShowAddTempCircumstance(false)
                  setNewTempCircumstance(emptyTempCM('circumstance'))
                  setTempCircumstanceError(null)
                } else {
                  setShowAddTempMotivator(false)
                  setNewTempMotivator(emptyTempCM('motivator'))
                  setTempMotivatorError(null)
                }
              }
              if (tempForSection.length === 0 && !showAddTempForm) return null
              return (
                <div className="mb-2 space-y-1">
                  {showAddTempForm && (
                    <div style={{ border: `1px dashed ${sceneAccentColour}`, borderRadius: 4, padding: 1 }}>
                      <CircumstanceMotivatorForm
                        attributeType={section.id === 'circumstances' ? 'circumstance' : 'motivator'}
                        value={newTempForSection}
                        setValue={setNewTempForSection}
                        error={tempErrorForSection}
                        setError={setTempErrorForSection}
                        onConfirm={confirmAddTempForSection}
                        onCancel={cancelAddTemp}
                        confirmLabel="Add"
                        headerLabel={`New Temporary ${section.id === 'circumstances' ? 'Circumstance' : 'Motivator'}`}
                      />
                    </div>
                  )}
                  {tempForSection.map((entry) => {
                    if (editingTempId === entry.id) {
                      return (
                        <div key={entry.id} style={{ border: `1px dashed ${effectiveState?.colour || '#888888'}`, borderRadius: 4, padding: 1 }}>
                          <CircumstanceMotivatorForm
                            attributeType={entry.attribute_type}
                            value={editingTemp}
                            setValue={setEditingTemp}
                            error={editingTempError}
                            setError={setEditingTempError}
                            onConfirm={confirmEditTemp}
                            onCancel={cancelEditTemp}
                            confirmLabel="Save"
                            headerLabel={`Edit Temporary ${entry.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'}`}
                          />
                        </div>
                      )
                    }
                    return (
                      <div
                        key={entry.id}
                        className="rounded p-1.5"
                        style={{ border: `1px dashed ${effectiveState?.colour || '#888888'}` }}
                      >
                        <div className="flex items-center gap-1 mb-0.5">
                          <span
                            className="text-[10px] flex-1 truncate text-zinc-300 cursor-text hover:text-zinc-100"
                            onClick={() => openEditTemp(entry)}
                            title={`Click to edit this Temporary ${entry.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'}`}
                          >
                            {entry.name?.trim() || (entry.description ? (entry.description.length > 28 ? entry.description.slice(0, 28) + '…' : entry.description) : '(unnamed)')}
                          </span>
                          <button
                            onClick={() => handleConvertTempToOngoing(entry)}
                            className="flex items-center justify-center w-3.5 h-3.5 rounded-sm border border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-accent-500 hover:bg-accent-900/30 hover:text-accent-300 leading-none flex-shrink-0"
                            title={`Make this Temporary ${entry.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'} ongoing from this scene forward`}
                          >
                            <span className="font-bold text-[9px] leading-none">↑</span>
                          </button>
                          <TypeBadgeForSection size={14} temporary temporaryColour={sceneAccentColour} />
                          <button
                            onClick={() => handleRemoveTemp(entry)}
                            className="text-[9px] text-zinc-700 hover:text-red-400 leading-none"
                            title={`Remove this Temporary ${entry.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'}`}
                          >
                            −
                          </button>
                        </div>
                        <div
                          className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                          onClick={() => openEditTemp(entry)}
                          title={`Click to edit this Temporary ${entry.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'}`}
                        >
                          <div className="flex flex-col items-center flex-shrink-0">
                            <IntensityBadge level={entry.intensity ?? null} size={20} temporary temporaryColour={sceneAccentColour} />
                            {entry.intensity != null && (
                              <span className="text-[9px] text-zinc-500 mt-0 leading-none whitespace-nowrap">({INTENSITY_LABELS[entry.intensity]})</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            {entry.description ? (
                              <CollapsibleDescription text={entry.description} textClassName="text-zinc-300" />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            {(() => {
              // Phase 1.26 — apply per-(node, entity, kind) manual sub-chip
              // order for the C / M sections. The Attributes section
              // (non-C/M) keeps its natural insertion order. Reads the
              // order overlay off the active anchor's node data; writes
              // happen via `reorderEntityCMs` when the user drops a row.
              const filtered = effectiveState.attributes.filter((a) => section.typeFilter(a.attribute_type))
              // Phase 4.2 — Attributes section uses the shared
              // attribute_order sort (already memoized above as
              // `orderedEffectiveSectionAttrs`); C/M keep their per-
              // node manual sub-chip order.
              if (section.id === 'attributes') return orderedEffectiveSectionAttrs
              const anchorNode = nodes.find((n) => n.id === nodeId)
              const kind = section.id === 'circumstances' ? 'circumstance' : 'motivator'
              return orderedCMEntriesFromScene(filtered, anchorNode?.data || {}, entityId, kind)
            })().map((attr, attrRowIdx) => {
              const modifyChange       = draftAttrChanges.find((ac) => ac.action === 'modify' && ac.attribute_id === attr.id)
              const removeChange       = draftAttrChanges.find((ac) => ac.action === 'remove' && ac.attribute_id === attr.id)
              const renameChange       = !isOrigin ? draftAttrChanges.find((ac) => ac.action === 'rename' && ac.attribute_id === attr.id) : null
              const addedAtCurrentNode = !isOrigin && !!draftAttrChanges.find((ac) => ac.action === 'add' && ac.attribute?.id === attr.id)
              const savedAsAddedHere   = !isOrigin && !!(savedChangeSource?.attribute_changes || []).find((ac) => ac.action === 'add' && ac.attribute?.id === attr.id)
              if (savedAsAddedHere && !addedAtCurrentNode) return null
              const addEntry           = draftAttrChanges.find((ac) => ac.action === 'add' && ac.attribute?.id === attr.id)
              const hasModify          = !!modifyChange
              const hasRemove          = !!removeChange
              const hasRename          = !!renameChange
              const inheritedAttr      = priorEffectiveState.attributes.find((a) => a.id === attr.id)
              const displayValue       = addEntry ? (addEntry.attribute.value ?? '') : hasModify ? (modifyChange.new_value ?? '') : (inheritedAttr?.value ?? attr.value ?? '')
              const rawDisplayName     = isOrigin && addEntry ? addEntry.attribute.name : (hasRename ? renameChange.new_name : attr.name)
              // For circumstance / motivator rows, fall back to the first
              // ~28 chars of the description when the name is blank — the
              // user can save these with description-only and we still
              // need a label in the row header.
              const isCM_attr = attr.attribute_type === 'circumstance' || attr.attribute_type === 'motivator'
              // Layer draft state on top of chain-resolved effective state
              // for circumstance / motivator rows. `attr` from the loop is
              // chain-resolved from origin to the active anchor using
              // committed projectStore state (the walker reads from
              // `nodes` / `edges`); it does NOT include uncommitted draft
              // modify entries. Without this layer, the row's read-only
              // display would keep showing the OLD intensity / description
              // / name after the user clicked Save in the inline edit
              // dialog (which writes a modify chain entry to the draft)
              // until the user hit the DraftSaveBar Save (which commits
              // the draft to projectStore so the walker picks it up).
              //   - addEntry path: the attribute was added at this anchor
              //     (origin OR added-here). The add entry IS the
              //     attribute's own origin per the chain model — read its
              //     embedded baseline.
              //   - modifyChange path: a draft modify entry exists at
              //     this anchor with new_* per-field overrides. Apply
              //     those on top of `attr` (which is the chain-resolved
              //     value up to and including the previous committed
              //     state at this anchor).
              //   - else: just read `attr.*` (chain-resolved at the
              //     active anchor, no draft modify pending).
              const cmHasNewName = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_name')
              const cmHasNewDesc = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_description')
              const cmHasNewInt  = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_intensity')
              const cmEffectiveName = isCM_attr
                ? (addEntry ? (addEntry.attribute.name || '')
                  : cmHasNewName ? (modifyChange.new_name ?? '')
                  : (attr.name || ''))
                : null
              const cmEffectiveDesc = isCM_attr
                ? (addEntry ? (addEntry.attribute.description || '')
                  : cmHasNewDesc ? (modifyChange.new_description ?? '')
                  : (attr.description || ''))
                : null
              const cmEffectiveIntensity = isCM_attr
                ? (addEntry ? (addEntry.attribute.intensity ?? null)
                  : cmHasNewInt ? (modifyChange.new_intensity ?? null)
                  : (attr.intensity ?? null))
                : null
              // Phase 2.13b — same layering for perspective rows. The
              // chain walker only sees COMMITTED state, so a pending
              // draft modify entry (written by Save in the perspective
              // edit form) wouldn't reach `attr.*` until the writer
              // hits the DraftSaveBar Save. Layer the draft modify on
              // top so the row reflects the just-edited values
              // immediately. `addEntry` path covers the perspective's
              // own origin (mutate add-entry baseline directly);
              // `modifyChange` path covers downstream-anchor edits
              // (modify chain entry with new_description /
              // new_perspective_target_*).
              const isPerspective_attr = attr.attribute_type === 'perspective'
              const pHasNewDesc = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_description')
              const pHasNewKind = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_perspective_target_kind')
              const pHasNewId   = modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_perspective_target_id')
              const perspectiveEffectiveDesc = isPerspective_attr
                ? (addEntry ? (addEntry.attribute.description || '')
                  : pHasNewDesc ? (modifyChange.new_description ?? '')
                  : (attr.description || ''))
                : null
              const perspectiveEffectiveTargetKind = isPerspective_attr
                ? (addEntry ? (addEntry.attribute.perspective_target_kind ?? null)
                  : pHasNewKind ? (modifyChange.new_perspective_target_kind ?? null)
                  : (attr.perspective_target_kind ?? null))
                : null
              const perspectiveEffectiveTargetId = isPerspective_attr
                ? (addEntry ? (addEntry.attribute.perspective_target_id ?? null)
                  : pHasNewId ? (modifyChange.new_perspective_target_id ?? null)
                  : (attr.perspective_target_id ?? null))
                : null
              // Number attribute effective value — same draft-aware layering
              // as the C/M and perspective paths. The value lives on
              // `number_value` (not `value`). An `add` entry at this anchor
              // IS the attribute's origin (read its embedded number_value); a
              // `modify` entry carries `new_number_value`; otherwise read the
              // chain-resolved `attr.number_value`.
              const isNumber_attr = attr.attribute_type === 'number'
              const numHasModify  = isNumber_attr && modifyChange && Object.prototype.hasOwnProperty.call(modifyChange, 'new_number_value')
              const displayNumber = isNumber_attr
                ? (addEntry ? (addEntry.attribute.number_value ?? null)
                  : numHasModify ? (modifyChange.new_number_value ?? null)
                  : (inheritedAttr?.number_value ?? attr.number_value ?? null))
                : null
              const cmDescSource = cmEffectiveDesc || ''
              const cmEffectiveNameTrimmed = (cmEffectiveName || '').trim()
              const trimmedRawName = isCM_attr ? cmEffectiveNameTrimmed : (rawDisplayName || '').trim()
              const displayAttrName = isCM_attr
                ? (cmEffectiveNameTrimmed
                    ? cmEffectiveName
                    : (cmDescSource.trim()
                        ? (cmDescSource.length > 28 ? cmDescSource.slice(0, 28) + '…' : cmDescSource)
                        : cmEffectiveName))
                : (trimmedRawName
                    ? rawDisplayName
                    : rawDisplayName)
              const isEditingThisName  = editingAttrNameId === attr.id

              // Modifier-mode preserved its slightly less-padded badge classes
              // (no `flex-shrink-0` on the type pill). Visually almost identical
              // — kept as-is per no-behaviour-changes rule.
              const typePillClass = `text-[9px] px-1 py-0.5 rounded ${isModifier ? '' : 'flex-shrink-0 '}${ATTR_TYPE_COLOURS[attr.attribute_type] || ''}`

              // Phase 1.26 — drag-to-reorder enabled only for C/M
              // section rows. Skipped on the editing-this-name row so
              // the input doesn't fight with native drag.
              const cmKindForDrag = section.id === 'circumstances'
                ? 'circumstance'
                : section.id === 'motivators' ? 'motivator' : null
              const isDragSource  = cmKindForDrag && draggedAttrCM?.kind === cmKindForDrag && draggedAttrCM?.id === attr.id
              const isDropTarget  = cmKindForDrag && dragOverAttrCM?.kind === cmKindForDrag && dragOverAttrCM?.id === attr.id
              const cmOrderedIds  = cmKindForDrag
                ? (() => {
                    const anchorNode = nodes.find((n) => n.id === nodeId)
                    const filtered = effectiveState.attributes.filter((a) => a.attribute_type === cmKindForDrag)
                    return orderedCMEntriesFromScene(filtered, anchorNode?.data || {}, entityId, cmKindForDrag).map((a) => a.id)
                  })()
                : []
              const dragProps = (cmKindForDrag && !isEditingThisName) ? {
                draggable: true,
                onDragStart: (e) => startAttrCMDrag(cmKindForDrag, attr.id, e),
                onDragOver: (e) => overAttrCMRow(cmKindForDrag, attr.id, e),
                onDrop: (e) => dropOnAttrCMRow(cmKindForDrag, attr.id, cmOrderedIds, e),
                onDragEnd: endAttrCMDrag,
              } : {}
              const dragVisualClass = cmKindForDrag
                ? ` cursor-grab active:cursor-grabbing${isDragSource ? ' opacity-40' : ''}`
                : ''
              // Phase 4.2 — Attributes-section rows get a grip-handle
              // reorder (shared `attrReorder` hook). The hook index IS
              // the map index here because the attributes section maps
              // over `orderedEffectiveSectionAttrs`. C/M sections keep
              // their own whole-row drag above; the two never both
              // apply to one row.
              const isAttrRow = section.id === 'attributes'
              const attrIndicator = isAttrRow ? attrReorder.indicatorStyle(attrRowIdx, false) : null
              return (
                <div key={attr.id}>
                {/* Insertion line indicator — same affordance the
                    scene-node entity-chip drag uses to show where the
                    dragged row will land. Only emitted in C/M sections
                    when this row is the current drop target. */}
                {cmKindForDrag && (
                  <div style={{ height: 0, borderTop: isDropTarget ? `2px solid ${sceneAccentColour}` : '2px solid transparent', marginBottom: isDropTarget ? 2 : 0 }} />
                )}
                <div
                  {...dragProps}
                  {...(isAttrRow ? attrReorder.rowDropProps(attrRowIdx) : {})}
                  className={`mb-2 px-1.5 py-1 rounded border border-zinc-800${dragVisualClass}`}
                  style={attrIndicator || undefined}
                >
                  <div className="flex items-center gap-1 mb-0.5">
                    {isAttrRow && (
                      <span
                        {...attrReorder.gripProps(attrRowIdx)}
                        title="Drag to reorder this attribute"
                        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing flex-shrink-0 select-none leading-none"
                        style={{ fontSize: 11 }}
                      >⠿</span>
                    )}
                    {attr.attribute_type === 'perspective' ? (
                      // Perspective rows: the "name slot" is occupied by
                      // the target identity badge — perspectives have no
                      // name field of their own; the target IS the
                      // perspective's identity in the row header. Falls
                      // back to a muted "(deleted target)" string when
                      // the target was cascade-orphaned (cascade contract
                      // from Phase 2.13 planning doc, decision 3). Reads
                      // perspectiveEffectiveTarget* (draft-aware layer)
                      // so a pending modify entry's new target shows
                      // immediately, before the writer commits the draft.
                      <div className="flex-1 min-w-0 flex items-center">
                        {(() => {
                          const k  = perspectiveEffectiveTargetKind
                          const id = perspectiveEffectiveTargetId
                          if (!k || !id) {
                            return <span className="text-[10px] text-zinc-500 italic">(deleted target)</span>
                          }
                          if (k === 'knowledge') {
                            const kn = useProjectStore.getState().knowledges?.find((x) => x.id === id)
                            return <KnowledgeLabelChip name={kn?.name || '(missing)'} />
                          }
                          if (k === 'relationship') {
                            const r = useProjectStore.getState().relationships?.find((x) => x.id === id)
                            let label = '(missing)'
                            if (r) {
                              if (r.title?.trim()) label = r.title.trim()
                              else {
                                const joins = (r.history?.participant_changes || []).filter((c) => c.action === 'join').map((c) => c.entity_id)
                                const uniq  = Array.from(new Set(joins))
                                const names = uniq.slice(0, 2).map((eid) => useEntitiesStore.getState().getEntityById(eid)?.name || '?')
                                label = uniq.length <= 2 ? names.join(' ↔ ') : `${names.join(' ↔ ')} + ${uniq.length - 2} more`
                              }
                            }
                            return <RelationshipLabelChip name={label} />
                          }
                          const e = useEntitiesStore.getState().getEntityById(id)
                          return e
                            ? <EntityLabelChip entity={e} />
                            : <span className="text-[10px] text-zinc-500 italic">(deleted target)</span>
                        })()}
                      </div>
                    ) : isEditingThisName ? (
                      <input
                        autoFocus
                        className="flex-1 min-w-0 bg-zinc-800 border border-zinc-500 rounded px-1 py-0 text-[10px] text-zinc-200 focus:outline-none focus:border-accent-500"
                        value={editingAttrNameValue}
                        onChange={(e) => setEditingAttrNameValue(e.target.value)}
                        onBlur={() => commitAttrNameEdit(attr.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitAttrNameEdit(attr.id) }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingAttrNameId(null) }
                        }}
                      />
                    ) : (
                      // Preset-type rows: name is derived from the preset
                      // list's name, not independently editable. Render the
                      // name as plain non-interactive text. Other types
                      // remain click-to-rename.
                      attr.attribute_type === 'preset' ? (
                        <span
                          className={`text-[10px] flex-1 truncate ${hasRemove ? 'text-zinc-600 line-through' : 'text-zinc-500'}`}
                          title={hasRemove ? undefined : 'Preset name comes from the preset list'}
                        >
                          {displayAttrName}
                        </span>
                      ) : (
                        <span
                          className={`text-[10px] flex-1 truncate ${hasRemove ? 'text-zinc-600 line-through' : 'text-zinc-500 cursor-text hover:text-zinc-300'}`}
                          onClick={() => {
                            if (!hasRemove) {
                              setEditingAttrNameId(attr.id)
                              setEditingAttrNameValue(displayAttrName)
                              // Capture the chain-resolved displayed name at
                              // edit-start so commitAttrNameEdit can no-op
                              // when the user blurs out without changing it.
                              setEditingAttrNameOriginal(displayAttrName)
                            }
                          }}
                          title={!hasRemove ? 'Click to rename' : undefined}
                        >
                          {displayAttrName}
                        </span>
                      )
                    )}
                    {/* Invisible spacer matching the temp row's leading
                        ↑-button slot, so the C/M type badge in ongoing
                        rows lines up horizontally with the type badge
                        in temp rows. Only emitted for C/M attribute
                        types (other types don't render alongside
                        temporaries so the spacer would be wasted). */}
                    {(attr.attribute_type === 'circumstance' || attr.attribute_type === 'motivator') && (
                      <span className="w-3.5 flex-shrink-0" aria-hidden="true" />
                    )}
                    {attr.attribute_type === 'circumstance' ? (
                      <CircumstanceTypeBadge size={14} />
                    ) : attr.attribute_type === 'motivator' ? (
                      <MotivatorTypeBadge size={14} />
                    ) : attr.attribute_type === 'perspective' ? (
                      <PerspectiveTypeBadge size={14} />
                    ) : (
                      <span className={typePillClass}>
                        {attr.attribute_type}
                      </span>
                    )}
                    {addedAtCurrentNode && <ChangeBadge action="add" />}
                    {hasModify && <ChangeBadge action="modify" />}
                    {hasRemove && <ChangeBadge action="remove" />}
                    {hasRename && <ChangeBadge action="rename" />}
                    {hasModify && (
                      <button
                        onClick={() => clearAttrOverride(attr.id)}
                        className="text-[9px] text-zinc-600 hover:text-red-400"
                        title="Clear override"
                      >
                        ✕
                      </button>
                    )}
                    {hasRename && (
                      <button
                        onClick={() => clearAttrRename(attr.id)}
                        className="text-[9px] text-zinc-600 hover:text-red-400"
                        title="Clear rename"
                      >
                        ✕
                      </button>
                    )}
                    {hasRemove ? (
                      <button
                        onClick={() => undoAttrRemove(attr.id)}
                        className="text-[9px] text-amber-500 hover:text-amber-300"
                        title="Undo remove"
                      >
                        ↩
                      </button>
                    ) : addedAtCurrentNode ? (
                      <button
                        onClick={async () => {
                          const result = await confirm({
                            title: 'Delete attribute',
                            message: 'This will delete this attribute from this point in the chain — all downstream uses will also be removed.\n\nContinue?',
                            buttons: [
                              { label: 'Delete', value: 'delete', style: 'danger'  },
                              { label: 'Cancel', value: 'cancel', style: 'neutral' },
                            ],
                          })
                          if (result !== 'delete') return
                          // Two paths:
                          //   - The 'add' chain entry is already committed
                          //     to projectStore (saved at this anchor in a
                          //     prior session) → commit the revoke directly
                          //     via a projectStore action so undo / redo
                          //     can revert it cleanly. Do NOT also strip
                          //     the local draft: the row's visibility is
                          //     computed from `effectiveState.attributes`
                          //     (chain-resolved from committed state), so
                          //     the row hides itself when committed loses
                          //     the entry and reappears when undo restores
                          //     it. Stripping the draft as well would force
                          //     `addedAtCurrentNode=false` which combines
                          //     with `savedAsAddedHere=true` after undo to
                          //     hide the row even though committed has it
                          //     back.
                          //   - The 'add' is still draft-only (added but
                          //     not yet saved this session) → mutate the
                          //     draft in-place. No projectStore change, no
                          //     undo entry needed.
                          const wasCommitted = !!(savedChangeSource?.attribute_changes || []).find(
                            (ac) => ac.action === 'add' && ac.attribute?.id === attr.id
                          )
                          if (wasCommitted) {
                            const ps = useProjectStore.getState()
                            if (isModifier) {
                              ps.revokeAttributeAddAtModifier(nodeId, entityId, attr.id)
                            } else {
                              ps.revokeAttributeAddAtChainAnchor(nodeId, entityId, attr.id)
                            }
                          } else {
                            revokeAttrAdd(attr.id)
                          }
                        }}
                        className="text-[9px] text-zinc-600 hover:text-red-400"
                        title={`Revoke add — removes this ${
                          attr.attribute_type === 'circumstance' ? 'circumstance'
                          : attr.attribute_type === 'motivator' ? 'motivator'
                          : 'attribute'
                        } from this point forward`}
                      >
                        ✕
                      </button>
                    ) : (
                      !hasModify && (
                        <button
                          onClick={() => removeAttrChange(attr.id)}
                          className="text-[9px] text-zinc-700 hover:text-red-400"
                          title={(() => {
                            const kind = attr.attribute_type === 'circumstance' ? 'circumstance'
                              : attr.attribute_type === 'motivator' ? 'motivator'
                              : 'attribute'
                            return isModifier ? `Remove ${kind} here` : `Remove ${kind} at this scene`
                          })()}
                        >
                          −
                        </button>
                      )
                    )}
                  </div>

                  {hasRemove ? (
                    <p className="text-[9px] text-red-400 italic">Removed at this point</p>
                  ) : attr.attribute_type === 'text' ? (
                    <>
                      <ExpandableTextField
                        className={`bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none focus:border-accent-500 ${
                          hasModify ? 'border-zinc-500 text-zinc-100' : 'border-zinc-700 text-zinc-400'
                        }`}
                        value={displayValue}
                        placeholder={inheritedAttr?.value || ''}
                        extraProps={{
                          'data-ovum-teal-scarecrow':
                            (entity?.type === 'item'
                              && ['ocarina','ocarina of time'].includes((entity?.name || '').trim().toLowerCase())
                              && (attr.name || '').trim().toLowerCase() === "scarecrow's song")
                              ? 'yes' : undefined,
                        }}
                        onChange={(e) => setAttrOverride(attr.id, e.target.value)}
                        onKeyDown={(e) => {
                          ovumTealHandleAttributeKeydown({
                            entity,
                            attributeName: attr.name,
                            event: e,
                            value: displayValue,
                            onChange: (next) => setAttrOverride(attr.id, next),
                          })
                        }}
                      />
                      {hasModify && inheritedAttr && (
                        <div className="text-[9px] text-zinc-600 italic mt-0.5">
                          ↳ was: &ldquo;{inheritedAttr.value || '(empty)'}&rdquo;
                        </div>
                      )}
                    </>
                  ) : attr.attribute_type === 'preset' ? (
                    <>
                      <select
                        value={displayValue}
                        onChange={(e) => setAttrOverride(attr.id, e.target.value)}
                        className={`w-full bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none focus:border-accent-500 ${
                          hasModify ? 'border-zinc-500 text-zinc-100' : 'border-zinc-700 text-zinc-400'
                        }`}
                      >
                        <option value="">— select —</option>
                        {(presetLists.find((pl) => pl.id === attr.preset_list_id)?.values || []).map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                      {hasModify && inheritedAttr && (
                        <div className="text-[9px] text-zinc-600 italic mt-0.5">
                          ↳ was: &ldquo;{inheritedAttr.value || '(none)'}&rdquo;
                        </div>
                      )}
                    </>
                  ) : attr.attribute_type === 'number' ? (
                    <>
                      <input
                        type="number"
                        value={displayNumber ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') { setAttrNumberOverride(attr.id, null); return }
                          const n = Number(raw)
                          setAttrNumberOverride(attr.id, Number.isFinite(n) ? n : null)
                        }}
                        className={`w-full bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none focus:border-accent-500 ${
                          numHasModify ? 'border-zinc-500 text-zinc-100' : 'border-zinc-700 text-zinc-400'
                        }`}
                      />
                      {numHasModify && inheritedAttr && (
                        <div className="text-[9px] text-zinc-600 italic mt-0.5">
                          ↳ was: {inheritedAttr.number_value != null ? formatNumberForChip(inheritedAttr.number_value) : '(none)'}
                        </div>
                      )}
                    </>
                  ) : attr.attribute_type === 'file' ? (() => {
                    const draftFileRefChange = modifyChange?.file_ref_change
                    const hasDraftFileOverride = draftFileRefChange !== undefined && draftFileRefChange !== null
                    const displayFileRef = hasDraftFileOverride
                      ? (draftFileRefChange === '' ? null : draftFileRefChange)
                      : (attr.file_ref || null)
                    const inheritedFileRef = inheritedAttr?.file_ref || null
                    const uploadingThis = mediaReplaceUploading === attr.id
                    const dot = displayFileRef ? displayFileRef.lastIndexOf('.') : -1
                    const ext = dot !== -1 ? displayFileRef.slice(dot + 1).toLowerCase() : ''
                    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)
                    const hoverSrc = isImage && displayFileRef ? `/api/project/assets/${displayFileRef.replace(/^assets\//, '')}` : null
                    const eyeButton = displayFileRef ? (
                      <button
                        onClick={() => togglePreview({
                          type: 'attribute',
                          entityId,
                          attributeId: attr.id,
                          atNodeId: nodeId,
                          fileRef: displayFileRef,
                          attributeName: attr.name,
                          entityName: effectiveState.name,
                          entityColour: effectiveState.colour,
                          profileImageRef: effectiveState.profile_image_ref,
                        })}
                        title="Open in Media Preview Panel (click again to close)"
                        className="flex-shrink-0 text-zinc-500 hover:text-accent-400 transition-colors"
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
                          <circle cx="8" cy="8" r="2" />
                        </svg>
                      </button>
                    ) : null
                    const replaceTitle = uploadingThis
                      ? 'Uploading…'
                      : isOrigin
                        ? 'Change media file'
                        : isModifier
                          ? 'Replace at this modifier node'
                          : 'Replace at this chain position'
                    return (
                      <div className="flex items-center gap-1.5">
                        {displayFileRef ? (
                          <span className="text-[10px] text-zinc-400 truncate flex-1" title={displayFileRef}>
                            {displayFileRef.split('/').pop()}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-600 italic flex-1">no media</span>
                        )}
                        {eyeButton && hoverSrc && (
                          <ImageHoverPreview src={hoverSrc} borderColour={effectiveState.colour} size={120}>
                            {eyeButton}
                          </ImageHoverPreview>
                        )}
                        {eyeButton && !hoverSrc && eyeButton}
                        <button
                          onClick={() => handleMediaReplaceClick(attr.id)}
                          disabled={uploadingThis}
                          title={replaceTitle}
                          className="flex-shrink-0 text-zinc-500 hover:text-accent-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V6" />
                            <path d="M2 13.5 3.5 7h12l-1.5 6.5a1 1 0 0 1-1 .5H3a1 1 0 0 1-1-.5z" />
                          </svg>
                        </button>
                        {hasDraftFileOverride && (
                          <button
                            onClick={() => clearAttrOverride(attr.id)}
                            className="text-[9px] text-zinc-600 hover:text-red-400 flex-shrink-0"
                            title={inheritedFileRef ? `Revert to inherited: ${inheritedFileRef.split('/').pop()}` : 'Clear override'}
                          >
                            ↩
                          </button>
                        )}
                      </div>
                    )
                  })() : attr.attribute_type === 'text_list' ? (() => {
                    const { adds, removes } = getTextListPendingSets(attr.id, draftAttrChanges)
                    const draftAdd = draftAttrChanges.find((ac) => ac.action === 'add' && ac.attribute?.id === attr.id)
                    const items = parseListValue(draftAdd ? draftAdd.attribute.value : attr.value)
                    return (
                      <TextListAttribute
                        attr={attr}
                        effectiveItems={items}
                        pendingAdds={adds}
                        pendingRemoves={removes}
                        onAdd={(item) => addListItem(attr.id, item)}
                        onRemove={(item) => removeListItem(attr.id, item)}
                      />
                    )
                  })() : attr.attribute_type === 'entity_list' ? (() => {
                    const { adds, removes } = getTextListPendingSets(attr.id, draftAttrChanges)
                    const draftAdd = draftAttrChanges.find((ac) => ac.action === 'add' && ac.attribute?.id === attr.id)
                    const items = parseListValue(draftAdd ? draftAdd.attribute.value : attr.value)
                    return (
                      <EntityListAttribute
                        attr={attr}
                        effectiveItems={items}
                        pendingAdds={adds}
                        pendingRemoves={removes}
                        atNodeId={nodeId}
                        onAdd={(refId) => addListItem(attr.id, refId)}
                        onRemove={(refId) => removeListItem(attr.id, refId)}
                        onNavigate={navigateToReferencedEntity}
                      />
                    )
                  })() : (attr.attribute_type === 'circumstance' || attr.attribute_type === 'motivator') ? (
                    editingCMAttrId === attr.id ? (
                      /* Edit mode — same form used for + Add. On confirm,
                         setAttrCMOverride routes chain-aware: mutates the
                         add entry's embedded attribute when at the
                         attribute's own origin / added-here, writes a
                         modify chain entry at downstream anchors. */
                      <CircumstanceMotivatorForm
                        attributeType={attr.attribute_type}
                        value={editingCM}
                        setValue={setEditingCM}
                        error={editingCMError}
                        setError={setEditingCMError}
                        onConfirm={confirmEditCM}
                        onCancel={cancelEditCM}
                        confirmLabel="Save"
                        headerLabel={attr.attribute_type === 'motivator' ? 'Edit Motivator' : 'Edit Circumstance'}
                      />
                    ) : (
                      /* Read-only display row. Reads cmEffective* — the
                         chain-resolved-PLUS-pending-draft layered view
                         at the active anchor. Click body to enter edit. */
                      <div
                        className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                        onClick={() => openEditCM({
                          id: attr.id,
                          name:        cmEffectiveName,
                          description: cmEffectiveDesc,
                          intensity:   cmEffectiveIntensity,
                        })}
                        title="Click to edit"
                      >
                        <div className="flex flex-col items-center flex-shrink-0">
                          <IntensityBadge level={cmEffectiveIntensity} size={20} />
                          {cmEffectiveIntensity != null && (
                            <span className="text-[9px] text-zinc-500 mt-0 leading-none whitespace-nowrap">({INTENSITY_LABELS[cmEffectiveIntensity]})</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {cmEffectiveDesc ? (
                            <CollapsibleDescription text={cmEffectiveDesc} textClassName="text-zinc-300" />
                          ) : null}
                        </div>
                      </div>
                    )
                  ) : attr.attribute_type === 'perspective' ? (
                    editingPerspectiveAttrId === attr.id ? (
                      /* Edit mode — same field layout as the +ADD form
                         (target on top, description below) but pre-
                         filled from the chain-resolved current values.
                         On Save, confirmEditPerspective routes chain-
                         aware via setAttrPerspectiveOverride: mutates
                         the add entry's embedded baseline at the
                         perspective's own origin, writes a `modify`
                         chain entry with `new_description` /
                         `new_perspective_target_*` downstream. */
                      <div className="border border-zinc-600 rounded p-2 space-y-1.5">
                        <div className="flex items-center gap-1">
                          <PerspectiveTypeBadge size={14} />
                          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Edit Perspective</span>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-0.5">Perspective on</div>
                          {editingPerspective.perspective_target_id ? (
                            (() => {
                              const changeTarget = () => {
                                setEditingPerspective((p) => ({ ...p, perspective_target_kind: null, perspective_target_id: null }))
                                setEditingPerspectivePickerOpen(true)
                              }
                              const k  = editingPerspective.perspective_target_kind
                              const id = editingPerspective.perspective_target_id
                              if (k === 'knowledge') {
                                const kn = useProjectStore.getState().knowledges?.find((x) => x.id === id)
                                return <KnowledgeLabelChip size="lg" name={kn?.name || '(missing)'} onClick={changeTarget} />
                              }
                              if (k === 'relationship') {
                                const r = useProjectStore.getState().relationships?.find((x) => x.id === id)
                                let label = '(missing)'
                                if (r) {
                                  if (r.title?.trim()) label = r.title.trim()
                                  else {
                                    const joins = (r.history?.participant_changes || []).filter((c) => c.action === 'join').map((c) => c.entity_id)
                                    const uniq  = Array.from(new Set(joins))
                                    const names = uniq.slice(0, 2).map((eid) => useEntitiesStore.getState().getEntityById(eid)?.name || '?')
                                    label = uniq.length <= 2 ? names.join(' ↔ ') : `${names.join(' ↔ ')} + ${uniq.length - 2} more`
                                  }
                                }
                                return <RelationshipLabelChip size="lg" name={label} onClick={changeTarget} />
                              }
                              const e = useEntitiesStore.getState().getEntityById(id)
                              return e
                                ? <EntityLabelChip size="lg" entity={e} onClick={changeTarget} />
                                : <span className="text-[11px] text-zinc-500 italic">(missing)</span>
                            })()
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingPerspectivePickerOpen((v) => !v)}
                              className={`w-full px-2 py-1 rounded border text-[11px] text-left transition-colors ${editingPerspectiveError === 'noTarget' ? 'border-red-500 text-red-300' : 'border-zinc-700 text-accent-400 hover:border-accent-500'}`}
                            >
                              {editingPerspectivePickerOpen ? '× Close picker' : '+ Pick target…'}
                            </button>
                          )}
                          {editingPerspectivePickerOpen && !editingPerspective.perspective_target_id && (
                            <div className="mt-1">
                              <PerspectiveTargetPicker
                                onPick={({ kind, id }) => {
                                  setEditingPerspective((p) => ({ ...p, perspective_target_kind: kind, perspective_target_id: id }))
                                  setEditingPerspectivePickerOpen(false)
                                  if (editingPerspectiveError === 'noTarget') setEditingPerspectiveError(null)
                                }}
                                onClose={() => setEditingPerspectivePickerOpen(false)}
                              />
                            </div>
                          )}
                        </div>
                        <textarea
                          className={`w-full bg-zinc-800 border ${editingPerspectiveError === 'noDescription' ? 'border-red-500' : 'border-zinc-700'} rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500`}
                          rows={3}
                          value={editingPerspective.description}
                          placeholder="Description (the perspective)"
                          onChange={(e) => { setEditingPerspective((p) => ({ ...p, description: e.target.value })); if (editingPerspectiveError === 'noDescription') setEditingPerspectiveError(null) }}
                        />
                        {editingPerspectiveError === 'noDescription' && (
                          <p className="text-[9px] text-red-400 whitespace-nowrap">A perspective needs a description.</p>
                        )}
                        {editingPerspectiveError === 'noTarget' && (
                          <p className="text-[9px] text-red-400 whitespace-nowrap">Pick a target for this perspective.</p>
                        )}
                        <div className="flex gap-1.5">
                          <button
                            onClick={confirmEditPerspective}
                            className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-2 py-1"
                          >
                            Save
                          </button>
                          <button
                            onClick={cancelEditPerspective}
                            className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Read-only display. Click body to enter edit.
                         Reads perspectiveEffectiveDesc (draft-aware
                         layer) so a pending modify entry's
                         new_description shows immediately, before the
                         writer commits the draft. */
                      <div
                        className="text-xs text-zinc-300 cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                        onClick={() => openEditPerspective({
                          id: attr.id,
                          description: perspectiveEffectiveDesc,
                          perspective_target_kind: perspectiveEffectiveTargetKind,
                          perspective_target_id: perspectiveEffectiveTargetId,
                        })}
                        title="Click to edit"
                      >
                        {perspectiveEffectiveDesc
                          ? <CollapsibleDescription text={perspectiveEffectiveDesc} />
                          : <span className="text-zinc-500 italic whitespace-pre-wrap break-words">(no description)</span>}
                      </div>
                    )
                  ) : (
                    <div className="text-xs text-zinc-500 italic">
                      {attr.value || <em>no value</em>}
                    </div>
                  )}
                </div>
                </div>
              )
            })}
            {/* Trailing drop-zone insertion-line indicator for the C/M
                effective-rows list — only emitted while dragging within
                this kind. Lets the writer drop past the last row to
                append. Mirrors the SceneCircumstancesView pattern. */}
            {(section.id === 'circumstances' || section.id === 'motivators') && draggedAttrCM?.kind === (section.id === 'circumstances' ? 'circumstance' : 'motivator') && (() => {
              const kind = section.id === 'circumstances' ? 'circumstance' : 'motivator'
              const anchorNode = nodes.find((n) => n.id === nodeId)
              const filtered = effectiveState.attributes.filter((a) => a.attribute_type === kind)
              const orderedIds = orderedCMEntriesFromScene(filtered, anchorNode?.data || {}, entityId, kind).map((a) => a.id)
              return (
                <div
                  onDragOver={(e) => overAttrCMRow(kind, '__end__', e)}
                  onDrop={(e) => dropOnAttrCMRow(kind, '__end__', orderedIds, e)}
                  onDragEnd={endAttrCMDrag}
                  className="h-3 rounded mb-2"
                  style={{ borderTop: dragOverAttrCM?.id === '__end__' && dragOverAttrCM?.kind === kind ? `2px solid ${sceneAccentColour}` : '2px solid transparent' }}
                />
              )
            })()}

            {/* Pending +ADD entries (excludes origin entries marked pending-remove) */}
            {(section.id === 'attributes'
              ? orderedAddSectionAcs
              : draftAttrChanges.filter((ac) => ac.action === 'add' && ac.attribute && !ac.pending_remove && !effectiveState.attributes.some((a) => a.id === ac.attribute.id) && section.typeFilter(ac.attribute.attribute_type))
            ).map((ac, addRowIdx) => {
              // Phase 2.13d follow-up — perspective drafts render with
              // their own card shape (target chip header + description
              // body + ✚ ADDED badge), NOT the generic attribute name +
              // value layout. Without this branch, an orphaned-target
              // perspective in pending-add state would surface as a
              // weird "Attribute name" input row in the Perspectives
              // section with no way to see / fix the orphaned target.
              // Reuses the existing add-form picker state slot
              // (`perspectiveTargetPickerOpen`) since at most one draft
              // perspective can be open in the picker at a time.
              if (ac.attribute.attribute_type === 'perspective') {
                const draftKind = ac.attribute.perspective_target_kind ?? null
                const draftId   = ac.attribute.perspective_target_id ?? null
                const draftDesc = ac.attribute.description || ''
                const dismiss = () => {
                  if (isOrigin) {
                    setDraft((d) => {
                      const base = d ?? initDraft()
                      return {
                        ...base,
                        attribute_changes: base.attribute_changes.map((x) =>
                          x.action === 'add' && x.attribute?.id === ac.attribute.id
                            ? { ...x, pending_remove: true }
                            : x,
                        ),
                      }
                    })
                  } else {
                    setDraft((d) => {
                      const base     = d ?? initDraft()
                      const newDraft = { ...base, attribute_changes: base.attribute_changes.filter((x) => !(x.action === 'add' && x.attribute?.id === ac.attribute.id)) }
                      return draftIsClean(newDraft) ? null : newDraft
                    })
                  }
                }
                return (
                  <div key={ac.attribute.id} className="mb-2 border border-green-900/30 rounded p-1.5 space-y-1.5">
                    <div className="flex items-center gap-1">
                      <PerspectiveTypeBadge size={14} />
                      <span className="text-[10px] text-zinc-400 uppercase tracking-wider flex-1">Perspective</span>
                      <ChangeBadge action="add" />
                      <button
                        onClick={dismiss}
                        className="text-[9px] text-zinc-600 hover:text-red-400"
                        title="Remove this perspective"
                      >
                        ✕
                      </button>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-0.5">Perspective on</div>
                      {draftId ? (
                        (() => {
                          const changeTarget = () => updateAddedAttr(ac.attribute.id, {
                            perspective_target_kind: null,
                            perspective_target_id: null,
                          })
                          if (draftKind === 'knowledge') {
                            const kn = useProjectStore.getState().knowledges?.find((x) => x.id === draftId)
                            return <KnowledgeLabelChip size="lg" name={kn?.name || '(deleted target)'} onClick={changeTarget} />
                          }
                          if (draftKind === 'relationship') {
                            const r = useProjectStore.getState().relationships?.find((x) => x.id === draftId)
                            let label = '(deleted target)'
                            if (r) {
                              if (r.title?.trim()) label = r.title.trim()
                              else {
                                const joins = (r.history?.participant_changes || []).filter((c) => c.action === 'join').map((c) => c.entity_id)
                                const uniq  = Array.from(new Set(joins))
                                const names = uniq.slice(0, 2).map((eid) => useEntitiesStore.getState().getEntityById(eid)?.name || '?')
                                label = uniq.length <= 2 ? names.join(' ↔ ') : `${names.join(' ↔ ')} + ${uniq.length - 2} more`
                              }
                            }
                            return <RelationshipLabelChip size="lg" name={label} onClick={changeTarget} />
                          }
                          const e = useEntitiesStore.getState().getEntityById(draftId)
                          return e
                            ? <EntityLabelChip size="lg" entity={e} onClick={changeTarget} />
                            : (
                              // Target id is set but resolves to nothing
                              // → the object was deleted out from under
                              // this pending-add draft. Surface it as
                              // an orphan so the writer can rewire.
                              <button
                                type="button"
                                onClick={changeTarget}
                                className="px-2 py-1 rounded border border-amber-500/50 text-[11px] text-amber-300 hover:bg-amber-900/20 transition-colors"
                              >
                                (deleted target) — click to rewire
                              </button>
                            )
                        })()
                      ) : draftPerspectivePickerOpenId === ac.attribute.id ? (
                        <PerspectiveTargetPicker
                          onPick={({ kind, id }) => {
                            updateAddedAttr(ac.attribute.id, {
                              perspective_target_kind: kind,
                              perspective_target_id: id,
                            })
                            setDraftPerspectivePickerOpenId(null)
                          }}
                          onClose={() => setDraftPerspectivePickerOpenId(null)}
                        />
                      ) : (
                        // Compact null-target badge — amber warning
                        // triangle inside a badge-shaped button. Saves
                        // vertical space vs always-on inline picker;
                        // click to expand the picker, ✕ inside the
                        // picker (or picking a target) collapses back
                        // to this badge state.
                        <button
                          type="button"
                          onClick={() => setDraftPerspectivePickerOpenId(ac.attribute.id)}
                          className="inline-flex items-center gap-1 pl-0.5 pr-1.5 py-0 rounded text-xs font-medium align-middle hover:brightness-125 cursor-pointer"
                          style={{ border: '1px solid #f59e0b66', backgroundColor: '#f59e0b18' }}
                          title="No target picked — click to pick"
                        >
                          <span
                            className="inline-flex items-center justify-center flex-shrink-0 text-amber-400"
                            style={{ width: 14, height: 14, fontSize: 14, lineHeight: 1 }}
                            aria-hidden="true"
                          >⚠</span>
                          <span className="text-amber-300 truncate">No target</span>
                        </button>
                      )}
                    </div>
                    <textarea
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] italic text-zinc-300 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500"
                      rows={3}
                      value={draftDesc}
                      placeholder="Description (the perspective)"
                      onChange={(e) => updateAddedAttr(ac.attribute.id, { description: e.target.value })}
                    />
                  </div>
                )
              }
              // Phase 4.2 — draft-add attribute rows share the
              // `attrReorder` index space, offset past the effective
              // rows (`_effAttrCount + addRowIdx`), so the grip handle
              // reorders across both regions. Only the Attributes
              // section participates; C/M/perspective add rows render
              // here too but are gated out.
              const isAddAttrRow = section.id === 'attributes'
              const addReorderIdx = _effAttrCount + addRowIdx
              const addAttrIndicator = isAddAttrRow ? attrReorder.indicatorStyle(addReorderIdx, false) : null
              return (
              <div
                key={ac.attribute.id}
                {...(isAddAttrRow ? attrReorder.rowDropProps(addReorderIdx) : {})}
                className="mb-2 border border-green-900/30 rounded p-1.5"
                style={addAttrIndicator || undefined}
              >
                <div className="flex items-center gap-1 mb-0.5">
                  {isAddAttrRow && (
                    <span
                      {...attrReorder.gripProps(addReorderIdx)}
                      title="Drag to reorder this attribute"
                      className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing flex-shrink-0 select-none leading-none"
                      style={{ fontSize: 11 }}
                    >⠿</span>
                  )}
                  {isOrigin && ac.attribute.attribute_type !== 'preset' ? (
                    <input
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500 min-w-0"
                      value={ac.attribute.name}
                      placeholder="Attribute name"
                      onChange={(e) => updateAddedAttr(ac.attribute.id, { name: e.target.value })}
                    />
                  ) : (
                    <span className="text-[10px] text-zinc-300 flex-1 truncate">{ac.attribute.name}</span>
                  )}
                  {/* Origin / chip render the type pill on +ADD entries; modifier
                      omits it (preserved per-anchor as in the originals). */}
                  {!isModifier && (
                    ac.attribute.attribute_type === 'circumstance' ? (
                      <CircumstanceTypeBadge size={14} />
                    ) : ac.attribute.attribute_type === 'motivator' ? (
                      <MotivatorTypeBadge size={14} />
                    ) : (
                      <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${ATTR_TYPE_COLOURS[ac.attribute.attribute_type] || ''}`}>
                        {ac.attribute.attribute_type}
                      </span>
                    )
                  )}
                  <ChangeBadge action="add" />
                  <button
                    onClick={() => {
                      if (isOrigin) {
                        // Mark as pending-remove for review-on-Save
                        setDraft((d) => {
                          const base = d ?? initDraft()
                          return {
                            ...base,
                            attribute_changes: base.attribute_changes.map((x) =>
                              x.action === 'add' && x.attribute?.id === ac.attribute.id
                                ? { ...x, pending_remove: true }
                                : x
                            ),
                          }
                        })
                      } else {
                        setDraft((d) => {
                          const base     = d ?? initDraft()
                          const newDraft = { ...base, attribute_changes: base.attribute_changes.filter((x) => !(x.action === 'add' && x.attribute?.id === ac.attribute.id)) }
                          return draftIsClean(newDraft) ? null : newDraft
                        })
                      }
                    }}
                    className="text-[9px] text-zinc-600 hover:text-red-400"
                    title="Remove this addition"
                  >
                    ✕
                  </button>
                </div>
                {isOrigin ? (
                  <>
                    {ac.attribute.attribute_type === 'text' && (
                      <ExpandableTextField
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                        value={ac.attribute.value || ''}
                        placeholder="Value…"
                        extraProps={{
                          'data-ovum-teal-scarecrow':
                            (entity?.type === 'item'
                              && ['ocarina','ocarina of time'].includes((entity?.name || '').trim().toLowerCase())
                              && (ac.attribute?.name || '').trim().toLowerCase() === "scarecrow's song")
                              ? 'yes' : undefined,
                        }}
                        onChange={(e) => updateAddedAttr(ac.attribute.id, { value: e.target.value })}
                      />
                    )}
                    {ac.attribute.attribute_type === 'preset' && (
                      <select
                        value={ac.attribute.value || ''}
                        onChange={(e) => updateAddedAttr(ac.attribute.id, { value: e.target.value })}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                      >
                        <option value="">— select —</option>
                        {(presetLists.find((pl) => pl.id === ac.attribute.preset_list_id)?.values || []).map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    )}
                    {ac.attribute.attribute_type === 'file' && (
                      <div className="flex items-center gap-2">
                        {ac.attribute.file_ref && (
                          <span className="text-[10px] text-zinc-400 truncate flex-1" title={ac.attribute.file_ref}>
                            {ac.attribute.file_ref.split('/').pop()}
                          </span>
                        )}
                        {ac.attribute.file_ref && (
                          <button
                            onClick={() => togglePreview({
                              type: 'attribute',
                              entityId,
                              attributeId: ac.attribute.id,
                              atNodeId: nodeId,
                              fileRef: ac.attribute.file_ref,
                              attributeName: ac.attribute.name,
                              entityName: effectiveState.name,
                              entityColour: effectiveState.colour,
                              profileImageRef: effectiveState.profile_image_ref,
                            })}
                            title="Open in Media Preview Panel (click again to close)"
                            className="flex-shrink-0 text-zinc-500 hover:text-accent-400 transition-colors"
                          >
                            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
                              <circle cx="8" cy="8" r="2" />
                            </svg>
                          </button>
                        )}
                        <FileAttrInput
                          fileRef={ac.attribute.file_ref}
                          onChange={(ref) => {
                            updateAddedAttr(ac.attribute.id, { file_ref: ref, value: ref })
                            if (ref) {
                              const ps = usePreviewStore.getState()
                              const exp = ps.expanded
                              if (exp?.source?.type === 'attribute' && exp.source.entityId === entityId && exp.source.attributeId === ac.attribute.id) {
                                ps.replaceExpandedSource({ ...exp.source, fileRef: ref })
                              }
                            }
                          }}
                        />
                      </div>
                    )}
                    {ac.attribute.attribute_type === 'text_list' && (
                      <TextListAttribute
                        attr={ac.attribute}
                        effectiveItems={parseListValue(ac.attribute.value)}
                        onAdd={(item) => addListItem(ac.attribute.id, item)}
                        onRemove={(item) => removeListItem(ac.attribute.id, item)}
                      />
                    )}
                    {ac.attribute.attribute_type === 'entity_list' && (
                      <EntityListAttribute
                        attr={ac.attribute}
                        effectiveItems={parseListValue(ac.attribute.value)}
                        atNodeId={nodeId}
                        onAdd={(refId) => addListItem(ac.attribute.id, refId)}
                        onRemove={(refId) => removeListItem(ac.attribute.id, refId)}
                        onNavigate={navigateToReferencedEntity}
                      />
                    )}
                    {ac.attribute.attribute_type === 'number' && (
                      <input
                        type="number"
                        value={ac.attribute.number_value ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') { updateAddedAttr(ac.attribute.id, { number_value: null }); return }
                          const n = Number(raw)
                          updateAddedAttr(ac.attribute.id, { number_value: Number.isFinite(n) ? n : null })
                        }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                      />
                    )}
                    {(ac.attribute.attribute_type === 'circumstance' || ac.attribute.attribute_type === 'motivator') && (
                      editingCMAttrId === ac.attribute.id ? (
                        <CircumstanceMotivatorForm
                          attributeType={ac.attribute.attribute_type}
                          value={editingCM}
                          setValue={setEditingCM}
                          error={editingCMError}
                          setError={setEditingCMError}
                          onConfirm={confirmEditCM}
                          onCancel={cancelEditCM}
                          confirmLabel="Save"
                          headerLabel={ac.attribute.attribute_type === 'motivator' ? 'Edit Motivator' : 'Edit Circumstance'}
                        />
                      ) : (
                        <div
                          className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                          onClick={() => openEditCM(ac.attribute)}
                          title="Click to edit"
                        >
                          <div className="flex flex-col items-center flex-shrink-0">
                            <IntensityBadge level={ac.attribute.intensity ?? null} size={20} />
                            {ac.attribute.intensity != null && (
                              <span className="text-[9px] text-zinc-500 mt-0 leading-none whitespace-nowrap">({INTENSITY_LABELS[ac.attribute.intensity]})</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            {ac.attribute.description ? (
                              <CollapsibleDescription text={ac.attribute.description} textClassName="text-zinc-300" />
                            ) : null}
                          </div>
                        </div>
                      )
                    )}
                  </>
                ) : (
                  <>
                    {ac.attribute.attribute_type === 'text' && (
                      <ExpandableTextField
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                        value={ac.attribute.value || ''}
                        placeholder="Value…"
                        extraProps={{
                          'data-ovum-teal-scarecrow':
                            (entity?.type === 'item'
                              && ['ocarina','ocarina of time'].includes((entity?.name || '').trim().toLowerCase())
                              && (ac.attribute?.name || '').trim().toLowerCase() === "scarecrow's song")
                              ? 'yes' : undefined,
                        }}
                        onChange={(e) => updateAddedAttr(ac.attribute.id, { value: e.target.value })}
                      />
                    )}
                    {ac.attribute.attribute_type === 'preset' && (
                      <select
                        value={ac.attribute.value || ''}
                        onChange={(e) => updateAddedAttr(ac.attribute.id, { value: e.target.value })}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                      >
                        <option value="">— select —</option>
                        {(presetLists.find((pl) => pl.id === ac.attribute.preset_list_id)?.values || []).map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    )}
                    {ac.attribute.attribute_type === 'file' && (
                      <div className="flex items-center gap-1.5">
                        {ac.attribute.file_ref ? (
                          <>
                            <span className="text-[10px] text-zinc-400 truncate flex-1" title={ac.attribute.file_ref}>
                              {ac.attribute.file_ref.split('/').pop()}
                            </span>
                            <button
                              onClick={() => togglePreview({
                                type: 'attribute',
                                entityId,
                                attributeId: ac.attribute.id,
                                atNodeId: nodeId,
                                fileRef: ac.attribute.file_ref,
                                attributeName: ac.attribute.name,
                                entityName: effectiveState.name,
                                entityColour: effectiveState.colour,
                                profileImageRef: effectiveState.profile_image_ref,
                              })}
                              title="Open in Media Preview Panel (click again to close)"
                              className="flex-shrink-0 text-zinc-500 hover:text-accent-400 transition-colors"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
                                <circle cx="8" cy="8" r="2" />
                              </svg>
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-zinc-600 italic">no media</span>
                        )}
                      </div>
                    )}
                    {ac.attribute.attribute_type === 'text_list' && (
                      <TextListAttribute
                        attr={ac.attribute}
                        effectiveItems={parseListValue(ac.attribute.value)}
                        onAdd={(item) => addListItem(ac.attribute.id, item)}
                        onRemove={(item) => removeListItem(ac.attribute.id, item)}
                      />
                    )}
                    {ac.attribute.attribute_type === 'entity_list' && (
                      <EntityListAttribute
                        attr={ac.attribute}
                        effectiveItems={parseListValue(ac.attribute.value)}
                        atNodeId={nodeId}
                        onAdd={(refId) => addListItem(ac.attribute.id, refId)}
                        onRemove={(refId) => removeListItem(ac.attribute.id, refId)}
                        onNavigate={isModifier ? ((id) => navigateToReferencedEntity(id, 'relationships')) : navigateToReferencedEntity}
                      />
                    )}
                    {(ac.attribute.attribute_type === 'circumstance' || ac.attribute.attribute_type === 'motivator') && (
                      editingCMAttrId === ac.attribute.id ? (
                        <CircumstanceMotivatorForm
                          attributeType={ac.attribute.attribute_type}
                          value={editingCM}
                          setValue={setEditingCM}
                          error={editingCMError}
                          setError={setEditingCMError}
                          onConfirm={confirmEditCM}
                          onCancel={cancelEditCM}
                          confirmLabel="Save"
                          headerLabel={ac.attribute.attribute_type === 'motivator' ? 'Edit Motivator' : 'Edit Circumstance'}
                        />
                      ) : (
                        <div
                          className="flex items-start gap-2 text-xs cursor-pointer hover:bg-zinc-800/40 rounded px-1 -mx-1 transition-colors"
                          onClick={() => openEditCM(ac.attribute)}
                          title="Click to edit"
                        >
                          <div className="flex flex-col items-center flex-shrink-0">
                            <IntensityBadge level={ac.attribute.intensity ?? null} size={20} />
                            {ac.attribute.intensity != null && (
                              <span className="text-[9px] text-zinc-500 mt-0 leading-none whitespace-nowrap">({INTENSITY_LABELS[ac.attribute.intensity]})</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            {ac.attribute.description ? (
                              <CollapsibleDescription text={ac.attribute.description} textClassName="text-zinc-300" />
                            ) : null}
                          </div>
                        </div>
                      )
                    )}
                    {ac.attribute.attribute_type === 'number' && (
                      <input
                        type="number"
                        value={ac.attribute.number_value ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') { updateAddedAttr(ac.attribute.id, { number_value: null }); return }
                          const n = Number(raw)
                          updateAddedAttr(ac.attribute.id, { number_value: Number.isFinite(n) ? n : null })
                        }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent-500"
                      />
                    )}
                    {ac.attribute.attribute_type !== 'text' && ac.attribute.attribute_type !== 'preset' && ac.attribute.attribute_type !== 'file' && ac.attribute.attribute_type !== 'text_list' && ac.attribute.attribute_type !== 'entity_list' && ac.attribute.attribute_type !== 'circumstance' && ac.attribute.attribute_type !== 'motivator' && ac.attribute.attribute_type !== 'number' && (
                      <div className="text-xs text-zinc-400">{ac.attribute.value || <em className="text-zinc-600">no value</em>}</div>
                    )}
                  </>
                )}
              </div>
              )
            })}

            {/* Phase 4.2 — trailing drop zone for the Attributes section,
                so a dragged attribute can be dropped PAST the last row
                to move it to the end (dstIdx === total). Only rendered
                while an attribute drag is in progress. */}
            {section.id === 'attributes' && attrReorder.trailingZoneProps && (
              <div
                {...attrReorder.trailingZoneProps}
                className="h-3 rounded -mt-1 mb-1"
                style={{ borderTop: attrReorder.dragOverIdx === _attrReorderTotal ? `2px solid ${attrReorder.accentColor}` : '2px solid transparent' }}
              />
            )}

            {/* Origin: attributes marked pending-remove — show −REMOVED + ↩ before user saves */}
            {isOrigin && draftAttrChanges
              .filter((ac) => ac.action === 'add' && ac.pending_remove && ac.attribute && section.typeFilter(ac.attribute.attribute_type))
              .map((ac) => (
                <div key={ac.attribute.id} className="mb-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <span className="text-[10px] flex-1 truncate text-zinc-600 line-through">{ac.attribute.name}</span>
                    {ac.attribute.attribute_type === 'circumstance' ? (
                      <CircumstanceTypeBadge size={14} />
                    ) : ac.attribute.attribute_type === 'motivator' ? (
                      <MotivatorTypeBadge size={14} />
                    ) : (
                      <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${ATTR_TYPE_COLOURS[ac.attribute.attribute_type] || ''}`}>
                        {ac.attribute.attribute_type}
                      </span>
                    )}
                    <ChangeBadge action="remove" />
                    <button
                      onClick={() => setDraft((d) => {
                        const base = d ?? initDraft()
                        return {
                          ...base,
                          attribute_changes: base.attribute_changes.map((x) =>
                            x.action === 'add' && x.attribute?.id === ac.attribute.id
                              ? { ...x, pending_remove: false }
                              : x
                          ),
                        }
                      })}
                      className="text-[9px] text-amber-500 hover:text-amber-300"
                      title="Undo remove"
                    >
                      ↩
                    </button>
                  </div>
                  <p className="text-[9px] text-red-400 italic">Will be removed on Save</p>
                </div>
              ))}

            {/* Attributes removed at this node — persisted in source but not in effectiveState */}
            {!isOrigin && draftAttrChanges
              .filter((ac) => ac.action === 'remove' && !effectiveState.attributes.some((a) => a.id === ac.attribute_id))
              .map((ac) => {
                const removedAttr = priorEffectiveState?.attributes.find((a) => a.id === ac.attribute_id)
                if (!removedAttr) return null
                if (!section.typeFilter(removedAttr.attribute_type)) return null
                const removedTypePillClass = `text-[9px] px-1 py-0.5 rounded ${isModifier ? '' : 'flex-shrink-0 '}${ATTR_TYPE_COLOURS[removedAttr.attribute_type] || ''}`
                return (
                  <div key={ac.attribute_id} className="mb-2 px-1.5 py-1 rounded border border-zinc-800">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[10px] flex-1 truncate text-zinc-600 line-through">{removedAttr.name}</span>
                      {removedAttr.attribute_type === 'circumstance' ? (
                        <CircumstanceTypeBadge size={14} />
                      ) : removedAttr.attribute_type === 'motivator' ? (
                        <MotivatorTypeBadge size={14} />
                      ) : (
                        <span className={removedTypePillClass}>
                          {removedAttr.attribute_type}
                        </span>
                      )}
                      <ChangeBadge action="remove" />
                      <button
                        onClick={() => undoAttrRemove(removedAttr.id)}
                        className="text-[9px] text-amber-500 hover:text-amber-300"
                        title="Undo remove"
                      >
                        ↩
                      </button>
                    </div>
                    <p className="text-[9px] text-red-400 italic">Removed at this point</p>
                  </div>
                )
              })}

            {/* Attributes restored via ↩ — in priorEffectiveState but not in effectiveState,
                and no 'remove' entry in draft (undo was applied). Show as normal during draft. */}
            {!isOrigin && isDirty && (priorEffectiveState?.attributes || [])
              .filter((a) =>
                !effectiveState.attributes.some((ea) => ea.id === a.id) &&
                !draftAttrChanges.some((ac) => ac.action === 'remove' && ac.attribute_id === a.id) &&
                section.typeFilter(a.attribute_type)
              )
              .map((attr) => {
                const modifyChange = draftAttrChanges.find((ac) => ac.action === 'modify' && ac.attribute_id === attr.id)
                const hasModify    = !!modifyChange
                const displayValue = hasModify ? (modifyChange.new_value ?? '') : (attr.value ?? '')
                // Number attributes carry their value on number_value, not value.
                const restoredNumber = attr.attribute_type === 'number'
                  ? ((hasModify && Object.prototype.hasOwnProperty.call(modifyChange, 'new_number_value'))
                      ? modifyChange.new_number_value
                      : (attr.number_value ?? null))
                  : null
                const restoredTypePillClass = `text-[9px] px-1 py-0.5 rounded ${isModifier ? '' : 'flex-shrink-0 '}${ATTR_TYPE_COLOURS[attr.attribute_type] || ''}`
                return (
                  <div key={attr.id} className="mb-2">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[10px] text-zinc-500 flex-1 truncate">{attr.name}</span>
                      {attr.attribute_type === 'circumstance' ? (
                        <CircumstanceTypeBadge size={14} />
                      ) : attr.attribute_type === 'motivator' ? (
                        <MotivatorTypeBadge size={14} />
                      ) : (
                        <span className={restoredTypePillClass}>
                          {attr.attribute_type}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-400">{
                      attr.attribute_type === 'number'
                        ? (restoredNumber != null ? formatNumberForChip(restoredNumber) : <em className="text-zinc-600">no value</em>)
                        : (displayValue || <em className="text-zinc-600">no value</em>)
                    }</div>
                  </div>
                )
              })}

              </>)}
            </div>
            ))}
            <input
              ref={mediaReplaceInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*"
              onChange={handleMediaReplaceFileChosen}
            />
          </>
          )
        })()}

        {subTab === 'relationships' && (
          <div data-help-region="detail-panel:relationships_body">
          {isModifier ? (
            // Modifier mode: read-only relationship summary (no editor / picker)
            (() => {
              const entityRelIds = [...(relationshipsByEntity[entityId] || new Set())].filter((rid) => {
                const rel = allRelationships.find((r) => r.id === rid)
                if (!rel) return true
                const relState = computeRelationshipEffectiveState(rel, nodeOrder, nodeId)
                if (relState?.is_active === false) {
                  return (rel.history?.existence_changes || []).some(
                    (c) => c.node_id === nodeId && c.action === 'deactivate'
                  )
                }
                const isParticipant = (relState?.participants || []).some((p) => p.entity_id === entityId)
                if (!isParticipant) {
                  return (rel.history?.participant_changes || []).some(
                    (c) => c.node_id === nodeId && c.entity_id === entityId && c.action === 'leave'
                  )
                }
                return true
              })
              return (
                <>
                  {entityRelIds.length === 0 ? (
                    <p className="text-xs text-zinc-600 italic">No relationships at this point.</p>
                  ) : (
                    entityRelIds.map((rid) => {
                      const rel = allRelationships.find((r) => r.id === rid)
                      if (!rel) return null
                      const relState = computeRelationshipEffectiveState(rel, nodeOrder, nodeId)
                      const myPt = (relState?.participants || []).find((p) => p.entity_id === entityId)
                      const myRole = (relState?.participant_roles || {})[entityId]
                      const entityScopedChanges = getRelationshipChangesAtNode(rel, nodeId, entityId, nodeOrder)
                      return (
                        <div key={rid} className="group relative bg-zinc-700/30 rounded mb-1.5 overflow-hidden">
                          <RelationshipSummaryHeader
                            relationship={rel}
                            atNodeId={nodeId}
                            nodeOrder={nodeOrder}
                            compact
                            stacked
                            onClick={() => tryProceed(() => openRelationshipDetail(rid, nodeId))}
                          />
                          <div className="absolute top-0.5 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              className="px-1.5 py-0.5 text-zinc-500 hover:text-accent-400 text-[10px] bg-zinc-800/90 rounded"
                              title="Open relationship detail"
                              onClick={(e) => { e.stopPropagation(); tryProceed(() => openRelationshipDetail(rid, nodeId)) }}
                            >→</button>
                          </div>
                          {(myPt?.alias_override || myRole?.value || myPt?.perception) && (
                            <div className="px-2 pb-1.5 space-y-0.5">
                              {myPt?.alias_override && (
                                <div className="flex items-center gap-1 text-[10px]">
                                  <span className="text-zinc-600 w-12 flex-shrink-0">alias:</span>
                                  <span className="text-zinc-400 italic">{myPt.alias_override}</span>
                                </div>
                              )}
                              {myRole?.value && (
                                <div className="flex items-center gap-1 text-[10px]">
                                  <span className="text-zinc-600 w-12 flex-shrink-0">role:</span>
                                  <span className="text-zinc-400">{myRole.value}</span>
                                </div>
                              )}
                              {myPt?.perception && (
                                <p className="text-[10px] text-zinc-500 italic truncate">"{myPt.perception}"</p>
                              )}
                              {entityScopedChanges.length > 0 && (
                                <div className="flex flex-col gap-0.5 pt-0.5">
                                  {entityScopedChanges.map((ch, i) => (
                                    <RelChangeChip key={i} change={ch} getEntity={(id) => allEntities.find((e) => e.id === id) || null} />
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </>
              )
            })()
          ) : (
            // Chip / Origin: full relationship editor
            (() => {
              const entityRelIds = [...(relationshipsByEntity[entityId] || new Set())]
              const membershipRelIds = entityRelIds.filter((rid) => {
                const r = allRelationships.find((x) => x.id === rid)
                return r?.membership_of === entityId
              })
              const regularRelIds = entityRelIds.filter((rid) => !membershipRelIds.includes(rid)).filter((rid) => {
                // Origin and chip both filter by participation at the
                // current anchor. `relationshipsByEntity` indexes any
                // rel where the entity has a join event in history,
                // irrespective of scene position; without this filter
                // an origin chip would list rels the entity doesn't
                // join until a downstream scene.
                const rel = allRelationships.find((r) => r.id === rid)
                if (!rel) return true
                const relState = computeRelationshipEffectiveState(rel, nodeOrder, nodeId)
                if (relState?.is_active === false) {
                  return (rel.history?.existence_changes || []).some(
                    (c) => c.node_id === nodeId && c.action === 'deactivate'
                  )
                }
                const isParticipant = (relState?.participants || []).some((p) => p.entity_id === entityId)
                if (!isParticipant) {
                  return (rel.history?.participant_changes || []).some(
                    (c) => c.node_id === nodeId && c.entity_id === entityId && c.action === 'leave'
                  )
                }
                return true
              })
              const entityAliases = (effectiveState?.aliases || entity?.aliases || [])
                .map((a) => (typeof a === 'string' ? a : a?.value))
                .filter(Boolean)

              function getRelLabel(rel) {
                if (!rel) return 'Unknown'
                if (rel.name) return rel.name
                if (rel.membership_of) {
                  const parent = allEntities.find((e) => e.id === rel.membership_of)
                  return rel.hierarchy?.enabled ? `${parent?.name || 'Unknown'} hierarchy` : `${parent?.name || 'Unknown'} Members`
                }
                const pts = Array.from(new Set(
                  (rel.history?.participant_changes || [])
                    .filter((c) => c.action === 'join')
                    .map((c) => c.entity_id)
                )).map((eid) => ({ entity_id: eid }))
                if (pts.length === 0) return 'New relationship'
                const names = pts.slice(0, 2).map((p) => allEntities.find((e) => e.id === p.entity_id)?.name || 'Unknown')
                return pts.length > 2 ? `${names.join(' + ')} + ${pts.length - 2} more` : names.join(' + ')
              }

              return (
                <>
                  {membershipRelIds.length > 0 && (
                    <div className="border border-zinc-600/50 rounded p-2 mb-3 bg-zinc-800/30">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5 font-semibold">
                        {entity?.type === 'faction' ? 'Membership' : 'Contains'}
                      </div>
                      {membershipRelIds.map((rid) => {
                        const rel = allRelationships.find((r) => r.id === rid)
                        if (!rel) return null
                        return (
                          <RelationshipSummaryHeader
                            key={rid}
                            relationship={rel}
                            atNodeId={isOrigin ? null : nodeId}
                            nodeOrder={nodeOrder}
                            compact
                            onClick={() => tryProceed(() => openRelationshipDetail(rid, isOrigin ? null : nodeId))}
                          />
                        )
                      })}
                      {entity?.type === 'faction' && membershipRelIds.length > 0 && (() => {
                        const membershipRel = allRelationships.find((r) => r.id === membershipRelIds[0])
                        if (!membershipRel) return null
                        const currentParticipantIds = new Set(
                          (membershipRel.history?.participant_changes || [])
                            .filter((c) => c.action === 'join')
                            .map((c) => c.entity_id)
                        )
                        // Phase 1.26 — migrated from a bespoke search-list
                        // picker to the shared `<EntityPickerPopover>` so
                        // the faction Add-Member surface matches the styling
                        // / search / type-tab affordances used by every
                        // other entity-pick site in the app. Single-add
                        // semantics: each click adds the entity as a
                        // participant and closes the picker.
                        return (
                          <div className="mt-1.5">
                            {!showAddMember ? (
                              <button
                                className="w-full text-[9px] text-accent-400/70 hover:text-accent-300 py-1 border border-dashed border-zinc-700 hover:border-zinc-500 rounded transition-colors"
                                onClick={() => setShowAddMember(true)}
                              >
                                + Add Member
                              </button>
                            ) : (
                              <EntityPickerPopover
                                allEntities={allEntities}
                                excludeIds={currentParticipantIds}
                                onPick={(eid) => { addParticipant(membershipRel.id, eid, nodeId); setShowAddMember(false) }}
                                onClose={() => setShowAddMember(false)}
                              />
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}

                  {regularRelIds.length === 0 && membershipRelIds.length === 0 && (
                    <p className="text-xs text-zinc-600 italic mb-2">No relationships at this point.</p>
                  )}
                  {regularRelIds.map((rid) => {
                    const rel = allRelationships.find((r) => r.id === rid)
                    if (!rel) return null
                    const relState = isOrigin ? null : computeRelationshipEffectiveState(rel, nodeOrder, nodeId)
                    const myPt = (relState?.participants || []).find((p) => p.entity_id === entityId)
                    const myRole = (relState?.participant_roles || rel.participant_roles || {})[entityId]
                    const storedPerception = myPt?.perception || ''
                    const entityScopedChanges = isOrigin ? [] : getRelationshipChangesAtNode(rel, nodeId, entityId, nodeOrder)
                    const hasHierarchy = !!(rel.hierarchy?.enabled || rel.hierarchy?.root_entity_id)
                    const isMembership = !!rel.membership_of
                    const isRelActive = relState ? relState.is_active : true
                    const relParticipants = relState?.participants || []
                    const relJoins = (rel.history?.participant_changes || []).filter((c) => c.action === 'join')
                    const relJoinNodeIds = new Set(relJoins.map((c) => c.node_id))
                    const allRelJoinsAtOriginNodes = relJoins.length > 0 && [...relJoinNodeIds].every((nid) => {
                      const n = nodes.find((x) => x.id === nid)
                      return n?.type === 'entityNode' && !n.data?.is_modifier
                    })
                    const isRelCreationNode = isOrigin || (relJoins.length > 0 && (
                      relJoins.every((c) => c.node_id === nodeId) ||
                      (allRelJoinsAtOriginNodes && relJoinNodeIds.has(nodeId))
                    ))
                    const fieldOverrides = isOrigin ? {} : {
                      perception: (rel.history?.perception_changes || []).some((c) => c.node_id === nodeId && c.entity_id === entityId),
                      alias: (rel.history?.alias_changes || []).some((c) => c.node_id === nodeId && c.entity_id === entityId),
                      role: (rel.history?.role_changes || []).some((c) => c.node_id === nodeId && c.entity_id === entityId),
                    }
                    return (
                      <div key={rid} className="border-b border-zinc-700/30 last:border-b-0">
                        {/* Custom header */}
                        <div className="pl-2 pr-1.5 py-1 border-l-2" style={{ borderLeftColor: '#a78bfa55' }}>
                          {/* Row 1: editable name + badges + relationship icon */}
                          <div className="flex items-center gap-1 min-w-0">
                            {editingRelNameId === rid ? (
                              <input
                                autoFocus
                                className="flex-1 min-w-0 text-[11px] bg-transparent border-b border-zinc-600 focus:outline-none focus:border-violet-400 text-zinc-200 placeholder-zinc-600"
                                value={relNameVal}
                                onChange={(e) => setRelNameVal(e.target.value)}
                                onBlur={() => { setRelationshipName(rid, relNameVal.trim() || null, isOrigin ? null : nodeId); setEditingRelNameId(null) }}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingRelNameId(null) }}
                                placeholder="Name this relationship…"
                              />
                            ) : (() => {
                              const pts = Array.from(new Set(
                                (rel.history?.participant_changes || [])
                                  .filter((c) => c.action === 'join')
                                  .map((c) => c.entity_id)
                              )).map((eid) => ({ entity_id: eid }))
                              return (
                                <button
                                  className="flex-1 min-w-0 text-left text-[11px] font-medium text-zinc-200 hover:text-zinc-100 cursor-text"
                                  onClick={(e) => { e.stopPropagation(); setRelNameVal(rel.name || ''); setEditingRelNameId(rid) }}
                                  title="Click to rename"
                                >
                                  {rel.name && pts.length > 0
                                    ? (
                                      <RelationshipLabelStack
                                        name={rel.name}
                                        participants={pts}
                                        getEntity={(id) => allEntities.find((e) => e.id === id)}
                                        sliceMax={3}
                                        rel={rel}
                                      />
                                    )
                                    : <span className="truncate block">{getRelLabel(rel)}</span>
                                  }
                                </button>
                              )
                            })()}
                            {!isRelActive && <span className="text-[9px] text-red-400/70 bg-red-900/20 px-1 py-px rounded flex-shrink-0">ended</span>}
                            {hasHierarchy && <span className="text-[9px] text-amber-400/70 bg-amber-900/20 px-1 py-px rounded flex-shrink-0">hierarchy</span>}
                            {isMembership && !hasHierarchy && <span className="text-[9px] text-violet-400/70 bg-violet-900/20 px-1 py-px rounded flex-shrink-0">members</span>}
                            <button
                              type="button"
                              className="flex-shrink-0 inline-flex items-center justify-center p-1 rounded border border-violet-400/25 bg-violet-900/15 hover:bg-violet-900/35 hover:border-violet-400/45 focus:outline-none transition-colors"
                              title="Open relationship detail"
                              onClick={(e) => { e.stopPropagation(); tryProceed(() => openRelationshipDetail(rid, isOrigin ? null : nodeId)) }}
                            >
                              <RelationshipIcon size={13} />
                            </button>
                          </div>
                          {/* Row 2: participant avatars */}
                          {relParticipants.length > 0 && (
                            <div className="flex items-center justify-center gap-1 mt-1 flex-wrap">
                              {relParticipants.slice(0, 5).map((p) => {
                                const pEnt = allEntities.find((e) => e.id === p.entity_id)
                                if (!pEnt) return null
                                const pColour = pEnt.colour || '#888888'
                                const pAsset = pEnt.profile_image_ref ? pEnt.profile_image_ref.replace(/^assets\//, '') : null
                                const pSrc = pAsset ? `/api/project/assets/${pAsset}` : null
                                const pInner = pSrc ? (
                                  <img src={pSrc} alt="" className="rounded object-cover flex-shrink-0" style={{ width: 24, height: 24, border: `1.5px solid ${pColour}` }} title={pEnt.name} />
                                ) : (
                                  <span className="rounded flex items-center justify-center flex-shrink-0" style={{ width: 24, height: 24, backgroundColor: pColour + '22', border: `1.5px solid ${pColour}`, fontSize: 10, lineHeight: 1 }} title={pEnt.name}>
                                    {TYPE_ICONS[pEnt.type] || '★'}
                                  </span>
                                )
                                const avatarNode = pSrc
                                  ? <ImageHoverPreview src={pSrc} borderColour={pColour} size={80}>{pInner}</ImageHoverPreview>
                                  : pInner
                                return (
                                  <button
                                    key={p.entity_id}
                                    type="button"
                                    className="p-0 bg-transparent border-0 inline-flex hover:opacity-75 focus:outline-none transition-opacity"
                                    title={`View ${pEnt.name}'s relationships`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const targetChain = getEntityNarrativeChain(p.entity_id, nodes, edges)
                                      const idx = targetChain.findIndex((n) => n.id === nodeId)
                                      openEntityAtRelationshipsTab(p.entity_id, nodeId, idx)
                                    }}
                                  >
                                    {avatarNode}
                                  </button>
                                )
                              })}
                              {relParticipants.length > 5 && (
                                <span className="text-[9px] text-zinc-500">+{relParticipants.length - 5}</span>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Entity-centric slice */}
                        <div className="pl-3.5 pr-2 pb-1.5 space-y-0.5">
                          {isOrigin ? (
                            <>
                              {myPt?.alias_override && (
                                <div className="flex items-center gap-1 text-[10px]">
                                  <span className="text-zinc-600 w-16 flex-shrink-0">alias:</span>
                                  <span className="text-zinc-400 italic">{myPt.alias_override}</span>
                                </div>
                              )}
                              {myRole?.value && (
                                <div className="flex items-center gap-1 text-[10px]">
                                  <span className="text-zinc-600 w-16 flex-shrink-0">role:</span>
                                  <span className="text-zinc-400">{myRole.value}</span>
                                </div>
                              )}
                              {storedPerception && (
                                <div className="text-[10px] text-zinc-500 italic">"{storedPerception}"</div>
                              )}
                            </>
                          ) : (
                            <>
                              {relDraft[rid] ? (
                                <div className="space-y-1 pt-0.5">
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1">
                                      <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Perception</span>
                                      {fieldOverrides.perception && (
                                        <>
                                          <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                                          <button
                                            className="text-[8px] text-zinc-500 hover:text-red-400 leading-none"
                                            onClick={() => { removeRelationshipChange(rid, { type: 'perception', entity_id: entityId }, nodeId); cancelRelDraft(rid) }}
                                            title="Revert this change"
                                          >✕</button>
                                        </>
                                      )}
                                    </div>
                                    <textarea
                                      className="w-full bg-zinc-800 border border-zinc-600 focus:border-accent-500/50 rounded px-1.5 py-0.5 text-zinc-300 focus:outline-none text-[10px] resize-none"
                                      rows={2}
                                      value={relDraft[rid].perception}
                                      onChange={(e) => updateRelDraftField(rid, 'perception', e.target.value)}
                                      placeholder="How this entity sees the relationship…"
                                    />
                                  </div>
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1">
                                      <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Alias</span>
                                      {fieldOverrides.alias && (
                                        <>
                                          <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                                          <button
                                            className="text-[8px] text-zinc-500 hover:text-red-400 leading-none"
                                            onClick={() => { removeRelationshipChange(rid, { type: 'alias', entity_id: entityId }, nodeId); cancelRelDraft(rid) }}
                                            title="Revert this change"
                                          >✕</button>
                                        </>
                                      )}
                                    </div>
                                    {entityAliases.length === 0 ? (
                                      <span className="text-[10px] text-zinc-700 italic px-0.5 py-0.5">No aliases defined</span>
                                    ) : (
                                      <select
                                        className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200"
                                        value={relDraft[rid].alias || ''}
                                        onChange={(e) => updateRelDraftField(rid, 'alias', e.target.value)}
                                      >
                                        <option value="">None</option>
                                        {entityAliases.map((a) => <option key={a} value={a}>{a}</option>)}
                                      </select>
                                    )}
                                  </div>
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1">
                                      <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Role</span>
                                      {fieldOverrides.role && (
                                        <>
                                          <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                                          <button
                                            className="text-[8px] text-zinc-500 hover:text-red-400 leading-none"
                                            onClick={() => { removeRelationshipChange(rid, { type: 'role', entity_id: entityId }, nodeId); cancelRelDraft(rid) }}
                                            title="Revert this change"
                                          >✕</button>
                                        </>
                                      )}
                                      {relDraft[rid].role?.preset_list_id ? (
                                        <button
                                          className="ml-auto text-[8px] text-zinc-600 hover:text-zinc-400 leading-none"
                                          onClick={() => updateRelDraftField(rid, 'role', { value: relDraft[rid].role?.value || '', preset_list_id: null })}
                                          title="Switch to free-form text"
                                        >free-form</button>
                                      ) : (
                                        <button
                                          ref={(el) => { relRoleAnchorRefs.current[rid] = el }}
                                          className="ml-auto text-[8px] text-zinc-600 hover:text-zinc-400 leading-none"
                                          onClick={() => setRelRolePickerOpenId(rid)}
                                          title="Choose a preset list"
                                        >preset</button>
                                      )}
                                    </div>
                                    {relDraft[rid].role?.preset_list_id ? (
                                      <>
                                        <button
                                          ref={(el) => { relRoleAnchorRefs.current[rid] = el }}
                                          onClick={() => setRelRolePickerOpenId(rid)}
                                          className="text-[10px] bg-zinc-800 border border-zinc-600 hover:border-zinc-400 rounded px-1 py-0.5 text-left w-full focus:outline-none"
                                          title="Change preset list"
                                        >
                                          {(() => {
                                            const list = presetLists.find((l) => l.id === relDraft[rid].role.preset_list_id)
                                            return list
                                              ? <span className="text-zinc-400 italic">{list.name}</span>
                                              : <span className="text-zinc-500 italic">list not found</span>
                                          })()}
                                        </button>
                                        {(() => {
                                          const list = presetLists.find((l) => l.id === relDraft[rid].role.preset_list_id)
                                          if (!list) return null
                                          return (
                                            <select
                                              className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200"
                                              value={relDraft[rid].role?.value || ''}
                                              onChange={(e) => updateRelDraftField(rid, 'role', { ...relDraft[rid].role, value: e.target.value })}
                                            >
                                              <option value="">— select value —</option>
                                              {(list.values || []).map((v) => <option key={v} value={v}>{v}</option>)}
                                            </select>
                                          )
                                        })()}
                                      </>
                                    ) : (
                                      <input
                                        className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200 w-full"
                                        value={relDraft[rid].role?.value || ''}
                                        onChange={(e) => updateRelDraftField(rid, 'role', { value: e.target.value, preset_list_id: null })}
                                        placeholder="Role in this relationship…"
                                      />
                                    )}
                                    <PresetListPicker
                                      value={relDraft[rid].role?.preset_list_id || null}
                                      onChange={(listId) => updateRelDraftField(rid, 'role', { value: '', preset_list_id: listId })}
                                      anchorEl={relRoleAnchorRefs.current[rid]}
                                      isOpen={relRolePickerOpenId === rid}
                                      onClose={() => setRelRolePickerOpenId(null)}
                                    />
                                  </div>
                                  <div className="flex items-center gap-1 mt-1 pt-1 border-t border-zinc-700/30">
                                    {myPt && (
                                      <button
                                        className="text-[9px] text-zinc-600 hover:text-amber-400 px-1.5 py-0.5 rounded hover:bg-zinc-700/40 transition-colors"
                                        title="Remove this entity from the relationship from this scene forward"
                                        onClick={async (e) => { e.stopPropagation()
                                          const getEntityFromAll = (id) => allEntities.find((ent) => ent.id === id)
                                          const entityMap = new Map(allEntities.map((ent) => [ent.id, ent]))
                                          const displayEntity = entity
                                            ? { ...entity, name: effectiveState?.name || entity.name, colour: effectiveState?.colour || entity.colour }
                                            : null
                                          const ok = await confirm({
                                            title: 'Leave relationship',
                                            message: buildLeaveRelationshipMessage({
                                              entity: displayEntity,
                                              aliasOverride: myPt?.alias_override || null,
                                              rel,
                                              getEntity: getEntityFromAll,
                                              leavingAtNodeId: nodeId,
                                              nodes,
                                              entityMap,
                                            }),
                                            buttons: [{ label: 'Leave', value: 'remove', style: 'danger' }, { label: 'Cancel', value: 'cancel', style: 'default' }],
                                          })
                                          if (ok === 'remove') removeParticipantInChip(rid, entityId, nodeId)
                                        }}
                                      >Leave</button>
                                    )}
                                    <button
                                      className="text-[9px] text-zinc-600 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-zinc-700/40 transition-colors"
                                      title={isRelCreationNode ? 'Delete the entire relationship from the story' : 'End this relationship at this scene'}
                                      onClick={async (e) => { e.stopPropagation();
                                        const getEntityFromAll = (id) => allEntities.find((ent) => ent.id === id)
                                        const entityMap = new Map(allEntities.map((ent) => [ent.id, ent]))
                                        const resolveNameAtScene = (eid) => {
                                          const ent = getEntityFromAll(eid)
                                          if (!ent) return null
                                          const s = computeEffectiveState(ent, nodes, edges, nodeId)
                                          return s?.name || ent.name || null
                                        }
                                        if (isRelCreationNode) {
                                          const ok = await confirm({
                                            title: 'Delete relationship',
                                            message: buildDeleteRelationshipMessage({ rel, getEntity: getEntityFromAll, resolveName: resolveNameAtScene }),
                                            buttons: [{ label: 'Delete', value: 'delete', style: 'danger' }, { label: 'Cancel', value: 'cancel', style: 'default' }],
                                          })
                                          if (ok === 'delete') deleteObjectInChip('relationship', rid)
                                        } else {
                                          const ok = await confirm({
                                            title: 'End relationship',
                                            message: buildEndRelationshipMessage({
                                              rel,
                                              getEntity: getEntityFromAll,
                                              endNodeId: nodeId,
                                              nodes,
                                              entityMap,
                                              resolveName: resolveNameAtScene,
                                            }),
                                            buttons: [{ label: 'End here', value: 'end', style: 'danger' }, { label: 'Cancel', value: 'cancel', style: 'default' }],
                                          })
                                          if (ok === 'end') recordRelationshipChange(rid, { type: 'existence', data: { action: 'deactivate', node_id: nodeId } })
                                        }
                                      }}
                                    >{isRelCreationNode ? 'Delete rel.' : 'End here'}</button>
                                    <div className="flex items-center gap-1.5 ml-auto">
                                      <button
                                        className="text-[9px] text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded"
                                        onClick={() => cancelRelDraft(rid)}
                                      >Cancel</button>
                                      <button
                                        className="text-[9px] px-2 py-0.5 rounded bg-accent-500 hover:bg-accent-400 text-zinc-900 font-medium"
                                        onClick={() => saveRelDraft(rid, storedPerception, myRole, myPt?.alias_override || '')}
                                      >Save</button>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div
                                  className="cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-zinc-700/30 space-y-0.5"
                                  onClick={() => openRelDraft(rid, storedPerception, myRole, myPt?.alias_override || '')}
                                >
                                  <div className="flex items-start gap-1 text-[10px]">
                                    <span className="text-zinc-600 w-16 flex-shrink-0 pt-px">perception:</span>
                                    {storedPerception
                                      ? <span className="text-zinc-400 italic line-clamp-2">"{storedPerception}"</span>
                                      : <span className="text-zinc-700 italic">add perception…</span>
                                    }
                                  </div>
                                  <div className="flex items-center gap-1 text-[10px]">
                                    <span className="text-zinc-600 w-16 flex-shrink-0">role:</span>
                                    {myRole?.value
                                      ? <span className="text-zinc-400">{myRole.value}</span>
                                      : <span className="text-zinc-700 italic">add role…</span>
                                    }
                                  </div>
                                  <div className="flex items-center gap-1 text-[10px]">
                                    <span className="text-zinc-600 w-16 flex-shrink-0">alias:</span>
                                    {myPt?.alias_override
                                      ? <span className="text-zinc-400 italic">{myPt.alias_override}</span>
                                      : <span className="text-zinc-700 italic">add alias…</span>
                                    }
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                          {/* Entity-scoped change sub-chips at this node */}
                          {entityScopedChanges.length > 0 && (
                            <div className="flex flex-col gap-0.5 pt-0.5">
                              {entityScopedChanges.map((ch, i) => (
                                <RelChangeChip key={i} change={ch} getEntity={(id) => allEntities.find((e) => e.id === id) || null} onDismiss={() => removeRelationshipChange(rid, ch, nodeId)} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  {!showCreateRel && (
                    <button
                      onClick={() => setShowCreateRel(true)}
                      className="w-full text-[9px] text-accent-400/70 hover:text-accent-300 py-1 border border-dashed border-zinc-700 hover:border-zinc-500 rounded transition-colors mt-1"
                    >
                      + Add Relationship
                    </button>
                  )}
                  {showCreateRel && (() => {
                    const query = newRelPartnerSearch.trim().toLowerCase()
                    const availableToPick = allEntities.filter((e) =>
                      e.id !== entityId && !newRelSelectedPartnerIds.includes(e.id) &&
                      (query === '' || e.name.toLowerCase().includes(query))
                    ).slice(0, 20)
                    const selectedPartners = newRelSelectedPartnerIds
                      .map((id) => allEntities.find((e) => e.id === id))
                      .filter(Boolean)
                    const closePicker = () => {
                      setShowCreateRel(false)
                      setNewRelName('')
                      setNewRelPartnerSearch('')
                      setNewRelSelectedPartnerIds([])
                    }
                    const handleCreate = async () => {
                      if (newRelSelectedPartnerIds.length === 0) return
                      if (isOrigin) {
                        await createRelationshipViaEntityOrigin(
                          entityId,
                          newRelSelectedPartnerIds,
                          newRelName.trim() || null,
                        )
                      } else {
                        const allParticipantIds = [entityId, ...newRelSelectedPartnerIds]
                        await createRelationship({
                          name: newRelName.trim() || null,
                          history: {
                            ...createEmptyRelationshipHistory({ bornAtSceneId: nodeId }),
                            participant_changes: allParticipantIds.map((id) => ({
                              node_id: nodeId,
                              action: 'join',
                              entity_id: id,
                              initial_perception: '',
                              initial_alias_override: null,
                            })),
                          },
                        })
                      }
                      closePicker()
                    }
                    return (
                      <div className="bg-zinc-700/40 rounded p-2 mt-1 space-y-1.5">
                        <input
                          autoFocus
                          className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500 placeholder:text-zinc-600"
                          placeholder="Relationship name (optional)…"
                          value={newRelName}
                          onChange={(e) => setNewRelName(e.target.value)}
                        />
                        {selectedPartners.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {selectedPartners.map((p) => {
                              const colour = p.colour || '#888'
                              return (
                                <span key={p.id} className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] bg-zinc-800" style={{ border: `1px solid ${colour}` }}>
                                  <span className="text-zinc-200">{p.name}</span>
                                  <button
                                    className="text-zinc-500 hover:text-red-400"
                                    onClick={() => setNewRelSelectedPartnerIds((ids) => ids.filter((id) => id !== p.id))}
                                    title="Remove from selection"
                                  >×</button>
                                </span>
                              )
                            })}
                          </div>
                        )}
                        <input
                          className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-300 focus:outline-none focus:border-accent-500 placeholder:text-zinc-600"
                          placeholder="Filter entities…"
                          value={newRelPartnerSearch}
                          onChange={(e) => setNewRelPartnerSearch(e.target.value)}
                        />
                        {availableToPick.length > 0 ? (
                          <div className="max-h-28 overflow-y-auto space-y-0.5">
                            {availableToPick.map((e) => (
                              <button
                                key={e.id}
                                className="w-full flex items-center gap-1.5 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-600 rounded text-left"
                                onClick={() => {
                                  setNewRelSelectedPartnerIds((ids) => [...ids, e.id])
                                  setNewRelPartnerSearch('')
                                }}
                              >
                                {(() => {
                                  const assetName = e.profile_image_ref ? e.profile_image_ref.replace(/^assets\//, '') : null
                                  const colour = e.colour || '#888'
                                  const chip = (
                                    <span className="inline-flex items-center justify-center flex-shrink-0 rounded" style={{ width: 14, height: 14, backgroundColor: assetName ? 'transparent' : colour + '22', border: `1.5px solid ${colour}` }}>
                                      {assetName ? <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full rounded object-cover" /> : <span style={{ fontSize: 8 }}>{TYPE_ICONS[e.type] || '?'}</span>}
                                    </span>
                                  )
                                  return assetName ? <ImageHoverPreview src={`/api/project/assets/${assetName}`} borderColour={colour} size={80}>{chip}</ImageHoverPreview> : chip
                                })()}
                                <span className="truncate">{e.name}</span>
                                <span className="text-zinc-600 ml-auto">{e.type}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[9px] text-zinc-600 italic px-1">No matching entities</p>
                        )}
                        <div className="flex gap-2 justify-end">
                          <button className="text-xs text-zinc-400 hover:text-zinc-200" onClick={closePicker}>Cancel</button>
                          <button
                            className="text-xs px-2 py-0.5 rounded bg-accent-700/30 border border-accent-700/50 text-accent-300 hover:bg-accent-700/50 disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={newRelSelectedPartnerIds.length === 0}
                            onClick={handleCreate}
                          >Create</button>
                        </div>
                      </div>
                    )
                  })()}
                  {!isOrigin && (
                    <p className="text-[10px] text-zinc-700 italic mt-2">Wire entity chips on the canvas to link participants at a scene.</p>
                  )}
                </>
              )
            })()
          )}
          </div>
        )}

      </>)}
      footer={(<>
      <NotesFooterButton surface="entity" id={entityId} />

      <DraftSaveBar isDirty={isDirty} onSave={_entityDraftHandle.save} onDiscard={_entityDraftHandle.discard} />
      </>)}
    />

      {overflowOpenForRel && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setOverflowOpenForRel(null)}
        >
          <div
            className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl p-4 max-w-[300px] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const rel = allRelationships.find((r) => r.id === overflowOpenForRel)
              if (!rel) return null
              const relState = isOrigin ? null : computeRelationshipEffectiveState(rel, nodeOrder, nodeId)
              const pts = relState ? relState.participants : Array.from(new Set(
                (rel.history?.participant_changes || [])
                  .filter((c) => c.action === 'join')
                  .map((c) => c.entity_id)
              )).map((eid) => ({ entity_id: eid }))
              const resolveNameHere = (eid) => {
                const ent = allEntities.find((e) => e.id === eid)
                if (!ent) return null
                const s = computeEffectiveState(ent, nodes, edges, nodeId)
                return s?.name || ent.name || null
              }
              const label = rel.name || (pts.length > 0
                ? participantsFallbackLabel(pts, (id) => allEntities.find((e) => e.id === id), 2, rel, resolveNameHere)
                : 'Relationship')
              return (
                <>
                  <div className="text-xs text-zinc-300 font-medium mb-3 truncate">{label}</div>
                  <div className="flex flex-wrap gap-3">
                    {pts.map((p) => {
                      const e = allEntities.find((ent) => ent.id === p.entity_id)
                      if (!e) return null
                      const colour = e.colour || '#888'
                      const assetName = e.profile_image_ref ? e.profile_image_ref.replace(/^assets\//, '') : null
                      const src = assetName ? `/api/project/assets/${assetName}` : null
                      const avatar = (
                        <span
                          className="inline-flex items-center justify-center rounded"
                          style={{ width: 32, height: 32, backgroundColor: assetName ? 'transparent' : colour + '22', border: `2px solid ${colour}` }}
                        >
                          {assetName
                            ? <img src={src} alt="" className="w-full h-full rounded object-cover" />
                            : <span className="text-sm">{TYPE_ICONS[e.type] || '?'}</span>
                          }
                        </span>
                      )
                      return (
                        <button
                          key={p.entity_id}
                          className="flex flex-col items-center gap-1 group hover:opacity-90"
                          onClick={() => { navigateToReferencedEntity(p.entity_id); setOverflowOpenForRel(null) }}
                        >
                          {src
                            ? <ImageHoverPreview src={src} borderColour={colour} size={100}>{avatar}</ImageHoverPreview>
                            : avatar
                          }
                          <span className="text-[9px] text-zinc-300 group-hover:text-zinc-100 max-w-[52px] truncate" style={{ color: colour }}>{e.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )
            })()}
          </div>
        </div>,
        document.body
      )}
      {/* Phase 2.11b item 14 — Character Chat Setup modal mounted at
          panel scope. Only opened by the "🎭 Talk to this character"
          button in the cornerAction above; rendered unconditionally
          so the modal's `open` prop drives visibility. The Setup
          modal itself uses createPortal internally so it overlays
          everything else regardless of where it's mounted. */}
      <CharacterChatSetupModal
        open={talkSetupOpen}
        initialMeta={talkInitialMeta}
        initialCharacterId={talkInitialMeta?.character_id || null}
        onConfirm={async (meta, opts) => {
          setTalkSetupOpen(false)
          const hasProfile = (prefs?.ai_provider_profiles || []).length > 0
          if (!hasProfile) return
          await createCharacterChatThread(meta, opts, {
            createThread,
            prefs,
            charactersList: _entCharsForTalk,
            projectNodes: nodes,
            projectEdges: edges,
          })
          // The new thread is already the active one (createThread sets
          // it); open the chat panel so it's visible even if it was
          // closed/collapsed when starting from the detail tab.
          useUiStore.getState().openChatPanel()
        }}
        onClose={() => setTalkSetupOpen(false)}
        onConfirmAddSecond={(meta) => {
          // Phase 2.12 — snapshot modal 1's draft, layer modal 2 above.
          setFirstCharacterMetaForTalk(meta)
          setTalkSecondSetupOpen(true)
        }}
      />
      {/* Phase 2.12 — second Setup modal for the entity-detail-panel
          AI-to-AI flow. `allowAdd2nd=false` caps the flow at two
          characters. Closing via X / Esc returns to modal 1 (still
          mounted with state intact). On Confirm, both modals close
          and the two-character thread is created via the shared
          helper. */}
      <CharacterChatSetupModal
        open={talkSecondSetupOpen}
        initialCharacterId={null}
        allowAdd2nd={false}
        onConfirm={async (secondMeta, opts) => {
          setTalkSecondSetupOpen(false)
          setTalkSetupOpen(false)
          const first = firstCharacterMetaForTalk
          setFirstCharacterMetaForTalk(null)
          const hasProfile = (prefs?.ai_provider_profiles || []).length > 0
          if (!first || !hasProfile) return
          await createTwoCharacterChatThread(first, secondMeta, opts, {
            createThread,
            prefs,
            charactersList: _entCharsForTalk,
            projectNodes: nodes,
            projectEdges: edges,
          })
          useUiStore.getState().openChatPanel()
        }}
        onClose={() => setTalkSecondSetupOpen(false)}
      />

      <TagPopover
        key={_tagPopoverTarget?.tag?.id || 'closed'}
        isOpen={!!_tagPopoverTarget}
        onClose={_closeTagPopover}
        mode="project"
        tag={_tagPopoverTarget?.tag}
        anchor={_tagPopoverTarget?.anchor}
        anchorEl={_tagPopoverTarget?.anchorEl}
        readOnly
      />
    </>
  )
}

export default EntityDetailView
