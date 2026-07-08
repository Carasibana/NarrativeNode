/**
 * ExportDialogScopeTree — Phase 1.12a Track 9 frontend.
 *
 * Hierarchical scene picker used by the Export dialog's Scope
 * section. Renders acts → chapters → scenes (plus any unchaptered
 * POV scenes + off-screen scenes at the top level) as a tree of
 * tri-state checkboxes so the user can select exactly which scenes
 * end up in the export. Scene checkboxes drive the ultimate
 * `scope_scene_ids` list that gets POSTed to the backend.
 *
 * Tri-state semantics:
 *   - unchecked: no descendants are selected
 *   - checked: every descendant is selected
 *   - mixed (indeterminate): some but not all descendants are
 *     selected. Clicking a mixed or unchecked parent selects all
 *     descendants; clicking a fully-checked parent deselects all
 *     descendants.
 *
 * Structure pulled from `projectStore.story`:
 *   - story.acts, story.chapters, story.chapter_x_offset
 *   - projectStore.nodes + edges (for computePovChain)
 *
 * Reuses the same helpers as TableOfContentsPanel:
 *   - `computePovChain` for POV-chain ordering of scenes
 *   - `resolveChapterIdForNode` (mode-aware) for assigning scenes to chapters
 *
 * The tree is a controlled component: the parent owns the
 * `selectedIds: Set<string>` state and passes an `onToggle(nodeId)`
 * callback for scene clicks + an `onToggleBulk(nodeIds, select)`
 * callback for chapter / act bulk toggles.
 */

import { useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { computePovChain } from '../../utils/povSequence'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { useChapterMemberOpts } from '../../hooks/useChapterMemberOpts'

const EMPTY_ARRAY = []

// ── Outline builder ───────────────────────────────────────────────────

/**
 * Compute the hierarchical scope outline: acts → chapters → scenes,
 * plus optional unchaptered / offscreen top-level groups. Returned
 * shape is intentionally flat enough to render via nested `.map()`
 * calls in the JSX.
 *
 * The outline does NOT carry any selection state — that's the
 * caller's job via `selectedIds`. The tree just shows the shape.
 */
function useScopeOutline() {
  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_ARRAY)
  const acts = useProjectStore((s) => s.story?.acts || EMPTY_ARRAY)
  const chapterMemberOpts = useChapterMemberOpts()
  const chapterLabel = useProjectStore((s) => s.story?.chapter_label) || 'Chapter'
  const actLabel = useProjectStore((s) => s.story?.act_label) || 'Act'
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)

  return useMemo(() => {
    const povChain = computePovChain(nodes, edges)
    // Collect POV-chain scenes, grouped by chapter id
    const scenesByChapter = new Map()
    const unchapteredScenes = []
    for (const entry of povChain.sequence) {
      const node = nodes.find((n) => n.id === entry.nodeId)
      if (!node || node.type !== 'sceneNode') continue
      const chapterId = resolveChapterIdForNode(node, chapters, chapterMemberOpts)
      const sceneEntry = {
        nodeId: node.id,
        label:
          node.data?.title ||
          node.data?.description ||
          `Scene ${entry.index}`,
        chainIndex: entry.index,
      }
      if (!chapterId) {
        unchapteredScenes.push(sceneEntry)
        continue
      }
      if (!scenesByChapter.has(chapterId)) scenesByChapter.set(chapterId, [])
      scenesByChapter.get(chapterId).push(sceneEntry)
    }

    // Collect offscreen scenes (plot-point nodes NOT on the POV chain)
    const povNodeIds = new Set(povChain.sequence.map((e) => e.nodeId))
    const offscreenScenes = nodes
      .filter(
        (n) =>
          n.type === 'sceneNode' &&
          !povNodeIds.has(n.id) &&
          !n.data?.is_flashback,
      )
      // Presentation ordering only (NOT a chain-order claim — off-POV scenes
      // have no defined narrative order). Canvas x-position is the user's
      // visual arrangement, which is the most intuitive reading order for
      // this export-scope listing.
      .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0))
      .map((n) => ({
        nodeId: n.id,
        label: n.data?.title || n.data?.description || 'Untitled Scene',
      }))

    // Chapter id → Act metadata lookup
    const actByChapter = new Map()
    acts.forEach((a) => {
      for (const cid of a.chapter_ids || []) {
        actByChapter.set(cid, a)
      }
    })

    // Walk chapters[] in order, grouping contiguous runs into
    // sections when they belong to the same act.
    const sections = []
    let currentSection = null
    let currentActId = '__INIT__'
    chapters.forEach((c, i) => {
      const act = actByChapter.get(c.id) || null
      const actId = act?.id ?? null
      if (actId !== currentActId) {
        if (actId) {
          const actIdx = acts.findIndex((a) => a.id === actId)
          currentSection = {
            type: 'act',
            id: act.id,
            label: act.title
              ? `${actLabel} ${actIdx + 1}: ${act.title}`
              : `${actLabel} ${actIdx + 1}`,
            chapters: [],
          }
        } else {
          currentSection = { type: 'no-act', id: `no-act-${i}`, chapters: [] }
        }
        sections.push(currentSection)
        currentActId = actId
      }
      currentSection.chapters.push({
        id: c.id,
        label: c.title
          ? `${chapterLabel} ${i + 1}: ${c.title}`
          : `${chapterLabel} ${i + 1}`,
        scenes: scenesByChapter.get(c.id) || [],
      })
    })

    return {
      sections,
      unchapteredScenes,
      offscreenScenes,
    }
  }, [
    chapters,
    acts,
    chapterMemberOpts,
    chapterLabel,
    actLabel,
    nodes,
    edges,
  ])
}

