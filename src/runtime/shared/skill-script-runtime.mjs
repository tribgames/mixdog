// The interpreter a built-in skill's bundled scripts run on.
//
// `${MIXDOG_SKILL_DIR}` is a real directory every process can read, but the
// pptx scripts import the runtime by relative path (../../../../runtime/...)
// and its native dependencies (sharp, @napi-rs/canvas, pdf.js). A packaged
// desktop keeps those only inside runtime.asar, which plain Node cannot open,
// so `node "<dir>/scripts/x.mjs"` works from an npm install and fails there.
//
// So the daemon that runs the model's shells hands them its OWN runtime: a
// per-installation directory, first on every model shell's PATH, holds
// `mixdog-skill-node` launchers that run this process's executable (Electron
// in node mode, or node) on src/skill-script-entry.mjs, which maps the script
// back into the archive before importing it. Each daemon builds its own shell
// env, so an SSH-remote or mobile session gets its execution host's runtime.
// Launchers carry two paths and nothing else: no credentials, no daemon
// identity.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomicSync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

/** This module's package root (src/runtime/shared → the package). */
export const SKILL_SCRIPT_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The `…/runtime.asar` prefix of a location inside the runtime archive, or null. */
export function archiveRootOf(location, platform = process.platform) {
  const sep = platform === 'win32' ? '[\\\\/]' : '/';
  const match = new RegExp(`^(.*?${sep}runtime\\.asar)(?=${sep}|$)`).exec(String(location || ''));
  return match ? pathApi(platform).normalize(match[1]) : null;
}

/**
 * The path a script must be imported from. A built-in skill's directory is
 * handed out under `runtime.asar.unpacked` (skillExecutionDir), but its
 * relative imports only resolve from the archive, so a script under the
 * sidecar of the archive that holds this package maps back into it. Source
 * trees and npm installs keep the real path (symlinks resolved, as the ESM
 * loader resolves them for import.meta.url).
 */
export function canonicalSkillScriptPath(
  target,
  {
    packageRoot = SKILL_SCRIPT_PACKAGE_ROOT,
    platform = process.platform,
    cwd = process.cwd(),
    realpath = realpathSync,
  } = {}
) {
  const api = pathApi(platform);
  let location = api.resolve(cwd, String(target));
  try {
    location = realpath(location);
  } catch {
    // A missing script fails at import with its own path in the message.
  }
  const archive = archiveRootOf(packageRoot, platform);
  if (!archive) return location;
  const sidecar = `${archive}.unpacked${api.sep}`;
  const fold = (value) => (platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value);
  if (!fold(location).startsWith(fold(sidecar))) return location;
  return `${archive}${api.sep}${location.slice(sidecar.length)}`;
}

/** The runtime this process would hand a skill script to. */
export function skillScriptRuntime({
  execPath = process.execPath,
  versions = process.versions,
  packageRoot = SKILL_SCRIPT_PACKAGE_ROOT,
  platform = process.platform,
} = {}) {
  return {
    platform,
    interpreter: execPath,
    // Electron's own version marker, not ELECTRON_RUN_AS_NODE: model shells
    // scrub that variable, and a daemon may have inherited it without being
    // Electron at all.
    electron: Boolean(versions?.electron),
    packageRoot,
    entry: pathApi(platform).join(packageRoot, 'src', 'skill-script-entry.mjs'),
  };
}

function batchQuote(value) {
  return `"${String(value).replaceAll('%', '%%')}"`;
}

function posixQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * The command `${MIXDOG_SKILL_NODE}` renders to. It is the same word in every
 * shell: model shells find it on PATH (withSkillLauncherPath), as the
 * extensionless sh launcher (bash, sh, zsh, Git Bash) or as the .cmd beside
 * it (cmd through PATHEXT on Windows). PowerShell model commands define a
 * function of the same name first (renderPowerShellSkillFunction), which
 * takes precedence over both.
 */
export const SKILL_LAUNCHER_COMMAND = 'mixdog-skill-node';

/**
 * sh launcher text. Electron node mode is set only inside the launcher, for
 * the one child it execs; every argument and the exit code pass through.
 */
export function renderPosixSkillLauncher({ interpreter, entry, electron }) {
  return `${[
    '#!/bin/sh',
    '# Mixdog skill-script launcher, generated for one installation. Do not edit.',
    ...(electron ? ['ELECTRON_RUN_AS_NODE=1', 'export ELECTRON_RUN_AS_NODE'] : []),
    `exec ${posixQuote(interpreter)} ${posixQuote(entry)} "$@"`,
  ].join('\n')}\n`;
}

/** .cmd launcher text, same contract as the sh launcher. */
export function renderWindowsSkillLauncher({ interpreter, entry, electron }) {
  // cmd decodes a batch file in the console code page line by line, so a
  // non-ASCII path needs UTF-8 for the lines after chcp; the caller's code
  // page is restored before exit.
  const unicode = /\P{ASCII}/u.test(`${interpreter}${entry}`);
  return `${[
    '@echo off',
    'rem Mixdog skill-script launcher, generated for one installation. Do not edit.',
    'setlocal EnableExtensions DisableDelayedExpansion',
    ...(unicode
      ? ['for /f "tokens=2 delims=:." %%C in (\'chcp\') do set "MIXDOG_SKILL_CP=%%C"', 'chcp 65001 >nul']
      : []),
    ...(electron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
    `${batchQuote(interpreter)} ${batchQuote(entry)} %*`,
    'set "MIXDOG_SKILL_EXIT=%ERRORLEVEL%"',
    ...(unicode ? ['if defined MIXDOG_SKILL_CP chcp %MIXDOG_SKILL_CP% >nul'] : []),
    'exit /b %MIXDOG_SKILL_EXIT%',
  ].join('\r\n')}\r\n`;
}

