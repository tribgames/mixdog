#!/usr/bin/env node
// What the model-fallback hop reads from the provider side, as Node computes it:
//   - displayModelName(model, provider, hint) (shared/model-display.mjs), the name a hop notice
//     gives a model;
//   - pinSessionWireRoute(session, provider) (providers/wire-route.mjs), the wire a session pins
//     once its route changed, over a provider whose wire resolution is scripted.
//   node benchmarks/rust-core/recorders/record-hop-host.mjs [--tree <dir>]
//
// Output: native/core/fixtures/hop-host/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'hop-host');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-hop-host.mjs';
const at = (path) => importFrom(tree, path);
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

writeJson(join(stage, 'golden.json'), { display, pins });
writeSetManifest(stage, { set: 'hop-host', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
