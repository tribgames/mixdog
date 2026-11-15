#!/usr/bin/env node
// Golden of the office structure review (crate mixdog-office-quality): what Node's `runtime/office/quality/
// assurance-structure.mjs` (`reviewOfficeStructure`, with `assurance-structure-{docx,pptx,xlsx}.mjs`) answers to a fixed
// corpus of portable snapshots: the decks, documents and workbooks that the office-assurance.slow, slide-quality and
// type-floors suites review (their snapshots are written out here, one case per assertion input and per variant the
// assertion tries), and seeded generated decks, documents and workbooks that spread the thresholds (alignment axes and
// peer rows, text collisions and occlusion, contrast and edge margins, heading hierarchy, orphan headings, total rows,
// chart ranges, print areas, drawing overlap, formula audit). Writes native/core/fixtures/office-structure/golden.json
// and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-structure.mjs --tree <product tree>
//
// Every section is a list of cases { input: { format, auditProfile?, document }, output | error }: the issue list in
// Node's order. The generator is deterministic and every input is plain JSON.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, orderedStringify, parseArgs, resolveTree, stageSet, writeSetManifest, writeText } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-structure.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-structure');
const stage = stageSet(finalDir);
const { reviewOfficeStructure } = await importFrom(tree, 'src/runtime/office/quality/assurance-structure.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const record = (inputs) =>
  inputs.map((raw) => {
    const input = plain(raw);
    try {
      return { input, output: plain(reviewOfficeStructure(plain(input))) };
    } catch (error) {
      return { input, error: String(error?.message ?? error) };
    }
  });

// ---- the suites' own snapshots -------------------------------------------------------------------------------------

const deck = (slides, extra = {}) => ({ slideWidth: 960, slideHeight: 540, ...extra, slides });
const slide = (shapes, extra = {}) => ({
  path: '/slide[1]',
  index: 1,
  ...extra,
  shapes: shapes.map((shape, index) => ({ path: `/slide[1]/shape[${index + 1}]`, index: index + 1, ...shape })),
});
const pptx = (document, auditProfile) => ({ format: 'pptx', ...(auditProfile ? { auditProfile } : {}), document });
const docx = (document) => ({ format: 'docx', document });
const xlsx = (document, auditProfile) => ({ format: 'xlsx', ...(auditProfile ? { auditProfile } : {}), document });

const suite = [];

// type-floors.test.mjs
const floorDeck = (width, height, size, note, extra = {}) =>
  deck(
    [
      slide([
        { text: '본문 문단의 첫째 줄입니다.\n둘째 줄도 본문입니다.', left: 40, top: 60, width: 400, height: 60, font: { size } },
        { text: '출처: 운영 시스템', left: 40, top: height - 80, width: 300, height: 16, font: { size: note } },
      ], { notes: '' }),
    ],
    { slideWidth: width, slideHeight: height, ...extra }
  );
for (const [width, height, size, note, extra] of [
  [960, 540, 11, 8.5, {}],
  [720, 540, 11, 8.5, {}],
  [720, 540, 12, 9, {}],
  [720, 405, 9, 7, {}],
  [720, 405, 8.5, 6.5, {}],
  [595, 842, 9.5, 7.5, { printSheet: true }],
  [595, 842, 8.5, 6.5, { printSheet: true }],
  [595, 842, 9.5, 7.5, {}],
  [1280, 720, 12, 9, {}],
  [1280, 720, 10, 8, {}],
]) {
  suite.push(pptx(floorDeck(width, height, size, note, extra)));
}

// office-assurance.slow.test.mjs
for (const [size, length] of [[20, 200], [11, 200], [20, 40], [18, 181], [18, 180], [17.9, 400]]) {
  suite.push(docx({ paragraphs: [{ path: '/body/p[1]', index: 1, text: '가'.repeat(length), font: { size } }], tables: [] }));
}
suite.push(
  docx({
    paragraphs: [
      { path: '/body/p[1]', index: 1, text: '결론', style: '제목 1', pageStart: 1, start: 1 },
      { path: '/body/p[2]', index: 2, text: '다음 페이지 본문', style: '본문', pageStart: 2, start: 20 },
    ],
    tables: [],
    blockOrder: [
      { type: 'paragraph', index: 1, path: '/body/p[1]', start: 1 },
      { type: 'paragraph', index: 2, path: '/body/p[2]', start: 20 },
    ],
  }),
  docx({
    paragraphs: [
      { path: '/body/p[1]', index: 1, text: '결론', style: '제목 1', pageStart: 1, start: 1 },
      { path: '/body/p[2]', index: 2, text: '표 셀', style: '제목 1', pageStart: 2, start: 20, inTable: true },
    ],
    tables: [{ path: '/body/tbl[1]', index: 1, pageStart: 1, pageEnd: 1, rows: [{ cells: [] }], start: 18 }],
    blockOrder: [
      { type: 'table', index: 1, path: '/body/tbl[1]', start: 18 },
      { type: 'paragraph', index: 1, path: '/body/p[1]', start: 1 },
    ],
  }),
  xlsx({
    sheets: [
      {
        path: '/sheet[Summary]',
        name: 'Summary',
        cells: [{ path: '/sheet[Summary]/cell[A11]', ref: 'A11', value: 'Total', style: {} }],
        charts: [{ path: '/sheet[Summary]/chart[1]', series: [{ formula: '=SERIES("Actual",Summary!$A$2:$A$11,Summary!$B$2:$B$11,1)' }] }],
      },
    ],
  })
);
const para = (index, style, text, font, extra = {}) => ({ path: `/body/p[${index}]`, index, style, text, font, ...extra });
suite.push(
  docx({
    paragraphs: [
      para(1, 'Heading1', '운영 개선 보고', { size: 24, bold: true }),
      para(2, 'Normal', '야간 출고 흐름을 다시 짰다.', { size: 11 }),
      para(3, 'Heading1', '배경', { size: 11 }),
      para(4, 'Normal', '묶음 단위로 실어 대기가 길었다.', { size: 11 }),
      para(5, 'Normal', '도크별로 나눈 뒤 대기가 사라졌다.', { size: 11 }),
    ],
  }),
  docx({
    paragraphs: [
      para(1, 'Heading1', '운영 개선 보고', { size: 24, bold: true }),
      para(2, 'Heading1', '배경', { size: 14, bold: true }),
      para(3, 'Normal', '묶음 단위로 실어 대기가 길었다.', { size: 11 }),
      para(4, 'Heading1', '결과', { size: 18, bold: true }),
    ],
  })
);
for (const [font, extra] of [
  [{ size: 11, color: 'C0392B' }, {}],
  [{ size: 11, color: '222222', caps: true }, {}],
  [{ size: 11, color: '222222' }, { spaceBefore: 18 }],
  [{ size: 11, color: '222222' }, {}],
  [{ size: 11, color: '#222222' }, {}],
  [{ size: 11, color: 'auto' }, {}],
  [{ size: 11, color: '222222', letterSpacing: 1.5 }, {}],
  [{ size: 11, color: '222222' }, { format: { spacingBefore: 6, spacingAfter: 6 } }],
  [{ size: 12, color: '222222' }, {}],
  [{ size: 11, color: '222222', bold: true }, {}],
]) {
  suite.push(
    docx({
      paragraphs: [
        para(1, 'Heading1', '배경', font, extra),
        para(2, 'Normal', '본문 문장이다.', { size: 11, color: '222222' }),
        para(3, 'Normal', '본문 문장이다.', { size: 11, color: '222222' }),
      ],
    })
  );
}
const shortSheet = (cells) =>
  xlsx({
    sheets: [
      {
        path: '/sheet[Ops]',
        name: 'Ops',
        cells: cells.map((cell) => ({ path: `/sheet[Ops]/cell[${cell.ref}]`, style: {}, ...cell })),
        charts: [{ path: '/sheet[Ops]/chart[1]', series: [{ formula: '=SERIES("처리량",Ops!$A$2:$A$3,Ops!$B$2:$B$3,1)' }] }],
      },
    ],
  });
suite.push(
  shortSheet([{ ref: 'B2', value: 120 }, { ref: 'B3', value: 118 }, { ref: 'B4', value: 96 }, { ref: 'A5', value: '출처: 운영 로그' }]),
  shortSheet([{ ref: 'B2', value: 120 }, { ref: 'B3', value: 118 }, { ref: 'A4', value: '합계' }, { ref: 'B4', value: 334 }]),
  shortSheet([{ ref: 'B2', value: 120 }, { ref: 'B3', value: 118 }, { ref: 'B5', value: '1,200' }, { ref: 'B6', value: '12%' }]),
  shortSheet([{ ref: 'B2', value: 120 }, { ref: 'B3', value: 118 }, { ref: 'B6', value: 40 }])
);
suite.push(
  pptx(
    deck([
      slide(
        [
          { text: '목표 120', left: 5, top: 5, width: 500, height: 80, font: { size: 32 } },
          { text: '설명 문단이 두 줄로 이어지는 본문 텍스트입니다.\n둘째 줄도 본문입니다.', left: 20, top: 20, width: 400, height: 70, font: { size: 10 } },
          { text: '3/8', left: 880, top: 505, width: 60, height: 20, font: { size: 9 } },
        ],
        { notes: '' }
      ),
    ]),
    'model-backed-deck'
  ),
  pptx(
    deck([
      slide(
        [
          { text: '목표 120', left: 100, top: 100, width: 500, height: 80, font: { size: 32 } },
          { text: '3/8', left: 880, top: 505, width: 60, height: 20, font: { size: 9 } },
        ],
        { notes: 'Source: Summary!B4' }
      ),
      slide([{ text: '매출 12', left: 100, top: 100, width: 500, height: 80, font: { size: 32 } }], { notes: '출처: 운영 로그', index: 2, path: '/slide[2]' }),
    ]),
    'model-backed-deck'
  )
);
for (const [printArea, pageSetup] of [['', {}], ['A1:B5', {}], ['', { fitToPagesWide: 1 }], ['A1:P20', {}], ['A1:B5,D1:P20', {}], ['A1:B5,D1:E8', {}], ['f2:o19', {}], [undefined, {}]]) {
  suite.push(
    xlsx({
      sheets: [
        {
          path: '/sheet[Sheet1]',
          name: 'Sheet1',
          cells: [],
          charts: [{ path: '/sheet[Sheet1]/chart[1]', anchor: { from: 'F2', to: 'O19', startColumn: 6, startRow: 2, endColumn: 15, endRow: 19 } }],
          pageSetup: { printArea, ...pageSetup },
        },
      ],
    })
  );
}
suite.push(
  docx({
    paragraphs: [
      { path: '/body/p[1]', index: 1, text: '• 타이핑한 글머리표', style: 'Normal', start: 1 },
      { path: '/body/p[2]', index: 2, text: '첫 줄\n둘째 줄', style: 'Normal', start: 20 },
      { path: '/body/p[3]', index: 3, text: '정상 문단 - 대시는 문장 안에서 허용', style: 'Normal', start: 40 },
      { path: '/body/p[4]', index: 4, text: '첫 줄\n둘째 줄', style: 'Normal', softBreaks: 1, start: 60 },
      { path: '/body/p[5]', index: 5, text: '* 별표 글머리표', style: 'Normal', start: 80 },
      { path: '/body/p[6]', index: 6, text: '-하이픈', style: 'Normal', start: 100 },
    ],
    tables: [],
    blockOrder: [
      { type: 'paragraph', index: 1, path: '/body/p[1]', start: 1 },
      { type: 'paragraph', index: 2, path: '/body/p[2]', start: 20 },
      { type: 'paragraph', index: 3, path: '/body/p[3]', start: 40 },
    ],
  })
);
const contrastShapes = [
  { text: null, left: 100, top: 100, width: 320, height: 120, fillColor: 16777215, fillTransparency: 0 },
  { text: 'Unreadable condition', left: 120, top: 125, width: 260, height: 30, fillColor: 16777215, fillTransparency: 1, font: { size: 14, color: 16777215 } },
  { text: 'Readable condition', left: 120, top: 170, width: 260, height: 30, fillColor: 16777215, fillTransparency: 1, font: { size: 14, color: 2894871 } },
];
suite.push(pptx(deck([slide(contrastShapes, { background: { color: '172C2C' } })])));
suite.push(
  xlsx({ sheets: [{ name: 'Dashboard', cells: [{ ref: 'C8', path: '/sheet[Dashboard]/cell[C8]', value: '#VALUE!' }], charts: [] }] }),
  xlsx({ sheets: [{ name: 'Dashboard', cells: [{ ref: 'C8', value: '#N/A' }, { ref: 'C9', value: '#spill!' }, { ref: 'C10', value: '#DIV/0!' }, { ref: 'C11', value: '#REF' }], charts: [] }] }),
  pptx(deck([{ index: 1, path: '/slide[1]', shapes: [{ path: '/slide[1]/shape[2]', chart: { path: '/slide[1]/shape[2]/chart', seriesCount: 0 } }] }]))
);
const chartDeck = (chart, shapes = []) =>
  pptx(deck([slide([{ text: '', left: 60, top: 120, width: 600, height: 300, chart: { path: '/slide[1]/shape[1]/chart', seriesCount: 2, ...chart } }, ...shapes])]));
const names = [{ name: '검출' }, { name: '오탐' }];
suite.push(
  chartDeck({ legend: false, seriesNamesShown: false, series: names }),
  chartDeck({ legend: true, series: names }),
  chartDeck({ legend: false, seriesNamesShown: true, series: names }),
  chartDeck({ legend: false, seriesNamesShown: false, series: names }, [{ text: '파란 선이 검출, 회색 선이 오탐이다', left: 700, top: 120, width: 200, height: 60 }]),
  chartDeck({ legend: false, seriesCount: 1, series: [names[0]] }),
  chartDeck({ series: names }),
  chartDeck({ legend: false, series: [{ name: '검' }, { name: '오탐' }] })
);
suite.push(
  pptx(
    deck([
      slide([
        { left: 0, top: 0, width: 317, height: 540, fill: { color: '171A1F' } },
        { left: 360, top: 100, width: 300, height: 346.4 },
        { left: 700, top: 200, width: 0, height: 146.4 },
        { left: 760, top: 240, width: 150, height: 66.4 },
      ]),
    ])
  )
);
const axisSlide = (drifting) =>
  pptx(
    deck([
      slide([
        { left: 480, top: 240, width: 0, height: 40 },
        { left: 480, top: 300, width: 0, height: 30 },
        { left: 256, top: 350, width: 448, height: 44 },
        { left: drifting, top: 400, width: 448, height: 44 },
      ]),
    ])
  );
for (const left of [260, 256, 200, 261, 262.5, 258, 250]) suite.push(axisSlide(left));
const rowSlide = (thirdLeft, mutate = (shapes) => shapes) =>
  pptx(
    deck([
      slide(
        mutate([
          { left: 40, top: 200, width: 260, height: 180 },
          { left: 330, top: 200, width: 260, height: 180 },
          { left: thirdLeft, top: 200, width: 260, height: 180 },
        ])
      ),
    ])
  );
for (const left of [628, 620, 760, 625, 622, 640]) suite.push(rowSlide(left));
suite.push(rowSlide(620, (shapes) => shapes.slice(0, 2)), rowSlide(628, (shapes) => shapes.map((shape, at) => (at === 2 ? { ...shape, width: 180 } : shape))));
const hiddenDeck = (hidden) =>
  pptx(
    deck([
      slide(
        [
          { type: 'p:sp', text: '야간 운영 전환 승인', font: { size: 28, color: '101418' }, left: 60, top: 60, width: 600, height: 70 },
          { type: 'p:sp', text: '이전 초안: 주간 인력 6명으로 대체', font: { size: 28, color: 'FAFAFA' }, left: 60, top: 70, width: 600, height: 70, ...(hidden ? { hidden: true } : {}) },
        ],
        { background: { color: 'FFFFFF' } }
      ),
    ])
  );
suite.push(hiddenDeck(false), hiddenDeck(true));
suite.push(pptx(deck([{ index: 1, path: '/slide[1]', hidden: true, shapes: contrastShapes }])));
const tableDeck = (table) =>
  pptx(
    deck([
      slide(
        [
          { type: 'p:sp', text: '가맹점 안내 자동화가 비용 대비 효과가 가장 크다', font: { size: 28, color: '101418' }, left: 60, top: 40, width: 800, height: 60 },
          { type: table ? 'p:graphicFrame' : 'p:sp', text: '안 비용 오류 감소 판정', font: { size: 13, color: 'FFFFFF' }, left: 60, top: 160, width: 800, height: 240, ...(table ? { table: { rows: 4, columns: 4 } } : {}) },
        ],
        { background: { color: 'FFFFFF' } }
      ),
    ])
  );
suite.push(tableDeck(false), tableDeck(true));
const pageNumberDeck = (bodyBottom) =>
  pptx(
    deck([
      slide([
        { text: '허브별 처리량', left: 43, top: 72, width: 873, height: 54, font: { size: 32, color: '17212B' } },
        { text: '교대 초에 동선 점검, 후반에 야간 순찰. 근접 경보는 즉시 정지한다.', left: 647, top: 460, width: 269, height: bodyBottom - 460, font: { size: 15, color: '17212B' } },
        { text: '3', placeholder: true, left: 845, top: 504, width: 72, height: 22, font: { size: 9, color: '5A6872' } },
      ]),
    ])
  );
for (const bottom of [512, 502, 498, 505, 520]) suite.push(pageNumberDeck(bottom));
const bandDeck = (bandTop) =>
  pptx(
    deck([
      slide([
        { text: '허브별 처리량', left: 43, top: 72, width: 873, height: 54, font: { size: 32, color: '17212B' } },
        { text: '', chart: { path: '/slide[1]/shape[2]/chart', seriesCount: 1 }, left: 43, top: 158, width: 518, height: 288 },
        { text: '', geometry: 'rect', fill: { color: 'EDD9D9' }, left: 43, top: bandTop, width: 873, height: 50 },
      ]),
    ])
  );
for (const top of [425, 470, 446, 440, 400]) suite.push(bandDeck(top));
const frameDeck = (frame, sourceTop) =>
  pptx(
    deck([
      slide([
        { text: '첫 주 지표', left: 43, top: 72, width: 873, height: 54, font: { size: 32, color: '17212B' } },
        { text: '', ...frame, left: 43, top: 300, width: 873, height: 190 },
        { text: '예시 수치 · 코호트 분석', left: 43, top: sourceTop, width: 600, height: 16, font: { size: 11, color: '6B7A8A' } },
      ]),
    ])
  );
const tableFrame = { table: { path: '/slide[1]/shape[2]/table', rows: 4, columns: 4 }, text: '지표 61% 78% +17%p' };
const chartFrame = { chart: { path: '/slide[1]/shape[2]/chart', seriesCount: 1 } };
for (const top of [484, 500, 470, 440]) suite.push(frameDeck(tableFrame, top), frameDeck(chartFrame, top), frameDeck({ picture: { path: '/slide[1]/picture[1]' } }, top));
const pageOfPeers = (sizes) =>
  pptx(
    deck([
      slide(sizes.map((size, index) => ({ type: 'p:sp', text: `항목 ${index + 1}`, left: 60, top: 60 + index * 90, width: 400, height: 60, font: { size } })),
      ),
    ])
  );
for (const sizes of [[16, 16, 16], [30, 16, 16], [36, 35, 17, 15, 10, 9], [18, 16, 16, 16], [20, 20], [24, 12, 12, 12, 12], [16, 16, 16, 16, 16, 16]]) suite.push(pageOfPeers(sizes));
const pageOf = (shapes) => pptx(deck([slide(shapes.map((shape) => ({ type: 'p:sp', left: 590, width: 326, ...shape })))]));
suite.push(
  pageOf([
    { text: '성공률', top: 297, height: 30, font: { size: 18 } },
    { text: '86.5% / 86.1%', top: 333, height: 42, font: { size: 27 } },
    { text: 'Mixdog / Codex CLI', top: 377, height: 23, font: { size: 13 } },
  ]),
  pageOf([
    { text: '지난 분기에는 대기 시간이 길었다', top: 297, height: 30, font: { size: 18 } },
    { text: '이번 분기에는 대기 시간이 사라졌다', top: 329, height: 30, font: { size: 18 } },
  ])
);
const kicker = (gap, upperSize, upperHeight) =>
  pptx(
    deck([
      slide([
        { text: 'DIAGNOSTIC ANATOMY & BOTTLENECK ANALYSIS', left: 43, top: 33, width: 500, height: upperHeight, font: { size: upperSize } },
        { text: '야간 출고 병목은 도크 배정에서 시작된다', left: 43, top: 33 + upperHeight + gap, width: 873, height: 50, font: { size: 30 } },
      ]),
    ])
  );
for (const gap of [2, 0, 5, 8, -3]) for (const [size, height] of [[10, 16], [10, 40], [20, 30], [16, 20]]) suite.push(kicker(gap, size, height));
const collisionDeck = (bandTop) =>
  pptx(
    deck([
      slide([
        { type: 'p:sp', text: '탭·폼·다운로드를 조작하고 페이지 상태를 확인한다', left: 43, top: 377, width: 270, height: 63, font: { size: 18 } },
        { type: 'p:sp', text: '설명에 그치지 않고, 연결된 도구로 작업을 수행한다', left: 43, top: bandTop, width: 873, height: 40, font: { size: 22 } },
      ]),
    ])
  );
for (const top of [425, 448, 438, 436, 444, 440]) suite.push(collisionDeck(top));
const occlusion = (shapes) => pptx(deck([slide(shapes.map((shape) => ({ type: 'p:sp', ...shape })))]));
suite.push(
  occlusion([{ text: '야간 출고 개선', left: 60, top: 60, width: 400, height: 60, font: { size: 28 } }, { text: '', left: 40, top: 40, width: 300, height: 120, type: 'p:pic' }]),
  occlusion([{ text: '제품', left: 60, top: 40, width: 300, height: 30, font: { size: 14 } }, { text: '', left: 40, top: 20, width: 400, height: 300, type: 'p:pic', name: 'mixdog-device:glow' }]),
  occlusion([{ text: '', left: 40, top: 40, width: 440, height: 120, fill: { color: 'EEF2F7' } }, { text: '야간 출고 개선', left: 60, top: 60, width: 400, height: 60, font: { size: 28 } }])
);
for (const top of [59, 50, 100, 62, 56, 88]) {
  suite.push(
    occlusion([
      { text: '이용은 역과 강변 대여소에 모인다', left: 48, top, width: 600, height: 35, font: { size: 27 } },
      { text: '', left: 48, top: 90, width: 530, height: 370, fill: { color: 'DCE7DF' } },
    ])
  );
}
const prose = '야간 출고는 묶음 단위로 실어 대기가 길어졌고 도크별 분할 이후 대기가 사라졌다. '.repeat(20);
for (const carrier of [{ type: 13 }, { type: 'picture', picture: { path: '/slide[1]/picture[1]' } }, { type: 'p:sp' }, { type: 28 }]) {
  suite.push(pptx(deck([{ path: '/slide[1]', index: 1, shapes: [{ index: 1, type: 'p:sp', left: 50, top: 110, width: 860, height: 360, text: prose, font: { size: 12 } }, { index: 2, left: 50, top: 36, width: 300, height: 60, text: '', ...carrier }] }])));
}
// workbook snapshots that the xlsx assurance tests and the benchmark build
const cell = (sheet, ref, value, style = {}, extra = {}) => ({ path: `/sheet[${sheet}]/cell[${ref}]`, ref, value, style, ...extra });
suite.push(
  xlsx({
    defaultStyle: { fontName: '맑은 고딕', fontSize: 11 },
    sheets: [
      {
        name: 'Data',
        rows: 60,
        columns: 5,
        pageSetup: { zoom: 120 },
        cells: Array.from({ length: 12 }, (_, at) => cell('Data', `A${at + 1}`, at + 1, { fontName: '맑은 고딕', fontSize: 11 })),
      },
    ],
  }),
  xlsx({
    sheets: [
      {
        name: 'Plain',
        cells: Array.from({ length: 9 }, (_, at) => cell('Plain', `B${at + 1}`, at * 3, { fontName: 'Calibri', fontSize: 11 })),
      },
    ],
  }),
  xlsx({
    sheets: [
      {
        name: 'Styled',
        cells: [
          cell('Styled', 'A1', '월', { bold: true }),
          cell('Styled', 'A2', '2026-06'),
          ...Array.from({ length: 8 }, (_, at) => cell('Styled', `B${at + 1}`, at, { fontName: 'Calibri', fontSize: 11 })),
        ],
      },
    ],
  }),
  xlsx({
    sheets: [
      {
        name: 'Report',
        cells: [
          cell('Report', 'A1', '지표', { bold: true }),
          cell('Report', 'B1', '값', { bold: true, horizontalAlignment: 'left' }),
          cell('Report', 'B2', 10),
          cell('Report', 'B3', 20),
          cell('Report', 'A4', '합계'),
          cell('Report', 'B4', 30),
          cell('Report', 'C1', '비중', { bold: true, horizontalAlignment: 'right' }),
          cell('Report', 'C2', 0.2),
          cell('Report', 'C3', 0.5),
          cell('Report', 'D1', '월', { bold: true }),
          cell('Report', 'D2', 5, { horizontalAlignment: 'center' }),
          cell('Report', 'D3', 6),
        ],
      },
    ],
  }),
  xlsx({
    sheets: [
      {
        path: '/sheet[Dash]',
        name: 'Dash',
        cells: [cell('Dash', 'B2', 5), cell('Dash', 'C3', '값'), cell('Dash', 'F5', 'x', {}, { formula: '=B2' })],
        charts: [
          { path: '/sheet[Dash]/chart[1]', anchor: { from: 'A1', to: 'D8', startColumn: 1, startRow: 1, endColumn: 4, endRow: 8 }, series: [] },
          { path: '/sheet[Dash]/chart[2]', anchor: { from: 'C5', to: 'G12', startColumn: 3, startRow: 5, endColumn: 7, endRow: 12 }, series: [] },
        ],
        images: [{ path: '/sheet[Dash]/picture[1]', anchor: { from: 'E4', to: 'H10', startColumn: 5, startRow: 4, endColumn: 8, endRow: 10 } }],
        pageSetup: { printArea: 'A1:H12' },
      },
    ],
  })
);

// ---- generated corpora -----------------------------------------------------------------------------------------------

let seed = 20260301;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];
const between = (low, high) => low + Math.floor(next() * (high - low + 1));
const chance = (share) => next() < share;

