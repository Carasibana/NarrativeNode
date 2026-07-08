// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-origin. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-origin",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 4,
  title: "Entity Origin",
  intro: "An entity node is where a character, location, item, or faction enters the story. It holds that entity's starting state: its name, type, colour, description, and attributes. From here, that starting state carries forward along the entity's own thread to every scene it appears in, until a scene changes something. Think of it as the entity's home base, the version everything later inherits from.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Entity Origin screenshot.",
  sections: [
    { id: "node", label: "Entity node", region: { x: 29.96, y: 9.37, w: 11.42, h: 22.96 }, body: "The entity node as a whole. It defines the entity's starting state, the baseline every later appearance inherits from, and is the place to set that baseline up before the entity ever reaches a scene.", target: {"type":"surface","ref":"entity-chip"} },
    { id: "header", label: "Name and type", region: { x: 30.17, y: 9.45, w: 11.17, h: 8.28 }, body: "The entity's name and type. Its colour and icon, shown here, identify it wherever it appears across the canvas." },
    { id: "attributes", label: "Attributes", region: { x: 30.17, y: 17.72, w: 11.17, h: 8.59 }, body: "The entity's attributes, the defining facts being tracked about it. The values shown here are its starting values, carried forward to later scenes until one of them changes a value." },
    { id: "description", label: "Description", region: { x: 30.17, y: 26.31, w: 11.17, h: 5.93 }, body: "The entity's description. Like its attributes, this is the starting text, in effect until a later scene gives the entity a new description." },
  ],
}
