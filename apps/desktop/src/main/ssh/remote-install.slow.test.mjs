import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REMOTE_SERVER_LOCKFILE, remoteServerDependencies } from '../../../scripts/remote-server-deps.mjs';
import { RemoteBootstrapError } from './remote-install-errors.ts';
import { encodePayloadArchive, manifestBuildHash, sha256Hex } from './remote-install-manifest.ts';
import {
  createServerPayload,
  localPayloadLayout,
  runtimeSources,
  SERVER_DEPS_FILES,
} from './remote-install-payload.ts';
import { classifyRemotePlatform, isWindowsShellFailure, parsePlatformLine } from './remote-install-platform.ts';
import { REMOTE_SERVER_LIBRARY } from './remote-install-program.ts';
import { REMOTE_PTY_PACKAGE } from './remote-install-versioned.ts';

const require = createRequire(import.meta.url);
// The server program's functions, loaded the way the program runs them.
const library = new Function(
  'require',
  'process',
  'Buffer',
  `${REMOTE_SERVER_LIBRARY}
  return { acquireInstallLock, unpackPayload, verifyManifest, manifestBuildHash, decideDaemonAction,
    busyDaemonMessage, ensureDaemon, garbageCollect, rotateLog, installedState, ensureInstalled, remotePaths,
    stopOwnedDaemon, managedInstallOf, readDaemonState, inspectInstallLock, stealInstallLock, lockHolders, cleanupServer };`
)(require, process, Buffer);

