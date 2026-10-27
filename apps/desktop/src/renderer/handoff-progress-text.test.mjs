import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_PROGRESS_MAX, handoffProgressText } from './handoff-progress-text.ts';

const graphemeCount = (text) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;

test('a long markdown update becomes a capped plain-text title', () => {
  const long =
    '시장 전체 규모로 매출 범위를 조이는 방안을 새 모델 후보 `rev-v9`로 만들어 시험하도록 맡겼습니다. **시장 × 순위대별 범위 폭 변화는 아직 계산 전이라, 지금은 드릴 숫자가 없습니다.** 나머지';
  const text = handoffProgressText(long);
  assert.ok(graphemeCount(text) <= HANDOFF_PROGRESS_MAX);
  assert.ok(text.endsWith('…'));
  assert.ok(!/[`*]/.test(text));
  assert.ok(text.includes('rev-v9로'));
  assert.ok(!text.includes('\uFFFD'));
});

test('a dangling cut-off marker at the end goes and paired markers are stripped', () => {
  assert.equal(handoffProgressText('Done now **'), 'Done now');
  assert.equal(handoffProgressText('a **b** `c` __d__ ~~e~~ *f* _g_.'), 'a b c d e f g.');
  assert.equal(handoffProgressText('## Title with [a link](https://x.y)'), 'Title with a link');
});

test('real text that looks like markdown is kept verbatim', () => {
  for (const text of [
    'src/__init__.py is missing',
    'rename snake_case and __dunder__.py',
    'a*b and c*d, 2 * 3 * 4',
    'port it to C++ or use *.cpp and *.h',
    'pass **kwargs on',
    String.raw`see C:\Users\me\__pycache__\x.py and C:\dir\*.txt`,
  ]) {
    assert.equal(handoffProgressText(text), text);
  }
  assert.equal(handoffProgressText('edit `src/__init__.py` and `a**b**c`'), 'edit src/__init__.py and a**b**c');
  assert.equal(handoffProgressText(String.raw`open **C:\Users\me\__x__.py**`), String.raw`open C:\Users\me\__x__.py`);
});

test('the cut never splits a surrogate pair or a grapheme cluster', () => {
  const text = handoffProgressText('😀'.repeat(200));
  assert.equal(graphemeCount(text), HANDOFF_PROGRESS_MAX);
  assert.ok(!/[\uD800-\uDBFF]$/.test(text.slice(0, -1)));
  const family = handoffProgressText('👨‍👩‍👧'.repeat(200));
  assert.equal(family.slice(0, -1), '👨‍👩‍👧'.repeat(HANDOFF_PROGRESS_MAX - 1));
});
