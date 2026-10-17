import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUserAgentOverride, rememberBrowserIdentity, rememberEngineFacts } from './browser-identity.ts';
import {
  browserAcceptLanguages,
  browserBrandHeader,
  browserBrandList,
  browserBrandRequestHeaders,
  browserPartitionUserAgent,
} from './user-agent.ts';

const ELECTRON_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog-desktop/0.9.171 Chrome/146.0.7680.216 Electron/41.10.6 Safari/537.36';
// Chrome sends the reduced form: the major version, the rest zeroed.
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

test('the brand list is the one Chrome of the same version sends, GREASE included', () => {
  // Observed from Chrome 155.0.8059.80 on this machine.
  assert.equal(
    browserBrandHeader(browserBrandList('155.0.8059.80')),
    '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"'
  );
  assert.deepEqual(browserBrandList('155.0.8059.80', true), [
    { brand: 'Google Chrome', version: '155.0.8059.80' },
    { brand: 'Chromium', version: '155.0.8059.80' },
    { brand: 'Not(A:Brand', version: '24.0.0.0' },
  ]);
  // The engine's own list for 146 is `"Not-A.Brand";v="24", "Chromium";v="146"`:
  // the same seed spells the same GREASE brand, with Chrome's brand added.
  assert.equal(
    browserBrandHeader(browserBrandList('146.0.7680.216')),
    '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"'
  );
});

test('only the brand headers a request already carries are rewritten', () => {
  const headers = browserBrandRequestHeaders(
    { 'sec-ch-ua': '"Not-A.Brand";v="24", "Chromium";v="146"', 'Sec-CH-UA-Mobile': '?0', Accept: '*/*' },
    '146.0.7680.216'
  );
  assert.equal(headers['sec-ch-ua'], browserBrandHeader(browserBrandList('146.0.7680.216')));
  assert.equal(headers['Sec-CH-UA-Mobile'], '?0');
  assert.equal(Object.hasOwn(headers, 'sec-ch-ua-full-version-list'), false);
});

test('the language list is the one Chrome seeds from the system languages', () => {
  assert.equal(browserAcceptLanguages(['ko-KR', 'en-US']), 'ko-KR,ko,en-US,en');
  assert.equal(browserAcceptLanguages(['en', 'en-GB']), 'en,en-GB');
  assert.equal(browserAcceptLanguages([]), '');
});

test("only the partition's own agent string carries Chrome's client-hint metadata", () => {
  rememberBrowserIdentity({ userAgent: CHROME, acceptLanguages: 'ko-KR,ko' });
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' }, 'no metadata yet: the engine identity stands');
  rememberEngineFacts({ platform: '', platformVersion: '', architecture: '', model: '', mobile: false });
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' }, 'an overridden page teaches nothing');
  rememberEngineFacts({
    platform: 'Windows',
    platformVersion: '19.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
    formFactors: ['Desktop'],
  });
  const own = browserUserAgentOverride(CHROME);
  assert.equal(own.acceptLanguage, 'ko-KR,ko');
  assert.equal(own.userAgentMetadata.platformVersion, '19.0.0');
  assert.equal(
    own.userAgentMetadata.brands.some((entry) => entry.brand === 'Google Chrome'),
    true
  );
  assert.equal(own.userAgentMetadata.fullVersion, process.versions.chrome ?? own.userAgentMetadata.fullVersion);
  assert.deepEqual(browserUserAgentOverride('Custom/2.0', 'fr-FR'), {
    userAgent: 'Custom/2.0',
    acceptLanguage: 'fr-FR',
  });
  assert.equal(browserUserAgentOverride(CHROME, 'fr-FR').acceptLanguage, 'fr-FR', 'an emulated locale wins');
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
