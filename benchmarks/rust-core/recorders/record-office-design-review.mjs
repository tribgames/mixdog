#!/usr/bin/env node
// Golden of the office design review (crate mixdog-office-quality, module design_review): what Node's
// `runtime/office/quality/design-review.mjs` (`reviewOfficeDesign`, `inferPptxSlideRoles`), `design-deck-diversity.mjs`,
// `design-review-critique.mjs`, `design-review-authored.mjs`, `pptx-deck-rubric.mjs` and `pptx-slide-roles.mjs` answer to
// the deck snapshots of the office-design-aesthetics, office-design-discipline, office-runtime-design and
// pptx-skill-kit suites (their decks are written out here, one case per assertion input and per variant the assertion
// tries), to the composition receipts of those decks, to composition sequences, and to seeded generated decks that spread
// the thresholds (beats, card grids, stripes, fonts and hue families, themes, signed structures, motifs, art directions,
// critiques, rubric receipts). Writes native/core/fixtures/office-design-review/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-design-review.mjs --tree <product tree> [--source-tree <checkout with pptx-deck-rubric.mjs>]
//
// Every section is a list of cases { input, output | error }; every input is plain JSON (the replay reads it back) and keys
// are written in the order the module produces them. The generator is deterministic.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, orderedStringify, parseArgs, resolveTree, stageSet, writeSetManifest, writeText } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-design-review.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-design-review');
const stage = stageSet(finalDir);

const review = await importFrom(tree, 'src/runtime/office/quality/design-review.mjs');
const diversity = await importFrom(tree, 'src/runtime/office/quality/design-deck-diversity.mjs');
const critique = await importFrom(tree, 'src/runtime/office/quality/design-review-critique.mjs');
const authored = await importFrom(tree, 'src/runtime/office/quality/design-review-authored.mjs');
// the rubric module may already be gone from the product tree: `--source-tree` names a checkout that still has it
const RUBRIC = 'src/runtime/office/quality/pptx-deck-rubric.mjs';
const rubric = await importFrom(existsSync(join(tree, RUBRIC)) || !args.get('source-tree') ? tree : resolve(args.get('source-tree')), RUBRIC);
const roles = await importFrom(tree, 'src/runtime/office/quality/pptx-slide-roles.mjs');
const briefs = await importFrom(tree, 'src/runtime/office/authoring/pptx-brief.mjs');
const receipts = await importFrom(tree, 'src/runtime/office/authoring/pptx-receipt.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const record = (inputs, run) =>
  inputs.map((raw) => {
    const input = plain(raw);
    try {
      return { input, output: plain(run(plain(input))) };
    } catch (error) {
      return { input, error: String(error?.message ?? error) };
    }
  });

// ---- the suites' own decks ------------------------------------------------------------------------------------------

const TITLE_FONT = { size: 40 };
const title = (index, text = `Title ${index}`) => ({ type: 17, text, left: 58, top: 46, width: 780, height: 70, font: TITLE_FONT });
const beat = (index, color = '0F1B26') => ({
  index,
  background: { color },
  shapes: [{ type: 17, text: `Beat ${index}`, left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }],
});
const evidence = (index) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [title(index), { chart: { type: index % 2 ? 'bar' : 'line' }, left: 58, top: 150, width: 800 - index * 7, height: 340 }],
});
const thin = (index) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [title(index), { type: 17, text: '대기 시간이 줄었다.', left: 58, top: 200, width: 600, height: 40, font: { size: 15 } }],
});
const charted = (index) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [
    title(index),
    { type: 17, text: '대기 시간이 줄었다.', left: 58, top: 200, width: 300, height: 40, font: { size: 15 } },
    { chart: { type: 'bar' }, left: 400, top: 150, width: 500, height: 340 },
  ],
});
const laned = (index) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [
    title(index),
    ...['조례 개정', '저소음 차량', '의견 수렴'].map((text, lane) => ({ type: 17, text, name: 'mixdog-spec:structure:lanes', left: 200 + lane * 60, top: 150 + lane * 110, width: 180, height: 50, font: { size: 14 } })),
  ],
});
const nodePage = (index, kind, name = '') => ({
  index,
  background: { color: 'F7F9FC', followMaster: false, source: 'slide' },
  shapes: [
    { type: 17, text: `Point ${index}`, left: 58, top: 46, width: 780, height: 70, font: { size: 40 } },
    { type: 1, text: '', geometry: 'ellipse', left: 120, top: 200, width: 60, height: 60 },
    { type: 17, text: kind, name, left: 200, top: 210, width: 300, height: 40, font: { size: 14 } },
  ],
});
const claim = (index, color = 'F7F9FC') => ({ index, background: { color }, shapes: [{ type: 17, text: 'Claim', left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }] });
const imagePage = (index) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [
    { type: 17, text: `Headline ${index}`, left: 58 + index, top: 46, width: 780, height: 70, font: { size: 40 } },
    { type: 13, text: '', left: 510 + index, top: 170, width: 360, height: 250 },
    { type: 17, text: 'Supporting evidence', left: 70, top: 190 + index, width: 360, height: 90, font: { size: 18 } },
  ],
});
const customRequest = { intent: 'Approve the operating plan', signature: 'evidence-led operating decision', deck: { backgroundMode: 'custom' } };
const deckOf = (slides, extra = {}) => ({ slideWidth: 960, slideHeight: 540, ...extra, slides });
const design = (document, request, format = 'pptx', extra = {}) => ({ format, document, design: request, ...extra });

