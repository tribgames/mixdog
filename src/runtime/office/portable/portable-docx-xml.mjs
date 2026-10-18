import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import { measureTextWidth } from './text-metrics.mjs';
import { naturalColumnWidths } from '../shared/column-widths.mjs';
import {
  WORD_RUN_SOURCE,
  containerInner,
  rebuildTextNodes,
  textNodes,
  topLevelElements,
  xmlDecode,
  xmlEncode,
} from './portable-xml.mjs';

function pointsToTwips(value) {
  return Math.max(1, Math.round(Number(value) * 20));
}

// A Word table with no borders and no style is invisible on the page: the
// rendered document shows three loose columns of text, and nothing says the
// rows belong together. Unless the caller styles the table themselves, it gets
// the least a reader needs — a rule under the header and hairlines between
// rows — which any explicit borders, style, or shading replaces.
const DEFAULT_TABLE_BORDERS = Object.freeze({
  top: { enabled: false },
  left: { enabled: false },
  right: { enabled: false },
  bottom: { style: 'single', size: 4, color: 'BFC5CB' },
  insideH: { style: 'single', size: 2, color: 'D8DCE0' },
  insideV: { enabled: false },
});

// A rule's line as w:val spells it. The Word backend reads solid (any name it does not know is a single line), dash,
// and dot; written through as given, style:'solid' made a file Word refused to open.
const WORD_BORDER_STYLES = new Set([
  'single',
  'thick',
  'double',
  'dotted',
  'dashed',
  'dotDash',
  'dotDotDash',
  'triple',
  'wave',
  'none',
  'nil',
]);
const WORD_BORDER_ALIASES = Object.freeze({ solid: 'single', dash: 'dashed', dot: 'dotted' });
function wordBorderStyle(style) {
  const name = String(style || 'single');
  if (WORD_BORDER_STYLES.has(name)) return name;
  return WORD_BORDER_ALIASES[name.toLowerCase()] || 'single';
}

export function wordTableProperties(properties = {}, { totalWidth = 0 } = {}) {
  const styled = properties.borders || properties.style || properties.shading;
  const borders = properties.borders || (styled ? {} : DEFAULT_TABLE_BORDERS);
  const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  // Two ways to say it: one spec for every side, or a spec per side. Naming one
  // side used to fall back to the whole object for the others, so asking for a
  // single rule on top drew a full grid.
  const perSide = sides.some((side) => borders[side] !== undefined);
  const sideRules = sides
    .map((side) => {
      const value = perSide ? borders[side] : borders;
      if (!value || typeof value !== 'object' || value.enabled === false) return '';
      return `<w:${side} w:val="${wordBorderStyle(value.style)}" w:sz="${Math.max(1, Number(value.size) || 4)}" w:space="${Math.max(0, Number(value.space) || 0)}" w:color="${xmlEncode(String(value.color || 'auto').replace(/^#/, ''))}"/>`;
    })
    .join('');
  const borderXml = Object.keys(borders).length ? `<w:tblBorders>${sideRules}</w:tblBorders>` : '';
  return [
    properties.style ? `<w:tblStyle w:val="${xmlEncode(docxStyleId(properties.style))}"/>` : '',
    // Declared column widths only hold everywhere (Word, LibreOffice, Google
    // Docs) when the table states its own width too; without it the columns are
    // re-fitted and the layout the caller asked for is lost.
    totalWidth > 0 ? `<w:tblW w:w="${Math.round(totalWidth)}" w:type="dxa"/>` : '<w:tblW w:w="0" w:type="auto"/>',
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
    borderXml,
    properties.shading
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>`
      : '',
  ].join('');
}

function wordCellProperties(properties = {}) {
  return [
    properties.width ? `<w:tcW w:w="${pointsToTwips(properties.width)}" w:type="dxa"/>` : '',
    properties.fillColor
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.fillColor).replace(/^#/, ''))}"/>`
      : '',
    // top, center (or middle, as a slide names it), bottom — the values the Word backend reads; another name is
    // not one the file knows.
    CELL_ALIGNMENTS[String(properties.verticalAlignment || '').toLowerCase()]
      ? `<w:vAlign w:val="${CELL_ALIGNMENTS[String(properties.verticalAlignment).toLowerCase()]}"/>`
      : '',
  ].join('');
}

const CELL_ALIGNMENTS = Object.freeze({ top: 'top', center: 'center', middle: 'center', bottom: 'bottom' });

// Word keeps cell properties in a fixed order too. Restyling one cell (a fill on
// the "after" column head) replaces only the properties it names; the width and
// the vertical alignment the table was written with stay.
const CELL_PROPERTY_ORDER = Object.freeze([
  'w:tcW',
  'w:gridSpan',
  'w:vMerge',
  'w:tcBorders',
  'w:shd',
  'w:noWrap',
  'w:tcMar',
  'w:textDirection',
  'w:tcFitText',
  'w:vAlign',
  'w:hideMark',
]);

