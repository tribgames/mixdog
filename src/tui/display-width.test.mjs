import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { displayWidthWith, isProblemCodePoint } from './display-width.mjs';

// Policy ON: the two problem ranges become 2 cells; everything else unchanged.
test('policy ON widens circled digits and arrows only', () => {
  assert.equal(displayWidthWith('\u2460', true), 2); // ① circled digit
  assert.equal(displayWidthWith('\u2192', true), 2); // → rightwards arrow
  assert.equal(displayWidthWith('a', true), 1); // ASCII unchanged
  // Box-drawing / figures must NOT be widened by the policy.
  assert.equal(displayWidthWith('\u2514', true), stringWidth('\u2514')); // └
  assert.equal(displayWidthWith('\u2502', true), stringWidth('\u2502')); // │
  assert.equal(displayWidthWith('\u2500', true), stringWidth('\u2500')); // ─
  assert.equal(displayWidthWith('\u25cf', true), stringWidth('\u25cf')); // ●
  // Mixed string: base + one +1 per problem code point.
  assert.equal(displayWidthWith('a\u2460b\u2192', true), stringWidth('a\u2460b\u2192') + 2);
});

// Policy OFF: byte-for-byte identical to plain string-width.
test('policy OFF equals string-width', () => {
  for (const s of ['\u2460', '\u2192', 'a', '\u2514', 'hello \u2192 world', '']) {
    assert.equal(displayWidthWith(s, false), stringWidth(s));
  }
});

test('problem range membership', () => {
  assert.equal(isProblemCodePoint(0x2460), true);
  assert.equal(isProblemCodePoint(0x24ff), true);
  assert.equal(isProblemCodePoint(0x2190), true);
  assert.equal(isProblemCodePoint(0x21ff), true);
  assert.equal(isProblemCodePoint(0x2500), false); // box-drawing
  assert.equal(isProblemCodePoint(0x245f), false); // just below range
  assert.equal(isProblemCodePoint(0x2200), false); // just above arrows
});
