import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { notifyTrace } from './notify-trace.mjs';

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('the trace lands in the data dir the environment names at call time', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-notify-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'isolated-data');
  const home = join(root, 'isolated-home');

  withEnv({ MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: undefined }, () => notifyTrace('data-dir-stage', { n: 1 }));
  const dataLog = join(dataDir, 'diagnostics', 'notify-trace.log');
  assert.ok(existsSync(dataLog), 'MIXDOG_DATA_DIR must own the trace');
  assert.match(readFileSync(dataLog, 'utf8'), /data-dir-stage n=1/);

  // A pristine boundary retargets MIXDOG_HOME after earlier traces were written.
  withEnv({ MIXDOG_DATA_DIR: undefined, MIXDOG_HOME: home }, () => notifyTrace('home-stage'));
  const homeLog = join(home, 'data', 'diagnostics', 'notify-trace.log');
  assert.ok(existsSync(homeLog), 'MIXDOG_HOME/data must own the trace');
  assert.match(readFileSync(homeLog, 'utf8'), /home-stage/);
  assert.doesNotMatch(readFileSync(dataLog, 'utf8'), /home-stage/);
});
