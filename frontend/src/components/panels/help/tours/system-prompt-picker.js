// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: system-prompt-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "system-prompt-picker",
  category: "settings",
  tier: "base",
  parent: "character-chat-setup",
  order: 1,
  title: "System Prompt Picker",
  intro: "This picker chooses which system prompt the AI follows here: the standing instruction that sets its role, voice, and ground rules. Prompts are grouped by category, and you can type to narrow the list before selecting the one you want.",
  screenshotFile: "system-prompt-picker.webp",
  screenshotAlt: "System Prompt Picker screenshot.",
  sections: [
    { id: "filter", label: "Filter", region: { x: 54.87, y: 79.34, w: 12.59, h: 2.15 }, body: "Type here to narrow the list to prompts whose name matches what you enter. Handy once you have built up a collection and want to jump straight to one." },
    { id: "prompt_row", label: "Row", region: { x: 54.45, y: 86.38, w: 13.42, h: 2.38 }, body: "A single system prompt in the list. Click it to make the AI follow that prompt here; the star marks one as the standing default for this surface so it is chosen automatically next time." },
  ],
}
