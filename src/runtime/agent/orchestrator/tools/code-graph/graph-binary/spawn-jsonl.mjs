// One mixdog-graph run: spawn, timeout with kill escalation, JSONL parse.
//
// child-spawn-gate is NOT acquired here. Worker builds and main-thread
// signature validation both hold their slot in buildCodeGraphAsync; worker
// threads do not share module-level state with the main thread, so acquiring
// here would create an independent semaphore that cannot coordinate with rg.
import { spawn } from 'node:child_process';
import { createChildKiller } from './child-kill.mjs';
import { parseGraphJsonl } from './jsonl-records.mjs';

const STDERR_CAP = 8 * 1024;
const FORCE_SETTLE_MS = 5000;

export function spawnGraphJsonl({ binPath, absRoot, extraArgs, stdinLines, signal, timeoutMs, requireRel }) {
  return new Promise((resolve, reject) => {
    // When stdinLines is supplied (--files mode), stream one JSON object per
    // line to the child's STDIN — the reused nodes' metadata — so Rust can
    // resolve imports across the WHOLE tree (fresh + reused) while only
    // full-parsing the changed subset passed as argv.
    const wantsStdin = Array.isArray(stdinLines);
    const proc = spawn(binPath, [absRoot, ...extraArgs], {
      stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // windowsHide: native code-graph binary is a console exe; without this each
      // call flashes a console window when spawned under the detached daemon.
      windowsHide: true,
    });
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

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      if (stderrText.length >= STDERR_CAP) return;
      const piece = c.toString('utf8');
      const room = STDERR_CAP - stderrText.length;
      stderrText += piece.length > room ? piece.slice(0, room) : piece;
    });
    proc.on('error', (err) => settle(() => reject(err)));
    if (wantsStdin) {
      proc.stdin.on('error', () => {
        /* child may close stdin early; ignore EPIPE */
      });
      proc.stdin.write(stdinLines.length ? `${stdinLines.join('\n')}\n` : '');
      proc.stdin.end();
    }
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
        try {
          resolve(parseGraphJsonl(Buffer.concat(chunks).toString('utf8'), { requireRel }));
        } catch (error) {
          reject(error);
        }
      })
    );
  });
}
