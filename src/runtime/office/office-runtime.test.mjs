import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  officeBenchmarkSnapshotRequest,
  officeBenchmarkVisualPolicy,
} from './benchmark.mjs';
import {
  assertOfficeOperationContracts,
  describeOfficeCapabilities,
  OFFICE_ACTIONS,
} from './capabilities.mjs';
import { runOfficeContractBenchmark } from './contract-benchmark.mjs';
import { resolveMicrosoftOfficeHostScriptPath } from './com-adapter.mjs';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './pagination.mjs';
import { recalculateLibreOfficeWorkbook } from './portable-ooxml.mjs';
import { renderPdfPages } from './pdf-render.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';
import { parseXlsxAutofitRange } from './xlsx-contract.mjs';

async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'mixdog-office-'));
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

async function writeZip(path, entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function unicodeFontPath() {
  const candidates = [
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'malgun.ttf') : '',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

test('office is a first-class built-in tool with stateful document actions', () => {
  assert.equal(TOOL_DEFS.length, 1);
  assert.equal(TOOL_DEFS[0].name, 'office');
  assert.deepEqual(
    TOOL_DEFS[0].inputSchema.properties.action.enum,
    OFFICE_ACTIONS,
  );
  for (const removed of ['set', 'add', 'remove', 'move']) {
    assert.equal(TOOL_DEFS[0].inputSchema.properties.action.enum.includes(removed), false);
  }
  for (const removed of ['type', 'text', 'value', 'values', 'formula', 'to', 'index']) {
    assert.equal(Object.hasOwn(TOOL_DEFS[0].inputSchema.properties, removed), false);
  }
  assert.match(TOOL_DEFS[0].description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].description, /operations on create\/open/);
  assert.match(TOOL_DEFS[0].description, /\bfinalize\b/);
  assert.match(TOOL_DEFS[0].description, /Inspect unfamiliar existing documents before editing/);
  assert.match(TOOL_DEFS[0].description, /do not snapshot again/);
  assert.match(TOOL_DEFS[0].description, /Call describe only when/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.action.description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /Call describe only when/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.review.description, /Keep enabled for deliverables/);
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('visible'));
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('attach'));
  assert.equal(TOOL_DEFS[0].inputSchema.properties.requireChanges.type, 'boolean');
  assert.deepEqual(TOOL_DEFS[0].inputSchema.properties.failOn.enum, ['error', 'warning']);
  const descriptionChars = [
    TOOL_DEFS[0].description,
    ...Object.values(TOOL_DEFS[0].inputSchema.properties).map((property) => property.description || ''),
  ].reduce((total, description) => total + description.length, 0);
  assert.ok(descriptionChars <= 5000, `Office schema descriptions grew to ${descriptionChars} characters`);
  assert.ok(JSON.stringify(TOOL_DEFS[0].inputSchema).length <= 7000, 'Office input schema exceeded its size budget');
});

test('XLSX autofit accepts bounded cell, whole-column, and whole-row selectors', () => {
  assert.equal(parseXlsxAutofitRange('A1:D5').type, 'cells');
  assert.deepEqual(parseXlsxAutofitRange('A:D'), { type: 'columns', start: 1, end: 4 });
  assert.deepEqual(parseXlsxAutofitRange('2:8'), { type: 'rows', start: 2, end: 8 });
  assert.throws(() => parseXlsxAutofitRange('D:A'), /Invalid XLSX column range/);
});

test('Office COM authoring keeps paragraph structure, no-op gates, and render state stable', async () => {
  const source = await readFile(new URL('./office-com-host.ps1', import.meta.url), 'utf8');
  const sessionSource = await readFile(new URL('./office-com-session-host.ps1', import.meta.url), 'utf8');
  assert.match(source, /Paragraphs\.Add\(\$range\)/);
  assert.match(source, /produced no change/);
  assert.match(source, /SetSourceData\(\$sheet\.Range\(\[string]\$op\.range\), 2\)/);
  assert.match(source, /\$pageSetup\.FitToPagesWide = 1/);
  assert.match(source, /\$state\.PageSetup\.FitToPagesWide = \$state\.FitToPagesWide/);
  assert.match(source, /SaveCopyAs\(\$output, 32\)/);
  assert.match(sessionSource, /\$wasSaved = \[bool]\$document\.Saved/);
  assert.match(sessionSource, /inspectIssues/);
  assert.match(sessionSource, /WaitForExit\(250\)/);
  assert.match(sessionSource, /FinalReleaseComObject/);
  assert.match(sessionSource, /\$process\.Kill\(\)/);
});

