import { join, posix } from 'node:path';
import { relationshipMap, zipText } from './portable-opc.mjs';
import { containerBody, elementSpans, paragraphTexts, setXmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';

export async function workbookSheets(zip) {
  const workbook = await zipText(zip, 'xl/workbook.xml');
  const rels = relationshipMap(await zipText(zip, 'xl/_rels/workbook.xml.rels'));
  const sheets = [];
  const regex = /<sheet\b([^>]+?)\/?>/g;
  let match;
  while ((match = regex.exec(workbook))) {
    const attrs = match[1];
    const name = xmlDecode(/\bname="([^"]+)"/.exec(attrs)?.[1] || '');
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const target = rid ? rels.get(rid) : '';
    if (!name || !target) continue;
    const normalized = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
    sheets.push({ name, path: normalized, rid });
  }
  return sheets;
}


export async function sharedStrings(zip) {
  const xml = await zipText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const strings = [];
  const regex = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = regex.exec(xml))) strings.push(paragraphTexts(match[1], 't').join(''));
  return strings;
}


function snapshotRangeBounds(reference) {
  const match = /^([^:]+):([^:]+)$/.exec(String(reference || '').trim());
  if (!match) return null;
  const start = parseCellRef(match[1]);
  const end = parseCellRef(match[2]);
  return {
    startRow: start.row,
    endRow: end.row,
    startCol: columnNumber(start.col),
    endCol: columnNumber(end.col),
  };
}


export function* iterateSheetCells(xml) {
  const regex = /<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)\/>|<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>([\s\S]*?)<\/c>/g;
  let match;
  while ((match = regex.exec(xml))) {
    yield {
      attributes: match[1] ?? match[3] ?? '',
      ref: match[2] ?? match[4],
      body: match[5] || '',
    };
  }
}

export function* iterateSheetRows(xml) {
  const regex = /<row\b([^>]*?)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let match;
  while ((match = regex.exec(xml))) {
    yield {
      attributes: match[1] ?? match[2] ?? '',
      body: match[3] || '',
    };
  }
}

export function cellRecords(xml, strings, options = null) {
  const records = [];
  const paged = options?.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 2_000) : Number.POSITIVE_INFINITY;
  const bounds = paged && options.range ? snapshotRangeBounds(options.range) : null;
  let total = 0;
  let formulaCount = 0;
  let formulaCacheMissing = 0;
  for (const cell of iterateSheetCells(xml)) {
    const attrs = cell.attributes;
    const ref = cell.ref;
    if (bounds) {
      const parsed = parseCellRef(ref);
      const column = columnNumber(parsed.col);
      if (parsed.row < bounds.startRow || parsed.row > bounds.endRow || column < bounds.startCol || column > bounds.endCol) continue;
    }
    const body = cell.body;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || '';
    const formula = xmlDecode(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1] || '');
    let raw = '';
    let value;
    if (type === 'inlineStr') value = paragraphTexts(body, 't').join('');
    else {
      raw = xmlDecode(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] || '');
      value = type === 's' ? strings[Number(raw)] ?? raw : raw;
    }
    const record = {
      ref,
      value,
      ...(formula ? {
        formula,
        cachedValue: raw === '' ? null : value,
        cacheState: raw === '' ? 'missing' : 'present',
      } : {}),
    };
    if (formula) {
      formulaCount += 1;
      if (record.cacheState === 'missing') formulaCacheMissing += 1;
    }
    if (!paged || (total >= offset && records.length < limit)) records.push(record);
    total += 1;
  }
  return paged ? { records, total, formulaCount, formulaCacheMissing } : records;
}


export function booleanXmlAttribute(attributes, name) {
  const value = new RegExp(`\\b${name}="([^"]+)"`, 'i').exec(attributes)?.[1] || '';
  return /^(?:1|true|on)$/i.test(value);
}


export function workbookCalculation(xml) {
  const attributes = /<calcPr\b([^>]*)\/?>/i.exec(xml)?.[1] || '';
  return {
    mode: /\bcalcMode="([^"]+)"/i.exec(attributes)?.[1] || '',
    fullCalcOnLoad: booleanXmlAttribute(attributes, 'fullCalcOnLoad'),
    forceFullCalc: booleanXmlAttribute(attributes, 'forceFullCalc'),
  };
}


