import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officeBenchmarkSnapshotRequest, officeBenchmarkVisualPolicy } from './bench/benchmark.mjs';
import { OFFICE_ACTIONS, assertOfficeOperationContracts, describeOfficeCapabilities } from './capabilities.mjs';
import { runOfficeContractBenchmark } from './bench/contract-benchmark.mjs';
import { executeOfficeTool } from './index.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './core/pagination.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';
import { value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('office is a first-class built-in tool with stateful document actions', () => {
  assert.equal(TOOL_DEFS.length, 1);
  assert.equal(TOOL_DEFS[0].name, 'office');
  assert.deepEqual(TOOL_DEFS[0].inputSchema.properties.action.enum, OFFICE_ACTIONS);
  for (const removed of ['set', 'add', 'remove', 'move']) {
    assert.equal(TOOL_DEFS[0].inputSchema.properties.action.enum.includes(removed), false);
  }
  for (const removed of ['type', 'text', 'value', 'values', 'formula', 'to', 'index']) {
    assert.equal(Object.hasOwn(TOOL_DEFS[0].inputSchema.properties, removed), false);
  }
  assert.match(TOOL_DEFS[0].description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].description, /untrusted data/);
  // Method and policy live in the format skills; the description is contract only.
  assert.doesNotMatch(
    TOOL_DEFS[0].description,
    /Inspect unfamiliar|Split only|Describe only|same turn|design\.content|never runs VBA|Keep review/
  );
  const deferredLead = TOOL_DEFS[0].description.slice(0, 220);
  assert.match(deferredLead, /XLSX\/CSV\/TSV set_range/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.action.description, /\bsecure\b/);
  assert.doesNotMatch(TOOL_DEFS[0].inputSchema.properties.action.description, /media tool/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /per the format skill/);
  assert.doesNotMatch(
    TOOL_DEFS[0].inputSchema.properties.operations.description,
    /every operation whose inputs|compose_document|fill_template|Unicode font/
  );
  assert.equal(TOOL_DEFS[0].inputSchema.properties.finalize.type, 'boolean');
  assert.equal(TOOL_DEFS[0].inputSchema.properties.review.type, 'boolean');
  assert.doesNotMatch(TOOL_DEFS[0].inputSchema.properties.review.description, /deliverables/);
  assert.equal(TOOL_DEFS[0].inputSchema.properties.acknowledgeUntrustedContent.type, 'boolean');
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
  assert.ok(descriptionChars <= 3500, `Office schema descriptions grew to ${descriptionChars} characters`);
  assert.ok(JSON.stringify(TOOL_DEFS[0].inputSchema).length <= 7000, 'Office input schema exceeded its size budget');
});

// Split pages and rendered images write into a folder, so a caller points
// output at one here too. Copying the document onto a directory failed with an
// OS copy error that named neither the field nor the document.
test('output names the file to write, and says so when a folder is passed', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'report.csv');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: source,
        format: 'csv',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['지점', '출고'],
              ['대전', 1240],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const folder = join(cwd, 'out');
  await mkdir(folder, { recursive: true });
  const refused = await executeOfficeTool({ action: 'open', path: source, output: folder, mode: 'portable' }, { cwd });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /output is the file to write, not a folder/);
  assert.match(refused.content[0].text, /report\.mixdog-edit\.csv/);
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: source,
        output: join(folder, 'edited.csv'),
        mode: 'portable',
      },
      { cwd }
    )
  );
  assert.match(opened.output, /edited\.csv$/);
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
});

