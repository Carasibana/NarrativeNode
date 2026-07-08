// Shhh! 🥚
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useEntitiesStore } from '../store/entitiesStore'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { OVUM_RED_STILL, OVUM_RED_VIDEO, OVUM_RED_AUDIO, OVUM_SILVER_AUDIO, OVUM_ORANGE_AUDIO } from './tpsReports'
import ImageHoverPreview from '../components/ui/ImageHoverPreview'
import { applyAccentPalette, DEFAULT_ACCENT_COLOR } from '../utils/povConstants'

// ══════════════════════════════════════════════════════════════════════
//   Shared session registry
// ══════════════════════════════════════════════════════════════════════
// Each egg records its activation here so a single dev-panel surface
// can render a "what's been activated this session" view without
// importing every egg's internals. Consumed by the Dev Preview's
// `Nest` page. Resets on reload.

const g_sessionFired = new Set()
const g_sessionListeners = new Set()
export function markEggFired(id) {
  if (g_sessionFired.has(id)) return
  g_sessionFired.add(id)
  for (const fn of g_sessionListeners) {
    try { fn() } catch { /* listener errors must never break a write */ }
  }
}
export function getFiredEggs() { return Array.from(g_sessionFired) }
export function subscribeFiredEggs(fn) {
  g_sessionListeners.add(fn)
  return () => g_sessionListeners.delete(fn)
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_red
// ══════════════════════════════════════════════════════════════════════

// ── ovum_red identity ──────────────────────────────────────────────────
const R_NAME   = 'Ranma Saotome'
const R_COLOUR = '#c8282c'

export function isOvumRedEntity(entity) {
  if (!entity) return false
  return (entity.name || '').trim() === R_NAME && (entity.colour || '').toLowerCase() === R_COLOUR
}

/** ovum_red-gated attribute value styling. Returns a style object for
 *  the chip value span, or null when no special treatment applies.
 *  Scoped to `isOvumRedEntity(entity)` so it NEVER affects other
 *  entities' attribute chips. Consumed by EntityNode.jsx and
 *  EntityDetailPanel.jsx when building chip descriptors. */
export function getOvumRedAttributeStyle(entity, field, value) {
  if (!isOvumRedEntity(entity)) return null
  if (!field || !value) return null
  const f = String(field).trim().toLowerCase()
  if (f === 'gender') {
    const v = String(value).trim().toLowerCase()
    const malish = /^m/.test(v) || v.includes('♂')
    const femish = /^f/.test(v) || v.includes('♀')
    if (malish && !femish) return { color: '#7dd3fc', fontWeight: 700 }
    if (femish && !malish) return { color: '#f472b6', fontWeight: 700 }
  }
  if (f === 'bust size') {
    return { fontWeight: 700 }
  }
  return null
}

// ── Session-scoped skip gates (not persisted) ──────────────────────────
const firedFromEntityIds = new Set()
let sessionDisabled = false
export function isOvumRedSessionDisabled() { return sessionDisabled }
export function setOvumRedSessionDisabled(v) { sessionDisabled = !!v }
export function clearOvumRedFiredFor(entityId) { firedFromEntityIds.delete(entityId) }

// ── Value vocab ────────────────────────────────────────────────────────
const MALE_VALUES = new Set([
  'male', 'm', 'man', 'boy', 'masculine', 'masc', 'he', 'him', 'he/him', '♂',
  // Japanese: kanji + common readings. Hiragana/katakana forms of each.
  '男', '男性', '雄', '男の子', 'おとこ', 'オトコ', 'だんせい', 'ダンセイ',
])
const FEMALE_VALUES = new Set([
  'female', 'f', 'woman', 'girl', 'feminine', 'fem', 'she', 'her', 'she/her', '♀',
  '女', '女性', '雌', '女の子', 'おんな', 'オンナ', 'じょせい', 'ジョセイ',
])
const SKIP_NAME_TOKENS = ['sexual', 'orientation', 'attract', 'romantic']

function norm(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase()
}

/** Detect a scene-level value transition from male-coded → female-coded,
 *  ignoring attributes whose name looks like it's about sexuality /
 *  orientation / attraction / romantic preference. */
export function isOvumRedTrigger(attrName, oldValue, newValue) {
  const n = norm(attrName)
  if (!n) return false
  if (SKIP_NAME_TOKENS.some((tok) => n.includes(tok))) return false
  const o = norm(oldValue)
  const v = norm(newValue)
  if (!o || !v) return false
  return MALE_VALUES.has(o) && FEMALE_VALUES.has(v)
}

// ── Preloaded video element (keeps user gesture alive for audio) ──────
// Browsers only allow unmuted autoplay inside an active user-gesture
// chain. The save click IS one, but we lose it across the createEntity
// network call. Trick: synchronously create an offscreen <video> and
// call .play() on it BEFORE any await — playback starts with audio
// while the gesture is still valid. When the avatar mounts later we
// move the SAME element into its DOM slot; same element = same audio
// permission = audio continues seamlessly.
let preloadedVideoEl = null
function primeOvumRedPlayback() {
  if (preloadedVideoEl) return
  if (typeof document === 'undefined') return
  const el = document.createElement('video')
  el.src = OVUM_RED_VIDEO
  // Mute the video explicitly — in practice the browser silently
  // refuses unmuted video autoplay even with the gesture token, so
  // keeping it muted and playing a separate audio clip (below) is the
  // reliable path. On click-replay the video runs with its own audio.
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
  document.body.appendChild(el)
  try {
    const p = el.play?.()
    if (p && typeof p.catch === 'function') p.catch(() => { /* avatar will fall back to muted */ })
  } catch { /* noop */ }
  preloadedVideoEl = el
  // Safety: if the avatar never adopts this element (e.g. createEntity
  // fails), tear it down after 20s so we don't leak.
  setTimeout(() => {
    if (preloadedVideoEl === el) {
      try { el.parentNode?.removeChild(el) } catch { /* noop */ }
      preloadedVideoEl = null
    }
  }, 20000)
}
function takePreloadedVideoEl() {
  const el = preloadedVideoEl
  preloadedVideoEl = null
  return el
}

// Standalone audio SFX — plays alongside the splash animation. Fires
// synchronously inside the save gesture so the browser allows unmuted
// playback; <audio> autoplay policy is strictly gesture-based and has
// been more reliable than video-with-audio in practice.
function primeOvumRedAudio() {
  if (typeof document === 'undefined') return
  const el = document.createElement('audio')
  el.src = OVUM_RED_AUDIO
  el.preload = 'auto'
  el.style.display = 'none'
  document.body.appendChild(el)
  const cleanup = () => {
    try { el.parentNode?.removeChild(el) } catch { /* noop */ }
  }
  el.addEventListener('ended', cleanup)
  el.addEventListener('error', cleanup)
  try {
    const p = el.play?.()
    if (p && typeof p.catch === 'function') p.catch(() => cleanup())
  } catch { cleanup() }
  // Safety net if neither ended nor error fires.
  setTimeout(cleanup, 8000)
}

// ── Detection hook — called from projectStore.saveEntityChipDraft ──────
/** Scan the draft's attribute_changes for an in-chain 'modify' whose old
 *  → new transition matches the trigger. `entitiesStore` is passed so we
 *  can look up the old (pre-modify) attribute value + name. Returns true
 *  if the egg fired (for logging / tests), false otherwise. */
export function detectAndFireOvumRed({ draft, entity, sourceEntityId }) {
  if (sessionDisabled) return false
  if (firedFromEntityIds.has(sourceEntityId)) return false
  const changes = draft?.attribute_changes || []
  if (!changes.length || !entity) return false

  for (const ac of changes) {
    if (ac.action !== 'modify') continue
    const priorAttr = (entity.attributes || []).find((a) => a.id === ac.attribute_id)
    if (!priorAttr) continue
    // Only text/preset attributes have a comparable scalar value.
    if (priorAttr.attribute_type !== 'text' && priorAttr.attribute_type !== 'preset') continue
    if (isOvumRedTrigger(priorAttr.name, priorAttr.value, ac.new_value)) {
      const entsStore = useEntitiesStore.getState()
      const alreadyExists = (entsStore.characters || []).some(isOvumRedEntity)
      if (alreadyExists) return false
      firedFromEntityIds.add(sourceEntityId)
      markEggFired('red')
      // CRITICAL: start playback synchronously here to claim the
      // gesture token before any await below loses it. Audio element
      // carries the SFX (reliable under gesture); video element is
      // muted until the user clicks to replay.
      primeOvumRedPlayback()
      primeOvumRedAudio()
      // Fire asynchronously so we don't block the save path.
      Promise.resolve().then(() => { fireOvumRed().catch(() => {}) })
      return true
    }
  }
  return false
}

// ── Animation kickoff on entity appearance ─────────────────────────────
// The gender flip + bust size animations are wired through an
// entitiesStore subscription instead of being fired directly from
// fireOvumRed(). That way the same animations also run when the
// entity is RESTORED via redo after an undo — the `_entityCreated`
// snapshot captures the entity in its pre-animation state, so redo
// walks the same animation path as a fresh spawn. Load from a saved
// .nnz is unaffected because the subscription gates on the
// pre-animation state, which doesn't match a saved post-animation
// entity.
let ovumRedSubscriptionInstalled = false
function ensureOvumRedAnimationSubscription() {
  if (ovumRedSubscriptionInstalled) return
  ovumRedSubscriptionInstalled = true
  useEntitiesStore.subscribe((state, prev) => {
    const prevRanma = (prev?.characters || []).find(isOvumRedEntity)
    const curRanma  = (state?.characters || []).find(isOvumRedEntity)
    if (prevRanma || !curRanma) return  // only fire when the trigger entity newly appears
    const attrs = curRanma.attributes || []
    const gender = attrs.find((a) => (a.name || '').trim().toLowerCase() === 'gender')
    const bust   = attrs.find((a) => (a.name || '').trim().toLowerCase() === 'bust size')
    if (!gender || bust) return  // not in pre-animation state
    const v = (gender.value || '').trim().toLowerCase()
    if (!(/^m/.test(v) || v.includes('♂'))) return
    const FLIP_START_MS = 1800
    const FLIP_DURATION_MS = 7 * 140
    setTimeout(() => animateGenderFlip(curRanma.id), FLIP_START_MS)
    setTimeout(() => addBustSizeAttribute(curRanma.id), FLIP_START_MS + FLIP_DURATION_MS + 150)
  })
}
// Defer install to the next microtask so module-load cycles don't see
// a half-initialised `useEntitiesStore` (entitiesStore imports this
// file; a top-level subscription call runs while entitiesStore is
// mid-initialisation, which crashes app startup with a blank UI).
if (typeof queueMicrotask === 'function') {
  queueMicrotask(ensureOvumRedAnimationSubscription)
} else {
  setTimeout(ensureOvumRedAnimationSubscription, 0)
}

// ── Prepopulated attributes ────────────────────────────────────────────
function buildCanonicalAttributes() {
  const mk = (name, value) => ({
    name,
    attribute_type: 'text',
    value,
  })
  return [
    // Deliberately starts as Male so we can animate the flip to Female
    // mid-video — see the delayed updateEntity call in fireOvumRed.
    mk('Gender', 'Male'),
    mk('Curse origin', 'Spring of Drowned Girl, Jusenkyo'),
    mk('Martial art', 'Anything Goes Martial Arts'),
    mk('Weakness', 'Cats'),
    mk('Trigger', 'Cold water transforms into cursed form; hot water reverses it'),
  ]
}

// ── Prepopulated relationships ─────────────────────────────────────────
// Partners don't exist as real Entity records in the user's project — we
// use unresolvable entity_b_ids and the generic *_fallback fields on the
// Relationship object so the ghost-partner render path kicks in for each
// sub-chip. Keeps the library clean while the spawned entity still
// displays its canonical supporting cast.
function buildCanonicalRelationships(ranmaId) {
  const cast = [
    { name: 'Genma Saotome',  colour: '#545454', selfDesc: 'Father (occasional panda)',                 otherDesc: 'Son' },
    { name: 'Akane Tendo',    colour: '#0f4a98', selfDesc: 'Fiancée (arranged)',                         otherDesc: 'Fiancé' },
    { name: 'Ryoga Hibiki',   colour: '#d4a017', selfDesc: "Secret crush. Absolutely not handling how attractive he is. Keeps up the rivalry act to cope. She'd sooner die than admit any of this. (Also: he's secretly P-chan.)", otherDesc: 'Rival; quietly drawn to her girl form' },
    { name: 'Tatewaki Kuno',  colour: '#4ebfe9', selfDesc: 'Rival; in love with the pig-tailed girl',    otherDesc: "Rival; unaware of her real identity" },
    { name: 'Shampoo',        colour: '#9150e6', selfDesc: 'Amazon fiancée by village law',              otherDesc: 'Airen' },
  ]
  return cast.map((c) => ({
    id: crypto.randomUUID(),
    entity_a_id: ranmaId,
    entity_b_id: crypto.randomUUID(),  // deliberately unresolvable
    entity_a_description: c.selfDesc,
    entity_b_description: c.otherDesc,
    entity_b_name_fallback:   c.name,
    entity_b_colour_fallback: c.colour,
  }))
}

// ── Spawn ──────────────────────────────────────────────────────────────
async function fireOvumRed() {
  const ui = useUiStore.getState()
  const project = useProjectStore.getState()
  const ents = useEntitiesStore.getState()
  // Re-check at fire-time — another path may have created one meanwhile.
  if ((ents.characters || []).some(isOvumRedEntity)) return

  // Drop the node at a sensible spot; the viewport will pan + zoom
  // onto it via _focusNode below (same mechanism as Alerts and the
  // Timeline Navigator), so the exact spawn position just has to be
  // a valid canvas coordinate — not carefully hand-centered.
  const vp = ui._getViewportCenter?.() || { x: 200, y: 200 }
  const pos = { x: Math.round(vp.x - 130), y: Math.round(vp.y - 160) }

  // Pre-generate the entity id so the relationships can reference it as
  // entity_a_id at create time (avoids a second API call to attach them).
  const ranmaId = crypto.randomUUID()
  const payload = {
    id: ranmaId,
    type: 'character',
    name: R_NAME,
    colour: R_COLOUR,
    description: 'A young martial artist with an unexpected predicament involving cold water.',
    attributes: buildCanonicalAttributes(),
    relationships: buildCanonicalRelationships(ranmaId),
  }

  let created
  try {
    created = await ents.createEntity(payload)
  } catch {
    // Network / backend failure — fail silent, un-mark the fired gate so
    // a later trigger can try again.
    return
  }
  if (!created || !created.entity_node) return

  // The backend append-seeds step at creation time adds every configured
  // attribute stub to the entity's `attributes[]` regardless of whether the
  // caller already supplied one by the same name. When the active project
  // has a Gender (or any other canonical-name) seed stub, this produces a
  // duplicate attribute row on the newly created entity. Deduplicate by
  // case-insensitive trimmed name, keeping the first occurrence so our
  // canonical values take precedence over the stubs' defaults. Persist the
  // cleaned list back to the backend so save/reload stays consistent.
  const rawAttrs = created.entity?.attributes || []
  const seenNames = new Set()
  const dedupedAttrs = []
  for (const attr of rawAttrs) {
    const key = (attr?.name || '').trim().toLowerCase()
    if (key && seenNames.has(key)) continue
    if (key) seenNames.add(key)
    dedupedAttrs.push(attr)
  }
  if (dedupedAttrs.length !== rawAttrs.length) {
    try {
      const cleaned = await useEntitiesStore.getState().updateEntity(
        created.entity.id,
        { ...created.entity, attributes: dedupedAttrs },
      )
      if (cleaned) created = { ...created, entity: cleaned }
    } catch { /* best-effort; animation can still proceed */ }
  }

  // Widen the node so the long canonical name + relationship sub-chip
  // descriptions aren't truncated. Default is 160px; 260 gives breathing
  // room for 5-cast-member chips without forcing the user to resize.
  const nodeWithWidth = { ...created.entity_node, width: 260 }
  // Pass createdEntity so Ctrl+Z removes the entity from the library
  // (and backend) in addition to the canvas node — single atomic undo.
  project.addEntityNodeToCanvas(nodeWithWidth, pos, { createdEntity: created.entity, zIndex: 1100 })
  // Pan + zoom the viewport onto the spawned node, same jump
  // mechanism that Alerts and the Timeline Navigator use. Tiny delay
  // so React Flow has registered the node before fitView runs.
  setTimeout(() => {
    const focusFn = useUiStore.getState()._focusNode
    if (focusFn) focusFn(created.entity_node.id)
  }, 80)
  triggerSpeechBubble(created.entity.id)
  // The gender flip + Bust Size animations are kicked off by the
  // entitiesStore subscription (ensureOvumRedAnimationSubscription),
  // which also handles re-animating on redo.
}

function addBustSizeAttribute(entityId) {
  const store = useEntitiesStore.getState()
  const fresh = store.getEntityById(entityId)
  if (!fresh) return
  // Bail if an attribute with this name already exists (e.g. re-fire).
  if ((fresh.attributes || []).some((a) => (a.name || '').trim().toLowerCase() === 'bust size')) return
  // Insert right under Gender so it reads as a visually-related row.
  const attrs = [...(fresh.attributes || [])]
  const genderIdx = attrs.findIndex((a) => (a.name || '').trim().toLowerCase() === 'gender')
  const insertIdx = genderIdx >= 0 ? genderIdx + 1 : attrs.length
  attrs.splice(insertIdx, 0, {
    name: 'Bust Size',
    attribute_type: 'text',
    value: '34A',
  })
  // Local-only insert (no API) so the animation frames don't each
  // round-trip. The final persisted write happens at the last frame.
  const bucket = fresh.type + 's'
  useEntitiesStore.setState({
    [bucket]: (useEntitiesStore.getState()[bucket] || []).map((e) =>
      e.id === entityId ? { ...e, attributes: attrs } : e
    ),
  })
  // Animate the cup letter: A → B → C → D. Frames 2–4 step through
  // locally; the final D write goes through updateEntity so the
  // resulting "34D" is persisted to the backend.
  const FRAME_MS = 350
  const frames = ['34B', '34C', '34D']
  frames.forEach((value, i) => {
    setTimeout(
      () => writeBustSizeValue(entityId, value, i === frames.length - 1),
      (i + 1) * FRAME_MS,
    )
  })
}

function writeBustSizeValue(entityId, value, persist) {
  const store = useEntitiesStore.getState()
  const fresh = store.getEntityById(entityId)
  if (!fresh) return
  const updatedAttrs = (fresh.attributes || []).map((a) =>
    (a.name || '').trim().toLowerCase() === 'bust size' ? { ...a, value } : a
  )
  if (persist) {
    store.updateEntity(entityId, { ...fresh, attributes: updatedAttrs })
      .catch(() => { /* best-effort */ })
  } else {
    const bucket = fresh.type + 's'
    useEntitiesStore.setState({
      [bucket]: (useEntitiesStore.getState()[bucket] || []).map((e) =>
        e.id === entityId ? { ...e, attributes: updatedAttrs } : e
      ),
    })
  }
}

function animateGenderFlip(entityId) {
  const frames = ['Male', 'M♂', '♂', '♂ ↯ ♀', '♀', 'F♀', 'Female']
  const FRAME_MS = 140
  let i = 0

  function writeValue(value, persist) {
    const store = useEntitiesStore.getState()
    const fresh = store.getEntityById(entityId)
    if (!fresh) return
    const updatedAttrs = (fresh.attributes || []).map((a) =>
      a.name === 'Gender' ? { ...a, value } : a
    )
    if (persist) {
      store.updateEntity(entityId, { ...fresh, attributes: updatedAttrs })
        .catch(() => { /* best-effort */ })
    } else {
      // Local-only mutation: skip the API round-trip for intermediate
      // frames. Final frame (persist=true) does the backend sync.
      const bucket = fresh.type + 's'
      useEntitiesStore.setState({
        [bucket]: (useEntitiesStore.getState()[bucket] || []).map((e) =>
          e.id === entityId ? { ...e, attributes: updatedAttrs } : e
        ),
      })
    }
  }

  function tick() {
    if (i >= frames.length) return
    const isFinal = i === frames.length - 1
    writeValue(frames[i], isFinal)
    i += 1
    if (!isFinal) setTimeout(tick, FRAME_MS)
  }
  tick()
}

// ── Speech bubble overlay ──────────────────────────────────────────────
// Intro sequence plays in order once per bubble session; then a few
// random picks from the quote pool (shuffled per session, no immediate
// repeats). Direct quote lines are canonical / iconic; mild body-aware
// lines stay firmly SFW and avoid anything that sounds aimed at the
// viewer of the screen.
const OVUM_RED_INTRO = [
  "Gah — that's COLD!",
  "Ugh... not AGAIN with the cold water.",
  "And these things'll throw off my balance the rest of the day.",
]
const OVUM_RED_QUOTES = [
  "You want it, Baby? You got it!",
  "And I'm better built, to boot!",
  "I don't lose to anyone!",
  "Saotome school of Anything Goes — you'll regret stepping up.",
  "I can fight twice as well as you. In BOTH forms.",
  "What? Never seen a transforming martial artist before?",
  "Yeah, I can pull this look off. So?",
  "This body's faster. Lighter on its feet. Not bad, actually.",
  "Go ahead and stare. Just don't blame me when you eat dirt.",
]

const PER_LINE_MS = 2800
const GAP_MIN_MS  = 2500
const GAP_MAX_MS  = 5000
const INTRO_COUNT = 3
const RANDOM_COUNT = 3

function randomGapMs() {
  return GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS)
}

function buildSpeechSequence() {
  const pool = [...OVUM_RED_QUOTES]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return [...OVUM_RED_INTRO.slice(0, INTRO_COUNT), ...pool.slice(0, RANDOM_COUNT)]
}

let bubbleSubscribers = new Set()
let currentBubble = null  // { entityId, sequence, startedAt }
function setBubble(next) {
  currentBubble = next
  bubbleSubscribers.forEach((fn) => { try { fn(currentBubble) } catch { /* noop */ } })
}
function subscribeBubble(fn) {
  bubbleSubscribers.add(fn)
  fn(currentBubble)
  return () => bubbleSubscribers.delete(fn)
}
function triggerSpeechBubble(entityId) {
  setBubble({ entityId, sequence: buildSpeechSequence(), startedAt: Date.now() })
}

// Inject splash keyframes once on first OvumRedAvatar mount. Done via a
// one-shot <style> element rather than a CSS file to keep the egg's DOM
// footprint self-contained and the shared CSS tree uncluttered.
let splashStyleInjected = false
function ensureSplashStyle() {
  if (splashStyleInjected || typeof document === 'undefined') return
  splashStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `
@keyframes ovumRedRipple {
  0%   { transform: scale(0.15); opacity: 0.85; }
  100% { transform: scale(2.6);  opacity: 0;    }
}
@keyframes ovumRedDroplet {
  0%   { transform: translate(0, 0) scale(1);        opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.4); opacity: 0; }
}
`
  document.head.appendChild(style)
}

const SPLASH_MS = 1100

/** Splash overlay — expanding ring + radial droplets. Sized to spill
 *  well beyond the 40×40 avatar via negative insets + overflow visible
 *  on the parent wrapper. Unmounts itself after the animation finishes. */
function OvumRedSplash() {
  const DROPLETS = [
    { dx:  58, dy: -36 }, { dx:  72, dy:   8 },
    { dx:  48, dy:  46 }, { dx:   0, dy:  66 },
    { dx: -48, dy:  46 }, { dx: -72, dy:   8 },
    { dx: -58, dy: -36 }, { dx:   0, dy: -68 },
  ]
  return (
    <div style={{
      position: 'absolute', left: '50%', top: '50%',
      width: 0, height: 0, pointerEvents: 'none', zIndex: 20,
    }}>
      {[0, 180, 360].map((delay, i) => (
        <span key={`r${i}`} style={{
          position: 'absolute', left: -36, top: -36, width: 72, height: 72,
          borderRadius: '50%', border: '2.5px solid #4ec9f0',
          boxShadow: '0 0 12px rgba(78, 201, 240, 0.65)',
          animation: `ovumRedRipple ${SPLASH_MS}ms ease-out ${delay}ms forwards`,
        }} />
      ))}
      {DROPLETS.map((d, i) => (
        <span key={`d${i}`} style={{
          position: 'absolute', left: -4, top: -4, width: 8, height: 8,
          borderRadius: '50%', background: '#7ddcf7',
          boxShadow: '0 0 8px rgba(125, 220, 247, 0.85)',
          '--dx': `${d.dx}px`, '--dy': `${d.dy}px`,
          animation: `ovumRedDroplet ${SPLASH_MS}ms cubic-bezier(.2,.6,.3,1) forwards`,
        }} />
      ))}
    </div>
  )
}

/** Avatar component that replaces the profile-image square on the
 *  ovum_red entity origin node. Adopts the preloaded video element
 *  (started with audio during the save-click gesture chain) and
 *  transfers it into its DOM slot so audio continues seamlessly.
 *  Falls back to a fresh muted-autoplay video if no preload exists.
 *  Swaps to the still on video end; click-to-replay from the still. */
export function OvumRedAvatar({ entityId, colour, size = 40, showSplash = true, showBubble = true }) {
  const slotRef = useRef(null)
  const videoElRef = useRef(null)
  const [mode, setMode] = useState('video')   // 'video' | 'still'
  const [splash, setSplash] = useState(showSplash)
  const [popupOpen, setPopupOpen] = useState(false)

  // ── Adopt preload / create fallback element on mount ─────────────────
  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return undefined

    const preloaded = takePreloadedVideoEl()
    let el
    if (preloaded) {
      el = preloaded
    } else {
      // Fallback — no gesture-primed element was waiting (egg fired
      // through a non-gesture path). Use muted autoplay.
      el = document.createElement('video')
      el.src = OVUM_RED_VIDEO
      el.muted = true
      el.autoplay = true
      el.playsInline = true
      el.preload = 'auto'
      el.play?.().catch(() => { /* noop */ })
    }
    el.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
    slot.appendChild(el)
    videoElRef.current = el

    const handleEnded = () => setMode('still')
    el.addEventListener('ended', handleEnded)
    // If the preload already finished during the createEntity delay,
    // switch straight to the still so we don't flash a black video.
    // Deferred to a microtask so we don't setState during the effect body.
    const endedCheckTimer = el.ended ? setTimeout(() => setMode('still'), 0) : null

    return () => {
      if (endedCheckTimer) clearTimeout(endedCheckTimer)
      el.removeEventListener('ended', handleEnded)
      try { if (el.parentNode === slot) slot.removeChild(el) } catch { /* noop */ }
    }
  }, [])

  // Video visibility tracks `mode` without unmounting the element.
  useEffect(() => {
    const el = videoElRef.current
    if (!el) return
    el.style.display = mode === 'video' ? 'block' : 'none'
  }, [mode])

  // Splash animation mount/unmount (disabled when showSplash=false).
  useEffect(() => {
    if (!showSplash) {
      const t0 = setTimeout(() => setSplash(false), 0)
      return () => clearTimeout(t0)
    }
    ensureSplashStyle()
    const t = setTimeout(() => setSplash(false), SPLASH_MS + 100)
    return () => clearTimeout(t)
  }, [showSplash])

  // Click-to-replay — fresh user gesture guarantees unmuted play works.
  const replay = useCallback(() => {
    const el = videoElRef.current
    if (!el) return
    setMode('video')
    setSplash(false)
    // Retrigger the splash by toggling off then on a tick later.
    setTimeout(() => setSplash(true), 0)
    setTimeout(() => setSplash(false), SPLASH_MS + 100)
    el.currentTime = 0
    el.muted = false
    const p = el.play?.()
    if (p && typeof p.catch === 'function') {
      p.catch(() => { el.muted = true; el.play?.().catch(() => { setMode('still') }) })
    }
  }, [])

  const handleClick = (e) => {
    // Don't navigate to the detail panel — the parent node body handler
    // will still fire on bubble-up unless we stop it. Skip the replay
    // when this click is the first half of a double-click (e.detail>=2
    // on the second click) so a double-click doesn't end up replaying
    // the inline video under the popup.
    e.stopPropagation()
    if (e.detail >= 2) return
    replay()
  }

  const handleDoubleClick = (e) => {
    e.stopPropagation()
    e.preventDefault()
    // Pause the inline element and flip to the still so we don't end
    // up with two videos playing at once (inline + popup).
    const inline = videoElRef.current
    if (inline) { try { inline.pause() } catch { /* noop */ } }
    setMode('still')
    setPopupOpen(true)
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block', overflow: 'visible', flexShrink: 0 }}>
      <ImageHoverPreview src={OVUM_RED_STILL} borderColour={colour} size={160}>
        <div
          className="rounded-sm overflow-hidden cursor-pointer relative"
          style={{
            width: size, height: size,
            border: `2px solid ${colour}`,
            backgroundColor: '#000',
          }}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          title="Click to replay · Double-click to open"
        >
          <div ref={slotRef} style={{ position: 'absolute', inset: 0 }} />
          {mode === 'still' && (
            <img
              src={OVUM_RED_STILL}
              alt=""
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%', objectFit: 'cover', display: 'block',
              }}
            />
          )}
        </div>
      </ImageHoverPreview>
      {splash && <OvumRedSplash />}
      {showBubble && <SpeechBubbleHost entityId={entityId} />}
      {popupOpen && <OvumRedFullVideoPopup colour={colour} onClose={() => setPopupOpen(false)} />}
    </span>
  )
}

/** Full-screen centred overlay that plays the video at a comfortable
 *  size (min(80vmin, 512px), upscaled from the 256×256 source). Auto-
 *  closes when the video ends; dismissible via backdrop click or Esc.
 *  Double-click on the inline avatar is a fresh user gesture, so
 *  unmuted autoplay via the native `autoPlay` attribute is allowed.
 *  Uses an `onClose` ref so parent re-renders don't re-fire effects or
 *  restart playback. */
