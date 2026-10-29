---
name: test-suite
description: Write, run, diagnose, prune and audit a project's tests without overloading the machine.
when_to_use: 'Write, fix, run, diagnose, prune or audit tests, flaky failures, suite health; not live UI checks.'
dependencies:
  tools:
    - type: tool
      value: read
    - type: tool
      value: shell
---

# Test suite

Owns how tests in any project are written, run during a change, diagnosed when
they fail intermittently, pruned and audited. The project's own
commands, lanes and conventions win over every default here; this skill
supplies the judgement and procedure around them. Driving a running app or
device by hand is outside it.

## Pick the mode

| Request | Mode |
|---|---|
| Add a test, fix a bug test-first | Write |
| Check a change while editing | Run |
| A test fails sometimes, only in a full run, only in CI, only on this machine | Diagnose |
| Duplicate, dead, obsolete or worthless tests | Prune |
| Review the suite's health or a whole area | Audit |

## Prerequisites: find the project's own way

Before the first run, look for the project's focused test command in this
order, and stop at the first source that gives it plus any constraint that
affects the change (lane, setup, needed service): `AGENTS.md` or `CLAUDE.md`,
`docs/testing*`, `CONTRIBUTING*`, package scripts (`package.json`, `Makefile`,
`pyproject.toml`, `Cargo.toml`), then CI workflows. Do not survey every
manifest or CI lane. Result: one focused command, copied from the project,
never invented; a broader command only when the change is broad. When nothing
is documented, fall back to the
runner's own selection: `node --test <file>`, `vitest run <file>`,
`jest <file>`, `pytest <file>::<test>`, `go test -run <Name> ./<pkg>`,
`cargo test <name>`.

## Machine rules

Tests run on the user's working machine. These hold in every mode.

- The Verification section of your system rules owns the evidence budget,
  reruns, fix attempts, heavy runs and stopping what you started; follow it.
- Never loop a test to "reproduce" flakiness here, and never shard in
  parallel locally; repetition belongs to CI history.
- Confirm by PID or command line that detached processes you started are gone.

## Write

What a change gets:

| Change | New tests |
|---|---|
| Bug fix | One regression test for the reported behaviour |
| New behaviour | One per observable behaviour the requirement names (its success and its stated rejections) |
| Refactor, rename, move | None; the existing tests must still pass unchanged |
| Removal | None; delete the removed behaviour's tests, never assert the absence |
| Docs, copy, style, config values | None |

Only a test owning a lasting contract joins the suite and its CI lane.
Reproductions, probes and one-off checks are scratch: they live in a temp
directory outside the repository, are never committed, and are deleted when
the task ends. A scratch reproduction that proves a bug becomes the
regression test above or is deleted, never both kept.

1. Name the behaviour and its owner: the one contract this test owns, beside
   the code it exercises. If a test already owns it, extend that test
   (`references/suite-design.md`). Result: one file and test name chosen.
2. Name the production change that would make the test fail; if you cannot,
   redesign it around an observable behaviour (`references/suite-design.md`).
   Write the test through the user's interface (caller, CLI,
   HTTP, rendered output) with the expected value from the requirement, not
   from running the code. For a new regression test, show it failing first:
   the failure names the missing behaviour. An existing failing test already
   counts as that evidence.
3. Apply `references/reliability.md` for any time, process, port, file,
   environment, locale or platform dependency. Result: no fixed sleep, no
   fixed port, no unrestored global, no host-locale assumption.
4. Make it pass with the smallest change, then rerun the same file. Result:
   a new regression test's fail-before and pass-after pair goes into the
   report. Add no further
   tests unless the user asks.
5. Put it in the lane its duration and needs call for (`suite-design.md`).

## Run

1. Run the covering file(s) only. Result: the selected count matches the files
   you meant.
2. On failure read the full log before editing; do not rerun to see if it
   passes.
3. Run a broader lane once after the last edit only if the change touches a
   shared contract or an integration point; otherwise stop at the covering
   file. Reuse an earlier pass only when no later edit touched the code it
   checks.
