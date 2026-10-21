import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The wake matrix for passive waits (`task wait`, the foreground shell hold):
// every wake event ends the wait at once and its notification reaches the
// very next model request exactly once, the waited task keeps running, and
// the session's task-wait state goes waiting -> running. Non-wake events
// leave the wait alone. Two delivery paths are covered with a real askSession
// turn against a fake provider:
// - "agent" (sub-agent, headless Lead): the manager pending queue;
// - "lead" (desktop/TUI Lead): the session-flow queue and its steering drain.

const root = mkdtempSync(join(tmpdir(), 'mixdog-wake-matrix-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { abortSessionTurn } = await import('./session-close.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { enqueuePendingMessage, markCompletionEntry } = await import('./pending-messages.mjs');
const { recordDeliveredCompletion } = await import('./delivered-completions.mjs');
const { _getRuntimeEntry } = await import('./runtime-liveness.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { beginInterruptibleTaskWait, interruptTaskWaitForSession, registerTaskWaitSteeringCheck } = await import(
  '../task-wait-control.mjs'
);
const { renderAgentCompletionEnvelope, renderShellCompletionEnvelope } = await import(
  '../../../../shared/task-notification-envelope.mjs'
);
const {
  acknowledgeBackgroundTaskCompletion,
  cancelBackgroundTask,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
} = await import('../../../../shared/background-tasks.mjs');
const { executeBuiltinTool } = await import('../../tools/builtin.mjs');
const { executeTaskTool } = await import('../../tools/builtin/task-tool.mjs');
const { killShellJob, peekShellJob, shutdownShellJobs } = await import('../../tools/builtin/shell-jobs.mjs');
const { createNotify } = await import('../../../../../session-runtime/services/agent-tool/notify.mjs');
const { createNotificationBus } = await import('../../../../../session-runtime/notification-bus.mjs');
const { createSessionFlow } = await import('../../../../../tui/session/session-flow.mjs');
const { createSubmissionIntake } = await import('../../../../../tui/session/session-api/intake/submission.mjs');
const { resolveTuiRuntimeNotificationDelivery } = await import('../../../../../tui/session/notification-plan.mjs');

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});
test.after(async () => {
  await shutdownShellJobs('test-cleanup').catch(() => {});
});

// A wake is event-driven (the wait's abort signal), so a missing one shows as
// the whole wait timeout (10 s and up), never as a near miss. The bound only
// has to separate the two; it is wide because the suite's other files load the
// machine (a loaded run measured 775 ms against the former 500 ms bound).
const WAKE_BOUND_MS = 2_000;
const shellText = (out) => String(out?.result ?? out);
let seq = 0;
const uid = (prefix) => `${prefix}_${process.pid}_${++seq}`;

const agentDone = (id, status = 'completed') =>
  renderAgentCompletionEnvelope({ id, tag: 'worker', status, result: `agent ${id} ${status}`, error: 'boom' });
const shellDone = (id, status = 'completed', exitCode = 0) =>
  renderShellCompletionEnvelope({ jobId: id, status, exitCode, command: 'npm test', result: `shell ${id} out` });

// The Lead's session-flow bag, wired as the desktop wires it: a queue that
// wakes waits on enqueue, an intake that wakes on typed input, and the turn's
// wait-entry check.
function leadFlow(sessionId) {
  const state = { busy: true, commandBusy: false, queued: [] };
  const turns = [];
  let n = 0;
  const bag = {
    runtime: {
      id: sessionId,
      interruptTaskWait: (reason, detail) => interruptTaskWaitForSession(sessionId, reason, detail),
    },
    flags: {},
    pending: [],
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `lead-${++n}`,
    tuiDebug() {},
    pushUserOrSyntheticItem() {},
    flushDeferredExecutionPendingResumeKick() {},
    autoClearBeforeSubmit: async () => {},
    runTurn: async (...args) => {
      turns.push({ at: Date.now(), args });
      return 'done';
    },
  };
  Object.assign(bag, createSessionFlow(bag));
  const intake = createSubmissionIntake(bag);
  const stopCheck = registerTaskWaitSteeringCheck((id) => id === sessionId && bag.pendingTaskWaitWake());
  return {
    bag,
    state,
    turns,
    intake,
    stopCheck,
    notify: (text, execution) =>
      bag.enqueue(text, { mode: 'task-notification', priority: 'next', execution, key: execution?.id }),
  };
}

