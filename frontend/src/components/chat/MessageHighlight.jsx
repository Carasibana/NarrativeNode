/**
 * Phase 2.8a — name-highlight walker for chat message bubbles.
 *
 * `<Streamdown>` doesn't expose a standard `rehypePlugins` array
 * (its `plugins` prop is a `PluginConfig`-keyed object that the
 * renderer reads for built-in plugins like Mermaid only). To paint
 * chain-aware coloured highlights on names that appear inside
 * rendered message text, we instead do the work in the
 * `components` overrides: each block-level renderer (`p`, `li`,
 * `td`, `h1`-`h6`, `blockquote`) wraps its `children` through
 * `<HighlightChildren>`, which walks the React children tree once
 * per render and replaces text-node runs that match any name in
 * `targets` with `<span class="nn-entity-highlight">` elements
 * carrying the same `data-entity-id` / `data-entity-colour` /
 * `data-entity-type` attributes the composer's ProseMirror
 * decorations use — so a single click delegate higher in the
 * bubble tree can open the entity detail panel for either surface.
 *
 * Subtree rules — match the rehype-AST approach the ToDo entry
 * proposed:
 *   - Match runs in raw string children only.
 *   - Skip `<a>` (link text) entirely. The link's own colour /
 *     hover state takes priority over a name highlight, and we
 *     don't want to nest interactive spans inside an anchor.
 *   - Skip `<code>` and `<pre>` entirely. Code identifiers that
 *     happen to share a name with an entity shouldn't recolour.
 *   - Recurse INTO `<strong>` / `<em>` / `<u>` / `<s>` / `<span>`
 *     and any other formatting element — bold or italic prose
 *     still gets highlighted.
 *
 * Ambiguous matches (one typed name maps to >1 distinct object)
 * render with the accent colour + dotted underline + a `title`
 * tooltip listing the colliders, mirroring
 * `EntityHighlightPlugin.buildDecorations`'s ambiguous-visual
 * pattern.
 */

import { Children, Fragment, cloneElement, isValidElement } from 'react'


// Element tags whose subtrees the walker should not enter. Match
// the rehype-AST node-type list from the ToDo's plan: code blocks
// (`pre`, `code`), inline links (`a`).
const SKIP_TAGS = new Set(['a', 'code', 'pre'])


/** Build a regex matching any name in `targets` as a whole word.
 *  Names are sorted longest-first so "Mina Murray" is preferred
 *  over the alias "Mina" when both appear in the text. Case
 *  insensitive, global. Returns null when targets is empty. */
function buildMatchRegex(targets) {
  if (!targets || !targets.length) return null
  const sorted = [...targets].sort((a, b) => b.name.length - a.name.length)
  const escaped = sorted.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
}


/** Map of lowercased name → list of targets sharing that name.
 *  Lookup with `> 1` distinct entityId triggers the ambiguous
 *  visual; identical-name same-entity duplicates collapse to a
 *  single unambiguous match. */
function buildLookup(targets) {
  const lookup = new Map()
  for (const t of (targets || [])) {
    const key = t.name.toLowerCase()
    const list = lookup.get(key) || []
    list.push(t)
    lookup.set(key, list)
  }
  return lookup
}


/** Replace every regex match in `text` with a `<span>` decoration.
 *  Returns an array of children (mixed strings and React
 *  elements). Non-matching segments stay as raw strings so React
 *  doesn't generate unnecessary DOM. */
function highlightText(text, regex, lookup, accentColor, keyPrefix) {
  if (!text) return text
  regex.lastIndex = 0
  const out = []
  let lastIdx = 0
  let match
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start > lastIdx) {
      out.push(text.slice(lastIdx, start))
    }
    const matchedKey = match[0].toLowerCase()
    const targets = lookup.get(matchedKey) || []
    const distinctIds = new Set(targets.map((t) => t.entityId))
    if (targets.length === 0) {
      // Shouldn't happen — regex was built from `lookup`'s keys —
      // but guard defensively.
      out.push(match[0])
    } else if (distinctIds.size > 1) {
      const names = targets.map((t) => t.name).join(', ')
      const ids = targets.map((t) => t.entityId).join(',')
      const kinds = targets.map((t) => t.entityType).join(',')
      out.push(
        <span
          key={`${keyPrefix}-amb-${i}`}
          className="nn-entity-highlight nn-entity-highlight-ambiguous"
          style={{
            color: accentColor || '#a78bfa',
            textDecoration: 'underline dotted',
            textUnderlineOffset: 2,
            cursor: 'help',
          }}
          title={`Ambiguous match — could be any of: ${names}`}
          data-ambiguous="true"
          data-ambiguous-ids={ids}
          data-ambiguous-types={kinds}
        >
          {match[0]}
        </span>
      )
    } else {
      const target = targets[0]
      const imgRef = target.profileImageRef
      const assetName = imgRef ? imgRef.replace(/^assets\//, '') : ''
      out.push(
        <span
          key={`${keyPrefix}-m-${i}`}
          className="nn-entity-highlight"
          style={{ color: target.colour, cursor: 'pointer' }}
          data-entity-id={target.entityId}
          data-entity-colour={target.colour}
          data-entity-image={assetName}
          data-entity-type={target.entityType}
        >
          {match[0]}
        </span>
      )
    }
    lastIdx = end
    i++
  }
  if (lastIdx < text.length) {
    out.push(text.slice(lastIdx))
  }
  return out
}


/** Walk a React children tree, replacing string runs that match a
 *  target name with highlight spans. SKIPs `<a>` / `<code>` /
 *  `<pre>` subtrees verbatim. Recursion is shallow per element —
 *  we only enter elements whose tag isn't in SKIP_TAGS. */
function walkChildren(children, regex, lookup, accentColor, keyPath = 'h') {
  if (children == null || children === false) return children
  return Children.map(children, (child, idx) => {
    if (typeof child === 'string') {
      return highlightText(child, regex, lookup, accentColor, `${keyPath}-${idx}`)
    }
    if (typeof child === 'number' || typeof child === 'boolean') return child
    if (Array.isArray(child)) {
      return walkChildren(child, regex, lookup, accentColor, `${keyPath}-${idx}`)
    }
    if (isValidElement(child)) {
      const tag = typeof child.type === 'string' ? child.type : null
      if (tag && SKIP_TAGS.has(tag)) return child
      const newChildren = walkChildren(
        child.props?.children,
        regex,
        lookup,
        accentColor,
        `${keyPath}-${idx}`,
      )
      return cloneElement(child, undefined, newChildren)
    }
    return child
  })
}


/** Wrapper that any block-level component renderer can pipe its
 *  `children` through. When `enabled` is false or `targets` is
 *  empty, children pass through unchanged — no wrapping work
 *  done, no extra React nodes created. */
export function HighlightChildren({ children, targets, enabled, accentColor }) {
  if (!enabled || !targets || !targets.length) return <>{children}</>
  const regex = buildMatchRegex(targets)
  if (!regex) return <>{children}</>
  const lookup = buildLookup(targets)
  return <Fragment>{walkChildren(children, regex, lookup, accentColor)}</Fragment>
}