test('create initial operations and finalize collapse a portable workflow', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'workflow.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
  }, { cwd }));
  assert.equal(created.document, undefined);
  assert.equal(created.batch.changeSummary.changed, 1);
  for (const removed of ['set', 'add', 'remove', 'move']) {
    const rejected = await executeOfficeTool({
      action: removed,
      session: created.session,
    }, { cwd });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unsupported Office Use action/);
  }
  const finalized = value(await executeOfficeTool({
    action: 'finalize',
    session: created.session,
    review: false,
  }, { cwd }));
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.failOn, 'warning');
  assert.equal(finalized.saved, true);
  assert.equal(finalized.closed, true);
});

test('persistent Office validation inspects the open document without quitting a second COM application', async () => {
  const source = await readFile(new URL('./office-com-session-host.ps1', import.meta.url), 'utf8');
  const start = source.indexOf("'validate' {");
  const end = source.indexOf("'checkpoint' {", start);
  const validation = source.slice(start, end);
  assert.match(validation, /Snapshot-Document \$document/);
  assert.match(validation, /Issues-Document \$document/);
  assert.doesNotMatch(validation, /Validate-NativeDocument/);
});

test('Office COM host resolves to the physical ASAR sidecar for external PowerShell', () => {
  const packaged = 'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\runtime\\office\\office-com-host.ps1';
  assert.equal(
    resolveMicrosoftOfficeHostScriptPath(packaged),
    'C:\\Program Files\\Mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\src\\runtime\\office\\office-com-host.ps1',
  );
  const development = 'C:\\Project\\mixdog\\src\\runtime\\office\\office-com-host.ps1';
  assert.equal(resolveMicrosoftOfficeHostScriptPath(development), development);
});

test('Office benchmark inherits adaptive cursor limits and separates large spreadsheet visuals', () => {
  assert.deepEqual(officeBenchmarkSnapshotRequest('office_1'), {
    action: 'snapshot',
    session: 'office_1',
    limit: 10000,
    maxChars: 100000,
  });
  assert.deepEqual(officeBenchmarkSnapshotRequest('office_1', 'cursor_1'), {
    action: 'snapshot',
    session: 'office_1',
    cursor: 'cursor_1',
    maxChars: 100000,
  });
  assert.deepEqual(officeBenchmarkVisualPolicy({ format: 'xlsx', totalCells: 50_000 }), { mode: 'full' });
  assert.equal(officeBenchmarkVisualPolicy({ format: 'xlsx', totalCells: 50_001 }).mode, 'performance-only');
  assert.deepEqual(officeBenchmarkVisualPolicy({ format: 'pptx', totalCells: 500_000 }), { mode: 'full' });
});

test('styled XLSX cursors keep their selector and cap detailed pages at 500 cells', () => {
  const session = { id: 'office_1', format: 'xlsx', snapshotVersion: 0 };
  const request = createOfficeSnapshotRequest(session, { includeStyles: true, includeSelection: true, limit: 10_000 });
  assert.equal(request.limit, 500);
  assert.equal(request.includeSelection, true);
  const document = { pagination: { nextOffset: 500 } };
  finalizeOfficeSnapshotPage(document, session, request);
  const continued = createOfficeSnapshotRequest(session, { cursor: document.pagination.nextCursor });
  assert.equal(continued.limit, 500);
  assert.equal(continued.includeStyles, true);
  assert.equal(continued.includeSelection, true);
});

