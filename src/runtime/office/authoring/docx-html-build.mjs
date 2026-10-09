// The Word HTML route, second half: the flow docx-html-measure.mjs read from the browser becomes a native Word
// document — the page and running lines through the portable writer's own operations, the body as WordprocessingML
// written block by block: paragraphs in their runs and spacing, tables on the grid the browser drew (data tables,
// rows of cards, boxes), lists on Word numbering, and pictures. Every number is points; the body follows the page's
// text width, so a block the browser set 40 pt in sits 40 pt in on the Word page.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPortableOoxmlDocument } from '../portable/portable-package.mjs';
import { applyPortableOoxmlBatch } from '../portable/portable-ooxml.mjs';
import { loadPackage, savePackage } from '../portable/portable-opc.mjs';
import { appendDocxBlock } from '../portable/portable-snapshot.mjs';
import { addDocumentImage, ensureNumbering, wordDrawingXml } from '../portable/portable-docx-parts.mjs';
import { wordRunProperties, wordTextContent } from '../portable/portable-docx-xml.mjs';
import { documentStyleId } from '../portable/portable-docx-styles.mjs';
import { xmlEncode } from '../portable/portable-xml.mjs';

const tw = (points) => Math.max(0, Math.round(Number(points || 0) * 20));
const eighths = (points) => Math.max(2, Math.min(96, Math.round(Number(points || 0.75) * 8)));
const BORDER_STYLE = { single: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' };
const SIDES = ['top', 'left', 'bottom', 'right'];

const borderElement = (tag, border, space = 0) =>
  `<w:${tag} w:val="${BORDER_STYLE[border.style] || 'single'}" w:sz="${eighths(border.width)}" w:space="${Math.max(0, Math.min(31, Math.round(space)))}" w:color="${border.color}"/>`;

function runsXml(runs) {
  return runs
    .map((run) => {
      if (run.br) return '<w:r><w:br/></w:r>';
      const properties = [
        wordRunProperties({
          name: run.font || undefined,
          nameEastAsia: run.fontEastAsia || run.font || undefined,
          size: run.size,
          bold: run.bold || undefined,
          italic: run.italic || undefined,
          underline: run.underline || undefined,
          color: run.color,
        }),
        run.strike ? '<w:strike/>' : '',
        run.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${run.shading}"/>` : '',
        run.vertAlign ? `<w:vertAlign w:val="${run.vertAlign}"/>` : '',
      ].join('');
      return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${wordTextContent(run.text, { preserve: true })}</w:r>`;
    })
    .join('');
}

// Paragraph properties in the schema's order: style, keeps, break, numbering, borders, shading, spacing, indents,
// justification.
function paragraphProperties(block, { styleId = '', numbering = null, exactLine = true } = {}) {
  const parts = [];
  if (styleId) parts.push(`<w:pStyle w:val="${xmlEncode(styleId)}"/>`);
  if (block.keepNext) parts.push('<w:keepNext/>');
  if (block.keepLines) parts.push('<w:keepLines/>');
  if (block.pageBreakBefore) parts.push('<w:pageBreakBefore/>');
  if (numbering)
    parts.push(`<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.numId}"/></w:numPr>`);
  if (block.borders) {
    const sides = SIDES.filter((side) => block.borders[side]);
    if (sides.length) {
      parts.push(
        `<w:pBdr>${sides.map((side) => borderElement(side, block.borders[side], block.borderSpace?.[side] ?? 1)).join('')}</w:pBdr>`
      );
    }
  }
  if (block.shading) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${block.shading}"/>`);
  const line = exactLine && block.line > 0 ? ` w:line="${tw(block.line)}" w:lineRule="exact"` : '';
  parts.push(`<w:spacing w:before="${tw(block.before)}" w:after="${tw(block.after)}"${line}/>`);
  const hanging = numbering ? Math.min(18, Math.max(0, block.indentLeft)) : 0;
  const first = numbering
    ? hanging
      ? ` w:hanging="${tw(hanging)}"`
      : ''
    : block.firstLine > 0
      ? ` w:firstLine="${tw(block.firstLine)}"`
      : block.firstLine < 0
        ? ` w:hanging="${tw(-block.firstLine)}"`
        : '';
  if (block.indentLeft || block.indentRight || first) {
    parts.push(`<w:ind w:left="${tw(block.indentLeft)}" w:right="${tw(block.indentRight)}"${first}/>`);
  }
  if (block.align && block.align !== 'left') parts.push(`<w:jc w:val="${block.align}"/>`);
  return `<w:pPr>${parts.join('')}</w:pPr>`;
}

const tinyParagraph = (height = 1, pageBreakBefore = false) =>
  `<w:p><w:pPr>${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="${tw(height)}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>`;

const cellBorders = (borders) => {
  if (!borders) return '';
  return `<w:tcBorders>${SIDES.map((side) => (borders[side] ? borderElement(side, borders[side]) : `<w:${side} w:val="nil"/>`)).join('')}</w:tcBorders>`;
};

// Only the side margins are the cell's: Word sets a row's text at its deepest top margin in every cell of the row, so a
// card's padding pushed the unpadded column beside it down. The top and bottom padding become the space before the
// cell's first block and after its last (cellBlocks).
const cellMargins = (padding) =>
  padding
    ? `<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${tw(padding.left)}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${tw(padding.right)}" w:type="dxa"/></w:tcMar>`
    : '';

function cellBlocks(cell) {
  const blocks = cell.blocks.map((block) => ({ ...block }));
  const top = cell.padding?.top || 0;
  const bottom = cell.padding?.bottom || 0;
  const paragraph = (block) => block && block.kind !== 'table' && block.kind !== 'spacer';
  if (top > 0.5) {
    if (paragraph(blocks[0])) blocks[0].before = (blocks[0].before || 0) + top;
    else blocks.unshift({ kind: 'spacer', height: top });
  }
  if (bottom > 0.5) {
    if (paragraph(blocks.at(-1))) blocks.at(-1).after = (blocks.at(-1).after || 0) + bottom;
    else blocks.push({ kind: 'spacer', height: bottom });
  }
  return blocks;
}

/** Writes a flow (docx-html-measure.mjs) into the body of the document at `path`. */
class BodyWriter {
  constructor(zip, { captures, notes }) {
    this.zip = zip;
    this.captures = captures;
    this.notes = notes;
    this.drawingId = 1000;
    this.lists = new Map();
    this.bullet = null;
    this.headingStyles = new Map();
    this.scratch = null;
  }

  async numbering(list) {
    if (list.kind === 'bullet') {
      this.bullet ||= (await ensureNumbering(this.zip, 'bullet')).numId;
      return { numId: this.bullet, level: list.level };
    }
    if (!this.lists.has(list.instance)) {
      const restart = this.lists.size > 0;
      this.lists.set(list.instance, (await ensureNumbering(this.zip, 'number', { restart })).numId);
    }
    return { numId: this.lists.get(list.instance), level: list.level };
  }

  async headingStyle(level) {
    if (!this.headingStyles.has(level)) {
      this.headingStyles.set(level, (await documentStyleId(this.zip, `Heading ${level}`)).id);
    }
    return this.headingStyles.get(level);
  }

  async picturePath(block) {
    if (block.capture) return this.captures.get(block.capture) || '';
    const src = String(block.src || '');
    if (src.startsWith('file:')) return fileURLToPath(src);
    const data = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(src);
    if (data) {
      this.scratch ||= await mkdtemp(join(tmpdir(), 'mixdog-docx-html-'));
      const path = join(this.scratch, `inline-${this.drawingId}.${data[1].toLowerCase().replace('jpeg', 'jpg')}`);
      await writeFile(path, Buffer.from(data[2], 'base64'));
      return path;
    }
    this.notes.push(`picture ${src.slice(0, 60)} is not a local file or data: URI; it was left out`);
    return '';
  }

  async block(block) {
    if (block.kind === 'spacer') return tinyParagraph(block.height);
    if (block.kind === 'table') {
      // Word puts page breaks on paragraphs, not on tables.
      return (block.pageBreakBefore ? tinyParagraph(1, true) : '') + (await this.table(block));
    }
    if (block.kind === 'image') return this.picture(block);
    const numbering = block.list ? await this.numbering(block.list) : null;
    const styleId = block.heading && block.heading <= 3 ? await this.headingStyle(block.heading) : '';
    return `<w:p>${paragraphProperties(block, { styleId, numbering })}${runsXml(block.runs)}</w:p>`;
  }

  async picture(block) {
    const path = await this.picturePath(block);
    if (!path) return '';
    const image = await addDocumentImage(this.zip, path);
    this.drawingId += 1;
    const drawing = wordDrawingXml({
      id: this.drawingId,
      embedId: image.relationshipId,
      name: image.name,
      width: block.width,
      height: block.height,
      altText: block.alt,
    });
    const properties = paragraphProperties(
      { ...block, indentLeft: block.indent, indentRight: 0, firstLine: 0, align: block.align || 'left' },
      { exactLine: false }
    );
    return `<w:p>${properties}<w:r>${drawing}</w:r></w:p>`;
  }

  async blocks(blocks, { keepAll = false } = {}) {
    const xml = [];
    for (const [index, block] of blocks.entries()) {
      const next = blocks[index + 1];
      // A short paragraph right before a table or picture is its title (그림 1. …, 표 1. …): it goes with it to the
      // next page, as Word keeps a caption with its table. keepAll holds a row's content to the row after it.
      const caption =
        block.kind === 'p' &&
        (next?.kind === 'table' || next?.kind === 'image') &&
        block.runs.reduce((length, run) => length + (run.text?.length || 0), 0) <= 80;
      xml.push(await this.block(keepAll || caption ? { ...block, keepNext: true } : block));
    }
    return xml.join('');
  }

  async table(table) {
    const total = table.columns.reduce((sum, width) => sum + width, 0);
    const properties =
      `<w:tblW w:w="${tw(total)}" w:type="dxa"/>` +
      (table.indent ? `<w:tblInd w:w="${tw(table.indent)}" w:type="dxa"/>` : '') +
      `<w:tblBorders>${[...SIDES, 'insideH', 'insideV'].map((side) => `<w:${side} w:val="nil"/>`).join('')}</w:tblBorders>` +
      '<w:tblLayout w:type="fixed"/>' +
      `<w:tblCellMar>${SIDES.map((side) => `<w:${side} w:w="0" w:type="dxa"/>`).join('')}</w:tblCellMar>`;
    const grid = table.columns.map((width) => `<w:gridCol w:w="${tw(width)}"/>`).join('');
    const rows = [];
    // A short table (six rows or fewer), one asked to stay whole, or a layout grid moves to the next page whole: each
    // row's text keeps with the row after it. A long data table breaks between rows, its header repeated.
    const contentRows = table.rows.filter((row) => !row.spacer);
    const keepWhole = !table.data || table.keepTogether || contentRows.length <= 6;
    const lastRow = contentRows.at(-1);
    for (const row of table.rows) {
      if (row.spacer) {
        rows.push(
          `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(row.height)}" w:hRule="exact"/></w:trPr>` +
            `<w:tc><w:tcPr><w:tcW w:w="${tw(total)}" w:type="dxa"/>${table.columns.length > 1 ? `<w:gridSpan w:val="${table.columns.length}"/>` : ''}</w:tcPr>${tinyParagraph()}</w:tc></w:tr>`
        );
        continue;
      }
      // A layout row (cards) stays whole; a data table breaks between rows as Word breaks it, its header repeated.
      const height = row.height - 0.5;
      const trPr =
        (table.data && !table.keepTogether ? '' : '<w:cantSplit/>') +
        (height > 1 ? `<w:trHeight w:val="${tw(height)}" w:hRule="atLeast"/>` : '') +
        (row.header ? '<w:tblHeader/>' : '');
      const cells = [];
      let column = 0;
      for (const cell of row.cells) {
        const width = table.columns.slice(column, column + cell.span).reduce((sum, value) => sum + value, 0);
        column += cell.span;
        const tcPr =
          `<w:tcW w:w="${tw(width)}" w:type="dxa"/>` +
          (cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : '') +
          cellBorders(cell.borders) +
          (cell.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill}"/>` : '') +
          cellMargins(cell.padding) +
          `<w:vAlign w:val="${cell.vAlign || 'top'}"/>`;
        let content =
          cell.empty || !cell.blocks?.length
            ? tinyParagraph()
            : await this.blocks(cellBlocks(cell), { keepAll: keepWhole && row !== lastRow });
        if (!/<\/w:p>$/.test(content)) content += tinyParagraph();
        cells.push(`<w:tc><w:tcPr>${tcPr}</w:tcPr>${content}</w:tc>`);
      }
      rows.push(`<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells.join('')}</w:tr>`);
    }
    return `<w:tbl><w:tblPr>${properties}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
  }

  async dispose() {
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// The running line and page numbers as the portable writer's own operations: a footer reading "{page} / {pages}"
// is the page field and the total, "Page {page}" a prefix; data-first-page="none" leaves the cover without it.
function runningOperations(kind, running) {
  if (!running?.text) return [];
  const properties = {
    ...(running.font ? { name: running.font, nameEastAsia: running.fontEastAsia || running.font } : {}),
    size: running.size,
    color: running.color,
    ...(running.bold ? { bold: true } : {}),
    alignment: running.align,
  };
  const numbered = /^(.*?)\{page\}(?:(.*?)\{pages\})?(.*)$/.exec(running.text);
  const operations = numbered
    ? [
        {
          op: 'add_page_numbers',
          kind,
          prefix: numbered[1].trim(),
          ...(numbered[2] !== undefined
            ? { separator: numbered[2].trim() || '/', includeTotal: true }
            : { includeTotal: false }),
          alignment: running.align,
        },
      ]
    : [{ op: 'set_header_footer', kind, text: running.text, properties }];
  if (['none', 'blank', 'hidden'].includes(String(running.firstPage).toLowerCase())) {
    operations.push({ op: 'set_header_footer', kind, variant: 'first', text: '' });
  }
  return operations;
}

/**
 * Writes the measured flow to `output` as a .docx.
 * @param {object} flow extractDocxFlow's result
 * @param {{ sheet: { width: number, height: number }, margin: object }} page the sheet and margins in points
 * @param {Map<number, string>} captures picture files for captured elements (an SVG, a chart, a canvas)
 */
export async function buildDocxFromFlow(flow, output, { page, captures, title = '' }) {
  const notes = [...(flow.notes || [])];
  await createPortableOoxmlDocument(output, { fileKind: 'docx', title });
  const firstHeading = (level) => flow.blocks.find((block) => block.heading === level && block.runs?.length);
  const headingStyles = {};
  for (const level of [1, 2, 3]) {
    const block = firstHeading(level);
    const run = block?.runs.find((entry) => entry.text);
    if (!run) continue;
    headingStyles[`Heading ${level}`] = {
      ...(run.font ? { name: run.font, nameEastAsia: run.fontEastAsia || run.font } : {}),
      size: run.size,
      bold: run.bold,
      color: run.color,
      keepWithNext: true,
    };
  }
  const body = flow.body || {};
  const face = body.font ? { name: body.font, nameEastAsia: body.fontEastAsia || body.font } : {};
  await applyPortableOoxmlBatch(output, 'docx', [
    {
      op: 'set_page',
      properties: {
        pageWidth: page.sheet.width,
        pageHeight: page.sheet.height,
        topMargin: page.margin.top,
        rightMargin: page.margin.right,
        bottomMargin: page.margin.bottom,
        leftMargin: page.margin.left,
      },
    },
    {
      op: 'set_document_font',
      properties: { ...face, ...(body.size ? { size: body.size } : {}), ...(body.color ? { color: body.color } : {}) },
    },
    {
      op: 'define_styles',
      styles: {
        Normal: {
          ...face,
          ...(body.size ? { size: body.size } : {}),
          spacingBefore: 0,
          spacingAfter: 0,
          alignment: 'left',
        },
        ...headingStyles,
      },
    },
    ...runningOperations('header', flow.header),
    ...runningOperations('footer', flow.footer),
  ]);
  const zip = await loadPackage(output);
  const writer = new BodyWriter(zip, { captures, notes });
  try {
    let xml = await writer.blocks(flow.blocks);
    if (!xml) xml = tinyParagraph();
    // The body ends on a paragraph: a document that ends in a table gives Word nowhere to put the cursor.
    if (/<\/w:tbl>$/.test(xml)) xml += tinyParagraph();
    const documentPart = 'word/document.xml';
    zip.file(documentPart, appendDocxBlock(await zip.file(documentPart).async('string'), xml));
    await savePackage(zip, output);
  } finally {
    await writer.dispose();
  }
  return { notes };
}
