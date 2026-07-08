import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { useProgramTagsStore } from '../../store/programTagsStore'
import { RelationshipIcon, KnowledgeIcon, EntityAvatar, NodeBadge, CueIcon } from '../ui/IdentityBadges'
import { ActionGlyphBadge } from '../ui/change-subchips/atoms'
import { BaseChangeChip } from '../ui/ChangeChipBase'
import CircumstanceMotivatorSubChip from '../ui/change-subchips/CircumstanceMotivatorSubChip'
import { CircumstanceTypeBadge, MotivatorTypeBadge, PerspectiveTypeBadge } from '../ui/TypeBadges'
import TagBadge from '../tags/TagBadge'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import { resolveChapterIdForNodeForStory } from '../../utils/chapterMembership'
import { runGlobalSearch } from '../../utils/globalSearch'
import { useTagHostIndex } from '../../hooks/useTagHostIndex'

/**
 * Dispatch a search result to the relevant canvas / panel surfaces.
 * Branches by `result.kind` and reuses existing store actions
 * wherever possible so the modal stays a thin entry point.
 *
 * Side effects:
 *   - canvas pan via `_focusNode(nodeId)` for results with a node id
 *   - left-sidebar detail panel via `setDetailPanel` /
 *     `openRelationshipDetail` / `openKnowledgeDetail`
 *   - right-sidebar editor via `openRightSidebar(nodeId)` for scene
 *     results (so the writer lands directly in the text editor)
 *
 * Chapter / act results don't carry a node id and don't currently
 * have a viewport-focus action of their own; they close the modal
 * without further side effects until / unless writer feedback flags
 * the gap.
 */
function navigateToSearchResult(result) {
  if (!result) return
  const ui = useUiStore.getState()
  const project = useProjectStore.getState()
  const focus = ui._focusNode
  const nodes = project.nodes || []

  // Helper: find an entity's origin node id (entityNode where
  // is_modifier !== true). Used by entity / attribute / knowledge
  // results to anchor the detail panel at the entity's origin when
  // the result has no more specific anchor.
  const originNodeIdForEntity = (entityId) => {
    const n = nodes.find((nd) => nd.type === 'entityNode' && nd.data?.is_modifier !== true && nd.data?.entity_id === entityId)
    return n?.id || null
  }

  const fitNodes = ui._fitViewToNodes
  const story = project.story || {}

  switch (result.kind) {
    case 'entity': {
      const entityId = result.entityId || result.id
      const anchorId = result.anchorNodeId || originNodeIdForEntity(entityId)
      if (anchorId && focus) focus(anchorId)
      const anchor = anchorId ? nodes.find((n) => n.id === anchorId) : null
      const mode = anchor && anchor.type === 'entityNode' && !anchor.data?.is_modifier ? 'entityNode' : 'entityChip'
      ui.setDetailPanel(mode, anchorId, entityId, -1)
      break
    }
    case 'attribute':
    case 'circumstance':
    case 'motivator':
    case 'perspective': {
      // Same canvas + Detail Panel anchor as `entity`, but route to
      // the **Attributes** sub-tab (the writer is asking about an
      // attribute / c / m / perspective, so land on the tab that
      // surfaces it). Perspectives are themselves entity attributes
      // (`attribute_type='perspective'`), so the same routing shape
      // applies.
      const entityId = result.entityId || result.id
      const anchorId = result.anchorNodeId || originNodeIdForEntity(entityId)
      if (anchorId && focus) focus(anchorId)
      const anchor = anchorId ? nodes.find((n) => n.id === anchorId) : null
      const mode = anchor && anchor.type === 'entityNode' && !anchor.data?.is_modifier ? 'entityNode' : 'entityChip'
      ui.setDetailPanel(mode, anchorId, entityId, -1, 'attributes')
      break
    }
    case 'contextCue': {
      // Cues live program-level; open the cue editor in the right
      // sidebar via the existing uiStore action.
      ui.openContextCueEditor?.(result.id)
      break
    }
    case 'knowledge': {
      ui.openKnowledgeDetail(result.id, result.anchorNodeId || null)
      if (result.anchorNodeId && focus) focus(result.anchorNodeId)
      break
    }
    case 'relationship': {
      ui.openRelationshipDetail(result.id, result.anchorNodeId || null)
      if (result.anchorNodeId && focus) focus(result.anchorNodeId)
      break
    }
    case 'scene': {
      if (focus) focus(result.id)
      ui.setDetailPanel('scene', result.id, null, -1)
      ui.openRightSidebar(result.id)
      break
    }
    case 'transition': {
      // Frame source + target scenes together so the wire (and its
      // transition note dot, which sits on the wire midpoint) lands
      // in the centre of the viewport. Falls back to single-node
      // focus when only one endpoint resolves. Then expand the
      // transition note dot if it's currently collapsed so the
      // writer lands directly on the editable text instead of a dot
      // they have to click again.
      const ids = [result.sourceNodeId, result.targetNodeId].filter(Boolean)
      if (ids.length >= 2 && fitNodes) fitNodes(ids, { padding: 0.35 })
      else if (ids[0] && focus) focus(ids[0])
      if (result.id) project.updateEdgeData?.(result.id, { is_expanded: true })
      break
    }
    case 'chapter': {
      // Pan + zoom to the chapter's span: gather every scene whose
      // canvas position falls inside this chapter (per the mode-aware
      // `resolveChapterIdForNodeForStory`) and fit them. Mirrors the
      // Table-of-Contents Panel's chapter-click behaviour without
      // needing direct access to React Flow's setCenter.
      const sceneIds = []
      for (const n of nodes) {
        if (n.type !== 'sceneNode') continue
        if (resolveChapterIdForNodeForStory(n, story) === result.id) sceneIds.push(n.id)
      }
      if (sceneIds.length > 0 && fitNodes) fitNodes(sceneIds, { padding: 0.18 })
      break
    }
    case 'act': {
      // Acts span a contiguous run of chapters; collect every scene
      // whose chapter id is in the act's `chapter_ids` list.
      const act = (story.acts || []).find((a) => a && a.id === result.id)
      const chapterIds = new Set(act?.chapter_ids || [])
      if (chapterIds.size === 0) break
      const sceneIds = []
      for (const n of nodes) {
        if (n.type !== 'sceneNode') continue
        const cid = resolveChapterIdForNodeForStory(n, story)
        if (cid && chapterIds.has(cid)) sceneIds.push(n.id)
      }
      if (sceneIds.length > 0 && fitNodes) fitNodes(sceneIds, { padding: 0.18 })
      break
    }
    case 'referenceNote':
    case 'groupNode':
    case 'povOriginNode': {
      if (result.id && focus) focus(result.id)
      break
    }
    case 'taggedHost': {
      // Phase 3.4e — tag-channel hits route to the same surfaces as
      // a direct entity / knowledge / etc. hit. Branches by
      // `hostKind` so each pool type lands where the writer expects.
      const hostKind = result.hostKind
      if (hostKind === 'character' || hostKind === 'location'
        || hostKind === 'item' || hostKind === 'faction' || hostKind === 'custom') {
        const anchorId = originNodeIdForEntity(result.id)
        if (anchorId && focus) focus(anchorId)
        const anchor = anchorId ? nodes.find((n) => n.id === anchorId) : null
        const mode = anchor && anchor.type === 'entityNode' && !anchor.data?.is_modifier ? 'entityNode' : 'entityChip'
        ui.setDetailPanel(mode, anchorId, result.id, -1)
      } else if (hostKind === 'knowledge') {
        ui.openKnowledgeDetail(result.id, null)
      } else if (hostKind === 'relationship') {
        ui.openRelationshipDetail(result.id, null)
      } else if (hostKind === 'presetList') {
        // Land on the Tags & Lists library tab where preset lists live.
        ui.setEntityLibraryTab?.('tags_and_lists')
      } else if (hostKind === 'referenceNode') {
        if (result.id && focus) focus(result.id)
      } else if (hostKind === 'cue') {
        ui.openContextCueEditor?.(result.id)
      } else if (hostKind === 'conversation') {
        // Open the chat panel and set the active thread directly.
        useConversationsStore.getState().setActiveThreadId?.(result.id)
        ui.openChatPanel?.()
      }
      break
    }
    default:
      break
  }
}

