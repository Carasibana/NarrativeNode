import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../store/uiStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { computeStoryOrder } from '../../utils/storyOrder'
import { storyLayoutArgs } from '../../utils/rowLayout'
import { computePovChain } from '../../utils/povSequence'
import { useAccentColor } from '../../utils/povConstants'
import { getChapterIdForNode } from '../../utils/chapterMembership'
import { getFiredEggs, subscribeFiredEggs } from '../../effects/quarterlyForecasts'
import { getChatPayloads, subscribeChatPayloads, clearChatPayloads } from '../../utils/chatDebugLog'
import {
  RelationshipIcon,
  RelationshipLabelChip,
  RELATIONSHIP_ARROW_PATHS,
  EntityAvatar,
  EntityAvatarName,
  RelationshipBirthBadge,
  ParticipantsFallbackLabel,
  NodeBadge,
  EventBadge,
  PovStartGlyph,
  KnowledgeIcon,
  KnowledgeLabelChip,
  KNOWLEDGE_COLOUR,
  EntityLabelChip,
  CueIcon,
  CueLabelChip,
  ConversationIcon,
  ConversationLabelChip,
} from './IdentityBadges'
import KnowledgePickerPopover from '../entities/KnowledgePickerPopover'
import {
  buildUpstreamConnectMessage,
  buildDuplicateRelMessage,
  buildDeleteRelationshipMessage,
  buildEndRelationshipMessage,
  buildLeaveRelationshipMessage,
  buildRemoveLastParticipantMessage,
  buildUnsavedChangesMessage,
} from './popupMessages'
import {
  SCALE_BINARY,
  SCALE_ALIAS,
  AwarenessBadge,
  AwarenessLevelPill,
  AwarenessLevelSelector,
  awarenessLabelsFor,
} from './AwarenessBadges'
import AwarenessPicker from '../entities/AwarenessPicker'
import AwarenessSubChip from './change-subchips/AwarenessSubChip'
import TagBadge from '../tags/TagBadge'
import TagFilterChip from '../tags/TagFilterChip'
import TagFilterBar from '../tags/TagFilterBar'
import ObjectTagsButton from '../tags/ObjectTagsButton'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import ChangeSubChip from './change-subchips/ChangeSubChip'
import RelChangeChip from './change-subchips/RelChangeChip'
import RelationshipSubChip from './change-subchips/RelationshipSubChip'
import RelationshipChangeChip from './change-subchips/RelationshipChangeChip'
import RelationshipHistoryChangeChip from './change-subchips/RelationshipHistoryChangeChip'
import { FallbackSubChip } from './change-subchips/atoms'
// Phase 1.22 — Circumstance / Motivator preview imports.
import { IntensityBadge, INTENSITY_LABELS, INTENSITY_COLOURS } from './IntensityBadge'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from './TypeBadges'
import CircumstanceMotivatorSubChip from './change-subchips/CircumstanceMotivatorSubChip'
// Phase 1.23 — Date / Time Tracking primitives.
import GranularityCarousel from './GranularityCarousel'
import TimeOfDayCarousel, {
  formatExact,
  CELL_VISUALS,
  CellGlyph,
  TIME_OF_DAY_LABELS,
} from './TimeOfDayCarousel'
import { SeasonRow, DateCarousel, SeasonGlyph, SeasonGlyphMahjong, SEASON_ACCENTS, WetRaindrops, DrySunCracks } from './DayCarousels'
import { formatGap, sceneBucket } from '../../utils/scenetimeVerbiage'
import SceneDurationCarousel, { timeOfDayLabelToBucket, PERIOD_BUCKETS } from './SceneDurationCarousel'
import {
  getActiveCalendar,
  weekdayName,
  seasonName,
  monthName,
} from '../../utils/calendarConventions'
import ProjectCard from '../library/ProjectCard'

/**
 * Hidden developer preview panel — opened only via Ctrl+` from anywhere in
 * the app. Renders a mostly-empty zinc surface with a close button in the
 * top-right and a swappable content area. Not exposed in any menu; not
 * intended for end-user use.
 *
 * Current preview content: a catalogue of every badge / identity component
 * exported from `ui/IdentityBadges.jsx`, rendered with representative fake
 * data so visual consistency can be checked side-by-side.
 *
 * ── Extending this panel (IMPORTANT CONVENTION) ────────────────────────────
 *
 * Future additions MUST be non-destructive: do NOT replace `BadgeCatalogue`
 * when adding a new preview. Instead, add new pages/tabs and navigate
 * between them. Treat this panel as a multi-page surface whose content
 * grows over time. Existing previews are reference material for ongoing
 * visual-consistency work — removing them mid-project strands the other
 * consumers.
 *
 * Suggested evolution path when the second preview is added:
 *   1. Introduce a simple tab bar or page selector below the header.
 *   2. Keep `BadgeCatalogue` as one page.
 *   3. Add the new preview as a sibling page.
 *   4. Page state can live in local `useState` (panel re-opens to page 0
 *      each time) or in `uiStore` if persistence matters.
 *
 * Do not put end-user-facing controls here. This panel is dev-only; any
 * action that would meaningfully mutate project state belongs in a real
 * UI surface, not here.
 */
const PAGES = [
  { id: 'badges', label: 'Badges', Component: BadgeCatalogue },
  { id: 'awareness', label: 'Awareness', Component: AwarenessCataloguePage },
  { id: 'subChips', label: 'Sub-chips', Component: SubChipsPage },
  { id: 'popups', label: 'Popups', Component: PopupCatalogue },
  { id: 'storyOrder', label: 'Story Order', Component: StoryOrderPage },
  { id: 'portSemantics', label: 'Port Semantics', Component: PortSemanticsPreview },
  { id: 'phase1_22', label: 'C&M Mockups', Component: Phase1_22MockupsPage },
  { id: 'phase1_23', label: 'Time', Component: Phase1_23TimePage },
  { id: 'chatPayloads', label: 'Chat Payloads', Component: ChatPayloadsPage },
  { id: 'uiIdeation', label: 'UI Ideation', Component: UiDesignIdeationPage },
  { id: 'library', label: 'Library', Component: LibraryCardPage },
  // Keep "Nest" LAST — it must always remain the right-most tab.
  { id: 'nest', label: 'Nest', Component: NestPage },
]

// Phase 1.22j — Dev Settings tab id. Rendered separately from PAGES
// so it can carry its own visual treatment (narrow, gear icon,
// accent-coloured background) and sit at the leftmost slot of the
// tabs bar, immediately right of the "Dev Preview" header label.
const DEV_SETTINGS_PAGE_ID = 'devSettings'

export default function DevPreviewPanel() {
  const open = useUiStore((s) => s.devPreviewOpen)
  const close = useUiStore((s) => s.closeDevPreview)
  const [activePageId, setActivePageId] = useState(PAGES[0].id)
  if (!open) return null

  // Phase 1.22j — DEV_SETTINGS_PAGE_ID is special-cased; the rest of
  // the activePageId universe is the PAGES list.
  const ActivePage = activePageId === DEV_SETTINGS_PAGE_ID
    ? DevSettingsPage
    : (PAGES.find((p) => p.id === activePageId) || PAGES[0]).Component

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center p-8 bg-black/60"
      onClick={close}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-2xl w-full max-w-7xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-700 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-400 uppercase tracking-wider">Dev Panel</span>
            <div className="flex items-center gap-1">
              {/* Phase 1.22j — Dev Settings tab. Special-cased so it
                  carries its own visual treatment (narrow, gear icon,
                  accent-coloured background) and sits at the leftmost
                  slot of the tabs bar, immediately right of the
                  "Dev Preview" header label. */}
              <button
                key={DEV_SETTINGS_PAGE_ID}
                onClick={() => setActivePageId(DEV_SETTINGS_PAGE_ID)}
                title="Dev Settings"
                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${
                  activePageId === DEV_SETTINGS_PAGE_ID
                    ? 'bg-accent-600 text-white'
                    : 'bg-accent-700/80 text-white hover:bg-accent-600'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              {PAGES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActivePageId(p.id)}
                  className={`text-xs px-2 py-0.5 rounded transition-colors ${
                    activePageId === p.id
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={close}
            className="text-zinc-500 hover:text-zinc-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800"
            title="Close (Ctrl + `)"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <ActivePage />
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Badge Catalogue (first preview content) ────────────────────────────────

const MOCK_ENTITIES = [
  { id: 'mock-alice',  name: 'Alice', type: 'character', colour: '#ec4899', aliases: [{ value: 'Ali' }] },
  { id: 'mock-bob',    name: 'Bob',   type: 'character', colour: '#60a5fa', aliases: [] },
  { id: 'mock-tavern', name: 'The Prancing Pony', type: 'location', colour: '#eab308', aliases: [] },
  { id: 'mock-ring',   name: 'One Ring', type: 'item', colour: '#f97316', aliases: [] },
  { id: 'mock-shire',  name: 'The Shire Council', type: 'faction', colour: '#10b981', aliases: [] },
  { id: 'mock-key',    name: 'Council Key', type: 'custom', colour: '#a855f7', aliases: [] },
  { id: 'mock-secret', name: 'The Secret', type: 'knowledge', colour: '#f59e0b', aliases: [] },
]

const MOCK_ENTITY_MAP = new Map(MOCK_ENTITIES.map((e) => [e.id, e]))

const MOCK_REL = {
  id: 'mock-rel',
  name: null,
  history: {
    participant_changes: [
      { node_id: 'mock-origin', action: 'join', entity_id: 'mock-alice', initial_perception: '', initial_alias_override: 'Ali' },
      { node_id: 'mock-origin', action: 'join', entity_id: 'mock-bob',   initial_perception: '', initial_alias_override: null },
    ],
    alias_changes: [],
  },
}

const MOCK_NODES = [
  { id: 'mock-scene',     type: 'sceneNode',        data: { title: 'The Meeting' } },
  { id: 'mock-flashback', type: 'sceneNode',        data: { title: 'Years Before', is_flashback: true } },
  { id: 'mock-origin-char', type: 'entityNode',         data: { entity_id: 'mock-alice' } },
  { id: 'mock-origin-loc',  type: 'entityNode',         data: { entity_id: 'mock-tavern' } },
  { id: 'mock-origin-item', type: 'entityNode',         data: { entity_id: 'mock-ring' } },
  { id: 'mock-origin-faction', type: 'entityNode',      data: { entity_id: 'mock-shire' } },
  { id: 'mock-origin-custom',  type: 'entityNode',      data: { entity_id: 'mock-key' } },
  { id: 'mock-origin-knowledge', type: 'entityNode',    data: { entity_id: 'mock-secret' } },
  { id: 'mock-mod-char',  type: 'entityNode',           data: { entity_id: 'mock-alice', is_modifier: true, name_change: 'Older Alice' } },
  { id: 'mock-rel-origin', type: 'relationshipOriginNode', data: { relationship_id: 'mock-rel' } },
  { id: 'mock-pov-origin', type: 'povOriginNode',       data: {} },
  { id: 'mock-reference',  type: 'referenceNode',       data: { title: 'Character Notes' } },
  { id: 'mock-group',      type: 'genericGroupNode',    data: { title: 'Act 1 Group' } },
  { id: 'mock-unknown',    type: 'futureUnknownNode',   data: {} },
]

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3 border-b border-zinc-800 pb-1">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex items-start gap-3">
      <div className="text-[10px] text-zinc-600 w-40 flex-shrink-0 pt-1">{label}</div>
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  )
}

// Phase 3.4e — local-state demo wrapper for `ProjectTagPicker`. The
// picker's add/remove callbacks emit project-tag ids; we hold those
// ids in component-local state so the writer can attach / detach /
// create + see the chip strip update without affecting any real
// host. The find-or-create POST hits the real backend pool, so newly-
// minted Project Tags do persist to disk — that's the point of the
// demo, but means clearing the box doesn't roll back any pool entry
// the writer just created.
function ProjectTagPickerDemo() {
  const [tagIds, setTagIds] = useState([])
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded p-3 space-y-2 max-w-md">
      <ProjectTagPicker
        currentTagIds={tagIds}
        onAdd={(id) => setTagIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
        onRemove={(id) => setTagIds((prev) => prev.filter((t) => t !== id))}
        placeholder="Type a tag name…"
      />
      <div className="text-[10px] text-zinc-500 font-mono">
        currentTagIds: {tagIds.length === 0 ? '[]' : JSON.stringify(tagIds)}
      </div>
    </div>
  )
}

// ── TagBadge fill-mockup helpers (Phase 3.4i prep) ──────────────────────
//
// Permanent design-exploration record — kept in the Dev Panel as a
// reference for the decision to switch TagBadge from the "stained
// glass" 18%-alpha fill to the dark zinc-900/80 fill (winner picked
// in v0.3.4.N during Phase 3.4i). Inline-only helpers so the
// comparison renders without touching the real TagBadge component
// going forward.

function _devHexToRgba(hex, alpha = 1) {
  if (typeof hex !== 'string') return `rgba(136, 136, 136, ${alpha})`
  const clean = hex.replace('#', '').trim()
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (full.length !== 6) return `rgba(136, 136, 136, ${alpha})`
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return `rgba(136, 136, 136, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Inline mockup chip — matches TagBadge's `sm` size + bracket framing
// + uppercase casing but takes its style from a per-variant prop so
// we can A/B fill treatments without modifying TagBadge.
function _MockupChip({ name, style }) {
  return (
    <span
      className="inline-flex items-center rounded border text-[10px] px-1.5 py-0.5 gap-0.5 transition-colors"
      style={style}
    >
      <span className="font-mono leading-none flex-shrink-0">[#</span>
      <span className="truncate max-w-[14rem] uppercase tracking-wide">{name}</span>
      <span className="font-mono leading-none flex-shrink-0">]</span>
    </span>
  )
}

// Single row showing one fill-treatment variant: four sample colours
// standalone + each wrapped in emerald (AND), amber (OR), red (NOT)
// state wraps (mimicking the TagFilterChip composition).
const _MOCKUP_COLOURS = [
  { label: 'purple', hex: '#7c3aed' },
  { label: 'pink',   hex: '#ec4899' },
  { label: 'amber',  hex: '#f59e0b' },
  { label: 'blue',   hex: '#3b82f6' },
]
const _WRAP_STATES = [
  { label: 'AND', glyph: '+', wrapCls: 'bg-emerald-900/40 border border-emerald-700/60 text-emerald-200' },
  { label: 'OR',  glyph: '|', wrapCls: 'bg-amber-900/40 border border-amber-700/60 text-amber-200' },
  { label: 'NOT', glyph: '−', wrapCls: 'bg-red-900/40 border border-red-700/60 text-red-200' },
]

function TagBadgeMockupRow({ variantLabel, fillStyle }) {
  return (
    <div className="mb-4 border-l-2 border-zinc-700 pl-3">
      <div className="text-[11px] text-zinc-300 font-semibold mb-2">{variantLabel}</div>
      <div className="text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">standalone</div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {_MOCKUP_COLOURS.map((c) => (
          <_MockupChip key={c.label} name={c.label} color={c.hex} style={fillStyle(c.hex)} />
        ))}
      </div>
      {_WRAP_STATES.map((s) => (
        <div key={s.label} className="mb-1">
          <div className="text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">wrapped — {s.label}</div>
          <div className="flex flex-wrap items-center gap-2">
            {_MOCKUP_COLOURS.map((c) => (
              <span
                key={c.label}
                className={`inline-flex items-center gap-1 px-1 py-px rounded select-none ${s.wrapCls}`}
              >
                <span className="font-mono leading-none flex-shrink-0 text-[11px]">{s.glyph}</span>
                <_MockupChip name={c.label} color={c.hex} style={fillStyle(c.hex)} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── ObjectTagsButton interactive preview wrapper (Phase 3.4i) ───────────
//
// Builds synthetic host fixtures keyed by the real project tag pool so
// the writer can interact-test hover-preview + click-to-pin without
// needing real entity / knowledge / relationship data. Each fixture
// renders inside a faux library row so the button shows in context
// (matches the row-hover fade-in pattern from the real library tabs).
function ObjectTagsButtonPreviewRow({ label, host, hostKind, pool, tagNames, hostHeader }) {
  return (
    <div className="group/item flex items-center justify-between gap-2 px-2 py-1 border border-zinc-800 rounded hover:bg-zinc-800/30 transition-colors">
      <span className="text-[11px] text-zinc-300">{label}</span>
      <div className="flex items-center gap-1">
        <ObjectTagsButton
          pool={pool}
          host={host}
          hostKind={hostKind}
          tagNames={tagNames}
          hostHeader={hostHeader}
        />
        {/* Fake delete affordance for visual reference — proves the new
            tag button sits cleanly alongside the existing per-row
            action button cluster. */}
        <button
          type="button"
          className="w-5 h-5 inline-flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-zinc-700 text-[11px]"
          title="(fake) Delete"
        >×</button>
      </div>
    </div>
  )
}

// Dev Panel previews use the REAL identity chips so the popover
// header composition matches what real surfaces will render. Each
// kind has its own chip component in `ui/IdentityBadges.jsx`:
//   - Entity      → EntityLabelChip
//   - Knowledge   → KnowledgeLabelChip
//   - Relationship → RelationshipLabelChip
//   - Cue          → CueLabelChip
//   - Conversation → ConversationLabelChip

// ── TagFilterBar interactive preview wrapper (Phase 3.4i) ───────────────
//
// Holds filter state in local React state so the Dev Panel preview is
// fully interactive without persisting anywhere. Subscribes to the
// project's real tag pool inside TagFilterBar itself.
function TagFilterBarPreviewWrapper({ pool }) {
  const [filterState, setFilterState] = useState({ and: [], or: [], not: [] })
  return (
    <div className="flex flex-col gap-1">
      <TagFilterBar
        pool={pool}
        filterState={filterState}
        onFilterStateChange={setFilterState}
      />
      <div className="text-[9px] text-zinc-600 font-mono break-all">
        filterState: {JSON.stringify(filterState)}
      </div>
    </div>
  )
}

function BadgeCatalogue() {
  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">IdentityBadges catalogue</h2>
      <p className="text-xs text-zinc-500 mb-6">Every exported component from <code className="text-zinc-400">ui/IdentityBadges.jsx</code>, rendered with representative mock data for visual consistency review.</p>

      <Section title="TagBadge (Phase 3.4e)">
        <Row label="default (md)">
          <TagBadge name="magic" color="#7c3aed" />
        </Row>
        <Row label="sizes — xs / sm / md">
          <TagBadge name="lore" color="#ec4899" size="xs" />
          <TagBadge name="lore" color="#ec4899" size="sm" />
          <TagBadge name="lore" color="#ec4899" size="md" />
        </Row>
        <Row label="with library count suffix (N)">
          <TagBadge name="banished" color="#ef4444" count={3} />
          <TagBadge name="protagonist" color="#10b981" count={1} />
          <TagBadge name="unused" color="#888888" count={0} />
        </Row>
        <Row label="chain-origin variant (dashed border; tooltip on hover)">
          <TagBadge name="cursed" color="#f59e0b" chainAdded />
          <TagBadge name="cursed" color="#f59e0b" chainAdded size="sm" />
        </Row>
        <Row label="clickable (interactive)">
          <TagBadge name="click me" color="#60a5fa" onClick={() => console.log('tag clicked')} />
        </Row>
        <Row label="with detach × button">
          <TagBadge name="removable" color="#a855f7" onRemove={() => console.log('detach')} />
        </Row>
        <Row label="long name truncation">
          <TagBadge name="this name is intentionally very long to force truncation" color="#06b6d4" />
        </Row>
        <Row label="mixed-casing input (rendered uppercase via CSS)">
          <TagBadge name="MiXeD CaSiNg" color="#84cc16" />
        </Row>
      </Section>

      <Section title="TagFilterChip (Phase 3.4i)">
        <Row label="popover mode — all 4 states (null / AND / OR / NOT)">
          <TagFilterChip
            tag={{ id: 'demo-1', name: 'magic', color: '#7c3aed' }}
            state="null"
            mode="popover"
            onCycle={(s) => console.log('cycle popover null →', s)}
          />
          <TagFilterChip
            tag={{ id: 'demo-2', name: 'magic', color: '#7c3aed' }}
            state="and"
            mode="popover"
            onCycle={(s) => console.log('cycle popover and →', s)}
          />
          <TagFilterChip
            tag={{ id: 'demo-3', name: 'magic', color: '#7c3aed' }}
            state="or"
            mode="popover"
            onCycle={(s) => console.log('cycle popover or →', s)}
          />
          <TagFilterChip
            tag={{ id: 'demo-4', name: 'magic', color: '#7c3aed' }}
            state="not"
            mode="popover"
            onCycle={(s) => console.log('cycle popover not →', s)}
          />
        </Row>
        <Row label="active-row mode — 3-state cycle (no null; × removes)">
          <TagFilterChip
            tag={{ id: 'demo-5', name: 'lore', color: '#ec4899' }}
            state="and"
            mode="active-row"
            onCycle={(s) => console.log('cycle active-row and →', s)}
            onRemove={() => console.log('remove from active-row')}
          />
          <TagFilterChip
            tag={{ id: 'demo-6', name: 'lore', color: '#ec4899' }}
            state="or"
            mode="active-row"
            onCycle={(s) => console.log('cycle active-row or →', s)}
            onRemove={() => console.log('remove from active-row')}
          />
          <TagFilterChip
            tag={{ id: 'demo-7', name: 'lore', color: '#ec4899' }}
            state="not"
            mode="active-row"
            onCycle={(s) => console.log('cycle active-row not →', s)}
            onRemove={() => console.log('remove from active-row')}
          />
        </Row>
        <Row label="with usage count suffix">
          <TagFilterChip
            tag={{ id: 'demo-8', name: 'popular', color: '#10b981', count: 12 }}
            state="and"
            mode="popover"
            onCycle={(s) => console.log('cycle with count →', s)}
          />
          <TagFilterChip
            tag={{ id: 'demo-9', name: 'rare', color: '#888888', count: 1 }}
            state="or"
            mode="popover"
            onCycle={(s) => console.log('cycle with count →', s)}
          />
        </Row>
        <Row label="multiple colours across states">
          <TagFilterChip
            tag={{ id: 'demo-10', name: 'emerald', color: '#10b981' }}
            state="and"
            mode="popover"
            onCycle={() => {}}
          />
          <TagFilterChip
            tag={{ id: 'demo-11', name: 'amber', color: '#f59e0b' }}
            state="or"
            mode="popover"
            onCycle={() => {}}
          />
          <TagFilterChip
            tag={{ id: 'demo-12', name: 'crimson', color: '#dc2626' }}
            state="not"
            mode="popover"
            onCycle={() => {}}
          />
          <TagFilterChip
            tag={{ id: 'demo-13', name: 'azure', color: '#3b82f6' }}
            state="null"
            mode="popover"
            onCycle={() => {}}
          />
        </Row>
      </Section>

      <Section title="TagBadge — fill mockups for filter-chip composability (NOT WIRED)">
        <p className="text-[10px] text-zinc-500 mb-2 italic">
          The real `TagBadge` is unchanged. These are inline mockups
          comparing fill treatments so we can see which one reads
          cleanest both standalone AND wrapped in a filter-state
          colour (emerald AND / amber OR / red NOT). Each row shows
          four sample colours (purple, pink, amber, blue) so we can
          spot per-colour clashes against each state wrap.
        </p>
        <TagBadgeMockupRow
          variantLabel="Original (pre-3.4i) — 18% alpha tag fill (stained glass)"
          fillStyle={(hex) => ({ backgroundColor: _devHexToRgba(hex, 0.18), borderColor: _devHexToRgba(hex, 0.55), color: _devHexToRgba(hex, 1) })}
        />
        <TagBadgeMockupRow
          variantLabel="Neutral fill — zinc-800/60 + tag border + tag text"
          fillStyle={(hex) => ({ backgroundColor: 'rgba(39, 39, 42, 0.6)', borderColor: _devHexToRgba(hex, 0.55), color: _devHexToRgba(hex, 1) })}
        />
        <TagBadgeMockupRow
          variantLabel="Transparent fill — outline only + tag border + tag text"
          fillStyle={(hex) => ({ backgroundColor: 'transparent', borderColor: _devHexToRgba(hex, 0.65), color: _devHexToRgba(hex, 1) })}
        />
        <TagBadgeMockupRow
          variantLabel="★ Dark fill — zinc-900/80 + brighter tag border + text — CURRENT (winner picked Phase 3.4i)"
          fillStyle={(hex) => ({ backgroundColor: 'rgba(24, 24, 27, 0.8)', borderColor: _devHexToRgba(hex, 0.75), color: _devHexToRgba(hex, 1) })}
        />
      </Section>

      <Section title="RelationshipIcon">
        <Row label="size 10">
          <RelationshipIcon size={10} />
        </Row>
        <Row label="size 12 (default)">
          <RelationshipIcon size={12} />
        </Row>
        <Row label="size 16">
          <RelationshipIcon size={16} />
        </Row>
      </Section>

      <Section title="RelationshipLabelChip">
        <Row label="named rel">
          <RelationshipLabelChip name="The Fellowship" />
        </Row>
        <Row label="clickable">
          <RelationshipLabelChip name="Click me" onClick={() => console.log('rel clicked')} />
        </Row>
        <Row label="with JSX children (aliases)">
          <RelationshipLabelChip name="Alice as Ali & Bob">
            <ParticipantsFallbackLabel
              participants={[{ entity_id: 'mock-alice' }, { entity_id: 'mock-bob' }]}
              getEntity={(id) => MOCK_ENTITY_MAP.get(id)}
              rel={MOCK_REL}
            />
          </RelationshipLabelChip>
        </Row>
      </Section>

      <Section title="CueIcon">
        <Row label="size 10">
          <CueIcon size={10} />
        </Row>
        <Row label="size 12 (default)">
          <CueIcon size={12} />
        </Row>
        <Row label="size 16">
          <CueIcon size={16} />
        </Row>
      </Section>

      <Section title="CueLabelChip">
        <Row label="non-clickable">
          <CueLabelChip name="Tavern Rules of Engagement" />
        </Row>
        <Row label="clickable">
          <CueLabelChip name="Click me" onClick={() => console.log('cue clicked')} />
        </Row>
        <Row label="long label truncates">
          <div style={{ maxWidth: 220 }}>
            <CueLabelChip name="A very long Context Cue name that should truncate cleanly inside the chip's max-width container" />
          </div>
        </Row>
      </Section>

      <Section title="ConversationIcon">
        <Row label="size 10">
          <ConversationIcon size={10} />
        </Row>
        <Row label="size 12 (default)">
          <ConversationIcon size={12} />
        </Row>
        <Row label="size 16">
          <ConversationIcon size={16} />
        </Row>
      </Section>

      <Section title="ConversationLabelChip">
        <Row label="non-clickable">
          <ConversationLabelChip name="Plotting Chapter 3" />
        </Row>
        <Row label="clickable">
          <ConversationLabelChip name="Click me" onClick={() => console.log('conv clicked')} />
        </Row>
        <Row label="long label truncates">
          <div style={{ maxWidth: 220 }}>
            <ConversationLabelChip name="A very long conversation thread name that should truncate cleanly inside the chip's max-width container" />
          </div>
        </Row>
      </Section>

      <Section title="EntityAvatar">
        <Row label="no profile image — icon fallback">
          {MOCK_ENTITIES.map((e) => <EntityAvatar key={e.id} entity={e} />)}
        </Row>
        <Row label="size 14">
          {MOCK_ENTITIES.slice(0, 3).map((e) => <EntityAvatar key={e.id} entity={e} size={14} />)}
        </Row>
        <Row label="size 24">
          {MOCK_ENTITIES.slice(0, 3).map((e) => <EntityAvatar key={e.id} entity={e} size={24} />)}
        </Row>
      </Section>

      <Section title="EntityAvatarName">
        <Row label="no alias">
          <EntityAvatarName entity={MOCK_ENTITIES[1]} />
        </Row>
        <Row label="with alias">
          <EntityAvatarName entity={MOCK_ENTITIES[0]} aliasOverride="Ali" />
        </Row>
        <Row label="clickable">
          <EntityAvatarName entity={MOCK_ENTITIES[0]} aliasOverride="Ali" onClick={() => console.log('entity clicked')} />
        </Row>
      </Section>

      <Section title="ParticipantsFallbackLabel">
        <Row label="2 participants, alias">
          <ParticipantsFallbackLabel
            participants={[{ entity_id: 'mock-alice' }, { entity_id: 'mock-bob' }]}
            getEntity={(id) => MOCK_ENTITY_MAP.get(id)}
            rel={MOCK_REL}
          />
        </Row>
        <Row label="3 participants, no rel / no alias">
          <ParticipantsFallbackLabel
            participants={[{ entity_id: 'mock-alice' }, { entity_id: 'mock-bob' }, { entity_id: 'mock-tavern' }]}
            getEntity={(id) => MOCK_ENTITY_MAP.get(id)}
          />
        </Row>
        <Row label="5 participants, sliceMax=3">
          <ParticipantsFallbackLabel
            participants={MOCK_ENTITIES.slice(0, 5).map((e) => ({ entity_id: e.id }))}
            getEntity={(id) => MOCK_ENTITY_MAP.get(id)}
            sliceMax={3}
          />
        </Row>
      </Section>

      <Section title="PovStartGlyph">
        <Row label="standalone">
          <PovStartGlyph />
        </Row>
        <Row label="inline with text">
          <span className="text-xs text-zinc-300">POV status:</span>
          <PovStartGlyph />
          <span className="text-xs text-zinc-500">(no character attached)</span>
        </Row>
      </Section>

      <Section title="RelationshipBirthBadge">
        <Row label="origin variant">
          <RelationshipBirthBadge kind="origin" label="Alice & Bob" />
        </Row>
        <Row label="origin, clickable">
          <RelationshipBirthBadge kind="origin" label="Alice & Bob" onClick={() => console.log('birth clicked')} />
        </Row>
        <Row label="scene variant">
          <RelationshipBirthBadge kind="scene" label="The Meeting" />
        </Row>
      </Section>

      <Section title="NodeBadge — every node type">
        <Row label="scene">
          <NodeBadge nodeId="mock-scene" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="scene (flashback)">
          <NodeBadge nodeId="mock-flashback" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="entity origin (each type)">
          <NodeBadge nodeId="mock-origin-char" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
          <NodeBadge nodeId="mock-origin-loc" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
          <NodeBadge nodeId="mock-origin-item" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
          <NodeBadge nodeId="mock-origin-faction" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
          <NodeBadge nodeId="mock-origin-custom" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
          <NodeBadge nodeId="mock-origin-knowledge" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="entity modifier">
          <NodeBadge nodeId="mock-mod-char" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="relationship origin">
          <NodeBadge nodeId="mock-rel-origin" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="POV origin">
          <NodeBadge nodeId="mock-pov-origin" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="reference">
          <NodeBadge nodeId="mock-reference" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="group">
          <NodeBadge nodeId="mock-group" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="unknown (fallback)">
          <NodeBadge nodeId="mock-unknown" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} />
        </Row>
        <Row label="clickable (scene)">
          <NodeBadge nodeId="mock-scene" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} onClick={(id) => console.log('nav to', id)} />
        </Row>
        <Row label="missing node — fallback text">
          <NodeBadge nodeId="does-not-exist" nodes={MOCK_NODES} entityMap={MOCK_ENTITY_MAP} fallback={<span className="text-zinc-600 italic text-[10px]">(no node)</span>} />
        </Row>
      </Section>

      <Section title="EventBadge — composite change-event badge">
        <Row label="modify (Alice's Title at Scene 2)">
          <EventBadge
            entity={MOCK_ENTITY_MAP.get('mock-alice')}
            nodeId="mock-scene"
            nodes={MOCK_NODES}
            entityMap={MOCK_ENTITY_MAP}
            fieldLabel="Title"
            action="modify"
            oldValue="Knight"
            newValue="Princess"
          />
        </Row>
        <Row label="add (Bob gains an attribute)">
          <EventBadge
            entity={MOCK_ENTITY_MAP.get('mock-bob')}
            nodeId="mock-scene"
            nodes={MOCK_NODES}
            entityMap={MOCK_ENTITY_MAP}
            fieldLabel="Origin"
            action="add"
            oldValue={null}
            newValue="Hobbiton"
          />
        </Row>
        <Row label="remove (an attribute is dropped)">
          <EventBadge
            entity={MOCK_ENTITY_MAP.get('mock-tavern')}
            nodeId="mock-flashback"
            nodes={MOCK_NODES}
            entityMap={MOCK_ENTITY_MAP}
            fieldLabel="Owner"
            action="remove"
            oldValue="Barliman Butterbur"
            newValue={null}
          />
        </Row>
        <Row label="clickable (logs to console)">
          <EventBadge
            entity={MOCK_ENTITY_MAP.get('mock-alice')}
            nodeId="mock-scene"
            nodes={MOCK_NODES}
            entityMap={MOCK_ENTITY_MAP}
            fieldLabel="Name"
            action="modify"
            oldValue="Alice"
            newValue="Aly"
            onClick={() => console.log('event badge clicked')}
          />
        </Row>
      </Section>

      {/* ── Phase 1.22 — IntensityBadge ───────────────────────────────────── */}
      <Section title="IntensityBadge (Phase 1.22)">
        <p className="text-[11px] text-zinc-500 mb-2">
          Pentagon (point-up), 5 wedges. Outline matches the fill colour at each tier (single solid colour
          per tier on cool-to-warm gradient). Wedges fill clockwise from the bottom as the level rises.
          Returns nothing for the unset / null state. Sizes scale uniformly from the same SVG.
        </p>
        <Row label="Detail Panel size (24 px)">
          <span className="inline-flex items-center gap-2">
            {[null, 0, 1, 2, 3, 4].map((lv, i) => (
              <span key={i} className="inline-flex flex-col items-center gap-0.5">
                <IntensityBadge level={lv} size={24} />
                <span className="text-[9px] text-zinc-500">
                  {lv === null ? 'unset' : INTENSITY_LABELS[lv]}
                </span>
              </span>
            ))}
          </span>
        </Row>
        <Row label="Sub-chip size (14 px)">
          <span className="inline-flex items-center gap-2">
            {[null, 0, 1, 2, 3, 4].map((lv, i) => (
              <IntensityBadge key={i} level={lv} size={14} />
            ))}
          </span>
        </Row>
        <Row label="Canvas chip size (10 px)">
          <span className="inline-flex items-center gap-2">
            {[null, 0, 1, 2, 3, 4].map((lv, i) => (
              <IntensityBadge key={i} level={lv} size={10} />
            ))}
          </span>
        </Row>
        <Row label="Tier colours">
          <span className="inline-flex items-center gap-3 text-[10px] font-mono">
            {INTENSITY_LABELS.map((label, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <span style={{ display: 'inline-block', width: 10, height: 10, backgroundColor: INTENSITY_COLOURS[i], borderRadius: 2 }} />
                <span className="text-zinc-400">{label}</span>
                <span className="text-zinc-600">{INTENSITY_COLOURS[i]}</span>
              </span>
            ))}
          </span>
        </Row>
      </Section>

      {/* ── Phase 1.22 — Type badges (Circumstance / Motivator) ─────────── */}
      <Section title="Type badges — Circumstance / Motivator (Phase 1.22)">
        <p className="text-[11px] text-zinc-500 mb-2">
          Pentagon outline (matches IntensityBadge silhouette) with a single character centred inside.
          Slate (#64748b) for circumstance, rust (#a17a6e) for motivator. Both colours are unclaimed
          elsewhere in the program. Sizes scale uniformly.
        </p>
        <Row label="Detail Panel size (24 px)">
          <span className="inline-flex items-center gap-3">
            <CircumstanceTypeBadge size={24} />
            <MotivatorTypeBadge size={24} />
          </span>
        </Row>
        <Row label="Sub-chip size (14 px)">
          <span className="inline-flex items-center gap-3">
            <CircumstanceTypeBadge size={14} />
            <MotivatorTypeBadge size={14} />
          </span>
        </Row>
        <Row label="Canvas chip size (10 px)">
          <span className="inline-flex items-center gap-3">
            <CircumstanceTypeBadge size={10} />
            <MotivatorTypeBadge size={10} />
          </span>
        </Row>
        <Row label="Side-by-side — type + intensity (24 px) at all five intensity tiers">
          <span className="inline-flex flex-col gap-1.5">
            {[0, 1, 2, 3, 4].map((lv) => (
              <span key={lv} className="inline-flex items-center gap-2">
                <CircumstanceTypeBadge size={20} />
                <IntensityBadge level={lv} size={20} />
                <span className="text-[10px] text-zinc-500 ml-2">Circumstance · {INTENSITY_LABELS[lv]}</span>
              </span>
            ))}
            <span className="h-1" />
            {[0, 1, 2, 3, 4].map((lv) => (
              <span key={`m${lv}`} className="inline-flex items-center gap-2">
                <MotivatorTypeBadge size={20} />
                <IntensityBadge level={lv} size={20} />
                <span className="text-[10px] text-zinc-500 ml-2">Motivator · {INTENSITY_LABELS[lv]}</span>
              </span>
            ))}
          </span>
        </Row>
      </Section>
    </div>
  )
}


// ── Popup Catalogue ────────────────────────────────────────────────────────
//
// Second preview page. Renders each of the 10 audited confirm-dialog popups
// populated with mock data, inside a miniature of the ConfirmDialog chrome
// so the preview matches the real-world look. For popups that include an
// entity, shows two variants side-by-side: placeholder (no profile image)
// and real (uses the first entity with a profile_image_ref from the
// currently-loaded project, when one exists).

function MockDialog({ title, message, buttons }) {
  return (
    <div className="bg-zinc-800 border border-zinc-600 rounded-lg shadow w-[420px] overflow-hidden">
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-100 flex-1">{title}</h3>
          <span className="text-zinc-400 text-sm leading-none -mt-0.5">×</span>
        </div>
        {message && (
          <div className="text-xs text-zinc-300 whitespace-pre-line leading-relaxed">
            {message}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-1">
          {buttons.map((b, i) => (
            <span
              key={i}
              className={`px-3 py-1.5 text-xs rounded border ${
                b.style === 'primary'
                  ? 'bg-accent-700 text-white border-accent-600'
                  : b.style === 'danger'
                    ? 'bg-zinc-800 text-accent-400 border-zinc-600 ring-2 ring-inset ring-accent-500'
                    : 'text-zinc-300 border-zinc-600'
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function PopupRow({ label, placeholder, real }) {
  return (
    <div className="mb-8">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{label}</div>
      <div className="flex gap-4 flex-wrap items-start">
        <div>
          <div className="text-[9px] text-zinc-600 mb-1 uppercase tracking-wide">Placeholder</div>
          {placeholder}
        </div>
        {real && (
          <div>
            <div className="text-[9px] text-zinc-600 mb-1 uppercase tracking-wide">Real entity</div>
            {real}
          </div>
        )}
      </div>
    </div>
  )
}

function AwarenessCataloguePage() {
  // Two independent picker states so callers can see both scales rendered
  // side-by-side. `null` = tracking disabled; dict = tracking enabled.
  const [entityAwareness, setEntityAwareness] = useState(null)
  const [aliasAwareness,  setAliasAwareness]  = useState(null)

  // Pick any real entity id from the currently-loaded project for the
  // picker's self-seed. Falls back to null when no entities exist.
  const firstEntityId = useEntitiesStore((s) => {
    for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs', 'knowledges']) {
      const arr = s[bucket] || []
      if (arr.length > 0) return arr[0].id
    }
    return null
  })

  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">AwarenessBadges catalogue</h2>
      <p className="text-xs text-zinc-500 mb-6">Visual vocabulary for the Phase 1.21 awareness layer (sharp square, coloured border + matching glyph). Integer levels are semantic: `0` = explicitly unaware, `3` = fully aware. Levels `1` and `2` are alias-only.</p>

      <Section title="AwarenessBadge (static)">
        <Row label="Level 0 — red ✕">
          <AwarenessBadge level={0} title="Explicitly unaware" />
        </Row>
        <Row label="Level 1 — blue ⯁">
          <AwarenessBadge level={1} title="Knows the name (alias scale only)" />
        </Row>
        <Row label="Level 2 — amber ⁉">
          <AwarenessBadge level={2} title="Knows it’s a pseudonym, but not whose (alias scale only)" />
        </Row>
        <Row label="Level 3 — green ✓">
          <AwarenessBadge level={3} title="Knows the alias and whose it is" />
        </Row>
        <Row label="Size 24 (larger)">
          <AwarenessBadge level={0} size={24} />
          <AwarenessBadge level={1} size={24} />
          <AwarenessBadge level={2} size={24} />
          <AwarenessBadge level={3} size={24} />
        </Row>
      </Section>

      <Section title="AwarenessLevelPill (interactive)">
        <Row label="Active (full opacity)">
          <AwarenessLevelPill level={0} active title="Explicitly unaware" onClick={() => {}} />
          <AwarenessLevelPill level={1} active title="Knows the name"    onClick={() => {}} />
          <AwarenessLevelPill level={2} active title="Knows it’s a pseudonym"     onClick={() => {}} />
          <AwarenessLevelPill level={3} active title="Knows the alias and whose it is" onClick={() => {}} />
        </Row>
        <Row label="Inactive (dimmed to 35%)">
          <AwarenessLevelPill level={0} active={false} title="Explicitly unaware" onClick={() => {}} />
          <AwarenessLevelPill level={1} active={false} title="Knows the name"    onClick={() => {}} />
          <AwarenessLevelPill level={2} active={false} title="Knows it’s a pseudonym"     onClick={() => {}} />
          <AwarenessLevelPill level={3} active={false} title="Knows the alias and whose it is" onClick={() => {}} />
        </Row>
      </Section>

      <Section title="AwarenessLevelSelector (scale controls)">
        <Row label="Binary {0, 3} — value 0">
          <AwarenessLevelSelector scale={SCALE_BINARY} value={0} onChange={() => {}} />
        </Row>
        <Row label="Binary {0, 3} — value 3">
          <AwarenessLevelSelector scale={SCALE_BINARY} value={3} onChange={() => {}} />
        </Row>
        <Row label="Alias {0, 1, 2, 3} — value 0">
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={0} onChange={() => {}} />
        </Row>
        <Row label="Alias {0, 1, 2, 3} — value 1">
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={1} onChange={() => {}} />
        </Row>
        <Row label="Alias {0, 1, 2, 3} — value 2">
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={2} onChange={() => {}} />
        </Row>
        <Row label="Alias {0, 1, 2, 3} — value 3">
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={3} onChange={() => {}} />
        </Row>
      </Section>

      <Section title="awarenessLabelsFor (context-aware tooltips)">
        <p className="text-[10px] text-zinc-500 mb-2">Hover the pills to see the tooltip vary by surface + context. When the surface-specific context fields are missing, the helper falls back to the generic static labels.</p>

        <Row label="Entity, context { parentName: 'Alice' }">
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('entity', { parentName: 'Alice' }) }}
            value={0}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('entity', { parentName: 'Alice' }) }}
            value={3}
            onChange={() => {}}
          />
        </Row>
        <Row label="Entity, no context (fallback)">
          <AwarenessLevelSelector scale={SCALE_BINARY} value={0} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_BINARY} value={3} onChange={() => {}} />
        </Row>

        <Row label="Attribute, context { parentName: 'Alice', attributeName: 'occupation' }">
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('attribute', { parentName: 'Alice', attributeName: 'occupation' }) }}
            value={0}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('attribute', { parentName: 'Alice', attributeName: 'occupation' }) }}
            value={3}
            onChange={() => {}}
          />
        </Row>
        <Row label="Attribute, no context (fallback)">
          <AwarenessLevelSelector scale={SCALE_BINARY} value={0} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_BINARY} value={3} onChange={() => {}} />
        </Row>

        <Row label="Relationship, context { relationshipName: 'The Conspiracy' }">
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('relationship', { relationshipName: 'The Conspiracy' }) }}
            value={0}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_BINARY, labels: awarenessLabelsFor('relationship', { relationshipName: 'The Conspiracy' }) }}
            value={3}
            onChange={() => {}}
          />
        </Row>
        <Row label="Relationship, no context (fallback)">
          <AwarenessLevelSelector scale={SCALE_BINARY} value={0} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_BINARY} value={3} onChange={() => {}} />
        </Row>

        <Row label="Alias, context { parentName: 'Alice', aliasValue: 'Jill' }">
          <AwarenessLevelSelector
            scale={{ ...SCALE_ALIAS, labels: awarenessLabelsFor('alias', { parentName: 'Alice', aliasValue: 'Jill' }) }}
            value={0}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_ALIAS, labels: awarenessLabelsFor('alias', { parentName: 'Alice', aliasValue: 'Jill' }) }}
            value={1}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_ALIAS, labels: awarenessLabelsFor('alias', { parentName: 'Alice', aliasValue: 'Jill' }) }}
            value={2}
            onChange={() => {}}
          />
          <AwarenessLevelSelector
            scale={{ ...SCALE_ALIAS, labels: awarenessLabelsFor('alias', { parentName: 'Alice', aliasValue: 'Jill' }) }}
            value={3}
            onChange={() => {}}
          />
        </Row>
        <Row label="Alias, no context (fallback)">
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={0} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={1} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={2} onChange={() => {}} />
          <AwarenessLevelSelector scale={SCALE_ALIAS} value={3} onChange={() => {}} />
        </Row>
      </Section>

      <Section title="AwarenessPicker — entity surface (binary, context-aware)">
        <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded p-3">
          <AwarenessPicker
            value={entityAwareness}
            onChange={setEntityAwareness}
            surface="entity"
            parentEntityId={firstEntityId}
            context={{ parentName: 'Alice' }}
          />
          <pre className="mt-2 text-[9px] text-zinc-600 whitespace-pre-wrap break-all">
            value = {JSON.stringify(entityAwareness)}
          </pre>
        </div>
      </Section>

      <Section title="AwarenessPicker — alias surface (4-level, context-aware)">
        <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded p-3">
          <AwarenessPicker
            value={aliasAwareness}
            onChange={setAliasAwareness}
            surface="alias"
            parentEntityId={firstEntityId}
            context={{ parentName: 'Alice', aliasValue: 'Jill' }}
          />
          <pre className="mt-2 text-[9px] text-zinc-600 whitespace-pre-wrap break-all">
            value = {JSON.stringify(aliasAwareness)}
          </pre>
        </div>
      </Section>
    </div>
  )
}

