import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('win32 setSecret passes the secret via stdin with a minimal env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-'));
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldData = process.env.MIXDOG_DATA_DIR;
  const oldSysRoot = process.env.SystemRoot;
  const calls = [];
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
  process.env.SOME_API_KEY = 'leaky';
  childProcess.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'Q0lQSEVS\n', stderr: '' };
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const modPath = require.resolve('./keychain-cjs.cjs');
    delete require.cache[modPath];
    const keychain = require('./keychain-cjs.cjs');
    const secret = "pa'ss wörd";
    keychain.setSecret('acct', secret);
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    assert.ok(!args.join(' ').includes('pa'), 'secret must not be in argv');
    assert.equal(Buffer.from(opts.input, 'base64').toString('utf8'), secret);
    assert.equal(opts.env.SOME_API_KEY, undefined);
    assert.equal(fs.readFileSync(path.join(dir, 'secrets', 'acct.dpapi'), 'utf8'), 'Q0lQSEVS');
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    childProcess.spawnSync = realSpawnSync;
    delete process.env.SOME_API_KEY;
    if (oldData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = oldData;
    if (oldSysRoot === undefined) delete process.env.SystemRoot;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('win32 deleteSecret is idempotent for a missing secret but surfaces real failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-del-'));
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realUnlink = fs.unlinkSync;
  const oldData = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const modPath = require.resolve('./keychain-cjs.cjs');
    delete require.cache[modPath];
    const keychain = require('./keychain-cjs.cjs');
    const file = path.join(dir, 'secrets', 'acct.dpapi');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    keychain.deleteSecret('acct');
    assert.equal(fs.existsSync(file), false);
    keychain.deleteSecret('acct');
    fs.unlinkSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    assert.throws(() => keychain.deleteSecret('acct'), /EPERM/);
  } finally {
    fs.unlinkSync = realUnlink;
    Object.defineProperty(process, 'platform', realPlatform);
    if (oldData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = oldData;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linux setSecretAsync rejects with an install hint when secret-tool is missing, without blocking', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldPath = process.env.PATH;
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-empty-'));
  process.env.PATH = emptyDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    const keychain = require('./keychain-cjs.cjs');
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const pending = keychain.setSecretAsync('acct', 'v');
    assert.equal(ticked, false, 'call returns a promise instead of blocking');
    await assert.rejects(pending, /libsecret-tools/);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env.PATH = oldPath;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// Fake `secret-tool` child: `behavior(args)` returns { stdout, stderr, code } or
// { hang: true } (a locked keyring waiting on its unlock prompt) or { enoent }.
let probeCalls = 0;
let secretToolCalls = 0;
function fakeSpawn(behavior) {
  return (cmd, args) => {
    if (cmd === 'gdbus') {
      probeCalls++;
      const probe = new EventEmitter();
      probe.stdout = new PassThrough();
      probe.stderr = new PassThrough();
      probe.kill = () => {};
      const p = behavior(['__probe']) || {};
      const method = args[args.indexOf('--method') + 1];
      const objectPath = args[args.indexOf('--object-path') + 1];
      // Mixdog's items as the Secret Service lists them: { account, locked? }.
      // Default: whatever the fake secret-tool search reports, locked when the
      // probe says so (other collections never matter — only Mixdog items do).
      const items =
        p.items ||
        [...String(behavior(['search', '--all', 'service', 'mixdog'])?.stderr || '').matchAll(/attribute\.account = (.+)/g)].map(
          (m) => ({ account: m[1], locked: !!p.locked })
        );
      const pathOf = (item) => `/org/freedesktop/secrets/collection/${item.locked ? 'login' : 'default'}/${items.indexOf(item)}`;
      const fail = (message) => {
        probe.stdout.end();
        probe.stderr.end(message);
        setImmediate(() => probe.emit('close', 1));
      };
      setTimeout(() => {
        if (p.missing) return probe.emit('error', Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' }));
        if (p.unreachable) return fail('Error: no such object');
        if (method.endsWith('.SearchItems')) {
          const list = (locked) =>
            items.filter((item) => !!item.locked === locked).map((item) => `objectpath '${pathOf(item)}'`);
          const array = (entries) => (entries.length ? `[${entries.join(', ')}]` : '@ao []');
          probe.stdout.end(`(${array(list(false))}, ${array(list(true))})\n`);
        } else {
          const item = items.find((candidate) => pathOf(candidate) === objectPath);
          if (!item || item.gone) return fail(`Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist at path “${objectPath}”`);
          probe.stdout.end(`(<{'account': '${item.account}', 'service': 'mixdog'}>,)\n`);
        }
        probe.stderr.end();
        setImmediate(() => probe.emit('close', 0));
      }, p.delay || 0);
      return probe;
    }
    assert.equal(cmd, 'secret-tool');
    secretToolCalls++;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null);
    };
    const result = behavior(args);
    setTimeout(() => {
      if (result.enoent) return child.emit('error', Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }));
      if (result.hang) return;
      child.stdout.end(result.stdout || '');
      child.stderr.end(result.stderr || '');
      setImmediate(() => child.emit('close', result.code ?? 0));
    }, result.delay || 0);
    return child;
  };
}

