// A compaction that leaves the conversation as it is (nothing to compact, no
// token reduction, a failed summary) must leave the provider request prefix as
// it was: the provider prefix guard (provider-prefix-guard.mjs) accepts a
// prefix change only across a registered compaction boundary, and a pass
// stamps stable message ids (message-ids.mjs) onto the live messages before it
// decides anything. That bookkeeping reaches no provider request, so the guard
// does not hash it, and the NEXT prompt — also one whose send landed while the
// pass was running — still passes. A compaction that does change the
// transcript keeps going through the boundary the guard accepts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-prefix-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { runPreSendCompactPass } = await import('./pre-send-compact.mjs');
const { projectProviderRequest } = await import('./loop/request-projection.mjs');
const { ProviderPrefixMutationError } = await import('./provider-prefix-guard.mjs');
const { everyMessageStamped, withoutStampedIds } = await import('./message-ids.test-support.mjs');
const { persistedAssistantTranscriptMetadata, persistedUserTranscriptMetadata } = await import(
  '../../../shared/transcript-metadata.mjs'
);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal',
  '- continue',
  '## Constraints & Preferences',
  '- (none)',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '### In Progress',
  '- (none)',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- (none)',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- (none)',
  '## Relevant Files',
  '- (none)',
].join('\n');

const userRow = (content) => ({
  role: 'user',
  content,
  meta: { transcript: persistedUserTranscriptMetadata({ at: 1 }) },
});
const assistantRow = (content) => ({
  role: 'assistant',
  content,
  meta: { transcript: persistedAssistantTranscriptMetadata({}, 1) },
});

// A new session after two prompts: the seeded system rows carry no meta; the
// prompts and replies carry their creation-time ids.
function sessionAfterTwoPrompts(tag, compaction = {}) {
  return {
    id: `compact-prefix-${process.pid}-${tag}`,
    provider: 'custom-fake',
    model: 'fake-1',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    tools: [],
    compaction,
    messages: [
      { role: 'system', content: 'base rules' },
      { role: 'system', content: 'stable context' },
      userRow('first prompt'),
      assistantRow('first reply'),
      userRow('second prompt'),
      assistantRow('second reply'),
    ],
  };
}

// The projection the loop sends, run through the guard exactly as the loop does.
function guardedSend(session, previous, extra = [], opts = {}) {
  return projectProviderRequest({
    messages: [...session.messages, ...extra],
    sendTools: [],
    opts,
    provider: { name: session.provider },
    sessionRef: session,
    sessionId: session.id,
    model: session.model,
    iteration: 1,
    prefixGuardState: previous,
    cacheBreakTraceKeys: new Set(),
  }).prefixGuardCandidate;
}

const manual = (session, provider) =>
  runSessionCompaction(session, { mode: 'manual', force: true, config: {}, provider, model: session.model });

const summaryProvider = (session) => ({
  name: session.provider,
  async send() {
    return { content: SUMMARY };
  },
});

const failingSummary = (session) => ({
  name: session.provider,
  async send() {
    throw new Error('summary unavailable');
  },
});

test('a manual compaction that finds nothing to compact leaves the prefix unchanged and the next prompt succeeds', async () => {
  const session = sessionAfterTwoPrompts('noop');
  const baseline = guardedSend(session, null);
  const before = structuredClone(session.messages);
  const result = await manual(session, summaryProvider(session));
  assert.equal(result.changed, false);
  // The conversation is untouched; the pass only stamped the ids it needs.
  assert.deepEqual(withoutStampedIds(session.messages), withoutStampedIds(before));
  assert.ok(everyMessageStamped(session.messages));
  assert.ok(guardedSend(session, baseline, [userRow('third prompt')]));
});

test('a manual compaction whose summary fails leaves the prefix unchanged and the next prompt succeeds', async () => {
  const session = sessionAfterTwoPrompts('failed', { conversationThresholdTokens: 1 });
  const baseline = guardedSend(session, null);
  const before = structuredClone(session.messages);
  const result = await manual(session, failingSummary(session));
  assert.match(result.error, /summary unavailable/);
  assert.deepEqual(withoutStampedIds(session.messages), withoutStampedIds(before));
  assert.ok(everyMessageStamped(session.messages));
  assert.ok(guardedSend(session, baseline, [userRow('third prompt')]));
});

for (const window of ['stage change', 'summary call']) {
  test(`a send that lands during a compaction (${window}) which then changes nothing is followed by sends the guard accepts`, async () => {
    const session = sessionAfterTwoPrompts(
      `mid-${window.replace(' ', '-')}`,
      window === 'summary call' ? { conversationThresholdTokens: 1 } : {}
    );
    const baseline = guardedSend(session, null);
    const midPrompt = userRow('prompt sent while compacting');
    let mid = null;
    // A request built from the live transcript the pass has already stamped.
    const sendWhileCompacting = () => {
      mid = guardedSend(session, baseline, [midPrompt]);
    };
    const result = await runSessionCompaction(session, {
      mode: 'manual',
      force: true,
      config: {},
      model: session.model,
      provider: {
        name: session.provider,
        async send() {
          if (window === 'summary call') sendWhileCompacting();
          throw new Error('summary unavailable');
        },
      },
      onStageChange: async (stage) => {
        if (stage === 'compacting' && window === 'stage change') sendWhileCompacting();
      },
    });
    assert.equal(result.changed, false);
    assert.ok(mid, 'a send landed while the compaction was running');
    assert.ok(everyMessageStamped(session.messages));
    const next = [midPrompt, assistantRow('its reply'), userRow('next prompt')];
    assert.ok(guardedSend(session, mid, next));
    assert.ok(guardedSend(session, baseline, next));
  });
}

