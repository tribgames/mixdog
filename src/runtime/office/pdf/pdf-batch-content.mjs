/**
 * src/runtime/office/pdf/pdf-batch-content.mjs - batch operations that draw
 * on or fill the document: text stamps, marks, images, OCR, and forms. Each
 * handler takes the batch state ({ path, source, context, document, measure })
 * and returns its result entry; handlers that reload the document assign
 * state.document / state.measure.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BlendMode, PDFString, degrees } from 'pdf-lib';
import { ocrPdf } from './pdf-analysis.mjs';
import { SAVE_OPTIONS, color, embedImage } from './pdf-draw.mjs';
import { embedDocumentFont } from './pdf-fonts.mjs';
import {
  addFormField,
  clippedFormValues,
  fieldText,
  fieldWidgets,
  fillFormValues,
  lintPdfFormFields,
} from './pdf-forms.mjs';
import { loadPdf, pageSpin, selectedPages, writeSibling } from './pdf-edit-document.mjs';
import { displayPointToUser, reportBoxes, targetBoxes } from './pdf-marks.mjs';

const ALIGNMENTS = ['left', 'center', 'right'];

// A rotated page is stamped as the reader sees it: x and y are points on the
// displayed page, mapped back into user space, and the run is turned by the
// page's own rotation so the stamp reads with the page instead of lying
// sideways along an edge. A watermark centres its rotated run on the page
// unless placed explicitly; add_text with align centres or right-aligns the
// run between the page margins when x is omitted, or on x when it is given.
function stampText(page, text, stamp) {
  const { font, size, angle, align, watermark } = stamp;
  const textWidth = font.widthOfTextAtSize(text, size);
  const spin = pageSpin(page);
  const upright = spin % 180 === 0;
  const displayWidth = upright ? page.getWidth() : page.getHeight();
  const displayHeight = upright ? page.getHeight() : page.getWidth();
  const spanX = textWidth * Math.cos((angle * Math.PI) / 180);
  const spanY = textWidth * Math.sin((angle * Math.PI) / 180);
  let defaultX = 36;
  if (align === 'center') defaultX = (displayWidth - spanX) / 2;
  else if (align === 'right') defaultX = displayWidth - 36 - spanX;
  let displayX = stamp.x ?? defaultX;
  let displayY = stamp.y ?? (watermark ? (displayHeight - spanY) / 2 : 36);
  if (stamp.x != null) {
    // With x, align puts the run's centre or right end there: the start at x ignored the align asked for, and a
    // footer centred at the page's middle ran off to the right by half its width.
    const share = { left: 0, center: 0.5, right: 1 }[align];
    displayX -= share * spanX;
    if (stamp.y != null) displayY -= share * spanY;
  } else if (watermark && stamp.y == null) {
    // The glyphs' middle on the page's centre, not their baseline: a 45° mark sat a third of its size up and to
    // the left. Latin capitals and Hangul stand about 0.7 em.
    const lift = 0.35 * size;
    displayX += lift * Math.sin((angle * Math.PI) / 180);
    displayY -= lift * Math.cos((angle * Math.PI) / 180);
  }
  const { x, y } = displayPointToUser(spin, page.getWidth(), page.getHeight(), displayX, displayY);
  page.drawText(text, {
    x,
    y,
    size,
    font,
    color: color(stamp.color),
    opacity: stamp.opacity,
    rotate: degrees(angle + spin),
  });
}

async function addText(state, operation) {
  const { document } = state;
  const watermark = operation.op === 'watermark';
  const template = String(operation.text ?? '');
  if (!template.trim()) throw new Error(`${operation.op} needs text`);
  const { font, fontPath, embedded } = await embedDocumentFont(document, {
    fontPath: operation.fontPath,
    text: template,
  });
  const align = String(operation.align || (watermark ? 'center' : 'left')).toLowerCase();
  if (!ALIGNMENTS.includes(align)) throw new Error(`${operation.op} align must be left, center, or right`);
  const stamp = {
    font,
    watermark,
    align,
    size: Number(operation.size ?? (watermark ? 48 : 12)),
    opacity: Number(operation.opacity ?? (watermark ? 0.25 : 1)),
    angle: Number(operation.rotation ?? (watermark ? 45 : 0)),
    color: operation.color,
    x: operation.x === undefined || operation.x === null ? null : Number(operation.x),
    y: operation.y === undefined || operation.y === null ? null : Number(operation.y),
  };
  const pageCount = document.getPageCount();
  const pages = [];
  for (const { page, index } of selectedPages(document, operation)) {
    // {page} and {pages} number an existing file the way create's pageNumbers does.
    const text = template.replace(/\{page\}/g, String(index + 1)).replace(/\{pages\}/g, String(pageCount));
    stampText(page, text, stamp);
    pages.push(index + 1);
  }
  return {
    op: operation.op,
    changed: pages.length > 0,
    pages,
    fontEmbedded: embedded,
    ...(fontPath ? { fontPath } : {}),
  };
}

async function measureTargets(state, operation) {
  const target = await targetBoxes(state.document, operation, state.measure);
  state.document = target.document;
  state.measure = target.measure;
  return target.boxes;
}

async function highlight(state, operation) {
  const boxes = await measureTargets(state, operation);
  const fill = color(operation.color || 'ffeb3b');
  const opacity = Number(operation.opacity ?? 0.45);
  const pages = new Set();
  for (const box of boxes) {
    // Multiply keeps the glyphs under the mark legible, the way a marker pen does.
    state.document.getPage(box.index).drawRectangle({
      x: box.x - 1,
      y: box.y - 1,
      width: box.width + 2,
      height: box.height + 2,
      color: fill,
      opacity,
      blendMode: BlendMode.Multiply,
      borderWidth: 0,
    });
    pages.add(box.index + 1);
  }
  return {
    op: operation.op,
    changed: true,
    marks: boxes.length,
    pages: [...pages],
    ...(operation.find ? { find: String(operation.find) } : {}),
    boxes: reportBoxes(boxes),
  };
}

async function addLink(state, operation) {
  const autoUrls = operation.urls === true;
  const url = String(operation.url ?? '').trim();
  const toPage = operation.toPage === undefined || operation.toPage === null ? null : Number(operation.toPage);
  if (!url && toPage === null && !autoUrls) throw new Error('add_link needs url, toPage, or urls:true');
  if (url && !/^(https?:\/\/|mailto:)/i.test(url))
    throw new Error(`add_link url must start with http://, https://, or mailto: (${url})`);
  if (toPage !== null) selectedPages(state.document, { page: toPage });
  // urls:true finds every http(s) address in the text and points each at itself.
  const request = autoUrls
    ? { ...operation, find: 'https?://[^\\s<>()"\']+', regex: true, wholeWord: false }
    : operation;
  let boxes;
  try {
    boxes = await measureTargets(state, request);
  } catch (error) {
    if (!autoUrls || !/found no text matching/.test(String(error?.message || ''))) throw error;
    throw new Error(`add_link urls:true found no http(s) address in the selected pages; pass find or a box instead`);
  }
  const { document } = state;
  // The destination page is looked up after measuring, on the document the links go into.
  const destination = toPage === null ? null : [document.getPage(toPage - 1).ref, 'XYZ', null, null, null];
  const linkUrl = (box) => (autoUrls ? box.text.replace(/[.,;:!?]+$/, '') : url);
  const pages = new Set();
  for (const box of boxes) {
    const page = document.getPage(box.index);
    const href = linkUrl(box);
    const annotation = document.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
      Border: [0, 0, 0],
      ...(href ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) } } : { Dest: destination }),
    });
    page.node.addAnnot(document.context.register(annotation));
    pages.add(box.index + 1);
  }
  let linkTarget = { toPage };
  if (autoUrls) linkTarget = { urls: boxes.map(linkUrl) };
  else if (url) linkTarget = { url };
  return {
    op: operation.op,
    changed: true,
    links: boxes.length,
    pages: [...pages],
    ...linkTarget,
    boxes: reportBoxes(boxes),
  };
}

async function stampImage(state, operation) {
  const { document, path } = state;
  const imagePath = resolve(dirname(path), String(operation.path || ''));
  const placed = await embedImage(document, imagePath);
  const pages = [];
  for (const { page, index } of selectedPages(document, operation)) {
    // Pixels become points one-to-one, so a photo would run off the page; keep it inside the margins unless sized.
    const width = Number(operation.width || Math.min(placed.width, page.getWidth() - 72));
    const height = Number(operation.height || (placed.height * width) / placed.width);
    page.drawImage(placed.image, {
      x: Number(operation.x || 0),
      y: Number(operation.y || 0),
      width,
      height,
      opacity: Number(operation.opacity ?? 1),
    });
    pages.push(index + 1);
  }
  return { op: operation.op, changed: pages.length > 0, pages, image: imagePath };
}

async function ocrPages(state, operation) {
  const { path } = state;
  await writeFile(path, await state.document.save(SAVE_OPTIONS));
  const result = await ocrPdf(path, operation, state.context);
  state.document = await loadPdf(await readFile(path));
  return result;
}

async function fillForm(state, operation) {
  const { document } = state;
  const form = document.getForm();
  const filled = fillFormValues(form, operation.values);
  const coverage = Object.values(operation.values || {})
    .flat()
    .map((value) => String(value ?? ''))
    .join(' ');
  const { font, fontPath, embedded } = await embedDocumentFont(document, {
    fontPath: operation.fontPath,
    text: coverage,
  });
  form.updateFieldAppearances(font);
  // The appearances exist now, so the values can be measured against the
  // boxes that will show them before the document is handed on.
  const clipped = clippedFormValues(document, form, operation.values, font);
  if (operation.flatten) form.flatten();
  return {
    op: operation.op,
    changed: filled.length > 0,
    filled,
    flattened: Boolean(operation.flatten),
    fontEmbedded: embedded,
    ...(fontPath ? { fontPath } : {}),
    ...(clipped.length
      ? {
          clipped,
          warning: `${clipped.length} value(s) do not fit their field box: ${clipped.map((entry) => entry.message).join(' ')}`,
        }
      : {}),
  };
}

async function addFormFieldOp(state, operation) {
  const { document } = state;
  const check = lintPdfFormFields(
    [operation],
    document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()])
  );
  if (!check.ok) throw new Error(check.issues.map((issue) => issue.message).join(' '));
  const { font } = await embedDocumentFont(document, {
    fontPath: operation.fontPath,
    text: fieldText(operation),
  });
  await addFormField(document, operation, font);
  document.getForm().updateFieldAppearances(font);
  return {
    op: operation.op,
    changed: true,
    name: operation.name,
    type: String(operation.type || 'text').toLowerCase(),
  };
}

async function flattenForm(state, operation) {
  const { document } = state;
  const form = document.getForm();
  const count = form.getFields().length;
  if (operation.fontPath) {
    const { font } = await embedDocumentFont(document, { fontPath: operation.fontPath });
    form.updateFieldAppearances(font);
  }
  form.flatten();
  return { op: operation.op, changed: count > 0, fields: count };
}

// A copy with every field's box outlined and named — and any box the caller
// proposes — so a render shows placement before a fill. The session document
// continues on a reload of the same bytes (see targetBoxes).
async function previewFields(state, operation) {
  const output = String(operation.output || '').trim();
  if (!output) throw new Error('preview_fields needs output (a file name beside the document)');
  const bytes = await state.document.save(SAVE_OPTIONS);
  state.document = await loadPdf(bytes);
  const copy = await loadPdf(bytes);
  const fields = copy.getForm().getFields();
  const proposed = Array.isArray(operation.boxes) ? operation.boxes : [];
  const labels = [...fields.map((field) => field.getName()), ...proposed.map((box) => String(box.label ?? ''))].join(
    ' '
  );
  const { font } = await embedDocumentFont(copy, { text: `${labels} box 0123456789` });
  const ink = color('d32f2f');
  const outline = (page, box, label) => {
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      borderColor: ink,
      borderWidth: 1,
    });
    page.drawText(label, { x: box.x, y: box.y + box.height + 2, size: 7, font, color: ink });
  };
  let widgets = 0;
  fields.forEach((field, index) => {
    for (const widget of fieldWidgets(field, copy)) {
      if (!widget.page) continue;
      outline(copy.getPage(widget.page - 1), widget, `${index + 1} ${field.getName()}`);
      widgets += 1;
    }
  });
  proposed.forEach((box, index) => {
    const rect = ['x', 'y', 'width', 'height'].map((key) => Number(box?.[key]));
    if (!box?.page || rect.some((value) => !Number.isFinite(value)))
      throw new Error(`preview_fields boxes[${index}] needs page, x, y, width, height`);
    const [{ page }] = selectedPages(copy, { page: box.page });
    outline(page, { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, String(box.label ?? `box ${index + 1}`));
  });
  const written = await writeSibling(state.path, output, await copy.save(SAVE_OPTIONS));
  return {
    op: operation.op,
    changed: true,
    documentChanged: false,
    output: written,
    fields: fields.length,
    widgets,
    boxes: proposed.length,
  };
}

export const CONTENT_OPERATIONS = {
  add_text: addText,
  watermark: addText,
  highlight,
  add_link: addLink,
  stamp_image: stampImage,
  ocr_pages: ocrPages,
  fill_form: fillForm,
  add_form_field: addFormFieldOp,
  flatten_form: flattenForm,
  preview_fields: previewFields,
};
