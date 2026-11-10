import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

const here = (path) => new URL(path, import.meta.url).href;
const statuses = [];
const claims = { count: 0 };
const secretState = { value: null };
mock.module(here('../webhooks-db.mjs'), {
  namedExports: {
    loadEndpointConfig: async () => ({ enabled: true }),
    readEndpointSecret: async () => secretState.value,
    claimDelivery: async () => {
      claims.count += 1;
      return { claimed: true };
    },
    updateDeliveryStatus: async (_name, _id, status, fields) => statuses.push({ status, fields }),
  },
});
mock.module(here('./log.mjs'), { namedExports: { logWebhook: () => {} } });
const { createWebhookRequestHandler } = await import('./request-handler.mjs');

async function post(body, handleWebhook, { headers = {}, verifyRequest = () => true } = {}) {
  const req = new EventEmitter();
  req.url = '/webhook/demo';
  req.headers = { 'content-type': 'application/json', ...headers };
  req.destroy = () => {};
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = text;
    },
  };
  const handler = createWebhookRequestHandler({
    getConfig: () => ({}),
    verifyRequest,
    handleWebhook,
  });
  const done = handler.handlePost(req, res);
  setImmediate(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  await done;
  return res;
}

test('a malformed JSON body is answered 400 invalid JSON', async () => {
  statuses.length = 0;
  const res = await post('{not json', async () => assert.fail('an unparsable body must not be handled'));
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid JSON' });
  assert.match(statuses.at(-1).fields.error, /^invalid JSON: /);
});

const PROBE_BODY = '{"mixdogWebhookTest":true}';
const PROBE_HEADERS = { 'x-mixdog-webhook-test': '1' };

test('a signed test probe (header + body marker) is answered verified without claim or dispatch', async (t) => {
  t.after(() => {
    secretState.value = null;
  });
  secretState.value = 'k';
  statuses.length = 0;
  claims.count = 0;
  const res = await post(PROBE_BODY, async () => assert.fail('a test request must not dispatch'), {
    headers: PROBE_HEADERS,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'verified', test: true });
  assert.equal(claims.count, 0);
  assert.equal(statuses.length, 0);
});

test('a probe accepted without a signing secret is never reported verified', async () => {
  claims.count = 0;
  const res = await post(PROBE_BODY, async () => assert.fail('must not dispatch'), { headers: PROBE_HEADERS });
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'test requires a signing secret' });
  assert.equal(claims.count, 0);
});

test('the test header or body marker alone is rejected and never dispatches', async (t) => {
  t.after(() => {
    secretState.value = null;
  });
  secretState.value = 'k';
  claims.count = 0;
  const headerOnly = await post('{"action":"opened"}', async () => assert.fail('must not dispatch'), {
    headers: PROBE_HEADERS,
  });
  const markerOnly = await post(PROBE_BODY, async () => assert.fail('must not dispatch'));
  // An escaped key spelling is the same JSON property and is still caught.
  const escapedMarker = await post('{"mixdogWebhookTes\\u0074":true}', async () => assert.fail('must not dispatch'));
  for (const res of [headerOnly, markerOnly, escapedMarker]) {
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid test request' });
  }
  assert.equal(claims.count, 0);
});

test('a test-header request that fails verification is still rejected', async () => {
  claims.count = 0;
  const res = await post(PROBE_BODY, async () => assert.fail('must not dispatch'), {
    headers: { 'x-mixdog-webhook-test': '1' },
    verifyRequest: ({ res: r }) => {
      r.writeHead(401);
      r.end(JSON.stringify({ error: 'invalid signature' }));
      return false;
    },
  });
  assert.equal(res.status, 401);
  assert.equal(claims.count, 0);
});

test('a failure after parsing is a server error, not invalid JSON', async () => {
  statuses.length = 0;
  const res = await post('{"ok":true}', async () => {
    throw new Error('dispatch store unavailable');
  });
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
  assert.deepEqual(statuses.at(-1), { status: 'failed', fields: { error: 'dispatch store unavailable' } });
});