export function mergeWordCellProperties(cellXml, properties = {}) {
  let existing = /<w:tcPr(?:\s[^>]*)?>([\s\S]*?)<\/w:tcPr>/.exec(cellXml)?.[1] || '';
  // A filled cell is a field again, and its text needs the padding back: a layout table's flush edge is dropped
  // when the cell takes a fill.
  if (properties.fillColor)
    existing = existing.replace(/<w:tcMar>(?:<w:(?:left|right) w:w="0" w:type="dxa"\/>)+<\/w:tcMar>/, '');
  // fillColor: null takes the shading away, as the Word backend's automatic colour removes it: a data row inserted
  // above a total keeps the total's shading otherwise.
  if (properties.fillColor === null) existing = existing.replace(/<w:shd\b[^>]*\/>/, '');
  const inner = mergeWordPropertyElements(existing, wordCellProperties(properties), CELL_PROPERTY_ORDER);
  return replaceWordProperties(cellXml, 'tc', 'tcPr', inner);
}

// A table's text formatting belongs on every cell run and paragraph, the way the
// Word backend applies it to the table range. Without it the portable file leaves
// each cell on the document default, and a Korean cell beside a Latin one is laid
// out in a different fallback face — the two sit on different baselines inside one
// row. The East Asian face is named separately because Word resolves it that way.
function wordTableRunProperties(properties = {}, { bold = false } = {}) {
  const latin = properties.fontName ? xmlEncode(String(properties.fontName)) : '';
  const eastAsia = properties.fontNameEastAsia ? xmlEncode(String(properties.fontNameEastAsia)) : '';
  const size = Number(properties.fontSize);
  return [
    runFontsXml(latin, eastAsia),
    bold ? '<w:b/><w:bCs/>' : '',
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    Number.isFinite(size) && size > 0
      ? `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`
      : '',
  ].join('');
}

// Every cell of a row shares one exact line pitch, 1.3× the size: under a
// minimum pitch a Hangul label took Malgun Gothic's taller line and sat 2 pt
// above the Latin-only figure beside it (Word, probe 2026-09-25); an exact
// pitch puts every line's baseline at the same height.
function wordTableParagraphProperties(properties = {}, { keepNext = false } = {}) {
  const spacing = Number(properties.spacingAfter);
  const size = Number(properties.fontSize) > 0 ? Number(properties.fontSize) : 11;
  return [
    properties.textStyle ? `<w:pStyle w:val="${xmlEncode(docxStyleId(properties.textStyle))}"/>` : '',
    keepNext ? '<w:keepNext/>' : '',
    `<w:spacing${Number.isFinite(spacing) ? ` w:after="${Math.max(0, Math.round(spacing * 20))}"` : ''} w:line="${Math.round(size * 1.3 * 20)}" w:lineRule="exact"/>`,
  ].join('');
}

// An alignment as Word's w:jc spells it, for a paragraph and for a column's cells. The file takes "both" for
// justified text: "justify" written as it was named made a file Word refused to open.
const WORD_JUSTIFICATION = Object.freeze({
  left: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  justify: 'both',
  both: 'both',
  distribute: 'distribute',
});

export function wordJustification(alignment) {
  return (
    WORD_JUSTIFICATION[
      String(alignment || '')
        .trim()
        .toLowerCase()
    ] || ''
  );
}

// Sets one justification on every paragraph of a cell, replacing the one it had.
export function justifyWordParagraphs(cellXml, justification) {
  if (!justification) return cellXml;
  return cellXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const stripped = paragraph.replace(/<w:jc\b[^>]*\/>/g, '');
    return /<w:pPr(?:\s[^>]*)?>/.test(stripped)
      ? stripped.replace(/<\/w:pPr>/, () => `<w:jc w:val="${justification}"/></w:pPr>`)
      : stripped.replace(/^(<w:p(?:\s[^>]*)?>)/, (__m, __1) => `${__1}<w:pPr><w:jc w:val="${justification}"/></w:pPr>`);
  });
}

// Applies per-column text alignment to an existing table, column by column.
export function alignWordTableColumns(tableXml, columnAlignments = []) {
  const justifications = columnAlignments.map(wordJustification);
  if (!justifications.some(Boolean)) return tableXml;
  let next = tableXml;
  for (const row of tableRowMatches(tableXml)) {
    let nextRow = row[0];
    rowCellMatches(row[0]).forEach((cell, column) => {
      if (!justifications[column]) return;
      nextRow = nextRow.replace(cell[0], () => justifyWordParagraphs(cell[0], justifications[column]));
    });
    next = next.replace(row[0], () => nextRow);
  }
  return next;
}

// A table with every rule switched off and no fill is a layout grid (a résumé's role and date, a signature block):
// nothing marks its edges, so its cell padding shows as an indent — "시니어 엔지니어" started 5 pt right of the "경력"
// heading above it and "2023 – 현재" stopped 5 pt short of the rule. Its outer cells drop the padding on the page
// side, so the text registers with the paragraphs around it; the padding between columns stays.
function isLayoutTable(properties = {}) {
  if (properties.style || properties.shading) return false;
  const borders = properties.borders;
  if (!borders || typeof borders !== 'object') return false;
  if (borders.enabled === false) return true;
  return ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].every((side) => borders[side]?.enabled === false);
}