const designCases = [];
const beatDeck = [beat(1), evidence(2), evidence(3), beat(4), beat(5), beat(6), evidence(7), evidence(8), evidence(9), beat(10)];
const darkTheme = Array.from({ length: 10 }, (_, i) => (i % 3 === 2 ? { ...evidence(i + 1), background: { color: '0F1B26' } } : beat(i + 1)));
const structureRequest = { intent: 'Approve the plan', signature: 'structure-led', deck: { backgroundMode: 'custom' } };
for (const slides of [
  beatDeck,
  [beat(1), beat(2), evidence(3), evidence(4), evidence(5), evidence(6), evidence(7), beat(8)],
  darkTheme,
  [beat(1), charted(2), thin(3), charted(4), beat(5)],
  [beat(1), charted(2), charted(3), beat(4)],
  [beat(1), charted(2), laned(3), charted(4), beat(5)],
  [nodePage(1, 'cover'), nodePage(2, 'node'), nodePage(3, 'node'), nodePage(4, 'node'), claim(5), { ...claim(6), shapes: [{ type: 17, text: 'Claim', left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }] }],
  [nodePage(1, 'cover'), nodePage(2, 'node', 'mixdog-spec:structure:hub'), nodePage(3, 'node', 'mixdog-spec:structure:timeline'), nodePage(4, 'node', 'mixdog-spec:structure:hub'), claim(5)],
  Array.from({ length: 7 }, (_, index) => imagePage(index + 1)),
]) {
  designCases.push(design(deckOf(slides), structureRequest), design(deckOf(slides), { ...structureRequest, allowRepetition: true }), design(deckOf(slides), { review: true }));
}
designCases.push(
  design(deckOf(Array.from({ length: 6 }, (_, index) => imagePage(index + 1))), { ...customRequest, slidePlans: Array.from({ length: 6 }, (_, i) => ({ slide: i + 1, visualType: 'image' })) }),
  design(deckOf([beat(1), evidence(2), evidence(3), beat(4)]), { profile: 'technical', intent: 'Launch a local-first coding harness', audience: 'product leaders', purpose: 'decide', signature: 'local-first evidence loop' }),
  design(deckOf([beat(1), evidence(2), evidence(3), beat(4)]), 'technical'),
  design(deckOf([beat(1), evidence(2), evidence(3), beat(4)]), {}),
  design(deckOf([beat(1), evidence(2), evidence(3), beat(4)]), undefined),
  design(deckOf([evidence(1)]), { review: true }),
  design(deckOf([]), { review: true }),
  design(null, { review: true }),
  design(deckOf([]), { review: true }, 'csv'),
  design({ paragraphs: [] }, { review: false }, 'docx', { auditProfile: 'x' }),
  design({ paragraphs: [{ path: '/body/p[1]', index: 1, text: 'x', font: { size: 11 } }], tables: [] }, { profile: 'editorial' }, 'docx'),
  design({ paragraphs: [{ path: '/body/p[1]', index: 1, text: 'x', font: { size: 11 } }], tables: [] }, { review: true }, 'docx'),
  design({ paragraphs: [] }, { review: false }, 'DOCX'),
  design({ sheets: [] }, { profile: 'technical' }, 'xlsx'),
  design({ sheets: [] }, { review: true }, 'xlsx', { auditProfile: 'financial-model' }),
  design({ slides: [] }, {}, 'pdf'),
  design({ slides: [] }, {}, 'unknown'),
  design({ slides: [] }, 'technical', 'pdf'),
  { format: 'pptx', document: deckOf([evidence(1)]), design: { profile: 'no-such-profile' } },
  { document: deckOf([evidence(1)]), design: {} }
);

// themed decks: a default (sandwich) deck whose backgrounds follow or break its plan
const themed = (backgrounds, request = {}) => design(deckOf(backgrounds.map((color, i) => ({ index: i + 1, background: { color }, shapes: [title(i + 1), { chart: { type: 'bar' }, left: 58, top: 150, width: 700, height: 300 }] }))), { intent: 'Quarterly review', ...request });
for (const request of [{}, { deck: { backgroundMode: 'dark' } }, { deck: { backgroundMode: 'light' } }, { deck: { backgroundMode: 'sandwich', sectionSlides: [3] } }, { deck: { enforce: false } }, { deck: { templateMode: 'template' } }]) {
  for (const backgrounds of [
    ['0F1B26', 'F7F9FC', 'F7F9FC', 'F7F9FC', '0F1B26'],
    ['FF0000', '00FF00', '0000FF', '00FF00', 'FF0000'],
    ['112233', 'EEEEEE', 'EEEEEE', 'EEEEEE', '112233'],
    ['112233', 'EEEEEE', 'DDDDDD', 'EEEEEE', 'CCCCCC'],
    ['F4EFE6', 'F4EFE6', '1B2A41', 'F4EFE6'],
    ['', 'F7F9FC', 'F7F9FC'],
  ]) {
    designCases.push(themed(backgrounds, request));
  }
}
designCases.push(
  themed(['112233', 'EEEEEE', 'EEEEEE', '112233'], { slidePlans: [{ slide: 1, slideRole: 'cover', backgroundRole: 'inverse' }, { slide: 2, slideRole: 'content', backgroundRole: 'canvas' }, { slide: 3, kind: 'content', backgroundRole: 'surface' }, { slide: 4, slideRole: 'closing' }] }),
  themed(['112233', 'EEEEEE', 'EEEEEE', '112233'], { slidePlans: [{ slide: 1 }, { slide: 2 }, { slide: 3 }, { slide: 4 }] }),
  themed(['112233', 'EEEEEE', 'EEEEEE', '112233'], { brief: { concept: 'x', plan: [] } }),
  themed(['112233', 'EEEEEE', 'DDDDDD', 'CCCCCC'], { brief: { palette: 'x' } }),
  themed(['112233', 'EEEEEE', 'DDDDDD', 'CCCCCC'], { deck: { backgroundMode: 'dark', sectionSlides: [2, 3] } })
);

// shape discipline: fonts, hue families, chart colours, COM colours
const textShape = (text, extra = {}) => ({ type: 17, text, left: 58, top: 120, width: 500, height: 60, font: { size: 18, name: 'Calibri', color: '222222' }, ...extra });
const disciplineSlides = (shapesList) => deckOf(shapesList.map((shapes, i) => ({ index: i + 1, background: { color: 'F7F9FC' }, shapes: [title(i + 1), ...shapes, { chart: { type: 'bar' }, left: 600, top: 150, width: 300, height: 300 }] })));
for (const shapes of [
  [textShape('a', { font: { size: 18, name: 'Calibri' } }), textShape('b', { font: { size: 18, name: 'Arial' } }), textShape('c', { font: { size: 18, name: 'Georgia' } }), textShape('d', { font: { size: 18, name: 'Verdana' } })],
  [textShape('a', { font: { size: 18, name: 'Gabarito Light' } }), textShape('b', { font: { size: 18, name: '"Pretendard" Semibold' } })],
  [textShape('a', { font: { size: 18, name: 'Comic Sans MS' } })],
  [textShape('a', { fonts: ['Calibri', 'Arial', 'Georgia Black', 'Segoe UI Semilight', ''] })],
  [textShape('a', { font: { size: 18, color: 'FF0000' } }), textShape('b', { font: { size: 18, color: '00FF00' } }), textShape('c', { font: { size: 18, color: '0000FF' } })],
  [textShape('a', { font: { size: 18, color: '#E63946' } }), textShape('b', { font: { size: 18, color: 'E85D3A' } }), textShape('c', { colors: ['1D4ED8', '1d4ed8'] })],
  [textShape('a', { font: { size: 18, color: 255 }, fill: { color: 65280 } }), textShape('b', { font: { size: 18, color: 16711680 }, fill: { color: -1 } })],
  [textShape('a', { font: { size: 18, color: null }, fill: { color: 'oops' } }), textShape('b', { font: { size: 18 } })],
  [textShape('a', { chart: { type: 'bar' }, font: { size: 18, color: 'FF0000' } }), textShape('', { font: { size: 18, name: 'Comic Sans MS', color: 'FF0000' } })],
  [textShape('a', { font: { size: 18, color: 12.5 } })],
]) {
  for (const request of [{ deck: { backgroundMode: 'custom' } }, { deck: { backgroundMode: 'custom', templateMode: 'template' } }, { deck: { backgroundMode: 'custom' }, allowUnsafeFonts: true }]) {
    designCases.push(design(disciplineSlides([shapes, shapes.slice(0, 1)]), request));
  }
}

