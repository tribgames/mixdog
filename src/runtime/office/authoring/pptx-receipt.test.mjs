import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRenderedAir, compositionReceipt, slideReceipt } from './pptx-receipt.mjs';
import { parseAuthoringBrief } from './pptx-brief.mjs';

const DOCUMENT = { slides: [
  { index: 1, background: { color: '0F1B26' }, shapes: [
    { text: 'Cover title', font: { size: 47 }, width: 600, height: 120 },
    { text: '01', font: { size: 240 }, width: 400, height: 300 },
  ] },
  { index: 2, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, width: 800, height: 60 },
    { chart: { path: '/slide[2]/shape[2]/chart' }, width: 600, height: 320 },
    { geometry: 'rect', fill: { color: 'DCEBEC' }, width: 870, height: 50 },
    { text: 'Takeaway', font: { size: 22 }, width: 850, height: 50 },
  ] },
  { index: 3, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, width: 800, height: 60 },
    { geometry: 'chevron', fill: { color: 'E9EFF3' }, width: 200, height: 80 },
    { geometry: 'chevron', fill: { color: '0E7C86' }, width: 200, height: 80 },
    { geometry: 'line', width: 300, height: 0 },
    { text: 'detail', font: { size: 13 }, width: 200, height: 80 },
  ] },
  { index: 4, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, width: 800, height: 60 },
    { text: 'a paragraph', font: { size: 18 }, width: 800, height: 200 },
  ] },
] };

test('a slide receipt counts what the saved slide carries and names its preset contours', () => {
  const cover = slideReceipt(DOCUMENT.slides[0]);
  assert.equal(cover.background, 'dark');
  assert.equal(cover.largestText, 240);
  const process = slideReceipt(DOCUMENT.slides[2]);
  assert.deepEqual(process.presets, ['chevron']);
  assert.equal(process.drawn, 3);
  assert.equal(process.lines, 1);
  assert.equal(process.textBoxes, 2);
  const evidence = slideReceipt(DOCUMENT.slides[1]);
  assert.equal(evidence.charts, 1);
  assert.equal(evidence.fields, 1);
  assert.ok(evidence.coverage > 0.3 && evidence.coverage <= 1);
});

// The kit signs its spec carriers by name; the receipt reads them back per slide and across the deck, and a carrier
// whose type size or face changed between slides shows as a second anatomy — information, not a verdict.
test('a receipt reads spec carriers from their signatures and shows a second anatomy when one drifted', () => {
  const document = { slides: [
    { index: 1, background: { color: 'F7F9FB' }, shapes: [
      { text: '채택', name: 'mixdog-spec:badge:positive', font: { size: 11, name: 'Noto Sans KR' }, width: 90, height: 24 },
      { text: '보류', name: 'mixdog-spec:badge:warning', font: { size: 11, name: 'Noto Sans KR' }, width: 90, height: 24 },
      { text: '31', name: 'mixdog-spec:stat:band', font: { size: 49, name: 'Arial' }, width: 200, height: 80 },
      { table: { path: '/slide[1]/shape[4]/table' }, name: 'mixdog-spec:table:toned', width: 600, height: 200 },
      { text: 'plain box', font: { size: 18 }, width: 300, height: 60 },
    ] },
    { index: 2, background: { color: 'F7F9FB' }, shapes: [
      { text: '기각', name: 'mixdog-spec:badge:critical', font: { size: 14, name: 'Noto Sans KR' }, width: 90, height: 24 },
      { text: '주의', name: 'mixdog-spec:callout:warning', font: { size: 14, name: 'Noto Sans KR' }, width: 300, height: 60 },
    ] },
  ] };
  const first = slideReceipt(document.slides[0]);
  assert.deepEqual(first.specs.badge, { count: 2, variants: ['positive', 'warning'], anatomies: ['11|Noto Sans KR'] });
  assert.deepEqual(first.specs.stat, { count: 1, variants: ['band'], anatomies: ['49|Arial'] });
  assert.deepEqual(first.specs.table, { count: 1, variants: ['toned'], anatomies: [] });
  assert.equal(slideReceipt(document.slides[1]).specs.callout.count, 1);
  assert.equal(slideReceipt({ index: 3, shapes: [{ text: 'no signature', font: { size: 18 }, width: 10, height: 10 }] }).specs, undefined, 'a slide without carriers carries no specs key');
  const { deck } = compositionReceipt(document);
  assert.deepEqual(deck.specs.badge, { count: 3, slides: 2, variants: ['positive', 'warning', 'critical'], anatomies: ['11|Noto Sans KR', '14|Noto Sans KR'] }, 'the badge on slide 2 drifted to 14 pt: two anatomies');
  assert.equal(deck.specs.callout.slides, 1);
});

