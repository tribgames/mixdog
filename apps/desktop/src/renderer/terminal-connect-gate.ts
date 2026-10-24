/** How a terminal pane reaches its PTY. A warm-up mount (rendered before its
 *  dock opens, e.g. on the toggle's hover) only attaches to a shell already
 *  running, never starting or changing one. The real open always runs the
 *  ensure, whatever the warm-up found: a shell it attached to can have exited
 *  since, and ensuring a live shell is idempotent (the same PTY answers). */
export type TerminalConnectMode = 'attach' | 'ensure';

export interface TerminalConnectGate {
  /** The mode a connect runs in now. */
  readonly mode: TerminalConnectMode;
  /** Starts a connect in the current mode unless one is in flight. */
  connect(): void;
  /** The real open: every connect ensures from here, and one runs now, after
   *  a connect still in flight (never alongside it). */
  open(): void;
}

/** `run` connects once in the given mode; it settles when that attempt is done. */
export function createTerminalConnectGate(
  warm: boolean,
  run: (mode: TerminalConnectMode) => Promise<unknown>
): TerminalConnectGate {
  let mode: TerminalConnectMode = warm ? 'attach' : 'ensure';
  let inFlight = false;
  let ensureNext = false;
  const connect = () => {
    if (inFlight) return;
    inFlight = true;
    const done = () => {
      inFlight = false;
      if (!ensureNext) return;
      ensureNext = false;
      connect();
    };
    run(mode).then(done, done);
  };
  return {
    get mode() {
      return mode;
    },
    connect,
    open() {
      if (mode === 'ensure') return;
      mode = 'ensure';
      if (inFlight) ensureNext = true;
      else connect();
    },
  };
}
