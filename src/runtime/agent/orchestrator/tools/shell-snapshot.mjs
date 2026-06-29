'use strict';
// Shell environment snapshot.
//
// Captures the user's interactive shell state (functions, aliases, shell
// options) by sourcing their config file in a one-shot login shell and
// dumping the resulting environment to a temp script. Subsequent bash
// commands prepend `source <snapshot>` so they run with the same nvm /
// pyenv / mise / asdf / direnv setup the user gets in their interactive
// terminal — without paying a fresh login-shell startup on every call.
//
// Mirrors upstream shell snapshot pattern (reference ShellSnapshot.ts:413,
// createAndSaveSnapshot). Simpler scope: bash and zsh only, no embedded
// search-tool injection (mixdog ships its own grep/glob helpers).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { readdir as readdirAsync, stat as statAsync, unlink as unlinkAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getPluginData } from '../config.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from './env-scrub.mjs';

const SNAPSHOT_TIMEOUT_MS = 10_000;

// One snapshot per shellPath. Re-snapshot when the cached file is gone;
// otherwise the cached path is reused for the process lifetime so we
// don't pay the login-shell cost per call.
const _cache = new Map();

// Negative cache. When snapshot generation fails (timeout, syntax error,
// missing dump utilities) we mark the shell path so subsequent calls
// fall through immediately instead of paying another 10 s timeout per
// command. Cleared on process exit (process-scoped Set).
const _failedShells = new Set();

// Mirrors reference cleanupRegistry pattern (utils/
// cleanupRegistry.ts + ShellSnapshot.ts:534-545). Snapshot files are
// session-scoped and must be unlinked on graceful shutdown — otherwise
// they pile up forever (each rc-file mtime change creates a new file).
const _activeSnapshots = new Set();
let _cleanupRegistered = false;

export function drainShellSnapshots() {
  for (const p of _activeSnapshots) {
    try { unlinkSync(p); } catch {}
  }
  _activeSnapshots.clear();
}

// Stale-snapshot sweep on module init. _activeSnapshots tracks files this
// process created; snapshots written by prior mcp child instances (before
// supervisor restart) sit on disk with no in-memory handle and the bare
// 'exit' hook can't reach them. Invariant: any snapshot-*.sh older than
// SNAPSHOT_STALE_MS in shell-snapshots/ belongs to a dead instance. The
// live process keeps its own files because _cache hits skip generation
// and the kept files get touched on reuse.
const SNAPSHOT_STALE_MS = 60 * 60 * 1000;
async function _sweepStaleSnapshots() {
  const dir = join(getPluginData(), 'shell-snapshots');
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - SNAPSHOT_STALE_MS;
  let names;
  try { names = await readdirAsync(dir); } catch { return; }
  await Promise.all(names.map(async (name) => {
    if (!name.startsWith('snapshot-') || !name.endsWith('.sh')) return;
    const p = join(dir, name);
    try {
      const st = await statAsync(p);
      if (st.mtimeMs < cutoff) await unlinkAsync(p);
    } catch {}
  }));
}
// Fire-and-forget. Async dirent iteration keeps the main event loop free
// while the sweep runs; errors swallowed per-file so a single stat/unlink
// failure does not abort the rest of the batch.
_sweepStaleSnapshots();

function _registerSnapshotCleanup(snapshotPath) {
  _activeSnapshots.add(snapshotPath);
  if (_cleanupRegistered) return;
  _cleanupRegistered = true;
  // Self-registered exit drain; bare 'exit' hook stays as idempotent backup.
  process.once('exit', drainShellSnapshots);
}

function getConfigFile(shellPath) {
  const lower = shellPath.toLowerCase();
  if (lower.includes('zsh')) return join(homedir(), '.zshrc');
  if (lower.includes('bash')) return join(homedir(), '.bashrc');
  return join(homedir(), '.profile');
}

