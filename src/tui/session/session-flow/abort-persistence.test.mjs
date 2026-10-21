import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionFlow } from '../session-flow.mjs';
import { createRunTurn } from '../turn.mjs';
import { createAbortAction } from '../session-api/intake/abort.mjs';
import { USER_CANCEL_KEEP_PROMPT_REASON } from '../../../runtime/agent/orchestrator/session/manager/turn-interruption.mjs';
import { flushTuiSteeringPersist, readTuiSteeringPersist } from '../tui-steering-persist.mjs';

const cancelled = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const prompt = { id: 'sub-stopped', content: 'review the migration' };

// Only the provider request is controlled. Intake, turn ownership, abort and
// restart recovery all use their real implementations and the real disk spool.
function boot(t, sessionId, { acceptsAbort = true, completes = false } = {}) {
  const state = {
    busy: true,
    commandBusy: false,
    queued: [],
    items: [],
    promptHistoryList: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  const flags = { leadTurnEpoch: 0 };
  const pending = [];
  const requests = [];
  const waiting = new Map();
  const abortReasons = [];
  let active;
  let draining;
  let sequence = 0;
  const runtime = {
    id: sessionId,
    session: { id: sessionId, messages: [] },
    toolMode: 'auto',
    async ask(content, options) {
      const result = Promise.withResolvers();
      const request = { id: options.id, content, options, ...result };
      const index = requests.push(request) - 1;
      active = request;
      waiting.get(index)?.resolve(request);
      if (completes) result.resolve({ result: { content: 'done' }, session: runtime.session });
      try {
        return await result.promise;
      } finally {
        active = null;
      }
    },
    abort(reason) {
      abortReasons.push(reason);
      if (!acceptsAbort) return false;
      active.reject(cancelled());
      return true;
    },
  };
  const bag = {
    runtime,
    flags,
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `${sessionId}-item-${++sequence}`,
    appendItems: (items, extra) => Object.assign(state, { items: [...state.items, ...items] }, extra),
    pushItem: (item) => state.items.push(item),
    pushUserOrSyntheticItem: (text, id, kind, extra) => state.items.push({ text, id, kind, ...extra }),
    patchItem: (id, patch) => Object.assign(state.items.find((item) => item.id === id) || {}, patch),
    replaceItems: (items) => items,
    tuiDebug() {},
    pushNotice() {},
    syncContextStats() {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
    denyAllToolApprovals() {},
    clearActiveToolSummary() {},
    flushDeferredExecutionPendingResumeKick() {},
    flushToolResults() {},
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  const { abort } = createAbortAction(bag);
  const stopProcess = async () => {
    flags.disposed = true;
    flags.admission = 'closing';
    clearTimeout(flags.blockedDrainRetryTimer);
    active?.reject(cancelled());
    await draining;
    await flushTuiSteeringPersist();
  };
  t.after(stopProcess);
  return {
    state,
    pending,
    requests,
    abortReasons,
    flow: bag,
    abort,
    stopProcess,
    start() {
      state.busy = false;
      draining = bag.drain();
      return draining;
    },
    nextRequest(index = 0) {
      if (requests[index]) return Promise.resolve(requests[index]);
      if (!waiting.has(index)) waiting.set(index, Promise.withResolvers());
      return waiting.get(index).promise;
    },
  };
}

async function enqueue(f, entry = prompt, options = {}) {
  assert.equal(await f.flow.enqueue(entry.content, { id: entry.id, awaitPersistence: true, ...options }), true);
}

const submitted = (requests) => requests.map(({ id, content }) => ({ id, content }));
const durable = async (sid) =>
  (await readTuiSteeringPersist(sid)).map(({ submissionId, content }) => ({ id: submissionId, content }));

for (const restorePrompt of [true, false]) {
  test(`accepted user Stop consumes its queued recovery row (restorePrompt=${restorePrompt})`, async (t) => {
    const sid = `stop-queued-${restorePrompt}`;
    const f = boot(t, sid);
    let committed = 0;
    await enqueue(f, prompt, { onCommitted: () => committed++ });
    assert.deepEqual(await durable(sid), [prompt]);
    const drained = f.start();
    await f.nextRequest();
    const result = f.abort({ restorePrompt });
    assert.equal(result.aborted, true);
    assert.equal(result.restoreText, restorePrompt ? prompt.content : '');
    await drained;
    await f.stopProcess();

    const restored = boot(t, sid, { completes: true });
    await restored.flow.restoreLeadSteeringFromDisk();
    const remaining = await durable(sid);
    await restored.start();
    assert.deepEqual(submitted([...f.requests, ...restored.requests]), [prompt], 'Stop never submits it again');
    assert.deepEqual(remaining, [], 'Stop removes the durable row before restart');
    assert.equal(committed, 0, 'cancellation never invokes the successful-commit callback');
  });
}

for (const [name, acceptsAbort, options] of [
  ['a rejected Stop', false, { restorePrompt: false }],
  ['the progress watchdog', true, { reason: 'agent-watchdog', restorePrompt: false }],
]) {
  test(`${name} preserves the uncommitted queued input for recovery`, async (t) => {
    const sid = acceptsAbort ? 'stop-queued-watchdog' : 'stop-queued-rejected';
    const f = boot(t, sid, { acceptsAbort });
    await enqueue(f);
    const drained = f.start();
    await f.nextRequest();
    assert.equal(f.abort(options).aborted, acceptsAbort);
    assert.deepEqual(await durable(sid), [prompt]);
    // An unsuccessful Stop can still be followed by process loss.
    await f.stopProcess();
    await drained;
    const restored = boot(t, sid, { completes: true });
    await restored.flow.restoreLeadSteeringFromDisk();
    assert.deepEqual(
      restored.pending.map(({ id, content }) => ({ id, content })),
      [prompt]
    );
    await restored.start();
    assert.deepEqual(submitted(restored.requests), [prompt]);
    assert.deepEqual(await durable(sid), []);
  });
}

test('normal commit still releases the queued recovery row exactly once', async (t) => {
  const sid = 'stop-queued-commit';
  const f = boot(t, sid, { completes: true });
  let committed = 0;
  await enqueue(f, prompt, { onCommitted: () => committed++ });
  await f.start();
  assert.equal(committed, 1);
  assert.deepEqual(submitted(f.requests), [prompt]);
  assert.deepEqual(await durable(sid), []);
  await f.stopProcess();
  const restored = boot(t, sid, { completes: true });
  await restored.flow.restoreLeadSteeringFromDisk();
  await restored.start();
  assert.deepEqual(restored.requests, []);
});

test('Send now stops only the active batch and retains the other queued submissions', async (t) => {
  const sid = 'stop-queued-send-now';
  const f = boot(t, sid);
  await enqueue(f);
  const drained = f.start();
  await f.nextRequest();
  const later = { id: 'sub-other', content: 'check the release notes' };
  const now = { id: 'sub-send-now', content: 'fix the migration first' };
  await enqueue(f, later);
  await enqueue(f, now);
  assert.equal(f.flow.prioritizeQueued(now.id).count, 1);
  assert.equal(f.abort({ restorePrompt: false }).aborted, true);
  assert.deepEqual(f.abortReasons, ['interrupt'], 'steering keeps its existing runtime interrupt reason');
  const urgent = await f.nextRequest(1);
  assert.deepEqual({ id: urgent.id, content: urgent.content }, now);
  assert.deepEqual(await durable(sid), [later, now], 'only the active batch was consumed');
  urgent.resolve({ result: { content: 'done' }, session: f.flow.runtime.session });
  const remaining = await f.nextRequest(2);
  assert.deepEqual({ id: remaining.id, content: remaining.content }, later);
  remaining.resolve({ result: { content: 'done' }, session: f.flow.runtime.session });
  await drained;
  assert.deepEqual(submitted(f.requests), [prompt, now, later]);
  assert.deepEqual(await durable(sid), []);
  await f.stopProcess();
  const restored = boot(t, sid, { completes: true });
  await restored.flow.restoreLeadSteeringFromDisk();
  await restored.start();
  assert.deepEqual(restored.requests, []);
});

// The kept prompt of a Stop that does not hand it back (desktop Stop button,
// TUI Esc) stays on screen with its cancelled row, and the next prompt lands
// after it: [prompt, cancelled, next prompt].
test('a prompt-keeping Stop leaves the prompt and its cancelled row, then the next prompt follows', async (t) => {
  const f = boot(t, 'stop-keeps-prompt-live');
  await enqueue(f);
  const drained = f.start();
  await f.nextRequest();
  const result = f.abort({ restorePrompt: false });
  assert.equal(result.aborted, true);
  assert.equal(result.restoreText, '');
  assert.deepEqual(f.abortReasons, [USER_CANCEL_KEEP_PROMPT_REASON]);
  await drained;
  const next = { id: 'sub-next', content: 'and now the real question' };
  await enqueue(f, next);
  const second = await f.nextRequest(1);
  second.resolve({ result: { content: 'done' }, session: f.flow.runtime.session });
  await f.flow.drain();
  const rows = f.state.items.filter(
    (item) => item.kind === 'user' || (item.kind === 'turndone' && item.status === 'cancelled')
  );
  assert.deepEqual(
    rows.map((item) => (item.kind === 'user' ? item.text : `turndone:${item.status}`)),
    [prompt.content, 'turndone:cancelled', next.content]
  );
});
