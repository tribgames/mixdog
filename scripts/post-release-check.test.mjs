import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ASSET_CONTRACT,
  checkAssetSet,
  checkEffortJudge,
  checkFeed,
  checkLatest,
  checkRelayApp,
  detectPublished,
  getReleaseByTag,
  waitForNpm,
} from './post-release-check.mjs';

const VERSION = '1.2.3';
const sha = (name) => createHash('sha512').update(name).digest('base64');
const SIZE = 100;
const asset = (name, extra = {}) => ({ name, size: SIZE, state: 'uploaded', ...extra });
const assets = ASSET_CONTRACT.map((name) => asset(name));
const hashAsset = async (a) => sha(a.name);

function macFeed({ version = VERSION, sha512 = sha, size = SIZE, omit = [], top = 'mixdog-desktop-mac-x64.zip' } = {}) {
  const names = [
    'mixdog-desktop-mac-arm64.zip',
    'mixdog-desktop-mac-arm64.dmg',
    'mixdog-desktop-mac-x64.zip',
    'mixdog-desktop-mac-x64.dmg',
  ].filter((name) => !omit.includes(name));
  return [
    `version: ${version}`,
    'files:',
    ...names.flatMap((name) => [`  - url: ${name}`, `    sha512: ${sha512(name)}`, `    size: ${size}`]),
    `path: ${top}`,
    `sha512: ${sha(top)}`,
    "releaseDate: '2025-01-01T00:00:00.000Z'",
    '',
  ].join('\n');
}
const MAC_ZIPS = ['mixdog-desktop-mac-arm64.zip', 'mixdog-desktop-mac-x64.zip'];
const checkMac = (text, overrides = {}) =>
  checkFeed({
    text,
    label: 'latest-mac.yml',
    version: VERSION,
    assets,
    hashAsset,
    requiredFiles: MAC_ZIPS,
    ...overrides,
  });

// Source-text on purpose: the verifying script is inline in workflow YAML that
// only runs on GitHub, so its checked-in text is the only surface to compare.
test('the asset contract matches the exact set release.yml verifies', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const block = /const requirements = \{([\s\S]*?)\s*\};\s*const expected/.exec(release)[1];
  const names = [...block.replace(/\/\/.*/g, '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...ASSET_CONTRACT].sort(), names.sort());
});

test('Latest must be the new app tag', () => {
  assert.deepEqual(checkLatest('v1.2.3', 'v1.2.3'), []);
  assert.match(checkLatest('v1.2.3', 'mobile-v0.1.12')[0], /Latest is mobile-v0\.1\.12, expected v1\.2\.3/);
  assert.match(checkLatest('v1.2.3', null)[0], /Latest is none/);
});

test('the asset set must be complete, exact and uploaded', () => {
  assert.deepEqual(checkAssetSet(assets), []);
  assert.deepEqual(checkAssetSet(assets.filter((a) => a.name !== 'latest-mac.yml')), [
    'missing release asset latest-mac.yml',
  ]);
  assert.deepEqual(checkAssetSet([...assets, asset('extra.bin')]), ['unexpected release asset extra.bin']);
  assert.match(
    checkAssetSet(assets.map((a) => (a.name === 'latest.yml' ? { ...a, state: 'starter' } : a)))[0],
    /incomplete release asset latest\.yml/
  );
});

test('a latest-mac.yml matching the uploaded assets passes', async () => {
  assert.deepEqual(await checkMac(macFeed()), []);
});

test('latest-mac.yml fails on version, missing zip, unknown file, size and sha512 mismatches', async () => {
  assert.match((await checkMac(macFeed({ version: '1.2.2' })))[0], /version 1\.2\.2, expected 1\.2\.3/);
  const noArm = await checkMac(macFeed({ omit: ['mixdog-desktop-mac-arm64.zip'] }));
  assert.deepEqual(noArm, ['latest-mac.yml: files[] does not list mixdog-desktop-mac-arm64.zip']);
  const missingAsset = await checkMac(macFeed(), {
    assets: assets.filter((a) => a.name !== 'mixdog-desktop-mac-x64.dmg'),
  });
  assert.deepEqual(missingAsset, ['latest-mac.yml: mixdog-desktop-mac-x64.dmg is not an uploaded asset']);
  const badSize = await checkMac(macFeed({ size: 99 }));
  assert.equal(badSize.length, 4);
  assert.match(badSize[0], /size 99 != uploaded 100/);
  const badHash = await checkMac(macFeed({ sha512: (name) => (name.endsWith('arm64.zip') ? 'stale==' : sha(name)) }));
  assert.deepEqual(badHash, ['latest-mac.yml: mixdog-desktop-mac-arm64.zip sha512 does not match the uploaded asset']);
  const badTop = await checkMac(macFeed({ top: 'mixdog-desktop-mac-x64.exe' }));
  assert.deepEqual(badTop, ['latest-mac.yml: path mixdog-desktop-mac-x64.exe is not listed in files[]']);
});

test('an unparseable feed is reported, not thrown', async () => {
  assert.match((await checkMac('files:\n  - bogus\n'))[0], /unsupported line|missing/);
});

test('npm resolution retries with backoff until the package appears', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchFn = async () =>
    ++calls < 4 ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => ({ version: VERSION }) };
  assert.deepEqual(
    await waitForNpm({ name: 'mixdog', version: VERSION, fetchFn, sleep: async (ms) => sleeps.push(ms) }),
    []
  );
  assert.deepEqual(sleeps, [5000, 10_000, 20_000]);
});

