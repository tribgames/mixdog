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
const { abortSessionTurn, closeSession } = await import('./session-close.mjs');
const { _getRuntimeEntry } = await import('./runtime-liveness.mjs');
const { reapTurnShellJobs, takeStoppedShellJobs } = await import('./turn-reap.mjs');
const { SessionClosedError } = await import('./session-errors.mjs');
const { streamStalledError, providerTimeoutError } = await import('../../stall-policy.mjs');
const { abortRuntime } = await import('../../../../../session-runtime/lifecycle/teardown/session-close.mjs');
const { composeAgentDispatchAbortSignal } = await import('../../agent-runtime/agent-dispatch/abort-link.mjs');
const { makeAgentDispatch } = await import('../../agent-runtime/agent-dispatch.mjs');
const { getSession } = await import('./session-crud.mjs');
const { markProviderRecoveryExhausted } = await import('../../providers/retry-executor.mjs');
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

// `killOutcome`: what a task whose own cancel hook kills reports (survivors).
function shellJob(sessionId, taskId, startedAtMs, stopped, killOutcome = null) {
  const task = registerBackgroundTask({
    taskId,
    startedAtMs,
    surface: 'shell',
    operation: 'shell',
    label: taskId,
    input: { command: taskId, cwd: root },
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
    resultType: 'shell_task_result',
    cancel: () => {
      stopped.push(taskId);
      if (killOutcome) task.cancelOutcome = killOutcome;
    },
  });
  return task;
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
// Resolves with the error the turn ended with.
async function stuckTurn(session, { inTool, abort, signal }) {
  const ask = askSession(session.id, 'run it', null, null, null, null, {
    ...(signal ? { signal } : {}),
    beforeToolExecution: () => {
      inTool();
      setImmediate(abort);
      return new Promise(() => {});
    },
  });
  return ask.then(
    () => assert.fail('the stuck turn must not finish'),
    (error) => error
  );
}

const finishJobs = (session) =>
  cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });

// The canonical watchdog (standalone agent tree → runtime abort → abortSessionTurn)
// and the in-process watchdog (dispatch's abort link) each own their timeout.
// `outer` is the canonical turn's own controller, linked as the ask's parent
// signal exactly as a canonical turn is.
const canonicalWatchdog = (session) => {
  const outer = new AbortController();
  return {
    signal: outer.signal,
    abort: () =>
      abortRuntime(
        {
          getSession: () => session,
          abortActiveTurns: (error) => {
            outer.abort(error);
            return true;
          },
          mgr: { abortSessionTurn },
        },
        'agent-watchdog',
        { timeout: true }
      ),
  };
};

for (const [name, watchdog] of [
  ['the canonical watchdog abort (outer turn controller linked as the parent)', canonicalWatchdog],
  [
    'a runtime abort with the timeout option (no outer controller)',
    (session) => ({ signal: null, abort: () => watchdogAbort(session) }),
  ],
]) {
  test(`${name} stops what the turn started and its survivors, keeping earlier turns' jobs`, async (t) => {
    await withTurns(t, async (session) => {
      const stopped = [];
      const [earlier, promoted, late, survivor] = ['earlier', 'promoted', 'late', 'survivor'].map(uniqueId);
      const wd = watchdog(session);
      await stuckTurn(session, {
        signal: wd.signal,
        inTool: () => {
          shellJob(session.id, earlier, Date.now() - 60_000, stopped);
          shellJob(session.id, promoted, Date.now(), stopped);
        },
        abort: () => {
          shellJob(session.id, late, Date.now(), stopped);
          wd.abort();
          shellJob(session.id, survivor, Date.now(), stopped);
        },
      });
      assert.deepEqual(stopped.sort(), [late, promoted, survivor].sort());
      const handoff = watchdogStoppedHandoff(
        new Error('agent task stale (1ms)'),
        'partial',
        await takeStoppedShellJobs(session.id)
      );
      assert.match(handoff, new RegExp(`Stopped its background shell jobs: .*${promoted}`));
      assert.match(handoff, new RegExp(survivor));
      assert.doesNotMatch(handoff, new RegExp(earlier));
      finishJobs(session);
    });
  });
}

