import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

import { buildPptxFromMeasure, coverOffset, textPlacement } from './pptx-html-build.mjs';
import { htmlBriefScript } from './pptx-html-runner.mjs';
import { parseAuthoringBrief } from './pptx-brief.mjs';
import { isOrnamentalStripe } from '../quality/design-review-authored.mjs';
import { shapeParagraphs } from '../portable/portable-pptx-core.mjs';
import { measureTextBlock } from '../portable/text-metrics.mjs';

const ink = { hex: '14181F', a: 1 };
const style = (size, extra = {}) => ({
  font: 'Noto Sans KR',
  size,
  bold: false,
  italic: false,
  color: ink,
  ls: 0,
  hl: null,
  ...extra,
});

// A numbered disc as the browser draws it: 44 px circle, one 24 px digit centred, line-height 1.
const disc = {
  kind: 'text',
  box: { x: 700, y: 380, w: 44, h: 44 },
  inset: { l: 0, r: 0, t: 0, b: 0 },
  frame: {
    kind: 'rect',
    box: { x: 700, y: 380, w: 44, h: 44 },
    fill: { hex: 'FF6B3D', a: 1 },
    radius: 22,
    stroke: null,
    shadow: null,
  },
  align: 'center',
  lineHeight: 24,
  fontSize: 24,
  inkW: 14,
  lines: [{ top: 384, bottom: 419, width: 14, runs: [{ text: '2', style: style(24, { bold: true }) }] }],
};

// Two lines the browser broke at a word boundary, the second carrying a highlighted run.
const paragraph = {
  kind: 'text',
  box: { x: 96, y: 600, w: 560, h: 84 },
  inset: { l: 0, r: 0, t: 0, b: 0 },
  frame: null,
  align: 'left',
  lineHeight: 42,
  fontSize: 28,
  inkW: 540,
  lines: [
    { top: 604, bottom: 644, width: 540, runs: [{ text: '하네스만 바꿔 다시 돌렸다.', style: style(28) }] },
    {
      top: 646,
      bottom: 686,
      width: 300,
      runs: [
        { text: '결과는 같고 ', style: style(28) },
        { text: '비용은 줄었다', style: style(28, { hl: 'FFD9CC' }) },
      ],
    },
  ],
};

const cell = (text, y) => ({
  text,
  box: { x: 96, y, w: 400, h: 60 },
  font: 'Noto Sans KR',
  size: 28,
  bold: false,
  color: ink,
  fill: { hex: 'FFFFFF', a: 1 },
  align: 'left',
  pad: { t: 10, r: 10, b: 10, l: 10 },
  border: { t: null, r: null, b: { w: 1, c: 'C9CDD4' }, l: null },
  span: 1,
});

const measure = {
  width: 1920,
  height: 1080,
  slides: [
    {
      bg: { hex: 'F4F5F7', a: 1 },
      notes: 'speaker note',
      items: [
        {
          kind: 'rect',
          box: { x: 96, y: 200, w: 800, h: 300 },
          fill: { hex: 'FFFFFF', a: 1 },
          radius: 16,
          stroke: { hex: '14181F', a: 1, w: 2 },
          shadow: { color: ink, x: 12, y: 12, blur: 0 },
        },
        disc,
        paragraph,
        {
          kind: 'table',
          box: { x: 96, y: 720, w: 400, h: 180 },
          rows: [[cell('a', 720)], [cell('b', 780)], [cell('c', 840)]],
        },
      ],
    },
  ],
};

async function slideXml(output) {
  const zip = await JSZip.loadAsync(await readFile(output));
  return zip.file('ppt/slides/slide1.xml').async('string');
}

test('a centred disc keeps PowerPoint single pitch and the middle anchor, lowered to the browser centre', () => {
  const place = textPlacement(disc, 1920);
  assert.equal(place.valign, 'middle');
  assert.equal(place.spacing, 1);
  // PowerPoint centres a single line 0.09 em high; a top inset of twice that moves the middle down.
  assert.ok(Math.abs(place.inset.t - 2 * 0.09 * 24) < 1e-9, String(place.inset.t));
});

test('a top-anchored block is placed so PowerPoint first baseline lands on the browser one', () => {
  const place = textPlacement(paragraph, 1920);
  assert.equal(place.valign, 'top');
  // Browser baseline: glyph top 604 + 0.801 × 40. PowerPoint: (0.93 × 1.25 − 0.03) × 28 under the top.
  const expected = 604 + 0.801 * 40 - (0.93 * (42 / 33.6) - 0.03) * 28;
  assert.ok(Math.abs(place.y - expected) < 0.01, String(place.y));
  assert.ok(Math.abs(place.spacing - 42 / 33.6) < 1e-9);
});

