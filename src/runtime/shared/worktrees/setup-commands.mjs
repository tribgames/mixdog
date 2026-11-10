/**
 * Worktree setup: the commands that prepare a freshly created managed
 * worktree (its dependency installs, dependencies.mjs) run one after another,
 * each through the system shell in its own folder of the worktree.
 *
 * The run never throws for what a command does: the report says how it ended
 * (`completed`, `failed`, `timed-out`, `cancelled`) and the first command that
 * does not complete ends it. Nothing here touches the worktree itself, so a
 * failed setup leaves the checkout exactly as the commands left it.
 *
 * Each command's output (stdout and stderr, interleaved) is kept within
 * `outputBytes`: past the cap the start and the end stay and the middle is
 * dropped. A command over `timeoutMs`, or a run whose `signal` aborts, has its
 * whole process tree killed.
 */
import { spawn } from 'node:child_process';
import { killProcessTrees } from '../../agent/orchestrator/mcp/child-tree.mjs';

const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_SETUP_OUTPUT_BYTES = 16 * 1024;
export const WORKTREE_SETUP_ELISION = '\n… output truncated …\n';
const PROGRESS_INTERVAL_MS = 200;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;

/** The last lines of a command's output, for a compact report. */
export function outputTail(output) {
  const lines = String(output || '')
    .trimEnd()
    .split(/\r?\n/)
    .slice(-TAIL_LINES)
    .join('\n');
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
}

/**
 * A byte-capped output window that keeps the first and the last half of the
 * cap once the output outgrows it.
 * @param {number} limit
 */
export function createOutputWindow(limit = WORKTREE_SETUP_OUTPUT_BYTES) {
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  return {
    append(chunk) {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += bytes.length;
      if (head.length < headLimit) {
        const take = Math.min(headLimit - head.length, bytes.length);
        head = Buffer.concat([head, bytes.subarray(0, take)]);
        bytes = bytes.subarray(take);
      }
      if (!bytes.length) return;
      tail = Buffer.concat([tail, bytes]);
      if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
    },
    get truncated() {
      return total > limit;
    },
    text() {
      if (total <= limit) return Buffer.concat([head, tail]).toString('utf8');
      return `${head.toString('utf8')}${WORKTREE_SETUP_ELISION}${tail.toString('utf8')}`;
    },
  };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    void killProcessTrees([child.pid]).catch(() => {});
    return;
  }
  try {
    // Started as its own process group: the shell and everything it spawned.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * The process environment with `overrides` applied: a string sets the
 * variable, null removes it (by any spelling on Windows, where names are
 * case-insensitive). No overrides: inherited as is.
 */
function commandEnv(overrides) {
  if (!overrides) return undefined;
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of Object.keys(env)) {
      if (key === name || (process.platform === 'win32' && key.toUpperCase() === name.toUpperCase())) delete env[key];
    }
    if (value !== null) env[name] = value;
  }
  return env;
}

/** One command to its end; resolves its step report, never rejects. */
function runCommand({ command, file, args, cwd, label, env }, { signal, timeoutMs, outputBytes, progress }) {
  const output = createOutputWindow(outputBytes);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let ended = null;
    let child;
    const finish = (status, exitCode = null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        label,
        status: ended ?? status,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: output.text(),
        truncated: output.truncated,
      });
    };
    const stop = (reason) => {
      if (ended) return;
      ended = reason;
      killTree(child);
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed-out'), timeoutMs);
    try {
      // `file` + `args`: run directly, no shell, so arguments are literal. A
      // Windows .cmd/.bat shim cannot be spawned without one; its arguments
      // are fixed, never file names.
      const direct = file && !(process.platform === 'win32' && /\.(cmd|bat)$/i.test(file));
      const options = {
        cwd,
        env: commandEnv(env),
        shell: !direct,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      child = direct ? spawn(file, args, options) : spawn(command, options);
    } catch (error) {
      output.append(String(error?.message || error));
      finish('failed');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const take = (chunk) => {
      output.append(chunk);
      progress(output);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', (error) => {
      output.append(`${String(error?.message || error)}\n`);
      finish('failed');
    });
    child.once('close', (code) => finish(code === 0 ? 'completed' : 'failed', Number.isInteger(code) ? code : null));
  });
}

/**
 * @typedef {object} WorktreeSetupStep
 * @property {string} command
 * @property {string} [label] Where it ran, for display.
 * @property {'completed'|'failed'|'timed-out'|'cancelled'} status
 * @property {number|null} exitCode
 * @property {number} durationMs
 * @property {string} output Capped output (middle elided when `truncated`).
 * @property {boolean} truncated
 */

/**
 * @typedef {object} WorktreeSetupCommand
 * @property {string} command Shell string; also the display text.
 * @property {string} [file] With `args`: run this program directly, no shell.
 * @property {string[]} [args]
 * @property {string} cwd
 * @property {string} [label]
 * @property {Record<string, string|null>} [env] Variables to set (string) or remove (null).
 */

/**
 * Run `commands` in order. `onProgress(event)` receives the live state —
 * `{ status: 'running', index, total, command, label, output, truncated }`
 * at each start and at most every 200 ms while output arrives — and finally
 * the report with `final: true`. `pending`: the commands a stop left unrun.
 * @param {{ commands: WorktreeSetupCommand[], signal?: AbortSignal, timeoutMs?: number,
 *   outputBytes?: number, onProgress?: (event: object) => void }} input
 * @returns {Promise<{ status: WorktreeSetupStep['status'], total: number, steps: WorktreeSetupStep[],
 *   pending: WorktreeSetupCommand[] }>}
 */
export async function runWorktreeSetupCommands({
  commands,
  signal,
  timeoutMs = WORKTREE_SETUP_TIMEOUT_MS,
  outputBytes = WORKTREE_SETUP_OUTPUT_BYTES,
  onProgress = () => {},
} = {}) {
  const total = commands.length;
  const steps = [];
  let status = 'completed';
  for (const [index, entry] of commands.entries()) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }
    const running = { status: 'running', index, total, command: entry.command, label: entry.label };
    onProgress({ ...running, output: '', truncated: false });
    let last = 0;
    const step = await runCommand(entry, {
      signal,
      timeoutMs,
      outputBytes,
      progress: (output) => {
        const now = Date.now();
        if (now - last < PROGRESS_INTERVAL_MS) return;
        last = now;
        onProgress({ ...running, output: output.text(), truncated: output.truncated });
      },
    });
    steps.push(step);
    if (step.status !== 'completed') {
      status = step.status;
      break;
    }
  }
  const report = { status, total, steps, pending: commands.slice(steps.length) };
  onProgress({ ...report, final: true });
  return report;
}
