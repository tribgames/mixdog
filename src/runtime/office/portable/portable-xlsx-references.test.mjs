// The bounded reference ("A1:C4") three worksheet operations write into the
// package: the conditional-formatting sqref, the autofilter ref, and the pivot
// cache's worksheetSource. Each is composed from a parsed range, so these pin
// what reaches the XML — the normalized case included — independently of where
// the composition lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { zipText } from './portable-opc.mjs';
import { createPortableChartWorkbook } from './portable-package.mjs';
import { applyXlsx } from './portable-xlsx.mjs';

const SHEET = 'xl/worksheets/sheet1.xml';

async function workbook() {
  return await JSZip.loadAsync(
    await createPortableChartWorkbook([
      ['Region', 'Product', 'Revenue'],
      ['North', 'Widget', 10],
      ['South', 'Widget', 20],
      ['North', 'Gadget', 30],
    ])
  );
}

test('a conditional format writes the range it reports as its sqref', async () => {
  const zip = await workbook();
  const [applied] = await applyXlsx(zip, [
    { op: 'add_conditional_format', range: 'b2:c4', formula: '=B2<100', fillColor: '#FFC7CE' },
  ]);
  assert.equal(applied.range, 'B2:C4');
  assert.match(await zipText(zip, SHEET), /<conditionalFormatting sqref="B2:C4">/);
  const [removed] = await applyXlsx(zip, [{ op: 'delete_conditional_formats', range: 'B2:C4' }]);
  assert.equal(removed.changed, true);
  assert.equal(removed.range, 'B2:C4');
  assert.doesNotMatch(await zipText(zip, SHEET), /<conditionalFormatting/);
});

test('an autofilter writes its bounded reference into the sheet', async () => {
  const zip = await workbook();
  const [applied] = await applyXlsx(zip, [{ op: 'set_autofilter', range: 'a1:c4' }]);
  assert.deepEqual(applied, { op: 'set_autofilter', changed: true, sheet: 'Sheet1', enabled: true });
  assert.match(await zipText(zip, SHEET), /<autoFilter ref="A1:C4"\/>/);
});

test('a pivot table records the source range it read', async () => {
  const zip = await workbook();
  const [applied] = await applyXlsx(zip, [
    { op: 'add_pivot_table', source: 'a1:c4', destination: 'E1', rows: 'Region', values: 'Revenue' },
  ]);
  assert.equal(applied.changed, true);
  assert.equal(applied.rows, 3);
  assert.match(
    await zipText(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'),
    /<worksheetSource ref="A1:C4" sheet="Sheet1"\/>/
  );
});

test('a line chart draws the line without a marker on every point, as Excel draws chartType line', async () => {
  const zip = await workbook();
  await applyXlsx(zip, [{ op: 'add_chart', chartType: 'line', range: 'A1:C4', cell: 'E2' }]);
  const chart = await zipText(zip, Object.keys(zip.files).find((name) => /^xl\/charts\/chart\d+\.xml$/.test(name)));
  assert.match(chart, /<c:lineChart>[\s\S]*<c:ser>[\s\S]*?<c:marker><c:symbol val="none"\/><\/c:marker>/);
});

test('a numeric field across the top lays out one column per value, and the pivot columns fit what they hold', async () => {
  const zip = await JSZip.loadAsync(
    await createPortableChartWorkbook([
      ['Segment', 'Year', 'Profit'],
      ['Channel Partners', 2014, 1026913.86],
      ['Government', 2013, 2886645.28],
      ['Channel Partners', 2013, 289889.28],
      ['Government', 2014, 8501527.89],
    ])
  );
  await applyXlsx(zip, [{ op: 'add_pivot_table', source: 'A1:C5', destination: 'E1', rows: 'Segment', columns: 'Year', values: 'Profit' }]);
  const sheet = await zipText(zip, SHEET);
  // Heading row, then the years as numbers in order, then the grand total.
  assert.match(sheet, /<c r="F2"[^>]*><v>2013<\/v><\/c><c r="G2"[^>]*><v>2014<\/v><\/c>/);
  assert.match(sheet, /<c r="H2"[^>]*t="inlineStr"><is><t>Grand Total<\/t>/);
  assert.match(
    await zipText(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'),
    /<cacheField name="Year" numFmtId="0"><sharedItems[^>]*count="2"><n v="2014"\/><n v="2013"\/><\/sharedItems>/
  );
  const widths = Object.fromEntries([...sheet.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]));
  assert.ok(widths[5] >= 16, `the Segment column fits "Channel Partners" (${widths[5]})`);
  assert.ok(widths[8] >= 10, `the Grand Total column fits its figures (${widths[8]})`);
});
