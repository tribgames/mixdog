import {
  ELEVATION_DECLINED_EXIT,
  elevateSecureDesktop,
  runSecureDesktopDelegated,
  runSecureDesktopWithLogon,
  SECURE_DESKTOP_ACCOUNT_DISABLED_EXIT,
  SECURE_DESKTOP_ACCOUNT_LOCKED_EXIT,
  SECURE_DESKTOP_BAD_CREDENTIALS_EXIT,
  SECURE_DESKTOP_BUSY_EXIT,
  SECURE_DESKTOP_DELEGATION_DENIED_EXIT,
  SECURE_DESKTOP_DELEGATION_DISABLED_EXIT,
  SECURE_DESKTOP_DELEGATION_UNAVAILABLE_EXIT,
  SECURE_DESKTOP_LOGON_TYPE_DENIED_EXIT,
  SECURE_DESKTOP_NOT_ADMIN_EXIT,
  SECURE_DESKTOP_OTHER_USER_EXIT,
  SECURE_DESKTOP_POLICY_BLOCKED_EXIT,
  SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT,
  SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT,
  secureDesktopInstallState,
  startSecureDesktopService,
  verifySecureDesktopImage,
  type SecureDesktopCredential,
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
 * by the elevated install (the helper refuses input without it). A request
 * for a phone whose key a current install lacks is only an enroll
 * (`not-enrolled`): it adds that key and keeps every other phone's. A fresh
 * install, or the update of an outdated helper, writes the key set of that
 * install (`outdated` is a different bundled binary, not a missing key).
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

/** How one phone `request` (the UAC-only install path) ended. The credential
 *  and delegation outcomes belong to the key-set ops only
 *  ([`SecureDesktopKeyChangeOutcome`]). */
export type SecureDesktopInstallOutcome =
  | 'installed'
  /** An outdated helper (check exit 2) was replaced by the bundled one. */
  | 'updated'
  | 'declined'
  | 'failed'
  | 'in-progress'
  | 'other-user'
  | 'unavailable';

/** How a key-set op (install/enroll/revoke) ended. A superset of
 *  [`SecureDesktopInstallOutcome`]: `enrolled`/`revoked` are key-change
 *  successes; `bad-credentials`…`policy-blocked` are the remote batch-logon
 *  path's refusals (the UAC path never produces them); `delegation-disabled`
 *  is the app-delegated path's "not enabled". */
export type SecureDesktopKeyChangeOutcome =
  | SecureDesktopInstallOutcome
  | 'enrolled'
  | 'revoked'
  | 'bad-credentials'
  | 'not-admin'
  | 'logon-type-denied'
  | 'account-locked'
  | 'account-disabled'
  | 'policy-blocked'
  // The app-delegated path, PC-side only (never travels to the phone, which
  // uses the credential path): delegation off, the service refused this
  // caller, or the service was unreachable — kept distinct so logs and the
  // pending-revoke path can tell them apart.
  | 'delegation-disabled'
  | 'delegation-denied'
  | 'service-unreachable';

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
  /** Unelevated `start` of the installed service; the running status after. */
  startService(): Promise<SecureDesktopStatus>;
  /** Launch one admin-gated key op through the chosen authorization path and
   *  resolve the bridge exit code (rejects only when it could not launch):
   *  a UAC prompt when `credential` is absent, the batch-logon from a phone
   *  password when present, or the unelevated app-delegation path when
   *  `delegated` (enroll/revoke only). Settles only once the launched
   *  elevation has finished (`ELEVATION_DECLINED_EXIT` when its prompt was
   *  declined); never gives up on a running child. */
  runKeyOp(op: SecureDesktopKeyOp): Promise<number>;
}

/** One admin-gated key-set operation and its authorization path. */
export interface SecureDesktopKeyOp {
  verb: 'install' | 'enroll' | 'revoke';
  /** Keys to enroll (install/enroll). For a `revoke`, the keys to remove. */
  keys: readonly string[];
  /** Keys to also remove in the same op (apply pending revokes on install/enroll). */
  revoke?: readonly string[];
  /** The phone's Windows password for the no-prompt batch-logon path. */
  credential?: SecureDesktopCredential;
  /** Use the unelevated app-delegation path (enroll/revoke of one key). */
  delegated?: boolean;
}

/** Options for an explicit key-set operation. */
export interface SecureDesktopKeyChangeOptions {
  /** Keys to also revoke in the same elevation (pending revokes). */
  revoke?: readonly string[];
  /** The phone's Windows password (remote, no-prompt path). */
  credential?: SecureDesktopCredential;
  /** Use the unelevated app-delegation path (enroll/revoke). */
  delegated?: boolean;
}

