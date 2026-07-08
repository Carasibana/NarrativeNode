"""MCP stdio wrapper for NarrativeNode — Phase 2.14.

Standalone process spawned by MCP host apps (Claude Desktop, Claude
Code) over stdio. Boots clean regardless of whether NarrativeNode is
running — the host always sees the `narrativenode` server as healthy
at handshake. Individual tool calls forward to the live NarrativeNode
MCP server over HTTP when it's running; when it isn't, calls return a
friendly JSON-RPC error envelope ("NarrativeNode isn't running") rather
than crashing.

This decouples the host's boot-time handshake from NN's runtime state.
Before this wrapper, hosts launched at OS login would mark the
`narrativenode` server unhealthy on every boot until NN itself was
running and the upstream URL became reachable.

═══ Launch from a host config ═══

  Claude Desktop's `claude_desktop_config.json`:
    {
      "mcpServers": {
        "narrativenode": {
          "command": "<NN_ROOT>/.venv/Scripts/python.exe",
          "args": ["<NN_ROOT>/backend/scripts/mcp_stdio_launcher.py"]
        }
      }
    }

  Claude Code (stdio transport):
    claude mcp add narrativenode \\
      <NN_ROOT>/.venv/Scripts/python.exe \\
      <NN_ROOT>/backend/scripts/mcp_stdio_launcher.py

  Use the venv Python explicitly — the wrapper depends on the `mcp`
  package which is installed in NN's venv. Using a system Python that
  lacks the package will produce a startup error.

═══ Architecture ═══

  Host (Claude Desktop)
    │
    │ stdio JSON-RPC (mcp.server.lowlevel.Server)
    │
  this wrapper
    │
    │ HTTP (mcp.client.streamable_http) — per-call connection
    │
  NarrativeNode FastMCP server at http://127.0.0.1:13316/mcp/server/

The catalogue served at handshake is read from
`mcp_catalogue.json` sitting next to this script. NarrativeNode
regenerates that file from its live FastMCP registry whenever the
MCP listener starts (see `services/mcp_control.py:_ensure_catalogue_current`).

═══ Error envelopes ═══

  - Upstream connection refused / timeout → JSON-RPC result with a
    single TextContent saying "NarrativeNode isn't running. Launch it
    and retry the call." The host shows this in the chat surface.
  - Other upstream errors (validation, tool not found, etc.) → the
    upstream's own error response is forwarded verbatim so the host
    sees what the live server would have said.
  - Catalogue file missing / corrupt → wrapper logs to stderr and
    serves an empty tools list. Host marks the server healthy with
    no tools. The next NN launch with MCP on will regenerate the
    catalogue and a host restart picks it up.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional

# Resolve the catalogue path relative to this script so the wrapper
# works regardless of where the host launches it from.
_SCRIPT_DIR = Path(__file__).resolve().parent
_CATALOGUE_PATH = _SCRIPT_DIR / "mcp_catalogue.json"

# Default upstream URL. The static MCP convenience port (13316) is
# chosen for stability — NarrativeNode's main backend port shifts
# across launches but this static port is what external MCP clients
# hardcode. Overridable via `NN_MCP_URL` env var for non-default deployments.
import os
_UPSTREAM_URL = os.environ.get(
    "NN_MCP_URL",
    "http://127.0.0.1:13316/mcp/server/",
)

# Per-call HTTP timeout. The upstream usually responds in <100 ms.
# 30 s is generous enough to cover slow first-touch handshakes without
# the host giving up on the user.
import datetime as _dt
_UPSTREAM_TIMEOUT = _dt.timedelta(seconds=30)


def _log(msg: str) -> None:
    """Diagnostic line to stderr — host apps capture this and surface
    it in their MCP server log views. Never log to stdout: stdout is
    reserved for JSON-RPC frames."""
    print(f"[nn-mcp-stdio] {msg}", file=sys.stderr, flush=True)


def _load_catalogue() -> dict:
    """Read the catalogue JSON. Returns an empty-tools shape on any
    failure so the wrapper still boots and the host marks the server
    healthy."""
    if not _CATALOGUE_PATH.exists():
        _log(
            f"catalogue not found at {_CATALOGUE_PATH}; serving empty tools list. "
            f"Run NarrativeNode with MCP enabled at least once to generate it."
        )
        return {"tools": []}
    try:
        return json.loads(_CATALOGUE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _log(f"catalogue read failed: {exc!r}; serving empty tools list")
        return {"tools": []}


def _relax_schema(schema: Any) -> Any:
    """Return a deep copy of `schema` with every string-typed `enum`
    constraint stripped (and moved into `examples` for discoverability).

    Why: the MCP SDK's `lowlevel.Server.handle_call_tool` runs
    `jsonschema.validate(instance=arguments, schema=tool.inputSchema)`
    on incoming args BEFORE invoking our `@server.call_tool` handler.
    With the strict enums still in place, mixed-case args like
    `type="Character"` would fail validation at the wrapper boundary
    before our normalisation pass could run.

    Stripping enums on the schema we serve to the host (while keeping
    the original strict schemas in `tool_schemas` for normalisation)
    lets any case pass the wrapper-side validation, the normalisation
    pass canonicalise to lowercase, and the upstream's strict gate
    re-validate the canonical form cleanly. Net result: case-insensitive
    end-to-end without losing strict validation downstream.
    """
    if not isinstance(schema, dict):
        return schema
    out = dict(schema)
    if out.get("type") == "string" and isinstance(out.get("enum"), list):
        out["examples"] = out.pop("enum")
    if isinstance(out.get("properties"), dict):
        out["properties"] = {k: _relax_schema(v) for k, v in out["properties"].items()}
    if "items" in out:
        out["items"] = _relax_schema(out["items"])
    for key in ("anyOf", "oneOf", "allOf"):
        if isinstance(out.get(key), list):
            out[key] = [_relax_schema(v) for v in out[key]]
    return out


def _normalize_args_for_schema(value: Any, schema: Optional[dict]) -> Any:
    """Walk a JSON schema and lowercase any string value bound to an enum
    constraint, so the MCP SDK's `jsonschema.validate` pre-check passes
    even when the caller used mixed-case input (e.g. `type="Character"`
    instead of `"character"`).

    Why it lives here, not in the upstream FastMCP server: the MCP SDK's
    `lowlevel.Server` validates incoming args against `tool.inputSchema`
    BEFORE Pydantic deserialisation runs, so a Pydantic-side
    `BeforeValidator` never gets a chance to fire on a mis-cased enum.
    Doing the normalisation here, in the wrapper, side-steps that order
    entirely — the upstream FastMCP receives args that already pass the
    JSON schema enum gate.

    Recurses into object properties and array items. Trims surrounding
    whitespace as well as case-normalising. Only lowercases when the
    lowered value actually appears in the schema's enum list — leaves
    unrelated strings untouched. Handles `anyOf` by trying each non-null
    variant in order (the common Pydantic shape for `Optional[Literal]`
    is `{"anyOf": [{"enum": [...]}, {"type": "null"}]}`).
    """
    if schema is None or not isinstance(schema, dict):
        return value

    # anyOf / oneOf — try each variant in order; first one that yields a
    # mutation wins, else fall through.
    for key in ("anyOf", "oneOf"):
        variants = schema.get(key)
        if isinstance(variants, list):
            for variant in variants:
                if isinstance(variant, dict) and variant.get("type") != "null":
                    coerced = _normalize_args_for_schema(value, variant)
                    if coerced != value:
                        return coerced
            return value

    # String + enum: the actual normalisation site.
    if schema.get("type") == "string" and isinstance(schema.get("enum"), list):
        if isinstance(value, str):
            stripped_lower = value.strip().lower()
            if stripped_lower in schema["enum"]:
                return stripped_lower
        return value

    # Object: recurse into known properties.
    if schema.get("type") == "object" and isinstance(value, dict):
        properties = schema.get("properties") or {}
        if not properties:
            return value
        out = {}
        for k, v in value.items():
            sub = properties.get(k)
            out[k] = _normalize_args_for_schema(v, sub) if sub is not None else v
        return out

    # Array: recurse into items.
    if schema.get("type") == "array" and isinstance(value, list):
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            return [_normalize_args_for_schema(item, item_schema) for item in value]
        return value

    return value


async def _forward_to_upstream(
    name: str,
    arguments: Optional[dict[str, Any]],
) -> Any:
    """Open a fresh streamable-http MCP client session to the upstream,
    invoke `tools/call`, return the result. Raises on connection failure
    so the caller can translate to a friendly envelope.

    A fresh session per call is intentional — the MCP host's `tools/call`
    frequency is human-cadence (a few per AI writing turn at most), the
    setup cost is ~50-100 ms, and the alternative (persistent connection
    with reconnection logic) adds significant complexity for marginal
    perf gain.
    """
    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(
        _UPSTREAM_URL,
        timeout=_UPSTREAM_TIMEOUT,
    ) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            return await session.call_tool(name, arguments or {})


def _build_friendly_unreachable_envelope(name: str, exc: Exception) -> list:
    """Build the JSON-RPC result body returned when the upstream is
    unreachable. Single TextContent with a plain-English message so the
    host's chat UI shows it inline. Returned as a regular tool result
    (not an MCP error) so the host doesn't treat the server as broken."""
    from mcp import types
    msg = (
        f"NarrativeNode isn't running, so the `{name}` tool can't be "
        f"called right now. Launch NarrativeNode (and turn on the MCP "
        f"control if it isn't on already) then retry.\n\n"
        f"Underlying error: {exc.__class__.__name__}: {exc}"
    )
    return [types.TextContent(type="text", text=msg)]


