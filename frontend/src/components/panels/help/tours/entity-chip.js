// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-chip. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-chip",
  category: "",
  tier: "element-detail",
  parent: "scene-node",
  order: 0,
  title: "Entity Chip",
  intro: "An entity chip is a character, location, item, or faction taking part in a scene. It is not the entity's master record but its presence at this one point in the story, showing the state it holds here once every change made along the way has been applied. Its output port lets you wire the entity onward to the next scene it appears in, or to a modifier node that records a change in its own thread.",
  screenshotFile: "entity-chip.webp",
  screenshotAlt: "Entity Chip screenshot.",
  sections: [
    { id: "identity", label: "Identity", region: { x: 1.5, y: 2.27, w: 98.5, h: 97.73 }, body: "The entity's name and colour as they stand at this scene, which may differ from where the entity began if something changed along the way. Select the chip to open its detail at this point in the story, where you can see and adjust its state here and have those changes carry forward to later scenes.", target: {"type":"surface","ref":"entity-origin"} },
  ],
}
