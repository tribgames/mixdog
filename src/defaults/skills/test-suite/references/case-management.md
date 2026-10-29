# Test case management

Every test has an owner, a single contract and a lane. None of this belongs in a hand-written registry: hand lists
drift from the code. It is derived from where the file lives, its name and its
text, and `scripts/inventory.mjs` reports it.

## Where a test lives

- Beside the code it exercises, in the same area directory; the inventory's
  area is the path below the source root, two levels deep.
- One domain per file (`suite-design.md`).
- Cross-area contract suites live in their own directory and still run in CI.

## What the inventory reads

| Ecosystem | Test files found by | Skip records |
|---|---|---|
| JS/TS (`node:test`, Vitest, Jest) | `*.test.*`, `*.spec.*`, `*-test.mjs`, `__tests__/` | `skip:` option, `it.skip`, `xit`, `skipIf` |
| Python (pytest, unittest) | `test_*.py`, `*_test.py` | `pytest.mark.skip/skipif/xfail`, `unittest.skip*`, `pytest.skip` |
| Go | `*_test.go` | `t.Skip`, `t.Skipf`, `t.SkipNow` |
| Rust | `tests/` directories, files with `#[test]` or `#[cfg(test)]` | `#[ignore]`, `#[ignore = "…"]`, `cfg_attr(…, ignore)` |

Lane comes from a `.slow.`, `.live.`, `.e2e.`, `.integration.` or `.electron.`
name tag (JS/TS); everything else counts as fast. Vendored, build and cache
directories are skipped and links are not followed.

Skip kinds: `capability` (the reason names a missing platform, tool or
privilege; a conditional skip with no reason counts here), `tracked` (`#N`),
`untracked` (a defect-looking skip with no issue) and `expired` (`until
YYYY-MM-DD` in the past). Every kind but `capability` is a defect skip that
needs a fix; an issue number does not make it acceptable.

## Risk markers

| Marker | Meaning | Expected action |
|---|---|---|
| `timer` | Sleep, timeout or ticker in a test | Replace with a signal or fake clock unless time is the subject |
| `spawn` | Real child process | Keep only when the process is the subject; await exit |
| `port` | Listener on a fixed port | Bind port 0 |
| `clock` | Real clock read without a fake clock | Inject or fake the clock when the verdict depends on it |
| `source-text` | Reads source and matches its text | Rewrite at a runnable interface, or justify in the test |

A fake-clock library in the file clears `timer` and `clock`. Markers are
leads, not verdicts: a timer in a test about timers is correct.

## Audit report

One table per project: area, files, fast/slow counts, marker counts, defect
skips. Rank batches by: defect skips, fast-lane
files with `timer`+`spawn`, then the rest by area. The audit ends at the
report; fix only the batches the user picks.
