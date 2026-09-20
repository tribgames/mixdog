import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// One real askSession turn against a fake provider: what the caller gets
// back, what lands in the stored transcript, how queued follow-ups, provider
// failures and aborts settle, and that the per-session lock is released.

// MIXDOG_DATA_DIR stays pinned to this temp root for the whole process: the
// store resolves the data dir at WRITE time and its writes are deferred
// (summary-index flush on setImmediate, worker saves, the exit drain), so
// restoring the env per test would land those late writes in the real data
// dir. node --test runs this file in its own process, so nothing to restore.
const root = mkdtempSync(join(tmpdir(), 'mixdog-ask-session-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { enqueuePendingMessage } = await import('./pending-messages.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { SessionClosedError } = await import('./session-errors.mjs');
const { modelToolSchemaAllowlist } = await import('../../../../../session-runtime/tool-profile.mjs');
// Registered after the store's own 'exit' drain so the directories that
// drain recreates are removed as well.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function withAskHarness(t, run) {
  const sessions = [];
  t.after(() => {
    for (const id of sessions) deleteSession(id, { deferSummaryUpdate: true });
  });
  const providerName = 'ask-session-turn-test';
  const sends = [];
  let reply = async () => ({ content: 'answer', usage: { inputTokens: 10, outputTokens: 5 } });
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages, model, tools, sendOpts) {
      sends.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), model, sendOpts });
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
    sessions.push(session.id);
    await run({
      session,
      askSession,
      loadSession,
      enqueuePendingMessage,
      SessionClosedError,
      sends,
      setReply: (fn) => {
        reply = fn;
      },
    });
  });
}

test('a turn returns the provider answer and commits user + assistant messages with usage totals', async (t) => {
  await withAskHarness(t, async ({ session, askSession, loadSession, sends }) => {
    const starts = [];
    const terminal = [];
    const result = await askSession(session.id, 'hello there', null, null, null, null, {
      onSessionStart: (detail) => starts.push(detail),
      onTerminalResult: (preview, detail) => terminal.push({ preview, detail }),
    });
    assert.equal(result.content, 'answer');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].model, 'fake-model');
    const lastUser = [...sends[0].messages].reverse().find((m) => m.role === 'user');
    assert.match(String(lastUser.content), /hello there/);
    assert.deepEqual(
      starts.map((s) => s.sessionId),
      [session.id]
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].detail.beforeSave, true);
    assert.equal(terminal[0].preview.content, 'answer');
    const stored = loadSession(session.id);
    const tail = stored.messages.slice(-2);
    assert.equal(tail[0].role, 'user');
    assert.match(String(tail[0].content), /hello there/);
    assert.equal(tail[1].role, 'assistant');
    assert.equal(tail[1].content, 'answer');
    assert.equal(stored.totalInputTokens, 10);
    assert.equal(stored.totalOutputTokens, 5);
  });
});

test('a message queued while the turn runs becomes the next turn and its result is returned', async (t) => {
  await withAskHarness(t, async ({ session, askSession, loadSession, enqueuePendingMessage, sends, setReply }) => {
    setReply(async (messages) => {
      if (sends.length === 1) enqueuePendingMessage(session.id, 'and then this');
      const user = [...messages].reverse().find((m) => m.role === 'user');
      return { content: `reply to ${String(user.content).slice(0, 12)}`, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const result = await askSession(session.id, 'first prompt', null, null, null, null, {});
    assert.equal(sends.length, 2);
    const secondUser = [...sends[1].messages].reverse().find((m) => m.role === 'user');
    assert.match(String(secondUser.content), /and then this/);
    assert.match(result.content, /^reply to /);
    const stored = loadSession(session.id);
    const assistants = stored.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 2);
    const users = stored.messages.filter((m) => m.role === 'user');
    assert.match(String(users.at(-1).content), /and then this/);
  });
});

test('a provider failure rejects, keeps the session usable, and an abort surfaces as a closed-session error', async (t) => {
  await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, sends, setReply }) => {
    // A 400 is terminal for the loop's retry classifier: no transport retries.
    setReply(async () => {
      throw Object.assign(new Error('provider exploded'), { httpStatus: 400 });
    });
    await assert.rejects(askSession(session.id, 'will fail', null, null, null, null, {}), /provider exploded/);
    assert.notEqual(loadSession(session.id).closed, true);

    const controller = new AbortController();
    setReply(
      (_messages, sendOpts) =>
        new Promise((_, reject) => {
          controller.abort(new Error('user stop'));
          sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    await assert.rejects(
      askSession(session.id, 'will abort', null, null, null, null, { signal: controller.signal }),
      (err) => err instanceof SessionClosedError
    );

    // The lock was released both times: a plain turn still completes.
    setReply(async () => ({ content: 'recovered', usage: { inputTokens: 1, outputTokens: 1 } }));
    const result = await askSession(session.id, 'after failures', null, null, null, null, {});
    assert.equal(result.content, 'recovered');
    assert.equal(sends.length, 3);
  });
});