test('describe exposes backend-aware advanced object operations', async () => {
  const summary = value(await executeOfficeTool({ action: 'describe' }));
  assert.equal(summary.formats.xlsx.operations, undefined);
  assert.ok(summary.formats.xlsx.operationCount > 0);
  assert.match(summary.nextAction, /When discovery is needed/);
  const described = value(await executeOfficeTool({ action: 'describe', format: 'xlsx' }));
  assert.match(described.nextAction, /If exact fields are unknown/);
  for (const action of ['create', 'attach', 'secure']) assert.ok(described.actions.includes(action), action);
  assert.ok(described.operations.includes('add_chart'));
  assert.ok(described.operations.includes('add_pivot_table'));
  assert.ok(described.operations.includes('insert_rows'));
  assert.ok(described.operations.includes('define_name'));
  assert.ok(described.operations.includes('add_provenance'));
  assert.deepEqual(described.properties.cellStyle, ['fontName', 'fontSize', 'bold', 'italic', 'color', 'fillColor', 'numberFormat']);
  const powerpoint = value(await executeOfficeTool({ action: 'describe', format: 'pptx' }));
  assert.ok(powerpoint.operations.includes('add_shape'));
  assert.ok(powerpoint.operations.includes('add_table'));
  assert.ok(powerpoint.operations.includes('set_chart_data'));
  assert.ok(powerpoint.operations.includes('add_provenance'));
  const word = value(await executeOfficeTool({ action: 'describe', format: 'docx' }));
  assert.ok(word.operations.includes('insert_toc'));
  assert.ok(word.operations.includes('add_page_numbers'));
  assert.ok(word.operations.includes('add_provenance'));
  assert.match(word.observation.selection, /active/i);
  const macroWorkbook = value(await executeOfficeTool({ action: 'describe', format: 'xlsm' }));
  assert.ok(macroWorkbook.operations.includes('insert_rows'));
  const csv = value(await executeOfficeTool({ action: 'describe', format: 'csv' }));
  assert.ok(csv.operations.includes('set_range'));
  assert.ok(!csv.operations.includes('set_style'));
});

test('describe returns compact operation contracts and actionable input errors', async () => {
  const chart = value(await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    backend: 'microsoft-office-com',
    operation: 'add_chart',
  }));
  assert.deepEqual(chart.operation.input.required, ['op', 'range']);
  assert.ok(chart.operation.input.optional.includes('chartType'));
  assert.equal(chart.operation.supported, true);
  assert.deepEqual(chart.operation.supportedBackends, ['microsoft-office-com']);
  assert.deepEqual(chart.operation.properties.chart, ['chartType', 'left', 'top', 'width', 'height', 'title']);

  const portableComment = value(await executeOfficeTool({
    action: 'describe',
    format: 'docx',
    backend: 'mixdog-ooxml',
    operation: 'add_comment',
  }));
  assert.equal(portableComment.operation.supported, false);
  assert.deepEqual(portableComment.operation.supportedBackends, ['microsoft-office-com']);

  const invalid = await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    operation: 'add_chrt',
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Did you mean: add_chart/);
});

test('operation registry matches every COM implementation and rejects unknown fields before dispatch', async () => {
  const source = await readFile(new URL('./office-com-host.ps1', import.meta.url), 'utf8');
  const sections = [
    ['docx', 'function Apply-WordOperation', 'function Excel-Sheet'],
    ['xlsx', 'function Apply-ExcelOperation', 'function Ppt-Slide'],
    ['pptx', 'function Apply-PowerPointOperation', 'function Apply-Operations'],
  ];
  for (const [format, startMarker, endMarker] of sections) {
    const start = source.indexOf(startMarker);
    const block = source.slice(start, source.indexOf(endMarker, start + startMarker.length));
    const implemented = [...block.matchAll(/^\s{4}'([a-z][a-z0-9_]*)'\s*\{/gm)]
      .map((match) => match[1])
      .sort();
    const described = describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
    }).operations.sort();
    assert.deepEqual(described, implemented, `${format} registry drifted from the COM backend`);
    for (const operation of described) {
      const targeted = describeOfficeCapabilities({
        format,
        backend: 'microsoft-office-com',
        operation,
      }).operation;
      assert.equal(targeted.input.required[0], 'op');
      assert.ok(targeted.supportedBackends.includes('microsoft-office-com'));
    }
  }
  assert.throws(
    () => assertOfficeOperationContracts({
      format: 'pdf',
      backend: 'mixdog-pdf',
      operations: [{ op: 'compress', alowNoChange: true }],
    }),
    /unknown field\(s\): alowNoChange.*alowNoChange→allowNoChange/,
  );
});

test('Office contract benchmark avoids broad catalogs and retries', async () => {
  const report = await runOfficeContractBenchmark();
  assert.equal(report.accurate, true);
  assert.equal(report.retries, 0);
  assert.equal(report.unnecessaryRereads, 0);
  assert.equal(report.broadCatalogMaterializations, 0);
  assert.deepEqual(report.requirementFulfillment, { passed: 4, total: 4, rate: 1 });
});

