import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { adoptSystemProxy, HANDOFF_VAR } from '../runtime/shared/llm/system-proxy.mjs';
import { spawnDaemonCandidate } from './session-client.mjs';

// A stand-in daemon: boot diagnostics on fd 2, the same ready handshake the
// real daemon sends, then a known exit AFTER the launcher detached.
const STUB_DAEMON = `
process.stderr.write('stub daemon boot diagnostic\\n');
process.send?.({ type: 'ready' });
setTimeout(() => { process.exit(7); }, 150);
`;

test('the session launcher records the daemon exit and mirrors boot stderr once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const previous = {
    dataDir: process.env.MIXDOG_DATA_DIR,
    runtimeRoot: process.env.MIXDOG_RUNTIME_ROOT,
    execArgv: process.execArgv,
  };
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  // fork() inherits the runner's execArgv; the stub must run as a plain script.
  process.execArgv = [];
  t.after(() => {
    process.execArgv = previous.execArgv;
    if (previous.dataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous.dataDir;
    if (previous.runtimeRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previous.runtimeRoot;
  });

  const entry = join(root, 'stub-daemon.mjs');
  writeFileSync(entry, STUB_DAEMON);
  const logs = [];
  let resolveExit;
  const exitLogged = new Promise((resolve) => {
    resolveExit = resolve;
  });
  await spawnDaemonCandidate({
    cwd: root,
    timeoutMs: 20_000,
    entry,
    log: (line) => {
      logs.push(line);
      if (line.startsWith('daemon exit ')) resolveExit(line);
    },
  });
  assert.ok(
    logs.some((line) => line.startsWith('daemon ready at=')),
    'the ready handshake is logged'
  );

  const timeout = new AbortController();
  const exitLine = await Promise.race([exitLogged, delay(20_000, null, { signal: timeout.signal })]).finally(() =>
    timeout.abort()
  );
  assert.ok(exitLine, `the launcher logged the daemon exit: ${logs.join(' | ')}`);
  assert.match(exitLine, /code=7 signal=- ready=1 uptimeMs=\d+/);

  // Boot diagnostics survive the switch from a pipe to a capture file, once.
  assert.equal(logs.filter((line) => line.includes('stub daemon boot diagnostic')).length, 1);

  const captureDir = join(dataDir, 'daemon-crash');
  const recordName = readdirSync(captureDir).find((name) => name.endsWith('.json'));
  assert.ok(recordName, `a lifecycle record is persisted: ${readdirSync(captureDir).join(', ')}`);
  const record = JSON.parse(readFileSync(join(captureDir, recordName), 'utf8'));
  assert.equal(record.launcher, 'session-client');
  assert.equal(record.launcherPid, process.pid);
  assert.equal(record.ready, true);
  assert.equal(record.exitCode, 7);
  assert.equal(record.exitSignal, null);
  assert.ok(record.pid > 0);
  assert.ok(record.spawnedAt && record.readyAt && record.exitedAt);
  assert.match(exitLine, new RegExp(`pid=${record.pid}\\b`));
});

/** Fork the stub daemon from a launcher with `env`; the proxy-related env it saw. */
async function probeDaemonEnv(t, { env: launcherEnv = {}, spawnEnv = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-spawn-proxy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
    'MIXDOG_SYSTEM_PROXY',
    HANDOFF_VAR,
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
  ];
  const saved = keys.map((key) => [key, process.env[key]]);
  const execArgv = process.execArgv;
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, launcherEnv);
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_RUNTIME_ROOT = join(root, 'runtime');
  mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
  mkdirSync(process.env.MIXDOG_RUNTIME_ROOT, { recursive: true });
  process.execArgv = [];
  t.after(() => {
    process.execArgv = execArgv;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const out = join(root, 'env.json');
  const entry = join(root, 'env-daemon.mjs');
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';
const seen = {};
for (const key of ${JSON.stringify(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'MIXDOG_SYSTEM_PROXY', HANDOFF_VAR])}) seen[key] = process.env[key];
writeFileSync(${JSON.stringify(out)}, JSON.stringify(seen));
process.send?.({ type: 'ready' });
setTimeout(() => process.exit(0), 150);
`
  );
  // The stub holds its cwd and capture file until it exits.
  const exited = Promise.withResolvers();
  await spawnDaemonCandidate({
    cwd: root,
    timeoutMs: 20_000,
    entry,
    log: (line) => {
      if (line.startsWith('daemon exit ')) exited.resolve();
    },
    spawnEnv,
  });
  // The launcher unrefs the stub after ready: a timer keeps this test alive.
  const timeout = new AbortController();
  await Promise.race([exited.promise, delay(20_000, null, { signal: timeout.signal })]).finally(() => timeout.abort());
  return JSON.parse(readFileSync(out, 'utf8'));
}

const DESKTOP_HANDOFF = JSON.stringify({ proxy: { https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890' } });

test('a system proxy resolved for a desktop fork reaches the daemon only as the private handoff', async (t) => {
  const env = await probeDaemonEnv(t, { spawnEnv: async () => ({ [HANDOFF_VAR]: DESKTOP_HANDOFF }) });
  assert.equal(env[HANDOFF_VAR], DESKTOP_HANDOFF);
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'MIXDOG_SYSTEM_PROXY']) {
    assert.equal(env[name], undefined, name);
  }
});

test('the system proxy a CLI settled reaches the daemon it starts as the private handoff', async (t) => {
  adoptSystemProxy(
    {},
    {
      platform: 'win32',
      reader: () => ({ proxyEnable: '0x1', proxyServer: '127.0.0.1:7890', proxyOverride: '<local>;*.corp.test' }),
      apply: () => {},
    }
  );
  t.after(() => adoptSystemProxy({}, { platform: 'linux' }));
  const env = await probeDaemonEnv(t);
  assert.deepEqual(JSON.parse(env[HANDOFF_VAR]), {
    proxy: { https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890' },
    bypass: { hosts: [], suffixes: ['corp.test'] },
  });
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
    assert.equal(env[name], undefined, name);
  }
});

test('the user’s own proxy variables still reach the daemon as before, with no handoff', async (t) => {
  const env = await probeDaemonEnv(t, { env: { HTTPS_PROXY: 'http://mine.test:1', NO_PROXY: 'corp.test' } });
  assert.equal(env.HTTPS_PROXY, 'http://mine.test:1');
  assert.equal(env.NO_PROXY, 'corp.test');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env[HANDOFF_VAR], undefined);
});
