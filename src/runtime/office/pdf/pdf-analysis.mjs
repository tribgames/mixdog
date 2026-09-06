import { createRequire } from 'node:module';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  DOMMatrix,
  ImageData,
  Path2D,
} from '@napi-rs/canvas';
import {
  PDFDocument,
  rgb,
} from 'pdf-lib';
import sharp from 'sharp';
import { resolvedPdfJs } from '../../attachments/pdfjs-runtime.mjs';
import { embedDocumentFont, fontCovers } from './pdf-fonts.mjs';
import { renderPdfPages } from './pdf-render.mjs';

const require = createRequire(import.meta.url);
const MAX_QUERY_PAGES = 100;

function installPdfGlobals() {
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  globalThis.Path2D ??= Path2D;
}

function selectedPages(total, pages) {
  const values = Array.isArray(pages) && pages.length
    ? [...new Set(pages.map(Number))]
    : Array.from({ length: total }, (_, index) => index + 1);
  if (values.length > MAX_QUERY_PAGES) throw new Error(`PDF analysis accepts at most ${MAX_QUERY_PAGES} pages per call`);
  for (const page of values) {
    if (!Number.isInteger(page) || page < 1 || page > total) throw new Error(`PDF page out of range: ${page}`);
  }
  return values;
}

// A path reads the file; bytes let a batch measure the document it is editing
// before anything reaches the disk.
async function openPdfJs(source) {
  installPdfGlobals();
  const pdfjs = await resolvedPdfJs();
  const bytes = typeof source === 'string' ? await readFile(source) : source;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  return { pdfjs, document: await loading.promise };
}

const MAX_SHAPES_PER_PAGE = 2000;
const round2 = (value) => Number(Number(value).toFixed(2));
const near = (left, right, tolerance = 0.5) => Math.abs(left - right) <= tolerance;
// pdf.js's own applyTransform mutates its argument in place, so map points here.
const applyPoint = ([x, y], m) => [(x * m[0]) + (y * m[2]) + m[4], (x * m[1]) + (y * m[3]) + m[5]];

// pdf.js packs a path as codes with their coordinates: 0 moveTo (x y),
// 1 lineTo (x y), 2 curveTo (six numbers), 3 quadraticCurveTo (four), 4 closePath.
function pathSubpaths(data) {
  const subpaths = [];
  let current = null;
  let k = 0;
  while (k < data.length) {
    const code = data[k++];
    if (code === 0) {
      current = { points: [[data[k], data[k + 1]]], curved: false };
      subpaths.push(current);
      k += 2;
    } else if (code === 1) {
      current?.points.push([data[k], data[k + 1]]);
      k += 2;
    } else if (code === 2 || code === 3) {
      const span = code === 2 ? 6 : 4;
      if (current) {
        current.points.push([data[k + span - 2], data[k + span - 1]]);
        current.curved = true;
      }
      k += span;
    } else if (code !== 4) {
      break;
    }
  }
  return subpaths;
}

// Rules and boxes are what a form without fields is made of: the horizontal
// line under a label is where the answer goes, and a small square is a
// checkbox. Coordinates share the text items' top-left origin.
async function pageShapes(pdfjs, page, viewport) {
  const { OPS, Util } = pdfjs;
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const operators = await page.getOperatorList();
  const lines = [];
  const boxes = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index] || [];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, Array.from(args));
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[0]) ctm = Util.transform(ctm, Array.from(args[0]));
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const [paintOp, [data]] = args;
      const filled = fillOps.has(paintOp);
      const stroked = strokeOps.has(paintOp);
      if (!data?.length || (!filled && !stroked)) continue;
      const full = Util.transform(viewport.transform, ctm);
      for (const subpath of pathSubpaths(data)) {
        if (subpath.curved) continue;
        const points = subpath.points.map((point) => applyPoint(point, full));
        const xs = points.map((point) => point[0]);
        const ys = points.map((point) => point[1]);
        const x = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - top;
        if (points.length === 2) {
          if (stroked && (near(height, 0, 1) || near(width, 0, 1))) {
            lines.push({ x1: round2(points[0][0]), y1: round2(points[0][1]), x2: round2(points[1][0]), y2: round2(points[1][1]) });
          }
          continue;
        }
        const closed = points.length === 4 || (points.length === 5 && near(points[0][0], points[4][0]) && near(points[0][1], points[4][1]));
        if (!closed) continue;
        const axisAligned = points.slice(0, 4).every((point, position) => {
          const next = points[(position + 1) % 4];
          return near(point[0], next[0]) || near(point[1], next[1]);
        });
        if (!axisAligned) continue;
        if (filled && height <= 1.5 && width > 6) {
          lines.push({ x1: round2(x), y1: round2(top + (height / 2)), x2: round2(x + width), y2: round2(top + (height / 2)) });
        } else if (filled && width <= 1.5 && height > 6) {
          lines.push({ x1: round2(x + (width / 2)), y1: round2(top), x2: round2(x + (width / 2)), y2: round2(top + height) });
        } else if (width >= 2 && height >= 2) {
          boxes.push({
            x: round2(x),
            top: round2(top),
            width: round2(width),
            height: round2(height),
            filled,
            stroked,
            checkbox: width >= 6 && width <= 24 && height >= 6 && height <= 24 && Math.abs(width - height) <= 2,
          });
        }
      }
      if (lines.length + boxes.length >= MAX_SHAPES_PER_PAGE) break;
    }
  }
  return { lines: lines.slice(0, MAX_SHAPES_PER_PAGE), boxes: boxes.slice(0, MAX_SHAPES_PER_PAGE) };
}

