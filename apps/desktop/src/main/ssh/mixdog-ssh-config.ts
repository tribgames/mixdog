// Mixdog's own ssh settings file and known_hosts, kept in the app data folder.
// Every ssh Mixdog starts reads `-F <this config>`: it names Mixdog's known_hosts
// first (new pins land there, so the user's own files are never written) and the
// user's known_hosts files after it, then includes the user's ~/.ssh/config for
// everything else. `-F` also reaches a ProxyJump hop's ssh, which `-o` would not.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { lockToUser, resolvePlainDir, type PrivatePlace } from './ssh-private-dir';

type ToolRun = Parameters<typeof lockToUser>[0];

const DEFAULT_USER_FILES = ['~/.ssh/known_hosts', '~/.ssh/known_hosts2'];
const MAX_EXTRA_FILES = 16;

interface State {
  knownHostsFile: string;
  configFile: string;
  home: string;
  extra: Set<string>;
}
let state: State | null = null;

/** Mixdog's own known_hosts, or null before `configureMixdogSsh` ran. */
export const mixdogKnownHostsFile = (): string | null => state?.knownHostsFile ?? null;
/** The generated ssh config every Mixdog ssh reads (`-F`), or null before configuration. */
export const mixdogSshConfigFile = (): string | null => state?.configFile ?? null;

/** A path as ssh config words write it: quoted, forward slashes. */
export const word = (path: string): string => `"${path.replace(/\\/g, '/').replace(/"/g, '')}"`;

/** The config text. Mixdog's file comes first so that `StrictHostKeyChecking=yes`
 *  finds a pin there; ssh reads all the listed files. */
export function mixdogSshConfigText(knownHostsFile: string, extraUserFiles: readonly string[], home: string): string {
  const files = [word(knownHostsFile), ...DEFAULT_USER_FILES, ...extraUserFiles.map(word)];
  return [
    '# Written by Mixdog; rewritten on every start.',
    'Host *',
    `  UserKnownHostsFile ${files.join(' ')}`,
    '',
    `Include ${word(join(home, '.ssh', 'config'))}`,
    '',
  ].join('\n');
}

async function writeConfig(): Promise<void> {
  if (!state) return;
  await writeFile(state.configFile, mixdogSshConfigText(state.knownHostsFile, [...state.extra], state.home), 'utf8');
}

/** Prepares the folder (plain path, this user only), Mixdog's known_hosts and the config. */
export async function configureMixdogSsh(options: {
  userDataPath: string;
  run: ToolRun;
  place?: PrivatePlace & { env?: NodeJS.ProcessEnv };
  home?: string;
}): Promise<void> {
  const platform = options.place?.platform ?? process.platform;
  const dir = await resolvePlainDir(options.run, options.userDataPath, 'ssh', options.place);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') await lockToUser(options.run, dir, options.place?.user);
  else await chmod(dir, 0o700);
  const knownHostsFile = join(dir, 'known_hosts');
  await writeFile(knownHostsFile, '', { flag: 'a', mode: 0o600 });
  state = { knownHostsFile, configFile: join(dir, 'config'), home: options.home ?? homedir(), extra: new Set() };
  await writeConfig();
}

/** The known_hosts files the user's own config names for a server: ssh keeps reading them. */
export async function registerUserKnownHosts(files: readonly string[]): Promise<void> {
  if (!state) return;
  const before = state.extra.size;
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    if (state.extra.size >= MAX_EXTRA_FILES) break;
    const home = state.home.replace(/\\\\/g, '/');
    if (!normalized || normalized === 'none' || DEFAULT_USER_FILES.includes(normalized)) continue;
    if (DEFAULT_USER_FILES.some((file) => normalized === file.replace('~', () => home))) continue;
    if (normalized === state.knownHostsFile.replace(/\\/g, '/')) continue;
    state.extra.add(file);
  }
  if (state.extra.size !== before) await writeConfig();
}

/** The folder that holds Mixdog's generated ssh files, or null before configuration. */
export const mixdogSshDir = (): string | null => (state ? dirname(state.configFile) : null);

/** Test seam. */
export function resetMixdogSsh(): void {
  state = null;
}
