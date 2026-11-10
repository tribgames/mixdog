import test from 'node:test';
import assert from 'node:assert/strict';
import { quickWebSearchModels } from './quick-web-search-models.mjs';

test('quick web-search rows come from the catalog rows, newest first, with no ids in code', () => {
  const models = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => [
      `future-${id}`,
      { name: `Future ${id}`, release_date: `2031-0${i + 1}-01` },
    ])
  );
  const rows = quickWebSearchModels('openai', models);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { id: 'future-f', display: 'Future f', releaseDate: '2031-06-01' });
  assert.equal(rows[4].id, 'future-b');
});

test('no catalog rows means no quick rows', () => {
  assert.deepEqual(quickWebSearchModels('openai', null), []);
});
