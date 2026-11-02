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

Read the mode's procedure before acting.

| Request | Mode | Procedure |
|---|---|---|
| Add a test, fix a bug test-first | Write | `references/write.md`; adding a new test area also `references/case-management.md` |
| Check a change while editing | Run | below |
| A test fails sometimes, only in a full run, only in CI, only on this machine | Diagnose | `references/diagnose.md` |
| Duplicate, dead, obsolete or worthless tests; any change that edits an existing test file | Prune | `references/prune.md` |
| Review the suite's health or a whole area | Audit | `references/case-management.md` |

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
- Never skip or disable a failing test: fix it, or report it and leave the
  decision to the user. Only a capability skip (a platform or tool the test
  needs is absent) is allowed, and its reason names that capability.
- Confirm by PID or command line that detached processes you started are gone:
  a load generator or server left detached outlives the agent and can freeze
  the machine. Nothing detached survives a report.

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

## Resources

- `references/reliability.md` — read when a test touches time, processes,
  ports, files, environment, locale or the platform, or when diagnosing.
- `references/flaky-policy.md` — read when a failure is intermittent.
- `references/suite-design.md` — read when writing a test, choosing its lane
  or file, or reviewing how a suite is organized.
- `scripts/inventory.mjs` — run for Audit; read-only, bounded, Markdown or
  `--json`.
