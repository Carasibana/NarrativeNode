// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: faction-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "faction-awareness",
  category: undefined,
  tier: "element-detail",
  parent: "detail-faction",
  order: 2,
  title: "Faction Awareness",
  intro: "The Awareness sub-tab covers who knows a faction exists and what the faction itself is aware of, both read at the point in the story you are viewing. Awareness lets you keep track of secrets and discoveries: a hidden order that only a few characters know about, or a faction that has learned of a rival's plans. Because awareness is read at the selected point, it reflects what has been revealed or concealed by this moment and is carried forward from there.",
  screenshotFile: "faction-awareness.webp",
  screenshotAlt: "Faction Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Shows which faction you are looking at, with its name and colour. This identity stays the same as you move between the faction's sub-tabs." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Returns to the Details sub-tab, where the faction's description, aliases, and core identity live.", link: "detail-faction" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Opens the Attributes sub-tab, where the faction's tracked details and values are listed.", link: "faction-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Opens the Relationships sub-tab, where the faction's members and other connections are listed.", link: "faction-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "The sub-tab you are on now. It holds two sides of awareness for this faction: who knows it exists, and what it knows about." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The top part lists who is aware of this faction at this point in the story, while the lower part lists what the faction itself is aware of. Set either here and the change is carried forward, so you can stage a reveal or a discovery at the exact scene it happens and have it hold from then on." },
  ],
}
