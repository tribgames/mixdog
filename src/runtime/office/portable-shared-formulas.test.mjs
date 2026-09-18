// A filled-down column is stored once. Read as the file writes it, every cell
// under the first looks like a pasted number — and the snapshot, the model
// audit and the recalculation each judge it as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellRecords } from './portable/portable-cells.mjs';
import { expandSharedFormulas } from './portable/portable-shared-formulas.mjs';

const SHEET =
  '<worksheet><sheetData>' +
  '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*$C$1</f><v>10</v></c><c r="C1"><v>10</v></c></row>' +
  '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>20</v></c></row>' +
  '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>30</v></c></row>' +
  '</sheetData></worksheet>';

test('every cell a shared formula covers reads as the formula it holds', () => {
  const records = cellRecords(SHEET, []);
  assert.deepEqual(expandSharedFormulas(SHEET, records), []);
  const formulas = Object.fromEntries(records.filter((record) => record.formula).map((r) => [r.ref, r.formula]));
  // The row moves with the cell; the column pinned with $ stays where it is.
  assert.deepEqual(formulas, { B1: 'A1*$C$1', B2: 'A2*$C$1', B3: 'A3*$C$1' });
});

// An array formula is written once for the block it fills, and Excel shows it
// in every cell of that block. Read as the file writes it, the cells after the
// first look like pasted results.
test('every cell inside an array block reads as the array formula', () => {
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B3">TREND(A1:A3)</f><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>2</v></c></row>' +
    '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>3</v></c></row>' +
    '</sheetData></worksheet>';
  const records = cellRecords(sheet, []);
  expandSharedFormulas(sheet, records);
  const formulas = Object.fromEntries(records.filter((record) => record.formula).map((r) => [r.ref, r.formula]));
  assert.deepEqual(formulas, { B1: 'TREND(A1:A3)', B2: 'TREND(A1:A3)', B3: 'TREND(A1:A3)' });
});

test('a cell outside any shared formula is left exactly as it was', () => {
  const records = cellRecords(SHEET, []);
  expandSharedFormulas(SHEET, records);
  const plain = records.find((record) => record.ref === 'A2');
  assert.equal(plain.formula, undefined);
  assert.equal(plain.value, 2);
});
