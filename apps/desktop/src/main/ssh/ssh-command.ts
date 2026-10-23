/**
 * Pure building blocks for driving the system OpenSSH client: target
 * validation, argument vectors, failure classification and the tunnel
 * restart schedule. Nothing here spawns a process.
 */

export interface SshTarget {
  /** What ssh receives after `--`: a Host alias, `host` or `user@host`. */
  readonly destination: string;
  /** Explicit port from a `user@host:port` target; null defers to ssh config. */
  readonly port: number | null;
  /** The target as configured, for messages. */
  readonly display: string;
}

/** Options every ssh spawn carries. Windows OpenSSH has no ControlMaster, so
 *  multiplexing is switched off everywhere for identical behavior. Host keys
 *  are checked strictly: a key enters known_hosts only through the pin the user
 *  confirmed (host-key.ts), never silently from a connection. */
export const SSH_COMMON_OPTIONS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  // No credential or display forwarding, whatever the user's ssh config says for this host.
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ForwardX11Trusted=no',
];

/** Seconds between tunnel restarts; the last entry repeats. */
export const TUNNEL_BACKOFF_SECONDS: readonly number[] = [1, 2, 5, 5, 10, 10, 10, 30, 30];
/** A tunnel that stayed up this long starts the schedule over. */
export const TUNNEL_HEALTHY_RESET_MS = 60_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// Host aliases, user names, DNS names, IPv4/IPv6 literals (with zone ids).
// Anything else (quotes, spaces, `$`, `;`, `/`...) is refused: ssh expands the
// host into ProxyCommand/Match exec lines, where shell metacharacters bite.
const TARGET_CHARACTERS = /^[A-Za-z0-9._@:%[\]+-]+$/;

export class SshTargetError extends Error {
  override readonly name = 'SshTargetError';
}

function parsePort(text: string, raw: string): number {
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshTargetError(`MIXDOG_SSH_TARGET has an invalid port: ${JSON.stringify(raw)}`);
  }
  return port;
}

/** Validate an ssh destination (`alias`, `host`, `user@host`, `user@host:port`,
 *  `user@[v6]:port`) so it can never be read as an ssh option. */
export function parseSshTarget(raw: string): SshTarget {
  const text = String(raw ?? '');
  if (CONTROL_CHARACTERS.test(text)) {
    throw new SshTargetError('MIXDOG_SSH_TARGET must not contain control characters.');
  }
  const value = text.trim();
  if (!value) throw new SshTargetError('MIXDOG_SSH_TARGET is empty.');
  if (value.startsWith('-')) {
    throw new SshTargetError(`MIXDOG_SSH_TARGET must not start with "-": ${JSON.stringify(value)}`);
  }
  if (!TARGET_CHARACTERS.test(value)) {
    throw new SshTargetError(`MIXDOG_SSH_TARGET contains unsupported characters: ${JSON.stringify(value)}`);
  }
  const at = value.lastIndexOf('@');
  const user = at >= 0 ? value.slice(0, at) : '';
  const hostPart = at >= 0 ? value.slice(at + 1) : value;
  if (at >= 0 && !user) throw new SshTargetError(`MIXDOG_SSH_TARGET has an empty user: ${JSON.stringify(value)}`);
  let host = hostPart;
  let port: number | null = null;
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(hostPart);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2] !== undefined) port = parsePort(bracketed[2], value);
  } else if (hostPart.includes('[') || hostPart.includes(']')) {
    throw new SshTargetError(`MIXDOG_SSH_TARGET has an unbalanced IPv6 literal: ${JSON.stringify(value)}`);
  } else if (hostPart.split(':').length === 2) {
    const colon = hostPart.indexOf(':');
    host = hostPart.slice(0, colon);
    port = parsePort(hostPart.slice(colon + 1), value);
  }
  // More than one colon without brackets is a bare IPv6 literal: no port.
  if (!host) throw new SshTargetError(`MIXDOG_SSH_TARGET has an empty host: ${JSON.stringify(value)}`);
  if (host.startsWith('-') || user.startsWith('-')) {
    throw new SshTargetError(`MIXDOG_SSH_TARGET must not start a user or host with "-": ${JSON.stringify(value)}`);
  }
  return { destination: user ? `${user}@${host}` : host, port, display: value };
}

