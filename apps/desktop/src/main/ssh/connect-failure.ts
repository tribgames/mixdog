// Maps what a failed connection threw (SshError, RemoteBootstrapError) to the
// guidance view the connect dialog shows for it.
import type { DesktopSshFailure } from '../../shared/contract-ssh';
import { REMOTE_MIN_NODE_MAJOR, RemoteBootstrapError } from './remote-bootstrap';
import { isSshMissingMessage, WINDOWS_SSH_CLIENT_COMMAND } from './ssh-binary';
import { SshError, type SshTarget } from './ssh-command';

const HOST_KEY_CHANGED =
  /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key for \S+ has changed/i;
// Strict checking refuses a key it has never seen with the same closing line as
// a changed one; only the second is a warning about the server.
const HOST_KEY_UNKNOWN = /No \S+ host key is known for/i;
const LOGIN_REFUSED =
  /Permission denied|Too many authentication failures|Authentication failed|No more authentication methods/i;
const MAX_MESSAGE_LENGTH = 800;

const boundedMessage = (message: string): string => message.trim().slice(-MAX_MESSAGE_LENGTH);

export const NODE_INSTALL_COMMAND = `curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${REMOTE_MIN_NODE_MAJOR}`;

/** The two commands that put this PC's login key on the server. Windows has
 *  no ssh-copy-id, so its second command pipes the public key through ssh. */
export function loginKeyCommands(target: SshTarget, platform: NodeJS.Platform): { keygen: string; register: string } {
  const port = target.port ? `-p ${target.port} ` : '';
  const register =
    platform === 'win32'
      ? `Get-Content "$env:USERPROFILE\\.ssh\\id_ed25519.pub" | ssh ${port}${target.destination} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`
      : `ssh-copy-id ${port}${target.destination}`;
  return { keygen: 'ssh-keygen -t ed25519', register };
}

/** The failure view for what a connection threw, carrying the error `code` the view shows in its details (and docs/support refer to). */
export function describeConnectFailure(
  error: unknown,
  target: SshTarget,
  platform: NodeJS.Platform
): DesktopSshFailure {
  const failure = classifyConnectFailure(error, target, platform);
  if (error instanceof RemoteBootstrapError) return { ...failure, code: error.code };
  if (error instanceof SshError && failure.kind === 'failed') return { ...failure, code: `ssh-${error.kind}` };
  return { ...failure, code: failure.kind };
}

function classifyConnectFailure(error: unknown, target: SshTarget, platform: NodeJS.Platform): DesktopSshFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RemoteBootstrapError) {
    switch (error.code) {
      case 'node-missing':
      case 'node-too-old': {
        const found = /found (\S+?)\.?$/.exec(error.message)?.[1] ?? null;
        return {
          kind: 'node',
          reason: error.code === 'node-missing' ? 'missing' : 'too-old',
          found: error.code === 'node-missing' ? null : found,
          required: REMOTE_MIN_NODE_MAJOR,
          command: NODE_INSTALL_COMMAND,
        };
      }
      case 'npm-missing':
        return { kind: 'npm-missing', command: NODE_INSTALL_COMMAND };
      case 'daemon-not-proxy':
      case 'daemon-model-login': {
        const pid = Number(/\bpid (\d+)/.exec(error.message)?.[1]);
        if (Number.isInteger(pid) && pid > 0) return { kind: 'daemon-running', pid };
        break;
      }
    }
    // Codes the server install reports; compared as text so the two sides can evolve apart.
    switch (String(error.code)) {
      case 'unsupported-platform':
        return { kind: 'unsupported-platform', message: boundedMessage(message) };
      case 'install-failed':
      case 'local-payload':
        return { kind: 'install-failed', message: boundedMessage(message) };
      case 'protocol-mismatch':
        return { kind: 'protocol-mismatch', message: boundedMessage(message) };
      case 'internal':
      case 'protocol':
        return { kind: 'internal', message: boundedMessage(message) };
      case 'remote-shell':
      case 'remote-home':
        return { kind: 'remote-shell', message: boundedMessage(message) };
      case 'install-locked':
        return { kind: 'install-locked' };
      case 'daemon-busy-other-version':
        return { kind: 'daemon-busy', message: boundedMessage(message) };
      case 'port-unavailable':
        return { kind: 'port-unavailable', message: boundedMessage(message) };
      case 'deps-install':
        return { kind: 'deps-install', message: boundedMessage(message) };
      case 'daemon-stop':
      case 'daemon-replace':
      case 'daemon-unproven':
      case 'daemon-unmanaged':
      case 'daemon-data-in-use':
        return {
          kind: error.code as
            | 'daemon-stop'
            | 'daemon-replace'
            | 'daemon-unproven'
            | 'daemon-unmanaged'
            | 'daemon-data-in-use',
          message: boundedMessage(message),
        };
    }
  } else {
    const text = error instanceof SshError ? `${error.stderrTail}\n${message}` : message;
    if (isSshMissingMessage(text))
      return { kind: 'ssh-missing', command: platform === 'win32' ? WINDOWS_SSH_CLIENT_COMMAND : null };
    if (HOST_KEY_CHANGED.test(text) && !HOST_KEY_UNKNOWN.test(text)) return { kind: 'host-key-changed' };
    if (LOGIN_REFUSED.test(text)) return { kind: 'auth', ...loginKeyCommands(target, platform) };
  }
  return { kind: 'failed', message: boundedMessage(message) };
}
