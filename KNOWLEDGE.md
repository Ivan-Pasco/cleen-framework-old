# KNOWLEDGE.md — Clean Framework (Frame)

Known considerations. Read before modifying framework code.

---

## 1. Plugin Expand Functions

**What:** Each framework plugin (frame.server, frame.data, frame.ui, frame.auth, frame.canvas, ...) has an expand function (`expand_block_typed`, named in `plugin.toml [exports].expand`) in its `src/main.cln` that transforms high-level DSL blocks into lower-level Clean Language code with bridge function calls. Bugs in expand functions produce valid-looking but semantically wrong WASM.

**Where:** Each plugin's `src/main.cln`

**Watch for:** Changes to bridge function signatures in plugin.toml must be reflected in the expand function's generated code. The expand function is the translation layer between user-facing DSL and runtime bridge calls.

---

## 2. Plugin.toml is the Contract

**What:** `plugin.toml` defines the contract between the compiler, the framework plugin, and the runtime server. It declares blocks, keywords, bridge functions, types, enforcement rules, and path conventions. The compiler reads this at compile time; the server implements the bridge functions at runtime.

**Watch for:** Any change to plugin.toml affects three systems (compiler, framework, server). Use `../foundation/spec/framework/grammar/frame-*.ebnf` as the authoritative syntax reference and `../foundation/spec/platform/function-registry.toml` for bridge signatures.

---

## 3. Framework Specifications

**What:** Behavioral specifications live in `../foundation/spec/framework/` (`frame-<plugin>-semantics.md`, `plugin-contract.md`, `contracts/`). These describe intended behavior, not necessarily current implementation state.

**Where:** `../foundation/spec/framework/frame-*-semantics.md` and `grammar/frame-*.ebnf`

**Watch for:** Gaps between the specification and the actual plugin implementation. The spec is the target; the implementation may lag.
