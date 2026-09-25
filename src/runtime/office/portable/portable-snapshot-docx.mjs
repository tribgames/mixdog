// Word document snapshot: body model, styles, comments, pictures.
import { zipText } from './portable-opc.mjs';
import {
  TRAILING_SECTION_PATTERN,
  blockText,
  containerInner,
  settingsTrackChanges,
  tagPattern,
  textNodes,
  topLevelElements,
  xmlAttribute,
  xmlDecode,
} from './portable-xml.mjs';
import { countDocxPropertyChanges, docxRevisionTree, flattenDocxRevisions } from './docx-revisions.mjs';
import { docxRunFont, nextPageOffset, softBreakFacts, statedRunFont } from './portable-snapshot-shared.mjs';

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
  // Word can hide a run: the words stay in the file and the page does not show
  // them. Reported like ordinary body text they are edited and quoted as what
  // the document says, so the hidden part is named beside the paragraph.
  const hiddenText = /<w:vanish\b/.test(paragraphXml)
    ? [...paragraphXml.matchAll(/<w:r\b(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)]
        .filter(([run]) =>
          /<w:vanish\b(?![^>]*\bw:val="(?:false|0)")/.test(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(run)?.[0] || '')
        )
        .map(([run]) => blockText(run, 'w:t'))
        .join('')
    : '';
  return {
    ...(Number.isFinite(numId) && numId > 0
      ? { list: { numId, level: Number(/<w:ilvl\b[^>]*\bw:val="(\d+)"/.exec(numbering)?.[1]) || 0 } }
      : {}),
    ...(tracked ? { tracked: true } : {}),
    ...(deletedText ? { deletedText } : {}),
    ...(hiddenText ? { hiddenText } : {}),
  };
}

/** Tracked changes touching a table cell, reported the way a paragraph's
 *  are so a reviewer reads table edits alike. */
function cellMarkup(cellXml) {
  if (!/<w:(?:ins|del|moveFrom|moveTo)\b/.test(cellXml)) return {};
  const deletedText = blockText(cellXml, 'w:delText');
  return { tracked: true, ...(deletedText ? { deletedText } : {}) };
}

function resolveDocxStyleFonts(stylesXml) {
  const fonts = new Map();
  if (!stylesXml) return fonts;
  const base = docxRunFont(/<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/.exec(stylesXml)?.[0] || '');
  const declared = new Map();
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = xmlDecode(/\bw:styleId="([^"]+)"/.exec(match[1])?.[1] || '');
    if (!id) continue;
    declared.set(id, {
      basedOn: xmlDecode(/<w:basedOn\b[^>]*\bw:val="([^"]+)"/.exec(match[2])?.[1] || ''),
      ...docxRunFont(match[2]),
    });
  }
  const resolve = (id, seen) => {
    const entry = declared.get(id);
    if (!entry || seen.has(id)) return base;
    seen.add(id);
    const parent = entry.basedOn ? resolve(entry.basedOn, seen) : base;
    return {
      size: entry.size || parent.size,
      bold: entry.bold || parent.bold,
      name: entry.name || parent.name,
    };
  };
  for (const id of declared.keys()) fonts.set(id, resolve(id, new Set()));
  fonts.set('', base);
  return fonts;
}

function paragraphRecord(block, paragraphIndex) {
  const runs = textNodes(block.xml, 'w:t').map((node, index) => ({
    path: `/body/p[${paragraphIndex}]/run[${index + 1}]`,
    index: index + 1,
    text: node.text,
  }));
  return {
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
    // What the paragraph's own runs state; snapshotDocx fills in what its
    // style says when they state nothing.
    ...statedRunFont(block.xml),
    // A soft break reads back as a newline like a typed one does, but Word
    // draws it as a line break instead of a space. Counting them lets a
    // review tell a deliberate break from a newline left inside a run.
    ...softBreakFacts(block.xml),
    runs,
    ...paragraphMarkup(block.xml),
  };
}

function tableRecord(block, tableIndex) {
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
  return {
    path: `/body/tbl[${tableIndex}]`,
    index: tableIndex,
    // Word falls back to TableNormal when a table declares no style, which is
    // what the Office reader reports; without this the two backends disagreed
    // on the style of the very same table.
    style: xmlDecode(/<w:tblStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || 'TableNormal'),
    rows,
  };
}