test('a one-line band wider than its text keeps the browser alignment; a pill it fills centres', () => {
  const band = {
    ...disc,
    box: { x: 96, y: 840, w: 1728, h: 104 },
    inset: { l: 40, r: 40, t: 30, b: 30 },
    frame: { ...disc.frame, box: { x: 96, y: 840, w: 1728, h: 104 }, radius: 16 },
    align: 'left',
    lineHeight: 43.5,
    fontSize: 30,
    inkW: 1100,
    lines: [
      { top: 866, bottom: 910, width: 1100, runs: [{ text: '제약 고객의 이탈 시간이 가장 짧다.', style: style(30) }] },
    ],
  };
  assert.equal(textPlacement(band, 1920).centerAlign, false);
  assert.equal(textPlacement({ ...band, box: { ...band.box, w: 1180 } }, 1920).centerAlign, true);
});

test('a covered picture is cropped where object-position puts it', () => {
  assert.deepEqual(coverOffset('27% 50%', 1000, 200, 2), [270, 100]);
  assert.deepEqual(coverOffset('-40px 0px', 1000, 200, 2), [80, 0]);
  assert.deepEqual(coverOffset('', 1000, 200, 2), [500, 100]);
});

test('unframed text on its box middle is still placed by baseline, never middle-anchored', () => {
  const loose = { ...paragraph, box: { ...paragraph.box, y: 596, h: 94 } };
  assert.equal(textPlacement(loose, 1920).valign, 'top');
});

