/**
 * Phase 3.11a — Novelcrafter prompt clipboard import.
 *
 * Decodes the `nc:prompt:1` blob produced by Novelcrafter's prompt
 * editor "Copy" button and maps it into a NarrativeNode system-prompt
 * draft suitable for `SystemPromptEditModal` in `mode: 'create'`.
 *
 * Encoding chain (from NC's Copy):
 *   JSON object  →  gzip  →  base64  →  text on clipboard
 *
 * Schema sample (reference blobs at .References/NC Prompt copy paste
 * examples/ + .References/NovelCrafter export example/):
 *   {
 *     "$schema": "nc:prompt:1",
 *     "name": "General Purpose (Copy)",
 *     "type": "scene-beat-completion",   // or scene-summarization,
 *                                        // manuscript-replacement,
 *                                        // workshop-chat
 *     "messages": [
 *       { "type": "system" | "user" | "assistant",
 *         "format": "aic2",
 *         "text": "..." }
 *     ],
 *     "inputs": [ { name, description, mode, required, types,
 *                   settings, default }, ... ]
 *   }
 *
 * V1 (per writer's pre-phase review):
 *   - Always create a NEW SystemPrompt entry; never overwrite or
 *     append to the current editor draft.
 *   - Strip Novelcrafter `{}` markers from the prompt body entirely.
 *     Phase 3.11c will land the bidirectional NC-marker ↔ NN-pill
 *     translator; until then, imported prompts are marker-free and
 *     the writer attaches NN pills by hand.
 */

const NC_PROMPT_SCHEMA = 'nc:prompt:1'

/**
 * Decode a NC clipboard blob (base64 of a gzip of a JSON string) into
 * the raw object. Throws on any failure with a writer-facing message.
 *
 * Uses the browser's native `DecompressionStream` ('gzip') — supported
 * in every Chromium / Firefox / Safari version we care about. No
 * third-party dependency needed.
 *
 * @param {string} blob — the base64 text from the clipboard
 * @returns {Promise<object>} the parsed nc:prompt:1 object
 */
export async function decodeNovelcrafterPromptBlob(blob) {
  if (!blob || typeof blob !== 'string') {
    throw new Error('No clipboard content to decode.')
  }
  const trimmed = blob.trim()
  if (!trimmed) {
    throw new Error('Clipboard is empty.')
  }

  // 1. Base64 → bytes. `atob` decodes one char per byte; we then
  // build a Uint8Array for the DecompressionStream input.
  let raw
  try {
    raw = atob(trimmed)
  } catch {
    throw new Error("Clipboard contents aren't base64 — is this really a NovelCrafter prompt blob?")
  }
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

  // 2. Bytes → gzip-decompressed bytes via the native stream API.
  let decompressed
  try {
    const ds = new DecompressionStream('gzip')
    const stream = new Blob([bytes]).stream().pipeThrough(ds)
    decompressed = new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    throw new Error("Couldn't unzip the clipboard contents.")
  }

  // 3. Bytes → JSON.
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(decompressed))
  } catch {
    throw new Error("The clipboard's unzipped contents aren't valid JSON.")
  }

  // 4. Schema validation. NC's "Copy" emits one of three shapes:
  //   (a) self-contained: a single object with $schema 'nc:prompt:1';
  //       any {include("X")} references in the prompt body were
  //       pre-expanded by NC into the content.
  //   (b) bundle: a JSON array of objects, each with $schema
  //       'nc:prompt:1'. The first non-`component` element is the main
  //       prompt; subsequent `type: 'component'` elements are the NC
  //       snippets the main prompt references via {include("Name")}.
  //   (c) reference-only: a single object with $schema 'nc:prompt:1'
  //       that still carries unresolved {include("X")} markers; the
  //       snippets are NOT bundled (writer expected the destination NC
  //       instance to have the snippet library).
  if (!parsed || typeof parsed !== 'object') {
    throw new Error("Decoded payload isn't an object — not a NovelCrafter prompt blob.")
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("Decoded payload is an empty bundle — nothing to import.")
    }
    for (let i = 0; i < parsed.length; i++) {
      const el = parsed[i]
      if (!el || typeof el !== 'object' || Array.isArray(el)) {
        throw new Error(`Bundle element ${i} isn't an object — not a NovelCrafter prompt blob.`)
      }
      if (el.$schema !== NC_PROMPT_SCHEMA) {
        throw new Error(
          `Bundle element ${i} has unexpected schema "${el.$schema || '<missing>'}" — only ${NC_PROMPT_SCHEMA} is supported.`,
        )
      }
    }
    return parsed
  }
  if (parsed.$schema !== NC_PROMPT_SCHEMA) {
    throw new Error(
      `Unexpected schema "${parsed.$schema || '<missing>'}" — only ${NC_PROMPT_SCHEMA} is supported.`,
    )
  }

  return parsed
}


