import { basename, dirname, extname, join, posix } from 'node:path';
import { applyCellStyle } from './portable-sheet-styles.mjs';
import { normalizeXlsxFormula } from './xlsx-contract.mjs';
import { chartXml } from './portable-chart.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import { summarizePivotFields, writePivotTable } from './portable-pivot.mjs';
import { cellRecords, columnLabel, columnNumber, existingCellStyle, expandRange, forceWorkbookRecalculation, parseCellRef, setCellInSheet, setCellStyleInSheet, sharedStrings, workbookSheets } from './portable-cells.mjs';
import { CHART_CONTENT_TYPE, IMAGE_CONTENT_TYPES, PIXELS_TO_POINTS, addPackageRelationship, ensureContentTypeOverride, ensureDefaultContentType, imagePixelSize, nextRelationshipId, partRelationshipPath, provenanceCitation, zipText } from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, SPREADSHEET_MAIN, XML_HEADER, containerBody, replaceAcrossRuns, setXmlAttribute, tagPattern, xmlAttribute, xmlEncode } from './portable-xml.mjs';
import { ensureWorksheetDrawing, excelPasswordHash, writeWorksheetNote } from './portable-sheet-parts.mjs';
import { absoluteRange, appendDifferentialFormat, appendWorksheetSection, composeSheetView, displayWidth, freezePaneXml, mergedCellAnchor, mergedRanges, parseAreaRange, quoteSheetName, safeWorkbookTableName, sheetViewParts, shiftWorksheetColumns, shiftWorksheetRows, updateSheetView, upsertDefinedName, upsertWorksheetSection, worksheetSection, writeColumnWidths, writeMergedRanges } from './portable-sheet-xml.mjs';

const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';


const WORKSHEET_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';


const MAX_STYLED_CELLS = 20_000;


const TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';



function emptyWorksheetXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${SPREADSHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}">`
    + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + '<sheetData/></worksheet>';
}



async function addWorksheet(zip, name) {
  const label = String(name || '').trim();
  if (!label) throw new Error('add_sheet requires name');
  if (label.length > 31) throw new Error('Worksheet names are limited to 31 characters');
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
  zip.file(relsPath, rels.replace('</Relationships>', `<Relationship Id="${relationshipId}" Type="${WORKSHEET_RELATIONSHIP}" Target="worksheets/sheet${ordinal}.xml"/></Relationships>`));
  const sheetIds = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
  const sheetId = Math.max(0, ...sheetIds) + 1;
  const entry = `<sheet name="${xmlEncode(label)}" sheetId="${sheetId}" r:id="${relationshipId}"/>`;
  const sheetsSection = /<sheets\b[^>]*?(?:\/>|>[\s\S]*?<\/sheets>)/.exec(workbook);
  if (!sheetsSection) throw new Error('Workbook is missing its sheet list');
  const next = sheetsSection[0].endsWith('/>')
    ? `<sheets>${entry}</sheets>`
    : sheetsSection[0].replace('</sheets>', `${entry}</sheets>`);
  zip.file(workbookPath, `${workbook.slice(0, sheetsSection.index)}${next}${workbook.slice(sheetsSection.index + sheetsSection[0].length)}`);
  const types = await zipText(zip, '[Content_Types].xml');
  if (!types.includes(`PartName="/${part}"`)) {
    zip.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${part}" ContentType="${WORKSHEET_CONTENT_TYPE}"/></Types>`));
  }
  return { name: label, path: part, sheetId };
}



