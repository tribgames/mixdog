import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { processToolBatch } from './tool-batch.mjs';
import { heartbeatTurnLimits } from './manager/ask-turn-loop-options.mjs';
import { HEARTBEAT_TURN_LIMITS, markHeartbeatSession } from '../../../shared/routine-trigger.mjs';

function agentSession(extra = {}) {
  return {
    id: 'agent-live-projection-test',
    owner: 'agent',
    agent: 'worker',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    ...extra,
  };
}

test('Agent dispatch preserves text deltas without requiring live projection', async () => {
  const session = agentSession();
  let providerSawTextDelta = false;
  const deltas = [];
  const provider = {
    async send(_messages, _model, _tools, sendOpts) {
      providerSawTextDelta = typeof sendOpts?.onTextDelta === 'function';
      sendOpts?.onTextDelta?.('secret-preamble');
      return { content: 'final', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const result = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: session.id,
    onTextDelta: (chunk) => deltas.push(chunk),
  });
  assert.equal(result.content, 'final');
  assert.equal(providerSawTextDelta, true);
  assert.deepEqual(deltas, ['secret-preamble']);
  assert.equal(Object.hasOwn(session, 'interactiveSessionSurface'), false);
  assert.equal(Object.hasOwn(session, 'liveProjection'), false);
});

test('explicit liveProjection permits provider onTextDelta without persisting a session flag', async () => {
  const session = agentSession();
  const deltas = [];
  let providerSawTextDelta = false;
  const provider = {
    async send(_messages, _model, _tools, sendOpts) {
      providerSawTextDelta = typeof sendOpts?.onTextDelta === 'function';
      sendOpts?.onTextDelta?.('live-chunk');
      return { content: 'final', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const result = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: session.id,
    liveProjection: true,
    onTextDelta: (chunk) => deltas.push(chunk),
  });
  assert.equal(result.content, 'final');
  assert.equal(providerSawTextDelta, true);
  assert.deepEqual(deltas, ['live-chunk']);
  assert.equal(session.interactiveSessionSurface, undefined);
  assert.equal(session.liveProjection, undefined);
});

test('live Agent tool-call turns keep preamble text and surface buffered assistant text', async () => {
  const session = agentSession();
  const assistantTexts = [];
  const committed = [];
  const toolResults = [];
  let sends = 0;
  const provider = {
    async send(_messages, _model, _tools, sendOpts) {
      sends += 1;
      if (sends === 1) {
        sendOpts?.onTextDelta?.('Now let me look');
        return {
          content: 'Now let me look',
          toolCalls: [{ id: 'c1', name: 'definitely_missing_live_proj_tool', arguments: {} }],
        };
      }
      return { content: 'final-answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const result = await agentLoop(
    provider,
    [{ role: 'user', content: 'inspect' }],
    'fake-model',
    [],
    null,
    process.cwd(),
    {
      session,
      sessionId: session.id,
      liveProjection: true,
      onAssistantText: (text) => assistantTexts.push(text),
      onAssistantMessageCommitted: (message) => committed.push(message),
      onToolResult: (message) => toolResults.push(message),
    }
  );
  assert.equal(result.content, 'final-answer');
  assert.equal(sends, 2);
  assert.deepEqual(assistantTexts, ['Now let me look']);
  assert.equal(committed[0]?.content, 'Now let me look');
  assert.equal(committed[0]?.toolCalls?.[0]?.name, 'definitely_missing_live_proj_tool');
  assert.ok(toolResults.length >= 1);
  assert.equal(toolResults[0]?.toolCallId, 'c1');
  assert.equal(session.interactiveSessionSurface, undefined);
});

test('Agent tool-call turns preserve emitted prose in history and buffered text', async () => {
  const session = agentSession();
  const assistantTexts = [];
  const committed = [];
  let sends = 0;
  const provider = {
    async send() {
      sends += 1;
      if (sends === 1) {
        return {
          content: 'Now let me look',
          toolCalls: [{ id: 'c1', name: 'definitely_missing_silent_proj_tool', arguments: {} }],
        };
      }
      return { content: 'final-answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const result = await agentLoop(
    provider,
    [{ role: 'user', content: 'inspect' }],
    'fake-model',
    [],
    null,
    process.cwd(),
    {
      session,
      sessionId: session.id,
      onAssistantText: (text) => assistantTexts.push(text),
      onAssistantMessageCommitted: (message) => committed.push(message),
    }
  );
  assert.equal(result.content, 'final-answer');
  assert.deepEqual(assistantTexts, ['Now let me look']);
  assert.equal(committed[0]?.content, 'Now let me look');
  assert.equal(committed[0]?.toolCalls?.[0]?.name, 'definitely_missing_silent_proj_tool');
});

test('successive Browser snapshots keep the already-sent provider prefix unchanged', async () => {
  const session = agentSession({ owner: 'cli', agent: 'lead' });
  const messages = [
    { role: 'user', content: 'browse' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'browser-old', name: 'browser', arguments: { action: 'snapshot' } }],
    },
    {
      role: 'tool',
      toolCallId: 'browser-old',
      content: 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s1\nold state',
    },
  ];
  const sent = [];
  let sends = 0;
  const provider = {
    async send(providerMessages) {
      sends += 1;
      sent.push(providerMessages);
      if (sends === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'browser-new', name: 'browser', arguments: { action: 'snapshot' } }],
        };
      }
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: session.id,
    onToolResult(message) {
      if (message.toolCallId !== 'browser-new') return;
      message.content = 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s2\nnew state';
    },
  });
  assert.equal(result.content, 'done');
  assert.equal(sends, 2);
  assert.equal(sent[0][2].content.includes('old state'), true);
  assert.equal(sent[1][2].content.includes('old state'), true);
});

/** A provider whose every answer is `reply(sendIndex)`; it records the tool
 *  choice and the last message each send carried. */
function scriptedProvider(reply) {
  const sends = [];
  return {
    sends,
    async send(providerMessages, _model, _tools, sendOpts) {
      sends.push({ toolChoice: sendOpts?.toolChoice, last: providerMessages.at(-1) });
      return reply(sends.length);
    },
  };
}
const calls = (send, count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `s${send}c${index}`,
    name: 'missing_capped_tool',
    arguments: {},
  }));
