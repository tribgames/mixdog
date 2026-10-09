export interface TerminalOutputOwner {
  id: string | null;
  writer: { push(id: string, data: string): void };
  localEcho: { onIncoming(data: string): string } | null;
  /** Live PTY output subscription; owned by the terminal view, not by a mount. */
  unsubscribeOutput?: (() => void) | null;
}

type SubscribeTermData = (listener: (event: { id: string; data: string }) => void) => () => void;

/** Attach the view's PTY output feed once. It outlives pane mounts: a hidden
 *  or re-parented terminal keeps parsing and acknowledging output, so main's
 *  flow control never counts IPC chunks nobody consumed and the shell is never
 *  paused behind a closed pane. */
export function attachTerminalOutput(view: TerminalOutputOwner, subscribe: SubscribeTermData | undefined): void {
  if (view.unsubscribeOutput || !subscribe) return;
  view.unsubscribeOutput = subscribe((event) => {
    if (event.id !== view.id) return;
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
