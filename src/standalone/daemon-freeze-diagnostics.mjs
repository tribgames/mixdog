// The freeze watchdog's last words (daemon-freeze-watchdog-worker.mjs), on a
// thread of their own: any of these writes may block for good, and the
// watchdog kills the process at its deadline whether or not they finish.
import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { installDaemonExitRecorder } from '../session-runtime/services/daemon-crash-capture/daemon-exit-record.mjs';

const { line, logPath, dataDir, startedAtMs, reason, code, signal } = workerData;
try {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, 'utf8');
} catch {}
try {
  installDaemonExitRecorder({ dataDir, startedAtMs, target: { on() {} } }).write({ reason, code, signal });
} catch {}
// Last, as the likeliest to block: fd 2 is the launcher's crash-capture file,
// or a pipe nobody may be reading.
try {
  writeSync(2, line);
} catch {}
parentPort.postMessage('done');
