// Preloaded (--import) into every test process the runner starts: records
// "<pid> <spawn time ms>" for each child process, so a process a test leaves
// running can be traced back to the run after its parent exited
// (scripts/lib/run-node-tests.mjs). Without the runner's environment it does
// nothing.
import { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { FAILURE_RECORDS_ENV, spawnLedgerPath } from './test-failure-records.mjs';

const ledger = spawnLedgerPath(process.env[FAILURE_RECORDS_ENV]);
if (ledger) {
  // spawn, exec, execFile and fork all start their process here.
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function recordedSpawn(...args) {
    const result = spawn.apply(this, args);
    if (this.pid) appendFileSync(ledger, `${this.pid} ${Date.now()}\n`);
    return result;
  };
}
