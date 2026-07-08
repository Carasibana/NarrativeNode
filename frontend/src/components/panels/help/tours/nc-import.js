// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: nc-import. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "nc-import",
  category: "",
  tier: "modal",
  parent: "app-menu",
  order: 5,
  title: "Nc Import",
  intro: "Brings a story in from a Novelcrafter export so you can carry on planning it here. Choose the exported bundle, review a summary of everything it contains, and run the import. The import always creates a fresh project, so your current work is never overwritten by accident.",
  screenshotFile: "nc-import.webp",
  screenshotAlt: "Nc Import screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.11, y: 0.13, w: 99.78, h: 6.48 }, body: "Names the dialog and offers a close button. Importing pulls a Novelcrafter story into NarrativeNode as a new project." },
    { id: "file_picker", label: "File", region: { x: 0.11, y: 6.61, w: 99.78, h: 7.01 }, body: "Choose the Novelcrafter export bundle to bring in. Once chosen, its title and author appear here so you can confirm you picked the right file." },
    { id: "preview", label: "Preview", region: { x: 0.11, y: 13.62, w: 99.78, h: 79.23 }, body: "Summarizes what the bundle holds before you commit: counts of acts, chapters, and scenes, the characters, locations, items, and other story elements found, and any warnings. A few settings that Novelcrafter does not export, such as the default point of view character, can be filled in here so the imported story starts out closer to how you want it." },
    { id: "footer", label: "Footer", region: { x: 0.11, y: 92.86, w: 99.78, h: 7.01 }, body: "The dialog's controls. Cancel backs out without importing; the import button on the right starts the import once a bundle is ready." },
    { id: "import_action", label: "Import", region: { x: 91.46, y: 94.58, w: 6.65, h: 3.7 }, body: "Runs the import, building a new project from the previewed bundle. It stays disabled until you have chosen a bundle and the preview has loaded." },
  ],
}
