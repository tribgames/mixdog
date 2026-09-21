// Worksheet-level operations the portable XLSX backend applies: sheet
// management, images, header/footer, conditional formats, validation, sort,
// autofit, pivot tables and charts.
import { extname, posix } from 'node:path';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import { conditionalFormatKind, listValidationChoices, listValidationFormula } from './xlsx-contract.mjs';
import { chartXml } from './portable-chart.mjs';
import { fitDrawingSheetOnePageWide, worksheetGeometry } from './portable-sheet-page.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import { summarizePivotFields, writePivotTable } from './portable-pivot.mjs';
import {
  cellRecords,
  cellStyleIndexes,
  columnLabel,
  columnNumber,
  expandRange,
  parseCellRef,
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
  zipText,
} from './portable-opc.mjs';
import {
  OFFICE_RELATIONSHIP_BASE,
  SPREADSHEET_MAIN,
  containerBody,
  tagPattern,
  xmlAttribute,
  xmlDecode,
  xmlEncode,
} from './portable-xml.mjs';
import { ensureWorksheetDrawing } from './portable-sheet-parts.mjs';
import {
  appendDifferentialFormat,
  appendWorksheetSection,
  conditionalScaleRule,
  displayWidth,
  formattedNumberWidth,
  hiddenSheetAreas,
  mergedRanges,
  parseAreaRange,
  quoteSheetName,
  upsertDefinedName,
  upsertWorksheetSection,
  worksheetSection,
  writeColumnWidths,
} from './portable-sheet-xml.mjs';

export const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

export const WORKSHEET_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

export const MAX_STYLED_CELLS = 20_000;

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

export const TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';

