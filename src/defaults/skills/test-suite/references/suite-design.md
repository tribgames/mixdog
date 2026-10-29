# Suite design

How a suite stays small, fast and honest. Apply when writing, placing or
reviewing tests.

## A good test

- **Names the break.** Before writing, state the production change that should
  make it fail, and whether that change is a bug or a decision. Cannot name
  one → redesign around an observable behaviour.
- **Independent expected value.** A literal or hand-checked fixture, never a
  value recomputed with the code under test or its helpers.
- **No change detectors.** If only intentional decisions can fail it (a
  constant, exact message wording, private structure), test the behaviour that
  depends on the decision instead.
- **Your code, not the framework's.** Test the contract at your boundaries;
  trivial getters and forwarding earn tests only when they validate,
  normalize, derive or cause side effects.
- **Through the interface.** Mock only at system boundaries (network, clock,
  randomness, slow or external stores), never your own modules; pass
  dependencies in so a boundary is easy to replace.
- **One behaviour per test**, small enough that a failure points at one cause.
  Write one test at a time, as needed; never bulk-generate cases.

## One invariant, one owning test

Two tests asserting the same contract drift apart instead of reinforcing each
other: when the contract changes, one is updated and the other keeps asserting
a retired behaviour. Name an owner per contract; every other test covers a
distinct observable boundary. When an overlap appears, reduce both to what is
distinct, or keep the owner and move the unique cases into it.

## Text matching is a last resort

Asserting against source text pins names, spacing and constants instead of
behaviour. It breaks on harmless refactors and passes on wrong behaviour, so it
proves neither direction. Reserve it for artifacts with no runnable surface
(generated scripts, workflow YAML, prompt text) or for ordering invariants in
code a test cannot import (a guard must precede a send), and say why in the
test. Keep the list of such files short and known.

## A contract suite must run in CI

A suite that asserts a contract but runs nowhere automatic is documentation
with an expiry date: nothing forces it to follow the code, and it fails the
first time someone runs it. Make it discoverable like every other test and give
it a CI job. Checks that need a built artifact run after the build step, not
nowhere. Scripts that are not test files (smoke scripts, harness runners) get a
scheduled sweep that enumerates them, so new ones join automatically and stale
exclusions fail closed.

## One domain per file

A multi-domain test file makes every change pay a whole-file search. Split when
one change forces a search across domains, not on line count alone; shared
fixtures move into a helper beside the files. One stateful fixture chain over
one domain stays one file whatever its length.

## Slow work gets its own lane

A test over roughly ten seconds alone goes to a slow lane marked by name,
directory or tag, whichever the runner selects on. It still runs in CI, in a
parallel job, so the gate takes the longer of the two instead of their sum.
Tests that need a built artifact or a live system get a live lane. If a file
is slow only in a full run because processes contend, the cause is contention,
not a slow file: Diagnose, do not move it.

## Selection beats retries

During a change run the files that reach the changed code (the project's
changed-files selection, a path or name filter, a single test id). The full
lanes gate the push. A suite that takes minutes is a design problem to fix by
selection and sharding in CI, not by waiting on the user's machine.

## Published artifacts carry no tests

Check that packaging excludes test sources, and that test-only changes do not
invalidate caches keyed on the shipped files.