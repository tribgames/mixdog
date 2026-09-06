import { basename, join, posix } from 'node:path';
import { booleanXmlAttribute, cellRecords, formulaReferences, sharedStrings, workbookCalculation, workbookSheets } from './portable-cells.mjs';
import { loadPackage, partRelationshipPath, relationshipTarget, zipText } from './portable-opc.mjs';
import { blockText, containerInner, paragraphTexts, textNodes, topLevelElements, xmlDecode } from './portable-xml.mjs';
import { presentationSlides } from './portable-pptx-package.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import { mergedRanges } from './portable-sheet-xml.mjs';
import { shapeIdentity } from './pptx-relations.mjs';
import { countDocxPropertyChanges, docxRevisionTree, flattenDocxRevisions } from './docx-revisions.mjs';

const REVISION_TYPES = Object.freeze({
  ins: 'insertion',
  del: 'deletion',
  moveFrom: 'moved_from',
  moveTo: 'moved_to',
});


/** What a paragraph carries beyond its text: list membership (numId 0 means
 *  "no numbering" in Word) and whether tracked changes touch it. */
function paragraphMarkup(paragraphXml) {
  const numbering = /<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/.exec(paragraphXml)?.[1] || '';
  const numId = numbering ? Number(/<w:numId\b[^>]*\bw:val="(-?\d+)"/.exec(numbering)?.[1]) : Number.NaN;
  const tracked = /<w:(?:ins|del|moveFrom|moveTo)\b/.test(paragraphXml);
  // `text` is the accepted view (w:t only); the words a reviewer still sees
  // struck through are listed beside it.
  const deletedText = tracked ? blockText(paragraphXml, 'w:delText') : '';
  return {
    ...(Number.isFinite(numId) && numId > 0
      ? { list: { numId, level: Number(/<w:ilvl\b[^>]*\bw:val="(\d+)"/.exec(numbering)?.[1]) || 0 } }
      : {}),
    ...(tracked ? { tracked: true } : {}),
    ...(deletedText ? { deletedText } : {}),
  };
}

/** Tracked changes touching a table cell, reported the way a paragraph's
 *  are so a reviewer reads table edits alike. */
function cellMarkup(cellXml) {
  if (!/<w:(?:ins|del|moveFrom|moveTo)\b/.test(cellXml)) return {};
  const deletedText = blockText(cellXml, 'w:delText');
  return { tracked: true, ...(deletedText ? { deletedText } : {}) };
}

export function docxBodyModel(documentXml) {
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
        // Word numbers every paragraph in the document, table cells included, so
        // the Office reader reports those too. This model walks body blocks only.
        // Stating the scope lets a caller compare the two readings instead of
        // silently mistaking cell text for body text.
        inTable: false,
        text: blockText(block.xml, 'w:t'),
        // Word resolves a paragraph carrying no explicit style to Normal, and the
        // Office reader reports it that way. Answering with an empty string made
        // the same paragraph look unstyled to one backend and styled to the other.
        style: xmlDecode(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || 'Normal'),
        runs,
        ...paragraphMarkup(block.xml),
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
          text: blockText(cell.xml, 'w:t'),
          ...cellMarkup(cell.xml),
        })),
      }));
      tables.push({
        path: `/body/tbl[${tableIndex}]`,
        index: tableIndex,
        // Word falls back to TableNormal when a table declares no style, which is
        // what the Office reader reports; without this the two backends disagreed
        // on the style of the very same table.
        style: xmlDecode(/<w:tblStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || 'TableNormal'),
        rows,
      });
      block.logicalIndex = tableIndex;
    }
  }
  return { paragraphs, tables, blocks, body };
}