// ---- briefs -----------------------------------------------------------------------------------------------------------
const BASE_FACTS = '// facts: F1 38건 — 1차 리뷰 로그 · F2 0.72 — 3차 미학 점수 · F3 97% — QA 통과율 · F4 1,250 — 시트 B4';
const BASE_PLAN = [
  '// slide plan: 1 job: cover · move: ask · carriers: statement',
  '//   · 2 job: evidence · carriers: chart, hero · rhythm: dense',
  '//   · 3 job: process · carriers: diagram · composition: steps',
  '//   · 4 job: comparison · carriers: table + picture · texture: grain',
  '//   · 5 job: section · carriers: gauge, specimen, quote',
  '//   · 6 job: closing · carriers: statement',
].join('\n');
const briefScripts = [
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN}\n`,
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN}\n// directions: A bold type-led cover · B calm photo cover · selected: A\n`,
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN}\n// directions: A bold type-led cover · A bold type-led cover · selected: A\n`,
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN}\n// reading mode: presentation\n`,
  `// BRIEF\n${BASE_FACTS}\n// slide plan: 1 job: cover · carriers: statement\n//   · 2 job: closing · carriers: quote\n// concept: tidal\n`,
  `// BRIEF\n// sources: a.pdf · b.xlsx\n${BASE_FACTS}\n${BASE_PLAN}\n// style: swiss-minimal · palette: hue 225\n`,
  '// BRIEF\n// facts: F1 47% — user brief\n// slide plan: 1 job: cover · carriers: statement\n//   · 2 job: closing · carriers: hero\n',
];
const parsedBriefs = briefScripts.map((script) => plain(briefs.parseAuthoringBrief(script))).filter((entry) => entry && entry.present);
const briefDeck = deckOf([
  { index: 1, background: { color: '0F1B26' }, shapes: [{ type: 17, text: 'Cover title', left: 58, top: 200, width: 700, height: 120, font: { size: 47 } }] },
  { index: 2, background: { color: 'F7F9FC' }, shapes: [title(2, 'Wait fell to 38건'), { chart: { type: 'bar' }, left: 58, top: 150, width: 600, height: 300 }, textShape('97% 통과 · 1,250 rows', { left: 680, top: 160, width: 220, height: 60 })] },
  { index: 3, background: { color: 'F7F9FC' }, shapes: [title(3), textShape('A page of unsourced 73% and 4,500 figures here')] },
  { index: 4, background: { color: 'F7F9FC' }, shapes: [title(4), { table: { rows: 3 }, left: 58, top: 150, width: 500, height: 200 }, { type: 13, left: 600, top: 150, width: 300, height: 200 }] },
  { index: 5, background: { color: '0F1B26' }, shapes: [{ type: 17, text: 'Section', left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }] },
  { index: 6, background: { color: '0F1B26' }, shapes: [{ type: 17, text: 'Thank you', left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }] },
]);
for (const brief of parsedBriefs) {
  for (const request of [{ deck: { backgroundMode: 'custom' }, brief }, { brief }, { deck: { backgroundMode: 'custom' }, brief, slidePlans: [{ slide: 2, visualType: 'chart' }] }]) {
    designCases.push(design(briefDeck, { intent: 'Wait review', ...request }));
  }
}
designCases.push(design(briefDeck, { deck: { backgroundMode: 'custom' }, brief: 'not an object' }));

