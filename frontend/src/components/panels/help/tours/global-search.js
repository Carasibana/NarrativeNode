// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: global-search. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "global-search",
  category: "Dialogs",
  tier: "modal",
  parent: "menu-bar",
  order: 3,
  title: "Global Search",
  intro: "Search looks across your whole story at once, not just the words in one scene. It matches far more than names: it searches names, descriptions, aliases, attribute values, scene prose, transition notes, circumstances, motivators, reference notes, and node titles throughout the story. Type a few letters, narrow the results to the kinds of thing you want, and select a match to jump straight to it on the canvas. Use this to locate something when you cannot remember where it lives.",
  screenshotFile: "global-search.webp",
  screenshotAlt: "Global Search screenshot.",
  sections: [
    { id: "input", label: "Search box", region: { x: 0.14, y: 0.69, w: 99.72, h: 33.1 }, body: "Type the name or text you are looking for. Results update as you type and gather every matching item from across the story." },
    { id: "close", label: "Close", region: { x: 95.56, y: 11.38, w: 2.63, h: 11.03 }, body: "Closes the search window without changing anything. Pressing Escape does the same." },
    { id: "filters", label: "Filters", region: { x: 0.14, y: 33.79, w: 99.72, h: 31.03 }, body: "Choose which kinds of story object to include, such as characters, scenes, relationships, or tags. Turning off the kinds you do not need keeps a long result list focused on what you are actually after." },
    { id: "scope_chip", label: "Active filter", region: { x: 7.15, y: 39.31, w: 3.89, h: 19.31 }, body: "One kind of object included in the current search. Click its icon to add or drop that kind from the results; hover to see which kind it is." },
    { id: "filter_all_toggle", label: "Search all", region: { x: 94.31, y: 39.31, w: 3.89, h: 19.31 }, body: "Switches between including every kind of object and the smaller set you have picked. Use it to quickly cast the widest net or clear back to a focused search." },
    { id: "results", label: "Results", region: { x: 0.14, y: 64.83, w: 99.72, h: 34.48 }, body: "The matches found, gathered under headings for each kind of object so you can scan them quickly. Select a result to open it where it lives, so you land on the right entity or the right point in the story." },
  ],
}
