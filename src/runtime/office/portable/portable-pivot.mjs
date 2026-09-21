import { posix } from 'node:path';
import { addPackageRelationship, ensureContentTypeOverride, partRelationshipPath, zipText } from './portable-opc.mjs';
import { columnLabel, columnNumber, parseCellRef, setCellInSheet } from './portable-cells.mjs';
import { SPREADSHEET_MAIN, XML_HEADER, xmlEncode } from './portable-xml.mjs';

const CACHE_DEFINITION_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';
const CACHE_RECORDS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml';
const PIVOT_TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';
const RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function summarizePivotFields(headers, records) {
  return headers.map((name, index) => {
    const column = records.map((record) => record[index]);
    const numeric =
      column.length > 0 &&
      column.every((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
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
    const items = new Set();
    for (const value of column) {
      items.add(String(value ?? ''));
    }
    return { name, numeric: false, items: [...items] };
  });
}

function displayOrder(field) {
  return [...field.items.keys()].sort((left, right) => field.items[left].localeCompare(field.items[right], 'en'));
}

function sharedItemsXml(field) {
  if (field.numeric) {
    const integer = field.integer ? ' containsInteger="1"' : '';
    return (
      `<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"` +
      `${integer} minValue="${field.min}" maxValue="${field.max}"/>`
    );
  }
  const items = field.items.map((item) => `<s v="${xmlEncode(item)}"/>`).join('');
  return `<sharedItems count="${field.items.length}">${items}</sharedItems>`;
}

function cacheDefinitionXml(fields, records, sourceSheet, sourceRef, recordsRelationshipId) {
  const cacheFields = fields
    .map((field) => `<cacheField name="${xmlEncode(field.name)}" numFmtId="0">${sharedItemsXml(field)}</cacheField>`)
    .join('');
  return (
    `${XML_HEADER}<pivotCacheDefinition xmlns="${SPREADSHEET_MAIN}"` +
    ` xmlns:r="${RELATIONSHIP_BASE}" r:id="${recordsRelationshipId}"` +
    ' createdVersion="8" refreshedVersion="8" minRefreshableVersion="3" refreshOnLoad="1"' +
    ` recordCount="${records.length}">` +
    `<cacheSource type="worksheet"><worksheetSource ref="${xmlEncode(sourceRef)}" sheet="${xmlEncode(sourceSheet)}"/></cacheSource>` +
    `<cacheFields count="${fields.length}">${cacheFields}</cacheFields>` +
    '</pivotCacheDefinition>'
  );
}

function cacheRecordsXml(fields, records) {
  const rows = records
    .map(
      (record) =>
        `<r>${record
          .map((value, index) => {
            const field = fields[index];
            if (field.numeric) return `<n v="${Number(value)}"/>`;
            const position = field.items.indexOf(String(value ?? ''));
            return `<x v="${Math.max(0, position)}"/>`;
          })
          .join('')}</r>`
    )
    .join('');
  return (
    `${XML_HEADER}<pivotCacheRecords xmlns="${SPREADSHEET_MAIN}"` +
    ` xmlns:r="${RELATIONSHIP_BASE}" count="${records.length}">${rows}</pivotCacheRecords>`
  );
}

// Excel keeps a pivot twice over: the definition a refresh recomputes, and the
// cells a reader sees before any refresh happens. A destination sheet with the
// definition alone opens empty in Excel and holds nothing for a snapshot, an
// autofit, or a fit audit to read, so the computed grid is written as cells.
const GRAND_TOTAL = 'Grand Total';

function pivotGrid({ fields, records, rowField, columnField, valueFields }) {
  const itemsOf = (index) => displayOrder(fields[index]).map((item) => fields[index].items[item]);
  const rowLabels = rowField >= 0 ? itemsOf(rowField) : [];
  const columnLabels = columnField >= 0 ? itemsOf(columnField) : [];
  const sum = (valueIndex, matches) =>
    records.reduce((total, record) => (matches(record) ? total + (Number(record[valueIndex]) || 0) : total), 0);
  const heading = (valueIndex) => `Sum of ${fields[valueIndex].name}`;
  const rows = [];
  if (columnField >= 0) {
    const valueIndex = valueFields[0];
    const inRow = (record, label) => String(record[rowField] ?? '') === label;
    const inColumn = (record, label) => String(record[columnField] ?? '') === label;
    rows.push([heading(valueIndex), fields[columnField].name]);
    rows.push([rowField >= 0 ? fields[rowField].name : '', ...columnLabels, GRAND_TOTAL]);
    for (const label of rowLabels) {
      const cells = columnLabels.map((column) =>
        sum(valueIndex, (record) => inRow(record, label) && inColumn(record, column))
      );
      rows.push([label, ...cells, sum(valueIndex, (record) => inRow(record, label))]);
    }
    const totals = columnLabels.map((column) => sum(valueIndex, (record) => inColumn(record, column)));
    rows.push([GRAND_TOTAL, ...totals, sum(valueIndex, () => true)]);
    return rows;
  }
  rows.push([rowField >= 0 ? fields[rowField].name : '', ...valueFields.map(heading)]);
  for (const label of rowLabels) {
    rows.push([
      label,
      ...valueFields.map((valueIndex) => sum(valueIndex, (record) => String(record[rowField] ?? '') === label)),
    ]);
  }
  rows.push([rowField >= 0 ? GRAND_TOTAL : 'Total', ...valueFields.map((valueIndex) => sum(valueIndex, () => true))]);
  return rows;
}

function axisItemsXml(order) {
  return (
    `<items count="${order.length + 1}">` +
    order.map((item) => `<item x="${item}"/>`).join('') +
    '<item t="default"/></items>'
  );
}

function axisEntriesXml(count) {
  return Array.from(
    { length: count },
    (_, position) => `<i>${position === 0 ? '<x/>' : `<x v="${position}"/>`}</i>`
  ).join('');
}

function pivotTableXml({ name, cacheId, fields, rowField, columnField, valueFields, destination }) {
  const rowOrder = rowField >= 0 ? displayOrder(fields[rowField]) : [];
  const columnOrder = columnField >= 0 ? displayOrder(fields[columnField]) : [];
  const pivotFields = fields
    .map((_field, index) => {
      if (index === rowField) return `<pivotField axis="axisRow" showAll="0">${axisItemsXml(rowOrder)}</pivotField>`;
      if (index === columnField)
        return `<pivotField axis="axisCol" showAll="0">${axisItemsXml(columnOrder)}</pivotField>`;
      if (valueFields.includes(index)) return '<pivotField dataField="1" showAll="0"/>';
      return '<pivotField showAll="0"/>';
    })
    .join('');

  const rowSection =
    rowField >= 0
      ? `<rowFields count="1"><field x="${rowField}"/></rowFields>` +
        `<rowItems count="${rowOrder.length + 1}">${axisEntriesXml(rowOrder.length)}` +
        '<i t="grand"><x/></i></rowItems>'
      : '<rowItems count="1"><i/></rowItems>';

  const valueItemXml = (position) => {
    const index = position ? ` i="${position}"` : '';
    const value = position === 0 ? '<x/>' : `<x v="${position}"/>`;
    return `<i${index}>${value}</i>`;
  };
  let columnSection = '<colItems count="1"><i/></colItems>';
  if (columnField >= 0) {
    columnSection =
      `<colFields count="1"><field x="${columnField}"/></colFields>` +
      `<colItems count="${columnOrder.length + 1}">${axisEntriesXml(columnOrder.length)}` +
      '<i t="grand"><x/></i></colItems>';
  } else if (valueFields.length > 1) {
    columnSection =
      '<colFields count="1"><field x="-2"/></colFields>' +
      `<colItems count="${valueFields.length}">` +
      valueFields.map((_, position) => valueItemXml(position)).join('') +
      '</colItems>';
  }

  const dataFields =
    `<dataFields count="${valueFields.length}">` +
    valueFields
      .map(
        (index) =>
          `<dataField name="Sum of ${xmlEncode(fields[index].name)}" fld="${index}" baseField="0" baseItem="0"/>`
      )
      .join('') +
    '</dataFields>';

  const anchor = parseCellRef(destination);
  const headerRows = columnField >= 0 ? 2 : 1;
  const bodyRows = Math.max(1, rowOrder.length) + (rowField >= 0 ? 1 : 0);
  const width = 1 + (columnField >= 0 ? columnOrder.length + 1 : valueFields.length);
  const reference =
    `${anchor.col}${anchor.row}:` +
    `${columnLabel(columnNumber(anchor.col) + width - 1)}${anchor.row + headerRows + bodyRows - 1}`;

  return (
    `${XML_HEADER}<pivotTableDefinition xmlns="${SPREADSHEET_MAIN}"` +
    ` name="${xmlEncode(name)}" cacheId="${cacheId}" dataCaption="Values"` +
    ' applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0"' +
    ' applyAlignmentFormats="0" applyWidthHeightFormats="1" updatedVersion="8" minRefreshableVersion="3"' +
    ' useAutoFormatting="1" itemPrintTitles="1" createdVersion="8" indent="0" outline="1" outlineData="1"' +
    ' multipleFieldFilters="0">' +
    `<location ref="${reference}" firstHeaderRow="1" firstDataRow="${headerRows}" firstDataCol="1"/>` +
    `<pivotFields count="${fields.length}">${pivotFields}</pivotFields>` +
    rowSection +
    columnSection +
    dataFields +
    '<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1"' +
    ' showRowStripes="0" showColStripes="0" showLastColumn="1"/>' +
    '</pivotTableDefinition>'
  );
}

export async function writePivotTable(
  zip,
  {
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
  }
) {
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
    `pivotCacheRecords${ordinal}.xml`
  );
  zip.file(definitionPart, cacheDefinitionXml(fields, records, sourceSheet, sourceRef, recordsRelationshipId));
  zip.file(recordsPart, cacheRecordsXml(fields, records));
  await ensureContentTypeOverride(zip, `/${definitionPart}`, CACHE_DEFINITION_CONTENT_TYPE);
  await ensureContentTypeOverride(zip, `/${recordsPart}`, CACHE_RECORDS_CONTENT_TYPE);

  const workbookRelationshipId = await addPackageRelationship(
    zip,
    'xl/_rels/workbook.xml.rels',
    `${RELATIONSHIP_BASE}/pivotCacheDefinition`,
    posix.relative('xl', definitionPart)
  );

  let workbook = await zipText(zip, 'xl/workbook.xml');
  const cacheId = (workbook.match(/<pivotCache\b/g) || []).length + 1;
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

  zip.file(
    tablePart,
    pivotTableXml({
      name,
      cacheId,
      fields,
      rowField,
      columnField,
      valueFields,
      destination,
    })
  );
  await ensureContentTypeOverride(zip, `/${tablePart}`, PIVOT_TABLE_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath(tablePart),
    `${RELATIONSHIP_BASE}/pivotCacheDefinition`,
    posix.relative(posix.dirname(tablePart), definitionPart)
  );
  await addPackageRelationship(
    zip,
    partRelationshipPath(destinationSheetPath),
    `${RELATIONSHIP_BASE}/pivotTable`,
    posix.relative(posix.dirname(destinationSheetPath), tablePart)
  );

  const anchor = parseCellRef(destination);
  const anchorColumn = columnNumber(anchor.col);
  const grid = pivotGrid({ fields, records, rowField, columnField, valueFields });
  let sheetXml = await zipText(zip, destinationSheetPath);
  grid.forEach((row, rowOffset) => {
    row.forEach((value, columnOffset) => {
      if (value === '' || value === null || value === undefined) return;
      sheetXml = setCellInSheet(
        sheetXml,
        `${columnLabel(anchorColumn + columnOffset)}${anchor.row + rowOffset}`,
        value
      );
    });
  });
  zip.file(destinationSheetPath, sheetXml);

  return { definitionPart, recordsPart, tablePart, cacheId, rows: grid.length, columns: grid[0]?.length || 0 };
}
