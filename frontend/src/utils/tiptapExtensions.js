/**
 * The single registered TipTap extension set for the reference / concept node
 * body. Shared so every place that serialises to or from the body's TipTap-JSON
 * content uses the IDENTICAL set:
 *   - `ReferenceNode.jsx` — `generateHTML(json, TIPTAP_EXTENSIONS)` to render.
 *   - the MCP `create_concept` handler — `generateJSON(html, TIPTAP_EXTENSIONS)`
 *     to store a rich-text body the AI passes as HTML.
 * They MUST match or an HTML ↔ TipTap-JSON round-trip drops nodes/marks.
 *
 * StarterKit v3 bundles Underline + Link. Link is fully disabled (the toolbar
 * link button was removed for being too inconsistent to ship); Underline is
 * disabled inside StarterKit so the explicit Underline below is the single
 * registered copy.
 */
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, FontSize, FontFamily } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import { SectionExtension } from '../components/ui/SectionExtension'

export const TIPTAP_EXTENSIONS = [
  StarterKit.configure({ link: false, underline: false }),
  Underline,
  Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TextStyle,
  FontSize,
  FontFamily,
  Color,
  SectionExtension,
]
