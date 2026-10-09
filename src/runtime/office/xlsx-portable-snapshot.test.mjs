import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { executeOfficeTool } from './index.mjs';
import { officeSnapshotContractViolations } from './core/snapshot-contract.mjs';
import { MALGUN_GOTHIC_INSTALLED, parts, value, workspace } from './office-test-support.mjs';
import { sessions } from './core/office-core.mjs';
import { recalculateForReview } from './core/office-recalculation.mjs';
import { cellRecords, sheetFormulaTotals } from './portable/portable-cells.mjs';
import { chartPartSnapshot } from './portable/portable-snapshot-shared.mjs';
import { columnFileWidth, columnPixels, maximumDigitWidth } from './portable/portable-sheet-page.mjs';

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
  // The same text in a grid cell is typed as the figure it shows, as Excel types it: 0.928 under 0.00%.
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
  const typed = value(
    await executeOfficeTool({ action: 'snapshot', session: created.session, range: 'H30:H30' }, { cwd })
  ).document.sheets[0].cells.find((cell) => cell.ref === 'H30');
  assert.equal(typed.value, 0.928);
  assert.equal(typed.style?.numberFormat, '0.00%');
  const grid = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    grid.filter((issue) => issue.code === 'number_stored_as_text').map((issue) => issue.path),
    []
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

// The composer picks the type, the spacing and the panel, and left the figures under General: its own sheet came
// back with `numeric_column_unformatted`. The default is read off the values and claims nothing about them.
test('a composed table formats its numeric columns and still takes the formats the caller names', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'formats.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [
          {
            op: 'compose_sheet',
            sheet: 'Report',
            title: '야간 출고 성과',
            headers: ['분기', '처리량 (천 건)', '오류율'],
            rows: [
              ['1분기', 12, 0.012],
              ['2분기', 18, 0.009],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const readCells = async (session) => {
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session }, { cwd }));
    return snapshot.document.sheets.find((entry) => entry.name === 'Report')?.cells || [];
  };
  const formatOf = (cells, wanted) => cells.find((cell) => cell.value === wanted)?.style?.numberFormat || '';
  const composed = await readCells(created.session);
  // Integers take the thousands form; decimals keep the places they were written with.
  assert.equal(formatOf(composed, 12), '#,##0');
  assert.equal(formatOf(composed, 0.012), '#,##0.000');
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    audited.filter((issue) => issue.code === 'numeric_column_unformatted'),
    []
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));

  // A format the caller names wins over the default, and one that lands nowhere is still reported.
  const named = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'named.xlsx'),
        mode: 'portable',
        operations: [
          {
            op: 'compose_sheet',
            sheet: 'Report',
            headers: ['분기', '오류율'],
            rows: [
              ['1분기', 0.012],
              ['2분기', 0.009],
            ],
            columnFormats: ['', '0.0%'],
          },
        ],
      },
      { cwd }
    )
  );
  const namedCells = await readCells(named.session);
  assert.equal(formatOf(namedCells, 0.012), '0.0%');
  assert.equal(formatOf(namedCells, 0.009), '0.0%');
  value(await executeOfficeTool({ action: 'close', session: named.session }, { cwd }));
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

