import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderAdmissionScheduler, wrapProviderAdmission } from './admission-scheduler.mjs';
import { createAccountPoolProvider } from './account-pool.mjs';
import {
  finalizeProviderRequestTools,
  isFinalizedProviderRequestTools,
  providerNativeToolPrefixCount,
} from '../runtime-core/provider-request-tools.mjs';

const LONE = '\ud83d';
const FIXED = '\ufffd';

function fakeProvider() {
  const seen = [];
  const provider = {
    name: 'openai-oauth',
    async send(messages, model, tools, opts) {
      seen.push({ messages, model, tools, opts });
      return { content: 'ok' };
    },
  };
  wrapProviderAdmission(provider, provider.name, new ProviderAdmissionScheduler({ concurrency: 2 }));
  return { provider, seen };
}

function allStringsWellFormed(value) {
  if (typeof value === 'string') return value.isWellFormed();
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    return Object.entries(value).every(([k, v]) => k.isWellFormed() && allStringsWellFormed(v));
  }
  return true;
}

test('lone surrogates in text, tool results, tool call arguments and keys reach the provider as U+FFFD', async () => {
  const { provider, seen } = fakeProvider();
  const stored = [
    { role: 'user', content: `half emoji ${LONE} cut` },
    { role: 'user', content: [{ type: 'text', text: `block ${LONE}` }] },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'grep', arguments: `{"pattern":"${LONE}"}` }],
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'read', arguments: { [`k${LONE}`]: `v${LONE}` } }],
    },
    { role: 'tool', toolCallId: 'c1', content: `result ${LONE}` },
  ];
  const tools = [{ name: 'grep', description: `tool ${LONE}`, input_schema: { type: 'object' } }];
  const before = JSON.stringify(stored);

  await provider.send(stored, 'gpt-test', tools, {});

  const got = seen[0];
  assert.ok(allStringsWellFormed(got.messages));
  assert.ok(allStringsWellFormed(got.tools));
  assert.equal(got.messages[0].content, `half emoji ${FIXED} cut`);
  assert.equal(got.messages[1].content[0].text, `block ${FIXED}`);
  assert.equal(got.messages[2].toolCalls[0].arguments, `{"pattern":"${FIXED}"}`);
  assert.deepEqual(got.messages[3].toolCalls[0].arguments, { [`k${FIXED}`]: `v${FIXED}` });
  assert.equal(got.messages[4].content, `result ${FIXED}`);
  assert.equal(got.tools[0].description, `tool ${FIXED}`);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(got.messages)));
  assert.ok(!JSON.stringify(got.messages).includes('\\ud83d'));
  // The stored transcript is never rewritten.
  assert.equal(JSON.stringify(stored), before);
  assert.ok(stored[0].content.includes(LONE));
});

test('well-formed requests keep object identity (no copy)', async () => {
  const { provider, seen } = fakeProvider();
  const messages = [
    { role: 'user', content: 'hello 😀 世界', meta: { transcript: { messageId: 'm1' } } },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', arguments: { a: '😀' } }] },
  ];
  const tools = [{ name: 'x', description: 'fine' }];
  await provider.send(messages, 'gpt-test', tools, {});
  assert.equal(seen[0].messages, messages);
  assert.equal(seen[0].messages[0], messages[0]);
  assert.equal(seen[0].tools, tools);
});

test('only containers on the path to a bad string are copied; siblings and media stay identical', async () => {
  const { provider, seen } = fakeProvider();
  const bytes = new Uint8Array([0xd8, 0x3d, 1, 2]);
  const buf = Buffer.from([0xed, 0xa0, 0xbd]);
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', bytes, buf };
  const clean = { role: 'user', content: 'clean' };
  const dirty = { role: 'user', content: [{ type: 'text', text: `x${LONE}` }, image] };
  const messages = [clean, dirty];
  await provider.send(messages, 'gpt-test', undefined, {});
  const got = seen[0].messages;
  assert.notEqual(got, messages);
  assert.equal(got[0], clean);
  assert.equal(got[1].content[0].text, `x${FIXED}`);
  assert.equal(got[1].content[1], image);
  assert.equal(got[1].content[1].bytes, bytes);
  assert.equal(got[1].content[1].buf, buf);
  assert.equal(seen[0].tools, undefined);
});

test('a finalized tool list stays finalized with its native prefix after sanitizing', async () => {
  const { provider, seen } = fakeProvider();
  const tools = finalizeProviderRequestTools([{ type: 'web_search' }, { name: 'x', description: `d${LONE}` }], 1);
  await provider.send([{ role: 'user', content: 'hi' }], 'gpt-test', tools, {});
  const sent = seen[0].tools;
  assert.notEqual(sent, tools);
  assert.equal(sent[1].description, `d${FIXED}`);
  assert.equal(isFinalizedProviderRequestTools(sent), true);
  assert.equal(providerNativeToolPrefixCount(sent), 1);
});

test('an account-pool gateway over a wrapped provider sanitizes too', async () => {
  const seen = [];
  const gateway = createAccountPoolProvider('openai-oauth', () => {
    const inner = {
      name: 'openai-oauth',
      async send(messages) {
        seen.push(messages);
        return { content: 'ok' };
      },
    };
    return wrapProviderAdmission(inner, 'openai-oauth', new ProviderAdmissionScheduler({ concurrency: 2 }));
  });
  await gateway.send([{ role: 'user', content: `a${LONE}` }], 'gpt-test', [], {});
  assert.equal(seen[0][0].content, `a${FIXED}`);
});
