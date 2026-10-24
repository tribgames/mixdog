import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
// Captured before any test overrides process.platform.
const HOST_PLATFORM = process.platform;
// Every test runs against a throwaway data dir: the Linux fallback file is looked
// up (and a superseded one removed) under `<dataDir>/secrets` even when the
// keychain works, and must never touch the real profile.
const FILE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-file-'));
process.env.MIXDOG_DATA_DIR = FILE_DATA_DIR;
after(() => {
  fs.rmSync(FILE_DATA_DIR, { recursive: true, force: true });
});

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

test('linux setSecretAsync without secret-tool stores into the private file, without blocking', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldPath = process.env.PATH;
  const oldData = process.env.MIXDOG_DATA_DIR;
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-empty-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-data-'));
  process.env.PATH = emptyDir;
  process.env.MIXDOG_DATA_DIR = dataDir;
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
    await pending;
    assert.equal(fs.readFileSync(path.join(dataDir, 'secrets', 'acct.secret'), 'utf8'), 'v');
    // The install hint is still the keychain status; the fallback is not a failure to report.
    assert.equal(keychain.keychainStatus().state, 'missing');
    assert.match(keychain.keychainStatus().message, /libsecret-tools/);
    assert.equal(keychain.keychainStatus().fallback, true);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env.PATH = oldPath;
    if (oldData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = oldData;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
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
        [
          ...String(behavior(['search', '--all', 'service', 'mixdog'])?.stderr || '').matchAll(
            /attribute\.account = (.+)/g
          ),
        ].map((m) => ({ account: m[1], locked: !!p.locked }));
      const pathOf = (item) =>
        `/org/freedesktop/secrets/collection/${item.locked ? 'login' : 'default'}/${items.indexOf(item)}`;
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
          if (!item || item.gone)
            return fail(
              `Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist at path “${objectPath}”`
            );
          probe.stdout.end(`(<{'account': '${item.account}', 'service': 'mixdog'}>,)\n`);
        }
        probe.stderr.end();
        setImmediate(() => probe.emit('close', 0));
      }, p.delay || 0);
      return probe;
    }
    assert.equal(cmd, 'secret-tool');
    // The availability probe never touches the keyring; it is not a keyring call.
    if (args[0] !== '--version') secretToolCalls++;
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
      if (result.enoent)
        return child.emit('error', Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }));
      if (result.hang) return;
      child.stdout.end(result.stdout || '');
      child.stderr.end(result.stderr || '');
      setImmediate(() => child.emit('close', result.code ?? 0));
    }, result.delay || 0);
    return child;
  };
}

async function withLinuxKeychain(behavior, env, fn, syncSpawn) {
  const realSpawn = childProcess.spawn;
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  childProcess.spawn = fakeSpawn(behavior);
  childProcess.spawnSync = syncSpawn || (() => assert.fail('sync secret-tool must never run on the daemon path'));
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
  const stdout =
    '[/org/x/1]\nlabel = mixdog acct\nsecret = s3cret\ncreated = 2024\nschema = org.freedesktop.Secret.Generic\n';
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
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.prewarmSecrets();
        assert.equal(keychain.keychainStatus().state, 'missing');
        assert.match(keychain.keychainStatus().message, /libsecret-tools/);
        // Nothing in the fallback file: the keychain error stands for a read.
        assert.throws(() => keychain.getSecret('acct'), /libsecret-tools/);
        assert.equal(keychain.hasSecret('acct'), false);
        // No keychain provider, so there is nothing in it to delete.
        await keychain.deleteSecretAsync('acct');
      }
    );
  });
});

