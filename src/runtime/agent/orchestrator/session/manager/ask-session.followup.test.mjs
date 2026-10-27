import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
// The background follow-up ask that runs input a cross-process hydration
// surfaced after the ask returned. Hydration is mocked so its completion can
// be placed after the turn; everything else is the real ask pipeline.
// Run through scripts/test-direct.mjs (module mocks).

const root = makeTempDirSync('ask-followup');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });

let hydrate = async () => 0;
mock.module('./pending-messages.mjs', {
  namedExports: {
    ...(await import('./pending-messages.mjs')),
    hydratePendingMessages: (sessionId) => hydrate(sessionId),
  },
});

const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession, loadSession, saveSessionAsync } = await import('../store.mjs');
const { enqueuePendingMessage } = await import('./pending-messages.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

// The agents enabled now, as the session runtime resolves them (turn-run.mjs
// passes its resolver): asked again for every user turn the ask prepares.
const WORKER = { id: 'worker', name: 'Worker', line: '- Worker (worker)' };
const ANNOUNCED = /# Available Agents Changed[\s\S]*- Worker \(worker\)/;

test('a queued turn and the background follow-up are told of an agent enabled meanwhile', async (t) => {
  const providerName = 'ask-session-agents-now-test';
  const sends = [];
  let agents = [];
  let onSend = () => {};
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      sends.push(String(messages.at(-1).content));
      onSend();
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
    const askOpts = { agentsNow: () => agents };

    // Two queued turns of one ask (task notifications run one each); Worker
    // is enabled while the first runs.
    enqueuePendingMessage(session.id, { content: 'first note', mode: 'task-notification' });
    enqueuePendingMessage(session.id, { content: 'second note', mode: 'task-notification' });
    onSend = () => {
      onSend = () => {};
      agents = [WORKER];
    };
    await askSession(session.id, '', null, null, null, null, askOpts);
    assert.equal(sends.length, 2, 'both queued turns ran in the same ask');
    assert.match(sends[0], /first note/);
    assert.doesNotMatch(sends[0], ANNOUNCED);
    assert.match(sends[1], /second note/);
    assert.match(sends[1], ANNOUNCED, 'the queued turn is told');

    // The background follow-up ask of another conversation: Worker switched
    // off after its ask returned, before the follow-up runs.
    const other = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(other.id, { deferSummaryUpdate: true }));
    let landHydration;
    let hydrateCalls = 0;
    hydrate = async (sessionId) => {
      if (sessionId !== other.id) return 0;
      hydrateCalls += 1;
      if (hydrateCalls !== 2) return 0;
      return await new Promise((resolve) => {
        landHydration = resolve;
      });
    };
    t.after(() => {
      hydrate = async () => 0;
    });
    sends.length = 0;
    await askSession(other.id, 'hello', null, null, null, null, askOpts);
    assert.match(sends[0], ANNOUNCED, 'Worker was enabled when the ask ran');
    assert.ok(await waitFor(() => typeof landHydration === 'function'), 'the post-turn hydration started');
    agents = [];
    enqueuePendingMessage(other.id, 'queued after return');
    landHydration(1);
    assert.ok(await waitFor(() => sends.length === 2), 'the follow-up ask ran');
    assert.match(sends[1], /queued after return/);
    assert.match(sends[1], /no longer available[^\n]*\n- Worker \(worker\)/, 'the follow-up is told');
    // The follow-up ask has settled (its own post-turn hydration ran) before
    // the next test counts hydrations.
    assert.ok(await waitFor(() => hydrateCalls >= 4), 'the follow-up ask settled');
  });
});

