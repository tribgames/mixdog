# Composer layout regression probe

Run from the repository root:

```powershell
node apps/desktop/scripts/composer-layout-probe/run.mjs
```

Runs in a hidden, isolated Electron window with the real renderer styles.
It does not connect to, restart, or modify the installed application.

- `submit` runs the actual Conversation / Composer keyboard-submit flow:
  slash-menu hit testing and keyboard dismissal, previous diff and goal
  removal, delayed transcript acknowledgement, and delayed goal publication.
  DIFF-only, completed-Goal-only, and combined chrome each run collapsed and
  expanded, with single- and multiline prompts, mixed Markdown history, and
  authoritative diff responses. Clock-only goal publications must not restore
  old chrome. Visible conversation rows, prompt, viewport, and input positions
  must stay unchanged after the first submitted frame, with the transcript
  pinned to its bottom. Native scroll writes must not reverse direction inside
  a single frame, including the optimistic-to-settled message handoff.
- `palette` runs only the focused popup geometry and virtual-list fixtures.
- `motion` captures the first visible frames of real pane session switches,
  including cold/cached Markdown history, a changed pane width, and delayed
  session data. It also tracks existing rows through multiline submissions
  at the tail and during a reader gesture, and preserves reading on append.
  The composer dock is measured too: a turn-review worker result landing
  after the transcript is shown must fill the reserved slot without moving a
  row, Goal republications (new object, clock-only fields) must not move the
  viewport, and clearing the Goal must move it exactly once.
- No argument runs both.

Bundles and reports are generated in a unique temporary directory, printed
to stdout, then removed. A failed assertion exits nonzero.
