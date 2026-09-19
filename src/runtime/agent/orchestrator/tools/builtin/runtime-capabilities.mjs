import { accessSync, constants as fsConstants, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  delimiter as pathDelimiter,
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolveAbsolute,
} from 'node:path';

export const SHELL_RUNTIME_CANDIDATES = Object.freeze([
  'node',
  'python3',
  'python',
  'py',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
  'Rscript',
  'java',
  'go',
  'rustc',
  'dotnet',
  'pwsh',
  'powershell',
  'bash',
]);

function _pathDirectory(value) {
  const text = String(value || '').trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function _executableNames(name, platform) {
  const text = String(name || '').trim();
  if (!text) return [];
  if (platform !== 'win32' || /\.(?:exe|cmd|bat|com)$/i.test(text)) return [text];
  return [text, `${text}.exe`, `${text}.cmd`, `${text}.bat`, `${text}.com`];
}

function findPathExecutable(
  name,
  { pathValue = process.env.PATH || '', platform = process.platform, maxDirectories = 64 } = {}
) {
  const names = _executableNames(name, platform);
  if (!names.length) return null;
  const seenDirectories = new Set();
  for (const rawDirectory of String(pathValue).split(pathDelimiter)) {
    const directory = _pathDirectory(rawDirectory);
    if (!directory) continue;
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (seenDirectories.has(key)) continue;
    seenDirectories.add(key);
    if (seenDirectories.size > maxDirectories) break;
    for (const executable of names) {
      const file = pathJoin(directory, executable);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return `${executable} (${directory.replace(/\\/g, '/')})`;
      } catch {}
    }
  }
  return null;
}

// Startup shell-tool line. An earlier inventory was dropped because it was
// measured in this process's PATH while commands run under the login-shell
// snapshot (shell-snapshot.mjs). This one is measured where commands run: on
// POSIX a login shell (`-lc`, the same profile the snapshot captures) answers
// `command -v`; on Windows there is no snapshot layer and commands inherit
// this process's environment, so a PATH walk is the truth there (minus the
// Store stub in WindowsApps, which resolves but only opens the Store). It is
// a startup observation like the git line, not a permanent rule; a failed or
// slow probe renders nothing rather than a guess. Names are the ones models
// guessed wrong most often in recorded runs (python3/file/python ≈ 70%).
const SHELL_TOOL_STARTUP_NAMES = Object.freeze([
  'python3',
  'python',
  'py',
  'pip3',
  'node',
  'npm',
  'gcc',
  'g++',
  'make',
  'jq',
  'sqlite3',
  'file',
  'curl',
  'xxd',
]);

