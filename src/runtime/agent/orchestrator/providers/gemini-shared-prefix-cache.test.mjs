import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiProvider } from './gemini.mjs';
import { _geminiCachePrefixHash, _geminiCredentialFingerprint } from './gemini-cache.mjs';

const MODEL = 'gemini-2.5-pro';
const API_KEY = 'gemini-test-key';
// Long enough to clear the explicit-cache minimum, so a regular request creates.
const SYSTEM = 'You are the Lead. '.repeat(20_000);
const CONTENTS = [
  { role: 'user', parts: [{ text: 'Refactor the parser.' }] },
  { role: 'model', parts: [{ text: 'Reading.' }] },
  { role: 'user', parts: [{ text: '<side-question>Where?</side-question>' }] },
];

function provider() {
  const gemini = new GeminiProvider({});
  const creates = [];
  gemini._joinOrCreateGeminiCache = async (args) => {
    creates.push(args);
    return 'cachedContents/created';
  };
  return { gemini, creates };
}

function ensure(gemini, opts) {
  return gemini._ensureGeminiCache({
    apiKey: API_KEY,
    model: MODEL,
    systemInstruction: SYSTEM,
    geminiTools: [],
    toolConfig: null,
    contents: CONTENTS,
    opts,
  });
}

function sessionCache({ expiresInMs = 60_000, createdAtIter = 1 } = {}) {
  return {
    gemini: {
      cacheName: 'cachedContents/session',
      cacheModel: MODEL,
      cacheCredentialFingerprint: _geminiCredentialFingerprint(API_KEY),
      cacheExpiresAt: Date.now() + expiresInMs,
      cacheCreatedAtIter: createdAtIter,
      cachePrefixContentCount: 1,
      cachePrefixHash: _geminiCachePrefixHash({
        model: MODEL,
        systemInstruction: SYSTEM,
        geminiTools: [],
        toolConfig: null,
        contents: CONTENTS,
        prefixCount: 1,
      }),
    },
  };
}

const FORK = { sharedCachePrefixCount: 1 };

test('a regular request creates the explicit cache the fork must not', async () => {
  const { gemini, creates } = provider();
  assert.equal(await ensure(gemini, { iteration: 1 }), 'cachedContents/created');
  assert.equal(creates.length, 1);
});

test('a forked request without a live session cache goes uncached and creates none', async () => {
  for (const providerState of [undefined, sessionCache({ expiresInMs: -1_000 })]) {
    const { gemini, creates } = provider();
    assert.equal(await ensure(gemini, { ...FORK, iteration: 1, providerState }), null);
    assert.equal(creates.length, 0);
  }
});

test('a forked request reuses the live session cache even when a refresh is due', async () => {
  const { gemini, creates } = provider();
  // Ten iterations past creation: a regular request would rebuild here.
  const opts = { ...FORK, iteration: 11, providerState: sessionCache({ createdAtIter: 1 }) };
  assert.equal(await ensure(gemini, opts), 'cachedContents/session');
  assert.equal(creates.length, 0);
});
