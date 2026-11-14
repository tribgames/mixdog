/**
 * The ssh destination the Add server dialog checks as the user types: what
 * counts as a target, and the name a saved server gets by default. The
 * connection itself (arguments, tunnel, failures) is the core's (mixdog-ssh).
 */

export interface SshTarget {
  /** What ssh receives after `--`: a Host alias, `host` or `user@host`. */
  readonly destination: string;
  /** Explicit port from a `user@host:port` target; null defers to ssh config. */
  readonly port: number | null;
  /** The target as configured, for messages. */
  readonly display: string;
}

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
