import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { SAVE_OPTIONS, color, embedImage, pageSize, wrapText } from './pdf-draw.mjs';
import { embedDocumentFont } from './pdf-fonts.mjs';
import { addFormField, fieldText, lintPdfFormFields } from './pdf-forms.mjs';

const HEADING_SIZES = Object.freeze({ 1: 20, 2: 15, 3: 12.5 });

const FLOW_FIELDS = ['before', 'after', 'x', 'width', 'color', 'align'];

// What each block actually takes. A block the writer cannot read used to flow
// as an empty paragraph: a table or a list written under the wrong key left no
// mark on the page and no word in the result, so the report shipped without
// the evidence it was asked for.
const BLOCK_FIELDS = Object.freeze({
  paragraph: Object.freeze({ required: ['text'], optional: [...FLOW_FIELDS, 'size', 'lineHeight'] }),
  heading: Object.freeze({ required: ['text'], optional: [...FLOW_FIELDS, 'size', 'lineHeight', 'level'] }),
  list: Object.freeze({
    required: ['items'],
    optional: [...FLOW_FIELDS, 'size', 'lineHeight', 'marker', 'indent', 'ordered'],
  }),
  table: Object.freeze({
    required: ['rows'],
    optional: [
      ...FLOW_FIELDS,
      'headers',
      'columnWidths',
      'columnAlignments',
      'fontSize',
      'rowHeight',
      'headerFill',
      'headerColor',
      'zebraFill',
      'borderColor',
      'repeatHeader',
    ],
  }),
  image: Object.freeze({ required: ['path'], optional: [...FLOW_FIELDS, 'height', 'y'] }),
  pagebreak: Object.freeze({ required: [], optional: [] }),
  // The document anatomy a report needs beyond running prose (docx §4 / pdf skill "Create"): each is one
  // block the writer flows and paginates, so a callout, a quote, or a caption is drawn the same on every page.
  cover: Object.freeze({
    required: ['title'],
    optional: [...FLOW_FIELDS, 'eyebrow', 'subtitle', 'meta', 'size', 'subtitleSize', 'accent', 'rule'],
  }),
  callout: Object.freeze({
    required: ['text'],
    optional: [...FLOW_FIELDS, 'label', 'size', 'lineHeight', 'fill', 'labelColor', 'padding'],
  }),
  quote: Object.freeze({
    required: ['text'],
    optional: [...FLOW_FIELDS, 'attribution', 'size', 'lineHeight', 'accent'],
  }),
  caption: Object.freeze({ required: ['text'], optional: [...FLOW_FIELDS, 'size'] }),
  stats: Object.freeze({ required: ['items'], optional: [...FLOW_FIELDS, 'size', 'labelSize', 'accent', 'rule'] }),
  rule: Object.freeze({ required: [], optional: [...FLOW_FIELDS, 'thickness'] }),
  // A form box that travels with the copy introducing it, rather than with a
  // page number the text may have moved off.
  field: Object.freeze({
    required: ['name'],
    optional: [
      ...FLOW_FIELDS,
      'label',
      'fieldType',
      'height',
      'value',
      'options',
      'multiline',
      'maxLength',
      'fontSize',
      'labelSize',
      'required',
      'readOnly',
    ],
  }),
  fieldRow: Object.freeze({
    required: ['items'],
    optional: [...FLOW_FIELDS, 'gutter', 'height', 'labelSize'],
  }),
});

// The document's own neutrals and accent (the same values the docx skill's table anatomy uses), so a
// callout field, a quote rule, and a caption read as one system without the writer naming a hex.
const INK = Object.freeze({ muted: '6B7280', accent: '1F6F8B', field: 'EEF2F7', line: 'C9CED6' });

// Block types are matched case-insensitively, so a caller writing fieldRow the
// way the contract spells it reaches the same definition as fieldrow.
const BLOCK_ALIASES = Object.freeze({ fieldrow: 'fieldRow' });

function blockType(block) {
  const declared = String(block?.type || 'paragraph').toLowerCase();
  return BLOCK_ALIASES[declared] ?? declared;
}