// The text width of the section a block sits in: the first section properties after it close that section. Measured
// against the document's first section, a table on a landscape page was reported as 3.4 in wider than its column.
export function sectionTextWidth(document, position) {
  const section =
    /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(document.slice(position))?.[0] ||
    /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(document)?.[0] ||
    '';
  const page = /<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(section);
  const margins =
    /<w:pgMar\b[^>]*\bw:left="(\d+)"[^>]*\bw:right="(\d+)"/.exec(section) ||
    /<w:pgMar\b[^>]*\bw:right="(\d+)"[^>]*\bw:left="(\d+)"/.exec(section);
  return (page ? Number(page[1]) : 12240) - (margins ? Number(margins[1]) + Number(margins[2]) : 2880);
}

// Word's default cell padding, left and right together, in points.
const CELL_PADDING_POINTS = 10.8;

// Column widths, in points, for a table the caller gave no widths, across the text width (naturalColumnWidths),
// measured in the table's own face. The widths are always written: a grid without them spans the page in the
// LibreOffice preview and shrinks to its text in Word.
export function naturalTableColumnWidths(values, properties = {}, available = 0) {
  const rows = Array.isArray(values) ? values : [];
  const font = {
    fontName: properties.fontName || properties.fontNameEastAsia || 'Calibri',
    fontSize: Number(properties.fontSize) > 0 ? Number(properties.fontSize) : 11,
  };
  const headerBold = tableHeaderBold(properties, rows.length);
  const headers = tableHeaderRows(properties, rows.length);
  const gutters = isLayoutTable(properties) ? [] : gutterColumns(properties);
  const measure = (text, rowIndex, column) =>
    measureTextWidth(text, {
      ...font,
      fontSize:
        Number(tableRowStyle(properties, rowIndex)?.fontSize) > 0
          ? Number(tableRowStyle(properties, rowIndex).fontSize)
          : font.fontSize,
      bold: rowBold(properties, rowIndex, rows.length, headerBold && rowIndex < headers),
    }) *
      1.05 +
    CELL_PADDING_POINTS +
    (gutters[column] ? GUTTER_POINTS : 0);
  return naturalColumnWidths(rows, measure, available);
}

// Room before a column of words that follows a column of figures: set right, the figure ran into the note beside it
// ("96 내부 인력 4명") across the cells' own padding alone. The words' cells take a gutter on their left.
const GUTTER_POINTS = 8;
function gutterColumns(properties) {
  const alignments = (properties?.columnAlignments || []).map((value) => String(value || '').toLowerCase());
  return alignments.map(
    (alignment, column) =>
      column > 0 && alignments[column - 1] === 'right' && (alignment === 'left' || alignment === 'justify')
  );
}
const gutterMargin = (gutter) =>
  gutter
    ? `<w:tcMar><w:left w:w="${pointsToTwips(CELL_PADDING_POINTS / 2 + GUTTER_POINTS)}" w:type="dxa"/></w:tcMar>`
    : '';

// The rows a table's header takes: one, or more for a header of several levels — a group label over the columns it
// spans ("3분기 처리량" over 7월 · 8월 · 9월) is two. At least one row stays data.
function tableHeaderRows(properties, rows) {
  return Math.max(1, Math.min(rows - 1, Math.floor(Number(properties?.headerRows) || 1)));
}

// The header row is set apart by weight unless the caller opts out (headerBold, or repeatHeader: false for a table
// whose first row is data); a one-row table has no header to set apart.
function tableHeaderBold(properties, rows) {
  return rows > 1 && properties?.headerBold !== false && properties?.repeatHeader !== false;
}

// One row's own type (rowStyles[row]: fontSize, color, bold): a stat strip sets its figures at 22 pt and the labels
// under them at 9 pt in one table, where a single fontSize set the labels at 22 pt too.
function tableRowStyle(properties, row) {
  const style = Array.isArray(properties?.rowStyles) ? properties.rowStyles[row] : null;
  return style && typeof style === 'object' ? style : null;
}

// The last row is the total when totalRow is set: bold over a rule, so it reads as the sum of the rows above it and
// not as one more of them.
const isTotalRow = (properties, row, rows) => properties?.totalRow === true && rows > 1 && row === rows - 1;
const TOTAL_ROW_RULE = Object.freeze({ size: 8, color: '374151' });

// A row's weight: its own rowStyles bold when given, else the header's or the total's.
function rowBold(properties, row, rows, header) {
  const own = tableRowStyle(properties, row)?.bold;
  if (typeof own === 'boolean') return own;
  return header || isTotalRow(properties, row, rows);
}

// A row's type properties: the table's, with its own rowStyles size and ink over them.
function rowTypeProperties(properties, row) {
  const style = tableRowStyle(properties, row);
  if (!style) return properties;
  return {
    ...properties,
    ...(Number(style.fontSize) > 0 ? { fontSize: Number(style.fontSize) } : {}),
    ...(style.color ? { color: style.color } : {}),
  };
}

const flushCellMargins = (first, last) => {
  if (!first && !last) return '';
  const left = first ? '<w:left w:w="0" w:type="dxa"/>' : '';
  const right = last ? '<w:right w:w="0" w:type="dxa"/>' : '';
  return `<w:tcMar>${left}${right}</w:tcMar>`;
};

