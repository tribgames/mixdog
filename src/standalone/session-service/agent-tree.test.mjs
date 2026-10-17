import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTree } from './agent-tree.mjs';
import { lastStoredAgentHandoff } from './agent-tree/agent-rehydrate.mjs';
import { AgentStallAbortError } from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

// The Agent child catalog against fake session-service hooks: how children
// are linked and rooted, what a turn does to a descriptor, how cancellation
// cascades, and what rehydration rebuilds from stored rows.

function createHarness({ rows = [], stored = {}, busyIds = new Set(), beforeCreate = async () => {} } = {}) {
  const created = [];
  const turns = [];
  const closed = [];
  const closeOptions = [];
  const retained = [];
  const logs = [];
  let nextId = 1;
  const runtimes = new Map();
  const runtimeFor = (id) => {
    if (!runtimes.has(id)) {
      runtimes.set(id, {
        messages: [],
        terminal: false,
        isSessionTerminal() {
          return this.terminal;
        },
        readModelMessages(start) {
          const list = runtimeFor(id).messages;
          return { messageCount: list.length, messages: list.slice(start) };
        },
        getState: () => ({ items: busyIds.has(id) ? [1, 2, 3] : [] }),
        async submitAndWait(prompt, options) {
          turns.push({ id, prompt, options });
          return runtimeFor(id).reply(prompt);
        },
        reply: async (prompt) => ({ status: 'done', result: { content: `echo:${prompt}` } }),
        async closeCanonicalSession(reason, options) {
          this.terminal = true;
          closed.push([id, reason]);
          closeOptions.push([id, options]);
          return true;
        },
      });
    }
    return runtimes.get(id);
  };
  const tree = createAgentTree({
    listSessions: async () => rows,
    readStoredSession: async (id, options) => stored[id]?.(options) ?? null,
    log: (line) => logs.push(line),
    sessionOwner: (id) => (runtimes.has(id) ? { runtime: runtimeFor(id) } : null),
    stateBusy: (state) => Array.isArray(state.items) && state.items.length > 0,
    entryForSession: async (id) => ({ runtime: runtimeFor(id) }),
    retainUnwatched: (_entry, reason) => retained.push(reason),
    createSession: async (input) => {
      await beforeCreate();
      const sessionId = `child-${nextId++}`;
      created.push({ sessionId, ...input });
      return { sessionId };
    },
  });
  return { tree, created, turns, closed, closeOptions, retained, logs, runtimeFor };
}

const spec = (parentSessionId, extra = {}) => ({
  parentSessionId,
  agent: 'reviewer',
  preset: { provider: 'openai', model: 'gpt-5', effort: 'high', id: 'fast-review' },
  cwd: 'C:/work',
  ...extra,
});

test('a busy child accepts follow-ups on its existing runtime', async () => {
  const h = createHarness({ busyIds: new Set(['child-1']) });
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const runtime = h.runtimeFor(session.id);
  const accepted = [];
  runtime.submitAsync = async (prompt, options) => {
    accepted.push({ prompt, options });
    return true;
  };
  assert.ok(await h.tree.agentSurface.enqueueTurn({ session, prompt: 'follow-up', context: 'extra' }));
  assert.equal(h.turns.length, 0, 'no second submitAndWait turn is started');
  assert.equal(accepted[0].prompt, 'follow-up');
  assert.equal(accepted[0].options.priority, 'next');
  assert.equal(accepted[0].options.context, 'extra');
});

test('setRoute saves a reused child model through the runtime route API, even while it is busy', async () => {
  const h = createHarness({ busyIds: new Set(['child-1']) });
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const requests = [];
  h.runtimeFor(session.id).setRoute = async (route) => {
    requests.push(route);
    return { provider: 'anthropic', model: 'opus', ...route };
  };
  const route = { provider: 'anthropic', model: 'opus', effort: 'low', fast: true };
  await h.tree.agentSurface.setRoute({ session, route });
  assert.deepEqual(requests, [{ ...route, sessionOnly: true }], 'scoped to the child, never Main');
  assert.equal(h.tree.agentDescriptor(session.id).model, 'opus');
  assert.equal(h.tree.agentDescriptor(session.id).provider, 'anthropic');
  // A tuning-only change names no model: the descriptor keeps the selected one.
  await h.tree.agentSurface.setRoute({ session, route: { fast: false } });
  assert.deepEqual(requests.at(-1), { fast: false, sessionOnly: true });
  assert.equal(h.tree.agentDescriptor(session.id).model, 'opus');
});

