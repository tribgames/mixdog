import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';

import { SERVICE_PIPE_NAME, stateFilePath, secureDesktopExePath, type SecureDesktopEnvironment } from './paths';
import {
  FRAME_DEADLINE_MS,
  FrameParser,
  PROTOCOL_VERSION,
  clientAuthTag,
  decodeNonce,
  encodeControl,
  generateNonce,
  serverAuthTag,
  tagsMatch,
  type ControlMessage,
  type DesktopName,
  type FrameHeader,
  type InputEvent,
  type PointerButton,
} from './protocol';

const execFileAsync = promisify(execFile);

/** Subset of the install state the client needs. Full schema lives in the crate. */
interface InstallState {
  secret: string;
  pipeName: string;
  productVersion: string;
}

export interface SecureDesktopStatus {
  installed: boolean;
  running: boolean;
  version?: string;
}

export interface ServerHello {
  protocol: number;
  version: string;
  session: number;
  /** Real input desktop name (`Default`, `Winlogon`, …). */
  desktop: DesktopName;
  /** The session's lock state from WTS (the lock screen vs UAC, which share
   *  the `Winlogon` desktop); absent when Windows reports it unknown. */
  locked?: boolean;
}

/** The authenticated session as it stands now: the server hello, with
 *  `desktop`, `session` and `locked` kept current by `desktop-changed`. */
export type SecureDesktopSession = ServerHello;

/** A helper challenge for the paired phone to sign (protocol v4). */
export interface SecureDesktopGrantChallenge {
  /** The connection's handshake server nonce (base64, 16 bytes). */
  nonce: string;
  /** One-shot challenge (base64, 16 bytes). */
  challenge: string;
}

/** The phone's answer to a challenge, relayed unchanged. */
export interface SecureDesktopGrant {
  challenge: string;
  epoch: number;
  /** Base64 of the 64-byte P-256 `r ‖ s` signature. */
  signature: string;
}

export interface SecureDesktopEvents {
  frame: (header: FrameHeader, pixels: Buffer) => void;
  'desktop-changed': (desktop: DesktopName, session: number, locked: boolean | undefined) => void;
  'grant-challenge': (challenge: SecureDesktopGrantChallenge) => void;
  error: (code: string, message: string) => void;
  close: () => void;
}

/** A minimal duplex the client needs; `net.Socket` satisfies it. */
export type SecureDesktopTransport = Pick<Duplex, 'write' | 'on' | 'end' | 'destroy'>;

export interface SecureDesktopClientOptions {
  environment: SecureDesktopEnvironment;
  /** Test seam: supply the install state instead of reading the state file. */
  readState?: () => InstallState | undefined;
  /** Test seam: supply the transport instead of connecting to the named pipe. */
  createConnection?: (pipeName: string) => SecureDesktopTransport;
  /** Test seam: the `sendInput` settle bound. Defaults to the helper's frame
   *  deadline, past which the helper itself would drop the connection. */
  inputDeadlineMs?: number;
}

function defaultReadState(environment: SecureDesktopEnvironment): InstallState | undefined {
  if (environment.platform !== 'win32') return undefined;
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(environment), 'utf8')) as Partial<InstallState>;
    if (typeof parsed.secret === 'string' && typeof parsed.pipeName === 'string') {
      return {
        secret: parsed.secret,
        pipeName: parsed.pipeName,
        productVersion: typeof parsed.productVersion === 'string' ? parsed.productVersion : '',
      };
    }
  } catch {
    // Not installed, or the state is unreadable by this user: treat as absent.
  }
  return undefined;
}

/**
 * The main-process client the WebRTC effort imports. When the service is not
 * installed every method is an inert no-op and `connect()` rejects with a
 * stable reason, so callers can construct it unconditionally. Nothing here
 * opens a network socket; the transport is the local named pipe.
 */
export class SecureDesktopClient {
  /** False when the service is not installed; all operations are then no-ops. */
  readonly available: boolean;

  private readonly state?: InstallState;
  private readonly createConnection: (pipeName: string) => SecureDesktopTransport;
  private readonly parser = new FrameParser();
  private readonly handlers: { [K in keyof SecureDesktopEvents]: Set<SecureDesktopEvents[K]> } = {
    frame: new Set(),
    'desktop-changed': new Set(),
    'grant-challenge': new Set(),
    error: new Set(),
    close: new Set(),
  };

