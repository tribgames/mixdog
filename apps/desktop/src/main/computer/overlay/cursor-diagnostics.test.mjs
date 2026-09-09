import assert from 'node:assert/strict';
import test from 'node:test';
import { createCursorDiagnostics } from './cursor-diagnostics.ts';

test('cursor diagnostics retain bounded counters, not input content, and coalesce writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const diagnostics = createCursorDiagnostics(async value => saved.push(value));
  for (let i = 0; i < 100; i++) diagnostics.record('received');
  diagnostics.record('private title with spaces');
  diagnostics.record('source_generated', 70);
  diagnostics.record('source_failed', -1);
  assert.equal(saved.length, 0);
  await diagnostics.flush();
  assert.deepEqual(saved[0].counts, { received: 100, source_generated: 70 });
  assert.equal(saved.length, 1);
  assert.equal(JSON.stringify(saved).includes('private title'), false);
});

test('diagnostic write failure cannot throw into input delivery', async () => {
  const diagnostics = createCursorDiagnostics(async () => { throw new Error('disk unavailable'); });
  diagnostics.record('render_failed');
  await assert.doesNotReject(diagnostics.flush());
  assert.equal(diagnostics.snapshot().counts.render_failed, 1);
});
