import { extname, posix } from 'node:path';
import { applyCellStyle, resolveCellStyles } from './portable-sheet-styles.mjs';
import {
  conditionalFormatKind,
  listValidationChoices,
  listValidationFormula,
  normalizeXlsxFormula,
} from './xlsx-contract.mjs';
import { chartXml } from './portable-chart.mjs';
import { applyWorksheetPageSetup, fitDrawingSheetOnePageWide, worksheetGeometry } from './portable-sheet-page.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import { summarizePivotFields, writePivotTable } from './portable-pivot.mjs';
import {
  cellRecords,
  cellStyleIndexes,
  columnLabel,
  columnNumber,
  expandRange,
  forceWorkbookRecalculation,
  parseCellRef,
  setCellInSheet,
  setCellStylesInSheet,
  setCellsInSheet,
  sharedStrings,
  workbookSheets,
} from './portable-cells.mjs';
import {
  CHART_CONTENT_TYPE,
  IMAGE_CONTENT_TYPES,
  PIXELS_TO_POINTS,
  addPackageRelationship,
  ensureContentTypeOverride,
  ensureDefaultContentType,
  imagePixelSize,
  nextRelationshipId,
  partRelationshipPath,
  provenanceCitation,
  zipText,
} from './portable-opc.mjs';
import {
  OFFICE_RELATIONSHIP_BASE,
  SPREADSHEET_MAIN,
  XML_HEADER,
  containerBody,
  replaceAcrossRuns,
  setXmlAttribute,
  tagPattern,
  xmlAttribute,
  xmlDecode,
  xmlEncode,
} from './portable-xml.mjs';
import { ensureWorksheetDrawing, excelPasswordHash, writeWorksheetNote } from './portable-sheet-parts.mjs';
import {
  appendDifferentialFormat,
  appendWorksheetSection,
  composeSheetView,
  conditionalScaleRule,
  displayWidth,
  formattedNumberWidth,
  freezePaneXml,
  hiddenSheetAreas,
  mergedCellAnchor,
  mergedRanges,
  parseAreaRange,
  quoteSheetName,
  safeWorkbookTableName,
  sheetViewParts,
  shiftWorksheetColumns,
  shiftWorksheetRows,
  updateSheetView,
  upsertDefinedName,
  upsertWorksheetSection,
  workbookDefinedNameFault,
  worksheetSection,
  writeColumnVisibility,
  writeColumnWidths,
  writeMergedRanges,
} from './portable-sheet-xml.mjs';

const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

const WORKSHEET_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

const MAX_STYLED_CELLS = 20_000;

// A printed sheet names its pages the way a PDF stamp does — {page} / {pages} —
// instead of Excel's field codes. An ampersand opens a code, so the caller's
// own text is escaped first and the tokens become codes afterwards; without
// this a page number could not be written at all on the portable backend.
function headerFooterFields(text) {
  return String(text ?? '')
    .replace(/&/g, '&&')
    .replace(/\{page\}/gi, '&P')
    .replace(/\{pages\}/gi, '&N')
    .replace(/\{date\}/gi, '&D')
    .replace(/\{time\}/gi, '&T')
    .replace(/\{sheet\}/gi, '&A')
    .replace(/\{file\}/gi, '&F');
}

// The sort key is named the way the caller already reads the sheet: a column
// letter, the header the column carries, or nothing when the first column of
// the range is the key.
function sortKeyColumn(op, area, headerValue) {
  const declared = String(op.by ?? op.column ?? op.byColumn ?? '').trim();
  if (!declared) return area.startCol;
  if (/^[A-Za-z]{1,3}$/.test(declared)) {
    const column = columnNumber(declared.toUpperCase());
    if (column < area.startCol || column > area.endCol) {
      throw new Error(`XLSX sort_range by "${declared}" is outside ${op.range}; name a column the range covers.`);
    }
    return column;
  }
  const headers = [];
  for (let col = area.startCol; col <= area.endCol; col += 1) {
    const value = headerValue(col);
    const text = value == null ? '' : String(value).trim();
    if (text) headers.push(`${columnLabel(col)} (${text})`);
    if (text && text === declared) return col;
  }
  throw new Error(
    `XLSX sort_range by "${declared}" matches no column in ${op.range}. Name a column letter or one of its headers: ${headers.join(', ') || '(the range has no header row)'}.`
  );
}

// Excel orders numbers before text and leaves blanks last in both directions;
// text is compared the way the reader's locale reads it, so 강릉 sorts before
// 광주 rather than by code point.
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareSortValues(left, right) {
  const blank = (value) => value == null || value === '';
  if (blank(left) && blank(right)) return 0;
  if (blank(left)) return 1;
  if (blank(right)) return -1;
  const leftNumber = typeof left === 'number' ? left : Number(left);
  const rightNumber = typeof right === 'number' ? right : Number(right);
  const leftNumeric = typeof left === 'number' || (String(left).trim() !== '' && Number.isFinite(leftNumber));
  const rightNumeric = typeof right === 'number' || (String(right).trim() !== '' && Number.isFinite(rightNumber));
  if (leftNumeric && rightNumeric) return leftNumber - rightNumber;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return SORT_COLLATOR.compare(String(left), String(right));
}

// A snapshot reports where a picture or chart sits as cells (A1 to C5), so a
// caller placing one names a cell too. The sheet's own column widths and row
// heights turn that cell into the point offset the drawing anchor stores.
function cellAnchorPoints(xml, cell) {
  const { columnPoints, rowPoints } = worksheetGeometry(xml);
  const { col, row } = parseCellRef(cell);
  const column = columnNumber(col);
  let left = 0;
  for (let index = 1; index < column; index += 1) left += columnPoints(index);
  let top = 0;
  for (let index = 1; index < row; index += 1) top += rowPoints(index);
  return { left, top };
}

// A reader who cannot see the picture hears this description; Excel reads it
// from the drawing's descr.
function pictureDescription(altText) {
  const text = String(altText ?? '').trim();
  return text ? ` descr="${xmlEncode(text)}"` : '';
}

// Cell validation as both backends express it: the OOXML names here, the Excel
// enumeration in the COM host.
const XLSX_VALIDATION_TYPES = Object.freeze({
  list: 'list',
  whole: 'whole',
  decimal: 'decimal',
  date: 'date',
  time: 'time',
  textlength: 'textLength',
  custom: 'custom',
});

const XLSX_VALIDATION_OPERATORS = Object.freeze({
  between: 'between',
  notbetween: 'notBetween',
  equal: 'equal',
  notequal: 'notEqual',
  greaterthan: 'greaterThan',
  lessthan: 'lessThan',
  greaterthanorequal: 'greaterThanOrEqual',
  lessthanorequal: 'lessThanOrEqual',
});

const TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';

// A built-in table style bands the range from the workbook's own theme, which
// is not the palette a composed sheet paints with. style:'none' keeps the
// table — its name, its filters, its structured references — and leaves the
// colours to whoever set them.
function tableStyleInfoXml(style) {
  const name = style === undefined ? 'TableStyleMedium2' : String(style).trim();
  if (!name || name.toLowerCase() === 'none') {
    return '<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/>';
  }
  return (
    `<tableStyleInfo name="${xmlEncode(name)}"` +
    ' showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>'
  );
}

function emptyWorksheetXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${SPREADSHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}">` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<sheetData/></worksheet>'
  );
}

// Excel refuses these itself: a workbook written with such a name opens as a
// repair prompt, which is a worse answer than refusing the operation here.
const FORBIDDEN_SHEET_CHARACTERS = /[:\\/?*[\]]/;

