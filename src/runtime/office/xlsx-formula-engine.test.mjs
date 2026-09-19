// The in-process formula engine: what it computes, and what it refuses. A
// refusal is the point — the workbook keeps whatever it held rather than
// gaining a number nobody can stand behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { UnsupportedFormula, evaluateFormula } from './portable/xlsx-formula-engine.mjs';
import { recalculateWithFormulaEngine } from './portable/xlsx-recalculate.mjs';
import { workspace, writeZip } from './office-test-support.mjs';

const CELLS = { A1: 2, A2: 3, B1: 'north', C1: true };
const CONTEXT = {
  sheet: 'Sheet1',
  value: (sheet, ref) => (sheet.toLowerCase() === 'sheet1' ? (CELLS[ref] ?? '') : ''),
};
const evaluate = (formula) => evaluateFormula(formula, CONTEXT);

test('the engine follows Excel precedence, coercion, and error propagation', () => {
  assert.equal(evaluate('=2+3*4'), 14);
  assert.equal(evaluate('=(1+2)*3'), 9);
  // Excel binds unary minus tighter than the power operator, so this is 4.
  assert.equal(evaluate('=-2^2'), 4);
  assert.equal(evaluate('=10%'), 0.1);
  assert.equal(evaluate('="a"&"b"'), 'ab');
  assert.equal(evaluate('=1&2'), '12');
  assert.equal(evaluate('=A1+A2'), 5);
  assert.equal(evaluate('=A1>1'), true);
  assert.equal(evaluate('=B1="NORTH"'), true);
  assert.equal(evaluate('=A1/0'), '#DIV/0!');
  assert.equal(evaluate('=A1/0+1'), '#DIV/0!');
  assert.equal(evaluate('=ZZ9+1'), 1);
});

test('the engine reads ranges, calls Excel functions, and keeps IF from inheriting an error', () => {
  assert.equal(evaluate('=SUM(A1:A2)'), 5);
  assert.equal(evaluate('=ROUND(AVERAGE(A1:A2),1)'), 2.5);
  assert.equal(evaluate('=IF(A1>1,"big","small")'), 'big');
  // The false branch divides by zero; Excel never evaluates it, and the answer
  // must not inherit an error from a branch the test did not take.
  assert.equal(evaluate('=IF(A1=0,0,10/A1)'), 5);
  assert.equal(evaluate('=IFERROR(1/0,"safe")'), 'safe');
  // ERROR.TYPE reports on the error it is given instead of inheriting it.
  assert.equal(evaluate('=ERROR.TYPE(1/0)'), 2);
  assert.equal(evaluate('=CONCATENATE(B1,"-",A1)'), 'north-2');
  // Excel writes a post-2007 function with an _xlfn. prefix and keeps its
  // family dotted, so a workbook Excel saved says _xlfn.RANK.EQ for RANK.EQ.
  assert.equal(evaluate('=_xlfn.TEXTJOIN("-",TRUE,"a","b")'), 'a-b');
  // A date is a serial counting calendar days: 31 January 2024 is day 45322,
  // and reading the library's local-midnight date as a UTC instant made it the
  // day before east of Greenwich.
  assert.equal(evaluate('=DATE(2024,1,31)'), 45322);
  assert.equal(evaluate('=YEAR(DATE(2024,5,6))'), 2024);
  assert.equal(evaluate('=DAY(DATE(2024,5,6))'), 6);
  // The same day read out of text, which the library dates differently again.
  assert.equal(evaluate('=DATEVALUE("2024-01-31")'), 45322);
  // The statistics names a workbook of that age still holds are the same
  // calculation as the family member the library ships.
  assert.equal(evaluate('=ROUND(STDEV(A1:A2),4)'), 0.7071);
  assert.equal(evaluate('=RANK(A1,A1:A2)'), 2);
  assert.equal(evaluate('=_xlfn.RANK.EQ(A1,A1:A2)'), 2);
});

