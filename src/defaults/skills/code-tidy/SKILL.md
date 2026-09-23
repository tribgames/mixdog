---
name: code-tidy
description: Format, lint, apply structural rules, and clean up user-selected code with the tidy tool.
when_to_use: 'Tidy, format, lint, deslop, or clean up selected code, behavior unchanged; not features or bugs.'
metadata:
  requires: tidy
dependencies:
  tools:
    - type: tool
      value: tidy
---

# Code tidy (tidy tool)

Use the applicable layers, cheapest and safest first: project formatters and
linters through `tidy`, structural rule packs, then agent-level cleanup.
Every layer preserves behavior and public API; this is not a bug hunt.
The schema owns action fields; this file owns scope, order, and boundaries.

Investigate and clean the selected scope in approved partition-sized rounds,
then report the outcome. `references/agent-cleanup.md` owns candidate
tracking, risk classification, completion criteria, and the closing report.

## 1. Which job
**Hard rule — tidy owns format/lint/structure/cleanup, not feature work.**
New behavior, refactors that change a public API, and adding formatter configs
are not this skill. A correctness bug found while cleaning is reported under
"Bugs found", never folded into a cleanup edit.**Hard rule — never invent a formatter config**: a project that already has
Biome, Prettier, clang-format, rustfmt, gofmt, or equivalent keeps it. Do not
add or rewrite `biome.json`, `.prettierrc`, `.clang-format`, or similar unless
the user asks.**Mode**: `apply` unless the user asks to check, review, or "just report" —
report-only requests stay read-only across all layers and never edit; the report
lists what would change. Apply still follows the active workflow's approval rules.
**Focus**: an explicit restriction applies to every layer. "Formatting only"
excludes lint fixes and structural or semantic cleanup; "only dead code"
excludes unrelated formatting and refactoring. Skip unrelated investigations
and fixes, but retain checks needed to verify the requested work. If a tool
cannot isolate that operation, use evidenced targeted edits or report the
limitation and ask before widening the work.

## 2. Scope and investigation
1. **Get the scope from the user.** Accept named files, directories, a feature
   area resolved to confirmed paths, or an explicitly requested whole project.
   If absent or ambiguous, ask before scanning or editing. Never infer scope
   from recent changes, a diff, a branch, a commit, or session activity.
2. Recommend that the user commit their existing work before an apply run, so
   it starts from a clean checkpoint; do not commit for them or make this a
   requirement for read-only investigation. Use Git mainly for one initial
   status check and a final scoped diff. A dirty tree requires preserving the
   existing edits, not automatically stashing or discarding them.
3. Drop deleted, binary, generated, vendored files and lockfiles unless the
   user explicitly included them. Read and run direct consumers and covering
   tests as needed; editing them outside the selected area needs approval.
   New, non-ignored files are included without staging. Never widen the edit
   scope silently.
4. Pass the current round's approved paths on every `scan`/`check`/`fix`;
   use `paths:["."]` only for an explicitly requested whole project that fits
   one round. Result: every layer sees the same round scope, which the report names.
5. **Establish the baseline before any edit** with the narrowest documented
   tests and typecheck covering the current round's approved behavior. Reuse current results
   when their inputs have not changed. Record pre-existing failures separately.
   A broken runner blocks changes requiring it; continue independent work and
   report the blocked scope as unfinished.