async function withTempDataDir(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-fallback-'));
  try {
    return await fn(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const SECRETS_FILE_MODE_CHECKABLE = HOST_PLATFORM !== 'win32';
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const SECRET = 'sk-test-fallback-secret-0123456789';

test('linux fallback: with no secret-tool, save / read / delete work through an owner-only file', async () => {
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.prewarmSecrets();
        assert.equal(keychain.keychainStatus().state, 'missing');
        await keychain.setSecretAsync('agent.openai.apiKey', SECRET);

        const file = path.join(dataDir, 'secrets', 'agent.openai.apiKey.secret');
        assert.equal(fs.readFileSync(file, 'utf8'), SECRET);
        if (SECRETS_FILE_MODE_CHECKABLE) {
          assert.equal(modeOf(file), 0o600);
          assert.equal(modeOf(path.dirname(file)), 0o700);
        }
        assert.deepEqual(
          fs.readdirSync(path.dirname(file)),
          ['agent.openai.apiKey.secret'],
          'no temporary file is left behind'
        );

        // A cold read (cache dropped, e.g. after a restart) comes from the file.
        keychain.invalidateSecretCache();
        assert.equal(keychain.getSecret('agent.openai.apiKey'), SECRET);
        assert.equal(keychain.hasSecret('agent.openai.apiKey'), true);
        assert.equal(await keychain.getSecretAsync('agent.openai.apiKey'), SECRET);
        assert.equal(keychain.hasSecret('agent.other.apiKey'), false);

        // The fallback is a working store, not a failure.
        assert.equal(keychain.keychainStatus().fallback, true);

        // Replacing keeps one file; deleting removes it, and reads see nothing.
        await keychain.setSecretAsync('agent.openai.apiKey', `${SECRET}-2`);
        keychain.invalidateSecretCache();
        assert.equal(keychain.getSecret('agent.openai.apiKey'), `${SECRET}-2`);
        await keychain.deleteSecretAsync('agent.openai.apiKey');
        assert.equal(fs.existsSync(file), false);
        keychain.invalidateSecretCache();
        assert.equal(keychain.hasSecret('agent.openai.apiKey'), false);
        assert.throws(() => keychain.getSecret('agent.openai.apiKey'), /libsecret-tools/);
      }
    );
  });
});

test('linux fallback: sync setSecret / getSecret / deleteSecret use the file when secret-tool is missing', async () => {
  const missing = () => ({
    error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }),
    status: null,
  });
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        keychain.setSecret('acct', SECRET);
        const file = path.join(dataDir, 'secrets', 'acct.secret');
        assert.equal(fs.readFileSync(file, 'utf8'), SECRET);
        if (SECRETS_FILE_MODE_CHECKABLE) assert.equal(modeOf(file), 0o600);
        keychain.invalidateSecretCache();
        assert.equal(keychain.getSecret('acct'), SECRET);
        keychain.deleteSecret('acct');
        assert.equal(fs.existsSync(file), false);
        keychain.invalidateSecretCache();
        assert.equal(keychain.hasSecret('acct'), false);
      },
      missing
    );
  });
});

test('linux fallback: an account name cannot escape the secrets directory', async () => {
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('../../escape/acct', SECRET);
        const names = fs.readdirSync(path.join(dataDir, 'secrets'));
        assert.equal(names.length, 1);
        assert.ok(!names[0].includes('/') && !names[0].includes('\\'));
        assert.deepEqual(fs.readdirSync(dataDir), ['secrets']);
        keychain.invalidateSecretCache();
        assert.equal(keychain.getSecret('../../escape/acct'), SECRET);
      }
    );
  });
});

test('linux fallback: an available keychain is preferred and supersedes a fallback value', async () => {
  await withTempDataDir(async (dataDir) => {
    const stores = [];
    const file = path.join(dataDir, 'secrets', 'acct.secret');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old-fallback');
    await withLinuxKeychain(
      (args) => {
        if (args[0] === 'store') stores.push(args);
        return { code: 0 };
      },
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('acct', SECRET);
        assert.equal(stores.length, 1, 'the keychain was written');
        assert.equal(fs.existsSync(file), false, 'the stale fallback value is gone');
        assert.equal(keychain.keychainStatus().fallback, false);
        assert.equal(keychain.getSecret('acct'), SECRET);
      }
    );
  });
});

