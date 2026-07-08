// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: app-menu. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "app-menu",
  category: "Canvas & Toolbar",
  tier: "modal",
  parent: "menu-bar",
  order: 0,
  title: "App Menu",
  intro: "The application menu, opened from the hamburger icon at the far left of the menu bar. It gathers every file-level and project-level command in one list: starting, opening, and saving stories, searching within one, bringing content in, sending it out, and reaching help and settings.",
  screenshotFile: "app-menu.webp",
  screenshotAlt: "App Menu screenshot.",
  sections: [
    { id: "new", label: "New", region: { x: 0.31, y: 1.35, w: 99.38, h: 7.89 }, body: "Starts a fresh, empty project with a blank canvas, ready for you to begin building a new story from scratch." },
    { id: "open", label: "Open", region: { x: 0.31, y: 9.24, w: 99.38, h: 7.89 }, body: "Opens an existing story file from your computer. Recently opened projects are listed just beneath, so returning to current work takes a single click." },
    { id: "library", label: "Library", region: { x: 0.31, y: 25.61, w: 99.38, h: 7.89 }, body: "Opens the Story Library, the shelf showing all your projects at a glance so you can pick one to work on without hunting through folders.", link: "projects" },
    { id: "save", label: "Save", region: { x: 0.31, y: 35.98, w: 99.38, h: 7.89 }, body: "Writes the current story back to its own file, keeping your work safe. The application does not save on its own, so this is how you commit changes to disk." },
    { id: "save_as", label: "Save as", region: { x: 0.31, y: 43.87, w: 99.38, h: 7.89 }, body: "Saves the current story to a new, separate file and leaves the original untouched. Handy for keeping a snapshot or branching off a variant without disturbing the version you came from." },
    { id: "find", label: "Find", region: { x: 0.31, y: 54.24, w: 99.38, h: 7.89 }, body: "Opens search across the whole project, so you can jump straight to a scene, entity, or any text wherever it lives in your story." },
    { id: "import", label: "Import", region: { x: 0.31, y: 64.61, w: 99.38, h: 7.89 }, body: "Brings outside content into the current story: entities from another project, reusable story seeds, a starting template, or a story exported from Novelcrafter.", link: "template-import" },
    { id: "export", label: "Export", region: { x: 0.31, y: 72.5, w: 99.38, h: 7.89 }, body: "Sends your story out to a file in one of the supported formats for reading, sharing, or carrying into another writing tool.", link: "export-dialog" },
    { id: "help", label: "Help", region: { x: 0.31, y: 82.87, w: 99.38, h: 7.89 }, body: "Opens this help, a guided tour of the interface explaining what each part is for and the ideas behind it." },
    { id: "settings", label: "Settings", region: { x: 0.31, y: 90.76, w: 99.38, h: 7.89 }, body: "Opens the settings panel, where story-level options and application preferences are configured.", link: "settings" },
  ],
}