// ---- generated decks ----------------------------------------------------------------------------------------------------
let seed = 20260514;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];
const between = (low, high) => low + Math.floor(next() * (high - low + 1));
const chance = (share) => next() < share;
const FACES = ['Calibri', 'Arial', 'Georgia', '맑은 고딕', 'Segoe UI Semibold', 'Comic Sans MS', 'Gabarito Light', 'Pretendard', 'Inter'];
const COLORS = ['222222', 'FFFFFF', 'E63946', '1D4ED8', '0E7C86', 'F59E0B', '6D28D9', '16A34A', '94A3B8'];
const FILLS = ['E9EFF3', 'DCEBEC', '0F1B26', 'F7F9FC', 'E63946', 'EEEEEE'];
const GEOMETRIES = ['rect', 'roundRect', 'ellipse', 'chevron', 'homePlate', 'rightArrow', 'pie', 'blockArc', 'trapezoid', 'triangle', 'hexagon', 'diamond', 'custGeom', 'line', 'wedgeRectCallout', 'leftBrace', 'frame', 'snip1Rect'];
const WORDS = ['대기', 'queue', '처리량', 'throughput', '개선', 'plan', '출고', 'dock', 'night', '운영', '12%', '0.72'];
const sentence = (words) => Array.from({ length: words }, () => pick(WORDS)).join(' ');
const box = (width, height) => ({ left: between(0, 960 - width), top: between(0, 540 - height), width, height });
const generatedShape = () => {
  const kind = pick(['text', 'text', 'text', 'title', 'caption', 'metric', 'card', 'chart', 'table', 'group', 'picture', 'picture2', 'node', 'stripe', 'vline', 'chrome', 'motif', 'spec', 'placeholder']);
  const font = (size) => ({ size, ...(chance(0.8) ? { name: pick(FACES) } : {}), ...(chance(0.7) ? { color: pick(COLORS) } : {}), ...(chance(0.2) ? { bold: true } : {}) });
  switch (kind) {
    case 'title':
      return { type: 17, text: sentence(between(2, 6)), ...box(between(400, 800), between(40, 90)), font: font(between(32, 54)) };
    case 'caption':
      return { type: 17, text: sentence(between(2, 8)), ...box(between(100, 300), between(14, 30)), font: font(between(8, 12)) };
    case 'metric':
      return { type: 17, text: pick(['+12%', '−4', '38', '0.72x', 'abc', '12345678901234']), ...box(between(100, 260), between(50, 90)), font: font(between(36, 72)) };
    case 'card':
      return { type: 1, geometry: pick(['rect', 'roundRect']), text: sentence(between(4, 9)), fill: { color: pick(FILLS) }, ...box(between(180, 260), between(60, 140)), font: font(between(12, 20)) };
    case 'chart':
      return { chart: { type: pick(['bar', 'line']) }, ...box(between(300, 600), between(200, 340)) };
    case 'table':
      return { table: { rows: between(2, 6) }, ...box(between(300, 600), between(100, 260)) };
    case 'group':
      return { group: { count: between(2, 5) }, ...box(between(200, 500), between(100, 300)) };
    case 'picture':
      return { type: 13, ...box(between(100, 600), between(100, 400)) };
    case 'picture2':
      return { type: 'p:pic', ...box(between(100, 600), between(100, 400)) };
    case 'node':
      return { type: 'p:sp', geometry: pick(GEOMETRIES), ...(chance(0.5) ? { fill: { color: pick(FILLS) } } : {}), ...box(between(30, 200), between(30, 200)) };
    case 'stripe':
      return { type: 1, geometry: 'rect', fill: { color: 'E63946' }, left: pick([0, 40, 100, 400]), top: pick([0, 20, 100, 270, 500, 530]), width: pick([960, 880, 400, 330]), height: pick([2, 4, 6, 7, 1]) };
    case 'vline':
      return { type: 1, geometry: 'rect', fill: { color: '0F1B26' }, left: pick([0, 20, 58, 300, 940]), top: pick([0, 80, 150, 300]), width: pick([2, 6, 12, 14]), height: pick([180, 240, 300, 540]) };
    case 'chrome':
      return { type: 17, text: pick(['Deck name', '3', 'Section']), left: 40, top: pick([14, 28, 500]), width: 200, height: 12, font: font(pick([8, 10, 14, 16])) };
    case 'motif':
      return { type: 1, name: 'Mixdog Motif rings', altText: pick(['rings motif', 'dots motif', 'Rings Motif', 'x motif y']), ...box(between(100, 400), between(100, 400)) };
    case 'spec':
      return { type: 17, text: sentence(2), name: pick(['mixdog-spec:structure:lanes', 'mixdog-spec:chevrons', 'mixdog-spec:table', 'mixdog-spec:stat', 'mixdog-spec:structure:']), ...box(between(100, 300), between(30, 60)), font: font(14) };
    case 'placeholder':
      return { type: 14, placeholder: { type: 'title' }, text: sentence(3), ...box(400, 60), font: font(36) };
    default:
      return { type: 17, text: sentence(between(3, 40)), ...box(between(150, 500), between(40, 160)), font: font(between(11, 28)) };
  }
};
const generatedSlide = (index, count) => {
  const cover = index === 1;
  const closing = index === count && count >= 3;
  const shapes = Array.from({ length: cover || closing ? between(1, 3) : between(1, 8) }, generatedShape);
  if (!cover && !closing && chance(0.6)) shapes.unshift(title(index));
  const slide = { index: chance(0.97) ? index : pick([undefined, '3', 0, 1.5, null]), background: { color: cover || closing ? pick(['0F1B26', 'F7F9FC', '112233']) : pick(['F7F9FC', 'F7F9FC', 'F7F9FC', 'EEEEEE', '0F1B26']) }, shapes };
  if (chance(0.05)) delete slide.background;
  return slide;
};
const generatedDeck = () => {
  const count = between(2, 12);
  return deckOf(Array.from({ length: count }, (_, at) => generatedSlide(at + 1, count)), pick([{}, {}, { slideWidth: 1280, slideHeight: 720 }, { slideWidth: 0 }, { slideCount: count + 1 }]));
};
// decks of a few repeated pages, so the repetition readings fire
const repeatedDeck = () => {
  const count = between(5, 10);
  const page = generatedSlide(2, count).shapes;
  return deckOf(Array.from({ length: count }, (_, at) => ({ index: at + 1, background: { color: pick(['F7F9FC', 'F7F9FC', '0F1B26']) }, shapes: at === 0 || (at === count - 1 && chance(0.7)) ? generatedSlide(at + 1, count).shapes : page.map((shape, i) => ({ ...shape, left: (shape.left ?? 0) + (chance(0.3) ? between(-30, 30) : 0), top: (shape.top ?? 0) + i * 0 })) })));
};
const generatedRequests = [
  () => ({ ...customRequest }),
  () => ({ ...customRequest, allowTextOnly: chance(0.5), allowDecorativeLines: chance(0.5), allowSyntheticVisuals: chance(0.5) }),
  () => ({ intent: 'Review', signature: 'review' }),
  () => ({ review: true, deck: { backgroundMode: pick(['dark', 'light', 'sandwich', 'custom']) } }),
  () => ({ ...customRequest, slidePlans: Array.from({ length: between(1, 6) }, (_, at) => ({ slide: at + 1, ...(chance(0.7) ? { visualType: pick(['comparison', 'diagram', 'matrix', 'process', 'table', 'image', 'chart', 'metric', 'typography']) } : {}) })) }),
  () => ({ ...customRequest, brief: { plan: [{ slide: between(1, 4), carriers: [pick(['statement', 'quote', 'hero', 'specimen', 'chart'])] }] } }),
];
for (let at = 0; at < 220; at += 1) {
  const document = chance(0.35) ? repeatedDeck() : generatedDeck();
  designCases.push(design(document, pick(generatedRequests)()));
}

