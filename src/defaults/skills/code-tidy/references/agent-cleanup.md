# Agent-level cleanup

Read this before the agent-level layer of `code-tidy`. It owns the deletion
ladder, the lens checklists, what counts as slop, the risk tiers, and the
final report template. The skill body owns scope, order, approvals, and the list of
things that are never removed or renamed.

## Deletion ladder

Run the ladder on every changed unit (function, class, module, config knob)
before looking for smells. Only code that lands on the last rung goes on to
the lenses.

| Rung | Question | Typical win |
|---|---|---|
| Delete | Is the behavior needed at all? Speculative generality, a flag nobody sets, a branch no caller reaches | whole unit gone, tests that only guarded it gone with it |
| Reuse | Does a helper in this repo already do it? (`code_graph symbol_search`, `grep` for the pattern's distinctive call) | reimplementation replaced by a call |
| Platform | Does the stdlib, runtime, or an already-installed dependency do it? (`URLSearchParams`, `path.relative`, `Array.prototype.at`, `pathlib`, an imported util) | hand-rolled parser/formatter/debounce replaced |
| Simplify | It must exist here; make it smaller | proceeds to the lenses |

A unit replaced by one platform call is a larger and safer win than any
in-place cleanup; take it before analysing the unit's smells.

## Lenses

Each lens searches the codebase for evidence; a finding without a
`file:line` pointer is dropped. Run every lens unless the user named a focus.
Judge a changed line inside the function or class containing it, not inside
the diff hunk: four added lines are often the reason a 50-line function now
needs splitting.

**Reuse** — new code that duplicates an existing utility, constant, type
guard, or pattern: hand-rolled string/path manipulation, custom env checks,
ad-hoc validation, re-implemented parsing. Name the existing thing and where it
lives. Before flagging a new dependency import, check `package.json` /
`pyproject.toml` for a library already installed that covers it.

**Quality** — redundant state (values derivable from existing state, caches
that need not exist); parameter sprawl (a parameter bolted on where the
function should be restructured, a boolean parameter that selects between two
behaviors — split the function instead); copy-paste-with-variation; leaky
abstractions; stringly-typed code where a constant, enum, or registry exists;
slop patterns from the table below.

**Efficiency** — redundant computation, repeated file reads, duplicate API
calls, N+1 access; independent operations run sequentially; heavy work on
startup or per-request paths; existence pre-checks instead of doing the
operation and handling the error; unbounded growth, missing cleanup,
listener/handle leaks; closures capturing a whole scope for long-lived
objects; whole-file reads where a slice would do. Only apply an efficiency
change whose behavioral equivalence is obvious; never restructure an
algorithm with subtle correctness implications without a test that pins it.

**Altitude** — a fix applied too shallowly: a caller-specific branch added to
a generic path (`if (caller === X)`, a magic-value escape hatch); a symptom
patched at one call site while siblings keep the same flaw; a workaround
stacked on a workaround; a wrapper added to avoid touching the thing that
needs changing; a flag introduced to route around a broken default. Name
the mechanism the change is dodging and the deeper fix. When the deeper fix
is larger than the cleanup, report it as its own task instead of doing it
here.

## Slop categories

| Category | Flag | Keep | Fix |
|---|---|---|---|
| Obvious comments | restating the code, section dividers, commented-out code, vague TODOs, narration of the change or of the caller | WHY comments (business rule, workaround, invariant), ticket links, regex/algorithm notes, BDD markers, license/attribution notices, tool directives, public API docs | delete only with high confidence; preserve token boundaries and significant line breaks |
| Over-defensive code | null checks on guaranteed values, try/catch around code that cannot throw, type checks on statically typed params, defaults for required params, validation duplicated inside a boundary, broad catch-all | I/O error handling, nullable DB fields, a top-level catch-all that logs and rethrows | remove only when a test proves the guard redundant; narrow broad catches to the expected error |
| Fake resilience | a fallback that turns a missing input or a failed call into a plausible value (`?? 0`, an empty-object default, a stub record); a catch that only rethrows the same error; a catch that logs without the error and continues | a default the caller's contract names, a retry or degraded mode the docs describe | surface the failure instead: propagate the error or return the empty case the contract defines |
| Excessive complexity | nesting > 3, nested ternaries, 4+ predicates in one condition, > 5 positional params, functions > 50 lines doing several things, clever one-liners, a 4+ branch ladder comparing one value against constants, a hand-rolled loop the language has an idiom for (`for i in range(len(xs))`, an index loop over a collection, `count() > 0` for "any") | a hot path that intentionally uses a dense idiom | guard clauses, early returns, explicit if/else, an options object, a lookup table, the language's own idiom, extract by responsibility |
| Needless abstraction | pass-through wrappers, single-use helpers, speculative indirection, one-implementer interfaces that add no seam, factories that only call a constructor | abstractions that give a real seam (tests, multiple implementers, framework boundary) | inline |
| Boundary violations | wrong-layer imports, import cycles between modules, business logic in a handler, one module reading another's private state, side effects in a pure-named function | short-circuits already established as a pattern here | move to the owning layer; break a cycle by moving the shared piece out; flag when unsure |
| Dead code | unused imports/locals/private functions, unreachable branches, stale feature flags, debug leftovers, code removed but still referenced | whatever the dead-code procedure lists as never dead | remove through the dead-code procedure linked from the skill |
| Duplication | copy-pasted branches with trivial differences, two helpers doing the same thing, repeated literal sequences, one exported type or interface redeclared in several files | incidental similarity between things that serve different intents and may diverge | consolidate only when intents match |
| Type escapes | `as any`, `@ts-ignore`, `# type: ignore` without reason, a lint or compiler warning suppressed without one (`eslint-disable`, `# noqa`, `#pragma warning disable`), `object`/`Any` annotations where a union or Protocol fits, a value re-coerced to the type it already has (`String(s)` on a `string`) | an escape or suppression whose comment names the upstream bug it works around | narrow with a guard, a precise type, or `unknown` plus a check; drop a coercion the type already guarantees; fix the warning or record why it is silenced |
| Hardcoded config | environment-specific URLs and endpoints, provider/account/project ids, absolute paths and path strings spliced with `/`, a literal branch for one caller or one environment, unnamed numeric thresholds | test fixtures, documentation examples, a literal the contract itself fixes (wire strings, protocol constants) | read it through the project's existing config or env accessor; name the literal. A credential in source is a bug — report it, never merely relocate it |
| Placeholder naming | numbered or filler names on new code (`data2`, `helper1`, `tmp`, `handleStuff`, a `Manager` holding two functions) | names the project's own idioms establish | rename locals after their intent; an exported rename is a contract change, so RISKY |
| Oversized modules | files well past the project's norm (the skill's 1,000-line threshold), mixing responsibilities | a self-contained single-responsibility script | split by what each part does; never `utils`/`helpers`/`common`/`part2` dump files |

