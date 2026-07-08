// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: template-import. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "template-import",
  category: "Dialogs",
  tier: "modal",
  parent: "app-menu",
  order: 3,
  title: "Template Import",
  intro: "Bring a whole story structure into NarrativeNode at once, from a filled-in template document rather than building it scene by scene. This is the path to take when you have an outline, a set of characters, or a draft prepared elsewhere (often handed to a chat assistant working from the blank template) and want it turned into entities, scenes, chapters, and relationships in one pass. You choose where the text comes from and whether it starts a fresh project or merges into the one you have open, then preview the result before anything is committed.",
  screenshotFile: "template-import.webp",
  screenshotAlt: "Template Import screenshot.",
  sections: [
    { id: "body", label: "Body", region: { x: 0.16, y: 5.6, w: 99.69, h: 87.23 }, body: "The working area of the dialog, where you supply the template text and set the import options before previewing. As you move through the steps it changes from picking a source, to a summary of everything that was found, to a confirmation once the import is done." },
    { id: "source", label: "Source", region: { x: 2.66, y: 18.32, w: 94.69, h: 34.73 }, body: "Where the template text comes from: paste it directly into the box, or upload a markdown file. Either way it should be a NarrativeNode story template that has been filled in with your characters, scenes, and other story elements; a blank one to hand to an assistant can be downloaded just above." },
    { id: "mode", label: "Mode", region: { x: 2.66, y: 54.85, w: 94.69, h: 36.19 }, body: "Whether the template starts a brand-new project or folds into the one already open. New project replaces your workspace with the imported story and offers to save any unsaved work first; Merge appends the imported elements alongside what you have, renaming anything whose name would clash." },
    { id: "origin_layout", label: "Layout", region: { x: 4.69, y: 70.2, w: 90.63, h: 11.2 }, body: "How the imported entities' starting points are arranged on the canvas. Group them into tidy columns ahead of the first chapter, or drop each one near the scene where it first appears, so its place on the canvas mirrors when it enters the story." },
    { id: "clean_titles", label: "Clean titles", region: { x: 4.69, y: 82.3, w: 90.63, h: 7.28 }, body: "Strips a leading \"Chapter One\" or \"Act 1:\" style label off imported chapter and act titles, keeping the descriptive part. Leave it off to bring titles in exactly as written in the template." },
    { id: "actions", label: "Actions", region: { x: 0.16, y: 92.83, w: 99.69, h: 7.06 }, body: "Move the import forward or back out of it. Preview parses the template and shows you what was found before anything changes; from there you confirm the import, step back to adjust the source or options, or cancel without touching your project." },
  ],
}