const scratch = () => mkdtempSync(join(tmpdir(), 'mixdog-remote-install-'));
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function rejectsWith(promiseOrFn, code, pattern) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected ${code}`);
}

// ---------------------------------------------------------------- manifest

const fixtureSources = () => [
  { path: 'package.json', source: Buffer.from('{"name":"mixdog","version":"1.1.2"}') },
  { path: 'server-deps/package.json', source: Buffer.from('{"name":"deps"}') },
  { path: 'server-deps/package-lock.json', source: Buffer.from('{"lockfileVersion":3}') },
  { path: 'src/standalone/daemon.mjs', source: Buffer.from('// daemon\n') },
  { path: 'apps/desktop/out/main/daemon.cjs', source: Buffer.from('module.exports = {};\n') },
];

test('the desktop and the server compute the same build hash from one manifest', async () => {
  const payload = await createServerPayload(fixtureSources(), '1.1.2');
  assert.equal(payload.installId, `1.1.2-${payload.buildHash}`);
  assert.match(payload.buildHash, /^[0-9a-f]{16}$/);
  assert.equal(library.manifestBuildHash(payload.files), manifestBuildHash(payload.files));
  const changed = await createServerPayload(
    [...fixtureSources().slice(0, 4), { path: 'apps/desktop/out/main/daemon.cjs', source: Buffer.from('x') }],
    '1.1.2'
  );
  assert.notEqual(changed.buildHash, payload.buildHash);
});

test('the server unpacks the archive and verifies every file against the manifest', async () => {
  const payload = await createServerPayload(fixtureSources(), '1.1.2');
  const dir = scratch();
  const manifest = library.unpackPayload(await payload.archive(), dir);
  library.verifyManifest(dir, manifest, payload.buildHash);
  assert.equal(readFileSync(join(dir, 'src', 'standalone', 'daemon.mjs'), 'utf8'), '// daemon\n');
  await rejectsWith(() => library.verifyManifest(dir, manifest, '0'.repeat(16)), 'install-failed', /hashes to/);
  writeFileSync(join(dir, 'src', 'standalone', 'daemon.mjs'), '// tampered\n');
  await rejectsWith(
    () => library.verifyManifest(dir, manifest, payload.buildHash),
    'install-failed',
    /daemon\.mjs does not match/
  );
});

test('a truncated archive or an escaping path never lands', async () => {
  const payload = await createServerPayload(fixtureSources(), '1.1.2');
  const { gunzipSync, gzipSync } = await import('node:zlib');
  const raw = gunzipSync(await payload.archive());
  await rejectsWith(
    () => library.unpackPayload(gzipSync(raw.subarray(0, raw.length - 3)), scratch()),
    'install-failed',
    /truncated/
  );
  await rejectsWith(
    () => library.unpackPayload(Buffer.from('not gzip'), scratch()),
    'install-failed',
    /not a valid archive/
  );
  const data = Buffer.from('evil');
  const evil = await encodePayloadArchive(
    [{ path: '../evil.txt', size: data.length, sha256: sha256Hex(data) }],
    async () => data
  );
  const dir = scratch();
  await rejectsWith(() => library.unpackPayload(evil, dir), 'install-failed', /invalid entry/);
  assert.equal(existsSync(join(dirname(dir), 'evil.txt')), false);
});

// ---------------------------------------------------------------- lock

const OLD_TOKEN = '0123456789abcdef01234567';
/** A lock left by another holder: lockDir/<token>/owner.json. */
function seedLock(lockDir, token, owner) {
  mkdirSync(join(lockDir, token), { recursive: true });
  writeFileSync(join(lockDir, token, 'owner.json'), JSON.stringify({ token, ...owner }));
}

test('the install lock admits one holder, names it to a waiter, and is released', async () => {
  const lockDir = join(scratch(), '.install-lock');
  const first = await library.acquireInstallLock(lockDir, { waitMs: 0, purpose: 'install x' });
  const owner = JSON.parse(readFileSync(join(lockDir, first.owner.token, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  // The desktop's host name never reaches the server (argv is visible in ps).
  assert.equal('client' in owner, false);
  await rejectsWith(
    library.acquireInstallLock(lockDir, { waitMs: 300, pollMs: 50 }),
    'install-locked',
    new RegExp(`pid ${process.pid} on .*install x`)
  );
  first.release();
  assert.equal(existsSync(lockDir), false);
  const second = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  second.release();
});

test('a waiter gets the lock once the holder releases it', async () => {
  const lockDir = join(scratch(), '.install-lock');
  const first = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  setTimeout(() => first.release(), 200);
  const second = await library.acquireInstallLock(lockDir, { waitMs: 5000, pollMs: 50 });
  assert.notEqual(second.owner.token, first.owner.token);
  second.release();
});

test('a lock whose owner died, or that outlived the stale timeout, is taken over', async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  const lockDir = join(scratch(), '.install-lock');
  seedLock(lockDir, OLD_TOKEN, { pid: deadPid, host: hostname(), startedAt: Date.now() });
  const taken = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  assert.deepEqual(readdirSync(lockDir), [taken.owner.token]);
  taken.release();
  // Live pid on another host: only age makes it stale.
  seedLock(lockDir, OLD_TOKEN, { pid: process.pid, host: 'elsewhere', startedAt: Date.now() - 60_000 });
  await rejectsWith(library.acquireInstallLock(lockDir, { waitMs: 0, staleMs: 120_000 }), 'install-locked');
  const aged = await library.acquireInstallLock(lockDir, { waitMs: 0, staleMs: 30_000 });
  aged.release();
  // A lock dir whose creator died before entering its token dir.
  mkdirSync(lockDir);
  utimesSync(lockDir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const empty = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  empty.release();
  assert.deepEqual(readdirSync(dirname(lockDir)), []);
});

test('a takeover never moves or deletes the lock of a holder that replaced the stale one', async () => {
  const lockDir = join(scratch(), '.install-lock');
  seedLock(lockDir, OLD_TOKEN, { pid: 999_999_99, host: hostname(), startedAt: Date.now() });
  const judged = library.inspectInstallLock(lockDir, 900_000);
  assert.deepEqual({ stale: judged.stale, token: judged.token }, { stale: true, token: OLD_TOKEN });
  // Interleaving: the stale lock goes away and a live holder takes the path
  // before the stealer acts on its judgement.
  rmSync(lockDir, { recursive: true });
  const live = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  assert.equal(library.stealInstallLock(lockDir, judged), false);
  assert.deepEqual(readdirSync(lockDir), [live.owner.token]);
  // An empty-lock judgement made before the live holder entered.
  assert.equal(library.stealInstallLock(lockDir, { gone: false, stale: true, token: null, owner: null }), false);
  assert.deepEqual(readdirSync(lockDir), [live.owner.token]);
  // The live holder still excludes everyone else and releases cleanly.
  await rejectsWith(library.acquireInstallLock(lockDir, { waitMs: 100, pollMs: 20 }), 'install-locked');
  live.release();
  assert.deepEqual(readdirSync(dirname(lockDir)), []);
});

test('a release removes only its own token dir, never a second creator inside the lock', async () => {
  const lockDir = join(scratch(), '.install-lock');
  const newer = await library.acquireInstallLock(lockDir, { waitMs: 0 });
  // The stalled creator's token dir appears next to the newer holder's.
  mkdirSync(join(lockDir, OLD_TOKEN));
  writeFileSync(
    join(lockDir, OLD_TOKEN, 'owner.json'),
    JSON.stringify({ token: OLD_TOKEN, pid: process.pid, host: hostname(), startedAt: Date.now() })
  );
  assert.deepEqual(library.lockHolders(lockDir), [OLD_TOKEN, newer.owner.token].sort());
  newer.release();
  // Releasing removed only its own token dir; the other one keeps the lock.
  assert.deepEqual(readdirSync(lockDir), [OLD_TOKEN]);
});

test('a release whose lock root removal was refused retries it on the next call before letting go', async () => {
  const realFs = require('fs');
  let refusedRoot = null;
  const fs = {
    ...realFs,
    rmdirSync: (target, ...rest) => {
      if (target === refusedRoot) throw Object.assign(new Error(`EPERM: rmdir '${target}'`), { code: 'EPERM' });
      return realFs.rmdirSync(target, ...rest);
    },
  };
  const injected = new Function('require', 'process', 'Buffer', `${REMOTE_SERVER_LIBRARY}\nreturn { acquireInstallLock };`)(
    (id) => (id === 'fs' ? fs : require(id)),
    process,
    Buffer
  );
  const lockDir = join(scratch(), '.install-lock');
  const lock = await injected.acquireInstallLock(lockDir, { waitMs: 0 });
  assert.ok(process.listeners('exit').includes(lock.release));
  refusedRoot = lockDir;
  lock.release();
  // The token is gone but the empty root stayed: the exit hook still owns its removal.
  assert.deepEqual(readdirSync(lockDir), []);
  assert.ok(process.listeners('exit').includes(lock.release));
  refusedRoot = null;
  lock.release();
  assert.equal(existsSync(lockDir), false);
  assert.equal(process.listeners('exit').includes(lock.release), false);
});

test('interleaved contenders, some crashing while they hold the lock, never overlap', {
  timeout: 120_000,
}, async () => {
  const dir = scratch();
  const lockDir = join(dir, '.install-lock');
  const worker = join(dir, 'worker.cjs');
  writeFileSync(
    worker,
    `const library = new Function('require', 'process', 'Buffer', ${JSON.stringify(`${REMOTE_SERVER_LIBRARY}\nreturn { acquireInstallLock };`)})(require, process, Buffer);
