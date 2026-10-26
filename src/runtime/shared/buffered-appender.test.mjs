import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// The async append is replaced by an in-memory fake, so the flush chain is made
// of promise reactions only and the debounce timer is the mocked clock's.
const appends = []; // every async append the module issued: { path, data }
let appendOutcome = (path, data) => {
  appendFileSync(path, data, 'utf8');
};
mock.module('node:fs/promises', {
  namedExports: {
    appendFile: async (path, data) => {
      appends.push({ path, data });
      return appendOutcome(path, data);
    },
  },
});
const { appendBuffered, drainPathSync, getBufferedAppenderStats } = await import('./buffered-appender.mjs');

// Promise reactions all run before the next macrotask, so once this resolves
// the fake append's whole then/catch/finally chain has completed.
const reactionsSettled = () => new Promise((resolve) => setImmediate(resolve));

test('a mid-write sync drain does not duplicate the in-flight payload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-buffered-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'log.txt');
  appendBuffered(path, 'a'.repeat(40 * 1024)); // crosses the flush threshold: async append starts
  drainPathSync(path);
  appendBuffered(path, 'b');
  await reactionsSettled();
  t.mock.timers.runAll(); // the debounce flush of 'b'
  await reactionsSettled();
  const text = readFileSync(path, 'utf8');
  assert.equal(text.length, 40 * 1024 + 1);
});

test('data dropped after repeated flush failures is recorded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-buffered-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing-dir', 'log.txt');
  appendOutcome = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  t.after(() => {
    appendOutcome = (file, data) => {
      appendFileSync(file, data, 'utf8');
    };
  });
  appends.length = 0;
  appendBuffered(path, 'hello');
  while (getBufferedAppenderStats(path).droppedBytes === 0) {
    t.mock.timers.runAll(); // the pending debounce flush
    await reactionsSettled();
  }
  assert.equal(getBufferedAppenderStats(path).droppedBytes, 5);
  // The module requeues a failed flush up to 3 times before dropping it.
  assert.equal(appends.length, 4);
  assert.ok(appends.every((append) => append.path === path && append.data === 'hello'));
});
