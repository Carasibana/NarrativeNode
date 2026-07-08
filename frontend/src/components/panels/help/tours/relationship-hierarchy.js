// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-hierarchy. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-hierarchy",
  category: undefined,
  tier: "element-detail",
  parent: "detail-relationship",
  order: 0,
  title: "Relationship Hierarchy",
  intro: "A relationship can be flat, where everyone simply takes part, or structured as a hierarchy with parents and children, like a chain of command or a nested set of places. This sub-tab is where you turn that structure on and arrange it. As with everything about a relationship, what you see reflects its state at the point in the story you are currently viewing, so a hierarchy can grow or be reorganised as the narrative moves forward.",
  screenshotFile: "relationship-hierarchy.webp",
  screenshotAlt: "Relationship Hierarchy screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Shows the relationship's name and identity. It stays in place across the Details, Hierarchy, and Awareness sub-tabs so you always know which relationship you are working on." },
    { id: "details_tab", label: "Details tab", region: { x: 4, y: 16.6, w: 22, h: 2.5 }, body: "Switches to the Details sub-tab, where the relationship's participants, their roles, and how each one sees the connection are managed.", link: "detail-relationship" },
    { id: "hierarchy_tab", label: "Hierarchy tab", region: { x: 33, y: 16.6, w: 36, h: 2.5 }, body: "The sub-tab shown here, where you decide whether the relationship is arranged as a structured hierarchy and lay out its order." },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 74, y: 16.6, w: 24, h: 2.5 }, body: "Switches to the Awareness sub-tab, which tracks who in the story knows this relationship exists and who does not, at the point you are viewing.", link: "relationship-awareness" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Turns the hierarchy on or off and chooses how it is ordered: by participant, arranging the entities directly into a parent and child tree, or by role, arranging the role labels with each role's members listed beneath it. Drag entries to reorder or re-parent them; the arrangement is carried forward from this point in the story." },
  ],
}