test('createAgentChild passes the preset Auto effort explicitly and records only the off state', async () => {
  const h = createHarness();
  const { session: on } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const off = (
    await h.tree.createAgentChild({ spec: spec('lead-1', { preset: { ...spec('').preset, autoEffort: false } }) })
  ).session;
  assert.equal(h.created[0].autoEffort, true, 'explicit, so the Main model bucket cannot decide it');
  assert.equal(h.created[1].autoEffort, false);
  assert.equal(Object.hasOwn(on, 'autoEffort'), false);
  assert.equal(off.autoEffort, false);
});

test('canonical child forwards its ordered fallback chain through the runtime profile', async () => {
  const h = createHarness();
  const fallbacks = [
    { provider: 'anthropic', model: 'second', contextTokens: 48000 },
    { provider: 'gemini', model: 'third', effort: 'low' },
  ];
  await h.tree.createAgentChild({ spec: spec('lead-1', { preset: { ...spec('').preset, fallbacks } }) });
  assert.deepEqual(h.created[0].sessionProfile.routeFallbacks, fallbacks);
});

test('createAgentChild links the child under its parent with the root owner carried down the chain', async () => {
  const h = createHarness();
  const { session: child } = await h.tree.createAgentChild({ spec: spec('lead-1'), tag: 'r1' });
  const { session: grandchild } = await h.tree.createAgentChild({ spec: spec(child.id) });
  assert.equal(child.id, 'child-1');
  assert.equal(child.owner, 'agent');
  assert.equal(child.visibility, 'agent-only');
  assert.equal(child.ownerSessionId, 'lead-1');
  assert.equal(child.agentTag, 'r1');
  assert.equal(child.presetName, 'fast-review');
  assert.equal(grandchild.parentSessionId, 'child-1');
  assert.equal(grandchild.ownerSessionId, 'lead-1', 'root owner is inherited');
  assert.equal(h.tree.rootOwnerSessionId('child-2'), 'lead-1');
  assert.deepEqual(h.tree.agentDescendantSessionIds('lead-1'), ['child-1', 'child-2']);
  assert.equal(h.created[0].sessionProfile.ownerSessionId, 'lead-1');
  assert.equal(h.created[0].toolMode, 'full');
  assert.equal(h.tree.agentSurface.canRun({ id: 'child-1' }), true);
  assert.equal(h.tree.agentSurface.canRun({ id: 'nope' }), false);
  await assert.rejects(() => h.tree.createAgentChild({ spec: { parentSessionId: 'x', preset: {} } }), /incomplete/);
});

test('runAgentTurn drives the runtime, records the handoff and reports terminal results', async () => {
  const h = createHarness();
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const terminal = [];
  const result = await h.tree.runAgentTurn({
    session,
    prompt: 'review it',
    onTerminalResult: (r) => terminal.push(r),
    onToolResult: () => {},
  });
  assert.equal(result.content, 'echo:review it');
  assert.deepEqual(terminal, [result]);
  assert.equal(h.turns[0].options.mode, 'prompt');
  assert.equal(h.turns[0].options.priority, 'next');
  assert.equal(typeof h.turns[0].options.onToolResult, 'function');
  assert.deepEqual(h.retained, ['agent child idle']);
  const after = h.tree.agentDescriptor(session.id);
  assert.equal(after.status, 'idle');
  assert.equal(after.lastHandoff, 'echo:review it');
  assert.equal(await h.tree.agentManager.readSessionHandoff(session.id), 'echo:review it');

  h.runtimeFor(session.id).reply = async () => ({ status: 'failed', error: 'boom' });
  await assert.rejects(() => h.tree.runAgentTurn({ session, prompt: 'again' }), /boom/);
  assert.equal(h.tree.agentDescriptor(session.id).status, 'error');
  h.runtimeFor(session.id).reply = async () => ({ status: 'cancelled' });
  await assert.rejects(() => h.tree.runAgentTurn({ session, prompt: 'again' }), /cancelled/);
  assert.equal(h.tree.agentDescriptor(session.id).status, 'cancelled');
});

