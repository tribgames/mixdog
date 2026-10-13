// Private folders for files ssh reads or runs on behalf of this app (the
// askpass helper, the generated ssh config, the jump-host scan config). They
// belong to this user alone: a random subfolder per use, locked with icacls on
// Windows before anything is written into it, and the shared parent locked too.
// Paths handed to ssh must be plain ASCII without spaces on Windows: ssh starts
// a jump host's own ssh with `-F <config>` as one unquoted word, and cmd.exe
// reads wrapper paths in the console code page.
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, posix, win32 } from 'node:path';

type ToolRun = (
  command: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const TOOL_TIMEOUT_MS = 8_000;
/** Printable ASCII without spaces. */
export const PLAIN_PATH = /^[\x21-\x7e]+$/;

export interface PrivatePlace {
  platform?: NodeJS.Platform;
  /** The Windows account that gets the folder; defaults to the signed-in account. */
  user?: string;
}

/** Restricts the folder to one account (and its children by inheritance). */
export async function lockToUser(run: ToolRun, dir: string, user: string = userInfo().username): Promise<void> {
  const locked = await run('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], TOOL_TIMEOUT_MS);
  if (locked.code !== 0)
    throw new Error(locked.stderr.trim() || locked.stdout.trim() || `Could not restrict ${dir} to this user.`);
}

/** A new random subfolder of `parent`, usable by this user only. On Windows the
 *  parent is locked first and the subfolder is locked before the caller writes
 *  into it. */
export async function createPrivateDir(
  run: ToolRun,
  parent: string,
  prefix: string,
  place: PrivatePlace = {}
): Promise<string> {
  const platform = place.platform ?? process.platform;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (platform === 'win32') await lockToUser(run, parent, place.user);
  const dir = await mkdtemp(join(parent, prefix));
  try {
    if (platform === 'win32') await lockToUser(run, dir, place.user);
    else await chmod(dir, 0o700);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return dir;
}

/** The 8.3 short form of an existing Windows folder, or null when the volume has none. */
export async function shortWindowsPath(run: ToolRun, dir: string): Promise<string | null> {
  const literal = dir.replace(/'/g, "''");
  const result = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${literal}').ShortPath`,
    ],
    TOOL_TIMEOUT_MS
  ).catch(() => null);
  const short = result?.code === 0 ? result.stdout.trim() : '';
  return PLAIN_PATH.test(short) ? short : null;
}

/**
 * A folder for files ssh must be able to name: `<userData>/<name>` when that
 * path is plain, else the same folder under the 8.3 short path of the user-data
 * folder, else a per-user folder under a shared root (ProgramData, Public, the
 * system drive) — which `createPrivateDir` then locks.
 */
export async function resolvePlainDir(
  run: ToolRun,
  userDataPath: string,
  name: string,
  place: PrivatePlace & { env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const platform = place.platform ?? process.platform;
  const env = place.env ?? process.env;
  const join_ = platform === 'win32' ? win32.join : posix.join;
  const preferred = join_(userDataPath, name);
  if (platform !== 'win32' || PLAIN_PATH.test(preferred)) return preferred;
  await mkdir(userDataPath, { recursive: true }).catch(() => undefined);
  const short = await shortWindowsPath(run, userDataPath);
  if (short && PLAIN_PATH.test(join_(short, name))) return join_(short, name);
  const account = (place.user ?? userInfo().username).replace(/[^A-Za-z0-9._-]/g, '_');
  for (const base of [env.ProgramData, env.PUBLIC, env.SystemDrive ? `${env.SystemDrive}\\` : undefined]) {
    if (base && PLAIN_PATH.test(base)) return join_(base, `mixdog-${name}-${account}`);
  }
  return preferred;
}
