import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { SAVE_OPTIONS, color, embedImage, pageSize, wrapText } from './pdf-draw.mjs';
import { embedBoldFont, embedDocumentFont } from './pdf-fonts.mjs';
import { addFormField, fieldText, lintPdfFormFields } from './pdf-forms.mjs';
import { figureColumnAlignments } from '../shared/column-alignments.mjs';
import { naturalColumnWidths } from '../shared/column-widths.mjs';

// Word's own heading sizes over the 11 pt body, the ladder the Word writer's anatomy sets: at 20 pt a section head
// stood nearly as large as the 26 pt cover title and the page read as a row of titles.
const HEADING_SIZES = Object.freeze({ 1: 16, 2: 13, 3: 12 });

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
      'grid',
      'totalRow',
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
  chart: Object.freeze({
    required: ['categories', 'values'],
    optional: [...FLOW_FIELDS, 'chartType', 'title', 'unit', 'highlight', 'forecast', 'height', 'size', 'accent'],
  }),
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
// It is only the fallback: properties.palette { accent, muted, field, line } (6-digit hex, no '#') overrides it.
const INK = Object.freeze({ muted: '6B7280', accent: '1F6F8B', field: 'EEF2F7', line: 'C9CED6' });
const PALETTE_KEYS = Object.keys(INK);

function resolvePalette(palette) {
  if (palette === undefined || palette === null) return { ink: INK, custom: false };
  if (typeof palette !== 'object' || Array.isArray(palette)) {
    throw new Error(`PDF properties.palette must be an object { ${PALETTE_KEYS.join(', ')} } of 6-digit hex colours.`);
  }
  const faults = [];
  for (const [key, value] of Object.entries(palette)) {
    if (!PALETTE_KEYS.includes(key)) {
      faults.push(`properties.palette.${key} is not a palette role (use ${PALETTE_KEYS.join(', ')}).`);
    } else if (!/^[0-9A-Fa-f]{6}$/.test(String(value))) {
      faults.push(
        `properties.palette.${key} must be a 6-digit hex colour without '#' (for example "${INK[key]}"), got ${JSON.stringify(value)}.`
      );
    }
  }
  if (faults.length) throw new Error(`PDF palette is invalid: ${faults.join(' ')}`);
  return { ink: Object.freeze({ ...INK, ...palette }), custom: true };
}

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
  if (type === 'chart') faults.push(...chartShapeFaults(block, at));
  return faults;
}

function chartShapeFaults(block, at) {
  const faults = [];
  const { categories, values } = block;
  if (categories !== undefined && !Array.isArray(categories)) {
    faults.push(`PDF ${at} (chart) categories must be an array of labels.`);
  }
  if (
    values !== undefined &&
    !(
      Array.isArray(values) &&
      values.length > 0 &&
      values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    )
  ) {
    faults.push(`PDF ${at} (chart) values must be a non-empty array of numbers, zero or more.`);
  } else if (Array.isArray(categories) && Array.isArray(values) && categories.length !== values.length) {
    faults.push(
      `PDF ${at} (chart) has ${categories.length} categories and ${values.length} values; give one value per category.`
    );
  }
  if (block.chartType !== undefined && !['bar', 'column'].includes(String(block.chartType).toLowerCase())) {
    faults.push(`PDF ${at} (chart) chartType is bar (bars across) or column (bars upright).`);
  }
  // A projection named wrong would be drawn as a counted figure without a word: every one must name a bar.
  if (block.forecast !== undefined && Array.isArray(categories)) {
    const unknown = forecastEntries(block).filter((entry) => forecastIndex(categories, entry) < 0);
    if (unknown.length) {
      faults.push(
        `PDF ${at} (chart) forecast names ${unknown.map((entry) => JSON.stringify(entry)).join(', ')}, not a category or its index; name the projected bars as categories names them.`
      );
    }
  }
  return faults;
}

// forecast: the bars that are projections, as an index, a category, or a list of them.
function forecastEntries(block) {
  if (block.forecast === undefined || block.forecast === null) return [];
  return Array.isArray(block.forecast) ? block.forecast : [block.forecast];
}

function forecastIndex(categories, entry) {
  if (typeof entry === 'number') return Number.isInteger(entry) && entry >= 0 && entry < categories.length ? entry : -1;
  return categories.map((category) => String(category ?? '')).indexOf(String(entry));
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
  if (type === 'chart')
    return [block.title, block.unit, ...(Array.isArray(block.categories) ? block.categories : [])]
      .map((value) => String(value ?? ''))
      .join(' ');
  if (type === 'image' || type === 'pagebreak' || type === 'rule') return '';
  return String(block?.text ?? '');
}