  private connection?: SecureDesktopTransport;
  private pendingConnect?: { resolve: (hello: ServerHello) => void; reject: (error: Error) => void };
  /** Handshake progress: our nonce while awaiting `server-auth`, then 'proved'
   *  once we sent `client-auth`, then 'done' after `server-hello`. */
  private handshake:
    | { stage: 'await-server-auth'; clientNonce: Buffer }
    | { stage: 'await-hello' }
    | { stage: 'done' } = { stage: 'done' };
  /** Set once authenticated; cleared when the connection ends. */
  private current?: SecureDesktopSession;
  private readonly inputDeadlineMs: number;
  /** Rejecters of `sendInput` promises still waiting for their write. */
  private readonly pendingInputs = new Set<(error: Error) => void>();

  constructor(options: SecureDesktopClientOptions) {
    this.state = (options.readState ?? (() => defaultReadState(options.environment)))();
    this.available = this.state !== undefined;
    this.createConnection = options.createConnection ?? ((pipeName: string) => netConnect({ path: pipeName }));
    this.inputDeadlineMs = options.inputDeadlineMs ?? FRAME_DEADLINE_MS;
  }

  /** The authenticated session — protocol, helper version, console session,
   *  and the current input desktop — or `undefined` when not connected. */
  session(): SecureDesktopSession | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  /** End the session state and settle every pending `sendInput` as failed. */
  private endSession(reason: string): void {
    this.current = undefined;
    const error = new Error(reason);
    for (const reject of [...this.pendingInputs]) reject(error);
  }

