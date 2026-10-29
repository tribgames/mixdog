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
- Never invent a formatter config; a project's own formatter stays. Add or
  rewrite one only when asked.
- Mode is `apply` unless the user asks to check, review, or "just report";
  report-only stays read-only on every layer and lists what would change.
- An explicit focus restricts every layer. If the tool cannot isolate it, use
  targeted edits or report the limitation and ask before widening.

## 2. Scope
1. Scope comes from the user: named files, directories, a feature area
   resolved to confirmed paths, or an explicitly requested whole project. If
   absent or ambiguous, ask first. Never infer it from a diff, branch,
   commit, or recent activity.
2. Recommend (do not require) that the user commit existing work before an
   apply run. A dirty tree means preserve those edits.
3. Drop deleted, binary, generated, vendored files and lockfiles unless
   explicitly included. Consumers and covering tests may be read; editing
   them outside the scope needs approval. New non-ignored files are included.
4. Pass the approved paths on every `scan`/`check`/`fix`; `paths:["."]` only
   for an explicitly requested whole project.
5. For large scopes, review bounded partitions once. Preserve their
   completion state; report blocked partitions without restarting completed
   work.
6. Read per-rule and per-directory counts first, then page only relevant rows
   with `tidy action:'results'` filters. Truncation, timeouts, or scope
   leakage mark that partition **unfinished**, not clean. Blocked checks stop
   dependent edits only.

## 3. Deterministic layers
1. `tidy action:'scan'` first (languages, engines used/missing,
   `installHint`). Scan never downloads.
2. Downloads are automatic under the default `auto` policy. Only when
   `tidy.downloads` is `ask` does a result carry `needsApproval`: ask once,
   listing engines and bytes, then re-call with `approveDownloads:true`.
3. Engines run only through `tidy` and are never installed by hand; report
   `installHint`. An ad-hoc `npx <engine>`, global binary, or package script
   is not verification. An engine `tidy` cannot resolve leaves its check
   blocked, never clean.
4. Plan with `fix` without `apply:true`. The dry run is diagnostics and
   candidate files, not a frozen patch. `structural:false` disables
   structural rules only. For a restricted focus, avoid a combined apply that
   touches unrelated code.
5. Apply with `apply:true` once the plan is settled, then review the actual
   changes; skip it when the dry run proposes nothing. Rules without a fix
   are diagnostics for the agent layer. Keep the engine pass a distinct change
   set from semantic edits. On engine or structural failure, truncation, or a
   rejected edit, stop affected writes; a partial result is not success.

## 4. Agent-level cleanup
Read `references/agent-cleanup.md` (ladder, lenses, slop, risk tiers); also
`references/test-suite-slop.md` when tests are in scope, and
`references/cleanup-report.md` for the report.

1. **Pin behavior (read-only).** Find the source-text guards a planned move
   can affect (procedure in `agent-cleanup.md`). A unit whose touched behavior
   no test covers gets only SAFE changes; report it instead of adding tests.
2. **Ladder, then lenses.** Run the deletion ladder on each selected source
   unit, then the lenses on the survivors. Engine diagnostics point at units;
   they do not define coverage. Findings need path+symbol evidence; drop the
   rest. Use history only when code, contracts, and tests leave intent
   unclear; unresolved intent blocks deletion.
3. **Apply by tier.** SAFE as one batch; CAREFUL one source unit at a time,
   each wired into its callers (never leave a new module nothing imports);
   RISKY is reported with its evidence and applied only after the user
   approves that item. Dead code follows
   `references/dead-code.md`.
4. **Stop rules.** Follow the shared verification budget. Report correctness
   defects and changes beyond cleanup scope; do not fix them here. When
   principles cannot pick between two rewrites, apply neither and record both.

Structural signals (file > 1,000 lines, function > 50 lines or nesting > 3,
duplicated small helpers, history comments, exported underscore names) are
leads, not candidates: act only on a named symptom. Do not improve names,
control flow, or types beyond the ladder and lenses. A confirmed
responsibility-based split that preserves behavior and entry points is
CAREFUL; moving a whole body elsewhere or cutting it into numbered chunks
resolves nothing.

## 5. Verify
Use the shared evidence budget. Run scoped `tidy check`; select behavioral
checks and typechecking only where the edits can invalidate their contracts.
Reuse valid passes. Attribute failures from evidence, not from whether the
failing file was edited. A broken runner leaves its scope unverified; say so.
Skipped or failed checks never count as passed.

If checks fail and cannot be fixed, undo only this run's edits with targeted
patches, preserving prior or concurrent work. Never use `git checkout`,
`reset`, `restore`, or `stash` as rollback; if the edits cannot be separated
safely, leave them and report the blocker.

## 6. Keep: never remove or rename
- Validation and error handling at a trust boundary unless an adversarial test
  proves the guard redundant.
- Contracts: export names, routes, CLI flags, DB columns, config keys, event
  names, wire strings. A rename is RISKY even when the name is bad.
- Anything on the never-dead list in `references/dead-code.md`.
- An empty catch or ignored error that may be intentional: flag it.
- Complexity serving a current compatibility obligation, staged migration, or
  vendored-code isolation.
- Tool directives, public API docs, and security or compatibility
  explanations. Comments that may separate tokens or carry significant line
  breaks are left for manual review.
- The project's own idioms (`AGENTS.md`/`CLAUDE.md`/lint config) over generic
  ones; clarity over fewer lines.

## 7. Pitfalls
- Missing engine: `installHint` only; continue others; that check is blocked.
- User declines downloads: skip those engines and say so.
- Structural engine unavailable: `check`/`fix` fail with a rebuild remedy;
  `scan` still works. Retry with `structural:false`; missing structural
  matches are never clean.
- A dead-code scanner report is a candidate list, not proof.

## 8. Reporting
Report once, after the last partition, using `references/cleanup-report.md`,
with everything needing the user's decision in one list. Pause only for a
blocker or a required approval. No report file unless requested.