const TEXTS = [
  '야간 출고 개선', '목표 120', '성공률 86.5%', 'Quarterly revenue 38 and 41', '출처: 운영 로그', '3', '2/9', '항목', '지난 분기에는 대기 시간이 길었다',
  '탭·폼·다운로드를 조작하고 페이지 상태를 확인한다', 'KICKER', '12', '  ', 'Total 1,200', '야간 출고 병목은 도크 배정에서 시작된다\n둘째 줄', 'x'.repeat(140), '가나다라 '.repeat(60),
];
const COLORS = ['FFFFFF', '000000', '172C2C', '#17212B', 'FAFAFA', '5A6872', 16777215, 0, 2894871, '', null, 'EEF2F7', 'not a colour', '0x1234'];
const SIZES = [7, 8, 8.5, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 44];
const COORD = [0, 4, 9, 10, 18, 20, 40, 43, 60, 100, 120, 256, 480, 500, 640, 700, 860, 900, 940];
const SPANS = [0, 20, 36, 60, 150, 260, 300, 448, 600, 873, 960];

function shape(at, canvas) {
  const kind = pick(['text', 'text', 'text', 'fill', 'fill', 'picture', 'chart', 'table', 'line', 'group', 'motif', 'halo', 'pageNumber', 'icon', 'stat']);
  const frame = () => ({ left: pick(COORD) + (chance(0.3) ? pick([0.5, 1, 2, 3.5, 5]) : 0), top: pick(COORD) % canvas.height, width: pick(SPANS), height: pick(SPANS.filter((span) => span <= 600)) });
  const base = { path: `/slide[1]/shape[${at}]`, index: at, ...frame() };
  if (chance(0.04)) base.hidden = true;
  if (chance(0.03)) base.left = String(base.left);
  if (chance(0.02)) delete base.height;
  const font = () => ({ size: pick(SIZES), ...(chance(0.8) ? { color: pick(COLORS) } : {}), ...(chance(0.2) ? { name: pick(['Malgun Gothic', 'Arial', '"Noto Sans KR" Light', 'Aptos Display']) } : {}) });
  switch (kind) {
    case 'text':
      return { ...base, text: pick(TEXTS), font: font(), ...(chance(0.25) ? { slot: pick(['title', 'column-title-1', 'column-title-2', 'column-body-1', 'metric-value-1', 'metric-value-2', 'step-label-3']) } : {}), ...(chance(0.15) ? { fonts: [pick(['Arial', 'Malgun Gothic']), pick(['Arial', 'Calibri'])] } : {}) };
    case 'fill':
      return { ...base, text: chance(0.1) ? '' : null, ...(chance(0.5) ? { fill: { color: pick(COLORS), ...(chance(0.3) ? { transparency: pick([0, 0.1, 0.2, 0.5, 1]) } : {}) } } : { fillColor: pick(COLORS), fillTransparency: pick([0, 0, 0.19, 0.2, 1]) }), ...(chance(0.4) ? { geometry: pick(['rect', 'roundRect', 'ellipse', 'chevron']) } : {}) };
    case 'picture':
      return { ...base, text: '', type: pick(['p:pic', 13, 'p:pic']), ...(chance(0.3) ? { picture: { path: base.path } } : {}) };
    case 'chart':
      return { ...base, text: '', chart: { path: `${base.path}/chart`, seriesCount: pick([0, 1, 2, 3, undefined]), ...(chance(0.5) ? { legend: pick([true, false, undefined]), seriesNamesShown: pick([true, false, undefined]), series: [{ name: pick(['검출', 'A', '오탐', '']) }, { name: pick(['오탐', 'B', '검출']) }, { name: 'C' }].slice(0, between(1, 3)) } : {}) } };
    case 'table':
      return { ...base, text: pick(TEXTS), type: 'p:graphicFrame', font: font(), table: { path: `${base.path}/table`, rows: 4, columns: 3 } };
    case 'line':
      return { ...base, text: '', ...(chance(0.5) ? { width: 0 } : { height: 0 }) };
    case 'group':
      return { ...base, text: '', group: { path: `${base.path}/group` } };
    case 'motif':
      return { ...base, text: pick(['', 'decor', 'MOTIF']), name: 'Mixdog Motif · ring' };
    case 'halo':
      return { ...base, text: '', type: 'p:pic', name: 'mixdog-device:glow' };
    case 'pageNumber':
      return { ...base, text: pick(['3', '3/8', '12 of 20', '104', '1234']), placeholder: pick([true, true, false]), left: 860, top: canvas.height - 40, width: 60, height: 20, font: { size: pick([9, 10, 12]) } };
    case 'icon':
      return { ...base, text: '', type: pick(['p:pic', 28, 13]), width: pick([20, 36, 37]), height: pick([20, 36, 40]) };
    default:
      return { ...base, text: pick(['86.5%', '성공률', 'Mixdog / Codex CLI']), font: font(), width: 326 };
  }
}

