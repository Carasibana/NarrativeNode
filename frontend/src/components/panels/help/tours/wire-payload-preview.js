// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: wire-payload-preview. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "wire-payload-preview",
  category: "chat",
  tier: "base",
  parent: "message-bubble",
  order: 0,
  title: "Wire Payload Preview",
  intro: "This preview shows exactly what would be sent to the AI if you sent your message right now: the instructions that set its behaviour, any story context that travels with the request, and your own message. It is a look-before-you-send window, so you can check that the right material is going across and nothing unexpected is attached. Nothing is sent while you are reading it.",
  screenshotFile: "wire-payload-preview.webp",
  screenshotAlt: "Wire Payload Preview screenshot.",
  sections: [
    { id: "modal", label: "Preview", region: { x: 26.65, y: 14.98, w: 46.73, h: 70.04 }, body: "The window holding the full preview of an outgoing message. Close it to return to your conversation without sending anything." },
    { id: "body", label: "Body", region: { x: 26.69, y: 18.64, w: 46.65, h: 66.3 }, body: "The working area of the preview, holding the controls along the top and the assembled message below. Everything shown here is a copy for inspection, not the live message." },
    { id: "scope_toggle", label: "History scope", region: { x: 27.31, y: 19.22, w: 12.75, h: 2.15 }, body: "Chooses whether the preview shows only the message you are about to send, or that message together with the earlier conversation it would be sent alongside. Switch to the fuller view to see everything the AI would receive as context." },
    { id: "view_mode", label: "View mode", region: { x: 65.4, y: 19.22, w: 7.31, h: 2.15 }, body: "Switches between a tidy, formatted reading view and the plain, literal text as it is actually sent. The literal view is handy when you want to see the exact wording with no formatting hiding any of it." },
    { id: "messages", label: "Messages", region: { x: 26.69, y: 22.03, w: 46.65, h: 62.91 }, body: "The assembled request laid out in order, each part labelled by who it comes from: the setup instructions, the story context, and your own message. Reading down the list shows you precisely what the AI will see and in what sequence." },
  ],
}