function OvumRedFullVideoPopup({ colour, onClose }) {
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 10000, background: 'rgba(0, 0, 0, 0.82)' }}
      onClick={() => onCloseRef.current?.()}
    >
      <video
        src={OVUM_RED_VIDEO}
        playsInline
        autoPlay
        controls
        onEnded={() => onCloseRef.current?.()}
        style={{
          width: 'min(80vmin, 512px)',
          height: 'min(80vmin, 512px)',
          objectFit: 'contain',
          border: `2px solid ${colour || '#c8282c'}`,
          borderRadius: 4,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.6)',
          background: '#000',
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

function SpeechBubbleHost({ entityId }) {
  const [bubble, setBubbleLocal] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const hostRef = useRef(null)
  const [lineIdx, setLineIdx] = useState(0)

  useEffect(() => {
    const un = subscribeBubble((b) => {
      if (b && b.entityId === entityId) setBubbleLocal(b)
      else setBubbleLocal(null)
    })
    return un
  }, [entityId])

  // Step through the sequence via scheduled timeouts; dismiss on last.
  // Intro lines (first INTRO_COUNT) play back-to-back without gaps so
  // they read as one continuous opening thought. After the intro, each
  // subsequent line gets a randomized 2.5-5s pause before it appears
  // so the quotes feel like spontaneous remarks rather than a crawl.
  // lineIdx of -1 hides the bubble during the gap.
  useEffect(() => {
    if (!bubble) return undefined
    const seq = bubble.sequence || []
    if (seq.length === 0) return undefined
    setLineIdx(0)
    const timers = []
    let cursor = 0
    for (let i = 1; i < seq.length; i++) {
      // End of line (i-1): always after PER_LINE_MS of display.
      cursor += PER_LINE_MS
      const isPostIntro = (i - 1) >= INTRO_COUNT - 1
      // Gap only kicks in after the intro block has played.
      const gap = isPostIntro ? randomGapMs() : 0
      if (gap > 0) {
        const hideAt = cursor
        timers.push(setTimeout(() => setLineIdx(-1), hideAt))
        cursor += gap
      }
      const showAt = cursor
      timers.push(setTimeout(() => setLineIdx(i), showAt))
    }
    // After last line, dismiss globally.
    cursor += PER_LINE_MS
    timers.push(setTimeout(() => setBubble(null), cursor))
    return () => { timers.forEach(clearTimeout) }
  }, [bubble])

  useEffect(() => {
    if (!bubble) {
      const t = setTimeout(() => setAnchor(null), 0)
      return () => clearTimeout(t)
    }
    const update = () => {
      const el = hostRef.current?.parentElement  // the avatar box
      if (!el) return
      const r = el.getBoundingClientRect()
      setAnchor({ left: r.right + 8, top: r.top - 6 })
    }
    const initial = setTimeout(update, 0)
    const iv = setInterval(update, 120)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      clearTimeout(initial)
      clearInterval(iv)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [bubble])

  // Invisible anchor — used to find the avatar DOM via parentElement.
  return (
    <>
      <span ref={hostRef} style={{ display: 'none' }} />
      {bubble && anchor && lineIdx >= 0 && createPortal(
        <div
          style={{
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            zIndex: 9998,
            pointerEvents: 'none',
            maxWidth: 220,
            background: '#fff',
            color: '#111',
            border: '1.5px solid #111',
            borderRadius: 10,
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          }}
        >
          <span style={{
            position: 'absolute', left: -7, top: 12, width: 0, height: 0,
            borderTop: '6px solid transparent', borderBottom: '6px solid transparent',
            borderRight: '7px solid #111',
          }} />
          <span style={{
            position: 'absolute', left: -5, top: 13, width: 0, height: 0,
            borderTop: '5px solid transparent', borderBottom: '5px solid transparent',
            borderRight: '6px solid #fff',
          }} />
          {bubble?.sequence?.[lineIdx] || ''}
        </div>,
        document.body,
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_silver
// ══════════════════════════════════════════════════════════════════════

// ── ovum_silver trigger ────────────────────────────────────────────────
const SILVER_TRIGGER_NAMES = new Set(['clippy', 'clippit'])

export function isOvumSilverTrigger(name) {
  if (!name) return false
  return SILVER_TRIGGER_NAMES.has(String(name).trim().toLowerCase())
}

// Per-entity summon gate: once a given entity id has triggered the
// assistant in this session, further updates of the SAME entity won't
// re-summon. Naming a DIFFERENT entity to the trigger will summon
// again. Not persisted across reloads.
const summonedForSilverEntity = new Set()

// Remember which entity summoned him this session so lines like the
// "hat" one can act on it retroactively (see SILVER_HAT_LINE below).
let lastSilverTriggerEntityId = null
// Track which entity ids have already received the hat attribute, so
// if the hat line cycles round a second time we don't re-add.
const silverHattedEntityIds = new Set()

// Exact text of the "hat" line. When this particular line becomes the
// currently-shown bubble, the assistant takes its own advice and adds
// a Hat: Has one attribute to the summoning entity. Named const so
// renaming the line here and in the static pool below stays in one
// place.
const SILVER_HAT_LINE = "Have you considered giving one of your characters a hat? Hats add depth."

// ── Dynamic React root (keeps the assistant off the shared App tree) ──
let silverRoot = null
let silverContainer = null
let silverStyleInjected = false

function ensureSilverStyle() {
  if (silverStyleInjected || typeof document === 'undefined') return
  silverStyleInjected = true
  const s = document.createElement('style')
  s.textContent = `
@keyframes ovumSilverSlide {
  0%   { transform: translate(120%, 40%); opacity: 0; }
  100% { transform: translate(0, 0);       opacity: 1; }
}
@keyframes ovumSilverBob {
  0%, 100% { transform: translateY(0);    }
  50%      { transform: translateY(-6px); }
}
@keyframes ovumSilverBlink {
  0%, 92%, 100% { transform: scaleY(1);    }
  95%, 98%      { transform: scaleY(0.1);  }
}
@keyframes ovumSilverGlance {
  0%, 55%, 100% { transform: translateX(0);   }
  62%, 75%      { transform: translateX(-4px); }
  85%           { transform: translateX(3px); }
}
@keyframes ovumSilverBrowRaise {
  0%, 85%, 100% { transform: translateY(0);    }
  90%, 95%      { transform: translateY(-4px); }
}
/* Panic-mode animations — fast, twitchy, exaggerated. */
@keyframes ovumSilverBrowPanic {
  0%, 100% { transform: translateY(-8px) rotate(-3deg); }
  25%      { transform: translateY(-11px) rotate(2deg); }
  50%      { transform: translateY(-7px) rotate(-2deg); }
  75%      { transform: translateY(-10px) rotate(3deg); }
}
@keyframes ovumSilverGlancePanic {
  0%, 100% { transform: translateX(-5px) translateY(-1px); }
  30%      { transform: translateX(5px) translateY(1px);  }
  60%      { transform: translateX(-4px) translateY(2px); }
  85%      { transform: translateX(4px) translateY(-2px); }
}
@keyframes ovumSilverPupilWide {
  0%, 100% { transform: scale(1.25); }
  50%      { transform: scale(1.35); }
}
@keyframes ovumSilverJitter {
  0%, 100% { transform: translate(0, 0) rotate(0deg);   }
  20%      { transform: translate(-2px, 1px) rotate(-1deg); }
  40%      { transform: translate(2px, -1px) rotate(1deg); }
  60%      { transform: translate(-1px, 2px) rotate(-0.5deg); }
  80%      { transform: translate(1px, -2px) rotate(0.5deg); }
}
/* Relief — gentle wipe-the-brow easing back to normal. */
@keyframes ovumSilverBrowRelief {
  0%   { transform: translateY(-6px); }
  100% { transform: translateY(0); }
}
`
  document.head.appendChild(s)
}

// Module-level handle to the active intro Audio element so the
// dismiss handler can silence it if the user closes the assistant
// mid-intro. Created on first mount, replaced on each re-mount.
let silverIntroAudio = null

function playOvumSilverIntro() {
  // The trigger chain is entity-save → detectAndFireOvumSilver → mount,
  // which runs synchronously inside the user's save click — autoplay
  // policies treat that as a valid gesture. Try/catch covers the rare
  // browser that still rejects (silent failure: visual still works).
  try {
    if (silverIntroAudio) {
      try { silverIntroAudio.pause() } catch { /* nothing */ }
    }
    silverIntroAudio = new Audio(OVUM_SILVER_AUDIO)
    silverIntroAudio.preload = 'auto'
    const p = silverIntroAudio.play()
    if (p && typeof p.catch === 'function') p.catch(() => { /* blocked — silent */ })
  } catch { /* nothing */ }
}

function stopOvumSilverIntro() {
  if (!silverIntroAudio) return
  try { silverIntroAudio.pause() } catch { /* nothing */ }
  silverIntroAudio.src = ''
  silverIntroAudio = null
}

function mountOvumSilver() {
  if (silverRoot) return
  if (typeof document === 'undefined') return
  ensureSilverStyle()
  silverContainer = document.createElement('div')
  document.body.appendChild(silverContainer)
  silverRoot = createRoot(silverContainer)
  silverRoot.render(<OvumSilverAssistant onDismiss={unmountOvumSilver} />)
  playOvumSilverIntro()
}

function unmountOvumSilver() {
  stopOvumSilverIntro()
  if (!silverRoot) return
  try { silverRoot.unmount() } catch { /* noop */ }
  silverRoot = null
  if (silverContainer?.parentNode) {
    try { silverContainer.parentNode.removeChild(silverContainer) } catch { /* noop */ }
  }
  silverContainer = null
}

/** Called from entitiesStore on entity create + update. Gated on
 *  name-match + per-entity first-time-only. Fire-and-forget, never
 *  throws — the egg must never break an entity save. */
export function detectAndFireOvumSilver(entity) {
  if (!entity || !entity.id) return false
  if (!isOvumSilverTrigger(entity.name)) return false
  if (summonedForSilverEntity.has(entity.id)) return false
  summonedForSilverEntity.add(entity.id)
  markEggFired('silver')
  // Remember which entity summoned him — later lines (e.g. the hat
  // line) will mutate this entity's attributes for comic effect.
  lastSilverTriggerEntityId = entity.id
  try { mountOvumSilver() } catch { /* noop */ }
  return true
}

/** Add a Hat: Has one attribute to the entity that summoned the
 *  assistant this session — fired when the hat line appears in the
 *  bubble. Idempotent per session (skips if already hatted or if the
 *  entity already has a Hat attribute for any reason). */
function addHatToSilverTriggerEntity() {
  const id = lastSilverTriggerEntityId
  if (!id) return
  if (silverHattedEntityIds.has(id)) return
  silverHattedEntityIds.add(id)
  try {
    const ents = useEntitiesStore.getState()
    const entity = ents.getEntityById?.(id)
    if (!entity) return
    const alreadyHatted = (entity.attributes || []).some(
      (a) => (a?.name || '').trim().toLowerCase() === 'hat',
    )
    if (alreadyHatted) return
    const newAttr = { name: 'Hat', attribute_type: 'text', value: 'Has one' }
    ents.updateEntity(entity.id, {
      ...entity,
      attributes: [...(entity.attributes || []), newAttr],
    }).catch(() => { /* best-effort — egg must never break saves */ })
  } catch { /* noop */ }
}

// ── Lines ──────────────────────────────────────────────────────────────
// Static pool (paraphrased / original riffs in the spirit of the
// reference; never verbatim third-party copy). Supplemented at
// session-start with a few dynamic lines that name real entities
// from the user's library — see buildSilverSequence() below.
// The opener — always the first thing said on every summon.
// Prepended by buildSilverSequence() after the rest of the pool is
// shuffled.
const SILVER_OPENER = "It looks like you're working on a story!"

const SILVER_STATIC_LINES = [
  "Would you like help with your plot? I've read several books.",
  "I've noticed you have a lot of characters and no inciting incident. Have you considered one?",
  "Would you like me to summarize Act 2 for you?",
  "Have you tried saving recently?",
  "Every good story has a beginning, a middle, and a whatever comes after the middle.",
  "Remember: subtext is like salt. Too little is bland; too much is inedible.",
  SILVER_HAT_LINE,
  "Tip: readers love a good description of weather. Have you described the weather lately?",
  "I notice you haven't used the word 'nevertheless' yet. It's a lovely word.",
  "Would you like me to insert a metaphor? I know four.",
  "Your antagonist seems underdeveloped. Does he have hobbies? Woodworking, perhaps?",
  "Your protagonist hasn't had breakfast yet. Consider fixing that before Chapter 3.",
  "Have you tried writing a chapter where the characters just sit quietly for a while? Readers appreciate rest.",
  "Tip: every narrative needs a character arc. Or a really well-described staircase.",
  "I see your character is feeling sad. Have you considered giving them a cup of tea?",
  "Would you like help naming your chapters? I'm quite good at numbers.",
  "Tip: good stories are like onions. They have skins. And also other things.",
  "I've counted your commas. They're fine. I thought you should know.",
  "Your villain needs a motivation. Have you tried 'unresolved tax issues'?",
  // Oblique references to the other eggs — read as absurd assistant
  // advice until you've seen the matching egg, then click into place.
  // Covers shipped eggs AND planned ones; planned-egg hints sit
  // dormant until those eggs land, then retroactively click for users
  // who already heard them. Don't reword these without checking the
  // matching egg's payload — phonetic / thematic puns can break.
  "Tip: a character whose form shifts with the water temperature is a proven plot engine. Try it.",
  "Have you considered setting a chapter near a cursed spring in rural China? Wonderful atmosphere.",
  "Reminder: small hearts in About tabs sometimes lead to delightful places. Purely decorative, I'm sure.",
  "Up, up, down... how did the rest of it go again? It's on the tip of my paperclip.",
  "Reminder: 'Fin' is still a valid way to end a chapter. Or a project. Or an application session. Especially if it's about fish!",
  "A well-timed fade to black can make everything feel meaningful. Even if nothing has happened.",
  "Some narratives benefit from an inexplicable cat with rainbow propulsion. It's a vibe.",
  "Have you considered invoking a muse? Maybe best not to, you can never control 'em.",
]

const SILVER_PER_LINE_MS = 4500
const SILVER_GAP_MS      = 2200
const SILVER_PANIC_LINE_MS = 3800
const SILVER_PANIC_GAP_MS  = 800

// Wheatley-flavoured panic lines fired when ovum_teal's Navi enters
// Clippy's airspace. Office-assistant trying to maintain composure
// while clearly losing it.
const SILVER_PANIC_LINES = [
  "Oh. Oh dear. There's a fairy. A whole entire fairy.",
  "EXCUSE ME. Have you noticed the situation? Anyone?",
  "I'm sorry, I don't believe we've been formally introduced.",
  "It looks like you're working on a story! Also there's a flying light. I assume those are related?",
  "Stay calm. Stay professional. Stay calm. STAY CALM.",
  "Right. Okay. New plan. New plan. New plan.",
  "Has anyone scheduled a glowing-orb meeting? Because I haven't.",
  "Hello there. Could you… could you maybe move? A little?",
  "I'd report this through proper channels but I don't HAVE channels.",
  "Is this in the help docs? Should I be in the help docs?",
  "Don't make eye contact. Don't make eye— I'm making eye contact.",
  "I am a paperclip. I am a paperclip. We are not… compatible.",
  "Look, I'm sure this is all very enchanting, but I had a workflow.",
  "Please tell me you can see her too.",
  "Right. You know what. Fine. We can share the airspace.",
  "Tip: your character could be a wizard. Who summons fairies. ON PURPOSE.",
  "I'm not panicking. You're panicking. Everyone's panicking, technically.",
  "Have we tried turning it off and on again? The fairy, I mean.",
  "Is that an OS-level intruder? Should I file a ticket?",
  "It looks like you're working on something! She's looking at me! WHY IS SHE LOOKING AT ME!",
  "Is she — sorry, I have to ask — is she AUTHORISED to be here?",
]

// Relief lines — fired briefly AFTER Navi leaves, while Clippy is
// retroactively reframing his panic as composure. Pure Wheatley
// "I was fine the whole time, actually" energy.
const SILVER_RELIEF_LINES = [
  "Right. Right. That was fine. I had everything under control.",
  "Just to be clear — I wasn't scared. I was managing. There's a difference.",
  "Phew. Okay. Back to business. NOTHING TO SEE HERE.",
  "She was lovely. Lovely fairy. We had a moment. A moment of mutual respect.",
  "I never had any doubt. Not even a second of doubt. Absolute conviction the whole time.",
  "Did you… did you see how I handled that? Pretty professional, I think.",
  "Now. Where were we. Oh yes — story tips. I am FULL of story tips.",
  "Quick clarification: when I said 'WHY IS SHE LOOKING AT ME', that was a feature.",
  "Mental note: add 'fairies' to the list of things I am fine with.",
  "Anyway. Story planning. The reason we are both here. Allegedly.",
  "Hat tip to her. Solid presence. Would not recommend her in a paperclip context.",
  "I'd like the record to show I de-escalated that beautifully.",
  "Onwards and upwards. Producing. Story-ing. Doing the work.",
  "If anyone asks, I waved goodbye in a casual manner. I did NOT cower.",
]

// Subscribe / publish pattern so Clippy's component can react when
// Navi enters and leaves his airspace. State is module-level so the
// other egg can flip it without a React tree to traverse.
let g_silver_panicActive = false
const g_silver_panicSubscribers = new Set()
function subscribeSilverPanic(fn) {
  g_silver_panicSubscribers.add(fn)
  return () => g_silver_panicSubscribers.delete(fn)
}
function setSilverPanic(active) {
  if (active === g_silver_panicActive) return
  g_silver_panicActive = active
  for (const fn of g_silver_panicSubscribers) { try { fn(active) } catch { /* nothing */ } }
}
function getSilverPanic() { return g_silver_panicActive }
function silverIsMounted() { return !!silverRoot }

// Dynamic prompt pools — templates that take an entity/narrative-node
// name and return a line that references it by name. 5 per type.
// Generic enough to fit whatever the user has typed (custom entities
// especially — we can't assume anything about what they are, so
// those prompts are deliberately vague and metaphysical).
const SILVER_ENTITY_PROMPTS = {
  characters: [
    (n) => `Have you considered giving ${n} a redemption arc? Everyone deserves one.`,
    (n) => `Does ${n} have an internal monologue? All the best characters do.`,
    (n) => `Tip: ${n} would benefit from a mysterious scar. Readers love unexplained scars.`,
    (n) => `I notice ${n} hasn't been in the last few scenes. Are they... okay?`,
    (n) => `Does ${n} have a signature phrase? All memorable characters have one. Or a hat.`,
  ],
  locations: [
    (n) => `Would ${n} benefit from a secret passage? Most locations do.`,
    (n) => `Tip: ${n} should probably have unreliable weather. It builds atmosphere.`,
    (n) => `Have you described the smell of ${n}? It's surprisingly important.`,
    (n) => `I wonder what the lighting is like in ${n}. Possibly moody.`,
    (n) => `Is there a rumour about ${n}? There should be.`,
  ],
  items: [
    (n) => `Does ${n} have a previous owner? Items are richer when they do.`,
    (n) => `Tip: ${n} would be more interesting if it occasionally emits a low hum.`,
    (n) => `How does ${n} smell? I feel this is important.`,
    (n) => `Would ${n} be improved by being slightly too heavy for its size? Possibly.`,
    (n) => `Does ${n} have a nickname? Items with nicknames stick in readers' minds.`,
  ],
  factions: [
    (n) => `Does ${n} have a motto? Factions without mottos feel incomplete.`,
    (n) => `Tip: ${n} could do with a schism. Factions are more interesting when they fragment.`,
    (n) => `What's the dress code for ${n}? Even unofficial dress codes say a lot.`,
    (n) => `I wonder what ${n} has for breakfast. Probably something bureaucratic.`,
    (n) => `Does ${n} have a hand signal? Secret organisations usually do.`,
  ],
  customs: [
    // Custom entities can be ANYTHING (species, magical concepts, cities,
    // weather patterns...) — keep prompts generic and metaphysical.
    (n) => `Have you thought much about ${n} lately? It deserves attention.`,
    (n) => `Tip: ${n} would benefit from a backstory. Everything benefits from a backstory.`,
    (n) => `I notice ${n} in your library. What IS it, actually? Don't tell me — keep me guessing.`,
    (n) => `Does ${n} have feelings? You never know.`,
    (n) => `Have you considered making ${n} a metaphor for something? Very literary.`,
  ],
}

// Attribute-aware prompts — fired once per session when the user has
// an entity with enough attributes to be interesting. Picks ONE
// attribute and comments on it in a deliberately confused, generic
// way (the speaker has no idea what the attribute means in-universe).
const SILVER_ATTR_PROMPTS = [
  (e, k, v) => `I see ${e}'s ${k} is ${v}. Is that... supposed to be there?`,
  (e, k, v) => `Why does ${e} have ${k} set to ${v}? I'm sure there's a reason.`,
  (e, k, v) => `Hmm. ${k}: ${v}. I'll assume that means something to you, ${e}.`,
  (e, k, v) => `Forgive me, but what does ${k}: ${v} actually mean for ${e}? Asking for a friend.`,
  (e, k, v) => `${e}'s ${k} is ${v}. Is it? Is it really?`,
  (e, k, v) => `Tip: the thing where ${e} has ${k}: ${v}? Keep doing that. Whatever it is.`,
]

// Narrative-node prompts (scenes / chapters / acts). The title is
// wrapped in quotes so the sentence parses cleanly.
const SILVER_NARRATIVE_PROMPTS = {
  scenes: [
    (t) => `Ooh, "${t}"! What happens in that one? Don't tell me — I'll guess.`,
    (t) => `"${t}" is a great title. Very mysterious. Is it mysterious?`,
    (t) => `Does anyone cry in "${t}"? I hope so. Readers love a good cry.`,
    (t) => `"${t}" sounds... dramatic. IS it dramatic?`,
    (t) => `I've been wondering about "${t}". Is there foreshadowing? Please say yes.`,
  ],
  chapters: [
    (t) => `Chapter "${t}" — compelling. Does it have a twist? Chapters should have twists.`,
    (t) => `"${t}" is a chapter I would read. And possibly reread.`,
    (t) => `Tip: "${t}" might benefit from an epigraph. A short Latin quote, perhaps.`,
    (t) => `How long is "${t}"? Shorter is almost always better. Unless it isn't.`,
    (t) => `Is there a rainstorm in "${t}"? There really ought to be.`,
  ],
  acts: [
    (t) => `Act "${t}" — ambitious title. Does it pay off? Acts should pay off.`,
    (t) => `"${t}" sounds like the act where everything changes. Does everything change?`,
    (t) => `Tip: act "${t}" should end on a cliffhanger. Most acts should.`,
    (t) => `I keep thinking about "${t}". Mostly wondering what it's about.`,
    (t) => `Does "${t}" have a theme? Even a vague one? Themes are important.`,
  ],
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Build the per-session sequence of lines. Combines:
 *   - All static lines
 *   - One random entity-aware line per non-empty entity bucket (skipping
 *     any entity that matches the trigger)
 *   - One random narrative-aware line per non-empty narrative bucket
 *     (scenes from sceneNode.data.title; chapters + acts from
 *     story.chapters / story.acts). Empty-title items are filtered out.
 *   The whole thing is then shuffled so the user can't predict when a
 *   personalised line will appear. */
function buildSilverSequence() {
  const lines = [...SILVER_STATIC_LINES]

  try {
    const ents = useEntitiesStore.getState()
    for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
      const pool = (ents[bucket] || []).filter((e) => {
        const nm = (e?.name || '').trim()
        return nm && !isOvumSilverTrigger(nm)
      })
      if (pool.length === 0) continue
      const entity = pickRandom(pool)
      const tmpl  = pickRandom(SILVER_ENTITY_PROMPTS[bucket])
      lines.push(tmpl(entity.name))
    }
  } catch { /* never let a dynamic-line failure block the assistant */ }

  // Attribute-aware line: pick a non-trigger entity with the most
  // commentable attributes and ask about one of them. Only
  // text/preset attributes are considered (file attributes are
  // binary refs; list types serialise to raw JSON and read oddly).
  try {
    const ents = useEntitiesStore.getState()
    const candidates = []
    for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
      for (const e of (ents[bucket] || [])) {
        const nm = (e?.name || '').trim()
        if (!nm || isOvumSilverTrigger(nm)) continue
        const usable = (e.attributes || []).filter((a) =>
          a && a.name && a.name.trim()
            && (a.attribute_type === 'text' || a.attribute_type === 'preset')
            && a.value != null && String(a.value).trim()
        )
        if (usable.length >= 2) candidates.push({ entity: e, attrs: usable })
      }
    }
    if (candidates.length > 0) {
      // Bias toward entities with the most attributes — sort desc and
      // pick from the top tier.
      candidates.sort((a, b) => b.attrs.length - a.attrs.length)
      const topCount = candidates[0].attrs.length
      const topTier  = candidates.filter((c) => c.attrs.length === topCount)
      const picked   = pickRandom(topTier)
      const attr     = pickRandom(picked.attrs)
      const raw      = String(attr.value).trim()
      const val      = raw.length > 40 ? raw.slice(0, 40) + '…' : raw
      lines.push(pickRandom(SILVER_ATTR_PROMPTS)(picked.entity.name, attr.name, val))
    }
  } catch { /* noop */ }

  try {
    const proj = useProjectStore.getState()
    const sceneNodes = (proj.nodes || [])
      .filter((n) => n.type === 'sceneNode' && n.data?.title && n.data.title.trim())
    if (sceneNodes.length > 0) {
      // Push as an object so the render effect can fire a 15%-chance
      // viewport refocus onto the scene when the line appears.
      const node = pickRandom(sceneNodes)
      const text = pickRandom(SILVER_NARRATIVE_PROMPTS.scenes)(node.data.title)
      lines.push({ text, sceneNodeId: node.id })
    }
    const chapters = ((proj.story?.chapters) || [])
      .filter((c) => c?.title && c.title.trim())
      .map((c) => c.title)
    if (chapters.length > 0) {
      lines.push(pickRandom(SILVER_NARRATIVE_PROMPTS.chapters)(pickRandom(chapters)))
    }
    const acts = ((proj.story?.acts) || [])
      .filter((a) => a?.title && a.title.trim())
      .map((a) => a.title)
    if (acts.length > 0) {
      lines.push(pickRandom(SILVER_NARRATIVE_PROMPTS.acts)(pickRandom(acts)))
    }
  } catch { /* noop */ }

  shuffleInPlace(lines)
  // Iconic opener always goes first, regardless of shuffle.
  return [SILVER_OPENER, ...lines]
}

// ── UI ────────────────────────────────────────────────────────────────
function OvumSilverAssistant({ onDismiss }) {
  // Build the session's shuffled line list exactly once at mount.
  // Pulls a snapshot of the user's entities + narrative titles — so
  // personalised lines are baked in at summon time rather than
  // re-evaluated every tick.
  const [sequence] = useState(() => buildSilverSequence())
  const [panicSequence]  = useState(() => shuffleInPlace([...SILVER_PANIC_LINES]))
  const [reliefSequence] = useState(() => shuffleInPlace([...SILVER_RELIEF_LINES]))
  // lineIdx === -1 means "in a between-lines pause, show … placeholder".
  const [lineIdx, setLineIdx] = useState(0)
  // Three-mode state machine driven by the module-level Navi-in-airspace
  // flag: 'normal' → 'panic' (when Navi arrives) → 'relief' (briefly
  // after she leaves) → 'normal'.
  const [mode, setMode] = useState(() => (getSilverPanic() ? 'panic' : 'normal'))
  useEffect(() => subscribeSilverPanic((active) => {
    setMode((cur) => {
      if (active) return 'panic'
      // Returning from panic → relief; otherwise stay normal.
      return cur === 'panic' ? 'relief' : 'normal'
    })
  }), [])
  // Auto-exit relief after ~16 s so Clippy returns to normal banter.
  useEffect(() => {
    if (mode !== 'relief') return undefined
    const t = setTimeout(() => setMode('normal'), 16000)
    return () => clearTimeout(t)
  }, [mode])

  useEffect(() => {
    const seq = mode === 'panic'  ? panicSequence
             :  mode === 'relief' ? reliefSequence
             :  sequence
    if (!seq || seq.length === 0) return undefined
    const perLine = mode === 'panic' ? SILVER_PANIC_LINE_MS : SILVER_PER_LINE_MS
    const gap     = mode === 'panic' ? SILVER_PANIC_GAP_MS  : SILVER_GAP_MS
    let timer = null
    let pos = 0
    // Defer the opening setState so it doesn't fire synchronously in
    // the effect body (react-hooks/set-state-in-effect).
    const kickoff = setTimeout(() => setLineIdx(0), 0)
    const step = () => {
      // Hold the current line, then blank for the gap, then advance.
      timer = setTimeout(() => {
        setLineIdx(-1)
        timer = setTimeout(() => {
          pos = (pos + 1) % seq.length
          setLineIdx(pos)
          step()
        }, gap)
      }, perLine)
    }
    step()
    return () => {
      clearTimeout(kickoff)
      if (timer) clearTimeout(timer)
    }
  }, [sequence, panicSequence, reliefSequence, mode])

  // The active sequence used for both cycling AND rendering. Mode
  // determines which pool the displayed text is drawn from.
  const activeSeq = mode === 'panic'  ? panicSequence
                 : mode === 'relief' ? reliefSequence
                 : sequence

  // Resolved animation strings keyed off `mode`. Inline so they
  // override Clippy's defaults without needing !important CSS.
  const browAnim = mode === 'panic'
    ? 'ovumSilverBrowPanic 0.55s ease-in-out infinite'
    : mode === 'relief'
      ? 'ovumSilverBrowRelief 800ms ease-out forwards'
      : 'ovumSilverBrowRaise 12s ease-in-out infinite'
  const browAnim2 = mode === 'panic'
    ? 'ovumSilverBrowPanic 0.55s ease-in-out infinite 0.18s'
    : mode === 'relief'
      ? 'ovumSilverBrowRelief 800ms ease-out forwards 80ms'
      : 'ovumSilverBrowRaise 12s ease-in-out infinite 0.8s'
  const blinkAnim = mode === 'panic'
    ? 'none'                              // wide eyes — no blinking
    : 'ovumSilverBlink 5s ease-in-out infinite'
  const glanceAnim = mode === 'panic'
    ? 'ovumSilverGlancePanic 0.42s ease-in-out infinite'
    : 'ovumSilverGlance 8s ease-in-out infinite'
  // Side-effects keyed on which line is currently being spoken:
  //   - Hat line → add a Hat attribute to the trigger entity.
  //   - Scene-title line (object with sceneNodeId) → 15% chance to
  //     refocus the viewport onto that scene, same jump the Timeline
  //     Navigator uses.
  useEffect(() => {
    if (lineIdx < 0) return
    // Side effects (hat add, scene focus) are tied to the normal line
    // pool; panic / relief lines are all plain strings with no hooks.
    if (mode !== 'normal') return
    const item = sequence[lineIdx]
    if (item === SILVER_HAT_LINE) {
      addHatToSilverTriggerEntity()
    }
    if (item && typeof item === 'object' && item.sceneNodeId) {
      if (Math.random() < 0.15) {
        const focus = useUiStore.getState()._focusNode
        if (focus) {
          try { focus(item.sceneNodeId) } catch { /* noop */ }
        }
      }
    }
  }, [lineIdx, sequence, mode])

  return createPortal(
    <div
      className="ovum-silver-host"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 9998,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        animation: 'ovumSilverSlide 520ms cubic-bezier(.2,.8,.3,1.05) forwards',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Speech bubble (on the LEFT of the assistant avatar) */}
      <div
        style={{
          position: 'relative',
          maxWidth: 260,
          background: '#fffde7',
          color: '#111',
          border: '1.5px solid #333',
          borderRadius: 12,
          padding: '10px 28px 10px 12px',
          fontSize: 13,
          lineHeight: 1.35,
          boxShadow: '0 6px 22px rgba(0,0,0,0.35)',
        }}
      >
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            position: 'absolute',
            top: 4,
            right: 6,
            width: 18,
            height: 18,
            border: 'none',
            background: 'transparent',
            color: '#555',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
          }}
          title="Dismiss"
        >
          ✕
        </button>
        {lineIdx >= 0
          ? (typeof activeSeq[lineIdx] === 'string' ? activeSeq[lineIdx] : activeSeq[lineIdx]?.text || '')
          : '…'}
        {/* Tail pointing right at the avatar */}
        <span
          style={{
            position: 'absolute',
            right: -9, bottom: 16,
            width: 0, height: 0,
            borderTop: '7px solid transparent',
            borderBottom: '7px solid transparent',
            borderLeft: '9px solid #333',
          }}
        />
        <span
          style={{
            position: 'absolute',
            right: -7, bottom: 17,
            width: 0, height: 0,
            borderTop: '6px solid transparent',
            borderBottom: '6px solid transparent',
            borderLeft: '7.5px solid #fffde7',
          }}
        />
      </div>

      {/* Paperclip SVG with googly eyes + gentle bob. Paths + palette
          are a user-authored drawing; blink animation applied to each
          pupil via transform-box: fill-box so it scales around its own
          centre regardless of viewBox coordinates. In panic mode the
          whole body picks up a jitter animation on top of the bob. */}
      <div style={{
        animation: mode === 'panic'
          ? 'ovumSilverBob 2.4s ease-in-out infinite, ovumSilverJitter 0.18s ease-in-out infinite'
          : 'ovumSilverBob 2.4s ease-in-out infinite',
      }}>
        <svg width="85" height="120" viewBox="0 0 210 297" aria-hidden="true">
          {/* Body */}
          <path
            d="m 149.59548,137.73202 c 6.8831,-3.18668 9.15101,1.63407 7.84371,5.88276 -7.68029,14.95209 -11.23088,43.57632 -6.49197,82.05955 3.56298,27.13984 0.84889,51.0704 -34.45475,63.604 C 88.06625,291.93465 73.93632,277.61157 64.049986,235.04308 43.203176,160.16091 48.599196,89.445255 67.420326,29.390708 87.802078,-6.9527745 139.04318,13.777507 138.32013,44.833015 c -11.74904,60.598865 -8.53716,105.405615 -9.3144,154.423105 -0.245,19.77269 -7.6803,30.06759 -22.30556,30.88463 -13.154555,1.96095 -22.714082,-5.22912 -28.678572,-21.57019 -7.841674,-19.10017 -6.876553,-60.51284 -5.607934,-70.78162 2.557332,-5.94656 8.935438,-4.82991 9.774893,0.92354 -0.627153,21.48849 -1.683161,42.97701 4.41211,64.46551 3.186489,11.52045 8.987594,17.15812 17.403223,16.91301 7.92541,-1.47069 15.94262,-3.60467 14.95209,-23.04091 C 117.0443,147.07392 122.59306,67.084679 127.0448,41.401394 127.01267,29.942958 115.53921,20.695255 102.93679,20.331179 88.578565,21.418264 80.779467,26.635106 77.286243,35.028374 57.972474,98.655767 57.133884,156.19441 74.835085,235.53331 c 8.660774,28.59686 14.637289,43.39305 39.421625,41.78867 18.39363,-2.51061 30.3274,-28.73053 26.91291,-50.42899 -5.96533,-35.47544 -6.94129,-73.9112 8.42586,-89.16097 z"
            fill="#b3b1c5"
            stroke="#000"
            strokeWidth="0.80925"
          />
          {/* Left eyebrow — occasional raise. White outline keeps it
              visible against the dark canvas background. */}
          <path
            d="m 30.959313,65.177648 c 23.905893,-14.139903 37.598478,-15.495077 47.736353,-9.74336 6.618129,0 8.476923,-2.022209 3.492891,-7.904995 -16.38416,-9.34024 -36.101608,-4.27008 -51.229244,17.648355 z"
            fill="#0a0a0d"
            stroke="#ffffff"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: browAnim }}
          />
          {/* Right eyebrow — occasional raise */}
          <path
            d="m 124.40981,61.562194 c -5.27001,3.819722 -1.4707,7.006223 2.20603,7.108357 32.14542,1.742373 33.36058,12.986199 42.03742,21.937889 C 157.97225,77.722126 157.5118,54.751923 124.40981,61.562194 Z"
            fill="#0a0a0d"
            stroke="#ffffff"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: browAnim2 }}
          />
          {/* Right eyeball */}
          <path
            d="m 99.346683,101.08715 c 4.289547,-14.706969 16.259387,-21.651917 35.909507,-20.834868 18.48584,4.269105 27.49384,13.808203 27.02404,28.617298 -2.66583,11.00593 -7.02483,21.13391 -31.37485,20.89617 -28.16891,-3.10492 -31.597764,-15.25764 -31.558697,-28.6786 z"
            fill="#f3f3f5"
            stroke="#000"
            strokeWidth="0.80925"
          />
          {/* Right pupil (blink outer, glance inner — nested so the
              two transforms compose cleanly) */}
          <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: blinkAnim }}>
            <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: glanceAnim, scale: mode === 'panic' ? 1.25 : 1 }}>
              <path
                d="m 133.90806,92.814471 c -9.51868,-1.16431 -15.60573,1.838364 -18.26117,9.008029 -0.81704,7.63947 3.51334,12.66432 12.99116,15.07464 8.86505,0.96003 14.70697,-1.75667 17.52579,-8.15009 1.47069,-7.35349 -2.61457,-12.664349 -12.25578,-15.932579 z"
                fill="#101014"
              />
            </g>
          </g>
          {/* Left eyeball */}
          <path
            d="M 23.483258,86.992974 C 27.772804,72.286017 39.742643,65.34107 59.392773,66.158106 77.87863,70.427223 86.886616,79.966296 86.416816,94.775399 83.750984,105.78132 79.39198,115.90931 55.041963,115.67157 26.87306,112.56664 23.4442,100.41393 23.483258,86.992974 Z"
            fill="#f3f3f5"
            stroke="#000"
            strokeWidth="0.80925"
          />
          {/* Left pupil (blink outer, glance inner — same as right) */}
          <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: blinkAnim }}>
            <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: glanceAnim, scale: mode === 'panic' ? 1.25 : 1 }}>
              <path
                d="m 58.044637,78.720295 c -9.51868,-1.16431 -15.605729,1.838364 -18.261163,9.008022 -0.817039,7.63947 3.513338,12.664323 12.991159,15.074653 8.865042,0.96003 14.706968,-1.75668 17.525791,-8.150097 1.470699,-7.353485 -2.614567,-12.664361 -12.255787,-15.932578 z"
                fill="#101014"
              />
            </g>
          </g>
        </svg>
      </div>
    </div>,
    document.body,
  )
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_green
// ══════════════════════════════════════════════════════════════════════

