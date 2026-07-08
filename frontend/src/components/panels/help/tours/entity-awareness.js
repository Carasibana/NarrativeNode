// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-awareness",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "detail-character",
  order: 2,
  title: "Entity Awareness",
  intro: "The Awareness sub-tab of an entity's detail panel. Awareness tracks who knows what across your story, and this tab shows it from both sides at the point you are viewing: who is aware of this entity, and what this entity is aware of. Like every other value, awareness is read as it stands at this point in the story, and what you set here carries forward.",
  screenshotFile: "entity-awareness.webp",
  screenshotAlt: "Entity Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The entity's name and identity, shared across all four detail sub-tabs so you always know whose awareness you are looking at." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, where the entity's description, aliases, and tags live.", link: "detail-character" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the Attributes sub-tab, which shows the entity's attributes, circumstances, motivators, and perspectives at this point.", link: "entity-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the Relationships sub-tab, which shows who this entity is connected to and how those ties stand here.", link: "entity-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "The Awareness sub-tab, currently shown: who is aware of this entity and what this entity is aware of at this point in the story." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The awareness state at this point, shown from two directions. The Known by section lists who is aware of this entity and to what degree, from unaware through to fully aware; turn tracking on to record it. The Aware of section gathers everything this entity has learned about, the other side of the same picture. Use these to track secrets, reveals, and who is in the dark at any moment." },
  ],
}
