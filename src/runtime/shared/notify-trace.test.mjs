import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flushNotifyTrace, notifyTrace } from './notify-trace.mjs';
import { createAsyncLogAppender } from './async-log-appender.mjs';

function withEnv(values, run) {
  values = { MIXDOG_NOTIFY_TRACE: '1', ...values };
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

test('the trace is off unless MIXDOG_NOTIFY_TRACE=1 opts in', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-notify-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  for (const value of [undefined, '', '0', 'true']) {
    withEnv({ MIXDOG_NOTIFY_TRACE: value, MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: undefined }, () =>
      notifyTrace('off-stage')
    );
  }
  await flushNotifyTrace();
  assert.equal(existsSync(join(dataDir, 'diagnostics')), false, 'nothing is written, not even the folder');
});

test('the trace lands in the data dir the environment names at call time', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-notify-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'isolated-data');
  const home = join(root, 'isolated-home');

  withEnv({ MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: undefined }, () => notifyTrace('data-dir-stage', { n: 1 }));
  await flushNotifyTrace();
  const dataLog = join(dataDir, 'diagnostics', 'notify-trace.log');
  assert.ok(existsSync(dataLog), 'MIXDOG_DATA_DIR must own the trace');
  assert.match(readFileSync(dataLog, 'utf8'), /data-dir-stage n=1/);

  // A pristine boundary retargets MIXDOG_HOME after earlier traces were written.
  withEnv({ MIXDOG_DATA_DIR: undefined, MIXDOG_HOME: home }, () => notifyTrace('home-stage'));
  await flushNotifyTrace();
  const homeLog = join(home, 'data', 'diagnostics', 'notify-trace.log');
  assert.ok(existsSync(homeLog), 'MIXDOG_HOME/data must own the trace');
  assert.match(readFileSync(homeLog, 'utf8'), /home-stage/);
  assert.doesNotMatch(readFileSync(dataLog, 'utf8'), /home-stage/);
});

test('the trace returns before its write and a flush lands every queued line', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-notify-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  withEnv({ MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: undefined }, () => {
    for (let index = 0; index < 50; index += 1) notifyTrace('burst', { index });
    assert.ok(!existsSync(join(dataDir, 'diagnostics', 'notify-trace.log')), 'append must not run inline');
  });
  await flushNotifyTrace();
  const lines = readFileSync(join(dataDir, 'diagnostics', 'notify-trace.log'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 50);
  assert.match(lines[49], /burst index=49$/);
});

test('an appended file is cut to its last whole lines once it passes the cap', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-log-appender-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'rotating.log');
  writeFileSync(file, Array.from({ length: 200 }, (_, index) => `old-${index}\n`).join(''));
  const log = createAsyncLogAppender({ maxBytes: 1000, keepBytes: 300 });
  for (let index = 0; index < 5; index += 1) log.append(file, `new-${index}\n`);
  await log.flush();
  const text = readFileSync(file, 'utf8');
  assert.ok(text.length <= 300 + 50, `bounded, got ${text.length}`);
  const lines = text.trim().split('\n');
  assert.ok(
    lines.every((line) => /^(old|new)-\d+$/.test(line)),
    'no partial line survives'
  );
  assert.deepEqual(lines.slice(-5), ['new-0', 'new-1', 'new-2', 'new-3', 'new-4']);
  assert.ok(lines.includes('old-199'));
});

test('an unwritable target is dropped without throwing or wedging later lines', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-log-appender-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = createAsyncLogAppender({ maxBytes: 1000, keepBytes: 300 });
  const missing = join(root, 'no-such-dir', 'x.log');
  log.append(missing, 'lost\n');
  await log.flush();
  const good = join(root, 'ok.log');
  log.append(good, 'kept\n');
  await log.flush();
  assert.equal(readFileSync(good, 'utf8'), 'kept\n');
});
