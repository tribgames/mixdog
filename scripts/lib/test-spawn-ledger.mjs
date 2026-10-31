// Preloaded (--import) into every test process the runner starts: records
// each child process's pid, spawn time and exit, so a process a test leaves
// running can be traced back to the run after its parent exited
// (scripts/lib/run-node-tests.mjs). Without the runner's environment it does
// nothing.
import { ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSystemErrorMap } from 'node:util';
import { FAILURE_RECORDS_ENV, spawnLedgerPath } from './test-failure-records.mjs';

// --test-force-exit ends a test file's process once every test registered so
// far has finished. A test registered after a top-level await that is still
// pending by then (e.g. `await import()` between tests) is never run, and the
// file would exit 0 with those tests unreported. The entry module is already
// being evaluated by the time this runs, so importing it again only observes
// it: if the process exits before its top-level evaluation completed, fail the
// file instead. Stricter on purpose: an entry whose top-level evaluation never
// completes under force-exit (e.g. an intentionally never-resolving await after
// its last test) cannot be told apart from dropped tests, so it fails too.
// Only ESM entries are observed: importing a CommonJS entry would run it a
// second time and change `require.main === module`.
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
    if (settled) return;
    console.error(
      `${process.argv[1]}: the process was force-exited before the file's top-level evaluation completed (a top-level await was still pending); tests registered after it never ran, and an await that never settles is treated the same way`
    );
    // Never replace a failure code the file already set.
    if (!code) process.exitCode = 1;
  });
}

const ledger = spawnLedgerPath(process.env[FAILURE_RECORDS_ENV]);
if (ledger) {
  // spawn, exec, execFile and fork all start their process here. A spawn is
  // "<pid> <before> <since>", the clock just before and just after it; the
  // same line plus "<exited>" follows once its exit is seen. The 'exit' event
  // comes before the child's handle is closed, so the pid is still this
  // child's when the exit is written: from then on another process may hold it.
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
  // Once a child's exit is seen its pid is free, and Windows hands it to the
  // next process started within moments — on a loaded gate often a parallel
  // unit's test runner, node --test batch or test file process. A cleanup that
  // signals every pid it recorded (e.g. `after(() => process.kill(pid))`, or a
  // kill(pid, 0) liveness poll) then terminates that process instead, and the
  // whole unit dies without output. Such a signal fails ESRCH here, as for a
  // gone process, and never reaches whatever holds the pid now. Arguments Node
  // rejects (a non-integer pid, an unknown signal) still go to Node, which
  // throws before any signal is sent; this rejects only what it would send.
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