function rowOfCards(at, canvas) {
  const width = pick([180, 260]);
  const gap = pick([20, 29, 30, 31, 33, 90]);
  const top = pick([100, 200, 201.5]);
  return [0, 1, 2, between(0, 1) ? 3 : 2].map((slot, position) => ({ path: `/slide[1]/shape[${at + position}]`, index: at + position, left: 40 + position * (width + gap) + (chance(0.3) ? pick([0.5, 1, 3]) : 0), top: top + (chance(0.2) ? 1 : 0), width, height: 180 }));
}

function generatedDeck() {
  const canvas = pick([{ width: 960, height: 540 }, { width: 720, height: 540 }, { width: 720, height: 405 }, { width: 595, height: 842 }, { width: 1280, height: 720 }, { width: 0, height: 0 }]);
  const slides = [];
  for (let slideAt = 1; slideAt <= between(1, 3); slideAt += 1) {
    const shapes = [];
    for (let at = 1; at <= between(0, 12); at += 1) shapes.push(shape(shapes.length + 1, canvas));
    if (chance(0.2)) shapes.push(...rowOfCards(shapes.length + 1, canvas));
    slides.push({ path: `/slide[${slideAt}]`, index: slideAt, ...(chance(0.6) ? { background: { color: pick(COLORS) } } : {}), ...(chance(0.5) ? { notes: pick(['', 'Source: Summary!B4', '출처: 로그', 'none']) } : {}), ...(chance(0.05) ? { hidden: true } : {}), shapes: shapes.map((entry) => ({ ...entry, path: entry.path.replace('/slide[1]', `/slide[${slideAt}]`) })) });
  }
  return { slideWidth: canvas.width, slideHeight: canvas.height, ...(chance(0.1) ? { printSheet: true } : {}), slides };
}

