import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { describeOfficeCapabilities } from './capabilities.mjs';
import { expandOfficeDesignOperations } from './design-system.mjs';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { applyPortableOoxmlBatch } from './portable-ooxml.mjs';
import { createPortableOoxmlDocument } from './portable-package.mjs';
import { describeOfficeSnapshotViolations, officeSnapshotContractViolations } from './snapshot-contract.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'mixdog-portable-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(path, 'mixdog-data');
  t.after(async () => {
    resetOfficeSessionsForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function value(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function writeZip(path, files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function parts(path) {
  const zip = await JSZip.loadAsync(await readFile(path));
  return {
    has: (name) => Boolean(zip.file(name)),
    text: async (name) => {
      const file = zip.file(name);
      assert.ok(file, `package is missing ${name}`);
      return await file.async('string');
    },
  };
}

test('portable create produces openable Word, Excel, and PowerPoint packages', async (t) => {
  const cwd = await workspace(t);
  const expected = {
    docx: ['word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'],
    xlsx: ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'],
    pptx: ['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'],
  };
  for (const [fileKind, required] of Object.entries(expected)) {
    const target = join(cwd, `created.${fileKind}`);
    const created = value(await executeOfficeTool({
      action: 'create',
      path: target,
      mode: 'portable',
    }, { cwd }));
    assert.equal(created.backend, 'mixdog-ooxml');
    const packaged = await parts(target);
    for (const part of ['[Content_Types].xml', '_rels/.rels', ...required]) {
      assert.equal(packaged.has(part), true, `${fileKind} is missing ${part}`);
    }
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  }
});

test('portable workbook authoring writes styles, merges, panes, and page setup', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'authored.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
  }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Quarterly revenue' },
      { op: 'merge_cells', range: 'A1:C1' },
      {
        op: 'set_style',
        range: 'A1:C1',
        properties: { bold: true, fillColor: '#1B4965', color: 'FFFFFF', horizontalAlignment: 'center' },
      },
      { op: 'set_range', range: 'A3:C4', values: [['Region', 'Revenue', 'Share'], ['Korea', 120, 0.42]] },
      { op: 'set_style', cell: 'C4', properties: { numberFormat: '0.0%' } },
      { op: 'freeze_panes', row: 4, column: 1 },
      { op: 'autofit_range', range: 'A:C' },
      { op: 'set_sheet_view', showGridlines: false, zoom: 90 },
      { op: 'set_page_setup', printArea: 'A1:C4', orientation: 'landscape', fitToPagesWide: 1, centerHorizontally: true },
      { op: 'add_sheet', name: 'Appendix' },
    ],
  }, { cwd }));
  assert.equal(batch.results.length, 10);
  const packaged = await parts(target);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<mergeCell ref="A1:C1"\/>/);
  assert.match(sheet, /<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<cols><col /);
  assert.match(sheet, /showGridLines="0"/);
  assert.match(sheet, /orientation="landscape"/);
  const styles = await packaged.text('xl/styles.xml');
  assert.match(styles, /formatCode="0\.0%"/);
  assert.match(styles, /<fgColor rgb="FF1B4965"\/>/);
  const workbook = await packaged.text('xl/workbook.xml');
  assert.match(workbook, /_xlnm\.Print_Area/);
  assert.match(workbook, /name="Appendix"/);
  assert.equal(packaged.has('xl/worksheets/sheet2.xml'), true);
});

test('portable presentation authoring manages slides, shapes, tables, and notes', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'authored.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'add_slide' },
      { op: 'set_slide_background', slide: 1, color: '1B4965' },
      {
        op: 'add_textbox',
        slide: 1,
        text: 'Portable deck',
        properties: { left: 58, top: 60, width: 820, height: 70, fontSize: 36, bold: true, color: 'FFFFFF' },
      },
      {
        op: 'add_shape',
        slide: 1,
        shapeType: 'rounded_rectangle',
        text: '42%',
        properties: { left: 520, top: 180, width: 320, height: 140, fillColor: '5FA8D3', color: 'FFFFFF' },
      },
      { op: 'add_slide' },
      {
        op: 'add_table',
        slide: 2,
        values: [['Region', 'Revenue'], ['Korea', '120']],
        left: 58,
        top: 100,
        width: 520,
        height: 120,
        properties: { headerFillColor: '1B4965', headerColor: 'FFFFFF' },
      },
      { op: 'set_notes', slide: 2, text: 'Revenue by region.' },
    ],
  }, { cwd }));
  const packaged = await parts(target);
  const first = await packaged.text('ppt/slides/slide1.xml');
  assert.match(first, /<p:bg>/);
  assert.match(first, /<a:prstGeom prst="roundRect">/);
  assert.match(first, /Portable deck/);
  const second = await packaged.text('ppt/slides/slide2.xml');
  assert.match(second, /<a:tbl>/);
  assert.equal(packaged.has('ppt/notesSlides/notesSlide2.xml'), true);
  assert.equal(packaged.has('ppt/notesMasters/notesMaster1.xml'), true);
  // PowerPoint reports the entire package as corrupt and unreadable when the
  // notes master shares the slide master's theme part, so every deck carrying
  // speaker notes needs a theme of its own.
  const notesMasterRelationships = await packaged.text('ppt/notesMasters/_rels/notesMaster1.xml.rels');
  const notesTheme = /Target="\.\.\/theme\/(theme\d+\.xml)"/.exec(notesMasterRelationships)?.[1];
  const slideMasterRelationships = await packaged.text('ppt/slideMasters/_rels/slideMaster1.xml.rels');
  const slideTheme = /Target="\.\.\/theme\/(theme\d+\.xml)"/.exec(slideMasterRelationships)?.[1];
  assert.ok(notesTheme, 'the notes master must reference a theme');
  assert.notEqual(notesTheme, slideTheme, 'the notes master needs a theme part of its own');
  assert.equal(packaged.has(`ppt/theme/${notesTheme}`), true);
  assert.match(
    await packaged.text('[Content_Types].xml'),
    new RegExp(`PartName="/ppt/theme/${notesTheme}"`),
  );

  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'move_slide', slide: 2, index: 1 }],
  }, { cwd }));
  const reordered = await parts(target);
  const presentation = await reordered.text('ppt/presentation.xml');
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="(rId\d+)"/g)].map((match) => match[1]);
  const rels = await reordered.text('ppt/_rels/presentation.xml.rels');
  const targets = order.map((id) => new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]);
  assert.deepEqual(targets, ['slides/slide2.xml', 'slides/slide1.xml']);
});

