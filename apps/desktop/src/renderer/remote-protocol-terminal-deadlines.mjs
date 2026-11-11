// The waits of the replay's lease-clock steps, each with one deadline that fails with what was awaited. They hold the real timers:
// the phone world replaces the global ones with a virtual clock, and this module is loaded before it.
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
