// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: location-relationships. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "location-relationships",
  category: undefined,
  tier: "element-detail",
  parent: "detail-location",
  order: 1,
  title: "Location Relationships",
  intro: "The Relationships sub-tab lists the connections this location takes part in, shown as they stand at the point in the story you are currently viewing. A relationship is a shared link between two or more entities, so a place might be held by a faction, contain a smaller location, or sit beneath a larger one. Each entry shows the location's role in that connection, and because relationships are tracked through the story, what appears here reflects the selected point rather than a fixed list.",
  screenshotFile: "location-relationships.webp",
  screenshotAlt: "Location Relationships screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The location's name and identity, shared across all of its detail sub-tabs so you always know which place you are looking at and which point in the story is in view." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, where the location's description, aliases, and other identity fields live at this point in the story.", link: "detail-location" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the Attributes sub-tab, which collects the location's descriptive properties, circumstances, motivators, and perspectives as they stand at the selected point.", link: "location-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "The Relationships sub-tab, currently shown. It lists every connection this location is part of at the selected point, along with the location's role in each." },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to the Awareness sub-tab, which records who knows about this location at the point in the story you are viewing.", link: "location-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Each row is a relationship this location is part of at the selected point, showing the other participants and the location's role. Membership and containment connections, such as a controlling faction or a parent location, are set apart so you can see the place's place in the wider world at a glance. Open a row to edit the relationship and follow how it changes across the story." },
  ],
}