export function appendDocxBlock(documentXml, block) {
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


export async function snapshotDocx(zip, options = {}) {
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort();
  const content = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    content.push({ part, text: blockText(xml, 'w:t') });
  }
  const documentXml = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(documentXml);
  // A paragraph's numId names a definition in numbering.xml; the level's
  // number format tells a bullet from a numbered list.
  const numbering = await zipText(zip, 'word/numbering.xml');
  if (numbering && model.paragraphs.some((paragraph) => paragraph.list)) {
    const abstractOf = new Map([...numbering.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId\b[^>]*\bw:val="(\d+)"/g)]
      .map((match) => [Number(match[1]), Number(match[2])]));
    const formats = new Map();
    for (const abstract of numbering.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
      for (const level of abstract[2].matchAll(/<w:lvl\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
        formats.set(`${abstract[1]}:${level[1]}`, /<w:numFmt\b[^>]*\bw:val="([^"]+)"/.exec(level[2])?.[1] || '');
      }
    }
    for (const paragraph of model.paragraphs) {
      if (!paragraph.list) continue;
      const format = formats.get(`${abstractOf.get(paragraph.list.numId)}:${paragraph.list.level}`);
      if (format) paragraph.list.kind = format === 'bullet' ? 'bullet' : 'number';
    }
  }
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
      anchoredText = blockText(xml.slice(start.index + start[0].length, end.index), 'w:t');
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
      text: blockText(match[2], 'w:t'),
      anchoredText,
      part: anchoredPart,
    });
  }
  const revisions = [];
  let propertyChangeCount = 0;
  // The body block a document.xml offset falls in: a revision names the
  // paragraph or table it sits in, and a paragraph lists its revisions.
  const blockAt = (offset) => {
    if (!model.body) return null;
    const relative = offset - model.body.start;
    return model.blocks.find((block) => block.start <= relative && relative < block.end) || null;
  };
  // Inside a table, the row and cell an offset (relative to the table block)
  // falls in — the outer table's when tables nest — so the revision names
  // the cell.
  const cellAt = (block, offset) => {
    const table = containerInner(block.xml, 'w:tbl');
    if (!table) return { suffix: '' };
    const inTable = offset - table.start;
    const rows = topLevelElements(table.inner, ['w:tr']);
    const rowIndex = rows.findIndex((row) => row.start <= inTable && inTable < row.end);
    if (rowIndex < 0) return { suffix: '' };
    const rowInner = containerInner(rows[rowIndex].xml, 'w:tr');
    const inRow = rowInner ? inTable - rows[rowIndex].start - rowInner.start : -1;
    const cellIndex = rowInner
      ? topLevelElements(rowInner.inner, ['w:tc']).findIndex((cell) => cell.start <= inRow && inRow < cell.end)
      : -1;
    return {
      row: rowIndex + 1,
      cell: cellIndex + 1,
      suffix: `/row[${rowIndex + 1}]${cellIndex < 0 ? '' : `/cell[${cellIndex + 1}]`}`,
    };
  };
  for (const part of storyParts) {
    const xml = await zipText(zip, part);
    propertyChangeCount += countDocxPropertyChanges(xml);
    const inBody = /^word\/document\.xml$/i.test(part);
    // Wrappers in document order of their opening tags, parents before
    // children — the ordinal resolve_revision addresses. A paragraph-mark
    // marker (<w:del/> inside w:rPr) and a formatting record (w:rPrChange)
    // are not wrappers and are not listed.
    for (const span of flattenDocxRevisions(docxRevisionTree(xml))) {
      const block = inBody ? blockAt(span.start) : null;
      const location = block?.name === 'w:tbl' ? cellAt(block, span.start - model.body.start - block.start) : { suffix: '' };
      const at = !block
        ? ''
        : block.name === 'w:p'
          ? `/body/p[${block.logicalIndex}]`
          : `/body/tbl[${block.logicalIndex}]${location.suffix}`;
      revisions.push({
        path: `/body/revision[${revisions.length + 1}]`,
        index: revisions.length + 1,
        id: xmlDecode(span.id),
        author: span.author,
        date: xmlDecode(span.date),
        type: REVISION_TYPES[span.tag],
        text: blockText(xml.slice(span.innerStart, span.innerEnd), span.kind === 'ins' ? 'w:t' : 'w:delText'),
        ...(span.children.length ? { nested: span.children.length } : {}),
        ...(at ? { at } : {}),
        part,
      });
      if (block?.name === 'w:p') {
        const paragraph = model.paragraphs[block.logicalIndex - 1];
        paragraph.revisions = [...(paragraph.revisions || []), revisions.length];
      } else if (location.cell) {
        const cell = model.tables[block.logicalIndex - 1]?.rows[location.row - 1]?.cells[location.cell - 1];
        if (cell) cell.revisions = [...(cell.revisions || []), revisions.length];
      }
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
        text: blockText(match[2], 'w:t'),
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
        text: blockText(match[1], 'w:t'),
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
    propertyChangeCount,
    // Who changed what, at a glance: the redline reviewer reads this before
    // the revision list.
    revisionAuthors: [...revisions.reduce((authors, revision) => {
      const entry = authors.get(revision.author) || { author: revision.author, insertions: 0, deletions: 0 };
      if (['insertion', 'moved_to'].includes(revision.type)) entry.insertions += 1;
      else entry.deletions += 1;
      return authors.set(revision.author, entry);
    }, new Map()).values()],
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


// Legacy cell notes (the comments part a worksheet relates to), in the shape
// Excel reports them: { path, cell, text, author }.
async function worksheetNotes(zip, sheet) {
  const rels = await zipText(zip, partRelationshipPath(sheet.path));
  const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/.exec(rels || '')?.[1];
  if (!target) return [];
  const part = target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(sheet.path), target));
  const xml = await zipText(zip, part);
  if (!xml) return [];
  const authors = [...xml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((match) => xmlDecode(match[1]));
  const notes = [];
  for (const match of xml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
    const cell = (/\bref="([^"]+)"/.exec(match[1])?.[1] || '').toUpperCase();
    if (!cell) continue;
    const authorId = Number(/\bauthorId="(\d+)"/.exec(match[1])?.[1] ?? -1);
    notes.push({
      path: `/sheet[${sheet.name}]/cell[${cell}]/note`,
      cell,
      text: paragraphTexts(match[2], 't').join(''),
      author: authors[authorId] || '',
    });
  }
  return notes;
}