function assertWorksheetName(operation, name) {
  const label = String(name || '').trim();
  if (!label) throw new Error(`${operation} requires name`);
  if (label.length > 31) throw new Error('Worksheet names are limited to 31 characters');
  const forbidden = FORBIDDEN_SHEET_CHARACTERS.exec(label);
  if (forbidden) {
    throw new Error(`Worksheet names cannot contain : \\ / ? * [ ] — "${label}" has ${forbidden[0]}`);
  }
  if (/^'|'$/.test(label)) throw new Error(`Worksheet names cannot start or end with an apostrophe: ${label}`);
  if (/^history$/i.test(label)) throw new Error('History is reserved by Excel and cannot name a worksheet');
  return label;
}

async function addWorksheet(zip, name) {
  const label = assertWorksheetName('add_sheet', name);
  const workbookPath = 'xl/workbook.xml';
  const workbook = await zipText(zip, workbookPath);
  if (new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(label))}"`, 'i').test(workbook)) {
    throw new Error(`Worksheet already exists: ${label}`);
  }
  let ordinal = 1;
  while (zip.file(`xl/worksheets/sheet${ordinal}.xml`)) ordinal += 1;
  const part = `xl/worksheets/sheet${ordinal}.xml`;
  zip.file(part, emptyWorksheetXml());
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const rels = await zipText(zip, relsPath);
  if (!rels) throw new Error('Workbook relationships are missing');
  const relationshipId = nextRelationshipId(rels);
  zip.file(
    relsPath,
    rels.replace(
      '</Relationships>',
      `<Relationship Id="${relationshipId}" Type="${WORKSHEET_RELATIONSHIP}" Target="worksheets/sheet${ordinal}.xml"/></Relationships>`
    )
  );
  const sheetIds = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
  const sheetId = Math.max(0, ...sheetIds) + 1;
  const entry = `<sheet name="${xmlEncode(label)}" sheetId="${sheetId}" r:id="${relationshipId}"/>`;
  const sheetsSection = /<sheets\b[^>]*?(?:\/>|>[\s\S]*?<\/sheets>)/.exec(workbook);
  if (!sheetsSection) throw new Error('Workbook is missing its sheet list');
  const next = sheetsSection[0].endsWith('/>')
    ? `<sheets>${entry}</sheets>`
    : sheetsSection[0].replace('</sheets>', `${entry}</sheets>`);
  zip.file(
    workbookPath,
    `${workbook.slice(0, sheetsSection.index)}${next}${workbook.slice(sheetsSection.index + sheetsSection[0].length)}`
  );
  const types = await zipText(zip, '[Content_Types].xml');
  if (!types.includes(`PartName="/${part}"`)) {
    zip.file(
      '[Content_Types].xml',
      types.replace('</Types>', `<Override PartName="/${part}" ContentType="${WORKSHEET_CONTENT_TYPE}"/></Types>`)
    );
  }
  return { name: label, path: part, sheetId };
}

async function renameWorksheet(zip, sheet, name) {
  const label = assertWorksheetName('rename_sheet', name);
  const workbookPath = 'xl/workbook.xml';
  const workbook = await zipText(zip, workbookPath);
  const pattern = new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(sheet.name))}"[^>]*\\/>`, 'i');
  const match = pattern.exec(workbook);
  if (!match) throw new Error(`Worksheet not found: ${sheet.name}`);
  const replaced = match[0].replace(/\bname="[^"]*"/, `name="${xmlEncode(label)}"`);
  zip.file(
    workbookPath,
    `${workbook.slice(0, match.index)}${replaced}${workbook.slice(match.index + match[0].length)}`
  );
  return { from: sheet.name, to: label };
}

async function deleteWorksheet(zip, sheets, sheet) {
  if (sheets.length <= 1) throw new Error('A workbook must keep at least one worksheet');
  const index = sheets.findIndex((entry) => entry.name === sheet.name);
  const workbookPath = 'xl/workbook.xml';
  let workbook = await zipText(zip, workbookPath);
  const pattern = new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(sheet.name))}"[^>]*\\/>`, 'i');
  const match = pattern.exec(workbook);
  if (!match) throw new Error(`Worksheet not found: ${sheet.name}`);
  workbook = `${workbook.slice(0, match.index)}${workbook.slice(match.index + match[0].length)}`;
  workbook = upsertDefinedName(workbook, '', (item) => Number(xmlAttribute(item, 'localSheetId')) === index);
  workbook = workbook.replace(/<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)/g, (item) => {
    const local = Number(xmlAttribute(item, 'localSheetId'));
    return Number.isFinite(local) && local > index
      ? item.replace(/\blocalSheetId="\d+"/, `localSheetId="${local - 1}"`)
      : item;
  });
  zip.file(workbookPath, workbook);
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const rels = await zipText(zip, relsPath);
  zip.file(relsPath, rels.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${tagPattern(sheet.rid)}"[^>]*\\/>`), ''));
  zip.remove(sheet.path);
  const partRels = `${posix.dirname(sheet.path)}/_rels/${posix.basename(sheet.path)}.rels`;
  if (zip.file(partRels)) zip.remove(partRels);
  const types = await zipText(zip, '[Content_Types].xml');
  zip.file(
    '[Content_Types].xml',
    types.replace(new RegExp(`<Override\\b[^>]*\\bPartName="/${tagPattern(sheet.path)}"[^>]*\\/>`), '')
  );
  return { sheet: sheet.name };
}

/** Places a picture on the sheet's drawing, sized from the file when no size is given. */
async function addWorksheetImage(zip, sheet, xml, op) {
  const extension = extname(String(op.path || ''))
    .replace(/^\./, '')
    .toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(
      `Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`
    );
  }
  const data = await readFile(op.path);
  let mediaOrdinal = 1;
  while (zip.file(`xl/media/image${mediaOrdinal}.${extension}`)) mediaOrdinal += 1;
  const mediaPart = `xl/media/image${mediaOrdinal}.${extension}`;
  zip.file(mediaPart, data);
  await ensureDefaultContentType(zip, extension, contentType);
  const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
  const imageFit = fitDrawingSheetOnePageWide(drawing.worksheet);
  xml = imageFit.xml;
  const embedId = await addPackageRelationship(
    zip,
    partRelationshipPath(drawing.part),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    posix.relative(posix.dirname(drawing.part), mediaPart)
  );
  const pixels = imagePixelSize(data);
  const width = Number(op.width) > 0 ? Number(op.width) : pixels ? pixels.width * PIXELS_TO_POINTS : 240;
  const height = Number(op.height) > 0 ? Number(op.height) : pixels ? pixels.height * PIXELS_TO_POINTS : 180;
  const drawingXml = await zipText(zip, drawing.part);
  const anchorCount = (drawingXml.match(/<xdr:(absolute|two|one)CellAnchor\b/g) || []).length;
  const placement = op.cell ? cellAnchorPoints(xml, op.cell) : { left: 0, top: 0 };
  const anchor =
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${toEmu(op.left ?? placement.left)}" y="${toEmu(op.top ?? placement.top)}"/>` +
    `<xdr:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${anchorCount + 2}" name="Picture ${anchorCount + 1}"${pictureDescription(op.altText)}/>` +
    '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    `<xdr:blipFill><a:blip r:embed="${embedId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
    '<xdr:clientData/></xdr:absoluteAnchor>';
  zip.file(drawing.part, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
  zip.file(sheet.path, xml);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    image: mediaPart,
    ...(op.cell ? { cell: String(op.cell).toUpperCase() } : {}),
    ...(String(op.altText ?? '').trim() ? { altText: String(op.altText).trim() } : {}),
  };
}

