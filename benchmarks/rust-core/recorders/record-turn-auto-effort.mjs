#!/usr/bin/env node
// Golden twin of Auto effort's first-request decision (session/manager/ask-turn-auto-effort.mjs):
// `autoEffortMode`, `autoEffortBaseSetting`, `autoEffortStepsEnabled` over the environment and an
// agent config; `clampAutoEffortBase` (providers/auto-effort.mjs) over raw settings and ladders; and
// `resolveTurnAutoEffort` over modes, routes, ladders, prompts and judge answers. The judge client
// is replaced by a scripted one (its answer per case); everything else is Node's own code, and the
// decision log and the empty-ladder warning are captured instead of written.
//
//   node benchmarks/rust-core/recorders/record-turn-auto-effort.mjs [--tree <dir>]
//
// Needs Node's module mocks; the script restarts itself with the flag.
import { spawnSync } from 'node:child_process';
import { mock } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const run = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit' }
  );
  process.exit(run.status ?? 1);
}

const tree = resolveTree(parseArgs());
const url = (rel) => pathToFileURL(join(tree, rel)).href;
const JUDGE = 'src/runtime/effort-judge/judge-client.mjs';

const judgeOriginal = await import(url(JUDGE));
let answer = null;
const judgeCalls = [];
const decisions = [];
mock.module(url(JUDGE), {
  namedExports: {
    ...judgeOriginal,
    judgeTurn: async (input) => {
      judgeCalls.push(input);
      return answer;
    },
    recordEffortDecision: (entry) => decisions.push(entry),
  },
});
const auto = await import(`${url('src/runtime/agent/orchestrator/session/manager/ask-turn-auto-effort.mjs')}?recorded`);
const { clampAutoEffortBase } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/auto-effort.mjs');
const { turnEffortConfigurationMode, autoEffortModel } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/providers/effort-configuration.mjs'
);
const { effortOptionsFor } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/effort.mjs');
const { anthropicEffortLevelsFor } = await importFrom(tree, 'src/runtime/shared/llm/anthropic-effort.mjs');

let state = 20260518;
const rnd = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];

const ENV = ['MIXDOG_AUTO_EFFORT', 'MIXDOG_FEATURE_AUTO_EFFORT', 'MIXDOG_AUTO_EFFORT_STEPS'];
const setEnv = (env) => {
  for (const name of ENV) delete process.env[name];
  for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
};
const stripUndefined = (value) => JSON.parse(JSON.stringify(value ?? null));

const envs = [
  {},
  { MIXDOG_AUTO_EFFORT: 'on' },
  { MIXDOG_AUTO_EFFORT: 'observe' },
  { MIXDOG_AUTO_EFFORT: 'off' },
  { MIXDOG_AUTO_EFFORT: ' ON ' },
  { MIXDOG_AUTO_EFFORT: 'bogus' },
  { MIXDOG_AUTO_EFFORT: ' ' },
  { MIXDOG_FEATURE_AUTO_EFFORT: '0' },
  { MIXDOG_FEATURE_AUTO_EFFORT: '1' },
  { MIXDOG_AUTO_EFFORT_STEPS: 'off' },
  { MIXDOG_AUTO_EFFORT_STEPS: ' OFF ' },
  { MIXDOG_AUTO_EFFORT_STEPS: 'on' },
  { MIXDOG_AUTO_EFFORT_STEPS: '' },
];
const settings = [undefined, null, 'low', 'medium', 'high', ' HIGH ', 'xhigh', 'max', '', 5, true, ['low'], ['high', 'x'], {}, 'Low'];
const configs = [
  {},
  { modules: { autoEffort: { enabled: false } } },
  { modules: { autoEffort: { enabled: true } } },
  { modules: { autoEffort: {} } },
  { modules: { autoEffort: { enabled: 0 } } },
];
const withSetting = (config, setting) => (setting === undefined ? config : { ...config, autoEffortBase: setting });

// ---- the source: mode, base setting, steps ------------------------------------------------------------
const sources = [];
for (const env of envs) {
  for (const config of configs) {
    for (const setting of settings) {
      const agent = withSetting(config, setting);
      setEnv(env);
      sources.push({
        env,
        agent: stripUndefined(agent),
        mode: auto.autoEffortMode(agent),
        base: auto.autoEffortBaseSetting(agent),
        steps: auto.autoEffortStepsEnabled(),
      });
    }
  }
}
setEnv({});

