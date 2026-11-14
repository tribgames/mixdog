import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOST_SCREEN_INDICATOR, HOST_SCREEN_INDICATOR_STOP, registerScreenIndicatorHost } from './screen-indicator.ts';

function rig() {
  const handlers = new Map();
  const notified = [];
  const closers = [];
  const shown = [];
  const connection = {
    handleRequest: (method, handler) => handlers.set(method, handler),
    notify: (method, params) => notified.push([method, params]),
    onClose: (listener) => closers.push(listener),
  };
  const closeAll = registerScreenIndicatorHost(connection, (options) => {
    const entry = { options, labels: [], closed: 0 };
    shown.push(entry);
    return { update: (label) => entry.labels.push(label), close: () => (entry.closed += 1) };
  });
  const call = (params) => handlers.get(HOST_SCREEN_INDICATOR)(params, new AbortController().signal);
  return { call, notified, closers, shown, closeAll };
}

test('a show opens the phones place on the pill for the display its id names', async () => {
  const { call, shown } = rig();
  assert.deepEqual(await call({ state: 'show', screenId: '2', clientLabel: 'Pixel', controlling: false }), {});
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.deviceLabel, 'Pixel');
  assert.equal(shown[0].options.displayId, 2);
});

test('a display id that is not a whole number shows the pill on the primary display', async () => {
  const { call, shown } = rig();
  await call({ state: 'show', screenId: 'a-display', clientLabel: 'P' });
  await call({ state: 'show', screenId: '007', clientLabel: 'P' });
  assert.equal(shown[0].options.displayId, undefined);
  assert.equal(shown[1].options.displayId, undefined);
});

test('the pill Stop is reported to the core once for the session it belongs to', async () => {
  const { call, shown, notified } = rig();
  await call({ state: 'show', screenId: '1', clientLabel: 'A' });
  await call({ state: 'show', screenId: '2', clientLabel: 'B' });
  shown[0].options.onStop();
  shown[1].options.onStop();
  assert.deepEqual(notified, [
    [HOST_SCREEN_INDICATOR_STOP, { screenId: '1' }],
    [HOST_SCREEN_INDICATOR_STOP, { screenId: '2' }],
  ]);
});

test('an update relabels the shown session and a hide closes it; both ignore a session that is not shown', async () => {
  const { call, shown } = rig();
  await call({ state: 'update', screenId: '1', clientLabel: 'Nobody' });
  await call({ state: 'hide', screenId: '1' });
  await call({ state: 'show', screenId: '1', clientLabel: 'A' });
  await call({ state: 'update', screenId: '1', clientLabel: 'A2', controlling: true });
  await call({ state: 'update', screenId: '1', controlling: true });
  assert.deepEqual(shown[0].labels, ['A2']);
  await call({ state: 'hide', screenId: '1' });
  await call({ state: 'hide', screenId: '1' });
  assert.equal(shown[0].closed, 1);
});

test('a second show for a display replaces the first, which is closed', async () => {
  const { call, shown } = rig();
  await call({ state: 'show', screenId: '1', clientLabel: 'A' });
  await call({ state: 'show', screenId: '1', clientLabel: 'B' });
  assert.deepEqual(
    shown.map((entry) => entry.closed),
    [1, 0]
  );
});

test('closing the connection closes every place still shown', async () => {
  const { call, shown, closers } = rig();
  await call({ state: 'show', screenId: '1', clientLabel: 'A' });
  await call({ state: 'show', screenId: '2', clientLabel: 'B' });
  for (const listener of closers) listener();
  assert.deepEqual(
    shown.map((entry) => entry.closed),
    [1, 1]
  );
});

test('params that are not a session of a known state are refused with -32602', async () => {
  const { call } = rig();
  const refused = [
    null,
    [],
    'x',
    {},
    { state: 'show' },
    { state: 'show', screenId: '' },
    { state: 'show', screenId: 'x'.repeat(129) },
    { state: 'hide', screenId: 1 },
    { state: 'open', screenId: '1' },
    { state: 'show', screenId: '1', clientLabel: 3 },
  ];
  for (const bad of refused) {
    await assert.rejects(call(bad), (error) => error.code === -32602, JSON.stringify(bad));
  }
});
