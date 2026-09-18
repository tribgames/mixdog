import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPdfDesign, expandOfficeDesignOperations, resolveOfficeDesign } from './design/design-system.mjs';
import { summarizeOfficeCompositions } from './design/composition-system.mjs';
import {
  canonicalOfficeDesignPack,
  indexOfficeTemplates,
  persistOfficeDesignBinding,
  readOfficeCompositionHistory,
  recordOfficeCompositionHistory,
  resolveOfficeDesignLibrary,
  syncOfficeDesignLibrary,
} from './design/library/design-library.mjs';
import {
  inferPptxSlideRoles,
  isPptxDiagramSlide,
  isPptxPictureSlide,
  isPptxStatementSlide,
  pptxVisualReviewAcknowledged,
  reviewOfficeDesign,
  reviewPptxVisualCritique,
} from './quality/design-review.mjs';
import { annotatePptxSnapshotRoles, inducePptxSampleRoles } from './design/library/design-template-induct.mjs';
import { selectTemplatePage, templatePageFill } from './design/library/design-template-fill.mjs';
import { value, workspace } from './office-test-support.mjs';
import { executeOfficeTool } from './index.mjs';
import { assertOfficeOperationContracts } from './capabilities.mjs';
import { finalizeOfficeResult, serializedToolValue } from './core/office-core.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// Every batch and finalize used to echo the whole design context back, so the
// catalogue a direction was chosen from cost several times the audit it rode
// with. The result keeps the design in force and drops the input-side lists.
// The metric strip shipped operations the runtime's own validation refused
// (a cell alignment the catalog never declared), so every preset was refused
// for any caller who asked for metrics. The presets are held to the contract
// they enforce, across the profiles and purposes that change what they emit.
test('a preset never emits an operation its own contract refuses', () => {
  const content = {
    packageId: 'sweep',
    objective: 'Night shift decision',
    decision: 'Approve 12 crew',
    facts: [
      { id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' },
      { id: 'throughput', label: 'Throughput', value: 47210, unit: 'orders' },
    ],
    claims: [{ id: 'approve', text: 'Approve the crew', factIds: ['on-time', 'throughput'] }],
  };
  const presets = {
    docx: [
      {
        op: 'compose_document',
        title: 'Night shift',
        subtitle: 'Operations',
        summary: 'Approve the crew.',
        claimId: 'approve',
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        meta: ['October 2026'],
        footer: 'Operations',
        pageNumbers: true,
        sections: [
          { heading: 'Decision', kind: 'decision', paragraphs: ['Approve the crew.'], callout: 'Review in 30 days.' },
          {
            heading: 'Evidence',
            paragraphs: ['On-time delivery fell.'],
            bullets: ['Daejeon at 68%'],
            table: { headers: ['Item', 'Count'], rows: [['Crew', '12']] },
          },
          { heading: 'Voice', quote: 'The night shift is short-handed.', eyebrow: 'Floor', pageBreak: true },
          {
            heading: 'Plan',
            steps: [
              { title: 'Hire', detail: 'Nov 1' },
              { title: 'Review', detail: 'Dec 1' },
            ],
          },
        ],
      },
    ],
    xlsx: [
      {
        op: 'compose_sheet',
        title: 'Night shift metrics',
        kind: 'dashboard',
        claimId: 'approve',
        headers: ['Hub', 'Throughput', 'On time'],
        rows: [
          ['Daejeon', 128400, 0.928],
          ['Gwangju', 84200, 0.961],
        ],
        columnFormats: ['', '#,##0', '0.0%'],
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        insights: ['Daejeon explains the drop.'],
        decision: 'Approve 12 crew',
        gates: [
          ['Metric', 'Gate'],
          ['On time', '95%+'],
        ],
        actions: [
          ['Action', 'Due'],
          ['Hire', 'Nov 1'],
        ],
        chart: { title: 'Throughput by hub', chartType: 'column' },
        source: { document: 'Ops dashboard', target: 'October' },
      },
    ],
  };
  let checked = 0;
  for (const profile of ['executive', 'editorial', 'technical', 'data']) {
    for (const purpose of ['monitor', 'decide', 'compare', 'explain', 'inspect']) {
      for (const expressionMode of ['conservative', 'strong-fit', 'divergent']) {
        for (const [format, operations] of Object.entries(presets)) {
          for (const backend of ['microsoft-office-com', 'mixdog-ooxml']) {
            const expanded = expandOfficeDesignOperations({
              format,
              backend,
              created: true,
              design: { profile, purpose, expressionMode, content },
              operations,
            });
            assertOfficeOperationContracts({ format, backend, operations: expanded.operations });
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 240);
});

test('an office result returns the design in force, not the catalogue it was chosen from', () => {
  const design = resolveOfficeDesign('pptx', {
    profile: 'technical',
    intent: 'Launch a local-first coding harness for product leaders',
    audience: 'product and engineering leaders',
    purpose: 'decide',
    expressionMode: 'strong-fit',
  });
  assert.ok(design.artDirection.candidates.length >= 2, 'the resolved design still carries its candidates');
  const before = serializedToolValue({ design }).length;
  const result = finalizeOfficeResult(
    { design, batch: { design } },
    { action: 'finalize', startedAt: performance.now() }
  );
  assert.equal(result.design.layouts, undefined);
  assert.equal(result.design.recentCompositions, undefined);
  assert.equal(result.design.artDirection.candidates, undefined);
  assert.equal(result.design.artDirection.candidateCount, design.artDirection.candidates.length);
  assert.equal(result.design.artDirection.selected.id, design.artDirection.selected.id);
  assert.equal(result.design.profile, design.profile);
  assert.deepEqual(result.design.tokens, design.tokens);
  assert.equal(result.batch.design.layouts, undefined, 'a finalize that carries its batch trims that design too');
  // The design the caller resolved is untouched; only the returned copy is trimmed.
  assert.ok(design.artDirection.candidates.length >= 2);
  assert.ok(
    serializedToolValue({ design: result.design }).length * 2 < before,
    `trimmed ${before} -> ${serializedToolValue({ design: result.design }).length}`
  );
  assert.doesNotMatch(
    serializedToolValue({ a: { b: 1 } }),
    /\n/,
    'results are serialized for a reader that parses them'
  );
});

test('authored statement slides are read from their shapes so breathing beats are not penalised', () => {
  const statement = {
    index: 2,
    shapes: [
      { index: 1, type: 1, text: '문제', font: { size: 11 } },
      { index: 2, type: 1, text: '지금까지의 덱은 주제가 무엇이든 같은 카드 세 장으로 끝났다.', font: { size: 28 } },
      { index: 3, type: 1, text: '2/8', font: { size: 9 } },
    ],
  };
  const dense = {
    index: 3,
    shapes: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      type: 1,
      text: `항목 ${index + 1} 설명 문장입니다.`,
      font: { size: 14 },
    })),
  };
  assert.equal(isPptxStatementSlide(statement), true);
  assert.equal(isPptxStatementSlide(dense), false);
  assert.deepEqual(inferPptxSlideRoles({ slides: [{ index: 1, shapes: [] }, statement, dense] }), {
    2: { slideRole: 'statement' },
  });
});

test('authored diagram slides are read from their native shapes so shape-filled fields are not judged empty', () => {
  // A cycle: four block arcs spanning the content field, labels inside, one connector.
  const diagram = {
    index: 4,
    shapes: [
      {
        index: 1,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Cycle',
        font: { size: 32 },
        left: 43,
        top: 72,
        width: 870,
        height: 60,
      },
      ...[0, 1, 2, 3].map((i) => ({
        index: 2 + i,
        type: 'p:sp',
        geometry: 'blockArc',
        text: `Step ${i + 1}`,
        font: { size: 14 },
        left: 200 + (i % 2) * 300,
        top: 150 + Math.floor(i / 2) * 170,
        width: 280,
        height: 160,
      })),
      { index: 6, type: 'p:cxnSp', text: '', left: 480, top: 300, width: 120, height: 0.5 },
    ],
  };
  // Text boxes only: the same count of shapes, none drawn.
  const text = {
    index: 5,
    shapes: Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      type: 'p:sp',
      geometry: 'rect',
      text: `Line ${i + 1}`,
      font: { size: 14 },
      left: 43,
      top: 160 + i * 40,
      width: 870,
      height: 32,
    })),
  };
  // Shapes drawn, but in one small corner: a badge, not a diagram.
  const corner = {
    index: 6,
    shapes: [
      {
        index: 1,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Title',
        font: { size: 20 },
        left: 43,
        top: 72,
        width: 870,
        height: 60,
      },
      ...[0, 1, 2].map((i) => ({
        index: 2 + i,
        type: 'p:sp',
        geometry: 'ellipse',
        text: '',
        left: 700 + i * 30,
        top: 400,
        width: 24,
        height: 24,
      })),
    ],
  };
  // A side picture with a short claim: few words, but the frame owns the slide.
  const pictureSide = {
    index: 7,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 0, top: 0, width: 446, height: 540 },
      {
        index: 2,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Night volume passed daytime',
        font: { size: 32 },
        left: 490,
        top: 72,
        width: 420,
        height: 60,
      },
      {
        index: 3,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Two more shuttles.',
        font: { size: 18 },
        left: 490,
        top: 160,
        width: 420,
        height: 40,
      },
    ],
  };
  // A statement with a small inset picture stays a statement.
  const inset = {
    index: 8,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 700, top: 380, width: 160, height: 100 },
      {
        index: 2,
        type: 'p:sp',
        geometry: 'rect',
        text: 'One claim in air',
        font: { size: 40 },
        left: 43,
        top: 120,
        width: 600,
        height: 80,
      },
    ],
  };
  assert.equal(isPptxDiagramSlide(diagram), true);
  assert.equal(isPptxDiagramSlide(text), false);
  assert.equal(isPptxDiagramSlide(corner), false);
  assert.equal(isPptxPictureSlide(pictureSide), true);
  assert.equal(isPptxPictureSlide(inset), false);
  assert.deepEqual(
    inferPptxSlideRoles({
      slideWidth: 960,
      slideHeight: 540,
      slides: [{ index: 1, shapes: [] }, diagram, text, corner, pictureSide, inset],
    }),
    { 4: { visualType: 'diagram' }, 7: { visualType: 'picture' }, 8: { slideRole: 'statement' } }
  );
});

