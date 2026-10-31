import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMaintenanceIdleProbe, registerMaintenanceTask, runMaintenanceTasks } from './maintenance-schedule.mjs';

test('due tasks run one at a time only while idle; a busy tick defers them; errors reschedule', async () => {
  const ran = [];
  const errors = [];
  let idle = false;
  const stopProbe = registerMaintenanceIdleProbe(() => idle);
  const stopA = registerMaintenanceTask('a', () => ran.push('a'), { intervalMs: 100, initialDelayMs: 10, now: 0 });
  const stopB = registerMaintenanceTask(
    'b',
    () => {
      ran.push('b');
      throw new Error('boom');
    },
    { intervalMs: 50, initialDelayMs: 0, now: 0, onError: (error) => errors.push(error.message) }
  );
  try {
    assert.deepEqual(await runMaintenanceTasks({ now: 20 }), { ran: [], busy: true });
    idle = true;
    assert.deepEqual(await runMaintenanceTasks({ now: 20 }), { ran: ['a', 'b'], busy: false });
    assert.deepEqual(errors, ['boom']);
    assert.deepEqual((await runMaintenanceTasks({ now: 60 })).ran, [], 'not due yet');
    assert.deepEqual((await runMaintenanceTasks({ now: 70 })).ran, ['b']);
    idle = false;
    assert.deepEqual((await runMaintenanceTasks({ force: true, now: 71 })).ran, ['a', 'b'], 'force skips the gate');
  } finally {
    stopA();
    stopB();
    stopProbe();
  }
  assert.deepEqual(ran, ['a', 'b', 'b', 'a', 'b']);
});

test('a turn that starts during one task defers the next task of the same tick', async () => {
  let idle = true;
  const ran = [];
  const stopProbe = registerMaintenanceIdleProbe(() => idle);
  const stopFirst = registerMaintenanceTask(
    'first',
    () => {
      ran.push('first');
      idle = false; // a session started its turn meanwhile
    },
    { intervalMs: 1_000, initialDelayMs: 0, now: 0 }
  );
  const stopSecond = registerMaintenanceTask('second', () => ran.push('second'), {
    intervalMs: 1_000,
    initialDelayMs: 0,
    now: 0,
  });
  try {
    assert.deepEqual(await runMaintenanceTasks({ now: 1 }), { ran: ['first'], busy: true });
    idle = true;
    assert.deepEqual((await runMaintenanceTasks({ now: 2 })).ran, ['second'], 'still due, it runs once idle');
  } finally {
    stopFirst();
    stopSecond();
    stopProbe();
  }
  assert.deepEqual(ran, ['first', 'second']);
});
