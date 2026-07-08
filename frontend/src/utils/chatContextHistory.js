import { buildSceneContextBlock } from './sceneContextPrompt'
import { getOrComputeStoryOrderFromStore } from '../hooks/useStoryOrder'
import { useProjectStore } from '../store/projectStore'

// The set of entity ids that are participants of the given scene (every
// entity_id across the scene node's character / location / item / faction /
// custom buckets). Used by the wire builder to dedup an entity that is BOTH
// a scene participant and a standalone pin (Phase 7.1 item 291): the scene
// block already renders it as a full participant dossier, so its separate
// pinned blocks are excluded from the wire. Empty set when scene context is
// off or the node is gone — every pin then rides as normal.
function _sceneParticipantIds(sceneId) {
  const ids = new Set()
  if (!sceneId) return ids
  const node = (useProjectStore.getState().nodes || []).find((n) => n.id === sceneId)
  if (!node) return ids
  for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
    for (const ref of (node.data?.[bucket] || [])) {
      if (ref?.entity_id) ids.add(ref.entity_id)
    }
  }
  return ids
}

/**
 * Phase 2.5d — Chat-context-history change detection + wire builder.
 *
 * This module owns the per-part change detection and the wire-
 * messages array sent to the LLM adapter on each send. Both pieces
 * live together because they share a tight contract: change
 * detection writes `system_context` messages into the thread; the
 * wire builder consumes those same messages, emitting each one as
 * a `role: system` wire entry at its natural position, with ride-
 * along for in-force parts whose blocks fall outside the rolling
 * window.
 *
 * Per-part state machine (from the planning doc):
 *
 *   prior state     | new state       | content changed? | emit
 *   ----------------+-----------------+------------------+-------------
 *   not in force    | in force        | (n/a)            | *_full
 *   in force        | in force        | no               | nothing
 *   in force        | in force        | yes              | *_diff
 *   in force        | not in force    | (n/a)            | *_removed
 *   not in force    | not in force    | (n/a)            | nothing
 *
 * Part identity key:
 *   - 'scene'                              — the scene part
 *   - 'pinned:<itemKind>:<itemId>'         — one pinned item
 */
export async function computeContextDiff(thread, activeSceneId, pinnedItems) {
  const messages = thread?.messages || []
  // Walk thread to find latest stored block per part. "Latest" =
  // most-recent emission of any kind, including `_removed`. A
  // part is "prior in force" iff its latest emission is NOT a
  // `_removed`.
  const latestByPart = _walkLatestByPart(messages)

  const blocks = []

  // Compute the expensive story order ONCE for this whole send and hand
  // it to every render below, so a multi-pin send pays the walk a single
  // time rather than once per pinned item (Option B renders each pin in
  // isolation — the cause of the multi-pin send perf spike). Skipped
  // entirely when there's nothing to render.
  let sharedStoryOrder = null
  if (activeSceneId || (Array.isArray(pinnedItems) && pinnedItems.length > 0)) {
    // Use the SHARED, structurally-cached story order (the same one the
    // canvas uses) so this is a near-free cache read on a send rather
    // than a fresh ~110ms graph walk. The cache survives node-array ref
    // churn via structural equality, so it only recomputes when the
    // ordering genuinely changes.
    sharedStoryOrder = getOrComputeStoryOrderFromStore()
  }

  // ── Scene part ─────────────────────────────────────────────────
  const sceneKey = 'scene'
  const sceneLatest = latestByPart.get(sceneKey)
  const scenePriorInForce = !!sceneLatest && !sceneLatest.kind.endsWith('_removed')
  const sceneNowInForce = !!activeSceneId

  if (sceneNowInForce && !scenePriorInForce) {
    const content = await _safeRender({ sceneId: activeSceneId, pinnedItems: [], storyOrder: sharedStoryOrder })
    if (content) blocks.push({ kind: 'scene_full', content, scene_id: activeSceneId })
  } else if (sceneNowInForce && scenePriorInForce) {
    // Distinguish "same scene, content edited" from "writer switched
    // to a different scene". A switch is two events — the prior
    // scene is no longer in focus (scene_removed), the new scene is
    // now in focus (scene_full) — and the wire should read that way
    // so the model doesn't interpret it as a single edit that
    // happens to change every field at once.
    //
    // Identity comparison uses `scene_id` on the prior block when
    // present; falls back to title parsing for blocks emitted before
    // the field was added.
    const priorSceneId = sceneLatest.scene_id
      || sceneLatest.sceneId  // tolerate camelCase from older JS-side writes
      || null
    const priorTitle = _sceneTitleFromBlock(sceneLatest)
    const newContent = await _safeRender({ sceneId: activeSceneId, pinnedItems: [], storyOrder: sharedStoryOrder })
    if (!newContent) {
      // Render failure — no emission.
    } else if (priorSceneId && priorSceneId !== activeSceneId) {
      // Clear identity switch — record it as a single "changed scene
      // X → Y" marker (a minimal old-scene record) followed by the new
      // scene's full block, instead of a remove + add the model might
      // misread as one giant edit. Old + new titles ride in `content`
      // as JSON so no new persisted block field is needed.
      blocks.push({ kind: 'scene_switch', content: JSON.stringify({ from: priorTitle || '', to: _sceneTitleFromRender(newContent) || '' }), scene_id: activeSceneId })
      blocks.push({ kind: 'scene_full', content: newContent, scene_id: activeSceneId })
    } else if (!priorSceneId && priorTitle) {
      // Legacy block without scene_id — fall back to title compare.
      const newTitle = _sceneTitleFromRender(newContent)
      if (newTitle && newTitle !== priorTitle) {
        blocks.push({ kind: 'scene_switch', content: JSON.stringify({ from: priorTitle, to: newTitle }), scene_id: activeSceneId })
        blocks.push({ kind: 'scene_full', content: newContent, scene_id: activeSceneId })
      } else if (newContent !== (sceneLatest.content || '')) {
        blocks.push({ kind: 'scene_diff', content: newContent, scene_id: activeSceneId })
      }
    } else if (newContent !== (sceneLatest.content || '')) {
      // Same scene, edited content.
      blocks.push({ kind: 'scene_diff', content: newContent, scene_id: activeSceneId })
    }
  } else if (!sceneNowInForce && scenePriorInForce) {
    // Capture the scene title at write time so the wire's one-liner
    // marker can read "[Context removed: scene "X"]" without having
    // to walk back through prior blocks.
    const title = _sceneTitleFromBlock(sceneLatest)
    blocks.push({ kind: 'scene_removed', content: title || '' })
  }

  // ── Pinned parts — per-item (Option B) ─────────────────────────
  // Each currently-pinned item is its OWN part (key
  // `pinned:<kind>:<id>`), rendered in isolation via the pinned-only
  // render path anchored at the active scene. Consequences:
  //   - A pill added or changed mid-conversation is its own
  //     full/diff block, item-aware by construction, so same-named
  //     fields across different pins never collide (the v0.6.2.14 bug
  //     class is gone structurally, not by text-diffing the set).
  //   - An unpinned item simply stops being emitted; it gets no new
  //     block and (via the wire builder's in-force filter) vanishes
  //     from the wire entirely. No "removed" marker: silent + total
  //     removal, per the design.
  //   - Rendering one item at a time uses the pinned-only path
  //     (`hostSceneId` anchor, no `sceneId`), so a pin never re-emits
  //     the scene block inside itself.
  //
  // Read-side shim: a thread written before Option B holds a single
  // whole-set `pinned` block (no item_id). Its part key stays
  // 'pinned'; per-item keys never collide with it, so old threads keep
  // rendering their historical block while every new change emits per
  // item from here on. Clearing all pins closes out an in-force legacy
  // block with a removed marker so it stops riding along.
  const pinnedNowInForce = Array.isArray(pinnedItems) && pinnedItems.length > 0
  if (pinnedNowInForce) {
    for (const item of pinnedItems) {
      if (!item || !item.id) continue
      const itemKind = item.kind || ''
      const itemKey = `pinned:${itemKind}:${item.id}`
      const prior = latestByPart.get(itemKey)
      const priorInForce = !!prior && !prior.kind.endsWith('_removed')
      const itemContent = await _safeRender({ pinnedItems: [item], hostSceneId: activeSceneId, storyOrder: sharedStoryOrder })
      if (!itemContent) continue
      if (!priorInForce) {
        blocks.push({ kind: 'pinned_full', item_kind: itemKind, item_id: item.id, content: itemContent })
      } else if (itemContent !== (prior.content || '')) {
        blocks.push({ kind: 'pinned_diff', item_kind: itemKind, item_id: item.id, content: itemContent })
      }
    }
  }
  // Close out a legacy whole-set pinned part if the writer has cleared
  // all pins, so the old block stops riding along. Per-item parts need
  // no removed marker: they vanish by absence (handled in the wire).
  const legacyPinned = latestByPart.get('pinned')
  if (legacyPinned && !legacyPinned.kind.endsWith('_removed') && !pinnedNowInForce) {
    blocks.push({ kind: 'pinned_removed', content: '' })
  }

  return blocks
}


