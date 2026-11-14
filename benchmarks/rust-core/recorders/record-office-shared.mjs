#!/usr/bin/env node
// Golden of the office engine's shared helpers (crate mixdog-office-base): what Node's `runtime/office/shared/*.mjs`, the
// head of `core/office-core.mjs` (the format tables, the legacy-binary refusals, the tool-result envelope) and the cell
// reference parsers of `portable-cells.mjs` / `xlsx-contract.mjs` answer to a fixed corpus. Writes
// native/core/fixtures/office-shared/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-shared.mjs --tree <product tree>
//
// Every section is a list of cases { input, ...output }; an entry that throws is recorded as { error: message }. The
// width and line-break cases measure with one fixed function (a wide character costs 2, padding 2 plus the column), which
// the replay repeats. The system temp directory never appears in the corpus. The output is byte-stable: the corpus is
// constants and keys are written in the order the modules produce them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-shared.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const load = (name) => importFrom(tree, `src/runtime/office/${name}`);

const values = await load('shared/values.mjs');
const labels = await load('shared/labels.mjs');
const pageSizes = await load('shared/page-sizes.mjs');
const widths = await load('shared/column-widths.mjs');
const alignments = await load('shared/column-alignments.mjs');
const lineBreaks = await load('shared/line-breaks.mjs');
const particles = await load('shared/korean-particles.mjs');
const asar = await load('shared/asar-path.mjs');
const core = await load('core/office-core.mjs');
const cells = await load('portable/portable-cells.mjs');
const contract = await load('portable/xlsx-contract.mjs');

const attempt = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// The measure of the width and line-break cases: a wide character (Hangul, CJK) is 2, any other 1; padding is 2 plus the column.
const MEASURE = (text, _row, column) => [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x1100 ? 2 : 1), 2 + column);
const LINE_WIDTH = (text) => [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x1100 ? 2 : 1), 0);

const out = {
  note: 'Recorded from the Node office shared modules; tests/twin_shared.rs replays it.',
  measure: 'width = sum of 2 for a character at or above U+1100 and 1 for any other, plus 2 and the column index; line width is the sum alone',
};

out.values = {
  clone: [
    { a: 1, b: [1.5, null, 'x'], '2': 'two', '1': true },
    { nested: { z: 1, a: { '10': 1, '9': 2, b: 3 } } },
    [1, [2, [3]]],
    'text',
    12.5,
    null,
    1e21,
    0.1,
    -0,
    { 'é': 1, '😀': 2, A: 3 },
  ].map((input) => ({ input, json: JSON.stringify(values.clone(input)) })),
  stable: [
    { b: 1, a: 2, '10': 3, '9': 4 },
    { b: { z: 1, a: [{ y: 1, x: 2 }] }, B: 0, a: null },
    { 'é': 1, z: 2, '😀': 3, '\uffff': 4 },
    [{ b: 1, a: 2 }],
    'text',
    null,
  ].map((input) => ({ input, json: JSON.stringify(values.stableValue(input)) })),
  plainObject: [{}, [], null, 'x', 1, { a: 1 }].map((input) => ({ input, plain: values.plainObject(input) })),
  sha256: ['', 'abc', '한글', 'a'.repeat(1000)].map((input) => ({ input, hex: values.sha256(input) })),
  clamp: [
    [0.5], [2], [-1], ['0.25'], [null], ['abc'], [[]], [[0.5]], [0], [1, 0, 10], [-3, -5, 5], [7, 2, 4], [5, 4, 4], ['12', 0, 100],
  ].map(([input, minimum, maximum]) => ({
    input, minimum: minimum ?? 0, maximum: maximum ?? 1, value: values.clamp(input, minimum ?? 0, maximum ?? 1),
  })),
  compact: [
    ['  a \n\t b  c ', 120], ['abcdef', 3], [0, 10], [12, 10], [null, 10], ['', 10], [false, 5], ['\u00a0x\u3000y\ufeff', 50], ['가나다라마', 3], [['a', 'b'], 10], ['x'.repeat(200), undefined],
  ].map(([input, maximum]) => ({
    input, maximum: maximum ?? 120, text: maximum === undefined ? values.compact(input) : values.compact(input, maximum),
  })),
};