// A composed report set every paragraph's face and left the document's own at Calibri 11 pt: a paragraph added later
// came out in another face, size, and ink than the body. The document default is now the body's, and a Normal style
// without run properties leaves the style after it alone.
test('a composed document makes its body face, size, and ink the document default', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'report.docx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        design: { profile: 'data' },
        operations: [
          {
            op: 'compose_document',
            title: '야간 이용 분석',
            sections: [{ heading: '해석', paragraphs: ['본문입니다.'] }],
          },
        ],
      },
      { cwd }
    )
  );
  const styles = await (await parts(path)).text('word/styles.xml');
  const defaults = /<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/.exec(styles)[0];
  // The design's Latin face is written as given; Hangul takes the Korean sans beside it.
  assert.match(defaults, /w:ascii="Calibri"/);
  assert.match(defaults, /w:eastAsia="Malgun Gothic"/);
  assert.match(defaults, /<w:sz w:val="20"\/>/);
  assert.match(defaults, /<w:color w:val="[0-9A-F]{6}"\/>/);
  const title = /<w:style\b[^>]*w:styleId="Title"[^>]*>[\s\S]*?<\/w:style>/.exec(styles)?.[0] || '';
  assert.doesNotMatch(title, /w:ascii="Malgun Gothic"/, 'the style after Normal is left alone');

  // Korean Word writes Normal as styleId "a" with its own run properties, which outrank the defaults: it is found as
  // the default paragraph style and takes the same face and size.
  const korean = join(cwd, 'korean-word.docx');
  const zip = await JSZip.loadAsync(await readFile(path));
  const koreanStyles = (await zip.file('word/styles.xml').async('string')).replace(
    /<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"\/>/,
    '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>'
  );
  assert.match(koreanStyles, /w:styleId="a"/);
  zip.file('word/styles.xml', koreanStyles);
  await writeFile(korean, await zip.generateAsync({ type: 'nodebuffer' }));
  const opened = value(await executeOfficeTool({ action: 'open', path: korean, mode: 'portable' }, { cwd }));
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [{ op: 'set_document_font', properties: { name: '맑은 고딕', size: 10.5 } }],
      },
      { cwd }
    )
  );
  const saved = await (await parts(opened.output || korean)).text('word/styles.xml');
  const normal = /<w:style\b[^>]*w:styleId="a"[^>]*>[\s\S]*?<\/w:style>/.exec(saved)[0];
  assert.match(normal, /w:ascii="맑은 고딕"/);
  assert.match(normal, /<w:sz w:val="21"\/>/);
});

// A body that ended in a table lost that table when LibreOffice saved the file as .doc, and two tables appended in a
// row joined into one. A table now ends on a paragraph, which the next paragraph fills, and tables keep one between.
test('a document keeps a paragraph after its last table and between two tables', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'tables.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '앞 문단' },
          { op: 'add_table', rows: 1, columns: 1, values: [['첫째']] },
          { op: 'add_table', rows: 1, columns: 1, values: [['둘째']] },
        ],
      },
      { cwd }
    )
  );
  const blocks = async () =>
    [
      ...(await (await parts(path)).text('word/document.xml'))
        .replace(/<w:tc>[\s\S]*?<\/w:tc>/g, '')
        .matchAll(/<w:(p|tbl)\b(\/)?/g),
    ]
      .map(blockLetter)
      .join('');
  assert.equal(await blocks(), 'pTeTe');
  value(
    await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'append_text', text: '뒤 문단' }] },
      { cwd }
    )
  );
  assert.equal(await blocks(), 'pTeTp', 'the closing paragraph is filled, not followed by a blank line');
  // Placed under a paragraph that a table follows, a new table keeps a paragraph between it and that table.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'add_table', paragraph: 1, rows: 1, columns: 1, values: [['앞']] }],
      },
      { cwd }
    )
  );
  assert.equal(await blocks(), 'pTeTeTp');
  // Removing the only paragraph between two tables keeps it as an empty one, or the two would join.
  const pair = join(cwd, 'pair.docx');
  const paired = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: pair,
        format: 'docx',
        mode: 'portable',
        operations: [
          { op: 'append_text', text: '첫' },
          { op: 'add_table', rows: 1, columns: 1, values: [['A']] },
          { op: 'append_text', text: '사이' },
          { op: 'add_table', rows: 1, columns: 1, values: [['B']] },
          { op: 'append_text', text: '끝' },
        ],
      },
      { cwd }
    )
  );
  const between = value(
    await executeOfficeTool(
      { action: 'batch', session: paired.session, operations: [{ op: 'remove_paragraph', paragraph: 2 }] },
      { cwd }
    )
  );
  assert.equal(between.results[0].keptBetweenTables, true);
  const pairBlocks = [
    ...(await (await parts(pair)).text('word/document.xml'))
      .replace(/<w:tc>[\s\S]*?<\/w:tc>/g, '')
      .matchAll(/<w:(p|tbl)\b(\/)?/g),
  ]
    .map(blockLetter)
    .join('');
  assert.equal(pairBlocks, 'pTeTp');
  // Moving that paragraph away leaves the tables apart too.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: paired.session,
        operations: [
          { op: 'remove_paragraph', paragraph: 1 },
          { op: 'append_text', text: '사이 2' },
          { op: 'move_paragraph', paragraph: 1, index: 3 },
        ],
      },
      { cwd }
    )
  );
  const moved = [
    ...(await (await parts(pair)).text('word/document.xml'))
      .replace(/<w:tc>[\s\S]*?<\/w:tc>/g, '')
      .matchAll(/<w:(p|tbl)\b(\/)?/g),
  ]
    .map(blockLetter)
    .join('');
  assert.doesNotMatch(moved, /TT/, moved);
});

