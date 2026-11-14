/**
 * The host role of Electron main (DS §12). The protocol connection itself is
 * owned by the main-process client; this file is the one seam the host side
 * needs from it, so every host module is testable against an in-memory pair.
 */
import type { HostCapabilities } from '../../../../../packages/protocol/src/index.ts';

export const HOST_METHOD = {
  claim: 'host/claim',
  browserCommand: 'host/browser/command',
  browserViewFrames: 'host/browser/viewFrames',
  browserFrame: 'host/browser/frame',
  systemProxyResolve: 'host/systemProxy/resolve',
  notificationShow: 'host/notification/show',
  notificationClicked: 'host/notification/clicked',
  notificationStatus: 'host/notification/status',
  power: 'host/power',
  updateReport: 'host/update/report',
  remoteTargetSet: 'host/remoteTarget/set',
  humanOnlyBegin: 'host/humanOnly/begin',
  humanOnlyEnd: 'host/humanOnly/end',
  hostWindowOpen: 'host/window/open',
  hostWindowClose: 'host/window/close',
  hostWindowFocus: 'host/window/focus',
  hostWindowClosed: 'host/window/closed',
} as const;

/** What the connection offers a host module. `request` rejects with `HostRpcError`. */
export interface HostConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** One binary X17 frame (needs `capabilities.host.media`). */
  sendBinary(frame: Uint8Array): void;
  /** Serve one core→host request; the signal aborts when the core abandons it. */
  handleRequest(method: string, handler: (params: unknown, signal: AbortSignal) => Promise<unknown>): void;
  /** Serve one core→host notification. */
  handleNotification(method: string, handler: (params: unknown) => void): void;
  /** The method names registered through handleRequest and handleNotification, sorted. */
  servedMethods(): string[];
  /** Runs `listener` once when the connection closes. */
  onClose(listener: () => void): void;
}

/** A JSON-RPC error answered to the core. */
export class HostRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'HostRpcError';
    this.code = code;
    this.data = data;
  }
}

/** JSON-RPC server-error range: a command that ran and failed. */
export const HOST_COMMAND_FAILED = -32000;
/** JSON-RPC invalid params. */
export const HOST_INVALID_PARAMS = -32602;

/** `capabilities.host` declared at `initialize` (DS §12.2). */
export const HOST_CAPABILITIES = {
  browser: true,
  // `host/visualize/command` (visualize.ts), `host/capture/fileSnapshot` and
  // `host/localPage/url` (files.ts), `host/update/command` (lifecycle.ts).
  visualize: true,
  notifications: true,
  systemProxy: true,
  power: true,
  media: true,
  updater: true,
  files: true,
  // `host/computer/*`: capture and displays (computer.ts), foregroundLease, internalWindows and pointerFeedback
  // (computer-lease.ts, computer-internal-windows.ts, computer-pointer.ts), cursorPrepare, appWindows, appInput, pixels,
  // permissions and command (computer-cursor.ts, computer-app-windows.ts, computer-app-input.ts, computer-pixels.ts,
  // computer-permissions.ts, computer-command.ts). A core that does not drive Computer Use never calls the latter six.
  computer: true,
  // `host/window/open|close|focus` (connections/window-host.ts); a core without the connections service never calls them.
  windows: true,
} as const satisfies HostCapabilities;

/** The fields of a generated protocol params type, each still to be checked (a wire value is unknown). */
export type WireFields<T> = { [K in keyof T]?: unknown };

/** `T` is the generated params type: reading a field it does not declare does not compile. */
export function objectParams<T extends object = Record<string, unknown>>(value: unknown, method: string): WireFields<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostRpcError(HOST_INVALID_PARAMS, `${method} expects an object.`);
  }
  return value as WireFields<T>;
}
