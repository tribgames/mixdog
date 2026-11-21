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
      console.error(
        '[mixdog] core socket progress unavailable: the ws library no longer exposes its raw socket; a large response may be taken for silence'
      );
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
