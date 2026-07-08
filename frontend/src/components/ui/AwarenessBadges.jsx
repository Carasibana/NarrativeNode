/**
 * Awareness visual primitives — shared across the Phase 1.21 awareness
 * surfaces (picker, Awareness Panel, Aliases Panel, sub-chips on scenes,
 * Detail Panel "Who knows this?" section, hover tooltips).
 *
 * Visual language:
 *   - Square, sharp-cornered frame. Unique to awareness — no other chip
 *     indicator in the app uses sharp corners, so "awareness" is readable
 *     at a glance.
 *   - Colour + glyph keyed purely by integer level. Integers are semantic
 *     across scales: `0` always means "explicitly unaware", `3` always
 *     means "fully aware / knows the linkage".
 *
 *   Level 0 → red   ✕  Explicitly unaware        (shared across all surfaces)
 *   Level 1 → blue  ⯁  Knows the name             (alias scale only; face-value)
 *   Level 2 → amber ⁉  Knows it's a pseudonym     (alias scale only)
 *   Level 3 → green ✓  Knows the alias and whose it is
 *                                                (shared: binary "Aware" ↔ alias full)
 *
 * Scale coverage:
 *   - Binary surfaces (Entity / Attribute / Relationship existence): {0, 3}.
 *     Only the two endpoints apply; `1` and `2` are alias-only.
 *   - Alias surfaces: {0, 1, 2, 3}.
 *
 * Exports:
 *   - `SCALE_BINARY`, `SCALE_ALIAS`, `scaleFor(surface)` — scale metadata.
 *   - `DEFAULT_AWARENESS_LEVEL` — the highest positive level (3), used as
 *     the default when adding a new entity to an awareness dict.
 *   - `awarenessLevelStyle(level)` — pure function → { icon, frame }.
 *   - `<AwarenessBadge>` — static display-only variant (span, not button).
 *   - `<AwarenessLevelPill>` — single interactive button variant.
 *   - `<AwarenessLevelSelector>` — full multi-pill selector for a scale.
 */

// ── Scale definitions ──────────────────────────────────────────────────────

// `labels` are the verbose default strings used when no context is provided
// (fallback tooltips, dev preview, orphan displays). `shortLabels` are the
// concise names used in compact UI surfaces like group headers where the
// parent object's name is already on-screen elsewhere — "Unaware" reads
// cleaner than the full context-aware "Doesn't know about 'X'". Surface-
// specific helpers (`awarenessLabelsFor` below) still produce the context-
// aware long form for hover tooltips.
export const SCALE_BINARY = {
  levels: [0, 3],
  labels: {
    0: 'Explicitly unaware',
    3: 'Aware',
  },
  shortLabels: {
    0: 'Unaware',
    // Binary mode has no gradation to contrast against — "Aware" reads
    // cleaner than "Fully aware" here. The graduated (alias) scale still
    // uses "Fully aware" at level 3 to distinguish from "Partially aware".
    3: 'Aware',
  },
}

export const SCALE_ALIAS = {
  levels: [0, 1, 2, 3],
  labels: {
    0: 'Explicitly unaware',
    1: 'Knows the name',
    2: 'Knows it’s a pseudonym, but not whose',
    3: 'Knows the alias and whose it is',
  },
  shortLabels: {
    0: 'Unaware',
    1: 'Nominally aware',
    2: 'Partially aware',
    3: 'Fully aware',
  },
}

export function scaleFor(surface) {
  // Alias + Knowledge both use the 4-level scale (0/1/2/3) because the
  // "knows it exists but not details" gradations map naturally to both.
  // All other surfaces (entity / attribute / relationship) use the binary
  // scale (0/3).
  if (surface === 'alias' || surface === 'knowledge') return SCALE_ALIAS
  return SCALE_BINARY
}

// Highest positive level across both scales. Used as the default-on-add
// and self-seed level regardless of surface.
export const DEFAULT_AWARENESS_LEVEL = 3

// ── Context-aware labels ───────────────────────────────────────────────────

