import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeOfficeCapabilities } from './capabilities.mjs';
import { expandOfficeDesignOperations } from './design/design-system.mjs';
import { executeOfficeTool } from './index.mjs';
import { applyPortableOoxmlBatch } from './portable/portable-ooxml.mjs';
import { createPortableOoxmlDocument } from './portable/portable-package.mjs';
import { describeOfficeSnapshotViolations, officeSnapshotContractViolations } from './core/snapshot-contract.mjs';
import { PNG_PIXEL, parts, value, workspace, writeZip } from './office-test-support.mjs';
import { contrastRatio } from './portable/text-metrics.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('portable create produces openable Word, Excel, and PowerPoint packages', async (t) => {
  const cwd = await workspace(t);
  const expected = {
    docx: ['word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'],
    xlsx: ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'],
    pptx: [
      'ppt/presentation.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
    ],
  };
  for (const [fileKind, required] of Object.entries(expected)) {
    const target = join(cwd, `created.${fileKind}`);
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: target,
          mode: 'portable',
        },
        { cwd }
      )
    );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
      },
      { cwd }
    )
  );
  const batch = value(
    await executeOfficeTool(
      {
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
          {
            op: 'set_range',
            range: 'A3:C4',
            values: [
              ['Region', 'Revenue', 'Share'],
              ['Korea', 120, 0.42],
            ],
          },
          { op: 'set_style', cell: 'C4', properties: { numberFormat: '0.0%' } },
          { op: 'freeze_panes', row: 4, column: 1 },
          { op: 'autofit_range', range: 'A:C' },
          { op: 'set_sheet_view', showGridlines: false, zoom: 90 },
          {
            op: 'set_page_setup',
            printArea: 'A1:C4',
            orientation: 'landscape',
            fitToPagesWide: 1,
            centerHorizontally: true,
          },
          { op: 'add_sheet', name: 'Appendix' },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
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
            values: [
              ['Region', 'Revenue'],
              ['Korea', '120'],
            ],
            left: 58,
            top: 100,
            width: 520,
            height: 120,
            properties: { headerFillColor: '1B4965', headerColor: 'FFFFFF' },
          },
          { op: 'set_notes', slide: 2, text: 'Revenue by region.' },
        ],
      },
      { cwd }
    )
  );
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
  assert.match(await packaged.text('[Content_Types].xml'), new RegExp(`PartName="/ppt/theme/${notesTheme}"`));

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'move_slide', slide: 2, index: 1 }],
      },
      { cwd }
    )
  );
  const reordered = await parts(target);
  const presentation = await reordered.text('ppt/presentation.xml');
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="(rId\d+)"/g)].map((match) => match[1]);
  const rels = await reordered.text('ppt/_rels/presentation.xml.rels');
  const targets = order.map((id) => new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]);
  // Parts are renumbered to their positions after a structural edit: the table
  // slide that moved to the front is now slide1.xml, and the notes it carries
  // still point back at it.
  assert.deepEqual(targets, ['slides/slide1.xml', 'slides/slide2.xml']);
  assert.match(await reordered.text('ppt/slides/slide1.xml'), /<a:tbl\b/);
  assert.doesNotMatch(await reordered.text('ppt/slides/slide2.xml'), /<a:tbl\b/);
  const movedRels = await reordered.text('ppt/slides/_rels/slide1.xml.rels');
  const movedNotes = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(movedRels)?.[1];
  assert.ok(movedNotes, movedRels);
  assert.match(await reordered.text(`ppt/notesSlides/_rels/${movedNotes}.rels`), /Target="\.\.\/slides\/slide1\.xml"/);
});

test('portable composition stays inside the portable operation catalog', () => {
  const supported = {
    xlsx: new Set(describeOfficeCapabilities({ format: 'xlsx', backend: 'mixdog-ooxml' }).operations),
    docx: new Set(describeOfficeCapabilities({ format: 'docx', backend: 'mixdog-ooxml' }).operations),
  };
  const composed = {
    xlsx: [
      {
        op: 'compose_sheet',
        title: 'Regional revenue',
        headers: ['Region', 'Revenue'],
        rows: [['Korea', 120]],
        metrics: [{ label: 'Revenue', value: 120 }],
        source: { document: 'internal model' },
      },
    ],
    docx: [
      {
        op: 'compose_document',
        title: 'Portable authoring',
        sections: [{ heading: 'Decision', body: ['Ship it.'] }],
      },
    ],
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
    operations: [
      {
        op: 'compose_sheet',
        headers: ['Region', 'Revenue'],
        rows: [
          ['Korea', 120],
          ['Japan', 95],
        ],
        chart: { type: 'column' },
      },
    ],
    created: true,
  });
  assert.ok(sheet.operations.some((entry) => entry.op === 'add_chart'));
});

test('portable charts write a chart part with an embedded workbook', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'chart.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
            series: [
              {
                name: '2026',
                values: [120, 95],
                color: '1B4965',
                pointColors: ['1B4965', '2D66D5'],
              },
            ],
            left: 58,
            top: 90,
            width: 520,
            height: 300,
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).changed, true);
  const packaged = await parts(deck);
  const chart = await packaged.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:barChart>/);
  assert.match(chart, /<c:v>120<\/c:v>/);
  assert.match(chart, /srgbClr val="1B4965"/);
  assert.match(chart, /<c:dPt><c:idx val="1"\/><c:spPr><a:solidFill><a:srgbClr val="2D66D5"/);
  assert.equal(packaged.has('ppt/embeddings/chartData1.xlsx'), true);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<p:graphicFrame>/);

  const updated = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            series: [{ name: '2027', values: [180, 140] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(updated.results[0].changed, true);
  const revised = await (await parts(deck)).text('ppt/charts/chart1.xml');
  assert.match(revised, /<c:v>180<\/c:v>/);
  assert.doesNotMatch(revised, /<c:v>120<\/c:v>/);
  // New numbers are a refresh, not a redesign: the emphasized point survives it.
  assert.match(revised, /<c:dPt><c:idx val="1"\/><c:spPr><a:solidFill><a:srgbClr val="2D66D5"/);
  assert.ok(updated.results[0].preserved.includes('pointColors'), JSON.stringify(updated.results[0]));

  // A duplicated page owns its chart: an edit on the copy leaves the source page
  // as it was approved, and the copy keeps the axis the chart was drawn with.
  const copied = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', minimum: 100, maximum: 200 },
          { op: 'duplicate_slide', slide: 1 },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(copied.results.at(-1).ownParts, ['ppt/charts/chart2.xml']);
  const refreshed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_chart_data', slide: 2, shape: 1, series: [{ name: '2028', values: [150, 160] }] }],
      },
      { cwd }
    )
  );
  assert.equal(refreshed.results[0].chart, 'ppt/charts/chart2.xml');
  assert.ok(refreshed.results[0].preserved.includes('axis'));
  const bothCharts = await parts(deck);
  const source = await bothCharts.text('ppt/charts/chart1.xml');
  const copy = await bothCharts.text('ppt/charts/chart2.xml');
  assert.match(source, /<c:v>180<\/c:v>/);
  assert.doesNotMatch(source, /<c:v>150<\/c:v>/);
  assert.match(copy, /<c:v>150<\/c:v>/);
  assert.match(copy, /<c:max val="200"\/><c:min val="100"\/>/);
});

test('portable workbook charts anchor through a drawing part', async (t) => {
  const cwd = await workspace(t);
  const book = join(cwd, 'chart.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: book,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
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
      },
      { cwd }
    )
  );
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

// A long document is written paragraph by paragraph, so appending must read the
// body's tail rather than its whole model — and still put the first paragraph in
// place of the empty one a new file starts with.
test('a long document appends in order and keeps no empty first paragraph', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'long.docx');
  const count = 120;
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        format: 'docx',
        operations: [
          { op: 'append_text', text: '야간 운영 보고', properties: { style: 'Heading1' } },
          ...Array.from({ length: count }, (_, index) => ({
            op: 'append_text',
            text: `${index + 1}. 대전 허브 정시 출고율은 89.1%였습니다.`,
          })),
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, count + 1);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const paragraphs = snapshot.document.paragraphs;
  assert.equal(paragraphs[0].text, '야간 운영 보고');
  assert.equal(paragraphs[1].text, '1. 대전 허브 정시 출고율은 89.1%였습니다.');
  // The snapshot is paged; the document itself carries every appended block.
  assert.equal(snapshot.document.paragraphCount, count + 1, 'no placeholder paragraph survives');
  const body = await (await parts(target)).text('word/document.xml');
  const written = [...body.matchAll(/(\d+)\. 대전 허브/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    written,
    Array.from({ length: count }, (_, index) => index + 1),
    'paragraphs keep their order'
  );
  assert.ok(body.lastIndexOf(`${count}. 대전`) < body.indexOf('<w:sectPr'), 'content stays before the section break');
});

test('portable Word authoring covers images, sections, lists, and links', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'mark.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'report.docx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'set_formula', cell: 'B4', formula: '=SUM(B2:B3)' },
          { op: 'set_formula', cell: 'C4', formula: '=TEXTJOIN(", ",TRUE,A2:A3)' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 3);
  const sheet = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /_xlfn\.TEXTJOIN/, 'post-2007 functions need the _xlfn prefix');
  assert.match(sheet, /<f>SUM\(B2:B3\)<\/f>/);

  const rejected = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_formula', cell: 'D4', formula: '=XLOOKUP(A2,A:A,B:B)' }],
    },
    { cwd }
  );
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /XLOOKUP/);
});

test('portable workbook warns when writing inside a merged range', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'merged.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'set_cell', cell: 'A1', value: 'Title' },
          { op: 'merge_cells', range: 'A1:C1' },
          { op: 'set_cell', cell: 'B1', value: 'hidden' },
        ],
      },
      { cwd }
    )
  );
  const [anchor, , inside] = created.batch.results;
  assert.equal(anchor.warning, undefined);
  assert.match(inside.warning, /merged range/);
});

