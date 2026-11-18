// The window's `sections` API served by its own client (the composed renderer API, createSessionsApi's sibling). The
// section store is the client library's own, in this renderer: a snapshot is read from it, a change of it is a push, and
// the scoped feeds a window follows (a file watch, the ports list, `media:<jobId>`, a sign-in flow) are the connection's.
// Nothing is relayed, so a whole-store replace is one synchronous swap: when the connection was replaced, and when a leg
// that came back has folded its app snapshot (it may be a restarted core's).
import type { DesktopApi } from '../../shared/contract.ts';
import {
  EVENT_SECTIONS,
  isRendererProtocolMethod,
  isScopedSectionFeed,
  type DesktopSectionEntry,
  type DesktopSectionsApi,
  type DesktopSectionsPush,
} from '../../shared/contract-sections.ts';
import { loginUpdateOf } from '../../shared/core-lanes/login-feed.ts';
import type { DirectContext } from './context.ts';
import type { RendererWindow } from './renderer-connection.ts';

type FsChange = { watchId: string; changedPaths: string[]; kind?: string };
type LoginUpdate = { flowId: string; state: unknown };

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
  // Whether the connection has been open: the window is composed before its first open, whose app snapshot reaches the window as
  // section changes, so only a ready after that one is a leg that came back. Set after the first open's own status push.
  let opened = connection.client() !== null;
  void connection.whenSynced().then(() => void (opened = true), () => undefined);
  connection.onReplaced(() => void (opened = true));

  // The whole store at once, then the status: a store refolded from another core (a restarted one numbers its revisions
  // again and drops what it no longer holds) is taken whole, never through the revision guard of single changes.
  const replaceWhole = (send: (push: DesktopSectionsPush) => void): void => {
    const { entries, epoch, status, link } = connection.snapshot();
    send({ kind: 'replace', stage: 'begin' });
    send({ kind: 'replace', stage: 'chunk', entries });
    send({ kind: 'replace', stage: 'commit', epoch });
    send({ kind: 'status', status, ...(link ? { link } : {}) });
  };

  const subscribeSource = (listener: (push: DesktopSectionsPush) => void): (() => void) => {
    pushListeners.add(listener);
    // A burst of store changes (an app snapshot folds all its sections in one synchronous run) leaves one push: the changed
    // `(section, key)` pairs with their entries as they are when it is sent. The set is drained once per burst, in a later
    // loop turn than the library's folding of the frame that caused it.
    const dirty = new Map<string, { section: string; key: string | null }>();
    let scheduled = false;
    const flush = (): void => {
      scheduled = false;
      const store = connection.client()?.store as
        | { section(section: string, key?: string | null): DesktopSectionEntry | undefined }
        | undefined;
      const changes = store
        ? [...dirty.values()].map(({ section, key }) => ({ section, key, entry: store.section(section, key) ?? null }))
        : [];
      dirty.clear();
      if (changes.length > 0 && pushListeners.has(listener)) listener({ kind: 'sections', changes });
    };
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(flush, 0);
    };
    // The whole store supersedes the changes still waiting for the push.
    const replaceAll = (): void => {
      dirty.clear();
      replaceWhole(listener);
    };
    // A leg of the same client came back: the app snapshot it folds may be another core's, so the window takes the whole
    // store once that snapshot is announced (what the main relay's `reconnected` did).
    let awaitingAppSnapshot = false;
    const offStore = connection.onStoreChange((change) => {
      if (change.type === 'appSnapshot') {
        if (awaitingAppSnapshot) {
          awaitingAppSnapshot = false;
          replaceAll();
        }
        return;
      }
      // The core refused to restore the app subscription: the store keeps the previous app state, no snapshot is coming.
      const sub = change as { type: string; feedId?: string; state?: string };
      if (sub.type === 'subscription' && sub.feedId === 'app' && sub.state === 'lost') {
        awaitingAppSnapshot = false;
        return;
      }
      if (change.type !== 'section' || change.section === undefined) return;
      const store = connection.client()?.store as { owed?: unknown } | undefined;
      if (!store) return;
      // A tell is not state: the announcement of a snapshot (a leg that came back) is not one.
      if (store.owed && EVENT_SECTIONS.includes(change.section)) return;
      dirty.set(`${change.section}\u0000${change.key ?? ''}`, { section: change.section, key: change.key ?? null });
      schedule();
    });
    // What the window shows of the connection is the connection's own state, published at every change (the ladder, a reopen,
    // an open that failed): nothing here keeps a second account of it.
    let shown = connection.status;
    const offState = connection.onState(() => {
      if (!pushListeners.has(listener)) return;
      const next = connection.status;
      if (next === 'ready' && shown !== 'ready' && opened) awaitingAppSnapshot = true;
      shown = next;
      listener({ kind: 'status', status: next, link: connection.link() });
    });
    // A replaced connection holds another client's store, already folded when it is announced.
    const offReplaced = connection.onReplaced(() => replaceAll());
    return () => {
      pushListeners.delete(listener);
      offStore();
      offState();
      offReplaced();
    };
  };

  const sections: DesktopSectionsApi = {
    core: async () => true,
    snapshot: async () => connection.snapshot(),
    subscribe: subscribeSource,
    reconnect: () => connection.reopen(),
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