/** Writes one slot of a sheet's header or footer, keeping the other slots and the other story. */
async function setWorksheetHeaderFooter(zip, sheet, xml, op) {
  const named = String(op.kind || '').toLowerCase();
  if (!['header', 'footer'].includes(named)) throw new Error('set_header_footer kind must be header or footer');
  const alignment = String(op.alignment || 'center').toLowerCase();
  const slot = { left: 'L', center: 'C', right: 'R' }[alignment];
  if (!slot) throw new Error('set_header_footer alignment must be left, center, or right');
  const existing = worksheetSection(xml, 'headerFooter')?.[0] || '';
  const kept =
    named === 'header'
      ? /<oddFooter>[\s\S]*?<\/oddFooter>/.exec(existing)?.[0] || ''
      : /<oddHeader>[\s\S]*?<\/oddHeader>/.exec(existing)?.[0] || '';
  // Excel keeps all three slots of one story in a single string. Writing the
  // whole element for one slot dropped the others, so a sheet could carry a
  // title or a page number but never both: only the named slot is replaced.
  const story = named === 'header' ? 'oddHeader' : 'oddFooter';
  const current = xmlDecode(new RegExp(`<${story}>([\\s\\S]*?)</${story}>`).exec(existing)?.[1] || '');
  const slots = { L: '', C: '', R: '' };
  let reading = 'C';
  let buffer = '';
  for (let index = 0; index < current.length; index += 1) {
    // && is the caller's own ampersand; &L/&C/&R open a slot and every
    // other code (&P, &N, &D) belongs to the slot being read.
    if (current[index] === '&' && current[index + 1] === '&') {
      buffer += '&&';
      index += 1;
      continue;
    }
    if (current[index] === '&' && 'LCR'.includes(current[index + 1])) {
      slots[reading] = buffer;
      buffer = '';
      reading = current[index + 1];
      index += 1;
      continue;
    }
    buffer += current[index];
  }
  slots[reading] = buffer;
  slots[slot] = headerFooterFields(op.text);
  const encoded = xmlEncode(
    ['L', 'C', 'R']
      .filter((key) => slots[key] !== '')
      .map((key) => `&${key}${slots[key]}`)
      .join('')
  );
  const written = `<${story}>${encoded}</${story}>`;
  zip.file(
    sheet.path,
    upsertWorksheetSection(
      xml,
      'headerFooter',
      `<headerFooter>${named === 'header' ? `${written}${kept}` : `${kept}${written}`}</headerFooter>`
    )
  );
  return { op: op.op, changed: true, sheet: sheet.name, kind: named, alignment };
}

/** Adds a conditional rule over a range, or removes the rules already on it. */
async function applyConditionalFormat(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
  if (op.op === 'delete_conditional_formats') {
    const pattern = new RegExp(
      `<conditionalFormatting\\b[^>]*\\bsqref="${tagPattern(reference)}"[^>]*>[\\s\\S]*?<\\/conditionalFormatting>`,
      'g'
    );
    const next = xml.replace(pattern, '');
    zip.file(sheet.path, next);
    return { op: op.op, changed: next !== xml, sheet: sheet.name, range: reference };
  }
  const priority =
    [...xml.matchAll(/<cfRule\b[^>]*\bpriority="(\d+)"/g)].reduce((max, match) => Math.max(max, Number(match[1])), 0) +
    1;
  // A rule that paints the cells it picks needs a differential format; a
  // scale or a bar paints every cell in the range by its own value, so it
  // carries its colors inside the rule and takes no formula.
  const kind = conditionalFormatKind(op);
  if (kind !== 'expression') {
    zip.file(
      sheet.path,
      appendWorksheetSection(
        xml,
        'conditionalFormatting',
        `<conditionalFormatting sqref="${reference}">` +
          conditionalScaleRule(kind, op, priority) +
          '</conditionalFormatting>'
      )
    );
    return { op: op.op, changed: true, sheet: sheet.name, range: reference, priority, type: kind };
  }
  const stylesPath = 'xl/styles.xml';
  const styles = await zipText(zip, stylesPath);
  if (!styles) throw new Error('Workbook is missing xl/styles.xml');
  const differential = appendDifferentialFormat(styles, {
    color: op.color,
    fillColor: op.fillColor,
  });
  zip.file(stylesPath, differential.xml);
  zip.file(
    sheet.path,
    appendWorksheetSection(
      xml,
      'conditionalFormatting',
      `<conditionalFormatting sqref="${reference}">` +
        `<cfRule type="expression" dxfId="${differential.id}" priority="${priority}">` +
        `<formula>${xmlEncode(String(op.formula).replace(/^=/, ''))}</formula></cfRule></conditionalFormatting>`
    )
  );
  return { op: op.op, changed: true, sheet: sheet.name, range: reference, priority, type: kind };
}

/** One data validation over a range, appended to the validations already there. */
function addWorksheetValidation(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
  // A list is the common case and what Excel writes through the same
  // operation, so it is the default; the other kinds guard a number, a
  // date, or a length, and take a second bound. A formula that states a
  // rule rather than naming choices is that rule, not a dropdown of one
  // entry: "서울,부산" and $A$1:$A$9 are lists, B2>0 is a custom check.
  const kind = String(op.type || (listValidationFormula(op.formula1) ? 'list' : 'custom'))
    .trim()
    .toLowerCase();
  const type = XLSX_VALIDATION_TYPES[kind];
  if (!type) {
    throw new Error(`add_validation type must be one of ${Object.keys(XLSX_VALIDATION_TYPES).join(', ')}`);
  }
  const requested = String(op.operator || '').trim();
  const operator = requested
    ? XLSX_VALIDATION_OPERATORS[requested.toLowerCase()]
    : op.formula2 != null && !['list', 'custom'].includes(type)
      ? 'between'
      : '';
  if (requested && !operator) {
    throw new Error(`add_validation operator must be one of ${Object.keys(XLSX_VALIDATION_OPERATORS).join(', ')}`);
  }
  const formula = (value) => `${xmlEncode(String(value).replace(/^=/, ''))}`;
  const existing = worksheetSection(xml, 'dataValidations');
  const previous = existing ? containerBody(existing[0], 'dataValidations') : '';
  const count = (previous.match(/<dataValidation\b/g) || []).length + 1;
  const validation =
    `<dataValidation type="${type}"${operator ? ` operator="${operator}"` : ''}` +
    ' allowBlank="1" showInputMessage="1" showErrorMessage="1"' +
    `${op.inputMessage ? ` prompt="${xmlEncode(op.inputMessage)}"` : ''}` +
    `${op.errorMessage ? ` error="${xmlEncode(op.errorMessage)}"` : ''}` +
    ` sqref="${reference}">` +
    `<formula1>${type === 'list' ? xmlEncode(listValidationChoices(op.formula1)) : formula(op.formula1)}</formula1>` +
    `${op.formula2 == null || op.formula2 === '' ? '' : `<formula2>${formula(op.formula2)}</formula2>`}` +
    '</dataValidation>';
  zip.file(
    sheet.path,
    upsertWorksheetSection(
      xml,
      'dataValidations',
      `<dataValidations count="${count}">${previous}${validation}</dataValidations>`
    )
  );
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    range: reference,
    type,
    ...(operator ? { operator } : {}),
  };
}

