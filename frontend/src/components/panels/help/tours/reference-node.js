// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: reference-node. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "reference-node",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 10,
  title: "Reference Node",
  intro: "A reference node is a free-standing card you can park anywhere on the canvas to keep supporting material close to the work: a mood image, a research note, a reminder, or a tagged scrap you want to find again later. A third kind, the concept note, adds connection ports so you can wire ideas into a loose map of their own. Every kind is for your eyes only and stays outside the story itself, so it never joins an entity's or relationship's history and never affects what gets exported. Think of it as a sticky note pinned to the board rather than a beat in the plot. Drop as many as you like, colour and tag them, and arrange them wherever they help.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Reference Node screenshot.",
  sections: [
    { id: "node", label: "Reference node", region: { x: 29.23, y: 41.47, w: 14.54, h: 44.75 }, body: "The card as a whole: a place to keep a note, a piece of media, or a concept note beside your story without it taking part in the narrative. You can move, resize, and collapse it freely, and nothing on it is carried forward to any scene." },
    { id: "header", label: "Title", region: { x: 29.27, y: 41.55, w: 14.45, h: 3.03 }, body: "The reference's title and its colour swatch. The colour is purely for your own visual sorting on the canvas, letting you group related cards at a glance; the title can be left blank when the content speaks for itself." },
    { id: "tags", label: "Tags", region: { x: 29.27, y: 44.57, w: 14.45, h: 2.82 }, body: "Labels you attach to this reference so it can be grouped and filtered alongside others that share the same tag. They make a scattered set of cards searchable when your canvas fills up." },
    { id: "body", label: "Content", region: { x: 29.27, y: 47.39, w: 14.45, h: 38.75 }, body: "The reference's actual material: either free note text or an attached image or media file. This is the supporting content you want on hand, kept entirely separate from your scenes and entities." },
  ],
}
