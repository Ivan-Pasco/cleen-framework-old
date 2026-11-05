#!/usr/bin/env python3
"""Diff every plugin.toml [bridge] declaration against the function registry.

The registry (foundation/spec/platform/function-registry.toml) is the
contract for every host bridge function. A plugin that declares a bridge
with a different WASM shape than the registry makes the compiler emit an
import the hosts do not implement. This script applies the same comparison
rule as the compiler's registry validator (see the "VALIDATOR COMPARISON
RULE" header of the registry):

  - params are compared as WASM shapes: "string" is (i32, i32) when the
    entry expands strings (plugin: `expand_strings = true`; registry: the
    default) and a single i32 otherwise; "integer" / "boolean" / "i32" /
    "handler" / "any" / "ptr" are i32, "i64" is i64, "number" / "f64" f64;
  - returns: "string" / "ptr" / "any" are one pointer, "integer" /
    "boolean" / "i32" an i32, "number" / "f64" an f64, "i64", "void";
  - hosts: a plugin may only claim hosts the registry permits;
  - a declared bridge missing from the registry is reported as well.

Usage:
  scripts/check-bridge-registry.py [--registry PATH] [plugin-dir ...]

Default registry: ../foundation/spec/platform/function-registry.toml next to
this checkout; default plugins: every plugins/*/plugin.toml. Exit 0 when
every declaration matches, 1 on drift, 2 on a read/parse error.
"""

import argparse
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMEWORK = os.path.dirname(HERE)
DEFAULT_REGISTRY = os.path.join(
    os.path.dirname(FRAMEWORK), "foundation", "spec", "platform", "function-registry.toml"
)


# ---------------------------------------------------------------------------
# Minimal TOML reader — the subset the registry and plugin manifests use:
# [table] / [[array.of.tables]] headers, key = value, basic and literal
# strings, arrays (multi-line), inline tables, booleans, numbers, comments.
# ---------------------------------------------------------------------------

class TomlError(Exception):
    pass


class _Reader:
    def __init__(self, text, path):
        self.s = text
        self.i = 0
        self.path = path

    def error(self, msg):
        line = self.s.count("\n", 0, self.i) + 1
        raise TomlError("%s:%d: %s" % (self.path, line, msg))

    def peek(self):
        return self.s[self.i] if self.i < len(self.s) else ""

    def skip_ws(self, newlines):
        while self.i < len(self.s):
            c = self.s[self.i]
            if c in " \t\r" or (newlines and c == "\n"):
                self.i += 1
            elif c == "#":
                while self.i < len(self.s) and self.s[self.i] != "\n":
                    self.i += 1
            else:
                break

    def key(self):
        self.skip_ws(False)
        c = self.peek()
        if c == '"':
            return self.basic_string()
        if c == "'":
            return self.literal_string()
        start = self.i
        while self.i < len(self.s) and (self.s[self.i].isalnum() or self.s[self.i] in "_-"):
            self.i += 1
        if start == self.i:
            self.error("expected a key")
        return self.s[start:self.i]

    def dotted_key(self):
        parts = [self.key()]
        self.skip_ws(False)
        while self.peek() == ".":
            self.i += 1
            parts.append(self.key())
            self.skip_ws(False)
        return parts

    def basic_string(self):
        self.i += 1
        out = []
        escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "b": "\b", "f": "\f"}
        while True:
            if self.i >= len(self.s) or self.s[self.i] == "\n":
                self.error("unterminated string")
            c = self.s[self.i]
            if c == '"':
                self.i += 1
                return "".join(out)
            if c == "\\":
                n = self.s[self.i + 1]
                if n in escapes:
                    out.append(escapes[n])
                    self.i += 2
                elif n in "uU":
                    width = 4 if n == "u" else 8
                    out.append(chr(int(self.s[self.i + 2:self.i + 2 + width], 16)))
                    self.i += 2 + width
                else:
                    self.error("bad escape \\%s" % n)
            else:
                out.append(c)
                self.i += 1

    def literal_string(self):
        end = self.s.find("'", self.i + 1)
        if end == -1:
            self.error("unterminated literal string")
        value = self.s[self.i + 1:end]
        self.i = end + 1
        return value

    def value(self):
        self.skip_ws(False)
        c = self.peek()
        if c == '"':
            return self.basic_string()
        if c == "'":
            return self.literal_string()
        if c == "[":
            self.i += 1
            items = []
            while True:
                self.skip_ws(True)
                if self.peek() == "]":
                    self.i += 1
                    return items
                items.append(self.value())
                self.skip_ws(True)
                if self.peek() == ",":
                    self.i += 1
                elif self.peek() != "]":
                    self.error("expected , or ] in array")
        if c == "{":
            self.i += 1
            table = {}
            self.skip_ws(False)
            if self.peek() == "}":
                self.i += 1
                return table
            while True:
                keys = self.dotted_key()
                self.skip_ws(False)
                if self.peek() != "=":
                    self.error("expected = in inline table")
                self.i += 1
                _assign(table, keys, self.value(), self)
                self.skip_ws(False)
                if self.peek() == ",":
                    self.i += 1
                elif self.peek() == "}":
                    self.i += 1
                    return table
                else:
                    self.error("expected , or } in inline table")
        start = self.i
        while self.i < len(self.s) and self.s[self.i] not in ",]}\n#":
            self.i += 1
        word = self.s[start:self.i].strip()
        if word == "true":
            return True
        if word == "false":
            return False
        try:
            return int(word.replace("_", ""), 0)
        except ValueError:
            pass
        try:
            return float(word.replace("_", ""))
        except ValueError:
            self.error("unsupported value %r" % word)


