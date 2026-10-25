/**
 * katex-text-metrics.test.mjs — KaTeX lends characters it has no metrics for
 * (Hangul, CJK, …) the metrics of 'M', so a fraction clears them by too little
 * and their ink crosses the bar. The markdown pipeline must lay such text out
 * with the metrics of the glyph that is really painted.
 *
 * The expected layout is independent of KaTeX's internals: a Hangul syllable
 * measured with the built-in metrics of a Latin glyph has to lay out exactly
 * like that Latin glyph.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import builtIn from 'katex/src/fontMetricsData.js';
import { parseMarkdownToHast } from './markdown-ast';
import { setGlyphMeasurer } from './katex-text-metrics';

const [PAREN_DEPTH, PAREN_HEIGHT, , , PAREN_WIDTH] = builtIn['Main-Regular'][40];
const [BOLD_PAREN_DEPTH, BOLD_PAREN_HEIGHT, , , BOLD_PAREN_WIDTH] = builtIn['Main-Bold'][40];

function inkOf(depth, height, width) {
  return { ascent: height, descent: depth, advance: width };
}

/** Ink of '(' in the face the KaTeX font name resolves to. */
function parenMeasurer(calls) {
  return (face, character) => {
    calls.push(`${face.weight}:${character}`);
    return face.weight === 'bold'
      ? inkOf(BOLD_PAREN_DEPTH, BOLD_PAREN_HEIGHT, BOLD_PAREN_WIDTH)
      : inkOf(PAREN_DEPTH, PAREN_HEIGHT, PAREN_WIDTH);
  };
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

const hasClass = (name) => (node) => node.properties?.className?.includes(name);

/** Every vertical offset of the layout: numerator, bar and denominator tops. */
function layout(markdown) {
  const root = parseMarkdownToHast(markdown);
  return findAll(root, hasClass('vlist'))
    .flatMap((list) => list.children.map((child) => child.properties?.style))
    .filter(Boolean);
}

const frac = (cell) => `$$\\frac{\\text{${cell}}}{\\text{${cell}}}$$`;

test.afterEach(() => setGlyphMeasurer(undefined));

test('a fraction clears a measured Hangul glyph like the Latin glyph with the same metrics', () => {
  setGlyphMeasurer(parenMeasurer([]));
  assert.notDeepEqual(layout(frac('(')), layout(frac('M')), 'the probe metrics must differ from the M stand-in');
  assert.deepEqual(layout(frac('한')), layout(frac('(')));
});

test('bold text is measured in, and laid out with, the bold face', () => {
  const calls = [];
  setGlyphMeasurer(parenMeasurer(calls));
  assert.deepEqual(layout('$$\\frac{\\textbf{한}}{\\textbf{한}}$$'), layout('$$\\frac{\\textbf{(}}{\\textbf{(}}$$'));
  assert.ok(calls.includes('bold:한'));
});

test('each character is measured once and then cached', () => {
  const calls = [];
  setGlyphMeasurer(parenMeasurer(calls));
  layout(frac('한한'));
  const first = calls.length;
  assert.ok(first > 0);
  layout(frac('한'));
  layout(frac('한한'));
  assert.equal(calls.length, first);
  layout(frac('국'));
  assert.ok(calls.length > first);
});

test('characters produced by expansion are measured too', () => {
  setGlyphMeasurer(parenMeasurer([]));
  assert.deepEqual(layout('$$\\frac{\\text{\\char"D55C}}{\\text{\\char"D55C}}$$'), layout(frac('(')));
  assert.deepEqual(layout('$$\\def\\k{한}\\frac{\\text{\\k}}{\\text{\\k}}$$'), layout(frac('(')));
});

test('a formula lays out the same whatever was rendered before it', () => {
  const formula = '$$\\frac{\\text{\\char"D55C}}{\\text{국}}$$';
  setGlyphMeasurer(parenMeasurer([]));
  const fresh = layout(formula);
  setGlyphMeasurer(parenMeasurer([]));
  layout(frac('한'));
  layout(frac('국'));
  assert.deepEqual(layout(formula), fresh);
  assert.deepEqual(fresh, layout(frac('(')));
});

test('characters KaTeX already has metrics for are never measured', () => {
  const calls = [];
  setGlyphMeasurer(parenMeasurer(calls));
  layout('$$\\frac{a+b}{\\text{abc ÅÀ А ж}}$$');
  assert.deepEqual(calls, []);
});
