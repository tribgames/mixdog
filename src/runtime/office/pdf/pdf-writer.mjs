import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { SAVE_OPTIONS, color, embedImage, pageSize, wrapText } from './pdf-draw.mjs';
import { embedDocumentFont } from './pdf-fonts.mjs';
import { addFormField, fieldText, lintPdfFormFields } from './pdf-forms.mjs';

const HEADING_SIZES = Object.freeze({ 1: 20, 2: 15, 3: 12.5 });

function blockText(block) {
  const type = String(block?.type || 'paragraph').toLowerCase();
  if (type === 'table') return (Array.isArray(block.rows) ? block.rows : []).flat().map((value) => String(value ?? '')).join(' ');
  if (type === 'image' || type === 'pagebreak') return '';
  return String(block?.text ?? '');
}

/**
 * Flow blocks (heading, paragraph, table, image, pagebreak) onto pages, add
 * the form fields, number the pages, and write the file. The font is chosen
 * for the whole text up front so a Korean paragraph and its table share one
 * embedded face.
 */
export async function createPdf(path, {
  blocks = [],
  fields = [],
  properties = {},
} = {}) {
  const document = await PDFDocument.create();
  const size = pageSize(properties);
  const margin = Number(properties.margin ?? 54);
  const coverage = [
    ...(blocks || []).map(blockText),
    String(properties.footer ?? ''),
    ...(fields || []).map(fieldText),
  ].join(' ');
  const { font, fontPath, embedded } = await embedDocumentFont(document, { fontPath: properties.fontPath, text: coverage });
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
  for (const block of blocks || []) {
    const type = String(block.type || 'paragraph').toLowerCase();
    if (type === 'pagebreak') {
      newPage();
      continue;
    }
    if (type === 'image') {
      const imagePath = resolve(dirname(path), String(block.path || ''));
      const image = await embedImage(document, imagePath);
      const width = Number(block.width || Math.min(image.width, page.getWidth() - (margin * 2)));
      const height = Number(block.height || (image.height * width / image.width));
      if (y - height < margin) newPage();
      const align = String(block.align || 'left').toLowerCase();
      const defaultX = align === 'center'
        ? (page.getWidth() - width) / 2
        : align === 'right'
          ? page.getWidth() - margin - width
          : margin;
      page.drawImage(image, { x: Number(block.x ?? defaultX), y: Number(block.y ?? y - height), width, height });
      y -= height + Number(block.after ?? 12);
      continue;
    }
    if (type === 'table') {
      const rows = (Array.isArray(block.rows) ? block.rows : [])
        .map((row) => (Array.isArray(row) ? row : [row]).map((value) => String(value ?? '')));
      if (!rows.length) continue;
      const columns = Math.max(1, ...rows.map((row) => row.length));
      const width = Number(block.width || page.getWidth() - (margin * 2));
      const weights = Array.isArray(block.columnWidths) && block.columnWidths.length === columns
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
        const cells = Array.from({ length: columns }, (_, column) => (
          wrapText(row[column] ?? '', font, fontSize, Math.max(4, cellWidths[column] - (padding * 2)))
        ));
        const height = Math.max(minRowHeight, (Math.max(...cells.map((lines) => lines.length)) * lineHeight) + (padding * 2));
        return { cells, height };
      });
      const drawRow = (rowIndex) => {
        const { cells, height } = laidOut[rowIndex];
        let x = x0;
        cells.forEach((lines, column) => {
          const fill = rowIndex === 0
            ? block.headerFill
            : rowIndex % 2 === 0
              ? block.zebraFill
              : '';
          page.drawRectangle({
            x,
            y: y - height,
            width: cellWidths[column],
            height,
            ...(fill ? { color: color(fill) } : {}),
            borderWidth: 0.5,
            borderColor: color(block.borderColor || '999999'),
          });
          const top = y - Math.max(padding, (height - (lines.length * lineHeight)) / 2);
          lines.forEach((line, lineIndex) => {
            page.drawText(line, {
              x: x + padding,
              y: top - (lineIndex * lineHeight) - (fontSize * 0.78) - ((lineHeight - fontSize) / 2),
              size: fontSize,
              font,
              color: color(rowIndex === 0 ? block.headerColor || block.color : block.color),
            });
          });
          x += cellWidths[column];
        });
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
    const heading = type === 'heading';
    const level = Math.min(3, Math.max(1, Number(block.level) || 1));
    const fontSize = Number(block.size || (heading ? HEADING_SIZES[level] : 11));
    const lineHeight = Number(block.lineHeight || fontSize * 1.35);
    const lines = wrapText(block.text, font, fontSize, page.getWidth() - (margin * 2));
    for (const line of lines) {
      if (y - lineHeight < margin) newPage();
      page.drawText(line, { x: Number(block.x ?? margin), y: y - fontSize, size: fontSize, font, color: color(block.color) });
      y -= lineHeight;
    }
    y -= Number(block.after ?? (heading ? 10 : 6));
  }
  const pageCount = document.getPageCount();
  const numbering = properties.pageNumbers === true
    || (properties.pageNumbers !== false && String(properties.pageNumbers ?? 'auto') === 'auto' && pageCount > 1);
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
  if (properties.keywords != null) document.setKeywords(Array.isArray(properties.keywords) ? properties.keywords.map(String) : [String(properties.keywords)]);
  const formCheck = lintPdfFormFields(fields, document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()]));
  if (!formCheck.ok) throw new Error(`PDF form layout is invalid: ${formCheck.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join(' ')}`);
  for (const field of fields || []) await addFormField(document, field, font);
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