  on<K extends keyof SecureDesktopEvents>(event: K, handler: SecureDesktopEvents[K]): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  private emit<K extends keyof SecureDesktopEvents>(event: K, ...args: Parameters<SecureDesktopEvents[K]>): void {
    for (const handler of this.handlers[event]) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  /**
   * Connect and complete the mutual challenge-response. Resolves with the
   * server hello.
   *
   * The secret never crosses the wire. We send only a fresh nonce; the server
   * must answer with its own nonce and `HMAC(secret, "server" ‖ ours ‖ its)`.
   * Only if that verifies do we send `HMAC(secret, "client" ‖ its ‖ ours)`. A
   * process squatting the pipe name without the secret therefore receives one
   * random nonce and nothing else: we abort before revealing our proof, and a
   * proof could not be reused anyway because it is bound to both fresh nonces.
   */
  connect(): Promise<ServerHello> {
    if (!this.state) {
      return Promise.reject(new Error('secure desktop service is not installed'));
    }
    if (this.connection) {
      return Promise.reject(new Error('already connected'));
    }
    const state = this.state;
    const connection = this.createConnection(state.pipeName || SERVICE_PIPE_NAME);
    this.connection = connection;

    return new Promise<ServerHello>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      connection.on('data', (chunk: Buffer) => this.onData(chunk));
      connection.on('error', (error: Error) => this.fail(error));
      connection.on('close', () => {
        this.endSession('connection closed');
        this.emit('close');
        this.fail(new Error('connection closed'));
        this.connection = undefined;
      });
      const clientNonce = generateNonce();
      this.handshake = { stage: 'await-server-auth', clientNonce: decodeNonce(clientNonce) as Buffer };
      connection.write(encodeControl({ type: 'client-hello', protocol: PROTOCOL_VERSION, clientNonce }));
    });
  }

  /** Abort a handshake: reject `connect()` and drop the connection without
   *  sending anything further. */
  private abort(code: string, message: string): void {
    this.endSession(`${code}: ${message}`);
    this.emit('error', code, message);
    this.fail(new Error(`${code}: ${message}`));
    this.handshake = { stage: 'done' };
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy?.();
  }

  private fail(error: Error): void {
    if (this.pendingConnect) {
      this.pendingConnect.reject(error);
      this.pendingConnect = undefined;
    }
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      // Malformed framing or a schema-invalid message: drop the connection
      // without dispatching anything from this chunk.
      this.abort('protocol', (error as Error).message);
      return;
    }
    for (const frame of frames) {
      if (!this.connection) return; // aborted by an earlier frame in this chunk
      if (this.handshake.stage !== 'done') {
        this.onHandshake(frame);
        continue;
      }
      if (frame.kind === 'video') {
        this.emit('frame', frame.header, frame.pixels);
        continue;
      }
      this.onControl(frame.message);
    }
  }

  /** Drive the client side of the challenge-response. Anything out of order
   *  (video, input, an unexpected type) aborts before we reveal our proof. */
  private onHandshake(frame: ReturnType<FrameParser['push']>[number]): void {
    if (!this.state) return;
    if (frame.kind !== 'control') {
      this.abort('protocol', 'video frame before authentication');
      return;
    }
    const message = frame.message;
    if (message.type === 'error') {
      this.abort(message.code, message.message);
      return;
    }
    if (this.handshake.stage === 'await-server-auth') {
      if (message.type !== 'server-auth') {
        this.abort('protocol', `expected server-auth, got ${message.type}`);
        return;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        this.abort('protocol_mismatch', `server speaks protocol ${message.protocol}`);
        return;
      }
      const serverNonce = decodeNonce(message.serverNonce);
      const clientNonce = this.handshake.clientNonce;
      if (!serverNonce || !tagsMatch(serverAuthTag(this.state.secret, clientNonce, serverNonce), message.mac)) {
        // Not the real helper: abort WITHOUT sending our proof.
        this.abort('unauthorized', 'server failed to prove the install secret');
        return;
      }
      this.handshake = { stage: 'await-hello' };
      this.connection?.write(
        encodeControl({ type: 'client-auth', mac: clientAuthTag(this.state.secret, serverNonce, clientNonce) })
      );
      return;
    }
    // stage 'await-hello'
    if (message.type !== 'server-hello' || message.protocol !== PROTOCOL_VERSION) {
      this.abort('protocol', `expected server-hello, got ${message.type}`);
      return;
    }
    this.handshake = { stage: 'done' };
    this.onControl(message);
  }

  private onControl(message: ControlMessage): void {
    switch (message.type) {
      case 'server-hello': {
        const hello: SecureDesktopSession = {
          protocol: message.protocol,
          version: message.version,
          session: message.session,
          desktop: message.desktop,
          ...(message.locked === undefined ? {} : { locked: message.locked }),
        };
        this.current = hello;
        if (this.pendingConnect) {
          this.pendingConnect.resolve({ ...hello });
          this.pendingConnect = undefined;
        }
        break;
      }
      case 'desktop-changed':
        if (this.current) {
          this.current = {
            protocol: this.current.protocol,
            version: this.current.version,
            desktop: message.desktop,
            session: message.session,
            ...(message.locked === undefined ? {} : { locked: message.locked }),
          };
        }
        this.emit('desktop-changed', message.desktop, message.session, message.locked);
        break;
      case 'grant-challenge':
        this.emit('grant-challenge', { nonce: message.nonce, challenge: message.challenge });
        break;
      case 'error':
        this.emit('error', message.code, message.message);
        this.fail(new Error(`${message.code}: ${message.message}`));
        break;
      default:
        // The client never acts on handshake/input/control messages after auth.
        break;
    }
  }

  private send(message: ControlMessage): void {
    // Nothing but handshake messages may precede mutual authentication.
    if (!this.connection || this.handshake.stage !== 'done') return;
    this.connection.write(encodeControl(message));
  }

  /** Start or stop the remote-control session. Capture and injection are inert
   *  until this is called with `true`. */
  setActive(active: boolean): void {
    this.send({ type: 'control', active });
  }

  /**
   * Send one input event. Settles in bounded time: resolves once the write has
   * been handed to the pipe, rejects at once when not authenticated, when the
   * connection ends first, or after the helper's frame deadline — past which
   * the helper would drop a peer anyway. "Resolved" means handed to the pipe,
   * not executed: there are no input acks. The helper applies a release
   * (`down: false`) only for a button/key this connection pressed and still
   * holds — while control is inactive, in place and without movement.
   */
  sendInput(event: InputEvent): Promise<void> {
    return this.sendBounded({ type: 'input', event });
  }

  /** Declare the video run (the app's epoch) the phone is being shown. A
   *  grant names the run it was signed for; another run ends the live grant. */
  setVideoRun(epoch: number): void {
    this.send({ type: 'video-run', epoch });
  }

  /** Relay the phone's signed answer to a `grant-challenge`. The helper
   *  verifies it against the enrolled phone key; the app cannot forge one. */
  sendGrant(grant: SecureDesktopGrant): Promise<void> {
    return this.sendBounded({
      type: 'grant',
      challenge: grant.challenge,
      epoch: grant.epoch,
      signature: grant.signature,
    });
  }

  /** Ask for Ctrl+Alt+Del (the service presses it). Settles like `sendInput`;
   *  a refusal (`grant_required`, `sas_disabled_by_policy`) arrives as `error`. */
  sas(): Promise<void> {
    return this.sendBounded({ type: 'sas' });
  }

  /** Write one authenticated message, settling in bounded time (see
   *  `sendInput`). */
  private sendBounded(message: ControlMessage): Promise<void> {
    const connection = this.connection;
    if (!connection || this.handshake.stage !== 'done') {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingInputs.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error(`input not taken by the helper within ${this.inputDeadlineMs} ms`)),
        this.inputDeadlineMs
      );
      this.pendingInputs.add(settle);
      connection.write(encodeControl(message), (error?: Error | null) => settle(error));
    });
  }

  /** Fire-and-forget form for the convenience methods: no-ops when not
   *  connected; failures surface through `sendInput` callers and `close`. */
  private input(event: InputEvent): void {
    this.sendInput(event).catch(() => undefined);
  }

  pointerMove(x: number, y: number): void {
    this.input({ kind: 'pointer-move', x, y });
  }

  pointerButton(button: PointerButton, down: boolean, x: number, y: number): void {
    this.input({ kind: 'pointer-button', button, down, x, y });
  }

  pointerWheel(x: number, y: number, dx: number, dy: number): void {
    this.input({ kind: 'pointer-wheel', x, y, dx, dy });
  }

  key(down: boolean, vk: number, scan = 0, extended = false): void {
    this.input({ kind: 'key', down, vk, scan, extended });
  }

  text(value: string): void {
    this.input({ kind: 'text', text: value });
  }

  close(): void {
    if (!this.connection) return;
    this.setActive(false);
    // Writes already issued flush before `end`; their `sendInput` promises
    // settle from their own callbacks. Only the session view is cleared here.
    this.current = undefined;
    try {
      this.connection.end();
    } catch {
      this.connection.destroy?.();
    }
    this.connection = undefined;
  }
}

