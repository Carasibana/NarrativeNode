// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-import. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-import",
  category: "",
  tier: "element-detail",
  parent: "app-menu",
  order: 4,
  title: "Entity Import",
  intro: "Bring characters, locations, items, factions, custom entities, and knowledge across from another saved project so you do not rebuild them by hand. Choose the source file, tick which objects you want, and add them to the timeline grid on the right. Because an entity carries its state forward through the story, an imported object has a state at each scene it appeared in over there, so you pick which point in its history to bring over. Review the grid before confirming, and remember to save your project afterward to keep what you imported.",
  screenshotFile: "entity-import.webp",
  screenshotAlt: "Entity Import screenshot.",
  sections: [
    { id: "file_picker", label: "File", region: { x: 0.09, y: 5.32, w: 99.82, h: 6.13 }, body: "Pick the saved project to pull entities out of. Once it loads, this row shows the source story's title and a count of its entities and scenes so you know you opened the right one." },
    { id: "picker", label: "Pick entities", region: { x: 0.09, y: 11.46, w: 25.45, h: 82.29 }, body: "The source project's contents, listed by type. Tick the entities and knowledge you want and they join the timeline grid on the right, where you choose what state to bring across." },
    { id: "picker_type_tabs", label: "Type tabs", region: { x: 0.09, y: 11.46, w: 25.36, h: 4.05 }, body: "Narrow the list to one kind at a time: characters, locations, items, factions, custom entities, knowledge, or preset lists. The first tab is All, which shows every type together in one list. Each tab shows how many of that kind the source project holds." },
    { id: "timeline", label: "Timeline", region: { x: 25.55, y: 11.46, w: 74.36, h: 82.29 }, body: "Each entity you tick becomes a row, with a marker at every scene where it changed in the source story. Because state is carried forward from scene to scene, you click a marker to choose which point in the entity's history to import: its starting state, or how it stood at a later moment." },
    { id: "picker_search", label: "Search", region: { x: 0.09, y: 15.51, w: 25.36, h: 4.51 }, body: "Filter the current type by name to find a specific entity quickly. Add All beside it ticks everything the filter is currently showing." },
    { id: "footer", label: "Footer", region: { x: 0.09, y: 93.75, w: 99.82, h: 6.13 }, body: "Confirm to bring your picks into the project, or cancel to back out without changing anything. There is also an option here to copy the source story's settings, such as its author, genre, and tags, across at the same time." },
  ],
}
