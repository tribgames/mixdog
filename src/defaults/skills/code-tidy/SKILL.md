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

The cleanup enforces an explicit three-phase contract:
**investigation (find all items) - execution - reporting (what was completed, how each item changed, and what remains)**.
Investigation determines the entire candidate inventory before editing; work executes
in approved bounded rounds; each report reconciles every candidate, reporting round
completion separately from overall completion to prevent silent scope leaks.

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
report-only requests stay read-only across all layers and never edit; the report
lists what would change.
**Focus**: an explicit focus ("only dead code", "efficiency") restricts the
agent layer to that lens; the deterministic layers still run.
Maintain candidate inventory and progress under the shared delivery policy.

## 2. Scope and investigation
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
5. **Establish the baseline before any edit**: run the project's tests and
   typecheck. Green, or explicitly listed pre-existing failures excluded from
   the change, is the baseline. A broken runner blocks changes that require
   it; continue independent work and report the blocked scope as unfinished.
6. **Complete read-only investigation before cleanup**: run all applicable
   investigation checks (tidy scan/check, structural rules, dead-code detection,
   lens analysis) read-only to gather the complete candidate inventory before
   any edits.
   - Register candidates per `references/agent-cleanup.md`: assign stable IDs,
     group equal root causes without losing member locations, and distinguish
     mechanical threshold hits from confirmed cleanups and kept items. Every
     threshold hit requires planned action, an evidenced keep under the documented keep rules,
     or an unfinished status with a concrete blocker.
   - Truncated results, timeouts, failed diagnostic checks, or scope leakage
     mean an **unfinished investigation**, not a clean state. The entire inventory
     must be accounted for before claiming investigation complete.
   - Partial implementation while investigation is blocked is permitted only if
     the user explicitly approves that specific unblocked subset.

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
lens checklists, the slop categories, the risk tiers, candidate inventory
definitions, and the report template. This section owns the order.

1. **Lock behavior.** Use the baseline established in section 2. A file with no test covering
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
3. **Execute in approved bounded rounds.**
   - Retain the complete candidate inventory across rounds; never silently
     narrow scope or overwrite the backlog with the completed subset. Newly
     discovered candidates (such as cascade findings) are appended with new IDs.
   - Independent modules may be cleaned in parallel across tasks; within any
     file or module, CAREFUL source units must be edited sequentially.
   - Apply by tier: SAFE as one batch with tests after it; CAREFUL one source
     unit at a time with tests after each unit, reverting on failure; RISKY
     reported, never auto-applied. Within a tier: comments → dead code →
     defensive code → duplication → complexity → abstraction → performance.
   - Structural items from the table below are CAREFUL; dead code follows
     `references/dead-code.md`.
   - After the last tier lands in a round, re-run `tidy check` over the same
     paths once: removals leave new unused imports and newly orphaned helpers
     behind. Apply only SAFE findings from that cascade pass and add any
     remaining items to the inventory — one pass, never a loop.
4. **Stop rules.** Three failed attempts on one file → stop and escalate with
   what was tried. A deeper fix larger than the cleanup → report it as its own
   task. Principles cannot pick between two rewrites → apply neither, record
   both.

| Structural threshold | Action |
|---|---|
| File > 1,000 lines | Split by responsibility |
| Function > 50 lines, or nesting > 3 | Extract |
| Duplicated small helpers across files | Consolidate into a shared module |
| Comments describing history (`extracted verbatim`, `moved from`, `behavior-preserving move`) | Delete |
| Underscore-prefixed names exported across modules | Rename |
| Dead code / unused exports | Remove |

Do not "improve" names, control flow, or types beyond the ladder, the lenses,
and this table.

Size alone does not make a split RISKY. A responsibility-based split that
preserves behavior and public entry points is CAREFUL: name the responsibilities,
extract one source unit at a time with the new modules it requires, and verify
its direct consumers before the next extraction. Moving the entire oversized
body elsewhere or cutting it into numbered chunks does not satisfy the split.
If a documented keep rule applies, record the evidence; otherwise an unperformed
split remains unfinished, with its specific blocker.

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

## 7. Report and reconciliation
Use the template and inventory reconciliation rules in `references/agent-cleanup.md`.

1. **Separate round completion from whole cleanup completion.**
   Always state the current round outcome separately from overall cleanup status.
   Never claim the entire cleanup is complete when further rounds or unfinished
   items remain.
2. **Reconcile every candidate ID.**
   Account for every candidate ID under completed, kept, or unfinished per
   `references/agent-cleanup.md`. All candidate IDs must reconcile across rounds.
3. **Verification record.**
   Report test counts (passed, failed, pre-existing excluded, skipped), typecheck,
   and lint diagnostics. Never mark skipped or failed checks as passed.
4. **Completion criteria.**
   Declare overall cleanup complete only when every candidate ID in the full
   inventory is verified completed or evidenced as kept across all stages. A
   finished round with remaining inventory items is reported as **round complete,
   overall partial**, naming the remaining items and next round.

## 8. References
- `references/agent-cleanup.md` — before section 4: ladder, lenses, slop
  categories with keep/fix rules, test-suite slop, risk tiers, report
  template.
- `references/dead-code.md` — before removing any unused symbol, file, or
  dependency: candidate sources, verification, never-dead list, order.
