import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from './scheduler.mjs';

test('schedule log lines are not double-terminated on stderr', async () => {
  const scheduler = Object.create(Scheduler.prototype);
  scheduler.running = new Set(['daily']);
  scheduler.renaming = new Set();
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await scheduler.fireTimedPrompt({ name: 'daily', model: 'm' }, 'p');
  } finally {
    process.stderr.write = original;
  }
  const line = writes.find((w) => w.includes('previous run still in progress'));
  assert.ok(line);
  assert.ok(line.endsWith('\n') && !line.endsWith('\n\n'));
});
