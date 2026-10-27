// A bot-descended turn that launches background work keeps its place in the
// bot-to-bot chain: the completion notification resumes (or joins) a turn at the
// hop of the turn that launched it, whichever route delivers it, so a loop that
// passes through a background completion every round still reaches MAX_BOT_HOPS.
// A human message still resets it. The resume runs the real askSession.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('bot-hop-bg');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { createAskSteeringDrain } = await import('./ask-turn-steering-drain.mjs');
const { enqueuePendingMessage, markCompletionEntry } = await import('./pending-messages.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { createSteeringDrain } = await import('../loop/steering.mjs');
const { prepareToolCall } = await import('../loop/tool-exec/call-prep.mjs');
const { notifyToolCompletion } = await import('../../../../../runtime/shared/tool-execution-contract.mjs');
const { createJobStarter } = await import(
  '../../../../../session-runtime/services/agent-tool/spawn-flow/job-start.mjs'
);
const { createSessionControl } = await import('../../../../../standalone/daemon-session-control.mjs');
const { createAgentTaskSessions } = await import('../../../../../session-runtime/agent-task-sessions.mjs');

const LIMIT = /Bot-to-bot chain limit reached; ask the user before continuing\./;
const COMPLETION = [
  'Async shell task job_bg (completed, exit 0) finished.',
  '',
  'Result:',
  '> [task_id: job_bg]',
  '> [status: completed]',
].join('\n');

/** A `session send` from agent `agentId` made in a turn at `hop`. */
function sendFrom(agentId, hop, to) {
  const service = {
    materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
    submitSession: async () => ({ accepted: true }),
  };
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: async () => {},
    watches: { add: async () => {}, list: async () => [], remove: async () => {} },
    loadSession: async () => null,
    agentName: async (id) => `Name ${id}`,
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  return createSessionControl({ getSessionService: () => service, agentTasks })(
    { action: 'send', session_id: `sess_home_${to}`, prompt: 'ping' },
    { callerSessionId: `sess_home_${agentId}`, callerAgentId: agentId, callerHop: hop }
  );
}

/** A live session on a provider that answers every turn. */
async function withBotSession(t, run) {
  const providerName = `bot-hop-bg-${Math.random().toString(36).slice(2)}`;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send() {
      return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
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
    await run(session.id);
  });
}

const ask = (id, prompt, askOpts) => askSession(id, prompt, null, null, null, null, askOpts);
const turnHop = async (id) => (await loadSession(id)).turnHop ?? 0;

// The turn at `hop` launches a background command whose notify callback declines
// (so the completion takes the shell fallback queue), then the completion wakes
// the session through the real idle-resume ask; returns the hop of the turn it ran.
async function launchAndResume(id, n) {
  const prepared = prepareToolCall('shell', {}, root, id, await loadSession(id), {});
  const delivered = notifyToolCompletion({
    surface: 'shell',
    id: `job_bg_${n}`,
    status: 'completed',
    text: COMPLETION,
    resultType: 'shell_task_result',
    context: { ...prepared.completionToolOpts, notifyFn: () => false },
    enqueueFallback: (sessionId, message, meta) =>
      enqueuePendingMessage(sessionId, markCompletionEntry(message, { executionId: meta.execution_id, meta })),
  });
  assert.equal(delivered, true);
  await ask(id, '', { promptSource: 'task-notification' });
  return turnHop(id);
}

test('a bot loop that passes through a background completion each round reaches the chain limit', async (t) => {
  await withBotSession(t, async (id) => {
    // B's message at hop 1 starts A's turn; its background command finishes; A answers B.
    await ask(id, 'from b', { transcriptMeta: { sender: 'lead', fromAgent: 'b', hop: 1 } });
    assert.equal(await launchAndResume(id, 1), 1, "the completion resumes the launching turn's hop");
    const toB = await sendFrom('a', 1, 'b');
    assert.equal(toB.hop, 2);
    const toA = await sendFrom('b', toB.hop, 'a');
    assert.equal(toA.hop, 3);
    // The next round is still bot-descended: A's answer goes out past the limit.
    await ask(id, 'from b again', { transcriptMeta: { sender: 'lead', fromAgent: 'b', hop: toA.hop } });
    const hop = await launchAndResume(id, 2);
    assert.equal(hop, 3);
    await assert.rejects(sendFrom('a', hop, 'b'), LIMIT);
  });
});

test('background work no bot started carries no hop, and a human message resets one', async (t) => {
  await withBotSession(t, async (id) => {
    await ask(id, 'typed by the user', { transcriptMeta: { device: 'PC' } });
    assert.equal(await launchAndResume(id, 3), 0, 'independent work resumes at 0');
    await ask(id, 'from b', { transcriptMeta: { sender: 'lead', fromAgent: 'b', hop: 3 } });
    assert.equal(await turnHop(id), 3);
    await ask(id, 'typed by the user', { transcriptMeta: { device: 'PC' } });
    assert.equal(await turnHop(id), 0, 'a human message resets the hop');
    assert.equal((await sendFrom('a', 0, 'b')).hop, 1);
  });
});

test('completions of different hops joining a running turn keep the highest', async (t) => {
  await withBotSession(t, async (id) => {
    const session = { id, turnHop: 0, messages: [] };
    for (const hops of [
      [1, 3],
      [3, 1],
    ]) {
      session.turnHop = 0;
      for (const hop of hops) {
        enqueuePendingMessage(
          id,
          markCompletionEntry(`${COMPLETION} ${hop}`, { executionId: `job_mix_${hop}`, meta: { hop } })
        );
      }
      const drain = createSteeringDrain({
        messages: [],
        opts: {
          session,
          drainSteering: createAskSteeringDrain({ sessionId: id, turn: { pendingEntries: [] }, askOpts: {} }),
          onSteerMessage() {},
        },
        sessionId: id,
        onSkillPrompt() {},
      });
      assert.equal(drain('terminal'), true);
      assert.equal(session.turnHop, 3, `hops ${hops} join at the highest`);
    }
  });
});

test("an agent task's completion returns at the hop of the turn that started it", async () => {
  const completions = [];
  const startJob = createJobStarter({
    mgr: {},
    notifyStatusChange() {},
    notifySessionCompletion: (sessionId, text, meta) => {
      completions.push({ sessionId, meta });
      return true;
    },
  });
  const task = startJob('spawn', { tag: 'bg' }, async () => ({ content: 'done' }), {
    callerSessionId: 'sess_home_a',
    hop: 2,
  });
  const deadline = Date.now() + 5000;
  while (!completions.some((entry) => entry.meta.execution_id === task.taskId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completion = completions.find((entry) => entry.meta.execution_id === task.taskId);
  assert.ok(completion, 'the owner was notified');
  assert.equal(completion.sessionId, 'sess_home_a');
  assert.equal(completion.meta.hop, 2);
});
