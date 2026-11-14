/**
 * Every `host/computer/*` handler of this desktop and the report of the desktop's own transitions, registered at once with
 * what each needs handed in (`registerComputerHost`): the screen reads and the whole-command relay of the desktop's own
 * computer host (only while one runs), the foreground lease, the internal windows, the pointer feedback and cursor
 * readiness, the app windows and app input, the pixels and the permissions, and the lock / suspend / display reports that
 * take the user's hold in the core. The arrow of the input into the desktop's own windows is the presence mirror's, like
 * the arrow of the helper's pointer progress, so one overlay draws both.
 */
import type { ComputerPresence } from '../computer/presence/mirror';
import { registerComputerHost as registerComputerHandlers, type ComputerControlSource, type ComputerHostDeps } from './computer';
import { registerComputerCommand, type ComputerCommandHostSource } from './computer-command';
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
  legacyScreen: ComputerControlSource;
  /** The same host's bridge answer (`host/computer/command`) while it runs, else null. */
  legacyCommand: ComputerCommandHostSource;
}

/** Registers the handlers and starts the environment reports once the app is ready; the returned function stops the reports (a
 *  connection's handlers end with it). */
export function registerComputerHost(connection: HostConnection, wiring: ComputerHostWiring): () => void {
  const { mirror, environment } = wiring;
  registerComputerHandlers(connection, wiring.legacyScreen, {
    appInput: {
      // The arrow follows the native physical point. A click is the phase the mirror paints as one; the other actions are its own words.
      showCursor: (sessionId, x, y, action) =>
        mirror.pointerProgress(sessionId, { x, y, held: false, mode: 'background', phase: action === 'click' ? 'release' : action }),
    },
    pixels: wiring.pixels,
  });
  registerComputerPermissions(connection, wiring.permissions);
  registerComputerCommand(connection, wiring.legacyCommand);
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
