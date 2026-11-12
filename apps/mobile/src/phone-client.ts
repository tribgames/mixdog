// The phone web UI's one connection: `packages/protocol-client` over the relay.
// The UI reads folded state from `client.store` and calls typed methods; no
// desktop-method table or message shim sits between them.
import {
  connect,
  DEFAULT_LADDER,
  sessionReducer,
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
  readonly link: Pick<RelayConnector, 'hidden' | 'suspend' | 'suspended' | 'retire' | 'silentSince'> & {
    /** Foreground: releases a suspension, probes the live socket, and cuts a running redial wait short. */
    wake(): boolean;
  };
  /** Present when `PhoneClientOptions.screen` was given: call `refresh()` when the page or the shown threads change. */
  readonly screen?: ScreenReporter;
}

/** While the relay says the PC is offline nothing can connect, so redials back off this far instead of every few seconds. */
export const OFFLINE_LADDER_CAP_MS = 60_000;
/** The first redial after the relay ended a live connection is spread over this window, so a relay restart does not meet every phone at once. */
export const FLEET_SPREAD_MS = 1_500;
/** The shortest wait of a redial that is not the first of an outage, and the longest while the relay does not say the PC is offline. */
export const REDIAL_MIN_MS = 500;
export const REDIAL_MAX_MS = 10_000;

export interface RedialAsk {
  /** The relay closed a connection that was live: every phone on it redials in this instant, so the first retry is spread. */
  readonly fleet?: boolean;
  /** The relay's latest answer is "PC offline". */
  readonly offline?: boolean;
  /** The page recycled the socket itself: one silent redial at full speed. */
  readonly quiet?: boolean;
}

/**
 * How long the phone waits before dialing again, as the relay web app always paced it: the first retry of an outage leaves at once
 * (spread over FLEET_SPREAD_MS after a relay-side close of a live connection), and each later one is drawn from [step, next step]
 * from REDIAL_MIN_MS up to the ceiling, which is REDIAL_MAX_MS (60 s while the PC is offline); at the ceiling the range stays
 * [ceiling / 2, ceiling] so phones that reached it never line up again. Every ready connection and every wake starts over.
 */
export function createRedialSchedule(random: () => number): { next(ask: RedialAsk): number; reset(): void } {
  let step = 0;
  return {
    reset: () => {
      step = 0;
    },
    next: ({ fleet = false, offline = false, quiet = false }) => {
      if (quiet) {
        step = 0;
        return 0;
      }
      const ceiling = offline ? OFFLINE_LADDER_CAP_MS : REDIAL_MAX_MS;
      if (step === 0) {
        step = REDIAL_MIN_MS;
        return fleet ? Math.round(random() * FLEET_SPREAD_MS) : 0;
      }
      const high = Math.min(ceiling, step * 2);
      const low = Math.min(step, high / 2);
      step = Math.min(ceiling, step * 2);
      return Math.round(low + random() * (high - low));
    },
  };
}

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
  // Redial pacing: the library asks for a wait before each dial; what the page knows of the last end decides how long (see createRedialSchedule).
  let offline = false;
  let spread = false;
  let quiet = false;
  let silent = false;
  const schedule = createRedialSchedule(random);
  const redialDelay = (): number => {
    const ask = { fleet: spread, offline, quiet: silent };
    spread = false;
    silent = false;
    return schedule.next(ask);
  };
  // A wake cuts the running redial wait short: waiting out a grown backoff after the user came back is the gap they watch.
  const sleepers = new Set<() => void>();
  const sleep = (_libraryMs: number): Promise<void> =>
    new Promise((done) => {
      const silentRedial = silent;
      const ms = redialDelay();
      // Node's silent redial runs inside the close handler, ahead of whatever the close settles; any other redial is a timer, however short.
      if (silentRedial && ms === 0) return done();
      const finish = (): void => {
        clearTimeout(timer);
        sleepers.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      sleepers.add(finish);
    });
  let last: PhoneConnection | undefined;
  const connector = createRelayConnector({
    ...options,
    // Every dial states the indicator again, as the page always did: a wake that dials during an outage shows it anew.
    dialing: () => {
      if (!terminal && last && (last.state === 'connecting' || last.state === 'reconnecting')) options.onConnection(last);
      options.dialing?.();
    },
    // The desktop came back to a socket the relay kept: the handshake starts over on it.
    reused: () => {
      if (!terminal && last?.state === 'reconnecting') {
        last = { state: 'connecting' };
        options.onConnection(last);
      }
      options.reused?.();
    },
    closed: (code, reason, info) => {
      const state = terminalOfClose(code, reason);
      offline = code === CLOSE_DESKTOP_OFFLINE;
      spread = info.remote && info.ready;
      quiet = info.quiet;
      silent = info.quiet;
      // The failure is reported before a terminal state asks the user, as the page always did.
      options.onClose?.(code, reason, info);
      if (state) settle(state);
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
        // `feedRanges`: the protocol client folds a coalesced text append (`feed.from`), so the core batches this phone's appends.
        capabilities: { optOutNotificationMethods: [], experimentalApi: false, feedRanges: true },
        threadReducer: options.threadReducer ?? sessionReducer,
        clock: { sleep },
        random,
        ladder: DEFAULT_LADDER,
      });
    } catch (error) {
      if (terminal) throw error;
      const detail = (error as { detail?: { kind?: string } }).detail;
      if (detail?.kind === 'versionRefused') {
        settle('update-required');
        throw error;
      }
      await sleep(0);
      continue;
    }
    break;
  }
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
      if (event.status.state === 'ready') {
        offline = false;
        schedule.reset();
      }
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
    retire: () => connector.retire(),
    silentSince: (since) => connector.silentSince(since),
    get suspended() {
      return connector.suspended;
    },
    wake: () => {
      // A wake never inherits a grown backoff: the redial that follows it is the gap the user watches.
      schedule.reset();
      const probing = connector.wake();
      for (const finish of [...sleepers]) finish();
      return probing;
    },
  };
  return { client, link, ...(screen ? { screen } : {}) };
}
