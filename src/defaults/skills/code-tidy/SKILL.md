---
name: code-tidy
description: Format, lint, apply structural rules, and clean up user-selected code with the tidy tool.
when_to_use: 'Tidy, format, lint, deslop, or clean up code; not new features or bug fixes.'
metadata:
  requires: tidy
dependencies:
  tools:
    - type: tool
      value: tidy
---

# Code tidy (tidy tool)

Layers, cheapest and safest first: project formatters and linters through
`tidy`, structural rule packs, then agent-level cleanup. Every layer preserves
behavior and public API; this is not a bug hunt. The `tidy` schema owns action
fields; this file owns scope, order, and boundaries. Verification follows the
shared rule: finish all planned edits, then check once (section 5).

## 1. Job and mode
- Tidy owns format, lint, structure, and cleanup, not feature work. New
  behavior and public-API refactors are out of scope. A correctness bug found
  while cleaning goes under "Bugs found", never into a cleanup edit.
- Never invent a formatter config. A project with Biome, Prettier,
  clang-format, rustfmt, gofmt, or equivalent keeps it; add or rewrite
  `biome.json`, `.prettierrc`, `.clang-format` and the like only when asked.
- Mode is `apply` unless the user asks to check, review, or "just report";
  report-only stays read-only on every layer and lists what would change.
- An explicit focus restricts every layer ("formatting only" excludes lint
  and semantic cleanup; "only dead code" excludes unrelated formatting). If
  the tool cannot isolate it, use targeted edits or report the limitation
  and ask before widening.

## 2. Scope
1. Scope comes from the user: named files, directories, a feature area
   resolved to confirmed paths, or an explicitly requested whole project. If
   absent or ambiguous, ask first. Never infer it from a diff, branch,
   commit, or recent activity.
2. Recommend (do not require, do not do it for them) that the user commit
   existing work before an apply run. A dirty tree means preserve those edits.
3. Drop deleted, binary, generated, vendored files and lockfiles unless
   explicitly included. Consumers and covering tests may be read; editing
   them outside the scope needs approval. New non-ignored files are included.
4. Pass the approved paths on every `scan`/`check`/`fix`; `paths:["."]` only
   for an explicitly requested whole project.
5. Too large to review in one pass (whole project, many directories):
   partition by directory or responsibility so every source unit gets the
   ladder and every survivor the lenses; hundreds of files per partition is
   the usual failure. Work through all partitions without pausing for input.
   Keep the partition list and candidate list across turns.
6. Read per-rule and per-directory counts first, then page only relevant
   rows with `tidy action:'results'` filters; never treat unreviewed in-scope
   results as clean. Real engine truncation, timeouts, or scope leakage mark
   that partition **unfinished**, not clean. Blocked checks stop dependent
   edits only.

## 3. Deterministic layers
1. `tidy action:'scan'` first (languages, engines used/missing,
   `installHint`). Scan never downloads.
2. Downloads are automatic under the default `auto` policy. Only when
   `tidy.downloads` is `ask` does a result carry `needsApproval`: ask once,
   listing engines and bytes, then re-call with `approveDownloads:true`.
3. Engines run only through `tidy` and are never installed by hand
   (rustfmt, gofmt, dart, swift, zig, mix, dotnet: report `installHint`). An
   ad-hoc `npx <engine>`, global binary, or package script is not
   verification and may report a false clean. An engine `tidy` cannot resolve
   leaves its check blocked, never clean.
4. Plan with `fix` without `apply:true`; no separate `check` first. The dry
   run is diagnostics and candidate files, not a frozen patch; apply
   recalculates. `structural:true` (default) also runs ordinary engines;
   `structural:false` disables structural rules only, not engine lint fixes.
   For a restricted focus, do not use a combined apply that touches unrelated
   code.
5. Apply with `apply:true` once the plan for the scope is settled, then review
   the actual changes. Skip apply when the dry run proposes nothing.
   Rules without a fix (`no-empty-catch`, `no-nested-ternary`, `no-any-cast`,
   `no-boolean-literal-compare`, `no-debug-statement`, `todo-marker`) are
   diagnostics for the agent layer. Keep the engine pass a distinct change
   set from semantic edits. On engine or structural failure, truncation, or a
   rejected edit, stop affected writes; a partial result is not success.

## 4. Agent-level cleanup
Read `references/agent-cleanup.md` (ladder, lenses, slop, risk tiers); also
`references/test-suite-slop.md` when tests are in scope, and
`references/cleanup-report.md` for recording and the closing report.

