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
  found while cleaning is reported, never fixed in a cleanup edit.
- Never invent a formatter config; a project's own formatter stays unless the
  user asks to add or rewrite one.
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
   explicitly included; include new non-ignored files. Consumers and covering
   tests may be read; editing them outside the scope needs approval.
4. Pass the approved paths on every `scan`/`check`/`fix`; `paths:["."]` only
   for an explicitly requested whole project.
5. Review large scopes in bounded partitions once, keeping completion state;
   report blocked partitions without restarting finished work. Read per-rule
   and per-directory counts first, then page only relevant rows
   (`tidy action:'results'` filters). Truncation, timeouts, or scope leakage
   mark a partition **unfinished**, not clean; blocked checks stop dependent
   edits only.

## 3. Deterministic layers
1. `tidy action:'scan'` first (languages, engines used/missing,
   `installHint`); it never downloads.
2. Downloads are automatic under the default `auto` policy. Only when
   `tidy.downloads` is `ask` does a result carry `needsApproval`: ask once,
   listing engines and bytes, then re-call with `approveDownloads:true`; if
   declined, skip those engines and say so.
3. Engines run only through `tidy`, never installed by hand; report
   `installHint` and continue other checks. An ad-hoc `npx <engine>`, global
   binary, or package script is not verification. An engine `tidy` cannot
   resolve, or an unavailable structural engine (`check`/`fix` fail with a
   rebuild remedy; `scan` still works; retry with `structural:false`), leaves that check blocked,
   never clean.
4. Plan with `fix` without `apply:true`: the dry run is diagnostics and
   candidate files, not a frozen patch. For a restricted focus, avoid a
   combined apply that touches unrelated code.
5. Apply with `apply:true` once the plan is settled (skip it when the dry run
   proposes nothing), then review the actual changes. Rules without a fix are
   diagnostics for the agent layer. Keep the engine pass a distinct change set
   from semantic edits. On engine or structural failure, truncation, or a
   rejected edit, stop affected writes; a partial result is not success.

## 4. Agent-level cleanup
Read `references/agent-cleanup.md` first (it owns the ladder, lenses, slop,
risk tiers, source-text guards and structural signals); also
`references/test-suite-slop.md` when tests are in scope and
`references/cleanup-report.md` for the report.

1. **Pin behavior (read-only).** Find the source-text guards a planned move
   can affect. A unit whose touched behavior no test covers gets only SAFE
   changes; report it instead of adding tests.
2. **Ladder, then lenses** on each selected source unit. Engine diagnostics
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
with everything needing the user's decision in one list. Pause only for a
blocker or a required approval. No report file unless requested.
