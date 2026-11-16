// The one way a connection's life-cycle reaches a host log. Every call site on the desktop side goes through it, so the
// guarantees hold by construction and not per site:
//  - it never throws into its caller, and never runs the sink before the caller's own work is done (the sink runs in a
//    microtask, in call order; the fields are copied at the call, so later changes do not reach the line);
//  - the event name comes from one fixed vocabulary (a name outside it is dropped, not written);
//  - the record's identity (which connection or window owns the link) is merged last, so a call's own fields cannot replace it.
// A line carries counts, ids and times only: never frames, message contents or tokens.

export const LINK_EVENTS = new Set([
  // The protocol client's link (`link-*`); `attempted`/`settled` counts are fields of the line that issued or finished them.
  'link-open',
  'link-down',
  'link-reconnected',
  'link-restore-settled',
  'link-violation',
  // The desktop's connection to the core: the socket it dialed and what ended it, and the connection object's replacement.
  'core-socket-open',
  'core-socket-open-failed',
  'core-socket-close',
  'core-connection-replace',
  'core-scoped-feeds-restore-started',
  'core-scoped-feeds-restore-settled',
  // The renderer-direct window link main relays.
  'core-link-open',
  'core-link-open-failed',
  'core-link-close',
  // The one automatic kill of a core.
  'core-ended-by-watch',
]);

/** `fn` that cannot throw into, delay or reorder its caller: it runs after the caller's current work, and its failures are its own. */
export function contained(fn) {
  return (...args) => {
    queueMicrotask(() => {
      try {
        Promise.resolve(fn(...args)).catch(() => {});
      } catch {
        /* diagnostics only */
      }
    });
  };
}

/** The log of one owner: `identity` (e.g. `{ link: 'main', owner: 'ssh', ownerKey }`) is on every line and wins over a call's fields. */
export function createLinkLog(sink, identity = {}) {
  if (!sink) return () => {};
  const write = contained(sink);
  return (event, fields = {}) => {
    if (!LINK_EVENTS.has(event)) return;
    write(event, { ...fields, ...identity });
  };
}