test('linux fallback: a value saved without a keychain stays readable once a keychain exists; the keychain wins when it has the account', async () => {
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('only-file', 'from-file');
        await keychain.setSecretAsync('both', 'file-value');
      }
    );
    // "Restart" with a reachable, unlocked keychain that holds only `both`.
    await withLinuxKeychain(
      (args) => {
        if (args[0] === '__probe') return { items: [{ account: 'both' }] };
        if (args[0] === 'lookup') return args[4] === 'both' ? { stdout: 'keychain-value' } : { code: 1 };
        return { code: 0 };
      },
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.prewarmSecrets();
        assert.equal(keychain.keychainStatus().state, 'ok');
        assert.equal(keychain.keychainStatus().fallback, false);
        // The label follows the source a read uses: the keychain wins for `both`.
        assert.equal(keychain.hasFallbackSecret('both'), false);
        assert.equal(keychain.hasFallbackSecret('only-file'), true);
        assert.equal(keychain.getSecret('only-file'), 'from-file');
        assert.equal(keychain.hasSecret('only-file'), true);
        assert.equal(await keychain.getSecretAsync('only-file'), 'from-file');
        assert.equal(keychain.getSecret('both'), 'keychain-value');
        assert.equal(keychain.getSecret('nowhere'), null);
        // Deleting clears both stores.
        await keychain.deleteSecretAsync('only-file');
        assert.equal(fs.existsSync(path.join(dataDir, 'secrets', 'only-file.secret')), false);
        assert.equal(keychain.getSecret('only-file'), null);
      }
    );
  });
});

test('linux fallback: no running Secret Service (secret-tool fails) uses the file; a locked keyring does not', async () => {
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      (args) =>
        args[0] === 'store'
          ? { code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' }
          : { code: 0 },
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('acct', SECRET);
        assert.equal(fs.readFileSync(path.join(dataDir, 'secrets', 'acct.secret'), 'utf8'), SECRET);
        assert.equal(keychain.keychainStatus().fallback, true);
        assert.doesNotMatch(keychain.keychainStatus().message, /autolaunch|DISPLAY/);
      }
    );
  });
  for (const locked of [
    { code: 1, stderr: 'secret-tool: Cannot create an item in a locked collection' },
    { code: 1, stderr: 'secret-tool: Failed to unlock collection' },
    { code: 1, stderr: 'secret-tool: prompt dismissed' },
    { hang: true },
  ]) {
    await withTempDataDir(async (dataDir) => {
      await withLinuxKeychain(
        (args) => (args[0] === 'store' ? locked : { code: 0 }),
        { MIXDOG_DATA_DIR: dataDir, MIXDOG_KEYCHAIN_TIMEOUT_MS: '80' },
        async (keychain) => {
          await assert.rejects(keychain.setSecretAsync('acct', SECRET), /locked|unlock/i);
          assert.equal(
            fs.existsSync(path.join(dataDir, 'secrets')),
            false,
            `no secret written: ${JSON.stringify(locked)}`
          );
          assert.equal(keychain.keychainStatus().state, 'locked');
          assert.equal(keychain.keychainStatus().fallback, false);
        }
      );
    });
  }
});

test('linux fallback: an unwritable secrets directory fails the save and never reports the value', async () => {
  await withTempDataDir(async (dataDir) => {
    // A regular file where the secrets directory must go.
    fs.writeFileSync(path.join(dataDir, 'secrets'), 'not a directory');
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await assert.rejects(keychain.setSecretAsync('acct', SECRET), (error) => {
          assert.match(error.message, /libsecret-tools/);
          assert.match(error.message, /could not be written/);
          assert.ok(!error.message.includes(SECRET));
          return true;
        });
      }
    );
  });
});

