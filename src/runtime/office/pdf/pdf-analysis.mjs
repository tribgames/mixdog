import sharp from 'sharp';
import { openPdfJs, selectedPages } from './pdf-document.mjs';

export { ocrPdf, ocrTextLines, parseOcrBlocks, parseOcrTsv, pdfOcrReadiness } from './pdf-ocr.mjs';

const MAX_SHAPES_PER_PAGE = 2000;
const round2 = (value) => Number(Number(value).toFixed(2));
const near = (left, right, tolerance = 0.5) => Math.abs(left - right) <= tolerance;
// pdf.js's own applyTransform mutates its argument in place, so map points here.
const applyPoint = ([x, y], m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

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
// One straight subpath in page space: a hairline stroke or a thin filled
// bar reads as a line, an axis-aligned closed rectangle as a box.
const lineShape = (x1, y1, x2, y2) => ({ line: { x1: round2(x1), y1: round2(y1), x2: round2(x2), y2: round2(y2) } });

function shapeOfSubpath(points, { filled, stroked }) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - top;
  if (points.length === 2) {
    if (stroked && (near(height, 0, 1) || near(width, 0, 1))) {
      return lineShape(points[0][0], points[0][1], points[1][0], points[1][1]);
    }
    return null;
  }
  const closed =
    points.length === 4 ||
    (points.length === 5 && near(points[0][0], points[4][0]) && near(points[0][1], points[4][1]));
  if (!closed) return null;
  const axisAligned = points.slice(0, 4).every((point, position) => {
    const next = points[(position + 1) % 4];
    return near(point[0], next[0]) || near(point[1], next[1]);
  });
  if (!axisAligned) return null;
  if (filled && height <= 1.5 && width > 6) return lineShape(x, top + height / 2, x + width, top + height / 2);
  if (filled && width <= 1.5 && height > 6) return lineShape(x + width / 2, top, x + width / 2, top + height);
  if (width >= 2 && height >= 2) {
    return {
      box: {
        x: round2(x),
        top: round2(top),
        width: round2(width),
        height: round2(height),
        filled,
        stroked,
        checkbox: width >= 6 && width <= 24 && height >= 6 && height <= 24 && Math.abs(width - height) <= 2,
      },
    };
  }
  return null;
}

// The painting operators that stroke a path and the ones that fill it.
function paintOps(OPS) {
  const both = [OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke];
  return {
    stroke: new Set([OPS.stroke, OPS.closeStroke, ...both]),
    fill: new Set([OPS.fill, OPS.eoFill, ...both]),
  };
}

async function pageShapes(pdfjs, page, viewport) {
  const { OPS, Util } = pdfjs;
  const paint = paintOps(OPS);
  const operators = await page.getOperatorList();
  const lines = [];
  const boxes = [];
  const state = { stack: [], ctm: [1, 0, 0, 1, 0, 0] };
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index] || [];
    applyGraphicsOp(pdfjs, fn, args, state);
    if (fn !== OPS.constructPath) continue;
    const [paintOp, [data]] = args;
    const filled = paint.fill.has(paintOp);
    const stroked = paint.stroke.has(paintOp);
    if (!data?.length || (!filled && !stroked)) continue;
    const full = Util.transform(viewport.transform, state.ctm);
    for (const subpath of pathSubpaths(data)) {
      if (subpath.curved) continue;
      const points = subpath.points.map((point) => applyPoint(point, full));
      const shape = shapeOfSubpath(points, { filled, stroked });
      if (shape?.line) lines.push(shape.line);
      else if (shape?.box) boxes.push(shape.box);
    }
    if (lines.length + boxes.length >= MAX_SHAPES_PER_PAGE) break;
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
        const destination =
          typeof annotation.dest === 'string' ? await document.getDestination(annotation.dest) : annotation.dest;
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

// The run's four corners — origin, end of the advance, and both lifted by
// the glyph height — give one box that is right for upright text, text on
// a rotated page, and a diagonal watermark.
function pdfTextItem(pdfjs, viewport, item) {
  const [a, b, c, d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform);
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
  return {
    text: item.str,
    x: Number(left.toFixed(2)),
    top: Number(top.toFixed(2)),
    width: Number((Math.max(...xs) - left).toFixed(2)),
    height: Number(Math.max(1, Math.max(...ys) - top).toFixed(2)),
    ...(vertical ? { vertical: true } : {}),
    ...(reversed ? { reversed: true } : {}),
    direction: item.dir || '',
    font: item.fontName || '',
  };
}