test('the stable message id reaches no provider request builder', async () => {
  const marker = 'msg_MARKER_NEVER_SENT_';
  const plain = () => [
    { role: 'system', content: 'base rules' },
    { role: 'system', content: 'env context', cacheTier: 'env' },
    { role: 'user', content: 'first prompt' },
    {
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'file body' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
  ];
  const stamped = () =>
    plain().map((message, index) => ({
      ...message,
      meta: { transcript: { messageId: `${marker}${index}`, at: 5 } },
    }));
  const tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } }];
  const providers = '../providers';
  const [anthropic, compat, responsesInput, gemini, geminiBody, antigravity, responsesPayload, cursor] =
    await Promise.all([
      import(`${providers}/lib/anthropic-request-utils.mjs`),
      import(`${providers}/openai-compat-wire.mjs`),
      import(`${providers}/openai-responses-input.mjs`),
      import(`${providers}/gemini-schema.mjs`),
      import(`${providers}/gemini-request-body.mjs`),
      import(`${providers}/antigravity-request.mjs`),
      import(`${providers}/openai-responses-payload.mjs`),
      import(`${providers}/cursor-wire-request.mjs`),
    ]);
  const cursorHistory = (messages) =>
    messages.map((message) => {
      if (message.role === 'tool') return { ...message, tool_call_id: message.toolCallId };
      if (!message.toolCalls) return message;
      const tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      return { ...message, tool_calls };
    });
  const builders = {
    anthropic: (m) => anthropic.toAnthropicMessages(m, tools, 'anthropic'),
    openaiChat: (m) => compat.toOpenAIMessages(m, 'openai'),
    xaiResponses: (m) => compat.toXaiResponsesInput(m, null),
    responsesInput: (m) => responsesInput.convertMessagesToResponsesInput(m),
    responsesBody: (m) => responsesPayload.buildRequestBody(m, 'gpt-5', tools, {}),
    geminiContents: (m) => gemini.toGeminiContents(m, 'gemini-2.5-pro'),
    geminiRequest: (m) => geminiBody.buildGeminiRequest(m, 'gemini-2.5-pro', tools, {}),
    cursor: (m) => cursor.parseMessages(cursorHistory(m)),
    // Mints a random request id per call, so only the marker is compared.
    antigravity: (m) => antigravity.buildAntigravityRequest(m, 'gemini-3-pro', tools, {}, 'proj'),
  };
  for (const [name, build] of Object.entries(builders)) {
    const sent = JSON.stringify(build(stamped()));
    assert.ok(!sent.includes(marker), `${name} sends the stable message id`);
    if (name !== 'antigravity') assert.equal(sent, JSON.stringify(build(plain())), name);
  }
});

test('a compaction that changes the transcript is accepted by the guard only across its compaction boundary', async () => {
  const session = sessionAfterTwoPrompts('changed', { conversationThresholdTokens: 1 });
  const baseline = guardedSend(session, null);
  const result = await manual(session, summaryProvider(session));
  assert.equal(result.changed, true);
  assert.equal(session.pendingCacheBreakIntent, 'manual_compaction');
  assert.throws(() => guardedSend(session, baseline, [userRow('third prompt')]), ProviderPrefixMutationError);
  assert.ok(
    guardedSend(session, baseline, [userRow('third prompt')], { cacheBreakIntent: session.pendingCacheBreakIntent })
  );
});

test('a pre-send compaction pass an agent session retries quietly leaves the prefix unchanged', async () => {
  const session = {
    ...sessionAfterTwoPrompts('pre-send'),
    sessionMode: 'agent',
    compaction: { auto: true, conversationThresholdTokens: 1 },
  };
  const baseline = guardedSend(session, null);
  const before = structuredClone(session.messages);
  // A reactive overflow retry compacts without needing a token reduction; the
  // failed summary is retried on the next send and this send goes on.
  const result = await runPreSendCompactPass({
    compactionConfig: {},
    provider: failingSummary(session),
    messages: session.messages,
    model: session.model,
    requestTools: [],
    sessionRef: session,
    sessionId: session.id,
    cwd: process.cwd(),
    opts: {},
    signal: null,
    iterations: 1,
    lastUsage: null,
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: true,
    loopUsageMetricsTurnId: () => 'test-turn',
    loopUsageMetricsEpoch: () => 0,
  });
  assert.equal(result.compactChanged, false);
  assert.deepEqual(withoutStampedIds(session.messages), withoutStampedIds(before));
  assert.ok(everyMessageStamped(session.messages));
  assert.ok(guardedSend(session, baseline, [userRow('third prompt')]));
});