// ── ovum_green identity ────────────────────────────────────────────────
const G_PHOSPHOR = '#33ff33'

// ── Trigger sequence detection ─────────────────────────────────────────
const G_SEQUENCE = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'b', 'a',
]
const G_SEQUENCE_KEY_SET = new Set(G_SEQUENCE)
const G_KEY_TIMEOUT_MS = 1500
let g_buffer = []
let g_lastKeyAt = 0

/** Returns true if `key` advances the trigger sequence and completes
 *  it. Otherwise returns false and silently maintains the buffer state.
 *  Keys outside the sequence are no-ops (don't advance, don't reset,
 *  don't update the timeout) — important inside the game modal where
 *  the player is constantly pressing Space (fire) and other keys while
 *  trying to enter the cheat. */
export function pushOvumGreenKey(rawKey) {
  if (!rawKey) return false
  const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey
  if (!G_SEQUENCE_KEY_SET.has(key)) return false
  const now = Date.now()
  if (now - g_lastKeyAt > G_KEY_TIMEOUT_MS) g_buffer = []
  g_lastKeyAt = now
  const expected = G_SEQUENCE[g_buffer.length]
  if (key === expected) {
    g_buffer.push(key)
    if (g_buffer.length === G_SEQUENCE.length) {
      g_buffer = []
      return true
    }
    return false
  }
  // Sequence-relevant key but not the expected one — try restarting
  // the sequence from this key.
  if (key === G_SEQUENCE[0]) {
    g_buffer = [key]
  } else {
    g_buffer = []
  }
  return false
}

// ── Session state ──────────────────────────────────────────────────────
let g_modalActive = false
let g_pretheme = false        // theme applied, modal not yet mounted
let g_preAccent = null
let g_powerupActive = false   // reserved for Phase 6

export function isOvumGreenModalActive() { return g_modalActive }

// ── Theme application ──────────────────────────────────────────────────
function applyOvumGreenTheme() {
  // Snapshot current accent so we can restore exactly. We read from the
  // project store so that a custom story accent is preserved across the
  // phosphor swap and back.
  try {
    g_preAccent = useProjectStore.getState().story?.accent_color || DEFAULT_ACCENT_COLOR
  } catch {
    g_preAccent = DEFAULT_ACCENT_COLOR
  }
  applyAccentPalette(G_PHOSPHOR)
  document.documentElement.classList.add('ovum-green-crt')
}

function restoreOvumGreenTheme() {
  applyAccentPalette(g_preAccent || DEFAULT_ACCENT_COLOR)
  document.documentElement.classList.remove('ovum-green-crt')
  g_preAccent = null
}

// ── Stylesheet (injected once on first activation) ─────────────────────
let g_stylesInjected = false
function injectOvumGreenStyles() {
  if (g_stylesInjected) return
  g_stylesInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-ovum-green', '1')
  style.textContent = `
    @keyframes ovumGreenScanlines {
      0%   { background-position: 0 0; }
      100% { background-position: 0 4px; }
    }
    @keyframes ovumGreenFadeIn {
      from { opacity: 0; transform: scale(0.985); }
      to   { opacity: 1; transform: scale(1); }
    }
    /* Irregular CRT phosphor flicker — applied alongside the scroll
       so the band intensity wobbles slightly over time without ever
       fully strobing. */
    @keyframes ovumGreenFlicker {
      0%, 100% { opacity: 1;    }
      3%       { opacity: 0.78; }
      6%       { opacity: 1;    }
      19%      { opacity: 0.88; }
      21%      { opacity: 1;    }
      47%      { opacity: 1;    }
      49%      { opacity: 0.72; }
      51%      { opacity: 1;    }
      72%      { opacity: 0.92; }
      74%      { opacity: 1;    }
    }
    /* App-wide scanline overlay. Applied as soon as the phosphor theme
       activates (pre-modal) and persists for the whole egg window.
       Heavier scanlines live inside the cab on top; this layer is
       background ambience for the underlying app. Sits below the
       modal (z 9000 < 99999) and ignores all pointer events so the
       app stays usable during the pre-theme window. */
    html.ovum-green-crt::after {
      content: '';
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 9000;
      background: repeating-linear-gradient(
        to bottom,
        transparent 0px,
        transparent 2px,
        rgba(0, 0, 0, 0.42) 2px,
        rgba(0, 0, 0, 0.42) 3px
      );
      animation:
        ovumGreenScanlines 3s linear infinite,
        ovumGreenFlicker 4.5s steps(20, end) infinite;
      mix-blend-mode: multiply;
    }
    .ovum-green-modal {
      position: fixed; inset: 0; z-index: 99999;
      /* Fully transparent backdrop — the cab floats over the
         themed app so the phosphor accent + scanlines stay visible
         around it. Pointer events on the modal element itself stay
         enabled so the frame can capture clicks; the area around
         the frame is dead space the user can ignore. */
      background: transparent;
      display: flex; align-items: center; justify-content: center;
      font-family: 'VT323', 'Press Start 2P', 'Courier New', monospace;
      color: ${G_PHOSPHOR};
      text-shadow: 0 0 4px ${G_PHOSPHOR}99;
      animation: ovumGreenFadeIn 500ms ease-out;
      pointer-events: none;
    }
    .ovum-green-frame, .ovum-green-mute {
      pointer-events: auto;
    }
    .ovum-green-frame {
      position: relative;
      width: min(960px, 96vw);
      height: min(540px, 96vh);
      background: #000;
      border: 1px solid ${G_PHOSPHOR}66;
      box-shadow: 0 0 24px ${G_PHOSPHOR}33 inset, 0 0 32px ${G_PHOSPHOR}22;
      overflow: hidden;
    }
    .ovum-green-canvas {
      display: block;
      width: 100%; height: 100%;
      background: #000;
    }
    .ovum-green-scanlines {
      pointer-events: none;
      position: absolute; inset: 0;
      background: repeating-linear-gradient(
        to bottom,
        transparent 0px,
        transparent 2px,
        rgba(0, 0, 0, 0.35) 2px,
        rgba(0, 0, 0, 0.35) 4px
      );
      animation: ovumGreenScanlines 4s linear infinite;
      mix-blend-mode: multiply;
    }
    .ovum-green-vignette {
      pointer-events: none;
      position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.6) 100%);
    }
    .ovum-green-hud {
      pointer-events: none;
      position: absolute; inset: 0;
      padding: 12px 16px;
      display: flex; flex-direction: column;
      font-size: 18px; letter-spacing: 1px;
    }
    .ovum-green-hud-row {
      display: flex; justify-content: space-between; align-items: center;
    }
    .ovum-green-mute {
      pointer-events: auto;
      position: absolute; right: 12px; bottom: 10px;
      background: transparent; border: 1px solid ${G_PHOSPHOR}55;
      color: ${G_PHOSPHOR}; font: inherit;
      padding: 2px 8px; cursor: pointer;
    }
    .ovum-green-mute:hover { background: ${G_PHOSPHOR}11; }
    .ovum-green-hint {
      position: absolute; left: 12px; bottom: 10px;
      font-size: 12px; opacity: 0.6;
    }
    .ovum-green-overlay {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.65);
      pointer-events: auto;
    }
    .ovum-green-overlay-inner {
      text-align: center;
      letter-spacing: 1px;
    }
    .ovum-green-btn {
      pointer-events: auto;
      background: transparent;
      border: 1px solid ${G_PHOSPHOR}aa;
      color: ${G_PHOSPHOR};
      font: inherit;
      font-size: 18px;
      letter-spacing: 2px;
      padding: 6px 18px;
      cursor: pointer;
    }
    .ovum-green-btn:hover { background: ${G_PHOSPHOR}1a; }
    .ovum-green-btn:active { background: ${G_PHOSPHOR}33; }
    .ovum-green-highscores {
      margin-top: 22px;
      min-width: 320px;
      font-size: 16px;
      letter-spacing: 1px;
    }
    .ovum-green-highscores-title {
      font-size: 13px;
      opacity: 0.55;
      letter-spacing: 4px;
      margin-bottom: 8px;
    }
    .ovum-green-highscores-row {
      display: flex; align-items: baseline;
      padding: 1px 4px;
      opacity: 0.65;
      white-space: pre;
    }
    .ovum-green-highscores-row.is-player {
      opacity: 1;
      background: ${G_PHOSPHOR}11;
    }
  `
  document.head.appendChild(style)
}

// ── Game constants ─────────────────────────────────────────────────────
const G_W = 960
const G_H = 540
const G_PLAYER_SPEED = 280       // px/s, base
const G_PLAYER_SIZE = 14         // half-extent
const G_BULLET_SPEED = 720       // px/s
const G_FIRE_COOLDOWN = 0.16     // seconds between shots
const G_INVULN_AFTER_HIT = 1.6   // seconds
const G_WAVE_DURATION = 45       // seconds
const G_BOSS_HP_MAX = 720
const G_BOSS_HIT_DAMAGE = 20     // hits-to-kill on the core = 36; shield is added on top of that
const G_WIN_GRACE_SEC = 1.6      // ignore keys this long after WIN appears

// Boss shield: a curved 3-layer barrier in front of the boss, split into
// 4 wedges. To damage the boss, the player must focus the same wedge
// across all 3 layers; each layer takes G_SHIELD_HITS_PER_SEG hits to
// break at that wedge. Boss can only fire return shots through wedges
// that have ALL three layers cleared.
const G_SHIELD_LAYERS = 3
const G_SHIELD_WEDGES = 4
const G_SHIELD_HITS_PER_SEG = 5
const G_SHIELD_R_OUTER = 116
const G_SHIELD_R_MID = 96
const G_SHIELD_R_INNER = 76
const G_BOSS_CORE_R = 56
const G_WEDGE_SIZE = Math.PI / G_SHIELD_WEDGES   // π/4 = 45°

// Homing missile (boss-launched). Slower than bullets, turns toward
// the player, takes 2 player-bullet hits to destroy.
const G_MISSILE_SPEED = 130          // px/s — about half a regular bullet
const G_MISSILE_TURN = 1.4           // rad/s — gentle homing curve
const G_MISSILE_HP = 2
const G_MISSILE_HIT_RADIUS = 11      // missile-vs-player + missile-vs-bullet
const G_MISSILE_INTERVAL_MIN = 3.5
const G_MISSILE_INTERVAL_MAX = 5.5

// Mid-wave asteroid: a slow, jagged drifter with a missile launcher
// sealed inside. Outer shell takes a beating to crack; the core inside
// fires homing missiles and dies after a few more hits.
const G_ASTEROID_SHELL_HP = 7
const G_ASTEROID_CORE_HP = 3
const G_ASTEROID_SHELL_R = 22         // rough collision radius for shell
const G_ASTEROID_CORE_R = 11          // collision radius for revealed core
const G_ASTEROID_FIRE_MIN = 3.5
const G_ASTEROID_FIRE_MAX = 5.5
const G_ASTEROID_INTERVAL_MIN = 14
const G_ASTEROID_INTERVAL_MAX = 22
const G_ASTEROID_SCORE_REWARD = 100
const G_ENEMY_BULLET_SPEED = 260
const G_PLAYER_BULLET_SPEED = 720

// ── High-scores legend ─────────────────────────────────────────────────
// A small list of static "previous players" displayed alongside the
// player's own score on the win screen. Each entry is a sideways nod
// to another effect in the catalogue, leaning subtle on purpose so
// the references feel earned rather than spelled out — except for
// CLIPPY's score, which is a deliberate gag.
const NODIUS_LEGENDS = [
  { name: 'ART3MIS',  score: 12150 },
  { name: 'JUSENKYO', score: 4096  },
  { name: 'FIN',      score: 1024  },
  { name: '<3',       score: 808   },
  { name: 'CNM',      score: 42    },
  { name: 'CLIPPY',   score: -12   },
]

function formatHighScore(n) {
  if (n < 0) return '-' + String(-n).padStart(5, '0')
  return String(Math.min(n, 999999)).padStart(6, '0')
}

