// One ipcMain registration per channel, many windows behind it. Each window's
// handlers (registered through its own scope, bound to its connection) live
// in a table keyed by webContents id; every call first resolves the sender's
// connection and is answered only by that window's table.
import { ConnectionError } from './errors';

interface RoutedSender {
  readonly id: number;
}

interface RoutedEvent {
  readonly sender: RoutedSender;
}

// Handlers declare Electron's own event and argument types, so the listener
// types must accept any of them (the same looseness as ipcMain's own API).
// biome-ignore lint/suspicious/noExplicitAny: handlers are typed by their registrants.
type InvokeListener = (event: any, ...args: any[]) => unknown;
// biome-ignore lint/suspicious/noExplicitAny: handlers are typed by their registrants.
type EventListener = (event: any, ...args: any[]) => void;

/** The ipcMain surface the router drives. */
export interface RouterIpcMain {
  handle(channel: string, listener: InvokeListener): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: EventListener): unknown;
  removeListener(channel: string, listener: EventListener): unknown;
}

/** What one window's IPC registration sees in place of ipcMain. */
export interface WindowIpcScope {
  handle(channel: string, listener: InvokeListener): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: EventListener): this;
  removeListener(channel: string, listener: EventListener): this;
  /** Drops every handler and listener this window registered. */
  dispose(): void;
}

export interface ConnectionIpcRouterOptions {
  ipcMain: RouterIpcMain;
  /** The sender's connection (see resolveWindowConnection); throws when the
   *  window has no route or its connection is gone. */
  resolveSender(sender: RoutedSender): { readonly id: string };
}

interface ScopeState {
  readonly connectionId: string;
  readonly handlers: Map<string, InvokeListener>;
  readonly listeners: Map<EventListener, Array<{ channel: string; wrapped: EventListener }>>;
}

export function createConnectionIpcRouter({ ipcMain, resolveSender }: ConnectionIpcRouterOptions) {
  const scopes = new Map<number, ScopeState>();
  const channelUsers = new Map<string, number>();

  /** The scope that answers `event`, after the sender's route checks out. */
  const routedScope = (event: RoutedEvent): ScopeState => {
    const connection = resolveSender(event.sender);
    const scope = scopes.get(event.sender.id);
    if (!scope || scope.connectionId !== connection.id) {
      throw new ConnectionError('connection-route-missing', 'This window has no handlers for its connection.');
    }
    return scope;
  };

  const retainChannel = (channel: string): void => {
    const users = channelUsers.get(channel) ?? 0;
    channelUsers.set(channel, users + 1);
    if (users > 0) return;
    ipcMain.handle(channel, (event: RoutedEvent, ...args: unknown[]) => {
      const handler = routedScope(event).handlers.get(channel);
      if (!handler) throw new Error(`This window does not handle ${channel}.`);
      return handler(event, ...args);
    });
  };

  const releaseChannel = (channel: string): void => {
    const users = (channelUsers.get(channel) ?? 0) - 1;
    if (users > 0) {
      channelUsers.set(channel, users);
      return;
    }
    channelUsers.delete(channel);
    ipcMain.removeHandler(channel);
  };

  return {
    /** Starts the handler table of one window bound to `connectionId`. */
    scope(webContentsId: number, connectionId: string): WindowIpcScope {
      if (scopes.has(webContentsId)) throw new Error(`Window ${webContentsId} already has IPC handlers.`);
      const state: ScopeState = { connectionId, handlers: new Map(), listeners: new Map() };
      scopes.set(webContentsId, state);
      let disposed = false;
      const scope: WindowIpcScope = {
        handle(channel, listener) {
          if (disposed) throw new Error('The window IPC scope is disposed.');
          if (state.handlers.has(channel)) {
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          state.handlers.set(channel, listener);
          retainChannel(channel);
        },
        removeHandler(channel) {
          if (!state.handlers.delete(channel)) return;
          releaseChannel(channel);
        },
        on(channel, listener) {
          if (disposed) throw new Error('The window IPC scope is disposed.');
          // Fire-and-forget lanes answer nobody: a call from another window,
          // or from one whose route is gone, is dropped.
          const wrapped: EventListener = (event: RoutedEvent, ...args: unknown[]) => {
            if (event?.sender?.id !== webContentsId) return;
            try {
              routedScope(event);
            } catch {
              return;
            }
            listener(event, ...args);
          };
          const registered = state.listeners.get(listener) ?? [];
          registered.push({ channel, wrapped });
          state.listeners.set(listener, registered);
          ipcMain.on(channel, wrapped);
          return scope;
        },
        removeListener(channel, listener) {
          const registered = state.listeners.get(listener);
          const index = registered?.findIndex((entry) => entry.channel === channel) ?? -1;
          if (!registered || index < 0) return scope;
          const [{ wrapped }] = registered.splice(index, 1);
          if (!registered.length) state.listeners.delete(listener);
          ipcMain.removeListener(channel, wrapped);
          return scope;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const channel of [...state.handlers.keys()]) scope.removeHandler(channel);
          for (const [listener, registered] of [...state.listeners]) {
            for (const { channel } of [...registered]) scope.removeListener(channel, listener);
          }
          if (scopes.get(webContentsId) === state) scopes.delete(webContentsId);
        },
      };
      return scope;
    },
  };
}

export type ConnectionIpcRouter = ReturnType<typeof createConnectionIpcRouter>;