test('portable composition stays inside the portable operation catalog', () => {
  const supported = {
    xlsx: new Set(describeOfficeCapabilities({ format: 'xlsx', backend: 'mixdog-ooxml' }).operations),
    pptx: new Set(describeOfficeCapabilities({ format: 'pptx', backend: 'mixdog-ooxml' }).operations),
    docx: new Set(describeOfficeCapabilities({ format: 'docx', backend: 'mixdog-ooxml' }).operations),
  };
  const composed = {
    xlsx: [{
      op: 'compose_sheet',
      title: 'Regional revenue',
      headers: ['Region', 'Revenue'],
      rows: [['Korea', 120]],
      metrics: [{ label: 'Revenue', value: 120 }],
      source: { document: 'internal model' },
    }],
    pptx: [
      {
        op: 'compose_slide',
        kind: 'cover',
        title: 'Portable decks',
        plan: { regions: [{ id: 'message', role: 'title', x: 8, y: 30, w: 78, h: 22 }] },
      },
      {
        op: 'compose_slide',
        kind: 'metrics',
        title: 'Coverage',
        metrics: [{ label: 'Formats', value: '3' }],
        plan: {
          regions: [
            { id: 'message', role: 'title', x: 7, y: 8, w: 80, h: 16 },
            { id: 'evidence', role: 'metric', x: 62, y: 30, w: 28, h: 44 },
          ],
        },
      },
      {
        op: 'compose_slide',
        kind: 'table',
        title: 'Regions',
        table: [['Region', 'Revenue'], ['Korea', '120']],
        plan: {
          regions: [
            { id: 'message', role: 'title', x: 7, y: 8, w: 80, h: 16 },
            { id: 'evidence', role: 'table', x: 7, y: 31, w: 86, h: 50 },
          ],
        },
      },
    ],
    docx: [{
      op: 'compose_document',
      title: 'Portable authoring',
      sections: [{ heading: 'Decision', body: ['Ship it.'] }],
    }],
  };
  for (const [format, operations] of Object.entries(composed)) {
    const expanded = expandOfficeDesignOperations({
      format,
      backend: 'mixdog-ooxml',
      operations,
      created: true,
      snapshotVersion: 0,
    });
    assert.ok(expanded.operations.length > 0);
    for (const operation of expanded.operations) {
      assert.equal(supported[format].has(operation.op), true, `${format} composition emitted ${operation.op}`);
    }
  }
});

test('portable composition keeps charts native instead of rejecting them', () => {
  const sheet = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    operations: [{
      op: 'compose_sheet',
      headers: ['Region', 'Revenue'],
      rows: [['Korea', 120], ['Japan', 95]],
      chart: { type: 'column' },
    }],
    created: true,
  });
  assert.ok(sheet.operations.some((entry) => entry.op === 'add_chart'));
  const deck = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'mixdog-ooxml',
    operations: [{
      op: 'compose_slide',
      kind: 'chart',
      title: 'Trend',
      chart: { series: [{ name: '2026', values: [1, 2, 3] }], categories: ['a', 'b', 'c'] },
      plan: {
        regions: [
          { id: 'message', role: 'title', x: 7, y: 8, w: 80, h: 16 },
          { id: 'evidence', role: 'chart', x: 7, y: 30, w: 86, h: 60 },
        ],
      },
    }],
    created: true,
  });
  assert.ok(deck.operations.some((entry) => entry.op === 'add_chart' || entry.op === 'set_chart_data'));
});

test('portable charts write a chart part with an embedded workbook', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'chart.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: deck,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_chart',
        slide: 1,
        chartType: 'column',
        title: 'Revenue',
        categories: ['Korea', 'Japan'],
        series: [{ name: '2026', values: [120, 95], color: '1B4965' }],
        left: 58,
        top: 90,
        width: 520,
        height: 300,
      },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).changed, true);
  const packaged = await parts(deck);
  const chart = await packaged.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:barChart>/);
  assert.match(chart, /<c:v>120<\/c:v>/);
  assert.match(chart, /srgbClr val="1B4965"/);
  assert.equal(packaged.has('ppt/embeddings/chartData1.xlsx'), true);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<p:graphicFrame>/);

  const updated = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{
      op: 'set_chart_data',
      slide: 1,
      shape: 1,
      series: [{ name: '2027', values: [180, 140] }],
    }],
  }, { cwd }));
  assert.equal(updated.results[0].changed, true);
  const revised = await (await parts(deck)).text('ppt/charts/chart1.xml');
  assert.match(revised, /<c:v>180<\/c:v>/);
  assert.doesNotMatch(revised, /<c:v>120<\/c:v>/);
});

test('portable workbook charts anchor through a drawing part', async (t) => {
  const cwd = await workspace(t);
  const book = join(cwd, 'chart.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: book,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      {
        op: 'add_chart',
        range: 'A1:B3',
        chartType: 'column',
        title: 'Revenue',
        left: 320,
        top: 20,
        width: 460,
        height: 280,
        seriesColors: ['1B4965'],
      },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).series, 1);
  const packaged = await parts(book);
  const chart = await packaged.text('xl/charts/chart1.xml');
  assert.match(chart, /Sheet1!\$B\$2:\$B\$3/);
  assert.match(chart, /<c:v>120<\/c:v>/);
  const drawing = await packaged.text('xl/drawings/drawing1.xml');
  assert.match(drawing, /<xdr:absoluteAnchor>/);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<drawing r:id="/);
});

test('portable cell writes stay ordered and keep the section break last', async (t) => {
  const cwd = await workspace(t);
  const workbook = join(cwd, 'ordering.xlsx');
  await createPortableOoxmlDocument(workbook, { fileKind: 'xlsx' });
  await applyPortableOoxmlBatch(workbook, 'xlsx', [
    { op: 'set_cell', cell: 'C5', value: 'third' },
    { op: 'set_cell', cell: 'A2', value: 'first' },
    { op: 'set_cell', cell: 'B5', value: 'second' },
  ]);
  const sheet = await (await parts(workbook)).text('xl/worksheets/sheet1.xml');
  const rows = [...sheet.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(rows, [2, 5]);
  const cells = [...sheet.matchAll(/<c r="([A-Z]+\d+)"/g)].map((match) => match[1]);
  assert.deepEqual(cells, ['A2', 'B5', 'C5']);

  const document = join(cwd, 'ordering.docx');
  await createPortableOoxmlDocument(document, { fileKind: 'docx' });
  await applyPortableOoxmlBatch(document, 'docx', [
    { op: 'append_text', text: 'Heading', style: 'Heading1', properties: { bold: true, size: 18 } },
    { op: 'add_table', values: [['A', 'B']] },
  ]);
  const body = await (await parts(document)).text('word/document.xml');
  assert.ok(body.indexOf('<w:tbl>') < body.indexOf('<w:sectPr>'), 'table must precede the section break');
  assert.ok(body.indexOf('Heading') < body.indexOf('<w:sectPr>'), 'text must precede the section break');
});

const PNG_PIXEL = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000100ffff03000006000557bfabd400000000'
  + '49454e44ae426082',
  'hex',
);

test('portable Word authoring covers images, sections, lists, and links', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'mark.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'report.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'append_text', text: 'Quarterly report', style: 'Title' },
      { op: 'append_text', text: 'Coverage expanded' },
      { op: 'set_list', paragraph: 2, kind: 'bullet' },
      { op: 'add_image', path: picture, width: 120, height: 120 },
      { op: 'add_hyperlink', paragraph: 1, address: 'https://example.com/report', display: 'Full report' },
      { op: 'set_font', find: 'Quarterly report', properties: { color: '#1B4965', bold: true } },
      { op: 'insert_break', kind: 'page' },
      { op: 'set_page', properties: { orientation: 'landscape', topMargin: 56.7 } },
      { op: 'set_header_footer', text: 'Mixdog', header: true },
      { op: 'add_page_numbers', includeTotal: true },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 10);
  const packaged = await parts(target);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /<w:drawing>/);
  assert.match(document, /<w:numPr>/);
  assert.match(document, /<w:hyperlink/);
  assert.match(document, /<w:br w:type="page"\/>/);
  assert.match(document, /w:orient="landscape"/);
  assert.match(document, /w:top="1134"/);
  assert.match(document, /<w:headerReference/);
  assert.match(document, /<w:footerReference/);
  assert.doesNotMatch(document, /<w:body><w:p\/>/, 'the seeded empty paragraph must be reused');
  assert.equal(packaged.has('word/numbering.xml'), true);
  assert.equal(packaged.has('word/media/image1.png'), true);
  const footer = await packaged.text('word/footer1.xml');
  assert.match(footer, /w:instr=" PAGE "/);
  assert.match(footer, /w:instr=" NUMPAGES "/);
});

