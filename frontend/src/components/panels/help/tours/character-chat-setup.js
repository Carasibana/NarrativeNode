// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: character-chat-setup. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "character-chat-setup",
  category: "",
  tier: "modal",
  parent: "thread-browser",
  order: 1,
  title: "Character Chat Setup",
  intro: "Set up a conversation held in the voice of one of your characters, so the AI answers as them rather than as a writing assistant. Pick the character and the point in the story to speak from, choose how they should sound, and add anything that should colour this chat only. The character's name, description, and traits are read at the scene you anchor to, so the voice reflects who they are at that moment, not just their starting state.",
  screenshotFile: "character-chat-setup.webp",
  screenshotAlt: "Character Chat Setup screenshot.",
  sections: [
    { id: "character", label: "Character", region: { x: 1.98, y: 6.3, w: 96.05, h: 10.43 }, body: "Choose which of your characters the AI will speak as. Their identity, description, and personality are drawn from the story, read at the point you anchor the chat to, so the conversation reflects who they are at that moment rather than a generic persona.", link: "entity-picker" },
    { id: "persona_prompt", label: "Persona", region: { x: 1.98, y: 18.48, w: 47.33, h: 4.57 }, body: "A reusable instruction set that shapes how the character speaks and carries themselves: tone, length, mannerisms, how much they reveal. It steers the voice without changing anything about the character in your story; you manage these personas in Settings.", link: "system-prompt-picker" },
    { id: "model", label: "Model", region: { x: 50.7, y: 18.48, w: 47.33, h: 4.57 }, body: "Pick which connection and model answer in this chat, drawn from the AI providers you have set up. Different models give different voices and pacing, so this is where you match the character to the engine that performs them best.", link: "connection-model-picker" },
    { id: "temp_circumstances", label: "Circumstances", region: { x: 1.98, y: 26.85, w: 47.33, h: 2.99 }, body: "Add conditions that are true for the character just inside this conversation, such as being exhausted or under threat. These sit on top of whatever the story already says and never alter the character; they let you explore a what-if without touching the scene chain.", link: "circumstance-motivator-form" },
    { id: "temp_motivators", label: "Motivators", region: { x: 50.7, y: 26.85, w: 47.33, h: 2.99 }, body: "Add drives that push the character during this conversation only, such as a goal they are chasing or a fear they are hiding. Like the temporary circumstances beside them, they shape the voice for this chat and leave the character's story state untouched.", link: "circumstance-motivator-form" },
    { id: "custom_instructions", label: "Instructions", region: { x: 1.98, y: 33.64, w: 96.05, h: 6.47 }, body: "Extra notes for this conversation alone, layered on top of the chosen persona as its own block when messages are sent. Use it for one-off direction such as keeping replies brief; it never edits the persona you picked." },
    { id: "add_second", label: "Second character", region: { x: 61.53, y: 95.92, w: 26.99, h: 2.88 }, body: "Set up a second character so two of your characters can talk to each other through the AI. This opens a second setup window for the other character; once both are configured they hold the conversation between themselves." },
    { id: "start", label: "Start", region: { x: 89.45, y: 96.03, w: 8.57, h: 2.66 }, body: "Begin the conversation with the configured character. A new thread opens in the chat panel, ready for you to write to them as themselves at the chosen point in the story." },
  ],
}
