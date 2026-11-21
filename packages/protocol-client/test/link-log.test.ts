// The one helper every connection line goes through: what it guarantees its callers, by construction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contained, createLinkLog, LINK_EVENTS } from '../src/link-log.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a sink that throws, rejects or is slow cannot throw into, delay or reorder its caller', async () => {
  const order: string[] = [];
  const log = createLinkLog(() => {
    order.push('sink');
    throw new Error('the sink failed');
  });
  log('link-open', {});
  order.push('caller');
  assert.deepEqual(order, ['caller'], "the caller's work comes first");
  await flush();
  assert.deepEqual(order, ['caller', 'sink']);
  contained(() => Promise.reject(new Error('rejected')))();
  await flush(); // an unhandled rejection would fail the run here
});

test('lines arrive in call order, with the fields as they were at the call, and the owner identity wins', async () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLinkLog((event, fields) => lines.push({ event, ...fields }), { link: 'window-port', window: 'w1' });
  const fields: Record<string, unknown> = { n: 1, window: 'someone-else' };
  log('link-open', fields);
  fields.n = 2;
  log('link-down', { n: 3 });
  await flush();
  assert.deepEqual(lines, [
    { event: 'link-open', n: 1, window: 'w1', link: 'window-port' },
    { event: 'link-down', n: 3, window: 'w1', link: 'window-port' },
  ]);
});

test('an event outside the vocabulary is not written', async () => {
  const lines: string[] = [];
  const log = createLinkLog((event) => lines.push(event));
  log('free text with message contents');
  log('core-link-close');
  await flush();
  assert.deepEqual(lines, ['core-link-close']);
  assert.ok(LINK_EVENTS.has('core-link-close'));
});
