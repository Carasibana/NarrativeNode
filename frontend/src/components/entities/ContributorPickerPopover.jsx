/**
 * ContributorPickerPopover — Phase 1.21g Step 4
 *
 * Unified picker for any of the three contributor kinds an awareness
 * field can hold:
 *   - Direct entity contributor — one entity at a level.
 *   - Relationship source       — projects every active participant
 *                                 of a relationship to a level.
 *   - Entity-list attribute     — projects every entry of an
 *                                 entity_list attribute to a level.
 *
 * Layout follows the existing `EntityPickerPopover` visual style:
 * tabs across the top to filter the list, search, scrollable list of
 * matches. Tabs:
 *   ⊕   All entity types     — flat entity list (any of the 5 types)
 *   👤  Characters
 *   📍  Locations
 *   🎒  Items
 *   🚩  Factions
 *   🔧  Custom entities
 *   🔗  Relationships          — list of relationships
 *   📋  Entity-list attributes — folder rows per parent entity; expand
 *                                to reveal that entity's entity_list
 *                                attributes
 *
 * Calls `onPick(contributor)` with one of:
 *   { kind: 'entity',       entity_id }
 *   { kind: 'relationship', relationship_id }
 *   { kind: 'attribute',    entity_id, attribute_id }
 *
 * The popover stays open after a pick so callers can add multiple
 * contributors before dismissing.
 */

import { useMemo, useState } from 'react'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import { RelationshipIcon, RelationshipLabelChip, EntityAvatar, KnowledgeIcon } from '../ui/IdentityBadges'

// Tabs use plain TYPE_ICONS for entity types (since those are already
// glyph strings); relationship tab renders the canonical
// `<RelationshipIcon />` from IdentityBadges as a JSX node so the tab
// matches the violet relationship visual everywhere else in the app.
const TABS = [
  { key: 'all',          icon: '⊕',                  label: 'All entity types' },
  { key: 'character',    icon: TYPE_ICONS.character, label: 'Characters' },
  { key: 'location',     icon: TYPE_ICONS.location,  label: 'Locations' },
  { key: 'item',         icon: TYPE_ICONS.item,      label: 'Items' },
  { key: 'faction',      icon: TYPE_ICONS.faction,   label: 'Factions' },
  { key: 'custom',       icon: TYPE_ICONS.custom,    label: 'Custom entities' },
  { key: 'relationship', icon: <RelationshipIcon size={14} />, label: 'Relationships' },
  { key: 'knowledge',    icon: <KnowledgeIcon size={14} />,    label: 'Knowledges' },
  { key: 'attribute',    icon: '📋',                  label: 'Entity-list attributes' },
  { key: 'alias',        icon: '🏷',                  label: 'Entity aliases' },
]
const ENTITY_TAB_KEYS = new Set(['all', 'character', 'location', 'item', 'faction', 'custom'])

function EntityRow({ entity, onClick }) {
  return (
    <button
      data-help-region="contributor-picker:entity_row"
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
    >
      <EntityAvatar entity={entity} size={16} />
      <span className="text-[10px] text-zinc-200 truncate flex-1">{entity.name}</span>
      <span className="text-[10px] flex-shrink-0" title={entity.type}>{TYPE_ICONS[entity.type] || '?'}</span>
    </button>
  )
}

function RelationshipRow({ relationship, onClick, getEntity }) {
  // Same fallback the rest of the app uses: explicit name first, otherwise
  // synthesise from active participants (e.g. "Alice & Bob & Carol"). Falls
  // back to a short id stub if even that's empty (newly-created relationship
  // with no joins yet).
  const explicit = relationship.name?.trim()
  let name = explicit
  if (!name) {
    const joinIds = Array.from(new Set(
      ((relationship.history?.participant_changes) || [])
        .filter((c) => c.action === 'join')
        .map((c) => c.entity_id),
    ))
    name = participantsFallbackLabel(
      joinIds.map((eid) => ({ entity_id: eid })),
      getEntity,
      3,
      relationship,
    )
  }
  if (!name) name = `Relationship ${(relationship.id || '').slice(0, 6)}…`
  return (
    <button
      data-help-region="contributor-picker:relationship_row"
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
    >
      <RelationshipLabelChip name={name} />
    </button>
  )
}

function AttributeFolderRow({ entity, attributes, expanded, onToggle, onPickAttribute }) {
  return (
    <div data-help-region="contributor-picker:attribute_folder">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
      >
        <span className="text-[10px] text-zinc-500 w-3 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
        <EntityAvatar entity={entity} size={16} />
        <span className="text-[10px] text-zinc-200 truncate flex-1">{entity.name}</span>
        <span className="text-[9px] text-zinc-500 flex-shrink-0">{attributes.length} list{attributes.length === 1 ? '' : 's'}</span>
      </button>
      {expanded && attributes.map((attr) => (
        <button
          key={attr.id}
          type="button"
          onClick={() => onPickAttribute(attr.id)}
          className="w-full flex items-center gap-1.5 pl-7 pr-1 py-0.5 rounded text-left hover:bg-zinc-700"
        >
          <span className="text-[10px] text-zinc-400 truncate flex-1">{attr.name || '(unnamed attribute)'}</span>
          <span className="text-[9px] text-zinc-500 flex-shrink-0">📋</span>
        </button>
      ))}
    </div>
  )
}

