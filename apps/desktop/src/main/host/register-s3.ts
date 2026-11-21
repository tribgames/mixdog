import type { ComputerPresence } from '../computer/presence/mirror';
import { registerComputerHandlers, type ComputerControlSource, type ComputerHostDeps } from './computer';
import { registerComputerCommand, type ComputerCommandHostSource } from './computer-command';
import { registerComputerProcessFate, type ProcessFateSource } from './computer-process-fate';
import { type ComputerSwitch, registerComputerScopes } from './computer-scope';
import { bindComputerEnvironment } from './computer-environment';
import { registerComputerPermissions, type ComputerPermissionReads } from './computer-permissions';
import { coreDrivesComputer } from './computer-user-control';
import type { HostConnection } from './connection';

type EnvironmentSource = Parameters<typeof bindComputerEnvironment>[0];

export interface ComputerHostWiring {
  /** The presence mirror the `computer` section feeds: the arrow of app input is drawn through it, and it says who drives the computer. */
  mirror: Pick<ComputerPresence, 'backend' | 'snapshot' | 'pointerProgress'>;
  /** What `host/computer/pixels` captures with and how large its upload chunks are (the Electron capturers when absent). */
  pixels?: ComputerHostDeps['pixels'];
  /** The operating-system grants (`host/computer/permissions`). */
  permissions: ComputerPermissionReads;
  /** The desktop transitions (the screen locks, the machine suspends, a display changes) the core is told of while it drives the computer
   *  (`computer/userControl` takeover). Electron's `powerMonitor` and `screen` exist once the app is ready, so they are read then. */
  environment: {
    ready: Promise<unknown>;
    sources(): { power: EnvironmentSource; screen: EnvironmentSource };
    onError?: (error: unknown) => void;
  };
  /** The desktop's own computer host's screen reads (`host/computer/capture`, `displays`) while it runs, else null. */
  desktopHostScreen: ComputerControlSource;
  /** The same host's bridge answer (`host/computer/command`) while it runs, else null. */
  desktopHostCommand: ComputerCommandHostSource;
  /** The same host's reading of one process (`host/computer/processFate`) while it runs, else null. */
  desktopHostProcessFate: ProcessFateSource;
  /** Computer Use's switch: every handler commits its effects under the request's automation scope, which follows it, and
   *  `host/computer/revokeScopes` is always served (`computer-scope.ts`). */
  computerSwitch: ComputerSwitch;
}

/** Registers the handlers and starts the environment reports once the app is ready; the returned function stops the reports (a
 *  connection's handlers end with it). */
export function registerComputerHost(connection: HostConnection, wiring: ComputerHostWiring): () => void {
  const { mirror, environment } = wiring;
  const scopes = registerComputerScopes(connection, wiring.computerSwitch);
  registerComputerHandlers(connection, wiring.desktopHostScreen, {
    appInput: {
      // The arrow follows the native physical point. A click is the phase the mirror paints as one; the other actions are its own words.
      showCursor: (sessionId, x, y, action) =>
        mirror.pointerProgress(sessionId, {
          x,
          y,
          held: false,
          mode: 'background',
          phase: action === 'click' ? 'release' : action,
        }),
    },
    pixels: wiring.pixels,
    scopes,
  });
  registerComputerPermissions(connection, wiring.permissions);
  registerComputerCommand(connection, wiring.desktopHostCommand, scopes);
  registerComputerProcessFate(connection, wiring.desktopHostProcessFate);
  let stopped = false;
  let unbind: () => void = () => undefined;
  void environment.ready.then(() => {
    if (stopped) return;
    const { power, screen } = environment.sources();
    unbind = bindComputerEnvironment(
      power,
      screen,
      (method, params) => connection.request(method, params),
      () => coreDrivesComputer(mirror),
      environment.onError
    );
  });
  return () => {
    stopped = true;
    unbind();
  };
}