// One real turn: the model calls `task wait` on a running shell task, the
// event fires `injectAfterMs` into the wait, and the model answers on the
// next request. Returns the timings and transcript facts each cell asserts.
async function waitTurn(t, { path, inject, observeMs = 0, after = null, waitArgs = {} }) {
  const providerName = uid('wake-matrix');
  const sends = [];
  const taskId = uid('task_shell_waited');
  let resolveTask;
  const marks = {};
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      sends.push({ at: Date.now(), messages: messages.map((m) => ({ role: m.role, content: m.content })) });
      if (sends.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_wait', name: 'task', arguments: { action: 'wait', task_id: taskId, ...waitArgs } }],
          stopReason: 'tool_use',
        };
      }
      return { content: 'answer', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  let result = null;
  let error = null;
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    const task = registerBackgroundTask({
      taskId,
      surface: 'shell',
      operation: 'shell',
      label: 'npm test',
      context: { callerSessionId: session.id, routingSessionId: session.id },
    });
    task.promise = new Promise((resolve) => {
      resolveTask = resolve;
    });
    const lead = path === 'lead' ? leadFlow(session.id) : null;
    const ctx = {
      session,
      taskId,
      lead,
      finishTask: (status = 'completed') => {
        completeBackgroundTask(taskId, { status, resultText: 'waited task out', notify: false });
        resolveTask();
      },
    };
    const fire = setTimeout(() => {
      marks.waitingBefore = _getRuntimeEntry(session.id)?.taskWaits || 0;
      marks.injectAt = Date.now();
      inject(ctx);
      if (observeMs > 0) {
        setTimeout(() => {
          marks.sendsDuringObserve = sends.length;
          marks.waitingDuringObserve = _getRuntimeEntry(session.id)?.taskWaits || 0;
          after?.(ctx);
        }, observeMs);
      }
    }, 300);
    try {
      result = await askSession(session.id, 'run the wait', null, null, null, null, {
        ...(lead ? { drainSteering: (_sid, options) => lead.bag.drainPendingSteering(options) } : {}),
      });
    } catch (err) {
      error = err;
      marks.rejectedAt = Date.now();
    } finally {
      clearTimeout(fire);
      lead?.stopCheck();
      marks.waitingAfter = _getRuntimeEntry(session.id)?.taskWaits || 0;
      marks.taskStatusAfter = peekStatus(taskId);
      cancelBackgroundTask(taskId, 'test cleanup');
    }
    marks.stored = loadSession(session.id)?.messages || [];
  });
  const toolResult = marks.stored.find((m) => m.role === 'tool' && m.toolCallId === 'call_wait');
  return { sends, marks, result, error, toolText: String(toolResult?.content || ''), taskId };
}

const peekStatus = (taskId) => getBackgroundTask(taskId)?.status || null;