function AliasFolderRow({ entity, aliases, expanded, onToggle, onPickAlias }) {
  return (
    <div data-help-region="contributor-picker:alias_folder">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
      >
        <span className="text-[10px] text-zinc-500 w-3 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
        <EntityAvatar entity={entity} size={16} />
        <span className="text-[10px] text-zinc-200 truncate flex-1">{entity.name}</span>
        <span className="text-[9px] text-zinc-500 flex-shrink-0">{aliases.length} alias{aliases.length === 1 ? '' : 'es'}</span>
      </button>
      {expanded && aliases.map((val) => (
        <button
          key={val}
          type="button"
          onClick={() => onPickAlias(val)}
          className="w-full flex items-center gap-1.5 pl-7 pr-1 py-0.5 rounded text-left hover:bg-zinc-700"
        >
          <span className="text-[10px] text-zinc-400 truncate flex-1">{val || '(unnamed alias)'}</span>
          <span className="text-[9px] text-zinc-500 flex-shrink-0">🏷</span>
        </button>
      ))}
    </div>
  )
}

export default function ContributorPickerPopover({
  allEntities = [],
  allRelationships = [],
  allKnowledges = [],
  excludeEntityIds = null,
  excludeRelationshipIds = null,
  excludeAttributeKeys = null,  // Set of `${entity_id}:${attribute_id}` to hide
  excludeKnowledgeIds = null,
  excludeAliasKeys = null,      // Set of `${entity_id}:${alias_value}` to hide
  onPick,
  onClose,
}) {
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [expandedAttrEntity, setExpandedAttrEntity] = useState(null)
  const [expandedAliasEntity, setExpandedAliasEntity] = useState(null)

  const exclEnt   = excludeEntityIds       instanceof Set ? excludeEntityIds       : new Set(excludeEntityIds       || [])
  const exclRel   = excludeRelationshipIds instanceof Set ? excludeRelationshipIds : new Set(excludeRelationshipIds || [])
  const exclAttr  = excludeAttributeKeys   instanceof Set ? excludeAttributeKeys   : new Set(excludeAttributeKeys   || [])
  const exclKnow  = excludeKnowledgeIds    instanceof Set ? excludeKnowledgeIds    : new Set(excludeKnowledgeIds    || [])
  const exclAlias = excludeAliasKeys       instanceof Set ? excludeAliasKeys       : new Set(excludeAliasKeys       || [])

  const filteredEntities = useMemo(() => {
    if (!ENTITY_TAB_KEYS.has(tab)) return []
    const s = search.trim().toLowerCase()
    return (allEntities || [])
      .filter((e) => e?.type !== 'knowledge')
      .filter((e) => tab === 'all' || e.type === tab)
      .filter((e) => !exclEnt.has(e.id))
      .filter((e) => !s || (e.name || '').toLowerCase().includes(s))
      .slice(0, 50)
  }, [allEntities, tab, search, exclEnt])

  const filteredRelationships = useMemo(() => {
    if (tab !== 'relationship') return []
    const s = search.trim().toLowerCase()
    return (allRelationships || [])
      .filter((r) => !exclRel.has(r.id))
      .filter((r) => !s || (r.name?.toLowerCase().includes(s)))
      .slice(0, 50)
  }, [allRelationships, tab, search, exclRel])

  // For the attribute tab: build folder rows. Each entity that owns at
  // least one entity_list attribute that isn't already excluded gets a
  // row; the row expands to reveal the entity's entity_list attrs.
  const attributeFolders = useMemo(() => {
    if (tab !== 'attribute') return []
    const s = search.trim().toLowerCase()
    const folders = []
    for (const e of (allEntities || [])) {
      if (e?.type === 'knowledge') continue
      const lists = (e.attributes || []).filter((a) => a.attribute_type === 'entity_list')
        .filter((a) => !exclAttr.has(`${e.id}:${a.id}`))
        .filter((a) => !s
          || (e.name || '').toLowerCase().includes(s)
          || (a.name || '').toLowerCase().includes(s))
      if (lists.length > 0) folders.push({ entity: e, attributes: lists })
    }
    return folders.slice(0, 50)
  }, [allEntities, tab, search, exclAttr])

  const filteredKnowledges = useMemo(() => {
    if (tab !== 'knowledge') return []
    const s = search.trim().toLowerCase()
    return (allKnowledges || [])
      .filter((k) => !exclKnow.has(k.id))
      .filter((k) => !s || (k.name || '').toLowerCase().includes(s))
      .slice(0, 50)
  }, [allKnowledges, tab, search, exclKnow])

  // Alias tab: folder rows per entity that owns at least one alias, mirroring
  // the entity-list attribute folders. Aliases may be stored as strings or
  // `{ value }` objects; normalise to the string value for picking.
  const aliasFolders = useMemo(() => {
    if (tab !== 'alias') return []
    const s = search.trim().toLowerCase()
    const folders = []
    for (const e of (allEntities || [])) {
      if (e?.type === 'knowledge') continue
      const aliases = (e.aliases || [])
        .map((a) => (typeof a === 'string' ? a : a?.value))
        .filter((v) => v != null && v !== '')
        .filter((v) => !exclAlias.has(`${e.id}:${v}`))
        .filter((v) => !s || (e.name || '').toLowerCase().includes(s) || v.toLowerCase().includes(s))
      if (aliases.length > 0) folders.push({ entity: e, aliases })
    }
    return folders.slice(0, 50)
  }, [allEntities, tab, search, exclAlias])

  return (
    <div data-help-region="contributor-picker:popover" className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden">
      <div data-help-region="contributor-picker:type_tabs" className="flex border-b border-zinc-700">
        {TABS.map((t) => {
          const isActive = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); setExpandedAttrEntity(null); setExpandedAliasEntity(null) }}
              title={t.label}
              className={`flex-1 flex items-center justify-center py-1 text-sm transition-colors border-b-2 ${
                isActive
                  ? 'bg-zinc-700 text-zinc-100 border-accent-500'
                  : 'bg-zinc-800 text-zinc-400 border-transparent hover:bg-zinc-700/50 hover:text-zinc-200'
              }`}
            >
              {t.icon}
            </button>
          )
        })}
      </div>

      <div className="p-1.5 space-y-1">
        <input
          data-help-region="contributor-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />

        <div className="max-h-40 overflow-y-auto space-y-0.5">
          {ENTITY_TAB_KEYS.has(tab) && filteredEntities.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {ENTITY_TAB_KEYS.has(tab) && filteredEntities.map((e) => (
            <EntityRow
              key={e.id}
              entity={e}
              onClick={() => onPick({ kind: 'entity', entity_id: e.id })}
            />
          ))}

          {tab === 'relationship' && filteredRelationships.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No relationships.</p>
          )}
          {tab === 'relationship' && filteredRelationships.map((r) => (
            <RelationshipRow
              key={r.id}
              relationship={r}
              getEntity={(eid) => (allEntities || []).find((e) => e.id === eid) || null}
              onClick={() => onPick({ kind: 'relationship', relationship_id: r.id })}
            />
          ))}

          {tab === 'attribute' && attributeFolders.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">
              No entity-list attributes available.
            </p>
          )}
          {tab === 'attribute' && attributeFolders.map((f) => (
            <AttributeFolderRow
              key={f.entity.id}
              entity={f.entity}
              attributes={f.attributes}
              expanded={expandedAttrEntity === f.entity.id}
              onToggle={() => setExpandedAttrEntity((cur) => cur === f.entity.id ? null : f.entity.id)}
              onPickAttribute={(attributeId) => onPick({
                kind: 'attribute',
                entity_id: f.entity.id,
                attribute_id: attributeId,
              })}
            />
          ))}

          {tab === 'knowledge' && filteredKnowledges.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No knowledges.</p>
          )}
          {tab === 'knowledge' && filteredKnowledges.map((k) => (
            <button
              key={k.id}
              data-help-region="contributor-picker:knowledge_row"
              type="button"
              onClick={() => onPick({ kind: 'knowledge', knowledge_id: k.id })}
              className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
            >
              <KnowledgeIcon size={16} />
              <span className="text-[10px] text-zinc-200 truncate flex-1">{k.name || '(unnamed)'}</span>
            </button>
          ))}

          {tab === 'alias' && aliasFolders.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No aliases available.</p>
          )}
          {tab === 'alias' && aliasFolders.map((f) => (
            <AliasFolderRow
              key={f.entity.id}
              entity={f.entity}
              aliases={f.aliases}
              expanded={expandedAliasEntity === f.entity.id}
              onToggle={() => setExpandedAliasEntity((cur) => cur === f.entity.id ? null : f.entity.id)}
              onPickAlias={(aliasValue) => onPick({ kind: 'alias', entity_id: f.entity.id, alias_value: aliasValue })}
            />
          ))}
        </div>

        <button
          data-help-region="contributor-picker:close"
          type="button"
          onClick={onClose}
          className="w-full text-[9px] text-zinc-500 hover:text-zinc-300 text-center"
        >
          Close picker
        </button>
      </div>
    </div>
  )
}