async function renameWorksheet(zip, sheet, name) {
  const label = String(name || '').trim();
  if (!label) throw new Error('rename_sheet requires name');
  if (label.length > 31) throw new Error('Worksheet names are limited to 31 characters');
  const workbookPath = 'xl/workbook.xml';
  const workbook = await zipText(zip, workbookPath);
  const pattern = new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(sheet.name))}"[^>]*\\/>`, 'i');
  const match = pattern.exec(workbook);
  if (!match) throw new Error(`Worksheet not found: ${sheet.name}`);
  const replaced = match[0].replace(/\bname="[^"]*"/, `name="${xmlEncode(label)}"`);
  zip.file(workbookPath, `${workbook.slice(0, match.index)}${replaced}${workbook.slice(match.index + match[0].length)}`);
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
  zip.file('[Content_Types].xml', types.replace(new RegExp(`<Override\\b[^>]*\\bPartName="/${tagPattern(sheet.path)}"[^>]*\\/>`), ''));
  return { sheet: sheet.name };
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
      const formula = op.op === 'set_formula'
        ? normalizeXlsxFormula(op.formula, { backend: 'mixdog-ooxml' })
        : '';
      const anchored = mergedCellAnchor(xml, op.cell);
      xml = setCellInSheet(xml, op.cell, op.value, formula);
      zip.file(sheet.path, xml);
      if (formula) recalculationRequired = true;
      results.push({
        op: op.op,
        changed: true,
        sheet: sheet.name,
        cell: parseCellRef(op.cell).ref,
        ...(anchored ? {} : { warning: 'Cell is inside a merged range but is not its top-left anchor; Excel hides the value.' }),
      });
      continue;
    }
    if (op.op === 'set_range') {
      const area = expandRange(op.range);
      const values = Array.isArray(op.values) ? op.values : [];
      for (let row = area.startRow; row <= area.endRow; row += 1) {
        for (let col = area.startCol; col <= area.endCol; col += 1) {
          const value = values[row - area.startRow]?.[col - area.startCol] ?? null;
          xml = setCellInSheet(xml, `${columnLabel(col)}${row}`, value);
        }
      }
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, range: op.range });
      continue;
    }
    if (op.op === 'append_row') {
      const cells = cellRecords(xml, await sharedStrings(zip));
      const maxRow = cells.reduce((max, cell) => Math.max(max, parseCellRef(cell.ref).row), 0);
      const row = maxRow + 1;
      for (let index = 0; index < (op.values || []).length; index += 1) {
        xml = setCellInSheet(xml, `${columnLabel(index + 1)}${row}`, op.values[index]);
      }
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
      if (!area.startRow || !area.startCol) throw new Error('set_style requires a bounded cell or range such as A1 or A1:D5');
      const covered = (area.endRow - area.startRow + 1) * (area.endCol - area.startCol + 1);
      if (covered > MAX_STYLED_CELLS) {
        throw new Error(`set_style covers ${covered} cells; narrow the range to at most ${MAX_STYLED_CELLS}`);
      }
      const stylesPath = 'xl/styles.xml';
      let styles = await zipText(zip, stylesPath);
      if (!styles) throw new Error('Workbook is missing xl/styles.xml');
      const resolved = new Map();
      for (let row = area.startRow; row <= area.endRow; row += 1) {
        for (let column = area.startCol; column <= area.endCol; column += 1) {
          const ref = `${columnLabel(column)}${row}`;
          const base = existingCellStyle(xml, ref);
          if (!resolved.has(base)) {
            const applied = applyCellStyle(styles, base, op.properties || {});
            styles = applied.xml;
            resolved.set(base, applied.index);
          }
          xml = setCellStyleInSheet(xml, ref, resolved.get(base));
        }
      }
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
      const next = op.op === 'merge_cells'
        ? [...current, ref]
        : current.filter((entry) => entry !== ref);
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
      const area = parseAreaRange(op.range);
      const records = cellRecords(xml, await sharedStrings(zip));
      const spans = mergedRanges(xml).map((entry) => parseAreaRange(entry));
      const measured = new Map();
      for (const record of records) {
        const parsed = parseCellRef(record.ref);
        const column = columnNumber(parsed.col);
        if (area.startCol && (column < area.startCol || column > area.endCol)) continue;
        if (area.startRow && (parsed.row < area.startRow || parsed.row > area.endRow)) continue;
        if (spans.some((span) => span.startCol !== span.endCol
          && span.startCol <= column && column <= span.endCol
          && span.startRow <= parsed.row && parsed.row <= span.endRow)) continue;
        const text = record.formula ? String(record.cachedValue ?? '') : String(record.value ?? '');
        measured.set(column, Math.max(measured.get(column) || 0, displayWidth(text)));
      }
      const widths = new Map([...measured.entries()]
        .map(([column, width]) => [column, Math.min(80, Math.max(8, Math.round((width + 2) * 10) / 10))]));
      xml = writeColumnWidths(xml, widths);
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, columns: widths.size });
      continue;
    }
    if (['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns'].includes(op.op)) {
      if (/<f(?:\s[^>]*)?>/.test(xml)) {
        throw new Error(`Portable ${op.op} cannot rewrite formula references; remove formulas first or run the edit with Microsoft Excel`);
      }
      if (mergedRanges(xml).length) {
        throw new Error(`Portable ${op.op} cannot rewrite merged ranges; unmerge first or run the edit with Microsoft Excel`);
      }
      const amount = Math.max(1, Number(op.count) || 1);
      const rowOperation = op.op.endsWith('rows');
      const from = Math.max(1, Number(rowOperation ? op.row : op.column) || 1);
      const delta = op.op.startsWith('insert') ? amount : -amount;
      xml = rowOperation
        ? shiftWorksheetRows(xml, from, delta)
        : shiftWorksheetColumns(xml, from, delta);
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
      const visibility = String(op.visibility || '').toLowerCase();
      const state = { visible: 'visible', hidden: 'hidden', very_hidden: 'veryHidden' }[visibility];
      if (!state) throw new Error('set_sheet_visibility visibility must be visible, hidden, or very_hidden');
      const workbookPath = 'xl/workbook.xml';
      const workbook = await zipText(zip, workbookPath);
      const pattern = new RegExp(`<sheet\\b[^>]*\\bname="${tagPattern(xmlEncode(sheet.name))}"[^>]*\\/>`, 'i');
      const match = pattern.exec(workbook);
      if (!match) throw new Error(`Worksheet not found: ${sheet.name}`);
      if (state !== 'visible') {
        const visible = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)]
          .filter((entry) => !/\bstate="(?:hidden|veryHidden)"/.test(entry[0]));
        if (visible.length <= 1) throw new Error('A workbook must keep at least one visible worksheet');
      }
      const attrs = state === 'visible'
        ? match[0].replace(/\s*\bstate="[^"]*"/, '')
        : match[0].replace(/\s*\bstate="[^"]*"/, '').replace(/\/>$/, ` state="${state}"/>`);
      zip.file(workbookPath, `${workbook.slice(0, match.index)}${attrs}${workbook.slice(match.index + match[0].length)}`);
      results.push({ op: op.op, changed: true, sheet: sheet.name, visibility });
      continue;
    }
    if (op.op === 'define_name' || op.op === 'delete_name') {
      const name = String(op.name || '').trim();
      if (!name) throw new Error(`${op.op} requires name`);
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
      zip.file(workbookPath, upsertDefinedName(
        workbook,
        `<definedName name="${xmlEncode(name)}">${xmlEncode(refersTo)}</definedName>`,
        matches,
      ));
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
      const label = String(op.name || `${sheet.name} copy`).slice(0, 31);
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
          sourceRelationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/table"[^>]*\/>/g, ''),
        );
      }
      await ensureContentTypeOverride(zip, `/${copyPart}`, WORKSHEET_CONTENT_TYPE);
      const relationshipId = await addPackageRelationship(
        zip,
        'xl/_rels/workbook.xml.rels',
        WORKSHEET_RELATIONSHIP,
        `worksheets/sheet${copyOrdinal}.xml`,
      );
      const workbookPath = 'xl/workbook.xml';
      const workbook = await zipText(zip, workbookPath);
      const sheetIds = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
      const entry = `<sheet name="${xmlEncode(label)}" sheetId="${Math.max(0, ...sheetIds) + 1}" r:id="${relationshipId}"/>`;
      zip.file(workbookPath, workbook.replace('</sheets>', `${entry}</sheets>`));
      if (zip.file(copyPart)) {
        zip.file(copyPart, (await zipText(zip, copyPart)).replace(/<tableParts\b[^>]*?(?:\/>|>[\s\S]*?<\/tableParts>)/, ''));
      }
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, sheet: label });
      continue;
    }
    if (op.op === 'add_image') {
      const extension = extname(String(op.path || '')).replace(/^\./, '').toLowerCase();
      const contentType = IMAGE_CONTENT_TYPES[extension];
      if (!contentType) {
        throw new Error(`Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`);
      }
      const data = await readFile(op.path);
      let mediaOrdinal = 1;
      while (zip.file(`xl/media/image${mediaOrdinal}.${extension}`)) mediaOrdinal += 1;
      const mediaPart = `xl/media/image${mediaOrdinal}.${extension}`;
      zip.file(mediaPart, data);
      await ensureDefaultContentType(zip, extension, contentType);
      const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
      xml = drawing.worksheet;
      const embedId = await addPackageRelationship(
        zip,
        partRelationshipPath(drawing.part),
        `${OFFICE_RELATIONSHIP_BASE}/image`,
        posix.relative(posix.dirname(drawing.part), mediaPart),
      );
      const pixels = imagePixelSize(data);
      const width = Number(op.width) > 0 ? Number(op.width) : (pixels ? pixels.width * PIXELS_TO_POINTS : 240);
      const height = Number(op.height) > 0 ? Number(op.height) : (pixels ? pixels.height * PIXELS_TO_POINTS : 180);
      const drawingXml = await zipText(zip, drawing.part);
      const anchorCount = (drawingXml.match(/<xdr:(absolute|two|one)CellAnchor\b/g) || []).length;
      const anchor = '<xdr:absoluteAnchor>'
        + `<xdr:pos x="${toEmu(op.left ?? 0)}" y="${toEmu(op.top ?? 0)}"/>`
        + `<xdr:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/>`
        + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${anchorCount + 2}" name="Picture ${anchorCount + 1}"/>`
        + '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        + `<xdr:blipFill><a:blip r:embed="${embedId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
        + '<xdr:clientData/></xdr:absoluteAnchor>';
      zip.file(drawing.part, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, image: mediaPart });
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
          'External',
        )
        : '';
      if (op.text != null) xml = setCellInSheet(xml, parsed.ref, op.text);
      const existing = worksheetSection(xml, 'hyperlinks');
      const previous = existing
        ? containerBody(existing[0], 'hyperlinks').replace(new RegExp(`<hyperlink\\b[^>]*\\bref="${parsed.ref}"[^>]*\\/>`), '')
        : '';
      const link = `<hyperlink ref="${parsed.ref}"${relationshipId ? ` r:id="${relationshipId}"` : ''}`
        + `${op.subAddress ? ` location="${xmlEncode(op.subAddress)}"` : ''}`
        + `${op.screenTip ? ` tooltip="${xmlEncode(op.screenTip)}"` : ''}/>`;
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
          `<sheetProtection${password} sheet="1" objects="1" scenarios="1"`
          + `${allow('allowFormattingCells', 'formatCells')}`
          + `${allow('allowSorting', 'sort')}`
          + `${allow('allowFiltering', 'autoFilter')}/>`,
        );
      }
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name });
      continue;
    }
    if (op.op === 'add_conditional_format' || op.op === 'delete_conditional_formats') {
      const area = parseAreaRange(op.range);
      const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
      if (op.op === 'delete_conditional_formats') {
        const pattern = new RegExp(`<conditionalFormatting\\b[^>]*\\bsqref="${tagPattern(reference)}"[^>]*>[\\s\\S]*?<\\/conditionalFormatting>`, 'g');
        const next = xml.replace(pattern, '');
        const changed = next !== xml;
        xml = next;
        zip.file(sheet.path, xml);
        results.push({ op: op.op, changed, sheet: sheet.name, range: reference });
        continue;
      }
      const stylesPath = 'xl/styles.xml';
      const styles = await zipText(zip, stylesPath);
      if (!styles) throw new Error('Workbook is missing xl/styles.xml');
      const differential = appendDifferentialFormat(styles, {
        color: op.color,
        fillColor: op.fillColor,
      });
      zip.file(stylesPath, differential.xml);
      const priority = [...xml.matchAll(/<cfRule\b[^>]*\bpriority="(\d+)"/g)]
        .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
      xml = appendWorksheetSection(
        xml,
        'conditionalFormatting',
        `<conditionalFormatting sqref="${reference}">`
        + `<cfRule type="expression" dxfId="${differential.id}" priority="${priority}">`
        + `<formula>${xmlEncode(String(op.formula).replace(/^=/, ''))}</formula></cfRule></conditionalFormatting>`,
      );
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, range: reference, priority });
      continue;
    }
    if (op.op === 'add_validation') {
      const area = parseAreaRange(op.range);
      const reference = `${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`;
      const existing = worksheetSection(xml, 'dataValidations');
      const previous = existing ? containerBody(existing[0], 'dataValidations') : '';
      const count = (previous.match(/<dataValidation\b/g) || []).length + 1;
      const validation = '<dataValidation type="custom" allowBlank="1" showInputMessage="1" showErrorMessage="1"'
        + `${op.inputMessage ? ` prompt="${xmlEncode(op.inputMessage)}"` : ''}`
        + `${op.errorMessage ? ` error="${xmlEncode(op.errorMessage)}"` : ''}`
        + ` sqref="${reference}">`
        + `<formula1>${xmlEncode(String(op.formula1).replace(/^=/, ''))}</formula1></dataValidation>`;
      xml = upsertWorksheetSection(
        xml,
        'dataValidations',
        `<dataValidations count="${count}">${previous}${validation}</dataValidations>`,
      );
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, range: reference });
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
      zip.file(tablePart, `${XML_HEADER}<table xmlns="${SPREADSHEET_MAIN}" id="${tableOrdinal}"`
        + ` name="${xmlEncode(tableName)}" displayName="${xmlEncode(tableName)}" ref="${reference}" totalsRowShown="0">`
        + `<autoFilter ref="${reference}"/>`
        + `<tableColumns count="${names.length}">`
        + names.map((entry, index) => `<tableColumn id="${index + 1}" name="${xmlEncode(entry)}"/>`).join('')
        + '</tableColumns>'
        + `<tableStyleInfo name="${xmlEncode(op.style || 'TableStyleMedium2')}"`
        + ' showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>'
        + '</table>');
      await ensureContentTypeOverride(zip, `/${tablePart}`, TABLE_CONTENT_TYPE);
      const relationshipId = await addPackageRelationship(
        zip,
        partRelationshipPath(sheet.path),
        `${OFFICE_RELATIONSHIP_BASE}/table`,
        posix.relative(posix.dirname(sheet.path), tablePart),
      );
      const existing = worksheetSection(xml, 'tableParts');
      const previous = existing ? containerBody(existing[0], 'tableParts') : '';
      const count = (previous.match(/<tablePart\b/g) || []).length + 1;
      xml = upsertWorksheetSection(
        xml,
        'tableParts',
        `<tableParts count="${count}">${previous}<tablePart r:id="${relationshipId}"/></tableParts>`,
      );
      zip.file(sheet.path, xml);
      results.push({ op: op.op, changed: true, sheet: sheet.name, name: tableName, columns: names.length });
      continue;
    }
    if (op.op === 'add_pivot_table') {
      const area = parseAreaRange(op.source);
      if (!area.startRow || !area.startCol || area.endRow <= area.startRow) {
        throw new Error('add_pivot_table requires a bounded source range whose first row holds field names');
      }
      const asList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean);
      const rowNames = asList(op.rows);
      const columnNames = asList(op.columns);
      const valueNames = asList(op.values);
      if (!valueNames.length) throw new Error('add_pivot_table requires at least one value field');
      if (rowNames.length > 1 || columnNames.length > 1) {
        throw new Error('Portable add_pivot_table supports one row field and one column field; run the edit with Microsoft Excel for deeper nesting');
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
      const pivotName = String(op.name || `MixdogPivot${(Object.keys(zip.files).filter((part) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(part)).length) + 1}`);
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
      results.push({
        op: op.op,
        changed: true,
        sheet: destinationName,
        name: pivotName,
        rows: records.length,
        fields: headers.length,
        part: written.tablePart,
      });
      continue;
    }
    if (op.op === 'add_chart') {
      const area = parseAreaRange(op.range);
      if (!area.startRow || !area.startCol || area.endCol <= area.startCol) {
        throw new Error('add_chart requires a bounded range whose first column holds categories');
      }
      const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
      const cellValue = (column, row) => {
        const record = grid.get(`${columnLabel(column)}${row}`);
        if (!record) return null;
        return record.formula ? record.cachedValue : record.value;
      };
      const categories = [];
      for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
        categories.push(String(cellValue(area.startCol, row) ?? ''));
      }
      const palette = Array.isArray(op.seriesColors) ? op.seriesColors : [];
      const sheetReference = quoteSheetName(sheet.name);
      const series = [];
      const names = [];
      const values = [];
      for (let column = area.startCol + 1; column <= area.endCol; column += 1) {
        const index = column - area.startCol - 1;
        const label = columnLabel(column);
        const numbers = [];
        for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
          numbers.push(Number(cellValue(column, row)));
        }
        series.push({
          name: String(cellValue(column, area.startRow) ?? `Series ${index + 1}`),
          values: numbers,
          ...(palette.length ? { color: palette[index % palette.length] } : {}),
        });
        names.push(`${sheetReference}!$${label}$${area.startRow}`);
        values.push(`${sheetReference}!$${label}$${area.startRow + 1}:$${label}$${area.endRow}`);
      }
      const categoryLabel = columnLabel(area.startCol);
      let chartOrdinal = 1;
      while (zip.file(`xl/charts/chart${chartOrdinal}.xml`)) chartOrdinal += 1;
      const chartPart = `xl/charts/chart${chartOrdinal}.xml`;
      zip.file(chartPart, chartXml({
        chartType: op.chartType,
        title: op.title,
        categories,
        series,
        references: {
          sheet: sheetReference,
          category: `${sheetReference}!$${categoryLabel}$${area.startRow + 1}:$${categoryLabel}$${area.endRow}`,
          names,
          values,
        },
        showValues: op.showValues === true,
        dataLabelPosition: op.dataLabelPosition,
        dataLabelColor: op.dataLabelColor,
        valueNumberFormat: op.valueNumberFormat,
        showLegend: op.showLegend,
        zeroBaseline: op.zeroBaseline === true,
      }));
      await ensureContentTypeOverride(zip, `/${chartPart}`, CHART_CONTENT_TYPE);
      const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
      const drawingPart = drawing.part;
      xml = drawing.worksheet;
      zip.file(sheet.path, xml);
      const chartRelationshipId = await addPackageRelationship(
        zip,
        partRelationshipPath(drawingPart),
        `${OFFICE_RELATIONSHIP_BASE}/chart`,
        posix.relative(posix.dirname(drawingPart), chartPart),
      );
      const drawingXml = await zipText(zip, drawingPart);
      const anchorCount = (drawingXml.match(/<xdr:(absolute|two|one)CellAnchor\b/g) || []).length;
      const anchor = '<xdr:absoluteAnchor>'
        + `<xdr:pos x="${toEmu(op.left ?? 300)}" y="${toEmu(op.top ?? 20)}"/>`
        + `<xdr:ext cx="${Math.max(1, toEmu(op.width ?? 480))}" cy="${Math.max(1, toEmu(op.height ?? 280))}"/>`
        + '<xdr:graphicFrame macro="">'
        + `<xdr:nvGraphicFramePr><xdr:cNvPr id="${anchorCount + 2}" name="Chart ${anchorCount + 1}"/>`
        + '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
        + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
        + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
        + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
        + ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${chartRelationshipId}"/>`
        + '</a:graphicData></a:graphic></xdr:graphicFrame>'
        + '<xdr:clientData/></xdr:absoluteAnchor>';
      zip.file(drawingPart, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
      results.push({ op: op.op, changed: true, sheet: sheet.name, chart: chartPart, series: series.length });
      continue;
    }
    if (op.op === 'set_page_setup') {
      const orientation = String(op.orientation || '').toLowerCase();
      if (orientation && !['portrait', 'landscape'].includes(orientation)) {
        throw new Error('set_page_setup orientation must be portrait or landscape');
      }
      const fitWide = Number(op.fitToPagesWide) || 0;
      const fitTall = op.fitToPagesTall == null ? null : Number(op.fitToPagesTall) || 0;
      if (fitWide || fitTall != null) {
        const existing = worksheetSection(xml, 'sheetPr');
        const attrs = existing ? /^<sheetPr\b([^>]*?)(?:\/>|>)/.exec(existing[0])?.[1] || '' : '';
        const body = existing && !existing[0].endsWith('/>')
          ? existing[0].slice(existing[0].indexOf('>') + 1, existing[0].lastIndexOf('</sheetPr>'))
          : '';
        const cleaned = body.replace(/<pageSetUpPr\b[^>]*?\/>/, '');
        xml = upsertWorksheetSection(xml, 'sheetPr', `<sheetPr${attrs}>${cleaned}<pageSetUpPr fitToPage="1"/></sheetPr>`);
      }
      const centered = `${op.centerHorizontally === true ? ' horizontalCentered="1"' : ''}`
        + `${op.centerVertically === true ? ' verticalCentered="1"' : ''}`;
      xml = upsertWorksheetSection(xml, 'printOptions', centered ? `<printOptions${centered}/>` : '');
      const margin = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
      xml = upsertWorksheetSection(xml, 'pageMargins', `<pageMargins left="${margin(op.leftMargin, 0.7)}"`
        + ` right="${margin(op.rightMargin, 0.7)}" top="${margin(op.topMargin, 0.75)}"`
        + ` bottom="${margin(op.bottomMargin, 0.75)}" header="0.3" footer="0.3"/>`);
      xml = upsertWorksheetSection(xml, 'pageSetup', `<pageSetup paperSize="9"`
        + `${orientation ? ` orientation="${orientation}"` : ''}`
        + `${fitWide ? ` fitToWidth="${fitWide}"` : ''}`
        + `${fitTall == null ? '' : ` fitToHeight="${fitTall}"`}/>`);
      zip.file(sheet.path, xml);
      if (op.printArea) {
        const area = parseAreaRange(op.printArea);
        const reference = `${quoteSheetName(sheet.name)}!`
          + absoluteRange(`${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`);
        const localSheetId = sheets.findIndex((entry) => entry.name === sheet.name);
        const workbookPath = 'xl/workbook.xml';
        const workbook = await zipText(zip, workbookPath);
        zip.file(workbookPath, upsertDefinedName(
          workbook,
          `<definedName name="_xlnm.Print_Area" localSheetId="${localSheetId}">${xmlEncode(reference)}</definedName>`,
          (item) => xmlAttribute(item, 'name') === '_xlnm.Print_Area'
            && Number(xmlAttribute(item, 'localSheetId')) === localSheetId,
        ));
      }
      results.push({ op: op.op, changed: true, sheet: sheet.name });
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
