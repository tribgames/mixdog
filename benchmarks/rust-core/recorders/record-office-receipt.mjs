#!/usr/bin/env node
// Golden of the composition receipt (crate mixdog-office-author, module receipt): what Node's
// `runtime/office/authoring/pptx-receipt.mjs` answers to the deck snapshots of its own suite (pptx-receipt.test.mjs) and to
// a seeded corpus of decks: the per-slide receipts (counts, grammar, spec carriers, the observations read from the shape
// footprints), the deck receipts read against a brief, the receipts with rendered air attached (a bare number or a full
// reading per page), and the receipts a session sends twice or three times (`receiptForDelivery`, with an edit between).
// Writes native/core/fixtures/office-receipt/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-receipt.mjs --tree <product tree>
//
// Every case is { input, output }; every input is plain JSON (the replay reads it back) and keys are written in the order
// the module produces them. The corpus is seeded: the file is byte-stable.
import { join } from 'node:path';
import { commitStage, FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-receipt.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-receipt');
const stage = stageSet(finalDir);

const receipt = await importFrom(tree, 'src/runtime/office/authoring/pptx-receipt.mjs');
const brief = await importFrom(tree, 'src/runtime/office/authoring/pptx-brief.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- the suite's decks ----------------------------------------------------------------------------------------------------
const PAPER = 'F7F9FB';
const TITLE = { text: 'Title', font: { size: 36 }, left: 43, top: 72, width: 600, height: 60 };
const PROSE = "A body page carries the argument in the source's own words, three hundred characters or more beside its chart.";
const SUITE_DECKS = [
  {
    slides: [
      { index: 1, background: { color: '0F1B26' }, shapes: [{ text: 'Cover title', font: { size: 47 }, width: 600, height: 120 }, { text: '01', font: { size: 240 }, width: 400, height: 300 }] },
      {
        index: 2,
        background: { color: PAPER },
        shapes: [
          { text: 'Title', font: { size: 36 }, width: 800, height: 60 },
          { chart: { path: '/slide[2]/shape[2]/chart' }, width: 600, height: 320 },
          { geometry: 'rect', fill: { color: 'DCEBEC' }, width: 870, height: 50 },
          { text: 'Takeaway', font: { size: 22 }, width: 850, height: 50 },
        ],
      },
      {
        index: 3,
        background: { color: PAPER },
        shapes: [
          { text: 'Title', font: { size: 36 }, width: 800, height: 60 },
          { geometry: 'chevron', fill: { color: 'E9EFF3' }, width: 200, height: 80 },
          { geometry: 'chevron', fill: { color: '0E7C86' }, width: 200, height: 80 },
          { geometry: 'line', width: 300, height: 0 },
          { text: 'detail', font: { size: 13 }, width: 200, height: 80 },
        ],
      },
      { index: 4, background: { color: PAPER }, shapes: [{ text: 'Title', font: { size: 36 }, width: 800, height: 60 }, { text: 'a paragraph', font: { size: 18 }, width: 800, height: 200 }] },
    ],
  },
  {
    slides: [
      {
        index: 1,
        background: { color: PAPER },
        shapes: [
          { text: '채택', name: 'mixdog-spec:badge:positive', font: { size: 11, name: 'Noto Sans KR' }, width: 90, height: 24 },
          { text: '보류', name: 'mixdog-spec:badge:warning', font: { size: 11, name: 'Noto Sans KR' }, width: 90, height: 24 },
          { text: '31', name: 'mixdog-spec:stat:band', font: { size: 49, name: 'Arial' }, width: 200, height: 80 },
          { table: { path: '/slide[1]/shape[4]/table' }, name: 'mixdog-spec:table:toned', width: 600, height: 200 },
          { text: 'plain box', font: { size: 18 }, width: 300, height: 60 },
        ],
      },
      {
        index: 2,
        background: { color: PAPER },
        shapes: [
          { text: '기각', name: 'mixdog-spec:badge:critical', font: { size: 14, name: 'Noto Sans KR' }, width: 90, height: 24 },
          { text: '주의', name: 'mixdog-spec:callout:warning', font: { size: 14, name: 'Noto Sans KR' }, width: 300, height: 60 },
        ],
      },
    ],
  },
  {
    slides: [
      {
        index: 5,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { geometry: 'rect', fill: { color: '0E7C86' }, left: 0, top: 0, width: 480, height: 540 },
          { text: 'body', font: { size: 18 }, left: 43, top: 200, width: 400, height: 100 },
          { text: 'stray', font: { size: 18 }, left: 700, top: 300, width: 200, height: 60 },
          { chart: { path: '/slide[5]/shape[5]/chart' }, left: 500, top: 100, width: 400, height: 150 },
        ],
      },
      {
        index: 9,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 100, top: 200, width: 30, height: 30 },
          { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 700, top: 200, width: 30, height: 30 },
          { geometry: 'line', left: 130, top: 215, width: 570, height: 0 },
          { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 400, top: 460, width: 30, height: 30 },
        ],
      },
      {
        index: 7,
        background: { color: PAPER },
        shapes: [
          { geometry: 'rect', fill: { color: PAPER }, left: 0, top: 0, width: 960, height: 540 },
          { text: 'claim', font: { size: 40 }, left: 280, top: 220, width: 400, height: 100 },
        ],
      },
      {
        index: 6,
        background: { color: '0F1B26' },
        shapes: [
          { text: 'no fill textbox', font: { size: 18 }, left: 40, top: 40, width: 300, height: 60, fillColor: 16777215, fillVisible: false },
          { geometry: 'rect', left: 480, top: 0, width: 480, height: 540, fillColor: 8813582, fillVisible: true },
        ],
      },
    ],
  },
  {
    slides: [
      {
        index: 8,
        background: { color: PAPER },
        shapes: [
          { text: 'Title', font: { size: 36 }, sizes: [36], colors: ['1A2B3C'], left: 43, top: 72, width: 600, height: 60 },
          { text: 'prose', font: { size: 18 }, sizes: [18, 18], colors: ['33475B', 'B04A2A'], left: 43, top: 164.4, width: 560, height: 100 },
          { text: 'caption', font: { size: 12 }, sizes: [12], colors: ['6B7A8A'], left: 43, top: 273, width: 560, height: 20 },
          { geometry: 'rect', fill: { color: '0E7C86' }, left: 700, top: 100, width: 200, height: 300 },
          { text: 'on field', font: { size: 18, color: 16777215 }, left: 720, top: 120, width: 160, height: 40 },
        ],
      },
    ],
  },
  {
    slides: [
      {
        index: 11,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { geometry: 'rect', fill: { color: 'E7EBEE' }, left: 480, top: 160, width: 480, height: 380 },
          { text: 'two lines on the plane', font: { size: 14 }, left: 510, top: 180, width: 400, height: 50 },
          { chart: { path: '/slide[11]/shape[4]/chart' }, left: 43, top: 160, width: 400, height: 360 },
        ],
      },
      {
        index: 12,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { geometry: 'rect', fill: { color: 'E7EBEE' }, left: 480, top: 160, width: 480, height: 380 },
          { text: 'two lines on the plane', font: { size: 14 }, left: 510, top: 180, width: 400, height: 50 },
          { chart: { path: '/slide[12]/shape[4]/chart' }, left: 43, top: 160, width: 400, height: 360 },
          { text: 'the rest of the column', font: { size: 14 }, left: 510, top: 260, width: 400, height: 260 },
        ],
      },
      {
        index: 13,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { text: 'a paragraph under the title', font: { size: 18 }, left: 43, top: 164.4, width: 560, height: 100 },
          { geometry: 'line', left: 100, top: 305, width: 300, height: 0 },
          { text: 'L2', font: { size: 11 }, left: 100, top: 280, width: 40, height: 20 },
          { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 700, top: 200, width: 14, height: 14 },
          { text: 'node', font: { size: 11 }, left: 720, top: 196, width: 60, height: 20 },
          { text: 'a caption far from any device', font: { size: 12 }, left: 43, top: 400, width: 560, height: 20 },
        ],
      },
    ],
  },
  {
    slides: [
      {
        index: 1,
        background: { color: '0F1B26' },
        shapes: [{ text: 'Cover', font: { size: 47 }, left: 43, top: 200, width: 600, height: 120 }, { type: 'p:pic', name: 'Icon', left: 500, top: 20, width: 440, height: 500 }],
      },
      { index: 2, background: { color: PAPER }, shapes: [TITLE, { chart: {}, left: 43, top: 150, width: 800, height: 340 }, { text: PROSE, font: { size: 15 }, left: 43, top: 500, width: 800, height: 30 }] },
      {
        index: 3,
        background: { color: PAPER },
        shapes: [{ geometry: 'rect', fill: { color: '0E7C86' }, left: 0, top: 0, width: 960, height: 540 }, { text: 'Section', font: { size: 40 }, left: 43, top: 200, width: 600, height: 80 }],
      },
      { index: 4, background: { color: PAPER }, shapes: [TITLE, { text: PROSE, font: { size: 15 }, left: 43, top: 150, width: 800, height: 200 }] },
      { index: 5, background: { color: PAPER }, shapes: [TITLE, { text: 'A stat band', name: 'mixdog-spec:stat:band', font: { size: 54 }, left: 43, top: 150, width: 300, height: 100 }] },
      {
        index: 6,
        background: { color: PAPER },
        shapes: [
          TITLE,
          { geometry: 'ellipse', left: 100, top: 200, width: 80, height: 80 },
          { geometry: 'ellipse', left: 400, top: 200, width: 80, height: 80 },
          { geometry: 'line', left: 180, top: 240, width: 220, height: 0 },
        ],
      },
    ],
  },
  ...['mixdog-device:orb', 'Picture 3', 'mixdog-svg:<svg/>'].map((name) => ({
    slides: [
      {
        index: 1,
        background: { color: '0F1B26' },
        shapes: [{ text: 'Cover', font: { size: 47 }, left: 43, top: 200, width: 600, height: 120 }, { type: 'p:pic', name, altText: 'sphere', left: 560, top: 60, width: 460, height: 460 }],
      },
    ],
  })),
  { slides: [] },
  {},
  { slideWidth: 595, slideHeight: 842, slides: [{ index: 1, background: { color: PAPER }, shapes: [{ text: 'A4', font: { size: 20 }, left: 40, top: 60, width: 500, height: 40 }, { geometry: 'rect', fill: { color: '0E7C86' }, left: 0, top: 400, width: 595, height: 442 }] }] },
];