// ────────────────────────────────────────────────────────────────
// Phase 3.11c — NC marker → NN ContextMarker translator.
//
// Best-effort pre-strip pass that walks the body text, finds known
// simple-substitution and function-call NC markers, and replaces
// each with an equivalent NN ContextMarker object. Translated markers
// are REMOVED from the body text — they'll be attached to the prompt
// as `context_markers[]` instead and resolve at fire time.
//
// Coverage is scoped per the v0.3.11.7 audit:
//   • Direct simple substitutions for novel.* / pov.* / chapter.* /
//     act.* / date.today / storySoFar.
//   • Function calls with literal-int parameters: wordsBefore(N) /
//     wordsAfter(N) / lastWords(scene.fullText(scene.previous), N) /
//     firstWords(scene.fullText(scene.next), N).
//   • Adjacent-scene description reads: scene.summary(scene.previous)
//     / scene.summary(scene.next).
//
// Out of scope (left as raw text for the existing stripper to handle):
//   • Codex query DSL (codex.get / codex.mentions / codex.has / ...).
//   • Series.* / novel.outline / nextBeat / previousBeat — no NN
//     analog.
//   • Logic / math / list / text-formatter operations (and / or / not
//     / asMarkdown / pluralize / etc.) — NC has a real templating
//     language; translation isn't a marker-lookup problem there.
//   • Conditional blocks ({#if ... {#endif}) — handled by Phase 3.11d
//     decision (raw-text strip for now).
//
// Semantic mismatches the translator accepts as "close enough":
//   • `pov.type` is NC's per-scene POV type; NN doesn't have a per-
//     scene POV type marker. Maps to `story_pov_type` (story-level
//     default). Writer can adjust the resolved value via Story
//     Settings if they care.
//   • `pov` and `pov.character` both map to NN's `pov_character`
//     (current scene's POV chip). NN's `story_default_pov_character`
//     is NOT used here — NC's `pov` is scene-resolved at fire time,
//     same as NN's `pov_character`.
// ────────────────────────────────────────────────────────────────

const _NC_SIMPLE_MARKER_MAP = [
  // Order matters — longer keys first so 'pov.character' wins over 'pov'.
  ['novel.title',     { type: 'story_title' }],
  ['novel.tense',     { type: 'story_tense' }],
  ['novel.language',  { type: 'story_language' }],
  ['pov.character',   { type: 'pov_character' }],
  ['pov.type',        { type: 'story_pov_type' }],
  ['pov',             { type: 'pov_character' }],
  ['chapter.title',   { type: 'chapter_title' }],
  ['act.title',       { type: 'act_title' }],
  ['date.today',      { type: 'today_date' }],
  ['storySoFar',      { type: 'story_so_far', detail: 'descriptions_only' }],
]

function _markerKeyForDedup(marker) {
  // Sorted-keys JSON so equivalent markers stringify identically.
  // Mirrors `markerKey` in `frontend/src/utils/dynamicMarkers.js`,
  // duplicated here so this util stays standalone (no React /
  // store dependency, smoke-testable in Node).
  if (!marker || typeof marker !== 'object') return ''
  const sorted = {}
  for (const key of Object.keys(marker).sort()) sorted[key] = marker[key]
  return JSON.stringify(sorted)
}

/**
 * Translate the NC marker subset we have NN analogs for. Mutates
 * neither input nor output of the existing stripper — runs BEFORE
 * `stripNovelcrafterMarkers` so the inline `{...}` matches we
 * recognise get extracted into context markers; everything else
 * falls through to the existing strip pass.
 *
 * @param {string} text
 * @returns {{
 *   text: string,                    // body with translated markers removed
 *   markers: Array<object>,          // NN ContextMarkers to attach
 *   translated_count: number,        // total marker tokens replaced
 *   translated_kinds: Array<string>, // unique NN marker types created
 * }}
 */