// A series named in plain text (<c:tx><c:v>Value</c:v></c:tx>) has no name formula; the reader searched past
// </c:tx> and reported the category range as the name's, which the total-row audit then read as a series range.
test('a series named in text reports no name formula, not its category range', () => {
  const chart = chartPartSnapshot(
    '<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:v>Value</c:v></c:tx>' +
      '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/></c:numCache></c:numRef></c:val>' +
      '</c:ser><c:ser><c:idx val="1"/><c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:pt idx="0"><c:v>Target</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
      '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f></c:numRef></c:val>' +
      '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
  );
  assert.deepEqual(
    chart.series.map((series) => [series.name, series.formula, series.categoryFormula, series.valueFormula]),
    [
      ['Value', '', 'Sheet1!$A$2:$A$3', 'Sheet1!$B$2:$B$3'],
      ['Target', 'Sheet1!$C$1', 'Sheet1!$A$2:$A$3', 'Sheet1!$C$2:$C$3'],
    ]
  );
});

// A summary sheet charting the calculation sheet behind it was refused ("Invalid XLSX cell reference: '월별 계산'!A1"):
// the source could only be the sheet the frame stood on. It now names its sheet, and the chart cites that sheet.
test('a chart on a summary sheet reads its source from the sheet it names', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'summary.xlsx');
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'rename_sheet', sheet: 'Sheet1', name: '요약' },
          { op: 'add_sheet', name: '월별 계산' },
          {
            op: 'set_range',
            sheet: '월별 계산',
            range: 'A1:D3',
            values: [
              ['월', '방문자', '주문', '매출'],
              ['1월', 12000, 420, 17640000],
              ['2월', 12600, 441, 18522000],
            ],
          },
          {
            op: 'add_chart',
            sheet: '요약',
            range: "'월별 계산'!$A$1:$A$3,'월별 계산'!D1:D3",
            cell: 'B2',
            chartType: 'column',
            title: '월별 매출',
          },
        ],
      },
      { cwd }
    )
  );
  const zip = await parts(path);
  const chart = await zip.text('xl/charts/chart1.xml');
  assert.match(chart, /<c:f>&apos;월별 계산&apos;!\$D\$2:\$D\$3<\/c:f>/);
  assert.match(chart, /<c:f>&apos;월별 계산&apos;!\$A\$2:\$A\$3<\/c:f>/);
  assert.match(chart, /<c:v>18522000<\/c:v>/);
  const workbook = await zip.text('xl/workbook.xml');
  const summaryId = /<sheet\b[^>]*name="요약"[^>]*r:id="([^"]+)"/.exec(workbook)[1];
  const summaryPath = new RegExp(`Id="${summaryId}"[^>]*Target="([^"]+)"`).exec(
    await zip.text('xl/_rels/workbook.xml.rels')
  )[1];
  assert.match(
    await zip.text(`xl/${summaryPath.replace(/^\/?xl\//, '')}`),
    /<drawing r:id=/,
    'the frame stands on 요약'
  );

  for (const [range, fault] of [
    ["'월별 계산'!A1:A3,D1:D3", /some areas and none on others/],
    ["'월별 계산'!A1:A3,요약!D1:D3", /more than one sheet/],
    ['없는시트!A1:B3', /does not hold/],
  ]) {
    const refused = await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'refused.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        overwrite: true,
        operations: [{ op: 'add_chart', range }],
      },
      { cwd }
    );
    assert.equal(refused.isError, true, range);
    assert.match(refused.content[0].text, fault, range);
  }
});

