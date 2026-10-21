import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedUtf8 } from '../attachments/pdf-extract.mjs';
import { stripTrailingReplacementChars } from './utf8-cut.mjs';

const OLD = (text) => text.replace(/\uFFFD+$/g, '');

test('matches the old regex on ordinary inputs', () => {
  for (const text of [
    '',
    'abc',
    '\uFFFD',
    'a\uFFFD',
    'a\uFFFD\uFFFDb',
    '\uFFFDa\uFFFD\uFFFD',
    '한국어\uFFFD',
    '\uFFFD\uFFFD',
  ]) {
    assert.equal(stripTrailingReplacementChars(text), OLD(text));
  }
});

test('a long trailing run trims in linear time', () => {
  const run = '\uFFFD'.repeat(200_000);
  const started = performance.now();
  assert.equal(stripTrailingReplacementChars(`abc${run}`), 'abc');
  assert.equal(stripTrailingReplacementChars(run), '');
  assert.ok(performance.now() - started < 200, 'trimmed in bounded time');
});

test('boundedUtf8 stays linear and cuts cleanly on a replacement-char run', () => {
  const started = performance.now();
  const cut = boundedUtf8(`${'\uFFFD'.repeat(100_000)}${'x'.repeat(20)}`, 300_005);
  assert.equal(cut.text, `${'\uFFFD'.repeat(100_000)}xxxxx`);
  assert.equal(cut.truncated, true);
  assert.equal(boundedUtf8(`ab${'\uFFFD'.repeat(10)}`, 5).text, 'ab');
  assert.equal(boundedUtf8('한국어', 4).text, '한');
  assert.ok(performance.now() - started < 200, 'cut in bounded time');
});
