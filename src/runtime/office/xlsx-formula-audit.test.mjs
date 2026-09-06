import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { auditXlsxFormulas, inlineConstants, mergeXlsxFormulaAudit, relativeFormulaSignature, singleCellReferences, unguardedDivision } from './portable/xlsx-formula-audit.mjs';
import { summarizeXlsxConventions } from './portable/xlsx-conventions.mjs';
import { normalizeXlsxFormula, quoteUnquotedSheetReferences } from './portable/xlsx-contract.mjs';
import { workbookFormulaErrors } from './portable/portable-soffice.mjs';
import { normalizeExcelCellStyle } from './portable/portable-sheet-styles.mjs';
import { reviewOfficeStructure } from './quality/assurance-structure.mjs';

// Unit coverage of the XLSX formula audit and its helpers; the end-to-end
// portable reader is covered by xlsx-portable-snapshot.test.mjs.

const sheet = (name, cells) => ({
  name,
  path: `/sheet[${name}]`,
  cells: cells.map(([ref, entry]) => ({ ref, path: `/sheet[${name}]/cell[${ref}]`, ...entry })),
});

const codesAt = (issues, code) => issues.filter((entry) => entry.code === code).map((entry) => entry.path);

test('relative formula signatures match a pattern copied along a row and ignore string literals', () => {
  assert.equal(relativeFormulaSignature('=B2*(1+$B$10)', 'C2'), relativeFormulaSignature('=C2*(1+$B$10)', 'D2'));
  assert.notEqual(relativeFormulaSignature('=B2*(1+$B$10)', 'C2'), relativeFormulaSignature('=B2*1.1', 'C2'));
  assert.equal(relativeFormulaSignature('=IF(A1="B2",LOG10(A1),0)', 'C1'), 'IF(R[0]C[-2]="",LOG10(R[0]C[-2]),0)');
});

test('inline constants and unguarded division follow the modelling rules', () => {
  assert.deepEqual(inlineConstants('=B5*1.05'), ['1.05']);
  assert.deepEqual(inlineConstants('=B5*(1+0.05)'), ['0.05']);
  assert.deepEqual(inlineConstants('=ROUND(B5/12,2)*100'), []);
  assert.deepEqual(inlineConstants('=B5*(1+$B$6)'), []);
  assert.equal(unguardedDivision('=B5/C5'), true);
  assert.equal(unguardedDivision('=B5/(C5-D5)'), true);
  assert.equal(unguardedDivision('=B5/100'), false);
  assert.equal(unguardedDivision('=IFERROR(B5/C5,0)'), false);
  assert.equal(unguardedDivision('=IF(C5=0,0,B5/C5)'), false);
});