out.labels = [
  'Quarterly review', '분기 보고', '', ['a', ['b', ['한']]], ['x', null, 3], [{ k: '한' }], null, 12, ['가'], '\uac00', '\ud7a3', '\uabff\ud7a4', 'mixed 한 text',
].map((input) => ({ input, labels: labels.presetLabels(input) }));

out.pageSizes = [
  'a3', 'A4', 'a5', 'letter', 'LEGAL', 'Tabloid', 'b5', '', 5, null, true, {}, [100, 200], ['100', '200'], [0, 5], [-1, 5], [1, 2, 3], ['a4'], [1], [null, 5], ['x', 1], [1e308, 1e308], [3, 4.5],
].map((input) => ({ input, ...attempt(() => pageSizes.pageSizePoints(input, 'page size')) }));
out.pageSizesNamedLabel = attempt(() => pageSizes.pageSizePoints('x', 'paper'));

const wideCases = [
  { rows: [['a', 'bb'], ['c', 'd']], available: 20 },
  { rows: [['항목', '설명'], ['처리량 (건)', 'a long description of the row that wraps over several lines']], available: 40 },
  { rows: [['abcdefghij', 'abcdefghij']], available: 10 },
  { rows: [['abcdefgh', 'ab']], available: 14 },
  { rows: [], available: 10 },
  { rows: [[]], available: 10 },
  { rows: [['a']], available: 0 },
  { rows: [['a']], available: -5 },
  { rows: [['a\r\nbb\nccc', 'd e f']], available: 30 },
  { rows: [['월', '처리량 (건)', '설명'], ['6개월', '12,400', '확인이 필요한 항목이며 다음 점검 때 다시 봅니다']], available: 60 },
  { rows: [['a', 'b', 'c'], ['d']], available: 30 },
  { rows: [['aa bbbb', 'aa bbbb', 'aa bbbb'], ['aa bbbb cccc dddd', 'aa bbbb cccc dddd', 'aa bbbb cccc dddd eeee']], available: 40 },
  { rows: [['x', 'yy zz', 'one two three four five six seven'], ['xx', 'y', 'q']], available: 33.5 },
  { rows: [['1', '2', '3', '4']], available: 7 },
];
out.columnWidths = wideCases.map((input) => ({ input, widths: widths.naturalColumnWidths(input.rows, MEASURE, input.available) }));

out.columnAlignments = [
  {
    rows: [
      ['규모', '응답자', '생산성 유지', '이직 의향 감소', '예산', '메모'],
      ['300인 미만', '620', '81%', '22%p', '2.6억 원', '확인 필요'],
      ['1,000인 이상', '510', '79%', '+24%p', '₩600,000', '보류'],
    ],
    columns: 6,
  },
  { rows: [['호', 'n'], ['1호', '3'], ['2호', '4']], columns: 2, declared: ['center'] },
  { rows: [['no', 'name'], ['1', 'a'], ['2', 'b']], columns: 2 },
  { rows: [['no', 'name'], ['1', 'a'], ['2', 'b']], columns: 2, declared: ['', 'RIGHT'], header: false },
  { rows: [['h', 'h']], columns: 3 },
  { rows: [['h', 'v'], ['$120', '(3,000)'], ['€5.50', '-2.5'], ['x', '−4']], columns: 2 },
  { rows: [['h', 'v'], ['12 kg', '3 m'], ['4,5 cm', '7 ea'], ['ab', 'cd']], columns: 2 },
  { rows: [['h', 'v'], ['1', '2'], ['x', 'y'], ['z', 'w']], columns: 2, declared: [null, 0, 'Left'] },
  { rows: [['h', 'v'], ['2025-01-01', 'a'], ['2025-02-01', 'b']], columns: 2 },
  { rows: [['h', 'v'], ['1', ' '], ['2', '']], columns: 2 },
  { rows: [['a', 'b'], ['1']], columns: 2, header: false },
].map((input) => ({
  input,
  alignments: alignments.figureColumnAlignments(input.rows, input.columns, input.declared, input.header ?? true),
}));

