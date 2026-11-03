import assert from 'node:assert/strict';
import fs, {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, afterEach, before, describe, mock } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-config-snapshot-'));
process.env.MIXDOG_DATA_DIR = join(root, 'boot');
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
delete process.env.MIXDOG_MODEL_PROXY;

const cfg = await import('./config.mjs');
const shared = await import('../../shared/config.mjs');
const { configInputEpoch } = await import('../../shared/config-epoch.mjs');
const { createConfigSnapshot } = await import('./config-snapshot.mjs');

const realConfigWatch = shared.configWatchDeps.watch;
const silentWatch = () => ({ close() {}, unref() {}, on() {} });

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  shared.configWatchDeps.watch = realConfigWatch;
});

let dirs = 0;
/** A fresh data dir; `silent` makes the config directory watch deaf. */
function useDataDir({ silent = false } = {}) {
  const dir = join(root, `data-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  if (silent) shared.configWatchDeps.watch = silentWatch;
  return dir;
}

// Another process's write: a whole new file renamed into place.
function foreignWrite(path, content) {
  const tmp = `${path}.foreign-tmp`;
  writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content));
  renameSync(tmp, path);
}

const configFile = (dir) => join(dir, 'mixdog-config.json');
const openaiCredentials = (dir) => join(dir, 'openai-oauth.json');
const SIGNED_IN = { access_token: 'access', refresh_token: 'refresh' };
// Already separated, so loading it writes nothing back.
const writeAgent = (dir, agent) => foreignWrite(configFile(dir), { defaultsVersion: 2, agent });

const none = () => cfg.getConfigSnapshot({ secrets: false });
const full = () => cfg.getConfigSnapshot();
// First reads build; a second round absorbs anything the first load wrote.
const settle = () => [none(), full(), none(), full()];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Event-loop turns only, on the real clock: setTimeout and Date may be mocked.
async function until(check, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const SYNC_FS = [
  'readFileSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'readdirSync',
  'openSync',
  'readSync',
  'fstatSync',
  'accessSync',
  'writeFileSync',
];

function spySyncFs() {
  const calls = [];
  const originals = SYNC_FS.map((name) => [name, fs[name]]);
  for (const [name, original] of originals) {
    fs[name] = function spied(...args) {
      calls.push(name);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const [name, original] of originals) fs[name] = original;
      syncBuiltinESMExports();
    },
  };
}

test('a warm snapshot read does no synchronous file system work', () => {
  const dir = useDataDir();
  writeAgent(dir, { heartbeat: true });
  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  settle();
  const warmNone = none();
  const warmFull = full();
  const spy = spySyncFs();
  let warmCalls;
  try {
    for (let i = 0; i < 50; i += 1) {
      assert.equal(none(), warmNone);
      assert.equal(full(), warmFull);
    }
    warmCalls = [...spy.calls];
    // The spy sees what a loadConfig() read costs.
    cfg.loadConfig({ secrets: false });
  } finally {
    spy.restore();
  }
  assert.deepEqual(warmCalls, []);
  assert.ok(spy.calls.length > warmCalls.length);
  assert.equal(warmNone.heartbeat, true);
  assert.equal(warmFull.providers['openai-oauth'].enabled, true);
  assert.ok(Object.isFrozen(warmFull.providers['openai-oauth']));
  assert.deepEqual(warmNone, cfg.loadConfig({ secrets: false }));
  assert.deepEqual(warmFull, cfg.loadConfig());
});

test('this process’s own config write and logout are visible to the very next read', async () => {
  const dir = useDataDir({ silent: true });
  writeAgent(dir, { heartbeat: false });
  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  settle();
  assert.equal(none().heartbeat, false);
  assert.equal(full().providers['openai-oauth'].enabled, true);

  shared.updateSection('agent', (current) => ({ ...current, heartbeat: true }));
  assert.equal(none().heartbeat, true);
  assert.deepEqual(none(), cfg.loadConfig({ secrets: false }));

  const { forgetProviderAuth } = await import('../../../session-runtime/services/provider-admin.mjs');
  await forgetProviderAuth(cfg, 'openai-oauth');
  assert.equal(existsSync(openaiCredentials(dir)), false);
  assert.equal(full().providers['openai-oauth'].enabled, false);
  assert.deepEqual(full(), cfg.loadConfig());
});

test('this process’s OAuth token save and forget are visible to the very next read', async () => {
  const { saveTokens, forgetOpenAIOAuthCredentials } = await import('./providers/openai-oauth-tokens.mjs');
  const dir = useDataDir({ silent: true });
  writeAgent(dir, { heartbeat: false });
  settle();
  assert.equal(full().providers['openai-oauth'].enabled, false);

  saveTokens(SIGNED_IN);
  assert.equal(full().providers['openai-oauth'].enabled, true);
  assert.deepEqual(full(), cfg.loadConfig());

  forgetOpenAIOAuthCredentials();
  assert.equal(existsSync(openaiCredentials(dir)), false);
  assert.equal(full().providers['openai-oauth'].enabled, false);
  assert.deepEqual(full(), cfg.loadConfig());
});

test('a secret change moves the config inputs, so the next read rebuilds', () => {
  const dir = useDataDir({ silent: true });
  writeAgent(dir, { heartbeat: true });
  settle();
  const before = full();
  const epoch = configInputEpoch();
  // What every secret write, deletion and applied marker change ends in.
  shared.keychainSecretStore.invalidateSecretCache('agent.openai.apiKey');
  assert.ok(configInputEpoch() > epoch);
  assert.notEqual(full(), before);
  assert.deepEqual(full(), cfg.loadConfig());
});

test('another process’s config write is read fresh by every config-change listener', async () => {
  const dir = useDataDir();
  writeAgent(dir, { heartbeat: false });
  settle();
  assert.equal(none().heartbeat, false);
  const seen = [];
  const unsubscribe = shared.subscribeConfigChange(() => seen.push(none().heartbeat));
  try {
    writeAgent(dir, { heartbeat: true });
    await until(() => seen.length > 0);
    assert.deepEqual(seen, [true]);
    assert.deepEqual(none(), cfg.loadConfig({ secrets: false }));
  } finally {
    unsubscribe();
  }
});

// A snapshot of its own per test: no watch or timer of an earlier test's
// snapshot acts on this one.
let snapshot;
const fresh = () => {
  snapshot = createConfigSnapshot(cfg.loadConfig);
};
const noneOf = () => snapshot({ secrets: false });
const fullOf = () => snapshot();

test('another process’s config write reaches the snapshot through the config watch', async () => {
  const dir = useDataDir();
  writeAgent(dir, { heartbeat: false });
  fresh();
  assert.equal(noneOf().heartbeat, false);

  writeAgent(dir, { heartbeat: true });
  await until(() => noneOf().heartbeat === true);
  assert.deepEqual(noneOf(), cfg.loadConfig({ secrets: false }));
});

test('another process’s OAuth login and logout reach the snapshot through the credential file watch', async () => {
  const dir = useDataDir({ silent: true });
  fresh();
  assert.equal(fullOf().providers['openai-oauth'].enabled, false);

  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  await until(() => fullOf().providers['openai-oauth'].enabled === true);
  assert.deepEqual(fullOf(), cfg.loadConfig());

  rmSync(openaiCredentials(dir));
  await until(() => fullOf().providers['openai-oauth'].enabled === false);
  assert.deepEqual(fullOf(), cfg.loadConfig());
});

test('a credential file whose directory does not exist yet is seen once another process creates both', async (t) => {
  const dir = useDataDir({ silent: true });
  const nested = join(dir, 'later', 'creds', 'openai-oauth.json');
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = nested;
  t.after(() => delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH);
  fresh();
  assert.equal(fullOf().providers['openai-oauth'].enabled, false);

  // Only the nearest existing ancestor can be watched; its event leads on.
  mkdirSync(join(dir, 'later', 'creds'), { recursive: true });
  foreignWrite(nested, SIGNED_IN);
  await until(() => fullOf().providers['openai-oauth'].enabled === true);
  assert.deepEqual(fullOf(), cfg.loadConfig());
});

test('a config caught mid-write keeps the last good config until the write completes, with no retry', async () => {
  const dir = useDataDir();
  writeAgent(dir, { heartbeat: true });
  fresh();
  const good = noneOf();
  assert.equal(good.heartbeat, true);

  // Another process writing the file in place, caught halfway.
  const complete = JSON.stringify({ defaultsVersion: 2, agent: { heartbeat: false } });
  const fd = openSync(configFile(dir), 'w');
  try {
    writeSync(fd, complete.slice(0, complete.length - 8));
    fsyncSync(fd);
    // Its first bytes' events and notification pass are over.
    await sleep(400);
    const kept = noneOf();
    assert.deepEqual(kept, good, 'rebuilt over the last config that parsed');
    assert.equal(readFileSync(configFile(dir), 'utf8'), complete.slice(0, complete.length - 8));
    // Nothing re-checks while the file stays torn: no pass, no rebuild.
    const epoch = configInputEpoch();
    await sleep(600);
    assert.equal(configInputEpoch(), epoch);
    assert.equal(noneOf(), kept);

    // The completing write is the event that replaces it.
    writeSync(fd, complete.slice(complete.length - 8));
  } finally {
    closeSync(fd);
  }
  await until(() => noneOf().heartbeat === false);
  assert.deepEqual(noneOf(), cfg.loadConfig({ secrets: false }));
});

test('an OAuth credential file caught mid-write is probed again when the write completes', async () => {
  const dir = useDataDir({ silent: true });
  foreignWrite(openaiCredentials(dir), '{"access_token": "acc');
  fresh();
  const unsettled = fullOf().providers['openai-oauth'];
  assert.equal(unsettled.enabled, false);
  assert.equal(unsettled.credentialProbeUnavailable, true);

  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  await until(() => fullOf().providers['openai-oauth'].enabled === true);
  assert.equal(Object.hasOwn(fullOf().providers['openai-oauth'], 'credentialProbeUnavailable'), false);
  assert.deepEqual(fullOf(), cfg.loadConfig());
});

test('another process’s write landing while a build runs is still observed', async () => {
  const dir = useDataDir({ silent: true });
  let landed = false;
  // The credential file is written after the build's probes read it and
  // before the build records the epoch.
  snapshot = createConfigSnapshot((options) => {
    const value = cfg.loadConfig(options);
    if (!landed && options.secrets !== false) {
      landed = true;
      foreignWrite(openaiCredentials(dir), SIGNED_IN);
    }
    return value;
  });
  assert.equal(fullOf().providers['openai-oauth'].enabled, false, 'built from what it read before the write');
  assert.ok(landed);
  await until(() => fullOf().providers['openai-oauth'].enabled === true);
  assert.deepEqual(fullOf(), cfg.loadConfig());
});

describe('on a fake clock', () => {
  before(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() }));
  after(() => mock.timers.reset());

  test('an access token with no refresh token stops counting at its expiry, with no file changing', () => {
    const dir = useDataDir({ silent: true });
    const expiresAt = Date.now() + 60_000;
    foreignWrite(openaiCredentials(dir), { access_token: 'access', expires_at: expiresAt });
    fresh();
    const signedIn = fullOf();
    assert.equal(signedIn.providers['openai-oauth'].enabled, true);

    mock.timers.tick(expiresAt - Date.now() - 1);
    assert.equal(fullOf(), signedIn);
    mock.timers.tick(1);
    assert.equal(fullOf().providers['openai-oauth'].enabled, false);
    assert.deepEqual(fullOf(), cfg.loadConfig());
  });

  test('one timer at the exact expiry tells the epoch’s listeners, with no read', () => {
    const dir = useDataDir({ silent: true });
    const expiresAt = Date.now() + 90_000;
    foreignWrite(openaiCredentials(dir), { access_token: 'access', expires_at: expiresAt });
    fresh();
    assert.equal(fullOf().providers['openai-oauth'].enabled, true);

    const epoch = configInputEpoch();
    mock.timers.tick(expiresAt - Date.now() - 1);
    assert.equal(configInputEpoch(), epoch, 'nothing fires before the deadline');
    mock.timers.tick(1);
    assert.ok(configInputEpoch() > epoch);
    assert.equal(fullOf().providers['openai-oauth'].enabled, false);
  });

  test('a last good config kept over a torn file never extends a credential past its expiry', () => {
    const dir = useDataDir({ silent: true });
    writeAgent(dir, { heartbeat: true });
    const expiresAt = Date.now() + 60_000;
    foreignWrite(openaiCredentials(dir), { access_token: 'access', expires_at: expiresAt });
    fresh();
    assert.equal(fullOf().providers['openai-oauth'].enabled, true);

    foreignWrite(configFile(dir), '{"defaultsVersion": 2, "agent": {"heartbeat": fal');
    shared.invalidateConfigReadCache();
    const kept = fullOf();
    assert.equal(kept.heartbeat, true, 'the config part is the last good one');
    assert.equal(kept.providers['openai-oauth'].enabled, true);

    const epoch = configInputEpoch();
    mock.timers.tick(expiresAt - Date.now());
    assert.ok(configInputEpoch() > epoch, 'the expiry timer still fires');
    const expired = fullOf();
    assert.equal(expired.providers['openai-oauth'].enabled, false, 'the credential expired');
    assert.equal(expired.heartbeat, true, 'the config part is still the last good one');
    assert.equal(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 0, 'nothing quarantined');
  });
});
