import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { applyCellStyle, normalizeColor } from './portable-sheet-styles.mjs';
import {
  reviewShapeSpacing,
  reviewTextBoxFit,
  reviewTextContrast,
  shrinkFontSizeToFit,
} from './text-metrics.mjs';
import { normalizeXlsxFormula } from './xlsx-contract.mjs';
import { chartWorkbookRows, chartXml } from './portable-chart.mjs';
import { createPortableChartWorkbook } from './portable-package.mjs';
import {
  backgroundXml,
  pictureXml,
  resolveGeometry,
  shapeXml,
  solidFillXml,
  supportedShapeTypes,
  tableXml,
  textBodyXml,
  toEmu,
} from './portable-slide-shapes.mjs';

const OOXML_REQUIRED = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
};

const SPREADSHEET_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SPREADSHEET_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const DRAWING_MAIN_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const OFFICE_RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

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

function appendDocxBlock(documentXml, block) {
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const onlyEmptyParagraph = model.blocks.length === 1
    && model.blocks[0].name === 'w:p'
    && !paragraphTexts(model.blocks[0].xml, 'w:t').length
    && !/<w:drawing\b/.test(model.blocks[0].xml);
  if (onlyEmptyParagraph) {
    const placeholder = model.blocks[0];
    const replaced = `${model.body.inner.slice(0, placeholder.start)}${block}${model.body.inner.slice(placeholder.end)}`;
    return `${documentXml.slice(0, model.body.start)}${replaced}${documentXml.slice(model.body.end)}`;
  }
  const trailingSection = /<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/.exec(model.body.inner);
  const position = trailingSection ? trailingSection.index : model.body.inner.length;
  const inner = `${model.body.inner.slice(0, position)}${block}${model.body.inner.slice(position)}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
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

function existingCellStyle(xml, ref) {
  const match = new RegExp(`<c\\b([^>]*\\br="${ref}"[^>]*?)(?:\\/>|>)`, 'i').exec(xml);
  return match ? (/\bs="(\d+)"/.exec(match[1])?.[1] || '') : '';
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

function elementSpans(fragment, tag) {
  const spans = [];
  const regex = new RegExp(`<${tagPattern(tag)}\\b([^>]*?)(\\/>|>[\\s\\S]*?<\\/${tagPattern(tag)}>)`, 'g');
  let match;
  while ((match = regex.exec(fragment))) {
    spans.push({
      start: match.index,
      end: regex.lastIndex,
      attrs: match[1],
      xml: match[0],
    });
  }
  return spans;
}

function containerBody(xml, tag) {
  if (xml.endsWith('/>')) return '';
  return xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf(`</${tag}>`));
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

function setCellInSheet(xml, ref, value, formula = '') {
  const parsed = parseCellRef(ref);
  return placeCellInSheet(xml, parsed.ref, cellXml(parsed.ref, value, formula, existingCellStyle(xml, parsed.ref)));
}

function setCellStyleInSheet(xml, ref, styleIndex) {
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

function pointsToTwips(value) {
  return Math.max(1, Math.round(Number(value) * 20));
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
    properties.style ? `<w:tblStyle w:val="${xmlEncode(docxStyleId(properties.style))}"/>` : '',
    `<w:tblW w:w="0" w:type="auto"/>`,
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
    borderXml,
    properties.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>` : '',
  ].join('');
}

function wordCellProperties(properties = {}) {
  return [
    properties.width ? `<w:tcW w:w="${pointsToTwips(properties.width)}" w:type="dxa"/>` : '',
    properties.fillColor ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.fillColor).replace(/^#/, ''))}"/>` : '',
    properties.verticalAlignment ? `<w:vAlign w:val="${xmlEncode(properties.verticalAlignment)}"/>` : '',
  ].join('');
}