out.wrapUnits = [
  ['을', '10월', '14일', '투자심의에서'], ['12만', '6천', '원'], ['1억', '3,500만', '원'], ['3분의', '1'], ['14시', '30분'], ['24억', '원', '예산'],
  ['a', 'b'], [], ['10월'], ['5만', '원'], ['월', '1일'], ['3', '원'], ['3원', '원'], ['3천', '12일'], ['3', '4'],
].map((input) => ({ input, units: lineBreaks.wrapUnits(input) }));
out.withoutRunt = [
  { lines: ['부산 허브 증설이', '필요합니다'], limit: 20 },
  { lines: ['aaaa bbbb cc', 'dd'], limit: 20 },
  { lines: ['aaaa bbbb cc', 'dd'], limit: 4 },
  { lines: ['aaaa bbbb cc', 'dd'], limit: 5 },
  { lines: ['aaaa bbbb', 'dd'], limit: 20 },
  { lines: ['aaaa bbbb cc', 'dd ee'], limit: 20 },
  { lines: ['one'], limit: 20 },
  { lines: [], limit: 20 },
  { lines: ['a b c', ''], limit: 20 },
  { lines: ['a b c', '   '], limit: 20 },
  { lines: ['x y 10월', '14일'], limit: 30 },
  { lines: ['first line', 'aaaa bbbb 12만 6천', '원'], limit: 40 },
  { lines: ['wwww xxxx 3분의', '1'], limit: 40 },
].map((input) => ({ input, lines: lineBreaks.withoutRunt(input.lines, LINE_WIDTH, input.limit) }));

out.koreanParticles = [
  { company: '모아페이', team: '한빛상사', city: '서울', port: '부산' },
  { a: '서울', b: '부산', c: '대구', d: '광주' },
  { a: '사과', b: '책', c: '꽃', d: '나무' },
  { latin: 'ABC', figure: 12, empty: '', nothing: null, spaced: '  서울  ', mixed: '서울A' },
  { '2': '한', '1': '글', k: '값' },
  ['서울', '부산', 3],
  'text',
  null,
  7,
  {},
].map((input) => ({ input, replacements: particles.koreanParticleReplacements(input) }));

out.asarPaths = [
  'C:\\app\\resources\\app.asar\\native\\x.exe', '/a/APP.ASAR/b.ps1', '/a/b/c.ps1', '/a/app.asar', '/a/x.asar/y.asar/z', 'app.asar/x', '/app.asar/x',
  'C:/p/Resources/App.Asar/native/a.dll', '/a/.asar/b', '/a/x.asarx/b', '', '/a/b.asar\\c',
].map((input) => ({ input, path: asar.physicalAsarPath(input) }));

out.formats = {
  fileKindToFormat: Object.entries(core.FILE_KIND_TO_FORMAT),
  formats: [...core.FORMATS],
  tabular: [...core.TABULAR_FORMATS],
  ooxml: [...core.OOXML_FORMATS],
  paths: [
    'a.docx', 'B.XLSM', 'c.potx', 'd.csv', 'e.TSV', 'f.pdf', 'dir/g.dotm', 'g.doc', 'h.DOT', 'i.xls', 'j.xlt', 'k.ppt', 'l.pot', 'm.pps', 'n.txt', 'README',
    '.docx', 'a.', 'dir/x.y/file', 'dir.docx/', 'x.tar.gz', 'a/b.d.pptm', 'a.b.xltx', '...', '..', 'a/.hidden', 'dir/', '', 'x.PDF.bak', 'résumé.docx',
  ].map((input) => ({
    input,
    kind: attempt(() => core.documentFileKind(input)),
    format: attempt(() => core.documentFormat(input)),
    legacy: core.legacyPackageKind(input),
  })),
  normalize: ['DOCX', 'dotm', 'xls', '', 'pdf', 'TSV', 'png', 'pps', 'Csv', ' docx'].map((input) => ({ input, ...attempt(() => core.normalizeOfficeFormat(input)) })),
};

