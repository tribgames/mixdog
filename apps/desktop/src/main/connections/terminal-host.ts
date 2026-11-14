import type { TerminalSizeOwner, TerminalSizeOwnerEvent } from '../../shared/terminal-size-owner';
import { readTerminalActivityEvent, type TerminalActivityEvent } from '../../shared/terminal-activity';
import { attachNeedsRedraw, TerminalFeedPositions, type TerminalFeedPosition } from '../../shared/terminal-feed-reader';
import { createTerminalOutputDecoder, terminalActivityChanges, terminalSizeOwnerChanges } from '../../shared/terminal-protocol';
import type { DesktopService } from '../desktop-service-contract';
import type { DesktopTerminalHost } from '../ipc-terminal';
import type { ProtocolConnection } from '../protocol/connection';
import { onProtocolAttached } from '../protocol/screen-sessions-publish';

type TerminalService = Pick<DesktopService, 'invokeDesktopOperation'> & {
  notifyDesktopOperation(method: string, args?: unknown[]): void;
};

/** What the host reads of the connection's core: the tabs' output feeds and the terminal sections. */
type TerminalProtocol = Pick<ProtocolConnection, 'onEvent' | 'onReplaced' | 'watchSection'>;

function terminalSessionOf(value: object) {
  const result = value as Record<string, unknown>;
  // The window is never a size owner: a phone's grid is followed, not claimed.
  const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
  return {
    id: String(result.id || ''),
    replay: String(result.replay || ''),
    ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
  };
}

type TerminalSession = ReturnType<typeof terminalSessionOf>;

/** PTYs are owned by the connection's core; the window forwards control and reads each tab's output on the tab's own feed
 *  (`process:<id>`), which `terminal/attach` subscribes on this connection. Node's service pushed every tab's output to every window
 *  as `terminal-data` (desktop-operations.ts createTerminalOutputCoalescer); here the windows get the output of the tabs this
 *  connection attached, and the activity and size-owner events of the core's terminal sections. */