// `available` is the text width, in points, of the section the table lands in.
export function wordTableXml(operation, { available = 0 } = {}) {
  const values = Array.isArray(operation.values) ? operation.values : [];
  const layout = isLayoutTable(operation.properties);
  const rows = Math.max(1, Number(operation.rows) || values.length || 1);
  const columns = Math.max(1, Number(operation.columns) || Math.max(0, ...values.map((row) => row.length)) || 1);
  const widths =
    operation.properties?.columnWidths ||
    (columns === Math.max(0, ...values.map((row) => row.length))
      ? naturalTableColumnWidths(values, operation.properties, available)
      : null) ||
    [];
  const heights = operation.properties?.rowHeights || [];
  const justifications = (operation.properties?.columnAlignments || []).map(wordJustification);
  // The header row is set apart by weight, on both backends, unless the caller
  // says otherwise; a header a reader cannot tell from the data is not one.
  const headerBold = tableHeaderBold(operation.properties, rows);
  const headers = tableHeaderRows(operation.properties, rows);
  const rowRunProperties = (row) =>
    wordTableRunProperties(rowTypeProperties(operation.properties, row), {
      bold: rowBold(operation.properties, row, rows, headerBold && row < headers),
    });
  const totalBorder = `<w:tcBorders><w:top w:val="single" w:sz="${TOTAL_ROW_RULE.size}" w:space="0" w:color="${TOTAL_ROW_RULE.color}"/></w:tcBorders>`;
  const gutters = layout ? [] : gutterColumns(operation.properties);
  // A page break never strands a table's edge: the header travels with the first two rows and the last two rows
  // travel together (widow and orphan control, row by row) — a three-row table used to leave its last row alone at
  // the top of the next page under a repeated header. A table of six rows or fewer moves whole, as a split one is
  // reported; a longer one still breaks between those rows. keepWithNext holds the last row to what follows (its
  // caption): gluing every row instead carried a 25-row table whole to the next page and left half a page blank.
  const keptRow = (row) =>
    row < rows - 1 ? rows <= 6 || row <= headers || row === rows - 2 : Boolean(operation.properties?.keepWithNext);
  const paragraphProperties = (row) =>
    wordTableParagraphProperties(rowTypeProperties(operation.properties, row), { keepNext: keptRow(row) });
  const grid = Array.from(
    { length: columns },
    (_, column) => `<w:gridCol${widths[column] ? ` w:w="${pointsToTwips(widths[column])}"` : ''}/>`
  ).join('');
  // The first row is the table's header: a table that breaks across pages
  // carries it onto every continuation page, the way a reader expects, unless
  // the caller says the row is data.
  const repeatHeader = operation.properties?.repeatHeader !== false;
  const body = Array.from({ length: rows }, (_, row) => {
    const rowProperties = [
      row < headers && repeatHeader ? '<w:tblHeader/>' : '',
      heights[row] ? `<w:trHeight w:val="${pointsToTwips(heights[row])}" w:hRule="atLeast"/>` : '',
    ].join('');
    return `<w:tr>${rowProperties ? `<w:trPr>${rowProperties}</w:trPr>` : ''}${Array.from(
      { length: columns },
      (_, column) => {
        const text = String(values[row]?.[column] ?? '');
        const width = widths[column] ? `<w:tcW w:w="${pointsToTwips(widths[column])}" w:type="dxa"/>` : '';
        // A cell written with line breaks keeps them: Word collapses a literal
        // newline inside one text element, so a step's title and its date used to
        // run together on a single line.
        const runs = text
          .split(/\r?\n/)
          .map((line, lineIndex) => `${lineIndex ? '<w:br/>' : ''}${wordTextElement(line)}`)
          .join('');
        // Schema order inside pPr: style and spacing before justification.
        const cellParagraphProperties = `${paragraphProperties(row)}${justifications[column] ? `<w:jc w:val="${justifications[column]}"/>` : ''}`;
        const cellRunProperties = rowRunProperties(row);
        // A row reads from its top: a label beside a two-line note starts on the note's first line, where the
        // bottom edge put it on the last. The header row sits on its rule (its bottom edge), so a header that wraps
        // stands on the same line as the ones beside it. The exact line pitch keeps a Latin-only figure and a Hangul
        // label on one baseline either way; set_table_cell_style verticalAlignment overrides per cell.
        const margins = layout ? flushCellMargins(column === 0, column === columns - 1) : gutterMargin(gutters[column]);
        const edge = row < headers && headerBold ? 'bottom' : 'top';
        const rule = isTotalRow(operation.properties, row, rows) ? totalBorder : '';
        return `<w:tc><w:tcPr>${width}${rule}${margins}<w:vAlign w:val="${edge}"/></w:tcPr><w:p>${cellParagraphProperties ? `<w:pPr>${cellParagraphProperties}</w:pPr>` : ''}<w:r>${cellRunProperties ? `<w:rPr>${cellRunProperties}</w:rPr>` : ''}${runs}</w:r></w:p></w:tc>`;
      }
    ).join('')}</w:tr>`;
  }).join('');
  const totalWidth = widths.length === columns ? widths.reduce((sum, width) => sum + pointsToTwips(width), 0) : 0;
  return (
    `<w:tbl><w:tblPr>${wordTableProperties(operation.properties, { totalWidth })}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
}

export function insertDocxBlockAt(documentXml, block, paragraphNumber) {
  if (!paragraphNumber) return appendDocxBlock(documentXml, block);
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const paragraph = model.blocks.filter((entry) => entry.name === 'w:p')[Number(paragraphNumber) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${paragraphNumber} not found`);
  const inner = `${model.body.inner.slice(0, paragraph.end)}${block}${model.body.inner.slice(paragraph.end)}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}

const WORD_STYLE_IDS = Object.freeze({
  'heading 1': 'Heading1',
  'heading 2': 'Heading2',
  'heading 3': 'Heading3',
  'heading 4': 'Heading4',
  'list paragraph': 'ListParagraph',
  'table grid': 'TableGrid',
  'normal table': 'TableNormal',
  'no spacing': 'NoSpacing',
  'intense quote': 'IntenseQuote',
});

export function docxStyleId(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return WORD_STYLE_IDS[raw.toLowerCase()] || raw.replace(/\s+/g, '');
}

// Word keeps run properties in a fixed order and honours the last value it
// reads: appending a colour beside the one already there leaves the old ink
// winning, so a restyled cell must replace the property it sets, in place.
const RUN_PROPERTY_ORDER = Object.freeze([
  'w:rStyle',
  'w:rFonts',
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:caps',
  'w:smallCaps',
  'w:strike',
  'w:dstrike',
  'w:vanish',
  'w:color',
  'w:spacing',
  'w:w',
  'w:kern',
  'w:position',
  'w:sz',
  'w:szCs',
  'w:highlight',
  'w:u',
  'w:vertAlign',
  'w:rtl',
  'w:lang',
]);

function runPropertyElements(xml) {
  const matches = String(xml || '').matchAll(/<(w:[A-Za-z]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g);
  return [...matches].map((match) => ({ tag: match[1], xml: match[0] }));
}

function mergeWordPropertyElements(existing, overrides, order) {
  const merged = new Map();
  for (const element of [...runPropertyElements(existing), ...runPropertyElements(overrides)]) {
    merged.set(element.tag, element.xml);
  }
  const rank = (tag) => {
    const index = order.indexOf(tag);
    return index === -1 ? order.length : index;
  };
  return [...merged.entries()]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([, xml]) => xml)
    .join('');
}

// Run properties merged in Word's order, the overrides replacing the elements they name. The faces merge attribute by
// attribute: a document default naming its Korean face keeps it when only the Latin face is set.
export function mergeWordRunFonts(existing, { name = '', nameEastAsia = '', size = 0, color = '' } = {}) {
  const attributes = new Map(
    [...(/<w:rFonts\b([^>]*)\/>/.exec(existing)?.[1] || '').matchAll(/(w:[A-Za-z]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ])
  );
  // A theme face (asciiTheme…) outranks the named one in Word, so a face set here drops it.
  if (name) {
    for (const key of ['w:asciiTheme', 'w:hAnsiTheme']) attributes.delete(key);
    attributes.set('w:ascii', xmlEncode(name));
    attributes.set('w:hAnsi', xmlEncode(name));
  }
  if (nameEastAsia) {
    attributes.delete('w:eastAsiaTheme');
    attributes.set('w:eastAsia', xmlEncode(nameEastAsia));
  }
  const half = Number(size) > 0 ? Math.max(2, Math.round(Number(size) * 2)) : 0;
  const ink = String(color || '').replace(/^#/, '');
  const overrides =
    (attributes.size ? `<w:rFonts ${[...attributes].map(([key, value]) => `${key}="${value}"`).join(' ')}/>` : '') +
    (/^[0-9A-Fa-f]{6}$/.test(ink) ? `<w:color w:val="${ink.toUpperCase()}"/>` : '') +
    (half ? `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` : '');
  return mergeWordPropertyElements(existing, overrides, RUN_PROPERTY_ORDER);
}

export function applyWordRunFormat(xml, runFormat) {
  if (!runFormat) return xml;
  return String(xml).replace(new RegExp(WORD_RUN_SOURCE, 'g'), (run) => {
    const selfClosed = /<w:rPr\b[^>]*\/>/.exec(run);
    const opened = /<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/.exec(run);
    if (opened) {
      const merged = mergeWordPropertyElements(opened[1], runFormat, RUN_PROPERTY_ORDER);
      return run.replace(opened[0], () => `<w:rPr>${merged}</w:rPr>`);
    }
    if (selfClosed) return run.replace(selfClosed[0], () => `<w:rPr>${runFormat}</w:rPr>`);
    return run.replace(/<w:r(?:\s[^>]*)?>/, (open) => `${open}<w:rPr>${runFormat}</w:rPr>`);
  });
}

/** `<w:rFonts>` with the already-encoded Latin (ascii/hAnsi/cs) and East Asian faces; '' without either. */
function runFontsXml(latin, eastAsia) {
  if (!latin && !eastAsia) return '';
  const latinAttrs = latin ? ` w:ascii="${latin}" w:hAnsi="${latin}" w:cs="${latin}"` : '';
  const eastAsiaAttr = eastAsia ? ` w:eastAsia="${eastAsia}"` : '';
  return `<w:rFonts${latinAttrs}${eastAsiaAttr}/>`;
}

/** `<w:rFonts>` for a run's ascii/hAnsi face and East Asian face; '' without either. */
function wordRunFontsXml(name, nameEastAsia) {
  if (!name && !nameEastAsia) return '';
  const latin = name ? ` w:ascii="${xmlEncode(name)}" w:hAnsi="${xmlEncode(name)}"` : '';
  const eastAsia = nameEastAsia ? ` w:eastAsia="${xmlEncode(nameEastAsia)}"` : '';
  return `<w:rFonts${latin}${eastAsia}/>`;
}

/** `<w:t>` for one string; edge whitespace is kept with `xml:space="preserve"`, which Word otherwise drops. */
export function wordTextElement(text, { preserve = false } = {}) {
  return `<w:t${preserve || /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t>`;
}

/** `<w:tag w:val="…"/>` for a tri-state property: '' when undefined, else its on/off value. */
function toggleXml(tag, value, on = '1', off = '0') {
  if (value === undefined) return '';
  return `<w:${tag} w:val="${value ? on : off}"/>`;
}

export function wordRunProperties(properties = {}) {
  const size = Number(properties.size ?? properties.fontSize);
  const half = Number.isFinite(size) && size > 0 ? Math.max(2, Math.round(size * 2)) : 0;
  return [
    wordRunFontsXml(properties.name, properties.nameEastAsia),
    toggleXml('b', properties.bold),
    toggleXml('i', properties.italic),
    toggleXml('u', properties.underline, 'single', 'none'),
    // A working note travels with the document without being part of it: Word
    // hides the run, and the runtime already reads it back as hidden text.
    toggleXml('vanish', properties.hidden),
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    half ? `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` : '',
  ].join('');
}

export function wordParagraph(text, { alignment = '', style = '', runProperties = '' } = {}) {
  const justification = wordJustification(alignment);
  const properties = [
    style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : '',
    justification ? `<w:jc w:val="${justification}"/>` : '',
  ].join('');
  return (
    `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}` +
    `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}` +
    `${wordTextElement(String(text ?? ''))}</w:r></w:p>`
  );
}

export function blankTableCells(xml) {
  return xml.replace(/(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/g, '$1$2');
}

export function rewriteTableColumns(tableXml, columnIndex, mode) {
  const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(tableXml);
  let next = tableXml;
  if (grid) {
    const columns = [...grid[0].matchAll(/<w:gridCol\b[^>]*\/>/g)].map((match) => match[0]);
    if (mode === 'delete') {
      if (columns.length <= 1) throw new Error('A table must keep at least one column');
      columns.splice(columnIndex - 1, 1);
    } else {
      columns.splice(columnIndex - 1, 0, columns[columnIndex - 1] || columns.at(-1) || '<w:gridCol/>');
    }
    next = next.replace(grid[0], () => `<w:tblGrid>${columns.join('')}</w:tblGrid>`);
  }
  return mapTableRows(next, (row) => {
    const cells = tableRowCells(row);
    if (!cells.length) return row;
    if (mode === 'delete') {
      if (cells.length <= 1) return row;
      cells.splice(columnIndex - 1, 1);
    } else {
      const template = cells[columnIndex - 1] || cells.at(-1);
      cells.splice(columnIndex - 1, 0, blankTableCells(template));
    }
    const open = /^<w:tr(?:\s[^>]*)?>/.exec(row)?.[0] || '<w:tr>';
    const properties = /<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>/.exec(row)?.[0] || '';
    return `${open}${properties}${cells.join('')}</w:tr>`;
  });
}

export function tableRows(tableXml) {
  const inner = containerInner(tableXml, 'w:tbl');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tr']).map((row) => ({
    ...row,
    start: inner.start + row.start,
    end: inner.start + row.end,
  }));
}

function tableRowCells(rowXml) {
  return rowCellMatches(rowXml).map((match) => match[0]);
}

export function tableRowMatches(tableXml) {
  return tableRows(tableXml).map((row) => {
    const match = [row.xml];
    match.index = row.start;
    return match;
  });
}

// A row names its cells as it stands: a merge across columns joins cells and moves the later ones left, so a header
// merged left to right lost its last label. The error says how many cells the row holds and how to go on, in the words
// the Office backend uses.
export function missingDocxCellError(op, cells) {
  return new Error(
    `DOCX table row ${op.row} holds ${cells.length} cell(s) as it stands, so it has no cell ${op.col}: a merge across columns joins cells and moves the later ones left; merge a row from its right end first, or name the cell by its new position`
  );
}

export function rowCellMatches(rowXml) {
  const inner = containerInner(rowXml, 'w:tr');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tc']).map((cell) => {
    const match = [cell.xml];
    match.index = inner.start + cell.start;
    return match;
  });
}

function mapTableRows(tableXml, transform) {
  const rows = tableRows(tableXml);
  if (!rows.length) return tableXml;
  let output = '';
  let cursor = 0;
  for (const row of rows) {
    output += tableXml.slice(cursor, row.start) + transform(row.xml);
    cursor = row.end;
  }
  return output + tableXml.slice(cursor);
}

export function docxTables(current) {
  const body = containerInner(current, 'w:body');
  const scope = body ? body.inner : current;
  const offset = body ? body.start : 0;
  return topLevelElements(scope, ['w:tbl']).map((element) => {
    const match = [element.xml];
    match.index = offset + element.start;
    return match;
  });
}

// The grid's columns, as Word counts a table's columns whatever its merges.
function tableColumnCount(tableXml, rows = tableRowMatches(tableXml)) {
  const grid = /<w:tblGrid\b[\s\S]*?<\/w:tblGrid>/.exec(tableXml)?.[0] || '';
  return (grid.match(/<w:gridCol\b/g) || []).length || (rows.length ? rowCellMatches(rows[0][0]).length : 0);
}

// A table as a caller can pick it out of the page: its size and the words it starts with. A report's metric strip is
// a table too, and "table 1" named it where the results table was meant; the errors now say which table is which.
function tableSummary(tableXml) {
  const rows = tableRowMatches(tableXml);
  const columns = tableColumnCount(tableXml, rows);
  const firstCell = rows.length ? rowCellMatches(rows[0][0])[0]?.[0] || '' : '';
  const start = [...firstCell.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)]
    .map((match) => xmlDecode(match[1]))
    .join('')
    .trim()
    .slice(0, 24);
  return `${rows.length}×${columns}${start ? ` starting "${start}"` : ''}`;
}

export function docxTable(current, number) {
  const tables = docxTables(current);
  const match = tables[Number(number) - 1];
  if (!match) {
    const held = tables
      .slice(0, 6)
      .map((table, index) => `${index + 1}: ${tableSummary(table[0])}`)
      .join('; ');
    throw new Error(
      `DOCX table ${number} not found: the document holds ${tables.length} table(s)${held ? ` (${held})` : ''}`
    );
  }
  return match;
}

// A row the table does not have, said with the table's size and first words, so the caller can tell whether it named
// the wrong row or the wrong table. insert_table_row takes one past the last row, where the new row is added at the end.
export function missingDocxRowError(op, tableXml) {
  const count = tableRowMatches(tableXml).length;
  const insertion = op.op === 'insert_table_row';
  return new Error(
    `DOCX table ${op.table} is ${tableSummary(tableXml)}, so it has no row ${op.row}` +
      (insertion
        ? `: insert_table_row row is the position the new row takes, 1 to ${count + 1} (${count + 1} adds it at the end)`
        : '')
  );
}

// A column the table does not have, said the same way; insert_table_column takes one past the last column, where the
// new column is added at the end. The Office backend refused that position with Word's "no such member".
export function checkDocxColumn(op, tableXml) {
  const count = tableColumnCount(tableXml);
  const insertion = op.op === 'insert_table_column';
  const column = Number(op.column);
  if (Number.isInteger(column) && column >= 1 && column <= count + (insertion ? 1 : 0)) return column;
  throw new Error(
    `DOCX table ${op.table} is ${tableSummary(tableXml)}, so it has no column ${op.column}` +
      (insertion
        ? `: insert_table_column column is the position the new column takes, 1 to ${count + 1} (${count + 1} adds it at the end)`
        : '')
  );
}

export function replaceDocxTable(current, table, nextTable) {
  return `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
}