// Group display labels and render order. Mirrors the engine's
// `GROUP_ORDER` so the panel doesn't need to import it.
const GROUP_LABELS = {
  characters:     'Characters',
  locations:      'Locations',
  items:          'Items',
  factions:       'Factions',
  customs:        'Customs',
  knowledges:     'Knowledge',
  relationships:  'Relationships',
  cues:           'Context Cues',
  references:     'References',
  attributes:     'Attributes',
  circumstances:  'Circumstances',
  motivators:     'Motivators',
  perspectives:   'Perspectives',
  scenes:         'Scenes',
  chapters:       'Chapters',
  acts:           'Acts',
  other:          'Other',
}

// Inline glyphs for chips whose primitives don't already live in
// IdentityBadges / TypeBadges. Sized 14px to match the chip row.

function EntityTypeChipIcon({ type }) {
  // Mirrors the no-image fallback in `EntityAvatar`: emoji from
  // TYPE_ICONS in a 14px rounded-square frame. Border / tint are
  // intentionally transparent here because the chip itself already
  // carries the on/off treatment via outer button styling.
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none align-middle"
      style={{ width: 14, height: 14, fontSize: 11 }}
    >
      {TYPE_ICONS[type] || '?'}
    </span>
  )
}

function SceneChipIcon() {
  // Purple "S" letter pill in the style of scene NodeBadges
  // (text-purple-400 over bg-purple-900/30). Mirrors the visual
  // identity of `NODE_BADGE_STYLES.scene` so a scene chip in the
  // search modal reads as the same family the canvas uses.
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none align-middle font-bold"
      style={{
        width: 14,
        height: 14,
        fontSize: 9,
        backgroundColor: 'rgba(88, 28, 135, 0.45)' /* purple-900/30 with a touch more solidity for chip context */,
        color: '#c084fc' /* purple-400 */,
      }}
    >
      S
    </span>
  )
}

// Chapter / Act chip icons — letter pills tinted with the standard
// chapter / act overlay greys. No project-wide ChapterIcon /
// ActIcon primitive exists yet; if one ships later this is the
// natural place to swap to it.
function ChapterChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none align-middle font-bold"
      style={{ width: 14, height: 14, fontSize: 9, backgroundColor: '#52525b66', color: '#d4d4d8' }}
    >
      C
    </span>
  )
}

// References chip icon — pushpin glyph matches the library
// sidebar's References tab button (📌 / U+1F4CC).
function ReferenceChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center leading-none select-none align-middle"
      style={{ width: 14, height: 14, fontSize: 12 }}
      aria-hidden
    >
      &#x1F4CC;
    </span>
  )
}

function ActChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none align-middle font-bold"
      style={{ width: 14, height: 14, fontSize: 9, backgroundColor: '#3f3f4666', color: '#a1a1aa' }}
    >
      A
    </span>
  )
}

function AttributesChipIcon() {
  // Placeholder until a dedicated Attributes icon ships. Uses the
  // same 14px frame as the other chip icons so the row stays aligned.
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none"
      style={{ width: 14, height: 14, fontSize: 8, fontWeight: 700, letterSpacing: 0.2 }}
    >
      ATR
    </span>
  )
}

// Type-filter chips. All on by default; chip state is local to each
// modal-open session per planning §3.7. Entities are split into
// individual sub-type chips (character / location / item / faction /
// custom) so the writer can scope to a single entity family.
// Knowledges are listed after entity sub-types since they sit
// alongside entities conceptually post-1.21. Scenes use a purple "S"
// badge mirroring scene NodeBadge styling.
// Borderless Knowledge glyph for the scope-chip row. The bordered+
// tinted `KnowledgeIcon` reads as an identity chip in inline-prose
// contexts (alerts, detail panels, snippet rows); for the search
// filter row we want a plain emoji so the chip's own border /
// background is the only frame around it. Matches the other
// emoji-style chip icons (scenes / chapters / acts / references).
function KnowledgeChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center leading-none select-none align-middle"
      style={{ width: 14, height: 14, fontSize: 12 }}
      aria-hidden
    >
      📜
    </span>
  )
}

