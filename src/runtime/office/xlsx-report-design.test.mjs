import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { executeOfficeTool } from './index.mjs';
import { contentPrintArea } from './portable/portable-sheet-page.mjs';
import { value, workspace } from './office-test-support.mjs';

test('report composition preserves equal category emphasis and writes each insight once', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'report.xlsx'),
        mode: 'portable',
        operations: [
          {
            op: 'compose_sheet',
            sheet: 'Sheet1',
            kind: 'dashboard',
            title: 'Sales comparison',
            headers: ['Menu', 'Sales'],
            rows: [
              ['Coffee', 30],
              ['Cake', 20],
            ],
            insights: ['Illustrative operating data.'],
            decision: 'Review the sales mix.',
          },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = snapshot.document.sheets[0].cells;
  const coffee = cells.find((cell) => cell.value === 'Coffee');
  const cake = cells.find((cell) => cell.value === 'Cake');
  assert.equal(Boolean(cake.style?.bold), Boolean(coffee.style?.bold));
  assert.equal(cake.style?.fillColor, coffee.style?.fillColor);
  assert.equal(cells.filter((cell) => String(cell.value || '').includes('Illustrative operating data.')).length, 1);
});

test('portable pie charts persist distinct category colors and page setup includes late drawings', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'chart.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B4',
            values: [
              ['Menu', 'Share'],
              ['A', 0.5],
              ['B', 0.3],
              ['C', 0.2],
            ],
          },
          {
            op: 'add_chart',
            range: 'A1:B4',
            chartType: 'pie',
            left: 300,
            top: 200,
            width: 360,
            height: 240,
            seriesColors: ['173F35', 'B88950', '596B85'],
            showLegend: true,
          },
          { op: 'set_page_setup', printArea: 'A1:B4', fitToContent: true },
        ],
      },
      { cwd }
    )
  );
  const zip = await JSZip.loadAsync(await readFile(created.output || path));
  const chart = await zip.file('xl/charts/chart1.xml').async('string');
  const points = [...chart.matchAll(/<c:dPt>([\s\S]*?)<\/c:dPt>/g)];
  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((entry) => /<a:srgbClr val="([^"]+)"/.exec(entry[1])?.[1]),
    ['173F35', 'B88950', '596B85']
  );
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const area = /name="_xlnm.Print_Area"[^>]*>([^<]+)</.exec(workbook)?.[1];
  assert.match(area, /\$N\$30$/);
});

test('the worksheet snapshot places charts on the cell grid beside the print area', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'anchored.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B5',
            values: [
              ['Quarter', 'Revenue'],
              ['Q1', 120],
              ['Q2', 140],
              ['Q3', 160],
              ['Q4', 190],
            ],
          },
          {
            op: 'add_chart',
            range: 'A1:B5',
            chartType: 'column',
            left: 260,
            top: 20,
            width: 420,
            height: 260,
            title: 'Revenue',
          },
          { op: 'set_page_setup', fitToContent: true, orientation: 'landscape', fitToPagesWide: 1 },
        ],
      },
      { cwd }
    )
  );
  const sheet = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
    .sheets[0];
  assert.equal(sheet.chartCount, 1);
  const chart = sheet.charts[0];
  assert.equal(chart.seriesCount, 1);
  // A column and a bar share one OOXML element; the reader must still name the
  // kind the caller asked for.
  assert.equal(chart.chartType, 'column');
  assert.equal(chart.series[0].valueFormula, 'Sheet1!$B$2:$B$5');
  assert.equal(chart.title, 'Revenue');
  // The chart sits to the right of the data, so the print area has to reach it.
  assert.ok(chart.anchor.startColumn > 2, `chart starts at ${chart.anchor.from}`);
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.fitToPagesWide, 1);
  const bounds = /^A1:([A-Z]+)(\d+)$/.exec(sheet.pageSetup.printArea);
  assert.ok(bounds, `unexpected print area ${sheet.pageSetup.printArea}`);
  const endColumn = [...bounds[1]].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  assert.ok(endColumn >= chart.anchor.endColumn, `print area ends at ${bounds[1]}, chart at ${chart.anchor.to}`);
  assert.ok(
    Number(bounds[2]) >= chart.anchor.endRow,
    `print area ends at row ${bounds[2]}, chart at ${chart.anchor.to}`
  );
});

// A chart part written without a style or colour map leaves its fill to the
// reader: Excel resolves the theme, everything else draws nothing, so the
// rendered sheet shows value labels floating over an empty plot.
test('a chart authored without colors still carries a visible fill on every series and slice', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'defaults.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C4',
            values: [
              ['구간', '처리량', '오류'],
              ['1분기', 12, 3],
              ['2분기', 18, 2],
              ['3분기', 24, 1],
            ],
          },
          { op: 'add_chart', range: 'A1:C4', chartType: 'column', title: '분기별 처리량' },
          { op: 'add_chart', range: 'A1:B4', chartType: 'pie', top: 320 },
        ],
      },
      { cwd }
    )
  );
  const zip = await JSZip.loadAsync(await readFile(created.output || path));
  const column = await zip.file('xl/charts/chart1.xml').async('string');
  const seriesFills = [
    ...column.matchAll(/<c:ser>[\s\S]*?<c:spPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/g),
  ].map((match) => match[1]);
  assert.equal(seriesFills.length, 2, column.slice(0, 400));
  assert.equal(new Set(seriesFills).size, 2, 'two series never share one fill');
  const pie = await zip.file('xl/charts/chart2.xml').async('string');
  const slices = [
    ...pie.matchAll(/<c:dPt><c:idx val="\d+"\/><c:spPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/g),
  ].map((match) => match[1]);
  assert.equal(slices.length, 3, 'every slice of an uncoloured pie is filled');
  assert.equal(new Set(slices).size, 3, 'slices are told apart by colour');
});

test('print fitting uses stored nonuniform dimensions and ignores style-only blank cells', async () => {
  const zip = new JSZip();
  const sheet = { name: 'Report', path: 'xl/worksheets/sheet1.xml' };
  const xml =
    '<worksheet><sheetFormatPr defaultRowHeight="15" defaultColWidth="8.43"/>' +
    '<cols><col min="1" max="1" width="30"/><col min="2" max="2" width="10"/></cols>' +
    '<sheetData><row r="1" ht="40"><c r="A1" t="inlineStr"><is><t>Report</t></is></c></row>' +
    '<row r="100"><c r="Z100" s="2"/></row></sheetData></worksheet>';
  zip.file(sheet.path, xml);
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
  );
  zip.file(
    'xl/drawings/drawing1.xml',
    '<xdr:wsDr><xdr:absoluteAnchor>' +
      `<xdr:pos x="${200 * 12700}" y="${50 * 12700}"/><xdr:ext cx="${80 * 12700}" cy="${50 * 12700}"/>` +
      '</xdr:absoluteAnchor></xdr:wsDr>'
  );
  assert.equal(await contentPrintArea(zip, sheet, xml), 'A1:D5');
  zip.file(
    'xl/drawings/drawing1.xml',
    '<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from>' +
      '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '</xdr:twoCellAnchor></xdr:wsDr>'
  );
  assert.equal(await contentPrintArea(zip, sheet, xml), 'A1:D7');
});