const fs = require('fs');
const [lockDir, inside, mode, rounds] = process.argv.slice(2);
(async () => {
  for (let i = 0; i < Number(rounds); i += 1) {
    const lock = await library.acquireInstallLock(lockDir, { waitMs: 60000, pollMs: 5 });
    // Dies holding the lock (no exit handler runs): the others must take it over.
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    try { fs.mkdirSync(inside); } catch { fs.appendFileSync(inside + '.overlap', process.pid + '\\n'); }
    await new Promise((resolve) => setTimeout(resolve, 3));
    fs.rmdirSync(inside);
    lock.release();
  }
})();
`
  );
  const inside = join(dir, 'inside');
  const run = (mode, rounds) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, lockDir, inside, mode, String(rounds)], { stdio: 'ignore' });
      children.push(child.pid);
      child.once('exit', (code, signal) => resolve({ mode, code, signal }));
    });
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => run('work', 6)),
    ...Array.from({ length: 4 }, () => run('crash', 1)),
  ]);
  assert.deepEqual(
    results.filter((entry) => entry.mode === 'work').map((entry) => entry.code),
    [0, 0, 0, 0, 0, 0]
  );
  // A crasher that came last left its dead lock: taken over at once.
  (await library.acquireInstallLock(lockDir, { waitMs: 0 })).release();
  assert.equal(
    existsSync(`${inside}.overlap`),
    false,
    existsSync(`${inside}.overlap`) ? readFileSync(`${inside}.overlap`, 'utf8') : ''
  );
  assert.equal(existsSync(lockDir), false);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith('.install-lock')),
    []
  );
});

// ---------------------------------------------------------------- daemon decisions

const want = { version: '1.1.2', buildHash: 'aaaaaaaaaaaaaaaa' };
const health = (overrides = {}) => ({
  status: 'ok',
  pid: 10,
  modelProxy: 'client',
  packageVersion: '1.1.2',
  buildHash: want.buildHash,
  busy: 0,
  ...overrides,
});

test('the daemon decision: reuse the current build, replace only a managed idle one, refuse the rest', () => {
  const state = (h, pidAlive = true) => ({ pid: 10, pidAlive, health: h });
  const decide = (h, { force = false, managed = '1.1.1-bbbbbbbbbbbbbbbb', pidAlive } = {}) =>
    library.decideDaemonAction(state(h, pidAlive), want, force, managed);
  assert.equal(decide(null, { pidAlive: false }), 'spawn');
  assert.equal(decide(null), 'wait');
  assert.equal(decide(health(), { managed: null }), 'reuse');
  assert.equal(decide(health({ buildHash: 'b'.repeat(16) })), 'replace');
  assert.equal(decide(health({ packageVersion: '1.1.1' })), 'replace');
  assert.equal(decide(health({ modelProxy: null })), 'replace');
  // Not proven desktop-installed (an npm install, any other daemon): never
  // stopped, not even when forced.
  assert.equal(decide(health({ buildHash: null }), { managed: null }), 'unmanaged');
  assert.equal(decide(health({ buildHash: null }), { managed: null, force: true }), 'unmanaged');
  // Running turns or attached clients make a managed daemon busy.
  assert.equal(decide(health({ buildHash: 'b'.repeat(16), busy: 2 })), 'busy');
  assert.equal(decide(health({ buildHash: 'b'.repeat(16), idle: false, busy: undefined })), 'busy');
  // Attached clients without turns: the desktop waits for their leases.
  assert.equal(decide(health({ buildHash: 'b'.repeat(16), clients: 1 })), 'attached');
  assert.equal(decide(health({ buildHash: 'b'.repeat(16), busy: 1, clients: 1 })), 'busy');
  assert.equal(decide(health({ buildHash: 'b'.repeat(16), busy: 2, clients: 1 }), { force: true }), 'replace');
  // The current build is reused even while it runs turns.
  assert.equal(decide(health({ busy: 3, clients: 2 })), 'reuse');
  const message = library.busyDaemonMessage({
    pid: 4242,
    health: health({ packageVersion: '1.1.1', buildHash: null, busy: 2 }),
  });
  assert.match(message, /mixdog 1\.1\.1, pid 4242\) is running 2 turns on the server/);
  const attached = library.busyDaemonMessage({ pid: 7, health: health({ packageVersion: '1.1.1', clients: 1 }) });
  assert.match(attached, /pid 7\) has 1 attached client on the server/);
});

test('the daemon decision follows the saved model login: the other mode is replaced, never reused', () => {
  const state = (h) => ({ pid: 10, pidAlive: true, health: h });
  const server = { ...want, modelLogin: 'server' };
  const decide = (h, wanted, { force = false, managed = '1.1.2-aaaaaaaaaaaaaaaa' } = {}) =>
    library.decideDaemonAction(state(h), wanted, force, managed);
  // Server logins: only a daemon without the model proxy is current.
  assert.equal(decide(health({ modelProxy: null }), server, { managed: null }), 'reuse');
  assert.equal(decide(health({ modelProxy: undefined }), server, { managed: null }), 'reuse');
  assert.equal(decide(health(), server), 'replace');
  // This PC's logins (the default): exactly as before, a proxy daemon only.
  assert.equal(decide(health(), want, { managed: null }), 'reuse');
  assert.equal(decide(health({ modelProxy: null }), want), 'replace');
  // The same build in the other mode keeps the busy and attached handling.
  assert.equal(decide(health({ busy: 2 }), server), 'busy');
  assert.equal(decide(health({ clients: 1 }), server), 'attached');
  assert.equal(decide(health({ busy: 2, clients: 1 }), server, { force: true }), 'replace');
  assert.equal(decide(health(), server, { managed: null }), 'unmanaged');
  assert.match(
    library.busyDaemonMessage({ pid: 4242, health: health({ busy: 1 }) }, server),
    /^A Mixdog daemon using this PC's model logins \(mixdog 1\.1\.2 build a{16}, pid 4242\) is running 1 turn/
  );
  assert.match(
    library.busyDaemonMessage({ pid: 4242, health: health({ modelProxy: null, busy: 1 }) }, want),
    /^A Mixdog daemon using the server's model logins/
  );
  assert.match(
    library.busyDaemonMessage({ pid: 7, health: health({ buildHash: 'b'.repeat(16), busy: 1 }) }, server),
    /^A Mixdog daemon of another version/
  );
});

test('the desktop daemon has its own runtime root and Mixdog home under ~/.mixdog-remote', () => {
  const home = scratch();
  const p = library.remotePaths(home);
  const root = join(home, '.mixdog-remote');
  assert.equal(p.discovery, join(root, 'runtime', 'daemon.json'));
  assert.equal(p.mixdogHome, join(root, 'user-data', 'home'));
  assert.equal(p.dataOwner, join(root, 'user-data', 'home', 'data', 'daemon-owner.json'));
});

// A stand-in daemon (ESM, like daemon.mjs): daemon.json + /health + /stop.
const FAKE_DAEMON = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.MIXDOG_RUNTIME_ROOT;
const marker = (() => { try { return JSON.parse(fs.readFileSync(path.join(__HERE__, '..', '..', '.install-complete'), 'utf8')); } catch { return {}; } })();
const busy = Number(process.env.FAKE_BUSY || 0);
const clients = Number(process.env.FAKE_CLIENTS || 0);
const token = 'tok-' + process.pid;
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', pid: process.pid, clients, modelProxy: process.env.MIXDOG_MODEL_PROXY || null, packageVersion: process.env.FAKE_VERSION || marker.version, buildHash: process.env.FAKE_BUILD || marker.buildHash || null, busy, busySessions: busy, idle: busy === 0 })); return; }
  if (req.url === '/stop' && req.headers['x-mixdog-daemon-token'] === token) {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const force = JSON.parse(body || '{}').force === true;
      if (busy && !force) { res.statusCode = 409; res.end('{"error":"busy"}'); return; }
      res.end('{"ok":true}'); setTimeout(() => { try { fs.rmSync(path.join(root, 'daemon.json')); } catch {} process.exit(0); }, 50);
    });
    return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(Number(process.env.MIXDOG_SESSION_PORT || 0), '127.0.0.1', () => {
  fs.mkdirSync(root, { recursive: true });
  const env = { home: process.env.MIXDOG_HOME, config: process.env.MIXDOG_CONFIG_DIR, data: process.env.MIXDOG_DATA_DIR, grace: process.env.MIXDOG_REMOTE_CLIENT_GRACE_MS };
  fs.writeFileSync(path.join(root, 'daemon.json'), JSON.stringify({ pid: process.pid, env, endpoints: { session: { port: server.address().port, token } } }));
});
`;

