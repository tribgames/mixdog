import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDocumentPages, assessDocumentAcceptance, DOCUMENT_VISUAL_CHECKS } from './quality/document-acceptance.mjs';
import { scoreOfficeReleaseQuality } from './quality/quality-score.mjs';
import { recalculateForReview } from './core/office-recalculation.mjs';

const state = {
  renderedPageCount: 2, reviewToken: 'current', renderedVersion: 4,
  snapshotVersion: 4, renderedCoverage: { complete: true },
};
const evidence = { structuralAvailable: true, expectedPages: 2, pageCoverage: 1, blockingIssueCount: 0 };

for (const [format, checks] of Object.entries(DOCUMENT_VISUAL_CHECKS)) {
  test(`${format} acceptance requires current page-specific checks, not a diagnostic score`, () => {
    const design = {
      reviewed: true, reviewToken: 'current',
      critique: [1, 2].map((page) => ({
        page, verdict: 'pass', note: `Reviewed page ${page}`,
        ...Object.fromEntries(checks.map((check) => [check, true])),
      })),
    };
    const unreviewed = scoreOfficeReleaseQuality({
      format, aesthetics: { score: 1 }, structuralAvailable: true, renderedPages: 2, expectedPages: 2,
    });
    assert.equal(unreviewed.automatedReady, true);
    assert.equal(unreviewed.releaseReady, false);
    const accepted = reviewDocumentPages(format, design, state);
    assert.equal(assessDocumentAcceptance(evidence, accepted).releaseReady, true);
    for (const invalid of [
      { ...design, reviewToken: 'old' },
      { ...design, critique: [design.critique[0]] },
      { ...design, critique: [design.critique[0], design.critique[0]] },
      { ...design, critique: [design.critique[0], { ...design.critique[1], [checks[0]]: false }] },
    ]) assert.equal(reviewDocumentPages(format, invalid, state).acknowledged, false);
    assert.equal(reviewDocumentPages(format, design, { ...state, snapshotVersion: 5 }).acknowledged, false);
    assert.equal(reviewDocumentPages(format, design, { ...state, renderedCoverage: { complete: false } }).acknowledged, false);
  });
}

test('tabular exports do not acquire a paginated review requirement', () => {
  assert.equal(reviewDocumentPages('csv', {}, {}), null);
  assert.equal(reviewDocumentPages('tsv', {}, {}), null);
});

test('recalculation invalidates earlier pixels once per document version', async () => {
  const session = {
    backend: 'mixdog-ooxml', format: 'xlsx', target: 'fixture.xlsx', snapshotVersion: 4,
    renderCache: { stale: true }, designState: { reviewToken: 'old', renderedVersion: 4 },
  };
  let count = 0;
  const calculate = async () => { count += 1; return { needed: true, recalculated: true, totalErrors: 0 }; };
  await recalculateForReview(session, null, calculate);
  assert.equal(session.renderCache, null);
  assert.equal(session.designState.reviewToken, '');
  session.renderCache = { current: true };
  await recalculateForReview(session, null, calculate);
  assert.equal(count, 1);
  assert.deepEqual(session.renderCache, { current: true });
  session.snapshotVersion += 1;
  await recalculateForReview(session, null, calculate);
  assert.equal(count, 2);
  assert.equal(session.renderCache, null);
});