const SUITE_BRIEFS = [
  null,
  '\n// BRIEF\n// slide plan: 1 job: cover · carriers: statement · 2 job: evidence · carriers: chart · 3 job: process · carriers: diagram · 4 job: evidence · carriers: chart, table\n',
  '\n// BRIEF\n// slide plan: 1 job: cover · rhythm: anchor · 2 job: evidence · rhythm: dense · 3 job: section · rhythm: anchor · 4 job: claim · rhythm: anchor · 5 job: evidence · rhythm: dense · 6 job: process · rhythm: dense\n',
  '\n// BRIEF\n// slide plan: 1 job: cover · carriers: hero, picture · rhythm: anchor · 2 job: evidence · carriers: gauge, specimen · 5 job: claim · carriers: quote, diagram\n',
];

// ---- the seeded corpus -----------------------------------------------------------------------------------------------------
let seed = 20261115;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];
const between = (low, high, step = 1) => low + Math.floor((next() * (high - low)) / step) * step;
const chance = (p) => next() < p;
const round2 = (value) => Number(value.toFixed(2));

const COLORS = ['0F1B26', 'F7F9FB', '0E7C86', 'DCEBEC', 'B04A2A', '1A2B3C', 'FFFFFF', '2B2B2B', 'FFD166', 'E9EFF3', '7A3FBF', '808080', 'abcdef'];
const GEOMETRIES = ['rect', 'roundRect', 'ellipse', 'chevron', 'line', 'straightConnector1', 'bentConnector3', 'blockArc', 'triangle', 'round1Rect'];
const SPECS = ['badge:positive', 'badge:critical', 'callout:warning', 'stat:band', 'stat:plain', 'table:toned', 'chevrons:three', 'structure:rows', 'quote:'];
const FACES = ['Noto Sans KR', 'Arial', 'Georgia'];
const WORDS = ['Revenue', 'grew 12%', '  spaced  out  ', '채택', 'a\nb', 'x', 'Quarterly review of the plan', '2026-09-03', ' pad '];