test('the engine refuses what it cannot stand behind instead of guessing', () => {
  assert.throws(() => evaluate('=NOTAFUNCTION(1)'), UnsupportedFormula);
  assert.throws(() => evaluate('=TaxRate*2'), UnsupportedFormula);
  assert.throws(() => evaluate('=[Book1]Sheet1!A1'), UnsupportedFormula);
  assert.throws(() => evaluate('=SUM(A1:A2'), UnsupportedFormula);
  assert.throws(() => evaluate('=A1:A2+1'), UnsupportedFormula);
  // Nothing here can say how far column A reaches, and a million empty rows is
  // not an answer; only a workbook that knows its used range gets one.
  assert.throws(() => evaluate('=SUM(A:A)'), UnsupportedFormula);
  // Excel matches a wildcard criterion against the range; the library counts
  // nothing and calls it an answer, and ROW describes a cell this engine only
  // ever sees the value of.
  assert.throws(() => evaluate('=COUNTIF(A1:A2,"n*")'), UnsupportedFormula);
  assert.throws(() => evaluate('=SUMIF(B1:B1,"nor?h",A1:A1)'), UnsupportedFormula);
  assert.throws(() => evaluate('=ROW(A1)'), UnsupportedFormula);
  // A criterion without a wildcard still answers.
  assert.equal(evaluate('=COUNTIF(A1:A2,">2")'), 1);
  // An empty cell and empty text look the same to this engine, and a date
  // format has no faithful rendering here — both refuse instead of answering.
  assert.throws(() => evaluate('=ISBLANK(A9)'), UnsupportedFormula);
  assert.throws(() => evaluate('=TEXT(A1,"yyyy-mm-dd")'), UnsupportedFormula);
  // A number format still answers, so refusing stays narrow.
  assert.equal(evaluate('=TEXT(1234.5,"0.00")'), '1234.50');
});

const CONTENT_TYPES =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

async function workbookWith(cwd, rows) {
  const path = join(cwd, 'model.xlsx');
  await writeZip(path, {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
  });
  return path;
}

test('the engine bounds a whole-column reference by the rows the sheet uses', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(
    cwd,
    '<row r="1"><c r="A1"><v>2</v></c></row>' +
      '<row r="2"><c r="A2"><v>3</v></c></row>' +
      '<row r="3"><c r="B3"><f>SUM(A:A)</f></c></row>'
  );
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.recalculated, true);
  assert.equal(result.status, 'success');
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<c r="B3"><f>SUM\(A:A\)<\/f><v>5<\/v><\/c>/);
});

// A text answer carrying <, & or " has to reach the sheet as XML, or the part
// stops parsing and the workbook is lost rather than merely uncalculated.
test('a text answer with XML characters keeps the sheet readable', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(cwd, '<row r="1"><c r="A1"><f>"a&lt;b"&amp;"&amp;c"</f></c></row>');
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.recalculated, true);
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<v>a&lt;b&amp;c<\/v>/);
});

async function workbookWithSheets(cwd, sheets, definedNames = '') {
  const path = join(cwd, 'model.xlsx');
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_sheet, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join('') +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('') +
      `</sheets>${definedNames}</workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join('') +
      '</Relationships>',
  };
  for (const [index, sheet] of sheets.entries()) {
    files[`xl/worksheets/sheet${index + 1}.xml`] =
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows}</sheetData></worksheet>`;
  }
  await writeZip(path, files);
  return path;
}

test('the engine follows a reference into another sheet, quoted name and all', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWithSheets(cwd, [
    { name: 'Model', rows: '<row r="1"><c r="A1"><f>\'Raw Data\'!B2*2</f></c></row>' },
    { name: 'Raw Data', rows: '<row r="2"><c r="B2"><v>21</v></c></row>' },
  ]);
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.recalculated, true);
  assert.equal(result.status, 'success');
  const zip = await JSZip.loadAsync(await readFile(path));
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<v>42<\/v>/);
});

// A column written from the bottom up waits on the row beneath it all the way
// down. Read top-down that is one stack frame per row and the process dies, so
// the sheet is read from the bottom instead and every row still gets a value.
test('a column that waits on the row below it is calculated in full', async (t) => {
  const cwd = await workspace(t);
  const depth = 600;
  const rows = [];
  for (let row = 1; row < depth; row += 1) {
    rows.push(`<row r="${row}"><c r="A${row}"><f>A${row + 1}+1</f></c></row>`);
  }
  rows.push(`<row r="${depth}"><c r="A${depth}"><v>1</v></c></row>`);
  const path = await workbookWith(cwd, rows.join(''));
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.status, 'success');
  assert.equal(result.evaluated, depth - 1);
  const zip = await JSZip.loadAsync(await readFile(path));
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<c r="A1"><f>A2\+1<\/f><v>600<\/v><\/c>/);
});

// A model names its inputs, and the formulas then read TaxRate instead of a
// cell address. The name is defined once for the workbook and stands for the
// cell it points at.
test('a defined name reads as the cell it stands for', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWithSheets(
    cwd,
    [
      {
        name: 'Model',
        rows: '<row r="1"><c r="A1"><f>TaxRate*21</f></c></row>' + '<row r="2"><c r="A2"><f>Uplift*4</f></c></row>',
      },
      { name: 'Raw Data', rows: '<row r="2"><c r="B2"><v>2</v></c></row>' },
    ],
    '<definedNames><definedName name="TaxRate">\'Raw Data\'!$B$2</definedName>' +
      '<definedName name="Uplift">1.5</definedName></definedNames>'
  );
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.status, 'success');
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<v>42<\/v>/);
  // A name can also hold the constant itself.
  assert.match(xml, /<v>6<\/v>/);
});

