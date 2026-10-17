import assert from 'node:assert/strict';
import test from 'node:test';

const { settledTop } = await import('./route-editor-layout.ts');

test('a row top is read from layout offsets, not the transformed (animating) rect', () => {
  // A fixed sheet at 660 with a 1px border; its row list scrolled by 0; the row 4px in.
  const sheet = { offsetTop: 660, offsetParent: null, parentElement: null, clientTop: 1, scrollTop: 0 };
  const list = { parentElement: sheet, scrollTop: 0 };
  const row = {
    offsetTop: 3,
    offsetParent: sheet,
    parentElement: list,
    getBoundingClientRect: () => ({ top: 760 }),
  };
  assert.equal(settledTop(row), 664);
  // A scrolled list moves the row up by its scroll offset.
  list.scrollTop = 20;
  assert.equal(settledTop(row), 644);
});