const placed = (shape, canvas) => {
  if (chance(0.08)) return shape; // a shape the snapshot gave no position
  const width = between(0, Math.round(canvas.width * 0.95), 5);
  const height = between(0, Math.round(canvas.height * 0.8), 5);
  const left = chance(0.1) ? round2(next() * canvas.width) : between(0, Math.round(canvas.width - width), 6);
  const top = chance(0.1) ? round2(next() * canvas.height) : between(0, Math.round(canvas.height - height), 6);
  return { ...shape, left, top, width: chance(0.05) ? 0 : width, height: chance(0.05) ? 0 : height };
};

const shapeOf = (canvas) => {
  const kind = pick(['text', 'text', 'text', 'rect', 'rect', 'geometry', 'geometry', 'line', 'chart', 'table', 'picture', 'group', 'chrome', 'empty']);
  let shape;
  if (kind === 'text') {
    const size = pick([9, 11, 12, 14, 18, 22, 28, 36, 44, 54, 96]);
    shape = { text: pick(WORDS), font: { size, ...(chance(0.4) ? { name: pick(FACES) } : {}), ...(chance(0.2) ? { color: pick([0, 16777215, 8813582, '111827', '#33475B', -1, 'oops']) } : {}) } };
    if (chance(0.3)) shape.sizes = [size, pick([10, 12, 16])];
    if (chance(0.3)) shape.colors = [pick(COLORS), pick(COLORS)];
    if (chance(0.15)) shape.runs = { colors: [pick([0, 16777215, 8813582, -1]), pick([0, 255])], sizes: [pick([10, 14, 20])] };
    if (chance(0.2)) shape.name = `mixdog-spec:${pick(SPECS)}`;
    if (chance(0.15)) shape.fonts = [pick(FACES)];
    if (chance(0.15)) shape.fill = { color: pick(COLORS) };
  } else if (kind === 'rect') {
    shape = { geometry: pick(['rect', 'roundRect']), ...(chance(0.8) ? { fill: { color: pick(COLORS) } } : {}) };
    if (chance(0.2)) Object.assign(shape, { fillColor: pick([0, 8813582, 16777215, -1]), fillVisible: pick([true, false]), ...(chance(0.3) ? { fillTransparency: pick([0, 0.5, 1]) } : {}) });
  } else if (kind === 'geometry') shape = { geometry: pick(GEOMETRIES), ...(chance(0.6) ? { fill: { color: pick(COLORS) } } : {}) };
  else if (kind === 'line') shape = { geometry: pick(['line', 'straightConnector1', 'curvedConnector3']) };
  else if (kind === 'chart') shape = { chart: { path: '/slide[1]/shape[1]/chart' } };
  else if (kind === 'table') shape = { table: { rows: 2 }, ...(chance(0.4) ? { name: 'mixdog-spec:table:toned' } : {}) };
  else if (kind === 'picture') shape = { type: pick(['p:pic', 13, 'p:pic']), ...(chance(0.4) ? { name: pick(['Icon', 'mixdog-svg:<svg/>', 'mixdog-device:orb', 'Picture 2']) } : {}) };
  else if (kind === 'group') shape = { group: { children: 2 } };
  else if (kind === 'chrome') shape = { placeholder: true, type: pick([14, 14, 1]), ...(chance(0.7) ? { text: pick(['7', '', '  ']) } : {}), font: { size: 10 } };
  else shape = chance(0.5) ? {} : { text: '   ', font: { size: 20 } };
  if (chance(0.1)) shape.placeholder = true;
  return placed(shape, canvas);
};

