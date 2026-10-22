// Child-process helpers for the tidy engines. Every spawn goes through
// runProcess: argument arrays only (never a shell string), windowsHide, a hard
// timeout with kill escalation, and capped stdout/stderr buffers. Engine
// binaries and file paths are untrusted input, so no value ever reaches a shell
// parser.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

const DEFAULT_PROCESS_TIMEOUT_MS = 90_000;
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat']);

/** True for the Windows batch wrappers npm writes into node_modules/.bin. */
function isWindowsScript(binPath) {
  return process.platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extname(String(binPath || '')).toLowerCase());
}

function executableCandidates(name) {
  if (process.platform !== 'win32') return [name];
  if (extname(name)) return [name];
  const pathExt = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  return [name, ...pathExt.map((ext) => `${name}${ext.toLowerCase()}`)];
}

function isExecutableFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

const pathDirs = (env) =>
  String(env.PATH || env.Path || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

const nameKey = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * One PATH's directory listings, read once per directory on first use, for a
 * batch of `which` lookups. Resolving the whole engine catalog probed every
 * PATH dir × PATHEXT extension × engine name with its own statSync (≈17k
 * synchronous stats on a 65-entry PATH); with an index a name that is on no
 * directory costs no filesystem call at all.
 */
export function createPathIndex(env = process.env) {
  const listings = new Map(); // dir -> Set of entry names, or null (unlistable)
  return {
    dirs: pathDirs(env),
    has(dir, candidate) {
      if (!listings.has(dir)) {
        let names = null;
        try {
          names = new Set(readdirSync(dir).map(nameKey));
        } catch {
          // Unlistable (no list permission, gone): probe it per candidate.
        }
        listings.set(dir, names);
      }
      const names = listings.get(dir);
      return names ? names.has(nameKey(candidate)) : true;
    },
  };
}

/** First match for `name` on PATH, or null. Pure filesystem lookup, no spawn.
 *  `index` (createPathIndex over the same env) answers from directory listings. */
export function which(name, { env = process.env, index = null } = {}) {
  const bin = String(name || '').trim();
  if (!bin) return null;
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return existsSync(bin) ? bin : null;
  }
  for (const dir of index ? index.dirs : pathDirs(env)) {
    for (const candidate of executableCandidates(bin)) {
      if (index && !index.has(dir, candidate)) continue;
      const full = join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

function captureInto(state, key, chunk, cap) {
  const flag = `${key}Truncated`;
  if (state[flag]) return;
  const piece = chunk.toString('utf8');
  const room = cap - state[key].length;
  if (room <= 0) {
    state[flag] = true;
    return;
  }
  if (piece.length > room) {
    state[key] += piece.slice(0, room);
    state[flag] = true;
    return;
  }
  state[key] += piece;
}

/**
 * Spawn `bin` with `args` and collect its output.
 * Resolves `{code, signal, stdout, stderr, timedOut, error}` — a failed spawn is
 * reported, never thrown, so one broken engine cannot abort the multiplexer.
 */
export function runProcess(
  bin,
  args = [],
  {
    cwd = process.cwd(),
    env = process.env,
    input = null,
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    signal = null,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
  } = {}
) {
  return new Promise((resolveRun) => {
    const cap = Math.max(0, Number(maxCaptureBytes) || MAX_CAPTURE_BYTES);
    const state = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
    let command = bin;
    let argv = args;
    if (isWindowsScript(bin)) {
      // Node refuses to spawn .cmd/.bat without a shell. Invoke the interpreter
      // explicitly with an argument array so arguments stay data, not script.
      command = process.env.ComSpec || 'cmd.exe';
      argv = ['/d', '/s', '/c', bin, ...args];
    }
    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        windowsHide: true,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveRun({
        code: -1,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        error: error?.message || String(error),
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let onAbort = null;

    const escalate = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* best-effort */
      }
    };
    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(escalate, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild();
          }, timeoutMs)
        : null;
    if (timer?.unref) timer.unref();
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (onAbort && signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* best-effort */
        }
      }
    };
    if (signal) {
      onAbort = () => killChild();
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // One exit path for both outcomes: whoever settles first reports the
    // captured output and clears the timers.
    const settle = (code, exitSignal, error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveRun({
        code,
        signal: exitSignal,
        stdout: state.stdout,
        stderr: state.stderr,
        timedOut,
        truncated: Boolean(state.stdoutTruncated || state.stderrTruncated),
        error,
      });
    };

    child.stdout?.on('data', (chunk) => captureInto(state, 'stdout', chunk, cap));
    child.stderr?.on('data', (chunk) => captureInto(state, 'stderr', chunk, cap));
    child.on('error', (error) => settle(-1, null, error?.message || String(error)));
    if (input != null && child.stdin) {
      child.stdin.on('error', () => {
        /* child may close stdin early */
      });
      child.stdin.end(input);
    }
    child.on('close', (code, closeSignal) =>
      settle(
        typeof code === 'number' ? code : -1,
        closeSignal || null,
        timedOut ? `timed out after ${timeoutMs}ms` : ''
      )
    );
  });
}

/** Bounded-concurrency map that preserves input order and never rejects early. */
export async function mapLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