// The wake latency: inject -> next model request.
const latency = (run) => (run.sends[1]?.at || Number.POSITIVE_INFINITY) - run.marks.injectAt;
const countIn = (messages, needle) =>
  messages.filter((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(needle))
    .length;

function assertWokeAndDelivered(run, needle, { stillRunning = true } = {}) {
  assert.equal(run.error, null, run.error?.stack);
  assert.ok(latency(run) < WAKE_BOUND_MS, `wake latency ${latency(run)}ms`);
  assert.equal(run.marks.waitingBefore, 1, 'session showed the task wait (UI: waiting)');
  assert.equal(run.marks.waitingAfter, 0, 'wait released (UI: running, then done)');
  assert.equal(run.sends.length, 2, 'exactly one follow-up model request');
  if (needle) {
    assert.equal(countIn(run.sends[1].messages, needle), 1, 'delivered once, in the very next request');
    assert.equal(countIn(run.marks.stored, needle), 1, 'stored exactly once');
  }
  if (stillRunning) {
    assert.equal(run.marks.taskStatusAfter, 'running', 'the waited task keeps running');
    assert.match(run.toolText, /still running/);
  }
}

const EVENTS = [
  {
    name: 'another shell job of the session finishes',
    needle: (id) => `shell ${id} out`,
    agent: (ctx, id) => enqueuePendingMessage(ctx.session.id, markCompletionEntry(shellDone(id))),
    lead: (ctx, id) => ctx.lead.notify(shellDone(id), { surface: 'shell', id, status: 'completed' }),
  },
  {
    name: 'a sub-agent completes',
    needle: (id) => `agent ${id} completed`,
    agent: (ctx, id) => enqueuePendingMessage(ctx.session.id, markCompletionEntry(agentDone(id))),
    lead: (ctx, id) => ctx.lead.notify(agentDone(id), { surface: 'agent', id, status: 'completed' }),
  },
  {
    name: 'a sub-agent fails',
    needle: (id) => `agent ${id} failed`,
    agent: (ctx, id) => enqueuePendingMessage(ctx.session.id, markCompletionEntry(agentDone(id, 'failed'))),
    lead: (ctx, id) => ctx.lead.notify(agentDone(id, 'failed'), { surface: 'agent', id, status: 'failed' }),
  },
  {
    name: 'a sub-agent is cancelled',
    needle: (id) => `agent ${id} cancelled`,
    agent: (ctx, id) => enqueuePendingMessage(ctx.session.id, markCompletionEntry(agentDone(id, 'cancelled'))),
    lead: (ctx, id) => ctx.lead.notify(agentDone(id, 'cancelled'), { surface: 'agent', id, status: 'cancelled' }),
  },
  {
    name: 'a background job fails or times out',
    needle: (id) => `shell ${id} out`,
    agent: (ctx, id) => enqueuePendingMessage(ctx.session.id, markCompletionEntry(shellDone(id, 'failed', 124))),
    lead: (ctx, id) => ctx.lead.notify(shellDone(id, 'failed', 124), { surface: 'shell', id, status: 'failed' }),
  },
];

for (const path of ['lead', 'agent']) {
  for (const event of EVENTS) {
    test(`[${path}] task wait: ${event.name} -> wait ends, delivered once before the next request`, async (t) => {
      const id = uid(event.name.includes('agent') ? 'task_agent' : 'job_other');
      const run = await waitTurn(t, { path, inject: (ctx) => event[path](ctx, id) });
      assertWokeAndDelivered(run, event.needle(id));
      assert.match(run.toolText, new RegExp(`Wait ended because a notification arrived \\(task_id: ${id}\\)`));
      assert.match(run.toolText, /is still running in the background/);
    });
  }

  test(`[${path}] task wait: the waited task finishes -> completed result, no duplicate`, async (t) => {
    const run = await waitTurn(t, { path, inject: (ctx) => ctx.finishTask() });
    assertWokeAndDelivered(run, null, { stillRunning: false });
    assert.match(run.toolText, /status: completed/);
    assert.match(run.toolText, /waited task out/);
    // The system rules name the `<task-notification>` block (shared/10-tool-workflow.md), so only
    // the conversation (non-system) messages can show a delivery.
    const conversation = run.marks.stored.filter((m) => m.role !== 'system');
    assert.equal(countIn(conversation, '<task-notification>'), 0, 'no second delivery as a notification');
  });

  test(`[${path}] task wait: user input -> wait ends, delivered in the same turn`, async (t) => {
    const run = await waitTurn(t, {
      path,
      inject: (ctx) =>
        path === 'lead'
          ? ctx.lead.intake.submit('also check the lint')
          : enqueuePendingMessage(ctx.session.id, 'also check the lint'),
    });
    assert.equal(run.error, null, run.error?.stack);
    assert.ok(run.sends[1].at - run.marks.injectAt < WAKE_BOUND_MS, 'wait ended at once');
    assert.match(run.toolText, /Wait ended by new user input/);
    assert.equal(run.marks.taskStatusAfter, 'running');
    assert.equal(run.marks.waitingAfter, 0);
    // The Lead's queue hands typed input to the very next request; a
    // sub-agent's queued prompt joins the turn at its terminal boundary.
    const deliveredIn = run.sends.findIndex((s) => countIn(s.messages, 'also check the lint') === 1);
    assert.equal(deliveredIn, path === 'lead' ? 1 : 2);
    assert.equal(countIn(run.marks.stored, 'also check the lint'), 1);
  });

  test(`[${path}] task wait: session cancel -> wait ends, turn cancelled, task keeps running`, async (t) => {
    const run = await waitTurn(t, { path, inject: (ctx) => abortSessionTurn(ctx.session.id, 'user-cancel') });
    assert.ok(run.error, 'the turn is cancelled');
    assert.ok(run.marks.rejectedAt - run.marks.injectAt < WAKE_BOUND_MS, 'cancel releases the wait at once');
    assert.equal(run.sends.length, 1);
    assert.equal(run.marks.taskStatusAfter, 'running');
    assert.equal(run.marks.waitingAfter, 0);
  });

  test(`[${path}] task wait: several near-simultaneous completions -> one delivery`, async (t) => {
    const ids = [uid('task_agent_b'), uid('task_agent_b'), uid('job_b')];
    const run = await waitTurn(t, {
      path,
      inject: (ctx) => {
        for (const id of ids.slice(0, 2)) EVENTS[1][path](ctx, id);
        EVENTS[0][path](ctx, ids[2]);
      },
    });
    assert.equal(run.error, null, run.error?.stack);
    assert.equal(run.sends.length, 2, 'all of them ride one model request');
    assert.equal(countIn(run.sends[1].messages, `agent ${ids[0]} completed`), 1);
    assert.equal(countIn(run.sends[1].messages, `agent ${ids[1]} completed`), 1);
    assert.equal(countIn(run.sends[1].messages, `shell ${ids[2]} out`), 1);
    assert.equal(run.marks.taskStatusAfter, 'running');
  });

  for (const nonWake of [
    {
      name: 'a notification for a different session',
      fire: (_ctx, id) => enqueuePendingMessage(uid('sess_elsewhere'), markCompletionEntry(agentDone(id))),
    },
    {
      name: 'a notification already delivered',
      fire: (ctx, id) => {
        if (path === 'lead') {
          const done = registerBackgroundTask({ taskId: id, surface: 'shell', operation: 'shell' });
          completeBackgroundTask(done.taskId, { status: 'completed', resultText: 'x', notify: false });
          acknowledgeBackgroundTaskCompletion(done.taskId);
          ctx.lead.notify(shellDone(id), { surface: 'shell', id, status: 'completed' });
        } else {
          const entry = markCompletionEntry(shellDone(id), { executionId: id });
          recordDeliveredCompletion({ executionId: id, text: entry.content });
          enqueuePendingMessage(ctx.session.id, entry);
        }
      },
    },
  ]) {
    test(`[${path}] task wait: ${nonWake.name} does NOT end the wait`, async (t) => {
      const id = uid('task_agent_nw');
      const run = await waitTurn(t, {
        path,
        inject: (ctx) => nonWake.fire(ctx, id),
        observeMs: 800,
        after: (ctx) => ctx.finishTask(),
        waitArgs: { timeout_ms: 10_000 },
      });
      assert.equal(run.error, null, run.error?.stack);
      assert.equal(run.marks.sendsDuringObserve, 1, 'still waiting 800 ms later');
      assert.equal(run.marks.waitingDuringObserve, 1, 'UI still shows waiting');
      assert.match(run.toolText, /status: completed/, 'the wait ended only when its task finished');
      assert.equal(countIn(run.marks.stored, id), 0, 'nothing delivered for it');
    });
  }
}

test('task wait: progress output with no completion does NOT end the wait', { timeout: 30_000 }, async () => {
  const sessionId = uid('sess_progress');
  const file = join(root, 'progress.js');
  writeFileSync(file, "let i=0; setInterval(() => console.log('progress ' + (++i) + '%'), 50);");
  const opts = { sessionId, callerSessionId: sessionId, routingSessionId: sessionId };
  const started = shellText(
    await executeBuiltinTool('shell', { command: `node "${file}"`, background: true }, root, opts)
  );
  const taskId = /task_id: (\S+)/.exec(started)?.[1];
  assert.ok(taskId, started);
  let returned = false;
  const waiting = executeTaskTool({ action: 'wait', task_id: taskId, timeout_ms: 10_000 }, opts).then((text) => {
    returned = true;
    return text;
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(returned, false, 'output alone never wakes the wait');
  assert.equal(peekShellJob(taskId)?.status, 'running');
  killShellJob(taskId);
  assert.match(await waiting, /status: (cancelled|failed|completed)/);
});

for (const path of ['lead', 'agent']) {
  test(`[${path}] shell hold: a notification moves the command to the background at once`, {
    timeout: 30_000,
  }, async () => {
    const sessionId = uid('sess_hold_notify');
    const file = join(root, `hold-${path}.js`);
    // The notification is sent once the command has printed (the marker file
    // is written after the output is flushed): a loaded machine can take
    // longer than any fixed delay to start node.
    const started = join(root, `hold-${path}.started`);
    writeFileSync(
      file,
      `process.stdout.write('hold-start\\n', () => require('node:fs').writeFileSync(${JSON.stringify(started)}, '1')); setTimeout(() => {}, 20000);`
    );
    const lead = path === 'lead' ? leadFlow(sessionId) : null;
    const id = uid('task_agent_hold');
    let injectAt = 0;
    const timer = setInterval(() => {
      if (!existsSync(started)) return;
      clearInterval(timer);
      injectAt = Date.now();
      if (lead) lead.notify(agentDone(id), { surface: 'agent', id, status: 'completed' });
      else enqueuePendingMessage(sessionId, markCompletionEntry(agentDone(id)));
    }, 50);
    try {
      const out = shellText(
        await executeBuiltinTool('shell', { command: `node "${file}"` }, root, {
          sessionId,
          callerSessionId: sessionId,
          routingSessionId: sessionId,
        })
      );
      const elapsed = Date.now() - injectAt;
      assert.ok(injectAt > 0 && elapsed < WAKE_BOUND_MS, `hold returned ${elapsed}ms after the notification`);
      assert.match(out, /moved to background after \d+s because a notification arrived/);
      assert.match(out, /hold-start/);
      const taskId = /task_id: (\S+)/.exec(out)?.[1];
      assert.equal(peekShellJob(taskId)?.status, 'running', 'never killed');
      killShellJob(taskId);
      if (lead) {
        const drained = lead.bag.drainPendingSteering();
        assert.equal(drained.length, 1, 'the notification is then delivered once');
      }
    } finally {
      clearInterval(timer);
      lead?.stopCheck();
    }
  });
}

test('shell hold: an already-queued notification ends a new hold at once', { timeout: 30_000 }, async () => {
  const sessionId = uid('sess_hold_prequeued');
  const file = join(root, 'hold-pre.js');
  writeFileSync(file, 'setTimeout(() => {}, 20000);');
  enqueuePendingMessage(sessionId, markCompletionEntry(agentDone(uid('task_agent_pre'))));
  const startedAt = Date.now();
  const out = shellText(
    await executeBuiltinTool('shell', { command: `node "${file}"` }, root, { sessionId, callerSessionId: sessionId })
  );
  assert.ok(Date.now() - startedAt < 3000, 'did not hold');
  assert.match(out, /because a notification arrived/);
  killShellJob(/task_id: (\S+)/.exec(out)?.[1]);
});

// Every other kind that can enter either queue. Kinds that the next boundary
// delivers mid-turn wake the wait; informational, slash and `later` kinds do
// not, and are delivered exactly as before (`deliveredInTurn` times this turn).
test('[lead] task wait: the Goal closeout -> wait ends, delivered before the next request', async (t) => {
  const text = 'Goal duration reached: closeout-marker-1';
  const run = await waitTurn(t, {
    path: 'lead',
    inject: (ctx) => {
      ctx.lead.bag.shouldRunGoalContinuation = (entry) => entry.goalId === 'goal_1';
      ctx.lead.bag.enqueue(text, {
        mode: 'goal-closeout',
        priority: 'next',
        isMeta: true,
        suppressDisplay: true,
        skipSlashCommands: true,
        restorable: false,
        abortDiscardOnAbort: true,
        goalId: 'goal_1',
        displayText: '',
      });
    },
  });
  assertWokeAndDelivered(run, 'closeout-marker-1');
  assert.match(run.toolText, /Wait ended because a notification arrived; it is delivered to you now/);
});

const NON_WAKE_KINDS = [
  {
    path: 'lead',
    name: 'a slash command typed during the wait',
    needle: 'compact-marker',
    deliveredInTurn: 0,
    // A registered command; an unregistered `/word` is ordinary message text
    // (isSlashQueuedEntry) and rightly wakes the wait like any typed message.
    fire: (ctx) => ctx.lead.intake.submit('/compact compact-marker'),
  },
  {
    path: 'lead',
    name: 'the Goal deadline warning (informational reminder)',
    needle: 'deadline-warning-marker',
    deliveredInTurn: 1,
    fire: (ctx) =>
      ctx.lead.bag.enqueue('Goal deadline soon: deadline-warning-marker', {
        mode: 'prompt',
        priority: 'next',
        isMeta: true,
        suppressDisplay: true,
        skipSlashCommands: true,
        restorable: false,
        goalId: 'goal_1',
        displayText: '',
      }),
  },
  {
    path: 'lead',
    name: 'a scheduled or event-rule channel inject (later)',
    needle: 'schedule-marker',
    deliveredInTurn: 0,
    fire: (ctx) => {
      const text = 'daily report schedule-marker';
      assert.equal(resolveTuiRuntimeNotificationDelivery({ meta: { type: 'schedule' } }, text).action, 'enqueue');
      ctx.lead.bag.enqueue(text, { mode: 'task-notification', priority: 'later', displayText: text });
    },
  },
  {
    path: 'agent',
    name: 'a scheduled or event-rule channel inject (headless queue)',
    needle: 'schedule-marker-agent',
    deliveredInTurn: 1,
    fire: (ctx) =>
      enqueuePendingMessage(ctx.session.id, {
        content: 'daily report schedule-marker-agent',
        mode: 'task-notification',
      }),
  },
  {
    path: 'agent',
    name: 'a header-only agent completion preview or a running status update',
    needle: 'preview-marker',
    deliveredInTurn: 0,
    fire: (ctx) => {
      const bus = createNotificationBus({ listeners: new Set(), mgr: { enqueuePendingMessage } });
      const id = uid('task_agent_preview');
      const text = `background task\ntask_id: ${id}\nstatus: completed\n\npreview-marker`;
      const meta = { execution_id: id, execution_surface: 'agent', type: 'agent_task_result' };
      bus.notifySessionCompletion(ctx.session.id, text, { ...meta, status: 'completed', model_visible: false });
      bus.notifySessionCompletion(ctx.session.id, text.replace('completed', 'running'), {
        ...meta,
        status: 'running',
      });
      // The Lead's router applies the same gate: no model-visible body.
      assert.equal(
        resolveTuiRuntimeNotificationDelivery({ meta: { ...meta, status: 'completed', model_visible: false } }, text)
          .modelContent,
        ''
      );
    },
  },
];

for (const kind of NON_WAKE_KINDS) {
  test(`[${kind.path}] task wait: ${kind.name} does NOT end the wait`, async (t) => {
    const run = await waitTurn(t, {
      path: kind.path,
      inject: (ctx) => kind.fire(ctx),
      observeMs: 800,
      after: (ctx) => ctx.finishTask(),
      waitArgs: { timeout_ms: 10_000 },
    });
    assert.equal(run.error, null, run.error?.stack);
    assert.equal(run.marks.sendsDuringObserve, 1, 'still waiting 800 ms later');
    assert.equal(run.marks.waitingDuringObserve, 1, 'UI still shows waiting');
    assert.match(run.toolText, /status: completed/, 'the wait ended only when its task finished');
    assert.equal(countIn(run.marks.stored, kind.needle), kind.deliveredInTurn);
  });
}

test('sub-agent: a worker completion and an owner-bound agent completion wake that session', () => {
  const worker = uid('sess_worker');
  const owner = uid('sess_owner');
  const workerWait = beginInterruptibleTaskWait(worker);
  const ownerWait = beginInterruptibleTaskWait(owner);
  try {
    const mgr = { enqueuePendingMessage };
    const notify = createNotify(mgr, {});
    const jobId = uid('job_worker');
    notify.workerNotifyFn(worker)(shellDone(jobId), {
      execution_id: jobId,
      execution_surface: 'shell',
      status: 'completed',
    });
    assert.equal(workerWait.signal.aborted, true);
    assert.equal(workerWait.wakeReason, 'notification');
    assert.equal(workerWait.wakeDetail, jobId);
    assert.equal(ownerWait.signal.aborted, false, 'only the session the notification is for');
    // An agent owner with no attached surface gets the completion through the
    // notification bus into its pending queue.
    const bus = createNotificationBus({ listeners: new Set(), mgr });
    const agentId = uid('task_agent_owner');
    bus.notifySessionCompletion(owner, agentDone(agentId), {
      execution_id: agentId,
      execution_surface: 'agent',
      status: 'completed',
      type: 'agent_task_result',
    });
    assert.equal(ownerWait.signal.aborted, true);
    assert.equal(ownerWait.interruptedByUser, false);
  } finally {
    workerWait.dispose();
    ownerWait.dispose();
  }
});

test('idle Lead: a queued notification starts a turn at once', async () => {
  const sessionId = uid('sess_idle_lead');
  const lead = leadFlow(sessionId);
  lead.state.busy = false;
  const id = uid('task_agent_idle');
  const at = Date.now();
  lead.notify(agentDone(id), { surface: 'agent', id, status: 'completed' });
  for (let i = 0; i < 50 && lead.turns.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  lead.stopCheck();
  assert.equal(lead.turns.length, 1, 'woken');
  assert.ok(lead.turns[0].at - at < WAKE_BOUND_MS);
});
