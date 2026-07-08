# User Preferences — field reference

This file explains every entry in `preferences/user_preferences.json`.
The JSON file ships with all fields set to `null` — a `null` value means
"no preference set, use the application's built-in default." Replace
any `null` with a value of your choice to override the default for
every **new** project you create. Existing projects are untouched.

Most users don't need to edit this JSON directly — the Program Settings
tab inside the app's Settings panel provides a form UI that writes to the
same file. Hand-editing is only needed if you're scripting setups or
syncing preferences across machines.

---

## Schema

```jsonc
{
  "version": "0.1.14.0",
  "author_name": null,
  "default_tense": null,
  "default_pov_type": null,
  "default_language": null,
  "default_chapter_label": null,
  "default_act_label": null,
  "default_accent_color": null,
  "default_pov_color": null,
  "default_autosave_enabled": null,
  "default_autosave_interval_minutes": null
}
```

---

## Fields

### `version` — string

Schema version marker. Matches the application version at the time
the schema was last changed. Leave this alone unless you know what
you're doing; the app reads it to run migrations when the schema
evolves.

### `author_name` — string or null

Pre-fills the **Author** field in Story Settings for new projects.
Example: `"Jane Doe"`. Leave `null` to leave the Author field empty
on new projects (current built-in behaviour).

### `default_tense` — string or null

Default narrative tense for new projects. Accepted values:
- `"past"` — Past tense (most common).
- `"present"` — Present tense.

`null` = no preference; the Story field starts unset.

### `default_pov_type` — string or null

Default POV type for new projects. Accepted values:
- `"1st Person"`
- `"2nd Person"`
- `"3rd Person"`

`null` = no preference.

### `default_language` — string or null

Default language for new projects. Freeform string used for AI
context / prompt templates — not an ISO code. Example: `"English"`,
`"Français"`, `"日本語"`. `null` = no preference.

### `default_chapter_label` — string or null

Override for the term "Chapter" in the canvas chapter header. Useful
if you're writing in a non-novel format — e.g. `"Episode"` for TV,
`"Section"` for technical writing, `"Scene"` for stage plays. `null`
= use the app's default `"Chapter"`.

### `default_act_label` — string or null

Override for the term "Act" in the canvas header. Same pattern as
`default_chapter_label`. Examples: `"Part"`, `"Phase"`. `null` = use
the app's default `"Act"`.

### `default_accent_color` — hex string or null

Your preferred UI accent colour for new projects. Must be a 7-character
hex string including the `#` — e.g. `"#7c3aed"` (the built-in purple
default), `"#10b981"` (green), `"#ef4444"` (red). `null` = use the
built-in default.

### `default_pov_color` — hex string or null

Your preferred POV character highlight colour for new projects. Same
hex format as `default_accent_color`. Built-in default is a warm gold
(`"#eab308"`). `null` = use the built-in default.

### `default_autosave_enabled` — bool or null

Whether autosave should be on or off by default in new projects.
- `true` — autosave on (built-in default).
- `false` — autosave off.
- `null` — no preference; inherits the built-in default.

### `default_autosave_interval_minutes` — integer or null

How often autosave fires for new projects, in minutes. Built-in
default is `5`. Minimum realistic value is `1` (sub-minute autosave
would be noisy; the UI clamps this). `null` = built-in default.

---

## Where is this file?

Located at `<app root>/preferences/user_preferences.json`. The app
creates this file automatically on first launch if it's missing (or
if you've deleted it manually). A blank version lives in the git
repository so the schema shape is always visible; your personal
edits to the file stay local and aren't tracked (see the repo's
`.gitignore` / `skip-worktree` configuration).

## Default seeds

Default **seeds** (attribute stubs + bundled preset lists that seed
new projects) live in a separate file — `preferences/default_seeds.json`
— and are edited via the Default Seeds tab in the Settings panel, not
via this JSON. Mentioned here because users sometimes expect them in
the same file. See the Default Seeds tab's in-app explanation for
details.
