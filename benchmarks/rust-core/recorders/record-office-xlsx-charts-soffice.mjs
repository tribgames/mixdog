#!/usr/bin/env node
// What the portable workbook chart operation and the LibreOffice driver answer
// (src/runtime/office/portable/portable-xlsx-charts.mjs, portable-soffice.mjs), run through Node: add_chart on fixture
// workbooks step by step (the answer, then the chart part, the drawing, its relationships, the content types and the worksheet
// as text), the refresh of the copy of its cells every chart part carries, the command line and the texts the driver hands to
// LibreOffice for each kind of job, the install paths the Windows registry names, the error cells of a recalculated workbook, and
// the answers of a recalculation that never reaches LibreOffice. Rust `mixdog-ooxml` must answer the same: chart XML, argument and
// registry text equal as text (crates/mixdog-ooxml/tests/twin_xlsx_charts_soffice.rs).
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-charts-soffice.mjs --tree <dir with node_modules> [--faces <dir>] [--live]
//
// `--faces` names the folder of the fixture faces when this checkout does not hold native/core/fixtures/office-measure.
// `--live` also runs LibreOffice, when it is installed, for a recalculation and a rendering and records the computed values and the
// page count; without it nothing here starts LibreOffice. Output: native/core/fixtures/office-xlsx-charts-soffice/golden.json:
// `faces`, `workbooks`, `charts`, `refresh`, `soffice`, `live`. Texts are measured in the fixture faces of office-measure registered
// on both sides.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-xlsx-charts-soffice.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-charts-soffice');
const stage = stageSet(finalDir);
const require = createRequire(join(tree, 'package.json'));
const { GlobalFonts } = require('@napi-rs/canvas');
const JSZip = require('jszip');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const portable = 'src/runtime/office/portable/';
const charts = await importFrom(tree, `${portable}portable-xlsx-charts.mjs`);
const soffice = await importFrom(tree, `${portable}portable-soffice.mjs`);
const cells = await importFrom(tree, `${portable}portable-cells.mjs`);
const opc = await importFrom(tree, `${portable}portable-opc.mjs`);

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-charts-soffice-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
// The recording keeps the text a call answers (key order and number spelling included), or the reason it failed.
const text = async (run) => {
  const outcome = await attempt(run);
  return outcome.error === undefined ? { result: JSON.stringify(outcome.result) } : { error: outcome.error.split(work).join('$DIR').replaceAll('\\', '/') };
};

// ---- the markup ---------------------------------------------------------------------------------------------------
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const worksheet = (inner, head = '') => `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${head}${inner}</worksheet>`;
const rels = (...entries) =>
  `${HEAD}<Relationships xmlns="${PKG}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const inline = (reference, value, style) =>
  `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t>${value}</t></is></c>`;
const num = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`}><v>${value}</v></c>`;
const formula = (reference, expression, value) => `<c r="${reference}"><f>${expression}</f>${value === undefined ? '' : `<v>${value}</v>`}</c>`;
const row = (index, inner) => `<row r="${index}">${inner}</row>`;

const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Twin Miriam"/><family val="2"/></font><font><b/><sz val="12"/><name val="Twin Lisu"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 default
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 1 month
  '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0"/>' + // 2 thousands
  '</cellXfs></styleSheet>';

function book({ sheets, styles = STYLES, calc = '', parts = {} }) {
  const files = {};
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  files['[Content_Types].xml'] =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides.join('')}</Types>`;
  files['_rels/.rels'] = rels(['rId1', 'officeDocument', 'xl/workbook.xml']);
  files['xl/workbook.xml'] =
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') +
    `</sheets>${calc}</workbook>`;
  files['xl/_rels/workbook.xml.rels'] = rels(...sheets.map((_, index) => [`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`]), [`rId${sheets.length + 1}`, 'styles', 'styles.xml']);
  files['xl/styles.xml'] = styles;
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
  });
  return { ...files, ...parts };
}
const zipOf = (files) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip;
};

