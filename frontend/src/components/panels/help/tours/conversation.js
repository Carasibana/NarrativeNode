// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: conversation. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "conversation",
  category: "Chat & AI",
  tier: "base",
  parent: "thread-browser",
  order: 0,
  title: "Conversation",
  intro: "A single conversation with the AI. The thread above holds the exchange so far, and the composer below is where you write your next message. Because the AI does not see your story unless you show it, the composer is also where you decide what context travels with each message: the scene in focus, specific entities or relationships, or an attached file.",
  screenshotFile: "conversation.webp",
  screenshotAlt: "Conversation screenshot.",
  sections: [
    { id: "thread", label: "Message thread", region: { x: 0, y: 0, w: 100, h: 89.86 }, body: "The running exchange between you and the AI, oldest at the top and newest at the bottom. This is the record of the conversation; it grows as you send messages and the AI replies." },
    { id: "composer", label: "Composer", region: { x: 0, y: 89.96, w: 100, h: 10.04 }, body: "The area where you compose your next message and decide what story context goes with it. Everything here feeds one outgoing message: the text you type, plus any scenes, entities, or relationships you choose to attach so the AI can reason about them." },
    { id: "composer_input", label: "Message box", region: { x: 2.01, y: 90.37, w: 81.32, h: 5.22 }, body: "Where you type the message you want to send. As you write, your story's entity names can be highlighted here so you can see at a glance which ones the AI will recognize when context is attached." },
    { id: "composer_send", label: "Send", region: { x: 85.33, y: 90.37, w: 12.66, h: 5.22 }, body: "Sends your message, together with any attached context, to the AI and waits for its reply. The exchange then joins the thread above." },
    { id: "composer_settings", label: "Composer settings", region: { x: 2.01, y: 96.79, w: 5.01, h: 2.01 }, body: "Chooses which connection and model answer you, the system prompt that frames how the AI behaves, and how far back through the message history the AI is given. These settings shape every message in this conversation rather than any one of them." },
    { id: "composer_attach_file", label: "Attach file", region: { x: 8.02, y: 96.79, w: 5.01, h: 2.01 }, body: "Attaches a file to this message so the AI can take it into account. Use it when the material you want the AI to see lives outside your story, such as a reference document or an image." },
    { id: "composer_favourites", label: "Favourites", region: { x: 14.04, y: 96.79, w: 5.01, h: 2.01 }, body: "Inserts a reusable snippet or prompt you have saved as a favourite. It saves retyping the wordings and instructions you reach for often when working with the AI." },
    { id: "composer_scene_context", label: "Pin scene", region: { x: 20.05, y: 96.79, w: 5.01, h: 2.01 }, body: "Pins the scene currently in focus on the canvas as context, so the AI sees that beat of the story alongside your message. This is the quickest way to ground a question in whatever scene you are working on." },
    { id: "composer_add_context", label: "Add context", region: { x: 26.07, y: 96.79, w: 5.01, h: 2.01 }, body: "Opens a picker for choosing exactly what the AI should see with your message: particular scenes, entities, relationships, or markers that resolve to the right point in the story. Because the AI has no view of your story on its own, attaching context here is how it learns who is who and where things stand at this point." },
    { id: "composer_highlight_names", label: "Highlight names", region: { x: 32.08, y: 96.79, w: 8.65, h: 2.01 }, body: "Highlights your story's entity names in colour as you type in the message box. It gives you a live preview of which characters, places, and other entities the AI could recognize, and you can choose which kinds of names to detect." },
    { id: "composer_auto_attach", label: "Auto-attach", region: { x: 41.74, y: 96.79, w: 9.66, h: 2.01 }, body: "Automatically attaches the entities you name in your message as context, instead of you adding each one by hand. It keeps the AI aware of who and what you are referring to without interrupting your writing to pin them." },
    { id: "composer_reasoning", label: "Reasoning effort", region: { x: 78.32, y: 96.79, w: 5.01, h: 2.01 }, body: "Sets how hard the model thinks before it answers, on connections and models that support a reasoning setting. More effort can give a more considered reply at the cost of speed." },
  ],
}