const generatedDecks = [];
for (let at = 0; at < 300; at += 1) generatedDecks.push(pptx(generatedDeck(), chance(0.3) ? 'model-backed-deck' : undefined));
generatedDecks.push(pptx({ slides: [] }), pptx({}), pptx(null), pptx({ slideWidth: 960, slideHeight: 540, slides: [{ shapes: [] }, { index: 2, shapes: [{ text: 'x', left: 0, top: 0, width: 10, height: 10, font: { size: 5 } }] }] }));

const STYLES = ['Normal', '본문', 'Heading1', 'Heading 2', 'Heading3', 'Title', '제목 1', '제목', '표제', 'heading 9', 'Subtitle'];
const DOC_TEXTS = ['배경', '결과 요약', '묶음 단위로 실어 대기가 길었다.', '• 타이핑한 글머리표', '첫 줄\n둘째 줄', '- dash', '가'.repeat(200), '가'.repeat(950), 'Short', '   ', '', '합계', '운영 개선 보고'];
function generatedDocx() {
  const paragraphs = [];
  const count = between(0, 14);
  for (let at = 1; at <= count; at += 1) {
    const style = pick(STYLES);
    paragraphs.push({
      path: `/body/p[${at}]`,
      index: at,
      ...(chance(0.8) ? { style } : { styleName: style }),
      text: pick(DOC_TEXTS),
      font: { ...(chance(0.9) ? { size: pick([9, 10, 11, 11, 12, 14, 18, 20, 24]) } : {}), ...(chance(0.3) ? { bold: true } : {}), ...(chance(0.4) ? { color: pick(['222222', 'C0392B', 'auto', '#000000', '']) } : {}), ...(chance(0.1) ? { caps: true } : {}), ...(chance(0.1) ? { letterSpacing: pick([0, 1, 2]) } : {}) },
      ...(chance(0.15) ? { spaceBefore: pick([0, 6, 12, 18]), spaceAfter: pick([0, 6]) } : {}),
      ...(chance(0.15) ? { format: { spacingBefore: pick([0, 12]), spacingAfter: pick([0, 6]) } } : {}),
      ...(chance(0.3) ? { pageStart: between(1, 3) } : {}),
      ...(chance(0.1) ? { inTable: true } : {}),
      ...(chance(0.15) ? { softBreaks: between(0, 2) } : {}),
      start: at * 20,
    });
  }
  const tables = [];
  for (let at = 1; at <= between(0, 2); at += 1) {
    const rows = Array.from({ length: between(0, 8) }, (_, rowAt) => ({
      path: `/body/tbl[${at}]/row[${rowAt + 1}]`,
      cells: Array.from({ length: between(0, 4) }, (_, cellAt) => ({ path: `/body/tbl[${at}]/row[${rowAt + 1}]/cell[${cellAt + 1}]`, text: pick(['평균 대기 시간 단축', '합계', '총계', 'Total', '1,200', '12.5%', '계', 'Grand total', '소계 ', '']), font: { ...(chance(0.6) ? { size: pick([10, 11, 18, 22]) } : {}), ...(chance(0.3) ? { bold: pick([true, false]) } : {}) } })),
    }));
    tables.push({ path: `/body/tbl[${at}]`, index: at, rows, pageStart: between(1, 3), pageEnd: between(1, 3), start: at * 25 + 7 });
  }
  const order = [...paragraphs.map((entry) => ({ type: 'paragraph', index: entry.index, path: entry.path, start: entry.start })), ...tables.map((entry) => ({ type: 'table', index: entry.index, path: entry.path, start: entry.start }))];
  const document = { paragraphs, tables };
  if (chance(0.6)) document.blockOrder = order.sort(() => (chance(0.2) ? 1 : -1)).slice(0, between(0, order.length));
  return document;
}
const generatedDocs = [];
for (let at = 0; at < 200; at += 1) generatedDocs.push(docx(generatedDocx()));
generatedDocs.push(docx({}), docx(null), docx({ paragraphs: [], tables: [] }));
// a long document of plain body text with no headings
generatedDocs.push(docx({ paragraphs: Array.from({ length: 10 }, (_, at) => para(at + 1, 'Normal', `본문 ${at}`, { size: 11 })) }));

