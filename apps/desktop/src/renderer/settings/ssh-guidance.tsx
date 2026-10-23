import type { ReactNode } from 'react';

import type { DesktopSshAgentStatus, DesktopSshFailure } from '../../shared/contract-ssh';
import { t } from '../i18n';
import { Steps } from './connection-dialogs';
import { AddressRow } from './pair-code';

export type GuidanceFailure = Exclude<
  DesktopSshFailure,
  { kind: 'host-key-changed' | 'host-key-next' | 'daemon-running' | 'daemon-busy' | 'cancelled' }
>;

export interface Guidance {
  title: string;
  description: string;
  body: ReactNode;
}

/** A failure as a guidance view; kinds that have a view of their own in the connect dialog read as a plain failure here. */
export function toGuidance(failure: DesktopSshFailure): GuidanceFailure {
  switch (failure.kind) {
    case 'host-key-changed':
    case 'host-key-next':
    case 'daemon-running':
    case 'daemon-busy':
    case 'cancelled':
      return { kind: 'failed', message: t('The connection could not be completed.') };
    default:
      return failure;
  }
}

function commandStep(n: number, label: string, command: string): ReactNode {
  return (
    <div className="conn-stack">
      <Steps start={n} items={[label]} />
      <AddressRow address={command} />
    </div>
  );
}

function commandBlock(command: string): ReactNode {
  return (
    <div className="conn-stack" style={{ minWidth: 0 }}>
      <AddressRow address={command} />
    </div>
  );
}

function rawMessage(message: string): ReactNode {
  return <p className="conn-note conn-note--raw">{message}</p>;
}

function agentHint(agent: DesktopSshAgentStatus | undefined): ReactNode {
  if (!agent || agent.state === 'running' || agent.state === 'unknown') return null;
  const text: Record<string, string> = {
    stopped: t(
      'The ssh-agent service is stopped, so a passphrase-protected key cannot be used without typing it. Start it in PowerShell:'
    ),
    disabled: t('The ssh-agent service is disabled. Enable and start it in an administrator PowerShell:'),
    missing: t('No ssh-agent is running. Start one and load your key:'),
    empty: t('The ssh-agent has no keys. Load your key:'),
  };
  return (
    <div className="conn-stack">
      <p className="conn-note">{text[agent.state]}</p>
      {agent.command && <AddressRow address={agent.command} />}
    </div>
  );
}

function authGuidance(failure: Extract<GuidanceFailure, { kind: 'auth' }>): Guidance {
  return {
    title: t('Can’t sign in'),
    description: t('No key is registered on this server. Run the commands below in this PC’s terminal, in order.'),
    body: (
      <div className="conn-stack" style={{ gap: 16 }}>
        {commandStep(1, t('Create a key'), failure.keygen)}
        {commandStep(2, t('Register the key on the server · the server password is asked once'), failure.register)}
        {agentHint(failure.agent)}
      </div>
    ),
  };
}

function sshMissingGuidance(command: string | null): Guidance {
  return {
    title: t('OpenSSH is not installed'),
    description: command
      ? t(
          'Mixdog connects with the OpenSSH client of Windows. Run the command below in an administrator PowerShell, then try again.'
        )
      : t('Mixdog connects with the OpenSSH client. Install it with your system’s package manager, then try again.'),
    body: command ? commandBlock(command) : null,
  };
}

function nodeDescription(failure: Extract<GuidanceFailure, { kind: 'node' }>, name: string): string {
  if (failure.reason === 'too-old' && failure.found) {
    const found = failure.found.startsWith('v') ? failure.found : `v${failure.found}`;
    return t(
      'The version found on {{name}} is {{found}}. Run the command below in the server terminal, then try again.',
      { name, found }
    );
  }
  return t('Node.js was not found on {{name}}. Run the command below in the server terminal, then try again.', {
    name,
  });
}

type MessageFailure = Extract<GuidanceFailure, { message: string }>;