// User-state capture script. Functions + aliases + shell options. Writes
// to $SNAPSHOT_FILE so the parent process can reuse it via `source`.
//
// Filtering: completion functions (single-underscore prefix) are dropped
// since they bloat the snapshot without affecting interactive behaviour.
// Double-underscore helpers (__pyenv_init etc) are kept.
function _shellQuote(s) {
  // POSIX single-quote escape: close, escaped quote, reopen.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function getSnapshotScript(shellPath, snapshotFilePath, configFileExists) {
  const isZsh = shellPath.toLowerCase().includes('zsh');
  const sourceCfg = configFileExists
    ? `source ${_shellQuote(getConfigFile(shellPath))} < /dev/null 2>/dev/null || true`
    : '# no user config file';
  const fnDump = isZsh
    ? `
      typeset -f > /dev/null 2>&1
      typeset +f 2>/dev/null | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
      done
    `
    : `
      declare -f > /dev/null 2>&1
      declare -F 2>/dev/null | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
        declare -f "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
      done
    `;
  const optDump = isZsh
    ? `setopt 2>/dev/null | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"`
    : `
      shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"
      set -o 2>/dev/null | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
    `;
  const aliasDump = `
      alias 2>/dev/null | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
  `;
  return `SNAPSHOT_FILE=${_shellQuote(snapshotFilePath)}
${sourceCfg}
echo "# Snapshot" >| "$SNAPSHOT_FILE"
echo "# Unset all aliases first to avoid frozen-alias issues inside functions" >> "$SNAPSHOT_FILE"
echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"
echo "# Functions" >> "$SNAPSHOT_FILE"
${fnDump}
echo "# Shell options" >> "$SNAPSHOT_FILE"
${optDump}
echo "# Aliases" >> "$SNAPSHOT_FILE"
${aliasDump}
# PATH may contain $, backticks, or quotes that would re-expand if we
# emitted it inside double quotes. Emit a shell-safe single-quoted PATH
# export line via printf %q-style escaping inside the dump shell.
printf 'export PATH=' >> "$SNAPSHOT_FILE"
_q=$(printf %s "$PATH" | sed "s/'/'\\\\''/g")
printf "'%s'\n" "$_q" >> "$SNAPSHOT_FILE"
exit 0
`;
}

