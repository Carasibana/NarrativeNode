// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: item-relationships. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "item-relationships",
  category: undefined,
  tier: "element-detail",
  parent: "detail-entity",
  order: 1,
  title: "Item Relationships",
  intro: "The Relationships sub-tab shows the connections this item shares with other entities, such as the character who carries it or the faction it belongs to. Each connection is a story object in its own right, so what you see here is how it stands at the point in the story you are viewing, including any role or label the item holds within it. Use it to track how an object's place in the story shifts as it changes hands or gains significance.",
  screenshotFile: "item-relationships.webp",
  screenshotAlt: "Item Relationships screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Names the item you are viewing and stays fixed while you move between its Details, Attributes, Relationships, and Awareness sub-tabs, so you always know which object the panel is describing." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the item's core identity: its name, colour, description, and any aliases as they stand at this point in the story.", link: "detail-entity" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the item's properties, along with any circumstances and motivators tied to it, as they stand at this point in the story.", link: "item-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "The sub-tab you are on. It lists the connections this item takes part in, shown as they stand at this point in the story." },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to who knows about this item and what the item is aware of, letting you track what is hidden or revealed as the story unfolds.", link: "item-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Each row is one relationship the item is part of at this point in the story, naming the entities it connects and any role or label the item carries within it. Open a row to view or change the full relationship, including who else takes part and how each side sees it." },
  ],
}
