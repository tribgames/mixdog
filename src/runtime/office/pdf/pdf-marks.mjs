/**
 * src/runtime/office/pdf/pdf-marks.mjs - where a mark lands: display ↔ user
 * space mapping on rotated pages and the text-measured target boxes that
 * highlight / add_link draw on.
 */
import { extractPdfTextLayout, findPdfText } from './pdf-analysis.mjs';
import { SAVE_OPTIONS, round2 } from './pdf-draw.mjs';
import { loadPdf, selectedPages } from './pdf-edit-document.mjs';

export const MARK_OPERATIONS = new Set(['highlight', 'add_link']);
// pdf.js analysis takes at most this many pages per call.
const MEASURE_CHUNK = 100;

// A point on the page as displayed (bottom-left origin, after the page's own
// rotation) back to the user space a drawing operator writes in.
export function displayPointToUser(spin, width, height, x, y) {
  if (spin === 90) return { x: width - y, y: x };
  if (spin === 180) return { x: width - x, y: height - y };
  if (spin === 270) return { x: y, y: height - x };
  return { x, y };
}

// Display coordinates (top-left, page as shown) back to PDF user space through
// the inverse of pdf.js's page transform; the four corners keep a rotated box honest.
function displayToUser(transform, box) {
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c;
  const invert = ([X, Y]) => [(d * (X - e) - c * (Y - f)) / det, (-b * (X - e) + a * (Y - f)) / det];
  const corners = [
    [box.x, box.top],
    [box.x + box.width, box.top],
    [box.x, box.top + box.height],
    [box.x + box.width, box.top + box.height],
  ].map(invert);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// highlight and add_link take a box in bottom-left points, or `find`, which
// measures every match on the selected pages of the document as it stands in
// this batch (earlier operations included) so the boxes land on the real text.
// Measuring means serializing, and pdf-lib caches every stream it serializes
// (later drawing on such a page would be lost), so the batch continues on a
// fresh load of those bytes: the returned document replaces the caller's.
// `measure` carries the bytes and the pages already measured; marks do not
// move text, so consecutive marks share one measurement.
export async function targetBoxes(document, operation, measure = null) {
  const find = String(operation.find ?? '').trim();
  if (!find) {
    const box = ['x', 'y', 'width', 'height'].map((key) => Number(operation[key]));
    if (!operation.page || box.some((value) => !Number.isFinite(value)) || box[2] <= 0 || box[3] <= 0) {
      throw new Error(`${operation.op} needs find, or page with x, y, width, height in points`);
    }
    const [{ index }] = selectedPages(document, { page: operation.page });
    return { document, boxes: [{ index, x: box[0], y: box[1], width: box[2], height: box[3] }], measure };
  }
  const selected = selectedPages(document, operation);
  let current = document;
  let next = measure;
  if (!next) {
    const bytes = await document.save(SAVE_OPTIONS);
    current = await loadPdf(bytes);
    next = { bytes, pages: new Map() };
  }
  const missing = selected.map(({ index }) => index + 1).filter((page) => !next.pages.has(page));
  for (let at = 0; at < missing.length; at += MEASURE_CHUNK) {
    const layout = await extractPdfTextLayout(next.bytes, {
      pages: missing.slice(at, at + MEASURE_CHUNK),
      shapes: false,
      maxItems: 500_000,
    });
    for (const page of layout.pages) next.pages.set(page.page, page);
  }
  const layout = { pages: selected.map(({ index }) => next.pages.get(index + 1)).filter(Boolean) };
  const { matches } = findPdfText(layout, find, {
    limit: 500,
    wholeWord: operation.wholeWord === true,
    regex: operation.regex === true,
  });
  if (!matches.length) {
    const pageNoun = selected.length > 1 ? 'pages' : 'page';
    const scope =
      selected.length === document.getPageCount()
        ? 'the document'
        : `${pageNoun} ${selected.map(({ index }) => index + 1).join(', ')}`;
    throw new Error(
      `${operation.op} found no text matching "${find}" in ${scope}; check the snapshot text or pass page, x, y, width, height`
    );
  }
  // A phrase that wraps comes back as one rect per line, and each is marked on
  // its own; `first` selects a match, so its lines stay together.
  const all = matches.map((match) => {
    const index = match.page - 1;
    const page = layout.pages.find((entry) => entry.page === match.page);
    const rects = Array.isArray(match.rects) && match.rects.length ? match.rects : [match];
    return rects.map((part) => {
      // The layout is measured on the page as displayed (rotation and crop box
      // applied); inverting the page's transform puts the box back into user space.
      const rect =
        Array.isArray(page?.transform) && page.transform.length === 6
          ? displayToUser(page.transform, part)
          : { x: part.x, y: page.height - part.top - part.height, width: part.width, height: part.height };
      return { index, ...rect, text: match.text };
    });
  });
  const boxes = (operation.first === true ? all.slice(0, 1) : all).flat();
  return { document: current, boxes, measure: next };
}

// The first few boxes go back in bottom-left points so a caller can check a
// mark against the snapshot without rendering; a long match list is a count.
export function reportBoxes(boxes) {
  return boxes.slice(0, 20).map((box) => ({
    page: box.index + 1,
    x: round2(box.x),
    y: round2(box.y),
    width: round2(box.width),
    height: round2(box.height),
    ...(box.text ? { text: box.text } : {}),
  }));
}
