import '../loop/test-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import {
  captureSideQuestionRequest,
  compactionForkRequest,
  forgetSideQuestion,
  sideQuestionRequest,
} from '../side-question-store.mjs';

const SUMMARY = [
  '## Goal',
  '- continue the parser refactor',
  '## Constraints & Preferences',
  '- (none)',
  '## Progress',
  '### Done',
  '- read the parser',
  '### In Progress',
  '- refactor',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- (none)',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- (none)',
  '## Relevant Files',
  '- parser.mjs',
].join('\n');

const TOOLS = Object.freeze([{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }]);
const MAIN_OPTS = Object.freeze({
  effort: 'high',
  promptCacheKey: 'cache-main',
  cacheStrategy: { system: '1h', messages: '5m' },
});

function conversation() {
  return [
    { role: 'system', content: 'You are the Lead.' },
    ...Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `TURN_${i} `.padEnd(1_600, '.'),
    })),
    { role: 'user', content: 'Refactor the parser.' },
  ];
}

function mainProvider(
  name,
  reply = { content: SUMMARY, usage: { inputTokens: 900, cachedTokens: 30_000, outputTokens: 400 } }
) {
  const calls = [];
  return {
    name,
    calls,
    async send(messages, model, tools, opts) {
      calls.push({ messages, model, tools, opts });
      return typeof reply === 'function' ? reply(calls.length) : reply;
    },
  };
}

// The request the main loop sent last, settled with its reply.
function captureMain(sessionId, provider, messages) {
  const handle = captureSideQuestionRequest({
    sessionId,
    sessionRef: { id: sessionId },
    provider,
    model: 'main-model',
    messages,
    tools: TOOLS,
    opts: { ...MAIN_OPTS, sessionId, signal: new AbortController().signal, onTextDelta() {} },
  });
  handle.settle({ content: 'Reading the parser first.', usage: { inputTokens: 10, outputTokens: 5 } });
  return sideQuestionRequest(sessionId);
}

function compact({ sessionId, provider, messages, config = {}, getProviderFn }) {
  return runFreshContextCompact({
    sessionRef: {
      id: sessionId,
      provider: provider.name,
      model: 'main-model',
      contextWindow: 200_000,
      compaction: { conversationThresholdTokens: 1 },
    },
    messages,
    provider,
    model: 'main-model',
    compactBudgetTokens: 50_000,
    compactPolicy: { contextWindow: 200_000 },
    config,
    initProvidersFn: async () => {},
    getProviderFn: getProviderFn || (() => provider),
    sendOpts: {},
  });
}

test('the summary forks the cached main request: same prefix, tools, model and cache options', async (t) => {
  const sessionId = 'fork-summary-shared';
  t.after(() => forgetSideQuestion(sessionId));
  const provider = mainProvider('anthropic');
  const messages = conversation();
  const request = captureMain(sessionId, provider, messages.slice());
  const result = await compact({ sessionId, provider, messages });
  assert.equal(provider.calls.length, 1);
  const [call] = provider.calls;
  // The shared prefix is the saved request's own message objects, unchanged.
  assert.equal(call.messages.length, request.messages.length + 2);
  for (const [index, message] of request.messages.entries()) assert.equal(call.messages[index], message);
  assert.equal(call.messages.at(-2).role, 'assistant');
  assert.equal(call.messages.at(-1).role, 'user');
  assert.match(
    call.messages.at(-1).content,
    /^<compaction-request>[\s\S]*## Relevant Files[\s\S]*<\/compaction-request>$/
  );
  assert.equal(call.model, 'main-model');
  assert.equal(call.tools, TOOLS);
  // Cache-relevant options are the main request's; no `:compact` isolation.
  assert.equal(call.opts.promptCacheKey, 'cache-main');
  assert.equal(call.opts.sessionId, sessionId);
  assert.equal(call.opts.effort, 'high');
  assert.deepEqual(call.opts.cacheStrategy, MAIN_OPTS.cacheStrategy);
  assert.equal(call.opts.sharedCachePrefixCount, request.messages.length);
  assert.equal(call.opts.maxOutputTokens, undefined);
  assert.equal(call.opts.admissionOwner, sessionId);
  assert.ok(call.opts.transportScope);
  // Usage attribution only; the prompt is the main request's.
  assert.equal(call.opts.requestKind, 'compaction');
  assert.equal(result.diagnostics.pipeline.generated.mode, 'shared-prefix');
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 400, cachedTokens: 30_000, cacheWriteTokens: 0 });
  assert.ok(result.messages.some((m) => String(m.content).includes('continue the parser refactor')));
  // The compacted transcript is no longer what the saved request carried.
  assert.equal(compactionForkRequest(sessionId), null);
  assert.ok(sideQuestionRequest(sessionId), 'a side question may still fork it');
});