/**
 * Build the array of `{role, content}` messages sent to the LLM
 * adapter on this send. Spec-compliant per the Phase 2.5d planning
 * doc:
 *
 *   1. Walk the thread oldest-to-newest. User/assistant messages
 *      in-window emit as-is. `system_context` messages in-window
 *      emit as `role: system` messages AT THEIR NATURAL POSITION
 *      (NOT collapsed into one mega-block before the latest turn).
 *      The original `scene_full` thus lives with the turn it was
 *      first emitted alongside; each subsequent `scene_diff` lives
 *      with the later turn that triggered the change.
 *
 *   2. Two-zone wire for in-force parts (Phase 7.1 item 289): every
 *      part still in force at send time (active scene + pinned items)
 *      contributes a BACKSTOP at the top of the wire — a single
 *      resolved-state emission that collapses all of its OUT-OF-WINDOW
 *      history into the part's state as of the window boundary. Its
 *      IN-WINDOW changes still emit as positioned `*_diff` records at
 *      their natural turns. As an in-window change ages past the
 *      boundary it is absorbed into the backstop (the superseded
 *      earlier state is simply never emitted); a widening window
 *      re-expands absorbed changes back into positioned records. This
 *      replaces the older ride-along that re-emitted every
 *      out-of-window chain block verbatim.
 *
 *   3. Diffs always carry their baseline: a `*_diff` whose preceding
 *      `*_full` has rolled out of window gets that full prepended
 *      too, even if the part is no longer in force at send time
 *      (otherwise the diff is meaningless).
 *
 *   4. Sticky favourites (`pinned && context_sticky`) bypass the
 *      rolling-window cap on user/assistant turns.
 *
 *   5. `*_removed` blocks render as short one-liner system markers:
 *      `[Context removed: scene "X"]`, etc. ~15 tokens. They emit
 *      naturally in their position; ride-along does not apply
 *      (the spec's "softer rule" — referenced context that's no
 *      longer in force isn't mandatory ride-along).
 */
