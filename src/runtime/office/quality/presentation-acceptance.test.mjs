import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreOfficeReleaseQuality } from './quality-score.mjs';
import { assessPresentationAcceptance } from './presentation-acceptance.mjs';
import { assessDocumentAcceptance } from './document-acceptance.mjs';

const evidence = {
  structuralAvailable: true, expectedPages: 5, pageCoverage: 1, blockingIssueCount: 0,
};

test('a current accepted visual review is required independently of perfect diagnostics', () => {
  const quality = scoreOfficeReleaseQuality({
    format: 'pptx', aesthetics: { score: 1 }, renderedPages: 5,
    expectedPages: 5, structuralAvailable: true, planCoverage: 1,
  });
  assert.equal(quality.releaseReady, false);
  assert.equal(assessPresentationAcceptance(quality.evidence, {
    acknowledged: true, critique: { ok: true },
  }).releaseReady, true);
  for (const review of [
    { acknowledged: true },
    { acknowledged: true, critique: { ok: false } },
    { acknowledged: false, critique: { ok: true } },
  ]) {
    assert.equal(assessPresentationAcceptance(evidence, review).releaseReady, false);
  }
});

test('visual approval cannot replace missing coverage or override diagnostic warnings', () => {
  for (const partial of [
    { structuralAvailable: false }, { expectedPages: 0 },
    { pageCoverage: 0.8 }, { blockingIssueCount: 1 },
  ]) {
    const result = assessPresentationAcceptance({ ...evidence, ...partial }, {
      acknowledged: true, critique: { ok: true },
    });
    assert.equal(result.automatedReady, false);
    assert.equal(result.visualReview.status, 'accepted');
    assert.equal(result.releaseReady, false);
  }
});

test('an aesthetic score is not a release threshold and document formats wait for their own page review', () => {
  const low = scoreOfficeReleaseQuality({
    format: 'pptx', aesthetics: { score: 0 }, renderedPages: 5,
    expectedPages: 5, structuralAvailable: true,
  });
  assert.equal(assessPresentationAcceptance(low.evidence, {
    acknowledged: true, critique: { ok: true },
  }).releaseReady, true);
  const workbook = scoreOfficeReleaseQuality({
    format: 'xlsx', aesthetics: { score: 0.9 }, renderedPages: 1,
    expectedPages: 1, structuralAvailable: true,
  });
  assert.equal(workbook.version, 2);
  // Rendering is evidence, not approval: a clean workbook is automated-ready
  // but not release-ready until its rendered pages have been reviewed.
  assert.equal(workbook.automatedReady, true);
  assert.equal(workbook.releaseReady, false);
  assert.equal(workbook.visualReview.status, 'not-reviewed');
  assert.equal(assessDocumentAcceptance(workbook.evidence, {
    acknowledged: true, status: 'accepted',
  }).releaseReady, true);
});
