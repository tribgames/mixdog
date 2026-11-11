#!/usr/bin/env node
// Golden twin of the setup tool's `status providers` reader (session-runtime/setup-tool/executor.mjs)
// and of the roster read `set_media_default` makes (`getProviderAccounts`, Node's
// `listProviderAccounts`). Node's real setup executor answers `status` over a runtime facade whose
// `getProviderSetup` is a scripted provider setup (that snapshot is the provider-setup service's
// own state), `getQuotaAutoResume` a scripted switch, and `getProviderAccounts` Node's real
// provider-admin `listProviderAccounts` over a throwaway data dir seeded with OAuth sign-ins and
// an account roster. Each case holds the facade calls the reader made, in order, with their
// answers, and what the executor answered. `rosters` holds `listProviderAccounts` itself.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-provider-status.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, recordingProvenance, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'provider-status');
const base = mkdtempSync(join(tmpdir(), 'provider-status-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_MODEL_PROXY;

const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const admin = await importFrom(tree, 'src/session-runtime/services/provider-admin.mjs');
const accounts = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = 'openai-oauth';
const signedIn = { access_token: 'opaque', refresh_token: 'r', expires_at: 9_000_000_000_000 };

let n = 0;
async function seed(state) {
  n += 1;
  const dataDir = join(base, `data-${n}`);
  mkdirSync(dataDir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = join(dataDir, 'openai-default.json');
  const credentials = (id) => {
    const file = accounts.providerAccountPath(P, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(signedIn));
  };
  if (state === 'implicit') writeFileSync(process.env.OPENAI_OAUTH_CREDENTIALS_PATH, JSON.stringify(signedIn));
  if (state === 'one' || state === 'many') {
    await accounts.registerProviderAccount(P, ID(1), { label: 'Work' });
    credentials(ID(1));
  }
  if (state === 'many') {
    await accounts.registerProviderAccount(P, ID(2), { label: '' });
    credentials(ID(2));
    await accounts.registerProviderAccount(P, ID(3), { label: 'Spare' });
    await accounts.changeProviderAccounts(P, { selectedId: ID(2), policy: 'headroom' });
  }
}

const oauthIds = admin.providerSetup ? (await admin.providerSetup({}, { checkSecrets: false })).oauth.map((row) => row.id) : [];

// ---- the provider setup snapshots the reader is given (secrets never in them)
const row = (id, extra = {}) => ({ id, name: id.toUpperCase(), type: 'x', enabled: true, authenticated: false, status: 'Not connected', ...extra });
const setups = {
  mixed: {
    api: [
      row('a-env', { authenticated: true, status: 'Connected', env: true, envName: 'A_KEY', url: 'https://a.example/keys' }),
      row('a-keychain', { authenticated: true, status: 'Connected', stored: true, url: 'http://insecure.example', custom: true }),
      row('a-none', { url: 'https://none.example' }),
      row('a-nourl', { authenticated: true, status: 'Connected', stored: true, enabled: false }),
      row('a-odd', { authenticated: 1, enabled: 'yes', status: '', custom: 'true', url: 5 }),
      { id: 'a-bare' },
    ],
    oauth: [
      row(P, { authenticated: true, status: 'Connected', plan: 'plus', expiresAt: 1_900_000_000_000 }),
      row('anthropic-oauth', { authenticated: true, status: 'Connected', expiresAt: 0 }),
      row('cursor-oauth', { authenticated: false, reauthRequired: true, status: 'Sign in again', plan: 'pro' }),
      row('grok-oauth'),
      row('gemini-oauth', { authenticated: false, reauthRequired: false, plan: 'free', expiresAt: 5 }),
    ],
    local: [
      row('ollama', { authenticated: true, status: 'Detected', detected: true, baseURL: 'http://localhost:11434', defaultURL: 'http://d' }),
      row('lmstudio', { authenticated: true, status: 'Detected', defaultURL: 'http://localhost:1234' }),
      row('llamacpp', { authenticated: false, reauthRequired: true, detected: false }),
      row('vllm'),
    ],
  },
  pending: { pendingSecrets: true, api: [row('a-env', { authenticated: false, env: true, envName: 'A_KEY' })], oauth: [row(P, { authenticated: true, status: 'Connected' })], local: [] },
  empty: { api: [], oauth: [], local: [] },
  bare: {},
  none: null,
  managed: { managedByClient: true, unavailable: true, pendingSecrets: false, api: [row('a-env', { authenticated: true, status: 'Connected', stored: true })], oauth: [row(P, { authenticated: true, status: 'Connected', plan: 'plus' })], local: [row('ollama', { authenticated: true, detected: true })] },
  'managed-available': { managedByClient: true, api: [], oauth: [row(P, { authenticated: false, reauthRequired: true })], local: [] },
  'managed-odd': { managedByClient: 'yes', unavailable: 1, api: [], oauth: [], local: [] },
};

const cases = [];
async function record(name, state, setupName, { quota, detail, proxy = false }) {
  await seed(state);
  if (proxy) process.env.MIXDOG_MODEL_PROXY = 'client';
  else delete process.env.MIXDOG_MODEL_PROXY;
  const facade = [];
  const rt = {
    getProviderSetup: async (options) => {
      const result = setups[setupName] === undefined ? undefined : setups[setupName];
      facade.push({ call: 'getProviderSetup', args: [plain(options)], result: plain(result) });
      return result;
    },
    getProviderAccounts: (id) => {
      const entry = { call: 'getProviderAccounts', args: [id] };
      facade.push(entry);
      try {
        const pool = admin.listProviderAccounts(id);
        entry.result = plain(pool);
        return pool;
      } catch (error) {
        entry.error = String(error?.message ?? error);
        throw error;
      }
    },
    getQuotaAutoResume: () => {
      facade.push({ call: 'getQuotaAutoResume', args: [], result: quota });
      return quota;
    },
  };
  const executor = createSetupToolExecutor({ getApi: () => rt, getConfig: () => ({}), getSessionId: () => 'sess_caller' });
  const args = { action: 'status', domain: 'providers', ...(detail === undefined ? {} : { detail }) };
  let result;
  try {
    const out = JSON.parse(await executor.execute(args, { callerSessionId: 'sess_caller' }));
    delete out.domain;
    result = { value: out };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  cases.push({ name, state, setup: setupName, quota, proxy, args, facade, ...result });
}

for (const setupName of Object.keys(setups)) {
  for (const state of ['none', 'implicit', 'one', 'many']) {
    for (const detail of [undefined, false, true]) {
      for (const quota of [true, false]) {
        await record(`${setupName} detail=${detail} quota=${quota}: ${state}`, state, setupName, { quota, detail });
      }
    }
  }
}
// The server's own roster is empty in client mode, whatever the setup says.
for (const detail of [undefined, true]) {
  await record(`mixed detail=${detail} in proxy mode`, 'many', 'mixed', { quota: true, detail, proxy: true });
}
// An OAuth row the roster does not know: the roster's own refusal reaches the caller.
setups.unknown = { api: [], oauth: [row('mystery-oauth', { authenticated: true, status: 'Connected' })], local: [] };
for (const detail of [undefined, true]) await record(`unknown oauth provider detail=${detail}`, 'many', 'unknown', { quota: true, detail });
// A truthy non-boolean `detail` is not `detail: true`.
for (const detail of ['true', 1, null]) await record(`detail=${JSON.stringify(detail)}`, 'one', 'mixed', { quota: true, detail });

// ---- the roster read `set_media_default` makes
const rosters = [];
for (const state of ['none', 'implicit', 'one', 'many']) {
  for (const proxy of [false, true]) {
    for (const id of [...oauthIds, 'nope', 'openai', '', ' openai-oauth ']) {
      await seed(state);
      if (proxy) process.env.MIXDOG_MODEL_PROXY = 'client';
      else delete process.env.MIXDOG_MODEL_PROXY;
      const entry = { state, proxy, id };
      try {
        entry.result = plain(admin.listProviderAccounts(id));
      } catch (error) {
        entry.error = String(error?.message ?? error);
      }
      rosters.push(entry);
    }
  }
}
delete process.env.MIXDOG_MODEL_PROXY;

writeJson(join(outDir, 'provider-status-twin.json'), {
  domain: 'provider-status-twin',
  recorder: 'benchmarks/rust-core/recorders/record-provider-status.mjs',
  cases,
  rosters,
});
writeSetManifest(outDir, {
  set: 'provider-status',
  recorder: 'benchmarks/rust-core/recorders/record-provider-status.mjs',
  command: 'node benchmarks/rust-core/recorders/record-provider-status.mjs --tree <tree>',
  identityTree: tree,
  extra: recordingProvenance('benchmarks/rust-core/recorders/record-provider-status.mjs', ['benchmarks/rust-core/recorders/lib/common.mjs']),
});
console.log(`recorded ${cases.length} status cases (${cases.filter((c) => c.error).length} errors), ${rosters.length} roster reads (${rosters.filter((c) => c.error).length} errors)`);