export function replaceWordProperties(xml, owner, propertyTag, value) {
  const pattern = new RegExp(`<w:${propertyTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:${propertyTag}>`);
  if (pattern.test(xml)) return xml.replace(pattern, () => `<w:${propertyTag}>${value}</w:${propertyTag}>`);
  return xml.replace(
    new RegExp(`<w:${owner}(?:\\s[^>]*)?>`),
    (open) => `${open}<w:${propertyTag}>${value}</w:${propertyTag}>`
  );
}

// The gap between a rule and the text is Word's own default per side (4 pt beside, 1 pt above or below),
// the distance Word applies through COM; a callout's left rule otherwise touches its label.
function paragraphBorderXml(border) {
  if (!border) return '';
  // The sides the Word backend draws; any other name is its bottom rule, as Word reads it.
  const side = ['top', 'left', 'bottom', 'right'].includes(String(border.side)) ? String(border.side) : 'bottom';
  const explicitSpace =
    border.space !== undefined && border.space !== null && border.space !== '' && Number.isFinite(Number(border.space));
  const defaultSpace = ['left', 'right'].includes(side) ? 4 : 1;
  const space = Math.max(0, explicitSpace ? Number(border.space) : defaultSpace);
  return `<w:pBdr><w:${side} w:val="${wordBorderStyle(border.style)}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${space}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>`;
}