export function docxBodyModel(documentXml) {
  const body = containerInner(documentXml, 'w:body');
  if (!body) return { paragraphs: [], tables: [], blocks: [] };
  const blocks = topLevelElements(body.inner, ['w:p', 'w:tbl']);
  const paragraphs = [];
  const tables = [];
  for (const block of blocks) {
    if (block.name === 'w:p') {
      paragraphs.push(paragraphRecord(block, paragraphs.length + 1));
      block.logicalIndex = paragraphs.length;
    } else {
      tables.push(tableRecord(block, tables.length + 1));
      block.logicalIndex = tables.length;
    }
  }
  return { paragraphs, tables, blocks, body };
}

export function appendDocxBlock(documentXml, block) {
  const body = containerInner(documentXml, 'w:body');
  if (!body) throw new Error('DOCX document body is missing');
  // Appending reads the body's tail, never its whole model: parsing every
  // existing paragraph for each appended one turns a long document into
  // quadratic work. A fresh file's single empty paragraph is the one case that
  // needs the blocks, and there is exactly one of them to inspect.
  const trailing = TRAILING_SECTION_PATTERN.exec(body.inner);
  const content = trailing ? body.inner.slice(0, trailing.index) : body.inner;
  const onlyEmptyParagraph =
    content.length < 2000 &&
    (content.match(/<w:p\b/g) || []).length === 1 &&
    !/<w:tbl\b/.test(content) &&
    !/<w:t[ >]/.test(content) &&
    !/<w:drawing\b/.test(content);
  if (onlyEmptyParagraph) {
    const inner = `${block}${body.inner.slice(content.length)}`;
    return `${documentXml.slice(0, body.start)}${inner}${documentXml.slice(body.end)}`;
  }
  // Only the document's own trailing sectPr, never the one a section break
  // paragraph carries: content appends before the former and after the latter.
  const inner = `${content}${block}${body.inner.slice(content.length)}`;
  return `${documentXml.slice(0, body.start)}${inner}${documentXml.slice(body.end)}`;
}

// The thread facts a comment carries: whether it is resolved, and the comment
// it replies to (by the id the snapshot reports, not Word's internal paraId).
function commentThread(threads, paraIds, idByParaId) {
  const entry = paraIds.map((paraId) => threads.get(paraId)).find(Boolean);
  if (!entry) return {};
  const replyTo = entry.parentParaId ? idByParaId.get(entry.parentParaId.toUpperCase()) || '' : '';
  return {
    ...(entry.resolved ? { resolved: true } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

/** The pictures a Word story carries, as a Word session reports them: the name,
 *  the description a reader who cannot see it is given, and the placed size in
 *  points. One reading serves the snapshot and the accessibility audit. */
function docxPictures(xml) {
  const pictures = [];
  for (const match of String(xml || '').matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
    if (!/<pic:pic[\s>]/.test(match[0])) continue;
    const properties = /<wp:docPr\b[^>]*>/.exec(match[0])?.[0] || '';
    const extent = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(match[0]);
    pictures.push({
      name: xmlDecode(/\bname="([^"]*)"/.exec(properties)?.[1] || ''),
      altText: xmlDecode(/\bdescr="([^"]*)"/.exec(properties)?.[1] || ''),
      width: extent ? Math.round(Number(extent[1]) / 127) / 100 : 0,
      height: extent ? Math.round(Number(extent[2]) / 127) / 100 : 0,
    });
  }
  return pictures;
}

// A localized Word writes its built-in styles under ids of its own — Korean Word saves "heading 2" as w:styleId="2"
// and "Title" as "a3" — so the id alone named no heading, and the audit read a titled, sectioned newsletter as a
// document without one (heading_hierarchy_missing). The style's name travels beside its id when the two differ.
function applyDocxStyleNames(model, stylesXml) {
  if (!stylesXml) return;
  const names = new Map();
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = xmlDecode(/\bw:styleId="([^"]+)"/.exec(match[1])?.[1] || '');
    const name = xmlDecode(/<w:name\b[^>]*\bw:val="([^"]+)"/.exec(match[2])?.[1] || '');
    if (id && name && name.replace(/\s+/g, '').toLowerCase() !== id.toLowerCase()) names.set(id, name);
  }
  for (const paragraph of model.paragraphs) {
    const name = names.get(paragraph.style);
    if (name) paragraph.styleName = name;
  }
}

// What a paragraph's style says about its font, filled in where the
// paragraph's own runs state nothing.
function applyDocxStyleFonts(model, styleFonts) {
  if (!styleFonts.size) return;
  for (const paragraph of model.paragraphs) {
    const inherited = styleFonts.get(paragraph.style) || styleFonts.get('');
    const size = paragraph.font?.size || inherited?.size || 0;
    const bold = paragraph.font?.bold || inherited?.bold || false;
    const name = paragraph.font?.name || inherited?.name || '';
    if (!size && !bold && !name) continue;
    paragraph.font = { ...(size ? { size } : {}), ...(bold ? { bold: true } : {}), ...(name ? { name } : {}) };
  }
}