6. **Complete read-only investigation per round before cleanup.** Partition
   scopes too large for one review (an explicitly requested whole project or
   several directories) by directory or responsibility. Each partition is one
   round: deterministic check on its paths (or the dry-run plan in section 3)
   → deletion ladder → lenses → apply by tier → verification → round close.
   - **Size each partition so one round can actually finish it.** The round
     owes the ladder on every source unit in the partition and the lenses on
     every survivor; a partition that cannot get that pass is too big, so split
     it further before starting. Hundreds of files in one partition is the
     usual failure.
   - **Run the partitions one at a time, and the whole set through to the
     end.** Start the next partition as soon as the current round closes.
     Never run two partitions concurrently, including when rounds are
     delegated: concurrent edits make each round's verification unattributable.
     Each round declares the test lane it uses (runner plus paths); two rounds
     must never share a lane that cannot run concurrently, because a
     load-sensitive suite then fails for a reason neither round owns.
     Do not pause for user input between rounds — section 7 owns reporting.
   - **More than one partition runs under a Goal.** Record the partition list
     and the accumulating candidate inventory as durable tasks
     (`goal-management`), so the remaining partitions and IDs survive turn
     boundaries instead of being rebuilt from scratch.
   - Finish all applicable read-only checks and lens analysis for the current
     round before its edits, not for the whole scope. Accumulate registered
     candidates across rounds using `references/agent-cleanup.md`.
   - Read per-rule and per-directory counts from check/fix/results first;
     select the rules and directories relevant to this round, then page only
     those with `tidy action:'results'` filters. Read every selected page of the
     current round's cached run before another check/fix replaces it. Never
     page a whole-project run row by row or treat unreviewed in-scope results
     as clean. Pagination is not engine truncation; do not rerun engines just
     to see remaining rows.
   - Actual engine truncation, timeouts, failed diagnostic checks, or scope
     leakage mark the affected partition **unfinished**, not clean; they do
     not invalidate other partitions.
   - Blocked checks stop dependent edits; continue only approved independent
     work and report the unfinished portion.

## 3. Deterministic layers
1. `tidy action:'scan'` first: languages and engines (used / missing /
   `installHint`). Scan never downloads and never returns `needsApproval`.
2. **Hard rule — downloads are automatic under the default `auto` policy;
   only when the user set `tidy.downloads` to `ask` does a result carry
   `needsApproval` — then ask once**, list engines and bytes, and re-call
   that action with `approveDownloads:true`.3. **Hard rule — engines run only through tidy, and never get installed by
   hand** (rustfmt, gofmt, dart, swift, zig, mix, dotnet): report
   `installHint`. Managed engines download only through tidy (`auto`,
   `approveDownloads`, or `action:'install'`). An ad-hoc `npx <engine>`, global
   binary, or package script is not verification — the name can resolve to an
   unrelated package and report a false clean. An engine tidy cannot resolve
   leaves its check blocked, never clean.4. Plan the approved deterministic work with `fix` without `apply:true`;
   do not repeat an equivalent `check` first. Use one combined plan when both
   engines and structural rules are in scope:
   - `structural:false` disables structural rules, not engine lint fixes.
   - `structural:true` (the default) runs ordinary engines as well as rules;
     it is not a structure-only pass. Do not precede it with a redundant
     engine-only pass. The current tool has no structure-only selector.
   - For restricted work, follow the Focus boundary above rather than using
     a combined apply that also changes unrelated code.
5. Treat the engine dry run as diagnostics and candidate files, not a preview
   of the exact resulting patch. Apply recalculates work; it does not replay a
   frozen preview. If inputs or approved operations change before writing,
   refresh the affected plan. Use `apply:true` only after the current round's
   complete plan is approved, then review the actual changes against that scope.
6. A dry run with no proposed fixes skips apply. Rules without a fix
   (`no-empty-catch`, `no-nested-ternary`, `no-any-cast`,
   `no-boolean-literal-compare`, `no-debug-statement`, `todo-marker`) are
   diagnostics for the agent layer, not changes. Skip a layer the scan shows
   has nothing to do. Keep the engine pass separable from the agent edits: a
   reformat folded into semantic changes makes the diff unreviewable, so
   report them as distinct change sets.
   Stop affected writes on an engine or structural failure, truncation, or
   rejected edit; a partial result is not success. Do not retry unchanged input
   or apply findings from the failed portion of the plan.