export function buildWireMessages(thread, options) {
  const messages = thread?.messages || []
  const rollingN = options?.rollingN ?? null
  const activeSceneId = options?.activeSceneId || null
  const pinnedItems = options?.pinnedItems || []
  // Phase 2.5g follow-up — strip attachments from the WIRE payload
  // when the active model doesn't support that input modality. The
  // persisted message data on disk is untouched: the bubble still
  // renders the historical image / file thumbnail and the writer can
  // still see what was shared. The strip only applies to the
  // outgoing `messages[]` for THIS send, so a switch from a vision
  // model to a text-only model mid-thread doesn't blow up the
  // request with attachments the upstream can't ingest.
  //
  // Defaults to `true` for both so legacy callers (and any path
  // that hasn't been threaded through yet) keep the pre-fix
  // forward-everything behaviour. The chat send path passes the
  // resolved capability flags from `useActiveModelCapabilities`.
  const supportsImageInput = options?.supportsImageInput !== false
  const supportsFileInput = options?.supportsFileInput !== false

  // Compute the in-force set. Pinned is one consolidated part; the
  // grouping / sorting / framing all live in the renderer, so the
  // wire just needs to know "are any pins currently in force".
  const inForceKeys = new Set()
  if (activeSceneId) inForceKeys.add('scene')
  // Option B — each currently-pinned item is its own in-force part, so
  // its chain rides along independently and only pins that are STILL
  // attached are kept in the wire. A removed pin is absent from this
  // set, which is what makes it vanish in the emit loop below.
  //
  // Phase 7.1 item 291 — scene/pinned dedup: an entity that is a
  // participant of the active scene is already emitted in the scene block
  // (a full participant dossier, the superset representation), so its
  // separate pinned blocks must NOT also reach the model. Leaving its key
  // out of the in-force set drops every one of its pinned blocks via the
  // vanish filter and gives it no backstop, so the entity is emitted once,
  // in the scene section. Only ENTITY pins dedup (relationships and
  // knowledges are not scene participants); when scene context is off the
  // participant set is empty and every pin rides as before.
  const sceneParticipantIds = _sceneParticipantIds(activeSceneId)
  for (const item of (Array.isArray(pinnedItems) ? pinnedItems : [])) {
    if (!item || !item.id) continue
    if (item.kind === 'entity' && sceneParticipantIds.has(item.id)) continue
    inForceKeys.add(`pinned:${item.kind || ''}:${item.id}`)
  }

  // Rolling-window cutoff — walk from end counting user/assistant
  // messages until N is reached. `cutoffIdx` is the first IN-window
  // message index (everything before is out-of-window).
  const cutoffIdx = _computeCutoffIdx(messages, rollingN)

  // First pass — walk thread chronologically, tracking each part's
  // current chain. For each block, pre-render its wire text knowing
  // the part's previous in-chain block (so a `*_diff` block can be
  // rendered as the sub-block diff against the prior full state).
  //
  // Storage shape: `*_full.content` and `*_diff.content` BOTH carry
  // the full scene/pinned render at that turn. The wire shows the
  // FULL render once (at the natural position of the original
  // `_full`) and only the changed sub-blocks for each subsequent
  // `_diff`. A `_removed` block closes out the chain.
  const blockRender = new Map()  // `${msgIdx}:${blockIdx}` -> rendered wire text
  const partChain = new Map()    // key -> [{ msgIdx, block, renderedText }] active chain
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'system_context') continue
    for (let j = 0; j < (m.blocks || []).length; j++) {
      const b = m.blocks[j]
      const key = _partKey(b)
      if (!key) continue
      let rendered = ''
      if (b.kind.endsWith('_full')) {
        rendered = _wrapFullEmission(b)
        partChain.set(key, [{ msgIdx: i, block: b, renderedText: rendered }])
      } else if (b.kind.endsWith('_diff')) {
        const chain = partChain.get(key) || []
        const priorFullContent = chain.length > 0
          ? (chain[chain.length - 1].block.content || '')
          : ''
        const diffBody = priorFullContent
          ? _renderDiffBodyForWire(priorFullContent, b.content || '', b.kind)
          : ''
        rendered = _wrapDiffEmission(b, diffBody || b.content || '')
        chain.push({ msgIdx: i, block: b, renderedText: rendered })
        partChain.set(key, chain)
      } else if (b.kind === 'scene_switch') {
        // A scene switch is a positional one-liner marker; the
        // `scene_full` that follows it resets the chain to the new
        // scene, so the marker itself doesn't touch the chain.
        rendered = _renderSwitchMarker(b)
      } else if (b.kind.endsWith('_removed')) {
        rendered = _renderRemovedMarker(b)
        partChain.set(key, [])
      }
      if (rendered) blockRender.set(`${i}:${j}`, rendered)
    }
  }

  // Collect every system_context block emission with its containing
  // message index, grouped per part. Used for ride-along chain
  // resolution.
  const partEmissions = new Map()  // key -> [{ msgIdx, blockIdx, block }]
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'system_context') continue
    for (let j = 0; j < (m.blocks || []).length; j++) {
      const b = m.blocks[j]
      const key = _partKey(b)
      if (!key) continue
      if (!partEmissions.has(key)) partEmissions.set(key, [])
      partEmissions.get(key).push({ msgIdx: i, blockIdx: j, block: b })
    }
  }

  // `rideAlongTexts` are the texts prepended at the TOP of the wire.
  // The in-force loop below fills it with each attached part's BACKSTOP
  // (Phase 7.1 item 289); the not-in-force loop further down uses the
  // `rideAlong()` helper to pull a legacy diff's out-of-window baseline
  // along when its part is no longer in force.
  const rideAlongTexts = []
  const rideAlongUsedKeys = new Set()  // `${msgIdx}:${blockIdx}`
  function rideAlong(e) {
    const k = `${e.msgIdx}:${e.blockIdx}`
    if (rideAlongUsedKeys.has(k)) return
    rideAlongUsedKeys.add(k)
    const text = blockRender.get(k)
    if (text) rideAlongTexts.push(text)
  }
  // Backstop: collapse every OUT-OF-WINDOW change for an in-force part
  // into ONE resolved-state emission rather than riding the whole
  // out-of-window chain verbatim. The backstop is the FULL render stored
  // on the part's LAST out-of-window block — its resolved state as of the
  // window boundary, with every aged-out change already folded in
  // (absorption). In-window changes still emit as positioned records in
  // the walk below; as one ages past the boundary, the last-out-of-window
  // block advances and its resolved content silently supersedes the older
  // state (the superseded state is simply never emitted). Window EXPAND is
  // free: a larger window moves the boundary earlier, so the backstop
  // falls back to an earlier resolved state and the now-in-window changes
  // re-expand into positioned records — reconstructed from the stored
  // per-item blocks (Option B), never lost.
  for (const key of inForceKeys) {
    const emissions = partEmissions.get(key) || []
    if (emissions.length === 0) continue
    // Chain start: latest `_full` not closed by a later `_removed`.
    let chainStart = -1
    for (let j = emissions.length - 1; j >= 0; j--) {
      const e = emissions[j]
      if (e.block.kind.endsWith('_removed')) { chainStart = -1; break }
      if (e.block.kind.endsWith('_full')) { chainStart = j; break }
    }
    if (chainStart < 0) continue
    // Boundary state = the LAST chain emission still out-of-window.
    // Emissions are chronological, so walk forward until the cutoff is
    // reached. Whole chain in-window → nothing to absorb; the in-window
    // `_full` carries the state at its own position (no backstop).
    let backstop = null
    for (let j = chainStart; j < emissions.length; j++) {
      const e = emissions[j]
      if (e.msgIdx < cutoffIdx) backstop = e
      else break
    }
    if (!backstop) continue
    // Frame the boundary block's resolved content as a FULL regardless of
    // whether it was itself a `_full` or a later `_diff`: `block.content`
    // is the complete render at that turn, so the model receives the
    // resolved state, not a bare change line.
    const bb = backstop.block
    const fullKind = bb.kind.endsWith('_diff') ? bb.kind.replace(/_diff$/, '_full') : bb.kind
    const text = _wrapFullEmission({ ...bb, kind: fullKind })
    if (text) rideAlongTexts.push(text)
  }
  // For not-in-force parts: any in-window `_diff` whose preceding
  // `_full` is out-of-window pulls that `_full` along (the diff
  // would be meaningless without its baseline).
  for (const [key, emissions] of partEmissions) {
    if (inForceKeys.has(key)) continue
    // A per-item pinned part that's no longer attached — or the scene
    // part when scene context is off — has vanished; don't ride its
    // baseline along (that would resurrect removed context). Legacy
    // whole-set 'pinned' (no colon) is exempt — it's a historical
    // block, handled by the natural-position walk.
    if (key.startsWith('pinned:') || key === 'scene') continue
    for (let j = 0; j < emissions.length; j++) {
      const e = emissions[j]
      if (!e.block.kind.endsWith('_diff')) continue
      if (e.msgIdx < cutoffIdx) continue
      let baselineIdx = -1
      for (let k = j - 1; k >= 0; k--) {
        const pe = emissions[k]
        if (pe.block.kind.endsWith('_full')) { baselineIdx = k; break }
        if (pe.block.kind.endsWith('_removed')) break
      }
      if (baselineIdx < 0) continue
      const baseline = emissions[baselineIdx]
      if (baseline.msgIdx >= cutoffIdx) continue
      rideAlong(baseline)
    }
  }

  // Build the wire array (Flavour A from the planning discussion):
  // every `system_context` block emits as a PREFIX on the next user
  // message rather than as its own `role: system` entry. This is
  // the standard RAG-style convention and is the only role with
  // mid-conversation positional semantics that survives across
  // every API (Anthropic concatenates `system` to position 0; OpenAI
  // tolerates mid-stream system but the model isn't trained to read
  // it as authorial action). User-role with a clearly-framed
  // bracketed preamble is what the model recognises as "the writer
  // shared this with their question."
  //
  // Ride-along texts ride with the FIRST in-window user message;
  // each in-window system_context message rides with whichever user
  // message comes next in the thread. The position-0 system slot is
  // reserved for the shipped persona/system prompt (set by the
  // caller, sent as `system_prompt` to the adapter, not part of the
  // wire `messages` array).
  const wire = []
  const pendingPrefixes = []
  for (const t of rideAlongTexts) {
    if (t) pendingPrefixes.push(t)
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const inWindow = i >= cutoffIdx
    if (m.role === 'system_context') {
      if (!inWindow) continue
      for (let j = 0; j < (m.blocks || []).length; j++) {
        // Vanish filter: a per-item pinned block whose item is no
        // longer attached — or any scene block when scene context is
        // off — is dropped from the wire entirely, not just from
        // ride-along but from its in-window position too, so removed
        // context leaves no trace (silent + total removal). Legacy
        // whole-set 'pinned' blocks (no colon) are historical and
        // always render.
        const vk = _partKey(m.blocks[j])
        if (vk && (vk.startsWith('pinned:') || vk === 'scene') && !inForceKeys.has(vk)) continue
        const text = blockRender.get(`${i}:${j}`)
        if (text) pendingPrefixes.push(text)
      }
    } else if (m.role === 'user' || m.role === 'assistant') {
      const sticky = m.pinned && m.context_sticky
      if (!(inWindow || sticky)) continue
      if (m.role === 'user') {
        // Drain accumulated context into this user message's content.
        //
        // Wire format: when there are accumulated context prefixes,
        // wrap them in `<context>...</context>` and the writer's
        // typed content in `<message>...</message>` so the model
        // sees a clear boundary between framing context and the
        // actual prompt. When there are NO prefixes, the writer's
        // content rides as-is (no empty `<message>` wrapper for the
        // common no-context case). XML-style tags chosen because
        // every major model family is trained to parse them as
        // delimiters AND consecutive same-role messages aren't
        // universally supported (Bedrock + vLLM + most local-model
        // Jinja templates reject them) — so a single tagged user
        // message stays portable across every provider while still
        // giving the AI a structural boundary.
        const contextText = pendingPrefixes.join('\n\n')
        const userText = m.content || ''
        pendingPrefixes.length = 0
        let content
        if (contextText && userText) {
          content = `<context>\n${contextText}\n</context>\n\n<message>\n${userText}\n</message>`
        } else if (contextText) {
          // Defensive: context with no typed content (shouldn't
          // normally happen). Still wrap so the AI knows it's
          // framing context, not a prompt to act on.
          content = `<context>\n${contextText}\n</context>`
        } else {
          content = userText
        }
        const wireMsg = { role: 'user', content }
        // Forward stored attachments from the persisted message so
        // subsequent turns retain the file context from earlier in
        // the conversation. Without this, on turn 2+ the model
        // loses the file content it saw on turn 1 — it'd see only
        // the assistant's prior reply about the file, not the file
        // itself. Convert StoredAttachment shape → ChatAttachment
        // shape (which the wire encoder expects).
        //
        // Phase 2.5g follow-up: filter by the active model's
        // capabilities. Image attachments are skipped when the
        // active model doesn't support image input; file (PDF)
        // attachments are skipped when it doesn't support file
        // input. Text attachments always ride (their content was
        // inlined into the model's wire view at original send time
        // and the same shape works for any text-capable model).
        const wireAtts = []
        for (const att of (m.attachments || [])) {
          if (att?.kind === 'image' && !supportsImageInput) continue
          if (att?.kind === 'file'  && !supportsFileInput)  continue
          const w = _storedAttachmentToWire(att)
          if (w) wireAtts.push(w)
        }
        if (wireAtts.length > 0) wireMsg.attachments = wireAtts
        wire.push(wireMsg)
      } else {
        // Phase 2.5e — assistant attachments (received images) ride
        // forward on subsequent turns so the model sees the picture
        // it generated earlier. The wire shape forwards whichever
        // URL the upstream originally emitted: hosted URL → ship the
        // URL string verbatim (no re-encode); data URL → ship the
        // bytes. `_storedAttachmentToWire` handles the split.
        const wireMsg = { role: 'assistant', content: m.content }
        const wireAtts = []
        for (const att of (m.attachments || [])) {
          // Phase 2.5g follow-up: same capability gate as the user
          // branch. An assistant-returned image from an earlier turn
          // (generated by a vision/output-capable model) is only
          // forwardable if the CURRENT model can ingest images.
          if (att?.kind === 'image' && !supportsImageInput) continue
          if (att?.kind === 'file'  && !supportsFileInput)  continue
          const w = _storedAttachmentToWire(att)
          if (w) wireAtts.push(w)
        }
        if (wireAtts.length > 0) wireMsg.attachments = wireAtts
        wire.push(wireMsg)
      }
    }
  }
  // Defensive: if context remained pending with no user message to
  // drain into (shouldn't happen in our send flow — system_context
  // always precedes a user — but kept for safety), surface it as a
  // synthetic trailing user entry so the model still sees it.
  // Wrapped in `<context>` for consistency with the drained-into-
  // user path above, so the AI knows this is framing context, not
  // a prompt to act on.
  if (pendingPrefixes.length > 0) {
    wire.push({
      role: 'user',
      content: `<context>\n${pendingPrefixes.join('\n\n')}\n</context>`,
    })
  }
  return wire
}


