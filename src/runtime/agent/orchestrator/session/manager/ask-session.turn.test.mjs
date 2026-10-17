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
const { renderShellCompletionEnvelope } = await import('../../../../shared/task-notification-envelope.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { SessionClosedError } = await import('./session-errors.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
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
    async send(messages, model, _tools, sendOpts) {
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

test('reasoning usage persists once per call and missing usage marks the reported subtotal incomplete', async (t) => {
  await withAskHarness(t, async ({ session, askSession, loadSession, setReply }) => {
    setReply(async () => ({
      content: 'measured',
      usage: { inputTokens: 10, outputTokens: 8, raw: { output_tokens_details: { reasoning_tokens: 5 } } },
    }));
    await askSession(session.id, 'first', null, null, null, null, {});
    assert.deepEqual(loadSession(session.id).reasoningUsage, {
      reasoningTokens: 5,
      reasoningTokensComplete: true,
    });
    setReply(async () => ({ content: 'no usage supplied' }));
    await askSession(session.id, 'second', null, null, null, null, {});
    assert.deepEqual(loadSession(session.id).reasoningUsage, {
      reasoningTokens: 5,
      reasoningTokensComplete: false,
    });
    setReply(async () => ({
      content: 'measured again',
      usage: { inputTokens: 10, outputTokens: 6, raw: { thoughtsTokenCount: 2 } },
    }));
    await askSession(session.id, 'third', null, null, null, null, {});
    assert.deepEqual(loadSession(session.id).reasoningUsage, {
      reasoningTokens: 7,
      reasoningTokensComplete: false,
    });
    assert.equal(loadSession(session.id).totalOutputTokens, 14);
  });
});

test('a delivered task notification survives turn commit and the next provider request', async (t) => {
  await withAskHarness(t, async ({ session, askSession, loadSession, sends }) => {
    const notification = renderShellCompletionEnvelope({
      jobId: 'task_history',
      status: 'completed',
      exitCode: 0,
      summary: 'The background check passed.',
    });
    const pending = [{ mode: 'task-notification', content: notification }];

    await askSession(session.id, 'Check the background result.', null, null, null, null, {
      drainSteering: () => pending.splice(0),
    });
    const sentHistory = structuredClone(sends.at(-1).messages);
    assert.ok(sentHistory.some((message) => message.content === notification));
    const stored = loadSession(session.id);
    const storedNotification = stored.messages.find((message) => message.meta?.source === 'task-notification');
    assert.equal(storedNotification?.content, notification);
    assert.equal(stored.messages.at(-1).content, 'answer');
    assert.ok(stored._providerPrefixGuardState);

    await askSession(session.id, 'Continue after the check.', null, null, null, null, {});
    const nextRequest = sends.at(-1).messages;
    assert.deepEqual(nextRequest.slice(0, sentHistory.length), sentHistory);
    assert.match(
      String(nextRequest.findLast((message) => message.role === 'user').content),
      /Continue after the check\./
    );
  });
});

// Regression (lost Lead turn): a turn woken by a task notification ran a
// long tool, the user stopped it and sent a new message. The cancelled
// turn's notification, assistant text and tool call must stay in history,
// the unfinished call closed as cancelled, before the user's next message.
for (const abortReason of ['user-cancel', 'interrupt']) {
  test(`a notification turn stopped mid-tool (${abortReason}) keeps its turn before the next user message`, async (t) => {
    const { abortSessionTurn } = await import('./session-close.mjs');
    await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, setReply }) => {
      const notification = renderShellCompletionEnvelope({
        jobId: 'task_agent_island',
        status: 'completed',
        exitCode: 0,
        summary: 'Agent "island-agents" completed',
      });
      setReply(async () => ({
        content: 'The island fix is done. Re-running the full gate.',
        toolCalls: [{ id: 'call_gate', name: 'read', arguments: { path: 'gate.log' } }],
        stopReason: 'tool_use',
      }));
      let toolStarted = false;
      await assert.rejects(
        askSession(session.id, notification, null, null, null, null, {
          promptSource: 'task-notification',
          // The long-running tool: still executing when the turn is stopped.
          beforeToolExecution: () => {
            toolStarted = true;
            setImmediate(() => abortSessionTurn(session.id, abortReason));
            return new Promise(() => {});
          },
        }),
        (err) => err instanceof SessionClosedError
      );
      assert.equal(toolStarted, true);

      setReply(async () => ({ content: 'Looking into the shell.', usage: { inputTokens: 1, outputTokens: 1 } }));
      await askSession(session.id, 'Why did the foreground shell not background?', null, null, null, null, {});

      const messages = loadSession(session.id).messages.filter((m) => m.role !== 'system');
      const start = messages.findIndex((m) => m.role === 'user' && String(m.content).includes('task_agent_island'));
      assert.ok(start >= 0, 'the notification that started the turn is in history');
      const turn = messages.slice(start);
      const call = turn.find((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'call_gate'));
      assert.ok(call, 'the assistant tool call is in history');
      assert.match(String(call.content), /island fix is done/);
      const result = turn.find((m) => m.role === 'tool' && m.toolCallId === 'call_gate');
      assert.equal(result?.content, 'Cancelled', 'the unfinished tool call is closed as cancelled');
      const next = turn.findIndex((m) => m.role === 'user' && /foreground shell/.test(String(m.content)));
      assert.ok(next > turn.indexOf(result), 'the user message follows the interrupted turn');
      assert.equal(turn.at(-1).content, 'Looking into the shell.');
    });
  });
}