test('runAgentTurn fails a rejected or unknown turn status with its reason, never an empty completion', async () => {
  const h = createHarness();
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const terminal = [];
  h.runtimeFor(session.id).reply = async () => ({ status: 'rejected', reason: 'session-closed', result: null });
  await assert.rejects(
    () => h.tree.runAgentTurn({ session, prompt: 'x', onTerminalResult: (r) => terminal.push(r) }),
    /agent turn rejected: session-closed/
  );
  assert.equal(h.tree.agentDescriptor(session.id).status, 'error');
  h.runtimeFor(session.id).reply = async () => ({ status: 'rejected', result: null, session: null });
  await assert.rejects(() => h.tree.runAgentTurn({ session, prompt: 'x' }), /agent turn rejected/);
  h.runtimeFor(session.id).reply = async () => ({ status: 'mystery' });
  await assert.rejects(() => h.tree.runAgentTurn({ session, prompt: 'x' }), /agent turn mystery/);
  assert.deepEqual(terminal, []);
});

test('a watchdog stop surfaces as its stall error with the turn partial output, not a user cancel', async () => {
  const h = createHarness();
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const runtime = h.runtimeFor(session.id);
  runtime.messages.push({ role: 'assistant', content: 'earlier turn' });
  const aborts = [];
  runtime.abort = (options) => aborts.push(options);
  const watchdog = new AbortController();
  h.tree.agentManager.linkParentSignalToSession(session.id, watchdog.signal);
  const stall = new AgentStallAbortError('agent task stale (315000ms without stream/tool progress)');
  runtime.reply = async () => {
    runtime.messages.push({ role: 'user', content: 'measure' }, { role: 'assistant', content: 'measured half' });
    watchdog.abort(stall);
    return { status: 'cancelled' };
  };
  await assert.rejects(
    () => h.tree.runAgentTurn({ session, prompt: 'measure' }),
    (error) => error === stall && error.partialHandoff === 'measured half'
  );
  assert.deepEqual(aborts, [{ restorePrompt: false, reason: 'agent-watchdog' }]);
  assert.equal(h.tree.agentDescriptor(session.id).status, 'error');
  runtime.reply = async () => ({ status: 'cancelled' });
  await assert.rejects(() => h.tree.runAgentTurn({ session, prompt: 'again' }), /agent session turn cancelled/);
});

test('concurrent cancellation of cyclic parent links settles and closes each runtime once', {
  timeout: 2000,
}, async () => {
  const h = createHarness();
  const { session: first } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const { session: second } = await h.tree.createAgentChild({ spec: spec(first.id) });
  h.tree.linkAgentDescriptor({ ...h.tree.agentDescriptor(first.id), parentSessionId: second.id });
  assert.deepEqual(await Promise.all([h.tree.cancelAgentTree(first.id), h.tree.cancelAgentTree(second.id)]), [
    true,
    true,
  ]);
  assert.deepEqual(h.closed.map(([id]) => id).sort(), [first.id, second.id].sort());
});

