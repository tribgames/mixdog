/**
 * `computer/userControl`: the Computer Use pill's Resume and Stop, sent to the core. The core holds the person's control of the
 * desktop for the Rust computer helpers (`computer_user_control.rs`): a yield of one session, or a takeover of all of them,
 * which it publishes in the `computer` section's `userControl` (turned into the pill's snapshot by `computer-pill.ts`). Resume
 * ends it and Stop holds the desktop until the stopped turns have ended. The controls fit `ComputerUseOverlayControls`, whose
 * Stop also ends the turns through the session service: the caller does that, since this module knows only the computer.
 */
import type {
  ComputerUserControlParams,
  ComputerUserControlResult,
} from '../../../../../packages/protocol/src/index.ts';
import type { ComputerUseOverlayControls } from '../computer/overlay/controls';
import { confirmComputerTurnsStopped } from '../computer/overlay/stop-turns';
import type { ComputerUseSnapshot } from '../computer/session/coordinator';

export const COMPUTER_USER_CONTROL = 'computer/userControl';

/** One request to the core (`ProtocolConnection.call`). */
export type CallCore = (method: string, params: unknown) => Promise<unknown>;

export function createCoreUserControl(call: CallCore) {
  /** Whether the core's hold changed: false when there was nothing to resume or stop. */
  const send = async (params: ComputerUserControlParams): Promise<boolean> =>
    ((await call(COMPUTER_USER_CONTROL, params)) as ComputerUserControlResult).ok;
  return {
    /**
     * The pill's Resume, for every session. The core's hold carries no generation to go stale, and a hold that ended by
     * itself first (the person went idle) leaves nothing to resume, which is no failure.
     */
    async resume(): Promise<void> {
      await send({ action: 'resume' });
    },
    /** The pause when the control renderer dies: the core holds the desktop as `user_pause` (not `user_stop`), which only Resume ends. */
    async pause(): Promise<void> {
      await send({ action: 'pause' });
    },
    /** The idle-resume setting (0..=60 seconds of quiet after which a hold ends by itself; 0 = only Resume ends it): the core keeps it with or without a session. */
    async configureIdleResume(seconds: number): Promise<void> {
      await send({ action: 'configureIdleResume', seconds });
    },
    /** The pill's Stop: the core holds the desktop until the sessions using the computer have ended. */
    async stop(): Promise<void> {
      await send({ action: 'stop' });
    },
  };
}

/** Whether the core's computer sessions are the ones the pill shows: it draws the core's `computer` section, so the core owns the
 *  computer while that section has a session, a hold of the user's or a cleanup pending. Otherwise the desktop's own computer host does. */
export function coreOwnsComputer(snapshot: ComputerUseSnapshot): boolean {
  return (snapshot.presentSessionIds ?? []).length > 0 || snapshot.userControlActive || snapshot.cleanupState !== 'ready';
}

/** Whether the core drives the computer now: the section names the core's helper as the backend (not the desktop's own host,
 *  whose in-process sessions the pill then shows) and the core owns the computer (`coreOwnsComputer`). */
export function coreDrivesComputer(pill: { backend(): 'helper' | 'desktopHost'; snapshot(): ComputerUseSnapshot }): boolean {
  return pill.backend() === 'helper' && coreOwnsComputer(pill.snapshot());
}

export interface ComputerPillControlsOptions {
  core: ReturnType<typeof createCoreUserControl>;
  /** The presence mirror: which stack the `computer` section names (`backend`) and the pill's current snapshot, which says who owns the computer. */
  mirror: { backend(): 'helper' | 'desktopHost'; snapshot(): ComputerUseSnapshot };
  /** The desktop's own computer host (the TypeScript PowerShell host), which serves the pill while the core does not own the computer;
   *  absent where this desktop runs none (the Rust helper is the only stack): every control then goes to the core. */
  host?: ComputerUseOverlayControls & Required<Pick<ComputerUseOverlayControls, 'pause' | 'resume'>>;
  /** Ends a session's agent turn; Stop confirms it for every session the pill names. */
  abortSession(sessionId: string): Promise<unknown>;
  /** A failed idle-resume report to the core (the control is a plain setter: it cannot reject). */
  onError?(error: unknown): void;
}

/**
 * The pill's Pause, Stop and Resume, the pause when the control renderer dies and the emergency shortcut (which is Stop), sent to the
 * core while it owns the computer (the section names the helper and has a session, a hold or a cleanup: `coreDrivesComputer`) and to the
 * desktop's own host otherwise. The core's hold is one for all sessions, so its Resume carries no generation and its pause is the
 * core's `user_pause` hold. The idle-resume interval is a setting, not a hold: it goes to the core whenever the helper is the backend
 * (a session need not be open) and to the desktop host as well when this desktop has one.
 */
export function createComputerPillControls(options: ComputerPillControlsOptions): ComputerUseOverlayControls {
  const { core, host, mirror } = options;
  const owned = (): boolean => host === undefined || coreDrivesComputer(mirror);
  return {
    pause: async () => (owned() ? core.pause() : host?.pause()),
    resume: async (generation) => (owned() ? core.resume() : host?.resume(generation)),
    configureIdleResume: (seconds) => {
      host?.configureIdleResume?.(seconds);
      if (mirror.backend() !== 'helper') return;
      core.configureIdleResume(seconds).catch(options.onError ?? ((error) => console.warn('[mixdog-computer] idle-resume report failed:', error)));
    },
    async stop(sessionIds) {
      if (!owned()) return host?.stop(sessionIds);
      // The hold and the turns' end are independent (the desktop host's Stop): a late or failed reply to one never holds back the other.
      await Promise.all([core.stop(), confirmComputerTurnsStopped(sessionIds, options.abortSession)]);
    },
  };
}