// Excel tables (ListObjects) a worksheet relates to, in the shape Excel
// reports them: { path, index, name, range, style }.
async function worksheetTables(zip, sheet) {
  const rels = await zipText(zip, partRelationshipPath(sheet.path));
  const tables = [];
  for (const match of (rels || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = match[1];
    if (!/\bType="[^"]*\/table"/.test(attributes)) continue;
    const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1] || '';
    if (!target) continue;
    const part = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(posix.dirname(sheet.path), target));
    const xml = await zipText(zip, part);
    const open = /<table\b([^>]*)>/.exec(xml || '')?.[1] || '';
    const range = (/\bref="([^"]+)"/.exec(open)?.[1] || '').toUpperCase();
    if (!range) continue;
    tables.push({
      path: `/sheet[${sheet.name}]/table[${tables.length + 1}]`,
      index: tables.length + 1,
      name: xmlDecode(/\bdisplayName="([^"]*)"/.exec(open)?.[1] || /\bname="([^"]*)"/.exec(open)?.[1] || ''),
      range,
      style: xmlDecode(/<tableStyleInfo\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
    });
  }
  return tables;
}

export async function snapshotXlsx(zip, options = {}) {
  const sheets = await workbookSheets(zip);
  const strings = await sharedStrings(zip);
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
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
    const cellResult = cellRecords(xml, strings, paged ? { ...options, styles } : { styles });
    const cells = paged ? cellResult.records : cellResult;
    const notes = await worksheetNotes(zip, sheet);
    const tables = await worksheetTables(zip, sheet);
    // The same shape Excel reports: which rows and columns stay put.
    const pane = /<pane\b([^>]*)\/?>/.exec(xml)?.[1] || '';
    const freezePanes = {
      frozen: /\bstate="frozen(?:Split)?"/.test(pane),
      splitRow: Number(/\bySplit="(\d+)"/.exec(pane)?.[1] || 0),
      splitColumn: Number(/\bxSplit="(\d+)"/.exec(pane)?.[1] || 0),
    };
    if (notes.length) {
      const byRef = new Map(notes.map((note) => [note.cell, note.text]));
      for (const cell of cells) {
        const text = byRef.get(cell.ref);
        if (text) cell.note = text;
      }
    }
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
      noteCount: notes.length,
      notes,
      tableCount: tables.length,
      tables,
      mergedRanges: mergedRanges(xml),
      freezePanes,
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
    // The workbook default (cellXfs 0): what every unstyled cell renders with.
    defaultStyle: styles[0] || null,
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


const SLIDE_BACKGROUND = /<p:bg\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/;


async function pptxRelatedPart(zip, part, suffix) {
  const relationshipPath = partRelationshipPath(part);
  const relationships = await zipText(zip, relationshipPath);
  if (!relationships) return '';
  for (const match of relationships.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    if (/\bTargetMode="External"/i.test(match[0])) continue;
    if (!(/\bType="([^"]*)"/.exec(match[0])?.[1] || '').endsWith(suffix)) continue;
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1] || '';
    if (target) return relationshipTarget(relationshipPath, target);
  }
  return '';
}


