import { trackReplay } from './terminal-replay-state.ts';

export interface TerminalOutputOwner {
  id: string | null;
  writer: {
    push(id: string, data: string, gen?: number): void;
    writeReplay?(data: string, before?: () => void): Promise<void>;
  };
  localEcho: { onIncoming(data: string): string; reset?(): void } | null;
  /** The xterm a reset event clears; absent in views that only receive output. */
  term?: { reset(): void };
  /** The replay write still in flight (terminal-replay-state). */
  replayPending?: Promise<void> | null;
  /** Live PTY output subscription; owned by the terminal view, not by a mount. */
  unsubscribeOutput?: (() => void) | null;
}

/** `reset` marks a replay of the whole screen after a server reattach. */
type SubscribeTermData = (
  listener: (event: { id: string; data: string; reset?: true }, gen?: number) => void
) => () => void;

/** Attach the view's PTY output feed once. It outlives pane mounts, so a hidden
 *  terminal keeps acknowledging output and main's flow control never pauses
 *  the shell behind a closed pane. */
export function attachTerminalOutput(
  view: TerminalOutputOwner,
  subscribe: SubscribeTermData | undefined,
  acknowledge?: (id: string, charCount: number, gen?: number) => void
): void {
  if (view.unsubscribeOutput || !subscribe) return;
  view.unsubscribeOutput = subscribe((event, gen) => {
    if (event.id !== view.id) return;
    if (event.reset === true) {
      // Main counts the replay in flight (TerminalDataBufferer.reset): it must be
      // acknowledged once written or main's window stays shut.
      view.localEcho?.reset?.();
      const reset = () => {
        try {
          view.term?.reset();
        } catch {
          /* disposed mid-reset */
        }
      };
      if (view.writer.writeReplay) {
        const { id, data } = event;
        void trackReplay(view as Parameters<typeof trackReplay>[0], data, reset).then(() => {
          if (data) acknowledge?.(id, data.length, gen);
        });
      } else reset();
      return;
    }
    const data = view.localEcho ? view.localEcho.onIncoming(event.data) : event.data;
    if (data) view.writer.push(event.id, data, gen);
  });
}

/** Release the feed when the view itself is disposed. */
export function detachTerminalOutput(view: TerminalOutputOwner): void {
  const unsubscribe = view.unsubscribeOutput;
  view.unsubscribeOutput = null;
  unsubscribe?.();
}
