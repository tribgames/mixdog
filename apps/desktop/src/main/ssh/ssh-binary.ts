// Finds the OpenSSH tools. On Windows the client is an optional feature whose
// folder is not always on PATH, so System32\OpenSSH is the second place to look.
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export type SshToolName = 'ssh' | 'ssh-keygen' | 'ssh-keyscan' | 'ssh-add';

export const SSH_TOOL_NAMES: readonly string[] = ['ssh', 'ssh-keygen', 'ssh-keyscan', 'ssh-add'];

/** Installs the Windows OpenSSH client (run in an administrator PowerShell). */
export const WINDOWS_SSH_CLIENT_COMMAND = 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0';

/** The spawn error text for a missing client (The OpenSSH client (ssh) was not found on PATH.). */
export const isSshMissingMessage = (text: string): boolean => /OpenSSH client \(\S+\) was not found/i.test(text);

export interface SshBinaryDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile(path: string): boolean;
}

const defaultDeps: SshBinaryDeps = {
  platform: process.platform,
  env: process.env,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

const found = new Map<string, string>();

/** Full path of the tool: PATH first, then (Windows) %SystemRoot%\System32\OpenSSH.
 *  Null when the client is not installed. Paths may hold spaces or non-ASCII
 *  characters; they are only ever passed as one argv entry, never through a shell. */
export function resolveSshTool(name: SshToolName, deps: SshBinaryDeps = defaultDeps): string | null {
  const cached = deps === defaultDeps ? found.get(name) : undefined;
  if (cached && deps.isFile(cached)) return cached;
  const windows = deps.platform === 'win32';
  const file = windows ? `${name}.exe` : name;
  const path = windows ? win32 : posix;
  const directories = (windows ? (deps.env.Path ?? deps.env.PATH ?? '') : (deps.env.PATH ?? '')).split(
    windows ? ';' : ':'
  );
  if (windows)
    directories.push(path.join(deps.env.SystemRoot ?? deps.env.windir ?? 'C:\\Windows', 'System32', 'OpenSSH'));
  for (const directory of directories) {
    const trimmed = directory.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const candidate = path.join(trimmed, file);
    if (deps.isFile(candidate)) {
      if (deps === defaultDeps) found.set(name, candidate);
      return candidate;
    }
  }
  return null;
}

/** What to spawn for a tool: the resolved path, or the bare name so the spawn
 *  failure carries the usual "not found" error the dialog explains. */
export function sshToolCommand(command: string): string {
  return SSH_TOOL_NAMES.includes(command) ? (resolveSshTool(command as SshToolName) ?? command) : command;
}
