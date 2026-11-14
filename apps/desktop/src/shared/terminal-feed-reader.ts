// Where a tab's output feed (`process:<tab>`) was read to, so a new link to the core resumes from there instead of losing what was
// written while it was down. Pure: no I/O, shared by the desktop's terminal host and the pages that read a tab's feed.

/** A reader's last position in a feed, as `terminal/attach` takes it in `resumeFrom`. */
export interface TerminalFeedPosition {
  epoch: string;
  seq: number;
}

function positionOf(value: unknown): TerminalFeedPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { epoch, seq } = value as { epoch?: unknown; seq?: unknown };
  return typeof epoch === 'string' && epoch && typeof seq === 'number' && Number.isFinite(seq) ? { epoch, seq } : undefined;
}

/** The last position read on each tab's feed. */
export class TerminalFeedPositions {
  private readonly positions = new Map<string, TerminalFeedPosition>();

  /** Notes the stamp of a frame read on the tab's feed (`{ id, epoch, seq }`); anything that is not a stamp leaves the position. */
  note(tabId: string, feed: unknown): void {
    const position = positionOf(feed);
    if (tabId && position) this.positions.set(tabId, position);
  }

  /** The position to resume the tab from, or undefined when nothing was read. */
  resumeFrom(tabId: string): TerminalFeedPosition | undefined {
    return this.positions.get(tabId);
  }

  forget(tabId: string): void {
    this.positions.delete(tabId);
  }
}

/** Whether the screen the attach answered replaces what the reader shows. The core replays the missed frames only when the reader
 *  resumed from a position of the same epoch (`subscription.mode === "replay"`); a snapshot, a new epoch, or a core that answers no
 *  subscription gives the screen as it is now. */
export function attachNeedsRedraw(reply: unknown, resumed: TerminalFeedPosition | undefined): boolean {
  const subscription = reply && typeof reply === 'object' ? (reply as { subscription?: unknown }).subscription : undefined;
  if (!subscription || typeof subscription !== 'object') return true;
  const { mode, epoch } = subscription as { mode?: unknown; epoch?: unknown };
  return !(mode === 'replay' && resumed !== undefined && epoch === resumed.epoch);
}