// text walls, card grids and composition sequences
const wall = (index, chars) => ({ index, background: { color: 'F7F9FC' }, shapes: [title(index), { type: 17, text: 'x'.repeat(chars), left: 58, top: 150, width: 800, height: 300, font: { size: 14 } }, { chart: { type: 'bar' }, left: 600, top: 150, width: 300, height: 300 }] });
const cards = (index, count = 3, aligned = true) => ({
  index,
  background: { color: 'F7F9FC' },
  shapes: [title(index), ...Array.from({ length: count }, (_, at) => ({ type: 1, geometry: 'rect', text: 'A card that carries its own copy', fill: { color: 'EEEEEE' }, left: 58 + at * 280, top: aligned ? 160 : 160 + at * 30, width: 250, height: 160 }))],
});
for (const request of [customRequest, { ...customRequest, allowRepetition: true }]) {
  designCases.push(
    design(deckOf([beat(1), wall(2, 700), wall(3, 650), wall(4, 651), beat(5)]), request),
    design(deckOf([beat(1), cards(2), cards(3), cards(4), evidence(5), beat(6)]), request),
    design(deckOf([beat(1), cards(2), cards(3, 3, false), cards(4, 2), beat(5)]), request),
    design(deckOf([beat(1), cards(2), cards(3), cards(4), cards(5), cards(6), cards(7)]), request)
  );
}
const sequence = (ids) => ids.map((id, at) => ({ id, kind: at === 0 ? 'cover' : at === ids.length - 1 ? 'closing' : 'content', slide: at + 1 }));
const sequenceDeck = deckOf([beat(1), evidence(2), evidence(3), evidence(4), evidence(5), beat(6)]);
for (const compositions of [
  sequence(['cover', 'steps', 'steps', 'steps', 'steps', 'closing']),
  sequence(['cover', 'steps', 'matrix', 'steps', 'matrix', 'closing']),
  sequence(['cover', 'steps', 'steps', 'steps', 'matrix', 'closing']),
  sequence(['cover', 'closing']),
  [],
]) {
  const first = review.reviewOfficeDesign({ format: 'pptx', document: sequenceDeck, design: { ...customRequest, compositions } });
  designCases.push(design(sequenceDeck, { ...customRequest, compositions }), design(sequenceDeck, { ...customRequest, compositions, allowRepetition: true }));
  const fingerprint = first.composition?.fingerprint;
  if (fingerprint) {
    designCases.push(
      { format: 'pptx', document: sequenceDeck, design: { ...customRequest, compositions }, library: { recentCompositions: [{ fingerprint, createdAt: '2026-01-01T00:00:00Z' }] } },
      { format: 'pptx', document: sequenceDeck, design: { ...customRequest, compositions }, library: { recentCompositions: [{ fingerprint: 'other' }, 5, null] } }
    );
  }
}

// ---- deck diversity (resolved design objects, read directly) --------------------------------------------------------------
const diversityCases = [];
const directionSets = [
  undefined,
  { artDirection: { candidates: [{ id: 'a', text: 'Bold type' }, { id: 'b', text: 'Calm photo' }, { id: 'c', text: 'Data wall' }], selected: { id: 'b' } } },
  { artDirection: { candidates: [{ id: 'a', text: 'Bold type' }, { id: 'b', text: 'bold   TYPE' }, { id: 'c', text: 'Data wall' }], selected: { id: 'b' } } },
  { artDirection: { candidates: [{ id: 'a', text: 'Bold type' }, { id: 'b', text: 'Calm photo' }, { id: 'c', text: 'Data wall' }], selected: {} } },
  { artDirection: { candidates: [{ id: 'a', mood: 'bold' }, { id: 'b', mood: 'calm' }, { id: 'c', mood: 'bold' }], selected: { id: 'a' } } },
  { artDirection: { candidates: [{ id: 'a', text: null, mood: 'x' }, 'plain', 7, null, ['x']], selected: { id: 'a' } } },
  { brief: { directions: { candidates: [{ text: 'Bold type' }, { text: 'Calm photo' }], selected: 'Bold type' } } },
  { brief: { directions: { candidates: [{ text: 'Bold type' }, { text: 'Calm photo' }], selected: '' } } },
  { brief: { directions: { candidates: [{ text: 'Bold type' }], selected: 'Bold type' } } },
  { brief: { directions: { candidates: [], selected: 'x' } } },
  { brief: { plan: [] } },
];
const diversityDecks = [
  deckOf([beat(1), evidence(2), evidence(3), beat(4)]),
  deckOf(beatDeck),
  deckOf([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i === 1 || i === 9 ? beat(i) : i % 3 ? thin(i) : laned(i)))),
  deckOf([nodePage(1, 'cover'), nodePage(2, 'node'), nodePage(3, 'node'), nodePage(4, 'node'), claim(5), claim(6)]),
  deckOf(Array.from({ length: 8 }, (_, index) => ({ ...imagePage(index + 1), shapes: [...imagePage(index + 1).shapes, { type: 1, name: 'Mixdog Motif rings', altText: index < 4 ? 'rings motif' : index === 4 ? 'Dots Motif' : 'x', left: 0, top: 0, width: 80, height: 80 }] }))),
  deckOf([beat(1), { ...evidence(2) }]),
  deckOf([beat(1)]),
  deckOf([]),
  deckOf(generatedDeck().slides),
];
for (const document of diversityDecks) {
  for (const extra of directionSets) {
    diversityCases.push({ document, design: { review: {}, ...(extra || {}) } });
  }
  diversityCases.push({ document, design: { review: { allowRepetition: true } } });
  diversityCases.push({ document, design: { review: {}, slidePlans: document.slides.map((entry, at) => ({ slide: entry.index ?? at + 1, visualType: pick(['chart', 'table', 'image', 'Metric', 'diagram', 'process', '']) })) } });
  diversityCases.push({ document, design: { review: {}, format: { canvasWidth: 1280, canvasHeight: 720 } } });
}
for (const brief of parsedBriefs) {
  diversityCases.push({ document: briefDeck, design: { review: {}, brief } });
}
diversityCases.push({ document: {}, design: {} }, { document: null, design: null }, { document: diversityDecks[1], design: { review: {}, brief: { readingMode: 'keynote' } } }, { document: diversityDecks[2], design: { review: {}, brief: { argumentMode: 'showcase' } } });
for (let at = 0; at < 80; at += 1) diversityCases.push({ document: chance(0.5) ? repeatedDeck() : generatedDeck(), design: { review: {}, ...(chance(0.5) ? pick(directionSets) || {} : {}) } });

