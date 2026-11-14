/**
 * `host/window/open|close|focus` (core → host) and the two things this desktop tells the core about its windows:
 * `host/window/closed` and `host/state/set{windowFocus}`. A pure module over injected deps (no BrowserWindow), so
 * main/index.ts supplies what `showConnectionWindow`, the window close and the focus calls do.
 */
import type {
  HostWindowCloseParams,
  HostWindowFocusParams,
  HostWindowOpenParams,
  HostWindowOpenResult,
  WindowFocusEntry,
} from '../../../../../packages/protocol/src/index.ts';
import { type HostConnection, HostRpcError, HOST_INVALID_PARAMS, HOST_METHOD, objectParams } from '../host/connection';

export const WINDOW_HOST_METHOD = {
  open: HOST_METHOD.hostWindowOpen,
  close: HOST_METHOD.hostWindowClose,
  focus: HOST_METHOD.hostWindowFocus,
  closed: HOST_METHOD.hostWindowClosed,
  stateSet: 'host/state/set',
} as const;

/** Focus, blur, show and hide arrive in bursts (one click moves focus between two windows). */
const FOCUS_DEBOUNCE_MS = 100;

export interface WindowHostDeps {
  /** Opens or focuses the server's window (joins one being created); false when it could not be made. */
  open(params: { connectionId: string; kind: HostWindowOpenParams['kind']; name: string }): Promise<boolean>;
  close(connectionId: string): void;
  /** `local` is the main window; `sessionId` shows that session in it. */
  focus(connectionId: string, sessionId?: string): void;
  /** Sends `host/window/closed` (a notification) or `host/state/set` (a request) to the core. */
  report(method: string, params: unknown): void;
  debounceMs?: number;
}

export interface WindowHost {
  handlers: Record<string, (params: unknown) => Promise<unknown>>;
  /** A window the core asked for is gone: `byUser` unless the app is quitting. Sent only for a window the core opened
   *  through `host/window/open` on this connection: a core that does not drive the server windows never opens one, so it is
   *  never told (it does not take `host/window/closed`), and a window the person opened is not the core's to hear about. */
  windowClosed(connectionId: string, byUser: boolean): void;
  /** The current state of every window; reported to the core once the burst settles, and only when it changed. */
  publishFocus(windows: WindowFocusEntry[]): void;
  dispose(): void;
}

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value) {
    throw new HostRpcError(HOST_INVALID_PARAMS, `${method} needs a connectionId.`);
  }
  return value;
}

function windowsKey(windows: readonly WindowFocusEntry[]): string {
  return JSON.stringify(
    [...windows]
      .sort((a, b) => (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0))
      .map((w) => [w.connectionId, w.visible, w.focused, w.sessionIds ?? []])
  );
}

export function createWindowHost(deps: WindowHostDeps): WindowHost {
  const opening = new Map<string, Promise<HostWindowOpenResult>>();
  /** The windows the core asked for (an open it was answered `opened: true`); what `windowClosed` reports. */
  const asked = new Set<string>();
  const debounceMs = deps.debounceMs ?? FOCUS_DEBOUNCE_MS;
  let pending: WindowFocusEntry[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported: string | null = null;

  const flush = (): void => {
    timer = null;
    const windows = pending;
    pending = null;
    if (!windows) return;
    const key = windowsKey(windows);
    if (key === reported) return;
    reported = key;
    deps.report(WINDOW_HOST_METHOD.stateSet, { key: 'windowFocus', value: { windows } });
  };

  const handlers: WindowHost['handlers'] = {
    [WINDOW_HOST_METHOD.open]: async (params) => {
      const p = objectParams<HostWindowOpenParams>(params, WINDOW_HOST_METHOD.open);
      const connectionId = requireId(p.connectionId, WINDOW_HOST_METHOD.open);
      if (p.kind !== 'ssh' || typeof p.name !== 'string') {
        throw new HostRpcError(HOST_INVALID_PARAMS, 'host/window/open needs kind "ssh" and a name.');
      }
      const inflight = opening.get(connectionId);
      if (inflight) return inflight;
      const request = deps
        .open({ connectionId, kind: p.kind, name: p.name })
        .then((opened): HostWindowOpenResult => {
          if (opened) asked.add(connectionId);
          return { opened };
        })
        .catch((): HostWindowOpenResult => ({ opened: false }))
        .finally(() => {
          if (opening.get(connectionId) === request) opening.delete(connectionId);
        });
      opening.set(connectionId, request);
      return request;
    },
    [WINDOW_HOST_METHOD.close]: async (params) => {
      deps.close(requireId(objectParams<HostWindowCloseParams>(params, WINDOW_HOST_METHOD.close).connectionId, WINDOW_HOST_METHOD.close));
      return {};
    },
    [WINDOW_HOST_METHOD.focus]: async (params) => {
      const p = objectParams<HostWindowFocusParams>(params, WINDOW_HOST_METHOD.focus);
      const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined;
      deps.focus(requireId(p.connectionId, WINDOW_HOST_METHOD.focus), sessionId);
      return {};
    },
  };

  return {
    handlers,
    windowClosed: (connectionId, byUser) => {
      if (!asked.delete(connectionId)) return;
      deps.report(WINDOW_HOST_METHOD.closed, { connectionId, byUser });
    },
    publishFocus: (windows) => {
      pending = windows;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      // The next connection starts from nothing: its core has not been told, and has asked for no window.
      reported = null;
      asked.clear();
    },
  };
}

/** The one install function: registers the three handlers on the host connection and clears state when it closes. */
export function registerWindowHost(connection: HostConnection, deps: WindowHostDeps): WindowHost {
  const host = createWindowHost(deps);
  for (const [method, handler] of Object.entries(host.handlers)) connection.handleRequest(method, handler);
  connection.onClose(() => host.dispose());
  return host;
}