// A built-in table style bands the range from the workbook's own theme, which
// is not the palette a composed sheet paints with. style:'none' keeps the
// table — its name, its filters, its structured references — and leaves the
// colours to whoever set them.
export function tableStyleInfoXml(style) {
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

export function assertWorksheetName(operation, name) {
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

export async function addWorksheet(zip, name) {
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

export async function renameWorksheet(zip, sheet, name) {
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

export async function deleteWorksheet(zip, sheets, sheet) {
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

// Stores the image bytes as the next xl/media part of its type.
async function storeImageMedia(zip, op) {
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
  return { mediaPart, data };
}

// The requested size, or the picture's own size in points.
function imagePlacementSize(op, data) {
  const pixels = imagePixelSize(data);
  const naturalWidth = pixels ? pixels.width * PIXELS_TO_POINTS : 240;
  const naturalHeight = pixels ? pixels.height * PIXELS_TO_POINTS : 180;
  return {
    width: Number(op.width) > 0 ? Number(op.width) : naturalWidth,
    height: Number(op.height) > 0 ? Number(op.height) : naturalHeight,
  };
}

function imageAnchorXml({ embedId, anchorCount, left, top, width, height, altText }) {
  return (
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<xdr:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${anchorCount + 2}" name="Picture ${anchorCount + 1}"${pictureDescription(altText)}/>` +
    '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    `<xdr:blipFill><a:blip r:embed="${embedId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
    '<xdr:clientData/></xdr:absoluteAnchor>'
  );
}

/** Places a picture on the sheet's drawing, sized from the file when no size is given. */
export async function addWorksheetImage(zip, sheet, xml, op) {
  const { mediaPart, data } = await storeImageMedia(zip, op);
  const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
  const imageFit = fitDrawingSheetOnePageWide(drawing.worksheet);
  xml = imageFit.xml;
  const embedId = await addPackageRelationship(
    zip,
    partRelationshipPath(drawing.part),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    posix.relative(posix.dirname(drawing.part), mediaPart)
  );
  const drawingXml = await zipText(zip, drawing.part);
  const anchorCount = (drawingXml.match(/<xdr:(absolute|two|one)CellAnchor\b/g) || []).length;
  const placement = op.cell ? cellAnchorPoints(xml, op.cell) : { left: 0, top: 0 };
  const anchor = imageAnchorXml({
    embedId,
    anchorCount,
    left: op.left ?? placement.left,
    top: op.top ?? placement.top,
    ...imagePlacementSize(op, data),
    altText: op.altText,
  });
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

// Splits one story's string into its L/C/R slots. && is the caller's own
// ampersand; &L/&C/&R open a slot and every other code (&P, &N, &D) belongs
// to the slot being read.
function headerFooterSlots(current) {
  const slots = { L: '', C: '', R: '' };
  let reading = 'C';
  let buffer = '';
  for (let index = 0; index < current.length; index += 1) {
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
  return slots;
}

const headerFooterStoryText = (slots) =>
  xmlEncode(
    ['L', 'C', 'R']
      .filter((key) => slots[key] !== '')
      .map((key) => `&${key}${slots[key]}`)
      .join('')
  );

/** Writes one slot of a sheet's header or footer, keeping the other slots and the other story. */
export async function setWorksheetHeaderFooter(zip, sheet, xml, op) {
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
  const slots = headerFooterSlots(current);
  slots[slot] = headerFooterFields(op.text);
  const written = `<${story}>${headerFooterStoryText(slots)}</${story}>`;
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
export async function applyConditionalFormat(zip, sheet, xml, op) {
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
  const rule =
    kind === 'expression'
      ? await expressionConditionalRule(zip, op, priority)
      : conditionalScaleRule(kind, op, priority);
  zip.file(
    sheet.path,
    appendWorksheetSection(
      xml,
      'conditionalFormatting',
      `<conditionalFormatting sqref="${reference}">${rule}</conditionalFormatting>`
    )
  );
  return { op: op.op, changed: true, sheet: sheet.name, range: reference, priority, type: kind };
}

// An expression rule's differential format lives in the styles part; the rule
// references it by id.
async function expressionConditionalRule(zip, op, priority) {
  const stylesPath = 'xl/styles.xml';
  const styles = await zipText(zip, stylesPath);
  if (!styles) throw new Error('Workbook is missing xl/styles.xml');
  const differential = appendDifferentialFormat(styles, {
    color: op.color,
    fillColor: op.fillColor,
  });
  zip.file(stylesPath, differential.xml);
  return (
    `<cfRule type="expression" dxfId="${differential.id}" priority="${priority}">` +
    `<formula>${xmlEncode(String(op.formula).replace(/^=/, ''))}</formula></cfRule>`
  );
}

// The comparison a bounded validation applies; a second bound without one
// means between.
function validationOperator(op, type) {
  const requested = String(op.operator || '').trim();
  let operator = '';
  if (requested) operator = XLSX_VALIDATION_OPERATORS[requested.toLowerCase()];
  else if (op.formula2 != null && !['list', 'custom'].includes(type)) operator = 'between';
  if (requested && !operator) {
    throw new Error(`add_validation operator must be one of ${Object.keys(XLSX_VALIDATION_OPERATORS).join(', ')}`);
  }
  return operator;
}

function dataValidationXml(op, { type, operator, reference }) {
  const formula = (value) => `${xmlEncode(String(value).replace(/^=/, ''))}`;
  return (
    `<dataValidation type="${type}"${operator ? ` operator="${operator}"` : ''}` +
    ' allowBlank="1" showInputMessage="1" showErrorMessage="1"' +
    `${op.inputMessage ? ` prompt="${xmlEncode(op.inputMessage)}"` : ''}` +
    `${op.errorMessage ? ` error="${xmlEncode(op.errorMessage)}"` : ''}` +
    ` sqref="${reference}">` +
    `<formula1>${type === 'list' ? xmlEncode(listValidationChoices(op.formula1)) : formula(op.formula1)}</formula1>` +
    `${op.formula2 == null || op.formula2 === '' ? '' : `<formula2>${formula(op.formula2)}</formula2>`}` +
    '</dataValidation>'
  );
}

/** One data validation over a range, appended to the validations already there. */
export function addWorksheetValidation(zip, sheet, xml, op) {
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
  const operator = validationOperator(op, type);
  const existing = worksheetSection(xml, 'dataValidations');
  const previous = existing ? containerBody(existing[0], 'dataValidations') : '';
  const count = (previous.match(/<dataValidation\b/g) || []).length + 1;
  const validation = dataValidationXml(op, { type, operator, reference });
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

// The sorts Excel itself refuses, and the ones that would silently corrupt
// the sheet: formulas inside the moved rows, hidden rows among them, and
// merged cells crossing them.
function refuseUnsortableRange(xml, area, firstRow, records, refAt) {
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
}

// The cell refs of the sortable body, row by row.
function rangeRows(area, firstRow, refAt) {
  return Array.from({ length: area.endRow - firstRow + 1 }, (_unused, offset) => firstRow + offset).map((row) =>
    Array.from({ length: area.endCol - area.startCol + 1 }, (_empty, index) => refAt(row, area.startCol + index))
  );
}

function writeSortedRows(xml, sorted, area, firstRow, refAt) {
  const placed = sorted.flatMap((cells, offset) =>
    cells.map((cell, index) => ({ ref: refAt(firstRow + offset, area.startCol + index), ...cell }))
  );
  const withValues = setCellsInSheet(
    xml,
    placed.map(({ ref, value }) => ({ ref, value }))
  );
  return setCellStylesInSheet(
    withValues,
    placed.map(({ ref, style }) => ({ ref, style }))
  );
}

/** Sorts the values of a range, refusing the cases Excel itself refuses. */
export async function sortWorksheetRange(zip, sheet, xml, op) {
  const area = expandRange(op.range);
  const records = new Map(cellRecords(xml, await sharedStrings(zip)).map((cell) => [cell.ref, cell]));
  const header = op.hasHeader !== false;
  const firstRow = area.startRow + (header ? 1 : 0);
  const refAt = (row, col) => `${columnLabel(col)}${row}`;
  refuseUnsortableRange(xml, area, firstRow, records, refAt);
  const column = sortKeyColumn(op, area, (col) => records.get(refAt(area.startRow, col))?.value);
  const descending = String(op.order || 'asc')
    .trim()
    .toLowerCase()
    .startsWith('desc');
  const rows = rangeRows(area, firstRow, refAt);
  const styles = cellStyleIndexes(xml, rows.flat());
  const body = rows.map((refs) =>
    refs.map((ref) => ({ value: records.get(ref)?.value ?? null, style: styles.get(ref) || 0 }))
  );
  const keyIndex = column - area.startCol;
  const sorted = [...body].sort(
    (left, right) => compareSortValues(left[keyIndex]?.value, right[keyIndex]?.value) * (descending ? -1 : 1)
  );
  zip.file(sheet.path, writeSortedRows(xml, sorted, area, firstRow, refAt));
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

// The widest printed text of each column in the area, skipping the cells a
// horizontal merge spans.
function measuredColumnWidths(records, area, spans) {
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
  return measured;
}

/** Widths measured from what each cell prints, with the floor a composed sheet asks for. */
export async function autofitWorksheetRange(zip, sheet, xml, op) {
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
  const measured = measuredColumnWidths(records, area, spans);
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

// The row, column and value field names an add_pivot_table op names, within
// what the portable writer can lay out.
function pivotFieldNames(op) {
  const asList = (value) => {
    let list = [value];
    if (Array.isArray(value)) list = value;
    else if (value == null) list = [];
    return list.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  };
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
  return { rowNames, columnNames, valueNames };
}

// The source range as its header row plus data rows of cached values.
async function pivotSourceTable(zip, xml, area) {
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
  return { headers, records };
}

/** One row field and one column field over a bounded source range. */
export async function addWorksheetPivotTable(zip, sheet, xml, op) {
  const area = parseAreaRange(op.source);
  if (!area.startRow || !area.startCol || area.endRow <= area.startRow) {
    throw new Error('add_pivot_table requires a bounded source range whose first row holds field names');
  }
  const { rowNames, columnNames, valueNames } = pivotFieldNames(op);
  const { headers, records } = await pivotSourceTable(zip, xml, area);
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

// The block a chart reads. One bounded area, or several joined by commas the
// way Excel's own Range("A7:A12,D7:D12") reads them: the first column of the
// first area holds the categories, every other column of every area is a
// series, so a chart can skip the columns between its category and its value.
// plotBy:'rows' reads the same block turned a quarter: the first row holds
// the categories and every other row is one series, which is how a sheet
// that grows a column per period is already written.
function chartDataBlock(op) {
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
  const lanes = plotByRows ? seriesRows : seriesColumns;
  if (!area?.startRow || !area.startCol || !lanes.length || !wholeBlock) {
    throw new Error(
      plotByRows
        ? "add_chart plotBy:'rows' requires one bounded range whose first row holds the categories and whose first column names each series"
        : 'add_chart requires a bounded range whose first column holds categories (comma-joined areas must share the same rows)'
    );
  }
  return { plotByRows, area, lanes };
}

// The category labels along the header row (plotted by rows) or the first column.
function chartCategories(cellValue, area, plotByRows) {
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
  return categories;
}

// One series' numbers: the lane's row (plotted by rows) or its column.
function laneValues(cellValue, area, plotByRows, lane) {
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
  return numbers;
}

// Categories, series values and the sheet references the chart part cites.
async function readChartData(zip, xml, sheet, op, { plotByRows, area, lanes }) {
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  const cellValue = (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    return record.formula ? record.cachedValue : record.value;
  };
  const categories = chartCategories(cellValue, area, plotByRows);
  const palette = Array.isArray(op.seriesColors) ? op.seriesColors : [];
  const pointColors = ['pie', 'doughnut', 'donut'].includes(String(op.chartType).toLowerCase()) && palette.length;
  const sheetReference = quoteSheetName(sheet.name);
  const series = [];
  const names = [];
  const values = [];
  for (const [index, lane] of lanes.entries()) {
    const label = columnLabel(plotByRows ? area.startCol : lane);
    const numbers = laneValues(cellValue, area, plotByRows, lane);
    series.push({
      name: String(
        (plotByRows ? cellValue(area.startCol, lane) : cellValue(lane, area.startRow)) ?? `Series ${index + 1}`
      ),
      values: numbers,
      ...(palette.length ? { color: palette[index % palette.length] } : {}),
      ...(pointColors ? { pointColors: categories.map((_, point) => palette[point % palette.length]) } : {}),
    });
    names.push(plotByRows ? `${sheetReference}!$${label}$${lane}` : `${sheetReference}!$${label}$${area.startRow}`);
    values.push(
      plotByRows
        ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${lane}:$${columnLabel(area.endCol)}$${lane}`
        : `${sheetReference}!$${label}$${area.startRow + 1}:$${label}$${area.endRow}`
    );
  }
  const categoryLabel = columnLabel(area.startCol);
  const category = plotByRows
    ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${area.startRow}:$${columnLabel(area.endCol)}$${area.startRow}`
    : `${sheetReference}!$${categoryLabel}$${area.startRow + 1}:$${categoryLabel}$${area.endRow}`;
  return { categories, series, references: { sheet: sheetReference, category, names, values } };
}

function nextChartPart(zip) {
  let chartOrdinal = 1;
  while (zip.file(`xl/charts/chart${chartOrdinal}.xml`)) chartOrdinal += 1;
  return `xl/charts/chart${chartOrdinal}.xml`;
}

function chartFrameAnchor(op, framePlacement, anchorCount, chartRelationshipId) {
  return (
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
    '<xdr:clientData/></xdr:absoluteAnchor>'
  );
}

/** A chart part, its drawing anchor, and the series read out of the sheet. */
export async function addWorksheetChart(zip, sheet, xml, op) {
  const block = chartDataBlock(op);
  const { categories, series, references } = await readChartData(zip, xml, sheet, op, block);
  const chartPart = nextChartPart(zip);
  zip.file(
    chartPart,
    chartXml({
      chartType: op.chartType,
      title: op.title,
      categories,
      series,
      references,
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
  const anchor = chartFrameAnchor(op, framePlacement, anchorCount, chartRelationshipId);
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
