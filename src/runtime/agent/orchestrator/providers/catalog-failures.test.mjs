import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { describeError } from '../../../shared/error-presentation.mjs';
import { boundedProviderCatalogOp, bumpProviderCatalogGeneration } from './catalog-deadline.mjs';
import { providerCatalogFailure } from './catalog-failures.mjs';
import { fetchCompatModelItems } from './openai-compat-models.mjs';

const KEY = 'sk-test-key-0123456789abcdef';
let server;
let baseURL;
let reply = { status: 200, body: '{}' };

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const list = (name) => {
  const provider = { name, baseURL, config: { apiKey: KEY }, defaultHeaders: {} };
  return boundedProviderCatalogOp({ name, provider, kind: 'list', run: () => fetchCompatModelItems(provider) });
};

test('an expired OpenCode Go key is recorded as an authentication failure with the provider reason', async () => {
  reply = {
    status: 401,
    body: JSON.stringify({
      error: {
        type: 'authentication_error',
        code: 'api_key_expired',
        message: 'This API key has expired. Create a new API key in OpenCode Console.',
      },
    }),
  };
  const outcome = await list('opencode-go');
  assert.equal(outcome.error.status, 401);
  assert.equal(outcome.error.message, 'opencode-go models 401');
  const failure = providerCatalogFailure('opencode-go');
  assert.equal(failure.errorKind.kind, 'auth');
  assert.equal(failure.errorKind.status, 401);
  assert.match(failure.message, /^opencode-go models 401: This API key has expired\./);
  assert.equal(describeError({ message: failure.message, errorKind: failure.errorKind }).kind, 'authentication');
  assert.equal(failure.message.includes(KEY), false);
});

test('an xAI 403 for spent credits keeps its reason and reads as a permission refusal', async () => {
  reply = {
    status: 403,
    body: JSON.stringify({
      code: 'permission-denied',
      error: 'Your team has either used all available credits or reached its monthly spending limit.',
    }),
  };
  await list('xai');
  const failure = providerCatalogFailure('xai');
  assert.equal(failure.errorKind.kind, 'permission');
  assert.match(failure.message, /^xai models 403: Your team has either used all available credits/);
});

test('a body that is not JSON still records the status', async () => {
  reply = { status: 502, body: '<html>bad gateway</html>' };
  await list('plain-502');
  const failure = providerCatalogFailure('plain-502');
  assert.equal(failure.message, 'plain-502 models 502');
  assert.equal(failure.errorKind.kind, 'transient');
});

test('credentials echoed by the provider are redacted from the recorded reason', async () => {
  reply = { status: 401, body: JSON.stringify({ error: { message: 'bad header Bearer abc.def-123 rejected' } }) };
  await list('echo');
  assert.equal(providerCatalogFailure('echo').message.includes('abc.def-123'), false);
  assert.match(providerCatalogFailure('echo').message, /Bearer \[redacted\]/);
});

test('the request key echoed whole or as a prefix is redacted from the retained provider error', async () => {
  reply = {
    status: 401,
    body: JSON.stringify({
      code: `invalid key ${KEY}`,
      error: `Incorrect API key provided: ${KEY.slice(0, 12)}****cdef. You can obtain an API key from the console.`,
    }),
  };
  const outcome = await list('echo-key');
  const { message, code } = outcome.error.providerError;
  for (const value of [message, code, providerCatalogFailure('echo-key').message]) {
    assert.equal(value.includes(KEY.slice(0, 8)), false, value);
  }
  assert.equal(message, 'Incorrect API key provided: [redacted]****cdef. You can obtain an API key from the console.');
  assert.equal(code, 'invalid key [redacted]');
});

test('a superseded operation never overwrites the current outcome with its late failure', async () => {
  const provider = {};
  const run = (name, extra) => boundedProviderCatalogOp({ name, provider, kind: 'list', timeoutMs: 1_000, ...extra });
  const lateFailure = Object.assign(new Error('models 401'), { status: 401 });

  // Across an account change.
  const oldAccount = Promise.withResolvers();
  const stale = run('switched', { run: () => oldAccount.promise });
  bumpProviderCatalogGeneration();
  assert.deepEqual(await run('switched', { run: () => ['m1'] }), { value: ['m1'] });
  oldAccount.reject(lateFailure);
  assert.equal((await stale).error, lateFailure);
  assert.equal(providerCatalogFailure('switched'), null);

  // Within one generation, replaced by a newer catalog revision.
  const oldRevision = Promise.withResolvers();
  const replaced = run('revised', { run: () => oldRevision.promise, epoch: 'r1' });
  assert.deepEqual(await run('revised', { run: () => ['m2'], epoch: 'r2' }), { value: ['m2'] });
  oldRevision.reject(lateFailure);
  assert.equal((await replaced).error, lateFailure);
  assert.equal(providerCatalogFailure('revised'), null);
});

test('the provider answering again clears its failure; an account change clears every failure', async () => {
  reply = { status: 401, body: '{}' };
  await list('flaky');
  await list('other');
  assert.ok(providerCatalogFailure('flaky'));
  reply = { status: 200, body: JSON.stringify({ data: [{ id: 'm1' }] }) };
  assert.deepEqual((await list('flaky')).value, [{ id: 'm1' }]);
  assert.equal(providerCatalogFailure('flaky'), null);
  assert.ok(providerCatalogFailure('other'));
  bumpProviderCatalogGeneration();
  assert.equal(providerCatalogFailure('other'), null);
});
