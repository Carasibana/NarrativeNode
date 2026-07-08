// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: faction-attributes. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "faction-attributes",
  category: undefined,
  tier: "element-detail",
  parent: "detail-faction",
  order: 0,
  title: "Faction Attributes",
  intro: "The Attributes sub-tab lists a faction's stored details as they stand at the point in the story you are viewing. A faction can hold attributes the same way a character does: a charter, a banner colour, a founding date, anything you want to track. Because everything is read at the selected point, the values shown here reflect changes made earlier in the story and carried forward, not a single fixed profile.",
  screenshotFile: "faction-attributes.webp",
  screenshotAlt: "Faction Attributes screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Shows which faction you are looking at, with its name and colour. This identity stays the same as you move between the faction's sub-tabs." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the Details sub-tab, where the faction's description, aliases, and core identity live.", link: "detail-faction" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "The sub-tab you are on now. It collects the faction's tracked attributes, separated into Attributes, Circumstances, Motivators, and Perspectives." },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Opens the Relationships sub-tab, where the faction's members and other connections are listed.", link: "faction-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Opens the Awareness sub-tab, where you can see who knows the faction exists and what the faction knows about.", link: "faction-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Each row is one attribute the faction holds at this point in the story, showing its name and current value. Add or change an attribute here and the new value is carried forward to every later scene until something changes it again, so the list always reflects the faction as it stands at the moment you are viewing." },
  ],
}
