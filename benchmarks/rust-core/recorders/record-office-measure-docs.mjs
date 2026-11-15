#!/usr/bin/env node
// Golden of the Word, Excel and PDF HTML routes' layout half (crate mixdog-office-author: measure_docx, measure_xlsx,
// pdf_print): what Node's `runtime/office/authoring/docx-html-measure.mjs` (`extractDocxFlow`),
// `xlsx-html-measure.mjs` (`extractXlsxSheets`), `pdf-html-charts.mjs` (`drawDataCharts`) and `pdf-html-runner.mjs`
// (`printableArea`, `frameCanvas`, `printHtmlPdf`) answer for the HTML documents of the office suites
// (office-docx-html.slow, office-xlsx-html.slow, office-pdf-html.slow) and for a few of their own, run in the installed
// Chrome or Edge through puppeteer.
//
//   node benchmarks/rust-core/recorders/record-office-measure-docs.mjs --tree <product tree>
//
// Sections:
//   areas      `printableArea(rule)` for the @page rules the routes see and the ones they refuse (needs no browser: the
//              replay is `twin_measure_docs`).
//   docx       per document: the printable area, the flow `extractDocxFlow` read at that width, the chart warnings,
//              the title, how many pictures were photographed, and the summary of the browser's print of the same HTML.
//   xlsx       per workbook: what `extractXlsxSheets` read at 1920 x 1200 and how many pictures it counted.
//   frames     `frameCanvas` for a designed document, and the refusal when its @page has a margin.
//   prints     per document: what `printHtmlPdf` answered (without the file name, size and time) and the summary of the
//              finished PDF: page count, page sizes, outline titles in order, text of each page, document properties.
// The browser sections depend on the installed browser and its fonts: the replay that runs Rust against them is the
// ignored `twin_live_measure_docs`, on the machine that recorded them.
// Writes native/core/fixtures/office-measure-docs/golden.json and the set's manifest.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-measure-docs.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-measure-docs');
const stage = stageSet(finalDir);

