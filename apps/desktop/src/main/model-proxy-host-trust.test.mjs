// The PC side of the model proxy treats the server as untrusted: what a
// server's call may make this PC read, how many calls it may start, and when.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// This PC's attachment store, with a blob in it the server must never reach.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-trust-'));
process.env.MIXDOG_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { createModelProxyHost, MODEL_PROXY_CALLBACKS, withoutAttachmentReferences } = await import(
  './model-proxy-host.ts'
);
const { MODEL_PROXY_REQUEST_EVENT, ModelProxyChannel, encodeModelProxyWire } = await import(
  '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs'
);
const { ModelProxyProvider } = await import(
  '../../../../src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs'
);
const { readAttachmentBase64, storeInlineImagePart } = await import('../../../../src/runtime/attachments/store.mjs');

function connect(t, runtime, { channel = new ModelProxyChannel(), ...hostOptions } = {}) {
  const operations = [];
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      operations.push(operation);
      const wireArgs = JSON.parse(JSON.stringify(args));
      return JSON.parse(JSON.stringify((await channel.handleOperation(operation, wireArgs)) ?? null));
    },
    loadRuntime: async () => runtime,
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  t.after(() => {
    detach();
    host.dispose();
  });
  return { channel, host, operations };
}

function fakeRuntime(providers) {
  return {
    provider: async (name) => providers[name],
    providerConfig: async () => ({ providers: { openai: { enabled: true } }, ready: true }),
    finalizeTools: (tools) => tools,
  };
}