test('a different summary route cannot share the cache and runs the isolated request', async (t) => {
  const sessionId = 'fork-summary-maintenance';
  t.after(() => forgetSideQuestion(sessionId));
  const provider = mainProvider('anthropic');
  const maintenance = mainProvider('fixture-maintenance', { content: SUMMARY });
  maintenance.getCachedModelInfo = () => ({ contextWindow: 200_000 });
  const messages = conversation();
  captureMain(sessionId, provider, messages.slice());
  const result = await compact({
    sessionId,
    provider,
    messages,
    config: {
      compaction: { summaryMode: 'maintainer' },
      agents: { maintainer: { provider: maintenance.name, model: 'maintenance-model' } },
    },
    getProviderFn: (name) => (name === maintenance.name ? maintenance : provider),
  });
  assert.equal(provider.calls.length, 0);
  assert.equal(maintenance.calls.length, 1);
  assert.equal(maintenance.calls[0].opts.sessionId, `${sessionId}:compact`);
  assert.equal(maintenance.calls[0].tools, undefined);
  assert.equal(result.diagnostics.pipeline.generated.mode, 'isolated');
  assert.equal(result.diagnostics.pipeline.generated.sharedPrefixFallback, 'different_route');
});

test('without a settled request, or after the fork answers with a tool call, the isolated request runs', async (t) => {
  const sessionId = 'fork-summary-fallback';
  t.after(() => forgetSideQuestion(sessionId));
  const plain = mainProvider('anthropic', { content: SUMMARY });
  const first = await compact({ sessionId, provider: plain, messages: conversation() });
  // No settled request: nothing is cached for this session.
  assert.equal(first.diagnostics.pipeline.generated.sharedPrefixFallback, 'cold_cache');
  assert.equal(first.diagnostics.pipeline.cacheWarm, false);
  assert.equal(plain.calls[0].opts.sessionId, `${sessionId}:compact`);

  const provider = mainProvider('anthropic', (n) =>
    n === 1
      ? {
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
          usage: { inputTokens: 5, cachedTokens: 100 },
        }
      : { content: SUMMARY, usage: { inputTokens: 50, outputTokens: 20 } }
  );
  const messages = conversation();
  captureMain(sessionId, provider, messages.slice());
  const result = await compact({ sessionId, provider, messages });
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].opts.sessionId, `${sessionId}:compact`);
  assert.equal(result.diagnostics.pipeline.generated.sharedPrefixFallback, 'tool_call');
  // Both paid requests count toward the compaction's usage.
  assert.deepEqual(result.usage, { inputTokens: 55, outputTokens: 20, cachedTokens: 100, cacheWriteTokens: 0 });
});

test('a cancelled fork stays cancelled instead of falling back', async (t) => {
  const sessionId = 'fork-summary-abort';
  t.after(() => forgetSideQuestion(sessionId));
  const controller = new AbortController();
  const provider = mainProvider('anthropic', () => {
    controller.abort(new Error('turn cancelled'));
    throw new Error('aborted by caller');
  });
  const messages = conversation();
  captureMain(sessionId, provider, messages.slice());
  await assert.rejects(
    runFreshContextCompact({
      sessionRef: {
        id: sessionId,
        provider: provider.name,
        model: 'main-model',
        contextWindow: 200_000,
        compaction: { conversationThresholdTokens: 1 },
      },
      messages,
      provider,
      model: 'main-model',
      compactBudgetTokens: 50_000,
      compactPolicy: { contextWindow: 200_000 },
      config: {},
      signal: controller.signal,
      sendOpts: {},
    }),
    /turn cancelled/
  );
  assert.equal(provider.calls.length, 1);
});
