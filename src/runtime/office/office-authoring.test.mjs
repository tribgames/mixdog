import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import { runPptxAuthoringScript } from './authoring/pptx-script-runner.mjs';
import { normalizeParagraphProperties } from './authoring/pptx-script-normalize.mjs';
import { loadPackage, zipText } from './portable/portable-opc.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

const DECK_SCRIPT = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const cover = pres.addSlide();
cover.background = { color: '1E2761' };
cover.addText('Retention rose after onboarding', { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Cambria', fontSize: 40, bold: true, color: 'FFFFFF' });
const content = pres.addSlide();
content.addText('Week-4 retention', { x: 0.8, y: 0.6, w: 11.5, h: 0.9, fontFace: 'Cambria', fontSize: 36, bold: true, color: '1E2761' });
content.addChart(pres.ChartType.bar, [{ name: 'Retention', labels: ['Before', 'After'], values: [31, 47] }], {
  x: 0.8, y: 1.8, w: 7, h: 4.8, chartColors: ['1E2761'], showValue: true, dataLabelPosition: 'outEnd', showLegend: false,
});
content.addText('Guided setup lifted week-4 retention by 16 points.', { x: 8.2, y: 2.4, w: 4.3, h: 2, fontFace: 'Calibri', fontSize: 16, color: '333333' });
await pres.writeFile({ fileName: OUTPUT });
`;

test('author without a script points at the pptx skill instead of serving a guide', async (t) => {
  const cwd = await workspace(t);
  const result = await executeOfficeTool({ action: 'author' }, { cwd });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Skill name:"pptx"/);
});

test('author writes a deck from a pptxgenjs script and opens a session on it', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'authored.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script: DECK_SCRIPT, mode: 'portable', render: false }, { cwd }));
  assert.equal(authored.ok, true);
  assert.ok(authored.bytes > 1000);
  assert.equal(authored.output, path);
  assert.equal(authored.artifacts?.[0]?.operation, 'create');
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: authored.session }, { cwd }));
  assert.equal(snapshot.document.slides.length, 2);
  const validation = value(await executeOfficeTool({ action: 'validate', session: authored.session }, { cwd }));
  assert.equal(validation.ok, true, JSON.stringify(validation.issues || validation));
  const again = value(await executeOfficeTool({ action: 'author', path, script: DECK_SCRIPT, mode: 'portable', render: false }, { cwd }));
  assert.equal(again.ok, true);
  assert.equal(again.replacedSession, authored.session);
  assert.notEqual(again.session, authored.session);
});

test('author reports script failures with the offending line', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'broken.pptx');
  const failed = value(await executeOfficeTool({
    action: 'author',
    path,
    mode: 'portable',
    script: 'const pptxgen = require("pptxgenjs");\nconst pres = new pptxgen();\nundefinedCall();\n',
  }, { cwd }));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'script_failed');
  assert.match(failed.error.message, /undefinedCall/);
  assert.equal(failed.error.line, 3);
});

test('authored decks keep one paragraph-properties element per paragraph', async (t) => {
  const doubled = '<a:p><a:pPr indent="0"/><a:r><a:t>a</a:t></a:r><a:pPr indent="0"><a:buNone/></a:pPr><a:r><a:t>b</a:t></a:r></a:p><a:p><a:pPr/><a:r><a:t>c</a:t></a:r></a:p>';
  const normalized = normalizeParagraphProperties(doubled);
  assert.equal(normalized.removed, 1);
  assert.equal(normalized.xml, '<a:p><a:pPr indent="0"/><a:r><a:t>a</a:t></a:r><a:r><a:t>b</a:t></a:r></a:p><a:p><a:pPr/><a:r><a:t>c</a:t></a:r></a:p>');

  // pptxgenjs writes a pPr for every run; a two-run paragraph must come out of
  // the runner schema-valid without an Office re-save.
  const cwd = await workspace(t);
  const path = join(cwd, 'runs.pptx');
  const run = await runPptxAuthoringScript(`
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addText([{ text: 'plain ', options: {} }, { text: '42%', options: { bold: true, color: 'B85042' } }, { text: ' of users', options: {} }],
  { x: 1, y: 1, w: 8, h: 1, fontSize: 18, lineSpacingMultiple: 1.3 });
await pres.writeFile({ fileName: OUTPUT });
`, path);
  assert.equal(run.ok, true, run.error?.message);
  assert.ok(run.normalizedParagraphs >= 2);
  const slideXml = await zipText(await loadPackage(path), 'ppt/slides/slide1.xml');
  for (const paragraph of slideXml.match(/<a:p>[\s\S]*?<\/a:p>/g)) {
    assert.ok((paragraph.match(/<a:pPr/g) || []).length <= 1, paragraph);
  }
});

test('authoring scripts cannot require modules outside the contract', async (t) => {
  const cwd = await workspace(t);
  const run = await runPptxAuthoringScript('require("child_process");', join(cwd, 'blocked.pptx'));
  assert.equal(run.ok, false);
  assert.match(run.error.message, /not available/);
  const missing = await runPptxAuthoringScript('const pptxgen = require("pptxgenjs"); new pptxgen();', join(cwd, 'missing.pptx'));
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /without writing OUTPUT/);
});