const capRefusals = (messages) => messages.filter((m) => m.role === 'tool' && /^\[turn-limit\]/.test(m.content));
const leadSession = (id) => agentSession({ id, owner: 'cli', agent: 'lead' });

test("a heartbeat turn's tool calls are capped: calls past the cap never run, then it must reply without tools", async (t) => {
  const id = 'sess_daemon_capped';
  markHeartbeatSession(id);
  t.after(() => markHeartbeatSession(id, true));
  const limits = heartbeatTurnLimits(id);
  assert.equal(limits.turnLimits.maxToolCalls, HEARTBEAT_TURN_LIMITS.maxToolCalls);
  assert.equal(limits.turnLimits.maxToolCalls, 8);
  assert.deepEqual(heartbeatTurnLimits('sess_daemon_other'), {}, 'any other session runs uncapped');
  // Three calls a round: 3 + 3 run, then 2 of the next 3 (the 9th never runs).
  const provider = scriptedProvider((send) =>
    send <= 3
      ? { content: '', toolCalls: calls(send, 3) }
      : { content: 'Two routines failed.', toolCalls: [], stopReason: 'end_turn' }
  );
  const messages = [{ role: 'user', content: 'heartbeat' }];
  const session = leadSession(id);
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: id,
    ...limits,
  });
  assert.equal(result.content, 'Two routines failed.');
  assert.equal(result.toolCallsTotal, 9);
  assert.deepEqual(
    capRefusals(messages).map((m) => m.toolCallId),
    ['s3c2']
  );
  assert.equal(messages.filter((m) => m.role === 'tool').length, 9, 'every call is answered');
  assert.deepEqual(
    provider.sends.map((s) => s.toolChoice),
    [undefined, undefined, undefined, 'none']
  );
  assert.match(JSON.stringify(provider.sends[3].last?.content), /This turn has reached its tool-call or time limit/);
});

