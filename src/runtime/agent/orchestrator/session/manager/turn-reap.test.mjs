import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';

// A turn abandoned by a timeout or stall stops the background shell work that
// turn started (a job promoted during it, the survivors it left) and nothing
// else: not an earlier turn's jobs, not a user cancel's, not a newer turn's.
const root = makeTempDirSync('turn-reap');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { abortSessionTurn } = await import('./session-close.mjs');
const { _getRuntimeEntry } = await import('./runtime-liveness.mjs');
const { reapTurnShellJobs, takeStoppedShellJobs, isTurnTimeoutAbort, turnEndedByTimeout } = await import(
  './turn-reap.mjs'
);
const { SessionClosedError } = await import('./session-errors.mjs');
const { streamStalledError, providerTimeoutError } = await import('../../stall-policy.mjs');
const { deleteSession } = await import('../store.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { registerBackgroundTask, cancelBackgroundTasks } = await import('../../../../shared/background-tasks.mjs');
const { AgentStallAbortError, watchdogStoppedHandoff } = await import(
  '../../agent-runtime/agent-progress-watchdog.mjs'
);
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function shellJob(sessionId, taskId, startedAtMs, stopped) {
  return registerBackgroundTask({
    taskId,
    startedAtMs,
    surface: 'shell',
    operation: 'shell',
    label: taskId,
    input: { command: taskId, cwd: root },
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
    resultType: 'shell_task_result',
    cancel: () => stopped.push(taskId),
  });
}

let seq = 0;
const uniqueId = (name) => {
  seq += 1;
  return `${name}_${process.pid}_${seq}`;
};

let liveSessionId;
const currentSessionId = () => liveSessionId;
const toolTurn = async () => ({
  content: 'ok',
  toolCalls: [{ id: 'call_x', name: 'read', arguments: { path: 'x' } }],
  stopReason: 'tool_use',
});

async function withTurns(t, run, send = toolTurn) {
  const providerName = 'turn-reap-test';
  let session;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    send,
  };
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    session = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    liveSessionId = session.id;
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    await run(session);
  });
}

// One turn whose tool never returns: `inTool` runs inside it (jobs the turn
// starts) and `abort` ends it (and may register what the dying commands left).
function stuckTurn(session, { inTool, abort, signal }) {
  const ask = askSession(session.id, 'run it', null, null, null, null, {
    ...(signal ? { signal } : {}),
    beforeToolExecution: () => {
      inTool();
      setImmediate(abort);
      return new Promise(() => {});
    },
  });
  return assert.rejects(ask);
}

for (const [name, abortWith] of [
  ['the canonical watchdog abort', (session) => abortSessionTurn(session.id, 'agent-watchdog')],
  ['the in-process watchdog abort', (_session, ac) => ac.abort(new AgentStallAbortError('agent task stale (1ms)'))],
]) {
  test(`${name} stops what the turn started and its survivors, keeping earlier turns' jobs`, async (t) => {
    await withTurns(t, async (session) => {
      const stopped = [];
      const [earlier, promoted, survivor] = ['earlier', 'promoted', 'survivor'].map(uniqueId);
      const ac = new AbortController();
      await stuckTurn(session, {
        signal: ac.signal,
        inTool: () => {
          shellJob(session.id, earlier, Date.now() - 60_000, stopped);
          shellJob(session.id, promoted, Date.now(), stopped);
        },
        abort: () => {
          abortWith(session, ac);
          shellJob(session.id, survivor, Date.now(), stopped);
        },
      });
      assert.deepEqual(stopped.sort(), [promoted, survivor].sort());
      const handoff = watchdogStoppedHandoff(
        new Error('agent task stale (1ms)'),
        'partial',
        takeStoppedShellJobs(session.id)
      );
      assert.match(handoff, new RegExp(`Stopped its background shell jobs: .*${promoted}`));
      assert.match(handoff, new RegExp(survivor));
      assert.doesNotMatch(handoff, new RegExp(earlier));
      cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
    });
  });
}

