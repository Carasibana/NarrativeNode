"""Phase 1.25h — LLM template import endpoints.

`POST /project/import/template` — upload a populated markdown story
template, parse it, and either return parse errors (when `preview=true`
or any error blocks application) or apply the import to the active
project in `new` or `merge` mode.

The parser + applier live in `services.template_import_service`. This
router wraps them in a multipart form so the upload + mode flag travel
in one request, mirroring the existing seeds / entity-import endpoints.
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from services import template_import_service
from services.import_engine import apply_import_ir_new, apply_import_ir_merge
import state


router = APIRouter(prefix="/project/import/template", tags=["template-import"])


@router.post("")
async def import_template(
    file: UploadFile = File(...),
    mode: str = Form("new"),
    preview: bool = Form(False),
    skip_errors: bool = Form(False),
    layout_mode: str = Form("columns"),
    # Phase 5.9 — strip leading "Chapter N" / "Act N" prefixes from imported
    # chapter/act titles. Default on; off = titles verbatim.
    clean_chapter_act_titles: bool = Form(True),
):
    """Import a populated NarrativeNode story template.

    Multipart form:
      - `file`    — the markdown template (UTF-8).
      - `mode`    — `new` (wipe + rebuild) or `merge` (name-suffix
                    dedup against the active project).
      - `preview` — when true, the parser runs but no apply happens.
                    Returns the parse summary and structured errors so
                    the UI can show a confirm dialog before commit.

    Response shape (preview or success):
      {
        "applied": bool,
        "errors": [{line, expected, found, hint}, ...],
        "summary": {entities, relationships, knowledges, scenes, ...},
      }
    """
    if mode not in ("new", "merge"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode {mode!r}; must be 'new' or 'merge'.",
        )
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Template file must be UTF-8 encoded.",
        )

    ir, diagnostics = template_import_service.parse_template(text)
    err_payload = [d.to_dict() for d in diagnostics]
    # Hard errors block the apply by default; warnings (auto-corrected
    # or skipped lines) do not. The writer can override the block via
    # the dialog's "Apply anyway, skipping the problematic lines"
    # button, which sends `skip_errors=true` — the parser already
    # returned None for the broken bullets so they're absent from the
    # IR; the override just lets the rest of the file apply.
    has_hard_error = any(d.severity == "error" for d in diagnostics)

    # Preview always returns diagnostics + a dry-run summary (no apply).
    if preview or (has_hard_error and not skip_errors):
        return {
            "applied": False,
            "errors": err_payload,
            "summary": {
                "characters": len(ir.characters),
                "locations": len(ir.locations),
                "items": len(ir.items),
                "factions": len(ir.factions),
                "customs": len(ir.customs),
                "relationships": len(ir.relationships),
                "knowledges": len(ir.knowledges),
                "scenes": len(ir.scenes),
                "chapters": len(ir.chapters),
                "preset_lists": len(ir.preset_lists),
                "custom_categories": len(ir.custom_categories),
            },
        }

    if mode == "new":
        story, summary = apply_import_ir_new(
            ir, layout_mode=layout_mode,
            clean_chapter_act_titles=clean_chapter_act_titles,
        )
        state.set_story(story)
        state.set_active_file_path(None)
    else:
        story = state.get_story()
        summary = apply_import_ir_merge(
            ir, story, layout_mode=layout_mode,
            clean_chapter_act_titles=clean_chapter_act_titles,
        )

    return {
        "applied": True,
        "errors": [],
        "summary": summary,
    }