/** Environment variable carrying a PowerShell caller's arguments to the entry. */
export const SKILL_ARGV_ENV = 'MIXDOG_SKILL_ARGV';
const SKILL_ARGV_TAG = 'mixdog1';

function psQuote(value) {
  // PowerShell also treats the typographic single quotes as quote characters.
  return `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * One-line PowerShell definition of `mixdog-skill-node`, prepended to every
 * PowerShell model command. Through PATH, PowerShell would reach the .cmd via
 * `cmd.exe /c` with arguments it does not quote, so `'a&b'` ran `b`. The
 * function runs this daemon's executable on the entry as a plain native
 * command, so PowerShell's own native-command handling provides streaming,
 * ordering, backpressure, line endings, `2>&1`/`2>$null`/`2>file`,
 * `$LASTEXITCODE`, Ctrl-C and early stop. The caller's arguments never reach
 * that command line: they travel in SKILL_ARGV_ENV (UTF-8 base64), because
 * Windows PowerShell 5.1 drops empty native arguments and does not escape
 * embedded double quotes. A failing script ends the command with its exit
 * code (`exit`), because a PowerShell function cannot fail `$?` or the
 * -Command exit code.
 *
 * SKILL_ARGV_ENV and (Electron daemons only) ELECTRON_RUN_AS_NODE are set on
 * $env just for the call and restored in `finally`; the bootstrap deletes
 * both before importing the script. Accepted tradeoff: while the call runs,
 * a process a concurrent downstream pipeline stage starts can see them.
 */
export function renderPowerShellSkillFunction({ interpreter, entry, electron }) {
  const names = [SKILL_ARGV_ENV, ...(electron ? ['ELECTRON_RUN_AS_NODE'] : [])];
  const values = ['$__mxa', ...(electron ? ["'1'"] : [])];
  const body = [
    `$__mxa = '${SKILL_ARGV_TAG}'`,
    "foreach ($__mxv in $args) { foreach ($__mxe in @($__mxv)) { if ($null -ne $__mxe) { $__mxa += ',' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__mxe)) } } }",
    names.map((name, i) => `$__mxo${i} = $env:${name}`).join('; '),
    [
      'try {',
      ...names.map((name, i) => `$env:${name} = ${values[i]};`),
      `& ${psQuote(interpreter)} ${psQuote(entry)}`,
      '} finally {',
      names.map((name, i) => `$env:${name} = $__mxo${i}`).join('; '),
      '}',
    ].join(' '),
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
  ];
  return `function ${SKILL_LAUNCHER_COMMAND} { ${body.join('; ')} }`;
}

/** The arguments a PowerShell caller sent through SKILL_ARGV_ENV, or null. */
export function decodeSkillArgv(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.startsWith(SKILL_ARGV_TAG)) return null;
  const rest = text.slice(SKILL_ARGV_TAG.length);
  if (!rest) return [];
  return rest
    .slice(1)
    .split(',')
    .map((item) => Buffer.from(item, 'base64').toString('utf8'));
}

/** Launcher files of `runtime`: the sh script everywhere, plus the .cmd on Windows. */
export function skillLauncherFiles(runtime) {
  return [
    { name: SKILL_LAUNCHER_COMMAND, content: renderPosixSkillLauncher(runtime) },
    ...(runtime.platform === 'win32'
      ? [{ name: `${SKILL_LAUNCHER_COMMAND}.cmd`, content: renderWindowsSkillLauncher(runtime) }]
      : []),
  ];
}

/** Private per-installation launcher directory under the data dir. */
export function skillLauncherDir(runtime, dataDir = resolvePluginData()) {
  const digest = createHash('sha256')
    .update(JSON.stringify([runtime.platform, runtime.interpreter, runtime.entry, runtime.electron]))
    .digest('hex')
    .slice(0, 16);
  return pathApi(runtime.platform).join(dataDir, 'skill-launchers', digest);
}

const ensuredDirs = new Set();

/**
 * Write (atomically) or refresh the launchers for `runtime`; returns their
 * directory. A directory already verified by this process is only checked for
 * presence, so the per-command shell env build stays a couple of stats.
 */
export function ensureSkillLauncherDir(runtime = skillScriptRuntime(), dataDir = resolvePluginData()) {
  const dir = skillLauncherDir(runtime, dataDir);
  const api = pathApi(runtime.platform);
  const files = skillLauncherFiles(runtime);
  if (ensuredDirs.has(dir) && files.every(({ name }) => existsSync(api.join(dir, name)))) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const { name, content } of files) {
    const file = api.join(dir, name);
    let current = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // Not written yet.
    }
    if (current !== content) writeFileAtomicSync(file, content, { mode: 0o700 });
  }
  ensuredDirs.add(dir);
  return dir;
}

/**
 * `env` with this installation's launcher directory first on PATH. Only model
 * shell environments call this; the daemon's own env, hooks and internal
 * workers keep their PATH. The directory holds nothing but the launchers, so
 * no existing command is shadowed.
 */
export function withSkillLauncherPath(env, { runtime = skillScriptRuntime(), dataDir = resolvePluginData() } = {}) {
  const dir = ensureSkillLauncherDir(runtime, dataDir);
  const delimiter = runtime.platform === 'win32' ? ';' : ':';
  // Windows env keys are case-insensitive and usually spelled `Path`.
  const key =
    (runtime.platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : null) || 'PATH';
  const entries = String(env[key] || '')
    .split(delimiter)
    .filter((entry) => entry && entry !== dir);
  env[key] = [dir, ...entries].join(delimiter);
  return env;
}