1. **Pin behavior (read-only).** Search the tests for source-text guards
   (shapes in `agent-cleanup.md`) before extracting or moving anything. A file
   whose touched behavior no test covers gets the narrowest regression test
   that pins it, or only SAFE changes. Prose files have no behavior to pin.
2. **Ladder, then lenses.** Run the deletion ladder on every selected source
   unit, then the four lenses on the survivors. Engine diagnostics point at
   units; they do not define coverage. A partition reviewed only where an
   engine flagged is unfinished. Each finding has a path+symbol location,
   cost, action, confidence, and risk tier; drop findings without evidence.
   Use history only when code, contracts, and tests leave intent unclear;
   unresolved intent blocks deletion.
3. **Apply by tier.** SAFE as one batch; CAREFUL one source unit at a time,
   each finished and wired into its callers (never leave a new module nothing
   imports); RISKY is reported, never auto-applied. Order within a tier:
   comments, dead code, defensive code, duplication, complexity, abstraction,
   performance. Dead code follows `references/dead-code.md`.
4. **Stop rules.** Three failed attempts on one file: stop and escalate with
   what was tried. A deeper fix larger than the cleanup: report it as its own
   task. Principles cannot pick between two rewrites: apply neither, record
   both.

Structural signals are leads, not candidates: file > 1,000 lines, function
> 50 lines or nesting > 3 (under ~100 lines, act only on a named symptom:
duplication, a defect, demonstrated difficulty of change), duplicated small
helpers (consolidate only when intent matches), history comments (remove only
if no protected content is lost), underscore-prefixed names exported across
modules (rename is RISKY). Do not improve names, control flow, or types
beyond the ladder, lenses, and these signals. A confirmed
responsibility-based split that preserves behavior and entry points is
CAREFUL; an extracted unit takes only the values it reads. Moving a whole
body elsewhere or cutting it into numbered chunks resolves nothing.

## 5. Check once, then fix
After every planned edit in the assigned scope is done, run the project's
documented tests/typecheck covering the touched behavior and `tidy check` on
the scope, once, in parallel. No check, build, lint, test, or formatter run
before that. If it fails, read the full logs, finish the fixes, and rerun only
the failed or invalidated checks. A failure on code you did not touch is
pre-existing: report it separately. A broken runner leaves its scope
unverified: say so. Skipped or failed checks never count as passed.

If checks fail and cannot be fixed, undo only this run's edits with targeted
patches, preserving prior or concurrent work. Never use `git checkout`,
`reset`, `restore`, or `stash` as rollback; if the edits cannot be separated
safely, leave them and report the blocker.

New findings from the final `tidy check` (e.g. imports orphaned by removals)
are fixed once if SAFE; others are reported.

## 6. Keep: never remove or rename
- Validation and error handling at a trust boundary (user input, external
  API, file, network) unless an adversarial test proves the guard redundant.
- Export names, API routes, CLI flags, DB columns, config keys, event names,
  wire strings: contracts. A rename is RISKY even when the name is bad.
- Anything on the never-dead list in `references/dead-code.md`.
- An empty catch or ignored error that may be intentional: flag it.
- Complexity serving a current compatibility obligation, staged migration, or
  vendored-code isolation (see legacy retirement in `dead-code.md`).
- License, copyright, SPDX notices; compiler, linter, bundler directives;
  public API docs; security and compatibility explanations. Block comments
  that may separate tokens or carry significant line breaks are left for
  manual review.
- The project's own idioms (`AGENTS.md`/`CLAUDE.md`/lint config) over generic
  ones; clarity over fewer lines; nested ternaries are flattened, never added.

## 7. Pitfalls
- Missing engine: `installHint` only; continue others; that check is blocked.
- User declines downloads: skip those engines and say so.
- Structural engine unavailable (missing or outdated mixdog-graph): `check`/
  `fix` fail with a rebuild remedy; `scan` still works. Retry with
  `structural:false` for formatters/linters only; missing structural matches
  are never clean. A per-language rule-pack error leaves only that language
  unfinished.
- A dead-code scanner report is a candidate list, not proof; verify per
  `references/dead-code.md`.

## 8. Reporting
Report once, after the last partition, using `references/cleanup-report.md`.
Put everything needing the user's decision in one list at the end: RISKY
findings, bugs found, unresolved intent, unfinished candidates. Do not pause
between partitions except for a blocker or a required approval. No separate
report file unless requested.
