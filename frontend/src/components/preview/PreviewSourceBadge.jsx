import { useMemo } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useEntityById } from '../../hooks/useEntityById'
import { computeEffectiveState } from '../../utils/narrativeChain'
import ImageHoverPreview from '../ui/ImageHoverPreview'

// Colour + label palette for the node-state badge. Kept in sync visually with
// the identical palette in `AlertsPanel.jsx` so chain-position badges in the
// preview header read the same way as alert badges that navigate to canvas nodes.
const NODE_BADGE_STYLES = {
  scene:    { label: 'SCENE',    labelCls: 'text-purple-400', bgCls: 'bg-purple-900/30 hover:bg-purple-900/50' },
  origin:   { label: 'NEW',      labelCls: 'text-green-400',  bgCls: 'bg-green-900/30 hover:bg-green-900/50'  },
  modifier: { label: 'MODIFIER', labelCls: 'text-amber-400',  bgCls: 'bg-amber-900/30 hover:bg-amber-900/50'  },
}

/**
 * Clickable badge identifying the chain position the preview was opened from.
 *
 * Matches the `AlertNodeBadge` styling from `AlertsPanel.jsx` exactly:
 * a single rounded pill with a coloured tint bg, a coloured uppercase label
 * span, and the specific node/entity name in white normal-case text after it.
 *
 *   sceneNode            → [SCENE]    + scene title
 *   entityNode, !is_modifier → [NEW : CHARACTER]    + entity name
 *   entityNode, is_modifier  → [MODIFIER : CHARACTER] + entity name
 *
 * Clicking the badge calls `useUiStore._focusNode(nodeId)` — the same canvas
 * pan/zoom action the alerts panel uses so the format and function match.
 */
function NodeStateBadge({ nodeId }) {
  const focusNode = useUiStore((s) => s._focusNode)
  const nodes = useProjectStore((s) => s.nodes)
  // Subscribe to all entity buckets so the badge's entity-type label stays in
  // sync if entities are renamed / retyped while the preview is open.
  const entCharacters  = useEntitiesStore((s) => s.characters)
  const entLocations   = useEntitiesStore((s) => s.locations)
  const entItems       = useEntitiesStore((s) => s.items)
  const entFactions    = useEntitiesStore((s) => s.factions)
  const entCustoms     = useEntitiesStore((s) => s.customs)
  const entKnowledges  = useProjectStore((s) => s.knowledges)

  if (!nodeId) return null
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return null

  // Compute `label` (coloured uppercase prefix like "SCENE" or "NEW : CHARACTER")
  // and `name` (white specific identifier — scene title or entity name).
  let style, label, name
  if (node.type === 'sceneNode') {
    style = NODE_BADGE_STYLES.scene
    label = 'SCENE'
    name = node.data?.title || node.data?.description || 'Untitled Scene'
  } else if (node.type === 'entityNode') {
    const entityId = node.data?.entity_id
    let entity = null
    if (entityId) {
      entity = [...entCharacters, ...entLocations, ...entItems, ...entFactions, ...entCustoms, ...(entKnowledges || [])]
        .find((e) => e.id === entityId)
    }
    const typeName = entity?.type ? entity.type.toUpperCase() : ''
    if (node.data?.is_modifier) {
      style = NODE_BADGE_STYLES.modifier
      label = 'MODIFIER' + (typeName ? ` : ${typeName}` : '')
      name = node.data?.name_change || entity?.name || 'Unknown'
    } else {
      style = NODE_BADGE_STYLES.origin
      label = 'NEW' + (typeName ? ` : ${typeName}` : '')
      name = entity?.name || 'Unknown'
    }
  } else {
    return null
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (focusNode) focusNode(nodeId) }}
      title={`Focus on this ${node.type === 'sceneNode' ? 'scene' : (node.data?.is_modifier ? 'modifier node' : 'origin node')}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] uppercase tracking-wide font-semibold cursor-pointer transition-colors flex-shrink-0 ${style.bgCls}`}
    >
      <span className={style.labelCls}>{label}</span>
      <span className="text-zinc-100 normal-case tracking-normal font-semibold truncate max-w-[140px]">{name}</span>
    </button>
  )
}

/**
 * Interactive source badge for the Media Preview Panel header.
 *
 * Renders one of two layouts based on `source.type`:
 *
 *   - attribute: small profile image (entity colour border) + entity name + attribute name
 *   - reference_node: "REFERENCE : MEDIA" badge + the node's title
 *
 * Clicking the badge routes back to the source:
 *   - attribute → opens the left Detail Panel on that entity's origin, Attributes tab
 *   - reference_node → pans/zooms the canvas to centre the node
 */