function wordTableXml(operation) {
  const values = Array.isArray(operation.values) ? operation.values : [];
  const rows = Math.max(1, Number(operation.rows) || values.length || 1);
  const columns = Math.max(1, Number(operation.columns) || Math.max(0, ...values.map((row) => row.length)) || 1);
  const widths = operation.properties?.columnWidths || [];
  const grid = Array.from({ length: columns }, (_, column) => `<w:gridCol${widths[column] ? ` w:w="${pointsToTwips(widths[column])}"` : ''}/>`).join('');
  const body = Array.from({ length: rows }, (_, row) => `<w:tr>${Array.from({ length: columns }, (_, column) => {
    const text = String(values[row]?.[column] ?? '');
    const width = widths[column] ? `<w:tcW w:w="${pointsToTwips(widths[column])}" w:type="dxa"/>` : '';
    return `<w:tc>${width ? `<w:tcPr>${width}</w:tcPr>` : ''}<w:p><w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr>${wordTableProperties(operation.properties)}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

const WORD_MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const HEADER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FOOTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
const WORD_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PICTURE_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const PIXELS_TO_POINTS = 0.75;

export function imagePixelSize(data) {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 0xFF && data[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xFF) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (data.length > 10 && data.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  return null;
}

async function addDocumentImage(zip, source) {
  const extension = extname(String(source || '')).replace(/^\./, '').toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`);
  }
  const data = await readFile(source);
  let ordinal = 1;
  while (zip.file(`word/media/image${ordinal}.${extension}`)) ordinal += 1;
  const part = `word/media/image${ordinal}.${extension}`;
  zip.file(part, data);
  await ensureDefaultContentType(zip, extension, contentType);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    `media/image${ordinal}.${extension}`,
  );
  return { part, relationshipId, pixels: imagePixelSize(data), name: `image${ordinal}.${extension}` };
}

function wordDrawingXml({ id, embedId, name, width, height }) {
  const cx = Math.max(1, Math.round(width * 12_700));
  const cy = Math.max(1, Math.round(height * 12_700));
  return `<w:drawing><wp:inline xmlns:wp="${WORD_DRAWING_NS}" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${id}" name="${xmlEncode(name)}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${DRAWING_MAIN_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${DRAWING_MAIN_NS}"><a:graphicData uri="${PICTURE_NS}">`
    + `<pic:pic xmlns:pic="${PICTURE_NS}">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlEncode(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:a="${DRAWING_MAIN_NS}" r:embed="${embedId}"/>`
    + `<a:stretch xmlns:a="${DRAWING_MAIN_NS}"><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm xmlns:a="${DRAWING_MAIN_NS}"><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom xmlns:a="${DRAWING_MAIN_NS}" prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

function insertDocxBlockAt(documentXml, block, paragraphNumber) {
  if (!paragraphNumber) return appendDocxBlock(documentXml, block);
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const paragraph = model.blocks.filter((entry) => entry.name === 'w:p')[Number(paragraphNumber) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${paragraphNumber} not found`);
  const inner = `${model.body.inner.slice(0, paragraph.end)}${block}${model.body.inner.slice(paragraph.end)}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}

function trailingSectionProperties(documentXml) {
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const match = /<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/.exec(model.body.inner);
  return { model, match };
}

function upsertSectionChild(sectionXml, tag, element, afterTags = []) {
  const pattern = new RegExp(`<w:${tag}\\b[^>]*\\/>`);
  if (pattern.test(sectionXml)) return sectionXml.replace(pattern, element);
  for (const anchor of afterTags) {
    const found = new RegExp(`<w:${anchor}\\b[^>]*\\/>`).exec(sectionXml);
    if (found) {
      const position = found.index + found[0].length;
      return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
    }
  }
  const references = [...sectionXml.matchAll(/<w:(?:headerReference|footerReference)\b[^>]*\/>/g)];
  const position = references.length
    ? references.at(-1).index + references.at(-1)[0].length
    : sectionXml.indexOf('>') + 1;
  return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
}

function writeSectionProperties(documentXml, mutate) {
  const { model, match } = trailingSectionProperties(documentXml);
  const current = match ? match[0] : '<w:sectPr></w:sectPr>';
  const next = mutate(current);
  const inner = match
    ? `${model.body.inner.slice(0, match.index)}${next}${model.body.inner.slice(match.index + match[0].length)}`
    : `${model.body.inner}${next}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}

const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

const COMMENTS_EXTENDED_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml';
const COMMENTS_EXTENDED_RELATIONSHIP = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended';
const WORD_2010_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
const WORD_2012_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';

function commentParagraphId(commentId) {
  return (0x10000000 + Number(commentId)).toString(16).toUpperCase().padStart(8, '0');
}

async function ensureCommentsExtendedPart(zip) {
  const part = 'word/commentsExtended.xml';
  const existing = await zipText(zip, part);
  if (existing) return { part, xml: existing };
  const xml = `${XML_HEADER}<w15:commentsEx xmlns:w15="${WORD_2012_NS}"></w15:commentsEx>`;
  zip.file(part, xml);
  await ensureContentTypeOverride(zip, `/${part}`, COMMENTS_EXTENDED_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    COMMENTS_EXTENDED_RELATIONSHIP,
    'commentsExtended.xml',
  );
  return { part, xml };
}

async function registerCommentThread(zip, { commentId, parentId = 0, done = false }) {
  const extended = await ensureCommentsExtendedPart(zip);
  const paraId = commentParagraphId(commentId);
  const pattern = new RegExp(`<w15:commentEx\\b[^>]*\\bw15:paraId="${paraId}"[^>]*\\/>`);
  const entry = `<w15:commentEx w15:paraId="${paraId}"`
    + `${parentId ? ` w15:paraIdParent="${commentParagraphId(parentId)}"` : ''}`
    + ` w15:done="${done ? 1 : 0}"/>`;
  const next = pattern.test(extended.xml)
    ? extended.xml.replace(pattern, entry)
    : extended.xml.replace('</w15:commentsEx>', `${entry}</w15:commentsEx>`);
  zip.file(extended.part, next);
  return paraId;
}

async function ensureCommentsPart(zip) {
  const part = 'word/comments.xml';
  const existing = await zipText(zip, part);
  if (existing) return { part, xml: existing };
  const xml = `${XML_HEADER}<w:comments xmlns:w="${WORD_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}"></w:comments>`;
  zip.file(part, xml);
  await ensureContentTypeOverride(zip, `/${part}`, COMMENTS_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/comments`,
    'comments.xml',
  );
  return { part, xml };
}

function anchorDocxComment(paragraphXml, id) {
  const opening = /^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(paragraphXml)?.[0] || '<w:p>';
  const body = paragraphXml.slice(opening.length);
  return `${opening}<w:commentRangeStart w:id="${id}"/>${body}`
    .replace(/<\/w:p>$/, `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`);
}

async function writeHeaderFooterPart(zip, { header, body }) {
  const tag = header ? 'hdr' : 'ftr';
  const prefix = header ? 'header' : 'footer';
  let ordinal = 1;
  while (zip.file(`word/${prefix}${ordinal}.xml`)) ordinal += 1;
  const part = `word/${prefix}${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<w:${tag} xmlns:w="${WORD_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}">${body}</w:${tag}>`);
  await ensureContentTypeOverride(zip, `/${part}`, header ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/${prefix}`,
    `${prefix}${ordinal}.xml`,
  );
  return { part, relationshipId };
}

function upsertSectionReference(sectionXml, tag, kind, relationshipId) {
  const element = `<w:${tag} w:type="${kind}" r:id="${relationshipId}"/>`;
  const pattern = new RegExp(`<w:${tag}\\b[^>]*\\bw:type="${kind}"[^>]*\\/>`);
  if (pattern.test(sectionXml)) return sectionXml.replace(pattern, element);
  const position = sectionXml.indexOf('>') + 1;
  return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
}

const NUMBERING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

const SETTINGS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
const SETTINGS_ORDER = Object.freeze([
  'w:writeProtection', 'w:view', 'w:zoom', 'w:removePersonalInformation', 'w:removeDateAndTime',
  'w:proofState', 'w:attachedTemplate', 'w:linkStyles', 'w:stylePaneFormatFilter',
  'w:documentType', 'w:mailMerge', 'w:revisionView', 'w:trackRevisions', 'w:doNotTrackMoves',
  'w:doNotTrackFormatting', 'w:documentProtection', 'w:autoFormatOverride', 'w:styleLockTheme',
  'w:styleLockQFSet', 'w:defaultTabStop', 'w:autoHyphenation', 'w:characterSpacingControl',
  'w:compat', 'w:rsids', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:decimalSymbol', 'w:listSeparator',
]);

async function documentTracksChanges(zip) {
  return /<w:trackRevisions\b/.test(await zipText(zip, 'word/settings.xml') || '');
}

function revisionAttributes(id, author) {
  return `w:id="${id}" w:author="${xmlEncode(author || 'Mixdog')}"`
    + ` w:date="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}"`;
}

function nextRevisionId(documentXml) {
  const ids = [...documentXml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(0, ...ids) + 1;
}

function markRunsDeleted(paragraphXml, id, author) {
  const runs = [...paragraphXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)];
  if (!runs.length) return paragraphXml;
  let output = paragraphXml;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const deleted = run[0]
      .replace(/<w:t(\s[^>]*)?>/g, (_match, attributes) => `<w:delText${attributes || ''}>`)
      .replace(/<\/w:t>/g, '</w:delText>');
    const wrapped = `<w:del ${revisionAttributes(id + index, author)}>${deleted}</w:del>`;
    output = `${output.slice(0, run.index)}${wrapped}${output.slice(run.index + run[0].length)}`;
  }
  return output;
}

const WORD_STYLE_IDS = Object.freeze({
  'heading 1': 'Heading1',
  'heading 2': 'Heading2',
  'heading 3': 'Heading3',
  'heading 4': 'Heading4',
  'list paragraph': 'ListParagraph',
  'table grid': 'TableGrid',
  'normal table': 'TableNormal',
  'no spacing': 'NoSpacing',
  'intense quote': 'IntenseQuote',
});

function docxStyleId(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return WORD_STYLE_IDS[raw.toLowerCase()] || raw.replace(/\s+/g, '');
}

function wordRunProperties(properties = {}) {
  const size = Number(properties.size ?? properties.fontSize);
  const half = Number.isFinite(size) && size > 0 ? Math.max(2, Math.round(size * 2)) : 0;
  return [
    properties.name ? `<w:rFonts w:ascii="${xmlEncode(properties.name)}" w:hAnsi="${xmlEncode(properties.name)}" w:eastAsia="${xmlEncode(properties.name)}"/>` : '',
    properties.bold === true ? '<w:b/>' : '',
    properties.italic === true ? '<w:i/>' : '',
    properties.underline === true ? '<w:u w:val="single"/>' : '',
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    half ? `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` : '',
  ].join('');
}

function numberingDefinition(abstractId, kind) {
  const levels = [0, 1, 2].map((level) => {
    const indent = 720 * (level + 1);
    if (kind === 'bullet') {
      const marks = ['\u2022', '\u25E6', '\u25AA'];
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>`
        + `<w:lvlText w:val="${marks[level]}"/><w:lvlJc w:val="left"/>`
        + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>`
        + '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl>';
    }
    const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${formats[level]}"/>`
      + `<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

async function ensureNumbering(zip, kind) {
  const part = 'word/numbering.xml';
  let xml = await zipText(zip, part);
  if (!xml) {
    xml = `${XML_HEADER}<w:numbering xmlns:w="${WORD_MAIN_NS}"></w:numbering>`;
    await ensureContentTypeOverride(zip, `/${part}`, NUMBERING_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      partRelationshipPath('word/document.xml'),
      `${OFFICE_RELATIONSHIP_BASE}/numbering`,
      'numbering.xml',
    );
  }
  const marker = kind === 'bullet' ? 'w:numFmt w:val="bullet"' : 'w:numFmt w:val="decimal"';
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>/g)) {
    if (!match[0].includes(marker)) continue;
    const reuse = new RegExp(`<w:num\\b[^>]*\\bw:numId="(\\d+)"[^>]*>\\s*<w:abstractNumId w:val="${match[1]}"\\/>`).exec(xml);
    if (reuse) return { xml, numId: Number(reuse[1]), created: false };
  }
  const abstractIds = [...xml.matchAll(/\bw:abstractNumId="(\d+)"/g)].map((match) => Number(match[1]));
  const numIds = [...xml.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"/g)].map((match) => Number(match[1]));
  const abstractId = Math.max(-1, ...abstractIds) + 1;
  const numId = Math.max(0, ...numIds) + 1;
  const abstract = numberingDefinition(abstractId, kind);
  const definition = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
  const abstracts = [...xml.matchAll(/<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g)];
  const position = abstracts.length
    ? abstracts.at(-1).index + abstracts.at(-1)[0].length
    : xml.indexOf('>', xml.indexOf('<w:numbering')) + 1;
  const next = `${xml.slice(0, position)}${abstract}${xml.slice(position)}`
    .replace('</w:numbering>', `${definition}</w:numbering>`);
  zip.file(part, next);
  return { xml: next, numId, created: true };
}

function wordParagraph(text, { alignment = '', style = '' } = {}) {
  const properties = [
    style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : '',
    alignment ? `<w:jc w:val="${xmlEncode(alignment)}"/>` : '',
  ].join('');
  const value = String(text ?? '');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}`
    + `<w:r><w:t${/^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''}>${xmlEncode(value)}</w:t></w:r></w:p>`;
}

function blankTableCells(xml) {
  return xml.replace(/(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/g, '$1$2');
}

function rewriteTableColumns(tableXml, columnIndex, mode) {
  const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(tableXml);
  let next = tableXml;
  if (grid) {
    const columns = [...grid[0].matchAll(/<w:gridCol\b[^>]*\/>/g)].map((match) => match[0]);
    if (mode === 'delete') {
      if (columns.length <= 1) throw new Error('A table must keep at least one column');
      columns.splice(columnIndex - 1, 1);
    } else {
      columns.splice(columnIndex - 1, 0, columns[columnIndex - 1] || columns.at(-1) || '<w:gridCol/>');
    }
    next = next.replace(grid[0], `<w:tblGrid>${columns.join('')}</w:tblGrid>`);
  }
  return next.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((match) => match[0]);
    if (!cells.length) return row;
    if (mode === 'delete') {
      if (cells.length <= 1) return row;
      cells.splice(columnIndex - 1, 1);
    } else {
      const template = cells[columnIndex - 1] || cells.at(-1);
      cells.splice(columnIndex - 1, 0, blankTableCells(template));
    }
    const open = /^<w:tr(?:\s[^>]*)?>/.exec(row)?.[0] || '<w:tr>';
    const properties = /<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>/.exec(row)?.[0] || '';
    return `${open}${properties}${cells.join('')}</w:tr>`;
  });
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

function paragraphFormatXml(properties = {}, numbering = null) {
  const border = properties.border || null;
  const tabs = Array.isArray(properties.tabStops) ? properties.tabStops : [];
  return [
    properties.keepWithNext === true ? '<w:keepNext/>' : '',
    properties.pageBreakBefore === true ? '<w:pageBreakBefore/>' : '',
    numbering
      ? `<w:numPr><w:ilvl w:val="${Math.max(0, Math.min(2, Number(numbering.level) || 0))}"/>`
        + `<w:numId w:val="${numbering.numId}"/></w:numPr>`
      : '',
    border ? `<w:pBdr><w:${xmlEncode(border.side || 'bottom')} w:val="${xmlEncode(border.style || 'single')}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${Math.max(0, Number(border.space) || 1)}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>` : '',
    tabs.length ? `<w:tabs>${tabs.map((tab) => `<w:tab w:val="${xmlEncode(tab.alignment || 'left')}" w:pos="${pointsToTwips(tab.position || 0)}"${tab.leader ? ` w:leader="${xmlEncode(tab.leader)}"` : ''}/>`).join('')}</w:tabs>` : '',
    (properties.spacingBefore !== undefined || properties.spacingAfter !== undefined || properties.lineSpacing !== undefined)
      ? `<w:spacing${properties.spacingBefore !== undefined ? ` w:before="${Math.max(0, Math.round(Number(properties.spacingBefore) * 20))}"` : ''}${properties.spacingAfter !== undefined ? ` w:after="${Math.max(0, Math.round(Number(properties.spacingAfter) * 20))}"` : ''}${properties.lineSpacing !== undefined ? ` w:line="${Math.max(1, Math.round(Number(properties.lineSpacing) * 20))}" w:lineRule="auto"` : ''}/>`
      : '',
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
  ].join('');
}

async function applyDocx(zip, operations) {
  const parts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name));
  const results = [];
  let tracking = await documentTracksChanges(zip);
  for (const op of operations) {
    if (op.op === 'track_changes') {
      const enabled = op.enabled !== false;
      const part = 'word/settings.xml';
      let settings = await zipText(zip, part);
      if (!settings) {
        settings = `${XML_HEADER}<w:settings xmlns:w="${WORD_MAIN_NS}"></w:settings>`;
        await ensureContentTypeOverride(zip, `/${part}`, SETTINGS_CONTENT_TYPE);
        await addPackageRelationship(
          zip,
          partRelationshipPath('word/document.xml'),
          `${OFFICE_RELATIONSHIP_BASE}/settings`,
          'settings.xml',
        );
      }
      zip.file(part, upsertOrderedChild(
        settings,
        SETTINGS_ORDER,
        'w:trackRevisions',
        enabled ? '<w:trackRevisions/>' : '',
      ));
      tracking = enabled;
      results.push({ op: op.op, changed: true, enabled });
      continue;
    }
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
      const properties = op.properties || {};
      const listKind = String(properties.listKind || '').toLowerCase();
      const numbering = listKind
        ? await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet')
        : null;
      const style = docxStyleId(op.style || properties.style || (numbering ? 'List Paragraph' : ''));
      const format = paragraphFormatXml(
        properties,
        numbering ? { numId: numbering.numId, level: properties.listLevel } : null,
      );
      const paragraphProperties = style || format
        ? `<w:pPr>${style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : ''}${format}</w:pPr>`
        : '';
      const runProperties = wordRunProperties(properties);
      const run = `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}`
        + `<w:t${/^\s|\s$/.test(String(op.text || '')) ? ' xml:space="preserve"' : ''}>${xmlEncode(op.text || '')}</w:t></w:r>`;
      const content = tracking
        ? `<w:ins ${revisionAttributes(nextRevisionId(current), properties.author)}>${run}</w:ins>`
        : run;
      const block = `<w:p>${paragraphProperties}${content}</w:p>`;
      zip.file('word/document.xml', appendDocxBlock(current, block));
      results.push({ op: op.op, changed: true, style: style || '', ...(tracking ? { tracked: true } : {}) });
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
      } else {
        current = appendDocxBlock(current, table);
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
      if (op.op === 'remove_paragraph' && tracking) {
        const id = nextRevisionId(current);
        const marked = markRunsDeleted(paragraph.xml, id, op.author);
        const mark = `<w:del ${revisionAttributes(id + 900, op.author)}/>`;
        const withMark = /<w:pPr(?:\s[^>]*)?>/.test(marked)
          ? (/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>\s*<\/w:pPr>/.test(marked)
            ? marked.replace(/(<w:rPr(?:\s[^>]*)?>)/, `$1${mark}`)
            : marked.replace(/<\/w:pPr>/, `<w:rPr>${mark}</w:rPr></w:pPr>`))
          : marked.replace(/^(<w:p(?:\s[^>]*)?>)/, `$1<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`);
        nextInner = `${nextInner.slice(0, paragraph.start)}${withMark}${nextInner.slice(paragraph.end)}`;
      } else if (op.op === 'remove_paragraph') {
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
            ? nextCell.replace(/<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/, (_, inner) => {
              const fonts = /<w:rFonts\b[^>]*\/>/.exec(inner);
              return fonts
                ? `<w:rPr>${fonts[0]}${runFormat}${inner.replace(fonts[0], '')}</w:rPr>`
                : `<w:rPr>${runFormat}${inner}</w:rPr>`;
            })
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
      const properties = op.properties || {};
      const listKind = String(properties.listKind || '').toLowerCase();
      const numbering = listKind
        ? await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet')
        : null;
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const existingStyle = /<w:pStyle\b[^>]*\/>/.exec(paragraph.xml)?.[0] || '';
      const nextParagraph = replaceWordProperties(
        paragraph.xml,
        'p',
        'pPr',
        `${existingStyle}${paragraphFormatXml(
          properties,
          numbering ? { numId: numbering.numId, level: properties.listLevel } : null,
        )}`,
      );
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextParagraph !== paragraph.xml, paragraph: Number(op.paragraph) });
      continue;
    }
    if (op.op === 'add_image') {
      const current = await zipText(zip, 'word/document.xml');
      const media = await addDocumentImage(zip, op.path);
      const pixels = media.pixels;
      const width = Number(op.width) > 0
        ? Number(op.width)
        : (pixels ? pixels.width * PIXELS_TO_POINTS : 240);
      const height = Number(op.height) > 0
        ? Number(op.height)
        : (pixels ? pixels.height * PIXELS_TO_POINTS * (Number(op.width) > 0 ? Number(op.width) / (pixels.width * PIXELS_TO_POINTS) : 1) : 180);
      const id = [...current.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)]
        .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
      const block = `<w:p><w:r>${wordDrawingXml({
        id,
        embedId: media.relationshipId,
        name: media.name,
        width,
        height,
      })}</w:r></w:p>`;
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, image: media.part, width, height });
      continue;
    }
    if (op.op === 'set_page') {
      const current = await zipText(zip, 'word/document.xml');
      const properties = op.properties || {};
      const orientation = String(properties.orientation || '').toLowerCase();
      if (orientation && !['portrait', 'landscape'].includes(orientation)) {
        throw new Error('set_page orientation must be portrait or landscape');
      }
      const next = writeSectionProperties(current, (section) => {
        const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
        let pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || 11_906;
        let pageHeight = Number(/\bw:h="(\d+)"/.exec(size)?.[1]) || 16_838;
        if (orientation === 'landscape' && pageWidth < pageHeight) {
          [pageWidth, pageHeight] = [pageHeight, pageWidth];
        }
        if (orientation === 'portrait' && pageWidth > pageHeight) {
          [pageWidth, pageHeight] = [pageHeight, pageWidth];
        }
        const margins = /<w:pgMar\b([^>]*)\/>/.exec(section)?.[1] || '';
        const margin = (name, key, fallback) => {
          const requested = properties[key];
          if (requested != null) return Math.max(0, Math.round(Number(requested) * 20));
          const existing = new RegExp(`\\bw:${name}="(-?\\d+)"`).exec(margins)?.[1];
          return existing == null ? fallback : Number(existing);
        };
        const withSize = upsertSectionChild(
          section,
          'pgSz',
          `<w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"${orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`,
          ['type'],
        );
        return upsertSectionChild(
          withSize,
          'pgMar',
          `<w:pgMar w:top="${margin('top', 'topMargin', 1418)}" w:right="${margin('right', 'rightMargin', 1418)}"`
          + ` w:bottom="${margin('bottom', 'bottomMargin', 1418)}" w:left="${margin('left', 'leftMargin', 1418)}"`
          + ` w:header="${margin('header', 'headerMargin', 709)}" w:footer="${margin('footer', 'footerMargin', 709)}" w:gutter="0"/>`,
          ['pgSz'],
        );
      });
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: next !== current, orientation: orientation || 'unchanged' });
      continue;
    }
    if (['insert_table_row', 'delete_table_row', 'insert_table_column', 'delete_table_column'].includes(op.op)) {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      let nextTable = table[0];
      if (op.op === 'insert_table_row' || op.op === 'delete_table_row') {
        const rows = [...table[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)];
        if (!rows.length) throw new Error(`DOCX table ${op.table} has no rows`);
        if (op.op === 'delete_table_row') {
          if (rows.length <= 1) throw new Error('A table must keep at least one row');
          const row = rows[Number(op.row) - 1];
          if (!row) throw new Error(`DOCX table row ${op.row} not found`);
          nextTable = `${table[0].slice(0, row.index)}${table[0].slice(row.index + row[0].length)}`;
        } else {
          const position = Math.max(1, Math.min(Number(op.row) || rows.length + 1, rows.length + 1));
          const template = rows[Math.min(position, rows.length) - 1];
          const blank = blankTableCells(template[0]);
          nextTable = position > rows.length
            ? table[0].replace(/<\/w:tbl>$/, `${blank}</w:tbl>`)
            : `${table[0].slice(0, template.index)}${blank}${table[0].slice(template.index)}`;
        }
      } else {
        const columnIndex = Math.max(1, Number(op.column) || 1);
        nextTable = rewriteTableColumns(
          table[0],
          columnIndex,
          op.op === 'delete_table_column' ? 'delete' : 'insert',
        );
      }
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table) });
      continue;
    }
    if (op.op === 'set_list') {
      const kind = String(op.kind || 'bullet').toLowerCase() === 'number' ? 'number' : 'bullet';
      const numbering = await ensureNumbering(zip, kind);
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const level = Math.max(0, Math.min(2, Number(op.level) || 0));
      const existing = /<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(paragraph.xml)?.[1] || '';
      const cleaned = existing
        .replace(/<w:numPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:numPr>)/, '')
        .replace(/<w:pStyle\b[^>]*\/>/, '');
      const properties = '<w:pStyle w:val="ListParagraph"/>'
        + `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numbering.numId}"/></w:numPr>`
        + cleaned;
      const nextParagraph = replaceWordProperties(paragraph.xml, 'p', 'pPr', properties);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, paragraph: Number(op.paragraph), kind, numId: numbering.numId });
      continue;
    }
    if (op.op === 'add_hyperlink') {
      const address = String(op.address || '').trim();
      const display = String(op.display || address || '').trim();
      if (!address && !op.subAddress) throw new Error('add_hyperlink requires address or subAddress');
      if (!display) throw new Error('add_hyperlink requires display text');
      let current = await zipText(zip, 'word/document.xml');
      const relationshipId = address
        ? await addPackageRelationship(
          zip,
          partRelationshipPath('word/document.xml'),
          `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
          address,
          'External',
        )
        : '';
      const run = '<w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
        + `<w:t${/^\s|\s$/.test(display) ? ' xml:space="preserve"' : ''}>${xmlEncode(display)}</w:t></w:r>`;
      const link = `<w:hyperlink${relationshipId ? ` r:id="${relationshipId}"` : ''}`
        + `${op.subAddress ? ` w:anchor="${xmlEncode(op.subAddress)}"` : ''}>${run}</w:hyperlink>`;
      if (op.paragraph) {
        const model = docxBodyModel(current);
        const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
        if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
        const nextParagraph = paragraph.xml.replace(/<\/w:p>$/, `${link}</w:p>`);
        const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
        current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      } else {
        current = appendDocxBlock(current, `<w:p>${link}</w:p>`);
      }
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, address, display });
      continue;
    }
    if (op.op === 'set_font') {
      const find = String(op.find || '');
      if (!find) throw new Error('set_font requires non-empty find');
      const properties = wordRunProperties(op.properties || {});
      if (!properties) throw new Error('set_font requires at least one font property');
      let count = 0;
      for (const part of parts) {
        const current = await zipText(zip, part);
        if (!current) continue;
        const next = current.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) => {
          if (!paragraphTexts(run, 'w:t').join('').includes(find)) return run;
          count += 1;
          return replaceWordProperties(run, 'r', 'rPr', properties);
        });
        if (next !== current) zip.file(part, next);
      }
      results.push({ op: op.op, changed: count > 0, runs: count });
      continue;
    }
    if (op.op === 'add_comment' || op.op === 'add_provenance') {
      const text = op.op === 'add_provenance' ? provenanceCitation(op.source) : String(op.text || '');
      if (!text) throw new Error(`${op.op} requires ${op.op === 'add_provenance' ? 'source' : 'text'}`);
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraphs = model.blocks.filter((block) => block.name === 'w:p');
      const paragraph = op.op === 'add_provenance'
        ? paragraphs[Number(op.paragraph) - 1]
        : paragraphs.find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(String(op.find || '')));
      if (!paragraph) {
        throw new Error(op.op === 'add_provenance'
          ? `DOCX paragraph ${op.paragraph} not found`
          : `DOCX text not found for comment anchor: ${op.find}`);
      }
      const comments = await ensureCommentsPart(zip);
      const ids = [...comments.xml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const entry = `<w:comment w:id="${id}" w:author="${xmlEncode(op.author || 'Mixdog')}"`
        + ` w:date="${stamp}" w:initials="${xmlEncode(op.initials || 'MD')}">`
        + `<w:p xmlns:w14="${WORD_2010_NS}" w14:paraId="${commentParagraphId(id)}">`
        + `<w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:comment>`;
      zip.file(comments.part, comments.xml.replace('</w:comments>', `${entry}</w:comments>`));
      await registerCommentThread(zip, { commentId: id });
      const anchored = anchorDocxComment(paragraph.xml, id);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${anchored}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({
        op: op.op,
        changed: true,
        comment: id,
        ...(op.op === 'add_provenance' ? { target: `/body/p[${Number(op.paragraph)}]`, citation: text } : {}),
      });
      continue;
    }
    if (op.op === 'add_comment_reply' || op.op === 'set_comment_resolved') {
      const parent = Number(op.comment);
      if (!Number.isInteger(parent) || parent < 1) throw new Error(`${op.op} requires a positive comment id`);
      const comments = await ensureCommentsPart(zip);
      const parentPattern = new RegExp(`<w:comment\\b[^>]*\\bw:id="${parent}"[^>]*>[\\s\\S]*?<\\/w:comment>`);
      const parentEntry = parentPattern.exec(comments.xml);
      if (!parentEntry) throw new Error(`DOCX comment ${parent} not found`);
      if (op.op === 'set_comment_resolved') {
        await registerCommentThread(zip, { commentId: parent, done: op.resolved !== false });
        results.push({ op: op.op, changed: true, comment: parent, resolved: op.resolved !== false });
        continue;
      }
      const text = String(op.text || '');
      if (!text) throw new Error('add_comment_reply requires text');
      const ids = [...comments.xml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const reply = `<w:comment w:id="${id}" w:author="${xmlEncode(op.author || 'Mixdog')}"`
        + ` w:date="${stamp}" w:initials="${xmlEncode(op.initials || 'MD')}">`
        + `<w:p xmlns:w14="${WORD_2010_NS}" w14:paraId="${commentParagraphId(id)}">`
        + `<w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:comment>`;
      zip.file(comments.part, comments.xml.replace('</w:comments>', `${reply}</w:comments>`));
      await registerCommentThread(zip, { commentId: id, parentId: parent });
      const current = await zipText(zip, 'word/document.xml');
      const anchor = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${parent}"[^>]*\\/>`).exec(current);
      if (anchor) {
        const position = anchor.index;
        const marks = `<w:commentRangeStart w:id="${id}"/><w:commentRangeEnd w:id="${id}"/>`
          + `<w:r><w:commentReference w:id="${id}"/></w:r>`;
        zip.file('word/document.xml', `${current.slice(0, position)}${marks}${current.slice(position)}`);
      }
      results.push({ op: op.op, changed: true, comment: id, parent });
      continue;
    }
    if (op.op === 'delete_comment') {
      const id = Number(op.comment);
      if (!Number.isInteger(id) || id < 1) throw new Error('delete_comment requires a positive comment id');
      const comments = await ensureCommentsPart(zip);
      const pattern = new RegExp(`<w:comment\\b[^>]*\\bw:id="${id}"[^>]*>[\\s\\S]*?<\\/w:comment>`);
      if (!pattern.test(comments.xml)) throw new Error(`DOCX comment ${id} not found`);
      zip.file(comments.part, comments.xml.replace(pattern, ''));
      const current = await zipText(zip, 'word/document.xml');
      const next = current
        .replace(new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
        .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
        .replace(new RegExp(`<w:r>(?:(?!<\\/w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*\\bw:id="${id}"[^>]*\\/>[\\s\\S]*?<\\/w:r>`, 'g'), '');
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, comment: id });
      continue;
    }
    if (op.op === 'resolve_revision' || op.op === 'resolve_revisions') {
      const resolution = String(op.resolution || 'accept').toLowerCase();
      if (!['accept', 'reject'].includes(resolution)) {
        throw new Error(`${op.op} resolution must be accept or reject`);
      }
      const target = op.op === 'resolve_revision' ? Math.max(1, Number(op.revision) || 1) : 0;
      let resolved = 0;
      let index = 0;
      let paragraphMarks = 0;
      let current = await zipText(zip, 'word/document.xml');
      const next = current.replace(/<w:(ins|del)\b[^>]*>[\s\S]*?<\/w:\1>/g, (block, tag) => {
        index += 1;
        if (target && index !== target) return block;
        resolved += 1;
        const inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf(`</w:${tag}>`));
        if (tag === 'ins') return resolution === 'accept' ? inner : '';
        return resolution === 'accept'
          ? ''
          : inner.replace(/<w:delText/g, '<w:t').replace(/<\/w:delText>/g, '</w:t>');
      });
      current = next.replace(/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:del\b[^>]*\/>[\s\S]*?<\/w:rPr>/g, (block) => {
        if (target) return block;
        paragraphMarks += 1;
        return block.replace(/<w:del\b[^>]*\/>/, '');
      });
      if (!resolved && target) throw new Error(`DOCX revision ${target} not found`);
      zip.file('word/document.xml', current);
      results.push({
        op: op.op,
        changed: resolved > 0 || paragraphMarks > 0,
        resolution,
        resolved,
        ...(paragraphMarks ? {
          paragraphMarks,
          note: 'Deleted paragraph marks were cleared without merging the paragraphs; review the layout.',
        } : {}),
      });
      continue;
    }
    if (op.op === 'fit_table') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const section = trailingSectionProperties(current).match?.[0] || '';
      const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
      const margins = /<w:pgMar\b([^>]*)\/>/.exec(section)?.[1] || '';
      const pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || 11_906;
      const marginLeft = Number(/\bw:left="(-?\d+)"/.exec(margins)?.[1]) || 1418;
      const marginRight = Number(/\bw:right="(-?\d+)"/.exec(margins)?.[1]) || 1418;
      const usable = Math.max(720, pageWidth - marginLeft - marginRight);
      const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(table[0]);
      const columns = grid ? [...grid[0].matchAll(/<w:gridCol\b([^>]*)\/>/g)] : [];
      const count = Math.max(1, columns.length);
      const current_widths = columns.map((column) => Number(/\bw:w="(\d+)"/.exec(column[1])?.[1]) || 0);
      const total = current_widths.reduce((sum, width) => sum + width, 0);
      const widths = total > 0
        ? current_widths.map((width) => Math.max(240, Math.round((width / total) * usable)))
        : Array.from({ length: count }, () => Math.round(usable / count));
      let nextTable = grid
        ? table[0].replace(grid[0], `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`)
        : table[0];
      const declared = `<w:tblW w:w="${usable}" w:type="dxa"/>`;
      let tableProperties = op.properties
        ? wordTableProperties(op.properties)
        : /<w:tblPr>([\s\S]*?)<\/w:tblPr>/.exec(nextTable)?.[1] || '';
      if (/<w:tblW\b[^>]*\/>/.test(tableProperties)) {
        tableProperties = tableProperties.replace(/<w:tblW\b[^>]*\/>/, declared);
      } else if (/<w:tblStyle\b[^>]*\/>/.test(tableProperties)) {
        tableProperties = tableProperties.replace(/(<w:tblStyle\b[^>]*\/>)/, `$1${declared}`);
      } else {
        tableProperties = `${declared}${tableProperties}`;
      }
      nextTable = replaceWordProperties(
        nextTable,
        'tbl',
        'tblPr',
        tableProperties,
      );
      nextTable = nextTable.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) => {
        let index = 0;
        return row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (cell) => {
          const existing = /<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(cell)?.[1] || '';
          const keep = (pattern) => pattern.exec(existing)?.[0] || '';
          const span = Math.max(1, Number(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(existing)?.[1]) || 1);
          const width = widths.slice(index, index + span).reduce((sum, column) => sum + (column || 0), 0)
            || widths.at(-1);
          index += span;
          return replaceWordProperties(
            cell,
            'tc',
            'tcPr',
            `<w:tcW w:w="${width}" w:type="dxa"/>`
            + keep(/<w:gridSpan\b[^>]*\/>/)
            + keep(/<w:hMerge\b[^>]*\/>/)
            + keep(/<w:vMerge\b[^>]*\/>/)
            + keep(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/)
            + keep(/<w:shd\b[^>]*\/>/)
            + keep(/<w:vAlign\b[^>]*\/>/),
          );
        });
      });
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, table: Number(op.table), width: usable, columns: count });
      continue;
    }
    if (op.op === 'insert_toc') {
      const current = await zipText(zip, 'word/document.xml');
      const lower = Math.max(1, Number(op.lowerHeadingLevel) || 1);
      const upper = Math.max(lower, Number(op.upperHeadingLevel) || 3);
      const instruction = ` TOC \\o "${lower}-${upper}" \\h \\z \\u `;
      const block = `<w:p><w:fldSimple w:instr="${xmlEncode(instruction)}">`
        + '<w:r><w:t>Update this field in Word to build the table of contents.</w:t></w:r></w:fldSimple></w:p>';
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, levels: `${lower}-${upper}` });
      continue;
    }
    if (op.op === 'add_bookmark') {
      const name = String(op.name || '').trim();
      if (!name) throw new Error('add_bookmark requires name');
      let current = await zipText(zip, 'word/document.xml');
      const ids = [...current.matchAll(/<w:bookmarkStart\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const model = docxBodyModel(current);
      const paragraphs = model.blocks.filter((block) => block.name === 'w:p');
      const paragraph = op.paragraph
        ? paragraphs[Number(op.paragraph) - 1]
        : paragraphs.find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(String(op.find || '')));
      if (!paragraph) throw new Error('add_bookmark could not resolve a target paragraph');
      const opening = /^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(paragraph.xml)?.[0] || '<w:p>';
      const marked = `${opening}<w:bookmarkStart w:id="${id}" w:name="${xmlEncode(name)}"/>`
        + `${paragraph.xml.slice(opening.length)}`.replace(/<\/w:p>$/, `<w:bookmarkEnd w:id="${id}"/></w:p>`);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${marked}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, name, bookmark: id });
      continue;
    }
    if (op.op === 'set_header_footer') {
      const current = await zipText(zip, 'word/document.xml');
      const header = op.header !== false;
      const kind = ['default', 'first', 'even'].includes(String(op.kind || '').toLowerCase())
        ? String(op.kind).toLowerCase()
        : 'default';
      const written = await writeHeaderFooterPart(zip, {
        header,
        body: wordParagraph(op.text, { alignment: header ? '' : 'center' }),
      });
      const next = writeSectionProperties(current, (section) => {
        const referenced = upsertSectionReference(
          section,
          header ? 'headerReference' : 'footerReference',
          kind,
          written.relationshipId,
        );
        return kind === 'first' && !/<w:titlePg\b/.test(referenced)
          ? upsertSectionChild(referenced, 'titlePg', '<w:titlePg/>', ['pgMar', 'pgSz'])
          : referenced;
      });
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, part: written.part, header, kind });
      continue;
    }
    if (op.op === 'add_page_numbers') {
      const current = await zipText(zip, 'word/document.xml');
      const header = false;
      const kind = ['default', 'first', 'even'].includes(String(op.kind || '').toLowerCase())
        ? String(op.kind).toLowerCase()
        : 'default';
      const alignment = ['left', 'center', 'right'].includes(String(op.alignment || '').toLowerCase())
        ? String(op.alignment).toLowerCase()
        : 'center';
      const prefix = op.prefix ? `<w:r><w:t xml:space="preserve">${xmlEncode(op.prefix)} </w:t></w:r>` : '';
      const separator = op.includeTotal === true
        ? `<w:r><w:t xml:space="preserve"> ${xmlEncode(op.separator || '/')} </w:t></w:r>`
        + '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        : '';
      const body = `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>${prefix}`
        + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        + `${separator}</w:p>`;
      const written = await writeHeaderFooterPart(zip, { header, body });
      const next = writeSectionProperties(current, (section) => upsertSectionReference(
        section,
        header ? 'headerReference' : 'footerReference',
        kind,
        written.relationshipId,
      ));
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, part: written.part, includeTotal: op.includeTotal === true });
      continue;
    }
    if (op.op === 'insert_break') {
      const current = await zipText(zip, 'word/document.xml');
      const kind = String(op.kind || 'page').toLowerCase();
      if (!['page', 'column'].includes(kind)) {
        throw new Error('Portable insert_break supports page or column breaks');
      }
      const block = `<w:p><w:r><w:br w:type="${kind}"/></w:r></w:p>`;
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, kind });
      continue;
    }
    throw new Error(`Portable DOCX backend does not support operation: ${op.op}`);
  }
  return results;
}