def _assign(table, keys, value, reader):
    for k in keys[:-1]:
        table = table.setdefault(k, {})
        if isinstance(table, list):
            table = table[-1]
    if keys[-1] in table:
        reader.error("duplicate key %s" % ".".join(keys))
    table[keys[-1]] = value


def parse_toml(path):
    with open(path, encoding="utf-8") as f:
        r = _Reader(f.read(), path)
    root = {}
    current = root
    while True:
        r.skip_ws(True)
        if r.i >= len(r.s):
            return root
        if r.s.startswith("[[", r.i):
            r.i += 2
            keys = r.dotted_key()
            if not r.s.startswith("]]", r.i):
                r.error("expected ]]")
            r.i += 2
            parent = root
            for k in keys[:-1]:
                parent = parent.setdefault(k, {})
                if isinstance(parent, list):
                    parent = parent[-1]
            current = {}
            parent.setdefault(keys[-1], []).append(current)
        elif r.peek() == "[":
            r.i += 1
            keys = r.dotted_key()
            if r.peek() != "]":
                r.error("expected ]")
            r.i += 1
            current = root
            for k in keys:
                current = current.setdefault(k, {})
                if isinstance(current, list):
                    current = current[-1]
        else:
            keys = r.dotted_key()
            r.skip_ws(False)
            if r.peek() != "=":
                r.error("expected =")
            r.i += 1
            _assign(current, keys, r.value(), r)


# ---------------------------------------------------------------------------
# Shape comparison (mirrors the compiler's registry validator)
# ---------------------------------------------------------------------------

def _base(t):
    return str(t).split(":")[0]


def param_shape(params, expand):
    shape = []
    for p in params:
        t = _base(p)
        if t == "string":
            shape += ["i32", "i32"] if expand else ["i32"]
        elif t in ("ptr", "any", "integer", "boolean", "i32", "handler"):
            shape.append("i32")
        elif t == "i64":
            shape.append("i64")
        elif t in ("number", "f64"):
            shape.append("f64")
        elif t in ("void", ""):
            pass
        else:
            shape.append("unknown(%s)" % t)
    return shape


def return_shape(t):
    t = _base(t)
    if t in ("string", "ptr", "any"):
        return "ptr"
    if t in ("integer", "boolean", "i32"):
        return "i32"
    if t in ("number", "f64"):
        return "f64"
    if t == "i64":
        return "i64"
    if t in ("void", ""):
        return "void"
    return "unknown(%s)" % t


def check_plugin(manifest, registry):
    data = parse_toml(manifest)
    name = data.get("plugin", {}).get("name", os.path.basename(os.path.dirname(manifest)))
    problems = []
    for decl in data.get("bridge", {}).get("functions", []):
        fn = decl.get("name", "?")
        reg = registry.get(fn)
        if reg is None:
            problems.append("%s/%s: not in the registry" % (name, fn))
            continue
        p_params = decl.get("params", [])
        p_expand = bool(decl.get("expand_strings", False))
        r_params = reg.get("params", [])
        r_expand = bool(reg.get("expand_strings", True))
        ps, rs = param_shape(p_params, p_expand), param_shape(r_params, r_expand)
        if ps != rs:
            problems.append(
                "%s/%s: params %s (expand_strings=%s) are WASM %s; registry params %s are WASM %s"
                % (name, fn, p_params, str(p_expand).lower(), ps, r_params, rs)
            )
        pr, rr = return_shape(decl.get("returns", "void")), return_shape(reg.get("returns", "void"))
        if pr != rr:
            problems.append(
                "%s/%s: returns %r (%s); registry returns %r (%s)"
                % (name, fn, decl.get("returns", "void"), pr, reg.get("returns", "void"), rr)
            )
        r_hosts = reg.get("hosts", [])
        if r_hosts and "all" not in r_hosts:
            for h in decl.get("hosts", []) or []:
                if h != "all" and h not in r_hosts:
                    problems.append("%s/%s: host %r not permitted by registry hosts %s" % (name, fn, h, r_hosts))
    return name, len(data.get("bridge", {}).get("functions", [])), problems


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--registry", default=DEFAULT_REGISTRY)
    ap.add_argument("plugins", nargs="*", help="plugin directories (default: plugins/*)")
    args = ap.parse_args()

    try:
        reg_data = parse_toml(args.registry)
    except (OSError, TomlError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    registry = {}
    for entry in reg_data.get("functions", []):
        registry[entry["name"]] = entry
        for alias in entry.get("aliases", []):
            registry.setdefault(alias, entry)

    dirs = args.plugins or sorted(glob.glob(os.path.join(FRAMEWORK, "plugins", "*")))
    drift = 0
    for d in dirs:
        manifest = os.path.join(d, "plugin.toml")
        if not os.path.isfile(manifest):
            continue
        try:
            name, count, problems = check_plugin(manifest, registry)
        except (OSError, TomlError) as e:
            print("error: %s" % e, file=sys.stderr)
            return 2
        if problems:
            drift += len(problems)
            print("FAIL %s (%d bridge declarations, %d mismatches)" % (name, count, len(problems)))
            for p in problems:
                print("  - " + p)
        else:
            print("ok   %s (%d bridge declarations)" % (name, count))
    if drift:
        print("%d bridge declaration(s) differ from %s" % (drift, os.path.relpath(args.registry, FRAMEWORK)))
        return 1
    print("all bridge declarations match the registry")
    return 0


if __name__ == "__main__":
    sys.exit(main())
