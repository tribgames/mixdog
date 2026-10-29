import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentStallAbortError,
  evaluateAgentWatchdogAbort,
  noteStoppedShellJobsOnError,
  partialHandoffTextFromSession,
  resolveAgentWatchdogPolicy,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
  watchdogStoppedHandoff,
} from './agent-progress-watchdog.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, STALL_TICK_MS } from '../stall-policy.mjs';
import { VertexAIProvider } from '../providers/vertex-ai.mjs';

test('the first-transport deadline sits one tick above the provider first-byte window', () => {
  const providerWindow = 466_000;
  const policy = resolveAgentWatchdogPolicy('worker', { providerFirstByteTimeoutMs: providerWindow });
  assert.equal(policy.firstTransportMs, providerWindow + STALL_TICK_MS);
  // The provider is still inside its own first-byte window and retry.
  const now = 10_000_000;
  const waiting = {
    stage: 'requesting',
    modelRequestStartedAt: now - providerWindow,
    waitingForTransport: true,
    waitingForFirstSemantic: true,
  };
  assert.equal(evaluateAgentWatchdogAbort(waiting, now, policy), null);
  const late = { ...waiting, modelRequestStartedAt: now - providerWindow - STALL_TICK_MS - 1 };
  assert.match(evaluateAgentWatchdogAbort(late, now, policy).message, /^agent first transport stale \(/);
});

test('the first-semantic ceiling covers the provider first-output budget, so a retry ends as the provider failure', () => {
  const outputBudget = 931_000;
  const policy = resolveAgentWatchdogPolicy('worker', {
    providerFirstByteTimeoutMs: 466_000,
    providerFirstOutputTimeoutMs: outputBudget,
  });
  assert.equal(policy.firstSemanticMs, outputBudget + STALL_TICK_MS);
  // Headers arrived, the retry is still waiting for its first chunk.
  const now = 10_000_000;
  const silent = {
    stage: 'requesting',
    modelRequestStartedAt: now - 700_000,
    waitingForTransport: false,
    waitingForFirstSemantic: true,
  };
  assert.equal(evaluateAgentWatchdogAbort(silent, now, policy), null);
  const late = { ...silent, modelRequestStartedAt: now - outputBudget - STALL_TICK_MS - 1 };
  assert.match(evaluateAgentWatchdogAbort(late, now, policy).message, /^agent first semantic response stale \(/);
  // Without a provider budget the 600s ceiling is unchanged.
  assert.equal(resolveAgentWatchdogPolicy('worker').firstSemanticMs, 600_000);
});

test('a Vertex Flex route raises the first-response deadlines above the 120s default; other tiers keep it', () => {
  const provider = new VertexAIProvider({});
  const budget = provider.firstResponseBudget('gemini-3.8-flash', { modelParameters: { serviceTier: 'flex' } });
  const policy = resolveAgentWatchdogPolicy('worker', {
    providerFirstByteTimeoutMs: budget?.transportMs,
    providerFirstOutputTimeoutMs: budget?.semanticMs,
  });
  assert.ok(policy.firstTransportMs > 600_000, `${policy.firstTransportMs}`);
  assert.equal(policy.firstTransportMs, budget.transportMs + STALL_TICK_MS);
  for (const modelParameters of [undefined, {}, { serviceTier: 'priority' }, { serviceTier: 'standard' }]) {
    assert.equal(provider.firstResponseBudget('gemini-3.8-flash', { modelParameters }), null);
  }
  assert.equal(resolveAgentWatchdogPolicy('worker').firstTransportMs, 120_000);
});

test('a per-agent first-response deadline applies above the floor; 0 keeps it off', () => {
  assert.equal(
    resolveAgentWatchdogPolicy('art-director', { firstResponseTimeoutMs: 900_000 }).firstTransportMs,
    900_000
  );
  // Below the provider window the floor wins, so the provider decides first.
  assert.equal(
    resolveAgentWatchdogPolicy('art-director', { firstResponseTimeoutMs: 1_000 }).firstTransportMs,
    PROVIDER_FIRST_BYTE_TIMEOUT_MS + STALL_TICK_MS
  );
  assert.equal(resolveAgentWatchdogPolicy('art-director', { firstResponseTimeoutMs: 0 }).firstTransportMs, 0);
});

test('a long tool call is not a stall while its heartbeat keeps progress fresh', () => {
  const policy = resolveAgentWatchdogPolicy('worker');
  const now = 10_000_000;
  const snapshot = {
    stage: 'tool_running',
    currentTool: 'task',
    modelRequestStartedAt: now - 20 * 60_000,
    toolStartedAt: now - 10 * 60_000,
    lastProgressAt: now - 30_000,
  };
  assert.equal(evaluateAgentWatchdogAbort(snapshot, now, policy), null);
  const silent = { ...snapshot, lastProgressAt: now - policy.idleStaleMs - 1 };
  assert.match(evaluateAgentWatchdogAbort(silent, now, policy).message, /^agent task stale \(/);
});

test("a turn waiting on the user's approval is waiting on them, not stalled, however long it takes", () => {
  const policy = resolveAgentWatchdogPolicy('worker');
  const now = 10_000_000;
  const hours = 3 * 60 * 60_000;
  const waiting = {
    stage: 'tool_running',
    currentTool: 'mcp__gmail__send_email',
    awaitingUser: 'approval',
    modelRequestStartedAt: now - hours,
    toolStartedAt: now - hours,
    lastProgressAt: now - hours,
    firstSemanticAt: now - hours,
  };
  assert.equal(evaluateAgentWatchdogAbort(waiting, now, policy), null, 'no idle stall');
  // Even a snapshot still counting a model response (a call dispatched while the
  // stream was open) is not aborted by the first-response deadlines.
  const streaming = {
    ...waiting,
    stage: 'streaming',
    waitingForTransport: true,
    waitingForFirstSemantic: true,
  };
  assert.equal(evaluateAgentWatchdogAbort(streaming, now, policy), null, 'no first-response stall');
  // The same silence without a pending approval is still a stall.
  const { awaitingUser: _awaiting, ...silent } = waiting;
  assert.match(evaluateAgentWatchdogAbort(silent, now, policy).message, /^agent task stale \(/);
});

test('a stall error that carries its own partial handoff is reported as a stop with that text', () => {
  const error = new AgentStallAbortError('agent task stale (100ms without stream/tool progress)');
  error.partialHandoff = 'carried';
  const session = { messages: [{ role: 'assistant', content: 'from session' }] };
  const partial = watchdogPartialHandoffFromError(error, session);
  assert.equal(partial, 'carried');
  const handoff = watchdogStoppedHandoff(error, partial);
  assert.match(handoff, /^\[Agent stopped by the progress watchdog: agent task stale \(100ms/);
  assert.ok(handoff.endsWith('\n\ncarried'));
});

test('stopped shell jobs are named stopped only when confirmed gone, the rest as still stopping', () => {
  const jobs = { stopped: ['a'], stopping: ['b', 'c'] };
  const error = new AgentStallAbortError('agent task stale (1ms)');
  noteStoppedShellJobsOnError(error, jobs);
  assert.match(
    error.message,
    /\[Stopped its background shell jobs: a\.\] \[Still stopping its background shell jobs: b, c\.\]$/
  );
  const only = new AgentStallAbortError('agent task stale (1ms)');
  noteStoppedShellJobsOnError(only, { stopped: [], stopping: ['b'] });
  assert.doesNotMatch(only.message, /Stopped its/);
  assert.match(only.message, /\[Still stopping its background shell jobs: b\.\]$/);
  assert.match(
    watchdogStoppedHandoff(error, 'p', jobs),
    /partial\.\]\n\[Stopped its background shell jobs: a\.\] \[Still/
  );
  assert.ok(!watchdogStoppedHandoff(error, 'p').includes('background shell jobs: ]'));
});

test('partial handoff collects only assistant text appended in the current turn', () => {
  const session = { messages: [{ role: 'assistant', content: 'previous turn' }] };
  const start = resolveHandoffMessageStartIndex(session);
  session.messages.push(
    { role: 'user', content: 'query' },
    { role: 'assistant', content: '  first  ' },
    { role: 'assistant', content: '.' },
    { role: 'tool', content: 'tool output' },
    {
      role: 'assistant',
      content: [
        null,
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'second' },
        { type: 'output_text', text: 'third' },
        { type: 'text', text: 42 },
      ],
    },
    { role: 'assistant', content: { text: 'not a content block array' } }
  );
  assert.equal(start, 1);
  assert.equal(partialHandoffTextFromSession(session, start), 'first\n\nsecond\nthird');
});

test('partial handoff falls back to visible providerReplay text when content is empty', () => {
  const replay = (provider, items) => ({ version: 1, provider, items });
  const session = {
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1' }],
        providerReplay: replay('anthropic', [
          { type: 'thinking', thinking: 'private', text: 'hidden-thinking' },
          { type: 'text', text: 'PARTIAL-REPORT-OK' },
          { type: 'tool_use', id: 't1', name: 'read', input: { text: 'tool-payload' } },
        ]),
      },
      {
        role: 'assistant',
        content: '',
        providerReplay: replay('openai-responses', [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden-reasoning' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'openai-visible' }] },
          { type: 'function_call', call_id: 'c1', arguments: '{"text":"tool-payload"}' },
        ]),
      },
      {
        role: 'assistant',
        content: '',
        providerReplay: replay('gemini', [
          { thought: true, text: 'hidden-thought' },
          { text: 'gemini-visible' },
          { functionCall: { name: 'read', args: {} } },
        ]),
      },
      {
        role: 'assistant',
        content: 'content wins',
        providerReplay: replay('anthropic', [{ type: 'text', text: 'replay loses' }]),
      },
    ],
  };
  assert.equal(
    partialHandoffTextFromSession(session),
    'PARTIAL-REPORT-OK\n\nopenai-visible\n\ngemini-visible\n\ncontent wins'
  );
});

test('watchdog handoff preserves supported stale-error messages and the turn boundary', () => {
  const session = {
    messages: [
      { role: 'assistant', content: 'old' },
      { role: 'assistant', content: '  current  ' },
    ],
  };
  for (const message of [
    'agent first transport stale (100ms)',
    'agent first semantic response stale (100ms)',
    'agent first response stale (100ms)',
    'agent task stale (100ms without stream/tool progress)',
  ]) {
    assert.equal(watchdogPartialHandoffFromError(new Error(message), session, 1), 'current');
  }
});

test('non-watchdog failures do not inspect or salvage the session', () => {
  const session = {
    get messages() {
      throw new Error('non-watchdog failures must not read the transcript');
    },
  };
  for (const error of [null, new Error('cancelled'), new Error('deadline'), { message: 42 }]) {
    assert.equal(watchdogPartialHandoffFromError(error, session), null);
  }
});

test('empty handoffs stay null and message offsets keep their normalization', () => {
  const error = new Error('agent task stale (100ms without progress)');
  for (const session of [
    null,
    { messages: null },
    { messages: [] },
    { messages: [{ role: 'assistant', content: '  .  ' }] },
    { messages: [{ role: 'assistant', content: '  ' }] },
  ]) {
    assert.equal(partialHandoffTextFromSession(session), null);
    assert.equal(watchdogPartialHandoffFromError(error, session), null);
  }
  const session = {
    messages: [
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
  };
  assert.equal(partialHandoffTextFromSession(session, -2), 'first\n\nsecond');
  assert.equal(watchdogPartialHandoffFromError(error, session, '1.9'), 'second');
  assert.equal(watchdogPartialHandoffFromError(error, session, 2), null);
});