const REFS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];
const SHEET_VALUES = [1, 2.5, 120, 0, 7, 33, 410, 18.25, 96, 5, 64, 2, 88, 12, 3, 150, 21, 9, '합계', 'Total', 'Sub total', '출처: 로그', '#DIV/0!', '#N/A', '#REF!', '1,200', '12%', 'name', '', null, true, 'Grand Total', '소계'];
function generatedSheet(name) {
  const rows = between(2, 16);
  const columns = between(1, 6);
  const cells = [];
  const styleFor = () => (chance(0.5) ? {} : { ...(chance(0.3) ? { bold: true } : {}), ...(chance(0.3) ? { horizontalAlignment: pick(['left', 'right', 'center', 'general']) } : {}), ...(chance(0.3) ? { fontName: pick(['Calibri', '맑은 고딕']) } : {}), ...(chance(0.3) ? { fontSize: pick([10, 11, 12]) } : {}), ...(chance(0.2) ? { color: pick(['#000000', '000000', 'FF0000', 'auto']) } : {}), ...(chance(0.1) ? { fill: pick(['EEEEEE', null, '']) } : {}) });
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (chance(0.4)) continue;
      const value = column === 0 && chance(0.6) ? pick(['월', '합계', 'Total', 'x', '1월', '2월']) : pick(SHEET_VALUES);
      const entry = { path: `/sheet[${name}]/cell[${REFS[column]}${row}]`, ref: `${REFS[column]}${row}`, value, style: styleFor() };
      if (typeof value === 'number' && chance(0.2)) entry.dataType = pick(['text', 'number']);
      if (chance(0.1)) entry.formula = pick([`=B${row}*2`, `=SUM(B2:B${rows})`, `=${REFS[column]}${row}+Other!A1`, '=A1/0', '=B2*1.05', '=SUM(B2:B5)+10']);
      if (chance(0.03)) delete entry.ref;
      cells.push(entry);
    }
  }
  const anchor = () => {
    const startColumn = between(1, 12);
    const startRow = between(1, 25);
    const endColumn = startColumn + between(0, 8);
    const endRow = startRow + between(0, 14);
    return { from: `${REFS[startColumn - 1]}${startRow}`, to: `${REFS[Math.min(endColumn, 13) - 1]}${endRow}`, startColumn, startRow, endColumn, endRow };
  };
  const formulaRange = () => `${name}!$${pick(['A', 'B', 'C'])}$${between(1, 4)}:$${pick(['B', 'C', 'D'])}$${between(2, rows + 2)}`;
  return {
    path: `/sheet[${name}]`,
    name,
    ...(chance(0.7) ? { rows: pick([5, rows, 45, 60]), columns: pick([3, columns, 13]) } : {}),
    cells,
    charts: Array.from({ length: between(0, 2) }, (_, at) => ({
      path: `/sheet[${name}]/chart[${at + 1}]`,
      ...(chance(0.8) ? { anchor: anchor() } : {}),
      series: Array.from({ length: between(0, 2) }, () => ({ formula: `=SERIES("S",${formulaRange()},${formulaRange()},1)`, ...(chance(0.3) ? { categoryFormula: formulaRange() } : {}), ...(chance(0.2) ? { valueFormula: formulaRange() } : {}) })),
    })),
    images: Array.from({ length: between(0, 2) }, (_, at) => ({ path: `/sheet[${name}]/picture[${at + 1}]`, anchor: anchor() })),
    ...(chance(0.7) ? { pageSetup: { ...(chance(0.6) ? { printArea: pick(['', 'A1:H20', 'A1:C5,E1:M40', 'B2', 'bad', 'A1:M60']) } : {}), ...(chance(0.4) ? { fitToPagesWide: pick([1, 2, '1']) } : {}), ...(chance(0.4) ? { zoom: pick([60, 100, 110, 150]) } : {}) } } : {}),
  };
}
const generatedBooks = [];
for (let at = 0; at < 150; at += 1) {
  const sheets = Array.from({ length: between(0, 3) }, (_, sheetAt) => generatedSheet(pick(['Summary', 'Data', 'Ops', 'Other', 'Sheet1']) + (sheetAt || '')));
  generatedBooks.push(xlsx({ ...(chance(0.4) ? { defaultStyle: pick([{ fontName: '맑은 고딕', fontSize: 11 }, { fontName: 'Calibri' }, { fontSize: 11 }, {}]) } : {}), ...(chance(0.15) ? { definedNames: [{ name: 'Rate', refersTo: 'Data!$B$2' }] } : {}), sheets }, pick([undefined, 'financial-model', 'general'])));
}
generatedBooks.push(xlsx({}), xlsx(null), xlsx({ sheets: [] }));