test('portable workbook formulas are normalized and unsupported ones rejected', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'formulas.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      { op: 'set_formula', cell: 'B4', formula: '=SUM(B2:B3)' },
      { op: 'set_formula', cell: 'C4', formula: '=TEXTJOIN(", ",TRUE,A2:A3)' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 3);
  const sheet = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /_xlfn\.TEXTJOIN/, 'post-2007 functions need the _xlfn prefix');
  assert.match(sheet, /<f>SUM\(B2:B3\)<\/f>/);

  const rejected = await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_formula', cell: 'D4', formula: '=XLOOKUP(A2,A:A,B:B)' }],
  }, { cwd });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /XLOOKUP/);
});

test('portable workbook warns when writing inside a merged range', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'merged.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Title' },
      { op: 'merge_cells', range: 'A1:C1' },
      { op: 'set_cell', cell: 'B1', value: 'hidden' },
    ],
  }, { cwd }));
  const [anchor, , inside] = created.batch.results;
  assert.equal(anchor.warning, undefined);
  assert.match(inside.warning, /merged range/);
});

test('portable workbook tables register a table part', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'table.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      { op: 'add_table', range: 'A1:B3', name: 'Revenue', style: 'TableStyleMedium9' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).columns, 2);
  const packaged = await parts(target);
  const table = await packaged.text('xl/tables/table1.xml');
  assert.match(table, /name="Revenue"/);
  assert.match(table, /<tableColumn id="1" name="Region"\/>/);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<tableParts count="1">/);
});

test('portable Word tables gain and drop rows and columns', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'grid.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_table', values: [['A', 'B', 'C'], ['1', '2', '3']] },
      { op: 'insert_table_row', table: 1, row: 3 },
      { op: 'delete_table_column', table: 1, column: 3 },
      { op: 'insert_table_column', table: 1, column: 1 },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.every((entry) => entry.changed), true);
  const document = await (await parts(target)).text('word/document.xml');
  const rows = (document.match(/<w:tr>/g) || []).length;
  assert.equal(rows, 3, 'a row must have been appended');
  const firstRow = /<w:tr>[\s\S]*?<\/w:tr>/.exec(document)[0];
  assert.equal((firstRow.match(/<w:tc>/g) || []).length, 3, 'one column removed and one inserted');
  assert.equal((document.match(/<w:gridCol/g) || []).length, 3);
});

test('portable workbook shifts rows and columns and manages sheet metadata', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'structure.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:C3', values: [['Region', 'A', 'B'], ['Korea', 1, 2], ['Japan', 3, 4]] },
      { op: 'insert_rows', row: 2, count: 1 },
      { op: 'delete_columns', column: 3, count: 1 },
      { op: 'set_autofilter', range: 'A1:B4' },
      { op: 'define_name', name: 'Regions', refersTo: 'Sheet1!$A$3:$A$4' },
      { op: 'add_sheet', name: 'Notes' },
      { op: 'set_sheet_visibility', sheet: 'Notes', visibility: 'hidden' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 7);
  const packaged = await parts(target);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  const rows = [...sheet.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(rows, [1, 3, 4], 'rows below the insertion point shift down');
  assert.doesNotMatch(sheet, /r="C\d+"/, 'the deleted column disappears');
  assert.match(sheet, /<autoFilter ref="A1:B4"\/>/);
  const workbook = await packaged.text('xl/workbook.xml');
  assert.match(workbook, /name="Regions"/);
  assert.match(workbook, /state="hidden"/);
});

test('portable slides align, distribute, reorder, and duplicate', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'layout.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_shape', slide: 1, shapeType: 'rectangle', text: 'A', properties: { left: 40, top: 300, width: 120, height: 80 } },
      { op: 'add_shape', slide: 1, shapeType: 'rectangle', text: 'B', properties: { left: 400, top: 120, width: 120, height: 80 } },
      { op: 'align_shapes', slide: 1, shapes: [1, 2], align: 'middle' },
      { op: 'distribute_shapes', slide: 1, shapes: [1, 2], direction: 'horizontal', relativeToSlide: true },
      { op: 'z_order', slide: 1, shape: 1, command: 'front' },
      { op: 'duplicate_slide', slide: 1 },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).slide, 2);
  const packaged = await parts(target);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  const tops = [...slide.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g)]
    .map((match) => Number(match[2]))
    .filter((value) => value > 0);
  assert.equal(new Set(tops).size, 1, 'aligned shapes share one vertical position');
  assert.equal(packaged.has('ppt/slides/slide2.xml'), true);
  const presentation = await packaged.text('ppt/presentation.xml');
  assert.equal((presentation.match(/<p:sldId /g) || []).length, 2);
});

test('portable slides link shapes, cite sources, and prune to a keep list', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'links.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_slide' },
      { op: 'add_textbox', slide: 1, text: 'Link me', properties: { left: 60, top: 60, width: 300, height: 60, fontSize: 24 } },
      { op: 'set_hyperlink', slide: 1, shape: 1, address: 'https://example.com/report' },
      { op: 'add_provenance', slide: 1, shape: 1, source: { document: 'internal model', target: 'Q3' } },
      { op: 'keep_slides', slides: [1] },
    ],
  }, { cwd }));
  const citation = created.batch.results.find((entry) => entry.op === 'add_provenance');
  assert.equal(citation.citation, 'Source: internal model#Q3');
  assert.equal(created.batch.results.at(-1).remaining, 1);
  const packaged = await parts(target);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<a:hlinkClick[^>]*r:id="rId\d+"/);
  const relationships = await packaged.text('ppt/slides/_rels/slide1.xml.rels');
  assert.match(relationships, /TargetMode="External"/);
  assert.equal(packaged.has('ppt/notesSlides/notesSlide1.xml'), true);
  const notes = await packaged.text('ppt/notesSlides/notesSlide1.xml');
  assert.match(notes, /internal model#Q3/);
});

test('portable workbook copies sheets and adds images, links, validation, and protection', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'logo.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'sheet.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      { op: 'copy_sheet', sheet: 'Sheet1', name: 'Backup' },
      { op: 'add_image', path: picture, left: 240, top: 20, width: 80, height: 80 },
      { op: 'set_hyperlink', cell: 'A1', address: 'https://example.com', text: 'Region' },
      { op: 'add_validation', range: 'B2:B3', formula1: '=B2>0', errorMessage: 'Revenue must be positive' },
      { op: 'protect_sheet', password: 'secret', allowFiltering: true },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 6);
  const packaged = await parts(target);
  assert.equal(packaged.has('xl/worksheets/sheet2.xml'), true);
  assert.equal(packaged.has('xl/media/image1.png'), true);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<hyperlink ref="A1"/);
  assert.match(sheet, /<dataValidation type="custom"/);
  assert.match(sheet, /<sheetProtection password="[0-9A-F]{4}"/);
  assert.match(sheet, /<drawing r:id="/);
  const workbook = await packaged.text('xl/workbook.xml');
  assert.match(workbook, /name="Backup"/);
});

test('portable workbook writes and clears conditional formatting rules', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'rules.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      { op: 'add_conditional_format', range: 'B2:B3', formula: '=B2<100', color: '#9C0006', fillColor: '#FFC7CE' },
      { op: 'add_conditional_format', range: 'A2:A3', formula: '=LEN(A2)>4', fillColor: '#FFEB9C' },
      { op: 'delete_conditional_formats', range: 'A2:A3' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).changed, true);
  const packaged = await parts(target);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<conditionalFormatting sqref="B2:B3">/);
  assert.doesNotMatch(sheet, /sqref="A2:A3"/);
  const styles = await packaged.text('xl/styles.xml');
  assert.match(styles, /<dxfs count="2">/);
  assert.match(styles, /<bgColor rgb="FFFFC7CE"\/>/);
});

