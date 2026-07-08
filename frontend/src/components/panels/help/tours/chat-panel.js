// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: chat-panel. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "chat-panel",
  category: "Chat & AI",
  tier: "base",
  parent: "dock",
  order: 2,
  title: "Chat Panel",
  intro: "The chat panel is your conversation channel with the AI about your story, docked beside the canvas so you can talk while you plan. It holds your saved conversations and the running thread, and the AI can read from and act on your story through it. This is also where character chats appear, letting one of your characters answer in their own voice.",
  screenshotFile: "chat-panel.webp",
  screenshotAlt: "Chat Panel screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.25, y: 0, w: 99.75, h: 3.72 }, body: "Names the active conversation and gathers its controls in one strip: which connection and model are answering, and toggles for how messages are shown. For a character chat it instead shows who you are talking with and the point in the story they are speaking from." },
    { id: "close", label: "Close", region: { x: 94.14, y: 1.14, w: 2.86, h: 1.35 }, body: "Hides the chat panel and returns the full width to the canvas. Your conversations are kept, so reopening the panel brings the active thread back exactly as you left it." },
    { id: "content", label: "Content", region: { x: 0.25, y: 3.72, w: 99.75, h: 96.28 }, body: "The conversation itself: the back-and-forth of messages with the AI, newest at the bottom. When no thread is open this area lists your saved conversations so you can pick one up or start a new one." },
  ],
}
