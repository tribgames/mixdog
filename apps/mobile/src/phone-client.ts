// The phone web UI's one connection: `packages/protocol-client` over the relay.
// The UI reads folded state from `client.store` and calls typed methods; no
// desktop-method table or message shim sits between them.
import {
  ClientFailure,
  connect,
  DEFAULT_LADDER,
  keepTranscriptWindow,
  sessionReducer,
  type ProtocolClient,
  type SessionFold,
  type ThreadReducer,
} from '../../../packages/protocol-client/src/index.ts';
import { REMOTE_TOOL_OUTPUT_DISPLAY } from '../../desktop/src/shared/remote-tool-output-display.ts';
import { CLOSE_DESKTOP_OFFLINE, phoneConnectionOf, terminalOfClose, type PhoneConnection } from './phone-status.ts';
import { createScreenReporter, type ScreenReporter, type ScreenSource } from './screen-reporter.ts';
import {
  createRelayConnector,
  type CloseInfo,
  type RelayConnector,
  type RelayConnectorDeps,
} from './relay-connector.ts';

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
  /** Hands out the page-lifecycle link as soon as it exists, before the first connection resolves. */
  readonly linked?: (link: PhoneClient['link']) => void;
  /** Stops the first-connect retries. */
  readonly signal?: AbortSignal;
  /** What the phone shows; the core reads it as `ui/screenSessions/changed` to hold back pushes for a thread being looked at. */
  readonly screen?: ScreenSource;
  /** Every socket end, after the phone has taken its own decisions from it (terminal states, redial pacing). */
  readonly onClose?: (code: number, reason: string, info: CloseInfo) => void;
  /** A redial waits out `ms` (a backoff timer; an immediate retry says nothing); the next `dialing` ends the wait. */
  readonly redialIn?: (ms: number) => void;
}