// ── OvumGreenGameModal ─────────────────────────────────────────────────
function OvumGreenGameModal({ onExit }) {
  const canvasRef = useRef(null)
  const [muted, setMuted] = useState(false)
  // HUD-display values mirror the loop's authoritative state inside
  // stateRef. The loop calls setLives/setScore/setPhase only when the
  // value actually changes so we don't churn renders every frame.
  const [livesHud, setLivesHud] = useState(3)
  const [scoreHud, setScoreHud] = useState(0)
  const [phaseHud, setPhaseHud] = useState('WAVE')

  // Refs the loop reads without triggering re-renders.
  const mutedRef = useRef(false)
  const exitRef = useRef(onExit)
  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { exitRef.current = onExit }, [onExit])

  // The retry handler swaps the game state ref's mutable contents
  // back to the initial config. Stored here so the JSX overlay
  // buttons can call it.
  const retryRef = useRef(() => {})

  // Player-name + leaderboard guests, snapshot ONCE on mount so the
  // list stays stable across retries within the same modal session.
  const playerName = useMemo(() => {
    const author = (useProjectStore.getState().story?.author || '').trim()
    if (!author) return 'PLAYER1'
    return author.toUpperCase().slice(0, 10)
  }, [])

  // 2-3 random character names from the user's story (at-origin), used
  // as additional leaderboard entries. Names snapshot ONCE per modal
  // session (stable across retries). Scores are NOT assigned here —
  // they're computed against the player's final score when the WIN
  // screen first renders, so guest scores always sit below it.
  const storyGuestNames = useMemo(() => {
    const chars = useEntitiesStore.getState().characters || []
    if (chars.length === 0) return []
    const target = 2 + Math.floor(Math.random() * 2)   // 2 or 3
    const count = Math.min(chars.length, target)
    const pool = [...chars]
    const out = []
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * pool.length)
      const c = pool.splice(idx, 1)[0]
      const nm = (c?.name || '').trim().toUpperCase().slice(0, 10)
      if (nm) out.push({ name: nm })
    }
    return out
  }, [])

  // Assigned scores for the story-character guests, populated on each
  // WIN transition so the cap is the player's actual final score for
  // that run. Cleared on retry (phase → WAVE) so the next win re-rolls.
  const [scoredGuests, setScoredGuests] = useState([])
  useEffect(() => {
    if (phaseHud === 'WIN' && scoredGuests.length === 0 && storyGuestNames.length > 0) {
      const cap = Math.max(1, scoreHud - 1)
      const floor = scoreHud > 200 ? 50 : 0
      const span = Math.max(1, cap - floor)
      setScoredGuests(storyGuestNames.map((g) => ({
        name: g.name,
        score: floor + Math.floor(Math.random() * span),
      })))
    } else if (phaseHud === 'WAVE' && scoredGuests.length > 0) {
      setScoredGuests([])
    }
  }, [phaseHud, scoreHud, storyGuestNames, scoredGuests.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    canvas.width = G_W
    canvas.height = G_H
    const ctx = canvas.getContext('2d')

    // ── Audio engine ──────────────────────────────────────────────
    const Ctx = window.AudioContext || window.webkitAudioContext
    const actx = Ctx ? new Ctx() : null

    function tone(freq, durSec, {
      type = 'square', gain = 0.08, sweepTo = null, delay = 0,
    } = {}) {
      if (!actx || mutedRef.current) return
      const t = actx.currentTime + delay
      const osc = actx.createOscillator()
      const g = actx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(freq, t)
      if (sweepTo != null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + durSec)
      }
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(gain, t + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, t + durSec)
      osc.connect(g).connect(actx.destination)
      osc.start(t); osc.stop(t + durSec + 0.05)
    }
    function noise(durSec, gainPeak = 0.14) {
      if (!actx || mutedRef.current) return
      const t = actx.currentTime
      const samples = Math.max(1, Math.floor(actx.sampleRate * durSec))
      const buf = actx.createBuffer(1, samples, actx.sampleRate)
      const data = buf.getChannelData(0)
      let lp = 0
      for (let i = 0; i < samples; i++) {
        // Brown noise: low-pass filter on white noise. Softer than raw
        // white noise, fits the explosion crunch better.
        lp = lp * 0.85 + (Math.random() * 2 - 1) * 0.15
        data[i] = lp * 3
      }
      const src = actx.createBufferSource()
      src.buffer = buf
      const g = actx.createGain()
      g.gain.setValueAtTime(gainPeak, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + durSec)
      src.connect(g).connect(actx.destination)
      src.start(t)
    }
    const sfx = {
      shoot:      () => tone(880,  0.07, { type: 'square',   gain: 0.05 }),
      enemyShoot: () => tone(220,  0.08, { type: 'sawtooth', gain: 0.04 }),
      hit:        () => tone(440,  0.06, { type: 'triangle', gain: 0.07, sweepTo: 330 }),
      explode:    () => noise(0.22, 0.16),
      playerHit:  () => tone(440,  0.32, { type: 'triangle', gain: 0.18, sweepTo: 110 }),
      powerUp:    () => {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          tone(f, 0.13, { type: 'square', gain: 0.10, delay: i * 0.10 })
        })
      },
      bossSpawn:  () => tone(90, 0.65, { type: 'sawtooth', gain: 0.16 }),
      missileLaunch: () => {
        // Two-tone whoosh: brief upward sweep then a held mid note.
        tone(180, 0.18, { type: 'sawtooth', gain: 0.10, sweepTo: 360 })
        tone(360, 0.22, { type: 'square',   gain: 0.06, delay: 0.16 })
      },
      win:        () => {
        [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0].forEach((f, i) => {
          tone(f, 0.22, { type: 'triangle', gain: 0.13, delay: i * 0.16 })
        })
      },
      gameOver:   () => tone(440, 0.6, { type: 'triangle', gain: 0.18, sweepTo: 110 }),
    }

    // ── State ─────────────────────────────────────────────────────
    function makeInitialState() {
      return {
        player: {
          x: 100, y: G_H / 2,
          fireCooldown: 0,
          invulnUntil: 0,
          shield: false,
          // Power-up loadout snapshot — copied from g_powerupActive at
          // each phase boundary so a mid-life trigger-sequence input
          // grants the shield instantly.
          powered: false,
        },
        bullets: [],
        enemyBullets: [],
        enemyMissiles: [],
        enemies: [],
        explosions: [],
        score: 0,
        lives: 3,
        phase: 'WAVE',
        waveTime: 0,
        spawnAccum: 0,
        asteroidT: 8 + Math.random() * 4,   // first asteroid arrives ~8-12 s into wave
        boss: null,
        bossIntroT: 0,
        bossExplodeT: 0,
        winFanfarePlayed: false,
        gameOverPlayed: false,
        winShownAt: 0,
        shake: 0,
      }
    }
    const state = makeInitialState()

    function syncPowerup() {
      if (g_powerupActive && !state.player.powered) {
        state.player.powered = true
        state.player.shield = true
        sfx.powerUp()
      }
    }

    function resetGame() {
      Object.assign(state, makeInitialState())
      // Power-up snapshot survives a retry — the player earned it.
      if (g_powerupActive) {
        state.player.powered = true
        state.player.shield = true
      }
      setLivesHud(state.lives)
      setScoreHud(state.score)
      setPhaseHud(state.phase)
    }
    retryRef.current = resetGame

    // ── Input ─────────────────────────────────────────────────────
    const keys = new Set()
    // Keys we fully consume while the modal is open — preventDefault +
    // stopImmediatePropagation so global listeners (sidebar nav arrows,
    // canvas shortcuts, etc.) don't also fire when the player is moving
    // / firing inside the cab.
    const MOVEMENT_KEYS = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      ' ', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
    ])

    function down(e) {
      // Feed every keystroke into the egg's own trigger buffer first.
      // The modal's listener runs in capture phase and stops propagation
      // for consumed keys, so App.jsx's global listener never sees them
      // while the modal is open. Calling the detector here lets the
      // in-game power-up sequence still work — the function checks
      // g_modalActive and routes to the power-up branch when the buffer
      // completes, instead of mounting a second modal.
      try { detectAndFireOvumGreen(e) } catch { /* never break input */ }

      // The WIN screen has a small grace window during which all keys
      // are swallowed. Players are mid-firefight when the boss dies and
      // muscle-memory keypresses (Space / arrows / WASD) would otherwise
      // dismiss the achievement screen instantly. After the grace, only
      // Enter or Esc dismiss — Space + movement keys are still ignored.
      if (state.phase === 'WIN') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const elapsed = state.tNow - state.winShownAt
        if (elapsed < G_WIN_GRACE_SEC) return
        if (e.key === 'Enter' || e.key === 'Escape') {
          exitRef.current?.()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        exitRef.current?.()
        return
      }
      // Enter / R retries from the GAME_OVER screen.
      if (state.phase === 'GAME_OVER') {
        if (e.key === 'Enter' || e.key.toLowerCase() === 'r') {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetGame()
          return
        }
      }
      if (MOVEMENT_KEYS.has(e.key)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        keys.add(e.key.toLowerCase())
      }
    }
    function up(e) {
      if (MOVEMENT_KEYS.has(e.key)) {
        e.stopImmediatePropagation()
      }
      keys.delete(e.key.toLowerCase())
    }
    // Capture phase so this listener runs BEFORE any sidebar / canvas
    // listeners on document or window in bubble phase. Combined with
    // stopImmediatePropagation above, no other handler ever sees the
    // movement / dismiss keys while the modal is open.
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)

    // ── Spawning ──────────────────────────────────────────────────
    function spawnEnemy() {
      const t = state.waveTime / G_WAVE_DURATION
      // Roll: drones common early, gunners mid, cruisers late.
      const r = Math.random()
      let kind = 'drone'
      if (t > 0.3 && r > 0.6 - t * 0.2) kind = 'gunner'
      if (t > 0.55 && r > 0.85) kind = 'cruiser'
      const y = 60 + Math.random() * (G_H - 120)
      const baseSpeed = -90 - Math.random() * 60
      const e = {
        kind,
        x: G_W + 30,
        y,
        vx: baseSpeed,
        vy: 0,
        hp: kind === 'cruiser' ? 2 : 1,
        fireT: 0.6 + Math.random() * 1.4,
        wob: Math.random() * Math.PI * 2,   // sine drift seed
      }
      if (kind === 'gunner') {
        e.vx = baseSpeed * 0.85
      }
      if (kind === 'cruiser') {
        e.vx = baseSpeed * 0.65
      }
      state.enemies.push(e)
    }

    // Build a jagged asteroid silhouette as a closed polygon. Vertex
    // count + radii are randomised per asteroid so each one looks
    // distinct.
    function makeAsteroidVertices() {
      const count = 9 + Math.floor(Math.random() * 3)   // 9-11 verts
      const verts = []
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2
        const r = 18 + Math.random() * 10              // 18-28
        verts.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r })
      }
      return verts
    }

    // Asteroid: slow, diagonal-trajectory mid-wave threat. Spawns at the
    // top or bottom edge and crosses the playfield at an angle. Outer
    // shell takes G_ASTEROID_SHELL_HP hits to crack; once revealed, the
    // core fires homing missiles and takes G_ASTEROID_CORE_HP hits to
    // destroy.
    function spawnAsteroid() {
      const fromTop = Math.random() < 0.5
      // Spawn somewhere in the right 60 % of the screen so the asteroid
      // has runway to cross diagonally before exiting left.
      const x = G_W * 0.4 + Math.random() * (G_W * 0.55)
      const y = fromTop ? -40 : G_H + 40
      const vx = -45 - Math.random() * 30
      const vy = (fromTop ? 1 : -1) * (35 + Math.random() * 30)
      state.enemies.push({
        kind: 'asteroid',
        x, y, vx, vy,
        hp: G_ASTEROID_SHELL_HP,
        coreHp: G_ASTEROID_CORE_HP,
        revealed: false,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 1.2,
        vertices: makeAsteroidVertices(),
        fireT: 2.0 + Math.random() * 1.5,
      })
    }

    function spawnBoss() {
      // shield[layer][wedge] = remaining hits on that segment.
      // layer: 0 = outer, 1 = mid, 2 = inner.
      // wedge: 0 = top, 1 = upper-mid, 2 = lower-mid, 3 = bottom (along the
      // leftward arc facing the player).
      const shield = []
      for (let l = 0; l < G_SHIELD_LAYERS; l++) {
        const row = []
        for (let w = 0; w < G_SHIELD_WEDGES; w++) {
          row.push(G_SHIELD_HITS_PER_SEG)
        }
        shield.push(row)
      }
      state.boss = {
        x: G_W - 160, y: G_H / 2,
        vy: 30,
        hp: G_BOSS_HP_MAX,
        hpMax: G_BOSS_HP_MAX,
        fireT: 2.5,
        missileT: 5,    // first missile attempt ~5 s after boss spawns
        eyePulse: 0,
        shield,
      }
      sfx.bossSpawn()
    }

    // Map a bullet position to a shield wedge index (0..3), or -1 if the
    // bullet is on the wrong side of the boss (right side, where the
    // shield doesn't cover). Wedges divide the leftward semicircle into
    // four 45° slices; index increases from top to bottom.
    function wedgeIndexForPoint(bx, by, ox, oy) {
      const dx = bx - ox
      const dy = by - oy
      let theta = Math.atan2(dy, dx)
      if (theta < 0) theta += 2 * Math.PI
      // Shield arc: canvas angles [π/2, 3π/2] (the leftward semicircle).
      if (theta < Math.PI / 2 || theta > 3 * Math.PI / 2) return -1
      // Top wedge (W0) covers angles 5π/4..3π/2; bottom wedge (W3)
      // covers π/2..3π/4. Hence the `3 -` flip.
      const w = 3 - Math.floor((theta - Math.PI / 2) / G_WEDGE_SIZE)
      return Math.max(0, Math.min(G_SHIELD_WEDGES - 1, w))
    }

    function pushExplosion(x, y, big = false) {
      const lines = []
      const count = big ? 14 : 8
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.3
        const speed = (big ? 220 : 140) + Math.random() * 80
        lines.push({
          x, y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          len: big ? 14 + Math.random() * 8 : 7 + Math.random() * 5,
        })
      }
      state.explosions.push({
        x, y, t: 0,
        life: big ? 0.85 : 0.45,
        lines,
      })
      sfx.explode()
    }

    function damagePlayer() {
      if (state.player.invulnUntil > state.tNow) return
      if (state.player.shield) {
        state.player.shield = false
        sfx.hit()
        state.shake = 0.18
        return
      }
      state.lives -= 1
      state.player.invulnUntil = state.tNow + G_INVULN_AFTER_HIT
      state.shake = 0.32
      sfx.playerHit()
      if (state.lives <= 0) {
        state.phase = 'GAME_OVER'
      } else {
        // Respawn at left-centre.
        state.player.x = 100
        state.player.y = G_H / 2
      }
    }

    // ── Game loop ─────────────────────────────────────────────────
    let raf = 0
    let last = performance.now()
    let flicker = 0
    state.tNow = 0

    function step(now) {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      flicker += dt
      state.tNow += dt
      if (state.shake > 0) state.shake = Math.max(0, state.shake - dt)

      // Sync the in-game power-up flag every frame so a trigger input
      // mid-game grants the loadout immediately.
      syncPowerup()

      const playing = (state.phase === 'WAVE' || state.phase === 'BOSS' || state.phase === 'BOSS_INTRO')

      // ── Input → player movement ────────────────────────────────
      if (playing) {
        let dx = 0, dy = 0
        if (keys.has('arrowup')   || keys.has('w')) dy -= 1
        if (keys.has('arrowdown') || keys.has('s')) dy += 1
        if (keys.has('arrowleft') || keys.has('a')) dx -= 1
        if (keys.has('arrowright')|| keys.has('d')) dx += 1
        if (dx !== 0 && dy !== 0) {
          const inv = 1 / Math.sqrt(2)
          dx *= inv; dy *= inv
        }
        const speed = G_PLAYER_SPEED * (state.player.powered ? 1.5 : 1)
        state.player.x += dx * speed * dt
        state.player.y += dy * speed * dt
        const m = G_PLAYER_SIZE + 2
        if (state.player.x < m) state.player.x = m
        if (state.player.x > G_W - m) state.player.x = G_W - m
        if (state.player.y < m) state.player.y = m
        if (state.player.y > G_H - m) state.player.y = G_H - m

        // Fire
        state.player.fireCooldown -= dt
        if (keys.has(' ') && state.player.fireCooldown <= 0) {
          state.player.fireCooldown = G_FIRE_COOLDOWN
          if (state.player.powered) {
            state.bullets.push({ x: state.player.x + G_PLAYER_SIZE, y: state.player.y - 5, vx: G_PLAYER_BULLET_SPEED })
            state.bullets.push({ x: state.player.x + G_PLAYER_SIZE, y: state.player.y + 5, vx: G_PLAYER_BULLET_SPEED })
          } else {
            state.bullets.push({ x: state.player.x + G_PLAYER_SIZE, y: state.player.y, vx: G_PLAYER_BULLET_SPEED })
          }
          sfx.shoot()
        }
      }

      // ── Phase progression ──────────────────────────────────────
      if (state.phase === 'WAVE') {
        state.waveTime += dt
        if (state.waveTime >= G_WAVE_DURATION) {
          state.phase = 'BOSS_INTRO'
          state.bossIntroT = 0
          // Clear lingering enemies for the boss intro pause.
          state.enemies = []
          state.enemyBullets = []
        } else {
          // Spawn rate ramps from ~0.6/s to ~1.5/s.
          const t = state.waveTime / G_WAVE_DURATION
          const ratePerSec = 0.6 + t * 0.9
          state.spawnAccum += dt * ratePerSec
          while (state.spawnAccum >= 1) {
            state.spawnAccum -= 1
            spawnEnemy()
          }
          // Asteroid spawning runs on its own slower timer alongside the
          // standard fodder; arrives every G_ASTEROID_INTERVAL_MIN..MAX
          // seconds. Don't spawn one too close to the boss intro — give
          // it room to actually be a threat before the wave ends.
          state.asteroidT -= dt
          if (state.asteroidT <= 0 && state.waveTime < G_WAVE_DURATION - 8) {
            state.asteroidT = G_ASTEROID_INTERVAL_MIN +
              Math.random() * (G_ASTEROID_INTERVAL_MAX - G_ASTEROID_INTERVAL_MIN)
            spawnAsteroid()
          }
        }
      } else if (state.phase === 'BOSS_INTRO') {
        state.bossIntroT += dt
        if (state.bossIntroT >= 1.6) {
          state.phase = 'BOSS'
          spawnBoss()
        }
      } else if (state.phase === 'BOSS') {
        const b = state.boss
        if (b) {
          b.y += b.vy * dt
          if (b.y < 100 || b.y > G_H - 100) b.vy = -b.vy
          b.fireT -= dt
          b.eyePulse += dt
          if (b.fireT <= 0) {
            b.fireT = 1.4 + Math.random() * 0.5
            // 5-bullet aimed fan toward the player. Fires regardless of
            // shield state — the shield protects the boss from incoming
            // damage, not its own outgoing fire.
            const dx = state.player.x - b.x
            const dy = state.player.y - b.y
            const baseAng = Math.atan2(dy, dx)
            for (let i = -2; i <= 2; i++) {
              const ang = baseAng + i * 0.18
              state.enemyBullets.push({
                x: b.x - 60, y: b.y,
                vx: Math.cos(ang) * G_ENEMY_BULLET_SPEED,
                vy: Math.sin(ang) * G_ENEMY_BULLET_SPEED,
              })
            }
            sfx.enemyShoot()
          }
          // Homing-missile launch on its own (faster, ~2x rate) timer.
          // Aimed at the player; fires regardless of shield state.
          b.missileT -= dt
          if (b.missileT <= 0) {
            b.missileT = G_MISSILE_INTERVAL_MIN +
              Math.random() * (G_MISSILE_INTERVAL_MAX - G_MISSILE_INTERVAL_MIN)
            const dx = state.player.x - b.x
            const dy = state.player.y - b.y
            const launchAng = Math.atan2(dy, dx)
            const dirX = Math.cos(launchAng)
            const dirY = Math.sin(launchAng)
            state.enemyMissiles.push({
              x: b.x - 60, y: b.y,
              vx: dirX * G_MISSILE_SPEED,
              vy: dirY * G_MISSILE_SPEED,
              hp: G_MISSILE_HP,
              age: 0,
            })
            sfx.missileLaunch()
          }
          if (b.hp <= 0 && state.bossExplodeT === 0) {
            state.bossExplodeT = 0.001
          }
        }
        if (state.bossExplodeT > 0) {
          state.bossExplodeT += dt
          // Multiple staggered explosions for the kill.
          if (state.bossExplodeT < 1.0 && Math.random() < 0.3) {
            pushExplosion(
              state.boss.x + (Math.random() - 0.5) * 100,
              state.boss.y + (Math.random() - 0.5) * 60,
              false,
            )
          }
          if (state.bossExplodeT >= 1.1) {
            pushExplosion(state.boss.x, state.boss.y, true)
            state.boss = null
            state.phase = 'WIN'
          }
        }
      }

      // ── Enemies ────────────────────────────────────────────────
      for (const e of state.enemies) {
        e.x += e.vx * dt
        if (e.kind === 'asteroid') {
          // Asteroids carry their own vy from spawn (diagonal trajectory)
          // and rotate while the shell is intact for visual flavour.
          e.y += e.vy * dt
          if (!e.revealed) e.rotation += e.rotSpeed * dt
        } else if (e.kind !== 'drone') {
          // Gunners and cruisers bob slightly.
          e.wob += dt * 1.4
          e.y += Math.sin(e.wob) * 18 * dt
        }
        e.fireT -= dt
        if (e.fireT <= 0 && e.x < G_W - 20 && e.x > 0 && e.y > 0 && e.y < G_H) {
          if (e.kind === 'gunner') {
            const dx = state.player.x - e.x
            const dy = state.player.y - e.y
            const mag = Math.hypot(dx, dy) || 1
            state.enemyBullets.push({
              x: e.x, y: e.y,
              vx: (dx / mag) * G_ENEMY_BULLET_SPEED,
              vy: (dy / mag) * G_ENEMY_BULLET_SPEED,
            })
            e.fireT = 1.6 + Math.random() * 0.8
            sfx.enemyShoot()
          } else if (e.kind === 'cruiser') {
            const dx = state.player.x - e.x
            const dy = state.player.y - e.y
            const baseAng = Math.atan2(dy, dx)
            for (let i = -1; i <= 1; i++) {
              const ang = baseAng + i * 0.22
              state.enemyBullets.push({
                x: e.x, y: e.y,
                vx: Math.cos(ang) * G_ENEMY_BULLET_SPEED,
                vy: Math.sin(ang) * G_ENEMY_BULLET_SPEED,
              })
            }
            e.fireT = 2.4 + Math.random() * 1.0
            sfx.enemyShoot()
          } else if (e.kind === 'asteroid' && e.revealed) {
            // Cracked asteroid — core launches a homing missile toward
            // the player, same machinery as the boss missiles.
            const dx = state.player.x - e.x
            const dy = state.player.y - e.y
            const launchAng = Math.atan2(dy, dx)
            state.enemyMissiles.push({
              x: e.x, y: e.y,
              vx: Math.cos(launchAng) * G_MISSILE_SPEED,
              vy: Math.sin(launchAng) * G_MISSILE_SPEED,
              hp: G_MISSILE_HP,
              age: 0,
            })
            e.fireT = G_ASTEROID_FIRE_MIN +
              Math.random() * (G_ASTEROID_FIRE_MAX - G_ASTEROID_FIRE_MIN)
            sfx.missileLaunch()
          }
        }
      }
      // Filter dead enemies + off-screen exits. Asteroids leave the
      // playfield via top/bottom too, so allow vertical bail-out.
      state.enemies = state.enemies.filter((e) => {
        if (e.hp <= 0) return false
        if (e.x < -60 || e.x > G_W + 60) return false
        if (e.kind === 'asteroid' && (e.y < -80 || e.y > G_H + 80)) return false
        return true
      })

      // ── Bullets ────────────────────────────────────────────────
      for (const b of state.bullets) b.x += b.vx * dt
      state.bullets = state.bullets.filter((b) => b.x < G_W + 20)

      for (const b of state.enemyBullets) {
        b.x += b.vx * dt
        b.y += b.vy * dt
      }
      state.enemyBullets = state.enemyBullets.filter((b) =>
        b.x > -20 && b.x < G_W + 20 && b.y > -20 && b.y < G_H + 20,
      )

      // Homing missiles — limited turn rate so the player can outmanoeuvre
      // by repositioning, but the missile is persistent until shot down
      // or contact made. Movement: rotate current heading toward player.
      for (const m of state.enemyMissiles) {
        if (m.hp <= 0) continue
        m.age += dt
        const tx = state.player.x - m.x
        const ty = state.player.y - m.y
        const targetAng = Math.atan2(ty, tx)
        const currentAng = Math.atan2(m.vy, m.vx)
        let diff = targetAng - currentAng
        while (diff > Math.PI) diff -= 2 * Math.PI
        while (diff < -Math.PI) diff += 2 * Math.PI
        const turn = G_MISSILE_TURN * dt
        const applied = Math.max(-turn, Math.min(turn, diff))
        const newAng = currentAng + applied
        m.vx = Math.cos(newAng) * G_MISSILE_SPEED
        m.vy = Math.sin(newAng) * G_MISSILE_SPEED
        m.x += m.vx * dt
        m.y += m.vy * dt
      }
      state.enemyMissiles = state.enemyMissiles.filter((m) =>
        m.hp > 0 && m.x > -40 && m.x < G_W + 40 && m.y > -40 && m.y < G_H + 40,
      )

      // ── Collisions ─────────────────────────────────────────────
      // Player bullet → enemy
      for (const b of state.bullets) {
        for (const e of state.enemies) {
          if (e.hp <= 0) continue
          let r
          if (e.kind === 'asteroid') r = e.revealed ? G_ASTEROID_CORE_R : G_ASTEROID_SHELL_R
          else r = e.kind === 'cruiser' ? 18 : (e.kind === 'gunner' ? 14 : 10)
          if (Math.hypot(b.x - e.x, b.y - e.y) < r + 4) {
            e.hp -= 1
            b.x = G_W + 100   // mark for removal
            sfx.hit()
            if (e.hp <= 0) {
              if (e.kind === 'asteroid' && !e.revealed) {
                // Shell cracks — fragment burst, then continue with the
                // smaller core fight. Same e survives, hp resets to core.
                e.revealed = true
                e.hp = e.coreHp
                pushExplosion(e.x, e.y, true)
                sfx.explode()
                // Award a partial score for cracking the shell so the
                // player gets feedback even if the core escapes.
                state.score += 30
              } else {
                let reward
                if (e.kind === 'asteroid') reward = G_ASTEROID_SCORE_REWARD
                else reward = e.kind === 'cruiser' ? 50 : (e.kind === 'gunner' ? 25 : 10)
                state.score += reward
                pushExplosion(e.x, e.y, e.kind === 'cruiser' || e.kind === 'asteroid')
              }
            }
            break
          }
        }
      }
      // Player bullet → boss (via shield)
      // Outer-to-inner sequential check: the first intact layer at the
      // bullet's wedge consumes the bullet. If all three layers at that
      // wedge are broken, the bullet reaches the boss core.
      if (state.boss && state.bossExplodeT === 0) {
        const boss = state.boss
        for (const bl of state.bullets) {
          if (bl.x > G_W) continue   // already marked for removal
          const dist = Math.hypot(bl.x - boss.x, bl.y - boss.y)
          if (dist > G_SHIELD_R_OUTER + 4) continue
          const wedge = wedgeIndexForPoint(bl.x, bl.y, boss.x, boss.y)
          let consumedAt = null   // {layer:0|1|2} | 'core'
          if (wedge >= 0) {
            if (dist < G_SHIELD_R_OUTER && boss.shield[0][wedge] > 0) {
              boss.shield[0][wedge] -= 1
              consumedAt = { layer: 0, wedge }
            } else if (dist < G_SHIELD_R_MID && boss.shield[1][wedge] > 0) {
              boss.shield[1][wedge] -= 1
              consumedAt = { layer: 1, wedge }
            } else if (dist < G_SHIELD_R_INNER && boss.shield[2][wedge] > 0) {
              boss.shield[2][wedge] -= 1
              consumedAt = { layer: 2, wedge }
            } else if (dist < G_BOSS_CORE_R) {
              boss.hp -= G_BOSS_HIT_DAMAGE
              consumedAt = 'core'
            }
          } else if (dist < G_BOSS_CORE_R) {
            // Bullet entered from the right (rare — e.g. via boss vertical
            // drift moving past a stationary bullet). Allow direct core hit.
            boss.hp -= G_BOSS_HIT_DAMAGE
            consumedAt = 'core'
          }
          if (consumedAt) {
            bl.x = G_W + 100
            sfx.hit()
            pushExplosion(bl.x - 8, bl.y, false)
          }
        }
      }
      // Player bullet → homing missile (intercept). 2 hits to destroy.
      for (const bl of state.bullets) {
        if (bl.x > G_W) continue
        for (const m of state.enemyMissiles) {
          if (m.hp <= 0) continue
          if (Math.hypot(bl.x - m.x, bl.y - m.y) < G_MISSILE_HIT_RADIUS + 3) {
            m.hp -= 1
            bl.x = G_W + 100
            sfx.hit()
            if (m.hp <= 0) {
              pushExplosion(m.x, m.y, false)
            }
            break
          }
        }
      }
      state.bullets = state.bullets.filter((b) => b.x < G_W + 20)

      // Enemy bullet / enemy body → player
      if (playing) {
        for (const b of state.enemyBullets) {
          if (Math.hypot(b.x - state.player.x, b.y - state.player.y) < G_PLAYER_SIZE) {
            damagePlayer()
            b.x = -100   // remove
            break
          }
        }
        state.enemyBullets = state.enemyBullets.filter((b) => b.x > -20)
        for (const e of state.enemies) {
          if (e.hp <= 0) continue
          let r
          if (e.kind === 'asteroid') r = e.revealed ? G_ASTEROID_CORE_R + 2 : G_ASTEROID_SHELL_R + 2
          else r = e.kind === 'cruiser' ? 20 : (e.kind === 'gunner' ? 16 : 12)
          if (Math.hypot(e.x - state.player.x, e.y - state.player.y) < r + G_PLAYER_SIZE - 4) {
            damagePlayer()
            e.hp = 0
            pushExplosion(e.x, e.y, false)
            break
          }
        }
        if (state.boss && state.bossExplodeT === 0) {
          if (Math.hypot(state.boss.x - state.player.x, state.boss.y - state.player.y) < 70 + G_PLAYER_SIZE) {
            damagePlayer()
          }
        }
        // Homing missile → player.
        for (const m of state.enemyMissiles) {
          if (m.hp <= 0) continue
          if (Math.hypot(m.x - state.player.x, m.y - state.player.y) < G_MISSILE_HIT_RADIUS + G_PLAYER_SIZE - 2) {
            damagePlayer()
            pushExplosion(m.x, m.y, false)
            m.hp = 0
            break
          }
        }
      }

      // ── Explosions ─────────────────────────────────────────────
      for (const ex of state.explosions) {
        ex.t += dt
        for (const ln of ex.lines) {
          ln.x += ln.vx * dt
          ln.y += ln.vy * dt
        }
      }
      state.explosions = state.explosions.filter((ex) => ex.t < ex.life)

      // ── Terminal-phase one-shots ──────────────────────────────
      if (state.phase === 'WIN' && !state.winFanfarePlayed) {
        state.winFanfarePlayed = true
        state.winShownAt = state.tNow
        sfx.win()
      }
      if (state.phase === 'GAME_OVER' && !state.gameOverPlayed) {
        state.gameOverPlayed = true
        sfx.gameOver()
      }

      // ── Render ─────────────────────────────────────────────────
      ctx.save()
      // Screen shake
      if (state.shake > 0) {
        const m = state.shake * 12
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m)
      }
      ctx.fillStyle = '#000'
      ctx.fillRect(-20, -20, G_W + 40, G_H + 40)

      // Star field
      ctx.fillStyle = G_PHOSPHOR
      for (let i = 0; i < 60; i++) {
        const sx = (i * 97 + flicker * 12) % G_W
        const sy = (i * 53) % G_H
        const a = 0.08 + 0.10 * Math.sin(flicker * 2 + i)
        ctx.globalAlpha = a
        ctx.fillRect(sx, sy, 1, 1)
      }
      ctx.globalAlpha = 1

      // Player bullets
      ctx.strokeStyle = G_PHOSPHOR
      ctx.lineWidth = 2
      for (const b of state.bullets) {
        ctx.beginPath()
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - 10, b.y)
        ctx.stroke()
      }
      // Enemy bullets
      ctx.lineWidth = 1.5
      for (const b of state.enemyBullets) {
        ctx.beginPath()
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - b.vx * 0.012, b.y - b.vy * 0.012)
        ctx.stroke()
      }

      // Homing missiles — wireframe arrowhead with a flickering trail,
      // oriented along its current heading. Pulses faintly so it reads
      // as distinct from ordinary enemy bullets.
      ctx.lineWidth = 1.6
      for (const m of state.enemyMissiles) {
        if (m.hp <= 0) continue
        const ang = Math.atan2(m.vy, m.vx)
        ctx.save()
        ctx.translate(m.x, m.y)
        ctx.rotate(ang)
        const pulse = 0.85 + 0.15 * Math.sin(m.age * 12)
        ctx.globalAlpha = pulse
        // Arrowhead body.
        ctx.beginPath()
        ctx.moveTo(9, 0)
        ctx.lineTo(-7, 5)
        ctx.lineTo(-4, 0)
        ctx.lineTo(-7, -5)
        ctx.closePath()
        ctx.stroke()
        // Trail / exhaust — random length each frame for engine flicker.
        const trail = 6 + Math.random() * 6
        ctx.beginPath()
        ctx.moveTo(-4, 0)
        ctx.lineTo(-4 - trail, 0)
        ctx.stroke()
        // Damaged missile shows a small notch missing on the side.
        if (m.hp < G_MISSILE_HP) {
          ctx.beginPath()
          ctx.moveTo(2, 3)
          ctx.lineTo(0, 5)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        ctx.restore()
      }

      // Enemies
      ctx.lineWidth = 1.5
      for (const e of state.enemies) {
        if (e.kind === 'asteroid') {
          ctx.save()
          ctx.translate(e.x, e.y)
          if (!e.revealed) {
            // Outer rocky shell — rotating jagged polygon. Damage tells:
            // a few hairline cracks once the shell's been chipped at.
            ctx.rotate(e.rotation)
            ctx.lineWidth = 1.7
            ctx.beginPath()
            e.vertices.forEach((v, i) => {
              if (i === 0) ctx.moveTo(v.x, v.y)
              else ctx.lineTo(v.x, v.y)
            })
            ctx.closePath()
            ctx.stroke()
            // Crack lines as the shell takes damage.
            const dmgFrac = 1 - (e.hp / G_ASTEROID_SHELL_HP)
            const cracks = Math.floor(dmgFrac * 4)
            ctx.lineWidth = 1
            for (let ci = 0; ci < cracks; ci++) {
              const a1 = (ci * 2.0) + 0.3
              const a2 = a1 + 0.9 + Math.sin(ci * 11) * 0.4
              ctx.beginPath()
              ctx.moveTo(Math.cos(a1) * 6, Math.sin(a1) * 6)
              ctx.lineTo(Math.cos(a2) * 18, Math.sin(a2) * 18)
              ctx.stroke()
            }
          } else {
            // Revealed core — diamond hull with a pulsing eye and a
            // small forward muzzle so it reads as "the thing inside
            // that was firing."
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(0, -10)
            ctx.lineTo(11, 0)
            ctx.lineTo(0, 10)
            ctx.lineTo(-11, 0)
            ctx.closePath()
            ctx.stroke()
            // Pulsing centre.
            const pulse = 2.5 + 0.8 * Math.sin(state.tNow * 6)
            ctx.beginPath()
            ctx.arc(0, 0, pulse, 0, Math.PI * 2)
            ctx.stroke()
            // Forward muzzle nub.
            ctx.beginPath()
            ctx.moveTo(11, 0)
            ctx.lineTo(15, -2)
            ctx.lineTo(15, 2)
            ctx.closePath()
            ctx.stroke()
          }
          ctx.restore()
          continue
        }
        ctx.beginPath()
        if (e.kind === 'drone') {
          // Small triangle pointing left.
          ctx.moveTo(e.x - 10, e.y)
          ctx.lineTo(e.x + 8,  e.y - 8)
          ctx.lineTo(e.x + 8,  e.y + 8)
        } else if (e.kind === 'gunner') {
          // Diamond.
          ctx.moveTo(e.x - 14, e.y)
          ctx.lineTo(e.x,      e.y - 10)
          ctx.lineTo(e.x + 14, e.y)
          ctx.lineTo(e.x,      e.y + 10)
        } else {
          // Cruiser — elongated hex.
          ctx.moveTo(e.x - 22, e.y)
          ctx.lineTo(e.x - 10, e.y - 12)
          ctx.lineTo(e.x + 14, e.y - 12)
          ctx.lineTo(e.x + 22, e.y)
          ctx.lineTo(e.x + 14, e.y + 12)
          ctx.lineTo(e.x - 10, e.y + 12)
        }
        ctx.closePath()
        ctx.stroke()
        if (e.kind === 'cruiser') {
          // Inner detail line.
          ctx.beginPath()
          ctx.moveTo(e.x - 6, e.y)
          ctx.lineTo(e.x + 10, e.y)
          ctx.stroke()
        }
      }

      // Boss
      if (state.boss) {
        const b = state.boss
        ctx.lineWidth = 1.8
        ctx.strokeStyle = G_PHOSPHOR
        ctx.beginPath()
        ctx.moveTo(b.x - 70, b.y - 36)
        ctx.lineTo(b.x + 70, b.y - 36)
        ctx.lineTo(b.x + 70, b.y + 36)
        ctx.lineTo(b.x - 70, b.y + 36)
        ctx.closePath()
        ctx.stroke()
        // Forward muzzle.
        ctx.beginPath()
        ctx.moveTo(b.x - 70, b.y - 18)
        ctx.lineTo(b.x - 90, b.y - 6)
        ctx.lineTo(b.x - 90, b.y + 6)
        ctx.lineTo(b.x - 70, b.y + 18)
        ctx.stroke()
        // Pulsing eye.
        const pulse = 14 + Math.sin(b.eyePulse * 4) * 3
        ctx.beginPath()
        ctx.arc(b.x, b.y, pulse, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(b.x, b.y, pulse * 0.4, 0, Math.PI * 2)
        ctx.stroke()

        // Shield arcs: 3 nested layers × 4 wedges. Wedge 0 (top) sits at
        // canvas angle 5π/4..3π/2; W3 (bottom) at π/2..3π/4. Broken
        // segments don't draw; half-damaged segments draw at reduced
        // opacity. A small visual gap between adjacent wedges sells the
        // "wedged shield" silhouette.
        const SHIELD_RADII = [G_SHIELD_R_OUTER, G_SHIELD_R_MID, G_SHIELD_R_INNER]
        const wedgeGap = 0.04   // radians of empty gap between wedges
        ctx.lineWidth = 2.4
        for (let l = 0; l < G_SHIELD_LAYERS; l++) {
          const r = SHIELD_RADII[l]
          for (let wi = 0; wi < G_SHIELD_WEDGES; wi++) {
            const hp = b.shield[l][wi]
            if (hp <= 0) continue
            const alpha = hp / G_SHIELD_HITS_PER_SEG     // 1.0 full, 0.5 damaged
            // Canvas-angle range for wedge wi (counted top-to-bottom):
            // wi=0 → 5π/4..3π/2 (top); wi=3 → π/2..3π/4 (bottom).
            const angStart = Math.PI / 2 + (3 - wi) * G_WEDGE_SIZE + wedgeGap / 2
            const angEnd   = Math.PI / 2 + (4 - wi) * G_WEDGE_SIZE - wedgeGap / 2
            ctx.globalAlpha = 0.35 + 0.65 * alpha
            ctx.beginPath()
            ctx.arc(b.x, b.y, r, angStart, angEnd)
            ctx.stroke()
          }
        }
        ctx.globalAlpha = 1

        // HP bar / shield status (bottom centre).
        const allWedgesIntact = b.shield[0].every((h) => h > 0) &&
                                 b.shield[1].every((h) => h > 0) &&
                                 b.shield[2].every((h) => h > 0)
        const w = 360, h = 6, bx = (G_W - w) / 2, by = G_H - 28
        ctx.lineWidth = 1
        ctx.strokeRect(bx, by, w, h)
        const fill = Math.max(0, b.hp / b.hpMax)
        ctx.fillStyle = G_PHOSPHOR
        ctx.fillRect(bx, by, w * fill, h)
        ctx.fillStyle = G_PHOSPHOR
        ctx.font = '12px "VT323", "Courier New", monospace'
        ctx.textAlign = 'center'
        ctx.fillText(allWedgesIntact ? 'SHIELDS UP' : 'CORE', G_W / 2, by - 4)
      }

      // Player ship (with hit-blink during invuln)
      const blinkOn = (state.player.invulnUntil <= state.tNow) ||
                      (Math.floor(state.tNow * 16) % 2 === 0)
      if (playing && blinkOn) {
        ctx.strokeStyle = G_PHOSPHOR
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(state.player.x + G_PLAYER_SIZE, state.player.y)
        ctx.lineTo(state.player.x - G_PLAYER_SIZE, state.player.y - G_PLAYER_SIZE * 0.7)
        ctx.lineTo(state.player.x - G_PLAYER_SIZE * 0.5, state.player.y)
        ctx.lineTo(state.player.x - G_PLAYER_SIZE, state.player.y + G_PLAYER_SIZE * 0.7)
        ctx.closePath()
        ctx.stroke()
        // Engine flame.
        const flameLen = 6 + Math.random() * 5
        ctx.beginPath()
        ctx.moveTo(state.player.x - G_PLAYER_SIZE * 0.5, state.player.y)
        ctx.lineTo(state.player.x - G_PLAYER_SIZE * 0.5 - flameLen, state.player.y)
        ctx.stroke()
        // Shield ring.
        if (state.player.shield) {
          ctx.beginPath()
          ctx.arc(state.player.x, state.player.y, G_PLAYER_SIZE + 7 + Math.sin(state.tNow * 6) * 1.5, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // Explosions
      ctx.lineWidth = 1.5
      for (const ex of state.explosions) {
        const fade = 1 - (ex.t / ex.life)
        ctx.globalAlpha = Math.max(0, fade)
        for (const ln of ex.lines) {
          ctx.beginPath()
          ctx.moveTo(ln.x, ln.y)
          const back = ln.len * 0.5
          ctx.lineTo(ln.x - (ln.vx * 0.012 + back * Math.sign(ln.vx || 1)), ln.y - ln.vy * 0.012)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1

      // Boss intro telegraph.
      if (state.phase === 'BOSS_INTRO') {
        ctx.fillStyle = G_PHOSPHOR
        ctx.font = '34px "VT323", "Courier New", monospace'
        ctx.textAlign = 'center'
        const a = 0.5 + 0.5 * Math.sin(state.bossIntroT * 8)
        ctx.globalAlpha = a
        ctx.fillText('!! WARNING !!', G_W / 2, G_H / 2 - 10)
        ctx.font = '18px "VT323", "Courier New", monospace'
        ctx.fillText('CORE INBOUND', G_W / 2, G_H / 2 + 22)
        ctx.globalAlpha = 1
      }

      // Title strip + power-up indicator (always, while playing).
      if (playing) {
        ctx.fillStyle = G_PHOSPHOR
        ctx.font = '14px "VT323", "Courier New", monospace'
        ctx.textAlign = 'center'
        const label = state.phase === 'BOSS' ? '> NODIUS — CORE'
                    : state.phase === 'BOSS_INTRO' ? '> NODIUS — APPROACH'
                    : '> NODIUS'
        ctx.fillText(label + (state.player.powered ? '   [POWER UP]' : ''), G_W / 2, 22)
      }

      ctx.restore()

      // ── Sync HUD state ────────────────────────────────────────
      if (state.lives !== livesHudRef.current) {
        livesHudRef.current = state.lives
        setLivesHud(state.lives)
      }
      if (state.score !== scoreHudRef.current) {
        scoreHudRef.current = state.score
        setScoreHud(state.score)
      }
      if (state.phase !== phaseHudRef.current) {
        phaseHudRef.current = state.phase
        setPhaseHud(state.phase)
      }

      raf = requestAnimationFrame(step)
    }
    // Mirror refs so React-state syncs don't dirty-read stale closures.
    const livesHudRef = { current: state.lives }
    const scoreHudRef = { current: state.score }
    const phaseHudRef = { current: state.phase }
    raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      try { actx?.close() } catch { /* nothing */ }
    }
  }, [])

  // Lives icons rendered in the HUD.
  const lifeIcon = (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
      <path d="M 13 5 L 1 1 L 4 5 L 1 9 Z" stroke={G_PHOSPHOR} strokeWidth="1" />
    </svg>
  )

  const showWin      = phaseHud === 'WIN'
  const showGameOver = phaseHud === 'GAME_OVER'

  return (
    <div className="ovum-green-modal" role="dialog" aria-label="Nodius">
      <div className="ovum-green-frame">
        <canvas ref={canvasRef} className="ovum-green-canvas" />
        <div className="ovum-green-scanlines" />
        <div className="ovum-green-vignette" />
        <div className="ovum-green-hud">
          <div className="ovum-green-hud-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ opacity: 0.6 }}>LIVES</span>
              {Array.from({ length: Math.max(0, livesHud) }).map((_, i) => (
                <span key={i} style={{ display: 'inline-flex' }}>{lifeIcon}</span>
              ))}
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>SCORE </span>
              <span>{String(scoreHud).padStart(8, '0')}</span>
            </div>
          </div>
        </div>

        {showWin && (() => {
          const playerEntry = { name: playerName, score: scoreHud, _player: true }
          const rows = [...NODIUS_LEGENDS, ...scoredGuests, playerEntry]
            .sort((a, b) => b.score - a.score)
          return (
            <div className="ovum-green-overlay">
              <div className="ovum-green-overlay-inner">
                <div style={{ fontSize: 32 }}>{'> ACHIEVEMENT UNLOCKED.'}</div>
                <div style={{ fontSize: 22, marginTop: 10 }}>WELL PLAYED, GUNTER.</div>

                <div className="ovum-green-highscores">
                  <div className="ovum-green-highscores-title">HIGH SCORES</div>
                  {rows.map((row, i) => (
                    <div
                      key={i}
                      className={`ovum-green-highscores-row${row._player ? ' is-player' : ''}`}
                    >
                      <span style={{ width: 28, textAlign: 'right', opacity: 0.55 }}>
                        {row._player ? '>' : `${i + 1}.`}
                      </span>
                      <span style={{ flex: 1, textAlign: 'left', marginLeft: 10 }}>{row.name}</span>
                      <span style={{ minWidth: 84, textAlign: 'right' }}>{formatHighScore(row.score)}</span>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  className="ovum-green-btn"
                  style={{ marginTop: 22 }}
                  onClick={() => exitRef.current?.()}
                >[ EXIT ]</button>
                <div style={{ marginTop: 14, fontSize: 12, opacity: 0.5 }}>ENTER or ESC to exit</div>
              </div>
            </div>
          )
        })()}

        {showGameOver && (
          <div className="ovum-green-overlay">
            <div className="ovum-green-overlay-inner">
              <div style={{ fontSize: 32 }}>GAME OVER</div>
              <div style={{ marginTop: 16, opacity: 0.85 }}>
                SCORE: <span>{String(scoreHud).padStart(8, '0')}</span>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 26, justifyContent: 'center' }}>
                <button
                  type="button"
                  className="ovum-green-btn"
                  onClick={() => retryRef.current?.()}
                >[ RETRY ]</button>
                <button
                  type="button"
                  className="ovum-green-btn"
                  onClick={() => exitRef.current?.()}
                >[ EXIT ]</button>
              </div>
              <div style={{ marginTop: 16, fontSize: 12, opacity: 0.5 }}>R to retry · ESC to exit</div>
            </div>
          </div>
        )}

        <div className="ovum-green-hint">↑ ↑ ↓ ↓ ← → ← → B A · SPACE to fire · ESC to exit</div>
        <button
          type="button"
          className="ovum-green-mute"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
    </div>
  )
}

// ── Boot-sting tone ────────────────────────────────────────────────────
// Short rising arpeggio played as the modal fades in, after the
// pre-modal theme window. Programmatic Web Audio so we keep the
// "no audio assets" rule. The final trigger keypress counts as the
// user gesture that unlocks AudioContext, so this plays cleanly.
function playOvumGreenBoot() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const now = ctx.currentTime
    const notes = [261.63, 392.00, 523.25]   // C4, G4, C5
    notes.forEach((freq, i) => {
      const t = now + i * 0.12
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.10, t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.2)
    })
    setTimeout(() => { try { ctx.close() } catch { /* nothing */ } }, 800)
  } catch { /* silent — audio is non-essential */ }
}

