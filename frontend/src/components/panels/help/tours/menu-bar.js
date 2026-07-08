// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: menu-bar. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "menu-bar",
  category: "Canvas & Toolbar",
  tier: "base",
  parent: "canvas-overview",
  order: 0,
  title: "Menu Bar",
  intro: "The menu bar runs across the top of the window and stays in view as you work. On the left it carries the application menu and the application's name; in the middle it shows the current story's title and the file you are saving to; and along the way it gathers quick ways to open the table of contents, the timeline, find and replace, help, and to save. Indicators at the far right keep you posted on connections and on anything the application wants to flag.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Menu Bar screenshot.",
  sections: [
    { id: "wordmark", label: "Wordmark", region: { x: 0, y: 0, w: 14.54, h: 4.28 }, body: "The application's name and logo, marking the home corner of the window. It is a label rather than a button." },
    { id: "menu_bar", label: "Menu bar", region: { x: 0, y: 0, w: 100, h: 4.6 }, body: "The whole strip across the top of the window. Everything you reach often without opening a panel lives here: the application menu, the story title and file, and the row of quick actions." },
    { id: "app_menu", label: "Application menu", region: { x: 0.21, y: 0.39, w: 1.87, h: 3.5 }, body: "Opens the main menu for working with files and the application as a whole: starting a new story, opening or saving one, importing and exporting, settings, and help. Recently opened stories also appear here for quick return.", link: "app-menu" },
    { id: "toc", label: "Table of contents", region: { x: 14.95, y: 0.78, w: 1.45, h: 2.72 }, body: "Opens a structured outline of your story by act, chapter, and scene, following the order it will read in rather than where the scenes happen to sit on the canvas. It is the quickest way to jump straight to a particular scene.", link: "table-of-contents" },
    { id: "timeline", label: "Timeline", region: { x: 16.82, y: 0.78, w: 1.45, h: 2.72 }, body: "Opens the timeline, which lays your scenes out along the order the story is told in, set by the point of view path. It gives you a single running view of the narrative from beginning to end.", link: "timeline-navigator" },
    { id: "find", label: "Find and replace", region: { x: 18.69, y: 0.78, w: 1.45, h: 2.72 }, body: "Searches the text of your scenes and lets you replace what it finds across the whole story at once. Handy when a name or a wording needs to change everywhere it appears.", link: "global-search" },
    { id: "help", label: "Help", region: { x: 20.56, y: 0.78, w: 1.45, h: 2.72 }, body: "Turns on help mode: the cursor takes on a question mark, and the next thing you click opens help about that part of the application instead of doing its usual job. A quick way to ask what is this without hunting through a manual." },
    { id: "save", label: "Save", region: { x: 22.43, y: 0.78, w: 1.45, h: 2.72 }, body: "Writes your story to its file. A small mark on the button tells you when there are changes not yet saved, and the button turns green for a moment after a save so you know it went through." },
    { id: "story_title", label: "Story title", region: { x: 54.39, y: 0.97, w: 5.78, h: 2.33 }, body: "Shows your story's title in the centre of the bar. Click it to rename the story right here, without opening settings." },
    { id: "mcp_status", label: "MCP status", region: { x: 96.26, y: 1.01, w: 1.56, h: 2.41 }, body: "Shows whether an outside assistant is connected and currently allowed to work on your story, and flags when one is asking to make changes. Click it to open the control where you grant, deny, or end that access.", link: "mcp-control" },
    { id: "alerts", label: "Alerts", region: { x: 98.24, y: 1.05, w: 1.37, h: 2.33 }, body: "Gathers notes the application has raised about your story: validation warnings, time gaps in the sequence, and other things worth a glance. Nothing here blocks your work; it is a list you address at your own pace.", link: "alerts" },
    { id: "active_file", label: "Current file", region: { x: 24.3, y: 1.36, w: 6.85, h: 1.56 }, body: "Names the file your story is being saved to, so you always know which project is open. It stays empty until the story has been saved to a location." },
  ],
}
