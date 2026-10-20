import assert from 'node:assert/strict';
import test from 'node:test';
import { lastMessageLine } from '../agent/orchestrator/session/store-summary-last-message.mjs';
import { plainPreviewText } from './plain-preview.mjs';

test('a preview line drops markdown and keeps the words', () => {
  assert.equal(
    plainPreviewText('**벤치마크 정리 체크리스트**\n\n1. 측정 조건 고정'),
    '벤치마크 정리 체크리스트 측정 조건 고정'
  );
  assert.equal(plainPreviewText('## Heading\n- item *one*\n* item _two_\n> quote'), 'Heading item one item two quote');
  assert.equal(plainPreviewText('Run:\n```bash\nnpm test\n```\ndone'), 'Run: npm test done');
  assert.equal(plainPreviewText('Use `npm ci` and [docs](https://x.test) ~~old~~'), 'Use npm ci and docs old');
  // Plain prose (snake_case, 2*3, $HOME) is left as written.
  assert.equal(plainPreviewText('snake_case_name is 2*3 at $HOME'), 'snake_case_name is 2*3 at $HOME');
});

test('a list already folded onto one line by an older summary loses its markers', () => {
  assert.equal(
    plainPreviewText('몇 가지 예를 들어 드리겠습니다. - 조사: 웹에서 찾아 드립니다. - 글쓰기: 다듬어 드립니다.'),
    '몇 가지 예를 들어 드리겠습니다. 조사: 웹에서 찾아 드립니다. 글쓰기: 다듬어 드립니다.'
  );
  assert.equal(plainPreviewText('a - b and well-known'), 'a - b and well-known');
});

test("a greeting's suggestions comment never reaches the preview", () => {
  assert.equal(
    plainPreviewText('안녕하세요, PR 감시입니다.\n<!-- mixdog:suggestions ["열린 PR 보여 줘", "주기 바꿔 줘"] -->'),
    '안녕하세요, PR 감시입니다.'
  );
  assert.equal(plainPreviewText('Hi.\n<!-- mixdog:suggestions ["a'), 'Hi.', 'an unfinished one streams hidden');
});

test('a long preview keeps 200 characters: the row clamps it to two lines', () => {
  const long = '가'.repeat(500);
  assert.equal(plainPreviewText(long).length, 200);
  assert.equal(plainPreviewText('**v1.0 릴리스 노트**').length, 'v1.0 릴리스 노트'.length);
});

test('the last-message line of a markdown reply is plain text', () => {
  const line = lastMessageLine({ role: 'assistant', content: '**벤치마크 정리 체크리스트**\n1. 측정 조건 고정' });
  assert.equal(line, '벤치마크 정리 체크리스트 측정 조건 고정');
});