// ---- the workbooks ------------------------------------------------------------------------------------------------
const REGIONS = ['Seoul', 'Busan', 'Daegu', 'Incheon'];
const summary = worksheet(
  '<cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="3" width="9" customWidth="1"/></cols><sheetData>' +
    row(1, inline('A1', 'Region') + inline('B1', 'Q1') + inline('C1', 'Q2') + inline('D1', 'Q3') + inline('E1', 'Note') + inline('F1', 'Total')) +
    REGIONS.map((name, at) => row(at + 2, inline(`A${at + 2}`, name) + num(`B${at + 2}`, 100 + at * 25, 2) + num(`C${at + 2}`, 80 + at * 10) + num(`D${at + 2}`, 55.5 + at) + inline(`E${at + 2}`, 'n/a') + formula(`F${at + 2}`, `B${at + 2}+C${at + 2}`, 180 + at * 35))).join('') +
    '</sheetData>'
);
const monthly = worksheet(
  '<sheetData>' +
    row(1, inline('A1', 'Month') + inline('B1', 'Visits') + inline('C1', 'Orders')) +
    [46174, 46204, 46235, 46265, 46296, 46327].map((serial, at) => row(at + 2, num(`A${at + 2}`, serial, 1) + num(`B${at + 2}`, 1000 + at * 120) + num(`C${at + 2}`, 40 + at * 3))).join('') +
    '</sheetData>'
);
const plain = worksheet(
  '<sheetData>' + row(1, inline('A1', 'Item') + inline('B1', 'Cost')) + row(2, inline('A2', 'Rent') + num('B2', 1200)) + row(3, inline('A3', 'Power') + formula('B3', 'B2/4')) + '</sheetData>'
);
const declared = worksheet('<sheetData>' + row(1, inline('A1', 'Key') + inline('B1', 'Value')) + row(2, inline('A2', 'x') + num('B2', 3)) + '</sheetData>', '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
const WORKBOOKS = {
  sales: book({ sheets: [{ name: 'Summary', xml: summary }, { name: '월별 계산', xml: monthly }, { name: 'Plain', xml: plain }] }),
  declared: book({ sheets: [{ name: 'Declared', xml: declared }] }),
};
const names = (zip) => Object.keys(zip.files).filter((entry) => !entry.endsWith('/')).sort();

// ---- add_chart, step by step ----------------------------------------------------------------------------------------
const STEPS = [
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5' }],
  ['Summary', { op: 'add_chart', chartType: 'bar', range: 'A1:D5', title: 'Sales <Q1> & more', showValues: true, valueNumberFormat: '#,##0', dataLabelPosition: 'outEnd', dataLabelColor: '333333' }],
  ['Summary', { op: 'add_chart', chartType: 'line', range: 'A1:D3', plotBy: 'rows', cell: 'F2', width: 400, height: 220 }],
  ['Summary', { op: 'add_chart', chartType: 'pie', range: 'A1:B5', seriesColors: ['112233', '445566', '778899'] }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:A5,C1:C5', title: 'Skips a column' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', highlight: 2, mutedColor: 'DDDDDD' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', highlight: 'Busan', seriesColors: ['AA0000'] }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', highlight: 99 }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', highlight: 1.5 }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', cell: 'B8', toColumn: 'F' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', toColumn: 'F' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', cell: 'F8', toColumn: 'B' }],
  ['Summary', { op: 'add_chart', chartType: 'line', range: "'월별 계산'!A1:C7", title: 'Months' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'Nope!A1:B3' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A:B' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:A5', plotBy: 'rows' }],
  ['Summary', { op: 'add_chart', chartType: 'radar', range: 'A1:B5' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', left: 50, top: 60, width: 300, height: 200 }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', cell: 'D2', left: null, top: 3 }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:C5', gridlines: false, valueAxis: false, showLegend: false, zeroBaseline: true, fontName: 'Twin Lisu' }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:A5,F1:F5', title: 'Formula column' }],
  ['Summary', { op: 'add_chart', chartType: 'doughnut', range: 'A1:C5', seriesColors: ['0A0B0C', '0D0E0F'] }],
  ['Summary', { op: 'add_chart', chartType: 'column' }],
  ['Summary', { op: 'add_chart', chartType: 'PIE', range: 'A1:B5', showLegend: true }],
  ['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5', title: 42, showValues: 'yes', width: 'wide' }],
  ['Plain', { op: 'add_chart', chartType: 'column', range: 'A1:B3' }],
  ['Plain', { op: 'add_chart', chartType: 'column', range: 'Summary!A1:B5', cell: 'D1' }],
  ['Plain', { chartType: 'line', range: 'A1:B3' }],
];
const chartScenarios = [];
for (const [name, workbookName, steps] of [
  ['charts on a workbook of three sheets', 'sales', STEPS],
  ['a chart on a sheet that declares its page fit', 'declared', [['Declared', { op: 'add_chart', chartType: 'column', range: 'A1:B2' }], ['Declared', { op: 'add_chart', chartType: 'bar', range: 'A1:B2', cell: 'D2' }]]],
]) {
  const zip = zipOf(WORKBOOKS[workbookName]);
  const recordedSteps = [];
  for (const [sheetName, op] of steps) {
    const sheets = await cells.workbookSheets(zip);
    const sheet = sheets.find((entry) => entry.name === sheetName);
    const xml = await opc.zipText(zip, sheet.path);
    const output = await text(() => charts.addWorksheetChart(zip, sheet, xml, op, sheets));
    const answered = output.result === undefined ? null : JSON.parse(output.result);
    recordedSteps.push({
      sheet: sheetName,
      op,
      output,
      names: names(zip),
      chart: answered?.chart ? await opc.zipText(zip, answered.chart) : null,
      worksheet: await opc.zipText(zip, sheet.path),
      drawing: await opc.zipText(zip, 'xl/drawings/drawing1.xml'),
      drawingRels: await opc.zipText(zip, 'xl/drawings/_rels/drawing1.xml.rels'),
      types: await opc.zipText(zip, '[Content_Types].xml'),
    });
  }
  chartScenarios.push({ name, workbook: workbookName, steps: recordedSteps });
}