// Borderless Tag glyph for the scope-chip row. Mirrors the other
// emoji-style chip icons (Knowledge / Context Cue / Scenes etc.).
// The bordered+coloured `TagBadge` is the inline-prose identity
// chip; this is the chip-row counterpart.
function TagChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center leading-none select-none align-middle"
      style={{ width: 14, height: 14, fontSize: 12 }}
      aria-hidden
    >
      🏷️
    </span>
  )
}

// Borderless Context Cue glyph for the scope-chip row. Mirrors
// `KnowledgeChipIcon` — the bordered+tinted `CueIcon` is the inline-
// prose identity chip; this is the chip-row counterpart.
function ContextCueChipIcon() {
  return (
    <span
      className="inline-flex items-center justify-center leading-none select-none align-middle"
      style={{ width: 14, height: 14, fontSize: 12 }}
      aria-hidden
    >
      🧩
    </span>
  )
}

const SCOPE_CHIPS = [
  { key: 'characters',    label: 'Characters',    icon: () => <EntityTypeChipIcon type="character" /> },
  { key: 'locations',     label: 'Locations',     icon: () => <EntityTypeChipIcon type="location" /> },
  { key: 'items',         label: 'Items',         icon: () => <EntityTypeChipIcon type="item" /> },
  { key: 'factions',      label: 'Factions',      icon: () => <EntityTypeChipIcon type="faction" /> },
  { key: 'customs',       label: 'Customs',       icon: () => <EntityTypeChipIcon type="custom" /> },
  { key: 'knowledges',    label: 'Knowledge',     icon: () => <KnowledgeChipIcon /> },
  { key: 'relationships', label: 'Relationships', icon: () => <RelationshipIcon size={14} /> },
  { key: 'tags',          label: 'Tags',          icon: () => <TagChipIcon /> },
  { key: 'cues',          label: 'Context Cues',  icon: () => <ContextCueChipIcon /> },
  { key: 'references',    label: 'References',    icon: () => <ReferenceChipIcon /> },
  { key: 'attributes',    label: 'Attributes',    icon: () => <AttributesChipIcon /> },
  { key: 'circumstances', label: 'Circumstances', icon: () => <CircumstanceTypeBadge size={14} title="Circumstances" /> },
  { key: 'motivators',    label: 'Motivators',    icon: () => <MotivatorTypeBadge size={14} title="Motivators" /> },
  { key: 'perspectives',  label: 'Perspectives',  icon: () => <PerspectiveTypeBadge size={14} title="Perspectives" /> },
  { key: 'scenes',        label: 'Scenes',        icon: () => <SceneChipIcon /> },
  { key: 'chapters',      label: 'Chapters',      icon: () => <ChapterChipIcon /> },
  { key: 'acts',          label: 'Acts',          icon: () => <ActChipIcon /> },
]
const ALL_SCOPES_ON = SCOPE_CHIPS.reduce((acc, c) => { acc[c.key] = true; return acc }, {})

// Reference-stable empty array used as the fallback when the engine
// short-circuits and returns no `tagGroups`. Using a module-level
// constant keeps the `flatResults` useMemo from invalidating on every
// render.
const EMPTY_ARRAY = []

/**
 * Phase 1.24d — Global Search modal (Pillar 2 of Phase 1.24).
 *
 * Centred modal, ~60% viewport width capped at 720px, that
 * eventually searches all writer-authored text across the project:
 * entities, scenes, relationships, knowledges, attributes, aliases,
 * transitions, chapters, acts, etc. Three discovery affordances open
 * it: Ctrl+F (Cmd+F on macOS), a hamburger-menu Find entry, and a
 * top-bar quick-find button. All three flip the same `globalSearchOpen`
 * uiStore flag.
 *
 * This commit is the SHELL only. The search engine, scope coverage,
 * result rendering, keyboard navigation, and result navigation all
 * land in subsequent commits per the per-pillar ToDo. Today the modal
 * shows the search input, an empty-state hint, and the close
 * affordances (Esc, click-outside, ✕). Typing in the input is
 * accepted but produces no results panel yet.
 *
 * Rendered via portal directly into `document.body` so it sits above
 * the canvas and the sidebars regardless of where in the tree it
 * mounts.
 */
