import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDeadVectorChart, reviewTextFragmentation } from './review-editability.mjs';

const line = (slide, shape, top, text, { left = 72, width = 400, size = 18, bold = false } = {}) => ({
  slide, shape, left, top, width, height: size * 1.4,
  paragraphs: [{ text, fontSize: size, bold, fontName: 'Calibri' }],
});

test('a paragraph split into stacked single-line boxes is reported once per run', () => {
  const boxes = [
    line(2, 1, 60, 'Title of the slide', { size: 36, bold: true }),
    line(2, 2, 140, 'First line of the paragraph'),
    line(2, 3, 166, 'second line of the paragraph'),
    line(2, 4, 192, 'third line of the paragraph'),
    line(2, 5, 218, 'fourth line'),
    line(2, 6, 400, 'Standalone caption', { size: 12 }),
  ];
  const issues = reviewTextFragmentation(boxes);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'text_fragmentation');
  assert.equal(issues[0].path, '/slide[2]/shape[2]');
  assert.deepEqual(issues[0].shapes, [2, 3, 4, 5]);
});

test('real paragraphs, labels in different columns, and two-line pairs are not fragmentation', () => {
  const paragraph = { slide: 1, shape: 1, left: 72, top: 100, width: 400, height: 200, paragraphs: [{ text: 'a', fontSize: 18 }, { text: 'b', fontSize: 18 }] };
  const columns = [line(1, 2, 300, 'A', { left: 72 }), line(1, 3, 300, 'B', { left: 300 }), line(1, 4, 300, 'C', { left: 528 })];
  const pair = [line(1, 5, 400, 'value', { size: 40, bold: true }), line(1, 6, 460, 'label', { size: 12 })];
  const spaced = [line(1, 7, 500, 'one'), line(1, 8, 600, 'two'), line(1, 9, 700, 'three')];
  assert.deepEqual(reviewTextFragmentation([paragraph, ...columns, ...pair, ...spaced]), []);
});

const rect = (slide, shape, left, top, width, height) => ({ slide, shape, kind: 'p:sp', left, top, width, height });

test('columns of varying height on one baseline are a hand-drawn chart unless a native chart is present', () => {
  const content = [
    rect(3, 1, 72, 300, 40, 120), rect(3, 2, 132, 240, 40, 180), rect(3, 3, 192, 360, 40, 60), rect(3, 4, 252, 200, 40, 220),
    rect(3, 5, 72, 60, 500, 40),
  ];
  const issues = reviewDeadVectorChart(content, [{ slide: 3, shape: 5, paragraphs: [{ text: 'Title', fontSize: 30 }] }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'dead_vector_chart');
  assert.match(issues[0].message, /column chart by hand/);
  assert.deepEqual(issues[0].shapes, [1, 2, 3, 4]);
  const withNative = [...content, { slide: 3, shape: 6, kind: 'p:graphicFrame', left: 0, top: 0, width: 100, height: 100 }];
  assert.deepEqual(reviewDeadVectorChart(withNative, []), []);
});

test('horizontal bars from one left edge are reported and equal cards are not', () => {
  const bars = [rect(4, 1, 72, 100, 300, 24), rect(4, 2, 72, 140, 180, 24), rect(4, 3, 72, 180, 420, 24), rect(4, 4, 72, 220, 90, 24)];
  assert.match(reviewDeadVectorChart(bars, [])[0].message, /bar chart by hand/);
  const cards = [rect(5, 1, 72, 100, 200, 150), rect(5, 2, 300, 100, 200, 150), rect(5, 3, 528, 100, 200, 150), rect(5, 4, 756, 100, 200, 150)];
  assert.deepEqual(reviewDeadVectorChart(cards, []), []);
});