/** Construct a client. Safe to call when the service is not installed; the
 *  returned client reports `available: false` and no-ops. */
export function createSecureDesktopClient(options: SecureDesktopClientOptions): SecureDesktopClient {
  return new SecureDesktopClient(options);
}

function parseStatus(stdout: string): SecureDesktopStatus {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .pop();
  if (!line) return { installed: false, running: false };
  try {
    const parsed = JSON.parse(line) as { installed?: boolean; running?: boolean; version?: string };
    return {
      installed: Boolean(parsed.installed),
      running: Boolean(parsed.running),
      version: parsed.version,
    };
  } catch {
    return { installed: false, running: false };
  }
}

/** Exit code of an elevated run whose UAC prompt was declined
 *  (`ERROR_CANCELLED`). */
export const ELEVATION_DECLINED_EXIT = 1223;
/** The bridge's own exit codes: another elevated install is already running… */
export const SECURE_DESKTOP_BUSY_EXIT = 75;
/** …the service is installed for a different Windows account (nothing changed)… */
export const SECURE_DESKTOP_OTHER_USER_EXIT = 4;
/** …the image was refused: not a pinned, signed, unrevoked release build… */
export const SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT = 5;
/** …and its certificate revocation status could not be determined in time. */
export const SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT = 6;
/** `check --controller-key k`: installed and current, but that phone's key is
 *  not enrolled (offer an enroll, not a reinstall). */
export const SECURE_DESKTOP_NOT_ENROLLED_EXIT = 7;
// Credential-logon (`--logon`) exit codes: the typed Windows password did not
// authenticate, the account is not an unfiltered admin, or the account/policy
// refused the logon. Each maps to a phone outcome.
export const SECURE_DESKTOP_BAD_CREDENTIALS_EXIT = 10;
export const SECURE_DESKTOP_NOT_ADMIN_EXIT = 11;
export const SECURE_DESKTOP_LOGON_TYPE_DENIED_EXIT = 12;
export const SECURE_DESKTOP_ACCOUNT_LOCKED_EXIT = 13;
export const SECURE_DESKTOP_ACCOUNT_DISABLED_EXIT = 14;
export const SECURE_DESKTOP_POLICY_BLOCKED_EXIT = 15;
// App-delegated (`--delegated`) exit codes: delegation is off, the service
// refused this caller, or the service was unreachable.
export const SECURE_DESKTOP_DELEGATION_DISABLED_EXIT = 20;
export const SECURE_DESKTOP_DELEGATION_DENIED_EXIT = 21;
export const SECURE_DESKTOP_DELEGATION_UNAVAILABLE_EXIT = 22;