test('the in-process watchdog (a real dispatch) stops what the turn started, keeping earlier jobs', async (t) => {
  const stopped = [];
  const [earlier, started, late] = ['earlier', 'started', 'late'].map(uniqueId);
  let session;
  const provider = {
    name: 'turn-reap-dispatch',
    contextWindow: 128000,
    send: (_messages, _model, _tools, sendOpts) =>
      new Promise((_, reject) => {
        shellJob(session.id, earlier, Date.now() - 60_000, stopped);
        shellJob(session.id, started, Date.now(), stopped);
        sendOpts.onStreamDelta?.('semantic');
        sendOpts.signal.addEventListener(
          'abort',
          () => {
            shellJob(session.id, late, Date.now(), stopped);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      }),
  };
  await _withRegisteredProviderForTestAsync('turn-reap-dispatch', provider, async () => {
    session = createSession({
      provider: 'turn-reap-dispatch',
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    const dispatch = makeAgentDispatch({
      agent: 'worker',
      preset: { provider: 'turn-reap-dispatch', model: 'fake-model' },
      config: { presets: [] },
      brief: false,
      idleTimeoutMs: 1200,
      resourceAdmission: {
        acquire: async () => ({ release: async () => {} }),
        runWithLease: async (_lease, task) => task(),
      },
      prepareAgentSession: () => ({ session }),
      getSession,
      updateSessionStatus: async () => true,
      closeSession: () => true,
      askSession,
    });
    // The watchdog's poll is unref'd: keep the loop alive while it runs.
    const keepAlive = setInterval(() => {}, 100);
    try {
      await assert.rejects(dispatch({ prompt: 'run it' }));
    } finally {
      clearInterval(keepAlive);
    }
    assert.deepEqual(stopped.sort(), [late, started].sort());
    assert.deepEqual((await takeStoppedShellJobs(session.id)).stopped.sort(), [late, started].sort());
    finishJobs(session);
  });
});

test('the registry watchdog on the plain manager (headless role) stops what the turn started', async (t) => {
  const stopped = [];
  const [earlier, started, late] = ['earlier', 'started', 'late'].map(uniqueId);
  const { createProgressWatchdogRegistry } = await import(
    '../../../../../session-runtime/services/agent-watchdog-registry.mjs'
  );
  const manager = await import('../manager.mjs');
  const { resolveAgentWatchdogPolicy } = await import('../../agent-runtime/agent-progress-watchdog.mjs');
  let session;
  const provider = {
    name: 'turn-reap-registry',
    contextWindow: 128000,
    send: (_messages, _model, _tools, sendOpts) =>
      new Promise((_, reject) => {
        shellJob(session.id, earlier, Date.now() - 60_000, stopped);
        shellJob(session.id, started, Date.now(), stopped);
        sendOpts.onStreamDelta?.('semantic');
        sendOpts.signal.addEventListener(
          'abort',
          () => {
            shellJob(session.id, late, Date.now(), stopped);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      }),
  };
  await _withRegisteredProviderForTestAsync('turn-reap-registry', provider, async () => {
    session = createSession({
      provider: 'turn-reap-registry',
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    const registry = createProgressWatchdogRegistry({ mgr: manager });
    const handle = registry.start(session.id, resolveAgentWatchdogPolicy('worker', { idleTimeoutMs: 1200 }), 'worker');
    const keepAlive = setInterval(() => {}, 100);
    try {
      await assert.rejects(askSession(session.id, 'run it', null, null, null, null, {}));
    } finally {
      clearInterval(keepAlive);
      handle.stop();
    }
    assert.deepEqual(stopped.sort(), [late, started].sort());
    finishJobs(session);
  });
});

test('an interrupt through abortRuntime propagates the runtime abort error, not the manager one', async (t) => {
  await withTurns(t, async (session) => {
    const outer = new AbortController();
    const error = await stuckTurn(session, {
      signal: outer.signal,
      inTool: () => {},
      abort: () =>
        abortRuntime(
          {
            getSession: () => session,
            abortActiveTurns: (abortError) => {
              outer.abort(abortError);
              return true;
            },
            mgr: { abortSessionTurn },
          },
          'interrupt'
        ),
    });
    assert.equal(error, outer.signal.reason, 'the turn ends with the very error the outer abort carried');
    assert.equal(error.reason, 'interrupt');
    assert.match(error.message, /runtime abort \(reason=interrupt\)/);
  });
});

test('the dispatch abort link reports only the source that wins, before the composite aborts', () => {
  const [parent, watchdog] = [new AbortController(), new AbortController()];
  const winners = [];
  composeAgentDispatchAbortSignal([parent.signal, watchdog.signal], (source) => winners.push(source));
  watchdog.abort(new AgentStallAbortError('agent task stale (1ms)'));
  parent.abort();
  assert.deepEqual(winners, [watchdog.signal], 'the watchdog won; the later parent abort is not reported');

  const [parent2, watchdog2] = [new AbortController(), new AbortController()];
  const winners2 = [];
  const link = composeAgentDispatchAbortSignal([parent2.signal, watchdog2.signal], (source) => {
    winners2.push([source, link.signal.aborted]);
  });
  parent2.abort('user-cancel');
  watchdog2.abort(new AgentStallAbortError('agent task stale (1ms)'));
  assert.deepEqual(winners2, [[parent2.signal, false]], 'the cancel won; the later watchdog is not reported');
  assert.equal(link.signal.reason, 'user-cancel');
});

test('a watchdog that fires after a cancel does not override it; one that fires first stands', async (t) => {
  await withTurns(t, async (session) => {
    const stopped = [];
    const [cancelFirst, watchdogFirst] = ['cancel_first', 'watchdog_first'].map(uniqueId);
    await stuckTurn(session, {
      inTool: () => shellJob(session.id, cancelFirst, Date.now(), stopped),
      abort: () => {
        abortSessionTurn(session.id, 'user-cancel');
        watchdogAbort(session);
      },
    });
    assert.deepEqual(stopped, [], 'cancel first, watchdog second: no reap');
    assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [], stopping: [] });
    await stuckTurn(session, {
      inTool: () => shellJob(session.id, watchdogFirst, Date.now(), stopped),
      abort: () => {
        watchdogAbort(session);
        abortSessionTurn(session.id, 'user-cancel');
      },
    });
    assert.deepEqual(stopped, [watchdogFirst], 'watchdog first, cancel second: the timeout decision stands');
    finishJobs(session);
  });
});

for (const [name, end] of [
  ['user-cancel', (session) => abortSessionTurn(session.id, 'user-cancel')],
  ['interrupt', (session) => abortSessionTurn(session.id, 'interrupt')],
  ['an agent-watchdog reason without the timeout option', (session) => abortSessionTurn(session.id, 'agent-watchdog')],
  ['a runtime abort without the timeout option', (session) => abortRuntime(abortDeps(session), 'cli-abort')],
  ['closeSession', (session) => closeSession(session.id, 'manual')],
]) {
  test(`${name} never arms the timeout reap`, async (t) => {
    await withTurns(t, async (session) => {
      const stopped = [];
      const survivor = uniqueId('survivor');
      await stuckTurn(session, {
        inTool: () => shellJob(session.id, uniqueId('promoted'), Date.now(), stopped),
        abort: () => {
          end(session);
          shellJob(session.id, survivor, Date.now(), stopped);
        },
      });
      assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [], stopping: [] });
      if (name !== 'closeSession') assert.deepEqual(stopped, []);
      finishJobs(session);
    });
  });
}

function watchdogAbort(session) {
  return abortRuntime(abortDeps(session), 'agent-watchdog', { timeout: true });
}

function abortDeps(session) {
  return { getSession: () => session, abortActiveTurns: () => false, mgr: { abortSessionTurn } };
}

test('a normally finished turn never arms the timeout reap', async (t) => {
  const stopped = [];
  await withTurns(
    t,
    async (session) => {
      await askSession(session.id, 'go', null, null, null, null, {});
      assert.deepEqual(stopped, []);
      assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [], stopping: [] });
      finishJobs(session);
    },
    async () => {
      shellJob(currentSessionId(), uniqueId('during'), Date.now(), stopped);
      return { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    }
  );
});

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
      abort: () => watchdogAbort(session),
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
        assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [started], stopping: [] });
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

test('a job whose processes are not confirmed gone is reported as still stopping, not stopped', async (t) => {
  const [gone, confirmed, stuck] = ['gone', 'confirmed', 'stuck'].map(uniqueId);
  await withTurns(
    t,
    async (session) => {
      await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
      const jobs = await takeStoppedShellJobs(session.id);
      assert.deepEqual(jobs.stopped.sort(), [confirmed, gone].sort());
      assert.deepEqual(jobs.stopping, [stuck]);
      const handoff = watchdogStoppedHandoff(new Error('stale'), 'partial', jobs);
      assert.match(handoff, new RegExp(`\\[Stopped its background shell jobs: [^\\]]*${gone}`));
      assert.doesNotMatch(handoff, new RegExp(`Stopped its background shell jobs: [^\\]]*${stuck}`));
      assert.match(handoff, new RegExp(`\\[Still stopping its background shell jobs: ${stuck}\\.\\]`));
      cancelBackgroundTasks({ surface: 'shell', executionSessionId: session.id, notify: false });
    },
    async () => {
      shellJob(currentSessionId(), gone, Date.now(), []);
      shellJob(currentSessionId(), confirmed, Date.now(), [], Promise.resolve({ terminated: true }));
      shellJob(currentSessionId(), stuck, Date.now(), [], Promise.resolve({ terminated: false }));
      throw Object.assign(providerTimeoutError('test', 1), { unsafeToRetry: true });
    }
  );
});

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

// A provider timeout code, or a producer's own streamStalled flag with no code
// (terminal frames, compat stream results, Gemini partial finals), reaps only
// as the turn's terminal error while the turn's own signal is un-aborted; a
// code that only sits in a cause chain, or a terminal error after a cancel,
// never does.
for (const [code, marker] of [
  ['ESTREAMSTALL', { code: 'ESTREAMSTALL' }],
  ['EPROVIDERTIMEOUT', { code: 'EPROVIDERTIMEOUT' }],
  ['EGEMINITIMEOUT', { code: 'EGEMINITIMEOUT' }],
  ['flag-only streamStalled', { code: null, streamStalled: true }],
]) {
  const timeoutError = (extra = {}) =>
    Object.assign(new Error('provider timed out'), { ...marker, unsafeToRetry: true, ...extra });
  test(`a terminal ${code} error stops what the turn started when nothing aborted the turn`, async (t) => {
    const stopped = [];
    const [earlier, started] = ['earlier', 'started'].map(uniqueId);
    await withTurns(
      t,
      async (session) => {
        await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
        assert.deepEqual(stopped, [started]);
        assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [started], stopping: [] });
        finishJobs(session);
      },
      async () => {
        shellJob(currentSessionId(), earlier, Date.now() - 60_000, stopped);
        shellJob(currentSessionId(), started, Date.now(), stopped);
        throw timeoutError();
      }
    );
  });

  test(`a terminal ${code} error after a cancel already stopped the turn stops no job`, async (t) => {
    const stopped = [];
    await withTurns(
      t,
      async (session) => {
        await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
        assert.deepEqual(stopped, []);
        assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [], stopping: [] });
        finishJobs(session);
      },
      async (_messages, _model, _tools, sendOpts) => {
        shellJob(currentSessionId(), uniqueId('during'), Date.now(), stopped);
        setImmediate(() => abortSessionTurn(currentSessionId(), 'user-cancel'));
        await new Promise((resolve) => sendOpts.signal.addEventListener('abort', resolve, { once: true }));
        throw timeoutError();
      }
    );
  });
}

