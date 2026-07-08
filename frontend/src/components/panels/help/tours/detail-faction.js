// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: detail-faction. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "detail-faction",
  category: "Detail Panel",
  tier: "base",
  parent: "entity-library",
  order: 3,
  title: "Detail Faction",
  intro: "The detail panel for a faction, shown as it stands at the point in the story you are viewing. A faction is a group or organisation that gathers members and takes part in the narrative, and like every story element its name, look, and standing can shift as events unfold. The sub-tabs split that picture into its details, its attributes, its membership and other ties, and who is aware of it, each reflecting the state in effect at this point.",
  screenshotFile: "detail-faction.webp",
  screenshotAlt: "Detail Faction screenshot.",
  sections: [
    { id: "nav", label: "Navigation bar", region: { x: 1.5, y: 5.9, w: 96, h: 2.4 }, body: "Steps through the faction's life across the story so you can see it as it was earlier or later, and when you have opened it from a scene, lets you jump up to that scene. The arrows move you between the points where the faction changes; everything below updates to match the point you land on." },
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The faction's name and colour as they stand at this point in the story, with its type shown alongside. Because earlier scenes can rename or recolour a faction and carry that change forward, what you see here is its identity at the moment you are viewing, not a fixed label." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "The Details sub-tab, currently open. It holds the faction's description, any names it goes by, and the tags used to group it." },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Opens the faction's attributes: the facts you track about it, such as its size, base, or allegiance, each with the value it holds at this point in the story.", link: "faction-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Opens the faction's ties to other elements, including its members. A faction keeps a membership list, so this is where you see who belongs to it and how that roster stands at this point in the story.", link: "faction-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Opens who knows the faction exists at this point in the story. Awareness lets you track who is aware of the faction, any entity and not just characters, and who is still in the dark, so you can keep secrets and reveals straight as the plot moves.", link: "faction-awareness" },
    { id: "body", label: "Body", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Shows whichever sub-tab is open, always presenting the faction as it stands at the point in the story you are viewing. Move along the chain in the navigation bar and these contents shift to match that moment." },
  ],
}