async function within(promise, limitMs = 3_000) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${limitMs}ms`)), limitMs);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const okProvider = (seen = []) => ({
  async send(messages, _model, _tools, options) {
    seen.push({ messages, options });
    return { content: 'ok' };
  },
});

// ── 1. Attachment references never resolve against this PC's store ─────────

test('a stored-attachment reference from a server never reads this PC’s attachment store', async (t) => {
  const pcSecret = Buffer.from('this PC only').toString('base64');
  const stored = storeInlineImagePart({ type: 'image', data: pcSecret, mimeType: 'image/png' });
  assert.ok(stored?.attachmentRef, 'the digest exists in this PC’s store');
  assert.equal(readAttachmentBase64(stored), pcSecret, 'an adapter could have resolved it here');

  const seen = [];
  const { channel } = connect(t, fakeRuntime({ openai: okProvider(seen) }));
  // Straight onto the channel: a server that skips its own inlining.
  await within(
    channel.request({
      provider: 'openai',
      method: 'send',
      model: 'gpt',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', attachmentRef: stored.attachmentRef, mimeType: 'image/png' },
            {
              type: 'tool_result',
              content: [{ type: 'file', attachmentRef: stored.attachmentRef, filename: 'C:\\x\\a.pdf' }],
            },
          ],
        },
      ],
      options: {},
    })
  );
  const text = JSON.stringify(seen[0].messages);
  assert.doesNotMatch(text, /attachmentRef/);
  assert.doesNotMatch(text, new RegExp(pcSecret));
  assert.deepEqual(seen[0].messages[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'text', text: '[attachment unavailable: image/png]' },
    { type: 'tool_result', content: [{ type: 'text', text: '[attachment unavailable: a.pdf]' }] },
  ]);
});

test('inline attachment data passes untouched, and nesting is bounded', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }];
  assert.equal(withoutAttachmentReferences(messages), messages);
  let deep = {};
  for (let index = 0; index < 500; index += 1) deep = { content: [deep] };
  assert.throws(() => withoutAttachmentReferences([deep]), { code: 'MODEL_PROXY_REQUEST_INVALID' });
});

// ── 2. Claims and payloads are bounded ──────────────────────────────────────

test('1,000 advertised ids never produce more claims than one snapshot may name', async () => {
  const claims = [];
  const host = createModelProxyHost({
    // A daemon that never answers a claim.
    invoke: (operation, args) => {
      if (operation === 'modelProxyClaim') claims.push(args[0]);
      return new Promise(() => {});
    },
    loadRuntime: async () => fakeRuntime({}),
    maxSnapshotEntries: 4,
    claimTimeoutMs: 60_000,
  });
  const requests = Array.from({ length: 1_000 }, (_, index) => ({ id: `call-${index}`, method: 'send' }));
  for (let round = 0; round < 3; round += 1) {
    host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, { requests, cancelled: requests.map((row) => row.id) });
  }
  await delay(10);
  assert.deepEqual(claims, ['call-0', 'call-1', 'call-2', 'call-3']);
  host.dispose();
});

test('payloads past the aggregate in-flight limit are refused, and so are oversized event replies', async (t) => {
  const started = Promise.withResolvers();
  const hanging = {
    send(_messages, _model, _tools, options) {
      started.resolve();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason))
      );
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: hanging }), { maxInflightBytes: 3_000 });
  const big = [{ role: 'user', content: 'x'.repeat(2_000) }];
  const first = new ModelProxyProvider('openai', {}, channel).send(big, 'gpt', undefined, {});
  first.catch(() => {});
  await started.promise;
  await assert.rejects(within(new ModelProxyProvider('openai', {}, channel).send(big, 'gpt', undefined, {})), {
    code: 'MODEL_PROXY_BUSY',
  });

  // A daemon answering a callback batch with an oversized reply stops the call.
  const resolved = Promise.withResolvers();
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      if (operation === 'modelProxyClaim') {
        return {
          payload: encodeModelProxyWire({
            provider: 'openai',
            method: 'send',
            messages: [],
            options: {},
            callbacks: ['onTextDelta'],
          }),
        };
      }
      if (operation === 'modelProxyEvent') return { results: 'x'.repeat(2 * 1024 * 1024) };
      if (operation === 'modelProxyResolve') resolved.resolve(args);
      return null;
    },
    loadRuntime: async () =>
      fakeRuntime({
        openai: {
          send(_messages, _model, _tools, options) {
            options.onTextDelta('hi');
            return new Promise((_resolve, reject) =>
              options.signal.addEventListener('abort', () => reject(options.signal.reason))
            );
          },
        },
      }),
  });
  t.after(() => host.dispose());
  host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, { requests: [{ id: 'r1', method: 'send' }] });
  const [, ok, , error] = await within(resolved.promise);
  assert.equal(ok, false);
  assert.match(error, /oversized reply/);
});

// ── 3. No count, rate or duration limits: any send is admitted ──────────────

test('a burst of sends all run, with no rate or concurrency refusal', async (t) => {
  const { channel, host } = connect(t, fakeRuntime({ openai: okProvider() }));
  const sends = Array.from({ length: 30 }, () =>
    new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {})
  );
  for (const result of await within(Promise.all(sends))) assert.deepEqual(result, { content: 'ok' });
  assert.equal(host.running, 0);
});

// ── 4. Callbacks: only the allowlisted ones, projected ──────────────────────

test('callbacks reach the server only allowlisted and projected; account ids stay on this PC', async (t) => {
  const provider = {
    async send(_messages, _model, _tools, options) {
      assert.equal(options.onSecretHook, undefined, 'a callback the server names but this PC does not know');
      await options.onStageChange('account-changed', { provider: 'openai', accountId: 'pc-acct-42', at: 7 });
      await options.onStageChange('reconnecting', {
        attempt: 2,
        max: 3,
        message: 'retry with key sk-abcdefghijklmnopqrstuv',
        nested: { accountEmail: 'me@pc' },
        userEmail: 'me@pc',
      });
      options.onStreamDelta('x'.repeat(200));
      await options.onToolExcluded({
        name: 'bad_tool',
        index: 3,
        pointer: '/properties/x/type',
        reason: 'invalid type',
        message: 'gemini tool "bad_tool" excluded; key sk-abcdefghijklmnopqrstuv',
        accountId: 'pc-acct-42',
        schema: { type: 'bogus' },
      });
      return { content: 'ok' };
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: provider }));
  const stages = [];
  const deltas = [];
  const excluded = [];
  await within(
    new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {
      onStageChange: (stage, detail) => {
        stages.push([stage, detail]);
      },
      onStreamDelta: (kind) => {
        deltas.push(kind);
      },
      onToolExcluded: (info) => {
        excluded.push(info);
      },
      onSecretHook: () => assert.fail('never bridged'),
    })
  );
  assert.deepEqual(stages, [
    ['account-changed', { provider: 'openai', at: 7 }],
    ['reconnecting', { attempt: 2, max: 3, message: 'retry with key [redacted]' }],
  ]);
  assert.deepEqual(deltas, ['x'.repeat(64)]);
  // Scalars only, secrets redacted, identifying keys and nested values dropped.
  assert.deepEqual(excluded, [
    {
      name: 'bad_tool',
      index: 3,
      pointer: '/properties/x/type',
      reason: 'invalid type',
      message: 'gemini tool "bad_tool" excluded; key [redacted]',
    },
  ]);
  assert.deepEqual([...MODEL_PROXY_CALLBACKS.keys()].sort(), [
    'onStageChange',
    'onStreamDelta',
    'onTextDelta',
    'onTextReset',
    'onToolCall',
    'onToolExcluded',
  ]);
});