test('portable workbook recalculation is skipped without formulas and blocks unsafe containers', async (t) => {
  const cwd = await workspace(t);
  const plain = join(cwd, 'plain.xlsx');
  await writeZip(plain, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  const skipped = await recalculateLibreOfficeWorkbook(plain, { force: true });
  assert.deepEqual(skipped, {
    needed: false,
    recalculated: false,
    formulaCount: 0,
    missingCachedValues: 0,
  });

  const macro = join(cwd, 'formula.xlsm');
  await writeZip(macro, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
  });
  const blocked = await recalculateLibreOfficeWorkbook(macro, { force: true });
  assert.equal(blocked.needed, true);
  assert.equal(blocked.recalculated, false);
  assert.match(blocked.reason, /supports \.xlsx only/);
});

test('CSV and TSV sessions preserve delimiters, transactions, and formula-like value warnings', async (t) => {
  const cwd = await workspace(t);
  for (const format of ['csv', 'tsv']) {
    const path = join(cwd, `table.${format}`);
    const created = value(await executeOfficeTool({
      action: 'create',
      path,
      format,
    }, { cwd }));
    assert.equal(created.backend, 'mixdog-tabular');
    assert.equal(created.fileKind, format);
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], [format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted', 1]] },
        { op: 'append_row', values: ['formula', '=SUM(1,2)'] },
        { op: 'insert_columns', column: 2, count: 1 },
        { op: 'set_cell', cell: 'B1', value: 'inserted' },
      ],
    }, { cwd }));
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
    assert.equal(snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'A2').value, format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted');
    assert.equal(snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'B1').value, 'inserted');
    const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
    assert.equal(validation.ok, true);
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    assert.ok(issues.issues.some((issue) => issue.code === 'formula_like_value'));
    value(await executeOfficeTool({ action: 'begin', session: created.session }, { cwd }));
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_cell', sheet: 'table', cell: 'A1', value: 'temporary' }],
    }, { cwd }));
    value(await executeOfficeTool({ action: 'rollback', session: created.session }, { cwd }));
    const restored = value(await executeOfficeTool({
      action: 'get',
      session: created.session,
      target: '/sheet[table]/cell[A1]',
    }, { cwd }));
    assert.equal(restored.element.value, 'name');
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_cell', cell: 'C3', value: 'formula text' }],
    }, { cwd }));
    const finalized = value(await executeOfficeTool({
      action: 'finalize',
      session: created.session,
    }, { cwd }));
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.closed, true);
    assert.equal(finalized.review.preview.visualCoverage.mode, 'structural');
    assert.equal(finalized.review.preview.visualCoverage.complete, true);
    assert.equal(finalized.review._images, undefined);
  }
});

test('portable XLSM edits preserve VBA payload and strict package relationships', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'macro.xlsm');
  const output = join(cwd, 'macro-copy.xlsm');
  const vba = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]);
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': vba,
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.fileKind, 'xlsm');
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'macro-safe' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.macros, ['xl/vbaProject.bin']);
  assert.deepEqual(validation.baseline.lostProtectedParts, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.deepEqual(await zip.file('xl/vbaProject.bin').async('nodebuffer'), vba);
});

