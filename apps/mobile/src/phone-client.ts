// The phone web UI's one connection: `packages/protocol-client` over the relay.
// The UI reads folded state from `client.store` and calls typed methods; no
// desktop-method table or message shim sits between them.
import {
  connect,
  DEFAULT_LADDER,
  ladderDelay,
  sessionReducer,
  type LadderConfig,
  type ProtocolClient,
  type SessionFold,
  type ThreadReducer,
} from '../../../packages/protocol-client/src/index.ts';
import { CLOSE_DESKTOP_OFFLINE, phoneConnectionOf, terminalOfClose, type PhoneConnection } from './phone-status.ts';
import { createScreenReporter, type ScreenReporter, type ScreenSource } from './screen-reporter.ts';
import { createRelayConnector, type CloseInfo, type RelayConnector, type RelayConnectorDeps } from './relay-connector.ts';

export interface PhoneClientOptions extends Omit<RelayConnectorDeps, 'closed'> {
  /** The relay-hosted desktop this phone is paired with; one reconnect ladder per target. */
  readonly deviceId: string;
  /** The version the relay serves this page at; the core's `initialize` gate compares it exactly. */
  readonly version: string;
  readonly build?: string;
  /** Defaults to the `DesktopSessionState` fold. */
  readonly threadReducer?: ThreadReducer<SessionFold>;
  readonly random?: () => number;
  /** Receives every change of what the UI shows, starting with `connecting`. */
  readonly onConnection: (connection: PhoneConnection) => void;
  /** Stops the first-connect retries. */
  readonly signal?: AbortSignal;
  /** What the phone shows; the core reads it as `ui/screenSessions/changed` to hold back pushes for a thread being looked at. */
  readonly screen?: ScreenSource;
  /** Every socket end, after the phone has taken its own decisions from it (terminal states, redial pacing). */
  readonly onClose?: (code: number, reason: string, info: CloseInfo) => void;
}

export interface PhoneClient {
  readonly client: ProtocolClient<SessionFold>;
  /** Page lifecycle hooks of the transport session. */
  readonly link: Pick<RelayConnector, 'hidden' | 'suspend' | 'suspended'> & {
    /** Foreground: releases a suspension, probes the live socket, and cuts a running redial wait short. */
    wake(): void;
  };
  /** Present when `PhoneClientOptions.screen` was given: call `refresh()` when the page or the shown threads change. */
  readonly screen?: ScreenReporter;
}

/** While the relay says the PC is offline nothing can connect, so redials back off this far instead of every few seconds. */
export const OFFLINE_LADDER_CAP_MS = 60_000;
/** The first redial after the relay ended a live connection is spread over this window, so a relay restart does not meet every phone at once. */
export const FLEET_SPREAD_MS = 1_500;

/**
 * Connects, retrying the first connection on the client library's ladder (the library itself only reconnects a connection
 * that was ready once). A revoked pairing or a version mismatch is terminal: it is reported, the client is closed, and no
 * ladder runs. Rejects only for such a terminal state or an aborted signal.
 */
export async function connectPhone(options: PhoneClientOptions): Promise<PhoneClient> {
  const random = options.random ?? Math.random;
  let terminal: 'update-required' | 'pairing-lost' | undefined;
  let client: ProtocolClient<SessionFold> | undefined;
  const settle = (state: 'update-required' | 'pairing-lost'): void => {
    if (terminal) return;
    terminal = state;
    options.onConnection({ state });
    void client?.close();
  };
  // Redial pacing on top of the library ladder, read by it on every delay.
  let offline = false;
  let spread = false;
  let quiet = false;
  const ladder: LadderConfig = {
    get baseMs() {
      const first = spread;
      spread = false;
      return first ? FLEET_SPREAD_MS : DEFAULT_LADDER.baseMs;
    },
    get capMs() {
      return offline ? OFFLINE_LADDER_CAP_MS : DEFAULT_LADDER.capMs;
    },
  };
  // A wake cuts the running redial wait short: waiting out a grown backoff after the user came back is the gap they watch.
  const sleepers = new Set<() => void>();
  const sleep = (ms: number): Promise<void> =>
    new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        sleepers.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      sleepers.add(finish);
    });
  const connector = createRelayConnector({
    ...options,
    closed: (code, reason, info) => {
      const state = terminalOfClose(code, reason);
      if (state) settle(state);
      offline = code === CLOSE_DESKTOP_OFFLINE;
      spread = info.remote && info.ready;
      quiet = info.quiet;
      options.onClose?.(code, reason, info);
    },
  });
  options.onConnection({ state: 'connecting' });
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted');
    try {
      client = await connect<SessionFold>({
        target: { id: options.deviceId },
        connector,
        clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: options.version, kind: 'phone', build: options.build },
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: options.threadReducer ?? sessionReducer,
        clock: { sleep },
        random,
        ladder,
      });
    } catch (error) {
      if (terminal) throw error;
      const detail = (error as { detail?: { kind?: string } }).detail;
      if (detail?.kind === 'versionRefused') {
        settle('update-required');
        throw error;
      }
      await sleep(ladderDelay(attempt, random(), ladder));
      continue;
    }
    break;
  }
  let last: PhoneConnection | undefined;
  const report = (shown: PhoneConnection): void => {
    if (terminal) return;
    // A redial the page chose (recycle, background) or one that has not yet had a connection is connecting, not an outage.
    const next: PhoneConnection =
      shown.state === 'reconnecting' && (quiet || connector.suspended) ? { state: 'connecting' } : shown;
    if (last?.state === next.state) return;
    last = next;
    options.onConnection(next);
  };
  client.on((event) => {
    if (event.type === 'status') {
      if (event.status.state === 'ready') offline = false;
      report(phoneConnectionOf(event.status));
      if (event.status.state === 'ready') quiet = false;
    }
  });
  report(phoneConnectionOf(client.status));
  if (terminal) void client.close();
  const screen = options.screen ? createScreenReporter(client, options.screen) : undefined;
  const link: PhoneClient['link'] = {
    hidden: () => connector.hidden(),
    suspend: () => connector.suspend(),
    get suspended() {
      return connector.suspended;
    },
    wake: () => {
      connector.wake();
      for (const finish of [...sleepers]) finish();
    },
  };
  return { client, link, ...(screen ? { screen } : {}) };
}