test('linux fallback: only a recognised missing provider falls back; every unknown error fails closed and writes no file', async () => {
  const unknown = [
    'secret-tool: database disk image is malformed',
    'secret-tool: No space left on device',
    'secret-tool: something nobody has seen before',
    'secret-tool: Cannot create an item in the collection',
  ];
  for (const stderr of unknown) {
    await withTempDataDir(async (dataDir) => {
      await withLinuxKeychain(
        (args) => (args[0] === 'store' ? { code: 1, stderr } : { code: 0 }),
        { MIXDOG_DATA_DIR: dataDir },
        async (keychain) => {
          await assert.rejects(keychain.setSecretAsync('acct', SECRET), (error) => {
            assert.ok(!error.message.includes(SECRET));
            return true;
          });
          assert.equal(fs.existsSync(path.join(dataDir, 'secrets')), false, `no file for: ${stderr}`);
          assert.equal(keychain.keychainStatus().fallback, false);
        }
      );
      // The sync path fails closed the same way.
      await withLinuxKeychain(
        () => ({ code: 0 }),
        { MIXDOG_DATA_DIR: dataDir },
        async (keychain) => {
          assert.throws(() => keychain.setSecret('acct', SECRET), /secret-tool store failed/);
          assert.equal(fs.existsSync(path.join(dataDir, 'secrets')), false, `no file (sync) for: ${stderr}`);
        },
        () => ({ status: 1, stdout: '', stderr })
      );
    });
  }
  // A secret-tool that exists but cannot be started is not a missing provider.
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ code: 0 }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        assert.throws(() => keychain.setSecret('acct', SECRET), /could not be started/);
        assert.equal(fs.existsSync(path.join(dataDir, 'secrets')), false);
        assert.equal(keychain.keychainStatus().fallback, false);
      },
      () => ({ error: Object.assign(new Error('spawn secret-tool EACCES'), { code: 'EACCES' }), status: null })
    );
  });
  // Recognised "no provider" reports do fall back.
  for (const stderr of [
    'Cannot autolaunch D-Bus without X11 $DISPLAY',
    'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files',
    'secret-tool: error while loading shared libraries: libsecret-1.so.0: cannot open shared object file',
  ]) {
    await withTempDataDir(async (dataDir) => {
      await withLinuxKeychain(
        (args) => (args[0] === 'store' ? { code: 1, stderr } : { code: 0 }),
        { MIXDOG_DATA_DIR: dataDir },
        async (keychain) => {
          await keychain.setSecretAsync('acct', SECRET);
          assert.equal(fs.readFileSync(path.join(dataDir, 'secrets', 'acct.secret'), 'utf8'), SECRET);
        }
      );
    });
  }
});

test('linux status: an unreachable keyring (failed passive probe) is never reported as the fallback', async () => {
  for (const probe of [{ missing: true }, { unreachable: true }]) {
    await withTempDataDir(async (dataDir) => {
      await withLinuxKeychain(
        (args) => (args[0] === '__probe' ? probe : { code: 1 }),
        { MIXDOG_DATA_DIR: dataDir, MIXDOG_KEYCHAIN_RETRY_MS: '30000' },
        async (keychain) => {
          await keychain.prewarmSecrets();
          assert.equal(keychain.keychainStatus().state, 'unreachable');
          assert.equal(keychain.keychainStatus().fallback, false);
        }
      );
    });
  }
});

test('linux status: headless host (no gdbus, no secret-tool) is a confirmed missing provider at startup and after a save', async () => {
  const headless = (args) => (args[0] === '__probe' ? { missing: true } : { enoent: true });
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      headless,
      { MIXDOG_DATA_DIR: dataDir, MIXDOG_KEYCHAIN_RETRY_MS: '30000' },
      async (keychain) => {
        await keychain.prewarmSecrets();
        assert.equal(keychain.keychainStatus().state, 'missing');
        assert.equal(keychain.keychainStatus().fallback, true);
      }
    );
    await withLinuxKeychain(
      headless,
      { MIXDOG_DATA_DIR: dataDir, MIXDOG_KEYCHAIN_RETRY_MS: '30000' },
      async (keychain) => {
        await keychain.setSecretAsync('acct', SECRET);
        assert.equal(keychain.keychainStatus().fallback, true);
        assert.equal(await keychain.retryKeychain(), false);
        await keychain.prewarmSecrets();
        assert.equal(keychain.keychainStatus().state, 'missing');
        assert.equal(keychain.keychainStatus().fallback, true);
        keychain.invalidateSecretCache();
        assert.equal(keychain.getSecret('acct'), SECRET);
      }
    );
  });
});

