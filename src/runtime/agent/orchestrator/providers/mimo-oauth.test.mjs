import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mimo-provider-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(dir, 'mimo-oauth.json');

const { MimoOAuthProvider } = await import('./mimo-oauth.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('lists models from the stored base URL with bearer key and source header', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, source: req.headers['x-mimo-source'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-pro' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(
      process.env.MIMO_OAUTH_CREDENTIALS_PATH,
      JSON.stringify({ apiKey: 'sk-1', uid: 'u', baseUrl: `http://127.0.0.1:${server.address().port}/v1` })
    );
    const provider = new MimoOAuthProvider({ preconnect: false });
    const models = await provider.listModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['mimo-v2.6-pro']
    );
    assert.deepEqual(seen, [{ url: '/v1/models', auth: 'Bearer sk-1', source: 'mimocode-cli' }]);
  } finally {
    server.close();
  }
});

test('send without credentials asks for sign-in', async () => {
  rmSync(process.env.MIMO_OAUTH_CREDENTIALS_PATH, { force: true });
  const provider = new MimoOAuthProvider({ preconnect: false });
  await assert.rejects(provider.send([], 'mimo-v2.6-pro', [], {}), /sign in/);
});