// ── Selection helpers ─────────────────────────────────────────────────

/**
 * For a group of scene ids, determine whether they're all selected,
 * none selected, or partially selected. Returns "all" / "none" /
 * "mixed". An empty group counts as "none".
 */
function groupState(sceneIds, selectedIds) {
  if (!sceneIds.length) return 'none'
  let selectedCount = 0
  for (const id of sceneIds) {
    if (selectedIds.has(id)) selectedCount += 1
  }
  if (selectedCount === 0) return 'none'
  if (selectedCount === sceneIds.length) return 'all'
  return 'mixed'
}

/** Flatten a chapter's scene ids into a plain array. */
function chapterSceneIds(chapter) {
  return chapter.scenes.map((s) => s.nodeId)
}

/** Flatten an act (or no-act section)'s scene ids across all chapters. */
function sectionSceneIds(section) {
  const ids = []
  for (const chapter of section.chapters) {
    for (const scene of chapter.scenes) ids.push(scene.nodeId)
  }
  return ids
}

// ── Tri-state checkbox primitive ──────────────────────────────────────

function TriCheckbox({ state, onClick, label, className = '', dataHelpRegion }) {
  const ref = (el) => {
    if (el) el.indeterminate = state === 'mixed'
  }
  return (
    <label
      data-help-region={dataHelpRegion}
      className={`flex items-center gap-2 text-xs text-zinc-200 cursor-pointer hover:text-zinc-100 ${className}`}
    >
      <input
        type="checkbox"
        ref={ref}
        checked={state === 'all'}
        onChange={onClick}
        className="accent-accent-500"
      />
      <span className="truncate">{label}</span>
    </label>
  )
}

// ── Main component ────────────────────────────────────────────────────