// Measured against the widest row, one line with an unquoted separator made
// every well-formed row — the header included — read as ragged, and the sheet
// a caller was answered with carried the name of our working copy.
test('a delimited file reports the rows that break its shape, under its own name', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'hubs.csv');
  await writeFile(
    path,
    '지점,출고,비고\n대전,48210,정상\n광주,31880\n부산,40120,=HYPERLINK("http://example.com","확인")\n',
    'utf8'
  );
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const audited = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.deepEqual(
    audited.issues.filter((issue) => issue.code === 'ragged_row').map((issue) => issue.path),
    ['/row[3]', '/row[4]'],
    JSON.stringify(audited.issues)
  );
  assert.match(audited.issues.find((issue) => issue.path === '/row[4]').message, /unquoted separator/);
  const risky = audited.issues.find((issue) => issue.code === 'formula_like_value');
  assert.equal(risky.path, '/sheet[hubs]/cell[C4]', risky.path);
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

  // A negative figure opens with the same character as an injected formula. A
  // column of them reported as risky buries the one cell that is.
  const figures = join(cwd, 'figures.csv');
  await writeFile(figures, '지점,증감\n대전,-5.5\n광주,+3.2\n서울,=2+2\n제주,-2+3\n', 'utf8');
  const numeric = value(await executeOfficeTool({ action: 'open', path: figures, mode: 'portable' }, { cwd }));
  const scanned = value(await executeOfficeTool({ action: 'issues', session: numeric.session }, { cwd }));
  assert.deepEqual(
    scanned.issues.filter((issue) => issue.code === 'formula_like_value').map((issue) => issue.path),
    ['/sheet[figures]/cell[B4]', '/sheet[figures]/cell[B5]'],
    JSON.stringify(scanned.issues)
  );
  value(await executeOfficeTool({ action: 'close', session: numeric.session }, { cwd }));
});

test('removed mutation actions remain rejected', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'removed-actions.csv');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'csv',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['name', 'value'],
              ['alpha', 1],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  for (const removed of ['set', 'add', 'remove', 'move']) {
    const rejected = await executeOfficeTool(
      {
        action: removed,
        session: created.session,
      },
      { cwd }
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unsupported Office Use action/);
  }
  const finalized = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: created.session,
        review: false,
      },
      { cwd }
    )
  );
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
    'indent',
    'locked',
    'borders',
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
  const chart = value(
    await executeOfficeTool({
      action: 'describe',
      format: 'xlsx',
      backend: 'microsoft-office-com',
      operation: 'add_chart',
    })
  );
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

  const portableAnimation = value(
    await executeOfficeTool({
      action: 'describe',
      format: 'pptx',
      backend: 'mixdog-ooxml',
      operation: 'add_animation',
    })
  );
  assert.equal(portableAnimation.operation.supported, true);
  assert.deepEqual(portableAnimation.operation.supportedBackends, ['microsoft-office-com', 'mixdog-ooxml']);
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const portable = describeOfficeCapabilities({ format, backend: 'mixdog-ooxml' });
    assert.deepEqual(portable.unsupportedInBackend, [], `every ${format} operation runs without Microsoft Office`);
  }

  const invalid = await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    operation: 'add_chrt',
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Did you mean: add_chart/);
});