export interface PhoneClient {
  readonly client: ProtocolClient<SessionFold>;
  /** Page lifecycle hooks of the transport session. */
  readonly link: Pick<
    RelayConnector,
    'hidden' | 'suspend' | 'suspended' | 'retire' | 'probe' | 'silentSince' | 'silentFor'
  > & {
    /** Foreground, user retry, or network online/change: releases a suspension, resets backoff, recycles or probes, and cuts a running redial wait short. */
    wake(options?: { force?: boolean; recycle?: string }): boolean;
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

interface RedialWaiter {
  sleep(_libraryMs: number): Promise<void>;
  wake(): void;
}

function createRedialWaiter(
  options: Pick<PhoneClientOptions, 'signal' | 'visible' | 'redialIn'>,
  nextDelay: () => { silent: boolean; ms: number }
): RedialWaiter {
  const sleepers = new Set<() => void>();
  const away = (): boolean => options.visible?.() === false;
  return {
    sleep: (_libraryMs: number): Promise<void> =>
      new Promise((done) => {
        // Rule A: nothing waits for an attempt that was already aborted.
        if (options.signal?.aborted) return done();
        const { silent, ms } = nextDelay();
        // A silent redial runs inside the close handler, ahead of whatever the close settles; any other redial is a timer, however short.
        if (silent && ms === 0 && !away()) return done();
        if (ms > 0) options.redialIn?.(ms);
        const finish = (): void => {
          clearTimeout(timer);
          sleepers.delete(finish);
          options.signal?.removeEventListener('abort', finish);
          done();
        };
        // No redial is armed while the page is hidden, and a timer that fires after the page was hidden waits for the
        // wake that brings it back; a pairing reset (abort) ends every wait.
        const timer = setTimeout(() => {
          if (options.signal?.aborted || !away()) finish();
        }, ms);
        options.signal?.addEventListener('abort', finish);
        sleepers.add(finish);
      }),
    wake: () => {
      for (const finish of [...sleepers]) finish();
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
  type Terminal = Extract<PhoneConnection, { state: 'update-required' | 'pairing-lost' }>;
  let terminal: Terminal | undefined;
  let client: ProtocolClient<SessionFold> | undefined;
  const settle = (state: Terminal): void => {
    if (terminal) return;
    terminal = state;
    options.onConnection(state);
    void client?.close();
  };
  let offline = false;
  let spread = false;
  let quiet = false;
  let silent = false;
  const schedule = createRedialSchedule(random);
  const waiter = createRedialWaiter(options, () => {
    const silentRedial = silent;
    const ask = { fleet: spread, offline, quiet: silentRedial };
    spread = false;
    silent = false;
    return { silent: silentRedial, ms: schedule.next(ask) };
  });
  let last: PhoneConnection | undefined;
  const connector = createRelayConnector({
    ...options,
    // Every dial states the indicator again, as the page always did: a wake that dials during an outage shows it anew.
    dialing: () => {
      if (!terminal && last && (last.state === 'connecting' || last.state === 'reconnecting'))
        options.onConnection(last);
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
      // The failure is reported before a terminal state asks the user.
      options.onClose?.(code, reason, info);
      if (state) settle({ state });
    },
  });
  // The link exists from the first dial on: a wake, a hide or a suspension that comes before the first connection must reach it too.
  const link: PhoneClient['link'] = {
    hidden: () => connector.hidden(),
    suspend: () => connector.suspend(),
    retire: () => connector.retire(),
    probe: () => connector.probe(),
    silentSince: (since) => connector.silentSince(since),
    silentFor: (windowMs) => connector.silentFor(windowMs),
    get suspended() {
      return connector.suspended;
    },
    wake: (wakeOptions) => {
      // A wake never inherits a grown backoff: the redial that follows it is the gap the user watches.
      schedule.reset();
      const probing = connector.wake(wakeOptions);
      waiter.wake();
      return probing;
    },
  };
  options.linked?.(link);
  options.onConnection({ state: 'connecting' });
  const connectConfig = {
    target: { id: options.deviceId },
    connector,
    clientInfo: {
      name: 'mixdog-phone',
      title: 'Mixdog Phone',
      version: options.version,
      kind: 'phone' as const,
      build: options.build,
    },
    // `feedRanges`: the protocol client folds a coalesced text append (`feed.from`), so the core batches this phone's appends.
    // `toolOutput`: the core cuts each tool output to what the phone shows (the rest is read on request, `thread/items/read`).
    capabilities: {
      optOutNotificationMethods: [],
      experimentalApi: false,
      feedRanges: true,
      toolOutput: REMOTE_TOOL_OUTPUT_DISPLAY,
    },
    threadReducer: options.threadReducer ?? sessionReducer,
    // The phone holds a window of each transcript the core keeps for it, not the conversation.
    positionedTranscripts: true,
    clock: { sleep: waiter.sleep },
    random,
    ladder: DEFAULT_LADDER,
  };
  for (;;) {
    if (options.signal?.aborted) throw new Error('aborted');
    try {
      client = await connect<SessionFold>(connectConfig);
    } catch (error) {
      if (terminal || options.signal?.aborted) throw error;
      const detail = error instanceof ClientFailure ? error.detail : undefined;
      if (detail?.kind === 'versionRefused') {
        settle({ state: 'update-required', reason: detail.reason });
        throw error;
      }
      await waiter.sleep(0);
      continue;
    }
    break;
  }
  if (options.signal?.aborted) {
    void client.close();
    throw new Error('aborted');
  }
  // The attempt's end is the client's: its reconnect ladder must not outlive the pairing it served.
  const owned = client;
  // The window of every followed thread is kept as it changes, mounted or not (the desktop's session lane does the same).
  owned.store.subscribe((change) => {
    if (change.type === 'thread') void keepTranscriptWindow(owned, change.threadId);
  });
  options.signal?.addEventListener('abort', () => void owned.close(), { once: true });
  const report = (shown: PhoneConnection): void => {
    if (terminal) return;
    if (shown.state === 'update-required') {
      settle(shown);
      return;
    }
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
  return { client, link, ...(screen ? { screen } : {}) };
}
