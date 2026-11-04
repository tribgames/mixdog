// macOS reads: each account is asked of the keychain by `find-generic-password`
// for that account alone (the only read command ever spawned). An answer, key or
// "not found", is cached for the life of the process (unless an explicit finite
// MIXDOG_KEYCHAIN_CACHE_TTL_MS bounds every platform's cache); it is replaced
// only by this process's own set/delete, an invalidation, or the first read of
// an account. Nothing is ever read in the background: only the awaited
// warm-up spawns an async `security`.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('./keychain-cjs.cjs');
const KEY = 'agent.openai.apiKey';
const OTHER = 'agent.xai.apiKey';
const findArgs = (account) => ['find-generic-password', '-a', account, '-s', 'mixdog', '-w'];

/** A darwin keychain module over a fake `security`: stored = account -> value.
 *  `locked` makes every find fail with something other than "not found". */
function darwinKeychain(stored) {
  const real = { spawnSync: childProcess.spawnSync, spawn: childProcess.spawn, now: Date.now };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const log = { sync: [], async: [] };
  const state = { locked: false, offset: 0 };
  const answer = (args) => {
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'add-generic-password') {
      stored.set(account, args[args.indexOf('-w') + 1]);
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') {
      stored.delete(account);
      return { status: 0, stdout: '' };
    }
    if (args[0] !== 'find-generic-password') throw new Error(`unexpected security command: ${args[0]}`);
    if (state.locked) return { status: 36, stdout: '' };
    return stored.has(account) ? { status: 0, stdout: `${stored.get(account)}\n` } : { status: 44, stdout: '' };
  };
  childProcess.spawnSync = (_cmd, args) => {
    log.sync.push(args);
    return { ...answer(args), stderr: '' };
  };
  childProcess.spawn = (_cmd, args) => {
    log.async.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const { status, stdout } = answer(args);
    const finish = () => {
      child.stdout.end(stdout);
      child.emit('close', status);
    };
    // `holdNext`: the answer is fixed now but delivered only on release().
    if (state.holdNext) {
      state.holdNext = false;
      state.release = finish;
    } else setImmediate(finish);
    return child;
  };
  Date.now = () => real.now() + state.offset;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  delete require.cache[modulePath];
  return {
    keychain: require(modulePath),
    log,
    state,
    advance(ms) {
      state.offset += ms;
    },
    async settle() {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    restore() {
      childProcess.spawnSync = real.spawnSync;
      childProcess.spawn = real.spawn;
      Date.now = real.now;
      Object.defineProperty(process, 'platform', platform);
      delete require.cache[modulePath];
    },
  };
}

test('a not-found read is remembered instead of respawning security(1)', () => {
  const { keychain, log, restore } = darwinKeychain(new Map());
  try {
    assert.equal(keychain.getSecret(KEY), null);
    assert.equal(keychain.getSecret(KEY), null);
    assert.equal(keychain.hasSecret(KEY), false);
    assert.equal(log.sync.length, 1);
  } finally {
    restore();
  }
});

test('the warm reads only the accounts it is given, each with the per-account find, and no read spawns after it', async () => {
  const { keychain, log, restore } = darwinKeychain(
    new Map([
      [KEY, 'sk-warm'],
      ['agent.someone-else.apiKey', 'not-ours'],
    ])
  );
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    assert.deepEqual(log.async, [findArgs(KEY), findArgs(OTHER)]);
    assert.equal(keychain.getSecret(KEY), 'sk-warm');
    assert.equal(keychain.getSecret(OTHER), null);
    assert.equal(keychain.hasSecret(OTHER), false);
    assert.deepEqual(log.sync, [], 'no synchronous security(1) call after the warm');
    assert.equal(log.async.length, 2, 'the cached reads started nothing');
  } finally {
    restore();
  }
});