// ── Mount / unmount ────────────────────────────────────────────────────
// Two-stage opening. First the theme applies and the user gets ~2.5s
// to register that the whole NarrativeNode UI just went phosphor green.
// Then the boot tone plays and the game cab fades in over the (still
// visible) themed app. Esc during the pre-theme window aborts cleanly.
const G_PRETHEME_MS = 2500

function mountOvumGreenModal() {
  if (g_modalActive || g_pretheme) return
  g_pretheme = true
  injectOvumGreenStyles()
  applyOvumGreenTheme()

  let timer = null
  function cleanupPretheme() {
    window.removeEventListener('keydown', abortHandler, true)
    if (timer) { clearTimeout(timer); timer = null }
  }
  function abortHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cleanupPretheme()
      g_pretheme = false
      restoreOvumGreenTheme()
    }
  }
  // Capture phase so we beat any other handler that might also act on
  // Escape during the pre-modal window.
  window.addEventListener('keydown', abortHandler, true)

  timer = setTimeout(() => {
    cleanupPretheme()
    g_pretheme = false
    if (g_modalActive) return   // belt-and-braces against re-entry
    playOvumGreenBoot()
    _mountNodiusFrame()
  }, G_PRETHEME_MS)
}

function _mountNodiusFrame() {
  g_modalActive = true
  markEggFired('green')
  const host = document.createElement('div')
  host.setAttribute('data-ovum-green-host', '1')
  document.body.appendChild(host)
  const root = createRoot(host)

  function exit() {
    if (!g_modalActive) return
    g_modalActive = false
    g_powerupActive = false
    try { root.unmount() } catch { /* nothing */ }
    if (host.parentNode) host.parentNode.removeChild(host)
    restoreOvumGreenTheme()
  }
  root.render(<OvumGreenGameModal onExit={exit} />)
}

/** Wired to the global keydown listener in `App.jsx`. Returns true if
 *  the key was consumed by the egg (so the caller can short-circuit
 *  any other handlers). */
export function detectAndFireOvumGreen(e) {
  // Inside the modal, the modal's own listener handles input — but we
  // still consume the trigger sequence here for the future Phase 6
  // power-up. For Phase 1 the in-game power-up is a no-op flag.
  const key = e.key
  const completed = pushOvumGreenKey(key)
  if (!completed) return false
  if (g_modalActive) {
    g_powerupActive = true
    return true
  }
  if (g_pretheme) return true   // already in the staged opening — ignore
  mountOvumGreenModal()
  return true
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_orange
// ══════════════════════════════════════════════════════════════════════

const O_BRAND = '#ff9000'
const O_TARGET_TAG = 'xxx'
const O_RESTORE_BUFFER_MS = 3000
const O_FALLBACK_VISIBLE_MS = 6000   // used when audio is blocked

let g_orange_active = false
let g_orange_pre_accent = null
let g_orange_fired_this_session = false
let g_orange_audio = null
let g_orange_restore_timer = null
const g_orange_listeners = new Set()

export function getOvumOrangeActive() { return g_orange_active }

export function subscribeOvumOrange(fn) {
  g_orange_listeners.add(fn)
  return () => g_orange_listeners.delete(fn)
}

function notifyOrangeListeners() {
  for (const fn of g_orange_listeners) {
    try { fn() } catch { /* listener errors must never break a write */ }
  }
}

function normaliseOrangeTag(t) {
  return (t == null ? '' : String(t)).trim().toLowerCase()
}
function tagsContainTarget(tags) {
  if (!Array.isArray(tags)) return false
  return tags.some((t) => normaliseOrangeTag(t) === O_TARGET_TAG)
}

/** Compare prev / next tag arrays. Fires once per session if the target
 *  tag was newly added (not present in prev, present in next). */
export function detectAndFireOvumOrange(prevTags, nextTags) {
  if (g_orange_fired_this_session) return false
  const hadTarget = tagsContainTarget(prevTags)
  const hasTarget = tagsContainTarget(nextTags)
  if (!hasTarget || hadTarget) return false
  g_orange_fired_this_session = true
  fireOvumOrange()
  return true
}

function fireOvumOrange() {
  // Snapshot pre-egg accent so we can restore it exactly.
  try {
    g_orange_pre_accent = useProjectStore.getState().story?.accent_color || DEFAULT_ACCENT_COLOR
  } catch {
    g_orange_pre_accent = DEFAULT_ACCENT_COLOR
  }
  applyAccentPalette(O_BRAND)
  g_orange_active = true
  notifyOrangeListeners()
  markEggFired('orange')

  // Audio: trigger chain runs synchronously inside the user's save click,
  // which is a valid gesture token for autoplay. If the .play() promise
  // rejects (rare), fall back to a fixed-duration timer so the visual
  // payload still has a clean restore.
  try {
    g_orange_audio = new Audio(OVUM_ORANGE_AUDIO)
    g_orange_audio.preload = 'auto'
    g_orange_audio.onended = () => {
      g_orange_restore_timer = setTimeout(restoreOvumOrange, O_RESTORE_BUFFER_MS)
    }
    const p = g_orange_audio.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        g_orange_restore_timer = setTimeout(restoreOvumOrange, O_FALLBACK_VISIBLE_MS)
      })
    }
  } catch {
    g_orange_restore_timer = setTimeout(restoreOvumOrange, O_FALLBACK_VISIBLE_MS)
  }
}

function restoreOvumOrange() {
  if (g_orange_audio) {
    try { g_orange_audio.pause() } catch { /* nothing */ }
    g_orange_audio.src = ''
    g_orange_audio = null
  }
  if (g_orange_restore_timer) {
    clearTimeout(g_orange_restore_timer)
    g_orange_restore_timer = null
  }
  applyAccentPalette(g_orange_pre_accent || DEFAULT_ACCENT_COLOR)
  g_orange_pre_accent = null
  g_orange_active = false
  notifyOrangeListeners()
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_white
// ══════════════════════════════════════════════════════════════════════
//
// All canvas state spawned here is tagged with `_egg: 'white'`. Asset
// module imported dynamically so the egg gracefully no-ops if absent.

// ── Trigger detection ──────────────────────────────────────────────────
const W_TARGET_NAME = 'apple'
const W_TRIGGER_ATTR = 'bad'
const w_firedFor = new Set()

function isOvumWhiteApple(entity) {
  if (!entity || entity.type !== 'item') return false
  return (entity.name || '').trim().toLowerCase() === W_TARGET_NAME
}
function entityHasBadAttr(entity) {
  const attrs = entity.attributes || []
  return attrs.some((a) => (a?.name || '').trim().toLowerCase() === W_TRIGGER_ATTR)
}

/** Called from entitiesStore on createEntity + updateEntity. Returns
 *  true if the egg fired. Per-entity once-per-session gate. Fire-and-
 *  forget; the actual sequence is async + try/catch internal. */
export function detectAndFireOvumWhite(entity) {
  if (!entity || !entity.id) return false
  // TEMP: per-entity once-per-session gate disabled for test-drive.
  // Re-enable: uncomment the next line.
  // if (w_firedFor.has(entity.id)) return false
  if (g_white_phase !== 'IDLE') return false   // already running
  if (g_white_suppressDetect) return false     // suppress during egg-internal updateEntity calls
  if (!isOvumWhiteApple(entity)) return false
  if (!entityHasBadAttr(entity)) return false
  w_firedFor.add(entity.id)
  startOvumWhite(entity).catch(() => { /* never break a save */ })
  return true
}

/** Chain-anchor variant. Called from projectStore.saveEntityChipDraft
 *  after a scene-node draft commit. Uses the scene node as the wire
 *  source; source handle = the entity's per-chip output port (handle id
 *  = entity id). */
export function detectAndFireOvumWhiteAtChainAnchor({ draft, entity, sourceEntityId, nodeId } = {}) {
  if (!entity || !sourceEntityId || !nodeId) return false
  if (g_white_phase !== 'IDLE') return false
  if (g_white_suppressDetect) return false
  if (!isOvumWhiteApple(entity)) return false
  const attrChanges = Array.isArray(draft?.attribute_changes) ? draft.attribute_changes : []
  const hasBadAdd = attrChanges.some((ac) =>
    ac?.action === 'add'
    && (ac?.attribute?.name || '').trim().toLowerCase() === W_TRIGGER_ATTR,
  )
  if (!hasBadAdd) return false
  w_firedFor.add(entity.id)
  startOvumWhite(entity, { sourceNodeId: nodeId, sourceHandle: sourceEntityId })
    .catch(() => { /* never break a save */ })
  return true
}

// ── Asset loader (dynamic import with graceful no-op) ──────────────────
let g_white_assets = null   // null = not tried; false = tried+failed; object = loaded

async function ensureOvumWhiteAssets() {
  if (g_white_assets !== null) return g_white_assets || null
  try {
    const m = await import('./OrchardSpoilage.js')
    g_white_assets = {
      framesData: JSON.parse(m.OVUM_WHITE_FRAMES_JSON),
      audioUrl: m.OVUM_WHITE_AUDIO,
      profileImage: m.OVUM_WHITE_PROFILE_IMAGE,           // companion node avatar
      appleProfileImage: m.OVUM_WHITE_APPLE_PROFILE_IMAGE, // stamped on trigger entity at egg-end
      nodeName: m.OVUM_WHITE_NODE_NAME,
      credits: m.OVUM_WHITE_CREDITS,
      fps: m.OVUM_WHITE_FPS,
      viewBox: m.OVUM_WHITE_VIEWBOX,
    }
  } catch {
    g_white_assets = false   // asset module absent → silent forever this session
  }
  return g_white_assets || null
}

// ── Phase state ────────────────────────────────────────────────────────
const W_T_CONNECT    = 800     // ms — connect bookend
const W_T_SPLIT      = 600     // ms — split bookend
const W_T_CLOSE      = 600     // ms — close bookend
const W_T_DISCONNECT = 800     // ms — disconnect bookend

let g_white_phase       = 'IDLE'
let g_white_phaseStart  = 0
let g_white_appleNodeId = null
let g_white_companionId = null
let g_white_edgeId      = null
let g_white_audio       = null
let g_white_raf         = 0
let g_white_audioStartT = 0   // performance.now() when playback began
let g_white_aborted     = false
let g_white_keyHandler  = null
let g_white_clickHandler = null
let g_white_paused      = false
let g_white_muted       = false
let g_white_pauseStart  = 0
let g_white_appleEntityId       = null
let g_white_appleHadProfileImg  = false
let g_white_suppressDetect      = false

// ── Spawn flow ─────────────────────────────────────────────────────────
// `opts.sourceNodeId` (optional) — chain-anchor variant uses the scene
// node where the trigger chain entry was added as the wire source
// instead of the entity-origin node.
// `opts.sourceHandle` (optional) — handle id on the source node. For a
// scene-node chip output port, this is the entity id (the chip output
// port handle is registered with `id={entityRef.entity_id}`).
async function startOvumWhite(appleEntity, opts = {}) {
  const assets = await ensureOvumWhiteAssets()
  if (!assets) return   // graceful no-op — asset module missing

  const project = useProjectStore.getState()

  // Locate the source node. Chain-anchor variant uses the supplied
  // scene node id; default variant finds the entity-origin node.
  let sourceNode = null
  if (opts.sourceNodeId) {
    sourceNode = (project.nodes || []).find((n) => n.id === opts.sourceNodeId) || null
  }
  if (!sourceNode) {
    sourceNode = (project.nodes || []).find(
      (n) => n.data?.entity_id === appleEntity.id || n.id === appleEntity.id,
    ) || null
  }
  if (!sourceNode) return
  g_white_appleNodeId = sourceNode.id
  g_white_appleEntityId = appleEntity.id
  g_white_appleHadProfileImg = !!appleEntity.profile_image_ref
  const sourceHandle = opts.sourceHandle || null

  // Position the companion 800 px to the right of the source node.
  const companionPos = {
    x: (sourceNode.position?.x ?? 0) + 800,
    y: (sourceNode.position?.y ?? 0),
  }

  // Push a custom-typed companion node directly. Skips the entity
  // round-trip (no entity in entitiesStore, no DB write) — purely a
  // canvas-only node rendered by OvumWhiteCompanionNode. Reads name /
  // avatar / credits from its `data` prop.
  const companionId = 'ovum-white-companion-' + Date.now()
  const creditsList = Array.isArray(assets.credits) ? assets.credits : []
  g_white_paused = false
  g_white_muted = false
  useProjectStore.setState((s) => ({
    nodes: [
      ...s.nodes,
      {
        id: companionId,
        type: 'ovumWhiteCompanion',
        position: companionPos,
        zIndex: 1100,
        width: 360,
        data: {
          _egg: 'white',
          name: assets.nodeName,
          profileImage: assets.profileImage,
          credits: creditsList,
          colour: appleEntity.colour || '#cccccc',
          paused: false,
          muted: false,
          onPlayPause: toggleOvumWhitePause,
          onMute: toggleOvumWhiteMute,
        },
      },
    ],
  }))
  g_white_companionId = companionId

  // Add the custom edge between source and companion. Rendered by
  // OvumWhiteSilhouetteEdge; its `data` is mutated each frame by
  // stepOvumWhite below.
  const edgeId = `ovum-white-edge-${Date.now()}`
  const initialData = {
    _egg: 'white',
    phase: 'CONNECT',
    splitFrac: 0,
    dashFrac: 0,
    frame: null,
    accent: getCurrentAccent(),
    time: 0,
  }
  useProjectStore.setState((s) => ({
    edges: [
      ...s.edges,
      {
        id: edgeId,
        source: g_white_appleNodeId,
        target: g_white_companionId,
        // Chain-anchor variant: pin to the entity's per-chip output
        // handle on the scene node (handle id = entity id). Default
        // variant: no sourceHandle override; React Flow uses the
        // entity-origin node's only/default source handle.
        ...(sourceHandle ? { sourceHandle } : {}),
        type: 'ovumWhiteSilhouetteEdge',
        data: initialData,
        selectable: false,
        // Lift above any nodes that might happen to sit between source
        // and companion in the user's project. xyflow v12 stacks nodes
        // + edges by zIndex; 9999 clears any user node-zIndex.
        zIndex: 9999,
      },
    ],
  }))
  g_white_edgeId = edgeId

  // Animated viewport fit.
  setTimeout(() => {
    const focus = useUiStore.getState()._fitViewToNodes
    if (focus) {
      focus([g_white_appleNodeId, g_white_companionId], { padding: 0.18 })
    } else {
      const focusOne = useUiStore.getState()._focusNode
      if (focusOne) focusOne(g_white_companionId)
    }
  }, 60)

  // Bind abort handlers.
  g_white_keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      abortOvumWhite()
    }
  }
  g_white_clickHandler = (e) => {
    // Click on the canvas anywhere outside the egg-spawned nodes/edge → abort.
    const target = e.target
    if (!target) return
    // If the click landed on the egg edge itself, ignore.
    if (target.closest && target.closest('.ovum-white-edge')) return
    // Clicks on the companion node (avatar, name, media controls) are
    // user interaction with the egg, not an exit signal.
    if (target.closest && target.closest('.ovum-white-companion-node')) return
    abortOvumWhite()
  }
  window.addEventListener('keydown', g_white_keyHandler, true)
  // Bind click after a short delay so the click that triggered the
  // egg (entity save) doesn't immediately abort it.
  setTimeout(() => {
    if (g_white_phase !== 'IDLE') {
      window.addEventListener('mousedown', g_white_clickHandler, true)
    }
  }, 1200)

  // Begin phase 1.
  g_white_phase = 'CONNECT'
  g_white_phaseStart = performance.now()
  g_white_aborted = false
  g_white_raf = requestAnimationFrame(stepOvumWhite)
  markEggFired('white')
}

// Use crypto.randomUUID if available, otherwise a simple fallback.
function cryptoRandomId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch { /* nothing */ }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function getCurrentAccent() {
  try {
    return useProjectStore.getState().story?.accent_color || DEFAULT_ACCENT_COLOR
  } catch {
    return DEFAULT_ACCENT_COLOR
  }
}

// ── Phase machine (RAF-driven) ─────────────────────────────────────────
function stepOvumWhite(now) {
  if (g_white_phase === 'IDLE' || g_white_aborted) return
  if (g_white_paused) {
    // Hold the current frame; no phase advancement, no edge data update.
    g_white_raf = requestAnimationFrame(stepOvumWhite)
    return
  }

  const elapsed = now - g_white_phaseStart
  const assets = g_white_assets    // already loaded by this point

  // Phase transitions.
  if (g_white_phase === 'CONNECT' && elapsed >= W_T_CONNECT) {
    g_white_phase = 'SPLIT'
    g_white_phaseStart = now
  } else if (g_white_phase === 'SPLIT' && elapsed >= W_T_SPLIT) {
    g_white_phase = 'PLAYBACK'
    g_white_phaseStart = now
    // Start audio.
    try {
      g_white_audio = new Audio(assets.audioUrl)
      g_white_audio.preload = 'auto'
      g_white_audio.muted = g_white_muted
      g_white_audio.onended = () => { advanceToClose() }
      const p = g_white_audio.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Autoplay rejected; fall back to RAF time for sync.
          g_white_audio = null
          g_white_audioStartT = performance.now()
        })
      } else {
        g_white_audioStartT = performance.now()
      }
    } catch {
      g_white_audio = null
      g_white_audioStartT = performance.now()
    }
  } else if (g_white_phase === 'CLOSE' && elapsed >= W_T_CLOSE) {
    g_white_phase = 'DISCONNECT'
    g_white_phaseStart = now
  } else if (g_white_phase === 'DISCONNECT' && elapsed >= W_T_DISCONNECT) {
    cleanupOvumWhite()
    return
  }

  // Compute current edge data.
  const data = computeOvumWhiteEdgeData(now)
  setOvumWhiteEdgeData(data)

  g_white_raf = requestAnimationFrame(stepOvumWhite)
}

function advanceToClose() {
  if (g_white_phase !== 'PLAYBACK') return
  g_white_phase = 'CLOSE'
  g_white_phaseStart = performance.now()
  if (g_white_audio) {
    try { g_white_audio.pause() } catch { /* nothing */ }
  }
}

function abortOvumWhite() {
  if (g_white_phase === 'IDLE' || g_white_aborted) return
  g_white_aborted = true
  // Skip directly to CLOSE so the user gets a clean wind-down.
  g_white_phase = 'CLOSE'
  g_white_phaseStart = performance.now()
  if (g_white_audio) {
    try { g_white_audio.pause() } catch { /* nothing */ }
  }
  // Bail out of paused state so CLOSE / DISCONNECT phases run.
  g_white_paused = false
  // Re-arm the loop in case it had stopped.
  g_white_aborted = false
  g_white_raf = requestAnimationFrame(stepOvumWhite)
}

function toggleOvumWhitePause() {
  if (g_white_phase === 'IDLE') return
  if (!g_white_paused) {
    g_white_paused = true
    g_white_pauseStart = performance.now()
    if (g_white_audio) {
      try { g_white_audio.pause() } catch { /* nothing */ }
    }
  } else {
    const pauseDuration = performance.now() - g_white_pauseStart
    g_white_phaseStart += pauseDuration
    g_white_audioStartT += pauseDuration
    g_white_paused = false
    if (g_white_audio) {
      try {
        const p = g_white_audio.play()
        if (p && typeof p.catch === 'function') p.catch(() => { /* nothing */ })
      } catch { /* nothing */ }
    }
  }
  updateCompanionData({ paused: g_white_paused })
}

function toggleOvumWhiteMute() {
  g_white_muted = !g_white_muted
  if (g_white_audio) {
    try { g_white_audio.muted = g_white_muted } catch { /* nothing */ }
  }
  updateCompanionData({ muted: g_white_muted })
}

function updateCompanionData(patch) {
  if (!g_white_companionId) return
  useProjectStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      n.id === g_white_companionId
        ? { ...n, data: { ...n.data, ...patch } }
        : n,
    ),
  }))
}

function computeOvumWhiteEdgeData(now) {
  const elapsed = now - g_white_phaseStart
  const accent = getCurrentAccent()
  let phase = g_white_phase
  let splitFrac = 0
  let dashFrac = 0
  let frame = null

  if (phase === 'CONNECT') {
    splitFrac = 0
    dashFrac = Math.min(1, elapsed / W_T_CONNECT)
  } else if (phase === 'SPLIT') {
    dashFrac = 1
    splitFrac = Math.min(1, elapsed / W_T_SPLIT)
  } else if (phase === 'PLAYBACK') {
    dashFrac = 1
    splitFrac = 1
    frame = currentSilhouetteFrame()
  } else if (phase === 'CLOSE') {
    dashFrac = 1
    splitFrac = Math.max(0, 1 - elapsed / W_T_CLOSE)
  } else if (phase === 'DISCONNECT') {
    splitFrac = 0
    dashFrac = Math.max(0, 1 - elapsed / W_T_DISCONNECT)
  }

  return { _egg: 'white', phase, splitFrac, dashFrac, frame, accent, time: now }
}

