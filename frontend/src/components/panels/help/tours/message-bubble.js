// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: message-bubble. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "message-bubble",
  category: "Chat & AI",
  tier: "base",
  parent: "conversation",
  order: 0,
  title: "Message Bubble",
  intro: "A single message in the conversation with the AI. Each one carries the text that was exchanged, plus the model and time it was sent. On the AI's replies, a row of actions lets you fold the message back into your story, reuse it, or tidy the thread. The actions appear when you hover over the message.",
  screenshotFile: "message-bubble.webp",
  screenshotAlt: "Message Bubble screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 4.81, y: 10.53, w: 90.37, h: 18.71 }, body: "Identifies the message: who sent it, which model produced an AI reply, and when. For replies written in a character's voice, the character's name and colour appear here so you can tell speakers apart at a glance." },
    { id: "body", label: "Text", region: { x: 4.81, y: 33.92, w: 90.37, h: 22.81 }, body: "The message text itself, the actual words exchanged with the AI. Long messages can be collapsed to a short preview so the thread stays readable." },
    { id: "actions", label: "Actions", region: { x: 4.81, y: 61.4, w: 90.37, h: 28.07 }, body: "The row of actions for this message. These let you bring the message into your story, copy or edit it, reshape the conversation, or remove it. The row appears when you hover over the message." },
    { id: "action_apply", label: "Apply to section", region: { x: 7.78, y: 66.08, w: 7.41, h: 23.39 }, body: "Drops the message text into a section of your story in the editor, either replacing what is there, adding to the end, or adding to the start. This is the main way a passage the AI helped you write becomes part of your manuscript. Available when the editor is open on a section." },
    { id: "action_copy", label: "Copy", region: { x: 16.67, y: 66.08, w: 7.41, h: 23.39 }, body: "Copies the message text to the clipboard so you can paste it anywhere outside the conversation." },
    { id: "action_edit", label: "Edit", region: { x: 25.56, y: 66.08, w: 7.41, h: 23.39 }, body: "Edits the wording of the message in place. On your own messages you can also resubmit the edited version to get a fresh reply; on the AI's messages the edit is text only and does not regenerate the response." },
    { id: "action_collapse", label: "Collapse", region: { x: 34.44, y: 66.08, w: 7.41, h: 23.39 }, body: "Shrinks a long message to a short preview, or expands it back to full height. Useful for keeping a busy conversation scannable without losing anything." },
    { id: "action_resend", label: "Resend", region: { x: 43.33, y: 66.08, w: 7.41, h: 23.39 }, body: "Sends one of your own messages again to get a fresh reply. If a reply already sits below it, that reply is discarded first so the new one takes its place." },
    { id: "action_favourite", label: "Favourite", region: { x: 52.22, y: 66.08, w: 7.41, h: 23.39 }, body: "Marks the message as a favourite so you can find and reuse it later. A second click makes it sticky, keeping it close to hand across conversations." },
    { id: "action_retry", label: "Retry", region: { x: 52.22, y: 66.08, w: 7.41, h: 23.39 }, body: "Discards this AI reply and asks the model to answer the same question again, in case a different attempt lands better." },
    { id: "action_fork", label: "Fork", region: { x: 61.11, y: 66.08, w: 7.41, h: 23.39 }, body: "Starts a new thread carrying the conversation up to and including this message, so you can explore a different direction without disturbing the original. The original stays saved in your thread browser." },
    { id: "action_view_context", label: "View context", region: { x: 70, y: 66.08, w: 7.41, h: 23.39 }, body: "Opens the exact background that was sent to the AI alongside this message, such as the scene and any pinned items that were in force at that point. It lets you see what the model could actually draw on when it replied.", link: "wire-payload-preview" },
    { id: "action_add_cue", label: "Add cue", region: { x: 78.89, y: 66.08, w: 7.41, h: 23.39 }, body: "A planned action, not yet available, so the button stays disabled for now. Once it ships it will let you save a useful part of the message as a reusable context cue, a snippet you can hand to the AI again in later conversations without retyping it." },
    { id: "action_delete", label: "Delete", region: { x: 87.78, y: 66.08, w: 7.41, h: 23.39 }, body: "Removes the message from the conversation. Deleting one of your own messages can also remove the AI reply paired with it." },
  ],
}