// ---- clampAutoEffortBase -------------------------------------------------------------------------------
const ladders = [
  [],
  ['low'],
  ['medium'],
  ['high'],
  ['low', 'high'],
  ['low', 'medium', 'high'],
  ['low', 'medium', 'high', 'xhigh'],
  ['minimal', 'low', 'medium', 'high', 'max'],
  ['none', 'minimal'],
  ['max', 'ultra'],
  ['xhigh'],
  ['medium', 'xhigh'],
  [' HIGH ', 'Low'],
  ['low', 'bogus', 'xhigh'],
  ['low', 'high', 'xhigh'],
  ['none', 'low', 'high'],
];
const clamps = [];
for (const options of ladders) {
  for (const setting of settings) {
    clamps.push({
      absent: setting === undefined,
      setting: setting === undefined ? null : setting,
      options,
      result: clampAutoEffortBase({ base: setting, options }),
    });
  }
}

// ---- resolveTurnAutoEffort -----------------------------------------------------------------------------
const makeProvider = (name, row, protocol, config) => ({
  name,
  config: config ?? {},
  ...(protocol ? { customConfig: { protocol } } : {}),
  getCachedModelInfo: () => (row === undefined ? undefined : { ...row }),
});
const ROUTES = [
  { provider: 'anthropic-oauth', model: 'claude-opus-5-5', row: undefined },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', row: undefined },
  { provider: 'anthropic-oauth', model: 'claude-3-5-haiku', row: undefined },
  { provider: 'openai-oauth', model: 'gpt-5.5', row: { reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }] } },
  { provider: 'openai', model: 'gpt-5', row: {} },
  { provider: 'openai', model: 'o3', row: { reasoningLevels: ['low', 'medium', 'high'] } },
  { provider: 'gemini', model: 'gemini-2.5-pro', row: { reasoningLevels: ['low', 'high'] } },
  { provider: 'custom-acme', model: 'm1', row: { customReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }, protocol: 'openai-chat' },
  { provider: 'custom-acme', model: 'm1', row: { customReasoning: true, reasoningLevels: ['none', 'minimal'] }, protocol: 'openai-responses' },
  { provider: 'custom-acme', model: 'm1', row: { customReasoning: true, reasoningLevels: ['medium', 'xhigh', 'max'] }, protocol: 'openai-chat' },
  { provider: 'custom-acme', model: 'm1', row: { customReasoning: true, reasoningLevels: ['low', 'high'] }, protocol: 'anthropic' },
  { provider: 'custom-acme', model: 'm1', row: { customReasoning: true }, protocol: 'openai-chat' },
  { provider: 'anthropic-oauth', model: 'claude-opus-5-5', row: undefined, noProvider: true },
];
const PROMPTS = [
  'fix the failing test',
  '  padded request  ',
  '',
  '   ',
  '<skill>body</skill>',
  '<',
  'x<y',
  'héllo 😀 wörld',
  [{ type: 'text', text: 'first' }, { type: 'image' }, 'plain', { text: 'tail' }, { type: 'other' }],
  [{ type: 'image' }],
  [],
  42,
  null,
];
const MESSAGES = [
  [],
  [{ role: 'user', content: 'earlier request' }, { role: 'assistant', content: 'earlier answer' }],
  [{ role: 'assistant', content: '   ' }, { role: 'assistant', content: [{ type: 'text', text: 'said' }] }, { role: 'user', content: 'ask' }],
  [{ role: 'user', content: 'a' }, { role: 'tool', content: 'b' }, null, { role: 'user', content: '' }],
  [{ role: 'assistant', content: [{ type: 'image' }] }, { role: 'user', content: [{ type: 'text', text: 'q' }, 'r'] }],
  [{ role: 'user', content: 7 }, { role: 'assistant', content: null }],
];
const EFFORTS = [undefined, null, '', 'low', 'medium', 'high', 'xhigh', 'max', 'ULTRA', 'High', 5];
const DISTRIBUTIONS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [0.25, 0.25, 0.25, 0.25],
  [0.5, 0, 0, 0.5],
  [0.4, 0.3, 0.2, 0.1],
  [0.1, 0.2, 0.3, 0.4],
  [0.34, 0.33, 0.33, 0],
  [0.2, 0.5, 0.2, 0.1],
  [0.123456, 0.654321, 0.1, 0.122223],
  [0.6, 0.1, 0.1, 0.2],
  [0.3, 0.3, 0.4, 0],
  [0.5, 0.5],
  [0.25, 0.25, 0.25, 0.25, 0],
  [],
];
const ANSWERS = [
  ...DISTRIBUTIONS.map((probs) => ({ probs, ms: 7 })),
  { skipped: 'warming' },
  { skipped: 'model-missing' },
  { skipped: 'load-error: boom' },
];
const SESSION_FLAGS = [undefined, undefined, undefined, undefined, undefined, undefined, false, true];
const PROMPT_SOURCES = [undefined, undefined, undefined, undefined, 'completion', ''];