export default function GlobalSearchModal() {
  const open = useUiStore((s) => s.globalSearchOpen)
  const closeGlobalSearch = useUiStore((s) => s.closeGlobalSearch)
  const inputRef = useRef(null)

  const [query, setQuery] = useState('')
  const [scopes, setScopes] = useState(ALL_SCOPES_ON)

  // Subscribe to the live project + entities stores so the engine
  // sees fresh data on every keystroke (no debounce in V1).
  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const projectStory = useProjectStore((s) => s.story)
  const projectRelationships = useProjectStore((s) => s.relationships)
  const projectKnowledges = useProjectStore((s) => s.knowledges)
  const entitiesCharacters = useEntitiesStore((s) => s.characters)
  const entitiesLocations = useEntitiesStore((s) => s.locations)
  const entitiesItems = useEntitiesStore((s) => s.items)
  const entitiesFactions = useEntitiesStore((s) => s.factions)
  const entitiesCustoms = useEntitiesStore((s) => s.customs)
  // Knowledge records are loaded into `projectStore.knowledges`, not
  // `entitiesStore.knowledges` (which mirrors `story.entities.knowledges`,
  // typically empty — knowledges sit alongside entities in the story
  // schema, not inside `entities`). Source from projectStore so search
  // actually sees them.
  const entitiesKnowledges = useProjectStore((s) => s.knowledges)
  // Phase 3.4e — preset lists + reference nodes (Project Tag hosts
  // with baseline-only tags). Reference nodes live on
  // `projectStore.nodes`; preset lists on entitiesStore.
  const entitiesPresetLists = useEntitiesStore((s) => s.presetLists)
  // Phase 3.4e — Program Tag hosts: Context Cues (full list) +
  // Conversations (lightweight index). The pool is the colour
  // resolution source for the tag-group TagBadge header.
  const contextCues = useContextCuesStore((s) => s.cues)
  const conversationsIndex = useConversationsStore((s) => s.index)
  const programTagPool = useProgramTagsStore((s) => s.pool)

  // Phase 3.7N perf — module-cached project-level tag-host index.
  // Passed into the tag channel so per-tag host lookup is O(1)
  // instead of a full canvas walk per matched tag. Same shared cache
  // the TagPopover reads.
  const { membershipIndex: tagMembershipIndex } = useTagHostIndex()

  // Run the search engine. Memoised on the inputs that affect the
  // result set so each keystroke re-runs once and chip toggles
  // re-run once.
  const searchOutput = useMemo(() => {
    if (!open) return { groups: [], tagGroups: [], totalCount: 0, tagOnlyMode: false }
    return runGlobalSearch(
      query,
      scopes,
      { nodes: projectNodes, edges: projectEdges, story: projectStory, relationships: projectRelationships, knowledges: projectKnowledges },
      {
        characters: entitiesCharacters,
        locations: entitiesLocations,
        items: entitiesItems,
        factions: entitiesFactions,
        customs: entitiesCustoms,
        knowledges: entitiesKnowledges,
        presetLists: entitiesPresetLists,
      },
      {
        cues: contextCues,
        conversations: conversationsIndex,
        programTagPool,
        membershipIndex: tagMembershipIndex,
      },
    )
  }, [
    open, query, scopes,
    projectNodes, projectEdges, projectStory, projectRelationships, projectKnowledges,
    entitiesCharacters, entitiesLocations, entitiesItems, entitiesFactions, entitiesCustoms, entitiesKnowledges,
    entitiesPresetLists, contextCues, conversationsIndex, programTagPool, tagMembershipIndex,
  ])

  // Resolves ids to entity / node objects for badge rendering. The
  // result row shows
  //
  //   [EntityAvatar (origin baseline)]  Name  ·  [field pill]  [NodeBadge for chain anchor]
  //
  // EntityAvatar reads from the entity baseline at the entity's
  // origin — that's the correct anchor for "what does this entity
  // look like when referenced in a non-chain context like search."
  // The match itself is independently anchored on the result row
  // via `result.anchorNodeId` and the engine emitted one row per
  // explicit chain entry.
  const resolveLabels = useMemo(() => {
    // Knowledge records don't carry `type: 'knowledge'` natively
    // (consumers synthesize it on demand — same pattern as
    // useAlerts.js / AlertsPanel.jsx). Inject it here so EntityAvatar
    // resolves `TYPE_ICONS['knowledge']` (📜) instead of falling
    // through to the `?` placeholder when no profile image is set.
    const allEntities = [
      ...(entitiesCharacters || []), ...(entitiesLocations || []),
      ...(entitiesItems || []),      ...(entitiesFactions || []),
      ...(entitiesCustoms || []),
      ...(entitiesKnowledges || []).map((k) => (k.type ? k : { ...k, type: 'knowledge' })),
    ]
    const entityById = new Map(allEntities.map((e) => [e.id, e]))
    const nodeById = new Map((projectNodes || []).map((n) => [n.id, n]))
    const relById = new Map((projectRelationships || []).map((r) => [r.id, r]))
    const chapterById = new Map((projectStory?.chapters || []).map((c) => [c.id, c]))
    const actById = new Map((projectStory?.acts || []).map((a) => [a.id, a]))
    return {
      entity: (id) => entityById.get(id) || null,
      entityName: (id) => entityById.get(id)?.name || '(unknown)',
      entityMap: entityById,
      nodes: projectNodes || [],
      sceneTitle: (sceneId) => {
        const n = nodeById.get(sceneId)
        return n?.data?.title || 'Untitled Scene'
      },
      chapter: (id) => chapterById.get(id) || null,
      act: (id) => actById.get(id) || null,
      relationship: (id) => relById.get(id) || null,
      // Fallback display name for relationships with no user-set
      // `name`: derive from the participants who have ever joined
      // (the same shape `NodeBadge` uses for relationshipOriginNode).
      relationshipName: (id) => {
        const rel = relById.get(id)
        if (!rel) return '(unknown relationship)'
        if (rel.name) return rel.name
        const joinIds = Array.from(new Set(
          (rel.history?.participant_changes || [])
            .filter((c) => c.action === 'join')
            .map((c) => c.entity_id)
        ))
        return participantsFallbackLabel(
          joinIds.map((eid) => ({ entity_id: eid })),
          (eid) => entityById.get(eid),
          3,
          rel,
        ) || 'Relationship'
      },
    }
  }, [entitiesCharacters, entitiesLocations, entitiesItems, entitiesFactions, entitiesCustoms, entitiesKnowledges, projectNodes, projectRelationships, projectStory])

  // When the writer clicks AWAY from the input (without closing the
  // modal — chip toggles, scrolling the results, etc.), the next
  // click back into the input clears the field. Lets them start a
  // fresh query without an explicit clear button.
  const clearOnNextFocus = useRef(false)

  // Reset query + chip state every time the modal opens (planning §3.7).
  useEffect(() => {
    if (open) {
      setQuery('')
      setScopes(ALL_SCOPES_ON)
      clearOnNextFocus.current = false
    }
  }, [open])

  // Autofocus the search input the moment the modal opens.
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [open])

  function toggleScope(key) {
    setScopes((s) => ({ ...s, [key]: !s[key] }))
  }
  // Are every chip on right now? Drives the all-toggle's label / icon
  // and the action it dispatches.
  const allOn = SCOPE_CHIPS.every((c) => !!scopes[c.key])
  function toggleAllScopes() {
    if (allOn) {
      // Disable all → fastest way to scope to a single chip is to
      // turn everything off and click just the one(s) wanted.
      setScopes({})
    } else {
      setScopes(ALL_SCOPES_ON)
    }
  }
  function handleInputBlur() {
    clearOnNextFocus.current = true
  }
  function handleInputFocus() {
    if (clearOnNextFocus.current) {
      setQuery('')
      clearOnNextFocus.current = false
    }
  }

  const totalCount = searchOutput.totalCount
  const groups = searchOutput.groups
  // Reference-stable empty fallback so `tagGroups` doesn't trigger a
  // fresh useMemo dep on every render when the engine didn't produce
  // any. The engine always returns the same array reference within a
  // memoised search invocation, so this only matters for the
  // `searchOutput` default in the early-out branch.
  const tagGroups = searchOutput.tagGroups || EMPTY_ARRAY
  const tagOnlyMode = !!searchOutput.tagOnlyMode
  const hasQuery = query.trim().length > 0

  // Flatten visible results across groups in render order so
  // Up / Down / Enter can index a single 1D selection. Memoised on
  // the search output so it only rebuilds when the result set changes.
  // Tag groups render AFTER text-search groups (their visual section
  // sits beneath the existing result list), so flat-index assignments
  // match the visual order.
  const flatResults = useMemo(() => {
    const flat = []
    for (const g of groups) {
      for (const r of g.results) flat.push({ groupKey: g.groupKey, result: r })
    }
    for (const tg of tagGroups) {
      for (const r of tg.results) flat.push({ groupKey: `tag:${tg.tagName}`, result: r })
    }
    return flat
  }, [groups, tagGroups])

  // Selection index into `flatResults`. Resets to 0 whenever the
  // result set changes so the writer always lands on the first hit.
  // Stays at 0 even when the result set is empty — out-of-bounds
  // is harmless (the visual highlight is gated on hasResult below).
  const [selectedIndex, setSelectedIndex] = useState(0)
  useEffect(() => { setSelectedIndex(0) }, [flatResults])

  // Esc closes; Up / Down moves selection (with wrap); Enter
  // navigates to the current selection (placeholder until the
  // navigation dispatcher lands in the next iteration). Capture
  // phase keeps the canvas-level Esc handler from firing while the
  // modal is open.
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeGlobalSearch()
      return
    }
    const len = flatResults.length
    if (e.key === 'ArrowDown') {
      if (len === 0) return
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((i) => (i + 1) % len)
    } else if (e.key === 'ArrowUp') {
      if (len === 0) return
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((i) => (i - 1 + len) % len)
    } else if (e.key === 'Home') {
      if (len === 0) return
      e.preventDefault()
      setSelectedIndex(0)
    } else if (e.key === 'End') {
      if (len === 0) return
      e.preventDefault()
      setSelectedIndex(len - 1)
    } else if (e.key === 'Enter') {
      if (len === 0) return
      e.preventDefault()
      const sel = flatResults[Math.max(0, Math.min(selectedIndex, len - 1))]
      if (sel) {
        navigateToSearchResult(sel.result)
        closeGlobalSearch()
      }
    }
  }

  // Click-to-navigate — same dispatcher as Enter. Wired through
  // SearchResultGroup → SearchResultRow as `onActivate` so the row
  // has both selection-on-click (existing `onSelect`) and
  // navigate-on-click in one event.
  function activateResult(result) {
    navigateToSearchResult(result)
    closeGlobalSearch()
  }

  if (!open) return null

  return createPortal(
    <div
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the modal body
        // shouldn't bubble to this handler.
        if (e.target === e.currentTarget) closeGlobalSearch()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        zIndex: 1000,
      }}
    >
      <div
        onKeyDown={handleKeyDown}
        data-help-region="global-search:modal"
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl flex flex-col text-zinc-200"
        style={{
          width: 'min(60vw, 720px)',
          maxHeight: '70vh',
          overflow: 'hidden',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
      >
        <div data-help-region="global-search:input" className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-700">
          <span className="text-zinc-500" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="4" />
              <path d="M9 9 L12 12" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={handleInputBlur}
            onFocus={handleInputFocus}
            placeholder="Search…"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[18px] text-zinc-100 placeholder:text-zinc-500"
          />
          <button
            type="button"
            onClick={closeGlobalSearch}
            title="Close (Esc)"
            aria-label="Close global search"
            data-help-region="global-search:close"
            className="text-zinc-500 hover:text-zinc-200 leading-none px-1"
          >
            ×
          </button>
        </div>

        {/* Type-filter chip row. Each chip is icon-only (the writer
            toggles inclusion of that scope by clicking the icon).
            Hover for the chip's label. All chips on by default; chip
            state is local to this open session and resets on close.
            Rightmost button toggles all chips on / off. */}
        <div data-help-region="global-search:filters" className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-700">
          {/* Chips occupy the full width between the left edge and
              the divider, centred horizontally as a group. */}
          <div className="flex-1 flex flex-wrap items-center justify-center gap-1.5">
            {SCOPE_CHIPS.map((chip) => {
              const on = !!scopes[chip.key]
              return (
                <button
                  key={chip.key}
                  type="button"
                  data-help-region="global-search:scope_chip"
                  onClick={() => toggleScope(chip.key)}
                  className={`inline-flex items-center justify-center w-7 h-7 rounded border transition-colors ${
                    on
                      ? 'bg-accent-700/30 border-accent-700/40 text-accent-200 hover:bg-accent-700/50'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 opacity-60'
                  }`}
                  aria-pressed={on}
                  aria-label={`${on ? 'Hide' : 'Show'} ${chip.label}`}
                  title={`${on ? 'Hide' : 'Show'} ${chip.label}`}
                >
                  {chip.icon()}
                </button>
              )
            })}
          </div>
          <span className="inline-block w-px h-4 bg-zinc-700 mx-0.5" aria-hidden />
          <button
            type="button"
            onClick={toggleAllScopes}
            data-help-region="global-search:filter_all_toggle"
            className={`inline-flex items-center justify-center w-7 h-7 rounded border transition-colors text-[9px] font-bold ${
              allOn
                ? 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
                : 'bg-accent-700/30 border-accent-700/40 text-accent-200 hover:bg-accent-700/50'
            }`}
            aria-label={allOn ? 'Disable all filters' : 'Enable all filters'}
            title={allOn ? 'Disable all filters' : 'Enable all filters'}
          >
            {allOn ? 'NONE' : 'ALL'}
          </button>
        </div>

        {/* Result-count summary. Hidden when the input is blank;
            renders "{N} results" when there's a query, switches to
            "No matches" when totalCount is zero. Engine hookup lands
            in a subsequent commit; today totalCount is hard-zero so
            a non-empty query reads "No matches". */}
        {hasQuery && (
          <div className="px-3 py-1.5 border-b border-zinc-700 text-[10px] text-zinc-500">
            {totalCount === 0 ? 'No matches' : `${totalCount} result${totalCount === 1 ? '' : 's'}`}
          </div>
        )}

        <div data-help-region="global-search:results" className="flex-1 overflow-y-auto px-3 py-2 text-[12px] text-zinc-300">
          {!hasQuery && (
            <div className="px-1 py-2 text-zinc-500">
              Start typing to search across entities, scenes, relationships, knowledges, and more.
            </div>
          )}
          {hasQuery && groups.length === 0 && tagGroups.length === 0 && (
            <div className="px-1 py-2 text-zinc-500 italic">
              {tagOnlyMode
                ? 'No objects carry a tag matching this name.'
                : 'No matches.'}
            </div>
          )}
          {hasQuery && (() => {
            // Compute the starting flat index for each group so the
            // child rows know which 1D index they map to (drives the
            // selection highlight + Enter-to-navigate). Text-search
            // groups render first, then tag groups beneath them, so
            // cursor advances through the text groups before the tag
            // groups consume their indices.
            let cursor = 0
            const textGroupNodes = groups.map((group) => {
              const startIndex = cursor
              cursor += group.results.length
              return (
                <SearchResultGroup
                  key={group.groupKey}
                  group={group}
                  resolver={resolveLabels}
                  startIndex={startIndex}
                  selectedIndex={selectedIndex}
                  onSelect={setSelectedIndex}
                  onActivate={activateResult}
                />
              )
            })
            const tagGroupNodes = tagGroups.map((tg) => {
              const startIndex = cursor
              cursor += tg.results.length
              return (
                <TagResultGroup
                  key={`tag:${tg.tagName.toLowerCase()}`}
                  group={tg}
                  startIndex={startIndex}
                  selectedIndex={selectedIndex}
                  onSelect={setSelectedIndex}
                  onActivate={activateResult}
                />
              )
            })
            return (
              <>
                {textGroupNodes}
                {tagGroupNodes}
              </>
            )
          })()}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ────────────────────────────────────────────────────────────────────────
// Group + row rendering
//
// Layout per row:
//
//   [EntityAvatar]  Name  [field-type pill]  [NodeBadge for chain anchor]
//   …before<mark>match</mark>after…  +N more
//
// EntityAvatar / scene glyph reads the object's identity at its
// origin — that's the correct anchor for "what does this thing look
// like in a non-chain context like search." The result row is itself
// anchored at `result.anchorNodeId` via NodeBadge so the writer sees
// where on the chain the matching change entry actually lives.
// Chain-anchor badge is omitted when `result.anchorNodeId` is null
// (non-chain objects: scenes, chapters, acts, transitions).
// ────────────────────────────────────────────────────────────────────────

function FieldPill({ children }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0 rounded text-[9px] uppercase tracking-wide font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700 whitespace-nowrap"
    >
      {children}
    </span>
  )
}

// Scene identity glyph — the same purple "S" pill used in the chip
// row and on the canvas scene NodeBadge. Acts as the avatar slot for
// scene-kind results where there's no entity to render.
function SceneAvatar() {
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm leading-none select-none align-middle font-bold flex-shrink-0"
      style={{
        width: 18, height: 18, fontSize: 11,
        backgroundColor: 'rgba(88, 28, 135, 0.45)',
        color: '#c084fc',
      }}
    >
      S
    </span>
  )
}

