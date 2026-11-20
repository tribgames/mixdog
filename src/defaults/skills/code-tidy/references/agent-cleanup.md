# Agent-level cleanup

Owns the deletion ladder, lenses, slop categories, risk tiers and the
never-remove list. The skill body owns scope, order and approvals.

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

| Rung     | Question                                                                                          | Result                            |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| Delete   | Is there evidence the behavior is no longer needed (callers, requirements, flags, compatibility)? | remove the verified obsolete unit |
| Reuse    | Does a repo helper already do it?                                                                 | replaced by a call                |
| Platform | Does the runtime, stdlib, or an installed dependency do it?                                       | hand-rolled code replaced         |
| Simplify | It must exist; make it smaller                                                                    | proceeds to the lenses            |

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

| Category             | Flag                                                                                                                                                        | Keep                                                                                                   | Fix                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Comments             | every comment outside the keep list: restating the code, step narration, history or changelog notes, dividers, commented-out code, a comment the code contradicts, a TODO with no owner or issue, a justification of our own surprising code | license headers, directives, public API contract docs, issue or RFC links, behavior forced by an external dependency, platform, vendor or protocol, the source of a value the code uses | delete; in doubt, delete. Never shorten an unkept comment into a briefer justification: our own surprising code is the finding (rename, extract, retype). A kept comment keeps its facts in the fewest words; a "do not change" comment gets a proposed test or type that enforces it, applied only with approval |
| Over-defensive code  | checks on guaranteed values, try/catch around code that cannot throw, duplicated validation                                                                 | I/O handling, trust boundaries, a logging top-level catch                                              | remove when the edge or a type guarantees the value, or a test proves the guard redundant; changing which errors propagate is RISKY                           |
| Fake resilience      | a fallback turning missing input or failure into a plausible value; a catch that only rethrows or swallows                                                  | a default the contract names, documented retry or degraded mode                                        | remove only proven redundant behavior; changing the error contract is RISKY                                            |
| Heuristics | sniffing error or message text; special cases keyed on names, paths, vendors or versions; a fallback guessing the caller's intent; a threshold, limit, sleep or retry with no stated source | a documented format or a user-specified query; a limit whose source is named | decide on the exact signal (type, error kind, producer field, platform value) when within reach; a change to observable behavior is RISKY unless the current behavior is a shown defect; otherwise report what the signal needs |
| Excessive complexity | deep nesting, nested ternaries, long conditions, many params, clever one-liners, hand-rolled loops with an idiom, a long function doing several jobs                                            | a deliberately dense hot path                                                                          | guard clauses, early returns, lookup table, options object, extract by responsibility                                  |
| Needless abstraction, fragmentation | pass-through wrappers, single-use helpers that name no responsibility, speculative indirection, one responsibility spread over files or re-export-only modules, one decision repeated at call sites, a value converted back and forth                                                                                          | a real seam (tests, multiple implementers, framework boundary)                                         | inline or merge so each responsibility has one home, after the behavior boundary check                                                                               |
| Boundary violations  | wrong-layer imports, cycles, logic in handlers, reading another module's private state                                                                      | an established pattern                                                                                 | move to the owning layer; flag when unsure                                                                             |
| Dead code            | unused imports/locals/private functions, unreachable branches, debug leftovers                                                                              | the never-dead list                                                                                    | follow `dead-code.md`                                                                                                  |
| Duplication          | copy-pasted branches, two helpers doing one thing, redeclared types                                                                                         | similarity serving different intents                                                                   | consolidate only when intents match                                                                                    |
| Type escapes         | `any`, redundant coercions, a suppression (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `#[allow]`) of a rule that protects correctness or safety                                                                                            | an escape whose comment names the upstream bug                                                         | narrow with a guard or precise type; fix the warning or record why silenced                                            |
| Hardcoded config     | environment-specific URLs, ids, absolute paths                                                                                          | fixtures, docs, contract-fixed literals                                                                | use the project's config accessor; name the literal. A credential in source is a defect: report it                     |
| Placeholder naming   | `data2`, `tmp`, `handleStuff` on new code                                                                                                                   | the project's own idioms                                                                               | rename locals; an exported rename is RISKY                                                                             |
| Oversized modules    | files past the review threshold mixing responsibilities                                                                                                     | a cohesive module                                                                                      | split confirmed independent responsibilities; no `utils`/`common` dumps (see Structural findings)                      |

## Structural findings

Structure is judged, not only slop. Size thresholds (file > 1,000 lines,
function > 50 lines, nesting > 3), duplicated small helpers, history comments
and exported underscore names are leads: act only on a named symptom. A
structural finding needs path+symbol evidence of a concrete cost to a reader
or maintainer. Report few, high-conviction findings; do not pad with weak
ones. What counts:

- **Responsibility mixing** — a unit doing several independent jobs, or a
  file growing past 1,000 lines through such mixing. A change that pushes a
  file over that size is a presumptive structural defect unless the file is
  one cohesive responsibility.