test('hydration that completes after a retained-input retry runs the queued message', async (t) => {
  const providerName = 'ask-session-followup-test';
  const sends = [];
  const reply = async (messages) => ({
    content: `answered ${String(messages.at(-1).content)}`,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages, model, _tools, sendOpts) {
      sends.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return reply(messages, sendOpts);
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

    // The retained input a failed turn left behind.
    const live = loadSession(session.id);
    live.messages = [
      ...live.messages,
      {
        role: 'user',
        content: 'retry me',
        meta: { transcript: { messageId: 'failed-input', completion: { status: 'failed', attemptId: 'attempt-1' } } },
      },
    ];
    await saveSessionAsync(live);

    // The post-turn hydration of the retry resolves only after the retry
    // returned, with one cross-process message landed.
    let landHydration;
    let hydrateCalls = 0;
    hydrate = async () => {
      hydrateCalls += 1;
      if (hydrateCalls !== 2) return 0;
      return await new Promise((resolve) => {
        landHydration = resolve;
      });
    };
    const followUpErrors = [];
    const stderrWrite = process.stderr.write;
    process.stderr.write = function (chunk, ...rest) {
      if (String(chunk).includes('follow-up ask failed')) followUpErrors.push(String(chunk));
      return stderrWrite.call(this, chunk, ...rest);
    };
    t.after(() => {
      process.stderr.write = stderrWrite;
    });

    const result = await askSession(session.id, 'retry me', null, null, null, null, {
      retryTurnId: 'failed-input',
      retryAttemptId: 'attempt-1',
    });
    assert.match(result.content, /^answered /);
    assert.equal(sends.length, 1);

    assert.ok(await waitFor(() => typeof landHydration === 'function'), 'the post-turn hydration started');
    enqueuePendingMessage(session.id, 'queued after retry');
    landHydration(1);

    assert.ok(
      await waitFor(() =>
        /^answered .*queued after retry/s.test(String(loadSession(session.id).messages.at(-1)?.content))
      ),
      'the follow-up ask ran the queued message'
    );
    assert.equal(sends.length, 2);
    assert.match(String(sends[1].at(-1).content), /queued after retry/);
    assert.deepEqual(followUpErrors, []);
  });
});

for (const [name, announcedBefore, agentsAtRetry, expected] of [
  ['enabled', [], [WORKER], ANNOUNCED],
  ['disabled', [WORKER], [], /no longer available[^\n]*\n- Worker \(worker\)/],
]) {
  test(`a retained failed turn retried after an agent was ${name} carries the notice once, and the next turn does not repeat it`, async (t) => {
    const providerName = `ask-session-retry-agents-${name}-test`;
    const sends = [];
    const provider = {
      name: providerName,
      contextWindow: 128000,
      async send(messages) {
        sends.push(String(messages.at(-1).content));
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
      let agents = announcedBefore;
      const askOpts = (extra) => ({ agentsNow: () => agents, ...extra });

      // The conversation was told `announcedBefore`; the next turn fails.
      await askSession(session.id, 'hello', null, null, null, null, askOpts());
      assert.equal(/# Available Agents Changed/.test(sends.at(-1)), announcedBefore.length > 0);
      const live = loadSession(session.id);
      live.messages = [
        ...live.messages,
        {
          role: 'user',
          content: 'retry me',
          meta: { transcript: { messageId: 'failed-input', completion: { status: 'failed', attemptId: 'attempt-1' } } },
        },
      ];
      await saveSessionAsync(live);

      // The agent changes between the failure and the retry.
      agents = agentsAtRetry;
      sends.length = 0;
      await askSession(
        session.id,
        'retry me',
        null,
        null,
        null,
        null,
        askOpts({
          retryTurnId: 'failed-input',
          retryAttemptId: 'attempt-1',
        })
      );
      assert.equal(sends.length, 1);
      assert.match(sends[0], expected, 'the retry is told');
      assert.equal(sends[0].match(/# Available Agents Changed/g).length, 1, 'once');
      assert.equal(sends[0].match(/retry me/g).length, 1, 'the input is not duplicated');

      await askSession(session.id, 'next', null, null, null, null, askOpts());
      assert.match(sends[1], /next/);
      assert.doesNotMatch(sends[1], /# Available Agents Changed/, 'the next turn does not repeat it');
    });
  });
}
