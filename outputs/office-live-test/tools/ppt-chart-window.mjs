// Which PowerPoint chart operation leaves the chart-data Excel window visible in a background session.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const dir = await mkdtemp(join(tmpdir(), 'pptwin-'));
const created = await call({ action: 'create', path: join(dir, 'c.pptx'), format: 'pptx', mode: 'background' });
const session = created.session;
await call({ action: 'batch', session, operations: [{ op: 'add_slide' }] });
const steps = [
  ['no-series', { op: 'add_chart', slide: 1, chartType: 'column', title: 'Initial', left: 40, top: 40, width: 300, height: 180 }],
  ['with-series', { op: 'add_chart', slide: 1, chartType: 'column', title: 'One', categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }], left: 400, top: 40, width: 300, height: 180 }],
  ['set-data', { op: 'set_chart_data', slide: 1, shape: 1, categories: ['X', 'Y'], series: [{ name: 'T', values: [3, 4] }] }],
];
for (const [label, op] of steps) {
  const result = await call({ action: 'batch', session, operations: [op] });
  console.log(label, result.error ? `ERR ${result.error.slice(0, 200)}` : JSON.stringify(result.backgroundIsolation?.observedVisibleWindows));
}
await call({ action: 'close', session });