test('financial-model audit reports modelling discipline; every profile reports workbook hygiene', () => {
  const model = sheet('Model', [
    ['A1', { value: 'Growth', style: { bold: true } }],
    ['B1', { value: 0.05 }],
    ['B2', { value: 100 }],
    ['C2', { formula: 'B2*(1+$B$1)', value: 105 }],
    ['D2', { formula: 'C2*(1+$B$1)', value: 110.25 }],
    ['E2', { formula: 'D2*1.1', value: 121.3 }],
    ['F2', { formula: 'E2*(1+$B$1)', value: 127.3 }],
    ['G2', { formula: 'F2*(1+$B$1)', value: 133.7 }],
    ['B3', { value: 10 }],
    ['C3', { formula: 'B3+1', value: 11 }],
    ['D3', { value: 12 }],
    ['E3', { formula: 'D3+1', value: 13 }],
    ['F3', { value: 14 }],
    ['B4', { formula: 'B2/B3', value: 10 }],
    ['B5', { value: 15, style: { numberFormat: '0.0%' } }],
    ['B6', { value: 2024, style: { numberFormat: '#,##0' } }],
    ['B7', { formula: "Input Sheet!B2+'Input Sheet'!B3", value: 3 }],
    ['B8', { formula: "'[1]Returns Analysis'!$B$2", value: 9 }],
    ['B9', { value: 7 }],
    ['B10', { value: 8 }],
  ]);
  const financial = auditXlsxFormulas([model], { auditProfile: 'financial-model', sheetNames: ['Model', 'Input Sheet'] });
  assert.deepEqual(codesAt(financial, 'inline_constant_in_formula'), ['/sheet[Model]/cell[E2]']);
  assert.deepEqual(codesAt(financial, 'formula_pattern_inconsistency'), ['/sheet[Model]/cell[E2]']);
  assert.deepEqual(codesAt(financial, 'formula_inconsistency'), ['/sheet[Model]/cell[D3]']);
  assert.deepEqual(codesAt(financial, 'rogue_hardcode'), ['/sheet[Model]/cell[F3]']);
  assert.deepEqual(codesAt(financial, 'unguarded_division'), ['/sheet[Model]/cell[B4]']);
  assert.deepEqual(codesAt(financial, 'percentage_stored_as_whole'), ['/sheet[Model]/cell[B5]']);
  assert.deepEqual(codesAt(financial, 'year_with_thousands_separator'), ['/sheet[Model]/cell[B6]']);
  assert.deepEqual(codesAt(financial, 'unquoted_sheet_reference'), ['/sheet[Model]/cell[B7]']);
  assert.deepEqual(codesAt(financial, 'external_link_reference'), ['/sheet[Model]/cell[B8]']);
  assert.deepEqual(codesAt(financial, 'input_cells_unmarked'), ['/sheet[Model]']);
  assert.equal(financial.find((entry) => entry.code === 'input_cells_unmarked').severity, 'info');

  const plain = auditXlsxFormulas([model], { sheetNames: ['Model', 'Input Sheet'] });
  const plainCodes = new Set(plain.map((entry) => entry.code));
  assert.deepEqual([...plainCodes].sort(), [
    'external_link_reference',
    'percentage_stored_as_whole',
    'unquoted_sheet_reference',
    'year_with_thousands_separator',
  ]);

  // Numbers stored as text never sum; a year written as text is deliberate.
  const textual = sheet('Text', [
    ['A2', { value: '1,234', dataType: 'text' }],
    ['B2', { value: '15%', dataType: 'text' }],
    ['C2', { value: '2024', dataType: 'text' }],
    ['D2', { value: 'Q1 2024', dataType: 'text' }],
    ['E2', { value: '42' }],
  ]);
  assert.deepEqual(codesAt(auditXlsxFormulas([textual]), 'number_stored_as_text'), ['/sheet[Text]/cell[A2]', '/sheet[Text]/cell[B2]']);

  // A marked input (blue font in the COM color encoding) satisfies the legend rule.
  const marked = { ...model, cells: model.cells.map((cell) => (cell.ref === 'B2' ? { ...cell, style: { color: 16711680 } } : cell)) };
  assert.equal(auditXlsxFormulas([marked], { auditProfile: 'financial-model' }).some((entry) => entry.code === 'input_cells_unmarked'), false);
});

test('Excel cell styles normalize to the portable shape', () => {
  assert.deepEqual(
    normalizeExcelCellStyle({ fontName: 'Arial', fontSize: 11, bold: true, italic: false, color: 16711680, fillColor: 65535, numberFormat: '0.0%' }),
    { fontName: 'Arial', fontSize: 11, bold: true, numberFormat: '0.0%', color: '0000FF', fillColor: 'FFFF00' },
  );
  assert.deepEqual(
    normalizeExcelCellStyle({ fontName: 'Calibri', fontSize: 11, bold: false, italic: false, color: 0, fillColor: 16777215, numberFormat: 'General' }),
    { fontName: 'Calibri', fontSize: 11 },
  );
  // Korean Excel reports the General format as G/표준.
  assert.deepEqual(
    normalizeExcelCellStyle({ fontName: '맑은 고딕', fontSize: 11, color: 0, fillColor: 16777215, numberFormat: 'G/표준' }),
    { fontName: '맑은 고딕', fontSize: 11 },
  );
});

test('layout hygiene reports an unfrozen header on a long sheet and unformatted numeric table columns as information', () => {
  const rows = [];
  for (let row = 2; row <= 30; row += 1) {
    rows.push([`A${row}`, { value: `item ${row}`, dataType: 'text' }], [`B${row}`, { value: row * 10 }], [`C${row}`, { value: 2000 + (row % 5) }]);
  }
  const long = {
    ...sheet('Long', [['A1', { value: 'Item', dataType: 'text' }], ['B1', { value: 'Amount', dataType: 'text' }], ['C1', { value: 'Year', dataType: 'text' }], ...rows]),
    freezePanes: { frozen: false, splitRow: 0, splitColumn: 0 },
    tables: [{ path: '/sheet[Long]/table[1]', index: 1, name: 'Items', range: 'A1:C30' }],
  };
  const findings = auditXlsxFormulas([long]);
  assert.deepEqual(codesAt(findings, 'header_not_frozen'), ['/sheet[Long]']);
  assert.deepEqual(codesAt(findings, 'numeric_column_unformatted'), ['/sheet[Long]/table[1]']);
  assert.match(findings.find((entry) => entry.code === 'numeric_column_unformatted').message, /^Column B of Items/);
  assert.ok(findings.every((entry) => entry.severity === 'info'));

  const formatted = {
    ...long,
    freezePanes: { frozen: true, splitRow: 1, splitColumn: 0 },
    cells: long.cells.map((cell) => (/^B(?:[2-9]|[1-3]\d)$/.test(cell.ref) ? { ...cell, style: { numberFormat: '#,##0' } } : cell)),
  };
  assert.deepEqual(auditXlsxFormulas([formatted]), []);
  // Excel reports freezePanes only for the active sheet; an unknown state is not a finding.
  assert.deepEqual(auditXlsxFormulas([{ ...formatted, freezePanes: null }]), []);
});