async function withLinuxKeychain(behavior, env, fn) {
  const realSpawn = childProcess.spawn;
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  childProcess.spawn = fakeSpawn(behavior);
  childProcess.spawnSync = () => assert.fail('sync secret-tool must never run on the daemon path');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    return await fn(require('./keychain-cjs.cjs'));
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    childProcess.spawn = realSpawn;
    childProcess.spawnSync = realSpawnSync;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
  }
}

test('linux: an unanswered unlock prompt never blocks the event loop and reports an unlock message', async () => {
  await withLinuxKeychain(
    (args) => (args[0] === '__probe' ? { locked: true, items: [{ account: 'acct', locked: true }] } : { hang: true }),
    { MIXDOG_KEYCHAIN_INTERACTIVE_TIMEOUT_MS: '300', MIXDOG_KEYCHAIN_RETRY_MS: '100000' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      const started = Date.now();
      assert.throws(() => keychain.getSecret('acct'), /keyring/i);
      assert.equal(keychain.hasSecret('acct'), false);
      assert.ok(Date.now() - started < 200, 'sync read returns immediately');
      let ticks = 0;
      const timer = setInterval(() => ticks++, 20);
      assert.equal(await keychain.retryKeychain({ interactive: true }), false);
      clearInterval(timer);
      assert.ok(ticks >= 5, `event loop kept running during the locked wait (${ticks} ticks)`);
      assert.equal(keychain.keychainStatus().state, 'locked');
      assert.match(keychain.keychainStatus().message, /Unlock your keyring/);
    }
  );
});

test('linux: prewarm snapshot serves sync reads; absent accounts read as null; async delete clears', async () => {
  // Real GNOME split: header/label/secret/... on stdout, attribute.* on stderr.
  const stdout = '[/org/x/1]\nlabel = mixdog acct\nsecret = s3cret\ncreated = 2024\nschema = org.freedesktop.Secret.Generic\n';
  const stderr = 'attribute.service = mixdog\nattribute.account = acct\n';
  await withLinuxKeychain(
    (args) =>
      args[0] === 'search'
        ? { stdout, stderr }
        : args[0] === 'lookup' && args[4] === 'acct'
          ? { stdout: 's3cret' }
          : args[0] === 'lookup'
            ? { code: 1 }
            : { code: 0 },
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(keychain.getSecret('acct'), 's3cret');
      assert.equal(keychain.hasSecret('acct'), true);
      assert.equal(keychain.getSecret('other'), null);
      await keychain.deleteSecretAsync('acct');
      assert.equal(keychain.getSecret('acct'), null);
      await keychain.setSecretAsync('fresh', 'v');
      assert.equal(keychain.getSecret('fresh'), 'v');
    }
  );
});

test('linux: missing secret-tool reports the libsecret-tools hint', async () => {
  await withLinuxKeychain(() => ({ enoent: true }), {}, async (keychain) => {
    await keychain.prewarmSecrets();
    assert.equal(keychain.keychainStatus().state, 'missing');
    assert.match(keychain.keychainStatus().message, /libsecret-tools/);
    assert.throws(() => keychain.getSecret('acct'), /libsecret-tools/);
    await assert.rejects(keychain.deleteSecretAsync('acct'), /libsecret-tools/);
  });
});

test('linux: a locked item list is not cached as loaded; an unlock is picked up without any read', async () => {
  let unlocked = false;
  await withLinuxKeychain(
    (args) => {
      if (args[0] === '__probe') return { items: [{ account: 'acct', locked: !unlocked }] };
      return args[0] === 'lookup' ? { stdout: 's3cret' } : { code: 1 };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '50' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      // The internal detail never reaches the user-facing message.
      assert.doesNotMatch(keychain.keychainStatus().message, /attribute|snapshot|item\(s\)|passive|collection/);
      assert.throws(() => keychain.getSecret('acct'), /unlock it/);
      unlocked = true;
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(keychain.getSecret('acct'), 's3cret');
      assert.equal(keychain.keychainStatus().state, 'ok');
    }
  );
});