test('a read entry never expires: far past 30 s no read of any kind spawns security, and an invalidation costs exactly one foreground read', async () => {
  const stored = new Map([
    [KEY, 'a1'],
    [OTHER, 'b1'],
  ]);
  const { keychain, log, advance, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    assert.deepEqual(log.async, [findArgs(KEY), findArgs(OTHER)]);
    advance(24 * 60 * 60 * 1000);
    stored.set(KEY, 'a2');
    assert.equal(keychain.getSecret(KEY), 'a1');
    assert.equal(keychain.hasSecret(KEY), true);
    assert.equal(await keychain.getSecretAsync(KEY), 'a1');
    assert.equal(keychain.getSecret(OTHER), 'b1');
    await settle();
    assert.deepEqual(log.sync, [], 'no synchronous security after the warm, however old the entry');
    assert.equal(log.async.length, 2, 'no async security after the warm either');

    keychain.invalidateSecretCache(KEY);
    assert.deepEqual(log.sync, [], 'the invalidation itself reads nothing');
    assert.equal(keychain.getSecret(KEY), 'a2');
    assert.equal(keychain.hasSecret(KEY), true);
    assert.equal(await keychain.getSecretAsync(KEY), 'a2');
    await settle();
    assert.deepEqual(log.sync, [findArgs(KEY)], 'exactly one foreground read, for that account alone');
    assert.equal(log.async.length, 2);
  } finally {
    restore();
  }
});

test('a cached miss never expires either: a key added outside the process shows up only after an invalidation', async () => {
  const stored = new Map();
  const { keychain, log, advance, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    stored.set(KEY, 'sk-cli');
    advance(24 * 60 * 60 * 1000);
    assert.equal(keychain.getSecret(KEY), null);
    assert.equal(keychain.hasSecret(KEY), false);
    assert.deepEqual(log.sync, []);
    keychain.invalidateSecretCache(KEY);
    assert.equal(keychain.getSecret(KEY), 'sk-cli');
    assert.equal(log.sync.length, 1);
  } finally {
    restore();
  }
});

test('an invalidated entry whose foreground read fails answers as an uncached read does, and reads again next time', async () => {
  const { keychain, state, log, restore } = darwinKeychain(new Map([[KEY, 'sk-kept']]));
  try {
    await keychain.prewarmSecrets([KEY]);
    keychain.invalidateSecretCache(KEY);
    state.locked = true;
    assert.equal(keychain.getSecret(KEY), null);
    state.locked = false;
    assert.equal(keychain.getSecret(KEY), 'sk-kept');
    assert.equal(log.sync.length, 2);
  } finally {
    restore();
  }
});

test('an account whose warm read failed caches nothing and reads in the foreground next', async () => {
  const { keychain, state, log, restore } = darwinKeychain(new Map([[KEY, 'sk-x']]));
  try {
    state.locked = true;
    await keychain.prewarmSecrets([KEY]);
    state.locked = false;
    assert.deepEqual(log.sync, []);
    assert.equal(keychain.getSecret(KEY), 'sk-x');
    assert.equal(log.async.length, 1, 'only the warm itself ran async');
  } finally {
    restore();
  }
});

