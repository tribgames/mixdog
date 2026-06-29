import assert from 'node:assert/strict';
import {
  registerBackgroundTask,
  renderBackgroundTask,
  taskSummary,
} from '../src/runtime/shared/background-tasks.mjs';

const task = registerBackgroundTask({
  surface: 'agent',
  operation: 'spawn',
  label: 'smoke',
  meta: {
    tag: 'w1',
    role: 'worker',
    firstResponseTimeoutMs: 30_000,
    idleTimeoutMs: 120_000,
    spawnPrepTimeoutMs: 90_000,
    watchdogPolicy: { firstResponseMs: 30_000 },
  },
});

const rendered = renderBackgroundTask(task, { includeResult: false });
for (const forbidden of [
  'firstResponseTimeoutMs',
  'idleTimeoutMs',
  'spawnPrepTimeoutMs',
  'watchdogPolicy',
]) {
  assert.equal(rendered.includes(forbidden), false, `render leaked ${forbidden}`);
}

const summary = taskSummary(task);
assert.equal(summary.firstResponseTimeoutMs, undefined);
assert.equal(summary.idleTimeoutMs, undefined);
assert.equal(summary.spawnPrepTimeoutMs, undefined);
assert.equal(summary.tag, 'w1');

console.log('background-task-meta-smoke: ok');
