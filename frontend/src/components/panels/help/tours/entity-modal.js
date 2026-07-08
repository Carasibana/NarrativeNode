// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-modal. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-modal",
  category: "Library & Editor",
  tier: "modal",
  parent: "entity-library",
  order: 9,
  title: "Entity Modal",
  intro: "The dialog for creating a new entity: a character, location, item, faction, or custom element of your story. What you set here becomes the entity's starting state, the baseline it carries from its origin into every scene it later appears in. The Details tab covers its identity and the Attributes tab covers its defining facts. Nothing here is locked in; you can change any of it later, scene by scene, as the story unfolds.",
  screenshotFile: "entity-modal.webp",
  screenshotAlt: "Entity Modal screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.21, y: 0.16, w: 99.58, h: 7.9 }, body: "Names the entity being created and lets you close the dialog. It simply frames the work below." },
    { id: "tabs", label: "Tabs", region: { x: 0.21, y: 8.06, w: 99.58, h: 5.64 }, body: "Switches between the entity's Details and its Attributes. Details cover who or what it is; Attributes cover the facts you want to track about it." },
    { id: "tab_details", label: "Details", region: { x: 3.54, y: 8.06, w: 12.45, h: 5.48 }, body: "The entity's core identity: its name, type, colour, description, and who is aware it exists. These are the starting values that carry forward through the story." },
    { id: "tab_attributes", label: "Attributes", region: { x: 16.83, y: 8.06, w: 15.88, h: 5.48 }, body: "The entity's attributes, the defining facts you want to follow over the story, such as a title, an age, or a piece of equipment. Their starting values are set here and carried forward until a scene changes them." },
    { id: "body", label: "Body", region: { x: 0.21, y: 13.7, w: 99.58, h: 76.95 }, body: "The contents of whichever tab is selected, where you fill in the entity's details or build up its attributes." },
    { id: "name", label: "Name", region: { x: 3.54, y: 29.17, w: 92.92, h: 9.35 }, body: "The entity's name, used to identify it everywhere it appears. For a custom entity this is optional and falls back to an automatic name from its category." },
    { id: "type", label: "Type", region: { x: 3.54, y: 41.1, w: 92.92, h: 9.51 }, body: "What kind of entity this is: character, location, item, faction, or a custom type of your own. The type sets the entity's icon and governs which extra fields appear, such as a parent location or a custom category." },
    { id: "colour", label: "Colour", region: { x: 3.54, y: 53.18, w: 92.92, h: 9.35 }, body: "The colour that identifies this entity at a glance wherever it shows up across the canvas, on its node, its chips, and its links. Pick from the swatches or enter a specific value.", link: "colour-picker" },
    { id: "description", label: "Description", region: { x: 3.54, y: 65.11, w: 92.92, h: 16.76 }, body: "A short description of the entity. This is its starting text, in effect until a later scene gives it a new one." },
    { id: "awareness", label: "Awareness", region: { x: 3.54, y: 84.45, w: 92.92, h: 3.63 }, body: "Sets who already knows this entity exists when the story begins. As with everything else, this is the starting state, and later scenes can reveal it to others or hide it again.", link: "awareness-picker" },
  ],
}