// Wire-time diff: given the prior in-chain block's FULL content and
// the new block's FULL content, compute the affected-sub-block diff
// body the wire should carry. BOTH scene and pinned content are a SET
// of items: the pinned set is `## Additional Context` plus one
// `### Additional <Kind>: <Name>` sub-block per pin. So both go
// through the section-aware sub-block splitter. Diffing the whole
// pinned body as one flat line-tree (the old pinned path) keyed lines
// by their field head, so same-named fields across DIFFERENT pins
// collided on one key and a mid-conversation add/change was
// mis-attributed or dropped. Splitting into per-item sub-blocks first
// keys each item by its full `### Additional ...` heading (so two
// pins never collide) and diffs each item body independently.
//
// Pinned diffs additionally render field changes as `old -> new`
// (`showOldNew`), because the prior pin value is not otherwise on the
// same line. Scene diffs already carry in-scene change arrows from the
// renderer, so `showOldNew` stays off there to avoid doubling them.
function _renderDiffBodyForWire(priorFullContent, newFullContent, blockKind) {
  if (!priorFullContent || !newFullContent) return ''
  if (priorFullContent === newFullContent) return ''
  if (blockKind === 'scene_diff') {
    return _renderSceneSubBlockDiff(priorFullContent, newFullContent)
  }
  if (blockKind === 'pinned_diff') {
    return _renderSceneSubBlockDiff(priorFullContent, newFullContent, true)
  }
  return ''
}