// A tab stop in the names the Word backend reads (dash, line) and in the file's own (hyphen, underscore); a name
// written through as given ("dash") is not one the file knows, and Word refuses such a file.
const TAB_ALIGNMENTS = new Set(['left', 'center', 'right', 'decimal', 'bar']);
const TAB_LEADERS = Object.freeze({
  none: 'none',
  dot: 'dot',
  dots: 'dot',
  dotted: 'dot',
  dash: 'hyphen',
  hyphen: 'hyphen',
  line: 'underscore',
  underscore: 'underscore',
  heavy: 'heavy',
  middledot: 'middleDot',
});

function tabStopXml(tab) {
  const alignment = String(tab.alignment || '').toLowerCase();
  const leaderName = TAB_LEADERS[String(tab.leader || '').toLowerCase()];
  const leader = leaderName ? ` w:leader="${leaderName}"` : '';
  const value = TAB_ALIGNMENTS.has(alignment) ? alignment : 'left';
  return `<w:tab w:val="${value}" w:pos="${pointsToTwips(tab.position || 0)}"${leader}/>`;
}

// lineSpacing is a minimum unless lineSpacingRule:'exact' holds the line at it: set on Malgun Gothic's own line, the two
// lines of one 24 pt title stood nearly twice the size apart, and a minimum can only open that gap further.
function paragraphSpacingXml({ spacingBefore, spacingAfter, lineSpacing, lineSpacingRule }) {
  if (spacingBefore === undefined && spacingAfter === undefined && lineSpacing === undefined) return '';
  const before =
    spacingBefore !== undefined ? ` w:before="${Math.max(0, Math.round(Number(spacingBefore) * 20))}"` : '';
  const after = spacingAfter !== undefined ? ` w:after="${Math.max(0, Math.round(Number(spacingAfter) * 20))}"` : '';
  const rule = String(lineSpacingRule || '').toLowerCase() === 'exact' ? 'exact' : 'atLeast';
  const line =
    lineSpacing !== undefined
      ? ` w:line="${Math.max(1, Math.round(Number(lineSpacing) * 20))}" w:lineRule="${rule}"`
      : '';
  return `<w:spacing${before}${after}${line}/>`;
}