const ROUTES_WEIGHTED = [0, 0, 0, 1, 7, 7, 7, 8, 9, 9, 11, 3, 5, 2, 10, 12, 4, 6].map((index) => ROUTES[index]);
const writes = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  writes.push(String(chunk));
  return true;
};

const turns = [];
const TURNS = 2600;
for (let i = 0; i < TURNS; i += 1) {
  const base = pick(ROUTES_WEIGHTED);
  const route = base.provider === 'custom-acme' ? { ...base, model: pick(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) } : base;
  const env = rnd() < 0.85 ? { MIXDOG_AUTO_EFFORT: pick(['on', 'on', 'on', 'observe', 'off']) } : pick(envs);
  const agent = withSetting(rnd() < 0.7 ? {} : pick(configs), pick(settings));
  const session = {
    provider: route.provider,
    model: route.model,
    messages: pick(MESSAGES),
    modelParameters: rnd() < 0.2 ? { effort: 'high' } : undefined,
  };
  const effort = pick(EFFORTS);
  if (effort !== undefined) session.effort = effort;
  const flag = pick(SESSION_FLAGS);
  if (flag !== undefined) session.autoEffort = flag;
  const prompt = rnd() < 0.6 ? PROMPTS[0] : pick(PROMPTS);
  const promptSource = rnd() < 0.85 ? undefined : pick(PROMPT_SOURCES);
  const provider = route.noProvider ? null : makeProvider(route.provider, route.row, route.protocol);
  const chosenAnswer = pick(ANSWERS);
  setEnv(env);
  answer = chosenAnswer;
  judgeCalls.length = 0;
  decisions.length = 0;
  writes.length = 0;
  const configured = turnEffortConfigurationMode(session, provider);
  const options = effortOptionsFor(session.provider, autoEffortModel(session.provider, provider, session.model));
  const input = promptSource === undefined ? { prompt } : { prompt, promptSource };
  const result = await auto.resolveTurnAutoEffort({ sessionId: `s${i}`, session, provider, input, config: agent });
  turns.push({
    env,
    agent: stripUndefined(agent),
    route: {
      provider: route.provider,
      model: route.model,
      row: route.row === undefined ? null : route.row,
      protocol: route.protocol ?? null,
      hasProvider: !route.noProvider,
      anthropicLevels: route.provider.startsWith('anthropic') ? anthropicEffortLevelsFor(route.model) : null,
    },
    session: stripUndefined(session),
    prompt: stripUndefined(prompt),
    promptSource: promptSource ?? null,
    answer: chosenAnswer,
    configured,
    options,
    result: result === null ? null : stripUndefined(result),
    judged: judgeCalls.map((call) => stripUndefined(call)),
    decisions: decisions.map(({ at, ...rest }) => stripUndefined(rest)),
    warnings: [...writes],
  });
}
process.stderr.write = realWrite;
setEnv({});

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'turn-auto-effort-twin.json'), {
  domain: 'turn-auto-effort-twin',
  recorder: 'benchmarks/rust-core/recorders/record-turn-auto-effort.mjs',
  sources,
  clamps,
  turns,
});
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
const decided = turns.filter((t) => t.result).length;
console.log(`recorded ${sources.length} source cases, ${clamps.length} clamps, ${turns.length} turns (${decided} decided)`);
