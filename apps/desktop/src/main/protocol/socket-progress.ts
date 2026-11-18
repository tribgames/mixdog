// What the socket-owning layer can see that a whole-message API hides: bytes arriving on the connection from the core, before the
// message they belong to is complete. A `ws` WebSocket delivers a message only when all of it has arrived, so a response of several
// megabytes on a slow link would show the health machine (packages/protocol-client/src/health.ts) nothing for as long as it takes.
// This reports the socket's own data events, at most once per `minGapMs`, as the transport's progress fact; the policy is the
// client's. The bytes are those of the connection this socket carries to the core (a loopback socket, or the local end of an SSH
// forward to a server's core), so they are the core's, not a relay's keepalive.
export const SOCKET_PROGRESS_MIN_GAP_MS = 200;

interface RawSocket {
  on(event: 'data', run: (chunk: { length: number }) => void): unknown;
}

let missingLogged = false;

export function observeSocketProgress(
  socket: object,
  report: () => void,
  now: () => number = Date.now,
  minGapMs: number = SOCKET_PROGRESS_MIN_GAP_MS
): void {
  // `ws` keeps the net socket it upgraded; it has no public way to see its raw reads, so this reads its internal `_socket`. If a
  // library version no longer has it, the connection reports no progress and the health machine falls back to complete messages
  // alone: a message larger than its observation window then looks like silence. That is said once in the log, never skipped quietly.
  const raw = (socket as unknown as { _socket?: RawSocket })._socket;
  if (!raw) {
    if (!missingLogged) {
      missingLogged = true;
      console.error('[mixdog] core socket progress unavailable: the ws library no longer exposes its raw socket; a large response may be taken for silence');
    }
    return;
  }
  let last = Number.NEGATIVE_INFINITY;
  raw.on('data', (chunk) => {
    if (chunk.length === 0) return;
    const at = now();
    if (at - last < minGapMs) return;
    last = at;
    report();
  });
}

/** Test hook: forgets that the absence was already logged. */
export function resetSocketProgressNotice(): void {
  missingLogged = false;
}
