import { useState } from 'react'
import { ChangeBadge } from './SharedEntityComponents'
import EntityColorPicker from '../ui/EntityColorPicker'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import CircumstanceMotivatorSubChip from '../ui/change-subchips/CircumstanceMotivatorSubChip'
import PerspectiveSubChip from '../ui/change-subchips/PerspectiveSubChip'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import RelationshipChangeChip from '../ui/change-subchips/RelationshipChangeChip'
import RelationshipHistoryChangeChip from '../ui/change-subchips/RelationshipHistoryChangeChip'
import ChangesAtThisPointSection from '../ui/ChangesAtThisPointSection'

// `RelationshipChangeChip` and `RelationshipHistoryChangeChip` were
// relocated in v0.1.21.99 to `components/ui/change-subchips/`. This
// file re-exports them so the existing import paths
// (`from './EntityDetailPanelShared'`) keep working until callers are
// migrated to import directly from the canonical location.
export { default as RelationshipChangeChip } from '../ui/change-subchips/RelationshipChangeChip'
export { default as RelationshipHistoryChangeChip } from '../ui/change-subchips/RelationshipHistoryChangeChip'

// ── ChangesSummarySection — shared "Changes at this point" rendering ─────────
// Used by EntityChipDetailView (scene chips + origin entity nodes) and
// EntityNodeModifierView (modifier entity nodes). Ensures all three sidebar
// views render the same sub-chip visuals with no code duplication.
//
// Splits the changeSubChips array into Attributes and Relationships groups,
// renders section headers when both groups have entries, uses ChangeSubChip
// for attribute entries and a compact RelationshipChangeChip for relationship
// entries (showing the partner entity's profile image and entity-coloured name
// to match how RelationshipSubChip renders on the canvas).


