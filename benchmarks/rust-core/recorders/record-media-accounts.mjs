#!/usr/bin/env node
// Golden twin of a media run on a chosen provider account: Node's real `withProviderAccount`,
// `currentProviderAccountId`, `boundProviderAuthPath` (provider-auth-binding.mjs) and
// `mediaLaneAccountProvider` / `createMediaLaneCatalog` (lanes.mjs) over a scratch data folder
// with a real account roster. Records, per scope, which account and credential file every lane
// resolves to and what the lane catalog lists in that scope, pinned and unpinned. Rust
// `media::accounts` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-accounts.mjs --tree <dir>
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-accounts-'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
const tree = resolveTree(parseArgs());
const { withProviderAccount, currentProviderAccountId, boundProviderAuthPath, replaceProviderAuthBindings } = await importFrom(tree, 'src/runtime/shared/provider-auth-binding.mjs');
const { mediaLaneAccountProvider, createMediaLaneCatalog } = await importFrom(tree, 'src/runtime/media/lanes.mjs');
const { ACCOUNT_PROVIDERS, readProviderAccountPool } = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');

const UA = '11111111-2222-3333-4444-555555555555';
const UB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const pool = (accounts, selectedId) => ({ accounts, selectedId, auto: true, policy: 'limit' });
writeFileSync(
  join(DATA, 'provider-accounts.json'),
  JSON.stringify({
    version: 1,
    providers: {
      'grok-oauth': pool([{ id: 'default', label: 'Account 1' }, { id: UA, label: 'Work' }], UA),
      'openai-oauth': pool([{ id: 'default', label: 'Account 1' }, { id: UB, label: 'Spare' }], 'default'),
    },
  })
);
// Credential files: the grok account UA has some; UB (openai) has none.
const FILES = [join('provider-accounts', 'grok-oauth', `${UA}.json`), join('isolated', 'openai.json')];
for (const rel of FILES) {
  mkdirSync(join(DATA, rel, '..'), { recursive: true });
  writeFileSync(join(DATA, rel), '{}');
}
// Where a provider keeps its default account's credentials: present for these providers.
const DEFAULT_CREDS = new Set(['openai-oauth', 'xai']);

const LANES = ['grok-oauth', 'xai', 'openai-oauth', 'gemini', 'antigravity-oauth', 'openrouter', 'nano-gpt'];
const selected = Object.fromEntries(ACCOUNT_PROVIDERS.map((provider) => [provider, readProviderAccountPool(provider).selectedId]));

const catalog = createMediaLaneCatalog({
  loadModels: async () => [],
  authenticated: (lane) => {
    const provider = mediaLaneAccountProvider(lane.id);
    const path = provider ? boundProviderAuthPath(provider) : null;
    return path ? existsSync(path) : DEFAULT_CREDS.has(lane.auth.provider);
  },
});

async function inside(chain, run) {
  if (!chain.length) return run();
  const [[provider, id], ...rest] = chain;
  return withProviderAccount(provider, id, () => inside(rest, run));
}

const CHAINS = [
  [],
  [['grok-oauth', UA]],
  [['grok-oauth', 'default']],
  [['openai-oauth', UB]],
  [['openai-oauth', UB], ['grok-oauth', UA]],
  [['grok-oauth', UA], ['grok-oauth', 'default']],
  [['gemini', 'default']],
  [['grok-oauth', 'work']],
  [['custom-nano', 'default']],
  [['custom-', 'default']],
];
// The pristine `mixdog exec` run binds the selected provider's credential file in process (host
// bindings); its tools, media among them, then read that file. One binding exists, one does not.
const HOSTS = [null, { 'openai-oauth': join(DATA, 'isolated', 'openai.json'), 'grok-oauth': join(DATA, 'isolated', 'missing.json') }];
const scopes = [];
for (const host of HOSTS) {
const restore = host ? replaceProviderAuthBindings(host) : null;
for (const chain of CHAINS) {
  try {
    const result = await inside(chain, async () => ({
      lanes: LANES.map((lane) => {
        const provider = mediaLaneAccountProvider(lane);
        return { lane, provider, id: provider ? currentProviderAccountId(provider) : null, path: provider ? boundProviderAuthPath(provider) : null };
      }),
      listed: await catalog.listMediaLanes(),
    }));
    scopes.push({ host, chain, ...result });
  } catch (error) {
    scopes.push({ host, chain, error: error.message });
  }
}
restore?.();
}
const providerOf = ['grok-oauth', ' xai ', 'openai-oauth', 'gemini', 'antigravity-oauth', 'openrouter', 'nano-gpt', 'bogus', '', null, undefined, 7].map((lane) => ({ lane: lane ?? null, provider: mediaLaneAccountProvider(lane) }));

const slash = (path) => path.replaceAll('\\', '/');
const norm = (text) => text.replaceAll(slash(DATA), '{data}').replaceAll(DATA, '{data}');
const normalize = (value) =>
  typeof value === 'string' ? norm(value) : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
writeJson(join(FIXTURES_ROOT, 'services', 'media-accounts-twin.json'), {
  domain: 'media-accounts-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-accounts.mjs',
  accountProviders: ACCOUNT_PROVIDERS,
  selected,
  files: FILES.map(slash),
  defaultCreds: [...DEFAULT_CREDS],
  providerOf,
  scopes: normalize(scopes),
});
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${scopes.length} scopes`);
process.exit(0);
