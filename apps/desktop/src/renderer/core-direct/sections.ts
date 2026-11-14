// The window's `sections` API served by its own client (the composed renderer API, createSessionsApi's sibling). The
// section store is the client library's own, in this renderer: a snapshot is read from it, a change of it is a push, and
// the scoped feeds a window follows (a file watch, the ports list, `media:<jobId>`, a sign-in flow) are the connection's.
// Nothing is relayed, so the replace stages of the old relay are one synchronous swap when the connection was replaced.
import type { DesktopApi } from '../../shared/contract.ts';
import {
  EVENT_SECTIONS,
  isRendererProtocolMethod,
  isScopedSectionFeed,
  type DesktopProtocolStatus,
  type DesktopSectionsApi,
  type DesktopSectionsPush,
} from '../../shared/contract-sections.ts';
import { loginUpdateOf } from '../../shared/core-lanes/login-feed.ts';
import type { DirectContext } from './context.ts';
import type { RendererWindow } from './renderer-connection.ts';

type FsChange = { watchId: string; changedPaths: string[]; kind?: string };
type LoginUpdate = { flowId: string; state: unknown };

const toStatus = (state: string): DesktopProtocolStatus =>
  state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';

export function createSectionsApi(ctx: DirectContext): Pick<DesktopApi, 'sections'> {
  const { connection } = ctx;
  const pushListeners = new Set<(push: DesktopSectionsPush) => void>();
  const fsListeners = new Set<(change: FsChange) => void>();
  const loginListeners = new Set<(update: LoginUpdate) => void>();
  const lostListeners = new Set<(update: { flowId: string }) => void>();
  const push = (value: DesktopSectionsPush): void => {
    for (const listener of [...pushListeners]) listener(value);
  };

  // The window of this connection: scoped feed notifications, the loss of a sign-in feed and the sections a scoped feed
  // carries reach the listeners below.
  const window: RendererWindow = {
    push,
    notification(method, params) {
      if (method === 'fs/changed') {
        for (const listener of [...fsListeners]) listener(params as FsChange);
        return;
      }
      const login = loginUpdateOf(method, params);
      if (login) for (const listener of [...loginListeners]) listener(login);
    },
    loginFeedLost(flowId) {
      for (const listener of [...lostListeners]) listener({ flowId });
    },
  };
  connection.attach(window);

  const subscribeSource = (listener: (push: DesktopSectionsPush) => void): (() => void) => {
    pushListeners.add(listener);
    const offStore = connection.onStoreChange((change) => {
      if (change.type !== 'section' || change.section === undefined) return;
      const store = connection.client()?.store as
        | { section(section: string, key?: string | null): never; owed?: unknown }
        | undefined;
      if (!store) return;
      // A tell is not state: the announcement of a snapshot (a leg that came back) is not one.
      if (store.owed && EVENT_SECTIONS.includes(change.section)) return;
      const key = change.key ?? null;
      push({ kind: 'sections', changes: [{ section: change.section, key, entry: store.section(change.section, key) ?? null }] });
    });
    const offEvent = connection.onEvent((event) => {
      if (event.type === 'status') push({ kind: 'status', status: toStatus((event as { status: { state: string } }).status.state) });
    });
    // A replaced connection holds another client's store (a restarted core numbers its revisions again): the section
    // store takes the whole store at once, then the status.
    const offReplaced = connection.onReplaced(() => {
      const { entries, epoch, status } = connection.snapshot();
      push({ kind: 'replace', stage: 'begin' });
      push({ kind: 'replace', stage: 'chunk', entries });
      push({ kind: 'replace', stage: 'commit', epoch });
      push({ kind: 'status', status });
    });
    // The first open has no event of its own: its outcome is the status.
    const settled = (): void => {
      if (pushListeners.has(listener)) push({ kind: 'status', status: connection.status });
    };
    connection.whenSynced().then(settled, settled);
    return () => {
      pushListeners.delete(listener);
      offStore();
      offEvent();
      offReplaced();
    };
  };

  const sections: DesktopSectionsApi = {
    core: async () => true,
    snapshot: async () => connection.snapshot(),
    subscribe: subscribeSource,
    async call(method, params) {
      // A typo guard only: the core's Window allowlist is the boundary.
      if (!isRendererProtocolMethod(method)) throw new Error('This core method is not available to the window.');
      if (method === 'system/ports/subscribe' || method === 'system/ports/unsubscribe') {
        return connection.viewPorts(window, method === 'system/ports/subscribe');
      }
      if (method === 'feed/subscribe' || method === 'feed/unsubscribe') {
        const feedId = (params as { feedId?: unknown } | null)?.feedId;
        if (!isScopedSectionFeed(feedId)) throw new Error('This feed is not available to the window.');
        return method === 'feed/subscribe' ? connection.watchFeed(window, feedId) : connection.unwatchFeed(window, feedId);
      }
      const watchId = (params as { watchId?: unknown } | null)?.watchId;
      if ((method === 'fs/watch' || method === 'fs/unwatch') && typeof watchId === 'string') {
        return method === 'fs/watch'
          ? connection.watchFiles(window, { ...(params as object), watchId })
          : connection.unwatchFiles(watchId);
      }
      return connection.call(method, params);
    },
    subscribeFsChanged(listener) {
      fsListeners.add(listener);
      return () => void fsListeners.delete(listener);
    },
    subscribeLoginUpdated(listener) {
      loginListeners.add(listener);
      return () => void loginListeners.delete(listener);
    },
    subscribeLoginFeedLost(listener) {
      lostListeners.add(listener);
      return () => void lostListeners.delete(listener);
    },
    async loginFeed(flowId) {
      return connection.loginFeed(String(flowId));
    },
  };
  return { sections };
}
