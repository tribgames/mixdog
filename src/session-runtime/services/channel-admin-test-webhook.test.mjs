import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { verifySignature } from '../../runtime/channels/lib/webhook/signature.mjs';

const here = (path) => new URL(path, import.meta.url).href;
const state = { parser: 'github', base: 'https://relay.example/hook/dev1///' };
const SECRET = 'topsecret';
const actual = await import('../../runtime/channels/lib/webhooks-db.mjs');
mock.module(here('../../runtime/channels/lib/webhooks-db.mjs'), {
  namedExports: {
    ...actual,
    loadEndpointConfig: async (name) => (name === 'missing' ? null : { name, parser: state.parser }),
    readEndpointSecret: async () => SECRET,
  },
});
const tunnel = await import('../../runtime/channels/lib/webhook/relay-tunnel.mjs');
mock.module(here('../../runtime/channels/lib/webhook/relay-tunnel.mjs'), {
  namedExports: { ...tunnel, readHookPublicBase: () => state.base },
});
const { testWebhook } = await import('./channel-admin.mjs');

function stubFetch(impl) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  return calls;
}
const verified = () => new Response(JSON.stringify({ status: 'verified', test: true }), { status: 200 });

test('testWebhook signs per parser and verifies with verifySignature', async () => {
  const sigHeader = {
    github: 'x-hub-signature-256',
    generic: 'x-signature-256',
    sentry: 'sentry-hook-signature',
    stripe: 'stripe-signature',
  };
  for (const parser of Object.keys(sigHeader)) {
    state.parser = parser;
    const calls = stubFetch(verified);
    const result = await testWebhook('demo');
    mock.restoreAll();
    assert.deepEqual(result, {
      name: 'demo',
      ok: true,
      status: 200,
      url: 'https://relay.example/hook/dev1/webhook/demo',
    });
    const { url, init } = calls[0];
    assert.equal(url, result.url);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-mixdog-webhook-test'], '1');
    assert.equal(init.headers['content-type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.mixdogWebhookTest, true);
    assert.equal(body.webhook, 'demo');
    const sig = init.headers[sigHeader[parser]];
    const value = parser === 'github' || parser === 'generic' ? sig.replace('sha256=', '') : sig;
    assert.equal(verifySignature(SECRET, Buffer.from(init.body), value, parser), true);
    assert.equal(init.headers['x-github-event'], parser === 'github' ? 'ping' : undefined);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('testWebhook reports errors, missing endpoint and missing relay', async () => {
  state.parser = 'github';
  stubFetch(() => new Response(JSON.stringify({ error: 'invalid signature' }), { status: 401 }));
  assert.deepEqual(await testWebhook('demo'), {
    name: 'demo',
    ok: false,
    status: 401,
    url: 'https://relay.example/hook/dev1/webhook/demo',
    code: 'rejected',
    error: 'invalid signature',
  });
  mock.restoreAll();
  stubFetch(() => {
    throw new Error('boom');
  });
  const net = await testWebhook('demo');
  assert.equal(net.ok, false);
  assert.equal(net.status, 0);
  assert.equal(net.code, 'network');
  assert.match(net.error, /boom/);
  mock.restoreAll();
  stubFetch(() => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  });
  assert.equal((await testWebhook('demo')).code, 'timeout');
  mock.restoreAll();
  // Headers arrived but the body read timed out: still a timeout, not "rejected".
  stubFetch(() => ({
    status: 200,
    text: async () => {
      throw Object.assign(new Error('body timed out'), { name: 'TimeoutError' });
    },
  }));
  assert.equal((await testWebhook('demo')).code, 'timeout');
  mock.restoreAll();

  await assert.rejects(() => testWebhook('missing'), /webhook "missing" does not exist/);
  state.base = '';
  assert.deepEqual(await testWebhook('demo'), {
    name: 'demo',
    ok: false,
    status: 0,
    url: '',
    code: 'relay-unavailable',
    error: 'Endpoint URL is not available yet — the relay is not connected.',
  });
});
