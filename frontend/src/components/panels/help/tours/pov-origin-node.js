// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: pov-origin-node. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "pov-origin-node",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 7,
  title: "Pov Origin Node",
  intro: "The point-of-view origin is a small starting marker on the canvas that says where your story begins being told. From it runs the dashed point-of-view wire, which threads forward through the scenes in reading order. It holds no characters or text of its own; it simply anchors the start of that reading path, and there is one for the story.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Pov Origin Node screenshot.",
  sections: [
    { id: "badge", label: "Point-of-view badge", region: { x: 52.08, y: 45.36, w: 2.49, h: 2.33 }, body: "Marks the very start of the reading path. The dashed point-of-view wire leaves here and runs to your first point-of-view scene, so this is where the told order of your story begins.", target: {"type":"surface","ref":"pov-chip"} },
  ],
}