## 4. Agent-level cleanup
Read `references/agent-cleanup.md` first: it owns the deletion ladder, the
lens checklists, the slop categories, the risk tiers, candidate inventory
definitions, and the final report template. This section owns the order.

1. **Lock behavior.** Use the baseline established in section 2. A file with no test covering
   the behavior you will touch gets either the narrowest regression test that
   pins its observable output, or only SAFE-tier changes — say which. Prose
   files (skills, prompts, docs) have no behavior to pin.
   Before extracting or moving anything, search the test suite for guards that
   pin source text — tests reading source files as text, asserting statement or
   call ordering, or restricting where an identifier may appear — and record
   what each pins (`references/agent-cleanup.md` lists the shapes). A partition
   whose guards were not searched does not start extracting.
2. **Ladder, then lenses.** Run the deletion ladder on every selected source unit
   in the current round; only survivors go through the four lenses (reuse,
   quality, efficiency, altitude). Engine diagnostics point at units; they never
   define the round's coverage. A round that reviewed only the units an engine
   flagged is **unfinished**, not complete: say so in its close and name what
   stayed unreviewed. Every finding carries `file:line` evidence, a cost, an action, a
   confidence, and a risk tier; findings without evidence are dropped, and
   consult history only when code, contracts, and tests leave intent unclear;
   `git blame` is not a mandatory step for each removal. Unresolved intent
   lowers confidence and blocks deletion, rather than justifying it.
   The four lenses run over the ladder survivors and yield one merged,
   deduplicated finding list.
3. **Execute in approved bounded rounds.**
   - Use the partitions from section 2; accumulate the inventory across rounds,
     close each round with its brief note, and start the next partition
     immediately.
   - Within one file or module, CAREFUL source units must be edited
     sequentially. A round cut off mid-unit ends with that unit finished and
     wired into its callers, or reverted: never leave behind a new module
     nothing imports.
   - Apply by tier: SAFE as one batch; CAREFUL one source unit at a time; RISKY
     reported, never auto-applied. Within a tier: comments → dead code →
     defensive code → duplication → complexity → abstraction → performance.
     Use targeted checks at meaningful behavior boundaries and run the
     documented final tests/typecheck once after the round. Do not rerun
     unaffected checks after every comment or mechanical edit.
   - Structural items from the table below are CAREFUL unless their row says
     otherwise; dead code follows
     `references/dead-code.md`.
   - After the last tier lands in a round, re-run `tidy check` over the same
     paths once: removals leave new unused imports and newly orphaned helpers
     behind. Apply only SAFE findings from that cascade pass and add any
     remaining findings to the inventory — one pass, never a loop.
4. **Stop rules.** Three failed attempts on one file → stop and escalate with
   what was tried. A deeper fix larger than the cleanup → report it as its own
   task. Principles cannot pick between two rewrites → apply neither, record
   both.

The following are investigation signals, not registered candidates or permission
for an automatic rewrite; `references/agent-cleanup.md` owns registration.

| Structural signal | Decision |
|---|---|
| File > 1,000 lines | Identify separable responsibilities and verify the cost of splitting |
| Function > 50 lines, or nesting > 3 | Below roughly 100 lines, length alone is not a reason to act: name the symptom (duplication, a defect, demonstrated difficulty of change) or leave it. Above it, confirm mixed responsibilities or avoidable nesting before extracting |
| Duplicated small helpers across files | Consolidate only when intent and behavior match |
| Comments describing history (`extracted verbatim`, `moved from`, `behavior-preserving move`) | Remove only when no protected content or parsing behavior is lost |
| Underscore-prefixed names exported across modules | Treat a rename as a RISKY contract change; report, never auto-rename |
| Dead code / unused exports | Verify through the dead-code procedure before removing |

Do not "improve" names, control flow, or types beyond the ladder, the lenses,
and this table.

