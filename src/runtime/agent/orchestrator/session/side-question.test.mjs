import './loop/test-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendProviderRequest } from './loop/send-phase.mjs';
import {
  askSideQuestion,
  cancelSideQuestion,
  SIDE_QUESTION_NO_REQUEST,
  SIDE_QUESTION_TOOL_ATTEMPT,
} from './side-question.mjs';
import { forgetSideQuestion, sideQuestionRequest } from './side-question-store.mjs';
import { _withRegisteredProviderForTestAsync } from '../providers/registry.mjs';
import { loadSession } from './store.mjs';
import { _clearLiveSession, setLiveSession } from './store/live-state.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setCacheWarmDepsForTest,
  cacheWarmDelayMs,
  IDLE_RETURN_LOOKBACK_MS,
  IDLE_RETURN_MEASURED_WINDOW_MS,
} from './cache-warm.mjs';
import { createIdleGapStore } from './prompt-cache-idle-gaps.mjs';

const TOOLS = Object.freeze([{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }]);

// A provider whose replies are scripted per call; every call is recorded.
function scriptedProvider(...replies) {
  const calls = [];
  return {
    name: 'anthropic',
    calls,
    async send(messages, model, tools, opts) {
      calls.push({ messages, model, tools, opts });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return typeof reply === 'function' ? reply(opts) : reply;
    },
  };
}

function mainState(sessionId, provider, overrides = {}) {
  const session = { id: sessionId, provider: 'anthropic', model: 'claude-test', status: 'running', ...overrides };
  const messages = [
    { role: 'system', content: 'You are the Lead.' },
    { role: 'user', content: 'Refactor the parser.' },
  ];
  const opts = {
    sessionId,
    session,
    effort: 'high',
    fast: true,
    modelParameters: { temperature: 0.2 },
    promptCacheKey: `cache-${sessionId}`,
    cacheStrategy: { system: '1h', messages: '5m' },
    providerState: { chain: 1 },
    toolChoice: 'required',
    cacheBreakIntent: 'compaction',
    signal: new AbortController().signal,
    onTextDelta() {},
    onToolCall() {
      throw new Error('a side question must never dispatch a tool');
    },
  };
  return {
    state: {
      opts,
      provider,
      model: 'claude-test',
      messages,
      sessionRef: session,
      sessionId,
      signal: opts.signal,
      prefixGuardState: null,
      cacheBreakTraceKeys: new Set(),
      imageStrip: null,
      lastToolBatchEndedAt: 0,
      contextOverflowRetryUsed: false,
      transportRetriesUsed: 0,
      transportRetryMax: 0,
      imageStripUsed: false,
      thinkingReplayRepairUsed: false,
    },
    round: {
      iterT0: Date.now(),
      nextIteration: 1,
      sendTools: TOOLS,
      requestToolScope: { session, provider: 'anthropic', messages, requestTools: TOOLS },
    },
  };
}

const MAIN_REPLY = {
  content: 'Reading the parser first.',
  toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'parser.mjs' } }],
  usage: { inputTokens: 10, outputTokens: 5 },
  providerState: { chain: 2 },
};

async function sendMain(sessionId, provider, overrides) {
  const { state, round } = mainState(sessionId, provider, overrides);
  const sent = await sendProviderRequest(state, round);
  return { state, round, sent };
}

test('a sent provider request is captured with its cache-relevant inputs, in memory only', async () => {
  const provider = scriptedProvider(MAIN_REPLY);
  const { state, sent } = await sendMain('btw-capture', provider);
  const request = sideQuestionRequest('btw-capture');
  assert.ok(request);
  assert.equal(request.provider, provider);
  assert.equal(request.model, 'claude-test');
  assert.equal(request.tools, TOOLS);
  assert.deepEqual(request.messages, sent.providerMessages);
  assert.equal(request.response, sent.result.response);
  // Cache-relevant options are kept; loop-only state and callbacks are not.
  assert.equal(request.opts.effort, 'high');
  assert.equal(request.opts.fast, true);
  assert.equal(request.opts.promptCacheKey, 'cache-btw-capture');
  assert.deepEqual(request.opts.cacheStrategy, { system: '1h', messages: '5m' });
  for (const key of ['signal', 'toolChoice', 'cacheBreakIntent', 'onTextDelta', 'onToolCall']) {
    assert.equal(Object.hasOwn(request.opts, key), false, key);
  }
  // Nothing lands on the session record.
  assert.equal(
    Object.keys(state.sessionRef).some((key) => /side/i.test(key)),
    false
  );
  forgetSideQuestion('btw-capture');
});