async function pdfPageGeometry(pdfjs, page, viewport, shapes) {
  if (!shapes) return { lines: [], boxes: [] };
  try {
    return await pageShapes(pdfjs, page, viewport);
  } catch (error) {
    return { lines: [], boxes: [], shapesUnavailable: String(error?.message || error) };
  }
}

async function pdfPageLayout(document, page, pageNumber, viewport, { items, geometry, shapes }) {
  const [originX, originY] = Array.isArray(page.view) ? page.view : [0, 0];
  return {
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
  };
}

export async function extractPdfTextLayout(
  path,
  { pages = null, maxItems = 20_000, shapes = true, signal = null } = {}
) {
  const { pdfjs, document } = await openPdfJs(path);
  try {
    const output = [];
    let itemCount = 0;
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
          if (itemCount + items.length >= maxItems) {
            truncated = true;
            break;
          }
          items.push(pdfTextItem(pdfjs, viewport, item));
        }
        itemCount += items.length;
        const geometry = await pdfPageGeometry(pdfjs, page, viewport, shapes);
        output.push(await pdfPageLayout(document, page, pageNumber, viewport, { items, geometry, shapes }));
        if (truncated) break;
      } finally {
        try {
          page.cleanup?.();
        } catch {}
      }
    }
    return { pageCount: document.numPages, pages: output, truncated };
  } finally {
    try {
      await document.destroy?.();
    } catch {}
  }
}

// Text search over a layout lives in pdf-search.mjs; it stays reachable here
// so the adapter, the tool surface, and tests keep one import.
export { findPdfText } from './pdf-search.mjs';

// The text run at `index`, joined with the next run on the same line when only
// the joined text names a category (a label the PDF drew as two runs).
function categoryLabelAt(items, index, expected) {
  const item = items[index];
  const text = String(item?.text || '').trim();
  if (!text || expected.includes(text)) return text;
  let nextIndex = index + 1;
  while (nextIndex < items.length && !String(items[nextIndex]?.text || '').trim()) nextIndex += 1;
  const next = items[nextIndex];
  if (!next || Math.abs(Number(next.top) - Number(item.top)) > 1) return text;
  const joined = `${text}${String(next.text || '').trim()}`;
  return expected.includes(joined) ? joined : text;
}

// Every line that carries category labels, keyed by page and baseline.
function categoryLabelRows(layout, expected) {
  const rows = [];
  for (const page of layout?.pages || []) {
    const items = Array.isArray(page.items) ? page.items : [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const text = categoryLabelAt(items, index, expected);
      if (!text || !expected.includes(text)) continue;
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
  return rows;
}

function categoryRowSpacing(row, expected) {
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
}

export function evaluatePowerPointCategorySpacing(layout, categories = []) {
  const expected = [...new Set(categories.map((entry) => String(entry || '').trim()).filter(Boolean))];
  const complete = categoryLabelRows(layout, expected)
    .filter((row) => expected.every((text) => row.labels.some((entry) => entry.text === text)))
    .map((row) => categoryRowSpacing(row, expected))
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

// A PDF reports the runs it drew, not cells: a cell whose words were drawn as
// separate runs would count as several columns and break its row against the
// rows around it. Runs closer than half a line height are the same cell — the
// gap a column boundary leaves is several times that.
const INTRA_CELL_GAP_RATIO = 0.5;

function mergeRowRuns(items) {
  const cells = [];
  for (const item of items) {
    const last = cells[cells.length - 1];
    const gap = last ? item.x - (last.x + last.width) : Number.POSITIVE_INFINITY;
    if (last && gap <= INTRA_CELL_GAP_RATIO * Math.max(last.height, item.height)) {
      last.text += `${gap > 0.5 ? ' ' : ''}${item.text}`;
      last.width = item.x + item.width - last.x;
      last.height = Math.max(last.height, item.height);
      continue;
    }
    cells.push({ text: item.text, x: item.x, width: item.width, height: item.height });
  }
  return cells;
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
    cells: mergeRowRuns(row.cells.sort((left, right) => left.x - right.x)).map((cell) => ({
      text: cell.text.replace(/\s+/g, ' ').trim(),
      x: cell.x,
      width: cell.width,
      // The line height travels with the cell: the rows of an unruled table are
      // read as one table by how far apart they sit, which is measured in lines.
      height: cell.height,
    })),
  }));
}