// The decision panel sits to the right of the data; with a four-column table its Stop gate lands in column R
// while the dashboard canvas ends at L. Print and PDF export clip to the print area, so the area follows the panel.
test('a composed dashboard keeps its decision gates inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '결정',
        title: '도크 4 증설 결정',
        headers: ['안', '비용', '야간 대응', '판정'],
        rows: [
          ['주간 전용', '낮음', '불가', '기각'],
          ['야간 전용', '중간', '가능', '채택'],
        ],
        metrics: [{ label: '처리량 증가', value: 1.6 }],
        decision: '야간 전용안을 10월 운영 회의에 올린다.',
        gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }],
      },
    ],
    design: {},
  });
  const column = (label) => [...label].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  const stop = expanded.operations.find((entry) => entry.op === 'set_cell' && entry.value === '증차 불가 시 보류');
  assert.ok(stop, 'the Stop gate is written');
  const merged = expanded.operations.find(
    (entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${stop.cell}:`)
  );
  const gateEnd = /:([A-Z]+)\d+$/.exec(merged.range)[1];
  assert.ok(
    column(area[1]) >= column(gateEnd),
    `print area stops at column ${area[1]} but the Stop gate reaches ${gateEnd}`
  );
  assert.ok(Number(area[2]) >= Number(/\d+$/.exec(stop.cell)[0]), 'the print area reaches the gate rows');
  const autofit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  assert.ok(column(autofit.range.split(':')[1]) >= column(gateEnd), 'the column autofit covers the panel');
});

// The table's columns are the canvas's columns: a metric strip that took two
// columns per card made the title, the strip and the insight band twice the
// width of the table below them, and fit-to-page (which only scales down) then
// printed the whole thing as a small block in the corner of the page.
test('a composed dashboard gives every band the width of its table', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량', '정시 출고율', '지연 건수'],
        rows: [
          ['대전', 128400, 0.928, 96],
          ['광주', 84200, 0.961, 42],
        ],
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원 요청', value: 12, unit: '명' },
          { label: '지연 건수', value: 210 },
        ],
        insights: ['대전 허브의 야간 처리량이 4분기 목표를 좌우합니다.'],
      },
    ],
    design: {},
  });
  const merges = expanded.operations.filter((entry) => entry.op === 'merge_cells').map((entry) => entry.range);
  const bandEnds = new Set(merges.map((range) => /:([A-Z]+)\d+$/.exec(range)?.[1]));
  assert.ok(bandEnds.has('D'), `the bands reach the table's last column: ${[...bandEnds].join(', ')}`);
  assert.ok(!bandEnds.has('E') && !bandEnds.has('F'), `no band runs past the table: ${[...bandEnds].join(', ')}`);
  // The leading card carries the spare column, so three cards over four columns
  // read as a headline metric beside two supporting ones.
  const headline = merges.filter((range) => range.startsWith('A'));
  assert.ok(
    headline.some((range) => /^A\d+:B\d+$/.test(range)),
    headline.join(', ')
  );
  const fit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  assert.equal(fit.range, 'A:D');
  assert.ok(fit.minWidth >= 12, `the columns carry the printed width: ${JSON.stringify(fit)}`);
});

