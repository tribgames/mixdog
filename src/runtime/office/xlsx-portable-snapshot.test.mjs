import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { officeSnapshotContractViolations } from './core/snapshot-contract.mjs';
import { value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// The portable workbook reader end to end: styles, notes, booleans, the
// conventions summary, sheet-name quoting, and the issues audit that reads them.

test('portable snapshots expose cell styles and the issues audit reads them', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'styled.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'xlsx',
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Margin' },
      { op: 'set_cell', cell: 'B1', value: 15 },
      { op: 'set_style', cell: 'B1', properties: { numberFormat: '0.0%', color: '0000FF', fillColor: 'FFFF00', bold: true } },
      { op: 'set_cell', cell: 'A2', value: 'Year' },
      { op: 'set_cell', cell: 'B2', value: 2024 },
      { op: 'set_style', cell: 'B2', properties: { numberFormat: '#,##0' } },
      { op: 'set_formula', cell: 'B3', formula: '=B1*B2' },
      { op: 'set_cell', cell: 'E2', value: '1,234' },
      { op: 'freeze_panes', row: 2, column: 1 },
      { op: 'merge_cells', range: 'A5:B5' },
    ],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(snapshot.document.sheets[0].freezePanes, { frozen: true, splitRow: 1, splitColumn: 0 });
  assert.deepEqual(snapshot.document.sheets[0].mergedRanges, ['A5:B5']);
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('A1').dataType, 'text');
  assert.equal(cells.get('B1').dataType, undefined);
  assert.equal(cells.get('E2').dataType, 'text');
  assert.equal(cells.get('B1').style.numberFormat, '0.0%');
  assert.equal(cells.get('B1').style.color, '0000FF');
  assert.equal(cells.get('B1').style.fillColor, 'FFFF00');
  assert.equal(cells.get('B1').style.bold, true);
  assert.equal(cells.get('B2').style.numberFormat, '#,##0');
  assert.equal(cells.get('A1').style, undefined);

  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(issues.issues.some((entry) => entry.code === 'percentage_stored_as_whole' && /cell\[B1\]$/.test(entry.path)));
  assert.ok(issues.issues.some((entry) => entry.code === 'year_with_thousands_separator' && /cell\[B2\]$/.test(entry.path)));
  assert.ok(issues.issues.some((entry) => entry.code === 'number_stored_as_text' && /cell\[E2\]$/.test(entry.path)));

  const quoted = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'add_sheet', name: 'Input Sheet' },
      { op: 'set_cell', sheet: 'Input Sheet', cell: 'A1', value: 3 },
      { op: 'set_formula', cell: 'C1', formula: '=Input Sheet!A1*2' },
    ],
  }, { cwd }));
  const formulaResult = quoted.results.find((entry) => entry.op === 'set_formula');
  assert.equal(formulaResult.normalizedFormula, "='Input Sheet'!A1*2");
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(audited.issues.some((entry) => entry.code === 'unquoted_sheet_reference'), false);
});