/**
 * The page cursor the block renderers share: the current page, the baseline
 * `y` still free on it, and `newPage()` which opens the next page with the
 * document background and resets the cursor under the top margin.
 */
function createFlow(document, { size, margin, font, bold, background, palette }) {
  const resolved = resolvePalette(palette);
  const flow = {
    document,
    margin,
    font,
    bold: bold || font,
    page: null,
    y: 0,
    resolvedFields: [],
    ink: resolved.ink,
    customPalette: resolved.custom,
  };
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
  // A quote is set apart from what it follows as from what follows it: with no space of its own, one under a list
  // sat as close to the last item as the items to each other and read as one more of them. A chart under a paragraph
  // sat on its last line the same way.
  if (type === 'quote' || type === 'chart') return 6;
  if (type !== 'heading') return 0;
  const level = Math.min(3, Math.max(1, Number(block.level) || 1));
  return Math.round(Number(block.size || HEADING_SIZES[level]) * 0.8);
}

// The picture a block places, embedded once per document: the heading before it measures it, and drawImageBlock
// draws the same embedding rather than a second copy of the image.
async function blockImage(flow, block, baseDir) {
  flow.images ||= new Map();
  if (!flow.images.has(block))
    flow.images.set(block, await embedImage(flow.document, resolve(baseDir, String(block.path || ''))));
  return flow.images.get(block);
}

// The picture's placed size and the room it takes with the caption that names it (captionHeight): a caption on its
// own opened the next page under nothing, as a table's once did.
async function imageUnit(flow, block, baseDir, following) {
  const { margin } = flow;
  const placed = await blockImage(flow, block, baseDir);
  const width = Number(block.width || Math.min(placed.width, flow.page.getWidth() - margin * 2));
  const height = Number(block.height || (placed.height * width) / placed.width);
  const trailing = captionHeight(following, flow.font, flow.page.getWidth() - margin * 2);
  return { placed, width, height, needed: height + (trailing ? Number(block.after ?? 12) + trailing : 0) };
}

