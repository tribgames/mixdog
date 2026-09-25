// Microsoft's "Financial Sample.xlsx" (700 rows, one Excel table) edited the way an analyst would: a summary sheet
// of SUMIFS by segment and country, a profit margin column, a native chart, a printed page; then render and audit.
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
const work = 'outputs/office-live-test/real/sample-summary.xlsx';
await copyFile('outputs/office-live-test/real/sample.xlsx', work);
const { session } = await call({ action: 'open', path: work, mode: 'portable' });
const snap = await call({ action: 'snapshot', session, sheet: 'Sheet1', range: 'A1:P2' });
console.log('tables', JSON.stringify(snap.document.sheets[0].tables), 'freeze', JSON.stringify(snap.document.sheets[0].freezePanes));
const segments = ['Government', 'Midmarket', 'Channel Partners', 'Enterprise', 'Small Business'];
const countries = ['Canada', 'France', 'Germany', 'Mexico', 'United States of America'];
const S = "'Sheet1'";
const HEAD = { bold: true, color: 'FFFFFF', fillColor: '1F3A5F' };
const batch = await call({
  action: 'batch',
  session,
  operations: [
    { op: 'add_sheet', name: 'Summary' },
    { op: 'set_range', sheet: 'Summary', range: 'A1:A2', values: [['Sales and profit by segment'], ['Source: Financial Sample (Microsoft), Sheet1 · all years']] },
    { op: 'set_style', sheet: 'Summary', range: 'A1', properties: { fontSize: 15, bold: true, color: '1F3A5F' } },
    { op: 'set_style', sheet: 'Summary', range: 'A2', properties: { fontSize: 9, color: '6B7280' } },
    { op: 'set_range', sheet: 'Summary', range: 'A4:E4', values: [['Segment', 'Units sold', 'Sales', 'Profit', 'Margin']] },
    { op: 'set_style', sheet: 'Summary', range: 'A4:E4', properties: HEAD },
    { op: 'set_style', sheet: 'Summary', range: 'B4:E4', properties: { horizontalAlignment: 'right' } },
    { op: 'set_range', sheet: 'Summary', range: 'A5:A9', values: segments.map((s) => [s]) },
    ...segments.flatMap((_, i) => {
      const r = i + 5;
      return [
        { op: 'set_formula', sheet: 'Summary', cell: `B${r}`, formula: `=SUMIFS(${S}!$E:$E,${S}!$A:$A,$A${r})` },
        { op: 'set_formula', sheet: 'Summary', cell: `C${r}`, formula: `=SUMIFS(${S}!$J:$J,${S}!$A:$A,$A${r})` },
        { op: 'set_formula', sheet: 'Summary', cell: `D${r}`, formula: `=SUMIFS(${S}!$L:$L,${S}!$A:$A,$A${r})` },
        { op: 'set_formula', sheet: 'Summary', cell: `E${r}`, formula: `=IF(C${r}=0,0,D${r}/C${r})` },
      ];
    }),
    { op: 'set_range', sheet: 'Summary', range: 'A10', values: [['Total']] },
    { op: 'set_formula', sheet: 'Summary', cell: 'B10', formula: '=SUM(B5:B9)' },
    { op: 'set_formula', sheet: 'Summary', cell: 'C10', formula: '=SUM(C5:C9)' },
    { op: 'set_formula', sheet: 'Summary', cell: 'D10', formula: '=SUM(D5:D9)' },
    { op: 'set_formula', sheet: 'Summary', cell: 'E10', formula: '=IF(C10=0,0,D10/C10)' },
    { op: 'set_style', sheet: 'Summary', range: 'A10:E10', properties: { bold: true, borders: { top: { style: 'medium', color: '1F3A5F' } } } },
    { op: 'set_style', sheet: 'Summary', range: 'B5:B10', properties: { numberFormat: '#,##0' } },
    { op: 'set_style', sheet: 'Summary', range: 'C5:D10', properties: { numberFormat: '$#,##0,,"M"' } },
    { op: 'set_style', sheet: 'Summary', range: 'E5:E10', properties: { numberFormat: '0.0%' } },
    { op: 'set_range', sheet: 'Summary', range: 'A13:C13', values: [['Country', 'Sales', 'Profit']] },
    { op: 'set_style', sheet: 'Summary', range: 'A13:C13', properties: HEAD },
    { op: 'set_style', sheet: 'Summary', range: 'B13:C13', properties: { horizontalAlignment: 'right' } },
    { op: 'set_range', sheet: 'Summary', range: 'A14:A18', values: countries.map((c) => [c]) },
    ...countries.flatMap((_, i) => [
      { op: 'set_formula', sheet: 'Summary', cell: `B${i + 14}`, formula: `=SUMIFS(${S}!$J:$J,${S}!$B:$B,$A${i + 14})` },
      { op: 'set_formula', sheet: 'Summary', cell: `C${i + 14}`, formula: `=SUMIFS(${S}!$L:$L,${S}!$B:$B,$A${i + 14})` },
    ]),
    { op: 'set_style', sheet: 'Summary', range: 'B14:C18', properties: { numberFormat: '$#,##0,,"M"' } },
    { op: 'set_column_width', sheet: 'Summary', column: 'A', width: 26 },
    { op: 'set_column_width', sheet: 'Summary', column: 'B', width: 13, count: 4 },
    { op: 'add_chart', sheet: 'Summary', chartType: 'bar', range: 'A13:C18', cell: 'G4', width: 460, height: 300, title: 'Sales and profit by country' },
    { op: 'set_page_setup', sheet: 'Summary', orientation: 'landscape', printArea: 'A1:Q26', fitToPagesWide: 1 },
  ],
});
console.log('batch', batch.error || `ok ${batch.results?.length}`);
const rendered = await call({ action: 'render', session, sheet: 'Summary' });
console.log('render', rendered.error || rendered.pageCount, (rendered.images || []).map((i) => i.path).join(' '));
const values = await call({ action: 'snapshot', session, sheet: 'Summary', range: 'A4:E10' });
console.log(JSON.stringify(values.document?.sheets?.[0]?.cells?.map((c) => [c.address, c.value, c.formula]).slice(0, 30)));
const issues = await call({ action: 'issues', session });
console.log('issues', JSON.stringify((issues.issues || []).map((i) => `${i.code} ${i.path}`)).slice(0, 1500));
console.log('save', JSON.stringify(await call({ action: 'save', session })).slice(0, 300));
await call({ action: 'close', session });

