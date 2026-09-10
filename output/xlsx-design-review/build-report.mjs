import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';
import { recalculateLibreOfficeWorkbook } from '../../src/runtime/office/portable/portable-ooxml.mjs';
import { workbookSheets } from '../../src/runtime/office/portable/portable-cells.mjs';
import { writeColumnWidths } from '../../src/runtime/office/portable/portable-sheet-xml.mjs';
import { setXmlAttribute } from '../../src/runtime/office/portable/portable-xml.mjs';

const cwd = process.cwd();
const source = resolve('output/모닝브루_2026-06_운영보고서.xlsx');
const output = resolve('output/모닝브루_2026-06_운영보고서_개선.xlsx');
async function office(input) {
  const result = await executeOfficeTool(input, { cwd });
  if (result.isError) throw new Error(result.content?.[0]?.text || 'Office operation failed');
  const value = JSON.parse(result.content[0].text);
  if (value.ok === false) {
    await writeFile(resolve('output/xlsx-design-review/last-failure.json'), JSON.stringify(value, null, 2));
    console.error(JSON.stringify({ reason: value.reason, validation: value.validation,
      recalculation: value.recalculation }, null, 2));
    throw new Error(value.reason || 'Office validation failed');
  }
  return value;
}
const sheet = '대시보드';
const ops = [{ op: 'add_sheet', name: sheet }];
const cell = (address, value) => ops.push({ op: 'set_cell', sheet, cell: address, value });
const formula = (address, value) => ops.push({ op: 'set_formula', sheet, cell: address, formula: value });
const style = (range, properties) => ops.push({ op: 'set_style', sheet, range, properties });
const merge = (range) => ops.push({ op: 'merge_cells', sheet, range });
const ink = '23352F';
const accent = '245C49';
style('A1:L33', { fontName: '맑은 고딕', fontSize: 11, color: ink, fillColor: 'FFFFFF' });
cell('A1', 'MORNING BREW / MONTHLY REVIEW');
merge('A1:L1');
style('A1:L1', { fontSize: 9, bold: true, color: accent });
cell('A2', '모닝브루 6월 운영 보고서');
merge('A2:L2');
style('A2:L2', { fontSize: 25, bold: true });
cell('A3', '2026.06.01–06.30  |  가상 카페 · 예시 데이터  |  전일 영업');
merge('A3:L3');
style('A3:L3', { fontSize: 10, color: '68766E' });
for (const [label, valueRange, labelRange, address, reference, numberFormat] of [
  ['월 매출', 'A6:D7', 'A5:D5', 'A6', "='요약'!B8", '#,##0" 원"'],
  ['순이익 · 단순 모형', 'E6:H7', 'E5:H5', 'E6', "='요약'!B12", '#,##0" 원"'],
  ['순이익률', 'I6:L7', 'I5:L5', 'I6', "='요약'!B13", '0.0%'],
]) {
  merge(labelRange); merge(valueRange);
  cell(labelRange.split(':')[0], label);
  formula(address, reference);
  style(labelRange, { fontSize: 11, color: '63746A', fillColor: 'EDF3EF', bold: true });
  style(valueRange, { fontSize: 27, bold: true, color: accent, fillColor: 'EDF3EF',
    numberFormat, verticalAlignment: 'center' });
}
merge('A9:L9');
formula('A9', '="아메리카노가 매출의 "&TEXT(\'메뉴 분석\'!G5,"0.0%")&"를 차지합니다."');
style('A9:L9', { fontSize: 15, bold: true });
merge('A11:L11');
formula('A11', '="총비용 "&TEXT(\'요약\'!B11,"#,##0")&"원  ·  판매 "&TEXT(\'요약\'!B14,"#,##0")&"개  ·  일평균 매출 "&TEXT(\'요약\'!B15,"#,##0")&"원"');
style('A11:L11', { fontSize: 11, color: '63746A' });
cell('A31', '운영 제안  |  주말의 판매 증가를 반영해 발주량과 근무 배치를 검토합니다.');
merge('A31:L31');
style('A31:L31', { fontSize: 11, bold: true });
cell('A33', '가상 실적입니다. 순이익은 세금·감가상각·이자·결제 수수료를 제외한 단순 모형입니다.');
merge('A33:L33');
style('A33:L33', { fontSize: 9, color: '68766E' });
cell('A39', '차트 연결 데이터 · 자동 계산 / 위쪽 인쇄 영역에는 포함되지 않음');
cell('A40', '6월 일자'); cell('B40', '매출(만원)');
for (let index = 0; index < 30; index += 1) {
  formula(`A${41 + index}`, `=RIGHT('상세 데이터'!A${5 + index},2)`);
  formula(`B${41 + index}`, `='상세 데이터'!E${5 + index}/10000`);
}
cell('E40', '메뉴'); cell('F40', '매출 비중');
for (let index = 0; index < 3; index += 1) {
  formula(`E${41 + index}`, `='메뉴 분석'!A${5 + index}`);
  formula(`F${41 + index}`, `='메뉴 분석'!G${5 + index}`);
}
ops.push(
  { op: 'add_note', sheet, cell: 'A1', text: '기존 모닝브루 보고서의 동일 데이터와 계산 결과를 연결한 디자인 개선본. 외부 자료 없음.' },
  { op: 'add_note', sheet, cell: 'B41', text: '차트 표시 단위를 원에서 만원으로 바꾸기 위해 10,000으로 나눔. 원 단위 계산값은 상세 데이터 시트에 보존.' },
  { op: 'set_sheet_view', sheet, showGridlines: false, zoom: 95 },
  { op: 'add_chart', sheet, range: 'A40:B70', chartType: 'line',
    title: '일별 매출 추이 · 만원', left: 0, top: 205, width: 435, height: 235,
    seriesColors: [accent], showValues: false, showLegend: false, zeroBaseline: true, valueNumberFormat: '0' },
  { op: 'add_chart', sheet, range: 'E40:F43', chartType: 'bar',
    title: '메뉴별 매출 비중', left: 445, top: 205, width: 275, height: 235,
    seriesColors: [accent], showValues: true, showLegend: false, zeroBaseline: true,
    valueNumberFormat: '0%', dataLabelPosition: 'inside_end', dataLabelColor: 'FFFFFF' },
  { op: 'set_page_setup', sheet, printArea: 'A1:L33', orientation: 'landscape',
    fitToPagesWide: 1, fitToPagesTall: 1, leftMargin: 0.25, rightMargin: 0.25,
    topMargin: 0.25, bottomMargin: 0.25, centerHorizontally: true },
  { op: 'set_sheet_visibility', sheet: '요약', visibility: 'hidden' },
  { op: 'set_sheet_visibility', sheet: '차트', visibility: 'hidden' },
);
for (const [name, end] of [['상세 데이터', 'E34'], ['메뉴 분석', 'G14'], ['Checks', 'B6']]) {
  ops.push({ op: 'set_style', sheet: name, range: `A1:${end}`,
    properties: { fontName: '맑은 고딕', color: ink, fillColor: 'FFFFFF', bold: false, fontSize: 11 } });
}
for (const name of ['상세 데이터', '메뉴 분석']) {
  const end = name === '상세 데이터' ? 'E' : 'G';
  ops.push(
    { op: 'set_style', sheet: name, range: `A1:${end}1`, properties: { fontSize: 21, bold: true, color: ink } },
    { op: 'set_style', sheet: name, range: `A4:${end}4`, properties: { bold: true, color: 'FFFFFF', fillColor: accent } },
  );
}
ops.push(
  { op: 'set_style', sheet: '상세 데이터', range: 'B5:D34', properties: { color: '0000FF', fillColor: 'FFF2CC' } },
  { op: 'set_style', sheet: '메뉴 분석', range: 'B5:C7', properties: { color: '0000FF', fillColor: 'FFF2CC' } },
  { op: 'set_style', sheet: '메뉴 분석', range: 'B11:B13', properties: { color: '0000FF', fillColor: 'FFF2CC' } },
  { op: 'set_style', sheet: 'Checks', range: 'A1:B1', properties: { bold: true, color: 'FFFFFF', fillColor: accent } },
);
if (!process.argv.includes('--finalize-only')) {
const opened = await office({ action: 'open', path: source, output, mode: 'portable', operations: ops, audit: false });
await office({ action: 'close', session: opened.session, save: true });

// Artifact-only geometry: preserve the model and give the report a deliberate
// reading canvas. Native cells, formulas and charts remain editable.
const zip = await JSZip.loadAsync(await readFile(output));
const sheets = await workbookSheets(zip);
const report = sheets.find((entry) => entry.name === sheet);
let xml = await zip.file(report.path).async('string');
xml = writeColumnWidths(xml, new Map(Array.from({ length: 12 }, (_, index) => [index + 1, 10.8])));
const heights = new Map([[1, 17], [2, 36], [3, 20], [4, 14], [5, 23], [6, 27], [7, 22],
  [8, 15], [9, 24], [10, 6], [11, 19]]);
xml = xml.replace(/<row\b([^>]*?)(\/>|>)/g, (full, attrs, end) => {
  const row = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
  return `<row${setXmlAttribute(setXmlAttribute(attrs, 'ht', heights.get(row) || 15), 'customHeight', '1')}${end}`;
});
zip.file(report.path, xml);
let workbook = await zip.file('xl/workbook.xml').async('string');
const tags = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)].map((entry) => entry[0]);
const reportIndex = sheets.findIndex((entry) => entry.name === sheet);
const reordered = [tags[reportIndex], ...tags.filter((_, index) => index !== reportIndex)];
workbook = workbook.replace(/<sheets>[\s\S]*?<\/sheets>/, `<sheets>${reordered.join('')}</sheets>`)
  .replace(/\blocalSheetId="(\d+)"/g, (_, id) => `localSheetId="${Number(id) === reportIndex ? 0 : Number(id) + 1}"`)
  .replace(/\bactiveTab="\d+"/g, 'activeTab="0"');