// ---- the refresh of a chart part's copy of its cells ------------------------------------------------------------------
const refreshScenarios = [];
for (const [name, mutations, build, rewrites = []] of [
  ['values written after the chart', [['xl/worksheets/sheet1.xml', '<v>100</v>', '<v>777</v>'], ['xl/worksheets/sheet1.xml', '<v>205</v>', '<v>0.5</v>']], [['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:C5' }]]],
  ['a formula column and an edited label', [['xl/worksheets/sheet1.xml', '<v>180</v>', '<v>1234</v>'], ['xl/worksheets/sheet1.xml', '<t>Busan</t>', '<t>Busan &amp; Co</t>']], [['Summary', { op: 'add_chart', chartType: 'bar', range: 'A1:A5,F1:F5' }]]],
  ['dates from another sheet', [['xl/worksheets/sheet2.xml', '<v>46174</v>', '<v>46204</v>']], [['Summary', { op: 'add_chart', chartType: 'line', range: "'월별 계산'!A1:C7" }]]],
  ['a reference to a missing sheet and to a whole column stays as it was', [], [['Summary', { op: 'add_chart', chartType: 'column', range: 'A1:B5' }]], [['Summary!$A$2:$A$5', 'Gone!$A$2:$A$5'], ['Summary!$B$2:$B$5', 'Summary!$B:$B']]],
]) {
  const zip = zipOf(WORKBOOKS.sales);
  for (const [sheetName, op] of build) {
    const sheets = await cells.workbookSheets(zip);
    const sheet = sheets.find((entry) => entry.name === sheetName);
    await charts.addWorksheetChart(zip, sheet, await opc.zipText(zip, sheet.path), op, sheets);
  }
  for (const [from, to] of rewrites) {
    const part = names(zip).find((entry) => /^xl\/charts\/chart\d+\.xml$/.test(entry));
    zip.file(part, (await opc.zipText(zip, part)).replace(from, to));
  }
  for (const [part, from, to] of mutations) zip.file(part, (await opc.zipText(zip, part)).replace(from, to));
  const chartParts = names(zip).filter((entry) => /^xl\/charts\/chart\d+\.xml$/.test(entry));
  const before = Object.fromEntries(await Promise.all(chartParts.map(async (part) => [part, await opc.zipText(zip, part)])));
  const parts = Object.fromEntries(await Promise.all(names(zip).filter((entry) => !chartParts.includes(entry)).map(async (part) => [part, await opc.zipText(zip, part)])));
  await charts.refreshChartCaches(zip);
  const after = Object.fromEntries(await Promise.all(chartParts.map(async (part) => [part, await opc.zipText(zip, part)])));
  refreshScenarios.push({ name, parts, before, after });
}