// A pivot over Hangul fields read "Sum of 매출" over "Grand Total"; Korean Excel heads it "합계 : 매출" and "총합계".
test('a pivot over Korean fields takes Korean captions', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'pivot.xlsx');
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
            range: 'A1:C4',
            values: [
              ['권역', '분기', '매출'],
              ['서울', '1분기', 820],
              ['부산', '1분기', 410],
              ['서울', '2분기', 910],
            ],
          },
          {
            op: 'add_pivot_table',
            source: 'A1:C4',
            destination: 'E1',
            rows: ['권역'],
            columns: ['분기'],
            values: ['매출'],
          },
        ],
      },
      { cwd }
    )
  );
  const sheet = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd })).document
    .sheets[0];
  const values = sheet.cells.map((cell) => cell.value);
  assert.ok(values.includes('합계 : 매출') && values.includes('총합계'), JSON.stringify(values));
  assert.ok(!values.includes('Grand Total'));
  // The read names the pivot as Excel's does, and the row header keeps its field's name through a refresh.
  assert.deepEqual(
    sheet.pivots?.map((pivot) => pivot.name),
    ['MixdogPivot1'],
    JSON.stringify(sheet.pivots)
  );
  const definition = await (await parts(path)).text('xl/pivotTables/pivotTable1.xml');
  assert.match(definition, /grandTotalCaption="총합계"/);
  assert.match(definition, /rowHeaderCaption="[^"]+"/);
  assert.match(definition, /<dataField name="합계 : 매출"/);
});

// A form's instruction line under its title set column A four times the width of the dates under it and split the
// table over two pages. A line alone in its row prints across the empty cells beside it; a fit over several columns
// sizes the columns to the table, and a fit of that one column still takes the line.
test('a multi-column fit is not widened by a line of text alone in its row', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'form.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:A2',
            values: [['경비 신청서'], ['파란 칸에 입력하세요. 둘째 줄은 작성 예시입니다.']],
          },
          {
            op: 'set_range',
            range: 'A4:C5',
            values: [
              ['사용일', '구분', '금액'],
              ['2026-10-02', '교통', 18400],
            ],
          },
          { op: 'autofit_range', range: 'A:C' },
        ],
      },
      { cwd }
    )
  );
  const widthOf = async (column) => {
    const xml = await (await parts(join(cwd, 'form.xlsx'))).text('xl/worksheets/sheet1.xml');
    return Number(new RegExp(`<col min="${column}" max="${column}" width="([\\d.]+)"`).exec(xml)?.[1]);
  };
  assert.ok((await widthOf(1)) < 16, `column A fits its dates, not the instruction line: ${await widthOf(1)}`);
  value(
    await executeOfficeTool(
      { action: 'batch', session: created.session, operations: [{ op: 'autofit_range', range: 'A:A' }] },
      { cwd }
    )
  );
  assert.ok((await widthOf(1)) > 30, `a fit of column A alone still takes the line: ${await widthOf(1)}`);
});

