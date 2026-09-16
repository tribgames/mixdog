import { join } from 'node:path';
import { tableXml } from './portable-slide-shapes.mjs';
import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import { containerInner, topLevelElements, xmlEncode } from './portable-xml.mjs';

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

export function wordTableProperties(properties = {}, { totalWidth = 0 } = {}) {
  const styled = properties.borders || properties.style || properties.shading;
  const borders = properties.borders || (styled ? {} : DEFAULT_TABLE_BORDERS);
  const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  // Two ways to say it: one spec for every side, or a spec per side. Naming one
  // side used to fall back to the whole object for the others, so asking for a
  // single rule on top drew a full grid.
  const perSide = sides.some((side) => borders[side] !== undefined);
  const borderXml = Object.keys(borders).length
    ? `<w:tblBorders>${sides
        .map((side) => {
          const value = perSide ? borders[side] : borders;
          if (!value || typeof value !== 'object' || value.enabled === false) return '';
          return `<w:${side} w:val="${xmlEncode(value.style || 'single')}" w:sz="${Math.max(1, Number(value.size) || 4)}" w:space="${Math.max(0, Number(value.space) || 0)}" w:color="${xmlEncode(String(value.color || 'auto').replace(/^#/, ''))}"/>`;
        })
        .join('')}</w:tblBorders>`
    : '';
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

export function wordCellProperties(properties = {}) {
  return [
    properties.width ? `<w:tcW w:w="${pointsToTwips(properties.width)}" w:type="dxa"/>` : '',
    properties.fillColor
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.fillColor).replace(/^#/, ''))}"/>`
      : '',
    properties.verticalAlignment ? `<w:vAlign w:val="${xmlEncode(properties.verticalAlignment)}"/>` : '',
  ].join('');
}

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
  const existing = /<w:tcPr(?:\s[^>]*)?>([\s\S]*?)<\/w:tcPr>/.exec(cellXml)?.[1] || '';
  const merged = new Map();
  for (const element of [...runPropertyElements(existing), ...runPropertyElements(wordCellProperties(properties))]) {
    merged.set(element.tag, element.xml);
  }
  const rank = (tag) => {
    const index = CELL_PROPERTY_ORDER.indexOf(tag);
    return index === -1 ? CELL_PROPERTY_ORDER.length : index;
  };
  const inner = [...merged.entries()]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([, xml]) => xml)
    .join('');
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
    latin || eastAsia
      ? `<w:rFonts${latin ? ` w:ascii="${latin}" w:hAnsi="${latin}" w:cs="${latin}"` : ''}${eastAsia ? ` w:eastAsia="${eastAsia}"` : ''}/>`
      : '',
    bold ? '<w:b/><w:bCs/>' : '',
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    Number.isFinite(size) && size > 0
      ? `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`
      : '',
  ].join('');
}

// Every cell of a row shares one minimum line height: a Latin-only figure
// beside a Hangul label otherwise takes its own face's shorter line and sits
// on a different baseline; with the height fixed, both text runs sit on the
// same line bottom.
function wordTableParagraphProperties(properties = {}) {
  const spacing = Number(properties.spacingAfter);
  const size = Number(properties.fontSize) > 0 ? Number(properties.fontSize) : 11;
  return [
    properties.textStyle ? `<w:pStyle w:val="${xmlEncode(docxStyleId(properties.textStyle))}"/>` : '',
    `<w:spacing${Number.isFinite(spacing) ? ` w:after="${Math.max(0, Math.round(spacing * 20))}"` : ''} w:line="${Math.round(size * 1.3 * 20)}" w:lineRule="atLeast"/>`,
  ].join('');
}

// A column's text alignment is the justification of the paragraphs in its cells.
const WORD_JUSTIFICATION = Object.freeze({
  left: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  justify: 'both',
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
      ? stripped.replace(/<\/w:pPr>/, `<w:jc w:val="${justification}"/></w:pPr>`)
      : stripped.replace(/^(<w:p(?:\s[^>]*)?>)/, `$1<w:pPr><w:jc w:val="${justification}"/></w:pPr>`);
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
      nextRow = nextRow.replace(cell[0], justifyWordParagraphs(cell[0], justifications[column]));
    });
    next = next.replace(row[0], nextRow);
  }
  return next;
}