test('portable DOCX preserves the package while replacing split runs and appending text', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.docx');
  const output = join(cwd, 'edited.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/media/untouched.bin': Buffer.from([1, 2, 3, 4]),
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-ooxml');
  const described = value(await executeOfficeTool({
    action: 'describe',
    session: opened.session,
  }, { cwd }));
  assert.ok(described.operations.includes('set_paragraph_style'));
  assert.ok(described.operations.includes('fill_template'));
  assert.ok(!described.unsupportedInBackend.includes('set_paragraph_style'));
  assert.ok(described.unsupportedInBackend.includes('add_comment'));

  const begun = value(await executeOfficeTool({
    action: 'begin',
    session: opened.session,
  }, { cwd }));
  assert.equal(begun.transaction.diff.summary.total, 0);
  const temporary = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Temporary transaction text' }],
  }, { cwd }));
  assert.ok(temporary.transaction.diff.summary.modified > 0);
  const blockedSave = await executeOfficeTool({ action: 'save', session: opened.session }, { cwd });
  assert.equal(blockedSave.isError, true);
  assert.match(blockedSave.content[0].text, /Commit or roll back/);
  const blockedClose = await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
  assert.equal(blockedClose.isError, true);
  const transactionDiff = value(await executeOfficeTool({
    action: 'diff',
    session: opened.session,
  }, { cwd }));
  assert.ok(transactionDiff.transaction.diff.changes.some((change) => change.path === '/body/p[1]'));
  resetOfficeSessionsForTest();
  const pending = value(await executeOfficeTool({ action: 'transactions' }, { cwd }));
  assert.equal(pending.transactions[0].id, begun.transaction.id);
  assert.equal(pending.transactions[0].phase, 'active');
  const rolledBack = value(await executeOfficeTool({
    action: 'recover',
    transaction: begun.transaction.id,
    strategy: 'rollback',
  }, { cwd }));
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.remainingDiff.summary.total, 0);
  assert.equal(value(await executeOfficeTool({ action: 'transactions' }, { cwd })).transactions.length, 0);

  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'replace_text', find: 'Hello World', replace: '안녕하세요' },
      { op: 'append_text', text: 'Tail paragraph' },
      { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Path cell' },
    ],
  }, { cwd }));
  assert.equal(edited.atomic, true);
  assert.equal(edited.results[0].count, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const text = JSON.stringify(snapshot.document);
  assert.match(text, /안녕하세요/);
  assert.match(text, /Tail paragraph/);
  assert.equal(snapshot.document.paragraphs[0].path, '/body/p[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].path, '/body/tbl[1]/row[1]/cell[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Path cell');

  const firstParagraph = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/body/p[1]',
  }, { cwd }));
  assert.equal(firstParagraph.element.text, '안녕하세요');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_paragraph_text', paragraph: 1, text: 'Path edited' },
      { op: 'set_paragraph_style', paragraph: 1, style: 'Heading1' },
    ],
  }, { cwd }));
  const queried = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    query: 'Path edited',
  }, { cwd }));
  assert.equal(queried.matches[0].path, '/body/p[1]');

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.validation, 'opc-relationships-content-types-xml');
  assert.deepEqual(validation.missingRelationships, []);
  assert.deepEqual(validation.malformedXml, []);

  const zip = await JSZip.loadAsync(await readFile(output));
  assert.match(await zip.file('word/document.xml').async('string'), /<w:pStyle w:val="Heading1"\/>/);
  assert.deepEqual(await zip.file('word/media/untouched.bin').async('nodebuffer'), Buffer.from([1, 2, 3, 4]));

  const beforeExternalEdit = await readFile(output);
  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  const externalZip = await JSZip.loadAsync(beforeExternalEdit);
  externalZip.file('word/document.xml', (await externalZip.file('word/document.xml').async('string')).replace('Path edited', 'Outside edit'));
  await writeFile(output, await externalZip.generateAsync({ type: 'nodebuffer' }));
  const conflicted = await executeOfficeTool({ action: 'diff', session: opened.session }, { cwd });
  assert.equal(conflicted.isError, true);
  const conflictValue = JSON.parse(conflicted.content[0].text);
  assert.equal(conflictValue.code, 'transaction_conflict');
  assert.ok(conflictValue.externalDiff.summary.modified > 0);
  await writeFile(output, beforeExternalEdit);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));
});

test('portable DOCX set creates editable runs in empty paragraphs', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'empty-paragraphs.docx');
  const output = join(cwd, 'edited-empty-paragraphs.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Self-closing paragraph' }],
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 2, text: 'Styled empty paragraph' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Self-closing paragraph');
  assert.equal(snapshot.document.paragraphs[1].text, 'Styled empty paragraph');
  assert.equal(snapshot.document.paragraphs[1].style, 'Normal');
});

test('strict OOXML validation rejects missing relationship targets', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'broken.docx');
  const output = join(cwd, 'broken-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="image" Target="media/missing.png"/></Relationships>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.missingRelationships[0].resolved, 'word/media/missing.png');
});

test('portable DOCX snapshots structured comments and revisions', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'review.docx');
  const output = join(cwd, 'review-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Anchored text</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p><w:p><w:ins w:id="8" w:author="Editor" w:date="2026-08-27T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="9" w:author="Editor"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p></w:body></w:document>',
    'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-08-27T00:00:00Z"><w:p><w:r><w:t>Needs source</w:t></w:r></w:p></w:comment></w:comments>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.document.commentCount, 1);
  assert.deepEqual(opened.document.comments[0], {
    path: '/body/comment[1]',
    index: 1,
    id: '7',
    author: 'Reviewer',
    initials: 'RV',
    date: '2026-08-27T00:00:00Z',
    text: 'Needs source',
    anchoredText: 'Anchored text',
    part: 'word/document.xml',
  });
  assert.equal(opened.document.revisionCount, 2);
  assert.equal(opened.document.revisions[0].type, 'insertion');
  assert.equal(opened.document.revisions[0].text, 'Inserted');
  assert.equal(opened.document.revisions[1].type, 'deletion');
  assert.equal(opened.document.revisions[1].text, 'Deleted');
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_comments'));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_revisions'));
});

