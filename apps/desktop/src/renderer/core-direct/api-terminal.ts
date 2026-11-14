// The terminal members of the desktop API over the renderer's own core connection (DIRECT_KEYS.terminal). The PTYs belong to the
// core; this window asks for them with the shared routes (the request Node's operation made, the reply it answered) and reads each
// tab's output on the tab's own feed (`process:<id>`), which `terminal/attach` subscribes on this connection. The output goes to
// the page through the flow-control buffer (256 KiB in flight pauses the core's pty, under 32 KiB resumes it); the activity and
// size-owner events come from the core's terminal sections. The inputs are checked by the core; a failure arrives already mapped
// as the IPC path returned it (ctx.call).
import type { DesktopApi } from '../../shared/contract';
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';
import type { DirectKey } from '../../shared/desktop-api-split';
import { routeDesktopNotification, routeDesktopOperation } from '../../shared/core-lanes/desktop-operation-route';
import { termActivity } from '../../shared/core-lanes/section-reads';
import { readTerminalActivityEvent, type TerminalActivityEvent } from '../../shared/terminal-activity';
import { attachNeedsRedraw, TerminalFeedPositions, type TerminalFeedPosition } from '../../shared/terminal-feed-reader';
import { createTerminalOutputDecoder, terminalActivityChanges, terminalReply, terminalSizeOwnerChanges } from '../../shared/terminal-protocol';
import { requiredString } from '../../shared/scm-input';
import type { TerminalSizeOwner, TerminalSizeOwnerEvent } from '../../shared/terminal-size-owner';
import { TerminalDataBufferer, type TerminalDataEvent } from '../../main/terminal-data-buffer';
import type { DirectContext } from './context';

/** What the pane gets of a tab: its id, the screen up to the feed's position and who owns the size (never this window). */
type TerminalSession = { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } };

/** The notification that tells the core the pane showing a run's terminal claimed its reveal. */
const TERMINAL_RUN_CLAIMED = 'ui/terminalRun/claimed';
/** The output of a tab is coalesced for this long before it reaches the page. */
const OUTPUT_COALESCE_MS = 5;
/** The output the page holds unacknowledged before the core's pty is paused, and the level it resumes at. */
const HIGH_WATERMARK_CHARS = 256 * 1024;
const LOW_WATERMARK_CHARS = 32 * 1024;

function sessionOf(value: object): TerminalSession {
  const result = value as Record<string, unknown>;
  // The window is never a size owner: a phone's grid is followed, not claimed.
  const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
  return {
    id: String(result.id || ''),
    replay: String(result.replay || ''),
    ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
  };
}