// The shape each block type's list fields must have.
function blockShapeFaults(type, block, at) {
  const faults = [];
  if (type === 'table' && block.rows !== undefined && !Array.isArray(block.rows)) {
    faults.push(`PDF ${at} (table) rows must be an array of row arrays.`);
  }
  if (type === 'list' && block.items !== undefined && !Array.isArray(block.items)) {
    faults.push(`PDF ${at} (list) items must be an array of strings.`);
  }
  if (
    type === 'stats' &&
    block.items !== undefined &&
    !(
      Array.isArray(block.items) &&
      block.items.every((item) => item && typeof item === 'object' && item.value !== undefined)
    )
  ) {
    faults.push(`PDF ${at} (stats) items must be an array of { value, label } objects.`);
  }
  if (type === 'cover' && block.meta !== undefined && !Array.isArray(block.meta)) {
    faults.push(`PDF ${at} (cover) meta must be an array of strings (one line each).`);
  }
  return faults;
}

function pdfBlockFaults(block, index, kinds) {
  const at = `block ${index + 1}`;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return [`PDF ${at} must be an object with type: ${kinds.join(', ')}.`];
  }
  if (block.kind !== undefined && block.type === undefined) {
    return [`PDF ${at} names its block with kind; the field is type: { type: '${String(block.kind)}' }.`];
  }
  const type = blockType(block);
  const definition = BLOCK_FIELDS[type];
  if (!definition) return [`PDF ${at} has unknown type "${type}". Use one of: ${kinds.join(', ')}.`];
  const faults = [];
  const allowed = new Set(['type', ...definition.required, ...definition.optional]);
  const unknown = Object.keys(block).filter((field) => !allowed.has(field));
  if (unknown.length) {
    faults.push(
      `PDF ${at} (${type}) has unknown field(s): ${unknown.join(', ')}. ${type} takes: ${[...allowed].join(', ')}.`
    );
  }
  const missing = definition.required.filter((field) => block[field] === undefined);
  if (missing.length) faults.push(`PDF ${at} (${type}) is missing: ${missing.join(', ')}.`);
  return [...faults, ...blockShapeFaults(type, block, at)];
}

function assertPdfBlocks(blocks) {
  const kinds = Object.keys(BLOCK_FIELDS);
  const faults = (Array.isArray(blocks) ? blocks : []).flatMap((block, index) => pdfBlockFaults(block, index, kinds));
  if (faults.length === 1) throw new Error(faults[0]);
  if (faults.length)
    throw new Error(`This PDF breaks ${faults.length} block contracts; fix them together. ${faults.join(' ')}`);
  return blocks;
}

function blockText(block) {
  const type = blockType(block);
  if (type === 'table') {
    return [...(Array.isArray(block.headers) ? [block.headers] : []), ...(Array.isArray(block.rows) ? block.rows : [])]
      .flat()
      .map((value) => String(value ?? ''))
      .join(' ');
  }
  if (type === 'list')
    return (Array.isArray(block.items) ? block.items : []).map((value) => String(value ?? '')).join(' ');
  if (type === 'stats')
    return (Array.isArray(block.items) ? block.items : [])
      .map((item) => `${item?.value ?? ''} ${item?.label ?? ''}`)
      .join(' ');
  if (type === 'cover')
    return [block.eyebrow, block.title, block.subtitle, ...(Array.isArray(block.meta) ? block.meta : [])]
      .map((value) => String(value ?? ''))
      .join(' ');
  if (type === 'callout') return `${block.label ?? ''} ${block.text ?? ''}`;
  if (type === 'quote') return `${block.text ?? ''} ${block.attribution ?? ''}`;
  if (type === 'image' || type === 'pagebreak' || type === 'rule') return '';
  return String(block?.text ?? '');
}

/**
 * The page cursor the block renderers share: the current page, the baseline
 * `y` still free on it, and `newPage()` which opens the next page with the
 * document background and resets the cursor under the top margin.
 */
function createFlow(document, { size, margin, font, background }) {
  const flow = { document, margin, font, page: null, y: 0, resolvedFields: [] };
  flow.newPage = () => {
    const entry = document.addPage(size);
    if (background) {
      entry.drawRectangle({
        x: 0,
        y: 0,
        width: entry.getWidth(),
        height: entry.getHeight(),
        color: color(background),
      });
    }
    flow.page = entry;
    flow.y = entry.getHeight() - margin;
  };
  flow.newPage();
  return flow;
}

function atTop(flow) {
  return flow.y >= flow.page.getHeight() - flow.margin;
}

// A unit that does not fit moves whole to the next page — unless it already
// sits at the top, where it flows on the per-line guard instead.
function keepTogether(flow, height) {
  if (flow.y - height < flow.margin && !atTop(flow)) flow.newPage();
}

