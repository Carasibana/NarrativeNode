// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: tag-filter. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "tag-filter",
  category: "Library & Editor",
  tier: "element-detail",
  parent: "entity-library",
  order: 10,
  title: "Tag Filter",
  intro: "The tag filter narrows the entity library down to just the objects carrying the tags you care about. Tags are free-form labels you attach to entities, so this is how you pull together everything sharing a theme, faction, or any grouping you have invented. Choose one or more tags and the library hides everything that does not match, leaving you a focused working set.",
  screenshotFile: "tag-filter.webp",
  screenshotAlt: "Tag Filter screenshot.",
  sections: [
    { id: "trigger", label: "Tag filter button", region: { x: 4.7, y: 4.5, w: 26.9, h: 16.4 }, body: "Opens the tag filter, where you pick which tags to narrow the library by. When a filter is active the button is highlighted and shows how many tags are in play." },
    { id: "popover", label: "Filter popover", region: { x: 4.7, y: 23.8, w: 90.8, h: 70.9 }, body: "The panel for building your filter. Choose tags here and the library keeps only the entities carrying them, so you can concentrate on one slice of your cast or world at a time." },
    { id: "search", label: "Search tags", region: { x: 7.1, y: 41, w: 86.1, h: 13.5 }, body: "Type to find a tag by name when your list of tags is long. The choices below shrink to match what you enter." },
    { id: "clear_all", label: "Clear all", region: { x: 7.1, y: 77.9, w: 18.2, h: 11.9 }, body: "Drops every tag from the filter at once, returning the library to its full, unfiltered list." },
    { id: "done", label: "Done", region: { x: 81.2, y: 77.9, w: 12, h: 11.9 }, body: "Closes the panel while keeping the filter you have set. Your chosen tags stay active until you clear or change them." },
  ],
}