test('cancelAgentTree closes runtimes descendants-first and allows same-session follow-ups', async () => {
  const h = createHarness();
  const { session: child } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  await h.tree.createAgentChild({ spec: spec(child.id) });
  assert.equal(await h.tree.cancelAgentDescendants('lead-1', 'parent stopped'), true);
  assert.deepEqual(h.closed, [
    ['child-2', 'parent stopped'],
    ['child-1', 'parent stopped'],
  ]);
  assert.deepEqual(h.closeOptions, [
    ['child-2', { tombstone: false }],
    ['child-1', { tombstone: false }],
  ]);
  assert.equal(h.tree.agentDescriptor('child-1').status, 'cancelled');
  assert.equal(h.tree.agentDescriptor('child-2').closed, false);
  assert.equal(await h.tree.cancelAgentTree('child-1'), true, 'a closed child is already done');
  assert.equal(h.closed.length, 2);
  assert.equal(await h.tree.cancelAgentDescendants('lead-1'), true, 'children still listed');
  assert.equal(await h.tree.cancelAgentDescendants('nobody'), false);
  assert.equal((await h.tree.runAgentTurn({ session: child, prompt: 'x' })).content, 'echo:x');
  assert.deepEqual(
    h.tree.agentManager.listSessions().map((s) => s.id),
    ['child-1', 'child-2']
  );
  assert.deepEqual(
    h.tree.agentManager
      .listSessions({ includeClosed: true })
      .map((s) => s.id)
      .sort(),
    ['child-1', 'child-2']
  );
});

test('a failing descendant does not stop sibling and parent cancellation, and is reported', async () => {
  const h = createHarness();
  const { session: parent } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  const { session: failing } = await h.tree.createAgentChild({ spec: spec(parent.id) });
  const { session: sibling } = await h.tree.createAgentChild({ spec: spec(parent.id) });
  h.runtimeFor(failing.id).closeCanonicalSession = async () => {
    throw new Error('close exploded');
  };
  await assert.rejects(() => h.tree.cancelAgentTree(parent.id, 'stop all'), /^Error: close exploded$/);
  const { session: failing2 } = await h.tree.createAgentChild({ spec: spec(parent.id) });
  h.runtimeFor(failing2.id).closeCanonicalSession = async () => {
    throw new Error('second boom');
  };
  await assert.rejects(
    () => h.tree.cancelAgentTree(parent.id, 'stop all'),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      /close exploded/.test(error.message) &&
      /second boom/.test(error.message)
  );
  assert.deepEqual(h.closed, [
    [sibling.id, 'stop all'],
    [parent.id, 'stop all'],
  ]);
  assert.equal(h.tree.agentDescriptor(parent.id).status, 'cancelled');
  assert.equal(h.tree.agentDescriptor(sibling.id).status, 'cancelled');
});

test('cancellation follows the current runtime after an ordinary session reopen', async () => {
  const h = createHarness();
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  await h.tree.cancelAgentTree(session.id);
  h.runtimeFor(session.id).terminal = false;
  await h.tree.cancelAgentTree(session.id);
  assert.equal(h.closed.length, 2);
});

test('cancellation during transcript loading prevents turn submission', async () => {
  const h = createHarness();
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  h.runtimeFor(session.id).readModelMessages = async () => {
    await h.tree.cancelAgentTree(session.id);
    return { messageCount: 0, messages: [] };
  };
  await assert.rejects(h.tree.runAgentTurn({ session, prompt: 'do not submit' }), /cancelled during admission/);
  assert.equal(h.turns.length, 0);
});

test('a pending child creation cannot escape explicit parent cancellation', async () => {
  let started;
  let release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    beforeCreate: async () => {
      started();
      await gate;
    },
  });
  const creating = h.tree.createAgentChild({ spec: spec('lead-1') });
  await ready;
  await h.tree.cancelAgentDescendants('lead-1');
  release();
  await assert.rejects(creating, /cancelled during admission/);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.closeOptions, [['child-1', { tombstone: false }]], 'the runtime created meanwhile is closed');
  assert.equal(h.tree.agentDescriptor('child-1'), null);
});

test('busy follow-ups are rejected while subtree cancellation is in progress', async () => {
  const h = createHarness({ busyIds: new Set(['child-1']) });
  const { session } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  let started;
  let release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = h.runtimeFor(session.id);
  runtime.closeCanonicalSession = async () => {
    started();
    await gate;
    return true;
  };
  let submitted = false;
  runtime.submitAsync = async () => {
    submitted = true;
    return true;
  };
  const closing = h.tree.cancelAgentTree(session.id);
  await ready;
  await assert.rejects(h.tree.agentSurface.enqueueTurn({ session, prompt: 'late' }), /cancelled during admission/);
  assert.equal(submitted, false);
  release();
  await closing;
});