/** Sorts the values of a range, refusing the cases Excel itself refuses. */
async function sortWorksheetRange(zip, sheet, xml, op) {
  const area = expandRange(op.range);
  const records = new Map(cellRecords(xml, await sharedStrings(zip)).map((cell) => [cell.ref, cell]));
  const header = op.hasHeader !== false;
  const firstRow = area.startRow + (header ? 1 : 0);
  const refAt = (row, col) => `${columnLabel(col)}${row}`;
  // A sort moves whole rows. A formula inside them would keep pointing at
  // the row number it was written for, so the sorted sheet would compute
  // someone else's numbers: sort the values, then write the formulas.
  const formulas = [];
  for (let row = firstRow; row <= area.endRow; row += 1) {
    for (let col = area.startCol; col <= area.endCol; col += 1) {
      if (records.get(refAt(row, col))?.formula) formulas.push(refAt(row, col));
    }
  }
  if (formulas.length) {
    const named = formulas.slice(0, 3).join(', ') + (formulas.length > 3 ? ` and ${formulas.length - 3} more` : '');
    const holds =
      formulas.length === 1 ? 'holds a formula whose references would' : 'hold formulas whose references would';
    throw new Error(
      `XLSX sort_range moves rows, and ${named} ${holds} follow the move. Sort a range of values, then write the formulas over the sorted rows.`
    );
  }
  // A filtered sheet hides rows, not records: the flag stays on the row
  // number while the values move under it, so a sort would leave a
  // different record hidden than the one the reader filtered away.
  const withheld = [...hiddenSheetAreas(xml).rows].filter((row) => row >= firstRow && row <= area.endRow);
  if (withheld.length) {
    throw new Error(
      `XLSX sort_range would move values under hidden row${withheld.length > 1 ? 's' : ''} ${withheld.slice(0, 5).join(', ')}, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.`
    );
  }
  // Excel refuses the same case: a merged cell cannot travel with one row.
  const merges = mergedRanges(xml).filter((range) => {
    const merge = expandRange(range);
    return (
      merge.endRow >= firstRow &&
      merge.startRow <= area.endRow &&
      merge.endCol >= area.startCol &&
      merge.startCol <= area.endCol
    );
  });
  if (merges.length) {
    throw new Error(
      `XLSX sort_range cannot move rows through the merged cell${merges.length > 1 ? 's' : ''} ${merges.slice(0, 5).join(', ')}; Excel refuses the same sort. Unmerge them first with unmerge_cells.`
    );
  }
  const column = sortKeyColumn(op, area, (col) => records.get(refAt(area.startRow, col))?.value);
  const descending = String(op.order || 'asc')
    .trim()
    .toLowerCase()
    .startsWith('desc');
  const styles = cellStyleIndexes(
    xml,
    Array.from({ length: area.endRow - firstRow + 1 }, (unused, offset) => firstRow + offset).flatMap((row) =>
      Array.from({ length: area.endCol - area.startCol + 1 }, (empty, index) => refAt(row, area.startCol + index))
    )
  );
  const body = [];
  for (let row = firstRow; row <= area.endRow; row += 1) {
    body.push(
      Array.from({ length: area.endCol - area.startCol + 1 }, (unused, index) => {
        const ref = refAt(row, area.startCol + index);
        return { value: records.get(ref)?.value ?? null, style: styles.get(ref) || 0 };
      })
    );
  }
  const keyIndex = column - area.startCol;
  const sorted = [...body].sort(
    (left, right) => compareSortValues(left[keyIndex]?.value, right[keyIndex]?.value) * (descending ? -1 : 1)
  );
  xml = setCellsInSheet(
    xml,
    sorted.flatMap((cells, offset) =>
      cells.map((cell, index) => ({
        ref: refAt(firstRow + offset, area.startCol + index),
        value: cell.value,
      }))
    )
  );
  xml = setCellStylesInSheet(
    xml,
    sorted.flatMap((cells, offset) =>
      cells.map((cell, index) => ({
        ref: refAt(firstRow + offset, area.startCol + index),
        style: cell.style,
      }))
    )
  );
  zip.file(sheet.path, xml);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    range: op.range,
    by: columnLabel(column),
    order: descending ? 'desc' : 'asc',
    rows: sorted.length,
  };
}

/** Widths measured from what each cell prints, with the floor a composed sheet asks for. */
async function autofitWorksheetRange(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  // A row fit names rows (1:12) and asks for their height. Measuring columns
  // there rewrote every column width from its text, which silently undid the
  // widths a composed layout had just asked for.
  if (op.rows === true && !area.startCol) {
    return { op: op.op, changed: true, sheet: sheet.name, rows: true, columns: 0 };
  }
  // Widths follow what the cell prints: a number carries its format's
  // separators, decimals, and units, not the digits it stores.
  const cellStyles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const records = cellRecords(xml, await sharedStrings(zip), { styles: cellStyles });
  const spans = mergedRanges(xml).map((entry) => parseAreaRange(entry));
  const measured = new Map();
  for (const record of records) {
    const parsed = parseCellRef(record.ref);
    const column = columnNumber(parsed.col);
    if (area.startCol && (column < area.startCol || column > area.endCol)) continue;
    if (area.startRow && (parsed.row < area.startRow || parsed.row > area.endRow)) continue;
    if (
      spans.some(
        (span) =>
          span.startCol !== span.endCol &&
          span.startCol <= column &&
          column <= span.endCol &&
          span.startRow <= parsed.row &&
          parsed.row <= span.endRow
      )
    )
      continue;
    const value = record.formula ? record.cachedValue : record.value;
    const text = String(value ?? '');
    const numeric = record.dataType !== 'text' && text.trim() !== '' && Number.isFinite(Number(text));
    const needed = numeric ? formattedNumberWidth(Number(text), record.style?.numberFormat || '') : displayWidth(text);
    measured.set(column, Math.max(measured.get(column) || 0, needed));
  }
  // Fit-to-page never enlarges a sheet, so a layout whose columns hold only
  // their text prints as a small block in the corner of the page. minWidth is
  // the floor a composed sheet asks for: the columns still grow to their
  // content, and every column in the range - including the empty ones a
  // merged band spans - reaches that floor so the block keeps its width.
  const floor = Number(op.minWidth) > 0 ? Math.min(80, Number(op.minWidth)) : 8;
  if (Number(op.minWidth) > 0 && area.startCol && area.endCol - area.startCol < 64) {
    for (let column = area.startCol; column <= area.endCol; column += 1) {
      if (!measured.has(column)) measured.set(column, 0);
    }
  }
  const widths = new Map(
    [...measured.entries()].map(([column, width]) => [
      column,
      Math.min(80, Math.max(floor, Math.round((width + 2) * 10) / 10)),
    ])
  );
  zip.file(sheet.path, writeColumnWidths(xml, widths));
  return { op: op.op, changed: true, sheet: sheet.name, columns: widths.size };
}

/** One row field and one column field over a bounded source range. */
async function addWorksheetPivotTable(zip, sheet, xml, op) {
  const area = parseAreaRange(op.source);
  if (!area.startRow || !area.startCol || area.endRow <= area.startRow) {
    throw new Error('add_pivot_table requires a bounded source range whose first row holds field names');
  }
  const asList = (value) =>
    (Array.isArray(value) ? value : value == null ? [] : [value])
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
  const rowNames = asList(op.rows);
  const columnNames = asList(op.columns);
  const valueNames = asList(op.values);
  if (!valueNames.length) throw new Error('add_pivot_table requires at least one value field');
  if (rowNames.length > 1 || columnNames.length > 1) {
    throw new Error(
      'Portable add_pivot_table supports one row field and one column field; run the edit with Microsoft Excel for deeper nesting'
    );
  }
  if (valueNames.length > 1 && columnNames.length) {
    throw new Error('Portable add_pivot_table supports multiple value fields only without a column field');
  }
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  const cellValue = (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    return record.formula ? record.cachedValue : record.value;
  };
  const headers = [];
  for (let column = area.startCol; column <= area.endCol; column += 1) {
    headers.push(String(cellValue(column, area.startRow) ?? ''));
  }
  if (headers.some((entry) => !entry)) {
    throw new Error('add_pivot_table requires a field name in every column of the first source row');
  }
  const records = [];
  for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
    records.push(headers.map((_, index) => cellValue(area.startCol + index, row)));
  }
  if (!records.length) throw new Error('add_pivot_table source range has no data rows');
  const fieldIndex = (name) => {
    const index = headers.indexOf(name);
    if (index < 0) {
      throw new Error(`add_pivot_table field "${name}" is not in the source header row (${headers.join(', ')})`);
    }
    return index;
  };
  const destinationName = String(op.destinationSheet || sheet.name);
  const destination = (await workbookSheets(zip)).find((entry) => entry.name === destinationName);
  if (!destination) throw new Error(`add_pivot_table destination sheet "${destinationName}" was not found`);
  const pivotName = String(
    op.name ||
      `MixdogPivot${Object.keys(zip.files).filter((part) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(part)).length + 1}`
  );
  const written = await writePivotTable(zip, {
    fields: summarizePivotFields(headers, records),
    records,
    sourceSheet: sheet.name,
    sourceRef: `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`,
    destinationSheetPath: destination.path,
    destination: String(op.destination || 'A1'),
    name: pivotName,
    rowField: rowNames.length ? fieldIndex(rowNames[0]) : -1,
    columnField: columnNames.length ? fieldIndex(columnNames[0]) : -1,
    valueFields: valueNames.map(fieldIndex),
  });
  return {
    op: op.op,
    changed: true,
    sheet: destinationName,
    name: pivotName,
    rows: records.length,
    fields: headers.length,
    part: written.tablePart,
  };
}

