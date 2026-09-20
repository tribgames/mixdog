import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { createWebhookVerifier } from './verification.mjs';

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('webhook verification preserves signed and unsigned gate responses', () => {
  let warned = false;
  const verifier = createWebhookVerifier({
    getConfig: () => ({ endpoints: {} }),
    isWarningShown: () => warned,
    markWarningShown: () => {
      warned = true;
    },
  });
  const body = Buffer.from('{"ok":true}');
  const signature = createHmac('sha256', 'secret').update(body).digest('hex');
  const signedResponse = response();

  assert.equal(
    verifier({
      name: 'demo',
      endpoint: { parser: 'generic' },
      isTableEndpoint: true,
      secret: 'secret',
      body,
      headers: { 'x-signature-256': `sha256=${signature}` },
      res: signedResponse,
    }),
    true
  );
  assert.equal(signedResponse.status, 0);

  const invalidResponse = response();
  assert.equal(
    verifier({
      name: 'demo',
      endpoint: { parser: 'generic' },
      isTableEndpoint: true,
      secret: 'secret',
      body,
      headers: { 'x-signature-256': 'sha256=invalid' },
      res: invalidResponse,
    }),
    false
  );
  assert.equal(invalidResponse.status, 403);
  assert.deepEqual(JSON.parse(invalidResponse.body), { ok: false, error: 'invalid signature' });

  const unsignedResponse = response();
  assert.equal(
    verifier({
      name: 'demo',
      endpoint: { allowUnsigned: true },
      isTableEndpoint: false,
      secret: null,
      body,
      headers: {},
      res: unsignedResponse,
    }),
    true
  );
  assert.equal(warned, true);
});