// ---- critique --------------------------------------------------------------------------------------------------------------
const note = (text) => `${text} — the slide reads clearly with its labelled axis`;
const axes = (score) => ({ hierarchy: score, balance: score, legibility: score, cohesion: score, evidence: score });
const entry = (slide, extra = {}) => ({ slide, verdict: 'pass', ...axes(5), note: note(`Slide ${slide} chart`), fixes: [], ...extra });
const checks = (seed2) => [{ item: `${seed2} one`, pass: true }, { item: `${seed2} two`, answer: 'yes' }, { item: `${seed2} three`, pass: true }];
const critiqueCases = [
  { critique: [entry(1), entry(2)], pageCount: 2 },
  { critique: [entry(1), entry(2)], pageCount: 3 },
  { critique: [entry(1, { checks: checks('a') }), entry(2, { checks: checks('b') })], pageCount: 2, requireChecks: true },
  { critique: [entry(1), entry(2)], pageCount: 2, requireChecks: true },
  { critique: [entry(1, { note: 'short' }), entry(2, { hierarchy: 3 })], pageCount: 2 },
  { critique: [entry(1, { verdict: 'fix' }), entry(2, { fixes: ['tighten'] })], pageCount: 2 },
  { critique: [entry(1, { role: 'Cover', evidence: 2 }), entry(2, { role: 'closing', evidence: 1, balance: 3 }), entry(3, { role: 'content', evidence: 3 })], pageCount: 3 },
  { critique: [entry(1, { balance: 4.5 }), entry(2, { legibility: 6 }), entry(3, { cohesion: 0 }), entry(4, { evidence: '4' }), entry(5, { hierarchy: null })], pageCount: 5 },
  { critique: [entry(1), entry(1), entry(9), entry(0), { slide: 'x' }, { page: 2, ...axes(5), verdict: 'pass', note: note('page two body'), fixes: [] }], pageCount: 2 },
  { critique: [{ page: 1, ...axes(5), verdict: 'PASS', note: note('pdf page one') }, { slide: null, page: 2, ...axes(4), verdict: 'pass', note: note('pdf page two') }], pageCount: 2 },
  { critique: [{ slide: null, page: null }, { slide: undefined }, 5, null, 'x', [1]], pageCount: 2 },
  { critique: [entry(1, { note: note('same 1') }), entry(2, { note: note('same 2') })], pageCount: 2 },
  { critique: [entry(1, { note: note('same 1'), checks: checks('q') }), entry(2, { note: note('same 2'), checks: checks('q') })], pageCount: 2 },
  { critique: [entry(1, { checks: checks('q') }), entry(2, { checks: checks('Q') })], pageCount: 2 },
  { critique: [entry(1, { checks: [{ item: 'x', pass: false }, { question: 'y', answer: 'No' }, { item: '', pass: true }, 3, { item: 'z', answer: 'YES' }] })], pageCount: 1 },
  { critique: [entry(1, { fixes: 'one fix' }), entry(2, { fixes: [1, null, 'two', ''] })], pageCount: 2 },
  { critique: [entry(1)], pageCount: 1 },
  { critique: [entry(1)], pageCount: '1' },
  { critique: [entry(1)], pageCount: 0 },
  { critique: [entry(1)], pageCount: -2 },
  { critique: [entry(1)], pageCount: 1.5 },
  { critique: [entry(1), entry(2)], pageCount: 2.5 },
  { critique: 'x', pageCount: 2 },
  { pageCount: 2 },
  { critique: [], pageCount: 1 },
  {},
];
const acknowledgedCases = [
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, coverageComplete: true, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 2, snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, providedToken: 'u', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: '', renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  { reviewed: 'true', providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: null, snapshotVersion: 0, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 0, snapshotVersion: 0, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: '3', snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: null, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, coverageComplete: false, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, coverageComplete: null, critiqueOk: true },
  { reviewed: true, providedToken: 't', expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, critiqueOk: false },
  { reviewed: true, providedToken: 5, expectedToken: 5, renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  { reviewed: true, expectedToken: 't', renderedVersion: 3, snapshotVersion: 3, critiqueOk: true },
  {},
];

// ---- rubric ------------------------------------------------------------------------------------------------------------------
const slideObservation = (index, observe, extra = {}) => ({ slide: index, observe, ...extra });
const GOOD = {
  slides: [
    slideObservation(1, { air: 0.3, bodyTop: 4.6, bodyFill: 1, fieldFill: [0.62], presence: 0.36, renderBalance: { score: 0.88 }, textColumns: { rightStray: 1 } }),
    slideObservation(2, { air: 0.42, bodyTop: 2.22, bodyFill: 0.94, fieldFill: [0.31], presence: 0.31, renderBalance: { score: 0.86 }, textColumns: { rightStray: 1 } }),
    slideObservation(3, { air: 0.54, bodyTop: 2.22, bodyFill: 0.97, fieldFill: [0.95], presence: 0.27, renderBalance: { score: 0.82 }, textColumns: { rightStray: 2 } }),
    slideObservation(4, { air: 0.33, bodyTop: 2.22, bodyFill: 1, fieldFill: [0.9], presence: 0.44, renderBalance: { score: 0.9 }, textColumns: { rightStray: 1 } }),
  ],
  deck: { textOnly: 0, rhythm: { gapSet: [0.1, 0.45, 0.95], typeSet: [11, 13, 18, 22, 36], textColors: ['A', 'B', 'C', 'D'] } },
};
const POOR = {
  slides: [
    slideObservation(1, { air: 0.3, bodyTop: 4.6, bodyFill: 0.3, fieldFill: [0], presence: 0.08, renderBalance: { score: 0.6 }, textColumns: { rightStray: 3 } }),
    slideObservation(2, { air: 0.31, bodyTop: 2.2, bodyFill: 0.4, fieldFill: [0.05], presence: 0.06, renderBalance: { score: 0.55 }, textColumns: { rightStray: 4 } }),
    slideObservation(3, { air: 0.32, bodyTop: 3.1, bodyFill: 0.42, fieldFill: [0.1], presence: 0.1, renderBalance: { score: 0.62 }, textColumns: { rightStray: 3 } }),
    slideObservation(4, { air: 0.3, bodyTop: 2.9, bodyFill: 0.45, fieldFill: [0.12], presence: 0, renderBalance: { score: 0.58 }, textColumns: { rightStray: 5 } }),
  ],
  deck: { textOnly: 3, rhythm: { gapSet: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1.1, 1.4], typeSet: [9, 10, 11, 12, 13, 14, 18, 22, 30, 36, 44, 56], textColors: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] } },
};
const bodySlide = (index, chars) => ({ slide: index, grammar: 'body', chars, observe: { bodyTop: index % 2 ? 2.2 : 3.1, renderLargest: 0.05 } });
const rubricCases = [
  { receipt: GOOD, issues: 0 },
  { receipt: POOR, issues: 3 },
  { receipt: POOR, issues: 9 },
  { receipt: { slides: [slideObservation(1, { air: 0.3, bodyTop: 2.2, bodyFill: 0.9, textColumns: { rightStray: 1 } })], deck: { textOnly: 0, rhythm: {} } }, issues: 0 },
  { receipt: {}, issues: 0 },
  { issues: 2 },
  { receipt: { slides: [bodySlide(1, 20), bodySlide(2, 25), bodySlide(3, 30), bodySlide(4, 22)], deck: { rhythm: {} } }, issues: 0, brief: { readingMode: 'balanced' } },
  ...['presentation', 'keynote', 'showcase'].map((mode) => ({ receipt: { slides: [bodySlide(1, 20), bodySlide(2, 25), bodySlide(3, 30), bodySlide(4, 22)], deck: { rhythm: {} } }, issues: 0, brief: { readingMode: mode } })),
  { receipt: { slides: [bodySlide(1, 700), bodySlide(2, 900), bodySlide(3, 350), { slide: 4, grammar: 'beat', chars: 10, observe: { renderLargest: 0.4 } }], deck: { rhythm: {}, shape: { beat: 0.25 }, pacing: { colourSpread: 20 } } }, issues: 1 },
  { receipt: { slides: [bodySlide(1, 700), bodySlide(2, 900), bodySlide(3, 350), bodySlide(4, 400)], deck: { rhythm: {}, shape: { beat: 0.5 }, pacing: { colourSpread: 2 }, textOnly: 2 } }, issues: 0 },
  { receipt: { slides: [bodySlide(1, 700), bodySlide(2, 900)], deck: { shape: { beat: 0.1 }, pacing: { colourSpread: 'x' } } }, issues: 0 },
  { receipt: { slides: [{ slide: 1, observe: { air: 0.1 } }, { slide: 2, observe: { air: 0.5 } }, { slide: 3, observe: { air: 0.9 } }, { slide: 4, observe: null }, 'x'], deck: { textOnly: '2' } }, issues: 0 },
  { receipt: { slides: [{ slide: 1, observe: { bodyTop: 2, presence: 0.5, fieldFill: ['x'], renderBalance: { score: 'x' } } }, { slide: 2, observe: { bodyTop: 2, presence: 0.1, fieldFill: [] } }], deck: { rhythm: { gapSet: 'x', typeSet: [], textColors: [1, 2, 3, 4, 5, 6] } } }, issues: 0 },
];
{
  let state = 20260601;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const num = (low, high, digits = 2) => Number((low + rand() * (high - low)).toFixed(digits));
  for (let at = 0; at < 80; at += 1) {
    const count = 1 + Math.floor(rand() * 9);
    const slides = Array.from({ length: count }, (_, index) => ({
      slide: index + 1,
      ...(rand() < 0.85 ? { grammar: ['beat', 'evidence', 'text'][Math.floor(rand() * 3)] } : {}),
      ...(rand() < 0.85 ? { chars: Math.floor(rand() * 1000) } : {}),
      observe: {
        ...(rand() < 0.8 ? { bodyTop: pick([2.2, 2.2, 3.1, 4.6]) } : {}),
        ...(rand() < 0.8 ? { bodyFill: num(0, 1) } : {}),
        ...(rand() < 0.6 ? { fieldFill: [num(0, 1)] } : {}),
        ...(rand() < 0.8 ? { presence: num(0, 0.6) } : {}),
        ...(rand() < 0.7 ? { renderBalance: { score: num(0.4, 1) } } : {}),
        ...(rand() < 0.8 ? { air: num(0.1, 0.9, 3) } : {}),
        ...(rand() < 0.7 ? { textColumns: { rightStray: num(0, 6, 1) } } : {}),
        ...(rand() < 0.6 ? { renderLargest: num(0, 0.8) } : {}),
      },
    }));
    rubricCases.push({
      receipt: {
        slides,
        deck: {
          textOnly: Math.floor(rand() * count),
          rhythm: { gapSet: Array.from({ length: Math.floor(rand() * 16) }, (_, i) => i), typeSet: Array.from({ length: Math.floor(rand() * 18) }, (_, i) => i), textColors: Array.from({ length: Math.floor(rand() * 12) }, (_, i) => i) },
          ...(rand() < 0.7 ? { shape: { beat: num(0, 0.8) } } : {}),
          ...(rand() < 0.7 ? { pacing: { colourSpread: num(0, 30, 1) } } : {}),
        },
      },
      issues: Math.floor(rand() * 9),
      ...(rand() < 0.3 ? { brief: { readingMode: pick(['presentation', 'keynote', 'showcase', 'balanced']) } } : {}),
    });
  }
}

