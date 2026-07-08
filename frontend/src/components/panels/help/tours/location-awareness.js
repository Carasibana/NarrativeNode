// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: location-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "location-awareness",
  category: undefined,
  tier: "element-detail",
  parent: "detail-location",
  order: 2,
  title: "Location Awareness",
  intro: "The Awareness sub-tab records who knows about this location, shown as it stands at the point in the story you are currently viewing. Awareness lets you track which characters have heard of, discovered, or remain ignorant of this place, and at what depth, so a hidden refuge or a secret hideout can be unknown early and widely known later. Because awareness is tracked through the story, what you set here is carried forward until you change it again, and the panel always reflects the selected point.",
  screenshotFile: "location-awareness.webp",
  screenshotAlt: "Location Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The location's name and identity, shared across all of its detail sub-tabs so you always know which place you are looking at and which point in the story is in view." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, where the location's description, aliases, and other identity fields live at this point in the story.", link: "detail-location" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the Attributes sub-tab, which collects the location's descriptive properties, circumstances, motivators, and perspectives as they stand at the selected point.", link: "location-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the Relationships sub-tab, which shows the connections this location takes part in, such as which faction holds it or which larger place contains it.", link: "location-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "The Awareness sub-tab, currently shown. It tracks who knows of this location, and what this location is aware of, at the selected point." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The Known By section lists who is aware of this location at the selected point and how fully they know it, from a passing rumour to full knowledge. The Aware Of section is the reverse view, gathering whatever this location is recorded as knowing. Turn tracking on to begin recording awareness here, and your settings are carried forward to later scenes until you change them." },
  ],
}