// Text inside one cell, line by line; adjacent runs on a line are joined
// without a space unless the PDF left a gap between them.
function textInBox(items, box) {
  const inside = items.filter((item) => {
    const centerX = item.x + item.width / 2;
    const centerY = item.top + item.height / 2;
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
    line.text +=
      (line.text && gap > 1 && !line.text.endsWith(' ') && !item.text.startsWith(' ') ? ' ' : '') + item.text;
    line.end = item.x + item.width;
  }
  return lines
    .map((line) => line.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const TABLE_SNAP_TOLERANCE = 2;

// How far apart two rows of an unruled table may sit and still belong to it,
// in multiples of the row's own line height: a table steps by about a line,
// and a page's separate blocks sit further apart than that.
const ALIGNMENT_ROW_GAP = 2.5;

// The same column edge drawn on two rows can differ by a fraction of a point,
// and comparing raw coordinates splits one table into several. Near-identical
// positions collapse to the average of their cluster.
function snapPositions(values) {
  const clusters = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= TABLE_SNAP_TOLERANCE) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((cluster) => cluster.reduce((total, value) => total + value, 0) / cluster.length);
}

/** The index of the edge `value` sits on, or -1 when it sits on none of them. */
function snapTo(edges, value) {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < edges.length; index += 1) {
    const gap = Math.abs(edges[index] - value);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  }
  return distance <= TABLE_SNAP_TOLERANCE ? best : -1;
}

// A row belongs to the table when its edges sit on the table's grid (a merged
// cell simply omits the edges it spans) or when the grid sits on the row's
// edges (the row is finer, so the grid grows instead of a second table
// starting). Anything else is a different table.
function fitsGrid(grid, starts) {
  return starts.every((value) => snapTo(grid, value) >= 0) || grid.every((value) => snapTo(starts, value) >= 0);
}

function ruledTable(page, table) {
  const grid = table.grid;
  const columns = grid.length;
  const merges = [];
  const rows = [];
  for (const [rowIndex, row] of table.rows.entries()) {
    const values = new Array(columns).fill('');
    for (const cell of row.cells) {
      const start = snapTo(grid, cell.x);
      if (start < 0) continue;
      const end = snapTo(grid, cell.x + cell.width);
      // A cell ending past the last edge closes the row, so it spans the rest.
      const span = Math.max(1, (end < 0 ? columns : end) - start);
      values[start] = textInBox(page.items || [], cell);
      if (span > 1) merges.push({ row: rowIndex, column: start, span });
    }
    rows.push(values);
  }
  // A shaded first row over unshaded body rows is the header the document drew.
  const header =
    table.rows[0].cells.every((cell) => cell.filled) &&
    table.rows.slice(1).some((row) => row.cells.some((cell) => !cell.filled));
  return {
    page: page.page,
    columns,
    confidence: 1,
    source: 'ruled',
    ...(header ? { header: true } : {}),
    ...(merges.length ? { merges } : {}),
    rows,
    geometry: table.rows.map((row) => ({
      top: row.top,
      cells: row.cells.map((cell) => ({ x: cell.x, width: cell.width, height: cell.height })),
    })),
  };
}

// A bordered table is its cell rectangles: rows are boxes sharing a top edge,
// and consecutive rows sharing a column grid form one table. Text is assigned
// by containment, so wrapped cells and blank cells come out right, and a row
// stays as wide as the grid even where cells are merged.
function ruledTables(page) {
  const cells = (page.boxes || []).filter(
    (box) =>
      !box.checkbox &&
      box.width >= 8 &&
      box.height >= 6 &&
      box.width < page.width * 0.98 &&
      box.height < page.height * 0.5
  );
  if (cells.length < 4) return [];
  const rows = [];
  for (const cell of [...cells].sort((left, right) => left.top - right.top || left.x - right.x)) {
    let row = rows.find((entry) => Math.abs(entry.top - cell.top) <= TABLE_SNAP_TOLERANCE);
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
    const starts = row.cells.map((cell) => cell.x);
    const bottom = row.top + Math.max(...row.cells.map((cell) => cell.height));
    if (current && Math.abs(current.bottom - row.top) <= TABLE_SNAP_TOLERANCE && fitsGrid(current.grid, starts)) {
      current.grid = snapPositions([...current.grid, ...starts]);
      current.rows.push(row);
      current.bottom = bottom;
    } else {
      current = { grid: snapPositions(starts), rows: [row], bottom };
      tables.push(current);
    }
  }
  return tables
    .filter((table) => table.rows.length >= 2 && table.grid.length >= 2)
    .map((table) => ruledTable(page, table));
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
    // Rows far apart on the page are not a table. A form's field labels and the
    // footer under them line up in two columns, and taken together by position
    // alone they came back as a two-row table of a label and a page number. A
    // table's rows follow each other by about a line, so the block ends where
    // that stops being true.
    const blocks = [];
    for (const row of rows) {
      const height = Math.max(1, ...row.cells.map((cell) => cell.height || 0));
      const current = blocks.at(-1);
      if (current && row.top - current.bottom <= height * ALIGNMENT_ROW_GAP) {
        current.rows.push(row);
        current.bottom = row.top + height;
      } else blocks.push({ rows: [row], bottom: row.top + height });
    }
    for (const block of blocks) {
      if (block.rows.length < 2) continue;
      const counts = new Map();
      for (const row of block.rows) counts.set(row.cells.length, (counts.get(row.cells.length) || 0) + 1);
      const [columns, repeated] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || [0, 0];
      const selected = block.rows.filter((row) => Math.abs(row.cells.length - columns) <= 1);
      if (columns < 2 || selected.length < 2) continue;
      tables.push({
        page: page.page,
        columns,
        confidence: Number((repeated / block.rows.length).toFixed(3)),
        source: 'alignment',
        rows: selected.map((row) => row.cells.map((cell) => cell.text)),
        geometry: selected,
      });
    }
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
  })
    .png()
    .toBuffer();
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

