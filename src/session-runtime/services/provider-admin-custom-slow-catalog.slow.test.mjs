import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock, after } from 'node:test';

const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', { namedExports: { ...original } });

const admin = await import('./provider-admin.mjs');

const KEY = 'sk-slow-catalog-123456';
const DELAY_MS = 15_000;
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ path: new URL(req.url, 'http://x').pathname, headers: req.headers });
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'slow/model-a' }, { id: 'slow/model-b' }] }));
  }, DELAY_MS);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(
  () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
);

test('a trailing-space base URL discovers a 15 s catalog (slower than the old 10 s limit), sending the key', async () => {
  const cfg = { loadConfig: () => ({ providers: {} }), saveConfig: () => {} };
  const result = await admin.discoverCustomProviderModels(cfg, {
    name: 'Slow catalog',
    protocol: 'openai-chat',
    baseURL: `http://127.0.0.1:${server.address().port}/v1 `,
    apiKey: KEY,
    models: [],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['slow/model-a', 'slow/model-b']
  );
  const listing = requests.filter((r) => r.path === '/v1/models');
  assert.equal(listing.length, 1);
  assert.equal(listing[0].headers.authorization, `Bearer ${KEY}`);
});
