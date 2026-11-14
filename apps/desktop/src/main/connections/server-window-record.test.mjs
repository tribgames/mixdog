import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerWindowRecord, createServerWindows, openEnvSshTarget } from './server-window-record.ts';

const fakeCore = (answers = {}) => {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push([method, params]);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

test('a record asks this PC’s core where its server listens, every time', async () => {
  const core = fakeCore({ 'connections/endpoint': { url: 'ws://127.0.0.1:4001/', token: 't', serverInstanceId: 'i' } });
  const record = createServerWindowRecord({ id: 'srv', kind: 'ssh', name: 'Box' }, core);
  assert.deepEqual(await record.endpoint(), { url: 'ws://127.0.0.1:4001/', token: 't' });
  await record.endpoint();
  assert.deepEqual(core.calls, [
    ['connections/endpoint', { connectionId: 'srv' }],
    ['connections/endpoint', { connectionId: 'srv' }],
  ]);
  assert.deepEqual([record.id, record.kind, record.name], ['srv', 'ssh', 'Box']);
});

test('an endpoint answer without a url or token is an error, not a dial', async () => {
  const record = createServerWindowRecord({ id: 'srv', kind: 'ssh', name: 'Box' }, fakeCore({ 'connections/endpoint': { url: '', token: 't' } }));
  await assert.rejects(record.endpoint(), /no endpoint/);
});

function windowsFixture(options = {}) {
  const core = fakeCore({ 'connections/endpoint': { url: 'ws://server/', token: 'server-token', serverInstanceId: 'i' } });
  const shown = [];
  const windows = createServerWindows({
    core,
    showWindow: async (record) => {
      shown.push(record.id);
      if (options.fail) throw new Error('no window');
    },
    localEndpoint: async () => ({ url: 'ws://local/', token: 'local-token' }),
  });
  return { windows, shown, core };
}

test('host/window/open makes one record per server and shows its window each time', async () => {
  const { windows, shown } = windowsFixture();
  assert.equal(await windows.open({ connectionId: 'srv', kind: 'ssh', name: 'Box' }), true);
  const first = windows.get('srv');
  assert.ok(first);
  assert.equal(await windows.open({ connectionId: 'srv', kind: 'ssh', name: 'Box' }), true);
  assert.equal(windows.get('srv'), first);
  assert.deepEqual(shown, ['srv', 'srv']);
  windows.release('srv');
  assert.equal(windows.get('srv'), undefined);
});

test('a window that could not be made leaves no record and rejects', async () => {
  const { windows } = windowsFixture({ fail: true });
  await assert.rejects(windows.open({ connectionId: 'srv', kind: 'ssh', name: 'Box' }), /no window/);
  assert.equal(windows.get('srv'), undefined);
});

test('a server window gets the server’s core as primary and this PC’s as pc, both under its role', async () => {
  const { windows } = windowsFixture();
  await windows.open({ connectionId: 'srv', kind: 'ssh', name: 'Box' });
  assert.deepEqual(await windows.endpointsFor('srv'), [
    { slot: 'primary', url: 'ws://server/', token: 'server-token', target: 'server', role: 'server:srv' },
    { slot: 'pc', url: 'ws://local/', token: 'local-token', target: 'local', role: 'server:srv' },
  ]);
  assert.deepEqual(await windows.endpointsFor('local'), [
    { slot: 'primary', url: 'ws://local/', token: 'local-token', target: 'local', role: 'main' },
  ]);
  await assert.rejects(windows.endpointsFor('other'), /not open/);
});

test('MIXDOG_SSH_TARGET opens the target through the core and reports a refusal by its code', async () => {
  const ok = fakeCore({ 'connections/ssh/openEphemeral': { ok: true, host: {} } });
  await openEnvSshTarget(ok, 'root@box');
  assert.deepEqual(ok.calls, [['connections/ssh/openEphemeral', { target: 'root@box', name: 'root@box' }]]);
  const refused = fakeCore({ 'connections/ssh/openEphemeral': { ok: false, failure: { kind: 'auth', code: 'auth-failed' } } });
  await assert.rejects(openEnvSshTarget(refused, 'root@box'), /root@box could not be opened: auth-failed/);
  const unreachable = fakeCore({ 'connections/ssh/openEphemeral': new Error('core down') });
  await assert.rejects(openEnvSshTarget(unreachable, 'root@box'), /core down/);
});