/** A chart part, its drawing anchor, and the series read out of the sheet. */
async function addWorksheetChart(zip, sheet, xml, op) {
  // One bounded area, or several joined by commas the way Excel's own
  // Range("A7:A12,D7:D12") reads them: the first column of the first area
  // holds the categories, every other column of every area is a series,
  // so a chart can skip the columns between its category and its value.
  // plotBy:'rows' reads the same block turned a quarter: the first row holds
  // the categories and every other row is one series, which is how a sheet
  // that grows a column per period is already written.
  const plotByRows = String(op.plotBy ?? 'columns').toLowerCase() === 'rows';
  const areas = String(op.range ?? '')
    .split(',')
    .map((part) => parseAreaRange(part.trim()));
  const area = areas[0];
  const seriesColumns = areas.flatMap((entry, index) => {
    const from = index === 0 ? entry.startCol + 1 : entry.startCol;
    return Array.from({ length: Math.max(0, entry.endCol - from + 1) }, (_, offset) => from + offset);
  });
  const seriesRows = area
    ? Array.from({ length: Math.max(0, area.endRow - area.startRow) }, (_, offset) => area.startRow + 1 + offset)
    : [];
  const wholeBlock = plotByRows
    ? areas.length === 1 && area?.endCol > area?.startCol
    : areas.every(
        (entry) => entry.startRow && entry.startCol && entry.startRow === area.startRow && entry.endRow === area.endRow
      );
  if (!area?.startRow || !area.startCol || !(plotByRows ? seriesRows : seriesColumns).length || !wholeBlock) {
    throw new Error(
      plotByRows
        ? "add_chart plotBy:'rows' requires one bounded range whose first row holds the categories and whose first column names each series"
        : 'add_chart requires a bounded range whose first column holds categories (comma-joined areas must share the same rows)'
    );
  }
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  const cellValue = (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    return record.formula ? record.cachedValue : record.value;
  };
  const categories = [];
  if (plotByRows) {
    for (let column = area.startCol + 1; column <= area.endCol; column += 1) {
      categories.push(String(cellValue(column, area.startRow) ?? ''));
    }
  } else {
    for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
      categories.push(String(cellValue(area.startCol, row) ?? ''));
    }
  }
  const palette = Array.isArray(op.seriesColors) ? op.seriesColors : [];
  const sheetReference = quoteSheetName(sheet.name);
  const series = [];
  const names = [];
  const values = [];
  for (const [index, lane] of (plotByRows ? seriesRows : seriesColumns).entries()) {
    const label = columnLabel(plotByRows ? area.startCol : lane);
    const numbers = [];
    if (plotByRows) {
      for (let column = area.startCol + 1; column <= area.endCol; column += 1) {
        numbers.push(Number(cellValue(column, lane)));
      }
    } else {
      for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
        numbers.push(Number(cellValue(lane, row)));
      }
    }
    series.push({
      name: String(
        (plotByRows ? cellValue(area.startCol, lane) : cellValue(lane, area.startRow)) ?? `Series ${index + 1}`
      ),
      values: numbers,
      ...(palette.length ? { color: palette[index % palette.length] } : {}),
      ...(['pie', 'doughnut', 'donut'].includes(String(op.chartType).toLowerCase()) && palette.length
        ? { pointColors: categories.map((_, point) => palette[point % palette.length]) }
        : {}),
    });
    names.push(plotByRows ? `${sheetReference}!$${label}$${lane}` : `${sheetReference}!$${label}$${area.startRow}`);
    values.push(
      plotByRows
        ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${lane}:$${columnLabel(area.endCol)}$${lane}`
        : `${sheetReference}!$${label}$${area.startRow + 1}:$${label}$${area.endRow}`
    );
  }
  const categoryLabel = columnLabel(area.startCol);
  let chartOrdinal = 1;
  while (zip.file(`xl/charts/chart${chartOrdinal}.xml`)) chartOrdinal += 1;
  const chartPart = `xl/charts/chart${chartOrdinal}.xml`;
  zip.file(
    chartPart,
    chartXml({
      chartType: op.chartType,
      title: op.title,
      categories,
      series,
      references: {
        sheet: sheetReference,
        category: plotByRows
          ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${area.startRow}:$${columnLabel(area.endCol)}$${area.startRow}`
          : `${sheetReference}!$${categoryLabel}$${area.startRow + 1}:$${categoryLabel}$${area.endRow}`,
        names,
        values,
      },
      showValues: op.showValues === true,
      dataLabelPosition: op.dataLabelPosition,
      dataLabelColor: op.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat,
      showLegend: op.showLegend,
      zeroBaseline: op.zeroBaseline,
    })
  );
  await ensureContentTypeOverride(zip, `/${chartPart}`, CHART_CONTENT_TYPE);
  const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
  const drawingPart = drawing.part;
  const chartFit = fitDrawingSheetOnePageWide(drawing.worksheet);
  xml = chartFit.xml;
  zip.file(sheet.path, xml);
  const chartRelationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(drawingPart),
    `${OFFICE_RELATIONSHIP_BASE}/chart`,
    posix.relative(posix.dirname(drawingPart), chartPart)
  );
  const drawingXml = await zipText(zip, drawingPart);
  const anchorCount = (drawingXml.match(/<xdr:(absolute|two|one)CellAnchor\b/g) || []).length;
  const framePlacement = op.cell ? cellAnchorPoints(xml, op.cell) : { left: 300, top: 20 };
  const anchor =
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${toEmu(op.left ?? framePlacement.left)}" y="${toEmu(op.top ?? framePlacement.top)}"/>` +
    `<xdr:ext cx="${Math.max(1, toEmu(op.width ?? 480))}" cy="${Math.max(1, toEmu(op.height ?? 280))}"/>` +
    '<xdr:graphicFrame macro="">' +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="${anchorCount + 2}" name="Chart ${anchorCount + 1}"/>` +
    '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
    ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${chartRelationshipId}"/>` +
    '</a:graphicData></a:graphic></xdr:graphicFrame>' +
    '<xdr:clientData/></xdr:absoluteAnchor>';
  zip.file(drawingPart, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    chart: chartPart,
    series: series.length,
    ...(chartFit.applied ? { pageFit: 'one-page-wide' } : {}),
  };
}