test('portable Word adds a table of contents, bookmarks, and comments', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'toc.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'append_text', text: 'Contents', style: 'Heading1' },
      { op: 'insert_toc', lowerHeadingLevel: 1, upperHeadingLevel: 2 },
      { op: 'append_text', text: 'Section one', style: 'Heading1' },
      { op: 'add_bookmark', name: 'section_one', paragraph: 3 },
      { op: 'add_comment', find: 'Section one', text: 'Needs a data point' },
      { op: 'add_provenance', paragraph: 3, source: { document: 'internal model', target: 'Q3' } },
    ],
  }, { cwd }));
  const citation = created.batch.results.find((entry) => entry.op === 'add_provenance');
  assert.equal(citation.citation, 'Source: internal model#Q3');
  const packaged = await parts(target);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /w:instr=" TOC/);
  assert.match(document, /<w:bookmarkStart w:id="1" w:name="section_one"\/>/);
  assert.match(document, /<w:commentRangeStart w:id="1"\/>/);
  const comments = await packaged.text('word/comments.xml');
  assert.match(comments, /Needs a data point/);
  assert.match(comments, /internal model#Q3/);

  const removed = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'delete_comment', comment: 1 }],
  }, { cwd }));
  assert.equal(removed.results[0].changed, true);
  const after = await (await parts(target)).text('word/document.xml');
  assert.doesNotMatch(after, /<w:commentRangeStart w:id="1"\/>/);
});

test('portable slides crop pictures, set transitions, and swap layouts', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'photo.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'motion.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_image', slide: 1, path: picture, left: 60, top: 60, width: 200, height: 200 },
      { op: 'crop_image', slide: 1, shape: 1, left: 10, right: 10 },
      { op: 'set_transition', slide: 1, effect: 'fade', duration: 700 },
      { op: 'set_layout', slide: 1, layout: 'Blank' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 5);
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /<a:srcRect l="10000" t="0" r="10000" b="0"\/>/);
  assert.match(slide, /<p:transition spd="med"><p:fade\/><\/p:transition>/);
});

test('portable workbook notes carry assumptions and provenance', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'notes.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      { op: 'add_note', cell: 'B2', text: 'Assumption: 12% growth' },
      { op: 'add_provenance', cell: 'B2', source: { document: 'internal model', target: 'Q3' } },
      { op: 'add_note', cell: 'B3', text: 'Baseline figure' },
      { op: 'delete_note', cell: 'B3' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).changed, true);
  const packaged = await parts(target);
  const comments = await packaged.text('xl/comments1.xml');
  assert.match(comments, /Assumption: 12% growth/);
  assert.match(comments, /internal model#Q3/);
  assert.doesNotMatch(comments, /Baseline figure/);
  assert.equal(packaged.has('xl/drawings/vmlDrawing1.vml'), true);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<legacyDrawing r:id="/);
});

test('portable slides tune chart axes, labels, footers, and numbering', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'axis.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_chart',
        slide: 1,
        chartType: 'column',
        title: 'Revenue',
        categories: ['Korea', 'Japan'],
        series: [{ name: '2026', values: [120, 95] }],
        left: 58,
        top: 80,
        width: 520,
        height: 300,
      },
      { op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', minimum: 0, maximum: 200, majorUnit: 50, numberFormat: '#,##0', title: 'USD (mm)' },
      { op: 'set_chart_data_labels', slide: 1, shape: 1, showValue: true, position: 'outside_end' },
      { op: 'set_footer', slide: 1, text: 'Mixdog' },
      { op: 'set_slide_number', slide: 1, visible: true },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.every((entry) => entry.changed), true);
  const packaged = await parts(target);
  const chart = await packaged.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:max val="200"\/><c:min val="0"\/>/);
  assert.match(chart, /<c:majorUnit val="50"\/>/);
  assert.match(chart, /USD \(mm\)/);
  assert.match(chart, /<c:dLblPos val="outEnd"\/>/);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<p:ph type="ftr"/);
  assert.match(slide, /type="slidenum"/);
});

test('portable slides group and ungroup shapes', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'group.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_shape', slide: 1, shapeType: 'rectangle', text: 'A', properties: { left: 60, top: 100, width: 120, height: 80 } },
      { op: 'add_shape', slide: 1, shapeType: 'rectangle', text: 'B', properties: { left: 220, top: 100, width: 120, height: 80 } },
      { op: 'group_shapes', slide: 1, shapes: [1, 2] },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).shapes, 2);
  const grouped = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(grouped, /<p:grpSp>/);
  assert.match(grouped, /<a:chOff x="762000" y="1270000"\/>/);

  const ungrouped = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'ungroup_shape', slide: 1, shape: 1 }],
  }, { cwd }));
  assert.equal(ungrouped.results[0].changed, true);
  const flat = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.doesNotMatch(flat, /<p:grpSp>/);
  assert.equal((flat.match(/<p:sp>/g) || []).length, 2);
});

test('portable Word fits tables to the page and resolves tracked revisions', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'revisions.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_table', values: [['Region', 'Revenue'], ['Korea', '120']], properties: { columnWidths: [1000, 600] } },
      { op: 'fit_table', table: 1 },
    ],
  }, { cwd }));
  const fitted = created.batch.results.at(-1);
  assert.equal(fitted.width, 9070);
  const document = await (await parts(target)).text('word/document.xml');
  assert.match(document, /<w:tblW w:w="9070" w:type="dxa"\/>/);
  const widths = [...document.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 9070);
});

test('portable charts carry trendlines and error bars', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'stats.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_chart',
        slide: 1,
        chartType: 'column',
        categories: ['Korea', 'Japan', 'US'],
        series: [{ name: '2026', values: [120, 95, 180] }],
        left: 58,
        top: 80,
        width: 520,
        height: 300,
      },
      { op: 'set_chart_trendline', slide: 1, shape: 1, series: 1, type: 'linear', displayRSquared: true },
      { op: 'set_chart_error_bars', slide: 1, shape: 1, series: 1, amount: 12, direction: 'y' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).changed, true);
  const chart = await (await parts(target)).text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:trendlineType val="linear"\/>/);
  assert.match(chart, /<c:dispRSqr val="1"\/>/);
  assert.match(chart, /<c:errBars><c:errDir val="y"\/>/);
  assert.match(chart, /<c:val val="12"\/>/);
  assert.ok(chart.indexOf('<c:errBars>') < chart.indexOf('<c:cat>'), 'error bars precede the category axis data');

  const revised = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_chart_series', slide: 1, shape: 1, series: 1, name: '2027', values: [150, 130, 210] }],
  }, { cwd }));
  assert.equal(revised.results[0].changed, true);
  const updated = await (await parts(target)).text('ppt/charts/chart1.xml');
  assert.match(updated, /<c:v>2027<\/c:v>/);
  assert.match(updated, /<c:v>210<\/c:v>/);
  assert.doesNotMatch(updated, /<c:v>180<\/c:v>/);
});

