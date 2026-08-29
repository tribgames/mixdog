import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { describeOfficeCapabilities } from './capabilities.mjs';
import { expandOfficeDesignOperations } from './design-system.mjs';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { applyPortableOoxmlBatch } from './portable-ooxml.mjs';
import { createPortableOoxmlDocument } from './portable-package.mjs';

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
      { op: 'compose_slide', kind: 'cover', title: 'Portable decks' },
      { op: 'compose_slide', kind: 'metrics', title: 'Coverage', metrics: [{ label: 'Formats', value: '3' }] },
      { op: 'compose_slide', kind: 'table', title: 'Regions', table: [['Region', 'Revenue'], ['Korea', '120']] },
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

test('portable composition rejects chart requests that need Microsoft Office', () => {
  assert.throws(() => expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    operations: [{ op: 'compose_sheet', rows: [['Korea', 120]], chart: { type: 'column' } }],
    created: true,
  }), /requires Microsoft Excel/);
  assert.throws(() => expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'mixdog-ooxml',
    operations: [{ op: 'compose_slide', kind: 'chart', title: 'Trend', chart: { series: [] } }],
    created: true,
  }), /requires Microsoft PowerPoint/);
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
