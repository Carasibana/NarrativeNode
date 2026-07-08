"""Phase 1.25e — Shunn manuscript event-stream walker.

Format-agnostic walker that turns an `ExportModel` into a sequence of
typed events that the DOCX and PDF Shunn renderers consume. Both
renderers share this single pass so format details (font / page geometry
/ run encoding) live in the renderers, while content sequencing
(chapter ordering, scene-break placement, first-para-after-heading
rules, end marker) lives here.

Reference spec: `.References/Shunn Manuscript Format/Shunn Manuscript
Format - Specification.md`. The renderer-specific implementation notes
in §10 of that spec map directly onto the events yielded below.

Per the v0.1.25e direction (no personal-info collection): the title
page renders writer-supplied data we already know (`story.title`,
`story.author`) and uses placeholder text like `[Address]` / `[Phone]`
/ `[Email]` for fields the program does not store. The writer fills
those in by hand in their word processor before submission.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Iterator, Literal, Optional, Union


# ── Event dataclasses ─────────────────────────────────────────────────


@dataclass
class TitlePageEvent:
    """Renders the title page. The contact-block lines render single-
    spaced in the top-left; `word_count_line` is the top-right corner
    text; `title` is the centred title block; `byline` is the centred
    line below the title."""
    contact_lines: list[str]
    word_count_line: str
    title: str
    byline: str


@dataclass
class ChapterStartEvent:
    """Renders a centred chapter heading, preceded by a hard page
    break (the renderer emits the page-break-before behaviour). The
    spec calls for the heading sitting roughly one-third down the new
    page; the renderer handles vertical placement.

    `label` is the heading text — e.g. "Chapter 1", "1", "Prologue",
    "Chapter 1 — The Title". The walker passes through whatever the
    chapter has; if the chapter has no title, falls back to
    `Chapter <number>`."""
    label: str


@dataclass
class ParagraphEvent:
    """One body paragraph. `runs` is a list of styled text fragments
    (plain / italic / bold combinations) that the renderer concatenates
    into a single paragraph with appropriate formatting per run.

    `flush_left=True` marks the first paragraph of the chapter (after
    the chapter heading) or the first paragraph after a scene break.
    Per Shunn, those paragraphs render with no first-line indent;
    every other paragraph gets the standard 0.5-inch first-line indent."""
    runs: list["Run"]
    flush_left: bool = False


@dataclass
class Run:
    """One styled fragment of text within a paragraph. Italic / bold
    flags map onto the renderer's run formatting."""
    text: str
    italic: bool = False
    bold: bool = False


@dataclass
class SceneBreakEvent:
    """Centred `#` separator between scenes within the same chapter.
    Standard double-spacing above and below; no extra blank lines."""
    pass


@dataclass
class EndMarkerEvent:
    """Centred `# # #` after the final paragraph. Marks the end of the
    manuscript; conventional alternative is `THE END`."""
    pass


ShunnEvent = Union[
    TitlePageEvent, ChapterStartEvent, ParagraphEvent,
    SceneBreakEvent, EndMarkerEvent,
]


# ── Public entry ───────────────────────────────────────────────────────


def walk_shunn(model, options=None) -> Iterator[ShunnEvent]:
    """Yield Shunn-shaped events for the given ExportModel. The
    renderers iterate this once and turn each event into format-
    appropriate output.

    `options` (Optional[ExportOptions]) controls per-scene content
    selection via `include_scene_description` + `include_scene_body`.
    When both flags are on we emit description paragraphs first
    (typeset as flush-left Normal paragraphs), then the prose body.
    Shunn manuscripts traditionally carry only the prose; description
    here is opt-in by writer choice. When `options` is None or omitted,
    defaults to body-only (today's behaviour preserved)."""
    include_description = bool(getattr(options, "include_scene_description", False)) if options else False
    include_body = bool(getattr(options, "include_scene_body", True)) if options else True

    yield _build_title_page_event(model)

    first_chapter = True
    for section in (model.sections or []):
        # The Shunn spec doesn't address acts directly; the comment in
        # §9 suggests a separate centred page between acts. We piggy-
        # back on the existing chapter-break behaviour: an act header
        # in NarrativeNode shows as a `ExportSection` of kind 'act'
        # whose `chapters` are the act's chapters. We don't currently
        # emit an act page; chapters within the act render normally.
        # Expose only `chapter` / `unchaptered` sections; for `act`
        # sections, recurse into their nested children.
        for chapter_section in _flatten_act_chapters(section):
            scenes = chapter_section.scenes or []
            if not scenes:
                continue
            yield ChapterStartEvent(label=_chapter_label(
                chapter_section, first_chapter=first_chapter,
            ))
            first_chapter = False
            # Walk scenes within the chapter; emit a SceneBreak
            # between consecutive scenes.
            for scene_idx, scene in enumerate(scenes):
                if scene_idx > 0:
                    yield SceneBreakEvent()
                # First paragraph of the scene is flush-left (after
                # chapter heading OR after scene break — both same).
                first_para_in_scene = True
                if include_description:
                    description_text = (scene.description or "").strip()
                    if description_text:
                        # One ParagraphEvent per blank-line-separated
                        # paragraph in the description, with one literal
                        # un-styled Run of text per paragraph. Shunn
                        # renderers don't need rich runs for the
                        # description; the description is the writer's
                        # own beat-summary text.
                        for desc_para in [p.strip() for p in description_text.split("\n\n") if p.strip()]:
                            yield ParagraphEvent(
                                runs=[Run(text=desc_para)],
                                flush_left=first_para_in_scene,
                            )
                            first_para_in_scene = False
                if include_body:
                    for paragraph_runs in _parse_tiptap_paragraphs(scene.main_content_html or ""):
                        yield ParagraphEvent(
                            runs=paragraph_runs,
                            flush_left=first_para_in_scene,
                        )
                        first_para_in_scene = False

    yield EndMarkerEvent()