// A dashboard card: a 27 pt bold "47.0%" printed ### in a 14-character column while the size-only estimate (12.3)
// passed it. Bold runs wider; the rendered threshold is about 14.7.
test('a large bold figure is cut by the width its bold type needs', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'card.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:B1', values: [[0.47, 0.47]] },
          { op: 'set_style', range: 'A1:B1', properties: { fontSize: 27, bold: true, numberFormat: '0.0%' } },
          { op: 'set_column_width', column: 'A', width: 14 },
          { op: 'set_column_width', column: 'B', width: 16 },
          // The same card merged over two 8-character columns prints across both (16) and fits.
          { op: 'set_cell', cell: 'D1', value: 0.47 },
          { op: 'set_style', range: 'D1:E1', properties: { fontSize: 27, bold: true, numberFormat: '0.0%' } },
          { op: 'merge_cells', range: 'D1:E1' },
          { op: 'set_column_width', column: 'D', width: 8 },
          { op: 'set_column_width', column: 'E', width: 8 },
        ],
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  assert.deepEqual(
    issues.filter((entry) => entry.code === 'column_too_narrow').map((entry) => entry.path),
    ['/sheet[Sheet1]/cell[A1]']
  );
});

// General never prints ###: Excel rounds the decimals to the column and turns only a long integer part scientific.
// Measured from the stored digits, 0.5700000000000001 read as an eighteen-character cut on Excel's 0.57.
test('a General number is cut only when its integer part outruns the column', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'general.xlsx'),
        format: 'xlsx',
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:B2',
            values: [
              ['비율', '건수'],
              [0.5 + 0.07, 123456789012],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [];
  const narrow = issues.filter((entry) => entry.code === 'column_too_narrow');
  assert.deepEqual(
    narrow.map((entry) => entry.path),
    ['/sheet[Sheet1]/cell[B2]']
  );
  assert.match(narrow[0].message, /scientific notation/);
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
          { op: 'set_cell', cell: 'A4', value: '007' },
        ],
      },
      { cwd }
    )
  );
  assert.equal(created.batch.results.length, 4);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  const cells = new Map(snapshot.document.sheets[0].cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.get('B2').value, 1240);
  assert.equal(cells.get('C2').value, 0.928);
  assert.equal(cells.get('B3').value, -18.5);
  // A grouped figure written as text is the number Excel types from it, under #,##0; a code Excel would strip
  // ("007") stays text and keeps saying so: that flag is how a reader knows Excel will not sum it.
  assert.equal(cells.get('A3').value, 1240);
  assert.equal(cells.get('A3').dataType, undefined);
  assert.equal(cells.get('A4').value, '007');
  assert.equal(cells.get('A4').dataType, 'text');
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
          { op: 'set_cell', cell: 'E2', value: '0123' },
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
  // Microsoft Excel writes the same empty result as a self-closing <v/>, and the sheet totals read it the same way.
  const excel =
    '<sheetData><row r="6"><c r="D6" t="str"><f>IF(C6="","",C6*0.1)</f><v/></c><c r="E6"><f>D6*2</f></c></row></sheetData>';
  assert.deepEqual(
    cellRecords(excel, []).map((cell) => [cell.ref, cell.cacheState]),
    [
      ['D6', 'present'],
      ['E6', 'missing'],
    ]
  );
  assert.deepEqual(sheetFormulaTotals(excel), { formulaCount: 2, formulaCacheMissing: 1 });
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
  const scaled = audited.issues.filter((issue) => issue.code === 'percentage_stored_as_whole');
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