zip.file('xl/workbook.xml', workbook);
for (const [part, file] of Object.entries(zip.files)) {
  if (/^xl\/tables\/table\d+\.xml$/.test(part)) {
    const table = await file.async('string');
    zip.file(part, table.replace(/<tableStyleInfo\b[^>]*\/>/,
      '<tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/>'));
  }
  if (/^xl\/charts\/chart\d+\.xml$/.test(part)) {
    let chart = await file.async('string');
    chart = chart.replace(/<a:defRPr\b([^>]*?)\/>/g, '<a:defRPr$1><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/></a:defRPr>')
      .replace(/<\/a:defRPr>/g, '<a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/></a:defRPr>');
    // Keep one font declaration per run.
    chart = chart.replace(/(<a:latin typeface="Arial"\/><a:ea typeface="맑은 고딕"\/>){2}/g,
      '<a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/>');
    zip.file(part, chart);
  }
}
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }));
}
const recalculation = await recalculateLibreOfficeWorkbook(output, { force: true });
await writeFile(resolve('output/xlsx-design-review/recalculation.json'), JSON.stringify(recalculation, null, 2));
if (recalculation.status !== 'success') throw new Error(JSON.stringify(recalculation));
const final = await office({
  action: 'open', path: output, output: resolve('output/모닝브루_2026-06_운영보고서_개선본.xlsx'), mode: 'portable', finalize: true,
  auditProfile: 'financial-model', failOn: 'error',
});
await writeFile(resolve('output/xlsx-design-review/report-result.json'), JSON.stringify(final, null, 2));
console.log(JSON.stringify({
  path: final.path, finalized: final.finalized, validation: final.validation?.ok,
  recalculation: final.recalculation, preview: final.review?.preview?.images,
  issues: final.review?.issuesAfter?.map(({ code, path }) => ({ code, path })),
}, null, 2));