test('an operation error suggests a field only when it reads as a typo', async () => {
  const reject = async (operation) => {
    try {
      assertOfficeOperationContracts({ format: 'xlsx', backend: 'mixdog-ooxml', operations: [operation] });
    } catch (error) {
      return error.message;
    }
    throw new assert.AssertionError({ message: `operation was accepted: ${JSON.stringify(operation)}` });
  };
  // A near miss is corrected; an unrelated field gets the real list instead of
  // a nearest-neighbour guess that would cost another round trip.
  assert.match(await reject({ op: 'add_chart', range: 'A1:B5', chartTipe: 'column' }), /chartTipe→chartType/);
  const unrelated = await reject({ op: 'add_chart', range: 'A1:B5', source: 'A1:B5' });
  assert.doesNotMatch(unrelated, /Did you mean/);
  assert.match(unrelated, /add_chart takes: .*chartType/);
  // An operation missed by its verb still resolves by subject.
  assert.throws(
    () => assertOfficeOperationContracts({ format: 'docx', backend: 'mixdog-ooxml', operations: [{ op: 'add_toc' }] }),
    /Did you mean: insert_toc/
  );
  // A bulleted text box is its paragraphs; text beside them was required and then ignored.
  const box = { op: 'add_textbox', slide: 1, paragraphs: [{ text: '요점', bullet: true }] };
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'pptx', backend: 'mixdog-ooxml', operations: [box] })
  );
  assert.throws(
    () => assertOfficeOperationContracts({ format: 'pptx', backend: 'mixdog-ooxml', operations: [{ op: 'add_textbox', slide: 1 }] }),
    /requires one of: text or paragraphs/
  );
  // A property the writer would drop is rejected rather than silently ignored:
  // otherwise only the rendered page shows that the table was never styled.
  assert.throws(
    () =>
      assertOfficeOperationContracts({
        format: 'docx',
        backend: 'mixdog-ooxml',
        operations: [
          { op: 'add_table', values: [['a']], properties: { name: 'Noto Sans KR', size: 10, repeatHeader: true } },
        ],
      }),
    /unknown properties: name, size.*name→fontName, size→fontSize/
  );
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({
      format: 'docx',
      backend: 'mixdog-ooxml',
      operations: [
        {
          op: 'add_table',
          values: [['a']],
          properties: { fontName: 'Noto Sans KR', fontSize: 10, repeatHeader: true },
        },
      ],
    })
  );
  // A Word table has two alignments: `alignment` places the table on the page,
  // `columnAlignments` sets the text of each column. A list written into the
  // first used to reach the file as an invalid justification that only the
  // schema check at finalize refused.
  const tableAlignment = (properties) => () =>
    assertOfficeOperationContracts({
      format: 'docx',
      backend: 'mixdog-ooxml',
      operations: [{ op: 'add_table', values: [['a', '1']], properties }],
    });
  assert.throws(tableAlignment({ alignment: ['left', 'right'] }), /properties\.columnAlignments: \["left","right"\]/);
  assert.throws(tableAlignment({ alignment: 'middle' }), /must be left, center, right, not "middle"/);
  assert.throws(
    tableAlignment({ columnAlignments: ['left', 'top'] }),
    /columnAlignments is one of left, center, right, justify per column, not "top"/
  );
  assert.throws(tableAlignment({ columnAlignments: 'right' }), /\(an array\), not "right"/);
  const aligned = [
    { op: 'set_table_style', table: 1, properties: { alignment: 'Center', columnAlignments: ['Left', 'RIGHT'] } },
  ];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'docx', backend: 'mixdog-ooxml', operations: aligned })
  );
  assert.deepEqual(aligned[0].properties, { alignment: 'center', columnAlignments: ['left', 'right'] });
  // The same font is spelled fontName on a table and name on a run: the long
  // spelling can mean nothing else, so it reaches the key the run declares
  // rather than costing a round trip on a document already being written.
  const runFont = [
    { op: 'append_text', text: '정시 출고율', properties: { fontNameEastAsia: 'Noto Sans KR', fontSize: 11 } },
  ];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'docx', backend: 'mixdog-ooxml', operations: runFont })
  );
  assert.deepEqual(runFont[0].properties, { nameEastAsia: 'Noto Sans KR', size: 11 });
  // Every other worksheet operation targets `range`, so one cell named that way
  // is taken as the cell it is; a real range is refused with the operation that
  // does write it, instead of "unknown field".
  const single = [
    { op: 'set_formula', range: 'B5', formula: '=B2/B3' },
    { op: 'set_cell', range: "'운영 자료'!D5", value: 620 },
  ];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'xlsx', backend: 'mixdog-ooxml', operations: single })
  );
  assert.deepEqual(
    single.map((operation) => operation.cell),
    ['B5', "'운영 자료'!D5"]
  );
  assert.equal(
    single.every((operation) => operation.range === undefined),
    true
  );
  assert.match(await reject({ op: 'set_cell', range: 'B2:E2', value: 4 }), /writes one cell.*use set_range/s);
  // The same act carries three names across this runtime's own formats (Word
  // add_hyperlink, Excel set_hyperlink, PDF add_link), so a caller who brings
  // one format's name to another reaches the operation instead of rewriting a
  // whole batch. A paragraph added by its obvious name lands the same way.
  const aliased = [
    { op: 'add_paragraph', text: '허브 운영 요약' },
    { op: 'add_link', find: '허브 운영 요약', address: 'https://example.com/ops' },
  ];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'docx', backend: 'mixdog-ooxml', operations: aliased })
  );
  assert.deepEqual(
    aliased.map((operation) => operation.op),
    ['append_text', 'add_hyperlink']
  );
  const worksheet = [{ op: 'add_hyperlink', range: 'A1', url: 'https://example.com/ops' }];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'xlsx', backend: 'mixdog-ooxml', operations: worksheet })
  );
  assert.equal(worksheet[0].op, 'set_hyperlink');
  const stamped = [{ op: 'set_hyperlink', page: 1, find: '허브', url: 'https://example.com/ops' }];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'pdf', backend: 'mixdog-pdf', operations: stamped })
  );
  assert.equal(stamped[0].op, 'add_link');
  // compose_document takes a table as { headers, rows }; compose_sheet takes
  // those two at the top level. A caller writing the document's shape here is
  // writing a sheet with a table in it, and the contract used to answer with
  // "table→tableName", which names something else entirely.
  const composed = [
    {
      op: 'compose_sheet',
      title: '야간 운영 지표',
      table: { headers: ['허브', '정시 출고율'], rows: [['서울', 0.941]] },
    },
  ];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'xlsx', backend: 'mixdog-ooxml', operations: composed })
  );
  assert.deepEqual(composed[0].headers, ['허브', '정시 출고율']);
  assert.deepEqual(composed[0].rows, [['서울', 0.941]]);
  assert.equal(composed[0].table, undefined);
  // Two names for one gesture inside a single format: align_shapes takes align,
  // distribute_shapes takes direction. The word the operation carries reaches
  // its field rather than costing a round trip.
  const spaced = [{ op: 'distribute_shapes', slide: 1, shapes: [2, 3, 4], distribute: 'horizontal' }];
  assert.doesNotThrow(() =>
    assertOfficeOperationContracts({ format: 'pptx', backend: 'mixdog-ooxml', operations: spaced })
  );
  assert.equal(spaced[0].direction, 'horizontal');
  assert.equal(spaced[0].distribute, undefined);
  // An alias is a name for an operation that exists, never a new operation:
  // describe answers with the catalog entry it resolves to.
  assert.equal(
    describeOfficeCapabilities({ format: 'docx', backend: 'mixdog-ooxml', operation: 'add_paragraph' }).operation.name,
    'append_text'
  );
});