// ---- the driver: command lines and texts ------------------------------------------------------------------------------
const win = process.platform === 'win32';
const paths = win
  ? { profile: 'C:\\Users\\Twin Name\\AppData\\Local\\Temp\\mixdog-office-profile-ab12cd', unicode: 'C:\\Users\\Twin\\한글 폴더\\profile', out: 'C:\\work\\out dir', input: 'C:\\work\\in put\\report.v2.docx' }
  : { profile: '/tmp/Twin Name/mixdog-office-profile-ab12cd', unicode: '/home/twin/한글 폴더/profile', out: '/work/out dir', input: '/work/in put/report.v2.docx' };
const argumentCases = [];
for (const [kind, to, input] of [
  ['recalculate', 'xlsx', paths.input.replace('.docx', '.xlsx')],
  ['reopen', 'pdf', paths.input],
  ['render', 'pdf', paths.input],
  ['render picture', 'png', paths.input],
  ['legacy document', 'docx', paths.input.replace('.docx', '.doc')],
  ['legacy workbook', 'xlsx', paths.input.replace('.docx', '.xls')],
  ['legacy deck', 'pptx', paths.input.replace('.docx', '.ppt')],
]) {
  for (const profile of [paths.profile, paths.unicode]) argumentCases.push({ kind, profile, to, outDir: paths.out, input, args: soffice.sofficeConvertArguments(profile, { to, outDir: paths.out, input }) });
}
const home = homedir();
const hidden = (value) => value.split(home).join('$HOME');
const fontConfigs = [
  ['/tmp/cache & more', '/Applications/Microsoft Excel.app/Contents/Resources/DFonts'],
  ['/tmp/cache', ''],
  ['/tmp/<cache>', undefined],
].map(([cache, office]) => ({ cache, office: office ?? null, config: hidden(office === undefined ? soffice.macFontConfig(cache) : soffice.macFontConfig(cache, office)) }));
const registryOutputs = [
  '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (Default)    REG_SZ    D:\\Apps\\LibreOffice 24\\program\r\n\r\n',
  'HKEY_CURRENT_USER\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (기본값)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program\r\n',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\n    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\LibreOffice\\program   \n',
  '',
  'ERROR: The system was unable to find the specified registry key or value.',
];
const registryPrograms = registryOutputs.map((output) => ({ output, programs: soffice.registrySofficePrograms(output).map((program) => program.replaceAll('/', '\\')) }));

const errorSheet = worksheet(
  '<sheetData>' +
    row(1, '<c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="C1" t="e"><f>nosuchfn(1)</f><v>#NAME?</v></c>') +
    row(2, '<c r="A2"><f>SUM("nosuch(")</f><v>0</v></c><c r="B2" t="e"><v>   </v></c><c r="C2" t="e"><f>sum(A1:B1)</f><v>#REF!</v></c>') +
    '</sheetData>'
);
const second = worksheet('<sheetData>' + row(1, '<c r="A1" t="e"><v>#N/A</v></c>') + '</sheetData>');
const formulaErrorWorkbooks = {
  'error cells': book({ sheets: [{ name: 'Calc', xml: errorSheet }, { name: "Q1 'plan'", xml: second }] }),
  'no errors': WORKBOOKS.sales,
};
const formulaErrors = [];
for (const [name, files] of Object.entries(formulaErrorWorkbooks)) formulaErrors.push({ workbook: name, output: await text(async () => soffice.workbookFormulaErrors(zipOf(files))) });

