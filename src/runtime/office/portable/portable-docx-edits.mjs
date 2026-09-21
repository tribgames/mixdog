// Body, table, comment and story edits the portable DOCX backend applies to a
// document. Every edit takes (zip, op, context) where context carries the
// story part list and the current track-changes state, and returns the
// operation result; the dispatcher in portable-docx.mjs owns the loop.
import {
  PIXELS_TO_POINTS,
  addPackageRelationship,
  fillTemplateParts,
  partRelationshipPath,
  provenanceCitation,
  zipText,
} from './portable-opc.mjs';
import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import {
  OFFICE_RELATIONSHIP_BASE,
  XML_HEADER,
  paragraphTexts,
  rebuildTextNodes,
  replaceAcrossRuns,
  textNodes,
  upsertOrderedChild,
  xmlEncode,
} from './portable-xml.mjs';
import {
  SETTINGS_CONTENT_TYPE,
  SETTINGS_ORDER,
  WORD_2010_NS,
  WORD_MAIN_NS,
  addDocumentImage,
  anchorDocxComment,
  commentParagraphId,
  ensureCommentsPart,
  ensureDocxUpdateFields,
  ensureNumbering,
  ensurePart,
  forgetCommentIdentity,
  markRunsDeleted,
  nextRevisionId,
  registerCommentIdentity,
  registerCommentThread,
  revisionAttributes,
  documentSectionSpans,
  trailingSectionProperties,
  upsertSectionChild,
  upsertSectionReference,
  wordDrawingXml,
  writeHeaderFooterPart,
  writeSectionPropertiesAt,
} from './portable-docx-parts.mjs';
import {
  alignWordTableColumns,
  blankTableCells,
  docxStyleId,
  docxTable,
  insertDocxBlockAt,
  paragraphFormatXml,
  replaceDocxTable,
  replaceWordProperties,
  rewriteTableColumns,
  rowCellMatches,
  tableRowMatches,
  wordParagraph,
  wordRunProperties,
  wordTableXml,
  wordTableProperties,
} from './portable-docx-xml.mjs';
import { normalizeDocxRuns } from './docx-runs.mjs';
import { anchorPhraseInParagraph, trackedParagraphRewrite } from './docx-tracked-edits.mjs';
import { formatFirstBodyPhrase, patchParagraphFormat } from './docx-formatting.mjs';
import {
  docxHeadingLevels,
  docxTocCacheRuns,
  docxTocEntries,
  replaceTrackedParagraphs,
} from './portable-docx-operations.mjs';

const DOCUMENT_PART = 'word/document.xml';
const STORY_VARIANTS = ['default', 'first', 'even'];
const DOCX_STORY_PART = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i;

// The stories text can stand in, body first; the comments part carries no
// text of its own.
function docxStoryPartNames(zip) {
  return Object.keys(zip.files)
    .filter((name) => DOCX_STORY_PART.test(name))
    .sort(
      (left, right) => Number(right === DOCUMENT_PART) - Number(left === DOCUMENT_PART) || left.localeCompare(right)
    );
}

function bodyParagraphs(model) {
  return model.blocks.filter((block) => block.name === 'w:p');
}