const WORKSHEET_SECTIONS = Object.freeze([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter',
  'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr',
  'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions',
  'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing',
  'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst',
]);
const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const WORKSHEET_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const MAX_STYLED_CELLS = 20_000;
const TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';

function excelPasswordHash(password) {
  const text = String(password ?? '');
  let hash = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
    hash ^= text.charCodeAt(index);
  }
  hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
  hash ^= text.length;
  hash ^= 0xCE4B;
  return hash.toString(16).toUpperCase().padStart(4, '0');
}

async function ensureWorksheetDrawing(zip, sheet, worksheetXml) {
  const relationships = partRelationshipPath(sheet.path);
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/drawing"[^>]*\bTarget="([^"]+)"/
    .exec(await zipText(zip, relationships))?.[1];
  if (linked) {
    return {
      part: posix.normalize(posix.join(posix.dirname(sheet.path), linked)),
      worksheet: worksheetXml,
    };
  }
  let ordinal = 1;
  while (zip.file(`xl/drawings/drawing${ordinal}.xml`)) ordinal += 1;
  const part = `xl/drawings/drawing${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<xdr:wsDr xmlns:xdr="${SPREADSHEET_DRAWING_NS}" xmlns:a="${DRAWING_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}"></xdr:wsDr>`);
  await ensureContentTypeOverride(zip, `/${part}`, 'application/vnd.openxmlformats-officedocument.drawing+xml');
  const relationshipId = await addPackageRelationship(
    zip,
    relationships,
    `${OFFICE_RELATIONSHIP_BASE}/drawing`,
    posix.relative(posix.dirname(sheet.path), part),
  );
  return {
    part,
    worksheet: upsertWorksheetSection(worksheetXml, 'drawing', `<drawing r:id="${relationshipId}"/>`),
  };
}

const SHEET_COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';
const VML_SHELL = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
  + ' xmlns:x="urn:schemas-microsoft-com:office:excel">'
  + '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>'
  + '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">'
  + '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
  + '</xml>';

function vmlNoteShape(id, parsed) {
  const column = columnNumber(parsed.col) - 1;
  const row = parsed.row - 1;
  return `<v:shape id="_x0000_s${id}" type="#_x0000_t202"`
    + ' style="position:absolute;margin-left:60pt;margin-top:2pt;width:120pt;height:60pt;z-index:1;visibility:hidden"'
    + ' fillcolor="#ffffe1" o:insetmode="auto">'
    + '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>'
    + '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>'
    + '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>'
    + `<x:Anchor>${column + 1},15,${row},2,${column + 3},15,${row + 3},16</x:Anchor>`
    + `<x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${column}</x:Column></x:ClientData>`
    + '</v:shape>';
}

async function ensureWorksheetComments(zip, sheet, worksheetXml) {
  const relationships = partRelationshipPath(sheet.path);
  const rels = await zipText(zip, relationships);
  const resolve = (target) => posix.normalize(posix.join(posix.dirname(sheet.path), target));
  let commentsPart = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  let vmlPart = /<Relationship\b[^>]*\bType="[^"]*\/vmlDrawing"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  commentsPart = commentsPart ? resolve(commentsPart) : '';
  vmlPart = vmlPart ? resolve(vmlPart) : '';
  let worksheet = worksheetXml;
  if (!commentsPart) {
    let ordinal = 1;
    while (zip.file(`xl/comments${ordinal}.xml`)) ordinal += 1;
    commentsPart = `xl/comments${ordinal}.xml`;
    zip.file(commentsPart, `${XML_HEADER}<comments xmlns="${SPREADSHEET_MAIN}">`
      + '<authors><author>Mixdog</author></authors><commentList></commentList></comments>');
    await ensureContentTypeOverride(zip, `/${commentsPart}`, SHEET_COMMENTS_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      relationships,
      `${OFFICE_RELATIONSHIP_BASE}/comments`,
      posix.relative(posix.dirname(sheet.path), commentsPart),
    );
  }
  if (!vmlPart) {
    let ordinal = 1;
    while (zip.file(`xl/drawings/vmlDrawing${ordinal}.vml`)) ordinal += 1;
    vmlPart = `xl/drawings/vmlDrawing${ordinal}.vml`;
    zip.file(vmlPart, VML_SHELL);
    await ensureDefaultContentType(zip, 'vml', 'application/vnd.openxmlformats-officedocument.vmlDrawing');
    const relationshipId = await addPackageRelationship(
      zip,
      relationships,
      `${OFFICE_RELATIONSHIP_BASE}/vmlDrawing`,
      posix.relative(posix.dirname(sheet.path), vmlPart),
    );
    worksheet = upsertWorksheetSection(worksheet, 'legacyDrawing', `<legacyDrawing r:id="${relationshipId}"/>`);
  }
  return { commentsPart, vmlPart, worksheet };
}

async function writeWorksheetNote(zip, sheet, worksheetXml, { cell, text, author = 'Mixdog', append = false }) {
  const parsed = parseCellRef(cell);
  const context = await ensureWorksheetComments(zip, sheet, worksheetXml);
  let comments = await zipText(zip, context.commentsPart);
  const authors = [...comments.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((match) => xmlDecode(match[1]));
  let authorId = authors.indexOf(author);
  if (authorId < 0) {
    authors.push(author);
    authorId = authors.length - 1;
    comments = comments.replace(
      /<authors>[\s\S]*?<\/authors>/,
      `<authors>${authors.map((entry) => `<author>${xmlEncode(entry)}</author>`).join('')}</authors>`,
    );
  }
  const pattern = new RegExp(`<comment\\b[^>]*\\bref="${parsed.ref}"[^>]*>[\\s\\S]*?<\\/comment>`);
  const existing = pattern.exec(comments);
  const previous = existing
    ? [...existing[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join('')
    : '';
  if (append && previous.includes(text)) return { worksheet: context.worksheet, changed: false };
  const body = append && previous ? `${previous}\n${text}` : text;
  if (existing) comments = comments.replace(pattern, '');
  const entry = `<comment ref="${parsed.ref}" authorId="${authorId}">`
    + `<text><r><t xml:space="preserve">${xmlEncode(body)}</t></r></text></comment>`;
  zip.file(context.commentsPart, comments.replace('</commentList>', `${entry}</commentList>`));
  if (!existing) {
    const vml = await zipText(zip, context.vmlPart);
    const shapeId = 1025 + (vml.match(/<v:shape\b/g) || []).length;
    zip.file(context.vmlPart, vml.replace('</xml>', `${vmlNoteShape(shapeId, parsed)}</xml>`));
  }
  return { worksheet: context.worksheet, changed: true, cell: parsed.ref };
}

function safeWorkbookTableName(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_]/g, '');
  const named = /^[A-Za-z_]/.test(cleaned) ? cleaned : `Table${cleaned}`;
  return named.slice(0, 255) || 'Table1';
}

function worksheetSection(xml, name) {
  return new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`).exec(xml);
}

function upsertWorksheetSection(xml, name, element) {
  const existing = worksheetSection(xml, name);
  const base = existing
    ? `${xml.slice(0, existing.index)}${xml.slice(existing.index + existing[0].length)}`
    : xml;
  if (!element) return base;
  const position = WORKSHEET_SECTIONS.indexOf(name);
  for (const candidate of WORKSHEET_SECTIONS.slice(position + 1)) {
    const found = worksheetSection(base, candidate);
    if (found) return `${base.slice(0, found.index)}${element}${base.slice(found.index)}`;
  }
  return base.replace(/<\/worksheet>\s*$/, `${element}</worksheet>`);
}

function mergedRanges(xml) {
  const section = worksheetSection(xml, 'mergeCells');
  if (!section) return [];
  return [...section[0].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)]
    .map((match) => match[1].toUpperCase());
}

function writeMergedRanges(xml, ranges) {
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
  const body = containerBody(rowXml, 'row')
    .replace(/(<c\b[^>]*?\br=")([A-Z]+)\d+(")/g, (_match, lead, column, tail) => `${lead}${column}${index}${tail}`);
  return `<row${attrs}>${body}</row>`;
}

function replaceSheetData(xml, inner) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  return `${xml.slice(0, sheetData.index)}<sheetData>${inner}</sheetData>`
    + xml.slice(sheetData.index + sheetData[0].length);
}

function shiftWorksheetRows(xml, from, count) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  const inner = containerBody(sheetData[0], 'sheetData');
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

function shiftWorksheetColumns(xml, from, count) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  const inner = containerBody(sheetData[0], 'sheetData');
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

function appendWorksheetSection(xml, name, element) {
  const existing = [...xml.matchAll(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g'))];
  if (!existing.length) return upsertWorksheetSection(xml, name, element);
  const last = existing.at(-1);
  const position = last.index + last[0].length;
  return `${xml.slice(0, position)}${element}${xml.slice(position)}`;
}

function appendDifferentialFormat(stylesXml, { color = '', fillColor = '' }) {
  const font = normalizeColor(color);
  const fill = normalizeColor(fillColor);
  const dxf = '<dxf>'
    + (font ? `<font><color rgb="${font}"/></font>` : '')
    + (fill ? `<fill><patternFill><bgColor rgb="${fill}"/></patternFill></fill>` : '')
    + '</dxf>';
  const section = /<dxfs\b[^>]*?(?:\/>|>[\s\S]*?<\/dxfs>)/.exec(stylesXml);
  const items = section && !section[0].endsWith('/>')
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

function mergedCellAnchor(xml, reference) {
  const parsed = parseCellRef(reference);
  const column = columnNumber(parsed.col);
  for (const entry of mergedRanges(xml)) {
    const area = parseAreaRange(entry);
    if (
      area.startCol <= column && column <= area.endCol
      && area.startRow <= parsed.row && parsed.row <= area.endRow
    ) {
      return area.startCol === column && area.startRow === parsed.row;
    }
  }
  return true;
}

function sheetViewParts(view) {
  const open = /^<sheetView\b([^>]*?)(\/>|>)/.exec(view);
  if (!open) throw new Error('Worksheet view is malformed');
  return {
    attrs: open[1],
    body: open[2] === '/>' ? '' : view.slice(open[0].length, view.lastIndexOf('</sheetView>')),
  };
}

function composeSheetView(attrs, body) {
  return body ? `<sheetView${attrs}>${body}</sheetView>` : `<sheetView${attrs}/>`;
}

function updateSheetView(xml, mutate) {
  const section = worksheetSection(xml, 'sheetViews');
  const current = section
    ? /<sheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetView>)/.exec(section[0])?.[0] || ''
    : '';
  const next = mutate(current || '<sheetView workbookViewId="0"/>');
  return upsertWorksheetSection(xml, 'sheetViews', `<sheetViews>${next}</sheetViews>`);
}

function freezePaneXml(row, column) {
  const ySplit = Math.max(0, (Number(row) || 0) - 1);
  const xSplit = Math.max(0, (Number(column) || 0) - 1);
  if (!ySplit && !xSplit) return '';
  const topLeft = `${columnLabel(xSplit + 1)}${ySplit + 1}`;
  const activePane = ySplit && xSplit ? 'bottomRight' : ySplit ? 'bottomLeft' : 'topRight';
  return `<pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''}`
    + ` topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>`;
}

function parseAreaRange(range) {
  const text = String(range || '').trim().toUpperCase();
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
  throw new Error(`Unsupported range: ${range}`);
}

function displayWidth(text) {
  let width = 0;
  for (const character of String(text ?? '')) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character)
      ? 2
      : 1;
  }
  return width;
}

function writeColumnWidths(xml, widths) {
  if (!widths.size) return xml;
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
  for (const [column, width] of widths) {
    entries.set(column, ` min="${column}" max="${column}" width="${width}" customWidth="1"`);
  }
  const body = [...entries.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([column, attrs]) => `<col${setXmlAttribute(setXmlAttribute(attrs, 'min', column), 'max', column)}/>`)
    .join('');
  return upsertWorksheetSection(xml, 'cols', `<cols>${body}</cols>`);
}

function quoteSheetName(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}

function absoluteRange(range) {
  return String(range)
    .split(':')
    .map((part) => part.replace(/^([A-Za-z]+)(\d+)$/, '$$$1$$$2'))
    .join(':');
}

function upsertDefinedName(xml, entry, matches) {
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

function nextRelationshipId(rels) {
  const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
  return `rId${Math.max(0, ...ids) + 1}`;
}

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

async function applyXlsx(zip, operations) {
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

const PRESENTATION_NAMESPACES = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}"`
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PACKAGE_RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const NOTES_MASTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const IMAGE_CONTENT_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
});
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function emptyGroupShape() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

