import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

const here = (path) => new URL(path, import.meta.url).href;
const statuses = [];
mock.module(here('../../../shared/webhooks-db.mjs'), {
  namedExports: {
    loadEndpointConfig: async () => ({ enabled: true }),
    readEndpointSecret: async () => null,
    claimDelivery: async () => ({ claimed: true }),
    updateDeliveryStatus: async (_name, _id, status, fields) => statuses.push({ status, fields }),
  },
});
mock.module(here('./log.mjs'), { namedExports: { logWebhook: () => {} } });
const { createWebhookRequestHandler } = await import('./request-handler.mjs');

async function post(body, handleWebhook) {
  const req = new EventEmitter();
  req.url = '/webhook/demo';
  req.headers = { 'content-type': 'application/json' };
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
    verifyRequest: () => true,
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

test('a failure after parsing is a server error, not invalid JSON', async () => {
  statuses.length = 0;
  const res = await post('{"ok":true}', async () => {
    throw new Error('dispatch store unavailable');
  });
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
  assert.deepEqual(statuses.at(-1), { status: 'failed', fields: { error: 'dispatch store unavailable' } });
});