test('linux fallback: a symlinked secrets directory is refused; nothing is written or chmodded outside', async () => {
  await withTempDataDir(async (dataDir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-outside-'));
    try {
      if (SECRETS_FILE_MODE_CHECKABLE) fs.chmodSync(outside, 0o755);
      try {
        fs.symlinkSync(outside, path.join(dataDir, 'secrets'), 'dir');
      } catch {
        return; // the platform does not allow creating the link
      }
      await withLinuxKeychain(
        () => ({ enoent: true }),
        { MIXDOG_DATA_DIR: dataDir },
        async (keychain) => {
          await assert.rejects(keychain.setSecretAsync('acct', SECRET), (error) => {
            assert.match(error.message, /could not be written/);
            assert.ok(!error.message.includes(SECRET));
            return true;
          });
          assert.throws(() => keychain.setSecret('acct', SECRET), /could not be written/);
          assert.deepEqual(fs.readdirSync(outside), []);
          if (SECRETS_FILE_MODE_CHECKABLE) assert.equal(modeOf(outside), 0o755);
          // Reads and deletes do not follow the link either.
          fs.writeFileSync(path.join(outside, 'acct.secret'), 'planted');
          keychain.invalidateSecretCache();
          assert.equal(keychain.hasFallbackSecret('acct'), false);
          await assert.rejects(keychain.deleteSecretAsync('acct'));
          assert.equal(fs.existsSync(path.join(outside, 'acct.secret')), true);
        },
        () => ({ error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }), status: null })
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('linux status: the sync paths update the keyring health like the async ones', async () => {
  await withTempDataDir(async (dataDir) => {
    // Sync fallback: missing tool -> health says missing + fallback, not unknown.
    await withLinuxKeychain(
      () => ({ code: 0 }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        assert.equal(keychain.keychainStatus().state, 'unknown');
        keychain.setSecret('acct', SECRET);
        assert.equal(keychain.keychainStatus().state, 'missing');
        assert.equal(keychain.keychainStatus().fallback, true);
        keychain.deleteSecret('acct');
        assert.equal(keychain.keychainStatus().fallback, true);
      },
      () => ({ error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }), status: null })
    );
    // Sync success clears a stale failure.
    await withLinuxKeychain(
      () => ({ code: 0 }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        assert.throws(() => keychain.setSecret('a', SECRET), /locked/);
        assert.equal(keychain.keychainStatus().state, 'locked');
        assert.equal(keychain.keychainStatus().fallback, false);
        keychain.setSecret('b', SECRET);
        assert.equal(keychain.keychainStatus().state, 'ok');
        assert.equal(keychain.keychainStatus().fallback, false);
      },
      (() => {
        let calls = 0;
        return () =>
          ++calls === 1
            ? { status: 1, stdout: '', stderr: 'collection is locked' }
            : { status: 0, stdout: '', stderr: '' };
      })()
    );
  });
});

test('linux fallback: hasFallbackSecret tells per account where the value lives', async () => {
  await withTempDataDir(async (dataDir) => {
    await withLinuxKeychain(
      () => ({ enoent: true }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('file-only', SECRET);
        assert.equal(keychain.hasFallbackSecret('file-only'), true);
        assert.equal(keychain.hasFallbackSecret('other'), false);
      }
    );
    // The keychain recovered: the file-only account still says so, a keychain save does not.
    await withLinuxKeychain(
      (args) => (args[0] === '__probe' ? { items: [] } : { code: 0 }),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        assert.equal(keychain.hasFallbackSecret('file-only'), true);
        await keychain.setSecretAsync('in-keychain', SECRET);
        assert.equal(keychain.hasFallbackSecret('in-keychain'), false);
        await keychain.setSecretAsync('file-only', SECRET);
        assert.equal(keychain.hasFallbackSecret('file-only'), false);
      }
    );
  });
});

test('fallback file is Linux only: win32 and darwin keep their own backends', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realSpawnSync = childProcess.spawnSync;
  const oldData = process.env.MIXDOG_DATA_DIR;
  const oldSysRoot = process.env.SystemRoot;
  await withTempDataDir(async (dataDir) => {
    process.env.MIXDOG_DATA_DIR = dataDir;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const calls = [];
      childProcess.spawnSync = (cmd, args) => {
        calls.push([cmd, args[0]]);
        return args[0] === 'find-generic-password'
          ? { status: 44, stdout: '', stderr: '' }
          : { status: 1, stdout: '', stderr: 'denied' };
      };
      delete require.cache[require.resolve('./keychain-cjs.cjs')];
      const mac = require('./keychain-cjs.cjs');
      assert.throws(() => mac.setSecret('acct', SECRET), /security set failed/);
      assert.equal(mac.getSecret('acct'), null);
      assert.equal(mac.keychainStatus().fallback, false);
      assert.equal(fs.existsSync(path.join(dataDir, 'secrets')), false, 'macOS never writes the fallback file');

      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.SystemRoot ||= 'C:\\Windows';
      childProcess.spawnSync = () => ({ status: 1, stdout: '', stderr: 'dpapi down' });
      delete require.cache[require.resolve('./keychain-cjs.cjs')];
      const win = require('./keychain-cjs.cjs');
      assert.throws(() => win.setSecret('acct', SECRET), /DPAPI encrypt failed/);
      assert.equal(fs.existsSync(path.join(dataDir, 'secrets', 'acct.secret')), false);
      assert.equal(win.keychainStatus().fallback, false);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      childProcess.spawnSync = realSpawnSync;
      if (oldData === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = oldData;
      if (oldSysRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = oldSysRoot;
      delete require.cache[require.resolve('./keychain-cjs.cjs')];
    }
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
        assert.equal(secretToolCalls, 0, `passive paths must never run secret-tool: ${expectState}`);
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
      assert.deepEqual(
        [...new Set(calls)].filter((c) => c === 'search' || c === 'store' || c === 'clear'),
        []
      );
      assert.equal(calls.filter((c) => c === 'lookup').length, 1, 'only the unlocked item was looked up');
    }
  );
});

test('linux: an item the keyring lists but no longer has is skipped, not a snapshot failure', async () => {
  await withLinuxKeychain(
    (args) =>
      args[0] === '__probe' ? { items: [{ account: 'gone', gone: true }, { account: 'acct' }] } : { stdout: 's3cret' },
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
    (args) =>
      args[0] === '__probe' ? { unreachable: true } : args[0] === 'search' ? SEARCH_ONE : { stdout: 's3cret' },
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
    stdout: Object.keys(store)
      .map((_, i) => `[/org/x/${i}]\nsecret = s\n`)
      .join(''),
    stderr: Object.keys(store)
      .map((k) => `attribute.account = ${k}\n`)
      .join(''),
  });
  await withLinuxKeychain(
    (args) =>
      args[0] === 'search'
        ? search()
        : args[0] === 'lookup'
          ? args[4] in store
            ? { stdout: store[args[4]] }
            : { code: 1 }
          : { code: 0 },
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
        ? {
            stdout: '[/org/x/1]\nsecret = s\n[/org/x/2]\nsecret = s\n',
            stderr: 'attribute.account = a\nattribute.account = b\n',
          }
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
  await withTempDataDir(async (dataDir) => {
    const detail = 'secret-tool: /home/u/.secret-detail DBUS_X boom';
    // An unrecognised failure fails closed with the clean error.
    await withLinuxKeychain(
      (args) => (args[0] === 'store' ? { code: 1, stderr: detail } : {}),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await assert.rejects(keychain.setSecretAsync('acct', 'v'), (error) => {
          assert.doesNotMatch(error.message, /home\/u|DBUS_X|boom/);
          return true;
        });
        assert.doesNotMatch(keychain.keychainStatus().message, /home\/u|DBUS_X|boom/);
      }
    );
    // A recognised missing provider falls back; the status text stays clean.
    await withLinuxKeychain(
      (args) => (args[0] === 'store' ? { code: 1, stderr: `${detail} Cannot autolaunch D-Bus without X11` } : {}),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await keychain.setSecretAsync('acct', 'v');
        assert.doesNotMatch(keychain.keychainStatus().message, /home\/u|DBUS_X|boom/);
      }
    );
    // Locked keyring: the save is refused, with a clean error.
    await withLinuxKeychain(
      (args) => (args[0] === 'store' ? { code: 1, stderr: `${detail} locked` } : {}),
      { MIXDOG_DATA_DIR: dataDir },
      async (keychain) => {
        await assert.rejects(keychain.setSecretAsync('acct', 'v'), (error) => {
          assert.doesNotMatch(error.message, /home\/u|DBUS_X|boom/);
          return true;
        });
      }
    );
  });
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