// Space above a block is flow, not decoration: a heading that inherits only
// the previous paragraph's trailing space sits as close to the section it
// ends as to the one it opens, and the reader loses the break. The gap is
// dropped at the top of a page, where there is nothing to separate from.
function spaceBefore(block, type) {
  if (Number.isFinite(Number(block.before))) return Math.max(0, Number(block.before));
  if (type !== 'heading') return 0;
  const level = Math.min(3, Math.max(1, Number(block.level) || 1));
  return Math.round(Number(block.size || HEADING_SIZES[level]) * 0.8);
}

async function drawImageBlock(flow, block, baseDir) {
  const { margin } = flow;
  const placed = await embedImage(flow.document, resolve(baseDir, String(block.path || '')));
  const width = Number(block.width || Math.min(placed.width, flow.page.getWidth() - margin * 2));
  const height = Number(block.height || (placed.height * width) / placed.width);
  if (flow.y - height < margin) flow.newPage();
  const align = String(block.align || 'left').toLowerCase();
  let defaultX = margin;
  if (align === 'center') defaultX = (flow.page.getWidth() - width) / 2;
  else if (align === 'right') defaultX = flow.page.getWidth() - margin - width;
  flow.page.drawImage(placed.image, {
    x: Number(block.x ?? defaultX),
    y: Number(block.y ?? flow.y - height),
    width,
    height,
  });
  flow.y -= height + Number(block.after ?? 12);
}
// A list is the marker plus a hanging indent, so a wrapped item lines up
// under its own text rather than under the bullet.
function drawListBlock(flow, block) {
  const { font, margin } = flow;
  const items = (Array.isArray(block.items) ? block.items : []).map((value) => String(value ?? ''));
  const fontSize = Number(block.size || 11);
  const lineHeight = Number(block.lineHeight || fontSize * 1.35);
  const indent = Number(block.indent ?? fontSize * 1.4);
  const left = Number(block.x ?? margin);
  const textWidth = Number(block.width || flow.page.getWidth() - margin - left) - indent;
  const ordered = block.ordered === true;
  const tint = color(block.color);
  items.forEach((item, itemIndex) => {
    const marker = ordered ? `${itemIndex + 1}.` : String(block.marker ?? '•');
    const lines = wrapText(item, font, fontSize, Math.max(8, textWidth));
    // One item is one unit: broken line by line, an item that met the foot
    // of a page left its marker and first line there with the rest overleaf,
    // where no bullet introduces them.
    keepTogether(flow, lines.length * lineHeight);
    lines.forEach((line, lineIndex) => {
      if (flow.y - lineHeight < margin) flow.newPage();
      flow.y -= lineHeight;
      if (lineIndex === 0) flow.page.drawText(marker, { x: left, y: flow.y, size: fontSize, font, color: tint });
      flow.page.drawText(line, { x: left + indent, y: flow.y, size: fontSize, font, color: tint });
    });
  });
  // A list closes with the same step a table or picture leaves, so what
  // follows it is not set tight against its last item.
  flow.y -= Number(block.after ?? 12);
}
function tableRows(block) {
  return [
    ...(Array.isArray(block.headers) ? [block.headers] : []),
    ...(Array.isArray(block.rows) ? block.rows : []),
  ].map((row) => (Array.isArray(row) ? row : [row]).map((value) => String(value ?? '')));
}

// Figures are compared down the column, so they are set against the right
// edge and the header sits over them; every column of figures used to start
// at the left edge, which is where a reader looks for words.
const NUMERIC_CELL = /^[(\-+]?[\d,.\s]+(?:%|[A-Za-z가-힣원$€£¥]{0,3})\)?$/;
// A first column of 1호, 2호 is a row label with a digit in it, not a
// figure to compare down the column: it stays left unless every entry
// is a bare number.
const BARE_NUMBER_CELL = /^[(\-+]?[\d,.\s]+%?\)?$/;

function tableAlignments(rows, columns, block) {
  const numeric = (text) => /\d/.test(text) && NUMERIC_CELL.test(text.trim());
  const bareNumber = (text) => /\d/.test(text) && BARE_NUMBER_CELL.test(text.trim());
  return Array.from({ length: columns }, (_, column) => {
    const declared = Array.isArray(block.columnAlignments) ? block.columnAlignments[column] : '';
    if (declared) return String(declared).toLowerCase();
    const body = rows
      .slice(1)
      .map((row) => String(row[column] ?? '').trim())
      .filter(Boolean);
    if (!body.length) return 'left';
    if (column === 0) return body.every(bareNumber) ? 'right' : 'left';
    return body.filter(numeric).length / body.length >= 0.6 ? 'right' : 'left';
  });
}

