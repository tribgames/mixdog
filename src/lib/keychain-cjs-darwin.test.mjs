// macOS reads: each account is asked of the keychain by `find-generic-password`
// for that account alone (the only read command ever spawned), answers are cached
// with their read time, and an answer past 30 s is served as is and re-read in
// the background. No read blocks once the warm has run.
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
 *  `locked` makes every find fail with something other than "not found".
 *  `live` makes every async find a real, long-lived process that never answers
 *  (spawned with the options the module passed), for what a real child holds. */
function darwinKeychain(stored) {
  const real = { spawnSync: childProcess.spawnSync, spawn: childProcess.spawn, now: Date.now };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const log = { sync: [], async: [] };
  const state = { locked: false, offset: 0, live: false, liveChildren: [] };
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
  childProcess.spawnSync = (cmd, args) => {
    log.sync.push(args);
    return { ...answer(args), stderr: '' };
  };
  childProcess.spawn = (cmd, args, options) => {
    log.async.push(args);
    if (state.live) {
      const live = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      state.liveChildren.push(live);
      return live;
    }
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    // The calls that let a real child and its pipes stop holding the process; the fake holds nothing.
    for (const handle of [child, child.stdout, child.stderr]) {
      handle.ref = () => {};
      handle.unref = () => {};
    }
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
      for (const live of state.liveChildren) live.kill();
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
  const { keychain, log, restore } = darwinKeychain(new Map([[KEY, 'sk-warm'], ['agent.someone-else.apiKey', 'not-ours']]));
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

test('a cached key replaced outside the process is served once, then re-read for that account alone', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, log, advance, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    stored.set(KEY, 'new');
    advance(29000);
    assert.equal(keychain.getSecret(KEY), 'old');
    await settle();
    assert.equal(log.async.length, 1, 'inside 30 s nothing is re-read');
    advance(2000);
    assert.equal(keychain.getSecret(KEY), 'old', 'the stale read answers at once from the cache');
    assert.equal(log.async.length, 2, 'and starts the re-read');
    assert.deepEqual(log.async[1], findArgs(KEY));
    await settle();
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('a cached key deleted outside the process stops being used within 30 s of the next read', async () => {
  const stored = new Map([[KEY, 'sk-gone']]);
  const { keychain, log, advance, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    stored.delete(KEY);
    advance(31000);
    assert.equal(keychain.getSecret(KEY), 'sk-gone');
    await settle();
    assert.equal(keychain.getSecret(KEY), null);
    assert.equal(keychain.hasSecret(KEY), false);
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('a miss turns into a hit when the key appears outside the process', async () => {
  const stored = new Map();
  const { keychain, advance, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    assert.equal(keychain.getSecret(KEY), null);
    stored.set(KEY, 'sk-cli');
    advance(31000);
    assert.equal(keychain.getSecret(KEY), null);
    await settle();
    assert.equal(keychain.getSecret(KEY), 'sk-cli');
  } finally {
    restore();
  }
});

test('concurrent stale reads of one account share one re-read', async () => {
  const { keychain, log, advance, settle, restore } = darwinKeychain(new Map([[KEY, 'v']]));
  try {
    await keychain.prewarmSecrets([KEY]);
    advance(31000);
    keychain.getSecret(KEY);
    keychain.getSecret(KEY);
    keychain.hasSecret(KEY);
    await settle();
    assert.equal(log.async.length, 2, 'the warm plus a single re-read');
  } finally {
    restore();
  }
});

test('a re-read that fails for another reason than not-found keeps the cached key and is never repeated in the background', async () => {
  const { keychain, state, advance, settle, log, restore } = darwinKeychain(new Map([[KEY, 'sk-kept']]));
  try {
    await keychain.prewarmSecrets([KEY]);
    state.locked = true;
    advance(31000);
    keychain.getSecret(KEY);
    await settle();
    state.locked = false;
    advance(31000);
    assert.equal(keychain.getSecret(KEY), 'sk-kept');
    await settle();
    assert.equal(log.async.length, 2, 'the warm and the one failed re-read, nothing after');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('an account whose foreground read failed is not read in the background and reads again in the foreground', async () => {
  const { keychain, state, log, advance, settle, restore } = darwinKeychain(new Map([[KEY, 'sk-denied']]));
  try {
    state.locked = true;
    assert.equal(keychain.getSecret(KEY), null);
    state.locked = false;
    advance(31000);
    keychain.invalidateSecretCache(KEY);
    await settle();
    assert.deepEqual(log.async, [], 'nothing is read behind the foreground');
    assert.equal(keychain.getSecret(KEY), 'sk-denied', 'the next foreground read behaves as it always did');
    assert.equal(log.sync.length, 2);
  } finally {
    restore();
  }
});

test('an account whose warm read failed is not re-read in the background', async () => {
  const { keychain, state, log, advance, settle, restore } = darwinKeychain(new Map([[KEY, 'sk-x']]));
  try {
    state.locked = true;
    await keychain.prewarmSecrets([KEY]);
    state.locked = false;
    advance(31000);
    keychain.invalidateSecretCache(KEY);
    await settle();
    assert.equal(log.async.length, 1, 'only the warm itself');
  } finally {
    restore();
  }
});

test('an invalidation serves the cached key, re-reads in the background, then serves the new key with no sync spawn', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, log, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY]);
    stored.set(KEY, 'new');
    keychain.invalidateSecretCache(KEY);
    assert.equal(keychain.getSecret(KEY), 'old', 'the cached key answers while the re-read runs');
    assert.deepEqual(log.sync, []);
    await settle();
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.deepEqual(log.sync, [], 'no synchronous spawn at any step');
  } finally {
    restore();
  }
});

test('a full invalidation re-reads every cached account in the background, one at a time', async () => {
  const stored = new Map([[KEY, 'a1'], [OTHER, 'b1']]);
  const { keychain, log, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    stored.set(KEY, 'a2');
    stored.delete(OTHER);
    keychain.invalidateSecretCache();
    assert.equal(keychain.getSecret(KEY), 'a1');
    await settle();
    assert.equal(keychain.getSecret(KEY), 'a2');
    assert.equal(keychain.getSecret(OTHER), null);
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('a full invalidation overtakes a first warm in flight: its old answer is dropped and the new key arrives with no sync spawn', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, state, log, settle, restore } = darwinKeychain(stored);
  try {
    state.holdNext = true;
    const warm = keychain.prewarmSecrets([KEY]);
    await settle();
    assert.equal(log.async.length, 1, 'the warm read is out, unanswered');
    stored.set(KEY, 'new');
    keychain.invalidateSecretCache();
    state.release();
    await warm;
    await settle();
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.equal(log.async.length, 2, 'the account was read again in the background');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('the warm resolves only once the replacement read has landed, so the next read spawns nothing', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, state, log, settle, restore } = darwinKeychain(stored);
  try {
    state.holdNext = true;
    const warm = keychain.prewarmSecrets([KEY]);
    await settle();
    const releaseOld = state.release;
    stored.set(KEY, 'new');
    state.holdNext = true; // hold the replacement read as well
    keychain.invalidateSecretCache(KEY);
    assert.equal(log.async.length, 2);
    const releaseReplacement = state.release;
    let warmed = false;
    void warm.then(() => {
      warmed = true;
    });
    releaseOld();
    await settle();
    assert.equal(warmed, false, 'the dropped old answer does not finish the warm');
    releaseReplacement();
    await warm;
    // Read straight after the warm, before anything else settles.
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('a named invalidation overtakes a first warm in flight the same way', async () => {
  const stored = new Map([[KEY, 'old']]);
  const { keychain, state, log, settle, restore } = darwinKeychain(stored);
  try {
    state.holdNext = true;
    const warm = keychain.prewarmSecrets([KEY]);
    await settle();
    stored.set(KEY, 'new');
    keychain.invalidateSecretCache(KEY);
    state.release();
    await warm;
    await settle();
    assert.equal(keychain.getSecret(KEY), 'new');
    assert.deepEqual(log.sync, []);
  } finally {
    restore();
  }
});

test('a later warm (the custom providers) reads its accounts after the first one, each once', async () => {
  const { keychain, log, restore } = darwinKeychain(new Map([[KEY, 'a'], ['agent.custom-1.apiKey', 'c']]));
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
  const { keychain, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([OTHER]);
    assert.equal(keychain.getSecret(OTHER), null);
    stored.set(OTHER, 'sk-foreign');
    keychain.invalidateSecretCache(OTHER);
    await settle();
    assert.equal(keychain.getSecret(OTHER), 'sk-foreign');
  } finally {
    restore();
  }
});

test('only the per-account find-generic-password is ever spawned to read, warm and refresh included', async () => {
  const stored = new Map([[KEY, 'a']]);
  const { keychain, log, advance, settle, restore } = darwinKeychain(stored);
  try {
    await keychain.prewarmSecrets([KEY, OTHER]);
    advance(31000);
    keychain.getSecret(KEY);
    keychain.getSecret(OTHER);
    keychain.getSecret('agent.unwarmed.apiKey');
    await settle();
    for (const args of [...log.sync, ...log.async]) {
      assert.equal(args.length, 6);
      assert.deepEqual(args.slice(0, 1), ['find-generic-password']);
      assert.deepEqual(args.slice(1, 2).concat(args.slice(3)), ['-a', '-s', 'mixdog', '-w']);
    }
    assert.equal(log.sync.length, 1, 'only the never-warmed account was read synchronously');
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

test('a background re-read holds neither its child, its pipes nor a timer, and is still stopped at the bound', async () => {
  const savedTimeout = process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS;
  process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS = '1000';
  const { keychain, state, advance, settle, restore } = darwinKeychain(new Map([[KEY, 'v']]));
  // What keeps the event loop (hence the process) running: the child, its pipes, referenced timers.
  const holding = () => {
    const counts = {};
    for (const type of process.getActiveResourcesInfo()) {
      if (/^(Process|Pipe|Timeout)/.test(type)) counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  };
  try {
    await keychain.prewarmSecrets([KEY]);
    await settle();
    const before = holding();
    // The stale-cache re-read is the background one: nobody awaits it.
    state.live = true;
    advance(31000);
    assert.equal(keychain.getSecret(KEY), 'v');
    await settle();
    assert.equal(state.liveChildren.length, 1, 'the stale read started its re-read');
    assert.equal(state.liveChildren[0].exitCode, null, 'and security has not answered');
    const closed = new Promise((resolve) => state.liveChildren[0].once('close', resolve));
    assert.deepEqual(holding(), before, 'nothing the background read started keeps the process alive');
    // Only the test keeps the loop running now, until the bound kills the child that never answers.
    const keepAlive = setTimeout(() => {}, 30000);
    try {
      await closed;
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(state.liveChildren[0].killed, true, 'the bound still stops a security that never answers');
  } finally {
    restore();
    if (savedTimeout === undefined) delete process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS;
    else process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS = savedTimeout;
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