test('portable compose_document applies page setup, spacing, lists, and page numbers', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'brief.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [{
      op: 'compose_document',
      title: '분기 운영 리뷰',
      subtitle: 'portable 품질 점검',
      footer: 'Mixdog',
      pageNumbers: true,
      sections: [
        { heading: '결정', body: ['페이지 설정과 머리글을 적용한다.'], bullets: ['커버리지 확대'] },
        { heading: '근거', table: [['지표', '이전'], ['오퍼레이션', '15']] },
      ],
    }],
  }, { cwd }));
  const applied = created.batch.results.map((entry) => entry.op);
  assert.ok(applied.includes('set_page'), 'portable composition must set the page');
  assert.ok(applied.includes('fit_table'), 'portable composition must fit tables');
  assert.ok(applied.includes('add_page_numbers'), 'portable composition must add page numbers');
  const packaged = await parts(target);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /<w:pStyle w:val="Heading1"\/>/, 'style names normalize to Word style ids');
  assert.match(document, /<w:numPr>/, 'bullets become real list paragraphs');
  const spacing = /<w:spacing[^>]*w:line="(\d+)"/.exec(document);
  assert.ok(spacing && Number(spacing[1]) >= 200, `line spacing must be twips, saw ${spacing?.[1]}`);
  const margins = /<w:pgMar[^>]*w:top="(\d+)"/.exec(document);
  assert.ok(margins && Number(margins[1]) >= 720, `page margins must be twips, saw ${margins?.[1]}`);
});

test('portable slides report low-contrast text', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'contrast.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_shape',
        slide: 1,
        shapeType: 'rectangle',
        text: 'Hard to read',
        properties: { left: 60, top: 60, width: 400, height: 120, fillColor: 'F4F6F8', color: 'E7E9EC', fontSize: 14 },
      },
      {
        op: 'add_shape',
        slide: 1,
        shapeType: 'rectangle',
        text: 'Readable',
        properties: { left: 60, top: 220, width: 400, height: 120, fillColor: '1B4965', color: 'FFFFFF', fontSize: 14 },
      },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 3);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const contrast = (issues.issues || []).filter((entry) => entry.code === 'low_contrast');
  assert.equal(contrast.length, 1, 'only the faint shape is reported');
  assert.match(contrast[0].path, /shape\[1\]$/);
  assert.ok(contrast[0].ratio < 4.5);
});

test('portable workbook flags percentages stored as whole numbers', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'percent.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_range', range: 'A1:B3', values: [['Region', 'Share'], ['Korea', 42], ['Japan', 0.33]] },
      { op: 'set_style', range: 'B2:B3', properties: { numberFormat: '0.0%' } },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 2);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const scaled = (issues.issues || []).filter((entry) => entry.code === 'percent_stored_as_whole');
  assert.equal(scaled.length, 1, 'only the whole-number percentage is reported');
  assert.match(scaled[0].path, /cell\[B2\]$/);
});

test('portable workbook audits column fit and formula consistency', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'audit.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 1234567890123 },
      { op: 'set_style', cell: 'A1', properties: { numberFormat: '$#,##0' } },
      { op: 'set_range', range: 'A3:E3', values: [[1, 2, 3, 4, 5]] },
      { op: 'set_formula', cell: 'A4', formula: '=A3*2' },
      { op: 'set_formula', cell: 'B4', formula: '=B3*2' },
      { op: 'set_cell', cell: 'C4', value: 99 },
      { op: 'set_formula', cell: 'D4', formula: '=D3*2' },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 7);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const narrow = (issues.issues || []).filter((entry) => entry.code === 'column_too_narrow');
  assert.equal(narrow.length, 1);
  assert.match(narrow[0].path, /cell\[A1\]$/);
  const inconsistent = (issues.issues || []).filter((entry) => entry.code === 'formula_inconsistency');
  assert.equal(inconsistent.length, 1, 'the lone hardcoded cell mid-row is reported');
  assert.match(inconsistent[0].path, /cell\[C4\]$/);
});

test('portable Word records and resolves tracked revisions', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'contract.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'append_text', text: 'Original clause one.' },
      { op: 'append_text', text: 'Original clause two.' },
      { op: 'track_changes', enabled: true },
      { op: 'append_text', text: 'Proposed clause three.' },
      { op: 'remove_paragraph', paragraph: 2 },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.find((entry) => entry.tracked === true).op, 'append_text');
  const packaged = await parts(target);
  assert.match(await packaged.text('word/settings.xml'), /<w:trackRevisions\/>/);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /<w:ins w:id="\d+" w:author="Mixdog"/);
  assert.match(document, /<w:delText/);
  assert.match(document, /Proposed clause three/);
  assert.match(document, /Original clause two/, 'deleted text stays until the revision is accepted');

  const accepted = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
  }, { cwd }));
  assert.equal(accepted.results[0].resolved, 2);
  const resolved = await (await parts(target)).text('word/document.xml');
  assert.doesNotMatch(resolved, /<w:ins /);
  assert.doesNotMatch(resolved, /Original clause two/, 'accepting the deletion removes the text');
  assert.match(resolved, /Proposed clause three/);
});

test('portable Word threads comment replies and resolution', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'review.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'append_text', text: 'The fee cap is too low.' },
      { op: 'add_comment', find: 'fee cap', text: 'Raise this to 5%.', author: 'Reviewer' },
      { op: 'add_comment_reply', comment: 1, text: 'Agreed, updating.', author: 'Owner' },
      { op: 'set_comment_resolved', comment: 1, resolved: true },
    ],
  }, { cwd }));
  const reply = created.batch.results.find((entry) => entry.op === 'add_comment_reply');
  assert.equal(reply.parent, 1);
  assert.equal(reply.comment, 2);
  const packaged = await parts(target);
  const comments = await packaged.text('word/comments.xml');
  assert.match(comments, /Raise this to 5%/);
  assert.match(comments, /Agreed, updating/);
  assert.match(comments, /w14:paraId="10000001"/);
  const threads = await packaged.text('word/commentsExtended.xml');
  assert.match(threads, /w15:paraId="10000002" w15:paraIdParent="10000001"/);
  assert.match(threads, /w15:paraId="10000001" w15:done="1"/);
});

test('portable slides carry review comments', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'review.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_comment', slide: 1, text: 'Tighten this headline.', author: 'Reviewer', initials: 'RV' },
      { op: 'add_comment', slide: 1, text: 'Second note.', author: 'Owner' },
      { op: 'delete_comment', slide: 1, comment: 2 },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).comment, 2);
  const packaged = await parts(target);
  const comments = await packaged.text('ppt/comments/comment1.xml');
  assert.match(comments, /Tighten this headline/);
  assert.doesNotMatch(comments, /Second note/);
  const authors = await packaged.text('ppt/commentAuthors.xml');
  assert.match(authors, /name="Reviewer" initials="RV"/);
  assert.match(authors, /name="Owner"/);
});

test('portable Word refuses to pass a document whose content never landed', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'hollow.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [{ op: 'set_page', properties: { orientation: 'landscape' } }],
  }, { cwd }));
  const empty = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const blocking = (empty.issues || []).filter((issue) => issue.code === 'empty_document');
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, 'error');

  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'append_text', text: 'Latency review' }],
  }, { cwd }));
  const filled = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal((filled.issues || []).some((issue) => issue.code === 'empty_document'), false);
});