export function createTerminalApi(ctx: DirectContext): Pick<DesktopApi, DirectKey<'terminal'>> {
  const { connection } = ctx;
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const activityListeners = new Set<(event: TerminalActivityEvent) => void>();
  const sizeOwnerListeners = new Set<(event: TerminalSizeOwnerEvent) => void>();
  const runListeners = new Set<(request: DesktopTerminalRunRequest) => void>();
  const listen = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
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
    (event) => {
      for (const listener of [...dataListeners]) listener(event);
    },
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
  // The tabs whose feed this connection reads, or subscribes again on its next link (a feed does not survive the socket): a tab is
  // held from its attach until the attach answers that it is not running, its shell exits or the page disposes it. The core
  // answers an attach of a tab that is not running with null, never an error, so a rejected attach is a lost link, and the tab is
  // left to the next link's attach.
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
  const attach = (id: string): Promise<TerminalSession | null> => attaching.get(id) ?? subscribeFeed(id);

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
    const { method, params, feed } = (event as { notification: { method: string; params?: unknown; feed?: { id: string } } })
      .notification;
    if (method === 'ui/openRequested') {
      const open = params as ({ kind?: unknown; sessionId?: unknown } & Record<string, unknown>) | undefined;
      if (open?.kind !== 'terminal' || typeof open.sessionId !== 'string' || !open.sessionId) return;
      const { kind: _kind, ...request } = open;
      for (const listener of [...runListeners]) listener(request as unknown as DesktopTerminalRunRequest);
      return;
    }
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

  // The activity and size owner are read from the sections the connection holds each time one changes.
  const sectionValue = (name: 'terminalActivity' | 'terminalTabs'): unknown => connection.protocolClient()?.store.section(name, null)?.value;
  const activity = new Map<string, unknown>();
  const owners = new Map<string, TerminalSizeOwner>();
  connection.onStoreChange((change) => {
    const snapshot = change.type === 'appSnapshot';
    if (snapshot || (change.type === 'section' && change.section === 'terminalActivity')) {
      for (const event of terminalActivityChanges(activity, sectionValue('terminalActivity'))) {
        for (const listener of [...activityListeners]) listener(event);
      }
    }
    if (snapshot || (change.type === 'section' && change.section === 'terminalTabs')) {
      // A window never claims a size ('' owns nothing): a phone's grid is followed.
      for (const event of terminalSizeOwnerChanges(owners, sectionValue('terminalTabs'), '')) {
        for (const listener of [...sizeOwnerListeners]) listener(event);
      }
    }
  });

  const api: Pick<DesktopApi, DirectKey<'terminal'>> = {
    async termEnsure(id: unknown, cwd: unknown, profile: unknown): Promise<TerminalSession> {
      const { method, params } = routeDesktopOperation('termEnsure', [
        typeof id === 'string' && id ? id : null,
        typeof cwd === 'string' && cwd ? cwd : null,
        typeof profile === 'string' && profile ? profile : null,
      ]);
      const value = await ctx.call(method, params);
      if (!value || typeof value !== 'object') {
        throw new Error('The service terminal did not return a session.');
      }
      const ensured = sessionOf(terminalReply(value));
      // A tab this connection does not read yet is attached: its output streams from the attach's position, and the attach's
      // replay is the screen up to there; an attach in flight answers for it. A tab already read streams as it is.
      const pending = attaching.get(ensured.id) ?? (attached.has(ensured.id) ? null : subscribeFeed(ensured.id));
      if (!pending) return ensured;
      // The shell runs whatever the attach answers, so the ensure answers it: a shell already gone has nothing to stream, and an
      // attach lost with the link leaves the tab to the next link's (a retried ensure without an id would spawn a second shell).
      return (await pending.catch(() => null)) ?? ensured;
    },
    termAttach: (id: unknown): Promise<TerminalSession | null> => attach(id as string),
    termProfiles: async () => {
      const { method, params } = routeDesktopOperation('termProfiles', []);
      // The profile list is the core's answer as Node gave it.
      return (await ctx.call(method, params)) as Awaited<ReturnType<NonNullable<DesktopApi['termProfiles']>>>;
    },
    termWrite(id: unknown, data: unknown): void {
      // Keystrokes take the fire-and-forget lane, and one sent while the link is down is dropped.
      const route = routeDesktopNotification('termWrite', [id, data]);
      try {
        if (route) connection.notify(route.method, route.params);
      } catch {
        // dropped
      }
    },
    termResize(id: unknown, cols: unknown, rows: unknown): void {
      const route = routeDesktopNotification('termResize', [id, cols, rows]);
      try {
        if (route) connection.notify(route.method, route.params);
      } catch {
        // dropped
      }
    },
    termAcknowledge(id: unknown, charCount: unknown): void {
      buffer.acknowledge(String(id || ''), Number(charCount));
    },
    async termDispose(id: unknown): Promise<void> {
      const tab = id as string;
      buffer.release(tab);
      // A new tab under this id has a feed of its own, which its ensure attaches; an attach in flight is the old tab's.
      attached.delete(tab);
      attaching.delete(tab);
      paused.delete(tab);
      positions.forget(tab);
      const { method, params } = routeDesktopOperation('termDispose', [tab]);
      await ctx.call(method, params).catch(() => {});
    },
    termFocus(id: unknown, focused: unknown): void {
      if (typeof id !== 'string' || !id) return;
      const { method, params } = routeDesktopOperation('termFocus', [id, focused === true]);
      void ctx.call(method, params).catch(() => {});
    },
    async termActivity(): Promise<TerminalActivityEvent[]> {
      await connection.whenSynced();
      return termActivity(connection.snapshot())
        .map(readTerminalActivityEvent)
        .filter((event): event is TerminalActivityEvent => event !== null);
    },
    claimTerminalRun: async (requestId: unknown): Promise<boolean> => {
      const claimed = { requestId: requiredString(requestId, 'terminal run request id', 128) };
      connection.notify(TERMINAL_RUN_CLAIMED, claimed);
      return true;
    },
    subscribeTermData: (listener: (event: TerminalDataEvent) => void) => listen(dataListeners, listener),
    subscribeTermSizeOwner: (listener: (event: TerminalSizeOwnerEvent) => void) => listen(sizeOwnerListeners, listener),
    subscribeTermActivity: (listener: (event: TerminalActivityEvent) => void) => listen(activityListeners, listener),
    onTerminalRunRequested: (listener: (request: DesktopTerminalRunRequest) => void) => listen(runListeners, listener),
  };
  return api;
}
