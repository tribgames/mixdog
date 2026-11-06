#!/usr/bin/env node
// Golden twin of the LLM session titles: `createSessionTitleController`
// (runtime-core/session-title.mjs) driven with scripted sessions, a scripted title model and a
// scripted promotion, and `createTitleCompletion` (agent-runtime/title-completion.mjs) over a
// scripted config, route and provider. Rust `session::session_title` and the host's
// `run_host::title_completion` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-session-titles.mjs [--tree <dir>]
//
// Output: native/core/fixtures/session-titles/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'session-titles');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-session-titles.mjs';
const { createSessionTitleController } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/session-title.mjs');
const { createTitleCompletion } = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-runtime/title-completion.mjs');

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (text) => String(text).split('\n')[0];
const msg = (role, content, extra = {}) => ({ role, content, ...extra });
const turn = (n) => [msg('user', `question ${n}`), msg('assistant', `answer ${n}`)];

// model: a list of behaviours, one per call: {title}, {fail: text}, {route: true}, {hang: true}.
const CONTROLLER = [
  { name: 'a plain first prompt is titled by the model', model: [{ title: '  "Fix the build"  ' }], steps: [{ op: 'first', session: { id: 's1', messages: [] }, prompt: 'please fix the build' }] },
  { name: 'a greeting is titled without the model', model: [], steps: [
    { op: 'first', session: { id: 'g1', messages: [] }, prompt: 'hi!' },
    { op: 'first', session: { id: 'g2', messages: [] }, prompt: ' 안녕하세요 ' },
    { op: 'first', session: { id: 'g3', messages: [] }, prompt: 'Hello' },
    { op: 'first', session: { id: 'g4', messages: [] }, prompt: 'HEY?!' },
  ] },
  { name: 'a first title is tried once per session', model: [{ title: 'One' }], steps: [
    { op: 'first', session: { id: 'o1', messages: [] }, prompt: 'work' },
    { op: 'first', session: { id: 'o1', messages: [] }, prompt: 'work again' },
  ] },
  { name: 'a locked or already titled session is skipped', model: [], steps: [
    { op: 'first', session: { id: 'l1', titleLocked: true, messages: [] }, prompt: 'work' },
    { op: 'first', session: { id: 'l2', generatedTitleStage: 'first', messages: [] }, prompt: 'work' },
    { op: 'first', session: { id: 'l3', generatedTitleStage: 'third', messages: [] }, prompt: 'work' },
    { op: 'first', session: { id: '', messages: [] }, prompt: 'work' },
  ] },
  { name: 'a session that already has a user message is not a first turn', model: [], steps: [
    { op: 'first', session: { id: 'p1', messages: [msg('user', 'earlier')] }, prompt: 'work' },
    { op: 'first', session: { id: 'p2', messages: [msg('user', '[mixdog-runtime] note'), msg('user', '   ')] }, prompt: 'hello there friend' },
  ] },
  { name: 'a noise or empty prompt has no source', model: [], steps: [
    { op: 'first', session: { id: 'n1', messages: [] }, prompt: '' },
    { op: 'first', session: { id: 'n2', messages: [] }, prompt: '[mixdog-runtime] hidden' },
    { op: 'first', session: { id: 'n3', messages: [] }, prompt: '!!! ???' },
    { op: 'first', session: { id: 'n4', messages: [] }, prompt: 'ROUTINE_QUIET' },
  ] },
  { name: 'a long prompt is cleaned and cut to 4000 units for the model', model: [{ title: 'Long' }], steps: [
    { op: 'first', session: { id: 'c1', messages: [] }, prompt: `${'word  '.repeat(1200)}\n\n tail` },
  ] },
  { name: 'the first title waits for its release and is dropped when the release fails', model: [{ title: 'Late' }], steps: [
    { op: 'first', session: { id: 'a1', messages: [] }, prompt: 'work', after: 'resolve' },
    { op: 'first', session: { id: 'a2', messages: [] }, prompt: 'work', after: 'reject' },
    { op: 'first', session: { id: 'a2', messages: [] }, prompt: 'work', after: null },
  ] },
  { name: 'the third title takes the first three completed exchanges', model: [{ title: 'Three turns' }], steps: [
    { op: 'third', session: { id: 't1', messages: [...turn(1), ...turn(2)] } },
    { op: 'third', session: { id: 't1', messages: [...turn(1), ...turn(2), ...turn(3), ...turn(4)] } },
    { op: 'third', session: { id: 't1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
  ] },
  { name: 'the third title leaves out tools, injected rows and reasoning', model: [{ title: 'Filtered' }], steps: [
    { op: 'third', session: { id: 'f1', messages: [
      msg('system', 'rules'), msg('user', 'first ask'), msg('assistant', '<think>hidden</think>working'), msg('tool', 'result'),
      msg('assistant', [{ type: 'text', text: 'final one' }]), msg('user', 'second', { synthetic: true }), msg('user', 'second ask'),
      msg('assistant', 'second answer', { internal: true }), msg('assistant', 'second reply'), msg('user', [{ text: 'third' }, { text: 'ask' }]),
      msg('assistant', { text: 'third reply' }), msg('user', 'dangling'),
    ] } },
  ] },
  { name: 'a locked session or one past its third title is not retitled', model: [], steps: [
    { op: 'third', session: { id: 'k1', titleLocked: true, messages: [...turn(1), ...turn(2), ...turn(3)] } },
    { op: 'third', session: { id: 'k2', generatedTitleStage: 'third', messages: [...turn(1), ...turn(2), ...turn(3)] } },
  ] },
  { name: 'a failed generation releases the session to try again', model: [{ fail: 'Error: provider down' }, { title: 'Second try' }], steps: [
    { op: 'third', session: { id: 'r1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
    { op: 'third', session: { id: 'r1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
  ] },
  { name: 'an unresolved route disables the model titles for good', model: [{ route: true }], steps: [
    { op: 'third', session: { id: 'u1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
    { op: 'third', session: { id: 'u2', messages: [...turn(1), ...turn(2), ...turn(3)] } },
    { op: 'first', session: { id: 'u3', messages: [] }, prompt: 'work' },
    { op: 'first', session: { id: 'u4', messages: [] }, prompt: 'hello' },
  ] },
  { name: 'an empty or unusable answer promotes nothing', model: [{ title: '   ' }, { title: '<think>x</think>' }, { title: '!!!' }], steps: [
    { op: 'first', session: { id: 'e1', messages: [] }, prompt: 'work 1' },
    { op: 'first', session: { id: 'e2', messages: [] }, prompt: 'work 2' },
    { op: 'first', session: { id: 'e3', messages: [] }, prompt: 'work 3' },
  ] },
  { name: 'a generation that outlives its timeout fails and is released', model: [{ hang: true }, { title: 'After' }], timeoutMs: 15, steps: [
    { op: 'third', session: { id: 'h1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
    { op: 'third', session: { id: 'h1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
  ] },
  { name: 'a promotion the session refuses is only logged', model: [{ title: 'Refused' }], promote: false, steps: [
    { op: 'first', session: { id: 'x1', messages: [] }, prompt: 'work' },
  ] },
  { name: 'disposing ends later titles', model: [{ title: 'Never' }], steps: [
    { op: 'dispose' },
    { op: 'first', session: { id: 'd1', messages: [] }, prompt: 'work' },
    { op: 'third', session: { id: 'd1', messages: [...turn(1), ...turn(2), ...turn(3)] } },
  ] },
];

async function runController(scenario) {
  const calls = [];
  const promoted = [];
  const logs = [];
  const model = [...scenario.model];
  const controller = createSessionTitleController({
    log: (line) => logs.push(firstLine(line)),
    systemLocale: () => 'ko-KR',
    timeoutMs: scenario.timeoutMs,
    promoteGeneratedTitle: async (id, title, stage) => {
      promoted.push({ id, title, stage });
      return scenario.promote !== false;
    },
    generateSessionTitle: async (source, options) => {
      calls.push({ source, sessionId: options.sessionId, locale: options.locale });
      const next = model.shift() ?? { title: '' };
      if (next.route) throw Object.assign(new Error('unresolved'), { code: 'MAINTENANCE_ROUTE_UNRESOLVED' });
      if (next.fail) throw Object.assign(new Error(next.fail.replace(/^Error: /, '')), { stack: next.fail });
      if (next.hang) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
      return next.title;
    },
  });
  const steps = [];
  for (const step of scenario.steps) {
    let returned = null;
    if (step.op === 'first') {
      const after = step.after === 'resolve' ? Promise.resolve() : step.after === 'reject' ? Promise.reject(new Error('x')) : undefined;
      returned = controller.scheduleFirst(step.session, step.prompt, after ? { after } : {});
    } else if (step.op === 'third') returned = controller.observeThird(step.session);
    else controller.disposeAll();
    await settle(scenario.timeoutMs ? scenario.timeoutMs * 4 : 40);
    steps.push({ ...step, returned });
  }
  return { name: scenario.name, steps, calls, promoted, logs: logs.map((l) => l.replace(/\s+$/, '')) };
}

// The completion: a route + provider script per case; the provider records its send.
const COMPLETION = [
  { name: 'a route sends one title request', source: '  Fix the build  ', options: { sessionId: 's1', locale: 'ko-KR' }, route: { provider: 'openai', model: 'gpt-x' }, reply: 'Build fix' },
  { name: 'effort fast and the cache role follow the route', source: 'text', options: { sessionId: 's2', locale: '' }, route: { provider: 'anthropic', model: 'haiku', effort: ' medium ', fast: true }, reply: { content: 'Title' } },
  { name: 'no session id sends none and structured replies are joined', source: 'text', options: {}, route: { provider: 'openai', model: 'm' }, reply: { content: [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }] } },
  { name: 'an empty source is no request', source: '   ', options: {}, route: { provider: 'openai', model: 'm' }, reply: 'x' },
  { name: 'an unresolved route carries the machine marker', source: 'text', options: {}, route: null },
  { name: 'a route without a model is refused', source: 'text', options: {}, route: { provider: 'openai', model: ' ' } },
  { name: 'a missing provider is refused', source: 'text', options: {}, route: { provider: 'ghost', model: 'm' }, noProvider: true },
  { name: 'a provider init failure escapes', source: 'text', options: {}, route: { provider: 'openai', model: 'm' }, initFails: 'init exploded' },
];

async function runCompletion(scenario) {
  const sent = [];
  const inits = [];
  const generate = createTitleCompletion({
    loadConfig: () => ({ providers: { openai: { enabled: true } } }),
    resolveMaintenanceRoute: ({ agent }) => { sent.push({ agent }); return scenario.route; },
    initProviders: async (providers, options) => {
      inits.push({ providers, signal: Boolean(options?.signal) });
      if (scenario.initFails) throw new Error(scenario.initFails);
    },
    getProvider: () => (scenario.noProvider ? null : {
      send: async (messages, model, tools, opts) => {
        sent.push({ messages, model, tools: tools ?? null, opts: JSON.parse(JSON.stringify({ ...opts, signal: undefined })), hasSignal: opts.signal != null });
        return scenario.reply;
      },
    }),
  });
  let result;
  try {
    result = { ok: await generate(scenario.source, { ...scenario.options, signal: new AbortController().signal }) };
  } catch (error) {
    result = { error: error.message, code: error.code ?? null };
  }
  return { name: scenario.name, source: scenario.source, options: scenario.options, route: scenario.route, result, sent, inits };
}

const controller = [];
for (const scenario of CONTROLLER) controller.push(await runController(scenario));
const completion = [];
for (const scenario of COMPLETION) completion.push(await runCompletion(scenario));

writeJson(join(stage, 'golden.json'), { controller, completion });
writeSetManifest(stage, { set: 'session-titles', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