test('the fork re-sends the saved request unchanged plus the reply and the question', async () => {
  const provider = scriptedProvider(MAIN_REPLY, { content: '  The parser is in parser.mjs.  ', usage: null });
  const { state, sent } = await sendMain('btw-fork', provider);
  const transcriptBefore = structuredClone(state.messages);
  const sessionBefore = structuredClone(state.sessionRef);

  const answer = await askSideQuestion('btw-fork', 'Where is the parser?');
  assert.deepEqual(answer, { text: 'The parser is in parser.mjs.' });

  const [main, fork] = provider.calls;
  assert.equal(fork.model, main.model);
  assert.equal(fork.tools, main.tools, 'the same tool list, so the same cache key');
  // Cache-identical prefix: the saved messages come first, unchanged and by identity.
  const prefix = sent.providerMessages;
  assert.equal(fork.messages.length, prefix.length + 3);
  prefix.forEach((message, index) => assert.equal(fork.messages[index], message, `prefix[${index}]`));
  // Same request options as the main send (minus loop-only state).
  for (const key of ['sessionId', 'session', 'effort', 'fast', 'modelParameters', 'promptCacheKey', 'cacheStrategy']) {
    assert.equal(fork.opts[key], main.opts[key], key);
  }
  assert.equal(fork.opts.sharedCachePrefixCount, prefix.length);
  assert.equal(Object.hasOwn(fork.opts, 'sharedCachePrefixTail'), false);
  assert.deepEqual(fork.opts.providerState, { chain: 2 }, 'continues from the reply it appends');
  assert.notEqual(fork.opts.signal, state.signal);
  assert.equal(Object.hasOwn(fork.opts, 'toolChoice'), false);
  assert.equal(
    Object.values(fork.opts).some((value) => typeof value === 'function'),
    false,
    'no callback reaches the fork, so no tool can be dispatched'
  );
  // Suffix: the reply, a stub result for its tool call, then the question.
  const [reply, stub, question] = fork.messages.slice(prefix.length);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.content, 'Reading the parser first.');
  assert.deepEqual(
    reply.toolCalls.map((call) => call.id),
    ['call_1']
  );
  assert.equal(stub.role, 'tool');
  assert.equal(stub.toolCallId, 'call_1');
  assert.equal(question.role, 'user');
  assert.equal(question.meta.source, 'steering');
  assert.match(question.content, /side question/i);
  assert.match(question.content, /Where is the parser\?/);

  // No transcript, session or capture mutation.
  assert.deepEqual(state.messages, transcriptBefore);
  assert.deepEqual(state.sessionRef, sessionBefore);
  assert.equal(sideQuestionRequest('btw-fork').messages.length, prefix.length);
  forgetSideQuestion('btw-fork');
});

test('a request still in flight is forked without a reply', async () => {
  let release;
  const provider = scriptedProvider(
    () => new Promise((resolve) => (release = () => resolve(MAIN_REPLY))),
    { content: 'Still reading.' }
  );
  const { state, round } = mainState('btw-inflight', provider);
  const main = sendProviderRequest(state, round);
  await new Promise((resolve) => setImmediate(resolve));
  const answer = await askSideQuestion('btw-inflight', 'Status?');
  assert.equal(answer.text, 'Still reading.');
  const fork = provider.calls[1];
  assert.equal(fork.messages.length, provider.calls[0].messages.length + 1);
  assert.deepEqual(fork.opts.providerState, { chain: 1 }, 'the state the in-flight request was sent with');
  release();
  await main;
  forgetSideQuestion('btw-inflight');
});

test('a tool call from the fork is never executed and is reported as text', async () => {
  const provider = scriptedProvider(MAIN_REPLY, {
    content: '',
    toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'x' } }],
  });
  await sendMain('btw-tool', provider);
  const answer = await askSideQuestion('btw-tool', 'Open x?');
  assert.deepEqual(answer, { text: SIDE_QUESTION_TOOL_ATTEMPT });
  assert.equal(provider.calls.length, 2, 'one provider call, no tool loop');
  forgetSideQuestion('btw-tool');
});

