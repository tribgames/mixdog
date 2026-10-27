// Reading the Linux fallback secrets store (keychain-cjs.cjs "Linux fallback
// file"). A read must not trust whatever sits at `<dataDir>/secrets/<account>.secret`:
// a store restored with permissive modes, an account file swapped for a symlink,
// or a planted file owned by someone else must read as absent (the reason is
// surfaced as an EUNSAFE error, never the value) while a private 0600 file in a
// private directory is still served.
//
// Real files, real modes, real symlinks wherever the host has them; only
// process.platform is faked (as in keychain-cjs.test.mjs) and `secret-tool` is
// faked so the keyring either has no such item ('absent') or is not installed
// ('missing'). win32 has no owner/mode bits and no O_NOFOLLOW, so there the
// owner/mode/type checks run against an emulated POSIX stat view of the test
// data dir (see installPosixView) and the symlink/FIFO cases are skipped.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const POSIX = process.platform !== 'win32';
const NO_POSIX_SKIP = POSIX ? false : 'win32 has no O_NOFOLLOW, symlink privilege or FIFOs — covered on POSIX hosts';
const NO_CHMOD_SKIP = POSIX ? false : 'win32 ignores chmod, so the permission repair is only observable on POSIX';
const SECRET = 'sk-test-fallback-read-0123456789';
const ACCOUNT = 'agent.openai.apiKey';
const FAKE_UID = 1000;
const HOST_UID = POSIX ? process.getuid() : FAKE_UID;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-fallback-read-'));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// win32 only: a POSIX-like stat view (uid + permission bits) of the test data dir
// ---------------------------------------------------------------------------
const overrides = new Map(); // normalised path -> { mode, uid }
const keyOf = (target) => path.resolve(String(target)).toLowerCase();

function installPosixView(root) {
  const rootKey = keyOf(root);
  const real = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    lstatSync: fs.lstatSync,
  };
  const fdPaths = new Map();
  const view = (stat, target) => {
    const key = stat && target !== undefined ? keyOf(target) : null;
    if (key !== rootKey && !key?.startsWith(rootKey + path.sep)) return stat;
    const override = overrides.get(key) || {};
    const permissions = override.mode ?? (stat.isDirectory() ? 0o700 : 0o600);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      uid: override.uid ?? FAKE_UID,
      mode: (stat.mode & ~0o777) | permissions,
    });
  };
  fs.openSync = (target, ...rest) => {
    const descriptor = real.openSync(target, ...rest);
    fdPaths.set(descriptor, target);
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    fdPaths.delete(descriptor);
    return real.closeSync(descriptor);
  };
  fs.fstatSync = (descriptor, ...rest) => view(real.fstatSync(descriptor, ...rest), fdPaths.get(descriptor));
  fs.lstatSync = (target, ...rest) => view(real.lstatSync(target, ...rest), target);
  Object.defineProperty(process, 'getuid', { value: () => FAKE_UID, configurable: true, writable: true });
  return () => {
    Object.assign(fs, real);
    delete process.getuid;
    overrides.clear();
  };
}

function setMode(target, mode) {
  if (POSIX) fs.chmodSync(target, mode);
  else overrides.set(keyOf(target), { ...overrides.get(keyOf(target)), mode });
}

// Run `fn` as if the current user were someone else: everything on disk is then
// owned by a different uid than process.getuid().
async function asAnotherUser(fn) {
  const original = process.getuid;
  process.getuid = () => HOST_UID + 1;
  try {
    return await fn();
  } finally {
    process.getuid = original;
  }
}

// Run `fn` with every opened regular file reporting another owner while the
// directories keep this user: only the account file's own ownership differs.
async function withForeignFileOwner(fn) {
  const real = fs.fstatSync;
  fs.fstatSync = (...args) => {
    const stat = real(...args);
    if (!stat.isFile()) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 });
  };
  try {
    return await fn();
  } finally {
    fs.fstatSync = real;
  }
}

// ---------------------------------------------------------------------------
// Harness: the real module on a faked linux host with a throwaway data dir
// ---------------------------------------------------------------------------
const MISSING = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });

function fakeSpawn(outcome) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (outcome === 'missing') return child.emit('error', MISSING);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1);
    });
    return child;
  };
}

const fakeSpawnSync = (outcome) => () =>
  outcome === 'missing' ? { error: MISSING, status: null } : { status: 1, stdout: '', stderr: '' };

// `outcome`: 'absent' = a reachable keyring that does not hold the account (a
// read then reaches the fallback file); 'missing' = no secret-tool at all.
async function withStore(outcome, fn) {
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const env = { MIXDOG_DATA_DIR: dataDir, MIXDOG_KEYCHAIN_CACHE_TTL_MS: '0' };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const realSpawn = childProcess.spawn;
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const restoreView = POSIX ? null : installPosixView(dataDir);
  Object.assign(process.env, env);
  childProcess.spawn = fakeSpawn(outcome);
  childProcess.spawnSync = fakeSpawnSync(outcome);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    return await fn({ keychain: require('./keychain-cjs.cjs'), dataDir });
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    childProcess.spawn = realSpawn;
    childProcess.spawnSync = realSpawnSync;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreView?.();
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
  }
}