4. After two evidence-backed fix attempts, report what was tried and the log.

## Diagnose

An intermittent failure is a defect in the test or the product, never noise
(`references/flaky-policy.md`).

1. Collect evidence without reruns: the failing assertion, the full log, what
   else was running, the OS and locale. Result: the failing line and the
   condition it waited on.
2. Classify the cause with the table in `references/reliability.md`. Result:
   one named cause with the line that assumes it.
3. Propose the fix: in the test, or in the product when real users can hit
   the same race. A longer timeout, a retry or a skip is not a fix.

Diagnose ends at a report: cause, evidence, proposed fix. Only when the user
asked for a fix, apply it and prove it with the focused file plus a
deterministic trigger of the cause (a held promise, a fake clock, a localized
fixture), not by looping. It never becomes an open-ended fix loop. Never
skip or disable a failing test; when the fix cannot land now, report it and
leave that decision to the user. Only a capability skip (a platform or tool
the test needs is absent) is allowed, and its reason names that capability.

## Prune

First tell redundant coverage from removing a supported behaviour, and keep
distinct observable success, rejection, error and compatibility cases.
Removing a behaviour with its tests needs evidence independent of those tests
(current requirements, real callers, a specification); a test existing only
for a branch, or a fallback and test justifying each other, is no evidence,
and unresolved intent blocks deletion.

- Delete a test only when it is dominated (same branch and result as a
  stronger test), tautological (cannot fail), a permutation crossing no new
  branch, or verification theater (verifier and producer share one failure
  domain). Name the test that still owns the contract.
- Deleting a contract test needs the user's approval.
- Same contract owned twice → merge the unique cases into the owner at the
  user's interface.
- Asserts that something was removed, restates a constant, copies production
  logic or source text into the test, or pins internals no user observes →
  delete it, or rewrite it at the interface when a real contract is behind it.
- Passes only alone → Diagnose; never mark it serial to hide it.

Prune as you go: a change that touches a test file applies these rules to that
file only. A whole-suite sweep is an Audit the user asked for.

Result: each removal names the owning test that still covers the contract, or
states that the contract is gone.

## Audit

1. Run `node ${MIXDOG_SKILL_DIR}/scripts/inventory.mjs <project-root>`
   (`--json` for data). Result: per-area counts, lanes, languages, risk
   markers, and defect skips for JS/TS, Python, Go and Rust.
2. Read `references/case-management.md` and rank findings by impact: defect
   skips, risky markers in the fast lane, duplicate owners.
3. Report one table (area, finding, count, proposed action) and wait for the
   user's choice of batches. Audit ends at this report; fix only the batches
   the user picks, one or two at a time, each verified by its covering files.

## Pitfalls

- Parsing localized tool output (a console in another language, a busy host
  dropping rows) passed on the author's machine and failed elsewhere. Query a
  structured source.
- Fixed sleeps passed alone and failed in bulk when other work ran.
- A load generator or server started by an agent was detached, outlived the
  agent and froze the machine. Nothing detached survives a report.
- Render tests passed while the real screen hid a row: assert the rendered
  output, not the inputs.
- Full lanes that take many minutes fail under load; selection, not more
  retries, fixes that.

## Verification

- Write/fix: the focused file passes; a new regression test also failed
  before, and the report quotes both.
- Diagnose: the named cause and its evidence. Only when the user asked for a
  fix: the deterministic trigger and its passing run.
- Every mode: no process you started is still running.

## Resources

- `references/reliability.md` — read when a test touches time, processes,
  ports, files, environment, locale or the platform, or when diagnosing.
- `references/flaky-policy.md` — read when a failure is intermittent.
- `references/suite-design.md` — read when writing a test, choosing its lane
  or file, or reviewing how a suite is organized.
- `references/case-management.md` — read for Audit, or when adding a new
  area.
- `scripts/inventory.mjs` — run for Audit; read-only, bounded, Markdown or
  `--json`.