// Per-group leading icon — reuses the chip-row icons so a group
// header reads as the same visual family as its filter chip. Each
// entry returns a JSX element rendered at chip-icon size.
const GROUP_ICONS = {
  characters:    () => <EntityTypeChipIcon type="character" />,
  locations:     () => <EntityTypeChipIcon type="location"  />,
  items:         () => <EntityTypeChipIcon type="item"      />,
  factions:      () => <EntityTypeChipIcon type="faction"   />,
  customs:       () => <EntityTypeChipIcon type="custom"    />,
  attributes:    () => <AttributesChipIcon />,
  scenes:        () => <SceneChipIcon />,
  chapters:      () => <ChapterChipIcon />,
  acts:          () => <ActChipIcon />,
  relationships: () => <RelationshipIcon size={14} />,
  knowledges:    () => <KnowledgeIcon size={14} />,
  circumstances: () => <CircumstanceTypeBadge size={14} />,
  motivators:    () => <MotivatorTypeBadge size={14} />,
  perspectives:  () => <PerspectiveTypeBadge size={14} />,
  cues:          () => <CueIcon size={14} />,
  references:    () => <ReferenceChipIcon />,
}

function SearchResultGroup({ group, resolver, startIndex = 0, selectedIndex = -1, onSelect, onActivate }) {
  const label = GROUP_LABELS[group.groupKey] || group.groupKey
  const Icon = GROUP_ICONS[group.groupKey]
  return (
    <div className="mb-2">
      {/* Group separator bar — full-width zinc-tinted strip with the
          icon-and-label pill on top of it. Gives each group a clear
          visual break from the rows above without losing the chip-
          family icon treatment. The negative -mx-3 pulls the bar to
          the modal-body edges (the parent has px-3 padding); the
          inner padding restores text alignment with the rows. */}
      <div className="flex items-center gap-1.5 -mx-3 px-3 py-1 bg-zinc-800/50 border-y border-zinc-700/60">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold bg-zinc-900/70 text-zinc-300 border border-zinc-700"
        >
          {Icon ? <Icon /> : null}
          <span>{label}</span>
        </span>
        <span className="text-[10px] text-zinc-500">({group.results.length}{group.overflow > 0 ? `+${group.overflow}` : ''})</span>
      </div>
      <div className="flex flex-col">
        {group.results.map((r, i) => {
          const flatIndex = startIndex + i
          return (
            <SearchResultRow
              key={`${r.kind}:${r.id}:${r.fieldLabel}:${i}`}
              result={r}
              resolver={resolver}
              isSelected={flatIndex === selectedIndex}
              onSelect={onSelect ? () => onSelect(flatIndex) : undefined}
              onActivate={onActivate ? () => onActivate(r) : undefined}
            />
          )
        })}
        {group.overflow > 0 && (
          <div className="text-[10px] text-zinc-500 italic px-1 py-1">+{group.overflow} more (cap reached)</div>
        )}
      </div>
    </div>
  )
}