async function presentationSlides(zip) {
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const rels = relationshipMap(await zipText(zip, 'ppt/_rels/presentation.xml.rels'));
  const slides = [];
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*?)\/>/g)) {
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1] || '';
    const target = rid ? rels.get(rid) : '';
    if (!target) continue;
    slides.push({
      id: Number(/\bid="(\d+)"/.exec(match[1])?.[1]) || 0,
      rid,
      path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target)),
    });
  }
  if (slides.length) return slides;
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]))
    .map((path) => ({ id: 0, rid: '', path }));
}

function slidePath(slides, number) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  return slide.path;
}

async function ensureContentTypeOverride(zip, part, type) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  if (xml.includes(`PartName="${part}"`)) return;
  zip.file(path, xml.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`));
}

async function removeContentTypeOverride(zip, part) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  zip.file(path, xml.replace(new RegExp(`<Override\\b[^>]*\\bPartName="${tagPattern(part)}"[^>]*\\/>`), ''));
}

async function ensureDefaultContentType(zip, extension, type) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  if (new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"`, 'i').test(xml)) return;
  zip.file(path, xml.replace(/<Types\b[^>]*>/, `$&<Default Extension="${extension}" ContentType="${type}"/>`));
}

async function addPackageRelationship(zip, relsPath, type, target, mode = '') {
  const existing = await zipText(zip, relsPath);
  const xml = existing || `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"></Relationships>`;
  const id = nextRelationshipId(xml);
  const relationship = `<Relationship Id="${id}" Type="${type}" Target="${xmlEncode(target)}"`
    + `${mode ? ` TargetMode="${mode}"` : ''}/>`;
  zip.file(relsPath, xml.replace('</Relationships>', `${relationship}</Relationships>`));
  return id;
}

async function removePackageRelationship(zip, relsPath, id) {
  const xml = await zipText(zip, relsPath);
  if (!xml) return;
  zip.file(relsPath, xml.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${tagPattern(id)}"[^>]*\\/>`), ''));
}

function partRelationshipPath(part) {
  return `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
}

async function slideLayoutParts(zip) {
  const paths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]));
  const layouts = [];
  for (const path of paths) {
    const xml = await zipText(zip, path);
    layouts.push({
      path,
      name: xmlDecode(/<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
      type: /<p:sldLayout\b[^>]*\btype="([^"]*)"/.exec(xml)?.[1] || '',
    });
  }
  return layouts;
}

function selectSlideLayout(layouts, requested) {
  if (!layouts.length) throw new Error('Presentation has no slide layout for a new slide');
  const value = String(requested ?? '').trim();
  if (!value) return layouts.find((layout) => layout.type === 'blank') || layouts[0];
  if (/^\d+$/.test(value)) {
    const found = layouts[Number(value) - 1];
    if (!found) throw new Error(`Slide layout ${value} not found`);
    return found;
  }
  const matched = layouts.find((layout) => layout.name.toLowerCase() === value.toLowerCase())
    || layouts.find((layout) => layout.type.toLowerCase() === value.toLowerCase());
  if (!matched) {
    throw new Error(`Slide layout not found: ${value}. Available: ${layouts.map((layout) => layout.name || layout.type || '(unnamed)').join(', ')}`);
  }
  return matched;
}

function writeSlideIdList(presentation, entries) {
  const element = `<p:sldIdLst>${entries.join('')}</p:sldIdLst>`;
  const existing = /<p:sldIdLst\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldIdLst>)/.exec(presentation);
  if (existing) {
    return `${presentation.slice(0, existing.index)}${element}${presentation.slice(existing.index + existing[0].length)}`;
  }
  const size = /<p:sldSz\b/.exec(presentation);
  if (size) return `${presentation.slice(0, size.index)}${element}${presentation.slice(size.index)}`;
  return presentation.replace('</p:presentation>', `${element}</p:presentation>`);
}

function slideIdEntries(presentation) {
  const list = /<p:sldIdLst\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldIdLst>)/.exec(presentation);
  return list ? [...list[0].matchAll(/<p:sldId\b[^>]*?\/>/g)].map((match) => match[0]) : [];
}

async function addPresentationSlide(zip, op) {
  const layout = selectSlideLayout(await slideLayoutParts(zip), op.layout);
  let ordinal = 1;
  while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
  const part = `ppt/slides/slide${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<p:sld ${PRESENTATION_NAMESPACES}><p:cSld><p:spTree>${emptyGroupShape()}`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
  zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/slideLayout" Target="${posix.relative('ppt/slides', layout.path)}"/>`
    + '</Relationships>');
  await ensureContentTypeOverride(zip, `/${part}`, SLIDE_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/slide`,
    `slides/slide${ordinal}.xml`,
  );
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation);
  const ids = entries.map((entry) => Number(xmlAttribute(entry, 'id')) || 0);
  const position = Number(op.index) > 0 ? Math.min(Number(op.index) - 1, entries.length) : entries.length;
  entries.splice(position, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
  return { part, position: position + 1, layout: layout.name || layout.type || layout.path };
}

async function deletePresentationSlide(zip, slides, number) {
  if (slides.length <= 1) throw new Error('A presentation must keep at least one slide');
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation)
    .filter((entry) => xmlAttribute(entry, 'r:id') !== slide.rid);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
  await removePackageRelationship(zip, 'ppt/_rels/presentation.xml.rels', slide.rid);
  const relsPath = partRelationshipPath(slide.path);
  const rels = await zipText(zip, relsPath);
  const notes = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  if (notes) {
    const notesPart = posix.normalize(posix.join(posix.dirname(slide.path), notes));
    zip.remove(notesPart);
    if (zip.file(partRelationshipPath(notesPart))) zip.remove(partRelationshipPath(notesPart));
    await removeContentTypeOverride(zip, `/${notesPart}`);
  }
  zip.remove(slide.path);
  if (zip.file(relsPath)) zip.remove(relsPath);
  await removeContentTypeOverride(zip, `/${slide.path}`);
}

async function movePresentationSlide(zip, slides, number, index) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  const target = Number(index);
  if (!Number.isFinite(target) || target < 1 || target > slides.length) {
    throw new Error(`move_slide index must be between 1 and ${slides.length}`);
  }
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation);
  const from = entries.findIndex((entry) => xmlAttribute(entry, 'r:id') === slide.rid);
  if (from < 0) throw new Error(`PPTX slide ${number} is not listed in the presentation`);
  const [moved] = entries.splice(from, 1);
  entries.splice(target - 1, 0, moved);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
}

async function ensureNotesMaster(zip) {
  const part = 'ppt/notesMasters/notesMaster1.xml';
  if (zip.file(part)) return part;
  const theme = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name));
  if (!theme) throw new Error('Presentation is missing a theme for the notes master');
  const colorMap = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
    + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
  zip.file(part, `${XML_HEADER}<p:notesMaster ${PRESENTATION_NAMESPACES}>`
    + `<p:cSld><p:spTree>${emptyGroupShape()}</p:spTree></p:cSld>`
    + `<p:clrMap ${colorMap}/>`
    + '<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>'
    + '</p:notesMaster>');
  zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/theme" Target="${posix.relative('ppt/notesMasters', theme)}"/>`
    + '</Relationships>');
  await ensureContentTypeOverride(zip, `/${part}`, NOTES_MASTER_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/notesMaster`,
    'notesMasters/notesMaster1.xml',
  );
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  if (!/<p:notesMasterIdLst\b/.test(presentation)) {
    const element = `<p:notesMasterIdLst><p:notesMasterId r:id="${relationshipId}"/></p:notesMasterIdLst>`;
    const anchor = /<p:sldIdLst\b/.exec(presentation) || /<p:sldSz\b/.exec(presentation);
    zip.file(presentationPath, anchor
      ? `${presentation.slice(0, anchor.index)}${element}${presentation.slice(anchor.index)}`
      : presentation.replace('</p:presentation>', `${element}</p:presentation>`));
  }
  return part;
}

const PPTX_COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';
const PPTX_COMMENT_AUTHORS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';

async function ensureCommentAuthor(zip, author, initials) {
  const part = 'ppt/commentAuthors.xml';
  let xml = await zipText(zip, part);
  if (!xml) {
    xml = `${XML_HEADER}<p:cmAuthorLst ${PRESENTATION_NAMESPACES}></p:cmAuthorLst>`;
    zip.file(part, xml);
    await ensureContentTypeOverride(zip, `/${part}`, PPTX_COMMENT_AUTHORS_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      'ppt/_rels/presentation.xml.rels',
      `${OFFICE_RELATIONSHIP_BASE}/commentAuthors`,
      'commentAuthors.xml',
    );
  }
  const existing = new RegExp(`<p:cmAuthor\\b[^>]*\\bname="${tagPattern(xmlEncode(author))}"[^>]*\\/>`).exec(xml);
  if (existing) return Number(xmlAttribute(existing[0], 'id')) || 0;
  const ids = [...xml.matchAll(/<p:cmAuthor\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]));
  const id = Math.max(-1, ...ids) + 1;
  const entry = `<p:cmAuthor id="${id}" name="${xmlEncode(author)}" initials="${xmlEncode(initials)}"`
    + ` lastIdx="1" clrIdx="${id}"/>`;
  zip.file(part, xml.replace('</p:cmAuthorLst>', `${entry}</p:cmAuthorLst>`));
  return id;
}

async function ensureSlideComments(zip, slide) {
  const relationships = partRelationshipPath(slide.path);
  const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/
    .exec(await zipText(zip, relationships))?.[1];
  if (target) return posix.normalize(posix.join(posix.dirname(slide.path), target));
  let ordinal = 1;
  while (zip.file(`ppt/comments/comment${ordinal}.xml`)) ordinal += 1;
  const part = `ppt/comments/comment${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<p:cmLst ${PRESENTATION_NAMESPACES}></p:cmLst>`);
  await ensureContentTypeOverride(zip, `/${part}`, PPTX_COMMENTS_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    relationships,
    `${OFFICE_RELATIONSHIP_BASE}/comments`,
    posix.relative(posix.dirname(slide.path), part),
  );
  return part;
}

function provenanceCitation(source) {
  if (!source) return '';
  if (typeof source === 'string') return `Source: ${source.trim()}`;
  if (typeof source !== 'object') return '';
  const document = String(source.document || source.label || '').trim();
  const target = String(source.target || '').trim();
  if (!document) return '';
  return `Source: ${target ? `${document}#${target}` : document}`;
}

async function readSlideNotes(zip, slide) {
  const relationships = await zipText(zip, partRelationshipPath(slide.path));
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(relationships)?.[1];
  if (!linked) return '';
  const part = posix.normalize(posix.join(posix.dirname(slide.path), linked));
  const xml = await zipText(zip, part);
  if (!xml) return '';
  const body = /<p:sp>[\s\S]*?<p:ph type="body"[\s\S]*?<\/p:sp>/.exec(xml)?.[0] || xml;
  return [...body.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
    .map((paragraph) => paragraphTexts(paragraph[0], 'a:t').join(''))
    .join('\n')
    .trim();
}

async function setSlideNotes(zip, slides, number, text) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  await ensureNotesMaster(zip);
  const slideRelsPath = partRelationshipPath(slide.path);
  const slideRels = await zipText(zip, slideRelsPath);
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(slideRels)?.[1];
  const ordinal = Number(/slide(\d+)\.xml$/.exec(slide.path)?.[1]) || Number(number);
  const part = linked
    ? posix.normalize(posix.join(posix.dirname(slide.path), linked))
    : `ppt/notesSlides/notesSlide${ordinal}.xml`;
  const paragraphs = String(text ?? '').split(/\r?\n/).map((line) => ({ text: line }));
  const body = textBodyXml({ paragraphs, defaults: { fontSize: 12 } });
  zip.file(part, `${XML_HEADER}<p:notes ${PRESENTATION_NAMESPACES}><p:cSld><p:spTree>${emptyGroupShape()}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>'
    + '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    + '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
    + `<p:spPr/><p:txBody>${body}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>');
  if (!zip.file(partRelationshipPath(part))) {
    zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/slide" Target="${posix.relative(posix.dirname(part), slide.path)}"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_RELATIONSHIP_BASE}/notesMaster" Target="${posix.relative(posix.dirname(part), 'ppt/notesMasters/notesMaster1.xml')}"/>`
      + '</Relationships>');
  }
  await ensureContentTypeOverride(zip, `/${part}`, NOTES_SLIDE_CONTENT_TYPE);
  if (!linked) {
    await addPackageRelationship(
      zip,
      slideRelsPath,
      `${OFFICE_RELATIONSHIP_BASE}/notesSlide`,
      posix.relative(posix.dirname(slide.path), part),
    );
  }
}

async function addSlideImage(zip, slidePart, source) {
  const extension = extname(String(source || '')).replace(/^\./, '').toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`);
  }
  const data = await readFile(source);
  let ordinal = 1;
  while (zip.file(`ppt/media/image${ordinal}.${extension}`)) ordinal += 1;
  const part = `ppt/media/image${ordinal}.${extension}`;
  zip.file(part, data);
  await ensureDefaultContentType(zip, extension, contentType);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(slidePart),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    posix.relative(posix.dirname(slidePart), part),
  );
  return { part, relationshipId };
}

function partNaming(path) {
  const base = posix.basename(path);
  const match = /^([A-Za-z_]+?)\d*\.([A-Za-z0-9]+)$/.exec(base);
  if (match) return { prefix: match[1], extension: match[2] };
  const dot = base.lastIndexOf('.');
  return {
    prefix: dot > 0 ? base.slice(0, dot) : base,
    extension: dot > 0 ? base.slice(dot + 1) : 'bin',
  };
}

function nextAvailablePart(zip, directory, prefix, extension) {
  let ordinal = 1;
  while (zip.file(`${directory}/${prefix}${ordinal}.${extension}`)) ordinal += 1;
  return `${directory}/${prefix}${ordinal}.${extension}`;
}

async function partDigest(archive, path) {
  const file = archive.file(path);
  if (!file) return '';
  return createHash('sha1').update(await file.async('nodebuffer')).digest('hex');
}

async function findMatchingPart(zip, pattern, digest) {
  if (!digest) return '';
  for (const name of Object.keys(zip.files)) {
    if (!pattern.test(name)) continue;
    if (await partDigest(zip, name) === digest) return name;
  }
  return '';
}

async function copyPartContentType(source, zip, sourcePath, targetPath) {
  const types = await zipText(source, '[Content_Types].xml');
  const override = new RegExp(`<Override\\b[^>]*\\bPartName="/${tagPattern(sourcePath)}"[^>]*\\/>`).exec(types);
  if (override) {
    await ensureContentTypeOverride(zip, `/${targetPath}`, xmlAttribute(override[0], 'ContentType'));
    return;
  }
  const extension = partNaming(sourcePath).extension.toLowerCase();
  const fallback = new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"[^>]*\\/>`, 'i').exec(types);
  if (fallback) await ensureDefaultContentType(zip, extension, xmlAttribute(fallback[0], 'ContentType'));
}

