import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTree } from './agent-tree.mjs';
import { lastStoredAgentHandoff } from './agent-tree/agent-rehydrate.mjs';
import { AgentStallAbortError } from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

// The Agent child catalog against fake session-service hooks: how children
// are linked and rooted, what a turn does to a descriptor, how cancellation
// cascades, and what rehydration rebuilds from stored rows.

function createHarness({ rows = [], stored = {}, busyIds = new Set() } = {}) {
  const created = [];
  const turns = [];
  const closed = [];
  const retained = [];
  const logs = [];
  let nextId = 1;
  const runtimes = new Map();
  const runtimeFor = (id) => {
    if (!runtimes.has(id)) {
      runtimes.set(id, {
        messages: [],
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
        async closeCanonicalSession(reason) {
          closed.push([id, reason]);
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
      const sessionId = `child-${nextId++}`;
      created.push({ sessionId, ...input });
      return { sessionId };
    },
  });
  return { tree, created, turns, closed, retained, logs, runtimeFor };
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

test('cancelAgentTree closes descendants first and marks every descriptor closed', async () => {
  const h = createHarness();
  const { session: child } = await h.tree.createAgentChild({ spec: spec('lead-1') });
  await h.tree.createAgentChild({ spec: spec(child.id) });
  assert.equal(await h.tree.cancelAgentDescendants('lead-1', 'parent stopped'), true);
  assert.deepEqual(h.closed, [
    ['child-2', 'parent stopped'],
    ['child-1', 'parent stopped'],
  ]);
  assert.equal(h.tree.agentDescriptor('child-1').status, 'closed');
  assert.equal(h.tree.agentDescriptor('child-2').closed, true);
  assert.equal(await h.tree.cancelAgentTree('child-1'), true, 'a closed child is already done');
  assert.equal(h.closed.length, 2);
  assert.equal(await h.tree.cancelAgentDescendants('lead-1'), true, 'children still listed');
  assert.equal(await h.tree.cancelAgentDescendants('nobody'), false);
  await assert.rejects(() => h.tree.runAgentTurn({ session: child, prompt: 'x' }), /is closed/);
  assert.deepEqual(
    h.tree.agentManager.listSessions().map((s) => s.id),
    []
  );
  assert.deepEqual(
    h.tree.agentManager
      .listSessions({ includeClosed: true })
      .map((s) => s.id)
      .sort(),
    ['child-1', 'child-2']
  );
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
