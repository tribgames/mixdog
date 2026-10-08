import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseChangelog } from './changelog.ts';

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
