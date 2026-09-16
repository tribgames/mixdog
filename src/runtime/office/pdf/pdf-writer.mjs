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
});

// The document's own neutrals and accent (the same values the docx skill's table anatomy uses), so a
// callout field, a quote rule, and a caption read as one system without the writer naming a hex.
const INK = Object.freeze({ muted: '6B7280', accent: '1F6F8B', field: 'EEF2F7', line: 'C9CED6' });

function blockType(block) {
  return String(block?.type || 'paragraph').toLowerCase();
}

export function assertPdfBlocks(blocks) {
  const faults = [];
  const kinds = Object.keys(BLOCK_FIELDS);
  (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
    const at = `block ${index + 1}`;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      faults.push(`PDF ${at} must be an object with type: ${kinds.join(', ')}.`);
      return;
    }
    if (block.kind !== undefined && block.type === undefined) {
      faults.push(`PDF ${at} names its block with kind; the field is type: { type: '${String(block.kind)}' }.`);
      return;
    }
    const type = blockType(block);
    const definition = BLOCK_FIELDS[type];
    if (!definition) {
      faults.push(`PDF ${at} has unknown type "${type}". Use one of: ${kinds.join(', ')}.`);
      return;
    }
    const allowed = new Set(['type', ...definition.required, ...definition.optional]);
    const unknown = Object.keys(block).filter((field) => !allowed.has(field));
    if (unknown.length) {
      faults.push(
        `PDF ${at} (${type}) has unknown field(s): ${unknown.join(', ')}. ${type} takes: ${[...allowed].join(', ')}.`
      );
    }
    const missing = definition.required.filter((field) => block[field] === undefined);
    if (missing.length) faults.push(`PDF ${at} (${type}) is missing: ${missing.join(', ')}.`);
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
  });
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
 * Flow blocks (heading, paragraph, table, image, pagebreak) onto pages, add
 * the form fields, number the pages, and write the file. The font is chosen
 * for the whole text up front so a Korean paragraph and its table share one
 * embedded face.
 */
