"""
Export renderer package — Phase 1.12a modular export pipeline.

Importing this package triggers side-effect registration of every
renderer module listed below. After import, the registry is fully
populated and the router can dispatch `POST /api/project/export/{fmt}`
requests by looking the format up via `get_renderer`.

To add a new renderer:
  1. Create `backend/services/renderers/{format}.py` following the
     contract documented in `registry.py`.
  2. Add `from . import {format}  # noqa: F401` to this file so the
     module gets imported (and therefore self-registered).
  3. Enable the matching radio in `ExportDialog.jsx`.
  4. See `docs/export-renderer-guide.md` for the full walkthrough.
"""
from .registry import RendererSpec, register, get_renderer, all_renderers  # noqa: F401

# Each import below triggers side-effect registration via `register(SPEC)`
# at the bottom of the renderer module.
from . import html  # noqa: F401
from . import markdown  # noqa: F401
from . import txt  # noqa: F401
from . import pdf  # noqa: F401
from . import docx  # noqa: F401
# Variants — registered after their parent format for readability.
# Each variant_of points at the parent's format_id; the frontend
# groups them under the parent in the Export dialog's Format picker.
from . import markdown_novelcrafter  # noqa: F401
from . import docx_novelcrafter  # noqa: F401
from . import docx_shunn  # noqa: F401
from . import pdf_shunn  # noqa: F401
