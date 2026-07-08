// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: wire. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "wire",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 50,
  title: "Wire",
  intro: "Wires are the lines that connect things on the canvas, and each kind carries a different meaning. Transition wires set the order of your scenes, relationship wires show which entities are bound together, and POV wires trace whose eyes the reader is seeing through. Reading them together tells you, at a glance, how your story flows and who is involved at each step.",
  screenshotFile: "wire.webp",
  screenshotAlt: "Wire screenshot.",
  sections: [
    { id: "relationship", label: "Relationship wire", region: { x: 3.4, y: 12.2, w: 54.6, h: 44.2 }, body: "Links the entities that take part in a relationship, drawn in their colours so you can see who is connected. It marks an identity-level bond between them, such as a friendship, rivalry, or membership, rather than the order events happen in." },
    { id: "transition", label: "Transition wire", region: { x: 27.8, y: 12.2, w: 15.3, h: 60.2 }, body: "Joins one scene to the next, setting the temporal order in which events occur. You can add a short note to it to describe what happens in the gap between the two scenes, such as the passage of time or a journey." },
    { id: "pov", label: "POV wire", region: { x: 80, y: 69, w: 17.1, h: 19.2 }, body: "A dashed line tracing the run of scenes told from one character's point of view, in the order the reader experiences them. This path is what defines your narrative sequence, since the story is read along the viewpoint character's thread rather than across the whole canvas." },
  ],
}