test('portable workbook tables register a table part', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'table.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'add_table', range: 'A1:B3', name: 'Revenue', style: 'TableStyleMedium9' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).columns, 2);
  const packaged = await parts(target);
  const table = await packaged.text('xl/tables/table1.xml');
  assert.match(table, /name="Revenue"/);
  assert.match(table, /<tableStyleInfo name="TableStyleMedium9"/);
  assert.match(table, /<tableColumn id="1" name="Region"\/>/);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<tableParts count="1">/);

  // Excel accepts a Korean table name; keeping only ASCII erased it and the
  // table was silently called Table1 instead.
  const korean = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_range',
            range: 'D1:E3',
            values: [
              ['허브', '물량'],
              ['서울', 1240],
              ['부산', 1105],
            ],
          },
          { op: 'add_table', range: 'D1:E3', name: '허브 실적' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(korean.results.at(-1).name, '허브_실적');
  assert.match(await (await parts(target)).text('xl/tables/table2.xml'), /displayName="허브_실적"/);

  // A composed sheet paints its own palette; a built-in table style would band
  // the same range from the workbook's theme instead (a green sheet came back
  // with orange rows). style:'none' keeps the table and its filters and leaves
  // the colours alone.
  const unstyled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_range',
            range: 'G1:H2',
            values: [
              ['항목', '값'],
              ['운송비', 5483],
            ],
          },
          { op: 'add_table', range: 'G1:H2', name: '비용', style: 'none' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(unstyled.results.at(-1).columns, 2);
  const plain = await (await parts(target)).text('xl/tables/table3.xml');
  assert.doesNotMatch(plain, /tableStyleInfo name=/);
  assert.match(plain, /showRowStripes="0"/);
  assert.match(plain, /<autoFilter ref="G1:H2"\/>/);
});

// Word collapses a literal newline inside one text element, so a cell written as
// "title\ndate" rendered as one running line.
test('a table cell keeps the line breaks it was written with', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'steps.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [['01', '채용 공고\n10월 20일']],
            properties: { fontName: 'Noto Sans KR', fontSize: 10 },
          },
        ],
      },
      { cwd }
    )
  );
  const document = await (await parts(target)).text('word/document.xml');
  assert.match(document, /<w:t>채용 공고<\/w:t><w:br\/><w:t>10월 20일<\/w:t>/);
});

// A Word table with neither borders nor a style rendered as three loose columns
// of text: nothing on the page said the rows belonged together.
test('a Word table a caller did not style is still readable as a table', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'plain.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['허브', '물동량'],
              ['서울', '1,240'],
              ['대전', '880'],
            ],
            properties: { fontName: 'Noto Sans KR', fontSize: 10, repeatHeader: true },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).table, 1);
  const document = await (await parts(target)).text('word/document.xml');
  const properties = /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(document)?.[0] || '';
  assert.match(properties, /<w:bottom w:val="single"/, 'a rule under the header');
  assert.match(properties, /<w:insideH w:val="single"/, 'hairlines between rows');
  assert.doesNotMatch(properties, /<w:insideV/, 'no column rules by default');

  // A caller who styles the table owns it: the default never overrides them.
  const styled = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'add_table',
            values: [
              ['항목', '금액'],
              ['운송비', '548,300,000원'],
            ],
            properties: { borders: { top: { style: 'single', size: 8, color: '1F3A5F' } } },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(styled.results.at(-1).table, 2);
  const second = await (await parts(target)).text('word/document.xml');
  const tables = [...second.matchAll(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g)].map((match) => match[0]);
  assert.match(tables[1], /<w:top w:val="single" w:sz="8"[^>]*w:color="1F3A5F"/);
  assert.doesNotMatch(tables[1], /<w:insideH w:val="single"/);
});

test('portable Word tables gain and drop rows and columns', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'grid.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['A', 'B', 'C'],
              ['1', '2', '3'],
            ],
          },
          { op: 'insert_table_row', table: 1, row: 3 },
          { op: 'delete_table_column', table: 1, column: 3 },
          { op: 'insert_table_column', table: 1, column: 1 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(
    created.batch.results.every((entry) => entry.changed),
    true
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C3',
            values: [
              ['Region', 'A', 'B'],
              ['Korea', 1, 2],
              ['Japan', 3, 4],
            ],
          },
          { op: 'insert_rows', row: 2, count: 1 },
          { op: 'delete_columns', column: 3, count: 1 },
          { op: 'set_autofilter', range: 'A1:B4' },
          { op: 'define_name', name: 'Regions', refersTo: 'Sheet1!$A$3:$A$4' },
          { op: 'add_sheet', name: 'Notes' },
          // Rows and columns take visible: true/false; a sheet accepts the same word.
          { op: 'set_sheet_visibility', sheet: 'Notes', visible: false },
        ],
      },
      { cwd }
    )
  );
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
  // A withheld row or column is not a deleted one: the values stay, the sheet
  // stops showing them, and an edit written into a hidden column lands where the
  // user never looks — so the same call has to hide it and say that it is hidden.
  const withheld = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'set_column_visibility', column: 'B', visible: false },
          { op: 'set_row_visibility', row: 3, visible: false },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    withheld.results.map((entry) => entry.visible),
    [false, false]
  );
  const sheetXml = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<col\b[^>]*\bmin="2"[^>]*\bhidden="1"/);
  assert.match(sheetXml, /<row\b[^>]*\br="3"[^>]*\bhidden="1"/);
  const withheldSnapshot = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1' }, { cwd })
  );
  const withheldSheet = withheldSnapshot.document.sheets.find((entry) => entry.name === 'Sheet1');
  assert.deepEqual([withheldSheet.hiddenRows, withheldSheet.hiddenColumns], [[3], ['B']]);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'set_column_visibility', column: 'B', visible: true },
          { op: 'set_row_visibility', row: 3, visible: true },
        ],
      },
      { cwd }
    )
  );
  const restored = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1' }, { cwd })
  );
  const shownSheet = restored.document.sheets.find((entry) => entry.name === 'Sheet1');
  assert.deepEqual([shownSheet.hiddenRows, shownSheet.hiddenColumns], [[], []]);

  // A hidden sheet still answers a read; the snapshot has to say the workbook
  // withholds it, or its numbers are quoted as ordinary content.
  const hidden = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Notes' }, { cwd })
  );
  assert.equal(hidden.document.sheets.find((sheet) => sheet.name === 'Notes')?.visibility, 'hidden');
  const shown = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1' }, { cwd })
  );
  assert.equal(shown.document.sheets.find((sheet) => sheet.name === 'Sheet1')?.visibility, 'visible');
});

// A printed sheet carries its marking on every page, as a document and a deck do.
// Without the operation a workbook in the same pack went out unmarked.
test('a worksheet carries the mark its printed pages show', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'plan.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['허브', '건수'],
              ['대전', 1240],
            ],
          },
          { op: 'set_header_footer', kind: 'header', text: '대외비 — 물류본부 & 운영팀', alignment: 'left' },
          { op: 'set_header_footer', kind: 'footer', text: '문서번호 LOG-2026-114' },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    created.batch.results.slice(1).map((entry) => entry.kind),
    ['header', 'footer']
  );
  const sheetXml = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  // An ampersand opens a field code, so the literal one is doubled in the file.
  assert.match(
    sheetXml,
    /<headerFooter><oddHeader>&amp;L대외비 — 물류본부 &amp;&amp; 운영팀<\/oddHeader><oddFooter>&amp;C문서번호 LOG-2026-114<\/oddFooter><\/headerFooter>/
  );
  const snapshot = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Sheet1' }, { cwd })
  );
  const setup = snapshot.document.sheets[0].pageSetup;
  assert.equal(setup.header, '&L대외비 — 물류본부 && 운영팀');
  assert.equal(setup.footer, '&C문서번호 LOG-2026-114');
  const refused = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_header_footer', kind: 'top', text: '…' }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /kind must be header or footer/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Naming the thing to write — kind:'footer' — used to be read as an unknown page
// variant: the text became a second default header, replaced the real header, and
// the call reported success for a document whose footer never existed.
test('a footer asked for by name is written as a footer', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'contract.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        format: 'docx',
        operations: [
          { op: 'append_text', text: '계약 본문' },
          { op: 'set_header_footer', kind: 'header', text: '대외비 — 물류본부' },
          { op: 'set_header_footer', kind: 'footer', text: '문서번호 LOG-2026-114' },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    created.batch.results.slice(1).map((entry) => entry.header),
    [true, false]
  );
  const packaged = await parts(target);
  assert.match(await packaged.text('word/header1.xml'), /대외비 — 물류본부/);
  assert.match(await packaged.text('word/footer1.xml'), /문서번호 LOG-2026-114/);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /<w:footerReference\b[^>]*w:type="default"/);
  assert.match(document, /<w:headerReference\b[^>]*w:type="default"/);

  const refused = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_header_footer', kind: 'bottom', text: '…' }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /kind must be header, footer, default, first, even/);

  // Page numbers answer to the same two words rather than a second convention.
  const numbered = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'add_page_numbers', kind: 'header', alignment: 'right' }],
      },
      { cwd }
    )
  );
  assert.equal(numbered.results[0].header, true);
  assert.match(numbered.results[0].part, /^word\/header\d+\.xml$/);
  assert.match(await (await parts(target)).text(numbered.results[0].part), /PAGE/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Fit and ink are about what a reader sees. A hidden column shows nothing, so a
// truncation reported on one sends the next fix round to widen a column the
// workbook withholds on purpose.
test('appearance checks stop at the rows and columns the sheet withholds', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'plan.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:D3',
            values: [
              ['허브', '건수', '작업메모', '담당'],
              ['대전', 1240, '야간 인력 12명 증원 검토 중이며 단가 재협상 필요', '물류팀'],
              ['광주', 880, '보류 — 3분기 물량 확정 후 재검토 예정입니다', '운영팀'],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const codes = async () =>
    (value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || []).map(
      (entry) => entry.code
    );
  assert.ok((await codes()).includes('label_truncated'), 'a visible cut label is still reported');
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_column_visibility', column: 'C', visible: false }],
      },
      { cwd }
    )
  );
  assert.equal((await codes()).includes('label_truncated'), false, 'a hidden column is not measured');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Word hides a run and keeps its words in the file; a snapshot that reports them
