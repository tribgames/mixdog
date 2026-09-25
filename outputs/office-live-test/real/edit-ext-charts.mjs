// A third-party deck full of native charts (python-pptx's chart fixture): read the roster, refresh one chart's data
// the way a monthly update would, and confirm the chart keeps its treatment and the audit stays quiet.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const call = async (args) => {
  const text = (await executeOfficeTool(args, { cwd })).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};
const work = 'outputs/office-live-test/real/ext2-edited.pptx';
await copyFile('outputs/office-live-test/real/ext2.pptx', work);
const { session, error } = await call({ action: 'open', path: work, mode: 'portable' });
if (error) throw new Error(error);
const snap = await call({ action: 'snapshot', session, pages: [1, 2, 3] });
for (const slide of snap.document.slides) {
  for (const shape of slide.shapes.filter((s) => s.chart)) {
    console.log(slide.index, shape.index, JSON.stringify({ type: shape.chart.type ?? shape.chart.chartType, series: shape.chart.series?.length, categories: shape.chart.categories?.length ?? shape.chart.categoryCount }).slice(0, 200));
  }
}
const first = snap.document.slides.flatMap((slide) => slide.shapes.filter((s) => s.chart).map((s) => ({ slide: slide.index, shape: s.index, chart: s.chart })))[0];
console.log('first', JSON.stringify(first?.chart).slice(0, 600));
const batch = await call({
  action: 'batch',
  session,
  operations: [{ op: 'set_chart_data', slide: first.slide, shape: first.shape, categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [12, 18, 15, 22] }, { name: 'Cost', values: [8, 9, 11, 12] }] }],
});
console.log('batch', batch.error || JSON.stringify(batch.results).slice(0, 600));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 1500));
const rendered = await call({ action: 'render', session, pages: [first.slide] });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).join(' '));
await call({ action: 'close', session });
