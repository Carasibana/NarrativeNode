// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: projects. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "projects",
  category: "Dialogs",
  tier: "base",
  parent: "app-menu",
  order: 0,
  title: "Projects",
  intro: "The projects view is your story library: every project you have worked on, gathered in one place ready to reopen. Projects are arranged on shelves so the ones you reach for most stay close at hand. From here you can open an existing story, pick up a recent one, or start something new.",
  screenshotFile: "projects.webp",
  screenshotAlt: "Projects screenshot.",
  sections: [
    { id: "close", label: "Close", region: { x: 95.5, y: 1.64, w: 3.44, h: 3.79 }, body: "Closes the library and returns you to your story on the canvas." },
    { id: "view_shelves", label: "View shelves", region: { x: 55.03, y: 2, w: 3.76, h: 3.08 }, body: "Arranges your projects on grouped shelves, such as recent and favourite, so related stories sit together. This is the organised view for finding a project by how you use it." },
    { id: "view_all", label: "View all", region: { x: 59.05, y: 2, w: 2.12, h: 3.08 }, body: "Drops the shelf grouping and lists every project together in one place. Useful when you would rather scan or sort the whole collection at once." },
    { id: "welcome_panel", label: "Welcome panel", region: { x: 1, y: 6, w: 24, h: 90 }, body: "The branded entry area for the library, with the quickest ways to begin: start a fresh story or open one from a file. A rotating tip sits at the foot of the panel." },
    { id: "recents", label: "Recents", region: { x: 40, y: 11, w: 20, h: 4 }, body: "The stories you have opened most recently, newest first, so you can return to whatever you were last working on. Projects whose files have gone missing drop off this shelf automatically." },
    { id: "project_card", label: "Project card", region: { x: 53.54, y: 12.71, w: 9.11, h: 34.1 }, body: "One story in your library, shown with its title and cover. Click it to open the project, or expand it to see its details and other actions." },
    { id: "favourites", label: "Favourites", region: { x: 40, y: 50, w: 20, h: 4 }, body: "The stories you have starred to keep within easy reach, regardless of when you last opened them. Mark or unmark a project as a favourite from its card." },
    { id: "new_project", label: "New project", region: { x: 2, y: 55, w: 11, h: 23 }, body: "Starts a fresh, blank story with an empty canvas, ready for you to add your first scenes and characters." },
    { id: "open_project", label: "Open project", region: { x: 13, y: 55, w: 11, h: 23 }, body: "Opens a saved story from a file on your computer, including projects that are not already listed in your library." },
  ],
}