function _renderRemovedMarker(block) {
  if (!block) return ''
  if (block.kind === 'scene_removed') {
    const title = block.content || 'unknown'
    return `[Context removed: scene "${title}"]`
  }
  if (block.kind === 'pinned_removed') {
    return '[Context removed: all pinned context has been cleared.]'
  }
  return ''
}


// Render a scene-switch marker. The block's `content` carries
// `{ from, to }` JSON (old + new scene titles); we present it as a
// single one-liner so the model reads the focus change as one event
// ("the scene changed from X to Y"), with the new scene's full block
// emitted right after by `computeContextDiff`.
function _renderSwitchMarker(block) {
  if (!block) return ''
  let from = 'unknown'
  let to = 'unknown'
  try {
    const o = JSON.parse(block.content || '{}')
    from = (o.from || '').trim() || 'unknown'
    to = (o.to || '').trim() || 'unknown'
  } catch { /* malformed content — keep the unknown placeholders */ }
  return `[The user changed the active scene from "${from}" to "${to}".]`
}


// Frame an initial `*_full` emission as authored intent. The wrapper
// reads as "the user is showing me this from their tool" so the
// model treats the payload as content to engage with rather than as
// opaque system metadata. "User" rather than "author" stays neutral
// across narrative writing, game narrative, screenwriting, lore, and
// any other use NarrativeNode supports — the writer's self-identity
// isn't presumed.
function _wrapFullEmission(block) {
  const body = (block?.content || '').trim()
  if (!body) return ''
  if (block.kind === 'scene_full') {
    return `[The user is working on the following scene:\n\n${body}]`
  }
  if (block.kind === 'pinned_full') {
    return `[The user has pinned the following context to this conversation:\n\n${body}]`
  }
  return body
}


// Frame a `*_diff` emission as a specific change the user made since
// the previous message. The diff body itself (already produced by
// `_renderDiffBodyForWire` as the affected sub-block only) goes
// inside; the wrapper makes the "the user just changed X" signal
// unmissable.
function _wrapDiffEmission(block, diffBody) {
  const body = (diffBody || '').trim()
  if (!body) return ''
  if (block.kind === 'scene_diff') {
    return `[The user has changed the following in their scene since the previous message:\n\n${body}]`
  }
  if (block.kind === 'pinned_diff') {
    return `[The user has updated the following pinned context since the previous message:\n\n${body}]`
  }
  return body
}


/**
 * Return the consolidated context content that was in force at the
 * point a specific message was sent. Used by the "View attached
 * context" affordance on each user message.
 *
 * Walks the thread up to AND INCLUDING the target message, tracking
 * the latest non-removed block per part. Returns the concatenated
 * rendered text of all in-force parts at that point — empty string
 * when nothing was in force.
 */
export function getContextAtMessage(thread, messageId) {
  const messages = thread?.messages || []
  const idx = messages.findIndex((m) => m && m.id === messageId)
  if (idx < 0) return ''
  // Walk up to and including idx, tracking latest non-removed block
  // per part. (_removed clears the part during the walk.)
  const latestByPart = new Map()
  for (let i = 0; i <= idx; i++) {
    const m = messages[i]
    if (!m || m.role !== 'system_context') continue
    for (const b of (m.blocks || [])) {
      const key = _partKey(b)
      if (!key) continue
      if (b.kind.endsWith('_removed')) latestByPart.delete(key)
      else latestByPart.set(key, b)
    }
  }
  if (latestByPart.size === 0) return ''
  // Order: scene first, then pinned in iteration order.
  const out = []
  if (latestByPart.has('scene')) {
    const b = latestByPart.get('scene')
    if (b?.content) out.push(b.content)
  }
  for (const [k, b] of latestByPart) {
    if (k === 'scene') continue
    if (b?.content) out.push(b.content)
  }
  return out.join('\n\n')
}


// ── Internals ─────────────────────────────────────────────────────


function _walkLatestByPart(messages) {
  const latestByPart = new Map()
  for (const m of messages) {
    if (m.role !== 'system_context') continue
    for (const b of (m.blocks || [])) {
      const key = _partKey(b)
      if (key) latestByPart.set(key, b)
    }
  }
  return latestByPart
}


function _partKey(block) {
  if (!block || !block.kind) return null
  if (block.kind.startsWith('scene_')) return 'scene'
  if (block.kind.startsWith('pinned_')) {
    // Option B — per-item pinned parts. A block stamped with its item
    // identity gets its own part key, so each pin has an independent
    // chain (full/diff/removed), ride-along, and diff baseline; the
    // diff is then item-aware by construction (no cross-item field
    // collision). Legacy whole-set pinned blocks (no item_id, written
    // before Option B) keep the single 'pinned' key — the read-side
    // shim that lets old threads keep rendering their historical block.
    if (block.item_id) return `pinned:${block.item_kind || ''}:${block.item_id}`
    return 'pinned'
  }
  return null
}


// Compute the index of the first in-window user/assistant message.
// `rollingN` is the cap; everything before that index is out of
// window UNLESS it's a sticky user/assistant message (handled by
// the wire builder's natural-position walk).
function _computeCutoffIdx(messages, rollingN) {
  if (rollingN == null || rollingN < 0) return 0
  let count = 0
  let cutoffIdx = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
    count++
    if (count > rollingN) {
      cutoffIdx = i + 1
      return cutoffIdx
    }
  }
  return 0
}


// Wrapper that swallows errors and returns empty string on failure,
// so a render failure for one part doesn't break the whole diff.
async function _safeRender(arg) {
  try {
    const out = await buildSceneContextBlock(arg)
    return out || ''
  } catch (err) {
    // A throw here silently drops the ENTIRE pinned context from the
    // wire: when there is no prior pinned_full to ride along, the
    // pinned block is simply never emitted and the model stays unaware
    // of pills that are present. This is the leading suspect for the
    // "a context pill is present but the model doesn't know about it"
    // report. Log loudly (with the pins involved) so the failing pin
    // and cause are diagnosable on the next occurrence.
    try {
      console.warn(
        '[context] pinned context render failed; pinned block omitted this turn. Pins:',
        (arg?.pinnedItems || []).map((p) => `${p?.kind}:${p?.id}`),
        err,
      )
    } catch { /* never let logging break the send */ }
    return ''
  }
}


// Pull the scene title from a stored `scene_full` or `scene_diff`
// block's content. The full builder emits the first line as
// `## Scene context: <title>` so we just parse that.
function _sceneTitleFromBlock(block) {
  if (!block || !block.content) return ''
  return _sceneTitleFromRender(block.content)
}