test('a terminal retry-exhausted WS inter-chunk stall (as the WS watchdog builds it) stops what the turn started', async (t) => {
  const stopped = [];
  const started = uniqueId('started');
  await withTurns(
    t,
    async (session) => {
      await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
      assert.deepEqual(stopped, [started]);
      finishJobs(session);
    },
    async () => {
      shellJob(currentSessionId(), started, Date.now(), stopped);
      const err = Object.assign(new Error('WS stream: inter-chunk inactivity for 20ms'), {
        streamStalled: true,
        code: 'ESTREAMSTALL',
        unsafeToRetry: true,
      });
      throw markProviderRecoveryExhausted(err, { owner: 'openai-oauth-ws-midstream', attempts: 3 });
    }
  );
});

test('a timeout code that is only in the cause chain of the terminal error stops no job', async (t) => {
  const stopped = [];
  await withTurns(
    t,
    async (session) => {
      await assert.rejects(askSession(session.id, 'go', null, null, null, null, {}));
      assert.deepEqual(stopped, []);
      finishJobs(session);
    },
    async () => {
      shellJob(currentSessionId(), uniqueId('during'), Date.now(), stopped);
      throw Object.assign(new Error('wrapped'), {
        code: 'EOTHER',
        unsafeToRetry: true,
        cause: providerTimeoutError('test', 1),
      });
    }
  );
});

