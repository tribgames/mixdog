import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import {
  WORD_RUN_SOURCE,
  containerInner,
  rebuildTextNodes,
  textNodes,
  topLevelElements,
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
      return `<w:${side} w:val="${xmlEncode(value.style || 'single')}" w:sz="${Math.max(1, Number(value.size) || 4)}" w:space="${Math.max(0, Number(value.space) || 0)}" w:color="${xmlEncode(String(value.color || 'auto').replace(/^#/, ''))}"/>`;
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

export function applyWordRunFormat(xml, runFormat) {
  if (!runFormat) return xml;
  return String(xml).replace(new RegExp(WORD_RUN_SOURCE, 'g'), (run) => {
    const selfClosed = /<w:rPr\b[^>]*\/>/.exec(run);
    const opened = /<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/.exec(run);
    if (opened) {
      const merged = mergeWordPropertyElements(opened[1], runFormat, RUN_PROPERTY_ORDER);
      return run.replace(opened[0], `<w:rPr>${merged}</w:rPr>`);
    }
    if (selfClosed) return run.replace(selfClosed[0], `<w:rPr>${runFormat}</w:rPr>`);
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
  return rowCellMatches(rowXml).map((match) => match[0]);
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

// The gap between a rule and the text is Word's own default per side (4 pt beside, 1 pt above or below),
// the distance Word applies through COM; a callout's left rule otherwise touches its label.
function paragraphBorderXml(border) {
  if (!border) return '';
  const side = String(border.side || 'bottom');
  const explicitSpace =
    border.space !== undefined && border.space !== null && border.space !== '' && Number.isFinite(Number(border.space));
  const defaultSpace = ['left', 'right'].includes(side) ? 4 : 1;
  const space = Math.max(0, explicitSpace ? Number(border.space) : defaultSpace);
  return `<w:pBdr><w:${xmlEncode(side)} w:val="${xmlEncode(border.style || 'single')}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${space}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>`;
}

function tabStopXml(tab) {
  const leader = tab.leader ? ` w:leader="${xmlEncode(tab.leader)}"` : '';
  return `<w:tab w:val="${xmlEncode(tab.alignment || 'left')}" w:pos="${pointsToTwips(tab.position || 0)}"${leader}/>`;
}

function paragraphSpacingXml({ spacingBefore, spacingAfter, lineSpacing }) {
  if (spacingBefore === undefined && spacingAfter === undefined && lineSpacing === undefined) return '';
  const before =
    spacingBefore !== undefined ? ` w:before="${Math.max(0, Math.round(Number(spacingBefore) * 20))}"` : '';
  const after = spacingAfter !== undefined ? ` w:after="${Math.max(0, Math.round(Number(spacingAfter) * 20))}"` : '';
  const line =
    lineSpacing !== undefined
      ? ` w:line="${Math.max(1, Math.round(Number(lineSpacing) * 20))}" w:lineRule="atLeast"`
      : '';
  return `<w:spacing${before}${after}${line}/>`;
}

function paragraphIndentXml({ indentLeft, indentRight, indentFirstLine }) {
  if (indentLeft === undefined && indentRight === undefined && indentFirstLine === undefined) return '';
  const twips = (points) => Math.max(0, Math.round(Number(points) * 20));
  const left = indentLeft !== undefined ? ` w:left="${twips(indentLeft)}"` : '';
  const right = indentRight !== undefined ? ` w:right="${twips(indentRight)}"` : '';
  const firstLine = indentFirstLine !== undefined ? ` w:firstLine="${twips(indentFirstLine)}"` : '';
  return `<w:ind${left}${right}${firstLine}/>`;
}

/**
 * A run's text content. Each tab is Word's own `<w:tab/>` element: a TAB
 * character inside `<w:t>` renders as a space, so the paragraph's tab stops (a
 * right-aligned figure, a dot leader) never see it.
 */
export function wordTextContent(text, { preserve = false } = {}) {
  const textXml = (part) =>
    `<w:t${preserve || /^\s|\s$/.test(part) ? ' xml:space="preserve"' : ''}>${xmlEncode(part)}</w:t>`;
  const value = String(text ?? '');
  if (!value.includes('\t')) return textXml(value);
  return value
    .split('\t')
    .map((part) => (part ? textXml(part) : ''))
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
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
  ].join('');
}