# ── Title-page composition ────────────────────────────────────────────


_PLACEHOLDER_CONTACT_LINES: tuple[str, ...] = (
    "[Author Legal Name]",
    "[Address]",
    "[Phone]",
    "[Email]",
)


def _build_title_page_event(model) -> TitlePageEvent:
    """Compose the title-page event from the ExportModel. Uses what the
    project knows (`title`, `author`) and placeholders for the rest.
    The writer fills the placeholders in their word processor before
    submission."""
    title_text = (model.title or "[Title]").upper()
    byline_name = (model.author or "[Author Name]").strip()
    byline_text = f"A Novel by {byline_name}"
    word_count = _approximate_word_count(model)
    word_count_line = f"About {word_count:,} words"
    # Contact block: the Story doesn't store legal name / address /
    # phone / email — the writer fills these in by hand. The byline
    # name (story.author) is used for the title-block byline only;
    # the contact-block first line stays a placeholder so the writer
    # can choose whether to use a pseudonym or legal name.
    contact_lines: list[str] = list(_PLACEHOLDER_CONTACT_LINES)
    return TitlePageEvent(
        contact_lines=contact_lines,
        word_count_line=word_count_line,
        title=title_text,
        byline=byline_text,
    )


def _approximate_word_count(model) -> int:
    """Sum word counts across every scene body in the model, rounded to
    the nearest 1,000. The spec calls for the rounded form on the
    title page (`About 80,000 words`); exact counts read amateur."""
    total = 0
    for section in (model.sections or []):
        for chapter_section in _flatten_act_chapters(section):
            for scene in (chapter_section.scenes or []):
                total += _count_words_in_html(scene.main_content_html or "")
    if total <= 0:
        return 0
    # Round to the nearest 1,000 (minimum 1,000).
    return max(1000, round(total / 1000) * 1000)


def _count_words_in_html(html: str) -> int:
    """Strip HTML tags and split on whitespace. Works well enough for
    TipTap's straightforward `<p>` / `<em>` / `<strong>` markup."""
    if not html:
        return 0
    text = re.sub(r"<[^>]+>", " ", html)
    return len([w for w in text.split() if w])


# ── Section / chapter helpers ─────────────────────────────────────────


def _flatten_act_chapters(section):
    """Yield chapter (or unchaptered) sections from `section`. Acts
    are containers; their chapters are exposed at the same level as
    top-level chapters. Unchaptered sections yield themselves."""
    kind = getattr(section, "kind", "") or ""
    if kind == "act":
        for child in (section.children or []):
            yield from _flatten_act_chapters(child)
    else:
        yield section


def _chapter_label(chapter_section, *, first_chapter: bool) -> str:
    """Return the centred heading for a chapter section. Uses the
    chapter's own number + title; falls back to a synthesised label
    when neither is set."""
    label = (getattr(chapter_section, "label", "") or "").strip()
    title = (getattr(chapter_section, "title", "") or "").strip()
    if label and title:
        return f"{label} — {title}"
    if label:
        return label
    if title:
        return title
    return "Chapter"


# ── TipTap HTML → paragraph runs ──────────────────────────────────────


