#!/usr/bin/env python3
"""Replace named host imports of a WASM module with functions that trap.

Plugin helper tests (scripts/test-plugins.sh) run a plugin's parsing and
validation helpers outside the compiler. The plugin source declares the
compiler's typed-emission bridges (its `external:` blocks) and compile-time
bridges such as _build_state_get; no runtime provides them, so the module
could not be instantiated. Those imports become local functions whose body
is `unreachable`: a helper test that reaches one fails loudly instead of
silently passing.

Usage:
    stub-wasm-imports.py IN.wasm OUT.wasm SOURCE.cln [EXTRA_NAME ...]

Every import named in an `external:` block of SOURCE.cln, every import whose
name starts with `_build_state_`, and every EXTRA_NAME is stubbed. Needs
wasm-tools on PATH.
"""

import re
import subprocess
import sys


def external_names(source_path):
    """Function names declared in the `external:` blocks of a .cln file."""
    names = set()
    in_external = False
    with open(source_path, encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not line.startswith(("\t", " ")) and stripped:
                in_external = stripped == "external:"
                continue
            if in_external and stripped and not stripped.startswith("//"):
                m = re.match(r"[\w<>\[\],\s]*?\b([A-Za-z_]\w*)\s*\(", stripped)
                if m:
                    names.add(m.group(1))
    return names


def main():
    if len(sys.argv) < 4:
        print(__doc__.strip().splitlines()[-6], file=sys.stderr)
        sys.exit(2)
    wasm_in, wasm_out, source = sys.argv[1], sys.argv[2], sys.argv[3]
    stub = external_names(source) | set(sys.argv[4:])

    wat = subprocess.run(
        ["wasm-tools", "print", "--name-unnamed", wasm_in],
        check=True, capture_output=True, text=True,
    ).stdout

    import_re = re.compile(
        r'^(\s*)\(import "[^"]*" "([^"]+)" \(func (\$\S+)(?: \(;\d+;\))? (\(type [^)]*\))\)\)\s*$'
    )
    kept, stubs = [], []
    for line in wat.splitlines():
        m = import_re.match(line)
        if m and (m.group(2) in stub or m.group(2).startswith("_build_state_")):
            stubs.append(f"{m.group(1)}(func {m.group(3)} {m.group(4)} unreachable)")
        else:
            kept.append(line)

    # The module's closing paren is the last non-empty line.
    while kept and not kept[-1].strip():
        kept.pop()
    if not kept or kept[-1].strip() != ")":
        print("stub-wasm-imports: unexpected WAT layout", file=sys.stderr)
        sys.exit(1)
    out = "\n".join(kept[:-1] + stubs + [kept[-1]]) + "\n"

    subprocess.run(
        ["wasm-tools", "parse", "-", "-o", wasm_out],
        input=out, check=True, text=True,
    )


if __name__ == "__main__":
    main()