test('linux: an interactive search that only lists items without attributes is still locked, not loaded', async () => {
  await withLinuxKeychain(
    (args) =>
      args[0] === '__probe'
        ? { locked: true, items: [{ account: 'acct', locked: true }] }
        : args[0] === 'search'
          ? { stdout: '[/org/x/1]\nsecret = s3cret\n' }
          : { code: 1 },
    { MIXDOG_KEYCHAIN_RETRY_MS: '100000' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(await keychain.retryKeychain({ interactive: true }), false);
      assert.equal(keychain.keychainStatus().state, 'locked');
      assert.throws(() => keychain.getSecret('acct'), /unlock it/);
    }
  );
});

test('linux: prewarm is bounded as a whole (search + lookups) and a background retry picks up an unlock without any read', async () => {
  let unlocked = false;
  await withLinuxKeychain(
    (args) => {
      if (args[0] === 'search') return { stdout: '[/org/x/1]\nsecret = s\n', stderr: 'attribute.account = acct\n' };
      return unlocked ? { stdout: 's3cret' } : { hang: true };
    },
    { MIXDOG_KEYCHAIN_PREWARM_TIMEOUT_MS: '300', MIXDOG_KEYCHAIN_RETRY_MS: '60' },
    async (keychain) => {
      let recovered = 0;
      keychain.onKeychainRecovered(() => recovered++);
      const started = Date.now();
      await keychain.prewarmSecrets();
      assert.ok(Date.now() - started < 600, 'search and lookups share one deadline');
      assert.equal(keychain.keychainStatus().state, 'locked');
      unlocked = true;
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(recovered, 1);
      assert.equal(keychain.getSecret('acct'), 's3cret');
    }
  );
});

test('linux: background retry never runs secret-tool (no unlock prompt) while the keyring is locked; unlock then recovers; interactive retry may prompt', async () => {
  let locked = true;
  probeCalls = 0;
  secretToolCalls = 0;
  await withLinuxKeychain(
    (args) => {
      if (args[0] === '__probe') return { locked };
      if (args[0] === 'search') return { stdout: '[/org/x/1]\nsecret = s\n', stderr: 'attribute.account = acct\n' };
      return { stdout: 's3cret' };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '40' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(secretToolCalls, 0, 'passive probing must not call secret-tool');
      assert.ok(probeCalls >= 3, 'background probe keeps polling');
      locked = false;
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(keychain.getSecret('acct'), 's3cret');
      // The keyring locking after a successful read is detected passively.
      locked = true;
      await keychain.refreshKeychainStatus();
      assert.equal(keychain.keychainStatus().state, 'locked');
    }
  );
  // An explicit user action (Unlock button) is allowed to reach secret-tool.
  secretToolCalls = 0;
  let unlocked = false;
  const searches = [];
  await withLinuxKeychain(
    (args) => {
      if (args[0] === '__probe') return { items: [{ account: 'acct', locked: !unlocked }] };
      if (args[0] === 'search') {
        searches.push(args);
        unlocked = true; // `--unlock` raises the prompt; answering it unlocks
        return { stdout: '[/org/x/1]\nsecret = s\n', stderr: 'attribute.account = acct\n' };
      }
      return { stdout: 's3cret' };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '100000' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      assert.equal(searches.length, 0, 'passive prewarm raised no prompt');
      assert.equal(await keychain.retryKeychain({ interactive: true }), true);
      assert.equal(searches.length, 1);
      assert.ok(searches[0].includes('--unlock'), 'only --unlock makes secret-tool prompt');
      assert.equal(keychain.getSecret('acct'), 's3cret');
    }
  );
});

const SEARCH_ONE = { stdout: '[/org/x/1]\nsecret = s\n', stderr: 'attribute.account = acct\n' };

async function passiveCase(probe, expectState) {
  secretToolCalls = 0;
  await withLinuxKeychain(
    (args) => (args[0] === '__probe' ? probe : args[0] === 'search' ? SEARCH_ONE : { stdout: 's3cret' }),
    { MIXDOG_KEYCHAIN_RETRY_MS: '30' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(keychain.keychainStatus().state, expectState);
      if (expectState === 'ok') {
        assert.ok(secretToolCalls > 0);
        assert.equal(keychain.getSecret('acct'), 's3cret');
      } else {
        assert.equal(secretToolCalls, 0, 'passive paths must never run secret-tool: ' + expectState);
        assert.doesNotMatch(keychain.keychainStatus().message, /gdbus|org\.freedesktop|exit \d/);
      }
    }
  );
}