export function wordTableXml(operation) {
  const values = Array.isArray(operation.values) ? operation.values : [];
  const rows = Math.max(1, Number(operation.rows) || values.length || 1);
  const columns = Math.max(1, Number(operation.columns) || Math.max(0, ...values.map((row) => row.length)) || 1);
  const widths = operation.properties?.columnWidths || [];
  const heights = operation.properties?.rowHeights || [];
  const justifications = (operation.properties?.columnAlignments || []).map(wordJustification);
  const runProperties = wordTableRunProperties(operation.properties);
  // The header row is set apart by weight, on both backends, unless the caller
  // says otherwise; a header a reader cannot tell from the data is not one.
  const headerBold =
    rows > 1 && operation.properties?.headerBold !== false && operation.properties?.repeatHeader !== false;
  const headerRunProperties = headerBold ? wordTableRunProperties(operation.properties, { bold: true }) : runProperties;
  const paragraphProperties = wordTableParagraphProperties(operation.properties);
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
      row === 0 && repeatHeader ? '<w:tblHeader/>' : '',
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
          .map(
            (line, lineIndex) =>
              `${lineIndex ? '<w:br/>' : ''}<w:t${/^\s|\s$/.test(line) ? ' xml:space="preserve"' : ''}>${xmlEncode(line)}</w:t>`
          )
          .join('');
        // Schema order inside pPr: style and spacing before justification.
        const cellParagraphProperties = `${paragraphProperties}${justifications[column] ? `<w:jc w:val="${justifications[column]}"/>` : ''}`;
        const cellRunProperties = row === 0 ? headerRunProperties : runProperties;
        // Cells sit on their bottom edge: a Latin-only figure ("+3.0%") beside a Hangul one ("1,000건") takes a
        // shorter line in every renderer, and top-aligned the two read on different baselines. Bottom-aligned,
        // one row shares one baseline; set_table_cell_style verticalAlignment overrides per cell.
        return `<w:tc><w:tcPr>${width}<w:vAlign w:val="bottom"/></w:tcPr><w:p>${cellParagraphProperties ? `<w:pPr>${cellParagraphProperties}</w:pPr>` : ''}<w:r>${cellRunProperties ? `<w:rPr>${cellRunProperties}</w:rPr>` : ''}${runs}</w:r></w:p></w:tc>`;
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

export function mergeWordRunProperties(existing, overrides) {
  const merged = new Map();
  for (const element of [...runPropertyElements(existing), ...runPropertyElements(overrides)]) {
    merged.set(element.tag, element.xml);
  }
  const rank = (tag) => {
    const index = RUN_PROPERTY_ORDER.indexOf(tag);
    return index === -1 ? RUN_PROPERTY_ORDER.length : index;
  };
  return [...merged.entries()]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([, xml]) => xml)
    .join('');
}

export function applyWordRunFormat(xml, runFormat) {
  if (!runFormat) return xml;
  return String(xml).replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) => {
    const selfClosed = /<w:rPr\b[^>]*\/>/.exec(run);
    const opened = /<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/.exec(run);
    if (opened) return run.replace(opened[0], `<w:rPr>${mergeWordRunProperties(opened[1], runFormat)}</w:rPr>`);
    if (selfClosed) return run.replace(selfClosed[0], `<w:rPr>${runFormat}</w:rPr>`);
    return run.replace(/<w:r(?:\s[^>]*)?>/, (open) => `${open}<w:rPr>${runFormat}</w:rPr>`);
  });
}

export function wordRunProperties(properties = {}) {
  const size = Number(properties.size ?? properties.fontSize);
  const half = Number.isFinite(size) && size > 0 ? Math.max(2, Math.round(size * 2)) : 0;
  return [
    properties.name || properties.nameEastAsia
      ? `<w:rFonts${properties.name ? ` w:ascii="${xmlEncode(properties.name)}" w:hAnsi="${xmlEncode(properties.name)}"` : ''}${properties.nameEastAsia ? ` w:eastAsia="${xmlEncode(properties.nameEastAsia)}"` : ''}/>`
      : '',
    properties.bold !== undefined ? `<w:b w:val="${properties.bold ? '1' : '0'}"/>` : '',
    properties.italic !== undefined ? `<w:i w:val="${properties.italic ? '1' : '0'}"/>` : '',
    properties.underline !== undefined ? `<w:u w:val="${properties.underline ? 'single' : 'none'}"/>` : '',
    // A working note travels with the document without being part of it: Word
    // hides the run, and the runtime already reads it back as hidden text.
    properties.hidden !== undefined ? `<w:vanish w:val="${properties.hidden ? '1' : '0'}"/>` : '',
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    half ? `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` : '',
  ].join('');
}

