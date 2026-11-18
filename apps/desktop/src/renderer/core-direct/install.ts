// Composes window.mixdogDesktop in the renderer: the host half the preload exposes (window.mixdogDesktopHost) plus the direct
// half built here over this window's own core connection (window.mixdogCorePort). It runs before the bootstrap imports read the
// API; a preload that already supplies window.mixdogDesktop is left as it is.
import desktopPackage from '../../../package.json';
import type { DesktopApi } from '../../shared/contract';
import { DIRECT_KEYS, type DesktopHostApi } from '../../shared/desktop-api-split.ts';
import { createCapabilitiesApi } from './api-capabilities.ts';
import { createFilesApi } from './api-files.ts';
import { createScmApi } from './api-scm.ts';
import { createSessionsApi } from './api-sessions.ts';
import { createSettingsApi } from './api-settings.ts';
import { createTakeoverApi } from './api-takeover.ts';
import { createTerminalApi } from './api-terminal.ts';
import { connectionsApi } from '../connections-core-api.ts';
import { CONNECTION_REATTACHED_EVENT } from '../desktop-connection';
import { noteFirstPcCoreOpen, openDirectClient, pcCoreClient, reportCoreLink } from './client.ts';
import { createDirectContext } from './context.ts';
import { withApiFileGrantRefresh } from '../remote-file-grant-refresh.ts';
import type { CorePortBridge } from './port-connector.ts';
import { createRendererConnection, type RendererConnection } from './renderer-connection.ts';
import { watchLocalCoreLink } from '../local-core-link.ts';
import { createSectionsApi } from './sections.ts';
import { withServerGates } from './server-gates.ts';
import { sizedCall } from './sized-call.ts';
import { watchWake } from './wake-check.ts';

/** The window's globals this composes from and assigns to. */
export interface InstallTarget {
  mixdogDesktop?: DesktopApi;
  /** The host half, with the two boot values the preload reads from its launch arguments. */
  mixdogDesktopHost?: DesktopHostApi & Partial<Pick<DesktopApi, 'bootContext' | 'connection'>>;
  mixdogCorePort?: CorePortBridge;
}

export interface InstallOptions {
  /** Defaults to window. */
  target?: InstallTarget;
  /** The connection the direct half runs over; by default one that opens this window's core port. */
  connection?: RendererConnection;
}

export async function installDirectDesktopApi(options: InstallOptions = {}): Promise<void> {
  const target = options.target ?? (window as unknown as InstallTarget);
  if (target.mixdogDesktop) return;
  const host = target.mixdogDesktopHost;
  if (!host) throw new Error('The desktop host bridge is not available.');
  const bridge = target.mixdogCorePort;
  const server = host.connection?.kind === 'ssh';
  let connection = options.connection;
  if (!connection) {
    if (!bridge) throw new Error('The core port bridge is not available.');
    connection = createRendererConnection({
      open: () => openDirectClient({ bridge, version: desktopPackage.version }),
      log: reportCoreLink,
    });
  }
  watchLocalCoreLink(connection);
  const ctx = createDirectContext(connection);
  const live = connection;
  const events = typeof window === 'undefined' ? undefined : window;
  watchWake({
    check: () => server
      ? Promise.all([live.protocolClient()?.checkLink(), pcCoreClient()?.checkLink()])
      : live.protocolClient()?.checkLink(),
    events,
  });
  ctx.setSender((client, method, params) => sizedCall(client as never, method, params));
  // The management client carries only PC requests and scoped feeds. It cannot wait for the server it may need to reconnect.
  if (server && bridge) {
    noteFirstPcCoreOpen(openDirectClient({ bridge, version: desktopPackage.version, slot: 'pc' }).catch((error: unknown) => {
      console.error('The PC connection did not open:', error);
    }));
    events?.addEventListener(CONNECTION_REATTACHED_EVENT, () => {
      // A long outage may have exhausted the primary open. Leave healthy or still-retrying clients alone.
      if (live.status === 'closed') void live.ensureOpen().catch(() => undefined);
    });
  }
  // Start before exposing the API so early workspace calls can join the in-flight open.
  const opening = connection.start().catch((error: unknown) => {
    // The connection reopens on a call; the window still gets its API and shows the connection's own status.
    console.error('The core connection did not open:', error);
  });
  if (!server) noteFirstPcCoreOpen(opening);
  const direct = {
    ...createSessionsApi(ctx),
    ...createFilesApi(ctx),
    ...createScmApi(ctx),
    ...createTerminalApi(ctx),
    ...createSettingsApi(ctx),
    ...createCapabilitiesApi(ctx, { host }),
    ...createSectionsApi(ctx),
    ...Object.fromEntries(DIRECT_KEYS.connections.map((key) => [key, connectionsApi[key]])),
    ...createTakeoverApi(ctx),
  };
  // A held token for a file outside every Project can lose its grant (the oldest of the capped grants is dropped): such a
  // refusal re-grants the file through `resolveLocalPaths` and retries once, so a held link keeps opening.
  const composed = withApiFileGrantRefresh({ ...host, ...direct } as unknown as DesktopApi);
  target.mixdogDesktop = Object.freeze(server ? withServerGates(composed) : composed);
}
