#!/usr/bin/env node
// The `cache_break` trace rows (`traceCacheBreak`, cache-break-trace.mjs). Two parts:
// - `loop`: Node's agent loop (`agentLoop`) over a provider that refuses the turn's image once ("Could not process
//   image", status 400) and answers the replay: the request-local strip settles with the intentional
//   `image_strip_nonpersistent_rebaseline` row (send-phase.mjs `settleImageStrip`). Kept: every request's message count
//   and image count, the `cache_break` rows of the local trace file, and the `[cache-break]` stderr lines.
// - `payloads`: `traceCacheBreak` over records that reach every field of `buildCacheBreakPayload` and the stderr line
//   (text cleaning, hash cut, number coercion, the null drop), with the row it hands its trace function.
// - `turns`: one session through six `agentLoop` turns: the usage-detected `actual_cache_miss`, a `model_changed` and a
//   `tool_schema_changed` request break, and the `manual_compaction` break a compaction between turns tags.
// - `guard`: `prepareProviderPrefixGuard` over fingerprints reaching each of its breaks (and its refusals).
// - `prefix`, `seeded`: the Anthropic request fingerprints the cache-miss row names its moved blocks from.
//
//   node benchmarks/rust-core/recorders/record-cache-break.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/cache-break/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-cache-break.mjs';
const T0 = 1700000000000;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-cache-break-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_DIAGNOSTICS = '1';
delete process.env.NODE_TEST_CONTEXT;
Date.now = () => T0;

const orch = 'src/runtime/agent/orchestrator';
const { drainAgentTrace } = await importFrom(tree, `${orch}/agent-trace-io.mjs`);
const { traceCacheBreak } = await importFrom(tree, `${orch}/cache-break-trace.mjs`);
const { agentLoop } = await importFrom(tree, `${orch}/session/agent-loop.mjs`);

const stderrLines = [];
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  for (const line of text.split('\n')) if (line.startsWith('[cache-break] ')) stderrLines.push(line);
  return writeStderr(chunk, ...rest);
};