- **Ad-hoc conditional in an unrelated flow** — a special case for one caller,
  feature or input threaded through a generic path. Name the owner that should
  hold it.
- **Unnecessary optionality** — optional parameters, fields or nullable
  returns that no caller varies, and `unknown`/`any`-typed or cast-heavy
  contracts where a precise type is available. Question each; a boundary that
  truly receives untyped input stays.
- **Wrong seam** — a split that moves a body elsewhere, cuts it into
  numbered chunks, or follows execution order with pieces that pass most of
  their state along resolves nothing; split by what each part owns.

Structural findings rank above cosmetic ones in every report. Applying them
stays under the tiers: a confirmed responsibility split that preserves
behavior and entry points is CAREFUL; anything touching a contract is RISKY
and waits for approval. Do not redesign on the skill's own authority.

**Reader benefit.** Each structural change states, in one line, what it takes
off the reader (a branch, a hop, a duplicate, a cast). If none can be stated,
do not make it; if one was made, revert it with a targeted patch. A large
reshape also needs an old-versus-new equivalence check (same inputs, same
outputs and errors) before it counts as done.

## Language-specific checks

- **Exhaustive switches (TypeScript and similar)** — a `switch` or branch
  chain over a union or enum should end in a default that assigns the value to
  `never` (or the language's equivalent), so adding a member fails the
  compile. Adding it is SAFE only where the member set is closed and the
  default currently does nothing observable; replacing a real fallback is
  CAREFUL.
- **Casts and escapes** — TypeScript `as` outside a validating boundary,
  non-null `!` the type could prove, `as` where `satisfies` checks; Rust
  `unwrap`/`expect` outside tests where the type could carry the guarantee,
  and `as` numeric casts that can truncate. Flag each; narrowing is CAREFUL.
- **Import placement** — imports sit at module top. An inline or dynamic
  import stays only with a comment naming the cycle or lazy-load reason that
  forces it; otherwise move it, after checking module initialization order
  (CAREFUL).

## Prose tells

Comments, docs and messages written on autopilot are slop even when accurate.
Flag: filler openers and closers, announcements of what follows, bold inline
labels in running prose, inflated words where a plain one fits, hedging
stacks, and symmetric lists of three added for rhythm. Fix by deleting or
rewriting plainly; keep facts, constraints and links.

## Whole-project runs

Pre-release, whole-project use is normal when the user names the whole
project: partition by directory and run the deterministic layers first.

Coverage comes from an inventory, not a sample. Per partition, list by tool
every file and function past the size thresholds and every comment block of
four or more lines, and give each entry a verdict from reading it: changed,
or kept with the reason. Heuristics and fragmentation have no size signal, so
each partition is searched for the slop-table patterns. An entry without a
verdict, a verdict from a name or size alone, or a search not run leaves the
partition unfinished. Each file has one owner, who reads it once with every
lens.

Then make one pass across partitions for what no single partition shows: two
implementations of one responsibility, copies of a helper that drifted apart,
one pattern written several ways, names and idioms that disagree between
modules. An upcoming release is no reason to defer SAFE or CAREFUL items; only
RISKY waits for approval. The release blocker list is the RISKY and defect
sections, not the nits.

## Keep: never remove or rename

- Validation and error handling at a trust boundary unless an adversarial test
  proves the guard redundant; an empty catch or ignored error that may be
  intentional is flagged, not removed.
- Contracts: export names, routes, CLI flags, DB columns, config keys, event
  names, wire strings. A rename is RISKY even when the name is bad.
- Anything on the never-dead list in `dead-code.md`.
- Complexity serving a current compatibility obligation, staged migration, or
  vendored-code isolation.
- The comment keep list (slop table, Comments) and security or compatibility
  explanations; comments that may separate tokens or carry significant line
  breaks go to manual review.
- A kept comment's facts (a measured value, a platform quirk, a protocol
  rule) survive any rewrite; compare each rewritten comment with what
  remains.
- The project's own idioms (`AGENTS.md`/`CLAUDE.md`/lint config) over generic
  ones; clarity over fewer lines.

## Risk tiers

| Tier    | Meaning                                                                                                                                   | Handling                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| SAFE    | equivalence established, including initialization                                                                                         | apply as one batch                                                       |
| CAREFUL | same semantics, structure changes (local rename, guard clause, verified inlining, helper extraction, responsibility split, consolidation) | one source unit at a time, including required new modules                |
| RISKY   | may change behavior or a contract (public rename, error-handling or concurrency change, shared-infrastructure fix)                        | report with test coverage status; apply only the items the user approves |

When lenses disagree: correctness > the user's focus > readability and reuse >
micro-performance. Between two defensible rewrites, apply the one touching
less code and record the alternative; if principles cannot separate them,
apply neither.
