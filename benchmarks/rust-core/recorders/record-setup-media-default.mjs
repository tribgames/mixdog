#!/usr/bin/env node
// Golden twin of the setup action `set_media_default`: the real `createSetupToolExecutor` over a
// recording facade whose media catalog and provider roster are scripted per world. A case keeps
// the receipt (or refusal text) Node answered and the facade calls it made, in order, so Rust
// must hold the same checks (kind, blank lane, lane/model/account against the catalog and the
// roster) and make the same calls (`listMediaLanes`, `getProviderAccounts`, `setMediaPin`).
//
//   node benchmarks/rust-core/recorders/record-setup-media-default.mjs --tree <dir>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'setup-media-default-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');

const plain = (v) => (v === undefined ? { absent: true } : JSON.parse(JSON.stringify(v)));
const models = (...ids) => ({ models: ids.map((id) => ({ id })) });

const LANES = [
  { id: 'gemini', label: 'Gemini', authenticated: true, image: models('nano', 'nano-pro'), video: null },
  { id: 'oa', label: 'OpenAI', authType: 'oauth', authProvider: 'openai-oauth', authenticated: true, image: models('gpt-image-2'), video: models('sora') },
  { id: 'grok', label: 'Grok', authenticated: false, image: null, video: null },
  { id: 'cat', label: 'Catalog', authenticated: true, catalogError: 'The catalog could not be read', image: null, video: null },
  { id: 'bare', authenticated: true, image: models('m'), video: null },
  { id: 'broken', label: 'Broken', authType: 'oauth', authProvider: 'broken-oauth', authenticated: true, image: models('m'), video: models('v') },
  { id: 'fal', label: 'Fal', authType: 'api-key', authenticated: true, image: models('flux'), video: models('wan') },
];

const ROSTERS = {
  'openai-oauth': { provider: 'openai-oauth', selectedId: 'a1', accounts: [{ id: 'a1' }, { id: 'a2' }] },
};

function facade(calls, lanes) {
  return {
    listMediaLanes: async () => {
      calls.push({ method: 'listMediaLanes', args: [] });
      return JSON.parse(JSON.stringify(lanes));
    },
    getProviderAccounts: (id) => {
      calls.push({ method: 'getProviderAccounts', args: plain([id]) });
      if (!ROSTERS[id]) throw new TypeError('Unknown OAuth provider.');
      return JSON.parse(JSON.stringify(ROSTERS[id]));
    },
    setMediaPin: async (input) => {
      calls.push({ method: 'setMediaPin', args: plain([input]) });
      return input.lane ? { kind: input.kind, lane: input.lane.trim(), model: input.model ?? '', account: input.account ?? '' } : null;
    },
  };
}

async function outcome(args, lanes = LANES) {
  const calls = [];
  const executor = createSetupToolExecutor({ getApi: () => facade(calls, lanes), getConfig: () => ({}) });
  const base = lanes === LANES ? {} : { lanes };
  try {
    return { args, ...base, calls, receipt: JSON.parse(await executor.execute(args)) };
  } catch (error) {
    return { args, ...base, calls, error: String(error?.message ?? error) };
  }
}