/**
 * Return level-keyed tooltip labels tailored to a specific surface
 * instance. `context` carries the real names to substitute:
 *   { parentName?, aliasValue?, attributeName?, relationshipName? }
 *
 * When the required context field(s) for a surface are present, returns
 * context-aware strings. When missing, falls back to the generic static
 * labels on SCALE_BINARY / SCALE_ALIAS — preserving usability in contexts
 * that don't carry surface-specific names yet (dev preview, mock data,
 * read-only displays of data that's lost its referents).
 *
 * A future JSX-returning companion (`awarenessLabelNodesFor`) will render
 * the same substitutions as inline `<EntityAvatarName>` badges for use in
 * richer contexts (Detail Panel "Who knows this?" section, custom hover
 * overlays). Not needed for native `title=` tooltips — those only accept
 * plain strings.
 */
export function awarenessLabelsFor(surface, context = {}) {
  const { parentName, aliasValue, attributeName, relationshipName, observerName } = context || {}

  // Phase 1.21g — when `observerName` is supplied in context, prefix
  // every label with it ("Preston doesn't know Alice's name 'Alice'").
  // The verb is lower-cased mid-sentence; capitalise it back when no
  // observer prefix is in play. Centralised so every surface gets the
  // same treatment.
  const prefix = (s) => observerName ? `${observerName} ${s}` : capitaliseFirst(s)

  if (surface === 'alias') {
    if (parentName && aliasValue) {
      return {
        0: prefix(`doesn't know ${parentName}'s alias "${aliasValue}"`),
        1: prefix(`knows the name "${aliasValue}" but doesn't know it's an alias`),
        2: prefix(`knows "${aliasValue}" is an alias, but not whose`),
        3: prefix(`knows "${aliasValue}" is ${parentName}`),
      }
    }
    return SCALE_ALIAS.labels
  }

  // Canonical-name surface — the 4-level alias scale applied to the
  // entity's TRUE name (distinct from existence-binary `entity` surface).
  if (surface === 'entity_name') {
    const { nameValue } = context || {}
    if (parentName && nameValue) {
      return {
        0: prefix(`doesn't know ${parentName}'s name "${nameValue}"`),
        1: prefix(`has heard the name "${nameValue}"`),
        2: prefix(`knows someone has the name "${nameValue}", but not who`),
        3: prefix(`knows ${parentName}'s name is "${nameValue}"`),
      }
    }
    return SCALE_ALIAS.labels
  }

  if (surface === 'attribute') {
    if (parentName && attributeName) {
      // Phase 1.21g — attribute surfaces can be either binary {0, 3} or
      // graded {0, 1, 2, 3} per-attribute. The labels below cover all
      // four levels; the picker only renders the levels permitted by the
      // attribute's `awareness_scale`. Level-0 and level-3 phrasing reads
      // as "knows / doesn't know about ..." (existence + value); the
      // intermediate levels distinguish partial-knowledge cases:
      //   1 = knows the attribute exists but not its value (nominal)
      //   2 = has partial info about the value
      return {
        0: prefix(`doesn't know about ${parentName}'s ${attributeName}`),
        1: prefix(`knows ${parentName} has a ${attributeName} but doesn't know its value`),
        2: prefix(`has partial awareness of ${parentName}'s ${attributeName}`),
        3: prefix(`knows about ${parentName}'s ${attributeName}`),
      }
    }
    return SCALE_BINARY.labels
  }

  if (surface === 'relationship') {
    if (relationshipName) {
      return {
        0: prefix(`doesn't know about "${relationshipName}"`),
        3: prefix(`knows about "${relationshipName}"`),
      }
    }
    return SCALE_BINARY.labels
  }

  // Knowledge surface uses the 4-level scale like aliases, but the
  // observer-side framing is "knows about this knowledge" rather than
  // "knows whose alias this is". When the knowledge has a name we
  // substitute it; otherwise fall back to the generic alias labels.
  if (surface === 'knowledge') {
    if (parentName) {
      return {
        0: prefix(`doesn't know about "${parentName}"`),
        1: prefix(`has heard of "${parentName}"`),
        2: prefix(`knows something of "${parentName}", but not the whole story`),
        3: prefix(`fully knows "${parentName}"`),
      }
    }
    return SCALE_ALIAS.labels
  }

  // Entity surface (default).
  if (parentName) {
    return {
      0: prefix(`doesn't know ${parentName}`),
      3: prefix(`knows ${parentName}`),
    }
  }
  return SCALE_BINARY.labels
}

