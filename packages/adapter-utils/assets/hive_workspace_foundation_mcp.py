# AX: MCP | SUM: bounded read-only workspace context tools for host-side T3 sessions | SIG: workspace_foundation_mcp_v3
#!/usr/bin/env python3
"""Small, read-only workspace MCP for interactive Hive 2.0 sessions.

This is deliberately a runtime foundation, not a provider connection.  It is
started beside Codex, is bounded to the configured workspace roots, and never
writes files or calls a provider.  Business capabilities remain behind the
Paperclip Tool Gateway. Host-side T3 configures an explicit set of founder-owned
roots because its Codex app-server MCP process is shared across T3 threads.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


SERVER_NAME = "Hive Workspace Foundation"
SERVER_VERSION = "2.0.0"
MAX_READ_BYTES = int(os.environ.get("HIVE_FOUNDATION_MAX_READ_BYTES", "524288"))
MAX_SCAN_FILES = int(os.environ.get("HIVE_FOUNDATION_MAX_SCAN_FILES", "3000"))
SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "__pycache__",
        ".venv",
        "node_modules",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        "dist",
        "build",
        "results",
    }
)

SECRET_FILE_RE = re.compile(
    r"(^\.?env($|\.))|(^\.?mcp_config\.json$)|(^\.?npmrc$)|(^\.?netrc$)|(^\.?pgpass$)"
    r"|(\.(pem|key|p12|pfx)$)|(id_(rsa|ed25519|ecdsa|dsa)$)"
    r"|(credentials?($|\.)|secrets?($|\.))",
    re.IGNORECASE,
)
SECRET_KEY_RE = re.compile(
    r"TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API[_-]?KEY|APIKEY"
    r"|REFRESH_TOKEN|CLIENT_SECRET|CREDENTIAL|AUTHORIZATION|AUTH[_-]?HEADER|BEARER",
    re.IGNORECASE,
)
SECRET_CONTAINER_KEYS = frozenset(
    {
        "auth",
        "authentication",
        "authinfo",
        "apikey",
        "apikeys",
        "credential",
        "credentials",
        "secret",
        "secrets",
        "token",
        "tokens",
        "accesstoken",
        "accesstokens",
        "refreshtoken",
        "refreshtokens",
        "privatekey",
        "privatekeys",
    }
)
SECRET_VALUE_RE = re.compile(r"^[A-Za-z0-9_\-+/.=:~]{12,}$")
LONG_B64_RE = re.compile(r"[A-Za-z0-9+/]{20,}={0,2}")
KV_RE = re.compile(
    r'^(?P<lead>\s*["\']?)(?P<key>[A-Za-z_][\w.\-]*)'
    r'(?P<sep>["\']?\s*[:=]\s*)(?P<val>.+?)\s*$'
)
JSON_KV_RE = re.compile(
    r'(?P<lead>["\']?)(?P<key>[A-Za-z_][\w.\-]{0,127})'
    r'(?P<sep>["\']?\s*:\s*)(?P<quote>["\']?)'
    r'(?P<val>[A-Za-z0-9_\-+/.=:~]{12,})(?P<endquote>["\']?)'
)
INLINE_TOML_KV_RE = re.compile(
    r'(?P<prefix>(?<![A-Za-z0-9_.-])(?P<key>[A-Za-z_][\w.\-]*)\s*=\s*)'
    r'(?P<quote>["\'])(?P<val>(?:\\.|(?!["\']).)*)(?P=quote)'
)


TOOLS: list[dict[str, Any]] = [
    {
        "name": "workspace.context.read",
        "title": "Read workspace context",
        "description": (
            "Read the configured bounded workspace context. Use once at session start to learn the "
            "workspace roots, instruction files and the foundation workflow. Read-only."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "workspace.smart_read",
        "title": "Read workspace file safely",
        "description": (
            "Primary read-only workspace file reader. It redacts secrets, bounds large output, and "
            "supports focus, line ranges and raw output. Use this before native shell reads."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path inside the workspace."},
                "focus": {"type": "string", "description": "Optional function or class name."},
                "lines": {"type": "string", "description": "Optional one-based range such as 20-45."},
                "raw": {"type": "boolean", "description": "Return full bounded content instead of an outline."},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace.smart_grep",
        "title": "Search workspace safely",
        "description": (
            "Read-only regex search over bounded workspace files. It skips generated/vendor trees, "
            "redacts secrets, and returns concentrated matches or a file-count summary."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression to search."},
                "path": {"type": "string", "description": "Relative directory or file; defaults to workspace root."},
                "include": {"type": "string", "description": "Optional filename glob, for example *.py."},
                "raw": {"type": "boolean", "description": "Return all bounded matches instead of a summary."},
            },
            "required": ["pattern"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace.smart_glob",
        "title": "Find workspace files",
        "description": "Read-only bounded file discovery. Use to discover catalog or source files before reading them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Optional relative or absolute directory inside an allowed root; defaults to the primary root."},
                "pattern": {"type": "string", "description": "Relative glob such as catalog/**/*.md."},
                "raw": {"type": "boolean", "description": "Return every path instead of a concentrated summary."},
            },
            "required": ["pattern"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace.repo_map",
        "title": "Map workspace",
        "description": (
            "Create a concentrated read-only workspace map from AX headers, catalog Markdown headings "
            "and bounded file paths. Use once for orientation, then drill down with smart_read or smart_grep."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Optional relative or absolute directory inside an allowed root; defaults to the primary root."},
                "include": {"type": "string", "description": "Comma-separated relative prefixes; defaults to the selected workspace root."},
                "depth": {"type": "integer", "minimum": 1, "maximum": 8, "description": "Maximum path depth; default 3."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace.ax_impact",
        "title": "Find workspace impact",
        "description": (
            "Read-only concentrated impact search. It finds AX headers, definitions and references for "
            "a symbol or concept without returning whole files. Use before broad grep for where/how-used questions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Symbol, partial name or concept."},
                "path": {"type": "string", "description": "Optional relative or absolute directory inside an allowed root; defaults to the primary root."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Maximum result records; default 20."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]


class Workspace:
    def __init__(self) -> None:
        configured = (
            os.environ.get("HIVE_WORKSPACE_ROOT", "").strip()
            or os.environ.get("PAPERCLIP_WORKSPACE_CWD", "").strip()
        )
        if not configured:
            raise ValueError("HIVE_WORKSPACE_ROOT or PAPERCLIP_WORKSPACE_CWD is required")
        root = Path(configured).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("HIVE_WORKSPACE_ROOT is not a directory")
        self.root = root
        self.roots = [root]
        for raw in os.environ.get("HIVE_WORKSPACE_EXTRA_ROOTS", "").split(os.pathsep):
            if not raw.strip():
                continue
            extra = Path(raw).expanduser().resolve()
            if extra.is_dir() and extra not in self.roots:
                self.roots.append(extra)

    def _within(self, path: Path, root: Path) -> bool:
        return path == root or root in path.parents

    def resolve(self, raw: str) -> Path:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError("path is required")
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve(strict=False)
        if not any(self._within(resolved, root) for root in self.roots):
            raise ValueError("path is outside the bounded workspace")
        return resolved

    def display(self, path: Path) -> str:
        for root in self.roots:
            try:
                return str(path.relative_to(root)) or "."
            except ValueError:
                pass
        return str(path)

    def secret_file(self, path: Path) -> bool:
        return bool(SECRET_FILE_RE.search(path.name))

    def redact_json(self, text: str, redact_all: bool) -> str | None:
        try:
            json.loads(text)
        except (TypeError, ValueError, RecursionError):
            if redact_all:
                return "\n".join(
                    "<redacted:unparseable-secret-json>" if line else ""
                    for line in text.split("\n")
                )
            return None

        decoder = json.JSONDecoder()
        spans: list[tuple[int, int, Any]] = []

        def skip_space(index: int) -> int:
            while index < len(text) and text[index] in " \t\r\n":
                index += 1
            return index

        def is_secret_container(key: str) -> bool:
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            return normalized in SECRET_CONTAINER_KEYS

        def parse_value(index: int, force: bool) -> int:
            index = skip_space(index)
            marker = text[index]
            if marker == "{":
                index = skip_space(index + 1)
                if text[index] == "}":
                    return index + 1
                while True:
                    key, key_end = decoder.raw_decode(text, index)
                    if not isinstance(key, str):
                        raise ValueError("JSON object key is not a string")
                    index = skip_space(key_end)
                    if text[index] != ":":
                        raise ValueError("JSON object key has no value")
                    value_start = skip_space(index + 1)
                    value_is_container = text[value_start] in "[{"
                    secret_key = bool(SECRET_KEY_RE.search(key))
                    child_force = force or redact_all or (
                        secret_key and (not value_is_container or is_secret_container(key))
                    )
                    index = skip_space(parse_value(value_start, child_force))
                    if text[index] == "}":
                        return index + 1
                    if text[index] != ",":
                        raise ValueError("JSON object members are not comma-separated")
                    index = skip_space(index + 1)
            if marker == "[":
                index = skip_space(index + 1)
                if text[index] == "]":
                    return index + 1
                while True:
                    index = skip_space(parse_value(index, force or redact_all))
                    if text[index] == "]":
                        return index + 1
                    if text[index] != ",":
                        raise ValueError("JSON array values are not comma-separated")
                    index = skip_space(index + 1)
            value, end = decoder.raw_decode(text, index)
            if force and value is not None:
                spans.append((index, end, value))
            return end

        try:
            parse_value(0, redact_all)
        except (IndexError, TypeError, ValueError, RecursionError):
            return "\n".join(
                "<redacted:unparseable-secret-json>" if line else ""
                for line in text.split("\n")
            ) if redact_all else None
        if not spans:
            return text
        redacted = text
        for start, end, secret in reversed(spans):
            replacement = (
                json.dumps(f"<redacted:{len(secret.encode('utf-8'))}b>", ensure_ascii=False)
                if isinstance(secret, str)
                else "null"
            )
            redacted = redacted[:start] + replacement + redacted[end:]
        return redacted

    def redact_line(self, line: str, secret_file: bool) -> str:
        def redact_json_match(match: re.Match[str]) -> str:
            value = match.group("val")
            if not SECRET_KEY_RE.search(match.group("key")) or not SECRET_VALUE_RE.fullmatch(value):
                return match.group(0)
            return (
                f'{match.group("lead")}{match.group("key")}{match.group("sep")}'
                f'{match.group("quote")}<redacted:{len(value.encode("utf-8"))}b>{match.group("endquote")}'
            )

        if ":" in line and SECRET_KEY_RE.search(line):
            line = JSON_KV_RE.sub(redact_json_match, line)

        def redact_inline_toml(match: re.Match[str]) -> str:
            key = match.group("key")
            if not SECRET_KEY_RE.search(key):
                return match.group(0)
            value = match.group("val")
            return (
                f'{match.group("prefix")}{match.group("quote")}<redacted:'
                f'{len(value.encode("utf-8"))}b>{match.group("quote")}'
            )

        line = INLINE_TOML_KV_RE.sub(redact_inline_toml, line)
        match = KV_RE.match(line)
        if not match:
            stripped = line.strip()
            if secret_file and stripped and not stripped.startswith("#") and (
                SECRET_VALUE_RE.fullmatch(stripped) or LONG_B64_RE.search(stripped) or "PRIVATE KEY" in stripped.upper()
            ):
                return "<redacted:secret-line>"
            return line
        value = match.group("val").strip().rstrip(",").strip().strip('"').strip("'")
        if value and not value.startswith(("${", "$(")) and (secret_file or SECRET_KEY_RE.search(match.group("key")) and SECRET_VALUE_RE.fullmatch(value)):
            return f"{match.group('lead')}{match.group('key')}{match.group('sep')}<redacted:{len(value.encode('utf-8'))}b>"
        return line

    def redact(self, text: str, path: Path) -> str:
        secret_file = self.secret_file(path)
        if path.suffix.lower() == ".json":
            redacted_json = self.redact_json(
                text,
                redact_all=secret_file or path.name.lower() == "mcp_config.json",
            )
            if redacted_json is not None:
                return redacted_json
        lines = [self.redact_line(line, secret_file) for line in text.split("\n")]
        output = "\n".join(lines)
        return output

    def read_text(self, path: Path) -> str:
        if not path.exists():
            raise ValueError(f"not found: {self.display(path)}")
        if not path.is_file():
            raise ValueError(f"not a file: {self.display(path)}")
        if path.stat().st_size > MAX_READ_BYTES:
            if not self.secret_file(path):
                raise ValueError(f"file exceeds bounded read size ({MAX_READ_BYTES} bytes)")
            # A truncated secret file intentionally becomes an opaque
            # redacted marker below instead of an unbounded read.
            text = path.read_bytes()[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        else:
            text = path.read_text(encoding="utf-8", errors="replace")
        if "\x00" in text[:512]:
            raise ValueError(f"binary file: {self.display(path)}")
        return self.redact(text, path)

    def iter_files(self, start: Path) -> Any:
        if start.is_file():
            yield start
            return
        for directory, dirnames, filenames in os.walk(start, topdown=True, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
            for filename in sorted(filenames):
                if filename.startswith("."):
                    continue
                path = Path(directory) / filename
                try:
                    resolved = path.resolve(strict=True)
                except OSError:
                    continue
                if any(self._within(resolved, root) for root in self.roots):
                    yield resolved

    def read(self, args: dict[str, Any]) -> dict[str, Any]:
        path = self.resolve(args["path"])
        text = self.read_text(path)
        if args.get("focus"):
            text = self.focus(text, str(args["focus"]))
        elif args.get("lines"):
            text = self.lines(text, str(args["lines"]))
        elif not args.get("raw") and len(text) > 2000:
            text = self.outline(path, text)
        return {"path": self.display(path), "content": text}

    def outline(self, path: Path, text: str) -> str:
        lines = text.splitlines()
        entries = []
        for number, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith("class ") or stripped.startswith("def ") or stripped.startswith("function "):
                entries.append(f"  {number}: {stripped.split('(')[0].rstrip(':')}")
        preview = "\n".join(f"  {number}: {line}" for number, line in enumerate(lines[:10], 1))
        parts = [f"{path.name} ({len(lines)} lines)"]
        if entries:
            parts.append("Structure:\n" + "\n".join(entries[:100]))
        parts.append("Preview:\n" + preview)
        parts.append("[use focus, lines or raw=true for a closer read]")
        return "\n".join(parts)

    def focus(self, text: str, name: str) -> str:
        lines = text.splitlines()
        for index, line in enumerate(lines):
            if re.match(rf"\s*(?:async\s+)?(?:def|class)\s+{re.escape(name)}\b", line):
                base = len(line) - len(line.lstrip())
                end = index + 1
                while end < len(lines):
                    current = lines[end]
                    if current.strip() and len(current) - len(current.lstrip()) <= base and re.match(r"\s*(?:async\s+)?(?:def|class)\s+", current):
                        break
                    end += 1
                return f"[{name}: L{index + 1}-L{end}]\n" + "\n".join(f"  {n}: {lines[n - 1]}" for n in range(index + 1, end + 1))
        return f"error: '{name}' not found"

    def lines(self, text: str, value: str) -> str:
        try:
            bits = value.split("-", 1)
            start = int(bits[0])
            end = int(bits[1]) if len(bits) == 2 else start
            if start < 1 or end < start:
                raise ValueError
        except ValueError as exc:
            raise ValueError(f"invalid range: {value}") from exc
        rows = text.splitlines()
        if start > len(rows):
            raise ValueError(f"range starts after EOF ({len(rows)} lines)")
        end = min(end, len(rows))
        return f"[Lines {start}-{end} of {len(rows)}]\n" + "\n".join(f"  {n}: {rows[n - 1]}" for n in range(start, end + 1))

    def grep(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            regex = re.compile(str(args["pattern"]))
        except re.error as exc:
            raise ValueError(f"invalid regex: {exc}") from exc
        start = self.resolve(args.get("path", "."))
        matches: dict[str, list[tuple[int, str]]] = {}
        scanned = 0
        visited = 0
        total = 0
        include = str(args.get("include", "")).lstrip("*") or None
        truncated = False
        for path in self.iter_files(start):
            if visited >= MAX_SCAN_FILES:
                truncated = True
                break
            visited += 1
            if include and not fnmatch.fnmatch(path.name, str(args["include"])):
                continue
            scanned += 1
            if path.stat().st_size > MAX_READ_BYTES:
                continue
            try:
                content = self.redact(path.read_text(encoding="utf-8", errors="replace"), path)
            except OSError:
                continue
            if "\x00" in content[:512]:
                continue
            found = [(line_number, line) for line_number, line in enumerate(content.splitlines(), 1) if regex.search(line)]
            if found:
                matches[self.display(path)] = found
                total += len(found)
        if not matches:
            summary = "scan truncated; no matches in scanned prefix" if truncated else "no matches"
            return {"matches": [], "summary": summary, "visited_files": visited, "scanned_files": scanned, "truncated": truncated}
        if args.get("raw") or total <= 50:
            rows = [{"path": path, "line": line_number, "text": line} for path, found in matches.items() for line_number, line in found]
            return {"matches": rows, "total": total, "files": len(matches), "visited_files": visited, "scanned_files": scanned, "truncated": truncated}
        return {"matches": [], "total": total, "files": len(matches), "summary": {path: len(found) for path, found in matches.items()}, "visited_files": visited, "scanned_files": scanned, "truncated": truncated}

    def glob(self, args: dict[str, Any]) -> dict[str, Any]:
        pattern = str(args["pattern"])
        base = self.resolve(args.get("path", "."))
        if pattern.startswith("/"):
            raise ValueError("absolute glob patterns are not supported; use path to select an allowed root")
        found = []
        for path in base.glob(pattern):
            try:
                resolved = path.resolve(strict=True)
            except OSError:
                continue
            if resolved.name.startswith(".") or not any(self._within(resolved, root) for root in self.roots):
                continue
            if resolved.is_file():
                found.append(self.display(resolved))
        found = sorted(set(found))
        if args.get("raw") or len(found) <= 30:
            return {"files": found, "total": len(found)}
        by_dir: dict[str, int] = {}
        for item in found:
            directory = str(Path(item).parent)
            by_dir[directory] = by_dir.get(directory, 0) + 1
        return {"files": [], "total": len(found), "summary": by_dir}

    def repo_map(self, args: dict[str, Any]) -> dict[str, Any]:
        include = [item.strip().strip("/") for item in str(args.get("include", "")).split(",") if item.strip()]
        depth = int(args.get("depth", 3))
        records = []
        scanned = 0
        truncated = False
        selected_root = self.resolve(args.get("path", "."))
        for path in self.iter_files(selected_root):
            display = self.display(path)
            if include and not any(display == item or display.startswith(item + "/") for item in include):
                continue
            if len(Path(display).parts) > depth + 1:
                continue
            if scanned >= MAX_SCAN_FILES:
                truncated = True
                break
            scanned += 1
            ax = ""
            heading = ""
            try:
                first = path.read_text(encoding="utf-8", errors="replace")[:4096].splitlines()
                if first and first[0].startswith("# AX:"):
                    ax = first[0][5:].strip()
                if path.suffix.lower() in {".md", ".markdown"}:
                    heading = next((line.lstrip("# ").strip() for line in first if line.startswith("#")), "")
            except OSError:
                continue
            if ax or heading or path.suffix.lower() in {".md", ".py", ".ts", ".tsx", ".yaml", ".yml", ".toml"}:
                records.append({"path": display, **({"ax": ax} if ax else {}), **({"heading": heading} if heading else {})})
        return {"root": str(selected_root), "include": include or ["."], "depth": depth, "entries": records, "truncated": truncated}

    def impact(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args["query"]).strip()
        if not query:
            raise ValueError("query is required")
        needle = query.casefold()
        limit = int(args.get("limit", 20))
        results = []
        scanned = 0
        truncated = False
        selected_root = self.resolve(args.get("path", "."))
        for path in self.iter_files(selected_root):
            if path.stat().st_size > MAX_READ_BYTES:
                continue
            if scanned >= MAX_SCAN_FILES:
                truncated = True
                break
            scanned += 1
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            if any("\x00" in line for line in lines[:2]):
                continue
            ax = lines[0][5:].strip() if lines and lines[0].startswith("# AX:") else None
            line_numbers = [index for index, line in enumerate(lines, 1) if needle in line.casefold()]
            if line_numbers or (ax and needle in ax.casefold()):
                results.append({"path": self.display(path), "ax": ax, "lines": line_numbers[:50]})
                if len(results) >= limit:
                    truncated = True
                    break
        return {"query": query, "root": str(selected_root), "results": results, "scanned_files": scanned, "truncated": truncated}

    def context(self) -> dict[str, Any]:
        instruction_files = []
        for root in self.roots:
            for name in ("AGENTS.md", "CLAUDE.md", "README.md"):
                path = root / name
                if path.is_file():
                    instruction_files.append(str(path))
        catalogs = []
        for root in self.roots:
            candidate = root / "catalog"
            if candidate.is_dir():
                # Absolute, so a multi-root founder session can tell the Hive 1.0
                # historical catalogs apart instead of seeing "catalog" twice.
                catalogs.append(str(candidate))
        return {
            "workspace_root": str(self.root),
            "allowed_roots": [str(root) for root in self.roots],
            "instruction_files": instruction_files,
            "catalog_roots": catalogs,
            "foundation_tools": [tool["name"] for tool in TOOLS],
            "workflow": [
                "read this context once",
                "use workspace.repo_map for orientation; pass path for a non-primary allowed root",
                "use workspace.smart_read/smart_grep/smart_glob for bounded local I/O",
                "use workspace.ax_impact before broad searches for where/how-used questions",
                "use Paperclip search_tools/run_tool for business capabilities",
                "durable company memory is OpenViking (knowledge.company_* tools), not these "
                "catalog_roots; the Hive 1.0 catalogs are a read-only historical fallback",
            ],
        }


def call(workspace: Workspace, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "workspace.context.read":
        return workspace.context()
    if name == "workspace.smart_read":
        return workspace.read(arguments)
    if name == "workspace.smart_grep":
        return workspace.grep(arguments)
    if name == "workspace.smart_glob":
        return workspace.glob(arguments)
    if name == "workspace.repo_map":
        return workspace.repo_map(arguments)
    if name == "workspace.ax_impact":
        return workspace.impact(arguments)
    raise ValueError(f"unknown tool: {name}")


def reply(request_id: Any, result: Any = None, error: str | None = None) -> None:
    response: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        response["error"] = {"code": -32000, "message": error}
    else:
        response["result"] = result
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        workspace = Workspace()
    except ValueError as exc:
        print(f"workspace foundation unavailable: {exc}", file=sys.stderr)
        return 2
    for raw in sys.stdin.buffer:
        if not raw.strip():
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict):
            continue
        request_id = request.get("id")
        method = request.get("method")
        if method in {"notifications/initialized", "notifications/cancelled"}:
            continue
        if method == "initialize":
            reply(
                request_id,
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    "instructions": "Use workspace.context.read once, then bounded workspace tools. All tools are read-only.",
                },
            )
            continue
        if method == "ping":
            reply(request_id, {})
            continue
        if method == "tools/list":
            reply(request_id, {"tools": TOOLS})
            continue
        if method == "tools/call":
            params = request.get("params") or {}
            name = params.get("name") if isinstance(params, dict) else None
            arguments = params.get("arguments", {}) if isinstance(params, dict) else {}
            if not isinstance(name, str) or not isinstance(arguments, dict):
                reply(request_id, error="tools/call requires a tool name and object arguments")
                continue
            try:
                result = call(workspace, name, arguments)
                reply(
                    request_id,
                    {
                        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                        "structuredContent": result,
                        "isError": False,
                    },
                )
            except (OSError, ValueError, UnicodeError) as exc:
                reply(
                    request_id,
                    {
                        "content": [{"type": "text", "text": str(exc)}],
                        "isError": True,
                    },
                )
            continue
        if request_id is not None:
            reply(request_id, error=f"method not found: {method}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