export function translateNovelcrafterMarkers(text) {
  if (typeof text !== 'string' || text === '') {
    return { text: '', markers: [], translated_count: 0, translated_kinds: [] }
  }
  let out = text
  const markers = []
  const seenKeys = new Set()
  const translatedKinds = new Set()
  let translatedCount = 0

  function addMarker(m) {
    translatedCount += 1
    translatedKinds.add(m.type)
    const key = _markerKeyForDedup(m)
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    markers.push(m)
  }

  // 1. Simple substitution markers (`{novel.title}` etc.).
  for (const [nc, nn] of _NC_SIMPLE_MARKER_MAP) {
    const escaped = nc.replace(/\./g, '\\.')
    const pattern = new RegExp(`\\{\\s*${escaped}\\s*\\}`, 'g')
    out = out.replace(pattern, () => {
      addMarker({ ...nn })
      return ''
    })
  }

  // 2. Parameterised function calls — N-words variants. Numeric arg
  // gets parsed into the NN marker's `n` field.
  out = out.replace(/\{\s*wordsBefore\s*\(\s*(\d+)\s*\)\s*\}/g, (_m, n) => {
    addMarker({ type: 'previous_n_words', n: parseInt(n, 10) })
    return ''
  })
  out = out.replace(/\{\s*wordsAfter\s*\(\s*(\d+)\s*\)\s*\}/g, (_m, n) => {
    addMarker({ type: 'following_n_words', n: parseInt(n, 10) })
    return ''
  })
  out = out.replace(
    /\{\s*lastWords\s*\(\s*scene\.fullText\s*\(\s*scene\.previous\s*\)\s*,\s*(\d+)\s*\)\s*\}/g,
    (_m, n) => {
      addMarker({ type: 'previous_n_words', n: parseInt(n, 10) })
      return ''
    },
  )
  out = out.replace(
    /\{\s*firstWords\s*\(\s*scene\.fullText\s*\(\s*scene\.next\s*\)\s*,\s*(\d+)\s*\)\s*\}/g,
    (_m, n) => {
      addMarker({ type: 'following_n_words', n: parseInt(n, 10) })
      return ''
    },
  )

  // 3. Adjacent-scene description reads.
  out = out.replace(/\{\s*scene\.summary\s*\(\s*scene\.previous\s*\)\s*\}/g, () => {
    addMarker({ type: 'previous_scene', detail: 'descriptions_only' })
    return ''
  })
  out = out.replace(/\{\s*scene\.summary\s*\(\s*scene\.next\s*\)\s*\}/g, () => {
    addMarker({ type: 'next_scene', detail: 'descriptions_only' })
    return ''
  })

  return {
    text: out,
    markers,
    translated_count: translatedCount,
    translated_kinds: [...translatedKinds],
  }
}


/**
 * Strip Novelcrafter's `{}` markers from a body of prompt text.
 *
 * Three categories are handled, in this order:
 *   1. `{! ... !}` author-comment blocks (may be multi-line).
 *   2. `{#if cond} ... {#endif}` conditional blocks (multi-line,
 *      strip the ENTIRE block including its content since the body
 *      is conditional on a substitution we can't resolve).
 *   3. Single-line `{anything}` substitutions / function calls /
 *      `{include("...")}` directives.
 *
 * After the strips, runs of spaces are collapsed to single spaces and
 * runs of 3+ blank lines are collapsed to 2. The result is trimmed
 * at the ends. Empty input passes through as `""`.
 *
 * @param {string} text
 * @returns {{ stripped: string, removed_count: number }}
 *   Both the cleaned text and the total number of marker tokens
 *   the function elided, so the import flow can surface "N
 *   Novelcrafter markers were removed; add NN context pills as needed."
 */