test('an invalidation, named or full, starts no async security behind the caller', async () => {
  const stored = new Map([
    [KEY, 'a1'],
    [OTHER, 'b1'],
  ]);
  const { keychain, log, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    keychain.invalidateSecretCache(KEY);
    keychain.invalidateSecretCache();
    await settle();
    assert.equal(log.async.length, 2, 'only the warm spawned async');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('an invalidation drops the cached key, and the next foreground read asks the keychain', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, log, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    stored.set(KEY, 'new');
    keychain.invalidateSecretCache(KEY);
    assert.deepEqual(log.sync, []);
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.equal(log.sync.length, 1);
  } finally {
    restore();
  }
});

test('a full invalidation drops every cached account', async () => {
  const stored = new Map([
    [KEY, 'a1'],
    [OTHER, 'b1'],
  ]);
  const { keychain, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    stored.set(KEY, 'a2');
    stored.delete(OTHER);
    keychain.invalidateSecretCache();
    assert.equal(keychain.getSecret(KEY), 'a2');
    assert.equal(keychain.getSecret(OTHER), null);
  } finally {
    restore();
  }
});

test('an invalidation overtakes a first warm in flight: its old answer is dropped, not cached', async () => {
  for (const account of [KEY, undefined]) {
    const stored = new Map([[KEY, 'old']]);
    const { keychain, state, log, settle, restore } = darwinKeychain(stored);
    try {
      state.holdNext = true;
      const warm = keychain.prewarmSecrets([KEY]);
      await settle();
      assert.equal(log.async.length, 1, 'the warm read is out, unanswered');
      stored.set(KEY, 'new');
      keychain.invalidateSecretCache(account);
      state.release();
      await warm;
      await settle();
      assert.equal(log.async.length, 1, 'nothing re-reads it behind the warm');
      assert.deepEqual(log.sync, []);
      assert.equal(keychain.getSecret(KEY), 'new', 'the foreground read finds the new key');
    } finally {
      restore();
    }
  }
});

test('a later warm (the custom providers) reads its accounts after the first one, each once', async () => {
  const { keychain, log, restore } = darwinKeychain(
    new Map([
      [KEY, 'a'],
      ['agent.custom-1.apiKey', 'c'],
    ])
  );
  try {
    const first = keychain.prewarmSecrets([KEY]);
    const second = keychain.prewarmSecrets([KEY, 'agent.custom-1.apiKey']);
    await Promise.all([first, second]);
    assert.deepEqual(log.async, [findArgs(KEY), findArgs('agent.custom-1.apiKey')]);
    assert.equal(keychain.getSecret('agent.custom-1.apiKey'), 'c');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('this process storing or deleting a key is visible to the very next read, with no find spawned', async () => {
  const stored = new Map();
  const { keychain, log, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([OTHER]);
    assert.equal(keychain.getSecret(OTHER), null);
    keychain.setSecret(OTHER, 'sk-new');
    assert.equal(keychain.getSecret(OTHER), 'sk-new');
    keychain.deleteSecret(OTHER);
    assert.equal(keychain.getSecret(OTHER), null);
    assert.equal(log.sync.filter((args) => args[0] === 'find-generic-password').length, 0);
  } finally {
    restore();
  }
});

test("another process's new key is asked of the keychain once its invalidation arrives", async () => {
  const stored = new Map();
  const { keychain, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([OTHER]);
    assert.equal(keychain.getSecret(OTHER), null);
    stored.set(OTHER, 'sk-foreign');
    keychain.invalidateSecretCache(OTHER);
    assert.equal(keychain.getSecret(OTHER), 'sk-foreign');
  } finally {
    restore();
  }
});

test('only the per-account find-generic-password is ever spawned to read, warm and first reads included', async () => {
  const stored = new Map([[KEY, 'a']]);
  const { keychain, log, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    keychain.getSecret(KEY);
    keychain.getSecret(OTHER);
    keychain.getSecret('agent.unwarmed.apiKey');
    await settle();
    for (const args of [...log.sync, ...log.async]) {
      assert.equal(args.length, 6);
      assert.deepEqual(args.slice(0, 1), ['find-generic-password']);
      assert.deepEqual(args.slice(1, 2).concat(args.slice(3)), ['-a', '-s', 'mixdog', '-w']);
    }
    assert.equal(log.sync.length, 1, 'only the never-read account was read synchronously');
  } finally {
    restore();
  }
});

test('a cached keychain absence still resolves the fallback file credential, as an uncached read does', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-darwin-fallback-'));
  const savedDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { keychain, log, restore } = darwinKeychain(new Map());
  try {
    const dir = path.join(dataDir, 'secrets');
    const file = path.join(dir, `${encodeURIComponent(KEY)}.secret`);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(file, 'sk-from-file');
    fs.chmodSync(file, 0o600);
    assert.equal(keychain.getSecret(KEY), null, 'the keychain holds nothing and that absence is cached');
    // The file store is served on Linux only, so the platform changes once the
    // miss is cached: what is left of the macOS read is the cached absence.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.equal(keychain.getSecret(KEY), 'sk-from-file');
    assert.equal(await keychain.getSecretAsync(KEY), 'sk-from-file');
    assert.equal(keychain.hasSecret(KEY), true);
    assert.equal(log.sync.length, 1, 'the cached absence was not read again');
    assert.deepEqual(log.async, []);
  } finally {
    restore();
    if (savedDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = savedDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an awaited warm-up keeps the process alive until its callback runs, even when nothing else does', async () => {
  // A process whose only pending work is the warm-up: `security` answers after
  // 500 ms. If the awaited read were unref'd, the process would exit silently first.
  const script = `
    const cp = require('node:child_process');
    const realSpawn = cp.spawn;
    cp.spawn = (cmd, args, options) =>
      realSpawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write('sk-late\\\\n'), 500)"], options);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const keychain = require(${JSON.stringify(modulePath)});
    keychain.prewarmSecrets([${JSON.stringify(KEY)}]).then(() => {
      console.log('warmed:' + keychain.getSecret(${JSON.stringify(KEY)}));
    });
  `;
  const stdout = await new Promise((resolve, reject) => {
    childProcess.execFile(process.execPath, ['-e', script], { timeout: 20000 }, (error, out) =>
      error ? reject(error) : resolve(out)
    );
  });
  assert.equal(stdout.trim(), 'warmed:sk-late');
});
