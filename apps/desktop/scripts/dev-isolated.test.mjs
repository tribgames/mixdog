import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  acquireLease,
  allocatePorts,
  assertIsolation,
  instanceEnv,
  instanceProcessIds,
  isPidAlive,
  leaseIsStale,
  stopInstance,
  sweep,
} from './dev-isolated.mjs';
import { DEV_DEBUG_PORT, devRendererPortFor, persistentDevProfileDir } from './dev-profile.mjs';

const exec = promisify(execFile);
const moduleUrl = new URL('./dev-isolated.mjs', import.meta.url).href;

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-isolated-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('concurrent starters in separate processes never share a port, and never get 9342', async (t) => {
  const root = await tempRoot(t);
  // A small range around the shared port forces contention and the exclusion.
  const range = [DEV_DEBUG_PORT - 6, DEV_DEBUG_PORT + 5];
  const script = `
    const { allocatePorts } = await import(${JSON.stringify(moduleUrl)});
    const ports = await allocatePorts(${JSON.stringify(root)}, process.argv[1], { range: ${JSON.stringify(range)}, start: 0 });
    console.log(JSON.stringify(ports));`;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      exec(process.execPath, ['--input-type=module', '-e', script, `agent-${index}`]).then(({ stdout }) =>
        JSON.parse(stdout)
      )
    )
  );
  const cdp = results.map((result) => result.cdpPort);
  assert.equal(new Set(cdp).size, cdp.length, `duplicate CDP ports: ${cdp}`);
  assert.equal(new Set(results.map((result) => result.rendererPort)).size, results.length);
  for (const { cdpPort, rendererPort } of results) {
    assert.notEqual(cdpPort, DEV_DEBUG_PORT);
    assert.notEqual(rendererPort, devRendererPortFor(DEV_DEBUG_PORT));
    assert.equal(rendererPort, devRendererPortFor(cdpPort));
  }
  assert.equal((await readdir(join(root, 'ports'))).length, 8);
});

test('a port in use is skipped and its reservation released', async (t) => {
  const root = await tempRoot(t);
  const busy = new Set([9400, devRendererPortFor(9401)]);
  const ports = await allocatePorts(root, 'a', {
    range: [9400, 9403],
    start: 0,
    probe: async (port) => !busy.has(port),
  });
  assert.deepEqual(ports, { cdpPort: 9402, rendererPort: devRendererPortFor(9402) });
  assert.deepEqual(await readdir(join(root, 'ports')), ['9402.json']);
  await assert.rejects(allocatePorts(root, 'b', { range: [9402, 9402], probe: async () => true }), /No free/);
  await assert.rejects(
    allocatePorts(root, 'c', { range: [DEV_DEBUG_PORT, DEV_DEBUG_PORT], probe: async () => true }),
    /No free/
  );
});

test('the instance environment never names the real data, userData or the shared dev profile', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'x-000000');
  const parent = {
    ...process.env,
    MIXDOG_DATA_DIR: join(homedir(), '.mixdog', 'data'),
    MIXDOG_HOME: join(homedir(), '.mixdog'),
    MIXDOG_DESKTOP_USER_DATA: 'C:\\real-user-data',
    MIXDOG_RELAY_URL: 'wss://relay.example.com',
  };
  const env = await instanceEnv({
    instanceDir,
    cdpPort: 9500,
    rendererPort: 10500,
    appDir: join(instanceDir, 'app', 'desktop'),
    parent,
  });
  for (const key of [
    'MIXDOG_DESKTOP_USER_DATA',
    'MIXDOG_HOME',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
  ]) {
    assert.ok(env[key].startsWith(instanceDir), `${key}=${env[key]}`);
  }
  assert.equal(env.MIXDOG_RELAY_URL, 'off');
  assert.equal(env.MIXDOG_DEV_RENDERER_PORT, '10500');

  const ports = { instanceDir, cdpPort: 9500, rendererPort: 10500, parent };
  assert.throws(
    () => assertIsolation({ ...env, MIXDOG_DATA_DIR: join(homedir(), '.mixdog', 'data') }, ports),
    /MIXDOG_DATA_DIR/
  );
  assert.throws(() => assertIsolation({ ...env, MIXDOG_RELAY_URL: '' }, ports), /relay/);
  assert.throws(() => assertIsolation(env, { ...ports, cdpPort: DEV_DEBUG_PORT }), /9342/);
  assert.throws(() => assertIsolation(env, { ...ports, rendererPort: devRendererPortFor(DEV_DEBUG_PORT) }), /9342/);
  // An instance root placed inside a shared location is refused too.
  for (const shared of [join(homedir(), '.mixdog'), persistentDevProfileDir('default', parent)]) {
    const inside = join(shared, 'instances', 'y');
    const sharedEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value.replace(instanceDir, inside)])
    );
    assert.throws(() => assertIsolation(sharedEnv, { ...ports, instanceDir: inside }), /shared location/);
  }
});

