// The real daemon in remote mode (MIXDOG_MODEL_PROXY=client) publishes its
// model proxy bridge in the owner-only daemon.json and keeps it on re-publish.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { ModelProxyBridgeChannel } from '../runtime/agent/orchestrator/providers/model-proxy-bridge.mjs';
import { discoveryPid } from './daemon-owner.mjs';
import { ensureDaemon } from './session-client.mjs';

function remoteDaemonFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-bridge-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    MIXDOG_MODEL_PROXY: 'client',
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    // 1 s beats: a deleted daemon.json is re-published within the test.
    MIXDOG_DAEMON_OWNER_STALE_MS: '6000',
    HOME: home,
    USERPROFILE: home,
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const previousExecArgv = process.execArgv;
  Object.assign(process.env, env);
  // fork() inherits the runner's execArgv; the daemon must run as a plain script.
  process.execArgv = [];
  const pids = new Set();
  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {}
      for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await delay(50);
    }
    process.execArgv = previousExecArgv;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });
  return { root, discoveryPath: join(root, 'runtime', 'daemon.json'), track: (pid) => pids.add(Number(pid)) };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

test('a remote-mode daemon publishes its model proxy bridge owner-only and keeps it on re-publish', async (t) => {
  const fx = remoteDaemonFixture(t);
  const daemon = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(daemon.pid);
  const record = JSON.parse(readFileSync(fx.discoveryPath, 'utf8'));
  const endpoint = record.endpoints.modelProxy;
  assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0);
  assert.match(endpoint.token, /^[0-9a-f]{64}$/);
  assert.ok(record.endpoints.session && record.endpoints.channel);
  assert.notEqual(endpoint.token, record.endpoints.session.token);

  // Authenticated, but no PC client is attached to this daemon.
  const client = new ModelProxyBridgeChannel(endpoint);
  t.after(() => client.dispose());
  assert.equal(await client.whenConnected(500), false);
  await assert.rejects(client.request({ provider: 'openai', method: 'isAvailable' }), {
    code: 'MODEL_PROXY_UNAVAILABLE',
    message: /no desktop client is connected/,
  });

  // A wrong token is refused.
  const intruder = net.connect({ host: '127.0.0.1', port: endpoint.port });
  intruder.on('error', () => {});
  await new Promise((resolve) => intruder.once('connect', resolve));
  intruder.write(`${JSON.stringify({ type: 'hello', v: 1, token: '0'.repeat(64) })}\n`);
  let answer = '';
  intruder.on('data', (chunk) => {
    answer += chunk;
  });
  await new Promise((resolve) => intruder.once('close', resolve));
  assert.match(answer, /MODEL_PROXY_BRIDGE_UNAUTHORIZED/);
  assert.doesNotMatch(answer, /"state"/);

  if (process.platform === 'win32') {
    // writeJsonAtomicSync(..., { secret: true }): a protected DACL granting
    // the current user only, nothing inherited from the runtime root.
    const sid = execFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
    })
      .trim()
      .match(/"(S-[\d-]+)"$/)[1];
    const acl = execFileSync(join(process.env.SystemRoot, 'System32', 'icacls.exe'), [fx.discoveryPath, '/q'], {
      encoding: 'utf8',
    });
    const grants = acl
      .split(/\r?\n/)
      .map((line) => line.replace(fx.discoveryPath, '').trim())
      .filter((line) => /:\(/.test(line));
    assert.equal(grants.length, 1, acl);
    assert.doesNotMatch(grants[0], /\(I\)/, acl);
    const account = execFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), { encoding: 'utf8' }).trim();
    assert.ok(
      grants[0].toLowerCase().startsWith(`${account.toLowerCase()}:`) || grants[0].startsWith(`${sid}:`),
      `${grants[0]} is not the current user`
    );
  }

  // TEMP cleanup deletes daemon.json: the re-publish keeps the bridge endpoint.
  rmSync(fx.discoveryPath);
  assert.ok(await waitFor(() => discoveryPid(fx.discoveryPath) === Number(daemon.pid)), 're-published');
  assert.deepEqual(JSON.parse(readFileSync(fx.discoveryPath, 'utf8')).endpoints.modelProxy, endpoint);
});