test('financial-model audit flags a single reference past the populated extent, never a range or another sheet', () => {
  assert.deepEqual(singleCellReferences('=SUM(B2:B9)/B10+\'Other Sheet\'!Z99+Other!C40+$D$3').map((entry) => entry.ref), ['B10', 'D3']);
  const model = sheet('Model', [
    ['A1', { value: 'Revenue', dataType: 'text' }],
    ['B1', { value: 100 }],
    ['B2', { value: 110 }],
    ['B3', { value: 120 }],
    ['C3', { formula: 'SUM(B1:B100)', value: 330 }],
    // The populated extent ends at row 5, column C: B6 is one row past it, D2 one column.
    ['C4', { formula: 'B6*2', value: 0 }],
    ['C5', { formula: 'Other!Z99+D2', value: 0 }],
  ]);
  const findings = auditXlsxFormulas([model], { auditProfile: 'financial-model' });
  assert.deepEqual(codesAt(findings, 'formula_reads_beyond_data'), ['/sheet[Model]/cell[C4]', '/sheet[Model]/cell[C5]']);
  assert.match(findings.find((entry) => entry.path.endsWith('[C4]')).message, /reads B6,/);
  assert.match(findings.find((entry) => entry.path.endsWith('[C5]')).message, /reads D2,/);
  assert.equal(auditXlsxFormulas([model]).some((entry) => entry.code === 'formula_reads_beyond_data'), false);
});

test('financial-model audit reads notes, the Checks sheet, and merges into a host result without repeats', () => {
  const model = sheet('Model', [
    ['B1', { value: 0.05, note: 'user brief 2026-09-06' }],
    ['B2', { value: 100 }],
    ['C2', { formula: 'B2*(1+$B$1)', value: 105 }],
    ['E9', { value: 42 }],
  ]);
  const checks = { ...sheet('Checks', [
    ['A1', { value: 'Revenue ties' }],
    ['B1', { formula: 'ROUND(Model!C2-105,2)=0', value: true }],
    ['B2', { formula: 'Model!B2=99', cachedValue: false, value: false }],
    ['B3', { value: 3 }],
  ]), notes: [{ cell: 'B3', text: 'count of checks' }] };
  const findings = auditXlsxFormulas([model, checks], { auditProfile: 'financial-model' });
  assert.deepEqual(codesAt(findings, 'hardcode_missing_source'), ['/sheet[Model]/cell[B2]']);
  assert.deepEqual(codesAt(findings, 'failed_check'), ['/sheet[Checks]/cell[B2]']);

  // Records inside an Excel table are data the table sources, not assumptions.
  const data = { ...sheet('Data', [
    ['A1', { value: 'Item' }],
    ['B1', { value: 'Qty' }],
    ['B2', { value: 4 }],
    ['B3', { value: 6 }],
    ['B4', { formula: 'SUM(B2:B3)', value: 10 }],
    ['B9', { value: 9 }],
  ]), tables: [{ path: '/sheet[Data]/table[1]', index: 1, name: 'Items', range: 'A1:B3', style: '' }] };
  const dataFindings = auditXlsxFormulas([data], { auditProfile: 'financial-model' });
  assert.deepEqual(codesAt(dataFindings, 'hardcode_missing_source'), ['/sheet[Data]/cell[B9]']);

  const merged = mergeXlsxFormulaAudit(
    { ok: true, issues: [{ severity: 'warning', code: 'failed_check', path: '/sheet[Checks]/cell[B2]', message: 'host' }] },
    { sheets: [model, checks] },
    { auditProfile: 'financial-model' },
  );
  assert.equal(merged.issues.filter((entry) => entry.code === 'failed_check').length, 1);
  assert.equal(merged.issues[0].message, 'host');
  assert.equal(merged.sharedAudit.added, merged.issues.length - 1);
  const scoped = mergeXlsxFormulaAudit({ issues: [] }, { sheets: [model, checks] }, { auditProfile: 'financial-model', sheet: 'Checks' });
  assert.ok(scoped.issues.every((entry) => entry.path.startsWith('/sheet[Checks]')));
});

