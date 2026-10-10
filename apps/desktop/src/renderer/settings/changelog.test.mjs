import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { localizeReleases, parseChangelog, selectWhatsNew } from './changelog.ts';
import { SEEN_VERSION_KEY, takeWhatsNew } from './whats-new.ts';

const release = (version, body) => ({ version, date: '2026-10-01', body });

test('localizeReleases uses the translated section per version and falls back to English', () => {
  const english = [release('v1.0.2', 'new'), release('v1.0.1', 'mid'), release('v1.0.0', 'old')];
  const localized = [release('v1.0.1', 'mitte'), release('v1.0.0', 'alt'), release('v0.9.0', 'extra')];
  assert.deepEqual(
    localizeReleases(english, localized).map((entry) => entry.body),
    ['new', 'mitte', 'alt']
  );
  assert.deepEqual(localizeReleases(english, []), english);
});

test('selectWhatsNew finds the running version only', () => {
  const releases = [release('v1.0.2', 'new'), release('v1.0.1', 'mid')];
  assert.equal(selectWhatsNew(releases, '1.0.1')?.body, 'mid');
  assert.equal(selectWhatsNew(releases, '1.0.3'), undefined);
});

test('takeWhatsNew announces a version once after an update, never on a fresh install', () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.equal(takeWhatsNew(storage, '1.0.1'), false, 'fresh install');
  assert.equal(data.get(SEEN_VERSION_KEY), '1.0.1');
  assert.equal(takeWhatsNew(storage, '1.0.1'), false, 'same version');
  assert.equal(takeWhatsNew(storage, '1.0.2'), true, 'first launch after update');
  assert.equal(takeWhatsNew(storage, '1.0.2'), false, 'only once');
  assert.equal(takeWhatsNew(undefined, '1.0.2'), false);
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => undefined,
  };
  assert.equal(takeWhatsNew(broken, '1.0.2'), false);
});

test('parseChangelog returns released sections with their dates and skips Unreleased', () => {
  const text = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '- Pending change.',
    '',
    '## v1.0.2 - 2026-10-08',
    '',
    '- Fixed `thing`.',
    '  Continued line.',
    '',
    '## v1.0.1',
    '',
    '- Undated release.',
    '',
    '## v1.0.0 - 2026-10-01',
    '',
  ].join('\r\n');
  assert.deepEqual(parseChangelog(text), [
    { version: 'v1.0.2', date: '2026-10-08', body: '- Fixed `thing`.\r\n  Continued line.' },
    { version: 'v1.0.1', date: '', body: '- Undated release.' },
  ]);
});

test('the repository CHANGELOG.md parses into dated releases', () => {
  const releases = parseChangelog(readFileSync(new URL('../../../../../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.ok(releases.length > 0);
  for (const release of releases) {
    assert.match(release.version, /^v\d/);
    assert.ok(release.body);
  }
  assert.match(releases[0].date, /^\d{4}-\d{2}-\d{2}$/);
});
