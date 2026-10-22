// The max_tokens escalation through the public agentLoop entry point: it is
// one-shot whatever happens to the send it rode on, it withdraws text the cut
// turn already streamed, and it leaves hidden-agent and pause_turn handling
// as they were.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-output-escalation-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { agentLoop } = await import('./agent-loop.mjs');
const { HIDDEN_AGENT_NAMES } = await import('./loop/hidden-agents.mjs');

const ESCALATED = 128_000;
const cut = { content: '', toolCalls: [], stopReason: 'max_tokens' };

function leadSession(extra = {}) {
  return {
    id: 'output-escalation-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    ...extra,
  };
}

// `script` entries are responses or functions (sendOpts, sendNumber) returning
// one (or throwing). The last entry repeats.
function scriptedProvider(script, { escalated = ESCALATED } = {}) {
  const state = { sends: 0, overrides: [] };
  return {
    state,
    escalatedMaxTokens: () => escalated,
    async send(_messages, _model, _tools, sendOpts) {
      state.sends += 1;
      state.overrides.push(sendOpts?.maxOutputTokensOverride);
      const entry = script[Math.min(state.sends, script.length) - 1];
      return typeof entry === 'function' ? entry(sendOpts, state.sends) : entry;
    },
  };
}

function run(provider, messages, opts = {}) {
  return agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: leadSession(),
    sessionId: 'output-escalation-test',
    ...opts,
  });
}

const malformedToolCall = () =>
  Object.assign(new Error('Gemini response incomplete: finishReason=MALFORMED_FUNCTION_CALL'), {
    providerIncomplete: true,
    code: 'PROVIDER_INCOMPLETE',
    finishReason: 'MALFORMED_FUNCTION_CALL',
    partialContent: '',
  });

test('a transport retry of the escalated send does not carry the override again', async () => {
  const provider = scriptedProvider([
    cut,
    () => {
      throw malformedToolCall();
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const sendOpts = {};
  const result = await run(provider, [{ role: 'user', content: 'go' }], sendOpts);
  assert.deepEqual(provider.state.overrides, [undefined, ESCALATED, undefined]);
  assert.equal(result.content, 'done');
  assert.equal(sendOpts.maxOutputTokensOverride, undefined);
});

test('a thrown error on the escalated send leaves no override for any later send', async () => {
  const provider = scriptedProvider([
    cut,
    () => {
      throw new Error('boom: not recoverable');
    },
    { content: 'later', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const sendOpts = {};
  await assert.rejects(run(provider, [{ role: 'user', content: 'go' }], sendOpts), /boom/);
  assert.equal(sendOpts.maxOutputTokensOverride, undefined);
  // A later ask that reuses the same options starts clean.
  const result = await run(provider, [{ role: 'user', content: 'again' }], sendOpts);
  assert.equal(result.content, 'later');
  assert.equal(provider.state.overrides.at(-1), undefined);
});

test('an abort during the escalated send leaves no override behind', async () => {
  const controller = new AbortController();
  const provider = scriptedProvider([
    cut,
    () => {
      controller.abort();
      throw new Error('aborted');
    },
    { content: 'later', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const sendOpts = { signal: controller.signal };
  await assert.rejects(run(provider, [{ role: 'user', content: 'go' }], sendOpts));
  assert.equal(sendOpts.maxOutputTokensOverride, undefined);
  assert.deepEqual(provider.state.overrides, [undefined, ESCALATED]);
});

function streamingCut(text) {
  return (sendOpts) => {
    sendOpts.onTextDelta(text);
    return { content: text, toolCalls: [], stopReason: 'max_tokens' };
  };
}

test('escalating withdraws the text the cut turn already streamed, so the live row shows no stale copy', async () => {
  const screen = [];
  const resets = [];
  const provider = scriptedProvider([
    streamingCut('partial text'),
    (sendOpts) => {
      sendOpts.onTextDelta('full answer');
      return { content: 'full answer', toolCalls: [], stopReason: 'end_turn' };
    },
  ]);
  const result = await run(provider, [{ role: 'user', content: 'go' }], {
    onTextDelta: (text) => screen.push(text),
    onTextReset: ({ chars, reason }) => {
      resets.push({ chars, reason });
      const joined = screen.join('');
      screen.length = 0;
      screen.push(joined.slice(0, joined.length - chars));
      return true;
    },
  });
  assert.deepEqual(provider.state.overrides, [undefined, ESCALATED]);
  assert.deepEqual(resets, [{ chars: 'partial text'.length, reason: 'output-limit-escalation' }]);
  assert.equal(screen.join(''), 'full answer');
  assert.equal(result.content, 'full answer');
});

test('streamed text the owner cannot withdraw is kept: no escalation, the ladder resumes it', async () => {
  for (const onTextReset of [undefined, () => false]) {
    const messages = [{ role: 'user', content: 'go' }];
    const provider = scriptedProvider([
      streamingCut('partial text'),
      { content: 'rest', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const result = await run(provider, messages, { onTextDelta: () => {}, ...(onTextReset ? { onTextReset } : {}) });
    assert.deepEqual(provider.state.overrides, [undefined, undefined]);
    assert.equal(result.content, 'partial textrest');
    assert.equal(messages.filter((message) => message.meta?.source === 'max-output-recovery').length, 1);
  }
});

test('a hidden agent that is cut empty at max_tokens recovers like any other turn', async () => {
  const [hidden] = [...HIDDEN_AGENT_NAMES];
  assert.ok(hidden, 'the registry names at least one hidden agent');
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([cut, cut, { content: 'chunk-a|chunk-b', toolCalls: [], stopReason: 'end_turn' }]);
  const result = await run(provider, messages, { session: leadSession({ agent: hidden }) });
  assert.deepEqual(provider.state.overrides, [undefined, ESCALATED, undefined]);
  assert.equal(result.content, 'chunk-a|chunk-b');
  assert.equal(result.terminationReason, undefined);
  assert.equal(messages.filter((message) => message.meta?.source === 'max-output-recovery').length, 1);
});

test('a hidden agent still ends an ordinary empty turn without a nudge', async () => {
  const [hidden] = [...HIDDEN_AGENT_NAMES];
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'end_turn' }]);
  const result = await run(provider, messages, { session: leadSession({ agent: hidden }) });
  assert.equal(provider.state.sends, 1);
  assert.equal(messages.length, 1);
  assert.equal(result.terminationReason, undefined);
});

test('an empty pause_turn is nudged as an incomplete turn, never escalated or treated as an output limit', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'pause_turn' }]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 4);
  assert.deepEqual(provider.state.overrides, [undefined, undefined, undefined, undefined]);
  const nudges = messages.filter(
    (message) => typeof message.content === 'string' && message.content.includes('Empty incomplete turn')
  );
  assert.equal(nudges.length, 3);
  assert.match(nudges[0].content, /stopReason=pause_turn/);
  assert.equal(messages.filter((message) => message.meta?.source === 'max-output-recovery').length, 0);
  assert.equal(result.terminationReason, 'truncated');
});