test('workbook conventions summarize faces, formats by column, and input markers', () => {
  const document = {
    sheets: [sheet('Inputs', [
      ['A1', { value: 'Growth', style: { fontName: 'Arial', fontSize: 11, bold: true } }],
      ['B1', { value: 0.05, style: { fontName: 'Arial', fontSize: 11, numberFormat: '0.0%', color: '0000FF' } }],
      ['B2', { value: 1200, style: { fontName: 'Arial', fontSize: 11, numberFormat: '#,##0', color: '0000FF', fillColor: 'FFFF00' } }],
      ['C2', { formula: 'B2*(1+B1)', value: 1260, style: { fontName: 'Arial', fontSize: 11, numberFormat: '#,##0' } }],
      ['D2', { value: 7 }],
    ])],
  };
  const conventions = summarizeXlsxConventions({ ...document, defaultStyle: { fontName: 'Calibri', fontSize: 11 } });
  assert.equal(conventions.defaultFont, 'Calibri');
  assert.deepEqual(conventions.fonts, [{ name: 'Arial', cells: 4 }]);
  assert.deepEqual(conventions.numberFormats, [
    { format: '#,##0', cells: 2, columns: ['B', 'C'] },
    { format: '0.0%', cells: 1, columns: ['B'] },
  ]);
  assert.deepEqual(conventions.inputMarkers.fontColors, [{ color: '0000FF', cells: 2 }]);
  assert.deepEqual(conventions.inputMarkers.fills, [{ color: 'FFFF00', cells: 1 }]);
  assert.deepEqual(conventions.cells, { styled: 4, formulas: 1, hardcodes: 3, markedInputs: 2 });
  assert.deepEqual(conventions.sampleInputs, ['Inputs!B1', 'Inputs!B2']);
  assert.equal(summarizeXlsxConventions({ sheets: [sheet('Raw', [['A1', { value: 1 }]])] }), null);
});

test('the structure review carries the formula audit with its profile', () => {
  const document = {
    sheets: [sheet('Plan', [
      ['B2', { value: 100 }],
      ['C2', { formula: 'B2*1.07', value: 107 }],
    ])],
  };
  const reviewed = reviewOfficeStructure({ format: 'xlsx', document, auditProfile: 'financial-model' });
  const finding = reviewed.find((entry) => entry.code === 'inline_constant_in_formula');
  assert.equal(finding?.source, 'format-review');
  assert.equal(finding?.severity, 'warning');
  assert.equal(reviewOfficeStructure({ format: 'xlsx', document }).some((entry) => entry.code === 'inline_constant_in_formula'), false);
});

test('portable formulas quote multi-word sheet names and prefix post-2007 functions', () => {
  const sheetNames = ['Summary', 'Input Sheet', "O'Brien"];
  assert.equal(
    normalizeXlsxFormula("=Input Sheet!B2+'Input Sheet'!B3&\"Input Sheet!\"", { sheetNames }),
    "'Input Sheet'!B2+'Input Sheet'!B3&\"Input Sheet!\"",
  );
  assert.equal(normalizeXlsxFormula("=O'Brien!A1", { sheetNames }), "'O''Brien'!A1");
  assert.equal(normalizeXlsxFormula('=Summary!A1+IFS(A1>0,1,TRUE,0)', { sheetNames }), 'Summary!A1+_xlfn.IFS(A1>0,1,TRUE,0)');
  // Without a sheet list (an Excel session) a multi-word token before `!` and a reference is still a sheet name.
  assert.equal(quoteUnquotedSheetReferences('=SUM(Data 2024!A1:A5)+My Sheet!$B$2+Plan!C1'), "=SUM('Data 2024'!A1:A5)+'My Sheet'!$B$2+Plan!C1");
  assert.equal(quoteUnquotedSheetReferences('=SUM(A1:C3 Sheet2!B2:D4)&"My Sheet!A1"'), '=SUM(A1:C3 Sheet2!B2:D4)&"My Sheet!A1"');
  assert.equal(quoteUnquotedSheetReferences("=IF(A1=\"x\", Sheet2!B1, 'Input Sheet'!B1)"), "=IF(A1=\"x\", Sheet2!B1, 'Input Sheet'!B1)");
});

test('recalculation error summary tallies error cells by type with locations', async () => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Model" sheetId="1" r:id="rId1"/><sheet name="Checks" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships>'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
    + '</Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>'
    + '<row r="1"><c r="A1"><f>1/0</f><v>1</v></c><c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="C1" t="e"><f>xlookup(1,A:A,B:B)</f><v>#NAME?</v></c>'
    + '<c r="D1"><f>SUM(A1:B1)&amp;"lower(x)"</f><v>1</v></c></row>'
    + '</sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="e"><f>B1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>');
  const summary = await workbookFormulaErrors(zip);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byType['#DIV/0!'], { count: 2, cells: ['Model!B1', 'Checks!A1'], truncated: 0 });
  assert.deepEqual(summary.byType['#NAME?'].cells, ['Model!C1']);
  assert.deepEqual(summary.unparsed, ['Model!C1']);
});

