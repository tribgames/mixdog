// The `author` action's HTML input: lay the deck out in a local browser, read
// it back, write native PowerPoint objects, and keep the browser's page images
// so the review can hold the PPTX render against what the HTML intended.
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

import { HTML_CANVAS, measureHtmlDeck } from './pptx-html-measure.mjs';
import { noteOfficeWrite } from '../core/office-write-ledger.mjs';
import { buildPptxFromMeasure } from './pptx-html-build.mjs';
import { normalizeAuthoredPptx } from './pptx-script-normalize.mjs';

const require = createRequire(import.meta.url);

/** Artifacts kept beside the deck: the HTML source and the browser's page images. */
export function htmlArtifacts(target) {
  return {
    source: `${target}.mixdog-source.html`,
    shot: (page) => `${target}.mixdog-html-page-${page}.png`,
    compare: (page) => `${target}.mixdog-compare-page-${page}.png`,
  };
}

// The brief of an HTML deck is an HTML comment that opens with BRIEF, written with the same keys as a
// script's `// key: value` lines. It is handed to the brief parser in the script's own form.
export function htmlBriefScript(html) {
  const match = /<!--\s*BRIEF\b([\s\S]*?)-->/.exec(String(html || ''));
  if (!match) return '';
  const lines = match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/\s*)?/, ''))
    .filter((line) => line.trim());
  return ['// BRIEF', ...lines.map((line) => `// ${line}`)].join('\n');
}

