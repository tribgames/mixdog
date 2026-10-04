import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from './scheduler.mjs';

test('wrapPrompt takes hour and minute from one time snapshot', () => {
  const scheduler = Object.create(Scheduler.prototype);
  scheduler.getSessionState = () => ({ lastActivityMs: 0, pendingWork: false });
  scheduler.getTimeContext = () => ({ hour: 9, minute: 5, dayOfWeek: 'Monday', isWeekend: false });
  assert.match(scheduler.wrapPrompt('n', 'p', 'interactive'), /\[time: Monday 09:05 \| weekend: false\]/);
});

test('schedule log lines are not double-terminated on stderr', async () => {
  const scheduler = Object.create(Scheduler.prototype);
  scheduler.running = new Set(['daily']);
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await scheduler.fireTimedPrompt({ name: 'daily', model: 'm' }, 'non-interactive', 'p');
  } finally {
    process.stderr.write = original;
  }
  const line = writes.find((w) => w.includes('previous run still in progress'));
  assert.ok(line);
  assert.ok(line.endsWith('\n') && !line.endsWith('\n\n'));
});