export function stripNovelcrafterMarkers(text) {
  if (typeof text !== 'string' || text === '') {
    return { stripped: '', removed_count: 0, include_refs: [] }
  }
  let removed = 0
  let out = text
  const includeRefs = []

  // 1. Comment blocks `{! ... !}` (non-greedy, dotall via [\s\S]).
  out = out.replace(/\{!\s*[\s\S]*?\s*!\}/g, () => { removed += 1; return '' })

  // 2. `{#if cond}...{#endif}` blocks (non-greedy across newlines).
  // Multiple sibling blocks shouldn't cross-match because the regex
  // is non-greedy on the body. Nested `{#if}` inside another `{#if}`
  // would mis-balance — NC doesn't seem to use nesting in the
  // reference samples so v1 doesn't handle it; we'd surface it as
  // a follow-up if a sample shows up.
  out = out.replace(/\{#if\s+[^}]*\}[\s\S]*?\{#endif\}/g, () => { removed += 1; return '' })

  // 3. Single-line `{...}` substitutions (everything else). Before we
  // strip them, harvest any `{include("Name")}` / `{include('Name')}`
  // references so the caller can match them against bundled
  // components or surface unresolved ones in the success banner.
  // The include capture has to run BEFORE the strip pass — once the
  // marker is gone we can't recover the name.
  const includeRegex = /\{\s*include\s*\(\s*["']([^"']+)["']\s*\)\s*\}/g
  let m
  while ((m = includeRegex.exec(out)) !== null) {
    if (m[1]) includeRefs.push(m[1])
  }
  out = out.replace(/\{[^{}\n]+\}/g, () => { removed += 1; return '' })

  // 4. Tidy whitespace: collapse multi-space runs, cap consecutive
  // blank lines at 2, trim ends.
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n')
  out = out.trim()

  return { stripped: out, removed_count: removed, include_refs: includeRefs }
}


/**
 * Map a decoded `nc:prompt:1` object into the NN system-prompt draft
 * shape that `SystemPromptEditModal` expects in `mode: 'create'`.
 *
 *   - The first NC `system` message → NN's `prompt` (the system
 *     prompt body). Subsequent `system` messages, if any, get
 *     appended to the first as separate paragraphs (the modal can't
 *     represent multiple system entries).
 *   - Every `user` / `assistant` NC message in order → an NN
 *     `mock_messages` entry. Role mapping is straightforward
 *     (`user` ↔ `user`, `assistant` ↔ `assistant`).
 *
 * Every text body is run through `stripNovelcrafterMarkers` before
 * landing in the draft. The total removed-marker count is summed
 * across all bodies and returned alongside the draft so the import
 * flow can surface it to the writer.
 *
 * @param {object} ncPrompt — the decoded nc:prompt:1 object
 * @returns {{ draft: object, nc_type: string, removed_markers: number }}
 */
export function mapNovelcrafterPromptToDraft(ncPrompt) {
  // Bundle (array) shape: first non-`component` element is the main
  // prompt; every other `component` element is a snippet bundled
  // alongside. The caller resolves components against existing
  // Context Cues (reuse by name) or stages new cues for the modal's
  // draft state. Self-contained (a) and reference-only (c) shapes
  // fall through to the single-prompt path.
  let mainPrompt = ncPrompt
  const components = []
  if (Array.isArray(ncPrompt)) {
    // Find the first non-`component` element as the main prompt; any
    // additional non-`component` entries collapse into components too
    // (they're not the headline prompt, but they're real content the
    // writer bundled).
    let mainIdx = ncPrompt.findIndex((el) => el && el.type !== 'component')
    if (mainIdx === -1) {
      // Pathological: bundle of only components. Treat the first
      // element as the main prompt so we at least produce something
      // sane; the writer can rename and re-organize after.
      mainIdx = 0
    }
    mainPrompt = ncPrompt[mainIdx]
    for (let i = 0; i < ncPrompt.length; i++) {
      if (i === mainIdx) continue
      components.push(ncPrompt[i])
    }
  }

  const safeName = (mainPrompt && typeof mainPrompt.name === 'string' && mainPrompt.name.trim())
    ? mainPrompt.name.trim()
    : 'Imported NovelCrafter prompt'
  const ncType = (mainPrompt && typeof mainPrompt.type === 'string') ? mainPrompt.type : ''

  const messages = Array.isArray(mainPrompt?.messages) ? mainPrompt.messages : []
  let removedTotal = 0
  let translatedTotal = 0
  const includeRefs = []
  // Translator output accumulates into the draft's `context_markers`
  // array. Dedup is per-marker-key so the same marker appearing in
  // multiple messages collapses to one prompt-level attachment.
  const collectedMarkers = []
  const collectedMarkerKeys = new Set()
  const translatedKindSet = new Set()
  let systemBody = ''
  const mockMessages = []

  for (const m of messages) {
    if (!m || typeof m.text !== 'string') continue
    // Phase 3.11c — translator runs BEFORE the stripper. Any NC marker
    // with an NN analog gets extracted into the context_markers list
    // and removed from the body; everything else falls through to the
    // stripper. Markers are NOT re-counted in `removedTotal` — they
    // are a separate, more useful signal ("N markers translated to
    // NN pills"). The stripper's count covers only the unmapped
    // tokens that got dropped.
    const translated = translateNovelcrafterMarkers(m.text)
    for (const marker of translated.markers) {
      const key = _markerKeyForDedup(marker)
      if (collectedMarkerKeys.has(key)) continue
      collectedMarkerKeys.add(key)
      collectedMarkers.push(marker)
    }
    translatedTotal += translated.translated_count
    for (const k of translated.translated_kinds) translatedKindSet.add(k)
    const { stripped, removed_count, include_refs } = stripNovelcrafterMarkers(translated.text)
    removedTotal += removed_count
    for (const r of (include_refs || [])) includeRefs.push(r)
    if (m.type === 'system') {
      // Concatenate multiple system blocks (rare, but observed in the
      // survey) with a blank-line separator so the writer can see
      // both halves and merge / re-split by hand.
      systemBody = systemBody ? `${systemBody}\n\n${stripped}` : stripped
    } else if (m.type === 'user' || m.type === 'assistant') {
      // Mint an id locally — backend `MockMessage` requires `id: str`
      // (a missing / undefined id 422s the SystemPrompt POST). And
      // the body field is `body`, not `content` — the previous
      // `content` field was getting silently dropped by Pydantic's
      // `extra="ignore"` config, so any mock messages from a paste-in
      // were arriving at the backend with empty bodies even when the
      // POST didn't 422. Both bugs originated in v0.3.11.2 and went
      // unnoticed until v0.3.11.7 added context_markers to the draft,
      // tipping the payload over the 422 threshold via the id-missing
      // failure.
      mockMessages.push({
        id: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : `sp_${Math.random().toString(36).slice(2, 10)}`,
        role: m.type,
        body: stripped,
      })
    }
    // Other NC message types (none observed in the survey) drop on
    // the floor — adding them later is additive if NC ships new ones.
  }

  // Bundled components — each becomes a candidate Context Cue. We
  // strip the same `{}` markers from their bodies (NN cues are
  // static text; the chat runtime has no template engine on the cue
  // side), concatenate multi-message components with blank-line
  // separators, and return the name + cleaned body for the caller
  // to resolve against the existing cue library.
  const componentDrafts = []
  for (const c of components) {
    if (!c || typeof c !== 'object') continue
    const compName = (typeof c.name === 'string' && c.name.trim()) ? c.name.trim() : ''
    if (!compName) continue
    const compMessages = Array.isArray(c.messages) ? c.messages : []
    let compBody = ''
    let compRemoved = 0
    for (const cm of compMessages) {
      if (!cm || typeof cm.text !== 'string') continue
      const { stripped, removed_count } = stripNovelcrafterMarkers(cm.text)
      compRemoved += removed_count
      compBody = compBody ? `${compBody}\n\n${stripped}` : stripped
    }
    componentDrafts.push({
      name: compName,
      body: compBody,
      removed_markers: compRemoved,
    })
  }

  // Unresolved includes — `{include("Name")}` references in the main
  // prompt body that don't match a bundled component. The caller
  // also subtracts existing-cue name matches before surfacing.
  const bundledNames = new Set(componentDrafts.map((c) => c.name))
  const unresolvedIncludes = []
  const seenUnresolved = new Set()
  for (const ref of includeRefs) {
    if (bundledNames.has(ref)) continue
    if (seenUnresolved.has(ref)) continue
    seenUnresolved.add(ref)
    unresolvedIncludes.push(ref)
  }

  return {
    draft: {
      name: safeName,
      prompt: systemBody,
      mock_messages: mockMessages,
      // Sensible defaults for the rest of the SystemPrompt shape.
      // The modal will fill these from its own create-mode defaults
      // when undefined.
      is_persona: false,
      // Phase 3.11c — translator output. Markers extracted from the
      // body during import attach as the prompt's `context_markers`
      // list so they resolve at fire time on whatever surface picks
      // the prompt.
      context_markers: collectedMarkers,
      static_cue_ids: [],
      surface_defaults: null,
    },
    nc_type: ncType,
    removed_markers: removedTotal,
    translated_markers: translatedTotal,
    translated_kinds: [...translatedKindSet],
    components: componentDrafts,
    unresolved_includes: unresolvedIncludes,
  }
}


/**
 * Top-level helper for the System Prompts settings tab "Paste a
 * NovelCrafter prompt" button. Reads from the system clipboard,
 * decodes, strips, and maps. Throws with a writer-facing message
 * on any failure so the caller can surface a toast.
 *
 * Clipboard read uses `navigator.clipboard.readText()` — modern
 * browsers gate this behind user permission. If the read is
 * blocked, the caller should fall back to a paste-into-textarea
 * dialog.
 *
 * @returns {Promise<{ draft, nc_type, removed_markers }>}
 */
export async function importNovelcrafterPromptFromClipboard() {
  let blob
  try {
    blob = await navigator.clipboard.readText()
  } catch {
    throw new Error(
      "Couldn't read the clipboard. Allow clipboard access for this site, or paste the blob into the input.",
    )
  }
  const decoded = await decodeNovelcrafterPromptBlob(blob)
  return mapNovelcrafterPromptToDraft(decoded)
}


// ────────────────────────────────────────────────────────────────
// Phase 3.11b — NN → NC export (the "Copy for NovelCrafter" path).
//
// Symmetric to the import side above: package an NN system prompt
// (with any attached Context Cues) into NC's `nc:prompt:1` clipboard
// blob in one of three shapes that mirror NC's own "Copy" options:
//   - 'self-contained' (NC default)     → snippet bodies inlined into
//                                         the system message body;
//                                         no `component` entries.
//   - 'bundle'                          → array `[main, ...components]`;
//                                         system body carries
//                                         `{include("Cue Name")}`
//                                         markers for each cue.
//   - 'reference-only'                  → object with `{include("Cue
//                                         Name")}` markers in the body
//                                         but NO components; requires
//                                         the destination NC instance
//                                         to already have matching
//                                         snippets.
//
// The NC `type` field is sourced from the NN prompt's `category`
// (free-form NN folder name) when set, falling back to
// 'scene-beat-completion' (NC's own default) otherwise. NC may or
// may not accept arbitrary strings there — that's left for empirical
// testing on the writer's side.
//
// Encoding chain (reverse of import): JS object → JSON →
// `CompressionStream('gzip')` → base64 → `navigator.clipboard.writeText`.
// ────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from a TipTap/HTML cue body, returning plain text.
 * NC's `nc:prompt:1` blobs carry plain text in `messages[].text`, not
 * HTML, so cue bodies (which NN stores as TipTap HTML) need a quick
 * tag strip before they ride out as NC component text or inlined into
 * a system message.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtmlForNcExport(html) {
  if (typeof html !== 'string' || !html) return ''
  if (typeof document === 'undefined') return html
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.innerText || div.textContent || '').trim()
}


function _buildMessagesArray(systemBody, mockMessages) {
  const messages = []
  if (systemBody) {
    messages.push({ type: 'system', format: 'aic2', text: systemBody })
  }
  for (const m of (mockMessages || [])) {
    if (!m) continue
    const role = m.role === 'user' || m.role === 'assistant' ? m.role : null
    if (!role) continue
    messages.push({ type: role, format: 'aic2', text: m.content || '' })
  }
  return messages
}


/**
 * Phase 3.11c — NN ContextMarker → NC marker emitter. Inverse of
 * `translateNovelcrafterMarkers`. Walks a prompt's `context_markers`
 * list and returns:
 *   - `nc_markers`: a list of NC `{...}` marker strings to splice
 *     into the system body so the destination NC instance resolves
 *     them at fire time.
 *   - `unsupported`: list of NN marker types that have no NC
 *     equivalent and got dropped. Caller surfaces these as a one-
 *     line warning in the copy popover so the writer knows the
 *     round-trip is lossy on those pills.
 *
 * @param {Array<object>} contextMarkers   NN ContextMarker array
 * @returns {{ nc_markers: string[], unsupported: string[] }}
 */
export function emitNovelcrafterMarkersForNn(contextMarkers) {
  if (!Array.isArray(contextMarkers) || contextMarkers.length === 0) {
    return { nc_markers: [], unsupported: [] }
  }
  const ncMarkers = []
  const unsupported = []
  const seenUnsupported = new Set()
  for (const m of contextMarkers) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') continue
    let nc = null
    switch (m.type) {
      case 'story_title':       nc = '{novel.title}'; break
      case 'story_tense':       nc = '{novel.tense}'; break
      case 'story_language':    nc = '{novel.language}'; break
      case 'pov_character':     nc = '{pov.character}'; break
      case 'story_pov_type':    nc = '{pov.type}'; break
      case 'chapter_title':     nc = '{chapter.title}'; break
      case 'act_title':         nc = '{act.title}'; break
      case 'today_date':        nc = '{date.today}'; break
      // NC's storySoFar has no detail axis — descriptions-only is its
      // only mode. NN's descriptions_and_changes / full_content variants
      // collapse to the same NC marker (NN renders richer content on
      // its own side, but the exported NC instance only knows the
      // single shape).
      case 'story_so_far':      nc = '{storySoFar}'; break
      case 'previous_n_words': {
        const n = Number.isFinite(m.n) ? Math.max(1, Math.floor(m.n)) : null
        if (n) nc = `{lastWords(scene.fullText(scene.previous), ${n})}`
        break
      }
      case 'following_n_words': {
        const n = Number.isFinite(m.n) ? Math.max(1, Math.floor(m.n)) : null
        if (n) nc = `{firstWords(scene.fullText(scene.next), ${n})}`
        break
      }
      case 'previous_scene': {
        if (m.detail === 'full_content') nc = '{scene.fullText(scene.previous)}'
        else nc = '{scene.summary(scene.previous)}'
        break
      }
      case 'next_scene': {
        if (m.detail === 'full_content') nc = '{scene.fullText(scene.next)}'
        else nc = '{scene.summary(scene.next)}'
        break
      }
      case 'current_scene_body':
        nc = '{scene.fullText}'
        break
      // Whole-story scope only maps cleanly when full content is
      // requested — NC's `novel.fullText` is the inverse. The
      // descriptions-only variant would need NC to iterate scene
      // summaries, which isn't a single-marker emit; warn instead.
      case 'story_scope_whole_story':
        if (m.detail === 'full_content') nc = '{novel.fullText}'
        break
      // NN-only pills with no clean NC analog. Listed explicitly so
      // a future marker addition doesn't fall through to the catch-
      // all silently — we want any unmapped marker to surface as a
      // warning, not vanish.
      case 'story_description':
      case 'story_default_pov_character':
      case 'story_scope_current_chapter':
      case 'story_scope_current_act':
        // No mapping; fall through to the unsupported list below.
        break
      default:
        // Catch-all for new marker types not yet considered.
        break
    }
    if (nc) {
      ncMarkers.push(nc)
    } else if (!seenUnsupported.has(m.type)) {
      seenUnsupported.add(m.type)
      unsupported.push(m.type)
    }
  }
  return { nc_markers: ncMarkers, unsupported }
}


