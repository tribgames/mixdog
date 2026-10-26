import {
  ELEVATION_DECLINED_EXIT,
  elevateSecureDesktop,
  SECURE_DESKTOP_BUSY_EXIT,
  SECURE_DESKTOP_OTHER_USER_EXIT,
  SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT,
  SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT,
  secureDesktopInstallState,
  startSecureDesktopService,
  verifySecureDesktopImage,
  type SecureDesktopImageCheck,
  type SecureDesktopInstallState,
  type SecureDesktopStatus,
} from './client';
import type { SecureDesktopEnvironment } from './paths';
import { NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS } from '../../shared/native-file-save';
import { isSecureDesktopControllerKey } from '../../shared/secure-desktop-grant';

/**
 * On-demand install of the secure-desktop helper service.
 *
 * The app never installs the helper by itself: not on app install, not on
 * update, not on start. The only trigger is the paired phone's request from
 * the secure-desktop blocked state, and each request is at most one UAC prompt
 * on the PC. Nothing retries: a declined or failed request leaves the helper
 * not installed (or outdated) until the phone asks again. Requests made while
 * one is running join it instead of opening a second prompt, and the elevated
 * bridge itself holds a machine-wide lock so two installs can never overlap
 * even across processes.
 *
 * A launched elevation is latched until the process it launched has settled:
 * when it has not finished by the report deadline the request answers
 * `in-progress`, and every later request launches nothing until that
 * elevation exits. Meanwhile a request whose own `check` reports the helper
 * installed is answered `installed` — but that answers only that request; it
 * never releases the latch, which belongs to the launched elevation (an
 * already-enrolled phone checks as installed while another phone's install is
 * still running).
 *
 * A request from a different Windows account (`other-user`) is never silently
 * taken over; the phone is told, and a transfer would be a separate, explicit
 * step. A build that the elevated install would refuse (no release signer pin,
 * unsigned) fails with the reason before any prompt.
 *
 * Every request carries the asking phone's control-grant public key, enrolled
 * by the elevated install (the helper refuses input without it). One key per
 * install: an install that enrolls no key, or another phone's, reads as
 * `outdated` for this phone, and its approved update replaces the key.
 *
 * After an `installed` outcome the caller must build a fresh secure-desktop
 * client and adapter: an existing client read the install state (secret) when
 * it was constructed, so it cannot see the new install.
 */

/** How long a request waits for the elevated install before answering
 *  `in-progress`; covers the user reading and approving the UAC prompt. The
 *  existing Mixdog bound for waiting on a modal OS dialog the user must answer
 *  (`NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS`), reused rather than tuned. */
const DEFAULT_REPORT_AFTER_MS = NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS;

/** How one request ended, reported back to the phone. */
export type SecureDesktopInstallOutcome =
  | 'installed'
  /** An outdated helper (check exit 2) was replaced by the bundled one. */
  | 'updated'
  | 'declined'
  | 'failed'
  | 'in-progress'
  | 'other-user'
  | 'unavailable';

export interface SecureDesktopInstallResult {
  outcome: SecureDesktopInstallOutcome;
  /** The install state after the request. */
  state: SecureDesktopInstallState;
  /** Short diagnostic for `failed` / `in-progress` (no secrets; the bridge logs
   *  details to `%ProgramData%\Mixdog\SecureDesktop\secure-desktop.log`). */
  detail?: string;
}

export interface SecureDesktopInstallerPort {
  /** Unelevated state check, relative to the phone key when one is given. */
  check(controllerKey?: string): Promise<SecureDesktopInstallState>;
  /** Unelevated check that the elevated install would accept the bundled image. */
  verifyImage(): Promise<SecureDesktopImageCheck>;
  /** Launch the elevated `install --controller-key <key>` (one UAC prompt).
   *  Settles only once the launched elevation has finished: resolves its exit
   *  code (`ELEVATION_DECLINED_EXIT` when the prompt was declined), rejects
   *  only when it could not be launched. Never gives up on a running child. */
  elevateInstall(controllerKey: string): Promise<number>;
  /** Unelevated `start` of the installed service; the running status after. */
  startService(): Promise<SecureDesktopStatus>;
}

export interface SecureDesktopInstallerOptions {
  /** How long a request waits for the elevation before answering `in-progress`. */
  reportAfterMs?: number;
}

export interface SecureDesktopInstaller {
  /** Current install state, for that phone when its key is given; never prompts. */
  state(controllerKey?: string): Promise<SecureDesktopInstallState>;
  /** Whether a request (and so possibly a UAC prompt) is in progress. */
  readonly pending: boolean;
  /** Handle one phone request carrying its public control key: at most one
   *  UAC prompt, never retried. An invalid key fails without a prompt. */
  request(controllerKey: string): Promise<SecureDesktopInstallResult>;
  /** Start the installed service if it is registered but stopped (after a
   *  reboot). Never installs, never prompts; the running status after. */
  ensureRunning(): Promise<SecureDesktopStatus>;
}

/** Why an elevated install that exited without installing failed. */
function failureDetail(exitCode: number, after: SecureDesktopInstallState): string {
  if (exitCode === SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT) {
    return 'the helper image was refused: it is not a signed, unrevoked Mixdog release build';
  }
  if (exitCode === SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT) return 'could not check certificate revocation (offline?)';
  if (exitCode === 0) return `helper not installed after install (${after})`;
  return `install exited with ${exitCode}`;
}

/**
 * What the phone's blocked state offers for an install state. An outdated
 * helper (check exit 2: the installed copy differs from the bundled one, e.g.
 * after an app update bumped the helper protocol) is offered as an update to
 * approve — "helper outdated, approve update" — instead of surfacing only as
 * the adapter's `protocol_mismatch` failure.
 */
