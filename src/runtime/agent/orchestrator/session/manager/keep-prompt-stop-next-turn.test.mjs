// A Stop that keeps its unanswered prompt (USER_CANCEL_KEEP_PROMPT_REASON: the
// desktop Stop button and the TUI Esc) leaves two consecutive user messages
// once the user sends again. This pins that the next turn is still a valid
// request for every provider family's message builder, passes the provider
// prefix guard, and that the stored transcript keeps both prompts in order.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('keep-stop');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { abortSessionTurn } = await import('./session-close.mjs');
const { USER_CANCEL_KEEP_PROMPT_REASON } = await import('./turn-interruption.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { SessionClosedError } = await import('./session-errors.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { restoreTranscriptItems } = await import('../transcript-restore/restore.mjs');
const { buildAnthropicApiRequest } = await import('../../providers/anthropic-api-request.mjs');
const { toOpenAIMessages } = await import('../../providers/openai-compat-wire.mjs');
const { convertMessagesToResponsesInput } = await import('../../providers/openai-responses-payload.mjs');
const { buildGeminiRequest } = await import('../../providers/gemini-request-body.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const STOPPED = 'first prompt that gets stopped';
const NEXT = 'second prompt after the stop';

// warm-up turn (arms the prefix guard) → stopped turn → next turn, all through
// the real ask loop; only the provider is fake. Returns what the provider saw
// on the next turn and the stored session.
async function stopThenAskAgain(t, abortReason) {
  const providerName = 'keep-stop-next-turn-test';
  const sends = [];
  let hang = false;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages, _model, _tools, sendOpts) {
      sends.push(structuredClone(messages));
      if (!hang) return { content: 'answer', usage: { inputTokens: 10, outputTokens: 5 } };
      return new Promise((_, reject) => {
        sendOpts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        setImmediate(() => abortSessionTurn(session.id, abortReason));
      });
    },
  };
  let session;
  let out;
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    session = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    await askSession(session.id, 'warm up', null, null, null, null, {});
    hang = true;
    await assert.rejects(
      askSession(session.id, STOPPED, null, null, null, null, {}),
      (err) => err instanceof SessionClosedError
    );
    hang = false;
    // Resolving at all means the prefix guard let the request through.
    await askSession(session.id, NEXT, null, null, null, null, {});
    out = { sent: sends.at(-1), stored: loadSession(session.id) };
  });
  return out;
}

const textOf = (value) => JSON.stringify(value);
function assertBothPromptsInOrder(wire) {
  const text = textOf(wire);
  assert.ok(text.includes(STOPPED), 'the stopped prompt is still sent');
  assert.ok(text.includes(NEXT), 'the new prompt is sent');
  assert.ok(text.indexOf(STOPPED) < text.indexOf(NEXT), 'in the order typed');
}
// Request-valid for a chat wire: only the roles the family accepts, every turn
// carries content, and it opens and closes on a user turn.
function assertWellFormedTurns(turns, roles, contentOf) {
  assert.ok(turns.length > 0);
  for (const turn of turns) {
    assert.ok(roles.includes(turn.role), `unexpected role ${turn.role}`);
    const content = contentOf(turn);
    assert.ok(
      typeof content === 'string' ? content.trim() : Array.isArray(content) && content.length > 0,
      `empty ${turn.role} turn`
    );
  }
  assert.equal(turns[0].role, 'user');
  assert.equal(turns.at(-1).role, 'user');
}

const abortReason = USER_CANCEL_KEEP_PROMPT_REASON;
test(`after a prompt-keeping stop the next turn is a valid request for every provider family (${abortReason})`, async (t) => {
  const { sent } = await stopThenAskAgain(t, abortReason);
  assert.equal(
    sent.filter((m) => m.role === 'user' && textOf(m.content).includes(STOPPED)).length,
    1,
    'the engine history holds the stopped prompt once'
  );

  const anthropic = await buildAnthropicApiRequest({
    name: 'anthropic',
    config: {},
    messages: sent,
    useModel: 'claude-sonnet-4-5',
    tools: undefined,
    opts: {},
    fastModeLatched: false,
  });
  assertWellFormedTurns(anthropic.params.messages, ['user', 'assistant'], (turn) => turn.content);
  assertBothPromptsInOrder(anthropic.params.messages);

  const responses = convertMessagesToResponsesInput(sent);
  assertWellFormedTurns(
    responses.filter((item) => item.role),
    ['user', 'assistant'],
    (item) => item.content
  );
  assertBothPromptsInOrder(responses);

  const chat = toOpenAIMessages(
    sent.filter((m) => m.role !== 'system'),
    'openai'
  );
  assertWellFormedTurns(chat, ['user', 'assistant'], (message) => message.content);
  assertBothPromptsInOrder(chat);

  const gemini = buildGeminiRequest(sent, 'gemini-2.5-pro', undefined, {});
  assertWellFormedTurns(gemini.contents, ['user', 'model'], (turn) => turn.parts);
  for (const turn of gemini.contents) {
    for (const part of turn.parts) assert.ok(typeof part.text === 'string' ? part.text.trim() : true);
  }
  assertBothPromptsInOrder(gemini.contents);
});

test(`the stored transcript keeps the stopped prompt, then the new one, then its answer (${abortReason})`, async (t) => {
  const { stored } = await stopThenAskAgain(t, abortReason);
  const chat = stored.messages.filter((m) => m.role !== 'system');
  const texts = chat.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : textOf(m.content)}`);
  const stopped = texts.findIndex((line) => line.includes(STOPPED));
  const next = texts.findIndex((line) => line.includes(NEXT));
  assert.ok(stopped >= 0 && next > stopped, texts.join('\n'));
  assert.equal(chat.at(-1).role, 'assistant');

  const rows = restoreTranscriptItems(stored.messages, { sessionId: stored.id });
  const kinds = rows.map((row) => `${row.kind}${row.status ? `:${row.status}` : ''}`);
  const rowStopped = rows.findIndex((row) => row.kind === 'user' && String(row.text).includes(STOPPED));
  const rowNext = rows.findIndex((row) => row.kind === 'user' && String(row.text).includes(NEXT));
  assert.ok(rowStopped >= 0 && rowNext > rowStopped, kinds.join(' '));
  assert.ok(
    rows.slice(rowStopped + 1, rowNext).some((row) => row.kind === 'turndone' && row.status === 'cancelled'),
    `a cancelled marker sits between the two prompts: ${kinds.join(' ')}`
  );
});