const tracePath = join(root, 'history', 'agent-trace.jsonl');
const traceRows = () => {
  try {
    return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// The loop: the system prompt and one user turn with an image; the first send is refused, the replay answers.
const images = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'image').length : 0);
const requests = [];
const messages = [
  { role: 'system', content: 'Stable instructions.' },
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
];
const session = { id: 'sess_cache_break', owner: 'user', provider: 'anthropic', cwd: root, messages: messages.slice() };
await agentLoop(
  {
    name: 'anthropic',
    async send(sent) {
      requests.push({ messages: sent.length, images: sent.reduce((n, m) => n + images(m), 0) });
      if (requests.length === 1) throw Object.assign(new Error('Could not process image'), { status: 400 });
      return { content: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
    },
  },
  messages,
  'claude-test',
  [],
  null,
  root,
  { session, sessionId: session.id }
);
await drainAgentTrace();
const loopRows = traceRows().filter((line) => JSON.parse(line).kind === 'cache_break');
const loopStderr = stderrLines.splice(0);

// The payload builder and the stderr line over every field.
const records = [
  {
    sessionId: 's-all', iteration: 3, classification: 'unexpected\nline', reason: 'prefix\tchanged', source: 'request_prefix',
    provider: 'openai-oauth', model: 'gpt-test', transport: 'websocket', intentionalTransition: 'automatic_compaction',
    index: 4, previousCount: 9, nextCount: '10', previousHash: 'abcdef0123456789abcdef', nextHash: 'fedcba9876543210fedcba',
    previousRequestPrefixHash: '0011223344556677889900', nextRequestPrefixHash: '9988776655443322110011', requestPrefixChanged: true,
    cachedTokens: 1200, promptTokens: 5000, uncachedTokens: 3800, cacheRatio: 0.24, actualCacheMiss: true,
    previousCachedPrefixTokens: 4800, idleMs: 61000, missingPrefixGuardBaseline: true,
    inputPrefixMismatchIndex: 2, inputPrefixMismatchPreviousCount: 7, inputPrefixMismatchCurrentCount: 8,
    inputPrefixMismatchExpectedType: 'message', inputPrefixMismatchExpectedHash: '1234567890abcdef1234',
    inputPrefixMismatchActualType: 'function_call', inputPrefixMismatchActualHash: 'abcdef1234567890abcd',
    changedBlocks: 'tools,s1', markersChanged: false, lostMessageBreakpoints: 'm12',
  },
  { sessionId: 's-empty' },
  { sessionId: '', iteration: '7', classification: '', reason: null, index: null, previousCount: 'x', cachedTokens: '', idleMs: true, missingPrefixGuardBaseline: false, markersChanged: 'yes', requestPrefixChanged: 'true', actualCacheMiss: 1 },
  { sessionId: 's-long', iteration: 1.5, classification: 'c'.repeat(130), model: 'é'.repeat(125), previousHash: '\n\nabc\tdef', changedBlocks: 'none', markersChanged: true },
];
const payloads = records.map((record) => {
  const rows = [];
  const lines = [];
  const payload = traceCacheBreak(structuredClone(record), { traceFn: (row) => rows.push(row), stderrFn: (line) => lines.push(line) });
  return { record, payload, row: rows[0] ?? null, stderr: lines.join('') };
});

// The turns: one session through six turns of `agentLoop` (each turn's answer joins the transcript as the turn commit adds it),
// the session record carrying what the loop keeps on it between turns (`_providerPrefixGuardState`, `lastProviderSendAt`,
// `lastProviderCachedPrefixTokens`, `pendingCacheBreakIntent`). Each turn's provider answer carries the usage given.
const turnSession = { id: 'sess_cache_turns', owner: 'user', provider: 'anthropic', cwd: root, providerCacheOpts: { cacheStrategy: { messages: '5m' } }, messages: [] };
const convo = [{ role: 'system', content: 'Stable instructions.' }];
const echoTool = { name: 'echo', description: 'Echoes its input.', inputSchema: { type: 'object', properties: {} } };
const usage = (input, cached, write) => ({ inputTokens: input, outputTokens: 2, cachedTokens: cached, cacheWriteTokens: write, promptTokens: input + cached + write });
const steps = [
  { name: 'first', prompt: 'one', model: 'claude-test', tools: [], usage: usage(10, 0, 6000) },
  { name: 'cache miss', prompt: 'two', model: 'claude-test', tools: [], usage: usage(10, 100, 50) },
  { name: 'model switch', prompt: 'three', model: 'claude-test-2', tools: [], usage: usage(10, 0, 7000) },
  { name: 'compaction between turns', compact: true, prompt: 'four', model: 'claude-test-2', tools: [], usage: usage(10, 0, 3000) },
  { name: 'tool schema', prompt: 'five', model: 'claude-test-2', tools: [echoTool], usage: usage(10, 3000, 100) },
  { name: 'warm', prompt: 'six', model: 'claude-test-2', tools: [echoTool], usage: usage(10, 3100, 20) },
];
const turns = [];
for (const [index, step] of steps.entries()) {
  if (step.compact) {
    // What a manual compaction leaves (compaction-runner.mjs): a rewritten transcript and the one-shot intent.
    convo.splice(1, convo.length - 1, { role: 'user', content: 'Summary of the earlier turns.' }, { role: 'assistant', content: 'Noted.' });
    turnSession.pendingCacheBreakIntent = 'manual_compaction';
  }
  convo.push({ role: 'user', content: step.prompt });
  const before = traceRows().length;
  stderrLines.splice(0);
  const answer = `answer ${index + 1}`;
  const result = await agentLoop(
    {
      name: 'anthropic',
      async send() {
        return { content: answer, toolCalls: [], stopReason: 'end_turn', usage: step.usage };
      },
    },
    convo,
    step.model,
    step.tools,
    null,
    root,
    { session: turnSession, sessionId: turnSession.id }
  );
  convo.push({ role: 'assistant', content: result.content });
  await drainAgentTrace();
  turns.push({
    name: step.name,
    prompt: step.prompt,
    answer,
    model: step.model,
    tools: step.tools.map((tool) => tool.name),
    compact: step.compact === true,
    usage: step.usage,
    rows: traceRows().slice(before).filter((line) => JSON.parse(line).kind === 'cache_break'),
    stderr: stderrLines.splice(0),
    record: { lastProviderCachedPrefixTokens: turnSession.lastProviderCachedPrefixTokens ?? null, pendingCacheBreakIntent: turnSession.pendingCacheBreakIntent ?? null },
  });
}

// The routes: the breaks only a real turn reaches, each through `agentLoop` over one session, the loop keeping the guard state
// on the session record between turns as it settles a send. A step names the whole transcript the turn starts from, the
// session's provider and the loop's native tools; a refused step (the guard throws before the send) is kept with the error.
const routeSessions = [
  {
    name: 'a history that shrank, a prefix that was rewritten',
    provider: 'anthropic',
    steps: [
      { name: 'first', convo: [['system', 'Stable instructions.'], ['user', 'one']] },
      { name: 'continued', convo: [['system', 'Stable instructions.'], ['user', 'one'], ['assistant', 'answer'], ['user', 'two']] },
      { name: 'shrunk', convo: [['system', 'Stable instructions.'], ['user', 'one'], ['assistant', 'answer']] },
      { name: 'rewritten', convo: [['system', 'Stable instructions.'], ['user', 'ONE'], ['assistant', 'answer'], ['user', 'two'], ['assistant', 'answer'], ['user', 'three']] },
      { name: 'continued again', convo: [['system', 'Stable instructions.'], ['user', 'one'], ['assistant', 'answer'], ['user', 'two'], ['assistant', 'answer'], ['user', 'three']] },
    ],
  },
  {
    name: 'a route to another provider, a native tool added',
    provider: 'anthropic',
    steps: [
      { name: 'first', convo: [['system', 'Stable instructions.'], ['user', 'one']] },
      { name: 'another provider', provider: 'openai', convo: [['system', 'Stable instructions.'], ['user', 'one'], ['assistant', 'answer'], ['user', 'two']] },
      { name: 'a native tool', provider: 'openai', nativeTools: [{ type: 'web_search' }], convo: [['system', 'Stable instructions.'], ['user', 'one'], ['assistant', 'answer'], ['user', 'two'], ['assistant', 'answer'], ['user', 'three']] },
    ],
  },
];
const routes = [];
for (const [at, scenario] of routeSessions.entries()) {
  const routeSession = { id: `sess_cache_route_${at}`, owner: 'user', provider: scenario.provider, cwd: root, messages: [] };
  const done = [];
  for (const step of scenario.steps) {
    routeSession.provider = step.provider ?? routeSession.provider;
    const convo = step.convo.map(([role, content]) => ({ role, content }));
    const before = traceRows().length;
    stderrLines.splice(0);
    let sent = 0;
    let thrown = null;
    try {
      await agentLoop(
        { name: routeSession.provider, async send() { sent += 1; return { content: 'answer', toolCalls: [], stopReason: 'end_turn', usage: usage(10, 0, 0) }; } },
        convo,
        'claude-test',
        [],
        null,
        root,
        { session: routeSession, sessionId: routeSession.id, ...(step.nativeTools ? { nativeTools: step.nativeTools } : {}) }
      );
    } catch (error) {
      thrown = { name: error.name, code: error.code ?? null, message: error.message };
    }
    await drainAgentTrace();
    done.push({ name: step.name, convo: step.convo, provider: routeSession.provider, nativeTools: step.nativeTools ?? [], sent, thrown, rows: traceRows().slice(before).filter((line) => JSON.parse(line).kind === 'cache_break'), stderr: stderrLines.splice(0) });
  }
  routes.push({ name: scenario.name, session: routeSession.id, model: 'claude-test', steps: done });
}

// The compactions: a real compaction of a session, then the next turn's send. Each scenario is one session through
// `agentLoop` turns over a long conversation (the guard keeps its state on the session between them); the summary is
// the only part replaced (a provider whose summary requests answer SUMMARY_TEXT, everything else is the product's).
// - `manual`: the turns settle, then `runSessionCompaction(session, { mode: 'manual', force: true })` rewrites the
//   transcript and parks `pendingCacheBreakIntent`; the next turn's first send takes it.
// - `automatic`: the last turn's transcript is over the session's window, so `agentLoop`'s pre-send pass
//   (`runPreSendCompactPass`) compacts before the send and tags it itself.
const { runSessionCompaction } = await importFrom(tree, `${orch}/session/manager/compaction-runner.mjs`);
const { providerTokenCalibration } = await importFrom(tree, `${orch}/session/context-utils.mjs`);
const SUMMARY_TEXT = [
  '## Goal', '- continue', '## Constraints & Preferences', '- (none)', '## Progress', '### Done', '- older turns summarized',
  '### In Progress', '- (none)', '### Blocked', '- (none)', '## Key Decisions', '- (none)', '## Next Steps', '- continue',
  '## Critical Context', '- (none)', '## Relevant Files', '- (none)',
].join('\n');
const words = (count, word) => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');
const compactionSystem = [{ role: 'system', content: 'Stable instructions.' }];
const compactionRoutes = [];
for (const scenario of [
  { name: 'manual', session: 'sess_cache_compact_manual', turns: 3, words: 150, window: 100000, compactBetween: true },
  { name: 'automatic', session: 'sess_cache_compact_auto', turns: 5, words: 1500, window: 20000, compactBetween: false },
]) {
  const record = {
    id: scenario.session, owner: 'user', provider: 'anthropic', model: 'claude-test', cwd: root,
    contextWindow: scenario.window, rawContextWindow: scenario.window, effectiveContextWindowPercent: 100,
    tools: [], compaction: { auto: scenario.name === 'automatic', conversationThresholdTokens: 1 },
    providerCacheOpts: { cacheStrategy: { messages: '5m' } }, messages: [],
  };
  const { messages: _omitted, cwd: _temporary, ...initialHeader } = structuredClone(record);
  const transcript = compactionSystem.map((message) => ({ ...message }));
  const steps = [];
  let summaries = 0;
  const run = async (name, prompt) => {
    transcript.push({ role: 'user', content: prompt });
    const before = traceRows().length;
    stderrLines.splice(0);
    const sent = [];
    const seen = transcript.length;
    const answer = `answer to ${name}`;
    record.messages = transcript;
    const result = await agentLoop(
      {
        name: 'anthropic',
        async send(messages) {
          // A summary request is the compaction pipeline's own; the turn's request is the one over the transcript.
          const summary = messages.at(-1)?.content !== prompt;
          if (summary) summaries += 1;
          sent.push({ summary, messages: messages.length });
          return { content: summary ? SUMMARY_TEXT : answer, toolCalls: [], stopReason: 'end_turn', usage: usage(10, 0, 100) };
        },
      },
      transcript, 'claude-test', [], null, root, { session: record, sessionId: record.id }
    );
    await drainAgentTrace();
    transcript.push({ role: 'assistant', content: result.content });
    steps.push({
      name, prompt, answer, transcriptBefore: seen, sent, transcriptAfter: transcript.length,
      rows: traceRows().slice(before).filter((line) => JSON.parse(line).kind === 'cache_break'),
      stderr: stderrLines.splice(0), pending: record.pendingCacheBreakIntent ?? null,
    });
  };
  for (let turn = 1; turn <= scenario.turns; turn += 1) await run(`turn ${turn}`, words(scenario.words, `u${turn}_`));
  let compaction = null;
  if (scenario.compactBetween) {
    const before = transcript.map((message) => ({ ...message }));
    let summaryRequests = 0;
    const outcome = await runSessionCompaction(record, {
      mode: 'manual', force: true, config: {}, model: record.model, sessionId: record.id,
      provider: { name: 'anthropic', async send() { summaryRequests += 1; return { content: SUMMARY_TEXT, usage: usage(10, 0, 100) }; } },
    });
    transcript.splice(0, transcript.length, ...record.messages);
    compaction = { before: before.map(({ role, content }) => ({ role, content })), outcome: { changed: outcome.changed, error: outcome.error ?? null }, summaryRequests, pending: record.pendingCacheBreakIntent ?? null };
  }
  await run('after', words(scenario.words, 'after_'));  compactionRoutes.push({
    name: scenario.name, session: scenario.session, model: record.model, provider: record.provider, contextWindow: scenario.window,
    header: initialHeader, tokenCalibration: providerTokenCalibration(record.provider), system: compactionSystem[0].content,
    summaryText: SUMMARY_TEXT, compaction, summaries,
    transcript: transcript.map(({ role, content }) => ({ role, content })), steps,
  });
}

// The guard's comparison (`prepareProviderPrefixGuard`) over request fingerprints that reach each of its breaks: the
// previous and next fingerprints, the options, the details handed to `onCacheBreak`, and whether it refused the send.
const { prepareProviderPrefixGuard } = await importFrom(tree, `${orch}/session/provider-prefix-guard.mjs`);
const print = (messages, prefix, options) => prepareProviderPrefixGuard(null, messages, prefix, options);
const user = (text) => ({ role: 'user', content: text });
const base = [{ role: 'system', content: 'S' }, user('a'), { role: 'assistant', content: 'b' }];
const toolA = { name: 'a', description: 'A.', inputSchema: { type: 'object' } };
const deferred = { ...toolA, name: 'd', deferLoading: true };
const guardCases = [
  ['continued', base, base.concat(user('c')), {}, {}, {}],
  ['history shrink', base, base.slice(0, 2), {}, {}, {}],
  ['message rewritten', base, [base[0], user('A'), base[2], user('c')], {}, {}, {}],
  ['message rewritten by a transcript rebuild', base, [base[0], user('A')], {}, {}, { cacheBreakIntent: 'transcript_rebuild', mutationSource: 'transcript_rebuild' }],
  ['compaction', base, [base[0], user('summary')], {}, {}, { cacheBreakIntent: 'automatic_compaction' }],
  ['compaction that changed nothing', base, base, {}, {}, { cacheBreakIntent: 'post_turn_compaction' }],
  ['compaction of the request prefix alone', base, base, { tools: [] }, { tools: [toolA] }, { cacheBreakIntent: 'deferred_body_compaction' }],
  ['a non-compaction intent', base, base, {}, {}, { cacheBreakIntent: 'tool_surface_bridge_migration' }],
  ['provider changed', base, base, {}, {}, { nextProvider: 'openai' }],
  ['model changed', base, base, {}, {}, { nextModel: 'm2' }],
  ['tool schema changed', base, base, { tools: [] }, { tools: [toolA] }, {}],
  ['native tool schema changed', base, base, { tools: [], nativeTools: [] }, { tools: [], nativeTools: [{ type: 'web_search' }] }, {}],
  ['a deferred tool on anthropic', base, base, { tools: [toolA] }, { tools: [toolA, deferred] }, {}],
  ['a deferred tool elsewhere', base, base, { tools: [toolA] }, { tools: [toolA, deferred] }, { provider: 'openai' }],
  ['request properties changed', base, base, { tools: [] }, { tools: [], extra: 1 }, {}],
];
const guard = guardCases.map(([name, before, after, beforePrefix, afterPrefix, options]) => {
  const provider = options.provider ?? 'anthropic';
  const previous = print(before, beforePrefix, { provider, model: 'm1' });
  const breaks = [];
  const nextOptions = {
    provider: options.nextProvider ?? provider,
    model: options.nextModel ?? 'm1',
    cacheBreakIntent: options.cacheBreakIntent,
    mutationSource: options.mutationSource ?? null,
    onCacheBreak: (details) => breaks.push(details),
  };
  let next = null;
  let thrown = null;
  try {
    next = prepareProviderPrefixGuard(previous, after, afterPrefix, nextOptions);
  } catch (error) {
    thrown = { name: error.name, code: error.code, message: error.message };
  }
  const { onCacheBreak: _drop, ...told } = nextOptions;
  return { name, previous, next: next ?? print(after, afterPrefix, { provider: nextOptions.provider, model: nextOptions.model }), options: told, breaks, thrown };
});

// The Anthropic request fingerprints (`anthropic-prefix-trace.mjs`) over bodies that move each block, marker and message
// breakpoint: per body, the session it is recorded under, the persisted fingerprint and the changes from the one before.
const prefixTrace = await importFrom(tree, `${orch}/providers/lib/anthropic-prefix-trace.mjs`);
const sys = (text, marker) => ({ type: 'text', text, ...(marker ? { cache_control: marker } : {}) });
const msg = (role, text, marker) => ({ role, content: [{ type: 'text', text, ...(marker ? { cache_control: marker } : {}) }] });
const tools1 = [{ name: 't1', description: 'T.', input_schema: { type: 'object' } }];
const thinking = { type: 'enabled', budget_tokens: 1024 };
const bodies = [
  ['first', 'sess_prefix_a', { model: 'm', max_tokens: 10, system: [sys('A', { type: 'ephemeral', ttl: '1h' }), sys('env')], messages: [msg('user', 'hi', { type: 'ephemeral' })], tools: tools1, thinking, stream: true }],
  ['grown', 'sess_prefix_a', { model: 'm', max_tokens: 10, system: [sys('A', { type: 'ephemeral', ttl: '1h' }), sys('env')], messages: [msg('user', 'hi'), { role: 'assistant', content: 'hello' }, msg('user', 'more', { type: 'ephemeral' })], tools: tools1, thinking, stream: true }],
  ['system and tools moved', 'sess_prefix_a', { model: 'm', max_tokens: 10, system: [sys('A', { type: 'ephemeral', ttl: '1h' }), sys('env2')], messages: [msg('user', 'hi'), { role: 'assistant', content: 'hello' }, msg('user', 'more', { type: 'ephemeral' })], tools: [], thinking, stream: true }],
  ['params and a rewritten message', 'sess_prefix_a', { model: 'm', max_tokens: 10, system: [sys('A'), sys('env2', { type: 'ephemeral' })], messages: [msg('user', 'HI'), { role: 'assistant', content: 'hello' }, msg('user', 'more', { type: 'ephemeral' })], output_config: { effort: 'high' }, stream: true }],
  ['another session', 'sess_prefix_b', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'plain' }], stream: true }],
];
const prefix = bodies.map(([name, session, body]) => {
  prefixTrace.recordAnthropicPrefix(session, prefixTrace.anthropicPrefixFingerprint(body));
  return { name, session, body, persisted: prefixTrace.persistableAnthropicPrefix(prefixTrace.latestAnthropicPrefix(session)), changes: prefixTrace.anthropicPrefixChanges(session) };
});
// A restarted process: the record's fingerprint seeds the session, a second seed is a no-op, and the next request is compared
// with the seeded one.
const seededFrom = prefix[1].persisted;
prefixTrace.seedAnthropicPrefix('sess_prefix_seeded', seededFrom);
prefixTrace.seedAnthropicPrefix('sess_prefix_seeded', prefix[3].persisted);
const seededBefore = prefixTrace.anthropicPrefixChanges('sess_prefix_seeded');
prefixTrace.recordAnthropicPrefix('sess_prefix_seeded', prefixTrace.anthropicPrefixFingerprint(bodies[2][2]));
const seeded = { from: seededFrom, body: bodies[2][2], changesBefore: seededBefore, changes: prefixTrace.anthropicPrefixChanges('sess_prefix_seeded') };