export type SecureDesktopInstallOffer = 'install' | 'update' | 'none';

export function installOfferFor(state: SecureDesktopInstallState): SecureDesktopInstallOffer {
  if (state === 'not-installed') return 'install';
  if (state === 'outdated') return 'update';
  return 'none';
}

const STILL_RUNNING = Symbol('still-running');

/** The `in-progress` detail while a launched elevation is outstanding: most
 *  often the UAC prompt is still waiting for an answer on the PC. */
const AWAITING_PROMPT =
  'an administrator (UAC) prompt is already open on the PC: answer it there; no new prompt is shown until it is answered';

export function createSecureDesktopInstaller(
  port: SecureDesktopInstallerPort,
  options: SecureDesktopInstallerOptions = {},
): SecureDesktopInstaller {
  const reportAfterMs = options.reportAfterMs ?? DEFAULT_REPORT_AFTER_MS;
  let inFlight: Promise<SecureDesktopInstallResult> | null = null;
  /** The phone key the running request enrolls. */
  let inFlightKey: string | null = null;
  /** The launched elevation until it is known to have finished. */
  let outstanding: Promise<number> | null = null;

  function latch(launched: Promise<number>): void {
    outstanding = launched;
    const release = () => {
      if (outstanding === launched) outstanding = null;
    };
    launched.then(release, release);
  }

  async function fromExitCode(
    exitCode: number,
    before: SecureDesktopInstallState,
    controllerKey: string,
  ): Promise<SecureDesktopInstallResult> {
    const after = await port.check(controllerKey);
    if (exitCode === ELEVATION_DECLINED_EXIT) return { outcome: 'declined', state: after };
    // Another elevated install held the machine-wide lock: it is doing the work.
    if (exitCode === SECURE_DESKTOP_BUSY_EXIT) {
      return { outcome: 'in-progress', state: after, detail: 'another install is already running' };
    }
    // Ownership is re-checked under the elevated lock; nothing was changed.
    if (exitCode === SECURE_DESKTOP_OTHER_USER_EXIT) return { outcome: 'other-user', state: after };
    if (exitCode === 0 && after === 'installed') {
      return { outcome: before === 'outdated' ? 'updated' : 'installed', state: after };
    }
    return { outcome: 'failed', state: after, detail: failureDetail(exitCode, after) };
  }

  async function run(controllerKey: string): Promise<SecureDesktopInstallResult> {
    // A launched elevation has not settled: never launch another. A
    // determinate installed state answers this request, and only this one;
    // the latch is released solely when the launched process settles.
    if (outstanding) {
      const state = await port.check(controllerKey);
      if (state === 'installed') return { outcome: 'installed', state };
      return { outcome: 'in-progress', state, detail: AWAITING_PROMPT };
    }

    const before = await port.check(controllerKey);
    // Nothing the elevated step could fix, nothing to do, or not ours: no prompt.
    if (before === 'unavailable') return { outcome: 'unavailable', state: before };
    if (before === 'installed') return { outcome: 'installed', state: before };
    if (before === 'other-user') return { outcome: 'other-user', state: before };
    // A build the elevated install would refuse: say why, without a prompt.
    const image = await port.verifyImage();
    if (!image.ok) return { outcome: 'failed', state: before, detail: image.detail };

    const launched = port.elevateInstall(controllerKey);
    latch(launched);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stillRunning = new Promise<typeof STILL_RUNNING>((resolve) => {
      timer = setTimeout(() => resolve(STILL_RUNNING), reportAfterMs);
    });
    let settled: number | typeof STILL_RUNNING;
    try {
      settled = await Promise.race([launched, stillRunning]);
    } catch (error) {
      return {
        outcome: 'failed',
        state: await port.check(controllerKey),
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
    if (settled === STILL_RUNNING) {
      return { outcome: 'in-progress', state: await port.check(controllerKey), detail: AWAITING_PROMPT };
    }
    return fromExitCode(settled, before, controllerKey);
  }

  return {
    state: (controllerKey) => port.check(controllerKey),
    get pending() {
      return inFlight !== null || outstanding !== null;
    },
    async request(controllerKey) {
      if (!isSecureDesktopControllerKey(controllerKey)) {
        return { outcome: 'failed', state: await port.check(), detail: "the phone's control key is invalid" };
      }
      // The same phone joins the running request; another phone does not get
      // that phone's result as its own.
      if (inFlight && inFlightKey !== controllerKey) {
        return {
          outcome: 'in-progress',
          state: await port.check(controllerKey),
          detail: 'another phone’s helper request is running on the PC',
        };
      }
      inFlightKey = controllerKey;
      inFlight ??= run(controllerKey).finally(() => {
        inFlight = null;
        inFlightKey = null;
      });
      return inFlight;
    },
    async ensureRunning() {
      if ((await port.check()) !== 'installed') return { installed: false, running: false };
      return port.startService();
    },
  };
}

/** The installer for this app's bundled bridge. */
export function secureDesktopInstallerFor(environment: SecureDesktopEnvironment): SecureDesktopInstaller {
  return createSecureDesktopInstaller({
    check: (controllerKey) => secureDesktopInstallState(environment, controllerKey),
    verifyImage: () => verifySecureDesktopImage(environment),
    elevateInstall: (controllerKey) =>
      elevateSecureDesktop(environment, 'install', ['--controller-key', controllerKey]),
    startService: () => startSecureDesktopService(environment),
  });
}
