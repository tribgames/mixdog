import { trackReplay } from './terminal-replay-state';

export interface TerminalOutputOwner {
  id: string | null;
  writer: { push(id: string, data: string): void; writeReplay?(data: string): Promise<void> };
  localEcho: { onIncoming(data: string): string; reset?(): void } | null;
  /** The xterm a reset event clears; absent in views that only receive output. */
  term?: { reset(): void };
  /** The replay write still in flight (terminal-replay-state). */
  replayPending?: Promise<void> | null;
  /** Live PTY output subscription; owned by the terminal view, not by a mount. */
  unsubscribeOutput?: (() => void) | null;
}

/** `reset` marks a replay of the whole screen after a server reattach (widened
 *  here until shared/contract.ts carries it). */
type SubscribeTermData = (listener: (event: { id: string; data: string; reset?: true }) => void) => () => void;

/** Attach the view's PTY output feed once. It outlives pane mounts: a hidden
 *  or re-parented terminal keeps parsing and acknowledging output, so main's
 *  flow control never counts IPC chunks nobody consumed and the shell is never
 *  paused behind a closed pane. */
export function attachTerminalOutput(view: TerminalOutputOwner, subscribe: SubscribeTermData | undefined): void {
  if (view.unsubscribeOutput || !subscribe) return;
  view.unsubscribeOutput = subscribe((event) => {
    if (event.id !== view.id) return;
    if (event.reset === true) {
      // The host redraws from a clean screen: clear the view, then write the
      // replay as a replay write (unacknowledged, ordered before later output).
      view.localEcho?.reset?.();
      try {
        view.term?.reset();
      } catch {
        /* disposed mid-reset */
      }
      if (event.data && view.writer.writeReplay) {
        trackReplay(view as Parameters<typeof trackReplay>[0], event.data);
      }
      return;
    }
    const data = view.localEcho ? view.localEcho.onIncoming(event.data) : event.data;
    if (data) view.writer.push(event.id, data);
  });
}

/** Release the feed when the view itself is disposed. */
export function detachTerminalOutput(view: TerminalOutputOwner): void {
  const unsubscribe = view.unsubscribeOutput;
  view.unsubscribeOutput = null;
  unsubscribe?.();
}
