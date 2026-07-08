// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: dock-zones. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "dock-zones",
  category: "",
  tier: "base",
  parent: "dock",
  order: 0,
  title: "Dock Zones",
  intro: "The Editor and the chat panel dock to the edges of the workspace, either in the right sidebar or along a strip below the canvas. When you drag a panel to re-dock it, highlighted drop zones show where it will land. These handles let you set how much room a docked panel takes, and how two panels divide a shared spot, so neither the panel nor the canvas crowds the other.",
  screenshotFile: "dock-zones.webp",
  screenshotAlt: "Dock Zones screenshot.",
  sections: [
    { id: "right_resize", label: "Resize", region: { x: 1.7, y: 0.57, w: 1.46, h: 98.85 }, body: "Drag this edge to make the docked panel wider or narrower. The canvas gives up or reclaims the space as you pull, down to a point that always keeps the canvas usable." },
    { id: "panel_divider", label: "Divider", region: { x: 49.76, y: 0.57, w: 0.73, h: 98.85 }, body: "When the Editor and the chat panel share one spot, this bar sits between them. Drag it to give one more room and the other less, so you can favour whichever you are leaning on right now." },
  ],
}
