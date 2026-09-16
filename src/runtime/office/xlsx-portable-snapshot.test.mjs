import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from './index.mjs';
import { officeSnapshotContractViolations } from './core/snapshot-contract.mjs';
import { parts, value, workspace } from './office-test-support.mjs';
import { sessions } from './core/office-core.mjs';
import { recalculateForReview } from './core/office-recalculation.mjs';
import { cellRecords } from './portable/portable-cells.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// The portable workbook reader end to end: styles, notes, booleans, the
// conventions summary, sheet-name quoting, and the issues audit that reads them.

test('the preset speaks the sheet language and formats the columns it was given', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'composed.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'compose_sheet',
            title: '4분기 물류 운영 요약',
            headers: ['지표', '목표', '실적'],
            rows: [
              ['정시 출고율', 0.97, 0.928],
              ['처리량', 40000, 47210],
            ],
            // One entry per column, the way the rows themselves are written.
            columnFormats: ['', '0.0%', '0.0%'],
            metrics: [{ label: '정시 출고율', value: '92.8%' }],
            decision: '대전 허브 야간 인력 12명 증원을 승인해 주십시오.',
          },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = new Map((snapshot.document.sheets[0].cells || []).map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('A1').value, '의사결정 대시보드');
  assert.ok(
    [...cells.values()].some((cell) => cell.value === '결정 사항'),
    'the panel caption is Korean too'
  );
  const formatted = [...cells.values()].filter((cell) => cell.style?.numberFormat === '0.0%');
  assert.ok(formatted.length >= 4, JSON.stringify(formatted.map((cell) => cell.ref)));
  // A percentage typed as text in the metric tile is the label it was written
  // as; the same string in a grid cell is a number that will not sum.
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    issues.filter((issue) => issue.code === 'number_stored_as_text'),
    []
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'H30', value: '92.8%' }],
      },
      { cwd }
    )
  );
  const grid = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    grid.filter((issue) => issue.code === 'number_stored_as_text').map((issue) => issue.path),
    ['/sheet[Sheet1]/cell[H30]']
  );
  const mismatched = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [
        {
          op: 'compose_sheet',
          sheet: 'Sheet1',
          headers: ['지표', '목표'],
          rows: [['정시 출고율', 0.97]],
          columnFormats: { Revenue: '#,##0' },
        },
      ],
    },
    { cwd }
  );
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0].text, /columnFormats matched no column/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('column widths follow the text a number format prints', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'formatted.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:D2',
            values: [
              ['운송비', '비중', '기준일', '차액'],
              [548300000, 0.9284, 46356, -1250.5],
            ],
          },
          // A unit the format prints, a percent, a date, and a negative in parentheses.
          { op: 'set_style', cell: 'A2', properties: { numberFormat: '#,##0"원"' } },
          { op: 'set_style', cell: 'B2', properties: { numberFormat: '0.00%' } },
          { op: 'set_style', cell: 'C2', properties: { numberFormat: 'yyyy-mm-dd' } },
          { op: 'set_style', cell: 'D2', properties: { numberFormat: '#,##0.0;(#,##0.0)' } },
        ],
      },
      { cwd }
    )
  );
  const narrow = async (session) =>
    (value(await executeOfficeTool({ action: 'issues', session }, { cwd })).issues || [])
      .filter((entry) => entry.code === 'column_too_narrow')
      .map((entry) => entry.path);
  // 548,300,000원 takes 14 columns, not the 9 digits the cell stores; a date
  // and a parenthesised negative print wider than they read too.
  assert.deepEqual(await narrow(created.session), [
    '/sheet[Sheet1]/cell[A2]',
    '/sheet[Sheet1]/cell[C2]',
    '/sheet[Sheet1]/cell[D2]',
  ]);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'autofit_range', range: 'A:D' }],
      },
      { cwd }
    )
  );
  assert.deepEqual(await narrow(created.session), []);
});

