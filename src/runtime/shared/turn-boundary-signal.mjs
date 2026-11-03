// Turn boundaries the review follows, as two process-local signals with no
// dependencies (the desktop service bundle imports this file too, so every
// copy shares one registry through a global symbol):
// - a command tool finished (shell, terminal, git): it may have changed files
//   without going through Mixdog's write path, so the review must capture the
//   worktree it ran in on its next read;
// - the review may read differently now (a boundary stamped a worktree, or a
//   capture changed what it shows), so open reviews should read again.

const KEY = Symbol.for('mixdog.turnBoundarySignal.v1');

function registry() {
  globalThis[KEY] ??= { commands: new Set(), reviews: new Set(), reviewQueued: false };
  return globalThis[KEY];
}

function listen(set, fn) {
  set.add(fn);
  return () => set.delete(fn);
}

/** Tools that run arbitrary commands: their completion is a boundary. */
export const COMMAND_TOOL_NAMES = new Set(['shell', 'terminal', 'git']);

/** A command tool finished in `cwd`. */
export function noteCommandToolSettled(cwd) {
  for (const fn of registry().commands) {
    try {
      fn(cwd);
    } catch {}
  }
}

export function onCommandToolSettled(fn) {
  return listen(registry().commands, fn);
}

/** The review may have changed. Signals within one task reach listeners
 *  once, after it: a tool batch stamping several roots is one re-read. */
export function noteTurnReviewChanged() {
  const host = registry();
  if (host.reviewQueued) return;
  host.reviewQueued = true;
  queueMicrotask(() => {
    host.reviewQueued = false;
    for (const fn of host.reviews) {
      try {
        fn();
      } catch {}
    }
  });
}

export function onTurnReviewChanged(fn) {
  return listen(registry().reviews, fn);
}