/** The alias or host of a target, without user and port: the default name of a saved server. */
export function sshTargetLabel(target: SshTarget): string {
  return target.destination.slice(target.destination.lastIndexOf('@') + 1);
}

/** What makes two saved servers the same one: the user and port as typed, the host name without regard to case. */
export function sshTargetKey(target: SshTarget): string {
  const at = target.destination.lastIndexOf('@');
  const user = at >= 0 ? target.destination.slice(0, at) : '';
  return `${user}@${target.destination.slice(at + 1).toLowerCase()}:${target.port ?? ''}`;
}

function baseArgs(target: SshTarget): string[] {
  return [...SSH_COMMON_OPTIONS, ...(target.port ? ['-p', String(target.port)] : [])];
}

/** Short exec: one remote command, no forwards inherited from ssh_config. */
export function sshExecArgs(target: SshTarget, remoteCommand: string): string[] {
  return [...baseArgs(target), '-T', '-o', 'ClearAllForwardings=yes', '--', target.destination, remoteCommand];
}

/** Long-lived local forward to the daemon's loopback session port. ClearAllForwardings cannot be used here: ssh would drop this `-L` with the forwards of the config (checked with `ssh -G`), so forwards a config defines for the host are found beforehand (host-key.ts `forwards`) and the connection refuses them. */
export function sshTunnelArgs(target: SshTarget, localPort: number, remotePort: number): string[] {
  return [
    ...baseArgs(target),
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    target.destination,
  ];
}

/** One connection carried to 127.0.0.1:`remotePort` on the server over the
 *  child's stdin/stdout (`-W` implies -N, -T, ExitOnForwardFailure and
 *  ClearAllForwardings). */
export function sshStdioForwardArgs(target: SshTarget, remotePort: number): string[] {
  return [...baseArgs(target), '-W', `127.0.0.1:${remotePort}`, '--', target.destination];
}

export type SshFailureKind = 'terminal' | 'transient';

const TERMINAL_SSH_FAILURES: readonly RegExp[] = [
  /REMOTE HOST IDENTIFICATION HAS CHANGED/i,
  /Host key verification failed/i,
  /Host key for \S+ has changed/i,
  /Permission denied/i,
  /Too many authentication failures/i,
  /Authentication failed/i,
  /No more authentication methods/i,
];

/** Retrying cannot fix a changed host key or a refused login. */
export function classifySshFailure(stderr: string): SshFailureKind {
  return TERMINAL_SSH_FAILURES.some((pattern) => pattern.test(stderr)) ? 'terminal' : 'transient';
}

/** The local end of a forward could not be bound: pick another local port. */
export function isLocalForwardBindFailure(stderr: string): boolean {
  return /cannot listen to port|Could not request local forwarding|bind \[?127\.0\.0\.1\]?.*(?:Address already in use|Permission denied)/i.test(
    stderr
  );
}

/** Last lines of ssh's stderr, verbatim. */
export function stderrTail(stderr: string, maxLines = 12, maxChars = 2_000): string {
  const lines = stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim());
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export class SshError extends Error {
  override readonly name = 'SshError';
  constructor(
    message: string,
    readonly kind: SshFailureKind,
    readonly stderrTail = '',
    readonly exitCode: number | null = null
  ) {
    super(message);
  }
}

export function isTerminalSshError(error: unknown): error is SshError {
  return error instanceof SshError && error.kind === 'terminal';
}

/** Restart schedule for the supervised tunnel: walks TUNNEL_BACKOFF_SECONDS
 *  and starts over once a tunnel stayed healthy for TUNNEL_HEALTHY_RESET_MS. */
export class TunnelBackoff {
  private index = 0;

  constructor(
    private readonly scheduleMs: readonly number[] = TUNNEL_BACKOFF_SECONDS.map((seconds) => seconds * 1_000),
    private readonly healthyResetMs = TUNNEL_HEALTHY_RESET_MS
  ) {}

  /** Delay before the next start, given how long the last tunnel was ready
   *  (0 when it never became ready). */
  next(healthyForMs: number): number {
    if (healthyForMs >= this.healthyResetMs) this.index = 0;
    const delay = this.scheduleMs[Math.min(this.index, this.scheduleMs.length - 1)];
    this.index += 1;
    return delay;
  }

  reset(): void {
    this.index = 0;
  }
}
