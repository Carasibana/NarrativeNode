// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: context-cue-library. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "context-cue-library",
  category: "",
  tier: "base",
  parent: "entity-library",
  order: 8,
  title: "Context Cue Library",
  intro: "Context cues are short reusable notes you write once and hand to the AI as background: a style reminder, a recurring instruction, a snippet of world detail you keep needing. They live here, in their own library, separate from your story so they carry across projects. This is where you create, organise, tag, and tidy them; you bring a cue into an actual conversation from the chat composer, where it rides along as extra context for the assistant.",
  screenshotFile: "context-cue-library.webp",
  screenshotAlt: "Context Cue Library screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.39, y: 15.6, w: 97.21, h: 2.79 }, body: "The top of the context cue library. It shows how many cues you have, narrowing to a matched count when a filter is on, and gathers the controls for sorting, multi-select, and organising the list." },
    { id: "select_toggle", label: "Select", region: { x: 75.96, y: 16.3, w: 8.71, h: 1.39 }, body: "Switch the list into selection mode so you can tick several cues and delete them all at once. A confirmation dialog asks before they go, and any conversation that has one of them pinned loses it. This is permanent, so reach for it to clear out cues you are sure you no longer need." },
    { id: "sort", label: "Sort", region: { x: 66.81, y: 16.35, w: 8.28, h: 1.28 }, body: "Choose the order cues appear in: your own manual arrangement, alphabetical, or by how recently each was edited. Pinned cues always stay grouped at the top whichever order you pick." },
    { id: "new_cue", label: "New cue", region: { x: 4.88, y: 95.91, w: 90.24, h: 3.45 }, body: "Start a fresh context cue. It opens in the editor ready to name and write, after which it joins the library to be tagged, pinned, and handed to the AI from any conversation." },
  ],
}
