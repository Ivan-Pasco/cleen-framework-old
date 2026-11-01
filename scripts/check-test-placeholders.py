#!/usr/bin/env python3
"""
check-test-placeholders.py

Walks every .cln under tests/ and plugins/*/tests/ and blocks placeholder
patterns from landing. Rule list is self-contained below.

Usage:
    check-test-placeholders.py                     # walk full tree
    check-test-placeholders.py file1.cln file2.cln # check only listed files (used by git hooks)
    check-test-placeholders.py --list-files        # print files that would be checked

Exit codes:
    0 — no offenses
    1 — one or more offenses (details on stdout)
    2 — invocation error (bad flags, missing tree)

The script is intentionally strict. Exempt paths are declared in
EXEMPT_RELATIVE_PATHS / EXEMPT_SUFFIXES below. Every exemption should be
justified in a code comment next to the entry.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

TEST_ROOTS = [
    REPO_ROOT / "tests" / "framework",
    REPO_ROOT / "tests" / "canvas",
    REPO_ROOT / "tests" / "comprehensive-test",
]
PLUGIN_TESTS_GLOB = REPO_ROOT / "plugins"

EXEMPT_RELATIVE_PATHS = {
    "tests/framework/utils/assertions.cln",
    "tests/framework/utils/http_helpers.cln",
    "tests/framework/utils/bridge_mocks.cln",
}

EXEMPT_SUFFIXES = (
    "/tests/test_expand.cln",
)

PENDING_FILE = REPO_ROOT / "tests" / "PENDING.md"

DOT_NAMESPACES = (
    "auth.", "db.", "http.", "ui.", "canvas.", "api.", "live.", "feed.",
    "queue.", "email.", "crypto.", "env.", "time.", "log.", "mcp.",
    "session.", "jwt.", "storage.", "audio.", "input.", "collision.",
    "camera.", "scene.", "page.", "res.", "req.", "json.", "job.",
    "schedule.", "locale.", "i18n.", "tween.", "particles.", "animState.",
    "form.", "server.", "file.",
)

# Standalone helper / builtin calls that count as "real" work.
TRANSLATION_FUNCS = ("t(", "tc(", "now(", "render(", "renderWith(",
                     "assertEqual", "assertTrue", "assertFalse",
                     "assertContains", "assertNotContains", "assertStartsWith",
                     "assertEndsWith", "assertEmpty", "assertNotEmpty",
                     "assertGreaterThan", "assertLessThan", "assertOccurrences",
                     "logPass", "logFail", "logSection")

# Tiny runtime smoke tests (arithmetic + printl) are legitimate — the runtime
# folder exists to verify the toolchain works with NO plugins involved. Files
# under tests/framework/runtime/ are exempt from the "no-real-call" rule.
RUNTIME_ONLY_PREFIX = "tests/framework/runtime/"

# A file that declares `html:` blocks inside a `functions:` block is exercising
# frame.ui's page-render pipeline: the plugin produces an HTML string as the
# function return. Asserting `.contains(...)` on that returned string against
# expected markup IS the real test — the html: block is the real API surface.
# Detect this shape and let it pass the "no-real-call" and "string-match-only"
# rules.
HTML_BLOCK_RE = re.compile(r'^\s*html:\s*$', re.MULTILINE)

# Framework DSL blocks that exercise real plugin surfaces. Presence of any of
# these anywhere in the source proves the file is invoking a plugin's real
# expansion path — not a string-matching pretense.
DSL_BLOCK_RE = re.compile(
    r'^\s*(?:server|auth|roles|data\s+\w+|endpoints|middleware|routes|'
    r'canvasScene|component|page|locale|mail|jobs|schedule|mcp\s+"[^"]+"|'
    r'transaction|load|form|send|state|events|styles\s+\w+)\s*:',
    re.MULTILINE,
)

# HTTP method verbs used at the start of a route declaration. Their presence
# in an `endpoints:` block proves the file is registering real handlers.
HTTP_VERB_RE = re.compile(
    r'^\s*(?:GET|POST|PUT|PATCH|DELETE|FEED|LIVE|STREAM)\s+"',
    re.MULTILINE,
)

# Model-method DSL calls: `Post.find:`, `User.insert:`, etc. These are the
# frame.data API surface and are dot-notation, but not one of the fixed
# namespaces in DOT_NAMESPACES.
MODEL_METHOD_RE = re.compile(
    r'\b[A-Z]\w*\.(?:find|first|count|exists|select|insert|insert_id|update|'
    r'upsert|delete|paginate|cursor|save|validate|migrate)\s*:?',
)

SUSPECT_TAGS_RE = re.compile(
    # Whole-word, case-sensitive on the marker forms only (TODO, FIXME, XXX,
    # xfail, pending, placeholder, stub) so that ordinary domain nouns like
    # "Todo model" or "user pending review" don't false-positive.
    r"\b(?:TODO|FIXME|XXX|xfail|placeholder|stub|not_implemented)\b",
)

DEPRECATED_MOCK_RE = re.compile(r"bridge_mocks\.cln")

STRING_MATCH_ONLY_RE = re.compile(
    r"\.(contains|indexOf|startsWith|endsWith)\s*\(",
)

# Match a single double-quoted string that looks like a code fragment:
# contains an identifier immediately followed by "(" (a call) and later a ")".
# Non-greedy on the middle so we don't span across adjacent strings.
CODE_LOOKING_LITERAL_RE = re.compile(
    r'"(?:\\.|[^"\\])*?[A-Za-z_][A-Za-z0-9_]+\s*\([^"()]*\)(?:\\.|[^"\\])*?"'
)

PASS_LINE_RE = re.compile(r'printl\s*\(\s*"PASS:\s*[^"]+"\s*\)')
FAIL_LINE_RE = re.compile(r'printl\s*\(\s*"FAIL:\s*[^"]+"\s*\)')


@dataclass
class Offense:
    path: Path
    kind: str
    detail: str

    def render(self) -> str:
        return f"{self.path.relative_to(REPO_ROOT)}: [{self.kind}] {self.detail}"


def load_pending_allowlist() -> set[str]:
    """Load allowlisted file paths from tests/PENDING.md.

    Format: bullet lines like `- tests/framework/unit/plugins/auth/foo.cln — <ERROR_CODE>: reason`.
    Only the leading relative path is extracted.
    """
    if not PENDING_FILE.exists():
        return set()
    allow: set[str] = set()
    for line in PENDING_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        # strip leading "- " and take up to first whitespace or em-dash
        rest = line[2:].strip()
        for sep in (" — ", " -- ", " -- ", "  ", "\t"):
            if sep in rest:
                rest = rest.split(sep, 1)[0]
                break
        rest = rest.strip("`").strip()
        if rest.endswith(".cln"):
            allow.add(rest)
    return allow


def is_exempt(path: Path) -> bool:
    try:
        rel = path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return False
    if rel in EXEMPT_RELATIVE_PATHS:
        return True
    for suffix in EXEMPT_SUFFIXES:
        if rel.endswith(suffix):
            return True
    return False


def iter_test_files() -> list[Path]:
    files: list[Path] = []
    for root in TEST_ROOTS:
        if root.exists():
            files.extend(sorted(root.rglob("*.cln")))
    if PLUGIN_TESTS_GLOB.exists():
        for plugin_tests_dir in sorted(PLUGIN_TESTS_GLOB.glob("*/tests")):
            files.extend(sorted(plugin_tests_dir.rglob("*.cln")))
    return files


def strip_strings(source: str) -> str:
    """Remove double-quoted string contents so tag/regex scans don't false-positive
    on legitimate code that mentions banned words inside strings."""
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', source)


def strip_line_comments(source: str) -> str:
    return re.sub(r"//[^\n]*", "", source)


def check_file(path: Path) -> list[Offense]:
    offenses: list[Offense] = []
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        offenses.append(Offense(path, "encoding", "file is not valid UTF-8"))
        return offenses

    if not raw.strip():
        offenses.append(Offense(path, "empty", "file is empty"))
        return offenses

    if DEPRECATED_MOCK_RE.search(raw):
        offenses.append(Offense(
            path,
            "deprecated-mock",
            "references tests/framework/utils/bridge_mocks.cln (deprecated per CONVENTIONS.md §2)",
        ))

    # Tag scan: run against source with string contents stripped so we don't
    # false-positive on legitimate code that quotes banned words.
    tag_source = strip_strings(raw)
    for match in SUSPECT_TAGS_RE.finditer(tag_source):
        line_no = tag_source[: match.start()].count("\n") + 1
        offenses.append(Offense(
            path,
            "suspect-tag",
            f"line {line_no}: contains '{match.group(0)}' (allowed only in PENDING.md)",
        ))

    # PASS: line requirement
    if not PASS_LINE_RE.search(raw):
        offenses.append(Offense(
            path,
            "no-pass-line",
            "file emits no printl(\"PASS: ...\") line (CONVENTIONS.md §6)",
        ))

    # Real API surface: must call at least one dot-notation namespace or an
    # allowed translation/helper function. Assertion helpers alone are not
    # enough — a file whose only real call is assertTrue(...) is still a
    # placeholder unless it also exercises something real.
    #
    # Exception: runtime smoke tests (tests/framework/runtime/) exist to verify
    # the toolchain works with NO plugins involved. They pass on arithmetic
    # + printl alone.
    try:
        rel_posix = path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel_posix = str(path)
    is_runtime_smoke = rel_posix.startswith(RUNTIME_ONLY_PREFIX)

    stripped = strip_line_comments(raw)
    has_dot_call = any(ns in stripped for ns in DOT_NAMESPACES)
    has_translation_call = any(fn in stripped for fn in TRANSLATION_FUNCS)
    # An html: block inside a functions: body is the frame.ui rendering
    # pipeline — that IS a real API call, expanded by the plugin at compile
    # time. Treat its presence as a real call.
    has_html_block = bool(HTML_BLOCK_RE.search(stripped))
    # DSL block declarations (server:, auth:, data Post:, endpoints:, etc.)
    # invoke plugin expansion — they ARE the real API surface being tested.
    has_dsl_block = bool(DSL_BLOCK_RE.search(stripped))
    has_http_verb = bool(HTTP_VERB_RE.search(stripped))
    has_model_method = bool(MODEL_METHOD_RE.search(stripped))
    is_exempt_shape = (is_runtime_smoke or has_html_block or has_dsl_block or
                      has_http_verb or has_model_method)
    if not has_dot_call and not has_translation_call and not is_exempt_shape:
        offenses.append(Offense(
            path,
            "no-real-call",
            "no dot-notation namespace call and no translation/helper call detected — "
            "file appears to be a string-matching placeholder",
        ))

    # String-match-only anti-pattern: file contains `.contains(...)` or
    # equivalent AND does not contain any dot-namespace call. Runtime-smoke
    # files never need to string-match; html-block files are asserting on
    # rendered markup which IS the real test surface for frame.ui.
    if STRING_MATCH_ONLY_RE.search(stripped) and not has_dot_call and not is_exempt_shape:
        offenses.append(Offense(
            path,
            "string-match-only",
            "uses .contains/.indexOf/.startsWith/.endsWith without calling a real API "
            "(CONVENTIONS.md §9)",
        ))

    # Code-looking string literals — flagged only if the file also has no
    # dot-call and isn't runtime-smoke or html-block-based. Standalone,
    # code-looking literals are legitimate (SQL inside db.query, HTML in html:).
    if not has_dot_call and not is_exempt_shape and CODE_LOOKING_LITERAL_RE.search(raw):
        offenses.append(Offense(
            path,
            "code-in-string",
            "file contains code-shaped string literals but never calls the real API — "
            "classic placeholder shape",
        ))

    return offenses


def check_files(paths: list[Path], allowlist: set[str]) -> list[Offense]:
    all_offenses: list[Offense] = []
    for path in paths:
        if is_exempt(path):
            continue
        try:
            rel = path.relative_to(REPO_ROOT).as_posix()
        except ValueError:
            rel = str(path)
        if rel in allowlist:
            continue
        all_offenses.extend(check_file(path))
    return all_offenses


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Detect placeholder patterns in Clean Framework test files.",
    )
    parser.add_argument(
        "files",
        nargs="*",
        help="Specific files to check. If omitted, walks the whole tree.",
    )
    parser.add_argument(
        "--list-files",
        action="store_true",
        help="Print the files that would be checked and exit.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Only print offenses; suppress the 'ok' summary.",
    )
    args = parser.parse_args(argv)

    if args.files:
        paths = []
        for f in args.files:
            p = Path(f).resolve()
            if p.suffix == ".cln" and p.exists():
                paths.append(p)
    else:
        paths = iter_test_files()

    if args.list_files:
        for p in paths:
            print(p.relative_to(REPO_ROOT))
        return 0

    allowlist = load_pending_allowlist()
    offenses = check_files(paths, allowlist)

    if offenses:
        print(f"Found {len(offenses)} placeholder offense(s) in {len({o.path for o in offenses})} file(s):")
        print()
        for o in offenses:
            print("  " + o.render())
        print()
        print("Fix each offense per system-documents/testing/TEST_STRATEGY.md §5.")
        print("If the fix requires an upstream compiler/plugin change:")
        print("  1. Call `report_error` via the MCP tool with the error code.")
        print("  2. Add the file to tests/PENDING.md with the error code and reason.")
        print("  3. Do NOT commit a placeholder in the meantime.")
        return 1

    if not args.quiet:
        print(f"OK: {len(paths)} test file(s) checked, no placeholder offenses.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
