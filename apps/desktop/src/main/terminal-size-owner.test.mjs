// Terminal size ownership on the wire: remote calls claim per connection, and
// the relay tells each phone whether IT owns the size.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';
import { TERMINAL_SIZE_OWNER_EVENT } from '../shared/terminal-size-owner.ts';

function fakeTerminals(ensured) {
  const resizes = [];
  return {
    resizes,
    ensure: async () => ensured,
    write() {},
    resize: (...args) => resizes.push(args),
  };
}

test('remote resize claims and releases under the relay connection id, never a client-sent one', async () => {
  const terminals = fakeTerminals({ id: 't', replay: '' });
  const phoneA = createRemoteMethods({ host: {}, terminals }, { connectionId: () => 'leg-a' });
  const phoneB = createRemoteMethods({ host: {}, terminals }, { connectionId: () => 'leg-b' });
  await phoneA.termResize(['t', 50, 20, true]);
  await phoneB.termResize(['t', 40, 30, true]);
  await phoneB.termResize(['t', 0, 0, true]);
  await phoneA.termResize(['t', 120, 40, false]);
  await phoneA.termResize(['t', 120, 40]);
  assert.deepEqual(terminals.resizes, [
    ['t', 50, 20, 'leg-a'],
    ['t', 40, 30, 'leg-b'],
    ['t', 0, 0, 'leg-b'],
    ['t', 120, 40, ''],
    ['t', 120, 40, ''],
  ]);
});

test('a terminal attach tells the phone whether it owns the PTY size', async () => {
  const owned = fakeTerminals({ id: 't', replay: 'x', sizeOwner: { cols: 50, rows: 20, owner: 'leg-a' } });
  const owner = await createRemoteMethods({ host: {}, terminals: owned }, { connectionId: () => 'leg-a' }).termEnsure([
    't',
  ]);
  assert.deepEqual(owner, { id: 't', replay: 'x', sizeOwner: { cols: 50, rows: 20, own: true } });
  const other = await createRemoteMethods({ host: {}, terminals: owned }, { connectionId: () => 'leg-b' }).termEnsure([
    't',
  ]);
  assert.deepEqual(other.sizeOwner, { cols: 50, rows: 20, own: false });
  const free = fakeTerminals({ id: 't', replay: 'x' });
  assert.deepEqual(await createRemoteMethods({ host: {}, terminals: free }, {}).termEnsure(['t']), {
    id: 't',
    replay: 'x',
  });
});

test('relay push tells the owning phone own=true and every other terminal reader own=false', (t) => {
  const listeners = new Set();
  const phoneA = { lanes: new Set(['terminal']) };
  const phoneB = { lanes: new Set(['terminal']) };
  const idle = { lanes: new Set(['state']) };
  const clients = new Map([
    ['leg-a', phoneA],
    ['leg-b', phoneB],
    ['leg-idle', idle],
  ]);
  const frames = [];
  const push = createRelayPushLanes({
    clients,
    subscribeDesktopEvents: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    broadcastEncrypted: (payload, droppable, include) =>
      frames.push({ payload, droppable, to: [...clients.values()].filter((state) => include?.(state) ?? true) }),
  });
  t.after(() => push.dispose());
  const emit = (value) => {
    for (const listener of listeners) listener({ name: TERMINAL_SIZE_OWNER_EVENT, value });
  };

  emit({ id: 't', cols: 50, rows: 20, owner: 'leg-a' });
  const delivered = (own) => frames.filter((frame) => frame.payload.payload.own === own);
  assert.equal(frames[0].payload.event, 'termSizeOwner');
  assert.deepEqual(
    delivered(true).map((frame) => frame.to),
    [[phoneA]]
  );
  assert.deepEqual(
    delivered(false).map((frame) => frame.to),
    [[phoneB]]
  );
  assert.deepEqual(frames[0].payload.payload, { id: 't', cols: 50, rows: 20, own: true });
  assert.equal(
    frames.every((frame) => frame.droppable === false),
    true,
    'ownership changes are never dropped'
  );

  // Nobody owns the size any more: all readers hear own=false with a zero grid.
  frames.length = 0;
  emit({ id: 't', cols: 0, rows: 0, owner: '' });
  assert.deepEqual(
    delivered(true).map((frame) => frame.to),
    [[]]
  );
  assert.deepEqual(
    delivered(false).map((frame) => frame.to),
    [[phoneA, phoneB]]
  );
});