const slideOf = (index, canvas) => ({
  index,
  ...(chance(0.9) ? { background: { color: pick(COLORS) } } : {}),
  shapes: Array.from({ length: between(0, 12) }, () => shapeOf(canvas)),
});

const CANVASES = [{ width: 960, height: 540 }, { width: 960, height: 540 }, { width: 960, height: 540 }, { width: 595, height: 842 }, { width: 720, height: 405 }];
const randomDeck = () => {
  const canvas = pick(CANVASES);
  const wide = canvas.width === 960 && canvas.height === 540;
  const count = between(0, 8);
  return { ...(wide ? {} : { slideWidth: canvas.width, slideHeight: canvas.height }), slides: Array.from({ length: count }, (_, i) => slideOf(i + 1, canvas)) };
};

const RHYTHMS = ['anchor', 'dense', 'breathe', 'Anchor-ish', ''];
const briefFor = (document) => {
  const slides = document.slides || [];
  if (!slides.length || chance(0.35)) return null;
  const lines = slides
    .map((slide, i) => {
      const carriers = [pick(['statement', 'chart', 'table', 'picture', 'hero', 'diagram', 'gauge', 'specimen', 'quote']), ...(chance(0.4) ? [pick(['chart', 'table', 'hero'])] : [])];
      return `${i + 1} job: ${pick(['cover', 'evidence', 'process', 'closing'])} · carriers: ${carriers.join(', ')}${chance(0.6) ? ` · rhythm: ${pick(RHYTHMS)}` : ''}`;
    })
    .slice(0, chance(0.2) ? Math.max(1, slides.length - 1) : slides.length);
  return `\n// BRIEF\n// slide plan: ${lines.join(' · ')}\n`;
};

