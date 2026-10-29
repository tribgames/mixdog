# Reliable tests

A test must give the same verdict alone, beside other suites, on a busy
machine, on a localized OS and in CI. Process isolation does not isolate
ports, paths, child processes, the clock or the host's language.

## Cause table

| Cause | Signal | Fix |
|---|---|---|
| Timing | Passes alone, fails when other work runs; a sleep or a fixed budget decides the verdict | Wait on the event, promise or state the code produces; fake the clock when time is the subject |
| Shared resource | Fixed port, fixed temp path, shared data dir, a leftover process | Bind port 0 and read the assigned port; a fresh temp dir per test; per-test data dirs |
| Unrestored global | Later tests change behaviour; order matters | Restore environment variables, working directory, timers, mocks and locale in a `finally`/fixture teardown right after the change |
| Platform / locale | Fails on another OS, language or console code page | Query structured sources; never parse localized tool text; remember Windows environment names are case-insensitive |
| Order | Depends on a previous test's state | Each test creates and removes its own prerequisites |
| Teardown | Next test sees a live child, open handle or locked file | Await child exit, server close and handle release before the test ends |

## Time

- A timeout only bounds a wait on a real signal; it never makes the assertion
  true. Keep the outer wait far larger than any deadline under test.
- When the deadline itself is the subject, inject or fake the clock and
  restore real time in teardown.
- Do not assert scheduler ordering unless the order is the product contract;
  place races with deferred promises at a chosen point instead.

## Processes and ports

- Count spawns: a process start costs tens of milliseconds on Windows and much
  more under load. Spawn once per file when the behaviour allows it.
- A test that starts a process owns its whole tree: kill it and await exit,
  detached children included, before the test ends.
- Prefer an in-process fake over a real server unless the real process is the
  subject.

## Files and environment

- Use a private temp root per test and remove it afterwards; never write into
  the user's home configuration or the repository tree.
- Windows releases handles asynchronously: a rename or delete right after a
  close may need a bounded retry sized to the observed contention.
- Point every home, data or cache directory variable the code reads at the
  test's own root.

## Proof

A reliability fix is proven by a deterministic trigger of the named cause
(held promise, fake clock, localized fixture, pre-bound port) that fails before
and passes after, not by repeating the test until it stays green.
