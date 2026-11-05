/**
 * Host → core reports that are plain state of this machine: power events,
 * the updater's state, and the SSH tunnel the local core bridges phones to.
 * All of them are re-sent after a reconnect where they are state, never
 * replayed where they are events.
 */
import type {
  HostPowerParams,
  HostRemoteTargetSetParams,
  HostUpdateCommandParams,
  HostUpdateReportParams,
  JsonValue,
} from '../../../../../packages/protocol/src/index.ts';
import { HOST_METHOD, type HostConnection, HostRpcError, HOST_INVALID_PARAMS, objectParams } from './connection';

export type PowerEvent = HostPowerParams['event'];

/** The desktop updater, as the window-process request handler used it (index.ts `updaterInstall`). */
export interface HostUpdater {
  /** Checks and answers the state; with no updater controller, the current state. */
  check(): Promise<unknown>;
  getState(): { status: string };
  /** True (and the state says why) when an unconfirmed install would be held back. */
  confirmBusy(): Promise<boolean>;
  install(confirmed: boolean): Promise<unknown>;
}

export interface RemoteTarget {
  endpoint: string;
  token?: string;
}

export function createHostReports(
  connection: HostConnection,
  updater: HostUpdater | undefined,
  /** An install that failed after the caller was answered. */
  onInstallFailed: (error: unknown) => void
) {
  let target: RemoteTarget | null = null;
  let updaterState: JsonValue | undefined;

  if (updater) {
    connection.handleRequest('host/update/command', async (params) => {
      const { action, confirmed: confirmedParam } = objectParams<HostUpdateCommandParams>(params, 'host/update/command');
      if (action === 'check') return (await updater.check()) ?? updater.getState();
      if (action === 'install') {
        // Only a confirmed request installs past running agent tasks; otherwise the
        // answer is the ready state saying why not.
        const confirmed = confirmedParam === true;
        const held = !confirmed && updater.getState().status === 'ready' && (await updater.confirmBusy());
        const state = updater.getState();
        // Installing restarts the app, so the caller is answered first.
        if (!held && updater.getState().status === 'ready') {
          // Node let a failed install escape to the process; here it is reported, never discarded.
          setImmediate(() => void Promise.resolve().then(() => updater.install(confirmed)).catch(onInstallFailed));
        }
        return state;
      }
      throw new HostRpcError(HOST_INVALID_PARAMS, 'host/update/command action must be check or install.');
    });
  }

  const sendTarget = (): Promise<unknown> =>
    connection.request(
      HOST_METHOD.remoteTargetSet,
      (target ? { endpoint: target.endpoint, token: target.token } : {}) satisfies HostRemoteTargetSetParams
    );

  return {
    /** Sleep and wake, and a network that came back (`resume`): relay, WebRTC and watcher react. */
    power(event: PowerEvent): void {
      connection.notify(HOST_METHOD.power, { event } satisfies HostPowerParams);
    },
    /** The updater's `DesktopUpdaterState`, as it changes. */
    updateState(state: JsonValue): void {
      updaterState = state;
      connection.notify(HOST_METHOD.updateReport, { state } satisfies HostUpdateReportParams);
    },
    /** The SSH tunnel to a server core, or null for the local core. */
    setRemoteTarget(next: RemoteTarget | null): Promise<unknown> {
      target = next;
      return sendTarget();
    },
    /** After a (re)claim: state the core must know again. */
    resend(): void {
      if (updaterState !== undefined) {
        connection.notify(HOST_METHOD.updateReport, { state: updaterState } satisfies HostUpdateReportParams);
      }
      if (target) void sendTarget().catch(() => undefined);
    },
  };
}
