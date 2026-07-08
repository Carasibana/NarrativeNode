// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: preset-list-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "preset-list-picker",
  category: "entity",
  tier: "base",
  parent: "entity-modal",
  order: 1,
  title: "Preset List Picker",
  intro: "A preset attribute pulls its value from a fixed list of options you maintain, so the same wording stays consistent everywhere it is used. This picker is where you choose which of your lists that attribute should draw from, or build a new list on the spot. Once a list is attached, the attribute offers its values as a dropdown rather than free text.",
  screenshotFile: "preset-list-picker.webp",
  screenshotAlt: "Preset List Picker screenshot.",
  sections: [
    { id: "popover", label: "Preset list", region: { x: 1.34, y: 42.16, w: 11.63, h: 10.8 }, body: "Pick which of your saved lists this preset attribute should draw its options from. Selecting a list here means the attribute will offer that list's values; choosing None leaves the attribute unattached." },
    { id: "search", label: "Search", region: { x: 1.8, y: 43.09, w: 10.72, h: 2.49 }, body: "Filter your saved lists by name to find the one you want quickly. Handy once you keep several lists, such as one for species and another for ranks." },
    { id: "create_new", label: "Create list", region: { x: 1.8, y: 50.3, w: 10.72, h: 1.99 }, body: "Build a brand new list without leaving the picker: give it a name and add its values, then it is attached straight away. Use this when no existing list fits the attribute you are setting up." },
  ],
}
