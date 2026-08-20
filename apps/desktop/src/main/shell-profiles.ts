// Terminal shell detection: enumerate EVERY shell installed on this machine
// (user: 있는 거 다 선택하게, 간단하게) and hand the renderer a plain list.
// The renderer only ever names a profile ID; resolveShellProfileSpawn maps it
// back to a spawnable path/args/env, so an arbitrary executable can never be
// requested over IPC. Detection follows the conventional profile rules
// in miniature: existence-checked well-known paths, git.exe-derived Git Bash,
// and `wsl.exe -l -q` for distributions.
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { childEnvironment } from './child-environment';
import type { TerminalSpawnProfile } from './terminal-contract';

export interface DesktopShellProfileInfo {
  id: string;
  label: string;
  path: string;
  /** OS-default shell — what an empty selection spawns. */
  default?: boolean;
}

interface DetectedShellProfile extends DesktopShellProfileInfo {
  args?: string[];
  env?: Record<string, string>;
}

let detection: Promise<DetectedShellProfile[]> | null = null;

function existingFile(candidate: string): string {
  if (!candidate) return '';
  try {
    return fs.statSync(candidate).isFile() ? candidate : '';
  } catch {
    return '';
  }
}

function findOnPath(binary: string): string {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = existingFile(path.join(dir, binary));
    if (candidate) return candidate;
  }
  return '';
}

/** `wsl.exe -l -q`: one distribution per line, emitted as UTF-16LE. */
function wslDistributions(wslPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    exec(`"${wslPath}" -l -q`, {
      encoding: 'utf16le',
      timeout: 3_000,
      windowsHide: true,
      env: childEnvironment(),
    },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.replace(/\u0000/g, '').trim())
          .filter(Boolean));
      });
  });
}

async function detectWindowsProfiles(): Promise<DetectedShellProfile[]> {
  const profiles: DetectedShellProfile[] = [];
  const windir = process.env.windir || process.env.SystemRoot || 'C:\\Windows';
  const system32 = path.join(windir, 'System32');
  const pwsh = findOnPath('pwsh.exe')
    || existingFile(path.join(process.env.ProgramFiles || 'C:\\Program Files',
      'PowerShell', '7', 'pwsh.exe'));
  // Label PS7 and PS5.1 unmistakably apart (user: pwsh랑 파워셀 구분).
  if (pwsh) profiles.push({ id: 'pwsh', label: 'PowerShell (pwsh)', path: pwsh });
  const windowsPowerShell = existingFile(
    path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  if (windowsPowerShell) {
    profiles.push({ id: 'windows-powershell', label: 'Windows PowerShell', path: windowsPowerShell });
  }
  const cmd = existingFile(path.join(system32, 'cmd.exe'));
  if (cmd) profiles.push({ id: 'cmd', label: 'Command Prompt', path: cmd });
  // Git Bash: `<install>/cmd/git.exe` implies `<install>/bin/bash.exe`
  // plus the conventional install roots as fallbacks.
  const gitDirs = new Set<string>();
  const gitExe = findOnPath('git.exe');
  if (gitExe) gitDirs.add(path.resolve(path.dirname(gitExe), '..', '..'));
  for (const root of [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Programs') : '',
  ]) {
    if (root) gitDirs.add(root);
  }
  let gitBash = '';
  for (const dir of gitDirs) {
    gitBash = existingFile(path.join(dir, 'Git', 'bin', 'bash.exe'))
      || existingFile(path.join(dir, 'Git', 'usr', 'bin', 'bash.exe'))
      || existingFile(path.join(dir, 'usr', 'bin', 'bash.exe'));
    if (gitBash) break;
  }
  if (gitBash) {
    profiles.push({ id: 'git-bash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'] });
  }
  const homeDrive = `${process.env.HOMEDRIVE || 'C:'}\\`;
  const msys = existingFile(path.join(homeDrive, 'msys64', 'usr', 'bin', 'bash.exe'));
  if (msys) {
    // CHERE_INVOKING keeps the requested cwd instead of MSYS2's home.
    profiles.push({
      id: 'msys2', label: 'bash (MSYS2)', path: msys,
      args: ['--login', '-i'], env: { CHERE_INVOKING: '1' },
    });
  }
  const cygwin = existingFile(path.join(homeDrive, 'cygwin64', 'bin', 'bash.exe'))
    || existingFile(path.join(homeDrive, 'cygwin', 'bin', 'bash.exe'));
  if (cygwin) profiles.push({ id: 'cygwin', label: 'Cygwin', path: cygwin, args: ['--login'] });
  const wsl = existingFile(path.join(system32, 'wsl.exe'));
  if (wsl) {
    for (const distro of await wslDistributions(wsl)) {
      if (hiddenWslDistribution(distro)) continue;
      profiles.push({
        id: `wsl-${distro.toLowerCase()}`,
        label: `${distro} (WSL)`,
        path: wsl,
        args: ['-d', distro],
      });
    }
  }
  return profiles;
}

