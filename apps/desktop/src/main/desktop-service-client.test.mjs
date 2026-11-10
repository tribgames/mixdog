import assert from 'node:assert/strict';
import test from 'node:test';

import { DesktopServiceClient, displayExitCode } from './desktop-service-client.ts';

const notice = (key, name = 'Gmail') => ({ key, code: 'connector-sign-in-expired', params: { name } });
const clientWith = (lanes = {}) =>
  new DesktopServiceClient({ serviceLane: { call: async () => null }, capabilityLane: {}, operationLane: {}, ...lanes });

test('service notices that arrive before any window wait for it, one per condition', async (t) => {
  const client = clientWith();
  t.after(() => client.dispose());
  client.emitDesktopEvent('desktop-notice', notice('connector-sign-in:Gmail'));
  client.emitDesktopEvent('desktop-notice', notice('connector-sign-in:Drive', 'Drive'));
  client.emitDesktopEvent('desktop-notice', notice('connector-sign-in:Gmail'));
  const shown = [];
  const unsubscribe = client.subscribeDesktopNotices((received) => shown.push(received.key));
  assert.deepEqual(shown, ['connector-sign-in:Drive', 'connector-sign-in:Gmail'], 'held for the first window');

  client.emitDesktopEvent('desktop-notice', notice('connector-sign-in:Notion', 'Notion'));
  assert.equal(shown.at(-1), 'connector-sign-in:Notion', 'a listening window gets it at once');
  unsubscribe();

  client.emitDesktopEvent('desktop-notice', notice('connector-sign-in:Slack', 'Slack'));
  const next = [];
  client.subscribeDesktopNotices((received) => next.push(received.key));
  assert.deepEqual(next, ['connector-sign-in:Slack'], 'the window that opens next gets what came between');
});

test('overlapping desktop registrations carry increasing versions', async () => {
  const seen = [];
  const client = clientWith({ serviceLane: { call: async (method, args) => (seen.push([method, args]), true) } });
  await Promise.all([client.setVisibleSessions(['a']), client.setVisibleSessions(['b'])]);
  assert.deepEqual(
    seen.map(([, args]) => args[1]),
    [1, 2]
  );
});

test('a client calls its capability, operation and service lanes and never a transport', async () => {
  const seen = [];
  const client = clientWith({
    serviceLane: { call: async (method, args) => (seen.push(['service', method, args]), 'svc') },
    capabilityLane: {
      invoke: async (capability, args, sessionId) => (seen.push(['capability', capability, args, sessionId]), { value: 1, snapshot: null }),
      read: async (requests) => (seen.push(['read', requests]), []),
    },
    operationLane: { invoke: async (method, args) => (seen.push(['operation', method, args]), 'op') },
  });
  assert.equal(await client.listSessions(), 'svc');
  await client.invokeCapability('setModel', ['m'], 's1');
  await client.readCapabilities([{ capability: 'listPresets' }]);
  assert.equal(await client.invokeDesktopOperation('gitStatus', ['/r']), 'op');
  assert.deepEqual(seen, [
    ['service', 'listSessions', []],
    ['capability', 'setModel', ['m'], 's1'],
    ['read', [{ capability: 'listPresets' }]],
    ['operation', 'gitStatus', ['/r']],
  ]);
});

test('a disposed client refuses to start', async () => {
  const client = clientWith();
  await client.dispose();
  await assert.rejects(client.start(), /disposed/);
});

test('displayExitCode names OOM exits and keeps the number', () => {
  assert.equal(displayExitCode(0xe0000008), '0xE0000008 (out of memory)');
  assert.equal(displayExitCode(-536870904), '-536870904 (out of memory)');
});