Size alone neither mandates a split nor makes one RISKY. A confirmed
responsibility-based split preserving behavior and entry points is CAREFUL:
extract one source unit at a time with its required modules, and verify direct
consumers. An extracted unit takes only the values it reads — a parameter it
never uses is a defect, and the call site stops passing it. Moving the entire
body elsewhere or cutting it into numbered chunks does not resolve the finding.
An unperformed confirmed split stays unfinished.

## 5. Keep — never remove or rename
- Validation and error handling at a trust boundary (user input, external
  API, file, network) unless an adversarial test proves the guard redundant.
- Export names, API routes, CLI flags, DB columns, config keys, event names,
  wire strings — contracts; a rename is RISKY even when the name is bad.
- Anything on the never-dead list in `references/dead-code.md`.
- An empty catch or ignored error that may be intentional — flag it.
- Complexity serving a current compatibility obligation, staged migration,
  or vendored-code isolation. Use the legacy retirement procedure in
  `references/dead-code.md` before treating an old path as obsolete.
- License, copyright and SPDX notices; compiler, linter and bundler directives;
  public API documentation; security and compatibility explanations. A history
  phrase alone is not permission to remove attribution. Embedded block comments
  may separate tokens or carry significant line breaks: leave them for manual
  review, and preserve parsing and behavior when editing any comment.
- The project's own idioms: `AGENTS.md`/`CLAUDE.md`/lint config beat a
  generic idiom; clarity beats fewer lines; nested ternaries are flattened,
  never introduced.

## 6. Pitfalls
- Missing toolchain engine → `installHint` only; continue other engines and
  report that engine's check as blocked, not clean.
- User declines downloads → skip those engines; say so.
- Tests/typecheck fail after apply → stop and undo only this run's edits with
  targeted patches while preserving prior or concurrent work. Never use
  automatic `git checkout`, `reset`, `restore`, or `stash` as rollback. If the
  edits cannot be separated safely, leave them intact and report the blocker.
  Do not continue until the affected verification is green again.
- Formatter config missing and the user did not ask to add one → tidy
  defaults / detected engines; never write a config file.
- Structural engine unavailable (missing or outdated mixdog-graph) → `check` /
  `fix` fail with a rebuild remedy; `scan` still succeeds and names the binary
  in `notes`. Retry with `structural:false` for formatters/linters only; never
  treat missing structural matches as clean. A per-language rule-pack error
  leaves only that language's structural pass unfinished; results for other
  languages and engines remain usable.
- A selected area too large for one review → default to directory or
  responsibility partitions for every layer, one complete round at a time.
  The inventory grows across rounds, not up front. Do not infer a smaller
  scope from a diff or ask for commits to divide the review.
- A dead-code scanner report is a candidate list, not proof → verify per
  `references/dead-code.md` before deleting.

## 7. Round close and final report
Close each round in the conversation with a few lines: the partition, its test
lane, what landed, the verification result including every check that could not
run, the round's function counts over 50, 100 and 150 lines, and whether the
round is complete or unfinished. Report all three counts: decomposition moves
mass downward, so functions over 100 falling while functions over 50 rise is
progress, and a single threshold hides it. Keep the inventory in `references/agent-cleanup.md` form as you go;
do not spend a full report on every round.

Deliver the full report once, after the last partition, using the
reconciliation, completion criteria, and report template in
`references/agent-cleanup.md`. It carries one consolidated list of everything
that needs the user's decision — RISKY findings, bugs found, unresolved intent,
unfinished candidates — so those questions arrive together at the end instead
of interrupting the cycle. Do not create a separate report file unless
requested.

Interrupt the cycle only for a blocker that makes continuing impossible or an
approval the active workflow requires.

## 8. References
- `references/agent-cleanup.md` — before section 4: ladder, lenses, slop
  categories with keep/fix rules, test-suite slop, risk tiers, final report
  template.
- `references/dead-code.md` — before removing any unused symbol, file, or
  dependency, or retiring a legacy path: candidate sources, usage and side-effect
  verification, compatibility retirement, never-dead list, removal order.
