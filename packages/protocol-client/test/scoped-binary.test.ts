// Scoped-feed notifications and the X17 binary lane, over the mock transport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ClientEvent } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

test('scoped-feed notifications arrive as ordered notification events; sendBinary writes a binary frame', async () => {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const events: ClientEvent[] = [];
  client.on((e) => events.push(e));

  const feed = (method: string, params: unknown, id: string, seq: number) => conn.serverSend({ method, params, feed: { id, epoch: 'e', seq } });
  feed('fs/changed', { watchId: 'w', changedPaths: ['a'] }, 'fs:w', 0);
  feed('system/ports/updated', { section: 'ports', key: null, revision: 1, value: [] }, 'ports', 0);
  feed('fs/changed', { watchId: 'w', changedPaths: ['b'] }, 'fs:w', 1);
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  const got = events.filter((e) => e.type === 'notification').map((e) => (e as { notification: { method: string; feed?: { id: string } } }).notification);
  assert.deepEqual(got.map((n) => `${n.feed?.id}:${n.method}`), ['fs:w:fs/changed', 'ports:system/ports/updated', 'fs:w:fs/changed']);

  const frame = new Uint8Array(20);
  client.sendBinary(frame);
  assert.deepEqual(conn.binary, [frame]);
  assert.throws(() => client.sendBinary(new Uint8Array(options.initializeResult.limits.maxMediaFrameBytes + 17)), /protocolViolation|maxMediaFrameBytes/);

  feed('fs/changed', { watchId: 'w', changedPaths: ['c'] }, 'fs:w', 5);
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  assert.equal(conn.clientClose?.code, 1002);
});
