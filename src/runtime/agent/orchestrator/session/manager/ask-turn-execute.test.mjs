import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const events = [];
const buildCalls = [];
let mockHistory = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const provider = {
  config: {},
  customConfig: { protocol: 'openai-chat' },
  getCachedModelInfo: (id) => ({
    id,
    reasoningLevels: ['low', 'medium', 'high'],
    customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' }, replay: false },
  }),
};
const JUDGE_MS = 10;
const BUILD_MS = 10;

mock.module('../../providers/registry.mjs', {
  namedExports: { ...(await import('../../providers/registry.mjs')), getProvider: () => provider },
});
mock.module('./ask-turn-auto-effort.mjs', {
  namedExports: {
    ...(await import('./ask-turn-auto-effort.mjs')),
    resolveTurnAutoEffort: async () => {
      events.push('judge:start');
      await sleep(JUDGE_MS);
      events.push('judge:end');
      return { effort: 'high', applied: true, mode: 'on', request: 'go', base: 'medium' };
    },
  },
});
mock.module('./ask-turn-prepare.mjs', {
  namedExports: {
    ...(await import('./ask-turn-prepare.mjs')),
    applyTurnContextMeta: () => {},
    traceTurnContext: () => {},
    startProviderPrewarm: (args) => {
      events.push(`prewarm:${args.turnEffort}`);
      return null;
    },
    buildUserTurn: async (args) => {
      buildCalls.push(args);
      events.push('build:start');
      await sleep(BUILD_MS);
      events.push('build:end');
      const userTurnMessage = {
        role: 'user',
        content: 'go',
        meta: { runtimeUserContext: { prefix: '', suffix: 'x' } },
      };
      const historyMessages = mockHistory.slice();
      return {
        historyMessages,
        outgoing: [...historyMessages, userTurnMessage],
        userTurnMessage,
        explicitPrefetchResult: '',
      };
    },
  },
});
mock.module('../store.mjs', {
  namedExports: { ...(await import('../store.mjs')), saveSessionAsync: async () => {} },
});

const { prepareAskTurn } = await import('./ask-turn-execute.mjs');

function turnFor(session) {
  return {
    turn: { session },
    runtime: {},
    turnSignal: new AbortController().signal,
    askGeneration: 1,
    checkpoint: { schedule() {} },
    turnToken: 't',
    startedAt: Date.now(),
    codexTurnId: null,
  };
}

test('the first human prompt names a titleless session; manual, generated and later prompts never overwrite', async () => {
  const fresh = () => ({
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    messages: [],
    cwd: process.cwd(),
    sessionStartMetaInjected: true,
  });
  const session = fresh();
  await prepareAskTurn({ sessionId: 's2', opened: turnFor(session), input: { prompt: '  Fix the\nlogin bug ' } });
  assert.equal(session.title, 'Fix the login bug');
  assert.equal(session.generatedTitleStage, undefined);
  assert.equal(session.titleLocked, undefined);
  await prepareAskTurn({ sessionId: 's2', opened: turnFor(session), input: { prompt: 'another request' } });
  assert.equal(session.title, 'Fix the login bug');

  const manual = { ...fresh(), title: 'Mine', titleLocked: true, titleSource: 'user' };
  await prepareAskTurn({ sessionId: 's3', opened: turnFor(manual), input: { prompt: 'something' } });
  assert.equal(manual.title, 'Mine');

  const generated = { ...fresh(), title: 'Generated', generatedTitleStage: 'first' };
  await prepareAskTurn({ sessionId: 's4', opened: turnFor(generated), input: { prompt: 'something' } });
  assert.equal(generated.title, 'Generated');

  const injected = fresh();
  await prepareAskTurn({
    sessionId: 's5',
    opened: turnFor(injected),
    input: { prompt: 'task finished', promptSource: 'task-notification' },
  });
  assert.equal(injected.title, undefined);
});

test('an existing titleless session is named from its earliest human history, not the current prompt', async () => {
  mockHistory = [
    { role: 'user', content: 'Continue the goal', meta: { source: 'goal-continuation', synthetic: true } },
    { role: 'user', content: 'Original request about caching' },
    { role: 'assistant', content: 'working on it' },
  ];
  try {
    const session = {
      provider: 'custom-a',
      model: 'm',
      effort: 'medium',
      messages: mockHistory.slice(),
      cwd: process.cwd(),
      sessionStartMetaInjected: true,
    };
    await prepareAskTurn({ sessionId: 's6', opened: turnFor(session), input: { prompt: 'a later question' } });
    assert.equal(session.title, 'Original request about caching');

    // With no human history, the current prompt is still the fallback.
    mockHistory = [{ role: 'user', content: 'Continue', meta: { source: 'goal-continuation' } }];
    const fresh = { ...session, title: undefined, messages: [] };
    await prepareAskTurn({ sessionId: 's7', opened: turnFor(fresh), input: { prompt: 'a later question' } });
    assert.equal(fresh.title, 'a later question');
  } finally {
    mockHistory = [];
  }
});