function paragraphIndentXml({ indentLeft, indentRight, indentFirstLine }) {
  if (indentLeft === undefined && indentRight === undefined && indentFirstLine === undefined) return '';
  const twips = (points) => Math.max(0, Math.round(Number(points) * 20));
  const left = indentLeft !== undefined ? ` w:left="${twips(indentLeft)}"` : '';
  const right = indentRight !== undefined ? ` w:right="${twips(indentRight)}"` : '';
  // A negative first line hangs out to the left of the lines under it — "①" or "1." with the wrapped words set
  // under the words, not under the mark — as Word takes a negative FirstLineIndent through COM. The file spells it
  // w:hanging: a w:firstLine never goes below zero, and clamped there the mark sat inside the indent and every
  // wrapped line started under it.
  const first = Number(indentFirstLine);
  let firstLine = '';
  if (indentFirstLine !== undefined) {
    firstLine = first < 0 ? ` w:hanging="${twips(-first)}"` : ` w:firstLine="${twips(first)}"`;
  }
  return `<w:ind${left}${right}${firstLine}/>`;
}

/**
 * A run's text content. Each tab is Word's own `<w:tab/>` element: a TAB
 * character inside `<w:t>` renders as a space, so the paragraph's tab stops (a
 * right-aligned figure, a dot leader) never see it.
 */