export async function createPdf(path, { blocks = [], fields = [], properties = {} } = {}) {
  assertPdfBlocks(blocks);
  const document = await PDFDocument.create();
  const size = pageSize(properties);
  const margin = Number(properties.margin ?? 54);
  const coverage = [
    ...(blocks || []).map(blockText),
    String(properties.footer ?? ''),
    ...(fields || []).map(fieldText),
  ].join(' ');
  const { font, fontPath, embedded } = await embedDocumentFont(document, {
    fontPath: properties.fontPath,
    text: coverage,
  });
  const preparePage = (entry) => {
    if (properties.background) {
      entry.drawRectangle({
        x: 0,
        y: 0,
        width: entry.getWidth(),
        height: entry.getHeight(),
        color: color(properties.background),
      });
    }
    return entry;
  };
  let page = preparePage(document.addPage(size));
  let y = page.getHeight() - margin;
  const newPage = () => {
    page = preparePage(document.addPage(size));
    y = page.getHeight() - margin;
  };
  // Space above a block is flow, not decoration: a heading that inherits only
  // the previous paragraph's trailing space sits as close to the section it
  // ends as to the one it opens, and the reader loses the break. The gap is
  // dropped at the top of a page, where there is nothing to separate from.
  const spaceBefore = (block, type) => {
    if (Number.isFinite(Number(block.before))) return Math.max(0, Number(block.before));
    if (type !== 'heading') return 0;
    const level = Math.min(3, Math.max(1, Number(block.level) || 1));
    return Math.round(Number(block.size || HEADING_SIZES[level]) * 0.8);
  };
  for (const block of blocks || []) {
    const type = String(block.type || 'paragraph').toLowerCase();
    if (type === 'pagebreak') {
      newPage();
      continue;
    }
    const before = spaceBefore(block, type);
    if (before && y < page.getHeight() - margin) y -= before;
    if (type === 'image') {
      const imagePath = resolve(dirname(path), String(block.path || ''));
      const placed = await embedImage(document, imagePath);
      const width = Number(block.width || Math.min(placed.width, page.getWidth() - margin * 2));
      const height = Number(block.height || (placed.height * width) / placed.width);
      if (y - height < margin) newPage();
      const align = String(block.align || 'left').toLowerCase();
      const defaultX =
        align === 'center'
          ? (page.getWidth() - width) / 2
          : align === 'right'
            ? page.getWidth() - margin - width
            : margin;
      page.drawImage(placed.image, { x: Number(block.x ?? defaultX), y: Number(block.y ?? y - height), width, height });
      y -= height + Number(block.after ?? 12);
      continue;
    }
    if (type === 'list') {
      // A list is the marker plus a hanging indent, so a wrapped item lines up
      // under its own text rather than under the bullet.
      const items = (Array.isArray(block.items) ? block.items : []).map((value) => String(value ?? ''));
      const fontSize = Number(block.size || 11);
      const lineHeight = Number(block.lineHeight || fontSize * 1.35);
      const indent = Number(block.indent ?? fontSize * 1.4);
      const left = Number(block.x ?? margin);
      const textWidth = Number(block.width || page.getWidth() - margin - left) - indent;
      const ordered = block.ordered === true;
      items.forEach((item, itemIndex) => {
        const marker = ordered ? `${itemIndex + 1}.` : String(block.marker ?? '•');
        const lines = wrapText(item, font, fontSize, Math.max(8, textWidth));
        lines.forEach((line, lineIndex) => {
          if (y - lineHeight < margin) newPage();
          y -= lineHeight;
          if (lineIndex === 0) {
            page.drawText(marker, { x: left, y, size: fontSize, font, color: color(block.color) });
          }
          page.drawText(line, { x: left + indent, y, size: fontSize, font, color: color(block.color) });
        });
      });
      // A list closes with the same step a table or picture leaves, so what
      // follows it is not set tight against its last item.
      y -= Number(block.after ?? 12);
      continue;
    }
    if (type === 'table') {
      const rows = [
        ...(Array.isArray(block.headers) ? [block.headers] : []),
        ...(Array.isArray(block.rows) ? block.rows : []),
      ].map((row) => (Array.isArray(row) ? row : [row]).map((value) => String(value ?? '')));
      if (!rows.length) continue;
      const columns = Math.max(1, ...rows.map((row) => row.length));
      const width = Number(block.width || page.getWidth() - margin * 2);
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
      const x0 = Number(block.x ?? margin);
      // Cells wrap inside their column and the row grows to the tallest cell,
      // so a long value never spills into its neighbour.
      const laidOut = rows.map((row) => {
        const cells = Array.from({ length: columns }, (_, column) =>
          wrapText(row[column] ?? '', font, fontSize, Math.max(4, cellWidths[column] - padding * 2))
        );
        const height = Math.max(
          minRowHeight,
          Math.max(...cells.map((lines) => lines.length)) * lineHeight + padding * 2
        );
        return { cells, height };
      });
      // Figures are compared down the column, so they are set against the right
      // edge and the header sits over them; every column of figures used to start
      // at the left edge, which is where a reader looks for words.
      const numeric = (text) =>
        /\d/.test(text) && /^[(\-+]?[\d,.\s]+(?:%|[A-Za-z가-힣원$€£¥]{0,3})\)?$/.test(text.trim());
      // A first column of 1호, 2호 is a row label with a digit in it, not a
      // figure to compare down the column: it stays left unless every entry
      // is a bare number.
      const bareNumber = (text) => /\d/.test(text) && /^[(\-+]?[\d,.\s]+%?\)?$/.test(text.trim());
      const alignments = Array.from({ length: columns }, (_, column) => {
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
      // A header row a reader cannot tell from the data is not a header. Without
      // an explicit choice the row carries a neutral band and a rule under it.
      const headerFill = block.headerFill === undefined ? 'EEF0F2' : block.headerFill;
      const ruleColor = color(block.borderColor || 'C9CED6');
      const drawRow = (rowIndex) => {
        const { cells, height } = laidOut[rowIndex];
        let x = x0;
        cells.forEach((lines, column) => {
          const fill = rowIndex === 0 ? headerFill : rowIndex % 2 === 0 ? block.zebraFill : '';
          page.drawRectangle({
            x,
            y: y - height,
            width: cellWidths[column],
            height,
            ...(fill ? { color: color(fill) } : {}),
            borderWidth: 0.5,
            borderColor: color(block.borderColor || 'C9CED6'),
          });
          const top = y - Math.max(padding, (height - lines.length * lineHeight) / 2);
          lines.forEach((line, lineIndex) => {
            const right = alignments[column] === 'right';
            const inset = right ? cellWidths[column] - padding - font.widthOfTextAtSize(line, fontSize) : padding;
            page.drawText(line, {
              x: x + Math.max(padding * 0.5, inset),
              y: top - lineIndex * lineHeight - fontSize * 0.78 - (lineHeight - fontSize) / 2,
              size: fontSize,
              font,
              color: color(rowIndex === 0 ? block.headerColor || block.color : block.color),
            });
          });
          x += cellWidths[column];
        });
        if (rowIndex === 0) {
          page.drawLine({
            start: { x: x0, y: y - height },
            end: { x, y: y - height },
            thickness: 1.1,
            color: ruleColor,
          });
        }
        y -= height;
      };
      for (let rowIndex = 0; rowIndex < laidOut.length; rowIndex += 1) {
        if (y - laidOut[rowIndex].height < margin) {
          newPage();
          if (rowIndex > 0 && block.repeatHeader !== false) drawRow(0);
        }
        drawRow(rowIndex);
      }
      y -= Number(block.after ?? 12);
      continue;
    }
    const bodyWidth = Number(block.width || page.getWidth() - margin * 2);
    const left = Number(block.x ?? margin);
    // Lines of one role at one x: the shared way a cover's title, a quote, and a caption put words down.
    const drawLines = (text, size, { lh = size * 1.35, x = left, width = bodyWidth, tint } = {}) => {
      for (const line of wrapText(String(text ?? ''), font, size, Math.max(8, width))) {
        if (y - lh < margin) newPage();
        page.drawText(line, { x, y: y - size, size, font, color: color(tint) });
        y -= lh;
      }
    };
    const linesHeight = (text, size, width, lh = size * 1.35) =>
      wrapText(String(text ?? ''), font, size, Math.max(8, width)).length * lh;
    if (type === 'rule') {
      if (y - 2 < margin) newPage();
      page.drawLine({
        start: { x: left, y },
        end: { x: left + bodyWidth, y },
        thickness: Number(block.thickness || 0.6),
        color: color(block.color || INK.line),
      });
      y -= Number(block.after ?? 12);
      continue;
    }
    if (type === 'cover') {
      // Eyebrow · title · subtitle · meta lines, one rule under the group: the title block of a report's
      // first page, not a page of its own — the summary follows on the same page unless a pagebreak says otherwise.
      const size = Number(block.size || 26),
        accent = block.accent || INK.accent;
      if (block.eyebrow) {
        drawLines(block.eyebrow, 9.5, { lh: 14, tint: accent });
        y -= 4;
      }
      drawLines(block.title, size, { lh: size * 1.2, tint: block.color });
      if (block.subtitle) {
        y -= 6;
        drawLines(block.subtitle, Number(block.subtitleSize || 13), {
          lh: Number(block.subtitleSize || 13) * 1.4,
          tint: block.color || '374151',
        });
      }
      if (Array.isArray(block.meta) && block.meta.length) {
        y -= 8;
        for (const line of block.meta) drawLines(line, 9.5, { lh: 14, tint: INK.muted });
      }
      if (block.rule !== false) {
        y -= 12;
        page.drawLine({ start: { x: left, y }, end: { x: left + bodyWidth, y }, thickness: 0.8, color: color(accent) });
      }
      y -= Number(block.after ?? 26);
      continue;
    }
    if (type === 'callout') {
      // A tinted field the text sits in, its label above the text in the accent: one unit, never split
      // across pages — a field that does not fit moves whole to the next page.
      const size = Number(block.size || 10.5),
        lh = Number(block.lineHeight || size * 1.45),
        pad = Number(block.padding ?? 12);
      const label = String(block.label ?? '').trim(),
        labelSize = 8.5;
      const inner = bodyWidth - pad * 2;
      const height = pad * 2 + (label ? labelSize * 1.4 + 4 : 0) + linesHeight(block.text, size, inner, lh);
      if (y - height < margin && y < page.getHeight() - margin) newPage();
      page.drawRectangle({ x: left, y: y - height, width: bodyWidth, height, color: color(block.fill || INK.field) });
      y -= pad;
      if (label) {
        drawLines(label, labelSize, {
          lh: labelSize * 1.4,
          x: left + pad,
          width: inner,
          tint: block.labelColor || INK.accent,
        });
        y -= 4;
      }
      drawLines(block.text, size, { lh, x: left + pad, width: inner, tint: block.color || '1F2937' });
      y -= pad;
      y -= Number(block.after ?? 14);
      continue;
    }
    if (type === 'quote') {
      // Someone else's words: a rule in the accent at the left, the quote a step larger than the body,
      // the attribution a caption under it.
      const size = Number(block.size || 13),
        lh = Number(block.lineHeight || size * 1.45),
        inset = 16;
      const height = linesHeight(block.text, size, bodyWidth - inset, lh);
      if (y - height < margin && y < page.getHeight() - margin) newPage();
      const top = y;
      drawLines(block.text, size, { lh, x: left + inset, width: bodyWidth - inset, tint: block.color || '1F2937' });
      // The rule spans the quote's lines from the first cap height to the last descender, not one line's ink.
      page.drawLine({
        start: { x: left + 1, y: top },
        end: { x: left + 1, y: y + (lh - size) / 2 },
        thickness: 2,
        color: color(block.accent || INK.accent),
      });
      if (block.attribution) {
        y -= 4;
        drawLines(`— ${block.attribution}`, 9, { lh: 13, x: left + inset, width: bodyWidth - inset, tint: INK.muted });
      }
      y -= Number(block.after ?? 14);
      continue;
    }
    if (type === 'caption') {
      const size = Number(block.size || 8.5);
      drawLines(block.text, size, { lh: size * 1.35, tint: block.color || INK.muted });
      y -= Number(block.after ?? 10);
      continue;
    }
    if (type === 'stats') {
      // Several figures with one cause on one baseline: value over label per peer, equal columns, one rule under.
      const items = (Array.isArray(block.items) ? block.items : []).map((item) => ({
        value: String(item?.value ?? ''),
        label: String(item?.label ?? ''),
      }));
      const size = Number(block.size || 22),
        labelSize = Number(block.labelSize || 9),
        gap = 12;
      const colW = (bodyWidth - gap * (items.length - 1)) / Math.max(1, items.length);
      const labelH = Math.max(0, ...items.map((item) => linesHeight(item.label, labelSize, colW, labelSize * 1.3)));
      const height = size * 1.15 + 4 + labelH + 10;
      if (y - height < margin && y < page.getHeight() - margin) newPage();
      const top = y;
      items.forEach((item, index) => {
        const x = left + index * (colW + gap);
        page.drawText(item.value, { x, y: top - size, size, font, color: color(block.accent || INK.accent) });
        let ly = top - size * 1.15 - 4;
        for (const line of wrapText(item.label, font, labelSize, colW)) {
          page.drawText(line, { x, y: ly - labelSize, size: labelSize, font, color: color(INK.muted) });
          ly -= labelSize * 1.3;
        }
      });
      y = top - height;
      if (block.rule !== false)
        page.drawLine({
          start: { x: left, y },
          end: { x: left + bodyWidth, y },
          thickness: 0.6,
          color: color(INK.line),
        });
      y -= Number(block.after ?? 16);
      continue;
    }
    const heading = type === 'heading';
    const level = Math.min(3, Math.max(1, Number(block.level) || 1));
    const fontSize = Number(block.size || (heading ? HEADING_SIZES[level] : 11));
    // Body copy leads at 1.5× (Hangul needs the air; 1.35 sets Korean lines touching); a heading keeps 1.2×.
    const lineHeight = Number(block.lineHeight || fontSize * (heading ? 1.2 : 1.5));
    // A heading never ends a page: it moves with the first lines of what it opens.
    if (heading && y - lineHeight * 3 < margin) newPage();
    drawLines(block.text, fontSize, { lh: lineHeight, width: bodyWidth, tint: block.color });
    y -= Number(block.after ?? (heading ? 8 : 6));
  }
  const pageCount = document.getPageCount();
  const numbering =
    properties.pageNumbers === true ||
    (properties.pageNumbers !== false && String(properties.pageNumbers ?? 'auto') === 'auto' && pageCount > 1);
  const footer = String(properties.footer ?? '');
  if (numbering || footer) {
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
  if (properties.title != null) document.setTitle(String(properties.title));
  if (properties.author != null) document.setAuthor(String(properties.author));
  if (properties.subject != null) document.setSubject(String(properties.subject));
  if (properties.keywords != null)
    document.setKeywords(
      Array.isArray(properties.keywords) ? properties.keywords.map(String) : [String(properties.keywords)]
    );
  const formCheck = lintPdfFormFields(
    fields,
    document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()])
  );
  if (!formCheck.ok)
    throw new Error(
      `PDF form layout is invalid: ${formCheck.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join(' ')}`
    );
  // A PDF field is a box with no caption of its own. A form whose fields were
  // named but never labelled reaches the reader as blank rectangles, so the
  // label each field declares is drawn above its box.
  const formPages = document.getPages();
  for (const field of fields || []) {
    const label = String(field.label ?? '').trim();
    const page = formPages[Math.max(1, Number(field.page) || 1) - 1];
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
  await writeFile(path, await document.save(SAVE_OPTIONS));
  return {
    ok: true,
    path,
    pages: pageCount,
    pageNumbers: numbering,
    form: formCheck,
    font: { embedded, ...(fontPath ? { path: fontPath } : {}) },
  };
}