test('npm resolution gives up once the time budget is spent', async () => {
  const sleeps = [];
  const problems = await waitForNpm({
    name: 'mixdog',
    version: VERSION,
    fetchFn: async () => ({ ok: false, status: 404 }),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(
    sleeps.reduce((a, b) => a + b, 0),
    600_000
  );
  assert.match(problems[0], /mixdog@1\.2\.3 not resolvable on npm after 600s \(HTTP 404\)/);
});

const page =
  (body, status = 200) =>
  async (url) =>
    url.endsWith('/app') ? { status, ok: status === 200, text: async () => body } : { status: 200, ok: true };

test('relay /app must be 200 and link an existing published mobile release', async () => {
  const body = '<a href="https://github.com/o/r/releases/tag/mobile-v0.1.12">Android</a>';
  const releases = { 'mobile-v0.1.12': { draft: false } };
  const getRelease = (tag) => releases[tag] ?? null;
  assert.deepEqual(await checkRelayApp({ domain: 'd', fetchFn: page(body), getRelease }), {
    problems: [],
    warnings: [],
  });
  assert.match(
    (await checkRelayApp({ domain: 'd', fetchFn: page(body, 502), getRelease })).problems[0],
    /answered 502/
  );
  assert.match((await checkRelayApp({ domain: 'd', fetchFn: page('<p>none</p>'), getRelease })).problems[0], /no link/);
  assert.match(
    (await checkRelayApp({ domain: 'd', fetchFn: page(body), getRelease: () => null })).problems[0],
    /not an existing release/
  );
  assert.match(
    (await checkRelayApp({ domain: 'd', fetchFn: page(body), getRelease: () => ({ draft: true }) })).problems[0],
    /still a draft/
  );
});

test('relay /app keeping the previous good mobile release is a warning, not an error', async () => {
  const body = '<a href="https://github.com/o/r/releases/tag/mobile-v0.1.12">Android</a>';
  const getRelease = (tag) => (tag === 'mobile-v0.1.12' ? { draft: false } : null);
  const kept = await checkRelayApp({ domain: 'd', fetchFn: page(body), getRelease, mobileVersion: '0.1.13' });
  assert.deepEqual(kept.problems, []);
  assert.match(kept.warnings[0], /links mobile-v0\.1\.12 instead of mobile-v0\.1\.13.*previous good release kept/);
  const same = await checkRelayApp({ domain: 'd', fetchFn: page(body), getRelease, mobileVersion: '0.1.12' });
  assert.deepEqual(same, { problems: [], warnings: [] });
  const list = await checkRelayApp({
    domain: 'd',
    fetchFn: page('<a href="https://github.com/o/r/releases">x</a>'),
    getRelease,
    mobileVersion: '0.1.13',
  });
  assert.deepEqual(list.problems, []);
  assert.match(list.warnings[0], /mobile-v0\.1\.13 was not shipped/);
  // A previous release that vanished is still a hard error.
  const gone = await checkRelayApp({
    domain: 'd',
    fetchFn: page(body),
    getRelease: () => null,
    mobileVersion: '0.1.13',
  });
  assert.match(gone.problems[0], /not an existing release/);
});

test('effort-judge release must exist, be published, not be Latest, and carry the manifest files', () => {
  const manifest = { release: 'effort-judge-v6', files: { 'model.onnx': { size: 5 } } };
  const good = { draft: false, assets: [{ name: 'model.onnx', size: 5 }] };
  assert.deepEqual(checkEffortJudge({ manifest, latestTag: 'v1.2.3', getRelease: () => good }), []);
  assert.match(checkEffortJudge({ manifest, latestTag: 'v1.2.3', getRelease: () => null })[0], /does not exist/);
  assert.match(
    checkEffortJudge({ manifest, latestTag: 'effort-judge-v6', getRelease: () => good })[0],
    /is GitHub Latest/
  );
  assert.match(
    checkEffortJudge({ manifest, latestTag: 'v1', getRelease: () => ({ ...good, draft: true }) })[0],
    /is a draft/
  );
  assert.match(
    checkEffortJudge({ manifest, latestTag: 'v1', getRelease: () => ({ draft: false, assets: [] }) })[0],
    /lacks model\.onnx/
  );
});

test('getReleaseByTag maps only 404/not-found to null and rethrows everything else', () => {
  const failing = (stderr) => () => {
    throw Object.assign(new Error('Command failed'), { stderr });
  };
  assert.equal(getReleaseByTag('o/r', 'v1.2.3', failing('gh: Not Found (HTTP 404)')), null);
  // "not found" wording without an explicit 404 status is not absence.
  assert.throws(
    () => getReleaseByTag('o/r', 'v1.2.3', failing('upstream resource not found (HTTP 500)')),
    /Command failed/
  );
  assert.throws(() => getReleaseByTag('o/r', 'v1.2.3', failing('gh: Not Found')), /Command failed/);
  assert.throws(() => getReleaseByTag('o/r', 'v1.2.3', failing('gh: Bad credentials (HTTP 401)')), /Command failed/);
  assert.throws(() => getReleaseByTag('o/r', 'v1.2.3', failing('gh: Bad Gateway (HTTP 502)')), /Command failed/);
  assert.throws(() => getReleaseByTag('o/r', 'v1.2.3', failing('dial tcp: i/o timeout')), /Command failed/);
  assert.deepEqual(
    getReleaseByTag('o/r', 'v1.2.3', () => '{"draft":false}'),
    { draft: false }
  );
});

test('detectPublished: published, draft and absent are definite answers without retries', async () => {
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  assert.equal(await detectPublished({ fetchRelease: () => ({ draft: false }), sleep }), true);
  assert.equal(await detectPublished({ fetchRelease: () => ({ draft: true }), sleep }), false);
  assert.equal(await detectPublished({ fetchRelease: () => null, sleep }), false);
  assert.deepEqual(sleeps, []);
});

test('detectPublished retries API errors with backoff, recovers, and otherwise fails', async () => {
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  let calls = 0;
  const flaky = () => {
    if (++calls < 3) throw new Error('HTTP 502');
    return { draft: false };
  };
  assert.equal(await detectPublished({ fetchRelease: flaky, sleep, firstDelayMs: 10 }), true);
  assert.deepEqual(sleeps, [10, 20]);

  sleeps.length = 0;
  let attempts = 0;
  await assert.rejects(
    detectPublished({
      fetchRelease: () => {
        attempts++;
        throw new Error('HTTP 401');
      },
      sleep,
      attempts: 4,
      firstDelayMs: 10,
    }),
    /after 4 attempts: HTTP 401/
  );
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [10, 20, 40]);
});
