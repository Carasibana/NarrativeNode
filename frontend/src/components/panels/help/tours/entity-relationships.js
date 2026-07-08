// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-relationships. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-relationships",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "detail-character",
  order: 1,
  title: "Entity Relationships",
  intro: "The Relationships sub-tab of an entity's detail panel. A relationship is a connection this entity shares with others: a friendship, a rivalry, faction membership, a place it sits inside. Like everything else in the panel, what you see here is the picture at the point in the story you currently have selected, so a bond that forms or ends partway through shows up only from that point onward. Use this tab to read who this entity is tied to right now, and to record changes to those ties at this scene.",
  screenshotFile: "entity-relationships.webp",
  screenshotAlt: "Entity Relationships screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The entity's name and identity, shown the same way across all four sub-tabs so you always know who you are looking at as you move between Details, Attributes, Relationships, and Awareness." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, which holds this entity's name, colour, image, and description as they stand at this point in the story.", link: "detail-character" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the Attributes sub-tab, where this entity's tracked traits and their values are read and changed at this point in the story.", link: "entity-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "The sub-tab shown now. It gathers every connection this entity takes part in, separate from its own traits, because a relationship is shared between entities rather than owned by one." },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to the Awareness sub-tab, which tracks who knows what about this entity: who is aware it exists, and who is in the dark, at this point in the story.", link: "entity-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The relationships this entity is part of at the point you have selected, each showing the role or label it carries and how it views the others. Membership in a faction or a place it sits inside is grouped on its own; you can open any relationship for its full detail, or add and adjust ties so the change is recorded here and carried forward from this scene." },
  ],
}
