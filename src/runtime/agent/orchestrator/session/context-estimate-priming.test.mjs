// Sliced priming of the per-message meters and transcript signatures must
// leave every later value exactly as an unprimed computation produces it.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextMessagesShapeSignature,
  contextMessagesSignature,
  estimateMessagesTokens,
  primeContextEstimates,
  summarizeContextMessages,
} from './context-utils.mjs';
import { createContextStatus } from '../../../../session-runtime/context-status.mjs';
import { createResumeAction } from '../../../../tui/session/session-api/lifecycle/resume.mjs';

function transcript(count, bodyChars = 200) {
  const messages = [{ role: 'system', content: '# Rules\n- keep going' }];
  for (let index = 0; messages.length < count; index += 1) {
    const id = `call-${index}`;
    messages.push(
      { role: 'user', content: `request ${index} 세션 ${'x'.repeat(bodyChars)}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'read', arguments: { path: `f-${index}` } }],
        providerReplay: { items: [{ type: 'thinking', thinking: `think ${index}`, signature: 'S'.repeat(80) }] },
      },
      { role: 'tool', toolCallId: id, content: `result ${index}\n${'line\n'.repeat(bodyChars / 5)}` }
    );
  }
  return messages.slice(0, count);
}

const COUNTS = [0, 1, 63, 64, 65, 100, 128, 129, 150];

test('primed estimates and signatures equal unprimed ones', async () => {
  const source = transcript(150);
  const primed = structuredClone(source);
  await primeContextEstimates(primed, {
    provider: 'anthropic-oauth',
    model: 'fake-model',
    contextPressureBaselineProvider: 'anthropic-oauth',
    contextPressureBaselineModel: 'fake-model',
    contextPressureBaselineTokens: 12_000,
    contextPressureBaselinePrefixSignature: 'stored-exact-that-does-not-match',
    contextPressureBaselineShapeSignature: 'stored-shape',
    contextPressureBaselineMessageCount: 100,
  });
  assert.equal(estimateMessagesTokens(primed), estimateMessagesTokens(structuredClone(source)));
  assert.deepEqual(summarizeContextMessages(primed), summarizeContextMessages(structuredClone(source)));
  for (const count of COUNTS) {
    assert.equal(contextMessagesSignature(primed, count), contextMessagesSignature(structuredClone(source), count));
    assert.equal(
      contextMessagesShapeSignature(primed, count),
      contextMessagesShapeSignature(structuredClone(source), count)
    );
  }
});

test('a transcript edited while priming still signs as its current content', async () => {
  const source = transcript(3_000, 2_000);
  const primed = structuredClone(source);
  const priming = primeContextEstimates(primed, {
    contextPressureBaselineTokens: 12_000,
    contextPressureBaselinePrefixSignature: 'stored',
    contextPressureBaselineShapeSignature: 'stored-shape',
    contextPressureBaselineMessageCount: 2_000,
    contextPressureBaselineProvider: null,
    contextPressureBaselineModel: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  primed[5] = { role: 'user', content: 'replaced while priming' };
  primed.push({ role: 'user', content: 'appended while priming' });
  await priming;
  const reference = structuredClone(primed);
  for (const count of [10, 64, 1_500, primed.length]) {
    assert.equal(contextMessagesSignature(primed, count), contextMessagesSignature(reference, count));
  }
  assert.equal(estimateMessagesTokens(primed), estimateMessagesTokens(reference));
});

test('resume meters the loaded transcript in slices before the context sync', async () => {
  const session = {
    id: 'resume-priming',
    provider: 'anthropic-oauth',
    model: 'fake-model',
    contextWindow: 1_000_000,
    messages: transcript(3_000, 2_000),
  };
  const route = { provider: session.provider, model: session.model, contextWindow: session.contextWindow };
  const statusFor = (target) =>
    createContextStatus({
      getSession: () => target,
      getRoute: () => route,
      getCurrentCwd: () => process.cwd(),
      getMode: () => 'full',
    }).contextStatus();
  const unprimed = statusFor(structuredClone(session));

  let state = { commandBusy: false, stats: {} };
  let immediateRan = false;
  let yieldedBeforeSync = false;
  let resumed = null;
  const action = createResumeAction(
    {
      runtime: { session, resume: async () => ({ id: session.id, messages: session.messages }) },
      flags: {},
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
      flushEmitImmediate() {},
      replaceItems: (items) => items,
      clearToastTimers() {},
      routeState: () => ({}),
      restoreLeadSteeringFromDisk: async () => {},
      resetStatsAndSyncContext: () => {
        yieldedBeforeSync = immediateRan;
        resumed = statusFor(session);
      },
    },
    { restoreTranscriptItems: () => [] }
  );
  setImmediate(() => {
    immediateRan = true;
  });
  assert.equal(await action.resume(session.id), true);
  // Unprimed, the sync ran within the resume's microtasks, before any
  // event-loop turn; metering this transcript takes longer than one slice.
  assert.equal(yieldedBeforeSync, true, 'the event loop ran before the context sync');
  const { updatedAt: _a, ...left } = resumed;
  const { updatedAt: _b, ...right } = unprimed;
  assert.deepEqual(left, right);
});