test('linux passive probe: gdbus missing -> unreachable, secret-tool never runs', async () => {
  await passiveCase({ missing: true }, 'unreachable');
});
test('linux passive probe: Secret Service unreachable -> unreachable', async () => {
  await passiveCase({ unreachable: true }, 'unreachable');
});
test('linux passive probe: Mixdog items in a locked collection -> locked, no secret-tool', async () => {
  await passiveCase({ items: [{ account: 'acct', locked: true }] }, 'locked');
});
test('linux passive probe: Mixdog items unlocked -> snapshot runs', async () => {
  await passiveCase({ items: [{ account: 'acct' }] }, 'ok');
});

test('linux: a locked collection without Mixdog items does not make the unlocked Default keyring read as locked', async () => {
  // Real VM state: Default (holds the items) unlocked, Login locked and empty.
  // SearchItems only reports Mixdog's items, so the Login collection is moot.
  const calls = [];
  await withLinuxKeychain(
    (args) => {
      calls.push(args[0]);
      return args[0] === '__probe' ? { items: [{ account: 'acct' }, { account: 'other' }] } : { stdout: 's3cret' };
    },
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(keychain.getSecret('acct'), 's3cret');
      assert.ok(!calls.includes('search'), 'no secret-tool search: items are listed through D-Bus');
    }
  );
});

test('linux: unlocked items stay readable while other Mixdog items sit in a locked collection; nothing prompts', async () => {
  const calls = [];
  await withLinuxKeychain(
    (args) => {
      calls.push(args[0]);
      return args[0] === '__probe'
        ? { items: [{ account: 'acct' }, { account: 'hidden', locked: true }] }
        : { stdout: args[4] === 'acct' ? 's3cret' : '' };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '100000' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      assert.equal(keychain.getSecret('acct'), 's3cret', 'the readable item is not refused');
      assert.throws(() => keychain.getSecret('hidden'), /unlock it/, 'an uncached account is locked, not absent');
      assert.deepEqual([...new Set(calls)].filter((c) => c === 'search' || c === 'store' || c === 'clear'), []);
      assert.equal(calls.filter((c) => c === 'lookup').length, 1, 'only the unlocked item was looked up');
    }
  );
});

test('linux: an item the keyring lists but no longer has is skipped, not a snapshot failure', async () => {
  await withLinuxKeychain(
    (args) =>
      args[0] === '__probe'
        ? { items: [{ account: 'gone', gone: true }, { account: 'acct' }] }
        : { stdout: 's3cret' },
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(keychain.getSecret('acct'), 's3cret');
      assert.equal(keychain.getSecret('gone'), null);
    }
  );
});

test('linux: no Mixdog item at all still runs the secret-tool listing (proves the tool is installed)', async () => {
  secretToolCalls = 0;
  await withLinuxKeychain(
    (args) => (args[0] === '__probe' ? { items: [] } : { enoent: true }),
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'missing');
      assert.equal(secretToolCalls, 1);
    }
  );
});

test('linux: explicit interactive retry from an unreachable state may run secret-tool', async () => {
  secretToolCalls = 0;
  await withLinuxKeychain(
    (args) => (args[0] === '__probe' ? { unreachable: true } : args[0] === 'search' ? SEARCH_ONE : { stdout: 's3cret' }),
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'unreachable');
      assert.equal(await keychain.retryKeychain({ interactive: true }), true);
    }
  );
});

test('linux snapshot refresh picks up external add / replace / delete (replace, not merge)', async () => {
  const store = { a: 'one', b: 'bee' };
  const search = () => ({
    stdout: Object.keys(store).map((_, i) => `[/org/x/${i}]\nsecret = s\n`).join(''),
    stderr: Object.keys(store).map((k) => `attribute.account = ${k}\n`).join(''),
  });
  await withLinuxKeychain(
    (args) => (args[0] === 'search' ? search() : args[0] === 'lookup' ? (args[4] in store ? { stdout: store[args[4]] } : { code: 1 }) : { code: 0 }),
    { MIXDOG_KEYCHAIN_SNAPSHOT_TTL_MS: '0' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.getSecret('a'), 'one');
      store.a = 'two'; // replaced externally
      store.c = 'sea'; // added externally
      delete store.b; // deleted externally
      assert.equal(await keychain.refreshKeychainStatus(), true);
      assert.equal(keychain.getSecret('a'), 'two');
      assert.equal(keychain.getSecret('c'), 'sea');
      assert.equal(keychain.getSecret('b'), null);
      assert.equal(await keychain.refreshKeychainStatus(), false, 'unchanged snapshot reports no change');
    }
  );
});

