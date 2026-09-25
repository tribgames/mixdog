import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSlideLayout } from './portable-pptx-package.mjs';

// The layouts of a deck Korean PowerPoint wrote: its names are Korean, its types the file's own.
const korean = [
  { name: '제목 슬라이드', type: 'title' },
  { name: '제목 및 내용', type: 'obj' },
  { name: '구역 머리글', type: 'secHead' },
  { name: '콘텐츠 2개', type: 'twoObj' },
  { name: '비교', type: 'twoTxTwoObj' },
  { name: '제목만', type: 'titleOnly' },
  { name: '빈 화면', type: 'blank' },
];

test('the default layouts are found by their English names in a deck of another language', () => {
  const pick = (requested) => selectSlideLayout(korean, requested).name;
  assert.equal(pick('Title Only'), '제목만');
  assert.equal(pick('title and content'), '제목 및 내용');
  assert.equal(pick('Section Header'), '구역 머리글');
  assert.equal(pick('Two Content'), '콘텐츠 2개');
  assert.equal(pick('Comparison'), '비교');
  // The deck's own name and the layout type still come first.
  assert.equal(pick('제목만'), '제목만');
  assert.equal(pick('blank'), '빈 화면');
  assert.throws(() => pick('Agenda'), /Slide layout not found: Agenda\. Available: 제목 슬라이드/);
});