test('stale leases (dead owner or past TTL) are reclaimed; a live one is refused', async (t) => {
  const root = await tempRoot(t);
  const list = () => [];
  const writeLease = async (name, lease) => {
    const instanceDir = join(root, 'instances', `${name}-abcdef`);
    await mkdir(join(instanceDir, 'profile'), { recursive: true });
    await mkdir(join(root, 'leases'), { recursive: true });
    await mkdir(join(root, 'ports'), { recursive: true });
    await writeFile(join(root, 'ports', `${lease.cdpPort}.json`), JSON.stringify({ name }));
    await writeFile(join(root, 'leases', `${name}.json`), JSON.stringify({ name, instanceDir, ...lease }));
    return instanceDir;
  };
  const dead = await writeLease('dead', {
    pid: await deadPid(),
    cdpPort: 9601,
    startedAt: new Date().toISOString(),
    ttlMs: 60_000,
  });
  const old = await writeLease('old', {
    pid: process.pid,
    cdpPort: 9602,
    startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  });
  await writeLease('live', { pid: process.pid, cdpPort: 9603, startedAt: new Date().toISOString(), ttlMs: 60_000 });

  assert.equal(leaseIsStale({ pid: process.pid, startedAt: new Date().toISOString() }), false);
  await acquireLease(root, 'dead', { list });
  assert.equal(existsSync(dead), false);
  await assert.rejects(acquireLease(root, 'live', { list }), /is running/);

  const swept = await sweep(root, { list });
  assert.deepEqual(
    swept.map((result) => result.name),
    ['old']
  );
  assert.equal(existsSync(old), false);
  assert.deepEqual((await readdir(join(root, 'leases'))).sort(), ['dead.json', 'live.json']);
  assert.deepEqual(await readdir(join(root, 'ports')), ['9603.json']);
});

test('process matching: the instance tree and its daemon, never a reused or unrelated pid', () => {
  const instanceDir = 'C:\\iso\\instances\\a-123456';
  const processes = [
    { pid: 10, ppid: 1, cmd: `node electron-vite.js dev --outDir ${instanceDir}\\app\\desktop\\out` },
    { pid: 11, ppid: 10, cmd: `electron.exe ${instanceDir}\\app\\desktop` },
    { pid: 12, ppid: 11, cmd: 'electron.exe C:\\repo\\src\\standalone\\daemon.mjs' },
    { pid: 13, ppid: 12, cmd: 'node memory\\index.mjs' },
    { pid: 20, ppid: 1, cmd: 'electron.exe C:\\iso\\instances\\a-123456-ffffff\\app\\desktop' },
    { pid: 30, ppid: 1, cmd: 'electron.exe --remote-debugging-port=9342 .' },
    { pid: 40, ppid: 99, cmd: 'orphan child of a killed main' },
  ];
  const needle = `${instanceDir}\\`;
  assert.deepEqual(instanceProcessIds(processes, { needle }).sort(), [10, 11, 12, 13]);
  assert.deepEqual(instanceProcessIds(processes, { needle, ancestorPids: [99] }).sort(), [10, 11, 12, 13, 40]);
  assert.deepEqual(instanceProcessIds(processes, { needle: 'nothing', ancestorPids: [30] }), []);
});

test('stop kills the whole tree, an orphaned daemon included, and deletes the instance', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'tree-abcdef');
  const profile = join(instanceDir, 'profile');
  await mkdir(join(profile, 'runtime'), { recursive: true });
  // A link like the real layout's: stopping must remove the link, not its target.
  const target = join(root, 'link-target');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'x');
  await symlink(target, join(instanceDir, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  // A parent naming the instance that spawns a grandchild which does not.
  const tree = spawn(
    process.execPath,
    [
      '-e',
      "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});setInterval(()=>{},1e3)",
      join(instanceDir, 'marker'),
    ],
    { stdio: 'ignore' }
  );
  // A daemon whose parent is gone: found only through the profile's daemon.json.
  const daemonDir = join(root, 'repo', 'src', 'standalone');
  await mkdir(daemonDir, { recursive: true });
  await writeFile(join(daemonDir, 'daemon.mjs'), 'setInterval(() => {}, 1000);');
  const daemon = spawn(process.execPath, [join(daemonDir, 'daemon.mjs')], { stdio: 'ignore', detached: true });
  daemon.unref();
  await writeFile(join(profile, 'runtime', 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
  t.after(() => {
    for (const pid of [tree.pid, daemon.pid]) if (isPidAlive(pid)) process.kill(pid);
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const lease = { name: 'tree', instanceDir, profile, startedAt: new Date().toISOString(), cdpPort: 9700 };
  await mkdir(join(root, 'leases'), { recursive: true });
  await writeFile(join(root, 'leases', 'tree.json'), JSON.stringify(lease));
  const result = await stopInstance(root, lease);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.removed, true);
  assert.ok(result.killed.includes(tree.pid) && result.killed.includes(daemon.pid));
  assert.equal(result.killed.length, 3, `killed ${result.killed}`);
  assert.equal(isPidAlive(tree.pid), false);
  assert.equal(isPidAlive(daemon.pid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(join(target, 'keep.txt')), true);
  assert.deepEqual(await readdir(join(root, 'leases')), []);
});