async function importPartTree(source, zip, sourcePath, cache) {
  if (cache.has(sourcePath)) return cache.get(sourcePath);
  const file = source.file(sourcePath);
  if (!file) throw new Error(`import_slides source package is missing ${sourcePath}`);
  const data = await file.async('nodebuffer');
  const digest = createHash('sha1').update(data).digest('hex');
  const directory = posix.dirname(sourcePath);
  const naming = partNaming(sourcePath);
  const reused = await findMatchingPart(
    zip,
    new RegExp(`^${tagPattern(directory)}/${tagPattern(naming.prefix)}\\d*\\.${tagPattern(naming.extension)}$`, 'i'),
    digest,
  );
  if (reused) {
    cache.set(sourcePath, reused);
    return reused;
  }
  const targetPath = nextAvailablePart(zip, directory, naming.prefix, naming.extension);
  zip.file(targetPath, data);
  cache.set(sourcePath, targetPath);
  await copyPartContentType(source, zip, sourcePath, targetPath);
  const relationships = await zipText(source, partRelationshipPath(sourcePath));
  if (relationships) {
    zip.file(
      partRelationshipPath(targetPath),
      await rewriteImportedRelationships(source, zip, sourcePath, targetPath, relationships, cache),
    );
  }
  return targetPath;
}

async function rewriteImportedRelationships(source, zip, sourceOwner, targetOwner, relationships, cache) {
  const sourceDirectory = posix.dirname(sourceOwner);
  const targetDirectory = posix.dirname(targetOwner);
  let output = relationships;
  for (const match of relationships.matchAll(/<Relationship\b[^>]*?\/>/g)) {
    const block = match[0];
    if (/\bTargetMode="External"/i.test(block)) continue;
    const type = xmlAttribute(block, 'Type');
    const target = xmlDecode(xmlAttribute(block, 'Target'));
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(sourceDirectory, target));
    if (type.endsWith('/notesSlide')) {
      output = output.replace(block, '');
      continue;
    }
    let mapped = '';
    if (type.endsWith('/slideLayout')) {
      mapped = await findMatchingPart(
        zip,
        /^ppt\/slideLayouts\/slideLayout\d+\.xml$/,
        await partDigest(source, resolved),
      );
      if (!mapped) {
        throw new Error('portable import_slides requires the deck to be seeded from the same template; create the presentation from this template first');
      }
    } else if (type.endsWith('/slide')) {
      mapped = cache.get(`slide:${resolved}`) || '';
      if (!mapped) {
        output = output.replace(block, '');
        continue;
      }
    } else {
      mapped = await importPartTree(source, zip, resolved, cache);
    }
    output = output.replace(
      block,
      block.replace(/\bTarget="[^"]*"/, `Target="${xmlEncode(posix.relative(targetDirectory, mapped))}"`),
    );
  }
  return output;
}

async function importSlidesIntoPresentation(zip, sourcePath, slideNumbers, after) {
  const source = await JSZip.loadAsync(await readFile(sourcePath));
  const sourceSlides = await presentationSlides(source);
  if (!sourceSlides.length) throw new Error('import_slides source has no slides');
  const requested = Array.isArray(slideNumbers) && slideNumbers.length
    ? slideNumbers.map(Number)
    : sourceSlides.map((_, index) => index + 1);
  const cache = new Map();
  let position = Math.max(0, Number(after) || 0);
  const imported = [];
  for (const number of requested) {
    const entry = sourceSlides[number - 1];
    if (!entry) throw new Error(`import_slides source has no slide ${number}`);
    let ordinal = 1;
    while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
    const targetPath = `ppt/slides/slide${ordinal}.xml`;
    zip.file(targetPath, await zipText(source, entry.path));
    cache.set(`slide:${entry.path}`, targetPath);
    await ensureContentTypeOverride(zip, `/${targetPath}`, SLIDE_CONTENT_TYPE);
    const relationships = await zipText(source, partRelationshipPath(entry.path));
    if (relationships) {
      zip.file(
        partRelationshipPath(targetPath),
        await rewriteImportedRelationships(source, zip, entry.path, targetPath, relationships, cache),
      );
    }
    const relationshipId = await addPackageRelationship(
      zip,
      'ppt/_rels/presentation.xml.rels',
      `${OFFICE_RELATIONSHIP_BASE}/slide`,
      `slides/slide${ordinal}.xml`,
    );
    const presentation = await zipText(zip, 'ppt/presentation.xml');
    const entries = slideIdEntries(presentation);
    const ids = entries.map((item) => Number(xmlAttribute(item, 'id')) || 0);
    const index = Math.min(position, entries.length);
    entries.splice(index, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
    zip.file('ppt/presentation.xml', writeSlideIdList(presentation, entries));
    position = index + 1;
    imported.push(number);
  }
  return { count: imported.length, slides: imported };
}

const DEFAULT_TEXT_INSETS = Object.freeze({ left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 });

function shapeParagraphs(shapeXml) {
  const paragraphs = [];
  for (const match of shapeXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
    const block = match[0];
    const text = [...block.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((node) => xmlDecode(node[1]))
      .join('');
    const runElement = /<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/.exec(block)?.[0] || '';
    const runProperties = /^<a:rPr\b([^>]*?)(?:\/>|>)/.exec(runElement)?.[1] || '';
    const size = Number(xmlAttribute(runProperties, 'sz'));
    if (!Number.isFinite(size) || size <= 0) return null;
    paragraphs.push({
      text,
      fontSize: size / 100,
      bold: xmlAttribute(runProperties, 'b') === '1',
      italic: xmlAttribute(runProperties, 'i') === '1',
      color: /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(runElement)?.[1] || '',
      fontName: /<a:latin\b[^>]*\btypeface="([^"]*)"/.exec(block)?.[1] || 'Calibri',
    });
  }
  return paragraphs;
}

export async function inspectPptxTextBoxes(zip) {
  const slides = await presentationSlides(zip);
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation);
  const boxes = [];
  for (let index = 0; index < slides.length; index += 1) {
    const xml = await zipText(zip, slides[index].path);
    const slideBackground = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1] || '';
    const tree = containerInner(xml, 'p:spTree');
    if (!tree) continue;
    const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
    const painted = [];
    for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
      const shape = shapes[shapeIndex];
      if (shape.name !== 'p:sp') continue;
      const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(shape.xml);
      const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shape.xml);
      if (!offset || !extent) continue;
      const bounds = {
        left: Number(offset[1]) / 12_700,
        top: Number(offset[2]) / 12_700,
        width: Number(extent[1]) / 12_700,
        height: Number(extent[2]) / 12_700,
      };
      const ownFill = /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/
        .exec(containerInner(shape.xml, 'p:spPr')?.inner || '')?.[1] || '';
      if (ownFill) painted.push({ ...bounds, color: ownFill });
      const paragraphs = shapeParagraphs(shape.xml);
      if (!paragraphs?.length) continue;
      const covering = [...painted].reverse().find((entry) => (
        entry.color !== ownFill
        && entry.left <= bounds.left + 1
        && entry.top <= bounds.top + 1
        && entry.left + entry.width >= bounds.left + bounds.width - 1
        && entry.top + entry.height >= bounds.top + bounds.height - 1
      ));
      const bodyProperties = /<a:bodyPr\b([^>]*?)\/?>/.exec(shape.xml)?.[1] || '';
      const inset = (name, fallback) => {
        const value = Number(xmlAttribute(bodyProperties, name));
        return Number.isFinite(value) ? value / 12_700 : fallback;
      };
      boxes.push({
        slide: index + 1,
        shape: shapeIndex + 1,
        left: Number(offset[1]) / 12_700,
        top: Number(offset[2]) / 12_700,
        width: Number(extent[1]) / 12_700,
        height: Number(extent[2]) / 12_700,
        insetLeft: inset('lIns', DEFAULT_TEXT_INSETS.left),
        insetTop: inset('tIns', DEFAULT_TEXT_INSETS.top),
        insetRight: inset('rIns', DEFAULT_TEXT_INSETS.right),
        insetBottom: inset('bIns', DEFAULT_TEXT_INSETS.bottom),
        wrap: xmlAttribute(bodyProperties, 'wrap') !== 'none',
        autofit: /<a:normAutofit\b/.test(shape.xml) || /<a:spAutoFit\b/.test(shape.xml),
        background: ownFill || covering?.color || slideBackground,
        paragraphs,
      });
    }
  }
  return {
    boxes,
    slideWidth: size ? Number(size[1]) / 12_700 : 0,
    slideHeight: size ? Number(size[2]) / 12_700 : 0,
  };
}

export async function clearPortablePresentationSlides(path) {
  const zip = await loadPackage(path);
  const slides = await presentationSlides(zip);
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  zip.file('ppt/presentation.xml', writeSlideIdList(presentation, []));
  for (const slide of slides) {
    if (slide.rid) await removePackageRelationship(zip, 'ppt/_rels/presentation.xml.rels', slide.rid);
    const relationships = partRelationshipPath(slide.path);
    const notes = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/
      .exec(await zipText(zip, relationships))?.[1];
    if (notes) {
      const notesPart = posix.normalize(posix.join(posix.dirname(slide.path), notes));
      zip.remove(notesPart);
      if (zip.file(partRelationshipPath(notesPart))) zip.remove(partRelationshipPath(notesPart));
      await removeContentTypeOverride(zip, `/${notesPart}`);
    }
    zip.remove(slide.path);
    if (zip.file(relationships)) zip.remove(relationships);
    await removeContentTypeOverride(zip, `/${slide.path}`);
  }
  await savePackage(zip, path);
  return { removed: slides.length };
}

function setTableCellText(cell, text) {
  const value = String(text ?? '');
  const nodes = textNodes(cell, 'a:t');
  if (nodes.length) {
    nodes[0].text = value;
    for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
    return rebuildTextNodes(cell, 'a:t', nodes);
  }
  const run = `<a:r><a:rPr lang="en-US" dirty="0"/>`
    + `<a:t${/^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''}>${xmlEncode(value)}</a:t></a:r>`;
  const paragraph = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/.exec(cell);
  if (paragraph) {
    const replaced = paragraph[0].replace(/<\/a:p>$/, `${run}</a:p>`);
    return `${cell.slice(0, paragraph.index)}${replaced}${cell.slice(paragraph.index + paragraph[0].length)}`;
  }
  if (!/<\/a:txBody>/.test(cell)) throw new Error('PPTX table cell has no text body');
  return cell.replace('</a:txBody>', `<a:p>${run}</a:p></a:txBody>`);
}

function setTableValues(shapeXml, values) {
  const table = containerInner(shapeXml, 'a:tbl');
  if (!table) throw new Error('PPTX shape does not contain a table');
  const rows = elementSpans(table.inner, 'a:tr');
  if (!rows.length) throw new Error('PPTX table has no rows');
  let inner = table.inner;
  let filledRows = 0;
  let filledCells = 0;
  let removedRows = 0;
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    const source = values[rowIndex];
    if (!Array.isArray(source)) {
      if (rowIndex >= values.length) {
        inner = `${inner.slice(0, row.start)}${inner.slice(row.end)}`;
        removedRows += 1;
      }
      continue;
    }
    const cells = elementSpans(containerBody(row.xml, 'a:tr'), 'a:tc');
    let body = containerBody(row.xml, 'a:tr');
    for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex -= 1) {
      const cell = cells[cellIndex];
      const text = cellIndex < source.length ? source[cellIndex] : '';
      body = `${body.slice(0, cell.start)}${setTableCellText(cell.xml, text)}${body.slice(cell.end)}`;
      filledCells += 1;
    }
    const attrs = /^<a:tr\b([^>]*?)(?:\/>|>)/.exec(row.xml)?.[1] || '';
    inner = `${inner.slice(0, row.start)}<a:tr${attrs}>${body}</a:tr>${inner.slice(row.end)}`;
    filledRows += 1;
  }
  return {
    xml: `${shapeXml.slice(0, table.start)}${inner}${shapeXml.slice(table.end)}`,
    rows: filledRows,
    cells: filledCells,
    capacity: rows.length,
    ...(removedRows ? { removedRows } : {}),
  };
}

const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const LABEL_POSITION_CODES = Object.freeze({
  inside_end: 'inEnd',
  inside_base: 'inBase',
  outside_end: 'outEnd',
  center: 'ctr',
  centre: 'ctr',
  best_fit: 'bestFit',
});
const WORKBOOK_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function chartFrameXml({ id, relationshipId, left, top, width, height }) {
  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>`
    + `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
    + ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${relationshipId}"/>`
    + '</a:graphicData></a:graphic></p:graphicFrame>';
}

const CHART_AXIS_ORDER = Object.freeze([
  'c:axId', 'c:scaling', 'c:delete', 'c:axPos', 'c:majorGridlines', 'c:minorGridlines',
  'c:title', 'c:numFmt', 'c:majorTickMark', 'c:minorTickMark', 'c:tickLblPos',
  'c:spPr', 'c:txPr', 'c:crossAx', 'c:crosses', 'c:crossesAt', 'c:crossBetween',
  'c:majorUnit', 'c:minorUnit',
]);

function upsertOrderedChild(xml, order, tag, element) {
  const pattern = new RegExp(`<${tagPattern(tag)}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${tagPattern(tag)}>)`);
  const stripped = xml.replace(pattern, '');
  if (!element) return stripped;
  for (const candidate of order.slice(order.indexOf(tag) + 1)) {
    const found = new RegExp(`<${tagPattern(candidate)}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${tagPattern(candidate)}>)`).exec(stripped);
    if (found) return `${stripped.slice(0, found.index)}${element}${stripped.slice(found.index)}`;
  }
  return stripped.replace(/<\/[A-Za-z:]+>\s*$/, (close) => `${element}${close}`);
}

async function resolveSlideChart(zip, slides, op) {
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const tree = containerInner(current, 'p:spTree');
  if (!tree) throw new Error('PPTX slide shape tree is missing');
  const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
  const shape = shapes[Number(op.shape) - 1];
  if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
  const reference = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(shape.xml)?.[1];
  if (!reference) throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a chart`);
  const target = relationshipMap(await zipText(zip, partRelationshipPath(path))).get(reference);
  if (!target) throw new Error(`PPTX chart relationship ${reference} is missing on slide ${op.slide}`);
  const part = posix.normalize(posix.join('ppt/slides', target));
  const xml = await zipText(zip, part);
  if (!xml) throw new Error(`PPTX chart part is missing: ${part}`);
  return { path, part, xml };
}

function detectChartType(xml) {
  if (/<c:pieChart\b/.test(xml)) return 'pie';
  if (/<c:doughnutChart\b/.test(xml)) return 'doughnut';
  if (/<c:lineChart\b/.test(xml)) return 'line';
  if (/<c:areaChart\b/.test(xml)) return 'area';
  const stacked = /<c:grouping val="stacked"\/>/.test(xml);
  const horizontal = /<c:barDir val="bar"\/>/.test(xml);
  if (stacked) return horizontal ? 'stacked_bar' : 'stacked_column';
  return horizontal ? 'bar' : 'column';
}

function chartCategories(xml) {
  const block = /<c:cat>[\s\S]*?<\/c:cat>/.exec(xml)?.[0] || '';
  return [...block.matchAll(/<c:pt idx="\d+"><c:v>([\s\S]*?)<\/c:v><\/c:pt>/g)]
    .map((match) => xmlDecode(match[1]));
}

function chartTitleText(xml) {
  const block = /<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0] || '';
  return [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => xmlDecode(match[1])).join('');
}

async function writePresentationChart(zip, {
  chartPart,
  embeddingPart,
  chart,
  rows,
}) {
  zip.file(embeddingPart, await createPortableChartWorkbook(rows));
  await ensureDefaultContentType(zip, 'xlsx', WORKBOOK_CONTENT_TYPE);
  zip.file(partRelationshipPath(chartPart), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/package"`
    + ` Target="${xmlEncode(posix.relative(posix.dirname(chartPart), embeddingPart))}"/></Relationships>`);
  zip.file(chartPart, chart);
  await ensureContentTypeOverride(zip, `/${chartPart}`, CHART_CONTENT_TYPE);
}

function shapeFrame(shapeXml) {
  const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(shapeXml);
  const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shapeXml);
  if (!offset || !extent) return null;
  return {
    left: Number(offset[1]) / 12_700,
    top: Number(offset[2]) / 12_700,
    width: Number(extent[1]) / 12_700,
    height: Number(extent[2]) / 12_700,
  };
}

async function presentationSlideSize(zip) {
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation);
  return {
    width: size ? Number(size[1]) / 12_700 : 960,
    height: size ? Number(size[2]) / 12_700 : 540,
  };
}

function selectedShapeSpans(tree, numbers) {
  const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
  const selected = [];
  for (const number of numbers) {
    const shape = shapes[Number(number) - 1];
    if (!shape) throw new Error(`PPTX shape ${number} not found`);
    selected.push(shape);
  }
  return { shapes, selected };
}

function writeShapeTree(slideXml, tree, shapes) {
  return `${slideXml.slice(0, tree.start)}${shapes.join('')}${slideXml.slice(tree.end)}`;
}

function appendSlideShape(xml, shape) {
  if (!/<\/p:spTree>/.test(xml)) throw new Error('PPTX slide shape tree is missing');
  return xml.replace('</p:spTree>', `${shape}</p:spTree>`);
}

function setSlideBackground(xml, color) {
  const background = backgroundXml(color);
  const existing = /<p:bg\b[^>]*?(?:\/>|>[\s\S]*?<\/p:bg>)/.exec(xml);
  if (existing) {
    return `${xml.slice(0, existing.index)}${background}${xml.slice(existing.index + existing[0].length)}`;
  }
  const common = /<p:cSld\b[^>]*?>/.exec(xml);
  if (!common) throw new Error('PPTX slide is missing its common slide data');
  const position = common.index + common[0].length;
  return `${xml.slice(0, position)}${background}${xml.slice(position)}`;
}