// Tracks the current transform through save/restore and form XObject nesting.
function applyGraphicsOp({ OPS, Util }, fn, args, state) {
  if (fn === OPS.save) state.stack.push(state.ctm);
  else if (fn === OPS.restore) state.ctm = state.stack.pop() || state.ctm;
  else if (fn === OPS.transform) state.ctm = Util.transform(state.ctm, Array.from(args));
  else if (fn === OPS.paintFormXObjectBegin) {
    state.stack.push(state.ctm);
    if (args[0]) state.ctm = Util.transform(state.ctm, Array.from(args[0]));
  } else if (fn === OPS.paintFormXObjectEnd) state.ctm = state.stack.pop() || state.ctm;
}

// An image paints the unit square under the current transform, so its
// corners under that transform are where it sits on the page.
function imagePlacement(Util, viewport, ctm) {
  const full = Util.transform(viewport.transform, ctm);
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map((point) => applyPoint(point, full));
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  return {
    x: round2(Math.min(...xs)),
    top: round2(Math.min(...ys)),
    placedWidth: round2(Math.max(...xs) - Math.min(...xs)),
    placedHeight: round2(Math.max(...ys) - Math.min(...ys)),
  };
}

async function collectPageImages(pdfjs, page, pageNumber, images) {
  const { OPS, Util } = pdfjs;
  const operators = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  const seen = new Map();
  const state = { stack: [], ctm: [1, 0, 0, 1, 0, 0] };
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index] || [];
    applyGraphicsOp(pdfjs, fn, args, state);
    if (![OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(fn)) continue;
    const key = fn === OPS.paintInlineImageXObject ? `inline-${index}` : String(args[0]);
    if (seen.has(key)) {
      seen.get(key).placements += 1;
      continue;
    }
    const image = fn === OPS.paintInlineImageXObject ? args[0] : await resolvedPdfObject(page.objs, args[0]);
    const data = await pdfImageBuffer(image);
    if (!data) continue;
    const entry = {
      page: pageNumber,
      index: images.length + 1,
      width: image.width,
      height: image.height,
      ...imagePlacement(Util, viewport, state.ctm),
      placements: 1,
      mimeType: 'image/png',
      data: data.toString('base64'),
    };
    seen.set(key, entry);
    images.push(entry);
  }
}

export async function extractPdfImages(path, { pages = null, signal = null } = {}) {
  const { pdfjs, document } = await openPdfJs(path);
  const images = [];
  try {
    for (const pageNumber of selectedPages(document.numPages, pages)) {
      if (signal?.aborted) throw new Error('PDF image extraction was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        await collectPageImages(pdfjs, page, pageNumber, images);
      } finally {
        try {
          page.cleanup?.();
        } catch {}
      }
    }
    return {
      pageCount: document.numPages,
      imageCount: images.length,
      images: images.map(({ data, ...image }) => image),
      _images: images,
    };
  } finally {
    try {
      await document.destroy?.();
    } catch {}
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
          if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object')
            page = (await document.getPageIndex(dest[0])) + 1;
        } catch {}
        entries.push({ title: String(item.title || ''), page, level, ...(item.url ? { url: item.url } : {}) });
        await walk(item.items, level + 1);
      }
    };
    await walk(await document.getOutline(), 1);
    return { entries, truncated: entries.length >= maxEntries };
  } finally {
    try {
      await document.destroy?.();
    } catch {}
  }
}