// A plan section named its steps and the writer drew only the heading: the steps
// reached the page solely under kind:'roadmap', so the composer produced the
// orphan heading its own audit then reported.
test('a section that names steps writes them without declaring a roadmap', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'executive', purpose: 'decide' },
    operations: [
      {
        op: 'compose_document',
        title: '10월 야간 운영 검토',
        sections: [
          {
            heading: '실행 계획',
            steps: [
              { title: '채용 공고', detail: '10월 20일' },
              { title: '교육 입과', detail: '11월 1일' },
            ],
          },
        ],
      },
    ],
  });
  const table = expanded.operations.find((entry) => entry.op === 'add_table');
  assert.ok(table, JSON.stringify(expanded.operations.map((entry) => entry.op)));
  assert.deepEqual(
    table.values.map((row) => row[1]),
    ['채용 공고\n10월 20일', '교육 입과\n11월 1일']
  );
  // Its first row is a step, not a header: repeating it on a continuation page
  // showed step one twice and hid the step it replaced.
  assert.equal(table.properties.repeatHeader, false);
  assert.ok(
    table.properties.rowHeights.every((height) => height <= 48),
    `a step is a row, not a page band: ${JSON.stringify(table.properties.rowHeights)}`
  );
  // Steps the writer cannot read are refused rather than dropped.
  assert.throws(
    () =>
      expandOfficeDesignOperations({
        format: 'docx',
        backend: 'mixdog-ooxml',
        created: true,
        operations: [{ op: 'compose_document', title: '계획', sections: [{ heading: '실행', steps: [{ note: '' }] }] }],
      }),
    /steps this writer cannot read/
  );
});

// Three cards over a two-column table pulled the canvas - and every band on it -
// half again past the table. The strip wraps instead.
test('a metric strip wider than the table wraps onto a second strip', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량'],
        rows: [
          ['대전', 128400],
          ['광주', 84200],
        ],
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원 요청', value: 12, unit: '명' },
          { label: '지연 건수', value: 210 },
        ],
      },
    ],
    design: {},
  });
  const merges = expanded.operations.filter((entry) => entry.op === 'merge_cells').map((entry) => entry.range);
  assert.ok(
    merges.every((range) => /:B\d+$/.test(range)),
    `no band runs past the table's last column: ${merges.join(', ')}`
  );
  const cards = expanded.operations
    .filter((entry) => entry.op === 'set_cell' && ['정시 출고율', '야간 증원 요청', '지연 건수'].includes(entry.value))
    .map((entry) => Number(/(\d+)$/.exec(entry.cell)[1]));
  assert.equal(new Set(cards).size, 2, `the three cards sit on two strips: rows ${cards.join(', ')}`);
  // The sheet that cannot fill a landscape page is printed on the narrow one.
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  assert.equal(page.orientation, 'portrait');
});

// Every data column became a series, so a count (128,400), a rate (0.928) and a
// tally (96) shared one axis: the legend named three series and the chart drew
// one, with the other two flattened onto the baseline.
test('a composed chart drops series that cannot share its axis', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량', '정시 출고율', '지연 건수'],
        rows: [
          ['대전', 128400, 0.928, 96],
          ['광주', 84200, 0.961, 42],
        ],
        chart: { title: '허브별 처리량', chartType: 'column' },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  assert.match(chart.range, /^A\d+:B\d+$/, `the chart plots the throughput column alone: ${chart.range}`);
  // The chart is a band of the same composition: it starts at the canvas edge and
  // ends where the table ends.
  const fit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  const columnPoints = (fit.minWidth * 7 + 5) * 0.75;
  assert.equal(chart.left, 0);
  assert.ok(
    Math.abs(chart.width - columnPoints * 4) < 1,
    `the chart spans the four canvas columns: ${chart.width}pt vs ${columnPoints * 4}pt`
  );
});

test('a composed sheet keeps its chart inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Sheet1',
        title: 'Regional revenue',
        headers: ['Region', 'Revenue'],
        rows: [
          ['Korea', 200],
          ['Japan', 210],
          ['US', 290],
        ],
        chart: { title: 'Revenue' },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  assert.equal(page.fitToContent, true);
  const endColumn = [...area[1]].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  // Print and PDF export clip to the print area; a chart outside it disappears
  // from every exported copy while still looking correct on screen.
  assert.ok(
    endColumn * 48 >= chart.left + chart.width,
    `print area stops at column ${area[1]} but the chart reaches ${chart.left + chart.width}pt`
  );
  assert.ok(
    Number(area[2]) * 15 >= chart.top + chart.height,
    `print area stops at row ${area[2]} but the chart reaches ${chart.top + chart.height}pt`
  );
});

test('a wide composed dashboard keeps its chart clear of the data table', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Dashboard',
        kind: 'dashboard',
        headers: ['Month', 'Revenue', 'Profit', 'Margin', 'Churn', 'NPS', 'Growth', 'Retention'],
        rows: [['January', 5000, 650, 0.13, 0.031, 49, 60, 55]],
        chart: { title: 'Performance', left: 440, width: 520 },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  // The chart clears the rows the table actually occupies. A fixed 300pt floor
  // read as an empty band between the two on every short dashboard.
  const lastRow = Math.max(
    ...expanded.operations
      .flatMap((entry) => [entry.cell, entry.range?.split(':')?.[1]])
      .map((reference) => Number(/(\d+)$/.exec(String(reference || ''))?.[1] || 0))
  );
  assert.ok(chart.top >= (lastRow + 1) * 20, `chart begins at ${chart.top}pt but the table runs to row ${lastRow}`);
  assert.ok(
    chart.left + chart.width <= 960,
    'moving the chart must preserve the requested right edge and one-page scale'
  );
});

test('composition review blocks repeated and recently duplicated document structures', () => {
  const compositions = Array.from({ length: 4 }, () => ({
    id: 'content:evidence-right',
    family: 'evidence',
    kind: 'content',
    purpose: 'decide',
    topology: { signature: 'pptx|m:0|c:0|s:0|r:0|p:few|e:visual' },
  }));
  const summary = summarizeOfficeCompositions('pptx', compositions);
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [] },
    design: {
      purpose: 'decide',
      compositions,
      review: { allowTextOnly: true, allowSyntheticVisuals: true },
    },
    library: {
      source: 'mixdog-starter',
      recentCompositions: [
        {
          ...summary,
          purpose: 'decide',
          expressionMode: 'strong-fit',
        },
      ],
    },
  });
  assert.ok(review.issues.some((entry) => entry.code === 'repetitive_composition'));
  assert.ok(review.issues.some((entry) => entry.code === 'recent_composition_repeat'));
  assert.equal(review.composition.fingerprint, summary.fingerprint);
});

test('Office composition history is bounded, replaces a document record, and excludes the active path', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'data');
  const documentPath = join(cwd, 'brief.docx');
  await recordOfficeCompositionHistory(dataDir, {
    documentPath,
    format: 'docx',
    profile: 'editorial',
    purpose: 'decide',
    expressionMode: 'strong-fit',
    fingerprint: 'first',
    compositionIds: ['decision-brief'],
  });
  await recordOfficeCompositionHistory(dataDir, {
    documentPath,
    format: 'docx',
    profile: 'editorial',
    purpose: 'decide',
    expressionMode: 'divergent',
    fingerprint: 'second',
    compositionIds: ['evidence-brief'],
  });
  const history = await readOfficeCompositionHistory(dataDir, { format: 'docx' });
  assert.equal(history.length, 1);
  assert.equal(history[0].fingerprint, 'second');
  assert.deepEqual(history[0].compositionIds, ['evidence-brief']);
  assert.deepEqual(
    await readOfficeCompositionHistory(dataDir, { format: 'docx', excludeDocumentPath: documentPath }),
    []
  );
});

