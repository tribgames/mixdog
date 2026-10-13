interface SharedPoll {
  count: number;
  timer: number | undefined;
  onVisibility: () => void;
}

const polls = new WeakMap<object, SharedPoll>();

/** One poll per `key` (window-wide) shared by every mounted subscriber. It is
 *  paused while the document is hidden and refreshes at once when the document
 *  becomes visible again. Returns the unsubscribe function. */
export function subscribeSharedPoll(key: object, refresh: () => void, intervalMs: number): () => void {
  let poll = polls.get(key);
  if (!poll) {
    const created: SharedPoll = {
      count: 0,
      timer: undefined,
      onVisibility: () => {
        if (document.hidden) {
          if (created.timer !== undefined) window.clearInterval(created.timer);
          created.timer = undefined;
        } else if (created.timer === undefined) {
          refresh();
          created.timer = window.setInterval(refresh, intervalMs);
        }
      },
    };
    polls.set(key, created);
    poll = created;
  }
  const shared = poll;
  if (shared.count++ === 0) {
    document.addEventListener('visibilitychange', shared.onVisibility);
    if (!document.hidden) shared.timer = window.setInterval(refresh, intervalMs);
  }
  return () => {
    if (--shared.count > 0) return;
    document.removeEventListener('visibilitychange', shared.onVisibility);
    if (shared.timer !== undefined) window.clearInterval(shared.timer);
    shared.timer = undefined;
    polls.delete(key);
  };
}
