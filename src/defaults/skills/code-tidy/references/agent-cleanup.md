# Agent-level cleanup

Owns the deletion ladder, lenses, slop categories, and risk tiers. The skill
body owns scope, order, approvals, and the never-remove list.

## Behavior boundary

Classify risk by evidence, not syntax. Equivalence includes observable outputs
and errors, side effects and module initialization, and any call identity,
receiver, or ordering consumers rely on. Removing an unused binding can remove
initialization; inlining a wrapper can change its call contract.

Establish equivalence from current callers, contracts, and tests that exercise
the affected behavior. An intended change to failures, returned values,
compatibility, or concurrency is RISKY: report it as a separate correction.

**Source-text guards.** Some tests assert on source text rather than behavior
(file reads of source paths, `indexOf` ordering chains, identifier-absence or
literal-presence assertions), so a move breaks them without changing behavior.
Search only for guards a proposed move can affect, and record what each pins.
Moving code across such a guard is a contract change, not a tidying.

**Dependency arrays.** A suspected correctness defect is outside cleanup;
report its evidence without changing behavior.

## Deletion ladder

Run on each selected unit before looking for smells; only code that lands on
the last rung goes on to the lenses.

| Rung | Question | Result |
|---|---|---|
| Delete | Is there evidence the behavior is no longer needed (callers, requirements, flags, compatibility)? | remove the verified obsolete unit |
| Reuse | Does a repo helper already do it? | replaced by a call |
| Platform | Does the runtime, stdlib, or an installed dependency do it? | hand-rolled code replaced |
| Simplify | It must exist; make it smaller | proceeds to the lenses |

## Lenses

Use the lenses to identify supported improvements within scope; stop
investigating a candidate when its disposition is established. Each lens may
search the whole repository for evidence; a finding without a path+symbol
pointer is dropped. Judge units in full context, not only recently edited
lines, and never widen the edit scope to consumers. Skip lenses the user's
focus excludes.

- **Reuse** — new code duplicating an existing utility, constant, guard, or
  installed library. Name the existing thing.
- **Quality** — redundant or derivable state, parameter sprawl (a boolean
  selecting between behaviors), copy-paste-with-variation, leaky abstractions,
  stringly-typed code where a constant or registry exists, slop below.
- **Efficiency** — redundant work, repeated reads, N+1 access, needless
  sequencing, leaks, existence pre-checks instead of handling the error. Apply
  only when equivalence is obvious; otherwise report it.
- **Altitude** — a fix applied too shallowly: a caller-specific branch in a
  generic path, a symptom patched at one site, a workaround on a workaround.
  Name the deeper fix; when it exceeds the cleanup, report it as its own task.

## Slop categories

| Category | Flag | Keep | Fix |
|---|---|---|---|
| Comments | restating the code, step narration, history or changelog notes, dividers, commented-out code, a comment the code contradicts, a TODO with no owner or issue | a non-obvious why (external constraint, invariant, tradeoff), directives, public API docs, issue links | delete or correct; a "do not change" comment gets a proposed test or type that enforces it, applied only with approval |
| Over-defensive code | checks on guaranteed values, try/catch around code that cannot throw, duplicated validation | I/O handling, trust boundaries, a logging top-level catch | remove only when a test proves the guard redundant; changing which errors propagate is RISKY |
| Fake resilience | a fallback turning missing input or failure into a plausible value; a catch that only rethrows or swallows | a default the contract names, documented retry or degraded mode | remove only proven redundant behavior; changing the error contract is RISKY |
| Excessive complexity | deep nesting, nested ternaries, long conditions, many params, clever one-liners, hand-rolled loops with an idiom | a deliberately dense hot path | guard clauses, early returns, lookup table, options object, extract by responsibility |
| Needless abstraction | pass-through wrappers, single-use helpers, speculative indirection | a real seam (tests, multiple implementers, framework boundary) | inline after the behavior boundary check |
| Boundary violations | wrong-layer imports, cycles, logic in handlers, reading another module's private state | an established pattern | move to the owning layer; flag when unsure |
| Dead code | unused imports/locals/private functions, unreachable branches, debug leftovers | the never-dead list | follow `dead-code.md` |
| Duplication | copy-pasted branches, two helpers doing one thing, redeclared types | similarity serving different intents | consolidate only when intents match |
| Type escapes | `any`, unexplained ignores and suppressions, redundant coercions | an escape whose comment names the upstream bug | narrow with a guard or precise type; fix the warning or record why silenced |
| Hardcoded config | environment-specific URLs, ids, absolute paths, unnamed thresholds | fixtures, docs, contract-fixed literals | use the project's config accessor; name the literal. A credential in source is a defect: report it |
| Placeholder naming | `data2`, `tmp`, `handleStuff` on new code | the project's own idioms | rename locals; an exported rename is RISKY |
| Oversized modules | files past the review threshold mixing responsibilities | a cohesive module | split confirmed independent responsibilities; no `utils`/`common` dumps |

## Risk tiers

| Tier | Meaning | Handling |
|---|---|---|
| SAFE | equivalence established, including initialization | apply as one batch |
| CAREFUL | same semantics, structure changes (local rename, guard clause, verified inlining, helper extraction, responsibility split, consolidation) | one source unit at a time, including required new modules |
| RISKY | may change behavior or a contract (public rename, error-handling or concurrency change, shared-infrastructure fix) | report with test coverage status; apply only the items the user approves |

When lenses disagree: correctness > the user's focus > readability and reuse >
micro-performance. Between two defensible rewrites, apply the one touching
less code and record the alternative; if principles cannot separate them,
apply neither.
