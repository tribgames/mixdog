import { posix } from 'node:path';
import {
  addPackageRelationship,
  ensureContentTypeOverride,
  partRelationshipPath,
  zipText,
} from './portable-opc.mjs';
import { columnLabel, columnNumber, parseCellRef } from './portable-cells.mjs';
import { SPREADSHEET_MAIN, XML_HEADER, xmlEncode } from './portable-xml.mjs';

const CACHE_DEFINITION_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';
const CACHE_RECORDS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml';
const PIVOT_TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';
const RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function summarizePivotFields(headers, records) {
  return headers.map((name, index) => {
    const column = records.map((record) => record[index]);
    const numeric = column.length > 0 && column.every((value) => (
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ));
    if (numeric) {
      const numbers = column.map(Number);
      return {
        name,
        numeric: true,
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        integer: numbers.every((value) => Number.isInteger(value)),
        items: [],
      };
    }
    const items = [];
    for (const value of column) {
      const text = String(value ?? '');
      if (!items.includes(text)) items.push(text);
    }
    return { name, numeric: false, items };
  });
}

function displayOrder(field) {
  return [...field.items.keys()]
    .sort((left, right) => field.items[left].localeCompare(field.items[right], 'en'));
}

function cacheDefinitionXml(fields, records, sourceSheet, sourceRef, recordsRelationshipId) {
  const cacheFields = fields.map((field) => {
    const shared = field.numeric
      ? `<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"`
        + `${field.integer ? ' containsInteger="1"' : ''} minValue="${field.min}" maxValue="${field.max}"/>`
      : `<sharedItems count="${field.items.length}">`
        + field.items.map((item) => `<s v="${xmlEncode(item)}"/>`).join('')
        + '</sharedItems>';
    return `<cacheField name="${xmlEncode(field.name)}" numFmtId="0">${shared}</cacheField>`;
  }).join('');
  return `${XML_HEADER}<pivotCacheDefinition xmlns="${SPREADSHEET_MAIN}"`
    + ` xmlns:r="${RELATIONSHIP_BASE}" r:id="${recordsRelationshipId}"`
    + ' createdVersion="8" refreshedVersion="8" minRefreshableVersion="3" refreshOnLoad="1"'
    + ` recordCount="${records.length}">`
    + `<cacheSource type="worksheet"><worksheetSource ref="${xmlEncode(sourceRef)}" sheet="${xmlEncode(sourceSheet)}"/></cacheSource>`
    + `<cacheFields count="${fields.length}">${cacheFields}</cacheFields>`
    + '</pivotCacheDefinition>';
}

function cacheRecordsXml(fields, records) {
  const rows = records.map((record) => `<r>${record.map((value, index) => {
    const field = fields[index];
    if (field.numeric) return `<n v="${Number(value)}"/>`;
    const position = field.items.indexOf(String(value ?? ''));
    return `<x v="${Math.max(0, position)}"/>`;
  }).join('')}</r>`).join('');
  return `${XML_HEADER}<pivotCacheRecords xmlns="${SPREADSHEET_MAIN}"`
    + ` xmlns:r="${RELATIONSHIP_BASE}" count="${records.length}">${rows}</pivotCacheRecords>`;
}

function axisItemsXml(order) {
  return `<items count="${order.length + 1}">`
    + order.map((item) => `<item x="${item}"/>`).join('')
    + '<item t="default"/></items>';
}

function axisEntriesXml(count) {
  return Array.from({ length: count }, (_, position) => (
    `<i>${position === 0 ? '<x/>' : `<x v="${position}"/>`}</i>`
  )).join('');
}