test('rehydration rebuilds children from stored rows, resolving roots through the parent chain', async () => {
  const h = createHarness({
    rows: [
      { id: 'a', parentSessionId: 'lead', visibility: 'agent-only', agent: 'worker', messageCount: 4 },
      { id: 'b', parentSessionId: 'a', owner: 'agent', messages: [{ role: 'assistant', content: 'done b' }] },
      { id: 'c', parentSessionId: 'zzz', owner: 'agent', closed: true },
      { id: 'user-chat', owner: 'user' },
      { id: 'bad id!', parentSessionId: 'lead', owner: 'agent' },
    ],
  });
  h.tree.linkAgentDescriptor({ id: 'a', parentSessionId: 'other-lead', agent: 'live' });
  assert.equal(await h.tree.rehydrateAgentSessions(), 3);
  assert.equal(h.tree.agentDescriptor('a').agent, 'live', 'a live link is never rolled back');
  const b = h.tree.agentDescriptor('b');
  assert.equal(b.ownerSessionId, 'lead', 'root resolved through the STORED parent chain, not the live link');
  assert.equal(b.lastHandoff, 'done b');
  assert.equal(b.agent, 'worker');
  assert.equal(h.tree.agentDescriptor('c').status, 'closed');
  assert.equal(h.tree.hasAgentSession('user-chat'), false);
  assert.equal(h.tree.hasAgentSession('bad id!'), false);
  assert.equal(await h.tree.rehydrateAgentSessions(), 3, 'idempotent');
});

test('descriptor status reflects the live runtime and handoff falls back to the stored transcript', async () => {
  const stored = {
    w: () => ({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'stored answer' },
      ],
    }),
  };
  const h = createHarness({ busyIds: new Set(['w']), stored });
  h.tree.linkAgentDescriptor({ id: 'w', parentSessionId: 'lead', messageCount: 2 });
  assert.equal(h.tree.agentDescriptor('w').status, 'idle', 'no runtime yet');
  h.runtimeFor('w');
  assert.equal(h.tree.agentDescriptor('w').status, 'running');
  assert.equal(h.tree.agentDescriptor('w').messageCount, 3);
  assert.deepEqual(h.tree.agentManager.getSessionRuntime('w'), { stage: 'running' });
  assert.equal(await h.tree.agentManager.readSessionHandoff('w'), 'stored answer');
  assert.equal(h.tree.agentDescriptor('w').lastHandoff, 'stored answer', 'cached after the read');
  assert.equal(await h.tree.agentManager.readSessionHandoff('missing'), '');
});

test('stored handoffs preserve explicit text and otherwise select the last nonempty assistant output', () => {
  const messages = Object.freeze([
    { role: 'assistant', content: 'old answer' },
    { role: 'assistant', content: '  latest answer  ' },
    { role: 'assistant', content: ' \n ' },
    { role: 'assistant', content: null },
    { role: 'user', content: 'new question' },
    null,
  ]);
  assert.equal(lastStoredAgentHandoff({ messages }), '  latest answer  ');
  assert.equal(lastStoredAgentHandoff({ lastHandoff: '', messages }), '');
  assert.equal(lastStoredAgentHandoff({ lastHandoff: 'explicit', messages }), 'explicit');
  assert.equal(
    lastStoredAgentHandoff({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'structured' }] }],
    }),
    '[{"type":"text","text":"structured"}]'
  );
  assert.equal(lastStoredAgentHandoff({ messages: new Array(3) }), '');
  assert.equal(
    lastStoredAgentHandoff({
      messages: [
        { role: 'assistant', content: false },
        { role: 'assistant', content: 0 },
      ],
    }),
    ''
  );
  assert.equal(lastStoredAgentHandoff({ messages: 'invalid' }), '');
  assert.equal(lastStoredAgentHandoff(null), '');
});
