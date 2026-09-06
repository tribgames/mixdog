import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// pptxgenjs writes the chart relationship as an absolute part name
// ("/ppt/charts/chart1.xml"), where a hand-built deck writes "../charts/chart1.xml".
const DECK = `
// BRIEF
// facts: sample — test fixture, illustrative figures
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addChart(pres.ChartType.bar, [{ name: 'Retention', labels: ['Self-serve', 'Guided'], values: [38, 52] }], { x: 1, y: 1, w: 11, h: 5 });
await pres.writeFile({ fileName: OUTPUT });
`;

test('set_chart_data edits a pptxgenjs chart through its absolute relationship target, and a duplicated slide shares that part', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'chart.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd }));
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const source = await parts(deck);
  assert.match(await source.text('ppt/slides/_rels/slide1.xml.rels'), /Target="\/ppt\/charts\/chart1\.xml"/);

  const output = join(cwd, 'chart-edited.pptx');
  const opened = value(await executeOfficeTool({
    action: 'open', path: deck, mode: 'portable', output, snapshotAfter: false,
    operations: [{ op: 'duplicate_slide', slide: 1 }],
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch', session: opened.session,
    operations: [{ op: 'set_chart_data', slide: 2, shape: 1, categories: ['Self-serve', 'Guided'], series: [{ name: 'Retention', values: [7, 9] }] }],
  }, { cwd }));
  assert.equal(edited.results[0].chart, 'ppt/charts/chart1.xml');
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

  const result = await parts(output);
  assert.equal(result.has('ppt/charts/chart2.xml'), false, 'the copy references the source chart part instead of cloning it');
  for (const slide of [1, 2]) {
    assert.match(await result.text(`ppt/slides/_rels/slide${slide}.xml.rels`), /Target="\/ppt\/charts\/chart1\.xml"/);
  }
  const chart = await result.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:v>7<\/c:v>/);
  assert.match(chart, /<c:v>9<\/c:v>/);
  assert.doesNotMatch(chart, /<c:v>38<\/c:v>/);
});