// A paragraph's numId names a definition in numbering.xml; the level's
// number format tells a bullet from a numbered list.
function applyDocxListKinds(model, numbering) {
  if (!numbering || !model.paragraphs.some((paragraph) => paragraph.list)) return;
  const abstractOf = new Map(
    [...numbering.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId\b[^>]*\bw:val="(\d+)"/g)].map(
      (match) => [Number(match[1]), Number(match[2])]
    )
  );
  const formats = new Map();
  for (const abstract of numbering.matchAll(
    /<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g
  )) {
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

// The body blocks a read returns: the whole body, one page of it, or the
// single paragraph or table a target path names.
function selectDocxBlocks(model, options) {
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 200) : model.blocks.length;
  const page = { paged, offset, limit, blocks: model.blocks };
  if (!paged) return page;
  const target = options.target ? String(options.target) : '';
  const paragraph = /^\/body\/p\[(\d+)]/.exec(target);
  const table = /^\/body\/tbl\[(\d+)]/.exec(target);
  if (paragraph) {
    page.blocks = model.blocks.filter((block) => block.name === 'w:p' && block.logicalIndex === Number(paragraph[1]));
  } else if (table) {
    page.blocks = model.blocks.filter((block) => block.name === 'w:tbl' && block.logicalIndex === Number(table[1]));
  } else {
    page.blocks = model.blocks.slice(offset, offset + limit);
  }
  return page;
}

const COMMENT_PATTERN = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;

// Word keeps a thread's state beside the comments: whether it was marked
// resolved, and which comment a reply answers. A reader that ignores this
// reports a settled thread as outstanding and a reply as its own comment.
function docxCommentThreadRecords(commentsExtendedXml) {
  const records = [];
  const threads = new Map();
  for (const match of commentsExtendedXml.matchAll(/<w15:commentEx\b([^>]*?)\/?>/g)) {
    const record = {
      paraId: xmlDecode(xmlAttribute(match[1], 'w15:paraId') || ''),
      parentParaId: xmlDecode(xmlAttribute(match[1], 'w15:paraIdParent') || ''),
      resolved: /^(?:1|true)$/i.test(xmlAttribute(match[1], 'w15:done') || ''),
    };
    records.push(record);
    if (record.paraId) threads.set(record.paraId.toUpperCase(), record);
  }
  return { records, threads };
}

// The paragraph ids each comment carries, both ways round: a thread record
// names paragraphs, and a reply names its parent's paragraph.
function docxCommentParaIds(commentsXml) {
  const paraIdsById = new Map();
  for (const match of commentsXml.matchAll(COMMENT_PATTERN)) {
    const id = xmlDecode(/\bw:id="([^"]+)"/.exec(match[1])?.[1] || '');
    const paragraphs = [...match[2].matchAll(/<w:p\b([^>]*)/g)]
      .map((entry) => (xmlAttribute(entry[1], 'w14:paraId') || '').toUpperCase())
      .filter(Boolean);
    if (id && paragraphs.length) paraIdsById.set(id, paragraphs);
  }
  const idByParaId = new Map();
  for (const [id, paragraphs] of paraIdsById) for (const paraId of paragraphs) idByParaId.set(paraId, id);
  return { paraIdsById, idByParaId };
}

// The words a comment is anchored to, from the first story part that
// carries both ends of its range.
function docxCommentAnchor(storyXml, id) {
  const escapedId = tagPattern(id);
  for (const [part, xml] of storyXml) {
    const start = new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
    const end = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
    if (!start || !end || end.index < start.index) continue;
    return { anchoredText: blockText(xml.slice(start.index + start[0].length, end.index), 'w:t'), part };
  }
  return { anchoredText: '', part: '' };
}

// A reply inherits the state of the thread it belongs to: Word shows the
// whole thread as resolved when its first comment is marked done.
function inheritThreadResolution(comments) {
  const threadRoot = new Map(comments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    if (!comment.replyTo) continue;
    let root = threadRoot.get(comment.replyTo);
    for (let depth = 0; root?.replyTo && depth < 20; depth += 1) root = threadRoot.get(root.replyTo);
    if (root?.resolved) comment.resolved = true;
  }
}