/** The title and text of every failure whose only detail is the error message shown beneath them. */
const MESSAGE_GUIDANCE: Record<MessageFailure['kind'], (name: string) => Omit<Guidance, 'body'>> = {
  'unsupported-platform': (name) => ({
    title: t('This server can’t run Mixdog'),
    description: t('{{name}} uses a system Mixdog does not support yet.', { name }),
  }),
  'install-failed': (name) => ({
    title: t('The installation failed'),
    description: t('Mixdog could not be installed on {{name}}. Check the details below, then try again.', { name }),
  }),
  'protocol-mismatch': (name) => ({
    title: t('The Mixdog version on the server doesn’t match'),
    description: t(
      'Connecting again installs the matching version on {{name}}. If this keeps happening, use “Clean up Mixdog on the server…” in Settings → Connections, then connect again.',
      { name }
    ),
  }),
  internal: () => ({
    title: t('An unexpected error occurred'),
    description: t('Open “View log” or “Copy diagnostics” and include it when you report this.'),
  }),
  'remote-shell': (name) => ({
    title: t('The server’s login shell interferes'),
    description: t(
      '{{name}} printed something unexpected when Mixdog logged in, or its home folder could not be used. Remove any output from the login scripts (such as .bashrc) that runs in non-interactive sessions, then try again.',
      { name }
    ),
  }),
  'port-unavailable': (name) => ({
    title: t('The server has no free port'),
    description: t('Mixdog could not open its port on {{name}}. Check the details below, then try again.', { name }),
  }),
  'deps-install': (name) => ({
    title: t('The server couldn’t install what Mixdog needs'),
    description: t(
      '{{name}} needs npm and access to the npm registry or GitHub to install it. Check the details below, then try again.',
      { name }
    ),
  }),
  'daemon-stop': (name) => ({
    title: t('The old Mixdog could not be stopped'),
    description: t('Mixdog on {{name}} did not stop. Check the details below, then try again.', { name }),
  }),
  'daemon-replace': (name) => ({
    title: t('Mixdog could not be replaced'),
    description: t(
      'The Mixdog on {{name}} could not be replaced with this version. Check the details below, then try again.',
      { name }
    ),
  }),
  'daemon-unmanaged': (name) => ({
    title: t('Mixdog on the server was started by someone else'),
    description: t(
      'A Mixdog that was not started from this app is running on {{name}}. It was left running; Mixdog will not stop it for you. Stop it yourself on the server, or use that Mixdog directly, then try again.',
      { name }
    ),
  }),
  'daemon-data-in-use': (name) => ({
    title: t('The server’s Mixdog data is in use'),
    description: t(
      'Another Mixdog on {{name}} is using the same data folder. It was left running. Close it on the server, then try again.',
      { name }
    ),
  }),
  'daemon-unproven': (name) => ({
    title: t('This Mixdog can’t be confirmed'),
    description: t(
      'The process on {{name}} could not be confirmed as Mixdog, so it was left alone. Check the details below.',
      { name }
    ),
  }),
  failed: () => ({
    title: t('Couldn’t connect'),
    description: t('Check the details below, then try again.'),
  }),
};

/** The title, text and commands of a view that explains why a connection stopped. */
export function guidance(failure: GuidanceFailure, name: string): Guidance {
  switch (failure.kind) {
    case 'auth':
      return authGuidance(failure);
    case 'ssh-missing':
      return sshMissingGuidance(failure.command);
    case 'host-key-revoked':
      return {
        title: t('This server’s key is revoked'),
        description: t(
          'Your known_hosts file marks this key as revoked, so the connection was not made. Ask the server administrator for a new key.'
        ),
        body: null,
      };
    case 'already-connected':
      return {
        title: t('This server is already connected'),
        description: t('Disconnect it first to change its login key or folder.'),
        body: null,
      };
    case 'install-locked':
      return {
        title: t('Another installation is running'),
        description: t(
          'Mixdog is already being installed on {{name}} by another connection. Wait a moment, then try again.',
          { name }
        ),
        body: null,
      };
    case 'node':
      return {
        title: t('The server needs Node.js {{version}}', { version: failure.required }),
        description: nodeDescription(failure, name),
        body: commandBlock(failure.command),
      };
    case 'npm-missing':
      return {
        title: t('The server needs npm'),
        description: t(
          'npm was not found on {{name}}. Install Node.js, which includes npm, with the command below in the server terminal, then try again.',
          { name }
        ),
        body: commandBlock(failure.command),
      };
    default:
      return { ...MESSAGE_GUIDANCE[failure.kind](name), body: rawMessage(failure.message) };
  }
}
