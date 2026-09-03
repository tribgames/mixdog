import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthoringBrief, reviewBriefPromises, reviewFactCoverage } from './pptx-brief.mjs';

const SCRIPT = `
// BRIEF
// subject/audience/action: board · approve the plan
// reading mode: balanced · argument mode: pyramid
// family: editorial · palette from: finance · accent: 1F7A4D
// facts: F1 38건 — 1차 리뷰 로그 · F2 0.72 — 3차 미학 점수 · F3 97% — QA 통과율
// slide plan: 1 cover S5 · 2 evidence · chart · E1 · accent bar + takeaway · 3 focal claim · hero · S2 · hero + emphasis
//   · 4 order · stepped · R3 · steps · 5 closing
const x = 1;
`;

test('brief parser reads the plan, the facts, and the family', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  assert.equal(brief.present, true);
  assert.equal(brief.family, 'editorial');
  assert.deepEqual(brief.plan.map((entry) => [entry.slide, entry.skeleton, entry.role]), [[1, 'S5', 'cover'], [2, 'E1', ''], [3, 'S2', ''], [4, 'R3', ''], [5, '', 'closing']]);
  assert.deepEqual(brief.facts.map((fact) => fact.value), ['38건', '0.72', '97%']);
});

test('the review holds slides to the skeleton their plan line promised', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  const document = { slides: [
    { index: 1, shapes: [{ text: '01', font: { size: 240 } }] },
    { index: 2, shapes: [{ text: 'Title', font: { size: 32 } }, { text: 'a body paragraph', font: { size: 14 } }] },      // promised a chart
    { index: 3, shapes: [{ text: '38', font: { size: 96 } }] },
    { index: 4, shapes: [{ geometry: 'round1Rect', fill: { color: 'EEEEEE' } }, { geometry: 'line' }] },
    { index: 5, shapes: [{ text: 'The ask', font: { size: 36 } }] },
  ] };
  const issues = reviewBriefPromises(document, brief);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.path]), [['plan_promise_missing', '/slide[2]']]);
  assert.equal(reviewBriefPromises({ slides: document.slides.slice(0, 4) }, brief).some((issue) => issue.code === 'plan_count_mismatch'), true);
});

test('figures without a fact behind them are reported; dates and slide numbers are not', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  const document = { slides: [
    { index: 1, shapes: [{ text: '2026-09-03 · 38건 → 0' }, { text: '3', placeholder: true }] },
    { index: 2, shapes: [{ text: '품질 0.72, 통과율 97%, 비용 1,250만원' }] },
  ] };
  const issues = reviewFactCoverage(document, brief);
  assert.deepEqual(issues.map((issue) => issue.path), ['/slide[2]']);
  assert.match(issues[0].message, /1,250/);
  assert.doesNotMatch(issues[0].message, /0\.72|97%/);
  const noFacts = reviewFactCoverage(document, { present: true, facts: [] });
  assert.equal(noFacts.some((issue) => issue.code === 'facts_missing'), true);
});