function docxComments(storyXml, commentsXml, commentsExtendedXml) {
  const { records, threads } = docxCommentThreadRecords(commentsExtendedXml);
  const { paraIdsById, idByParaId } = docxCommentParaIds(commentsXml);
  const comments = [];
  for (const match of commentsXml.matchAll(COMMENT_PATTERN)) {
    const attributes = match[1];
    const id = xmlDecode(/\bw:id="([^"]+)"/.exec(attributes)?.[1] || '');
    comments.push({
      path: `/body/comment[${comments.length + 1}]`,
      index: comments.length + 1,
      id,
      author: xmlDecode(/\bw:author="([^"]*)"/.exec(attributes)?.[1] || ''),
      initials: xmlDecode(/\bw:initials="([^"]*)"/.exec(attributes)?.[1] || ''),
      date: xmlDecode(/\bw:date="([^"]*)"/.exec(attributes)?.[1] || ''),
      text: blockText(match[2], 'w:t'),
      ...docxCommentAnchor(storyXml, id),
      ...commentThread(threads, paraIdsById.get(id) || [], idByParaId),
    });
  }
  inheritThreadResolution(comments);
  return { comments, threadRecords: records };
}

// The body block a document.xml offset falls in: a revision names the
// paragraph or table it sits in, and a paragraph lists its revisions.
function docxBlockAt(model, offset) {
  if (!model.body) return null;
  const relative = offset - model.body.start;
  return model.blocks.find((block) => block.start <= relative && relative < block.end) || null;
}

// Inside a table, the row and cell an offset (relative to the table block)
// falls in — the outer table's when tables nest — so the revision names
// the cell.
function docxCellAt(block, offset) {
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
}

