// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: detail-relationship. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "detail-relationship",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "entity-library",
  order: 6,
  title: "Detail Relationship",
  intro: "A relationship is a connection between one or more entities, with its own history that unfolds as the story does. This panel shows that relationship as it stands at the scene you have selected: who takes part, how each of them sees it, and the role each one holds. Edit a value here and the change is recorded at this scene and carried forward to later ones, so the connection can shift, deepen, or break as the narrative moves.",
  screenshotFile: "detail-relationship.webp",
  screenshotAlt: "Detail Relationship screenshot.",
  sections: [
    { id: "details_body", label: "Details", region: { x: 6.1, y: 33.32, w: 87.8, h: 35.34 }, body: "The relationship as it stands at this point in the story. Its description, tags, and participants are shown the way they are at the selected scene, reflecting any changes made up to this point rather than a single fixed definition." },
    { id: "details_tags", label: "Tags", region: { x: 6.1, y: 44.79, w: 87.8, h: 4.55 }, body: "Labels you attach to this relationship so you can group and filter related connections across the story. Tags describe the relationship itself rather than any single scene, which makes them handy for picking out threads like rivalries or alliances later on." },
    { id: "details_participants", label: "Participants", region: { x: 6.1, y: 50.26, w: 87.8, h: 18.41 }, body: "The entities taking part in this relationship at the selected scene. Because participants can join or leave over the course of the story, this list reflects who is involved at this point and not who has ever been involved." },
    { id: "details_participant_row", label: "Participant", region: { x: 6.1, y: 52.28, w: 87.8, h: 6.42 }, body: "One entity's stake in the relationship, showing the role it holds and how it sees the connection at this point. Expand it to set that participant's own view of the relationship, choose which of its names is in play here, and assign a role; those settings are recorded at this scene and carried forward." },
    { id: "details_add_participant", label: "Add participant", region: { x: 6.1, y: 66.02, w: 87.8, h: 2.65 }, body: "Brings another entity into this relationship from this scene onward. The entity joins as of this point in the story and remains a participant in later scenes, leaving earlier scenes untouched.", link: "entity-picker" },
  ],
}
