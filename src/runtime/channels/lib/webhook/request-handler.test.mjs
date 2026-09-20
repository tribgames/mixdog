import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { collectRawBody, MAX_BODY_BYTES, parseEndpointName } from './request-handler.mjs';

function response() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('webhook request parsing decodes endpoint names and preserves raw body bytes', async () => {
  assert.deepEqual(parseEndpointName('/webhook/demo?source=test'), {
    rawName: 'demo',
    name: 'demo',
  });
  assert.deepEqual(parseEndpointName('/webhook/%E2%9C%93'), {
    rawName: '%E2%9C%93',
    name: '✓',
  });

  const req = new EventEmitter();
  const res = response();
  req.destroy = () => {};
  const body = Buffer.from([0xe2, 0x82, 0xac, 0x00, 0xff]);
  const received = collectRawBody(req, res);
  req.emit('data', body.subarray(0, 2));
  req.emit('data', body.subarray(2));
  req.emit('end');
  assert.deepEqual(await received, body);
  assert.equal(res.status, 0);
});

test('webhook request parsing rejects bodies beyond the wire cap', async () => {
  const req = new EventEmitter();
  const res = response();
  let destroyed = false;
  req.destroy = () => {
    destroyed = true;
  };
  const received = collectRawBody(req, res);
  req.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
  assert.equal(await received, null);
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.body), { error: 'payload too large', limit: MAX_BODY_BYTES });
  assert.equal(destroyed, true);
});
