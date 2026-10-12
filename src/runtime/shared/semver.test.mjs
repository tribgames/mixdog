import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemver } from './semver.mjs';
import { compareSemver as checkerCompare, isNewerVersion } from './update-checker.mjs';

test('the SemVer 2.0.0 §11 precedence example orders strictly ascending', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(compareSemver(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.ok(compareSemver(ordered[i], ordered[i - 1]) > 0, `${ordered[i]} > ${ordered[i - 1]}`);
  }
});

test('numeric prerelease identifiers compare numerically, below alphanumeric ones', () => {
  assert.ok(compareSemver('1.2.0-beta.10', '1.2.0-beta.2') > 0);
  assert.ok(compareSemver('1.2.0-1', '1.2.0-alpha') < 0);
  assert.ok(compareSemver('1.2.0-beta.99999999999999999999', '1.2.0-beta.99999999999999999998') > 0);
});

test('core versions compare numerically; v prefixes and build metadata do not matter', () => {
  assert.ok(compareSemver('1.1.10', '1.1.2') > 0);
  assert.ok(compareSemver('2.0.0', '1.99.99') > 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3+build.7', '1.2.3+other'), 0);
  assert.ok(compareSemver('1.2.0-beta.1', '1.2.0') < 0);
  assert.equal(compareSemver('1.2.0-rc.1', '1.2.0-rc.1'), 0);
});

test('the update checker uses the same precedence for its update decisions', () => {
  assert.equal(checkerCompare, compareSemver);
  assert.equal(isNewerVersion('1.2.0-beta.10', '1.2.0-beta.2'), true);
  assert.equal(isNewerVersion('1.2.0', '1.2.0-rc.1'), true);
  assert.equal(isNewerVersion('1.2.0-rc.1', '1.2.0'), false);
  assert.equal(isNewerVersion('1.1.1', '1.1.1'), false);
  assert.equal(isNewerVersion('', '1.1.1'), false);
});
