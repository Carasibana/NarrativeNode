// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: export-dialog. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "export-dialog",
  category: "Dialogs",
  tier: "element-detail",
  parent: "app-menu",
  order: 2,
  title: "Export Dialog",
  intro: "Turn your story into a finished file you can read, print, or hand to another tool. Start with a preset for a ready-made look, or open Customize to control the format, page size, and exactly how much of the story goes in. Because the canvas tracks far more than the prose, the choices here decide whether you get a clean reading copy or a detailed working document. The footer runs the export once you are set.",
  screenshotFile: "export-dialog.webp",
  screenshotAlt: "Export Dialog screenshot.",
  sections: [
    { id: "preset", label: "Presets", region: { x: 2.5, y: 11.11, w: 95, h: 33.15 }, body: "Ready-made combinations of format and styling for common needs, so you can pick a finished look in one click instead of setting every option yourself. Choosing a preset fills in the settings below; Customize lets you take over from there." },
    { id: "preset_native", label: "Native", region: { x: 2.65, y: 15.41, w: 23.53, h: 5.73 }, body: "Exports the full working picture, including the structure and detail you see in the application rather than just the finished prose. Best when you want a complete reference copy of everything you have tracked." },
    { id: "preset_prose", label: "Prose", region: { x: 2.65, y: 21.15, w: 23.53, h: 5.73 }, body: "Exports only the written scenes as clean, readable text, leaving the tracking detail behind. This is the choice for a reading copy or a draft to share." },
    { id: "preset_shunn", label: "Manuscript", region: { x: 2.65, y: 26.88, w: 23.53, h: 5.73 }, body: "Exports in the standard manuscript layout editors and agents expect, with conventional spacing and formatting. Use this when you are preparing work for submission." },
    { id: "preset_novelcrafter", label: "Novelcrafter", region: { x: 2.65, y: 32.62, w: 23.53, h: 5.73 }, body: "Produces two files shaped to import cleanly into Novelcrafter: a manuscript, with your scene bodies separated by ***, and an entity codex of your characters, places, and other objects. You choose whether the manuscript carries your prose or your scene summaries, one or the other rather than both. You can take the two files separately or together as a single zip bundle." },
    { id: "preset_customize", label: "Customize", region: { x: 2.65, y: 38.35, w: 23.53, h: 5.73 }, body: "Skips the ready-made presets and opens the individual settings so you can set the format, page size, scope, and detail level yourself. Use this when none of the presets matches what you need." },
    { id: "format", label: "Format", region: { x: 2.5, y: 47.85, w: 95, h: 7.71 }, body: "The kind of file you end up with. Each format suits a different destination, from a printable page to plain text you can paste anywhere." },
    { id: "format_pdf", label: "PDF", region: { x: 2.5, y: 51.97, w: 6.69, h: 3.58 }, body: "Produces a fixed, page-laid-out document that looks the same everywhere and prints reliably. Good for a finished copy you will not edit further." },
    { id: "format_docx", label: "Word", region: { x: 11.54, y: 51.97, w: 14.63, h: 3.58 }, body: "Produces an editable Word document, the usual format for further editing and for sharing with editors who mark up as they read." },
    { id: "format_markdown", label: "Markdown", region: { x: 28.53, y: 51.97, w: 12.8, h: 3.58 }, body: "Produces lightweight text with simple formatting marks, ideal for writing tools and note apps that read Markdown." },
    { id: "format_html", label: "Web page", region: { x: 43.68, y: 51.97, w: 8.45, h: 3.58 }, body: "Produces a web page you can open in any browser. Handy for reading on screen or posting online." },
    { id: "format_txt", label: "Plain text", region: { x: 54.48, y: 51.97, w: 11.43, h: 3.58 }, body: "Produces unformatted text with no styling at all, the most portable option for pasting into any program." },
    { id: "page_size", label: "Page size", region: { x: 2.5, y: 59.14, w: 95, h: 7.71 }, body: "The paper size used when the format lays content out in pages. This only matters for the paged formats; text and web formats ignore it." },
    { id: "page_size_a4", label: "A4", region: { x: 2.5, y: 63.26, w: 16.21, h: 3.58 }, body: "Uses A4 pages, the standard size in most of the world." },
    { id: "page_size_letter", label: "Letter", region: { x: 21.06, y: 63.26, w: 16.65, h: 3.58 }, body: "Uses Letter pages, the standard size in North America." },
    { id: "scope", label: "Scope", region: { x: 2.5, y: 70.43, w: 95, h: 17.03 }, body: "How much of the story to include. Since your canvas can hold scenes that sit off to the side or outside the main thread, this is where you decide whether to export everything or just the through-line." },
    { id: "scope_whole", label: "Whole story", region: { x: 2.5, y: 74.55, w: 95, h: 3.58 }, body: "Includes every scene in the story. Use this for a complete export when you want nothing left out." },
    { id: "scope_pov_only", label: "Point of view only", region: { x: 2.5, y: 79.21, w: 95, h: 3.58 }, body: "Includes just the scenes along the point-of-view path and arranges them in reading order, the sequence a reader actually follows. This gives you the narrative as it is meant to be read, leaving out the off-screen and side material." },
    { id: "scope_selected", label: "Selected", region: { x: 2.5, y: 83.87, w: 95, h: 3.58 }, body: "Includes only the scenes you have picked out, letting you export a single chapter, an act, or any handful of scenes you want on their own." },
    { id: "footer", label: "Footer", region: { x: 0.15, y: 90.32, w: 99.71, h: 9.5 }, body: "The controls that close out the dialog. The export action runs the export itself, and Cancel backs out without exporting. A Save as default button appears only when you are on the Customize preset, so you can keep your current choices for next time; the other presets show just Cancel and the export action." },
    { id: "export_button", label: "Export", region: { x: 88.98, y: 92.65, w: 8.52, h: 5.02 }, body: "Runs the export with the settings above and writes the file. This is the final step once your format and scope are set." },
  ],
}
