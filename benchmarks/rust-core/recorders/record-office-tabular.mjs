#!/usr/bin/env node
// Golden of the office engine's CSV/TSV backend (crate mixdog-office, module `tabular`): what Node's
// `runtime/office/core/tabular.mjs` answers, and leaves on disk, for sequences of calls on delimited files. Writes
// native/core/fixtures/office-tabular/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-tabular.mjs --tree <product tree>
//
// A scenario is { name, file, format, initial, steps }. `initial` is the file's bytes as hex (null: the file does not
// exist). A step is { kind: 'create' | 'snapshot' | 'apply' | 'validate' | 'issues', ... }; after each step the
// recording holds `result` (the answer's exact JSON text) or `error` (the message), and `fileHex` (the file's bytes
// then, null when there is none; `fileLength` and `fileSha256` instead when the file is long). Every file lives in a temporary directory, which the recording names `<dir>`: the
// text of a result has `<dir>/` where the directory and a separator were, so a replay on any platform compares equal.
// The corpus is constants: the output is byte-stable.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-tabular.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const tabular = await importFrom(tree, 'src/runtime/office/core/tabular.mjs');

const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const BOM = '﻿';
const raw = (...bytes) => Buffer.from(bytes).toString('hex');

const snapshot = (options) => ({ kind: 'snapshot', options });
const apply = (...operations) => ({ kind: 'apply', operations });
const issues = (options) => ({ kind: 'issues', options });
const validate = { kind: 'validate' };

const scenarios = [];
const scenario = (name, file, format, initial, steps) => scenarios.push({ name, file, format, initial, steps });
const csv = (name, text, steps, file = 'data.csv') => scenario(name, file, 'csv', text === null ? null : hex(text), steps);
const tsv = (name, text, steps, file = 'data.tsv') => scenario(name, file, 'tsv', text === null ? null : hex(text), steps);

// ---- parse: line ends, quotes, the trailing newline, the byte-order mark ----
csv('plain crlf', 'name,qty,note\r\nfoo,1,a\r\nbar,2,b\r\n', [snapshot({}), validate, issues({})]);
csv('plain lf without trailing newline', 'a,b\nc,d', [snapshot({}), apply({ op: 'set_cell', cell: 'B2', value: 'x' })]);
csv('cr line ends', 'a,b\rc,d\r', [snapshot({}), apply({ op: 'append_row', values: ['e', 'f'] })]);
csv('mixed line ends and a blank line', 'a\r\nb\nc\r\rd', [snapshot({}), validate]);
csv('quoted fields', '"a,b","say ""hi""","line\nbreak"\r\n"x",y,"z"\r\n', [snapshot({}), apply({ op: 'set_cell', cell: 'D1', value: 'q"r' })]);
csv('quote inside an unquoted field', 'a"b,c\r\n"d"e,f\r\n', [snapshot({}), apply({ op: 'set_cell', cell: 'A3', value: 'g' })]);
csv('unterminated quote', 'a,"open\r\nb,c', [snapshot({}), validate, issues({})]);
csv('empty quoted file', '""', [snapshot({}), apply({ op: 'set_cell', cell: 'A1', value: 'k' })]);
csv('only a newline', '\n', [snapshot({}), apply({ op: 'set_cell', cell: 'B1', value: 'k' })]);
csv('byte-order mark and Hangul', `${BOM}이름,수량\r\n사과,3\r\n`, [snapshot({}), apply({ op: 'set_cell', cell: 'B2', value: '4' }), apply({ op: 'append_row', values: ['배', 5] })]);
csv('byte-order mark only', BOM, [snapshot({}), apply({ op: 'append_row', values: ['a'] })]);
csv('byte-order mark kept on an unchanged ASCII edit', `${BOM}a,b\r\n`, [apply({ op: 'clear_cell', cell: 'A1' })]);
tsv('tsv with tabs and quotes', 'a\tb c\t"d\te"\r\n1\t"say ""x"""\t3\r\n', [snapshot({}), apply({ op: 'set_cell', cell: 'D2', value: 'with,comma' }, { op: 'set_cell', cell: 'E2', value: 'with\ttab' })]);
tsv('tsv keeps commas plain', 'a,b\tc\r\n', [snapshot({}), apply({ op: 'set_cell', cell: 'B1', value: 'x,y' })]);

