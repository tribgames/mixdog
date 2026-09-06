import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import {
  QC_MAX_PAGES,
  decidePage,
  othersChanged,
  pageDefects,
  parsePages,
  qcInstruction,
  runPageQc,
  slideFingerprints,
  slideInventory,
  workingCopyPath,
} from '../../defaults/skills/pptx/scripts/qc-pages.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// Slide 1 is a clean statement; slide 2 carries a measurable overflow that
// fit_text at 12 pt resolves.
const DECK = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const cover = pres.addSlide();
cover.background = { color: '1E2761' };
cover.addText('Retention rose after onboarding', { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Arial', fontSize: 40, bold: true, color: 'FFFFFF' });
const body = pres.addSlide();
body.addText('Guided setup lifted week-four retention across every cohort that started after March', { x: 0.8, y: 3.4, w: 6, h: 0.6, fontFace: 'Arial', fontSize: 28, color: '333333' });
await pres.writeFile({ fileName: OUTPUT });
`;

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

async function authoredDeck(t) {
  const cwd = await workspace(t);
  const deck = join(cwd, 'qc.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd }));
  assert.equal(authored.ok, true);
  assert.equal(authored.audit.status, 'fail', JSON.stringify(authored.audit));
  assert.deepEqual(authored.audit.locations.map((entry) => entry.slide), [2]);
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  return { cwd, deck };
}

// A stand-in for the fixer session: it edits the deck through the office tool
// exactly as the child would, then reports.
function child(cwd, deck, operations, reply = 'Fitted the body text.') {
  return async (options) => {
    assert.equal(options.webSearch, false);
    assert.match(options.message, /Slide 2 of 2/);
    assert.ok(options.message.includes(`output:"${workingCopyPath(deck, 2)}"`));
    const opened = value(await executeOfficeTool({ action: 'open', path: deck, mode: 'portable', output: workingCopyPath(deck, 2), snapshotAfter: false }, { cwd }));
    value(await executeOfficeTool({ action: 'batch', session: opened.session, operations }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
    options.write(reply);
    return 0;
  };
}

test('page selection, defect scoping, fingerprints, and the verdict are pure readings', () => {
  assert.deepEqual(parsePages('all', 3), [1, 2, 3]);
  assert.deepEqual(parsePages('2-3,1', 3), [1, 2, 3]);
  assert.throws(() => parsePages('4', 3), /out of range/);
  assert.throws(() => parsePages('x', 3), /invalid/);
  const issues = [
    { severity: 'warning', code: 'text_overflow', path: '/slide[2]/shape[1]', message: 'over' },
    { severity: 'info', code: 'shapes_too_close', path: '/slide[2]/shape[1]', message: 'close' },
    { severity: 'warning', code: 'vertical_imbalance', path: '/slide[2]', message: 'hollow' },
    { severity: 'warning', code: 'text_overflow', path: '/slide[21]/shape[1]', message: 'other' },
  ];
  assert.deepEqual(pageDefects(issues, 2).map((issue) => issue.code), ['text_overflow', 'vertical_imbalance']);
  const document = {
    slides: [
      { index: 1, text: ['a'], shapes: [{ index: 1, type: 'p:sp', text: 'a', left: 1, top: 1, width: 2, height: 1, font: { size: 40, bold: true }, fill: { color: '1E2761' } }] },
      { index: 2, text: ['b'], shapes: [{ index: 1, type: 'p:sp', text: 'b', left: 1, top: 1, width: 2, height: 1 }] },
    ],
  };
  const before = slideFingerprints(document);
  const moved = structuredClone(document);
  moved.slides[1].shapes[0].left = 3;
  assert.equal(othersChanged(before, slideFingerprints(moved), 2), false);
  assert.equal(othersChanged(before, slideFingerprints(moved), 1), true);
  assert.equal(othersChanged(before, slideFingerprints({ slides: document.slides.slice(0, 1) }), 2), true);
  assert.deepEqual(decidePage({ before: 2, after: 1 }), { keep: true, reason: 'improved' });
  assert.deepEqual(decidePage({ before: 1, after: 1 }), { keep: true, reason: 'unchanged' });
  assert.deepEqual(decidePage({ before: 1, after: 2 }), { keep: false, reason: 'regression' });
  assert.deepEqual(decidePage({ before: 0, after: 0, scopeChanged: true }), { keep: false, reason: 'scope' });
  assert.deepEqual(decidePage({ before: 0, after: 0, auditFailed: true }), { keep: false, reason: 'audit_failed' });
  assert.deepEqual(slideInventory(document, 1), ['shape[1] text left 1 top 1 width 2 height 1 font 40 bold fill 1E2761 "a"']);
  const geometryOnly = qcInstruction({ deck: 'C:/decks/a.pptx', copy: 'C:/decks/.a.qc-page-2.pptx', page: 2, total: 2, inventory: slideInventory(document, 2), defects: pageDefects(issues, 2), imagePath: '' });
  assert.match(geometryOnly, /No rendering is available/);
  assert.match(geometryOnly, /output:"C:\/decks\/\.a\.qc-page-2\.pptx"/);
  assert.match(geometryOnly, /every operation names slide: 2/);
  assert.match(geometryOnly, /text_overflow \/slide\[2\]\/shape\[1\]/);
  assert.match(geometryOnly, /STRICTLY FORBIDDEN: touching any other slide/);
  const visual = qcInstruction({ deck: 'C:/decks/a.pptx', copy: 'C:/decks/.a.qc-page-1.pptx', page: 1, total: 2, inventory: [], defects: [], imagePath: 'C:/decks/page-1.png' });
  assert.match(visual, /Rendered page: C:\/decks\/page-1\.png/);
  assert.match(visual, /found nothing on this slide/);
});

test('a fix that reduces the measured defects is kept and a clean page never reaches the model', async (t) => {
  const { cwd, deck } = await authoredDeck(t);
  let calls = 0;
  const report = await runPageQc({ deck, provider: 'test-provider', model: 'test-model', vision: false, output: join(cwd, 'qc.json') }, {
    execute: async (options) => {
      calls += 1;
      return child(cwd, deck, [{ op: 'fit_text', slide: 2, shape: 1, minFontSize: 12 }])(options);
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.deepEqual(report.pages.map((entry) => [entry.page, entry.reason, entry.kept, entry.edited]), [[1, 'clean', true, false], [2, 'improved', true, true]]);
  assert.equal(report.fixed, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.pages[1].before, 1);
  assert.equal(report.pages[1].after, 0);
  assert.equal(report.pages[1].reply, 'Fitted the body text.');
  assert.equal(JSON.parse(await readFile(join(cwd, 'qc.json'), 'utf8')).fixed, 1);
  const reopened = value(await executeOfficeTool({ action: 'open', path: deck, mode: 'portable', snapshotAfter: false }, { cwd }));
  const measured = value(await executeOfficeTool({ action: 'issues', session: reopened.session }, { cwd }));
  assert.equal(pageDefects(measured.issues, 2).length, 0, JSON.stringify(measured.issues));
  value(await executeOfficeTool({ action: 'close', session: reopened.session }, { cwd }));
});

test('an edit outside the page, a grown defect count, or an unreadable deck is reverted from the backup', async (t) => {
  const { cwd, deck } = await authoredDeck(t);
  const pristine = await sha256(deck);
  const scope = await runPageQc({ deck, pages: '2', provider: 'test-provider', model: 'test-model', vision: false }, {
    execute: child(cwd, deck, [{ op: 'set_text', slide: 1, shape: 1, text: 'Retention fell' }], 'Moved the title.'),
  });
  assert.deepEqual(scope.pages.map((entry) => [entry.page, entry.reason, entry.kept, entry.edited]), [[2, 'scope', false, true]]);
  assert.equal(scope.discarded, 1);
  assert.equal(await sha256(deck), pristine);
  assert.equal(await readFile(workingCopyPath(deck, 2)).then(() => true, () => false), false);

  const regression = await runPageQc({ deck, pages: '2', provider: 'test-provider', model: 'test-model', vision: false }, {
    execute: child(cwd, deck, [{
      op: 'add_shape',
      slide: 2,
      shapeType: 'rect',
      text: 'A second box whose copy is far too long for the frame it was given on this slide',
      left: 72,
      top: 360,
      width: 144,
      height: 29,
      properties: { fontSize: 24 },
    }], 'Added a caption.'),
  });
  assert.deepEqual(regression.pages.map((entry) => [entry.reason, entry.kept]), [['regression', false]]);
  assert.equal(regression.pages[0].before, 1);
  assert.equal(await sha256(deck), pristine);

  const corrupt = await runPageQc({ deck, pages: '2', provider: 'test-provider', model: 'test-model', vision: false }, {
    execute: async (options) => {
      await writeFile(workingCopyPath(deck, 2), 'not a deck any more');
      options.write('Rewrote the file.');
      return 0;
    },
  });
  assert.deepEqual(corrupt.pages.map((entry) => [entry.reason, entry.kept]), [['audit_failed', false]]);
  assert.equal(await sha256(deck), pristine);

  const failed = await runPageQc({ deck, pages: '2', provider: 'test-provider', model: 'test-model', vision: false }, {
    execute: async () => { throw new Error('provider unavailable'); },
  });
  assert.deepEqual(failed.pages.map((entry) => [entry.reason, entry.kept, entry.edited]), [['execution_failed', true, false]]);
  assert.match(failed.pages[0].errors[0], /provider unavailable/);
  assert.equal(await sha256(deck), pristine);
});

test('the run needs an explicit route and caps the pages it hands out', async (t) => {
  const { cwd, deck } = await authoredDeck(t);
  await assert.rejects(runPageQc({ deck, provider: '', model: 'm' }, { execute: async () => 0 }), /explicit --provider and --model/);
  assert.equal(QC_MAX_PAGES, 20);
  const capped = await runPageQc({ deck, provider: 'p', model: 'm', vision: false, maxPages: 1 }, {
    execute: async () => { throw new Error('the capped page must not run'); },
  });
  assert.deepEqual(capped.pages.map((entry) => [entry.page, entry.reason]), [[1, 'clean']]);
  assert.deepEqual(capped.skippedPages, [2]);
  assert.equal(cwd.length > 0, true);
});
