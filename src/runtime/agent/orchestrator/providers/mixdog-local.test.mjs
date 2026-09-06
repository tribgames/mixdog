import assert from 'node:assert/strict';
import test from 'node:test';
import { MixdogLocalProvider } from './mixdog-local.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';

import {
  disableProvider,
  getProvider,
  initProviders,
} from './registry.mjs';

test('mixdog-local registers as a first-party provider and explicit disable removes it', async () => {
  await initProviders({
    'mixdog-local': { enabled: true },
  });
  assert.equal(getProvider('mixdog-local')?.name, 'mixdog-local');
  assert.equal(disableProvider('mixdog-local'), true);
  assert.equal(getProvider('mixdog-local'), undefined);
});

test('different local provider instances share a single inference slot before transport begins', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached = 0;
  const originalSend = OpenAICompatProvider.prototype.send;
  OpenAICompatProvider.prototype.send = async () => { reached++; if (reached === 1) await held; return { content: 'ok' }; };
  try {
    const options = { ensureServer: async () => ({ baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'not-used' }) };
    const a = new MixdogLocalProvider({}, options);
    const b = new MixdogLocalProvider({}, options);
    const first = a.send([{ role: 'user', content: 'one' }], 'model', [], {});
    const second = b.send([{ role: 'user', content: 'two' }], 'model', [], {});
    await new Promise(setImmediate);
    assert.equal(reached, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(reached, 2);
  } finally {
    release();
    OpenAICompatProvider.prototype.send = originalSend;
  }
});