// The 1-based body paragraph an operation names, or the usual error.
function bodyParagraphAt(model, ordinal) {
  const paragraph = bodyParagraphs(model)[Number(ordinal) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${ordinal} not found`);
  return paragraph;
}

function paragraphContaining(model, find) {
  return bodyParagraphs(model).find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(find));
}

// Splice one rewritten paragraph back into the document body.
function replaceBodyParagraph(current, model, paragraph, nextParagraph) {
  const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
  return `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
}

function preserveSpace(text) {
  return /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
}

function commentEntryXml(id, op, text, stamp) {
  return (
    `<w:comment w:id="${id}" w:author="${xmlEncode(op.author || 'Mixdog')}"` +
    ` w:date="${stamp}" w:initials="${xmlEncode(op.initials || 'MD')}">` +
    `<w:p xmlns:w14="${WORD_2010_NS}" w14:paraId="${commentParagraphId(id)}">` +
    `<w:r><w:t${preserveSpace(text)}>${xmlEncode(text)}</w:t></w:r></w:p></w:comment>`
  );
}

function nextCommentId(commentsXml) {
  const ids = [...commentsXml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(0, ...ids) + 1;
}

function commentStamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function commentEntryPattern(id) {
  return new RegExp(`<w:comment\\b[^>]*\\bw:id="${id}"[^>]*>[\\s\\S]*?<\\/w:comment>`);
}

// A new comment is one entry in the comments part plus the thread and the
// identity records that carry its author and timestamp.
async function appendComment(zip, comments, op, text, thread = {}) {
  const id = nextCommentId(comments.xml);
  const stamp = commentStamp();
  zip.file(
    comments.part,
    comments.xml.replace('</w:comments>', `${commentEntryXml(id, op, text, stamp)}</w:comments>`)
  );
  await registerCommentThread(zip, { commentId: id, ...thread });
  await registerCommentIdentity(zip, { commentId: id, date: stamp });
  return id;
}

// A caller that names the thing it wants — kind:'footer' — must get a footer.
// Reading that name as an unknown page variant wrote the text into a second
// header instead, and reported success for a document whose footer never
// existed. `named` is the story/variant word, `kind` the resolved page variant.
function storyTarget(op) {
  const named = String(op.kind || '').toLowerCase();
  if (named && !['header', 'footer', ...STORY_VARIANTS].includes(named)) {
    throw new Error(`${op.op} kind must be header, footer, ${STORY_VARIANTS.join(', ')}`);
  }
  const requested = String(op.variant || '').toLowerCase();
  if (requested && !STORY_VARIANTS.includes(requested)) {
    throw new Error(`${op.op} variant must be ${STORY_VARIANTS.join(', ')}`);
  }
  return { named, kind: requested || (STORY_VARIANTS.includes(named) ? named : 'default') };
}

// track_changes: the new state is returned so the dispatcher can carry it to
// the following operations.
export async function setDocxTrackChanges(zip, op) {
  const enabled = op.enabled !== false;
  const part = 'word/settings.xml';
  const settings = await ensurePart(zip, {
    part,
    xml: `${XML_HEADER}<w:settings xmlns:w="${WORD_MAIN_NS}"></w:settings>`,
    contentType: SETTINGS_CONTENT_TYPE,
    relationship: `${OFFICE_RELATIONSHIP_BASE}/settings`,
  });
  zip.file(
    part,
    upsertOrderedChild(settings, SETTINGS_ORDER, 'w:trackRevisions', enabled ? '<w:trackRevisions/>' : '')
  );
  return { result: { op: op.op, changed: true, enabled }, tracking: enabled };
}

// Under track changes each token becomes a tracked deletion plus the
// inserted value, so a filled template still passes the redlining audit.
export async function fillDocxTemplate(zip, op, { parts, tracking }) {
  const filled = await fillTemplateParts(
    zip,
    parts,
    'w:t',
    op,
    tracking
      ? { replace: (xml, _tag, find, replacement) => replaceTrackedParagraphs(xml, find, replacement, op.author) }
      : {}
  );
  return tracking ? { ...filled, tracked: true } : filled;
}

export async function replaceDocxText(zip, op, { parts, tracking }) {
  let count = 0;
  let paragraphRewrites = 0;
  for (const part of parts) {
    const current = await zipText(zip, part);
    const replaced = tracking
      ? replaceTrackedParagraphs(current, String(op.find || ''), String(op.replace ?? ''), op.author)
      : replaceAcrossRuns(current, 'w:t', String(op.find || ''), String(op.replace ?? ''));
    if (replaced.count) zip.file(part, replaced.xml);
    count += replaced.count;
    paragraphRewrites += replaced.paragraphRewrites || 0;
  }
  const tracked = {};
  if (tracking) {
    tracked.tracked = true;
    tracked.granularity = paragraphRewrites ? 'paragraph' : 'run';
    if (paragraphRewrites) {
      tracked.paragraphRewrites = paragraphRewrites;
      tracked.note = `${paragraphRewrites} paragraph(s) held the match across a tab, break, field, or drawing and were rewritten whole: their runs are marked deleted and one inserted run carries the new text.`;
    }
  }
  return { op: op.op, changed: count > 0, count, ...tracked };
}

export async function appendDocxText(zip, op, { tracking }) {
  const current = await zipText(zip, DOCUMENT_PART);
  const properties = op.properties || {};
  const listKind = String(properties.listKind || '').toLowerCase();
  let numbering = null;
  if (listKind) numbering = await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet');
  const style = docxStyleId(op.style || properties.style || (numbering ? 'List Paragraph' : ''));
  const format = paragraphFormatXml(
    properties,
    numbering ? { numId: numbering.numId, level: properties.listLevel } : null
  );
  const styleXml = style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : '';
  const paragraphProperties = style || format ? `<w:pPr>${styleXml}${format}</w:pPr>` : '';
  const runProperties = wordRunProperties(properties);
  const run =
    `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}` +
    `<w:t${preserveSpace(String(op.text || ''))}>${xmlEncode(op.text || '')}</w:t></w:r>`;
  const content = tracking
    ? // The reviewer's label comes where it does on every other tracked edit —
      // beside the operation — and the older nested spelling still works.
      `<w:ins ${revisionAttributes(nextRevisionId(current), op.author ?? properties.author)}>${run}</w:ins>`
    : run;
  const block = `<w:p>${paragraphProperties}${content}</w:p>`;
  zip.file(DOCUMENT_PART, appendDocxBlock(current, block));
  return { op: op.op, changed: true, style: style || '', ...(tracking ? { tracked: true } : {}) };
}

export async function addDocxTable(zip, op) {
  let current = await zipText(zip, DOCUMENT_PART);
  const table = wordTableXml(op);
  if (op.paragraph) {
    const model = docxBodyModel(current);
    const paragraph = bodyParagraphAt(model, op.paragraph);
    const position = paragraph.end;
    const nextInner = `${model.body.inner.slice(0, position)}${table}${model.body.inner.slice(position)}`;
    current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
  } else {
    current = appendDocxBlock(current, table);
  }
  zip.file(DOCUMENT_PART, current);
  return {
    op: op.op,
    changed: true,
    table: docxBodyModel(current).blocks.filter((block) => block.name === 'w:tbl').length,
  };
}

export async function setDocxParagraphStyle(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const model = docxBodyModel(current);
  const paragraph = bodyParagraphAt(model, op.paragraph);
  const style = xmlEncode(op.style || 'Normal');
  let nextParagraph = paragraph.xml;
  if (/<w:pPr(?:\s[^>]*)?>/.test(nextParagraph)) {
    if (/<w:pStyle\b[^>]*\/>/.test(nextParagraph)) {
      nextParagraph = nextParagraph.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${style}"/>`);
    } else {
      nextParagraph = nextParagraph.replace(/<w:pPr(?:\s[^>]*)?>/, (open) => `${open}<w:pStyle w:val="${style}"/>`);
    }
  } else {
    nextParagraph = nextParagraph.replace(
      /<w:p(?:\s[^>]*)?>/,
      (open) => `${open}<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    );
  }
  zip.file(DOCUMENT_PART, replaceBodyParagraph(current, model, paragraph, nextParagraph));
  return { op: op.op, changed: true, style: op.style || 'Normal' };
}

export async function setDocxTableCell(zip, op, { tracking }) {
  const current = await zipText(zip, DOCUMENT_PART);
  const table = docxTable(current, op.table);
  const rows = tableRowMatches(table[0]);
  const row = rows[Number(op.row) - 1];
  if (!row) throw new Error(`DOCX table row ${op.row} not found`);
  const cells = rowCellMatches(row[0]);
  const cell = cells[Number(op.col) - 1];
  if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
  let nextCell;
  if (tracking) {
    // The first paragraph takes the new text as a tracked rewrite; any
    // further paragraph in the cell is marked deleted.
    let id = nextRevisionId(current);
    let first = true;
    nextCell = cell[0].replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
      const runCount = (paragraph.match(/<w:r(?:\s[^>]*)?>/g) || []).length;
      if (first) {
        first = false;
        const rewritten = trackedParagraphRewrite(paragraph, String(op.text ?? ''), id, op.author);
        id += runCount + 1;
        return rewritten;
      }
      const deleted = markRunsDeleted(paragraph, id, op.author);
      id += runCount;
      return deleted;
    });
    if (first) {
      nextCell = cell[0].replace(
        '</w:tc>',
        `<w:p><w:ins ${revisionAttributes(id, op.author)}><w:r>` +
          `<w:t xml:space="preserve">${xmlEncode(op.text ?? '')}</w:t></w:r></w:ins></w:p></w:tc>`
      );
    }
  } else {
    const nodes = textNodes(cell[0], 'w:t');
    if (nodes.length) {
      nodes[0].text = String(op.text ?? '');
      for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
      nextCell = rebuildTextNodes(cell[0], 'w:t', nodes);
    } else {
      nextCell = cell[0].replace('</w:tc>', `<w:p><w:r><w:t>${xmlEncode(op.text ?? '')}</w:t></w:r></w:p></w:tc>`);
    }
  }
  const nextRow = row[0].replace(cell[0], nextCell);
  const nextTable = table[0].replace(row[0], nextRow);
  zip.file(
    DOCUMENT_PART,
    `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`
  );
  return { op: op.op, changed: true, ...(tracking ? { tracked: true } : {}) };
}

export async function setDocxTableStyle(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const table = docxTable(current, op.table);
  // Restyling a table must not undo its width: the declared width is part
  // of the layout, not of the style being replaced.
  const declaredWidth = /<w:tblW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa"/.exec(table[0])?.[1];
  const nextTable = alignWordTableColumns(
    replaceWordProperties(
      table[0],
      'tbl',
      'tblPr',
      wordTableProperties(op.properties, { totalWidth: Number(declaredWidth) || 0 })
    ),
    Array.isArray(op.properties?.columnAlignments) ? op.properties.columnAlignments : []
  );
  zip.file(DOCUMENT_PART, replaceDocxTable(current, table, nextTable));
  return { op: op.op, changed: nextTable !== table[0], table: Number(op.table) };
}

export async function setDocxParagraphFormat(zip, op) {
  const properties = op.properties || {};
  const listKind = String(properties.listKind || '').toLowerCase();
  let numbering = null;
  if (listKind) numbering = await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet');
  const current = await zipText(zip, DOCUMENT_PART);
  const model = docxBodyModel(current);
  const paragraph = bodyParagraphAt(model, op.paragraph);
  const nextParagraph = patchParagraphFormat(
    paragraph.xml,
    properties,
    numbering ? { numId: numbering.numId, level: properties.listLevel } : null
  );
  zip.file(DOCUMENT_PART, replaceBodyParagraph(current, model, paragraph, nextParagraph));
  return { op: op.op, changed: nextParagraph !== paragraph.xml, paragraph: Number(op.paragraph) };
}

export async function addDocxImage(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const media = await addDocumentImage(zip, op.path);
  const pixels = media.pixels;
  const naturalWidth = pixels ? pixels.width * PIXELS_TO_POINTS : 240;
  const width = Number(op.width) > 0 ? Number(op.width) : naturalWidth;
  // A requested width scales the natural height so the picture keeps its aspect ratio.
  const scale = pixels && Number(op.width) > 0 ? Number(op.width) / (pixels.width * PIXELS_TO_POINTS) : 1;
  const naturalHeight = pixels ? pixels.height * PIXELS_TO_POINTS * scale : 180;
  const height = Number(op.height) > 0 ? Number(op.height) : naturalHeight;
  const id =
    [...current.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].reduce((max, match) => Math.max(max, Number(match[1])), 0) +
    1;
  const block = `<w:p><w:r>${wordDrawingXml({
    id,
    embedId: media.relationshipId,
    name: media.name,
    width,
    height,
    altText: op.altText,
  })}</w:r></w:p>`;
  zip.file(DOCUMENT_PART, insertDocxBlockAt(current, block, op.paragraph));
  return {
    op: op.op,
    changed: true,
    image: media.part,
    width,
    height,
    ...(String(op.altText ?? '').trim() ? { altText: String(op.altText).trim() } : {}),
  };
}

// insert_table_row / delete_table_row / insert_table_column / delete_table_column
export async function editDocxTableRowsOrColumns(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const table = docxTable(current, op.table);
  let nextTable = table[0];
  if (op.op === 'insert_table_row' || op.op === 'delete_table_row') {
    const rows = tableRowMatches(table[0]);
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
      nextTable =
        position > rows.length
          ? table[0].replace(/<\/w:tbl>$/, `${blank}</w:tbl>`)
          : `${table[0].slice(0, template.index)}${blank}${table[0].slice(template.index)}`;
    }
  } else {
    const columnIndex = Math.max(1, Number(op.column) || 1);
    nextTable = rewriteTableColumns(table[0], columnIndex, op.op === 'delete_table_column' ? 'delete' : 'insert');
  }
  zip.file(DOCUMENT_PART, replaceDocxTable(current, table, nextTable));
  return { op: op.op, changed: nextTable !== table[0], table: Number(op.table) };
}

export async function setDocxList(zip, op) {
  const kind = String(op.kind || 'bullet').toLowerCase() === 'number' ? 'number' : 'bullet';
  const numbering = await ensureNumbering(zip, kind);
  const current = await zipText(zip, DOCUMENT_PART);
  const model = docxBodyModel(current);
  const paragraph = bodyParagraphAt(model, op.paragraph);
  const level = Math.max(0, Math.min(2, Number(op.level) || 0));
  const existing = /<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(paragraph.xml)?.[1] || '';
  const cleaned = existing
    .replace(/<w:numPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:numPr>)/, '')
    .replace(/<w:pStyle\b[^>]*\/>/, '');
  const properties =
    '<w:pStyle w:val="ListParagraph"/>' +
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numbering.numId}"/></w:numPr>` +
    cleaned;
  const nextParagraph = replaceWordProperties(paragraph.xml, 'p', 'pPr', properties);
  zip.file(DOCUMENT_PART, replaceBodyParagraph(current, model, paragraph, nextParagraph));
  return { op: op.op, changed: true, paragraph: Number(op.paragraph), kind, numId: numbering.numId };
}

export async function addDocxHyperlink(zip, op) {
  const address = String(op.address || '').trim();
  // Linking a phrase must not rewrite it: the reader asked for 정시 출고율
  // to become a link, not to be replaced by the raw address. Only a caller
  // naming display, or a link with no phrase to sit on, uses other text.
  const display = String(op.display || op.find || address || '').trim();
  if (!address && !op.subAddress) throw new Error('add_hyperlink requires address or subAddress');
  if (!display) throw new Error('add_hyperlink requires display text');
  let current = await zipText(zip, DOCUMENT_PART);
  const relationshipId = address
    ? await addPackageRelationship(
        zip,
        partRelationshipPath(DOCUMENT_PART),
        `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
        address,
        'External'
      )
    : '';
  const run =
    '<w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>' +
    `<w:t${preserveSpace(display)}>${xmlEncode(display)}</w:t></w:r>`;
  const link =
    `<w:hyperlink${relationshipId ? ` r:id="${relationshipId}"` : ''}` +
    `${op.subAddress ? ` w:anchor="${xmlEncode(op.subAddress)}"` : ''}>${run}</w:hyperlink>`;
  // A link asked for by phrase replaces that phrase, the way Word does it.
  // Appending it to the end of the document instead put the link somewhere
  // the caller never named and still reported success.
  const find = String(op.find || '');
  let anchor = 'appended';
  if (find) {
    const model = docxBodyModel(current);
    const paragraph = paragraphContaining(model, find);
    if (!paragraph) throw new Error(`DOCX text not found for hyperlink: ${find}`);
    const linked = anchorPhraseInParagraph(paragraph.xml, find, 0, { start: link, end: '', replace: true });
    if (!linked) throw new Error(`DOCX hyperlink phrase crosses a tab, break, field, or drawing: ${find}`);
    current = replaceBodyParagraph(current, model, paragraph, linked);
    anchor = 'phrase';
  } else if (op.paragraph) {
    const model = docxBodyModel(current);
    const paragraph = bodyParagraphAt(model, op.paragraph);
    const nextParagraph = paragraph.xml.replace(/<\/w:p>$/, `${link}</w:p>`);
    current = replaceBodyParagraph(current, model, paragraph, nextParagraph);
    anchor = 'paragraph';
  } else {
    current = appendDocxBlock(current, `<w:p>${link}</w:p>`);
  }
  zip.file(DOCUMENT_PART, current);
  return { op: op.op, changed: true, address, display, anchor };
}

export async function setDocxFont(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const formatted = formatFirstBodyPhrase(current, String(op.find || ''), op.properties || {});
  if (formatted.changed) zip.file(DOCUMENT_PART, formatted.xml);
  return { op: op.op, changed: formatted.changed, scope: 'body', matches: 1 };
}

// add_comment / add_provenance
export async function addDocxComment(zip, op) {
  const text = op.op === 'add_provenance' ? provenanceCitation(op.source) : String(op.text || '');
  if (!text) throw new Error(`${op.op} requires ${op.op === 'add_provenance' ? 'source' : 'text'}`);
  const current = await zipText(zip, DOCUMENT_PART);
  const model = docxBodyModel(current);
  const paragraph =
    op.op === 'add_provenance'
      ? bodyParagraphs(model)[Number(op.paragraph) - 1]
      : paragraphContaining(model, String(op.find || ''));
  if (!paragraph) {
    throw new Error(
      op.op === 'add_provenance'
        ? `DOCX paragraph ${op.paragraph} not found`
        : `DOCX text not found for comment anchor: ${op.find}`
    );
  }
  const comments = await ensureCommentsPart(zip);
  const id = await appendComment(zip, comments, op, text);
  // A comment marks the phrase it was asked about; the paragraph only when
  // the phrase cannot be cut out of its runs.
  const phrase = op.op === 'add_comment' ? anchorPhraseInParagraph(paragraph.xml, String(op.find || ''), id) : null;
  const anchored = phrase || anchorDocxComment(paragraph.xml, id);
  zip.file(DOCUMENT_PART, replaceBodyParagraph(current, model, paragraph, anchored));
  return {
    op: op.op,
    changed: true,
    comment: id,
    anchor: phrase ? 'phrase' : 'paragraph',
    ...(op.op === 'add_provenance' ? { target: `/body/p[${Number(op.paragraph)}]`, citation: text } : {}),
  };
}

// add_comment_reply / set_comment_resolved
export async function replyOrResolveDocxComment(zip, op) {
  const parent = Number(op.comment);
  if (!Number.isInteger(parent) || parent < 1) throw new Error(`${op.op} requires a positive comment id`);
  const comments = await ensureCommentsPart(zip);
  if (!commentEntryPattern(parent).exec(comments.xml)) throw new Error(`DOCX comment ${parent} not found`);
  if (op.op === 'set_comment_resolved') {
    await registerCommentThread(zip, { commentId: parent, done: op.resolved !== false });
    return { op: op.op, changed: true, comment: parent, resolved: op.resolved !== false };
  }
  const text = String(op.text || '');
  if (!text) throw new Error('add_comment_reply requires text');
  const id = await appendComment(zip, comments, op, text, { parentId: parent });
  const marks =
    `<w:commentRangeStart w:id="${id}"/><w:commentRangeEnd w:id="${id}"/>` +
    `<w:r><w:commentReference w:id="${id}"/></w:r>`;
  // The parent may be anchored in any story — the body, a header, a footer, a
  // note. A reply marked only where the body happens to hold the id reached no
  // story at all, and the next accept-all pruned it as orphaned.
  const pattern = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${parent}"[^>]*\\/>`);
  for (const part of docxStoryPartNames(zip)) {
    const story = await zipText(zip, part);
    const anchor = pattern.exec(story);
    if (!anchor) continue;
    zip.file(part, `${story.slice(0, anchor.index)}${marks}${story.slice(anchor.index)}`);
    break;
  }
  return { op: op.op, changed: true, comment: id, parent };
}

export async function deleteDocxComment(zip, op) {
  const id = Number(op.comment);
  if (!Number.isInteger(id) || id < 1) throw new Error('delete_comment requires a positive comment id');
  const comments = await ensureCommentsPart(zip);
  const pattern = commentEntryPattern(id);
  const entry = pattern.exec(comments.xml);
  if (!entry) throw new Error(`DOCX comment ${id} not found`);
  zip.file(comments.part, comments.xml.replace(pattern, ''));
  await forgetCommentIdentity(zip, entry[0]);
  const current = await zipText(zip, DOCUMENT_PART);
  const next = current
    .replace(new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
    .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
    .replace(
      new RegExp(
        `<w:r>(?:(?!<\\/w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*\\bw:id="${id}"[^>]*\\/>[\\s\\S]*?<\\/w:r>`,
        'g'
      ),
      ''
    );
  zip.file(DOCUMENT_PART, next);
  return { op: op.op, changed: true, comment: id };
}

export async function insertDocxToc(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const lower = Math.max(1, Number(op.lowerHeadingLevel) || 1);
  const upper = Math.max(lower, Number(op.upperHeadingLevel) || 3);
  const instruction = ` TOC \\o "${lower}-${upper}" \\h \\z \\u `;
  const cached = docxTocCacheRuns(docxTocEntries(current, lower, upper, await docxHeadingLevels(zip)), lower);
  const block = `<w:p><w:fldSimple w:instr="${xmlEncode(instruction)}">${cached}</w:fldSimple></w:p>`;
  zip.file(DOCUMENT_PART, insertDocxBlockAt(current, block, op.paragraph));
  // The cached entries are what Word draws until it rebuilds the field, so
  // the package asks for that rebuild: without it the contents reach the
  // reader as plain lines with no leaders and no page numbers.
  await ensureDocxUpdateFields(zip);
  return { op: op.op, changed: true, levels: `${lower}-${upper}`, updateFields: true };
}

export async function addDocxBookmark(zip, op) {
  const name = String(op.name || '').trim();
  if (!name) throw new Error('add_bookmark requires name');
  const current = await zipText(zip, DOCUMENT_PART);
  const ids = [...current.matchAll(/<w:bookmarkStart\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
  const id = Math.max(0, ...ids) + 1;
  const model = docxBodyModel(current);
  const paragraph = op.paragraph
    ? bodyParagraphs(model)[Number(op.paragraph) - 1]
    : paragraphContaining(model, String(op.find || ''));
  if (!paragraph) throw new Error('add_bookmark could not resolve a target paragraph');
  const opening = /^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(paragraph.xml)?.[0] || '<w:p>';
  const marked =
    `${opening}<w:bookmarkStart w:id="${id}" w:name="${xmlEncode(name)}"/>` +
    `${paragraph.xml.slice(opening.length)}`.replace(/<\/w:p>$/, `<w:bookmarkEnd w:id="${id}"/></w:p>`);
  zip.file(DOCUMENT_PART, replaceBodyParagraph(current, model, paragraph, marked));
  return { op: op.op, changed: true, name, bookmark: id };
}

export async function setDocxHeaderFooter(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const { named, kind } = storyTarget(op);
  let header = op.header !== false;
  if (named === 'footer') header = false;
  else if (named === 'header') header = true;
  const written = await writeHeaderFooterPart(zip, {
    header,
    documentXml: current,
    kind,
    body: wordParagraph(op.text, { alignment: header ? '' : 'center' }),
  });
  const next = writeSectionPropertiesAt(current, op.section, (section) => {
    const referenced = upsertSectionReference(
      section,
      header ? 'headerReference' : 'footerReference',
      kind,
      written.relationshipId
    );
    return kind === 'first' && !/<w:titlePg\b/.test(referenced)
      ? upsertSectionChild(referenced, 'titlePg', '<w:titlePg/>', ['pgMar', 'pgSz'])
      : referenced;
  });
  zip.file(DOCUMENT_PART, next);
  // replaced says the section already had this story: whatever stood there
  // — a page number, an earlier line — is gone, not beside the new text.
  return {
    op: op.op,
    changed: true,
    part: written.part,
    header,
    kind,
    ...(written.replaced ? { replaced: true } : {}),
  };
}

// Same vocabulary as set_header_footer: kind names the story (the footer
// unless the caller asks for the header), variant names the page.
export async function addDocxPageNumbers(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const { named, kind } = storyTarget(op);
  const header = named === 'header';
  const alignment = ['left', 'center', 'right'].includes(String(op.alignment || '').toLowerCase())
    ? String(op.alignment).toLowerCase()
    : 'center';
  const prefix = op.prefix ? `<w:r><w:t xml:space="preserve">${xmlEncode(op.prefix)} </w:t></w:r>` : '';
  const separator =
    op.includeTotal === true
      ? `<w:r><w:t xml:space="preserve"> ${xmlEncode(op.separator || '/')} </w:t></w:r>` +
        '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
      : '';
  const numbering =
    `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>${prefix}` +
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    `${separator}</w:p>`;
  // A footer line and its page number are two operations, and this one used
  // to write the story from scratch: the author's footer text was gone from
  // the file while the result reported success. Only the paragraph carrying
  // the page field is rewritten, so asking twice never stacks a second
  // number and never erases the words around it.
  let keptStory = false;
  const written = await writeHeaderFooterPart(zip, {
    header,
    documentXml: current,
    kind,
    body: (story) => {
      const around = String(story).replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) =>
        /w:instr="[^"]*\bPAGE\b/.test(paragraph) ? '' : paragraph
      );
      keptStory = Boolean(around.trim());
      return `${around}${numbering}`;
    },
  });
  const next = writeSectionPropertiesAt(current, op.section, (section) =>
    upsertSectionReference(section, header ? 'headerReference' : 'footerReference', kind, written.relationshipId)
  );
  zip.file(DOCUMENT_PART, next);
  return {
    op: op.op,
    changed: true,
    part: written.part,
    header,
    includeTotal: op.includeTotal === true,
    ...(written.replaced ? { replaced: true } : {}),
    ...(keptStory ? { keptExistingContent: true } : {}),
  };
}

export async function insertDocxBreak(zip, op) {
  const current = await zipText(zip, DOCUMENT_PART);
  const kind = String(op.kind || 'page').toLowerCase();
  if (!['page', 'column', 'section_next', 'section_continuous'].includes(kind)) {
    throw new Error('insert_break supports page, column, section_next, or section_continuous');
  }
  if (kind.startsWith('section')) {
    // A section break paragraph carries the properties of the section it
    // closes, so the text before it keeps the page it was written for and
    // the trailing sectPr — which set_page edits — governs what follows.
    const { match } = trailingSectionProperties(current);
    const closing = upsertSectionChild(
      match ? match[0] : '<w:sectPr></w:sectPr>',
      'type',
      `<w:type w:val="${kind === 'section_continuous' ? 'continuous' : 'nextPage'}"/>`
    );
    const block = `<w:p><w:pPr>${closing}</w:pPr></w:p>`;
    const next = insertDocxBlockAt(current, block, op.paragraph);
    zip.file(DOCUMENT_PART, next);
    return { op: op.op, changed: true, kind, sections: documentSectionSpans(next).spans.length };
  }
  const block = `<w:p><w:r><w:br w:type="${kind}"/></w:r></w:p>`;
  zip.file(DOCUMENT_PART, insertDocxBlockAt(current, block, op.paragraph));
  return { op: op.op, changed: true, kind };
}

export async function normalizeDocxStoryRuns(zip, op, { parts }) {
  const summary = { merged: 0, textMerged: 0, proofErrRemoved: 0, rsidStripped: 0, parts: [] };
  for (const part of parts) {
    const current = await zipText(zip, part);
    const normalized = normalizeDocxRuns(current);
    if (!(normalized.merged + normalized.proofErrRemoved + normalized.rsidStripped)) continue;
    zip.file(part, normalized.xml);
    summary.merged += normalized.merged;
    summary.textMerged += normalized.textMerged;
    summary.proofErrRemoved += normalized.proofErrRemoved;
    summary.rsidStripped += normalized.rsidStripped;
    summary.parts.push(part);
  }
  return { op: op.op, changed: summary.parts.length > 0, ...summary };
}