// Cells wrap inside their column and the row grows to the tallest cell,
// so a long value never spills into its neighbour.
function tableLayout(flow, block, rows) {
  const { font, margin } = flow;
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const width = Number(block.width || flow.page.getWidth() - margin * 2);
  const weights =
    Array.isArray(block.columnWidths) && block.columnWidths.length === columns
      ? block.columnWidths.map((value) => Math.max(0, Number(value) || 0))
      : Array(columns).fill(1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || columns;
  const cellWidths = weights.map((weight) => width * (weight / totalWeight));
  const fontSize = Number(block.fontSize || 9);
  const lineHeight = fontSize * 1.3;
  const padding = 4;
  const minRowHeight = Number(block.rowHeight || 24);
  const laidOut = rows.map((row) => {
    const cells = Array.from({ length: columns }, (_, column) =>
      wrapText(row[column] ?? '', font, fontSize, Math.max(4, cellWidths[column] - padding * 2))
    );
    const height = Math.max(minRowHeight, Math.max(...cells.map((lines) => lines.length)) * lineHeight + padding * 2);
    return { cells, height };
  });
  return {
    width,
    cellWidths,
    fontSize,
    lineHeight,
    padding,
    x0: Number(block.x ?? margin),
    laidOut,
    alignments: tableAlignments(rows, columns, block),
    // A header row a reader cannot tell from the data is not a header. Without
    // an explicit choice the row carries a neutral band and a rule under it.
    headerFill: block.headerFill === undefined ? 'EEF0F2' : block.headerFill,
    borderColor: color(block.borderColor || INK.line),
  };
}

function drawTableRow(flow, block, layout, rowIndex) {
  const { font } = flow;
  const { cellWidths, fontSize, lineHeight, padding } = layout;
  const { cells, height } = layout.laidOut[rowIndex];
  const top = flow.y;
  let x = layout.x0;
  cells.forEach((lines, column) => {
    let fill = '';
    if (rowIndex === 0) fill = layout.headerFill;
    else if (rowIndex % 2 === 0) fill = block.zebraFill;
    flow.page.drawRectangle({
      x,
      y: top - height,
      width: cellWidths[column],
      height,
      ...(fill ? { color: color(fill) } : {}),
      borderWidth: 0.5,
      borderColor: layout.borderColor,
    });
    const textTop = top - Math.max(padding, (height - lines.length * lineHeight) / 2);
    const right = layout.alignments[column] === 'right';
    lines.forEach((line, lineIndex) => {
      const inset = right ? cellWidths[column] - padding - font.widthOfTextAtSize(line, fontSize) : padding;
      flow.page.drawText(line, {
        x: x + Math.max(padding * 0.5, inset),
        y: textTop - lineIndex * lineHeight - fontSize * 0.78 - (lineHeight - fontSize) / 2,
        size: fontSize,
        font,
        color: color(rowIndex === 0 ? block.headerColor || block.color : block.color),
      });
    });
    x += cellWidths[column];
  });
  if (rowIndex === 0) {
    flow.page.drawLine({
      start: { x: layout.x0, y: top - height },
      end: { x, y: top - height },
      thickness: 1.1,
      color: layout.borderColor,
    });
  }
  flow.y = top - height;
}

// A caption names what the table shows, so it is measured with the last
// row: on its own it landed at the top of the next page, citing a table
// the reader had already turned away from.
function captionHeight(following, font, width) {
  if (!following || String(following.type || '').toLowerCase() !== 'caption') return 0;
  const size = Number(following.size || 8.5);
  return (
    wrapText(String(following.text ?? ''), font, size, Math.max(8, width)).length * size * 1.35 +
    Number(following.after ?? 10)
  );
}

function drawTableBlock(flow, block, following) {
  const rows = tableRows(block);
  if (!rows.length) return;
  const layout = tableLayout(flow, block, rows);
  const trailing = captionHeight(following, flow.font, layout.width);
  const last = layout.laidOut.length - 1;
  for (let rowIndex = 0; rowIndex <= last; rowIndex += 1) {
    const needed = layout.laidOut[rowIndex].height + (rowIndex === last ? trailing : 0);
    if (flow.y - needed < flow.margin) {
      flow.newPage();
      if (rowIndex > 0 && block.repeatHeader !== false) drawTableRow(flow, block, layout, 0);
    }
    drawTableRow(flow, block, layout, rowIndex);
  }
  flow.y -= Number(block.after ?? 12);
}
// The horizontal box a text-family block writes into: its own x/width, else
// the page body between the margins.
function textBox(flow, block) {
  return {
    left: Number(block.x ?? flow.margin),
    width: Number(block.width || flow.page.getWidth() - flow.margin * 2),
  };
}

function linesHeight(font, text, size, width, lh = size * 1.35) {
  return wrapText(String(text ?? ''), font, size, Math.max(8, width)).length * lh;
}

// Lines of one role at one x: the shared way a cover's title, a quote, and a caption put words down.
function drawLines(flow, box, text, size, { lh = size * 1.35, x = box.left, width = box.width, tint } = {}) {
  const { font, margin } = flow;
  for (const line of wrapText(String(text ?? ''), font, size, Math.max(8, width))) {
    if (flow.y - lh < margin) flow.newPage();
    flow.page.drawText(line, { x, y: flow.y - size, size, font, color: color(tint) });
    flow.y -= lh;
  }
}

function drawRule(flow, box, thickness, tint) {
  flow.page.drawLine({
    start: { x: box.left, y: flow.y },
    end: { x: box.left + box.width, y: flow.y },
    thickness,
    color: color(tint),
  });
}

function drawRuleBlock(flow, block, box) {
  if (flow.y - 2 < flow.margin) flow.newPage();
  drawRule(flow, box, Number(block.thickness || 0.6), block.color || INK.line);
  flow.y -= Number(block.after ?? 12);
}

// Eyebrow · title · subtitle · meta lines, one rule under the group: the title block of a report's
// first page, not a page of its own — the summary follows on the same page unless a pagebreak says otherwise.
function drawCoverBlock(flow, block, box) {
  const size = Number(block.size || 26);
  const accent = block.accent || INK.accent;
  if (block.eyebrow) {
    drawLines(flow, box, block.eyebrow, 9.5, { lh: 14, tint: accent });
    flow.y -= 4;
  }
  drawLines(flow, box, block.title, size, { lh: size * 1.2, tint: block.color });
  if (block.subtitle) {
    flow.y -= 6;
    const subtitleSize = Number(block.subtitleSize || 13);
    drawLines(flow, box, block.subtitle, subtitleSize, { lh: subtitleSize * 1.4, tint: block.color || '374151' });
  }
  if (Array.isArray(block.meta) && block.meta.length) {
    flow.y -= 8;
    for (const line of block.meta) drawLines(flow, box, line, 9.5, { lh: 14, tint: INK.muted });
  }
  if (block.rule !== false) {
    flow.y -= 12;
    drawRule(flow, box, 0.8, accent);
  }
  flow.y -= Number(block.after ?? 26);
}

// A tinted field the text sits in, its label above the text in the accent: one unit, never split
// across pages — a field that does not fit moves whole to the next page.
function drawCalloutBlock(flow, block, box) {
  const size = Number(block.size || 10.5);
  const lh = Number(block.lineHeight || size * 1.45);
  const pad = Number(block.padding ?? 12);
  const label = String(block.label ?? '').trim();
  const labelSize = 8.5;
  const inner = box.width - pad * 2;
  const height = pad * 2 + (label ? labelSize * 1.4 + 4 : 0) + linesHeight(flow.font, block.text, size, inner, lh);
  keepTogether(flow, height);
  flow.page.drawRectangle({
    x: box.left,
    y: flow.y - height,
    width: box.width,
    height,
    color: color(block.fill || INK.field),
  });
  flow.y -= pad;
  if (label) {
    drawLines(flow, box, label, labelSize, {
      lh: labelSize * 1.4,
      x: box.left + pad,
      width: inner,
      tint: block.labelColor || INK.accent,
    });
    flow.y -= 4;
  }
  drawLines(flow, box, block.text, size, { lh, x: box.left + pad, width: inner, tint: block.color || '1F2937' });
  flow.y -= pad + Number(block.after ?? 14);
}
// Someone else's words: a rule in the accent at the left, the quote a step larger than the body,
// the attribution a caption under it.
function drawQuoteBlock(flow, block, box) {
  const size = Number(block.size || 13);
  const lh = Number(block.lineHeight || size * 1.45);
  const inset = 16;
  const inner = box.width - inset;
  const attribution = block.attribution ? `— ${block.attribution}` : '';
  // The attribution is part of the quote, so the break is decided on both:
  // measured on the words alone, a quote that ended a page left its
  // attribution stranded at the top of the next one, under nothing.
  const height =
    linesHeight(flow.font, block.text, size, inner, lh) +
    (attribution ? 4 + linesHeight(flow.font, attribution, 9, inner, 13) : 0);
  keepTogether(flow, height);
  const top = flow.y;
  drawLines(flow, box, block.text, size, { lh, x: box.left + inset, width: inner, tint: block.color || '1F2937' });
  // The rule spans the quote's lines from the first cap height to the last descender, not one line's ink.
  flow.page.drawLine({
    start: { x: box.left + 1, y: top },
    end: { x: box.left + 1, y: flow.y + (lh - size) / 2 },
    thickness: 2,
    color: color(block.accent || INK.accent),
  });
  if (attribution) {
    flow.y -= 4;
    drawLines(flow, box, attribution, 9, { lh: 13, x: box.left + inset, width: inner, tint: INK.muted });
  }
  flow.y -= Number(block.after ?? 14);
}

function drawCaptionBlock(flow, block, box) {
  const size = Number(block.size || 8.5);
  drawLines(flow, box, block.text, size, { lh: size * 1.35, tint: block.color || INK.muted });
  flow.y -= Number(block.after ?? 10);
}

// Several figures with one cause on one baseline: value over label per peer, equal columns, one rule under.
function drawStatsBlock(flow, block, box) {
  const { font } = flow;
  const items = (Array.isArray(block.items) ? block.items : []).map((item) => ({
    value: String(item?.value ?? ''),
    label: String(item?.label ?? ''),
  }));
  const size = Number(block.size || 22);
  const labelSize = Number(block.labelSize || 9);
  const gap = 12;
  const colW = (box.width - gap * (items.length - 1)) / Math.max(1, items.length);
  const labelH = Math.max(0, ...items.map((item) => linesHeight(font, item.label, labelSize, colW, labelSize * 1.3)));
  const height = size * 1.15 + 4 + labelH + 10;
  keepTogether(flow, height);
  const top = flow.y;
  items.forEach((item, index) => {
    const x = box.left + index * (colW + gap);
    flow.page.drawText(item.value, { x, y: top - size, size, font, color: color(block.accent || INK.accent) });
    let ly = top - size * 1.15 - 4;
    for (const line of wrapText(item.label, font, labelSize, colW)) {
      flow.page.drawText(line, { x, y: ly - labelSize, size: labelSize, font, color: color(INK.muted) });
      ly -= labelSize * 1.3;
    }
  });
  flow.y = top - height;
  if (block.rule !== false) drawRule(flow, box, 0.6, INK.line);
  flow.y -= Number(block.after ?? 16);
}

function drawProseBlock(flow, block, box, type) {
  const heading = type === 'heading';
  const level = Math.min(3, Math.max(1, Number(block.level) || 1));
  const fontSize = Number(block.size || (heading ? HEADING_SIZES[level] : 11));
  // Body copy leads at 1.5× (Hangul needs the air; 1.35 sets Korean lines touching); a heading keeps 1.2×.
  const lineHeight = Number(block.lineHeight || fontSize * (heading ? 1.2 : 1.5));
  // A heading never ends a page: it moves with the first lines of what it opens.
  if (heading && flow.y - lineHeight * 3 < flow.margin) flow.newPage();
  drawLines(flow, box, block.text, fontSize, { lh: lineHeight, tint: block.color });
  flow.y -= Number(block.after ?? (heading ? 8 : 6));
}

const TEXT_BLOCKS = Object.freeze({
  rule: drawRuleBlock,
  cover: drawCoverBlock,
  callout: drawCalloutBlock,
  quote: drawQuoteBlock,
  caption: drawCaptionBlock,
  stats: drawStatsBlock,
});

const FIELD_HEIGHT = 22;
const FIELD_GUTTER = 12;
const FIELD_KEYS = Object.freeze([
  'name',
  'label',
  'value',
  'options',
  'multiline',
  'maxLength',
  'fontSize',
  'labelSize',
  'required',
  'readOnly',
  'width',
  'height',
]);

// A PDF field is a bare box, and pinning it to a page number leaves it behind
// the moment the copy above it grows by a line: the approval boxes ended up on
// the page after their own heading. A field declared as a block travels in the
// flow, so the writer fixes its page and its coordinates where the reader meets
// it. A field given absolute coordinates still goes exactly where it was put,
// which is what stamping a form onto a scan needs.
function fieldSpec(source) {
  const declared = String(source.fieldType || source.type || '').toLowerCase();
  const spec = { type: declared && declared !== 'field' && declared !== 'fieldrow' ? declared : 'text' };
  for (const key of FIELD_KEYS) if (source[key] !== undefined) spec[key] = source[key];
  return spec;
}

function fieldSpecs(block, type) {
  if (type !== 'fieldrow' && type !== 'fieldRow') return [fieldSpec(block)];
  return (Array.isArray(block.items) ? block.items : [])
    .filter((item) => item && typeof item === 'object')
    .map(fieldSpec);
}

/** The fields the blocks declare, so the document embeds a font that covers
 *  their captions and values before anything is drawn. */
function flowedFieldSpecs(blocks) {
  return (Array.isArray(blocks) ? blocks : []).flatMap((block) => {
    const type = blockType(block);
    return type === 'field' || type === 'fieldRow' ? fieldSpecs(block, type) : [];
  });
}

/** The room a field block needs, so the heading that introduces a form is not
 *  left at the foot of a page while its boxes move to the next one. */
function fieldBlockHeight(block) {
  const type = blockType(block);
  if (type !== 'field' && type !== 'fieldRow') return 0;
  const items = fieldSpecs(block, type);
  if (!items.length) return 0;
  const labelSize = Number(block.labelSize) > 0 ? Number(block.labelSize) : 9;
  const height = Number(block.height) > 0 ? Number(block.height) : FIELD_HEIGHT;
  return (items.some((item) => String(item.label ?? '').trim()) ? labelSize * 1.7 : 0) + height;
}

function placeFieldBlock(flow, block, box, type) {
  const items = fieldSpecs(block, type);
  if (!items.length) return;
  const labelSize = Number(block.labelSize) > 0 ? Number(block.labelSize) : 9;
  const height = Number(block.height) > 0 ? Number(block.height) : FIELD_HEIGHT;
  const caption = items.some((item) => String(item.label ?? '').trim()) ? labelSize * 1.7 : 0;
  keepTogether(flow, caption + height);
  const gutter = Number(block.gutter ?? FIELD_GUTTER);
  const share = (box.width - gutter * (items.length - 1)) / items.length;
  const top = flow.y - caption;
  const page = flow.document.getPages().indexOf(flow.page) + 1;
  items.forEach((item, index) => {
    flow.resolvedFields.push({
      labelSize,
      ...item,
      page,
      x: box.left + (share + gutter) * index,
      y: top - height,
      width: Number(item.width) > 0 ? Number(item.width) : share,
      height: Number(item.height) > 0 ? Number(item.height) : height,
    });
  });
  flow.y = top - height - Number(block.after ?? 14);
}

async function flowBlocks(flow, blocks, baseDir) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const type = blockType(block);
    if (type === 'pagebreak') {
      flow.newPage();
      continue;
    }
    const before = spaceBefore(block, type);
    if (before && !atTop(flow)) flow.y -= before;
    // A heading that introduces a form travels with it: the boxes it names must
    // not start on the next page while the words stay behind on this one. The
    // reservation is what the heading itself will consume, plus the form.
    const companion = fieldBlockHeight(blocks[index + 1] || {});
    if (type === 'heading' && companion) {
      const level = Math.min(3, Math.max(1, Number(block.level) || 1));
      const size = Number(block.size || HEADING_SIZES[level]);
      const lineHeight = Number(block.lineHeight || size * 1.2);
      const headingHeight = linesHeight(flow.font, block.text, size, textBox(flow, block).width, lineHeight);
      keepTogether(flow, headingHeight + Number(block.after ?? 8) + companion);
    }
    if (type === 'field' || type === 'fieldRow') placeFieldBlock(flow, block, textBox(flow, block), type);
    else if (type === 'image') await drawImageBlock(flow, block, baseDir);
    else if (type === 'list') drawListBlock(flow, block);
    else if (type === 'table') drawTableBlock(flow, block, blocks[index + 1]);
    else (TEXT_BLOCKS[type] ?? drawProseBlock)(flow, block, textBox(flow, block), type);
  }
}
function pageNumbering(properties, pageCount) {
  return (
    properties.pageNumbers === true ||
    (properties.pageNumbers !== false && String(properties.pageNumbers ?? 'auto') === 'auto' && pageCount > 1)
  );
}