/**
 * Build the JS object representation of a NN → NC export. Pure
 * data shape; no encoding / clipboard / DOM access.
 *
 * @param {object} prompt            NN SystemPrompt-shaped object
 * @param {object} opts
 * @param {'self-contained'|'bundle'|'reference-only'} opts.shape
 * @param {Array<{name: string, body: string}>} opts.attachedCues
 *        Cues to inline / bundle / reference. `body` should already
 *        be plain text (call `stripHtmlForNcExport` first if your
 *        source is HTML).
 * @param {string|null} [opts.ncType]
 *        Overrides the NC `type` field. Defaults to
 *        `prompt.category || 'scene-beat-completion'`.
 * @returns {object|Array<object>} the nc:prompt:1 payload — an
 *        object for self-contained / reference-only, an array for
 *        bundle.
 */
export function buildNovelcrafterExportPayload(prompt, opts) {
  const { shape = 'self-contained', attachedCues = [], ncType = null } = opts || {}
  const safeName = (prompt && typeof prompt.name === 'string' && prompt.name.trim())
    ? prompt.name.trim()
    : 'Untitled system prompt'
  const effectiveType = (typeof ncType === 'string' && ncType.trim())
    ? ncType.trim()
    : ((prompt && typeof prompt.category === 'string' && prompt.category.trim())
        ? prompt.category.trim()
        : 'scene-beat-completion')
  let systemBody = (prompt && typeof prompt.prompt === 'string') ? prompt.prompt : ''
  // Phase 3.11c — emit NN context_markers as NC `{...}` markers
  // appended after the prompt body. Each on its own line so the
  // destination writer can move them inline as needed. Markers
  // without an NC equivalent get dropped here; the caller surfaces
  // the list separately via `copyNovelcrafterPromptToClipboard`'s
  // return shape so the popover can warn before encoding.
  const contextMarkers = Array.isArray(prompt?.context_markers) ? prompt.context_markers : []
  const emitted = emitNovelcrafterMarkersForNn(contextMarkers)
  if (emitted.nc_markers.length > 0) {
    const block = emitted.nc_markers.join('\n')
    systemBody = systemBody ? `${systemBody}\n\n${block}` : block
  }
  const mockMessages = Array.isArray(prompt?.mock_messages) ? prompt.mock_messages : []
  const cues = Array.isArray(attachedCues) ? attachedCues.filter((c) => c && c.name) : []

  if (shape === 'bundle') {
    // Append `{include("Cue Name")}` markers for each cue and emit
    // components alongside the main prompt.
    let body = systemBody
    for (const c of cues) {
      const marker = `{include("${c.name}")}`
      body = body ? `${body}\n\n${marker}` : marker
    }
    const main = {
      $schema: NC_PROMPT_SCHEMA,
      type: effectiveType,
      name: safeName,
      messages: _buildMessagesArray(body, mockMessages),
    }
    const components = cues.map((c) => ({
      $schema: NC_PROMPT_SCHEMA,
      type: 'component',
      name: c.name,
      messages: [{ type: 'system', format: 'aic2', text: c.body || '' }],
    }))
    return [main, ...components]
  }

  if (shape === 'reference-only') {
    // Same as bundle's main but no components emitted.
    let body = systemBody
    for (const c of cues) {
      const marker = `{include("${c.name}")}`
      body = body ? `${body}\n\n${marker}` : marker
    }
    return {
      $schema: NC_PROMPT_SCHEMA,
      type: effectiveType,
      name: safeName,
      messages: _buildMessagesArray(body, mockMessages),
    }
  }

  // 'self-contained' (default) — inline each cue body into the
  // system message, separated by blank lines. Mirrors NC's "Copy
  // without any dependencies" behaviour: snippet content lands in
  // the prompt body so the destination doesn't need the snippet to
  // be present.
  let body = systemBody
  for (const c of cues) {
    const cueBody = (c.body || '').trim()
    if (!cueBody) continue
    body = body ? `${body}\n\n${cueBody}` : cueBody
  }
  return {
    $schema: NC_PROMPT_SCHEMA,
    type: effectiveType,
    name: safeName,
    messages: _buildMessagesArray(body, mockMessages),
  }
}