const islandNotification = () =>
  renderShellCompletionEnvelope({
    jobId: 'task_agent_island',
    status: 'completed',
    exitCode: 0,
    summary: 'Agent "island-agents" completed',
  });

// P1-a: an idle ask drains every queued completion at once; only the first
// runs, the rest wait as follow-up turns. Cancelling the first must hand the
// waiting ones back to the pending queue, not drop them with the ask.
test('completions drained behind a cancelled idle turn are released back to the pending queue', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  const { markCompletionEntry, drainPendingMessages, releasePendingMessages } = await import('./pending-messages.mjs');
  await withAskHarness(t, async ({ session, askSession, SessionClosedError, sends, setReply }) => {
    const completion = (jobId) =>
      markCompletionEntry(
        renderShellCompletionEnvelope({ jobId, status: 'completed', exitCode: 0, summary: `${jobId} done` }),
        { executionId: jobId }
      );
    enqueuePendingMessage(session.id, completion('job_first'));
    enqueuePendingMessage(session.id, completion('job_second'));
    setReply(
      (_messages, sendOpts) =>
        new Promise((_, reject) => {
          sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          setImmediate(() => abortSessionTurn(session.id, 'user-cancel'));
        })
    );
    await assert.rejects(
      askSession(session.id, '', null, null, null, null, {}),
      (err) => err instanceof SessionClosedError
    );
    assert.equal(sends.length, 1, 'only the first completion started a turn');
    assert.match(String(sends[0].messages.at(-1).content), /job_first/);
    const drained = drainPendingMessages(session.id);
    const text = drained.map((entry) => String(entry.content ?? entry.message ?? ''));
    assert.deepEqual(
      [
        text.filter((value) => value.includes('job_first')).length,
        text.filter((value) => value.includes('job_second')).length,
      ],
      [1, 1],
      'both completions are queued again, each exactly once'
    );
    assert.ok(text.findIndex((v) => v.includes('job_first')) < text.findIndex((v) => v.includes('job_second')));
    releasePendingMessages(session.id, drained);
  });
});

// P1-b: the host commits the prompt on the first meaningful text. A reset
// retracts that text and the retry so far streamed only whitespace; the
// retracted text is still the only output the user saw, so a cancel must keep
// the turn (the host will not requeue a committed notification).
test('a cancel after a text reset and whitespace-only replacement keeps the committed output', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, setReply }) => {
    const notification = islandNotification();
    setReply(
      (_messages, sendOpts) =>
        new Promise((_, reject) => {
          sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          (async () => {
            sendOpts.onTextDelta?.('hello');
            assert.equal(await sendOpts.onTextReset?.({ chars: 5 }), true);
            sendOpts.onTextDelta?.('  ');
            abortSessionTurn(session.id, 'user-cancel');
          })();
        })
    );
    await assert.rejects(
      askSession(session.id, notification, null, null, null, null, {
        promptSource: 'task-notification',
        onTextReset: () => true,
      }),
      (err) => err instanceof SessionClosedError
    );
    const stored = loadSession(session.id).messages;
    const start = stored.findIndex((m) => m.role === 'user' && m.content === notification);
    assert.ok(start >= 0, 'the committed notification turn is kept');
    const assistant = stored.slice(start).find((m) => m.role === 'assistant');
    assert.match(String(assistant?.content), /hello/, 'the text the user saw is kept');
  });
});