test('PPTX review exempts the cover while a short deck still owes evidence', () => {
  const textOnly = (index) => ({
    index,
    background: { color: 'F5F2EC', followMaster: false, source: 'slide' },
    shapes: [
      {
        type: 17,
        text: `Slide ${index} carries only body copy`,
        left: 60,
        top: 80,
        width: 700,
        height: 90,
        font: { size: 20 },
      },
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [textOnly(1), textOnly(2)] },
    design: { deck: { backgroundMode: 'custom' } },
  });
  assert.deepEqual(
    review.issues.filter((issue) => issue.code === 'meaningful_visual_missing').map((issue) => issue.path),
    ['/slide[2]'],
    'a cover never owes a chart, but the content slide of a two-slide deck still does'
  );
});

test('PPTX visual critique requires distinct per-slide evidence across five axes', () => {
  const entry = (slide, note, overrides = {}) => ({
    slide,
    verdict: 'pass',
    hierarchy: 4,
    balance: 4,
    legibility: 4,
    cohesion: 4,
    evidence: 4,
    note,
    fixes: [],
    ...overrides,
  });
  const passing = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [
      entry(1, 'Cover establishes one dark focal statement and a clear numeric transition.'),
      entry(2, 'Body uses one dominant comparison axis with readable supporting labels.'),
      entry(3, 'Closing repeats the dark frame and lands one concise executive action.'),
    ],
  });
  assert.equal(passing.status, 'pass');
  const incomplete = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [
      entry(1, 'Repeated generic note that does not distinguish the slide composition.'),
      entry(2, 'Repeated generic note that does not distinguish the slide composition.'),
    ],
  });
  assert.ok(incomplete.issues.some((issue) => issue.code === 'visual_critique_missing_slide'));
  // A template answer is not a review: swapping the slide number into one
  // sentence, or asking every slide the same three questions, says nothing
  // about the page it judges.
  const numbered = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [1, 2, 3].map((slide) =>
      entry(slide, `슬라이드 ${slide}: 계획한 역할대로 읽히고 제목과 근거의 위계가 분리되어 보입니다.`)
    ),
  });
  assert.ok(numbered.issues.some((issue) => issue.code === 'visual_critique_repeated_note'));
  const sameChecks = reviewPptxVisualCritique({
    pageCount: 2,
    requireChecks: true,
    critique: [
      entry(1, 'Cover establishes one dark focal statement and a clear numeric transition.', {
        checks: [
          { item: 'the slide is readable', pass: true },
          { item: 'the figures match the fact sheet', pass: true },
          { item: 'the accent marks the conclusion', pass: true },
        ],
      }),
      entry(2, 'Body uses one dominant comparison axis with readable supporting labels.', {
        checks: [
          { item: 'the slide is readable', pass: true },
          { item: 'the figures match the fact sheet', pass: true },
          { item: 'the accent marks the conclusion', pass: true },
        ],
      }),
    ],
  });
  assert.ok(sameChecks.issues.some((issue) => issue.code === 'visual_critique_repeated_note'));
  assert.match(
    sameChecks.issues.find((issue) => issue.code === 'visual_critique_repeated_note').message,
    /own plan line/
  );
  const failed = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'The focal visual remains too weak and needs a larger evidence area.', {
        verdict: 'needs-polish',
        balance: 2,
        fixes: ['Enlarge the evidence visual.'],
      }),
    ],
  });
  assert.ok(failed.issues.some((issue) => issue.code === 'visual_critique_needs_polish'));
  const anchor = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'A section anchor: one statement on a receded picture, no evidence by design.', {
        role: 'section',
        evidence: 2,
      }),
    ],
  });
  assert.equal(anchor.status, 'pass', 'an anchor is not gated on evidence');
  const anchorWeak = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'A section anchor whose statement does not read at thumbnail size on the picture.', {
        role: 'section',
        legibility: 2,
      }),
    ],
  });
  assert.ok(
    anchorWeak.issues.some((issue) => issue.code === 'visual_critique_needs_polish'),
    'the other axes still gate an anchor'
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:2',
      expectedToken: 'office_1:2',
      renderedVersion: 2,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    true
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:1',
      expectedToken: 'office_1:2',
      renderedVersion: 2,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    false
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:2',
      expectedToken: 'office_1:2',
      renderedVersion: 1,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    false
  );
});

test('signed Office design packs hot-update model tokens while existing bindings stay pinned', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'design-library-data');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustedKeys = {
    'test-key': publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const config = {
    manifestUrl: 'https://design.example.test/stable.json',
    trustedKeys,
    channel: 'stable',
    templateDirectories: [],
  };
  const makePack = (version, accent) => ({
    schemaVersion: 1,
    id: 'verified-layouts',
    version,
    channel: 'stable',
    profiles: {
      brand: {
        extends: 'technical',
        label: 'Verified Brand',
        tokens: { colors: { accent } },
      },
    },
    defaultProfiles: { pptx: 'brand' },
    layouts: [
      {
        id: `statement-${version.replaceAll('.', '-')}`,
        format: 'pptx',
        kind: 'statement',
        profile: 'brand',
        defaults: { titleSize: 42 },
      },
    ],
    templates: [],
  });
  const envelopeFor = (pack, signingKey = privateKey) => ({
    schemaVersion: 1,
    keyId: 'test-key',
    pack,
    signature: signBytes(null, Buffer.from(canonicalOfficeDesignPack(pack)), signingKey).toString('base64'),
  });
  let envelope = envelopeFor(makePack('1.0.0', 'C43E2F'));
  const fetchImpl = async () =>
    new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const firstSync = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(firstSync.ok, true, firstSync.warning);
  assert.equal(firstSync.active.version, '1.0.0');
  const firstDocument = join(cwd, 'first.pptx');
  const firstLibrary = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: firstDocument,
    format: 'pptx',
    created: true,
    request: {},
    config,
    fetchImpl,
  });
  await persistOfficeDesignBinding(dataDir, firstDocument, firstLibrary.binding);
  assert.equal(firstLibrary.binding.packVersion, '1.0.0');

  envelope = envelopeFor(makePack('2.0.0', '7C3AED'));
  const secondSync = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(secondSync.ok, true, secondSync.warning);
  assert.equal(secondSync.active.version, '2.0.0');
  const pinned = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: firstDocument,
    format: 'pptx',
    created: false,
    request: {},
    config,
    fetchImpl,
  });
  assert.equal(pinned.pack.version, '1.0.0');
  assert.equal(pinned.pinned, true);
  const secondLibrary = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'second.pptx'),
    format: 'pptx',
    created: true,
    request: {},
    config,
    fetchImpl,
  });
  assert.equal(secondLibrary.pack.version, '2.0.0');
  const resolved = resolveOfficeDesign('pptx', {}, { library: secondLibrary });
  assert.equal(resolved.profile, 'brand');
  assert.equal(resolved.tokens.colors.accent, '7C3AED');
  // The pinned pack's palette resolves for a deck even though decks are authored, not composed.
  assert.equal(resolveOfficeDesign('pptx', {}, { library: secondLibrary }).tokens.colors.accent, '7C3AED');

  const tampered = makePack('3.0.0', 'DC2626');
  envelope = {
    ...envelopeFor(makePack('2.0.0', '7C3AED')),
    pack: tampered,
  };
  const rejected = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.warning, /signature verification failed/);
  assert.equal(rejected.active.version, '2.0.0');
});

