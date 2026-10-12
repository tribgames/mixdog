import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { installWhatsNewAcknowledge } from './whats-new-acknowledge.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ launchRecorded = () => Promise.resolve(true) } = {}) {
  const ipc = new EventEmitter();
  const mainFrame = { name: 'main' };
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { mainFrame },
  });
  const acknowledged = [];
  installWhatsNewAcknowledge(ipc, window, {
    version: '1.1.1',
    launchRecorded,
    acknowledge: async (version) => {
      acknowledged.push(version);
    },
  });
  const send = (version, event = { sender: window.webContents, senderFrame: mainFrame }) =>
    ipc.emit(DESKTOP_IPC.acknowledgeWhatsNew, event, version);
  return { ipc, window, acknowledged, send };
}

test('the main frame of the window acknowledging the running version is accepted', async () => {
  const { acknowledged, send } = harness();
  send('1.1.1');
  await flush();
  assert.deepEqual(acknowledged, ['1.1.1']);
});

test('another window, a subframe, a destroyed window or a wrong/malformed version is ignored', async () => {
  const { window, acknowledged, send } = harness();
  send('1.1.1', { sender: { other: true }, senderFrame: window.webContents.mainFrame });
  send('1.1.1', { sender: window.webContents, senderFrame: { name: 'iframe' } });
  for (const version of ['1.1.0', '1.2.0', '', null, undefined, 111, { version: '1.1.1' }, ['1.1.1']]) send(version);
  window.destroyed = true;
  send('1.1.1');
  await flush();
  assert.deepEqual(acknowledged, []);
});

test('an acknowledgement waits for the launch record to be written', async () => {
  let recorded;
  const { acknowledged, send } = harness({
    launchRecorded: () =>
      new Promise((resolve) => {
        recorded = resolve;
      }),
  });
  send('1.1.1');
  await flush();
  assert.deepEqual(acknowledged, [], 'not before the record exists');
  recorded(true);
  await flush();
  assert.deepEqual(acknowledged, ['1.1.1']);
});

test('the listener is removed when the window closes', async () => {
  const { ipc, window, acknowledged, send } = harness();
  assert.equal(ipc.listenerCount(DESKTOP_IPC.acknowledgeWhatsNew), 1);
  window.emit('closed');
  assert.equal(ipc.listenerCount(DESKTOP_IPC.acknowledgeWhatsNew), 0);
  send('1.1.1');
  await flush();
  assert.deepEqual(acknowledged, []);
});
