import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { officeBenchmarkSnapshotRequest, officeBenchmarkVisualPolicy } from './bench/benchmark.mjs';
import { OFFICE_ACTIONS, describeOfficeCapabilities } from './capabilities.mjs';
import { runOfficeContractBenchmark } from './bench/contract-benchmark.mjs';
import { executeOfficeTool } from './index.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './core/pagination.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';
import { value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

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
  assert.match(TOOL_DEFS[0].description, /Direct:/);
  assert.match(TOOL_DEFS[0].description, /finalize:true/);
  assert.match(TOOL_DEFS[0].description, /all known operations in one ordered array/);
  assert.match(TOOL_DEFS[0].description, /Inspect unfamiliar existing files first/);
  assert.match(TOOL_DEFS[0].description, /no snapshot unless/);
  assert.match(TOOL_DEFS[0].description, /Describe only unknown/);
  const deferredLead = TOOL_DEFS[0].description.slice(0, 220);
  assert.match(deferredLead, /finalize:true/);
  assert.match(deferredLead, /XLSX\/CSV\/TSV set_range/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.action.description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /every operation whose inputs are known/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /Call describe only when/);
  assert.equal(TOOL_DEFS[0].inputSchema.properties.finalize.type, 'boolean');
  assert.match(TOOL_DEFS[0].inputSchema.properties.review.description, /Keep enabled for deliverables/);
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('visible'));
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('attach'));
  assert.match(TOOL_DEFS[0].inputSchema.properties.mode.description, /auto defaults to background/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.mode.description, /Only explicit attach/);
  assert.equal(TOOL_DEFS[0].inputSchema.properties.requireChanges.type, 'boolean');
  assert.deepEqual(TOOL_DEFS[0].inputSchema.properties.failOn.enum, ['error', 'warning']);
  const descriptionChars = [
    TOOL_DEFS[0].description,
    ...Object.values(TOOL_DEFS[0].inputSchema.properties).map((property) => property.description || ''),
  ].reduce((total, description) => total + description.length, 0);
  assert.ok(descriptionChars <= 5000, `Office schema descriptions grew to ${descriptionChars} characters`);
  assert.ok(JSON.stringify(TOOL_DEFS[0].inputSchema).length <= 7000, 'Office input schema exceeded its size budget');
});

test('removed mutation actions remain rejected', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'removed-actions.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
  }, { cwd }));
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
  assert.ok(described.operations.includes('set_sheet_visibility'));
  assert.deepEqual(described.properties.cellStyle, [
    'fontName',
    'fontSize',
    'bold',
    'italic',
    'color',
    'fillColor',
    'numberFormat',
    'horizontalAlignment',
    'verticalAlignment',
    'wrapText',
  ]);
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
  assert.deepEqual(chart.operation.supportedBackends, ['microsoft-office-com', 'mixdog-ooxml']);
  assert.deepEqual(chart.operation.properties.chart, [
    'chartType',
    'left',
    'top',
    'width',
    'height',
    'title',
    'seriesColors',
    'showValues',
    'showLegend',
    'zeroBaseline',
    'valueNumberFormat',
    'dataLabelPosition',
    'dataLabelColor',
  ]);

  const portableAnimation = value(await executeOfficeTool({
    action: 'describe',
    format: 'pptx',
    backend: 'mixdog-ooxml',
    operation: 'add_animation',
  }));
  assert.equal(portableAnimation.operation.supported, true);
  assert.deepEqual(portableAnimation.operation.supportedBackends, ['microsoft-office-com', 'mixdog-ooxml']);
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const portable = describeOfficeCapabilities({ format, backend: 'mixdog-ooxml' });
    assert.deepEqual(
      portable.unsupportedInBackend,
      [],
      `every ${format} operation runs without Microsoft Office`,
    );
  }

  const invalid = await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    operation: 'add_chrt',
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Did you mean: add_chart/);
});

test('Office contract benchmark avoids broad catalogs and retries', async () => {
  const report = await runOfficeContractBenchmark();
  assert.equal(report.accurate, true);
  assert.equal(report.retries, 0);
  assert.equal(report.unnecessaryRereads, 0);
  assert.equal(report.broadCatalogMaterializations, 0);
  assert.deepEqual(report.requirementFulfillment, { passed: 4, total: 4, rate: 1 });
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