async function drawImageBlock(flow, block, baseDir, following) {
  const { margin } = flow;
  const { placed, width, height, needed } = await imageUnit(flow, block, baseDir, following);
  if (flow.y - needed < margin && !atTop(flow)) flow.newPage();
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
// under its own text rather than under the bullet. The measured lines serve the
// drawing and the room a heading keeps for the list it opens.
function listLayout(flow, block) {
  const { font, margin } = flow;
  const items = (Array.isArray(block.items) ? block.items : []).map((value) => String(value ?? ''));
  const fontSize = Number(block.size || 11);
  // The same 1.5× lead as body copy: at 1.35 Hangul items set tighter than the paragraph above them.
  const lineHeight = Number(block.lineHeight || fontSize * 1.5);
  const ordered = block.ordered === true;
  const markers = items.map((_, itemIndex) => (ordered ? `${itemIndex + 1}.` : String(block.marker ?? '•')));
  const markerWidth = (marker) => font.widthOfTextAtSize(marker, fontSize);
  const widestMarker = Math.max(0, ...markers.map(markerWidth));
  // The text starts past the widest marker with half an em to spare, and the numbers end together on their periods:
  // at a fixed 1.4 em, "10." ran into its item's first word ("10.10단계").
  const indent = Number(block.indent ?? Math.max(fontSize * 1.4, widestMarker + fontSize * 0.5));
  const left = Number(block.x ?? margin);
  const textWidth = Number(block.width || flow.page.getWidth() - margin - left) - indent;
  const lines = items.map((item) => wrapText(item, font, fontSize, Math.max(8, textWidth)));
  const height = (from, through) =>
    lines.slice(from, through + 1).reduce((sum, itemLines) => sum + itemLines.length * lineHeight, 0);
  return { items, fontSize, lineHeight, ordered, markers, markerWidth, widestMarker, indent, left, lines, height };
}

// The last item a page break may not separate from the one at `index`. A list never leaves one item alone at a page
// edge — the first two open a page together and the last two close one, the widow and orphan rule a table's rows
// keep — so a list of three or fewer moves as one. The last of three bullets had opened the next page by itself.
function listKeepThrough(count, index) {
  if (count <= 3) return index === 0 ? count - 1 : index;
  if (index === 0) return 1;
  return index === count - 2 ? count - 1 : index;
}

// The room the first unit of a list takes, which the heading that opens it keeps beside itself.
function listLeadHeight(flow, block) {
  if (blockType(block) !== 'list') return 0;
  const layout = listLayout(flow, block);
  return layout.items.length ? layout.height(0, listKeepThrough(layout.items.length, 0)) : 0;
}

function drawListBlock(flow, block) {
  const { font, margin } = flow;
  const layout = listLayout(flow, block);
  const { items, fontSize, lineHeight, ordered, markers, markerWidth, widestMarker, indent, left } = layout;
  const tint = color(block.color);
  items.forEach((_item, itemIndex) => {
    const marker = markers[itemIndex];
    const markerX = ordered ? left + widestMarker - markerWidth(marker) : left;
    const lines = layout.lines[itemIndex];
    // One item is one unit: broken line by line, an item that met the foot
    // of a page left its marker and first line there with the rest overleaf,
    // where no bullet introduces them.
    keepTogether(flow, layout.height(itemIndex, listKeepThrough(items.length, itemIndex)));
    lines.forEach((line, lineIndex) => {
      if (flow.y - lineHeight < margin) flow.newPage();
      flow.y -= lineHeight;
      if (lineIndex === 0) flow.page.drawText(marker, { x: markerX, y: flow.y, size: fontSize, font, color: tint });
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

// Cells wrap inside their column and the row grows to the tallest cell,
// so a long value never spills into its neighbour.
function tableLayout(flow, block, rows) {
  const { font, bold, margin } = flow;
  // headers:false is a table with no header row (a totals block under the line items); otherwise the first
  // row — the headers, or rows[0] when none are given — is the header.
  const header = block.headers !== false;
  const total = block.totalRow === true && rows.length > (header ? 1 : 0);
  const faceOf = (rowIndex) => ((header && rowIndex === 0) || (total && rowIndex === rows.length - 1) ? bold : font);
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const width = Number(block.width || flow.page.getWidth() - margin * 2);
  const fontSize = Number(block.fontSize || 9);
  const lineHeight = fontSize * 1.3;
  const padding = 4;
  // Words after figures start a padding further in: the figures end on their column's right edge, and "30분" and
  // "점검 필요" beside it read as one cell (the Excel composer indents that column for the same reason).
  const alignments = figureColumnAlignments(rows, columns, block.columnAlignments, header);
  const leads = alignments.map((alignment, column) =>
    column > 0 && alignments[column - 1] === 'right' && alignment !== 'right' ? padding : 0
  );
  // Undeclared widths follow the text, the Word writer's rule (naturalColumnWidths).
  const measure = (text, rowIndex, column) =>
    faceOf(rowIndex).widthOfTextAtSize(text, fontSize) + padding * 2 + leads[column];
  const weights =
    Array.isArray(block.columnWidths) && block.columnWidths.length === columns
      ? block.columnWidths.map((value) => Math.max(0, Number(value) || 0))
      : naturalColumnWidths(rows, measure, width) || Array(columns).fill(1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || columns;
  const cellWidths = weights.map((weight) => width * (weight / totalWeight));
  const minRowHeight = Number(block.rowHeight || 24);
  // The space over a row's first line and under its last: a one-line row's text centred in the row, and every
  // row after it keeps the same inset, so a wrapped row grows by its lines and nothing else.
  const inset = Math.max(padding, (minRowHeight - lineHeight) / 2);
  const laidOut = rows.map((row, rowIndex) => {
    const face = faceOf(rowIndex);
    const cells = Array.from({ length: columns }, (_, column) =>
      wrapText(row[column] ?? '', face, fontSize, Math.max(4, cellWidths[column] - padding * 2 - leads[column]))
    );
    const height = Math.max(minRowHeight, Math.max(...cells.map((lines) => lines.length)) * lineHeight + inset * 2);
    return { cells, height, face };
  });
  return {
    width,
    cellWidths,
    fontSize,
    lineHeight,
    padding,
    inset,
    header,
    total,
    // The table anatomy the Word writer draws (docx skill §4): a bold header on a rule, hairlines between the
    // rows, no vertical rules; grid:true keeps the full cell grid for a form-like table.
    grid: block.grid === true,
    x0: Number(block.x ?? margin),
    laidOut,
    alignments,
    leads,
    // A header row a reader cannot tell from the data is not a header. Without
    // an explicit choice the row carries a neutral band and a rule under it.
    headerFill: block.headerFill === undefined ? (flow.customPalette ? flow.ink.field : 'EEF0F2') : block.headerFill,
    borderColor: color(block.borderColor || flow.ink.line),
  };
}

function drawTableRow(flow, block, layout, rowIndex) {
  const { cellWidths, fontSize, lineHeight, padding, inset } = layout;
  const { cells, height, face } = layout.laidOut[rowIndex];
  const isHeader = layout.header && rowIndex === 0;
  const isTotal = layout.total && rowIndex === layout.laidOut.length - 1;
  const top = flow.y;
  const rule = (y, thickness) =>
    flow.page.drawLine({
      start: { x: layout.x0, y },
      end: { x: layout.x0 + layout.width, y },
      thickness,
      color: layout.borderColor,
    });
  let x = layout.x0;
  cells.forEach((lines, column) => {
    let fill = '';
    if (isHeader) fill = layout.headerFill;
    else if (rowIndex % 2 === 0) fill = block.zebraFill;
    if (layout.grid || fill) {
      flow.page.drawRectangle({
        x,
        y: top - height,
        width: cellWidths[column],
        height,
        ...(fill ? { color: color(fill) } : {}),
        ...(layout.grid ? { borderWidth: 0.5, borderColor: layout.borderColor } : {}),
      });
    }
    // The Word writer's anatomy: a body row reads from its first line — every cell starts it at the same height, where
    // a one-line cell centred beside a wrapped one had floated between its two lines — and the header sits on its rule.
    const textTop = isHeader ? top - (height - inset - lines.length * lineHeight) : top - inset;
    const right = layout.alignments[column] === 'right';
    lines.forEach((line, lineIndex) => {
      const textLeft = right
        ? cellWidths[column] - padding - face.widthOfTextAtSize(line, fontSize)
        : padding + layout.leads[column];
      flow.page.drawText(line, {
        x: x + Math.max(padding * 0.5, textLeft),
        y: textTop - lineIndex * lineHeight - fontSize * 0.78 - (lineHeight - fontSize) / 2,
        size: fontSize,
        font: face,
        color: color(isHeader ? block.headerColor || block.color : block.color),
      });
    });
    x += cellWidths[column];
  });
  // The total closes the column it sums: a stronger rule over it, in its bold face.
  if (isTotal) rule(top, 1.1);
  if (isHeader) rule(top - height, 1.1);
  else if (!layout.grid) rule(top - height, 0.5);
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

// The last row a page break may not separate from the one at `index`, the Word writer's rule: the header travels with
// the first two rows and the last two rows travel together, and a table of six rows or fewer moves whole. Row by row,
// the last of 24 weeks opened the next page alone under its repeated header.
function tableKeepThrough(count, index) {
  if (count <= 6) return index === 0 ? count - 1 : index;
  if (index === 0) return 2;
  return index === count - 2 ? count - 1 : index;
}

function tableUnitHeight(layout, from, through) {
  return layout.laidOut.slice(from, through + 1).reduce((sum, row) => sum + row.height, 0);
}

// The first lines of a paragraph a page may not leave behind (drawLines widows): the whole of a short one, else two.
function paragraphLeadHeight(flow, block) {
  if (blockType(block) !== 'paragraph') return 0;
  const size = Number(block.size || 11);
  const lh = Number(block.lineHeight || size * 1.5);
  const count = wrapText(String(block.text ?? ''), flow.font, size, Math.max(8, textBox(flow, block).width)).length;
  return (count <= 3 ? count : 2) * lh;
}

// The room the first unit of a table takes, which the heading that opens it keeps beside itself.
function tableLeadHeight(flow, block) {
  if (blockType(block) !== 'table') return 0;
  const rows = tableRows(block);
  if (!rows.length) return 0;
  return tableUnitHeight(tableLayout(flow, block, rows), 0, tableKeepThrough(rows.length, 0));
}

function drawTableBlock(flow, block, following) {
  const rows = tableRows(block);
  if (!rows.length) return;
  const layout = tableLayout(flow, block, rows);
  const trailing = captionHeight(following, flow.font, layout.width);
  const last = layout.laidOut.length - 1;
  for (let rowIndex = 0; rowIndex <= last; rowIndex += 1) {
    const through = tableKeepThrough(last + 1, rowIndex);
    const needed = tableUnitHeight(layout, rowIndex, through) + (through === last ? trailing : 0);
    if (flow.y - needed < flow.margin && !atTop(flow)) {
      flow.newPage();
      if (rowIndex > 0 && layout.header && block.repeatHeader !== false) drawTableRow(flow, block, layout, 0);
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
// widows: a paragraph that meets the foot of a page leaves at least two lines there and carries at least two over;
// one of three lines or fewer moves whole — a single line had been left at the foot, or alone atop the next page.
function drawLines(
  flow,
  box,
  text,
  size,
  { lh = size * 1.35, x = box.left, width = box.width, tint, face, widows = false } = {}
) {
  const { margin } = flow;
  const font = face || flow.font;
  const lines = wrapText(String(text ?? ''), font, size, Math.max(8, width));
  let splitAt = -1;
  const room = Math.floor((flow.y - margin) / lh + 1e-6);
  if (widows && !atTop(flow) && room < lines.length) {
    if (room < 2 || lines.length <= 3) flow.newPage();
    else if (lines.length - room < 2) splitAt = room - 1;
  }
  lines.forEach((line, index) => {
    if (index === splitAt || flow.y - lh < margin) flow.newPage();
    flow.page.drawText(line, { x, y: flow.y - size, size, font, color: color(tint) });
    flow.y -= lh;
  });
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
  drawRule(flow, box, Number(block.thickness || 0.6), block.color || flow.ink.line);
  flow.y -= Number(block.after ?? 12);
}

// Eyebrow · title · subtitle · meta lines, one rule under the group: the title block of a report's
// first page, not a page of its own — the summary follows on the same page unless a pagebreak says otherwise.
function drawCoverBlock(flow, block, box) {
  const size = Number(block.size || 26);
  const accent = block.accent || flow.ink.accent;
  if (block.eyebrow) {
    drawLines(flow, box, block.eyebrow, 9.5, { lh: 14, tint: accent });
    flow.y -= 4;
  }
  drawLines(flow, box, block.title, size, { lh: size * 1.2, tint: block.color, face: flow.bold });
  if (block.subtitle) {
    flow.y -= 6;
    const subtitleSize = Number(block.subtitleSize || 13);
    drawLines(flow, box, block.subtitle, subtitleSize, { lh: subtitleSize * 1.4, tint: block.color || '374151' });
  }
  if (Array.isArray(block.meta) && block.meta.length) {
    flow.y -= 8;
    for (const line of block.meta) drawLines(flow, box, line, 9.5, { lh: 14, tint: flow.ink.muted });
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
    color: color(block.fill || flow.ink.field),
  });
  flow.y -= pad;
  if (label) {
    drawLines(flow, box, label, labelSize, {
      lh: labelSize * 1.4,
      x: box.left + pad,
      width: inner,
      tint: block.labelColor || flow.ink.accent,
      face: flow.bold,
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
  // The dash is drawn here, so one the author already typed is not doubled.
  const speaker = String(block.attribution ?? '')
    .replace(/^[\s—–-]+/, '')
    .trim();
  const attribution = speaker ? `— ${speaker}` : '';
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
    color: color(block.accent || flow.ink.accent),
  });
  if (attribution) {
    flow.y -= 4;
    drawLines(flow, box, attribution, 9, { lh: 13, x: box.left + inset, width: inner, tint: flow.ink.muted });
  }
  flow.y -= Number(block.after ?? 14);
}

function drawCaptionBlock(flow, block, box) {
  const size = Number(block.size || 8.5);
  drawLines(flow, box, block.text, size, { lh: size * 1.35, tint: block.color || flow.ink.muted });
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
    flow.page.drawText(item.value, {
      x,
      y: top - size,
      size,
      font: flow.bold,
      color: color(block.accent || flow.ink.accent),
    });
    let ly = top - size * 1.15 - 4;
    for (const line of wrapText(item.label, font, labelSize, colW)) {
      flow.page.drawText(line, { x, y: ly - labelSize, size: labelSize, font, color: color(flow.ink.muted) });
      ly -= labelSize * 1.3;
    }
  });
  flow.y = top - height;
  if (block.rule !== false) drawRule(flow, box, 0.6, flow.ink.line);
  flow.y -= Number(block.after ?? 16);
}

// A bar chart the page draws itself, in the document's face and accent: categories and one series of values, each
// value labelled at its bar and the axis left quiet (no grid; the labels carry the numbers). chartType 'bar' lays the
// bars across, a ranking whose names read on the left; 'column' stands them up, periods from left to right. highlight
// (an index or a category) takes the accent and the other bars recede, so the page says which bar it is about.
// forecast (an index, a category, or a list of them) draws those bars as projections: a pale fill inside a dashed
// outline, their values muted — a projected quarter had stood in the same grey as the counted ones.
function chartLayout(flow, block, box) {
  const { font, bold } = flow;
  const size = Number(block.size || 9.5);
  const categories = block.categories.map((category) => String(category ?? ''));
  const values = block.values.map(Number);
  const unit = String(block.unit ?? '');
  const labels = values.map((value) => `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit}`);
  const across = String(block.chartType || 'bar').toLowerCase() !== 'column';
  const titleSize = size + 1;
  const titleH = block.title ? linesHeight(bold, block.title, titleSize, box.width, titleSize * 1.3) + 6 : 0;
  let highlight = -1;
  if (typeof block.highlight === 'number') highlight = block.highlight;
  else if (block.highlight !== undefined) highlight = categories.indexOf(String(block.highlight));
  const forecast = new Set(forecastEntries(block).map((entry) => forecastIndex(categories, entry)));
  const base = { size, categories, values, labels, titleSize, titleH, highlight, forecast, across };
  if (across) {
    // The names column is as wide as its longest name, a third of the width at most, where a longer name wraps.
    const labelW = Math.min(
      box.width / 3,
      Math.max(...categories.map((name) => font.widthOfTextAtSize(name, size))) + 10
    );
    const valueW = Math.max(...labels.map((label) => bold.widthOfTextAtSize(label, size))) + 8;
    const names = categories.map((name) => wrapText(name, font, size, Math.max(8, labelW - 10)));
    const rows = names.map((lines) => Math.max(size * 2.4, lines.length * size * 1.25 + 8));
    return { ...base, labelW, valueW, names, rows, height: titleH + rows.reduce((sum, row) => sum + row, 0) };
  }
  const plotH = Number(block.height || 150);
  const colW = box.width / Math.max(1, values.length);
  const names = categories.map((name) => wrapText(name, font, size, Math.max(8, colW - 6)));
  const nameH = Math.max(1, ...names.map((lines) => lines.length)) * size * 1.3;
  return { ...base, plotH, colW, names, height: titleH + size * 1.6 + plotH + 6 + nameH };
}

// The chart and the caption under it, measured as one unit: a caption alone atop the next page cites nothing.
function chartUnitHeight(flow, block, following) {
  if (blockType(block) !== 'chart') return 0;
  const box = textBox(flow, block);
  const trailing = captionHeight(following, flow.font, box.width);
  return chartLayout(flow, block, box).height + (trailing ? Number(block.after ?? 10) + trailing : 0);
}

function drawChartBlock(flow, block, following) {
  const box = textBox(flow, block);
  const layout = chartLayout(flow, block, box);
  keepTogether(flow, chartUnitHeight(flow, block, following));
  const { page, font, bold } = flow;
  const { size, values, labels, highlight, forecast, names } = layout;
  const accent = color(block.accent || flow.ink.accent);
  const lit = (index) => highlight < 0 || index === highlight;
  // A projected bar keeps its colour at a third of its strength inside a dashed outline, and its value reads muted.
  const bar = (index) => {
    const fill = lit(index) ? accent : color(flow.ink.line);
    if (!forecast.has(index)) return { color: fill };
    const outline = lit(index) && highlight >= 0 ? accent : color(flow.ink.muted);
    return { color: fill, opacity: 0.35, borderColor: outline, borderWidth: 0.8, borderDashArray: [2.4, 1.6] };
  };
  const labelInk = (index) => (lit(index) && !forecast.has(index) ? color('1F2937') : color(flow.ink.muted));
  if (block.title) {
    drawLines(flow, box, block.title, layout.titleSize, { lh: layout.titleSize * 1.3, face: bold, tint: '1F2937' });
    flow.y -= 6;
  }
  const scale = Math.max(...values, 0) || 1;
  const ink = color('1F2937');
  if (layout.across) {
    const track = Math.max(40, box.width - layout.labelW - layout.valueW);
    const left = box.left + layout.labelW;
    const top = flow.y;
    values.forEach((value, index) => {
      const rowH = layout.rows[index];
      const mid = flow.y - rowH / 2;
      // The name stands against the bars, its lines centred on the bar.
      names[index].forEach((line, lineIndex) => {
        const y = mid + ((names[index].length - 1) / 2 - lineIndex) * size * 1.25 - size * 0.35;
        page.drawText(line, { x: left - 10 - font.widthOfTextAtSize(line, size), y, size, font, color: ink });
      });
      const width = (value / scale) * track;
      const barH = Math.min(rowH - 6, size * 1.5);
      if (width > 0) {
        page.drawRectangle({
          x: left,
          y: mid - barH / 2,
          width,
          height: barH,
          ...bar(index),
        });
      }
      page.drawText(labels[index], {
        x: left + width + 4,
        y: mid - size * 0.35,
        size,
        font: lit(index) && highlight >= 0 ? bold : font,
        color: labelInk(index),
      });
      flow.y -= rowH;
    });
    page.drawLine({ start: { x: left, y: top }, end: { x: left, y: flow.y }, thickness: 0.6, color: color(flow.ink.line) });
  } else {
    const baseline = flow.y - size * 1.6 - layout.plotH;
    values.forEach((value, index) => {
      const x = box.left + index * layout.colW;
      const barW = Math.min(layout.colW * 0.56, 64);
      const height = (value / scale) * layout.plotH;
      if (height > 0) {
        page.drawRectangle({
          x: x + (layout.colW - barW) / 2,
          y: baseline,
          width: barW,
          height,
          ...bar(index),
        });
      }
      const face = lit(index) && highlight >= 0 ? bold : font;
      const label = labels[index];
      page.drawText(label, {
        x: x + (layout.colW - face.widthOfTextAtSize(label, size)) / 2,
        y: baseline + height + 4,
        size,
        font: face,
        color: labelInk(index),
      });
      names[index].forEach((line, lineIndex) => {
        page.drawText(line, {
          x: x + (layout.colW - font.widthOfTextAtSize(line, size)) / 2,
          y: baseline - 6 - size - lineIndex * size * 1.3,
          size,
          font,
          color: ink,
        });
      });
    });
    page.drawLine({
      start: { x: box.left, y: baseline },
      end: { x: box.left + box.width, y: baseline },
      thickness: 0.6,
      color: color(flow.ink.line),
    });
    flow.y = flow.y - (layout.height - layout.titleH);
  }
  flow.y -= Number(block.after ?? 10);
}

function drawProseBlock(flow, block, box, type) {
  const heading = type === 'heading';
  const level = Math.min(3, Math.max(1, Number(block.level) || 1));
  const fontSize = Number(block.size || (heading ? HEADING_SIZES[level] : 11));
  // Body copy leads at 1.5× (Hangul needs the air; 1.35 sets Korean lines touching); a heading keeps 1.2×.
  const lineHeight = Number(block.lineHeight || fontSize * (heading ? 1.2 : 1.5));
  // A heading never ends a page: it moves with the first lines of what it opens.
  if (heading && flow.y - lineHeight * 3 < flow.margin) flow.newPage();
  drawLines(flow, box, block.text, fontSize, {
    lh: lineHeight,
    tint: block.color,
    face: heading ? flow.bold : flow.font,
    widows: !heading,
  });
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

// A checkbox or a radio is a square with its label beside it, the way a form is read and ticked; stretched to the
// column like a text box it drew a 350 pt bar with the tick floating in its middle.
const MARK_SIZE = 14;
// A radio group with its options is a question: its label above, each option a mark with its own words beside it
// in one row. Drawn like a single mark, every option sat on the same spot under the question alone — one circle,
// no choices, and the lint reported the group's buttons overlapping each other.
const isChoiceGroup = (item) =>
  String(item?.type || '') === 'radio' &&
  Array.isArray(item.options) &&
  item.options.length > 0 &&
  !(Number(item.width) > 0);
const isMarkField = (item) =>
  ['checkbox', 'radio'].includes(String(item?.type || '')) && !(Number(item.width) > 0) && !isChoiceGroup(item);

// The row's geometry, shared by the reservation and the placement: the caption band above typed boxes and above a
// question's options, and a row of marks only as tall as a mark and its label.
function fieldRowGeometry(block, items) {
  const labelSize = Number(block.labelSize) > 0 ? Number(block.labelSize) : 9;
  const marksOnly = items.every((item) => isMarkField(item) || isChoiceGroup(item));
  let height = FIELD_HEIGHT;
  if (marksOnly) height = Math.max(MARK_SIZE + 4, labelSize * 1.8);
  else if (Number(block.height) > 0) height = Number(block.height);
  const caption = items.some((item) => !isMarkField(item) && String(item.label ?? '').trim()) ? labelSize * 1.7 : 0;
  return { labelSize, height, caption };
}

// A question's options in a row from x: each mark, its words beside it, then a gap before the next.
function choiceOptions(flow, item, x, y, labelSize) {
  let at = x;
  return item.options.map((option) => {
    const value = String(option?.value ?? option);
    const label = String(option?.label ?? option?.value ?? option);
    const placed = { value, label, x: at, y };
    at += MARK_SIZE + 6 + flow.font.widthOfTextAtSize(label, labelSize + 1) + 18;
    return placed;
  });
}

/** The room a field block needs, so the heading that introduces a form is not
 *  left at the foot of a page while its boxes move to the next one. */
function fieldBlockHeight(block) {
  const type = blockType(block);
  if (type !== 'field' && type !== 'fieldRow') return 0;
  const items = fieldSpecs(block, type);
  if (!items.length) return 0;
  const { height, caption } = fieldRowGeometry(block, items);
  return caption + height;
}

function placeFieldBlock(flow, block, box, type, following) {
  const items = fieldSpecs(block, type);
  if (!items.length) return;
  const { labelSize, height, caption } = fieldRowGeometry(block, items);
  // A caption under the form's last row travels with it, as it does under a table: on its own it opened a page of
  // nothing but one grey line.
  keepTogether(flow, caption + height + Number(block.after ?? 14) + captionHeight(following, flow.font, box.width));
  const gutter = Number(block.gutter ?? FIELD_GUTTER);
  const share = (box.width - gutter * (items.length - 1)) / items.length;
  const top = flow.y - caption;
  const page = flow.document.getPages().indexOf(flow.page) + 1;
  items.forEach((item, index) => {
    const x = box.left + (share + gutter) * index;
    if (isMarkField(item)) {
      flow.resolvedFields.push({
        labelSize,
        ...item,
        page,
        x,
        y: top - height + (height - MARK_SIZE) / 2,
        width: MARK_SIZE,
        height: MARK_SIZE,
        labelBeside: true,
      });
      return;
    }
    if (isChoiceGroup(item)) {
      const y = top - height + (height - MARK_SIZE) / 2;
      flow.resolvedFields.push({
        labelSize,
        ...item,
        page,
        x,
        y,
        width: MARK_SIZE,
        height: MARK_SIZE,
        options: choiceOptions(flow, item, x, y, labelSize),
      });
      return;
    }
    flow.resolvedFields.push({
      labelSize,
      ...item,
      page,
      x,
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
    // reservation is what the heading itself will consume, plus the form — or
    // the first unit of the list, table, or paragraph it opens, or the picture
    // it introduces with that picture's caption, each of which keeps together itself.
    const next = blocks[index + 1] || {};
    let companion = 0;
    if (type === 'heading') {
      companion =
        fieldBlockHeight(next) ||
        listLeadHeight(flow, next) ||
        tableLeadHeight(flow, next) ||
        paragraphLeadHeight(flow, next) ||
        chartUnitHeight(flow, next, blocks[index + 2]);
      if (!companion && blockType(next) === 'image') {
        companion = (await imageUnit(flow, next, baseDir, blocks[index + 2])).needed;
      }
    }
    if (companion) {
      const level = Math.min(3, Math.max(1, Number(block.level) || 1));
      const size = Number(block.size || HEADING_SIZES[level]);
      const lineHeight = Number(block.lineHeight || size * 1.2);
      const headingHeight = linesHeight(flow.font, block.text, size, textBox(flow, block).width, lineHeight);
      keepTogether(flow, headingHeight + Number(block.after ?? 8) + companion);
    }
    if (type === 'field' || type === 'fieldRow')
      placeFieldBlock(flow, block, textBox(flow, block), type, blocks[index + 1]);
    else if (type === 'image') await drawImageBlock(flow, block, baseDir, blocks[index + 1]);
    else if (type === 'list') drawListBlock(flow, block);
    else if (type === 'table') drawTableBlock(flow, block, blocks[index + 1]);
    else if (type === 'chart') drawChartBlock(flow, block, blocks[index + 1]);
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

export function applyDocumentProperties(document, properties) {
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
        // A mark's label reads beside its square, on the square's middle; a typed box's sits above it.
        x: field.labelBeside ? Number(field.x) + Number(field.width) + 6 : Number(field.x),
        y: field.labelBeside
          ? Number(field.y) + (Number(field.height) - labelSize * 0.72) / 2
          : Number(field.y) + Number(field.height) + labelSize * 0.45,
        size: field.labelBeside ? labelSize + 1 : labelSize,
        font,
        color: color(field.labelBeside ? '1F2937' : '444444'),
      });
    }
    // A question's options each carry their own words beside their mark.
    if (page) {
      const labelSize = Number(field.labelSize) > 0 ? Number(field.labelSize) : 9;
      for (const option of Array.isArray(field.options) ? field.options : []) {
        if (
          !option ||
          typeof option !== 'object' ||
          !String(option.label ?? '').trim() ||
          !Number.isFinite(Number(option.x))
        )
          continue;
        page.drawText(String(option.label), {
          x: Number(option.x) + Number(field.width) + 6,
          y: Number(option.y) + (Number(field.height) - labelSize * 0.72) / 2,
          size: labelSize + 1,
          font,
          color: color('1F2937'),
        });
      }
    }
    const { labelBeside, ...control } = field;
    await addFormField(document, control, font);
  }
  if (fields?.length) document.getForm().updateFieldAppearances(font);
}

/**
 * One chart block on a page of its own size — `width` points wide, as tall as the chart — for a document that places
 * the chart as a picture (a Word report): the same drawing the PDF chart block makes, cut to the chart.
 */
export async function createChartPdf(path, block, { width = 420, palette } = {}) {
  const chart = { ...block, type: 'chart', x: 0, width, before: 0, after: 0 };
  assertPdfBlocks([chart]);
  const document = await PDFDocument.create();
  const text = blockText(chart);
  const { font, fontPath } = await embedDocumentFont(document, { text });
  const bold = await embedBoldFont(document, { font, fontPath, text });
  const pad = 4;
  const { height } = chartLayout({ font, bold }, chart, { left: 0, width });
  const flow = createFlow(document, {
    size: [width + pad * 2, height + pad * 2],
    margin: pad,
    font,
    bold,
    background: 'FFFFFF',
    palette,
  });
  drawChartBlock(flow, { ...chart, x: pad }, null);
  await writeFile(path, await document.save(SAVE_OPTIONS));
  return { path, width: width + pad * 2, height: height + pad * 2 };
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
  const bold = await embedBoldFont(document, { font, fontPath, text: coverage });
  const flow = createFlow(document, {
    size: pageSize(properties),
    margin,
    font,
    bold,
    background: properties.background,
    palette: properties.palette,
  });
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