// Link annotations in the same top-left coordinates as the text, so a reader
// can say where a link sits and what it opens.
async function pageLinks(document, page, viewport) {
  const links = [];
  let annotations = [];
  try {
    annotations = await page.getAnnotations();
  } catch {
    return links;
  }
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect)) continue;
    const [x1, y1] = applyPoint([annotation.rect[0], annotation.rect[1]], viewport.transform);
    const [x2, y2] = applyPoint([annotation.rect[2], annotation.rect[3]], viewport.transform);
    const entry = {
      x: round2(Math.min(x1, x2)),
      top: round2(Math.min(y1, y2)),
      width: round2(Math.abs(x2 - x1)),
      height: round2(Math.abs(y2 - y1)),
    };
    // unsafeUrl is the string the file carries; url is pdf.js's normalized copy (a trailing slash appears).
    if (annotation.unsafeUrl || annotation.url) entry.url = String(annotation.unsafeUrl || annotation.url);
    else if (annotation.dest) {
      try {
        const destination = typeof annotation.dest === 'string' ? await document.getDestination(annotation.dest) : annotation.dest;
        const target = Array.isArray(destination) ? destination[0] : null;
        if (target && typeof target === 'object') entry.page = (await document.getPageIndex(target)) + 1;
        else if (Number.isInteger(target)) entry.page = target + 1;
      } catch {}
    }
    if (!entry.url && !entry.page) continue;
    links.push(entry);
    if (links.length >= MAX_SHAPES_PER_PAGE) break;
  }
  return links;
}

