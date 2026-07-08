import { useMemo } from 'react'
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import { useProjectStore } from '../../store/projectStore'
import { getLiveStoryEntitiesShape } from '../../store/entitiesStore'
import { describeMarker } from '../../utils/markerResolver'
import { buildResolutionContext } from '../../utils/sceneContextPrompt'
import { getOrComputeStoryOrderFromStore } from '../../hooks/useStoryOrder'
import DynamicPillChip from './DynamicPillChip'
import { EntityAvatar, PovStartGlyph } from './IdentityBadges'
import { PinnedContextChip } from '../chat/ConversationView'

const _EMPTY = Object.freeze([])

/**
 * PinRow — single source of pin-row rendering for every surface.
 *
 * Replaces the duplicated `.map()` blocks at:
 *   - `ConversationView.ActiveContextStrip` (chat composer)
 *   - `PromptBlockForm` (Section PBH / IPB / Scene Description PBH)
 *
 * Subscribes to `pinnedContextStore.surfaces[surfaceKey]` so the
 * surface's pin list drives the render. Branches per item between
 * `<DynamicPillChip>` (marker-backed Tier 2) and `<PinnedContextChip>`
 * (static Tier 2 pins for entity / knowledge / relationship / scene /
 * cue / section / freetext). Wires `onRemove` and `onConfigChange`
 * through the unified store actions; `onPreview` and the chat-only
 * `onOpenAnchorPicker` come from the host since their behaviour is
 * surface-specific.
 *
 *   ─── ResolutionContext bundle — memoized + lazy ───────────────
 *
 * The bundle's only chain-walk is `precomputed.povCharacterName`
 * (chain-resolved at the host scene anchor via the same path the
 * send-time wire assembly uses). Building the bundle is cheap but
 * non-zero, so:
 *
 *   - Built only when at least one pin on the surface is dynamic.
 *     If every pin is static, the bundle is never built and the
 *     chain walk never fires.
 *
 *   - Memoized on `(anchorSceneId, nodes, edges, story)`. The
 *     project store's `nodes` / `edges` / `story` references are
 *     stable until the writer mutates them, so the bundle survives
 *     across unrelated re-renders (typing in the chat composer
 *     input, etc.).
 *
 * Props:
 *   - `surfaceKey`            — e.g. `'chat:<threadId>'` or `'block:<sectionId>'`
 *   - `flashScope`            — flash key prefix; defaults to `surfaceKey`
 *   - `anchorSceneId`         — host scene id for marker resolution; null when
 *                                 the surface has no active scene (chat with
 *                                 scene-context off; section PBH outside any scene)
 *   - `onPreview(item)`       — host-supplied preview opener; required
 *   - `onOpenAnchorPicker(item)` — chat-only; optional, omitted on PBH / IPB
 *   - `disabled`              — passes through to each chip's interactive controls
 */
export default function PinRow({
  surfaceKey,
  flashScope,
  anchorSceneId = null,
  onPreview,
  onOpenAnchorPicker,
  disabled = false,
}) {
  // Subscribe to the surface's bucket. Module-level `_EMPTY` fallback
  // avoids creating a new array per render for absent surfaces.
  const pins = usePinnedContextStore((s) => s.surfaces[surfaceKey]) || _EMPTY
  const removePin = usePinnedContextStore((s) => s.removePin)
  const updatePinMarker = usePinnedContextStore((s) => s.updatePinMarker)
  const updatePinMode = usePinnedContextStore((s) => s.updatePinMode)

  // Project state needed for the ResolutionContext bundle. Subscribed
  // so an update to nodes / edges / story re-fires the memo.
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const story = useProjectStore((s) => s.story)

  // Bundle build — lazy + memoized.
  const hasDynamic = useMemo(() => pins.some((p) => p && p.pin_kind === 'dynamic'), [pins])
  const dynamicCtx = useMemo(() => {
    if (!hasDynamic) return null
    const projectStore = useProjectStore.getState()
    const storyOrder = getOrComputeStoryOrderFromStore()
    // Live entities — `story.entities` from the project store is the
    // load-time snapshot and goes stale after any mid-session entity
    // edit (e.g. profile-image change, rename). Match what
    // `buildSceneContextBlock` does so the POV character's chain-walked
    // avatar / colour / name reflect live state.
    const liveStory = { ...(story || {}), entities: getLiveStoryEntitiesShape() }
    return buildResolutionContext(anchorSceneId || null, projectStore, liveStory, nodes, edges, storyOrder)
  }, [hasDynamic, anchorSceneId, nodes, edges, story])

  const scope = flashScope || surfaceKey

  if (!surfaceKey || pins.length === 0) return null

  return (
    <>
      {pins.map((item) => {
        if (!item) return null
        if (item.pin_kind === 'dynamic' && item.marker) {
          const desc = describeMarker(item.marker, dynamicCtx)
          const sourceLabel = item.source === 'prompt'
            ? 'attached by the active system prompt'
            : 'manually added'
          const tooltip = `Dynamic context, ${sourceLabel}. Auto-updates when the active scene, story state, or referenced object changes.`
          // Construct the inline identity badge for markers that
          // expose `identityBadgeData`. Currently only `pov_character`
          // does — it surfaces the POV entity's colour swatch + name
          // alongside `<PovStartGlyph />` so the writer sees WHICH
          // character is the current POV on the pill itself, and the
          // badge updates as the active scene changes.
          let identityBadge = null
          const badgeData = desc.identityBadgeData
          if (badgeData && badgeData.kind === 'pov' && badgeData.entityId) {
            // Build a minimal entity shape EntityAvatar can render
            // from. EntityAvatar reads `colour`, `profile_image_ref`,
            // and `type`; we already chain-resolved each via the
            // ResolutionContext bundle's precomputed slot, so this
            // does no additional store lookup.
            const avatarEntity = {
              id: badgeData.entityId,
              colour: badgeData.entityColour,
              profile_image_ref: badgeData.entityProfileImageRef,
              type: badgeData.entityType || 'character',
            }
            identityBadge = (
              <span className="inline-flex items-center gap-1">
                <PovStartGlyph />
                <EntityAvatar entity={avatarEntity} size={14} />
                <span
                  className="truncate max-w-[140px] font-medium"
                  style={badgeData.entityColour ? { color: badgeData.entityColour } : undefined}
                >
                  {badgeData.entityName || '(POV character)'}
                </span>
              </span>
            )
          }
          return (
            <DynamicPillChip
              key={item.sessionId}
              marker={item.marker}
              sessionId={item.sessionId}
              flashScope={scope}
              targetKey={desc.targetKey}
              resolvedLabel={desc.label}
              silentSkip={desc.silentSkip}
              tooltip={tooltip}
              identityBadge={identityBadge}
              disabled={disabled}
              onPreview={() => onPreview && onPreview(item)}
              onRemove={() => removePin(surfaceKey, item.sessionId)}
              onConfigChange={(nextMarker) => updatePinMarker(surfaceKey, item.sessionId, nextMarker)}
            />
          )
        }
        return (
          <PinnedContextChip
            key={item.sessionId}
            item={item}
            anchorSceneId={anchorSceneId}
            sceneContextEnabled={!!anchorSceneId}
            flashScope={scope}
            onPreview={() => onPreview && onPreview(item)}
            onRemove={() => removePin(surfaceKey, item.sessionId)}
            onCycleMode={item.kind === 'scene' ? (nextMode) => updatePinMode(surfaceKey, item.sessionId, nextMode) : undefined}
            onOpenAnchorPicker={onOpenAnchorPicker ? () => onOpenAnchorPicker(item) : undefined}
          />
        )
      })}
    </>
  )
}
