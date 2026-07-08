// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: find-replace. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "find-replace",
  category: "",
  tier: "base",
  parent: "editor-panel",
  order: 2,
  title: "Find Replace",
  intro: "Find and Replace works on the words inside your scenes, the prose you write in the Editor. It searches the text of the scene you are editing, or every scene in the story, and swaps matches for new wording. This is for editing what is written, not for finding entities or relationships: for those, use Search instead.",
  screenshotFile: "find-replace.webp",
  screenshotAlt: "Find Replace screenshot.",
  sections: [
    { id: "find_input", label: "Find", region: { x: 19.05, y: 16.62, w: 77.94, h: 12.89 }, body: "Type the word or phrase you want to locate in your scene text. As you type, the panel counts how many times it appears and highlights each match in the editor." },
    { id: "replace_input", label: "Replace", region: { x: 19.05, y: 32.95, w: 77.94, h: 12.89 }, body: "Type what each match should become. Leave it blank to delete the found text instead of replacing it." },
    { id: "options", label: "Options", region: { x: 3.01, y: 49.28, w: 93.98, h: 26.93 }, body: "Set how widely and how strictly the search runs. Scope chooses between just the scene you are editing and every scene in the story, while Match case and Whole word tighten what counts as a match so you do not catch partial words or the wrong capitalization." },
    { id: "actions", label: "Actions", region: { x: 3.01, y: 79.66, w: 93.98, h: 15.19 }, body: "Step through the matches one at a time with Previous and Next, replace the one you are currently on, or replace them all at once. When the scope is the whole story, stepping follows the order your scenes are told in, and Replace all is a single undo step." },
  ],
}
