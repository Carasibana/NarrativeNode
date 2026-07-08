// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-origin. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-origin",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 6,
  title: "Knowledge Origin",
  intro: "A knowledge node is the canvas home of a single fact in your story: a secret, a rumour, or a revelation you want to follow. It marks where that fact enters the story and holds its defining name, colour, and description. From here you wire the knowledge out to the characters and scenes it touches, and each observer's awareness of it is tracked separately, so you can show exactly who knows what at any point.",
  screenshotFile: "knowledge-origin.webp",
  screenshotAlt: "Knowledge Origin screenshot.",
  sections: [
    { id: "port", label: "Output port", region: { x: 95.23, y: 12.59, w: 4.55, h: 7.41 }, body: "The point you drag a wire from to grant awareness of this fact. Connect it to a character at their starting point or to a character within a scene, and that character becomes aware of the knowledge from that point in the story forward." },
    { id: "header", label: "Name and colour", region: { x: 1.82, y: 24.07, w: 97.73, h: 29.63 }, body: "The knowledge's name and identifying colour, which is how this fact is recognized everywhere it is referenced. Clicking opens the detail panel, where you can review and adjust the knowledge and who is aware of it.", target: {"type":"surface","ref":"knowledge-chip"} },
    { id: "body", label: "Details", region: { x: 1.82, y: 53.7, w: 97.73, h: 45.93 }, body: "The defining description of the fact: what it actually is. This is the starting account of the knowledge, carried forward through the story unless a later scene revises it." },
  ],
}