// ---- slide roles and the authored rules ---------------------------------------------------------------------------------
const rolesCases = [
  deckOf([beat(1), evidence(2), imagePage(3), laned(4), claim(5)]),
  deckOf(Array.from({ length: 8 }, (_, index) => ({ ...generatedSlide(index + 1, 8), index: index + 1 }))),
  { slides: [{ index: 3, shapes: [{ type: 13, left: 0, top: 0, width: 900, height: 500 }] }, { index: 12, shapes: [{ type: 17, text: 'One claim', font: { size: 48 }, width: 500, height: 100 }] }, { index: 2, shapes: [{ type: 'p:sp', geometry: 'ellipse', left: 0, top: 0, width: 300, height: 300 }, { type: 'p:sp', geometry: 'ellipse', left: 300, top: 0, width: 300, height: 300 }, { type: 'p:cxnSp', left: 0, top: 300, width: 600, height: 0 }] }, { index: 0 }, { index: 1.5, shapes: [{ type: 17, text: 'Half', font: { size: 50 }, width: 500, height: 100 }] }, { index: 3, shapes: [{ type: 17, text: 'Again', font: { size: 50 }, width: 500, height: 100 }] }, { shapes: [] }, null] },
  { slides: [] },
  {},
  ...Array.from({ length: 60 }, () => generatedDeck()),
];
const slideRoleCases = [];
for (let at = 0; at < 120; at += 1) {
  const deck = generatedDeck();
  const slide = pick(deck.slides);
  slideRoleCases.push({ slide, size: pick([{ width: 960, height: 540 }, { width: 0, height: 0 }, { width: 1280, height: 720 }, {}, { width: 100, height: 100 }]) });
}
const specimen = (...sizes) => sizes.map((size, at) => ({ type: 17, text: 'Aa', left: 40, top: 40 + at * 80, width: 300, height: 60, font: { size, ...(at === 1 ? { bold: true } : {}), name: 'Georgia' } }));
const specimenCases = [specimen(48, 24, 14), specimen(48, 24), specimen(20, 18, 14), specimen(48, 48, 48), [...specimen(48, 24, 14), ...specimen(30, 30)], []].map((shapes) => ({ shapes }));

