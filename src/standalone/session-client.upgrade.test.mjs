import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { drainDeferral } from './daemon-drain-policy.mjs';
import { ensureDaemon, forceDaemonUpgrade } from './session-client.mjs';
import { createSessionTransport } from './session-transport.mjs';
import { SESSION_PROTOCOL, SESSION_REVISION, runtimeVersion } from './session-wire.mjs';

// Old daemon stub: reports version 0.0.0 until /upgrade, then (after
// `yieldAfterMs`) reports the current build so the client sees it yield.
async function stubOldDaemon(context, { yieldAfterMs = 150 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-upgrade-'));
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const previous = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  const state = { upgrades: [], upgradedAt: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const json = (value) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url.startsWith('/upgrade')) {
        state.upgrades.push(JSON.parse(body));
        state.upgradedAt = Date.now();
        return json({ accepted: true });
      }
      const yielded = state.upgradedAt && Date.now() - state.upgradedAt >= yieldAfterMs;
      return json({
        status: 'ok',
        pid: process.pid,
        protocol: SESSION_PROTOCOL,
        revision: SESSION_REVISION,
        version: yielded ? runtimeVersion() : '0.0.0',
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(
    join(runtimeRoot, 'daemon.json'),
    JSON.stringify({
      pid: process.pid,
      endpoints: { session: { port: server.address().port, token: 'secret' } },
    })
  );
  context.after(() => {
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return state;
}

test('ensureDaemon reports onUpgradeWait waiting then done, swallowing callback errors', async (context) => {
  const state = await stubOldDaemon(context);
  const events = [];
  await ensureDaemon({
    attempts: 0,
    onUpgradeWait: (info) => {
      events.push(info);
      throw new Error('callback failure is swallowed');
    },
  });
  assert.deepEqual(events, [
    { state: 'waiting', fromVersion: '0.0.0', toVersion: runtimeVersion() },
    { state: 'done', fromVersion: '0.0.0', toVersion: runtimeVersion() },
  ]);
  assert.equal(state.upgrades[0].force, undefined);
});

test('a drain longer than the ready timeout still attaches once the older daemon yields', async (context) => {
  await stubOldDaemon(context, { yieldAfterMs: 300 });
  const discovery = await ensureDaemon({ attempts: 0, readyTimeoutMs: 100 });
  assert.equal(Number(discovery.pid), process.pid);
});

test('forceDaemonUpgrade posts force:true and returns accepted', async (context) => {
  const state = await stubOldDaemon(context);
  assert.equal(await forceDaemonUpgrade(), true);
  assert.deepEqual(state.upgrades[0], {
    protocol: SESSION_PROTOCOL,
    revision: SESSION_REVISION,
    version: runtimeVersion(),
    force: true,
  });
});

test('forceDaemonUpgrade returns false without a daemon', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-upgrade-none-'));
  const previous = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = root;
  context.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(await forceDaemonUpgrade(), false);
});

test('upgrade route passes force through and still rejects non-newer force requests', async () => {
  const seen = [];
  const transport = createSessionTransport({
    handleCall: async () => null,
    clientGraceMs: 5,
    onClientsEmpty: () => {},
    onUpgradeRequested: (details) => seen.push(details),
  });
  const discovery = await transport.start();
  const post = (body) =>
    fetch(`http://127.0.0.1:${discovery.port}/upgrade`, {
      method: 'POST',
      headers: { 'x-mixdog-daemon-token': discovery.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const newer = { protocol: SESSION_PROTOCOL, revision: SESSION_REVISION + 1, version: runtimeVersion() };
    assert.equal((await post({ ...newer, force: true })).status, 200);
    assert.equal((await post(newer)).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      seen.map((d) => d.force),
      [true, false]
    );
    const stale = { protocol: SESSION_PROTOCOL, revision: SESSION_REVISION, version: runtimeVersion(), force: true };
    assert.equal((await post(stale)).status, 409);
  } finally {
    await transport.stop();
  }
});

test('a forced replacement does not defer for busy work', () => {
  const busy = { activeCalls: 1, queuedCalls: 1, busySessions: 2, busyMemoryAgents: 1 };
  assert.equal(drainDeferral(busy), 'calls');
  assert.equal(drainDeferral({ ...busy, activeCalls: 0, queuedCalls: 0 }), 'busy');
  assert.equal(drainDeferral(busy, { force: true }), null);
});