/** Utility-VM distributions are not user shells. */
export function hiddenWslDistribution(name: string): boolean {
  return /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine.*)$/i
    .test(String(name || '').trim());
}

/** OS-default profile id: Windows prefers PowerShell 7
 *  (pwsh) over Windows PowerShell over cmd; elsewhere $SHELL wins. */
export function defaultShellProfileId(
  profiles: readonly Pick<DesktopShellProfileInfo, 'id' | 'path'>[],
  platform: NodeJS.Platform = process.platform,
  envShell: string = process.env.SHELL || '',
): string {
  if (!profiles.length) return '';
  if (platform === 'win32') {
    for (const id of ['pwsh', 'windows-powershell', 'cmd']) {
      if (profiles.some((profile) => profile.id === id)) return id;
    }
    return profiles[0].id;
  }
  return profiles.find((profile) => profile.path === envShell)?.id || profiles[0].id;
}

function detectUnixProfiles(): DetectedShellProfile[] {
  const seen = new Set<string>();
  const profiles: DetectedShellProfile[] = [];
  const push = (candidate: string) => {
    const resolved = existingFile(candidate);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    const name = path.basename(resolved);
    // Two installs of the same shell (e.g. /bin/zsh + /usr/local/bin/zsh)
    // keep distinct ids by falling back to the full path.
    const id = profiles.some((profile) => profile.id === name) ? resolved : name;
    profiles.push({ id, label: name, path: resolved });
  };
  push(process.env.SHELL || '');
  try {
    for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n')) {
      const candidate = line.trim();
      if (candidate && !candidate.startsWith('#')) push(candidate);
    }
  } catch { /* the conventional fallbacks below stand in */ }
  for (const candidate of ['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh']) push(candidate);
  return profiles;
}

function detect(): Promise<DetectedShellProfile[]> {
  detection ??= (process.platform === 'win32'
    ? detectWindowsProfiles()
    : Promise.resolve(detectUnixProfiles())
  ).catch(() => []);
  return detection;
}

/** Every shell found on this machine, for the terminal strip's picker. */
export async function listShellProfiles(): Promise<DesktopShellProfileInfo[]> {
  const detected = await detect();
  const defaultId = defaultShellProfileId(detected);
  return detected.map(({ id, label, path: shellPath }) => ({
    id,
    label,
    path: shellPath,
    ...(id === defaultId ? { default: true } : {}),
  }));
}

/** Resolve a renderer-chosen profile id to its spawn spec. Empty or unknown
 *  ids resolve to the detected OS default (pwsh-first on Windows); null only
 *  when nothing was detected — the worker's hardcoded last resort. */
export async function resolveShellProfileSpawn(id: unknown): Promise<TerminalSpawnProfile | null> {
  const wanted = typeof id === 'string' ? id.trim() : '';
  const detected = await detect();
  const profile = (wanted ? detected.find((candidate) => candidate.id === wanted) : undefined)
    ?? detected.find((candidate) => candidate.id === defaultShellProfileId(detected));
  if (!profile) return null;
  return {
    path: profile.path,
    ...(profile.args ? { args: profile.args } : {}),
    ...(profile.env ? { env: profile.env } : {}),
  };
}