const authoredCases = { slideSize: [], ladder: [], stripe: [], cardGrid: [] };
for (const document of [{}, { slideWidth: 1280, slideHeight: 720 }, { slideWidth: 0, slideHeight: 'x' }, { slideWidth: '600' }, null, { slideWidth: Infinity }, { slideWidth: -5, slideHeight: 400 }]) authoredCases.slideSize.push({ document });
for (const [backgrounds, tokenColors] of [
  [['F4EFE6', 'F4EFE6', '1B2A41', 'F4EFE6'], { canvas: 'FFFFFF', inverse: '000000' }],
  [['F4EFE6', 'F4EFE6', '1B2A41', 'F4EFE6'], { canvas: 'f4efe6' }],
  [['F4EFE6', '1B2A41', '1B2A41', '3355AA', 'FFFFFF'], { accent: 'FF0000', n: 5, empty: '', nothing: null }],
  [['111111', '111111', 'EEEEEE', 'CCCCCC', 'EEEEEE'], undefined],
  [['AAAAAA'], {}],
  [['AAAAAA', 'BBBBBB'], null],
  [['ZZZZZZ', 'AAAAAA', 'ZZZZZZ'], {}],
]) authoredCases.ladder.push({ backgrounds, tokenColors });
for (let at = 0; at < 160; at += 1) {
  const shapes = Array.from({ length: between(1, 6) }, () => pick([() => generatedShape(), () => ({ type: 1, geometry: 'rect', ...pick([{ left: 0, top: 100, width: 10, height: 540 }, { left: 40, top: 30, width: 880, height: 1 }, { left: 40, top: 500, width: 880, height: 1.5 }, { left: 58, top: 150, width: 6, height: 200 }, { left: 300, top: 200, width: 400, height: 4 }, { left: 900, top: 0, width: 14, height: 540 }]) }), () => ({ type: 17, text: pick(['Deck name', 'Big title']), left: pick([40, 60, 300]), top: pick([14, 100, 210, 500]), width: 300, height: 30, font: { size: pick([10, 14, 24, 40]) } })])());
  authoredCases.stripe.push({ shapes, size: pick([{ width: 960, height: 540 }, { width: 1280, height: 720 }, { width: 600, height: 400 }]) });
}
for (let at = 0; at < 120; at += 1) {
  const card = (left, top, width, height, fill = true) => ({ type: 1, geometry: 'rect', text: chance(0.8) ? sentence(5) : 'short', ...(fill ? { fill: { color: 'EEEEEE' } } : {}), left, top, width, height });
  const count = between(2, 5);
  const row = chance(0.7);
  const shapes = Array.from({ length: count }, (_, i) => card(row ? 40 + i * 230 : 40, row ? 100 : 100 + i * 130, pick([200, 200, 212, 300]), pick([100, 100, 40, 130]), chance(0.8)));
  if (chance(0.3)) shapes.push({ type: 17, text: sentence(6), left: 50, top: 110, width: 100, height: 20 });
  authoredCases.cardGrid.push({ shapes });
}

const golden = {
  design: record(designCases, (input) => review.reviewOfficeDesign(input)),
  diversity: record(diversityCases, (input) => diversity.reviewPptxDeckDiversity(input)),
  critique: record(critiqueCases, (input) => critique.reviewPptxVisualCritique(input)),
  acknowledged: record(acknowledgedCases, (input) => critique.pptxVisualReviewAcknowledged(input)),
  rubric: record(rubricCases, (input) => rubric.scoreDeck({ receipt: input.receipt, issues: Array.from({ length: input.issues || 0 }, () => ({ code: 'x' })), brief: input.brief })),
  roles: record(rolesCases, (input) => review.inferPptxSlideRoles(input)),
  slideRoles: record(slideRoleCases, ({ slide, size }) => ({ diagram: roles.isPptxDiagramSlide(slide, size), picture: roles.isPptxPictureSlide(slide, size), statement: roles.isPptxStatementSlide(slide), specimen: roles.isPptxSpecimenSlide((slide.shapes || []).filter((shape) => String(shape.text || '').trim())) })),
  specimen: record(specimenCases, ({ shapes }) => roles.isPptxSpecimenSlide(shapes)),
  slideSize: record(authoredCases.slideSize, ({ document }) => authored.slideSize(document)),
  ladder: record(authoredCases.ladder, ({ backgrounds, tokenColors }) => authored.authoredBackgroundLadder(backgrounds, tokenColors)),
  stripe: record(authoredCases.stripe, ({ shapes, size }) => shapes.map((shape) => authored.isOrnamentalStripe(shape, shapes, size))),
  cardGrid: record(authoredCases.cardGrid, ({ shapes }) => authored.isCardGridSlide(shapes.filter((shape) => String(shape.text || '').trim()), shapes)),
};
// the receipts the review reads (page grammar, specs, chars) are the authoring crate's own; a sample pins that the replay's
// receipt reader and Node's agree on the decks these cases use
golden.receipts = record(
  [...diversityDecks, briefDeck, deckOf(beatDeck)].flatMap((document) => document.slides.map((slide) => ({ slide }))),
  ({ slide }) => receipts.slideReceipt(slide)
);
writeText(join(stage, 'golden.json'), orderedStringify(golden, 0));
writeSetManifest(stage, { set: 'office-design-review', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
const summary = Object.entries(golden).map(([name, list]) => `${name} ${list.length}${list.some((entry) => entry.error) ? ` (${list.filter((entry) => entry.error).length} errors)` : ''}`);
console.log(`golden.json: ${summary.join(', ')}`);