const requireFromTree = createRequire(join(tree, 'package.json'));
const { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } = requireFromTree('pdf-lib');
const runner = await importFrom(tree, 'src/runtime/office/authoring/pdf-html-runner.mjs');
const htmlBrowser = await importFrom(tree, 'src/runtime/office/authoring/html-browser.mjs');
const deckMeasure = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-measure.mjs');
const { extractDocxFlow } = await importFrom(tree, 'src/runtime/office/authoring/docx-html-measure.mjs');
const { extractXlsxSheets } = await importFrom(tree, 'src/runtime/office/authoring/xlsx-html-measure.mjs');
const { drawDataCharts } = await importFrom(tree, 'src/runtime/office/authoring/pdf-html-charts.mjs');
const launch = await importFrom(tree, 'src/runtime/shared/browser-launch.mjs');
if (!launch.localBrowserAvailable()) throw new Error('no local Chrome or Edge: the documents cannot be laid out');
const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = async (run) => {
  try {
    return { output: plain(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- areas -----------------------------------------------------------------------------------------------------------
const RULES = [
  { size: 'A4' },
  { size: 'a4', margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' } },
  { size: 'A5 landscape', margin: { top: '10mm', left: '0.5in', right: '12pt', bottom: '1cm' } },
  { size: 'letter portrait' },
  { size: 'legal landscape', margin: { top: '1in' } },
  { size: 'ledger' },
  { size: 'b5' },
  { size: '148mm 210mm' },
  { size: '600px' },
  { size: '8.5in 11in', margin: { top: '72pt', bottom: '6pc', left: '40Q', right: '0' } },
  { size: '210mm', margin: { left: '15mm' } },
  { size: '', margin: {} },
  { size: 'auto' },
  { size: 'landscape' },
  { size: '0 10px' },
  { size: '12 5mm' },
  { size: 'A4 5.mm' },
  { size: 'A4', margin: { left: '2furlong' } },
  { size: 'A4', margin: { top: '1e3px' } },
  { size: '-10mm 20mm' },
  { size: 'A4 20mm' },
];
const areas = [];
for (const rule of RULES) areas.push({ rule, ...(await attempt(() => runner.printableArea(rule))) });

// ---- the documents ---------------------------------------------------------------------------------------------------
const DOCX = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>운영 보고</title>
<!-- BRIEF
subject/audience/action: 운영 보고 / 운영팀 / 승인
facts: F1 184,200건 — 운영 시트 B4 · F2 37분 — 운영 시트 B5 · F3 동부 69,800건 — 운영 시트 B6 · F4 대기 52분 15분 — 운영 시트 C2:C3
-->
<style>
@page { size: A4; margin: 20mm; }
body { font-family: 'Malgun Gothic', sans-serif; font-size: 10.5pt; line-height: 1.6; color: #374151; }
h1 { font-size: 24pt; line-height: 1.3; color: #111827; margin: 0 0 10pt; }
h2 { font-size: 14pt; color: #111827; margin: 18pt 0 6pt; }
p { margin: 0 0 8pt; }
.cards { display: flex; gap: 10pt; }
.card { flex: 1; background: #EEF4F1; padding: 10pt; }
.card .v { font-size: 22pt; font-weight: 700; color: #1F5E4B; line-height: 1.2; margin: 0; }
.card .l { font-size: 9pt; color: #374151; margin: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4pt 6pt 4pt 0; border-bottom: 0.75pt solid #CCCCCC; }
td.n, th.n { text-align: right; }
</style></head><body>
<header data-first-page="none">운영 보고</header>
<footer>{page} / {pages}</footer>
<h1>처리량은 184,200건이었다</h1>
<div class="cards"><div class="card"><p class="v">184,200건</p><p class="l">3분기 처리량</p></div><div class="card"><p class="v">37분</p><p class="l">대기 시간 단축</p></div></div>
<h2>세부</h2>
<ul><li>동부가 가장 많이 늘었다</li><li>서부도 늘었다</li></ul>
<table><thead><tr><th>허브</th><th class="n">처리량</th></tr></thead><tbody><tr><td>동부</td><td class="n">69,800</td></tr></tbody></table>
<div data-chart='{"type":"col","labels":["6월","9월"],"values":[52,15],"colors":["C9CED6","1F5E4B"]}' style="height:120pt"></div>
</body></html>`;

// The same office features the Word suite does not reach: numbered and nested lists, an inline picture, a rule, an
// absolutely positioned block, a page break, a bordered paragraph, hidden text and an SVG that is photographed.
const DOCX_FEATURES = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Features</title><style>
@page { size: letter; margin: 1in; }
body { font-family: Georgia, serif; font-size: 11pt; line-height: 1.5; }
h2 { break-before: page; font-size: 16pt; }
.note { border-left: 3pt solid #C2461A; padding-left: 8pt; background: #FDF1EC; }
.grid { display: grid; grid-template-columns: 1fr 2fr; gap: 8pt; }
.abs { position: absolute; top: 10px; left: 10px; }
.hide { display: none; }
</style></head><body>
<p>Opening <b>bold</b>, <i>italic</i>, <u>under</u>, <s>strike</s>, <sup>sup</sup>, <sub>sub</sub> and <br>a line break.</p>
<ol><li>First<ul><li>Nested bullet</li></ul></li><li>Second</li></ol>
<hr>
<div class="note">A bordered, shaded paragraph.</div>
<div class="grid"><div>Narrow</div><div>Wide column of text</div></div>
<p class="abs">Placed absolutely</p><p class="hide">Hidden</p>
<svg width="80" height="40" viewBox="0 0 80 40"><rect x="0" y="0" width="80" height="40" fill="#1F5E4B"/></svg>
<p style="text-transform: uppercase">shouting <span style="background:#FFF2A8">marked</span></p>
<h2>After a page break</h2>
<p>Text on the second page.</p>
</body></html>`;

const XLSX = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>운영 보고</title>
<style>
body { margin: 0; font-family: 'Malgun Gothic', sans-serif; color: #374151; }
.report { width: 900px; padding: 24px; box-sizing: border-box; font-size: 13px; }
.title { font-size: 22px; font-weight: 700; color: #111827; line-height: 30px; margin: 0 0 16px; }
.kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 0 0 20px; }
.kpi { background: #EEF4F1; padding: 12px 14px; }
.kpi .v { font-size: 26px; font-weight: 700; color: #1F5E4B; line-height: 34px; margin: 0; }
.kpi .l { font-size: 12px; line-height: 18px; margin: 0; }
.body { display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
table { border-collapse: collapse; font-size: 12px; }
.report table { width: 100%; }
th { text-align: right; background: #EEF4F1; padding: 6px 10px; line-height: 18px; }
td { text-align: right; padding: 6px 10px; line-height: 18px; }
.t { text-align: left; }
</style></head><body>
<section data-sheet="보고" class="report">
  <p class="title">대기 시간이 37분 줄었다</p>
  <div class="kpis">
    <div class="kpi"><p class="v" data-formula="={w6}-{w9}" data-format='0"분"'>37분</p><p class="l">평균 대기 시간 단축</p></div>
    <div class="kpi"><p class="v" data-formula="={v9}" data-format='#,##0"건"'>63,000건</p><p class="l">9월 처리량</p></div>
  </div>
  <div class="body">
    <table>
      <thead><tr><th class="t" id="mh">월</th><th id="vh">처리량 (건)</th><th id="wh">평균 대기 (분)</th></tr></thead>
      <tbody>
        <tr><td class="t" id="m6" data-value="2026-06-01" data-format='m"월"'>6월</td><td id="v6" data-formula="=SUMIFS(Ops[처리량],Ops[월],{m6})" data-format="#,##0">55,100</td><td id="w6" data-formula="=SUMIFS(Ops[대기],Ops[월],{m6})" data-format="0">52</td></tr>
        <tr><td class="t" id="m9" data-value="2026-09-01" data-format='m"월"'>9월</td><td id="v9" data-note="자료: 표본 데이터" data-formula="=SUMIFS(Ops[처리량],Ops[월],{m9})" data-format="#,##0">63,000</td><td id="w9" data-formula="=SUMIFS(Ops[대기],Ops[월],{m9})" data-format="0">15</td></tr>
      </tbody>
    </table>
    <div data-chart='{"type":"col","colors":["C9CED6","1F5E4B"],"format":"0\\"분\\""}' data-range="{mh}:{m9},{wh}:{w9}" style="height:200px"></div>
  </div>
</section>
<section data-sheet="데이터">
  <table data-table="Ops" data-freeze="header">
    <thead><tr><th class="t">월</th><th>처리량</th><th>대기</th></tr></thead>
    <tbody>
      <tr><td class="t" data-value="2026-06-01" data-format="yyyy-mm">2026-06</td><td>55,100</td><td>52</td></tr>
      <tr><td class="t" data-value="2026-09-01" data-format="yyyy-mm">2026-09</td><td>63,000</td><td>15</td></tr>
    </tbody>
  </table>
</section>
</body></html>`;

const XLSX_FEATURES = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font-family: Arial, sans-serif; }
section { padding: 10px; width: 700px; }
.card { background: #EEF4F1; border: 1px solid #1F5E4B; padding: 8px; width: 200px; }
.abs { position: absolute; left: 400px; top: 40px; }
</style></head><body>
<section data-sheet="One" data-gridlines="show" data-freeze="A2" data-fit="width" data-orientation="landscape">
  <div class="card"><span>Label</span><div>Value</div></div>
  <p class="abs">Placed</p>
  <div data-chart='{not json}'></div>
  <div data-chart='{"type":"pie","labels":["a","b"],"values":[1,2]}' data-title="Pie" data-alt="share" style="height:80px"></div>
  <svg width="40" height="20"><rect width="40" height="20" fill="#C2461A"/></svg>
  <table data-table="T"><tr><th>H</th><td colspan="2">span</td></tr></table>
  <div>text beside <div>blocks</div></div>
</section>
<section data-sheet="Hidden" data-hidden="true"><p>hidden sheet</p></section>
</body></html>`;

const pdfPage = (body, css = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>분기 보고서</title><style>
@page { size: A4; margin: 20mm; @bottom-right { content: counter(page) " / " counter(pages); font-size: 9pt; } }
body { margin: 0; font-family: 'Malgun Gothic', 'Noto Sans KR', sans-serif; font-size: 11pt; line-height: 1.6;
  word-break: keep-all; overflow-wrap: break-word; }
h1, h2 { break-after: avoid; }
${css}
</style></head><body>${body}</body></html>`;

const REPORT = `<!-- BRIEF
subject/audience/action: 분기 운영 보고 / 운영팀 / 다음 분기 예산 승인
facts: F1 2,400건 — 운영 시트 B4
-->
<h1>운영 보고서</h1>
<p>이번 분기 처리량은 2,400건이고 대기 시간은 37분이었다.</p>
<h2>세부 내역</h2>
${'<p>세부 항목마다 같은 절차를 반복해 기록한다.</p>\n'.repeat(60)}
<h2>결론</h2>
<p>다음 분기에도 같은 체계를 유지한다.</p>`;

const designed = (margin = '0') => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: ${margin}; }
body { margin: 0; font-family: 'Malgun Gothic', sans-serif; }
.slide { position: relative; width: 210mm; height: 297mm; overflow: hidden; box-sizing: border-box; padding: 24mm 20mm; }
.cover { background: #0F3B3A; color: #FFFFFF; }
.hero { font-size: 72pt; font-weight: 700; margin: 0; }
table { border-collapse: collapse; font-size: 11pt; width: 120mm; }
td { border-bottom: 1px solid #C9CED6; padding: 2mm 0; }
</style></head><body>
<section class="slide cover"><p class="hero">2,400건</p><p style="font-size:14pt">이번 분기 처리량</p></section>
<section class="slide"><h1 style="font-size:20pt;margin:0 0 8mm">세부<br>내역</h1>
<table><tr><td>처리</td><td>정상</td></tr><tr><td>대기</td><td>짧음</td></tr></table>
<div data-chart='{"type":"col","labels":["처리","대기"],"values":[2400,37],"colors":["E4572E","C9CED6"],"format":"#,##0","labelColor":"161B26","size":10}' style="width:120mm;height:55mm;margin-top:8mm"></div>
<i data-icon="check" style="display:block;width:12mm;height:12mm;color:#0F3B3A;margin-top:8mm"></i></section>
</body></html>`;

const CHARTS = pdfPage(
  `<h1>Charts</h1>
<div data-chart='{"type":"col","labels":["a","b","c"],"values":[3,-1,5],"format":"0.0"}' style="height:60mm"></div>
<div data-chart='{"type":"bar","labels":["a","b"],"series":[{"name":"x","values":[1,2]},{"name":"y","values":[2,1]}],"stacked":true,"legend":"b"}' style="height:60mm"></div>
<div data-chart='{"type":"line","labels":["a","b","c"],"values":[1,3,2]}' style="height:60mm"></div>
<div data-chart='{"type":"pie","labels":["a","b"],"values":[1,2],"hole":50}' style="height:60mm"></div>
<div data-chart='{broken'></div>`
);

// ---- browser sections ------------------------------------------------------------------------------------------------
async function inPage(html, work) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-measure-docs-golden-'));
  const source = join(dir, 'doc.html');
  await writeFile(source, html, 'utf8');
  let browser;
  try {
    browser = await htmlBrowser.launchHtmlBrowser('measure-docs-golden');
    return await htmlBrowser.runInBrowser(browser, { signal: null, timeoutMs: 90_000 }, async () => {
      const page = await browser.newPage();
      return work(page, source, dir);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A finished PDF: pages with their sizes and text, the outline titles in order, and the document properties.
async function summarisePdf(bytes) {
  const document = await PDFDocument.load(bytes);
  const titles = [];
  const seen = new Set();
  const walk = (node) => {
    while (node && !seen.has(node)) {
      seen.add(node);
      const title = node.get(PDFName.of('Title'));
      titles.push(title instanceof PDFString || title instanceof PDFHexString ? title.decodeText() : '');
      walk(node.lookupMaybe(PDFName.of('First'), PDFDict));
      node = node.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
  };
  walk(document.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)?.lookupMaybe(PDFName.of('First'), PDFDict));
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const loaded = await task.promise;
  const text = [];
  for (let number = 1; number <= loaded.numPages; number += 1) {
    const content = await (await loaded.getPage(number)).getTextContent();
    text.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''));
  }
  await task.destroy();
  return {
    pageCount: document.getPageCount(),
    sizes: document.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    outline: titles,
    text,
    info: {
      title: document.getTitle() ?? null,
      author: document.getAuthor() ?? null,
      subject: document.getSubject() ?? null,
      keywords: document.getKeywords() ?? null,
    },
  };
}

const PRINT_SKIP = new Set(['output', 'bytes', 'elapsedMs']);
const withoutVolatile = (result) => Object.fromEntries(Object.entries(plain(result)).filter(([key]) => !PRINT_SKIP.has(key)));

const docxCases = [];
for (const [name, html] of [['word suite document', DOCX], ['features', DOCX_FEATURES]]) {
  const run = await attempt(() =>
    inPage(html, async (page, source, dir) => {
      await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
      const area = runner.printableArea(await page.evaluate(runner.readPageRule));
      await page.setViewport({ width: Math.round(area.width), height: Math.round(area.height), deviceScaleFactor: 2 });
      await page.addStyleTag({ content: 'html, body { margin: 0 !important; }' });
      await page.evaluate(deckMeasure.injectIcons, deckMeasure.iconTable().table, '0 0 24 24');
      const charts = await page.evaluate(drawDataCharts);
      await page.evaluate(() => document.fonts.ready);
      const flow = await page.evaluate(extractDocxFlow);
      const captured = await htmlBrowser.photographCaptures(page, 'data-docx-capture', flow.captures, dir);
      await page.emulateMediaType('print');
      const printPath = join(dir, 'print.pdf');
      await page.pdf({ path: printPath, preferCSSPageSize: true, printBackground: true });
      return { area, flow, chartWarnings: charts.warnings, title: await page.title(), captured: captured.size, print: await summarisePdf(await readFile(printPath)) };
    })
  );
  docxCases.push({ name, html, ...run });
}

const xlsxCases = [];
for (const [name, html] of [['excel suite workbook', XLSX], ['features', XLSX_FEATURES]]) {
  const run = await attempt(() =>
    inPage(html, async (page, source, dir) => {
      await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 2 });
      await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
      await page.evaluate(deckMeasure.injectIcons, deckMeasure.iconTable().table, '0 0 24 24');
      await page.evaluate(() => document.fonts.ready);
      const measure = await page.evaluate(extractXlsxSheets);
      const captured = await htmlBrowser.photographCaptures(page, 'data-xlsx-capture', measure.captures, dir);
      return { measure, captured: captured.size };
    })
  );
  xlsxCases.push({ name, html, ...run });
}

const frames = [];
for (const [name, html] of [['designed pages', designed()], ['designed pages with a margin', designed('20mm')], ['no @page size', '<!doctype html><html><body><p>x</p></body></html>']]) {
  const run = await attempt(() =>
    inPage(html, async (page, source) => {
      await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
      return runner.frameCanvas(page);
    })
  );
  frames.push({ name, html, ...run });
}

const PRINTS = [
  { name: 'report (office-pdf-html.slow)', html: pdfPage(REPORT) },
  { name: 'designed pages (office-pdf-html.slow)', html: designed(), frame: true },
  { name: 'charts of every kind', html: CHARTS },
  { name: 'document properties', html: pdfPage(REPORT), properties: { title: '분기 보고서', author: '운영팀', subject: 'Q3', keywords: ['운영', 'ops'] } },
  { name: 'layout check refuses what print would cut', html: pdfPage('<img src="https://example.com/a.png"><div style="width:400mm">넓은 표</div>') },
  { name: 'a picture that did not load', html: pdfPage('<img src="missing.png"><p>x</p>') },
  { name: 'no @page size', html: '<!doctype html><html><body><p>본문</p></body></html>' },
  { name: 'designed pages with a margin printed as a frame', html: designed('20mm'), frame: true },
];
const prints = [];
for (const entry of PRINTS) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-print-golden-'));
  try {
    const output = join(dir, 'out.pdf');
    const result = withoutVolatile(
      await runner.printHtmlPdf(entry.html, output, { sourcePath: runner.pdfHtmlSourcePath(output), frame: Boolean(entry.frame), properties: entry.properties ?? {} })
    );
    const pdf = result.ok ? await summarisePdf(await readFile(output)) : null;
    prints.push({ name: entry.name, html: entry.html, frame: Boolean(entry.frame), properties: entry.properties ?? null, result, pdf });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const golden = {
  note: 'Recorded from the Node HTML routes (docx-html-measure, xlsx-html-measure, pdf-html-charts, pdf-html-runner); tests/twin_measure_docs.rs replays the printable areas and twin_live_measure_docs runs the documents against the installed browser.',
  areas,
  docx: docxCases,
  xlsx: xlsxCases,
  frames,
  prints,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-measure-docs', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
const failed = [...docxCases, ...xlsxCases, ...frames].filter((entry) => entry.error).map((entry) => `${entry.name}: ${entry.error}`);
console.log(`golden.json: areas ${areas.length}, docx ${docxCases.length}, xlsx ${xlsxCases.length}, frames ${frames.length}, prints ${prints.length}${failed.length ? ` (errors: ${failed.join('; ')})` : ''}`);