// A second reset that retracts only the whitespace replacement must not
// overwrite the meaningful draft the host already committed on.
test('a cancel after two resets around a whitespace-only retry keeps the committed output', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, setReply }) => {
    const notification = islandNotification();
    setReply(
      (_messages, sendOpts) =>
        new Promise((_, reject) => {
          sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          (async () => {
            sendOpts.onTextDelta?.('hello');
            assert.equal(await sendOpts.onTextReset?.({ chars: 5 }), true);
            sendOpts.onTextDelta?.('  ');
            assert.equal(await sendOpts.onTextReset?.({ chars: 2 }), true);
            abortSessionTurn(session.id, 'user-cancel');
          })();
        })
    );
    await assert.rejects(
      askSession(session.id, notification, null, null, null, null, {
        promptSource: 'task-notification',
        onTextReset: () => true,
      }),
      (err) => err instanceof SessionClosedError
    );
    const stored = loadSession(session.id).messages;
    const start = stored.findIndex((m) => m.role === 'user' && m.content === notification);
    assert.ok(start >= 0, 'the committed notification turn is kept');
    const assistant = stored.slice(start).find((m) => m.role === 'assistant');
    assert.match(String(assistant?.content), /hello/, 'the text the user saw is kept');
  });
});

// An idle ask drains every queued completion at once; after the first turn
// succeeds, the ones waiting in the queue's tail must run too, in order,
// even when nothing new arrived during the first turn.
test('completions drained together by an idle ask all run as follow-up turns', async (t) => {
  const { markCompletionEntry, drainPendingMessages } = await import('./pending-messages.mjs');
  await withAskHarness(t, async ({ session, askSession, sends, setReply }) => {
    const completion = (jobId) =>
      markCompletionEntry(
        renderShellCompletionEnvelope({ jobId, status: 'completed', exitCode: 0, summary: `${jobId} done` }),
        { executionId: jobId }
      );
    enqueuePendingMessage(session.id, completion('job_first'));
    enqueuePendingMessage(session.id, completion('job_second'));
    setReply(async () => ({ content: 'Noted.', usage: { inputTokens: 1, outputTokens: 1 } }));
    await askSession(session.id, '', null, null, null, null, {});
    assert.equal(sends.length, 2, 'each queued completion ran its own turn');
    assert.match(String(sends[0].messages.at(-1).content), /job_first/);
    assert.match(String(sends[1].messages.at(-1).content), /job_second/);
    assert.deepEqual(drainPendingMessages(session.id), [], 'nothing is left pending');
  });
});

// The host half (the uncommitted notification entry is requeued by Esc) is
// pinned in src/tui/session/session-api/intake.test.mjs.
test('a notification turn cancelled with reasoning only is rewound from history', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, setReply }) => {
    const notification = islandNotification();
    setReply(
      (_messages, sendOpts) =>
        new Promise((_, reject) => {
          sendOpts.onReasoningDelta?.('Thinking about the gate.');
          sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          setImmediate(() => abortSessionTurn(session.id, 'user-cancel'));
        })
    );
    await assert.rejects(
      askSession(session.id, notification, null, null, null, null, { promptSource: 'task-notification' }),
      (err) => err instanceof SessionClosedError
    );
    const stored = loadSession(session.id).messages;
    assert.equal(
      stored.some((m) => String(m.content).includes('task_agent_island')),
      false,
      'a turn that produced no output is rewound'
    );
    assert.equal(
      stored.some((m) => m.role === 'assistant'),
      false,
      'reasoning alone never persists as an assistant message'
    );
  });
});