// A workbook opened through Excel reported 1240 and one opened portably
// reported '1240': a model tying a figure out against its own arithmetic got a
// different answer depending on which backend happened to be available.
test('portable cells carry the workbook types Excel reports', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'types.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: target,
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:D2',
            values: [
              ['허브', '물동량', '비율', '메모'],
              ['서울', 1240, 0.928, '9월 실측'],
            ],
          },
          { op: 'set_cell', cell: 'A3', value: '1,240' },
          { op: 'set_cell', cell: 'B3', value: -18.5 },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 3);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('B2').value, 1240);
  assert.equal(cells.get('C2').value, 0.928);
  assert.equal(cells.get('B3').value, -18.5);
  // Text that merely looks numeric stays text, and keeps saying so: that flag
  // is how a reader knows Excel will not sum it.
  assert.equal(cells.get('A3').value, '1,240');
  assert.equal(cells.get('A3').dataType, 'text');
  assert.equal(cells.get('B2').dataType, undefined);
  assert.equal(cells.get('D2').value, '9월 실측');
});

// A snapshot says where a picture or chart sits in cells, but placing one took
// points from the sheet origin — the caller had to do the column arithmetic the
// reader had just undone. Reading a boundary was off by one on top of that.
test('a picture and a chart are placed at the cell the snapshot reports them in', async (t) => {
  const cwd = await workspace(t);
  const picture = join(cwd, 'hub.png');
  await writeFile(
    picture,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2S9sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'placed.xlsx'),
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B5',
            values: [
              ['분기', '매출'],
              ['Q1', 120],
              ['Q2', 140],
              ['Q3', 160],
              ['Q4', 190],
            ],
          },
          { op: 'add_image', path: picture, cell: 'D2', width: 120, height: 60, altText: '허브 로고' },
          { op: 'add_chart', range: 'A1:B5', cell: 'D8', chartType: 'column', title: '분기 매출' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results[1].cell, 'D2');
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const [sheet] = snapshot.document.sheets;
  assert.equal(sheet.images[0].anchor.from, 'D2', JSON.stringify(sheet.images[0].anchor));
  assert.equal(sheet.charts[0].anchor.from, 'D8', JSON.stringify(sheet.charts[0].anchor));
});

// get on a sheet returned one cell under truncated:true: the caller asked for
// the element and had to fall back to a paged snapshot to actually read it.
test('get reads the element it names, leaf or container', async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, 'sheet-get.xlsx');
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
              ['항목', '1분기', '2분기'],
              ['매출', 5317.43, 5901.2],
              ['비용', 3801.02, 4120.5],
              ['영업이익', 1516.41, 1780.7],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 1);
  const sheet = value(
    await executeOfficeTool({ action: 'get', session: created.session, target: '/sheet[Sheet1]' }, { cwd })
  );
  assert.equal(sheet.element.cells.length, 12);
  assert.equal(sheet.element.truncated, false);
  assert.equal(sheet.element.cells.find((cell) => cell.ref === 'B2').value, 5317.43);
  const cell = value(
    await executeOfficeTool({ action: 'get', session: created.session, target: '/sheet[Sheet1]/cell[C4]' }, { cwd })
  );
  assert.equal(cell.element.value, 1780.7);
});

test('portable snapshots expose cell styles and the issues audit reads them', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'styled.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_cell', cell: 'A1', value: 'Margin' },
          { op: 'set_cell', cell: 'B1', value: 15 },
          {
            op: 'set_style',
            cell: 'B1',
            properties: { numberFormat: '0.0%', color: '0000FF', fillColor: 'FFFF00', bold: true },
          },
          { op: 'set_cell', cell: 'A2', value: 'Year' },
          { op: 'set_cell', cell: 'B2', value: 2024 },
          { op: 'set_style', cell: 'B2', properties: { numberFormat: '#,##0' } },
          { op: 'set_formula', cell: 'B3', formula: '=B1*B2' },
          { op: 'set_cell', cell: 'E2', value: '1,234' },
          { op: 'freeze_panes', row: 2, column: 1 },
          { op: 'merge_cells', range: 'A5:B5' },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(snapshot.document.sheets[0].freezePanes, { frozen: true, splitRow: 1, splitColumn: 0 });
  assert.deepEqual(snapshot.document.sheets[0].mergedRanges, ['A5:B5']);
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('A1').dataType, 'text');
  assert.equal(cells.get('B1').dataType, undefined);
  assert.equal(cells.get('E2').dataType, 'text');
  assert.equal(cells.get('B1').style.numberFormat, '0.0%');
  assert.equal(cells.get('B1').style.color, '0000FF');
  assert.equal(cells.get('B1').style.fillColor, 'FFFF00');
  assert.equal(cells.get('B1').style.bold, true);
  assert.equal(cells.get('B2').style.numberFormat, '#,##0');
  assert.equal(cells.get('A1').style, undefined);

  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(
    issues.issues.some((entry) => entry.code === 'percentage_stored_as_whole' && /cell\[B1\]$/.test(entry.path))
  );
  assert.ok(
    issues.issues.some((entry) => entry.code === 'year_with_thousands_separator' && /cell\[B2\]$/.test(entry.path))
  );
  assert.ok(issues.issues.some((entry) => entry.code === 'number_stored_as_text' && /cell\[E2\]$/.test(entry.path)));

  const quoted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          { op: 'add_sheet', name: 'Input Sheet' },
          { op: 'set_cell', sheet: 'Input Sheet', cell: 'A1', value: 3 },
          { op: 'set_formula', cell: 'C1', formula: '=Input Sheet!A1*2' },
        ],
      },
      { cwd }
    )
  );
  const formulaResult = quoted.results.find((entry) => entry.op === 'set_formula');
  assert.equal(formulaResult.normalizedFormula, "='Input Sheet'!A1*2");
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(
    audited.issues.some((entry) => entry.code === 'unquoted_sheet_reference'),
    false
  );
});

