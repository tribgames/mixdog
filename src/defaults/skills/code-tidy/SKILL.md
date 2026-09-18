---
name: code-tidy
description: Format, lint, apply structural rules, and clean up recent changes with the tidy tool.
when_to_use: 'Format, lint, tidy, simplify, deslop, or clean up a codebase or recent changes: remove AI slop, dead code, and needless complexity without changing behavior; not feature work, bug hunting, or adding formatter configs.'
metadata:
  requires: tidy
dependencies:
  tools:
    - type: tool
      value: tidy
---

# Code tidy (tidy tool)

Three layers, cheapest and safest first: the project's formatters and linters
through `tidy`, then the structural rule packs, then agent-level cleanup of
the code in scope. Every layer preserves behavior and public API; this is a
cleanup pass, not a bug hunt. The schema owns action fields; this file owns
scope, order, approvals, and what must not change.

## 1. Which job
**Hard rule — tidy owns format/lint/structure/cleanup, not feature work.**
New behavior, refactors that change a public API, and adding formatter configs
are not this skill. A correctness bug found while cleaning is reported under
"Bugs found", never folded into a cleanup edit. → manual
**Hard rule — never invent a formatter config**: a project that already has
Biome, Prettier, clang-format, rustfmt, gofmt, or equivalent keeps it. Do not
add or rewrite `biome.json`, `.prettierrc`, `.clang-format`, or similar unless
the user asks. → manual
**Mode**: `apply` unless the user asks to check, review, or "just report" —
then every layer stays dry-run and the report lists what would change.
**Focus**: an explicit focus ("only dead code", "efficiency") restricts the
agent layer to that lens; the deterministic layers still run.

## 2. Scope
Default scope is the recent change, not the tree:
1. `git status --short` (untracked files) plus `git diff --name-only HEAD`
   (staged and unstaged). Empty → the merge-base diff against the default
   branch. Still empty → the files the user named or edited this session.
   Nothing at all → say there is nothing to tidy and stop.
2. Drop deleted, binary, generated, vendored files and lockfiles. Add the test
   file covering each changed source even when that test was not itself
   changed: suite bloat accumulates where the change never landed.
3. Widen only when the user asks ("the whole tree", a directory, a branch).
4. Pass the list as `paths` on every `tidy` call so engines, rules, and the
   agent layer see the same files. Result: the report names the scope.

## 3. Deterministic layers
1. `tidy action:'scan'` first: languages and engines (used / missing /
   `installHint`). Scan never downloads and never returns `needsApproval`.
2. **Hard rule — downloads are automatic under the default `auto` policy;
   only when the user set `tidy.downloads` to `ask` does a result carry
   `needsApproval` — then ask once**, list engines and bytes, and re-call
   that action with `approveDownloads:true`. → manual
3. **Hard rule — never install toolchain engines** (rustfmt, gofmt, dart,
   swift, zig, mix, dotnet): report `installHint`. Managed engines download
   only through tidy (`auto`, `approveDownloads`, or `action:'install'`). → manual
4. Engines, then structural rules, each dry-run then apply, with the
   project's tests/typecheck after every apply and a stop on failure:
   - engine `check` with `structural:false`;
   - engine `fix` with `structural:false`, then the same call with `apply:true`;
   - `tidy action:'fix' structural:true`, then `apply:true`.
   `structural` defaults to true on check/fix, so engine steps must pass
   `structural:false` or structural fixes land during the engine write. A
   dry-run with no changes skips that apply. Rules without a fix
   (`no-empty-catch`, `no-nested-ternary`, `no-any-cast`,
   `no-boolean-literal-compare`, `no-debug-statement`, `todo-marker`) are
   diagnostics for the agent layer, not changes. Skip a layer the scan shows
   has nothing to do. Keep the engine pass separable from the agent edits: a
   reformat folded into semantic changes makes the diff unreviewable, so
   report them as distinct change sets.

## 4. Agent-level cleanup
Read `references/agent-cleanup.md` first: it owns the deletion ladder, the
lens checklists, the slop categories, the risk tiers, and the report
template. This section owns the order.