// ---- a recalculation that never reaches LibreOffice -------------------------------------------------------------------
const staleCalc = '<calcPr calcId="191029" fullCalcOnLoad="1"/>';
const externalLink = { 'xl/externalLinks/externalLink1.xml': `${HEAD}<externalLink xmlns="${MAIN}"/>` };
const recalcWorkbooks = {
  'no formulas': book({ sheets: [{ name: 'Data', xml: declared }] }),
  'cached formulas': book({ sheets: [{ name: 'Data', xml: summary }] }),
  'missing cache, macro workbook': book({ sheets: [{ name: 'Data', xml: plain }] }),
  'stale, macro workbook': book({ sheets: [{ name: 'Data', xml: summary }], calc: staleCalc }),
  'external links': book({ sheets: [{ name: 'Data', xml: plain }], parts: externalLink }),
};
const recalculations = [];
for (const [workbook, file, force] of [
  ['no formulas', 'a.xlsx', true],
  ['cached formulas', 'a.xlsx', false],
  ['missing cache, macro workbook', 'a.xlsm', false],
  ['stale, macro workbook', 'b.xltx', false],
  ['cached formulas', 'c.XLSM', true],
  ['external links', 'd.xlsx', true],
]) {
  const path = join(work, file);
  writeFileSync(path, await zipOf(recalcWorkbooks[workbook]).generateAsync({ type: 'nodebuffer' }));
  recalculations.push({ workbook, file, force, output: await text(() => soffice.recalculateLibreOfficeWorkbook(path, { force })) });
}

// ---- LibreOffice itself, only when asked for ------------------------------------------------------------------------------
let live = null;
if (args.has('live') && (await soffice.libreOfficeAvailable())) {
  const values = (xml) => Object.fromEntries([...xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<f[^>]*>[^<]*<\/f>)?<v>([^<]*)<\/v>/g)].map((match) => [match[1], match[2]]));
  const recalcPath = join(work, 'live-recalc.xlsx');
  const liveBook = book({ sheets: [{ name: 'Summary', xml: summary.replace(/<v>(?:180|215|250|285)<\/v>/g, '') }] });
  writeFileSync(recalcPath, await zipOf(liveBook).generateAsync({ type: 'nodebuffer' }));
  const report = await soffice.recalculateLibreOfficeWorkbook(recalcPath, { force: true });
  const sheet = await opc.zipText(await JSZip.loadAsync(readFileSync(recalcPath)), 'xl/worksheets/sheet1.xml');
  const { outputBytes: _bytes, ...stable } = report;
  const pdfPath = join(work, 'live-render.pdf');
  const salesPath = join(work, 'live-render.xlsx');
  writeFileSync(salesPath, await zipOf(WORKBOOKS.sales).generateAsync({ type: 'nodebuffer' }));
  await soffice.renderPortableOoxml(salesPath, pdfPath);
  const pages = (readFileSync(pdfPath).toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  live = { recalculation: { workbook: 'sales without its formula values', report: stable, values: values(sheet) }, render: { workbook: 'sales', pages }, recalcBook: liveBook };
}

writeJson(join(stage, 'golden.json'), {
  platform: process.platform,
  workbooks: { ...WORKBOOKS, ...recalcWorkbooks, ...formulaErrorWorkbooks },
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  charts: chartScenarios,
  refresh: refreshScenarios,
  soffice: { argumentCases, registry: soffice.MACRO_LOCKDOWN_REGISTRY, fontConfigs, registryPrograms, formulaErrors, recalculations, maxStderrChars: soffice.MAX_SOFFICE_STDERR_CHARS },
  live,
});
writeSetManifest(stage, { set: 'office-xlsx-charts-soffice', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(work, { recursive: true, force: true });
