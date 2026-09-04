import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import JSZip from 'jszip';
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
  // Hanging punctuation is switched off on every paragraph so the box is the measure (a trailing
  // Korean period otherwise hangs 1-4 pt past the edge and reads as text_overflow).
  assert.equal(normalized.xml, '<a:p><a:pPr hangingPunct="0" indent="0"/><a:r><a:t>a</a:t></a:r><a:r><a:t>b</a:t></a:r></a:p><a:p><a:pPr hangingPunct="0"/><a:r><a:t>c</a:t></a:r></a:p>');
  const bare = normalizeParagraphProperties('<a:p><a:r><a:t>d</a:t></a:r></a:p><a:p><a:pPr hangingPunct="1"/><a:r><a:t>e</a:t></a:r></a:p>');
  assert.equal(bare.xml, '<a:p><a:pPr hangingPunct="0"/><a:r><a:t>d</a:t></a:r></a:p><a:p><a:pPr hangingPunct="0"/><a:r><a:t>e</a:t></a:r></a:p>');

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

test('an accented bar drawn as two stacked series is saved as one series with a per-point fill', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'accent.pptx');
  const run = await runPptxAuthoringScript(`
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
const labels = ['Q1', 'Q2', 'Q3', 'Q4'], values = [10, 12, 15, 9];
slide.addChart(pres.ChartType.bar, [
  { name: '매출', labels, values: values.map((v, i) => (i === 2 ? 0 : v)) },
  { name: '매출 ·', labels, values: values.map((v, i) => (i === 2 ? v : 0)) },
], { x: 1, y: 1, w: 8, h: 4, barDir: 'col', barGrouping: 'stacked', chartColors: ['E6ECF3', '1F5FBF'], showValue: true, dataLabelPosition: 'inEnd' });
await pres.writeFile({ fileName: OUTPUT });
`, path);
  assert.equal(run.ok, true, run.error?.message);
  const zip = await loadPackage(path);
  // pptxgenjs numbers chart parts per process, so the part is found, not assumed.
  const chartPart = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const chart = await zipText(zip, chartPart);
  assert.equal((chart.match(/<c:ser>/g) || []).length, 1, 'one series');
  assert.match(chart, /<c:grouping val="clustered"\/>/);
  assert.doesNotMatch(chart, /<c:overlap/);
  assert.match(chart, /<c:dPt><c:idx val="2"\/>[\s\S]*?<a:srgbClr val="1F5FBF"\/>/, 'the accent point carries the overlay color');
  assert.match(chart, /<c:pt idx="2"><c:v>15<\/c:v>/, 'the merged series holds the real value at the accent index');
  const embedded = Object.keys(zip.files).find((name) => /embeddings\/.*\.xlsx$/.test(name));
  const workbook = await JSZip.loadAsync(await zip.file(embedded).async('nodebuffer'));
  const sheet = await workbook.file('xl/worksheets/sheet1.xml').async('string');
  assert.doesNotMatch(sheet, /<c r="C/, 'the overlay column is gone from the workbook');
  assert.match(sheet, /<c r="B4"[^>]*><v>15<\/v>/, 'the accent row holds its value in the one column');
});

test('authoring scripts reach the offline icon set through ICON by name', async (t) => {
  const cwd = await workspace(t);
  const run = await runPptxAuthoringScript(`
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
if (ICON.names.length < 200) throw new Error('icon set too small: ' + ICON.names.length);
if (!/<path/.test(ICON('chart-line'))) throw new Error('no markup');
const svg = ICON.svg('rocket', { color: '1F5FBF', size: 128 });
if (!/stroke="#1F5FBF"/.test(svg)) throw new Error('color not applied');
const buf = await sharp(Buffer.from(svg)).png().toBuffer();
slide.addImage({ data: 'image/png;base64,' + buf.toString('base64'), x: 1, y: 1, w: 1, h: 1 });
let unknown = '';
try { ICON('barchart'); } catch (error) { unknown = error.message; }
if (!/Nearest: .*chart/.test(unknown)) throw new Error('no nearest hint: ' + unknown);
console.log('nearest', unknown);
await pres.writeFile({ fileName: OUTPUT });
`, join(cwd, 'icons.pptx'));
  assert.equal(run.ok, true, run.error?.message);
  assert.ok(run.logs.some((line) => /Nearest: /.test(line.text)));
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