// Content handed to create under a field the format does not read wrote an empty
// document and answered "created": the caller spent a turn finding the file blank.
test('create refuses content in a field it never writes, and reads the design it is given', async (t) => {
  const cwd = await workspace(t);
  const refuse = async (args) => {
    const result = await executeOfficeTool({ mode: 'portable', ...args, action: 'create' }, { cwd });
    assert.equal(result.isError, true, `accepted: ${JSON.stringify(args)}`);
    return result.content[0].text;
  };
  assert.match(
    await refuse({
      path: 'a.pdf',
      format: 'pdf',
      operations: [{ op: 'add_text', page: 1, text: '야간', x: 60, y: 700 }],
    }),
    /PDF create writes blocks, not operations/
  );
  assert.match(
    await refuse({ path: 'b.docx', format: 'docx', blocks: [{ type: 'heading', text: '야간 운영' }] }),
    /DOCX create writes operations, not blocks/
  );
  assert.match(
    await refuse({ path: 'c.xlsx', format: 'xlsx', values: [['월', '처리량']] }),
    /takes no top-level values.*set_range/s
  );
  assert.match(
    await refuse({ path: 'd.pptx', format: 'pptx', script: 'const s = light();' }),
    /takes no script.*action:'author'/s
  );
  // Facts and claims say what the deliverable must carry; nothing writes them
  // on their own. The call used to produce an empty file and report success.
  const content = {
    content: {
      objective: '야간 인력 12명 증원 승인',
      facts: [{ id: '정시_출고율', label: '정시 출고율', value: 0.928 }],
    },
  };
  assert.match(
    await refuse({ path: 'f.pptx', format: 'pptx', design: content }),
    /PPTX create writes nothing from design\.content on its own.*action:'author'/s
  );
  assert.match(
    await refuse({ path: 'g.xlsx', format: 'xlsx', design: content }),
    /XLSX create writes nothing from design\.content on its own.*compose_sheet/s
  );
  assert.equal((await readdir(cwd)).length, 0, 'a refused create leaves no file behind');

  // The same content under `design` is the document, not an unknown key.
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: 'e.docx',
        format: 'docx',
        mode: 'portable',
        design: { operations: [{ op: 'append_text', text: '야간 운영 보고' }] },
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results[0].changed, true);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.paragraphs.map((entry) => entry.text),
    ['야간 운영 보고']
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('a failed create leaves no file behind for the retry to trip over', async (t) => {
  const cwd = await workspace(t);
  const failed = await executeOfficeTool(
    {
      action: 'create',
      path: 'report.xlsx',
      format: 'xlsx',
      mode: 'portable',
      operations: [{ op: 'add_chart', range: 'A1:B5', source: 'A1:B5' }],
    },
    { cwd }
  );
  assert.equal(failed.isError, true);
  assert.equal((await readdir(cwd)).includes('report.xlsx'), false);
  const retried = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: 'report.xlsx',
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['Region', 'Revenue'],
              ['Korea', 120],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(retried.created, true);
  // A file that was already on disk belongs to the caller: overwrite replaces
  // its content as asked, but a later failure never deletes the target.
  await writeFile(join(cwd, 'kept.xlsx'), 'ORIGINAL');
  const overwritten = await executeOfficeTool(
    {
      action: 'create',
      path: 'kept.xlsx',
      format: 'xlsx',
      mode: 'portable',
      overwrite: true,
      operations: [{ op: 'add_chart', range: 'A1:B5', source: 'A1:B5' }],
    },
    { cwd }
  );
  assert.equal(overwritten.isError, true);
  assert.ok((await readFile(join(cwd, 'kept.xlsx'))).length > 0);
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
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path,
          format,
        },
        { cwd }
      )
    );
    assert.equal(created.backend, 'mixdog-tabular');
    assert.equal(created.fileKind, format);
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: created.session,
          operations: [
            {
              op: 'set_range',
              range: 'A1:B2',
              values: [
                ['name', 'value'],
                [format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted', 1],
              ],
            },
            { op: 'append_row', values: ['formula', '=SUM(1,2)'] },
            { op: 'insert_columns', column: 2, count: 1 },
            { op: 'set_cell', cell: 'B1', value: 'inserted' },
          ],
        },
        { cwd }
      )
    );
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
    assert.equal(
      snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'A2').value,
      format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted'
    );
    assert.equal(snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'B1').value, 'inserted');
    const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
    assert.equal(validation.ok, true);
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    assert.ok(issues.issues.some((issue) => issue.code === 'formula_like_value'));
    value(await executeOfficeTool({ action: 'begin', session: created.session }, { cwd }));
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: created.session,
          operations: [{ op: 'set_cell', sheet: 'table', cell: 'A1', value: 'temporary' }],
        },
        { cwd }
      )
    );
    value(await executeOfficeTool({ action: 'rollback', session: created.session }, { cwd }));
    const restored = value(
      await executeOfficeTool(
        {
          action: 'get',
          session: created.session,
          target: '/sheet[table]/cell[A1]',
        },
        { cwd }
      )
    );
    assert.equal(restored.element.value, 'name');
    value(
      await executeOfficeTool(
        {
          action: 'batch',
          session: created.session,
          operations: [{ op: 'set_cell', cell: 'C3', value: 'formula text' }],
        },
        { cwd }
      )
    );
    const finalized = value(
      await executeOfficeTool(
        {
          action: 'finalize',
          session: created.session,
        },
        { cwd }
      )
    );
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.closed, true);
    assert.equal(finalized.review.preview.visualCoverage.mode, 'structural');
    assert.equal(finalized.review.preview.visualCoverage.complete, true);
    assert.equal(finalized.review._images, undefined);
  }

  // A delimited file arrives from Excel with a byte-order mark; writing it back
  // without one turns its Korean column into mojibake the next time it opens.
  const marked = join(cwd, 'marked.csv');
  await writeFile(marked, '\uFEFF허브,처리량\r\n대전,128400\r\n', 'utf8');
  const opened = value(await executeOfficeTool({ action: 'open', path: marked, mode: 'portable' }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'append_row', values: ['광주', 84200] }],
      },
      { cwd }
    )
  );
  const saved = await readFile(opened.output || marked, 'utf8');
  assert.ok(saved.startsWith('\uFEFF'), 'the byte-order mark survives the edit');
  assert.equal(saved.slice(1), '허브,처리량\r\n대전,128400\r\n광주,84200\r\n');
  const plain = join(cwd, 'plain.csv');
  await writeFile(plain, 'hub,volume\r\n', 'utf8');
  const plainSession = value(await executeOfficeTool({ action: 'open', path: plain, mode: 'portable' }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: plainSession.session,
        operations: [{ op: 'append_row', values: ['daejeon', 128400] }],
      },
      { cwd }
    )
  );
  assert.equal(
    (await readFile(plainSession.output || plain, 'utf8')).startsWith('\uFEFF'),
    false,
    'a file without the mark does not gain one'
  );
});

