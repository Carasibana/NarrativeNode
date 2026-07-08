// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-chip. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-chip",
  category: "",
  tier: "element-detail",
  parent: "scene-node",
  order: 3,
  title: "Relationship Chip",
  intro: "A relationship chip appears inside a scene to mark a relationship that is in effect there, between entities present at that point. It shows up only at scenes where something about the relationship begins or changes, so the chips along a story trace exactly where bonds form, shift, or break. Click it to open the relationship in the detail panel at this point in the story, or drag an entity onto it to bring that entity into the relationship here.",
  screenshotFile: "relationship-chip.webp",
  screenshotAlt: "Relationship Chip screenshot.",
  sections: [
    { id: "chip", label: "Relationship chip", region: { x: 0, y: 0, w: 100, h: 100 }, body: "Stands for a relationship as it exists at this scene, listing the entities taking part and any change recorded here, such as someone joining, leaving, or seeing the relationship differently. Click it to view and edit the relationship at this point in the story; drag an entity onto it to add that entity as a participant from here forward.", target: {"type":"surface","ref":"detail-relationship"} },
  ],
}
