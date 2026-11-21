import { routeDesktopOperation } from '../../shared/core-lanes/desktop-operation-route';
import { attachNeedsRedraw, TerminalFeedPositions, type TerminalFeedPosition } from '../../shared/terminal-feed-reader';
import { createTerminalOutputDecoder, terminalReply } from '../../shared/terminal-protocol';
import { TerminalDataBufferer, type TerminalDataEvent } from './terminal-data-buffer';
import type { DirectContext } from './context';

/** What the pane gets of a tab: its id, the screen up to the feed's position and who owns the size (never this window). */
export type TerminalSession = { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } };

/** The output of a tab is coalesced for this long before it reaches the page. */
const OUTPUT_COALESCE_MS = 5;
/** The output the page holds unacknowledged before the core's pty is paused, and the level it resumes at. */
const HIGH_WATERMARK_CHARS = 256 * 1024;
const LOW_WATERMARK_CHARS = 32 * 1024;

export function sessionOf(value: object): TerminalSession {
  const result = value as Record<string, unknown>;
  // The window is never a size owner: a phone's grid is followed, not claimed.
  const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
  return {
    id: String(result.id || ''),
    replay: String(result.replay || ''),
    ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
  };
}

/** The terminal tabs whose output feed this connection reads (`process:<id>`): attaching and re-attaching them, the feed
 *  positions they resume from, and the flow control that holds the core's pty back while the page's buffer is full. */
export function createTerminalFeed(ctx: DirectContext, onData: (event: TerminalDataEvent) => void) {
  const { connection } = ctx;
  const output = createTerminalOutputDecoder();
  // Where each tab's feed was read to: a new link's attach resumes from there.
  const positions = new TerminalFeedPositions();
  // The tabs whose output the core holds back because the page's buffer is full: the pause belongs to this connection, so a new
  // link asks for it again.
  const paused = new Set<string>();
  const sendPause = (method: 'termPause' | 'termResume', id: string): void => {
    const { method: name, params } = routeDesktopOperation(method, [id]);
    void ctx.call(name, params).catch(() => {});
  };
  const buffer = new TerminalDataBufferer(
    onData,
    OUTPUT_COALESCE_MS,
    HIGH_WATERMARK_CHARS,
    {
      pause: (id) => {
        paused.add(id);
        sendPause('termPause', id);
      },
      resume: (id) => {
        paused.delete(id);
        sendPause('termResume', id);
      },
    },
    LOW_WATERMARK_CHARS
  );
  const attached = new Set<string>();
  // The attach in flight per tab, which a second caller joins (a dock hover's warm-up, then the pane's ensure): the core keeps one
  // subscription per feed and connection, and a second attach would replace the first and drop what was still queued on it.
  const attaching = new Map<string, Promise<TerminalSession | null>>();
  // The feed's position an attach answered (frames follow from `startSeq`), unless frames read since are already past it. Noted on
  // every attach, so a tab that printed nothing on a link still resumes on the next one.
  const noteAttached = (id: string, value: unknown): boolean => {
    const subscription = (value as { subscription?: { epoch?: unknown; startSeq?: unknown } }).subscription;
    if (typeof subscription?.startSeq !== 'number') return false;
    const read = positions.resumeFrom(id);
    if (!read || read.epoch !== subscription.epoch || read.seq < subscription.startSeq - 1) {
      positions.note(id, { epoch: subscription.epoch, seq: subscription.startSeq - 1 });
    }
    return true;
  };
  // `relink`: a new link attaches the tab again from the position its feed was read to; the reply says whether the missed output
  // follows as frames (replay) or the screen is given as it is (snapshot, a new epoch, nothing to resume from), which the page
  // draws anew.
  const subscribeFeed = (id: string, relink = false): Promise<TerminalSession | null> => {
    const resumed: TerminalFeedPosition | undefined = relink ? positions.resumeFrom(id) : undefined;
    const { method, params } = routeDesktopOperation('termAttach', resumed ? [id, resumed] : [id]);
    const request: Promise<TerminalSession | null> = ctx.call(method, params).then(
      (reply) => {
        const value = reply == null ? null : terminalReply(reply);
        const session = value ? sessionOf(value) : null;
        // A newer attach has the say over the tab: a new link's, or a new tab's under a disposed id.
        if (attaching.get(id) !== request) return session;
        attaching.delete(id);
        if (!value) {
          attached.delete(id);
          paused.delete(id);
          positions.forget(id);
          output.end(id);
        } else if (relink && attachNeedsRedraw(value, resumed)) {
          // What the page shows is not this screen's past: a half character left from the old link is dropped, the feed's
          // position is the snapshot's (frames follow from startSeq), and the page draws the screen anew.
          output.end(id);
          if (!noteAttached(id, value)) positions.forget(id);
          buffer.reset(id, session!.replay);
        } else {
          noteAttached(id, value);
        }
        return session;
      },
      (error: unknown) => {
        if (attaching.get(id) === request) attaching.delete(id);
        throw error;
      }
    );
    attaching.set(id, request);
    attached.add(id);
    return request;
  };

  // A new link holds none of the old one's feeds: each tab is attached again, and an attach still in flight was the old link's.
  const reattach = (): void => {
    for (const id of [...attached]) {
      void subscribeFeed(id, true).catch(() => undefined);
      if (paused.has(id)) sendPause('termPause', id);
    }
  };
  let ready = false;
  connection.onEvent((event) => {
    if (event.type === 'status') {
      const next = (event as { status: { state: string } }).status.state === 'ready';
      if (next && !ready) reattach();
      ready = next;
      return;
    }
    if (event.type !== 'notification') return;
    const { method, params, feed } = (
      event as { notification: { method: string; params?: unknown; feed?: { id: string } } }
    ).notification;
    const tab = String((params as { processHandle?: unknown } | undefined)?.processHandle ?? '');
    // A tab's own feed only: the phones' terminal lane (`process:relay`), should this connection read it, repeats every tab's output.
    if (feed?.id !== `process:${tab}` || !attached.has(tab)) return;
    positions.note(tab, feed);
    if (method === 'process/outputDelta') {
      const { id, data } = output.text(params);
      if (data) buffer.push({ id, data });
    } else if (method === 'process/exited') {
      attached.delete(tab);
      positions.forget(tab);
      paused.delete(tab);
      output.end(tab);
    }
  });
  connection.onReplaced(reattach);

  return {
    attach: (id: string): Promise<TerminalSession | null> => attaching.get(id) ?? subscribeFeed(id),
    /** The attach that answers for a tab not yet read, or the one in flight; null for a tab already read, which streams as it is. */
    joinOrAttach: (id: string): Promise<TerminalSession | null> | null =>
      attaching.get(id) ?? (attached.has(id) ? null : subscribeFeed(id)),
    acknowledge: (id: string, charCount: number): void => buffer.acknowledge(id, charCount),
    dispose(tab: string): void {
      buffer.release(tab);
      attached.delete(tab);
      attaching.delete(tab);
      paused.delete(tab);
      positions.forget(tab);
    },
  };
}
