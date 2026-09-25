import assert from 'node:assert/strict';
import test from 'node:test';
import { tableRowCells } from './pptx-table-fit.mjs';

// One 24 pt line (28.8 pt) in a 30 pt row: inside PowerPoint's default cell insets (3.6 pt top and bottom) only
// 22.8 pt is left; with the margins the cell states (zero) it fits the row's 30.
const row = (margins) =>
  '<a:tr h="381000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"/><a:t>한 줄</a:t></a:r></a:p></a:txBody>' +
  `<a:tcPr${margins}/></a:tc></a:tr>`;

test('a table cell is measured inside the margins it states, PowerPoint defaults where it states none', () => {
  const widths = [1828800];
  const [defaults] = tableRowCells(row(''), widths).cells;
  assert.ok(defaults.fit.measured.height > defaults.fit.available, JSON.stringify(defaults.fit));
  const [tight] = tableRowCells(row(' marL="0" marR="0" marT="0" marB="0"'), widths).cells;
  assert.ok(tight.fit.measured.height <= tight.fit.available, JSON.stringify(tight.fit));
});
