import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { _maskNonCodeText } from './text-mask.mjs';

// Byte-exact masking goldens across the comment/string/interpolation dialects
// the scanner distinguishes. Regenerate deliberately when the masking contract
// changes; a diff here otherwise means identifier scans now see (or miss)
// different bytes.
const goldens = JSON.parse(readFileSync(new URL('./text-mask.golden.json', import.meta.url), 'utf8'));

for (const { lang, src, masked } of goldens) {
  test(`masking golden: ${lang}`, () => {
    const out = _maskNonCodeText(src, lang);
    assert.equal(out.length, src.length);
    assert.equal(out, masked);
  });
}
