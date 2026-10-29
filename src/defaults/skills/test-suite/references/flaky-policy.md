# Flaky-test policy

## Rules

1. **Zero flakes.** A test that passes and fails on the same code is a defect.
   CI never retries automatically, and a passing rerun clears nothing.
2. **Fix, never skip.** Fix the cause, or move a correctly slow test to the
   slow lane. A failure that cannot be fixed now is reported; skipping it is
   the user's decision, never the agent's.
3. **Capability skips only.** A skip states the capability the platform or
   machine lacks (a tool, an OS feature), never a defect.
4. **Evidence over memory.** Decide from the failing log and CI history, not
   from "it is always flaky". Keep both the failed and the passing log.
5. **No local stress.** Reproduction happens through a deterministic trigger
   in the test, or in CI history; never by loading or looping on the user's
   machine.

## A flake report

When a flake is handed off, one tracked issue carries: the test and file, the
failing assertion and log, the platform and load conditions, when it first
appeared, how often in CI history, and the suspected cause with its evidence.
One issue per test, so ownership stays clear.

## Priority

Fix in this order:

1. Tests that block a release or a push.
2. Tests failing most often across recent CI runs.
3. Tests whose cause can also hit users (product races, localized output).
4. Everything else, batched by area.

## What does not count as a fix

- Raising a timeout to absorb a sleep, poll or production interval.
- Adding retries, a rerun-failed CI step, or a serial flag to hide contention.
- Skipping on a platform that has the capability.
- Deleting the assertion that failed.