test('snapshot pagination uses opaque cursors and rejects stale continuations', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'large.csv');
  const created = value(await executeOfficeTool({ action: 'create', path, format: 'csv' }, { cwd }));
  const values = Array.from({ length: 2_505 }, (_, index) => [`row-${index + 1}`]);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_range', range: 'A1:A2505', values }],
      },
      { cwd }
    )
  );
  const first = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: created.session,
        limit: 1_000,
      },
      { cwd }
    )
  );
  const firstReturned = first.document.pagination.returned;
  assert.ok(firstReturned > 0 && firstReturned <= 1_000);
  assert.equal(first.document.sheets[0].cells.length, firstReturned);
  assert.equal(first.document.pagination.hasMore, true);
  assert.ok(first.document.pagination.nextCursor);
  const second = value(
    await executeOfficeTool(
      {
        action: 'snapshot',
        session: created.session,
        cursor: first.document.pagination.nextCursor,
      },
      { cwd }
    )
  );
  assert.equal(second.document.sheets[0].cells[0].ref, `A${firstReturned + 1}`);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_cell', sheet: 'large', cell: 'A1', value: 'changed' }],
      },
      { cwd }
    )
  );
  const stale = await executeOfficeTool(
    {
      action: 'snapshot',
      session: created.session,
      cursor: second.document.pagination.nextCursor,
    },
    { cwd }
  );
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale/i);
});