const images = [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { mimeType: 'image/jpeg', data: '/9j/4AAQ' }];
out.envelopes = [
  { value: { ok: true, b: 1, '2': 2, a: [1.5, null, 'é'] } },
  { value: 'plain text' },
  { value: '' },
  { value: 5 },
  { value: null },
  { value: true },
  { value: [1, 'two', { three: 3 }] },
  { value: { ok: false, message: 'bad "quote" \\ and \n newline \u2028 and \ud7ff' }, isError: true },
  { value: { ok: true }, images },
  { value: 'with images', isError: true, images: [images[0]] },
  { value: { n: 1e21, m: 1e-7, big: 123456789012345680000, tiny: 5e-324, neg: -0, third: 0.1 + 0.2 } },
  { value: { nested: { '10': 'a', '9': 'b', x: { '1': 1 } } } },
].map((input) => {
  const result = core.toolResult(input.value, input.isError === true, input.images ?? []);
  return { input, result, text: JSON.stringify(result) };
});
out.conflict = { message: new core.OfficeConflictError({ ok: false, code: 'transaction_conflict' }).message };

out.a1 = {
  columnLabel: [1, 2, 26, 27, 28, 52, 53, 702, 703, 18278, 16384, 0, -5, 1.9, 28.5, 1e6, 17576, 475254].map((input) => ({ input, label: cells.columnLabel(input) })),
  columnNumber: ['A', 'z', 'aa', 'XFD', '', '1', 'a1', 'ab c', 'ß', '\ud835\udc9c', 'ZZZ', 'zzzzzzzzzzzzzzzzzzzzzz'].map((input) => ({ input, number: cells.columnNumber(input) })),
  cellRef: [' b12 ', 'A1', 'aa100', 'A0', '1A', '', 'A1:B2', '$A$1', 'A01', 'XFD1048576', 'A-1', 'a 1', 'AB2\n'].map((input) => ({ input, ...attempt(() => cells.parseCellRef(input)) })),
  xlsxCell: ['A1', 'xfd1048576', 'XFE1', 'A1048577', 'A0', 'a-1', '  b2  ', '', 'AAAA1', 'A99999999999999999999999', 'ZZ5', 'a1048576'].map((input) => ({
    input, ...attempt(() => contract.parseXlsxCell(input)),
  })),
  xlsxRange: [
    { input: 'A1:B2' }, { input: 'b2:D5' }, { input: ' C3 ' }, { input: '' }, { input: 'A1' }, { input: 'B2:A1' }, { input: 'A1:C4' }, { input: 'A1:B2:C3' }, { input: ':A1' },
    { input: 'A1:' }, { input: 'A1:XFE1' }, { input: 'A1:A100001' }, { input: 'A1:A100000' }, { input: ' a1 : b2 ' }, { input: 'A1:C4', maxCells: 10 }, { input: 'A1:B5', maxCells: 10 },
    { input: 'C1:A1' }, { input: 'A1:A1048577' }, { input: 'AB:CD' },
  ].map((input) => ({
    input, ...attempt(() => (input.maxCells === undefined ? contract.parseXlsxRange(input.input) : contract.parseXlsxRange(input.input, { maxCells: input.maxCells }))),
  })),
};

const fixtures = path.join(FIXTURES_ROOT, 'office-shared');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-shared', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