function _runSnapshot(shellPath, snapshotPath, configFileExists) {
  return new Promise((resolve) => {
    const script = getSnapshotScript(shellPath, snapshotPath, configFileExists);
    let stderrBuf = '';
    // Mirror reference implementation (bash/ShellSnapshot.ts:458):
    // `-c -l` (login non-interactive). Earlier `-ic` (interactive command)
    // forced bash-completion to load — Git's completion loader spawns `find`
    // in subshells (__git_find_on_cmdline etc.) which detach on Windows when
    // the parent gets SIGTERM at timeout, leaking find.exe processes. Login
    // mode runs .bash_profile / .profile (which typically sources .bashrc)
    // without triggering completion init. The script also explicitly sources
    // the rc file, so the interactive-guard `[[ $- == *i* ]] && return` is
    // accepted as a known tradeoff (matches the reference choice).
    const child = spawn(shellPath, ['-c', '-l', script], {
      // P3 fix: blank prompts so an interactive sourcing in -ic does not
      // print PS1 / PS2 / RPROMPT / PROMPT noise to stderr (which our
      // failure log truncates to 200 chars and tags as "snapshot failed"
      // even when the snapshot itself is fine).
      // R11: scrub loader/execution vars from process.env before
      // handing it to the snapshot shell. This site previously passed
      // raw process.env, bypassing even the R5 secret scrub — the
      // snapshot child sources the user's rc file, so NODE_OPTIONS /
      // LD_PRELOAD / BASH_ENV here would inject into every subsequent
      // bash command that uses this snapshot.
      env: (() => {
        const e = scrubLoaderVars({
          ...process.env,
          SHELL: shellPath,
          GIT_EDITOR: 'true',
          CLAUDECODE: '1',
          PS1: '',
          PS2: '',
          PS3: '',
          PS4: '',
          PROMPT: '',
          RPROMPT: '',
        });
        // R5 secret scrub — the rc-sourcing snapshot child runs user code
        // (.bashrc / .zshrc) which can exfil any inherited env. Strip
        // provider/cloud tokens before exposing the env to that script.
        // Shared with bash-session and shell-jobs via env-scrub.mjs.
        scrubProviderSecrets(e);
        return e;
      })(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (s) => {
      stderrBuf += s;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, SNAPSHOT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(snapshotPath)) {
        // P3 fix: payload-aware sentinel. Header bytes alone (~80) plus
        // PATH export and `unalias -a` boilerplate can exceed 200 even
        // when no user state was captured. Require at least one of:
        // alias declaration, function definition, or shell-option line.
        let snapContent = '';
        try { snapContent = readFileSync(snapshotPath, 'utf-8'); } catch {}
        const _hasAlias = /^\s*alias\s+--\s/m.test(snapContent);
        const _hasFn = /^\s*[A-Za-z_][\w-]*\s*\(\s*\)\s*\{/m.test(snapContent)
          || /^\s*function\s+[A-Za-z_]/m.test(snapContent);
        const _hasOpt = /^\s*setopt\b/m.test(snapContent)
          || /^\s*shopt\s+-s/m.test(snapContent)
          || /^\s*set\s+-o\s/m.test(snapContent);
        if (!_hasAlias && !_hasFn && !_hasOpt) {
          try {
            process.stderr.write(
              `[shell-snapshot] empty snapshot rejected (no aliases / functions / options captured, size=${snapContent.length})\n`,
            );
          } catch {}
          try { unlinkSync(snapshotPath); } catch {}
          resolve(null);
          return;
        }
        _registerSnapshotCleanup(snapshotPath);
        resolve(snapshotPath);
      } else {
        try {
          process.stderr.write(
            `[shell-snapshot] failed exit=${code} stderr=${(stderrBuf || '').slice(0, 200)}\n`,
          );
        } catch {}
        // Failure branch may have left a partially-written file behind.
        try { unlinkSync(snapshotPath); } catch {}
        resolve(null);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// Returns the snapshot file path for the given shell, generating one on
// first call. Returns null if generation failed (caller falls through to
// running the command without snapshot prelude).
async function getOrCreateSnapshot(shellPath) {
  // Cache key includes rc-file mtime/size so editing .bashrc/.zshrc
  // mid-session forces a fresh snapshot on the next call instead of
  // reusing the stale one for the rest of the process lifetime.
  const configFile = getConfigFile(shellPath);
  const configExists = existsSync(configFile);
  let _rcMtime = 0;
  let _rcSize = 0;
  if (configExists) {
    try {
      const _st = statSync(configFile);
      _rcMtime = _st.mtimeMs;
      _rcSize = _st.size;
    } catch {}
  }
  const cacheKey = `${shellPath}|${_rcMtime}|${_rcSize}`;
  if (_failedShells.has(cacheKey)) return null;
  const cached = _cache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  const dir = join(getPluginData(), 'shell-snapshots');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const shellTag = shellPath.toLowerCase().includes('zsh')
    ? 'zsh'
    : shellPath.toLowerCase().includes('bash')
      ? 'bash'
      : 'sh';
  const snapshotPath = join(
    dir,
    `snapshot-${shellTag}-${Date.now()}-${randomUUID().slice(0, 6)}.sh`,
  );
  const result = await _runSnapshot(shellPath, snapshotPath, configExists);
  if (result) _cache.set(cacheKey, result);
  else _failedShells.add(cacheKey);
  return result;
}

// Wrap a user command so it runs with the captured environment sourced
// in. Snapshot generation is best-effort — when it fails, the command
// still runs (without alias / function support).
export async function wrapCommandWithSnapshot(shellPath, command) {
  if (process.platform === 'win32') return command;
  if (process.env.MIXDOG_BASH_SNAPSHOT === 'off') return command;
  const snapshot = await getOrCreateSnapshot(shellPath).catch(() => null);
  if (!snapshot) return command;
  const escaped = snapshot.replace(/'/g, "'\\''");
  // Source on its own line so the just-loaded aliases are visible to
  // the user command. When alias declarations and the consuming command
  // share a single shell line, alias expansion is skipped on that line
  // (bash POSIX rule) and the user command runs without snapshot
  // aliases applied.
  return `source '${escaped}' 2>/dev/null\n${command}`;
}