// the format is read from the document when the call names none, and an unknown format is no review
const dispatch = [
  { document: { format: 'DOCX', paragraphs: [para(1, 'Heading1', '배경', { size: 11 }), para(2, 'Normal', '본문', { size: 11 })] } },
  { format: 'XLSX', document: { sheets: [{ name: 'A', cells: [cell('A', 'A1', '#N/A')] }] } },
  { format: '', document: { format: 'pptx', slideWidth: 960, slideHeight: 540, slides: [slide([{ text: 'x', left: 0, top: 0, width: 40, height: 40, font: { size: 8 } }])] } },
  { format: 'pdf', document: { slides: [] } },
  { document: {} },
  {},
];

const golden = {
  suites: record(suite),
  pptx: record(generatedDecks),
  docx: record(generatedDocs),
  xlsx: record(generatedBooks),
  dispatch: record(dispatch),
};
writeText(join(stage, 'golden.json'), orderedStringify(golden, 0));
writeSetManifest(stage, { set: 'office-structure', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
const issueCount = (list) => list.reduce((sum, entry) => sum + (entry.output?.length ?? 0), 0);
console.log(`golden.json: ${Object.entries(golden).map(([name, list]) => `${name} ${list.length} (${issueCount(list)} issues)`).join(', ')}`);
