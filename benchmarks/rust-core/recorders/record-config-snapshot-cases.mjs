#!/usr/bin/env node
// Records Node's config snapshot for the k1 UNTESTED config-snapshot.test.mjs (gaps-rest.md: mixdog-core-config). Each
// case runs the test's steps (another process's writes of the config and of the OpenAI OAuth credential file, this
// process's own config write and logout, a torn write, the clock passing a token's expiry) against Node's real
// `getConfigSnapshot` / `createConfigSnapshot(loadConfig)`, and records after each step the whole config a read returns
// (secrets included), once the snapshot has taken the step in as the test waits for it.
//
// The keychain is an in-memory store (the test reads this machine's real one) and HOME is a fresh folder, so no
// credential of the recording machine reaches the recording.
//
//   node benchmarks/rust-core/recorders/record-config-snapshot-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/config-snapshot-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-config-snapshot-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/config-snapshot.test.mjs';
const NOW = Date.parse('2026-03-01T10:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-config-snapshot-cases-'));
process.env.HOME = process.env.USERPROFILE = join(root, 'home');
mkdirSync(process.env.HOME, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(root, 'boot');
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
for (const name of Object.keys(process.env)) {
  if (/(_API_KEY|_OAUTH_CREDENTIALS_PATH)$/.test(name) || name.startsWith('MIXDOG_AGENT_') || name === 'MIXDOG_MODEL_PROXY') delete process.env[name];
}

// The keychain: an in-memory store behind the module's own functions, replaced before config.mjs takes them.
const keychain = createRequire(join(tree, 'src', 'lib', 'keychain-cjs.cjs'))(join(tree, 'src', 'lib', 'keychain-cjs.cjs'));
const secrets = new Map();
Object.assign(keychain, {
  getSecret: (account) => secrets.get(account) ?? null,
  getSecretAsync: async (account) => secrets.get(account) ?? null,
  setSecret: (account, value) => void secrets.set(account, value),
  setSecretAsync: async (account, value) => void secrets.set(account, value),
  deleteSecret: (account) => void secrets.delete(account),
  deleteSecretAsync: async (account) => void secrets.delete(account),
  hasSecret: (account) => secrets.has(account),
  hasFallbackSecret: () => false,
});

const cfg = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const shared = await importFrom(tree, 'src/runtime/shared/config.mjs');
const { configInputEpoch } = await importFrom(tree, 'src/runtime/shared/config-epoch.mjs');
const { createConfigSnapshot } = await importFrom(tree, 'src/runtime/agent/orchestrator/config-snapshot.mjs');
const { forgetProviderAuth } = await importFrom(tree, 'src/session-runtime/services/provider-admin.mjs');

const realWatch = shared.configWatchDeps.watch;
const silentWatch = () => ({ close() {}, trusted: true });
let dirs = 0;
let dir;
function useDataDir({ silent = false } = {}) {
  dir = join(root, `data-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  shared.configWatchDeps.watch = silent ? silentWatch : realWatch;
}
function foreignWrite(path, content) {
  const tmp = `${path}.foreign-tmp`;
  writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content));
  renameSync(tmp, path);
}
const configFile = () => join(dir, 'mixdog-config.json');
const credentials = () => join(dir, 'openai-oauth.json');
const SIGNED_IN = { access_token: 'access', refresh_token: 'refresh' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value));

// Each case: the steps the Rust side replays, and after each `observe` the whole config the read returned.
const cases = [];
let snapshot;
let steps;
const read = () => snapshot();
// The loaded config in its stored form, through Node's own `createConfigPatch` from a base loaded config: the core's loaded
// config lays no defaults on (each reader applies its own), so the defaults Node's carries are compared as their absence.
// Taken once every case has run, over an empty data dir: the save builder reads the config file.
const observe = () => steps.push({ op: 'observe', loaded: plain(read()) });
function step(op, extra, run) {
  steps.push({ op, ...extra });
  return run();
}
const writeAgent = (agent) => step('writeConfig', { text: JSON.stringify({ defaultsVersion: 2, agent }) }, () => foreignWrite(configFile(), { defaultsVersion: 2, agent }));
const writeCredential = (content, at = 'data') =>
  step('writeCredential', { at, text: typeof content === 'string' ? content : JSON.stringify(content) }, () =>
    foreignWrite(at === 'data' ? credentials() : process.env.OPENAI_OAUTH_CREDENTIALS_PATH, content)
  );
async function record(name, body) {
  steps = [];
  snapshot = undefined;
  await body();
  cases.push({ case: name, steps });
}

await record('this process’s own config write and logout are visible to the very next read', async () => {
  useDataDir({ silent: true });
  writeAgent({ heartbeat: false });
  writeCredential(SIGNED_IN);
  snapshot = () => cfg.getConfigSnapshot();
  observe();
  step('updateAgent', { set: { heartbeat: true } }, () => shared.updateSection('agent', (current) => ({ ...current, heartbeat: true })));
  observe();
  await step('forgetProviderAuth', { provider: 'openai-oauth' }, () => forgetProviderAuth(cfg, 'openai-oauth'));
  observe();
});

await record('another process’s config write is read fresh by every config-change listener', async () => {
  useDataDir();
  writeAgent({ heartbeat: false });
  snapshot = () => cfg.getConfigSnapshot();
  observe();
  // The test's listener (config-snapshot.test.mjs:197): each notification reads the config fresh.
  const seen = [];
  const unsubscribe = shared.subscribeConfigChange(() => seen.push(read().heartbeat));
  try {
    writeAgent({ heartbeat: true });
    await until(() => seen.length > 0);
    steps.push({ op: 'listener', seen: plain(seen) });
    observe();
  } finally {
    unsubscribe();
  }
});

await record('another process’s config write reaches the snapshot through the config watch', async () => {
  useDataDir();
  writeAgent({ heartbeat: false });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  writeAgent({ heartbeat: true });
  await until(() => read().heartbeat === true);
  observe();
});

await record('another process’s OAuth login and logout reach the snapshot through the credential file watch', async () => {
  useDataDir({ silent: true });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  writeCredential(SIGNED_IN);
  await until(() => read().providers['openai-oauth'].enabled === true);
  observe();
  step('removeCredential', {}, () => rmSync(credentials()));
  await until(() => read().providers['openai-oauth'].enabled === false);
  observe();
});

await record('a credential file whose directory does not exist yet is seen once another process creates both', async () => {
  useDataDir({ silent: true });
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = join(dir, 'later', 'creds', 'openai-oauth.json');
  steps.push({ op: 'credentialPath', at: 'later/creds/openai-oauth.json' });
  try {
    snapshot = createConfigSnapshot(cfg.loadConfig);
    observe();
    step('mkdir', { at: 'later/creds' }, () => mkdirSync(join(dir, 'later', 'creds'), { recursive: true }));
    writeCredential(SIGNED_IN, 'nested');
    await until(() => read().providers['openai-oauth'].enabled === true);
    observe();
  } finally {
    delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
  }
});

await record('a config caught mid-write keeps the last good config until the write completes, with no retry', async () => {
  useDataDir();
  writeAgent({ heartbeat: true });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  const complete = JSON.stringify({ defaultsVersion: 2, agent: { heartbeat: false } });
  const fd = openSync(configFile(), 'w');
  try {
    step('writeConfigInPlace', { text: complete.slice(0, complete.length - 8) }, () => {
      writeSync(fd, complete.slice(0, complete.length - 8));
      fsyncSync(fd);
    });
    await sleep(1000);
    observe();
    // Nothing re-checks while the file stays torn: no pass, no rebuild (config-snapshot.test.mjs:263-267).
    const epoch = configInputEpoch();
    await sleep(600);
    steps.push({ op: 'quiet', epochMoved: configInputEpoch() > epoch });
    step('appendConfig', { text: complete.slice(complete.length - 8) }, () => writeSync(fd, complete.slice(complete.length - 8)));
  } finally {
    closeSync(fd);
  }
  await until(() => read().heartbeat === false);
  observe();
});

await record('an OAuth credential file caught mid-write is probed again when the write completes', async () => {
  useDataDir({ silent: true });
  writeCredential('{"access_token": "acc');
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  writeCredential(SIGNED_IN);
  await until(() => read().providers['openai-oauth'].enabled === true);
  observe();
});

await record('a warm snapshot read does no synchronous file system work', async () => {
  useDataDir();
  writeAgent({ heartbeat: true });
  writeCredential(SIGNED_IN);
  snapshot = () => cfg.getConfigSnapshot();
  observe();
  observe();
});

await record('this process’s OAuth token save and forget are visible to the very next read', async () => {
  const { saveTokens, forgetOpenAIOAuthCredentials } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-oauth-tokens.mjs');
  useDataDir({ silent: true });
  writeAgent({ heartbeat: false });
  snapshot = () => cfg.getConfigSnapshot();
  observe();
  await step('saveTokens', { tokens: SIGNED_IN }, () => saveTokens(SIGNED_IN));
  observe();
  await step('forgetTokens', {}, () => forgetOpenAIOAuthCredentials());
  observe();
});

await record('a credential file that cannot be stat’ed is not read as unchanged: the snapshot rebuilds, and again when it can', async () => {
  useDataDir({ silent: true });
  writeCredential(SIGNED_IN);
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  // The test's denied stat of the credential file (fs.promises.stat throws EACCES for it), while it is removed.
  const stat = fsp.stat;
  const denied = mock.method(fsp, 'stat', async (path, ...rest) => {
    if (String(path).endsWith('openai-oauth.json')) throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
    return stat(path, ...rest);
  });
  step('removeCredential', {}, () => rmSync(credentials()));
  await until(() => read().providers['openai-oauth'].enabled === false);
  observe();
  denied.mock.restore();
  writeCredential(SIGNED_IN);
  await until(() => read().providers['openai-oauth'].enabled === true);
  observe();
});

// The fake clock cases: Date and setTimeout are mocked from NOW, as the test's `mock.timers`.
mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
// `epochMoved`: whether the tick told the config inputs' listeners (config-snapshot.test.mjs:380-382, :400-402).
const tick = (ms) => {
  const epoch = configInputEpoch();
  steps.push({ op: 'tick', ms });
  mock.timers.tick(ms);
  steps[steps.length - 1].epochMoved = configInputEpoch() > epoch;
};

await record('an access token with no refresh token stops counting at its expiry, with no file changing', async () => {
  useDataDir({ silent: true });
  writeCredential({ access_token: 'access', expires_at: NOW + 60_000 });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  tick(60_000 - 1);
  observe();
  tick(1);
  observe();
});

await record('one timer at the exact expiry tells the epoch’s listeners, with no read', async () => {
  useDataDir({ silent: true });
  writeCredential({ access_token: 'access', expires_at: Date.now() + 90_000 });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  tick(90_000 - 1);
  tick(1);
  observe();
});

await record('a last good config kept over a torn file never extends a credential past its expiry', async () => {
  useDataDir({ silent: true });
  writeAgent({ heartbeat: true });
  const expiresAt = Date.now() + 60_000;
  writeCredential({ access_token: 'access', expires_at: expiresAt });
  snapshot = createConfigSnapshot(cfg.loadConfig);
  observe();
  step('writeConfig', { text: '{"defaultsVersion": 2, "agent": {"heartbeat": fal' }, () => {
    foreignWrite(configFile(), '{"defaultsVersion": 2, "agent": {"heartbeat": fal');
    shared.invalidateConfigReadCache();
  });
  observe();
  tick(expiresAt - Date.now());
  observe();
});
mock.timers.reset();
useDataDir({ silent: true });
// The base each observation is diffed from: the config a read returns over an empty data dir (a loaded config, as
// every real `createConfigPatch` before is).
const base = plain(cfg.loadConfig());
for (const { steps: recorded } of cases) {
  for (const entry of recorded) if (entry.op === 'observe') entry.stored = plain(cfg.createConfigPatch(base, entry.loaded));
}

// Each named part is something no client, user or file can observe; what they can observe of the same case is replayed.
const excluded = {
  'a warm snapshot read does no synchronous file system work: the spied fs calls, the object identity and freezing':
    'not observable: a warm read hands back the cached frozen object with no I/O (src/runtime/agent/orchestrator/config-snapshot.mjs:173-177); ' +
    'a reader gets the same config either way, and that config is the replayed part',
  'a secret change moves the config inputs, so the next read rebuilds':
    'not observable: the test changes no secret value (config-snapshot.test.mjs:178-189 calls invalidateSecretCache on an unset key) and asserts ' +
    "only the input epoch moving and the snapshot's object identity changing (`assert.notEqual(full(), before)`), which no reader can see; " +
    'the rebuilt config equals the one before',
  'a credential file that cannot be stat’ed is not read as unchanged: the snapshot rebuilds, and again when it can: the logged EACCES':
    "the failed stat is Node's own probe of the watched file's stamp (config-snapshot.mjs:68-80, logged by watched-file-cache.mjs); the core " +
    'keeps no stamp and never stats the file, so it has no stat failure to log; the config after the removal and after the rewrite is replayed',
  'another process’s write landing while a build runs is still observed':
    'not reachable by a client: the write is placed between the probes and the epoch read of one build through an injected loader ' +
    '(config-snapshot.mjs:144-165, the test wraps createConfigSnapshot\'s `load`); outside the module a write is only ever seen ' +
    'by its watch event, which the credential-watch cases replay',
};

const finalDir = join(FIXTURES_ROOT, 'config-snapshot-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's config snapshot at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, now: NOW, base, cases });
writeSetManifest(stage, {
  set: 'config-snapshot-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "after each step, the whole config a read returns (loadConfig with secrets, `loaded`), once the snapshot took the step in, " +
      "compared as its change from the read over an empty data dir (`stored`: createConfigPatch(base, loaded); the core's " +
      "create_config_patch from its own loaded config over an empty data dir on its side): the " +
      "core's loaded config lays no defaults on, Node's carries them. Also the config listener's first read (`listener`, " +
      "test :197), whether each clock tick told the config inputs' listeners (`epochMoved`, test :380-402) and that a torn file " +
      "moves nothing (`quiet`, test :263-267). A listener's notification count is not compared: the core's change cell " +
      'coalesces ticks (`Config::changes`), where Node tells once per file event. A torn in-place write makes no core notification (the reload fails, the last good document stays), so the pass over its first bytes is not awaited; the completing write is. The replay waits for each rebuild\'s notification and accepts, between ' +
      "the recorded moments, a rebuild equal to the last observation or to the empty-data-dir base: the core reads the file by path, and a foreign " +
      "replace (temp file renamed over it, as `foreignWrite` does) can be read while the path is empty on Windows",
    isolated: 'an in-memory keychain and a fresh HOME; the fake clock cases start at 2026-03-01T10:00:00.000Z',
    excluded,
  },
});
commitStage(stage, finalDir);
rmSync(root, { recursive: true, force: true });
console.log(`config-snapshot-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