process.stderr.write = writeStderr;
rmSync(root, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'cache-break');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'traceCacheBreak: the rows and stderr lines of the image-strip replay of agentLoop, and the payload of every field',
  now: T0,
  loop: { session: session.id, model: 'claude-test', provider: 'anthropic', requests, rows: loopRows, stderr: loopStderr },
  payloads,
  turns: { session: turnSession.id, provider: 'anthropic', cacheStrategy: turnSession.providerCacheOpts.cacheStrategy, system: convo[0].content, steps: turns },
  routes,
  compactions: compactionRoutes,
  guard,
  prefix,
  seeded,
});
writeSetManifest(out, {
  set: 'cache-break',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    syntheticInputs: [
      'the loop: a system prompt and one user turn of text and one image; a provider named anthropic whose first send throws "Could not process image" with status 400 and whose second answers "ok"',
      'Date.now fixed at 1700000000000; MIXDOG_DIAGNOSTICS=1 so the local trace file is written',
      'the payload records: synthetic values reaching every buildCacheBreakPayload field',
      'the turns: six agentLoop turns of one anthropic session (a 5m messages cache) with the usage, model and tools given per turn, and a manual compaction\'s rewritten transcript and pending intent before the fourth',
      'the compactions: two anthropic sessions of long synthetic turns through agentLoop; the manual one is compacted by runSessionCompaction (mode manual, force) between turns, the automatic one crosses its 20000-token window so the loop\'s pre-send pass compacts; the summary provider answers one fixed summary text (the only replaced part)',
      'the guard cases: synthetic transcripts and request prefixes reaching every prepareProviderPrefixGuard branch',
      'the prefix bodies: synthetic Anthropic request bodies moving each fingerprinted block, marker and message breakpoint',
    ],
    exclusions: {
      deferred_body_compaction: 'no product path sets it: provider-prefix-guard.mjs:5-10 only accepts it as a compaction intent; the setters of a cache-break intent are pre-send-compact.mjs:461,613 (automatic_compaction), compaction-runner.mjs:737 (post_turn_compaction, manual_compaction), request-boundary.mjs:75,88 (tool_surface_bridge_migration, transcript_rebuild)',
      request_properties_changed: 'no product path reaches it: request-projection.mjs:52-58 hands the guard a prefix of the two tool lists only, and provider-prefix-guard.mjs:176-196 digests each list on its own, so a changed prefix with the same provider, model and both list digests cannot occur (the guard cases give the guard a prefix with another key)',
      post_turn_compaction: 'no product path sets it: compaction-runner.mjs:737 sets it only for mode "auto", and runSessionCompaction is called only with mode "manual" (session-crud.mjs:164 and :391, via session-ops.mjs:75 for /compact and auto-clear); the guard cases still give the comparison that intent',
    },
    keptWhole: 'the cache_break lines of the local trace file, per route step its transcript, provider, native tools, send count, refusal, rows and stderr lines, the [cache-break] stderr lines, each request\'s message and image count, per payload record its payload, row and stderr line, per turn its rows, stderr lines and record fields, per compaction scenario its compaction outcome, summary request count, parked intent, the transcript after, and per turn the sends (summary or turn, message count), rows, stderr lines and the parked intent, per guard case both fingerprints, the details told and the refusal, per prefix body the persisted fingerprint and the changes',
  },
});
commitStage(out, finalOut);
console.log(`loopRows=${loopRows.length} stderr=${loopStderr.length} payloads=${payloads.length}`);
process.exit(0);
