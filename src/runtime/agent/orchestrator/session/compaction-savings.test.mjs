import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateMessagesTokens } from './context-utils.mjs';
import { freshContextCompactMessages, SUMMARY_OUTPUT_TOKENS } from './compact.mjs';
import { previewFreshContextCompaction, runFreshContextCompact } from './loop/fresh-context.mjs';
import { resolveWorkerCompactPolicy, compactTargetBudget } from './loop/compact-policy.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { createSessionOps } from '../../../../session-runtime/turn/session-ops.mjs';

function fixture() {
  return {
    id: 'compact-savings',
    owner: 'agent',
    provider: 'savings-test',
    model: 'savings-test',
    contextWindow: 40_000,
    compaction: {},
    lastProviderSendAt: Date.now() - 6 * 60_000,
    messages: [
      { role: 'system', content: 'Preserve instructions.' },
      { role: 'user', content: 'Continue the approved task.' },
      { role: 'assistant', content: 'Working on the task.' },
    ],
  };
}

function previewInput(session, extra = {}) {
  const compactPolicy = resolveWorkerCompactPolicy(session, []);
  return {
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages,
    compactPolicy,
    compactBudgetTokens: compactTargetBudget(compactPolicy),
    ...extra,
  };
}

function isolatedData(t) {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-compact-savings-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function addLargeToolResult(session) {
  session.messages.push(
    { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'read-1', content: 'Original recoverable output.\n'.repeat(4_000) }
  );
}

for (const activeTurn of [false, true]) {
  test(`preview rejects equal or larger transcripts including continuation (activeTurn=${activeTurn})`, () => {
    const session = fixture();
    const before = structuredClone(session);
    const input = previewInput(session, { activeTurn });
    const candidate = freshContextCompactMessages(session.messages, input.compactBudgetTokens, {
      force: true,
      contextWindow: session.contextWindow,
      maxBudgetTokens: session.contextWindow,
      reserveTokens: input.compactPolicy.reserveTokens,
      sessionId: session.id,
      activeTurn,
    });
    const prediction = previewFreshContextCompaction(input);
    assert.equal(prediction.beforeTokens, estimateMessagesTokens(session.messages));
    assert.equal(prediction.afterTokens, estimateMessagesTokens(candidate.messages));
    assert.ok(prediction.afterTokens >= prediction.beforeTokens);
    assert.equal(prediction.reducesTokens, false);
    assert.deepEqual(session, before);
  });
}

test('preview uses exact archive references without writing artifacts, and the real pass still archives', async (t) => {
  const root = isolatedData(t);
  const session = fixture();
  addLargeToolResult(session);
  const before = structuredClone(session);
  const input = previewInput(session, { activeTurn: true });
  const prediction = previewFreshContextCompaction(input);
  assert.equal(prediction.reducesTokens, true);
  assert.equal(existsSync(join(root, 'tool-results')), false);
  assert.deepEqual(session, before);
  const result = await runFreshContextCompact({ ...input, config: {}, requireReduction: true });
  assert.equal(prediction.afterTokens, estimateMessagesTokens(result.messages));
  const recovery = result.messages.find((message) => message.meta?.source === 'compact-execution-recovery');
  const artifactPath = recovery.content.match(/available at (.+?) \(sha256:/)[1];
  assert.equal(existsSync(artifactPath), true);
});

test('summary prediction includes its envelope and output ceiling, not an assumed compression ratio', () => {
  const session = fixture();
  session.messages.splice(1, 0, { role: 'assistant', content: 'Older conversation facts. '.repeat(4_000) });
  const input = previewInput(session);
  const envelope = freshContextCompactMessages(session.messages, input.compactBudgetTokens, {
    force: true,
    contextWindow: session.contextWindow,
    maxBudgetTokens: session.contextWindow,
    reserveTokens: input.compactPolicy.reserveTokens,
    sessionId: session.id,
    preview: true,
    previewSummary: true,
  });
  const prediction = previewFreshContextCompaction(input);
  assert.equal(prediction.summaryTriggered, true);
  assert.equal(prediction.afterTokens, estimateMessagesTokens(envelope.messages) + SUMMARY_OUTPUT_TOKENS);
  assert.equal(prediction.reducesTokens, true);

  const short = fixture();
  short.compaction.conversationThresholdTokens = 1;
  const shortPrediction = previewFreshContextCompaction(previewInput(short));
  assert.equal(shortPrediction.summaryTriggered, true);
  assert.equal(shortPrediction.reducesTokens, false);
});

for (const trigger of ['cache', 'threshold']) {
  test(`${trigger} trigger without savings leaves provider state, hooks and completion events untouched`, async () => {
    const session = fixture();
    if (trigger === 'threshold') session.autoCompactTokenLimit = 1;
    session.providerState = { previousResponse: 'keep' };
    const messages = session.messages;
    const before = structuredClone(messages);
    const stages = [];
    const events = [];
    let hooks = 0;
    const result = await runPreSendCompactPass({
      ...previewInput(session),
      requestTools: [],
      iterations: 7,
      providerState: session.providerState,
      opts: {
        cacheStrategy: { messages: trigger === 'cache' ? '5m' : '1h' },
        preCompactHook: async () => hooks++,
        postCompactHook: async () => hooks++,
        onStageChange: (stage) => stages.push(stage),
        onCompact: (event) => events.push(event),
      },
    });
    assert.equal(result.compactChanged, false);
    assert.equal(result.providerStateCleared, false);
    assert.equal(result.iterations, 7);
    assert.equal(result.providerState, session.providerState);
    assert.equal(session.messages, messages);
    assert.deepEqual(messages, before);
    assert.equal(session.pendingGoalReminder, undefined);
    assert.equal(hooks, 0);
    assert.deepEqual(stages, []);
    assert.deepEqual(events, []);
  });
}

test('repeated cache expiry skips an already compacted transcript until new reducible output arrives', async (t) => {
  isolatedData(t);
  const session = fixture();
  addLargeToolResult(session);
  const state = {
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages,
    requestTools: [],
    opts: { cacheStrategy: { messages: '5m' } },
  };
  assert.equal((await runPreSendCompactPass(state)).compactChanged, true);
  const compacted = structuredClone(session.messages);
  assert.equal((await runPreSendCompactPass(state)).compactChanged, false);
  assert.deepEqual(session.messages, compacted);
  session.messages.push(
    { role: 'assistant', content: '', toolCalls: [{ id: 'read-2', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'read-2', content: 'New recoverable output.\n'.repeat(4_000) }
  );
  assert.equal((await runPreSendCompactPass(state)).compactChanged, true);
});

test('reactive context overflow still runs when the token prediction has no savings', async () => {
  const session = fixture();
  assert.equal(previewFreshContextCompaction(previewInput(session, { activeTurn: true })).reducesTokens, false);
  let hooks = 0;
  const result = await runPreSendCompactPass({
    ...previewInput(session),
    requestTools: [],
    reactiveOverflowRetryPending: true,
    opts: { postCompactHook: async () => hooks++ },
  });
  assert.equal(hooks, 1);
  assert.equal(result.reactiveOverflowRetryPending, false);
});

for (const options of [{ mode: 'auto', force: true }, { mode: 'manual', requireReduction: true }]) {
  test(`automatic manager path skips without mutating context (${JSON.stringify(options)})`, async () => {
    const session = fixture();
    session.providerState = { previousResponse: 'keep' };
    session.lastContextTokens = 20_000;
    session.lastContextTokensUpdatedAt = 123;
    const before = structuredClone(session);
    let stages = 0;
    const result = await runSessionCompaction(session, {
      ...options,
      config: {},
      onStageChange: () => stages++,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.changed, false);
    assert.equal(result.beforeTokens, result.afterTokens);
    assert.equal(stages, 0);
    assert.deepEqual(session.messages, before.messages);
    assert.deepEqual(session.compaction, before.compaction);
    assert.deepEqual(session.providerState, before.providerState);
    assert.equal(session.lastContextTokens, before.lastContextTokens);
    assert.equal(session.lastContextTokensUpdatedAt, before.lastContextTokensUpdatedAt);
  });
}

for (const settle of ['success', 'error']) {
  test(`compact settling after a session switch (${settle}) leaves the active session untouched`, async () => {
    const old = fixture();
    const other = { ...fixture(), id: 'other-session' };
    let active = old;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const touched = [];
    old.postCompactHook = async () => {};
    const api = createSessionOps({
      getSession: () => active,
      getActiveTurnCount: () => 0,
      setSession: (s) => touched.push(['set', s.id]),
      invalidateContextStatusCache: () => touched.push(['invalidate']),
      agentTool: { recoverWorkers: () => touched.push(['recover']) },
      mgr: {
        async compactSessionMessages() {
          await gate;
          return settle === 'success' ? { changed: true } : { changed: false, error: 'boom' };
        },
        getSession: () => old,
      },
    });
    const pending = api.compact({ requireReduction: true, recoverAgent: true });
    active = other;
    release();
    const result = await pending;
    assert.equal(result.changed, settle === 'success');
    assert.deepEqual(touched, []);
    assert.equal(other.pendingGoalReminder, undefined);
    assert.equal(old.pendingGoalReminder, undefined);
  });
}

test('compact on the still-active session rebinds and invalidates', async () => {
  const session = fixture();
  const replaced = { ...session };
  const touched = [];
  const api = createSessionOps({
    getSession: () => session,
    getActiveTurnCount: () => 0,
    setSession: (s) => touched.push(['set', s]),
    invalidateContextStatusCache: () => touched.push(['invalidate']),
    mgr: { async compactSessionMessages() { return { changed: true }; }, getSession: () => replaced },
  });
  assert.equal((await api.compact({ requireReduction: true })).changed, true);
  assert.deepEqual(touched, [['set', replaced], ['invalidate']]);
});

test('auto-clear session API threads the savings gate without hooks or reminder side effects on skip', async () => {
  const session = fixture();
  let invalidations = 0;
  session.preCompactHook = async () => assert.fail('skipped pre-hook');
  session.postCompactHook = async () => assert.fail('skipped post-hook');
  const api = createSessionOps({
    getSession: () => session,
    getActiveTurnCount: () => 0,
    setSession: () => assert.fail('skipped session replacement'),
    invalidateContextStatusCache: () => invalidations++,
    mgr: {
      async compactSessionMessages(id, options) {
        assert.equal(id, session.id);
        assert.equal(options.requireReduction, true);
        return runSessionCompaction(session, { ...options, mode: 'manual', config: {} });
      },
    },
  });
  const result = await api.compact({ requireReduction: true });
  assert.equal(result.skipped, true);
  assert.equal(invalidations, 0);
  assert.equal(session.pendingGoalReminder, undefined);
});
