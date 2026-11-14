// One daemon connection: its service client, the protocol connection to the connection's core and the terminal host
// of its windows. This PC's core is dialed from its discovery file; a server window's core is where this PC's core says
// the server listens (the ssh session, the tunnel, the link and the model proxy are the core's, not built here).
import type { SessionSnapshot } from '../../shared/contract';
import { DesktopServiceClient } from '../desktop-service-client';
import type { SerializableDesktopServiceOptions } from '../desktop-service-contract';
import type { DesktopTerminalHost } from '../ipc-terminal';
import type { ConnectionIdentity } from './contract';
import { createServiceTerminalHost } from './terminal-host';
import { createCapabilityLane } from '../protocol/capability-route';
import { withSectionCapabilities } from '../protocol/section-capability-lane';
import { createOperationLane, watchAnnouncements } from '../protocol/desktop-operation-route';
import { createServiceLane } from '../protocol/service-route';
import { createSessionLane } from '../protocol/session-lane';
import type { OperationHost } from '../protocol/section-reads';
import type { ProtocolConnection } from '../protocol/connection';

export interface DesktopConnection extends ConnectionIdentity {
  readonly client: DesktopServiceClient;
  /** This process's one protocol connection to the connection's core: pushed sections, detail calls, host role.
   *  Every session capability, read and operation is a request on it. */
  readonly protocol: ProtocolConnection;
  readonly terminals: DesktopTerminalHost;
  /** The daemon-side user data directory: this PC's profile. A server's core keeps its own data. */
  serviceUserDataPath(): string;
  start(): Promise<void>;
  /** Detach: the client and the protocol connection close; a server's core keeps running. */
  dispose(): Promise<void>;
}

export interface DesktopConnectionDependencies {
  sessionOptions(): SerializableDesktopServiceOptions;
  appVersion: string;
  initialSnapshot?(): SessionSnapshot;
  onDiagnostic?(connection: ConnectionIdentity, event: string, data: Record<string, unknown>): void;
  onServiceReady?(connection: ConnectionIdentity, context: { generation: number }): void;
  /** The protocol connection of `connection`'s core, or null when its endpoint is not available. */
  createProtocol?(connection: ConnectionIdentity): ProtocolConnection | null;
  /** What only this process answers for the renderer's desktop operations: `pcNotificationsSupported`,
   *  `readDisplayPreferences`, `hostName` (protocol/section-reads.ts `OperationHost`). */
  operationHost?(): Partial<Omit<OperationHost, 'emitDesktopEvent'>>;
}

export type DesktopConnectionSpec = ConnectionIdentity;

function createServiceClient({
  deps,
  identity,
  protocol,
}: {
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  protocol: ProtocolConnection;
}): DesktopServiceClient {
  const client: DesktopServiceClient = new DesktopServiceClient({
    // Every capability, read and operation is a request of the connection's core (capability-route.ts, service-route.ts,
    // desktop-operation-route.ts); the capabilities the sections replaced are answered from the connection's sections
    // (section-capability-lane.ts).
    serviceLane: createServiceLane({ protocol, snapshot: () => client.getSnapshot() }),
    sessionLane: createSessionLane({ protocol }),
    capabilityLane: withSectionCapabilities({
      lane: createCapabilityLane({ protocol }),
      protocol,
      snapshot: () => client.getSnapshot(),
    }),
    // What only this process knows (the OS's notification support, the window's theme, its windows' event feed) is
    // handed to the lane.
    operationLane: createOperationLane({
      protocol,
      host: { ...deps.operationHost?.(), emitDesktopEvent: (name, value) => client.emitDesktopEvent(name, value) },
    }),
    ...(deps.initialSnapshot ? { initialSnapshot: deps.initialSnapshot() } : {}),
    onDiagnostic: (event, data) => deps.onDiagnostic?.(identity, event, data),
  });
  // The core's announcements (`ui/settings/changed`, `ui/providerModels/changed`) are the events Node's service raised for
  // this process's windows; they last as long as the connection.
  if (protocol) watchAnnouncements(protocol, (name, value) => client.emitDesktopEvent(name, value));
  return client;
}

export function createDesktopConnection(spec: DesktopConnectionSpec, deps: DesktopConnectionDependencies): DesktopConnection {
  const identity: ConnectionIdentity = { id: spec.id, kind: spec.kind, name: spec.name };
  const protocol = deps.createProtocol?.(identity) ?? null;
  if (!protocol) throw new Error('A connection is carried by its core connection: it needs createProtocol.');
  const client = createServiceClient({ deps, identity, protocol });
  // Each attachment of the core (the first, and every redial after a lost link or a restarted core) is a service ready.
  let generation = 0;
  let started = false;
  const attached = (): void => {
    generation += 1;
    deps.onServiceReady?.(identity, { generation });
  };
  const stopWatching = protocol.onEvent((event) => {
    if (started && event.type === 'status' && (event as { status: { state: string } }).status.state === 'ready') attached();
  });
  let disposal: Promise<void> | null = null;
  return {
    ...identity,
    client,
    protocol,
    terminals: createServiceTerminalHost(client, protocol),
    serviceUserDataPath() {
      // A server's core keeps its own data; only this PC's profile is addressable from here.
      if (spec.kind === 'local') return deps.sessionOptions().userDataPath;
      throw new Error(`The connection to ${spec.name} is not attached yet.`);
    },
    async start() {
      await client.start();
      // The core is serving once its connection is open; windows read sections from here on.
      await protocol.start();
      started = true;
      attached();
    },
    dispose() {
      disposal ??= (async () => {
        stopWatching();
        await protocol.close().catch(() => undefined);
        await client.dispose();
      })();
      return disposal;
    },
  };
}