// An array formula is written in the first cell of the block it fills and the
// rest of the block carries only the value — which is how the workbook stores
// it, and how it is written back.
test('an array block is filled where it answers once, and refused where it answers per cell', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(
    cwd,
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B3">A1:A3*2</f></c>' +
      '<c r="D1"><f t="array" ref="D1:D3">SUM(A1:A3)</f></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"/><c r="D2"/></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"/><c r="D3"/></row>'
  );
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.evaluated, 3);
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<c r="D2"><v>6<\/v><\/c>/);
  assert.match(xml, /<c r="D3"><v>6<\/v><\/c>/);
  // A block whose answer differs per cell is one this engine cannot stand
  // behind, so those cells keep exactly what the file held.
  assert.match(xml, /<c r="B2"\/>/);
  assert.ok(
    result.unevaluated.some((entry) => entry.startsWith('Data!B1: ')),
    JSON.stringify(result.unevaluated)
  );
});

// Excel writes a filled-down column once and gives the cells under it the
// shared id alone. Read literally those cells hold no formula at all, so the
// column came back empty with nothing reporting it missing.
test('a shared formula is calculated in every cell it covers', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(
    cwd,
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*$C$1</f></c><c r="C1"><v>10</v></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/></c></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/></c></row>'
  );
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.status, 'success');
  assert.equal(result.formulaCount, 3);
  assert.equal(result.evaluated, 3);
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  // The row moves with the cell and the pinned $C$1 does not, so B3 reads A3*C1.
  assert.match(xml, /<c r="B2"><f t="shared" si="0"\/><v>20<\/v><\/c>/);
  assert.match(xml, /<c r="B3"><f t="shared" si="0"\/><v>30<\/v><\/c>/);
});

const sheetXml = async (path) =>
  await (await JSZip.loadAsync(await readFile(path))).file('xl/worksheets/sheet1.xml').async('string');

test('recalculation without LibreOffice caches the values it computed and names the cells it skipped', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(
    cwd,
    '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*3</f></c></row>' +
      '<row r="2"><c r="A2"><v>3</v></c><c r="B2"><f>SUM(A1:A2)</f></c></row>' +
      '<row r="3"><c r="A3"><f>A1/0</f></c><c r="B3"><f>IFERROR(A3,"safe")</f></c></row>' +
      '<row r="4"><c r="A4"><f>MysteryRate*2</f></c></row>'
  );
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.recalculated, true);
  assert.equal(result.backend, 'mixdog-formula');
  assert.equal(result.status, 'errors_found');
  assert.equal(result.formulaCount, 5);
  assert.equal(result.evaluated, 4);
  assert.equal(result.totalErrors, 1);
  assert.deepEqual(result.errorSummary['#DIV/0!'], { count: 1, cells: ['Data!A3'] });
  assert.equal(result.unevaluatedCount, 1);
  assert.match(result.unevaluated[0], /^Data!A4: defined name MysteryRate$/);

  const xml = await sheetXml(path);
  assert.match(xml, /<c r="B1"><f>A1\*3<\/f><v>6<\/v><\/c>/);
  assert.match(xml, /<c r="B2"><f>SUM\(A1:A2\)<\/f><v>5<\/v><\/c>/);
  assert.match(xml, /<c r="A3" t="e"><f>A1\/0<\/f><v>#DIV\/0!<\/v><\/c>/);
  assert.match(xml, /<c r="B3" t="str"><f>IFERROR\(A3,"safe"\)<\/f><v>safe<\/v><\/c>/);
  // The cell it could not read keeps exactly what the file held.
  assert.match(xml, /<c r="A4"><f>MysteryRate\*2<\/f><\/c>/);
});

test('a circular reference is reported, never settled on a number', async (t) => {
  const cwd = await workspace(t);
  const path = await workbookWith(cwd, '<row r="1"><c r="A1"><f>B1+1</f></c><c r="B1"><f>A1+1</f></c></row>');
  const result = await recalculateWithFormulaEngine(path);
  assert.equal(result.recalculated, false);
  assert.match(result.reason, /circular reference/);
  assert.match(await sheetXml(path), /<c r="A1"><f>B1\+1<\/f><\/c>/);
});