for (const reason of ['user-cancel', 'interrupt']) {
  test(`${reason} stops no background shell job`, async (t) => {
    await withTurns(t, async (session) => {
      const stopped = [];
      const [promoted, survivor] = ['promoted', 'survivor'].map(uniqueId);
      await stuckTurn(session, {
        inTool: () => shellJob(session.id, promoted, Date.now(), stopped),
        abort: () => {
          abortSessionTurn(session.id, reason);
          shellJob(session.id, survivor, Date.now(), stopped);
        },
      });
      assert.deepEqual(stopped, []);
      assert.deepEqual(takeStoppedShellJobs(session.id), []);
      cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
    });
  });
}

test("a reap that runs after a newer turn took the session leaves that turn's job alone", async (t) => {
  await withTurns(t, async (session) => {
    const stopped = [];
    const [first, newer] = ['first', 'newer'].map(uniqueId);
    let firstTurnEntry;
    await stuckTurn(session, {
      inTool: () => {
        firstTurnEntry = _getRuntimeEntry(session.id);
        shellJob(session.id, first, Date.now(), stopped);
      },
      abort: () => abortSessionTurn(session.id, 'agent-watchdog'),
    });
    assert.deepEqual(stopped, [first]);
    stopped.length = 0;
    await stuckTurn(session, {
      inTool: () => {
        shellJob(session.id, newer, Date.now(), stopped);
        reapTurnShellJobs(session.id, firstTurnEntry);
      },
      abort: () => abortSessionTurn(session.id, 'user-cancel'),
    });
    assert.deepEqual(stopped, []);
    cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
  });
});

for (const [name, makeError] of [
  ['StreamStalledError', () => streamStalledError('test', 1, { emittedToolCall: true })],
  ['ProviderTimeoutError', () => Object.assign(providerTimeoutError('test', 1), { unsafeToRetry: true })],
]) {
  test(`a terminal ${name} that ends the turn stops what the turn started, not earlier jobs`, async (t) => {
    const stopped = [];
    const [earlier, started] = ['earlier', 'started'].map(uniqueId);
    await withTurns(
      t,
      async (session) => {
        await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
        assert.deepEqual(stopped, [started]);
        assert.deepEqual(takeStoppedShellJobs(session.id), [started]);
        cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
      },
      async () => {
        shellJob(currentSessionId(), earlier, Date.now() - 60_000, stopped);
        shellJob(currentSessionId(), started, Date.now(), stopped);
        throw makeError();
      }
    );
  });
}

test('a stall the turn retries and recovers from stops no background shell job', async (t) => {
  const stopped = [];
  let calls = 0;
  await withTurns(
    t,
    async (session) => {
      await askSession(session.id, 'go', null, null, null, null, {});
      assert.ok(calls >= 2, 'the stall was retried');
      assert.deepEqual(stopped, []);
      cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
    },
    async () => {
      calls += 1;
      if (calls === 1) {
        shellJob(currentSessionId(), uniqueId('during'), Date.now(), stopped);
        throw streamStalledError('test', 1);
      }
      return { content: 'recovered', usage: { inputTokens: 1, outputTokens: 1 } };
    }
  );
});

test('an explicit cancel, interrupt or close wins over a timeout cause; a watchdog abort still reaps', () => {
  const timeout = providerTimeoutError('test', 1);
  for (const reason of [
    'user-cancel',
    'user-cancel-keep-prompt',
    'cli-abort',
    'turn-abort',
    'interrupt',
    'login-required',
    'manual',
  ]) {
    const err = new SessionClosedError('s', 'x', reason);
    err.cause = timeout;
    assert.equal(isTurnTimeoutAbort(err), false, reason);
    const outer = Object.assign(new Error('wrapped'), { cause: err });
    assert.equal(isTurnTimeoutAbort(outer), false, `wrapped ${reason}`);
  }
  assert.equal(isTurnTimeoutAbort(new SessionClosedError('s', 'x', 'agent-watchdog')), true);
  assert.equal(isTurnTimeoutAbort(Object.assign(new SessionClosedError('s', 'x'), { cause: timeout })), true);
});

