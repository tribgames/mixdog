// Opens a portable-written pivot workbook in Microsoft Excel (background) and reads the pivot back, so a cache Excel
// would repair or refuse shows up here.
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
const work = 'outputs/office-live-test/real/sample-pivot-check.xlsx';
await copyFile('outputs/office-live-test/real/sample-pivot-portable.xlsx', work);
const opened = await call({ action: 'open', path: work, mode: 'background' });
console.log('open', opened.error || opened.backend);
const snap = await call({ action: 'snapshot', session: opened.session, sheet: 'Pivot', range: 'A3:D10' });
const sheet = snap.document?.sheets?.[0];
console.log('cells', JSON.stringify((sheet?.cells || []).map((c) => [c.address || c.path, c.value]).slice(0, 14)));
console.log('pivots', JSON.stringify(sheet?.pivotTables || sheet?.pivots || snap.document?.pivotTables || '').slice(0, 400));
const rendered = await call({ action: 'render', session: opened.session, pages: [] });
console.log('render', rendered.error || rendered.pageCount);
await call({ action: 'close', session: opened.session });
