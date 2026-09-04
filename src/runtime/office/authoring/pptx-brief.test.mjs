import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthoringBrief, reviewBriefPromises, reviewFactCoverage, reviewSourceGrounding } from './pptx-brief.mjs';

const SCRIPT = `
// BRIEF
// subject/audience/action: board · approve the plan
// reading mode: balanced · argument mode: pyramid
// directions: A editorial · hue 205 · serif · vertical rule — document-like · B swiss-minimal · hue 225 · concord · oversized plane — number-led
//   · C dark-tech · hue 215 · weight · glow — stage-led · selected: B · why: the numbers carry the argument
// style: swiss-minimal · palette: hue 225 · accent: 1F7A4D · type: MODE balanced → body 18 · script: ko · pairing: concord · fonts: noto
// facts: F1 38건 — 1차 리뷰 로그 · F2 0.72 — 3차 미학 점수 · F3 97% — QA 통과율
// slide plan: 1 job: cover · move: the room knows the ask · composition: dark field, ghost numeral · carriers: statement
//   · 2 job: evidence · relationship: evidence · move: trust the trend · composition: chart as spine · carriers: chart, takeaway · rhythm: dense
//   · 3 job: claim · relationship: none · move: the number lands · composition: hero entering high · carriers: hero · rhythm: breathing
//   · 4 job: process · relationship: order · move: see the path · composition: stepped blocks rising · carriers: diagram · 5 job: closing · move: approve · carriers: statement
const x = 1;
`;

test('brief parser reads the plan fields, the directions, the style, and the facts', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  assert.equal(brief.present, true);
  assert.equal(brief.style, 'swiss-minimal');
  assert.equal(brief.family, 'swiss-minimal');
  assert.deepEqual(brief.directions.candidates.map((c) => c.id), ['A', 'B', 'C']);
  assert.equal(brief.directions.selected, 'B');
  assert.deepEqual(brief.plan.map((entry) => [entry.slide, entry.job, entry.role, entry.carriers]), [
    [1, 'cover', 'cover', ['statement']],
    [2, 'evidence', '', ['chart', 'takeaway']],
    [3, 'claim', '', ['hero']],
    [4, 'process', '', ['diagram']],
    [5, 'closing', 'closing', ['statement']],
  ]);
  assert.equal(brief.plan[1].relationship, 'evidence');
  assert.equal(brief.plan[1].composition, 'chart as spine');
  assert.equal(brief.plan[2].rhythm, 'breathing');
  assert.deepEqual(brief.facts.map((fact) => fact.value), ['38건', '0.72', '97%']);
});

test('the review reads the carriers each plan line named back as information', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  const document = { slides: [
    { index: 1, shapes: [{ text: '01', font: { size: 240 } }] },
    { index: 2, shapes: [{ text: 'Title', font: { size: 32 } }, { text: 'a body paragraph', font: { size: 14 } }] },      // promised a chart
    { index: 3, shapes: [{ text: '38', font: { size: 96 } }] },
    { index: 4, shapes: [{ geometry: 'round1Rect', fill: { color: 'EEEEEE' } }, { geometry: 'line' }] },
    { index: 5, shapes: [{ text: 'The ask', font: { size: 36 } }] },
  ] };
  const issues = reviewBriefPromises(document, brief);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.path, issue.severity]), [['plan_promise_missing', '/slide[2]', 'info']]);
  assert.match(issues[0].message, /chart/);
  assert.equal(reviewBriefPromises({ slides: document.slides.slice(0, 4) }, brief).some((issue) => issue.code === 'plan_count_mismatch'), true);
});

test('facts and plan lines that wrap across comment lines keep every entry apart', () => {
  const brief = parseAuthoringBrief(`
// BRIEF
// facts: F1 38건 — 리뷰 로그 · F2 0.72 — 미학 점수
//        F3 97% — QA 통과율 · F4 133 — 테스트 수
// slide plan: 1 job: cover · move: 잡는다
//   2 job: evidence · carriers: hero, chart · move: 규모
//   3 job: closing
`);
  assert.deepEqual(brief.facts.map((fact) => fact.id), ['F1', 'F2', 'F3', 'F4']);
  assert.equal(brief.facts[1].source, '미학 점수');
  assert.deepEqual(brief.plan.map((entry) => [entry.slide, entry.role, entry.carriers]), [[1, 'cover', []], [2, '', ['hero', 'chart']], [3, 'closing', []]]);
});

test('geometry-based promises stay silent when the snapshot has no geometry', () => {
  const brief = parseAuthoringBrief(SCRIPT);
  const withGeometry = reviewBriefPromises({ slides: [
    { index: 1, shapes: [{ text: '01', font: { size: 240 } }] },
    { index: 2, shapes: [{ text: 'Title', font: { size: 32 } }] },
    { index: 3, shapes: [{ text: '38', font: { size: 96 } }] },
    { index: 4, shapes: [{ geometry: 'round1Rect' }, { geometry: 'line' }] },
    { index: 5, shapes: [{ text: 'The ask', font: { size: 36 } }] },
  ] }, brief);
  assert.ok(withGeometry.every((issue) => issue.severity === 'info'));
  // The Office COM snapshot reports shape kinds without preset geometry: a diagram cannot be seen there, a chart can.
  const comSnapshot = reviewBriefPromises({ slides: [1, 2, 3, 4].map((index) => ({ index, shapes: [{ type: 1, text: 'x', font: { size: 14 } }] })) }, brief);
  assert.deepEqual(comSnapshot.map((issue) => [issue.code, issue.path]), [['plan_count_mismatch', '/'], ['plan_promise_missing', '/slide[1]'], ['plan_promise_missing', '/slide[2]'], ['plan_promise_missing', '/slide[3]']]);
});

test('a deck built from supplied sources cites where each figure can be opened', () => {
  const grounded = parseAuthoringBrief(`
// BRIEF
// sources: 2026 운영 리포트.pdf · metrics.xlsx
// facts: F1 38건 — 운영 리포트 p.12 · F2 0.72 — metrics.xlsx Sheet1!B4 · F3 97% — https://status.example.com/qa
`);
  assert.deepEqual(grounded.sources, ['2026 운영 리포트.pdf', 'metrics.xlsx']);
  assert.deepEqual(grounded.facts.map((fact) => fact.locator), [true, true, true]);
  assert.deepEqual(reviewSourceGrounding(grounded), []);

  const loose = parseAuthoringBrief(`
// BRIEF
// sources: 2026 운영 리포트.pdf
// facts: F1 38건 — 운영 리포트 · F2 0.72 — 미학 점수 · F3 97% — 리포트 p.9
`);
  const issues = reviewSourceGrounding(loose);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'fact_without_locator');
  assert.match(issues[0].message, /F1, F2/);
  assert.doesNotMatch(issues[0].message, /F3/);

  // No sources line: the facts line is the whole contract and nothing is demanded of it.
  assert.deepEqual(reviewSourceGrounding(parseAuthoringBrief(SCRIPT)), []);
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
