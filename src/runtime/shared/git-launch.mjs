// The git executable product code starts, and the environment it starts with.
//
// On Windows `git` on PATH is usually Git for Windows' launcher,
// <root>\cmd\git.exe (or the identical <root>\bin\git.exe). It only prepares
// the environment and starts <root>\<msystem>\bin\git.exe as a second process,
// so every git child costs two process creations. When PATH's git is that
// launcher, children start the real binary directly with the environment the
// launcher would have built. The steps below follow git-wrapper.c
// (git-for-windows/MINGW-packages, mingw-w64-git/git-wrapper.c): main()'s
// `git.exe` branch and setup_environment(top_level_path, full_path=1) plus
// maybe_read_config(). Anything else — another platform, a scoop shim, MinGit,
// a git.exe outside such a layout, an ambiguous or incomplete install — keeps
// plain `git` and the caller's environment, exactly as before.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

// The wrapper's compile-time MSYSTEM, lower-cased, names its binary directory.
const MSYSTEM_DIRECTORIES = ['mingw64', 'clangarm64', 'mingw32'];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Windows names are case-insensitive. Of several spellings in one object
// Node passes the first in sorted order to the child, so that one is read and
// written.
function envKey(env, name) {
  const upper = name.toUpperCase();
  return (
    Object.keys(env)
      .filter((key) => key.toUpperCase() === upper)
      .sort()[0] ?? name
  );
}

function envValue(env, name) {
  const value = env[envKey(env, name)];
  return value === undefined || value === null ? undefined : String(value);
}

// The wrapper's my_path_append: one backslash between the parts.
function appendPath(list, part) {
  return list.endsWith('\\') ? `${list}${part}` : `${list}\\${part}`;
}

