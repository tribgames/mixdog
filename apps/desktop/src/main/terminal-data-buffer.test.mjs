import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalDataBufferer } from './terminal-data-buffer.ts';

test('idle remote output delivers immediately while a continued burst coalesces', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delivered = [];
  const buffer = new TerminalDataBufferer((event) => delivered.push(event), { delayMs: 16, leadingEdge: true });
  buffer.push({ id: 'term', data: '한' });
  assert.deepEqual(delivered, [{ id: 'term', data: '한' }]);
  buffer.push({ id: 'term', data: '글' });
  buffer.push({ id: 'term', data: '\x1b[31m' });
  assert.equal(delivered.length, 1);
  t.mock.timers.tick(16);
  assert.deepEqual(delivered[1], { id: 'term', data: '글\x1b[31m' });
  buffer.release('term');
  buffer.push({ id: 'term', data: 'new session' });
  assert.equal(delivered[2].data, 'new session');
  buffer.dispose();
});

test('leading-edge delivery still respects the acknowledgement window and resumes producers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delivered = [];
  const flow = [];
  const buffer = new TerminalDataBufferer((event) => delivered.push(event), { delayMs: 16, leadingEdge: true }, 4, {
    pause: (id) => flow.push(['pause', id]),
    resume: (id) => flow.push(['resume', id]),
  });
  buffer.push({ id: 'term', data: '1234' });
  buffer.push({ id: 'term', data: '56' });
  t.mock.timers.tick(16);
  assert.deepEqual(delivered, [{ id: 'term', data: '1234' }]);
  assert.deepEqual(flow, [['pause', 'term']]);
  buffer.acknowledge('term', 4);
  assert.equal(delivered[1].data, '56');
  buffer.acknowledge('term', 2);
  assert.deepEqual(flow, [
    ['pause', 'term'],
    ['resume', 'term'],
  ]);
  buffer.dispose();
});

test('ordinary desktop buffering keeps its existing delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delivered = [];
  const buffer = new TerminalDataBufferer((event) => delivered.push(event), 5);
  buffer.push({ id: 'term', data: 'a' });
  assert.equal(delivered.length, 0);
  t.mock.timers.tick(5);
  assert.equal(delivered[0].data, 'a');
  buffer.dispose();
});

test('a reset drops the output not yet sent and delivers the screen at once, counted in flight until acknowledged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delivered = [];
  const buffer = new TerminalDataBufferer((event) => delivered.push(event), 5, 8);
  buffer.push({ id: 'term', data: 'old' });
  buffer.reset('term', 'SCREEN');
  assert.deepEqual(delivered, [{ id: 'term', data: 'SCREEN', reset: true }]);
  t.mock.timers.tick(10);
  assert.equal(delivered.length, 1, 'the dropped output is not sent later');
  // 6 of 8 chars are in flight: only 2 more go out until the reset is acknowledged.
  buffer.push({ id: 'term', data: 'abcdef' });
  t.mock.timers.tick(10);
  assert.equal(delivered[1].data, 'ab');
  buffer.acknowledge('term', 6);
  assert.equal(delivered[2].data, 'cdef');
  buffer.dispose();
});
