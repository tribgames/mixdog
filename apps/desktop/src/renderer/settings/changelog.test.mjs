import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { localizeReleases, parseChangelog, selectWhatsNew } from './changelog.ts';
import { markWhatsNewSeen, peekWhatsNew, SEEN_VERSION_KEY } from './whats-new.ts';

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

const memoryStorage = (initial) => {
  const data = new Map(initial === undefined ? [] : [[SEEN_VERSION_KEY, initial]]);
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('a fresh install records the version silently and announces nothing', () => {
  const storage = memoryStorage();
  assert.equal(peekWhatsNew(storage, '2.0.1'), 'fresh-install');
  assert.equal(storage.data.get(SEEN_VERSION_KEY), '2.0.1');
  assert.equal(peekWhatsNew(storage, '2.0.1'), 'current');
});

test('an update is pending until marked seen, and then shows once', () => {
  const storage = memoryStorage('2.1.0');
  assert.equal(peekWhatsNew(storage, '2.1.1'), 'pending');
  assert.equal(storage.data.get(SEEN_VERSION_KEY), '2.1.0', 'peeking leaves the stored version alone');
  markWhatsNewSeen(storage, '2.1.1');
  assert.equal(storage.data.get(SEEN_VERSION_KEY), '2.1.1');
  assert.equal(peekWhatsNew(storage, '2.1.1'), 'already-shown');
});

test('1.1.0 -> 1.1.1 with the stored mark intact announces 1.1.1 once', () => {
  const storage = memoryStorage('1.1.0');
  assert.equal(peekWhatsNew(storage, '1.1.1', true), 'pending');
  markWhatsNewSeen(storage, '1.1.1');
  assert.equal(peekWhatsNew(storage, '1.1.1', true), 'already-shown');
});

test('1.1.0 -> 1.1.1 after localStorage was lost still announces, instead of passing for a fresh install', () => {
  // Installed-app evidence: the Local Storage database was recreated empty
  // during the 1.1.0 session, and the 1.1.1 launch logged reason=fresh-install.
  // (1.1.1 is already marked shown in this module by the test above, so the
  // same upgrade runs here as 1.2.0 -> 1.2.1.)
  const storage = memoryStorage();
  assert.equal(peekWhatsNew(storage, '1.2.1', true), 'pending');
  assert.equal(storage.data.has(SEEN_VERSION_KEY), false, 'nothing is recorded until the notice is shown');
  const fresh = memoryStorage();
  assert.equal(peekWhatsNew(fresh, '1.2.1', false), 'fresh-install');
});

test('only a newer version is announced; a downgrade leaves the newer mark alone', () => {
  const storage = memoryStorage('3.1.0');
  assert.equal(peekWhatsNew(storage, '3.0.9'), 'downgrade');
  assert.equal(storage.data.get(SEEN_VERSION_KEY), '3.1.0');
  assert.equal(peekWhatsNew(memoryStorage('3.2.0-beta.2'), '3.2.0-beta.10'), 'pending', 'prereleases by precedence');
  assert.equal(peekWhatsNew(memoryStorage('3.3.0'), '3.3.0-rc.1', true), 'downgrade');
});

test('a failed prepare never marks the version, so the next mount retries', () => {
  const storage = memoryStorage('2.2.0');
  assert.equal(peekWhatsNew(storage, '2.2.1'), 'pending');
  // import/prepare fails here: markWhatsNewSeen is never called.
  assert.equal(peekWhatsNew(storage, '2.2.1'), 'pending', 'remount retries');
  assert.equal(storage.data.get(SEEN_VERSION_KEY), '2.2.0');
});

test('a remount in the same session does not show the notice twice, even if the mark cannot be stored', () => {
  const storage = memoryStorage('2.3.0');
  storage.setItem = () => {
    throw new Error('quota');
  };
  assert.equal(peekWhatsNew(storage, '2.3.1'), 'pending');
  markWhatsNewSeen(storage, '2.3.1');
  assert.equal(peekWhatsNew(storage, '2.3.1'), 'already-shown');
});

test('unavailable storage stays quiet', () => {
  assert.equal(peekWhatsNew(undefined, '2.4.0'), 'storage-unavailable');
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => undefined,
  };
  assert.equal(peekWhatsNew(broken, '2.4.0'), 'storage-unavailable');
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
