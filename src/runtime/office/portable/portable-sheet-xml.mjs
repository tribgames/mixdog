import { normalizeColor } from './portable-sheet-styles.mjs';
import { columnLabel, columnNumber, parseCellRef } from './portable-cells.mjs';
import { containerBody, elementSpans, setXmlAttribute, xmlAttribute } from './portable-xml.mjs';

const WORKSHEET_SECTIONS = Object.freeze([
  'sheetPr',
  'dimension',
  'sheetViews',
  'sheetFormatPr',
  'cols',
  'sheetData',
  'sheetCalcPr',
  'sheetProtection',
  'protectedRanges',
  'scenarios',
  'autoFilter',
  'sortState',
  'dataConsolidate',
  'customSheetViews',
  'mergeCells',
  'phoneticPr',
  'conditionalFormatting',
  'dataValidations',
  'hyperlinks',
  'printOptions',
  'pageMargins',
  'pageSetup',
  'headerFooter',
  'rowBreaks',
  'colBreaks',
  'customProperties',
  'cellWatches',
  'ignoredErrors',
  'smartTags',
  'drawing',
  'legacyDrawing',
  'legacyDrawingHF',
  'picture',
  'oleObjects',
  'controls',
  'webPublishItems',
  'tableParts',
  'extLst',
]);

