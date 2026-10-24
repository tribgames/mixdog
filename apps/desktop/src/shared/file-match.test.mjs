import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFileMatches, matchFile, normalizeFileQuery } from './file-match.ts';

const tier = (path, query) => matchFile(path, query)?.tier ?? null;

test('tiers run: name equals, name starts, word start, name contains, segment starts, path contains', () => {
  assert.equal(tier('src/Composer.tsx', 'composer.tsx'), 0);
  assert.equal(tier('src/Composer.tsx', 'composer'), 0, 'equal without the extension');
  assert.equal(tier('src/composer-surfaces.tsx', 'comp'), 1);
  for (const name of ['use-composer.ts', 'use_composer.ts', 'use.composer.ts', 'use composer.ts', 'useComposer.ts']) {
    assert.equal(tier(`src/${name}`, 'composer'), 2, name);
  }
  assert.equal(tier('src/decomposer.ts', 'composer'), 3, 'a lower-case run is not a word start');
  assert.equal(tier('src/composer/index.ts', 'comp'), 4);
  assert.equal(tier('src/xcomp/index.ts', 'comp'), 5);
  assert.equal(tier('src/composer/index.ts', 'src/comp'), 4, 'a query with folders matches at a segment start');
});

test('scattered letters never match', () => {
  assert.equal(matchFile('p/a/l/e/t/t/e/x.txt', 'palette'), null);
  assert.equal(matchFile('apple.tsx', 'app.ts'), null);
});

test('a hump needs the original case; matching is case-insensitive', () => {
  assert.equal(tier('src/MainComposer.tsx', 'COMPOSER'), 2);
  assert.equal(tier('src/MAINCOMPOSER.tsx', 'composer'), 3, 'no lower-case letter before the capital');
  assert.equal(tier('SRC/README.MD', 'readme'), 0);
});

test('the range marks the matched characters in the whole path, folders included', () => {
  assert.deepEqual(matchFile('apps/desktop/use-composer.ts', 'compo'), { tier: 2, start: 17, end: 22 });
  assert.deepEqual(matchFile('src/compact/', 'comp'), { tier: 1, start: 4, end: 8 });
  assert.deepEqual(matchFile('src/xcomp/a.ts', 'comp'), { tier: 5, start: 5, end: 9 });
  assert.deepEqual(matchFile('src/Composer.tsx', 'Composer'), { tier: 0, start: 4, end: 12 });
});

test('an empty query matches everything at tier 0 and normalizes like typed text', () => {
  assert.deepEqual(matchFile('src/a.ts', '  '), { tier: 0, start: 0, end: 0 });
  assert.equal(normalizeFileQuery(' Src\\Comp '), 'src/comp');
});

test('ties go to fewer segments, then the shorter path, then alphabetical; folders get no priority', () => {
  const rank = (query, paths) =>
    paths
      .flatMap((path) => {
        const match = matchFile(path, query);
        return match ? [{ path, match }] : [];
      })
      .sort(compareFileMatches)
      .map((entry) => entry.path);
  assert.deepEqual(rank('ab', ['z/abc.ts', 'abcdef.ts', 'abd.ts', 'abc.ts']), [
    'abc.ts',
    'abd.ts',
    'abcdef.ts',
    'z/abc.ts',
  ]);
  assert.deepEqual(rank('target', ['sub/target/', 'target.txt']), ['target.txt', 'sub/target/']);
  assert.deepEqual(rank('target', ['target/', 'sub/target.txt']), ['target/', 'sub/target.txt']);
});
