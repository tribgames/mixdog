import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUserAgentOverride, rememberBrowserIdentity, rememberEngineFacts } from './browser-identity.ts';
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

test("the partition's own agent string is never overridden per page; a locale restates the engine's own hints", () => {
  const engineBrands = [
    { brand: 'Not-A.Brand', version: '24' },
    { brand: 'Chromium', version: '146' },
  ];
  rememberBrowserIdentity({ userAgent: CHROME });
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' }, 'the session already sends it');
  assert.deepEqual(
    browserUserAgentOverride(CHROME, 'fr-FR'),
    { userAgent: CHROME, acceptLanguage: 'fr-FR' },
    'no facts yet: nothing to restate'
  );
  rememberEngineFacts({ platform: '', platformVersion: '', architecture: '', model: '', mobile: false });
  rememberEngineFacts({
    brands: [],
    platform: 'Windows',
    platformVersion: '19.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
  });
  assert.equal(
    Object.hasOwn(browserUserAgentOverride(CHROME, 'fr-FR'), 'userAgentMetadata'),
    false,
    'an overridden page (empty brands) teaches nothing'
  );
  rememberEngineFacts({
    brands: engineBrands,
    fullVersionList: [
      { brand: 'Not-A.Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: '146.0.7680.216' },
    ],
    platform: 'Windows',
    platformVersion: '19.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
    formFactors: ['Desktop'],
  });
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' }, 'still no per-page override');
  const own = browserUserAgentOverride(CHROME, 'fr-FR');
  assert.equal(own.acceptLanguage, 'fr-FR');
  assert.equal(own.userAgentMetadata.platformVersion, '19.0.0');
  assert.deepEqual(own.userAgentMetadata.brands, engineBrands, "the engine's own brands, no Google Chrome");
  assert.doesNotMatch(JSON.stringify(own), /Google Chrome/);
  assert.equal(own.userAgentMetadata.fullVersion, process.versions.chrome ?? own.userAgentMetadata.fullVersion);
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