test('a completed tool result of a cancelled notification turn is kept exactly once', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, SessionClosedError, sends, setReply }) => {
    setReply(async (_messages, sendOpts) => {
      if (sends.length === 1) {
        return {
          content: 'Checking the gate log.',
          toolCalls: [{ id: 'call_done', name: 'read', arguments: { path: 'missing-gate.log' } }],
          stopReason: 'tool_use',
        };
      }
      // The follow-up request after the completed tool: stopped mid-stream.
      return new Promise((_, reject) => {
        sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        setImmediate(() => abortSessionTurn(session.id, 'user-cancel'));
      });
    });
    await assert.rejects(
      askSession(session.id, islandNotification(), null, null, null, null, { promptSource: 'task-notification' }),
      (err) => err instanceof SessionClosedError
    );
    assert.equal(sends.length, 2, 'the tool completed and its result was sent');
    const stored = loadSession(session.id).messages;
    assert.ok(stored.some((m) => m.role === 'user' && String(m.content).includes('task_agent_island')));
    const results = stored.filter((m) => m.role === 'tool' && m.toolCallId === 'call_done');
    assert.equal(results.length, 1, 'the completed result is not duplicated');
    assert.notEqual(results[0].content, 'Cancelled', 'a completed result is never replaced by a closure');
    assert.equal(stored.at(-1).content, '[Request interrupted by user]');
  });
});

test('after the close snapshot finalizes a cancelled notification turn, the next provider request carries it', async (t) => {
  const { abortSessionTurn } = await import('./session-close.mjs');
  await withAskHarness(t, async ({ session, askSession, SessionClosedError, sends, setReply }) => {
    const notification = islandNotification();
    setReply(async () => ({
      content: 'The island fix is done. Re-running the full gate.',
      toolCalls: [{ id: 'call_gate', name: 'read', arguments: { path: 'gate.log' } }],
      stopReason: 'tool_use',
    }));
    await assert.rejects(
      askSession(session.id, notification, null, null, null, null, {
        promptSource: 'task-notification',
        beforeToolExecution: () => {
          setImmediate(() => abortSessionTurn(session.id, 'user-cancel'));
          return new Promise(() => {});
        },
      }),
      (err) => err instanceof SessionClosedError
    );
    setReply(async () => ({ content: 'Looking into the shell.', usage: { inputTokens: 1, outputTokens: 1 } }));
    // Desktop-style next turn: a plain user prompt with transcript metadata.
    await askSession(session.id, 'Why did the foreground shell not background?', null, null, null, null, {
      transcriptMeta: { at: Date.now(), device: 'test-desktop' },
    });
    const request = sends.at(-1).messages;
    const at = (predicate) => request.findIndex(predicate);
    const notificationAt = at((m) => m.role === 'user' && m.content === notification);
    const assistantAt = at((m) => m.role === 'assistant' && /island fix is done/.test(String(m.content)));
    const closureAt = at((m) => m.role === 'tool' && m.content === 'Cancelled');
    const promptAt = at((m) => m.role === 'user' && /foreground shell/.test(String(m.content)));
    assert.ok(notificationAt >= 0, 'the provider sees the notification');
    assert.ok(notificationAt < assistantAt && assistantAt < closureAt && closureAt < promptAt);
  });
});

