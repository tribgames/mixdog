#!/usr/bin/env node
// What the model-fallback hop reads from the provider side, as Node computes it:
//   - displayModelName(model, provider, hint) (shared/model-display.mjs), the name a hop notice
//     gives a model;
//   - pinSessionWireRoute(session, provider) (providers/wire-route.mjs), the wire a session pins
//     once its route changed, over a provider whose wire resolution is scripted.
//   node benchmarks/rust-core/recorders/record-hop-host.mjs [--tree <dir>]
//
// Output: native/core/fixtures/hop-host/golden.json.
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'hop-host');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-hop-host.mjs';
const at = (path) => importFrom(tree, path);

// advanceAgentRoute runs for real; only what sits outside it is a recording stand-in: the provider
// registry, the config snapshot, the session store's route update, the tool surface rebuild, the
// request options and the effort configuration. The context window is the real
// resolveSessionContextMeta. Registered before the product graph loads.
const orchestrator = 'src/runtime/agent/orchestrator/';
const STUBS = {
  'providers/registry.mjs': ['getProvider', 'initProviders'],
  'config.mjs': ['getConfigSnapshot'],
  'session/manager/session-lifecycle.mjs': ['updateSessionRoute'],
  'session/loop/tool-exposure-migration.mjs': ['rebuildToolSurfaceForProviderWithMigration'],
  'session/manager/ask-turn-loop-options.mjs': ['buildRequestSendOptions'],
  'providers/effort-configuration.mjs': ['prepareTurnEffortConfiguration'],
};
const { world } = await import(pathToFileURL(join(import.meta.dirname, 'lib/hop-world.mjs')).href);
register(pathToFileURL(join(import.meta.dirname, 'lib/hop-hooks.mjs')), {
  data: {
    world: pathToFileURL(join(import.meta.dirname, 'lib/hop-world.mjs')).href,
    stubs: Object.fromEntries(Object.entries(STUBS).map(([rel, names]) => [pathToFileURL(join(tree, orchestrator, rel)).href, names])),
  },
});
const { advanceAgentRoute } = await at(`${orchestrator}session/loop/route-fallback.mjs`);
const { displayModelName } = await at('src/runtime/shared/model-display.mjs');
const { pinSessionWireRoute } = await at('src/runtime/agent/orchestrator/providers/wire-route.mjs');

const MODELS = [
  '', '  ', 'gpt-5', 'gpt-5.4-2026-01-02', 'GPT-5.1-Codex-Max', 'gpt-4o', 'gpt-4o-mini-20240718', 'gpt-', 'gpt-image-1',
  'o3', 'o4-mini', 'o1-preview', 'codex-mini-latest', 'deepseek-v4-pro', 'deepseek-chat', 'grok-4-fast', 'grok-build',
  'claude-opus-4-1', 'claude-sonnet-4-5-20250929', 'claude-opus-4-8', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku', 'claude-fable-2',
  'claude-haiku', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-pro', 'gemini-', 'kimi-k2.7-code', 'qwen3.8-max', 'qwen-plus',
  'mimo-v2-flash', 'muse-spark-1.3-contributor', 'hy3-preview', 'glm-5.3-flash', 'glm-4.6', 'minimax-m3', 'longcat-flash-chat',
  'anthropic/claude-opus-4-8', 'openai/gpt-5', 'openrouter/auto/', '/', 'a//b', 'custom-model-x', 'Llama-3.1-8B', 'llama3:8b',
  'gpt-5.4-2026-01-02-', 'claude-opus-4-8\n', 'ÉCLAIR-1', 'kimi-contributor',
];
const HINTS = ['', 'GPT 5', 'My Fast Model', '  Claude Opus 4.8  ', 'gpt-5'];
const display = [];
for (const model of MODELS) {
  for (const hint of HINTS) display.push({ model, hint, name: displayModelName(model, 'p', hint) });
}