export default function ExportDialogScopeTree({ selectedIds, onChange }) {
  const outline = useScopeOutline()

  /**
   * Toggle a single scene id in/out of the selection set. Takes a
   * target state for convenience: pass `true` to force-select, `false`
   * to force-deselect, or omit to flip.
   */
  function toggleScene(nodeId, forceState) {
    const next = new Set(selectedIds)
    const isSelected = next.has(nodeId)
    const target = forceState === undefined ? !isSelected : forceState
    if (target) next.add(nodeId)
    else next.delete(nodeId)
    onChange(next)
  }

  /** Bulk add/remove a list of scene ids in one update. */
  function toggleBulk(nodeIds, select) {
    if (!nodeIds.length) return
    const next = new Set(selectedIds)
    if (select) {
      for (const id of nodeIds) next.add(id)
    } else {
      for (const id of nodeIds) next.delete(id)
    }
    onChange(next)
  }

  /** Clicking an act / chapter bulk-toggles based on current state. */
  function handleGroupClick(groupIds, currentState) {
    // mixed or none → select all; all → deselect all
    toggleBulk(groupIds, currentState !== 'all')
  }

  const hasAnyContent =
    outline.sections.length > 0 ||
    outline.unchapteredScenes.length > 0 ||
    outline.offscreenScenes.length > 0

  if (!hasAnyContent) {
    return (
      <div className="text-[11px] text-zinc-500 italic px-2 py-3">
        No scenes found in this story.
      </div>
    )
  }

  return (
    <div className="border border-zinc-700 rounded bg-zinc-900/40 max-h-[260px] overflow-y-auto p-2 space-y-1">
      {/* Unchaptered group — top-level when present */}
      {outline.unchapteredScenes.length > 0 && (
        <SectionGroup
          label="Unchaptered"
          groupIds={outline.unchapteredScenes.map((s) => s.nodeId)}
          selectedIds={selectedIds}
          onGroupClick={handleGroupClick}
        >
          {outline.unchapteredScenes.map((scene) => (
            <SceneRow
              key={scene.nodeId}
              scene={scene}
              selectedIds={selectedIds}
              onToggle={toggleScene}
              indent={1}
            />
          ))}
        </SectionGroup>
      )}

      {/* Act + no-act sections */}
      {outline.sections.map((section) => (
        <SectionBlock
          key={section.id}
          section={section}
          selectedIds={selectedIds}
          onToggleScene={toggleScene}
          onGroupClick={handleGroupClick}
        />
      ))}

      {/* Off-screen scenes group — top-level when present */}
      {outline.offscreenScenes.length > 0 && (
        <SectionGroup
          label="Off-screen scenes"
          groupIds={outline.offscreenScenes.map((s) => s.nodeId)}
          selectedIds={selectedIds}
          onGroupClick={handleGroupClick}
        >
          {outline.offscreenScenes.map((scene) => (
            <SceneRow
              key={scene.nodeId}
              scene={scene}
              selectedIds={selectedIds}
              onToggle={toggleScene}
              indent={1}
            />
          ))}
        </SectionGroup>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────

function SectionBlock({ section, selectedIds, onToggleScene, onGroupClick }) {
  const groupIds = sectionSceneIds(section)
  const state = groupState(groupIds, selectedIds)
  const actLabel = section.type === 'act' ? section.label : null

  return (
    <div className="space-y-0.5">
      {actLabel && (
        <TriCheckbox
          state={state}
          onClick={() => onGroupClick(groupIds, state)}
          label={actLabel}
          className="font-semibold text-zinc-100"
          dataHelpRegion="export-dialog:scope_tree_act"
        />
      )}
      {section.chapters.map((chapter) => (
        <ChapterRow
          key={chapter.id}
          chapter={chapter}
          selectedIds={selectedIds}
          onToggleScene={onToggleScene}
          onGroupClick={onGroupClick}
          indent={actLabel ? 1 : 0}
        />
      ))}
    </div>
  )
}

function ChapterRow({
  chapter,
  selectedIds,
  onToggleScene,
  onGroupClick,
  indent,
}) {
  const chapterIds = chapterSceneIds(chapter)
  const state = groupState(chapterIds, selectedIds)
  const indentStyle = { paddingLeft: `${indent * 16}px` }
  return (
    <div className="space-y-0.5">
      <div style={indentStyle}>
        <TriCheckbox
          state={state}
          onClick={() => onGroupClick(chapterIds, state)}
          label={`${chapter.label}  (${chapter.scenes.length} scene${chapter.scenes.length === 1 ? '' : 's'})`}
          className="font-medium"
          dataHelpRegion="export-dialog:scope_tree_chapter"
        />
      </div>
      {chapter.scenes.map((scene) => (
        <SceneRow
          key={scene.nodeId}
          scene={scene}
          selectedIds={selectedIds}
          onToggle={onToggleScene}
          indent={indent + 1}
        />
      ))}
    </div>
  )
}

function SceneRow({ scene, selectedIds, onToggle, indent }) {
  const isSelected = selectedIds.has(scene.nodeId)
  const indentStyle = { paddingLeft: `${indent * 16 + 4}px` }
  return (
    <div style={indentStyle}>
      <TriCheckbox
        state={isSelected ? 'all' : 'none'}
        onClick={() => onToggle(scene.nodeId)}
        label={scene.label}
        dataHelpRegion="export-dialog:scope_tree_scene"
      />
    </div>
  )
}

function SectionGroup({ label, groupIds, selectedIds, onGroupClick, children }) {
  const state = groupState(groupIds, selectedIds)
  return (
    <div className="space-y-0.5">
      <TriCheckbox
        state={state}
        onClick={() => onGroupClick(groupIds, state)}
        label={label}
        className="font-semibold text-zinc-100"
        dataHelpRegion="export-dialog:scope_tree_group"
      />
      {children}
    </div>
  )
}