// Phase 3.4e — tag-keyed result group. One per matched tag NAME;
// header is the TagBadge for that tag (so the writer sees exactly
// which tag's hosts are listed). Rows underneath are simple
// host-identity rows (icon + display name) using the `taggedHost`
// kind. Keyboard navigation participates in the same flat-index
// sequence as the text-search groups (parent assigns startIndex).
function TagResultGroup({ group, startIndex = 0, selectedIndex = -1, onSelect, onActivate }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 -mx-3 px-3 py-1 bg-zinc-800/50 border-y border-zinc-700/60">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-zinc-400">
          Tagged
        </span>
        <TagBadge name={group.tagName} color={group.tagColor} size="sm" />
        <span className="text-[10px] text-zinc-500">
          ({group.results.length}{group.overflow > 0 ? `+${group.overflow}` : ''})
        </span>
      </div>
      <div className="flex flex-col">
        {group.results.map((r, i) => {
          const flatIndex = startIndex + i
          return (
            <TaggedHostRow
              key={`tag:${group.tagName.toLowerCase()}:${r.hostKind}:${r.id}:${i}`}
              result={r}
              isSelected={flatIndex === selectedIndex}
              onSelect={onSelect ? () => onSelect(flatIndex) : undefined}
              onActivate={onActivate ? () => onActivate(r) : undefined}
            />
          )
        })}
        {group.overflow > 0 && (
          <div className="text-[10px] text-zinc-500 italic px-1 py-1">+{group.overflow} more (cap reached)</div>
        )}
      </div>
    </div>
  )
}