const answered = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
const unanswered = [{ role: 'user', content: 'hi' }];
const PINS = [
  ['no model', { provider: 'openrouter', model: '' }, {}, null],
  ['no provider name', { provider: '', model: 'm' }, {}, null],
  ['the pin already names this route', { provider: 'openrouter', model: 'm', wireRoute: { provider: 'openrouter', model: 'm', wire: 'chat', source: 'default', profileId: 'openrouter:chat' } }, { route: { wire: 'responses', source: 'family', profileId: 'openrouter:responses' } }, null],
  ['a pin of another model resolves anew', { provider: 'openrouter', model: 'm', wireRoute: { provider: 'openrouter', model: 'other', wire: 'chat', source: 'default', profileId: 'openrouter:chat' } }, { route: { wire: 'responses', source: 'family', profileId: 'openrouter:responses' } }, null],
  ['a null pin resolves fresh', { provider: 'openrouter', model: 'm', wireRoute: null }, { route: { wire: 'messages', source: 'catalog', profileId: 'openrouter:messages' } }, unanswered],
  ['a null pin on an answered session is not legacy', { provider: 'openrouter', model: 'm', wireRoute: null }, { route: { wire: 'messages', source: 'catalog', profileId: 'openrouter:messages' } }, answered],
  ['an absent pin on an unanswered session is not legacy', { provider: 'openrouter', model: 'm' }, { route: { wire: 'chat', source: 'default', profileId: 'openrouter:chat' } }, unanswered],
  ['an absent pin on an answered session is legacy', { provider: 'opencode-go', model: 'm' }, { route: { wire: 'chat', source: 'legacy', profileId: 'opencode-go:chat' } }, answered],
  ['an unknown route is not pinned', { provider: 'openrouter', model: 'm', wireRoute: null }, { route: { wire: 'chat', source: 'unknown', profileId: 'openrouter:chat' } }, unanswered],
  ['a model no wire serves is not pinned', { provider: 'openrouter', model: 'm', wireRoute: null }, { route: null }, unanswered],
  ['a failed resolution is not pinned', { provider: 'openrouter', model: 'm', wireRoute: null }, { throws: true }, unanswered],
  ['a single-wire provider pins nothing', { provider: 'openai', model: 'm', wireRoute: null }, { noRouting: true }, unanswered],
  ['an override route keeps its source', { provider: 'deepseek', model: 'deepseek-v4', wireRoute: null }, { route: { wire: 'messages', source: 'override', profileId: 'deepseek:messages' } }, unanswered],
];
const pins = [];
for (const [name, session, script, messages] of PINS) {
  const seen = [];
  const provider = script.noRouting
    ? {}
    : {
        async resolveWireRoute(model, ctx) {
          seen.push({ model, ...ctx });
          if (script.throws) throw new Error('resolution failed');
          return script.route ? { ...script.route } : null;
        },
      };
  const live = { ...session, messages: messages ?? unanswered };
  const given = structuredClone(session);
  const pin = await pinSessionWireRoute(live, provider);
  pins.push({
    name,
    session: given,
    answered: (messages ?? unanswered).some((m) => m.role === 'assistant'),
    script: { route: script.route ?? null, throws: script.throws === true, noRouting: script.noRouting === true },
    asked: seen,
    pin,
    wrote: live.wireRoute !== session.wireRoute,
  });
}