const readFor = (slide) => {
  if (chance(0.15)) return null;
  if (chance(0.15)) return round2(next());
  return {
    air: round2(next()),
    ...(chance(0.85) ? { colour: round2(next() * 50) } : {}),
    ...(chance(0.8) ? { largest: round2(next()) } : {}),
    ...(chance(0.8) ? { balance: { centered: round2(next()), leftRight: round2(next()), topBottom: round2(next()), score: round2(next()) } } : {}),
  };
};

// ---- cases -----------------------------------------------------------------------------------------------------------------
const decks = [...SUITE_DECKS, ...Array.from({ length: 36 }, randomDeck)];
const pageOf = (document) => {
  const named = Number(document.slideWidth) > 0 && Number(document.slideHeight) > 0;
  return named ? { width: Number(document.slideWidth), height: Number(document.slideHeight) } : { width: 960, height: 540 };
};
const slideCases = [];
for (const document of decks) {
  const page = pageOf(document);
  for (const slide of document.slides || []) slideCases.push({ input: { slide: plain(slide), page }, output: plain(receipt.slideReceipt(slide, page)) });
}

const withBrief = (script) => (script ? plain(brief.parseAuthoringBrief(script)) : null);
const deckCases = [];
const briefScripts = SUITE_BRIEFS.slice(1);
decks.forEach((document, at) => {
  const scripts = at < SUITE_DECKS.length ? [null, ...briefScripts] : [briefFor(document)];
  for (const script of scripts) {
    const parsed = withBrief(script);
    const reads = (document.slides || []).map((slide) => [slide.index, readFor(slide)]).filter(([, read]) => read !== null);
    const input = { document: plain(document), brief: parsed, reads };
    const composed = plain(receipt.compositionReceipt(document, parsed));
    const attached = plain(receipt.compositionReceipt(document, parsed));
    receipt.attachRenderedAir(attached, new Map(reads));
    // A session that is sent the receipt, the same receipt with its render, and the receipt after an edit.
    const session = {};
    const sent = [composed, attached, attached].map((one) => plain(receipt.receiptForDelivery(plain(one), session)));
    const edited = plain(attached);
    if (edited.slides?.length) {
      edited.slides[0].chars = (edited.slides[0].chars || 0) + 1;
      if (edited.deck?.slides !== undefined) edited.deck.charts = (edited.deck.charts || 0) + 1;
    }
    sent.push(plain(receipt.receiptForDelivery(edited, session)));
    deckCases.push({ input, output: { receipt: composed, attached, sent } });
  }
});

// Receipts handed straight to `receiptForDelivery`, as the engine's frame receipt is: hand-written shapes and edge forms.
const deliveryInputs = [
  { slides: [{ slide: 9, presets: [], observe: { quadrantAir: [0.5, 0.5, 0.5, 0.5], contentAir: [0.5, 0.5, 0.5, 0.5], fills: [], fieldFill: [0.3] } }] },
  { slides: [{ slide: 1, charts: 0, chars: 40, grammar: 'beat', background: '', observe: { air: 0.6, contentAir: [1, 0, 1, 0], quadrantAir: [1, 0, 1, 0] } }], deck: { slides: 1, rhythm: { air: [0.6] }, pacing: { median: 1 } }, absent: [] },
  { slides: [], deck: { slides: 0 } },
  { slides: [{ observe: { air: 0.2 } }] },
  { note: 'no slides' },
  { slides: [{ slide: 3, tables: 0, textBoxes: 2, observe: { contentAir: [0, 1, 0, 1] } }], deck: null },
];
const deliveryCases = deliveryInputs.map((input) => {
  const session = {};
  const output = [input, input, { ...input, note: 'edited' }].map((one) => plain(receipt.receiptForDelivery(plain(one), session)));
  output.push(plain(receipt.receiptForDelivery(plain(input), undefined)));
  return { input: plain(input), output };
});

const golden = {
  note: 'Recorded from the Node composition receipt (pptx-receipt.mjs); tests/twin_receipt.rs replays it.',
  slides: slideCases,
  decks: deckCases,
  deliveries: deliveryCases,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-receipt', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: slides ${slideCases.length}, decks ${deckCases.length}, deliveries ${deliveryCases.length}`);
