import './loop/test-isolation.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { OpenAIDirectProvider } from '../providers/openai-ws.mjs';
import {
  _clearWebSocketPoolForTest,
  _setOpenSocketForTest,
  _wsPool,
  acquireWebSocket,
  releaseWebSocket,
} from '../providers/openai-ws-pool.mjs';
import { sendProviderRequest } from './loop/send-phase.mjs';
import { askSideQuestion } from './side-question.mjs';
import { forgetSideQuestion } from './side-question-store.mjs';

class FakeSocket extends EventEmitter {
  readyState = 1;
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  ref() {}
  unref() {}
}

const TOOLS = Object.freeze([{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }]);

/**
 * The real OpenAI provider and socket pool; only the stream is scripted. Each
 * send acquires its pooled socket, reads the response-chain anchor, waits on
 * the scripted gate, then writes its own anchor, exactly where the stream
 * transport keeps it.
 */
function poolProvider(script) {
  const sends = [];
  class ScriptedSocketProvider extends OpenAIDirectProvider {
    send(messages, model, tools, opts) {
      return super.send(messages, model, tools, {
        ...opts,
        _sendViaWebSocketFn: async ({ auth, poolKey, cacheKey, body, externalSignal }) => {
          const { entry } = await acquireWebSocket({ auth, poolKey, cacheKey, codexHeaders: {}, externalSignal });
          const step = script[sends.length];
          const send = { poolKey, cacheKey, promptCacheKey: body.prompt_cache_key, anchorRead: entry.lastResponseId };
          sends.push(send);
          await step.gate;
          entry.lastResponseId = step.responseId;
          releaseWebSocket({ entry, poolKey, keep: true });
          return { content: step.content, toolCalls: [], usage: null };
        },
      });
    }
  }
  return { provider: new ScriptedSocketProvider({ apiKey: 'sk-test' }), sends };
}

function mainRequest(sessionId, provider) {
  const session = { id: sessionId, provider: 'openai', model: 'gpt-5.5', status: 'running' };
  const messages = [
    { role: 'system', content: 'You are the Lead.' },
    { role: 'user', content: 'Refactor the parser.' },
  ];
  const signal = new AbortController().signal;
  return [
    {
      opts: { sessionId, session, effort: 'medium', signal },
      provider,
      model: 'gpt-5.5',
      messages,
      sessionRef: session,
      sessionId,
      signal,
      prefixGuardState: null,
      cacheBreakTraceKeys: new Set(),
      imageStrip: null,
      lastToolBatchEndedAt: 0,
      contextOverflowRetryUsed: false,
      transportRetriesUsed: 0,
      transportRetryMax: 0,
      imageStripUsed: false,
      thinkingReplayRepairUsed: false,
    },
    {
      iterT0: Date.now(),
      nextIteration: 1,
      sendTools: TOOLS,
      requestToolScope: { session, provider: 'openai', messages, requestTools: TOOLS },
    },
  ];
}

test('a side question shares the prompt cache key but never the main socket or its chain anchor', async (t) => {
  _clearWebSocketPoolForTest();
  _setOpenSocketForTest(async () => ({ socket: new FakeSocket() }));
  t.after(() => {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  });
  const sessionId = 'btw-transport';
  let releaseMain;
  const { provider, sends } = poolProvider([
    { responseId: 'resp-main-1', content: 'Reading.' },
    { responseId: 'resp-main-2', content: 'Done.', gate: new Promise((resolve) => (releaseMain = resolve)) },
    { responseId: 'resp-side', content: 'It is in parser.mjs.' },
  ]);

  await sendProviderRequest(...mainRequest(sessionId, provider));
  // The next main request is in flight and owns the session's pooled socket.
  const mainTurn = sendProviderRequest(...mainRequest(sessionId, provider));
  while (sends.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends[1].anchorRead, 'resp-main-1', 'the main chain continues on its socket');

  // Answered while the main request still holds its socket: not serialized.
  const answer = await askSideQuestion(sessionId, 'Where is the parser?');
  assert.deepEqual(answer, { text: 'It is in parser.mjs.' });
  const [main, , side] = sends;
  assert.notEqual(side.poolKey, sessionId);
  assert.ok(side.poolKey.startsWith(`${sessionId}#side:`));
  assert.equal(side.anchorRead ?? null, null, 'the fork reads no chain anchor');
  assert.equal(side.cacheKey, main.cacheKey, 'same handshake cache routing');
  assert.equal(side.promptCacheKey, main.promptCacheKey, 'same prompt_cache_key');
  assert.equal(_wsPool.has(side.poolKey), false, 'the fork scope is disposed');

  // The main session's anchor is the one its own request left.
  const [mainEntry] = _wsPool.get(sessionId);
  assert.equal(mainEntry.lastResponseId, 'resp-main-1');
  releaseMain();
  await mainTurn;
  assert.equal(mainEntry.lastResponseId, 'resp-main-2');
  forgetSideQuestion(sessionId);
});