// A deck someone brings carries no {{TOKEN}} slots and no placeholders: its
// pages are drawn boxes, so the placeholder rules find no title on them and
// never a column. The page's own geometry is what says which box is which.
test('PPTX page roles are induced from the geometry of a deck that has no placeholders', () => {
  const box = (shape, left, top, width, height, text, fontSize) => ({
    shape,
    type: 'text',
    text,
    placeholderType: '',
    geometry: { left, top, width, height },
    fontSize,
  });
  const columns = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 400_000, 8_000_000, 900_000, '분기별 처리량 비교', 32),
      box(2, 600_000, 1_800_000, 3_400_000, 600_000, '기존 방식', 18),
      box(3, 4_400_000, 1_800_000, 3_400_000, 600_000, '개선 후', 18),
      box(4, 600_000, 2_600_000, 3_400_000, 1_200_000, '평균 3.4초가 걸렸다', 14),
      box(5, 4_400_000, 2_600_000, 3_400_000, 1_200_000, '평균 1.3초로 줄었다', 14),
    ],
  });
  assert.equal(columns.get(1), 'title');
  assert.equal(columns.get(2), 'column-title-1');
  assert.equal(columns.get(3), 'column-title-2');
  assert.equal(columns.get(4), 'column-body-1');
  assert.equal(columns.get(5), 'column-body-2');

  const metrics = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 2_000_000, 2_400_000, 800_000, '38%', 40),
      box(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '12건', 40),
      box(3, 600_000, 2_900_000, 2_400_000, 500_000, '재작업 비율', 12),
      box(4, 3_400_000, 2_900_000, 2_400_000, 500_000, '지연 건수', 12),
    ],
  });
  assert.equal(metrics.get(1), 'metric-value-1');
  assert.equal(metrics.get(3), 'metric-label-1');
  assert.equal(metrics.get(4), 'metric-label-2');

  // A chevron flow sizes every marker to the word it carries, so the row is
  // peers by band and height and never by width; the markers name the structure
  // and the labels drawn on them fill the slots.
  const marker = (shape, left, width) => ({
    shape,
    type: 'text',
    text: '',
    geometry: { left, top: 148, width, height: 101 },
    preset: 'chevron',
  });
  const steps = inducePptxSampleRoles(
    {
      shapes: [
        marker(1, 43, 221),
        box(2, 68, 148, 170, 101, '초안', 12),
        marker(3, 239, 231),
        box(4, 264, 148, 181, 101, '검토', 12),
        marker(5, 445, 282),
        box(6, 470, 148, 231, 101, '승인', 12),
      ],
    },
    { width: 960, height: 540 }
  );
  assert.equal(steps.get(2), 'step-title-1');
  assert.equal(steps.get(4), 'step-title-2');
  assert.equal(steps.get(6), 'step-title-3');

  // Two stacked rows of equal boxes are a grid, not six columns: a role names
  // exactly one box to fill, so only the page's strongest row speaks.
  const grid = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 1_000_000, 2_000_000, 700_000, '가', 14),
      box(2, 3_000_000, 1_000_000, 2_000_000, 700_000, '나', 14),
      box(3, 5_400_000, 1_000_000, 2_000_000, 700_000, '다', 14),
      box(4, 600_000, 4_000_000, 2_000_000, 700_000, '라', 14),
      box(5, 3_000_000, 4_000_000, 2_000_000, 700_000, '마', 14),
      box(6, 5_400_000, 4_000_000, 2_000_000, 700_000, '바', 14),
    ],
  });
  assert.equal(grid.size, 3);
  assert.equal(new Set(grid.values()).size, 3);
});

// Reading a deck to reuse it: the page answers with the job it does and each
// box with the slot it fills, on either backend, so the page the user already
// owns can be chosen and filled instead of composed again.
test('a PPTX snapshot reports each page job and the slot every box fills', () => {
  const box = (index, left, top, width, height, text, size) => ({
    index,
    left,
    top,
    width,
    height,
    text,
    font: { size },
  });
  const document = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 2,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      {
        index: 1,
        shapes: [box(1, 0.8, 2.6, 9, 1.4, '야간 출고 개선 보고', 40), box(2, 0.8, 4.2, 6, 0.5, '운영지원팀', 14)],
      },
      {
        index: 2,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '도입 전후 비교', 30),
          box(2, 0.7, 2, 5.6, 0.6, '도입 전', 20),
          box(3, 6.9, 2, 5.6, 0.6, '도입 후', 20),
          box(4, 0.7, 2.8, 5.6, 1.6, '평균 3.4초가 걸렸다', 14),
          box(5, 6.9, 2.8, 5.6, 1.6, '평균 1.3초로 줄었다', 14),
        ],
      },
    ],
  });
  assert.equal(document.slides[0].role, 'cover');
  assert.equal(document.slides[0].shapes[0].slot, 'title');
  assert.equal(document.slides[1].role, 'comparison');
  assert.equal(document.slides[1].shapes[1].slot, 'column-title-1');
  assert.equal(document.slides[1].shapes[4].slot, 'column-body-2');

  // The first page is the cover only when it carries nothing a cover never has:
  // a deck that opens on its comparison page answers with that job.
  const single = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 1,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      {
        index: 1,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '도입 전후 비교', 30),
          box(2, 0.7, 2, 5.6, 0.6, '도입 전', 20),
          box(3, 6.9, 2, 5.6, 0.6, '도입 후', 20),
          box(4, 0.7, 2.8, 5.6, 1.6, '묶음으로 실어 대기가 길었다', 14),
          box(5, 6.9, 2.8, 5.6, 1.6, '도크별로 나눠 대기가 사라졌다', 14),
        ],
      },
    ],
  });
  assert.equal(single.slides[0].role, 'comparison');
});

