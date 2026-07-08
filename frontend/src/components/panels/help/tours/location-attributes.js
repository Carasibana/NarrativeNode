// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: location-attributes. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "location-attributes",
  category: undefined,
  tier: "element-detail",
  parent: "detail-location",
  order: 0,
  title: "Location Attributes",
  intro: "The Attributes sub-tab gathers everything descriptive you are tracking about this location, shown as it stands at the point in the story you are currently viewing. Rows are grouped into Attributes (lasting properties), Circumstances (situational states that are true right now), Motivators (drives that push toward a goal), and Perspectives (how this place is regarded). Anything you add or change here is carried forward to later scenes until you change it again, so the panel always reflects the location's state at the selected point rather than a single fixed definition.",
  screenshotFile: "location-attributes.webp",
  screenshotAlt: "Location Attributes screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The location's name and identity, shared across all of its detail sub-tabs so you always know which place you are looking at and which point in the story is in view." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, where the location's description, aliases, and other identity fields live at this point in the story.", link: "detail-location" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "The Attributes sub-tab, currently shown. It collects the location's descriptive properties along with its circumstances, motivators, and perspectives as they stand at the selected point." },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the Relationships sub-tab, which shows the connections this location takes part in, such as which faction holds it or which larger place contains it.", link: "location-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to the Awareness sub-tab, which records who knows about this location at the point in the story you are viewing.", link: "location-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The grouped list of what you are tracking about this location at the selected point: lasting attributes, situational circumstances, motivators, and perspectives. Each section has its own Add control, and a coloured indicator marks anything added, changed, or removed at this point so you can see what shifted here versus what was carried forward." },
  ],
}
