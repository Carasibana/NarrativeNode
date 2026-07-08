// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: chapter-header. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "chapter-header",
  category: "",
  tier: "element-detail",
  parent: "canvas-overview",
  order: 11,
  title: "Chapter Header",
  intro: "The chapter headers run in a strip above the canvas, labelling the column bands that group your scenes into chapters. A scene belongs to whichever chapter band it sits within, so these columns are how you organise the shape of your story. The strip also carries an optional acts row above the chapters, for grouping chapters into larger acts.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Chapter Header screenshot.",
  sections: [
    { id: "chapter_cell", label: "Chapter label", region: { x: 14.4, y: 4.3, w: 85.6, h: 3.4 }, body: "A chapter's label sitting above its column band. The scenes within that band belong to this chapter, giving your story its higher-level structure. Click it to frame the chapter in view, or double-click to rename it.", target: {"type":"surface","ref":"table-of-contents"} },
    { id: "acts_toggle", label: "Acts", region: { x: 98.15, y: 4.87, w: 1.45, h: 2.72 }, body: "Show or hide the acts row above the chapters. Acts are an optional larger grouping that spans several chapters, letting you organise a long story into its broad movements without affecting the chapters themselves." },
  ],
}