// libuv's search for a bare `git` (no directory, no extension): each PATH
// entry in order, `git.com` before `git.exe`.
function launcherOnPath(pathValue) {
  for (const raw of String(pathValue || '').split(delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!entry) continue;
    // A relative entry resolves against each child's cwd; not decidable once.
    if (!isAbsolute(entry)) return null;
    if (isFile(join(entry, 'git.com'))) return null;
    const candidate = join(entry, 'git.exe');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

// etc\git-bash.config `MSYS=` lines, each prepended to MSYS in file order.
function readMsysConfig(root) {
  let text = '';
  try {
    text = readFileSync(join(root, 'etc', 'git-bash.config'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('MSYS='))
    .map((line) => line.slice(5));
}

/**
 * The Git for Windows layout behind PATH's `git`, or null when there is none
 * to bypass. `{ command, root, msystem, msysConfig }`.
 */
export function resolveGitLaunch({ platform = process.platform, pathValue = process.env.PATH } = {}) {
  if (platform !== 'win32') return null;
  const found = launcherOnPath(pathValue);
  if (!found) return null;
  let launcher;
  try {
    // The wrapper locates its install from its own final path.
    launcher = realpathSync.native(found);
  } catch {
    return null;
  }
  if (basename(launcher).toLowerCase() !== 'git.exe') return null;
  const launcherDirectory = dirname(launcher);
  if (!['cmd', 'bin'].includes(basename(launcherDirectory).toLowerCase())) return null;
  const root = dirname(launcherDirectory);
  // The installer and PortableGit ship git-bash.exe; MinGit and other layouts do not.
  if (!isFile(join(root, 'git-bash.exe')) || !isDirectory(join(root, 'usr', 'bin'))) return null;
  const installed = MSYSTEM_DIRECTORIES.filter((name) => isFile(join(root, name, 'bin', 'git.exe')));
  if (installed.length !== 1) return null;
  const [msystemDirectory] = installed;
  return {
    command: join(root, msystemDirectory, 'bin', 'git.exe'),
    root,
    msystem: msystemDirectory.toUpperCase(),
    msysConfig: readMsysConfig(root),
  };
}

function isSystemDirectory(path) {
  const system = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  return path.toLowerCase() === system.toLowerCase();
}

/** `base` as the launcher would hand it to the real git (setup_environment). */
export function gitLaunchEnvironment(launch, base) {
  const env = { ...base };
  const set = (name, value) => {
    env[envKey(env, name)] = value;
  };
  set('MSYSTEM', launch.msystem);
  if (envValue(env, 'PLINK_PROTOCOL') === undefined) set('PLINK_PROTOCOL', 'ssh');
  if (envValue(env, 'HOME') === undefined) {
    const homePath = envValue(env, 'HOMEPATH');
    const drive = `${envValue(env, 'HOMEDRIVE') ?? ''}${homePath ?? ''}`;
    if (homePath !== undefined && !isSystemDirectory(drive) && isDirectory(drive)) set('HOME', drive);
    else if (envValue(env, 'USERPROFILE') !== undefined) set('HOME', envValue(env, 'USERPROFILE'));
  }
  // <root>\<msystem>\bin;<root>\usr\bin;<HOME>\bin; ahead of the inherited PATH.
  const prefix =
    `${appendPath(launch.root, `${launch.msystem.toLowerCase()}\\bin`)};` +
    appendPath(launch.root, 'usr\\bin;') +
    appendPath(envValue(env, 'HOME') ?? '', 'bin;');
  set('PATH', `${prefix}${envValue(env, 'PATH') ?? ''}`);
  for (const msys of launch.msysConfig) {
    const current = envValue(env, 'MSYS');
    set('MSYS', current === undefined ? msys : `${msys} ${current}`);
  }
  return env;
}

// PATH value -> its launch (or null), resolved once per PATH: a child is
// started with the git its own environment's PATH names, as bare `git` is.
const resolved = new Map();
function gitLaunch(env) {
  const pathValue = envValue(env ?? process.env, 'PATH') ?? '';
  if (!resolved.has(pathValue)) resolved.set(pathValue, resolveGitLaunch({ pathValue }));
  return resolved.get(pathValue);
}

/** The program to spawn for git with `env` (null: this process's environment). */
export function gitCommand(env = null) {
  return gitLaunch(env)?.command ?? 'git';
}

/**
 * The environment for a git child: `env` (null: this process's environment)
 * with the launcher's additions when {@link gitCommand} bypasses it. Without a
 * bypass `env` is returned unchanged, null included.
 */
export function gitChildEnv(env = null) {
  const launch = gitLaunch(env);
  return launch ? gitLaunchEnvironment(launch, env ?? process.env) : env;
}

/**
 * Whether a spawn of `command` failed because that resolved binary is gone (an
 * uninstalled or moved Git). Its resolutions are dropped then, so the next
 * {@link gitCommand} resolves PATH afresh. ENOENT alone is not enough: a
 * missing cwd reports it too, with the binary still in place.
 */
export function forgetMissingGit(command, error) {
  if (error?.code !== 'ENOENT' || command === 'git' || isFile(command)) return false;
  for (const [pathValue, launch] of resolved) if (launch?.command === command) resolved.delete(pathValue);
  return true;
}

/**
 * Starts git as `start(command, childEnv)` and, when that spawn failed only
 * because the resolved binary is gone, once more with a fresh resolution —
 * where bare `git` would have found whatever PATH holds now. `start` rejects
 * with the spawn error, or settles an outcome `spawnError` reads it from.
 */
export async function startGit(env, start, spawnError = () => null) {
  const command = gitCommand(env);
  let outcome;
  try {
    outcome = await start(command, gitChildEnv(env));
  } catch (error) {
    if (!forgetMissingGit(command, error)) throw error;
    return start(gitCommand(env), gitChildEnv(env));
  }
  if (!forgetMissingGit(command, spawnError(outcome))) return outcome;
  return start(gitCommand(env), gitChildEnv(env));
}

/** {@link startGit} for a synchronous `start` (spawnSync). */
export function startGitSync(env, start, spawnError = (result) => result?.error) {
  const command = gitCommand(env);
  const outcome = start(command, gitChildEnv(env));
  if (!forgetMissingGit(command, spawnError(outcome))) return outcome;
  return start(gitCommand(env), gitChildEnv(env));
}
