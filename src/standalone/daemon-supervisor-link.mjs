// The daemon's end of the channel its supervisor (native/mixdog-supervisor)
// holds. On stdin: `hello <nonce>` once, then `ping <nonce>`, each nonce 128
// fresh OS-random bits. This (main) thread answers on fd 1: `pong <nonce>
// <what the daemon is doing>` per ping, and `ready()` sends `ready <hello
// nonce>`, which the supervisor tells the launcher. Other writers to fd 1 can
// shape a line like an answer but cannot name its nonce: only this thread reads
// stdin (a worker's process.stdin gets no data unless its creator passes
// `stdin: true`, which nothing here does), and no nonce goes through argv or
// env. A daemon started without a supervisor (a direct fork) has no link and
// keeps the IPC ready handshake.
//
// Where the OS has no parent-death signal the supervisor also passes the read
// end of a lifeline pipe; a worker watches it on its own event loop, so the
// daemon dies with its supervisor even while this thread is frozen.
import { writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { workerExecArgv } from '../runtime/shared/worker-exec-argv.mjs';

// fd 1, not process.stdout: the daemon log redirect owns that stream. Other
// writers to fd 1 (native code, inheriting children) may leave a partial
// line: each message starts on a fresh one, and the supervisor skips every
// line it does not know.
function send(line) {
  try {
    writeSync(1, `\n${line}\n`);
  } catch {}
}

// Keeps an answer well inside the supervisor's line bound (4 KiB).
const DETAIL_CHARS = 512;

/** `describe()` is the one-line state each answer carries (the supervisor
 *  quotes the last one when it kills a frozen daemon). */
export function startSupervisorLink({ describe = () => '' } = {}) {
  const supervised = process.env.MIXDOG_DAEMON_SUPERVISED === '1';
  const lifelineFd = Number(process.env.MIXDOG_DAEMON_LIFELINE_FD);
  // The daemon's own children are not supervised by this channel.
  delete process.env.MIXDOG_DAEMON_SUPERVISED;
  delete process.env.MIXDOG_DAEMON_LIFELINE_FD;
  if (!supervised) return { supervised: false, ready() {} };
  if (Number.isInteger(lifelineFd) && lifelineFd >= 0) {
    new Worker(new URL('./daemon-lifeline-worker.mjs', import.meta.url), {
      name: 'mixdog-supervisor-lifeline',
      execArgv: workerExecArgv(),
      workerData: { fd: lifelineFd },
    }).unref();
  }
  let hello = null;
  let readyWanted = false;
  let announced = false;
  // Ready can be asked for before the hello was read.
  const announce = () => {
    if (!readyWanted || !hello || announced) return;
    announced = true;
    send(`ready ${hello}`);
  };
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const message = /^(hello|ping) ([0-9a-f]+)$/.exec(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (message?.[1] === 'hello') {
        hello = message[2];
        announce();
      } else if (message) {
        send(`pong ${message[2]} ${String(describe()).replace(/\s+/g, ' ').slice(0, DETAIL_CHARS)}`);
      }
    }
  });
  // Never what keeps the daemon alive.
  process.stdin.unref?.();
  return {
    supervised: true,
    ready: () => {
      readyWanted = true;
      announce();
    },
  };
}
