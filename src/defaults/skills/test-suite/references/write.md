# Write a test

Read before adding a test or fixing a bug test-first.

## What a change gets

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

## Steps

1. Name the behaviour and its owner: the one contract this test owns, beside
   the code it exercises. If a test already owns it, extend that test
   (`references/suite-design.md`). Result: one file and test name chosen.
2. Name the production change that would make the test fail; if you cannot,
   redesign it around an observable behaviour. Write the test through the
   user's interface (caller, CLI, HTTP, rendered output) with the expected
   value from the requirement, not from running the code. Assert the rendered
   output, not the inputs: render tests passed while the real screen hid a
   row. For a new regression test, show it failing first: the failure names
   the missing behaviour. An existing failing test already counts as that
   evidence.
3. Apply `references/reliability.md` for any time, process, port, file,
   environment, locale or platform dependency. Result: no fixed sleep, no
   fixed port, no unrestored global, no host-locale assumption.
4. Make it pass with the smallest change, then rerun the same file. Add no
   further tests unless the user asks.
5. Put it in the lane its duration and needs call for (`suite-design.md`).

## Done when

The focused file passes. A new regression test also failed before, and the
report quotes both runs.
