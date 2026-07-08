// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: detail-character. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "detail-character",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "entity-library",
  order: 1,
  title: "Detail Character",
  intro: "This panel shows one character as they stand at a chosen point in the story. A character is not fixed: they begin from a starting state and change as the story moves forward, and this panel always reflects the state in effect at the point you have selected. The sub-tabs across the top split that picture into the character's details, attributes, relationships, and who is aware of what.",
  screenshotFile: "detail-character.webp",
  screenshotAlt: "Detail Character screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Identifies the character you are looking at: their name, the fact that they are a character, and their colour, all as they stand at the selected point in the story. If any of these were changed earlier in the narrative, the values shown here are the ones carried forward to this point." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "The Details sub-tab, shown here. It covers the character's descriptive identity at this point: their description, any aliases they go by, and the tags filed against them." },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "Switches to the Attributes sub-tab, which lists the character's attributes as they stand at this point in the story. Attributes are the trackable facts about a character, such as age or rank, that can change as the narrative unfolds.", link: "entity-attributes" },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the Relationships sub-tab, showing the connections this character has with others at this point: who they know, how each side sees the other, and any groups they belong to. Relationships answer who knows whom and how that stands here.", link: "entity-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to the Awareness sub-tab, which tracks who knows what about this character at this point: who is aware of them, their attributes, or their aliases, and who is deliberately kept in the dark. It is how you keep track of secrets and reveals across the story.", link: "entity-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The body of the Details sub-tab: the character's description, the aliases they are known by, and their tags, all as they stand at the selected point in the story. Editing a value here records the change from this point forward rather than rewriting the character everywhere." },
  ],
}