export function createServiceTerminalHost(service: TerminalService, protocol: TerminalProtocol): DesktopTerminalHost {
  const outputListeners = new Set<(event: { id: string; data: string }) => void>();
  const resetListeners = new Set<(event: { id: string; replay: string }) => void>();
  const activityListeners = new Set<(event: TerminalActivityEvent) => void>();
  const sizeOwnerListeners = new Set<(event: TerminalSizeOwnerEvent) => void>();
  const listen = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const output = createTerminalOutputDecoder();
  // Where each tab's feed was read to: a new link's attach resumes from there.
  const positions = new TerminalFeedPositions();
  // The windows holding each tab's output (a window's buffer is full): the core pauses the tab's pty for this connection while any
  // holds it, and a window's release leaves the others' holds.
  const holders = new Map<string, Set<string>>();
  // The tabs whose feed this connection reads, or subscribes again on its next link (a feed does not survive the socket): a tab is
  // held from its attach until the attach answers that it is not running, its shell exits or the window disposes it. The core
  // answers an attach of a tab that is not running with null, never an error (terminal/attach), so a rejected attach is a lost
  // link, and the tab is left to the next link's attach.
  const attached = new Set<string>();
  // The attach in flight per tab, which a second caller joins (a dock hover's warm-up, then the pane's ensure; two windows): the
  // core keeps one subscription per feed and connection, and a second attach would replace the first and drop what was still
  // queued on it.
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
  // follows as frames (replay) or the screen is given as it is (snapshot, a new epoch, nothing to resume from), which the windows
  // draw anew.
  const subscribeFeed = (id: string, relink = false): Promise<TerminalSession | null> => {
    const resumed: TerminalFeedPosition | undefined = relink ? positions.resumeFrom(id) : undefined;
    const request: Promise<TerminalSession | null> = service.invokeDesktopOperation('termAttach', resumed ? [id, resumed] : [id]).then(
      (value) => {
        const session = value && typeof value === 'object' ? terminalSessionOf(value) : null;
        // A newer attach has the say over the tab: a new link's, or a new tab's under a disposed id.
        if (attaching.get(id) !== request) return session;
        attaching.delete(id);
        if (!session) {
          attached.delete(id);
          positions.forget(id);
          output.end(id);
        } else if (relink && attachNeedsRedraw(value, resumed)) {
          // What the window shows is not this screen's past: a half character left from the old link is dropped, the feed's
          // position is the snapshot's (frames follow from startSeq), and the window draws the screen anew.
          output.end(id);
          if (!noteAttached(id, value)) positions.forget(id);
          for (const listener of [...resetListeners]) listener({ id, replay: session.replay });
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
  const attach = (id: string): Promise<TerminalSession | null> => attaching.get(id) ?? subscribeFeed(id);
  // A new link holds none of the old one's feeds: each tab is attached again, and an attach still in flight was the old link's.
  const reattach = (): void => {
    for (const id of [...attached]) {
      void subscribeFeed(id, true).catch(() => undefined);
      // The pause was this connection's on the old link.
      if (holders.has(id)) void service.invokeDesktopOperation('termPause', [id]).catch(() => {});
    }
  };
  onProtocolAttached(protocol, reattach);
  protocol.onReplaced(reattach);
  protocol.onEvent((event) => {
    if (event.type !== 'notification') return;
    const { method, params, feed } = (event as { notification: { method: string; params?: unknown; feed?: { id: string } } })
      .notification;
    const tab = String((params as { processHandle?: unknown } | undefined)?.processHandle ?? '');
    // A tab's own feed only: the phones' terminal lane (`process:relay`), should this connection read it, repeats every tab's output.
    if (feed?.id !== `process:${tab}`) return;
    positions.note(tab, feed);
    if (method === 'process/outputDelta') {
      const { id, data } = output.text(params);
      if (data) for (const listener of [...outputListeners]) listener({ id, data });
    } else if (method === 'process/exited') {
      attached.delete(tab);
      positions.forget(tab);
      holders.delete(tab);
      output.end(tab);
    }
  });
  const activity = new Map<string, unknown>();
  protocol.watchSection('terminalActivity', (entry) => {
    for (const event of terminalActivityChanges(activity, entry?.value)) {
      for (const listener of [...activityListeners]) listener(event);
    }
  });
  const owners = new Map<string, TerminalSizeOwner>();
  protocol.watchSection('terminalTabs', (entry) => {
    for (const event of terminalSizeOwnerChanges(owners, entry?.value, '')) {
      for (const listener of [...sizeOwnerListeners]) listener(event);
    }
  });
  const leave = (id: string, holder: string): void => {
    const held = holders.get(id);
    if (!held?.delete(holder) || held.size > 0) return;
    holders.delete(id);
    void service.invokeDesktopOperation('termResume', [id]).catch(() => {});
  };
  return {
    async ensure(id: string | null, cwd: string | null, profile?: string | null) {
      const value = await service.invokeDesktopOperation('termEnsure', [id, cwd, profile ?? null]);
      if (!value || typeof value !== 'object') {
        throw new Error('The service terminal did not return a session.');
      }
      const ensured = terminalSessionOf(value);
      // A tab this connection does not read yet is attached: its output streams from the attach's position, and the attach's
      // replay is the screen up to there; an attach in flight answers for it. A tab already read streams as it is.
      const pending = attaching.get(ensured.id) ?? (attached.has(ensured.id) ? null : subscribeFeed(ensured.id));
      if (!pending) return ensured;
      // The shell runs whatever the attach answers, so the ensure answers it: a shell already gone has nothing to stream, and an
      // attach lost with the link leaves the tab to the next link's (a retried ensure without an id would spawn a second shell).
      return (await pending.catch(() => null)) ?? ensured;
    },
    attach,
    write(id: string, data: string): void {
      // Keystrokes take the fire-and-forget lane: a response frame per keypress
      // only queued the input behind whatever session request was in flight.
      service.notifyDesktopOperation('termWrite', [id, data]);
    },
    resize(id: string, cols: number, rows: number): void {
      service.notifyDesktopOperation('termResize', [id, cols, rows]);
    },
    pauseOutput(id: string, holder: string): void {
      const held = holders.get(id) ?? new Set<string>();
      holders.set(id, held);
      if (held.has(holder)) return;
      held.add(holder);
      if (held.size === 1) void service.invokeDesktopOperation('termPause', [id]).catch(() => {});
    },
    resumeOutput(id: string, holder: string): void {
      leave(id, holder);
    },
    releaseHolder(holder: string): void {
      for (const id of [...holders.keys()]) leave(id, holder);
    },
    dispose(id: string): void {
      // A new tab under this id has a feed of its own, which its ensure attaches; an attach in flight is the old tab's.
      attached.delete(id);
      attaching.delete(id);
      positions.forget(id);
      holders.delete(id);
      void service.invokeDesktopOperation('termDispose', [id]).catch(() => {});
    },
    subscribe: (listener) => listen(outputListeners, listener),
    subscribeReset: (listener) => listen(resetListeners, listener),
    focus(id: string, focused: boolean): void {
      service.notifyDesktopOperation('termFocus', [id, focused, 'desktop']);
    },
    async activity(): Promise<TerminalActivityEvent[]> {
      const value = await service.invokeDesktopOperation('termActivity', []);
      return Array.isArray(value)
        ? value.map(readTerminalActivityEvent).filter((event): event is TerminalActivityEvent => event !== null)
        : [];
    },
    subscribeActivity: (listener) => listen(activityListeners, listener),
    subscribeSizeOwner: (listener) => listen(sizeOwnerListeners, listener),
  };
}