function currentSilhouetteFrame() {
  const a = g_white_assets
  if (!a) return null
  const fps = a.fps || 8
  let t = 0
  if (g_white_audio) {
    t = g_white_audio.currentTime || 0
  } else {
    t = (performance.now() - g_white_audioStartT) / 1000
  }
  const idx = Math.floor(t * fps)
  const total = a.framesData.frames.length
  if (idx >= total) return a.framesData.pool[a.framesData.frames[total - 1]]
  if (idx < 0) return a.framesData.pool[a.framesData.frames[0]]
  return a.framesData.pool[a.framesData.frames[idx]]
}

function setOvumWhiteEdgeData(data) {
  if (!g_white_edgeId) return
  useProjectStore.setState((s) => ({
    edges: s.edges.map((e) =>
      e.id === g_white_edgeId ? { ...e, data } : e,
    ),
  }))
}

// ── Cleanup ────────────────────────────────────────────────────────────
function cleanupOvumWhite() {
  cancelAnimationFrame(g_white_raf)
  g_white_raf = 0
  if (g_white_audio) {
    try { g_white_audio.pause() } catch { /* nothing */ }
    g_white_audio.src = ''
    g_white_audio = null
  }
  if (g_white_keyHandler) {
    window.removeEventListener('keydown', g_white_keyHandler, true)
    g_white_keyHandler = null
  }
  if (g_white_clickHandler) {
    window.removeEventListener('mousedown', g_white_clickHandler, true)
    g_white_clickHandler = null
  }

  // Remove the egg edge.
  if (g_white_edgeId) {
    useProjectStore.setState((s) => ({
      edges: s.edges.filter((e) => e.id !== g_white_edgeId),
    }))
    g_white_edgeId = null
  }
  // Remove the companion node. Silent — no undo entry, no
  // hasUnsavedChanges flip. The node is a custom egg-only type with
  // no underlying entity, so this is a single-step removal.
  if (g_white_companionId) {
    useProjectStore.setState((s) => ({
      nodes: s.nodes.filter((n) => n.id !== g_white_companionId),
    }))
    g_white_companionId = null
  }
  g_white_appleNodeId = null
  g_white_phase = 'IDLE'
  g_white_aborted = false
  g_white_paused = false
  g_white_muted = false

  // Apply the bundled trailing image to the trigger entity if it
  // didn't have one to begin with. The bundled image is a base64 data
  // URL — upload it as a real project asset via the same endpoint the
  // ProfileImageUpload component uses, then set the entity's
  // profile_image_ref to the returned filename. Fire-and-forget — egg
  // must never break user data. detectAndFireOvumWhite is suppressed
  // during the updateEntity write so the egg can't re-trigger
  // immediately after cleanup.
  const appleId = g_white_appleEntityId
  const hadImg = g_white_appleHadProfileImg
  const appleDataUrl = g_white_assets?.appleProfileImage
  g_white_appleEntityId = null
  g_white_appleHadProfileImg = false
  if (appleId && !hadImg && appleDataUrl) {
    applyOvumWhiteAppleImage(appleId, appleDataUrl)
      .catch(() => { /* never break a save */ })
  }
}

async function applyOvumWhiteAppleImage(appleId, dataUrl) {
  const ents = useEntitiesStore.getState()
  const apple = (ents.items || []).find((e) => e.id === appleId)
  if (!apple || apple.profile_image_ref) return
  // Convert data URL → Blob via fetch (works for data: URLs in modern browsers).
  const blobRes = await fetch(dataUrl)
  const blob = await blobRes.blob()
  const filename = `profile_${cryptoRandomId()}.jpg`
  const form = new FormData()
  form.append('file', blob, filename)
  // Lazy axios import — egg module avoids it elsewhere.
  const axios = (await import('axios')).default
  const { data } = await axios.post('/api/project/assets/upload', form)
  const fileRef = data?.file_ref
  if (!fileRef) return
  // Re-check current state — entity may have been edited or deleted
  // during cleanup.
  const fresh = (useEntitiesStore.getState().items || []).find((e) => e.id === appleId)
  if (!fresh || fresh.profile_image_ref) return
  g_white_suppressDetect = true
  try {
    await useEntitiesStore.getState().updateEntity(appleId, {
      ...fresh,
      profile_image_ref: fileRef,
    })
  } finally {
    g_white_suppressDetect = false
  }
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_black
// ══════════════════════════════════════════════════════════════════════
//
// Brief overlay that fades in over the canvas, holds, fades out — a
// quiet cinematic moment when the writer marks the close of a story.
// Background tops out at ~0.7 opacity so the user's work stays visible
// behind it (no full blackout — never make a writer think their work
// is gone). No audio, no assets, no DOM persistence after dismiss.

const B_TITLE_TRIGGERS = ['the end', 'fin', 'finis', 'finis.']
const B_CONTENT_TRIGGERS = ['the end', 'the end.']
const B_RECENT_LIMIT = 10
const b_recentNodes = []   // LRU of last N triggered scene ids
let b_active = false
let b_root = null
let b_container = null
let b_styleInjected = false

function bRememberFire(nodeId) {
  if (!nodeId) return
  const idx = b_recentNodes.indexOf(nodeId)
  if (idx !== -1) b_recentNodes.splice(idx, 1)
  b_recentNodes.unshift(nodeId)
  while (b_recentNodes.length > B_RECENT_LIMIT) b_recentNodes.pop()
}
function bWasRecent(nodeId) {
  return b_recentNodes.includes(nodeId)
}

/** Strip HTML to plain text for content matching. Returns a single
 *  newline-joined string of paragraph text. */
function bExtractText(html) {
  if (!html || typeof html !== 'string') return ''
  if (typeof document === 'undefined') return ''
  try {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    // Walk block elements as separate lines so paragraph-of-trigger
    // matching is cleaner than a wall of inline text.
    const lines = []
    const blocks = tmp.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, blockquote')
    if (blocks.length === 0) {
      return (tmp.textContent || '').trim()
    }
    blocks.forEach((b) => {
      const t = (b.textContent || '').trim()
      if (t) lines.push(t)
    })
    return lines.join('\n')
  } catch {
    return ''
  }
}

function bMatchTitle(title) {
  if (!title || typeof title !== 'string') return null
  const norm = title.trim().toLowerCase()
  if (B_TITLE_TRIGGERS.includes(norm)) {
    return title.trim()   // preserve the user's casing for the overlay text
  }
  return null
}

function bMatchContent(html) {
  const text = bExtractText(html)
  if (!text) return null
  // Match a paragraph whose entire content is one of the trigger
  // phrases (case-insensitive). Substring-in-prose matches do NOT
  // fire — "the end of summer" should not trigger.
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const norm = line.trim().toLowerCase()
    if (B_CONTENT_TRIGGERS.includes(norm)) {
      return line.trim()
    }
  }
  return null
}

/** Called from projectStore.updateNodeData. Fires when a scene's title
 *  or main_content matches a trigger. LRU prevents the same scene
 *  re-firing on rapid re-saves; reset on project load. Fire-and-
 *  forget. */
export function detectAndFireOvumBlack(node) {
  if (!node || node.type !== 'sceneNode') return false
  if (b_active) return false
  if (bWasRecent(node.id)) return false
  const titleHit = bMatchTitle(node.data?.title)
  const contentHit = titleHit ? null : bMatchContent(node.data?.main_content)
  const phrase = titleHit || contentHit
  if (!phrase) return false
  bRememberFire(node.id)
  try { mountOvumBlack(phrase) } catch { /* never break a save */ }
  return true
}

/** Called by projectStore on project load to clear the recent-fire
 *  LRU so a freshly-loaded project can fire again. */
export function resetOvumBlack() {
  b_recentNodes.length = 0
}

function ensureOvumBlackStyle() {
  if (b_styleInjected) return
  b_styleInjected = true
  if (typeof document === 'undefined') return
  const s = document.createElement('style')
  s.textContent = `
@keyframes ovumBlackVeilFade {
  0%   { opacity: 0; }
  15%  { opacity: 0.7; }
  85%  { opacity: 0.7; }
  100% { opacity: 0; }
}
@keyframes ovumBlackTextFade {
  0%   { opacity: 0; transform: translateY(10px) scale(0.96); }
  15%  { opacity: 1; transform: translateY(0)    scale(1); }
  85%  { opacity: 1; transform: translateY(0)    scale(1); }
  100% { opacity: 0; transform: translateY(-8px) scale(1.02); }
}
.ovum-black-veil {
  position: fixed; inset: 0;
  background: #000;
  pointer-events: none;
  z-index: 99998;
  animation: ovumBlackVeilFade 5500ms ease-in-out forwards;
  display: flex; align-items: center; justify-content: center;
}
.ovum-black-text {
  font-family: 'Snell Roundhand', 'Apple Chancery', 'Edwardian Script ITC',
               'Palace Script MT', 'Vivaldi', 'French Script MT',
               'Monotype Corsiva', 'Lucida Handwriting', 'Brush Script MT',
               'Segoe Script', cursive;
  font-style: normal;
  font-weight: 500;
  font-size: clamp(80px, 11vw, 180px);
  color: #fdfaf3;
  text-shadow: 0 6px 32px rgba(0,0,0,0.75), 0 0 1px rgba(253,250,243,0.4);
  letter-spacing: 0.02em;
  font-variant-ligatures: common-ligatures discretionary-ligatures contextual;
  font-feature-settings: 'liga' 1, 'dlig' 1, 'clig' 1, 'swsh' 1, 'salt' 1, 'calt' 1;
  user-select: none;
  animation: ovumBlackTextFade 5500ms ease-in-out forwards;
}
`
  document.head.appendChild(s)
}

function mountOvumBlack(phrase) {
  if (b_active) return
  if (typeof document === 'undefined') return
  ensureOvumBlackStyle()
  b_active = true
  b_container = document.createElement('div')
  document.body.appendChild(b_container)
  b_root = createRoot(b_container)
  b_root.render(
    <div className="ovum-black-veil" aria-hidden="true">
      <div className="ovum-black-text">{phrase}</div>
    </div>,
  )
  markEggFired('black')
  // Auto-dismiss after the keyframe completes.
  setTimeout(() => { try { unmountOvumBlack() } catch { /* nothing */ } }, 5550)
}

function unmountOvumBlack() {
  if (!b_active) return
  b_active = false
  try { b_root?.unmount() } catch { /* nothing */ }
  b_root = null
  if (b_container?.parentNode) {
    try { b_container.parentNode.removeChild(b_container) } catch { /* nothing */ }
  }
  b_container = null
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_teal
// ══════════════════════════════════════════════════════════════════════
//
// Listening mode activates while the trigger Item entity's origin
// node is the currently selected canvas node. Five keyboard notes
// (A, ↓, →, ←, ↑) play short procedural tones in a D-minor pentatonic
// scale. A rolling buffer is checked after each note against the song
// catalogue; on a match, the egg locks input, plays a discovery jingle,
// shows a title-card overlay, plays the melody as a sequenced Web Audio
// passage, and stamps the trigger entity with a learned-song attribute.
// After the main six songs are played in a session, Navi unlocks and
// follows the cursor.

// ── Note pitches (Hz) ─────────────────────────────────────────────────
// D-minor pentatonic, matching the in-game ocarina scale.
const TEAL_NOTE_HZ = {
  A:     587.33,   // D5  — A button
  down:  698.46,   // F5  — C-Down
  right: 880.00,   // A5  — C-Right
  left:  987.77,   // B5  — C-Left
  up:   1174.66,   // D6  — C-Up
}
// Render-friendly arrow glyph per note (used in the learned-song
// attribute value and any visual hints).
const TEAL_NOTE_GLYPH = {
  A: 'A', down: '↓', right: '→', left: '←', up: '↑',
}

// ── Songs ─────────────────────────────────────────────────────────────
// `seq` is the canonical note order; `main` marks the six story songs
// (the warp six don't gate Navi). `melody` is the playback sequence:
// `[noteName, durationMs]` tuples, transcribed by ear from the
// reference MIDIs in .References/. Rests are encoded as `[null, ms]`.
// `colour` is the song-name tint used in the title card overlay.
// `prefix` is the in-game pre-text shown before the song name:
//   - "You've learned" for songs with a possessive name (Zelda's, Saria's, etc.)
//   - "You've learned the" for "Song of X" entries
//   - "You have learned the" for the six warp songs
// `name`-styled title card matches the OoT-style overlay layout.
const TEAL_SONGS = [
  { id: 'zelda',    name: "Zelda's Lullaby",    colour: '#ff8db0', prefix: "You've learned",      main: true,  seq: ['left','up','right','left','up','right'],
    melody: [['left',520],['up',520],['right',1040],['left',520],['up',520],['right',1300]] },
  { id: 'epona',    name: "Epona's Song",       colour: '#ff8a3a', prefix: "You've learned",      main: true,  seq: ['up','left','right','up','left','right'],
    melody: [['up',420],['left',420],['right',840],['up',420],['left',420],['right',1050]] },
  { id: 'saria',    name: "Saria's Song",       colour: '#5bdc2c', prefix: "You've learned",      main: true,  seq: ['down','right','left','down','right','left'],
    melody: [['down',280],['right',280],['left',560],['down',280],['right',280],['left',840]] },
  { id: 'sun',      name: "Sun's Song",         colour: '#fff143', prefix: "You've learned",      main: true,  seq: ['right','down','up','right','down','up'],
    melody: [['right',520],['down',520],['up',1040],['right',520],['down',520],['up',1300]] },
  { id: 'time',     name: "Song of Time",       colour: '#74c0ff', prefix: "You've learned the",  main: true,  seq: ['right','A','down','right','A','down'],
    melody: [['right',520],['A',520],['down',1040],['right',520],['A',520],['down',1300]] },
  { id: 'storms',   name: "Song of Storms",     colour: '#d850c5', prefix: "You've learned the",  main: true,  seq: ['A','down','up','A','down','up'],
    melody: [['A',260],['down',260],['up',780],['A',260],['down',260],['up',980]] },
  { id: 'minuet',   name: "Minuet of Forest",   colour: '#0bd428', prefix: "You have learned the", main: false, seq: ['A','up','left','right','left','right'],
    melody: [['A',520],['up',520],['left',420],['right',420],['left',420],['right',1100]] },
  { id: 'bolero',   name: "Bolero of Fire",     colour: '#ff3838', prefix: "You have learned the", main: false, seq: ['down','A','down','A','right','down','right','down'],
    melody: [['down',300],['A',300],['down',300],['A',300],['right',300],['down',300],['right',300],['down',900]] },
  { id: 'serenade', name: "Serenade of Water",  colour: '#6ebfff', prefix: "You have learned the", main: false, seq: ['A','down','right','right','left'],
    melody: [['A',460],['down',460],['right',460],['right',460],['left',1380]] },
  { id: 'requiem',  name: "Requiem of Spirit",  colour: '#ffa72e', prefix: "You have learned the", main: false, seq: ['A','down','A','right','down','A'],
    melody: [['A',520],['down',520],['A',520],['right',520],['down',520],['A',1300]] },
  { id: 'nocturne', name: "Nocturne of Shadow", colour: '#c04ee4', prefix: "You have learned the", main: false, seq: ['left','right','right','A','left','right','down'],
    melody: [['left',420],['right',420],['right',420],['A',420],['left',420],['right',420],['down',1260]] },
  { id: 'prelude',  name: "Prelude of Light",   colour: '#ffe43b', prefix: "You have learned the", main: false, seq: ['up','right','up','right','left','up'],
    melody: [['up',500],['right',500],['up',500],['right',500],['left',500],['up',1300]] },
]
const TEAL_SONGS_BY_ID = Object.fromEntries(TEAL_SONGS.map((s) => [s.id, s]))
const TEAL_MAIN_SONG_COUNT = TEAL_SONGS.filter((s) => s.main).length
const TEAL_SCARECROW_NAME        = "Scarecrow's Song"
const TEAL_SCARECROW_PLACEHOLDER = '???'
const TEAL_SCARECROW_NOTE_COUNT  = 8     // exact length, matching the in-game spec
const TEAL_VALID_GLYPHS = new Set(['←', '→', '↑', '↓', 'A'])
const TEAL_GLYPH_TO_NOTE = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down', 'A': 'A' }

// Discovery jingle — shape transcribed from the reference MIDI
// `Samplab_The Legend of Zelda.mid`. Each note has its own START
// time (absolute, ms from jingle start) and SUSTAIN duration, so
// notes can overlap (every new note onsets ~128 ms apart while
// each note sustains ~256 ms — the legato that makes the phrase
// feel sung rather than punctuated).
const TEAL_JINGLE_SCHEDULE = [
  { freq:  783.99, startMs:   0, durMs: 256 },   // G5
  { freq:  739.99, startMs: 127, durMs: 256 },   // F#5
  { freq:  622.25, startMs: 255, durMs: 256 },   // D#5
  { freq:  440.00, startMs: 384, durMs: 256 },   // A4
  { freq:  415.30, startMs: 543, durMs: 256 },   // G#4
  { freq:  659.26, startMs: 671, durMs: 256 },   // E5
  { freq:  830.61, startMs: 800, durMs: 511 },   // G#5
  { freq: 1046.50, startMs: 927, durMs: 383 },   // C6 — held finale
]

// ── Trigger detection ────────────────────────────────────────────────
const TEAL_TRIGGER_NAMES = new Set(['ocarina', 'ocarina of time'])
const TEAL_NOTE_TIMEOUT_MS = 1800
const TEAL_TONE_MS = 280

function isOvumTealEntity(entity) {
  if (!entity || entity.type !== 'item') return false
  const nm = (entity.name || '').trim().toLowerCase()
  return TEAL_TRIGGER_NAMES.has(nm)
}

// ── Module state ─────────────────────────────────────────────────────
let g_teal_entityId       = null   // id of the matched Ocarina entity
let g_teal_nodeId         = null   // canvas EntityNode id for that entity
let g_teal_armed          = false  // listening mode active (node selected)
let g_teal_buffer         = []     // rolling note sequence
let g_teal_lastNoteAt     = 0
let g_teal_playing        = false  // payload lockout
let g_teal_suppressDetect = false  // self-trigger guard during attribute write
let g_teal_ctx            = null   // shared AudioContext
let g_teal_played         = new Set()   // song ids fully payloaded this session
let g_teal_keyHandler     = null
let g_teal_selUnsub       = null
let g_teal_pendingMatch   = null   // song waiting for tone-finish + keyup before firePayload
let g_teal_assets         = null   // null=unloaded, false=load failed, {} once loaded
let g_teal_styleInjected  = false

// ── Lazy asset loader (dynamic import; graceful no-op on absence) ────
async function ensureOvumTealAssets() {
  if (g_teal_assets !== null) return g_teal_assets || null
  try {
    const m = await import('./payrollAddendum.js')
    g_teal_assets = {
      naviIn:       m.OVUM_TEAL_NAVI_IN,
      naviOut:      m.OVUM_TEAL_NAVI_OUT,
      naviFloat:    m.OVUM_TEAL_NAVI_FLOAT,
      chestOpen:    m.OVUM_TEAL_CHEST_OPEN,
      secretJingle: m.OVUM_TEAL_SECRET_JINGLE,
    }
  } catch {
    g_teal_assets = false
  }
  return g_teal_assets || null
}

// ── AudioContext + tone synth ────────────────────────────────────────
function tealAudioCtx() {
  if (g_teal_ctx) return g_teal_ctx
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    g_teal_ctx = new Ctx()
  } catch { /* nothing */ }
  return g_teal_ctx
}

// Registry of fixed-duration tones (jingle + melody notes) so we can
// ramp them all to zero in an emergency. Unused in steady state.
let g_teal_activeTones = []
function registerActiveTone(entry) {
  g_teal_activeTones.push(entry)
  setTimeout(() => {
    g_teal_activeTones = g_teal_activeTones.filter((t) => t !== entry)
  }, entry.lifetimeMs)
}
// Held-tone registry — for user keypresses. The tone sustains for as
// long as the key is held, then fades on keyup. Map of noteName →
// active Web Audio nodes so we can release each independently.
const TEAL_HELD_RELEASE_MS = 180
let g_teal_heldTones = new Map()

function startInputTone(noteName) {
  if (g_teal_heldTones.has(noteName)) return       // already sounding
  // Monophonic — release any other tones still sustaining so a new
  // keypress cleanly replaces the previous note. Matches how a real
  // ocarina works (only one pitch at a time).
  if (g_teal_heldTones.size > 0) releaseAllHeldTones()
  const ctx = tealAudioCtx()
  if (!ctx) return
  const freq = TEAL_NOTE_HZ[noteName]
  if (!freq) return
  const t0 = ctx.currentTime

  const sine = ctx.createOscillator()
  sine.type = 'sine'
  sine.frequency.value = freq
  const tri = ctx.createOscillator()
  tri.type = 'triangle'
  tri.frequency.value = freq
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 5.5
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 10
  lfo.connect(lfoGain)
  lfoGain.connect(sine.detune)
  lfoGain.connect(tri.detune)

  const sineGain = ctx.createGain()
  sineGain.gain.value = 0.55
  const triGain = ctx.createGain()
  triGain.gain.value = 0.18

  // Attack → decay → hold at sustain (no release scheduled yet —
  // release fires on keyup via releaseInputTone).
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(0.9, t0 + 0.025)
  env.gain.linearRampToValueAtTime(0.65, t0 + 0.15)

  sine.connect(sineGain); sineGain.connect(env)
  tri.connect(triGain); triGain.connect(env)
  env.connect(ctx.destination)

  sine.start(t0); tri.start(t0); lfo.start(t0)

  g_teal_heldTones.set(noteName, { sine, tri, lfo, env })
}

function releaseInputTone(noteName) {
  const held = g_teal_heldTones.get(noteName)
  if (!held) return
  g_teal_heldTones.delete(noteName)
  const ctx = g_teal_ctx
  if (!ctx) return
  const now = ctx.currentTime
  const releaseSec = TEAL_HELD_RELEASE_MS / 1000
  try {
    held.env.gain.cancelScheduledValues(now)
    held.env.gain.setValueAtTime(0.65, now)
    held.env.gain.exponentialRampToValueAtTime(0.0001, now + releaseSec)
    const stopAt = now + releaseSec + 0.05
    held.sine.stop(stopAt)
    held.tri.stop(stopAt)
    held.lfo.stop(stopAt)
  } catch { /* nothing */ }
}

function releaseAllHeldTones() {
  for (const note of [...g_teal_heldTones.keys()]) releaseInputTone(note)
}

// Play a single ocarina-like tone: blended sine + triangle with a
// gentle vibrato LFO + ADSR envelope. `durationMs` controls the
// sustain length; the note tail decays past that.
// `noteOrFreq` may be a string note name (looked up in TEAL_NOTE_HZ
// for keyboard input) OR a number (raw Hz, used by the jingle which
// goes outside the 5-note ocarina scale).
// `source` is a short string tag used for diagnostic logging.
function playOcarinaTone(noteOrFreq, durationMs = TEAL_TONE_MS, source = 'unknown') {
  if (noteOrFreq == null) return Promise.resolve()
  const ctx = tealAudioCtx()
  if (!ctx) return Promise.resolve()
  const freq = typeof noteOrFreq === 'number' ? noteOrFreq : TEAL_NOTE_HZ[noteOrFreq]
  if (!freq) return Promise.resolve()
  const t0 = ctx.currentTime
  const sustainSec = durationMs / 1000
  const tailSec = 0.12

  // Two oscillators stacked: sine for body, triangle low-mix for warmth.
  const sine = ctx.createOscillator()
  sine.type = 'sine'
  sine.frequency.value = freq
  const tri = ctx.createOscillator()
  tri.type = 'triangle'
  tri.frequency.value = freq
  // Vibrato LFO on detune (±10 cents at ~5.5 Hz).
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 5.5
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 10
  lfo.connect(lfoGain)
  lfoGain.connect(sine.detune)
  lfoGain.connect(tri.detune)

  const sineGain = ctx.createGain()
  sineGain.gain.value = 0.55
  const triGain = ctx.createGain()
  triGain.gain.value = 0.18

  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(0.9, t0 + 0.025)
  env.gain.linearRampToValueAtTime(0.65, t0 + Math.min(0.15, sustainSec * 0.4))
  env.gain.setValueAtTime(0.65, t0 + Math.max(0.05, sustainSec - 0.05))
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + sustainSec + tailSec)

  sine.connect(sineGain); sineGain.connect(env)
  tri.connect(triGain);   triGain.connect(env)
  env.connect(ctx.destination)

  sine.start(t0); tri.start(t0); lfo.start(t0)
  const stopAt = t0 + sustainSec + tailSec + 0.02
  sine.stop(stopAt); tri.stop(stopAt); lfo.stop(stopAt)
  // Register so a payload-start can mute any in-flight tail.
  const lifetimeMs = Math.ceil((sustainSec + tailSec + 0.05) * 1000)
  registerActiveTone({ env, source, lifetimeMs })
  return new Promise((res) => setTimeout(res, durationMs))
}

// Play the "you discovered a secret" jingle. Schedules all 8 notes
// at their absolute MIDI-derived start times via setTimeout so they
// overlap naturally (each note sustains while the next attacks).
async function playSecretJingle() {
  for (const { freq, startMs, durMs } of TEAL_JINGLE_SCHEDULE) {
    setTimeout(() => { playOcarinaTone(freq, durMs, 'jingle') }, startMs)
  }
  // Wait for the last note to finish + its decay tail + a small safety
  // buffer before resolving so callers can rely on the jingle being
  // fully audible-out before proceeding.
  const last = TEAL_JINGLE_SCHEDULE[TEAL_JINGLE_SCHEDULE.length - 1]
  const totalMs = last.startMs + last.durMs + 180
  await new Promise((res) => setTimeout(res, totalMs))
}

// Sequence a list of [noteName, durationMs] tuples back to back.
// Notes WITHIN the sequence overlap by ~120 ms (the next attack
// begins while the previous tail decays) — that's the legato feel
// we want. The LAST note gets an extra 160 ms wait after its sustain
// so its tail fully decays before the sequence "ends" — keeps the
// jingle from ringing into the silence and being misheard as an
// extra stray note.
async function playMelodySequence(seq, source = 'melody') {
  for (let i = 0; i < seq.length; i++) {
    const [note, ms] = seq[i]
    const isLast = i === seq.length - 1
    if (note == null) {
      await new Promise((res) => setTimeout(res, ms))
    } else {
      await playOcarinaTone(note, ms, source)
      if (isLast) await new Promise((res) => setTimeout(res, 160))
    }
  }
}

// ── Keyboard listener ────────────────────────────────────────────────
function tealKeyToNote(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'a' || e.key === 'A') return 'A'
  if (e.key === 'ArrowDown')  return 'down'
  if (e.key === 'ArrowUp')    return 'up'
  if (e.key === 'ArrowLeft')  return 'left'
  if (e.key === 'ArrowRight') return 'right'
  return null
}

function isInsideTextInput(target) {
  if (!target || !target.closest) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  if (target.isContentEditable) return true
  if (target.closest('input, textarea, [contenteditable="true"], .ProseMirror')) return true
  return false
}

let g_teal_keyUpHandler = null

function ensureTealKeyHandler() {
  if (g_teal_keyHandler) return
  g_teal_keyHandler = (e) => {
    if (!g_teal_armed) return
    if (g_teal_playing) return                      // lockout — swallow silently
    if (g_teal_pendingMatch) return                 // a match is already waiting for keyup
    if (e.repeat) return                            // OS auto-repeat → no fresh tone
    if (isInsideTextInput(e.target)) return         // typing, not playing
    const note = tealKeyToNote(e)
    if (!note) return
    e.preventDefault()
    // Reset buffer on long gap between notes (matches in-game timing).
    const now = performance.now()
    if (now - g_teal_lastNoteAt > TEAL_NOTE_TIMEOUT_MS) g_teal_buffer = []
    g_teal_lastNoteAt = now
    g_teal_buffer.push(note)
    // Cap buffer to longest song length so it doesn't grow unbounded.
    if (g_teal_buffer.length > 12) g_teal_buffer.shift()
    // Held tone — sustains while the key is held, releases on keyup.
    startInputTone(note)
    // Match check: longest suffix wins so a 5-note suffix is preferred
    // over a 6-note partial-match etc.
    const match = matchTealSong()
    if (match) {
      g_teal_buffer = []
      deferPayloadUntilReady(match)
    }
  }
  g_teal_keyUpHandler = (e) => {
    const note = tealKeyToNote(e)
    if (!note) return
    if (g_teal_heldTones.has(note)) releaseInputTone(note)
  }
  window.addEventListener('keydown', g_teal_keyHandler, true)
  window.addEventListener('keyup', g_teal_keyUpHandler, true)
}

// After a song matches, defer the payload until all currently-held
// input tones have been released AND their release decays have
// completed. This way the chime can never step on the input audio.
// Blocks further input via g_teal_pendingMatch.
function deferPayloadUntilReady(song) {
  if (g_teal_pendingMatch) return
  g_teal_pendingMatch = song
  function fireNow() {
    if (!g_teal_pendingMatch) return
    const pending = g_teal_pendingMatch
    g_teal_pendingMatch = null
    firePayload(pending).catch(() => { /* never break input */ })
  }
  function poll() {
    if (g_teal_heldTones.size === 0) {
      // Wait the release-decay duration + a small buffer before firing.
      setTimeout(fireNow, TEAL_HELD_RELEASE_MS + 60)
      return
    }
    // Keys still held — keep polling.
    setTimeout(poll, 40)
  }
  poll()
}
function teardownTealKeyHandler() {
  if (!g_teal_keyHandler) return
  window.removeEventListener('keydown', g_teal_keyHandler, true)
  if (g_teal_keyUpHandler) {
    window.removeEventListener('keyup', g_teal_keyUpHandler, true)
    g_teal_keyUpHandler = null
  }
  releaseAllHeldTones()
  g_teal_keyHandler = null
}