test('a capped turn that still calls tools after it was told to reply ends with no reply', async () => {
  const provider = scriptedProvider((send) => ({
    content: send === 2 ? 'Let me check more.' : '',
    toolCalls: calls(send, 2),
  }));
  const messages = [{ role: 'user', content: 'heartbeat' }];
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: leadSession('sess_daemon_overrun'),
    sessionId: 'sess_daemon_overrun',
    turnLimits: { maxToolCalls: 2 },
  });
  assert.equal(provider.sends.length, 2, 'no request after the overrun');
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(
    capRefusals(messages).map((m) => m.toolCallId),
    ['s2c0', 's2c1']
  );
});

test('a batch that crosses the wrap-up time starts none of its later calls', async () => {
  const batchCalls = calls(1, 3);
  const ran = [];
  const results = [];
  const messages = [];
  await processToolBatch({
    calls: batchCalls,
    toolBatchId: 'batch-cross',
    pending: new Map(),
    messages,
    tools: [],
    cwd: process.cwd(),
    sessionId: 'sess_daemon_cross',
    sessionRef: { agent: 'lead' },
    signal: null,
    opts: {},
    iterations: 1,
    assistantTurnMsg: { role: 'assistant', content: '', toolCalls: batchCalls },
    epoch: { mutation: 0 },
    startEagerRun: () => {},
    crossTurnCalls: new Map(),
    crossTurnCap: 100,
    sessionAgent: null,
    pushToolResultMessage: (message) => results.push(message),
    throwIfAborted: () => {},
    repeatFailLimit: 3,
    dedupStubTotal: 0,
    editCount: 0,
    callsAllowed: 8,
    // The deadline passes while the first call runs.
    wrapUpAt: Date.now() + 30,
    executeToolFn: async (_name, _args, _cwd, _sessionId, _ref, meta) => {
      ran.push(meta?.toolCallId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return 'ok';
    },
  });
  assert.deepEqual(ran, ['s1c0'], 'only the call started before the deadline ran');
  const answered = [...results, ...messages].filter((m) => m?.role === 'tool');
  assert.deepEqual(
    capRefusals(answered).map((m) => m.toolCallId),
    ['s1c1', 's1c2'],
    'the calls after the deadline are answered unrun'
  );
});

test("past a capped turn's wrap-up time no call runs and the next request forbids tools", async () => {
  const provider = scriptedProvider((send) =>
    send === 1 ? { content: '', toolCalls: calls(1, 1) } : { content: 'Done.', toolCalls: [], stopReason: 'end_turn' }
  );
  const messages = [{ role: 'user', content: 'heartbeat' }];
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: leadSession('sess_daemon_late'),
    sessionId: 'sess_daemon_late',
    turnLimits: { maxToolCalls: 8, wrapUpAt: Date.now() - 1 },
  });
  assert.equal(result.content, 'Done.');
  assert.deepEqual(
    capRefusals(messages).map((m) => m.toolCallId),
    ['s1c0']
  );
  assert.deepEqual(
    provider.sends.map((s) => s.toolChoice),
    [undefined, 'none']
  );
});

test('an uncapped turn never limits its tool calls', async () => {
  const provider = scriptedProvider((send) =>
    send <= 4 ? { content: '', toolCalls: calls(send, 3) } : { content: 'ok', toolCalls: [], stopReason: 'end_turn' }
  );
  const messages = [{ role: 'user', content: 'go' }];
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: leadSession('sess_daemon_free'),
    sessionId: 'sess_daemon_free',
  });
  assert.equal(result.content, 'ok');
  assert.equal(result.toolCallsTotal, 12);
  assert.deepEqual(capRefusals(messages), []);
  assert.equal(
    provider.sends.some((s) => s.toolChoice === 'none'),
    false
  );
});