1. **Lock behavior.** Run the project's tests and typecheck before any edit.
   Green, or pre-existing failures listed as excluded, is the baseline; a
   broken runner stops the layer with a report. A file with no test covering
   the behavior you will touch gets either the narrowest regression test that
   pins its observable output, or only SAFE-tier changes — say which. Prose
   files (skills, prompts, docs) have no behavior to pin.
2. **Ladder, then lenses.** Run the deletion ladder on every changed unit;
   only survivors go through the four lenses (reuse, quality, efficiency,
   altitude). Every finding carries `file:line` evidence, a cost, a
   confidence, and a risk tier; findings without evidence are dropped, and
   `git blame` precedes any removal (unexplained intent is `confidence: low`).
   When this session can delegate to parallel workers, run one lens per
   worker with the complete diff and the repo path — workers report findings,
   never edit. Otherwise run the lenses yourself in sequence and say so in
   the report. Result: one merged, deduplicated finding list.
3. **Apply by tier.** SAFE as one batch with tests after it; CAREFUL one
   file at a time with tests after each file, reverting the file on failure;
   RISKY reported, never auto-applied. Within a tier: comments → dead code →
   defensive code → duplication → complexity → abstraction → performance.
   Structural items from the table below are CAREFUL; dead code follows
   `references/dead-code.md`. After the last tier lands, re-run `tidy check`
   over the same paths once: removals leave new unused imports and newly
   orphaned helpers behind. Apply only SAFE findings from that cascade pass
   and report the rest — one pass, never a loop.
4. **Stop rules.** Three failed attempts on one file → stop and escalate with
   what was tried. A deeper fix larger than the cleanup → report it as its own
   task. Principles cannot pick between two rewrites → apply neither, record
   both.

| Structural threshold | Action |
|---|---|
| File > 800 lines | Split by responsibility |
| Function > 50 lines, or nesting > 3 | Extract |
| Duplicated small helpers across files | Consolidate into a shared module |
| Comments describing history (`extracted verbatim`, `moved from`, `behavior-preserving move`) | Delete |
| Underscore-prefixed names exported across modules | Rename |
| Dead code / unused exports | Remove |

Do not "improve" names, control flow, or types beyond the ladder, the lenses,
and this table.

## 5. Keep — never remove or rename
- Validation and error handling at a trust boundary (user input, external
  API, file, network) unless an adversarial test proves the guard redundant.
- Export names, API routes, CLI flags, DB columns, config keys, event names,
  wire strings — contracts; a rename is RISKY even when the name is bad.
- Anything on the never-dead list in `references/dead-code.md`.
- An empty catch or ignored error that may be intentional — flag it.
- Complexity a comment or `git blame` explains: compat shims, staged
  migrations, isolation around vendored code.
- The project's own idioms: `AGENTS.md`/`CLAUDE.md`/lint config beat a
  generic idiom; clarity beats fewer lines; nested ternaries are flattened,
  never introduced.

## 6. Pitfalls
- Missing toolchain engine → `installHint` only; continue other engines.
- User declines downloads → skip those engines; say so.
- Tests/typecheck fail after apply → revert that change; do not start the
  next layer until the baseline is green again.
- Formatter config missing and the user did not ask to add one → tidy
  defaults / detected engines; never write a config file.
- Structural engine unavailable (missing or outdated mixdog-graph) → `check` /
  `fix` fail with a rebuild remedy; `scan` still succeeds and names the binary
  in `notes`. Retry with `structural:false` for formatters/linters only; never
  treat missing structural matches as clean.
- Diff over ~2000 changed lines → split the agent layer per directory or
  commit before running the lenses; one huge pass truncates.
- A dead-code scanner report is a candidate list, not proof → verify per
  `references/dead-code.md` before deleting.

## 7. Report
Use the template in `references/agent-cleanup.md`. It must name the scope and
mode, engines used/missing, files changed, diagnostics remaining, structural
matches applied/skipped, agent findings applied by lens and tier, **Noticed
but not applied** with the reason, deferred debt, bugs found, and the test,
typecheck, and lint results. An inline (non-delegated) lens run is stated as
such.

## 8. References
- `references/agent-cleanup.md` — before section 4: ladder, lenses, slop
  categories with keep/fix rules, test-suite slop, risk tiers, report
  template.
- `references/dead-code.md` — before removing any unused symbol, file, or
  dependency: candidate sources, verification, never-dead list, order.
