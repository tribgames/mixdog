import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOfficePolishPlan,
  evaluateOfficeSubmissionGate,
  normalizeOfficeReviewIssues,
} from './quality-pipeline.mjs';

test('style observations remain visible without forcing a redesign or blocking delivery', () => {
  const issues = [
    'accent_hue_overuse',
    'font_family_overuse',
    'decorative_stripe',
    'consecutive_beats',
    'consecutive_composition_repeat',
    'repeated_layout_grammar',
    'vertical_imbalance',
  ].map((code) => ({ code, severity: 'warning', path: '/slide[2]', message: code }));
  const reviewed = normalizeOfficeReviewIssues(issues);
  assert.deepEqual(reviewed.map((entry) => entry.code), issues.map((entry) => entry.code));
  assert.ok(reviewed.every((entry) => entry.severity === 'info'));
  assert.equal(buildOfficePolishPlan({ format: 'pptx', issues }).status, 'pass');
  assert.equal(evaluateOfficeSubmissionGate({ issues, persisted: true, visualCoverage: { complete: true } }).ok, true);
});

test('creative freedom does not waive corruption, calculation, fit, persistence, or review checks', () => {
  const style = { code: 'vertical_imbalance', severity: 'warning', path: '/slide[2]' };
  for (const code of [
    'package_corrupt', 'missing_relationship', 'formula_error', 'broken_chart',
    'shape_overlap', 'shape_out_of_bounds', 'text_outside_slide', 'text_overflow', 'render_failed',
  ]) {
    const issues = [style, { code, severity: 'warning', path: '/slide[2]' }];
    const gate = evaluateOfficeSubmissionGate({ issues, persisted: true, visualCoverage: { complete: true } });
    assert.equal(gate.ok, false, code);
    assert.deepEqual(gate.blocking.map((entry) => entry.code), [code]);
    assert.deepEqual(buildOfficePolishPlan({ format: 'pptx', issues }).targets[0].codes, [code]);
  }
  assert.equal(evaluateOfficeSubmissionGate({ issues: [style], persisted: false }).ok, false);
  assert.equal(evaluateOfficeSubmissionGate({ issues: [style], visualCoverage: { complete: false } }).ok, false);
});
