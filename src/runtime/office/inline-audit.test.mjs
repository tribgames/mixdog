import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import {
  INLINE_AUDIT_MAX_ROUNDS,
  INLINE_AUDIT_TOP,
  recordInlineAuditRound,
  summarizeOfficeAudit,
  touchedLocations,
} from './quality/inline-audit.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

const CLEAN_DECK = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const cover = pres.addSlide();
cover.background = { color: '1E2761' };
cover.addText('Retention rose after onboarding', { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Arial', fontSize: 40, bold: true, color: 'FFFFFF' });
const content = pres.addSlide();
content.addText('Week-4 retention', { x: 0.8, y: 0.6, w: 11.5, h: 0.9, fontFace: 'Arial', fontSize: 36, bold: true, color: '1E2761' });
content.addChart(pres.ChartType.bar, [{ name: 'Retention', labels: ['Before', 'After'], values: [31, 47] }], {
  x: 0.8, y: 1.8, w: 7, h: 4.8, chartColors: ['1E2761'], showValue: true, showLegend: false,
});
content.addText('Guided setup lifted week-4 retention by 16 points.', { x: 8.2, y: 2.4, w: 4.3, h: 2, fontFace: 'Arial', fontSize: 16, color: '333333' });
await pres.writeFile({ fileName: OUTPUT });
`;

const OVERFLOW_DECK = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addText('Retention rose after onboarding and kept rising through the second quarter of the year while support tickets fell', { x: 0.8, y: 0.6, w: 2.5, h: 0.4, fontFace: 'Arial', fontSize: 28, color: '333333' });
await pres.writeFile({ fileName: OUTPUT });
`;

const LONG_TITLE = 'Retention rose after onboarding and kept rising through the second quarter of the year while support tickets fell by a third and the activation funnel shortened from nine days to four for every cohort that started after the guided setup shipped in March';

test('summarizeOfficeAudit ranks touched locations first, drops advisories from the targets, and caps the list', () => {
  const issueList = [
    { severity: 'warning', code: 'text_overflow', path: '/slide[3]/shape[2]', message: 'over' },
    { severity: 'error', code: 'missing_relationship', path: '/ppt/slides/_rels/slide1.xml.rels', message: 'rel' },
    { severity: 'info', code: 'shapes_too_close', path: '/slide[1]/shape[1]', message: 'close' },
    { severity: 'warning', code: 'low_contrast', path: '/slide[1]/shape[4]', message: 'dim' },
    ...Array.from({ length: INLINE_AUDIT_TOP + 3 }, (_, index) => ({
      severity: 'warning', code: 'text_overflow', path: `/slide[${index + 4}]/shape[1]`, message: `over ${index}`,
    })),
  ];
  const audit = summarizeOfficeAudit(issueList, { touched: ['/slide[3]'] });
  assert.equal(audit.status, 'fail');
  assert.deepEqual(audit.counts, { error: 1, warning: INLINE_AUDIT_TOP + 5, info: 1 });
  assert.equal(audit.top.length, INLINE_AUDIT_TOP);
  assert.equal(audit.top[0].path, '/slide[3]/shape[2]');
  assert.equal(audit.top[1].code, 'missing_relationship');
  assert.ok(audit.top.every((issue) => issue.severity !== 'info'));
  assert.equal(audit.truncated, INLINE_AUDIT_TOP + 6 - INLINE_AUDIT_TOP);
  assert.equal(audit.locations[0].slide, 3);
  assert.equal(audit.locations.find((entry) => entry.label === 'document').error, 1);
  assert.ok(!audit.locations.some((entry) => entry.slide === 1 && !entry.warning));

  const clean = summarizeOfficeAudit([{ severity: 'info', code: 'shapes_too_close', path: '/slide[1]/shape[1]', message: 'close' }]);
  assert.equal(clean.status, 'pass');
  assert.deepEqual(clean.top, []);
  assert.deepEqual(clean.locations, []);
});

test('touchedLocations reads the edited slide, sheet, or body from the batch operations', () => {
  assert.deepEqual(touchedLocations('pptx', [{ op: 'set_text', slide: 2, shape: 1 }, { op: 'keep_slides', slides: [1, 4] }]), ['/slide[2]', '/slide[1]', '/slide[4]']);
  assert.deepEqual(touchedLocations('xlsx', [{ op: 'set_range', sheet: 'Data', range: 'A1' }]), ['/sheet[Data]']);
  assert.deepEqual(touchedLocations('docx', [{ op: 'replace_text', find: 'a', replace: 'b' }]), ['/body']);
  assert.deepEqual(touchedLocations('pptx', []), []);
});

test('audit rounds count consecutive failures on the session and reset on a pass', () => {
  const session = {};
  const failing = () => summarizeOfficeAudit([{ severity: 'warning', code: 'text_overflow', path: '/slide[1]/shape[1]', message: 'over' }]);
  assert.equal(recordInlineAuditRound(session, failing()).round, 1);
  assert.match(recordInlineAuditRound(session, failing()).nextAction, new RegExp(`round 2 of ${INLINE_AUDIT_MAX_ROUNDS}`));
  const exhausted = recordInlineAuditRound(session, failing());
  assert.equal(exhausted.round, INLINE_AUDIT_MAX_ROUNDS + 1);
  assert.match(exhausted.nextAction, /report what remains/);
  const passed = recordInlineAuditRound(session, summarizeOfficeAudit([]));
  assert.equal(passed.round, 0);
  assert.match(passed.nextAction, /passed/);
});

test('author returns the measured audit and keeps counting fix rounds across re-authors of the same deck', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'audited.pptx');
  const author = async () => value(await executeOfficeTool({ action: 'author', path, script: OVERFLOW_DECK, mode: 'portable', render: false }, { cwd }));
  const first = await author();
  assert.equal(first.ok, true);
  assert.equal(first.audit.status, 'fail', JSON.stringify(first.audit));
  assert.equal(first.audit.round, 1);
  assert.ok(first.audit.top.some((issue) => ['text_overflow', 'text_box_too_narrow'].includes(issue.code) && /^\/slide\[1\]/.test(issue.path)), JSON.stringify(first.audit.top));
  assert.equal(first.audit.locations[0].slide, 1);
  assert.match(first.nextAction, /same turn/);
  const second = await author();
  assert.equal(second.audit.round, 2);
  const third = await author();
  assert.equal(third.audit.round, 3);
  assert.match(third.nextAction, /report what remains/);

  const clean = value(await executeOfficeTool({ action: 'author', path, script: CLEAN_DECK, mode: 'portable', render: false }, { cwd }));
  assert.equal(clean.audit.status, 'pass', JSON.stringify(clean.audit));
  assert.equal(clean.audit.round, 0);
  assert.match(clean.nextAction, /action:render/);

  const silent = value(await executeOfficeTool({ action: 'author', path, script: CLEAN_DECK, mode: 'portable', render: false, audit: false }, { cwd }));
  assert.equal(silent.audit, undefined);
});