export async function applyXlsx(zip, operations) {
  let sheets = await workbookSheets(zip);
  const results = [];
  let recalculationRequired = false;
  for (const op of operations) {
    if (op.op === 'add_sheet') {
      const created = await addWorksheet(zip, op.name);
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, sheet: created.name });
      continue;
    }
    const selected = op.sheet
      ? sheets.find((entry) => entry.name.toLowerCase() === String(op.sheet).toLowerCase())
      : sheets[0];
    if (!selected) throw new Error(`Worksheet not found: ${op.sheet || '(first sheet)'}`);
    if (op.op === 'rename_sheet') {
      const renamed = await renameWorksheet(zip, selected, op.name);
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, ...renamed });
      continue;
    }
    if (op.op === 'delete_sheet') {
      const removed = await deleteWorksheet(zip, sheets, selected);
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, ...removed });
      continue;
    }
    const sheet = selected;
    let xml = await zipText(zip, sheet.path);
    if (op.op === 'set_cell' || op.op === 'set_formula') {
      const formula =
        op.op === 'set_formula'
          ? normalizeXlsxFormula(op.formula, { backend: 'mixdog-ooxml', sheetNames: sheets.map((entry) => entry.name) })
          : '';
      const anchored = mergedCellAnchor(xml, op.cell);
      xml = setCellInSheet(xml, op.cell, op.value, formula);
      zip.file(sheet.path, xml);
      if (formula) recalculationRequired = true;
      const normalized = formula && formula !== String(op.formula ?? '').replace(/^=/, '');
      results.push({
        op: op.op,
        changed: true,
        sheet: sheet.name,
        cell: parseCellRef(op.cell).ref,
        ...(normalized ? { normalizedFormula: `=${formula}` } : {}),
        ...(anchored
          ? {}
          : { warning: 'Cell is inside a merged range but is not its top-left anchor; Excel hides the value.' }),
      });
      continue;
    }
    if (op.op === 'set_range') {
      const area = expandRange(op.range);
      const values = Array.isArray(op.values) ? op.values : [];
      const entries = [];
      for (let row = area.startRow; row <= area.endRow; row += 1) {
        for (let col = area.startCol; col <= area.endCol; col += 1) {
          entries.push({
            ref: `${columnLabel(col)}${row}`,
            value: values[row - area.startRow]?.[col - area.startCol] ?? null,
          });
        }
      }
      xml = setCellsInSheet(xml, entries);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, range: op.range });
      continue;
    }
    if (op.op === 'sort_range') {
      results.push(await sortWorksheetRange(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'append_row') {
      const cells = cellRecords(xml, await sharedStrings(zip));
      const maxRow = cells.reduce((max, cell) => Math.max(max, parseCellRef(cell.ref).row), 0);
      const row = maxRow + 1;
      xml = setCellsInSheet(
        xml,
        (op.values || []).map((value, index) => ({
          ref: `${columnLabel(index + 1)}${row}`,
          value,
        }))
      );
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, row });
      continue;
    }
    if (op.op === 'clear_cell') {
      const parsed = parseCellRef(op.cell);
      const cellRegex = new RegExp(`<c\\b[^>]*\\br="${parsed.ref}"[^>]*(?:>[\\s\\S]*?</c>|/>)`, 'i');
      const changed = cellRegex.test(xml);
      if (changed) {
        xml = xml.replace(cellRegex, '');
        zip.file(sheet.path, xml);
      }
      results.push({ op: op.op, changed, sheet: sheet.name, cell: parsed.ref });
      continue;
    }
    if (op.op === 'replace_text') {
      let count = 0;
      for (const candidate of sheets) {
        const current = await zipText(zip, candidate.path);
        const replaced = replaceAcrossRuns(current, 't', String(op.find || ''), String(op.replace ?? ''));
        if (replaced.count) zip.file(candidate.path, replaced.xml);
        count += replaced.count;
      }
      const shared = await zipText(zip, 'xl/sharedStrings.xml');
      if (shared) {
        const replaced = replaceAcrossRuns(shared, 't', String(op.find || ''), String(op.replace ?? ''));
        if (replaced.count) zip.file('xl/sharedStrings.xml', replaced.xml);
        count += replaced.count;
      }
      results.push({ op: op.op, changed: count > 0, count });
      continue;
    }
    if (op.op === 'set_style') {
      const target = op.range || op.cell;
      if (!target) throw new Error('set_style requires cell or range');
      const area = parseAreaRange(target);
      if (!area.startRow || !area.startCol)
        throw new Error('set_style requires a bounded cell or range such as A1 or A1:D5');
      const covered = (area.endRow - area.startRow + 1) * (area.endCol - area.startCol + 1);
      if (covered > MAX_STYLED_CELLS) {
        throw new Error(`set_style covers ${covered} cells; narrow the range to at most ${MAX_STYLED_CELLS}`);
      }
      const stylesPath = 'xl/styles.xml';
      let styles = await zipText(zip, stylesPath);
      if (!styles) throw new Error('Workbook is missing xl/styles.xml');
      const refs = [];
      for (let row = area.startRow; row <= area.endRow; row += 1) {
        for (let column = area.startCol; column <= area.endCol; column += 1) {
          refs.push(`${columnLabel(column)}${row}`);
        }
      }
      const bases = cellStyleIndexes(xml, refs);
      const resolved = new Map();
      const styled = [];
      for (const ref of refs) {
        const base = bases.get(ref) ?? 0;
        if (!resolved.has(base)) {
          const applied = applyCellStyle(styles, base, op.properties || {});
          styles = applied.xml;
          resolved.set(base, applied.index);
        }
        styled.push({ ref, style: resolved.get(base) });
      }
      xml = setCellStylesInSheet(xml, styled);
      zip.file(stylesPath, styles);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: covered > 0, sheet: sheet.name, cells: covered });
      continue;
    }
    if (op.op === 'merge_cells' || op.op === 'unmerge_cells') {
      const area = parseAreaRange(op.range);
      if (!area.startRow || !area.startCol) throw new Error(`${op.op} requires a bounded range such as A1:D1`);
      const ref = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
      const current = mergedRanges(xml);
      const next = op.op === 'merge_cells' ? [...current, ref] : current.filter((entry) => entry !== ref);
      const changed = new Set(next).size !== new Set(current).size;
      xml = writeMergedRanges(xml, next);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed, sheet: sheet.name, range: ref });
      continue;
    }
    if (op.op === 'freeze_panes') {
      const pane = freezePaneXml(op.row, op.column);
      xml = updateSheetView(xml, (view) => {
        const { attrs, body } = sheetViewParts(view);
        const stripped = body.replace(/<pane\b[^>]*?(?:\/>|>[\s\S]*?<\/pane>)/, '');
        return composeSheetView(attrs, `${pane}${stripped}`);
      });
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, frozen: Boolean(pane) });
      continue;
    }
    if (op.op === 'set_sheet_view') {
      xml = updateSheetView(xml, (view) => {
        const { attrs, body } = sheetViewParts(view);
        let next = attrs;
        if (op.showGridlines != null) {
          next = setXmlAttribute(next, 'showGridLines', op.showGridlines === true ? '1' : '0');
        }
        if (op.zoom != null) {
          const zoom = Math.min(400, Math.max(10, Math.round(Number(op.zoom) || 100)));
          next = setXmlAttribute(next, 'zoomScale', zoom);
          next = setXmlAttribute(next, 'zoomScaleNormal', zoom);
        }
        return composeSheetView(next, body);
      });
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name });
      continue;
    }
    if (op.op === 'autofit_range') {
      results.push(await autofitWorksheetRange(zip, sheet, xml, op));
      continue;
    }
    if (['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns'].includes(op.op)) {
      if (/<f(?:\s[^>]*)?>/.test(xml)) {
        throw new Error(
          `Portable ${op.op} cannot rewrite formula references; remove formulas first or run the edit with Microsoft Excel`
        );
      }
      if (mergedRanges(xml).length) {
        throw new Error(
          `Portable ${op.op} cannot rewrite merged ranges; unmerge first or run the edit with Microsoft Excel`
        );
      }
      const amount = Math.max(1, Number(op.count) || 1);
      const rowOperation = op.op.endsWith('rows');
      const from = Math.max(1, Number(rowOperation ? op.row : op.column) || 1);
      const delta = op.op.startsWith('insert') ? amount : -amount;
      xml = rowOperation ? shiftWorksheetRows(xml, from, delta) : shiftWorksheetColumns(xml, from, delta);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, from, count: amount });
      continue;
    }
    if (op.op === 'set_autofilter') {
      const enabled = op.enabled !== false;
      if (enabled) {
        const area = parseAreaRange(op.range);
        const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
        xml = upsertWorksheetSection(xml, 'autoFilter', `<autoFilter ref="${reference}"/>`);
      } else {
        xml = upsertWorksheetSection(xml, 'autoFilter', '');
      }
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, enabled });
      continue;
    }
    if (op.op === 'set_sheet_visibility') {
      // Rows and columns are hidden with visible: true/false, so the same word
      // must work on a sheet rather than costing a round trip.
      const requested =
        op.visibility != null
          ? op.visibility
          : typeof op.visible === 'boolean'
            ? op.visible
              ? 'visible'
              : 'hidden'
            : '';
      const visibility = String(requested).toLowerCase();
      const state = { visible: 'visible', hidden: 'hidden', very_hidden: 'veryHidden' }[visibility];
      if (!state)
        throw new Error(
          'set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)'
        );
      const workbookPath = 'xl/workbook.xml';
      const workbook = await zipText(zip, workbookPath);
      const pattern = new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(sheet.name))}"[^>]*\\/>`, 'i');
      const match = pattern.exec(workbook);
      if (!match) throw new Error(`Worksheet not found: ${sheet.name}`);
      if (state !== 'visible') {
        const visible = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)].filter(
          (entry) => !/\bstate="(?:hidden|veryHidden)"/.test(entry[0])
        );
        if (visible.length <= 1) throw new Error('A workbook must keep at least one visible worksheet');
      }
      const attrs =
        state === 'visible'
          ? match[0].replace(/\s*\bstate="[^"]*"/, '')
          : match[0].replace(/\s*\bstate="[^"]*"/, '').replace(/\/>$/, ` state="${state}"/>`);
      zip.file(
        workbookPath,
        `${workbook.slice(0, match.index)}${attrs}${workbook.slice(match.index + match[0].length)}`
      );
      results.push({ op: op.op, changed: true, sheet: sheet.name, visibility });
      continue;
    }
    // What a printed sheet says on every page — the confidentiality mark, the
    // document number. Word and PowerPoint could carry one and a workbook could
    // not, so a printed pack lost its marking at the spreadsheet.
    if (op.op === 'set_header_footer') {
      results.push(await setWorksheetHeaderFooter(zip, sheet, xml, op));
      continue;
    }
    // Hiding a row or a column is how a sheet withholds a working note or a
    // filtered record without deleting it; the snapshot reports the same state
    // back as hiddenRows / hiddenColumns.
    if (op.op === 'set_row_visibility' || op.op === 'set_column_visibility') {
      if (typeof op.visible !== 'boolean') throw new Error(`${op.op} requires visible: true or false`);
      const rows = op.op === 'set_row_visibility';
      const start = rows
        ? Math.round(Number(op.row))
        : typeof op.column === 'string' && /^[A-Za-z]+$/.test(op.column.trim())
          ? columnNumber(op.column.trim().toUpperCase())
          : Math.round(Number(op.column));
      if (!Number.isFinite(start) || start < 1) {
        throw new Error(
          rows
            ? 'set_row_visibility requires row (1-based)'
            : 'set_column_visibility requires column (a letter such as D, or a 1-based number)'
        );
      }
      const count = Math.max(1, Math.round(Number(op.count) || 1));
      const targets = Array.from({ length: count }, (_, index) => start + index);
      if (rows) {
        for (const row of targets) {
          const existing = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*?(?:/>|>)`).exec(xml);
          if (existing) {
            const stripped = existing[0].replace(/\s*\bhidden="[^"]*"/, '');
            const next = op.visible ? stripped : stripped.replace(/(\/?>)$/, ' hidden="1"$1');
            xml = `${xml.slice(0, existing.index)}${next}${xml.slice(existing.index + existing[0].length)}`;
            continue;
          }
          if (op.visible) continue;
          // An empty row still hides, and Excel needs the element to record it.
          const later = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>)/g)].find(
            (entry) => Number(entry[1]) > row
          );
          const anchor = later ? later.index : xml.indexOf('</sheetData>');
          if (anchor < 0) throw new Error('Worksheet has no sheetData to hide a row in');
          xml = `${xml.slice(0, anchor)}<row r="${row}" hidden="1"/>${xml.slice(anchor)}`;
        }
      } else {
        xml = writeColumnVisibility(xml, targets, op.visible);
      }
      zip.file(sheet.path, xml);
      results.push({
        op: op.op,
        changed: true,
        sheet: sheet.name,
        visible: op.visible,
        ...(rows ? { rows: targets } : { columns: targets.map((column) => columnLabel(column)) }),
      });
      continue;
    }
    if (op.op === 'define_name' || op.op === 'delete_name') {
      const name = String(op.name || '').trim();
      if (!name) throw new Error(`${op.op} requires name`);
      const fault = op.op === 'define_name' ? workbookDefinedNameFault(name) : '';
      if (fault) throw new Error(`Excel refuses the defined name "${name}": ${fault}.`);
      const workbookPath = 'xl/workbook.xml';
      const workbook = await zipText(zip, workbookPath);
      const matches = (item) => xmlAttribute(item, 'name') === name;
      if (op.op === 'delete_name') {
        const next = upsertDefinedName(workbook, '', matches);
        zip.file(workbookPath, next);
        results.push({ op: op.op, changed: next !== workbook, name });
        continue;
      }
      const refersTo = String(op.refersTo || '').trim();
      if (!refersTo) throw new Error('define_name requires refersTo');
      zip.file(
        workbookPath,
        upsertDefinedName(
          workbook,
          `<definedName name="${xmlEncode(name)}">${xmlEncode(refersTo)}</definedName>`,
          matches
        )
      );
      results.push({ op: op.op, changed: true, name, refersTo });
      continue;
    }
    if (op.op === 'add_note' || op.op === 'add_provenance') {
      const text = op.op === 'add_provenance' ? provenanceCitation(op.source) : String(op.text || '');
      if (!text) throw new Error(`${op.op} requires ${op.op === 'add_provenance' ? 'source' : 'text'}`);
      const written = await writeWorksheetNote(zip, sheet, xml, {
        cell: op.cell,
        text,
        author: op.author || 'Mixdog',
        append: op.op === 'add_provenance',
      });
      xml = written.worksheet;
      zip.file(sheet.path, xml);
      results.push({
        op: op.op,
        changed: written.changed,
        sheet: sheet.name,
        cell: parseCellRef(op.cell).ref,
        ...(op.op === 'add_provenance' ? { citation: text } : {}),
      });
      continue;
    }
    if (op.op === 'delete_note') {
      const parsed = parseCellRef(op.cell);
      const relationships = await zipText(zip, partRelationshipPath(sheet.path));
      const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/.exec(relationships)?.[1];
      if (!target) {
        results.push({ op: op.op, changed: false, sheet: sheet.name, cell: parsed.ref });
        continue;
      }
      const commentsPart = posix.normalize(posix.join(posix.dirname(sheet.path), target));
      const comments = await zipText(zip, commentsPart);
      const pattern = new RegExp(`<comment\\b[^>]*\\bref="${parsed.ref}"[^>]*>[\\s\\S]*?<\\/comment>`);
      const changed = pattern.test(comments);
      if (changed) zip.file(commentsPart, comments.replace(pattern, ''));
      results.push({ op: op.op, changed, sheet: sheet.name, cell: parsed.ref });
      continue;
    }
    if (op.op === 'copy_sheet') {
      const label = assertWorksheetName('copy_sheet', String(op.name || `${sheet.name} copy`).slice(0, 31));
      if (sheets.some((entry) => entry.name.toLowerCase() === label.toLowerCase())) {
        throw new Error(`Worksheet already exists: ${label}`);
      }
      let copyOrdinal = 1;
      while (zip.file(`xl/worksheets/sheet${copyOrdinal}.xml`)) copyOrdinal += 1;
      const copyPart = `xl/worksheets/sheet${copyOrdinal}.xml`;
      zip.file(copyPart, xml);
      const sourceRelationships = await zipText(zip, partRelationshipPath(sheet.path));
      if (sourceRelationships) {
        zip.file(
          partRelationshipPath(copyPart),
          sourceRelationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/table"[^>]*\/>/g, '')
        );
      }
      await ensureContentTypeOverride(zip, `/${copyPart}`, WORKSHEET_CONTENT_TYPE);
      const relationshipId = await addPackageRelationship(
        zip,
        'xl/_rels/workbook.xml.rels',
        WORKSHEET_RELATIONSHIP,
        `worksheets/sheet${copyOrdinal}.xml`
      );
      const workbookPath = 'xl/workbook.xml';
      const workbook = await zipText(zip, workbookPath);
      const sheetIds = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
      const entry = `<sheet name="${xmlEncode(label)}" sheetId="${Math.max(0, ...sheetIds) + 1}" r:id="${relationshipId}"/>`;
      zip.file(workbookPath, workbook.replace('</sheets>', `${entry}</sheets>`));
      if (zip.file(copyPart)) {
        zip.file(
          copyPart,
          (await zipText(zip, copyPart)).replace(/<tableParts\b[^>]*?(?:\/>|>[\s\S]*?<\/tableParts>)/, '')
        );
      }
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, sheet: label });
      continue;
    }
    if (op.op === 'add_image') {
      results.push(await addWorksheetImage(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'set_hyperlink') {
      const parsed = parseCellRef(op.cell);
      const address = String(op.address || '').trim();
      if (!address && !op.subAddress) throw new Error('set_hyperlink requires address or subAddress');
      const relationshipId = address
        ? await addPackageRelationship(
            zip,
            partRelationshipPath(sheet.path),
            `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
            address,
            'External'
          )
        : '';
      if (op.text != null) xml = setCellInSheet(xml, parsed.ref, op.text);
      const existing = worksheetSection(xml, 'hyperlinks');
      const previous = existing
        ? containerBody(existing[0], 'hyperlinks').replace(
            new RegExp(`<hyperlink\\b[^>]*\\bref="${parsed.ref}"[^>]*\\/>`),
            ''
          )
        : '';
      const link =
        `<hyperlink ref="${parsed.ref}"${relationshipId ? ` r:id="${relationshipId}"` : ''}` +
        `${op.subAddress ? ` location="${xmlEncode(op.subAddress)}"` : ''}` +
        `${op.screenTip ? ` tooltip="${xmlEncode(op.screenTip)}"` : ''}/>`;
      xml = upsertWorksheetSection(xml, 'hyperlinks', `<hyperlinks>${previous}${link}</hyperlinks>`);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, cell: parsed.ref, address });
      continue;
    }
    if (op.op === 'protect_sheet' || op.op === 'unprotect_sheet') {
      if (op.op === 'unprotect_sheet') {
        xml = upsertWorksheetSection(xml, 'sheetProtection', '');
      } else {
        const allow = (key, attribute) => (op[key] === true ? ` ${attribute}="0"` : '');
        const password = op.password ? ` password="${excelPasswordHash(op.password)}"` : '';
        xml = upsertWorksheetSection(
          xml,
          'sheetProtection',
          `<sheetProtection${password} sheet="1" objects="1" scenarios="1"` +
            `${allow('allowFormattingCells', 'formatCells')}` +
            `${allow('allowSorting', 'sort')}` +
            `${allow('allowFiltering', 'autoFilter')}/>`
        );
      }
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name });
      continue;
    }
    if (op.op === 'add_conditional_format' || op.op === 'delete_conditional_formats') {
      results.push(await applyConditionalFormat(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'add_validation') {
      results.push(addWorksheetValidation(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'add_table') {
      const area = parseAreaRange(op.range);
      if (!area.startRow || !area.startCol) throw new Error('add_table requires a bounded range such as A1:C10');
      const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
      const names = [];
      for (let column = area.startCol; column <= area.endCol; column += 1) {
        const reference = `${columnLabel(column)}${area.startRow}`;
        const raw = String(grid.get(reference)?.value ?? '').trim();
        let name = raw || `Column${column - area.startCol + 1}`;
        while (names.includes(name)) name = `${name}_${names.length + 1}`;
        if (!raw) xml = setCellInSheet(xml, reference, name);
        names.push(name);
      }
      let tableOrdinal = 1;
      while (zip.file(`xl/tables/table${tableOrdinal}.xml`)) tableOrdinal += 1;
      const tablePart = `xl/tables/table${tableOrdinal}.xml`;
      const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
      const tableName = safeWorkbookTableName(op.name || `Table${tableOrdinal}`);
      zip.file(
        tablePart,
        `${XML_HEADER}<table xmlns="${SPREADSHEET_MAIN}" id="${tableOrdinal}"` +
          ` name="${xmlEncode(tableName)}" displayName="${xmlEncode(tableName)}" ref="${reference}" totalsRowShown="0">` +
          `<autoFilter ref="${reference}"/>` +
          `<tableColumns count="${names.length}">` +
          names.map((entry, index) => `<tableColumn id="${index + 1}" name="${xmlEncode(entry)}"/>`).join('') +
          '</tableColumns>' +
          tableStyleInfoXml(op.style) +
          '</table>'
      );
      await ensureContentTypeOverride(zip, `/${tablePart}`, TABLE_CONTENT_TYPE);
      const relationshipId = await addPackageRelationship(
        zip,
        partRelationshipPath(sheet.path),
        `${OFFICE_RELATIONSHIP_BASE}/table`,
        posix.relative(posix.dirname(sheet.path), tablePart)
      );
      const existing = worksheetSection(xml, 'tableParts');
      const previous = existing ? containerBody(existing[0], 'tableParts') : '';
      const count = (previous.match(/<tablePart\b/g) || []).length + 1;
      xml = upsertWorksheetSection(
        xml,
        'tableParts',
        `<tableParts count="${count}">${previous}<tablePart r:id="${relationshipId}"/></tableParts>`
      );
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, name: tableName, columns: names.length });
      continue;
    }
    if (op.op === 'add_pivot_table') {
      results.push(await addWorksheetPivotTable(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'add_chart') {
      results.push(await addWorksheetChart(zip, sheet, xml, op));
      continue;
    }
    if (op.op === 'set_page_setup') {
      results.push(await applyWorksheetPageSetup(zip, sheets, sheet, xml, op));
      continue;
    }
    throw new Error(`Portable XLSX backend does not support operation: ${op.op}`);
  }
  if (recalculationRequired) {
    const workbookPath = 'xl/workbook.xml';
    zip.file(workbookPath, forceWorkbookRecalculation(await zipText(zip, workbookPath)));
  }
  return results;
}
