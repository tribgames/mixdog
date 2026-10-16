import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  assertDebugPortAvailable,
  createIsolatedDevEnv,
  createPersistentDevEnv,
  devRendererPortFor,
  persistentDevProfileDir,
} from './dev-profile.mjs';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('./dev-profile.mjs', import.meta.url));

async function occupiedPort(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return server.address().port;
}

test('dev environment isolates every store and connection from the installed parent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-dev-env-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = {
    PATH: process.env.PATH,
    MIXDOG_HOME: 'live-home',
    MIXDOG_DATA_DIR: 'live-data',
    MIXDOG_RUNTIME_ROOT: 'live-runtime',
    MIXDOG_BRIDGE_DISCOVERY_DIR: 'live-bridges',
    MIXDOG_DESKTOP_USER_DATA: 'live-profile',
    MIXDOG_PROJECTS_FILE: 'live-projects',
    MIXDOG_RELAY_URL: 'wss://live-relay',
    MIXDOG_SUPERVISOR_PID: '1234',
    MIXDOG_DAEMON_HOST: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_RENDERER_URL: 'http://live-renderer',
    mixdog_unknown_override: 'live-override',
  };
  const original = { ...parent };
  const env = await createIsolatedDevEnv(parent, root);
  assert.deepEqual(parent, original, 'must not mutate the calling session');
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.MIXDOG_DISABLE_PROJECT_MARKERS, '1');
  const profile = env.MIXDOG_DESKTOP_USER_DATA;
  assert.equal(isAbsolute(profile), true);
  assert.equal((await stat(profile)).isDirectory(), true);
  assert.deepEqual((await readdir(profile)).sort(), ['bridges', 'data', 'home', 'runtime']);
  for (const key of [
    'MIXDOG_HOME',
    'MIXDOG_CONFIG_DIR',
    'MIXDOG_USER_DATA_BACKUP_ROOT',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
  ]) {
    const childPath = relative(profile, env[key]);
    assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), key);
    assert.notEqual(env[key], parent[key]);
  }
  for (const key of [
    'MIXDOG_RELAY_URL',
    'MIXDOG_SUPERVISOR_PID',
    'MIXDOG_DAEMON_HOST',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'mixdog_unknown_override',
  ])
    assert.equal(env[key], undefined, key);

  const second = await createIsolatedDevEnv(parent, root);
  for (const key of [
    'MIXDOG_DESKTOP_USER_DATA',
    'MIXDOG_HOME',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
  ])
    assert.notEqual(env[key], second[key], key);
});

test('kept dev profile is reused across launches and keeps its data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-dev-kept-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = { PATH: process.env.PATH, LOCALAPPDATA: root, MIXDOG_DATA_DIR: 'live-data' };
  const profile = persistentDevProfileDir('default', parent);
  assert.equal(profile, join(root, 'mixdog-dev', 'default'));
  const first = await createPersistentDevEnv(parent, profile);
  assert.equal(first.MIXDOG_DESKTOP_USER_DATA, profile);
  assert.notEqual(first.MIXDOG_DATA_DIR, 'live-data');
  await writeFile(join(first.MIXDOG_DATA_DIR, 'marker.json'), '{}');
  const second = await createPersistentDevEnv(parent, profile);
  assert.deepEqual(second, first);
  assert.equal(await readFile(join(second.MIXDOG_DATA_DIR, 'marker.json'), 'utf8'), '{}');
  for (const name of ['../live', '', '-x', 'a/b']) {
    assert.throws(() => persistentDevProfileDir(name, parent), /Profile name/, name);
  }
});

test('occupied debug port fails immediately rather than attaching to another app', async (t) => {
  const port = await occupiedPort(t);
  await assert.rejects(assertDebugPortAvailable(port), /EADDRINUSE/);
  await assert.rejects(
    exec(process.execPath, [helper, '--env-json', '--port', String(port)]),
    (error) => error.code === 1 && error.stdout === '' && /EADDRINUSE/.test(error.stderr)
  );
});

test('each debug port maps to its own fixed renderer port inside the valid range', () => {
  assert.equal(devRendererPortFor(9342), 10342);
  assert.equal(devRendererPortFor(9343), 10343);
  assert.equal(devRendererPortFor(65535), 64535);
  for (const port of [1, 9342, 64535, 64536, 65535]) {
    const renderer = devRendererPortFor(port);
    assert.ok(Number.isInteger(renderer) && renderer >= 1 && renderer <= 65535 && renderer !== port, String(port));
  }
});

test('debug port validation rejects invalid ports and permits a released port', async () => {
  for (const port of [0, -1, 65536, NaN, 1.5]) {
    await assert.rejects(assertDebugPortAvailable(port), /integer from 1 to 65535/);
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await assertDebugPortAvailable(port);
});

for (const preview of [false, true]) {
  test(`profile CLI isolates ${preview ? 'preview' : 'development'} from a different working directory`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog profile cli '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const { stdout, stderr } = await exec(
      process.execPath,
      [helper, '--env-json', '--fresh', '--port', String(port), ...(preview ? ['--preview'] : [])],
      {
        cwd: root,
        env: {
          ...process.env,
          MIXDOG_HOME: 'live-home',
          MIXDOG_DATA_DIR: 'live-data',
          MIXDOG_RUNTIME_ROOT: 'live-runtime',
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_CLI_ARGS: '["--user-data-dir=live-profile"]',
        },
      }
    );
    assert.equal(stderr, '');
    const env = JSON.parse(stdout);
    t.after(() => rm(env.MIXDOG_DESKTOP_USER_DATA, { recursive: true, force: true }));
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    if (preview) {
      assert.deepEqual(JSON.parse(env.ELECTRON_CLI_ARGS), [`--remote-debugging-port=${port}`]);
    } else {
      assert.equal(env.ELECTRON_CLI_ARGS, undefined);
    }
    assert.equal(env.MIXDOG_DISABLE_PROJECT_MARKERS, '1');
    assert.equal(env.MIXDOG_DEV_RENDERER_PORT, String(devRendererPortFor(port)));
    for (const directory of [
      env.MIXDOG_HOME,
      env.MIXDOG_DATA_DIR,
      env.MIXDOG_RUNTIME_ROOT,
      env.MIXDOG_BRIDGE_DISCOVERY_DIR,
      env.MIXDOG_DESKTOP_USER_DATA,
    ])
      assert.equal((await stat(directory)).isDirectory(), true);
    assert.notEqual(env.MIXDOG_DATA_DIR, 'live-data');
  });
}