test('classification scans the whole chain: any explicit cancel wins, whatever the order or object type', () => {
  const stall = () => providerTimeoutError('test', 1);
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError', reason: 'user-cancel', cause: stall() });
  assert.equal(isTurnTimeoutAbort(abortError), false, 'AbortError with a user-cancel reason and a stall cause');
  assert.equal(isTurnTimeoutAbort({ reason: 'interrupt', cause: stall() }), false, 'plain object interrupt');
  assert.equal(
    isTurnTimeoutAbort({ cause: stall(), signal: { reason: 'user-cancel' } }),
    false,
    'signal.reason cancel'
  );
  const deeper = new SessionClosedError('s', 'x', 'user-cancel');
  assert.equal(
    isTurnTimeoutAbort(Object.assign(stall(), { cause: deeper })),
    false,
    'timeout wrapping a deeper cancel'
  );
  assert.equal(isTurnTimeoutAbort(Object.assign(new Error('w'), { error: stall(), reason: 'cli-abort' })), false);
  // Timeout cases still reap, including a timeout error carrying its own text reason.
  assert.equal(isTurnTimeoutAbort(stall()), true);
  assert.equal(isTurnTimeoutAbort(Object.assign(stall(), { reason: 'timed out' })), true);
  assert.equal(isTurnTimeoutAbort({ cause: stall() }), true);
  assert.equal(isTurnTimeoutAbort(new AgentStallAbortError('agent task stale (1ms)')), true);
});

test("the turn's recorded abort reason decides over the terminal error", () => {
  const stall = streamStalledError('test', 1);
  const cancelled = new AbortController();
  cancelled.abort(new SessionClosedError('s', 'x', 'user-cancel'));
  assert.equal(turnEndedByTimeout(cancelled.signal, stall), false, 'user cancelled, error is a stall');
  const interrupted = new AbortController();
  interrupted.abort(new SessionClosedError('s', 'x', 'interrupt'));
  assert.equal(turnEndedByTimeout(interrupted.signal, stall), false);
  const generic = new AbortController();
  generic.abort();
  assert.equal(turnEndedByTimeout(generic.signal, stall), false, 'aborted for an unnamed reason');
  const watchdog = new AbortController();
  watchdog.abort(new SessionClosedError('s', 'x', 'agent-watchdog'));
  assert.equal(turnEndedByTimeout(watchdog.signal, new Error('boom')), true);
  const linkedStall = new AbortController();
  linkedStall.abort(new AgentStallAbortError('agent task stale (1ms)'));
  assert.equal(turnEndedByTimeout(linkedStall.signal, new Error('boom')), true);
  assert.equal(
    turnEndedByTimeout(new AbortController().signal, stall),
    true,
    'not aborted: the terminal error decides'
  );
});

test('cancelBackgroundTasks startedSinceMs only selects tasks started at or after it; without it all are cancelled', () => {
  const stopped = [];
  const owner = uniqueId('owner');
  const [old, recent] = ['old', 'recent'].map(uniqueId);
  shellJob(owner, old, Date.now() - 60_000, stopped);
  shellJob(owner, recent, Date.now(), stopped);
  const since = cancelBackgroundTasks({
    surface: 'shell',
    executionSessionId: owner,
    startedSinceMs: Date.now() - 1_000,
    notify: false,
  });
  assert.deepEqual(since.taskIds, [recent]);
  assert.deepEqual(stopped, [recent]);
  const rest = cancelBackgroundTasks({ surface: 'shell', executionSessionId: owner, notify: false });
  assert.equal(rest.cancelled, 1);
  assert.deepEqual(stopped, [recent, old]);
});