async def _main() -> None:
    from mcp import types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    catalogue = _load_catalogue()
    raw_tools = catalogue.get("tools", [])
    _log(
        f"loaded catalogue: {len(raw_tools)} tools "
        f"(fingerprint {catalogue.get('_source_fingerprint', '<missing>')[:12]}...)"
    )

    # Pre-build Tool objects so the list_tools handler is a constant-time
    # return. The catalogue file shape matches the MCP Tool model
    # directly — name, description, inputSchema.
    # Serve relaxed schemas to the host (enums stripped to examples) so
    # mixed-case enum input doesn't fail the SDK's own pre-validation.
    # Keep the original strict schemas in `tool_schemas` for the
    # normaliser to use. See `_relax_schema` docstring for the full
    # rationale.
    tool_objects = [
        types.Tool(
            name=t["name"],
            description=t.get("description", "") or "",
            inputSchema=_relax_schema(t.get("inputSchema", {"type": "object"})),
        )
        for t in raw_tools
    ]
    tool_schemas = {
        t["name"]: t.get("inputSchema", {"type": "object"}) for t in raw_tools
    }

    server = Server("narrativenode-stdio-wrapper")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return tool_objects

    @server.call_tool()
    async def call_tool(
        name: str, arguments: Optional[dict[str, Any]],
    ) -> list[types.ContentBlock]:
        # Schema-aware case-normalise of enum string args so the upstream
        # `jsonschema.validate` enum gate accepts mixed-case input (e.g.
        # `type="Character"` -> `"character"`). See the helper's docstring
        # for why this lives in the wrapper rather than the upstream.
        schema = tool_schemas.get(name)
        if schema is not None and arguments is not None:
            arguments = _normalize_args_for_schema(arguments, schema)
        try:
            result = await _forward_to_upstream(name, arguments)
        except (ConnectionError, OSError, asyncio.TimeoutError) as exc:
            _log(f"upstream unreachable for tool {name!r}: {exc!r}")
            return _build_friendly_unreachable_envelope(name, exc)
        except Exception as exc:  # noqa: BLE001 — forward unknown failures
            _log(f"upstream call failed for tool {name!r}: {exc!r}")
            # Translate ANY other failure into a friendly envelope rather
            # than letting it propagate as an MCP error. Hosts vary in
            # how they render MCP errors vs tool results; tool results
            # display reliably in chat surfaces.
            return _build_friendly_unreachable_envelope(name, exc)

        # The upstream returned a CallToolResult; forward its content.
        # Empty content list is valid (some void-result tools return
        # nothing meaningful).
        if hasattr(result, "content"):
            return list(result.content)
        return []

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options(),
        )


def main() -> int:
    try:
        asyncio.run(_main())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:  # noqa: BLE001
        _log(f"fatal: {exc.__class__.__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
