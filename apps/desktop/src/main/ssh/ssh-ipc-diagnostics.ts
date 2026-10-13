// The diagnostics handlers of the SSH IPC: the connection log of a server, the
// text the user copies into a bug report, and the tail of the server's daemon.log.
import type { IpcMainInvokeEvent } from 'electron';

import type { DesktopSshLogView, DesktopSshServerLog } from '../../shared/contract-ssh';
import { LOCAL_CONNECTION_ID } from '../connections/contract';
import { parseSshConfigDump, type RunTool } from './host-key';
import { parseSshTarget, type SshTarget } from './ssh-command';
import { runWithSshContext, type SshRunContext } from './ssh-context';
import {
  appendDiagnostic,
  buildDiagnosticsText,
  diagnosticLines,
  diagnosticsKeyFor,
  redactSecrets,
  redactServer,
  serverNames,
} from './ssh-diagnostics';
import { sshExec } from './ssh-exec';
import type { SshHostRecord, SshHostStore } from './ssh-host-store';
import { text } from './ssh-ipc-input';

export interface DiagnosticsHandlerDeps {
  /** The connection id of the sender's window; throws for a window that may not ask. */
  senderRoute(event: IpcMainInvokeEvent): string;
  store(): Promise<SshHostStore>;
  contextFor(record: SshHostRecord): SshRunContext;
  /** Runs `ssh -V` / `ssh -G`. */
  run: RunTool;
  /** The app version shown in the copied text; the Electron version when unset. */
  appVersion?: string;
  /** The tail of the server's daemon.log; reads it over ssh when unset. */
  readServerLog?: (target: SshTarget) => Promise<string>;
}

const electronVersion = async (): Promise<string> => {
  try {
    return (await import('electron')).app.getVersion();
  } catch {
    return 'unknown';
  }
};

const readDaemonLog = async (target: SshTarget): Promise<string> =>
  (
    await sshExec({
      target,
      command: 'tail -n 200 "$HOME/.mixdog-remote/daemon.log" 2>&1 || true',
      timeoutMs: 20_000,
    })
  ).stdout;

/** What `ssh -G` resolves for the address: the config lines worth copying, and the names to redact. */
async function resolvedConfig(run: RunTool, target: SshTarget): Promise<{ config: string[]; extraNames: string[] }> {
  const dump = await run(
    'ssh',
    ['-G', ...(target.port ? ['-p', String(target.port)] : []), '--', target.destination],
    8_000
  ).catch(() => null);
  const host = dump && dump.code === 0 ? parseSshConfigDump(dump.stdout) : null;
  if (!host) return { config: ['(ssh could not resolve this address)'], extraNames: [] };
  return {
    config: [
      `HostName ${host.hostname}`,
      `User ${host.user ?? ''}`,
      `Port ${host.port}`,
      ...(host.proxyJump ? [`ProxyJump ${host.proxyJump}`] : []),
      ...(host.proxyCommand ? ['ProxyCommand (set)'] : []),
    ],
    extraNames: [
      host.hostname,
      host.user ?? '',
      ...(host.proxyJump
        ?.split(',')
        .flatMap((hop) => [hop, hop.slice(hop.lastIndexOf('@') + 1).replace(/:\d+$/, '')]) ?? []),
    ],
  };
}

export function createDiagnosticsHandlers(deps: DiagnosticsHandlerDeps): {
  log(event: IpcMainInvokeEvent, ref: unknown): Promise<DesktopSshLogView>;
  copy(event: IpcMainInvokeEvent, ref: unknown): Promise<string>;
  serverLog(event: IpcMainInvokeEvent, ref: unknown): Promise<DesktopSshServerLog>;
} {
  /** The server a diagnostics call is about: from this PC's own window any saved id or address, from a server window only that window's server. */
  async function diagnosticsTarget(
    event: IpcMainInvokeEvent,
    ref: unknown
  ): Promise<{ record: SshHostRecord | undefined; target: SshTarget }> {
    const route = deps.senderRoute(event);
    const hosts = await deps.store();
    if (route === LOCAL_CONNECTION_ID) {
      const value = text(ref, 'ref');
      const record = hosts.get(value);
      return { record, target: parseSshTarget(record?.target ?? value) };
    }
    const record = hosts.get(route);
    if (!record) throw new Error('This window has no SSH server log.');
    return { record, target: parseSshTarget(record.target) };
  }

  return {
    async log(event, ref) {
      const { target } = await diagnosticsTarget(event, ref);
      const lines = diagnosticLines(diagnosticsKeyFor(target));
      return { lines, copyText: redactServer(lines.join('\n'), serverNames(target, [])) };
    },

    async copy(event, ref) {
      const { target } = await diagnosticsTarget(event, ref);
      const sshVersion = await deps
        .run('ssh', ['-V'], 5_000)
        .then((result) => (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? '')
        .catch(() => '');
      const { config, extraNames } = await resolvedConfig(deps.run, target);
      return buildDiagnosticsText({
        key: diagnosticsKeyFor(target),
        target,
        appVersion: deps.appVersion ?? (await electronVersion()),
        sshVersion,
        config,
        extraNames,
      });
    },

    async serverLog(event, ref) {
      const { record, target } = await diagnosticsTarget(event, ref);
      const key = diagnosticsKeyFor(target);
      try {
        const read = deps.readServerLog ?? readDaemonLog;
        const output = await runWithSshContext(record ? deps.contextFor(record) : { diagnosticsKey: key }, () =>
          read(target)
        );
        const cleaned = redactSecrets(output).trimEnd() || '(daemon.log is empty or does not exist yet)';
        appendDiagnostic(key, 'log', `server log fetched (${cleaned.split('\n').length} lines)`);
        return { ok: true, text: cleaned, copyText: redactServer(cleaned, serverNames(target, [])) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendDiagnostic(key, 'log', `server log failed: ${message}`);
        return { ok: false, message };
      }
    },
  };
}