// ---- the empty file and a new file ----
csv('empty file ascii', '', [snapshot({}), apply({ op: 'append_row', values: ['a', 1, null, true] }), apply({ op: 'append_row', values: ['b'] })]);
csv('empty file Hangul', '', [apply({ op: 'append_row', values: ['한글'] }), apply({ op: 'set_cell', cell: 'B2', value: 'z' })]);
csv('empty file nothing written', '', [apply({ op: 'clear_cell', cell: 'A1' }), validate, issues({})]);
csv('new file created then filled', null, [{ kind: 'create' }, snapshot({}), apply({ op: 'set_range', range: 'A1:B2', values: [['é', 1], ['b', 2]] })]);
csv('new file without Hangul', null, [{ kind: 'create' }, apply({ op: 'set_formula', cell: 'A1', formula: '=SUM(B1:B3)' })]);
csv('missing file', null, [snapshot({}), apply({ op: 'set_cell', cell: 'A1', value: 'x' }), validate, issues({})]);

// ---- every operation ----
const grid = 'h1,h2,h3\r\n1,2,3\r\n4,5,6\r\n';
csv('set_cell and set_formula', grid, [apply(
  { op: 'set_cell', cell: ' c2 ', value: 'x' },
  { op: 'set_cell', cell: 'E5', value: null },
  { op: 'set_cell', cell: 'A9', value: 1.5 },
  { op: 'set_cell', cell: 'B9', value: [1, [2, 3]] },
  { op: 'set_cell', cell: 'C9', value: { a: 1 } },
  { op: 'set_cell', cell: 'D9', value: false },
  { op: 'set_cell', cell: 'F9', value: 1e21 },
  { op: 'set_cell', cell: 'G9' },
  { op: 'set_formula', cell: 'H9', formula: '=A1+B1' },
  { op: 'set_formula', cell: 'I9' },
), snapshot({})]);
csv('set_range', grid, [
  apply({ op: 'set_range', range: 'B2:D3', values: [['a', 'b'], ['c']] }),
  apply({ op: 'set_range', range: 'F1', values: [['only']] }),
  apply({ op: 'set_range', range: 'A5:B5', values: [['p', 'q', 'extra']] }),
  snapshot({}),
]);
csv('set_range with a string for values', grid, [apply({ op: 'set_range', range: 'A1:B1', values: 'xy' })]);
csv('set_range without values', grid, [apply({ op: 'set_range', range: 'A1:B2' })]);
csv('set_range with a short outer list', grid, [apply({ op: 'set_range', range: 'A1:B3', values: [['a', 'b']] })]);
csv('set_range with null values', grid, [apply({ op: 'set_range', range: 'A1:A2', values: null })]);
csv('set_range without a range', grid, [apply({ op: 'set_range', values: [[1]] })]);
csv('set_range too large', grid, [apply({ op: 'set_range', range: 'A1:Z10000', values: [[1]] })]);
csv('append_row forms', grid, [
  apply({ op: 'append_row', values: ['a', 2, null, { k: 1 }, [3, 4]] }, { op: 'append_row' }, { op: 'append_row', values: null }, { op: 'append_row', values: 0 }),
]);
csv('append_row with a string', grid, [apply({ op: 'append_row', values: 'abc' })]);
csv('append_row with an object', grid, [apply({ op: 'append_row', values: { a: 1 } })]);
csv('clear_cell', grid, [apply(
  { op: 'clear_cell', cell: 'A1' },
  { op: 'clear_cell', cell: 'A1' },
  { op: 'clear_cell', cell: 'Z99' },
  { op: 'clear_cell', cell: 'c3' },
), snapshot({})]);
csv('replace_text', 'aaa,Banana\r\nca,d\r\n,a\r\n', [apply(
  { op: 'replace_text', find: 'a', replace: 'x' },
  { op: 'replace_text', find: 'zzz', replace: 'x' },
  { op: 'replace_text', find: '' },
  { op: 'replace_text', find: 'xx', replace: '$&$1' },
  { op: 'replace_text', find: 'x' },
  { op: 'replace_text', find: 5, replace: 6 },
  { op: 'replace_text', find: 0, replace: 'q' },
)]);
csv('replace_text across quoting', 'a,b\r\n', [apply({ op: 'replace_text', find: 'a', replace: 'x,"y"\nz' })]);
csv('replace_text with a null replacement', 'abc,abd\r\n', [apply({ op: 'replace_text', find: 'ab', replace: null })]);
csv('insert_rows and delete_rows', grid, [
  apply({ op: 'insert_rows', row: 2 }, { op: 'insert_rows', row: 1, count: 2 }, { op: 'insert_rows', row: 99, count: 0 }, { op: 'insert_rows', row: 1.7, count: 1.2 }),
  snapshot({}),
  apply({ op: 'delete_rows', row: 1, count: 3 }, { op: 'delete_rows', row: 9 }, { op: 'delete_rows', row: 2, count: 0 }, { op: 'delete_rows', row: -1 }),
  snapshot({}),
]);
csv('rows with odd numbers', grid, [apply(
  { op: 'insert_rows', row: 'x' },
  { op: 'insert_rows', row: null, count: null },
  { op: 'insert_rows', count: 2 },
  { op: 'insert_rows', row: '2', count: '1' },
  { op: 'delete_rows', row: -2, count: 1 },
  { op: 'delete_rows', row: 'x' },
  { op: 'delete_rows' },
  { op: 'delete_rows', row: 1, count: -3 },
  { op: 'delete_rows', row: 1, count: 'all' },
)]);
csv('insert_rows with an impossible count', grid, [apply({ op: 'insert_rows', row: 1, count: 1e10 })]);
csv('insert_rows with an infinite count', grid, [apply({ op: 'insert_rows', row: 1, count: 'Infinity' })]);
csv('insert_columns and delete_columns', 'a,b,c\r\n1\r\n\r\n4,5,6,7\r\n', [
  apply({ op: 'insert_columns', column: 2 }, { op: 'insert_columns', column: 1, count: 2 }, { op: 'insert_columns', column: 99, count: 1 }),
  snapshot({}),
  apply({ op: 'delete_columns', column: 1, count: 2 }, { op: 'delete_columns', column: 9 }, { op: 'delete_columns', column: 2, count: 0 }, { op: 'delete_columns', column: -1 }),
  snapshot({}),
]);
csv('columns with odd numbers', 'a,b,c\r\n1,2\r\n', [apply(
  { op: 'insert_columns', column: 'x' },
  { op: 'delete_columns' },
  { op: 'insert_columns', column: 0, count: 1 },
  { op: 'delete_columns', column: 2.5, count: 1.5 },
  { op: 'insert_columns', column: -1 },
)]);
csv('insert_columns on an empty sheet with a huge count', '', [apply({ op: 'insert_columns', column: 1, count: 1e10 })]);
csv('insert_columns with an impossible count', grid, [apply({ op: 'insert_columns', column: 1, count: 1e10 })]);
csv('unsupported operation', grid, [apply({ op: 'set_cell', cell: 'A1', value: 'x' }, { op: 'merge_cells' })]);
csv('operation without an op', grid, [apply({ cell: 'A1' })]);
csv('operation of another type', grid, [apply('set_cell')]);
csv('null operation', grid, [apply(null)]);
csv('invalid cells', grid, [
  apply({ op: 'set_cell', cell: 'A0', value: 1 }),
  apply({ op: 'set_cell', cell: 'XFE1', value: 1 }),
  apply({ op: 'set_cell', cell: 'A1048577', value: 1 }),
  apply({ op: 'set_cell', cell: '', value: 1 }),
  apply({ op: 'set_cell', cell: 0, value: 1 }),
  apply({ op: 'set_cell', cell: null, value: 1 }),
  apply({ op: 'clear_cell', cell: 'a-1' }),
]);
csv('invalid ranges', grid, [
  apply({ op: 'set_range', range: 'B2:A1', values: [[1]] }),
  apply({ op: 'set_range', range: '', values: [[1]] }),
  apply({ op: 'set_range', range: 'A1:B2:C3', values: [[1]] }),
  apply({ op: 'set_range', range: ':A1', values: [[1]] }),
]);
csv('an empty batch rewrites the file', 'a,b\nc,d', [apply(), snapshot({})]);
csv('a batch applied in order', grid, [apply(
  { op: 'append_row', values: ['x'] },
  { op: 'insert_rows', row: 1 },
  { op: 'set_cell', cell: 'A1', value: 'top' },
  { op: 'delete_columns', column: 3 },
), snapshot({})]);
csv('a far cell', '', [apply({ op: 'set_cell', cell: 'C3', value: 'x' })]);