test('portable DOCX fills split template tokens across stories and rolls back strict failures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'template.docx');
  const output = join(cwd, 'filled.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{ na</w:t></w:r><w:r><w:t>me }}</w:t></w:r></w:p><w:p><w:r><w:t>{{missing}}</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Owner: {{ owner }}</w:t></w:r></w:p></w:hdr>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const rejected = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team' }, strict: true }],
  }, { cwd });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /missing/);
  const beforeFill = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(beforeFill.document), /\{\{ name }}/);

  const filled = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team', missing: 'Done' }, strict: true }],
  }, { cwd }));
  assert.deepEqual(filled.results[0].unfilledTokens, []);
  assert.deepEqual(filled.results[0].filled, { name: 1, missing: 1, owner: 1 });
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(snapshot.document), /Ada/);
  assert.match(JSON.stringify(snapshot.document), /Owner: Team/);
  assert.doesNotMatch(JSON.stringify(snapshot.document), /\{\{/);
});

test('portable XLSX edits cells, ranges, formulas, and appended rows', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.xlsx');
  const output = join(cwd, 'edited.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="InputRange">Data!$B$1:$C$2</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Old</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E1:E3"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'New' },
      { op: 'set_range', sheet: 'Data', range: 'B1:C2', values: [[1, 2], [3, 4]] },
      { op: 'set_formula', sheet: 'Data', cell: 'D1', formula: '=SUM(B1:C2)' },
      { op: 'append_row', sheet: 'Data', values: ['tail', 5] },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const cells = snapshot.document.sheets[0].cells;
  assert.equal(cells.find((cell) => cell.ref === 'A1').value, 'New');
  assert.equal(cells.find((cell) => cell.ref === 'C2').value, '4');
  assert.equal(cells.find((cell) => cell.ref === 'D1').formula, 'SUM(B1:C2)');
  assert.equal(cells.find((cell) => cell.ref === 'D1').cachedValue, null);
  assert.equal(cells.find((cell) => cell.ref === 'D1').cacheState, 'missing');
  assert.equal(cells.find((cell) => cell.value === 'tail').ref, 'A3');
  assert.equal(cells.find((cell) => cell.ref === 'A1').path, '/sheet[Data]/cell[A1]');
  assert.equal(snapshot.document.formulaCount, 1);
  assert.equal(snapshot.document.formulaCacheMissing, 1);
  assert.equal(snapshot.document.needsRecalculation, true);
  assert.deepEqual(snapshot.document.calculation, {
    mode: 'auto',
    fullCalcOnLoad: true,
    forceFullCalc: true,
  });
  assert.equal(snapshot.document.definedNameCount, 1);
  assert.equal(snapshot.document.definedNames[0].name, 'InputRange');
  assert.equal(snapshot.document.definedNames[0].refersTo, 'Data!$B$1:$C$2');
  assert.equal(snapshot.document.sheets[0].validationCount, 1);
  assert.deepEqual(snapshot.document.sheets[0].validations[0].ranges, ['E1:E3']);
  assert.equal(snapshot.document.sheets[0].validations[0].formula1, '"Yes,No"');

  for (const operation of [
    { op: 'set_range', sheet: 'Data', range: 'A1:XFD1048576', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'C2:B1', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'B5:C6', values: [[1, 2]] },
    { op: 'set_cell', sheet: 'Data', cell: 'XFE1', value: 'outside' },
  ]) {
    const rejected = await executeOfficeTool({
      action: 'batch',
      session: opened.session,
      operations: [operation],
    }, { cwd });
    assert.equal(rejected.isError, true);
  }

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'Path set' }],
  }, { cwd }));
  const cell = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/sheet[Data]/cell[A1]',
  }, { cwd }));
  assert.equal(cell.element.value, 'Path set');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'E1', value: '#REF!' }],
  }, { cwd }));
  const issues = value(await executeOfficeTool({
    action: 'issues',
    session: opened.session,
  }, { cwd }));
  assert.equal(issues.ok, false);
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_cache_missing' && issue.path === '/sheet[Data]/cell[D1]'));
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Data]/cell[E1]'));

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'F1', value: 'Committed' }],
  }, { cwd }));
  let approvalRequest;
  const deniedCommit = await executeOfficeTool(
    { action: 'commit', session: opened.session },
    {
      cwd,
      requestApproval: async (request) => {
        approvalRequest = request;
        return { approved: false, reason: 'review first' };
      },
    },
  );
  assert.equal(deniedCommit.isError, true);
  assert.equal(JSON.parse(deniedCommit.content[0].text).code, 'transaction_approval_denied');
  assert.equal(approvalRequest.args.action, 'commit');
  assert.ok(approvalRequest.args.transaction.diff.summary.added > 0);
  const committed = value(await executeOfficeTool(
    { action: 'commit', session: opened.session },
    { cwd, requestApproval: async () => ({ approved: true }) },
  ));
  assert.equal(committed.committed, true);
  assert.ok(committed.transaction.diff.summary.added > 0);
});

