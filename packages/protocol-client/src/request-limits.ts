// The client's own time bounds. A request that has been sent has none of its own: it stays pending for as long as the connection is
// demonstrably alive (the connection's health machine, `health.ts`), and what fails it is the connection.

/** How long a call may wait before it is sent (a ready connection, a held thread's resume). Not a limit on a sent request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** How long failed attempts at a window's first connection are tried again before the failure is reported, and how long one
 *  opened transport may leave `initialize` unanswered; the next call opens the connection again. The dial itself is not timed
 *  (see `establish`). The Node build waited 55 s for a failed first start (`desktop-service-client.ts`). */
export const DEFAULT_FIRST_CONNECT_DEADLINE_MS = 55_000;
