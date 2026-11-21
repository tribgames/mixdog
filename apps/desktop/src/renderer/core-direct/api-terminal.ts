import type { DesktopApi } from '../../shared/contract';
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';
import type { DirectKey } from '../../shared/desktop-api-split';
import { routeDesktopNotification, routeDesktopOperation } from '../../shared/core-lanes/desktop-operation-route';
import { termActivity } from '../../shared/core-lanes/section-reads';
import { readTerminalActivityEvent, type TerminalActivityEvent } from '../../shared/terminal-activity';
import { terminalActivityChanges, terminalReply, terminalSizeOwnerChanges } from '../../shared/terminal-protocol';
import { requiredString } from '../../shared/scm-input';
import type { TerminalSizeOwner, TerminalSizeOwnerEvent } from '../../shared/terminal-size-owner';
import type { TerminalDataEvent } from './terminal-data-buffer';
import { createTerminalFeed, sessionOf, type TerminalSession } from './terminal-feed';
import type { DirectContext } from './context';

/** The notification that tells the core the pane showing a run's terminal claimed its reveal. */
const TERMINAL_RUN_CLAIMED = 'ui/terminalRun/claimed';

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
  const feed = createTerminalFeed(ctx, (event) => {
    for (const listener of [...dataListeners]) listener(event);
  });
  connection.onEvent((event) => {
    if (event.type !== 'notification') return;
    const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
    if (method !== 'ui/openRequested') return;
    const open = params as ({ kind?: unknown; sessionId?: unknown } & Record<string, unknown>) | undefined;
    if (open?.kind !== 'terminal' || typeof open.sessionId !== 'string' || !open.sessionId) return;
    const { kind: _kind, ...request } = open;
    for (const listener of [...runListeners]) listener(request as unknown as DesktopTerminalRunRequest);
  });

  // The activity and size owner are read from the sections the connection holds each time one changes.
  const sectionValue = (name: 'terminalActivity' | 'terminalTabs'): unknown =>
    connection.protocolClient()?.store.section(name, null)?.value;
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
      const pending = feed.joinOrAttach(ensured.id);
      if (!pending) return ensured;
      // The shell runs whatever the attach answers, so the ensure answers it: a shell already gone has nothing to stream, and an
      // attach lost with the link leaves the tab to the next link's (a retried ensure without an id would spawn a second shell).
      return (await pending.catch(() => null)) ?? ensured;
    },
    termAttach: (id: unknown): Promise<TerminalSession | null> => feed.attach(id as string),
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
      feed.acknowledge(String(id || ''), Number(charCount));
    },
    async termDispose(id: unknown): Promise<void> {
      const tab = id as string;
      // A new tab under this id has a feed of its own, which its ensure attaches; an attach in flight is the old tab's.
      feed.dispose(tab);
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
      // No open link to the core: nothing is sent and the pane is told the claim did not go (the page ignores the answer).
      try {
        connection.notify(TERMINAL_RUN_CLAIMED, claimed);
      } catch {
        return false;
      }
      return true;
    },
    subscribeTermData: (listener: (event: TerminalDataEvent) => void) => listen(dataListeners, listener),
    subscribeTermSizeOwner: (listener: (event: TerminalSizeOwnerEvent) => void) => listen(sizeOwnerListeners, listener),
    subscribeTermActivity: (listener: (event: TerminalActivityEvent) => void) => listen(activityListeners, listener),
    onTerminalRunRequested: (listener: (request: DesktopTerminalRunRequest) => void) => listen(runListeners, listener),
  };
  return api;
}