test('a slide receipt observes air, quadrants, the largest object, text columns, and fills from shape footprints', () => {
  const slide = { index: 5, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, left: 43, top: 72, width: 600, height: 60 },
    { geometry: 'rect', fill: { color: '0E7C86' }, left: 0, top: 0, width: 480, height: 540 },
    { text: 'body', font: { size: 18 }, left: 43, top: 200, width: 400, height: 100 },
    { text: 'stray', font: { size: 18 }, left: 700, top: 300, width: 200, height: 60 },
    { chart: { path: '/slide[5]/shape[5]/chart' }, left: 500, top: 100, width: 400, height: 150 },
  ] };
  const receipt = slideReceipt(slide);
  const o = receipt.observe;
  assert.ok(o.air > 0.3 && o.air < 0.6, `air ${o.air}`);
  assert.equal(o.quadrantAir[0], 0, 'the dark field fills the top-left quadrant');
  assert.equal(o.quadrantAir[2], 0, 'and the bottom-left');
  assert.ok(o.quadrantAir[3] > 0.7, `bottom-right is mostly air: ${o.quadrantAir[3]}`);
  assert.equal(o.largestShare, 0.5);
  assert.ok(o.visualShare > 0.55 && o.visualShare < 0.65, `field + chart footprint ${o.visualShare}`);
  assert.equal(o.presence, 0.12, 'presence is the chart (400 × 150 of 960 × 540), never the field or a text box');
  const diagram = slideReceipt({ index: 9, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, left: 43, top: 72, width: 600, height: 60 },
    { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 100, top: 200, width: 30, height: 30 },
    { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 700, top: 200, width: 30, height: 30 },
    { geometry: 'line', left: 130, top: 215, width: 570, height: 0 },
    { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 400, top: 460, width: 30, height: 30 },
  ] });
  assert.equal(diagram.observe.presence, 0.35, 'three contours and a connector read as one construction by their extent (630 × 290)');
  assert.deepEqual(o.textColumns, { columns: 2, stray: 1, rightEdges: 3, rightStray: 3, labels: 0 });
  assert.deepEqual(o.fills, [{ color: '0E7C86', share: 0.5 }]);
  assert.equal(o.largestTextTop, 1);
  assert.equal(o.bodyTop, 2.78, 'the body starts at the first box under the title (the body text at 200 pt)');
  assert.ok(o.centroid[0] < 0.5, `the dark left field pulls the centroid left: ${o.centroid}`);
  assert.ok(o.centroidOffset > 1, `and past the horizontal tolerance: ${o.centroidOffset}`);
  const centered = slideReceipt({ index: 7, background: { color: 'F7F9FB' }, shapes: [
    { geometry: 'rect', fill: { color: 'F7F9FB' }, left: 0, top: 0, width: 960, height: 540 },   // a canvas-wide surface does not count
    { text: 'claim', font: { size: 40 }, left: 280, top: 220, width: 400, height: 100 },
  ] });
  assert.deepEqual(centered.observe.centroid, [0.5, 0.5]);
  assert.equal(centered.observe.centroidOffset, 0);
  const com = slideReceipt({ index: 6, background: { color: '0F1B26' }, shapes: [
    { text: 'no fill textbox', font: { size: 18 }, left: 40, top: 40, width: 300, height: 60, fillColor: 16777215, fillVisible: false },
    { geometry: 'rect', left: 480, top: 0, width: 480, height: 540, fillColor: 8813582, fillVisible: true },   // BGR long 0x860E7C... = 14 + 124·256 + 134·65536 → 0E7C86
  ] });
  assert.deepEqual(com.observe.fills, [{ color: '0E7C86', share: 0.5 }], 'a COM fill is read from its BGR long; an invisible fill is not a surface');
  const positionless = slideReceipt(DOCUMENT.slides[0]);
  assert.equal(positionless.observe, undefined, 'no footprint, no observation');
});