function drawPageFooters(document, properties, { font, margin, numbering }) {
  const footer = String(properties.footer ?? '');
  if (!numbering && !footer) return;
  const pageCount = document.getPageCount();
  const footerSize = Number(properties.footerSize || 9);
  const shade = color(properties.footerColor || '666666');
  const baseline = Math.max(12, margin * 0.5);
  document.getPages().forEach((entry, index) => {
    if (footer) entry.drawText(footer, { x: margin, y: baseline, size: footerSize, font, color: shade });
    if (numbering) {
      const label = `${index + 1} / ${pageCount}`;
      entry.drawText(label, {
        x: entry.getWidth() - margin - font.widthOfTextAtSize(label, footerSize),
        y: baseline,
        size: footerSize,
        font,
        color: shade,
      });
    }
  });
}

function applyDocumentProperties(document, properties) {
  if (properties.title != null) document.setTitle(String(properties.title));
  if (properties.author != null) document.setAuthor(String(properties.author));
  if (properties.subject != null) document.setSubject(String(properties.subject));
  if (properties.keywords != null) {
    document.setKeywords(
      Array.isArray(properties.keywords) ? properties.keywords.map(String) : [String(properties.keywords)]
    );
  }
}

function lintForm(document, fields) {
  const formCheck = lintPdfFormFields(
    fields,
    document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()])
  );
  if (!formCheck.ok) {
    throw new Error(
      `PDF form layout is invalid: ${formCheck.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join(' ')}`
    );
  }
  return formCheck;
}