function updateShapeGeometry(shape, properties) {
  let next = shape;
  if (['left', 'top', 'width', 'height', 'rotation'].some((key) => properties[key] != null)) {
    const current = /<a:xfrm\b[^>]*?(?:\/>|>[\s\S]*?<\/a:xfrm>)/.exec(next);
    const offset = current ? /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(current[0]) : null;
    const extent = current ? /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(current[0]) : null;
    const rotation = properties.rotation != null
      ? Math.round(Number(properties.rotation) * 60_000)
      : Number(current ? xmlAttribute(current[0], 'rot') : 0) || 0;
    const frame = `<a:xfrm${rotation ? ` rot="${rotation}"` : ''}>`
      + `<a:off x="${properties.left != null ? toEmu(properties.left) : Number(offset?.[1] || 0)}"`
      + ` y="${properties.top != null ? toEmu(properties.top) : Number(offset?.[2] || 0)}"/>`
      + `<a:ext cx="${properties.width != null ? toEmu(properties.width) : Number(extent?.[1] || 1)}"`
      + ` cy="${properties.height != null ? toEmu(properties.height) : Number(extent?.[2] || 1)}"/></a:xfrm>`;
    next = current
      ? `${next.slice(0, current.index)}${frame}${next.slice(current.index + current[0].length)}`
      : next.replace(/<p:spPr(?:\s[^>]*)?>/, `$&${frame}`);
  }
  if (properties.fillColor != null) {
    const shapeProperties = containerInner(next, 'p:spPr');
    const fill = solidFillXml(properties.fillColor, properties.fillTransparency);
    if (shapeProperties && fill) {
      const cleaned = shapeProperties.inner
        .replace(/<a:solidFill\b[^>]*?(?:\/>|>[\s\S]*?<\/a:solidFill>)/, '')
        .replace(/<a:noFill\s*\/>/, '');
      const geometry = /<a:prstGeom\b[^>]*?(?:\/>|>[\s\S]*?<\/a:prstGeom>)/.exec(cleaned);
      const position = geometry ? geometry.index + geometry[0].length : cleaned.length;
      const inner = `${cleaned.slice(0, position)}${fill}${cleaned.slice(position)}`;
      next = `${next.slice(0, shapeProperties.start)}${inner}${next.slice(shapeProperties.end)}`;
    }
  }
  return next;
}

