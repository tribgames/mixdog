// The phone web UI's one connection: `packages/protocol-client` over the relay.
// The UI reads folded state from `client.store` and calls typed methods; no
// desktop-method table or message shim sits between them.
import {
  connect,
  ladderDelay,
  sessionReducer,
  type ProtocolClient,
  type SessionFold,
  type ThreadReducer,
} from '../../../packages/protocol-client/src/index.ts';
import { phoneConnectionOf, terminalOfClose, type PhoneConnection } from './phone-status.ts';
import { createScreenReporter, type ScreenReporter, type ScreenSource } from './screen-reporter.ts';
import { createRelayConnector,type RelayConnector, type RelayConnectorDeps } from './relay-connector.ts';

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
}

export interface PhoneClient {
  readonly client: ProtocolClient<SessionFold>;
  /** Page lifecycle hooks of the transport session. */
  readonly link: Pick<RelayConnector, 'hidden' | 'wake'>;
  /** Present when `PhoneClientOptions.screen` was given: call `refresh()` when the page or the shown threads change. */
  readonly screen?: ScreenReporter;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
  const connector = createRelayConnector({
    ...options,
    closed: (code, reason) => {
      const state = terminalOfClose(code, reason);
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
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: options.threadReducer ?? sessionReducer,
        clock: { sleep },
        random,
      });
    } catch (error) {
      if (terminal) throw error;
      const detail = (error as { detail?: { kind?: string } }).detail;
      if (detail?.kind === 'versionRefused') {
        settle('update-required');
        throw error;
      }
      await sleep(ladderDelay(attempt, random()));
      continue;
    }
    break;
  }
  let last: PhoneConnection | undefined;
  const report = (next: PhoneConnection): void => {
    if (terminal) return;
    if (last?.state === next.state) return;
    last = next;
    options.onConnection(next);
  };
  client.on((event) => {
    if (event.type === 'status') report(phoneConnectionOf(event.status));
  });
  report(phoneConnectionOf(client.status));
  if (terminal) void client.close();
  const screen = options.screen ? createScreenReporter(client, options.screen) : undefined;
  return { client, link: connector, ...(screen ? { screen } : {}) };
}