// ---- snapshot options ----
const wide = 'a,b,c\r\n,x,\r\n=1+1,,-3\r\n';
csv('snapshot range', wide, [
  snapshot({ range: 'B1:C3' }), snapshot({ range: 'a2' }), snapshot({ range: 'D1:E5' }), snapshot({ range: 'bad' }), snapshot({ range: 5 }), snapshot({ range: '' }), snapshot({ range: null }),
]);
csv('snapshot paging', 'a,b,c\r\nd,e,f\r\ng,h,i\r\n', [
  snapshot({ paged: true }),
  snapshot({ paged: true, offset: 2, limit: 3 }),
  snapshot({ paged: true, offset: 7, limit: 3 }),
  snapshot({ paged: true, offset: 8, limit: 3 }),
  snapshot({ paged: true, offset: 100 }),
  snapshot({ paged: true, offset: -4, limit: 0 }),
  snapshot({ paged: true, offset: 1.5, limit: 2.5 }),
  snapshot({ paged: true, offset: 'x', limit: 'y' }),
  snapshot({ paged: true, offset: '2', limit: '1', range: 'A1:B3' }),
  snapshot({ paged: true, limit: 'Infinity' }),
  snapshot({ paged: true, limit: -3 }),
  snapshot({ paged: 'true', offset: 3, limit: 1 }),
  snapshot({ paged: 1, offset: 3, limit: 1 }),
  snapshot({ offset: 3, limit: 1 }),
]);
csv('snapshot sheet names', 'a\r\n', [
  snapshot({ sheet: 'DATA' }), snapshot({ sheet: 'data' }), snapshot({ sheet: 'other' }), snapshot({ sheet: '' }), snapshot({ sheet: 5 }), snapshot({ sheet: ['data'] }), snapshot({ sheet: 'Data ' }),
]);
csv('the working copy of a file is named for the file', 'a\r\n', [snapshot({}), issues({})], 'Report 2026.mixdog-edit.csv');
csv('a file name in capitals', 'a\r\n', [snapshot({}), issues({})], 'REPORT.MIXDOG-EDIT.CSV');
csv('a dotted file name', 'a\r\n', [snapshot({})], 'a.b.c.csv');
csv('a file named for its extension', 'a\r\n', [snapshot({})], '.csv');
csv('a file named only the edit mark', 'a\r\n', [snapshot({}), issues({})], '.mixdog-edit.csv');
csv('a Hangul file name', '가\r\n', [snapshot({})], '매출.csv');
tsv('a tsv file name', 'a\tb\r\n', [snapshot({}), issues({})], 'sheet.mixdog-edit.tsv');
tsv('a tsv file without an extension', 'a\tb\r\n', [snapshot({})], 'noext');

