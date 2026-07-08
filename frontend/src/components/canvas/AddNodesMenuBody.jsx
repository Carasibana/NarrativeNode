/**
 * AddNodesMenuBody — the shared list of "add ___" buttons used by both
 * the canvas toolbar's `+` dropdown (`AddMenu` in CanvasToolbar.jsx) and
 * the canvas right-click context menu (`CanvasContextMenu` in Canvas.jsx).
 *
 * Each caller wraps this component in its own positioned container
 * (toolbar uses `absolute` dropdown, context menu uses `fixed` at
 * clientX/clientY) and handles its own close-on-outside-click +
 * Escape-to-close behaviour. This component is ONLY the content — the
 * list of action buttons.
 *
 * `flowPosition` is optional. If provided (the context-menu case), add
 * actions receive the flow-space cursor position so new nodes spawn
 * exactly where the user right-clicked. If null (the toolbar case),
 * each add action falls back to its own default — usually the viewport
 * centre or a random offset.
 *
 * `onClose` is called after any item is picked so the parent menu can
 * dismiss itself.
 */

import { usePovColor } from '../../utils/povConstants'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { KNOWLEDGE_COLOUR, RelationshipIcon } from '../ui/IdentityBadges'
import { TYPE_ICONS } from '../../utils/entityHelpers'

// Phase 1.21c: `knowledge` removed from ENTITY_TYPES - Knowledge is a
// first-class object, not an Entity subtype, so it doesn't open the
// EntityModal flow. The dedicated "Add Knowledge" button below the
// entity types opens the KnowledgeModal instead.
//
// Icons are pulled from TYPE_ICONS so the menu stays locked to the
// canonical library / chip glyphs - no risk of menu / library drift.
const ENTITY_TYPES = [
  { type: 'character', label: 'Character' },
  { type: 'location',  label: 'Location'  },
  { type: 'item',      label: 'Item'      },
  { type: 'faction',   label: 'Faction'   },
  { type: 'custom',    label: 'Custom'    },
]