test('a model built to the conventions audits clean under financial-model', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'model.xlsx');
  const input = (cell, value, numberFormat, note) => [
    { op: 'set_cell', sheet: 'Inputs', cell, value },
    { op: 'set_style', sheet: 'Inputs', cell, properties: { numberFormat, color: '0000FF' } },
    { op: 'add_note', sheet: 'Inputs', cell, text: note },
  ];
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'rename_sheet', sheet: 'Sheet1', name: 'Inputs' },
          { op: 'set_range', sheet: 'Inputs', range: 'A1:B1', values: [['Assumption', 'Value']] },
          { op: 'set_cell', sheet: 'Inputs', cell: 'A2', value: 'Growth' },
          ...input('B2', 0.05, '0.0%', 'user brief 2026-09-06: 5% growth'),
          { op: 'set_cell', sheet: 'Inputs', cell: 'A3', value: 'Base revenue ($mm)' },
          ...input('B3', 1000, '#,##0', 'FY2025 actuals, finance sheet B4'),
          { op: 'set_cell', sheet: 'Inputs', cell: 'A4', value: 'Margin' },
          ...input('B4', 0.2, '0.0%', 'user brief 2026-09-06: 20% margin'),
          { op: 'define_name', name: 'GrowthRate', refersTo: 'Inputs!$B$2' },
          { op: 'add_sheet', name: 'Model' },
          { op: 'set_range', sheet: 'Model', range: 'A1:E1', values: [['Year', 2024, 2025, 2026, 2027]] },
          { op: 'set_cell', sheet: 'Model', cell: 'A2', value: 'Revenue ($mm)' },
          { op: 'set_formula', sheet: 'Model', cell: 'B2', formula: '=Inputs!B3' },
          { op: 'set_formula', sheet: 'Model', cell: 'C2', formula: '=B2*(1+Inputs!$B$2)' },
          { op: 'set_formula', sheet: 'Model', cell: 'D2', formula: '=C2*(1+Inputs!$B$2)' },
          { op: 'set_formula', sheet: 'Model', cell: 'E2', formula: '=D2*(1+Inputs!$B$2)' },
          { op: 'set_cell', sheet: 'Model', cell: 'A3', value: 'Profit ($mm)' },
          { op: 'set_formula', sheet: 'Model', cell: 'B3', formula: '=B2*Inputs!$B$4' },
          { op: 'set_formula', sheet: 'Model', cell: 'C3', formula: '=C2*Inputs!$B$4' },
          { op: 'set_formula', sheet: 'Model', cell: 'D3', formula: '=D2*Inputs!$B$4' },
          { op: 'set_formula', sheet: 'Model', cell: 'E3', formula: '=E2*Inputs!$B$4' },
          { op: 'set_cell', sheet: 'Model', cell: 'A4', value: 'Margin check' },
          { op: 'set_formula', sheet: 'Model', cell: 'B4', formula: '=IFERROR(B3/B2,0)' },
          { op: 'set_style', sheet: 'Model', range: 'B2:E3', properties: { numberFormat: '#,##0' } },
          { op: 'add_sheet', name: 'Checks' },
          { op: 'set_range', sheet: 'Checks', range: 'A1:B1', values: [['Check', 'Result']] },
          { op: 'set_cell', sheet: 'Checks', cell: 'A2', value: 'Revenue ties to the input' },
          { op: 'set_formula', sheet: 'Checks', cell: 'B2', formula: '=ROUND(Model!B2-Inputs!B3,2)=0' },
          { op: 'set_cell', sheet: 'Checks', cell: 'A3', value: 'All checks' },
          { op: 'set_formula', sheet: 'Checks', cell: 'B3', formula: '=AND(B2)' },
          // Labels sit beside their values, so the columns have to carry them.
          { op: 'autofit_range', sheet: 'Inputs', range: 'A:B' },
          { op: 'autofit_range', sheet: 'Model', range: 'A:E' },
          { op: 'autofit_range', sheet: 'Checks', range: 'A:B' },
        ],
      },
      { cwd }
    )
  );
  const audited = value(
    await executeOfficeTool({ action: 'issues', session: created.session, auditProfile: 'financial-model' }, { cwd })
  );
  // Before a recalculation every formula lacks a cached value; nothing else may fire.
  const codes = [...new Set(audited.issues.map((entry) => entry.code))];
  assert.deepEqual(
    codes,
    ['formula_cache_missing'],
    JSON.stringify(audited.issues.filter((entry) => entry.code !== 'formula_cache_missing'))
  );
  // A paged snapshot reads one sheet at a time: the first by default, a named one on request.
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.equal(snapshot.document.sheets[0].name, 'Inputs');
  assert.deepEqual(snapshot.document.conventions.sampleInputs, ['Inputs!B2', 'Inputs!B3', 'Inputs!B4']);
  const checks = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, sheet: 'Checks' }, { cwd })
  );
  assert.equal(checks.document.sheets[0].name, 'Checks');
  assert.ok(checks.document.sheets[0].cells.some((cell) => cell.ref === 'B3' && /^AND\(/.test(cell.formula)));
});