test('a slide receipt reads the spacing vocabulary, ragged right edges, the type sizes, and the text colors', () => {
  const slide = { index: 8, background: { color: 'F7F9FB' }, shapes: [
    { text: 'Title', font: { size: 36 }, sizes: [36], colors: ['1A2B3C'], left: 43, top: 72, width: 600, height: 60 },       // right edge 643
    { text: 'prose', font: { size: 18 }, sizes: [18, 18], colors: ['33475B', 'B04A2A'], left: 43, top: 164.4, width: 560, height: 100 },   // gap 32.4 pt = 0.45 in; right edge 603
    { text: 'caption', font: { size: 12 }, sizes: [12], colors: ['6B7A8A'], left: 43, top: 273, width: 560, height: 20 },   // gap 8.6 pt ≈ 0.12 in
    { geometry: 'rect', fill: { color: '0E7C86' }, left: 700, top: 100, width: 200, height: 300 },
    { text: 'on field', font: { size: 18, color: 16777215 }, left: 720, top: 120, width: 160, height: 40 },   // COM font color BGR long → FFFFFF
  ] };
  const o = slideReceipt(slide).observe;
  assert.deepEqual(o.gaps, [0.1, 0.45], 'two spacing steps read as two values');
  assert.deepEqual(o.textColumns, { columns: 2, stray: 1, rightEdges: 3, rightStray: 2, labels: 0 }, 'title, prose, and caption share a left edge; prose and caption share a right edge, the title is 0.55 in wider (ragged right)');
  assert.deepEqual(o.typeSet, [12, 18, 36]);
  assert.deepEqual(o.textColors, ['1A2B3C', '33475B', 'B04A2A', '6B7A8A', 'FFFFFF'], 'the field\'s own surface color is not a text color; the COM long decodes to white');
  const deck = compositionReceipt({ slides: [slide, { ...slide, index: 9, shapes: slide.shapes.slice(0, 2) }] });
  assert.deepEqual(deck.deck.rhythm.gapSet, [0.1, 0.45]);
  assert.deepEqual(deck.deck.rhythm.typeSet, [12, 18, 36]);
  assert.equal(deck.deck.rhythm.textColors.length, 5);
  assert.deepEqual(deck.deck.rhythm.rightStray, [2, 2]);
});

test('a tinted plane that holds two lines reads as an empty plane, where footprint air cannot', () => {
  const shapes = [
    { text: 'Title', font: { size: 36 }, left: 43, top: 72, width: 400, height: 60 },
    { geometry: 'rect', fill: { color: 'E7EBEE' }, left: 480, top: 160, width: 480, height: 380 },   // the plane, bottom-right
    { text: 'two lines on the plane', font: { size: 14 }, left: 510, top: 180, width: 400, height: 50 },
    { chart: { path: '/slide[11]/shape[4]/chart' }, left: 43, top: 160, width: 400, height: 360 },
  ];
  const hollow = slideReceipt({ index: 11, background: { color: 'F7F9FB' }, shapes }).observe;
  assert.equal(hollow.quadrantAir[3], 0, 'the plane covers the bottom-right quadrant');
  assert.ok(hollow.contentAir[3] > 0.9, `while nothing is in it: ${hollow.contentAir[3]}`);
  assert.ok(hollow.fieldFill[0] < 0.2, `and the plane carries almost none of itself: ${hollow.fieldFill}`);
  const filled = slideReceipt({ index: 12, background: { color: 'F7F9FB' }, shapes: [...shapes,
    { text: 'the rest of the column', font: { size: 14 }, left: 510, top: 260, width: 400, height: 260 }] }).observe;
  assert.ok(filled.fieldFill[0] > 0.6, `content that owns the plane reads high: ${filled.fieldFill}`);
  assert.ok(filled.contentAir[3] < 0.5, `and the quadrant carries content: ${filled.contentAir[3]}`);
  const deck = compositionReceipt({ slides: [{ index: 11, shapes }] });
  assert.deepEqual(deck.deck.rhythm.fieldFills, [hollow.fieldFill[0]], 'the deck rhythm lists the emptiest plane per slide');
});