// Microsoft Office reports a resolved background per slide, and the theme review
// abandons the whole deck as soon as one slide has none. Reading only the slide
// part would leave every template deck unreviewed, so inheritance is resolved
// through the layout and master exactly as PowerPoint does.
async function pptxSlideBackground(zip, slidePath, slideXml) {
  const own = SLIDE_BACKGROUND.exec(slideXml)?.[1];
  if (own) return { color: own.toUpperCase(), followMaster: false, source: 'slide' };
  const layoutPath = await pptxRelatedPart(zip, slidePath, '/slideLayout');
  if (layoutPath) {
    const layoutXml = await zipText(zip, layoutPath);
    const inherited = SLIDE_BACKGROUND.exec(layoutXml)?.[1];
    if (inherited) return { color: inherited.toUpperCase(), followMaster: true, source: 'layout' };
    const masterPath = await pptxRelatedPart(zip, layoutPath, '/slideMaster');
    if (masterPath) {
      const fromMaster = SLIDE_BACKGROUND.exec(await zipText(zip, masterPath))?.[1];
      if (fromMaster) return { color: fromMaster.toUpperCase(), followMaster: true, source: 'master' };
    }
  }
  return { color: '', followMaster: true, source: 'master' };
}


async function pptxSlideNotes(zip, slidePath) {
  const notesPath = await pptxRelatedPart(zip, slidePath, '/notesSlide');
  if (!notesPath) return '';
  const xml = await zipText(zip, notesPath);
  const tree = containerInner(xml, 'p:spTree');
  if (!tree) return '';
  for (const shape of topLevelElements(tree.inner, ['p:sp'])) {
    if (/<p:ph\b[^>]*\btype="body"/i.test(shape.xml)) {
      return blockText(shape.xml, 'a:t');
    }
  }
  return blockText(xml, 'a:t');
}