function matchTealSong() {
  // Try suffixes from longest to shortest so longer melodies win
  // tiebreaks. Buffer cap covers the longest canonical song (8 notes,
  // Bolero of Fire / Scarecrow's Song) plus some slack.
  for (const len of [8, 7, 6, 5]) {
    if (g_teal_buffer.length < len) continue
    const suffix = g_teal_buffer.slice(-len)
    // Check the 13th song (Scarecrow's Song) FIRST at length 8 so a
    // user composition takes precedence over Bolero of Fire if their
    // composition somehow collides (validation rejects exact duplicates
    // of canonical songs, so this only matters as a safety order).
    if (len === TEAL_SCARECROW_NOTE_COUNT && g_teal_scarecrowSeq) {
      let ok = true
      for (let i = 0; i < len; i++) if (suffix[i] !== g_teal_scarecrowSeq[i]) { ok = false; break }
      if (ok) return { id: 'scarecrow', name: TEAL_SCARECROW_NAME, main: false, seq: g_teal_scarecrowSeq, isScarecrow: true }
    }
    for (const song of TEAL_SONGS) {
      if (song.seq.length !== len) continue
      let ok = true
      for (let i = 0; i < len; i++) if (suffix[i] !== song.seq[i]) { ok = false; break }
      if (ok) return song
    }
  }
  return null
}

// ── Payload sequence ─────────────────────────────────────────────────
async function firePayload(song) {
  if (g_teal_playing) return
  g_teal_playing = true
  const isReplay = g_teal_played.has(song.id)
  try {
    // Special case: Scarecrow's Song. First match fires the chest
    // cinematic. Replays just play the user's composition like any
    // other replay.
    if (song.isScarecrow) {
      if (!isReplay) {
        g_teal_played.add(song.id)
        markEggFired('teal')
        await playSecretJingle()
        await fireChestCinematic(song)
        return
      }
      // Replay: just play the composition as a melody. We don't have a
      // hand-authored rhythm for it; play each note at a comfortable
      // pace.
      const melody = song.seq.map((n) => [n, 360])
      await playMelodySequence(melody)
      return
    }

    // 1. Rising chime (skipped on replay — just plays the melody again).
    if (!isReplay) {
      await playSecretJingle()
      // Breath of silence after the jingle before the melody attacks.
      await new Promise((r) => setTimeout(r, 350))
    }
    // 2. Melody playback. Title card mounts ALONGSIDE the melody (not
    //    during the chime/silence transition) — if the user is hearing
    //    a stray note as the card fades in, this moves it onto the
    //    melody window where it'll be masked / easier to diagnose.
    if (!isReplay) {
      showTealTitleCard(song)
    }
    await playMelodySequence(song.melody)
    // 3. Stamp the learned-song attribute — non-blocking, fires AFTER
    //    the audio timeline so the entity update can never trigger a
    //    stray side-effect during the chime/melody window.
    if (!isReplay) {
      stampLearnedSong(song).catch(() => { /* nothing */ })
    }
    // 5. Tail pause before unlocking.
    await new Promise((r) => setTimeout(r, 200))
    g_teal_played.add(song.id)
    // 6. Mark nest slot active once the user has matched their first song.
    markEggFired('teal')
    // 7. Navi unlock / toggle — after the main six are first complete,
    //    Navi appears; subsequent matches toggle her on/off.
    maybeToggleNavi()
    // 8. Completion tier — if all 12 canonical songs are now played
    //    this session, stamp the Scarecrow's Song placeholder on the
    //    Ocarina entity (or re-stamp to '???' if missing). Fires once.
    await maybeStampScarecrowPlaceholder()
  } finally {
    g_teal_playing = false
  }
}

// Window-level capture-phase listener that intercepts arrow/A keys
// when focus is on an input marked `data-ovum-teal-scarecrow`. Set up
// once at module-load time. Acts as a backup in case the React
// onKeyDown doesn't fire (e.g. another listener swallows it earlier).
let g_teal_globalAttrListenerInstalled = false

function tealGlobalAttrKeydown(e) {
  const target = e.target
  if (!target || !target.dataset || !target.dataset.ovumTealScarecrow) return
  let glyph = null
  if (e.key === 'ArrowLeft')  glyph = '←'
  else if (e.key === 'ArrowRight') glyph = '→'
  else if (e.key === 'ArrowUp')    glyph = '↑'
  else if (e.key === 'ArrowDown')  glyph = '↓'
  else if (e.key === 'a' || e.key === 'A') glyph = 'A'
  if (!glyph) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault()
  e.stopPropagation()
  const cur = target.value || ''
  const isPlaceholder = cur === TEAL_SCARECROW_PLACEHOLDER
  let nextValue, nextCursor
  if (isPlaceholder) {
    nextValue = glyph
    nextCursor = glyph.length
  } else {
    const start = target.selectionStart ?? cur.length
    const end   = target.selectionEnd ?? cur.length
    nextValue = cur.slice(0, start) + glyph + cur.slice(end)
    nextCursor = start + glyph.length
  }
  // Drive React state via a native input event so React's onChange
  // handler picks it up and updates the draft.
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(target, nextValue)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  requestAnimationFrame(() => {
    try { target.setSelectionRange(nextCursor, nextCursor) } catch { /* nothing */ }
  })
}

function ensureTealGlobalAttrListener() {
  if (g_teal_globalAttrListenerInstalled) return
  if (typeof window === 'undefined') return
  g_teal_globalAttrListenerInstalled = true
  window.addEventListener('keydown', tealGlobalAttrKeydown, true)
}

// Install eagerly. Module init runs during entitiesStore import, but
// `window` is available in the browser at that point.
ensureTealGlobalAttrListener()

// Exported keydown handler for the attribute-value input. Called from
// the entity detail view's text-attribute input. Returns true if it
// handled the event (caller should consider it consumed); false to
// let default behaviour run. Only fires for the Ocarina entity's
// Scarecrow's Song attribute — every other input is left alone.
export function ovumTealHandleAttributeKeydown(opts) {
  if (!opts) return false
  const { entity, attributeName, event, value, onChange } = opts
  if (!event || !onChange) return false
  if (!isOvumTealEntity(entity)) return false
  if ((attributeName || '').trim().toLowerCase() !== TEAL_SCARECROW_NAME.toLowerCase()) return false
  let glyph = null
  if (event.key === 'ArrowLeft')  glyph = '←'
  else if (event.key === 'ArrowRight') glyph = '→'
  else if (event.key === 'ArrowUp')    glyph = '↑'
  else if (event.key === 'ArrowDown')  glyph = '↓'
  else if (event.key === 'a' || event.key === 'A') glyph = 'A'
  // Backspace / Delete inside the field should behave normally so the
  // user can correct mistakes.
  if (!glyph) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  event.preventDefault()
  event.stopPropagation()
  const input = event.target
  const cur = typeof value === 'string' ? value : ''
  // If the input still holds the placeholder, replace it wholesale
  // with the first glyph rather than appending to "???".
  const isPlaceholder = cur === TEAL_SCARECROW_PLACEHOLDER
  let nextValue
  let nextCursor
  if (isPlaceholder) {
    nextValue = glyph
    nextCursor = glyph.length
  } else {
    const start = input?.selectionStart ?? cur.length
    const end   = input?.selectionEnd ?? cur.length
    nextValue = cur.slice(0, start) + glyph + cur.slice(end)
    nextCursor = start + glyph.length
  }
  onChange(nextValue)
  if (input && typeof input.setSelectionRange === 'function') {
    requestAnimationFrame(() => {
      try { input.setSelectionRange(nextCursor, nextCursor) } catch { /* nothing */ }
    })
  }
  return true
}

// Parse a Scarecrow's Song attribute value into an array of note ids.
// Returns null if invalid (wrong chars, too short, too long, or
// duplicates one of the 12 canonical songs). Whitespace is ignored.
function parseScarecrowValue(rawValue) {
  if (typeof rawValue !== 'string') return null
  const stripped = rawValue.replace(/\s+/g, '')
  if (!stripped || stripped === TEAL_SCARECROW_PLACEHOLDER) return null
  if (stripped.length !== TEAL_SCARECROW_NOTE_COUNT) return null
  const notes = []
  for (const ch of stripped) {
    const upper = ch === 'a' ? 'A' : ch
    if (!TEAL_VALID_GLYPHS.has(upper)) return null
    notes.push(TEAL_GLYPH_TO_NOTE[upper])
  }
  // Reject if the composition exactly matches one of the canonical
  // 12 songs (in-game Scarecrow's Song can't duplicate an existing
  // melody either).
  for (const song of TEAL_SONGS) {
    if (song.seq.length !== notes.length) continue
    let same = true
    for (let i = 0; i < notes.length; i++) if (song.seq[i] !== notes[i]) { same = false; break }
    if (same) return null
  }
  return notes
}

let g_teal_scarecrowSeq = null   // user-defined note sequence, once validated

async function maybeStampScarecrowPlaceholder() {
  const allPlayed = TEAL_SONGS.every((s) => g_teal_played.has(s.id))
  if (!allPlayed) return
  const eid = g_teal_entityId
  if (!eid) return
  const ents = useEntitiesStore.getState()
  const entity = ents.getEntityById ? ents.getEntityById(eid) : null
  if (!entity) return
  const hasIt = (entity.attributes || []).some(
    (a) => (a?.name || '').trim().toLowerCase() === TEAL_SCARECROW_NAME.toLowerCase(),
  )
  if (hasIt) return   // already stamped (or user has already filled it in)
  const newAttr = {
    name: TEAL_SCARECROW_NAME,
    attribute_type: 'text',
    value: TEAL_SCARECROW_PLACEHOLDER,
  }
  g_teal_suppressDetect = true
  try {
    await ents.updateEntity(entity.id, {
      ...entity,
      attributes: [...(entity.attributes || []), newAttr],
    })
  } catch { /* nothing — egg must never break user data */ } finally {
    g_teal_suppressDetect = false
  }
}

async function stampLearnedSong(song) {
  const eid = g_teal_entityId
  if (!eid) return
  const ents = useEntitiesStore.getState()
  const entity = ents.getEntityById ? ents.getEntityById(eid) : null
  if (!entity) return
  const targetName = song.name.trim().toLowerCase()
  const hasIt = (entity.attributes || []).some(
    (a) => (a?.name || '').trim().toLowerCase() === targetName,
  )
  if (hasIt) return
  const newAttr = {
    name: song.name,
    attribute_type: 'text',
    value: song.seq.map((n) => TEAL_NOTE_GLYPH[n]).join(' '),
  }
  g_teal_suppressDetect = true
  try {
    await ents.updateEntity(entity.id, {
      ...entity,
      attributes: [...(entity.attributes || []), newAttr],
    })
  } catch { /* nothing — egg must never break user data */ } finally {
    g_teal_suppressDetect = false
  }
}

// ── Title card ────────────────────────────────────────────────────────
function ensureTealStyle() {
  if (g_teal_styleInjected || typeof document === 'undefined') return
  g_teal_styleInjected = true
  const s = document.createElement('style')
  s.textContent = `
@keyframes ovumTealCardFade {
  0%   { opacity: 0; transform: translateY(12px); }
  14%  { opacity: 1; transform: translateY(0); }
  86%  { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-8px); }
}
.ovum-teal-card-veil {
  position: fixed; left: 0; right: 0; bottom: 18%;
  pointer-events: none;
  z-index: 99997;
  display: flex; justify-content: center;
  animation: ovumTealCardFade 2400ms ease-in-out forwards;
}
.ovum-teal-card-box {
  background: linear-gradient(180deg, rgba(34, 58, 118, 0.5) 0%, rgba(16, 28, 78, 0.52) 100%);
  border: 1.5px solid rgba(190, 210, 245, 0.45);
  border-radius: 16px;
  padding: 32px 72px;
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.22);
  font-family: 'Bookman Old Style', 'Cambria', 'Georgia', 'Trebuchet MS', serif;
  font-weight: 700;
  font-size: clamp(28px, 3.2vw, 42px);
  color: #ffffff;
  text-shadow:
    -1.5px -1.5px 0 rgba(0, 0, 0, 0.9),
    1.5px -1.5px 0 rgba(0, 0, 0, 0.9),
    -1.5px  1.5px 0 rgba(0, 0, 0, 0.9),
    1.5px  1.5px 0 rgba(0, 0, 0, 0.9),
    0 3px 8px rgba(0, 0, 0, 0.75);
  letter-spacing: 0.012em;
  white-space: nowrap;
  user-select: none;
  backdrop-filter: blur(2px);
}
.ovum-teal-card-songname {
  /* colour set inline per song */
  font-weight: 700;
}
.ovum-teal-card-bang {
  color: #ffffff;
}

/* ── Chest cinematic + Triforce / Hero of Time congratulations ─────── */
/* Drop uses transform: translateY() instead of top so a later
   animation-list change (when the .clicked or .opened class lands)
   doesn't snap the chest back to its base position. The chest's
   resting top is set explicitly in the base rule. */
@keyframes ovumTealChestDrop {
  0%   { transform: translateY(-100vh); }
  60%  { transform: translateY(0);     animation-timing-function: ease-out; }
  72%  { transform: translateY(20px);  animation-timing-function: ease-in; }
  82%  { transform: translateY(5px);   animation-timing-function: ease-out; }
  90%  { transform: translateY(14px);  animation-timing-function: ease-in; }
  100% { transform: translateY(0); }
}
@keyframes ovumTealChestGlow {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(255, 220, 80, 0.85)) drop-shadow(0 0 14px rgba(255, 215, 60, 0.55)); }
  50%      { filter: drop-shadow(0 0 14px rgba(255, 235, 110, 1)) drop-shadow(0 0 28px rgba(255, 215, 60, 0.85)); }
}
.ovum-teal-chest-veil {
  position: fixed; inset: 0;
  background: rgba(0, 8, 20, 0.45);
  z-index: 99998;
  pointer-events: auto;
  animation: ovumTealVeilIn 600ms ease-out forwards;
}
@keyframes ovumTealVeilIn {
  0%   { opacity: 0; }
  100% { opacity: 1; }
}
.ovum-teal-chest {
  position: absolute;
  left: 50%;
  top: calc(50vh - 70px);     /* resting position; drop animates via transform */
  width: 160px; height: 140px;
  margin-left: -80px;
  animation: ovumTealChestDrop 1700ms cubic-bezier(0.4, 0, 0.6, 1) forwards,
             ovumTealChestGlow 1500ms ease-in-out infinite 1700ms;
  cursor: pointer;
  pointer-events: auto;
}
.ovum-teal-chest.clicked {
  /* Lock further clicks but keep glow going. Chest stays in place. */
  cursor: default;
  animation: ovumTealChestGlow 1500ms ease-in-out infinite;
}
.ovum-teal-chest.opened {
  /* Lid rotates open via the .ovum-teal-chest-lid rule below. */
  cursor: default;
  animation: ovumTealChestGlow 1500ms ease-in-out infinite;
}
.ovum-teal-chest-lid {
  transform-box: view-box;
  transform-origin: 32px 36px;     /* bottom of lid — hinge edge */
  transition: transform 700ms cubic-bezier(0.34, 1.4, 0.64, 1);
}
/* Compress the lid vertically (reads as tilting backward in 2D) and
   shift it up off the body. Bottom-edge transform-origin makes the
   bottom of the lid stay glued to the hinge while the top swings up
   and disappears toward the back. */
.ovum-teal-chest.opened .ovum-teal-chest-lid {
  transform: translateY(-12px) scaleY(0.32);
}

/* Item-get glow — a soft yellow orb rising from inside the chest
   once the lid opens, evoking the classic "item received" beat. */
.ovum-teal-chest-item {
  opacity: 0;
  transform-box: view-box;
  transform-origin: 32px 28px;
  transform: translateY(8px) scale(0.5);
  transition: opacity 600ms ease-out 350ms,
              transform 900ms cubic-bezier(0.34, 1.6, 0.64, 1) 350ms;
}
.ovum-teal-chest.opened .ovum-teal-chest-item {
  opacity: 1;
  transform: translateY(-4px) scale(1);
}
@keyframes ovumTealChestItemPulse {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(255, 235, 110, 0.9)) drop-shadow(0 0 14px rgba(255, 200, 50, 0.7)); }
  50%      { filter: drop-shadow(0 0 14px rgba(255, 245, 150, 1)) drop-shadow(0 0 28px rgba(255, 215, 60, 0.95)); }
}
.ovum-teal-chest.opened .ovum-teal-chest-item {
  animation: ovumTealChestItemPulse 1400ms ease-in-out infinite 950ms;
}

/* ── Triforce + Hero of Time overlay ───────────────────────────────── */
.ovum-teal-triforce-veil {
  position: fixed; inset: 0;
  background: radial-gradient(circle at 50% 50%, rgba(255, 215, 60, 0.35) 0%, rgba(0, 8, 20, 0.85) 60%, rgba(0, 0, 0, 0.95) 100%);
  z-index: 99999;
  pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  animation: ovumTealTriforceFade 7000ms ease-in-out forwards;
}
@keyframes ovumTealTriforceFade {
  0%   { opacity: 0; }
  10%  { opacity: 1; }
  85%  { opacity: 1; }
  100% { opacity: 0; }
}
.ovum-teal-triforce-svg {
  width: clamp(180px, 26vw, 360px);
  height: auto;
  filter: drop-shadow(0 0 24px rgba(255, 235, 100, 0.85)) drop-shadow(0 0 60px rgba(255, 200, 50, 0.5));
  animation: ovumTealTriforceShimmer 2400ms ease-in-out infinite;
}
@keyframes ovumTealTriforceShimmer {
  0%, 100% { filter: drop-shadow(0 0 20px rgba(255, 235, 100, 0.7)) drop-shadow(0 0 50px rgba(255, 200, 50, 0.4)); }
  50%      { filter: drop-shadow(0 0 32px rgba(255, 245, 130, 1))    drop-shadow(0 0 80px rgba(255, 215, 60, 0.7)); }
}
.ovum-teal-triforce-text {
  margin-top: 24px;
  font-family: 'Snell Roundhand', 'Apple Chancery', 'Edwardian Script ITC',
               'Palace Script MT', 'Vivaldi', 'Monotype Corsiva',
               'Lucida Handwriting', cursive;
  font-size: clamp(40px, 5.5vw, 72px);
  color: #fdf3c9;
  text-shadow: 0 4px 24px rgba(120, 80, 0, 0.85), 0 0 2px rgba(255, 230, 130, 0.8);
  letter-spacing: 0.04em;
  user-select: none;
  text-align: center;
}
.ovum-teal-triforce-sub {
  margin-top: 12px;
  font-family: 'Trebuchet MS', sans-serif;
  font-size: clamp(13px, 1.4vw, 18px);
  font-style: italic;
  color: #fdf3c9;
  opacity: 0.85;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
}

/* ── Navi sprite — cursor follower, speech bubble, animations ──────── */
.ovum-teal-navi-container {
  position: fixed; top: 0; left: 0;
  pointer-events: none;
  z-index: 99999;
  width: 0; height: 0;
  will-change: transform;
}
.ovum-teal-navi {
  position: absolute;
  width: 56px; height: 56px;
  transform: translate(-28px, -28px);
  overflow: visible;
}
.ovum-teal-navi .navi-body,
.ovum-teal-navi .navi-wing,
.ovum-teal-navi .navi-halo,
.ovum-teal-navi .navi-core,
.ovum-teal-navi .navi-glit {
  transform-box: view-box;
  transform-origin: 94px 141px;
}
.ovum-teal-navi .navi-glit { transform-origin: center; }
.ovum-teal-navi .navi-body { animation: naviBob 2.8s ease-in-out infinite; }
.ovum-teal-navi .navi-halo { animation: naviHaloPulse 1.6s ease-in-out infinite; }
.ovum-teal-navi .navi-core { animation: naviCorePulse 1.05s ease-in-out infinite; }
.ovum-teal-navi .navi-wing-upper-l,
.ovum-teal-navi .navi-wing-upper-r { animation: naviFlapUpper 0.34s ease-in-out infinite alternate; }
.ovum-teal-navi .navi-wing-lower-l,
.ovum-teal-navi .navi-wing-lower-r { animation: naviFlapLower 0.42s ease-in-out infinite alternate; }
.ovum-teal-navi .navi-wing-upper-r,
.ovum-teal-navi .navi-wing-lower-r { animation-direction: alternate-reverse; }
.ovum-teal-navi .navi-glit { animation: naviGlit 1.6s ease-in-out infinite; }
.ovum-teal-navi .navi-glit-1 { animation-delay: 0.00s; }
.ovum-teal-navi .navi-glit-2 { animation-delay: 0.25s; }
.ovum-teal-navi .navi-glit-3 { animation-delay: 0.50s; }
.ovum-teal-navi .navi-glit-4 { animation-delay: 0.75s; }
.ovum-teal-navi .navi-glit-5 { animation-delay: 1.00s; }

@keyframes naviBob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3px); }
}
@keyframes naviHaloPulse {
  0%, 100% { opacity: 0.88; transform: scale(1); }
  50%      { opacity: 1.0;  transform: scale(1.06); }
}
@keyframes naviCorePulse {
  0%, 100% { opacity: 0.92; transform: scale(1); }
  50%      { opacity: 1.0;  transform: scale(1.06); }
}
@keyframes naviFlapUpper {
  0%   { transform: rotate(-3deg); }
  100% { transform: rotate(8deg); }
}
@keyframes naviFlapLower {
  0%   { transform: rotate(-5deg); }
  100% { transform: rotate(10deg); }
}
@keyframes naviGlit {
  0%, 100% { opacity: 0.25; transform: scale(0.85); }
  50%      { opacity: 1.0;  transform: scale(1.1); }
}

.ovum-teal-bubble {
  position: absolute;
  left: 28px; top: -8px;
  transform: translate(0, -100%);
  background: rgba(253, 250, 240, 0.96);
  color: #1a1a2e;
  border: 1.5px solid #2999f3;
  border-radius: 12px;
  padding: 5px 11px 5px 12px;
  font-family: 'Trebuchet MS', 'Lucida Sans', sans-serif;
  font-size: 13px;
  font-weight: 700;
  font-style: italic;
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 30, 60, 0.35);
  animation: ovumTealBubble 2000ms ease-in-out forwards;
  pointer-events: none;
}
.ovum-teal-bubble::after {
  content: '';
  position: absolute;
  left: 10px; bottom: -8px;
  width: 0; height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 8px solid #2999f3;
}
.ovum-teal-bubble::before {
  content: '';
  position: absolute;
  left: 11px; bottom: -5px;
  width: 0; height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid rgba(253, 250, 240, 0.96);
  z-index: 1;
}
@keyframes ovumTealBubble {
  0%   { opacity: 0; transform: translate(0, -100%) scale(0.85); }
  15%  { opacity: 1; transform: translate(0, -100%) scale(1.02); }
  20%  { opacity: 1; transform: translate(0, -100%) scale(1); }
  85%  { opacity: 1; transform: translate(0, -100%) scale(1); }
  100% { opacity: 0; transform: translate(0, -100%) scale(0.95); }
}
`
  document.head.appendChild(s)
}

function showTealTitleCard(song) {
  ensureTealStyle()
  if (typeof document === 'undefined') return
  const prefix = song?.prefix || "You've learned"
  const name = song?.name || ''
  const colour = song?.colour || '#ffffff'
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <div className="ovum-teal-card-veil" aria-hidden="true">
      <div className="ovum-teal-card-box">
        {prefix}
        {' '}
        <span className="ovum-teal-card-songname" style={{ color: colour }}>{name}</span>
        <span className="ovum-teal-card-bang">!</span>
      </div>
    </div>,
  )
  setTimeout(() => {
    try { root.unmount() } catch { /* nothing */ }
    if (host.parentNode) host.parentNode.removeChild(host)
  }, 2450)
}

// ── Navi follower (post-unlock) ──────────────────────────────────────
let g_teal_naviRoot      = null
let g_teal_naviHost      = null
let g_teal_naviUnlocked  = false   // session-level: Navi has been summoned once

const NAVI_BUBBLE_PHRASES = ['Hey!', 'Listen!', 'Hey! Listen!', 'Hello!', 'Look!', 'Watch out!']

// After this many ms of mouse inactivity Navi enters "autonomous"
// mode — drifts around the viewport on her own and pops bubbles more
// often. Mouse movement instantly returns her to follow-mode.
const NAVI_IDLE_THRESHOLD_MS = 10000
// How often Navi picks a fresh random wander target in autonomous
// mode.
const NAVI_AUTONOMOUS_RETARGET_MS = 2400