## Test-suite slop

Only when tests are in scope. Tests accumulate through repeated
agent corrections the same way production code does:

- **Dominated tests** — several tests reach the same branch and the same
  result; one asserts the observable output, the others only check
  construction, type, or non-emptiness. Keep the strongest, delete the rest
  and the fixtures that served only them.
- **Accumulated regression tests** — a near-identical test appended after each
  correction, or parameter permutations whose values never cross a new branch,
  equivalence class, or failure mode. Keep the smallest set that still covers
  distinct regressions, and a permutation only where it marks a real boundary.
- **Tautological assertions** — assertions that cannot fail: `assert True`,
  two equal literals compared, a state the fixture itself guarantees, a mock
  verifying the setup that fed it. Delete, or rewrite against the observable
  result.
- **Verification theater** — checksums, receipts, validators, or
  recomputation where producer and verifier share the same information and
  failure domain. They cannot fail independently; delete.
- **Closed justification loop** — a fallback exists because a test exercises
  it and the test exists because the fallback was added. Neither is evidence
  for the other; delete the pair. A test of a distinct externally observable
  rejection, error, or compatibility behavior is *not* a loop — it is that
  behavior's clearest specification, keep it.
- Reducing tests never justifies changing the production behavior they
  exercised; that needs its own evidence (a current requirement, a real
  caller, a spec).

## Candidate inventory and risk tiers

All candidates gathered during the read-only investigation are tracked in an
explicit candidate inventory using stable candidate IDs:

```text
[ID] file:line → problem → cost (what it duplicates, wastes, or makes harder) → planned action | tier: SAFE/CAREFUL/RISKY | confidence: high/medium/low | status: completed/kept/unfinished | verification: <test/check>
```

- **Stable IDs & Grouping**: Assign stable IDs (e.g. `C-01`, `C-02` or `MOD-01`).
  When multiple locations share an identical root cause (e.g. an unused helper
  referenced across three call sites, or repeated boilerplate), group them under
  one ID without losing individual `file:line` member locations. Counts track
  candidate IDs, not raw diagnostics or individual member locations.
- **Origin tracking**: When code moves during extraction or splitting, retain
  the origin candidate ID and record the new target location under that ID.
- **Candidate classification**: Distinguish raw mechanical threshold hits (e.g.
  files > 1,000 lines, functions > 50 lines) from confirmed changes vs Keep
  decisions. A mechanical threshold hit is an investigation candidate, not
  automatically a bug, but each hit requires a planned action, an evidenced Keep
  under the skill's keep rules, or an unfinished status with a concrete blocker.
  Generic cohesion is not a waiver.
