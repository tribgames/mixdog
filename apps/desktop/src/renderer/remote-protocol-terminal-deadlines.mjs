// The waits of the replay's teardown and lease-clock steps, each with one deadline that fails with what was awaited. They hold the real timers:
// the phone world replaces the global ones with a virtual clock, and this module is loaded before it.
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export const DEADLINE_MS = 60_000;

/** Rejects with `message` if `promise` has not settled within the deadline: the guard that turns a wait that would never end into a failure. */
export function bounded(promise, message, ms = DEADLINE_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${message} (no answer within ${ms} ms)`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer));
}

/** The manual lease clock's socket on `port`: it answers each command with one line. `connect` is `net.connect`; a connection that does not open is a failure. */
export async function openClockSocket(port, ms = DEADLINE_MS, connect = net.connect) {
  const socket = connect(port, '127.0.0.1');
  await bounded(
    new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }),
    `the connection to the lease clock on port ${port} to open`,
    ms
  ).catch((error) => {
    socket.destroy();
    throw error;
  });
  return { socket, lines: readline.createInterface({ input: socket }) };
}

/** Ends the core and its children, and resolves when `taskkill` has finished and the core has exited (its files are released then). One
 *  deadline covers both: `taskkill` is a process of its own and can hang like the core can. */
export function stopCore(core, ms = DEADLINE_MS, run = spawn) {
  // A core that has already exited emits no further `exit`: waiting for one would end the process with nothing printed.
  const gone = core.child.exitCode !== null || core.child.signalCode !== null;
  const exited = gone ? Promise.resolve() : new Promise((resolve) => core.child.once('exit', resolve));
  let killer;
  const killed = new Promise((resolve, reject) => {
    killer = run('taskkill', ['/PID', String(core.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', reject);
    // 128 is taskkill's answer for a pid that no longer exists (the core exited first); any other status left the core running.
    killer.once('exit', (status) =>
      status === 0 || status === 128 ? resolve() : reject(new Error(`taskkill could not end the core (pid ${core.child.pid}): it exited with status ${status}`))
    );
  });
  return bounded(Promise.all([killed, exited]), `taskkill to end the core (pid ${core.child.pid}) and the core to exit`, ms).catch((error) => {
    // A killer that hangs is ended with the failure, not left behind it.
    killer.kill();
    throw error;
  });
}
