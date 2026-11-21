import assert from 'node:assert/strict';
import test from 'node:test';
import { ASKED_FILE, FINAL, PARTIAL, startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

const TOOLS = [{ function: { name: 'read' } }, { function: { name: 'ask_user' } }];

async function withProvider(options, run) {
  const provider = await startAbortProvider(options);
  try {
    await run(provider);
  } finally {
    await provider.close();
  }
}

const post = (provider, body, signal) =>
  fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
const turn = (prompt, extra = {}) => ({
  stream: true,
  tools: TOOLS,
  messages: [{ role: 'user', content: prompt }],
  ...extra,
});
const toolCall = (text) => {
  const delta = text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)).choices[0]?.delta?.tool_calls?.[0])
    .find(Boolean);
  return { name: delta.function.name, args: JSON.parse(delta.function.arguments) };
};

test('a request without tools is answered with a short text and finished', async () => {
  await withProvider({}, async (provider) => {
    const text = await (await post(provider, turn('HOLD-TEXT', { tools: undefined }))).text();
    assert.match(text, /"content":"ok"/);
    assert.match(text, /\[DONE\]\n\n$/);
    assert.equal(provider.requests[0].held, null);
  });
});

test('a request that is not streamed is answered with one completion', async () => {
  await withProvider({}, async (provider) => {
    const body = await (await post(provider, turn('anything', { stream: false }))).json();
    assert.equal(body.choices[0].message.content, 'ok');
  });
});

test('GET lists the one model', async () => {
  await withProvider({}, async (provider) => {
    const body = await (await fetch(`${provider.baseURL}/models`)).json();
    assert.deepEqual(body.data, [{ id: 'harness-model', object: 'model' }]);
  });
});

test('HOLD-TOOL answers with a call of the read tool on package.json and reports it asked', async () => {
  await withProvider({}, async (provider) => {
    const text = await (await post(provider, turn('HOLD-TOOL go'))).text();
    assert.deepEqual(toolCall(text), { name: 'read', args: { path: 'package.json' } });
    assert.equal((await provider.asked('HOLD-TOOL')).asked, true);
  });
});

test('HOLD-ASK answers with a call of the read tool on the asked file', async () => {
  await withProvider({}, async (provider) => {
    const text = await (await post(provider, turn('HOLD-ASK go'))).text();
    assert.deepEqual(toolCall(text), { name: 'read', args: { path: ASKED_FILE } });
  });
});

test('HOLD-APPROVAL answers with a call of ask_user carrying a question', async () => {
  await withProvider({}, async (provider) => {
    const text = await (await post(provider, turn('HOLD-APPROVAL go'))).text();
    const { name, args } = toolCall(text);
    assert.equal(name, 'ask_user');
    assert.equal(args.questions[0].question, 'Add the file?');
  });
});

test('a tool call is refused with an empty stream when the turn offers no such tool', async () => {
  await withProvider({}, async (provider) => {
    const text = await (await post(provider, turn('HOLD-TOOL go', { tools: [{ function: { name: 'bash' } }] }))).text();
    assert.equal(
      text,
      'data: {"id":"chatcmpl-abort","object":"chat.completion.chunk","created":1700000000,"model":"harness-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n'
    );
  });
});

test('HOLD-ASK answers the request carrying the tool result and finishes it', async () => {
  await withProvider({}, async (provider) => {
    const messages = [
      { role: 'user', content: 'HOLD-ASK go' },
      { role: 'tool', content: 'file text' },
    ];
    const text = await (await post(provider, turn('', { messages }))).text();
    assert.match(text, /"content":"ok"/);
    assert.match(text, /\[DONE\]\n\n$/);
    assert.equal(provider.requests[0].asked, false);
  });
});

for (const [marker, kind, expected] of [
  ['HOLD-EMPTY', 'empty', null],
  ['HOLD-TEXT', 'text', PARTIAL],
  ['HOLD-FINAL', 'final', FINAL],
]) {
  test(`${marker} streams ${expected ?? 'nothing'} and stays open until the client hangs up`, async () => {
    await withProvider({}, async (provider) => {
      const abort = new AbortController();
      const response = await post(provider, turn(`${marker} go`), abort.signal);
      const reader = response.body.getReader();
      let seen = '';
      const decoder = new TextDecoder();
      const expectedText = expected ?? '"role":"assistant"';
      while (!seen.includes(expectedText)) seen += decoder.decode((await reader.read()).value);
      assert.equal(seen.includes('[DONE]'), false);
      const entry = await provider.held(marker);
      assert.equal(entry.held, kind);
      assert.equal(entry.closedByClient, undefined);
      abort.abort();
      await reader.closed.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(entry.closedByClient, true);
    });
  });
}

test('gated: nothing is written until released, one write per release, by request key order', async () => {
  await withProvider({ gated: true }, async (provider) => {
    const queued = new Promise((resolve) => provider.onQueued(resolve));
    const answered = fetch(`${provider.baseURL}/models`).then((res) => res.json());
    await queued;
    let done = false;
    answered.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    const first = provider.releaseNext();
    assert.equal(first.step, 1);
    assert.equal(first.key, 'GET /v1/models');
    assert.equal(provider.releaseNext().step, 2);
    assert.equal(provider.releaseNext(), false);
    assert.equal((await answered).data[0].id, 'harness-model');
  });
});