// Wrappers in document order of their opening tags, parents before
// children — the ordinal resolve_revision addresses. A paragraph-mark
// marker (<w:del/> inside w:rPr) and a formatting record (w:rPrChange)
// are not wrappers and are not listed.
function docxRevisions(model, storyXml) {
  const revisions = [];
  let propertyChangeCount = 0;
  for (const [part, xml] of storyXml) {
    propertyChangeCount += countDocxPropertyChanges(xml);
    const inBody = /^word\/document\.xml$/i.test(part);
    for (const span of flattenDocxRevisions(docxRevisionTree(xml))) {
      const block = inBody ? docxBlockAt(model, span.start) : null;
      const location =
        block?.name === 'w:tbl' ? docxCellAt(block, span.start - model.body.start - block.start) : { suffix: '' };
      let at = '';
      if (block?.name === 'w:p') at = `/body/p[${block.logicalIndex}]`;
      else if (block) at = `/body/tbl[${block.logicalIndex}]${location.suffix}`;
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
  return { revisions, propertyChangeCount };
}

// Who changed what, at a glance: the redline reviewer reads this before
// the revision list.
function docxRevisionAuthors(revisions) {
  const authors = new Map();
  for (const revision of revisions) {
    const entry = authors.get(revision.author) || { author: revision.author, insertions: 0, deletions: 0 };
    if (['insertion', 'moved_to'].includes(revision.type)) entry.insertions += 1;
    else entry.deletions += 1;
    authors.set(revision.author, entry);
  }
  return [...authors.values()];
}

async function docxNotes(zip) {
  const notes = [];
  for (const [kind, part, tag] of [
    ['footnote', 'word/footnotes.xml', 'w:footnote'],
    ['endnote', 'word/endnotes.xml', 'w:endnote'],
  ]) {
    const xml = await zipText(zip, part);
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let ordinal = 0;
    for (const match of xml.matchAll(pattern)) {
      const id = xmlDecode(/\bw:id="([^"]+)"/.exec(match[1])?.[1] || '');
      // The separator and continuation-separator entries are the rule Word
      // draws above the note area, not notes: counting them would report a
      // source the document does not carry.
      if (Number(id) < 1 || /\bw:type="/.test(match[1])) continue;
      ordinal += 1;
      notes.push({
        path: `/body/${kind}[${ordinal}]`,
        kind,
        id,
        text: blockText(match[2], 'w:t'),
        part,
      });
    }
  }
  return notes;
}

function docxContentControls(storyXml) {
  const contentControls = [];
  for (const [part, xml] of storyXml) {
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
  return contentControls;
}

function docxImages(storyXml) {
  const images = [];
  for (const [part, xml] of storyXml) {
    for (const picture of docxPictures(xml)) {
      images.push({ path: `/body/image[${images.length + 1}]`, index: images.length + 1, ...picture, part });
    }
  }
  return images;
}

// Every story part is decompressed once; the comment anchors, revisions,
// content controls and pictures all read from the same text.
async function docxStoryParts(zip) {
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort();
  const partXml = new Map();
  for (const part of parts) partXml.set(part, await zipText(zip, part));
  const content = parts.map((part) => ({ part, text: blockText(partXml.get(part), 'w:t') }));
  const storyXml = new Map([...partXml].filter(([part]) => !/\/comments\.xml$/i.test(part)));
  return { partXml, content, storyXml };
}

function blockOrderEntries(blocks) {
  return blocks.map((block) => ({
    type: block.name === 'w:p' ? 'paragraph' : 'table',
    index: block.logicalIndex,
    path: block.name === 'w:p' ? `/body/p[${block.logicalIndex}]` : `/body/tbl[${block.logicalIndex}]`,
    start: block.start,
  }));
}

// The body a page returns: every paragraph and table when unpaged, otherwise
// the blocks the page selected, with the story parts summarised once the
// body outgrows the page.
function pagedDocxBody(model, page, content) {
  if (!page.paged) return { paragraphs: model.paragraphs, tables: model.tables, parts: content };
  const paragraphIndexes = new Set(
    page.blocks.filter((block) => block.name === 'w:p').map((block) => block.logicalIndex)
  );
  const tableIndexes = new Set(
    page.blocks.filter((block) => block.name === 'w:tbl').map((block) => block.logicalIndex)
  );
  return {
    paragraphs: model.paragraphs.filter((paragraph) => paragraphIndexes.has(paragraph.index)),
    tables: model.tables.filter((table) => tableIndexes.has(table.index)),
    parts:
      model.blocks.length > page.limit
        ? content.map((part) => ({ part: part.part, chars: part.text.length }))
        : content,
  };
}

function docxPagination(page, model) {
  if (!page.paged) return {};
  return {
    pagination: {
      unit: 'body-block',
      offset: page.offset,
      limit: page.limit,
      returned: page.blocks.length,
      total: model.blocks.length,
      nextOffset: nextPageOffset(page.offset, page.blocks.length, model.blocks.length),
    },
  };
}

async function docxAnnotations(zip, model, storyXml) {
  const { comments, threadRecords } = docxComments(
    storyXml,
    await zipText(zip, 'word/comments.xml'),
    await zipText(zip, 'word/commentsExtended.xml')
  );
  const { revisions, propertyChangeCount } = docxRevisions(model, storyXml);
  const notes = await docxNotes(zip);
  const footnotes = notes.filter((entry) => entry.kind === 'footnote');
  const endnotes = notes.filter((entry) => entry.kind === 'endnote');
  const contentControls = docxContentControls(storyXml);
  const images = docxImages(storyXml);
  const commentThreads = threadRecords.map((record, index) => ({
    path: `/body/comment-thread[${index + 1}]`,
    index: index + 1,
    ...record,
  }));
  return {
    commentCount: comments.length,
    revisionCount: revisions.length,
    propertyChangeCount,
    revisionAuthors: docxRevisionAuthors(revisions),
    comments,
    revisions,
    footnoteCount: footnotes.length,
    endnoteCount: endnotes.length,
    footnotes,
    endnotes,
    contentControlCount: contentControls.length,
    contentControls,
    imageCount: images.length,
    images,
    commentThreadCount: commentThreads.length,
    commentThreads,
  };
}

export async function snapshotDocx(zip, options = {}) {
  const { partXml, content, storyXml } = await docxStoryParts(zip);
  const model = docxBodyModel(partXml.get('word/document.xml') ?? '');
  const stylesXml = await zipText(zip, 'word/styles.xml');
  applyDocxStyleFonts(model, resolveDocxStyleFonts(stylesXml));
  applyDocxStyleNames(model, stylesXml);
  applyDocxListKinds(model, await zipText(zip, 'word/numbering.xml'));
  const page = selectDocxBlocks(model, options);
  const body = pagedDocxBody(model, page, content);
  const annotations = await docxAnnotations(zip, model, storyXml);
  return {
    format: 'docx',
    path: '/',
    // Whether this document records new edits as revisions. A reviewer's file
    // often arrives with it already on, and the same edit means something
    // different in each state, so the reader reports it instead of leaving the
    // caller to discover it from the revisions its own batch produced.
    trackChanges: settingsTrackChanges((await zipText(zip, 'word/settings.xml')) || ''),
    paragraphCount: model.paragraphs.length,
    tableCount: model.tables.length,
    paragraphs: body.paragraphs,
    tables: body.tables,
    blockOrder: blockOrderEntries(page.blocks),
    parts: body.parts,
    ...annotations,
    ...docxPagination(page, model),
  };
}
