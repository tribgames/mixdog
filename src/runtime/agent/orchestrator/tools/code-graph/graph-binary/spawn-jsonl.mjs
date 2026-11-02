// One mixdog-graph run: spawn, timeout with kill escalation, JSONL parse.
//
// child-spawn-gate is NOT acquired here. Worker builds and main-thread
// signature validation both hold their slot in buildCodeGraphAsync; worker
// threads do not share module-level state with the main thread, so acquiring
// here would create an independent semaphore that cannot coordinate with rg.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { ensureNativeSpawnServer, tryNativeSpawn } from '../../lib/native-spawn-client.mjs';
import { createChildKiller } from './child-kill.mjs';
import { parseGraphJsonl } from './jsonl-records.mjs';

const STDERR_CAP = 8 * 1024;
const FORCE_SETTLE_MS = 5000;

// In-flight runs by identical inputs. An entry lives only while its process
// runs: nothing is cached after completion (the graph caches own that).
// Parallel sub-agents asking about the same repo used to start N identical
// processes in the same tick, and each Node `spawn` blocks the main thread.
const inflight = new Map();

function runKey({ binPath, absRoot, extraArgs, stdinLines, timeoutMs, env, cwd }) {
  const hash = createHash('sha256');
  // env and cwd are part of the identity: the child's output can depend on
  // them, and they may change between two calls. Length-prefixed parts keep
  // joins unambiguous.
  const envParts = Object.keys(env)
    .sort()
    .flatMap((name) => [name, env[name]]);
  for (const part of [binPath, absRoot, timeoutMs, cwd, ...extraArgs, '\0env', ...envParts]) {
    const text = String(part);
    hash.update(`${text.length}:${text}`);
  }
  hash.update(Array.isArray(stdinLines) ? `\0stdin${stdinLines.length}\0${stdinLines.join('\n')}` : '\0nostdin');
  return hash.digest('hex');
}

function startShared(key, params) {
  const controller = new AbortController();
  const entry = { waiters: 0, controller, promise: null };
  entry.promise = runGraphProcess({ ...params, signal: controller.signal }).finally(() => {
    if (inflight.get(key) === entry) inflight.delete(key);
  });
  // Waiters each attach their own handlers; this keeps a run whose waiters all
  // aborted from surfacing as an unhandled rejection.
  entry.promise.catch(() => {});
  inflight.set(key, entry);
  return entry;
}

// Concurrent calls with identical inputs share one process and await its
// stdout. Each waiter parses its own records, so callers never share mutable
// result objects. A waiter's abort rejects only that waiter; the process is
// killed when the last waiter leaves.
export function spawnGraphJsonl(callParams) {
  const { signal, requireRel } = callParams;
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  // Snapshot synchronously: the launch awaits the spawn server, and a later
  // env/cwd change must not leak into a run this call started or joined.
  const params = { ...callParams, env: { ...process.env }, cwd: process.cwd() };
  const key = runKey(params);
  const entry = inflight.get(key) || startShared(key, params);
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let left = false;
    const leave = () => {
      left = true;
      entry.waiters -= 1;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (left) return;
      leave();
      if (entry.waiters > 0) {
        reject(new Error('aborted'));
        return;
      }
      // Last waiter: stop the process, drop the entry so a new caller starts
      // a fresh run, and settle only once the process is gone (the child gate
      // slot the caller holds must not be released early).
      if (inflight.get(key) === entry) inflight.delete(key);
      entry.controller.abort();
      entry.promise.then(
        () => reject(new Error('aborted')),
        (error) => reject(error)
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (stdout) => {
        if (left) return;
        leave();
        try {
          resolve(parseGraphJsonl(stdout, { requireRel }));
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        if (left) return;
        leave();
        reject(error);
      }
    );
  });
}

// Node's `spawn` runs CreateProcess synchronously on the calling thread (up to
// ~0.5 s under load), so on the daemon main thread the launch goes through the
// native spawn server — the established off-thread path (git, shell): the main
// thread only writes a request line and receives output events. Worker threads
// (the build worker) are already off the main thread and, being separate
// module instances, would each start their own server, so they spawn directly,
// as does a main thread whose server is unavailable.
const NATIVE_OUTPUT_LIMIT = 1024 * 1024 * 1024;