function PopupCatalogue() {
  // Find a real entity with a profile image from the currently-loaded project.
  // When one exists, every popup that features an entity renders a second
  // variant using the real entity so placeholder/real can be compared
  // side-by-side. When none exists, only the placeholder variant renders.
  const realEntityWithImage = useEntitiesStore((s) => {
    const all = [
      ...(s.characters || []),
      ...(s.locations || []),
      ...(s.items || []),
      ...(s.factions || []),
      ...(s.customs || []),
      ...(s.knowledges || []),
    ]
    return all.find((e) => e && e.profile_image_ref) || null
  })

  // Placeholder entity (no profile image — forces the type-icon fallback).
  const placeholderAlice = MOCK_ENTITIES[0]  // Alice, character, no profile_image_ref
  const placeholderBob   = MOCK_ENTITIES[1]

  const placeholderRel      = { ...MOCK_REL, name: 'The Conspirators' }
  const unnamedTwoPartyRel  = MOCK_REL  // Alice + Bob, unnamed
  const unnamedFourPartyRel = {
    ...MOCK_REL,
    name: null,
    history: {
      participant_changes: [
        { node_id: 'x', action: 'join', entity_id: 'mock-alice',  initial_perception: '', initial_alias_override: 'Ali' },
        { node_id: 'x', action: 'join', entity_id: 'mock-bob',    initial_perception: '', initial_alias_override: null },
        { node_id: 'x', action: 'join', entity_id: 'mock-tavern', initial_perception: '', initial_alias_override: null },
        { node_id: 'x', action: 'join', entity_id: 'mock-ring',   initial_perception: '', initial_alias_override: null },
      ],
      alias_changes: [],
    },
  }

  const sampleNodes     = MOCK_NODES
  const sampleEntityMap = MOCK_ENTITY_MAP
  const getMockEntity   = (id) => sampleEntityMap.get(id)

  // Build side-by-side placeholder + real variants for any popup that
  // features an entity. `builder(entity)` produces the message node.
  const withEntity = (builder, title, buttons) => ({
    placeholder: <MockDialog title={title} message={builder(placeholderAlice)} buttons={buttons} />,
    real: realEntityWithImage
      ? <MockDialog title={title} message={builder(realEntityWithImage)} buttons={buttons} />
      : null,
  })

  const leaveRel = withEntity(
    (entity) => buildLeaveRelationshipMessage({
      entity,
      aliasOverride: entity === placeholderAlice ? 'Ali' : (entity.aliases?.[0]?.value || null),
      rel: placeholderRel,
      getEntity: getMockEntity,
      leavingAtNodeId: 'mock-scene',
      nodes: sampleNodes,
      entityMap: sampleEntityMap,
    }),
    'Leave relationship',
    [{ label: 'Leave', style: 'danger' }, { label: 'Cancel', style: 'neutral' }],
  )

  const lastParticipant = withEntity(
    (entity) => buildRemoveLastParticipantMessage({
      entity,
      rel: placeholderRel,
      getEntity: getMockEntity,
    }),
    'Remove last participant?',
    [
      { label: 'Remove and delete relationship', style: 'danger' },
      { label: 'Cancel', style: 'neutral' },
    ],
  )

  const upstreamConnect = withEntity(
    (entity) => buildUpstreamConnectMessage({
      entity,
      sourceNodeId: 'mock-origin-char',
      targetNodeId: 'mock-scene',
      nodes: sampleNodes,
      entityMap: sampleEntityMap,
    }),
    'Connect to upstream source',
    [{ label: 'Connect', style: 'primary' }, { label: 'Cancel', style: 'neutral' }],
  )

  const dupRelPlaceholderMessage = buildDuplicateRelMessage({
    participants: [
      { entity: placeholderAlice, aliasOverride: 'Ali' },
      { entity: placeholderBob,   aliasOverride: null },
    ],
    match: {
      kind: 'exact',
      existingLabel: 'The Conspirators',
      existingRel: { ...placeholderRel, name: 'The Conspirators' },
      getEntity: getMockEntity,
      joinEntityIds: ['mock-alice', 'mock-bob'],
      birth: { kind: 'origin', label: 'Origin' },
    },
    hasAliases: true,
  })

  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Popup catalogue</h2>
      <div className="text-xs text-zinc-500 mb-6 flex flex-wrap items-center gap-1">
        Each audited confirm dialog, rendered with mock data inside a miniature of the ConfirmDialog chrome.
        {realEntityWithImage ? (
          <>
            A real entity from the current project&nbsp;
            <EntityAvatarName entity={realEntityWithImage} />
            &nbsp;is used for the &quot;Real entity&quot; column so profile-image rendering can be checked.
          </>
        ) : (
          <>No entity with a profile image found in the current project — only the placeholder variants render.</>
        )}
      </div>

      <PopupRow
        label="Delete relationship (named)"
        placeholder={<MockDialog
          title="Delete relationship"
          message={buildDeleteRelationshipMessage({ rel: placeholderRel, getEntity: getMockEntity })}
          buttons={[{ label: 'Delete', style: 'danger' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="Delete relationship (unnamed — 2 participants, participants-fallback label)"
        placeholder={<MockDialog
          title="Delete relationship"
          message={buildDeleteRelationshipMessage({ rel: unnamedTwoPartyRel, getEntity: getMockEntity })}
          buttons={[{ label: 'Delete', style: 'danger' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="Delete relationship (unnamed — 4 participants, participants-fallback label with slice)"
        placeholder={<MockDialog
          title="Delete relationship"
          message={buildDeleteRelationshipMessage({ rel: unnamedFourPartyRel, getEntity: getMockEntity })}
          buttons={[{ label: 'Delete', style: 'danger' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="End relationship at a scene"
        placeholder={<MockDialog
          title="End relationship"
          message={buildEndRelationshipMessage({
            rel: placeholderRel,
            getEntity: getMockEntity,
            endNodeId: 'mock-scene',
            nodes: sampleNodes,
            entityMap: sampleEntityMap,
          })}
          buttons={[{ label: 'End here', style: 'danger' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="End relationship at a modifier node"
        placeholder={<MockDialog
          title="End relationship"
          message={buildEndRelationshipMessage({
            rel: placeholderRel,
            getEntity: getMockEntity,
            endNodeId: 'mock-mod-char',
            nodes: sampleNodes,
            entityMap: sampleEntityMap,
          })}
          buttons={[{ label: 'End here', style: 'danger' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="Leave relationship (entity + alias at a scene)"
        placeholder={leaveRel.placeholder}
        real={leaveRel.real}
      />

      <PopupRow
        label="Remove last participant (cascade-delete warning)"
        placeholder={lastParticipant.placeholder}
        real={lastParticipant.real}
      />

      <PopupRow
        label="Connect to upstream source (entity carried forward)"
        placeholder={upstreamConnect.placeholder}
        real={upstreamConnect.real}
      />

      <PopupRow
        label="Duplicate relationship guard (exact match + alias tip)"
        placeholder={<MockDialog
          title="Create duplicate relationship?"
          message={dupRelPlaceholderMessage}
          buttons={[{ label: 'Create anyway', style: 'primary' }, { label: 'Cancel', style: 'neutral' }]}
        />}
      />

      <PopupRow
        label="Unsaved changes (Detail Panel switch-away guard)"
        placeholder={<MockDialog
          title="Unsaved changes"
          message={buildUnsavedChangesMessage()}
          buttons={[
            { label: 'Confirm and continue', style: 'primary' },
            { label: 'Discard and continue', style: 'danger'  },
            { label: 'Cancel',               style: 'neutral' },
          ]}
        />}
      />

      <PopupRow
        label="Add knowledge of this change — menu (Phase 1.21k, non-origin trigger)"
        placeholder={<MockAddKnowledgePopover view="menu" isOrigin={false} />}
      />

      <PopupRow
        label="Add knowledge of this change — menu (Phase 1.21k, origin trigger — Path B hidden)"
        placeholder={<MockAddKnowledgePopover view="menu" isOrigin={true} />}
      />

      <PopupRow
        label="Add knowledge of this change — Knowledge picker view (Path B)"
        placeholder={<MockAddKnowledgePopover view="picker" isOrigin={false} />}
      />

      <PopupRow
        label="Duplicate Knowledge name confirmation (Phase 1.21k)"
        placeholder={<MockDialog
          title="Knowledge name already exists"
          message={'Another Knowledge named "Alice\'s Title" already exists. Create a second one with the same name?'}
          buttons={[{ label: 'Cancel', style: 'neutral' }, { label: 'Create anyway', style: 'primary' }]}
        />}
      />

      <PopupRow
        label="Knowledge attached to removed event (Phase 1.21k cascade)"
        placeholder={<MockDialog
          title="Knowledge attached to removed event"
          message={`The Knowledge "Alice's Title" was created by the event you just removed. Choose what to do with it.`}
          buttons={[
            { label: 'Delete', style: 'danger'  },
            { label: 'Detach', style: 'neutral' },
            { label: 'Cancel', style: 'neutral' },
          ]}
        />}
      />
    </div>
  )
}

// ── Mock Add-Knowledge-from-change popover (Phase 1.21k) ───────────────────
//
// Static visual mock of the real <AddKnowledgeFromChangePopover> menu and
// picker views. The real popover is portal-rendered with fixed position
// anchored to the trigger button; here it renders inline so the catalogue
// can compare visuals side-by-side. Mirrors the production class set so
// copy / spacing / colour stays in lockstep.
function MockAddKnowledgePopover({ view, isOrigin }) {
  const mockKnowledges = [
    { id: 'k-1', name: 'The Conspiracy',  colour: '#b89968' },
    { id: 'k-2', name: 'LostHeir',        colour: '#b89968' },
    { id: 'k-3', name: "Alice's Past",    colour: '#b89968' },
  ]
  return (
    <div className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl text-xs min-w-[260px] overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-700 text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
        <KnowledgeIcon size={12} />
        <span style={{ color: KNOWLEDGE_COLOUR }}>Knowledge of this change</span>
      </div>
      {view === 'menu' && (
        <>
          <div className="w-full text-left px-3 py-2 hover:bg-zinc-700 text-zinc-200 transition-colors flex items-center gap-2">
            <span className="text-green-400 font-bold leading-none text-sm">✚</span>
            <span className="flex-1">Make a new Knowledge from this change</span>
          </div>
          {!isOrigin && (
            <div className="w-full text-left px-3 py-2 hover:bg-zinc-700 text-zinc-200 transition-colors flex items-center gap-2 border-t border-zinc-700">
              <KnowledgeIcon size={12} />
              <span className="flex-1">Attach to an existing Knowledge…</span>
            </div>
          )}
        </>
      )}
      {view === 'picker' && (
        <KnowledgePickerPopover
          allKnowledges={mockKnowledges}
          excludeIds={new Set()}
          onPick={() => {}}
          onClose={() => {}}
        />
      )}
    </div>
  )
}

const TIER_COLOURS = {
  0:  '#52525b', // zinc-600 (origin, pre-narrative)
  1:  '#22c55e', // green (POV, known)
  2:  '#3b82f6', // blue (connected chain, known)
  3:  '#a855f7', // purple (orphan segment, partial)
  4:  '#06b6d4', // cyan (POV reachability, inferred)
  5:  '#eab308', // yellow (chapter, inferred)
  6:  '#f97316', // orange (canvas-x, inferred)
  7:  '#fb923c', // light orange (canvas-y tiebreak)
  8:  '#ef4444', // red (node-type tiebreak, degenerate)
  9:  '#dc2626', // deep red (name-presence tiebreak)
  10: '#b91c1c', // darker red (numeric name)
  11: '#991b1b', // crimson (alphabetical)
  12: '#7f1d1d', // maroon (UUID fallback)
}

const TIER_DESCRIPTIONS = {
  0:  'Tier 0 — origin node (axiomatic)',
  1:  'Tier 1 — POV chain (user-declared)',
  2:  'Tier 2 — entity chain anchored to POV (parallel layout)',
  3:  'Tier 3 — orphan segment internal ordering',
  4:  'Tier 4 — POV reachability (POV-reachable before not-POV-reachable)',
  5:  'Tier 5 — chapter membership (inferred; phantom chapter 0 / trailing chapter)',
  6:  'Tier 6 — canvas x-position (inferred)',
  7:  'Tier 7 — canvas y-position (deterministic tiebreak)',
  8:  'Tier 8 — node type (deterministic tiebreak)',
  9:  'Tier 9 — name presence: named before unnamed (tiebreak)',
  10: 'Tier 10 — name numeric order: numeric-aware (tiebreak)',
  11: 'Tier 11 — name alphabetical order (tiebreak)',
  12: 'Tier 12 — UUID order (deterministic fallback)',
}

const TIER_LEGEND = [
  { tier: 0,  name: 'Origin',            description: 'Pre-narrative setup: entity origin, relationship origin, POV origin. Pinned at position 0.',                                                                           authority: 'axiomatic' },
  { tier: 1,  name: 'POV chain',         description: 'Scene sits on the user-declared POV chain. Position = POV index.',                                                                                                       authority: 'known' },
  { tier: 2,  name: 'Entity chain',      description: 'Entity chain laid parallel to POV; nodes bracketed between two POV anchors are placed between them; nodes downstream of the last anchor go after the last POV scene.', authority: 'known' },
  { tier: 3,  name: 'Orphan segment',    description: 'Internal order within an orphan POV segment or orphan entity chain, overlaid to resolve still-ambiguous pairs.',                                                          authority: 'partial' },
  { tier: 4,  name: 'POV reachability',  description: 'A node that can trace an unbroken path back to the POV origin via POV or entity chain edges sorts before a node that cannot.',                                            authority: 'inferred' },
  { tier: 5,  name: 'Chapter',           description: 'Chapter membership decides. Left of chapter 1 = phantom chapter 0; right of last chapter = phantom trailing chapter.',                                                  authority: 'inferred' },
  { tier: 6,  name: 'Canvas x',          description: 'Same chapter; canvas x-position decides. Layout-driven.',                                                                                                                  authority: 'inferred' },
  { tier: 7,  name: 'Canvas y',          description: 'Same x; smaller y sorts earlier. Guards against vertical stacking at equal x.',                                                                                            authority: 'tiebreak' },
  { tier: 8,  name: 'Node type',         description: 'Same x, y; node-type rank decides (scene < modifier < entityOrigin < relationshipOrigin < povOrigin). Rare.',                                                            authority: 'tiebreak' },
  { tier: 9,  name: 'Name presence',     description: 'Same x, y, type; one node has a user-given name, the other doesn\'t. Named sorts first.',                                                                                authority: 'tiebreak' },
  { tier: 10, name: 'Name numeric',      description: 'Both named with parseable numbers. Numeric-aware: Scene 2 before Scene 10.',                                                                                              authority: 'tiebreak' },
  { tier: 11, name: 'Name alphabetical', description: 'Both named without both carrying numbers. Plain locale-compare.',                                                                                                         authority: 'tiebreak' },
  { tier: 12, name: 'UUID',              description: 'Final fallback. Deterministic and stable but carries no semantics.',                                                                                                       authority: 'tiebreak' },
]

function TierBadge({ tier, note }) {
  if (tier == null) return <span className="text-zinc-600">—</span>
  const colour = TIER_COLOURS[tier] || '#71717a'
  const description = TIER_DESCRIPTIONS[tier] || `Tier ${tier}`
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm text-[10px] font-bold w-6 h-5"
      style={{ backgroundColor: colour, color: '#0a0a0a' }}
      title={note ? `${description}\n${note}` : description}
    >
      {tier}
    </span>
  )
}

function formatNodeType(node) {
  if (!node) return '—'
  if (node.type === 'entityNode') {
    const entityType = node.data?.entity_type
    const prefix = node.data?.is_modifier ? 'modifier' : 'origin'
    return entityType ? `entityNode (${prefix}, ${entityType})` : `entityNode (${prefix})`
  }
  if (node.type === 'sceneNode' && node.data?.is_flashback) return 'sceneNode (flashback)'
  return node.type || '—'
}

function StoryOrderPage() {
  const storyOrder = useStoryOrder()
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const chapters = useProjectStore((s) => s.story?.chapters || [])
  const chapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })
  // Phase 4.3 — layout mode + row grouping feed computeStoryOrder's
  // canonicalization; selected here so the tier-snapshot recompute below
  // reads canonical (single-row) positions in multi-row mode too.
  const canvasLayoutMode = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const chapterRows = useProjectStore((s) => s.story?.chapter_rows || null)

  // F#2: tierSnapshots is opt-in on `computeStoryOrder` — the shared
  // `useStoryOrder` cache deliberately skips it (the 13-tier sub-graph
  // builds + reachability + ambiguous-pair scans are ~30-35% of compute
  // cost). This panel's "Decision tree" view is the only consumer, so
  // we run a dedicated `computeStoryOrder` pass here with the flag set
  // and memoize against the same input refs the hook uses. Cost only
  // paid while this page is mounted.
  const tierSnapshots = useMemo(() => {
    const povChain = computePovChain(nodes, edges)
    const r = computeStoryOrder({ nodes, edges, povChain, chapters, chapterXOffset, includeTierSnapshots: true, ...storyLayoutArgs({ canvas_layout_mode: canvasLayoutMode, chapter_rows: chapterRows, chapter_x_offset: chapterXOffset }) })
    return r.tierSnapshots
  }, [nodes, edges, chapters, chapterXOffset])

  const characters = useEntitiesStore((s) => s.characters || [])
  const locations = useEntitiesStore((s) => s.locations || [])
  const items = useEntitiesStore((s) => s.items || [])
  const factions = useEntitiesStore((s) => s.factions || [])
  const customs = useEntitiesStore((s) => s.customs || [])
  const knowledges = useProjectStore((s) => s.knowledges || [])

  // Build a flat entityId -> name map by walking every bucket.
  const entityNameById = new Map()
  for (const bucket of [characters, locations, items, factions, customs, knowledges]) {
    for (const e of (bucket || [])) {
      if (e?.id && e?.name) entityNameById.set(e.id, e.name)
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const chapterLabelById = new Map(chapters.map((c, i) => [c.id, c.name || `Chapter ${i + 1}`]))

  // Build nodeDisplayNameById: resolves a node id to a user-facing name.
  const nodeDisplayNameById = new Map()
  let sceneFallbackIdx = 0
  for (const n of nodes) {
    const d = n.data || {}
    if (n.type === 'sceneNode') {
      sceneFallbackIdx += 1
      const t = (d.title && String(d.title).trim()) || ''
      nodeDisplayNameById.set(n.id, t || `Scene ${sceneFallbackIdx}`)
    } else if (n.type === 'entityNode') {
      const resolved = (d.entity_id && entityNameById.get(d.entity_id)) || d.name || `entity ${String(d.entity_id || n.id).slice(0, 6)}`
      nodeDisplayNameById.set(n.id, d.is_modifier ? `${resolved} (modifier)` : `${resolved} origin`)
    } else if (n.type === 'povOriginNode') {
      nodeDisplayNameById.set(n.id, 'POV origin')
    } else if (n.type === 'relationshipOriginNode') {
      nodeDisplayNameById.set(n.id, `Relationship origin (${String(n.id).slice(0, 6)})`)
    } else {
      nodeDisplayNameById.set(n.id, d.title || d.name || `(${String(n.id).slice(0, 6)})`)
    }
  }

  const chapterNameById = new Map()
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    if (c?.id) chapterNameById.set(c.id, c.name || `Chapter ${i + 1}`)
  }

  const nameMaps = { entityNameById, nodeDisplayNameById, chapterNameById }

  const rows = storyOrder.orderedIds.map((id, idx) => {
    const node = nodeById.get(id) || null
    const chapterId = node ? getChapterLabel(node, chapters, chapterXOffset, chapterLabelById) : null
    const structuredReason = storyOrder.reasonById?.get(id) || null
    return {
      idx,
      id,
      node,
      tier: storyOrder.tierById.get(id),
      reasonText: formatReason(structuredReason, nameMaps),
      chapterLabel: chapterId,
    }
  })

  const tierCounts = new Map()
  for (const t of storyOrder.tierById.values()) {
    tierCounts.set(t, (tierCounts.get(t) || 0) + 1)
  }
  const tierSummary = Array.from(tierCounts.entries()).sort((a, b) => a[0] - b[0])

  const orphanEntries = Array.from(storyOrder.orphanSegmentsByEntityId.entries())

  const isEmpty = rows.length === 0

  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Story Order</h2>
      <p className="text-xs text-zinc-500 mb-2">
        Live global ordering from <code className="text-zinc-400">useStoryOrder()</code>. Every chain-participating node in lexicographic tier priority (0-11). Excluded node types (<code className="text-zinc-400">genericGroupNode</code>, <code className="text-zinc-400">referenceNode</code>) do not appear.
      </p>
      <p className="text-xs text-zinc-600 mb-4 italic">
        The <span className="text-zinc-400">Decided</span> column shows which tier's signal actually placed the node globally. A node can carry constraints from lower tiers (e.g. an entity chain at tier 2) without those constraints being the decisive placement signal — if the chain doesn't fully bracket the node against POV, the global position falls through to tier 4 or 5. Read the <span className="text-zinc-400">Reason</span> column for the concrete signal.
      </p>

      <details className="mb-4 text-xs" open>
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200 mb-2 select-none">Tier legend (13 tiers)</summary>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-zinc-800/50 text-zinc-400 text-[10px] uppercase tracking-wide">
              <tr>
                <th className="px-2 py-1.5 text-center w-12">Tier</th>
                <th className="px-2 py-1.5 text-left w-36">Name</th>
                <th className="px-2 py-1.5 text-left">Description</th>
                <th className="px-2 py-1.5 text-left w-32">Authority</th>
              </tr>
            </thead>
            <tbody>
              {TIER_LEGEND.map((row) => (
                <tr key={row.tier} className="border-t border-zinc-800">
                  <td className="px-2 py-1 text-center"><TierBadge tier={row.tier} /></td>
                  <td className="px-2 py-1 text-zinc-200">{row.name}</td>
                  <td className="px-2 py-1 text-zinc-400">{row.description}</td>
                  <td className="px-2 py-1 text-zinc-500 italic">{row.authority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {isEmpty ? (
        <div className="text-xs text-zinc-500 border border-zinc-800 rounded px-4 py-8 text-center">
          No project loaded, or the current project has no chain-participating nodes.
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-3 items-center">
            <div className="text-xs text-zinc-400">
              Total: <span className="text-zinc-200 font-semibold">{rows.length}</span> nodes
            </div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wide mr-1">Decided at:</div>
            {tierSummary.map(([tier, count]) => (
              <div key={tier} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <TierBadge tier={tier} />
                <span className="text-zinc-500">×</span>
                <span className="text-zinc-200">{count}</span>
              </div>
            ))}
          </div>

          {orphanEntries.length > 0 && (
            <div className="mb-4 p-2 border border-zinc-800 rounded text-xs">
              <div className="text-zinc-400 mb-1">Orphan segments detected:</div>
              {orphanEntries.map(([entityId, segs]) => (
                <div key={entityId} className="text-zinc-500">
                  <span className="text-zinc-400">{entityId}</span>: {segs.length} segment{segs.length === 1 ? '' : 's'} ({segs.map((s) => `${s.nodeIds.length} node${s.nodeIds.length === 1 ? '' : 's'}`).join(', ')})
                </div>
              ))}
            </div>
          )}

          <div className="overflow-auto border border-zinc-800 rounded">
            <table className="w-full text-xs">
              <thead className="bg-zinc-800/50 text-zinc-400 text-[10px] uppercase tracking-wide">
                <tr>
                  <th className="px-2 py-1.5 text-right w-12">#</th>
                  <th className="px-2 py-1.5 text-center w-16" title="The tier that decided this node's global position. Earlier tiers may have contributed constraints that were not decisive — see Reason column.">Decided</th>
                  <th className="px-2 py-1.5 text-left">Name</th>
                  <th className="px-2 py-1.5 text-left">Type</th>
                  <th className="px-2 py-1.5 text-left">Reason</th>
                  <th className="px-2 py-1.5 text-left">Chapter</th>
                  <th className="px-2 py-1.5 text-right w-16">x</th>
                  <th className="px-2 py-1.5 text-right w-16">y</th>
                  <th className="px-2 py-1.5 text-left font-mono text-[10px]">id</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-800/30">
                    <td className="px-2 py-1 text-right text-zinc-500">{r.idx}</td>
                    <td className="px-2 py-1 text-center"><TierBadge tier={r.tier} /></td>
                    <td className="px-2 py-1 text-zinc-200">{nodeDisplayNameById.get(r.id) || <span className="text-zinc-600">(unnamed)</span>}</td>
                    <td className="px-2 py-1 text-zinc-400">{formatNodeType(r.node)}</td>
                    <td className="px-2 py-1 text-zinc-300">{r.reasonText || <span className="text-zinc-600">—</span>}</td>
                    <td className="px-2 py-1 text-zinc-400">{r.chapterLabel || <span className="text-zinc-600">—</span>}</td>
                    <td className="px-2 py-1 text-right text-zinc-500 font-mono">{Math.round(r.node?.position?.x ?? 0)}</td>
                    <td className="px-2 py-1 text-right text-zinc-500 font-mono">{Math.round(r.node?.position?.y ?? 0)}</td>
                    <td className="px-2 py-1 text-zinc-600 font-mono text-[10px]">{r.id.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {Array.isArray(tierSnapshots) && tierSnapshots.length > 0 && (
            <details className="mt-6 text-xs">
              <summary className="cursor-pointer text-zinc-300 hover:text-zinc-100 select-none mb-2">
                Decision tree (per-tier resolution log)
              </summary>
              <p className="text-[11px] text-zinc-500 mb-3 italic">
                For each tier, shows the pair facts that first fired at that tier and the connected-component groups that had formed in the cumulative subgraph (tier &le; T). A group is &quot;internally resolved&quot; once every pair within it has a directed tier-&le;-T path; otherwise ambiguous pairs are listed.
              </p>
              {tierSnapshots
                .filter((snap) => snap.newPairs.length > 0 || snap.groups.some((g) => g.nodeIds.length > 1))
                .map((snap) => (
                  <TierSection
                    key={snap.tier}
                    snap={snap}
                    nodeDisplayNameById={nodeDisplayNameById}
                    nameMaps={nameMaps}
                  />
                ))}
            </details>
          )}
        </>
      )}
    </div>
  )
}

function TierSection({ snap, nodeDisplayNameById, nameMaps }) {
  const { tier, newPairs, groups } = snap
  const desc = TIER_DESCRIPTIONS[tier] || `Tier ${tier}`
  const multiNodeGroups = groups.filter((g) => g.nodeIds.length > 1)
  const resolvedCount = multiNodeGroups.filter((g) => g.internallyResolved).length
  return (
    <div className="border border-zinc-800 rounded p-3 mb-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <TierBadge tier={tier} />
        <span className="text-zinc-300">{desc}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">
          {newPairs.length} new pair{newPairs.length === 1 ? '' : 's'}
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">
          {multiNodeGroups.length} group{multiNodeGroups.length === 1 ? '' : 's'}
          {multiNodeGroups.length > 0 ? `, ${resolvedCount} internally resolved` : ''}
        </span>
      </div>

      {newPairs.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">New pairs</div>
          <ul className="space-y-0.5 pl-1">
            {newPairs.map((p, i) => (
              <li key={i} className="text-zinc-400 flex items-center gap-1.5 flex-wrap">
                <span className="text-zinc-200">{nodeDisplayNameById.get(p.predId) || p.predId.slice(0, 6)}</span>
                <span className="text-zinc-500">&rarr;</span>
                <span className="text-zinc-200">{nodeDisplayNameById.get(p.succId) || p.succId.slice(0, 6)}</span>
                <span className="text-zinc-600 ml-1">
                  ({formatAdjacencyReason({ ...p.payload, tier }, nameMaps)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {multiNodeGroups.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Groups (tier &le; {tier})</div>
          <div className="space-y-1.5">
            {multiNodeGroups.map((g, i) => (
              <GroupTimeline key={i} group={g} nodeDisplayNameById={nodeDisplayNameById} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function GroupTimeline({ group, nodeDisplayNameById }) {
  const { nodeIds, internallyResolved, ambiguousPairs } = group
  // Build a set of ambiguous unordered pair keys for quick lookup between
  // adjacent chips in the rendered sort order.
  const ambigKeys = new Set()
  for (const [a, b] of ambiguousPairs || []) {
    ambigKeys.add(a < b ? `${a}|${b}` : `${b}|${a}`)
  }
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const unresolvedCount = ambiguousPairs?.length || 0
  const children = []
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]
    const label = nodeDisplayNameById.get(id) || id.slice(0, 6)
    children.push(
      <span
        key={`chip-${id}`}
        title={id}
        className="px-2 py-0.5 text-[11px] rounded border border-zinc-700 bg-zinc-800 text-zinc-200 whitespace-nowrap flex-shrink-0"
        style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {label}
      </span>
    )
    if (i < nodeIds.length - 1) {
      const nextId = nodeIds[i + 1]
      const isAmbig = ambigKeys.has(pairKey(id, nextId))
      children.push(
        isAmbig ? (
          <span
            key={`arr-${i}`}
            className="text-zinc-600 px-1 text-[11px] flex-shrink-0"
            title="No tier-≤-T ordering path between these two nodes — adjacency shown is one valid topo order, not the unique one"
          >
            ?&rarr;
          </span>
        ) : (
          <span key={`arr-${i}`} className="text-zinc-500 px-1 text-[11px] flex-shrink-0">&rarr;</span>
        )
      )
    }
  }
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-0.5">
      {children}
      {!internallyResolved && (
        <span className="text-[10px] text-zinc-600 italic ml-2 flex-shrink-0">
          ({unresolvedCount} unresolved pair{unresolvedCount === 1 ? '' : 's'})
        </span>
      )}
    </div>
  )
}

/**
 * Format a single AdjacencyReason into a short display string. All name
 * resolution happens here — the compute emits id-only structured data.
 */
function formatAdjacencyReason(reason, nameMaps) {
  if (!reason) return ''
  const { entityNameById, chapterNameById } = nameMaps
  const lookupEntity = (eid) => entityNameById.get(eid) || (eid ? `entity ${String(eid).slice(0, 6)}` : '(unknown)')
  switch (reason.kind) {
    case 'origin':
      return 'origin'
    case 'pov':
      return 'POV chain'
    case 'chain':
      return `${lookupEntity(reason.entityId)}'s chain`
    case 'orphanSegment':
      return `orphan segment (${lookupEntity(reason.entityId)}, ${reason.segmentIndex + 1}/${reason.segmentSize})`
    case 'chapter':
      return reason.chapterId
        ? `chapter: ${chapterNameById.get(reason.chapterId) || '(unknown)'}`
        : 'no chapter'
    case 'canvasX':
      if (reason.chapterId) {
        const cn = chapterNameById.get(reason.chapterId) || '(unknown)'
        return `canvas-x = ${reason.x} (chapter: ${cn})`
      }
      return `canvas-x = ${reason.x}`
    case 'canvasY':
      return `canvas-y = ${reason.y}`
    case 'nodeType':
      return 'node-type tiebreak'
    case 'namedBeforeUnnamed':
      return 'name presence (named before unnamed)'
    case 'numeric':
      return `name numeric order (${reason.aNumber} < ${reason.bNumber})`
    case 'alphabetical':
      return 'name alphabetical order'
    case 'uuid':
      return 'UUID order'
    default:
      return `tier ${reason.tier}`
  }
}

/**
 * Format a node's full reason (left + right structured reasons) into a row
 * cell string. Left = "after <prev>", right = "before <next>".
 */
function formatReason(structured, nameMaps) {
  if (!structured) return ''
  const { leftReason, rightReason } = structured
  const { nodeDisplayNameById } = nameMaps
  const nameOf = (id) => nodeDisplayNameById.get(id) || `(${String(id || '').slice(0, 6)})`
  const leftPart = leftReason
    ? `after ${nameOf(leftReason.neighbourId)} (${formatAdjacencyReason(leftReason, nameMaps)})`
    : null
  const rightPart = rightReason
    ? `before ${nameOf(rightReason.neighbourId)} (${formatAdjacencyReason(rightReason, nameMaps)})`
    : null
  if (leftPart && rightPart) return `${leftPart}; ${rightPart}`
  return leftPart || rightPart || ''
}

function getChapterLabel(node, chapters, chapterXOffset, chapterLabelById) {
  if (!node || !node.position) return null
  if (!chapters || chapters.length === 0) return null
  const id = getChapterIdForNode(node, chapters, chapterXOffset)
  return id ? (chapterLabelById.get(id) || id.slice(0, 8)) : null
}

// ── Port Semantics preview (Phase 1.20 planning mockups) ────────────────────
//
// This page is a visual preview of the port shape vocabulary. Each shape is
// rendered at a slightly enlarged preview scale (real ports will be 8-10 px).
// Renders are visual-only — they don't represent live ports on the canvas;
// they're here so the user can approve the shape + fill + state treatments
// before the implementation work starts.

/**
 * Single port glyph rendered at preview scale. `shape` is one of
 * 'circle' / 'diamond' / 'square' / 'unicode'. `fill` is 'filled' or 'hollow'.
 * Colour defaults to REL_COLOUR violet — override per example.
 * `unicode` prop renders a unicode glyph instead of a shape (for ⊗, ☄, etc).
 */
function PortGlyph({ shape = 'circle', fill = 'filled', colour = '#a78bfa', size = 20, haloColour = null, unicode = null, haloSize = 'normal' }) {
  const borderColour = colour
  const fillColour = fill === 'filled' ? colour : 'transparent'
  // Halo size: 'normal' for resting-hover, 'large' for drag-accept (more
  // visible during an active drag). Shadow layers grow proportionally.
  const halo = haloColour
    ? (haloSize === 'large'
      ? { boxShadow: `0 0 0 5px ${haloColour}66, 0 0 16px 6px ${haloColour}55` }
      : { boxShadow: `0 0 0 3px ${haloColour}55, 0 0 8px 2px ${haloColour}44` })
    : {}
  if (shape === 'relationship') {
    return <RelationshipPortGlyph fill={fill} colour={colour} size={size} />
  }
  if (shape === 'broadcastSignal') {
    return <BroadcastSignalGlyph colour={colour} size={size} />
  }
  if (shape === 'unicode' && unicode) {
    return (
      <span
        className="inline-flex items-center justify-center leading-none"
        style={{
          width: size, height: size,
          color: colour,
          fontSize: size * 1.1,
          ...halo,
        }}
      >{unicode}</span>
    )
  }
  if (shape === 'circle') {
    return (
      <span
        className="inline-block rounded-full"
        style={{
          width: size, height: size,
          backgroundColor: fillColour,
          border: `2px solid ${borderColour}`,
          ...halo,
        }}
      />
    )
  }
  if (shape === 'square') {
    return (
      <span
        className="inline-block rounded-sm"
        style={{
          width: size, height: size,
          backgroundColor: fillColour,
          border: `2px solid ${borderColour}`,
          ...halo,
        }}
      />
    )
  }
  if (shape === 'diamond') {
    // Rotated square. Keep halo on the outer span so the rotation doesn't
    // distort the glow.
    return (
      <span
        className="inline-flex items-center justify-center"
        style={{ width: size + 6, height: size + 6, ...halo }}
      >
        <span
          className="inline-block"
          style={{
            width: size * 0.72, height: size * 0.72,
            backgroundColor: fillColour,
            border: `2px solid ${borderColour}`,
            transform: 'rotate(45deg)',
          }}
        />
      </span>
    )
  }
  return null
}

/**
 * Overlays a red X on an existing port glyph. Matches the 2-line SVG used
 * on ChangeSubChip's profile-image-removal overlay (ChangeSubChip.jsx:42-45):
 * 1.5 px stroke, round caps, red-500. No background halo — the X alone
 * carries the "rejected" signal per the three-state drag model (resting,
 * accept, reject).
 */
function PortRejectOverlay({ portGlyph, overlaySize = 18 }) {
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: overlaySize + 8, height: overlaySize + 8 }}>
      {portGlyph}
      <svg
        className="absolute inset-0 pointer-events-none m-auto"
        viewBox="0 0 16 16"
        style={{ width: overlaySize + 4, height: overlaySize + 4 }}
      >
        {/* Black outline underlay — wider stroke below the red X so the cross
            remains legible on ports of any colour or against the entity-colour
            backgrounds. */}
        <line x1="2" y1="2" x2="14" y2="14" stroke="#000000" strokeWidth="3" strokeLinecap="round" />
        <line x1="14" y1="2" x2="2" y2="14" stroke="#000000" strokeWidth="3" strokeLinecap="round" />
        {/* Red X — same 2-line pattern as ChangeSubChip.jsx:42-45. */}
        <line x1="2" y1="2" x2="14" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="14" y1="2" x2="2" y2="14" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  )
}

/**
 * Relationship-icon port glyph. Reuses the canonical RelationshipIcon shape
 * from IdentityBadges.jsx — outline circle with a horizontal two-way arrow
 * inside. Two fill variants encode persistence:
 *   - 'hollow' (action-only, scene-level rel-in): transparent circle interior
 *   - 'filled' (persistent, faction / rel-origin): interior tinted in the
 *     rel violet so the filled-vs-hollow distinction matches the general
 *     port-shape persistence convention
 */
function RelationshipPortGlyph({ fill = 'hollow', colour = '#a78bfa', size = 22 }) {
  const arrowSize = Math.max(6, Math.round(size * 0.66))
  const interior = fill === 'filled' ? `${colour}40` : 'transparent'  // 25% alpha tint when filled
  return (
    <span
      className="inline-flex items-center justify-center rounded-full flex-shrink-0"
      style={{ width: size, height: size, border: `2px solid ${colour}`, backgroundColor: interior }}
    >
      <svg width={arrowSize} height={arrowSize} viewBox="0 0 16 16" fill="none" stroke={colour} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {RELATIONSHIP_ARROW_PATHS}
      </svg>
    </span>
  )
}

/**
 * Custom broadcast-signal glyph. Inline SVG path copied from
 * `.References/Segoe UI Symbol Regular - U+E2C3_Rotated.svg` (three nested
 * arcs radiating from a central dot — "signal fanning outward" metaphor).
 * Renders as pure inline SVG so there's no font dependency and colour is
 * themed via the `fill` prop.
 */
function BroadcastSignalGlyph({ colour = '#7c3aed', size = 22 }) {
  // The path has ~20% whitespace padding inside its original viewBox; render
  // the SVG ~35% larger than the passed `size` so its visible content matches
  // the extent of the other port shapes rendered at the same nominal size.
  const renderSize = Math.round(size * 1.35)
  return (
    <svg
      width={renderSize}
      height={renderSize}
      viewBox="146 458 733 567"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block' }}
    >
      <path
        fill={colour}
        d="m 328.29925,561.43837 -27.65847,-24.53029 c 19.88402,-14.6398 41.42096,-26.31183 64.61014,-35.01535 23.18919,-8.70353 47.94873,-13.84474 74.27796,-15.42291 23.74377,-1.4232 46.78844,0.26235 69.13545,5.05727 22.34702,4.79492 43.43779,12.25989 63.27378,22.39552 19.83598,10.13563 38.042,22.61052 54.61943,37.42389 16.57743,14.81337 31.08204,31.4617 43.51452,49.94496 12.43248,18.48326 22.36329,38.53134 29.79324,60.14559 7.42995,21.61426 11.85612,44.29259 13.27932,68.03636 1.4232,23.74377 -0.25881,46.84768 -5.0467,69.31176 -4.78791,22.46409 -12.25283,43.55556 -22.39552,63.27378 -10.14269,19.71821 -22.55831,37.92137 -37.24758,54.60887 -14.68928,16.6875 -31.27482,31.2478 -49.75808,43.6803 -18.48326,12.4325 -38.53134,22.3632 -60.14559,29.7932 -21.61426,7.43 -44.29259,11.85608 -68.03636,13.27928 -26.32923,1.5782 -51.52562,-0.5687 -75.58841,-6.43988 -24.0628,-5.8713 -46.83976,-14.8872 -68.33014,-27.047 l 24.53028,-27.6585 c 17.5461,9.3294 36.12341,16.1786 55.73122,20.5473 19.60782,4.3689 40.10869,5.9125 61.50114,4.6302 20.45235,-1.2259 39.98239,-5.0508 58.58941,-11.4744 18.60702,-6.4238 35.85023,-14.9478 51.72817,-25.5729 15.87794,-10.625 30.16708,-23.16 42.86741,-37.6049 12.70034,-14.44492 23.43517,-30.18829 32.2046,-47.22873 8.76941,-17.04044 15.23199,-35.18194 19.38709,-54.42305 4.15509,-19.24112 5.61966,-39.0882 4.39375,-59.54055 -1.84592,-30.79631 -9.45243,-59.30021 -22.82031,-85.51306 -13.36788,-26.21285 -30.7072,-48.82496 -52.01877,-67.83768 -21.31155,-19.01273 -45.83365,-33.52685 -73.56564,-43.54309 -27.73197,-10.01624 -56.87905,-14.10842 -87.4398,-12.27661 -21.39245,1.28225 -41.55864,5.32216 -60.49715,12.11963 -18.93852,6.79747 -36.5682,15.75804 -52.88839,26.88099 z m 88.93449,78.54209 -29.87991,-26.16661 c 8.92873,-4.54622 18.32502,-8.17627 28.18953,-10.89091 9.86451,-2.71464 20.08581,-4.38898 30.66461,-5.02307 20.2175,-1.21183 39.49185,1.5257 57.82304,8.2126 18.33118,6.68689 34.53658,16.2736 48.61475,28.75952 14.07816,12.48592 25.53197,27.43015 34.36066,44.83134 8.82868,17.40119 13.84894,36.21053 15.06077,56.42804 1.22591,20.45234 -1.50456,39.84447 -8.19145,58.17565 -6.6869,18.33119 -16.27362,34.5366 -28.75953,48.61476 -12.48592,14.07816 -27.43366,25.47344 -44.84191,34.18434 -17.40824,8.71091 -36.2211,13.67263 -56.4386,14.8845 -21.15761,1.2681 -41.26906,-1.6549 -60.3337,-8.76992 l 26.54037,-29.54843 c 5.02132,1.1146 10.20133,1.92454 15.54006,2.43052 5.33874,0.50599 10.71132,0.5966 16.1185,0.27249 15.28072,-0.91592 29.50303,-4.71775 42.66836,-11.40487 13.16534,-6.68712 24.43998,-15.38498 33.82541,-26.09226 9.38543,-10.70727 16.61146,-22.99583 21.6781,-36.86569 5.06663,-13.86985 7.14239,-28.44446 6.22646,-43.72519 -0.91592,-15.28072 -4.71775,-29.50303 -11.40487,-42.66836 -6.68712,-13.16534 -15.32929,-24.50277 -25.92651,-34.01229 -10.59723,-9.50952 -22.82654,-16.73911 -36.68938,-21.68867 -13.86284,-4.94956 -28.43389,-6.96607 -43.71462,-6.05015 -11.04921,0.66229 -21.42569,2.69982 -31.13014,6.11266 z m 41.23332,162.44293 c -7.99264,0.47908 -15.54864,-0.6018 -22.66657,-3.24199 -7.11793,-2.6402 -13.41844,-6.39177 -18.90005,-11.25341 -5.48161,-4.86164 -9.95892,-10.66892 -13.43046,-17.42051 -3.47153,-6.75159 -5.44723,-14.12439 -5.92631,-22.11702 -0.47907,-7.99264 0.6018,-15.54865 3.24199,-22.66658 2.6402,-7.11792 6.39178,-13.41844 11.25342,-18.90005 4.86164,-5.48161 10.67246,-9.89968 17.43107,-13.25414 6.75861,-3.35446 14.13495,-5.27092 22.1276,-5.74999 7.99264,-0.47909 15.54509,0.54255 22.656,3.06567 7.1109,2.52312 13.40787,6.21546 18.88948,11.0771 5.48161,4.86164 9.95893,10.66891 13.43046,17.4205 3.47153,6.75159 5.44723,14.12439 5.92631,22.11703 0.47907,7.99264 -0.6018,15.54865 -3.24199,22.66657 -2.6402,7.11793 -6.39178,13.41844 -11.25342,18.90005 -4.86163,5.48162 -10.66891,9.95893 -17.4205,13.43046 -6.75159,3.47153 -14.12439,5.44723 -22.11703,5.92631 z"
      />
    </svg>
  )
}

/** Row layout: glyph + name + description + applies-to list. */
function ShapeRow({ shape, fill, colour, name, description, appliesTo, haloColour }) {
  return (
    <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '44px 140px 1fr 1fr' }}>
      <div className="flex justify-center">
        <PortGlyph shape={shape} fill={fill} colour={colour} size={22} haloColour={haloColour} />
      </div>
      <div>
        <div className="text-xs text-zinc-200 font-medium">{name}</div>
      </div>
      <div className="text-[11px] text-zinc-400">{description}</div>
      <div className="text-[11px] text-zinc-500 italic">{appliesTo}</div>
    </div>
  )
}

/** Two-cell side-by-side state comparison (resting vs drag-active vs reject). */
function StateCell({ label, glyph }) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-2 bg-zinc-800/50 rounded border border-zinc-800">
      <div className="flex items-center justify-center h-10">{glyph}</div>
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</div>
    </div>
  )
}

/** Mini scene-node preview showing the ports in their approximate positions.
 * Taller default height + higher per-port `top` offsets so ports don't overlap
 * when several are stacked on the same edge. */
function NodePreview({ title, subtitle, ports, tint, height = 120 }) {
  return (
    <div
      className="relative rounded border px-3 py-2"
      style={{
        borderColor: tint ? `${tint}77` : '#3f3f46',
        backgroundColor: tint ? `${tint}12` : '#18181b',
        width: 220,
        height,
      }}
    >
      <div className="text-[10px] text-zinc-400 uppercase tracking-widest">{title}</div>
      <div className="text-xs text-zinc-200 truncate">{subtitle}</div>
      {ports.map((p, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            [p.side]: -10,
            top: p.top,
            transform: 'translateY(-50%)',
          }}
          title={p.label}
        >
          <PortGlyph shape={p.shape} fill={p.fill} colour={p.colour} size={12} unicode={p.unicode} />
        </span>
      ))}
    </div>
  )
}

function PortSemanticsPreview() {
  const REL = '#a78bfa'
  const POV = '#eab308'
  const BROADCAST = '#7c3aed'
  const ENT_A = '#ec4899'  // rose — stand-in for an entity colour
  const ACCENT = '#c084fc'

  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Port Semantics — Phase 1.20 Mockups</h2>
      <p className="text-xs text-zinc-500 mb-4 italic">
        Visual preview of the proposed port-shape vocabulary + drag-time states.
      </p>

      {/* ── Section 1: Shape catalogue ─────────────────────────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          1. Shape catalogue (resting state)
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-2">
          Each shape encodes one payload type × persistence combination. Colour still comes from the parent context
          (entity colour, POV colour, REL violet) — shape carries the semantic.
        </p>
        <ShapeRow
          shape="circle" fill="filled" colour={ENT_A}
          name="Filled circle"
          description="Narrative-flow endpoint. Drop creates a persistent edge that carries entity chain forward."
          appliesTo="scene flow-in, chip-in, chip-out, entityNode I/O"
        />
        <ShapeRow
          shape="circle" fill="hollow" colour={REL}
          name="Hollow circle"
          description="Action-only target. Drop fires an action; nothing stays behind. Generic action-only convention (not a relationship-specific glyph) so the same hollow-circle shape can cover future action-only ports."
          appliesTo="scene-level rel-in (v0.1.18.133)"
        />
        <ShapeRow
          shape="diamond" fill="filled" colour={POV}
          name="Filled diamond"
          description="POV chain endpoint. Drop creates a persistent POV edge (in or out)."
          appliesTo="pov-in / pov-out on scenes, povOriginNode output"
        />
        <ShapeRow
          shape="broadcastSignal" fill="filled" colour={BROADCAST}
          name="Signal waves (custom SVG)"
          description="Fan-out broadcast. Drop creates per-entity wires to every chip on the target scene. Inline SVG (Segoe UI Symbol U+E2C3 rotated) so rendering is consistent across platforms."
          appliesTo="broadcast on sceneNode"
        />
        <ShapeRow
          shape="relationship" fill="filled" colour={REL}
          name="Relationship icon (filled)"
          description="Relationship-join endpoint that persists. Drop creates a relationship edge AND records the participant join. Same glyph as the hollow variant but with a violet-tinted interior to signal persistence."
          appliesTo="rel-in on entityNode (faction membership), relationshipOriginNode input"
        />
      </section>

      {/* ── Section 2: Drag-time states ───────────────────────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          2. Drag-time state transitions
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          Three-state drag-time model. When the user starts dragging a wire:
        </p>
        <ul className="text-[11px] text-zinc-400 italic mb-3 ml-4 space-y-1 list-disc">
          <li><strong className="text-zinc-300">Resting</strong> — port does not accept this payload type. No visual change. (Not dimmed — avoids false-negative perception.)</li>
          <li><strong className="text-zinc-300">Accept</strong> — port accepts this payload AND the drop would succeed. Accent halo.</li>
          <li><strong className="text-zinc-300">Reject</strong> — port <em>normally</em> accepts this payload BUT this specific drop is blocked by a guard (<code className="text-zinc-500">wouldCreateCycle</code>, <code className="text-zinc-500">wouldCreatePovLoop</code>, <code className="text-zinc-500">wouldContradictStoryOrder</code>). Red X overlay, no glow.</li>
        </ul>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          A hover state for the port-at-rest is shown too for comparison — subtle zinc halo that telegraphs
          "this port is interactive." Whether to keep or drop the hover state is an open approval question.
        </p>

        <div className="grid grid-cols-4 gap-2 mb-3">
          <StateCell label="Resting" glyph={<PortGlyph shape="circle" fill="filled" colour={ENT_A} size={18} />} />
          <StateCell label="Hover" glyph={<PortGlyph shape="circle" fill="filled" colour={ENT_A} size={18} haloColour="#71717a" />} />
          <StateCell label="Drag-accept" glyph={<PortGlyph shape="circle" fill="filled" colour={ENT_A} size={18} haloColour={ACCENT} haloSize="large" />} />
          <StateCell label="Drag-reject (red X, no glow)" glyph={<PortRejectOverlay portGlyph={<PortGlyph shape="circle" fill="filled" colour={ENT_A} size={18} />} overlaySize={18} />} />
        </div>
        <div className="text-[11px] text-zinc-600 italic">
          <strong>Drag-accept:</strong> larger accent halo (5 px ring + 16 px outer glow) — more visible during
          an active drag than a static hover state.<br/>
          <strong>Drag-reject:</strong> red X SVG overlay (same 2-line cross used on change sub-chips for
          profile-image removal, <code className="text-zinc-500">ChangeSubChip.jsx:42-45</code>). No glow — the
          X is unambiguous as "no" and reads clearly at port scale without competing with the accent halo.
        </div>
      </section>

      {/* ── Section 2a: Broadcast shape alternatives ─────────────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          2a. Broadcast port — shape alternatives
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          User raised some options beyond the filled-square proposal. The broadcast port is semantically different
          from every other source port (fan-out to multiple wires at once), so it deserves a distinct glyph.
          Comparing below at uniform 22 px preview scale.
        </p>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <PortGlyph shape="square" fill="filled" colour={BROADCAST} size={22} />
          </div>
          <div className="text-xs text-zinc-200">Filled square</div>
          <div className="text-[11px] text-zinc-400">Original proposal. Categorically distinct from circles / diamonds. Simple to render at 8–10 px port scale.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <PortGlyph shape="unicode" unicode="☄" colour={BROADCAST} size={22} />
          </div>
          <div className="text-xs text-zinc-200">☄ Comet (U+2604)</div>
          <div className="text-[11px] text-zinc-400">Strong "propagation" metaphor. Risk: glyph is visually dense and font-dependent — may render differently across platforms at 8–10 px.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <PortGlyph shape="unicode" unicode="➲" colour={BROADCAST} size={22} />
          </div>
          <div className="text-xs text-zinc-200">➲ Heavy arrow (U+27B2)</div>
          <div className="text-[11px] text-zinc-400">Bold arrowhead. Reads as "out" but not specifically as "fan out to many"; could confuse with other arrow glyphs on the canvas.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <PortGlyph shape="unicode" unicode="⟄" colour={BROADCAST} size={22} />
          </div>
          <div className="text-xs text-zinc-200">⟄ Diagonal stroke (U+27C4)</div>
          <div className="text-[11px] text-zinc-400">Abstract. Risk: unclear metaphor at port scale; users would need to learn its meaning entirely.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <span className="inline-flex items-center" style={{ gap: 2 }}>
              <PortGlyph shape="circle" fill="hollow" colour={BROADCAST} size={14} />
              <span className="leading-none" style={{ color: BROADCAST, fontSize: 18 }}>⟫</span>
            </span>
          </div>
          <div className="text-xs text-zinc-200">⭘⟫ Circle + angles</div>
          <div className="text-[11px] text-zinc-400">Composite suggests "one thing → many directions". Good metaphor match but fragile at port scale; two sub-glyphs may crowd.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <span className="inline-flex items-center" style={{ gap: 2 }}>
              <PortGlyph shape="circle" fill="hollow" colour={BROADCAST} size={12} />
              <PortGlyph shape="circle" fill="hollow" colour={BROADCAST} size={12} />
            </span>
          </div>
          <div className="text-xs text-zinc-200">⭘⭘ Double circle</div>
          <div className="text-[11px] text-zinc-400">"Multiple" metaphor via repetition. Reliable rendering (just circles). Risk: may read as two separate ports rather than one logical port.</div>
        </div>
        <div className="grid items-center gap-3 py-2 border-b border-zinc-800" style={{ gridTemplateColumns: '64px 140px 1fr' }}>
          <div className="flex justify-center">
            <BroadcastSignalGlyph colour={BROADCAST} size={22} />
          </div>
          <div className="text-xs text-zinc-200">Signal waves (custom SVG)</div>
          <div className="text-[11px] text-zinc-400">Segoe UI Symbol U+E2C3 (rotated). Nested arcs radiating from a central dot — literal "signal fanning outward" metaphor. Shipped as inline SVG so rendering is consistent across platforms (no font dependency). Best semantic match for broadcast; slightly more complex to render at 8–10 px but still legible.</div>
        </div>
        <div className="text-[11px] text-zinc-500 italic mt-3">
          Original recommendation was filled square for simplicity + reliability. The signal-waves SVG is a stronger
          semantic match and renders consistently as inline SVG — preferred if the extra rendering complexity is
          acceptable at port scale.
        </div>
      </section>

      {/* ── Section 2b: Reserved icons for future port types ─────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          2b. Reserved for future port types
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          User noted these glyphs should be held in reserve — not used for Phase 1.20 ports — so the upcoming
          time-tracking phase can claim them for time-line wires / duration connections / time-origin ports.
        </p>
        <div className="flex flex-wrap items-center gap-6">
          {['◷', '⏰', '⏲', '⏱'].map((g) => (
            <div key={g} className="flex items-center gap-2">
              <PortGlyph shape="unicode" unicode={g} colour="#38bdf8" size={22} />
              <span className="text-[11px] text-zinc-500 font-mono">{g}</span>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-zinc-600 italic mt-3">
          Phase 1.23 (Date/Time Tracking) will likely want these for Time Line wires + Time Origin nodes.
          Phase 1.20 avoids claiming them.
        </div>
      </section>

      {/* ── Section 3: Context-aware shape for the same handle id ─────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          3. Context-aware shape: same <code className="text-zinc-400">rel-in-*</code> handle, two outcomes
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          The same <code className="text-zinc-400">rel-in-{'{relId}'}</code> handle id renders differently depending on
          its parent node. On a scene's relationship chip it's action-only (hollow). On an entity's faction-membership
          surface it creates a persistent wire (filled).
        </p>
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <PortGlyph shape="circle" fill="hollow" colour={REL} size={22} />
            <div>
              <div className="text-xs text-zinc-200">Hollow circle — scene-level</div>
              <div className="text-[10px] text-zinc-500">rel-in on sceneNode rel chip. ACTION_ONLY per v0.1.18.133. Generic action-only shape (no relationship-specific glyph).</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <PortGlyph shape="relationship" fill="filled" colour={REL} size={22} />
            <div>
              <div className="text-xs text-zinc-200">Relationship icon — faction / rel origin</div>
              <div className="text-[10px] text-zinc-500">rel-in on entityNode (faction), relationshipOriginNode input. PERSIST_WIRE + ACTION. Reuses the canonical relationship glyph (two-way arrow in a circle) from IdentityBadges.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 4: Per-node-type port preview ────────────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          4. Per-node-type port preview (approximate positions)
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          Node bodies are shown at preview scale; ports are rendered at the approximate positions they'd sit at
          relative to each node. Real canvas port sizes will be 8–10 px.
        </p>
        <div className="flex flex-wrap gap-6">
          <NodePreview
            title="Scene" subtitle="Scene 1" tint="#7c3aed" height={150}
            ports={[
              { side: 'left', top: 24, shape: 'circle', fill: 'filled', colour: '#a1a1aa', label: 'scene flow-in' },
              { side: 'right', top: 24, shape: 'broadcastSignal', fill: 'filled', colour: BROADCAST, label: 'broadcast' },
              { side: 'left', top: 62, shape: 'circle', fill: 'filled', colour: ENT_A, label: 'chip-in (Alice)' },
              { side: 'right', top: 62, shape: 'circle', fill: 'filled', colour: ENT_A, label: 'chip-out (Alice)' },
              { side: 'left', top: 100, shape: 'diamond', fill: 'filled', colour: POV, label: 'pov-in' },
              { side: 'right', top: 100, shape: 'diamond', fill: 'filled', colour: POV, label: 'pov-out' },
            ]}
          />
          <NodePreview
            title="Entity" subtitle="Alice (origin)" tint={ENT_A} height={80}
            ports={[
              { side: 'left', top: 40, shape: 'circle', fill: 'filled', colour: ENT_A, label: 'input' },
              { side: 'right', top: 40, shape: 'circle', fill: 'filled', colour: ENT_A, label: 'output' },
            ]}
          />
          <NodePreview
            title="Entity — faction" subtitle="The Order" tint="#10b981" height={110}
            ports={[
              { side: 'left', top: 30, shape: 'circle', fill: 'filled', colour: '#10b981', label: 'input' },
              { side: 'right', top: 30, shape: 'circle', fill: 'filled', colour: '#10b981', label: 'output' },
              { side: 'left', top: 80, shape: 'relationship', fill: 'filled', colour: REL, label: 'rel-in (member)' },
            ]}
          />
          <NodePreview
            title="Relationship origin" subtitle="Friendship" tint={REL} height={80}
            ports={[
              { side: 'left', top: 40, shape: 'relationship', fill: 'filled', colour: REL, label: 'input' },
            ]}
          />
          <NodePreview
            title="POV origin" subtitle="POV" tint={POV} height={80}
            ports={[
              { side: 'right', top: 40, shape: 'diamond', fill: 'filled', colour: POV, label: 'pov-out' },
            ]}
          />
          <NodePreview
            title="Scene — rel chip" subtitle="Friendship active" tint={REL} height={80}
            ports={[
              { side: 'left', top: 40, shape: 'circle', fill: 'hollow', colour: REL, label: 'rel-in (scene-level, action-only)' },
            ]}
          />
        </div>
      </section>

      {/* ── Section 5: Legend surface mockup ─────────────────────────── */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          5. Canvas toolbar Legend modal (discoverability)
        </h3>
        <p className="text-[11px] text-zinc-500 italic mb-3">
          Proposed `?` button in the Canvas toolbar opens a compact modal with this content. Per-port hover tooltip
          (native `title` attribute) also explains the port at rest, but this modal is the single place to see the
          full vocabulary.
        </p>
        <div className="border border-zinc-700 rounded p-4 bg-zinc-900 max-w-md">
          <div className="text-[11px] uppercase tracking-widest text-zinc-400 mb-3">Port shapes</div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <PortGlyph shape="circle" fill="filled" colour="#a1a1aa" size={14} />
              <div className="text-[11px] text-zinc-300">Narrative flow — persistent wire</div>
            </div>
            <div className="flex items-center gap-3">
              <PortGlyph shape="circle" fill="hollow" colour={REL} size={14} />
              <div className="text-[11px] text-zinc-300">Action-only target — drop fires action, nothing persists</div>
            </div>
            <div className="flex items-center gap-3">
              <PortGlyph shape="relationship" fill="filled" colour={REL} size={14} />
              <div className="text-[11px] text-zinc-300">Relationship join — persistent (faction / rel origin)</div>
            </div>
            <div className="flex items-center gap-3">
              <PortGlyph shape="diamond" fill="filled" colour={POV} size={14} />
              <div className="text-[11px] text-zinc-300">POV chain</div>
            </div>
            <div className="flex items-center gap-3">
              <PortGlyph shape="broadcastSignal" fill="filled" colour={BROADCAST} size={14} />
              <div className="text-[11px] text-zinc-300">Scene broadcast (fan-out to every chip)</div>
            </div>
          </div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-400 mt-4 mb-1">Drag states</div>
          <div className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <div>During drag: accent halo on accepting ports; no dimming elsewhere.</div>
            <div>During drag: red outline on ports whose drop would create a cycle or contradict POV / chain order.</div>
          </div>
        </div>
      </section>

      {/* ── Section 6: Outstanding questions ─────────────────────────── */}
      <section className="mb-2">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
          6. Outstanding decisions needing user approval
        </h3>
        <div className="text-[11px] text-zinc-400 leading-relaxed space-y-2">
          <div><span className="text-zinc-200">Shape assignments</span> — are the four primitives right for the four payload types? (filled circle / hollow circle / filled diamond / filled square)</div>
          <div><span className="text-zinc-200">Hollow = action-only</span> — is the hollow-circle signal sufficient on its own, or does it need a secondary treatment (play button / bolt / pulse) as discussed in the planning doc?</div>
          <div><span className="text-zinc-200">Drag-accept halo colour</span> — accent colour shown here; should it be a neutral green / white instead?</div>
          <div><span className="text-zinc-200">Drag-reject red outline</span> — red-500 shown here; acceptable as the reject signal? Or should the port pulse / shake instead?</div>
          <div><span className="text-zinc-200">Hover state</span> — subtle zinc halo on plain hover; worth keeping as "pre-signal" that a port is interactive, or drop it (only show halo during active drag)?</div>
          <div><span className="text-zinc-200">Legend modal placement</span> — `?` button in the canvas toolbar is one option; per-port `title` tooltip is another. Is having BOTH the right call, or should one be primary?</div>
          <div><span className="text-zinc-200">Tooltip wording approach</span> — see §P6 in the planning doc for per-branch wording. Any per-branch wording you want to tweak before we build the catalogue?</div>
        </div>
      </section>
    </div>
  )
}

// ── Sub-chips preview (unified) ──────────────────────────────────────
//
// Single page covering every sub-chip family that lives in
// `components/ui/change-subchips/`. Each subsection mounts the actual
// component with mock fixtures so the visuals stay in sync with the
// shipping renderers.
//
// Order follows the sub-chip host-context groupings:
//   1. Change sub-chips (entity-side attribute / scalar changes —
//      ChangeSubChip)
//   2. Awareness sub-chips (every awareness kind — AwarenessSubChip)
//   3. Relationship-on-entity-chip presence (RelationshipSubChip)
//   4. Relationship change events on relationship chips
//      (RelChangeChip)
//   5. Sidebar relationship-change rows (RelationshipChangeChip)
//   6. Sidebar relationship-history rows
//      (RelationshipHistoryChangeChip)
//
// When adding a new sub-chip variant to any renderer, also add a row
// here so the catalogue stays exhaustive.

function SubChipsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Sub-chips catalogue</h2>
      <p className="text-[11px] text-zinc-400">
        Every sub-chip variant the app renders. Mock fixtures: <span className="text-zinc-200">Alice</span> (character),
        {' '}<span className="text-zinc-200">Bob</span> (character),
        {' '}<span className="text-zinc-200">Cabal</span> (faction),
        {' '}<span className="text-zinc-200">Sword</span> (item),
        {' '}<span className="text-zinc-200">The Conspiracy</span> (relationship),
        {' '}<span className="text-zinc-200">LostHeir</span> (Knowledge).
      </p>

      <ChangeSubChipsSection />
      <CircumstanceMotivatorSubChipsSection />
      <AwarenessSubChipsSection />
      <RelationshipSubChipsSection />
      <RelChangeChipsSection />
      <SidebarRelationshipChangeChipsSection />
      <SidebarRelationshipHistoryChipsSection />
      <FallbackSubChipsSection />
    </div>
  )
}

// ── Phase 1.22 — Circumstance / Motivator subchip catalogue section ───
function CircumstanceMotivatorSubChipsSection() {
  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Circumstance / Motivator sub-chips (Phase 1.22)</h3>
        <p className="text-[10px] text-zinc-500">
          Single component used across every surface where a circumstance / motivator surfaces:
          Detail Panel attribute rows, scene-side Circumstances rows, canvas chip carried rows,
          Scene Changes tab change-event rows, and the scene Detail Panel Per-entity rollup.
          Same-shape reuse means visual identity stays consistent everywhere.
        </p>
      </div>

      <Section title="Current-state rows — circumstance, all five intensity tiers + unset">
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Pill-induced transformation"
            description="Subject's body has been altered by an enchanted pill. Effect time-limited."
            intensity={4}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Receiving unwanted attention"
            description="Subject is being approached or pursued in a way they did not invite."
            intensity={3}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Loud and crowded"
            description="The setting has high social-attention density."
            intensity={2}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Forced social obligation"
            description="Subject is required to attend / participate in something they did not freely choose."
            intensity={1}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Mild curiosity"
            description="Slightly inclined to investigate."
            intensity={0}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            name="Pregnant"
            description="Binary state — slider intentionally unset."
            intensity={null}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance"
            description="Unnamed circumstance — falls back to truncated description as the row label."
          />
        </div>
      </Section>

      <Section title="Current-state rows — motivator, all five intensity tiers + unset">
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Self-image as straight man"
            description="Subject's interior identity remains that of a straight man regardless of current bodily state."
            intensity={4}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Honour the bet"
            description="Subject feels duty-bound to follow through on a wager they lost, even when uncomfortable."
            intensity={3}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Embarrassment-aversion"
            description="Subject seeks to avoid public embarrassment, especially in front of peers."
            intensity={2}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Cynical disposition"
            description="Tends to assume the worst of others' motives."
            intensity={1}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Faint nostalgia"
            description="A barely-felt pull toward the past."
            intensity={0}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator"
            name="Existential drive"
            description="No specific intensity set."
            intensity={null}
          />
        </div>
      </Section>

      <Section title="Change-event rows — add / modify / remove">
        <p className="text-[10px] text-zinc-500 mb-2">
          When rendered as a change event the row gets the standard <code>✚ ADDED / ⚊ REMOVED / ✱ MODIFIED</code>
          glyph in front. Layout: <code>[action glyph] [type badge] [name] [intensity badge if set]</code>.
        </p>
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="add" name="Drunk"
            description="Subject has been drinking and is feeling the effects." intensity={2}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="add" name="Cognitive dissonance"
            description="Holding two contradictory beliefs / responses simultaneously." intensity={3}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="remove" name="Stuck in traffic"
            description="The car is no longer stopped."
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="remove" name="Embarrassment-aversion"
            description="The motivator no longer applies."
          />
        </div>
      </Section>

      <Section title="Modify with intensity-only transition (leading IntensityBadge, no ✱ glyph)">
        <p className="text-[10px] text-zinc-500 mb-2">
          For modifies that change ONLY the intensity slider, the row leads with the new IntensityBadge
          {' '}(no <code>✱</code> glyph — the badge IS the action signal, awareness-style). The row's background
          {' '}tint follows the new tier colour. One sample for each tier transition + the unset/cleared variant:
        </p>
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="modify" name="Faint tier"
            oldIntensity={null} newIntensity={0}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="modify" name="Mild tier"
            oldIntensity={0} newIntensity={1}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="modify" name="Moderate tier"
            oldIntensity={1} newIntensity={2}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="modify" name="Strong tier"
            oldIntensity={2} newIntensity={3}
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="modify" name="Intense tier"
            oldIntensity={3} newIntensity={4}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="modify" name="Cleared (back to unset)"
            oldIntensity={4} newIntensity={null}
          />
        </div>
      </Section>

      <Section title="Modify with text transition (name or description change)">
        <p className="text-[10px] text-zinc-500 mb-2">
          For modifies of name or description, the row renders the standard <code>oldValue → newValue</code> text transition.
        </p>
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="motivator" action="modify" name="Honour the bet"
            oldValue="Honour the bet" newValue="Honour the bet (sober)"
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" action="modify" name="Forced social obligation"
            oldValue="The bet party" newValue="The bet party (now leaving)"
          />
        </div>
      </Section>

      <Section title="Hover-reveal affordances (dismiss + Add Knowledge)">
        <p className="text-[10px] text-zinc-500 mb-2">
          Hover any row below to reveal the dismiss <code>−</code> and <code>+ Knowledge</code> buttons —
          inherited from <code>BaseChangeChip</code>, identical to other subchip families.
        </p>
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" name="Pill-induced transformation"
            description="Same as the row above, but with hover affordances wired."
            intensity={4}
            onDismiss={() => console.log('[DevPreview] dismiss circumstance')}
            onAddKnowledge={() => console.log('[DevPreview] add knowledge of circumstance')}
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" name="Honour the bet"
            description="Subject feels duty-bound." intensity={3}
            onDismiss={() => console.log('[DevPreview] dismiss motivator')}
            onAddKnowledge={() => console.log('[DevPreview] add knowledge of motivator')}
          />
        </div>
      </Section>

      <Section title="Phase 1.22h — Temporary variant (chevron-corner pentagon)">
        <p className="text-[10px] text-zinc-500 mb-2">
          Temporary circumstances / motivators apply to one entity at one scene only and don't propagate
          downstream. The pentagon outline on both the type badge and the IntensityBadge collapses to five
          chevron-shaped corner segments instead of the full perimeter — a visual signal that the entry is
          scoped, not full. Inner fill polygon and letter overlay are unchanged. Sample rows here pass
          <code> temporary={'{true}'}</code> to the same component.
        </p>
        <div className="space-y-1 max-w-[460px]">
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" name="Drunk" description="Three pints in." intensity={2}
            temporary
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" name="Embarrassment-aversion"
            description="Trying to keep face at the bet party." intensity={3}
            temporary
          />
          <CircumstanceMotivatorSubChip
            attributeType="circumstance" name="Pregnant" intensity={4}
            temporary
          />
          <CircumstanceMotivatorSubChip
            attributeType="motivator" name="Curiosity" description="Wants to peek behind the curtain."
            temporary
          />
        </div>
      </Section>
    </section>
  )
}

// Module-level guard: log the "expected test cases" banner exactly
// once per page load. The banner runs at render-time (before child
// useEffects) so it appears in the console *before* the dispatcher
// catchall warnings the section deliberately triggers, contextualising
// them as expected-by-design rather than real bugs.
let _DEV_PREVIEW_FALLBACK_BANNER_LOGGED = false
function logExpectedFallbackBanner() {
  if (_DEV_PREVIEW_FALLBACK_BANNER_LOGGED) return
  _DEV_PREVIEW_FALLBACK_BANNER_LOGGED = true
   
  console.info(
    '%c[DevPreview] Sub-chip fallback test cases',
    'color: #fbbf24; font-weight: bold;',
    '\nThe next ~5 [FallbackSubChip] warnings are EXPECTED — they intentionally feed unknown discriminators into each sub-chip dispatcher to confirm its catchall fires correctly. They are NOT real-world problems to investigate; they only appear because you opened the Sub-chips dev preview page. If a [FallbackSubChip] warning fires anywhere ELSE in the app (canvas, sidebar, alerts, etc.), THAT is the kind of gap to chase.',
  )
}

// ── 7. Fallback sub-chip (universal "TODO renderer" catchall) ──────
function FallbackSubChipsSection() {
  // Render-time log so the banner lands in the console before the
  // child dispatchers' useEffect-driven fallback warnings fire (effect
  // order is children-before-parent, so a parent useEffect would log
  // *after* the warnings — opposite of what we want).
  logExpectedFallbackBanner()
  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Fallback sub-chip (universal catchall)</h3>
        <p className="text-[10px] text-zinc-500">
          Visually-loud default rendered by every sub-chip dispatcher (<code>AwarenessSubChip</code>,
          {' '}<code>ChangeSubChip</code>, <code>RelChangeChip</code>,
          {' '}<code>RelationshipHistoryChangeChip</code>, <code>RelationshipSubChip</code>) when a
          discriminator (kind / action / type / changeType) doesn't match any known dispatch branch.
          Gray fill + red border + ⚠ glyph + "TODO" label so unhandled cases are immediately visible
          during development instead of silently dropping. When you see this in the wild, it means
          a new variant landed in the data without a matching renderer branch — find the dispatcher
          named in the <code>kind</code> prefix and add the missing branch.
        </p>
      </div>

      <Section title="Live dispatcher catchalls">
        <p className="text-[10px] text-zinc-500 mb-2">
          Each row triggers the catchall in a real dispatcher with a fabricated unknown discriminator —
          confirms the wiring works end-to-end across every sub-chip family. If any of these renders
          something OTHER than a fallback chip, that dispatcher's catchall is broken.
        </p>
        <div className="space-y-1 max-w-[480px]">
          <AwarenessSubChip
            record={{ kind: 'futurekind', changeId: 'demo-1', level: 3 }}
            getEntity={() => null}
            getRelationship={() => null}
            getKnowledge={() => null}
          />
          <ChangeSubChip chip={{ action: 'futureaction', field: 'Title', newValue: 'something' }} />
          <RelChangeChip change={{ type: 'futurereltype', action: 'modify' }} getEntity={() => null} />
          <RelationshipHistoryChangeChip
            entry={{ relationship: { id: 'r1', name: 'Demo' }, change: { type: 'futurereltype', action: 'modify' } }}
            getEntity={() => null}
          />
          <RelationshipSubChip
            relationship={{ id: 'r1', entity_a_id: 'a', entity_b_id: 'b' }}
            ownerEntityId="a"
            changeType="futureChangeType"
            allEntities={[{ id: 'a', name: 'A', colour: '#888' }, { id: 'b', name: 'B', colour: '#888' }]}
          />
        </div>
      </Section>

      <Section title="Atom directly (with custom message + payload)">
        <div className="space-y-1 max-w-[480px]">
          <FallbackSubChip kind="example" />
          <FallbackSubChip kind="customkind" reason="awaiting design — see Phase 1.21k notes" />
          <FallbackSubChip kind="payload-demo" payload={{ id: 'abc-123', level: 2, foo: 'bar' }} />
        </div>
      </Section>
    </section>
  )
}

// ── 1. Change sub-chips (entity-side) ────────────────────────────────
function ChangeSubChipsSection() {
  const titleAttrChip = (action, oldValue, newValue) => ({
    action, field: 'Title', oldValue, newValue, attributeId: 'attr-title',
  })
  const colourChip = (action, oldValue, newValue) => ({
    action, field: 'Colour', oldValue, newValue, isColour: true,
  })
  // Note: profile-image and file-attribute mocks use placeholder asset
  // paths. The img tags will 404 (real assets don't exist for these
  // ids); the layout structure is still preview-able and the broken-
  // image fallback shows the slot positions. For a fully-loaded preview
  // the dev would need to wire real asset refs from a loaded project.
  const profileImageChip = (action, oldRef, newRef) => ({
    action, field: 'Profile Image', isProfileImage: true,
    oldImageRef: oldRef, newImageRef: newRef,
  })
  const fileAttrChip = (action, oldRef, newRef) => ({
    action, field: 'Portrait', isFileAttribute: true,
    oldFileRef: oldRef, newFileRef: newRef,
  })

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Change sub-chips</h3>
        <p className="text-[10px] text-zinc-500">
          Entity-side attribute / scalar / colour / profile-image / file
          / list / rename changes. Renders on entity chips and modifier
          nodes via <code>ChangeSubChip</code>.
        </p>
      </div>

      <Section title="Text attribute (add / modify / remove)">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={titleAttrChip('add',    null,       'Princess')} />
          <ChangeSubChip chip={titleAttrChip('modify', 'Princess', 'Queen')} />
          <ChangeSubChip chip={titleAttrChip('remove', 'Queen',    null)} />
        </div>
      </Section>

      <Section title="Generic add / remove (no specific value display)">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={{ action: 'add',    field: 'Backstory', newValue: null }} />
          <ChangeSubChip chip={{ action: 'remove', field: 'Backstory' }} />
        </div>
      </Section>

      <Section title="Profile image change">
        <p className="text-[10px] text-zinc-500 mb-2">
          Image thumbnails replace text. Old image is shown crossed-out next to the new one on modify.
          Avatars sourced from <code>frontend/public/dev-preview/</code> (extracted from TestFixture_015 — Alice has baseline + scene1 + scene2 variants).
        </p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={profileImageChip('add',    null,                              '/dev-preview/alice-baseline.jpg')} entityColour="#6ea4ff" />
          <ChangeSubChip chip={profileImageChip('modify', '/dev-preview/alice-baseline.jpg', '/dev-preview/alice-scene1.jpg')}    entityColour="#6ea4ff" />
          <ChangeSubChip chip={profileImageChip('modify', '/dev-preview/alice-scene1.jpg',   '/dev-preview/alice-scene2.jpg')}    entityColour="#6ea4ff" />
          <ChangeSubChip chip={profileImageChip('remove', '/dev-preview/alice-scene2.jpg',   null)}                                entityColour="#6ea4ff" />
        </div>
      </Section>

      <Section title="Colour change">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={colourChip('add',    null,       '#ec4899')} />
          <ChangeSubChip chip={colourChip('modify', '#6ea4ff',  '#ec4899')} />
          <ChangeSubChip chip={colourChip('remove', '#ec4899',  null)} />
        </div>
      </Section>

      <Section title="File attribute change (add / modify / remove)">
        <p className="text-[10px] text-zinc-500 mb-2">
          File-typed attributes (image / audio / video). Uses MediaRefVisual to render the
          appropriate thumbnail or emoji per file type. The ∅ symbol replaces the new slot
          when the modification clears the attribute. Image variants use real avatars from
          <code>frontend/public/dev-preview/</code>.
        </p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={fileAttrChip('add',    null,                              '/dev-preview/bob-baseline.jpg')} entityColour="#f87171" />
          <ChangeSubChip chip={fileAttrChip('modify', '/dev-preview/bob-baseline.jpg',   '/dev-preview/bob-scene1.jpg')}   entityColour="#f87171" />
          <ChangeSubChip chip={fileAttrChip('modify', '/dev-preview/bob-scene1.jpg',     null)}                            entityColour="#f87171" />
          <ChangeSubChip chip={fileAttrChip('remove', '/dev-preview/candy-baseline.jpg', null)}                            entityColour="#a855f7" />
        </div>
      </Section>

      <Section title="Attribute rename">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={{ action: 'rename', field: 'Title', newValue: 'Rank' }} />
          <ChangeSubChip chip={{ action: 'rename', field: 'OldName', newValue: null }} />
        </div>
      </Section>

      <Section title="List attribute add (initial list)">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={{ action: 'add', field: 'Tags', isListAttribute: true, initialList: ['noble', 'royal', 'aged'] }} />
          <ChangeSubChip chip={{ action: 'add', field: 'Allies', isListAttribute: true, isEntityList: true, initialList: ['mock-alice', 'mock-bob'] }} />
        </div>
      </Section>

      <Section title="List change ops (list_change)">
        <p className="text-[10px] text-zinc-500 mb-2">
          One chip per list attribute, multiple ops inside. Each op is an add / remove
          of a single item. Works for both text_list and entity_list attribute types.
        </p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={{
            action: 'list_change', field: 'Tags',
            listOps: [{ type: 'add', value: 'cursed' }, { type: 'remove', value: 'royal' }],
          }} />
          <ChangeSubChip chip={{
            action: 'list_change', field: 'Allies',
            isEntityList: true,
            listOps: [{ type: 'add', value: 'mock-bob' }, { type: 'remove', value: 'mock-alice' }],
          }} />
        </div>
      </Section>

      <Section title="With dismiss button (hover to reveal)">
        <p className="text-[10px] text-zinc-500 mb-2">The hover-revealed <code>−</code> button strips the chain entry from the carrier ref.</p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={titleAttrChip('modify', 'Princess', 'Queen')} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title="With Add Knowledge button (Phase 1.21k — hover to reveal)">
        <p className="text-[10px] text-zinc-500 mb-2">
          The hover-revealed composite glyph (<code>✚</code> + Knowledge icon) opens
          the <code>AddKnowledgeFromChangePopover</code> with two options: make a
          new Knowledge from this change, or attach to an existing Knowledge.
          Wired on the on-canvas SceneNode / EntityNode chips and on the sidebar
          &quot;Changes at this point&quot; subchips via <code>ChangesSummarySection</code>.
        </p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={titleAttrChip('modify', 'Princess', 'Queen')} onAddKnowledge={() => console.log('add knowledge clicked')} />
          <ChangeSubChip chip={titleAttrChip('add', null, 'Knight')} onAddKnowledge={() => console.log('add knowledge clicked')} />
        </div>
      </Section>

      <Section title="With both dismiss + Add Knowledge buttons (hover to reveal)">
        <p className="text-[10px] text-zinc-500 mb-2">When both handlers are wired, the two buttons stack at the right end of the chip.</p>
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip
            chip={titleAttrChip('modify', 'Princess', 'Queen')}
            onDismiss={() => {}}
            onAddKnowledge={() => console.log('add knowledge clicked')}
          />
        </div>
      </Section>

      <Section title="Review-flagged (upstream change pending review)">
        <div className="space-y-1 max-w-[420px]">
          <ChangeSubChip chip={titleAttrChip('modify', 'Princess', 'Queen')} reviewFlagged />
        </div>
      </Section>
    </section>
  )
}

// ── 2. Awareness sub-chips ───────────────────────────────────────────
function AwarenessSubChipsSection() {
  const mockEntities = [
    { id: 'alice', type: 'character', name: 'Alice', colour: '#6ea4ff', attributes: [{ id: 'attr-age', name: 'Age', attribute_type: 'text', value: '32' }] },
    { id: 'cabal', type: 'faction',   name: 'Cabal', colour: '#b87cff', attributes: [] },
    { id: 'sword', type: 'item',      name: 'Sword', colour: '#e3a55c', attributes: [{ id: 'attr-mat', name: 'Material', attribute_type: 'text', value: 'Folded steel that has been blessed by the high priest' }] },
  ]
  const getEntity = (id) => mockEntities.find((e) => e.id === id) || null
  const mockRelationship = { id: 'rel-1', name: 'The Conspiracy' }
  const getRelationship = (id) => (id === 'rel-1' ? mockRelationship : null)
  const mockKnowledge = { id: 'k-1', name: 'LostHeir', colour: '#b89968' }
  const getKnowledge = (id) => (id === 'k-1' ? mockKnowledge : null)

  const aliasScale = [0, 1, 2, 3]
  const binaryScale = [0, 3]

  function rec(kind, level, extras = {}) {
    return { kind, level, changeId: `${kind}-${level}`, ...extras }
  }

  const rowsByKind = [
    {
      title: 'Entity existence (binary scale)',
      desc: 'Observer became aware that an entity exists. Levels: 0 unaware, 3 aware.',
      records: binaryScale.map((lvl) => rec('entity_existence', lvl, { targetEntityId: 'alice' })),
    },
    {
      title: 'Canonical name (4-level scale)',
      desc: "Observer learned (or explicitly does not know) the entity's canonical name. Always shows the name value.",
      records: aliasScale.map((lvl) => rec('entity_name', lvl, { targetEntityId: 'alice' })),
    },
    {
      title: 'Alias (4-level scale)',
      desc: 'Observer learned an alias of an entity. Always shows the alias value.',
      records: aliasScale.map((lvl) => rec('alias', lvl, { targetEntityId: 'alice', aliasValue: 'Ali' })),
    },
    {
      title: 'Attribute',
      desc: 'Observer became aware of an attribute value. At level 0/1 the value is hidden (observer does not know it). At level 2/3 the value is shown.',
      records: aliasScale.map((lvl) => rec('attribute', lvl, { targetEntityId: 'alice', attributeId: 'attr-age' })),
    },
    {
      title: 'Attribute with long value (24-char truncation)',
      desc: 'Long values truncate with an ellipsis so sub-chip width stays bounded.',
      records: aliasScale.map((lvl) => rec('attribute', lvl, { targetEntityId: 'sword', attributeId: 'attr-mat' })),
    },
    {
      title: 'Relationship (binary scale)',
      desc: 'Observer became aware of a relationship.',
      records: binaryScale.map((lvl) => rec('relationship', lvl, { relationshipId: 'rel-1' })),
    },
    {
      title: 'Knowledge (4-level scale)',
      desc: 'Observer became aware of a Knowledge node.',
      records: aliasScale.map((lvl) => rec('knowledge', lvl, { knowledgeId: 'k-1', knowledge: mockKnowledge })),
    },
  ]

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Awareness sub-chips</h3>
        <p className="text-[10px] text-zinc-500">
          Renders inside the "Awareness" sub-chip section on an observer entity's chip
          at a scene via <code>AwarenessSubChip</code>. Every kind × level combo.
        </p>
      </div>

      {rowsByKind.map((row) => (
        <Section key={row.title} title={row.title}>
          <p className="text-[10px] text-zinc-500 mb-2">{row.desc}</p>
          <div className="space-y-1 max-w-[420px]">
            {row.records.map((r) => (
              <div key={r.changeId}>
                <AwarenessSubChip
                  record={r}
                  getEntity={getEntity}
                  getRelationship={getRelationship}
                  getKnowledge={getKnowledge}
                />
              </div>
            ))}
          </div>
        </Section>
      ))}
    </section>
  )
}

// ── 3. Relationship-on-entity-chip presence ──────────────────────────
function RelationshipSubChipsSection() {
  const allEntities = [
    { id: 'alice', type: 'character', name: 'Alice', colour: '#6ea4ff', profile_image_ref: null },
    { id: 'bob',   type: 'character', name: 'Bob',   colour: '#f87171', profile_image_ref: null },
  ]
  const mockRel = {
    id: 'rel-1',
    entity_a_id: 'alice',
    entity_b_id: 'bob',
    entity_a_description: 'wife',
    entity_b_description: 'husband',
  }

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Relationship presence on entity chips</h3>
        <p className="text-[10px] text-zinc-500">
          Renders on an entity chip when that entity participates in a relationship,
          via <code>RelationshipSubChip</code>. Variants: existing (no action), add, modify, remove.
        </p>
      </div>

      <Section title="Existing (no action) — Bob's chip showing his relationship to Alice">
        <div className="space-y-1 max-w-[420px]">
          <RelationshipSubChip relationship={mockRel} ownerEntityId="bob" allEntities={allEntities} />
        </div>
      </Section>

      <Section title="Add / modify / remove">
        <div className="space-y-1 max-w-[420px]">
          <RelationshipSubChip relationship={mockRel} changeType="add" ownerEntityId="bob" allEntities={allEntities} />
          <RelationshipSubChip relationship={mockRel} changeType="modify" ownerEntityId="bob" allEntities={allEntities} descChange="ex-husband" oldDesc="husband" />
          <RelationshipSubChip relationship={mockRel} changeType="remove" ownerEntityId="bob" allEntities={allEntities} />
        </div>
      </Section>
    </section>
  )
}

// ── 4. Relationship change events on relationship chips ──────────────
function RelChangeChipsSection() {
  const allEntities = [
    { id: 'alice', type: 'character', name: 'Alice', colour: '#6ea4ff', profile_image_ref: null },
    { id: 'bob',   type: 'character', name: 'Bob',   colour: '#f87171', profile_image_ref: null },
  ]
  const getEntity = (id) => allEntities.find((e) => e.id === id) || null

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Relationship change events (on relationship chips)</h3>
        <p className="text-[10px] text-zinc-500">
          Per-event mutation chips inside a relationship chip. Layout convention for
          participant-scoped value changes: <code>[icon] [object badge] · [field] : [old strike] → [new]</code>.
          Container-wide changes (existence / hierarchy / name) use the field-name-first shape.
        </p>
      </div>

      <Section title="Participant join / leave">
        <div className="space-y-1 max-w-[420px]">
          <RelChangeChip change={{ type: 'participant', action: 'join', entity_id: 'alice' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'participant', action: 'leave', entity_id: 'alice' }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title="Role / Perception / Alias modify (with strikethrough inherited value)">
        <div className="space-y-1 max-w-[420px]">
          <RelChangeChip change={{ type: 'role', action: 'modify', entity_id: 'alice', new_value: 'Enemy', old_value: 'Friend' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'perception', action: 'modify', entity_id: 'alice', new_value: 'wary', old_value: 'trusting' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'alias', action: 'modify', entity_id: 'alice', new_value: 'Mistress', old_value: 'Lady' }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title="Role modify with no inherited value (creation-node baseline synthesis)">
        <p className="text-[10px] text-zinc-500 mb-2">At the creation node, baseline <code>participant_roles</code> entries synthesize as modify chips with <code>old_value: null</code>.</p>
        <div className="space-y-1 max-w-[420px]">
          <RelChangeChip change={{ type: 'role', action: 'modify', entity_id: 'alice', new_value: 'Friend', old_value: null }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title="Container-wide changes (field-name-first fallback)">
        <div className="space-y-1 max-w-[420px]">
          <RelChangeChip change={{ type: 'existence', action: 'activate' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'existence', action: 'deactivate' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'hierarchy', action: 'modify' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'name', action: 'modify', new_value: 'The Cabal', old_value: 'The Conspiracy' }} getEntity={getEntity} />
          <RelChangeChip change={{ type: 'description', action: 'modify', new_value: 'A secret society devoted to undermining the crown.', old_value: 'A loose group of dissidents.' }} getEntity={getEntity} />
        </div>
      </Section>
    </section>
  )
}

// ── 5. Sidebar relationship-change rows ──────────────────────────────
function SidebarRelationshipChangeChipsSection() {
  const allEntities = [
    { id: 'alice', type: 'character', name: 'Alice', colour: '#6ea4ff', profile_image_ref: null },
    { id: 'bob',   type: 'character', name: 'Bob',   colour: '#f87171', profile_image_ref: null },
  ]

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Sidebar relationship-change rows</h3>
        <p className="text-[10px] text-zinc-500">
          Renders in the entity Detail Panel's "Changes at this point" section via
          {' '}<code>RelationshipChangeChip</code>. Sidebar density (16px avatar);
          partner entity's profile image and entity-coloured name lead.
        </p>
      </div>

      <Section title="Add / modify / remove">
        <div className="space-y-1 max-w-[420px]">
          <RelationshipChangeChip chip={{ action: 'add', relEntityId: 'alice', field: 'Alice' }} allEntities={allEntities} />
          <RelationshipChangeChip chip={{ action: 'modify', relEntityId: 'alice', field: 'Alice', oldValue: 'wife', newValue: 'ex-wife' }} allEntities={allEntities} />
          <RelationshipChangeChip chip={{ action: 'remove', relEntityId: 'alice', field: 'Alice' }} allEntities={allEntities} />
        </div>
      </Section>
    </section>
  )
}

// ── 6. Relationship-history chips (sidebar rows + canvas entity-origin "+ JOINED") ───
function SidebarRelationshipHistoryChipsSection() {
  const allEntities = [
    { id: 'alice', type: 'character', name: 'Alice', colour: '#6ea4ff', profile_image_ref: '/dev-preview/alice-baseline.jpg' },
    { id: 'bob',   type: 'character', name: 'Bob',   colour: '#f87171', profile_image_ref: '/dev-preview/bob-baseline.jpg' },
    { id: 'candy', type: 'character', name: 'Candy', colour: '#a855f7', profile_image_ref: '/dev-preview/candy-baseline.jpg' },
  ]
  const getEntity = (id) => allEntities.find((e) => e.id === id) || null
  const namedRel = {
    id: 'rel-1',
    name: 'The Conspiracy',
    history: { participant_changes: [{ action: 'join', entity_id: 'alice' }, { action: 'join', entity_id: 'bob' }] },
  }
  const datingRel = {
    id: 'rel-dating',
    name: 'Dating',
    history: { participant_changes: [{ action: 'join', entity_id: 'candy' }, { action: 'join', entity_id: 'bob' }] },
  }
  const cabalRel = {
    id: 'rel-cabal',
    name: 'The Cabal',
    history: { participant_changes: [{ action: 'join', entity_id: 'alice' }, { action: 'join', entity_id: 'bob' }, { action: 'join', entity_id: 'candy' }] },
  }
  const unnamedRel = {
    id: 'rel-2',
    name: '',
    history: { participant_changes: [{ action: 'join', entity_id: 'alice' }, { action: 'join', entity_id: 'bob' }] },
  }

  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Relationship-history chips</h3>
        <p className="text-[10px] text-zinc-500">
          Single component <code>RelationshipHistoryChangeChip</code> covers two host
          contexts: the entity Detail Panel sidebar's "Relationship history" section
          AND the canvas entity-origin "+ JOINED &lt;relationship&gt;" aggregation. Pure-
          action chips (participant join/leave, existence start/end) use the full pill;
          value-bearing chips follow <code>[glyph] [relationship label] · [field] :
          [old strike] → [new]</code>. The canvas variant adds a trailing other-
          participant avatar row via the optional <code>otherParticipantIds</code> prop.
        </p>
      </div>

      <Section title="Pure-action chips (participant join / leave + existence start / end)">
        <div className="space-y-1 max-w-[480px]">
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'participant', action: 'join', entity_id: 'alice' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'participant', action: 'leave', entity_id: 'alice' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'existence', action: 'activate' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'existence', action: 'deactivate' } }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title="Value-bearing chips (perception / alias / role / hierarchy / name)">
        <div className="space-y-1 max-w-[480px]">
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'role', action: 'modify', entity_id: 'alice', new_value: 'Enemy', old_value: 'Friend' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'perception', action: 'modify', entity_id: 'alice', new_value: 'wary', old_value: 'trusting' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'alias', action: 'modify', entity_id: 'alice', new_value: 'Mistress', old_value: 'Lady' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'name', action: 'modify', new_value: 'The Cabal', old_value: 'The Conspiracy' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'description', action: 'modify', new_value: 'A secret society devoted to undermining the crown.', old_value: 'A loose group of dissidents.' } }} getEntity={getEntity} />
          <RelationshipHistoryChangeChip entry={{ relationship: namedRel, change: { type: 'hierarchy', action: 'modify' } }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title="Unnamed relationship (participants-fallback label)">
        <div className="space-y-1 max-w-[480px]">
          <RelationshipHistoryChangeChip entry={{ relationship: unnamedRel, change: { type: 'role', action: 'modify', entity_id: 'alice', new_value: 'Enemy' } }} getEntity={getEntity} />
        </div>
      </Section>

      <Section title='Canvas entity-origin "+ JOINED" aggregation (with trailing avatar row)'>
        <p className="text-[10px] text-zinc-500 mb-2">
          Same component, with <code>otherParticipantIds</code> + <code>allEntities</code>
          passed in to render the trailing avatar row. Up to 3 inline, then <code>+N</code>.
        </p>
        <div className="space-y-1 max-w-[480px]">
          <RelationshipHistoryChangeChip
            entry={{ relationship: datingRel, change: { type: 'participant', action: 'join', entity_id: 'candy' } }}
            getEntity={getEntity}
            otherParticipantIds={['bob']}
            allEntities={allEntities}
          />
          <RelationshipHistoryChangeChip
            entry={{ relationship: cabalRel, change: { type: 'participant', action: 'join', entity_id: 'alice' } }}
            getEntity={getEntity}
            otherParticipantIds={['bob', 'candy']}
            allEntities={allEntities}
          />
          <RelationshipHistoryChangeChip
            entry={{ relationship: unnamedRel, change: { type: 'participant', action: 'join', entity_id: 'alice' } }}
            getEntity={getEntity}
            otherParticipantIds={['bob']}
            allEntities={allEntities}
          />
        </div>
      </Section>
    </section>
  )
}

// ── Nest ───────────────────────────────────────────────────────────────
// One slot per implemented effect. Empty dashed outline by default;
// fills with the effect's signature colour once it has been activated
// this session (registry resets on reload). Subscribes to the shared
// session-fired registry so updates appear instantly when an egg
// fires elsewhere in the app — no polling.
//
// `id` is the registry key each egg writes via `markEggFired(id)`.
// `colour` is the egg's signature fill colour (matches the spec doc).

const NEST_EGGS = [
  { id: 'coral',  colour: '#d97757' },
  { id: 'red',    colour: '#c8282c' },
  { id: 'silver', colour: '#c0c0c0' },
  { id: 'green',  colour: '#33ff33' },
  { id: 'orange', colour: '#ff9000' },
  { id: 'white',  colour: '#ffffff' },
  { id: 'black',  colour: '#000000', outlineColour: '#4a4a52' },
  { id: 'teal',   colour: '#5dd6c7' },
  { id: 'yellow', colour: '#f5d000' },
]

// Egg shape — slightly pointier at the top than a plain ellipse.
// 50×65 viewBox; the stroke breathes into the box without clipping.
const NEST_EGG_PATH = 'M 25 4 C 12 4, 4 22, 4 38 C 4 54, 13 62, 25 62 C 37 62, 46 54, 46 38 C 46 22, 38 4, 25 4 Z'

function NestEgg({ colour, outlineColour, fired }) {
  const stroke = fired ? (outlineColour || colour) : '#52525b'
  return (
    <svg width="64" height="84" viewBox="0 0 50 65" aria-hidden="true">
      <path
        d={NEST_EGG_PATH}
        fill={fired ? colour : 'transparent'}
        stroke={stroke}
        strokeWidth="1.5"
        strokeDasharray={fired ? 'none' : '3 3'}
      />
    </svg>
  )
}

// Phase 1.22j — Dev Settings page. Exposes opt-in toggles for
// experimental features that aren't ready to ship as easily-
// accessible UI affordances yet but whose implementation stays in
// the codebase. Currently: Tidy Wires button visibility on the
// canvas toolbar.
function DevSettingsPage() {
  const showTidy = useSettingsStore((s) => !!s.preferences?.dev_show_tidy_wires_button)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const saving = useSettingsStore((s) => s.saving)

  function toggleTidy() {
    // Presence-on / null-off semantics per the user-preferences
    // contract: when on we write `true`; when off we write null so
    // the field disappears from the saved JSON entirely. Both
    // states satisfy `!!preferences.dev_show_tidy_wires_button`.
    updatePreferences({ dev_show_tidy_wires_button: showTidy ? null : true })
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-zinc-100 mb-1">Dev Settings</h2>
        <p className="text-xs text-zinc-500">
          Opt-in toggles for experimental features. Changes persist to <code>preferences/user_preferences.json</code> immediately.
        </p>
      </div>

      <section className="border border-zinc-700 rounded p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-200 font-medium">Show Tidy Wires button</div>
            <p className="text-xs text-zinc-500 mt-1">
              Adds a small Tidy Wires button next to the canvas <span className="text-zinc-400">+</span> button. Reorganises wires into right-angle routes when clicked.
              <span className="block mt-1 text-amber-400/80">
                Experimental — current implementation produces inconsistent results and isn't shippable yet. The feature stays in the codebase for ongoing iteration.
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={toggleTidy}
            disabled={saving}
            className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
              showTidy ? 'bg-accent-600' : 'bg-zinc-700'
            } ${saving ? 'opacity-60' : ''}`}
            title={showTidy ? 'Click to hide the Tidy Wires button' : 'Click to show the Tidy Wires button on the canvas toolbar'}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full bg-zinc-100"
              style={{
                left: showTidy ? 22 : 2,
                transition: 'left 0.15s ease-out',
              }}
            />
          </button>
        </div>
      </section>
    </div>
  )
}

function Phase1_23TimePage() {
  // Demo 1: simple two-stop carousel.
  const [twoActive, setTwoActive] = useState('a')
  const [twoDraftA, setTwoDraftA] = useState('')
  const [twoDraftB, setTwoDraftB] = useState('')
  const [twoSaved, setTwoSaved] = useState(null)
  function saveTwo() {
    const value = twoActive === 'a' ? twoDraftA : twoDraftB
    setTwoSaved({ tier: twoActive, value })
  }

  // Demo 2: three-stop carousel exercising per-tier draft preservation.
  // Three different widget shapes per tier so the per-tier draft model
  // is visible: a button row, a number input, and a text input.
  const [threeActive, setThreeActive] = useState('broad')
  const [draftBroad, setDraftBroad] = useState('day')
  const [draftLabelled, setDraftLabelled] = useState('')
  const [draftExact, setDraftExact] = useState('')
  const [threeSaved, setThreeSaved] = useState(null)
  function saveThree() {
    const value =
      threeActive === 'broad'    ? draftBroad
    : threeActive === 'labelled' ? draftLabelled
    : threeActive === 'exact'    ? draftExact
    : null
    setThreeSaved({ tier: threeActive, value })
  }
  function discardOthers() {
    if (threeActive !== 'broad')    setDraftBroad('day')
    if (threeActive !== 'labelled') setDraftLabelled('')
    if (threeActive !== 'exact')    setDraftExact('')
  }

  return (
    <div className="text-sm text-zinc-200">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Phase 1.23 — Time tracking primitives</h2>
      <p className="text-xs text-zinc-500 mb-6">
        Test surface for the reusable <code className="text-zinc-400">&lt;GranularityCarousel&gt;</code> primitive
        used by Time of Day, Day, and Scene Duration. The primitive owns rotation UI and
        active-tier visibility only; per-tier draft values live in the parent so each tier
        can render its own widget shape.
      </p>

      <Section title="Two-stop carousel">
        <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 space-y-3">
          <GranularityCarousel
            tiers={[
              { id: 'a', label: 'Stop A' },
              { id: 'b', label: 'Stop B' },
            ]}
            activeTierId={twoActive}
            onActiveTierChange={setTwoActive}
          >
            {twoActive === 'a' && (
              <input
                type="text"
                value={twoDraftA}
                onChange={(e) => setTwoDraftA(e.target.value)}
                placeholder="Draft for Stop A"
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-400"
              />
            )}
            {twoActive === 'b' && (
              <input
                type="text"
                value={twoDraftB}
                onChange={(e) => setTwoDraftB(e.target.value)}
                placeholder="Draft for Stop B"
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-400"
              />
            )}
          </GranularityCarousel>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveTwo}
              className="text-xs px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded"
            >
              Save (active tier only)
            </button>
            {twoSaved && (
              <div className="text-[11px] text-zinc-300 font-mono">
                Saved: <span className="text-accent-400">{twoSaved.tier}</span> = {JSON.stringify(twoSaved.value)}
              </div>
            )}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono leading-snug">
            session drafts: {`{ a: ${JSON.stringify(twoDraftA)}, b: ${JSON.stringify(twoDraftB)} }`}
          </div>
        </div>
      </Section>

      <Section title="Three-stop carousel — per-tier draft preservation">
        <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 space-y-3">
          <GranularityCarousel
            tiers={[
              { id: 'broad', label: 'Broad' },
              { id: 'labelled', label: 'Labelled' },
              { id: 'exact', label: 'Exact' },
            ]}
            activeTierId={threeActive}
            onActiveTierChange={setThreeActive}
          >
            {threeActive === 'broad' && (
              <div className="flex items-center gap-2">
                {['day', 'night'].map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setDraftBroad(opt)}
                    className={`text-[11px] px-3 py-1 rounded uppercase tracking-wider ${
                      draftBroad === opt
                        ? 'bg-accent-600 text-white'
                        : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
            {threeActive === 'labelled' && (
              <input
                type="text"
                value={draftLabelled}
                onChange={(e) => setDraftLabelled(e.target.value)}
                placeholder="e.g. Late Morning"
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-400 w-48"
              />
            )}
            {threeActive === 'exact' && (
              <input
                type="text"
                value={draftExact}
                onChange={(e) => setDraftExact(e.target.value)}
                placeholder="HH:MM"
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-400 w-24 font-mono"
              />
            )}
          </GranularityCarousel>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={saveThree}
              className="text-xs px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded"
            >
              Save (active tier only)
            </button>
            <button
              type="button"
              onClick={discardOthers}
              className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
              title="Demonstrates that on Save the inactive tiers' drafts are discarded"
            >
              Simulate Save: clear inactive drafts
            </button>
            {threeSaved && (
              <div className="text-[11px] text-zinc-300 font-mono">
                Saved: <span className="text-accent-400">{threeSaved.tier}</span> = {JSON.stringify(threeSaved.value)}
              </div>
            )}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono leading-snug space-y-0.5">
            <div>active tier: <span className="text-zinc-300">{threeActive}</span></div>
            <div>session drafts:</div>
            <div className="pl-3">
              broad:    <span className={threeActive === 'broad' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(draftBroad)}</span>
            </div>
            <div className="pl-3">
              labelled: <span className={threeActive === 'labelled' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(draftLabelled)}</span>
            </div>
            <div className="pl-3">
              exact:    <span className={threeActive === 'exact' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(draftExact)}</span>
            </div>
          </div>
          <p className="text-[10px] text-zinc-500 italic leading-relaxed">
            Try: type a value at one tier, rotate to another, type a different value, then rotate back —
            the original value is still there. On real Save (the Time Modal), only the active tier's value
            persists; the rest discard. The "Simulate Save" button above shows that in this preview.
          </p>
        </div>
      </Section>

      <Section title="With hint text">
        <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3">
          <GranularityCarousel
            tiers={[
              { id: 'one', label: 'Tier 1' },
              { id: 'two', label: 'Tier 2' },
              { id: 'three', label: 'Tier 3' },
            ]}
            activeTierId="two"
            onActiveTierChange={() => {}}
            hint="Retained value at adjacent tier — rotate to view"
          >
            <div className="text-xs text-zinc-400 italic">(active tier widget renders here)</div>
          </GranularityCarousel>
        </div>
      </Section>

      <TimeOfDayCarouselDemo />

      <TimeOfDayCarouselTiltedDemo />

      <TimeOfDayIconsCatalogue />

      <DayCarouselsDemo />

      <SceneDurationCarouselDemo />

      <OpenSceneTimeModalDemo />

      <SeasonIconsCatalogue />

      <GapPhrasingMatrix />

      <GapPhrasingMatrixWithConstraints />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
//  Gap-phrasing matrix — structural skeleton
//
//  Phase 0: enumerate every granularity dimension that flows into the
//  gap-phrasing computation, then lay out the prior × current TOD
//  matrix structurally so the writer can review coverage BEFORE any
//  phrasing decisions get baked in. Cells are intentionally empty
//  for now; each shows just the looser tier so the tier-matching
//  logic is visible.
//
//  Granularity dimensions affecting phrasing:
//
//    1. Time of Day (per scene)
//       - none (no TOD pinned)
//       - broad: 2 values (Day, Night)
//       - labelled: 15 values (Pre-Dawn, Dawn, Sunrise, Early Morning,
//         Morning, Late Morning, Noon, Afternoon, Late Afternoon,
//         Sunset, Evening, Dusk, Early Night, Night, Midnight)
//       - exact: HH:MM (continuous; sample at boundaries)
//
//    2. Date (per scene; orthogonal to TOD)
//       - none
//       - weekday only
//       - month only
//       - month + day
//       - weekday + month
//       - weekday + month + day
//       - weekday + day-of-month (rare)
//
//    3. Season (per scene)
//       - none / one of Spring / Summer / Fall / Winter / Wet / Dry
//       - Non-constraining context; does not affect floor or gap math.
//
//    4. Scene Duration (prior scene only — defines prior_end)
//       - ambiguous (null contribution)
//       - numeric: minutes / hours / days, with optional value
//       - all_period
//       - span (start period → end period)
//       - all_day with variants (all_day, all_night, until_next_evening,
//         legacy until_next_day)
//
//    5. Gap Extension (current scene only)
//       - none (effective = floor)
//       - TimeDelta with unit minutes/hours/days/weeks and value
//       - sign: positive (forward) or negative (Allow Negative Time)
//
//  The grid below covers axis (1) — TOD tier × value combinations
//  for both prior and current. Date / Duration / Gap-Extension
//  variants will need their own matrices once the TOD axis is
//  signed off; they multiply combinatorially with TOD.
// ──────────────────────────────────────────────────────────────────
// Shared TOD axis enumeration used by both gap-phrasing matrices.
// Every distinct shape a scene's TOD pin can take.
const _GAP_MATRIX_TOD_OPTIONS = [
  { id: 't-none',         short: '(no TOD)',            tier: null       },
  { id: 't-broad-day',    short: 'broad: Day',          tier: 'broad'    },
  { id: 't-broad-night',  short: 'broad: Night',        tier: 'broad'    },
  { id: 't-lbl-predawn',  short: 'lbl: Pre-Dawn',       tier: 'labelled' },
  { id: 't-lbl-dawn',     short: 'lbl: Dawn',           tier: 'labelled' },
  { id: 't-lbl-sunrise',  short: 'lbl: Sunrise',        tier: 'labelled' },
  { id: 't-lbl-emorn',    short: 'lbl: Early Morning',  tier: 'labelled' },
  { id: 't-lbl-morn',     short: 'lbl: Morning',        tier: 'labelled' },
  { id: 't-lbl-lmorn',    short: 'lbl: Late Morning',   tier: 'labelled' },
  { id: 't-lbl-noon',     short: 'lbl: Noon',           tier: 'labelled' },
  { id: 't-lbl-aft',      short: 'lbl: Afternoon',      tier: 'labelled' },
  { id: 't-lbl-laft',     short: 'lbl: Late Afternoon', tier: 'labelled' },
  { id: 't-lbl-sunset',   short: 'lbl: Sunset',         tier: 'labelled' },
  { id: 't-lbl-eve',      short: 'lbl: Evening',        tier: 'labelled' },
  { id: 't-lbl-dusk',     short: 'lbl: Dusk',           tier: 'labelled' },
  { id: 't-lbl-enight',   short: 'lbl: Early Night',    tier: 'labelled' },
  { id: 't-lbl-night',    short: 'lbl: Night',          tier: 'labelled' },
  { id: 't-lbl-mid',      short: 'lbl: Midnight',       tier: 'labelled' },
  { id: 't-exact-0300',   short: 'exact: 03:00',        tier: 'exact'    },
  { id: 't-exact-0830',   short: 'exact: 08:30',        tier: 'exact'    },
  { id: 't-exact-1200',   short: 'exact: 12:00',        tier: 'exact'    },
  { id: 't-exact-1400',   short: 'exact: 14:00',        tier: 'exact'    },
  { id: 't-exact-1800',   short: 'exact: 18:00',        tier: 'exact'    },
  { id: 't-exact-2100',   short: 'exact: 21:00',        tier: 'exact'    },
  { id: 't-exact-2330',   short: 'exact: 23:30',        tier: 'exact'    },
]

function _looserTierForMatrix(a, b) {
  const RANK = { broad: 1, labelled: 2, exact: 3 }
  if (!a) return b
  if (!b) return a
  return RANK[a] < RANK[b] ? a : b
}

// Build a synthetic scene-data object for a TOD option so sceneBucket
// + sceneStartMinutesOfDay can derive bucket / minutes for the cell.
function _scenefyOption(opt) {
  if (!opt.tier) return { time_of_day_tier: null }
  if (opt.tier === 'broad') {
    return { time_of_day_tier: 'broad', time_of_day_broad: opt.short.endsWith('Day') ? 'day' : 'night' }
  }
  if (opt.tier === 'labelled') {
    const label = opt.short.replace(/^lbl: /, '')
    return { time_of_day_tier: 'labelled', time_of_day_labelled: label }
  }
  if (opt.tier === 'exact') {
    const hhmm = opt.short.replace(/^exact: /, '')
    return { time_of_day_tier: 'exact', time_of_day_exact: hhmm }
  }
  return { time_of_day_tier: null }
}

// Inner table rendering shared by both gap-phrasing matrices below.
// `gapSamples` is an array of `{ mins, label }` — each sample renders
// one row inside every cell so the writer can scan how the phrasing
// scales across multiple gap magnitudes (sub-day, 1 day, 5 days, weeks,
// months, years) for the same prior×current pair.
function GapMatrixTable({ gapSamples }) {
  const samples = gapSamples ?? [{ mins: 6 * 60, label: '6 hr' }]
  return (
    <div className="overflow-auto">
      <table className="text-[10px] border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 bg-zinc-900 px-2 py-1 text-zinc-400 uppercase tracking-wider text-[9px] border-r border-b border-zinc-700/60">
              Prior \ Current
            </th>
            {_GAP_MATRIX_TOD_OPTIONS.map((s) => (
              <th
                key={s.id}
                className="bg-zinc-900 px-2 py-1 text-zinc-200 text-[10px] tracking-wider border-b border-zinc-700/60 whitespace-nowrap"
              >
                {s.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {_GAP_MATRIX_TOD_OPTIONS.map((priorS) => {
            const priorScene   = _scenefyOption(priorS)
            const priorBucket  = sceneBucket(priorScene)
            return (
              <tr key={priorS.id}>
                <th className="sticky left-0 z-10 bg-zinc-900 px-2 py-1 text-zinc-200 text-[10px] tracking-wider text-left border-r border-zinc-700/60 whitespace-nowrap">
                  {priorS.short}
                </th>
                {_GAP_MATRIX_TOD_OPTIONS.map((curS) => {
                  const curScene      = _scenefyOption(curS)
                  const currentBucket = sceneBucket(curScene)
                  const tier = _looserTierForMatrix(priorS.tier, curS.tier)
                  return (
                    <td
                      key={curS.id}
                      className="align-top px-2 py-1 border-b border-r border-zinc-800 bg-zinc-900/40"
                    >
                      <div className="flex flex-col gap-0.5">
                        {samples.map((g) => {
                          // Day shift = how many calendar days the
                          // gap actually crosses. Computed from the
                          // matrix's synthetic positions (prior_end
                          // at chain-day 0, current_start at the
                          // chain-day floor(gap_minutes / 1440)).
                          // formatGap uses this to decide same-day
                          // vs next-day vs N-days-later rather than
                          // approximating from gap_minutes alone.
                          const dayShift = Math.floor(g.mins / (24 * 60))
                          const phrase = formatGap(g.mins, 'compact-gap', {
                            tier,
                            priorBucket,
                            currentBucket,
                            dayShift,
                          })
                          return (
                            <div key={g.label} className="flex items-baseline gap-2">
                              <span className="text-zinc-500 w-10 flex-shrink-0">{g.label}</span>
                              <span className="text-zinc-200">{phrase || <span className="italic text-zinc-600">—</span>}</span>
                            </div>
                          )
                        })}
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function GapPhrasingMatrix() {
  // Scenario A — next-available slot. Single sub-day gap sample
  // representative of "current scene fits same day after prior".
  const samples = [
    { mins: 6 * 60, label: '6 hr' },
  ]
  return (
    <Section title="Gap phrasing matrix — Next-available slot">
      <p className="text-xs text-zinc-300 mb-3 leading-relaxed">
        <strong>Scenario A — next available slot.</strong> Current
        scene's TOD pin fits at-or-after the prior scene's end (no
        walker snap-forward triggered). Phrasing is what the writer
        reads when pins fit naturally in chain order. Cells render
        live via <code className="text-zinc-200">formatGap</code>{' '}
        — phrasing is template-driven (small set of base phrases
        with placeholders filled from the inputs), not a per-cell
        lookup.
      </p>

      <p className="text-[11px] text-zinc-400 italic mb-2 leading-snug">
        The exact-tier values shown (03:00, 08:30, 12:00, 14:00, 18:00,
        21:00, 23:30) are <em>examples only</em>: any HH:MM in those
        rows / columns produces equivalent phrasing because the
        bucket the time falls in drives the phrasing, not the literal
        value. Date / Weekday / Season / Scene Duration / Gap
        Extension are independent granularity dimensions that flow
        into the phrasing too; their matrices come next.
      </p>

      <GapMatrixTable gapSamples={samples} />
    </Section>
  )
}

function GapPhrasingMatrixWithConstraints() {
  // Scenario B — pushed forward by constraints. Multiple gap samples
  // because "pushed forward" doesn't mean a fixed magnitude — the
  // floor can push the current scene 1 day, 5 days, 8 weeks, months,
  // even years forward (Feb 29 cycle, weekday pin + large prior
  // duration, manual gap_extension, etc.). Each cell shows phrasing
  // at increasing magnitudes so the writer can verify the templates
  // scale across the range.
  const samples = [
    { mins: 24 * 60,            label: '1 day'  },
    { mins: 5 * 24 * 60,        label: '5 days' },
    { mins: 12 * 24 * 60,       label: '12 days' },
    { mins: 8 * 7 * 24 * 60,    label: '8 weeks' },
    { mins: 120 * 24 * 60,      label: '4 mths'  },
    { mins: 4 * 365 * 24 * 60,  label: '4 yrs'   },
  ]
  return (
    <Section title="Gap phrasing matrix — Pushed forward by constraints">
      <p className="text-xs text-zinc-300 mb-3 leading-relaxed">
        <strong>Scenario B — pushed forward.</strong> The walker
        snapped the current scene past the next-available slot to a
        further one (next day / 5 days / weeks / months / years out)
        because of large prior durations, weekday or date pins on
        the current scene, leap-year Feb 29 cycles, or manual{' '}
        <em>extra time since last scene</em> additions on the current
        scene. Each cell shows phrasing at six increasing magnitudes
        so the writer can verify the templates scale across the full
        range; the floor is not always "the next slot".
      </p>

      <p className="text-[11px] text-zinc-400 italic mb-2 leading-snug">
        Same row / column structure as Scenario A. The exact-tier
        values are <em>examples only</em> as in Scenario A. A 12-day
        push correctly reads as "12 days later" (or "12 days later,
        in the morning" when the current scene has a TOD bucket
        pinned), not "the next day". The reference table at{' '}
        <code className="text-zinc-200">utils/gapPhrasingMatrixData.js</code>{' '}
        captures an exhaustive 625-cell next-available + pushed-forward
        spread the agent produced; it's kept as a fixture for cross-
        checking template output, not as the runtime source.
      </p>

      <GapMatrixTable gapSamples={samples} />
    </Section>
  )
}

function SceneDurationCarouselDemo() {
  // Section 4 of the Time Modal will hold this. The carousel takes
  // a `startBucket` (one of the 5 period buckets) so the All-period
  // and Span stops can render their context-aware widgets. When
  // null, those stops are hidden — the writer hasn't pinned a start
  // Time of Day, so they aren't expressible.
  const [startTOD, setStartTOD] = useState(null)
  const [duration, setDuration] = useState({
    activeStop: 'ambiguous',
    drafts: {
      ambiguous:  {},
      minutes:    { value: null },
      hours:      { value: null },
      all_period: {},
      span:       { endPeriod: null },
      all_day:    {},
      days:       { value: null },
    },
  })
  const startBucket = timeOfDayLabelToBucket(startTOD)

  const TOD_OPTIONS = [
    null,
    'Pre-Dawn', 'Dawn', 'Sunrise',
    'Early Morning', 'Morning', 'Late Morning',
    'Noon', 'Afternoon', 'Late Afternoon',
    'Dusk', 'Evening', 'Sunset',
    'Early Night', 'Night', 'Midnight',
  ]

  const demoBg = '#27272a'
  return (
    <Section title="Scene Duration carousel (Phase 1.23 step 5)">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Seven stops in magnitude order from no commitment to largest:
        Ambiguous / Minutes / Hours / All <em>period</em> /
        <em>start → end</em> / All Day / Days. Numeric stops accept an
        optional value (magnitude-without-specifics is valid). The
        All-period and Span stops are context-aware: they're hidden
        when no start Time of Day is pinned, since the period name
        comes from that pin.
      </p>

      <div
        className="border border-zinc-700 rounded p-3 space-y-3"
        style={{ backgroundColor: demoBg }}
      >
        <div className="flex items-center gap-2 text-[11px] text-zinc-400">
          <span>Pinned start Time of Day:</span>
          <select
            value={startTOD ?? ''}
            onChange={(e) => setStartTOD(e.target.value || null)}
            className="h-6 text-[11px] rounded bg-zinc-900 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-sky-600 px-1"
          >
            {TOD_OPTIONS.map((label) => (
              <option key={label ?? '_null_'} value={label ?? ''}>
                {label ?? '(none)'}
              </option>
            ))}
          </select>
          <span className="text-zinc-600">
            → bucket: <span className="text-zinc-300">{startBucket ?? '—'}</span>
          </span>
        </div>

        <SceneDurationCarousel
          state={duration}
          onChange={setDuration}
          startBucket={startBucket}
        />

        <div className="text-[10px] text-zinc-500 font-mono leading-snug space-y-0.5">
          <div>active stop: <span className="text-zinc-300">{duration.activeStop}</span></div>
          <div>draft @ active: <span className="text-zinc-300">{JSON.stringify(duration.drafts[duration.activeStop])}</span></div>
        </div>

        <p className="text-[10px] text-zinc-500 italic leading-relaxed">
          Try: rotate to Hours, type 1.5 — magnitude with specifics.
          Rotate to Minutes — empty input (per-stop drafts; previous
          value not pre-filled). Set start TOD to Morning — All-period
          and Span stops appear. Set start TOD back to (none) — those
          two stops disappear; if active was on one of them, falls
          back to Ambiguous.
        </p>
      </div>

      <div className="text-[11px] text-zinc-500 italic mt-3 leading-snug">
        Period buckets: {PERIOD_BUCKETS.join(' / ')}. Tier-3 exact-clock
        and Tier-1 broad pins (Day / Night) aren't yet wired in this
        demo — only Tier-2 labels feed the start bucket.
      </div>
    </Section>
  )
}

function OpenSceneTimeModalDemo() {
  // Trigger the global Scene Time modal mounted in App.jsx so the
  // carousels can be evaluated in real modal context (sized inside
  // a 640 px-wide dark dialog with header + scrollable body +
  // Save/Cancel footer), not as flat dev-panel sections.
  const openSceneTimeModal = useUiStore((s) => s.openSceneTimeModal)
  return (
    <Section title="Scene Time modal — open in real modal shell">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Opens the actual Scene Time modal (the canonical editor that
        will eventually be triggered from each scene node). Sections 1
        and 3 are placeholders until the POV-chain time walker
        (step 7) and Time Since Last Scene field (step 6) land.
        Sections 2 (Time of Day + Season + Date) and 4 (Scene
        Duration) are wired now.
      </p>
      <button
        type="button"
        onClick={() => openSceneTimeModal(null)}
        className="text-xs px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded"
      >
        Open Scene Time modal
      </button>
    </Section>
  )
}

function SeasonIconsCatalogue() {
  const cal = getActiveCalendar()
  const naturalLabels = ['Seedling', 'Palm tree', 'Falling leaves', 'Snowflake']
  const mahjongLabels = [
    'Mahjong tile — Spring',
    'Mahjong tile — Summer',
    'Mahjong tile — Autumn',
    'Mahjong tile — Winter',
  ]
  return (
    <Section title="Season — icon set comparison">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Two candidate icon sets, each rendering in the season's accent
        colour at the live carousel size (14 px) and a scaled-up size
        (40 px) for shape review. Both sets use exact path data from
        the named Segoe UI Symbol glyphs (saved in <code>.References/</code>),
        embedded inline so they render identically on Windows / macOS /
        Linux / web — Segoe UI Symbol the font itself only ships with
        Windows.
      </p>

      <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">
        Set A — Seedling / Palm tree / Falling leaves / Snowflake
      </div>
      <div className="grid grid-cols-4 gap-3 mb-5">
        {cal.seasons.long.map((name, idx) => (
          <div
            key={idx}
            className="flex flex-col items-center gap-2 p-3 rounded-md bg-zinc-800/40 border border-zinc-700/60"
          >
            <div className="text-xs uppercase tracking-wider text-zinc-300">{name}</div>
            <div className="text-[10px] text-zinc-500 italic">{naturalLabels[idx]}</div>
            <div className="flex items-end gap-3">
              <div className="flex flex-col items-center gap-1">
                <SeasonGlyph index={idx} size={14} colour={SEASON_ACCENTS[idx]} />
                <div className="text-[9px] text-zinc-500">14 px</div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <SeasonGlyph index={idx} size={40} colour={SEASON_ACCENTS[idx]} />
                <div className="text-[9px] text-zinc-500">40 px</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">
        Set B — Mahjong tile glyphs (full Segoe glyph including kanji)
      </div>
      <div className="grid grid-cols-4 gap-3 mb-3">
        {cal.seasons.long.map((name, idx) => (
          <div
            key={idx}
            className="flex flex-col items-center gap-2 p-3 rounded-md bg-zinc-800/40 border border-zinc-700/60"
          >
            <div className="text-xs uppercase tracking-wider text-zinc-300">{name}</div>
            <div className="text-[10px] text-zinc-500 italic">{mahjongLabels[idx]}</div>
            <div className="flex items-end gap-3">
              <div className="flex flex-col items-center gap-1">
                <SeasonGlyphMahjong index={idx} size={14} colour={SEASON_ACCENTS[idx]} />
                <div className="text-[9px] text-zinc-500">14 px</div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <SeasonGlyphMahjong index={idx} size={40} colour={SEASON_ACCENTS[idx]} />
                <div className="text-[9px] text-zinc-500">40 px</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="text-[11px] text-zinc-500 italic leading-snug">
        Set A is the cleaner-at-small-sizes option — single-shape
        glyphs read instantly at 14 px. Set B carries cultural and
        seasonal cues but the kanji + tile outline + season indicator
        all bake into one combined path; at 14 px the tile-shape
        dominates and the season indicator gets tiny. To use Set B
        without the kanji, the SVGs would need editing in Inkscape
        first (path → break apart, delete the kanji subpaths, save).
      </div>

      <div className="text-[11px] uppercase tracking-wider text-zinc-400 mt-6 mb-2">
        Tropical Set — Wet / Dry seasons (DRAFT for v0.1.23.x)
      </div>
      <p className="text-[11px] text-zinc-400 leading-snug mb-3">
        Two extra season indices (4 = Wet, 5 = Dry) for non-temperate
        calendars. Bundled with the 4-season set so a 6-season
        SeasonRow can render them inline. Glyphs designed at 32×32
        viewBox to match the existing Segoe-derived 4-season glyphs
        in scale.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        {[
          { name: 'Wet',  natural: 'Three raindrops at a slight wind-driven slant.', accent: '#3b82f6', Icon: WetRaindrops },
          { name: 'Dry',  natural: 'Sun above a horizon line with cracks splitting the parched ground.', accent: '#d97706', Icon: DrySunCracks },
        ].map((season) => {
          const { name, natural, accent } = season
          // Icon is rendered as a JSX element below; bind it as a local so
          // it is recognised as used (the lint config does not count JSX
          // element-tag usage of destructured parameters).
          const Icon = season.Icon
          return (
          <div
            key={name}
            className="flex flex-col items-center gap-2 p-3 rounded-md bg-zinc-800/40 border border-zinc-700/60"
          >
            <div className="text-xs uppercase tracking-wider text-zinc-300">{name}</div>
            <div className="text-[10px] text-zinc-500 italic text-center">{natural}</div>
            <div className="flex items-end gap-3">
              <div className="flex flex-col items-center gap-1">
                <Icon size={14} colour={accent} />
                <div className="text-[9px] text-zinc-500">14 px</div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Icon size={32} colour={accent} />
                <div className="text-[9px] text-zinc-500">32 px</div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Icon size={64} colour={accent} />
                <div className="text-[9px] text-zinc-500">64 px</div>
              </div>
            </div>
            {/* Inverse / button-active preview — white glyph on accent fill,
                matching the SeasonRow active-button look. */}
            <div className="flex items-end gap-3 pt-2 border-t border-zinc-700/40 w-full justify-center">
              <div className="flex flex-col items-center gap-1">
                <div
                  className="w-16 h-16 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: accent, border: `1px solid ${accent}` }}
                >
                  <Icon size={32} colour="#fafafa" />
                </div>
                <div className="text-[9px] text-zinc-500">active state</div>
              </div>
            </div>
          </div>
          )
        })}
      </div>

      <div className="text-[11px] text-zinc-500 italic leading-snug">
        Wet uses a darker blue (#3b82f6) so the raindrops read
        distinctly from the existing winter blue. Dry uses ochre
        (#d97706) for parched-earth associations without colliding
        with summer's amber.
      </div>
    </Section>
  )
}

function DayCarouselsDemo() {
  // Section 2 of the Time Modal will hold three independent controls
  // alongside Time of Day: Season, and Date. Day-of-week is folded
  // into the Date carousel as its least-granular tier so the writer
  // can layer "Tuesday" on top of any more-precise pin if they want.
  const [season, setSeason]       = useState(null)
  const [weekStart, setWeekStart] = useState('sunday')
  const [date, setDate] = useState({
    enabled: { weekday: true, month: false, day: false },
    values:  { weekday: null, monthIdx: null, day: null },
  })

  const cal = getActiveCalendar()

  const dateSummary = (() => {
    const enabled = date.enabled ?? {}
    const v = date.values ?? {}
    const wk  = enabled.weekday && v.weekday  != null ? weekdayName(v.weekday) : null
    const mo  = enabled.month   && v.monthIdx != null ? monthName(v.monthIdx)  : null
    const day = enabled.day     && v.day      != null ? String(v.day)          : null
    const datePart = mo && day ? `${mo} ${day}` : (mo || day || null)
    const parts = [wk, datePart].filter(Boolean)
    return parts.length === 0 ? '(none)' : parts.join(', ')
  })()

  return (
    <Section title="Season + Date carousels (Phase 1.23 step 4)">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Section 2 of the Time Modal will hold these alongside the Time of
        Day carousel above. Season is its own button row (one per
        season, each with its own accent colour). The Date carousel has
        three tiers — Weekday only / Month + Weekday / Month + Day +
        Weekday — with the weekday pin carried forward across rotations.
        The day-of-month grid uses 10 columns, deliberately NOT seven,
        to avoid implying any Sun/Mon/Tue position the calendar can't
        actually compute without years.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-4">
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-zinc-400">Season</span>
          <SeasonRow value={season} onChange={setSeason} />
          <div className="text-[11px] text-zinc-500">
            Pinned: <span className="text-zinc-300">
              {season == null ? '(none)' : seasonName(season)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-zinc-400">Date</span>
            <label className="text-[11px] text-zinc-500 italic flex items-center gap-1">
              <input
                type="checkbox"
                checked={weekStart === 'monday'}
                onChange={(e) => setWeekStart(e.target.checked ? 'monday' : 'sunday')}
                className="accent-sky-600"
              />
              Monday-first
            </label>
          </div>
          <DateCarousel state={date} onChange={setDate} weekStart={weekStart} />
          <div className="text-[11px] text-zinc-500">
            Pinned: <span className="text-zinc-300">{dateSummary}</span>
          </div>
        </div>
      </div>

      <div className="text-[11px] text-zinc-500 italic leading-snug">
        Calendar source: <span className="text-zinc-400">Gregorian</span>
        {' · '}weekday count: <span className="text-zinc-400">{cal.weekdays.long.length}</span>
        {' · '}season count: <span className="text-zinc-400">{cal.seasons.long.length}</span>
        {' · '}month count: <span className="text-zinc-400">{cal.months.long.length}</span>
        . Custom calendars plug in via <code className="text-zinc-400">setActiveCalendar()</code>.
      </div>
    </Section>
  )
}

function TimeOfDayIconsCatalogue() {
  // Render two views: an isolated swatch + glyph for each cell, and a
  // scaled-up rendering so the icon shapes can be eyeballed at a size
  // bigger than the live gearshift uses. Useful for visual-consistency
  // review without the gearshift chrome around it.
  return (
    <Section title="Time of Day — icons & colours catalogue">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Per-cell glyph + colour swatch in isolation. The first row uses the
        live size (14 px); the second renders at 32 px for shape detail.
      </p>

      {/* Live-size strip */}
      <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 mb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Live size (14 px)</div>
        <div className="grid grid-cols-6 gap-3">
          {TIME_OF_DAY_LABELS.map((label) => {
            const v = CELL_VISUALS[label]
            if (!v) return null
            return (
              <div key={label} className="flex flex-col items-center gap-1">
                <svg width={14} height={14} viewBox="0 0 14 14" className="overflow-visible">
                  <CellGlyph base={v.base} modifier={v.modifier} colour={v.colour} size={14} dim={false} />
                </svg>
                <div
                  className="w-4 h-2 rounded-sm"
                  style={{ backgroundColor: v.colour }}
                  title={v.colour}
                />
                <div className="text-[10px] text-zinc-300 text-center leading-tight">{label}</div>
                <div className="text-[9px] text-zinc-500 font-mono">{v.colour}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Scaled-up strip for shape review */}
      <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 mb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Scaled-up (32 px)</div>
        <div className="grid grid-cols-6 gap-3">
          {TIME_OF_DAY_LABELS.map((label) => {
            const v = CELL_VISUALS[label]
            if (!v) return null
            return (
              <div key={`big-${label}`} className="flex flex-col items-center gap-1">
                <svg width={32} height={32} viewBox="0 0 32 32" className="overflow-visible">
                  <CellGlyph base={v.base} modifier={v.modifier} colour={v.colour} size={32} dim={false} />
                </svg>
                <div className="text-[10px] text-zinc-400 text-center leading-tight">{label}</div>
                <div className="text-[9px] text-zinc-500 font-mono">{v.base}{v.modifier !== 'plain' ? ' · ' + v.modifier : ''}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Unicode emoji comparison — shows how the candidate Unicode glyphs render on
          this machine. Three rows: default rendering, with VS-15 (︎) text-style
          request, and with `font-variant-emoji: text` CSS. Most browsers/OS will still
          render the emoji-codepoint chars in colour because emoji fonts ship colour
          glyphs without monochrome fallbacks. Useful for visual comparison. */}
      <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 mb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Unicode comparison (rendering on this machine)</div>
        <p className="text-[10px] text-zinc-500 italic mb-2 leading-snug">
          Most emoji codepoints render in colour regardless of font / variation-selector requests; the
          text-style chars (☀ ☽ ☾) are reliably monochrome. Custom SVG (above) is the only consistent
          monochrome path across platforms.
        </p>
        {(() => {
          const unicodes = [
            { ch: '☀', label: 'sun (text)' },
            { ch: '⛅', label: 'sun-cloud' },
            { ch: '🌄', label: 'sunrise-mtns' },
            { ch: '🌅', label: 'sunrise' },
            { ch: '🌇', label: 'sunset-city' },
            { ch: '🌃', label: 'night-stars' },
            { ch: '☽', label: '1Q moon (text)' },
            { ch: '☾', label: 'LQ moon (text)' },
            { ch: '🌑', label: 'new moon' },
            { ch: '🌒', label: 'wax cresc' },
            { ch: '🌓', label: '1Q' },
            { ch: '🌔', label: 'wax gibb' },
            { ch: '🌕', label: 'full' },
            { ch: '🌖', label: 'wan gibb' },
            { ch: '🌗', label: 'LQ' },
            { ch: '🌘', label: 'wan cresc' },
            { ch: '🌙', label: 'crescent' },
            { ch: '🌚', label: 'new+face' },
            { ch: '🌛', label: '1Q+face' },
            { ch: '🌜', label: 'LQ+face' },
            { ch: '🌝', label: 'full+face' },
            { ch: '🌞', label: 'sun+face' },
            { ch: '🌟', label: 'star' },
            { ch: '🌠', label: 'shooting' },
          ]
          return (
            <>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 mt-2">Default rendering</div>
              <div className="grid grid-cols-8 gap-2 mb-3">
                {unicodes.map(({ ch, label }) => (
                  <div key={`u-d-${ch}`} className="flex flex-col items-center gap-0.5">
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{ch}</span>
                    <span className="text-[9px] text-zinc-500 leading-tight">{label}</span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">With VS-15 (︎) — text-style request</div>
              <div className="grid grid-cols-8 gap-2 mb-3">
                {unicodes.map(({ ch, label }) => (
                  <div key={`u-t-${ch}`} className="flex flex-col items-center gap-0.5">
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{ch + '︎'}</span>
                    <span className="text-[9px] text-zinc-500 leading-tight">{label}</span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">With <code className="text-zinc-400">font-variant-emoji: text</code></div>
              <div className="grid grid-cols-8 gap-2">
                {unicodes.map(({ ch, label }) => (
                  <div key={`u-fv-${ch}`} className="flex flex-col items-center gap-0.5">
                    <span style={{ fontSize: 22, lineHeight: 1, fontVariantEmoji: 'text' }}>{ch}</span>
                    <span className="text-[9px] text-zinc-500 leading-tight">{label}</span>
                  </div>
                ))}
              </div>
            </>
          )
        })()}
      </div>

      {/* Day-cycle gradient strip */}
      <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Colour cycle (in time order)</div>
        <div className="flex w-full h-8 rounded overflow-hidden">
          {TIME_OF_DAY_LABELS.map((label) => {
            const v = CELL_VISUALS[label]
            if (!v) return null
            return (
              <div
                key={`cycle-${label}`}
                className="flex-1"
                style={{ backgroundColor: v.colour }}
                title={`${label} — ${v.colour}`}
              />
            )
          })}
        </div>
        <div className="flex w-full mt-1">
          {TIME_OF_DAY_LABELS.map((label) => (
            <div key={`cycle-label-${label}`} className="flex-1 text-[8px] text-zinc-500 text-center leading-tight px-0.5">
              {label.replace(/Early /, 'E ').replace(/Late /, 'L ')}
            </div>
          ))}
        </div>
      </div>
    </Section>
  )
}

function TimeOfDayCarouselDemo() {
  const [timeFormat, setTimeFormat] = useState('12h')
  const [todState, setTodState] = useState({
    activeTier: 'labelled',
    drafts: { broad: null, labelled: null, exact: null },
  })
  const [todSaved, setTodSaved] = useState(null)
  function saveTod() {
    const value = todState.drafts[todState.activeTier]
    setTodSaved({ tier: todState.activeTier, value })
  }
  function discardOthers() {
    const next = { broad: null, labelled: null, exact: null }
    next[todState.activeTier] = todState.drafts[todState.activeTier]
    setTodState({ activeTier: todState.activeTier, drafts: next })
  }
  function loadDemo() {
    setTodState({
      activeTier: 'labelled',
      drafts: { broad: null, labelled: 'Late Morning', exact: null },
    })
    setTodSaved(null)
  }

  // Effective display of the active tier's value (for the readout).
  const active = todState.activeTier
  const draft = todState.drafts[active]
  const effective =
    active === 'exact'    ? (draft ? formatExact(draft, timeFormat) : '(blank)')
  : active === 'labelled' ? (draft || '(blank)')
  : active === 'broad'    ? (draft || '(blank)')
  : '(no tier)'

  // Solid bg colour for the demo wrapper. We pass this same value as
  // the carousel's `bgColour` so the per-cell backing discs blend
  // seamlessly with the wrapper instead of reading as darker circles.
  const demoBg = '#27272a'   // zinc-800 (solid, was bg-zinc-800/50)
  return (
    <Section title="Time of Day carousel (full)">
      <div
        className="border border-zinc-700 rounded p-3 space-y-3"
        style={{ backgroundColor: demoBg }}
      >
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <span>Time format:</span>
          <button
            type="button"
            onClick={() => setTimeFormat(timeFormat === '12h' ? '24h' : '12h')}
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
          >
            {timeFormat}
          </button>
          <span className="text-zinc-600">(Tier 3 only)</span>
        </div>

        <TimeOfDayCarousel
          state={todState}
          onChange={setTodState}
          timeFormat={timeFormat}
          bgColour={demoBg}
        />

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={saveTod}
            className="text-xs px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded"
          >
            Save (active tier only)
          </button>
          <button
            type="button"
            onClick={discardOthers}
            className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
          >
            Simulate Save: clear inactive drafts
          </button>
          <button
            type="button"
            onClick={loadDemo}
            className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
            title="Simulates loading a saved scene with only the labelled tier populated"
          >
            Load demo: labelled = Late Morning
          </button>
          {todSaved && (
            <div className="text-[11px] text-zinc-300 font-mono">
              Saved: <span className="text-accent-400">{todSaved.tier}</span> ={' '}
              <span className="text-zinc-200">{JSON.stringify(todSaved.value)}</span>
            </div>
          )}
        </div>

        <div className="text-[10px] text-zinc-500 font-mono leading-snug space-y-0.5">
          <div>active tier: <span className="text-zinc-300">{todState.activeTier}</span></div>
          <div>effective display: <span className="text-zinc-300">{effective}</span></div>
          <div>session drafts:</div>
          <div className="pl-3">
            broad:    <span className={active === 'broad' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(todState.drafts.broad)}</span>
          </div>
          <div className="pl-3">
            labelled: <span className={active === 'labelled' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(todState.drafts.labelled)}</span>
          </div>
          <div className="pl-3">
            exact:    <span className={active === 'exact' ? 'text-zinc-200' : 'text-zinc-500'}>{JSON.stringify(todState.drafts.exact)}</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-500 italic leading-relaxed">
          Try: pick a Tier 2 label (Tier 2 is the default starting tier). Rotate to Exact, set a clock time. Rotate back to
          Labelled — your label is preserved. Set Exact to e.g. 03:15, rotate to Labelled — pre-fill is "Late Night" via the
          §2.3 collapse table. Pre-fill never overwrites: if Labelled already has a draft, rotation restores it.
        </p>
      </div>
    </Section>
  )
}

function TimeOfDayCarouselTiltedDemo() {
  // Same shape as TimeOfDayCarouselDemo but with `tilted={true}` so
  // top-row branches (except Pre-Dawn) lean 30° counter-clockwise and
  // bot-row branches (except Midnight) lean 30° clockwise around their
  // column's mid-cell pivot. Lets the writer A/B the two gearshift
  // geometries side by side.
  const [todState, setTodState] = useState({
    activeTier: 'labelled',
    drafts: { broad: null, labelled: null, exact: null },
  })
  const demoBg = '#27272a'
  return (
    <Section title="Time of Day carousel — tilted-branch variant">
      <p className="text-[11px] text-zinc-500 italic mb-3 leading-snug">
        Identical to the carousel above, with <code>tilted</code> set:
        top-row branches lean 30° counter-clockwise (except Pre-Dawn),
        bot-row branches lean 30° clockwise (except Midnight). Icons
        and text stay upright at the new tip positions; the central
        sun-arc track is unchanged. Drag-snap and click-to-pick both
        respect the new geometry.
      </p>
      <div
        className="border border-zinc-700 rounded p-3"
        style={{ backgroundColor: demoBg }}
      >
        <TimeOfDayCarousel
          state={todState}
          onChange={setTodState}
          bgColour={demoBg}
          tilted
        />
      </div>
    </Section>
  )
}

function NestPage() {
  const [fired, setFired] = useState(() => new Set(getFiredEggs()))
  useEffect(() => subscribeFiredEggs(() => setFired(new Set(getFiredEggs()))), [])

  return (
    <div>
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-4">
        Nest — session activations
      </div>
      <div className="flex flex-wrap gap-6 items-end">
        {NEST_EGGS.map((egg) => (
          <div
            key={egg.id}
            title={egg.id + (fired.has(egg.id) ? ' — activated' : ' — not yet')}
            className="flex flex-col items-center"
          >
            <NestEgg colour={egg.colour} outlineColour={egg.outlineColour} fired={fired.has(egg.id)} />
          </div>
        ))}
      </div>
      <div className="text-xs text-zinc-500 mt-6">
        {fired.size} of {NEST_EGGS.length} activated this session.
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────────────────
// Phase 1.22 Mockups page — Attributes-tab grouping mockup, Scene Detail
// Panel Circumstances sub-tab mockup, and the bet-pill scenario walkthrough.
// All renders are fixture-driven (synthetic mock data — no real-store
// integration); the goal is to lock the visual target so the 1.22d / 1.22e
// implementations have a stable reference to build against.
// ───────────────────────────────────────────────────────────────────────────

// Reusable mock fixture: the bet-pill scenario from the planning doc.
// Each "anchor" describes a scene + Alice's chain-resolved circumstance /
// motivator stack at that scene + scene-level circumstances at that scene.
// Pre-resolved (we don't run the actual walker here — these are static
// snapshots showing what the writer would see at each chain stop).
const BET_PILL_FIXTURE = [
  {
    sceneNumber: 1,
    sceneTitle: 'Scene 1 — The bet is lost, pill is taken',
    sceneCircumstances: [],
    aliceCircumstances: [
      { name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill. ~214 hours remaining.", intensity: 4 },
    ],
    aliceMotivators: [
      { name: 'Honour the bet',           description: 'Subject feels duty-bound to follow through on the wager.', intensity: 3 },
      { name: 'Self-image as straight man', description: "Subject's interior identity remains that of a straight man.", intensity: 4 },
      { name: 'Embarrassment-aversion',   description: 'Subject seeks to avoid public embarrassment.', intensity: 1 },
    ],
  },
  {
    sceneNumber: 4,
    sceneTitle: 'Scene 4 — Getting dressed for the party',
    sceneCircumstances: [
      { name: null, description: 'Forced social obligation', intensity: 2 },
    ],
    aliceCircumstances: [
      { name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill.", intensity: 4 },
    ],
    aliceMotivators: [
      { name: 'Honour the bet',           description: 'Subject feels duty-bound.', intensity: 3 },
      { name: 'Self-image as straight man', description: "Subject's interior identity remains that of a straight man.", intensity: 4 },
      { name: 'Embarrassment-aversion',   description: 'Subject seeks to avoid public embarrassment.', intensity: 1 },
    ],
  },
  {
    sceneNumber: 5,
    sceneTitle: 'Scene 5 — At the party, first guy approaches',
    sceneCircumstances: [
      { name: null, description: 'At the bet party',                      intensity: null },
      { name: null, description: 'Loud and crowded',                      intensity: 2 },
      { name: null, description: 'Receiving unwanted romantic attention', intensity: 2 },
      { name: null, description: 'Forced social obligation',              intensity: 2 },
    ],
    aliceCircumstances: [
      { name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill.", intensity: 4 },
    ],
    aliceMotivators: [
      { name: 'Honour the bet',                description: 'Subject feels duty-bound.', intensity: 3 },
      { name: 'Self-image as straight man',    description: "Subject's interior identity remains that of a straight man.", intensity: 4 },
      { name: 'Embarrassment-aversion',        description: 'Now intense — being approached publicly.', intensity: 4 },
      { name: 'Emergent unwanted attraction', description: 'Subject is finding themselves attracted to someone they did not expect.', intensity: 1 },
    ],
  },
  {
    sceneNumber: 8,
    sceneTitle: 'Scene 8 — Deeper into the party',
    sceneCircumstances: [
      { name: null, description: 'At the bet party',                      intensity: null },
      { name: null, description: 'Loud and crowded',                      intensity: 2 },
      { name: null, description: 'Receiving unwanted romantic attention', intensity: 3 },
      { name: null, description: 'Forced social obligation',              intensity: 2 },
    ],
    aliceCircumstances: [
      { name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill.", intensity: 4 },
    ],
    aliceMotivators: [
      { name: 'Honour the bet',                description: 'Subject feels duty-bound.', intensity: 3 },
      { name: 'Self-image as straight man',    description: "Subject's interior identity remains that of a straight man.", intensity: 4 },
      { name: 'Embarrassment-aversion',        description: 'Intense — being approached publicly.', intensity: 4 },
      { name: 'Emergent unwanted attraction', description: 'Subject is finding themselves attracted to men.', intensity: 3 },
      { name: 'Cognitive dissonance',         description: "Holding two contradictory beliefs / responses simultaneously.", intensity: 3 },
    ],
  },
  {
    sceneNumber: 14,
    sceneTitle: 'Scene 14 — Next morning, party over',
    sceneCircumstances: [],
    aliceCircumstances: [
      { name: 'Pill-induced transformation', description: "Effect time-limited.", intensity: 4 },
    ],
    aliceMotivators: [
      { name: 'Honour the bet',                description: 'Subject feels duty-bound.', intensity: 3 },
      { name: 'Self-image as straight man',    description: "Subject's interior identity remains.", intensity: 4 },
      { name: 'Embarrassment-aversion',        description: 'Subdued the morning after.', intensity: 1 },
      { name: 'Emergent unwanted attraction', description: 'Still present.', intensity: 3 },
      { name: 'Cognitive dissonance',         description: 'Still active.', intensity: 3 },
    ],
  },
  {
    sceneNumber: 22,
    sceneTitle: 'Scene 22 — Transformation reverses (~214 h elapsed)',
    sceneCircumstances: [],
    aliceCircumstances: [],
    aliceMotivators: [
      { name: 'Self-image as straight man', description: 'Residual — a faint trace of identity-anxiety remains.', intensity: 0 },
    ],
  },
]

function CMRow({ kind, attr }) {
  return (
    <CircumstanceMotivatorSubChip
      attributeType={kind}
      name={attr.name}
      description={attr.description}
      intensity={attr.intensity}
    />
  )
}

// ── Mockup A: Attributes tab grouping (entity Detail Panel — 1.22d target) ──
function AttributesTabGroupingMockup() {
  // Synthetic Alice attribute set — mix of Other (text) attributes,
  // Circumstance attributes, and Motivator attributes. Locks the
  // section ordering decision: Other → Circumstances → Motivators.
  const [otherOpen, setOtherOpen]     = useState(true)
  const [circOpen, setCircOpen]       = useState(true)
  const [motOpen,  setMotOpen]        = useState(true)
  return (
    <section className="rounded border border-zinc-800 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Attributes-tab grouping mockup (Phase 1.22d target)</h3>
        <p className="text-[10px] text-zinc-500">
          Static synthetic render of Alice's entity Detail Panel Attributes tab once 1.22d ships. Section ordering:
          <strong> Attributes → Circumstances → Motivators</strong>. Each section header is collapsible (click it).
          Default state on first open: all sections expanded. <code>+ Add</code> button at the top of each new section.
          The <em>Attributes</em> section (the catch-all category) uses placeholder-text rows instead of the real <code>ChangeSubChip</code> /
          attribute-row renderer (the real thing arrives in 1.22d); the Circumstances and Motivators sections use the real
          <code>CircumstanceMotivatorSubChip</code>.
        </p>
      </div>

      <div className="rounded border border-zinc-700 bg-zinc-900/40 max-w-[520px]">
        <div className="px-3 py-2 border-b border-zinc-700 text-[11px] text-zinc-300">
          Alice <span className="text-zinc-500">— Attributes tab</span>
        </div>

        {/* Other attributes section */}
        <div className="border-b border-zinc-700/60">
          <button
            onClick={() => setOtherOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
          >
            <span>{otherOpen ? '▾' : '▸'} Attributes</span>
            <span className="text-accent-400 normal-case tracking-normal text-[11px]">+ Add Attribute</span>
          </button>
          {otherOpen && (
            <div className="px-3 pb-2 space-y-1 text-[11px] text-zinc-300">
              <div className="flex items-center justify-between"><span className="text-zinc-400">Age</span><span>32</span></div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Hair colour</span><span>brown</span></div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Strength</span><span>15 <span className="text-zinc-500 text-[9px]">(number)</span></span></div>
            </div>
          )}
        </div>

        {/* Circumstances section */}
        <div className="border-b border-zinc-700/60">
          <button
            onClick={() => setCircOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
          >
            <span>{circOpen ? '▾' : '▸'} Circumstances</span>
            <span className="text-accent-400 normal-case tracking-normal text-[11px]">+ Add Circumstance</span>
          </button>
          {circOpen && (
            <div className="px-3 pb-2 space-y-1">
              <CMRow kind="circumstance" attr={{ name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill. ~214 hours remaining.", intensity: 4 }} />
            </div>
          )}
        </div>

        {/* Motivators section */}
        <div>
          <button
            onClick={() => setMotOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
          >
            <span>{motOpen ? '▾' : '▸'} Motivators</span>
            <span className="text-accent-400 normal-case tracking-normal text-[11px]">+ Add Motivator</span>
          </button>
          {motOpen && (
            <div className="px-3 pb-2 space-y-1">
              <CMRow kind="motivator" attr={{ name: 'Honour the bet',                description: 'Subject feels duty-bound to follow through on a wager they lost.', intensity: 3 }} />
              <CMRow kind="motivator" attr={{ name: 'Self-image as straight man',    description: "Subject's interior identity remains that of a straight man regardless of current bodily state.", intensity: 4 }} />
              <CMRow kind="motivator" attr={{ name: 'Embarrassment-aversion',        description: 'Subject seeks to avoid public embarrassment, especially in front of peers.', intensity: 4 }} />
              <CMRow kind="motivator" attr={{ name: 'Emergent unwanted attraction', description: 'Subject is finding themselves attracted to someone they did not expect.', intensity: 3 }} />
              <CMRow kind="motivator" attr={{ name: 'Cognitive dissonance',         description: 'Subject is experiencing the discomfort of holding two contradictory beliefs simultaneously.', intensity: 3 }} />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ── Mockup B: Scene Detail Panel Circumstances sub-tab (1.22e target) ──────
function SceneCircumstancesSubTabMockup() {
  return (
    <section className="rounded border border-zinc-800 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Scene Detail Panel Circumstances sub-tab mockup (Phase 1.22e target)</h3>
        <p className="text-[10px] text-zinc-500">
          Static synthetic render of the new <em>Circumstances</em> sub-tab on the Scene Detail Panel. Sits between
          {' '}<em>Details</em> and <em>Changes</em> in the existing sub-tab strip. Two sections: <strong>At the scene
          level</strong> (editable list of the scene's own <code>Scene.circumstances</code>) and
          {' '}<strong>Per entity</strong> (read-only summary per entity in the scene with click-through to the entity's
          Detail Panel). Entities with empty stacks still appear with "(none)" rows.
        </p>
      </div>

      <div className="rounded border border-zinc-700 bg-zinc-900/40 max-w-[520px]">
        <div className="px-3 py-2 border-b border-zinc-700 text-[11px] text-zinc-300">
          Scene 5 <span className="text-zinc-500">— Circumstances</span>
        </div>

        {/* At the scene level */}
        <div className="border-b border-zinc-700/60">
          <div className="px-3 py-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-400">
            <span>At the scene level</span>
            <span className="text-accent-400 normal-case tracking-normal text-[11px]">+ Add Circumstance</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            <CMRow kind="circumstance" attr={{ name: null, description: 'At the bet party',                      intensity: null }} />
            <CMRow kind="circumstance" attr={{ name: null, description: 'Loud and crowded',                      intensity: 2 }} />
            <CMRow kind="circumstance" attr={{ name: null, description: 'Receiving unwanted romantic attention', intensity: 2 }} />
            <CMRow kind="circumstance" attr={{ name: null, description: 'Forced social obligation',              intensity: 2 }} />
          </div>
        </div>

        {/* Per entity */}
        <div>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400">Per entity</div>
          <div className="px-3 pb-2 space-y-3">
            <div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-200 mb-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ec4899' }} />
                Alice
                <span className="text-zinc-500 text-[10px]">— click to drill into Alice's Detail Panel at this scene</span>
              </div>
              <div className="space-y-1 pl-4 border-l border-zinc-800">
                <CMRow kind="circumstance" attr={{ name: 'Pill-induced transformation', description: "Subject's body has been altered by an enchanted pill.", intensity: 4 }} />
                <CMRow kind="motivator"    attr={{ name: 'Honour the bet',                description: 'Subject feels duty-bound.', intensity: 3 }} />
                <CMRow kind="motivator"    attr={{ name: 'Self-image as straight man',    description: "Subject's interior identity remains.", intensity: 4 }} />
                <CMRow kind="motivator"    attr={{ name: 'Embarrassment-aversion',        description: 'Subject seeks to avoid public embarrassment.', intensity: 4 }} />
                <CMRow kind="motivator"    attr={{ name: 'Emergent unwanted attraction', description: 'Subject is finding themselves attracted to men.', intensity: 1 }} />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-200 mb-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#60a5fa' }} />
                Bob
                <span className="text-zinc-500 text-[10px]">— (none)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Mockup C: Bet-pill scenario walkthrough fixture ────────────────────────
function BetPillScenarioWalkthrough() {
  const [sceneIdx, setSceneIdx] = useState(3)  // default: Scene 8 (the most populated state)
  const anchor = BET_PILL_FIXTURE[sceneIdx]
  return (
    <section className="rounded border border-zinc-800 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Bet-pill scenario walkthrough (chain resolution preview)</h3>
        <p className="text-[10px] text-zinc-500">
          Static fixture that snapshots Alice's chain-resolved circumstance / motivator stack at five key scenes from the
          planning doc's worked example (Scene 1, 4, 5, 8, 14, 22). Click the scene numbers below to scrub through the
          chain and verify the visual progression. Rendered using the real <code>CircumstanceMotivatorSubChip</code> with
          synthetic data — the actual <code>computeEffectiveState</code> walker integration arrives in 1.22d / 1.22e.
        </p>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {BET_PILL_FIXTURE.map((a, i) => (
          <button
            key={i}
            onClick={() => setSceneIdx(i)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              i === sceneIdx
                ? 'border-accent-500 bg-accent-700/30 text-accent-200'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
            }`}
          >
            Scene {a.sceneNumber}
          </button>
        ))}
      </div>

      <div className="rounded border border-zinc-700 bg-zinc-900/40 max-w-[520px]">
        <div className="px-3 py-2 border-b border-zinc-700 text-[11px] text-zinc-300">
          {anchor.sceneTitle}
        </div>

        {anchor.sceneCircumstances.length > 0 && (
          <div className="border-b border-zinc-700/60">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400">At the scene level</div>
            <div className="px-3 pb-2 space-y-1">
              {anchor.sceneCircumstances.map((c, i) => (
                <CMRow key={i} kind="circumstance" attr={c} />
              ))}
            </div>
          </div>
        )}

        <div className="border-b border-zinc-700/60">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400">Alice — Carried circumstances</div>
          <div className="px-3 pb-2 space-y-1">
            {anchor.aliceCircumstances.length === 0 && (
              <div className="text-[10px] italic text-zinc-600">(none)</div>
            )}
            {anchor.aliceCircumstances.map((c, i) => (
              <CMRow key={i} kind="circumstance" attr={c} />
            ))}
          </div>
        </div>

        <div>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-400">Alice — Motivators</div>
          <div className="px-3 pb-2 space-y-1">
            {anchor.aliceMotivators.length === 0 && (
              <div className="text-[10px] italic text-zinc-600">(none)</div>
            )}
            {anchor.aliceMotivators.map((m, i) => (
              <CMRow key={i} kind="motivator" attr={m} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function Phase1_22MockupsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Circumstances & Motivators 1.22 Mockups</h2>
      <p className="text-[11px] text-zinc-400">
        Visual targets for the rest of Phase 1.22. Atom + subchip components from 1.22b are wired in directly; surface
        mockups (Attributes-tab grouping, Scene Detail Panel sub-tab) use synthetic data so the visuals are reviewable
        BEFORE the 1.22d / 1.22e implementations land.
      </p>

      <AttributesTabGroupingMockup />
      <SceneCircumstancesSubTabMockup />
      <BetPillScenarioWalkthrough />
    </div>
  )
}


// ── Chat Payloads (Phase 2.5d debug) ────────────────────────────────────────
//
// Session-only ring buffer view: every time `streamChat` ships a
// payload to `/api/ai/chat-stream` (frontend/src/services/
// chatClient.js), `recordChatPayload` stashes the exact body in a
// module-level ring buffer (cap 5). This page subscribes and
// renders the entries oldest-first so a writer debugging the
// chat-context-history flow can see byte-for-byte what the model
// is receiving. The buffer is in-memory only and resets on reload.
function ChatPayloadsPage() {
  const [, force] = useState(0)
  useEffect(() => {
    const unsub = subscribeChatPayloads(() => force((x) => x + 1))
    return unsub
  }, [])
  const entries = getChatPayloads()
  return (
    <div className="text-zinc-200">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm text-zinc-300 font-semibold mb-0.5">Chat Payloads</h3>
          <p className="text-[10px] text-zinc-500 max-w-2xl">
            The last {entries.length === 0 ? 'few' : `${entries.length}`} outgoing chat payloads sent to the LLM adapter, oldest first.
            Session-only; cleared on reload. Use this to verify exactly what `system_context` blocks, scene-context inline messages,
            and user / assistant turns the model is actually receiving.
          </p>
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={() => clearChatPayloads()}
            className="text-[10px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800/60 flex-shrink-0"
          >
            Clear
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-zinc-500 italic border border-dashed border-zinc-700 rounded p-4 text-center">
          No chat payloads captured yet. Send a message in the chat panel and refresh this tab.
        </div>
      ) : (
        <div className="space-y-4">
          {entries.map((e, idx) => (
            <ChatPayloadEntry key={e.id} entry={e} ordinal={entries.length - idx} />
          ))}
        </div>
      )}
    </div>
  )
}


function ChatPayloadEntry({ entry, ordinal }) {
  const [view, setView] = useState('readable')  // 'readable' | 'json'
  const payload = entry.payload || {}
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  return (
    <div className="border border-zinc-700 rounded bg-zinc-900/60">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-800/40">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[9px] uppercase tracking-wider text-zinc-500">#{ordinal}</span>
          <span className="text-[10px] text-zinc-400 font-mono truncate">{entry.at}</span>
          <span className="text-[10px] text-zinc-500 truncate">
            {payload.profile_id || '?'} / {payload.model || '?'} · {messages.length} msg{messages.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setView('readable')}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${
              view === 'readable'
                ? 'border-accent-700/60 bg-accent-900/30 text-accent-200'
                : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
            }`}
          >Readable</button>
          <button
            type="button"
            onClick={() => setView('json')}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${
              view === 'json'
                ? 'border-accent-700/60 bg-accent-900/30 text-accent-200'
                : 'border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
            }`}
          >JSON</button>
        </div>
      </div>
      {view === 'readable' ? (
        <div className="px-3 py-2 space-y-2">
          {payload.system_prompt && (
            <ChatPayloadMessage role="system_prompt" content={payload.system_prompt} />
          )}
          {messages.map((m, i) => (
            <ChatPayloadMessage key={i} role={m.role} content={m.content} />
          ))}
          {messages.length === 0 && !payload.system_prompt && (
            <div className="text-[11px] text-zinc-500 italic">(empty payload)</div>
          )}
        </div>
      ) : (
        <pre className="px-3 py-2 text-[10px] text-zinc-300 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[60vh] overflow-y-auto">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  )
}


function ChatPayloadMessage({ role, content }) {
  const tone = role === 'user'
    ? 'border-l-blue-700/60 bg-blue-900/10'
    : role === 'assistant'
      ? 'border-l-emerald-700/60 bg-emerald-900/10'
      : role === 'system' || role === 'system_prompt'
        ? 'border-l-amber-700/60 bg-amber-900/10'
        : 'border-l-zinc-700/60 bg-zinc-800/30'
  const label = role === 'system_prompt' ? 'system (prompt)' : role
  return (
    <div className={`border-l-2 ${tone} px-2 py-1 rounded-r`}>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
      <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-words font-sans leading-relaxed">
        {content || '(empty)'}
      </pre>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────────────────
// UI Design Ideation Page — scratchpad for candidate icons for the chat-
// composer's auto-attach toggle button (Feature A) and the scene-editor's
// type-aware highlight names button (Feature B). Three parallel agents
// independently proposed candidates; this page renders each side-by-side
// (OFF / ON states) so the writer can visually compare and pick.
//
// Conventions:
//   - All icons render in a 24×24 viewBox.
//   - OFF state: stroke-only, `text-zinc-500`. ON state: filled with the
//     story accent colour (`useAccentColor()`), white-tinted strokes.
//   - "Family" icons that work for both features are flagged.
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Phase 2.13 — Perspective badge ideation. Pentagon shape is reserved for
// the intensity-family badges (IntensityBadge / CircumstanceTypeBadge /
// MotivatorTypeBadge) so Perspective needs a different outline. Colours
// below are picked from currently-unclaimed identity-hue families — every
// existing identity colour (violet=relationship, purple=scene, tan=
// knowledge, indigo=conversation, amber=broad day, deep indigo=broad
// night, emerald+yellow=cues, slate=circumstance, rust=motivator,
// red=reject) is excluded.
// ───────────────────────────────────────────────────────────────────────────
const _PERSPECTIVE_PATHS = {
  hexagon:       'M 0,-50 L 43.3,-25 L 43.3,25 L 0,50 L -43.3,25 L -43.3,-25 Z',
  diamondV:      'M 0,-50 L 30,0 L 0,50 L -30,0 Z',
  diamondH:      'M 0,-30 L 50,0 L 0,30 L -50,0 Z',
  // Union of the vertical (30×50) and horizontal (50×30) diamonds —
  // an 8-vertex 4-pointed star. Tips at (±50,0) / (0,±50) come from
  // the diamond extents; "shoulder" inflection points at (±18.75, ±18.75)
  // are where the two diamond edges intersect (solved from
  // y = (5/3)x - 50 vs y = (3/5)x - 30, giving x = 300/16 = 18.75).
  diamondStar:   'M 0,-50 L 18.75,-18.75 L 50,0 L 18.75,18.75 L 0,50 L -18.75,18.75 L -50,0 L -18.75,-18.75 Z',
  rupee:         'M 0,-50 L 25,-25 L 25,25 L 0,50 L -25,25 L -25,-25 Z',
  octagon:       'M -20.7,-50 L 20.7,-50 L 50,-20.7 L 50,20.7 L 20.7,50 L -20.7,50 L -50,20.7 L -50,-20.7 Z',
  roundedSquare: 'M -28,-40 L 28,-40 Q 40,-40 40,-28 L 40,28 Q 40,40 28,40 L -28,40 Q -40,40 -40,28 L -40,-28 Q -40,-40 -28,-40 Z',
  // Rounded square rotated 45° on centre → a diamond with rounded
  // corners. Vertices live at (±50, 0) and (0, ±50) like the regular
  // diamond, with corner radius r=14.14 (so r/√2 = exactly 10) softening
  // each tip. Removes both the "axis-aligned button" read of the regular
  // rounded square AND the sharp-point austerity of the regular diamond.
  roundedDiamond: 'M 10,-40 L 40,-10 Q 50,0 40,10 L 10,40 Q 0,50 -10,40 L -40,10 Q -50,0 -40,-10 L -10,-40 Q 0,-50 10,-40 Z',
}

function _PerspectiveBadgeMockup({ shape, colour, size = 40 }) {
  // Diamond-horizontal is short vertically; shrink the letter so it
  // still fits inside the outline. Other shapes use the same letter
  // size as the existing pentagon badges.
  const isShort = shape === 'diamondH'
  const fontSize = isShort ? 28 : 50
  const yOffset  = isShort ? 10 : 17
  return (
    <svg viewBox="-55 -55 110 110" width={size} height={size} style={{ display: 'inline-block' }}>
      <path d={_PERSPECTIVE_PATHS[shape]} fill="none" stroke={colour} strokeWidth="3" strokeLinejoin="round" />
      <text x="0" y={yOffset} fill={colour} fontSize={fontSize} fontWeight="700" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, sans-serif">P</text>
    </svg>
  )
}

const _PERSPECTIVE_SHAPES = [
  { key: 'hexagon',       label: 'Hexagon' },
  { key: 'diamondV',      label: 'Diamond (vertical)' },
  { key: 'diamondH',      label: 'Diamond (horizontal)' },
  { key: 'diamondStar',   label: 'Diamond star (V + H union)' },
  { key: 'rupee',         label: 'Rupee' },
  { key: 'octagon',        label: 'Octagon' },
  { key: 'roundedSquare',  label: 'Rounded square' },
  { key: 'roundedDiamond', label: 'Rounded diamond (square rotated 45°)' },
]

// Metallic trio: dull silver (Circumstance #94a3b8) + dull bronze
// (Motivator #c89078) + dull gold (Perspective candidates below).
// `dullGold` is the primary candidate, matched in saturation +
// luminosity to the C / M slate + rust pair; `antiqueGold` and
// `honeyGold` are nearby variations for comparison.
const _PERSPECTIVE_COLOURS = [
  { key: 'dullGold',    label: 'Dull gold',    value: '#c5a86a' },
  { key: 'antiqueGold', label: 'Antique gold', value: '#a89150' },
  { key: 'honeyGold',   label: 'Honey gold',   value: '#c9a45a' },
  { key: 'softBrass',   label: 'Soft brass',   value: '#b8a06b' },
  { key: 'teal',        label: 'Teal (prev)',  value: '#5fa8a8' },
]

function _CandidateCard({ name, description, attribution, family, ...props }) {
  // OffIcon / OnIcon are rendered as JSX elements below; destructure them
  // in the body so they are recognised as used (the lint config does not
  // count JSX element-tag usage of destructured parameters).
  const { OffIcon, OnIcon } = props
  return (
    <div className="bg-zinc-800/40 border border-zinc-700 rounded-md p-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="text-xs font-semibold text-zinc-200">{name}</span>
        {family && (
          <span className="text-[9px] uppercase tracking-wider text-accent-400 bg-accent-900/40 border border-accent-700/40 px-1 py-px rounded">
            {family}
          </span>
        )}
      </div>
      <div className="text-[10px] text-zinc-500 leading-snug">{description}</div>
      <div className="flex items-center gap-3 mt-1">
        <div className="flex flex-col items-center gap-1">
          <div className="w-7 h-7 flex items-center justify-center rounded border border-zinc-700 bg-zinc-900">
            <OffIcon />
          </div>
          <span className="text-[9px] uppercase tracking-wider text-zinc-600">off</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="w-7 h-7 flex items-center justify-center rounded border border-accent-700/60 bg-accent-900/40">
            <OnIcon />
          </div>
          <span className="text-[9px] uppercase tracking-wider text-accent-400">on</span>
        </div>
      </div>
      {attribution && (
        <div className="text-[9px] text-zinc-600 italic mt-auto">{attribution}</div>
      )}
    </div>
  )
}

// ── Phase 5.1b — Wire-visibility toggle: candidate mode-icon sets ─────────
// Brainstorm scratchpad for the single small <ControlButton> that cycles the
// canvas wire-visibility modes. The button's glyph changes per mode, so we
// need ONE cohesive set of five simple, distinct icons legible at ~16px.
// Convention: a node is a SQUARE, an entity is a CIRCLE (shape carries the
// node-vs-entity split); Hide uses a slash. Monochrome (currentColor) to
// match the other control buttons.
const _wireSvg = (size, children) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)

const WIRE_ICON_SET_A = [
  { label: 'Show All', Icon: ({ size }) => _wireSvg(size, <>
      <line x1="12" y1="5" x2="6" y2="17" /><line x1="12" y1="5" x2="18" y2="17" /><line x1="6" y1="17" x2="18" y2="17" />
      <circle cx="12" cy="5" r="2.4" fill="currentColor" stroke="none" /><circle cx="6" cy="17" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="17" r="2.4" fill="currentColor" stroke="none" />
    </>) },
  { label: 'POV Only', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M4 9 Q12 3.5 20 9 Q12 14.5 4 9 Z" /><circle cx="12" cy="9" r="2" fill="currentColor" stroke="none" />
      <line x1="7" y1="19.5" x2="17" y2="19.5" /><circle cx="7" cy="19.5" r="1.6" fill="currentColor" stroke="none" /><circle cx="17" cy="19.5" r="1.6" fill="currentColor" stroke="none" />
    </>) },
  { label: 'Selected Node', Icon: ({ size }) => _wireSvg(size, <>
      <rect x="3" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
      <line x1="10" y1="10.5" x2="19" y2="6" /><line x1="10" y1="13.5" x2="19" y2="18" />
      <circle cx="19.5" cy="6" r="2" /><circle cx="19.5" cy="18" r="2" />
    </>) },
  { label: 'Selected Entity', Icon: ({ size }) => _wireSvg(size, <>
      <circle cx="6.5" cy="12" r="3.7" fill="currentColor" stroke="none" />
      <line x1="10" y1="10.5" x2="19" y2="6" /><line x1="10" y1="13.5" x2="19" y2="18" />
      <circle cx="19.5" cy="6" r="2" /><circle cx="19.5" cy="18" r="2" />
    </>) },
  { label: 'Hide', Icon: ({ size }) => _wireSvg(size, <>
      <line x1="6" y1="15" x2="18" y2="15" strokeOpacity="0.5" /><circle cx="6" cy="15" r="1.8" /><circle cx="18" cy="15" r="1.8" />
      <line x1="4.5" y1="20" x2="19.5" y2="5" strokeWidth="2.3" />
    </>) },
]

const WIRE_ICON_SET_B = [
  { label: 'Show All', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M12 5 Q6 11 6 17" /><path d="M12 5 Q18 11 18 17" /><path d="M6 17 Q12 14 18 17" />
      <circle cx="12" cy="5" r="2.4" fill="currentColor" stroke="none" /><circle cx="6" cy="17" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="17" r="2.4" fill="currentColor" stroke="none" />
    </>) },
  { label: 'POV Only', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M4 9 Q12 3.5 20 9 Q12 14.5 4 9 Z" /><circle cx="12" cy="9" r="2" fill="currentColor" stroke="none" />
      <path d="M7 19.5 Q12 16.5 17 19.5" /><circle cx="7" cy="19.5" r="1.6" fill="currentColor" stroke="none" /><circle cx="17" cy="19.5" r="1.6" fill="currentColor" stroke="none" />
    </>) },
  { label: 'Selected Node', Icon: ({ size }) => _wireSvg(size, <>
      <rect x="3" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
      <path d="M10 11 Q16 8 19.5 6" /><path d="M10 13 Q16 16 19.5 18" />
      <circle cx="19.5" cy="6" r="2" /><circle cx="19.5" cy="18" r="2" />
    </>) },
  { label: 'Selected Entity', Icon: ({ size }) => _wireSvg(size, <>
      <circle cx="6.5" cy="12" r="3.7" fill="currentColor" stroke="none" />
      <path d="M10 11 Q16 8 19.5 6" /><path d="M10 13 Q16 16 19.5 18" />
      <circle cx="19.5" cy="6" r="2" /><circle cx="19.5" cy="18" r="2" />
    </>) },
  { label: 'Hide', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M6 15 Q12 12 18 15" strokeOpacity="0.5" /><circle cx="6" cy="15" r="1.8" /><circle cx="18" cy="15" r="1.8" />
      <line x1="4.5" y1="20" x2="19.5" y2="5" strokeWidth="2.3" />
    </>) },
]

const WIRE_ICON_SET_C = [
  { label: 'Show All', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M3 7 Q12 3 21 7" /><path d="M3 12 Q12 8 21 12" /><path d="M3 17 Q12 13 21 17" />
    </>) },
  { label: 'POV Only', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M3 7 Q12 3 21 7" strokeOpacity="0.3" /><path d="M3 12 Q12 8 21 12" strokeWidth="2.6" /><path d="M3 17 Q12 13 21 17" strokeOpacity="0.3" />
    </>) },
  { label: 'Selected Node', Icon: ({ size }) => _wireSvg(size, <>
      <rect x="2.5" y="8.7" width="6.5" height="6.5" rx="1.2" fill="currentColor" stroke="none" />
      <path d="M9 11 Q15 8 21 7" /><path d="M9 12 Q15 12 21 12" /><path d="M9 13 Q15 16 21 17" />
    </>) },
  { label: 'Selected Entity', Icon: ({ size }) => _wireSvg(size, <>
      <circle cx="6" cy="12" r="3.4" fill="currentColor" stroke="none" />
      <path d="M9.4 10.8 Q15 8 21 7" /><path d="M9.5 12 Q15 12 21 12" /><path d="M9.4 13.2 Q15 16 21 17" />
    </>) },
  { label: 'Hide', Icon: ({ size }) => _wireSvg(size, <>
      <path d="M3 7 Q12 3 21 7" strokeOpacity="0.4" /><path d="M3 12 Q12 8 21 12" strokeOpacity="0.4" /><path d="M3 17 Q12 13 21 17" strokeOpacity="0.4" />
      <line x1="4.5" y1="20" x2="19.5" y2="4" strokeWidth="2.3" />
    </>) },
]

// Set D — Set A refined: bold "POV" lettering instead of the eye, Selected
// Entity mirrored (circle on the right) to read distinctly from Selected
// Node, and Hide = the Show-All dots flipped vertically with no wires / slash.
const WIRE_ICON_SET_D = [
  { label: 'Show All', Icon: ({ size }) => _wireSvg(size, <>
      <line x1="12" y1="5" x2="6" y2="17" /><line x1="12" y1="5" x2="18" y2="17" /><line x1="6" y1="17" x2="18" y2="17" />
      <circle cx="12" cy="5" r="2.4" fill="currentColor" stroke="none" /><circle cx="6" cy="17" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="17" r="2.4" fill="currentColor" stroke="none" />
    </>) },
  { label: 'POV Only', Icon: ({ size }) => _wireSvg(size, <>
      <text x="12" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight="800" fontFamily="ui-sans-serif, system-ui, sans-serif" letterSpacing="-0.8" fill="currentColor" stroke="none">POV</text>
      <line x1="7" y1="19.5" x2="17" y2="19.5" /><circle cx="7" cy="19.5" r="1.6" fill="currentColor" stroke="none" /><circle cx="17" cy="19.5" r="1.6" fill="currentColor" stroke="none" />
    </>) },
  { label: 'Selection', Icon: ({ size }) => _wireSvg(size, <>
      <line x1="9" y1="10.5" x2="4" y2="6" /><line x1="15" y1="10.5" x2="20" y2="6" />
      <line x1="9" y1="13.5" x2="4" y2="18" /><line x1="15" y1="13.5" x2="20" y2="18" />
      <circle cx="3.5" cy="6" r="1.7" /><circle cx="20.5" cy="6" r="1.7" /><circle cx="3.5" cy="18" r="1.7" /><circle cx="20.5" cy="18" r="1.7" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" stroke="none" />
    </>) },
  { label: 'POV + Selection', Icon: ({ size }) => _wireSvg(size, <>
      <text x="12" y="7.6" textAnchor="middle" fontSize="6.8" fontWeight="800" fontFamily="ui-sans-serif, system-ui, sans-serif" letterSpacing="-0.6" fill="currentColor" stroke="none">POV</text>
      <line x1="9.5" y1="13.6" x2="5" y2="11" /><line x1="14.5" y1="13.6" x2="19" y2="11" />
      <line x1="9.5" y1="16.4" x2="5" y2="20" /><line x1="14.5" y1="16.4" x2="19" y2="20" />
      <circle cx="4.5" cy="11" r="1.5" /><circle cx="19.5" cy="11" r="1.5" /><circle cx="4.5" cy="20" r="1.5" /><circle cx="19.5" cy="20" r="1.5" />
      <rect x="9.5" y="12.5" width="5" height="5" rx="1.1" fill="currentColor" stroke="none" />
    </>) },
  { label: 'Hide', Icon: ({ size }) => _wireSvg(size, <>
      <circle cx="6" cy="7" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="7" r="2.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="2.4" fill="currentColor" stroke="none" />
    </>) },
]

function _WireModeSet({ name, concept, modes }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] font-medium text-zinc-200">{name}</div>
      <div className="text-[10px] text-zinc-500 mb-2">{concept}</div>
      <div className="flex gap-5 flex-wrap">
        {modes.map((m) => (
          <div key={m.label} className="flex flex-col items-center gap-1" style={{ width: 84 }}>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded bg-zinc-900 border border-zinc-700 text-zinc-100"
                    style={{ width: 26, height: 26 }} title="actual button size (~16px glyph)">
                <m.Icon size={16} />
              </span>
              <span className="inline-flex items-center justify-center text-zinc-100"
                    style={{ width: 38, height: 38 }} title="enlarged">
                <m.Icon size={36} />
              </span>
            </div>
            <div className="text-[9px] text-zinc-400 text-center leading-tight">{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Phase 5.8b — candidate scene-break (dinkus) ornaments for the native
// export. Markdown / txt fall back to "* * *"; PDF + DOCX would embed the
// chosen SVG (rasterised via resvg, the export-icon path); HTML can embed
// the vector inline. Stored as raw SVG strings — the exact form the
// rasteriser consumes — so a pick here drops straight into the renderer.
const SCENE_BREAK_ORNAMENTS = [
  {
    id: 'asterisks',
    label: '0 · Classic dinkus  * * *',
    note: 'text fallback (markdown / txt)',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><text x="120" y="20" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-size="16" letter-spacing="7" fill="#3a3a3a">* * *</text></svg>',
  },
  {
    id: 'diamonds3',
    label: '1 · Three diamonds',
    note: 'geometric, prints crisp',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="#3a3a3a"><polygon points="104,9.5 108.5,14 104,18.5 99.5,14"/><polygon points="120,7.5 125.5,14 120,20.5 114.5,14"/><polygon points="136,9.5 140.5,14 136,18.5 131.5,14"/></g></svg>',
  },
  {
    id: 'diamondRule',
    label: '2 · Diamond with fading rules',
    note: 'center diamond, tapered hairlines',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><defs><linearGradient id="sbL" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.9"/></linearGradient><linearGradient id="sbR" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0.9"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0"/></linearGradient></defs><rect x="36" y="13.4" width="74" height="1.2" fill="url(#sbL)"/><polygon points="120,7 127,14 120,21 113,14" fill="#3a3a3a"/><rect x="130" y="13.4" width="74" height="1.2" fill="url(#sbR)"/></svg>',
  },
  {
    id: 'dotsDiamond',
    label: '3 · Dotted, center diamond',
    note: 'dots framing a diamond',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="#3a3a3a"><circle cx="74" cy="14" r="1.5"/><circle cx="88" cy="14" r="1.5"/><circle cx="102" cy="14" r="1.5"/><polygon points="120,8 126,14 120,20 114,14"/><circle cx="138" cy="14" r="1.5"/><circle cx="152" cy="14" r="1.5"/><circle cx="166" cy="14" r="1.5"/></g></svg>',
  },
  {
    id: 'asterisksVec',
    label: '4 · Three asterisks (vector stars)',
    note: 'crisp six-point asterisks',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g stroke="#3a3a3a" stroke-width="1.3" stroke-linecap="round"><line x1="98.5" y1="14" x2="109.5" y2="14"/><line x1="101.25" y1="9.24" x2="106.75" y2="18.76"/><line x1="101.25" y1="18.76" x2="106.75" y2="9.24"/><line x1="114.5" y1="14" x2="125.5" y2="14"/><line x1="117.25" y1="9.24" x2="122.75" y2="18.76"/><line x1="117.25" y1="18.76" x2="122.75" y2="9.24"/><line x1="130.5" y1="14" x2="141.5" y2="14"/><line x1="133.25" y1="9.24" x2="138.75" y2="18.76"/><line x1="133.25" y1="18.76" x2="138.75" y2="9.24"/></g></svg>',
  },
  {
    id: 'lens',
    label: '5 · Hairline with center lens',
    note: 'thin rule swelling to a leaf',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g><line x1="42" y1="14" x2="106" y2="14" stroke="#3a3a3a" stroke-width="1"/><path d="M106 14 Q120 8.5 134 14 Q120 19.5 106 14 Z" fill="#3a3a3a"/><line x1="134" y1="14" x2="198" y2="14" stroke="#3a3a3a" stroke-width="1"/></g></svg>',
  },
  {
    id: 'fleuron',
    label: '6 · Fleuron flourish (draft)',
    note: 'mirrored leaf scroll — refinable',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="#3a3a3a"><path d="M114 14 C 104 7, 90 7, 82 11 C 88 11, 100 12, 113 14 C 100 16, 88 17, 82 17 C 90 21, 104 21, 114 14 Z"/><path d="M126 14 C 136 7, 150 7, 158 11 C 152 11, 140 12, 127 14 C 140 16, 152 17, 158 17 C 150 21, 136 21, 126 14 Z"/><polygon points="120,9 124,14 120,19 116,14"/></g></svg>',
  },
  {
    id: 'fancy-victorian',
    label: '7 · Victorian filigree (fancier)',
    note: 'symmetric scrollwork + centre diamond',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="none" stroke="#3a3a3a" stroke-width="1.1" stroke-linecap="round"><path d="M116 14 C 102 14 98 7 86 8 C 77 9 77 17 86 17 C 92 17 92 11 87 11"/><path d="M124 14 C 138 14 142 7 154 8 C 163 9 163 17 154 17 C 148 17 148 11 153 11"/><path d="M116 14 C 110 11 110 17 116 14" stroke-width="0.9"/><path d="M124 14 C 130 11 130 17 124 14" stroke-width="0.9"/></g><polygon points="120,9.5 123.5,14 120,18.5 116.5,14" fill="#3a3a3a"/></svg>',
  },
  {
    id: 'fancy-deco',
    label: '8 · Art-deco chevrons',
    note: 'geometric << ◆ >>',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g stroke="#3a3a3a" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="110,9 104,14 110,19"/><polyline points="102,9 96,14 102,19"/><polyline points="130,9 136,14 130,19"/><polyline points="138,9 144,14 138,19"/></g><polygon points="120,7.5 125,14 120,20.5 115,14" fill="#3a3a3a"/></svg>',
  },
  {
    id: 'nn-arches',
    label: '9 · NarrativeNode "nn" arches',
    note: 'double-n motif + fading rules',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><defs><linearGradient id="nnL" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.85"/></linearGradient><linearGradient id="nnR" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0.85"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0"/></linearGradient></defs><rect x="40" y="13.5" width="63" height="1" fill="url(#nnL)"/><g fill="none" stroke="#3a3a3a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M111 20 L111 12 C111 8 118 8 118 12 L118 20"/><path d="M122 20 L122 12 C122 8 129 8 129 12 L129 20"/></g><rect x="137" y="13.5" width="63" height="1" fill="url(#nnR)"/></svg>',
  },
  {
    id: 'nn-roundel',
    label: '10 · NarrativeNode "nn" roundel',
    note: 'double-n as a maker\'s mark',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><ellipse cx="120" cy="14" rx="23" ry="11" fill="none" stroke="#3a3a3a" stroke-width="0.8"/><g fill="none" stroke="#3a3a3a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M111 19 L111 12 C111 9 117 9 117 12 L117 19"/><path d="M121 19 L121 12 C121 9 127 9 127 12 L127 19"/></g></svg>',
  },
  {
    id: 'nn-diamond',
    label: '11 · NarrativeNode  n ◆ n',
    note: 'double-n framing a diamond',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="none" stroke="#3a3a3a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M97 20 L97 12 C97 8 104 8 104 12 L104 20"/><path d="M136 20 L136 12 C136 8 143 8 143 12 L143 20"/></g><polygon points="120,8 126,14 120,20 114,14" fill="#3a3a3a"/></svg>',
  },
  {
    id: 'nn-serif',
    label: '12 · Serif "nn" + rules',
    note: 'literal letters — font-dependent in PDF/DOCX',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><line x1="58" y1="14" x2="104" y2="14" stroke="#3a3a3a" stroke-width="0.8"/><text x="120" y="19" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-style="italic" font-size="15" fill="#3a3a3a">nn</text><line x1="136" y1="14" x2="182" y2="14" stroke="#3a3a3a" stroke-width="0.8"/></svg>',
  },
  {
    id: 'cursive-interwoven',
    label: '13 · Cursive NN — interwoven (draft)',
    note: 'two mirrored N strokes crossing at centre',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="none" stroke="#3a3a3a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M80,17 C84,21 87,21 90,19 C92,13 95,9 99,8 C101,12 106,16 112,20 C114,14 116,10 119,8"/><path d="M160,17 C156,21 153,21 150,19 C148,13 145,9 141,8 C139,12 134,16 128,20 C126,14 124,10 121,8"/></g></svg>',
  },
  {
    id: 'cursive-pair',
    label: '14 · Cursive NN — flowing pair (draft)',
    note: 'two italic N strokes with swash tails',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><g fill="none" stroke="#3a3a3a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M72,16 C76,20 80,21 82,20 C84,12 88,8 93,8 C95,12 100,16 105,20 C107,13 110,9 114,8"/><path d="M118,20 C120,12 124,8 129,8 C131,12 136,16 141,20 C143,13 146,9 150,8 C152,11 156,11 160,14"/></g></svg>',
  },
  {
    id: 'cursive-knot',
    label: '15 · Cursive NN — centre knot (draft)',
    note: 'two N strokes meeting in a small loop',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28"><path d="M82,20 C84,12 88,8 93,8 C95,12 100,16 105,20 C108,15 111,11 114,12 C118,13 119,18 115,18 C111,18 112,12 117,11 C122,10 126,8 130,12 C133,16 138,18 143,15 C147,12 150,9 152,12 C154,16 158,20 164,19" fill="none" stroke="#3a3a3a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'nn-overlap-angled',
    label: '16 · Overlapping NN diamond + angled rules',
    note: 'your sketch — rules kink up parallel to the slope',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 36" width="300" height="36"><defs><linearGradient id="nnA16" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.92"/></linearGradient><linearGradient id="nnB16" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0.92"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0"/></linearGradient></defs><g fill="none" stroke="#3a3a3a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M126 28 L126 8 L158 28 L158 8"/><path d="M174 28 L174 8 L142 28 L142 8"/></g><path d="M26 24 L96 24 L126 8" fill="none" stroke="url(#nnA16)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M274 24 L204 24 L174 8" fill="none" stroke="url(#nnB16)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'nn-overlap-flat',
    label: '17 · Overlapping NN diamond + flat rules',
    note: 'same mark, plain fading rules',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 36" width="300" height="36"><defs><linearGradient id="nnA17" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.92"/></linearGradient><linearGradient id="nnB17" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3a3a3a" stop-opacity="0.92"/><stop offset="100%" stop-color="#3a3a3a" stop-opacity="0"/></linearGradient></defs><g fill="none" stroke="#3a3a3a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M126 28 L126 8 L158 28 L158 8"/><path d="M174 28 L174 8 L142 28 L142 8"/></g><line x1="26" y1="18" x2="118" y2="18" stroke="url(#nnA17)" stroke-width="2" stroke-linecap="round"/><line x1="182" y1="18" x2="274" y2="18" stroke="url(#nnB17)" stroke-width="2" stroke-linecap="round"/></svg>',
  },
]

function UiDesignIdeationPage() {
  const accent = useAccentColor()
  // Stroke / fill helpers. ON state uses accent; OFF uses muted grey
  // so a writer can read the silhouette at a glance.
  const offStroke = '#a1a1aa'   // zinc-400
  const onStroke = '#ffffff'
  const onFill = accent
  // Sample type colours used by multi-colour icons (matches the cue +
  // entity defaults used elsewhere in the program).
  const C = { ent: '#fb923c', cue: '#10b981', know: '#b89968', rel: '#a78bfa' }
  // Vibrant palette used by the #18 rainbow-tag variants. Brighter
  // than the program's canonical entity / cue / knowledge / relationship
  // colours (which lean toward parchment / muted-violet for prose
  // legibility); we want the icon's perimeter to pop at toolbar size.
  const VIVID = { ent: '#f97316', cue: '#10b981', know: '#f59e0b', rel: '#8b5cf6' }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
          UI Design Ideation
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl">
          Candidate icons for two related features: <b>Feature A</b> = chat-composer auto-attach toggle (detects names in chat input → highlights inline + auto-attaches as context pills); <b>Feature B</b> = scene-editor type-aware highlight names button (extends existing entity highlighting to cover cues / knowledges / relationships). Three parallel agents independently proposed candidates; this page is the scratchpad for picking visuals before committing them to live UI.
        </p>
      </div>

      {/* ─ Scene break ornaments (Phase 5.8b) ─────────────────────── */}
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
          Scene Break Ornaments (Phase 5.8b)
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl mb-3">
          Candidate dinkus / scene-break separators for the NarrativeNode native export, each shown between two scenes of the same chapter on a paper-toned card at roughly on-page width. Markdown / plain-text exports use <code>* * *</code> (option 0); PDF + DOCX would embed the chosen SVG (rasterised via resvg, the same path the season / time-of-day icons use); HTML can embed it as crisp inline vector. Pick one, mix-and-match, or ask for tweaks (the fleuron is a rough draft).
        </p>
        <div className="space-y-3 max-w-2xl">
          {SCENE_BREAK_ORNAMENTS.map((o) => (
            <div key={o.id} className="rounded border border-zinc-700 overflow-hidden">
              <div className="flex items-baseline justify-between px-3 py-1 bg-zinc-800/40">
                <span className="text-[11px] font-medium text-zinc-200">{o.label}</span>
                <span className="text-[10px] text-zinc-500">{o.note}</span>
              </div>
              <div
                style={{ background: '#f7f4ec', color: '#2c2c2c', fontFamily: 'Georgia, "Times New Roman", serif' }}
                className="px-8 py-5"
              >
                <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, textAlign: 'justify' }}>
                  …the latch fell shut behind her, and the long corridor swallowed the sound of her footsteps whole.
                </p>
                <div
                  style={{ textAlign: 'center', margin: '14px 0' }}
                  dangerouslySetInnerHTML={{ __html: o.svg }}
                />
                <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, textAlign: 'justify' }}>
                  Morning arrived grey and unhurried, indifferent to everything the night had quietly taken from her.
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ─ Convergence notes ─────────────────────────────────────── */}
      <div className="bg-zinc-800/30 border border-zinc-700 rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
          Agent convergence
        </div>
        <ul className="text-[11px] text-zinc-300 space-y-1 list-disc list-inside">
          <li><b>Multi-coloured strata / chips / underlines</b> — all three agents proposed a "stacked-colour-bands" family (Agent 2: Stacked Strokes + Layered Chips; Agent 3: Bookmark Strata). Strongest convergence; visually encodes "per-type" by construction.</li>
          <li><b>Highlighter pen</b> — Agent 1 and Agent 2 both proposed a diagonal-marker icon with a coloured nib. Borderline against the "no font-button" rule but the diagonal shape (vs horizontal Aa) keeps it safe.</li>
          <li><b>Magnet</b> — Agent 1 (sparkle variant) and Agent 3 (text-line variant) both used the magnet "auto-attraction" metaphor for Feature A. Mostly Feature A only.</li>
          <li><b>Loupe / magnifying glass</b> — Agent 1 and Agent 3 both rejected the plain "magnifier + plus", with Agent 3 proposing a spectrum-lens variant where the glass IS the type palette.</li>
          <li><b>Sparkle / wand AI-motif</b> — Agent 1 leaned on this in 3 of 6 candidates. Agent 3 actively avoided it as too-generic AI iconography.</li>
        </ul>
      </div>

      {/* ─ Feature A — auto-attach button candidates ─────────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Feature A — Chat composer auto-attach button
        </div>
        <div className="grid grid-cols-3 gap-3">
          <_CandidateCard
            name="1. Magnet + sparkle"
            description="Horseshoe magnet (auto-attracts matching names) with a small sparkle for the AI/auto cue."
            attribution="Agent 1 · convergence with Agent 3"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round">
                <path d="M6 16 V10 a6 6 0 0 1 12 0 V16" />
                <path d="M6 16 H10 M14 16 H18" />
                <path d="M19 4 l0.7 1.5 l1.5 0.7 l-1.5 0.7 l-0.7 1.5 l-0.7-1.5 l-1.5-0.7 l1.5-0.7 z" fill={offStroke} stroke="none" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.6" strokeLinecap="round">
                <path d="M6 16 V10 a6 6 0 0 1 12 0 V16" fill={onFill} fillOpacity="0.35" />
                <path d="M6 16 H10 M14 16 H18" />
                <path d="M19 4 l0.7 1.5 l1.5 0.7 l-1.5 0.7 l-0.7 1.5 l-0.7-1.5 l-1.5-0.7 l1.5-0.7 z" fill={onFill} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="2. Wand + trail"
            description="Diagonal wand with sparkles trailing up-right. Strong 'AI auto' read; overlaps Copilot / ChatGPT conventions."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 20 L16 8" />
                <circle cx="16" cy="8" r="1.5" fill={offStroke} stroke="none" />
                <path d="M18 6 l0.3 0.7 l0.7 0.3 l-0.7 0.3 l-0.3 0.7 l-0.3-0.7 l-0.7-0.3 l0.7-0.3 z" fill={offStroke} stroke="none" />
                <path d="M21 3 l0.3 0.7 l0.7 0.3 l-0.7 0.3 l-0.3 0.7 l-0.3-0.7 l-0.7-0.3 l0.7-0.3 z" fill={offStroke} stroke="none" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 20 L16 8" />
                <circle cx="16" cy="8" r="1.8" fill={onFill} stroke="none" />
                <path d="M18 6 l0.4 0.9 l0.9 0.4 l-0.9 0.4 l-0.4 0.9 l-0.4-0.9 l-0.9-0.4 l0.9-0.4 z" fill={onFill} stroke="none" />
                <path d="M21 3 l0.4 0.9 l0.9 0.4 l-0.9 0.4 l-0.4 0.9 l-0.4-0.9 l-0.9-0.4 l0.9-0.4 z" fill={onFill} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="3. Radar pulse"
            description="Concentric arcs with a centre dot. Abstract: 'live detection / scanning input'. Pulse animation on ON state."
            attribution="Agent 1 · unique"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="2.2" fill={offStroke} stroke="none" />
                <path d="M12 7 A5 5 0 0 1 17 12" />
                <path d="M12 4 A8 8 0 0 1 20 12" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.6" strokeLinecap="round">
                <circle cx="12" cy="12" r="2.4" fill={onFill} stroke="none" />
                <path d="M12 7 A5 5 0 0 1 17 12" />
                <path d="M12 4 A8 8 0 0 1 20 12" />
              </svg>
            )}
          />
          <_CandidateCard
            name="4. @ in rounded box"
            description="Borrows Slack/Discord '@' mention semantics. Risk: implies sigil-trigger detection, but our detection is name-based not '@'-based."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="3" />
                <path d="M15 12 V13.5 a1.5 1.5 0 0 0 3 0 V12 A6 6 0 1 0 14 17.5" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill={onFill} stroke={onStroke} strokeWidth="1.4" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="3" fill="none" />
                <path d="M15 12 V13.5 a1.5 1.5 0 0 0 3 0 V12 A6 6 0 1 0 14 17.5" fill="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="5. Chain links + sparkle"
            description="Two oblique chain links plus a sparkle. Native to NarrativeNode's chain vocabulary; sparkle disambiguates from hyperlink toolbars."
            attribution="Agent 1 · NarrativeNode-native"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round">
                <ellipse cx="9" cy="15" rx="4" ry="2.4" transform="rotate(-45 9 15)" />
                <ellipse cx="15" cy="9" rx="4" ry="2.4" transform="rotate(-45 15 9)" />
                <path d="M20 3 l0.4 1 l1 0.4 l-1 0.4 l-0.4 1 l-0.4-1 l-1-0.4 l1-0.4 z" fill={offStroke} stroke="none" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.8" strokeLinecap="round">
                <ellipse cx="9" cy="15" rx="4" ry="2.4" transform="rotate(-45 9 15)" />
                <ellipse cx="15" cy="9" rx="4" ry="2.4" transform="rotate(-45 15 9)" />
                <path d="M20 3 l0.5 1.2 l1.2 0.5 l-1.2 0.5 l-0.5 1.2 l-0.5-1.2 l-1.2-0.5 l1.2-0.5 z" fill={onFill} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="6. Speech bubble + multi-bar"
            description="Chat-bubble with a coloured-stripes run inside. Clearly chat-side; doesn't translate to the editor."
            attribution="Agent 3 · A only"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5 a2 2 0 0 1 2-2 h12 a2 2 0 0 1 2 2 v8 a2 2 0 0 1-2 2 H10 l-4 4 v-4 H6 a2 2 0 0 1-2-2 z" />
                <line x1="7" y1="9" x2="11" y2="9" strokeWidth="2" stroke={offStroke} />
                <line x1="13" y1="9" x2="17" y2="9" strokeWidth="2" stroke={offStroke} />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5 a2 2 0 0 1 2-2 h12 a2 2 0 0 1 2 2 v8 a2 2 0 0 1-2 2 H10 l-4 4 v-4 H6 a2 2 0 0 1-2-2 z" />
                <line x1="6.5" y1="9" x2="9" y2="9" strokeWidth="2" stroke={C.ent} />
                <line x1="10" y1="9" x2="12.5" y2="9" strokeWidth="2" stroke={C.cue} />
                <line x1="13.5" y1="9" x2="16" y2="9" strokeWidth="2" stroke={C.know} />
                <line x1="17" y1="9" x2="18.5" y2="9" strokeWidth="2" stroke={C.rel} />
              </svg>
            )}
          />
        </div>
      </div>

      {/* ─ Feature B — scene editor names button candidates ──────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Feature B — Scene editor type-aware highlight names button
        </div>
        <div className="grid grid-cols-3 gap-3">
          <_CandidateCard
            name="7. Stacked colour bars"
            description="Three offset rounded rects in distinct entity-type colours. Reads as 'multi-type highlight' immediately."
            attribution="Agent 2 · convergence"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.4" strokeLinecap="round">
                <rect x="3" y="6" width="14" height="3" rx="1.5" />
                <rect x="5" y="11" width="14" height="3" rx="1.5" />
                <rect x="3" y="16" width="14" height="3" rx="1.5" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <rect x="3" y="6" width="14" height="3" rx="1.5" fill={C.ent} />
                <rect x="5" y="11" width="14" height="3" rx="1.5" fill={C.cue} />
                <rect x="3" y="16" width="14" height="3" rx="1.5" fill={C.rel} />
              </svg>
            )}
          />
          <_CandidateCard
            name="8. Highlighter pen + nib swatch"
            description="Diagonal marker body with the nib filled in story-accent. The always-coloured nib hints at the 'always highlight' subtoggle."
            attribution="Agent 2 · convergence with Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 4 L20 10 L10 20 L4 14 Z" />
                <path d="M4 14 L8 18 L6 20 Z" fill={accent} stroke="none" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 4 L20 10 L10 20 L4 14 Z" fill={onFill} fillOpacity="0.5" />
                <path d="M4 14 L8 18 L6 20 Z" fill={onFill} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="9. Bracketed name tag"
            description="Wiki-style [[name]] brackets around a coloured chip. Borrows Roam/Obsidian/Notion mention semantics writers already know."
            attribution="Agent 2 · unique"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 5 L3 5 L3 19 L5 19" />
                <path d="M19 5 L21 5 L21 19 L19 19" />
                <rect x="7" y="9" width="10" height="6" rx="1.5" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 5 L3 5 L3 19 L5 19" />
                <path d="M19 5 L21 5 L21 19 L19 19" />
                <rect x="7" y="9" width="10" height="6" rx="1.5" fill={onFill} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            name="10. Layered name chips (fan)"
            description="Fanned stack of overlapping pill-chips in different tints. Strong 'categories of named things' read; Linear-label-filter idiom."
            attribution="Agent 2 · convergence"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.4" strokeLinecap="round">
                <rect x="3" y="10" width="14" height="4" rx="2" transform="rotate(-10 10 12)" />
                <rect x="5" y="10" width="14" height="4" rx="2" />
                <rect x="3" y="10" width="14" height="4" rx="2" transform="rotate(10 10 12)" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <rect x="3" y="10" width="14" height="4" rx="2" transform="rotate(-10 10 12)" fill={C.ent} fillOpacity="0.85" />
                <rect x="5" y="10" width="14" height="4" rx="2" fill={C.cue} fillOpacity="0.9" />
                <rect x="3" y="10" width="14" height="4" rx="2" transform="rotate(10 10 12)" fill={C.rel} fillOpacity="0.85" />
              </svg>
            )}
          />
          <_CandidateCard
            name="11. Inkwell + nibs"
            description="Inkwell with three coloured nibs above the rim. Writer-poetic; fits scene editor. Doesn't translate to chat."
            attribution="Agent 3 · B only"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.4" strokeLinecap="round">
                <path d="M5 11 h14 l-2 9 H7 z" />
                <line x1="9" y1="6" x2="9" y2="10" strokeWidth="2.4" />
                <line x1="12" y1="4" x2="12" y2="10" strokeWidth="2.4" />
                <line x1="15" y1="6" x2="15" y2="10" strokeWidth="2.4" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onFill} strokeWidth="1.5" strokeLinecap="round">
                <path d="M5 11 h14 l-2 9 H7 z" fill={onFill} fillOpacity="0.3" />
                <line x1="9" y1="6" x2="9" y2="10" strokeWidth="2.4" stroke={C.ent} />
                <line x1="12" y1="4" x2="12" y2="10" strokeWidth="2.4" stroke={C.cue} />
                <line x1="15" y1="6" x2="15" y2="10" strokeWidth="2.4" stroke={C.rel} />
              </svg>
            )}
          />
          <_CandidateCard
            name="12. Nib + swatch row"
            description="Marker nib pointing at a row of coloured swatches. Both verbs visible at once. Nib triangle risks reading as a dropdown arrow."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.4" strokeLinejoin="round">
                <path d="M9 4 L15 4 L12 11 Z" />
                <rect x="3" y="13" width="4" height="6" rx="1" />
                <rect x="8" y="13" width="4" height="6" rx="1" />
                <rect x="13" y="13" width="4" height="6" rx="1" />
                <rect x="18" y="13" width="3" height="6" rx="1" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.4" strokeLinejoin="round">
                <path d="M9 4 L15 4 L12 11 Z" fill={onFill} stroke="none" />
                <rect x="3" y="13" width="4" height="6" rx="1" fill={C.ent} />
                <rect x="8" y="13" width="4" height="6" rx="1" fill={C.cue} />
                <rect x="13" y="13" width="4" height="6" rx="1" fill={C.know} />
                <rect x="18" y="13" width="3" height="6" rx="1" fill={C.rel} />
              </svg>
            )}
          />
        </div>
      </div>

      {/* ─ Family candidates (work for both) ─────────────────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Family candidates — share an icon family across both features
        </div>
        <p className="text-[10px] text-zinc-500 italic mb-3 max-w-3xl">
          These designs work for both surfaces — picking one as the family icon means Feature A and Feature B share a recognisable lineage, with surface-specific overlay glyphs (e.g. a pin corner-stamp for A, bare for B) distinguishing them.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <_CandidateCard
            family="A + B"
            name="13. Bookmark strata"
            description="Three stacked horizontal pills, each filled with a type colour. The only icon whose visual STATE encodes the per-type popover (unchecked types desaturate)."
            attribution="Agent 3 · STRONGEST family pick"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.3" strokeLinecap="round">
                <rect x="4" y="5" width="16" height="3.5" rx="1.5" />
                <rect x="4" y="10.5" width="16" height="3.5" rx="1.5" />
                <rect x="4" y="16" width="16" height="3.5" rx="1.5" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <rect x="4" y="5" width="16" height="3.5" rx="1.5" fill={C.ent} />
                <rect x="4" y="10.5" width="16" height="3.5" rx="1.5" fill={C.cue} />
                <rect x="4" y="16" width="16" height="3.5" rx="1.5" fill={C.rel} />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="14. Prism / refraction"
            description="Triangle with diverging coloured rays. Literally illustrates type-aware splitting of one text stream into typed colours."
            attribution="Agent 3 · unique"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="9,3 3,15 15,15" />
                <line x1="15" y1="9" x2="21" y2="6" />
                <line x1="15" y1="12" x2="21" y2="12" />
                <line x1="15" y1="15" x2="21" y2="18" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="9,3 3,15 15,15" stroke={onFill} fill={onFill} fillOpacity="0.2" />
                <line x1="15" y1="9" x2="21" y2="6" stroke={C.ent} />
                <line x1="15" y1="12" x2="21" y2="12" stroke={C.cue} />
                <line x1="15" y1="15" x2="21" y2="18" stroke={C.rel} />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="15. Constellation"
            description="Connected dots in varying sizes — named proper-nouns lighting up as recognised stars. Novel, needs tooltip first time."
            attribution="Agent 3 · dark-horse"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.2" strokeLinecap="round">
                <circle cx="5" cy="6" r="1.4" />
                <circle cx="12" cy="4" r="1.1" />
                <circle cx="18" cy="8" r="1.4" />
                <circle cx="14" cy="14" r="1.6" />
                <circle cx="6" cy="17" r="1.2" />
                <line x1="5" y1="6" x2="12" y2="4" />
                <line x1="12" y1="4" x2="18" y2="8" />
                <line x1="18" y1="8" x2="14" y2="14" />
                <line x1="14" y1="14" x2="6" y2="17" />
                <line x1="6" y1="17" x2="5" y2="6" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill={onFill} stroke={onFill} strokeWidth="1.3" strokeLinecap="round">
                <circle cx="5" cy="6" r="1.6" />
                <circle cx="12" cy="4" r="1.3" />
                <circle cx="18" cy="8" r="1.6" />
                <circle cx="14" cy="14" r="1.8" />
                <circle cx="6" cy="17" r="1.4" />
                <line x1="5" y1="6" x2="12" y2="4" />
                <line x1="12" y1="4" x2="18" y2="8" />
                <line x1="18" y1="8" x2="14" y2="14" />
                <line x1="14" y1="14" x2="6" y2="17" />
                <line x1="6" y1="17" x2="5" y2="6" />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="16. Spectrum loupe"
            description="Magnifier outline + the lens IS a multi-colour disc. Different from 'plain magnifier + plus' because the colour-classification is in the glass."
            attribution="Agent 3 · unique"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round">
                <circle cx="10" cy="10" r="6" />
                <line x1="14.5" y1="14.5" x2="20" y2="20" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.5" strokeLinecap="round">
                <defs>
                  <linearGradient id="loupeGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={C.ent} />
                    <stop offset="33%" stopColor={C.cue} />
                    <stop offset="66%" stopColor={C.know} />
                    <stop offset="100%" stopColor={C.rel} />
                  </linearGradient>
                </defs>
                <circle cx="10" cy="10" r="6" fill="url(#loupeGrad)" />
                <line x1="14.5" y1="14.5" x2="20" y2="20" stroke={onFill} strokeWidth="2" />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="17. Tinted tag-chip"
            description="A tag shape with a coloured fill-dot inside. Compact, immediately reads as 'labelled named thing'. Tag iconography is common in toolbars."
            attribution="Agent 3"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
                <circle cx="7" cy="12" r="1.4" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" fill={onFill} fillOpacity="0.4" />
                <circle cx="7" cy="12" r="1.6" fill={C.cue} stroke="none" />
              </svg>
            )}
          />
        </div>
      </div>

      {/* ─ Combined direction — rainbow-edged tag-chip ───────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Combined direction — rainbow-edged tag-chip (#13 type-colour idea grafted onto #17 tag-chip shape)
        </div>
        <p className="text-[10px] text-zinc-500 italic mb-3 max-w-3xl">
          The tag-chip silhouette stays the same; the type-colour signal moves to the BORDER so the interior stays clean. Four different border-treatment variants below; all share the same ON-state convention: interior subtly tinted with the story accent at low alpha so "currently on" reads.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <_CandidateCard
            family="A + B"
            name="18a. Conic-stroke (real mask, smooth)"
            description="The tag's stroke + hole-punch stroke ARE the mask. A foreignObject paints a CSS conic-gradient (smooth transitions, no hard stops) and the mask lets only the stroked area show through. Result: a real conic walking smoothly around the perimeter AND the hole-punch outline. Distinctly different from the multi-segment version because colours blend into each other rather than abutting at corners."
            attribution="User pick (`conic + stroke as mask`)"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" fill="none" stroke={offStroke} strokeWidth="2.2" strokeLinejoin="round" />
                <circle cx="7" cy="12" r="1.4" fill="none" stroke={offStroke} strokeWidth="1.3" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <defs>
                  <mask id="tagStrokeMask18aOn">
                    <rect width="24" height="24" fill="black" />
                    <path d="M3 4 h11 l6 8 l-6 8 H3 z" fill="none" stroke="white" strokeWidth="2.6" strokeLinejoin="round" />
                    <circle cx="7" cy="12" r="1.4" fill="none" stroke="white" strokeWidth="1.5" />
                  </mask>
                </defs>
                {/* Interior accent fill with hole punched out (evenodd). Sits behind the stroke. */}
                <path
                  d="M3 4 h11 l6 8 l-6 8 H3 z M7 12 m-1.4 0 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"
                  fill={onFill}
                  fillOpacity="0.2"
                  fillRule="evenodd"
                  stroke="none"
                />
                {/* Smooth conic painted via foreignObject + masked to stroke + hole-stroke band. */}
                <foreignObject x="0" y="0" width="24" height="24" mask="url(#tagStrokeMask18aOn)">
                  <div xmlns="http://www.w3.org/1999/xhtml" style={{
                    width: '100%', height: '100%',
                    background: `conic-gradient(from 225deg, ${VIVID.ent}, ${VIVID.cue}, ${VIVID.know}, ${VIVID.rel}, ${VIVID.ent})`,
                  }} />
                </foreignObject>
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="18b. Multi-segment stroke"
            description="Four separate SVG path segments, one per edge of the tag, each at full saturation. Crispest at toolbar size since each colour gets a dedicated region with hard transitions at corners. Hole-punch retained as a separate outlined circle in white for legibility."
            attribution="Discrete colour-per-side"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="2.2" strokeLinecap="butt" strokeLinejoin="round">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
                <circle cx="7" cy="12" r="1.4" strokeWidth="1.3" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.6" strokeLinecap="butt" strokeLinejoin="round">
                <path
                  d="M3 4 h11 l6 8 l-6 8 H3 z M7 12 m-1.4 0 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"
                  fill={onFill}
                  fillOpacity="0.18"
                  fillRule="evenodd"
                  stroke="none"
                />
                <path d="M3 4 H14" stroke={VIVID.ent} />
                <path d="M14 4 L20 12" stroke={VIVID.cue} />
                <path d="M20 12 L14 20" stroke={VIVID.know} />
                <path d="M14 20 H3" stroke={VIVID.rel} />
                <path d="M3 20 V4" stroke={VIVID.ent} />
                <circle cx="7" cy="12" r="1.4" stroke={onStroke} strokeWidth="1.3" />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="18c. Linear gradient stroke"
            description="Single SVG stroke with a diagonal linear gradient cycling through the four type colours, vivid palette. Smoother than 18b but each colour transitions through its neighbours. Hole-punch shares the same gradient stroke."
            attribution="Cheapest implementation"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="2.2" strokeLinejoin="round">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
                <circle cx="7" cy="12" r="1.4" strokeWidth="1.3" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.6" strokeLinejoin="round">
                <defs>
                  <linearGradient id="tagLinearOn" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={VIVID.ent} />
                    <stop offset="33%" stopColor={VIVID.cue} />
                    <stop offset="66%" stopColor={VIVID.know} />
                    <stop offset="100%" stopColor={VIVID.rel} />
                  </linearGradient>
                </defs>
                <path
                  d="M3 4 h11 l6 8 l-6 8 H3 z M7 12 m-1.4 0 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"
                  fill={onFill}
                  fillOpacity="0.18"
                  fillRule="evenodd"
                  stroke="none"
                />
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" stroke="url(#tagLinearOn)" />
                <circle cx="7" cy="12" r="1.4" stroke="url(#tagLinearOn)" strokeWidth="1.5" />
              </svg>
            )}
          />
          <_CandidateCard
            family="A + B"
            name="18d. Corner-dots only"
            description="Tag outline in mono; four small coloured dots at the corner vertices instead of a full coloured border. Hole-punch retained as a plain neutral outline since the dots are doing the colour story."
            attribution="Lightest touch"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="2" strokeLinejoin="round">
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
                <circle cx="7" cy="12" r="1.4" strokeWidth="1.3" />
                <circle cx="3" cy="4" r="1.4" fill={offStroke} stroke="none" />
                <circle cx="20" cy="12" r="1.4" fill={offStroke} stroke="none" />
                <circle cx="3" cy="20" r="1.4" fill={offStroke} stroke="none" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="2" strokeLinejoin="round">
                <path
                  d="M3 4 h11 l6 8 l-6 8 H3 z M7 12 m-1.4 0 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0"
                  fill={onFill}
                  fillOpacity="0.18"
                  fillRule="evenodd"
                  stroke="none"
                />
                <path d="M3 4 h11 l6 8 l-6 8 H3 z" />
                <circle cx="7" cy="12" r="1.4" strokeWidth="1.3" />
                <circle cx="3" cy="4" r="1.8" fill={VIVID.ent} stroke="none" />
                <circle cx="14" cy="4" r="1.8" fill={VIVID.cue} stroke="none" />
                <circle cx="20" cy="12" r="2" fill={VIVID.know} stroke="none" />
                <circle cx="3" cy="20" r="1.8" fill={VIVID.rel} stroke="none" />
              </svg>
            )}
          />
        </div>
      </div>

      {/* ─ Feature C — PBH auto-attach button candidates ─────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Feature C — Prompt Block Header auto-attach detected names
        </div>
        <p className="text-[10px] text-zinc-500 italic mb-3 max-w-3xl">
          Per-Section toggle (default ON) that auto-pins library-object names from the Section&apos;s prose to the Prompt Block&apos;s context pills. Must be distinct from: paperclip (chat file attach), tag-chip + rainbow stroke (chat highlight-detected-names), bold plus (AddContext button), magnet + sparkle (Feature A candidate). Two parallel agents independently proposed 5 candidates each.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {/* Agent 1's 5 candidates */}
          <_CandidateCard
            family="C"
            name="14. Circled A + link-chain tail"
            description="Capital A inside a circle, with a small two-link chain extending right. A = name/label; chain = attach; circle = automated/processed. Combines all three semantic beats."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="8" r="4" />
                <path d="M4.7 9.2 L6 5.5 L7.3 9.2 M5.2 8 H6.8" strokeWidth="1.3" />
                <path d="M10 8 H11.5 a1.5 1.5 0 0 1 0 3 H10.5" strokeWidth="1.4" />
                <path d="M13 11 H14.5 a1.5 1.5 0 0 1 0 3 H13.5" strokeWidth="1.4" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={onStroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="8" r="4" fill={onFill} fillOpacity="0.25" />
                <path d="M4.7 9.2 L6 5.5 L7.3 9.2 M5.2 8 H6.8" strokeWidth="1.4" />
                <path d="M10 8 H11.5 a1.5 1.5 0 0 1 0 3 H10.5" strokeWidth="1.5" />
                <path d="M13 11 H14.5 a1.5 1.5 0 0 1 0 3 H13.5" strokeWidth="1.5" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="15. Lasso around letter dots"
            description="Loop of rope wrapping three text-token dots, tail trailing off bottom-right. Lasso = active capture; dots-as-text reads cleaner than letters at 12px."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round">
                <ellipse cx="7" cy="7" rx="5.2" ry="4.2" />
                <circle cx="5" cy="7" r="0.9" fill={offStroke} />
                <circle cx="7.5" cy="7" r="0.9" fill={offStroke} />
                <circle cx="10" cy="7" r="0.9" fill={offStroke} />
                <path d="M11 10.5 L13 14" />
                <circle cx="13" cy="14" r="0.7" fill={offStroke} />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={onStroke} strokeWidth="1.6" strokeLinecap="round">
                <ellipse cx="7" cy="7" rx="5.2" ry="4.2" fill={onFill} fillOpacity="0.22" />
                <circle cx="5" cy="7" r="1" fill={onStroke} />
                <circle cx="7.5" cy="7" r="1" fill={onStroke} />
                <circle cx="10" cy="7" r="1" fill={onStroke} />
                <path d="M11 10.5 L13 14" />
                <circle cx="13" cy="14" r="0.8" fill={onStroke} />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="16. Radar pulse + name-tag"
            description="Small tag/chip shape at left, two concentric arc-rings emanating right. Radar = automatic detection/scanning; tag = name label."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={offStroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 6 L7.5 6 L9.5 8 L7.5 10 L5 10 Z" />
                <circle cx="6" cy="8" r="0.6" fill={offStroke} />
                <path d="M11 5.5 a3.5 3.5 0 0 1 0 5" />
                <path d="M12.8 3.8 a6 6 0 0 1 0 8.4" opacity="0.7" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={onStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 6 L7.5 6 L9.5 8 L7.5 10 L5 10 Z" fill={onFill} fillOpacity="0.3" />
                <circle cx="6" cy="8" r="0.7" fill={onStroke} />
                <path d="M11 5.5 a3.5 3.5 0 0 1 0 5" />
                <path d="M12.8 3.8 a6 6 0 0 1 0 8.4" opacity="0.85" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="17. Funnel filtering letters into a chip"
            description="Three text-dots above a funnel that narrows down into a pill/chip. Direct narrative: text-in, pill-out. Visualises the auto-attach pipeline."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5.5" cy="2.5" r="0.7" fill={offStroke} />
                <circle cx="8" cy="2.5" r="0.7" fill={offStroke} />
                <circle cx="10.5" cy="2.5" r="0.7" fill={offStroke} />
                <path d="M3.5 4.5 H12.5 L9.5 8.5 V11 H6.5 V8.5 Z" />
                <rect x="4.5" y="12" width="7" height="2.5" rx="1.25" strokeWidth="1.4" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={onStroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5.5" cy="2.5" r="0.8" fill={onStroke} />
                <circle cx="8" cy="2.5" r="0.8" fill={onStroke} />
                <circle cx="10.5" cy="2.5" r="0.8" fill={onStroke} />
                <path d="M3.5 4.5 H12.5 L9.5 8.5 V11 H6.5 V8.5 Z" fill={onFill} fillOpacity="0.22" />
                <rect x="4.5" y="12" width="7" height="2.5" rx="1.25" strokeWidth="1.5" fill={onFill} fillOpacity="0.3" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="18. 'AT' monogram in circle"
            description="Capital A and T side-by-side inside a circle. AT = auto-tag, AND echoes @-style attach metaphor. Most typographic / instantly readable at 12px."
            attribution="Agent 1"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={offStroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M4 11 L6 5 L8 11 M4.7 9 H7.3" strokeWidth="1.3" />
                <path d="M9 5 H12.5 M10.75 5 V11" strokeWidth="1.3" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={onStroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" fill={onFill} fillOpacity="0.22" />
                <path d="M4 11 L6 5 L8 11 M4.7 9 H7.3" strokeWidth="1.4" />
                <path d="M9 5 H12.5 M10.75 5 V11" strokeWidth="1.4" />
              </svg>
            )}
          />
          {/* Agent 2's 5 candidates */}
          <_CandidateCard
            family="C"
            name="19. Lasso loop around 'A'"
            description="Rope lasso wraps a capital A; tail trails off with a small knot dot. Letter = name/word; lasso curve = unambiguous capture-by-detection."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 11.5c0-3 3-5 7-5s7 2 7 5-3 5-7 5c-2 0-3.8-.5-5.2-1.4" />
                <path d="M6.8 15.1l-1.6 3.4" />
                <path d="M9 15l1.2-4.5h3.6L15 15" />
                <path d="M10 13h4" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 11.5c0-3 3-5 7-5s7 2 7 5-3 5-7 5c-2 0-3.8-.5-5.2-1.4" />
                <path d="M6.8 15.1l-1.6 3.4" />
                <path d="M9 15l1.2-4.5h3.6L15 15" fill={onFill} fillOpacity="0.3" />
                <path d="M10 13h4" />
                <circle cx="5.2" cy="13.3" r="1.3" fill={onStroke} stroke="none" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="20. Funnel-to-pin"
            description="Funnel above a downward-pointing pin; two text-dots fall into the funnel mouth. Visualises 'names get sifted down and pinned'. Bold geometric shapes strong at small sizes."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 4h14l-5 6v4l-4 2v-6L5 4z" />
                <circle cx="9" cy="3" r="0.6" fill={offStroke} stroke="none" />
                <circle cx="12" cy="2.5" r="0.6" fill={offStroke} stroke="none" />
                <circle cx="15" cy="3" r="0.6" fill={offStroke} stroke="none" />
                <path d="M12 16v5" />
                <circle cx="12" cy="17.5" r="1.6" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 4h14l-5 6v4l-4 2v-6L5 4z" fill={onFill} fillOpacity="0.2" />
                <circle cx="9" cy="3" r="0.6" fill={onStroke} stroke="none" />
                <circle cx="12" cy="2.5" r="0.6" fill={onStroke} stroke="none" />
                <circle cx="15" cy="3" r="0.6" fill={onStroke} stroke="none" />
                <path d="M12 16v5" />
                <circle cx="12" cy="17.5" r="1.6" fill={onFill} stroke={onStroke} />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="21. Eye + pinned dot"
            description="Open eye with the pupil rendered as a small pin (dot above short stem). The auto-scanner literally 'sees and pins' detected names."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
                <circle cx="12" cy="11" r="2" />
                <path d="M12 13v3" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
                <circle cx="12" cy="11" r="2" fill={onFill} stroke={onStroke} />
                <path d="M12 13v3" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="22. 'A' inside reticle"
            description="Capital A framed inside a square targeting reticle with four short tick marks on outer edges. Auto-detecting/targeting a name. Strong, distinctive silhouette."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="14" height="14" rx="1.5" />
                <path d="M12 3v2" />
                <path d="M12 19v2" />
                <path d="M3 12h2" />
                <path d="M19 12h2" />
                <path d="M9 16l3-8 3 8" />
                <path d="M10.2 13.5h3.6" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="14" height="14" rx="1.5" fill={onFill} fillOpacity="0.2" />
                <path d="M12 3v2" />
                <path d="M12 19v2" />
                <path d="M3 12h2" />
                <path d="M19 12h2" />
                <path d="M9 16l3-8 3 8" />
                <path d="M10.2 13.5h3.6" />
              </svg>
            )}
          />
          <_CandidateCard
            family="C"
            name="23. Circular arrow around a pin"
            description="Teardrop pin wrapped by a 3/4 circular arrow returning to itself. Pin = attachment; loop arrow = continuous auto-scanning. Round arc + pointed pin contrast strongly."
            attribution="Agent 2"
            OffIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={offStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12a7 7 0 1 1-2.5-5.4" />
                <path d="M19.5 4v3h-3" />
                <path d="M12 9a3 3 0 0 1 3 3c0 2.2-3 5-3 5s-3-2.8-3-5a3 3 0 0 1 3-3z" />
                <circle cx="12" cy="12" r="1" />
              </svg>
            )}
            OnIcon={() => (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={onStroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12a7 7 0 1 1-2.5-5.4" />
                <path d="M19.5 4v3h-3" />
                <path d="M12 9a3 3 0 0 1 3 3c0 2.2-3 5-3 5s-3-2.8-3-5a3 3 0 0 1 3-3z" fill={onFill} fillOpacity="0.3" />
                <circle cx="12" cy="12" r="1" fill={onStroke} stroke="none" />
              </svg>
            )}
          />
        </div>
      </div>

      {/* ─ Perspective badge ideation (Phase 2.13) ───────────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Perspective Badge — Shape × Colour Ideation (Phase 2.13)
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl mb-3">
          Candidate badge shapes for the new <b>Perspective</b> specialised attribute type. The pentagon outline is reserved for the intensity-family badges (IntensityBadge / Circumstance / Motivator) so this badge must use a different shape. Colours below are picked from currently-unclaimed identity-hue families — distinct from violet (relationship), purple (scene), tan (knowledge), indigo (conversation), amber + deep indigo (broad day / night), emerald + yellow (cues), slate (circumstance), rust (motivator), and red (reject).
        </p>
        <p className="text-[11px] text-accent-400 leading-relaxed max-w-3xl mb-3 italic">
          <b>Decided 2026-06-01:</b> <code>roundedDiamond</code> + <code>antiqueGold (#a89150)</code>. Lives in <code>TypeBadges.jsx</code> as <code>PerspectiveTypeBadge</code>. Reason for the rounded-diamond pick: a regular hexagon read too close to the pentagon family (Circumstance / Motivator), a regular rounded square read too close to a UI button. Rotating the rounded square 45° kills both ambiguities while keeping the softness. Antique gold completes the "dull silver / dull bronze / dull gold" metallic trio with the C / M badges.
        </p>
        <div className="grid gap-2 items-center" style={{ gridTemplateColumns: `minmax(140px, auto) repeat(${_PERSPECTIVE_COLOURS.length}, 1fr)` }}>
          <div></div>
          {_PERSPECTIVE_COLOURS.map((c) => (
            <div key={c.key} className="text-center pb-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-300">{c.label}</div>
              <div className="font-mono text-[9px] text-zinc-500">{c.value}</div>
            </div>
          ))}
          {_PERSPECTIVE_SHAPES.map((s) => (
            <div key={s.key} className="contents">
              <div className="text-[10px] uppercase tracking-wider text-zinc-300 pr-3 self-center">{s.label}</div>
              {_PERSPECTIVE_COLOURS.map((c) => (
                <div key={`${s.key}-${c.key}`} className="bg-zinc-800/40 border border-zinc-700 rounded p-3 flex items-center justify-center">
                  <_PerspectiveBadgeMockup shape={s.key} colour={c.value} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ─ ProjectTagPicker (Phase 3.4e Item 5) ─────────────────── */}
      <div className="bg-zinc-800/30 border border-zinc-700 rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
          ProjectTagPicker (Phase 3.4e)
        </div>
        <p className="text-[11px] text-zinc-400 italic mb-3 leading-relaxed max-w-3xl">
          Local-state sandbox for the new picker. Typing + Enter on an existing pool entry attaches it
          (chip renders in the pool&apos;s stored colour); typing + Enter on a name not in the pool
          transparently mints a new pool entry with the default colour and attaches the returned id —
          no &quot;create tag?&quot; confirmation step. <strong>Caveat:</strong> newly-created tags from
          this sandbox DO persist to the project pool (the find-or-create POST hits the real backend);
          delete them from the Tags &amp; Lists library tab if you want a clean slate.
        </p>
        <ProjectTagPickerDemo />
      </div>

      {/* ─ Phase 3.4i — TagFilterBar interactive drop-in ─────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
          Phase 3.4i — TagFilterBar (interactive drop-in)
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl mb-3">
          Subscribes to the project&apos;s real tag pool (project pool from
          <code className="text-zinc-300"> entitiesStore.projectTags</code> AND the count walk; program pool
          from <code className="text-zinc-300">programTagsStore.pool</code>). Filter state is held locally
          in this preview wrapper via <code className="text-zinc-300">useState</code> so you can
          interact-test without persisting anywhere. Click the trigger to open the popover; cycle tags
          through null / AND / OR / NOT; watch the active-filter row below populate. The
          {' '}<code className="text-zinc-300">×</code> button is the only way to remove a tag from the
          active row.
        </p>
        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Project pool — entity-family library filter
            </div>
            <TagFilterBarPreviewWrapper pool="project" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Program pool — context cue / conversation filter
            </div>
            <TagFilterBarPreviewWrapper pool="program" />
          </div>
        </div>
      </div>

      {/* ─ Phase 3.4i — ObjectTagsButton interactive drop-in ──────── */}
      <ObjectTagsButtonPreviewSection />

      {/* ─ Phase 5.1b — Wire-visibility toggle mode icons ──────────── */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-300 mb-1 border-b border-zinc-700 pb-1">
          Wire-visibility toggle — mode icon sets (Phase 5.1b)
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl mb-3">
          The canvas wire-visibility control is one small control button that cycles five modes; its glyph changes per mode. Goal: ONE cohesive set of five simple, distinct icons legible at ~16px (each shown at button size + enlarged). Modes: <b>Show All</b>, <b>POV Only</b>, <b>Selected Node</b>, <b>Selected Entity</b>, <b>Hide</b>. Shared convention: a node is a <b>square</b>, an entity is a <b>circle</b> (shape carries the node-vs-entity distinction), and Hide uses a <b>slash</b>. POV varies by set (eye-over-wire in A / B, the lit strand in C).
        </p>
        <_WireModeSet name="Set A — Dots & straight wires" concept="Nodes as dots / shapes joined by straight wires; the mode changes what's emphasized." modes={WIRE_ICON_SET_A} />
        <_WireModeSet name="Set B — Curved wires" concept="The same system with curved beziers, echoing the canvas's curved edges." modes={WIRE_ICON_SET_B} />
        <_WireModeSet name="Set C — Wire bundle" concept="A bundle of three wires; emphasis / anchor-shape changes per mode (no eye — POV is the single lit strand)." modes={WIRE_ICON_SET_C} />
        <_WireModeSet name="Set D — live set (condensed modes)" concept="The set wired into the control. Five modes: Show All; POV (bold 'POV' lettering); Selection (a single hub that covers a selected scene OR a focused entity / object); POV + Selection (POV lettering over the hub); Hide (Show-All dots flipped, no wires)." modes={WIRE_ICON_SET_D} />
      </div>
    </div>
  )
}

// ── ObjectTagsButton preview section (Phase 3.4i) ───────────────────────
//
// Mounts a small set of synthetic library rows so the writer can
// interact-test the button's hover-preview + click-to-pin behaviour
// against the real project / program tag pools. Each row mounts in a
// `group/item` container so the row-hover affordance pattern (existing
// per-row action buttons fade in on row hover) is preserved.
function ObjectTagsButtonPreviewSection() {
  const projectTags = useEntitiesStore((s) => s.projectTags) || []
  const tagA = projectTags[0]
  const tagB = projectTags[1] || projectTags[0]
  const tagC = projectTags[2] || projectTags[0]

  // Synthetic knowledge fixture: baseline carries tagA; chain history
  // adds tagB at a downstream scene. Mirrors the shape `splitTagIdsByOrigin`
  // expects (`{ tag_ids, history: { tag_changes } }`).
  const fakeKnowledgeBaselinePlusChain = {
    id: 'fake-knowledge-baseline-plus-chain',
    tag_ids: tagA ? [tagA.id] : [],
    history: {
      tag_changes: tagB ? [{ action: 'add', tag_id: tagB.id, node_id: 'fake-node-1' }] : [],
    },
  }

  // Synthetic relationship fixture: baseline only.
  const fakeRelationshipBaseline = {
    id: 'fake-relationship-baseline',
    tag_ids: tagA && tagC ? [tagA.id, tagC.id] : (tagA ? [tagA.id] : []),
    history: { tag_changes: [] },
  }

  // Empty host: no tags anywhere.
  const fakeEmptyKnowledge = { id: 'fake-empty', tag_ids: [], history: { tag_changes: [] } }

  // Program-pool fixture: arbitrary string tag list. Resolved against
  // the live programTagsStore inside the button.
  const fakeProgramTagNames = ['draft', 'epiphany', 'wip']

  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-zinc-300 mb-3 border-b border-zinc-700 pb-1">
        Phase 3.4i — ObjectTagsButton (per-row glance affordance)
      </div>
      <p className="text-[11px] text-zinc-400 leading-relaxed max-w-3xl mb-3">
        Read-only per-row tag glance. Hover the button (intent delay <code className="text-zinc-300">120ms</code>) →
        the popover opens in preview mode and tracks the cursor. Move the cursor away → closes after
        {' '}<code className="text-zinc-300">150ms</code>. <strong>Click</strong> the button → popover
        pins (stays open regardless of cursor position). Click the pinned button again, click outside,
        or press <code className="text-zinc-300">Esc</code> to dismiss. Baseline tags render solid;
        chain-added tags render with the dashed-border variant from <code className="text-zinc-300">TagBadge</code>.
      </p>
      <div className="space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Project pool — knowledge / relationship / entity rows
          </div>
          <div className="flex flex-col gap-1 max-w-md">
            <ObjectTagsButtonPreviewRow
              label="Knowledge — baseline + chain-added"
              pool="project"
              host={fakeKnowledgeBaselinePlusChain}
              hostKind="knowledge"
              hostHeader={<KnowledgeLabelChip name="The Codex" />}
            />
            <ObjectTagsButtonPreviewRow
              label="Relationship — baseline only"
              pool="project"
              host={fakeRelationshipBaseline}
              hostKind="relationship"
              hostHeader={<RelationshipLabelChip name="Alice ↔ Bob" />}
            />
            <ObjectTagsButtonPreviewRow
              label="Knowledge — empty (no tags attached)"
              pool="project"
              host={fakeEmptyKnowledge}
              hostKind="knowledge"
              hostHeader={<KnowledgeLabelChip name="Empty Knowledge" />}
            />
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Program pool — context cue / conversation rows
          </div>
          <div className="flex flex-col gap-1 max-w-md">
            <ObjectTagsButtonPreviewRow
              label="Cue — three program tags"
              pool="program"
              tagNames={fakeProgramTagNames}
              hostHeader={<CueLabelChip name="Beat 7 cue" />}
            />
            <ObjectTagsButtonPreviewRow
              label="Thread — empty (no tags)"
              pool="program"
              tagNames={[]}
              hostHeader={<ConversationLabelChip name="Untagged thread" />}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Library — project-card preview (Phase 5.5a) ─────────────────────────
//
// A dedicated tab previewing the Story Library `ProjectCard` in its three
// states (resting / hover / expanded) against representative sample data:
// a normal story, a favourited one, one with no cover (placeholder), a
// fully-missing one (greyed + "File not found"), a multi-path story whose
// most-recent path is an autosave, and a relocated story whose preferred
// path is missing (warning marker). Hover a card to see it grow + the
// quick Favourite / Open actions; click a cover to expand it inline.
//
// The cards live in local state so the actions are demonstrable: Favourite
// toggles the star, Hide / Remove drop the card (Reset restores them), and
// Open reports the path it would load. Sample covers are inline SVG data
// URLs (the live cards fetch `/api/library/cover/{uuid}`).

function _libSampleCover(bg, label) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 300'>` +
    `<rect width='200' height='300' fill='${bg}'/>` +
    `<rect x='10' y='10' width='180' height='280' fill='none' stroke='rgba(255,255,255,0.25)'/>` +
    `<text x='100' y='160' fill='rgba(255,255,255,0.9)' font-size='16' text-anchor='middle' font-family='sans-serif'>${label}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const _LIB_NOW = 1718200000  // fixed sample timestamps (seconds)
const _LIB_OLD = 1700000000

const LIBRARY_SAMPLE_CARDS = [
  {
    id: 'lib-tidewatch',
    title: 'The Tidewatch Saga',
    series: 'Tidewatch',
    seriesNumber: 1,
    tags: ['fantasy', 'epic', 'seafaring', 'drowned-city', 'lighthouse', 'mystery', 'slow-burn', 'ensemble', 'nautical', 'ancient-curse'],
    description: 'A drowned city wakes beneath the harbour, and the only witness is a lighthouse keeper who has not slept in twenty years.',
    favourite: false,
    missing: false,
    coverUrl: _libSampleCover('#1e3a5f', 'Tidewatch'),
    paths: [{ path: 'D:\\Stories\\tidewatch.nnz', lastModified: _LIB_NOW, isAutosave: false }],
    resolvedPath: 'D:\\Stories\\tidewatch.nnz',
    warning: false,
  },
  {
    id: 'lib-embers',
    title: 'Embers of the North',
    series: null,
    seriesNumber: null,
    tags: ['grimdark'],
    description: 'Three siblings, one throne, and a winter that will not end. The eldest commands the army but not the love of the people; the middle child holds the people but has no claim; the youngest has a claim nobody knew existed and a secret that could unmake all three. When the passes freeze and the grain runs short, alliances sworn at midwinter curdle by the first thaw, and every promise made in the great hall is a knife waiting for a back. A deliberately long sample description so the expanded card has plenty to scroll through.',
    favourite: true,
    missing: false,
    coverUrl: _libSampleCover('#5f1e1e', 'Embers'),
    paths: [{ path: 'D:\\Stories\\embers.nnz', lastModified: _LIB_NOW, isAutosave: false }],
    resolvedPath: 'D:\\Stories\\embers.nnz',
    warning: false,
  },
  {
    id: 'lib-untitled',
    title: 'Untitled Draft',
    series: null,
    seriesNumber: null,
    tags: [],
    description: 'A blank-slate story with no cover yet; shows the bundled placeholder.',
    favourite: false,
    missing: false,
    coverUrl: null,
    paths: [{ path: 'D:\\Stories\\untitled.nnz', lastModified: _LIB_OLD, isAutosave: false }],
    resolvedPath: 'D:\\Stories\\untitled.nnz',
    warning: false,
  },
  {
    id: 'lib-lost',
    title: 'The Lost Manuscript',
    series: null,
    seriesNumber: null,
    tags: ['mystery'],
    description: 'Every known path for this story is gone (USB unplugged / file moved). The card stays, greyed, with a "File not found" overlay and Remove still available.',
    favourite: false,
    missing: true,
    coverUrl: _libSampleCover('#3f3f46', 'Lost'),
    paths: [],
    resolvedPath: null,
    warning: false,
  },
  {
    id: 'lib-working',
    title: 'Working Copy',
    series: 'Tidewatch',
    seriesNumber: 2,
    tags: ['fantasy', 'wip'],
    description: 'Has both a saved file and a more-recent autosave. The autosave is offered in the dropdown but never auto-selected.',
    favourite: false,
    missing: false,
    coverUrl: _libSampleCover('#1e5f3a', 'WIP'),
    paths: [
      { path: 'D:\\Stories\\.autosave\\working.nnz', lastModified: _LIB_NOW + 5000, isAutosave: true },
      { path: 'D:\\Stories\\working.nnz', lastModified: _LIB_NOW, isAutosave: false },
    ],
    resolvedPath: 'D:\\Stories\\working.nnz',
    warning: false,
  },
  {
    id: 'lib-relocated',
    title: 'Relocated Project',
    series: null,
    seriesNumber: null,
    tags: ['drama'],
    description: 'The preferred (most-recent) path is missing, so Open falls back to an older path that still exists, flagged with a warning.',
    favourite: false,
    missing: false,
    coverUrl: _libSampleCover('#4a2f5f', 'Moved'),
    paths: [{ path: 'E:\\Backup\\relocated.nnz', lastModified: _LIB_OLD, isAutosave: false }],
    resolvedPath: 'E:\\Backup\\relocated.nnz',
    warning: true,
  },
]

function LibraryCardPage() {
  const [cards, setCards] = useState(LIBRARY_SAMPLE_CARDS)
  const [lastAction, setLastAction] = useState('')
  const [expandedId, setExpandedId] = useState(null)  // accordion: one card open at a time

  const toggleFav = (id) =>
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, favourite: !c.favourite } : c)))
  const drop = (id, verb) => {
    const card = cards.find((c) => c.id === id)
    setCards((cs) => cs.filter((c) => c.id !== id))
    if (expandedId === id) setExpandedId(null)
    setLastAction(`${verb}: ${card ? card.title : id}`)
  }
  const reset = () => { setCards(LIBRARY_SAMPLE_CARDS); setExpandedId(null); setLastAction('') }

  return (
    <div className="text-zinc-300">
      <h2 className="text-lg font-semibold text-zinc-100 mb-1">Story Library: project card</h2>
      <p className="text-xs text-zinc-500 mb-4 max-w-2xl">
        Phase 5.5a. Hover a card: the cover grows (a transform, no shelf reflow) and shows quick
        Favourite + Open. Click a cover to expand it inline: larger cover, description, tags, the
        path dropdown (autosaves labelled, never auto-selected), and Open / Favourite / Hide /
        Remove. A dev preview against sample data; the live cards render inside the shelved view in
        Phase 5.5b.
      </p>

      <div className="flex flex-wrap items-start gap-4 p-4 bg-zinc-950/40 border border-zinc-800 rounded min-h-[16rem]">
        {cards.length === 0 ? (
          <div className="text-xs text-zinc-500 py-8">All sample cards hidden / removed.</div>
        ) : (
          cards.map((c) => (
            <ProjectCard
              key={c.id}
              card={c}
              expanded={expandedId === c.id}
              onToggleExpand={() => setExpandedId((cur) => (cur === c.id ? null : c.id))}
              onOpen={(path) =>
                setLastAction(`Open "${c.title}" from ${path || '(no resolved path; picker)'}`)
              }
              onToggleFavourite={() => toggleFav(c.id)}
              onHide={() => drop(c.id, 'Hide')}
              onRemove={() => drop(c.id, 'Remove')}
            />
          ))
        )}
      </div>

      <div className="flex items-center gap-4 mt-3">
        <button
          type="button"
          onClick={reset}
          className="text-xs px-3 py-1 rounded border border-zinc-600 text-zinc-300 hover:text-zinc-100"
        >
          Reset sample cards
        </button>
        <span className="text-xs text-zinc-500">{lastAction ? `Last action: ${lastAction}` : 'No action yet.'}</span>
      </div>
    </div>
  )
}