// Phase 3.4e — single host row inside a tag group. Minimal:
// `[host-kind icon]  Display Name  [kind label]`. No snippet (the
// match is the whole tag, surfaced via the group header). Click /
// Enter dispatches to `activateResult` → `navigateToSearchResult`
// which branches on `result.hostKind` to the right detail surface.
const TAGGED_HOST_KIND_LABEL = {
  character: 'Character',
  location: 'Location',
  item: 'Item',
  faction: 'Faction',
  custom: 'Custom',
  knowledge: 'Knowledge',
  relationship: 'Relationship',
  presetList: 'Preset list',
  referenceNode: 'Reference',
  cue: 'Context cue',
  conversation: 'Conversation',
}

const TAGGED_HOST_KIND_ICON = {
  character: TYPE_ICONS.character,
  location: TYPE_ICONS.location,
  item: TYPE_ICONS.item,
  faction: TYPE_ICONS.faction,
  custom: TYPE_ICONS.custom,
  // Non-entity kinds: small emoji fallbacks. Replace with proper
  // identity badges in 3.4i if we extend the picker UX surfaces.
  knowledge: '📜',
  relationship: '🔗',
  presetList: '📋',
  referenceNode: '📌',
  cue: '🧩',
  conversation: '💬',
}

function TaggedHostRow({ result, isSelected, onSelect, onActivate }) {
  const icon = TAGGED_HOST_KIND_ICON[result.hostKind] || '•'
  const kindLabel = TAGGED_HOST_KIND_LABEL[result.hostKind] || result.hostKind
  return (
    <button
      type="button"
      onMouseEnter={onSelect}
      onClick={onActivate}
      className={`w-full text-left flex items-center gap-2 px-1.5 py-1 border-l-2 transition-colors ${
        isSelected
          ? 'bg-accent-900/20 border-accent-500 text-accent-100'
          : 'border-transparent hover:bg-zinc-800/40 text-zinc-200'
      }`}
    >
      <span className="text-[14px] leading-none flex-shrink-0" aria-hidden>{icon}</span>
      <span className="truncate flex-1 min-w-0 text-[13px]">{result.displayName}</span>
      <span className="text-[10px] text-zinc-500 flex-shrink-0">{kindLabel}</span>
    </button>
  )
}

