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