export default function PreviewSourceBadge({ source }) {
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const focusNode = useUiStore((s) => s._focusNode)

  // For reference_node sources, subscribe to the live node data so the badge
  // updates when the user edits the node's colour or title on the canvas while
  // the preview is open. Selectors return primitives (colour / title strings)
  // so Zustand's equality check only triggers a re-render when those specific
  // fields change — not on unrelated node updates. Falls back to the snapshot
  // in the source descriptor if the node was deleted.
  const liveRefColour = useProjectStore((s) => {
    if (source?.type !== 'reference_node') return null
    const n = s.nodes.find((node) => node.id === source.nodeId)
    return n?.data?.colour ?? null
  })
  const liveRefTitle = useProjectStore((s) => {
    if (source?.type !== 'reference_node') return null
    const n = s.nodes.find((node) => node.id === source.nodeId)
    return n?.data?.title ?? null
  })

  // For attribute sources, look up the entity and chain-walk to its effective
  // state at the anchor position (`source.atNodeId`). This reflects any mid-chain
  // edits to the entity's name / colour / profile image / attribute name at the
  // position where the media was accessed from — keeping the badge visually in
  // sync with what the user sees on the canvas chip they clicked.
  const entity = useEntityById(source?.type === 'attribute' ? source.entityId : null)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const effectiveState = useMemo(() => {
    if (source?.type !== 'attribute' || !entity) return null
    return computeEffectiveState(entity, nodes, edges, source.atNodeId || null)
  }, [source, entity, nodes, edges])

  if (!source) return null

  if (source.type === 'chat_attachment') {
    // Chat-attachment branch — Phase 2.5e. Source carries the
    // filename (`title`), file size in bytes (`size`), and the
    // story's active accent colour (`colour`). No back-navigation
    // target (the attachment lives only in the chat composer; the
    // chat panel itself is the natural home, no canvas focus
    // possible).
    const accent = source.colour || '#a78bfa'
    const filename = source.title || 'Attachment'
    const sizeLabel = _formatBytes(source.size)
    return (
      <div className="flex items-center gap-2 min-w-0 px-1 py-0.5" data-help-region="badge:preview_source">
        <span
          className="rounded-sm flex-shrink-0"
          style={{
            width: 20,
            height: 20,
            backgroundColor: accent,
            border: `1.5px solid ${accent}`,
          }}
        />
        <div className="flex flex-col items-start min-w-0 leading-tight">
          <span
            className="text-xs truncate max-w-[260px] font-semibold"
            style={{ color: accent }}
            title={filename}
          >
            {filename}
          </span>
          {sizeLabel && (
            <span className="text-[10px] text-zinc-400">{sizeLabel}</span>
          )}
        </div>
      </div>
    )
  }

  function handleClick(e) {
    e.stopPropagation()
    if (source.type === 'attribute') {
      // Resolve the entity's origin entity_node id so we can open the detail panel
      // on the origin state (chainIndex 0). Matches the pattern used in Canvas.jsx
      // for entity-node double-click navigation.
      const nodes = useProjectStore.getState().nodes
      const originNode = nodes.find(
        (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === source.entityId
      )
      if (originNode) {
        setDetailPanel('entityNode', originNode.id, source.entityId, 0, 'attributes')
      }
      return
    }
    if (source.type === 'entity_profile') {
      // Same origin-detail-panel navigation as `attribute`, but lands on the
      // default sub-tab (no `'attributes'` argument) — profile image lives on
      // the entity's identity, not on the attributes tab.
      const nodes = useProjectStore.getState().nodes
      const originNode = nodes.find(
        (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === source.entityId
      )
      if (originNode) {
        setDetailPanel('entityNode', originNode.id, source.entityId, 0)
      }
      return
    }
    if (source.type === 'reference_node') {
      if (focusNode) focusNode(source.nodeId)
      return
    }
  }

  if (source.type === 'reference_node') {
    // Prefer live node data; fall back to the descriptor snapshot if the node
    // was deleted from the canvas while the preview is still open.
    const badgeColour = liveRefColour ?? source.colour ?? undefined
    const badgeTitle = liveRefTitle ?? source.title ?? 'Untitled'
    // Single pill matching the AlertNodeBadge style: coloured bg tint using
    // the node colour at ~20% alpha, coloured label, white title. Matches the
    // NodeStateBadge and the orphaned-entity alert badge visual convention.
    return (
      <button
        type="button"
        onClick={handleClick}
        data-help-region="badge:preview_source"
        title="Click to focus source node on the canvas"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold cursor-pointer transition-colors min-w-0"
        style={badgeColour ? {
          backgroundColor: `${badgeColour}22`,  // ~13% alpha tint of the node colour
        } : undefined}
      >
        <span
          className="flex-shrink-0"
          style={badgeColour ? { color: badgeColour } : undefined}
        >
          REFERENCE : MEDIA
        </span>
        <span className="text-zinc-100 normal-case tracking-normal font-semibold truncate">
          {badgeTitle}
        </span>
      </button>
    )
  }

  if (source.type === 'entity_profile') {
    // Entity profile-image source. Descriptor carries snapshot values for
    // `entityName` + `entityColour` from the call site (EntityAvatar passes
    // them through verbatim — already chain-resolved by whichever surface
    // mounted the avatar). The asset URL used for the thumbnail mirrors
    // EntityAvatar's own URL resolution: `assets/...` paths route through
    // the project-asset endpoint; `data:` URLs render directly. Click →
    // opens the entity's origin detail panel, same as the attribute branch.
    const displayName = source.entityName || 'Entity'
    const displayColour = source.entityColour || '#888888'
    const profileRef = source.fileRef || source.url || null
    let thumbSrc = null
    if (profileRef) {
      if (profileRef.startsWith('data:')) {
        thumbSrc = profileRef
      } else {
        thumbSrc = `/api/project/assets/${profileRef.replace(/^assets\//, '')}`
      }
    }
    const thumbBorder = `1.5px solid ${displayColour}`
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(e) }}
        data-help-region="badge:preview_source"
        title="Click to focus this entity in the details sidebar"
        className="flex items-center gap-2 min-w-0 cursor-pointer hover:bg-zinc-700/40 rounded px-1 py-0.5 transition-colors"
      >
        {thumbSrc && (
          <img
            src={thumbSrc}
            alt=""
            className="rounded-sm object-cover flex-shrink-0"
            style={{ width: 20, height: 20, border: thumbBorder }}
          />
        )}
        <div className="flex flex-col items-start min-w-0 leading-tight">
          <span
            className="text-xs truncate max-w-[220px] font-semibold"
            style={{ color: displayColour }}
          >
            {displayName}
          </span>
          <span className="text-[10px] text-zinc-400 truncate max-w-[220px]">Profile image</span>
        </div>
      </div>
    )
  }

  // attribute source — prefer the chain-walked effective state for name / colour /
  // profile image / attribute name, falling back to the source descriptor's snapshot
  // values if the entity was deleted while the preview is still open.
  const effectiveAttr = effectiveState?.attributes?.find((a) => a.id === source.attributeId) || null
  const displayEntityName  = effectiveState?.name          ?? source.entityName    ?? 'Entity'
  const displayEntityColour = effectiveState?.colour       ?? source.entityColour  ?? null
  const displayProfileRef  = effectiveState?.profile_image_ref ?? source.profileImageRef ?? null
  const displayAttrName    = effectiveAttr?.name           ?? source.attributeName ?? 'Attribute'

  const assetName = displayProfileRef ? displayProfileRef.replace(/^assets\//, '') : null
  const imgBorder = displayEntityColour ? `1.5px solid ${displayEntityColour}` : '1.5px solid #888888'

  // Outer container is a div (not a button) so the nested NodeStateBadge
  // button is valid HTML — nested interactive elements are an accessibility
  // anti-pattern. Still clickable via onClick + role="button".
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(e) }}
      data-help-region="badge:preview_source"
      title="Click to focus source in the entity details sidebar"
      className="flex items-center gap-2 min-w-0 cursor-pointer hover:bg-zinc-700/40 rounded px-1 py-0.5 transition-colors"
    >
      {assetName ? (
        <ImageHoverPreview
          src={`/api/project/assets/${assetName}`}
          borderColour={displayEntityColour}
          size={100}
        >
          <img
            src={`/api/project/assets/${assetName}`}
            alt=""
            className="rounded-sm object-cover flex-shrink-0"
            style={{ width: 20, height: 20, border: imgBorder }}
          />
        </ImageHoverPreview>
      ) : (
        <span
          className="rounded-sm flex-shrink-0"
          style={{
            width: 20,
            height: 20,
            backgroundColor: displayEntityColour || '#52525b',
            border: imgBorder,
          }}
        />
      )}
      <div className="flex flex-col items-start min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-xs truncate max-w-[220px] font-semibold"
            style={displayEntityColour ? { color: displayEntityColour } : { color: '#e4e4e7' }}
          >
            {displayEntityName}
          </span>
          {/* Chain-position badge: identifies WHERE this preview is anchored
              (scene / origin / modifier) and clicks to pan the canvas to that
              node. Same visual + function pattern as the Alerts panel's node
              badges so users recognise it. */}
          <NodeStateBadge nodeId={source.atNodeId} />
        </div>
        <span className="text-[10px] text-zinc-400 truncate max-w-[220px]">{displayAttrName}</span>
      </div>
    </div>
  )
}


// Bytes → "1.4 KB" / "2.3 MB" / etc. Used by the chat_attachment
// badge layout to display the picked file's size as the sub-label
// under the filename. Matches the helper in AttachedFileChips.jsx
// (kept inline rather than shared to avoid an utility-module pull
// for a six-line helper).
function _formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
}
