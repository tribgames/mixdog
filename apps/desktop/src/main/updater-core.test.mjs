import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
import { CoreControlError, createCoreControl, createCoreUpdateGate, parseDaemonDiscovery } from './updater-core.ts';

/** A control listener stand-in: records requests, answers from a mutable state. */
async function fakeCore(initial = {}) {
  const state = {
    state: 'serving',
    hold: false,
    running: [],
    drain: null,
    ...initial,
  };
  const requests = [];
  const refuse = {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      const answer = (status, value) => {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      };
      if (refuse[req.url]) return answer(409, { error: refuse[req.url] });
      if (req.url === '/mgmt/status') return answer(200, state);
      if (req.url === '/mgmt/hold') state.hold = body.on;
      if (req.url === '/mgmt/stop') {
        state.state = 'draining';
        state.drain = { drainId: 'd1', reason: 'update', confirmToken: 'tok', releasing: false };
      }
      if (req.url === '/mgmt/cancelDrain') {
        state.state = 'serving';
        state.drain = null;
      }
      answer(200, state);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  const dir = makeTempDirSync('updater-core');
  const discoveryPath = join(dir, 'daemon.json');
  writeFileSync(
    discoveryPath,
    JSON.stringify({
      pid: 4242,
      endpoints: { session: { port: server.address().port, token: 'secret' } },
      core: { version: '1.4.6', build: 'b', instanceId: 'i', processStartTime: 't', state: 'serving', rpc: { port: 1 }, control: { port: server.address().port } },
    })
  );
  return { state, requests, refuse, discoveryPath };
}

const work = (title) => ({ kind: 'turn', threadId: 't', turnId: 'u', title });

test('the control client sends the discovery token and reads the status', async () => {
  const core = await fakeCore({ running: [work('a')] });
  const control = createCoreControl({ discoveryPath: core.discoveryPath });
  const read = await control.status();
  assert.equal(read.status.running[0].title, 'a');
  assert.equal(read.discovery.pid, 4242);
  assert.deepEqual(core.requests.map((r) => [r.method, r.path, r.auth]), [['GET', '/mgmt/status', 'Bearer secret']]);
  await control.stop('whenIdle');
  assert.deepEqual(core.requests.at(-1).body, { mode: 'whenIdle', reason: 'update' });
  await control.stop('abortConfirmed', 'tok');
  assert.deepEqual(core.requests.at(-1).body, { mode: 'abortConfirmed', reason: 'update', confirmToken: 'tok' });
});

test('no discovery file, or nothing listening, is no core; a refusal is an error with its code', async () => {
  const none = createCoreControl({ discoveryPath: join(makeTempDirSync('updater-core-none'), 'daemon.json') });
  assert.equal(await none.status(), null);
  await none.hold(true);
  const core = await fakeCore();
  core.refuse['/mgmt/stop'] = { code: 'confirmationInvalid', message: 'the token is stale' };
  const control = createCoreControl({ discoveryPath: core.discoveryPath });
  await assert.rejects(control.stop('abortConfirmed', 'x'), (error) => error instanceof CoreControlError && error.code === 'confirmationInvalid' && error.status === 409);
});

test('hold: idle keeps the hold, busy releases it and reports the count', async () => {
  const idle = await fakeCore();
  const gate = createCoreUpdateGate({ control: createCoreControl({ discoveryPath: idle.discoveryPath }), waitExit: async () => {} });
  assert.equal(await gate.hold(), 0);
  assert.equal(idle.state.hold, true);
  const busy = await fakeCore({ running: [work('a'), work('b')] });
  const busyGate = createCoreUpdateGate({ control: createCoreControl({ discoveryPath: busy.discoveryPath }), waitExit: async () => {} });
  assert.equal(await busyGate.hold(), 2);
  assert.equal(busy.state.hold, false);
  assert.equal(await busyGate.running(), 2);
});

test('stop winds down, aborts only after confirmation, and returns once the OS reports the exit', async () => {
  const core = await fakeCore({ running: [work('a')] });
  const waited = [];
  const gate = createCoreUpdateGate({
    control: createCoreControl({ discoveryPath: core.discoveryPath }),
    waitExit: async (identity) => {
      waited.push(identity);
    },
  });
  await gate.stop({ abort: false });
  assert.deepEqual(core.requests.filter((r) => r.path === '/mgmt/stop').map((r) => r.body.mode), ['whenIdle']);
  assert.deepEqual(waited.map((w) => [w.pid, w.processStartTime]), [[4242, 't']], 'waited on the process identity');

  const confirmed = await fakeCore({ running: [work('a')] });
  const confirmedGate = createCoreUpdateGate({
    control: createCoreControl({ discoveryPath: confirmed.discoveryPath }),
    waitExit: async () => {},
  });
  await confirmedGate.stop({ abort: true });
  const stops = confirmed.requests.filter((r) => r.path === '/mgmt/stop').map((r) => r.body);
  assert.deepEqual(stops, [
    { mode: 'whenIdle', reason: 'update' },
    { mode: 'abortConfirmed', reason: 'update', confirmToken: 'tok' },
  ]);
});

test('stop with no core running does nothing; release cancels a drain that has not reached its release', async () => {
  const waitExit = async () => {};
  const none = createCoreUpdateGate({ control: createCoreControl({ discoveryPath: join(makeTempDirSync('updater-core-none2'), 'daemon.json') }), waitExit });
  await none.stop({ abort: true });
  const core = await fakeCore();
  const gate = createCoreUpdateGate({ control: createCoreControl({ discoveryPath: core.discoveryPath }), waitExit });
  await gate.hold();
  await gate.stop({ abort: false });
  assert.equal(core.state.state, 'draining');
  await gate.release();
  assert.equal(core.state.state, 'serving');
  assert.equal(core.state.hold, false);
});

const discoveryJson = (overrides = {}) =>
  JSON.stringify({
    pid: 4242,
    endpoints: { session: { port: 41002, token: 'session-secret-1' } },
    core: {
      version: '1.4.6',
      build: 'b',
      instanceId: 'i-1',
      processStartTime: 't',
      state: 'serving',
      rpc: { port: 41001 },
      control: { port: 41002 },
      ...overrides,
    },
  });

test('the discovery file reads the control port, the serving RPC port, token and identity', () => {
  const expected = {
    rpcPort: 41001,
    controlPort: 41002,
    token: 'session-secret-1',
    pid: 4242,
    instanceId: 'i-1',
    processStartTime: 't',
    state: 'serving',
    version: '1.4.6',
    build: 'b',
  };
  assert.deepEqual(parseDaemonDiscovery(discoveryJson()), expected);
  assert.deepEqual(parseDaemonDiscovery(JSON.parse(discoveryJson())), expected);
  // A draining core keeps its control listener and has no RPC listener.
  const draining = parseDaemonDiscovery(discoveryJson({ state: 'draining', rpc: undefined }));
  assert.equal(draining.rpcPort, null);
  assert.equal(draining.controlPort, 41002);
});

test('the discovery file is rejected when incomplete or malformed', () => {
  assert.equal(parseDaemonDiscovery('not json'), null);
  assert.equal(parseDaemonDiscovery(null), null);
  assert.equal(parseDaemonDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), pid: 0 })), null);
  assert.equal(parseDaemonDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), core: undefined })), null);
  assert.equal(parseDaemonDiscovery(discoveryJson({ control: { port: 70000 } })), null);
  assert.equal(
    parseDaemonDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), endpoints: { session: { port: 1 } } })),
    null
  );
  // A 1.4.5 daemon's file has no core block: it is not a 1.4.6 discovery document.
  assert.equal(parseDaemonDiscovery(JSON.stringify({ pid: 9, endpoints: { session: { port: 4100, token: 't' } } })), null);
});
