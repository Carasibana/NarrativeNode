// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: modifier. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "modifier",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 8,
  title: "Modifier",
  intro: "A modifier is a small change applied to one entity at a point between two scenes, without belonging to a scene itself. Use it when something happens to an entity off the page: an item is destroyed, a character is wounded, a place falls into ruin. It alters a value, and that change carries forward to every scene that follows it along the entity's thread.",
  screenshotFile: "modifier.webp",
  screenshotAlt: "Modifier screenshot.",
  sections: [
    { id: "badge", label: "Change badge", region: { x: 7.81, y: 10.62, w: 38.12, h: 21.88 }, body: "Marks this as a modifier and shows the kind of change it makes to the entity at this point. It is the way a change can happen between scenes rather than inside one, with the new value carried forward from here on.", target: {"type":"surface","ref":"entity-chain"} },
    { id: "in_port", label: "Input port", region: { x: 0.31, y: 20.62, w: 3.75, h: 7.5 }, body: "Where the entity's thread arrives from the scene before it. The state coming in is what the modifier is about to change." },
    { id: "out_port", label: "Output port", region: { x: 95.62, y: 20.62, w: 3.75, h: 7.5 }, body: "Where the entity's thread leaves, now carrying the changed value. It connects on to the scenes that follow, all of which inherit the change." },
  ],
}