- **Cost, Confidence & Nits**: A finding that cannot name its cost is a nit. Once
  registered in the inventory, a verified nit or false positive is marked `kept`
  with the recorded reason—never silently erase an ID. An unresolved finding
  remains `unfinished`; uncertainty is not evidence for keeping it. Confidence is `low` when
  current code, callers, contracts, and tests do not explain why the code exists.
  Consult history only to resolve a specific remaining question. Medium/low
  confidence candidates stay unfinished until that question is resolved; apply
  approval does not authorize guessing that they are safe to delete.
- **Statuses & Reconciliation Invariants**:
  - `completed`: verified done, with evidence of what and how changed.
  - `kept`: preserved with concrete evidence (documented keep rule, external contract, or registered nit).
  - `unfinished`: work remaining, with substatuses: `pending`, `in_progress`, `blocked`, `deferred`, or `unverified`.
  - Backlog integrity: retain the complete initial inventory across rounds; newly discovered candidates are appended with new IDs.
  - Formula: `Total Candidate IDs = Completed + Kept + Unfinished Remaining`. Counts must reconcile exactly.

| Tier | Meaning | Examples | Handling |
|---|---|---|---|
| SAFE | provably no behavior change | unused import, commented-out code, pass-through wrapper, redundant type assertion, obvious comment, history comment | apply as one batch; verify the affected behavior without repeating unchanged checks |
| CAREFUL | same semantics, structure changes | rename a local, flatten a ternary, guard clause, extract a helper, split responsibilities while preserving entry points, consolidate duplicates, name a magic number | apply one source unit at a time (including required new modules); targeted verification at behavior boundaries, final checks once; undo only this run's edits on failure |
| RISKY | may change behavior or a contract | public API or export rename, route/DB column/config key rename, error-handling change, concurrency change, N+1 restructuring, altitude fix in shared infrastructure | report only, with the test coverage status; never auto-apply |

Conflict resolution when lenses disagree: correctness > the user's stated
focus > readability and reuse > micro-performance. When two defensible
rewrites of the same region remain, apply the one that touches less code and
record the alternative; when the principles cannot separate them, apply
neither and record both.

## Small tidyings (CAREFUL tier)

Structure-only moves the slop table does not already cover: normalize two
variants of the same pattern to one form; put coupled functions next to each
other; declare a variable where it is initialized; blank line between chunks
that do different things; merge over-fragmented pieces back into one readable
block before re-splitting. One tidying per change set.

## Final report template

This is the shape of the closing reply to the user after each round. It is
written in the conversation, not to a file, unless the user asks for a
document.

```text
Scope: <user-selected paths | explicit whole project> · Mode: report|apply
Round: Round <N> <completed|partial> · Overall: <complete|partial>
Inventory: Total <N> · Completed <X> · Kept <Y> · Unfinished <Z> (X + Y + Z = N)
Stages: baseline / engines / structural / ladder + lenses / tiered changes / final verification
  <stage>: completed <evidence> | not applicable <reason> | unfinished <blocker>
Baseline: tests <green|N pre-existing failures excluded> · typecheck <ok|…>
Deterministic: engines used/missing · files changed · diagnostics remaining · structural matches applied/skipped

Completed (what changed and how)
  [ID] path/file.ts:line
    ✓ [Quality/SAFE]   removed comment narrating the change (L31) → deleted redundant comment
    ✓ [Reuse/CAREFUL]  replaced manual join with `joinPath` from src/shared/path.mjs (L53) → consolidated helper

Kept / Not Applicable (evidenced)
  [ID] path/file.ts:line
    - [Keep/Contract]  public export `parseConfig` kept (L12) → external contract
    - [Keep/Rule]      file > 1,000 lines kept intact (L1) → self-contained single-responsibility script under the Oversized modules keep rule

Unfinished (remaining candidates)
  [ID] path/file.ts:line
    ☐ [Structure/CAREFUL] split handler responsibility (L105) · Status: pending|in_progress|blocked|deferred|unverified
      Remaining: extract auth sub-handler · Reason: waiting for auth test fixture · Next: Round <N+1>

Noticed but not applied (report-only or out of scope)
  ⚠ [Altitude/RISKY] special case for caller X in src/core/run.mjs:88 — deeper fix: default in run() · coverage: none
  ⚠ [Quality]        two equal rewrites of parseInput (L70-74); principles could not decide

Deferred debt: <`debt:` markers added, with their ceiling and trigger>
Bugs found (not fixed here): <correctness issues surfaced while cleaning>
Verification: tests <passed/failed/skipped/baseline-excluded counts> · typecheck <result> · lint <remaining diagnostics>
Next round: <scope and IDs planned for next round, or none if overall complete>
```