test('without a sent request the side question is refused', async () => {
  await assert.rejects(askSideQuestion('btw-none', 'Anything?'), { message: SIDE_QUESTION_NO_REQUEST });
  await assert.rejects(askSideQuestion('', 'Anything?'), { message: SIDE_QUESTION_NO_REQUEST });
});

function storedSession(id, messages, overrides = {}) {
  const session = {
    id,
    provider: 'anthropic',
    model: 'claude-test',
    effort: 'high',
    status: 'idle',
    promptCacheKey: `cache-${id}`,
    tools: TOOLS.map((tool) => ({ ...tool })),
    messages,
    ...overrides,
  };
  setLiveSession(session);
  // The first read stamps the lifecycle fields; the state compared is what follows.
  loadSession(id);
  return session;
}

test('a session with a transcript but no saved request forks the request its next turn would send', async () => {
  const provider = scriptedProvider({ content: ' It is in parser.mjs. ', usage: null });
  const messages = [
    { role: 'system', content: 'You are the Lead.' },
    { role: 'user', content: 'Refactor the parser.' },
    { role: 'assistant', content: 'Reading the parser first.' },
  ];
  const session = storedSession('btw-restored', messages);
  const before = structuredClone(session);
  assert.equal(sideQuestionRequest('btw-restored'), null);

  await _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
    const answer = await askSideQuestion('btw-restored', 'Where is the parser?');
    assert.deepEqual(answer, { text: 'It is in parser.mjs.' });
  });

  assert.equal(provider.calls.length, 1, 'one provider call, no tool loop');
  const [fork] = provider.calls;
  assert.equal(fork.model, 'claude-test');
  assert.deepEqual(
    fork.tools.map((tool) => tool.name),
    ['read']
  );
  assert.equal(fork.messages.length, messages.length + 1);
  messages.forEach((message, index) => assert.equal(fork.messages[index], message, `prefix[${index}]`));
  const question = fork.messages.at(-1);
  assert.equal(question.role, 'user');
  assert.equal(question.meta.source, 'steering');
  assert.match(question.content, /Where is the parser\?/);
  assert.equal(fork.opts.session, session);
  assert.equal(fork.opts.effort, 'high');
  assert.equal(fork.opts.promptCacheKey, 'cache-btw-restored');
  assert.equal(fork.opts.sharedCachePrefixCount, messages.length);
  assert.equal(fork.opts.providerToolSnapshotAuthoritative, true);
  assert.equal(
    Object.values(fork.opts).some((value) => typeof value === 'function'),
    false,
    'no callback reaches the fork, so no tool can be dispatched'
  );
  assert.notEqual(fork.opts.transportScope, undefined, 'its own transport scope');

  // Nothing was written to the transcript or the session, and nothing was saved.
  assert.deepEqual(messages, before.messages);
  assert.deepEqual(session, before);
  assert.equal(sideQuestionRequest('btw-restored'), null);
  _clearLiveSession('btw-restored');
});

test('a session without a conversation or a provider still refuses the side question', async () => {
  const provider = scriptedProvider({ content: 'Never asked.' });
  storedSession('btw-empty', [{ role: 'system', content: 'You are the Lead.' }]);
  storedSession('btw-no-provider', [
    { role: 'system', content: 'You are the Lead.' },
    { role: 'user', content: 'Hello.' },
  ], { provider: 'missing-provider' });
  await _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
    await assert.rejects(askSideQuestion('btw-empty', 'Anything?'), { message: SIDE_QUESTION_NO_REQUEST });
    await assert.rejects(askSideQuestion('btw-no-provider', 'Anything?'), { message: SIDE_QUESTION_NO_REQUEST });
  });
  assert.equal(provider.calls.length, 0);
  _clearLiveSession('btw-empty');
  _clearLiveSession('btw-no-provider');
});

test('a failed main send keeps the previous request and provider errors reach the caller', async () => {
  const failure = Object.assign(new Error('invalid_request_error: tools.0 schema is invalid'), { status: 400 });
  const provider = scriptedProvider(MAIN_REPLY, () => Promise.reject(failure));
  await sendMain('btw-error', provider);
  const saved = sideQuestionRequest('btw-error');
  const { state, round } = mainState('btw-error', provider);
  await assert.rejects(sendProviderRequest(state, round));
  assert.equal(sideQuestionRequest('btw-error'), saved);
  await assert.rejects(askSideQuestion('btw-error', 'Why?'), { message: failure.message });
  forgetSideQuestion('btw-error');
});

