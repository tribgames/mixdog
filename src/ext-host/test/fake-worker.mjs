// A worker with scripted methods, for the pool's tests (native/core/crates/mixdog-exthost/tests).
// `node fake-worker.mjs overrun` ignores the core's chunk window.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runWorker } from '../worker-core.mjs';

const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);

const cancelled = (signal) =>
  new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })));

function startHelper(pidFile) {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, String(helper.pid));
}

const handlers = {
  echo: async ({ params }) => ({ value: params }),
  // The environment variable the core sets for an Electron-in-node-mode worker.
  electronMode: async () => ({ value: process.env.ELECTRON_RUN_AS_NODE ?? null }),
  whoami: async ({ params }) => ({ value: process.pid, pin: params?.pin === true }),
  sleep: async ({ params }) => {
    await new Promise((resolve) => setTimeout(resolve, params.ms));
    return { value: process.pid };
  },
  // Holds the slot until the core cancels.
  hold: async ({ signal }) => {
    await cancelled(signal);
    return { value: 'released' };
  },
  chunks: async ({ params, emit }) => {
    await emit(Buffer.alloc(params.bytes, params.fill ?? 7));
    return { value: { sent: params.bytes } };
  },
  // Synchronous JS the abort signal cannot interrupt.
  spin: async () => {
    for (;;);
  },
  // The same, recording its pid in `params.pidFile` first (a parser that never looks at the cancel).
  spinWithPid: async ({ params }) => {
    writeFileSync(params.pidFile, String(process.pid));
    for (;;);
  },
  crash: async () => process.exit(3),
  // Starts a helper that outlives this worker unless the core kills the whole group, records its
  // pid in `params.pidFile`, then crashes.
  crashWithHelper: async ({ params }) => {
    startHelper(params.pidFile);
    process.exit(3);
  },
  // Busy until the core ends it, with a helper that would outlive it.
  holdWithHelper: async ({ params, signal }) => {
    startHelper(params.pidFile);
    await cancelled(signal);
    return { value: 'released' };
  },
  // Answers normally, then exits 0 with the helper still running.
  exitWithHelper: async ({ params }) => {
    startHelper(params.pidFile);
    setTimeout(() => process.exit(0), 100);
    return { value: 'answered' };
  },
  browser: async ({ requestBrowser }) => ({ value: await requestBrowser() }),
  approved: async ({ paths }) => ({ value: paths }),
};

runWorker({
  handlers,
  input: process.stdin,
  write: (bytes) => writeFrame(bytes),
  exit: (code) => process.exit(code),
  windowBytes: process.argv[2] === 'overrun' ? 2 ** 30 : undefined,
});