/**
 * Encode a JS object (nc:prompt:1 payload — single object or array)
 * into NC's clipboard blob format: JSON → gzip → base64.
 *
 * Uses native `CompressionStream('gzip')`. Same browser-support
 * footprint as the import decoder.
 *
 * @param {object|Array<object>} ncPayload
 * @returns {Promise<string>} the base64 text ready for the clipboard
 */
export async function encodeNovelcrafterPromptBlob(ncPayload) {
  const json = JSON.stringify(ncPayload)
  const bytes = new TextEncoder().encode(json)

  let gzipped
  try {
    const cs = new CompressionStream('gzip')
    const stream = new Blob([bytes]).stream().pipeThrough(cs)
    gzipped = new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    throw new Error("Couldn't gzip the prompt payload for NovelCrafter.")
  }

  // Bytes → base64 via a chunked toString approach. atob/btoa expects
  // one byte per char; we build the binary string in chunks to avoid
  // stack overflow on large payloads (`String.fromCharCode(...arr)`
  // for arr of ~50k+ throws "RangeError: Maximum call stack size
  // exceeded" on some engines).
  let raw = ''
  const CHUNK = 0x8000
  for (let i = 0; i < gzipped.length; i += CHUNK) {
    raw += String.fromCharCode.apply(null, gzipped.subarray(i, i + CHUNK))
  }
  try {
    return btoa(raw)
  } catch {
    throw new Error("Couldn't base64-encode the prompt payload.")
  }
}


