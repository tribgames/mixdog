import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { runPptxAuthoringScript } from './authoring/pptx-script-runner.mjs';

test('chart and table styles preserve editable data with explicit visual roles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-chart-style-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kit = await readFile(new URL('../../defaults/skills/pptx/references/kit.md', import.meta.url), 'utf8');
  const blocks = [...kit.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const charts = (await readFile(new URL('../../defaults/skills/pptx/references/charts.md', import.meta.url), 'utf8')).match(/```js\n([\s\S]*?)```/)[1];
  const script = `${blocks[0]}
${blocks.find((b) => b.startsWith('// fitH:')).split('// Title:')[0]}
${charts}
chart(pres.addSlide(), 1, 1, 10, 5, {
  labels: ['Revenue'], series: [{name:'Prior',values:[10.125]},{name:'Current',values:[15.625]}],
  colors: ['445566','007A60'], legend:false
});
chart(pres.addSlide(), 1, 1, 10, 5, {
  type:'bar', labels:['Growth'], series:[{name:'A',values:[18.801]},{name:'B',values:[13.990]},{name:'C',values:[3.811]}],
  grouping:'stacked', categoryLabels:false, showValues:true, colors:['007A60','445566','CCDDEE'], legend:false
});
table(pres.addSlide(), 1, 1, 10, ['Business','Value'], [['Alpha','120.810'],['Beta','106.265']], {
  colW:[6,4], alignments:['left','right'], highlightRows:[1], emphasisCells:[[0,1]], headerFill:'102030', headerColor:'FFFFFF'
});
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'styles.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const [first, stacked, table] = await Promise.all([
    zip.file('ppt/charts/chart1.xml').async('string'),
    zip.file('ppt/charts/chart2.xml').async('string'),
    zip.file('ppt/slides/slide3.xml').async('string'),
  ]);
  assert.ok(zip.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'), 'native editable chart data is retained');
  for (const value of ['10.125', '15.625']) assert.ok(first.includes(`<c:v>${value}</c:v>`));
  assert.ok(first.includes('445566') && first.includes('007A60'));
  assert.doesNotMatch(first, /<c:legend>/);
  assert.match(stacked, /<c:grouping val="stacked"/);
  assert.match(stacked, /<c:dLblPos val="ctr"/);
  for (const value of ['18.801', '13.99', '3.811']) assert.ok(stacked.includes(`<c:v>${value}</c:v>`));
  assert.match(table, /<a:tbl>/);
  assert.ok(table.includes('120.810') && table.includes('106.265'));
  assert.match(table, /algn="r"/);
  assert.match(table, /sz="1800"/, 'default table content uses the balanced body size, not tiny chart captions');
  assert.ok(table.includes('102030') && table.includes('FFFFFF'));
  const dom = new JSDOM(table, { contentType: 'application/xml' });
  const rows = [...dom.window.document.getElementsByTagName('a:tr')];
  const emphasized = rows[1].getElementsByTagName('a:tc')[1];
  const ordinary = rows[2].getElementsByTagName('a:tc')[1];
  assert.equal(emphasized.textContent.includes('120.810'), true);
  assert.equal(emphasized.getElementsByTagName('a:rPr')[0].getAttribute('b'), '1');
  assert.notEqual(ordinary.getElementsByTagName('a:rPr')[0].getAttribute('b'), '1');
  dom.window.close();
});
