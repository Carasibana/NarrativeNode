// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: thread-browser. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "thread-browser",
  category: "Chat & AI",
  tier: "base",
  parent: "chat-panel",
  order: 0,
  title: "Thread Browser",
  intro: "Every chat you hold with the AI about your story is kept here as its own conversation, so you can return to an earlier thread rather than starting over each time. The list gathers them all in one place: search and filter to find the one you want, open it to pick up where you left off, or begin a fresh thread. Two kinds live side by side here: an open conversation with the assistant, and a character chat, where the AI answers in the voice of one of your characters.",
  screenshotFile: "thread-browser.webp",
  screenshotAlt: "Thread Browser screenshot.",
  sections: [
    { id: "search", label: "Search", region: { x: 3.01, y: 1.2, w: 71.95, h: 2.61 }, body: "Find a conversation by typing part of its name or wording from inside it. The list narrows as you type to just the threads that match, which helps when you have built up many over a long project." },
    { id: "tabs", label: "Filter tabs", region: { x: 0, y: 4.67, w: 100, h: 3.56 }, body: "Narrow the list by which story a conversation belongs to: see them all together, just the ones for the story you currently have open, or those tied to no loaded project. Useful for keeping one story's discussions separate from another's." },
    { id: "more_actions", label: "More actions", region: { x: 91.62, y: 4.87, w: 6.37, h: 2.46 }, body: "Opens a small menu of upkeep actions for the conversation list, such as rebuilding its index if the listing ever looks out of date. These are occasional maintenance tasks rather than everyday use." },
    { id: "select_mode", label: "Select", region: { x: 84.86, y: 4.94, w: 6.27, h: 2.11 }, body: "Switches the list into selection mode so you can tick several conversations and act on them together, such as deleting a batch of old threads in one go. Turn it off to go back to opening conversations with a single click." },
    { id: "threads", label: "Conversation list", region: { x: 0, y: 8.23, w: 100, h: 85.95 }, body: "The conversations themselves, with pinned ones gathered at the top and, in the all-stories view, grouped under the story each belongs to. Select any row to open that conversation and continue it." },
    { id: "new_conversation", label: "New conversation", region: { x: 2.51, y: 95.29, w: 46.24, h: 3.71 }, body: "Starts a fresh chat with the AI about your story. This is the open assistant, used for planning, brainstorming, or asking it to work with your story's details, rather than speaking as any one character." },
    { id: "new_character_chat", label: "New character chat", region: { x: 51.25, y: 95.29, w: 46.24, h: 3.71 }, body: "Starts a conversation where the AI answers in the voice of one of your characters, drawing on what that character is like and knows at the point you choose. A short setup step lets you pick the character and the moment in the story before the chat begins.", link: "character-chat-setup" },
  ],
}