// An in-place model switch (set-route switchSessionInPlace) rewrites the
// prompt's model line and drops provider replay; the next turn starts a new
// cache chain instead of failing the old route's prefix guard.
test('the first turn after an in-place model switch is sent on the new model', async (t) => {
  const { updateSessionRoute } = await import('./session-lifecycle.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, sends, setReply }) => {
    setReply(async () => ({
      content: 'first answer',
      reasoningContent: 'thinking on the old model',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    await askSession(session.id, 'before the switch', null, null, null, null, {});
    assert.ok(loadSession(session.id)._providerPrefixGuardState, 'the first turn baselined the prefix guard');
    const systemBefore = JSON.stringify(sends[0].messages.filter((m) => m.role === 'system'));

    updateSessionRoute(session.id, { model: 'fake-model-2' }, { crossProvider: true });
    setReply(async () => ({ content: 'second answer', usage: { inputTokens: 1, outputTokens: 1 } }));
    const result = await askSession(session.id, 'after the switch', null, null, null, null, {});
    assert.equal(result.content, 'second answer');
    assert.equal(sends.length, 2);
    assert.equal(sends[1].model, 'fake-model-2');
    assert.notEqual(JSON.stringify(sends[1].messages.filter((m) => m.role === 'system')), systemBefore);

    // The new route's chain is stable from here on.
    setReply(async () => ({ content: 'third answer', usage: { inputTokens: 1, outputTokens: 1 } }));
    await askSession(session.id, 'next turn', null, null, null, null, {});
    assert.deepEqual(sends[2].messages.slice(0, sends[1].messages.length), sends[1].messages);
  });
});

test('a quota failure without output preserves its notification and failure after restoration', async (t) => {
  const { restoreTranscriptItems } = await import('../transcript-restore/restore.mjs');
  await withAskHarness(t, async ({ session, askSession, loadSession, setReply }) => {
    const notification = islandNotification();
    const quota = { provider: session.provider, model: session.model, resetAt: null };
    setReply(async () => {
      throw Object.assign(new Error('quota exhausted'), { httpStatus: 400, quotaExhausted: quota });
    });
    await assert.rejects(
      askSession(session.id, notification, null, null, null, null, { promptSource: 'task-notification' }),
      /quota exhausted/
    );
    const stored = JSON.parse(JSON.stringify(loadSession(session.id).messages));
    const prompt = stored.find((message) => message.content === notification);
    assert.ok(prompt, 'the notification survives a failure with no output');
    assert.equal(prompt.meta.transcript.completion.status, 'failed');
    assert.deepEqual(prompt.meta.transcript.completion.quota, quota);
    const items = restoreTranscriptItems(stored, { sessionId: session.id });
    assert.equal(items.at(-1).kind, 'turndone');
    assert.equal(items.at(-1).status, 'failed');
    assert.deepEqual(items.at(-1).quota, quota);
    assert.equal(items.at(-1).detail, 'Provider usage limit reached.');
    assert.ok(
      items.some((item) => item.kind === 'tool'),
      'the notification card survives'
    );
    setReply(async () => ({ content: 'recovered' }));
    await askSession(session.id, 'continue', null, null, null, null, {});
    const recovered = loadSession(session.id).messages.find((message) => message.content === notification);
    assert.deepEqual(recovered.meta.transcript.completion, prompt.meta.transcript.completion);
  });
});

test('a close refused by its lifecycle barrier leaves the turn running and checkpointing', async (t) => {
  const { closeSession } = await import('./session-close.mjs');
  const { readTurnCheckpoint } = await import('./turn-checkpoint.mjs');
  const { sessionPath } = await import('../store/session-paths.mjs');
  const { existsSync, readFileSync, unlinkSync, writeFileSync } = await import('node:fs');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await withAskHarness(t, async ({ session, askSession, loadSession, setReply }) => {
    let refused = null;
    let checkpointed = null;
    setReply(async (_messages, sendOpts) => {
      sendOpts.onTextDelta?.('before');
      // Let the turn's preflight save land before replacing the record.
      await sleep(100);
      const path = sessionPath(session.id);
      const original = existsSync(path) ? readFileSync(path) : null;
      // Another session's record renamed onto this path: the barrier refuses it.
      writeFileSync(path, JSON.stringify({ id: 'sess_someone_else', messages: [] }));
      const stderrWrite = process.stderr.write;
      process.stderr.write = () => true;
      try {
        refused = closeSession(session.id, 'cli-agent-close');
      } finally {
        process.stderr.write = stderrWrite;
        if (original) writeFileSync(path, original);
        else unlinkSync(path);
      }
      sendOpts.onTextDelta?.(' after');
      await sleep(400);
      checkpointed = readTurnCheckpoint(session.id);
      return { content: 'before after', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const result = await askSession(session.id, 'keep going', null, null, null, null, {});
    assert.equal(refused, false, 'the close was refused');
    assert.equal(
      checkpointed?.interruption?.partialAssistantContent,
      'before after',
      'the checkpoint kept recording after the refused close'
    );
    assert.equal(result.content, 'before after');
    const stored = loadSession(session.id);
    assert.notEqual(stored.closed, true);
    assert.equal(stored.messages.at(-1).role, 'assistant');
    assert.equal(stored.messages.at(-1).content, 'before after');
    assert.equal(
      stored.messages.some((m) => /Request interrupted/.test(String(m.content))),
      false,
      'the refused close left no interruption snapshot behind'
    );
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