test('the deck receipt totals the families, lists the absent ones, and marks contradicted plan lines', () => {
  const brief = parseAuthoringBrief(`
// BRIEF
// slide plan: 1 job: cover · carriers: statement · 2 job: evidence · carriers: chart · 3 job: process · carriers: diagram · 4 job: evidence · carriers: chart, table
`);
  const receipt = compositionReceipt(DOCUMENT, brief);
  assert.equal(receipt.deck.slides, 4);
  assert.equal(receipt.deck.charts, 1);
  assert.equal(receipt.deck.presets, 1);
  assert.equal(receipt.deck.textOnly, 2, 'the cover (type only) and the paragraph slide are text-only; the receipt reports, the author decides');
  assert.deepEqual(receipt.deck.backgrounds, ['dark', 'light']);
  assert.deepEqual(receipt.absent, ['tables', 'pictures']);
  assert.equal(receipt.slides[1].missing, undefined);
  assert.deepEqual(receipt.slides[3].missing, ['chart', 'table']);
});

test('rendered air joins the receipt per slide and in the deck rhythm', () => {
  const receipt = compositionReceipt({ slides: [
    { index: 1, shapes: [{ text: 'a', font: { size: 30 }, left: 40, top: 40, width: 300, height: 60 }] },
    { index: 2, shapes: [{ text: 'b', font: { size: 30 }, left: 40, top: 40, width: 300, height: 60 }] },
  ] });
  attachRenderedAir(receipt, new Map([[1, 0.71]]));
  assert.equal(receipt.slides[0].observe.renderAir, 0.71);
  assert.equal(receipt.slides[1].observe.renderAir, undefined);
  assert.deepEqual(receipt.deck.rhythm.renderAir, [0.71, null]);
  assert.deepEqual(receipt.deck.rhythm.centroidX.length, 2);
});

test('a receipt without a brief still reports the deck and never throws on an empty document', () => {
  const receipt = compositionReceipt({ slides: [] });
  assert.equal(receipt.deck.slides, 0);
  assert.deepEqual(receipt.slides, []);
  assert.ok(receipt.absent.length);
});

test('diagram labels bound to a contour or connector leave the column and gap readings and are counted', () => {
  const shapes = [
    { text: 'Title', font: { size: 36 }, left: 43, top: 72, width: 600, height: 60 },
    { text: 'a paragraph under the title', font: { size: 18 }, left: 43, top: 164.4, width: 560, height: 100 },   // gap 0.45 in under the title
    { geometry: 'line', left: 100, top: 305, width: 300, height: 0 },
    { text: 'L2', font: { size: 11 }, left: 100, top: 280, width: 40, height: 20 },       // an axis tick 5 pt above its hairline
    { geometry: 'ellipse', fill: { color: '0E7C86' }, left: 700, top: 200, width: 14, height: 14 },
    { text: 'node', font: { size: 11 }, left: 720, top: 196, width: 60, height: 20 },     // a node label 6 pt from its dot
    { text: 'a caption far from any device', font: { size: 12 }, left: 43, top: 400, width: 560, height: 20 },
  ];
  const o = slideReceipt({ index: 13, background: { color: 'F7F9FB' }, shapes }).observe;
  assert.deepEqual(o.textColumns, { columns: 1, stray: 0, rightEdges: 2, rightStray: 1, labels: 2 }, 'the tick and the node label are parts of their device; title, paragraph, and caption form the page\'s column');
  assert.deepEqual(o.gaps, [0.45], 'the step from the paragraph down to the tick is a device gap, not a spacing step of the page');
});
