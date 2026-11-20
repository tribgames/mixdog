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
fields; this file owns scope, order, and boundaries.

## 1. Job and mode
- New behavior and public-API refactors are out of scope. A correctness defect
  found while cleaning is reported, never fixed in a cleanup edit; a linter
  finding that points at one (a wrong result, a swallowed failure, a test that
  checks nothing) is such a defect, however small its fix.
- Never add or change formatter or linter configuration (rules, ignores,
  overrides, schema versions) unless the user asks; propose it in the
  decision list. A configuration the engine cannot read is a blocker.
- Mode is `apply` unless the user asks to check, review, or "just report";
  report-only stays read-only on every layer and lists what would change.
- An explicit focus restricts every layer. If the tool cannot isolate it, use
  targeted edits, or report the limitation and ask before widening.

## 2. Scope
1. Scope comes from the user: named files, directories, a feature area
   resolved to confirmed paths, or an explicitly requested whole project; ask
   first when absent or ambiguous. Never infer it from a diff, branch, commit,
   or recent activity.
2. Recommend (do not require) committing existing work before an apply run;
   a dirty tree means preserve those edits.
3. Drop deleted, binary, generated, vendored files and lockfiles unless
   explicitly included, and treat a file whose exact bytes something pins (a
   manifest hash, a provenance record) as generated: changing it means
   regenerating the pin, which is RISKY. Include new non-ignored files. Consumers and covering
   tests may be read; editing them outside the scope needs approval.
4. Pass the approved paths on every `scan`/`check`/`fix`; `paths:["."]` only
   for an explicitly requested whole project.
5. A pre-release pass over the whole project is a normal use once the user
   requests it; run it as partitions per "Whole-project runs" in
   `references/agent-cleanup.md`.
6. Review large scopes in bounded partitions once, keeping completion state;
   report blocked partitions without restarting finished work. Read per-rule
   and per-directory counts first, then page only relevant rows
   (`tidy action:'results'` filters). Truncation, timeouts, or scope leakage
   mark a partition **unfinished**, not clean; blocked checks stop dependent
   edits only.

## 3. Deterministic layers
1. `tidy action:'scan'` first (languages, engines used/missing,
   `installHint`); it never downloads. Files come from `git ls-files`: outside
   a git repository, or with a `.mixdog/tidy.json` tidy cannot honour, the
   call fails with the reason; report it, never treat it as clean.
2. Read `emptyPaths` (a requested path that yields no file: nested
   repository or submodule, letter case, nothing listed) and `unprocessed`
   (per language, files no formatter or linter processed, with the reason).
   Those files are unchecked, not clean; structural rules do not stand in
   for a formatter. An engine result's own `unprocessed` lists files it ran
   on but could not process; its `error` summarizes them.
3. Downloads are automatic under the default `auto` policy, and only for
   engines that would run on a file in scope. Only when `tidy.downloads` is
   `ask` does a result carry `needsApproval`: ask once, listing engines and
   bytes, then re-call with `approveDownloads:true`; if declined, skip those
   engines and say so.
4. Engines run only through `tidy`, never installed by hand; report
   `installHint` and continue other checks. An ad-hoc `npx <engine>`, global
   binary, or package script is not verification. An engine `tidy` cannot
   resolve, or an unavailable structural engine (`check`/`fix` fail with a
   rebuild remedy; `scan` still works; retry with `structural:false`), leaves that check blocked,
   never clean.
5. Plan with `fix` without `apply:true`: the dry run is diagnostics and
   candidate files, not a frozen patch. For a restricted focus, avoid a
   combined apply that touches unrelated code.
6. Apply with `apply:true` once the plan is settled (skip it when the dry run
   proposes nothing), then review the actual changes. Rules without a fix are
   diagnostics for the agent layer. Keep the engine pass a distinct change set
   from semantic edits. On engine or structural failure, truncation, or a
   rejected edit, stop affected writes; a partial result is not success. An
   engine reported `not run` after an apply stop wrote nothing. A structural
   fix is written only where the file still holds the text its rule matched,
   and no file whose real path leaves the project is written; such files are
   rejected or listed in `unprocessed`.

## 4. Agent-level cleanup
Read `references/principles.md` (what quality means here: reader load,
subtraction, the smallest change, guards at the edge, types as proof, one
path, tools for repeated edits, mechanisms over instructions, shown
equivalence) and `references/agent-cleanup.md` (the ladder, lenses, slop, risk
tiers, source-text guards, structural findings, language-specific checks and
prose tells) first; also `references/test-suite-slop.md` when tests are in
scope and `references/cleanup-report.md` for the report.

1. **Pin behavior (read-only).** Find the source-text guards a planned move
   can affect. A unit whose touched behavior no test covers gets only SAFE
   changes; report it instead of adding tests.
2. **Ladder, then lenses, then structure** on each selected source unit;
   structural findings need evidence and a reader benefit, and rank first. A
   case the tables do not name is judged by the principles. Engine diagnostics
   point at units, not coverage. Findings need path+symbol evidence. Use
   history only when code, contracts, and tests leave intent unclear;
   unresolved intent blocks deletion.
3. **Apply by tier.** SAFE as one batch; CAREFUL one source unit at a time,
   each wired into its callers (never leave a new module nothing imports);
   RISKY is reported with its evidence and applied only after the user
   approves that item. Dead code follows `references/dead-code.md`.
4. Report correctness defects and out-of-scope changes; never fix them here.
   When principles cannot pick between two rewrites, apply neither and record
   both.

## 5. Verify
Use the shared evidence budget: scoped `tidy check`, plus behavioral checks
and typechecking only where the edits can invalidate their contracts. Reuse
valid passes. Attribute failures from evidence, not from whether the failing
file was edited. A broken runner, or a skipped, failed or blocked check,
leaves its scope unverified; say so, never count it as passed.

Only if checks fail and cannot be fixed: undo this run's edits with targeted
patches that preserve prior or concurrent work, never `git checkout`, `reset`,
`restore`, or `stash`; if the edits cannot be separated safely, leave them and
report the blocker.

## 6. Keep: never remove or rename
Trust-boundary validation, contracts (exports, routes, flags, columns, keys,
event and wire names; a rename is RISKY even when the name is bad), the
never-dead list, intentional complexity, directives and public or
security docs, and the project's own idioms. The full list is in
`references/agent-cleanup.md`.

## 7. Reporting
Report once, after the last partition, using `references/cleanup-report.md`,
with everything needing the user's decision in one list. The run is not done
until that report is delivered: never call the cleanup finished before it,
and answer a progress question with the steps still open. Deliver it as soon
as the last partition is verified; later work (CI failures, a release) does
not postpone it. Pause only for a blocker or a required approval. No report
file unless requested.