async function launchGraphChild({ binPath, absRoot, extraArgs, wantsStdin, env, cwd }) {
  const args = [absRoot, ...extraArgs];
  if (isMainThread) {
    try {
      await ensureNativeSpawnServer();
      const native = tryNativeSpawn({
        shell: binPath,
        argv: args,
        spawnOptions: {
          env,
          cwd,
          outputLimit: NATIVE_OUTPUT_LIMIT,
          rawOutput: true,
          stdinPipe: wantsStdin,
        },
      });
      if (native?.child) {
        const child = native.child;
        return {
          proc: child,
          // The server drops a stdin write for a request it has not yet
          // registered, so wait for its 'spawned' event.
          writeStdin: (text) => {
            const write = () => child.writeStdin(text, { close: true });
            if (child.pid) write();
            else child.once('spawn', write);
          },
        };
      }
    } catch {
      /* server unavailable or incompatible: fall back to a direct spawn */
    }
  }
  const proc = spawn(binPath, args, {
    env,
    cwd,
    stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // windowsHide: native code-graph binary is a console exe; without this each
    // call flashes a console window when spawned under the detached daemon.
    windowsHide: true,
  });
  return {
    proc,
    writeStdin(text) {
      proc.stdin.on('error', () => {
        /* child may close stdin early; ignore EPIPE */
      });
      proc.stdin.write(text);
      proc.stdin.end();
    },
  };
}

async function runGraphProcess(params) {
  const { binPath, absRoot, extraArgs, stdinLines, env, cwd } = params;
  // When stdinLines is supplied (--files mode), stream one JSON object per
  // line to the child's STDIN — the reused nodes' metadata — so Rust can
  // resolve imports across the WHOLE tree (fresh + reused) while only
  // full-parsing the changed subset passed as argv.
  const wantsStdin = Array.isArray(stdinLines);
  const launched = await launchGraphChild({ binPath, absRoot, extraArgs, wantsStdin, env, cwd });
  return superviseGraphChild(launched, params, wantsStdin);
}

function superviseGraphChild({ proc, writeStdin }, { stdinLines, signal, timeoutMs }, wantsStdin) {
  return new Promise((resolve, reject) => {
    const killer = createChildKiller(proc);
    const chunks = [];
    let stderrText = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer = null;
    let forceSettleTimer = null;
    let onAbort = null;

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      killer.clearGrace();
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
        forceSettleTimer = null;
      }
      if (onAbort && signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* ignore */
        }
        onAbort = null;
      }
    };
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      clearTimers();
      finish();
    };
    const timeoutError = () => new Error(`[code-graph] mixdog-graph timed out after ${timeoutMs}ms`);

    // Arm timeout — unref so it doesn't keep the process alive. On timeout we
    // start SIGTERM→grace→force-kill but do NOT settle yet: the promise stays
    // pending until the child's 'close' fires (so the build worker — and the
    // main-thread gate slot it holds — is only released once the process is
    // actually gone). A separate force-settle deadline guarantees the promise
    // still resolves if 'close' never arrives. Mirrors rg-runner exactly.
    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      killer.kill();
      // Hard backstop: if 'close' never fires after the kill escalation,
      // escalate again and settle so we never hang (and never release the
      // gate while the child is provably still alive without a final attempt).
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      forceSettleTimer = setTimeout(() => {
        forceSettleTimer = null;
        if (settled) return;
        killer.escalate();
        settle(() => reject(timeoutError()));
      }, FORCE_SETTLE_MS);
      forceSettleTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
    if (signal) {
      onAbort = () => {
        aborted = true;
        killer.kill();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (c) => chunks.push(Buffer.from(c)));
    proc.stderr.on('data', (c) => {
      if (stderrText.length >= STDERR_CAP) return;
      const piece = c.toString('utf8');
      const room = STDERR_CAP - stderrText.length;
      stderrText += piece.length > room ? piece.slice(0, room) : piece;
    });
    proc.on('error', (err) => settle(() => reject(err)));
    if (wantsStdin) writeStdin(stdinLines.length ? `${stdinLines.join('\n')}\n` : '');
    proc.on('close', (code) =>
      settle(() => {
        if (timedOut) {
          // Our timeout kill won the race: the child is gone now, so the gate
          // slot releases here (not at timeout-fire time). Report as a timeout.
          reject(timeoutError());
          return;
        }
        if (aborted) {
          reject(new Error('aborted'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`[code-graph] mixdog-graph exited ${code}: ${stderrText.trim().slice(0, 200)}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      })
    );
  });
}