test('turn start overlaps the judgment with buildUserTurn and still stamps the first request with it', async () => {
  events.length = 0;
  const session = {
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    messages: [],
    cwd: process.cwd(),
    sessionStartMetaInjected: true,
  };
  const opened = {
    turn: { session },
    runtime: {},
    turnSignal: new AbortController().signal,
    askGeneration: 1,
    checkpoint: { schedule() {} },
    turnToken: 't1',
    startedAt: Date.now(),
    codexTurnId: null,
  };
  const prepared = await prepareAskTurn({ sessionId: 's1', opened, input: { prompt: 'go' }, transcriptMeta: null });

  assert.deepEqual(events.slice(0, 3), ['judge:start', 'prewarm:medium', 'build:start']);
  assert.ok(events.indexOf('build:start') < events.indexOf('judge:end'), 'build began before the judgment finished');
  assert.equal(prepared.turnEffort, 'high');
  assert.equal(prepared.effortConfiguration.effort, 'high');
  const message = prepared.outgoing[0];
  assert.equal(message.meta.effortConfiguration.effort, 'high');
  assert.deepEqual(Object.keys(message.meta), ['effortConfiguration', 'runtimeUserContext']);
});

test('the built turn carries its prompt origin and retry provenance; the pre-commit checkpoints before provider work', async () => {
  const session = {
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    messages: [],
    cwd: process.cwd(),
    sessionStartMetaInjected: true,
  };
  const scheduled = [];
  const opened = { ...turnFor(session), checkpoint: { schedule: (flag) => scheduled.push(flag) }, turnToken: 'tk' };
  buildCalls.length = 0;
  const prepared = await prepareAskTurn({
    sessionId: 's8',
    opened,
    input: {
      prompt: 'go',
      promptSource: { source: 'task-notification' },
      promptOrigin: 'channel',
      retryProvenance: { source: 'agent-report' },
    },
  });
  assert.deepEqual(buildCalls.at(-1).turnPromptSource, {
    source: 'task-notification',
    origin: 'channel',
    provenance: { source: 'agent-report' },
  });
  await prepareAskTurn({ sessionId: 's8', opened, input: { prompt: 'go', promptSource: 'task-notification' } });
  assert.equal(buildCalls.at(-1).turnPromptSource, 'task-notification', 'no origin: the source passes as is');
  assert.deepEqual(scheduled, [true, true]);
  assert.deepEqual(session.activeTurnCheckpoint, { version: 1, turnToken: 'tk', startedAt: opened.startedAt });
  assert.equal(session.liveTurnMessages.length, 1);
  assert.equal(prepared.beforeCount, 1);
  assert.equal(session.messages.at(-1).content, 'go');
});

test('a turn carries its starting hop, a steered bot message raises it, a hopless notification turn starts at 0', async () => {
  const { createSteeringDrain } = await import('../loop/steering.mjs');
  const { createSessionControl } = await import('../../../../../standalone/daemon-session-control.mjs');
  const { createWorkspaceToolHandlers } = await import(
    '../../../../../session-runtime/internal-tool-executor/workspace-tools.mjs'
  );
  const session = {
    id: 'sess_home_a',
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    messages: [],
    cwd: process.cwd(),
    sessionStartMetaInjected: true,
  };
  const start = (input, transcriptMeta) =>
    prepareAskTurn({
      sessionId: session.id,
      opened: turnFor(session),
      input: { prompt: 'go', ...input },
      transcriptMeta,
    });
  await start({}, { sender: 'lead', fromAgent: 'b', hop: 1 });
  assert.equal(session.turnHop, 1, 'the starting submission sets the turn hop');

  // A bot message at hop 3 is steered into the running turn (the live working array, not session.messages).
  const live = session.liveTurnMessages;
  const drain = createSteeringDrain({
    messages: live,
    opts: {
      session,
      drainSteering: () => [{ content: 'from c', transcriptMeta: { sender: 'lead', fromAgent: 'c', hop: 3 } }],
      onSteerMessage() {},
    },
    sessionId: session.id,
    onSkillPrompt() {},
  });
  assert.equal(drain(), true);
  assert.equal(session.turnHop, 3);
  assert.ok(
    live.some((message) => message.meta?.transcript?.hop === 3),
    'it landed in the live array'
  );

  // A `session send` made in that turn goes out at hop 4: refused.
  const context = [];
  const tool = createWorkspaceToolHandlers({
    rt: { session, config: {} },
    executeSessionControl: async (args, ctx) => {
      context.push(ctx.callerHop);
      return createSessionControl({
        getSessionService: () => ({}),
        agentTasks: { reportOrigin: async () => ({ agentId: 'a', target: 'session' }), send: async () => ({}) },
      })(args, { ...ctx, callerAgentId: 'a' });
    },
  }).session;
  await assert.rejects(
    tool(
      { action: 'send', session_id: 'sess_home_b', prompt: 'x' },
      { callerCtx: { callerSessionId: session.id }, callerCwd: process.cwd() }
    ),
    /Bot-to-bot chain limit reached/
  );
  assert.deepEqual(context, [3]);

  // A hopless notification turn is not a bot message: it starts at 0, as a user turn does.
  await start({ promptSource: 'task-notification' }, null);
  assert.equal(session.turnHop, 0);
  await start({}, { sender: 'lead', fromAgent: 'b', hop: 2 });
  assert.equal(session.turnHop, 2);
  await start({}, { device: 'PC' });
  assert.equal(session.turnHop, 0);
});