// A 220 pt chart anchored at A8 reached row 22 and covered the block of cells written there; the page showed the
// chart and hid the figures. A chart clear of every filled cell is not reported.
test('a drawing laid over filled cells is reported, one clear of them is not', async (t) => {
  const cwd = await workspace(t);
  const audit = async (cell) => {
    const created = value(
      await executeOfficeTool(
        {
          action: 'create',
          path: join(cwd, `cover-${cell}.xlsx`),
          format: 'xlsx',
          mode: 'portable',
          overwrite: true,
          operations: [
            {
              op: 'set_range',
              range: 'A1:B3',
              values: [
                ['연도', '순현금흐름'],
                ['2027', 9.2],
                ['2028', 10.0],
              ],
            },
            { op: 'set_range', range: 'A22:B22', values: [['비고', '재무팀 검토']] },
            {
              op: 'add_chart',
              range: 'A1:B3',
              cell,
              chartType: 'column',
              title: '순현금흐름 (억원)',
              width: 300,
              height: 220,
            },
          ],
        },
        { cwd }
      )
    );
    const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    return audited.issues.filter((issue) => issue.code === 'drawing_covers_cells');
  };
  const covering = await audit('A8');
  assert.deepEqual(
    covering.map((issue) => issue.path),
    ['/sheet[Sheet1]/chart[1]'],
    JSON.stringify(covering)
  );
  assert.match(covering[0].message, /over 2 filled cells \(A22, B22\)/);
  assert.deepEqual(await audit('D2'), []);
});

// A sheet that grows a column per period is already written the other way:
// plotBy:'rows' reads the first row as the categories and every other row as a
// series named by its first cell, instead of asking for a transposed copy.
test('a chart reads a row-oriented block with plotBy rows', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'rows.xlsx');
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
            range: 'A1:D3',
            values: [
              ['지표', '1분기', '2분기', '3분기'],
              ['가동률', 92, 94, 96],
              ['경보', 7, 6, 4],
            ],
          },
          {
            op: 'add_chart',
            range: 'A1:D3',
            plotBy: 'rows',
            cell: 'F2',
            chartType: 'line',
            title: '분기 추이',
            width: 300,
            height: 200,
          },
        ],
      },
      { cwd }
    )
  );
  const chart = created.batch.results.find((entry) => entry.op === 'add_chart');
  assert.equal(chart.series, 2);
  const chartXml = await (await JSZip.loadAsync(await readFile(path))).file('xl/charts/chart1.xml').async('string');
  assert.match(chartXml, /\$B\$1:\$D\$1/);
  assert.match(chartXml, /\$B\$2:\$D\$2/);
  assert.match(chartXml, /\$B\$3:\$D\$3/);
  assert.match(chartXml, /가동률/);
  // Read by columns the same block would have made the quarters the series.
  assert.doesNotMatch(chartXml, /\$B\$2:\$B\$3/);
  const refused = await executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      operations: [{ op: 'add_chart', range: 'A1:B3,D1:D3', plotBy: 'rows', cell: 'F20' }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /plotBy:'rows' requires one bounded range/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// Excel holds a dropdown's choices quoted; written bare they are read as a
// name nobody defined and the list opens empty. A projection whose first
// period is an input and whose later periods grow from it is the ordinary
// shape of a plan, not a formula a hardcode interrupts.
test('a list validation is stored the way Excel reads it, and a plain projection is not a model finding', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'form.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'xlsx',
        mode: 'portable',
        operations: [
          { op: 'set_range', range: 'A1:F1', values: [['항목', '1Q', '2Q', '3Q', '4Q', '지역']] },
          { op: 'set_cell', cell: 'B2', value: 120 },
          { op: 'set_formula', cell: 'C2', formula: '=B2*1.05' },
          { op: 'set_formula', cell: 'D2', formula: '=C2*1.05' },
          { op: 'set_formula', cell: 'E2', formula: '=D2*1.05' },
          { op: 'add_validation', range: 'F2:F4', formula1: '서울,부산,대구' },
          { op: 'add_validation', range: 'G2:G4', formula1: '$A$1:$A$3' },
          { op: 'add_validation', range: 'H2:H4', type: 'whole', formula1: '0', formula2: '50' },
        ],
      },
      { cwd }
    )
  );
  const sheetXml = await (await JSZip.loadAsync(await readFile(path))).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheetXml, /<formula1>(?:"|&quot;)서울,부산,대구(?:"|&quot;)<\/formula1>/);
  assert.match(sheetXml, /<formula1>\$A\$1:\$A\$3<\/formula1>/);
  assert.match(sheetXml, /<formula1>0<\/formula1><formula2>50<\/formula2>/);
  const audited = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.deepEqual(
    audited.issues.filter((issue) => issue.code === 'formula_inconsistency'),
    []
  );
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
test('a column width is stored as Excel stores it: the characters asked for and its padding, in the default digit', async (t) => {
  const fonts = (name) =>
    `<styleSheet><fonts count="1"><font><sz val="11"/><name val="${name}"/></font></fonts></styleSheet>`;
  assert.equal(maximumDigitWidth(fonts('Calibri')), 7);
  if (MALGUN_GOTHIC_INSTALLED) assert.equal(maximumDigitWidth(fonts('맑은 고딕')), 8);
  // The values Excel itself wrote for ColumnWidth 9 and 5.2 in 맑은 고딕 11 (a column snaps to whole pixels).
  assert.equal(columnFileWidth(9, 8), 9.625);
  assert.equal(columnFileWidth(5.2, 8), 5.875);
  assert.equal(columnFileWidth(9, 7), 9.7109375);
  assert.equal(columnPixels(9.625, 8), 77);
  assert.equal(columnPixels(9.7109375, 7), 68);
  const cwd = await workspace(t);
  const path = join(cwd, 'widths.xlsx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        mode: 'portable',
        operations: [{ op: 'set_column_width', column: 'F', width: 9 }],
      },
      { cwd }
    )
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
  const sheet = await (await parts(path)).text('xl/worksheets/sheet1.xml');
  // Stored bare as 9, the column opened in Excel as 8.29 characters, 5 pixels short of the same call made there.
  assert.match(sheet, /<col\b[^>]*\bmin="6"[^>]*\bwidth="9\.7109375"/);
});

