import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED_UI_LANGUAGES } from '../../shared/ui-language.ts';
import { checkChangelogLocales, LOCALES } from '../../../../../scripts/check-changelog-locales.mjs';

test('the checked locales are exactly the non-English UI languages', () => {
  const languages = SUPPORTED_UI_LANGUAGES.map((entry) => entry.value).filter((value) => value !== 'en');
  assert.deepEqual([...LOCALES].sort(), languages.sort());
});

// Fails until every changelog/<lang>.md translation lands; the release gate
// additionally checks the Unreleased section (scripts/check-changelog-locales.mjs --unreleased).
test('every changelog/<lang>.md matches CHANGELOG.md released sections', () => {
  const problems = checkChangelogLocales();
  assert.deepEqual(problems, []);
});
