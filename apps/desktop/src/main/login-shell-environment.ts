// A Dock/Finder (macOS) or desktop-entry (Linux) launch inherits only the
// session manager's environment: the PATH additions and keys a user exports
// from ~/.zprofile or ~/.zshrc are missing, so the daemon it spawns — and every
// terminal and tool call under it — cannot find what a terminal launch finds
// (Homebrew git/gh/node, version managers, API keys). One interactive login
// shell prints its environment once, before the daemon starts. Windows GUI
// launches already carry the registry environment and skip the read.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';

const MARK = '__MIXDOG_LOGIN_ENV__';
// The marks bracket the dump so rc-file chatter before or after it is ignored.
const DUMP_SCRIPT = `printf '\\0%s\\0' ${MARK}; command env -0 || exit 1; printf '\\0%s\\0' ${MARK}; exit 0`;
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'];
// oh-my-zsh update prompts and tmux autostart plugins would otherwise block a
// shell that has no terminal attached.
const PROBE_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};
// Values that describe the probe shell process, not the user's configuration.
const PROBE_PROCESS_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', ...Object.keys(PROBE_ENV)]);
/** Whole-read budget across every candidate shell: the daemon waits for it. */
export const LOGIN_SHELL_READ_BUDGET_MS = 5_000;

export interface LoginShellFailure {
  shell: string;
  /** `exit <code>`, a signal name, a spawn error, `timeout`, or `unparsed`. */
  reason: string;
}

export interface LoginShellReadResult {
  /** The first successful shell's variables; null when every candidate failed. */
  environment: Record<string, string> | null;
  failures: LoginShellFailure[];
}

/** The account's login shell (what `chsh` chose — a Dock launch's $SHELL
 *  comes from launchd, not the user), then the fixed system shells. */
export function loginShellCandidates(): string[] {
  let account = '';
  try {
    account = userInfo().shell || '';
  } catch {
    /* no account record for this uid: fixed shells only */
  }
  return [...new Set([...(account ? [account] : []), ...FALLBACK_SHELLS])];
}

/** The variables printed between the two marks, or null until both arrived. */
export function extractLoginShellEnvironment(output: string): Record<string, string> | null {
  const fields = output.split('\0');
  const start = fields.indexOf(MARK);
  const end = fields.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const environment: Record<string, string> = {};
  for (const field of fields.slice(start + 1, end)) {
    const separator = field.indexOf('=');
    if (separator > 0) environment[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return environment;
}

/** The shell values this process should adopt. The shell wins, except for the
 *  probe's own process variables, Electron's runtime switches, and MIXDOG_*
 *  values the launcher already set (the desktop resolves those — bundled tool
 *  paths, isolated profiles — before the read). */
export function loginShellOverrides(
  inherited: NodeJS.ProcessEnv,
  shell: Readonly<Record<string, string>>
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(shell)) {
    if (PROBE_PROCESS_KEYS.has(key) || key.startsWith('ELECTRON_')) continue;
    if (key.startsWith('MIXDOG_') && inherited[key] !== undefined) continue;
    if (inherited[key] !== value) overrides[key] = value;
  }
  return overrides;
}

// Homebrew's prefixes (Apple Silicon, then Intel). A shell read that failed or
// a profile that never runs `brew shellenv` leaves them off a GUI launch PATH.
const HOMEBREW_PATH_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];

/** PATH with every existing Homebrew directory it lacks appended — never
 *  prepended, so the order the user's shell chose keeps winning. The original
 *  string is kept verbatim, empty components (the current directory) included. */
export function withHomebrewPath(
  path: string | undefined,
  exists: (dir: string) => boolean = existsSync
): { path: string; added: string[] } {
  const original = path ?? '';
  const segments = original.split(':');
  const added = HOMEBREW_PATH_DIRS.filter((dir) => !segments.includes(dir) && exists(dir));
  if (!added.length) return { path: original, added };
  return { path: original ? `${original}:${added.join(':')}` : added.join(':'), added };
}

function readShell(shell: string, timeoutMs: number): Promise<Record<string, string> | string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Interactive login mode runs the profile AND rc files, where most users
      // export PATH. stdin is closed so a prompting rc file reads EOF.
      child = spawn(shell, ['-ilc', DUMP_SCRIPT], {
        cwd: homedir(),
        env: { ...process.env, ...PROBE_ENV },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
      return;
    }
    const stdout = child.stdout!;
    const chunks: Buffer[] = [];
    let settled = false;
    const parsed = () => extractLoginShellEnvironment(Buffer.concat(chunks).toString('utf8'));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      // Background jobs an rc file starts inherit stdout and can hold it open
      // long after the shell exits, so the closing mark — not `close` — ends it.
      const environment = parsed();
      if (environment) finish(environment);
    };
    const timer = setTimeout(() => {
      finish('timeout');
      // The whole group: rc files may have started children of their own.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    function finish(result: Record<string, string> | string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep draining so a late writer does not die of EPIPE.
      stdout.off('data', onData);
      stdout.resume();
      resolve(result);
    }
    stdout.on('data', onData);
    child.on('error', (error) => finish(error.message));
    child.on('close', (code, signal) => {
      if (code !== 0) finish(signal ?? `exit ${String(code)}`);
      else finish(parsed() ?? 'unparsed');
    });
  });
}

/** Read the login-shell environment once. Never rejects: each failing
 *  candidate is recorded and the next one tried within one shared budget. */
export async function readLoginShellEnvironment({
  platform = process.platform,
  shells = loginShellCandidates(),
  budgetMs = LOGIN_SHELL_READ_BUDGET_MS,
}: {
  platform?: NodeJS.Platform;
  shells?: string[];
  budgetMs?: number;
} = {}): Promise<LoginShellReadResult> {
  const failures: LoginShellFailure[] = [];
  if (platform === 'win32') return { environment: null, failures };
  const deadline = Date.now() + budgetMs;
  for (const shell of shells) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failures.push({ shell, reason: 'timeout' });
      break;
    }
    const result = await readShell(shell, remainingMs);
    if (typeof result !== 'string') return { environment: result, failures };
    failures.push({ shell, reason: result });
  }
  return { environment: null, failures };
}
