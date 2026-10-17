import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

// The background follow-up ask that runs input a cross-process hydration
// surfaced after the ask returned. Hydration is mocked so its completion can
// be placed after the turn; everything else is the real ask pipeline.
// Run through scripts/test-direct.mjs (module mocks).

const root = mkdtempSync(join(tmpdir(), 'mixdog-ask-followup-'));
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