def _parse_tiptap_paragraphs(html: str) -> list[list[Run]]:
    """Parse a TipTap-shaped HTML body into a list of paragraphs;
    each paragraph is a list of styled `Run` fragments. Block tags
    (`<p>`, `<h1>..<h6>`, `<blockquote>`, `<li>`, `<pre>`) all become
    paragraphs. Inline `<em>` / `<i>` flips italic on; `<strong>` /
    `<b>` flips bold on. Other tags are ignored; their contents pass
    through. Media tags (`<img>` / `<audio>` / `<video>`) drop — Shunn
    is text-only.

    Empty paragraphs are skipped (TipTap inserts `<p></p>` for blank
    lines; Shunn doesn't use blank lines between paragraphs)."""
    parser = _ShunnHTMLParser()
    parser.feed(html or "")
    parser.close()
    return [p for p in parser.paragraphs if p]


_BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "pre"}
_DROP_BLOCK_TAGS = {"img", "audio", "video", "picture", "figure", "source", "track"}


class _ShunnHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: list[list[Run]] = []
        self._current: list[Run] = []
        self._italic_depth = 0
        self._bold_depth = 0
        self._in_drop = 0

    def handle_starttag(self, tag, attrs):
        if tag in _DROP_BLOCK_TAGS:
            self._in_drop += 1
            return
        if tag in _BLOCK_TAGS:
            # Start a fresh paragraph; flush the previous one if any.
            if self._current:
                self.paragraphs.append(self._coalesce(self._current))
                self._current = []
            return
        if tag in ("em", "i"):
            self._italic_depth += 1
            return
        if tag in ("strong", "b"):
            self._bold_depth += 1
            return
        if tag == "br":
            # Treat <br> as a paragraph break in the manuscript.
            if self._current:
                self.paragraphs.append(self._coalesce(self._current))
                self._current = []
            return

    def handle_endtag(self, tag):
        if tag in _DROP_BLOCK_TAGS:
            if self._in_drop > 0:
                self._in_drop -= 1
            return
        if tag in _BLOCK_TAGS:
            if self._current:
                self.paragraphs.append(self._coalesce(self._current))
                self._current = []
            return
        if tag in ("em", "i"):
            if self._italic_depth > 0:
                self._italic_depth -= 1
            return
        if tag in ("strong", "b"):
            if self._bold_depth > 0:
                self._bold_depth -= 1
            return

    def handle_data(self, data):
        if self._in_drop > 0:
            return
        if not data:
            return
        self._current.append(Run(
            text=data,
            italic=self._italic_depth > 0,
            bold=self._bold_depth > 0,
        ))

    def close(self):
        super().close()
        if self._current:
            self.paragraphs.append(self._coalesce(self._current))
            self._current = []

    @staticmethod
    def _coalesce(runs: list[Run]) -> list[Run]:
        """Merge adjacent runs with identical formatting so the
        renderer doesn't get a long list of single-character runs
        when the source HTML had whitespace fragments."""
        out: list[Run] = []
        for r in runs:
            if out and out[-1].italic == r.italic and out[-1].bold == r.bold:
                out[-1] = Run(
                    text=out[-1].text + r.text,
                    italic=out[-1].italic,
                    bold=out[-1].bold,
                )
            else:
                out.append(r)
        # Strip leading/trailing whitespace at paragraph boundaries —
        # TipTap occasionally emits leading newline-whitespace inside
        # `<p>` that would render as a stray space.
        if out:
            out[0] = Run(text=out[0].text.lstrip(), italic=out[0].italic, bold=out[0].bold)
            out[-1] = Run(text=out[-1].text.rstrip(), italic=out[-1].italic, bold=out[-1].bold)
            out = [r for r in out if r.text]
        return out


# ── Helpers exposed for the renderers ─────────────────────────────────


def shortened_title(full_title: str) -> str:
    """Default running-header shortened title: first two words of the
    full title, with non-alphanumerics squashed. Falls back to the full
    title or a placeholder when empty."""
    if not full_title:
        return "[Short Title]"
    words = [w for w in re.split(r"\s+", full_title.strip()) if w]
    if not words:
        return "[Short Title]"
    if len(words) <= 2:
        return " ".join(words)
    return " ".join(words[:2])


def author_last_name(author: Optional[str]) -> str:
    """Default running-header last name: last whitespace-separated word
    of the author string. Falls back to placeholder when empty. Single-
    name authors (e.g. `Carol`) come back as that single name."""
    if not author:
        return "[Last Name]"
    words = [w for w in re.split(r"\s+", author.strip()) if w]
    if not words:
        return "[Last Name]"
    return words[-1]