export async function extractPdfTextLayout(path, {
  pages = null,
  maxItems = 20_000,
  shapes = true,
  signal = null,
} = {}) {
  const { pdfjs, document } = await openPdfJs(path);
  try {
    const output = [];
    let truncated = false;
    for (const pageNumber of selectedPages(document.numPages, pages)) {
      if (signal?.aborted) throw new Error('PDF layout extraction was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = [];
        for (const item of content.items || []) {
          if (!item?.str) continue;
          if (output.reduce((sum, entry) => sum + entry.items.length, 0) + items.length >= maxItems) {
            truncated = true;
            break;
          }
          const [a, b, c, d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform);
          // The run's four corners — origin, end of the advance, and both
          // lifted by the glyph height — give one box that is right for
          // upright text, text on a rotated page, and a diagonal watermark.
          const advance = Math.hypot(a, b) || 1;
          const run = [(a / advance) * Number(item.width || 0), (b / advance) * Number(item.width || 0)];
          const xs = [e, e + run[0], e + c, e + run[0] + c];
          const ys = [f, f + run[1], f + d, f + run[1] + d];
          const left = Math.min(...xs);
          const top = Math.min(...ys);
          // On a rotated page the run stands (vertical) and may read upward
          // or leftward (reversed); a search places a match along that axis.
          const vertical = Math.abs(b) > Math.abs(a);
          const reversed = vertical ? b < 0 : a < 0;
          items.push({
            text: item.str,
            x: Number(left.toFixed(2)),
            top: Number(top.toFixed(2)),
            width: Number((Math.max(...xs) - left).toFixed(2)),
            height: Number(Math.max(1, Math.max(...ys) - top).toFixed(2)),
            ...(vertical ? { vertical: true } : {}),
            ...(reversed ? { reversed: true } : {}),
            direction: item.dir || '',
            font: item.fontName || '',
          });
        }
        let geometry = { lines: [], boxes: [] };
        if (shapes) {
          try {
            geometry = await pageShapes(pdfjs, page, viewport);
          } catch (error) {
            geometry = { lines: [], boxes: [], shapesUnavailable: String(error?.message || error) };
          }
        }
        const [originX, originY] = Array.isArray(page.view) ? page.view : [0, 0];
        output.push({
          page: pageNumber,
          width: Number(viewport.width.toFixed(2)),
          height: Number(viewport.height.toFixed(2)),
          // Reported only when the page box does not start at 0,0: bottom-left
          // coordinates derived from this layout need the offset added back.
          ...(originX || originY ? { origin: { x: round2(originX), y: round2(originY) } } : {}),
          // User space → these display coordinates; a mark inverts it to land on the page.
          transform: Array.from(viewport.transform, (value) => Number(value)),
          items,
          ...geometry,
          links: shapes ? await pageLinks(document, page, viewport) : [],
        });
        if (truncated) break;
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    }
    return { pageCount: document.numPages, pages: output, truncated };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}

// Text search over a layout lives in pdf-search.mjs; it stays reachable here
// so the adapter, the tool surface, and tests keep one import.
export { findPdfText } from './pdf-search.mjs';

export function evaluatePowerPointCategorySpacing(layout, categories = []) {
  const expected = [...new Set(categories.map((entry) => String(entry || '').trim()).filter(Boolean))];
  const rows = [];
  for (const page of layout?.pages || []) {
    const items = Array.isArray(page.items) ? page.items : [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let text = String(item?.text || '').trim();
      if (!text) continue;
      if (!expected.includes(text)) {
        let nextIndex = index + 1;
        while (nextIndex < items.length && !String(items[nextIndex]?.text || '').trim()) nextIndex += 1;
        const next = items[nextIndex];
        if (next && Math.abs(Number(next.top) - Number(item.top)) <= 1) {
          const joined = `${text}${String(next.text || '').trim()}`;
          if (expected.includes(joined)) text = joined;
        }
      }
      if (!expected.includes(text)) continue;
      let row = rows.find((entry) => entry.page === page.page && Math.abs(entry.top - Number(item.top)) <= 1);
      if (!row) {
        row = { page: page.page, width: Number(page.width) || 0, top: Number(item.top), labels: [] };
        rows.push(row);
      }
      if (!row.labels.some((entry) => entry.text === text)) {
        row.labels.push({ text, x: Number(item.x) || 0 });
      }
    }
  }
  const complete = rows
    .filter((row) => expected.every((text) => row.labels.some((entry) => entry.text === text)))
    .map((row) => {
      const labels = expected
        .map((text) => row.labels.find((entry) => entry.text === text))
        .sort((left, right) => left.x - right.x);
      const gaps = labels.slice(1).map((entry, index) => entry.x - labels[index].x);
      return {
        ...row,
        labels,
        span: labels.length > 1 ? labels.at(-1).x - labels[0].x : 0,
        minimumGap: gaps.length ? Math.min(...gaps) : 0,
      };
    })
    .sort((left, right) => right.span - left.span);
  const best = complete[0] || null;
  const requiredGap = best ? best.width * 0.1 : 0;
  return {
    ok: expected.length <= 1 || Boolean(best && best.minimumGap >= requiredGap),
    categories: expected,
    page: best?.page || 0,
    labels: best?.labels || [],
    span: Number((best?.span || 0).toFixed(2)),
    minimumGap: Number((best?.minimumGap || 0).toFixed(2)),
    requiredGap: Number(requiredGap.toFixed(2)),
  };
}

function clusterRows(items, tolerance = 3) {
  const rows = [];
  for (const item of [...items].sort((left, right) => left.top - right.top || left.x - right.x)) {
    if (!String(item.text || '').trim()) continue;
    let row = rows.find((entry) => Math.abs(entry.top - item.top) <= tolerance);
    if (!row) {
      row = { top: item.top, cells: [] };
      rows.push(row);
    }
    row.cells.push(item);
    row.top = (row.top * (row.cells.length - 1) + item.top) / row.cells.length;
  }
  return rows.map((row) => ({
    top: Number(row.top.toFixed(2)),
    cells: row.cells.sort((left, right) => left.x - right.x).map((item) => ({
      text: item.text,
      x: item.x,
      width: item.width,
    })),
  }));
}

// Text inside one cell, line by line; adjacent runs on a line are joined
// without a space unless the PDF left a gap between them.
function textInBox(items, box) {
  const inside = items.filter((item) => {
    const centerX = item.x + (item.width / 2);
    const centerY = item.top + (item.height / 2);
    return centerX >= box.x && centerX <= box.x + box.width && centerY >= box.top && centerY <= box.top + box.height;
  });
  const lines = [];
  for (const item of inside.sort((left, right) => left.top - right.top || left.x - right.x)) {
    let line = lines.find((entry) => Math.abs(entry.top - item.top) <= 2);
    if (!line) {
      line = { top: item.top, text: '', end: null };
      lines.push(line);
    }
    const gap = line.end == null ? 0 : item.x - line.end;
    line.text += (line.text && gap > 1 && !line.text.endsWith(' ') && !item.text.startsWith(' ') ? ' ' : '') + item.text;
    line.end = item.x + item.width;
  }
  return lines.map((line) => line.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// A bordered table is its cell rectangles: rows are boxes sharing a top edge,
// and consecutive rows with the same column edges form one table. Text is
// assigned by containment, so wrapped cells and blank cells come out right.
function ruledTables(page) {
  const cells = (page.boxes || []).filter((box) => (
    !box.checkbox && box.width >= 8 && box.height >= 6 && box.width < page.width * 0.98 && box.height < page.height * 0.5
  ));
  if (cells.length < 4) return [];
  const rows = [];
  for (const cell of [...cells].sort((left, right) => left.top - right.top || left.x - right.x)) {
    let row = rows.find((entry) => Math.abs(entry.top - cell.top) <= 2);
    if (!row) {
      row = { top: cell.top, cells: [] };
      rows.push(row);
    }
    if (!row.cells.some((existing) => Math.abs(existing.x - cell.x) <= 1)) row.cells.push(cell);
  }
  const tables = [];
  let current = null;
  for (const row of rows) {
    row.cells.sort((left, right) => left.x - right.x);
    const key = row.cells.map((cell) => Math.round(cell.x)).join('|');
    const bottom = row.top + Math.max(...row.cells.map((cell) => cell.height));
    if (current && current.key === key && Math.abs(current.bottom - row.top) <= 2) {
      current.rows.push(row);
      current.bottom = bottom;
    } else {
      current = { key, rows: [row], bottom };
      tables.push(current);
    }
  }
  return tables
    .filter((table) => table.rows.length >= 2 && table.rows[0].cells.length >= 2)
    .map((table) => ({
      page: page.page,
      columns: table.rows[0].cells.length,
      confidence: 1,
      source: 'ruled',
      rows: table.rows.map((row) => row.cells.map((cell) => textInBox(page.items || [], cell))),
      geometry: table.rows.map((row) => ({
        top: row.top,
        cells: row.cells.map((cell) => ({ x: cell.x, width: cell.width, height: cell.height })),
      })),
    }));
}

export function inferPdfTables(layout) {
  const tables = [];
  for (const page of layout.pages || []) {
    const ruled = ruledTables(page);
    if (ruled.length) {
      tables.push(...ruled);
      continue;
    }
    const rows = clusterRows(page.items || []).filter((row) => row.cells.length >= 2);
    if (rows.length < 2) continue;
    const counts = new Map();
    for (const row of rows) counts.set(row.cells.length, (counts.get(row.cells.length) || 0) + 1);
    const [columns, repeated] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || [0, 0];
    const selected = rows.filter((row) => Math.abs(row.cells.length - columns) <= 1);
    if (columns < 2 || selected.length < 2) continue;
    tables.push({
      page: page.page,
      columns,
      confidence: Number((repeated / rows.length).toFixed(3)),
      source: 'alignment',
      rows: selected.map((row) => row.cells.map((cell) => cell.text)),
      geometry: selected,
    });
  }
  return {
    pageCount: layout.pageCount,
    tableCount: tables.length,
    tables,
    truncated: layout.truncated === true,
  };
}

async function pdfImageBuffer(image) {
  if (!image?.data || !image.width || !image.height) return null;
  const channels = Math.round(image.data.length / (image.width * image.height));
  if (![1, 2, 3, 4].includes(channels)) return null;
  return await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels },
  }).png().toBuffer();
}

function resolvedPdfObject(objects, name) {
  return new Promise((resolve, reject) => {
    try {
      objects.get(name, (value) => resolve(value));
    } catch (error) {
      reject(error);
    }
  });
}

export async function extractPdfImages(path, {
  pages = null,
  signal = null,
} = {}) {
  const { pdfjs, document } = await openPdfJs(path);
  const { OPS, Util } = pdfjs;
  const images = [];
  try {
    for (const pageNumber of selectedPages(document.numPages, pages)) {
      if (signal?.aborted) throw new Error('PDF image extraction was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        const operators = await page.getOperatorList();
        const viewport = page.getViewport({ scale: 1 });
        const seen = new Map();
        const stack = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          const fn = operators.fnArray[index];
          const args = operators.argsArray[index] || [];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() || ctm;
          else if (fn === OPS.transform) ctm = Util.transform(ctm, Array.from(args));
          else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            if (args[0]) ctm = Util.transform(ctm, Array.from(args[0]));
          } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
          if (![OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(fn)) continue;
          // An image paints the unit square under the current transform, so its
          // corners under that transform are where it sits on the page.
          const full = Util.transform(viewport.transform, ctm);
          const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map((point) => applyPoint(point, full));
          const xs = corners.map((point) => point[0]);
          const ys = corners.map((point) => point[1]);
          const placement = {
            x: round2(Math.min(...xs)),
            top: round2(Math.min(...ys)),
            placedWidth: round2(Math.max(...xs) - Math.min(...xs)),
            placedHeight: round2(Math.max(...ys) - Math.min(...ys)),
          };
          const key = fn === OPS.paintInlineImageXObject ? `inline-${index}` : String(args[0]);
          if (seen.has(key)) {
            seen.get(key).placements += 1;
            continue;
          }
          const image = fn === OPS.paintInlineImageXObject
            ? args[0]
            : await resolvedPdfObject(page.objs, args[0]);
          const data = await pdfImageBuffer(image);
          if (!data) continue;
          const entry = {
            page: pageNumber,
            index: images.length + 1,
            width: image.width,
            height: image.height,
            ...placement,
            placements: 1,
            mimeType: 'image/png',
            data: data.toString('base64'),
          };
          seen.set(key, entry);
          images.push(entry);
        }
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    }
    return {
      pageCount: document.numPages,
      imageCount: images.length,
      images: images.map(({ data, ...image }) => image),
      _images: images,
    };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}

/** Bookmarks flattened in reading order with the page each one opens, so a long report's structure is visible before its text. */
export async function extractPdfOutline(path, { maxEntries = 500 } = {}) {
  const { document } = await openPdfJs(path);
  try {
    const entries = [];
    const walk = async (items, level) => {
      for (const item of items || []) {
        if (entries.length >= maxEntries) return;
        let page = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await document.getDestination(dest);
          if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object') page = (await document.getPageIndex(dest[0])) + 1;
        } catch {}
        entries.push({ title: String(item.title || ''), page, level, ...(item.url ? { url: item.url } : {}) });
        await walk(item.items, level + 1);
      }
    };
    await walk(await document.getOutline(), 1);
    return { entries, truncated: entries.length >= maxEntries };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}

export function parseOcrTsv(value) {
  const rows = String(value || '').split(/\r?\n/);
  if (!rows.length) return [];
  const header = rows.shift().split('\t');
  const position = Object.fromEntries(header.map((name, index) => [name, index]));
  return rows.map((line) => line.split('\t')).filter((columns) => columns.length >= header.length).map((columns) => ({
    text: columns[position.text] || '',
    confidence: Number(columns[position.conf] || -1),
    left: Number(columns[position.left] || 0),
    top: Number(columns[position.top] || 0),
    width: Number(columns[position.width] || 0),
    height: Number(columns[position.height] || 0),
  })).filter((word) => word.text.trim() && word.width > 0 && word.height > 0);
}

export function parseOcrBlocks(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) {
          const bbox = word?.bbox || {};
          const left = Number(bbox.x0 || 0);
          const top = Number(bbox.y0 || 0);
          const width = Number(bbox.x1 || 0) - left;
          const height = Number(bbox.y1 || 0) - top;
          if (String(word?.text || '').trim() && width > 0 && height > 0) {
            words.push({
              text: String(word.text),
              confidence: Number(word.confidence || 0),
              left,
              top,
              width,
              height,
            });
          }
        }
      }
    }
  }
  return words;
}