export function pivotTableXml({
  name,
  cacheId,
  fields,
  rowField,
  columnField,
  valueFields,
  destination,
}) {
  const rowOrder = rowField >= 0 ? displayOrder(fields[rowField]) : [];
  const columnOrder = columnField >= 0 ? displayOrder(fields[columnField]) : [];
  const pivotFields = fields.map((field, index) => {
    if (index === rowField) return `<pivotField axis="axisRow" showAll="0">${axisItemsXml(rowOrder)}</pivotField>`;
    if (index === columnField) return `<pivotField axis="axisCol" showAll="0">${axisItemsXml(columnOrder)}</pivotField>`;
    if (valueFields.includes(index)) return '<pivotField dataField="1" showAll="0"/>';
    return '<pivotField showAll="0"/>';
  }).join('');

  const rowSection = rowField >= 0
    ? `<rowFields count="1"><field x="${rowField}"/></rowFields>`
      + `<rowItems count="${rowOrder.length + 1}">${axisEntriesXml(rowOrder.length)}`
      + '<i t="grand"><x/></i></rowItems>'
    : '<rowItems count="1"><i/></rowItems>';

  const columnSection = columnField >= 0
    ? `<colFields count="1"><field x="${columnField}"/></colFields>`
      + `<colItems count="${columnOrder.length + 1}">${axisEntriesXml(columnOrder.length)}`
      + '<i t="grand"><x/></i></colItems>'
    : valueFields.length > 1
      ? '<colFields count="1"><field x="-2"/></colFields>'
        + `<colItems count="${valueFields.length}">`
        + valueFields.map((_, position) => (
          `<i${position ? ` i="${position}"` : ''}>${position === 0 ? '<x/>' : `<x v="${position}"/>`}</i>`
        )).join('')
        + '</colItems>'
      : '<colItems count="1"><i/></colItems>';

  const dataFields = `<dataFields count="${valueFields.length}">`
    + valueFields.map((index) => (
      `<dataField name="Sum of ${xmlEncode(fields[index].name)}" fld="${index}" baseField="0" baseItem="0"/>`
    )).join('')
    + '</dataFields>';

  const anchor = parseCellRef(destination);
  const headerRows = columnField >= 0 ? 2 : 1;
  const bodyRows = Math.max(1, rowOrder.length) + (rowField >= 0 ? 1 : 0);
  const width = 1 + (columnField >= 0 ? columnOrder.length + 1 : valueFields.length);
  const reference = `${anchor.col}${anchor.row}:`
    + `${columnLabel(columnNumber(anchor.col) + width - 1)}${anchor.row + headerRows + bodyRows - 1}`;

  return `${XML_HEADER}<pivotTableDefinition xmlns="${SPREADSHEET_MAIN}"`
    + ` name="${xmlEncode(name)}" cacheId="${cacheId}" dataCaption="Values"`
    + ' applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0"'
    + ' applyAlignmentFormats="0" applyWidthHeightFormats="1" updatedVersion="8" minRefreshableVersion="3"'
    + ' useAutoFormatting="1" itemPrintTitles="1" createdVersion="8" indent="0" outline="1" outlineData="1"'
    + ' multipleFieldFilters="0">'
    + `<location ref="${reference}" firstHeaderRow="1" firstDataRow="${headerRows}" firstDataCol="1"/>`
    + `<pivotFields count="${fields.length}">${pivotFields}</pivotFields>`
    + rowSection
    + columnSection
    + dataFields
    + '<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1"'
    + ' showRowStripes="0" showColStripes="0" showLastColumn="1"/>'
    + '</pivotTableDefinition>';
}

export async function writePivotTable(zip, {
  fields,
  records,
  sourceSheet,
  sourceRef,
  destinationSheetPath,
  destination,
  name,
  rowField,
  columnField,
  valueFields,
}) {
  let ordinal = 1;
  while (zip.file(`xl/pivotCache/pivotCacheDefinition${ordinal}.xml`)) ordinal += 1;
  const definitionPart = `xl/pivotCache/pivotCacheDefinition${ordinal}.xml`;
  const recordsPart = `xl/pivotCache/pivotCacheRecords${ordinal}.xml`;
  let tableOrdinal = 1;
  while (zip.file(`xl/pivotTables/pivotTable${tableOrdinal}.xml`)) tableOrdinal += 1;
  const tablePart = `xl/pivotTables/pivotTable${tableOrdinal}.xml`;

  const recordsRelationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(definitionPart),
    `${RELATIONSHIP_BASE}/pivotCacheRecords`,
    `pivotCacheRecords${ordinal}.xml`,
  );
  zip.file(definitionPart, cacheDefinitionXml(fields, records, sourceSheet, sourceRef, recordsRelationshipId));
  zip.file(recordsPart, cacheRecordsXml(fields, records));
  await ensureContentTypeOverride(zip, `/${definitionPart}`, CACHE_DEFINITION_CONTENT_TYPE);
  await ensureContentTypeOverride(zip, `/${recordsPart}`, CACHE_RECORDS_CONTENT_TYPE);

  const workbookRelationshipId = await addPackageRelationship(
    zip,
    'xl/_rels/workbook.xml.rels',
    `${RELATIONSHIP_BASE}/pivotCacheDefinition`,
    posix.relative('xl', definitionPart),
  );

  let workbook = await zipText(zip, 'xl/workbook.xml');
  const cacheId = ((workbook.match(/<pivotCache\b/g) || []).length + 1);
  const entry = `<pivotCache cacheId="${cacheId}" r:id="${workbookRelationshipId}"/>`;
  if (/<pivotCaches>/.test(workbook)) {
    workbook = workbook.replace('</pivotCaches>', `${entry}</pivotCaches>`);
  } else {
    const block = `<pivotCaches>${entry}</pivotCaches>`;
    workbook = /<calcPr\b[^>]*\/>/.test(workbook)
      ? workbook.replace(/(<calcPr\b[^>]*\/>)/, `$1${block}`)
      : workbook.replace('</sheets>', `</sheets>${block}`);
  }
  zip.file('xl/workbook.xml', workbook);

  zip.file(tablePart, pivotTableXml({
    name,
    cacheId,
    fields,
    rowField,
    columnField,
    valueFields,
    destination,
  }));
  await ensureContentTypeOverride(zip, `/${tablePart}`, PIVOT_TABLE_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath(tablePart),
    `${RELATIONSHIP_BASE}/pivotCacheDefinition`,
    posix.relative(posix.dirname(tablePart), definitionPart),
  );
  await addPackageRelationship(
    zip,
    partRelationshipPath(destinationSheetPath),
    `${RELATIONSHIP_BASE}/pivotTable`,
    posix.relative(posix.dirname(destinationSheetPath), tablePart),
  );
  return { definitionPart, recordsPart, tablePart, cacheId };
}