/** How a key-set operation ended. */
export interface SecureDesktopKeyChangeResult {
  outcome: SecureDesktopKeyChangeOutcome;
  state: SecureDesktopInstallState;
  detail?: string;
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
  /** Install (or update) the helper enrolling `keys` (zero or more), applying
   *  `options.revoke` in the same elevation. UAC by default, the batch-logon
   *  path with `options.credential`. */
  install(keys: readonly string[], options?: SecureDesktopKeyChangeOptions): Promise<SecureDesktopKeyChangeResult>;
  /** Enroll one or several keys in a single authorization (one UAC prompt for
   *  all) into the installed helper. UAC, batch-logon (`credential`), or the
   *  unelevated app-delegation path (`delegated`, one key per call). */
  enroll(keys: readonly string[], options?: SecureDesktopKeyChangeOptions): Promise<SecureDesktopKeyChangeResult>;
  /** Revoke one phone's key. Same authorization paths as `enroll`. */
  revoke(key: string, options?: SecureDesktopKeyChangeOptions): Promise<SecureDesktopKeyChangeResult>;
  /** Start the installed service if it is registered but stopped (after a
   *  reboot). Never installs, never prompts; the running status after. */
  ensureRunning(): Promise<SecureDesktopStatus>;
}

const IMAGE_REFUSED_DETAIL = 'the helper image was refused: not a signed, unrevoked Mixdog release build';
const REVOCATION_UNKNOWN_DETAIL = 'could not check certificate revocation (offline?)';

/** Why an elevated install that exited without installing failed. */
function failureDetail(exitCode: number, after: SecureDesktopInstallState): string {
  if (exitCode === SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT) return IMAGE_REFUSED_DETAIL;
  if (exitCode === SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT) return REVOCATION_UNKNOWN_DETAIL;
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
  // Outdated (a different bundled binary) or current-but-this-phone-unenrolled:
  // both are "approve", but `not-enrolled` only adds this key (an enroll), never
  // a reinstall that would replace the whole key set.
  if (state === 'outdated' || state === 'not-enrolled') return 'update';
  return 'none';
}

/** The in-progress detail when another admin action holds the single slot. */
const KEY_OP_IN_FLIGHT = 'another secure-desktop admin action is already running on the PC';

/** The phone outcome for a credential-logon refusal exit code, or null when the
 *  code is not a credential refusal. Derived only from the code — never from
 *  any credential — so nothing secret is echoed. Pure; unit-tested. */
function credentialOutcome(exitCode: number): SecureDesktopKeyChangeOutcome | null {
  switch (exitCode) {
    case SECURE_DESKTOP_BAD_CREDENTIALS_EXIT:
      return 'bad-credentials';
    case SECURE_DESKTOP_NOT_ADMIN_EXIT:
      return 'not-admin';
    case SECURE_DESKTOP_LOGON_TYPE_DENIED_EXIT:
      return 'logon-type-denied';
    case SECURE_DESKTOP_ACCOUNT_LOCKED_EXIT:
      return 'account-locked';
    case SECURE_DESKTOP_ACCOUNT_DISABLED_EXIT:
      return 'account-disabled';
    case SECURE_DESKTOP_POLICY_BLOCKED_EXIT:
      return 'policy-blocked';
    default:
      return null;
  }
}

/** Map a key-op bridge exit code to an outcome. `before`/`after` are the
 *  install state around the op (an install of an `outdated` helper reads as
 *  `updated`). A detail never contains any credential — only the exit code.
 *  Pure; unit-tested. */
function keyChangeFromExit(
  verb: SecureDesktopKeyOp['verb'],
  exitCode: number,
  before: SecureDesktopInstallState,
  after: SecureDesktopInstallState,
): SecureDesktopKeyChangeResult {
  if (exitCode === 0) {
    if (verb === 'install') return { outcome: before === 'outdated' ? 'updated' : 'installed', state: after };
    return { outcome: verb === 'enroll' ? 'enrolled' : 'revoked', state: after };
  }
  if (exitCode === ELEVATION_DECLINED_EXIT) return { outcome: 'declined', state: after };
  if (exitCode === SECURE_DESKTOP_BUSY_EXIT) {
    return { outcome: 'in-progress', state: after, detail: 'another install is already running' };
  }
  if (exitCode === SECURE_DESKTOP_OTHER_USER_EXIT) return { outcome: 'other-user', state: after };
  if (exitCode === SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT) return { outcome: 'failed', state: after, detail: IMAGE_REFUSED_DETAIL };
  if (exitCode === SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT) {
    return { outcome: 'failed', state: after, detail: REVOCATION_UNKNOWN_DETAIL };
  }
  if (exitCode === SECURE_DESKTOP_DELEGATION_DISABLED_EXIT) return { outcome: 'delegation-disabled', state: after };
  if (exitCode === SECURE_DESKTOP_DELEGATION_DENIED_EXIT) return { outcome: 'delegation-denied', state: after };
  if (exitCode === SECURE_DESKTOP_DELEGATION_UNAVAILABLE_EXIT) return { outcome: 'service-unreachable', state: after };
  const credential = credentialOutcome(exitCode);
  if (credential) return { outcome: credential, state: after };
  return { outcome: 'failed', state: after, detail: `the helper exited with ${exitCode}` };
}