// as ordinary body text invites an edit to quote or rewrite an internal remark
// the page never showed.
test('a Word snapshot names the text the page hides', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'contract.docx');
  const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const run = (text, hidden) =>
    `<w:r>${hidden ? '<w:rPr><w:vanish/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  await writeZip(target, {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      `<?xml version="1.0"?><w:document xmlns:w="${WORD}"><w:body>` +
      `<w:p>${run('계약 금액은 ')}${run('38,400,000원')}${run('입니다.')}</w:p>` +
      `<w:p>${run('검토 후 ')}${run('(법무 확인 전)', true)}${run(' 회신 바랍니다.')}</w:p>` +
      '</w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: target, mode: 'portable' }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  const paragraphs = snapshot.document.paragraphs;
  assert.equal(paragraphs[0].hiddenText, undefined, 'visible prose carries no hidden part');
  assert.equal(paragraphs[1].hiddenText, '(법무 확인 전)');
  assert.match(paragraphs[1].text, /검토 후 .*회신 바랍니다\./);
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
});

test('portable slides align, distribute, reorder, and duplicate', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'layout.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rectangle',
            text: 'A',
            properties: { left: 40, top: 300, width: 120, height: 80 },
          },
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rectangle',
            text: 'B',
            properties: { left: 400, top: 120, width: 120, height: 80 },
          },
          { op: 'align_shapes', slide: 1, shapes: [1, 2], align: 'middle' },
          { op: 'distribute_shapes', slide: 1, shapes: [1, 2], direction: 'horizontal', relativeToSlide: true },
          { op: 'z_order', slide: 1, shape: 1, command: 'front' },
          { op: 'duplicate_slide', slide: 1 },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_slide' },
          {
            op: 'add_textbox',
            slide: 1,
            text: 'Link me',
            properties: { left: 60, top: 60, width: 300, height: 60, fontSize: 24 },
          },
          { op: 'set_hyperlink', slide: 1, shape: 1, address: 'https://example.com/report' },
          { op: 'add_provenance', slide: 1, shape: 1, source: { document: 'internal model', target: 'Q3' } },
          { op: 'keep_slides', slides: [1] },
        ],
      },
      { cwd }
    )
  );
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

// Structural edits rename the slide parts to their positions: after a prune and a
// move, slide1.xml is the first slide the presentation lists, every relationship
// (the slide list, a notes slide's back-reference) follows, and the dropped part
// is gone, so "/slide[n]" in a snapshot or issue names the slide "slide: n" edits.
test('portable structural edits renumber slide parts to presentation order', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'renumber.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_slide' },
          { op: 'add_slide' },
          { op: 'add_textbox', slide: 1, text: 'One', properties: { left: 60, top: 60, width: 300, height: 60 } },
          { op: 'add_textbox', slide: 2, text: 'Two', properties: { left: 60, top: 60, width: 300, height: 60 } },
          { op: 'add_textbox', slide: 3, text: 'Three', properties: { left: 60, top: 60, width: 300, height: 60 } },
          { op: 'add_provenance', slide: 3, shape: 1, source: 'field survey' },
          { op: 'keep_slides', slides: [2, 3] },
          { op: 'move_slide', slide: 2, index: 1 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.ok, true, JSON.stringify(created.batch).slice(0, 400));
  const packaged = await parts(target);
  assert.match(await packaged.text('ppt/slides/slide1.xml'), /Three/);
  assert.match(await packaged.text('ppt/slides/slide2.xml'), /Two/);
  assert.equal(packaged.has('ppt/slides/slide3.xml'), false);
  const presentationRels = await packaged.text('ppt/_rels/presentation.xml.rels');
  assert.equal((presentationRels.match(/Target="slides\/slide[12]\.xml"/g) || []).length, 2);
  assert.doesNotMatch(presentationRels, /slide3\.xml/);
  const contentTypes = await packaged.text('[Content_Types].xml');
  assert.equal((contentTypes.match(/PartName="\/ppt\/slides\/slide\d+\.xml"/g) || []).length, 2);
  const slideRels = await packaged.text('ppt/slides/_rels/slide1.xml.rels');
  const notesTarget = /Type="[^"]*\/notesSlide"[^>]*Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(
    slideRels
  )?.[1];
  assert.ok(notesTarget, slideRels);
  const notesRels = await packaged.text(`ppt/notesSlides/_rels/${notesTarget}.rels`);
  assert.match(notesRels, /Target="\.\.\/slides\/slide1\.xml"/);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.slides.map((slide) => slide.index),
    [1, 2]
  );
  assert.match(snapshot.document.slides[0].text.join(' '), /Three/);
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_text', slide: 1, shape: 1, text: 'Three, edited' }],
      },
      { cwd }
    )
  );
  assert.notEqual(edited.ok, false, JSON.stringify(edited).slice(0, 400));
  assert.match(await (await parts(target)).text('ppt/slides/slide1.xml'), /Three, edited/);
});

test('portable workbook copies sheets and adds images, links, validation, and protection', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'logo.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'sheet.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'copy_sheet', sheet: 'Sheet1', name: 'Backup' },
          { op: 'add_image', path: picture, left: 240, top: 20, width: 80, height: 80 },
          { op: 'set_hyperlink', cell: 'A1', address: 'https://example.com', text: 'Region' },
          { op: 'add_validation', range: 'B2:B3', formula1: '=B2>0', errorMessage: 'Revenue must be positive' },
          { op: 'protect_sheet', password: 'secret', allowFiltering: true },
        ],
      },
      { cwd }
    )
  );
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

test('a protected form keeps its entry cells typable and reports the ones it locks', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'intake.xlsx');
  const operations = (unlock) => [
    {
      op: 'set_range',
      range: 'A1:B3',
      values: [
        ['항목', '값'],
        ['담당 허브', ''],
        ['야간 증원 인원', ''],
      ],
    },
    { op: 'add_validation', range: 'B2', formula1: '"서울,부산"' },
    { op: 'add_validation', range: 'B3', type: 'whole', formula1: '0', formula2: '50' },
    ...(unlock ? [{ op: 'set_style', range: 'B2:B3', properties: { fillColor: 'FFF7E0', locked: false } }] : []),
    { op: 'protect_sheet' },
  ];
  const locked = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: operations(false),
      },
      { cwd }
    )
  );
  const lockedIssues =
    value(await executeOfficeTool({ action: 'issues', session: locked.session }, { cwd })).issues || [];
  const reported = lockedIssues.find((issue) => issue.code === 'protected_input_locked');
  assert.ok(reported, JSON.stringify(lockedIssues).slice(0, 400));
  assert.match(reported.message, /B2, B3/);

  const open = join(cwd, 'intake-open.xlsx');
  const unlocked = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: open,
        mode: 'portable',
        operations: operations(true),
      },
      { cwd }
    )
  );
  const openIssues =
    value(await executeOfficeTool({ action: 'issues', session: unlocked.session }, { cwd })).issues || [];
  assert.equal(
    openIssues.filter((issue) => issue.code === 'protected_input_locked').length,
    0,
    JSON.stringify(openIssues).slice(0, 400)
  );
  const styles = await (await parts(open)).text('xl/styles.xml');
  assert.match(styles, /applyProtection="1"><protection locked="0"\/>/);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: unlocked.session }, { cwd }));
  const sheet = snapshot.document.sheets[0];
  assert.equal(sheet.protection.protected, true);
  assert.equal(sheet.cells.find((cell) => cell.ref === 'B2').style.locked, false);
  // A list validation is a dropdown, and a bounded number keeps its operator.
  assert.deepEqual(
    sheet.validations.map((entry) => [entry.type, entry.operator]),
    [
      ['list', ''],
      ['whole', 'between'],
    ]
  );
});

// Thousands of rows are written in one pass over the sheet, so the values, the
// styles the cells already carried, and the row order all have to survive it.
test('a bulk range write keeps cell styles, order, and the next append row', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'volume.xlsx');
  const rows = Array.from({ length: 400 }, (_, index) => [
    `2026-10-${(index % 28) + 1}`,
    '대전',
    1000 + index,
    (index % 10) / 10,
  ]);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:D1', values: [['일자', '허브', '처리량', '정시율']] },
          { op: 'set_style', range: 'A1:D1', properties: { bold: true, fillColor: '1F4E78', color: 'FFFFFF' } },
          { op: 'set_range', range: `A2:D${rows.length + 1}`, values: rows },
          { op: 'set_style', range: `D2:D${rows.length + 1}`, properties: { numberFormat: '0.0%' } },
          { op: 'set_range', range: 'A1:D1', values: [['일자', '허브', '처리량', '정시 출고율']] },
          { op: 'append_row', values: ['2026-10-29', '대전', 9999, 0.5] },
        ],
      },
      { cwd }
    )
  );
  assert.equal(
    created.batch.results.every((entry) => entry.changed),
    true
  );
  // A snapshot is paged, so each check asks for the rows it reads.
  const read = async (range) =>
    value(
      await executeOfficeTool(
        {
          action: 'snapshot',
          session: created.session,
          sheet: 'Sheet1',
          range,
        },
        { cwd }
      )
    ).document.sheets[0].cells;
  const head = await read('A1:D2');
  const tail = await read('A401:D401');
  const at = (ref) => [...head, ...tail].find((cell) => cell.ref === ref);
  // A rewritten header keeps the style it was given before the rewrite.
  assert.equal(at('D1').value, '정시 출고율');
  assert.equal(at('D1').style.bold, true);
  assert.equal(at('D1').style.fillColor, '1F4E78');
  assert.equal(at('D2').style.numberFormat, '0.0%');
  assert.equal(at('C2').value, 1000);
  assert.equal(at('C401').value, 1399);
  // The appended row lands after the last written row, not inside it.
  const appended = await read('A402:D402');
  assert.equal(appended.find((cell) => cell.ref === 'C402').value, 9999);
  const xml = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  const order = [...xml.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
    'rows stay in order'
  );
  assert.equal(new Set(order).size, order.length, 'each row is written once');
});

test('portable workbook writes and clears conditional formatting rules', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'rules.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'add_conditional_format', range: 'B2:B3', formula: '=B2<100', color: '#9C0006', fillColor: '#FFC7CE' },
          { op: 'add_conditional_format', range: 'A2:A3', formula: '=LEN(A2)>4', fillColor: '#FFEB9C' },
          { op: 'delete_conditional_formats', range: 'A2:A3' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).changed, true);
  const packaged = await parts(target);
  const sheet = await packaged.text('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<conditionalFormatting sqref="B2:B3">/);
  assert.doesNotMatch(sheet, /sqref="A2:A3"/);
  const styles = await packaged.text('xl/styles.xml');
  assert.match(styles, /<dxfs count="2">/);
  assert.match(styles, /<bgColor rgb="FFFFC7CE"\/>/);
});

test('a second footer replaces the first in place instead of leaving it behind', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'footers.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '10월 운영 보고', style: 'Heading1' },
          { op: 'add_page_numbers', kind: 'footer', alignment: 'center', includeTotal: true },
          { op: 'set_header_footer', kind: 'footer', text: '대외비 · 물류기획팀' },
          { op: 'set_header_footer', kind: 'header', variant: 'first', text: '' },
        ],
      },
      { cwd }
    )
  );
  const [numbers, footer, firstHeader] = created.batch.results.slice(-3);
  assert.equal(numbers.replaced, undefined);
  // The section already referenced that footer, so the text lands in the part
  // it points at — and the result says the page number is gone, not beside it.
  assert.equal(footer.replaced, true);
  assert.equal(footer.part, numbers.part);
  assert.equal(firstHeader.replaced, undefined);
  const packaged = await parts(target);
  assert.equal(packaged.has('word/footer1.xml'), true);
  assert.equal(packaged.has('word/footer2.xml'), false, 'the replaced footer must not stay in the package');
  assert.match(await packaged.text('word/footer1.xml'), /대외비/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('a printed sheet keeps every header slot and numbers its pages', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'ledger.xlsx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['허브', '정시율'],
              ['서울', 0.928],
            ],
          },
          { op: 'set_header_footer', kind: 'header', alignment: 'left', text: '10월 출고 대장' },
          { op: 'set_header_footer', kind: 'footer', alignment: 'center', text: '{page} / {pages}' },
          { op: 'set_header_footer', kind: 'footer', alignment: 'right', text: 'R&D 검토용' },
        ],
        finalize: true,
      },
      { cwd }
    )
  );
  const sheet = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  // One story holds three slots: writing the right slot must not drop the page
  // number written into the centre, and {page} must reach Excel's own field.
  assert.match(sheet, /<oddHeader>&amp;L10월 출고 대장<\/oddHeader>/);
  assert.match(sheet, /<oddFooter>&amp;C&amp;P \/ &amp;N&amp;RR&amp;&amp;D 검토용<\/oddFooter>/);
});

test("portable workbook sorts a range and carries each row's formats with it", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'hubs.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C5',
            values: [
              ['허브', '정시율', '처리량'],
              ['광주', 0.845, 640],
              ['서울', 0.928, 1240],
              ['강릉', 0.901, 320],
              ['부산', 0.883, 880],
            ],
          },
          { op: 'set_style', range: 'A3:C3', properties: { bold: true } },
          { op: 'sort_range', range: 'A1:C5', by: '정시율', order: 'desc' },
        ],
      },
      { cwd }
    )
  );
  const sort = created.batch.results.at(-1);
  assert.deepEqual([sort.by, sort.order, sort.rows], ['B', 'desc', 4]);
  const read = async (range) =>
    value(
      await executeOfficeTool(
        {
          action: 'snapshot',
          session: created.session,
          sheet: 'Sheet1',
          range,
        },
        { cwd }
      )
    ).document.sheets[0].cells;
  const cells = await read('A1:C5');
  const at = (ref) => cells.find((cell) => cell.ref === ref);
  // The header stays put, the rows arrive in value order, and the row that
  // carried a format still carries it after the move.
  assert.deepEqual(
    ['A1', 'A2', 'A3', 'A4', 'A5'].map((ref) => at(ref).value),
    ['허브', '서울', '강릉', '부산', '광주']
  );
  assert.equal(at('C2').value, 1240);
  assert.equal(at('A2').style.bold, true);
  assert.notEqual(at('A3').style?.bold, true);

  const withFormula = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'set_formula', cell: 'D2', formula: '=B2*C2' },
        { op: 'sort_range', range: 'A1:D5', by: 'B' },
      ],
    },
    { cwd }
  );
  assert.equal(withFormula.isError, true);
  assert.match(withFormula.content[0].text, /D2 holds a formula/);

  // A filtered row keeps its number while the values move, and a merged cell
  // cannot travel with one row: both would misreport the sheet, so both fail.
  const withHidden = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'set_row_visibility', row: 3, visible: false },
        { op: 'sort_range', range: 'A1:C5', by: 'B' },
      ],
    },
    { cwd }
  );
  assert.equal(withHidden.isError, true);
  assert.match(withHidden.content[0].text, /hidden row 3/);
  const withMerge = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'set_row_visibility', row: 3, visible: true },
        { op: 'merge_cells', range: 'A2:A3' },
        { op: 'sort_range', range: 'A1:C5', by: 'B' },
      ],
    },
    { cwd }
  );
  assert.equal(withMerge.isError, true);
  assert.match(withMerge.content[0].text, /merged cell A2:A3/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('portable workbook shades a range by value with a color scale and data bars', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'heatmap.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C4',
            values: [
              ['허브', '정시율', '처리량'],
              ['서울', 0.928, 1240],
              ['부산', 0.883, 880],
              ['광주', 0.845, 640],
            ],
          },
          {
            op: 'add_conditional_format',
            range: 'B2:B4',
            type: 'colorScale',
            minColor: '#F8696B',
            midColor: '#FFEB84',
            maxColor: '#63BE7B',
          },
          { op: 'add_conditional_format', range: 'C2:C4', type: 'dataBar', color: '#2E7D32' },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(
    created.batch.results.slice(-2).map((result) => result.type),
    ['colorScale', 'dataBar']
  );
  const sheet = await (await parts(target)).text('xl/worksheets/sheet1.xml');
  // The scale states its three stops, the bar its one color, and neither
  // borrows a differential format: the cells are shaded by their own values.
  assert.match(
    sheet,
    /<cfRule type="colorScale"[^>]*>[\s\S]*?<color rgb="FFF8696B"\/><color rgb="FFFFEB84"\/><color rgb="FF63BE7B"\/>/
  );
  assert.match(sheet, /<cfRule type="dataBar"[^>]*>[\s\S]*?<color rgb="FF2E7D32"\/>/);
  assert.doesNotMatch(sheet, /<cfRule type="(colorScale|dataBar)"[^>]*dxfId=/);

  // The two shapes exclude each other: a scale carries no formula, and a rule
  // that picks cells cannot be stated without one.
  const withFormula = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'add_conditional_format', range: 'B2:B4', type: 'colorScale', formula: 'B2<0.9' }],
    },
    { cwd }
  );
  assert.equal(withFormula.isError, true);
  assert.match(withFormula.content[0].text, /takes no formula/);
  const withoutFormula = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'add_conditional_format', range: 'B2:B4' }],
    },
    { cwd }
  );
  assert.equal(withoutFormula.isError, true);
  assert.match(withoutFormula.content[0].text, /colorScale.*dataBar/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('portable Word adds a table of contents, bookmarks, and comments', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'toc.docx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  const citation = created.batch.results.find((entry) => entry.op === 'add_provenance');
  assert.equal(citation.citation, 'Source: internal model#Q3');
  // A citation is read on the page, so a Korean source is labelled in Korean.
  const korean = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'add_provenance', paragraph: 3, source: { document: '실적원장.xlsx', target: 'Raw!B8' } }],
      },
      { cwd }
    )
  );
  assert.equal(korean.results[0].citation, '출처: 실적원장.xlsx#Raw!B8');
  const packaged = await parts(target);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /w:instr=" TOC/);
  // Until Word rebuilds the field, its cached result is what a preview, a PDF
  // export, or a render shows: the outline the document already carries.
  const field = /<w:fldSimple\b[^>]*w:instr=" TOC[\s\S]*?<\/w:fldSimple>/.exec(document)?.[0] || '';
  assert.match(field, /<w:t[^>]*>Contents<\/w:t>/);
  assert.doesNotMatch(field, /Update this field/);
  // A contents list is written before the sections it lists; saving rebuilds
  // its cache from the body, so the later heading is in it too.
  assert.match(field, /<w:t[^>]*>Section one<\/w:t>/);
  assert.match(document, /<w:bookmarkStart w:id="1" w:name="section_one"\/>/);
  assert.match(document, /<w:commentRangeStart w:id="1"\/>/);
  const comments = await packaged.text('word/comments.xml');
  assert.match(comments, /Needs a data point/);
  assert.match(comments, /internal model#Q3/);

  const removed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'delete_comment', comment: 1 }],
      },
      { cwd }
    )
  );
  assert.equal(removed.results[0].changed, true);
  const after = await (await parts(target)).text('word/document.xml');
  assert.doesNotMatch(after, /<w:commentRangeStart w:id="1"\/>/);
});

// A localized or converted Word file names its headings 제목 1 under its own
// style id: a contents list that only knew "Heading1" listed nothing and the
// page showed the English "update this field" placeholder instead.
test('a contents list reads the headings this document declares, not only Word style ids', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'korean-styles.docx');
  const heading = (style, text) =>
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  await writeZip(source, {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    'word/styles.xml':
      '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="10"><w:name w:val="제목 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="20"><w:name w:val="제목 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      heading('10', '1. 운영 현황') +
      '<w:p><w:r><w:t>야간 전환 이후 정시 출고율이 떨어졌습니다.</w:t></w:r></w:p>' +
      heading('20', '1.1 대전 허브') +
      heading('10', '2. 요청 사항') +
      '</w:body></w:document>',
  });
  const output = join(cwd, 'korean-toc.docx');
  const opened = value(await executeOfficeTool({ action: 'open', path: source, mode: 'portable', output }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'insert_toc', paragraph: 1, upperHeadingLevel: 3 }],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'save', session: opened.session }, { cwd }));
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
  const field =
    /<w:fldSimple\b[^>]*w:instr=" TOC[\s\S]*?<\/w:fldSimple>/.exec(
      await (await parts(output)).text('word/document.xml')
    )?.[0] || '';
  assert.doesNotMatch(field, /Update this field/);
  for (const entry of ['1. 운영 현황', '1.1 대전 허브', '2. 요청 사항']) {
    assert.ok(field.includes(entry), `${entry} is missing from ${field}`);
  }
});

test('portable slides crop pictures, set transitions, and swap layouts', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'photo.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'motion.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 5);
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /<a:srcRect l="10000" t="0" r="10000" b="0"\/>/);
  assert.match(slide, /<p:transition spd="med"><p:fade\/><\/p:transition>/);
});

// An appendix travels with its deck as a hidden slide: PowerPoint keeps the page
// and skips it when presenting. Without the operation there was no way to say so,
// and without the snapshot field a deck could not tell which pages it withholds.
test('a slide can be hidden and shown again, and the snapshot reports which', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'appendix.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_slide' },
          { op: 'add_textbox', slide: 1, text: '야간 운영 전환', left: 60, top: 60, width: 600, height: 80 },
          { op: 'add_textbox', slide: 2, text: '부록 — 계산 근거', left: 60, top: 60, width: 600, height: 80 },
          { op: 'set_slide_visibility', slide: 2, visible: false },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).visible, false);
  const packaged = await parts(target);
  assert.match(await packaged.text('ppt/slides/slide2.xml'), /<p:sld\b[^>]*\bshow="0"/);
  assert.doesNotMatch(await packaged.text('ppt/slides/slide1.xml'), /\bshow="0"/);
  const hidden = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    hidden.document.slides.map((slide) => slide.hidden),
    [false, true]
  );

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_slide_visibility', slide: 2, visible: true }],
      },
      { cwd }
    )
  );
  assert.doesNotMatch(await (await parts(target)).text('ppt/slides/slide2.xml'), /\bshow="0"/);
  const shown = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    shown.document.slides.map((slide) => slide.hidden),
    [false, false]
  );
});

test('portable workbook notes carry assumptions and provenance', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'notes.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
              ['Japan', 95],
            ],
          },
          { op: 'add_note', cell: 'B2', text: 'Assumption: 12% growth' },
          { op: 'add_provenance', cell: 'B2', source: { document: 'internal model', target: 'Q3' } },
          { op: 'add_note', cell: 'B3', text: 'Baseline figure' },
          { op: 'delete_note', cell: 'B3' },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
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
          {
            op: 'set_chart_axis',
            slide: 1,
            shape: 1,
            axis: 'value',
            minimum: 0,
            maximum: 200,
            majorUnit: 50,
            numberFormat: '#,##0',
            title: 'USD (mm)',
          },
          { op: 'set_chart_data_labels', slide: 1, shape: 1, showValue: true, position: 'outside_end' },
          { op: 'set_footer', slide: 1, text: 'Mixdog' },
          { op: 'set_slide_number', slide: 1, visible: true },
        ],
      },
      { cwd }
    )
  );
  assert.equal(
    created.batch.results.every((entry) => entry.changed),
    true
  );
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

// A footer is quiet, but the deck's own audit asks 4.5:1 of every piece of
// text — including the one the runtime writes itself, on a dark slide too.
test('footer and slide number take their ink from the field the slide shows', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'footers.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_slide' },
          { op: 'set_slide_background', slide: 2, color: '0F1824' },
          {
            op: 'add_textbox',
            slide: 1,
            text: '밝은 슬라이드',
            left: 60,
            top: 60,
            width: 480,
            height: 60,
            fontSize: 28,
          },
          {
            op: 'add_textbox',
            slide: 2,
            text: '어두운 슬라이드',
            left: 60,
            top: 60,
            width: 480,
            height: 60,
            fontSize: 28,
            color: 'FFFFFF',
          },
          { op: 'set_footer', slide: 1, text: '운영기획팀' },
          { op: 'set_slide_number', slide: 1, visible: true },
          { op: 'set_footer', slide: 2, text: '운영기획팀' },
          { op: 'set_slide_number', slide: 2, visible: true },
        ],
      },
      { cwd }
    )
  );
  const packaged = await parts(target);
  const ink = async (slide) => {
    const xml = await packaged.text(`ppt/slides/slide${slide}.xml`);
    const footer = /<p:ph type="ftr"[\s\S]*?<\/p:sp>/.exec(xml)?.[0] || '';
    const number = /<p:ph type="sldNum"[\s\S]*?<\/p:sp>/.exec(xml)?.[0] || '';
    return [footer, number].map((shape) => /<a:srgbClr val="([0-9A-F]{6})"\s*(?:\/>|>)/.exec(shape)?.[1] || '');
  };
  const [lightFooter, lightNumber] = await ink(1);
  const [darkFooter, darkNumber] = await ink(2);
  for (const [color, background] of [
    [lightFooter, 'FFFFFF'],
    [lightNumber, 'FFFFFF'],
    [darkFooter, '0F1824'],
    [darkNumber, '0F1824'],
  ]) {
    assert.ok(contrastRatio(color, background) >= 4.5, `${color} on ${background}`);
  }
  assert.notEqual(lightFooter, darkFooter, 'a dark slide takes light ink');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    issues.filter((issue) => issue.code === 'low_contrast'),
    []
  );
});

test('portable slides group and ungroup shapes', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'group.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rectangle',
            text: 'A',
            properties: { left: 60, top: 100, width: 120, height: 80 },
          },
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rectangle',
            text: 'B',
            properties: { left: 220, top: 100, width: 120, height: 80 },
          },
          { op: 'group_shapes', slide: 1, shapes: [1, 2] },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).shapes, 2);
  const grouped = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(grouped, /<p:grpSp>/);
  assert.match(grouped, /<a:chOff x="762000" y="1270000"\/>/);

  const ungrouped = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'ungroup_shape', slide: 1, shape: 1 }],
      },
      { cwd }
    )
  );
  assert.equal(ungrouped.results[0].changed, true);
  const flat = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.doesNotMatch(flat, /<p:grpSp>/);
  assert.equal((flat.match(/<p:sp>/g) || []).length, 2);
});

test('portable Word fits tables to the page and resolves tracked revisions', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'revisions.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'add_table',
            values: [
              ['Region', 'Revenue'],
              ['Korea', '120'],
            ],
            properties: { columnWidths: [1000, 600] },
          },
          { op: 'fit_table', table: 1 },
        ],
      },
      { cwd }
    )
  );
  const fitted = created.batch.results.at(-1);
  assert.equal(fitted.width, 9070);
  const document = await (await parts(target)).text('word/document.xml');
  assert.match(document, /<w:tblW w:w="9070" w:type="dxa"\/>/);
  const widths = [...document.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  assert.equal(
    widths.reduce((sum, width) => sum + width, 0),
    9070
  );
});

test('portable charts carry trendlines and error bars', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'stats.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).changed, true);
  const chart = await (await parts(target)).text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:trendlineType val="linear"\/>/);
  assert.match(chart, /<c:dispRSqr val="1"\/>/);
  assert.match(chart, /<c:errBars><c:errDir val="y"\/>/);
  assert.match(chart, /<c:val val="12"\/>/);
  assert.ok(chart.indexOf('<c:errBars>') < chart.indexOf('<c:cat>'), 'error bars precede the category axis data');

  const revised = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_chart_series', slide: 1, shape: 1, series: 1, name: '2027', values: [150, 130, 210] }],
      },
      { cwd }
    )
  );
  assert.equal(revised.results[0].changed, true);
  const updated = await (await parts(target)).text('ppt/charts/chart1.xml');
  assert.match(updated, /<c:v>2027<\/c:v>/);
  assert.match(updated, /<c:v>210<\/c:v>/);
  assert.doesNotMatch(updated, /<c:v>180<\/c:v>/);
});

test('portable compose_document applies page setup, spacing, lists, and page numbers', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'brief.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'compose_document',
            title: '분기 운영 리뷰',
            subtitle: 'portable 품질 점검',
            footer: 'Mixdog',
            pageNumbers: true,
            sections: [
              { heading: '결정', body: ['페이지 설정과 머리글을 적용한다.'], bullets: ['커버리지 확대'] },
              {
                heading: '근거',
                table: [
                  ['지표', '이전'],
                  ['오퍼레이션', '15'],
                ],
              },
            ],
          },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
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
            properties: {
              left: 60,
              top: 60,
              width: 400,
              height: 120,
              fillColor: 'F4F6F8',
              color: 'E7E9EC',
              fontSize: 14,
            },
          },
          {
            op: 'add_shape',
            slide: 1,
            shapeType: 'rectangle',
            text: 'Readable',
            properties: {
              left: 60,
              top: 220,
              width: 400,
              height: 120,
              fillColor: '1B4965',
              color: 'FFFFFF',
              fontSize: 14,
            },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 3);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const contrast = (issues.issues || []).filter((entry) => entry.code === 'low_contrast');
  assert.equal(contrast.length, 1, 'only the faint shape is reported');
  assert.match(contrast[0].path, /shape\[1\]$/);
  assert.ok(contrast[0].ratio < 4.5);

  // A caller who fills a shape and says nothing about its text gets ink the
  // fill can carry: the default dark ink on a dark card was text the runtime's
  // own contrast check then reported as unreadable.
  const defaults = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_shape',
            slide: 2,
            shapeType: 'rectangle',
            text: '서울 허브',
            properties: { left: 60, top: 60, width: 300, height: 120, fillColor: '1F3A5F' },
          },
          {
            op: 'add_shape',
            slide: 2,
            shapeType: 'rectangle',
            text: '대전 허브',
            properties: { left: 60, top: 220, width: 300, height: 120, fillColor: 'EEF2F6' },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(defaults.results.length, 3);
  const second = await (await parts(target)).text('ppt/slides/slide2.xml');
  assert.match(second, /1F3A5F[\s\S]*?<a:srgbClr val="FFFFFF">[\s\S]*?서울 허브/);
  assert.match(second, /EEF2F6[\s\S]*?<a:srgbClr val="1F2429">[\s\S]*?대전 허브/);
  const readable = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    (readable.issues || []).filter((entry) => entry.code === 'low_contrast' && /slide\[2\]/.test(entry.path)).length,
    0,
    JSON.stringify(readable.issues)
  );
});

test('portable workbook flags percentages stored as whole numbers', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'percent.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['Region', 'Share'],
              ['Korea', 42],
              ['Japan', 0.33],
            ],
          },
          { op: 'set_style', range: 'B2:B3', properties: { numberFormat: '0.0%' } },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 2);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const scaled = (issues.issues || []).filter((entry) => entry.code === 'percent_stored_as_whole');
  assert.equal(scaled.length, 1, 'only the whole-number percentage is reported');
  assert.match(scaled[0].path, /cell\[B2\]$/);
});

test('portable workbook audits column fit and formula consistency', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'audit.xlsx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 7);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const narrow = (issues.issues || []).filter((entry) => entry.code === 'column_too_narrow');
  assert.equal(narrow.length, 1);
  assert.match(narrow[0].path, /cell\[A1\]$/);
  const inconsistent = (issues.issues || []).filter((entry) => entry.code === 'formula_inconsistency');
  assert.equal(inconsistent.length, 1, 'the lone hardcoded cell mid-row is reported');
  assert.match(inconsistent[0].path, /cell\[C4\]$/);

  // A label only spills into an empty neighbour: once the next cell holds a
  // value, the reader sees the text cut at the column edge.
  const labelled = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'labels.xlsx'),
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:B1', values: [['상반기 매출 합계', 5317]] },
          { op: 'set_cell', cell: 'A2', value: '상반기 매출 합계' },
        ],
      },
      { cwd }
    )
  );
  const clipped = (
    value(await executeOfficeTool({ action: 'issues', session: labelled.session }, { cwd })).issues || []
  ).filter((entry) => entry.code === 'label_truncated');
  assert.deepEqual(
    clipped.map((entry) => entry.path),
    ['/sheet[Sheet1]/cell[A1]']
  );
  assert.match(clipped[0].message, /column A is 8\.4 wide and B1 has content/);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: labelled.session,
        operations: [{ op: 'autofit_range', range: 'A:B' }],
      },
      { cwd }
    )
  );
  const widened = (
    value(await executeOfficeTool({ action: 'issues', session: labelled.session }, { cwd })).issues || []
  ).filter((entry) => entry.code === 'label_truncated');
  assert.deepEqual(widened, []);
});

test('portable Word records and resolves tracked revisions', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'contract.docx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.find((entry) => entry.tracked === true).op, 'append_text');
  const packaged = await parts(target);
  assert.match(await packaged.text('word/settings.xml'), /<w:trackRevisions\/>/);
  const document = await packaged.text('word/document.xml');
  assert.match(document, /<w:ins w:id="\d+" w:author="Mixdog"/);
  assert.match(document, /<w:delText/);
  assert.match(document, /Proposed clause three/);
  assert.match(document, /Original clause two/, 'deleted text stays until the revision is accepted');

  const accepted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'resolve_revisions', resolution: 'accept' }],
      },
      { cwd }
    )
  );
  assert.equal(accepted.results[0].resolved, 2);
  const resolved = await (await parts(target)).text('word/document.xml');
  assert.doesNotMatch(resolved, /<w:ins /);
  assert.doesNotMatch(resolved, /Original clause two/, 'accepting the deletion removes the text');
  assert.match(resolved, /Proposed clause three/);
});

test('portable Word threads comment replies and resolution', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'review.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'append_text', text: 'The fee cap is too low.' },
          { op: 'add_comment', find: 'fee cap', text: 'Raise this to 5%.', author: 'Reviewer' },
          { op: 'add_comment_reply', comment: 1, text: 'Agreed, updating.', author: 'Owner' },
          { op: 'set_comment_resolved', comment: 1, resolved: true },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_comment', slide: 1, text: 'Tighten this headline.', author: 'Reviewer', initials: 'RV' },
          { op: 'add_comment', slide: 1, text: 'Second note.', author: 'Owner' },
          { op: 'delete_comment', slide: 1, comment: 2 },
        ],
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [{ op: 'set_page', properties: { orientation: 'landscape' } }],
      },
      { cwd }
    )
  );
  const empty = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const blocking = (empty.issues || []).filter((issue) => issue.code === 'empty_document');
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, 'error');

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'append_text', text: 'Latency review' }],
      },
      { cwd }
    )
  );
  const filled = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    (filled.issues || []).some((issue) => issue.code === 'empty_document'),
    false
  );
});

test('portable Word measures table columns in points and keeps borders through fit_table', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'grid.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_page',
            properties: { orientation: 'portrait', leftMargin: 72, rightMargin: 72, topMargin: 72, bottomMargin: 72 },
          },
          {
            op: 'add_table',
            values: [
              ['Metric', 'Baseline'],
              ['Latency', '120ms'],
            ],
            properties: { columnWidths: [300, 200], borders: { style: 'single', color: '808080', size: 4 } },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 2);
  const wide = await (await parts(target)).text('word/document.xml');
  assert.match(wide, /<w:gridCol w:w="6000"\/><w:gridCol w:w="4000"\/>/, 'point widths convert to twips');
  const flagged = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    (flagged.issues || []).some((issue) => issue.code === 'table_wider_than_page'),
    true,
    '500pt of columns overflow the 6.27in text column'
  );

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'fit_table', table: 1 }],
      },
      { cwd }
    )
  );
  const fitted = await (await parts(target)).text('word/document.xml');
  const properties = /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(fitted)?.[0] || '';
  assert.match(properties, /<w:tblW w:w="9026" w:type="dxa"\/>/);
  assert.match(properties, /<w:tblBorders>[\s\S]*w:color="808080"/, 'fit_table preserves declared borders');
  const clean = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    (clean.issues || []).some((issue) => issue.code === 'table_wider_than_page'),
    false
  );

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'merge_table_cells', table: 1, row: 2, col: 1, colSpan: 2 },
          { op: 'fit_table', table: 1 },
        ],
      },
      { cwd }
    )
  );
  const merged = await (await parts(target)).text('word/document.xml');
  assert.match(merged, /<w:gridSpan w:val="2"\/>/, 'fit_table keeps merged cells merged');
  const spanned = /<w:tcPr><w:tcW w:w="(\d+)" w:type="dxa"\/><w:gridSpan/.exec(merged);
  assert.equal(Number(spanned[1]), 9026, 'the merged cell spans both column widths');
});

// The audit asks every picture for alternative text, so the operations that
// place one must be able to carry it — and a build trigger is spelled the way
// every other multiword value in this runtime is.
test('a picture carries the alternative text the audit asks for', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'hub.png');
  await writeFile(picture, PNG_PIXEL);
  const target = join(cwd, 'described.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_image',
            slide: 1,
            path: picture,
            altText: '대전 허브 야간 작업 사진',
            left: 60,
            top: 120,
            width: 240,
            height: 180,
          },
          { op: 'add_image', slide: 1, path: picture, left: 360, top: 120, width: 240, height: 180 },
          { op: 'add_textbox', slide: 1, text: '현장', left: 60, top: 40, width: 300, height: 50, fontSize: 24 },
          { op: 'add_animation', slide: 1, shape: 3, effect: 'fade', trigger: 'after_previous', duration: 0.5 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.at(-1).trigger, 'afterprevious');
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /descr="대전 허브 야간 작업 사진"/);
  assert.match(slide, /nodeType="afterEffect"/);
  const described =
    value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  const missing = described.filter((issue) => issue.code === 'missing_alt_text');
  assert.equal(missing.length, 1, JSON.stringify(described).slice(0, 300));
  assert.equal(missing[0].path, '/slide[1]/picture[2]');

  // The description can also be added afterwards, on the picture that lacks it.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_shape', slide: 1, shape: 2, properties: { altText: '같은 허브의 주간 사진' } }],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.slides[0].shapes.filter((shape) => shape.type === 'p:pic').map((shape) => shape.altText),
    ['대전 허브 야간 작업 사진', '같은 허브의 주간 사진']
  );
  const after = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    after.filter((issue) => issue.code === 'missing_alt_text'),
    []
  );

  // A file name is what a writer stores when nobody described the picture, so
  // it cannot satisfy the rule: a reader hears "hub.png" and learns nothing.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_image', slide: 1, path: picture, altText: 'hub.png', left: 60, top: 340, width: 120, height: 90 },
        ],
      },
      { cwd }
    )
  );
  const named = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    named.filter((issue) => issue.code === 'missing_alt_text').map((issue) => issue.path),
    ['/slide[1]/picture[3]'],
    JSON.stringify(named).slice(0, 400)
  );

  // Swapping the picture in a template frame leaves the old description behind,
  // so the new photo is announced as the one it replaced until it is renamed.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'replace_image', slide: 1, shape: 4, path: picture, altText: '증설 후 같은 도크' }],
      },
      { cwd }
    )
  );
  const swapped = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    swapped.document.slides[0].shapes.filter((shape) => shape.type === 'p:pic').map((shape) => shape.altText),
    ['대전 허브 야간 작업 사진', '같은 허브의 주간 사진', '증설 후 같은 도크']
  );
  const settled = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    settled.filter((issue) => issue.code === 'missing_alt_text'),
    []
  );
});

// The same reader opens the Word report and the workbook. Both placed pictures
// with no way to describe them, so the accessibility rule the deck already
// enforces simply did not exist there.
test('a Word and an Excel picture carry — and are audited for — alternative text', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'hub.png');
  await writeFile(picture, PNG_PIXEL);
  for (const [format, operations] of Object.entries({
    docx: [
      { op: 'append_text', text: '10월 운영 현황' },
      { op: 'add_image', path: picture, width: 120, height: 60 },
    ],
    xlsx: [
      { op: 'set_cell', cell: 'A1', value: '현황' },
      { op: 'add_image', path: picture, sheet: 'Sheet1', left: 10, top: 10, width: 120, height: 60 },
    ],
  })) {
    const bare = value(
      await executeOfficeTool(
        {
          action: 'create',
          format,
          mode: 'portable',
          path: join(cwd, `bare.${format}`),
          operations,
        },
        { cwd }
      )
    );
    const bareIssues = (
      value(await executeOfficeTool({ action: 'issues', session: bare.session }, { cwd })).issues || []
    ).filter((issue) => issue.code === 'missing_alt_text');
    assert.equal(bareIssues.length, 1, `${format}: an undescribed picture is reported`);
    assert.match(bareIssues[0].message, /altText/);

    const description = '10월 출고율 추이 꺾은선';
    const described = value(
      await executeOfficeTool(
        {
          action: 'create',
          format,
          mode: 'portable',
          path: join(cwd, `described.${format}`),
          operations: operations.map((op) => (op.op === 'add_image' ? { ...op, altText: description } : op)),
        },
        { cwd }
      )
    );
    const describedIssues = (
      value(await executeOfficeTool({ action: 'issues', session: described.session }, { cwd })).issues || []
    ).filter((issue) => issue.code === 'missing_alt_text');
    assert.deepEqual(describedIssues, [], `${format}: a described picture is clean`);
    // Each file reads its pictures back, so a review sees what they say. The
    // Word session already listed /body/image[N]; the portable reader did not.
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: described.session }, { cwd }));
    const images = format === 'xlsx' ? snapshot.document.sheets[0].images : snapshot.document.images;
    assert.deepEqual(
      images.map((image) => image.altText),
      [description],
      `${format}: the picture reads back`
    );
    if (format === 'docx') {
      assert.equal(images[0].path, '/body/image[1]');
      assert.deepEqual([images[0].width, images[0].height], [120, 60]);
    }
  }
});

test('portable slides build an entrance animation timeline', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'anim.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
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
    executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'add_animation', slide: 1, shape: 1, effect: 'explode' }],
      },
      { cwd }
    ).then((result) => {
      if (result?.isError) throw new Error(result.content[0].text);
      return result;
    }),
    /effect must be one of/
  );
});

test('portable slides flag table cells whose text cannot fit the row', async (t) => {
  const cwd = await workspace(t);
  const outcomes = [];
  for (const [label, values] of [
    [
      'short',
      [
        ['Metric', 'Value'],
        ['Latency', '120ms'],
      ],
    ],
    [
      'long',
      [
        ['Metric', 'Value'],
        [
          'Rolling ninety-fifth percentile request latency measured across every production region and edge node',
          '120ms',
        ],
      ],
    ],
  ]) {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `${label}.pptx`),
          mode: 'portable',
          operations: [
            { op: 'add_slide' },
            { op: 'add_table', slide: 1, values, left: 40, top: 40, width: 320, height: 90 },
          ],
        },
        { cwd }
      )
    );
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    outcomes.push((issues.issues || []).filter((issue) => issue.code === 'table_cell_overflow'));
  }
  assert.equal(outcomes[0].length, 0, 'short cell text stays clean');
  assert.equal(outcomes[1].length, 1);
  assert.equal(outcomes[1][0].path, '/slide[1]/table[1]/row[2]/cell[1]');
  // Every cell fits its row, and the ten rows together (260 pt) still run off a 540 pt canvas from top 420,
  // which the per-cell read alone never says.
  const tall = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'tall.pptx'),
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_table',
            slide: 1,
            values: Array.from({ length: 10 }, (_, i) => [`Row ${i + 1}`, `${i * 12}ms`]),
            left: 40,
            top: 420,
            width: 320,
            height: 260,
          },
        ],
      },
      { cwd }
    )
  );
  const tallIssues = value(await executeOfficeTool({ action: 'issues', session: tall.session }, { cwd })).issues || [];
  const exceeds = tallIssues.find((issue) => issue.code === 'table_exceeds_canvas');
  assert.ok(exceeds, JSON.stringify(tallIssues.map((issue) => issue.code)));
  assert.equal(exceeds.path, '/slide[1]/table[1]');
  assert.equal(
    outcomes[0].some((issue) => issue.code === 'table_exceeds_canvas'),
    false
  );
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
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `${label}.pptx`),
          mode: 'portable',
          operations: [{ op: 'add_slide' }, { op: 'add_image', slide: 1, path: square, left: 40, top: 40, ...size }],
        },
        { cwd }
      )
    );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'group.pptx'),
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_textbox', slide: 1, text: 'first', properties: { left: 40, top: 40, width: 200, height: 40 } },
          {
            op: 'add_textbox',
            slide: 1,
            text: 'grouped A',
            properties: { left: 40, top: 120, width: 200, height: 40 },
          },
          {
            op: 'add_textbox',
            slide: 1,
            text: 'grouped B',
            properties: { left: 40, top: 180, width: 200, height: 40 },
          },
          { op: 'add_textbox', slide: 1, text: 'last', properties: { left: 40, top: 260, width: 200, height: 40 } },
          { op: 'group_shapes', slide: 1, shapes: [2, 3] },
        ],
      },
      { cwd }
    )
  );
  const before = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const names = before.document.slides[0].shapes.map((shape) => String(shape.text || ''));
  assert.equal(names.length, 3, 'the group counts as one shape, not two');

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_text', slide: 1, shape: 2, text: 'SECOND EDITED' }],
      },
      { cwd }
    )
  );
  const after = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(
    String(after.document.slides[0].shapes[1].text || ''),
    'SECOND EDITED',
    'set_text targets the same shape index the snapshot reports'
  );
});

test('portable slide snapshots keep deck order and report evidence shapes', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'evidence.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
            values: [
              ['Region', 'Revenue'],
              ['Korea', '120'],
            ],
            left: 40,
            top: 40,
            width: 400,
            height: 120,
          },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.slides.map((slide) => slide.index),
    [1, 2],
    'slides report in deck order, matching the Microsoft Office snapshot'
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
        {
          op: 'add_table',
          values: [
            ['A', 'B'],
            ['1', '2'],
          ],
        },
      ],
    },
    {
      format: 'xlsx',
      file: 'contract.xlsx',
      operations: [
        {
          op: 'set_range',
          range: 'A1:B3',
          values: [
            ['Region', 'Revenue'],
            ['Korea', 120],
            ['Japan', 95],
          ],
        },
      ],
    },
    {
      format: 'pptx',
      file: 'contract.pptx',
      operations: [
        { op: 'add_slide' },
        { op: 'set_slide_background', slide: 1, color: '16191D' },
        {
          op: 'add_textbox',
          slide: 1,
          text: 'Title',
          properties: { left: 40, top: 40, width: 400, height: 60, fontSize: 40 },
        },
        { op: 'set_notes', slide: 1, text: 'Speaker note.' },
        { op: 'add_slide' },
        {
          op: 'add_table',
          slide: 2,
          values: [
            ['A', 'B'],
            ['1', '2'],
          ],
          left: 40,
          top: 40,
          width: 300,
          height: 90,
        },
      ],
    },
  ];
  for (const testCase of cases) {
    const target = join(cwd, testCase.file);
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: target,
          mode: 'portable',
          operations: testCase.operations,
        },
        { cwd }
      )
    );
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
    const violations = officeSnapshotContractViolations(snapshot.document, {
      format: testCase.format,
      paged: true,
    });
    assert.deepEqual(
      violations,
      [],
      `${testCase.format} snapshot breaks the backend contract:\n${describeOfficeSnapshotViolations(violations)}`
    );
  }
});

test('portable Word reads and edits tables that contain a nested table', async (t) => {
  const cwd = await workspace(t);
  const cell = (text, extra = '') =>
    `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${extra}` +
    `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const inner =
    '<w:tbl><w:tblPr><w:tblW w:w="1000" w:type="dxa"/></w:tblPr>' +
    `<w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr>${cell('inner')}</w:tr></w:tbl>`;
  const outer =
    '<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
    `<w:tr>${cell('outer A')}${cell('outer B', inner)}</w:tr>` +
    `<w:tr>${cell('row2 A')}${cell('row2 B')}</w:tr></w:tbl>`;
  const second =
    '<w:tbl><w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr>' +
    `<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell('second')}</w:tr></w:tbl>`;
  const source = join(cwd, 'nested.docx');
  await writeZip(source, {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p>${outer}${second}<w:sectPr/></w:body></w:document>`,
  });

  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output: join(cwd, 'nested-out.docx'),
        mode: 'portable',
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.tables.length, 2, 'the nested table is not counted as a sibling');
  assert.equal(snapshot.document.tables[0].rows.length, 2, 'the outer table keeps both rows');
  assert.equal(snapshot.document.tables[1].rows[0].cells[0].text, 'second');

  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          { op: 'set_table_cell', table: 1, row: 2, col: 1, text: 'row2 edited' },
          { op: 'insert_table_column', table: 1, column: 2 },
        ],
      },
      { cwd }
    )
  );
  const edited = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(edited.document.tables[0].rows[1].cells[0].text, 'row2 edited');
  assert.equal(edited.document.tables[0].rows[0].cells.length, 3, 'the outer row gained a column');
  const document = await (await parts(join(cwd, 'nested-out.docx'))).text('word/document.xml');
  assert.match(document, /<w:t>inner<\/w:t>/, 'the nested table survives structural edits');
});

test('portable workbooks read cells that follow a style-only cell', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'styled.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'set_cell', cell: 'A1', value: 'Latency model' },
          { op: 'set_style', range: 'A1:C1', properties: { bold: true, fillColor: '183028' } },
          {
            op: 'set_range',
            range: 'A3:C4',
            values: [
              ['Region', 'Product', 'Revenue'],
              ['Korea', 'Alpha', 120],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 3);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = new Map(
    snapshot.document.sheets[0].cells.map((cell) => [cell.path.replace(/^.*\[/, '').replace(/\]$/, ''), cell.value])
  );
  assert.equal(cells.get('A1'), 'Latency model');
  assert.equal(cells.get('A3'), 'Region', 'the header after the style-only B1/C1 cells survives the read');
  assert.equal(cells.get('B3'), 'Product');
  assert.equal(cells.get('C3'), 'Revenue');
  assert.equal(cells.get('A4'), 'Korea');
});

test('portable workbook audits see cells that follow a style-only cell', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const codes = new Map((issues.issues || []).map((issue) => [issue.code, issue.path]));
  assert.equal(codes.get('percent_stored_as_whole'), '/sheet[Sheet1]/cell[A4]');
  assert.equal(codes.get('column_too_narrow'), '/sheet[Sheet1]/cell[B4]');
  assert.equal(codes.get('formula_inconsistency'), '/sheet[Sheet1]/cell[D6]');
});

test('portable workbooks build a refreshable pivot table', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'pivot.xlsx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
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
  assert.match(
    table,
    /<pivotField axis="axisRow"[^>]*><items count="3"><item x="1"\/><item x="0"\/>/,
    'row items follow display order'
  );
  assert.match(table, /<dataField name="Sum of Revenue" fld="2"/);
  assert.match(table, /<rowItems count="3">[\s\S]*<i t="grand">/);

  const workbook = await packaged.text('xl/workbook.xml');
  assert.match(workbook, /<pivotCaches><pivotCache cacheId="1" r:id="rId\d+"\/><\/pivotCaches>/);

  // The grid itself is in the sheet, so Excel shows the pivot before any
  // refresh and every cell-reading check (snapshot, autofit, fit audit) sees it.
  const summarised = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Pivot' }, { cwd })
  );
  const grid = new Map(
    (summarised.document.sheets.find((sheet) => sheet.name === 'Pivot')?.cells || []).map((cell) => [
      cell.ref,
      cell.value,
    ])
  );
  assert.equal(grid.get('A3'), 'Sum of Revenue');
  assert.deepEqual(
    ['A4', 'B4', 'C4', 'D4'].map((ref) => grid.get(ref)),
    ['Region', 'Alpha', 'Beta', 'Grand Total']
  );
  assert.deepEqual(
    ['A5', 'B5', 'C5', 'D5'].map((ref) => grid.get(ref)),
    ['Japan', 150, 60, 210]
  );
  assert.deepEqual(
    ['A6', 'B6', 'C6', 'D6'].map((ref) => grid.get(ref)),
    ['Korea', 120, 80, 200]
  );
  assert.deepEqual(
    ['A7', 'B7', 'C7', 'D7'].map((ref) => grid.get(ref)),
    ['Grand Total', 270, 140, 410]
  );

  // Excel's own way of naming a source — sheet and range in one string — and a
  // value field written as an object both reach the same pivot.
  const qualified = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'add_pivot_table',
            source: 'Sheet1!A1:C5',
            destination: 'Pivot!F3',
            name: 'RevenueByProduct',
            rows: ['Product'],
            values: [{ field: 'Revenue', function: 'sum' }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(qualified.results[0].name, 'RevenueByProduct');
  const second = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Pivot' }, { cwd })
  );
  const cells = new Map(
    (second.document.sheets.find((sheet) => sheet.name === 'Pivot')?.cells || []).map((cell) => [cell.ref, cell.value])
  );
  assert.deepEqual(
    ['F3', 'G3'].map((ref) => cells.get(ref)),
    ['Product', 'Sum of Revenue']
  );
  assert.deepEqual(
    ['F6', 'G6'].map((ref) => cells.get(ref)),
    ['Grand Total', 410]
  );

  const mismatched = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        {
          op: 'add_pivot_table',
          sheet: 'Pivot',
          source: 'Sheet1!A1:C5',
          destination: 'H3',
          rows: ['Region'],
          values: ['Revenue'],
        },
      ],
    },
    { cwd }
  );
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0].text, /names sheet "Sheet1" but sheet is "Pivot"/);

  const averaged = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        {
          op: 'add_pivot_table',
          sheet: 'Sheet1',
          source: 'A1:C5',
          destination: 'J3',
          destinationSheet: 'Pivot',
          rows: ['Region'],
          values: [{ field: 'Revenue', function: 'average' }],
        },
      ],
    },
    { cwd }
  );
  assert.equal(averaged.isError, true);
  assert.match(averaged.content[0].text, /totals its value fields; "average" is not available/);

  await assert.rejects(
    executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'add_pivot_table',
            sheet: 'Sheet1',
            source: 'A1:C5',
            destination: 'F3',
            rows: ['Region', 'Product'],
            values: ['Revenue'],
          },
        ],
      },
      { cwd }
    ).then((result) => {
      if (result?.isError) throw new Error(result.content[0].text);
      return result;
    }),
    /one row field and one column field/
  );
});

test('portable slides embed media and swap the theme', async (t) => {
  const cwd = await workspace(t);
  const poster = join(cwd, 'poster.png');
  const clip = join(cwd, 'clip.mp4');
  await writeFile(poster, PNG_PIXEL);
  await writeFile(clip, Buffer.from('00000018667479706d70343200000000', 'hex'));
  const target = join(cwd, 'media.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_media', slide: 1, path: clip, kind: 'video', poster, left: 60, top: 60, width: 320, height: 180 },
          { op: 'apply_theme', path: 'src/runtime/office/design/library/templates/mixdog-executive.pptx' },
        ],
      },
      { cwd: process.cwd() }
    )
  );
  assert.equal(created.batch.results.at(-1).applied.length >= 1, true);
  const packaged = await parts(target);
  assert.equal(packaged.has('ppt/media/media1.mp4'), true);
  const slide = await packaged.text('ppt/slides/slide1.xml');
  assert.match(slide, /<a:videoFile[^>]*r:link="rId\d+"/);
  assert.match(slide, /action="ppaction:\/\/media"/);
  const theme = await packaged.text('ppt/theme/theme1.xml');
  assert.match(theme, /Georgia|Arial/, 'the bundled brand theme replaced the default');

  // Applying the theme the deck already carries restyles nothing. Reporting a
  // change there sends the caller looking for a difference the file does not
  // hold — and the render cache, which reuses pages whose resources are
  // unchanged, would disagree with that answer.
  const again = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'apply_theme', path: 'src/runtime/office/design/library/templates/mixdog-executive.pptx' }],
    },
    { cwd: process.cwd() }
  );
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /apply_theme \(the deck already uses this theme\)/);
});

test('portable slides report shapes that crowd each other', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'spacing.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          // Blocks of copy, not labels: a short label (≤ 16 chars) sits beside its neighbour by design and is exempt.
          {
            op: 'add_textbox',
            slide: 1,
            text: 'The left block carries a full sentence of copy.',
            properties: { left: 60, top: 100, width: 200, height: 80, fontSize: 14 },
          },
          {
            op: 'add_textbox',
            slide: 1,
            text: 'The right block carries another sentence of copy.',
            properties: { left: 268, top: 100, width: 200, height: 80, fontSize: 14 },
          },
          {
            op: 'add_textbox',
            slide: 1,
            text: 'The far block sits well apart from the others.',
            properties: { left: 600, top: 100, width: 200, height: 80, fontSize: 14 },
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 4);
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const crowded = (issues.issues || []).filter((entry) => entry.code === 'shapes_too_close');
  assert.equal(crowded.length, 1, 'only the 8pt gap is reported');
  assert.equal(crowded[0].gap, 8);
});

test('portable issues flag leftover template placeholder text', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'placeholder.pptx');
  const created = value(
    await executeOfficeTool(
      {
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
      },
      { cwd }
    )
  );
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
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          { op: 'add_image', slide: 1, path: first, left: 40, top: 40, width: 120, height: 120 },
        ],
      },
      { cwd }
    )
  );
  assert.equal((await parts(target)).has('ppt/media/image1.png'), true);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'replace_image', slide: 1, shape: 1, path: second }],
      },
      { cwd }
    )
  );
  const packaged = await parts(target);
  assert.equal(packaged.has('ppt/media/image2.png'), true);
  assert.equal(packaged.has('ppt/media/image1.png'), false, 'the replaced media part must be cleaned up');
});

test('portable text metrics flag overflow and fit_text repairs it', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'overflow.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_textbox',
            slide: 1,
            text: '오버플로를 유발하기 위해 충분히 긴 문장을 반복해서 넣습니다. '.repeat(6),
            // 200 × 60 pt: 24 pt Hangul (measured in the East Asian fallback) runs far past it; 6 pt fits.
            properties: { left: 40, top: 40, width: 200, height: 60, fontSize: 24 },
          },
        ],
      },
      { cwd }
    )
  );
  const before = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const overflow = (before.issues || []).filter((entry) => entry.code === 'text_overflow');
  assert.equal(overflow.length, 1, 'an overflowing text box must be reported');
  assert.match(overflow[0].path, /^\/slide\[1\]\/shape\[1\]$/);

  const fitted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'fit_text', slide: 1, shape: 1, minFontSize: 6 }],
      },
      { cwd }
    )
  );
  assert.equal(fitted.results[0].changed, true);
  assert.ok(fitted.results[0].scale < 1, 'fit_text must shrink the run size');
  // The repair lands on a type ladder step and says what the copy now reads at:
  // a percentage search left 24 pt copy at 14.88 pt beside the deck's own sizes.
  assert.equal(Number.isInteger(fitted.results[0].fontSize), true, JSON.stringify(fitted.results[0]));
  assert.ok(fitted.results[0].fontSize < 24 && fitted.results[0].fontSize >= 6);
  const after = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal((after.issues || []).filter((entry) => entry.code === 'text_overflow').length, 0);
});

test('portable set_table_data rewrites an existing table in place', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'table.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
      },
      { cwd }
    )
  );
  const batch = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_table',
            slide: 1,
            values: [
              ['Region', 'Revenue'],
              ['Korea', '120'],
            ],
            left: 58,
            top: 100,
            width: 480,
            height: 120,
          },
          {
            op: 'set_table_data',
            slide: 1,
            shape: 1,
            values: [
              ['지역', '매출'],
              ['일본', '95'],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const replaced = batch.results.at(-1);
  assert.equal(replaced.changed, true);
  assert.equal(replaced.rows, 2);
  const slide = await (await parts(target)).text('ppt/slides/slide1.xml');
  assert.match(slide, /지역/);
  assert.match(slide, /일본/);
  assert.doesNotMatch(slide, /Korea/);
});
