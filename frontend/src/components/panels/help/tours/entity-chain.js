// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-chain. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-chain",
  category: "Concepts",
  tier: "base",
  parent: "entity-origin",
  order: 0,
  title: "Entity Chain",
  intro: "A character, location, item, or faction does not live in one place: it threads through every scene it appears in, carrying its state from one appearance to the next. Each appearance starts from whatever was true at the previous one, so the entity always arrives at a scene already holding the name, colour, description, attributes, and relationships it had upstream. When you change something at a scene, that change is carried forward and stays in effect at every later appearance until you change it again. This forward-carrying thread is the entity chain, and it is what lets the same person evolve across the whole story without you re-entering their details scene by scene.",
  screenshotFile: "entity-chain.webp",
  screenshotAlt: "Entity Chain screenshot.",
  sections: [
    { id: "chain_wires", label: "Chain wires", region: { x: 0, y: 23.12, w: 100, h: 21.25 }, body: "These wires join one appearance of an entity to its next appearance, and their direction is what sets the order of the chain. State travels the way the wires point, so an entity reads its starting state from upstream and carries any change forward to everything wired after it." },
    { id: "recurring_entity", label: "Recurring entity", region: { x: 50.65, y: 23.75, w: 9.16, h: 19.38 }, body: "This is the same entity showing up again later in the story, not a fresh copy of it. It inherits everything that was true earlier in the chain, so a change you made at an earlier point is already in effect here without being re-entered.", target: {"type":"surface","ref":"entity-origin"} },
  ],
}
