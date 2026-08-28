import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const OOXML_REQUIRED = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
};

function xmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEncode(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tagPattern(tag) {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textNodes(xml, tag) {
  const regex = new RegExp(`<${tagPattern(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${tagPattern(tag)}>`, 'g');
  const nodes = [];
  let match;
  while ((match = regex.exec(xml))) {
    nodes.push({
      start: match.index,
      end: regex.lastIndex,
      attrs: match[1] || '',
      text: xmlDecode(match[2]),
    });
  }
  return nodes;
}

function rebuildTextNodes(xml, tag, nodes) {
  let cursor = 0;
  const chunks = [];
  for (const node of nodes) {
    chunks.push(xml.slice(cursor, node.start));
    let attrs = node.attrs;
    if (/^\s|\s$/.test(node.text) && !/\bxml:space=/.test(attrs)) attrs += ' xml:space="preserve"';
    chunks.push(`<${tag}${attrs}>${xmlEncode(node.text)}</${tag}>`);
    cursor = node.end;
  }
  chunks.push(xml.slice(cursor));
  return chunks.join('');
}

function nodeAtOffset(nodes, offset, usePreviousAtBoundary = false) {
  let current = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const next = current + nodes[index].text.length;
    if (offset < next || (usePreviousAtBoundary && offset === next && next > current)) {
      return { index, offset: Math.max(0, offset - current) };
    }
    current = next;
  }
  return nodes.length ? { index: nodes.length - 1, offset: nodes.at(-1).text.length } : null;
}

export function replaceAcrossRuns(xml, tag, find, replacement) {
  if (!find) throw new Error('replace_text requires non-empty find');
  const nodes = textNodes(xml, tag);
  if (!nodes.length) return { xml, count: 0 };
  const joined = nodes.map((node) => node.text).join('');
  const occurrences = [];
  let cursor = 0;
  while (cursor <= joined.length - find.length) {
    const index = joined.indexOf(find, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + Math.max(1, find.length);
  }
  for (let occurrence = occurrences.length - 1; occurrence >= 0; occurrence -= 1) {
    const start = nodeAtOffset(nodes, occurrences[occurrence]);
    const end = nodeAtOffset(nodes, occurrences[occurrence] + find.length, true);
    if (!start || !end) continue;
    if (start.index === end.index) {
      const source = nodes[start.index].text;
      nodes[start.index].text = `${source.slice(0, start.offset)}${replacement}${source.slice(end.offset)}`;
      continue;
    }
    const first = nodes[start.index];
    const last = nodes[end.index];
    first.text = `${first.text.slice(0, start.offset)}${replacement}`;
    for (let index = start.index + 1; index < end.index; index += 1) nodes[index].text = '';
    last.text = last.text.slice(end.offset);
  }
  return { xml: rebuildTextNodes(xml, tag, nodes), count: occurrences.length };
}

function templateTokenMatches(text) {
  return [...String(text || '').matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)]
    .map((match) => ({ raw: match[0], key: match[1] }));
}

async function fillTemplateParts(zip, parts, tag, operation) {
  const tokens = operation.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('fill_template requires tokens as an object');
  }
  const filled = {};
  for (const part of parts) {
    let xml = await zipText(zip, part);
    const variants = new Map(templateTokenMatches(paragraphTexts(xml, tag).join('')).map((match) => [match.raw, match.key]));
    let changed = false;
    for (const [raw, key] of variants) {
      if (!Object.hasOwn(tokens, key)) continue;
      const replaced = replaceAcrossRuns(xml, tag, raw, String(tokens[key] ?? ''));
      if (!replaced.count) continue;
      xml = replaced.xml;
      changed = true;
      filled[key] = (filled[key] || 0) + replaced.count;
    }
    if (changed) zip.file(part, xml);
  }
  const remaining = new Set();
  for (const part of parts) {
    const xml = await zipText(zip, part);
    for (const match of templateTokenMatches(paragraphTexts(xml, tag).join(''))) remaining.add(match.key);
  }
  const unfilledTokens = [...remaining].sort();
  if (operation.strict && unfilledTokens.length) {
    throw new Error(`Unfilled template tokens: ${unfilledTokens.join(', ')}`);
  }
  return {
    op: 'fill_template',
    changed: Object.keys(filled).length > 0,
    filled,
    unfilledTokens,
    strict: operation.strict === true,
  };
}

async function loadPackage(path) {
  return await JSZip.loadAsync(await readFile(path), {
    checkCRC32: true,
    createFolders: false,
  });
}

async function zipText(zip, path) {
  const file = zip.file(path);
  return file ? await file.async('string') : '';
}

async function savePackage(zip, path) {
  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
  await writeFile(path, data);
}

function paragraphTexts(xml, tag) {
  return textNodes(xml, tag).map((node) => node.text).filter(Boolean);
}

