import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const { configSnapshotDeps, CONFIG_SNAPSHOT_CHECK_MS } = await import('./config-snapshot.mjs');

const realSnapshotWatch = configSnapshotDeps.watch;
const realConfigWatch = shared.configWatchDeps.watch;
const silentWatch = () => ({ close() {}, unref() {}, on() {} });

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  configSnapshotDeps.watch = realSnapshotWatch;
  shared.configWatchDeps.watch = realConfigWatch;
});

let dirs = 0;
/** A fresh data dir; `silent` makes every directory watch deaf. */
function useDataDir({ silent = false } = {}) {
  const dir = join(root, `data-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  if (silent) {
    configSnapshotDeps.watch = silentWatch;
    shared.configWatchDeps.watch = silentWatch;
  }
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

test('another process’s config write and OAuth login reach the snapshot through the watches', async () => {
  const dir = useDataDir();
  writeAgent(dir, { heartbeat: false });
  settle();
  assert.equal(none().heartbeat, false);
  assert.equal(full().providers['openai-oauth'].enabled, false);

  writeAgent(dir, { heartbeat: true });
  await until(() => none().heartbeat === true);
  assert.deepEqual(none(), cfg.loadConfig({ secrets: false }));

  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  await until(() => full().providers['openai-oauth'].enabled === true);
  assert.deepEqual(full(), cfg.loadConfig());
});

// One fake clock for the whole group: a timer handle the snapshot kept from an
// earlier, reset mock must not be handed to a new mock's clearTimeout.
describe('on a fake clock', () => {
  before(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() }));
  after(() => mock.timers.reset());

test('with every watch deaf, the 15 s check still picks up foreign changes', async () => {
  const dir = useDataDir({ silent: true });
  writeAgent(dir, { heartbeat: false });
  settle();
  const before = none();
  assert.equal(full().providers['openai-oauth'].enabled, false);

  writeAgent(dir, { heartbeat: true });
  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  mock.timers.tick(CONFIG_SNAPSHOT_CHECK_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(none(), before);

  mock.timers.tick(1);
  await until(() => none().heartbeat === true && full().providers['openai-oauth'].enabled === true);
  assert.deepEqual(none(), cfg.loadConfig({ secrets: false }));
  assert.deepEqual(full(), cfg.loadConfig());
});

test('a config caught mid-write keeps the last good snapshot and is never quarantined', async () => {
  const dir = useDataDir({ silent: true });
  writeAgent(dir, { heartbeat: true });
  settle();
  const good = none();
  assert.equal(good.heartbeat, true);

  const torn = '{"defaultsVersion": 2, "agent": {"heartbeat": fal';
  foreignWrite(configFile(dir), torn);
  // This process asks for a fresh read: the rebuild meets the torn bytes.
  shared.invalidateConfigReadCache();
  assert.equal(none(), good);
  assert.equal(readFileSync(configFile(dir), 'utf8'), torn);

  writeAgent(dir, { heartbeat: false });
  mock.timers.tick(CONFIG_SNAPSHOT_CHECK_MS);
  await until(() => none().heartbeat === false);
  assert.deepEqual(none(), cfg.loadConfig({ secrets: false }));
});

test('an OAuth credential file that cannot be read yet is probed again once it settles', async () => {
  const dir = useDataDir({ silent: true });
  foreignWrite(openaiCredentials(dir), '{"access_token": "acc');
  const unsettled = full().providers['openai-oauth'];
  assert.equal(unsettled.enabled, false);
  assert.equal(unsettled.credentialProbeUnavailable, true);

  foreignWrite(openaiCredentials(dir), SIGNED_IN);
  mock.timers.tick(999);
  assert.equal(full().providers['openai-oauth'], unsettled);
  // The re-probe runs on its own short timer, long before the 15 s check.
  mock.timers.tick(1);
  assert.equal(full().providers['openai-oauth'].enabled, true);
  assert.equal(Object.hasOwn(full().providers['openai-oauth'], 'credentialProbeUnavailable'), false);
  assert.deepEqual(full(), cfg.loadConfig());
});

test('an access token with no refresh token stops counting at its expiry, with no file changing', () => {
  const dir = useDataDir({ silent: true });
  const expiresAt = Date.now() + 60_000;
  foreignWrite(openaiCredentials(dir), { access_token: 'access', expires_at: expiresAt });
  const signedIn = full();
  assert.equal(signedIn.providers['openai-oauth'].enabled, true);

  mock.timers.tick(expiresAt - Date.now() - 1);
  assert.equal(full(), signedIn);
  mock.timers.tick(2);
  assert.equal(full().providers['openai-oauth'].enabled, false);
  assert.deepEqual(full(), cfg.loadConfig());
});
});