test('batch returns the audit of the edited deck with the touched slide first', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'batched.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script: CLEAN_DECK, mode: 'portable', render: false }, { cwd }));
  assert.equal(authored.audit.status, 'pass', JSON.stringify(authored.audit));
  const broken = value(await executeOfficeTool({
    action: 'batch',
    session: authored.session,
    operations: [{ op: 'set_text', slide: 1, shape: 1, text: LONG_TITLE }],
  }, { cwd }));
  assert.equal(broken.ok, true);
  assert.equal(broken.audit.status, 'fail', JSON.stringify(broken.audit));
  assert.equal(broken.audit.round, 1);
  assert.match(broken.audit.top[0].path, /^\/slide\[1\]/);
  assert.equal(broken.audit.locations[0].slide, 1);
  const repaired = value(await executeOfficeTool({
    action: 'batch',
    session: authored.session,
    operations: [{ op: 'set_text', slide: 1, shape: 1, text: 'Retention rose after onboarding' }],
  }, { cwd }));
  assert.equal(repaired.audit.status, 'pass', JSON.stringify(repaired.audit));
  assert.equal(repaired.audit.round, 0);
  const silent = value(await executeOfficeTool({
    action: 'batch',
    session: authored.session,
    operations: [{ op: 'set_text', slide: 1, shape: 1, text: 'Retention rose after onboarding again' }],
    audit: false,
  }, { cwd }));
  assert.equal(silent.audit, undefined);
});