function secretsDirOf(dataDir, dirMode = 0o700) {
  const dir = path.join(dataDir, 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  setMode(dir, dirMode);
  return dir;
}

// A stored account file with explicit modes (chmod, so the umask never decides).
function plant(dataDir, { dirMode = 0o700, fileMode = 0o600, account = ACCOUNT } = {}) {
  const dir = secretsDirOf(dataDir, dirMode);
  const file = path.join(dir, `${encodeURIComponent(account)}.secret`);
  fs.writeFileSync(file, SECRET);
  setMode(file, fileMode);
  return { dir, file };
}

// The value is never returned: the read throws the EUNSAFE reason (no secret in
// it) and every "is it stored?" probe says no.
async function assertRefused(keychain, account = ACCOUNT) {
  const reason = (error) => {
    assert.equal(error.code, 'EUNSAFE');
    assert.ok(!error.message.includes(SECRET), 'the reason never carries the value');
    return true;
  };
  assert.throws(() => keychain.getSecret(account), reason);
  await assert.rejects(keychain.getSecretAsync(account), reason);
  assert.equal(keychain.hasSecret(account), false);
  assert.equal(keychain.hasFallbackSecret(account), false);
}

async function assertServed(keychain, account = ACCOUNT) {
  assert.equal(keychain.getSecret(account), SECRET);
  assert.equal(await keychain.getSecretAsync(account), SECRET);
  assert.equal(keychain.hasSecret(account), true);
  assert.equal(keychain.hasFallbackSecret(account), true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('fallback read: a 0600 regular file in a 0700 directory owned by this user is served', async () => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    plant(dataDir);
    await assertServed(keychain);
    assert.equal(keychain.getSecret('nothing-stored'), null);
  });
});

test('fallback read: a file readable by group or other is refused, and served again once it is private', async () => {
  for (const fileMode of [0o640, 0o604, 0o644, 0o660, 0o666]) {
    await withStore('absent', async ({ keychain, dataDir }) => {
      const { file } = plant(dataDir, { fileMode });
      await assertRefused(keychain);
      setMode(file, 0o600);
      await assertServed(keychain);
    });
  }
});

test('fallback read: a permissive secrets directory is refused even around a 0600 file, and served again once it is private', async () => {
  for (const dirMode of [0o755, 0o750, 0o770, 0o707]) {
    await withStore('absent', async ({ keychain, dataDir }) => {
      const { dir } = plant(dataDir, { dirMode });
      await assertRefused(keychain);
      setMode(dir, 0o700);
      await assertServed(keychain);
    });
  }
});

test('fallback read: an account file owned by another user is refused', async () => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    plant(dataDir);
    await assertServed(keychain);
    await withForeignFileOwner(() => assertRefused(keychain));
    await assertServed(keychain);
  });
});

test('fallback read: a secrets directory owned by another user is refused', async () => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    plant(dataDir);
    await assertServed(keychain);
    await asAnotherUser(() => assertRefused(keychain));
    await assertServed(keychain);
  });
});

test('fallback read: a directory where the account file should be is refused', async () => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    fs.mkdirSync(path.join(secretsDirOf(dataDir), `${encodeURIComponent(ACCOUNT)}.secret`));
    await assertRefused(keychain);
  });
});

test('fallback read: a symlinked account file is refused, whatever it points at', { skip: NO_POSIX_SKIP }, async () => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    const dir = secretsDirOf(dataDir);
    const link = path.join(dir, `${encodeURIComponent(ACCOUNT)}.secret`);

    // A private file outside the store that holds a value: following the link would serve it.
    const outside = path.join(dataDir, 'outside.secret');
    fs.writeFileSync(outside, SECRET);
    fs.chmodSync(outside, 0o600);
    fs.symlinkSync(outside, link);
    await assertRefused(keychain);

    // A dangling link is refused too, not read as an absent account.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(dataDir, 'nowhere'), link);
    await assertRefused(keychain);
  });
});

test('fallback read: on a host with no keychain provider a refused file reads as absent and never as the value', async () => {
  await withStore('missing', async ({ keychain, dataDir }) => {
    const { file } = plant(dataDir, { fileMode: 0o644 });
    assert.throws(
      () => keychain.getSecret(ACCOUNT),
      (error) => {
        assert.match(error.message, /libsecret-tools/, 'the keychain error stands; the unsafe file is not an answer');
        assert.ok(!error.message.includes(SECRET));
        return true;
      }
    );
    await assert.rejects(keychain.getSecretAsync(ACCOUNT), /libsecret-tools/);
    assert.equal(keychain.hasSecret(ACCOUNT), false);
    assert.equal(keychain.hasFallbackSecret(ACCOUNT), false);
    setMode(file, 0o600);
    assert.equal(keychain.getSecret(ACCOUNT), SECRET);
    assert.equal(await keychain.getSecretAsync(ACCOUNT), SECRET);
  });
});