test('portable Word measures table columns in points and keeps borders through fit_table', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'grid.docx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_page', properties: { orientation: 'portrait', leftMargin: 72, rightMargin: 72, topMargin: 72, bottomMargin: 72 } },
      {
        op: 'add_table',
        values: [['Metric', 'Baseline'], ['Latency', '120ms']],
        properties: { columnWidths: [300, 200], borders: { style: 'single', color: '808080', size: 4 } },
      },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 2);
  const wide = await (await parts(target)).text('word/document.xml');
  assert.match(wide, /<w:gridCol w:w="6000"\/><w:gridCol w:w="4000"\/>/, 'point widths convert to twips');
  const flagged = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    (flagged.issues || []).some((issue) => issue.code === 'table_wider_than_page'),
    true,
    '500pt of columns overflow the 6.27in text column',
  );

  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'fit_table', table: 1 }],
  }, { cwd }));
  const fitted = await (await parts(target)).text('word/document.xml');
  const properties = /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(fitted)?.[0] || '';
  assert.match(properties, /<w:tblW w:w="9026" w:type="dxa"\/>/);
  assert.match(properties, /<w:tblBorders>[\s\S]*w:color="808080"/, 'fit_table preserves declared borders');
  const clean = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal((clean.issues || []).some((issue) => issue.code === 'table_wider_than_page'), false);

  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'merge_table_cells', table: 1, row: 2, col: 1, colSpan: 2 },
      { op: 'fit_table', table: 1 },
    ],
  }, { cwd }));
  const merged = await (await parts(target)).text('word/document.xml');
  assert.match(merged, /<w:gridSpan w:val="2"\/>/, 'fit_table keeps merged cells merged');
  const spanned = /<w:tcPr><w:tcW w:w="(\d+)" w:type="dxa"\/><w:gridSpan/.exec(merged);
  assert.equal(Number(spanned[1]), 9026, 'the merged cell spans both column widths');
});

test('portable slides build an entrance animation timeline', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'anim.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_textbox', slide: 1, text: 'First', properties: { left: 60, top: 60, width: 300, height: 60 } },
      { op: 'add_textbox', slide: 1, text: 'Second', properties: { left: 60, top: 200, width: 300, height: 60 } },
      { op: 'add_animation', slide: 1, shape: 1, effect: 'fade', trigger: 'onclick', duration: 0.75 },
      { op: 'add_animation', slide: 1, shape: 2, effect: 'wipe', trigger: 'afterprevious', delay: 0.25 },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.at(-1).effect, 'wipe');

  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.equal((slide.match(/<p:timing>/g) || []).length, 1, 'one timing tree per slide');
  assert.match(slide, /nodeType="mainSeq"/);
  assert.match(slide, /presetID="10"[^>]*nodeType="clickEffect"/);
  assert.match(slide, /presetID="22"[^>]*nodeType="afterEffect"/);
  assert.match(slide, /<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="\d+" dur="750"\/>/);
  assert.match(slide, /<p:cond delay="250"\/>/);
  const clickEffect = slide.indexOf('nodeType="clickEffect"');
  const afterEffect = slide.indexOf('nodeType="afterEffect"');
  const groupClose = slide.indexOf('</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>', clickEffect);
  assert.equal(afterEffect < groupClose, true, 'the follow-up effect stays a sibling inside the same click group');

  await assert.rejects(
    executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{ op: 'add_animation', slide: 1, shape: 1, effect: 'explode' }],
    }, { cwd }).then((result) => {
      if (result?.isError) throw new Error(result.content[0].text);
      return result;
    }),
    /effect must be one of/,
  );
});

test('portable slides flag table cells whose text cannot fit the row', async (t) => {
  const cwd = await workspace(t);
  const outcomes = [];
  for (const [label, values] of [
    ['short', [['Metric', 'Value'], ['Latency', '120ms']]],
    ['long', [['Metric', 'Value'], ['Rolling ninety-fifth percentile request latency measured across every production region and edge node', '120ms']]],
  ]) {
    const created = value(await executeOfficeTool({
      action: 'create',
      path: join(cwd, `${label}.pptx`),
      mode: 'portable',
      operations: [
        { op: 'add_slide' },
        { op: 'add_table', slide: 1, values, left: 40, top: 40, width: 320, height: 90 },
      ],
    }, { cwd }));
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    outcomes.push((issues.issues || []).filter((issue) => issue.code === 'table_cell_overflow'));
  }
  assert.equal(outcomes[0].length, 0, 'short cell text stays clean');
  assert.equal(outcomes[1].length, 1);
  assert.equal(outcomes[1][0].path, '/slide[1]/table[1]/row[2]/cell[1]');
});

test('portable slides flag stretched images but pass proportional ones', async (t) => {
  const cwd = await workspace(t);
  const square = join(cwd, 'square.png');
  await writeFile(square, PNG_PIXEL);
  const outcomes = [];
  for (const [label, size] of [
    ['proportional', { width: 200, height: 200 }],
    ['stretched', { width: 300, height: 100 }],
    ['contained', { width: 300, height: 100, fit: 'contain' }],
    ['covered', { width: 300, height: 100, fit: 'cover' }],
  ]) {
    const created = value(await executeOfficeTool({
      action: 'create',
      path: join(cwd, `${label}.pptx`),
      mode: 'portable',
      operations: [
        { op: 'add_slide' },
        { op: 'add_image', slide: 1, path: square, left: 40, top: 40, ...size },
      ],
    }, { cwd }));
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    outcomes.push((issues.issues || []).filter((issue) => issue.code === 'image_aspect_distorted'));
  }
  assert.equal(outcomes[0].length, 0, 'a square image placed square stays clean');
  assert.equal(outcomes[1].length, 1);
  assert.equal(outcomes[1][0].severity, 'warning');
  assert.match(outcomes[1][0].path, /^\/slide\[1\]\/picture\[1\]$/);
  assert.equal(outcomes[2].length, 0, 'contain preserves the whole image without stretching');
  assert.equal(outcomes[3].length, 0, 'cover crops the image without stretching');
});

test('portable slides number shapes the same way for snapshot and set_text', async (t) => {
  const cwd = await workspace(t);
  const created = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'group.pptx'),
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_textbox', slide: 1, text: 'first', properties: { left: 40, top: 40, width: 200, height: 40 } },
      { op: 'add_textbox', slide: 1, text: 'grouped A', properties: { left: 40, top: 120, width: 200, height: 40 } },
      { op: 'add_textbox', slide: 1, text: 'grouped B', properties: { left: 40, top: 180, width: 200, height: 40 } },
      { op: 'add_textbox', slide: 1, text: 'last', properties: { left: 40, top: 260, width: 200, height: 40 } },
      { op: 'group_shapes', slide: 1, shapes: [2, 3] },
    ],
  }, { cwd }));
  const before = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const names = before.document.slides[0].shapes.map((shape) => String(shape.text || ''));
  assert.equal(names.length, 3, 'the group counts as one shape, not two');

  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_text', slide: 1, shape: 2, text: 'SECOND EDITED' }],
  }, { cwd }));
  const after = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(
    String(after.document.slides[0].shapes[1].text || ''),
    'SECOND EDITED',
    'set_text targets the same shape index the snapshot reports',
  );
});

test('portable slide snapshots keep deck order and report evidence shapes', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'evidence.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_textbox',
        slide: 1,
        text: 'Cover',
        properties: { left: 40, top: 40, width: 400, height: 80, fontSize: 44 },
      },
      { op: 'add_slide' },
      {
        op: 'add_table',
        slide: 2,
        values: [['Region', 'Revenue'], ['Korea', '120']],
        left: 40,
        top: 40,
        width: 400,
        height: 120,
      },
    ],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.slides.map((slide) => slide.index),
    [1, 2],
    'slides report in deck order, matching the Microsoft Office snapshot',
  );
  const cover = snapshot.document.slides[0].shapes.find((shape) => shape.text === 'Cover');
  assert.equal(cover.font.size, 44, 'the type scale must reach the design review');
  const table = snapshot.document.slides[1].shapes.find((shape) => shape.table);
  assert.equal(table.table.rows, 2);
  assert.equal(table.table.columns, 2);
});