/** Run `file args`, resolving its exit code; a spawn failure rejects. */
async function exitCodeOf(file: string, args: string[]): Promise<number> {
  try {
    await execFileAsync(file, args, { windowsHide: true });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    throw error;
  }
}

/** The `error` of the bridge's last JSON line, when it printed one. */
function bridgeError(stdout: unknown): string | undefined {
  if (typeof stdout !== 'string') return undefined;
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .pop();
  try {
    const parsed = line ? (JSON.parse(line) as { error?: unknown }) : undefined;
    return typeof parsed?.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the bundled bridge would pass the elevated install's image check. */
export type SecureDesktopImageCheck = { ok: true } | { ok: false; detail: string };

/**
 * Run the bridge's unelevated `verify-image`: the same pinned-signer check the
 * elevated `install` applies to itself. Lets a request that is bound to be
 * refused (an unpinned dev build, an unsigned or foreign image) fail with the
 * reason instead of showing a UAC prompt first. Not a security boundary — the
 * elevated install re-verifies.
 */
export async function verifySecureDesktopImage(
  environment: SecureDesktopEnvironment
): Promise<SecureDesktopImageCheck> {
  if (environment.platform !== 'win32') return { ok: false, detail: 'the secure-desktop helper is Windows-only' };
  try {
    // No wrapper timeout: its external waits are limited inside — the online
    // revocation retrieval (20 s cumulative) and each single chain-building
    // fetch (Windows' default per-URL retrieval timeout, 15 s, a configurable
    // policy value; not a limit on the whole check); the rest is local work.
    await execFileAsync(secureDesktopExePath(environment), ['verify-image'], { windowsHide: true });
    return { ok: true };
  } catch (error) {
    const detail = bridgeError((error as { stdout?: unknown }).stdout);
    return { ok: false, detail: detail ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** The admin-gated subcommands the app runs through one of the three
 *  authorization paths (UAC elevation, `--logon`, or `--delegated`). */
export type SecureDesktopAdminVerb = 'install' | 'enroll' | 'revoke';

/**
 * Run an elevated subcommand (one UAC prompt) and wait for it. PowerShell's
 * `Start-Process -Verb RunAs -PassThru` launches through `ShellExecuteEx` with
 * `SEE_MASK_NOCLOSEPROCESS` and keeps the elevated process handle, and the
 * wrapper exits only after `WaitForExit` on it — so the returned promise
 * settles exactly when the launched elevation has finished (there is
 * deliberately no timeout that would abandon a still-running child). Resolves
 * the bridge's exit code, or `ELEVATION_DECLINED_EXIT` when the prompt was
 * declined; rejects only when it could not be launched.
 */
export async function elevateSecureDesktop(
  environment: SecureDesktopEnvironment,
  verbArgument: SecureDesktopAdminVerb,
  extraArguments: readonly string[] = []
): Promise<number> {
  const exe = secureDesktopExePath(environment);
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const argumentList = [verbArgument, ...extraArguments].map(quote).join(',');
  const command = [
    'try {',
    `  $p = Start-Process -FilePath ${quote(exe)} -ArgumentList @(${argumentList}) ` +
      '-Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e) {',
    `    if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${ELEVATION_DECLINED_EXIT}) { exit ${ELEVATION_DECLINED_EXIT} }`,
    '    $e = $e.InnerException',
    '  }',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
    // Holding the handle keeps ExitCode readable after the process exits.
    '$null = $p.Handle',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n');
  return exitCodeOf('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
}

/** A Windows administrator credential the phone typed for the remote (no-one
 *  at the PC) install path. `user` is optional: when omitted, the bridge uses
 *  the account running the app (`GetUserNameExW`). The password is never put in
 *  argv, the environment, logs or events — only on the child's stdin. */
export interface SecureDesktopCredential {
  password: string;
  user?: string;
}

/**
 * Run an admin-gated subcommand **unelevated, under a batch logon** from a
 * Windows password typed on the phone (`--logon`). The credential is written
 * only to the child's stdin as `<user>\n<password>` (an empty first line means
 * "use the app's own account"); it never appears in argv, the environment or
 * any log. Resolves the bridge's exit code (the `SECURE_DESKTOP_*_EXIT`
 * credential codes map to phone outcomes); rejects only when it could not be
 * spawned. The stdin string is dropped as soon as it is written.
 */
export function runSecureDesktopWithLogon(
  environment: SecureDesktopEnvironment,
  verbArgument: SecureDesktopAdminVerb,
  extraArguments: readonly string[],
  credential: SecureDesktopCredential
): Promise<number> {
  const exe = secureDesktopExePath(environment);
  const args = [verbArgument, ...extraArguments, '--logon'];
  const stdin = `${credential.user ?? ''}\n${credential.password}`;
  return new Promise<number>((resolve, reject) => {
    const child = execFile(exe, args, { windowsHide: true }, (error) => {
      if (!error) return resolve(0);
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'number') return resolve(code);
      return reject(error);
    });
    // Write the secret to stdin and close it; never retained after this.
    child.stdin?.end(stdin);
  });
}

/**
 * Run an admin-gated enroll/revoke **unelevated through the app-delegation
 * path** (`--delegated`): the bridge asks the SYSTEM service, which decides
 * against the stored delegation policy. No prompt, no credential. Resolves the
 * bridge's exit code; rejects only when it could not be spawned.
 */
export function runSecureDesktopDelegated(
  environment: SecureDesktopEnvironment,
  verbArgument: 'enroll' | 'revoke',
  extraArguments: readonly string[]
): Promise<number> {
  return exitCodeOf(secureDesktopExePath(environment), [verbArgument, ...extraArguments, '--delegated']);
}

/** Whether the installed service matches the bundled bridge, from its
 *  unelevated `check` (exit 0 current / 1 missing / 2 stale / 4 other-user /
 *  7 not-enrolled). `other-user` is a service another Windows account
 *  installed. */
export type SecureDesktopInstallState =
  | 'installed'
  | 'outdated'
  | 'not-installed'
  /** Installed and current, but the asking phone's key is not enrolled (bridge
   *  exit 7): add that one key (enroll), never a reinstall. */
  | 'not-enrolled'
  | 'other-user'
  | 'unavailable';

export function installStateFromCheckExit(exitCode: number): SecureDesktopInstallState {
  switch (exitCode) {
    case 0:
      return 'installed';
    case 1:
      return 'not-installed';
    case 2:
      return 'outdated';
    case 4:
      return 'other-user';
    case SECURE_DESKTOP_NOT_ENROLLED_EXIT:
      return 'not-enrolled';
    default:
      return 'unavailable';
  }
}

/** Run the bridge's `check`. Never elevates. `unavailable` off Windows, when
 *  the bridge is not shipped, or when the state cannot be determined. With a
 *  phone's `controllerKey`, a current install that does not enroll that key
 *  reads as `not-enrolled` (an enroll adds it). */
export async function secureDesktopInstallState(
  environment: SecureDesktopEnvironment,
  controllerKey?: string
): Promise<SecureDesktopInstallState> {
  if (environment.platform !== 'win32') return 'unavailable';
  const args = controllerKey === undefined ? ['check'] : ['check', '--controller-key', controllerKey];
  try {
    // No wrapper timeout: `check` is local work (an SCM query and file reads)
    // that waits on nothing external.
    return installStateFromCheckExit(await exitCodeOf(secureDesktopExePath(environment), args));
  } catch {
    return 'unavailable';
  }
}

/**
 * Start the installed demand-start service without elevation (the install
 * granted the installing user start rights). Used to bring the service back up
 * after a reboot when a remote session needs it — never installs or prompts.
 * Returns whether it is running afterwards.
 */
export async function startSecureDesktopService(environment: SecureDesktopEnvironment): Promise<SecureDesktopStatus> {
  if (environment.platform !== 'win32') return { installed: false, running: false };
  try {
    // No wrapper timeout: `start` ends by the documented checkpoint/wait-hint
    // pattern (stalled, settled or running), which has no fixed cap to mirror:
    // by design it keeps waiting for as long as the checkpoint keeps advancing.
    const { stdout } = await execFileAsync(secureDesktopExePath(environment), ['start'], {
      windowsHide: true,
    });
    return parseStatus(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    // `start` exits non-zero when it could not reach a running state; it still
    // printed its JSON, so parse that rather than guess.
    return typeof stdout === 'string' ? parseStatus(stdout) : { installed: false, running: false };
  }
}