function topLevelElements(fragment, acceptedTags) {
  const accepted = new Set(acceptedTags);
  const elements = [];
  const stack = [];
  let tracked = null;
  const regex = /<([/]?)([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?([/]?)>/g;
  let match;
  while ((match = regex.exec(fragment))) {
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosing = match[3] === '/';
    if (closing) {
      const opened = stack.pop();
      if (tracked && stack.length === 0 && opened === tracked.name) {
        elements.push({
          name: tracked.name,
          start: tracked.start,
          end: regex.lastIndex,
          xml: fragment.slice(tracked.start, regex.lastIndex),
        });
        tracked = null;
      }
      continue;
    }
    if (stack.length === 0 && accepted.has(name)) {
      if (selfClosing) {
        elements.push({ name, start: match.index, end: regex.lastIndex, xml: match[0] });
      } else {
        tracked = { name, start: match.index };
      }
    }
    if (!selfClosing) stack.push(name);
  }
  return elements;
}

function containerInner(xml, tag) {
  const open = new RegExp(`<${tagPattern(tag)}(?:\\s[^>]*)?>`).exec(xml);
  const close = new RegExp(`</${tagPattern(tag)}>`).exec(xml);
  if (!open || !close || close.index < open.index) return null;
  const start = open.index + open[0].length;
  return { start, end: close.index, inner: xml.slice(start, close.index) };
}

function docxBodyModel(documentXml) {
  const body = containerInner(documentXml, 'w:body');
  if (!body) return { paragraphs: [], tables: [], blocks: [] };
  const blocks = topLevelElements(body.inner, ['w:p', 'w:tbl']);
  let paragraphIndex = 0;
  let tableIndex = 0;
  const paragraphs = [];
  const tables = [];
  for (const block of blocks) {
    if (block.name === 'w:p') {
      paragraphIndex += 1;
      const runs = textNodes(block.xml, 'w:t').map((node, index) => ({
        path: `/body/p[${paragraphIndex}]/run[${index + 1}]`,
        index: index + 1,
        text: node.text,
      }));
      paragraphs.push({
        path: `/body/p[${paragraphIndex}]`,
        index: paragraphIndex,
        text: runs.map((run) => run.text).join(''),
        style: xmlDecode(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || ''),
        runs,
      });
      block.logicalIndex = paragraphIndex;
    } else {
      tableIndex += 1;
      const tableInner = containerInner(block.xml, 'w:tbl')?.inner || '';
      const rows = topLevelElements(tableInner, ['w:tr']).map((row, rowIndex) => ({
        path: `/body/tbl[${tableIndex}]/row[${rowIndex + 1}]`,
        index: rowIndex + 1,
        cells: topLevelElements(containerInner(row.xml, 'w:tr')?.inner || '', ['w:tc']).map((cell, cellIndex) => ({
          path: `/body/tbl[${tableIndex}]/row[${rowIndex + 1}]/cell[${cellIndex + 1}]`,
          index: cellIndex + 1,
          text: paragraphTexts(cell.xml, 'w:t').join(''),
        })),
      }));
      tables.push({ path: `/body/tbl[${tableIndex}]`, index: tableIndex, rows });
      block.logicalIndex = tableIndex;
    }
  }
  return { paragraphs, tables, blocks, body };
}

async function snapshotDocx(zip, options = {}) {
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort();
  const content = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    content.push({ part, text: paragraphTexts(xml, 'w:t').join('') });
  }
  const documentXml = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(documentXml);
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 200) : model.blocks.length;
  let selectedBlocks = model.blocks;
  if (paged && options.target) {
    const paragraph = /^\/body\/p\[(\d+)]/.exec(String(options.target));
    const table = /^\/body\/tbl\[(\d+)]/.exec(String(options.target));
    selectedBlocks = paragraph
      ? model.blocks.filter((block) => block.name === 'w:p' && block.logicalIndex === Number(paragraph[1]))
      : table
        ? model.blocks.filter((block) => block.name === 'w:tbl' && block.logicalIndex === Number(table[1]))
        : model.blocks.slice(offset, offset + limit);
  } else if (paged) {
    selectedBlocks = model.blocks.slice(offset, offset + limit);
  }
  const paragraphIndexes = new Set(selectedBlocks.filter((block) => block.name === 'w:p').map((block) => block.logicalIndex));
  const tableIndexes = new Set(selectedBlocks.filter((block) => block.name === 'w:tbl').map((block) => block.logicalIndex));
  const storyParts = parts.filter((name) => !/\/comments\.xml$/i.test(name));
  const comments = [];
  const commentsXml = await zipText(zip, 'word/comments.xml');
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attributes = match[1];
    const id = xmlDecode(/\bw:id="([^"]+)"/.exec(attributes)?.[1] || '');
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let anchoredText = '';
    let anchoredPart = '';
    for (const part of storyParts) {
      const xml = await zipText(zip, part);
      const start = new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
      const end = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
      if (!start || !end || end.index < start.index) continue;
      anchoredText = paragraphTexts(xml.slice(start.index + start[0].length, end.index), 'w:t').join('');
      anchoredPart = part;
      break;
    }
    comments.push({
      path: `/body/comment[${comments.length + 1}]`,
      index: comments.length + 1,
      id,
      author: xmlDecode(/\bw:author="([^"]*)"/.exec(attributes)?.[1] || ''),
      initials: xmlDecode(/\bw:initials="([^"]*)"/.exec(attributes)?.[1] || ''),
      date: xmlDecode(/\bw:date="([^"]*)"/.exec(attributes)?.[1] || ''),
      text: paragraphTexts(match[2], 'w:t').join(''),
      anchoredText,
      part: anchoredPart,
    });
  }
  const revisions = [];
  for (const part of storyParts) {
    const xml = await zipText(zip, part);
    for (const match of xml.matchAll(/<w:(ins|del)\b([^>]*)>([\s\S]*?)<\/w:\1>/g)) {
      const kind = match[1];
      const attributes = match[2];
      revisions.push({
        path: `/body/revision[${revisions.length + 1}]`,
        index: revisions.length + 1,
        id: xmlDecode(/\bw:id="([^"]+)"/.exec(attributes)?.[1] || ''),
        author: xmlDecode(/\bw:author="([^"]*)"/.exec(attributes)?.[1] || ''),
        date: xmlDecode(/\bw:date="([^"]*)"/.exec(attributes)?.[1] || ''),
        type: kind === 'ins' ? 'insertion' : 'deletion',
        text: paragraphTexts(match[3], kind === 'ins' ? 'w:t' : 'w:delText').join(''),
        part,
      });
    }
  }
  const notes = [];
  for (const [kind, part, tag] of [
    ['footnote', 'word/footnotes.xml', 'w:footnote'],
    ['endnote', 'word/endnotes.xml', 'w:endnote'],
  ]) {
    const xml = await zipText(zip, part);
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const match of xml.matchAll(pattern)) {
      const id = xmlDecode(/\bw:id="([^"]+)"/.exec(match[1])?.[1] || '');
      if (Number(id) < 0) continue;
      notes.push({
        path: `/body/${kind}[${notes.filter((entry) => entry.kind === kind).length + 1}]`,
        kind,
        id,
        text: paragraphTexts(match[2], 'w:t').join(''),
        part,
      });
    }
  }
  const contentControls = [];
  for (const part of storyParts) {
    const xml = await zipText(zip, part);
    for (const match of xml.matchAll(/<w:sdt\b[^>]*>([\s\S]*?)<\/w:sdt>/g)) {
      const properties = /<w:sdtPr\b[^>]*>([\s\S]*?)<\/w:sdtPr>/.exec(match[1])?.[1] || '';
      contentControls.push({
        path: `/body/content-control[${contentControls.length + 1}]`,
        index: contentControls.length + 1,
        tag: xmlDecode(/<w:tag\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        title: xmlDecode(/<w:alias\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        lock: xmlDecode(/<w:lock\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        text: paragraphTexts(match[1], 'w:t').join(''),
        part,
      });
    }
  }
  const commentThreads = [];
  const commentsExtended = await zipText(zip, 'word/commentsExtended.xml');
  for (const match of commentsExtended.matchAll(/<w15:commentEx\b([^>]*?)\/?>/g)) {
    commentThreads.push({
      path: `/body/comment-thread[${commentThreads.length + 1}]`,
      index: commentThreads.length + 1,
      paraId: xmlDecode(/\bw15:paraId="([^"]*)"/.exec(match[1])?.[1] || ''),
      parentParaId: xmlDecode(/\bw15:paraIdParent="([^"]*)"/.exec(match[1])?.[1] || ''),
      resolved: /^(?:1|true)$/i.test(/\bw15:done="([^"]*)"/.exec(match[1])?.[1] || ''),
    });
  }
  return {
    format: 'docx',
    path: '/',
    paragraphCount: model.paragraphs.length,
    tableCount: model.tables.length,
    paragraphs: paged ? model.paragraphs.filter((paragraph) => paragraphIndexes.has(paragraph.index)) : model.paragraphs,
    tables: paged ? model.tables.filter((table) => tableIndexes.has(table.index)) : model.tables,
    blockOrder: selectedBlocks.map((block) => ({
      type: block.name === 'w:p' ? 'paragraph' : 'table',
      index: block.logicalIndex,
      path: block.name === 'w:p'
        ? `/body/p[${block.logicalIndex}]`
        : `/body/tbl[${block.logicalIndex}]`,
      start: block.start,
    })),
    parts: paged && model.blocks.length > limit
      ? content.map((part) => ({ part: part.part, chars: part.text.length }))
      : content,
    commentCount: comments.length,
    revisionCount: revisions.length,
    comments,
    revisions,
    footnoteCount: notes.filter((entry) => entry.kind === 'footnote').length,
    endnoteCount: notes.filter((entry) => entry.kind === 'endnote').length,
    footnotes: notes.filter((entry) => entry.kind === 'footnote'),
    endnotes: notes.filter((entry) => entry.kind === 'endnote'),
    contentControlCount: contentControls.length,
    contentControls,
    commentThreadCount: commentThreads.length,
    commentThreads,
    ...(paged ? {
      pagination: {
        unit: 'body-block',
        offset,
        limit,
        returned: selectedBlocks.length,
        total: model.blocks.length,
        nextOffset: offset + selectedBlocks.length < model.blocks.length
          ? offset + selectedBlocks.length
          : null,
      },
    } : {}),
  };
}

