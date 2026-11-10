// The job of lib/process-job.mjs when its guard stops answering while a process is still in the job: the guard is ended by force, which
// closes the job's handle, and the job ends the process; the failure reported is the guard's unanswered request.
//   node --test benchmarks/rust-core/recorders/lib/process-job.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { withJob } from './process-job.mjs';

/** `promise`, or a failure naming `what` after `ms`. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

// Suspends every thread of a process (its main thread, the one reading its stdin, among them): it no longer answers or exits, as a hung
// guard would.
const SUSPEND = (pid) => `Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Diagnostics; using System.Runtime.InteropServices;
public static class Hang {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, int tid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Suspend(int pid) {
    foreach (ProcessThread thread in Process.GetProcessById(pid).Threads) {
      IntPtr handle = OpenThread(0x0002, false, thread.Id);
      if (handle == IntPtr.Zero) throw new Win32Exception();
      try { if (SuspendThread(handle) < 0) throw new Win32Exception(); } finally { CloseHandle(handle); }
    }
  }
}
'@
[Hang]::Suspend(${Number(pid)})`;

// The process left in the job: it tells its pid over a connection to the test and stays (the open connection keeps it alive).
const STAYS = (port) => `const s = require('net').connect(${port}, '127.0.0.1', () => s.write(String(process.pid)));`;

test('a guard that stops answering is ended by force, the job ends what is left in it, and the unanswered request is the failure', { timeout: 180_000 }, async () => {
  const server = net.createServer();
  await within(30_000, new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), 'the test listening on loopback');
  const arrived = new Promise((resolve) => server.once('connection', (socket) => socket.on('error', () => {}).once('data', (pid) => resolve({ socket, pid: Number(String(pid)) }))));
  let staying = null;
  let running = null;
  let guard = null;
  try {
    await assert.rejects(
      withJob(
        'hung-guard',
        async ({ run, guardPid }) => {
          guard = guardPid;
          // Not awaited: it runs until the job is ended; its own ending (with the guard gone) fails, which is not this test's question.
          running = run('stays', process.execPath, ['-e', STAYS(server.address().port)], { ms: 170_000 }).catch((error) => error);
          staying = await within(60_000, arrived, 'the process in the job telling its pid');
          const hung = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', SUSPEND(guardPid)], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
          assert.equal(hung.status, 0, `suspending the guard failed: ${hung.error?.message ?? hung.stderr}`);
        },
        { answerMs: 5_000 },
      ),
      /hung-guard: the job guard's answer to end 0 5000: not within 10000 ms/,
    );
    // The process's end closes its connection: withJob has returned, so this is the job's doing, not a later cleanup.
    await within(30_000, new Promise((resolve) => (staying.socket.destroyed ? resolve() : staying.socket.once('close', resolve))), 'the process in the job to end');
    assert.throws(() => process.kill(staying.pid, 0), { code: 'ESRCH' }, `the process ${staying.pid} in the job is still running`);
    await within(60_000, running, "the run of the process in the job to settle");
  } finally {
    // A process this test started that is still running here is a failure above; it is ended by its recorded pid (the guard first: its end
    // ends the job).
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const pid of [guard, staying?.pid]) if (pid && alive(pid)) process.kill(pid);
    server.close();
  }
});