// Entity-specific wrapper around the Layer-2 `<ChangesAtThisPointSection>`
// primitive. Builds the entity's four groups (Attributes / Relationships /
// Relationship history / Awareness) from chain-walker output and hands the
// pre-rendered rows to the layout primitive.
export function ChangesSummarySection({ chips, tempCMChips, tempCMAccentColour, onDismissTempCM, onTempCMClick, awarenessChips, relationshipHistoryChips, entityColour, allEntities, allRelationships, allKnowledges, observerName, onDismissChip, onDismissProfileImage, onAddKnowledge, onMediaPreview, sectionTitle, onSwitchTab }) {
  const attrChips = (chips || []).filter((c) => !c.isRelationship)
  const relChips  = (chips || []).filter((c) => c.isRelationship)
  const awChips   = awarenessChips || []
  const relHistChips = relationshipHistoryChips || []
  const tempChips = tempCMChips || []

  const groups = [
    {
      key: 'attrs',
      title: 'Attributes',
      rows: [
        ...attrChips.map((chip, i) => {
        // Phase 2.13b — perspective change events use the dedicated
        // PerspectiveSubChip.
        if (chip.isPerspective) {
          return (
            <PerspectiveSubChip
              key={`attr-${i}`}
              description={chip.description}
              perspectiveTargetKind={chip.perspectiveTargetKind}
              perspectiveTargetId={chip.perspectiveTargetId}
              action={chip.action}
              oldDescription={chip.oldDescription}
              oldPerspectiveTargetKind={chip.oldPerspectiveTargetKind}
              oldPerspectiveTargetId={chip.oldPerspectiveTargetId}
              onClick={chip.attributeId && onSwitchTab ? () => onSwitchTab('attributes') : undefined}
              onDismiss={onDismissChip ? () => onDismissChip(chip) : undefined}
              onAddKnowledge={onAddKnowledge ? (e) => onAddKnowledge(chip, e) : undefined}
            />
          )
        }
        // Phase 1.22f — circumstance / motivator change events use the
        // dedicated CircumstanceMotivatorSubChip (chevron-corner type
        // badge + intensity badge + per-event payload). Other attribute
        // changes use the standard ChangeSubChip.
        if (chip.isCircumstanceOrMotivator) {
          return (
            <CircumstanceMotivatorSubChip
              key={`attr-${i}`}
              attributeType={chip.attributeType}
              name={chip.field}
              description={chip.description}
              intensity={chip.intensity ?? null}
              action={chip.action}
              oldValue={chip.oldValue}
              newValue={chip.newValue}
              oldIntensity={chip.oldIntensity}
              newIntensity={chip.newIntensity}
              onClick={chip.attributeId && onSwitchTab ? () => onSwitchTab('attributes') : undefined}
              onDismiss={onDismissChip ? () => onDismissChip(chip) : undefined}
              onAddKnowledge={onAddKnowledge ? (e) => onAddKnowledge(chip, e) : undefined}
            />
          )
        }
        return (
          <ChangeSubChip
            key={`attr-${i}`}
            chip={chip}
            entityColour={entityColour}
            onDismiss={
              onDismissChip ? () => onDismissChip(chip)
              : (chip.isProfileImage && onDismissProfileImage ? onDismissProfileImage : undefined)
            }
            onAddKnowledge={onAddKnowledge ? (e) => onAddKnowledge(chip, e) : undefined}
            onMediaPreviewClick={chip.isFileAttribute && onMediaPreview ? (fileRef) => onMediaPreview(chip, fileRef) : undefined}
            onClick={chip.attributeId && onSwitchTab ? () => onSwitchTab('attributes') : undefined}
          />
        )
      }),
      // Phase 1.22h — temporary circumstances / motivators for this
      // entity at this scene. Scene-side data (NOT chain-tracked); the
      // scene IS their origin so reading directly is the chain-aware
      // path. Append after the chain-change attr chips so the writer
      // scans chain → temp top to bottom. Rendered with the chevron-
      // corner pentagon variant + dashed accent border to mark the
      // scene-only scope.
      ...tempChips.map((t) => (
        <CircumstanceMotivatorSubChip
          key={`tempcm-${t.id}`}
          attributeType={t.attribute_type}
          name={t.name || ''}
          description={t.description || ''}
          intensity={t.intensity ?? null}
          action="add"
          temporary
          temporaryColour={tempCMAccentColour}
          dashedOutline={tempCMAccentColour}
          onClick={onTempCMClick}
          onDismiss={onDismissTempCM ? () => onDismissTempCM(t) : undefined}
        />
      )),
      ],
    },
    {
      key: 'rels',
      title: 'Relationships',
      rows: relChips.map((chip, i) => (
        <RelationshipChangeChip
          key={`rel-${i}`}
          chip={chip}
          allEntities={allEntities}
          onClick={onSwitchTab ? () => onSwitchTab('relationships') : undefined}
          onDismiss={onDismissChip ? () => onDismissChip(chip) : undefined}
        />
      )),
    },
    {
      key: 'relhist',
      title: 'Relationship history',
      rows: relHistChips.map((entry, i) => (
        <RelationshipHistoryChangeChip
          key={`relhist-${entry.relationship?.id}-${entry.change?.type}-${i}`}
          entry={entry}
          getEntity={(eid) => allEntities?.find((e) => e.id === eid) || null}
          onClick={onSwitchTab ? () => onSwitchTab('relationships') : undefined}
        />
      )),
    },
    {
      key: 'aware',
      title: 'Awareness',
      rows: awChips.map((rec) => (
        <AwarenessSubChip
          key={rec.changeId || `${rec.kind}-${rec.targetEntityId || rec.knowledgeId || rec.relationshipId}`}
          record={rec}
          observerName={observerName}
          getEntity={(eid) => allEntities?.find((e) => e.id === eid) || null}
          getRelationship={(rid) => allRelationships?.find((r) => r.id === rid) || null}
          getKnowledge={(kid) => allKnowledges?.find((k) => k.id === kid) || null}
          onClick={onSwitchTab ? () => onSwitchTab('awareness') : undefined}
        />
      )),
    },
  ]

  return (
    <ChangesAtThisPointSection groups={groups} sectionTitle={sectionTitle || 'Changes at this point'} />
  )
}

// ── AliasesOverrideRow — inherited-or-override aliases for mid-chain views ────
// Matches TextListAttribute visual style: green chips for newly added, red
// strikethrough + revert arrow for removed, plain gray for unchanged.
// Both inheritedAliases and overrideValue may contain Alias objects or strings;
// we normalise to plain strings internally and convert back to Alias objects on onChange.

