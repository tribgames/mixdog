// A protocol connection stand-in for tests of a connection built around one: records what is sent and called,
// and lets the test emit client events (status, server requests) as the core would.
export function fakeProtocol(entries = []) {
  const listeners = new Set();
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
    watchSection: () => () => {},
    start: async () => {},
    reopen: async () => {},
    ensureOpen: async () => {},
    onReplaced: () => () => {},
    async close() {
      this.closed += 1;
    },
  };
  return protocol;
}
