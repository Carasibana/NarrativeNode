// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: faction-relationships. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "faction-relationships",
  category: undefined,
  tier: "element-detail",
  parent: "detail-faction",
  order: 1,
  title: "Faction Relationships",
  intro: "The Relationships sub-tab shows the connections a faction is part of at the point in the story you are viewing. For a faction this usually centres on its membership: who belongs to it, and what part each member plays. It can also include ties to other factions, characters, or places. Because the list is read at the selected point, members and roles reflect everyone who has joined or left by this moment in the story.",
  screenshotFile: "faction-relationships.webp",
  screenshotAlt: "Faction Relationships screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Shows which faction you are looking at, with its name and colour. This identity stays the same as you move between the faction's sub-tabs." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the Details sub-tab, where the faction's description, aliases, and core identity live.", link: "detail-faction" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Opens the Attributes sub-tab, where the faction's tracked details and values are listed.", link: "faction-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "The sub-tab you are on now. It lists the faction's membership and any other relationships it takes part in at this point." },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Opens the Awareness sub-tab, where you can see who knows the faction exists and what the faction knows about.", link: "faction-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Each entry is a relationship the faction is part of at this point, shown with the member's role where one is set. Membership is grouped on its own so you can see the roster at a glance, and because it is read at the selected point, the list reflects who has joined or left by this moment in the story." },
  ],
}
