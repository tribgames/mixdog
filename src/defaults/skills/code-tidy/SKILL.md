---
name: code-tidy
description: Format, lint, and structurally tidy a codebase with the tidy tool.
when_to_use: 'Format, lint, apply structural rules, or tidy a codebase; not ordinary feature work or adding formatter configs.'
metadata:
  requires: tidy
dependencies:
  tools:
    - type: tool
      value: tidy
---

# Code tidy (tidy tool)

Use `tidy` to format, lint, apply structural rules, and then — only if still
needed — do agent-level structural cleanup. The schema owns action fields;
this file owns order, approvals, and what must not change.

## 1. Which job
**Hard rule — tidy owns format/lint/structure, not feature work**: a request
to clean, format, lint, apply structural rules, or tidy a tree. New behavior,
refactors that change public API, and adding formatter configs are not this
skill. → manual
**Hard rule — never invent a formatter config**: if the project already has
Biome, Prettier, clang-format, rustfmt, gofmt, or equivalent config/tools,
tidy uses them. Do not add or rewrite `biome.json`, `.prettierrc`,
`.clang-format`, or similar unless the user asks. → manual

## 2. Call order
1. `tidy action:'scan'` first. Result: languages and engines (used / missing /
   `installHint`). Scan does not download and does not return `needsApproval`.
2. **Hard rule — downloads need one ask**: if a later `check` / `fix` /
   `install` result has `needsApproval`, list engines and bytes, ask once,
   then re-call that action with `approveDownloads:true`. Never download
   without that. → manual
3. **Hard rule — never install toolchain engines**: rustfmt, gofmt, dart,
   swift, zig, mix, dotnet, PSScriptAnalyzer. Report `installHint`; do not
   brew/choco/npm/cargo-install them. Managed engines download only through
   tidy (`approveDownloads` or `action:'install'`). → manual
4. Deterministic engines, then structural rules, then agent cleanup. Skip a
   layer that the scan shows has nothing to do.

## 3. Deterministic first
Each mutating step is dry-run then apply. `fix` is dry-run unless
`apply:true`. After every apply, run the project's tests/typecheck (detect
from `package.json` / `Cargo.toml` / `pyproject`) and **stop on failure**.

1. Engine `check` with `structural:false` (report-only).
2. Engine `fix` with `structural:false` (omit `apply` or `apply:false`) → the
   same call with `apply:true`.
3. Structural rules: `tidy action:'fix' structural:true` (dry-run) →
   `apply:true`.
4. Agent-level structural cleanup only after those, still one concern per
   change set, still dry-run (read/plan) before edits.

**Default — dry-run before every apply.** A dry-run that reports no changes
skips apply for that layer. Engine steps must pass `structural:false`:
`structural` defaults to true on check/fix, so omitting it would apply
structural fixes during the engine write.

## 4. Agent-level structural cleanup
Behavior and public API stay unchanged. Tests are the gate. One concern per
change set. Report what changed and what was left, with reasons.

| Threshold | Action |
|---|---|
| File > 800 lines | Split by responsibility |
| Function > 50 lines, or nesting > 3 | Extract |
| Duplicated small helpers across files | Consolidate into a shared module |
| Comments describing history (`extracted verbatim`, `moved from`, `behavior-preserving move`) | Delete |
| Underscore-prefixed names exported across modules | Rename |
| Magic numbers | Name them |
| Dead code / unused exports | Remove |

Do not "improve" names, control flow, or types beyond this list.

## 5. Failure handling
- Missing toolchain engine → `installHint` only; continue other engines.
- User declines downloads → skip those engines; say so.
- Tests/typecheck fail after apply → stop; do not apply the next layer.
- Formatter config missing and the user did not ask to add one → use tidy
  defaults / detected engines; do not write a config file.
- Structural engine unavailable (missing or outdated mixdog-graph) → `check` /
  `fix` fail with a rebuild remedy. `scan` still succeeds and names the binary
  in `notes`. Retry with `structural:false` for formatters/linters only. Do
  not treat missing structural matches as clean.

## 6. Report
Always report: languages, engines used/missing, files changed, diagnostics
remaining, structural matches applied/skipped, test results.
