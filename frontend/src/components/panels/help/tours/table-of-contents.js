// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: table-of-contents. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "table-of-contents",
  category: "Dialogs",
  tier: "base",
  parent: "menu-bar",
  order: 1,
  title: "Table Of Contents",
  intro: "The table of contents is a structured outline of your whole story: its acts, chapters, and scenes laid out in order. It is the fastest way to find your place, giving you a reading-like overview instead of the spatial canvas. Select any scene to jump straight to it on the canvas, and pin the panel to keep it beside you as you work.",
  screenshotFile: "table-of-contents.webp",
  screenshotAlt: "Table Of Contents screenshot.",
  sections: [
    { id: "pov_filter", label: "Reading order", region: { x: 77.7, y: 4.1, w: 8.86, h: 9.11 }, body: "Switches the outline between canvas order and reading order, following the point-of-view path that defines how the story is actually told. Use it to see your scenes in the sequence a reader would meet them, with off-screen scenes set aside." },
    { id: "pin", label: "Pin", region: { x: 88.44, y: 4.56, w: 7.5, h: 8.2 }, body: "Keeps the table of contents open so it stays in view as you move around the canvas. Unpinned, the panel closes once you click away." },
    { id: "outline", label: "Outline", region: { x: 0.31, y: 17.31, w: 99.38, h: 82.23 }, body: "The list of your acts, chapters, and scenes in order, mirroring the structure of your story. Select any entry to jump to that scene on the canvas and bring it into focus." },
  ],
}