test('portable snapshots satisfy the shared backend contract', async (t) => {
  const cwd = await workspace(t);
  const cases = [
    {
      format: 'docx',
      file: 'contract.docx',
      operations: [
        { op: 'append_text', text: 'Heading one', style: 'Heading1' },
        { op: 'append_text', text: 'Body paragraph.' },
        { op: 'add_table', values: [['A', 'B'], ['1', '2']] },
      ],
    },
    {
      format: 'xlsx',
      file: 'contract.xlsx',
      operations: [
        { op: 'set_range', range: 'A1:B3', values: [['Region', 'Revenue'], ['Korea', 120], ['Japan', 95]] },
      ],
    },
    {
      format: 'pptx',
      file: 'contract.pptx',
      operations: [
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 1, color: '16191D' },
        { op: 'add_textbox', slide: 1, text: 'Title', properties: { left: 40, top: 40, width: 400, height: 60, fontSize: 40 } },
        { op: 'set_notes', slide: 1, text: 'Speaker note.' },
        { op: 'add_slide' },
        { op: 'add_table', slide: 2, values: [['A', 'B'], ['1', '2']], left: 40, top: 40, width: 300, height: 90 },
      ],
    },
  ];
  for (const testCase of cases) {
    const target = join(cwd, testCase.file);
    const created = value(await executeOfficeTool({
      action: 'create',
      path: target,
      mode: 'portable',
      operations: testCase.operations,
    }, { cwd }));
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
    const violations = officeSnapshotContractViolations(snapshot.document, {
      format: testCase.format,
      paged: true,
    });
    assert.deepEqual(
      violations,
      [],
      `${testCase.format} snapshot breaks the backend contract:\n${describeOfficeSnapshotViolations(violations)}`,
    );
  }
});

test('portable Word reads and edits tables that contain a nested table', async (t) => {
  const cwd = await workspace(t);
  const cell = (text, extra = '') => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${extra}`
    + `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const inner = '<w:tbl><w:tblPr><w:tblW w:w="1000" w:type="dxa"/></w:tblPr>'
    + `<w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr>${cell('inner')}</w:tr></w:tbl>`;
  const outer = '<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
    + `<w:tr>${cell('outer A')}${cell('outer B', inner)}</w:tr>`
    + `<w:tr>${cell('row2 A')}${cell('row2 B')}</w:tr></w:tbl>`;
  const second = '<w:tbl><w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr>'
    + `<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell('second')}</w:tr></w:tbl>`;
  const source = join(cwd, 'nested.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p>${outer}${second}<w:sectPr/></w:body></w:document>`,
  });

  const opened = value(await executeOfficeTool({
    action: 'open', path: source, output: join(cwd, 'nested-out.docx'), mode: 'portable',
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.tables.length, 2, 'the nested table is not counted as a sibling');
  assert.equal(snapshot.document.tables[0].rows.length, 2, 'the outer table keeps both rows');
  assert.equal(snapshot.document.tables[1].rows[0].cells[0].text, 'second');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_table_cell', table: 1, row: 2, col: 1, text: 'row2 edited' },
      { op: 'insert_table_column', table: 1, column: 2 },
    ],
  }, { cwd }));
  const edited = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(edited.document.tables[0].rows[1].cells[0].text, 'row2 edited');
  assert.equal(edited.document.tables[0].rows[0].cells.length, 3, 'the outer row gained a column');
  const document = await (await parts(join(cwd, 'nested-out.docx'))).text('word/document.xml');
  assert.match(document, /<w:t>inner<\/w:t>/, 'the nested table survives structural edits');
});

test('portable workbooks read cells that follow a style-only cell', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'styled.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Latency model' },
      { op: 'set_style', range: 'A1:C1', properties: { bold: true, fillColor: '183028' } },
      { op: 'set_range', range: 'A3:C4', values: [['Region', 'Product', 'Revenue'], ['Korea', 'Alpha', 120]] },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 3);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [
    cell.path.replace(/^.*\[/, '').replace(/\]$/, ''),
    cell.value,
  ]));
  assert.equal(cells.get('A1'), 'Latency model');
  assert.equal(cells.get('A3'), 'Region', 'the header after the style-only B1/C1 cells survives the read');
  assert.equal(cells.get('B3'), 'Product');
  assert.equal(cells.get('C3'), 'Revenue');
  assert.equal(cells.get('A4'), 'Korea');
});

test('portable workbook audits see cells that follow a style-only cell', async (t) => {
  const cwd = await workspace(t);
  const created = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'audit.xlsx'),
    mode: 'portable',
    operations: [
      { op: 'set_cell', cell: 'A1', value: 'Audit' },
      { op: 'set_style', range: 'A1:D1', properties: { bold: true, fillColor: '183028' } },
      { op: 'set_cell', cell: 'A4', value: 42 },
      { op: 'set_style', cell: 'A4', properties: { numberFormat: '0.0%' } },
      { op: 'set_cell', cell: 'B4', value: 123456789012 },
      { op: 'set_formula', cell: 'A6', formula: '=1+1' },
      { op: 'set_formula', cell: 'B6', formula: '=2+2' },
      { op: 'set_formula', cell: 'C6', formula: '=3+3' },
      { op: 'set_cell', cell: 'D6', value: 99 },
    ],
  }, { cwd }));
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const codes = new Map((issues.issues || []).map((issue) => [issue.code, issue.path]));
  assert.equal(codes.get('percent_stored_as_whole'), '/sheet[Sheet1]/cell[A4]');
  assert.equal(codes.get('column_too_narrow'), '/sheet[Sheet1]/cell[B4]');
  assert.equal(codes.get('formula_inconsistency'), '/sheet[Sheet1]/cell[D6]');
});

test('portable workbooks build a refreshable pivot table', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'pivot.xlsx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      {
        op: 'set_range',
        range: 'A1:C5',
        values: [
          ['Region', 'Product', 'Revenue'],
          ['Korea', 'Alpha', 120],
          ['Korea', 'Beta', 80],
          ['Japan', 'Alpha', 150],
          ['Japan', 'Beta', 60],
        ],
      },
      { op: 'add_sheet', name: 'Pivot' },
      {
        op: 'add_pivot_table',
        sheet: 'Sheet1',
        source: 'A1:C5',
        destination: 'A3',
        destinationSheet: 'Pivot',
        name: 'RevenueByRegion',
        rows: ['Region'],
        columns: ['Product'],
        values: ['Revenue'],
      },
    ],
  }, { cwd }));
  const summary = created.batch.results.at(-1);
  assert.equal(summary.name, 'RevenueByRegion');
  assert.equal(summary.rows, 4);

  const packaged = await parts(target);
  assert.equal(packaged.has('xl/pivotCache/pivotCacheDefinition1.xml'), true);
  assert.equal(packaged.has('xl/pivotCache/pivotCacheRecords1.xml'), true);
  assert.equal(packaged.has('xl/pivotTables/pivotTable1.xml'), true);

  const definition = await packaged.text('xl/pivotCache/pivotCacheDefinition1.xml');
  assert.match(definition, /<worksheetSource ref="A1:C5" sheet="Sheet1"\/>/);
  assert.match(definition, /refreshOnLoad="1"/);
  assert.match(definition, /<sharedItems count="2"><s v="Korea"\/><s v="Japan"\/><\/sharedItems>/);
  assert.match(definition, /containsNumber="1"[^>]*minValue="60" maxValue="150"/);

  const records = await packaged.text('xl/pivotCache/pivotCacheRecords1.xml');
  assert.match(records, /<r><x v="0"\/><x v="0"\/><n v="120"\/><\/r>/);
  assert.equal((records.match(/<r>/g) || []).length, 4);

  const table = await packaged.text('xl/pivotTables/pivotTable1.xml');
  assert.match(table, /<location ref="A3:D7" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"\/>/);
  assert.match(table, /<pivotField axis="axisRow"[^>]*><items count="3"><item x="1"\/><item x="0"\/>/, 'row items follow display order');
  assert.match(table, /<dataField name="Sum of Revenue" fld="2"/);
  assert.match(table, /<rowItems count="3">[\s\S]*<i t="grand">/);

  const workbook = await packaged.text('xl/workbook.xml');
  assert.match(workbook, /<pivotCaches><pivotCache cacheId="1" r:id="rId\d+"\/><\/pivotCaches>/);

  await assert.rejects(
    executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{
        op: 'add_pivot_table',
        sheet: 'Sheet1',
        source: 'A1:C5',
        destination: 'F3',
        rows: ['Region', 'Product'],
        values: ['Revenue'],
      }],
    }, { cwd }).then((result) => {
      if (result?.isError) throw new Error(result.content[0].text);
      return result;
    }),
    /one row field and one column field/,
  );
});

