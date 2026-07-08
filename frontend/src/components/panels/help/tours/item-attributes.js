// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: item-attributes. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "item-attributes",
  category: undefined,
  tier: "element-detail",
  parent: "detail-entity",
  order: 0,
  title: "Item Attributes",
  intro: "The Attributes sub-tab gathers the descriptive properties of an item: its qualities, the circumstances it is caught up in, and any drives that surround it. Everything shown here is read as it stands at the point in the story you are currently viewing, so as you move along the item's history the values reflect what has been carried forward and changed up to that moment. This is where you record what an object is like and how that changes over the course of the narrative.",
  screenshotFile: "item-attributes.webp",
  screenshotAlt: "Item Attributes screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Names the item you are viewing and stays fixed while you move between its Details, Attributes, Relationships, and Awareness sub-tabs, so you always know which object the panel is describing." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the item's core identity: its name, colour, description, and any aliases as they stand at this point in the story.", link: "detail-entity" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "The sub-tab you are on. It lists the item's properties, along with any circumstances and motivators tied to it, as they stand at this point in the story." },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the connections this item shares with other entities, such as who owns or carries it, shown as they stand at this point in the story.", link: "item-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to who knows about this item and what the item is aware of, letting you track what is hidden or revealed as the story unfolds.", link: "item-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Each row is one property of the item: a plain value, a chosen preset, an attached file, a circumstance that is true of it right now, or a motivator pulling on it. Edits you make here are recorded at the current point in the story and carried forward to every later scene until you change them again." },
  ],
}
