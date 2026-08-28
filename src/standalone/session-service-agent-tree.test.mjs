import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupBackgroundTasks,
  getBackgroundTask,
  startBackgroundTask,
} from '../runtime/shared/background-tasks.mjs';
import { _sessionSummary } from '../runtime/agent/orchestrator/session/store-summary-index.mjs';
import { restoreTranscriptItems } from '../tui/session/session-api-ext.mjs';
import { createStandaloneAgent } from './agent-tool.mjs';
import { createSessionService } from './session-service.mjs';

function persistedUserMessage(prompt, options = {}) {
  const transcriptMeta = options.transcriptMeta && typeof options.transcriptMeta === 'object'
    ? { ...options.transcriptMeta }
    : null;
  return {
    role: 'user',
    content: prompt,
    ...(transcriptMeta ? { meta: { transcript: transcriptMeta } } : {}),
  };
}

function fakeRuntimeFactory(events) {
  return async (options = {}) => {
    const listeners = new Set();
    const state = {
      sessionId: null,
      items: [],
      queued: [],
      busy: false,
      provider: options.provider,
      model: options.model,
    };
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    return {
      get provider() { return options.provider; },
      get session() { return { provider: options.provider }; },
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reserveSession(sessionId) {
        state.sessionId = sessionId;
        events.push(['reserve', sessionId, options]);
        emit();
        return true;
      },
      async submitAndWait(prompt, turnOptions) {
        events.push(['turn', state.sessionId, prompt, turnOptions]);
        state.busy = true;
        state.items.push({ id: `user-${state.items.length}`, kind: 'user', text: prompt });
        emit();
        const content = `handoff:${prompt}`;
        state.items.push({ id: `assistant-${state.items.length}`, kind: 'assistant', text: content });
        state.busy = false;
        emit();
        return { status: 'done', result: { content } };
      },
      async abort(options) {
        events.push(['abort', state.sessionId, options]);
        state.busy = false;
        emit();
        return { aborted: true };
      },
      async closeCanonicalSession(reason) {
        events.push(['close', state.sessionId, reason]);
        state.busy = false;
        emit();
        return true;
      },
      async dispose(reason) {
        events.push(['dispose', state.sessionId, reason]);
      },
    };
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function cancellationRaceRuntimeFactory(events, controls) {
  const createRuntime = fakeRuntimeFactory(events);
  return async (options = {}) => {
    const runtime = await createRuntime(options);
    return {
      ...runtime,
      async submitAndWait(prompt, turnOptions) {
        const state = runtime.getState();
        events.push(['turn', state.sessionId, prompt, turnOptions]);
        state.busy = true;
        controls.turnPending = true;
        controls.turnStarted.resolve(state.sessionId);
        const detail = await controls.lateTurn.promise;
        controls.turnPending = false;
        state.busy = false;
        return detail;
      },
      async closeCanonicalSession(reason) {
        const state = runtime.getState();
        events.push(['close', state.sessionId, reason]);
        controls.closedWhileTurnPending = controls.turnPending;
        state.busy = false;
        return true;
      },
    };
  };
}

function durableRuntimeFactory(events, records) {
  return async (options = {}) => {
    const listeners = new Set();
    const state = {
      sessionId: null,
      items: [],
      messages: [],
      queued: [],
      busy: false,
      provider: options.provider,
      model: options.model,
    };
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const persist = (extra = {}) => {
      if (!state.sessionId) return;
      const previous = records.get(state.sessionId) || {};
      records.set(state.sessionId, {
        ...previous,
        id: state.sessionId,
        provider: options.provider || previous.provider || null,
        model: options.model || previous.model || null,
        effort: options.effort || previous.effort || null,
        fast: options.fast === true || previous.fast === true,
        modelParameters: options.modelParameters || previous.modelParameters || null,
        ...(options.sessionProfile || {}),
        messages: state.messages.map((message) => ({ ...message })),
        messageCount: state.messages.length,
        createdAt: previous.createdAt || Date.now(),
        updatedAt: Date.now(),
        status: state.busy ? 'running' : 'idle',
        ...extra,
      });
    };
    return {
      get provider() { return options.provider; },
      get session() { return { provider: options.provider }; },
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reserveSession(sessionId) {
        state.sessionId = sessionId;
        events.push(['reserve', sessionId, options]);
        persist();
        emit();
        return true;
      },
      resume(sessionId) {
        const stored = records.get(sessionId);
        if (!stored) return false;
        state.sessionId = sessionId;
        state.provider = stored.provider;
        state.model = stored.model;
        state.messages = Array.isArray(stored.messages)
          ? stored.messages.map((message) => ({ ...message }))
          : [];
        state.items = state.messages.map((message, index) => ({
          id: `${message.role}-${index}`,
          kind: message.role,
          text: message.content,
        }));
        events.push(['resume', sessionId, options]);
        emit();
        return true;
      },
      async submitAndWait(prompt, turnOptions) {
        events.push(['turn', state.sessionId, prompt, turnOptions]);
        state.busy = true;
        state.messages.push(persistedUserMessage(prompt, turnOptions));
        state.items.push({ id: `user-${state.items.length}`, kind: 'user', text: prompt });
        persist();
        emit();
        const content = `handoff:${prompt}`;
        state.messages.push({ role: 'assistant', content });
        state.items.push({ id: `assistant-${state.items.length}`, kind: 'assistant', text: content });
        state.busy = false;
        persist();
        emit();
        return { status: 'done', result: { content } };
      },
      async submitAsync(prompt, submitOptions) {
        events.push(['submit', state.sessionId, prompt, submitOptions]);
        state.messages.push(persistedUserMessage(prompt, submitOptions));
        state.items.push({ id: `user-${state.items.length}`, kind: 'user', text: prompt });
        persist();
        emit();
        return true;
      },
      readModelMessages(start = 0) {
        return {
          messageCount: state.messages.length,
          messages: state.messages.slice(start),
        };
      },
      async abort(abortOptions) {
        events.push(['abort', state.sessionId, abortOptions]);
        state.busy = false;
        persist({ status: 'cancelled' });
        emit();
        return { aborted: true };
      },
      async closeCanonicalSession(reason) {
        events.push(['close', state.sessionId, reason]);
        state.busy = false;
        persist({
          closed: true,
          status: 'closed',
          closedReason: reason,
        });
        emit();
        return true;
      },
      async dispose(reason) {
        events.push(['dispose', state.sessionId, reason]);
        persist();
      },
    };
  };
}

async function waitForAgentTask(agent, started, context) {
  const taskId = /^agent task:\s*(\S+)/m.exec(started)?.[1];
  assert.ok(taskId, started);
  let output = '';
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    output = await agent.execute({ type: 'read', task_id: taskId }, context);
    if (/status: completed/.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(output, /status: completed/);
  return output;
}

test('canonical Agent children use ordinary session turns, retain Parent–Child links, and cascade cancel', async (t) => {
  const events = [];
  const service = createSessionService({
    createSessionRuntime: fakeRuntimeFactory(events),
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => [],
  });
  t.after(() => service.stop('test complete'));

  const rootId = 'sess_root';
  const first = await service.agentSurface.createChild({
    tag: 'worker1',
    spec: {
      parentSessionId: rootId,
      ownerSessionId: rootId,
      agent: 'worker',
      agentTag: 'worker1',
      cwd: 'C:\\Project\\tree',
      preset: {
        id: 'worker-route',
        provider: 'test-provider',
        model: 'test-model',
        effort: 'high',
      },
    },
  });

  const firstSession = first.session;
  assert.equal(firstSession.parentSessionId, rootId);
  assert.equal(firstSession.ownerSessionId, rootId);
  assert.equal(firstSession.visibility, 'agent-only');
  const firstCreate = events.find(([kind, id]) => kind === 'reserve' && id === firstSession.id);
  assert.equal(firstCreate[2].sessionProfile.parentSessionId, rootId);
  assert.equal(firstCreate[2].sessionProfile.ownerSessionId, rootId);
  assert.equal(firstCreate[2].sessionProfile.visibility, 'agent-only');

  const initial = await service.agentSurface.runTurn({
    session: firstSession,
    prompt: 'initial brief',
  });
  const followUp = await service.agentSurface.runTurn({
    session: firstSession,
    prompt: 'follow up',
  });
  assert.equal(initial.content, 'handoff:initial brief');
  assert.equal(followUp.content, 'handoff:follow up');
  const firstTurns = events.filter(([kind, id]) => kind === 'turn' && id === firstSession.id);
  assert.equal(firstTurns.length, 2);
  assert.deepEqual(firstTurns.map(([, , prompt]) => prompt), ['initial brief', 'follow up']);
  assert.deepEqual(firstTurns[0][3].transcriptMeta, { sender: 'lead' });
  assert.deepEqual(firstTurns[1][3].transcriptMeta, { sender: 'lead' });
  assert.equal(firstTurns[0][3].mode, 'prompt');

  const nested = await service.agentSurface.createChild({
    tag: 'reviewer1',
    spec: {
      parentSessionId: firstSession.id,
      agent: 'reviewer',
      agentTag: 'reviewer1',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  assert.equal(nested.session.parentSessionId, firstSession.id);
  assert.equal(nested.session.ownerSessionId, rootId);
  assert.equal(service.rootOwnerSessionId(nested.session.id), rootId);

  const concurrent = await service.agentSurface.createChild({
    tag: 'worker2',
    spec: {
      parentSessionId: rootId,
      ownerSessionId: rootId,
      agent: 'worker',
      agentTag: 'worker2',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  assert.deepEqual(await Promise.all([
    service.agentManager.closeSession(concurrent.session.id, 'first close'),
    service.agentManager.closeSession(concurrent.session.id, 'second close'),
  ]), [true, true]);
  assert.equal(events.filter(
    ([kind, id]) => kind === 'close' && id === concurrent.session.id,
  ).length, 1);

  assert.equal(await service.agentManager.closeSession(firstSession.id, 'parent cancelled'), true);
  const closedIds = events
    .filter(([kind]) => kind === 'close')
    .map(([, id]) => id);
  assert.equal(closedIds.includes(firstSession.id), true);
  assert.equal(closedIds.includes(nested.session.id), true);
  assert.equal(service.agentDescriptor(firstSession.id).status, 'closed');
  assert.equal(service.agentDescriptor(nested.session.id).status, 'closed');
});

test('turn abort does not hydrate the durable Agent catalog', async (t) => {
  const events = [];
  let listSessionsCalls = 0;
  const service = createSessionService({
    createSessionRuntime: fakeRuntimeFactory(events),
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => {
      listSessionsCalls += 1;
      return [];
    },
  });
  t.after(() => service.stop('test complete'));

  const parent = await service.createSession({
    sessionId: 'sess_turn_abort_no_scan',
    cwd: 'C:\\Project\\tree',
    provider: 'test-provider',
    model: 'test-model',
  });
  const result = await service.abortSession({
    sessionId: parent.sessionId,
  });

  assert.equal(result.aborted, true);
  assert.equal(listSessionsCalls, 0);
  assert.equal(events.filter(
    ([kind, id]) => kind === 'abort' && id === parent.sessionId,
  ).length, 1);
});

test('turn abort preserves background Agent descendants', async (t) => {
  const events = [];
  const delegatedWork = deferred();
  let delegatedCancelCalls = 0;
  const service = createSessionService({
    createSessionRuntime: fakeRuntimeFactory(events),
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => [],
  });
  t.after(() => {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    return service.stop('test complete');
  });

  const parent = await service.createSession({
    sessionId: 'sess_turn_abort_parent',
    cwd: 'C:\\Project\\tree',
    provider: 'test-provider',
    model: 'test-model',
  });
  const child = await service.agentSurface.createChild({
    tag: 'background-worker',
    spec: {
      parentSessionId: parent.sessionId,
      ownerSessionId: parent.sessionId,
      agent: 'worker',
      agentTag: 'background-worker',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  const delegatedTask = startBackgroundTask({
    taskId: 'agent_lead_abort_preserves_child',
    surface: 'agent',
    operation: 'spawn',
    context: { callerSessionId: parent.sessionId },
    cancel: () => {
      delegatedCancelCalls += 1;
      delegatedWork.resolve(null);
    },
    run: () => delegatedWork.promise,
  });

  const result = await service.abortSession({
    sessionId: parent.sessionId,
  });

  assert.equal(result.aborted, true);
  assert.equal(events.some(
    ([kind, id]) => kind === 'close' && id === child.session.id,
  ), false);
  assert.equal(service.agentDescriptor(child.session.id).closed, false);
  assert.equal(service.agentDescriptor(child.session.id).status, 'idle');
  assert.equal(delegatedCancelCalls, 0);
  assert.equal(delegatedTask.status, 'running');
  delegatedWork.resolve(null);
  await delegatedTask.promise;
});

test('Agent turn abort propagates to nested Agent background work without a durable scan', async (t) => {
  const events = [];
  let listSessionsCalls = 0;
  const nestedWork = deferred();
  let nestedCancelCalls = 0;
  const service = createSessionService({
    createSessionRuntime: fakeRuntimeFactory(events),
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => {
      listSessionsCalls += 1;
      return [];
    },
  });
  t.after(() => {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    return service.stop('test complete');
  });

  const parent = await service.createSession({
    sessionId: 'sess_nested_abort_parent',
    cwd: 'C:\\Project\\tree',
    provider: 'test-provider',
    model: 'test-model',
  });
  const child = await service.agentSurface.createChild({
    tag: 'nested-parent-worker',
    spec: {
      parentSessionId: parent.sessionId,
      ownerSessionId: parent.sessionId,
      agent: 'worker',
      agentTag: 'nested-parent-worker',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  const callsBeforeAbort = listSessionsCalls;
  const nestedTask = startBackgroundTask({
    taskId: 'agent_nested_abort_child',
    surface: 'agent',
    operation: 'spawn',
    context: { callerSessionId: child.session.id },
    cancel: () => {
      nestedCancelCalls += 1;
      nestedWork.resolve(null);
    },
    run: () => nestedWork.promise,
  });

  const result = await service.abortSession({ sessionId: child.session.id });
  await nestedTask.promise;

  assert.equal(result.aborted, true);
  assert.equal(listSessionsCalls, callsBeforeAbort);
  assert.equal(nestedCancelCalls, 1);
  assert.equal(nestedTask.status, 'cancelled');
  assert.equal(events.filter(
    ([kind, id]) => kind === 'abort' && id === child.session.id,
  ).length, 1);
});

test('external desktop submit stamps User while canonical Agent turns stamp Lead', async (t) => {
  const events = [];
  const service = createSessionService({
    createSessionRuntime: async (options = {}) => {
      const runtime = await fakeRuntimeFactory(events)(options);
      return {
        ...runtime,
        externalAction: true,
        async submitAsync(prompt, submitOptions) {
          events.push(['submit', runtime.getState().sessionId, prompt, submitOptions]);
          return true;
        },
      };
    },
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => [],
  });
  t.after(() => service.stop('test complete'));

  const created = await service.createSession({
    sessionId: 'sess_desktop_user',
    cwd: 'C:\\Project\\tree',
    provider: 'test-provider',
    model: 'test-model',
  });
  const submitted = await service.submitSession({
    sessionId: created.sessionId,
    prompt: 'please explain',
  });
  assert.equal(submitted.accepted, true);
  const submits = events.filter(([kind, id]) => kind === 'submit' && id === created.sessionId);
  assert.equal(submits.length, 1);
  assert.equal(submits[0][3].transcriptMeta.sender, 'user');

  const child = await service.agentSurface.createChild({
    tag: 'worker-lead',
    spec: {
      parentSessionId: created.sessionId,
      ownerSessionId: created.sessionId,
      agent: 'worker',
      agentTag: 'worker-lead',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  await service.agentSurface.runTurn({
    session: child.session,
    prompt: 'review this change',
  });
  const turns = events.filter(([kind, id]) => kind === 'turn' && id === child.session.id);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0][3].transcriptMeta, { sender: 'lead' });
  assert.equal(child.session.parentSessionId, created.sessionId);
  assert.equal(child.session.ownerSessionId, created.sessionId);
});

test('durable Agent and desktop transcripts restore Lead and User senders', async (t) => {
  const events = [];
  const records = new Map();
  const createService = () => createSessionService({
    createSessionRuntime: async (options = {}) => {
      const runtime = await durableRuntimeFactory(events, records)(options);
      runtime.externalAction = true;
      return runtime;
    },
    sessionExists: async (sessionId) => records.has(sessionId),
    readStoredSession: async (sessionId, options = {}) => {
      const stored = records.get(sessionId);
      if (!stored) return null;
      return {
        sessionId,
        provider: stored.provider,
        model: stored.model,
        cwd: stored.cwd,
        items: [],
        ...(options.includeMessages === true ? { messages: stored.messages || [] } : {}),
      };
    },
    listSessions: async () => [...records.values()],
  });
  let service = createService();
  t.after(async () => {
    await service?.stop('test complete');
  });

  const desktop = await service.createSession({
    sessionId: 'sess_desktop_user',
    cwd: 'C:\\Project\\tree',
    provider: 'test-provider',
    model: 'test-model',
  });
  const submitted = await service.submitSession({
    sessionId: desktop.sessionId,
    prompt: 'Please explain the result.',
  });
  assert.equal(submitted.accepted, true);

  const child = await service.agentSurface.createChild({
    tag: 'worker-lead',
    spec: {
      parentSessionId: desktop.sessionId,
      ownerSessionId: desktop.sessionId,
      agent: 'worker',
      agentTag: 'worker-lead',
      cwd: 'C:\\Project\\tree',
      preset: { provider: 'test-provider', model: 'test-model' },
    },
  });
  await service.agentSurface.runTurn({
    session: child.session,
    prompt: 'Review this change.',
  });
  assert.equal(child.session.parentSessionId, desktop.sessionId);
  assert.equal(child.session.ownerSessionId, desktop.sessionId);

  const liveAgent = await service.readSession({ sessionId: child.session.id, messageStart: 0 });
  const liveDesktop = await service.readSession({ sessionId: desktop.sessionId, messageStart: 0 });
  const liveAgentUser = liveAgent.messages.find((message) => message.role === 'user');
  const liveDesktopUser = liveDesktop.messages.find((message) => message.role === 'user');
  assert.equal(liveAgentUser.meta.transcript.sender, 'lead');
  assert.equal(liveDesktopUser.meta.transcript.sender, 'user');

  const agentSessionId = child.session.id;
  const desktopSessionId = desktop.sessionId;
  await service.stop('simulated daemon replacement');
  service = createService();

  const coldAgent = await service.readSession({ sessionId: agentSessionId, messageStart: 0 });
  const coldDesktop = await service.readSession({ sessionId: desktopSessionId, messageStart: 0 });
  const storedAgentUser = coldAgent.messages.find((message) => message.role === 'user');
  const storedDesktopUser = coldDesktop.messages.find((message) => message.role === 'user');
  assert.equal(storedAgentUser.content, 'Review this change.');
  assert.equal(storedAgentUser.meta.transcript.sender, 'lead');
  assert.equal(storedDesktopUser.content, 'Please explain the result.');
  assert.equal(storedDesktopUser.meta.transcript.sender, 'user');

  const restoredAgent = restoreTranscriptItems(coldAgent.messages, { sessionId: agentSessionId });
  const restoredDesktop = restoreTranscriptItems(coldDesktop.messages, { sessionId: desktopSessionId });
  assert.equal(restoredAgent.find((item) => item.kind === 'user')?.sender, 'lead');
  assert.equal(restoredDesktop.find((item) => item.kind === 'user')?.sender, 'user');
});

test('live Agent cancel survives canonical close and a late cancelled turn rejection', {
  timeout: 3_000,
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-agent-cancel-race-'));
  const events = [];
  const controls = {
    turnStarted: deferred(),
    lateTurn: deferred(),
    turnPending: false,
    closedWhileTurnPending: false,
  };
  const config = {
    default: 'main',
    providers: {},
    presets: [{
      id: 'main',
      name: 'Main',
      provider: 'test-provider',
      model: 'test-model',
      tools: 'full',
    }],
  };
  const service = createSessionService({
    createSessionRuntime: cancellationRaceRuntimeFactory(events, controls),
    sessionExists: async () => true,
    readStoredSession: async () => null,
    listSessions: async () => [],
  });
  const agent = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => config,
      getPluginData: () => dataDir,
      resolveRuntimeSpec: (_preset, { lane, agentId }) => ({
        lane,
        scopeKey: `${lane}:${agentId}`,
      }),
    },
    reg: {},
    mgr: service.agentManager,
    dataDir,
    cwd: process.cwd(),
    sessionSurface: service.agentSurface,
    awaitKeychainPrewarm: async () => {},
    isKeychainPrewarmReady: () => true,
    notifySessionCompletion: () => true,
  });
  t.after(async () => {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    await service.stop('test complete');
    await rm(dataDir, { recursive: true, force: true });
  });

  const context = {
    callerSessionId: 'sess_cancel_race_root',
    ownerSessionId: 'sess_cancel_race_root',
    callerCwd: process.cwd(),
    clientHostPid: process.pid,
  };
  const started = await agent.execute({
    type: 'spawn',
    tag: 'cancel-race-worker',
    agent: 'worker',
    prompt: 'hold until cancelled',
  }, context);
  const taskId = /^agent task:\s*(\S+)/m.exec(started)?.[1];
  assert.ok(taskId, started);
  const sessionId = await controls.turnStarted.promise;
  const task = getBackgroundTask(taskId, { surface: 'agent' });
  assert.ok(task);
  assert.equal(task.status, 'running');

  const cancelled = await agent.execute({ type: 'cancel', task_id: taskId }, context);
  assert.match(cancelled, new RegExp(`agent task:\\s*${taskId}`));
  assert.match(cancelled, new RegExp(sessionId));
  assert.equal(controls.closedWhileTurnPending, true);
  assert.equal(controls.turnPending, true);
  assert.equal(events.filter(
    ([kind, id]) => kind === 'close' && id === sessionId,
  ).length, 1);
  assert.equal(task.status, 'cancelled');

  controls.lateTurn.resolve({ status: 'cancelled' });
  await task.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(task.status, 'cancelled');
  assert.notEqual(task.status, 'failed');
  const stored = JSON.parse(await readFile(join(dataDir, 'agent-workers.json'), 'utf8'));
  const worker = Object.values(stored.workers || {})
    .find((row) => row.sessionId === sessionId);
  assert.ok(worker);
  assert.equal(worker.status, 'cancelled');
  assert.equal(worker.stage, 'cancelled');
  assert.notEqual(worker.status, 'error');
});

test('public Agent APIs rehydrate and reuse durable canonical ancestry after daemon replacement', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-canonical-agent-'));
  const events = [];
  const notifications = [];
  const records = new Map();
  const listCalls = [];
  const metadataReads = [];
  const config = {
    default: 'main',
    providers: {},
    presets: [{
      id: 'main',
      name: 'Main',
      provider: 'test-provider',
      model: 'test-model',
      tools: 'full',
    }],
  };
  const createService = () => createSessionService({
    createSessionRuntime: durableRuntimeFactory(events, records),
    sessionExists: async (sessionId) => records.has(sessionId),
    readStoredSession: async (sessionId, options = {}) => {
      const stored = records.get(sessionId);
      if (!stored) return null;
      if (options.metadataOnly === true) {
        metadataReads.push(sessionId);
        return {
          id: sessionId,
          sessionId,
          owner: stored.owner,
          agent: stored.agent,
          parentSessionId: stored.parentSessionId,
          ownerSessionId: stored.ownerSessionId,
          visibility: stored.visibility,
        };
      }
      return {
        sessionId,
        provider: stored.provider,
        model: stored.model,
        cwd: stored.cwd,
        items: [],
        ...(options.includeMessages === true ? { messages: stored.messages || [] } : {}),
      };
    },
    listSessions: async (options = {}) => {
      listCalls.push({ ...options });
      return options.includeAgentOnly === true
        ? [...records.values()].map((record) => {
            const summary = _sessionSummary(record);
            // Simulate a pre-parentSessionId v2 sidecar. Rehydration may read
            // these exact Agent ids, but must never enumerate full sessions.
            delete summary.parentSessionId;
            return summary;
          })
        : [];
    },
  });
  const createAgent = (service) => createStandaloneAgent({
    cfgMod: {
      loadConfig: () => config,
      getPluginData: () => dataDir,
      resolveRuntimeSpec: (_preset, { lane, agentId }) => ({
        lane,
        scopeKey: `${lane}:${agentId}`,
      }),
    },
    reg: {},
    mgr: service.agentManager,
    dataDir,
    cwd: process.cwd(),
    sessionSurface: service.agentSurface,
    awaitKeychainPrewarm: async () => {},
    isKeychainPrewarmReady: () => true,
    notifySessionCompletion(ownerSessionId, text, meta) {
      notifications.push({ ownerSessionId, text, meta });
      return true;
    },
  });
  let service = createService();
  let agent = createAgent(service);
  assert.equal(agent.tools[0].annotations.agentHidden, false);
  t.after(async () => {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    await service?.stop('test complete');
    await rm(dataDir, { recursive: true, force: true });
  });

  const context = {
    callerSessionId: 'sess_public_root',
    ownerSessionId: 'sess_public_root',
    callerCwd: process.cwd(),
    clientHostPid: process.pid,
  };
  const started = await agent.execute({
    type: 'spawn',
    tag: 'canonical-worker',
    agent: 'worker',
    prompt: 'task brief',
  }, context);
  assert.match(started, /status: running/);
  const status = await waitForAgentTask(agent, started, context);
  assert.match(status, /status: completed/);
  assert.match(status, /handoff:task brief/);
  assert.doesNotMatch(status, /agent result/);

  const sessionId = /^target:\s+\S+\s+(sess_\S+)/m.exec(status)?.[1];
  assert.ok(sessionId);

  const nestedContext = {
    ...context,
    callerSessionId: sessionId,
    ownerSessionId: context.ownerSessionId,
  };
  const nestedStarted = await agent.execute({
    type: 'spawn',
    tag: 'canonical-reviewer',
    agent: 'reviewer',
    prompt: 'nested brief',
  }, nestedContext);
  const nestedStatus = await waitForAgentTask(agent, nestedStarted, nestedContext);
  const nestedSessionId = /^target:\s+\S+\s+(sess_\S+)/m.exec(nestedStatus)?.[1];
  assert.ok(nestedSessionId);
  assert.notEqual(nestedSessionId, sessionId);
  assert.equal(records.size, 2);

  // Simulate a pre-visibility legacy Agent record while retaining its valid
  // immediate-parent and root-owner metadata.
  records.set(nestedSessionId, {
    ...records.get(nestedSessionId),
    visibility: null,
  });

  await service.stop('simulated daemon replacement');
  cleanupBackgroundTasks({ surface: 'agent', force: true });
  // A durable canonical session, not the auxiliary tag index, must be enough
  // to recover same-tag reuse after a crash between the two writes.
  await rm(join(dataDir, 'agent-workers.json'), { force: true });
  service = createService();
  agent = createAgent(service);

  const coldRead = await agent.execute({ type: 'read', sessionId }, context);
  assert.match(coldRead, /handoff:task brief/);

  const sent = await agent.execute({
    type: 'send',
    tag: 'canonical-worker',
    message: 'same child follow up',
  }, context);
  assert.match(sent, new RegExp(sessionId));
  const follow = await waitForAgentTask(agent, sent, context);
  assert.match(follow, /handoff:same child follow up/);

  const rehydrated = service.agentDescriptor(sessionId);
  const rehydratedNested = service.agentDescriptor(nestedSessionId);
  assert.equal(rehydrated.id, sessionId);
  assert.equal(rehydrated.parentSessionId, context.callerSessionId);
  assert.equal(rehydrated.ownerSessionId, context.ownerSessionId);
  assert.equal(rehydrated.visibility, 'agent-only');
  assert.equal(rehydrated.provider, 'test-provider');
  assert.equal(rehydrated.model, 'test-model');
  assert.equal(rehydrated.status, 'idle');
  assert.equal(rehydratedNested.parentSessionId, sessionId);
  assert.equal(rehydratedNested.ownerSessionId, context.ownerSessionId);
  assert.equal(rehydratedNested.visibility, 'agent-only');
  assert.equal(service.rootOwnerSessionId(nestedSessionId), context.ownerSessionId);

  const explicitSent = await agent.execute({
    type: 'send',
    sessionId,
    message: 'explicit session follow up',
  }, context);
  assert.match(explicitSent, new RegExp(sessionId));
  const explicitFollow = await waitForAgentTask(agent, explicitSent, context);
  assert.match(explicitFollow, /handoff:explicit session follow up/);

  cleanupBackgroundTasks({ surface: 'agent', force: true });
  const publicStatus = await agent.execute({ type: 'status', sessionId }, context);
  const publicRead = await agent.execute({ type: 'read', sessionId }, context);
  assert.match(publicStatus, new RegExp(sessionId));
  assert.match(publicStatus, /"status": "idle"/);
  assert.match(publicRead, /handoff:explicit session follow up/);

  const cancelled = await agent.execute({ type: 'cancel', sessionId }, context);
  assert.match(cancelled, /agent close: ok/);
  assert.match(cancelled, new RegExp(sessionId));
  const closedIds = events
    .filter(([kind]) => kind === 'close')
    .map(([, id]) => id);
  assert.equal(closedIds.includes(sessionId), true);
  assert.equal(closedIds.includes(nestedSessionId), true);
  assert.equal(service.agentDescriptor(sessionId).status, 'closed');
  assert.equal(service.agentDescriptor(nestedSessionId).status, 'closed');
  assert.equal(records.get(sessionId)?.closed, true);
  assert.equal(records.get(nestedSessionId)?.closed, true);

  await service.stop('second simulated daemon replacement');
  cleanupBackgroundTasks({ surface: 'agent', force: true });
  service = createService();
  agent = createAgent(service);
  const statusAfterClose = await agent.execute({ type: 'status', sessionId }, context);
  const sendAfterClose = await agent.execute({
    type: 'send',
    sessionId,
    message: 'must not resurrect',
  }, context);
  assert.match(statusAfterClose, /"status": "closed"/);
  assert.match(sendAfterClose, /Error:.*(?:closed|not found)/i);
  assert.equal(records.size, 2);
  assert.equal(records.get(sessionId)?.closed, true);
  assert.equal(records.get(nestedSessionId)?.closed, true);

  const reservedIds = events
    .filter(([kind]) => kind === 'reserve')
    .map(([, id]) => id);
  assert.deepEqual(new Set(reservedIds), new Set([sessionId, nestedSessionId]));
  assert.equal(reservedIds.length, 2);
  assert.equal(records.size, 2);
  assert.equal(listCalls.some((options) => options.includeAgentOnly === true), true);
  assert.equal(listCalls.every((options) => options.summaryOnly === true), true);
  assert.equal(listCalls.some((options) => options.refreshFromStorage === true), false);
  assert.equal(metadataReads.includes(sessionId), true);
  assert.equal(metadataReads.includes(nestedSessionId), true);
  const turnIds = events.filter(([kind]) => kind === 'turn').map(([, id]) => id);
  assert.deepEqual(new Set(turnIds), new Set([sessionId, nestedSessionId]));
  assert.ok(notifications.length >= 4);
  assert.equal(
    notifications.some((row) =>
      row.ownerSessionId === sessionId && /handoff:nested brief/.test(row.text)),
    true,
  );
  assert.equal(
    notifications.some((row) =>
      row.ownerSessionId === 'sess_public_root' && /handoff:nested brief/.test(row.text)),
    false,
  );
  assert.equal(notifications.some((row) => /handoff:task brief/.test(row.text)), true);
  assert.equal(notifications.some((row) => /handoff:same child follow up/.test(row.text)), true);
  assert.equal(notifications.some((row) => /agent result/.test(row.text)), false);
});