// Same parse, applied to raw render text (e.g. a freshly-built
// scene context block that hasn't been stored yet). Used by the
// legacy-block fallback in `computeContextDiff` when a stored
// block predates the `scene_id` field.
function _sceneTitleFromRender(text) {
  if (!text) return ''
  const firstLine = text.split('\n', 1)[0] || ''
  const m = firstLine.match(/^## Scene context:\s*(.+)$/)
  return m ? m[1].trim() : ''
}


// Pull the pinned item's display name from a stored pinned block's
// content. The pinned renderer emits the heading line as
// `### Additional <Kind>: <Name>` so we parse the first heading.
function _pinnedItemNameFromBlock(block) {
  if (!block || !block.content) return ''
  for (const line of block.content.split('\n')) {
    const m = line.match(/^### Additional [^:]+:\s*(.+)$/)
    if (m) return m[1].trim()
  }
  return ''
}


// ── Per-entity sub-block diffing for scene_diff ──────────────────
//
// The Phase 2.5d spec calls for `*_diff` messages to re-emit only
// the affected per-entity (or per-relationship / per-knowledge /
// per-pinned-item) sub-block, NOT the full re-render. We achieve
// this by parsing both the prior and the new rendered scene blocks
// into structural sub-blocks keyed by section + subject name, then
// emitting only the entries whose body differs.
//
// Sub-block key scheme:
//   - 'header'                  — the scene metadata block (title,
//                                 description, chapter, POV, voice,
//                                 time) sitting before any section.
//   - 'scene_circumstances'     — the `### Scene circumstances`
//                                 section as one chunk.
//   - 'characters:<Name>'       — one per character in the scene.
//   - 'locations:<Name>'        — etc.
//   - 'items:<Name>'
//   - 'factions:<Name>'
//   - 'customs:<Name>'
//   - 'relationships:<Head>'    — one per relationship line.
//   - 'knowledges:<Name>'       — one per knowledge line.
//   - 'additional:<Heading>'    — one per pinned-item block under
//                                 the `## Additional Context` section.
//
// Return shape: Map<string, { sectionHeading, body }>. The
// renderer uses sectionHeading to group changed sub-blocks back
// under their parent section heading so the model can read each
// chunk as "this is a Character change", "this is a Location
// change", etc.


function _splitSceneRender(text) {
  const out = new Map()
  if (!text) return out
  const lines = text.split('\n')

  // 1. Header: everything before the first '### ' heading OR the
  // first '## ' that isn't the leading scene-context heading.
  let i = 0
  const headerLines = []
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.startsWith('### ')) break
    if (ln.startsWith('## ') && headerLines.length > 0 && !ln.startsWith('## Scene context:')) break
    headerLines.push(ln)
    i++
  }
  if (headerLines.length > 0) {
    out.set('header', { sectionHeading: '', body: _trimBlank(headerLines).join('\n') })
  }

  // 2. Walk top-level sections (### or ##).
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.startsWith('## Additional Context')) {
      i++  // consume heading
      // Pinned items: each `### Additional <Kind>: <Name>` is one
      // sub-block keyed `additional:<heading-without-prefix>`.
      while (i < lines.length) {
        const sub = lines[i]
        if (sub.startsWith('### Additional ')) {
          const heading = sub
          i++  // consume the `### Additional ...` heading
          const collected = []
          while (i < lines.length && !lines[i].startsWith('### Additional ') && !lines[i].startsWith('## ')) {
            collected.push(lines[i])
            i++
          }
          out.set(`additional:${heading}`, {
            sectionHeading: '## Additional Context',
            subBlockHeading: heading,
            body: _trimBlank(collected).join('\n'),
          })
        } else if (sub.startsWith('## ')) {
          break
        } else {
          // Blank line or stray content under Additional Context.
          i++
        }
      }
      continue
    }
    if (!ln.startsWith('### ')) { i++; continue }
    // Section heading like '### Characters' or '### Scene circumstances'.
    const sectionHeading = ln
    const sectionType = _sectionTypeFromHeading(sectionHeading)
    i++
    if (sectionType === 'scene_circumstances') {
      const collected = []
      while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
        collected.push(lines[i])
        i++
      }
      out.set('scene_circumstances', {
        sectionHeading,
        body: _trimBlank(collected).join('\n'),
      })
      continue
    }
    if (sectionType && (sectionType.startsWith('entity:') || sectionType === 'relationships' || sectionType === 'knowledges')) {
      // Each `- **Name**` line starts an item sub-block; indented
      // continuation lines (`  -` or blanks between items) belong
      // to that item until the next `- **` at col 0 or a new
      // section starts.
      while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
        const itemLn = lines[i]
        if (!itemLn.startsWith('- **')) { i++; continue }
        const m = itemLn.match(/^- \*\*([^*]+)\*\*/)
        const name = m ? m[1].trim() : itemLn
        const collected = [itemLn]
        i++
        while (i < lines.length
               && !lines[i].startsWith('### ')
               && !lines[i].startsWith('## ')
               && !lines[i].startsWith('- **')) {
          collected.push(lines[i])
          i++
        }
        const key = sectionType.startsWith('entity:')
          ? `${sectionType.slice('entity:'.length)}:${name}`
          : `${sectionType}:${name}`
        out.set(key, {
          sectionHeading,
          body: _trimBlank(collected).join('\n'),
        })
      }
      continue
    }
    // Unknown section — preserve as one chunk so a renderer change
    // doesn't silently drop content from the diff.
    const collected = []
    while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
      collected.push(lines[i])
      i++
    }
    out.set(`unknown:${sectionHeading}`, {
      sectionHeading,
      body: _trimBlank(collected).join('\n'),
    })
  }

  return out
}


// Map a `### Heading` line to a section type. Returns null for
// headings we don't recognise (those get bucketed under 'unknown').
function _sectionTypeFromHeading(heading) {
  if (!heading) return null
  if (heading === '### Scene circumstances') return 'scene_circumstances'
  if (heading === '### Characters')          return 'entity:characters'
  if (heading === '### Locations')           return 'entity:locations'
  if (heading === '### Items')               return 'entity:items'
  if (heading === '### Factions')            return 'entity:factions'
  if (heading === '### Customs')             return 'entity:customs'
  if (heading === '### Relationships in this scene')         return 'relationships'
  if (heading === '### Knowledge relevant to this scene')    return 'knowledges'
  return null
}


function _trimBlank(lines) {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  while (out.length > 0 && out[0].trim() === '') out.shift()
  return out
}