function relationshipMap(xml) {
  const map = new Map();
  const regex = /<Relationship\b([^>]+?)\/?>/g;
  let match;
  while ((match = regex.exec(xml))) {
    const attrs = match[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

async function workbookSheets(zip) {
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

async function sharedStrings(zip) {
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

function cellRecords(xml, strings, options = null) {
  const records = [];
  const paged = options?.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 2_000) : Number.POSITIVE_INFINITY;
  const bounds = paged && options.range ? snapshotRangeBounds(options.range) : null;
  let total = 0;
  let formulaCount = 0;
  let formulaCacheMissing = 0;
  const regex = /<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)\/>/g;
  let match;
  while ((match = regex.exec(xml))) {
    const attrs = match[1] || match[4] || '';
    const ref = match[2] || match[5];
    if (bounds) {
      const parsed = parseCellRef(ref);
      const column = columnNumber(parsed.col);
      if (parsed.row < bounds.startRow || parsed.row > bounds.endRow || column < bounds.startCol || column > bounds.endCol) continue;
    }
    const body = match[3] || '';
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

function booleanXmlAttribute(attributes, name) {
  const value = new RegExp(`\\b${name}="([^"]+)"`, 'i').exec(attributes)?.[1] || '';
  return /^(?:1|true|on)$/i.test(value);
}

function workbookCalculation(xml) {
  const attributes = /<calcPr\b([^>]*)\/?>/i.exec(xml)?.[1] || '';
  return {
    mode: /\bcalcMode="([^"]+)"/i.exec(attributes)?.[1] || '',
    fullCalcOnLoad: booleanXmlAttribute(attributes, 'fullCalcOnLoad'),
    forceFullCalc: booleanXmlAttribute(attributes, 'forceFullCalc'),
  };
}

function formulaReferences(formula, currentSheet) {
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

async function snapshotXlsx(zip, options = {}) {
  const sheets = await workbookSheets(zip);
  const strings = await sharedStrings(zip);
  const workbookXml = await zipText(zip, 'xl/workbook.xml');
  const calculation = workbookCalculation(workbookXml);
  const definedNames = [];
  for (const match of workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const attributes = match[1];
    definedNames.push({
      path: `/defined-name[${definedNames.length + 1}]`,
      index: definedNames.length + 1,
      name: xmlDecode(/\bname="([^"]+)"/.exec(attributes)?.[1] || ''),
      localSheetId: Number(/\blocalSheetId="(\d+)"/.exec(attributes)?.[1] ?? -1),
      hidden: booleanXmlAttribute(attributes, 'hidden'),
      refersTo: xmlDecode(match[2]),
    });
  }
  const output = [];
  let formulaCount = 0;
  let formulaCacheMissing = 0;
  const paged = options.paged === true;
  const selectedSheets = paged
    ? [options.sheet
        ? sheets.find((sheet) => sheet.name.toLowerCase() === String(options.sheet).toLowerCase())
        : sheets[0]].filter(Boolean)
    : sheets;
  if (paged && options.sheet && !selectedSheets.length) throw new Error(`XLSX sheet not found: ${options.sheet}`);
  let page = null;
  for (const sheet of selectedSheets) {
    const xml = await zipText(zip, sheet.path);
    const cellResult = cellRecords(xml, strings, paged ? options : null);
    const cells = paged ? cellResult.records : cellResult;
    const validations = [];
    for (const match of xml.matchAll(/<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
      const attributes = match[1];
      const body = match[2] || '';
      validations.push({
        path: `/sheet[${sheet.name}]/validation[${validations.length + 1}]`,
        index: validations.length + 1,
        ranges: xmlDecode(/\bsqref="([^"]+)"/.exec(attributes)?.[1] || '').split(/\s+/).filter(Boolean),
        type: /\btype="([^"]+)"/.exec(attributes)?.[1] || '',
        operator: /\boperator="([^"]+)"/.exec(attributes)?.[1] || '',
        allowBlank: booleanXmlAttribute(attributes, 'allowBlank'),
        showInputMessage: booleanXmlAttribute(attributes, 'showInputMessage'),
        showErrorMessage: booleanXmlAttribute(attributes, 'showErrorMessage'),
        formula1: xmlDecode(/<formula1(?:\s[^>]*)?>([\s\S]*?)<\/formula1>/.exec(body)?.[1] || ''),
        formula2: xmlDecode(/<formula2(?:\s[^>]*)?>([\s\S]*?)<\/formula2>/.exec(body)?.[1] || ''),
      });
    }
    const conditionalFormats = [];
    for (const match of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
      const ranges = xmlDecode(/\bsqref="([^"]+)"/.exec(match[1])?.[1] || '').split(/\s+/).filter(Boolean);
      for (const rule of match[2].matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
        const attributes = rule[1];
        const body = rule[2] || '';
        conditionalFormats.push({
          path: `/sheet[${sheet.name}]/conditional-format[${conditionalFormats.length + 1}]`,
          index: conditionalFormats.length + 1,
          ranges,
          type: xmlDecode(/\btype="([^"]+)"/.exec(attributes)?.[1] || ''),
          operator: xmlDecode(/\boperator="([^"]+)"/.exec(attributes)?.[1] || ''),
          priority: Number(/\bpriority="(\d+)"/.exec(attributes)?.[1] || 0),
          formulas: [...body.matchAll(/<formula(?:\s[^>]*)?>([\s\S]*?)<\/formula>/g)].map((entry) => xmlDecode(entry[1])),
        });
      }
    }
    const lineage = cells.filter((cell) => cell.formula).map((cell) => ({
      path: `/sheet[${sheet.name}]/cell[${cell.ref}]/lineage`,
      from: `/sheet[${sheet.name}]/cell[${cell.ref}]`,
      formula: cell.formula,
      precedents: formulaReferences(cell.formula, sheet.name),
    }));
    formulaCount += paged ? cellResult.formulaCount : cells.filter((cell) => cell.formula).length;
    formulaCacheMissing += paged ? cellResult.formulaCacheMissing : cells.filter((cell) => cell.formula && cell.cacheState === 'missing').length;
    if (paged) page = cellResult;
    output.push({
      path: `/sheet[${sheet.name}]`,
      name: sheet.name,
      cellCount: paged ? cellResult.total : cells.length,
      cells: (paged ? cells : cells.slice(0, 2000)).map((cell) => ({
        path: `/sheet[${sheet.name}]/cell[${cell.ref}]`,
        ...cell,
      })),
      truncated: paged ? cellResult.total > cells.length : cells.length > 2000,
      validationCount: validations.length,
      validations,
      conditionalFormatCount: conditionalFormats.length,
      conditionalFormats,
      lineageCount: lineage.length,
      formulaLineage: lineage,
    });
  }
  return {
    format: 'xlsx',
    sheetCount: sheets.length,
    sheets: output,
    formulaCount,
    formulaCacheMissing,
    needsRecalculation: formulaCacheMissing > 0,
    calculation,
    definedNameCount: definedNames.length,
    definedNames,
    ...(paged ? {
      pagination: {
        unit: 'populated-cell',
        scope: `${selectedSheets[0]?.name || ''}${options.range ? `!${options.range}` : ''}`,
        offset: Math.max(0, Number(options.offset) || 0),
        limit: Math.max(1, Number(options.limit) || 2_000),
        returned: page?.records.length || 0,
        total: page?.total || 0,
        nextOffset: page && (Math.max(0, Number(options.offset) || 0) + page.records.length < page.total)
          ? Math.max(0, Number(options.offset) || 0) + page.records.length
          : null,
      },
    } : {}),
  };
}

async function snapshotPptx(zip, options = {}) {
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(basename(a))?.[0]) - Number(/\d+/.exec(basename(b))?.[0]));
  slidePaths.reverse();
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 20) : slidePaths.length;
  const requested = paged && Array.isArray(options.pages) && options.pages.length
    ? options.pages.map((page) => slidePaths.find((path) => Number(/slide(\d+)\.xml$/.exec(path)?.[1]) === Number(page))).filter(Boolean)
    : paged
      ? slidePaths.slice(offset, offset + limit)
      : slidePaths;
  const slides = [];
  for (const path of requested) {
    const xml = await zipText(zip, path);
    const index = Number(/slide(\d+)\.xml$/.exec(path)?.[1]);
    const tree = containerInner(xml, 'p:spTree');
    const shapeBlocks = tree ? topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']) : [];
    slides.push({
      path: `/slide[${index}]`,
      index,
      text: paragraphTexts(xml, 'a:t'),
      shapes: shapeBlocks.map((shape, shapeIndex) => {
        const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i.exec(shape.xml);
        const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(shape.xml);
        return {
          path: `/slide[${index}]/shape[${shapeIndex + 1}]`,
          index: shapeIndex + 1,
          type: shape.name,
          text: paragraphTexts(shape.xml, 'a:t').join(''),
          ...(offset && extent ? {
            left: Number(offset[1]) / 12_700,
            top: Number(offset[2]) / 12_700,
            width: Number(extent[1]) / 12_700,
            height: Number(extent[2]) / 12_700,
          } : {}),
        };
      }),
    });
  }
  const layoutPaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(basename(a))?.[0]) - Number(/\d+/.exec(basename(b))?.[0]));
  const layouts = [];
  for (const path of layoutPaths) {
    const xml = await zipText(zip, path);
    layouts.push({
      path: `/layout[${layouts.length + 1}]`,
      index: layouts.length + 1,
      name: xmlDecode(/<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
      packagePart: path,
    });
  }
  const presentationXml = await zipText(zip, 'ppt/presentation.xml');
  const slideSize = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(presentationXml);
  return {
    format: 'pptx',
    slideCount: slidePaths.length,
    slideWidth: slideSize ? Number(slideSize[1]) / 12_700 : 0,
    slideHeight: slideSize ? Number(slideSize[2]) / 12_700 : 0,
    slides,
    layoutCount: layouts.length,
    layouts,
    ...(paged ? {
      pagination: {
        unit: 'slide',
        offset,
        limit,
        returned: slides.length,
        total: Array.isArray(options.pages) && options.pages.length ? requested.length : slidePaths.length,
        nextOffset: !options.pages?.length && offset + slides.length < slidePaths.length
          ? offset + slides.length
          : null,
      },
    } : {}),
  };
}