// Capacity decides which page answers and whether it can answer at all: a page
// takes another item by being replaced, never by shrinking its type.
test('a template page refuses more items than it holds and the closest fitting page answers', () => {
  const page = (index, columns) => ({
    index,
    role: 'comparison',
    shapes: [
      { index: 1, slot: 'title', text: '' },
      ...Array.from({ length: columns }, (_, position) => [
        { index: 2 + position * 2, slot: `column-title-${position + 1}`, text: '' },
        { index: 3 + position * 2, slot: `column-body-${position + 1}`, text: '' },
      ]).flat(),
    ],
  });
  const document = { slides: [page(1, 4), page(2, 2)] };
  assert.equal(selectTemplatePage(document, { role: 'comparison', items: [{}, {}] }).index, 2);
  assert.equal(selectTemplatePage(document, { role: 'comparison', items: [{}, {}, {}] }).index, 1);
  assert.throws(
    () => templatePageFill(page(1, 2), { items: [{}, {}, {}] }),
    /holds 2 column slots and 3 items were given/
  );
  const fill = templatePageFill(page(1, 3), { title: '비교', items: [{ title: '가', body: '가 설명' }] });
  assert.deepEqual(
    fill.sets.map((entry) => entry.shape),
    [1, 2, 3]
  );
  assert.deepEqual(fill.deletes, [7, 6, 5, 4]);
});