test('portable PPTX fills template tokens while preserving masters and layouts', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pptx');
  const output = join(cwd, 'edited.pptx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{{ti</a:t></a:r><a:r><a:t>tle}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Owner {{owner}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Layout"/></p:sldLayout>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'fill_template', tokens: { title: 'Mixdog', owner: '재영' }, strict: true },
      { op: 'add_textbox', slide: 1, text: 'Second box', left: 20, top: 40, width: 200, height: 50 },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.deepEqual(snapshot.document.slides[0].text, ['Mixdog', 'Second box']);
  assert.equal(snapshot.document.slides[0].shapes[0].path, '/slide[1]/shape[1]');
  assert.equal(snapshot.document.layoutCount, 1);
  assert.equal(snapshot.document.layouts[0].name, 'Brand Layout');
  const packageAfterFill = await JSZip.loadAsync(await readFile(output));
  assert.equal(await packageAfterFill.file('ppt/slideMasters/slideMaster1.xml').async('string'), '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>');
  assert.match(await packageAfterFill.file('ppt/notesSlides/notesSlide1.xml').async('string'), /Owner 재영/);

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_text', slide: 1, shape: 1, text: 'Path shape' },
      { op: 'delete_shape', slide: 1, shape: 2 },
    ],
  }, { cwd }));
  const updated = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(updated.document.slides[0].shapes[0].text, 'Path shape');
  assert.equal(updated.document.slides[0].shapes.length, 1);
});

test('PDF backend edits and validates without Microsoft Office', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pdf');
  const output = join(cwd, 'edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'auto',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-pdf');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_text', page: 1, text: 'PDF edited', x: 20, y: 20, size: 14 },
      { op: 'rotate_pages', pages: [1], rotation: 90 },
      { op: 'set_metadata', properties: { title: 'Mixdog PDF' } },
    ],
  }, { cwd }));

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.pages, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.pageCount, 1);
  assert.equal(snapshot.document.pages[0].path, '/page[1]');

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: 'Visual QA delta', x: 30, y: 60, size: 16 }],
  }, { cwd }));
  const qaResult = await executeOfficeTool({
    action: 'qa',
    session: opened.session,
    output: join(cwd, 'qa-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const qa = value(qaResult);
  assert.equal(qa.review.visualDiff.available, true);
  assert.ok(qa.review.visualDiff.changedPercent > 0);
  assert.ok(qaResult.content.filter((item) => item.type === 'image').length >= 2);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));

  const renderedResult = await executeOfficeTool({
    action: 'render',
    session: opened.session,
    output: join(cwd, 'preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const rendered = value(renderedResult);
  assert.equal(rendered.images.length, 1);
  assert.equal(renderedResult.content[1].type, 'image');
  assert.equal(renderedResult.content[1].source.media_type, 'image/png');

  const finalizedResult = await executeOfficeTool({
    action: 'finalize',
    session: opened.session,
    output: join(cwd, 'final-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const finalized = value(finalizedResult);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.review._images, undefined);
  assert.equal(finalizedResult.content.filter((item) => item.type === 'image').length, 1);
});

test('PDF rendering compresses long documents into at most 12 contact sheets with full coverage', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'thirteen-pages.pdf');
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 13; page += 1) pdf.addPage([200, 120]);
  await writeFile(path, await pdf.save());

  const rendered = await renderPdfPages(path, { maxWidth: 200 });
  assert.equal(rendered.pageCount, 13);
  assert.equal(rendered.images.length, 7);
  assert.deepEqual(rendered.images[0].pages, [1, 2]);
  assert.deepEqual(rendered.visualCoverage, {
    reviewedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    reviewed: 13,
    total: 13,
    complete: true,
    remainingPages: [],
  });
});

test('PDF text edits embed an explicit Unicode font for non-Latin text', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const cwd = await workspace(t);
  const source = join(cwd, 'unicode-source.pdf');
  const output = join(cwd, 'unicode-edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: '한글-日本語-中文', x: 30, y: 60, size: 16, fontPath }],
  }, { cwd }));
  assert.equal(edited.results[0].fontEmbedded, true);
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
    pages: [1],
  }, { cwd }));
  assert.match(JSON.stringify(snapshot.document.pages), /한글/);
});

