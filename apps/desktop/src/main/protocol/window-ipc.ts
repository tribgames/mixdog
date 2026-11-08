// One window's view of its connection's protocol link: the section mirror, the closed list of detail calls, and the
// scoped feeds the window opened (a file watch, the ports list). A scoped feed lives as long as the window that asked
// for it: closing the window releases it (desktop-services.md §2.1, §6.6 viewer scope).
import { isRendererProtocolMethod, SECTIONS_IPC, type DesktopSectionsPush } from '../../shared/contract-sections';
import type { IpcHandle } from '../ipc';
import type { ProtocolConnection, ProtocolWindow } from './connection';
import { coreErrorForWindow } from './core-error';
import { loginUpdateOf } from './login-feed';

interface WindowIpcOptions {
  connection: Pick<
    ProtocolConnection,
    'snapshot' | 'attach' | 'call' | 'viewPorts' | 'watchFiles' | 'unwatchFiles' | 'loginFeed'
  >;
  handle: IpcHandle;
  /** Delivers to this window; false when it is gone. */
  send(channel: string, value: unknown): boolean;
  removeHandler(channel: string): void;
}

let nextWindowToken = 1;

export function registerProtocolWindowIpc({ connection, handle, send, removeHandler }: WindowIpcOptions): () => void {
  // Watch ids are chosen by the caller and unique per connection, not per window: this window's are namespaced.
  const prefix = `w${nextWindowToken++}:`;

  handle(SECTIONS_IPC.core, () => true);
  handle(SECTIONS_IPC.snapshot, () => connection.snapshot());
  handle(SECTIONS_IPC.loginFeed, (_event, flowId) => connection.loginFeed(String(flowId)));
  handle(SECTIONS_IPC.call, async (_event, method, params) => {
    if (!isRendererProtocolMethod(method)) throw new Error('This core method is not available to the window.');
    if (method === 'system/ports/subscribe' || method === 'system/ports/unsubscribe') {
      return connection.viewPorts(window, method === 'system/ports/subscribe');
    }
    const watchId = (params as { watchId?: unknown } | null)?.watchId;
    if ((method === 'fs/watch' || method === 'fs/unwatch') && typeof watchId === 'string') {
      const owned = `${prefix}${watchId}`;
      // The connection records this window as the owner before the request goes out and sends it again after a
      // reconnect; closing the window releases the watch whether or not the core has answered yet.
      return method === 'fs/watch'
        ? connection.watchFiles(window, { ...(params as object), watchId: owned })
        : connection.unwatchFiles(owned);
    }
    return connection.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  });

  const window: ProtocolWindow = {
    push: (push: DesktopSectionsPush) => void send(SECTIONS_IPC.push, push),
    notification(method, params) {
      if (method === 'fs/changed') {
        const watchId = (params as { watchId?: unknown } | null)?.watchId;
        if (typeof watchId === 'string' && watchId.startsWith(prefix)) {
          send(SECTIONS_IPC.fsChanged, { ...(params as object), watchId: watchId.slice(prefix.length) });
        }
      } else {
        const login = loginUpdateOf(method, params);
        if (login) send(SECTIONS_IPC.loginUpdated, login);
      }
    },
    loginFeedLost: (flowId) => void send(SECTIONS_IPC.loginFeedLost, { flowId }),
  };
  const detach = connection.attach(window);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Detaching releases this window's watches and port view.
    detach();
    removeHandler(SECTIONS_IPC.core);
    removeHandler(SECTIONS_IPC.snapshot);
    removeHandler(SECTIONS_IPC.loginFeed);
    removeHandler(SECTIONS_IPC.call);
  };
}

/** A window whose connection has no core endpoint: it answers the per-connection question, `false`, and nothing else. */
export function registerNoProtocolWindowIpc({
  handle,
  removeHandler,
}: Pick<WindowIpcOptions, 'handle' | 'removeHandler'>): () => void {
  handle(SECTIONS_IPC.core, () => false);
  return () => removeHandler(SECTIONS_IPC.core);
}