function failure(error, startedAt) {
  return {
    ok: false,
    error: { message: error?.message || String(error), line: null, excerpt: '' },
    logs: [],
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

/** Whether the HTML is written as pages under the deck contract: one <section class="slide"> per page. */
export function hasSlideSections(html) {
  return /<section[^>]*class=["'][^"']*\bslide\b/i.test(String(html || ''));
}

/**
 * @param {{ target: string, signal?: AbortSignal, prepare?: (page: object) => Promise<object> }} options
 *   prepare: names the canvas on the loaded page (pptx-html-measure.mjs); the deck's 1920 × 1080 without it
 */
export async function runPptxHtmlAuthoring(html, output, { target, signal = null, prepare = null }) {
  const source = String(html || '');
  if (!hasSlideSections(source)) {
    throw new Error('author html requires <section class="slide"> pages; see the pptx skill html reference.');
  }
  const startedAt = performance.now();
  const artifacts = htmlArtifacts(target);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  let measure;
  try {
    measure = await measureHtmlDeck(source, {
      sourcePath: artifacts.source,
      shotPath: artifacts.shot,
      signal,
      prepare,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return failure(error, startedAt);
  }
  try {
    await buildPptxFromMeasure(measure, output);
  } catch (error) {
    return failure(error, startedAt);
  }
  const normalized = await normalizeAuthoredPptx(output);
  const info = await stat(output);
  return {
    ok: true,
    output,
    bytes: info.size,
    logs: measure.notes.map((text) => ({ level: 'warn', text })),
    kit: 'html',
    slideCount: measure.slides.length,
    normalizedParagraphs: normalized.removed,
    htmlShots: measure.shots,
    htmlText: measure.slides.map((slide) => {
      // The browser draws no chart, so a non-text item over one would read the PPTX bars as its own ink.
      const charts = slide.items.filter((item) => item.kind === 'chart').map((item) => item.box);
      const overChart = (b) =>
        charts.some((c) => b.x < c.x + c.w && c.x < b.x + b.w && b.y < c.y + c.h && c.y < b.y + b.h);
      return slide.items.map(driftTarget).filter((target) => target && (target.align !== 'box' || !overChart(target)));
    }),
    htmlSource: artifacts.source,
    geometry: measure.geometry,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

// Where a text item's glyphs are on the HTML canvas: its lines' span across the box's content area, so a
// framed item is read inside its own fill rather than as the whole frame.
const DRIFT_LABEL = { image: 'picture', svg: 'svg', capture: 'decoration', rect: 'box' };

function driftTarget(item) {
  if (item.kind !== 'text') {
    // A picture, drawing, captured decoration or filled box is read by its whole painted extent; one the
    // size of the page has no surround to read against, and the browser draws no chart.
    const b = item.kind === 'capture' ? item.draw : item.box;
    if (!DRIFT_LABEL[item.kind] || !b || b.w < 8 || b.h < 8 || (b.w >= 1900 && b.h >= 1060)) return null;
    if (item.kind === 'rect' && !item.fill && !item.stroke) return null;
    const name = item.alt ? `${DRIFT_LABEL[item.kind]} ${item.alt}` : DRIFT_LABEL[item.kind];
    // A box's outline is its most distinct colour (a white disc ringed in navy on white paper); else its fill.
    const solidFill = item.fill && item.fill.a > 0.9 ? item.fill.hex : null;
    const ink = item.kind === 'rect' ? item.stroke?.hex || solidFill : null;
    return {
      text: name.length > 24 ? `${name.slice(0, 24)}…` : name,
      align: 'box',
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      pad: 3,
      ink,
    };
  }
  // The glyph boxes of tight display type reach past the element into its neighbours; the element's own
  // content box bounds the read so a neighbour's ink is never taken for this item's.
  const glyphTop = item.lines[0].top;
  const glyphBottom = item.lines[item.lines.length - 1].bottom;
  const boxTop = item.box.y + item.inset.t;
  const boxBottom = item.box.y + item.box.h - item.inset.b;
  const clipped = Math.min(glyphBottom, boxBottom) > Math.max(glyphTop, boxTop);
  const top = clipped ? Math.max(glyphTop, boxTop) : glyphTop;
  const bottom = clipped ? Math.min(glyphBottom, boxBottom) : glyphBottom;
  const text = item.lines.map((line) => line.runs.map((run) => run.text).join('')).join(' ');
  const x = item.box.x + item.inset.l;
  const w = Math.max(1, item.box.w - item.inset.l - item.inset.r);
  const pad = item.frame ? Math.max(0, Math.min(3, item.inset.l, item.inset.r, item.inset.t, item.inset.b)) : 3;
  const ink = item.lines[0]?.runs[0]?.style.color?.hex;
  return {
    text: text.length > 24 ? `${text.slice(0, 24)}…` : text,
    align: item.align,
    x,
    y: top,
    w,
    h: bottom - top,
    pad,
    ink,
  };
}

async function canvasPixels(sharp, path) {
  const { data, info } = await sharp(path)
    .resize(HTML_CANVAS.width, HTML_CANVAS.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// The ink inside a region: pixels that differ from the colour most common on its border.
function inkBounds(image, region, pad = region.pad ?? 3) {
  const x0 = Math.max(0, Math.floor(region.x - pad));
  const y0 = Math.max(0, Math.floor(region.y - pad));
  const x1 = Math.min(image.width - 1, Math.ceil(region.x + region.w + pad));
  const y1 = Math.min(image.height - 1, Math.ceil(region.y + region.h + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  const at = (x, y) => (y * image.width + x) * 3;
  const counts = new Map();
  const count = (x, y) => {
    const i = at(x, y);
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = x0; x <= x1; x += 1) {
    count(x, y0);
    count(x, y1);
  }
  for (let y = y0; y <= y1; y += 1) {
    count(x0, y);
    count(x1, y);
  }
  const [bg, bgCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // A drawn item on a surround that is not one colour (a band, a gradient, a picture) has no edge to read.
  const border = 2 * (x1 - x0 + 1) + 2 * (y1 - y0 + 1);
  if (region.align === 'box' && bgCount / border < 0.6) return null;
  const [r0, g0, b0] = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
  // With the text colour known, ink is what stands nearer to it than half the background's distance, so a
  // gradient or picture behind the words is never read as ink; otherwise, what departs from the background.
  const inkRgb = region.ink ? [0, 2, 4].map((k) => parseInt(region.ink.slice(k, k + 2), 16)) : null;
  const dist = (i, [cr, cg, cb]) =>
    Math.abs(image.data[i] - cr) + Math.abs(image.data[i + 1] - cg) + Math.abs(image.data[i + 2] - cb);
  const bgToInk = inkRgb ? Math.abs(r0 - inkRgb[0]) + Math.abs(g0 - inkRgb[1]) + Math.abs(b0 - inkRgb[2]) : 0;
  // A box's fill may sit close to the page (a white panel on paper); its known colour still separates it.
  const known = inkRgb && bgToInk > (region.align === 'box' ? 12 : 90);
  // A drawn item's pale tints are its extent too, so its departure threshold is lower than a glyph's; not so
  // low that a neighbour's soft shadow reads as the item.
  const departure = region.align === 'box' ? 60 : 90;
  const isInk = known ? (i) => dist(i, inkRgb) < bgToInk / 2 : (i) => dist(i, [r0, g0, b0]) > departure;
  let l = Infinity,
    t = Infinity,
    r = -1,
    b = -1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = at(x, y);
      if (isInk(i)) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { l, t, r, b };
}

const HTML_DRIFT_PX = 3;

// A drawn item counts only when both of its edges moved: together is a move, apart is a resize.
// One edge alone is the reading of a faint edge, not the item.
function axisDrift(lo, hi) {
  if (Math.abs(lo) <= 1 || Math.abs(hi) <= 1) return { move: 0, grow: 0 };
  return Math.sign(lo) === Math.sign(hi)
    ? { move: Math.sign(lo) * Math.min(Math.abs(lo), Math.abs(hi)), grow: 0 }
    : { move: 0, grow: hi - lo };
}

// How a drawn item's ink bounds moved between two renders, or null when it stayed within the threshold.
function boxDrift(a, b, text, threshold) {
  const x = axisDrift(b.l - a.l, b.r - a.r);
  const y = axisDrift(b.t - a.t, b.b - a.b);
  if (![x.move, y.move, x.grow, y.grow].some((v) => Math.abs(v) > threshold)) return null;
  return {
    text,
    dx: x.move,
    dy: y.move,
    ...(x.grow ? { dw: x.grow } : {}),
    ...(y.grow ? { dh: y.grow } : {}),
  };
}

/**
 * How far each item moved between the HTML and PowerPoint's render, in px of the HTML canvas: vertically
 * the mean of the top and bottom ink edges (a size change is not a move); horizontally the edge a text is
 * aligned to, or the mean of both edges for a picture, drawing, decoration or box. Only single-page render
 * images can be read.
 */
export async function measureHtmlDrift(htmlShots, htmlText, renderedImages, threshold = HTML_DRIFT_PX) {
  const sharp = require('sharp');
  const pages = [];
  const skipped = [];
  for (const image of renderedImages || []) {
    const covered = image.pages || [image.page];
    if (covered.length !== 1) {
      skipped.push(...covered);
      continue;
    }
    const targets = htmlText?.[image.page - 1];
    const shot = htmlShots?.[image.page - 1];
    if (!targets?.length || !shot || !image.path) continue;
    const html = await canvasPixels(sharp, shot);
    const pptx = await canvasPixels(sharp, image.path);
    const moved = [];
    for (const target of targets) {
      const a = inkBounds(html, target);
      const b = inkBounds(pptx, target);
      if (!a || !b) continue;
      if (target.align === 'box') {
        const drift = boxDrift(a, b, target.text, threshold);
        if (drift) moved.push(drift);
        continue;
      }
      const dy = Math.round((b.t - a.t + (b.b - a.b)) / 2);
      let dx = b.l - a.l;
      if (target.align === 'center') dx = Math.round((b.l - a.l + (b.r - a.r)) / 2);
      else if (target.align === 'right') dx = b.r - a.r;
      if (Math.abs(dy) > threshold || Math.abs(dx) > threshold) moved.push({ text: target.text, dx, dy });
    }
    if (moved.length)
      pages.push({
        page: image.page,
        items: moved.sort(
          (p, q) => Math.max(Math.abs(q.dy), Math.abs(q.dx)) - Math.max(Math.abs(p.dy), Math.abs(p.dx))
        ),
      });
  }
  return {
    code: 'html_render_drift',
    threshold,
    unit: 'px on the 1920 × 1080 HTML canvas',
    pages,
    ...(skipped.length ? { unreadPages: skipped } : {}),
  };
}

// One image per page: the HTML the author wrote on the left, the PPTX PowerPoint drew on the right.
export async function writeHtmlComparisons(target, htmlShots, renderedImages) {
  const sharp = require('sharp');
  const artifacts = htmlArtifacts(target);
  const width = 960;
  const height = 540;
  const gap = 16;
  const pairs = [];
  for (const image of renderedImages || []) {
    if ((image.pages?.length || 1) !== 1) continue;
    const html = htmlShots[image.page - 1];
    if (!html || !image.path) continue;
    const left = await sharp(html).resize(width, height, { fit: 'fill' }).png().toBuffer();
    const right = await sharp(image.path).resize(width, height, { fit: 'fill' }).png().toBuffer();
    const path = artifacts.compare(image.page);
    noteOfficeWrite(path);
    await sharp({ create: { width: width * 2 + gap, height, channels: 3, background: '#808080' } })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: width + gap, top: 0 },
      ])
      .png()
      .toFile(path);
    pairs.push({ page: image.page, path });
  }
  return pairs;
}