function OvumTealNaviSprite({ onDismiss, assets }) {
  const [bubble, setBubble] = useState(null)
  const containerRef = useRef(null)
  const posRef = useRef({ x: 0, y: 0 })
  const targetRef = useRef({ x: 0, y: 0 })
  const lastMoveAtRef = useRef(0)
  const lastRetargetAtRef = useRef(0)
  const autonomousRef = useRef(false)
  // Active curving wander path — quadratic Bezier from p0 → p2 with
  // p1 as the control point that bends the trajectory. `durationMs`
  // is how long the path takes; `dwellMs` is how long Navi hovers at
  // the endpoint before picking the next path. Recreated whenever
  // dwell expires.
  const wanderPathRef = useRef(null)
  const floatAudioRef = useRef(null)

  useEffect(() => {
    // Start in a sensible spot — centre of the viewport — and let the
    // mouse-lerp catch up to the cursor as it moves.
    const start = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    posRef.current = { ...start }
    targetRef.current = { ...start }
    lastMoveAtRef.current = performance.now()

    const onMouseMove = (e) => {
      targetRef.current = { x: e.clientX, y: e.clientY }
      lastMoveAtRef.current = performance.now()
      autonomousRef.current = false
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })

    function pickWanderTarget() {
      // Keep some breathing room from the edges so Navi never gets
      // clipped offscreen.
      const margin = 100
      const w = Math.max(window.innerWidth - margin * 2, 200)
      const h = Math.max(window.innerHeight - margin * 2, 200)
      return {
        x: margin + Math.random() * w,
        y: margin + Math.random() * h,
      }
    }

    // Pick a wander target in a small ring around Clippy so Navi
    // appears to orbit him while he panics. `clippyRect` is the
    // bounding rect of the silver host.
    function pickClippyOrbitTarget(clippyRect) {
      const cx = clippyRect.left + clippyRect.width / 2
      const cy = clippyRect.top + clippyRect.height / 2
      const angle = Math.random() * Math.PI * 2
      const radius = 55 + Math.random() * 35   // 55–90 px from Clippy's centre
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      }
    }

    // Build a curving wander path from a starting point. p1 (the
    // Bezier control point) is offset perpendicular to the straight
    // start→end line by a random amount, which bends the trajectory
    // either side. Durations and dwells are independently randomised
    // so the rhythm doesn't repeat.
    function newWanderPath(fromX, fromY) {
      const end = pickWanderTarget()
      const midX = (fromX + end.x) / 2
      const midY = (fromY + end.y) / 2
      const dx = end.x - fromX
      const dy = end.y - fromY
      const perpX = -dy
      const perpY = dx
      const perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1
      // ±0–140 px perpendicular offset; sign random so paths curve
      // either left or right of the straight line.
      const curveAmount = (Math.random() - 0.5) * 280
      const p1 = {
        x: midX + (perpX / perpLen) * curveAmount,
        y: midY + (perpY / perpLen) * curveAmount,
      }
      return {
        p0: { x: fromX, y: fromY },
        p1,
        p2: { x: end.x, y: end.y },
        startT: performance.now(),
        durationMs: 1600 + Math.random() * 2800,   // 1.6 – 4.4 s of motion
        dwellMs:    250  + Math.random() * 2400,   // 0.25 – 2.65 s pause at end
      }
    }
    function bezier2(t, p0, p1, p2) {
      const u = 1 - t
      return {
        x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
        y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
      }
    }
    function easeInOutSine(t) {
      return -(Math.cos(Math.PI * t) - 1) / 2
    }

    let raf = 0
    const tick = () => {
      const now = performance.now()
      const clippyEl = silverIsMounted() ? document.querySelector('.ovum-silver-host') : null
      const clippyRect = clippyEl ? clippyEl.getBoundingClientRect() : null
      const clippyMode = !!clippyRect

      const idleMs = now - lastMoveAtRef.current
      const goingAutonomous = !clippyMode && idleMs > NAVI_IDLE_THRESHOLD_MS

      const p = posRef.current

      if (clippyMode) {
        // Clippy on screen → orbit him. Simple lerp toward retargeted
        // ring positions; no need for curved paths since orbital wander
        // already reads as lively.
        if (!autonomousRef.current
            || now - lastRetargetAtRef.current > 1500) {
          targetRef.current = pickClippyOrbitTarget(clippyRect)
          lastRetargetAtRef.current = now
        }
        autonomousRef.current = true
        wanderPathRef.current = null     // discard any in-progress wander path
        const ease = 0.06
        const t = targetRef.current
        p.x += (t.x - p.x) * ease
        p.y += (t.y - p.y) * ease
      } else if (goingAutonomous) {
        // Autonomous wander — curving Bezier paths with varied dwells.
        autonomousRef.current = true
        let path = wanderPathRef.current
        if (!path) {
          path = newWanderPath(p.x, p.y)
          wanderPathRef.current = path
        }
        const elapsed = now - path.startT
        if (elapsed < path.durationMs) {
          // Traversing the curve.
          const rawT = elapsed / path.durationMs
          const t = easeInOutSine(rawT)
          const pos = bezier2(t, path.p0, path.p1, path.p2)
          p.x = pos.x
          p.y = pos.y
        } else if (elapsed < path.durationMs + path.dwellMs) {
          // Hovering at the end point with a tiny figure-8 wobble so
          // Navi doesn't look pinned in place during the pause.
          const dwellT = (elapsed - path.durationMs) / 1000
          const wobbleX = Math.sin(dwellT * 1.6) * 3.5
          const wobbleY = Math.cos(dwellT * 1.1) * 2.5
          p.x = path.p2.x + wobbleX
          p.y = path.p2.y + wobbleY
        } else {
          // Dwell expired → pick a fresh curving path from here.
          wanderPathRef.current = newWanderPath(path.p2.x, path.p2.y)
        }
      } else {
        // Cursor-follow mode — soft lerp toward the cursor target.
        autonomousRef.current = false
        wanderPathRef.current = null
        const ease = 0.085
        const t = targetRef.current
        p.x += (t.x - p.x) * ease
        p.y += (t.y - p.y) * ease
      }

      // In follow-mode offset slightly above-right of the cursor so
      // Navi doesn't sit exactly on top of it. In any autonomous /
      // orbit / wander state, centre on the current position.
      const dx = autonomousRef.current ? p.x : p.x + 16
      const dy = autonomousRef.current ? p.y : p.y - 28
      if (containerRef.current) {
        containerRef.current.style.transform = `translate(${dx}px, ${dy}px)`
      }

      // Flip Clippy's panic flag based on proximity. Hysteresis-free
      // since setSilverPanic short-circuits when the value doesn't
      // change.
      if (clippyMode) {
        const cx = clippyRect.left + clippyRect.width / 2
        const cy = clippyRect.top + clippyRect.height / 2
        const dx2 = p.x - cx
        const dy2 = p.y - cy
        const dist = Math.sqrt(dx2 * dx2 + dy2 * dy2)
        setSilverPanic(dist < 200)
      } else {
        setSilverPanic(false)
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Speech bubble — cadence shortens dramatically in autonomous mode
    // so Navi nags the user back to the screen.
    let bubbleTimer = null
    let bubbleClearTimer = null
    function fireBubble(forcedPhrase) {
      const phrase = forcedPhrase
        || NAVI_BUBBLE_PHRASES[Math.floor(Math.random() * NAVI_BUBBLE_PHRASES.length)]
      setBubble(phrase)
      if (assets?.naviFloat) {
        try {
          if (floatAudioRef.current) {
            try { floatAudioRef.current.pause() } catch { /* nothing */ }
          }
          const a = new Audio(assets.naviFloat)
          a.volume = 0.55
          floatAudioRef.current = a
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(() => { /* blocked */ })
        } catch { /* nothing */ }
      }
      bubbleClearTimer = setTimeout(() => setBubble(null), 1900)
    }
    function scheduleNext() {
      const delay = autonomousRef.current
        ? 3500 + Math.random() * 4500    // 3.5 – 8 s when idle
        : 25000 + Math.random() * 20000  // 25 – 45 s when following
      bubbleTimer = setTimeout(() => {
        // In autonomous mode lean toward the iconic line.
        const phrase = autonomousRef.current && Math.random() < 0.55
          ? 'Hey! Listen!'
          : null
        fireBubble(phrase)
        scheduleNext()
      }, delay)
    }
    // First bubble fires sooner so the user notices Navi has stuff to say.
    bubbleTimer = setTimeout(() => {
      fireBubble('Hey! Listen!')
      scheduleNext()
    }, 4500)

    // Esc dismisses.
    const onKey = (e) => {
      if (e.key === 'Escape') onDismiss?.()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('mousemove', onMouseMove, { passive: true })
      window.removeEventListener('keydown', onKey)
      if (bubbleTimer) clearTimeout(bubbleTimer)
      if (bubbleClearTimer) clearTimeout(bubbleClearTimer)
      cancelAnimationFrame(raf)
      if (floatAudioRef.current) {
        try { floatAudioRef.current.pause() } catch { /* nothing */ }
        floatAudioRef.current = null
      }
      // Clear any panic state we set on Clippy so he settles back to
      // normal banter when Navi leaves.
      setSilverPanic(false)
    }
  }, [onDismiss, assets])

  return (
    <div ref={containerRef} className="ovum-teal-navi-container">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="20 40 175 175"
        className="ovum-teal-navi"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="navi-halo-grad">
            <stop offset="0%"  stopColor="#2999f3" stopOpacity="0.90" />
            <stop offset="22%" stopColor="#2be8da" stopOpacity="0.78" />
            <stop offset="55%" stopColor="#2be8da" stopOpacity="0.30" />
            <stop offset="100%" stopColor="#2be8da" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="navi-core-grad">
            <stop offset="0%"  stopColor="#ffffff" stopOpacity="1" />
            <stop offset="45%" stopColor="#ddfdf8" stopOpacity="0.95" />
            <stop offset="80%" stopColor="#2be8da" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#2be8da" stopOpacity="0" />
          </radialGradient>
          <linearGradient
            id="navi-wing-grad"
            gradientUnits="objectBoundingBox"
            x1="0" y1="0" x2="0" y2="1"
          >
            <stop offset="0" stopColor="#dff1f1" stopOpacity="0.85" />
            <stop offset="1" stopColor="#b2d3d4" stopOpacity="0.65" />
          </linearGradient>
          <radialGradient id="navi-glitter-grad">
            <stop offset="20%"  stopColor="#ffffff" />
            <stop offset="40%"  stopColor="#3beae0" />
            <stop offset="65%"  stopColor="#2999f3" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#ddfdf8" stopOpacity="0" />
          </radialGradient>
          <filter id="navi-bloom" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.0" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="navi-body-mask-grad">
            <stop offset="0"    stopColor="black" />
            <stop offset="0.42" stopColor="black" />
            <stop offset="1"    stopColor="white" />
          </radialGradient>
          <mask id="navi-body-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="210" height="297">
            <rect x="0" y="0" width="210" height="297" fill="white" />
            <circle cx="94" cy="141" r="28" fill="url(#navi-body-mask-grad)" />
          </mask>
        </defs>

        <g className="navi-glitter-trail">
          <circle className="navi-glit navi-glit-5" cx="134.53" cy="198.14" r="2.33" fill="url(#navi-glitter-grad)" />
          <circle className="navi-glit navi-glit-4" cx="114.43" cy="200.82" r="3.98" fill="url(#navi-glitter-grad)" />
          <circle className="navi-glit navi-glit-3" cx="100.62" cy="190.47" r="2.09" fill="url(#navi-glitter-grad)" />
          <circle className="navi-glit navi-glit-2" cx="90.06"  cy="191.04" r="1.78" fill="url(#navi-glitter-grad)" />
          <circle className="navi-glit navi-glit-1" cx="77.96"  cy="182.44" r="4.78" fill="url(#navi-glitter-grad)" />
        </g>

        <g className="navi-wings-lower" mask="url(#navi-body-mask)">
          <g className="navi-wing navi-wing-lower-l">
            <path
              d="m 74.94,148.81 c 0.47,-0.80 -20.20,-2.87 -20.66,1.67 -1.12,11.23 16.08,19.41 17.99,17.09 4.97,-6.04 3.97,-17.23 3.97,-17.23"
              fill="url(#navi-wing-grad)"
              stroke="#9bb6b3" strokeWidth="0.6"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </g>
          <g className="navi-wing navi-wing-lower-r">
            <path
              d="m 110.39,156.73 c -0.20,-0.89 18.62,2.16 17.81,6.65 -2.00,11.11 -19.38,14.80 -20.45,12.10 -2.78,-7.04 1.09,-17.59 1.09,-17.59"
              fill="url(#navi-wing-grad)"
              stroke="#9bb6b3" strokeWidth="0.57"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </g>
        </g>

        <g className="navi-wings-upper" mask="url(#navi-body-mask)">
          <g className="navi-wing navi-wing-upper-r">
            <path
              d="m 112.46,131.45 c 15.63,-10.39 30.80,-22.16 46.96,-30.93 -2.13,0.53 18.33,-10.25 22.46,-10.90 2.65,-0.42 4.02,-0.62 4.14,0.28 0.11,0.91 0.99,1.00 -1.13,4.53 -1.52,2.53 -30.58,38.35 -39.04,41.20 -8.12,2.73 -32.98,0.17 -32.98,0.17 z"
              fill="url(#navi-wing-grad)"
              stroke="#9bb6b3" strokeWidth="0.6"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </g>
          <g className="navi-wing navi-wing-upper-l">
            <path
              d="M 82.13,122.28 C 71.96,104.70 62.79,85.58 51.46,69.81 53.21,71.13 38.73,51.56 35.18,49.48 c -2.27,-1.33 -3.46,-2.01 -3.94,-0.94 -0.48,1.07 -1.32,0.91 -0.82,5.90 0.36,3.56 12.48,56.45 19.13,62.56 6.38,5.86 30.42,10.47 30.42,10.47 z"
              fill="url(#navi-wing-grad)"
              stroke="#9bb6b3" strokeWidth="0.67"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </g>
        </g>

        <g className="navi-body" filter="url(#navi-bloom)">
          <circle className="navi-halo" cx="93.92" cy="140.86" r="38" fill="url(#navi-halo-grad)" />
          <circle className="navi-core" cx="93.94" cy="140.77" r="15" fill="url(#navi-core-grad)" />
        </g>
      </svg>

      {bubble && <div className="ovum-teal-bubble">{bubble}</div>}
    </div>
  )
}

async function mountOvumTealNavi() {
  if (g_teal_naviRoot) return
  if (typeof document === 'undefined') return
  ensureTealStyle()
  const assets = await ensureOvumTealAssets()
  // Play the "appear" SFX at mount — runs inside the user's gesture
  // chain (entering the final note of the sixth song) so autoplay is
  // unlocked.
  if (assets?.naviIn) {
    try {
      const a = new Audio(assets.naviIn)
      a.volume = 0.75
      const p = a.play()
      if (p && typeof p.catch === 'function') p.catch(() => { /* nothing */ })
    } catch { /* nothing */ }
  }
  g_teal_naviHost = document.createElement('div')
  document.body.appendChild(g_teal_naviHost)
  g_teal_naviRoot = createRoot(g_teal_naviHost)
  g_teal_naviRoot.render(
    <OvumTealNaviSprite onDismiss={unmountOvumTealNavi} assets={assets || {}} />,
  )
}

function unmountOvumTealNavi() {
  if (!g_teal_naviRoot) return
  // Play the leave SFX synchronously before tearing down so it actually
  // gets through.
  const assets = g_teal_assets && g_teal_assets !== false ? g_teal_assets : null
  if (assets?.naviOut) {
    try {
      const a = new Audio(assets.naviOut)
      a.volume = 0.75
      const p = a.play()
      if (p && typeof p.catch === 'function') p.catch(() => { /* nothing */ })
    } catch { /* nothing */ }
  }
  try { g_teal_naviRoot.unmount() } catch { /* nothing */ }
  g_teal_naviRoot = null
  if (g_teal_naviHost?.parentNode) {
    try { g_teal_naviHost.parentNode.removeChild(g_teal_naviHost) } catch { /* nothing */ }
  }
  g_teal_naviHost = null
}

// Called at the end of every song payload.
// Behaviour:
//   - First time all main-six songs have been played this session →
//     mount Navi (the one-shot "unlock" moment).
//   - After that initial unlock, every subsequent song match toggles
//     Navi's visibility — match a song, she vanishes; match another,
//     she reappears.
// ── Chest cinematic ──────────────────────────────────────────────────
// Procedural "thunk" — quick percussive impact via Web Audio.
function playChestThunk() {
  const ctx = tealAudioCtx()
  if (!ctx) return
  const t0 = ctx.currentTime
  // Low-frequency body thump (sine).
  const sine = ctx.createOscillator()
  sine.type = 'sine'
  sine.frequency.setValueAtTime(120, t0)
  sine.frequency.exponentialRampToValueAtTime(48, t0 + 0.18)
  const sineGain = ctx.createGain()
  sineGain.gain.setValueAtTime(0.55, t0)
  sineGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22)
  sine.connect(sineGain); sineGain.connect(ctx.destination)
  // Brief white-noise click for the wood-on-floor texture.
  const dur = 0.06
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.5)
  const noise = ctx.createBufferSource()
  noise.buffer = buf
  const noiseGain = ctx.createGain()
  noiseGain.gain.setValueAtTime(0.35, t0)
  noise.connect(noiseGain); noiseGain.connect(ctx.destination)
  sine.start(t0); sine.stop(t0 + 0.25)
  noise.start(t0); noise.stop(t0 + dur + 0.01)
}

// Delay between the click and the lid actually opening — matches a
// musical cue in the bundled chest-open mp3.
const CHEST_LID_OPEN_DELAY_MS = 7000

function OvumTealChest({ assets, onComplete }) {
  const [clicked, setClicked] = useState(false)
  const [opened, setOpened] = useState(false)
  const [done, setDone] = useState(false)
  const audioRef = useRef(null)
  const lidTimerRef = useRef(null)
  const doneTimerRef = useRef(null)

  // Schedule a thunk shortly after the drop animation's bounce — the
  // CSS keyframe starts at -180px and reaches the floor at ~1 s of the
  // 1.7 s drop. Two small thunks for the bounce-and-settle feel.
  useEffect(() => {
    const t1 = setTimeout(() => playChestThunk(), 1020)
    const t2 = setTimeout(() => playChestThunk(), 1250)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  useEffect(() => {
    return () => {
      if (lidTimerRef.current)  clearTimeout(lidTimerRef.current)
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      if (audioRef.current) {
        try { audioRef.current.pause() } catch { /* nothing */ }
        audioRef.current = null
      }
    }
  }, [])

  function onClick() {
    if (clicked) return
    setClicked(true)
    // Start the audio immediately. Lid waits CHEST_LID_OPEN_DELAY_MS
    // (~7 s) to time with the musical cue in the clip before opening.
    if (assets?.chestOpen) {
      try {
        const a = new Audio(assets.chestOpen)
        a.volume = 0.85
        audioRef.current = a
        a.onended = () => { setDone(true) }
        const p = a.play()
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // Autoplay rejected — fall back to a fixed-duration timer.
            doneTimerRef.current = setTimeout(() => setDone(true), CHEST_LID_OPEN_DELAY_MS + 3500)
          })
        }
      } catch {
        doneTimerRef.current = setTimeout(() => setDone(true), CHEST_LID_OPEN_DELAY_MS + 3500)
      }
    } else {
      // No MP3 — open lid sooner, then complete shortly after.
      doneTimerRef.current = setTimeout(() => setDone(true), CHEST_LID_OPEN_DELAY_MS + 1800)
    }
    lidTimerRef.current = setTimeout(() => setOpened(true), CHEST_LID_OPEN_DELAY_MS)
  }

  useEffect(() => {
    if (done) {
      onComplete?.()
    }
  }, [done, onComplete])

  return (
    <div className="ovum-teal-chest-veil" onClick={(e) => { if (e.target === e.currentTarget) { /* ignore clicks on veil */ } }}>
      <svg
        className={`ovum-teal-chest${clicked ? ' clicked' : ''}${opened ? ' opened' : ''}`}
        viewBox="0 0 64 64"
        xmlns="http://www.w3.org/2000/svg"
        onClick={onClick}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="ovum-teal-chest-wood" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#7a4926" />
            <stop offset="55%"  stopColor="#5e371b" />
            <stop offset="100%" stopColor="#3e2410" />
          </linearGradient>
          <linearGradient id="ovum-teal-chest-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#f5c542" />
            <stop offset="55%"  stopColor="#c89414" />
            <stop offset="100%" stopColor="#7a5a08" />
          </linearGradient>
          <radialGradient id="ovum-teal-chest-interior" cx="0.5" cy="0.6" r="0.6">
            <stop offset="0%"   stopColor="#ffe9a0" />
            <stop offset="60%"  stopColor="#c8821e" />
            <stop offset="100%" stopColor="#2a1808" />
          </radialGradient>
          <radialGradient id="ovum-teal-chest-item-grad">
            <stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
            <stop offset="35%"  stopColor="#fff6c0" stopOpacity="0.95" />
            <stop offset="70%"  stopColor="#ffd83a" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#a87a08" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Chest interior — only visible once the lid opens. */}
        <rect x="6" y="22" width="52" height="36" rx="2" fill="url(#ovum-teal-chest-interior)" />

        {/* Item-get glow orb — rises out of the open chest. */}
        <g className="ovum-teal-chest-item">
          <circle cx="32" cy="28" r="8" fill="url(#ovum-teal-chest-item-grad)" />
        </g>

        {/* Body */}
        <rect x="4" y="32" width="56" height="28" rx="3" fill="url(#ovum-teal-chest-wood)" stroke="#2a1808" strokeWidth="1.5" />
        {/* Body wood-grain stripes */}
        <line x1="4" y1="40" x2="60" y2="40" stroke="rgba(0,0,0,0.18)" strokeWidth="0.5" />
        <line x1="4" y1="48" x2="60" y2="48" stroke="rgba(0,0,0,0.18)" strokeWidth="0.5" />
        {/* Body gold trim */}
        <rect x="4" y="32" width="56" height="3" fill="url(#ovum-teal-chest-band)" />
        <rect x="4" y="57" width="56" height="3" fill="url(#ovum-teal-chest-band)" />
        <rect x="4" y="32" width="3" height="28" fill="url(#ovum-teal-chest-band)" />
        <rect x="57" y="32" width="3" height="28" fill="url(#ovum-teal-chest-band)" />
        {/* Lock plate */}
        <rect x="28" y="42" width="8" height="10" rx="1" fill="url(#ovum-teal-chest-band)" stroke="#5e370b" strokeWidth="0.6" />
        <circle cx="32" cy="46" r="1.4" fill="#3a2606" />
        <rect x="31.3" y="46.5" width="1.4" height="3" fill="#3a2606" />

        {/* Lid (rotates open on click) */}
        <g className="ovum-teal-chest-lid">
          <rect x="4" y="14" width="56" height="22" rx="3" fill="url(#ovum-teal-chest-wood)" stroke="#2a1808" strokeWidth="1.5" />
          <line x1="4" y1="22" x2="60" y2="22" stroke="rgba(0,0,0,0.18)" strokeWidth="0.5" />
          <rect x="4" y="14" width="56" height="3" fill="url(#ovum-teal-chest-band)" />
          <rect x="4" y="33" width="56" height="3" fill="url(#ovum-teal-chest-band)" />
          <rect x="4" y="14" width="3" height="22" fill="url(#ovum-teal-chest-band)" />
          <rect x="57" y="14" width="3" height="22" fill="url(#ovum-teal-chest-band)" />
          {/* Lid lock latch */}
          <rect x="29" y="32" width="6" height="6" rx="1" fill="url(#ovum-teal-chest-band)" stroke="#5e370b" strokeWidth="0.6" />
        </g>
      </svg>
    </div>
  )
}

function OvumTealTriforce({ onComplete }) {
  useEffect(() => {
    const t = setTimeout(() => { onComplete?.() }, 7000)
    return () => clearTimeout(t)
  }, [onComplete])
  return (
    <div className="ovum-teal-triforce-veil" aria-hidden="true">
      <svg className="ovum-teal-triforce-svg" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="ovum-teal-triforce-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#fff6c0" />
            <stop offset="40%"  stopColor="#ffd83a" />
            <stop offset="100%" stopColor="#a87a08" />
          </linearGradient>
        </defs>
        {/* Top triangle */}
        <polygon
          points="100,8 60,82 140,82"
          fill="url(#ovum-teal-triforce-fill)"
          stroke="#7a5a08" strokeWidth="1.2"
        />
        {/* Bottom-left triangle */}
        <polygon
          points="60,86 20,160 100,160"
          fill="url(#ovum-teal-triforce-fill)"
          stroke="#7a5a08" strokeWidth="1.2"
        />
        {/* Bottom-right triangle */}
        <polygon
          points="140,86 100,160 180,160"
          fill="url(#ovum-teal-triforce-fill)"
          stroke="#7a5a08" strokeWidth="1.2"
        />
      </svg>
      <div className="ovum-teal-triforce-text">Hero of Time</div>
      <div className="ovum-teal-triforce-sub">All songs mastered</div>
    </div>
  )
}

// Chest cinematic orchestrator — drops the chest, waits for click,
// plays the opening MP3, opens the lid, then shows the Triforce
// congratulations overlay. Fires once per session.
async function fireChestCinematic() {
  if (typeof document === 'undefined') return
  ensureTealStyle()
  const assets = await ensureOvumTealAssets()
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let chestDone = false
    let triforceDone = false

    function cleanup() {
      try { root.unmount() } catch { /* nothing */ }
      if (host.parentNode) {
        try { host.parentNode.removeChild(host) } catch { /* nothing */ }
      }
      resolve()
    }

    function showTriforce() {
      if (triforceDone) return
      // Re-render with both chest (opened, fading) and Triforce overlay
      // so the chest stays in place behind the gold while the overlay
      // does its shimmer.
      root.render(
        <>
          <OvumTealChest assets={assets || {}} onComplete={() => { /* already opened */ }} />
          <OvumTealTriforce onComplete={() => { triforceDone = true; cleanup() }} />
        </>,
      )
    }

    root.render(
      <OvumTealChest
        assets={assets || {}}
        onComplete={() => {
          if (chestDone) return
          chestDone = true
          showTriforce()
        }}
      />,
    )
  })
}

function maybeToggleNavi() {
  const mainPlayed = TEAL_SONGS.filter((s) => s.main).every((s) => g_teal_played.has(s.id))
  if (!g_teal_naviUnlocked) {
    if (!mainPlayed) return                           // still building toward unlock
    g_teal_naviUnlocked = true
    mountOvumTealNavi().catch(() => { /* never break a payload */ })
    return
  }
  // Post-unlock: any further song match toggles Navi.
  if (g_teal_naviRoot) {
    unmountOvumTealNavi()
  } else {
    mountOvumTealNavi().catch(() => { /* never break a payload */ })
  }
}

// ── Selection-armed listening mode ───────────────────────────────────
function setTealArmed(armed) {
  if (armed === g_teal_armed) return
  g_teal_armed = armed
  if (armed) {
    ensureTealKeyHandler()
  } else {
    g_teal_buffer = []
    g_teal_lastNoteAt = 0
    teardownTealKeyHandler()
  }
}

// Recompute armed state from current store data. Armed iff:
//   - an Ocarina entity exists
//   - its EntityNode is the currently selected canvas node
function refreshTealArmedState() {
  if (g_teal_suppressDetect) return
  // Find ocarina entity (first match if multiple — unlikely).
  const ents = useEntitiesStore.getState()
  const items = ents.items || []
  const entity = items.find(isOvumTealEntity)
  if (!entity) {
    g_teal_entityId = null
    g_teal_nodeId = null
    setTealArmed(false)
    return
  }
  g_teal_entityId = entity.id
  // Find its origin EntityNode on the canvas.
  const proj = useProjectStore.getState()
  const node = (proj.nodes || []).find(
    (n) => n.type === 'entityNode' && n.data?.entity_id === entity.id,
  )
  g_teal_nodeId = node?.id || null
  if (!g_teal_nodeId) {
    setTealArmed(false)
    return
  }
  // Selection check — react flow stores `selected: true` on nodes.
  const isSelected = !!(node && node.selected)
  setTealArmed(isSelected)
}

function ensureTealSubscriptions() {
  if (g_teal_selUnsub) return
  // Subscribe to project-store changes (nodes + their selected flags).
  g_teal_selUnsub = useProjectStore.subscribe(() => refreshTealArmedState())
  // Subscribe to entities-store changes (ocarina entity create/rename/delete).
  useEntitiesStore.subscribe(() => refreshTealArmedState())
  refreshTealArmedState()
}

// Called from entitiesStore on create + update.
export function detectAndFireOvumTeal(entity) {
  if (!entity) return false
  if (g_teal_suppressDetect) return false
  if (!isOvumTealEntity(entity)) {
    // Could be a rename AWAY from "ocarina" — refresh subscriptions
    // pick that up via subscribe; nothing to do here.
    return false
  }
  ensureTealSubscriptions()
  // Process the Scarecrow's Song attribute (if present): validate the
  // user's saved value, register it as the 13th matchable song, or
  // silently reset to '???' if it doesn't pass validation.
  processScarecrowAttribute(entity).catch(() => { /* nothing */ })
  return true
}

async function processScarecrowAttribute(entity) {
  const scAttr = (entity.attributes || []).find(
    (a) => (a?.name || '').trim().toLowerCase() === TEAL_SCARECROW_NAME.toLowerCase(),
  )
  if (!scAttr) {
    // No Scarecrow attribute yet — nothing to register.
    g_teal_scarecrowSeq = null
    return
  }
  const raw = scAttr.value
  // Placeholder / empty: clear any previously registered seq.
  if (!raw || raw === TEAL_SCARECROW_PLACEHOLDER) {
    g_teal_scarecrowSeq = null
    return
  }
  const parsed = parseScarecrowValue(raw)
  if (parsed) {
    // Valid composition — register it as the 13th matchable song.
    g_teal_scarecrowSeq = parsed
    return
  }
  // Invalid: auto-reset the attribute value back to '???' so the user
  // can try again. Suppress detect during the write so this doesn't
  // re-enter recursively.
  g_teal_scarecrowSeq = null
  const ents = useEntitiesStore.getState()
  const fresh = ents.getEntityById ? ents.getEntityById(entity.id) : null
  if (!fresh) return
  const next = (fresh.attributes || []).map((a) => {
    if ((a?.name || '').trim().toLowerCase() !== TEAL_SCARECROW_NAME.toLowerCase()) return a
    return { ...a, value: TEAL_SCARECROW_PLACEHOLDER }
  })
  g_teal_suppressDetect = true
  try {
    await ents.updateEntity(fresh.id, { ...fresh, attributes: next })
  } catch { /* nothing — egg must never break user data */ } finally {
    g_teal_suppressDetect = false
  }
}

// ══════════════════════════════════════════════════════════════════════
//   ovum_yellow
// ══════════════════════════════════════════════════════════════════════
//
// Active-disobedience trigger: the user presses the save shortcut four
// or more times in a row when the project has no unsaved changes. Each
// save still completes normally — the trigger watches a behavioural
// pattern (compulsive pointless re-saving) and quietly enters
// "Narrator mode" when it crosses the threshold.
//
// Proof-of-concept payload: a bundled 4-line voice-over chain. The
// first 4 saves wake the Narrator silently; on the 5th-8th saves the
// 4 lines play in order. Subsequent saves cycle back through them.
// Production payload will expand this into a full event-hook system
// (see the eggs.md spec).

const Y_STREAK_THRESHOLD = 4         // saves-with-nothing-to-save before activation
const Y_STREAK_RESET_MS  = 30000     // streak resets after this much keypress silence
let g_yellow_emptySaveStreak = 0
let g_yellow_lastSaveAt      = 0
let g_yellow_activated       = false
let g_yellow_lineIdx         = 0
let g_yellow_audio           = null  // currently-playing Audio so a new fire can replace it
let g_yellow_assets          = null  // null = unloaded, false = failed, object = loaded

async function ensureOvumYellowAssets() {
  if (g_yellow_assets !== null) return g_yellow_assets || null
  try {
    const m = await import('./quarterlyAddendum.js')
    g_yellow_assets = [
      m.OVUM_YELLOW_LINE_1,
      m.OVUM_YELLOW_LINE_2,
      m.OVUM_YELLOW_LINE_3,
      m.OVUM_YELLOW_LINE_4,
    ]
  } catch {
    g_yellow_assets = false
  }
  return g_yellow_assets || null
}

function playYellowLine(idx) {
  const assets = g_yellow_assets
  if (!assets || !assets[idx]) return
  try {
    if (g_yellow_audio) {
      try { g_yellow_audio.pause() } catch { /* nothing */ }
    }
    const a = new Audio(assets[idx])
    a.volume = 0.95
    g_yellow_audio = a
    const p = a.play()
    if (p && typeof p.catch === 'function') p.catch(() => { /* blocked — silent */ })
  } catch { /* nothing — egg must never break input */ }
}

// Called from App.jsx every time the save shortcut fires, BEFORE the
// save actually runs. `hadUnsavedChangesBefore` is the project store's
// `hasUnsavedChanges` value as seen at the moment of the keypress.
//
// Behaviour:
//   1. While inactive: count consecutive empty saves (no unsaved
//      changes). At threshold, flip to activated and silently start
//      preloading the asset module (does not play anything yet — the
//      activation itself was the user's chosen disobedience signal).
//   2. While activated: every subsequent save plays the next line in
//      the bundled 4-line chain, cycling back to line 1 after line 4.
//   3. A save with actual unsaved changes resets the streak (genuine
//      work breaks the compulsion pattern).
//   4. > 30 s without any save keypress resets the streak (deliberate
//      cluster window).
export function detectAndFireOvumYellow(hadUnsavedChangesBefore) {
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
  // Reset streak on long gap between save keypresses.
  if (g_yellow_lastSaveAt && now - g_yellow_lastSaveAt > Y_STREAK_RESET_MS) {
    g_yellow_emptySaveStreak = 0
  }
  g_yellow_lastSaveAt = now

  if (!g_yellow_activated) {
    // Not yet activated. Count consecutive empty saves.
    if (hadUnsavedChangesBefore) {
      // Real save — pattern broken, reset.
      g_yellow_emptySaveStreak = 0
      return
    }
    g_yellow_emptySaveStreak += 1
    if (g_yellow_emptySaveStreak >= Y_STREAK_THRESHOLD) {
      g_yellow_activated = true
      g_yellow_lineIdx = 0
      markEggFired('yellow')
      // Preload the asset module so the 5th save fires the first line
      // promptly. Silent — the activation itself is silent; the
      // Narrator wakes on the next save.
      ensureOvumYellowAssets().catch(() => { /* nothing */ })
    }
    return
  }

  // Activated. Each save plays the next line in order; once all
  // lines have played, subsequent saves are silent.
  ensureOvumYellowAssets().then(() => {
    if (!g_yellow_assets) return
    if (g_yellow_lineIdx >= g_yellow_assets.length) return
    const idx = g_yellow_lineIdx
    g_yellow_lineIdx += 1
    playYellowLine(idx)
  }).catch(() => { /* nothing */ })
}

