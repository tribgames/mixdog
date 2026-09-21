// Cell, range, view and workbook-level edits the portable XLSX backend applies
// to one worksheet. Every edit takes the sheet's current XML and returns the
// operation result; the dispatcher in portable-xlsx.mjs owns the loop.
import { posix } from 'node:path';
import { applyCellStyle } from './portable-sheet-styles.mjs';
import { normalizeXlsxFormula } from './xlsx-contract.mjs';
import {
  cellRecords,
  cellStyleIndexes,
  columnLabel,
  columnNumber,
  expandRange,
  parseCellRef,
  setCellInSheet,
  setCellStylesInSheet,
  setCellsInSheet,
  sharedStrings,
} from './portable-cells.mjs';
import {
  addPackageRelationship,
  ensureContentTypeOverride,
  partRelationshipPath,
  provenanceCitation,
  relationshipTargetByType,
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
  xmlEncode,
} from './portable-xml.mjs';
import { excelPasswordHash, writeWorksheetNote } from './portable-sheet-parts.mjs';
import {
  areaReference,
  composeSheetView,
  freezePaneXml,
  mergedCellAnchor,
  mergedRanges,
  parseAreaRange,
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
  writeMergedRanges,
} from './portable-sheet-xml.mjs';
import {
  MAX_STYLED_CELLS,
  TABLE_CONTENT_TYPE,
  WORKSHEET_CONTENT_TYPE,
  WORKSHEET_RELATIONSHIP,
  assertWorksheetName,
  tableStyleInfoXml,
} from './portable-xlsx-operations.mjs';

const WORKBOOK_PATH = 'xl/workbook.xml';

// set_cell / set_formula. `recalculate` tells the dispatcher a formula landed,
// so the workbook is marked for a full recalculation once all edits are in.
export function setWorksheetCell(zip, sheet, xml, op, sheets) {
  const formula =
    op.op === 'set_formula'
      ? normalizeXlsxFormula(op.formula, { backend: 'mixdog-ooxml', sheetNames: sheets.map((entry) => entry.name) })
      : '';
  const anchored = mergedCellAnchor(xml, op.cell);
  zip.file(sheet.path, setCellInSheet(xml, op.cell, op.value, formula));
  const normalized = formula && formula !== String(op.formula ?? '').replace(/^=/, '');
  const result = {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    cell: parseCellRef(op.cell).ref,
    ...(normalized ? { normalizedFormula: `=${formula}` } : {}),
    ...(anchored
      ? {}
      : { warning: 'Cell is inside a merged range but is not its top-left anchor; Excel hides the value.' }),
  };
  return { result, recalculate: Boolean(formula) };
}

export function setWorksheetRange(zip, sheet, xml, op) {
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
  zip.file(sheet.path, setCellsInSheet(xml, entries));
  return { op: op.op, changed: true, sheet: sheet.name, range: op.range };
}

export async function appendWorksheetRow(zip, sheet, xml, op) {
  const cells = cellRecords(xml, await sharedStrings(zip));
  const maxRow = cells.reduce((max, cell) => Math.max(max, parseCellRef(cell.ref).row), 0);
  const row = maxRow + 1;
  zip.file(
    sheet.path,
    setCellsInSheet(
      xml,
      (op.values || []).map((value, index) => ({
        ref: `${columnLabel(index + 1)}${row}`,
        value,
      }))
    )
  );
  return { op: op.op, changed: true, sheet: sheet.name, row };
}

export function clearWorksheetCell(zip, sheet, xml, op) {
  const parsed = parseCellRef(op.cell);
  const cellRegex = new RegExp(`<c\\b[^>]*\\br="${parsed.ref}"[^>]*(?:>[\\s\\S]*?</c>|/>)`, 'i');
  const changed = cellRegex.test(xml);
  if (changed) zip.file(sheet.path, xml.replace(cellRegex, ''));
  return { op: op.op, changed, sheet: sheet.name, cell: parsed.ref };
}

// replace_text runs over every sheet and the shared-string table, not just
// the addressed sheet.
export async function replaceWorkbookText(zip, sheets, op) {
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
  return { op: op.op, changed: count > 0, count };
}

export async function setWorksheetStyle(zip, sheet, xml, op) {
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
  zip.file(stylesPath, styles);
  zip.file(sheet.path, setCellStylesInSheet(xml, styled));
  return { op: op.op, changed: covered > 0, sheet: sheet.name, cells: covered };
}

