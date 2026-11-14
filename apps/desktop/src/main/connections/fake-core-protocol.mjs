// A protocol connection stand-in for tests of a connection built around one: records what is sent and called,
// and lets the test emit client events (status, server requests), section changes and a replaced client as the core would.
export function fakeProtocol(entries = []) {
  const listeners = new Set();
  const sectionWatchers = new Map();
  const replacedListeners = new Set();
  const protocol = {
    sent: [],
    calls: [],
    closed: 0,
    snapshot: () => ({ status: 'ready', entries }),
    onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    emit: (event) => listeners.forEach((listener) => listener(event)),
    respond(id, answer) {
      this.sent.push(['respond', id, answer]);
    },
    notify(method, params) {
      this.sent.push(['notify', method, params]);
    },
    call(method, params) {
      return new Promise((resolve, reject) => this.calls.push({ method, params, resolve, reject }));
    },
    watchSection: (section, listener) => {
      const watchers = sectionWatchers.get(section) ?? new Set();
      sectionWatchers.set(section, watchers.add(listener));
      return () => watchers.delete(listener);
    },
    /** The core's app section `section` now holds `value`. */
    pushSection: (section, value) =>
      sectionWatchers.get(section)?.forEach((listener) => listener({ section, key: null, revision: 1, value })),
    // The session lane's readers: no client is open, so nothing is folded and no store change arrives.
    client: () => null,
    whenSynced: async () => {},
    onStoreChange: () => () => {},
    resumeThread(threadId, window) {
      return this.call('thread/resume', { threadId, window });
    },
    unsubscribeThread(threadId) {
      return this.call('thread/unsubscribe', { threadId });
    },
    start: async () => {},
    reopen: async () => {},
    ensureOpen: async () => {},
    onReplaced: (listener) => (replacedListeners.add(listener), () => replacedListeners.delete(listener)),
    /** A reopen attached a new client. */
    replace: () => replacedListeners.forEach((listener) => listener()),
    async close() {
      this.closed += 1;
    },
  };
  return protocol;
}
