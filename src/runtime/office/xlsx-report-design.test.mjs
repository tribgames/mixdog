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
  const created = value(await executeOfficeTool({
    action: 'create', path: join(cwd, 'report.xlsx'), mode: 'portable',
    operations: [{
      op: 'compose_sheet', sheet: 'Sheet1', kind: 'dashboard',
      title: 'Sales comparison', headers: ['Menu', 'Sales'],
      rows: [['Coffee', 30], ['Cake', 20]],
      insights: ['Illustrative operating data.'], decision: 'Review the sales mix.',
    }],
  }, { cwd }));
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
  const created = value(await executeOfficeTool({
    action: 'create', path, mode: 'portable', operations: [
      { op: 'set_range', range: 'A1:B4', values: [['Menu', 'Share'], ['A', 0.5], ['B', 0.3], ['C', 0.2]] },
      { op: 'add_chart', range: 'A1:B4', chartType: 'pie', left: 300, top: 200, width: 360, height: 240,
        seriesColors: ['173F35', 'B88950', '596B85'], showLegend: true },
      { op: 'set_page_setup', printArea: 'A1:B4', fitToContent: true },
    ],
  }, { cwd }));
  const zip = await JSZip.loadAsync(await readFile(created.output || path));
  const chart = await zip.file('xl/charts/chart1.xml').async('string');
  const points = [...chart.matchAll(/<c:dPt>([\s\S]*?)<\/c:dPt>/g)];
  assert.equal(points.length, 3);
  assert.deepEqual(points.map((entry) => /<a:srgbClr val="([^"]+)"/.exec(entry[1])?.[1]),
    ['173F35', 'B88950', '596B85']);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const area = /name="_xlnm.Print_Area"[^>]*>([^<]+)</.exec(workbook)?.[1];
  assert.match(area, /\$N\$30$/);
});

test('print fitting uses stored nonuniform dimensions and ignores style-only blank cells', async () => {
  const zip = new JSZip();
  const sheet = { name: 'Report', path: 'xl/worksheets/sheet1.xml' };
  const xml = '<worksheet><sheetFormatPr defaultRowHeight="15" defaultColWidth="8.43"/>'
    + '<cols><col min="1" max="1" width="30"/><col min="2" max="2" width="10"/></cols>'
    + '<sheetData><row r="1" ht="40"><c r="A1" t="inlineStr"><is><t>Report</t></is></c></row>'
    + '<row r="100"><c r="Z100" s="2"/></row></sheetData></worksheet>';
  zip.file(sheet.path, xml);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  zip.file('xl/drawings/drawing1.xml', '<xdr:wsDr><xdr:absoluteAnchor>'
    + `<xdr:pos x="${200 * 12700}" y="${50 * 12700}"/><xdr:ext cx="${80 * 12700}" cy="${50 * 12700}"/>`
    + '</xdr:absoluteAnchor></xdr:wsDr>');
  assert.equal(await contentPrintArea(zip, sheet, xml), 'A1:D5');
  zip.file('xl/drawings/drawing1.xml', '<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from>'
    + '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
    + '</xdr:twoCellAnchor></xdr:wsDr>');
  assert.equal(await contentPrintArea(zip, sheet, xml), 'A1:D7');
});