export async function ocrPdf(path, operation, {
  dataDir,
  signal = null,
} = {}) {
  const source = await readFile(path);
  const document = await PDFDocument.load(source, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pages = selectedPages(document.getPageCount(), operation.pages || (operation.page ? [operation.page] : null));
  const languages = Array.isArray(operation.languages)
    ? operation.languages.map(String).join('+')
    : String(operation.languages || 'eng+kor');
  const cachePath = join(dataDir, 'office', 'ocr', 'languages');
  await mkdir(cachePath, { recursive: true });
  const tesseract = require('tesseract.js');
  const worker = await tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, {
    cachePath,
    gzip: true,
  });
  let wordCount = 0;
  let skippedWords = 0;
  let totalConfidence = 0;
  let text = '';
  const temporaryImages = [];
  const recognizedPages = [];
  try {
    // Recognize every page first so one font can be chosen for all the text
    // it produced: Helvetica when it is Latin, an installed Unicode face otherwise.
    for (const pageNumber of pages) {
      if (signal?.aborted) throw new Error('PDF OCR was cancelled');
      const rendered = await renderPdfPages(path, {
        pages: [pageNumber],
        maxWidth: Math.max(1200, Math.min(3200, Number(operation.maxWidth) || 2400)),
        signal,
      });
      const image = rendered.images[0];
      temporaryImages.push(image.path);
      const recognized = await worker.recognize(image.path, {}, { text: true, tsv: true, blocks: true });
      const positionedWords = parseOcrTsv(recognized.data.tsv);
      const words = (positionedWords.length ? positionedWords : parseOcrBlocks(recognized.data.blocks))
        .filter((word) => word.confidence >= Number(operation.minConfidence ?? 40));
      recognizedPages.push({ pageNumber, image, words });
      text += `${text ? '\n\n' : ''}--- Page ${pageNumber} ---\n${recognized.data.text || ''}`;
    }
    const coverage = recognizedPages.flatMap((entry) => entry.words.map((word) => word.text)).join(' ');
    let selected;
    try {
      selected = await embedDocumentFont(document, { fontPath: operation.fontPath, text: coverage });
    } catch (error) {
      // OCR noise can contain glyphs no installed face has; keep the words a
      // font does cover rather than failing the whole page.
      if (operation.fontPath) throw error;
      selected = await embedDocumentFont(document, { text: '' });
    }
    const { font, fontPath, embedded } = selected;
    for (const { pageNumber, image, words } of recognizedPages) {
      const page = document.getPage(pageNumber - 1);
      const scaleX = page.getWidth() / image.width;
      const scaleY = page.getHeight() / image.height;
      for (const word of words) {
        if (!fontCovers(font, word.text)) {
          skippedWords += 1;
          continue;
        }
        // Fit the invisible word to its box in both directions so text
        // extraction sees single spaces between words and layout queries
        // land where the picture shows the word.
        const naturalWidth = font.widthOfTextAtSize(word.text, 1);
        const byWidth = naturalWidth > 0 ? (word.width * scaleX) / naturalWidth : Infinity;
        page.drawText(word.text, {
          x: word.left * scaleX,
          y: page.getHeight() - (word.top + word.height) * scaleY,
          size: Math.max(3, Math.min(word.height * scaleY * 0.8, byWidth)),
          font,
          color: rgb(0, 0, 0),
          opacity: 0,
        });
        wordCount += 1;
        totalConfidence += word.confidence;
      }
    }
    if (wordCount > 0) await writeFile(path, await document.save({ useObjectStreams: true, addDefaultPage: false }));
    return {
      op: operation.op,
      changed: wordCount > 0,
      pages,
      languages,
      wordCount,
      ...(skippedWords ? { skippedWords, skippedReason: 'no installed font has glyphs for these words; pass fontPath to keep them' } : {}),
      averageConfidence: wordCount ? Number((totalConfidence / wordCount).toFixed(2)) : 0,
      text,
      searchableTextLayer: wordCount > 0,
      fontEmbedded: embedded,
      ...(fontPath ? { fontPath } : {}),
    };
  } finally {
    await worker.terminate().catch(() => {});
    for (const image of temporaryImages) await rm(image, { force: true }).catch(() => {});
  }
}
