import { ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSystemErrorMap } from 'node:util';
import { FAILURE_RECORDS_ENV, spawnLedgerPath } from './test-failure-records.mjs';

// --test-force-exit ends a file's process once every registered test finished, so tests registered after a
// still-pending top-level await never run and the file exits 0. Re-importing the entry only observes it:
// exiting before its top-level evaluation completed fails the file.
// Only ESM entries are observed: importing a CommonJS entry would run it twice and change `require.main === module`.
const isEsmEntry = (file) => {
  if (/\.(mjs|mts)$/.test(file)) return true;
  if (/\.(cjs|cts)$/.test(file)) return false;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type === 'module';
    } catch {
      // no readable package.json here: keep walking up
    }
    if (dirname(dir) === dir) return false;
  }
};
if (
  process.env.NODE_TEST_CONTEXT === 'child-v8' &&
  process.execArgv.includes('--test-force-exit') &&
  isEsmEntry(process.argv[1])
) {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  import(pathToFileURL(process.argv[1]).href).then(settle, settle);
  process.on('exit', (code) => {
    // A load error can exit before the observer's rejection callback runs.
    // Diagnose a dropped evaluation only when the file would otherwise pass.
    if (settled || code !== 0) return;
    console.error(
      `${process.argv[1]}: the process was force-exited before the file's top-level evaluation completed (a top-level await was still pending); tests registered after it never ran, and an await that never settles is treated the same way`
    );
    process.exitCode = 1;
  });
}

const ledger = spawnLedgerPath(process.env[FAILURE_RECORDS_ENV]);
if (ledger) {
  // A spawn is "<pid> <before> <since>"; the same line plus "<exited>" follows its exit.
  // 'exit' precedes closing the child's handle, so the pid is still this child's when that line is written.
  const spawn = ChildProcess.prototype.spawn;
  const exited = new Set();
  ChildProcess.prototype.spawn = function recordedSpawn(...args) {
    const before = Date.now();
    const result = spawn.apply(this, args);
    if (this.pid) {
      const { pid } = this;
      exited.delete(pid);
      const spawned = `${pid} ${before} ${Date.now()}`;
      appendFileSync(ledger, `${spawned}\n`);
      this.once('exit', () => {
        exited.add(pid);
        appendFileSync(ledger, `${spawned} ${Date.now()}\n`);
      });
    }
    return result;
  };
  // Windows hands a freed pid to the next process within moments, so a cleanup signalling a recorded pid
  // could kill another unit's process. Such a signal fails ESRCH here; arguments Node rejects still go to Node.
  const kill = process.kill;
  const [ESRCH] = [...getSystemErrorMap()].find(([, [name]]) => name === 'ESRCH');
  const sendable = (signal) => signal === (signal | 0) || Boolean(constants.signals[signal || 'SIGTERM']);
  process.kill = function killLiveChildOnly(pid, signal) {
    // Only a primitive pid is checked: coercing an object would run its
    // valueOf before Node's own coercion does. Number(pid) === (pid | 0) is
    // Node's `pid == (pid | 0)` integer check.
    const primitive = typeof pid === 'number' || typeof pid === 'string';
    if (primitive && Number(pid) === (pid | 0) && exited.has(pid | 0) && sendable(signal)) {
      // The shape of Node's own failed kill (an ErrnoException).
      throw Object.assign(new Error('kill ESRCH'), { errno: ESRCH, code: 'ESRCH', syscall: 'kill' });
    }
    return kill.call(process, pid, signal);
  };
}
