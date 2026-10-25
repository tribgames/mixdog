import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendBuffered, drainPathSync, getBufferedAppenderStats } from './buffered-appender.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a mid-write sync drain does not duplicate the in-flight payload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-buffered-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'log.txt');
  appendBuffered(path, 'a'.repeat(40 * 1024)); // crosses the flush threshold: async append starts
  drainPathSync(path);
  appendBuffered(path, 'b');
  await wait(150);
  const text = readFileSync(path, 'utf8');
  assert.equal(text.length, 40 * 1024 + 1);
});

test('data dropped after repeated flush failures is recorded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-buffered-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing-dir', 'log.txt');
  appendBuffered(path, 'hello');
  for (let i = 0; i < 200 && !(getBufferedAppenderStats(path).droppedBytes >= 5); i++) await wait(25);
  assert.ok(getBufferedAppenderStats(path).droppedBytes >= 5);
});