// ---- validate and issues ----
csv('ragged rows', 'a,b,c\r\n1,2\r\n3,4,5\r\n6,7,8,9\r\n\r\n', [validate, issues({})]);
csv('ragged: a tie goes to the first row', 'a,b\r\n1,2,3\r\n', [issues({})]);
csv('ragged: a tie without the first width goes to the wider', 'a\r\n1,2\r\n3,4,5\r\n6,7\r\n8,9,10\r\n', [issues({})]);
csv('ragged: one wide row among many', 'h1,h2\r\n1,2\r\n3,4\r\n5,6,7\r\n8,9\r\n', [issues({})]);
csv('formula-like values', 'a,b\r\n=SUM(A1),+1\r\n-5,-abc\r\n@x, =1\r\n+,-\r\n-Infinity,+Infinity\r\n-0x10,1e3\r\n- 5,=\r\n', [issues({}), issues({ range: 'A2:A3' }), issues({ range: 'B1:B9' }), issues({ range: 'bad' }), issues({ range: 'Z1:Z2' })]);
scenario('invalid utf-8', 'data.csv', 'csv', `${hex('a,')}${raw(0xff)}${hex('\r\nb,c\r\n')}`, [validate, issues({}), snapshot({}), apply({ op: 'set_cell', cell: 'A2', value: 'x' })]);
scenario('truncated utf-8 sequence', 'data.csv', 'csv', `${hex('a,')}${raw(0xe2, 0x82)}${hex('\r\n')}`, [validate, snapshot({})]);
scenario('nul bytes', 'data.csv', 'csv', `${hex('a,b\r\nc')}${raw(0)}${hex(',d')}${raw(0)}${hex('\r\n')}`, [validate, issues({}), snapshot({})]);
scenario('the replacement character itself', 'data.csv', 'csv', hex('a,�\r\n'), [validate, issues({})]);
scenarios.push({ name: 'the widest sheet', file: 'data.csv', format: 'csv', initial: { wide: 16384 }, steps: [validate, issues({})] });
scenarios.push({ name: 'one column too wide', file: 'data.csv', format: 'csv', initial: { wide: 16385 }, steps: [validate, issues({})] });
csv('an empty file validates', '', [validate, issues({}), snapshot({})]);
csv('issues on a blank row', 'a\r\n\r\nb\r\n', [issues({})]);