export function wordTextContent(text, { preserve = false } = {}) {
  const value = String(text ?? '');
  if (!value.includes('\t')) return wordTextElement(value, { preserve });
  return value
    .split('\t')
    .map((part) => (part ? wordTextElement(part, { preserve }) : ''))
    .join('<w:tab/>');
}

/**
 * The fragment with `text` in its first `<w:t>` and every other `<w:t>`
 * emptied: the first run's formatting carries the new words, and a tab in
 * them becomes that run's `<w:tab/>`. The fragment holds at least one `<w:t>`.
 */
export function withFirstRunText(xml, text) {
  const value = String(text ?? '');
  const nodes = textNodes(xml, 'w:t').map((node, index) => ({ ...node, text: index ? '' : value }));
  if (!value.includes('\t')) return rebuildTextNodes(xml, 'w:t', nodes);
  const [first, ...rest] = nodes;
  const tail = xml.slice(first.end);
  const shifted = rest.map((node) => ({ ...node, start: node.start - first.end, end: node.end - first.end }));
  return `${xml.slice(0, first.start)}${wordTextContent(value)}${rebuildTextNodes(tail, 'w:t', shifted)}`;
}

export function paragraphFormatXml(properties = {}, numbering = null) {
  const tabs = Array.isArray(properties.tabStops) ? properties.tabStops : [];
  return [
    toggleXml('keepNext', properties.keepWithNext),
    toggleXml('keepLines', properties.keepTogether),
    toggleXml('pageBreakBefore', properties.pageBreakBefore),
    toggleXml('widowControl', properties.widowControl),
    numbering
      ? `<w:numPr><w:ilvl w:val="${Math.max(0, Math.min(2, Number(numbering.level) || 0))}"/>` +
        `<w:numId w:val="${numbering.numId}"/></w:numPr>`
      : '',
    paragraphBorderXml(properties.border || null),
    // A paragraph's own field (a callout, a summary band) and its indents (a quote set in from the margin),
    // in points like every other distance here; Word reads the same fill and indents through COM.
    properties.shading
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>`
      : '',
    properties.tabStops !== undefined ? `<w:tabs>${tabs.map(tabStopXml).join('')}</w:tabs>` : '',
    paragraphSpacingXml(properties),
    // w:ind follows w:spacing in the schema's pPr sequence; a validator refuses the other order.
    paragraphIndentXml(properties),
    wordJustification(properties.alignment) ? `<w:jc w:val="${wordJustification(properties.alignment)}"/>` : '',
  ].join('');
}