const set = (extra) => ({ action: 'set_media_default', ...extra });
const ARGS = [
  set({ kind: 'image', lane: 'gemini' }),
  set({ kind: 'image', lane: 'gemini', model: 'nano' }),
  set({ kind: 'image', lane: 'gemini', model: 'nano-pro' }),
  set({ kind: 'image', lane: 'gemini', model: 'other' }),
  set({ kind: 'image', lane: 'gemini', model: '' }),
  set({ kind: 'image', lane: 'gemini', model: null }),
  set({ kind: 'image', lane: 'gemini', model: 7 }),
  set({ kind: 'video', lane: 'gemini' }),
  set({ kind: 'video', lane: 'oa', model: 'sora' }),
  set({ kind: 'image', lane: 'oa', accountId: 'a2' }),
  set({ kind: 'image', lane: 'oa', accountId: 'a1', model: 'gpt-image-2' }),
  set({ kind: 'image', lane: 'oa', accountId: 'zz' }),
  set({ kind: 'image', lane: 'oa', accountId: '' }),
  set({ kind: 'image', lane: 'oa', accountId: null }),
  set({ kind: 'image', lane: 'oa', accountId: 1 }),
  set({ kind: 'image', lane: 'oa', accountId: 'a1', model: 'nope' }),
  set({ kind: 'image', lane: 'gemini', accountId: 'a1' }),
  set({ kind: 'image', lane: 'fal', accountId: 'a1' }),
  set({ kind: 'image', lane: 'fal', model: 'flux' }),
  set({ kind: 'video', lane: 'fal', model: 'wan' }),
  set({ kind: 'image', lane: 'broken', accountId: 'a1' }),
  set({ kind: 'image', lane: 'broken' }),
  set({ kind: 'image', lane: 'missing' }),
  set({ kind: 'image', lane: ' gemini ' }),
  set({ kind: 'image', lane: 'Gemini' }),
  set({ kind: 'image', lane: 'grok' }),
  set({ kind: 'image', lane: 'grok', model: 'x', accountId: 'y' }),
  set({ kind: 'image', lane: 'cat' }),
  set({ kind: 'video', lane: 'cat' }),
  set({ kind: 'video', lane: 'grok' }),
  set({ kind: 'image', lane: 'bare' }),
  set({ kind: 'video', lane: 'bare' }),
  set({ kind: 'image', lane: '' }),
  set({ kind: 'video', lane: '' }),
  set({ kind: 'image', lane: '   ' }),
  set({ kind: 'image', lane: '', model: 'nano' }),
  set({ kind: 'image', lane: '', accountId: 'a1' }),
  set({ kind: 'image', lane: '', model: null }),
  set({ kind: 'image', lane: ' ', accountId: null, model: 'x' }),
  set({ kind: 'audio', lane: 'gemini' }),
  set({ kind: 'skills', lane: 'gemini' }),
  set({ kind: 'mcp', lane: '' }),
  set({ kind: 'plugins', lane: 'oa', accountId: 'a1' }),
  set({ kind: '', lane: 'gemini' }),
  set({ kind: ' image ', lane: 'gemini' }),
  set({ kind: 'IMAGE', lane: 'gemini' }),
  set({ kind: null, lane: 'gemini' }),
  set({ kind: 1, lane: 'gemini' }),
  set({ lane: 'gemini' }),
  set({ kind: 'image' }),
  set({ kind: 'image', lane: null }),
  set({ kind: 'image', lane: 5 }),
  set({ kind: 'image', lane: true }),
  set({ kind: 'image', lane: ['gemini'] }),
  set({ kind: 'image', lane: {} }),
  set({}),
];

// The tool schema (`[tool-input-validation]`, Rust: mixdog-tools setup_input) refuses a wrong-typed or
// out-of-set argument before any handler runs: those answers are not this action's.
const cases = [];
const record = async (args, lanes) => {
  const one = await outcome(args, lanes);
  if (!String(one.error ?? '').startsWith('[tool-input-validation]')) cases.push(one);
};
for (const args of ARGS) await record(args);

// A world whose catalog holds nothing, and one with lanes lacking the fields the messages print.
const BARE = [{ id: 'w', authenticated: false, image: null, video: null }, { id: 'x', authenticated: true, image: null, video: null }, { id: 'y', label: 'Why', image: models('m'), video: null }, { id: 'z', authType: 'oauth', authenticated: true, image: models('m'), video: null }];
for (const args of [set({ kind: 'image', lane: 'w' }), set({ kind: 'image', lane: 'x' }), set({ kind: 'image', lane: 'y' }), set({ kind: 'image', lane: 'z', accountId: 'a' }), set({ kind: 'image', lane: 'gemini' })]) {
  await record(args, BARE);
}
await record(set({ kind: 'image', lane: 'gemini' }), []);

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-media-default-twin.json'), {
  domain: 'setup-media-default-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-media-default.mjs',
  lanes: LANES,
  rosters: ROSTERS,
  cases,
});
console.log(`recorded ${cases.length} cases (${cases.filter((c) => c.error).length} errors)`);
