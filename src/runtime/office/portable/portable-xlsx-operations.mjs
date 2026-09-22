// Worksheet-level operations the portable XLSX backend applies: sheet
// management, images, header/footer, conditional formats, validation, sort,
// autofit, pivot tables and charts.
import { posix } from 'node:path';
import { conditionalFormatKind, listValidationChoices, listValidationFormula } from './xlsx-contract.mjs';
import { nextRelationshipId, zipText } from './portable-opc.mjs';
import {
  OFFICE_RELATIONSHIP_BASE,
  SPREADSHEET_MAIN,
  containerBody,
  tagPattern,
  xmlAttribute,
  xmlDecode,
  xmlEncode,
} from './portable-xml.mjs';
import {
  appendDifferentialFormat,
  appendWorksheetSection,
  areaReference,
  conditionalScaleRule,
  parseAreaRange,
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
  // A workbook-level name carries no localSheetId at all, and an absent
  // attribute reads back as an empty string: taking that as 0 deleted every
  // global name along with the first sheet.
  const localSheetId = (item) => {
    const raw = xmlAttribute(item, 'localSheetId');
    return /^\d+$/.test(raw) ? Number(raw) : null;
  };
  workbook = upsertDefinedName(workbook, '', (item) => localSheetId(item) === index);
  workbook = workbook.replace(/<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)/g, (item) => {
    const local = localSheetId(item);
    return local !== null && local > index ? item.replace(/\blocalSheetId="\d+"/, `localSheetId="${local - 1}"`) : item;
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
  const reference = areaReference(parseAreaRange(op.range));
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
  const reference = areaReference(parseAreaRange(op.range));
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

// Sorting a range's rows and measuring its column widths live in
// portable-xlsx-range-layout.mjs, same facade contract.
export { sortWorksheetRange, autofitWorksheetRange } from './portable-xlsx-range-layout.mjs';

// Worksheet drawings (picture placement, frame moves, frame deletion) live in
// portable-xlsx-drawings.mjs; re-exported so prior importers of this module
// stay unchanged.
export { addWorksheetImage, setWorksheetDrawing, deleteWorksheetDrawing } from './portable-xlsx-drawings.mjs';
// Chart parts and the series they read out of the sheet live in
// portable-xlsx-charts.mjs, same facade contract.
export { addWorksheetChart } from './portable-xlsx-charts.mjs';
// The pivot-table operation (field rules + source read) lives in
// portable-xlsx-pivot-ops.mjs, same facade contract.
export { addWorksheetPivotTable } from './portable-xlsx-pivot-ops.mjs';