export function AliasesOverrideRow({ inheritedAliases, overrideValue, onChange, onClear }) {
  const hasOverride = overrideValue !== null && overrideValue !== undefined
  const [inputVal, setInputVal] = useState('')

  // Normalise: always work with plain strings inside this component
  const toStrings = (arr) => (arr || []).map((a) => (typeof a === 'string' ? a : a.value))
  const toAliasObjects = (strings) => strings.map((v) => ({ value: v, aware_entity_ids: [] }))

  const inherited = toStrings(inheritedAliases)
  const effectiveList = hasOverride ? toStrings(overrideValue) : inherited

  const inheritedSet = new Set(inherited)
  const effectiveSet = new Set(effectiveList)
  const addedSet   = new Set(effectiveList.filter(a => !inheritedSet.has(a)))
  const removedSet = new Set(inherited.filter(a => !effectiveSet.has(a)))

  // Show all inherited items (incl. removed ones as red) plus any newly added items.
  const displayItems = [...inherited, ...effectiveList.filter(a => !inheritedSet.has(a))]

  function _isIdenticalToInherited(list) {
    if (list.length !== inherited.length) return false
    const s = new Set(list)
    return inherited.every(a => s.has(a))
  }

  function addAlias() {
    const trimmed = inputVal.trim()
    if (!trimmed || effectiveList.includes(trimmed)) { setInputVal(''); return }
    const newList = [...effectiveList, trimmed]
    onChange(toAliasObjects(newList))
    setInputVal('')
  }

  function removeAlias(alias) {
    const newList = effectiveList.filter(a => a !== alias)
    if (_isIdenticalToInherited(newList)) { onClear(); return }
    onChange(toAliasObjects(newList))
  }

  function revertAlias(alias) {
    const newList = [...effectiveList, alias]
    if (_isIdenticalToInherited(newList)) { onClear(); return }
    onChange(toAliasObjects(newList))
  }

  return (
    <div data-help-region="detail-panel:details_aliases_override" className="mb-3">
      {hasOverride && (
        <div className="flex items-center justify-end gap-1 mb-1">
          <ChangeBadge action="modify" />
          <button onClick={onClear} className="text-[11px] font-bold text-zinc-600 hover:text-red-400 leading-none" title="Clear override">−</button>
        </div>
      )}
      {/* Chip row + input row mirror `AliasTagEditor`'s structure exactly so
          origin-view and scene-view aliases are at the same vertical
          position when empty (both render "None" inside a `min-h-[20px]
          mb-1.5` container, then the input). */}
      <div className="flex flex-wrap gap-1 mb-1.5 min-h-[20px]">
        {displayItems.map((alias) => {
          const isPendingAdd    = addedSet.has(alias)
          const isPendingRemove = removedSet.has(alias)
          let chipCls, textCls
          if (isPendingRemove) {
            chipCls = 'bg-red-900/30 border border-red-800/60'
            textCls = 'text-zinc-400 line-through'
          } else if (isPendingAdd) {
            chipCls = 'bg-green-900/30 border border-green-800/60'
            textCls = 'text-green-300'
          } else {
            chipCls = 'bg-zinc-700'
            textCls = 'text-zinc-300'
          }
          return (
            <span key={alias} className={`inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5 ${chipCls}`}>
              <span className={textCls}>{alias}</span>
              {isPendingRemove ? (
                <button
                  type="button"
                  onClick={() => revertAlias(alias)}
                  className="text-amber-500 hover:text-amber-300 leading-none ml-0.5 text-[10px]"
                  title="Undo remove"
                >↩</button>
              ) : (
                <button
                  type="button"
                  onClick={() => removeAlias(alias)}
                  className="text-zinc-400 hover:text-red-400 leading-none ml-0.5"
                  title="Remove"
                >×</button>
              )}
            </span>
          )
        })}
        {displayItems.length === 0 && <span className="text-[10px] text-zinc-600 italic">None</span>}
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-zinc-100 focus:outline-none focus:border-accent-500"
          placeholder="Add alias..."
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias() } }}
        />
        <button
          onClick={addAlias}
          className="px-2 py-0.5 text-[10px] bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
        >+</button>
      </div>
    </div>
  )
}

// ── Navigation helper: route to the correct detail panel mode for a chain stop ─

export function navigateToChainStop(setDetailPanel, node, entityId, chainIndex) {
  if (node.type === 'entityNode') {
    if (node.data.is_modifier) {
      setDetailPanel('entityNodeModifier', node.id, entityId, chainIndex)
    } else {
      setDetailPanel('entityNode', node.id, entityId, chainIndex)
    }
  } else {
    setDetailPanel('entityChip', node.id, entityId, chainIndex)
  }
}
