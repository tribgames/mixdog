// The freeze watchdog's thread (daemon-freeze-watchdog.mjs): judges the main
// thread's progress counter every tick, hosts the owner-liveness listener, and
// ends the process once the main thread stayed frozen past the limit.
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { workerExecArgv } from '../runtime/shared/worker-exec-argv.mjs';
import { startOwnerLivenessListener } from './daemon-owner.mjs';
import { createFreezeJudge, freezeSharedViews, readMirroredWork } from './daemon-freeze-watchdog.mjs';

const {
  buffer,
  limitMs,
  tickMs,
  suspendGapMs,
  logPath,
  dataDir,
  startedAtMs,
  livenessPid,
  diagnosticsDeadlineMs,
} = workerData;
const { beats, work, kill: killClaim } = freezeSharedViews(buffer);
const judge = createFreezeJudge({ suspendGapMs });
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);
let terminating = false;

// A worker's process.exit() ends only this thread, and process.abort() is
// unavailable here; SIGKILL ends the whole process on every platform (on
// Windows through TerminateProcess) without waiting on the frozen thread.
function kill() {
  process.kill(process.pid, 'SIGKILL');
}

// The diagnostics are best effort and never hold the kill back: a hung disk
// or a full stderr pipe blocks a synchronous write for good (and may be what
// froze the main thread). They are written on a thread of their own; the
// process dies once they are done or at the deadline, whichever comes first.
// The redundant watchdog reaching the limit too only backs the first one up.
function terminate(frozenMs) {
  if (terminating) return;
  terminating = true;
  if (Atomics.compareExchange(killClaim, 0, 0, 1) !== 0) {
    setTimeout(kill, diagnosticsDeadlineMs + 1000);
    return;
  }
  setTimeout(kill, diagnosticsDeadlineMs);
  const sinceMs = Number((process.hrtime.bigint() - Atomics.load(beats, 1)) / 1_000_000n);
  const w = readMirroredWork(work);
  const detail =
    `main thread made no progress for ${frozenMs}ms of watched time (limit ${limitMs}ms,` +
    ` last progress ${sinceMs}ms ago)` +
    ` | in-flight at last progress: activeCalls=${w.activeCalls} queuedCalls=${w.queuedCalls}` +
    ` busySessions=${w.busySessions} busyMemoryAgents=${w.busyMemoryAgents} turnBusySessions=${w.turnBusySessions}` +
    ' | the main thread JS stack cannot be captured from the watchdog thread';
  const line = `[${new Date().toISOString()}] [daemon] freeze watchdog: ${detail} — killing pid=${process.pid} so it is restarted\n`;
  const windows = process.platform === 'win32';
  try {
    const writer = new Worker(new URL('./daemon-freeze-diagnostics.mjs', import.meta.url), {
      name: 'mixdog-freeze-diagnostics',
      execArgv: workerExecArgv(),
      workerData: {
        line,
        logPath,
        dataDir,
        startedAtMs,
        reason: `freeze watchdog: ${detail}`,
        // TerminateProcess ends it with 1 on Windows; elsewhere SIGKILL.
        code: windows ? 1 : null,
        signal: windows ? null : 'SIGKILL',
      },
    });
    writer.once('message', kill);
    writer.once('error', kill);
    writer.once('exit', kill);
  } catch {
    kill();
  }
}

setInterval(() => {
  const frozenMs = judge.observe(nowMs(), Atomics.load(beats, 0));
  if (frozenMs >= limitMs) terminate(frozenMs);
}, tickMs);

const listener = await startOwnerLivenessListener({ pid: livenessPid });
parentPort.postMessage({ type: 'ready', livenessPort: listener?.port ?? 0 });
