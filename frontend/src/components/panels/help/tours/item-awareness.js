// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: item-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "item-awareness",
  category: undefined,
  tier: "element-detail",
  parent: "detail-entity",
  order: 2,
  title: "Item Awareness",
  intro: "The Awareness sub-tab tracks what is known about this item and what the item knows in turn, which matters whenever an object is hidden, disguised, or secretly significant. It records who is aware the item exists, down to whether each character has the full picture or only a vague sense of it, all at the point in the story you are viewing. Because awareness is carried forward like any other change, you can show exactly when a secret is revealed and to whom.",
  screenshotFile: "item-awareness.webp",
  screenshotAlt: "Item Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Names the item you are viewing and stays fixed while you move between its Details, Attributes, Relationships, and Awareness sub-tabs, so you always know which object the panel is describing." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the item's core identity: its name, colour, description, and any aliases as they stand at this point in the story.", link: "detail-entity" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the item's properties, along with any circumstances and motivators tied to it, as they stand at this point in the story.", link: "item-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the connections this item shares with other entities, such as who owns or carries it, shown as they stand at this point in the story.", link: "item-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "The sub-tab you are on. It shows who is aware of this item and what the item is aware of, as they stand at this point in the story." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Two views sit here: who knows about this item, with how complete each one's knowledge is, and what the item itself is aware of. Set or change these at the current point in the story to mark the moment a secret is discovered or kept, and the change is carried forward from there." },
  ],
}
