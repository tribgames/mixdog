import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLocaleText } from '../../../../../scripts/check-changelog-locales.mjs';

const ENGLISH = [
  '# Changelog',
  '',
  'All notable changes.',
  '',
  '## Unreleased',
  '',
  '- Pending `thing`.',
  '',
  '## v1.0.1 - 2026-10-08',
  '',
  '### Fixed',
  '',
  '- Fixed `foo --bar` crash, see #8 and https://example.com/a (v1.0.0).',
  '- `only-code`',
  '',
  '```sh',
  'npm test',
  '```',
  '',
  '## v1.0.0 - 2026-10-01',
  '',
  '- First release.',
  '',
].join('\n');

const GOOD = [
  '# Änderungen',
  '',
  'Alle wichtigen Änderungen.',
  '',
  '## Unreleased',
  '',
  '- Ausstehend `thing`.',
  '',
  '## v1.0.1 - 2026-10-08',
  '',
  '### Fixed',
  '',
  '- Absturz bei `foo --bar` behoben, siehe #8 und https://example.com/a (v1.0.0).',
  '- `only-code`',
  '',
  '```sh',
  'npm test',
  '```',
  '',
  '## v1.0.0 - 2026-10-01',
  '',
  '- Erste Version.',
  '',
].join('\n');

const check = (locale, options) => checkLocaleText(ENGLISH, locale, options);
const edit = (from, to) => {
  assert.ok(GOOD.includes(from), from);
  return GOOD.replace(from, to);
};

test('a faithful translation passes, with and without Unreleased', () => {
  assert.deepEqual(check(GOOD), []);
  assert.deepEqual(check(GOOD, { includeUnreleased: true }), []);
});

test('CRLF line endings are tolerated', () => {
  assert.deepEqual(check(GOOD.replace(/\n/g, '\r\n')), []);
});

test('missing, extra, reordered and re-dated versions fail', () => {
  assert.match(check(GOOD.replace(/## v1\.0\.0[\s\S]*/, '')).join('\n'), /v1\.0\.0 - 2026-10-01: section missing/);
  assert.match(check(`${GOOD}\n## v0.9.0 - 2026-09-01\n\n- Alt.\n`).join('\n'), /v0\.9\.0.*not in CHANGELOG/);
  assert.match(check(edit('2026-10-08', '2026-10-09')).join('\n'), /section missing/);
  const swapped = [
    GOOD.slice(0, GOOD.indexOf('## v1.0.1')),
    GOOD.slice(GOOD.indexOf('## v1.0.0')),
    GOOD.slice(GOOD.indexOf('## v1.0.1'), GOOD.indexOf('## v1.0.0')),
  ].join('');
  assert.match(check(swapped).join('\n'), /section order differs/);
});

test('list item count and heading skeleton must match', () => {
  assert.match(check(edit('- Erste Version.', '- Erste Version.\n- Zweite.')).join('\n'), /top-level list items/);
  assert.match(check(edit('### Fixed', '#### Fixed')).join('\n'), /structure differs/);
});

test('inline code, code blocks, links, issue refs and versions must be preserved', () => {
  assert.match(check(edit('`foo --bar`', '`foo --baz`')).join('\n'), /inline code: differs/);
  assert.match(check(edit('npm test', 'npm tests')).join('\n'), /fenced code blocks: differs/);
  assert.match(check(edit('https://example.com/a', 'https://example.com/b')).join('\n'), /link targets: differs/);
  assert.match(check(edit('#8', '#9')).join('\n'), /issue references: differs/);
  assert.match(check(edit('(v1.0.0)', '(v1.0.2)')).join('\n'), /version strings: differs/);
});

test('an inline code span wrapped at a different place still matches', () => {
  const english = ['# Changelog', '', 'Intro.', '', '## v1.0.0 - 2026-10-01', '', '- Run `npm run build --workspace desktop` now.', ''].join('\n');
  const wrapped = ['# Änderungen', '', 'Einleitung.', '', '## v1.0.0 - 2026-10-01', '', '- Jetzt `npm run', '  build   --workspace desktop` ausführen.', ''].join('\n');
  assert.deepEqual(checkLocaleText(english, wrapped), []);
  const changed = wrapped.replace('--workspace', '--workspaces');
  assert.match(checkLocaleText(english, changed).join('\n'), /inline code: differs/);
});

test('untranslated list items and intros fail, code-only items pass', () => {
  const english = 'Fixed `foo --bar` crash, see #8 and https://example.com/a (v1.0.0).';
  assert.match(
    check(edit('Absturz bei `foo --bar` behoben, siehe #8 und https://example.com/a (v1.0.0).', english)).join('\n'),
    /list item 1 is not translated/
  );
  assert.match(check(edit('Alle wichtigen Änderungen.', 'All notable changes.').replace('# Änderungen', '# Changelog')).join('\n'), /intro: not translated/);
  assert.doesNotMatch(check(GOOD).join('\n'), /only-code/);
});

test('Unreleased is checked only when requested', () => {
  const broken = edit('- Ausstehend `thing`.', '- Ausstehend `other`.');
  assert.deepEqual(check(broken), []);
  assert.match(check(broken, { includeUnreleased: true }).join('\n'), /Unreleased: inline code: differs/);
  const noUnreleased = GOOD.replace(/## Unreleased\n\n- Ausstehend `thing`\.\n\n/, '');
  assert.deepEqual(check(noUnreleased), []);
  assert.match(check(noUnreleased, { includeUnreleased: true }).join('\n'), /Unreleased: section missing/);
});
