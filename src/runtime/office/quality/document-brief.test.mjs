import assert from 'node:assert/strict';
import test from 'node:test';
import { documentBrief, documentBriefIssues } from './document-brief.mjs';

test('document briefs accept custom or absent concepts without prescribing a style', () => {
  const plain = documentBrief('facts: F1 38 — log');
  const named = documentBrief('concept: ledger — the figures lead\nfacts: F1 38 — log');
  assert.equal(plain.concept, '');
  assert.equal(named.concept, 'ledger — the figures lead');
  for (const format of ['docx', 'xlsx', 'pdf']) {
    const document = { paragraphs: [{ text: '38' }], tables: [], sheets: [{ name: 'Report', cells: [{ value: '38' }] }] };
    assert.deepEqual(documentBriefIssues(format, document, plain), [], format);
    assert.deepEqual(documentBriefIssues(format, document, named), [], format);
  }
  assert.deepEqual(documentBriefIssues('docx', {}, null), []);
});

test('optional design choices do not waive source-grounding checks', () => {
  const brief = documentBrief('facts: F1 38 — log');
  for (const format of ['docx', 'xlsx']) {
    const document = {
      paragraphs: [{ text: '999건' }],
      sheets: [{ name: 'Report', cells: [{ value: '999건' }] }],
    };
    assert.ok(documentBriefIssues(format, document, brief).some((entry) => entry.code === 'number_without_fact'), format);
  }
});
