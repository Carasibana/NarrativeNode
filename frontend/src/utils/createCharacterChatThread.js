import { computeEffectiveState } from './narrativeChain'
import { latestAnchorNodeIdFromPins } from './characterChatAnchorMeta'

/**
 * Phase 2.11b — shared helper for creating a character-chat thread
 * from the CharacterChatSetupModal's `onConfirm` payload.
 *
 * Two entry points feed into this:
 *   - ThreadBrowser "🎭 Talk to a Character" button (no character
 *     pre-selected; writer picks one in the modal).
 *   - EntityDetailView "🎭 Talk to this character" button (character
 *     pre-selected from the focused entity; anchor pre-seeded from
 *     the panel's current chain position).
 *
 * Both flows hit the same Setup modal and surface the same confirm
 * payload; this helper handles the post-confirm seeding so the two
 * call-sites don't drift on auto-name resolution / profile fallback /
 * createThread shape.
 *
 * Name resolution is chain-aware via `computeEffectiveState` at the
 * latest anchor in the spec — picking an anchor where the character
 * has been renamed mid-chain means the thread title reflects that
 * renamed identity, not baseline.
 *
 * Deps argument is the host's wired-in stores / prefs so the helper
 * stays pure (no direct store imports — easier to test, easier to
 * reason about side-effects).
 */
export async function createCharacterChatThread(meta, opts, deps) {
  const {
    createThread,
    prefs,
    charactersList,
    projectNodes,
    projectEdges,
  } = deps

  const character = (charactersList || []).find((c) => c.id === meta.character_id)
  const latestAnchor = latestAnchorNodeIdFromPins(meta.anchor_spec)
  let resolvedName = null
  if (character) {
    try {
      const eff = computeEffectiveState(character, projectNodes || [], projectEdges || [], latestAnchor || null)
      resolvedName = eff?.name || character.name || null
    } catch {
      resolvedName = character.name || null
    }
  }
  const charName = resolvedName || 'character'
  const titleOverride = (opts?.title_override && opts.title_override.trim()) || null
  const name = titleOverride || `🎭 ${charName}`

  const seed = {
    name,
    profile_id: meta.model_id_override?.profile_id
      || prefs?.ai_default_model?.profile_id
      || (prefs?.ai_provider_profiles || [])[0]?.id
      || null,
    model: meta.model_id_override?.model || prefs?.ai_default_model?.model || null,
    system_prompt_id: meta.system_prompt_id,
    character_chat: meta,
  }
  return createThread(seed)
}


/**
 * Phase 2.12 — sibling helper for creating a TWO-character chat
 * thread from the back-to-back CharacterChatSetupModal flow (modal 1
 * configures Character 1, modal 2 configures Character 2, second
 * modal's Start Chat hands both metas here).
 *
 * `firstMeta` / `secondMeta` are both `CharacterChatMeta`-shaped
 * objects emitted by `CharacterChatSetupModal`'s `_buildMeta`.
 * `firstMeta` becomes `characters[0]` (Character 1, the UI's
 * assistant-side speaker); `secondMeta` becomes `characters[1]`
 * (Character 2, the UI's user-side speaker). The auto-name is
 * chain-aware per character — each name resolves at its OWN latest
 * anchor (so a thread named at a scene where Character 1 has been
 * renamed reflects that, independently of Character 2's anchor).
 *
 * The seeded `Conversation` has `two_character_chat` set and
 * `character_chat` null. Profile / model fallback uses
 * `firstMeta.model_id_override` as the thread-level connection
 * metadata (the wire-builder picks the right per-character model
 * override at send time, so the thread-level fields just need to be
 * SOMETHING coherent — going with Character 1's pick keeps the
 * thread-create path simple). `system_prompt_id` likewise rides
 * Character 1's pick at the thread level; the per-character
 * `system_prompt_id` fields inside `TwoCharacterChatMeta.characters`
 * are the authoritative ones the assembly path consumes.
 *
 * Same `deps` shape as the single-character helper for consistency
 * across entry points.
 */
export async function createTwoCharacterChatThread(firstMeta, secondMeta, opts, deps) {
  const {
    createThread,
    prefs,
    charactersList,
    projectNodes,
    projectEdges,
  } = deps

  function _resolvedNameFor(meta) {
    const character = (charactersList || []).find((c) => c.id === meta.character_id)
    if (!character) return null
    const latestAnchor = latestAnchorNodeIdFromPins(meta.anchor_spec)
    try {
      const eff = computeEffectiveState(character, projectNodes || [], projectEdges || [], latestAnchor || null)
      return eff?.name || character.name || null
    } catch {
      return character.name || null
    }
  }
  const name1 = _resolvedNameFor(firstMeta) || 'Character 1'
  const name2 = _resolvedNameFor(secondMeta) || 'Character 2'
  const titleOverride = (opts?.title_override && opts.title_override.trim()) || null
  const name = titleOverride || `🎭⇆🎭 ${name1} & ${name2}`

  const twoMeta = {
    characters: [firstMeta, secondMeta],
    next_turn_index: 0,
    composer_mode: 'single',
  }

  const seed = {
    name,
    profile_id: firstMeta.model_id_override?.profile_id
      || prefs?.ai_default_model?.profile_id
      || (prefs?.ai_provider_profiles || [])[0]?.id
      || null,
    model: firstMeta.model_id_override?.model || prefs?.ai_default_model?.model || null,
    system_prompt_id: firstMeta.system_prompt_id,
    two_character_chat: twoMeta,
  }
  return createThread(seed)
}
