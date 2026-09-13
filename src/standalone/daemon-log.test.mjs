import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createDaemonLog } from './daemon-log.mjs';
import { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';

function fixture(overrides = {}) {
  const batches = [];
  const stderrRows = [];
  const stderr = { write: (value) => { stderrRows.push(value); return true; } };
  const stdout = { write: () => true };
  const consoleTarget = {};
  const logger = createDaemonLog({
    logPath: 'daemon.log',
    fileSystem: {
      mkdir: async () => {},
      stat: async () => ({ size: 0 }),
      appendFile: async (_path, batch) => { batches.push(batch); },
    },
    stderr,
    stdout,
    consoleTarget,
    ...overrides,
  });
  return { logger, batches, stderrRows, stderr, stdout, consoleTarget };
}

test('the ready handoff writes every daemon line to exactly one sink', async () => {
  const f = fixture();
  f.logger.log('before ready');
  f.logger.enableFileLogging();
  f.logger.log('after ready');
  await f.logger.flush();
  assert.deepEqual(f.stderrRows, ['[daemon] before ready\n']);
  assert.equal(f.batches.length, 1);
  assert.match(f.batches[0], /\[daemon\] after ready\n$/);
  assert.equal(f.batches[0].includes('before ready'), false);
});

test('slow disk backpressure bounds queued data instead of growing a chain of batches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const batches = [];
  const f = fixture({
    fileSystem: {
      mkdir: async () => {},
      stat: async () => ({ size: 0 }),
      appendFile: async (_path, batch) => {
        batches.push(batch);
        if (batches.length === 1) await gate;
      },
    },
  });
  f.logger.enableFileLogging();
  f.logger.log('held write');
  t.mock.timers.tick(10);
  await setImmediate();
  for (let i = 0; i < 100; i += 1) {
    f.logger.log('x'.repeat(16_384));
    t.mock.timers.tick(10);
  }
  release();
  await f.logger.flush();
  assert.equal(batches.length, 2);
  assert.match(batches[1], /dropped \d+ log line\(s\) under backpressure/);
  assert.ok(Buffer.byteLength(batches.join('')) < 2 * 512 * 1024);
});

test('concurrent flushes do not duplicate batches or strand later queued lines', async () => {
  const f = fixture();
  f.logger.enableFileLogging();
  f.logger.log('first');
  const first = f.logger.flush();
  f.logger.log('second');
  await Promise.all([first, f.logger.flush()]);
  const text = f.batches.join('');
  assert.equal(text.match(/\[daemon\] first\n/g)?.length, 1);
  assert.equal(text.match(/\[daemon\] second\n/g)?.length, 1);
});

test('a failed append does not poison later best-effort logging', async () => {
  let attempts = 0;
  const written = [];
  const f = fixture({
    fileSystem: {
      mkdir: async () => {},
      stat: async () => ({ size: 0 }),
      appendFile: async (_path, batch) => {
        if (++attempts === 1) throw new Error('fixture disk unavailable');
        written.push(batch);
      },
    },
  });
  f.logger.enableFileLogging();
  f.logger.log('first');
  await f.logger.flush();
  f.logger.log('second');
  await f.logger.flush();
  assert.equal(attempts, 2);
  assert.match(written[0], /\[daemon\] second\n$/);
});

test('redirected streams preserve callbacks and bounded console formatting', async (t) => {
  const previous = process.env.MIXDOG_DAEMON_ALLOW_STDERR;
  delete process.env.MIXDOG_DAEMON_ALLOW_STDERR;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DAEMON_ALLOW_STDERR;
    else process.env.MIXDOG_DAEMON_ALLOW_STDERR = previous;
  });
  const f = fixture();
  f.logger.enableFileLogging();
  f.logger.installRedirect();
  let callbacks = 0;
  assert.equal(f.stderr.write('raw stderr\n', () => { callbacks += 1; }), true);
  assert.equal(f.stdout.write('raw stdout\n', 'utf8', () => { callbacks += 1; }), true);
  f.consoleTarget.warn({ long: 'x'.repeat(20_000) });
  await f.logger.flush();
  assert.equal(callbacks, 2);
  assert.match(f.batches.join(''), /raw stderr\n.*raw stdout\n/s);
  assert.match(f.batches.join(''), /\[console.warn\]/);
  assert.ok(f.batches.join('').length < 20_000);
  assert.deepEqual(f.stderrRows, []);
});

test('rotation retains the configured tail and appends the new line', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, 'daemon.log');
  writeFileSync(logPath, Buffer.alloc(PLUGIN_LOG_MAX_BYTES, 'a'));
  const logger = createDaemonLog({ logPath });
  logger.enableFileLogging();
  logger.log('after rotation');
  await logger.flush();
  const bytes = readFileSync(logPath);
  assert.ok(bytes.length > PLUGIN_LOG_KEEP_BYTES);
  assert.ok(bytes.length < PLUGIN_LOG_MAX_BYTES);
  assert.equal(bytes[0], 'a'.charCodeAt(0));
  assert.match(bytes.toString('utf8').slice(-100), /\[daemon\] after rotation\n$/);
});

test('a partial append failure invalidates the byte count before the next rotation decision', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-log-partial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, 'daemon.log');
  writeFileSync(logPath, Buffer.alloc(PLUGIN_LOG_MAX_BYTES - 16_384, 'x'));
  let appends = 0;
  const logger = createDaemonLog({
    logPath,
    fileSystem: {
      ...fileSystem,
      async appendFile(...args) {
        await fileSystem.appendFile(...args);
        if (++appends === 1) throw new Error('write failed after bytes reached disk');
      },
    },
  });
  logger.enableFileLogging();
  logger.log('a'.repeat(16_000));
  await logger.flush();
  logger.log('b'.repeat(1_000));
  await logger.flush();
  const bytes = readFileSync(logPath);
  assert.ok(bytes.length < PLUGIN_LOG_MAX_BYTES, 'rotation must account for bytes from a failed append');
  assert.ok(bytes.toString('utf8').endsWith(`${'b'.repeat(1_000)}\n`));
});