// Corrective cases: bounded insertions the old backend supports, explicit null
// versus omitted options, and BOM-only/failed-batch byte preservation.
for (const count of [120001, 122000]) {
  csv(`insert_rows ${count} preserves existing rows`, 'first\r\nlast\r\n', [
    apply({op:'insert_rows',row:2,count}), snapshot({paged:true,limit:2}),
  ]);
  csv(`insert_columns ${count} preserves existing cells`, 'first,last\r\n', [
    apply({op:'insert_columns',column:2,count}), snapshot({paged:true,limit:2}), validate,
  ]);
}
csv('explicit null options differ from omitted options', 'a,b\r\n', [
  snapshot(), issues(), snapshot(null), issues(null),
]);
scenario('read error precedes null options', 'absent.csv', 'csv', null, [snapshot(null), issues(null)]);
csv('BOM-only survives edit and deleting every row', BOM, [
  snapshot(), apply({op:'append_row',values:['가']}), apply({op:'delete_rows',row:1}), snapshot(),
]);
csv('failed batch does not publish earlier mutations', BOM+'first,last\r\n', [
  apply({op:'set_cell',cell:'A1',value:'changed'},{op:'unknown'}), snapshot(),
]);

// ---- the run ----
// A file of one row of `columns` columns, the cells counting up from 0; a scenario's `initial` may be { wide: columns }.
const wideRow = (columns) => `${Array.from({ length: columns }, (_, i) => i).join(',')}\r\n`;
const root = mkdtempSync(path.join(tmpdir(), 'office-tabular-'));
const sepJson = JSON.stringify(path.sep).slice(1, -1);
const normalise = (text, dir) => {
  const dirJson = JSON.stringify(dir).slice(1, -1);
  return text.replaceAll(`${dirJson}${sepJson}`, '<dir>/').replaceAll(`${dir}${path.sep}`, '<dir>/').replaceAll(dir, '<dir>');
};

const recorded = [];
try {
  for (const [index, item] of scenarios.entries()) {
    const dir = path.join(root, String(index));
    mkdirSync(dir);
    const file = path.join(dir, item.file);
    if (item.initial !== null) writeFileSync(file, typeof item.initial === 'string' ? Buffer.from(item.initial, 'hex') : wideRow(item.initial.wide));
    const steps = [];
    for (const step of item.steps) {
      const entry = { kind: step.kind };
      if (step.options !== undefined) entry.options = step.options;
      if (step.operations !== undefined) entry.operations = step.operations;
      try {
        let result;
        if (step.kind === 'create') result = await tabular.createTabular(file);
        else if (step.kind === 'snapshot') result = await tabular.snapshotTabular(file, item.format, step.options);
        else if (step.kind === 'apply') result = await tabular.applyTabularBatch(file, item.format, step.operations);
        else if (step.kind === 'validate') result = await tabular.validateTabular(file, item.format);
        else result = await tabular.issuesTabular(file, item.format, step.options);
        entry.result = normalise(JSON.stringify(result === undefined ? null : result), dir);
      } catch (error) {
        entry.error = normalise(String(error?.message ?? error), dir);
      }
      const content = existsSync(file) ? readFileSync(file).toString('hex') : null;
      // Preserve byte equality evidence for large files too, including insertions.
      if (content !== null && content.length > 4000) {
        entry.fileLength = content.length / 2;
        entry.fileSha256 = createHash('sha256').update(Buffer.from(content, 'hex')).digest('hex');
      } else entry.fileHex = content;
      steps.push(entry);
    }
    recorded.push({ name: item.name, file: item.file, format: item.format, initial: item.initial, steps });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const out = {
  note: 'Recorded from the Node CSV/TSV backend (runtime/office/core/tabular.mjs); tests/twin_tabular.rs replays it.',
  scenarios: recorded,
};
const fixtures = path.join(FIXTURES_ROOT, 'office-tabular');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-tabular', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes, ${recorded.length} scenarios`);
