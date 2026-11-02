import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DesktopServiceClient } from './desktop-service-client.ts';

class ReadyTransport extends EventEmitter {
  postMessage(message) {
    if (message.kind === 'init') queueMicrotask(() => this.emit('message', { kind: 'ready' }));
  }

  async close() {}
}

const notice = (key, name = 'Gmail') => ({
  kind: 'desktop-event',
  name: 'desktop-notice',
  value: { key, code: 'connector-sign-in-expired', params: { name } },
});

test('service notices that arrive before any window wait for it, one per condition', async (t) => {
  const transport = new ReadyTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({ userDataPath: 'C:/tmp/mixdog', packaged: false }),
    startupTimeoutMs: 1_000,
  });
  t.after(() => client.dispose());
  await client.start();

  transport.emit('message', notice('connector-sign-in:Gmail'));
  transport.emit('message', notice('connector-sign-in:Drive', 'Drive'));
  transport.emit('message', notice('connector-sign-in:Gmail'));
  const shown = [];
  const unsubscribe = client.subscribeDesktopNotices((received) => shown.push(received.key));
  assert.deepEqual(shown, ['connector-sign-in:Drive', 'connector-sign-in:Gmail'], 'held for the first window');

  transport.emit('message', notice('connector-sign-in:Notion', 'Notion'));
  assert.deepEqual(shown.at(-1), 'connector-sign-in:Notion', 'a listening window gets it at once');
  unsubscribe();

  transport.emit('message', notice('connector-sign-in:Slack', 'Slack'));
  const next = [];
  client.subscribeDesktopNotices((received) => next.push(received.key));
  assert.deepEqual(next, ['connector-sign-in:Slack'], 'the window that opens next gets what came between');
});