test('the measured deck becomes native shapes: disc, soft breaks, highlight, hard shadow, whole table', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-build-'));
  try {
    const output = join(dir, 'deck.pptx');
    await buildPptxFromMeasure(measure, output);
    const xml = await slideXml(output);
    assert.match(xml, /prst="ellipse"/);
    assert.match(xml, /anchor="ctr"/);
    assert.match(xml, /<a:br\/>/, 'the browser line break is written as a soft break');
    assert.match(xml, /<a:highlight><a:srgbClr val="FFD9CC"/);
    const blur = /<a:outerShdw[^>]*blurRad="(\d+)"/.exec(xml);
    assert.ok(blur && Number(blur[1]) < 12700, `hard shadow keeps a near-zero blur (${blur?.[1]})`);
    const frame = /<p:graphicFrame>[\s\S]*?<a:ext cx="\d+" cy="(\d+)"/.exec(xml);
    // Three 60 px rows = 180 px = 1.25 in = 1143000 EMU.
    assert.ok(frame && Math.abs(Number(frame[1]) - 1143000) < 2000, `table frame height ${frame?.[1]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('what runs past the page is cut at its edge, as the browser clips it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-bleed-'));
  try {
    const output = join(dir, 'deck.pptx');
    const band =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="260" viewBox="0 0 2000 260"><polygon points="0,202 2000,0 2000,57 0,260" fill="#C9CEF2"/></svg>';
    const items = [
      { kind: 'svg', box: { x: -40, y: 430, w: 2000, h: 260 }, markup: band, alt: 'band', alpha: 1 },
      {
        kind: 'rect',
        box: { x: 1800, y: -20, w: 200, h: 100 },
        fill: { hex: 'FF7A45', a: 1 },
        radius: 0,
        stroke: null,
        shadow: null,
      },
      { kind: 'line', seg: [-10, 900, 1950, 900], color: { hex: '161A33', a: 1 }, w: 2 },
    ];
    await buildPptxFromMeasure({ width: 1920, height: 1080, slides: [{ bg: null, items }] }, output);
    const xml = await slideXml(output);
    const drawn = xml.slice(xml.indexOf('</p:grpSpPr>'));
    const frames = [
      ...drawn.matchAll(/<a:xfrm[^>]*>\s*<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g),
    ].map((m) => m.slice(1).map(Number));
    assert.equal(frames.length, 3, xml);
    const [W, H] = [12192000, 6858000];
    for (const [x, y, cx, cy] of frames) {
      assert.ok(
        x >= 0 && y >= 0 && x + cx <= W + 2000 && y + cy <= H + 2000,
        `frame ${[x, y, cx, cy]} stays on the ${W}×${H} page`
      );
    }
    // The band keeps its page part: the full canvas width, placed at its own top.
    assert.ok(
      frames.some(([x, y, cx]) => x === 0 && Math.abs(cx - W) < 2000 && Math.abs(y - 430 * (W / 1920)) < 2000),
      JSON.stringify(frames)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chart spec pins the plot area and can hide the category axis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-chart-'));
  try {
    const output = join(dir, 'deck.pptx');
    const chart = {
      kind: 'chart',
      box: { x: 96, y: 500, w: 1728, h: 420 },
      spec: {
        type: 'col',
        labels: ['a', 'b'],
        values: [1, 2],
        plot: { x: 0, y: 0.1, w: 1, h: 0.8 },
        categoryAxis: false,
      },
    };
    await buildPptxFromMeasure({ width: 1920, height: 1080, slides: [{ bg: null, items: [chart] }] }, output);
    const zip = await JSZip.loadAsync(await readFile(output));
    const part = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const xml = await zip.file(part).async('string');
    assert.match(xml, /<c:layoutTarget val="inner" \/>[\s\S]*<c:y val="0.1" \/>[\s\S]*<c:h val="0.8" \/>/);
    assert.match(xml, /<c:catAx>[\s\S]*?<c:delete val="1"\/>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chart takes the measured element font before the Noto Sans KR fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-html-chart-font-'));
  try {
    const faceOf = async (item, name) => {
      const output = join(dir, name);
      const chart = { kind: 'chart', box: { x: 96, y: 500, w: 1728, h: 420 }, spec: { type: 'col', labels: ['a'], values: [1] }, ...item };
      await buildPptxFromMeasure({ width: 1920, height: 1080, slides: [{ bg: null, items: [chart] }] }, output);
      const zip = await JSZip.loadAsync(await readFile(output));
      const part = Object.keys(zip.files).find((file) => /^ppt\/charts\/chart\d+\.xml$/.test(file));
      return (await zip.file(part).async('string')).match(/<a:latin typeface="([^"]+)"/)?.[1];
    };
    assert.equal(await faceOf({ font: 'Georgia' }, 'measured.pptx'), 'Georgia');
    assert.equal(await faceOf({}, 'fallback.pptx'), 'Noto Sans KR');
    assert.equal(await faceOf({ font: 'Georgia', spec: { type: 'col', labels: ['a'], values: [1], font: 'Arial' } }, 'spec.pptx'), 'Arial');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an HTML brief comment reads as the script brief', () => {
  const html = `<!doctype html><!-- BRIEF
facts: sample — illustrative numbers
slide plan: 1 job: cover · move: know the deck · carriers: statement
  · 2 job: evidence · move: see the gap · carriers: chart
-->
<section class="slide"></section>`;
  const brief = parseAuthoringBrief(htmlBriefScript(html));
  assert.equal(brief.present, true);
  assert.equal(brief.factsMode, 'sample');
  assert.deepEqual(
    brief.plan.map((entry) => [entry.slide, entry.carriers]),
    [
      [1, ['statement']],
      [2, ['chart']],
    ]
  );
  assert.equal(htmlBriefScript('<section class="slide"></section>'), '');
});

test('the portable measure breaks a soft break where PowerPoint does, each line at its own size', () => {
  const shape = `<p:sp><p:txBody><a:bodyPr/><a:p><a:pPr><a:lnSpc><a:spcPct val="108333"/></a:lnSpc></a:pPr>
    <a:r><a:rPr lang="ko-KR" sz="1400" b="1"><a:latin typeface="Noto Sans KR"/></a:rPr><a:t>GPT-5.6 Sol</a:t></a:r><a:br/>
    <a:r><a:rPr lang="ko-KR" sz="1000"><a:latin typeface="Noto Sans KR"/></a:rPr><a:t>Codex CLI 대비</a:t></a:r></a:p></p:txBody></p:sp>`;
  const [paragraph] = shapeParagraphs(shape);
  assert.equal(paragraph.text, 'GPT-5.6 Sol\nCodex CLI 대비');
  const measured = measureTextBlock([paragraph], { width: 115 });
  assert.equal(measured.lines, 2);
  // 14 pt and 10 pt lines at 1.2 em × 1.083: about 31 pt, not three 14 pt lines.
  assert.ok(measured.height < 36.4, String(measured.height));
});

test('a header rule the running chrome sits on is page chrome, a bare edge bar is ornament', () => {
  const size = { width: 960, height: 540 };
  const rule = { type: 9, text: '', left: 48, top: 42, width: 864, height: 0 };
  const chrome = { type: 1, text: 'Mixdog 소개', left: 48, top: 21.5, width: 67, height: 13, font: { size: 10 } };
  assert.equal(isOrnamentalStripe(rule, [rule, chrome], size), false);
  assert.equal(isOrnamentalStripe(rule, [rule], size), true);
  const bar = { type: 1, text: '', left: 0, top: 0, width: 960, height: 6 };
  assert.equal(isOrnamentalStripe(bar, [bar, chrome], size), true);
});