// Reuse, end to end: the page is chosen by the job it does, its slots take the
// words, and the slots no item claimed are emptied rather than left carrying the
// template's own words.
test('use_template_page takes the page whose job matches and fills its slots', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const template = join(cwd, 'template.pptx');
  const built = await office({
    action: 'author',
    path: template,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const cover = p.addSlide();
      cover.addText('브랜드 덱', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      cover.addText('디자인팀', {x:0.8,y:4.2,w:6,h:0.5,fontSize:14});
      const compare = p.addSlide();
      compare.addText('세 방식 비교', {x:0.7,y:0.5,w:11.9,h:0.9,fontSize:30});
      compare.addText('가 방식', {x:0.7,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('나 방식', {x:4.8,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('다 방식', {x:8.9,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('가 설명', {x:0.7,y:2.8,w:3.8,h:1.6,fontSize:14});
      compare.addText('나 설명', {x:4.8,y:2.8,w:3.8,h:1.6,fontSize:14});
      compare.addText('다 설명', {x:8.9,y:2.8,w:3.8,h:1.6,fontSize:14});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: built.session });
  const deck = join(cwd, 'deck.pptx');
  const created = await office({
    action: 'author',
    path: deck,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const s = p.addSlide();
      s.addText('야간 출고 보고', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: created.session });
  const opened = await office({ action: 'open', path: deck, mode: 'portable' });
  t.after(async () => {
    await office({ action: 'close', session: opened.session }).catch(() => {});
  });
  await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'use_template_page',
        path: template,
        role: 'comparison',
        after: 1,
        title: '출고 방식 비교',
        items: [
          { title: '기존', body: '묶음으로 실어 대기가 길었다' },
          { title: '개선', body: '도크별로 나눠 대기가 사라졌다' },
        ],
      },
    ],
  });
  const snapshot = await office({ action: 'snapshot', session: opened.session });
  assert.equal(snapshot.document.slides.length, 2);
  const page = snapshot.document.slides[1];
  const texts = page.shapes.map((shape) => shape.text);
  assert.equal(page.role, 'comparison');
  assert.ok(texts.includes('출고 방식 비교'), texts.join(' | '));
  assert.ok(texts.includes('기존'), texts.join(' | '));
  assert.ok(texts.includes('도크별로 나눠 대기가 사라졌다'), texts.join(' | '));
  // The third column claimed no item, so its boxes left with it.
  assert.equal(page.shapes.length, 5);
  assert.ok(!texts.includes('다 방식'), texts.join(' | '));
  assert.ok(!texts.includes('다 설명'), texts.join(' | '));
});

// The same reading through the session a user actually opens: an authored deck
// carries no placeholder at all, so every role here is induced from geometry.
test('a session snapshot answers with the page job and the slots of a drawn deck', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const authored = await office({
    action: 'author',
    path: join(cwd, 'roles.pptx'),
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const cover = p.addSlide();
      cover.addText('야간 출고 개선 보고', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      cover.addText('운영지원팀', {x:0.8,y:4.2,w:6,h:0.5,fontSize:14});
      const compare = p.addSlide();
      compare.addText('도입 전후 비교', {x:0.7,y:0.5,w:11.9,h:0.9,fontSize:30});
      compare.addText('도입 전', {x:0.7,y:2,w:5.6,h:0.6,fontSize:20});
      compare.addText('도입 후', {x:6.9,y:2,w:5.6,h:0.6,fontSize:20});
      compare.addText('묶음 단위로 실어 대기가 길었다', {x:0.7,y:2.8,w:5.6,h:1.6,fontSize:14});
      compare.addText('도크별로 나눠 대기가 사라졌다', {x:6.9,y:2.8,w:5.6,h:1.6,fontSize:14});
      await p.writeFile({fileName:OUTPUT});`,
  });
  t.after(async () => {
    await office({ action: 'close', session: authored.session }).catch(() => {});
  });
  const snapshot = await office({ action: 'snapshot', session: authored.session });
  const [cover, compare] = snapshot.document.slides;
  assert.equal(cover.role, 'cover');
  assert.equal(compare.role, 'comparison');
  assert.equal(compare.shapes[0].slot, 'title');
  assert.equal(compare.shapes[1].slot, 'column-title-1');
  assert.equal(compare.shapes[4].slot, 'column-body-2');
});

test('local Office template indexing detects changes without rebinding existing documents', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'design-library-data');
  const templates = join(cwd, 'templates');
  const template = join(templates, 'brand.pptx');
  await mkdir(templates, { recursive: true });
  await writeFile(template, Buffer.from('template-v1'));
  await writeFile(
    `${template}.mixdog.json`,
    JSON.stringify({
      id: 'brand-deck',
      label: 'Brand Deck',
      layouts: [
        {
          id: 'brand-statement',
          format: 'pptx',
          kind: 'statement',
          defaults: { titleSize: 44 },
        },
      ],
    })
  );
  const config = { templateDirectories: [templates] };
  const first = await indexOfficeTemplates({ dataDir, config });
  const firstTemplate = first.templates.find((entry) => entry.id === 'brand-deck');
  assert.ok(firstTemplate);
  const document = join(cwd, 'bound.pptx');
  const selected = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: document,
    format: 'pptx',
    created: true,
    request: { template: 'brand-deck' },
    config,
  });
  assert.equal(selected.template.id, 'brand-deck');
  assert.equal(selected.layouts[0].id, 'brand-statement');
  await persistOfficeDesignBinding(dataDir, document, selected.binding);

  await writeFile(template, Buffer.from('template-v2-with-new-content'));
  const second = await indexOfficeTemplates({ dataDir, config });
  const secondTemplate = second.templates.find((entry) => entry.id === 'brand-deck');
  assert.equal(second.changed, true);
  assert.notEqual(secondTemplate.version, firstTemplate.version);
  const existing = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: document,
    format: 'pptx',
    created: false,
    request: {},
    config,
  });
  assert.equal(existing.binding.templateVersion, firstTemplate.version);
  assert.equal(existing.template, null);
  assert.match(existing.warning, /remains unchanged/);
  const next = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'next.pptx'),
    format: 'pptx',
    created: true,
    request: { template: 'brand-deck' },
    config,
  });
  assert.equal(next.template.version, secondTemplate.version);

  await writeFile(`${template}.mixdog.json`, JSON.stringify({ id: 'invalid template id' }));
  const degraded = await syncOfficeDesignLibrary({
    dataDir,
    config,
    allowRemote: false,
    indexTemplates: true,
  });
  assert.equal(degraded.ok, false);
  assert.match(degraded.warning, /template index was not updated/);
  assert.equal(degraded.templates.revision, second.revision);
  const fallback = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'fallback.pptx'),
    format: 'pptx',
    created: true,
    request: {},
    config,
  });
  assert.equal(fallback.source, 'mixdog-starter');
  assert.match(fallback.warning, /template index was not updated/);
});

test('Office design composition maps Word, Excel, and PDF to native structures', () => {
  const word = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_document',
        title: 'Decision brief',
        subtitle: 'Prepared for review',
        sections: [
          {
            heading: 'Recommendation',
            paragraphs: ['Adopt semantic composition.'],
            bullets: ['Preserve native styles.'],
            table: [
              ['Owner', 'Status'],
              ['Mixdog', 'Ready'],
            ],
          },
        ],
        footer: 'Source: operating model',
        pageNumbers: true,
      },
    ],
  });
  assert.ok(word.operations.some((operation) => operation.op === 'set_page'));
  assert.ok(
    word.operations.some((operation) => operation.op === 'append_text' && operation.properties.listKind === 'bullet')
  );
  assert.ok(word.operations.some((operation) => operation.op === 'set_table_cell_style'));
  assert.ok(
    word.operations.some(
      (operation) =>
        operation.op === 'add_page_numbers' &&
        operation.alignment === 'center' &&
        operation.prefix === 'Source: operating model · ' &&
        operation.separator === ' / '
    )
  );
  assert.ok(!word.operations.some((operation) => operation.op === 'set_header_footer'));
  // A section table the composer cannot write is refused, because a dropped
  // table reads as a finished document; the shape it does take still writes.
  const composeWith = (table) =>
    expandOfficeDesignOperations({
      format: 'docx',
      backend: 'microsoft-office-com',
      created: true,
      operations: [{ op: 'compose_document', title: 'Cost', sections: [{ heading: 'Ask', table }] }],
    });
  assert.throws(
    () =>
      composeWith({
        values: [
          ['Item', 'Cost'],
          ['Crew', '12'],
        ],
      }),
    /sections\[1\]\.table does not take values.*headers/s
  );
  assert.throws(() => composeWith({ rows: 'Crew' }), /rows must be an array of row arrays/);
  const keyed = composeWith({ headers: ['Item', 'Cost'], rows: [['Crew', '12']] });
  const keyedTable = keyed.operations.find((operation) => operation.op === 'add_table');
  assert.deepEqual(keyedTable.values, [
    ['Item', 'Cost'],
    ['Crew', '12'],
  ]);
  // A bound fact is written the way the prose writes it, and the cell style the
  // composer asks for is one the contract accepts — the metric strip was
  // refused by the runtime's own validation until both agreed.
  const measured = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      purpose: 'decide',
      content: {
        packageId: 'ops',
        facts: [
          { id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' },
          { id: 'throughput', label: 'Throughput', value: 47210, unit: 'orders' },
        ],
        claims: [{ id: 'approve', text: 'Approve the crew', factIds: ['on-time', 'throughput'] }],
      },
    },
    operations: [
      {
        op: 'compose_document',
        title: 'Night shift',
        claimId: 'approve',
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        sections: [{ heading: 'Evidence', paragraphs: ['Throughput reached 47,210 orders.'] }],
      },
    ],
  });
  const strip = measured.operations.find((operation) => operation.op === 'add_table');
  // The unit is part of the figure it counts, not a line under it: parked on the
  // detail row it rendered as an orphan word beside empty cells, and the value
  // above it lost its unit. A Latin unit keeps the space it is read with.
  assert.deepEqual(strip.values[1], ['92.8%', '47,210 orders']);
  // A detail row nobody filled rendered as a blank band under the figures, so
  // the strip stops at the values unless a metric says something there.
  assert.equal(strip.values.length, 2, JSON.stringify(strip.values));
  const detailless = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: {
      purpose: 'decide',
      content: { facts: [{ id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' }] },
    },
    operations: [{ op: 'compose_document', title: 'Night shift', metrics: [{ factId: 'on-time' }] }],
  });
  const bare = detailless.operations.find((operation) => operation.op === 'add_table');
  assert.equal(bare.values.length, 2, JSON.stringify(bare.values));
  assert.ok(!detailless.operations.some((operation) => operation.op === 'set_table_cell_style' && operation.row === 3));
  // The claim is the sentence the memo exists to make. Binding it to a titled
  // operation put it in the title it already had, so the document shipped with
  // its metrics and evidence and no recommendation in it.
  const recommendation = measured.operations
    .filter((operation) => operation.op === 'append_text')
    .map((operation) => operation.text);
  assert.ok(recommendation.includes('Approve the crew'), JSON.stringify(recommendation));
  assert.equal(recommendation[0], 'Night shift');

  // A fact key the model does not read was dropped, and the figure then shipped
  // in the wrong notation: format:'percent' printed 0.928 beside "92.8%".
  const spoken = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: {
      purpose: 'decide',
      content: {
        packageId: 'ops',
        facts: [{ id: 'on-time', label: '정시 출고율', value: 0.928, format: 'percent' }],
        claims: [{ id: 'approve', text: '야간 인력 12명 증원을 승인해 주십시오.', factIds: ['on-time'] }],
      },
    },
    operations: [
      { op: 'compose_document', title: '야간 운영 확대 검토', claimId: 'approve', metrics: [{ factId: 'on-time' }] },
    ],
  });
  assert.deepEqual(spoken.operations.find((operation) => operation.op === 'add_table').values[1], ['92.8%']);
  // A metric written straight into the preset reads the same spellings as a
  // bound fact: `format: 'percent'` printed 0.928 in the strip, and the unit
  // sat on its own row under an otherwise empty band.
  const written = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { purpose: 'decide' },
    operations: [
      {
        op: 'compose_document',
        title: '10월 야간 운영 보고',
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원', value: 12, unit: '명' },
          { label: '지연 건수', value: 210, detail: '4분기' },
        ],
      },
    ],
  });
  const writtenStrip = written.operations.find((operation) => operation.op === 'add_table');
  assert.deepEqual(writtenStrip.values[1], ['92.8%', '12명', '210']);
  assert.deepEqual(writtenStrip.values[2], ['', '', '4분기']);
  // In a cell the unit rides in the number format, so the value stays a number
  // a formula can use and the sheet still shows "12명".
  const sheet = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { purpose: 'monitor' },
    operations: [
      {
        op: 'compose_sheet',
        title: '야간 운영',
        kind: 'dashboard',
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원', value: 12, unit: '명' },
        ],
      },
    ],
  });
  const formats = sheet.operations
    .filter((operation) => operation.op === 'set_style' && operation.properties?.numberFormat)
    .map((operation) => operation.properties.numberFormat);
  assert.ok(formats.includes('0.0%'), JSON.stringify(formats));
  assert.ok(formats.includes('#,##0"명"'), JSON.stringify(formats));
  assert.throws(
    () =>
      expandOfficeDesignOperations({
        format: 'docx',
        backend: 'mixdog-ooxml',
        created: true,
        design: { content: { facts: [{ id: 'on-time', label: 'On time', value: 0.928, formatting: '0.0%' }] } },
        operations: [{ op: 'compose_document', title: 'Night shift' }],
      }),
    /unknown key\(s\): formatting.*A fact takes: /s
  );
  assertOfficeOperationContracts({
    format: 'docx',
    backend: 'microsoft-office-com',
    operations: measured.operations,
  });
  const workbook = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Summary',
        title: 'Operating summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Calls', 3],
          ['Accuracy', 1],
        ],
      },
    ],
  });
  assert.ok(workbook.operations.some((operation) => operation.op === 'merge_cells'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'add_table'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'autofit_range'));
  const pdf = applyPdfDesign(
    [
      { type: 'heading', text: 'Report' },
      {
        type: 'table',
        rows: [
          ['Metric', 'Value'],
          ['Calls', '3'],
        ],
      },
    ],
    { profile: 'data' }
  );
  assert.equal(pdf.blocks[0].color, '1F2933');
  assert.equal(pdf.blocks[1].headerFill, '183028');
});

test('Office design review rejects decorative stripes and repeated card grids', () => {
  const cardSlide = (index) => ({
    index,
    shapes: [
      { type: 17, text: `Slide ${index}`, left: 50, top: 40, width: 800, height: 50, font: { size: 34 } },
      { type: 1, text: 'Card A explains the first pillar in a sentence.', left: 60, top: 160, width: 240, height: 120 },
      {
        type: 1,
        text: 'Card B explains the second pillar in a sentence.',
        left: 330,
        top: 160,
        width: 240,
        height: 120,
      },
      {
        type: 1,
        text: 'Card C explains the third pillar in a sentence.',
        left: 600,
        top: 160,
        width: 240,
        height: 120,
      },
      { type: 1, text: '', left: 40, top: 90, width: 7, height: 340 },
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [cardSlide(1), cardSlide(2), cardSlide(3), cardSlide(4), cardSlide(5), cardSlide(6)] },
    design: { profile: 'editorial' },
  });
  assert.equal(review.status, 'needs-polish');
  assert.ok(review.issues.some((issue) => issue.code === 'decorative_stripe'));
  assert.ok(review.issues.some((issue) => issue.code === 'card_grid_overuse'));
  assert.ok(review.issues.some((issue) => issue.code === 'repetitive_composition'));
});

test('Office design review judges an authored deck by its own ladder and geometry', () => {
  const title = (index) => ({
    type: 17,
    text: `Slide ${index}`,
    left: 43,
    top: 72,
    width: 800,
    height: 50,
    font: { size: 32 },
  });
  const heroBand = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3].map((column) => ({
        type: 1,
        text: String(40 + column),
        left: 43 + column * 220,
        top: 173,
        width: 200,
        height: 80,
        font: { size: 56 },
      })),
      { type: 1, text: '', left: 43, top: 306, width: 873, height: 1 }, // hairline between rows
      ...[0, 1, 2, 3].map((column) => ({
        type: 1,
        text: 'One line of context under the number.',
        left: 43 + column * 220,
        top: 324,
        width: 195,
        height: 90,
      })),
    ],
  });
  const steps = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3, 4].map((step) => ({
        type: 1,
        text: `Stage ${step} with a short note under the lead.`,
        left: 43 + step * 176,
        top: 389 - step * 61,
        width: 158,
        height: 94,
      })),
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        {
          index: 1,
          background: { color: '1F1512' },
          shapes: [{ type: 17, text: 'Cover', left: 43, top: 180, width: 600, height: 120, font: { size: 44 } }],
        },
        heroBand(2),
        steps(3),
        {
          index: 4,
          background: { color: '1F1512' },
          shapes: [title(4), { type: 1, text: '97%', left: 130, top: 260, width: 230, height: 60, font: { size: 40 } }],
        },
        heroBand(5),
        {
          index: 6,
          background: { color: '1F1512' },
          shapes: [{ type: 17, text: 'Closing', left: 43, top: 180, width: 600, height: 120, font: { size: 36 } }],
        },
      ],
    },
    design: { profile: 'editorial' },
  });
  const codes = new Set(review.issues.map((issue) => issue.code));
  assert.equal(codes.has('theme_background_drift'), false);
  assert.equal(codes.has('decorative_stripe'), false);
  assert.equal(codes.has('card_grid_overuse'), false);
  // An authored deck may open light and close dark: its own two backgrounds are
  // the ladder, whichever slide takes which. Only a third field is drift.
  const lightCover = (slides) =>
    reviewOfficeDesign({
      format: 'pptx',
      document: { slides },
      design: { profile: 'editorial' },
    }).issues.filter((issue) => issue.code === 'theme_background_drift');
  const authored = [
    {
      index: 1,
      background: { color: 'F7FAF9' },
      shapes: [{ type: 17, text: '야간 운영 보고', left: 43, top: 180, width: 600, height: 120, font: { size: 44 } }],
    },
    { index: 2, background: { color: 'F7FAF9' }, shapes: [title(2)] },
    { index: 3, background: { color: 'F7FAF9' }, shapes: [title(3)] },
    {
      index: 4,
      background: { color: '0F241A' },
      shapes: [
        { type: 17, text: '승인을 요청드립니다', left: 43, top: 180, width: 600, height: 120, font: { size: 36 } },
      ],
    },
  ];
  assert.deepEqual(lightCover(authored), []);
  const thirdField = lightCover([
    ...authored.slice(0, 3),
    { ...authored[3], index: 4 },
    { index: 5, background: { color: '7A4E1F' }, shapes: [title(5)] },
  ]);
  assert.equal(thirdField.length, 1);
  assert.match(thirdField[0].message, /5:7A4E1F/);
  const edgeStripe = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [title(2), { type: 1, text: '', left: 0, top: 0, width: 960, height: 6 }],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.ok(edgeStripe.issues.some((issue) => issue.code === 'decorative_stripe'));
  // A level line in a diagram column is not an underline of the hero numeral beside it: they share no columns.
  const beside = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [
            title(2),
            { type: 1, text: '0', left: 660, top: 210, width: 250, height: 80, font: { size: 65 } },
            { type: 1, text: '', left: 80, top: 288, width: 540, height: 0 },
          ],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.equal(
    beside.issues.some((issue) => issue.code === 'decorative_stripe'),
    false
  );
  const underline = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [title(2), { type: 1, text: '', left: 43, top: 130, width: 540, height: 2 }],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.ok(
    underline.issues.some((issue) => issue.code === 'decorative_stripe'),
    'a rule under the title is still an underline'
  );
});
