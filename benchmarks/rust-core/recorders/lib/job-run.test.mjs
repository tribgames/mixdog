// The job host's report against processes whose lives are ordered by pipes alone: a process ends when the pipe its parent holds
// closes, which happens when the parent exits.
//   node --test benchmarks/rust-core/recorders/lib/job-run.test.mjs   (MIXDOG_RECORDER_SCRATCH: where the run folders go)
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJobReport, spawnInJob } from './job-run.mjs';

const scratch = process.env.MIXDOG_RECORDER_SCRATCH || tmpdir();

/** Runs `node -e program` in a job; resolves with the host's report and the run folder. Bounded: the host is ended after 60 s. */
async function run(program) {
  const dir = mkdtempSync(join(scratch, 'job-run-'));
  const report = join(dir, 'job.json');
  const host = spawnInJob(process.execPath, ['-e', program], { env: { ...process.env, JOB_TEST_DIR: dir }, cwd: dir, stdio: ['ignore', 'ignore', 'inherit'], report });
  const deadline = setTimeout(() => host.kill(), 60_000);
  const [code] = await once(host, 'exit');
  clearTimeout(deadline);
  assert.notEqual(code, null, 'the job host did not end within 60 s');
  return { job: readJobReport(report), dir };
}

// Starts a child whose stdin is a pipe from its parent and which exits when that pipe ends; `then` runs in the child before it exits.
const PIPED = (then) => `process.stdin.resume(); process.stdin.on('end', () => { ${then} });`;

test('a process the program leaves running is left behind even when it ends by itself after the program', async () => {
  // P starts B and exits; B outlives P only until P's end of its stdin closes, then starts C (after P's exit) and exits itself.
  const c = PIPED('process.exit(0)');
  const b = PIPED(`const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(c)}], { stdio: ['pipe', 'ignore', 'ignore'] }); c.stdin.write(''); process.exit(0);`);
  const p = `const b = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(b)}], { stdio: ['pipe', 'ignore', 'ignore'] });
    require('fs').writeFileSync(require('path').join(process.env.JOB_TEST_DIR, 'b.pid'), String(b.pid)); process.exit(0);`;
  const { job, dir } = await run(p);
  const bPid = Number(readFileSync(join(dir, 'b.pid'), 'utf8'));
  assert.equal(job.exitCode, 0);
  assert.deepEqual(job.left.map((m) => m.pid), [bPid]);
});

test('a program whose children ended before it leaves nothing behind, and its exit code is reported', async () => {
  const child = PIPED('process.exit(0)');
  const p = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', () => process.exit(3)); c.stdin.end();`;
  const { job } = await run(p);
  assert.equal(job.exitCode, 3);
  assert.deepEqual(job.left, []);
});
