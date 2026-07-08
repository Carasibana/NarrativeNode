// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-awareness",
  category: undefined,
  tier: "element-detail",
  parent: "detail-relationship",
  order: 1,
  title: "Relationship Awareness",
  intro: "This is the Awareness sub-tab of a relationship's detail panel. It answers two questions about secrecy: who in the story knows this relationship exists, and what hidden facts knowing this relationship lets someone in on. Like everything else, awareness is read at the scene you are currently viewing, so as you move along the story the lists here update to show who is in the know at that point and who is still in the dark. Use it to keep track of who can plausibly act on a connection, and who would be blindsided to learn of it.",
  screenshotFile: "relationship-awareness.webp",
  screenshotAlt: "Relationship Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The relationship's name and identity, shown the same way across all of its detail sub-tabs so you always know which connection you are editing." },
    { id: "details_tab", label: "Details tab", region: { x: 4, y: 16.6, w: 22, h: 2.5 }, body: "Switches to the Details sub-tab, where you set the relationship's description, tags, and the participants and how each one sees the others.", link: "detail-relationship" },
    { id: "hierarchy_tab", label: "Hierarchy tab", region: { x: 33, y: 16.6, w: 36, h: 2.5 }, body: "Switches to the Hierarchy sub-tab, used when a relationship has structure such as a parent-and-children arrangement or an ordered ranking of its members.", link: "relationship-hierarchy" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 74, y: 16.6, w: 24, h: 2.5 }, body: "The sub-tab shown here, covering who knows this relationship exists and what knowing it reveals, all read at the point on the story you are currently viewing." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "The two awareness lists for this relationship at the current scene: who is aware that the relationship exists, and what facts this relationship grants knowledge of to those who know it. Both reflect the state at this point in the story, so they change as people find out or are kept in the dark further along." },
  ],
}
