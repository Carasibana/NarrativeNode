// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: text-list-attribute. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "text-list-attribute",
  category: "entity",
  tier: "base",
  parent: "entity-modal",
  order: 3,
  title: "Text List Attribute",
  intro: "A text list attribute holds several short text entries under one heading, instead of a single value, which suits a detail that is naturally a set: a character's distinguishing marks, a list of titles, a few standing notes. Like any attribute, its entries belong to the moment in the story you are viewing: a starting state is set where the entity begins, and adding or removing entries at a later scene carries that revised list forward from that point. When you are looking at a point partway through the story, entries you have just added or removed are shown marked, so you can see how the list changes here against what was already in place.",
  screenshotFile: "text-list-attribute.webp",
  screenshotAlt: "Text List Attribute screenshot.",
  sections: [
    { id: "editor", label: "List", region: { x: 1.21, y: 75.58, w: 11.54, h: 3.07 }, body: "Shows the entries in the list as they stand at the point in the story you are viewing, each as a small removable tag. At a later scene, an entry you have added shows in green and one you have removed shows struck through, so a change made here reads clearly against the entries carried forward from earlier." },
    { id: "add_input", label: "Add entry", region: { x: 1.21, y: 75.58, w: 11.54, h: 3.07 }, body: "Type a new entry and press Enter, or use the plus button, to add it to the list. If you are at a scene partway through the story, the new entry is recorded as a change at this point and carries forward to the scenes that follow." },
  ],
}
