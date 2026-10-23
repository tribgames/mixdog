import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUserAgentOverride, rememberBrowserIdentity } from './browser-identity.ts';
import { browserAcceptLanguages, browserPartitionUserAgent } from './user-agent.ts';

const ELECTRON_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog-desktop/0.9.171 Chrome/146.0.7680.216 Electron/41.10.6 Safari/537.36';
// Chrome sends the reduced form: the major version, the rest zeroed.
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

test('the language list is the one Chrome seeds from the system languages', () => {
  assert.equal(browserAcceptLanguages(['ko-KR', 'en-US']), 'ko-KR,ko,en-US,en');
  assert.equal(browserAcceptLanguages(['en', 'en-GB']), 'en,en-GB');
  assert.equal(browserAcceptLanguages([]), '');
});

test("the partition's own agent string is never overridden per page; a locale changes only the language", () => {
  rememberBrowserIdentity({ userAgent: CHROME });
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' }, 'the session already sends it');
  // An override restating the string without metadata would empty the page's
  // brands (no client hints); the empty string leaves the engine's own.
  const own = browserUserAgentOverride(CHROME, 'fr-FR');
  assert.deepEqual(own, { userAgent: '', acceptLanguage: 'fr-FR' });
  assert.doesNotMatch(JSON.stringify(own), /Google Chrome/);
  assert.deepEqual(browserUserAgentOverride('Custom/2.0', 'fr-FR'), {
    userAgent: 'Custom/2.0',
    acceptLanguage: 'fr-FR',
  });
});

test('a page is told the Chrome build rendering it, not the app embedding it', () => {
  const agent = browserPartitionUserAgent(ELECTRON_DEFAULT);
  assert.equal(agent, CHROME, 'the agent string must match the client hints this partition sends');
  assert.doesNotMatch(agent, /mixdog|electron/i, 'an app version is a fingerprint sites never need');
});

test('the product token is stripped whatever the app name is', () => {
  for (const product of ['Mixdog/1.2.3', 'MixdogDev/1.2.3', 'mixdog-desktop/0.9.171']) {
    const agent = browserPartitionUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${product} Chrome/146.0.7680.216 Electron/41.10.6 Safari/537.36`
    );
    assert.equal(agent, CHROME, product);
  }
});

test('an agent string that already names Chrome alone is left untouched', () => {
  assert.equal(browserPartitionUserAgent(CHROME), CHROME);
});
