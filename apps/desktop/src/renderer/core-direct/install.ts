// Composes window.mixdogDesktop in the renderer: the host half the preload exposes (window.mixdogDesktopHost) plus the direct
// half built here over this window's own core connection (window.mixdogCorePort). It runs before the bootstrap imports read the
// API; a preload that already supplies window.mixdogDesktop is left as it is.
import desktopPackage from '../../../package.json';
import type { DesktopApi } from '../../shared/contract';
import type { DesktopHostApi } from '../../shared/desktop-api-split.ts';
import { createCapabilitiesApi } from './api-capabilities.ts';
import { createFilesApi } from './api-files.ts';
import { createScmApi } from './api-scm.ts';
import { createSessionsApi } from './api-sessions.ts';
import { createSettingsApi } from './api-settings.ts';
import { createTerminalApi } from './api-terminal.ts';
import { openDirectClient } from './client.ts';
import { createDirectContext } from './context.ts';
import type { CorePortBridge } from './port-connector.ts';
import { createRendererConnection, type RendererConnection } from './renderer-connection.ts';
import { createSectionsApi } from './sections.ts';
import { withServerGates } from './server-gates.ts';
import { sizedCall } from './sized-call.ts';

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
  let connection = options.connection;
  if (!connection) {
    if (!bridge) throw new Error('The core port bridge is not available.');
    connection = createRendererConnection({ open: () => openDirectClient({ bridge, version: desktopPackage.version }) });
  }
  const ctx = createDirectContext(connection);
  ctx.setSender((client, method, params) => sizedCall(client as never, method, params));
  try {
    await connection.start();
  } catch (error) {
    // The connection reopens on a call; the window still gets its API and shows the connection's own status.
    console.error('The core connection did not open:', error);
  }
  const direct = {
    ...createSessionsApi(ctx),
    ...createFilesApi(ctx),
    ...createScmApi(ctx),
    ...createTerminalApi(ctx),
    ...createSettingsApi(ctx),
    ...createCapabilitiesApi(ctx, { host }),
    ...createSectionsApi(ctx),
  };
  const composed = { ...host, ...direct } as unknown as DesktopApi;
  target.mixdogDesktop = Object.freeze(host.connection?.kind === 'ssh' ? withServerGates(composed) : composed);
}