async function snapshotPptx(zip, options = {}) {
  const roster = await presentationSlides(zip);
  const slidePaths = roster.map((slide) => slide.path);
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 20) : slidePaths.length;
  const requested = paged && Array.isArray(options.pages) && options.pages.length
    ? options.pages.map((page) => slidePaths[Number(page) - 1]).filter(Boolean)
    : paged
      ? slidePaths.slice(offset, offset + limit)
      : slidePaths;
  const slides = [];
  for (const path of requested) {
    const xml = await zipText(zip, path);
    const index = slidePaths.indexOf(path) + 1;
    const tree = containerInner(xml, 'p:spTree');
    const shapeBlocks = tree ? topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']) : [];
    slides.push({
      path: `/slide[${index}]`,
      index,
      slideId: roster[index - 1].id,
      background: await pptxSlideBackground(zip, path, xml),
      notes: await pptxSlideNotes(zip, path),
      text: paragraphTexts(xml, 'a:t'),
      shapes: shapeBlocks.map((shape, shapeIndex) => {
        const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i.exec(shape.xml);
        const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(shape.xml);
        // Design review reads evidence from the same fields Microsoft Office
        // reports. Publishing only the raw element name left every chart, table,
        // group, picture, and type-scale rule blind on portable decks.
        const shapePath = `/slide[${index}]/shape[${shapeIndex + 1}]`;
        const fontSizes = [...shape.xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/gi)]
          .map((match) => Number(match[1]) / 100)
          .filter((size) => size > 0);
        // Weight is a type-scale step of its own: a specimen ladder sets one size in light / regular / bold.
        const bold = /<a:rPr\b[^>]*\bb="1"/i.test(shape.xml);
        const tableRows = [...shape.xml.matchAll(/<a:tr\b/gi)].length;
        const tableColumns = [...shape.xml.matchAll(/<a:gridCol\b/gi)].length;
        // Typeface and color inventories feed the deck discipline review; a
        // shape that mixes families or invents colors is otherwise invisible.
        const fonts = [...new Set([...shape.xml.matchAll(/<a:latin\b[^>]*\btypeface="([^"]+)"/gi)]
          .map((match) => xmlDecode(match[1]))
          .filter(Boolean))];
        const colors = [...new Set([...shape.xml.matchAll(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/gi)]
          .map((match) => match[1].toUpperCase()))];
        const shapeName = xmlDecode(/<p:cNvPr\b[^>]*\bname="([^"]*)"/i.exec(shape.xml)?.[1] || '');
        // Preset geometry tells the diversity review which native structure a
        // slide carries (chevron process, block-arc share, trapezoid tiers).
        const geometry = shape.name === 'p:sp'
          ? (/<a:custGeom\b/i.test(shape.xml) ? 'custGeom' : /<a:prstGeom\b[^>]*\bprst="([^"]+)"/i.exec(shape.xml)?.[1] || '')
          : '';
        // The shape's own surface color (spPr solidFill, or a gradient's first stop — the side the kit
        // puts type on), distinct from text colors.
        const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/i.exec(shape.xml)?.[1] || '';
        const fill = /<a:gradFill\b[\s\S]*?<a:gs\b[^>]*>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(spPr)?.[1]?.toUpperCase()
          || /<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(spPr)?.[1]?.toUpperCase() || '';
        return {
          path: shapePath,
          index: shapeIndex + 1,
          ...shapeIdentity(shape.xml),
          type: shape.name,
          ...(shapeName ? { name: shapeName } : {}),
          ...(geometry ? { geometry } : {}),
          ...(fill ? { fill: { color: fill } } : {}),
          // A table's cells are separate strings a reader never runs together
          // ("4:3" beside "8.8초" is not "4:38.8초"), so they join on a space;
          // a text body keeps its runs together and its breaks — a soft break
          // (a:br, which the kit writes between Hangul words) and a paragraph
          // end — as newlines, so "4주차" + "잔존율" never reads "4주차잔존율".
          text: tableRows ? paragraphTexts(shape.xml, 'a:t').join(' ') : blockText(shape.xml, 'a:t'),
          ...(shape.name === 'p:grpSp' ? { group: true } : {}),
          ...(/<p:ph\b/i.test(shape.xml) ? { placeholder: true } : {}),
          ...(/<c:chart\b/i.test(shape.xml) ? { chart: { path: `${shapePath}/chart` } } : {}),
          ...(tableRows ? { table: { rows: tableRows, columns: tableColumns } } : {}),
          ...(fontSizes.length ? { font: { size: Math.max(...fontSizes), ...(bold ? { bold: true } : {}), ...(fonts.length ? { name: fonts[0] } : {}) }, sizes: [...new Set(fontSizes)].sort((a, b) => a - b) } : {}),
          ...(fonts.length ? { fonts } : {}),
          ...(colors.length ? { colors } : {}),
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