export function wordParagraph(text, { alignment = '', style = '' } = {}) {
  const properties = [
    style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : '',
    alignment ? `<w:jc w:val="${xmlEncode(alignment)}"/>` : '',
  ].join('');
  const value = String(text ?? '');
  return (
    `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}` +
    `<w:r><w:t${/^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''}>${xmlEncode(value)}</w:t></w:r></w:p>`
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
    next = next.replace(grid[0], `<w:tblGrid>${columns.join('')}</w:tblGrid>`);
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
  const inner = containerInner(rowXml, 'w:tr');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tc']).map((cell) => cell.xml);
}

export function tableRowMatches(tableXml) {
  return tableRows(tableXml).map((row) => {
    const match = [row.xml];
    match.index = row.start;
    return match;
  });
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

export function docxTable(current, number) {
  const match = docxTables(current)[Number(number) - 1];
  if (!match) throw new Error(`DOCX table ${number} not found`);
  return match;
}

export function replaceDocxTable(current, table, nextTable) {
  return `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
}

export function replaceWordProperties(xml, owner, propertyTag, value) {
  const pattern = new RegExp(`<w:${propertyTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:${propertyTag}>`);
  if (pattern.test(xml)) return xml.replace(pattern, `<w:${propertyTag}>${value}</w:${propertyTag}>`);
  return xml.replace(
    new RegExp(`<w:${owner}(?:\\s[^>]*)?>`),
    (open) => `${open}<w:${propertyTag}>${value}</w:${propertyTag}>`
  );
}

export function paragraphFormatXml(properties = {}, numbering = null) {
  const border = properties.border || null;
  const tabs = Array.isArray(properties.tabStops) ? properties.tabStops : [];
  return [
    properties.keepWithNext !== undefined ? `<w:keepNext w:val="${properties.keepWithNext ? '1' : '0'}"/>` : '',
    properties.keepTogether !== undefined ? `<w:keepLines w:val="${properties.keepTogether ? '1' : '0'}"/>` : '',
    properties.pageBreakBefore !== undefined
      ? `<w:pageBreakBefore w:val="${properties.pageBreakBefore ? '1' : '0'}"/>`
      : '',
    properties.widowControl !== undefined ? `<w:widowControl w:val="${properties.widowControl ? '1' : '0'}"/>` : '',
    numbering
      ? `<w:numPr><w:ilvl w:val="${Math.max(0, Math.min(2, Number(numbering.level) || 0))}"/>` +
        `<w:numId w:val="${numbering.numId}"/></w:numPr>`
      : '',
    // The gap between a rule and the text is Word's own default per side (4 pt beside, 1 pt above or below),
    // the distance Word applies through COM; a callout's left rule otherwise touches its label.
    border
      ? `<w:pBdr><w:${xmlEncode(border.side || 'bottom')} w:val="${xmlEncode(border.style || 'single')}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${Math.max(0, Number.isFinite(Number(border.space)) && border.space !== undefined && border.space !== null && border.space !== '' ? Number(border.space) : ['left', 'right'].includes(String(border.side || 'bottom')) ? 4 : 1)}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>`
      : '',
    // A paragraph's own field (a callout, a summary band) and its indents (a quote set in from the margin),
    // in points like every other distance here; Word reads the same fill and indents through COM.
    properties.shading
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>`
      : '',
    properties.tabStops !== undefined
      ? `<w:tabs>${tabs.map((tab) => `<w:tab w:val="${xmlEncode(tab.alignment || 'left')}" w:pos="${pointsToTwips(tab.position || 0)}"${tab.leader ? ` w:leader="${xmlEncode(tab.leader)}"` : ''}/>`).join('')}</w:tabs>`
      : '',
    properties.spacingBefore !== undefined ||
    properties.spacingAfter !== undefined ||
    properties.lineSpacing !== undefined
      ? `<w:spacing${properties.spacingBefore !== undefined ? ` w:before="${Math.max(0, Math.round(Number(properties.spacingBefore) * 20))}"` : ''}${properties.spacingAfter !== undefined ? ` w:after="${Math.max(0, Math.round(Number(properties.spacingAfter) * 20))}"` : ''}${properties.lineSpacing !== undefined ? ` w:line="${Math.max(1, Math.round(Number(properties.lineSpacing) * 20))}" w:lineRule="atLeast"` : ''}/>`
      : '',
    // w:ind follows w:spacing in the schema's pPr sequence; a validator refuses the other order.
    properties.indentLeft !== undefined ||
    properties.indentRight !== undefined ||
    properties.indentFirstLine !== undefined
      ? `<w:ind${properties.indentLeft !== undefined ? ` w:left="${Math.max(0, Math.round(Number(properties.indentLeft) * 20))}"` : ''}${properties.indentRight !== undefined ? ` w:right="${Math.max(0, Math.round(Number(properties.indentRight) * 20))}"` : ''}${properties.indentFirstLine !== undefined ? ` w:firstLine="${Math.max(0, Math.round(Number(properties.indentFirstLine) * 20))}"` : ''}/>`
      : '',
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
  ].join('');
}
