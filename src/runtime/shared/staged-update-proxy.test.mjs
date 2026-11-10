import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const spawned = [];
class FakeChild extends EventEmitter {
  unref() {}
}
mock.module('node:child_process', {
  namedExports: {
    ...createRequire(import.meta.url)('node:child_process'),
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.emit('exit', 1);
        child.emit('close', 1);
      });
      return child;
    },
  },
});

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-staged-proxy-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { adoptSystemProxy, attachSystemProxyResolver, HANDOFF_VAR } = await import('./llm/system-proxy.mjs');
const { runStagedInstall, spawnStagedInstall } = await import('./staged-update.mjs');
const { buildShellSpawnEnv } = await import('../agent/orchestrator/tools/builtin/bash-tool/spawn-env.mjs');

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY'];
// `npm test` exports its own config (npm_config_noproxy='' among it) to the
// runner; clear it so only what the update path adds is observed.
const NPM_PROXY_VARS = ['npm_config_https_proxy', 'npm_config_proxy', 'npm_config_noproxy'];
for (const name of NPM_PROXY_VARS) delete process.env[name];

test('update children get the system proxy privately and agent shells still do not', async (t) => {
  t.after(() => adoptSystemProxy({}, { platform: 'linux' }));
  for (const name of [...PROXY_VARS, HANDOFF_VAR, 'MIXDOG_DISABLE_STAGED_INSTALL']) delete process.env[name];
  const envBefore = JSON.stringify(process.env);
  adoptSystemProxy(
    {},
    {
      platform: 'win32',
      reader: () => ({ proxyEnable: '0x1', proxyServer: '127.0.0.1:7890', proxyOverride: 'exact.test;*.corp.test' }),
      apply: () => {},
    }
  );

  // The update worker: the private handoff, nothing standard.
  assert.equal(spawnStagedInstall('9.9.9'), true);
  const worker = spawned.find((call) => call.args[0].endsWith('staged-install-worker.mjs'));
  assert.deepEqual(JSON.parse(worker.options.env[HANDOFF_VAR]).proxy, {
    https: 'http://127.0.0.1:7890',
    http: 'http://127.0.0.1:7890',
  });
  for (const name of PROXY_VARS) assert.equal(worker.options.env[name], undefined, name);

  // npm: its registry's route as its own settings, scoped to that one spawn,
  // and no handoff. npm is asked for its registry (here it cannot say).
  await runStagedInstall('9.9.8');
  assert.ok(spawned.some((call) => call.args.slice(1).join(' ') === 'config get registry'));
  const npm = spawned.find((call) => call.args.includes('install'));
  assert.equal(npm.options.env.npm_config_https_proxy, 'http://127.0.0.1:7890');
  assert.equal(npm.options.env.npm_config_proxy, 'http://127.0.0.1:7890');
  const noproxy = npm.options.env.npm_config_noproxy.split(',');
  for (const entry of ['localhost', '127.0.0.1', '::1', '.local']) assert.ok(noproxy.includes(entry), entry);
  for (const name of [...PROXY_VARS, HANDOFF_VAR]) assert.equal(npm.options.env[name], undefined, name);

  // This process's env, and so an agent shell's, stays untouched.
  assert.equal(JSON.stringify(process.env), envBefore);
  const shellEnv = buildShellSpawnEnv(process.cwd());
  for (const name of [...PROXY_VARS, HANDOFF_VAR, ...NPM_PROXY_VARS]) {
    assert.equal(shellEnv[name], undefined, name);
  }
});

test('with the desktop attached, npm follows Chromium’s answer for its registry, asked once', async (t) => {
  t.after(() => adoptSystemProxy({}, { platform: 'linux' }));
  adoptSystemProxy({}, { platform: 'darwin', apply: () => {} });
  const asked = [];
  attachSystemProxyResolver(async (origin) => {
    asked.push(origin);
    return origin === 'https://registry.npmjs.org' ? 'PROXY npm-proxy.corp:8080' : 'DIRECT';
  });
  spawned.length = 0;
  await runStagedInstall('9.9.6');
  await runStagedInstall('9.9.5');
  const installs = spawned.filter((call) => call.args.includes('install'));
  assert.equal(installs.length, 2);
  for (const npm of installs) assert.equal(npm.options.env.npm_config_https_proxy, 'http://npm-proxy.corp:8080');
  assert.deepEqual(asked, ['https://registry.npmjs.org']);
});

test('with no system proxy decision the update children get nothing extra', async () => {
  adoptSystemProxy({}, { platform: 'linux' });
  spawned.length = 0;
  await runStagedInstall('9.9.7');
  const npm = spawned.find((call) => call.args.includes('install'));
  assert.equal(npm.options.env.npm_config_https_proxy, undefined);
  assert.equal(npm.options.env.npm_config_noproxy, undefined);
});

after(() => rmSync(dataDir, { recursive: true, force: true }));