function SearchResultRow({ result, resolver, isSelected = false, onSelect, onActivate }) {
  const isEntityKind = result.kind === 'entity' || result.kind === 'attribute' || result.kind === 'knowledge'
  const isRelationshipKind = result.kind === 'relationship'
  const isCircumstanceKind = result.kind === 'circumstance'
  const isMotivatorKind = result.kind === 'motivator'
  const isCMKind = isCircumstanceKind || isMotivatorKind
  const isTransitionKind = result.kind === 'transition'
  const isChapterKind = result.kind === 'chapter'
  const isActKind = result.kind === 'act'
  // Reference / generic-group / POV-origin nodes share the
  // canvas-NodeBadge identity treatment (same family as scene rows).
  const isCanvasNodeKind = result.kind === 'referenceNote' || result.kind === 'groupNode' || result.kind === 'povOriginNode'
  // Avatar logic: c/m rows render the avatar of whatever the c/m is
  // attached to — the entity (entity-attribute c/m or entity-temp
  // c/m) or the scene (scene-side circumstances). The c/m subchip
  // itself carries its own type badge + intensity badge.
  const cmHostEntity = isCMKind && result.entityId ? resolver.entity(result.entityId) : null
  const showEntityAvatar = isEntityKind || (isCMKind && !!cmHostEntity)
  // Scene-host c/m rows — use the scene NodeBadge as the leading
  // identity (canvas-consistent), not the chip-row "S" filter glyph.
  // Reference / generic-group / POV-origin rows also use NodeBadge
  // as the leading identity (the badge resolver handles each type).
  const showSceneNodeBadge = result.kind === 'scene' || isTransitionKind || (isCMKind && !cmHostEntity && result.sceneId) || isCanvasNodeKind
  const entity = isEntityKind ? resolver.entity(result.entityId || result.id) : cmHostEntity
  // Object name above the snippet — only used when the leading
  // identity is an avatar (entity or relationship); scene / transition
  // rows render their identity via NodeBadge directly so the title
  // doesn't double-render.
  const objectLabel = isEntityKind
    ? (entity?.name || '(unknown)')
    : isRelationshipKind ? resolver.relationshipName(result.id)
    : isCMKind && cmHostEntity ? (cmHostEntity.name || '(unknown)')
    : isChapterKind ? (resolver.chapter(result.id)?.title || '(untitled chapter)')
    : isActKind ? (resolver.act(result.id)?.title || '(untitled act)')
    : null
  const { before, match, after, additionalCount } = result.snippet || {}
  // Anchor NodeBadge to render after the field/subchip slot. Scene-
  // identity rows already render the scene's NodeBadge as the leading
  // identity, so suppress the trailing one to avoid duplicate badges.
  const trailingAnchorId = showSceneNodeBadge ? null : result.anchorNodeId
  // Auto-scroll the keyboard-selected row into view so Up / Down
  // navigation past the visible viewport doesn't strand the focus
  // off-screen.
  const rowRef = useRef(null)
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [isSelected])
  return (
    <div
      ref={rowRef}
      data-help-region="global-search:result_row"
      onMouseEnter={onSelect}
      onClick={() => { if (onSelect) onSelect(); if (onActivate) onActivate() }}
      className={`px-2 py-1 rounded cursor-pointer ${isSelected ? 'bg-accent-700/30 ring-1 ring-accent-600/50' : 'hover:bg-zinc-800'}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] min-w-0">
        {showEntityAvatar ? (
          entity ? <EntityAvatar entity={entity} size={18} /> : null
        ) : isRelationshipKind ? (
          <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: 18, height: 18 }}>
            <RelationshipIcon size={16} />
          </span>
        ) : isChapterKind || isActKind ? (
          <span
            className="inline-block flex-shrink-0 rounded-sm"
            style={{
              width: 18, height: 18,
              backgroundColor: result.colour || (isChapterKind ? '#52525b' : '#3f3f46'),
              border: '1px solid #52525b',
            }}
            title={isChapterKind ? 'Chapter' : 'Act'}
          />
        ) : result.kind === 'referenceNote' ? (
          // Reference avatar — same shape as `EntityAvatar`'s no-image
          // fallback (18px rounded square, coloured border, tinted
          // background, glyph centered) so reference rows read as the
          // same visual family as entity / knowledge rows. Colour
          // comes from the reference node's own `data.colour` (defaults
          // to the reference family sky-blue if unset).
          (() => {
            const refNode = resolver.nodes.find((n) => n.id === result.id)
            const refColour = refNode?.data?.colour || '#40afd0'
            // Phase 8.1 , a concept result reads as a Concept (◇ glyph) rather
            // than a reference note (📌); colour already comes from the node.
            const isConcept = refNode?.data?.sub_type === 'concept'
            return (
              <span
                className="inline-flex items-center justify-center rounded-sm flex-shrink-0 align-middle"
                style={{
                  width: 18, height: 18,
                  border: `1.5px solid ${refColour}`,
                  backgroundColor: `${refColour}22`,
                  fontSize: 11,
                  lineHeight: 1,
                }}
                aria-hidden
                title={isConcept ? 'Concept' : 'Reference note'}
              >
                {isConcept ? '\u{25C7}' : '\u{1F4CC}'}
              </span>
            )
          })()
        ) : null}
        {/* Scene-identity rows render the actual scene NodeBadge as
            the leading identity (matches canvas / detail-panel reads).
            Transitions show source → target as a NodeBadge pair. */}
        {(result.kind === 'scene' || isCanvasNodeKind) && (
          <NodeBadge nodeId={result.id} nodes={resolver.nodes} entityMap={resolver.entityMap} />
        )}
        {isCMKind && !cmHostEntity && result.sceneId && (
          <NodeBadge nodeId={result.sceneId} nodes={resolver.nodes} entityMap={resolver.entityMap} />
        )}
        {isTransitionKind && (
          <span className="inline-flex items-center gap-1 min-w-0">
            <NodeBadge nodeId={result.sourceNodeId} nodes={resolver.nodes} entityMap={resolver.entityMap} />
            <span className="text-zinc-500">→</span>
            <NodeBadge nodeId={result.targetNodeId} nodes={resolver.nodes} entityMap={resolver.entityMap} />
          </span>
        )}
        {objectLabel != null && (
          <span className="text-zinc-100 font-medium truncate min-w-0">{objectLabel}</span>
        )}
        {/* Subchip slot — reuses the canvas / detail-panel subchip
            primitives so search rows read as the same visual family:
              - Circumstance / motivator rows use the canonical
                CircumstanceMotivatorSubChip (✚ / ✱ glyph + intensity
                badge + circumstance / motivator type badge + name).
              - Other attribute add / modify rows use BaseChangeChip
                + ActionGlyphBadge + name (same shape the entity chip
                uses for "[+] Sporty" / "[*] Sporty").
              - Everything else falls through to a generic field pill.
            The matched text with highlight lives in the snippet row
            below regardless. */}
        {isCMKind ? (
          <CircumstanceMotivatorSubChip
            attributeType={isCircumstanceKind ? 'circumstance' : 'motivator'}
            name={result.attributeName}
            description={result.description}
            intensity={result.intensity}
            action={result.action}
            newValue={result.newValue}
            newIntensity={result.newIntensity}
            temporary={!!result.isTemporary}
          />
        ) : result.kind === 'attribute' && (result.action === 'add' || result.action === 'modify') ? (
          <BaseChangeChip action={result.action} showSymbol={false}>
            <ActionGlyphBadge action={result.action} />
            <span className="text-zinc-300">{result.attributeName}</span>
          </BaseChangeChip>
        ) : (
          <FieldPill>{result.fieldLabel}</FieldPill>
        )}
        {trailingAnchorId && (
          <NodeBadge
            nodeId={trailingAnchorId}
            nodes={resolver.nodes}
            entityMap={resolver.entityMap}
          />
        )}
      </div>
      <div className="text-[11px] text-zinc-400 mt-0.5 truncate">
        <span>{before}</span>
        <mark className="bg-accent-700/40 text-accent-100 rounded-sm px-0.5">{match}</mark>
        <span>{after}</span>
        {additionalCount > 0 && (
          <span className="ml-2 text-[10px] text-zinc-500 italic">+{additionalCount} more</span>
        )}
      </div>
    </div>
  )
}
