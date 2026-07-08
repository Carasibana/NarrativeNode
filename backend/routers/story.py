from fastapi import APIRouter
from models.story import Story
from services import seeds_service, user_preferences_service, file_service
from services.pov_service import compute_pov_sequence
import state

router = APIRouter(prefix="/story", tags=["story"])


# Fields on `UserPreferences` that map directly onto fields on
# `Story`. Each entry is (prefs_field, story_field). When the
# preference value is not None we copy it onto the new Story in
# the /reset endpoint below. Keeping this as a single list beats
# ten individual `if` statements AND makes it obvious at a glance
# which prefs consume which Story fields.
_PREFS_TO_STORY = [
    ("author_name",                        "author"),
    ("default_tense",                      "tense"),
    ("default_pov_type",                   "pov_type_default"),
    ("default_language",                   "language"),
    ("default_chapter_label",              "chapter_label"),
    ("default_act_label",                  "act_label"),
    ("default_accent_color",               "accent_color"),
    ("default_pov_color",                  "pov_color"),
    ("default_autosave_enabled",           "autosave_enabled"),
    ("default_autosave_interval_minutes",  "autosave_interval_minutes"),
    ("default_awareness_rollover_check_enabled", "awareness_rollover_check_enabled"),
    # Phase 1.23 — Time Tracking defaults.
    ("default_time_tracking_enabled",      "time_tracking_enabled"),
    ("default_allow_negative_time",        "allow_negative_time"),
    ("default_time_format",                "time_format"),
    ("default_week_start",                 "week_start"),
    ("default_gap_shift_threshold",        "gap_shift_threshold"),
]


@router.get("/", response_model=Story)
def get_story():
    """Return full story state."""
    return state.get_story()


@router.put("/", response_model=Story)
def update_story(updated: Story):
    """Replace full story state."""
    state.set_story(updated)
    return updated


def apply_user_defaults_to_fresh_story(story: Story) -> None:
    """Apply user preferences + default seeds to a freshly-created
    blank Story. Mutates `story` in place and writes the default
    seeds (if any) to `state.set_seeds`.

    Two distinct "seeding" flows:

    1. **User preferences** (`preferences/user_preferences.json`) →
       Story fields. Covers author, tense, POV type, language,
       chapter/act labels, accent/POV colours, autosave state +
       interval. Null = no override; the Story keeps its built-in
       default.

    2. **Default seeds** (`preferences/default_seeds.json`) →
       project seeds. Covers attribute stubs + bundled preset
       lists. Bundled lists are also promoted into
       `story.preset_lists` so preset-type stubs resolve cleanly.

    Default seeds are a TEMPLATE — once copied here, the new
    project's seeds are independent; later edits to
    `preferences/default_seeds.json` don't retroactively affect
    this project. Same for user preferences.

    Called from `POST /story/reset` (user clicks "New Project")
    AND from the FastAPI lifespan at startup (so the default empty
    project the program opens with reflects the user's preferences
    and default seeds).
    """
    prefs = user_preferences_service.read_user_preferences()
    for prefs_field, story_field in _PREFS_TO_STORY:
        value = getattr(prefs, prefs_field, None)
        if value is not None:
            setattr(story, story_field, value)

    default_seeds = seeds_service.read_default_seeds_file()
    if not default_seeds.is_empty():
        # Promote bundled preset lists into story.preset_lists so
        # preset-type stubs resolve when entities are created. Both
        # places (seeds.preset_lists AND story.preset_lists) end up
        # holding the lists — intentional, matches the post-import
        # reconciliation pattern.
        seeds_service.sync_bundled_preset_lists_to_project(default_seeds, story)
        # Deep-copy so edits to the project's seeds don't mutate
        # the on-disk default seeds file.
        state.set_seeds(default_seeds.model_copy(deep=True))


@router.post("/reset", response_model=Story)
def reset_story():
    """Reset story to a blank new story, pre-seeded with any
    non-null values from the user's `user_preferences.json` AND the
    user-level default-seeds template if configured. Called from
    frontend `newProject()`."""
    story = state.reset_story()
    # Phase 5.2a — a fresh project starts cover-less. Loading a .nnz
    # resets the cover via unpack_project; New Project doesn't go through
    # unpack, so clear any cover carried from the previous project here.
    file_service.clear_cover()
    apply_user_defaults_to_fresh_story(story)
    return story


@router.get("/pov-sequence")
def get_pov_sequence():
    """Return the ordered POV sequence — list of scene nodes in narrative order."""
    story = state.get_story()
    return compute_pov_sequence(story)
