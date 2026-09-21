import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDeterministicCorpus } from './embedding-model-bench-core.mjs';

const documents = Object.freeze([6, 3, 2, 5, 4, 1, 3].map((id) => Object.freeze({ id })));

test('negative sampling preserves SHA-256 order, document order, and duplicate rows', () => {
  // SHA-256("4") starts 4b22, then "3" starts 4e07; the other IDs sort after both.
  const selection = selectDeterministicCorpus(documents, [{ positiveIdsByTarget: [[6]] }], 3);
  assert.deepEqual(selection, {
    documents: [{ id: 6 }, { id: 3 }, { id: 4 }, { id: 3 }],
    sourceDocuments: 7,
    selectedDocuments: 3,
    positiveDocuments: 1,
    method: 'all-positive-roots + sha256(document-id) negatives',
  });
});

test('positive caps use the same hash ordering without counting duplicate IDs twice', () => {
  const selection = selectDeterministicCorpus(documents, [{ positiveIdsByTarget: [[1, 2, 3, 4, 5, 6, 3]] }], 2, 2);
  assert.deepEqual(selection, {
    documents: [{ id: 3 }, { id: 4 }, { id: 3 }],
    sourceDocuments: 7,
    selectedDocuments: 2,
    positiveDocuments: 2,
    method: 'up-to-2-positive-roots-per-target + sha256(document-id) negatives',
  });
});

test('full-corpus selections retain the original array and capped positive count', () => {
  for (const limit of [0, 1.5, 7, 9]) {
    const selection = selectDeterministicCorpus(
      documents,
      [{ positiveIdsByTarget: [[1, 2, 3, 4, 5, 6, 3]] }],
      limit,
      2
    );
    assert.equal(selection.documents, documents);
    assert.deepEqual(selection, {
      documents,
      sourceDocuments: 7,
      selectedDocuments: 7,
      positiveDocuments: 2,
      method: 'full-corpus',
    });
  }
});