// A PDF field is a box with no caption of its own. A form whose fields were
// named but never labelled reaches the reader as blank rectangles, so the
// label each field declares is drawn above its box.
async function drawFormFields(document, fields, font) {
  const pages = document.getPages();
  for (const field of fields || []) {
    const label = String(field.label ?? '').trim();
    const page = pages[Math.max(1, Number(field.page) || 1) - 1];
    if (label && page) {
      const labelSize = Number(field.labelSize) > 0 ? Number(field.labelSize) : 9;
      page.drawText(label, {
        x: Number(field.x),
        y: Number(field.y) + Number(field.height) + labelSize * 0.45,
        size: labelSize,
        font,
        color: color('444444'),
      });
    }
    await addFormField(document, field, font);
  }
  if (fields?.length) document.getForm().updateFieldAppearances(font);
}

/**
 * Flow blocks (heading, paragraph, table, image, pagebreak) onto pages, add
 * the form fields, number the pages, and write the file. The font is chosen
 * for the whole text up front so a Korean paragraph and its table share one
 * embedded face.
 */
export async function createPdf(path, { blocks = [], fields = [], properties = {} } = {}) {
  assertPdfBlocks(blocks);
  const document = await PDFDocument.create();
  const margin = Number(properties.margin ?? 54);
  const flowed = flowedFieldSpecs(blocks);
  const coverage = [
    ...(blocks || []).map(blockText),
    ...flowed.map(fieldText),
    String(properties.footer ?? ''),
    ...(fields || []).map(fieldText),
  ].join(' ');
  const { font, fontPath, embedded } = await embedDocumentFont(document, {
    fontPath: properties.fontPath,
    text: coverage,
  });
  const flow = createFlow(document, { size: pageSize(properties), margin, font, background: properties.background });
  await flowBlocks(flow, Array.isArray(blocks) ? blocks : [], dirname(path));
  const pageCount = document.getPageCount();
  const numbering = pageNumbering(properties, pageCount);
  drawPageFooters(document, properties, { font, margin, numbering });
  applyDocumentProperties(document, properties);
  // The flowed fields carry the page the reader met them on; the ones the
  // caller placed by hand keep the coordinates they were given.
  const form = [...flow.resolvedFields, ...(Array.isArray(fields) ? fields : [])];
  const formCheck = lintForm(document, form);
  await drawFormFields(document, form, font);
  await writeFile(path, await document.save(SAVE_OPTIONS));
  return {
    ok: true,
    path,
    pages: pageCount,
    pageNumbers: numbering,
    form: formCheck,
    ...(flow.resolvedFields.length ? { flowedFields: flow.resolvedFields.length } : {}),
    font: { embedded, ...(fontPath ? { path: fontPath } : {}) },
  };
}