// A computed column can only be measured once it has values. Fitted while the
// formulas were still uncached, it keeps the width of its header and renders
// as ### the moment the workbook is recalculated.
test('a column fitted before recalculation is fitted again once the values exist', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'refit.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:C1', values: [['품목', '금액', '단가']] },
          { op: 'set_cell', cell: 'A2', value: '야간' },
          { op: 'set_cell', cell: 'C2', value: 3200000 },
          { op: 'set_formula', cell: 'B2', formula: '=C2*12' },
          { op: 'autofit_range', range: 'A:C' },
        ],
      },
      { cwd }
    )
  );
  const widthOf = async (column) => {
    const sheet = await (await parts(path)).text('xl/worksheets/sheet1.xml');
    return Number(new RegExp(`<col\\b[^>]*\\bmin="${column}"[^>]*\\bwidth="([\\d.]+)"`).exec(sheet)?.[1] || 0);
  };
  const before = await widthOf(2);
  assert.ok(before > 0 && before < 12, `the empty formula column measured ${before}`);

  const session = sessions.get(created.session);
  const result = await recalculateForReview(session, null, async (target) => {
    // Stand in for the spreadsheet engine: the cached value the recalculation
    // would write for =C2*12.
    const zip = await JSZip.loadAsync(await readFile(target));
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', sheet.replace('<f>C2*12</f>', '<f>C2*12</f><v>38400000</v>'));
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    return { needed: true, recalculated: true, formulaCount: 1 };
  });
  assert.equal(result.recalculated, true);
  assert.ok(result.refittedColumns >= 1, JSON.stringify(result));
  assert.ok((await widthOf(2)) > before, `the computed column stayed at ${before}`);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// "This sheet has not been recalculated" is one fact. Reported once per cell it