test('portable slides embed media and swap the theme', async (t) => {
  const cwd = await workspace(t);
  const poster = join(cwd, 'poster.png');
  const clip = join(cwd, 'clip.mp4');
  await writeFile(poster, PNG_PIXEL);
  await writeFile(clip, Buffer.from('00000018667479706d70343200000000', 'hex'));
  const target = join(cwd, 'media.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_media', slide: 1, path: clip, kind: 'video', poster, left: 60, top: 60, width: 320, height: 180 },
      { op: 'apply_theme', path: 'src/runtime/office/templates/mixdog-executive.pptx' },
    ],
  }, { cwd: process.cwd() }));
  assert.equal(created.batch.results.at(-1).applied.length >= 1, true);
  const packaged = await parts(target);
  assert.equal(packaged.has('ppt/media/media1.mp4'), true);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<a:videoFile[^>]*r:link="rId\d+"/);
  assert.match(slide, /action="ppaction:\/\/media"/);
  const theme = await packaged.text('ppt/theme/theme1.xml');
  assert.match(theme, /Georgia|Arial/, 'the bundled brand theme replaced the default');
});

test('portable slides report shapes that crowd each other', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'spacing.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_textbox', slide: 1, text: 'Left block', properties: { left: 60, top: 100, width: 200, height: 80, fontSize: 14 } },
      { op: 'add_textbox', slide: 1, text: 'Right block', properties: { left: 268, top: 100, width: 200, height: 80, fontSize: 14 } },
      { op: 'add_textbox', slide: 1, text: 'Far block', properties: { left: 600, top: 100, width: 200, height: 80, fontSize: 14 } },
    ],
  }, { cwd }));
  assert.equal(created.batch.results.length, 4);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const crowded = (issues.issues || []).filter((entry) => entry.code === 'shapes_too_close');
  assert.equal(crowded.length, 1, 'only the 8pt gap is reported');
  assert.equal(crowded[0].gap, 8);
});

test('portable issues flag leftover template placeholder text', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'placeholder.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_textbox',
        slide: 1,
        text: 'Lorem ipsum dolor sit amet',
        properties: { left: 40, top: 40, width: 600, height: 120, fontSize: 18 },
      },
      {
        op: 'add_textbox',
        slide: 1,
        text: 'Owner: {{owner}}',
        properties: { left: 40, top: 200, width: 600, height: 60, fontSize: 18 },
      },
    ],
  }, { cwd }));
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const codes = (issues.issues || []).map((entry) => entry.code);
  assert.ok(codes.includes('placeholder_text'), 'lorem ipsum must be reported');
  assert.ok(codes.includes('unfilled_token'), 'an unresolved token must be reported');
});

test('portable image replacement removes the orphaned media part', async (t) => {
  const cwd = await workspace(t);
  const first = join(cwd, 'first.png');
  const second = join(cwd, 'second.png');
  await writeFile(first, PNG_PIXEL);
  await writeFile(second, Buffer.concat([PNG_PIXEL, Buffer.from([0])]));
  const target = join(cwd, 'media.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    operations: [
      { op: 'add_slide' },
      { op: 'add_image', slide: 1, path: first, left: 40, top: 40, width: 120, height: 120 },
    ],
  }, { cwd }));
  assert.equal((await parts(target)).has('ppt/media/image1.png'), true);
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'replace_image', slide: 1, shape: 1, path: second }],
  }, { cwd }));
  const packaged = await parts(target);
  assert.equal(packaged.has('ppt/media/image2.png'), true);
  assert.equal(packaged.has('ppt/media/image1.png'), false, 'the replaced media part must be cleaned up');
});

test('portable table slides use an explicitly requested bundled layout without leftover rows', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'table-layout.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    design: { profile: 'editorial', deck: { templateMode: 'prefer' } },
    operations: [{
      op: 'compose_slide',
      kind: 'table',
      title: '지원 범위',
      table: [['영역', 'COM', 'portable'], ['생성', '지원', '지원'], ['차트', '지원', '지원']],
    }],
  }, { cwd }));
  const modes = (created.batch?.semanticOperations || []).map((entry) => entry.renderMode);
  assert.deepEqual(modes, ['native-template']);
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /지원 범위/);
  assert.match(slide, /차트/);
  assert.doesNotMatch(slide, /Adoption/, 'unused template rows must be removed');
});

test('portable decks use the bundled template only after explicit opt-in and keep its typography', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'branded.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
    design: { profile: 'editorial', deck: { templateMode: 'prefer' } },
    operations: [
      { op: 'compose_slide', kind: 'cover', title: '표지 제목', subtitle: '부제' },
      { op: 'compose_slide', kind: 'metrics', title: '지표', metrics: [{ label: '포맷', value: '3' }] },
    ],
  }, { cwd }));
  const rendered = (created.batch?.semanticOperations || []).map((entry) => entry.renderMode);
  assert.ok(rendered.includes('native-template'), `template layouts must drive portable decks, saw ${rendered.join(', ')}`);
  const packaged = await parts(target);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /typeface="/);
  assert.match(slide, /표지 제목/);
  assert.equal(packaged.has('ppt/slideMasters/slideMaster1.xml'), true);
});

test('portable text metrics flag overflow and fit_text repairs it', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'overflow.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_textbox',
        slide: 1,
        text: '오버플로를 유발하기 위해 충분히 긴 문장을 반복해서 넣습니다. '.repeat(6),
        properties: { left: 40, top: 40, width: 200, height: 40, fontSize: 24 },
      },
    ],
  }, { cwd }));
  const before = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const overflow = (before.issues || []).filter((entry) => entry.code === 'text_overflow');
  assert.equal(overflow.length, 1, 'an overflowing text box must be reported');
  assert.match(overflow[0].path, /^\/slide\[1\]\/shape\[1\]$/);

  const fitted = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'fit_text', slide: 1, shape: 1, minFontSize: 6 }],
  }, { cwd }));
  assert.equal(fitted.results[0].changed, true);
  assert.ok(fitted.results[0].scale < 1, 'fit_text must shrink the run size');
  const after = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal((after.issues || []).filter((entry) => entry.code === 'text_overflow').length, 0);
});

test('portable set_table_data rewrites an existing table in place', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'table.pptx');
  const created = value(await executeOfficeTool({
    action: 'create',
    path: target,
    mode: 'portable',
  }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'add_slide' },
      {
        op: 'add_table',
        slide: 1,
        values: [['Region', 'Revenue'], ['Korea', '120']],
        left: 58,
        top: 100,
        width: 480,
        height: 120,
      },
      {
        op: 'set_table_data',
        slide: 1,
        shape: 1,
        values: [['지역', '매출'], ['일본', '95']],
      },
    ],
  }, { cwd }));
  const replaced = batch.results.at(-1);
  assert.equal(replaced.changed, true);
  assert.equal(replaced.rows, 2);
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /지역/);
  assert.match(slide, /일본/);
  assert.doesNotMatch(slide, /Korea/);
});