/**
 * Top-level "Copy for NovelCrafter" helper. Builds the payload,
 * encodes, writes to clipboard, returns a small summary the caller
 * can surface in a banner ("Copied 'X' as <shape>; N cue(s)").
 *
 * Caller is expected to:
 *   - resolve `prompt.static_cue_ids` to `{name, body}` shapes by
 *     looking the ids up in `useContextCuesStore`,
 *   - HTML-strip each cue's body via `stripHtmlForNcExport` BEFORE
 *     passing it in (this util stays free of DOM access in its
 *     core encode path so it can be smoke-tested in Node).
 *
 * @param {object} prompt
 * @param {object} opts
 * @param {'self-contained'|'bundle'|'reference-only'} opts.shape
 * @param {Array<{name: string, body: string}>} opts.attachedCues
 * @param {string|null} [opts.ncType]
 * @returns {Promise<{shape: string, nc_type: string, cue_count: number, byte_length: number, prompt_name: string}>}
 */
export async function copyNovelcrafterPromptToClipboard(prompt, opts) {
  const payload = buildNovelcrafterExportPayload(prompt, opts)
  const base64 = await encodeNovelcrafterPromptBlob(payload)
  try {
    await navigator.clipboard.writeText(base64)
  } catch {
    throw new Error("Couldn't write to the clipboard. Allow clipboard access for this site and try again.")
  }
  const effectiveType = Array.isArray(payload) ? payload[0]?.type : payload.type
  const promptName = Array.isArray(payload) ? payload[0]?.name : payload.name
  const cueCount = (opts && Array.isArray(opts.attachedCues)) ? opts.attachedCues.length : 0
  // Phase 3.11c — re-run the emitter on the prompt's context_markers
  // so the caller can surface translation + unsupported counts in
  // the banner. Cheap: the same emitter ran inside
  // buildNovelcrafterExportPayload above; re-running it costs a few
  // lookups against a small array. Avoids threading the summary
  // through the build → encode path just to expose it here.
  const ctxMarkers = Array.isArray(prompt?.context_markers) ? prompt.context_markers : []
  const emitted = emitNovelcrafterMarkersForNn(ctxMarkers)
  return {
    shape: opts?.shape || 'self-contained',
    nc_type: effectiveType || '',
    cue_count: cueCount,
    byte_length: base64.length,
    prompt_name: promptName || '',
    emitted_marker_count: emitted.nc_markers.length,
    unsupported_marker_types: emitted.unsupported,
  }
}