// -- advanceAgentRoute, whole ------------------------------------------------------------------
// Each scenario: the live session, what the stand-ins do, then the calls advanceAgentRoute makes
// on them in order (with arguments) and its outcome. `undefined` route fields read as null: the
// key is present with no value.
const plain = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
const NEXT = { provider: 'gemini', model: 'gemini-2.5-pro' };
const baseSession = (extra = {}) => ({
  id: 'sess_h1',
  agent: 'reviewer',
  owner: 'lead',
  provider: 'xai',
  model: 'grok-4',
  routeFallbacks: [NEXT],
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const ADVANCES = [
  ['a lead session hops: init, route update, hop fields, wire pin, tool surface', baseSession(), {}],
  ['a live turn checkpoint is marked route-changed before the update', baseSession({ activeTurnCheckpoint: { turn: 3 } }), {}],
  ['an agent-owned session keeps the surface the route update applied', baseSession({ owner: ' Agent ' }), {}],
  ['a provider that cannot init throws its own error', baseSession(), { initError: true }],
  ['a provider the registry does not have fails the hop', baseSession(), { missing: true }],
  ['a closed session fails the hop', baseSession(), { closed: true }],
  ['a failing route update escapes as it is', baseSession(), { writeError: true }],
  ['a wire that cannot be resolved is not pinned and the hop goes on', baseSession(), { resolveError: true }],
  ['a failing pin write escapes before the tool surface', baseSession(), { pinError: true }],
  ['a failing tool surface rebuild escapes as it is', baseSession(), { rebuildError: true }],
];
const advances = [];
for (const [name, given, script] of ADVANCES) {
  const log = [];
  world.log = log;
  const target = structuredClone(given);
  const observed = new Set(['activeTurnCheckpoint', 'routeFallbacks', 'routeFallbackPrimary', 'routeFallbackIndex', 'routeFallbackFailures', 'wireRoute']);
  const session = new Proxy(target, {
    set(object, key, value) {
      if (observed.has(key)) {
        log.push({ call: key === 'activeTurnCheckpoint' ? 'checkpoint' : 'set', ...(key === 'activeTurnCheckpoint' ? {} : { field: key }), value: plain(value) });
        if (key === 'wireRoute' && script.pinError) throw new Error('session store is read-only');
      }
      object[key] = value;
      return true;
    },
  });
  const adapter = {
    async resolveWireRoute(model, ctx) {
      log.push({ call: 'resolveWireRoute', model, agent: ctx.agent, legacy: ctx.legacy });
      if (script.resolveError) throw new Error('resolution failed');
      return { wire: 'chat', source: 'default', profileId: 'gemini:chat' };
    },
  };
  world.api = {
    getConfigSnapshot: () => ({}),
    async initProviders(providers) {
      for (const [provider, config] of Object.entries(providers)) log.push({ call: 'initProviders', provider, config: plain(config) });
      if (script.initError) throw new Error(`[provider] Failed to init "${NEXT.provider}": cannot build`);
    },
    getProvider: () => (script.missing ? null : adapter),
    buildRequestSendOptions: () => ({}),
    prepareTurnEffortConfiguration: () => null,
    updateSessionRoute(id, route, options) {
      log.push({ call: 'updateSessionRoute', route: plain(route), crossProvider: options.crossProvider });
      if (script.writeError) throw new Error('session store is read-only');
      if (script.closed) return null;
      for (const key of ['provider', 'model']) target[key] = route[key];
      target.wireRoute = null;
      return options.session;
    },
    rebuildToolSurfaceForProviderWithMigration(_session, provider) {
      log.push({ call: 'rebuildToolSurface', provider });
      if (script.rebuildError) throw new Error('surface rebuild failed');
    },
  };
  let notice = null;
  const state = {
    sessionRef: session,
    sessionId: given.id,
    signal: undefined,
    throwIfAborted() {},
    provider: {},
    messages: [],
    cacheBreakTraceKeys: new Set(),
    opts: { onStageChange: (stage, info) => stage === 'notice' && (notice = info.message) },
  };
  const error = Object.assign(new Error('slow down'), { status: 429 });
  let outcome;
  try {
    const hopped = await advanceAgentRoute(state, error);
    outcome = hopped ? { switched: true, provider: target.provider, model: target.model, notice } : { switched: false };
  } catch (thrown) {
    outcome = { threw: thrown.message };
  }
  advances.push({ name, session: given, error: { status: 429, message: 'slow down' }, script, calls: log, outcome });
}
world.api = {};

writeJson(join(stage, 'golden.json'), { display, pins, advances });
writeSetManifest(stage, { set: 'hop-host', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