// fills the issue budget of a real model and pushes every other finding out.
test('uncached formulas are reported once per sheet, not once per cell', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'uncached.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:B1', values: [['월', '매출']] },
          ...Array.from({ length: 12 }, (_, index) => ({
            op: 'set_cell',
            cell: `A${index + 2}`,
            value: `${index + 1}월`,
          })),
          ...Array.from({ length: 12 }, (_, index) => ({
            op: 'set_formula',
            cell: `B${index + 2}`,
            formula: `=${100 + index}*2`,
          })),
        ],
      },
      { cwd }
    )
  );
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const uncached = audited.issues.filter((issue) => issue.code === 'formula_cache_missing');
  assert.equal(uncached.length, 1, JSON.stringify(uncached));
  assert.equal(uncached[0].path, '/sheet[Sheet1]');
  assert.equal(uncached[0].cellCount, 12);
  assert.match(uncached[0].message, /12 formulas .*B2, B3, B4, …/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A formula whose result is the empty string is written as <v></v>; that is a
// computed value, not a cache the workbook still owes.
test('an empty-string formula result counts as a cached value', () => {
  const xml =
    '<sheetData><row r="7">' +
    '<c r="E7" t="n"><f>IF(C7=0,0,D7/C7)</f><v>0</v></c>' +
    '<c r="F7" t="str"><f>IF(C7=0,"",IF(E7&gt;=200,"정상","보강"))</f><v></v></c>' +
    '<c r="G7"><f>E7*2</f></c>' +
    '</row></sheetData>';
  const records = cellRecords(xml, []);
  assert.deepEqual(
    records.map((cell) => [cell.ref, cell.cacheState, cell.cachedValue]),
    [
      ['E7', 'present', 0],
      ['F7', 'present', ''],
      ['G7', 'missing', null],
    ]
  );
});

// A header styled with its column's percent format holds a shared-string
// index, not a number; only a numeric cell can store a percentage as a whole.
test('a percent-formatted header is not a percent stored as a whole', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'percent.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B3',
            values: [
              ['라인', '증감률'],
              ['1호', 0.1],
              ['2호', 250],
            ],
          },
          { op: 'set_style', range: 'B1:B3', properties: { numberFormat: '0.0%', horizontalAlignment: 'right' } },
        ],
      },
      { cwd }
    )
  );
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const scaled = audited.issues.filter((issue) => issue.code === 'percent_stored_as_whole');
  assert.deepEqual(
    scaled.map((issue) => issue.path),
    ['/sheet[Sheet1]/cell[B3]'],
    JSON.stringify(scaled)
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A chart's series need not sit beside its categories: comma-joined areas read
// the way Excel's own Range("A1:A3,C1:C3") does. Two drawings anchored on the
// same cells hide each other, and the review says so.
test('a chart takes comma-joined areas, and a drawing over another is reported', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'union.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C3',
            values: [
              ['주차', '처리량', '경보'],
              ['1주', 8900, 7],
              ['2주', 9400, 6],
            ],
          },
          {
            op: 'add_chart',
            range: 'A1:A3,C1:C3',
            cell: 'E2',
            chartType: 'column',
            title: '경보 (건)',
            width: 300,
            height: 200,
          },
          {
            op: 'add_chart',
            range: 'A1:B3',
            cell: 'F4',
            chartType: 'line',
            title: '처리량 (건)',
            width: 300,
            height: 200,
          },
          {
            op: 'add_chart',
            range: 'A1:B3',
            cell: 'E20',
            chartType: 'line',
            title: '처리량 (건)',
            width: 300,
            height: 200,
          },
        ],
      },
      { cwd }
    )
  );
  const charts = created.batch.results.filter((entry) => entry.op === 'add_chart');
  assert.equal(charts[0].series, 1);
  const chartXml = await (await JSZip.loadAsync(await readFile(path))).file('xl/charts/chart1.xml').async('string');
  assert.match(chartXml, /\$C\$2:\$C\$3/);
  assert.doesNotMatch(chartXml, /\$B\$2:\$B\$3/);
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const overlaps = audited.issues.filter((issue) => issue.code === 'drawing_overlap');
  assert.deepEqual(
    overlaps.map((issue) => issue.path),
    ['/sheet[Sheet1]/chart[2]'],
    JSON.stringify(overlaps)
  );
  assert.match(overlaps[0].message, /over the chart at E2:/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A label runs until the first column that holds something. The check looked
// only at the cell next door, so a label cut by the column after an empty (or
// withheld) one went unreported while the render showed it cut.
test('a label is measured against the room it actually has', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'labels.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C3',
            values: [
              ['지점', '작업메모', '출고'],
              ['대전 물류 허브 야간', '내부 검토 문구입니다', 48210],
              ['광주 물류 허브 야간', '', 31880],
            ],
          },
          { op: 'set_column_visibility', column: 'B', visible: false },
        ],
      },
      { cwd }
    )
  );
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  const cut = audited.issues.find((issue) => issue.code === 'label_truncated');
  assert.ok(cut, JSON.stringify(audited.issues));
  // Both rows are cut: the withheld column lends no room, so the number in C
  // stops each label at the edge of column A.
  assert.match(cut.message, /2 labels in this column are cut/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));

  // The same label with an empty column beside it borrows that column's room
  // and reads in full.
  const roomy = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'roomy.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C2',
            values: [
              ['지점', '', '출고'],
              ['대전 허브 야간', '', 48210],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const clean = value(await executeOfficeTool({ action: 'issues', session: roomy.session }, { cwd }));
  assert.equal(
    clean.issues.some((issue) => issue.code === 'label_truncated'),
    false,
    JSON.stringify(clean.issues)
  );
  value(await executeOfficeTool({ action: 'close', session: roomy.session }, { cwd }));
});