export default function AddNodesMenuBody({ flowPosition = null, onClose }) {
  const povColor = usePovColor()
  const addSceneNode      = useProjectStore((s) => s.addSceneNode)
  const addFlashbackNode      = useProjectStore((s) => s.addFlashbackNode)
  const addReferenceNode      = useProjectStore((s) => s.addReferenceNode)
  const addPovOriginNode      = useProjectStore((s) => s.addPovOriginNode)
  const addModifierEntityNode = useProjectStore((s) => s.addModifierEntityNode)
  const addEmptyRelationshipOriginNode = useProjectStore((s) => s.addEmptyRelationshipOriginNode)
  const addGroupNode          = useProjectStore((s) => s.addGroupNode)
  const hasPovOrigin          = useProjectStore((s) => s.nodes.some((n) => n.type === 'povOriginNode'))
  const openNewEntityModal    = useUiStore((s) => s.openNewEntityModal)
  const openNewKnowledgeModal = useUiStore((s) => s.openNewKnowledgeModal)

  function pick(fn) {
    return () => { onClose?.(); fn() }
  }

  const btnCls = 'w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-2'
  const primaryBtnCls = 'w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 flex items-center gap-2'

  return (
    <>
      {/* POV Start - only when none exists */}
      {!hasPovOrigin && (
        <>
          <button
            data-help-region="add-nodes-menu:pov_start"
            className={primaryBtnCls}
            onClick={pick(() => addPovOriginNode(flowPosition))}
          >
            <span
              className="inline-flex items-center justify-center rounded-sm text-[8px] font-bold flex-shrink-0"
              style={{
                width: 28, height: 14,
                color: povColor,
                backgroundColor: '#27272a',
                border: `1.5px solid ${povColor}`,
                borderRadius: 3,
                lineHeight: 1,
              }}
            >POV</span>
            Add POV Start
          </button>
          <div className="border-t border-zinc-700 my-1" />
        </>
      )}

      {/* Phase 1.22j — Add Chapter is no longer in this menu. Chapters
          are added via double-click on empty space in the chapter row. */}

      {/* Scene + Flashback */}
      <button
        data-help-region="add-nodes-menu:scene"
        className={primaryBtnCls}
        onClick={pick(() => addSceneNode(flowPosition))}
      >
        <span className="text-accent-400 font-bold">+</span>
        Add Scene
      </button>
      <button
        data-help-region="add-nodes-menu:flashback"
        className={btnCls}
        onClick={pick(() => addFlashbackNode(flowPosition))}
      >
        <span className="text-purple-400 text-[9px] font-semibold">FB</span>
        Add Flashback Scene
      </button>

      <div className="border-t border-zinc-700 my-1" />

      {/* Entity types */}
      {ENTITY_TYPES.map(({ type, label }) => (
        <button
          key={type}
          data-help-region={`add-nodes-menu:${type}`}
          className={btnCls}
          onClick={pick(() => openNewEntityModal(type, flowPosition))}
        >
          <span>{TYPE_ICONS[type]}</span>
          Add {label}
        </button>
      ))}

      <div className="border-t border-zinc-700 my-1" />

      {/* Phase 1.21c - Knowledge create. Opens the same KnowledgeModal
          flow as the library's "+ New Knowledge" button so the user
          fills in name / colour / description / awareness up front.
          The modal's save callback spawns the origin node at
          `flowPosition` (passed via `knowledgeModalPendingPosition` in
          uiStore). Placed directly after the entity types so the menu
          order matches the library tab order: entity tabs, Knowledge,
          Relationships, then Modifier (no library equivalent). */}
      <button
        data-help-region="add-nodes-menu:knowledge"
        className={btnCls}
        onClick={pick(() => openNewKnowledgeModal(flowPosition))}
      >
        <span
          className="inline-flex items-center justify-center flex-shrink-0"
          style={{
            width: 12, height: 12,
            border: `1.5px solid ${KNOWLEDGE_COLOUR}`,
            borderRadius: 2,
            backgroundColor: `${KNOWLEDGE_COLOUR}22`,
            fontSize: 9,
            lineHeight: 1,
          }}
        >{TYPE_ICONS.knowledge}</span>
        Add Knowledge
      </button>

      {/* Empty relationship origin node - user wires participants in afterwards */}
      <button
        data-help-region="add-nodes-menu:relationship"
        className={btnCls}
        onClick={pick(() => addEmptyRelationshipOriginNode(flowPosition))}
      >
        <RelationshipIcon size={12} />
        Add Relationship
      </button>

      {/* Modifier node - no library tab equivalent, sits at the end of
          the entity-related group so the library-mirrored sequence
          (entity types -> Knowledge -> Relationships) stays adjacent
          and uninterrupted. */}
      <button
        data-help-region="add-nodes-menu:modifier"
        className={btnCls}
        onClick={pick(() => addModifierEntityNode(flowPosition))}
      >
        <span className="text-amber-400">{'✏'}</span>
        Add Modifier Node
      </button>

      <div className="border-t border-zinc-700 my-1" />

      {/* Reference nodes */}
      <button
        data-help-region="add-nodes-menu:reference_note"
        className={btnCls}
        onClick={pick(() => addReferenceNode(flowPosition, 'note'))}
      >
        <span className="text-zinc-400">{'✎'}</span>
        Add Reference Note
      </button>
      <button
        data-help-region="add-nodes-menu:reference_media"
        className={btnCls}
        onClick={pick(() => addReferenceNode(flowPosition, 'media'))}
      >
        <span className="text-zinc-400">{'▣'}</span>
        Add Reference Media
      </button>
      <button
        data-help-region="add-nodes-menu:reference_concept"
        className={btnCls}
        onClick={pick(() => addReferenceNode(flowPosition, 'concept'))}
      >
        <span className="text-zinc-400">{'◇'}</span>
        Add Concept
      </button>

      <div className="border-t border-zinc-700 my-1" />

      {/* Phase 1.11 Track I - Add Group container */}
      <button
        data-help-region="add-nodes-menu:group"
        className={btnCls}
        onClick={pick(() => addGroupNode(flowPosition))}
      >
        <span className="text-zinc-400">{'⧉'}</span>
        Add Group
      </button>
    </>
  )
}