function capitaliseFirst(s) {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Per-level visual style ─────────────────────────────────────────────────

export function awarenessLevelStyle(level) {
  // `frame` (combined) is kept for existing pill/badge consumers.
  // `border` / `text` / `bg` are exposed separately so the groups-mode
  // awareness picker can apply just the border + text colour to a
  // container and use the background tint only in the group header.
  if (level === 0) {
    return {
      icon: '✕',
      frame: 'border-red-500 text-red-400 bg-red-950/40',
      border: 'border-red-500',
      text: 'text-red-400',
      bg: 'bg-red-950/40',
    }
  }
  if (level === 1) {
    return {
      icon: '⯁',
      frame: 'border-blue-500 text-blue-400 bg-blue-950/40',
      border: 'border-blue-500',
      text: 'text-blue-400',
      bg: 'bg-blue-950/40',
    }
  }
  if (level === 2) {
    return {
      icon: '⁉',
      frame: 'border-amber-500 text-amber-400 bg-amber-950/40',
      border: 'border-amber-500',
      text: 'text-amber-400',
      bg: 'bg-amber-950/40',
    }
  }
  if (level === 3) {
    return {
      icon: '✓',
      frame: 'border-emerald-500 text-emerald-400 bg-emerald-950/40',
      border: 'border-emerald-500',
      text: 'text-emerald-400',
      bg: 'bg-emerald-950/40',
    }
  }
  return {
    icon: '?',
    frame: 'border-zinc-600 text-zinc-400 bg-zinc-800',
    border: 'border-zinc-600',
    text: 'text-zinc-400',
    bg: 'bg-zinc-800',
  }
}

// ── Components ─────────────────────────────────────────────────────────────

/** Static, display-only awareness badge. Use when you want to show a level
 *  as an indicator but have no interaction — sub-chips, detail rows, hover
 *  tooltips, etc. Renders as a `<span>` to be embeddable inside any other
 *  clickable element without breaking the accessibility tree.
 *
 *  Phase 1.21h Fix #4 — `scale` is an optional non-destructive view filter:
 *  when `'binary'`, any non-zero stored level (1, 2, or 3) renders under
 *  the level-3 ✓ glyph. Level 0 always renders as 0. Stored data is
 *  unchanged; flipping the scale back to `'full'` (or omitting the prop)
 *  restores the original level glyph. */
export function AwarenessBadge({ level, title, size = 16, scale = null }) {
  const displayLevel = (scale === 'binary' && typeof level === 'number' && level > 0) ? 3 : level
  const s = awarenessLevelStyle(displayLevel)
  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center border leading-none ${s.frame}`}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.56)) }}
      data-help-region="badge:awareness_badge"
    >
      {s.icon}
    </span>
  )
}

/** Single interactive pill — button variant. Active levels render at full
 *  opacity; inactive levels dim to 35% with a hover lift to 70%. `active`
 *  is required so callers explicitly opt into the highlighted state.  */
export function AwarenessLevelPill({ level, active, title, onClick, disabled, size = 16 }) {
  const s = awarenessLevelStyle(level)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={!!active}
      className={`inline-flex items-center justify-center border leading-none transition-opacity ${s.frame} ${
        active ? 'opacity-100' : 'opacity-35 hover:opacity-70'
      }`}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.56)) }}
    >
      {s.icon}
    </button>
  )
}

/** Multi-pill selector for a full scale. Renders one pill per level in
 *  the scale (2 for binary, 4 for alias / knowledge), with only the
 *  active level at full opacity and the rest dimmed. Clicking any pill
 *  commits its level via `onChange`. Binary mode keeps the same
 *  active-pill-detection rule used for backwards-compat with stored
 *  gradation values: any positive stored level (1, 2, or 3) reads as
 *  "aware" and highlights the level-3 pill in binary mode. */
export function AwarenessLevelSelector({ scale, value, onChange, disabled, size = 16 }) {
  const { levels, labels } = scale
  const isBinary = levels.length === 2
  // In binary mode, treat any positive stored level (1, 2, or 3) as
  // "aware" and highlight the level-3 pill. Preserves underlying
  // gradation for surfaces like Knowledge that may carry level 1 / 2
  // data but are currently rendered in binary mode.
  const activeLevel = isBinary && typeof value === 'number' && value > 0 ? 3 : value
  return (
    <div className="inline-flex gap-0.5">
      {levels.map((lvl) => (
        <AwarenessLevelPill
          key={lvl}
          level={lvl}
          active={activeLevel === lvl}
          title={labels[lvl]}
          onClick={() => onChange(lvl)}
          disabled={disabled}
          size={size}
        />
      ))}
    </div>
  )
}