// Fitting the columns rewrote each column declaration from scratch, so a
// working column the sheet was withholding came back onto the page.
test('fitting columns keeps a withheld column withheld', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'withheld.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C2',
            values: [
              ['지점', '작업메모', '출고'],
              ['대전 물류 허브', '내부 검토 문구입니다', 48210],
            ],
          },
          { op: 'set_column_visibility', column: 'B', visible: false },
        ],
      },
      { cwd }
    )
  );
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'autofit_range', range: 'A:C' }],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(snapshot.document.sheets[0].hiddenColumns, ['B']);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Fit-to-page only scales down, so a composed sheet whose columns hold just
// their text prints as a small block in the corner of the paper. minWidth is the
// floor the layout asks for; a row fit that came after it used to rewrite every
// width from the text again and undo it.
test('a fitted column keeps the floor the layout asked for, and a row fit leaves it alone', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'floor.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['허브', '처리량'],
              ['대전 물류 허브 야간 운영 상황판', 128400],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const columnWidth = async (column) => {
    const sheet = await (await parts(join(cwd, 'floor.xlsx'))).text('xl/worksheets/sheet1.xml');
    const found = sheet.match(new RegExp(`<col\\b[^>]*\\bmin="${column}"[^>]*>`));
    return found ? Number(/width="([\d.]+)"/.exec(found[0])?.[1]) : 0;
  };
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'autofit_range', range: 'A:D', minWidth: 26 }],
      },
      { cwd }
    )
  );
  // The long label still grows past the floor; the empty columns a band spans
  // reach it, so the block keeps its width.
  assert.ok((await columnWidth(1)) > 26, `column A: ${await columnWidth(1)}`);
  assert.equal(await columnWidth(2), 26);
  assert.equal(await columnWidth(4), 26);
  const fitted = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'autofit_range', range: '1:2', rows: true }],
      },
      { cwd }
    )
  );
  assert.equal(fitted.results[0].columns, 0);
  assert.equal(await columnWidth(2), 26, 'a row fit does not resize the columns');
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// The audit says "run autofit_range" and the runtime has the operation, but the
// repair pass matched a code the audit never emits: autoFix answered a sheet of
// ### values and cut labels with an empty fix list.
test('qa autoFix widens the columns the audit reports as cut', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'narrow.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C3',
            values: [
              ['지점', '운송비', '비고'],
              ['대전 물류 허브', 548300000, '정상'],
              ['광주 물류 허브', 331880000, '점검'],
            ],
          },
          { op: 'set_style', range: 'B2:B3', properties: { numberFormat: '#,##0"원"' } },
        ],
      },
      { cwd }
    )
  );
  const before = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(
    before.issues.some((issue) => issue.code === 'column_too_narrow'),
    JSON.stringify(before.issues)
  );
  assert.ok(
    before.issues.some((issue) => issue.code === 'label_truncated'),
    JSON.stringify(before.issues)
  );

  const repaired = value(
    await executeOfficeTool(
      {
        action: 'qa',
        session: created.session,
        autoFix: true,
        render: false,
      },
      { cwd }
    )
  );
  assert.deepEqual(
    repaired.fixes.map((fix) => `${fix.op} ${fix.sheet} ${fix.range}`).sort(),
    ['autofit_range Sheet1 A:A', 'autofit_range Sheet1 B:B'],
    JSON.stringify(repaired.fixes)
  );
  const remaining = (repaired.issuesAfter || []).filter((issue) =>
    ['column_too_narrow', 'label_truncated'].includes(issue.code)
  );
  assert.deepEqual(remaining, [], JSON.stringify(remaining));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// A snapshot for a reader stops at a readable page of cells. The audit read the
