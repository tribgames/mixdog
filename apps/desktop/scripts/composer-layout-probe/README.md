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
  DIFF-only, completed-Goal-only, and combined chrome each run with single-
  and multiline prompts. Clock-only goal publications must not restore old
  chrome. Prompt, viewport, and input positions must stay unchanged after the
  first submitted frame, with the transcript pinned to its bottom.
- `palette` runs only the focused popup geometry and virtual-list fixtures.
- No argument runs both.

Bundles and reports are generated in a unique temporary directory, printed
to stdout, then removed. A failed assertion exits nonzero.