const children = [];
after(() => {
  for (const pid of children) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process already exited.
    }
  }
});

function serverHome() {
  const home = scratch();
  const p = library.remotePaths(home);
  return { home, p };
}

const OLD_BUILD = { version: '1.1.1', buildHash: 'bbbbbbbbbbbbbbbb' };

/** A version dir whose src/standalone/daemon.mjs is the fake daemon. */
function fakeVersion(p, installId, marker) {
  const dir = join(p.versions, installId);
  mkdirSync(join(dir, 'src', 'standalone'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'standalone', 'daemon.mjs'),
    FAKE_DAEMON.replace('__HERE__', JSON.stringify(join(dir, 'src', 'standalone')))
  );
  writeFileSync(join(dir, '.install-complete'), JSON.stringify(marker));
  return dir;
}

/** A daemon of another desktop-installed build (its own version dir and
 *  marker), or with `unmanaged`, one started from outside ~/.mixdog-remote. */
async function startFake(p, env, { unmanaged = false } = {}) {
  let script;
  if (unmanaged) {
    script = join(dirname(p.root), 'own-daemon.mjs');
    writeFileSync(script, FAKE_DAEMON.replace('__HERE__', JSON.stringify(dirname(p.root))));
  } else {
    script = join(fakeVersion(p, '1.1.1-bbbbbbbbbbbbbbbb', OLD_BUILD), 'src', 'standalone', 'daemon.mjs');
  }
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, MIXDOG_RUNTIME_ROOT: p.runtimeRoot, MIXDOG_MODEL_PROXY: 'client', ...env },
    stdio: 'ignore',
  });
  children.push(child.pid);
  const recorded = () => {
    try {
      return JSON.parse(readFileSync(p.discovery, 'utf8')).pid === child.pid;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !recorded(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return child;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('an idle daemon of another build is stopped through /stop and the current build is started', async () => {
  const { p } = serverHome();
  const old = await startFake(p, { FAKE_VERSION: '1.1.1', FAKE_BUILD: 'bbbbbbbbbbbbbbbb' });
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const result = await library.ensureDaemon(
    p,
    { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa', graceMs: '5400000' },
    versionDir,
    0
  );
  children.push(result.state.pid);
  assert.equal(result.started, true);
  assert.equal(result.replaced.pid, old.pid);
  assert.equal(result.replaced.version, '1.1.1');
  assert.equal(result.replaced.graceful, true);
  assert.equal(alive(old.pid), false);
  assert.equal(result.state.health.buildHash, want.buildHash);
  assert.match(readFileSync(p.log, 'utf8'), /starting 1\.1\.2-aaaaaaaaaaaaaaaa/);
  // Spawned with its own Mixdog home, config and data dir, never ~/.mixdog,
  // and the saved server's client grace.
  assert.deepEqual(JSON.parse(readFileSync(p.discovery, 'utf8')).env, {
    home: p.mixdogHome,
    config: p.mixdogHome,
    data: join(p.mixdogHome, 'data'),
    grace: '5400000',
  });
  if (process.platform !== 'win32') {
    for (const dir of [p.runtimeRoot, p.userData, p.mixdogHome]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  }
  // Second ensure: the same build is reused, nothing restarts.
  const again = await library.ensureDaemon(p, { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' }, versionDir, 0);
  assert.equal(again.started, false);
  assert.equal(again.state.pid, result.state.pid);
});

test('a busy daemon of another build is refused unless forced', async () => {
  const { p } = serverHome();
  const old = await startFake(p, { FAKE_VERSION: '1.1.1', FAKE_BUILD: 'bbbbbbbbbbbbbbbb', FAKE_BUSY: '1' });
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const args = { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' };
  await rejectsWith(
    library.ensureDaemon(p, args, versionDir, 0),
    'daemon-busy-other-version',
    new RegExp(`mixdog 1\\.1\\.1 build bbbbbbbbbbbbbbbb, pid ${old.pid}`)
  );
  assert.equal(alive(old.pid), true);
  const forced = await library.ensureDaemon(p, { ...args, forceRestart: true }, versionDir, 0);
  children.push(forced.state.pid);
  assert.equal(forced.replaced.pid, old.pid);
  assert.equal(alive(old.pid), false);
});

test('the daemon env follows the saved model login, and a daemon of the other mode is restarted, never attached', async () => {
  const { p } = serverHome();
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const args = { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' };
  // This PC's logins: the daemon starts in client proxy mode.
  const pc = await library.ensureDaemon(p, args, versionDir, 0);
  children.push(pc.state.pid);
  assert.equal(pc.started, true);
  assert.equal(pc.state.health.modelProxy, 'client');
  // Server logins: the same build in proxy mode is stopped and a daemon
  // without MIXDOG_MODEL_PROXY starts, even when the ssh session's own
  // environment names it.
  const inherited = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  let server;
  try {
    server = await library.ensureDaemon(p, { ...args, modelLogin: 'server' }, versionDir, 0);
  } finally {
    if (inherited === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = inherited;
  }
  children.push(server.state.pid);
  assert.equal(server.started, true);
  assert.equal(server.replaced.pid, pc.state.pid);
  assert.equal(server.replaced.modelProxy, 'client');
  assert.equal(alive(pc.state.pid), false);
  assert.equal(server.state.health.modelProxy, null);
  // The same mode again: reused, nothing restarts.
  const again = await library.ensureDaemon(p, { ...args, modelLogin: 'server' }, versionDir, 0);
  assert.equal(again.started, false);
  assert.equal(again.state.pid, server.state.pid);
  // Back to this PC's logins: the server-login daemon is replaced in turn.
  const back = await library.ensureDaemon(p, args, versionDir, 0);
  children.push(back.state.pid);
  assert.equal(back.replaced.pid, server.state.pid);
  assert.equal(back.state.health.modelProxy, 'client');
});

test('a busy daemon of the other model login is refused with its mode unless forced', async () => {
  const { p } = serverHome();
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const script = join(versionDir, 'src', 'standalone', 'daemon.mjs');
  const busy = spawn(process.execPath, [script], {
    env: { ...process.env, MIXDOG_RUNTIME_ROOT: p.runtimeRoot, MIXDOG_MODEL_PROXY: 'client', FAKE_BUSY: '1' },
    stdio: 'ignore',
  });
  children.push(busy.pid);
  for (let i = 0; i < 100; i += 1) {
    try {
      if (JSON.parse(readFileSync(p.discovery, 'utf8')).pid === busy.pid) break;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const args = { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa', modelLogin: 'server' };
  await rejectsWith(
    library.ensureDaemon(p, args, versionDir, 0),
    'daemon-busy-other-version',
    new RegExp(`using this PC's model logins \\(mixdog 1\\.1\\.2 build a{16}, pid ${busy.pid}\\) is running 1 turn`)
  );
  assert.equal(alive(busy.pid), true);
  const forced = await library.ensureDaemon(p, { ...args, forceRestart: true }, versionDir, 0);
  children.push(forced.state.pid);
  assert.equal(forced.replaced.pid, busy.pid);
  assert.equal(forced.state.health.modelProxy, null);
});

test('an idle daemon of another build with an attached client is not replaced automatically', async () => {
  const { p } = serverHome();
  const old = await startFake(p, { FAKE_CLIENTS: '1' });
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  await rejectsWith(
    library.ensureDaemon(p, { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' }, versionDir, 0),
    'daemon-clients-attached',
    new RegExp(`pid ${old.pid}\\) has 1 attached client`)
  );
  assert.equal(alive(old.pid), true);
});

test('a daemon not proven desktop-installed is never stopped, even when forced', async () => {
  const { p } = serverHome();
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const args = { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa', forceRestart: true };
  // Started from outside ~/.mixdog-remote (a global install).
  const own = await startFake(p, { FAKE_VERSION: '1.1.1', FAKE_BUILD: '' }, { unmanaged: true });
  await rejectsWith(library.ensureDaemon(p, args, versionDir, 0), 'daemon-unmanaged', new RegExp(`pid ${own.pid}`));
  assert.equal(alive(own.pid), true);
  process.kill(own.pid, 'SIGKILL');
  // Runs from a version dir but reports a build its marker does not name.
  const forged = await startFake(p, { FAKE_BUILD: 'cccccccccccccccc' });
  const state = await library.readDaemonState(p);
  assert.equal(library.managedInstallOf(p, state), null);
  await rejectsWith(library.ensureDaemon(p, args, versionDir, 0), 'daemon-unmanaged');
  assert.equal(alive(forged.pid), true);
});

test('defensive: a foreign live owner of the desktop data dir is left running and refused', async () => {
  const { p } = serverHome();
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  const personal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(personal.pid);
  mkdirSync(dirname(p.dataOwner), { recursive: true });
  writeFileSync(p.dataOwner, JSON.stringify({ kind: 'mixdog-daemon', pid: personal.pid }));
  await rejectsWith(
    library.ensureDaemon(p, { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' }, versionDir, 0),
    'daemon-data-in-use',
    new RegExp(`pid ${personal.pid}\\) that the desktop did not start is using`)
  );
  assert.equal(alive(personal.pid), true);
  assert.equal(existsSync(p.discovery), false);
  // A dead owner is no obstacle.
  personal.kill('SIGKILL');
  await new Promise((resolve) => personal.once('exit', resolve));
  const result = await library.ensureDaemon(p, { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' }, versionDir, 0);
  children.push(result.state.pid);
  assert.equal(result.started, true);
  assert.ok(result.state.port > 0);
});

test('a busy preferred port falls back to another loopback port; daemon.json names it', async () => {
  const { p } = serverHome();
  // Block the preferred port (41000 + uid % 20000) of some uid.
  const blocker = net.createServer();
  let uid = 12_345;
  for (; ; uid += 101) {
    const listening = await new Promise((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(41_000 + uid, '127.0.0.1', () => resolve(true));
    });
    if (listening) break;
  }
  const preferred = 41_000 + uid;
  const versionDir = fakeVersion(p, '1.1.2-aaaaaaaaaaaaaaaa', { version: '1.1.2', buildHash: want.buildHash });
  try {
    const result = await library.ensureDaemon(p, { ...want, installId: '1.1.2-aaaaaaaaaaaaaaaa' }, versionDir, uid);
    children.push(result.state.pid);
    assert.notEqual(result.state.port, preferred);
    assert.equal(JSON.parse(readFileSync(p.discovery, 'utf8')).endpoints.session.port, result.state.port);
  } finally {
    blocker.close();
  }
});

test('cleanup stops only a daemon running from the install; a stale record is dropped', async () => {
  const { p } = serverHome();
  const own = await startFake(p, { FAKE_VERSION: '1.1.1' }, { unmanaged: true });
  assert.deepEqual(await library.stopOwnedDaemon(p), { pid: own.pid, stopped: false, reason: 'not-proven' });
  assert.equal(alive(own.pid), true);
  process.kill(own.pid, 'SIGKILL');
  const old = await startFake(p, { FAKE_VERSION: '1.1.1' });
  const stopped = await library.stopOwnedDaemon(p);
  assert.deepEqual({ pid: stopped.pid, stopped: stopped.stopped }, { pid: old.pid, stopped: true });
  assert.equal(alive(old.pid), false);
  // A record whose pid is alive but does not answer /health as itself.
  writeFileSync(p.discovery, JSON.stringify({ pid: process.pid, endpoints: { session: { port: 1, token: 't' } } }));
  assert.deepEqual(await library.stopOwnedDaemon(p), { pid: process.pid, stopped: false, reason: 'not-proven' });
  writeFileSync(p.discovery, JSON.stringify({ pid: 999_999_99, endpoints: { session: { port: 1, token: 't' } } }));
  assert.equal(await library.stopOwnedDaemon(p), null);
  assert.equal(existsSync(p.discovery), false);
});

const cleanupArgs = { phase: 'remove', removeUserData: false, lockWaitMs: 0 };
const entries = (dir) => readdirSync(dir).sort();

test('cleanup stops the managed daemon and removes everything but user-data in one lock hold', async () => {
  const { p } = serverHome();
  const old = await startFake(p, { FAKE_VERSION: '1.1.1' });
  mkdirSync(p.deps, { recursive: true });
  mkdirSync(p.userData, { recursive: true });
  // Held by someone else: cleanup neither stops nor removes anything.
  const other = await library.acquireInstallLock(p.lock, { waitMs: 0 });
  await rejectsWith(library.cleanupServer(p, cleanupArgs), 'install-locked');
  assert.equal(alive(old.pid), true);
  other.release();
  const result = await library.cleanupServer(p, cleanupArgs);
  assert.equal(result.cleanup.stopped.pid, old.pid);
  assert.equal(alive(old.pid), false);
  assert.deepEqual(result.cleanup.kept, ['user-data']);
  assert.deepEqual(entries(p.root), ['user-data']);
});

test('cleanup removes nothing while an unproven daemon record or any process uses the install', async () => {
  const { p } = serverHome();
  // The daemon record names a live process that is not the desktop's daemon.
  const own = await startFake(p, { FAKE_VERSION: '1.1.1' }, { unmanaged: true });
  const before = entries(p.root);
  await rejectsWith(
    library.cleanupServer(p, cleanupArgs),
    'daemon-unproven',
    new RegExp(`pid ${own.pid}\\).*nothing was removed`)
  );
  await rejectsWith(library.cleanupServer(p, { ...cleanupArgs, phase: 'stop' }), 'daemon-unproven');
  assert.equal(alive(own.pid), true);
  assert.deepEqual(entries(p.root), before);
  process.kill(own.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  // No daemon record, but a process still runs code from a version dir.
  const script = join(p.versions, '1.1.0-dddddddddddddddd', 'stray.js');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  const stray = spawn(process.execPath, [script], { stdio: 'ignore' });
  children.push(stray.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rejectsWith(
    library.cleanupServer(p, cleanupArgs),
    'daemon-unproven',
    new RegExp(`pid ${stray.pid}.*nothing was removed`)
  );
  assert.equal(existsSync(script), true);
  stray.kill('SIGKILL');
  await new Promise((resolve) => stray.once('exit', resolve));
  // A live owner of the desktop data dir blocks removal too.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(holder.pid);
  mkdirSync(dirname(p.dataOwner), { recursive: true });
  writeFileSync(p.dataOwner, JSON.stringify({ kind: 'mixdog-daemon', pid: holder.pid }));
  await rejectsWith(library.cleanupServer(p, cleanupArgs), 'daemon-unproven', new RegExp(`pid ${holder.pid}`));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const done = await library.cleanupServer(p, { ...cleanupArgs, removeUserData: true });
  assert.deepEqual(done.cleanup.kept, []);
  assert.equal(existsSync(p.root), false);
});

// ---------------------------------------------------------------- install

test('an upload is staged, verified, published by rename and marked complete last', async () => {
  const { p } = serverHome();
  const payload = await createServerPayload(fixtureSources(), '1.1.2');
  const info = { os: 'linux', arch: 'x64', modules: '127', node: '22.19.0' };
  const depsHash = createHash('sha256')
    .update('{"name":"deps"}')
    .update('{"lockfileVersion":3}')
    .digest('hex')
    .slice(0, 16);
  const depsKey = `${depsHash}-linux-x64-abi127`;
  // Modules already installed for this lockfile: no npm needed.
  const depsDir = join(p.deps, depsKey);
  mkdirSync(join(depsDir, 'node_modules', REMOTE_PTY_PACKAGE), { recursive: true });
  writeFileSync(join(depsDir, 'node_modules', REMOTE_PTY_PACKAGE, 'package.json'), '{}');
  writeFileSync(
    join(depsDir, '.install-complete'),
    JSON.stringify({ depsKey, terminalsAvailable: false, terminalsError: 'no prebuild' })
  );
  const args = { installId: payload.installId, version: '1.1.2', buildHash: payload.buildHash };
  // A leftover without a marker at the final path is never trusted.
  mkdirSync(join(p.versions, payload.installId, 'src'), { recursive: true });
  writeFileSync(join(p.versions, payload.installId, 'src', 'junk'), 'x');
  assert.equal(library.installedState(p, args).installed, false);
  await rejectsWith(library.ensureInstalled(p, args, null, info), 'install-missing');
  const state = await library.ensureInstalled(p, args, await payload.archive(), info);
  assert.equal(state.installed, true);
  assert.equal(state.freshInstall, true);
  assert.equal(state.terminalsAvailable, false);
  const versionDir = join(p.versions, payload.installId);
  assert.equal(existsSync(join(versionDir, 'src', 'junk')), false);
  assert.equal(realpathSync(join(versionDir, 'node_modules')), realpathSync(join(depsDir, 'node_modules')));
  const marker = JSON.parse(readFileSync(join(versionDir, '.install-complete'), 'utf8'));
  assert.deepEqual(
    { buildHash: marker.buildHash, depsKey: marker.depsKey, version: marker.version },
    { buildHash: payload.buildHash, depsKey, version: '1.1.2' }
  );
  assert.ok(
    statSync(join(versionDir, '.install-complete')).mtimeMs >= statSync(join(versionDir, '.manifest.json')).mtimeMs
  );
  assert.deepEqual(readdirSync(p.versions), [payload.installId]);
  const reused = await library.ensureInstalled(p, args, null, info);
  assert.equal(reused.freshInstall, false);
  // A corrupted upload fails and leaves no staging behind.
  await rejectsWith(
    library.ensureInstalled(
      p,
      { ...args, installId: '1.1.2-ffffffffffffffff', buildHash: 'f'.repeat(16) },
      await payload.archive(),
      info
    ),
    'install-failed'
  );
  assert.deepEqual(readdirSync(p.versions), [payload.installId]);
});

// ---------------------------------------------------------------- gc

test('gc keeps current, previous and live versions and removes the rest', () => {
  const { p } = serverHome();
  const version = (name, deps) => {
    mkdirSync(join(p.versions, name), { recursive: true });
    writeFileSync(join(p.versions, name, '.install-complete'), '{}');
    if (deps) symlinkSync(join(p.deps, deps, 'node_modules'), join(p.versions, name, 'node_modules'), linkType);
  };
  for (const deps of ['d-used', 'd-live', 'd-orphan'])
    mkdirSync(join(p.deps, deps, 'node_modules'), { recursive: true });
  mkdirSync(join(p.deps, '.staging-d-x-1'), { recursive: true });
  version('1.1.3-cur', 'd-used');
  version('1.1.2-prev', 'd-used');
  version('1.1.1-live', 'd-live');
  version('1.1.0-old', 'd-orphan');
  mkdirSync(join(p.versions, '.staging-1.1.4-x-99'), { recursive: true });
  mkdirSync(join(p.root, '1.0.9', 'apps'), { recursive: true });
  mkdirSync(p.userData, { recursive: true });
  const commands = [`node ${join(p.versions, '1.1.1-live', 'src', 'standalone', 'daemon.mjs')}`, 'bash'];
  const keep = new Set(['1.1.3-cur', '1.1.2-prev']);
  assert.deepEqual(library.garbageCollect(p, keep, null), { removed: [], skipped: 'process list unavailable' });
  const { removed } = library.garbageCollect(p, keep, commands);
  assert.deepEqual(readdirSync(p.versions).sort(), ['1.1.1-live', '1.1.2-prev', '1.1.3-cur']);
  assert.deepEqual(readdirSync(p.deps).sort(), ['d-live', 'd-used']);
  assert.equal(existsSync(join(p.root, '1.0.9')), false);
  assert.equal(existsSync(p.userData), true);
  assert.deepEqual(removed.sort(), [
    '1.0.9',
    'deps/.staging-d-x-1',
    'deps/d-orphan',
    'versions/.staging-1.1.4-x-99',
    'versions/1.1.0-old',
  ]);
});

test('daemon.log rotates by size and keeps one old generation', () => {
  const dir = scratch();
  const log = join(dir, 'daemon.log');
  writeFileSync(log, 'a'.repeat(64));
  assert.equal(library.rotateLog(log, 100), false);
  writeFileSync(log, 'b'.repeat(200));
  assert.equal(library.rotateLog(log, 100), true);
  assert.equal(statSync(log).size, 0);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'b'.repeat(200));
});

// ---------------------------------------------------------------- platform

test('the platform probe admits Linux glibc and macOS on x64/arm64 only', () => {
  assert.deepEqual(classifyRemotePlatform('Linux x86_64', 'glibc'), { os: 'linux', arch: 'x64' });
  assert.deepEqual(classifyRemotePlatform('Linux aarch64', 'glibc'), { os: 'linux', arch: 'arm64' });
  assert.deepEqual(classifyRemotePlatform('Darwin arm64', 'none'), { os: 'darwin', arch: 'arm64' });
  assert.deepEqual(classifyRemotePlatform('Darwin x86_64', 'none'), { os: 'darwin', arch: 'x64' });
  for (const [uname, libc, pattern] of [
    ['Linux x86_64', 'musl', /musl/],
    ['Linux armv7l', 'glibc', /armv7l/],
    ['MINGW64_NT-10.0 x86_64', 'none', /Windows/],
    ['FreeBSD amd64', 'none', /FreeBSD/],
    ['', 'none', /unknown system/],
  ]) {
    assert.throws(
      () => classifyRemotePlatform(uname, libc),
      (error) =>
        error instanceof RemoteBootstrapError && error.code === 'unsupported-platform' && pattern.test(error.message),
      uname
    );
  }
  assert.deepEqual(parsePlatformLine('motd\nMIXDOG_PLATFORM Linux x86_64|glibc\n'), {
    uname: 'Linux x86_64',
    libc: 'glibc',
  });
  assert.equal(parsePlatformLine('nothing'), null);
  assert.ok(isWindowsShellFailure("'sh' is not recognized as an internal or external command,"));
  assert.ok(!isWindowsShellFailure('sh: 1: base64: not found'));
});

const desktopDir = fileURLToPath(new URL('../../../', import.meta.url));

test("node-pty's own prebuild list covers Linux x64/arm64 glibc for node 22 and 24", () => {
  const prebuilds = join(desktopDir, 'node_modules', REMOTE_PTY_PACKAGE, 'prebuilds');
  for (const arch of ['x64', 'arm64']) {
    const names = readdirSync(join(prebuilds, `linux-${arch}`));
    for (const abi of ['127', '137']) assert.ok(names.includes(`node.abi${abi}.node`), `linux-${arch} abi${abi}`);
  }
  // macOS binaries are not tarball content: the installer fetches them (prebuild-install).
  assert.equal(existsSync(join(prebuilds, 'darwin-arm64')), false);
});

// ---------------------------------------------------------------- payload sources

test('the local payload layout is the packaged runtime or the source checkout', () => {
  const sep = process.platform === 'win32' ? '\\' : '/';
  const resources = ['', 'opt', 'Mixdog', 'resources'].join(sep);
  const packaged = localPayloadLayout(`${resources}${sep}app.asar${sep}out${sep}main`, () => false);
  assert.equal(packaged.runtimePackageDir, join(resources, 'runtime.asar', 'node_modules', 'mixdog'));
  assert.equal(packaged.serverDepsDir, join(resources, 'app.asar', 'out', 'server', 'deps'));
  const checkout = localPayloadLayout(join(desktopDir, 'out', 'main'));
  assert.equal(checkout.runtimePackageDir, join(desktopDir, '..', '..'));
});

test('the built server lockfile survives packaging and ships as server-deps/package-lock.json', () => {
  // electron-builder drops every file named package-lock.json from app.asar by default.
  assert.notEqual(REMOTE_SERVER_LOCKFILE, 'package-lock.json');
  assert.deepEqual(
    SERVER_DEPS_FILES.map(({ local }) => local),
    ['package.json', REMOTE_SERVER_LOCKFILE]
  );
  const root = scratch();
  try {
    const layout = { runtimePackageDir: join(root, 'runtime'), serverDepsDir: join(root, 'deps') };
    mkdirSync(join(layout.runtimePackageDir, 'src'), { recursive: true });
    mkdirSync(layout.serverDepsDir);
    writeFileSync(join(layout.runtimePackageDir, 'package.json'), '{}');
    writeFileSync(join(layout.runtimePackageDir, 'src', 'index.mjs'), '');
    writeFileSync(join(layout.serverDepsDir, 'package.json'), '{}');
    assert.throws(
      () => runtimeSources(layout),
      (error) => error.code === 'local-payload' && /lockfile is missing/.test(error.message)
    );
    writeFileSync(join(layout.serverDepsDir, REMOTE_SERVER_LOCKFILE), '{}');
    const lock = runtimeSources(layout).find((entry) => entry.path === 'server-deps/package-lock.json');
    assert.equal(lock?.source, join(layout.serverDepsDir, REMOTE_SERVER_LOCKFILE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the server lockfile adds the bundle externals with their closure, nesting conflicts', () => {
  const runtimeLock = {
    packages: {
      '': { name: 'mixdog', dependencies: { a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/shared': { version: '1.0.0' },
      'node_modules/devtool': { version: '9.0.0', dev: true },
    },
  };
  const desktopLock = {
    packages: {
      'node_modules/pty': { version: '0.13.1', dependencies: { shared: '^2.0.0', helper: '^1.0.0' } },
      'node_modules/shared': { version: '2.0.0' },
      'node_modules/helper': { version: '1.2.0', dependencies: { a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0', dev: true },
    },
  };
  const { packageJson, packageLock } = remoteServerDependencies({
    runtimePackage: { version: '1.1.2', dependencies: { a: '^1.0.0' }, overrides: { a: '1.0.0' } },
    runtimeLock,
    desktopLock,
    externals: ['pty'],
  });
  assert.deepEqual(packageJson.dependencies, { a: '^1.0.0', pty: '0.13.1' });
  assert.deepEqual(packageJson.overrides, { a: '1.0.0' });
  assert.deepEqual(packageLock.packages[''].dependencies, packageJson.dependencies);
  assert.equal(packageLock.packages['node_modules/devtool'], undefined);
  assert.equal(packageLock.packages['node_modules/shared'].version, '1.0.0');
  assert.equal(packageLock.packages['node_modules/pty/node_modules/shared'].version, '2.0.0');
  assert.equal(packageLock.packages['node_modules/helper'].version, '1.2.0');
  assert.equal(packageLock.packages['node_modules/pty/node_modules/a'], undefined);
});