function nextShapeId(xml) {
  const ids = [...xml.matchAll(/\bcNvPr\s+id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(1, ...ids) + 1;
}

async function applyPptx(zip, operations) {
  let slides = await presentationSlides(zip);
  const results = [];
  for (const op of operations) {
    if (op.op === 'add_slide') {
      const created = await addPresentationSlide(zip, op);
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: true, slide: created.position, layout: created.layout });
      continue;
    }
    if (op.op === 'delete_slide') {
      await deletePresentationSlide(zip, slides, op.slide);
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: true, slide: Number(op.slide) });
      continue;
    }
    if (op.op === 'move_slide') {
      await movePresentationSlide(zip, slides, op.slide, op.index);
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), index: Number(op.index) });
      continue;
    }
    if (op.op === 'keep_slides') {
      const keep = new Set((Array.isArray(op.slides) ? op.slides : []).map(Number));
      if (!keep.size) throw new Error('keep_slides requires slides');
      let removed = 0;
      for (let index = slides.length; index >= 1; index -= 1) {
        if (keep.has(index)) continue;
        await deletePresentationSlide(zip, await presentationSlides(zip), index);
        removed += 1;
      }
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: removed > 0, removed, remaining: slides.length });
      continue;
    }
    if (op.op === 'add_comment' || op.op === 'delete_comment') {
      const slide = slides[Number(op.slide) - 1];
      if (!slide) throw new Error(`PPTX slide ${op.slide} not found`);
      if (op.op === 'delete_comment') {
        const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/
          .exec(await zipText(zip, partRelationshipPath(slide.path)))?.[1];
        if (!target) throw new Error(`PPTX slide ${op.slide} has no comments`);
        const part = posix.normalize(posix.join(posix.dirname(slide.path), target));
        const xml = await zipText(zip, part);
        const pattern = new RegExp(`<p:cm\\b[^>]*\\bidx="${Number(op.comment)}"[^>]*>[\\s\\S]*?<\\/p:cm>`);
        if (!pattern.test(xml)) throw new Error(`PPTX comment ${op.comment} not found on slide ${op.slide}`);
        zip.file(part, xml.replace(pattern, ''));
        results.push({ op: op.op, changed: true, slide: Number(op.slide), comment: Number(op.comment) });
        continue;
      }
      const text = String(op.text || '');
      if (!text) throw new Error('add_comment requires text');
      const authorId = await ensureCommentAuthor(zip, op.author || 'Mixdog', op.initials || 'MD');
      const part = await ensureSlideComments(zip, slide);
      const xml = await zipText(zip, part);
      const indices = [...xml.matchAll(/<p:cm\b[^>]*\bidx="(\d+)"/g)].map((match) => Number(match[1]));
      const index = Math.max(0, ...indices) + 1;
      const entry = `<p:cm authorId="${authorId}" dt="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}" idx="${index}">`
        + `<p:pos x="${Math.max(0, toEmu(op.left ?? 12))}" y="${Math.max(0, toEmu(op.top ?? 12))}"/>`
        + `<p:text>${xmlEncode(text)}</p:text></p:cm>`;
      zip.file(part, xml.replace('</p:cmLst>', `${entry}</p:cmLst>`));
      results.push({ op: op.op, changed: true, slide: Number(op.slide), comment: index });
      continue;
    }
    if (op.op === 'add_provenance') {
      const citation = provenanceCitation(op.source);
      if (!citation) throw new Error('add_provenance requires source with a document or label');
      const slide = slides[Number(op.slide) - 1];
      if (!slide) throw new Error(`PPTX slide ${op.slide} not found`);
      const existing = await readSlideNotes(zip, slide);
      if (existing.includes(citation)) {
        results.push({ op: op.op, changed: false, slide: Number(op.slide), citation });
        continue;
      }
      await setSlideNotes(zip, slides, op.slide, existing ? `${existing}\n${citation}` : citation);
      results.push({
        op: op.op,
        changed: true,
        slide: Number(op.slide),
        target: op.shape ? `/slide[${Number(op.slide)}]/shape[${Number(op.shape)}]` : `/slide[${Number(op.slide)}]`,
        citation,
      });
      continue;
    }
    if (op.op === 'set_hyperlink') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const address = String(op.address || '').trim();
      if (!address && !op.subAddress) throw new Error('set_hyperlink requires address or subAddress');
      const relationshipId = address
        ? await addPackageRelationship(
          zip,
          partRelationshipPath(path),
          `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
          address,
          'External',
        )
        : '';
      const link = `<a:hlinkClick xmlns:a="${DRAWING_MAIN_NS}"`
        + `${relationshipId ? ` r:id="${relationshipId}"` : ' r:id=""'}`
        + `${op.subAddress ? ` action="ppaction://hlinksldjump"` : ''}/>`;
      const updated = shape.xml
        .replace(/<a:hlinkClick\b[^>]*?(?:\/>|>[\s\S]*?<\/a:hlinkClick>)/, '')
        .replace(/<p:cNvPr\b([^>]*?)(\/>|>)/, (_match, attrs, close) => (
          close === '/>' ? `<p:cNvPr${attrs}>${link}</p:cNvPr>` : `<p:cNvPr${attrs}>${link}`
        ));
      const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
      zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape), address });
      continue;
    }
    if (op.op === 'duplicate_slide') {
      const source = slides[Number(op.slide) - 1];
      if (!source) throw new Error(`PPTX slide ${op.slide} not found`);
      let ordinal = 1;
      while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
      const duplicated = `ppt/slides/slide${ordinal}.xml`;
      zip.file(duplicated, await zipText(zip, source.path));
      const sourceRelationships = await zipText(zip, partRelationshipPath(source.path));
      if (sourceRelationships) {
        zip.file(
          partRelationshipPath(duplicated),
          sourceRelationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\/>/g, ''),
        );
      }
      await ensureContentTypeOverride(zip, `/${duplicated}`, SLIDE_CONTENT_TYPE);
      const relationshipId = await addPackageRelationship(
        zip,
        'ppt/_rels/presentation.xml.rels',
        `${OFFICE_RELATIONSHIP_BASE}/slide`,
        `slides/slide${ordinal}.xml`,
      );
      const presentation = await zipText(zip, 'ppt/presentation.xml');
      const entries = slideIdEntries(presentation);
      const ids = entries.map((entry) => Number(xmlAttribute(entry, 'id')) || 0);
      const position = Number(op.index) > 0
        ? Math.min(Number(op.index) - 1, entries.length)
        : Number(op.slide);
      entries.splice(position, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
      zip.file('ppt/presentation.xml', writeSlideIdList(presentation, entries));
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: true, slide: position + 1 });
      continue;
    }
    if (op.op === 'z_order') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const command = String(op.command || '').toLowerCase();
      if (!['front', 'back', 'forward', 'backward'].includes(command)) {
        throw new Error('z_order command must be front, back, forward, or backward');
      }
      const { shapes } = selectedShapeSpans(tree, [op.shape]);
      const index = Number(op.shape) - 1;
      const ordered = shapes.map((shape) => shape.xml);
      const [moved] = ordered.splice(index, 1);
      const destination = command === 'front'
        ? ordered.length
        : command === 'back'
          ? 0
          : Math.max(0, Math.min(ordered.length, index + (command === 'forward' ? 1 : -1)));
      ordered.splice(destination, 0, moved);
      const preamble = tree.inner.slice(0, shapes[0]?.start ?? tree.inner.length);
      zip.file(path, writeShapeTree(current, tree, [preamble, ...ordered]));
      results.push({ op: op.op, changed: true, slide: Number(op.slide), command });
      continue;
    }
    if (op.op === 'align_shapes' || op.op === 'distribute_shapes') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const numbers = Array.isArray(op.shapes) ? op.shapes.map(Number) : [];
      if (numbers.length < 2) throw new Error(`${op.op} requires at least two shapes`);
      const { shapes, selected } = selectedShapeSpans(tree, numbers);
      const frames = selected.map((shape) => {
        const frame = shapeFrame(shape.xml);
        if (!frame) throw new Error(`PPTX shape has no explicit position; ${op.op} needs sized shapes`);
        return frame;
      });
      const slideSize = await presentationSlideSize(zip);
      const bounds = op.relativeToSlide === true
        ? { left: 0, top: 0, right: slideSize.width, bottom: slideSize.height }
        : {
          left: Math.min(...frames.map((frame) => frame.left)),
          top: Math.min(...frames.map((frame) => frame.top)),
          right: Math.max(...frames.map((frame) => frame.left + frame.width)),
          bottom: Math.max(...frames.map((frame) => frame.top + frame.height)),
        };
      const placements = frames.map((frame) => ({ ...frame }));
      if (op.op === 'align_shapes') {
        const align = String(op.align || '').toLowerCase();
        const horizontal = { left: 0, center: 0.5, right: 1 }[align];
        const vertical = { top: 0, middle: 0.5, center: 0.5, bottom: 1 }[align];
        if (horizontal == null && vertical == null) {
          throw new Error('align must be left, center, right, top, middle, or bottom');
        }
        for (const placement of placements) {
          if (['left', 'center', 'right'].includes(align)) {
            placement.left = bounds.left + ((bounds.right - bounds.left - placement.width) * horizontal);
          } else {
            placement.top = bounds.top + ((bounds.bottom - bounds.top - placement.height) * vertical);
          }
        }
      } else {
        const direction = String(op.direction || '').toLowerCase();
        if (!['horizontal', 'vertical'].includes(direction)) {
          throw new Error('distribute direction must be horizontal or vertical');
        }
        const order = placements
          .map((placement, index) => ({ placement, index }))
          .sort((left, right) => (direction === 'horizontal'
            ? left.placement.left - right.placement.left
            : left.placement.top - right.placement.top));
        const total = direction === 'horizontal'
          ? bounds.right - bounds.left - order.reduce((sum, entry) => sum + entry.placement.width, 0)
          : bounds.bottom - bounds.top - order.reduce((sum, entry) => sum + entry.placement.height, 0);
        const gap = total / Math.max(1, order.length - 1);
        let cursor = direction === 'horizontal' ? bounds.left : bounds.top;
        for (const entry of order) {
          if (direction === 'horizontal') {
            entry.placement.left = cursor;
            cursor += entry.placement.width + gap;
          } else {
            entry.placement.top = cursor;
            cursor += entry.placement.height + gap;
          }
        }
      }
      const updates = new Map(selected.map((shape, index) => [shape.start, {
        xml: updateShapeGeometry(shape.xml, {
          left: placements[index].left,
          top: placements[index].top,
        }),
        end: shape.end,
      }]));
      let inner = '';
      let cursor = 0;
      for (const shape of shapes) {
        const update = updates.get(shape.start);
        if (!update) continue;
        inner += tree.inner.slice(cursor, shape.start) + update.xml;
        cursor = update.end;
      }
      inner += tree.inner.slice(cursor);
      zip.file(path, `${current.slice(0, tree.start)}${inner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), shapes: numbers.length });
      continue;
    }
    if (op.op === 'set_notes') {
      await setSlideNotes(zip, slides, op.slide, op.text);
      results.push({ op: op.op, changed: true, slide: Number(op.slide) });
      continue;
    }
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
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
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
    if (op.op === 'add_textbox' || op.op === 'add_shape') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const id = nextShapeId(current);
      const properties = op.properties || {};
      const textBox = op.op === 'add_textbox';
      const geometry = textBox ? 'rect' : resolveGeometry(op.shapeType);
      if (!geometry) {
        throw new Error(`Unsupported shapeType: ${op.shapeType}. Use one of: ${supportedShapeTypes().join(', ')}`);
      }
      const paragraphs = Array.isArray(op.paragraphs) && op.paragraphs.length
        ? op.paragraphs
        : [{ text: String(op.text ?? '') }];
      const shape = shapeXml({
        id,
        name: `Mixdog ${textBox ? 'TextBox' : 'Shape'} ${id}`,
        geometry,
        left: op.left ?? properties.left ?? 72,
        top: op.top ?? properties.top ?? 72,
        width: op.width ?? properties.width ?? 360,
        height: op.height ?? properties.height ?? 72,
        properties: {
          ...properties,
          ...(op.fillColor == null ? {} : { fillColor: op.fillColor }),
          ...(op.lineColor === undefined ? {} : { lineColor: op.lineColor }),
        },
        textBody: textBodyXml({
          paragraphs,
          defaults: {
            fontName: op.fontName ?? properties.fontName,
            fontSize: op.fontSize ?? properties.fontSize ?? 18,
            color: op.color ?? properties.color,
            bold: properties.bold,
            italic: properties.italic,
            align: properties.align,
            paragraphSpacing: properties.paragraphSpacing,
          },
          anchor: properties.anchor || (textBox ? '' : 'center'),
          margins: properties,
          autofit: properties.autofit || 'none',
        }),
        textBox,
      });
      zip.file(path, appendSlideShape(current, shape));
      results.push({ op: op.op, changed: true, shapeId: id });
      continue;
    }
    if (op.op === 'delete_shape') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
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
    if (op.op === 'import_slides') {
      const merged = await importSlidesIntoPresentation(zip, op.path, op.slides, op.after);
      slides = await presentationSlides(zip);
      results.push({ op: op.op, changed: merged.count > 0, count: merged.count, source: op.path });
      continue;
    }
    if (op.op === 'set_slide_background') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      zip.file(path, setSlideBackground(current, op.color));
      results.push({ op: op.op, changed: true, slide: Number(op.slide) });
      continue;
    }
    if (op.op === 'add_table') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const id = nextShapeId(current);
      const table = tableXml({
        id,
        values: Array.isArray(op.values) ? op.values : [],
        left: op.left ?? 72,
        top: op.top ?? 72,
        width: op.width ?? 480,
        height: op.height ?? 120,
        properties: op.properties || {},
      });
      zip.file(path, appendSlideShape(current, table));
      results.push({ op: op.op, changed: true, shapeId: id });
      continue;
    }
    if (op.op === 'add_image') {
      const path = slidePath(slides, op.slide);
      const media = await addSlideImage(zip, path, op.path);
      const current = await zipText(zip, path);
      const id = nextShapeId(current);
      const picture = pictureXml({
        id,
        embedId: media.relationshipId,
        left: op.left ?? 72,
        top: op.top ?? 72,
        width: op.width ?? 240,
        height: op.height ?? 180,
      });
      zip.file(path, appendSlideShape(current, picture));
      results.push({ op: op.op, changed: true, shapeId: id, image: media.part });
      continue;
    }
    if (op.op === 'add_chart') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const categories = Array.isArray(op.categories) ? op.categories : [];
      const series = Array.isArray(op.series) ? op.series : [];
      let ordinal = 1;
      while (zip.file(`ppt/charts/chart${ordinal}.xml`)) ordinal += 1;
      const chartPart = `ppt/charts/chart${ordinal}.xml`;
      await writePresentationChart(zip, {
        chartPart,
        embeddingPart: `ppt/embeddings/chartData${ordinal}.xlsx`,
        chart: chartXml({
          chartType: op.chartType,
          title: op.title,
          categories,
          series,
          showValues: op.showValues === true,
          dataLabelPosition: op.dataLabelPosition,
          dataLabelColor: op.dataLabelColor,
          valueNumberFormat: op.valueNumberFormat,
          showLegend: op.showLegend,
          zeroBaseline: op.zeroBaseline === true,
          externalDataId: 'rId1',
        }),
        rows: chartWorkbookRows(categories, series),
      });
      const relationshipId = await addPackageRelationship(
        zip,
        partRelationshipPath(path),
        `${OFFICE_RELATIONSHIP_BASE}/chart`,
        posix.relative('ppt/slides', chartPart),
      );
      const id = nextShapeId(current);
      zip.file(path, appendSlideShape(current, chartFrameXml({
        id,
        relationshipId,
        left: op.left ?? 72,
        top: op.top ?? 72,
        width: op.width ?? 480,
        height: op.height ?? 280,
      })));
      results.push({ op: op.op, changed: true, shapeId: id, chart: chartPart });
      continue;
    }
    if (op.op === 'set_chart_data') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const reference = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(shape.xml)?.[1];
      if (!reference) throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a chart`);
      const target = relationshipMap(await zipText(zip, partRelationshipPath(path))).get(reference);
      if (!target) throw new Error(`PPTX chart relationship ${reference} is missing on slide ${op.slide}`);
      const chartPart = posix.normalize(posix.join('ppt/slides', target));
      const existing = await zipText(zip, chartPart);
      if (!existing) throw new Error(`PPTX chart part is missing: ${chartPart}`);
      const series = Array.isArray(op.series) ? op.series : [];
      if (!series.length) throw new Error('set_chart_data requires series');
      const categories = Array.isArray(op.categories) ? op.categories : chartCategories(existing);
      const chartRelationships = await zipText(zip, partRelationshipPath(chartPart));
      const embedded = /<Relationship\b[^>]*\bType="[^"]*\/package"[^>]*\bTarget="([^"]+)"/.exec(chartRelationships)?.[1];
      const embeddingPart = embedded
        ? posix.normalize(posix.join(posix.dirname(chartPart), embedded))
        : `ppt/embeddings/chartData${Number(/chart(\d+)\.xml$/.exec(chartPart)?.[1]) || 1}.xlsx`;
      await writePresentationChart(zip, {
        chartPart,
        embeddingPart,
        chart: chartXml({
          chartType: op.chartType || detectChartType(existing),
          title: op.title ?? chartTitleText(existing),
          categories,
          series,
          showValues: op.showValues === true,
          dataLabelPosition: op.dataLabelPosition,
          dataLabelColor: op.dataLabelColor,
          valueNumberFormat: op.valueNumberFormat,
          showLegend: op.showLegend,
          zeroBaseline: op.zeroBaseline === true,
          externalDataId: 'rId1',
        }),
        rows: chartWorkbookRows(categories, series),
      });
      results.push({ op: op.op, changed: true, slide: Number(op.slide), chart: chartPart });
      continue;
    }
    if (op.op === 'set_chart_axis') {
      const axis = String(op.axis || '').toLowerCase();
      const tag = axis === 'category' ? 'c:catAx' : axis === 'value' ? 'c:valAx' : '';
      if (!tag) throw new Error('set_chart_axis axis must be category or value');
      const chart = await resolveSlideChart(zip, slides, op);
      const pattern = new RegExp(`<${tagPattern(tag)}>[\\s\\S]*?<\\/${tagPattern(tag)}>`);
      const block = pattern.exec(chart.xml);
      if (!block) throw new Error(`Chart has no ${axis} axis`);
      let updated = block[0];
      if (op.minimum != null || op.maximum != null) {
        updated = updated.replace(/<c:scaling>[\s\S]*?<\/c:scaling>/, (scaling) => {
          const cleaned = scaling.replace(/<c:min\b[^>]*\/>/, '').replace(/<c:max\b[^>]*\/>/, '');
          const bounds = `${op.maximum != null ? `<c:max val="${Number(op.maximum)}"/>` : ''}`
            + `${op.minimum != null ? `<c:min val="${Number(op.minimum)}"/>` : ''}`;
          return cleaned.replace('</c:scaling>', `${bounds}</c:scaling>`);
        });
      }
      if (op.numberFormat != null) {
        updated = upsertOrderedChild(
          updated,
          CHART_AXIS_ORDER,
          'c:numFmt',
          op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : '',
        );
      }
      if (op.majorUnit != null) {
        updated = upsertOrderedChild(
          updated,
          CHART_AXIS_ORDER,
          'c:majorUnit',
          Number(op.majorUnit) > 0 ? `<c:majorUnit val="${Number(op.majorUnit)}"/>` : '',
        );
      }
      if (op.title != null) {
        const title = String(op.title);
        updated = upsertOrderedChild(
          updated,
          CHART_AXIS_ORDER,
          'c:title',
          title
            ? '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>'
              + `<a:rPr lang="en-US" sz="900"/><a:t>${xmlEncode(title)}</a:t>`
              + '</a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
            : '',
        );
      }
      zip.file(chart.part, `${chart.xml.slice(0, block.index)}${updated}${chart.xml.slice(block.index + block[0].length)}`);
      results.push({ op: op.op, changed: updated !== block[0], slide: Number(op.slide), axis });
      continue;
    }
    if (op.op === 'set_chart_series') {
      if (op.chartType != null || op.secondaryAxis != null) {
        throw new Error('Portable set_chart_series cannot change the series type or axis; rebuild the chart with add_chart');
      }
      const chart = await resolveSlideChart(zip, slides, op);
      const wanted = Math.max(1, Number(op.series) || 1);
      let index = 0;
      let changed = false;
      const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
        index += 1;
        if (index !== wanted) return series;
        changed = true;
        let updated = series;
        if (op.name != null) {
          updated = updated.replace(
            /(<c:tx>[\s\S]*?<c:strCache>[\s\S]*?<c:pt idx="0"><c:v>)[\s\S]*?(<\/c:v>)/,
            `$1${xmlEncode(String(op.name))}$2`,
          );
        }
        if (Array.isArray(op.categories) && op.categories.length) {
          const points = op.categories
            .map((entry, position) => `<c:pt idx="${position}"><c:v>${xmlEncode(entry ?? '')}</c:v></c:pt>`)
            .join('');
          updated = updated.replace(/<c:cat>[\s\S]*?<\/c:cat>/, (block) => block
            .replace(/<c:strCache>[\s\S]*?<\/c:strCache>/, `<c:strCache><c:ptCount val="${op.categories.length}"/>${points}</c:strCache>`)
            .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.categories.length + 1}$2`));
        }
        if (Array.isArray(op.values) && op.values.length) {
          const points = op.values
            .map((entry, position) => {
              const numeric = Number(entry);
              return Number.isFinite(numeric) ? `<c:pt idx="${position}"><c:v>${numeric}</c:v></c:pt>` : '';
            })
            .join('');
          updated = updated.replace(/<c:val>[\s\S]*?<\/c:val>/, (block) => block
            .replace(
              /<c:numCache>[\s\S]*?<\/c:numCache>/,
              (cache) => cache
                .replace(/<c:ptCount val="\d+"\/>[\s\S]*?(?=<\/c:numCache>)/, `<c:ptCount val="${op.values.length}"/>${points}`),
            )
            .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.values.length + 1}$2`));
        }
        return updated;
      });
      if (!changed) throw new Error(`Chart has no series ${wanted}`);
      zip.file(chart.part, next);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), series: wanted });
      continue;
    }
    if (op.op === 'set_chart_trendline' || op.op === 'set_chart_error_bars') {
      const chart = await resolveSlideChart(zip, slides, op);
      const wanted = Number(op.series);
      let index = 0;
      let changed = false;
      const element = op.op === 'set_chart_trendline'
        ? (() => {
          const types = ['linear', 'poly', 'exp', 'log', 'movingAvg', 'power'];
          const type = String(op.type || 'linear').trim();
          if (!types.includes(type)) {
            throw new Error(`set_chart_trendline type must be one of: ${types.join(', ')}`);
          }
          return `<c:trendline><c:trendlineType val="${type}"/>`
            + `<c:dispRSqr val="${op.displayRSquared === true ? 1 : 0}"/>`
            + `<c:dispEq val="${op.displayEquation === true ? 1 : 0}"/></c:trendline>`;
        })()
        : (() => {
          const directions = { y: 'y', x: 'x', vertical: 'y', horizontal: 'x' };
          const direction = directions[String(op.direction || 'y').toLowerCase()];
          if (!direction) throw new Error('set_chart_error_bars direction must be x or y');
          const style = String(op.endStyle || 'both').toLowerCase();
          const barType = ['both', 'minus', 'plus'].includes(style) ? style : 'both';
          const amount = Number(op.amount);
          if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('set_chart_error_bars requires a positive amount');
          }
          return `<c:errBars><c:errDir val="${direction}"/><c:errBarType val="${barType}"/>`
            + `<c:errValType val="fixedVal"/><c:noEndCap val="0"/><c:val val="${amount}"/></c:errBars>`;
        })();
      const tag = op.op === 'set_chart_trendline' ? 'c:trendline' : 'c:errBars';
      const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
        index += 1;
        if (Number.isInteger(wanted) && wanted > 0 && wanted !== index) return series;
        changed = true;
        const cleaned = series.replace(new RegExp(`<${tagPattern(tag)}>[\\s\\S]*?<\\/${tagPattern(tag)}>`, 'g'), '');
        const anchor = /<c:cat>/.exec(cleaned) || /<c:val>/.exec(cleaned);
        return anchor
          ? `${cleaned.slice(0, anchor.index)}${element}${cleaned.slice(anchor.index)}`
          : cleaned.replace('</c:ser>', `${element}</c:ser>`);
      });
      if (!changed) throw new Error(`Chart has no series ${op.series ?? ''}`.trim());
      zip.file(chart.part, next);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), series: wanted || 'all' });
      continue;
    }
    if (op.op === 'set_chart_data_labels') {
      const chart = await resolveSlideChart(zip, slides, op);
      const position = LABEL_POSITION_CODES[String(op.position || '').toLowerCase()] || '';
      const stacked = /<c:grouping val="stacked"\/>/.test(chart.xml);
      const pie = /<c:(?:pie|doughnut)Chart\b/.test(chart.xml);
      const usable = stacked && position === 'outEnd' ? 'ctr' : position;
      const labels = op.showValue === false && op.showCategoryName !== true
        ? ''
        : '<c:dLbls>'
          + (op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : '')
          + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'
          + (usable && !pie ? `<c:dLblPos val="${usable}"/>` : '')
          + '<c:showLegendKey val="0"/>'
          + `<c:showVal val="${op.showValue === false ? 0 : 1}"/>`
          + `<c:showCatName val="${op.showCategoryName === true ? 1 : 0}"/>`
          + '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>'
          + '</c:dLbls>';
      const wanted = Number(op.series);
      let index = 0;
      let changed = false;
      const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
        index += 1;
        if (Number.isInteger(wanted) && wanted > 0 && wanted !== index) return series;
        changed = true;
        const cleaned = series.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, '');
        if (!labels) return cleaned;
        const anchor = /<c:cat>/.exec(cleaned);
        return anchor
          ? `${cleaned.slice(0, anchor.index)}${labels}${cleaned.slice(anchor.index)}`
          : cleaned.replace('</c:ser>', `${labels}</c:ser>`);
      });
      if (!changed) throw new Error(`Chart has no series ${op.series ?? ''}`.trim());
      zip.file(chart.part, next);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), series: wanted || 'all' });
      continue;
    }
    if (op.op === 'fit_text') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const paragraphs = shapeParagraphs(shape.xml);
      if (!paragraphs?.length) throw new Error(`PPTX shape ${op.shape} has no measurable text run`);
      const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shape.xml);
      if (!extent) throw new Error(`PPTX shape ${op.shape} has no explicit size`);
      const bodyProperties = /<a:bodyPr\b([^>]*?)\/?>/.exec(shape.xml)?.[1] || '';
      const inset = (name, fallback) => {
        const value = Number(xmlAttribute(bodyProperties, name));
        return Number.isFinite(value) ? value / 12_700 : fallback;
      };
      const minimumFontSize = Math.max(1, Number(op.minFontSize) || 8);
      const fitted = shrinkFontSizeToFit(paragraphs, {
        width: Math.max(1, (Number(extent[1]) / 12_700) - inset('lIns', DEFAULT_TEXT_INSETS.left) - inset('rIns', DEFAULT_TEXT_INSETS.right)),
        height: Math.max(1, (Number(extent[2]) / 12_700) - inset('tIns', DEFAULT_TEXT_INSETS.top) - inset('bIns', DEFAULT_TEXT_INSETS.bottom)),
        minimumFontSize,
      });
      if (!fitted.scale) {
        throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} cannot fit its text above ${minimumFontSize}pt`);
      }
      const changed = fitted.scale < 1;
      const updated = changed
        ? shape.xml.replace(/\bsz="(\d+)"/g, (_, size) => (
          `sz="${Math.max(minimumFontSize * 100, Math.round(Number(size) * fitted.scale))}"`
        ))
        : shape.xml;
      if (changed) {
        const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
        zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
      }
      results.push({
        op: op.op,
        changed,
        slide: Number(op.slide),
        shape: Number(op.shape),
        scale: Number(fitted.scale.toFixed(2)),
      });
      continue;
    }
    if (op.op === 'set_table_data' || op.op === 'replace_image') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      let updated;
      let detail = {};
      if (op.op === 'set_table_data') {
        const values = Array.isArray(op.values) ? op.values.filter((row) => Array.isArray(row)) : [];
        if (!values.length) throw new Error('set_table_data requires values as an array of rows');
        const filled = setTableValues(shape.xml, values);
        updated = filled.xml;
        detail = { rows: filled.rows, cells: filled.cells, capacity: filled.capacity };
        if (values.length > filled.capacity) {
          detail.droppedRows = values.length - filled.capacity;
        }
      } else {
        if (shape.name !== 'p:pic') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a picture`);
        const previous = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(shape.xml)?.[1];
        if (!previous) throw new Error(`PPTX picture ${op.shape} on slide ${op.slide} has no image reference`);
        const media = await addSlideImage(zip, path, op.path);
        updated = shape.xml.replace(/(<a:blip\b[^>]*\br:embed=")[^"]*(")/, `$1${media.relationshipId}$2`);
        detail = { image: media.part, replaced: previous };
      }
      const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
      const nextSlide = `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`;
      zip.file(path, nextSlide);
      if (detail.replaced && !nextSlide.includes(`r:embed="${detail.replaced}"`)) {
        await removePackageRelationship(zip, partRelationshipPath(path), detail.replaced);
      }
      results.push({ op: op.op, changed: updated !== shape.xml, slide: Number(op.slide), ...detail });
      continue;
    }
    if (op.op === 'group_shapes' || op.op === 'ungroup_shape') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      if (op.op === 'ungroup_shape') {
        const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
        const group = shapes[Number(op.shape) - 1];
        if (!group) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
        if (group.name !== 'p:grpSp') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a group`);
        const children = containerBody(group.xml, 'p:grpSp')
          .replace(/<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr>/, '')
          .replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/, '');
        const nextInner = `${tree.inner.slice(0, group.start)}${children}${tree.inner.slice(group.end)}`;
        zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
        results.push({ op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape) });
        continue;
      }
      const numbers = Array.isArray(op.shapes) ? [...new Set(op.shapes.map(Number))].sort((left, right) => left - right) : [];
      if (numbers.length < 2) throw new Error('group_shapes requires at least two shapes');
      const { shapes, selected } = selectedShapeSpans(tree, numbers);
      const frames = selected.map((shape) => shapeFrame(shape.xml));
      if (frames.some((frame) => !frame)) throw new Error('group_shapes needs shapes with explicit geometry');
      const left = Math.min(...frames.map((frame) => frame.left));
      const top = Math.min(...frames.map((frame) => frame.top));
      const right = Math.max(...frames.map((frame) => frame.left + frame.width));
      const bottom = Math.max(...frames.map((frame) => frame.top + frame.height));
      const id = nextShapeId(current);
      const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/>`
        + '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        + `<p:grpSpPr><a:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>`
        + `<a:ext cx="${Math.max(1, toEmu(right - left))}" cy="${Math.max(1, toEmu(bottom - top))}"/>`
        + `<a:chOff x="${toEmu(left)}" y="${toEmu(top)}"/>`
        + `<a:chExt cx="${Math.max(1, toEmu(right - left))}" cy="${Math.max(1, toEmu(bottom - top))}"/>`
        + '</a:xfrm></p:grpSpPr>'
        + selected.map((shape) => shape.xml).join('')
        + '</p:grpSp>';
      const anchors = new Set(selected.map((shape) => shape.start));
      let inner = '';
      let cursor = 0;
      for (const shape of shapes) {
        if (!anchors.has(shape.start)) continue;
        inner += tree.inner.slice(cursor, shape.start);
        cursor = shape.end;
      }
      inner += tree.inner.slice(cursor);
      zip.file(path, `${current.slice(0, tree.start)}${inner}${group}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), shapes: numbers.length, shapeId: id });
      continue;
    }
    if (op.op === 'set_footer' || op.op === 'set_slide_number') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const placeholder = op.op === 'set_footer' ? 'ftr' : 'sldNum';
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      let inner = tree.inner;
      for (let index = shapes.length - 1; index >= 0; index -= 1) {
        if (!new RegExp(`<p:ph\\b[^>]*\\btype="${placeholder}"`).test(shapes[index].xml)) continue;
        inner = `${inner.slice(0, shapes[index].start)}${inner.slice(shapes[index].end)}`;
      }
      const hidden = op.op === 'set_slide_number' && op.visible === false;
      if (!hidden) {
        const size = await presentationSlideSize(zip);
        const id = nextShapeId(current);
        const footer = op.op === 'set_footer';
        const body = footer
          ? textBodyXml({
            paragraphs: [{ text: String(op.text || '') }],
            defaults: { fontSize: 10, color: '7C838B' },
            anchor: 'center',
          })
          : '<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr><a:lstStyle/>'
            + `<a:p><a:pPr algn="r"/><a:fld id="{${randomUUID().toUpperCase()}}" type="slidenum">`
            + '<a:rPr lang="en-US" sz="1000"><a:solidFill><a:srgbClr val="7C838B"/></a:solidFill></a:rPr>'
            + `<a:t>${Number(op.slide)}</a:t></a:fld></a:p>`;
        const shape = `<p:sp><p:nvSpPr>`
          + `<p:cNvPr id="${id}" name="${footer ? 'Footer Placeholder' : 'Slide Number Placeholder'} ${id}"/>`
          + '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
          + `<p:nvPr><p:ph type="${placeholder}" sz="quarter" idx="${footer ? 10 : 12}"/></p:nvPr></p:nvSpPr>`
          + `<p:spPr><a:xfrm><a:off x="${toEmu(footer ? 58 : size.width - 158)}" y="${toEmu(size.height - 40)}"/>`
          + `<a:ext cx="${toEmu(footer ? size.width - 240 : 100)}" cy="${toEmu(24)}"/></a:xfrm>`
          + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
          + `<p:txBody>${body}</p:txBody></p:sp>`;
        inner = `${inner}${shape}`;
      }
      zip.file(path, `${current.slice(0, tree.start)}${inner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), ...(hidden ? { visible: false } : {}) });
      continue;
    }
    if (op.op === 'apply_theme') {
      const source = await JSZip.loadAsync(await readFile(op.path));
      const themePart = Object.keys(source.files)
        .find((name) => /^(?:ppt\/)?theme\/theme\d+\.xml$/i.test(name));
      if (!themePart) throw new Error(`apply_theme source has no theme part: ${op.path}`);
      const theme = await zipText(source, themePart);
      const masters = Object.keys(zip.files)
        .filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
      const targets = new Set();
      for (const master of masters) {
        const target = /<Relationship\b[^>]*\bType="[^"]*\/theme"[^>]*\bTarget="([^"]+)"/
          .exec(await zipText(zip, partRelationshipPath(master)))?.[1];
        if (target) targets.add(posix.normalize(posix.join(posix.dirname(master), target)));
      }
      if (!targets.size) targets.add('ppt/theme/theme1.xml');
      for (const part of targets) zip.file(part, theme);
      results.push({ op: op.op, changed: true, theme: themePart, applied: [...targets] });
      continue;
    }
    if (op.op === 'add_media') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const kind = String(op.kind || 'video').toLowerCase();
      if (!['video', 'audio'].includes(kind)) throw new Error('add_media kind must be video or audio');
      const extension = extname(String(op.path || '')).replace(/^\./, '').toLowerCase();
      if (!extension) throw new Error('add_media requires a media file path');
      const mediaTypes = {
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
        wmv: 'video/x-ms-wmv', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
      };
      const contentType = mediaTypes[extension];
      if (!contentType) {
        throw new Error(`Unsupported media type: .${extension}. Use ${Object.keys(mediaTypes).join(', ')}`);
      }
      if (!op.poster) throw new Error('add_media requires poster for the preview frame');
      let ordinal = 1;
      while (zip.file(`ppt/media/media${ordinal}.${extension}`)) ordinal += 1;
      const mediaPart = `ppt/media/media${ordinal}.${extension}`;
      zip.file(mediaPart, await readFile(op.path));
      await ensureDefaultContentType(zip, extension, contentType);
      const relative = posix.relative('ppt/slides', mediaPart);
      const mediaId = await addPackageRelationship(
        zip,
        partRelationshipPath(path),
        `http://schemas.microsoft.com/office/2007/relationships/media`,
        relative,
      );
      const linkId = await addPackageRelationship(
        zip,
        partRelationshipPath(path),
        `${OFFICE_RELATIONSHIP_BASE}/${kind}`,
        relative,
      );
      const poster = await addSlideImage(zip, path, op.poster);
      const id = nextShapeId(current);
      const shape = '<p:pic><p:nvPicPr>'
        + `<p:cNvPr id="${id}" name="${xmlEncode(posix.basename(mediaPart))}">`
        + '<a:hlinkClick xmlns:a="' + DRAWING_MAIN_NS + '" r:id="" action="ppaction://media"/></p:cNvPr>'
        + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
        + `<p:nvPr><a:${kind}File xmlns:a="${DRAWING_MAIN_NS}" r:link="${linkId}"/>`
        + `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">`
        + `<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${mediaId}"/>`
        + '</p:ext></p:extLst></p:nvPr></p:nvPicPr>'
        + `<p:blipFill><a:blip r:embed="${poster.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
        + `<p:spPr><a:xfrm><a:off x="${toEmu(op.left ?? 72)}" y="${toEmu(op.top ?? 72)}"/>`
        + `<a:ext cx="${Math.max(1, toEmu(op.width ?? 360))}" cy="${Math.max(1, toEmu(op.height ?? 240))}"/></a:xfrm>`
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
      zip.file(path, appendSlideShape(await zipText(zip, path), shape));
      results.push({ op: op.op, changed: true, slide: Number(op.slide), media: mediaPart, kind });
      continue;
    }
    if (op.op === 'set_layout') {
      const path = slidePath(slides, op.slide);
      const layout = selectSlideLayout(await slideLayoutParts(zip), op.layout);
      const relationships = partRelationshipPath(path);
      const rels = await zipText(zip, relationships);
      const target = posix.relative('ppt/slides', layout.path);
      const pattern = /<Relationship\b[^>]*\bType="[^"]*\/slideLayout"[^>]*\/>/;
      const next = pattern.test(rels)
        ? rels.replace(pattern, (block) => block.replace(/\bTarget="[^"]*"/, `Target="${xmlEncode(target)}"`))
        : rels.replace('</Relationships>', `<Relationship Id="${nextRelationshipId(rels)}" Type="${OFFICE_RELATIONSHIP_BASE}/slideLayout" Target="${xmlEncode(target)}"/></Relationships>`);
      zip.file(relationships, next);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), layout: layout.name || layout.type });
      continue;
    }
    if (op.op === 'crop_image') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      if (shape.name !== 'p:pic') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a picture`);
      const edge = (value) => Math.max(0, Math.min(100_000, Math.round((Number(value) || 0) * 1000)));
      const rect = `<a:srcRect l="${edge(op.left)}" t="${edge(op.top)}" r="${edge(op.right)}" b="${edge(op.bottom)}"/>`;
      const updated = shape.xml
        .replace(/<a:srcRect\b[^>]*\/>/, '')
        .replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/, `$1${rect}`);
      const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
      zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape) });
      continue;
    }
    if (op.op === 'set_transition') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const effects = {
        fade: '<p:fade/>',
        cut: '<p:cut/>',
        push: '<p:push/>',
        wipe: '<p:wipe/>',
        split: '<p:split/>',
        dissolve: '<p:dissolve/>',
        cover: '<p:cover/>',
        zoom: '<p:zoom/>',
        none: '',
      };
      const requested = String(op.effect || 'fade').toLowerCase();
      if (!Object.hasOwn(effects, requested)) {
        throw new Error(`set_transition effect must be one of: ${Object.keys(effects).join(', ')}`);
      }
      const duration = Number(op.duration);
      const speed = Number.isFinite(duration) && duration > 0
        ? (duration >= 1500 ? 'slow' : duration <= 500 ? 'fast' : 'med')
        : 'med';
      const advance = op.advanceOnTime === true && Number(op.advanceTime) > 0
        ? ` advTm="${Math.round(Number(op.advanceTime))}"`
        : '';
      const element = requested === 'none'
        ? ''
        : `<p:transition spd="${speed}"${advance}>${effects[requested]}</p:transition>`;
      const stripped = current.replace(/<p:transition\b[^>]*?(?:\/>|>[\s\S]*?<\/p:transition>)/, '');
      const anchor = /<p:clrMapOvr\b[^>]*?(?:\/>|>[\s\S]*?<\/p:clrMapOvr>)/.exec(stripped);
      const next = element
        ? (anchor
          ? `${stripped.slice(0, anchor.index + anchor[0].length)}${element}${stripped.slice(anchor.index + anchor[0].length)}`
          : stripped.replace('</p:sld>', `${element}</p:sld>`))
        : stripped;
      zip.file(path, next);
      results.push({ op: op.op, changed: true, slide: Number(op.slide), effect: requested });
      continue;
    }
    if (op.op === 'set_shape') {
      const path = slidePath(slides, op.slide);
      const current = await zipText(zip, path);
      const tree = containerInner(current, 'p:spTree');
      if (!tree) throw new Error('PPTX slide shape tree is missing');
      const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
      const shape = shapes[Number(op.shape) - 1];
      if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
      const updated = updateShapeGeometry(shape.xml, op.properties || {});
      const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
      zip.file(path, `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`);
      results.push({ op: op.op, changed: updated !== shape.xml });
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
  if (operations.some((operation) => ['delete_slide', 'replace_image', 'delete_shape'].includes(operation.op))) {
    await removeOrphanPackageParts(zip).catch(() => ({ removed: [] }));
  }
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

const BUILTIN_NUMBER_FORMATS = Object.freeze({
  9: '0%',
  10: '0.00%',
  5: '$#,##0_);($#,##0)',
  6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)',
  8: '$#,##0.00_);[Red]($#,##0.00)',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
});