// An abort inherited from a parent is a cancel for this turn, whatever it
// carries: the child's own watchdog or provider timeout is what arms it, and
// the turn ends with the same error the parent abort always produced.
for (const [name, parentReason] of [
  ['a user-cancel SessionClosedError', () => new SessionClosedError('s', 'x', 'user-cancel')],
  ['a plain user-cancel string', () => 'user-cancel'],
  ['a plain agent-watchdog string', () => 'agent-watchdog'],
  ['an agent-watchdog SessionClosedError', () => new SessionClosedError('s', 'x', 'agent-watchdog')],
  ['an AgentStallAbortError (a parent timeout)', () => new AgentStallAbortError('agent task stale (1ms)')],
  ['a provider timeout error (a parent timeout)', () => providerTimeoutError('test', 1)],
  [
    'an AbortError carrying a user-cancel reason and a stall cause',
    () =>
      Object.assign(new Error('aborted'), {
        name: 'AbortError',
        reason: 'user-cancel',
        cause: providerTimeoutError('test', 1),
      }),
  ],
]) {
  test(`an inherited parent abort with ${name} never arms the child`, async (t) => {
    await withTurns(t, async (session) => {
      const stopped = [];
      const ac = new AbortController();
      const reason = parentReason();
      const error = await stuckTurn(session, {
        signal: ac.signal,
        inTool: () => shellJob(session.id, uniqueId('job'), Date.now(), stopped),
        abort: () => ac.abort(reason),
      });
      assert.deepEqual(stopped, []);
      assert.deepEqual(await takeStoppedShellJobs(session.id), { stopped: [], stopping: [] });
      // The parent's reason is not re-typed: a string is not wrapped as a
      // recorded close reason, an Error reaches the turn as itself or as the
      // message of the cancelled call.
      if (typeof reason === 'string') assert.notEqual(error.reason, reason);
      else assert.ok(error === reason || error.message.includes(reason.message), error.message);
      finishJobs(session);
    });
  });
}

test('a recovery-exhausted rethrow keeps the timeout code and flag the terminal check reads', async () => {
  const { createAnthropicRecoveryGuards } = await import('../../providers/anthropic-recovery-guards.mjs');
  const spent = { allowStallRetry: () => false };
  for (const make of [() => streamStalledError('test', 1), () => providerTimeoutError('test', 1)]) {
    const original = make();
    const guards = createAnthropicRecoveryGuards({
      label: 'test',
      budgetOwner: 'test',
      opts: { _stallRetryBudget: spent },
      onTextReset: null,
      issueNonStreamingFallback: async () => assert.fail('no replay once the budget is spent'),
    });
    for (const rethrow of [
      () => guards.requireTransportRecoveryBudget(original, null),
      () => guards.recoverNonStreaming({ emittedTextChars: 3 }, original, null),
    ]) {
      const thrown = await Promise.resolve()
        .then(rethrow)
        .then(
          () => null,
          (error) => error
        );
      assert.equal(thrown, original, 'the same error object is rethrown');
      assert.equal(thrown.code, original.code);
      assert.equal(thrown.streamStalled, original.streamStalled);
    }
    assert.equal(original.providerRecoveryExhausted, true);
  }
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