// Compute the diff body for a `scene_diff` block. Operates at TWO
// granularities:
//
//   - At the section level (sub-blocks keyed by `_splitSceneRender`):
//     only sub-blocks that actually changed surface in the output.
//
//   - WITHIN a changed sub-block (per entity, per relationship,
//     per knowledge), the body is parsed as an indented line tree
//     and tree-diffed against the prior body. Only LEAF LINES whose
//     content differs land in the diff, with their ancestor group
//     lines preserved as locating context. So an attribute change
//     emits as:
//
//         ### Characters
//         - **Mina Murray** *(POV)*
//           - Attributes:
//             - Occupation: "Schoolteacher" → "A Teacher" *(changes during this scene)*
//
//     NOT the full Mina Murray sub-block.
//
// Returns '' when nothing differs OR the parser can't make sense
// of the renders (caller falls back to full content in that case).
function _renderSceneSubBlockDiff(priorText, newText, showOldNew = false) {
  const prior = _splitSceneRender(priorText)
  const next = _splitSceneRender(newText)
  if (next.size === 0) return ''

  // Group changes by section so each section heading is emitted at
  // most once per diff. Sections preserve insertion order from the
  // new render so the diff reads top-to-bottom matching the
  // canonical layout.
  const sectionsInOrder = []
  const sectionByHeading = new Map()
  function ensureSection(sectionHeading) {
    const k = sectionHeading || '__noheader__'
    let s = sectionByHeading.get(k)
    if (s) return s
    s = { sectionHeading: sectionHeading || '', items: [] }
    sectionsInOrder.push(s)
    sectionByHeading.set(k, s)
    return s
  }

  for (const [key, rec] of next) {
    const priorRec = prior.get(key)
    if (priorRec && priorRec.body === rec.body) continue
    const s = ensureSection(rec.sectionHeading)
    // Compose the sub-block heading prefix (if any). Pinned items
    // carry a `### Additional <Kind>: <Name>` line as their
    // `subBlockHeading`; we always include it so the diff reads
    // "which pinned item changed". Other sub-block types have no
    // separate heading — the heading is already part of the body
    // (e.g. `- **Name**` for entities) or absent (header section).
    const headingPrefix = rec.subBlockHeading ? rec.subBlockHeading + '\n' : ''
    if (!priorRec) {
      // Newly-present sub-block — emit verbatim, no diffing.
      s.items.push(headingPrefix + rec.body)
    } else {
      const subDiff = _diffSubBlockBodies(priorRec.body, rec.body, showOldNew)
      if (subDiff) s.items.push(headingPrefix + subDiff)
      else s.items.push(headingPrefix + rec.body)  // defensive — parser fallthrough
    }
  }
  // Removed sub-blocks (keys present in prior, missing in new).
  for (const [key, priorRec] of prior) {
    if (next.has(key)) continue
    const s = ensureSection(priorRec.sectionHeading)
    // Prefer the sub-block heading (pinned items) when present; it
    // identifies the removed item without a free-form parse of the
    // body's first line.
    const label = priorRec.subBlockHeading
      || (priorRec.body.split('\n', 1)[0] || '').trim()
      || key
    s.items.push(`- ${label} *(removed)*`)
  }

  if (sectionsInOrder.every((s) => s.items.length === 0)) return ''

  const out = []
  for (const s of sectionsInOrder) {
    if (s.items.length === 0) continue
    if (s.sectionHeading) out.push(s.sectionHeading)
    for (const it of s.items) out.push(it)
    out.push('')
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}


// Tree-diff one sub-block's body. Lines are parsed into an
// indentation-based forest (one or more sibling roots, each with
// indented children). Nodes are matched between prior and new by
// their KEY — derived from the "head" of the line: bolded name,
// field name before `:`, name before ` *(annotation)*`, or name
// before ` — description`. A leaf line whose tail differs is a
// leaf-level change; we emit just the new line. Group nodes
// (Attributes / Motivators / Awareness, or the entity heading)
// retain their line as locating context when a descendant changes.
//
// Multi-root mode handles non-entity shapes:
//   - The header sub-block: each `**Field**:` line is a separate
//     depth-0 root. Field-level diff works the same way as
//     entity attributes.
//   - Scene circumstances: each `- Name *(intensity)* — desc` line
//     is a separate depth-0 root.
//   - Pinned items: the `### Additional ...` heading is stripped
//     by `_splitSceneRender` so the body starts with the `- **Name**`
//     root cleanly.
//
// Returns the diff body (changed roots and their context) or ''
// if nothing actually changed.
function _diffSubBlockBodies(priorBody, newBody, showOldNew = false) {
  const priorTree = _parseLineTree(priorBody)
  const newTree = _parseLineTree(newBody)
  if (priorTree.length === 0 && newTree.length === 0) return ''
  const rootDiff = _diffNodeChildren(priorTree, newTree, showOldNew)
  if (rootDiff.length === 0) return ''
  return rootDiff.join('\n')
}


// Parse a body into a tree of { line, depth, children }. Indent
// drives the hierarchy: each line's depth is the number of leading
// spaces; deeper lines become children of the most-recent shallower
// node. Blank lines are skipped — they're not part of the tree.
function _parseLineTree(text) {
  const lines = (text || '').split('\n')
  const root = { line: null, depth: -1, children: [] }
  const stack = [root]
  for (const ln of lines) {
    if (ln.trim() === '') continue
    const depth = ln.match(/^ */)[0].length
    while (stack[stack.length - 1].depth >= depth) stack.pop()
    const node = { line: ln, depth, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root.children
}


// Diff two sibling-lists of nodes. Returns an array of rendered
// lines representing only the changes (with parent-group context
// where a group's child changed). Each emitted node uses its
// original indentation so the line tree shape is preserved in the
// diff body.
function _diffNodeChildren(priorChildren, newChildren, showOldNew = false) {
  // Build key maps. Key is derived from the line's "head" — the
  // text before the first `:` or, for bolded names, the bolded
  // portion. Two nodes with the same key represent the same
  // logical field across renderings.
  const priorByKey = new Map()
  const priorOrder = []
  for (const n of priorChildren) {
    const k = _nodeKey(n)
    priorByKey.set(k, n)
    priorOrder.push(k)
  }
  const newByKey = new Map()
  const newOrder = []
  for (const n of newChildren) {
    const k = _nodeKey(n)
    newByKey.set(k, n)
    newOrder.push(k)
  }
  const out = []
  // Walk new children in render order; emit only changed ones.
  for (const key of newOrder) {
    const newNode = newByKey.get(key)
    const priorNode = priorByKey.get(key)
    if (!priorNode) {
      // Newly added field — emit the whole subtree.
      out.push(newNode.line)
      _appendSubtreeLines(out, newNode)
    } else if (newNode.line !== priorNode.line) {
      // Leaf-level value change OR group header text shifted.
      const isLeaf = newNode.children.length === 0 && priorNode.children.length === 0
      if (showOldNew && isLeaf) {
        // Pinned path: surface the value transition inline as
        // `head: old -> new` (the prior value is not otherwise on
        // this line). Falls back to the new line when the heads
        // don't match a `head: value` shape.
        out.push(_formatLeafChange(priorNode.line, newNode.line))
      } else {
        out.push(newNode.line)
        // If the node has children, recurse and emit only changed
        // descendants — NOT the full subtree, since the visible
        // change is at this node itself.
        if (newNode.children.length > 0 || priorNode.children.length > 0) {
          const sub = _diffNodeChildren(priorNode.children, newNode.children, showOldNew)
          for (const s of sub) out.push(s)
        }
      }
    } else if (newNode.children.length > 0 || priorNode.children.length > 0) {
      // This line matches the prior line, but children might have
      // shifted. Recurse; only emit this line if a descendant did.
      const sub = _diffNodeChildren(priorNode.children, newNode.children, showOldNew)
      if (sub.length > 0) {
        out.push(newNode.line)
        for (const s of sub) out.push(s)
      }
    }
  }
  // Removed children — emit a "removed since last turn" marker
  // at the prior node's depth so the model sees the absence.
  for (const key of priorOrder) {
    if (newByKey.has(key)) continue
    const priorNode = priorByKey.get(key)
    const indent = ' '.repeat(priorNode.depth)
    out.push(`${indent}- ${key} *(removed)*`)
  }
  return out
}


function _appendSubtreeLines(out, node) {
  for (const c of node.children) {
    out.push(c.line)
    _appendSubtreeLines(out, c)
  }
}


// Render an in-place leaf value change as `head: old → new`. Used
// only on the pinned-diff path (`showOldNew`), where the prior value
// is not otherwise visible on the line. Both lines share a diff key,
// so they describe the same field; when both parse as `head: value`
// with the same head AND the value actually differs, show the
// transition. Otherwise fall back to the new line (the prior full
// block still carries the baseline for the model to compare).
function _formatLeafChange(priorLine, newLine) {
  const nm = newLine.match(/^(.*?:\s*)([\s\S]*)$/)
  const om = priorLine.match(/^(.*?:\s*)([\s\S]*)$/)
  if (nm && om && nm[1].trim() === om[1].trim()) {
    const oldVal = om[2].trim()
    const newVal = nm[2].trim()
    // Don't double an existing transition arrow (e.g. a scene line the
    // renderer already wrote as `X → Y` that itself changed).
    if (oldVal !== newVal && !oldVal.includes(' → ') && !newVal.includes(' → ')) {
      return `${nm[1]}${oldVal} → ${newVal}`
    }
  }
  return newLine
}


// Derive a stable key for diff-pairing from a tree node's line.
// Two nodes share a key when they represent the same logical
// "slot" in the canonical render. The patterns below cover every
// shape the scene renderer emits.
//
//   1. `- **Name** ...` / `- **Name** *(annotation)*`     → "Name"
//   2. `**Field**: value`                                  → "Field"
//   3. `- Field: value` / `Field: value`                   → "Field"
//   4. `- Name *(annotation)* — description` (scene
//      circumstances pattern)                              → "Name"
//   5. `- Name — description` (relationship participant
//      pattern)                                            → "Name"
//   6. `## Heading: value` / `### Heading: value`          → "## Heading"
//   7. Anything else (free-form text, e.g. a knowledge or
//      relationship description with no field name)        → full
//      trimmed text (line-identity pairing — identical lines
//      between renders pair cleanly; differing lines surface as
//      remove+add).
function _nodeKey(node) {
  const ln = (node.line || '').replace(/^ */, '')
  const body = ln.startsWith('- ') ? ln.slice(2) : ln
  // (1) Bolded leading name — `**Name**` or `- **Name**`.
  const boldMatch = body.match(/^\*\*([^*]+)\*\*/)
  if (boldMatch) return boldMatch[1].trim()
  // (2) / (3) / (6) Field with `:` separator (any leading markdown
  // prefix like `## ` or `### ` survives in the key so heading-style
  // lines don't collide with plain `Field:` lines).
  const colonIdx = body.indexOf(':')
  if (colonIdx > 0) {
    return body.slice(0, colonIdx).trim()
  }
  // (4) `Name *(annotation)*` — circumstance / motivator style.
  const annotIdx = body.indexOf(' *(')
  if (annotIdx > 0) return body.slice(0, annotIdx).trim()
  // (5) `Name — description` — relationship-participant style.
  const dashIdx = body.indexOf(' — ')
  if (dashIdx > 0) return body.slice(0, dashIdx).trim()
  return body.trim()
}


// Convert a `StoredAttachment` record (the persisted form on a
// `ConversationMessage`) back into the wire-shape `ChatAttachment`
// record (the form `chatClient.streamChat` / the backend adapter
// expects). Used when assembling the wire for subsequent turns so
// historical user messages retain the files they were originally
// sent with.
//
// Returns null when the stored attachment can't be re-encoded:
//   * text-kind without text_content (pre-v0.2.5.6 messages — the
//     content was never persisted)
//   * image-kind without data_url (similar pre-feature messages)
//   * file-kind (PDF / .docx / etc) — bytes were never persisted
//     by design, so we can't re-send them on subsequent turns.
//     A future iteration could ride a chip in the wire as a note
//     so the model knows a binary file was attached on a prior
//     turn; for now historical PDFs silently drop.
function _storedAttachmentToWire(att) {
  if (!att || !att.kind) return null
  if (att.kind === 'text') {
    if (typeof att.text_content !== 'string' || att.text_content.length === 0) return null
    return {
      kind: 'text',
      name: att.name || 'attachment.txt',
      mime_type: att.mime_type || 'text/plain',
      data_base64: _utf8ToBase64(att.text_content),
    }
  }
  if (att.kind === 'image') {
    // Assistant-image case (Phase 2.5e): when the persisted `wire_url`
    // is a hosted https:// URL, forward the URL verbatim — that's
    // what the upstream originally emitted and what subsequent turns
    // should see. Skips re-encoding bytes we already have locally for
    // display. When `wire_url` is itself a `data:` URL (model returned
    // raw bytes), or is missing entirely, fall through to the bytes
    // path so we ship whichever copy is actually available.
    if (typeof att.wire_url === 'string' && /^https?:\/\//i.test(att.wire_url)) {
      return {
        kind: 'image',
        name: att.name || 'image',
        mime_type: att.mime_type || 'image/jpeg',
        data_base64: '',
        wire_url: att.wire_url,
      }
    }
    if (typeof att.data_url !== 'string' || !att.data_url.startsWith('data:')) return null
    const commaIdx = att.data_url.indexOf(',')
    if (commaIdx < 0) return null
    return {
      kind: 'image',
      name: att.name || 'image',
      mime_type: att.mime_type || 'image/jpeg',
      data_base64: att.data_url.slice(commaIdx + 1),
    }
  }
  // file-kind: bytes weren't persisted, nothing to forward.
  return null
}


// UTF-8 encode → base64. Inverse of the `_decodeBase64Utf8`
// helper in ConversationView.jsx. Used to re-encode persisted
// text-attachment content for the wire.
function _utf8ToBase64(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}