export async function snapshotPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  if (format === 'docx') return await snapshotDocx(zip, options);
  if (format === 'xlsx') return await snapshotXlsx(zip, options);
  if (format === 'pptx') return await snapshotPptx(zip, options);
  throw new Error(`Unsupported OOXML format: ${format}`);
}

function parseCellRef(ref) {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(String(ref || '').trim());
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: match[1].toUpperCase(), row: Number(match[2]), ref: `${match[1].toUpperCase()}${match[2]}` };
}

function cellXml(ref, value, formula = '') {
  if (formula) {
    const normalized = String(formula).replace(/^=/, '');
    return `<c r="${ref}"><f>${xmlEncode(normalized)}</f><v></v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t${/^\s|\s$/.test(String(value ?? '')) ? ' xml:space="preserve"' : ''}>${xmlEncode(value ?? '')}</t></is></c>`;
}

function setXmlAttribute(attributes, name, value) {
  const pattern = new RegExp(`\\b${name}="[^"]*"`, 'i');
  return pattern.test(attributes)
    ? attributes.replace(pattern, `${name}="${value}"`)
    : `${attributes} ${name}="${value}"`;
}

function forceWorkbookRecalculation(xml) {
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

function setCellInSheet(xml, ref, value, formula = '') {
  const parsed = parseCellRef(ref);
  const rowRegex = new RegExp(`<row\\b([^>]*\\br="${parsed.row}"[^>]*)>([\\s\\S]*?)</row>`);
  const rowMatch = rowRegex.exec(xml);
  const nextCell = cellXml(parsed.ref, value, formula);
  if (rowMatch) {
    const rowBody = rowMatch[2];
    const cellRegex = new RegExp(`<c\\b[^>]*\\br="${parsed.ref}"[^>]*(?:>[\\s\\S]*?</c>|/>)`, 'i');
    const nextBody = cellRegex.test(rowBody)
      ? rowBody.replace(cellRegex, nextCell)
      : `${rowBody}${nextCell}`;
    return xml.replace(rowRegex, `<row${rowMatch[1]}>${nextBody}</row>`);
  }
  const sheetDataRegex = /<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/;
  const dataMatch = sheetDataRegex.exec(xml);
  if (!dataMatch) throw new Error('Worksheet is missing sheetData');
  const row = `<row r="${parsed.row}">${nextCell}</row>`;
  return xml.replace(sheetDataRegex, `<sheetData>${dataMatch[1]}${row}</sheetData>`);
}

function columnNumber(label) {
  return [...label.toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}

function columnLabel(number) {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function expandRange(range) {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(String(range || '').trim());
  if (!match) throw new Error(`Invalid range: ${range}`);
  return {
    startCol: columnNumber(match[1]),
    startRow: Number(match[2]),
    endCol: columnNumber(match[3]),
    endRow: Number(match[4]),
  };
}

function wordTableProperties(properties = {}) {
  const borders = properties.borders || {};
  const borderXml = Object.keys(borders).length
    ? `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => {
        const value = typeof borders[side] === 'object' ? borders[side] : borders;
        if (!value || value.enabled === false) return '';
        return `<w:${side} w:val="${xmlEncode(value.style || 'single')}" w:sz="${Math.max(1, Number(value.size) || 4)}" w:space="${Math.max(0, Number(value.space) || 0)}" w:color="${xmlEncode(String(value.color || 'auto').replace(/^#/, ''))}"/>`;
      }).join('')}</w:tblBorders>`
    : '';
  return [
    properties.style ? `<w:tblStyle w:val="${xmlEncode(properties.style)}"/>` : '',
    `<w:tblW w:w="0" w:type="auto"/>`,
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
    properties.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>` : '',
    borderXml,
  ].join('');
}

function wordCellProperties(properties = {}) {
  return [
    properties.width ? `<w:tcW w:w="${Math.max(1, Math.round(Number(properties.width)))}" w:type="dxa"/>` : '',
    properties.fillColor ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.fillColor).replace(/^#/, ''))}"/>` : '',
    properties.verticalAlignment ? `<w:vAlign w:val="${xmlEncode(properties.verticalAlignment)}"/>` : '',
  ].join('');
}

function wordTableXml(operation) {
  const values = Array.isArray(operation.values) ? operation.values : [];
  const rows = Math.max(1, Number(operation.rows) || values.length || 1);
  const columns = Math.max(1, Number(operation.columns) || Math.max(0, ...values.map((row) => row.length)) || 1);
  const widths = operation.properties?.columnWidths || [];
  const grid = Array.from({ length: columns }, (_, column) => `<w:gridCol${widths[column] ? ` w:w="${Math.max(1, Math.round(Number(widths[column])))}"` : ''}/>`).join('');
  const body = Array.from({ length: rows }, (_, row) => `<w:tr>${Array.from({ length: columns }, (_, column) => {
    const text = String(values[row]?.[column] ?? '');
    const width = widths[column] ? `<w:tcW w:w="${Math.max(1, Math.round(Number(widths[column])))}" w:type="dxa"/>` : '';
    return `<w:tc>${width ? `<w:tcPr>${width}</w:tcPr>` : ''}<w:p><w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr>${wordTableProperties(operation.properties)}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

function docxTable(current, number) {
  const match = [...current.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)][Number(number) - 1];
  if (!match) throw new Error(`DOCX table ${number} not found`);
  return match;
}

function replaceDocxTable(current, table, nextTable) {
  return `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
}

function replaceWordProperties(xml, owner, propertyTag, value) {
  const pattern = new RegExp(`<w:${propertyTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:${propertyTag}>`);
  if (pattern.test(xml)) return xml.replace(pattern, `<w:${propertyTag}>${value}</w:${propertyTag}>`);
  return xml.replace(new RegExp(`<w:${owner}(?:\\s[^>]*)?>`), (open) => `${open}<w:${propertyTag}>${value}</w:${propertyTag}>`);
}

function paragraphFormatXml(properties = {}) {
  const border = properties.border || null;
  const tabs = Array.isArray(properties.tabStops) ? properties.tabStops : [];
  return [
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
    (properties.spacingBefore !== undefined || properties.spacingAfter !== undefined || properties.lineSpacing !== undefined)
      ? `<w:spacing${properties.spacingBefore !== undefined ? ` w:before="${Math.round(Number(properties.spacingBefore))}"` : ''}${properties.spacingAfter !== undefined ? ` w:after="${Math.round(Number(properties.spacingAfter))}"` : ''}${properties.lineSpacing !== undefined ? ` w:line="${Math.round(Number(properties.lineSpacing))}" w:lineRule="auto"` : ''}/>`
      : '',
    properties.keepWithNext === true ? '<w:keepNext/>' : '',
    properties.pageBreakBefore === true ? '<w:pageBreakBefore/>' : '',
    border ? `<w:pBdr><w:${xmlEncode(border.side || 'bottom')} w:val="${xmlEncode(border.style || 'single')}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${Math.max(0, Number(border.space) || 1)}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>` : '',
    tabs.length ? `<w:tabs>${tabs.map((tab) => `<w:tab w:val="${xmlEncode(tab.alignment || 'left')}" w:pos="${Math.round(Number(tab.position) || 0)}"${tab.leader ? ` w:leader="${xmlEncode(tab.leader)}"` : ''}/>`).join('')}</w:tabs>` : '',
  ].join('');
}

async function applyDocx(zip, operations) {
  const parts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name));
  const results = [];
  for (const op of operations) {
    if (op.op === 'fill_template') {
      results.push(await fillTemplateParts(zip, parts, 'w:t', op));
      continue;
    }
    if (op.op === 'replace_text') {
      let count = 0;
      for (const part of parts) {
        const current = await zipText(zip, part);
        const replaced = replaceAcrossRuns(current, 'w:t', String(op.find || ''), String(op.replace ?? ''));
        if (replaced.count) zip.file(part, replaced.xml);
        count += replaced.count;
      }
      results.push({ op: op.op, changed: count > 0, count });
      continue;
    }
    if (op.op === 'append_text') {
      const current = await zipText(zip, 'word/document.xml');
      const style = op.style || op.properties?.style;
      const paragraphProperties = style ? `<w:pPr><w:pStyle w:val="${xmlEncode(style)}"/></w:pPr>` : '';
      const font = op.properties || {};
      const runProperties = [
        font.name ? `<w:rFonts w:ascii="${xmlEncode(font.name)}" w:hAnsi="${xmlEncode(font.name)}" w:eastAsia="${xmlEncode(font.name)}"/>` : '',
        font.size ? `<w:sz w:val="${Math.max(2, Math.round(Number(font.size) * 2))}"/>` : '',
        font.bold === true ? '<w:b/>' : '',
        font.italic === true ? '<w:i/>' : '',
        font.color ? `<w:color w:val="${xmlEncode(String(font.color).replace(/^#/, ''))}"/>` : '',
      ].join('');
      const block = `<w:p>${paragraphProperties}<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}<w:t${/^\s|\s$/.test(String(op.text || '')) ? ' xml:space="preserve"' : ''}>${xmlEncode(op.text || '')}</w:t></w:r></w:p>`;
      if (!/<\/w:body>/.test(current)) throw new Error('DOCX document body is missing');
      zip.file('word/document.xml', current.replace('</w:body>', `${block}</w:body>`));
      results.push({ op: op.op, changed: true, style: style || '' });
      continue;
    }
    if (op.op === 'add_table') {
      let current = await zipText(zip, 'word/document.xml');
      const table = wordTableXml(op);
      if (op.paragraph) {
        const model = docxBodyModel(current);
        const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
        if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
        const position = paragraph.end;
        const nextInner = `${model.body.inner.slice(0, position)}${table}${model.body.inner.slice(position)}`;
        current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      } else if (/<w:sectPr(?:\s[^>]*)?>/.test(current)) {
        current = current.replace(/<w:sectPr(?:\s[^>]*)?>/, `${table}$&`);
      } else {
        current = current.replace('</w:body>', `${table}</w:body>`);
      }
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, table: docxBodyModel(current).blocks.filter((block) => block.name === 'w:tbl').length });
      continue;
    }
    if (op.op === 'set_paragraph_text' || op.op === 'set_run_text' || op.op === 'remove_paragraph' || op.op === 'move_paragraph') {
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      let nextInner = model.body.inner;
      if (op.op === 'remove_paragraph') {
        nextInner = `${nextInner.slice(0, paragraph.start)}${nextInner.slice(paragraph.end)}`;
      } else if (op.op === 'move_paragraph') {
        const destination = Math.max(1, Number(op.index));
        const remaining = model.blocks.filter((block) => block !== paragraph);
        const paragraphBlocks = remaining.filter((block) => block.name === 'w:p');
        const anchor = paragraphBlocks[destination - 1];
        const without = `${nextInner.slice(0, paragraph.start)}${nextInner.slice(paragraph.end)}`;
        if (!anchor) {
          nextInner = `${without}${paragraph.xml}`;
        } else {
          const adjustedStart = anchor.start > paragraph.start ? anchor.start - paragraph.xml.length : anchor.start;
          nextInner = `${without.slice(0, adjustedStart)}${paragraph.xml}${without.slice(adjustedStart)}`;
        }
      } else {
        const nodes = textNodes(paragraph.xml, 'w:t');
        let nextParagraph;
        if (!nodes.length) {
          if (op.op === 'set_run_text') throw new Error(`DOCX paragraph ${op.paragraph} has no editable text`);
          const run = `<w:r><w:t xml:space="preserve">${xmlEncode(String(op.text ?? ''))}</w:t></w:r>`;
          if (/<\/w:p>\s*$/.test(paragraph.xml)) {
            nextParagraph = paragraph.xml.replace(/<\/w:p>\s*$/, `${run}</w:p>`);
          } else if (/\/>\s*$/.test(paragraph.xml)) {
            nextParagraph = paragraph.xml.replace(/\/>\s*$/, `>${run}</w:p>`);
          } else {
            throw new Error(`DOCX paragraph ${op.paragraph} is malformed`);
          }
        } else if (op.op === 'set_run_text') {
          const run = nodes[Number(op.run) - 1];
          if (!run) throw new Error(`DOCX run ${op.run} not found in paragraph ${op.paragraph}`);
          run.text = String(op.text ?? '');
          nextParagraph = rebuildTextNodes(paragraph.xml, 'w:t', nodes);
        } else {
          nodes[0].text = String(op.text ?? '');
          for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
          nextParagraph = rebuildTextNodes(paragraph.xml, 'w:t', nodes);
        }
        nextInner = `${nextInner.slice(0, paragraph.start)}${nextParagraph}${nextInner.slice(paragraph.end)}`;
      }
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true });
      continue;
    }
    if (op.op === 'set_paragraph_style') {
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const style = xmlEncode(op.style || 'Normal');
      let nextParagraph = paragraph.xml;
      if (/<w:pPr(?:\s[^>]*)?>/.test(nextParagraph)) {
        if (/<w:pStyle\b[^>]*\/>/.test(nextParagraph)) {
          nextParagraph = nextParagraph.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${style}"/>`);
        } else {
          nextParagraph = nextParagraph.replace(/<w:pPr(?:\s[^>]*)?>/, (open) => `${open}<w:pStyle w:val="${style}"/>`);
        }
      } else {
        nextParagraph = nextParagraph.replace(/<w:p(?:\s[^>]*)?>/, (open) => `${open}<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`);
      }
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, style: op.style || 'Normal' });
      continue;
    }
    if (op.op === 'set_table_cell') {
      let current = await zipText(zip, 'word/document.xml');
      const tables = [...current.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)];
      const table = tables[Number(op.table) - 1];
      if (!table) throw new Error(`DOCX table ${op.table} not found`);
      const rows = [...table[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)];
      const row = rows[Number(op.row) - 1];
      if (!row) throw new Error(`DOCX table row ${op.row} not found`);
      const cells = [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)];
      const cell = cells[Number(op.col) - 1];
      if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
      const nodes = textNodes(cell[0], 'w:t');
      let nextCell;
      if (nodes.length) {
        nodes[0].text = String(op.text ?? '');
        for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
        nextCell = rebuildTextNodes(cell[0], 'w:t', nodes);
      } else {
        nextCell = cell[0].replace('</w:tc>', `<w:p><w:r><w:t>${xmlEncode(op.text ?? '')}</w:t></w:r></w:p></w:tc>`);
      }
      const nextRow = row[0].replace(cell[0], nextCell);
      const nextTable = table[0].replace(row[0], nextRow);
      current = `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true });
      continue;
    }
    if (op.op === 'set_table_style') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const nextTable = replaceWordProperties(table[0], 'tbl', 'tblPr', wordTableProperties(op.properties));
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table) });
      continue;
    }
    if (op.op === 'set_table_cell_style' || op.op === 'merge_table_cells') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const rows = [...table[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)];
      const row = rows[Number(op.row) - 1];
      if (!row) throw new Error(`DOCX table row ${op.row} not found`);
      const cells = [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)];
      const cell = cells[Number(op.col) - 1];
      if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
      let nextTable = table[0];
      if (op.op === 'set_table_cell_style') {
        let nextCell = replaceWordProperties(cell[0], 'tc', 'tcPr', wordCellProperties(op.properties));
        const runFormat = [
          op.properties?.bold ? '<w:b/>' : '',
          op.properties?.italic ? '<w:i/>' : '',
          op.properties?.color ? `<w:color w:val="${xmlEncode(String(op.properties.color).replace(/^#/, ''))}"/>` : '',
        ].join('');
        if (runFormat) {
          nextCell = /<w:rPr(?:\s[^>]*)?>/.test(nextCell)
            ? nextCell.replace(/<w:rPr(?:\s[^>]*)?>/, (open) => `${open}${runFormat}`)
            : nextCell.replace(/<w:r(?:\s[^>]*)?>/, (open) => `${open}<w:rPr>${runFormat}</w:rPr>`);
        }
        nextTable = table[0].replace(cell[0], nextCell);
      } else {
        const colSpan = Math.max(1, Number(op.colSpan) || 1);
        const rowSpan = Math.max(1, Number(op.rowSpan) || 1);
        let merged = replaceWordProperties(cell[0], 'tc', 'tcPr', `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}${rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ''}`);
        let nextRow = row[0].replace(cell[0], merged);
        for (let index = Number(op.col); index < Number(op.col) + colSpan - 1; index += 1) {
          const remove = cells[index];
          if (remove) nextRow = nextRow.replace(remove[0], '');
        }
        nextTable = table[0].replace(row[0], nextRow);
        if (rowSpan > 1) {
          for (let rowIndex = Number(op.row); rowIndex < Number(op.row) + rowSpan - 1; rowIndex += 1) {
            const continuationRow = rows[rowIndex];
            if (!continuationRow) break;
            const continuationCells = [...continuationRow[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)];
            const continuation = continuationCells[Number(op.col) - 1];
            if (!continuation) continue;
            const nextCell = replaceWordProperties(continuation[0], 'tc', 'tcPr', `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}<w:vMerge/>`);
            nextTable = nextTable.replace(continuation[0], nextCell);
          }
        }
      }
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table), row: Number(op.row), col: Number(op.col) });
      continue;
    }
    if (op.op === 'set_paragraph_format') {
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const nextParagraph = replaceWordProperties(paragraph.xml, 'p', 'pPr', paragraphFormatXml(op.properties));
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextParagraph !== paragraph.xml, paragraph: Number(op.paragraph) });
      continue;
    }
    throw new Error(`Portable DOCX backend does not support operation: ${op.op}`);
  }
  return results;
}

async function applyXlsx(zip, operations) {
  const sheets = await workbookSheets(zip);
  const byName = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));
  const results = [];
  let recalculationRequired = false;
  for (const op of operations) {
    const sheet = op.sheet ? byName.get(String(op.sheet).toLowerCase()) : sheets[0];
    if (!sheet) throw new Error(`Worksheet not found: ${op.sheet || '(first sheet)'}`);
    let xml = await zipText(zip, sheet.path);
    if (op.op === 'set_cell' || op.op === 'set_formula') {
      xml = setCellInSheet(xml, op.cell, op.value, op.op === 'set_formula' ? op.formula : '');
      zip.file(sheet.path, xml);
      if (op.op === 'set_formula') recalculationRequired = true;
      results.push({ op: op.op, changed: true, sheet: sheet.name, cell: parseCellRef(op.cell).ref });
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
    throw new Error(`Portable XLSX backend does not support operation: ${op.op}`);
  }
  if (recalculationRequired) {
    const workbookPath = 'xl/workbook.xml';
    zip.file(workbookPath, forceWorkbookRecalculation(await zipText(zip, workbookPath)));
  }
  return results;
}

function nextShapeId(xml) {
  const ids = [...xml.matchAll(/\bcNvPr\s+id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(1, ...ids) + 1;
}

async function applyPptx(zip, operations) {
  const results = [];
  for (const op of operations) {
    if (op.op === 'fill_template') {
      const paths = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name));
      results.push(await fillTemplateParts(zip, paths, 'a:t', op));
      continue;
    }
    if (op.op === 'replace_text') {
      let count = 0;
      const paths = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name));
      for (const path of paths) {
        const current = await zipText(zip, path);
        const replaced = replaceAcrossRuns(current, 'a:t', String(op.find || ''), String(op.replace ?? ''));
        if (replaced.count) zip.file(path, replaced.xml);
        count += replaced.count;
      }
      results.push({ op: op.op, changed: count > 0, count });
      continue;
    }
    if (op.op === 'set_text') {
      const path = `ppt/slides/slide${Number(op.slide)}.xml`;
      const current = await zipText(zip, path);
      if (!current) throw new Error(`PPTX slide ${op.slide} not found`);
      const shapes = [...current.matchAll(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g)];
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const nodes = textNodes(shape[0], 'a:t');
      if (!nodes.length) throw new Error(`PPTX shape ${op.shape} has no editable text`);
      nodes[0].text = String(op.text ?? '');
      for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
      const nextShape = rebuildTextNodes(shape[0], 'a:t', nodes);
      zip.file(path, `${current.slice(0, shape.index)}${nextShape}${current.slice(shape.index + shape[0].length)}`);
      results.push({ op: op.op, changed: true });
      continue;
    }
    if (op.op === 'add_textbox') {
      const path = `ppt/slides/slide${Number(op.slide)}.xml`;
      const current = await zipText(zip, path);
      if (!current) throw new Error(`PPTX slide ${op.slide} not found`);
      const id = nextShapeId(current);
      const left = Math.round(Number(op.left ?? 72) * 12700);
      const top = Math.round(Number(op.top ?? 72) * 12700);
      const width = Math.round(Number(op.width ?? 360) * 12700);
      const height = Math.round(Number(op.height ?? 72) * 12700);
      const size = Math.round(Number(op.properties?.fontSize ?? 18) * 100);
      const shape = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Mixdog TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${left}" y="${top}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${xmlEncode(op.text ?? '')}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
      if (!/<\/p:spTree>/.test(current)) throw new Error('PPTX slide shape tree is missing');
      zip.file(path, current.replace('</p:spTree>', `${shape}</p:spTree>`));
      results.push({ op: op.op, changed: true, shapeId: id });
      continue;
    }
    if (op.op === 'delete_shape') {
      const path = `ppt/slides/slide${Number(op.slide)}.xml`;
      const current = await zipText(zip, path);
      if (!current) throw new Error(`PPTX slide ${op.slide} not found`);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const nextInner = `${tree.inner.slice(0, shape.start)}${tree.inner.slice(shape.end)}`;
      zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true });
      continue;
    }
    throw new Error(`Portable PPTX backend does not support operation: ${op.op}`);
  }
  return results;
}

export async function applyPortableOoxmlBatch(path, format, operations) {
  const zip = await loadPackage(path);
  const results = format === 'docx'
    ? await applyDocx(zip, operations)
    : format === 'xlsx'
      ? await applyXlsx(zip, operations)
      : await applyPptx(zip, operations);
  await savePackage(zip, path);
  return results;
}

function xmlAttribute(attributes, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attributes)?.[1] || '';
}

function relationshipOwner(relPath) {
  if (relPath === '_rels/.rels') return '';
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/i.exec(relPath);
  return match ? `${match[1]}/${match[2]}` : '';
}

function relationshipTarget(relPath, target) {
  let decoded = xmlDecode(target).split('#')[0].split('?')[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  const owner = relationshipOwner(relPath);
  const base = owner ? posix.dirname(owner) : '';
  return posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded));
}

async function inspectXmlParts(zip, entries) {
  const malformedXml = [];
  const xmlEntries = entries.filter((name) => name === '[Content_Types].xml' || /\.(?:xml|rels)$/i.test(name));
  const { JSDOM } = await import('jsdom');
  for (const name of xmlEntries) {
    try {
      const xml = await zipText(zip, name);
      const dom = new JSDOM(xml, { contentType: 'text/xml' });
      dom.window.close();
    } catch (error) {
      malformedXml.push({ part: name, error: error?.message || String(error) });
    }
  }
  return malformedXml;
}

function contentTypeCoverage(entries, xml, format) {
  const defaults = new Map();
  const overrides = new Map();
  for (const match of xml.matchAll(/<Default\b([^>]*?)\/?>/gi)) {
    defaults.set(xmlAttribute(match[1], 'Extension').toLowerCase(), xmlAttribute(match[1], 'ContentType'));
  }
  for (const match of xml.matchAll(/<Override\b([^>]*?)\/?>/gi)) {
    overrides.set(xmlAttribute(match[1], 'PartName').replace(/^\/+/, ''), xmlAttribute(match[1], 'ContentType'));
  }
  const missingContentTypes = entries.filter((name) => {
    if (name === '[Content_Types].xml') return false;
    if (overrides.has(name)) return false;
    const extension = name.toLowerCase().endsWith('.rels')
      ? 'rels'
      : posix.extname(name).slice(1).toLowerCase();
    return !extension || !defaults.has(extension);
  });
  const mainPart = OOXML_REQUIRED[format]?.[1] || '';
  const mainContentType = overrides.get(mainPart) || '';
  return {
    missingContentTypes,
    mainPart,
    mainContentType,
    mainContentTypeMissing: Boolean(mainPart && !mainContentType),
  };
}

async function baselinePackage(zip, original) {
  if (!original) return { compared: false };
  const originalZip = await loadPackage(original);
  const currentEntries = new Set(Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name));
  const originalEntries = Object.entries(originalZip.files).filter(([, entry]) => !entry.dir).map(([name]) => name);
  const protectedPattern = /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|_xmlsignatures\/|origin\.sigs$|signatures?\.xml$|customUI\/|embeddings\/|externalLinks\/|connections\.xml$|slideMasters\/|slideLayouts\/|theme\/)/i;
  const protectedParts = originalEntries.filter((name) => protectedPattern.test(name));
  const lostProtectedParts = protectedParts.filter((name) => !currentEntries.has(name));
  const hash = async (entry) => createHash('sha256').update(await entry.async('nodebuffer')).digest('hex');
  const changedProtectedParts = [];
  const changedParts = [];
  for (const name of originalEntries) {
    const current = zip.file(name);
    if (!current) continue;
    const [before, after] = await Promise.all([hash(originalZip.file(name)), hash(current)]);
    if (before !== after) {
      changedParts.push(name);
      if (protectedPattern.test(name)) changedProtectedParts.push({ part: name, before, after });
    }
  }
  const signatureParts = originalEntries.filter((name) => /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name));
  return {
    compared: true,
    original,
    originalEntries: originalEntries.length,
    addedParts: [...currentEntries].filter((name) => !originalZip.file(name)),
    lostProtectedParts,
    changedProtectedParts,
    signatureParts,
    digitalSignatureInvalidated: signatureParts.length > 0 && changedParts.length > 0,
  };
}

function rejectedDocxText(xml) {
  let value = String(xml || '');
  value = value.replace(/<w:ins(?:\s[^>]*)?>[\s\S]*?<\/w:ins>/g, '');
  value = value.replace(/<w:del(?:\s[^>]*)?>([\s\S]*?)<\/w:del>/g, (_, body) => (
    body.replaceAll('<w:delText', '<w:t').replaceAll('</w:delText>', '</w:t>')
  ));
  return [...value.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((paragraph) => paragraphTexts(paragraph[1], 'w:t').join(''))
    .filter((text) => text.length > 0)
    .join('\n');
}

async function validateDocxRedlining(zip, originalPath) {
  if (!originalPath) {
    return {
      requested: true,
      ok: false,
      reason: 'Redlining audit requires an opened source document.',
    };
  }
  try {
    const original = await loadPackage(originalPath);
    const before = rejectedDocxText(await zipText(original, 'word/document.xml'));
    const after = rejectedDocxText(await zipText(zip, 'word/document.xml'));
    return {
      requested: true,
      ok: before === after,
      originalCharacters: before.length,
      rejectedCharacters: after.length,
      reason: before === after ? '' : 'Document text differs from the source after rejecting tracked changes; at least one edit is untracked.',
    };
  } catch (error) {
    return {
      requested: true,
      ok: false,
      reason: error?.message || String(error),
    };
  }
}

export async function validatePortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name);
  const missing = (OOXML_REQUIRED[format] || []).filter((name) => !zip.file(name));
  const unsafeEntries = entries.filter((name) => name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name));
  const macros = entries.filter((name) => /vbaProject\.bin$/i.test(name));
  const signatures = entries.filter((name) => /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name));
  const externalLinks = entries.filter((name) => /(?:^|\/)externalLinks\//i.test(name));
  const dataConnections = entries.filter((name) => /(?:^|\/)connections\.xml$/i.test(name));
  const embeddedObjects = entries.filter((name) => /(?:^|\/)embeddings\//i.test(name));
  const malformedXml = await inspectXmlParts(zip, entries);
  const contentTypes = contentTypeCoverage(entries, await zipText(zip, '[Content_Types].xml'), format);
  const missingRelationships = [];
  const duplicateRelationshipIds = [];
  const externalRelationships = [];
  for (const relPath of entries.filter((name) => name.endsWith('.rels'))) {
    const xml = await zipText(zip, relPath);
    const ids = new Set();
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      const id = xmlAttribute(match[1], 'Id');
      const target = xmlAttribute(match[1], 'Target');
      const mode = xmlAttribute(match[1], 'TargetMode');
      if (id && ids.has(id)) duplicateRelationshipIds.push({ relationship: relPath, id });
      if (id) ids.add(id);
      if (mode.toLowerCase() === 'external') {
        externalRelationships.push({ relationship: relPath, id, target: xmlDecode(target) });
        continue;
      }
      const resolved = relationshipTarget(relPath, target);
      if (!resolved || resolved.startsWith('../') || !zip.file(resolved)) {
        missingRelationships.push({ relationship: relPath, id, target: xmlDecode(target), resolved });
      }
    }
  }
  const baseline = await baselinePackage(zip, options.original);
  const redlining = format === 'docx' && options.auditProfile === 'redlining'
    ? await validateDocxRedlining(zip, options.original)
    : null;
  const ok = missing.length === 0
    && unsafeEntries.length === 0
    && malformedXml.length === 0
    && contentTypes.missingContentTypes.length === 0
    && !contentTypes.mainContentTypeMissing
    && missingRelationships.length === 0
    && duplicateRelationshipIds.length === 0
    && !(baseline.lostProtectedParts?.length)
    && !(baseline.changedProtectedParts?.length)
    && baseline.digitalSignatureInvalidated !== true
    && (!redlining || redlining.ok);
  return {
    ok,
    format,
    entries: entries.length,
    missing,
    unsafeEntries,
    macros,
    security: {
      macros,
      signatures,
      externalLinks,
      dataConnections,
      embeddedObjects,
      macroExecution: 'disabled',
      digitalSignatureInvalidated: baseline.digitalSignatureInvalidated === true,
    },
    malformedXml,
    missingRelationships,
    duplicateRelationshipIds,
    externalRelationships,
    ...contentTypes,
    baseline,
    redlining,
    validation: 'opc-relationships-content-types-xml',
  };
}

export async function issuesPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const issues = [];
  const validation = await validatePortableOoxml(path, format);
  for (const missing of validation.missing) {
    issues.push({ severity: 'error', code: 'missing_part', path: `/${missing}`, message: `Required package part is missing: ${missing}` });
  }
  for (const unsafe of validation.unsafeEntries) {
    issues.push({ severity: 'error', code: 'unsafe_zip_entry', path: `/${unsafe}`, message: `Unsafe ZIP entry path: ${unsafe}` });
  }
  for (const malformed of validation.malformedXml) {
    issues.push({ severity: 'error', code: 'malformed_xml', path: `/${malformed.part}`, message: malformed.error });
  }
  for (const relationship of validation.missingRelationships) {
    issues.push({ severity: 'error', code: 'missing_relationship_target', path: `/${relationship.relationship}`, message: `Relationship ${relationship.id || '(unnamed)'} targets missing part ${relationship.resolved || relationship.target}` });
  }
  for (const relationship of validation.duplicateRelationshipIds) {
    issues.push({ severity: 'error', code: 'duplicate_relationship_id', path: `/${relationship.relationship}`, message: `Relationship id is duplicated: ${relationship.id}` });
  }
  for (const part of validation.missingContentTypes) {
    issues.push({ severity: 'error', code: 'missing_content_type', path: `/${part}`, message: 'Package part has no matching content type declaration.' });
  }
  if (validation.mainContentTypeMissing) {
    issues.push({ severity: 'error', code: 'missing_main_content_type', path: `/${validation.mainPart}`, message: 'The main Office document part needs an explicit content type override.' });
  }
  for (const part of validation.baseline.lostProtectedParts || []) {
    issues.push({ severity: 'error', code: 'lost_protected_part', path: `/${part}`, message: 'A macro, master, layout, or theme part from the source package was removed.' });
  }
  for (const part of validation.baseline.changedProtectedParts || []) {
    issues.push({ severity: 'error', code: 'changed_protected_part', path: `/${part.part}`, message: 'A macro, signature, embedded object, external link, connection, master, layout, or theme part changed unexpectedly.' });
  }
  if (validation.security?.digitalSignatureInvalidated) {
    issues.push({ severity: 'error', code: 'digital_signature_invalidated', path: '/', message: 'The source package was digitally signed and document changes invalidate that signature.' });
  }
  for (const macro of validation.macros) {
    issues.push({ severity: 'warning', code: 'macro_present', path: `/${macro}`, message: 'VBA macro payload is present and is never executed by the portable backend.' });
  }
  for (const connection of validation.security?.dataConnections || []) {
    issues.push({ severity: 'warning', code: 'data_connection_present', path: `/${connection}`, message: 'Workbook data connection is preserved but never refreshed automatically.' });
  }
  for (const embedded of validation.security?.embeddedObjects || []) {
    issues.push({ severity: 'warning', code: 'embedded_object_present', path: `/${embedded}`, message: 'Embedded object is preserved but never activated by Mixdog.' });
  }
  for (const relationship of validation.externalRelationships) {
    issues.push({ severity: 'warning', code: 'external_relationship', path: `/${relationship.relationship}`, message: `External relationship: ${relationship.target}` });
  }
  if (format === 'docx') {
    const snapshot = await snapshotDocx(zip);
    if (snapshot.revisionCount) issues.push({ severity: 'info', code: 'unresolved_revisions', path: '/body', message: `${snapshot.revisionCount} tracked revision element(s) remain unresolved.` });
    if (snapshot.commentCount) issues.push({ severity: 'info', code: 'unresolved_comments', path: '/body', message: `${snapshot.commentCount} comment(s) remain in the document.` });
  } else if (format === 'xlsx') {
    const selective = Boolean(options.sheet || options.range);
    const snapshot = await snapshotXlsx(zip, selective ? {
      paged: true,
      sheet: options.sheet,
      range: options.range,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    } : {});
    const errorPattern = /^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/i;
    for (const sheet of snapshot.sheets) {
      for (const cell of sheet.cells) {
        if (cell.formula && cell.cacheState === 'missing') {
          issues.push({ severity: 'warning', code: 'formula_cache_missing', path: cell.path, message: 'Formula has no cached value; the workbook is marked for full recalculation on open.' });
        }
        if (errorPattern.test(String(cell.value || ''))) {
          issues.push({ severity: 'error', code: 'formula_error', path: cell.path, message: `Cell contains formula error ${cell.value}` });
        }
      }
    }
    if (options.auditProfile === 'financial-model') {
      if (!snapshot.sheets.some((sheet) => sheet.name.toLowerCase() === 'checks')) {
        issues.push({ severity: 'warning', code: 'missing_checks_sheet', path: '/', message: 'Financial-model audit expects a Checks sheet with explicit tie-out formulas.' });
      }
      for (const sheet of snapshot.sheets) {
        const formulaRows = new Set(sheet.cells.filter((cell) => cell.formula).map((cell) => parseCellRef(cell.ref).row));
        for (const cell of sheet.cells) {
          if (!cell.formula && formulaRows.has(parseCellRef(cell.ref).row) && /^-?\d+(?:\.\d+)?$/.test(String(cell.value || ''))) {
            issues.push({ severity: 'warning', code: 'rogue_hardcode', path: cell.path, message: 'Numeric hardcode appears inside a row that otherwise contains formulas.' });
          }
        }
      }
    }
  } else if (format === 'pptx') {
    const requestedPages = new Set((options.pages || []).map(Number));
    const slidePaths = Object.keys(zip.files).filter((name) => {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) return false;
      if (!requestedPages.size) return true;
      return requestedPages.has(Number(/slide(\d+)\.xml$/.exec(name)?.[1]));
    });
    for (const slidePath of slidePaths) {
      const xml = await zipText(zip, slidePath);
      const slide = Number(/slide(\d+)\.xml$/.exec(slidePath)?.[1]);
      let picture = 0;
      for (const match of xml.matchAll(/<p:pic(?:\s[^>]*)?>[\s\S]*?<\/p:pic>/g)) {
        picture += 1;
        const descr = /\bdescr="([^"]*)"/.exec(match[0])?.[1] || '';
        if (!descr) issues.push({ severity: 'warning', code: 'missing_alt_text', path: `/slide[${slide}]/picture[${picture}]`, message: 'Picture has no alternative text.' });
      }
    }
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), format, issueCount: issues.length, issues };
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function libreOfficeProgram() {
  const candidates = process.platform === 'win32'
    ? [
        'soffice.exe',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      ]
    : ['soffice', 'libreoffice'];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) return candidate;
  }
  return '';
}

export async function recalculateLibreOfficeWorkbook(path, {
  force = false,
  signal = null,
} = {}) {
  const source = await readFile(path);
  const zip = await JSZip.loadAsync(source);
  let formulaCount = 0;
  let missingCachedValues = 0;
  for (const name of Object.keys(zip.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))) {
    const xml = await zipText(zip, name);
    for (const match of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/gi)) {
      if (!/<f(?:\s[^>]*)?>/i.test(match[1])) continue;
      formulaCount += 1;
      if (!/<v(?:\s[^>]*)?>[\s\S]*?<\/v>/i.test(match[1])) missingCachedValues += 1;
    }
  }
  const needed = formulaCount > 0 && (force || missingCachedValues > 0);
  if (!needed) {
    return {
      needed: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
    };
  }
  if (extname(path).toLowerCase() !== '.xlsx') {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason: 'Portable formula recalculation currently supports .xlsx only; use Microsoft Office background mode for macro-enabled or template workbooks.',
    };
  }
  if (Object.keys(zip.files).some((entry) => /^xl\/externalLinks\//i.test(entry))) {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason: 'Portable formula recalculation is blocked because LibreOffice may invalidate external workbook links.',
    };
  }
  const program = await libreOfficeProgram();
  if (!program) {
    return {
      needed: true,
      available: false,
      recalculated: false,
      formulaCount,
      missingCachedValues,
      reason: 'LibreOffice is unavailable for portable XLSX recalculation.',
    };
  }
  const root = await mkdtemp(join(tmpdir(), 'mixdog-office-recalculate-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const input = join(inputDir, basename(path));
  await writeFile(input, source);
  let timeout;
  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(program, ['--headless', '--convert-to', 'xlsx', '--outdir', outputDir, input], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        try { child.kill(); } catch {}
        finish({ recalculated: false, error: 'Portable XLSX recalculation was cancelled' });
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => finish({ recalculated: false, error: error?.message || String(error) }));
      child.once('close', (code) => finish(code === 0
        ? { recalculated: true }
        : { recalculated: false, error: stderr.trim() || `LibreOffice exited with code ${code}` }));
      timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ recalculated: false, error: 'Portable XLSX recalculation timed out after 60 seconds' });
      }, 60_000);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
    if (!result.recalculated) {
      return {
        needed: true,
        available: true,
        recalculated: false,
        formulaCount,
        missingCachedValues,
        reason: result.error,
      };
    }
    const generated = join(outputDir, `${basename(path, extname(path))}.xlsx`);
    const details = await stat(generated).catch(() => null);
    if (!details?.isFile() || details.size <= 0) {
      return {
        needed: true,
        available: true,
        recalculated: false,
        formulaCount,
        missingCachedValues,
        reason: 'LibreOffice produced no recalculated workbook.',
      };
    }
    await writeFile(path, await readFile(generated));
    return {
      needed: true,
      available: true,
      recalculated: true,
      backend: 'libreoffice',
      formulaCount,
      missingCachedValues,
      outputBytes: details.size,
    };
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

export async function validateLibreOfficeReopen(path) {
  const program = await libreOfficeProgram();
  if (!program) return { available: false, opened: false, backend: 'libreoffice' };
  const outputDir = await mkdtemp(join(tmpdir(), 'mixdog-office-libreoffice-'));
  let timeout;
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(program, ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, path], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const finish = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ opened: false, error: 'LibreOffice reopen timed out after 60 seconds' });
      }, 60_000);
      child.once('error', (error) => finish({ opened: false, error: error?.message || String(error) }));
      child.once('close', (code) => finish(code === 0
        ? { opened: true }
        : { opened: false, error: stderr.trim() || `LibreOffice exited with code ${code}` }));
    });
    const output = join(outputDir, `${basename(path, extname(path))}.pdf`);
    if (result.opened) {
      const details = await stat(output).catch(() => null);
      if (!details?.isFile() || details.size <= 0) return { available: true, opened: false, backend: 'libreoffice', error: 'LibreOffice produced no review PDF' };
      return { available: true, opened: true, backend: 'libreoffice', outputBytes: details.size };
    }
    return { available: true, backend: 'libreoffice', ...result };
  } finally {
    clearTimeout(timeout);
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function renderPortableOoxml(path, output, { signal = null } = {}) {
  const program = await libreOfficeProgram();
  if (!program) {
    throw new Error('Portable Office rendering requires LibreOffice; install LibreOffice or open the document in background mode to render through Microsoft Office');
  }
  const outputDir = dirname(output);
  await new Promise((resolve, reject) => {
    const child = spawn(program, ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, path], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      operation();
    };
    const onAbort = () => {
      try { child.kill(); } catch {}
      finish(() => reject(new Error('Office rendering was cancelled')));
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => (
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `LibreOffice exited with code ${code}`))
    )));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  const generated = join(outputDir, `${basename(path, extname(path))}.pdf`);
  if (generated !== output) {
    const { rename } = await import('node:fs/promises');
    await rename(generated, output);
  }
  return output;
}