test('a label is measured in its own face: a bold header that prints inside its column is not reported cut', async (t) => {
  const cwd = await workspace(t);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'header.xlsx'),
        mode: 'portable',
        operations: [
          {
            op: 'set_range',
            range: 'A1:C2',
            values: [
              ['시작', '기간 (일)', '진행률'],
              ['2026-10-05', 12, 0.4],
            ],
          },
          { op: 'set_style', range: 'A1:C1', properties: { fontName: 'Malgun Gothic', fontSize: 10, bold: true } },
          { op: 'set_column_width', column: 'B', width: 9 },
        ],
      },
      { cwd }
    )
  );
  const cut = async () =>
    (value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd })).issues || [])
      .filter((issue) => issue.code === 'label_truncated')
      .map((issue) => issue.path);
  // Counted as ten characters (two a Hangul letter, one a space or a bracket, a fifth more for bold), it was
  // reported cut in a column of nine it prints inside with room to spare.
  assert.deepEqual(await cut(), []);
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [{ op: 'set_cell', cell: 'B1', value: '계획 대비 실제 소요 기간 (일)' }],
      },
      { cwd }
    )
  );
  assert.deepEqual(await cut(), ['/sheet[Sheet1]/cell[B1]']);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

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
  // The characters a column holds, read back from the width the file stores with Excel's 5 pixels of padding (the
  // workbook's Calibri 11 digit is 7 pixels wide).
  const columnWidth = async (column) => {
    const sheet = await (await parts(join(cwd, 'floor.xlsx'))).text('xl/worksheets/sheet1.xml');
    const found = sheet.match(new RegExp(`<col\\b[^>]*\\bmin="${column}"[^>]*>`));
    const stored = found ? Number(/width="([\d.]+)"/.exec(found[0])?.[1]) : 0;
    return stored ? (Math.trunc(((256 * stored + 18) / 256) * 7) - 5) / 7 : 0;
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

// One letter per body block of a Word document: T a table, e an empty (self-closed) paragraph, p a paragraph.
function blockLetter(match) {
  if (match[1] === 'tbl') return 'T';
  return match[2] ? 'e' : 'p';
}