function abortableReply(opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
  });
}

test('cancelSide aborts the side question in flight through the provider signal', async () => {
  const provider = scriptedProvider(MAIN_REPLY, abortableReply);
  await sendMain('btw-cancel', provider);
  const pending = askSideQuestion('btw-cancel', 'Long one?');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.calls[1].opts.signal.aborted, false);
  assert.equal(cancelSideQuestion('btw-cancel'), true);
  assert.equal(provider.calls[1].opts.signal.aborted, true);
  await assert.rejects(pending, { message: 'Side question canceled.' });
  assert.equal(cancelSideQuestion('btw-cancel'), false, 'nothing left in flight');
  forgetSideQuestion('btw-cancel');
});

test('a new side question aborts the previous one', async () => {
  const provider = scriptedProvider(MAIN_REPLY, abortableReply, { content: 'Second answer.' });
  await sendMain('btw-replace', provider);
  const first = askSideQuestion('btw-replace', 'First?');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await askSideQuestion('btw-replace', 'Second?');
  assert.equal(second.text, 'Second answer.');
  await assert.rejects(first, { message: 'Side question canceled.' });
  assert.equal(provider.calls[1].opts.signal.aborted, true);
  forgetSideQuestion('btw-replace');
});

test('agent sessions capture nothing', async () => {
  const provider = scriptedProvider(MAIN_REPLY);
  await sendMain('btw-agent', provider, { owner: 'agent' });
  assert.equal(sideQuestionRequest('btw-agent'), null);
});

test('a side question neither closes nor moves the idle gap the cache warmer learns', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'btw-gaps-'));
  const gaps = createIdleGapStore({
    path: join(dir, 'gaps.json'),
    lookbackMs: IDLE_RETURN_LOOKBACK_MS,
    windowMs: IDLE_RETURN_MEASURED_WINDOW_MS,
    minMs: cacheWarmDelayMs(5 * 60_000),
  });
  _setCacheWarmDepsForTest({ gaps: () => gaps });
  t.after(async () => {
    _setCacheWarmDepsForTest();
    forgetSideQuestion('btw-gap');
    await gaps.flush();
    rmSync(dir, { recursive: true, force: true });
  });
  const provider = scriptedProvider(MAIN_REPLY, { content: 'In parser.mjs.', usage: null });
  await sendMain('btw-gap', provider);
  const anchor = gaps.openAt('btw-gap');
  assert.ok(anchor > 0, 'the main request anchored the idle clock');
  assert.deepEqual(await askSideQuestion('btw-gap', 'Where is the parser?'), { text: 'In parser.mjs.' });
  assert.equal(gaps.openAt('btw-gap'), anchor);
  assert.deepEqual(gaps.gaps('btw-gap'), []);
});

test('the fork inherits the wire route the main request was pinned to', async () => {
  const route = { provider: 'anthropic', model: 'claude-test', wire: 'messages', nativeDeferredTools: true };
  const provider = scriptedProvider(MAIN_REPLY, { content: 'ok', usage: null });
  const { state } = mainState('btw-route', provider);
  state.opts.wireRoute = route;
  await sendProviderRequest(state, mainState('btw-route', provider).round);
  assert.equal(sideQuestionRequest('btw-route').opts.wireRoute, route);
  await askSideQuestion('btw-route', 'Which wire?');
  assert.equal(provider.calls.at(-1).opts.wireRoute, route);
  forgetSideQuestion('btw-route');
});

test('a restored session forks with the wire route it was pinned to', async () => {
  const route = { provider: 'anthropic', model: 'claude-test', wire: 'messages', nativeDeferredTools: true };
  const provider = scriptedProvider({ content: 'ok', usage: null });
  storedSession(
    'btw-route-restored',
    [
      { role: 'system', content: 'You are the Lead.' },
      { role: 'user', content: 'Refactor the parser.' },
      { role: 'assistant', content: 'Reading the parser first.' },
    ],
    { wireRoute: route }
  );
  await _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
    await askSideQuestion('btw-route-restored', 'Which wire?');
  });
  assert.equal(provider.calls[0].opts.wireRoute, route);
  _clearLiveSession('btw-route-restored');
});
