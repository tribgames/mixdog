/**
 * src/tui/session/worktree-setup-notice.mjs - the one-line transcript notice
 * shown while a new worktree's dependencies install (runtime.onWorktreeSetup).
 * Only runs that install anything reach it; one notice per run, patched in
 * place, so every surface showing the transcript (TUI, desktop, remote) sees
 * the same line. The details (output, failures, skips) go to the agent only.
 */
const ENDINGS = {
  completed: 'Worktree dependencies installed.',
  cancelled: 'Installing worktree dependencies was cancelled.',
};
const INCOMPLETE = 'Some worktree dependencies were not installed; the agent has the details.';

/** Notice text and tone for one install progress event. */
export function worktreeSetupNotice(event) {
  if (event.final) {
    const text = ENDINGS[event.status] ?? INCOMPLETE;
    return { text, tone: event.status === 'completed' ? 'info' : 'warn' };
  }
  const what = event.label || event.command;
  return { text: `Installing worktree dependencies [${event.index + 1}/${event.total}]: ${what}`, tone: 'info' };
}

export function createWorktreeSetupNotices({ pushItem, patchItem, nextId }) {
  const items = new Map();
  return (event) => {
    const notice = worktreeSetupNotice(event);
    const itemId = items.get(event.id);
    if (itemId === undefined) {
      const id = nextId();
      items.set(event.id, id);
      pushItem({ kind: 'notice', id, ...notice });
    } else {
      patchItem(itemId, notice);
    }
    if (event.final) items.delete(event.id);
  };
}
