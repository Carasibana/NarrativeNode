// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-chain. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-chain",
  category: "Concepts",
  tier: "base",
  parent: "relationship-origin",
  order: 0,
  title: "Relationship Chain",
  intro: "A relationship is not fixed: it begins somewhere, gains and loses members, and shifts in tone and standing as the story goes on. Rather than storing a single snapshot, NarrativeNode records each of these moments at the scene where it happens and carries the result forward from there. This tour shows how that history reads scene by scene: where the relationship starts, where someone joins or leaves, and how a participant's role can change along the way. Reading it at any scene tells you exactly where the relationship stood at that moment.",
  screenshotFile: "relationship-chain.webp",
  screenshotAlt: "Relationship Chain screenshot.",
  sections: [
    { id: "started", label: "Relationship begins", region: { x: 16.6, y: 40.2, w: 19.2, h: 8.3 }, body: "The scene where the relationship comes into being. From this point onward it exists in the story and its starting set of participants is in effect, until something later changes that." },
    { id: "joined", label: "Participant joins", region: { x: 6.2, y: 51, w: 90.3, h: 22.2 }, body: "Someone becoming part of the relationship at this scene. A join, like a later departure, is pinned to the scene where it happens and carries forward from there, so the relationship's membership at any point is the sum of everyone who has joined and not since left." },
    { id: "roles", label: "Roles", region: { x: 6.2, y: 74.5, w: 90.3, h: 22.2 }, body: "Each participant's role within the relationship, such as their rank or standing. A role can be changed at a later scene, and the role shown here is the one in effect at the point on the story you are viewing rather than a single fixed label." },
  ],
}
