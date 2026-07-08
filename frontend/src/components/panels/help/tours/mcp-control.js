// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: mcp-control. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "mcp-control",
  category: "Chat & AI",
  tier: "base",
  parent: "menu-bar",
  order: 5,
  title: "Mcp Control",
  intro: "MCP lets an outside assistant work on your story for you, using the same building blocks you use by hand: it can add scenes, set who is present, record what changes at each point, and adjust relationships. Nothing happens without your say-so. This control shows whether such a connection is open and lets you turn it on or off for the current sitting, and it is also where requests to make changes come in for your approval.",
  screenshotFile: "mcp-control.webp",
  screenshotAlt: "Mcp Control screenshot.",
  sections: [
    { id: "status", label: "Status", region: { x: 0.21, y: 0.41, w: 99.58, h: 20.04 }, body: "Shows at a glance whether an outside assistant can reach NarrativeNode right now and whether it is currently allowed to make changes. This is your reassurance that the door is only open when you have opened it." },
    { id: "turn_on", label: "Turn on", region: { x: 3.96, y: 56.65, w: 92.08, h: 17.18 }, body: "Opens the door for this sitting so an outside assistant can connect and ask to work on your story. It stays off until you choose this, and turning it on here does not change what happens the next time you launch the application." },
  ],
}
