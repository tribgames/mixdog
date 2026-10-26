/**
 * Keeps Mixdog's own GNOME Shell extension (mixdog-windows@mixdog.io) in place
 * while Computer Use is on: it is what lets the native backend list and control
 * windows on GNOME Wayland. The .deb ships it system-wide; every other install
 * gets the bundled copy under ~/.local/share/gnome-shell/extensions. Turning
 * Computer Use off disables it again and leaves the files. Only this uuid is
 * ever touched, nothing prompts, and every step is idempotent.
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path/posix';

export const GNOME_EXTENSION_UUID = 'mixdog-windows@mixdog.io';
const SYSTEM_EXTENSIONS_DIR = '/usr/share/gnome-shell/extensions';

export interface GnomeExtensionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(path: string): boolean;
  readText(path: string): string;
  replaceDir(from: string, to: string): void;
  /** Resolves stdout; rejects when the command fails. */
  run(command: string, args: string[]): Promise<string>;
  log(message: string): void;
}

const realDeps: GnomeExtensionDeps = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  replaceDir(from, to) {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  },
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) =>
        error ? reject(error) : resolve(String(stdout))
      );
    }),
  log: (message) => console.warn(`[gnome-extension] ${message}`),
};

function metadataVersion(deps: GnomeExtensionDeps, dir: string): number | null {
  try {
    const version = JSON.parse(deps.readText(join(dir, 'metadata.json'))).version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

/** The enabled-extensions list as gsettings prints it: `['a', 'b']` or `@as []`. */
function parseExtensionList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

function formatExtensionList(list: string[]): string {
  return `[${list.map((uuid) => `'${uuid}'`).join(', ')}]`;
}

/** Puts the bundled copy in the user's extensions dir unless one is already installed system-wide. */
function installFiles(deps: GnomeExtensionDeps, bundledDir: string): boolean {
  if (deps.exists(join(SYSTEM_EXTENSIONS_DIR, GNOME_EXTENSION_UUID, 'metadata.json'))) return true;
  const data = deps.env.XDG_DATA_HOME || join(deps.home, '.local', 'share');
  const target = join(data, 'gnome-shell', 'extensions', GNOME_EXTENSION_UUID);
  const bundled = metadataVersion(deps, bundledDir);
  if (bundled === null) {
    deps.log(`bundled extension not found at ${bundledDir}`);
    return false;
  }
  if (metadataVersion(deps, target) !== bundled || !deps.exists(join(target, 'extension.js'))) {
    deps.replaceDir(bundledDir, target);
  }
  return true;
}

async function setEnabled(deps: GnomeExtensionDeps, enabled: boolean): Promise<void> {
  const current = parseExtensionList(await deps.run('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions']));
  const present = current.includes(GNOME_EXTENSION_UUID);
  if (present === enabled) return;
  const next = enabled ? [...current, GNOME_EXTENSION_UUID] : current.filter((uuid) => uuid !== GNOME_EXTENSION_UUID);
  await deps.run('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', formatExtensionList(next)]);
}

/** Brings the extension in line with the Computer Use setting; failures are logged, never thrown. */
export async function syncGnomeExtension(
  enabled: boolean,
  bundledDir: string,
  deps: GnomeExtensionDeps = realDeps
): Promise<void> {
  if (deps.platform !== 'linux' || !/gnome/i.test(deps.env.XDG_CURRENT_DESKTOP || '')) return;
  try {
    if (enabled && !installFiles(deps, bundledDir)) return;
    await setEnabled(deps, enabled);
  } catch (error) {
    deps.log(
      `${enabled ? 'setup' : 'disable'} failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`
    );
  }
}

let queue: Promise<void> = Promise.resolve();

/** Serialized, so a quick off/on toggle cannot interleave two syncs. */
export function applyGnomeExtensionSetting(enabled: boolean, bundledDir: string): Promise<void> {
  queue = queue.then(() => syncGnomeExtension(enabled, bundledDir));
  return queue;
}
