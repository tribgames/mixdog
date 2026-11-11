import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SHELL_OUTPUT_RETENTION_MS, sweepExpiredShellOutput } from './shell-exec-output.mjs';

// The sweep takes only the spill files whose ownership record shows their run
// ended: a run another process still has going (silent for longer than the
// retention) and a file nobody recorded are left, and the files left for want
// of a record are counted.
test('the shell-output sweep takes only ended runs older than the retention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-output-sweep-'));
  try {
    const now = Date.now();
    const write = (name, body, ageMs) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      const at = new Date(now - ageMs);
      utimesSync(path, at, at);
      return path;
    };
    const run = (id, state, ageMs) => [
      write(`${id}.stdout`, 'out', ageMs),
      write(`${id}.stderr`, 'err', ageMs),
      write(`${id}.owner.json`, JSON.stringify({ pid: 1, state }), ageMs),
    ];
    const old = SHELL_OUTPUT_RETENTION_MS + 24 * 60 * 60 * 1000;
    const ended = run('job_ended', 'finished', old);
    const recent = run('job_recent', 'finished', 60_000);
    const live = run('job_live_elsewhere', 'running', old);
    const unowned = write('my-notes.stdout', 'mine', old);
    write('my-notes.stderr', 'mine', 60_000);
    write('readme.txt', 'not a spill file', old);
    const left = await sweepExpiredShellOutput(dir, now);
    assert.equal(left, 2, 'both unrecorded spill-named files are counted, nothing else');
    assert.deepEqual(ended.map(existsSync), [false, false, false], 'the ended run went');
    assert.deepEqual(recent.map(existsSync), [true, true, true], 'a recent run stays');
    assert.deepEqual(live.map(existsSync), [true, true, true], "another process's running run stays");
    assert.ok(existsSync(unowned), 'a file with no ownership record stays');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
