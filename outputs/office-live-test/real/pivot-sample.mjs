// A pivot table over Microsoft's Financial Sample (700 rows): profit by segment × year, on its own sheet, rendered.
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const mode = process.argv[2] || 'portable';
const call = async (args) => {
  const text = (await executeOfficeTool(args, { cwd })).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};
const work = `outputs/office-live-test/real/sample-pivot-${mode}.xlsx`;
await copyFile('outputs/office-live-test/real/sample.xlsx', work);
const { session, error } = await call({ action: 'open', path: work, mode });
if (error) throw new Error(error);
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'add_sheet', name: 'Pivot' },
    { op: 'add_pivot_table', sheet: 'Sheet1', source: 'A1:P701', destinationSheet: 'Pivot', destination: 'A3', name: 'ProfitBySegment', rows: ['Segment'], columns: ['Year'], values: [{ field: 'Profit', function: 'sum' }] },
    { op: 'set_range', sheet: 'Pivot', range: 'A1', values: [['Profit by segment and year']] },
    { op: 'set_style', sheet: 'Pivot', range: 'A1', properties: { fontSize: 14, bold: true } },
  ],
});
console.log('batch', batch.error || JSON.stringify(batch.results?.map((r) => ({ op: r.op, changed: r.changed, range: r.range, rows: r.rows }))).slice(0, 800));
const snap = await call({ action: 'snapshot', session, sheet: 'Pivot', range: 'A1:E10' });
console.log(JSON.stringify(snap.document?.sheets?.[0]?.cells?.map((c) => [c.address || c.path, c.value, c.style?.numberFormat]).slice(0, 40)));
const rendered = await call({ action: 'render', session, sheet: 'Pivot' });
console.log('render', rendered.error || (rendered.images || []).map((i) => i.path).slice(-2).join(' '));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).filter((i) => /Pivot/.test(i.path || '')).map((i) => `${i.code} ${i.path} ${i.message}`)).slice(0, 1200));
await call({ action: 'close', session });
