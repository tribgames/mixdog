// A phone showing a terminal owns that PTY's size; every other view follows it
// instead of re-fitting. Ownership is announced as a dedicated event (never in
// the terminal output stream, which agent tools and logs also read).

/** Host side: the effective owner of one PTY's size. `owner` is the claiming
 *  remote connection's id. */
export interface TerminalSizeOwner {
  cols: number;
  rows: number;
  owner: string;
}

/** Host side: ownership of one PTY changed. `cols`/`rows` are 0 and `owner`
 *  is '' when nobody owns the size any more (views fit their own pane). */
export interface TerminalSizeOwnerChange extends TerminalSizeOwner {
  id: string;
}

/** What one client is told: `own` is true when THIS client holds ownership. */
export interface TerminalSizeOwnerEvent {
  id: string;
  cols: number;
  rows: number;
  own: boolean;
}

export const TERMINAL_SIZE_OWNER_EVENT = 'terminal-size-owner';

/** The owner state a client is handed when it attaches to a PTY. */
export function clientSizeOwner(
  owner: TerminalSizeOwner | null | undefined,
  clientId: string
): { cols: number; rows: number; own: boolean } | undefined {
  return owner ? { cols: owner.cols, rows: owner.rows, own: clientId !== '' && owner.owner === clientId } : undefined;
}