// merge_cells / unmerge_cells
export function mergeWorksheetCells(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  if (!area.startRow || !area.startCol) throw new Error(`${op.op} requires a bounded range such as A1:D1`);
  const ref = areaReference(area);
  const current = mergedRanges(xml);
  const next = op.op === 'merge_cells' ? [...current, ref] : current.filter((entry) => entry !== ref);
  const changed = new Set(next).size !== new Set(current).size;
  zip.file(sheet.path, writeMergedRanges(xml, next));
  return { op: op.op, changed, sheet: sheet.name, range: ref };
}

export function freezeWorksheetPanes(zip, sheet, xml, op) {
  const pane = freezePaneXml(op.row, op.column);
  const next = updateSheetView(xml, (view) => {
    const { attrs, body } = sheetViewParts(view);
    const stripped = body.replace(/<pane\b[^>]*?(?:\/>|>[\s\S]*?<\/pane>)/, '');
    return composeSheetView(attrs, `${pane}${stripped}`);
  });
  zip.file(sheet.path, next);
  return { op: op.op, changed: true, sheet: sheet.name, frozen: Boolean(pane) };
}

export function setWorksheetView(zip, sheet, xml, op) {
  const updated = updateSheetView(xml, (view) => {
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
  zip.file(sheet.path, updated);
  return { op: op.op, changed: true, sheet: sheet.name };
}

// insert_rows / delete_rows / insert_columns / delete_columns
export function shiftWorksheetRowsOrColumns(zip, sheet, xml, op) {
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
  zip.file(sheet.path, rowOperation ? shiftWorksheetRows(xml, from, delta) : shiftWorksheetColumns(xml, from, delta));
  return { op: op.op, changed: true, sheet: sheet.name, from, count: amount };
}

export function setWorksheetAutofilter(zip, sheet, xml, op) {
  const enabled = op.enabled !== false;
  let next;
  if (enabled) {
    const reference = areaReference(parseAreaRange(op.range));
    next = upsertWorksheetSection(xml, 'autoFilter', `<autoFilter ref="${reference}"/>`);
  } else {
    next = upsertWorksheetSection(xml, 'autoFilter', '');
  }
  zip.file(sheet.path, next);
  return { op: op.op, changed: true, sheet: sheet.name, enabled };
}

// Rows and columns are hidden with visible: true/false, so the same word
// must work on a sheet rather than costing a round trip.
export async function setWorksheetVisibility(zip, sheet, _xml, op) {
  let requested = '';
  if (op.visibility != null) requested = op.visibility;
  else if (typeof op.visible === 'boolean') requested = op.visible ? 'visible' : 'hidden';
  const visibility = String(requested).toLowerCase();
  const state = { visible: 'visible', hidden: 'hidden', very_hidden: 'veryHidden' }[visibility];
  if (!state)
    throw new Error('set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)');
  const workbook = await zipText(zip, WORKBOOK_PATH);
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
  zip.file(WORKBOOK_PATH, `${workbook.slice(0, match.index)}${attrs}${workbook.slice(match.index + match[0].length)}`);
  return { op: op.op, changed: true, sheet: sheet.name, visibility };
}

// Hiding a row or a column is how a sheet withholds a working note or a
// filtered record without deleting it; the snapshot reports the same state
// back as hiddenRows / hiddenColumns.
export function setRowOrColumnVisibility(zip, sheet, xml, op) {
  if (typeof op.visible !== 'boolean') throw new Error(`${op.op} requires visible: true or false`);
  const rows = op.op === 'set_row_visibility';
  let start;
  if (rows) start = Math.round(Number(op.row));
  else if (typeof op.column === 'string' && /^[A-Za-z]+$/.test(op.column.trim())) {
    start = columnNumber(op.column.trim().toUpperCase());
  } else start = Math.round(Number(op.column));
  if (!Number.isFinite(start) || start < 1) {
    throw new Error(
      rows
        ? 'set_row_visibility requires row (1-based)'
        : 'set_column_visibility requires column (a letter such as D, or a 1-based number)'
    );
  }
  const count = Math.max(1, Math.round(Number(op.count) || 1));
  const targets = Array.from({ length: count }, (_, index) => start + index);
  let next = xml;
  if (rows) {
    for (const row of targets) {
      const existing = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*?(?:/>|>)`).exec(next);
      if (existing) {
        const stripped = existing[0].replace(/\s*\bhidden="[^"]*"/, '');
        const replacement = op.visible ? stripped : stripped.replace(/(\/?>)$/, ' hidden="1"$1');
        next = `${next.slice(0, existing.index)}${replacement}${next.slice(existing.index + existing[0].length)}`;
        continue;
      }
      if (op.visible) continue;
      // An empty row still hides, and Excel needs the element to record it.
      const later = [...next.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>)/g)].find(
        (entry) => Number(entry[1]) > row
      );
      let anchor = later ? later.index : next.indexOf('</sheetData>');
      if (anchor < 0) {
        // A sheet with no rows yet carries <sheetData/> — what add_sheet
        // writes — and the row still has to go inside it.
        const empty = /<sheetData\b([^>]*?)\/>/.exec(next);
        if (!empty) throw new Error('Worksheet has no sheetData to hide a row in');
        const opening = `<sheetData${empty[1]}>`;
        next = `${next.slice(0, empty.index)}${opening}</sheetData>${next.slice(empty.index + empty[0].length)}`;
        anchor = empty.index + opening.length;
      }
      next = `${next.slice(0, anchor)}<row r="${row}" hidden="1"/>${next.slice(anchor)}`;
    }
  } else {
    next = writeColumnVisibility(next, targets, op.visible);
  }
  zip.file(sheet.path, next);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    visible: op.visible,
    ...(rows ? { rows: targets } : { columns: targets.map((column) => columnLabel(column)) }),
  };
}

// define_name / delete_name
export async function defineWorkbookName(zip, op) {
  const name = String(op.name || '').trim();
  if (!name) throw new Error(`${op.op} requires name`);
  const fault = op.op === 'define_name' ? workbookDefinedNameFault(name) : '';
  if (fault) throw new Error(`Excel refuses the defined name "${name}": ${fault}.`);
  const workbook = await zipText(zip, WORKBOOK_PATH);
  const matches = (item) => xmlAttribute(item, 'name') === name;
  if (op.op === 'delete_name') {
    const next = upsertDefinedName(workbook, '', matches);
    zip.file(WORKBOOK_PATH, next);
    return { op: op.op, changed: next !== workbook, name };
  }
  const refersTo = String(op.refersTo || '').trim();
  if (!refersTo) throw new Error('define_name requires refersTo');
  zip.file(
    WORKBOOK_PATH,
    upsertDefinedName(workbook, `<definedName name="${xmlEncode(name)}">${xmlEncode(refersTo)}</definedName>`, matches)
  );
  return { op: op.op, changed: true, name, refersTo };
}

// add_note / add_provenance
export async function addWorksheetNote(zip, sheet, xml, op) {
  const text = op.op === 'add_provenance' ? provenanceCitation(op.source) : String(op.text || '');
  if (!text) throw new Error(`${op.op} requires ${op.op === 'add_provenance' ? 'source' : 'text'}`);
  const written = await writeWorksheetNote(zip, sheet, xml, {
    cell: op.cell,
    text,
    author: op.author || 'Mixdog',
    append: op.op === 'add_provenance',
  });
  zip.file(sheet.path, written.worksheet);
  return {
    op: op.op,
    changed: written.changed,
    sheet: sheet.name,
    cell: parseCellRef(op.cell).ref,
    ...(op.op === 'add_provenance' ? { citation: text } : {}),
  };
}

export async function deleteWorksheetNote(zip, sheet, _xml, op) {
  const parsed = parseCellRef(op.cell);
  const relationships = await zipText(zip, partRelationshipPath(sheet.path));
  const target = relationshipTargetByType(relationships, 'comments');
  if (!target) return { op: op.op, changed: false, sheet: sheet.name, cell: parsed.ref };
  const commentsPart = posix.normalize(posix.join(posix.dirname(sheet.path), target));
  const comments = await zipText(zip, commentsPart);
  const pattern = new RegExp(`<comment\\b[^>]*\\bref="${parsed.ref}"[^>]*>[\\s\\S]*?<\\/comment>`);
  const changed = pattern.test(comments);
  if (changed) zip.file(commentsPart, comments.replace(pattern, ''));
  return { op: op.op, changed, sheet: sheet.name, cell: parsed.ref };
}

// copy_sheet adds a workbook entry, so the dispatcher re-reads the sheet list.
export async function copyWorksheet(zip, sheet, xml, op, sheets) {
  const label = assertWorksheetName('copy_sheet', String(op.name || `${sheet.name} copy`).slice(0, 31));
  if (sheets.some((entry) => entry.name.toLowerCase() === label.toLowerCase())) {
    throw new Error(`Worksheet already exists: ${label}`);
  }
  let copyOrdinal = 1;
  while (zip.file(`xl/worksheets/sheet${copyOrdinal}.xml`)) copyOrdinal += 1;
  const copyPart = `xl/worksheets/sheet${copyOrdinal}.xml`;
  // A table part belongs to the sheet that declares it, so the copy takes the
  // cells without the tableParts entry or the table relationships.
  zip.file(copyPart, xml.replace(/<tableParts\b[^>]*?(?:\/>|>[\s\S]*?<\/tableParts>)/, ''));
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
  const workbook = await zipText(zip, WORKBOOK_PATH);
  const sheetIds = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
  const entry = `<sheet name="${xmlEncode(label)}" sheetId="${Math.max(0, ...sheetIds) + 1}" r:id="${relationshipId}"/>`;
  zip.file(WORKBOOK_PATH, workbook.replace('</sheets>', `${entry}</sheets>`));
  return { op: op.op, changed: true, sheet: label };
}

export async function setWorksheetHyperlink(zip, sheet, xml, op) {
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
  let next = op.text != null ? setCellInSheet(xml, parsed.ref, op.text) : xml;
  const existing = worksheetSection(next, 'hyperlinks');
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
  next = upsertWorksheetSection(next, 'hyperlinks', `<hyperlinks>${previous}${link}</hyperlinks>`);
  zip.file(sheet.path, next);
  return { op: op.op, changed: true, sheet: sheet.name, cell: parsed.ref, address };
}

// protect_sheet / unprotect_sheet
export function protectWorksheet(zip, sheet, xml, op) {
  let next;
  if (op.op === 'unprotect_sheet') {
    next = upsertWorksheetSection(xml, 'sheetProtection', '');
  } else {
    const allow = (key, attribute) => (op[key] === true ? ` ${attribute}="0"` : '');
    const password = op.password ? ` password="${excelPasswordHash(op.password)}"` : '';
    next = upsertWorksheetSection(
      xml,
      'sheetProtection',
      `<sheetProtection${password} sheet="1" objects="1" scenarios="1"` +
        `${allow('allowFormattingCells', 'formatCells')}` +
        `${allow('allowSorting', 'sort')}` +
        `${allow('allowFiltering', 'autoFilter')}/>`
    );
  }
  zip.file(sheet.path, next);
  return { op: op.op, changed: true, sheet: sheet.name };
}

export async function addWorksheetTable(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  if (!area.startRow || !area.startCol) throw new Error('add_table requires a bounded range such as A1:C10');
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  const names = [];
  let next = xml;
  for (let column = area.startCol; column <= area.endCol; column += 1) {
    const reference = `${columnLabel(column)}${area.startRow}`;
    const raw = String(grid.get(reference)?.value ?? '').trim();
    let name = raw || `Column${column - area.startCol + 1}`;
    while (names.includes(name)) name = `${name}_${names.length + 1}`;
    if (!raw) next = setCellInSheet(next, reference, name);
    names.push(name);
  }
  let tableOrdinal = 1;
  while (zip.file(`xl/tables/table${tableOrdinal}.xml`)) tableOrdinal += 1;
  const tablePart = `xl/tables/table${tableOrdinal}.xml`;
  const reference = areaReference(area);
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
  const existing = worksheetSection(next, 'tableParts');
  const previous = existing ? containerBody(existing[0], 'tableParts') : '';
  const count = (previous.match(/<tablePart\b/g) || []).length + 1;
  next = upsertWorksheetSection(
    next,
    'tableParts',
    `<tableParts count="${count}">${previous}<tablePart r:id="${relationshipId}"/></tableParts>`
  );
  zip.file(sheet.path, next);
  return { op: op.op, changed: true, sheet: sheet.name, name: tableName, columns: names.length };
}
