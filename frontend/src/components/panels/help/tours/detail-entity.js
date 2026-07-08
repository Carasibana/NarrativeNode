// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: detail-entity. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "detail-entity",
  category: "Detail Panel",
  tier: "base",
  parent: "entity-library",
  order: 4,
  title: "Detail Entity",
  intro: "This panel shows one entity, an item here, as it stands at a chosen point in the story. An entity is not fixed: it begins from a starting state and can change as the narrative moves forward, and this panel always reflects the state in effect at the point you have selected. The navigation bar and sub-tabs let you move along the entity's story and split its picture into details, attributes, relationships, and awareness.",
  screenshotFile: "detail-entity.webp",
  screenshotAlt: "Detail Entity screenshot.",
  sections: [
    { id: "nav", label: "Navigation bar", region: { x: 1.5, y: 5.9, w: 96, h: 2.4 }, body: "Moves the panel through the entity's story: step back and forward across the points where it changes, or jump up to the scene that contains it. The position you land on is the point whose state the rest of the panel reflects." },
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Identifies the entity you are looking at: its name, type, and colour as they stand at the selected point in the story. If any of these were changed earlier in the narrative, the values shown here are the ones carried forward to this point." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "The Details sub-tab, shown here. It covers the entity's descriptive identity at this point: its description, any aliases it goes by, and the tags filed against it." },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Opens the Attributes sub-tab, which lists the entity's attributes as they stand at this point in the story. Attributes are the trackable facts about the entity that can change as the narrative unfolds.", link: "item-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Opens the Relationships sub-tab, showing the connections this entity has with others at this point: which entities it is tied to and how those ties stand here. Relationships answer who or what is bound to this entity and how that stands at this point.", link: "item-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Opens the Awareness sub-tab, which tracks who knows what about this entity at this point: who is aware of it, its attributes, or its aliases, and who is deliberately kept in the dark. It is how you keep track of secrets and reveals across the story.", link: "item-awareness" },
    { id: "body", label: "Body", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The contents of whichever sub-tab is selected, all shown as they stand at the point in the story you are viewing. Editing a value here records the change from this point forward rather than rewriting the entity everywhere." },
  ],
}