function _posixStartupShell(candidates = ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

export function describeShellToolsStartupState({
  platform = process.platform,
  names = SHELL_TOOL_STARTUP_NAMES,
  shellPath = null,
  timeoutMs = 1500,
  pathValue = process.env.PATH || '',
  _spawnSync = spawnSync,
} = {}) {
  const wanted = names.map((name) => String(name || '').trim()).filter(Boolean);
  if (!wanted.length) return '';
  let found;
  if (platform === 'win32') {
    found = new Set();
    for (const name of wanted) {
      const hit = findPathExecutable(name, { pathValue, platform });
      if (hit && !/[\\/]WindowsApps(?:[\\/]|\)|$)/i.test(hit)) found.add(name);
    }
  } else {
    const shell = shellPath || _posixStartupShell();
    if (!shell) return '';
    let result;
    try {
      result = _spawnSync(shell, ['-lc', `command -v ${wanted.join(' ')}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathValue },
        maxBuffer: 64 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch {
      return '';
    }
    // `command -v a b c` exits non-zero when any name is missing; only a
    // spawn failure or timeout means the answer is unknown.
    if (!result || result.error) return '';
    found = new Set();
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const base = line.trim().split('/').pop();
      if (base && wanted.includes(base)) found.add(base);
    }
  }
  const present = wanted.filter((name) => found.has(name));
  const absent = wanted.filter((name) => !found.has(name));
  return `- Shell tools at startup: ${present.length ? present.join(' ') : '(none)'}; absent: ${absent.length ? absent.join(' ') : '(none)'}.`;
}

// Walk up for a `.git` marker instead of shelling out to `git rev-parse`: it
// costs no process spawn, and it still answers on images where the git binary
// is absent. `.git` is a directory in a normal clone and a file in a worktree
// or submodule, so both count as "inside a repository".
function findRepositoryRoot(startDirectory, { maxDepth = 64 } = {}) {
  let current;
  try {
    current = pathResolveAbsolute(String(startDirectory || '.'));
  } catch {
    return null;
  }
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const marker = pathJoin(current, '.git');
    try {
      const stats = statSync(marker);
      return { root: current, gitDirectory: stats.isDirectory() ? marker : null };
    } catch {}
    const parent = pathDirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function _headBranch(gitDirectory) {
  if (!gitDirectory) return null;
  try {
    const head = readFileSync(pathJoin(gitDirectory, 'HEAD'), 'utf8').trim();
    // Detached HEAD holds a raw object id and names no branch.
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

function _repositoryChangeState(root) {
  try {
    const result = spawnSync(
      'git',
      ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 64 * 1024,
        timeout: 1500,
        windowsHide: true,
      }
    );
    const output = String(result.stdout || '').trim();
    if (result.status === 0) return output ? 'changes present' : 'clean';
    if (result.error?.code === 'ENOBUFS' && output) return 'changes present';
  } catch {}
  return null;
}

// Startup snapshot, same contract as the shell line above: it states what was
// true when the session opened, not a permanent rule. `git init` or a move to
// another directory changes it, which is why this reports the observation
// rather than forbidding calls.
export function describeGitStartupState({ cwd = process.cwd(), ...pathOptions } = {}) {
  const installed = Boolean(findPathExecutable('git', pathOptions));
  if (!installed) {
    return '- Git startup state: git is not installed here; git tool calls fail until something installs it.';
  }
  const found = findRepositoryRoot(cwd);
  if (!found) {
    return `- Git startup state: ${cwd} was not inside a git repository at startup; git commands that require one fail until a repository exists.`;
  }
  const branch = _headBranch(found.gitDirectory);
  const changeState = _repositoryChangeState(found.root);
  return `- Git startup state: repository root ${found.root}${branch ? ` on branch ${branch}` : ' with a detached HEAD'}${changeState ? `; ${changeState}` : ''}.`;
}

// The cwd's immediate entries are the same kind of fact as the git line: a
// property of this directory, true at startup. Without it the first call of a
// session is routinely `list .` or `glob *` (11/11 trials on orientation-heavy
// tasks), one full model round-trip spent on a listing the prompt could have
// carried. Capped so a large root does not swell the prompt; the cap is
// reported so the caller knows to list for more.
//
// The line only pays for itself when it actually replaces that listing, so it
// carries what the listing would have taught: gitignored entries are dropped
// (the project's own `.gitignore` decides, no name-based guessing), `.git`
// itself is repository metadata rather than content, and directories sort
// ahead of files so the cap trims loose files before the tree's shape.
const CWD_STARTUP_ENTRY_LIMIT = 40;

function _gitIgnoredEntries(directory, names) {
  if (!names.length || !findRepositoryRoot(directory)) return new Set();
  try {
    const result = spawnSync('git', ['--no-optional-locks', '-C', directory, 'check-ignore', '--stdin', '-z'], {
      encoding: 'utf8',
      input: `${names.join('\0')}\0`,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 1024 * 1024,
      timeout: 1500,
      windowsHide: true,
    });
    // Exit 1 is "nothing ignored", not a failure.
    if (result.status !== 0 && result.status !== 1) return new Set();
    return new Set(
      String(result.stdout || '')
        .split('\0')
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

export function describeCwdStartupEntries({ cwd = process.cwd(), limit = CWD_STARTUP_ENTRY_LIMIT } = {}) {
  let directory;
  let entries;
  try {
    directory = pathResolveAbsolute(String(cwd || '.'));
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return '';
  }
  if (!entries.length) return '- Cwd entries at startup: none (empty directory).';
  const candidates = entries.filter((entry) => entry.name !== '.git');
  const ignored = _gitIgnoredEntries(
    directory,
    candidates.map((entry) => entry.name)
  );
  const kept = candidates.filter((entry) => !ignored.has(entry.name));
  if (!kept.length) return '- Cwd entries at startup: none besides gitignored entries.';
  const names = kept
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'))
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  const shown = names.slice(0, limit);
  const omitted = names.length - shown.length;
  return `- Cwd entries at startup: ${shown.join(' ')}${omitted > 0 ? ` … +${omitted} more (list for the rest)` : ''}`;
}

export function appendGitStartupState(rules, tools, options = {}) {
  const text = String(rules || '').trimEnd();
  if (!text || !Array.isArray(tools) || !tools.some((tool) => tool?.name === 'git')) return text;
  return `${text}\n${describeGitStartupState(options)}`;
}