async function workbookNumberFormats(zip) {
  const styles = await zipText(zip, 'xl/styles.xml');
  if (!styles) return [];
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)]
    .map((match) => [Number(match[1]), xmlDecode(match[2])]));
  const section = /<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] || '';
  return [...section.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((match) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[0])?.[1]) || 0;
    return custom.get(id) || BUILTIN_NUMBER_FORMATS[id] || '';
  });
}

async function percentScaleIssues(zip, sheets) {
  const formats = await workbookNumberFormats(zip);
  if (!formats.length) return [];
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const style = Number(/\bs="(\d+)"/.exec(match[1])?.[1]);
      if (!Number.isInteger(style)) continue;
      const format = formats[style] || '';
      if (!format.includes('%')) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(match[2])?.[1];
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) <= 1.5) continue;
      const reference = /\br="([A-Z]+\d+)"/.exec(match[1])?.[1] || '';
      issues.push({
        severity: 'warning',
        code: 'percent_stored_as_whole',
        path: `/sheet[${sheet.name}]/cell[${reference}]`,
        message: `Percent-formatted cell holds ${value}; Excel renders that as ${(value * 100).toLocaleString('en-US')}%. Store percentages as fractions.`,
        source: 'number-format',
      });
      if (issues.length >= 50) return issues;
    }
  }
  return issues;
}

const DEFAULT_COLUMN_WIDTH = 8.43;

function formattedNumberWidth(value, format) {
  const absolute = Math.abs(value);
  const decimals = (format.match(/\.(0+)/)?.[1] || '').length;
  const grouped = format.includes(',');
  const percent = format.includes('%');
  const scaled = percent ? absolute * 100 : absolute;
  const whole = Math.trunc(scaled);
  let width = String(whole).length;
  if (grouped && whole >= 1000) width += Math.floor((String(whole).length - 1) / 3);
  if (decimals) width += decimals + 1;
  if (percent) width += 1;
  if (/[$€£¥₩]/.test(format)) width += 1;
  if (value < 0) width += 1;
  return width;
}

async function columnFitIssues(zip, sheets) {
  const formats = await workbookNumberFormats(zip);
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    const widths = new Map();
    const section = worksheetSection(xml, 'cols');
    if (section) {
      for (const match of section[0].matchAll(/<col\b([^>]*)\/>/g)) {
        const min = Number(xmlAttribute(match[1], 'min')) || 0;
        const max = Number(xmlAttribute(match[1], 'max')) || min;
        const width = Number(xmlAttribute(match[1], 'width'));
        if (!Number.isFinite(width) || width <= 0) continue;
        for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
          widths.set(column, width);
        }
      }
    }
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = match[1];
      if (/\bt="(?:s|inlineStr|str|b)"/.test(attributes)) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(match[2])?.[1];
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      if (!reference) continue;
      const column = columnNumber(parseCellRef(reference).col);
      const width = widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
      const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1]);
      const format = Number.isInteger(style) ? formats[style] || '' : '';
      const needed = formattedNumberWidth(value, format);
      if (needed <= width + 0.5) continue;
      issues.push({
        severity: 'warning',
        code: 'column_too_narrow',
        path: `/sheet[${sheet.name}]/cell[${reference}]`,
        message: `Number needs about ${needed} characters but column ${columnLabel(column)} is ${width.toFixed(1)} wide; Excel shows ###. Run autofit_range.`,
        source: 'number-format',
      });
      if (issues.length >= 50) return issues;
    }
  }
  return issues;
}

async function formulaConsistencyIssues(zip, sheets) {
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => ({
        reference: /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1] || '',
        formula: /<f[\s>]/.test(cell[2]),
        numeric: !/\bt="(?:s|inlineStr|str|b)"/.test(cell[1])
          && Number.isFinite(Number(/<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1])),
      }));
      if (cells.filter((cell) => cell.formula).length < 3) continue;
      for (const cell of cells) {
        if (cell.formula || !cell.numeric || !cell.reference) continue;
        issues.push({
          severity: 'warning',
          code: 'formula_inconsistency',
          path: `/sheet[${sheet.name}]/cell[${cell.reference}]`,
          message: 'A hardcoded value interrupts a row of formulas; a lone edited cell mid-row is a common silent error.',
          source: 'formula-audit',
        });
        if (issues.length >= 50) return issues;
      }
    }
  }
  return issues;
}

const PLACEHOLDER_RULES = Object.freeze([
  { code: 'placeholder_text', label: 'lorem ipsum filler', pattern: /\b(?:lorem|ipsum)\b/i },
  { code: 'placeholder_text', label: 'repeated X placeholder', pattern: /\bx{3,}\b/i },
  { code: 'placeholder_text', label: 'TODO marker', pattern: /\bTODO\b/ },
  { code: 'placeholder_text', label: 'insert marker', pattern: /\[\s*insert\b/i },
  { code: 'placeholder_text', label: 'layout instruction', pattern: /this[^.]{0,40}\b(?:page|slide)\b[^.]{0,40}layout/i },
  { code: 'placeholder_text', label: 'click-to-edit prompt', pattern: /click to (?:edit|add)/i },
  { code: 'placeholder_text', label: 'Korean input prompt', pattern: /(?:여기에|내용을|제목을)\s*입력/ },
  { code: 'unfilled_token', label: 'unresolved template token', pattern: /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/ },
]);

async function placeholderIssues(zip, format) {
  const parts = format === 'pptx'
    ? Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
    : format === 'docx'
      ? ['word/document.xml']
      : [];
  if (!parts.length) return [];
  const tag = format === 'pptx' ? 'a:t' : 'w:t';
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const text = paragraphTexts(xml, tag).join(' ');
    if (!text.trim()) continue;
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    for (const rule of PLACEHOLDER_RULES) {
      const found = rule.pattern.exec(text);
      if (!found) continue;
      issues.push({
        severity: 'warning',
        code: rule.code,
        path: slide ? `/slide[${slide}]` : '/body',
        message: `Leftover ${rule.label}: "${found[0].slice(0, 60)}"`,
        source: 'placeholder-scan',
      });
    }
  }
  return issues;
}

const CLEANABLE_PARTS = /^(?:ppt|xl|word)\/(?:media|embeddings|charts|drawings|diagrams|ink|notesSlides)\//i;

async function referencedParts(zip) {
  const referenced = new Set();
  for (const relationships of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
    const owner = relationshipOwner(relationships);
    const xml = await zipText(zip, relationships);
    if (!xml) continue;
    for (const match of xml.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
      if (/\bTargetMode="External"/i.test(match[0])) continue;
      const target = xmlDecode(xmlAttribute(match[0], 'Target'));
      if (!target) continue;
      referenced.add(target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(posix.dirname(owner || ''), target)));
    }
  }
  return referenced;
}

export async function removeOrphanPackageParts(zip) {
  const removed = [];
  if (!Object.keys(zip.files).some((name) => name.endsWith('.rels'))) {
    return { removed, skipped: 'no-relationship-parts' };
  }
  for (let pass = 0; pass < 8; pass += 1) {
    const referenced = await referencedParts(zip);
    if (!referenced.size) {
      throw new Error('Refusing to clean the package: no relationship resolves to a part');
    }
    const orphans = Object.keys(zip.files).filter((name) => (
      !zip.files[name].dir
      && CLEANABLE_PARTS.test(name)
      && !name.includes('/_rels/')
      && !referenced.has(name)
    ));
    if (!orphans.length) break;
    for (const orphan of orphans) {
      zip.remove(orphan);
      removed.push(orphan);
      const relationships = partRelationshipPath(orphan);
      if (zip.file(relationships)) {
        zip.remove(relationships);
        removed.push(relationships);
      }
      await removeContentTypeOverride(zip, `/${orphan}`);
    }
  }
  return { removed };
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
  for (const finding of await placeholderIssues(zip, format)) issues.push(finding);
  if (format === 'xlsx') {
    const workbookSheetList = await workbookSheets(zip);
    for (const finding of await percentScaleIssues(zip, workbookSheetList)) issues.push(finding);
    for (const finding of await columnFitIssues(zip, workbookSheetList)) issues.push(finding);
    for (const finding of await formulaConsistencyIssues(zip, workbookSheetList)) issues.push(finding);
  }
  if (format === 'pptx') {
    const inspected = await inspectPptxTextBoxes(zip);
    for (const fit of reviewTextBoxFit(inspected.boxes, {
      slideWidth: inspected.slideWidth,
      slideHeight: inspected.slideHeight,
    })) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...fit });
    }
    for (const contrast of reviewTextContrast(inspected.boxes)) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...contrast });
    }
    for (const spacing of reviewShapeSpacing(inspected.boxes)) {
      issues.push({ severity: 'info', source: 'text-metrics', ...spacing });
    }
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
    const document = await zipText(zip, 'word/document.xml');
    const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
    const printable = body
      .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
      .replace(/<w:sectPr\b[^>]*\/>/g, '');
    if (!/<w:t[\s>]/.test(printable) && !/<w:tbl>/.test(printable) && !/<w:drawing>/.test(printable)) {
      issues.push({
        severity: 'error',
        code: 'empty_document',
        path: '/body',
        message: 'The document body carries no text, table, or image; the requested content never reached the file.',
      });
    }
    const section = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(document)?.[0] || '';
    const page = /<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(section);
    const margins = /<w:pgMar\b[^>]*\bw:left="(\d+)"[^>]*\bw:right="(\d+)"/.exec(section)
      || /<w:pgMar\b[^>]*\bw:right="(\d+)"[^>]*\bw:left="(\d+)"/.exec(section);
    const usable = (page ? Number(page[1]) : 12240)
      - (margins ? Number(margins[1]) + Number(margins[2]) : 2880);
    let ordinal = 0;
    for (const table of document.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
      ordinal += 1;
      const columns = [...table[0].matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].map((match) => Number(match[1]));
      if (!columns.length) continue;
      const width = columns.reduce((total, column) => total + column, 0);
      if (width <= usable * 1.02) continue;
      issues.push({
        severity: 'warning',
        code: 'table_wider_than_page',
        path: `/body/table[${ordinal}]`,
        message: `Table spans ${(width / 1440).toFixed(2)}in across a ${(usable / 1440).toFixed(2)}in text column; run fit_table to rebalance.`,
      });
    }
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