export function formulaReferences(formula, currentSheet) {
  const references = [];
  const seen = new Set();
  const pattern = /(?:(?:'([^']+)'|([A-Za-z0-9_ .-]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)/g;
  for (const match of String(formula || '').matchAll(pattern)) {
    const sheet = String(match[1] || match[2] || currentSheet);
    const ref = `${match[3]}${match[4]}`;
    const key = `${sheet}!${ref}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ sheet, ref, path: `/sheet[${sheet}]/cell[${ref}]` });
  }
  return references;
}


export function parseCellRef(ref) {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(String(ref || '').trim());
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: match[1].toUpperCase(), row: Number(match[2]), ref: `${match[1].toUpperCase()}${match[2]}` };
}


function cellXml(ref, value, formula = '', style = '') {
  const styled = style === '' ? '' : ` s="${style}"`;
  if (formula) {
    const normalized = String(formula).replace(/^=/, '');
    return `<c r="${ref}"${styled}><f>${xmlEncode(normalized)}</f><v></v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${styled}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}"${styled} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${styled} t="inlineStr"><is><t${/^\s|\s$/.test(String(value ?? '')) ? ' xml:space="preserve"' : ''}>${xmlEncode(value ?? '')}</t></is></c>`;
}


export function existingCellStyle(xml, ref) {
  const match = new RegExp(`<c\\b([^>]*\\br="${ref}"[^>]*?)(?:\\/>|>)`, 'i').exec(xml);
  return match ? (/\bs="(\d+)"/.exec(match[1])?.[1] || '') : '';
}


export function forceWorkbookRecalculation(xml) {
  if (/<calcPr\b/i.test(xml)) {
    return xml.replace(/<calcPr\b([^>]*)\/?>/i, (_match, sourceAttributes) => {
      let attributes = String(sourceAttributes || '').replace(/\/\s*$/, '');
      attributes = setXmlAttribute(attributes, 'calcMode', 'auto');
      attributes = setXmlAttribute(attributes, 'fullCalcOnLoad', '1');
      attributes = setXmlAttribute(attributes, 'forceFullCalc', '1');
      return `<calcPr${attributes}/>`;
    });
  }
  return xml.replace(/<\/workbook>/i, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
}


function setRowCell(rowXml, ref, column, cell) {
  const attrs = /^<row\b([^>]*?)(?:\/>|>)/.exec(rowXml)?.[1] || '';
  const body = containerBody(rowXml, 'row');
  const cells = elementSpans(body, 'c')
    .map((span) => ({ ...span, ref: (/\br="([A-Za-z]+\d+)"/.exec(span.attrs)?.[1] || '').toUpperCase() }))
    .filter((span) => span.ref);
  const existing = cells.find((span) => span.ref === ref);
  if (existing) {
    return `<row${attrs}>${body.slice(0, existing.start)}${cell}${body.slice(existing.end)}</row>`;
  }
  const following = cells.find((span) => columnNumber(parseCellRef(span.ref).col) > column);
  const position = following ? following.start : body.length;
  return `<row${attrs}>${body.slice(0, position)}${cell}${body.slice(position)}</row>`;
}


export function setCellInSheet(xml, ref, value, formula = '') {
  const parsed = parseCellRef(ref);
  return placeCellInSheet(xml, parsed.ref, cellXml(parsed.ref, value, formula, existingCellStyle(xml, parsed.ref)));
}


export function setCellStyleInSheet(xml, ref, styleIndex) {
  const parsed = parseCellRef(ref);
  const pattern = new RegExp(`<c\\b([^>]*\\br="${parsed.ref}"[^>]*?)(\\/>|>[\\s\\S]*?<\\/c>)`, 'i');
  const match = pattern.exec(xml);
  if (match) {
    const attrs = setXmlAttribute(match[1], 's', styleIndex);
    return `${xml.slice(0, match.index)}<c${attrs}${match[2]}${xml.slice(match.index + match[0].length)}`;
  }
  return placeCellInSheet(xml, parsed.ref, `<c r="${parsed.ref}" s="${styleIndex}"/>`);
}


function placeCellInSheet(xml, ref, cell) {
  const parsed = parseCellRef(ref);
  const column = columnNumber(parsed.col);
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  const inner = containerBody(sheetData[0], 'sheetData');
  const rows = elementSpans(inner, 'row')
    .map((span) => ({ ...span, index: Number(/\br="(\d+)"/.exec(span.attrs)?.[1] || 0) }));
  const existing = rows.find((row) => row.index === parsed.row);
  let nextInner;
  if (existing) {
    nextInner = `${inner.slice(0, existing.start)}${setRowCell(existing.xml, parsed.ref, column, cell)}${inner.slice(existing.end)}`;
  } else {
    const following = rows.find((row) => row.index > parsed.row);
    const position = following ? following.start : inner.length;
    nextInner = `${inner.slice(0, position)}<row r="${parsed.row}">${cell}</row>${inner.slice(position)}`;
  }
  return `${xml.slice(0, sheetData.index)}<sheetData>${nextInner}</sheetData>${xml.slice(sheetData.index + sheetData[0].length)}`;
}


export function columnNumber(label) {
  return [...label.toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}


export function columnLabel(number) {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}


export function expandRange(range) {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(String(range || '').trim());
  if (!match) throw new Error(`Invalid range: ${range}`);
  return {
    startCol: columnNumber(match[1]),
    startRow: Number(match[2]),
    endCol: columnNumber(match[3]),
    endRow: Number(match[4]),
  };
}
