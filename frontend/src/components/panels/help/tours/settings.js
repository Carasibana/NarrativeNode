// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: settings. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "settings",
  category: "Dialogs",
  tier: "element-detail",
  parent: "app-menu",
  order: 1,
  title: "Settings",
  intro: "Settings is where you tend to the project as a whole rather than any one scene or entity. A row of tabs separates the kinds of choices: details about this story and its cover, the seeds new entities start from, the program's own behaviour and appearance, and credits, with further tabs appearing when AI integrations are switched on. Changes that affect the project ask you to save before they take effect, while a couple of tabs are reference only, such as About and Thanks, and have nothing to save.",
  screenshotFile: "settings.webp",
  screenshotAlt: "Settings screenshot.",
  sections: [
    { id: "tab_bar", label: "Tabs", region: { x: 0.13, y: 5.45, w: 23.68, h: 94.44 }, body: "Choose which group of settings to view. The tabs are Story Settings, Story Seeds, Default Seeds, Program Settings, About, and Thanks, with MCP & API Connections and System Prompts added when AI integrations are enabled. Each tab opens its own panel to the right." },
    { id: "body", label: "Body", region: { x: 23.82, y: 5.45, w: 76.05, h: 94.44 }, body: "The panel for the tab you have selected. Its contents change with the tab, holding the fields and controls for that group of settings." },
    { id: "cover", label: "Cover", region: { x: 28.16, y: 11.82, w: 19.87, h: 24.62 }, body: "The story's cover image, shown on the project and in places that represent the story as a whole. Click to set or replace it, or use the corner control to remove it." },
    { id: "tab_footer", label: "Footer", region: { x: 23.82, y: 93.68, w: 76.05, h: 6.21 }, body: "Saves or discards your changes to this tab. It also tells you when there are unsaved changes still waiting to be committed." },
  ],
}