test('a model built to the conventions audits clean under financial-model', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'model.xlsx');
  const input = (cell, value, numberFormat, note) => [
    { op: 'set_cell', sheet: 'Inputs', cell, value },
    { op: 'set_style', sheet: 'Inputs', cell, properties: { numberFormat, color: '0000FF' } },
    { op: 'add_note', sheet: 'Inputs', cell, text: note },
  ];
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'xlsx',
    mode: 'portable',
    operations: [
      { op: 'rename_sheet', sheet: 'Sheet1', name: 'Inputs' },
      { op: 'set_range', sheet: 'Inputs', range: 'A1:B1', values: [['Assumption', 'Value']] },
      { op: 'set_cell', sheet: 'Inputs', cell: 'A2', value: 'Growth' },
      ...input('B2', 0.05, '0.0%', 'user brief 2026-09-06: 5% growth'),
      { op: 'set_cell', sheet: 'Inputs', cell: 'A3', value: 'Base revenue ($mm)' },
      ...input('B3', 1000, '#,##0', 'FY2025 actuals, finance sheet B4'),
      { op: 'set_cell', sheet: 'Inputs', cell: 'A4', value: 'Margin' },
      ...input('B4', 0.2, '0.0%', 'user brief 2026-09-06: 20% margin'),
      { op: 'define_name', name: 'GrowthRate', refersTo: 'Inputs!$B$2' },
      { op: 'add_sheet', name: 'Model' },
      { op: 'set_range', sheet: 'Model', range: 'A1:E1', values: [['Year', 2024, 2025, 2026, 2027]] },
      { op: 'set_cell', sheet: 'Model', cell: 'A2', value: 'Revenue ($mm)' },
      { op: 'set_formula', sheet: 'Model', cell: 'B2', formula: '=Inputs!B3' },
      { op: 'set_formula', sheet: 'Model', cell: 'C2', formula: '=B2*(1+Inputs!$B$2)' },
      { op: 'set_formula', sheet: 'Model', cell: 'D2', formula: '=C2*(1+Inputs!$B$2)' },
      { op: 'set_formula', sheet: 'Model', cell: 'E2', formula: '=D2*(1+Inputs!$B$2)' },
      { op: 'set_cell', sheet: 'Model', cell: 'A3', value: 'Profit ($mm)' },
      { op: 'set_formula', sheet: 'Model', cell: 'B3', formula: '=B2*Inputs!$B$4' },
      { op: 'set_formula', sheet: 'Model', cell: 'C3', formula: '=C2*Inputs!$B$4' },
      { op: 'set_formula', sheet: 'Model', cell: 'D3', formula: '=D2*Inputs!$B$4' },
      { op: 'set_formula', sheet: 'Model', cell: 'E3', formula: '=E2*Inputs!$B$4' },
      { op: 'set_cell', sheet: 'Model', cell: 'A4', value: 'Margin check' },
      { op: 'set_formula', sheet: 'Model', cell: 'B4', formula: '=IFERROR(B3/B2,0)' },
      { op: 'set_style', sheet: 'Model', range: 'B2:E3', properties: { numberFormat: '#,##0' } },
      { op: 'add_sheet', name: 'Checks' },
      { op: 'set_range', sheet: 'Checks', range: 'A1:B1', values: [['Check', 'Result']] },
      { op: 'set_cell', sheet: 'Checks', cell: 'A2', value: 'Revenue ties to the input' },
      { op: 'set_formula', sheet: 'Checks', cell: 'B2', formula: '=ROUND(Model!B2-Inputs!B3,2)=0' },
      { op: 'set_cell', sheet: 'Checks', cell: 'A3', value: 'All checks' },
      { op: 'set_formula', sheet: 'Checks', cell: 'B3', formula: '=AND(B2)' },
    ],
  }, { cwd }));
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session, auditProfile: 'financial-model' }, { cwd }));
  // Before a recalculation every formula lacks a cached value; nothing else may fire.
  const codes = [...new Set(audited.issues.map((entry) => entry.code))];
  assert.deepEqual(codes, ['formula_cache_missing'], JSON.stringify(audited.issues.filter((entry) => entry.code !== 'formula_cache_missing')));
  // A paged snapshot reads one sheet at a time: the first by default, a named one on request.
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.sheets[0].name, 'Inputs');
  assert.deepEqual(snapshot.document.conventions.sampleInputs, ['Inputs!B2', 'Inputs!B3', 'Inputs!B4']);
  const checks = value(await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Checks' }, { cwd }));
  assert.equal(checks.document.sheets[0].name, 'Checks');
  assert.ok(checks.document.sheets[0].cells.some((cell) => cell.ref === 'B3' && /^AND\(/.test(cell.formula)));
});

test('portable snapshots carry notes, booleans, and conventions; the financial audit reads the notes', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'noted.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'xlsx',
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Growth' },
      { op: 'set_cell', cell: 'B1', value: 0.05 },
      { op: 'set_style', cell: 'B1', properties: { numberFormat: '0.0%', color: '0000FF' } },
      { op: 'add_note', cell: 'B1', text: 'user brief 2026-09-06: 5% growth' },
      { op: 'set_cell', cell: 'B2', value: 100 },
      { op: 'set_formula', cell: 'C2', formula: '=B2*(1+$B$1)' },
      { op: 'set_cell', cell: 'D1', value: true },
      { op: 'set_range', range: 'A4:B6', values: [['Item', 'Qty'], ['bolt', 4], ['nut', 6]] },
      { op: 'add_table', range: 'A4:B6', name: 'Items' },
      { op: 'set_formula', cell: 'B7', formula: '=SUM(B5:B6)' },
    ],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const first = snapshot.document.sheets[0];
  const cells = new Map(first.cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('B1').note, 'user brief 2026-09-06: 5% growth');
  assert.equal(first.noteCount, 1);
  assert.equal(first.notes[0].cell, 'B1');
  assert.equal(cells.get('D1').value, true);
  assert.equal(first.tableCount, 1);
  assert.deepEqual(first.tables[0], { path: `/sheet[${first.name}]/table[1]`, index: 1, name: 'Items', range: 'A4:B6', style: 'TableStyleMedium2' });
  assert.deepEqual(officeSnapshotContractViolations(snapshot.document, { format: 'xlsx', paged: true }), []);
  assert.deepEqual(snapshot.document.conventions.inputMarkers.fontColors, [{ color: '0000FF', cells: 1 }]);
  assert.deepEqual(snapshot.document.conventions.sampleInputs, [`${first.name}!B1`]);
  assert.ok(snapshot.document.defaultStyle?.fontName, 'the workbook default face is reported');
  assert.equal(snapshot.document.conventions.defaultFont, snapshot.document.defaultStyle.fontName);

  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session, auditProfile: 'financial-model' }, { cwd }));
  assert.deepEqual(
    audited.issues.filter((entry) => entry.code === 'hardcode_missing_source').map((entry) => entry.path),
    [`/sheet[${first.name}]/cell[B2]`],
  );
});