// Excel names take letters of any script, digits, underscores and periods, but
// no spaces or punctuation, and may not start with a digit or read as a cell
// reference. Keeping only ASCII erased 허브실적 entirely and the table was
// silently called Table1 — the name the caller asked for, gone without a word.
export function safeWorkbookTableName(value) {
  const cleaned = String(value || '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_.]/gu, '');
  let named = '';
  if (/^[\p{L}_]/u.test(cleaned)) named = cleaned;
  else if (cleaned) named = `_${cleaned}`;
  const bounded = named.slice(0, 255);
  if (!bounded) return 'Table1';
  // R, C, and anything shaped like A1 are reserved; Excel refuses the workbook.
  return /^(?:[RrCc]|[A-Za-z]{1,3}\d{1,7})$/.test(bounded) ? `_${bounded}` : bounded;
}

// Why a name Excel refuses is refused here. A defined name is written into
// formulas by the caller, so repairing it silently would break those formulas:
// the rule is reported instead. Excel will not open a workbook whose defined
// name carries a space (verified against Excel), and reads A1 or R/C as a
// reference rather than a name.
export function workbookDefinedNameFault(value) {
  const name = String(value || '');
  if (!name.trim()) return 'a name is required';
  if (name.length > 255) return `it is ${name.length} characters; Excel allows 255`;
  if (/\s/.test(name)) return `it contains a space; use an underscore (${name.replace(/\s+/g, '_')})`;
  if (!/^[\p{L}_\\]/u.test(name)) return 'it must start with a letter, underscore, or backslash';
  const offending = [...new Set([...name].filter((char) => !/[\p{L}\p{N}_.\\]/u.test(char)))];
  if (offending.length) return `it contains ${offending.join(' ')}; use letters, digits, underscores, or periods`;
  if (/^(?:[RrCc]|\$?[A-Za-z]{1,3}\$?\d{1,7})$/.test(name)) return 'Excel reads it as a cell reference, not a name';
  return '';
}

export function worksheetSection(xml, name) {
  return new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`).exec(xml);
}

export function upsertWorksheetSection(xml, name, element) {
  const existing = worksheetSection(xml, name);
  const base = existing ? `${xml.slice(0, existing.index)}${xml.slice(existing.index + existing[0].length)}` : xml;
  if (!element) return base;
  const position = WORKSHEET_SECTIONS.indexOf(name);
  for (const candidate of WORKSHEET_SECTIONS.slice(position + 1)) {
    const found = worksheetSection(base, candidate);
    if (found) return `${base.slice(0, found.index)}${element}${base.slice(found.index)}`;
  }
  return base.replace(/<\/worksheet>\s*$/, `${element}</worksheet>`);
}

export function mergedRanges(xml) {
  const section = worksheetSection(xml, 'mergeCells');
  if (!section) return [];
  return [...section[0].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)].map((match) => match[1].toUpperCase());
}

export function writeMergedRanges(xml, ranges) {
  const unique = [...new Set(ranges)];
  const element = unique.length
    ? `<mergeCells count="${unique.length}">${unique.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : '';
  return upsertWorksheetSection(xml, 'mergeCells', element);
}

function renumberWorksheetRow(rowXml, index) {
  const open = /^<row\b([^>]*?)(\/>|>)/.exec(rowXml);
  if (!open) return rowXml;
  const attrs = setXmlAttribute(open[1], 'r', index);
  if (open[2] === '/>') return `<row${attrs}/>`;
  const body = containerBody(rowXml, 'row').replace(
    /(<c\b[^>]*?\br=")([A-Z]+)\d+(")/g,
    (_match, lead, column, tail) => `${lead}${column}${index}${tail}`
  );
  return `<row${attrs}>${body}</row>`;
}

function sheetDataSection(xml) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  return sheetData;
}

function replaceSheetData(xml, inner) {
  const sheetData = sheetDataSection(xml);
  return `${xml.slice(0, sheetData.index)}<sheetData>${inner}</sheetData>${xml.slice(sheetData.index + sheetData[0].length)}`;
}

export function shiftWorksheetRows(xml, from, count) {
  const inner = containerBody(sheetDataSection(xml)[0], 'sheetData');
  const kept = [];
  for (const span of elementSpans(inner, 'row')) {
    const index = Number(/\br="(\d+)"/.exec(span.attrs)?.[1] || 0);
    if (count < 0 && index >= from && index < from - count) continue;
    const next = index >= from ? index + count : index;
    if (next < 1) continue;
    kept.push(renumberWorksheetRow(span.xml, next));
  }
  return replaceSheetData(xml, kept.join(''));
}

export function shiftWorksheetColumns(xml, from, count) {
  const inner = containerBody(sheetDataSection(xml)[0], 'sheetData');
  const rows = elementSpans(inner, 'row').map((span) => {
    const open = /^<row\b([^>]*?)(\/>|>)/.exec(span.xml);
    if (!open || open[2] === '/>') return span.xml;
    const body = containerBody(span.xml, 'row');
    const kept = [];
    for (const cell of elementSpans(body, 'c')) {
      const reference = (/\br="([A-Za-z]+\d+)"/.exec(cell.attrs)?.[1] || '').toUpperCase();
      if (!reference) continue;
      const parsed = parseCellRef(reference);
      const column = columnNumber(parsed.col);
      if (count < 0 && column >= from && column < from - count) continue;
      const next = column >= from ? column + count : column;
      if (next < 1) continue;
      kept.push(cell.xml.replace(/(\br=")[A-Za-z]+(\d+")/, `$1${columnLabel(next)}$2`));
    }
    return `<row${open[1]}>${kept.join('')}</row>`;
  });
  return replaceSheetData(xml, rows.join(''));
}

export function appendWorksheetSection(xml, name, element) {
  const existing = [...xml.matchAll(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g'))];
  if (!existing.length) return upsertWorksheetSection(xml, name, element);
  const last = existing.at(-1);
  const position = last.index + last[0].length;
  return `${xml.slice(0, position)}${element}${xml.slice(position)}`;
}

// A scale or a bar states its own colors inside the rule: the low end, the
// optional middle, and the high end for a scale; one bar color otherwise.
// Excel's defaults are a red-to-green scale and a blue bar; a caller that
// names colors gets those instead.
export function conditionalScaleRule(kind, options = {}, priority = 1) {
  const color = (value, fallback) => normalizeColor(value) || fallback;
  if (kind === 'dataBar') {
    return (
      `<cfRule type="dataBar" priority="${priority}"><dataBar>` +
      '<cfvo type="min"/><cfvo type="max"/>' +
      `<color rgb="${color(options.color || options.fillColor, 'FF638EC6')}"/>` +
      '</dataBar></cfRule>'
    );
  }
  const middle = normalizeColor(options.midColor);
  return (
    `<cfRule type="colorScale" priority="${priority}"><colorScale>` +
    '<cfvo type="min"/>' +
    (middle ? '<cfvo type="percentile" val="50"/>' : '') +
    '<cfvo type="max"/>' +
    `<color rgb="${color(options.minColor, 'FFF8696B')}"/>` +
    (middle ? `<color rgb="${middle}"/>` : '') +
    `<color rgb="${color(options.maxColor, 'FF63BE7B')}"/>` +
    '</colorScale></cfRule>'
  );
}

export function appendDifferentialFormat(stylesXml, { color = '', fillColor = '' }) {
  const font = normalizeColor(color);
  const fill = normalizeColor(fillColor);
  const dxf =
    '<dxf>' +
    (font ? `<font><color rgb="${font}"/></font>` : '') +
    (fill ? `<fill><patternFill><bgColor rgb="${fill}"/></patternFill></fill>` : '') +
    '</dxf>';
  const section = /<dxfs\b[^>]*?(?:\/>|>[\s\S]*?<\/dxfs>)/.exec(stylesXml);
  const items =
    section && !section[0].endsWith('/>')
      ? [...section[0].matchAll(/<dxf>[\s\S]*?<\/dxf>/g)].map((match) => match[0])
      : [];
  const found = items.indexOf(dxf);
  if (found >= 0) return { xml: stylesXml, id: found };
  items.push(dxf);
  const element = `<dxfs count="${items.length}">${items.join('')}</dxfs>`;
  if (section) return { xml: stylesXml.replace(section[0], element), id: items.length - 1 };
  const styles = /<cellStyles\b[^>]*?(?:\/>|>[\s\S]*?<\/cellStyles>)/.exec(stylesXml);
  if (styles) {
    const position = styles.index + styles[0].length;
    return { xml: `${stylesXml.slice(0, position)}${element}${stylesXml.slice(position)}`, id: items.length - 1 };
  }
  return { xml: stylesXml.replace('</styleSheet>', `${element}</styleSheet>`), id: items.length - 1 };
}

export function mergedCellAnchor(xml, reference) {
  const parsed = parseCellRef(reference);
  const column = columnNumber(parsed.col);
  for (const entry of mergedRanges(xml)) {
    const area = parseAreaRange(entry);
    if (area.startCol <= column && column <= area.endCol && area.startRow <= parsed.row && parsed.row <= area.endRow) {
      return area.startCol === column && area.startRow === parsed.row;
    }
  }
  return true;
}

export function sheetViewParts(view) {
  const open = /^<sheetView\b([^>]*?)(\/>|>)/.exec(view);
  if (!open) throw new Error('Worksheet view is malformed');
  return {
    attrs: open[1],
    body: open[2] === '/>' ? '' : view.slice(open[0].length, view.lastIndexOf('</sheetView>')),
  };
}

export function composeSheetView(attrs, body) {
  return body ? `<sheetView${attrs}>${body}</sheetView>` : `<sheetView${attrs}/>`;
}

export function updateSheetView(xml, mutate) {
  const section = worksheetSection(xml, 'sheetViews');
  const current = section ? /<sheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetView>)/.exec(section[0])?.[0] || '' : '';
  const next = mutate(current || '<sheetView workbookViewId="0"/>');
  return upsertWorksheetSection(xml, 'sheetViews', `<sheetViews>${next}</sheetViews>`);
}

export function freezePaneXml(row, column) {
  const ySplit = Math.max(0, (Number(row) || 0) - 1);
  const xSplit = Math.max(0, (Number(column) || 0) - 1);
  if (!ySplit && !xSplit) return '';
  const topLeft = `${columnLabel(xSplit + 1)}${ySplit + 1}`;
  let activePane = 'topRight';
  if (ySplit && xSplit) activePane = 'bottomRight';
  else if (ySplit) activePane = 'bottomLeft';
  return (
    `<pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''}` +
    ` topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>`
  );
}

export function parseAreaRange(range) {
  const text = String(range || '')
    .trim()
    .toUpperCase();
  const columns = /^([A-Z]+):([A-Z]+)$/.exec(text);
  if (columns) {
    return { startCol: columnNumber(columns[1]), endCol: columnNumber(columns[2]), startRow: 0, endRow: 0 };
  }
  const rows = /^(\d+):(\d+)$/.exec(text);
  if (rows) return { startCol: 0, endCol: 0, startRow: Number(rows[1]), endRow: Number(rows[2]) };
  const area = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(text);
  if (area) {
    const start = parseCellRef(area[1]);
    const end = parseCellRef(area[2]);
    return {
      startCol: Math.min(columnNumber(start.col), columnNumber(end.col)),
      endCol: Math.max(columnNumber(start.col), columnNumber(end.col)),
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
    };
  }
  if (/^[A-Z]+\d+$/.test(text)) {
    const single = parseCellRef(text);
    const column = columnNumber(single.col);
    return { startCol: column, endCol: column, startRow: single.row, endRow: single.row };
  }
  // A sheet-qualified reference is a near miss, not a malformed range: say
  // where the sheet belongs instead of reporting the whole string as unusable.
  if (String(range).includes('!')) {
    throw new Error(
      `Range "${range}" carries a sheet name; pass the cells alone (A1:D25) and name the sheet in the operation's sheet field`
    );
  }
  throw new Error(`Unsupported range: ${range}`);
}

// A parsed area written back as the bounded reference Excel reads ("A1:D5"):
// the inverse of parseAreaRange, and the one spelling every operation that
// records a range uses.
export function areaReference(area) {
  return `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
}

// Hangul, CJK and fullwidth forms take two character cells of a column.
const WIDE_CHARACTER = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function displayWidth(text) {
  let width = 0;
  for (const character of String(text ?? '')) width += WIDE_CHARACTER.test(character) ? 2 : 1;
  return width;
}

// Excel prints a number through its format, so the characters a column has to
// hold are the digits it renders plus every literal the format carries — a ₩
// sign, a "원" suffix, the space an _) reserves. A column narrower than this
// shows ### instead of the value, which is why both the fit audit and
// autofit_range measure the formatted text rather than the stored number.
const DATE_TOKENS = /(?:^|[^\\"'])[ymdhs]/i;

function formatSections(code) {
  const sections = [];
  let current = '';
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"') {
      const close = code.indexOf('"', index + 1);
      const end = close < 0 ? code.length : close;
      current += code.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '\\') {
      current += code.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === ';') {
      sections.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  sections.push(current);
  return sections;
}

// Roughly what a date format prints: each token as the characters it renders.
function dateWidth(section) {
  let width = 0;
  for (const token of section.matchAll(/(y+|m+|d+|h+|s+|am\/pm|a\/p)|"([^"]*)"|\\(.)|\[[^\]]*\]|(.)/gi)) {
    const [, repeated, quoted, escaped, other] = token;
    if (repeated) {
      const size = repeated.length;
      const letter = repeated[0].toLowerCase();
      if (letter === 'a') width += 2;
      else if (size >= 4) width += letter === 'y' ? 4 : 9;
      else if (size === 3) width += 3;
      else width += 2;
      continue;
    }
    if (quoted !== undefined) width += displayWidth(quoted);
    else if (escaped !== undefined) width += displayWidth(escaped);
    else if (other !== undefined) width += displayWidth(other);
  }
  return width;
}

// What Excel's General format prints: eleven characters at most, the decimals rounded to fit with trailing zeros
// dropped, scientific notation past that. Counted from the stored digits, float noise such as 0.5700000000000001
// measured eighteen characters for the 0.57 on the sheet.
export function generalNumberText(number) {
  const plain = String(number);
  if (plain.length <= 11) return plain;
  const magnitude = Math.abs(number);
  if (magnitude >= 1e11 || magnitude < 1e-9) return number.toExponential(5).replace(/\.?0+e/, 'e').toUpperCase();
  const integerDigits = magnitude < 1 ? 1 : Math.floor(Math.log10(magnitude)) + 1;
  const decimals = Math.max(0, 10 - (number < 0 ? 1 : 0) - integerDigits);
  return String(Number(number.toFixed(decimals)));
}

export function formattedNumberWidth(value, format = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) return displayWidth(String(value ?? ''));
  const code = String(format || '').trim();
  if (!code || /^general$/i.test(code) || code === '@') return displayWidth(generalNumberText(number));
  const sections = formatSections(code);
  let chosen = sections[0];
  if (number < 0) chosen = sections[1] ?? sections[0];
  else if (number === 0) chosen = sections[2] ?? sections[0];
  const section = chosen ?? '';
  if (DATE_TOKENS.test(section.replace(/"[^"]*"/g, ''))) return dateWidth(section);
  let literals = '';
  let zeroPlaces = 0;
  let decimals = 0;
  let grouped = false;
  let percent = 0;
  let thousands = 0;
  let fraction = false;
  let seenDot = false;
  let seenPlaceholder = false;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    if (char === '"') {
      const close = section.indexOf('"', index + 1);
      literals += section.slice(index + 1, close < 0 ? section.length : close);
      index = close < 0 ? section.length : close;
      continue;
    }
    if (char === '\\') {
      literals += section[index + 1] ?? '';
      index += 1;
      continue;
    }
    // _x reserves the width of x; *x repeats a fill character that never
    // widens the column.
    if (char === '_') {
      literals += ' ';
      index += 1;
      continue;
    }
    if (char === '*') {
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = section.indexOf(']', index + 1);
      const body = section.slice(index + 1, close < 0 ? section.length : close);
      // [$₩-412] carries a currency symbol; a colour or condition prints nothing.
      if (body.startsWith('$')) literals += body.slice(1).split('-')[0];
      index = close < 0 ? section.length : close;
      continue;
    }
    if (char === '0' || char === '#' || char === '?') {
      seenPlaceholder = true;
      if (seenDot) decimals += 1;
      else if (char === '0') zeroPlaces += 1;
      continue;
    }
    if (char === '.') {
      seenDot = true;
      continue;
    }
    if (char === '/') {
      fraction = true;
      continue;
    }
    if (char === ',') {
      // A comma between digit placeholders groups thousands; one after the last
      // placeholder divides the value by a thousand per comma.
      if (!seenDot && '0#?'.includes(section[index + 1] || '')) grouped = true;
      else if (seenPlaceholder) thousands += 1;
      continue;
    }
    if (char === '%') {
      percent += 1;
      literals += '%';
      continue;
    }
    if (char === '@') {
      literals += String(number);
      continue;
    }
    literals += char;
  }
  const scaled = (Math.abs(number) * 100 ** percent) / 1000 ** thousands;
  const rounded = Number(scaled.toFixed(Math.min(20, decimals)));
  const digits = Math.max(String(Math.trunc(rounded)).length, zeroPlaces, 1);
  let width = digits + displayWidth(literals);
  if (grouped && digits > 3) width += Math.floor((digits - 1) / 3);
  if (decimals) width += decimals + 1;
  // A fraction format prints its numerator and denominator after the integer.
  if (fraction) width += 3;
  // Without a section of its own, a negative value carries the sign Excel adds.
  if (number < 0 && sections.length < 2) width += 1;
  return width;
}

function columnAttributes(xml) {
  const entries = new Map();
  const existing = worksheetSection(xml, 'cols');
  if (existing) {
    for (const match of existing[0].matchAll(/<col\b([^>]*?)\/>/g)) {
      const min = Number(xmlAttribute(match[1], 'min')) || 0;
      const max = Number(xmlAttribute(match[1], 'max')) || min;
      for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
        entries.set(column, match[1]);
      }
    }
  }
  return entries;
}

function writeColumnAttributes(xml, entries) {
  const body = [...entries.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([column, attrs]) => `<col${setXmlAttribute(setXmlAttribute(attrs, 'min', column), 'max', column)}/>`)
    .join('');
  return upsertWorksheetSection(xml, 'cols', `<cols>${body}</cols>`);
}

export function writeColumnWidths(xml, widths) {
  if (!widths.size) return xml;
  const entries = columnAttributes(xml);
  for (const [column, width] of widths) {
    // A column declaration carries more than its width: hidden keeps a working
    // column out of the sheet, and the outline level and style belong to it
    // too. Replacing the declaration to fit the text put a withheld column back
    // on the page, so the width is written onto what the column already says.
    const previous = entries.get(column) ?? ` min="${column}" max="${column}"`;
    entries.set(column, setXmlAttribute(setXmlAttribute(previous, 'width', width), 'customWidth', 1));
  }
  return writeColumnAttributes(xml, entries);
}

// What the sheet does not show: a filtered or outlined row, a working column.
// An appearance check that measures one reports a defect no reader can see, and
// a reader that quotes one answers with data the workbook withheld.
export function hiddenSheetAreas(xml) {
  const rows = new Set();
  for (const [, attributes] of String(xml || '').matchAll(/<row\b([^>]*?)(?:\/>|>)/g)) {
    if (!/\bhidden="(?:1|true)"/.test(attributes)) continue;
    const row = Number(xmlAttribute(attributes, 'r')) || 0;
    if (row > 0) rows.add(row);
  }
  const columns = new Set();
  const declarations = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(String(xml || ''))?.[1] || '';
  for (const [, attributes] of declarations.matchAll(/<col\b([^>]*?)\/?>/g)) {
    if (!/\bhidden="(?:1|true)"/.test(attributes)) continue;
    const first = Number(xmlAttribute(attributes, 'min')) || 0;
    const last = Number(xmlAttribute(attributes, 'max')) || first;
    if (!first) continue;
    for (let index = first; index <= last && index - first < 2048; index += 1) columns.add(index);
  }
  return { rows, columns };
}

// A hidden column keeps its width and its values; only the sheet stops showing
// it. The declarations are stored per range, so each target column is written
// as its own entry rather than splitting someone else's range by hand.
export function writeColumnVisibility(xml, columns, visible) {
  if (!columns.length) return xml;
  const entries = columnAttributes(xml);
  for (const column of columns) {
    const attrs = (entries.get(column) || ` min="${column}" max="${column}" width="9.14" customWidth="1"`).replace(
      /\s*\bhidden="[^"]*"/,
      ''
    );
    entries.set(column, visible ? attrs : setXmlAttribute(attrs, 'hidden', '1'));
  }
  return writeColumnAttributes(xml, entries);
}

export function quoteSheetName(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}

export function absoluteRange(range) {
  return String(range)
    .split(':')
    .map((part) => part.replace(/^([A-Za-z]+)(\d+)$/, '$$$1$$$2'))
    .join(':');
}

export function upsertDefinedName(xml, entry, matches) {
  const section = /<definedNames\b[^>]*?(?:\/>|>[\s\S]*?<\/definedNames>)/.exec(xml);
  const items = section
    ? [...section[0].matchAll(/<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)/g)].map((match) => match[0])
    : [];
  const kept = items.filter((item) => !matches(item));
  if (entry) kept.push(entry);
  const element = kept.length ? `<definedNames>${kept.join('')}</definedNames>` : '';
  if (section) {
    return `${xml.slice(0, section.index)}${element}${xml.slice(section.index + section[0].length)}`;
  }
  if (!element) return xml;
  const calculation = /<calcPr\b[^>]*?(?:\/>|>[\s\S]*?<\/calcPr>)/.exec(xml);
  if (calculation) return `${xml.slice(0, calculation.index)}${element}${xml.slice(calculation.index)}`;
  return xml.replace(/<\/workbook>\s*$/, `${element}</workbook>`);
}