/** The bridge args for a key op. `install`/`enroll` take `--controller-key` for
 *  adds and `--revoke-key` for pending revokes in the same elevation; `revoke`
 *  takes `--controller-key` for the keys to remove. */
function keyOpArgs(verb: SecureDesktopKeyOp['verb'], keys: readonly string[], revoke: readonly string[]): string[] {
  const adds = keys.flatMap((key) => ['--controller-key', key]);
  if (verb === 'revoke') return adds;
  return [...adds, ...revoke.flatMap((key) => ['--revoke-key', key])];
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
  /** The single in-flight explicit key op (install/enroll/revoke). Rate limit:
   *  at most one admin action runs at a time across all phones, and there is no
   *  automatic retry — a second concurrent call is answered `in-progress`, not
   *  queued, so a failure never spins. Repeated password guesses are bounded by
   *  Windows' own account-lockout policy, not a Mixdog timer. */
  let keyOpInFlight: Promise<SecureDesktopKeyChangeResult> | null = null;

  async function runKeyChange(
    verb: SecureDesktopKeyOp['verb'],
    keys: readonly string[],
    options?: SecureDesktopKeyChangeOptions,
  ): Promise<SecureDesktopKeyChangeResult> {
    // One admin action at a time (including a phone request's elevation).
    if (inFlight || outstanding || keyOpInFlight) {
      return { outcome: 'in-progress', state: await port.check(), detail: KEY_OP_IN_FLIGHT };
    }
    const revoke = options?.revoke ?? [];
    for (const key of [...keys, ...revoke]) {
      if (!isSecureDesktopControllerKey(key)) {
        return { outcome: 'failed', state: await port.check(), detail: 'a controller key is invalid' };
      }
    }
    const op = (async (): Promise<SecureDesktopKeyChangeResult> => {
      if (verb === 'install') {
        const image = await port.verifyImage();
        if (!image.ok) return { outcome: 'failed', state: await port.check(), detail: image.detail };
      }
      const before = await port.check(keys[0]);
      let exitCode: number;
      try {
        exitCode = await port.runKeyOp({ verb, keys, revoke, credential: options?.credential, delegated: options?.delegated });
      } catch (error) {
        return { outcome: 'failed', state: await port.check(), detail: error instanceof Error ? error.message : String(error) };
      }
      return keyChangeFromExit(verb, exitCode, before, await port.check(keys[0]));
    })();
    keyOpInFlight = op.finally(() => {
      keyOpInFlight = null;
    });
    return keyOpInFlight;
  }

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
    // A launched elevation or an explicit key op has not settled: never launch
    // another. A determinate installed state answers this request, and only
    // this one; the latch is released solely when the launched process settles.
    if (outstanding || keyOpInFlight) {
      const state = await port.check(controllerKey);
      if (state === 'installed') return { outcome: 'installed', state };
      return { outcome: 'in-progress', state, detail: AWAITING_PROMPT };
    }

    const before = await port.check(controllerKey);
    // Nothing the elevated step could fix, nothing to do, or not ours: no prompt.
    if (before === 'unavailable') return { outcome: 'unavailable', state: before };
    if (before === 'installed') return { outcome: 'installed', state: before };
    if (before === 'other-user') return { outcome: 'other-user', state: before };
    // Installed and current, but this phone's key is not enrolled: add that one
    // key (an enroll), never a reinstall — a reinstall rebuilds the state and
    // would drop every other paired phone's key. The image is already the
    // bundled one, so there is nothing to verify.
    const enrollOnly = before === 'not-enrolled';
    if (!enrollOnly) {
      // A build the elevated install would refuse: say why, without a prompt.
      const image = await port.verifyImage();
      if (!image.ok) return { outcome: 'failed', state: before, detail: image.detail };
    }

    const launched = port.runKeyOp({
      verb: enrollOnly ? 'enroll' : 'install',
      keys: [controllerKey],
      revoke: [],
      credential: undefined,
      delegated: undefined,
    });
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
      return inFlight !== null || outstanding !== null || keyOpInFlight !== null;
    },
    install: (keys, options) => runKeyChange('install', keys, options),
    enroll: (keys, options) => runKeyChange('enroll', keys, options),
    revoke: (key, options) => runKeyChange('revoke', [key], options),
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
    startService: () => startSecureDesktopService(environment),
    runKeyOp: (op) => {
      const args = keyOpArgs(op.verb, op.keys, op.revoke ?? []);
      if (op.delegated && (op.verb === 'enroll' || op.verb === 'revoke')) {
        return runSecureDesktopDelegated(environment, op.verb, args);
      }
      if (op.credential) return runSecureDesktopWithLogon(environment, op.verb, args, op.credential);
      return elevateSecureDesktop(environment, op.verb, args);
    },
  });
}