test('fallback read: saving repairs a permissive store (directory 0700, file replaced at 0600) so it reads again', {
  skip: NO_CHMOD_SKIP,
}, async () => {
  await withStore('missing', async ({ keychain, dataDir }) => {
    const { dir, file } = plant(dataDir, { dirMode: 0o755, fileMode: 0o644 });
    assert.equal(keychain.hasFallbackSecret(ACCOUNT), false);
    keychain.setSecret(ACCOUNT, `${SECRET}-new`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(keychain.getSecret(ACCOUNT), `${SECRET}-new`);
    assert.equal(keychain.hasFallbackSecret(ACCOUNT), true);
  });
});

test('fallback status: an unsafe store is reported with its directory and the kind of repair, never the value, and clears once repaired', async () => {
  const cases = [
    {
      name: 'group/other-readable file',
      kind: 'permissions',
      plantOptions: { fileMode: 0o644 },
      repair: (p) => setMode(p.file, 0o600),
    },
    {
      name: 'permissive directory',
      kind: 'permissions',
      plantOptions: { dirMode: 0o755 },
      repair: (p) => setMode(p.dir, 0o700),
    },
    {
      name: 'directory where the account file should be',
      kind: 'type',
      plantOptions: {},
      before: (p) => {
        fs.rmSync(p.file);
        fs.mkdirSync(p.file);
      },
      repair: (p) => fs.rmdirSync(p.file),
    },
  ];
  for (const { name, kind, plantOptions, before, repair } of cases) {
    await withStore('missing', async ({ keychain, dataDir }) => {
      keychain.setSecret('seed', 'v'); // no provider: confirms the fallback and notes it in the status
      const planted = plant(dataDir, plantOptions);
      before?.(planted);
      const status = keychain.keychainStatus();
      assert.equal(status.fallback, true, name);
      assert.deepEqual(status.unsafeStore, { path: planted.dir, kind }, name);
      assert.ok(!JSON.stringify(status).includes(SECRET), 'the status never carries the value');
      repair(planted);
      assert.equal(keychain.keychainStatus().unsafeStore, undefined, `${name}: repaired`);
    });
  }
  // A healthy store reports nothing.
  await withStore('missing', async ({ keychain, dataDir }) => {
    keychain.setSecret('seed', 'v');
    plant(dataDir);
    assert.equal(keychain.keychainStatus().unsafeStore, undefined);
  });
});

test('fallback status: a store owned by another user is reported as an owner problem', async () => {
  await withStore('missing', async ({ keychain, dataDir }) => {
    keychain.setSecret('seed', 'v');
    plant(dataDir);
    await asAnotherUser(async () => {
      const dirOwner = keychain.keychainStatus().unsafeStore;
      assert.equal(dirOwner.kind, 'owner');
      assert.equal(dirOwner.path, path.join(dataDir, 'secrets'));
    });
    // Only the account file's owner differs (the status scan lstats it).
    const realLstat = fs.lstatSync;
    fs.lstatSync = (...args) => {
      const stat = realLstat(...args);
      if (!stat.isFile()) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 });
    };
    try {
      assert.equal(keychain.keychainStatus().unsafeStore.kind, 'owner');
    } finally {
      fs.lstatSync = realLstat;
    }
  });
});

test('fallback status: a symlinked account file is reported as a type problem', { skip: NO_POSIX_SKIP }, async () => {
  await withStore('missing', async ({ keychain, dataDir }) => {
    const dir = secretsDirOf(dataDir);
    fs.symlinkSync(path.join(dataDir, 'nowhere'), path.join(dir, `${encodeURIComponent(ACCOUNT)}.secret`));
    keychain.setSecret('seed', 'v');
    assert.deepEqual(keychain.keychainStatus().unsafeStore, { path: dir, kind: 'type' });
  });
});

// Last on purpose: an unguarded read would block forever on the FIFO, and that
// must not hide the results of the cases above.
test('fallback read: a FIFO where the account file should be is refused without blocking', {
  skip: NO_POSIX_SKIP,
}, async (t) => {
  await withStore('absent', async ({ keychain, dataDir }) => {
    const file = path.join(secretsDirOf(dataDir), `${encodeURIComponent(ACCOUNT)}.secret`);
    try {
      childProcess.execFileSync('mkfifo', [file]);
    } catch {
      return t.skip('mkfifo is not available');
    }
    await assertRefused(keychain);
  });
});