// same trimmed page: on a ledger of a few hundred rows every check silently
// stopped at cell 2000 and the answer still came back "ok, nothing found".
test('the audit reads the whole sheet, not the page a reader is shown', async (t) => {
  const cwd = await workspace(t);
  const rows = 1200;
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'ledger.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: `A1:C${rows}`,
            values: Array.from({ length: rows }, (_, index) =>
              index === 0 ? ['지점', '출고', '비고'] : [`허브 ${index}`, index * 7, '정상']
            ),
          },
          // Past the first 2000 populated cells: the broken figure a reader would see.
          { op: 'set_cell', cell: 'B1100', value: '#DIV/0!' },
        ],
      },
      { cwd }
    )
  );
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.equal(audited.ok, false, JSON.stringify(audited.issues));
  assert.ok(
    audited.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Sheet1]/cell[B1100]'),
    JSON.stringify(audited.issues)
  );
  // A count the audit reports is the sheet's own, not the size of the page it read.
  const frozen = audited.issues.find((issue) => issue.code === 'header_not_frozen');
  assert.match(frozen.message, new RegExp(`^${rows - 1} rows scroll`), frozen.message);
  // The reader's own snapshot keeps its readable page and says it is one.
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const [sheet] = snapshot.document.sheets;
  assert.equal(sheet.truncated, true);
  assert.ok(sheet.cells.length <= 2000, String(sheet.cells.length));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('portable snapshots carry notes, booleans, and conventions; the financial audit reads the notes', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'noted.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_cell', cell: 'A1', value: 'Growth' },
          { op: 'set_cell', cell: 'B1', value: 0.05 },
          { op: 'set_style', cell: 'B1', properties: { numberFormat: '0.0%', color: '0000FF' } },
          { op: 'add_note', cell: 'B1', text: 'user brief 2026-09-06: 5% growth' },
          { op: 'set_cell', cell: 'B2', value: 100 },
          { op: 'set_formula', cell: 'C2', formula: '=B2*(1+$B$1)' },
          { op: 'set_cell', cell: 'D1', value: true },
          {
            op: 'set_range',
            range: 'A4:B6',
            values: [
              ['Item', 'Qty'],
              ['bolt', 4],
              ['nut', 6],
            ],
          },
          { op: 'add_table', range: 'A4:B6', name: 'Items' },
          { op: 'set_formula', cell: 'B7', formula: '=SUM(B5:B6)' },
        ],
      },
      { cwd }
    )
  );
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const first = snapshot.document.sheets[0];
  const cells = new Map(first.cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('B1').note, 'user brief 2026-09-06: 5% growth');
  assert.equal(first.noteCount, 1);
  assert.equal(first.notes[0].cell, 'B1');
  assert.equal(cells.get('D1').value, true);
  assert.equal(first.tableCount, 1);
  assert.deepEqual(first.tables[0], {
    path: `/sheet[${first.name}]/table[1]`,
    index: 1,
    name: 'Items',
    range: 'A4:B6',
    style: 'TableStyleMedium2',
  });
  assert.deepEqual(officeSnapshotContractViolations(snapshot.document, { format: 'xlsx', paged: true }), []);
  assert.deepEqual(snapshot.document.conventions.inputMarkers.fontColors, [{ color: '0000FF', cells: 1 }]);
  assert.deepEqual(snapshot.document.conventions.sampleInputs, [`${first.name}!B1`]);
  assert.ok(snapshot.document.defaultStyle?.fontName, 'the workbook default face is reported');
  assert.equal(snapshot.document.conventions.defaultFont, snapshot.document.defaultStyle.fontName);

  const audited = value(
    await executeOfficeTool({ action: 'issues', session: created.session, auditProfile: 'financial-model' }, { cwd })
  );
  assert.deepEqual(
    audited.issues.filter((entry) => entry.code === 'hardcode_missing_source').map((entry) => entry.path),
    [`/sheet[${first.name}]/cell[B2]`]
  );
});
