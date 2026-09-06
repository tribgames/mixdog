import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import { documentSessionKey, documentSessions, sessions } from './core/office-core.mjs';
import { factsGate, parseAuthoringBrief, reviewFactCoverage } from './authoring/pptx-brief.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

function deck({ facts = null, headline = 'Week-4 retention reached 47% after guided onboarding' } = {}) {
  return `// BRIEF
// subject/audience/action: retention review for the product team
${facts === null ? '' : `// facts: ${facts}\n`}const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addText(${JSON.stringify(headline)}, { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Arial', fontSize: 32, bold: true, color: '1E2761' });
await pres.writeFile({ fileName: OUTPUT });
`;
}

test('the brief names its facts mode and the author gate mirrors the fact review', () => {
  const sourced = parseAuthoringBrief('// BRIEF\n// facts: F1 47% — user brief\n');
  assert.equal(sourced.factsMode, 'sourced');
  const sample = parseAuthoringBrief('// BRIEF\n// facts: sample — projections not measured yet\n');
  assert.equal(sample.factsMode, 'sample');
  assert.equal(sample.factsNote, 'projections not measured yet');
  assert.deepEqual(sample.facts, []);
  const none = parseAuthoringBrief('// BRIEF\n// subject/audience/action: review\n');
  assert.equal(none.factsMode, 'none');

  const document = {
    slides: [
      { index: 1, shapes: [{ text: 'Retention reached 47% and churn fell 12%' }] },
      { index: 2, shapes: [{ text: 'Q3 2024 review' }, { placeholder: true, text: '99 placeholder' }] },
    ],
  };
  assert.deepEqual(factsGate(document, none), { blocked: true, code: 'facts_missing', slides: [{ slide: 1, figures: ['47%', '12%'] }] });
  assert.deepEqual(factsGate(document, sourced), { blocked: true, code: 'number_without_fact', slides: [{ slide: 1, figures: ['12%'] }] });
  assert.deepEqual(factsGate(document, parseAuthoringBrief('// BRIEF\n// facts: F1 47% — user brief · F2 12% — user brief\n')), { blocked: false });
  assert.deepEqual(factsGate(document, sample), { blocked: false });
  assert.deepEqual(factsGate(document, parseAuthoringBrief('const deckWithoutBrief = 1;')), { blocked: false });
  assert.deepEqual(factsGate({ slides: [{ index: 1, shapes: [{ text: 'No figures here' }] }] }, none), { blocked: false });
  assert.deepEqual(reviewFactCoverage(document, sample).map((issue) => [issue.code, issue.severity]), [['facts_illustrative', 'info']]);
});

test('author refuses to land a deck whose figures have no fact and leaves the previous deck untouched', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'gated.pptx');
  const refused = value(await executeOfficeTool({ action: 'author', path, script: deck(), mode: 'portable', render: false }, { cwd }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'facts_gate');
  assert.equal(refused.gate.code, 'facts_missing');
  assert.deepEqual(refused.gate.slides, [{ slide: 1, figures: ['47%'] }]);
  assert.match(refused.nextAction, /facts: sample/);
  assert.equal(refused.session, undefined);
  await assert.rejects(access(path));
  assert.equal(documentSessions.has(documentSessionKey(path)), false);

  const landed = value(await executeOfficeTool({ action: 'author', path, script: deck({ facts: 'F1 47% — user brief' }), mode: 'portable', render: false }, { cwd }));
  assert.equal(landed.ok, true);
  assert.equal(landed.factsMode, undefined);
  assert.equal(landed.audit.status, 'pass', JSON.stringify(landed.audit));

  const again = value(await executeOfficeTool({
    action: 'author',
    path,
    script: deck({ facts: 'F1 47% — user brief', headline: 'Retention reached 47% while churn fell 12%' }),
    mode: 'portable',
    render: false,
  }, { cwd }));
  assert.equal(again.ok, false);
  assert.equal(again.gate.code, 'number_without_fact');
  assert.deepEqual(again.gate.slides, [{ slide: 1, figures: ['12%'] }]);
  assert.equal(sessions.has(landed.session), true);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: landed.session }, { cwd }));
  const slideText = JSON.stringify(snapshot.document.slides[0]);
  assert.match(slideText, /47%/);
  assert.doesNotMatch(slideText, /12%/);
});

test('facts: sample lands the deck and carries its disclosure on author and qa', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'sample.pptx');
  const landed = value(await executeOfficeTool({
    action: 'author',
    path,
    script: deck({ facts: 'sample — projections not measured yet' }),
    mode: 'portable',
    render: false,
  }, { cwd }));
  assert.equal(landed.ok, true);
  assert.equal(landed.factsMode, 'sample');
  assert.match(landed.disclosure, /illustrative/);
  const reviewed = value(await executeOfficeTool({ action: 'qa', session: landed.session, render: false }, { cwd }));
  assert.equal(reviewed.factsMode, 'sample');
  assert.ok(reviewed.issuesAfter.some((issue) => issue.code === 'facts_illustrative' && issue.severity === 'info'), JSON.stringify(reviewed.issuesAfter));
  assert.ok(!reviewed.issuesAfter.some((issue) => ['number_without_fact', 'facts_missing'].includes(issue.code)));
});