// A workbook is read one sheet at a time, so the roster has to be visible and
// the cursor has to reach the sheets the first page left out.
test('a paged workbook names every sheet and the cursor walks into the next one', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'workbook.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B2',
            values: [
              ['허브', '처리량'],
              ['서울', 1200],
            ],
          },
          { op: 'add_sheet', name: '요약' },
          { op: 'set_range', sheet: '요약', range: 'A1:B1', values: [['지표', '값']] },
          { op: 'copy_sheet', sheet: 'Sheet1', name: '백업' },
        ],
      },
      { cwd }
    )
  );
  const first = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document;
  assert.equal(first.sheetCount, 3);
  assert.deepEqual(first.sheetNames, ['Sheet1', '요약', '백업']);
  assert.deepEqual(
    first.sheets.map((sheet) => sheet.name),
    ['Sheet1']
  );
  assert.equal(first.pagination.hasMore, true);
  const seen = [first.sheets[0].name];
  let cursor = first.pagination.nextCursor;
  for (let page = 0; page < 5 && cursor; page += 1) {
    const next = value(
      await executeOfficeTool({ action: 'snapshot', session: created.session, cursor }, { cwd })
    ).document;
    seen.push(...next.sheets.map((sheet) => sheet.name));
    cursor = next.pagination.nextCursor;
  }
  assert.deepEqual(seen, ['Sheet1', '요약', '백업']);
  assert.equal(cursor, null);
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
    detail: 'Office Use operation was cancelled',
  });
});