test('linux snapshot never overwrites a newer same-process set / delete', async () => {
  await withLinuxKeychain(
    (args) =>
      args[0] === 'search'
        ? { stdout: '[/org/x/1]\nsecret = s\n[/org/x/2]\nsecret = s\n', stderr: 'attribute.account = a\nattribute.account = b\n' }
        : args[0] === 'lookup'
          ? { stdout: 'stale', delay: 40 }
          : { code: 0 },
    { MIXDOG_KEYCHAIN_SNAPSHOT_TTL_MS: '0' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      const refresh = keychain.refreshKeychainStatus(); // lookups are slow
      await new Promise((r) => setTimeout(r, 10));
      // search finished instantly; the slow lookups are in flight
      await keychain.setSecretAsync('a', 'fresh');
      await keychain.deleteSecretAsync('b');
      await refresh;
      assert.equal(keychain.getSecret('a'), 'fresh');
      assert.equal(keychain.getSecret('b'), null);
    }
  );
});

test('linux: raw secret-tool stderr never reaches user-facing errors', async () => {
  await withLinuxKeychain(
    (args) => (args[0] === 'store' ? { code: 1, stderr: 'secret-tool: /home/u/.secret-detail DBUS_X boom' } : {}),
    {},
    async (keychain) => {
      await assert.rejects(keychain.setSecretAsync('acct', 'v'), (error) => {
        assert.doesNotMatch(error.message, /home\/u|DBUS_X|boom/);
        return true;
      });
    }
  );
});
test('linux: Unlock keyring raises exactly one prompt, also while a passive retry is in flight or clicked twice', async () => {
  let searches = 0;
  let unlocked = false;
  await withLinuxKeychain(
    (args) => {
      if (args[0] === '__probe') return { delay: 120, items: [{ account: 'acct', locked: !unlocked }] };
      if (args[0] === 'search') {
        searches++;
        unlocked = true; // the prompt unlocks the collection
        return { stdout: '[/org/x/1]\nsecret = s\n', stderr: 'attribute.account = acct\n', delay: 80 };
      }
      return { stdout: 's3cret' };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '40' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'locked');
      // The background retry is now polling passively (slow gdbus); click twice meanwhile.
      await new Promise((r) => setTimeout(r, 60));
      const results = await Promise.all([
        keychain.retryKeychain({ interactive: true }),
        keychain.retryKeychain({ interactive: true }),
      ]);
      assert.equal(searches, 1, 'exactly one secret-tool prompt');
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.ok(results.includes(true));
      assert.equal(keychain.getSecret('acct'), 's3cret');
    }
  );
});

test('linux: a declined prompt is not asked again by the second click already waiting on it', async () => {
  let searches = 0;
  await withLinuxKeychain(
    (args) => {
      if (args[0] === '__probe') return { items: [{ account: 'acct', locked: true }] };
      if (args[0] === 'search') {
        searches++;
        return { code: 1, stderr: 'secret-tool: prompt dismissed', delay: 60 };
      }
      return { code: 1 };
    },
    { MIXDOG_KEYCHAIN_RETRY_MS: '100000' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      await Promise.all([keychain.retryKeychain({ interactive: true }), keychain.retryKeychain({ interactive: true })]);
      assert.equal(searches, 1);
      assert.equal(keychain.keychainStatus().state, 'locked');
    }
  );
});

test('linux: a focus re-check (force) re-snapshots before the TTL, a plain refresh does not', async () => {
  const store = { a: 'one' };
  await withLinuxKeychain(
    (args) =>
      args[0] === '__probe'
        ? { items: Object.keys(store).map((account) => ({ account })) }
        : args[0] === 'lookup'
          ? args[4] in store
            ? { stdout: store[args[4]] }
            : { code: 1 }
          : { code: 0 },
    { MIXDOG_KEYCHAIN_SNAPSHOT_TTL_MS: '600000', MIXDOG_KEYCHAIN_RECHECK_MIN_MS: '0' },
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.getSecret('a'), 'one');
      store.b = 'bee'; // secret-tool store
      delete store.a; // secret-tool clear
      assert.equal(await keychain.refreshKeychainStatus(), false, 'within the TTL nothing is re-read');
      assert.equal(keychain.getSecret('a'), 'one');
      assert.equal(await keychain.refreshKeychainStatus({ force: true }), true);
      assert.equal(keychain.getSecret('a'), null);
      assert.equal(keychain.getSecret('b'), 'bee');
    }
  );
});