test('snapshot pagination uses opaque cursors and rejects stale continuations', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'large.csv');
  const created = value(await executeOfficeTool({ action: 'create', path, format: 'csv' }, { cwd }));
  const values = Array.from({ length: 2_505 }, (_, index) => [`row-${index + 1}`]);
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_range', range: 'A1:A2505', values }],
  }, { cwd }));
  const first = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    limit: 1_000,
  }, { cwd }));
  const firstReturned = first.document.pagination.returned;
  assert.ok(firstReturned > 0 && firstReturned <= 1_000);
  assert.equal(first.document.sheets[0].cells.length, firstReturned);
  assert.equal(first.document.pagination.hasMore, true);
  assert.ok(first.document.pagination.nextCursor);
  const second = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    cursor: first.document.pagination.nextCursor,
  }, { cwd }));
  assert.equal(second.document.sheets[0].cells[0].ref, `A${firstReturned + 1}`);
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_cell', sheet: 'large', cell: 'A1', value: 'changed' }],
  }, { cwd }));
  const stale = await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    cursor: second.document.pagination.nextCursor,
  }, { cwd });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale/i);
});

test('Office Use returns a typed cancellation result before starting work', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeOfficeTool({ action: 'detect' }, { signal: controller.signal });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: 'cancelled',
    message: 'Office Use operation was cancelled',
  });
});

test('PDF create lints forms, reports OCR handoff, and preserves attachments', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'created.pdf');
  const attachment = join(cwd, 'source.txt');
  await writeFile(attachment, 'attached evidence', 'utf8');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Frontier PDF' },
      { type: 'paragraph', text: 'Structured document body.' },
      { type: 'pagebreak' },
    ],
    fields: [
      { name: 'Reviewer', type: 'text', page: 1, x: 50, y: 650, width: 180, height: 24, value: 'Mixdog' },
      { name: 'Approved', type: 'checkbox', page: 1, x: 240, y: 650, width: 18, height: 18, value: true },
    ],
    properties: { title: 'Frontier PDF' },
  }, { cwd }));
  assert.equal(created.created, true);
  assert.equal(created.artifacts[0].type, 'pdf');
  assert.equal(created.outputCount, 1);
  assert.equal(created.document.fieldCount, 2);
  assert.ok(created.document.likelyScannedPages.includes(2));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'add_attachment', path: attachment, name: 'evidence.txt', description: 'Source evidence' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    pages: [1],
  }, { cwd }));
  assert.equal(snapshot.document.metadata.title, 'Frontier PDF');
  assert.equal(snapshot.document.fieldCount, 2);
  assert.equal(snapshot.document.attachmentCount, 1);
  assert.equal(snapshot.document.attachments[0].name, 'evidence.txt');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'ocr_required' && issue.path === '/page[2]'));
});

test('macro and digital-signature containers expose security inventory and fail invalidated signatures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'signed.xlsm');
  const output = join(cwd, 'signed-copy.xlsm');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]),
    '_xmlsignatures/origin.sigs': Buffer.from([1, 2, 3]),
    '_xmlsignatures/sig1.xml': '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'edited' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.security.macroExecution, 'disabled');
  assert.equal(validation.security.macros.length, 1);
  assert.equal(validation.security.signatures.length, 2);
  assert.equal(validation.security.digitalSignatureInvalidated, true);
});
