#!/usr/bin/env node
// Golden twin of the provider-account setup actions (session-runtime/setup-tool/executor.mjs
// `forget_provider_auth` and `set_provider_account`). Node's real setup executor runs scenarios
// over a runtime facade whose four provider calls (`getProviderSetup`, `getProviderAccounts`,
// `forgetProviderAuth`, `updateProviderAccounts`) are Node's real provider-admin functions over a
// throwaway data dir seeded with OAuth sign-ins and an account roster. Each case holds what the
// executor asked of the facade, in order, with the facade's answer (or its error), and what the
// executor answered. An API-key provider's forget would reach the OS keychain: its facade answer
// is the one `forgetProviderAuth` returns (`stubbed: true`).
//
// Every user directory is a temp dir before any Mixdog module loads. The only git the manifest\n// runs is in the repository this recorder lives in, never the product tree's.
//   node benchmarks/rust-core/recorders/record-account-actions.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'account-actions');
const base = mkdtempSync(join(tmpdir(), 'account-actions-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
delete process.env.MIXDOG_MODEL_PROXY;

const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const admin = await importFrom(tree, 'src/session-runtime/services/provider-admin.mjs');
const accounts = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = 'openai-oauth';
// Valid for centuries, so the real clock decides nothing.
const signedIn = { access_token: 'opaque', refresh_token: 'r', expires_at: 9_000_000_000_000 };

let dataDir = null;
let n = 0;
// A fresh data dir per case, seeded as `state` says.
async function seed(state) {
  n += 1;
  dataDir = join(base, `data-${n}`);
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
    // Registered, never signed in.
    await accounts.registerProviderAccount(P, ID(3), { label: 'Spare' });
    await accounts.changeProviderAccounts(P, { selectedId: ID(2), policy: 'headroom' });
  }
}

const cases = [];
async function record(name, state, args, { managed = false } = {}) {
  await seed(state);
  const facade = [];
  // The executor gets the live value; the case records a JSON copy of it.
  const live = async (method, callArgs, run) => {
    const entry = { call: method, args: plain(callArgs) };
    facade.push(entry);
    try {
      const result = await run();
      entry.result = plain(result);
      return result;
    } catch (error) {
      entry.error = String(error?.message ?? error);
      throw error;
    }
  };
  const rt = {
    getProviderSetup: (options) =>
      live('getProviderSetup', [options], async () => {
        if (managed) return { managedByClient: true, unavailable: true, api: [], oauth: [], local: [] };
        const setup = await admin.providerSetup({}, { checkSecrets: false });
        return { oauth: setup.oauth.map((row) => ({ id: row.id })), api: setup.api.map((row) => ({ id: row.id })) };
      }),
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
    forgetProviderAuth: (id, accountId) =>
      live('forgetProviderAuth', accountId === undefined ? [id] : [id, accountId], async () => {
        if (API_IDS.has(id)) return { provider: id, type: 'api-key', forgotten: true, stubbed: true };
        return await admin.forgetProviderAuth(null, id, accountId);
      }),
    updateProviderAccounts: (id, change) => live('updateProviderAccounts', [id, change], () => admin.updateProviderAccounts(id, change)),
  };
  const executor = createSetupToolExecutor({ getApi: () => rt, getConfig: () => ({}), getSessionId: () => 'sess_caller' });
  let result;
  try {
    const out = JSON.parse(await executor.execute(args, { callerSessionId: 'sess_caller' }));
    // The receipt wrapper is the setup service's.
    delete out.saved;
    delete out.appliesTo;
    if (out.scope === 'installation') delete out.scope;
    result = { value: out };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  const stubbed = facade.some((entry) => entry.result?.stubbed === true);
  cases.push({ name, state, args, facade, ...(stubbed ? { stubbed: true } : {}), ...result });
}

const API_IDS = new Set((await admin.providerSetup({}, { checkSecrets: false })).api.map((row) => row.id));

// ---- forget_provider_auth
const forget = (extra) => ({ action: 'forget_provider_auth', ...extra });
for (const state of ['none', 'implicit', 'one', 'many']) {
  for (const extra of [
    { name: P },
    { name: ` ${P} ` },
    { name: P, accountId: ID(1) },
    { name: P, accountId: ID(2) },
    { name: P, accountId: ID(3) },
    { name: P, accountId: ID(9) },
    { name: P, accountId: 'default' },
    { name: P, accountId: '  ' },
    { name: P, accountId: ` ${ID(1)} ` },
    { name: 'anthropic-oauth' },
    { name: 'anthropic-oauth', accountId: ID(1) },
    { name: 'cursor-oauth' },
    { name: 'nope' },
    { name: 'nope', accountId: ID(1) },
    { name: 'openai' },
    { name: 'openai', accountId: ID(1) },
    { name: '  ' },
    { name: '' },
  ]) {
    await record(`forget ${JSON.stringify(extra)}: ${state}`, state, forget(extra));
  }
}
// Forgetting every account of a roster, one after the other, in one data dir.
for (const extra of [{ name: P }, { name: 5 }, { name: P, accountId: 5 }, {}, { name: P, surprise: true }]) {
  await record(`forget ${JSON.stringify(extra)}: invalid input`, 'many', forget(extra));
}
await record('forget when the desktop manages accounts', 'many', forget({ name: P }), { managed: true });
await record('forget with an account id when the desktop manages accounts', 'many', forget({ name: P, accountId: ID(1) }), { managed: true });

// ---- set_provider_account
const change = (name, providerAccount) => ({ action: 'set_provider_account', name, providerAccount });
for (const state of ['none', 'implicit', 'one', 'many']) {
  for (const providerAccount of [
    { selectedId: ID(1) },
    { selectedId: ID(2) },
    { selectedId: ID(9) },
    { selectedId: 'default' },
    { selectedId: '' },
    { auto: false },
    { auto: true },
    { policy: 'manual' },
    { policy: 'limit' },
    { policy: 'headroom' },
    { policy: 'nope' },
    { useCredits: true },
    { useCredits: false },
    { rename: { id: ID(1), label: ' Renamed ' } },
    { rename: { id: ID(1), label: '' } },
    { rename: { id: ID(9), label: 'Ghost' } },
    { rename: { id: ID(2), label: 'x'.repeat(80) } },
    { rename: { id: ID(2), label: 'x'.repeat(81) } },
    { rename: { id: ID(2) } },
    { order: [ID(3), ID(2), ID(1)] },
    { order: [ID(2), ID(1)] },
    { order: [] },
    { order: [ID(1), ID(1), ID(2)] },
    { order: ['default'] },
    { selectedId: ID(1), auto: false, policy: 'limit', useCredits: true },
    { selectedId: ID(2), order: [ID(2), ID(3), ID(1)] },
    { refreshUsage: true },
    { surprise: 1 },
    {},
  ]) {
    await record(`set_provider_account ${P} ${JSON.stringify(providerAccount)}: ${state}`, state, change(P, providerAccount));
  }
  for (const name of ['anthropic-oauth', 'cursor-oauth', 'openai', 'nope', ' openai-oauth ', '  ', '']) {
    await record(`set_provider_account ${JSON.stringify(name)}: ${state}`, state, change(name, { auto: false }));
  }
}
for (const args of [
  { action: 'set_provider_account', name: P },
  { action: 'set_provider_account', providerAccount: { auto: false } },
  { action: 'set_provider_account', name: P, providerAccount: 'auto' },
  { action: 'set_provider_account', name: P, providerAccount: [1] },
  { action: 'set_provider_account', name: P, providerAccount: { auto: 'yes' } },
  { action: 'set_provider_account', name: P, providerAccount: { auto: false }, accountId: ID(1) },
  { action: 'set_provider_account', name: 5, providerAccount: { auto: false } },
]) {
  await record(`set_provider_account invalid ${JSON.stringify(args)}`, 'many', args);
}
await record('set_provider_account when the desktop manages accounts', 'many', change(P, { auto: false }), { managed: true });
await record('set_provider_account (empty change) when the desktop manages accounts', 'many', change(P, {}), { managed: true });

writeJson(join(outDir, 'account-actions-twin.json'), {
  domain: 'account-actions-twin',
  recorder: 'benchmarks/rust-core/recorders/record-account-actions.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'account-actions',
  recorder: 'benchmarks/rust-core/recorders/record-account-actions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-account-actions.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${cases.length} account-action cases (${cases.filter((c) => c.error).length} errors)`);
