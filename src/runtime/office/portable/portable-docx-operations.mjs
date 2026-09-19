// Document-level operations the portable DOCX backend applies: TOC refresh,
// notes, page setup, table fitting, content controls, paragraph edits,
// table cells and revision resolution.
import { zipText } from './portable-opc.mjs';
import { docxBodyModel } from './portable-snapshot.mjs';
import { paragraphTexts, rebuildTextNodes, textNodes, xmlDecode, xmlEncode } from './portable-xml.mjs';
import {
  ensureNotePart,
  forgetCommentIdentity,
  markRunsDeleted,
  nextRevisionId,
  revisionAttributes,
  trailingSectionProperties,
  upsertSectionChild,
  writeSectionPropertiesAt,
} from './portable-docx-parts.mjs';
import {
  applyWordRunFormat,
  docxTable,
  justifyWordParagraphs,
  mergeWordCellProperties,
  replaceDocxTable,
  replaceWordProperties,
  rowCellMatches,
  tableRowMatches,
  wordJustification,
  wordTableProperties,
} from './portable-docx-xml.mjs';
import { docxRevisionTree, flattenDocxRevisions } from './docx-revisions.mjs';
import { settleDocxStory } from './docx-runs.mjs';
import { anchorPhraseInParagraph, trackedParagraphReplace, trackedParagraphRewrite } from './docx-tracked-edits.mjs';

// Word rebuilds a TOC field when the reader updates it; until then the cached
// result is what every other reader shows — a preview, a PDF export, a render.
// The cache is the document's own outline, so it is built from the headings the
// body carries at the time it is written.
// Which paragraph styles this document calls a heading. Word's own style ids
// are not the only ones a real file carries: a localized or converted document
// names its headings 제목 1 or declares an outline level under its own id, and a
// table of contents that only knows "Heading1" lists nothing at all.
export async function docxHeadingLevels(zip) {
  const styles = await zipText(zip, 'word/styles.xml');
  const levels = new Map();
  for (const match of styles.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g)) {
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(match[0])?.[1] || '';
    const outline = Number(/<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(match[0])?.[1]);
    const named = /^(?:heading|제목|표제)\s*([1-9])/i.exec(name.trim());
    let level = 0;
    if (Number.isInteger(outline) && outline >= 0 && outline <= 8) level = outline + 1;
    else if (named) level = Number(named[1]);
    if (level) levels.set(match[1], level);
  }
  return levels;
}

const A4_WIDTH_TWIPS = 11_906;
const A4_HEIGHT_TWIPS = 16_838;

// word/document.xml first, then headers and footers in name order.
function documentPartFirst(left, right) {
  if (left === 'word/document.xml') return -1;
  if (right === 'word/document.xml') return 1;
  return left.localeCompare(right);
}

// A deleted paragraph mark lives in the paragraph's own run properties: the
// mark joins an existing <w:rPr>, else opens one under <w:pPr>, else opens a
// <w:pPr> at the head of the paragraph.
function withParagraphMarkRevision(paragraphXml, mark) {
  if (!/<w:pPr(?:\s[^>]*)?>/.test(paragraphXml)) {
    return paragraphXml.replace(/^(<w:p(?:\s[^>]*)?>)/, `$1<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`);
  }
  if (/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>\s*<\/w:pPr>/.test(paragraphXml)) {
    return paragraphXml.replace(/(<w:rPr(?:\s[^>]*)?>)/, `$1${mark}`);
  }
  return paragraphXml.replace(/<\/w:pPr>/, `<w:rPr>${mark}</w:rPr></w:pPr>`);
}

export function docxTocEntries(documentXml, lower, upper, headingLevels = new Map()) {
  const entries = [];
  for (const match of documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const style = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(match[0])?.[1] || '';
    const level = Number(/^Heading([1-9])$/.exec(style)?.[1]) || headingLevels.get(style) || 0;
    if (!Number.isInteger(level) || level < lower || level > upper) continue;
    const text = paragraphTexts(match[0], 'w:t').join('').trim();
    if (text) entries.push({ level, text });
  }
  return entries;
}

export function docxTocCacheRuns(entries, lower) {
  return entries.length
    ? entries
        .map(
          (entry) =>
            `<w:r><w:t xml:space="preserve">${xmlEncode(`${'    '.repeat(entry.level - lower)}${entry.text}`)}</w:t></w:r>`
        )
        .join('<w:r><w:br/></w:r>')
    : '<w:r><w:t>Update this field in Word to build the table of contents.</w:t></w:r>';
}

/** A table of contents is usually written before the sections it lists, so the
 *  cache captured at insert time would show an empty document forever. Every
 *  save rebuilds it from the body as it stands. */
export async function refreshDocxTableOfContents(zip) {
  const current = await zipText(zip, 'word/document.xml');
  if (!/<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC/.test(current)) return false;
  const headingLevels = await docxHeadingLevels(zip);
  const next = current.replace(
    /<w:fldSimple\b([^>]*\bw:instr="([^"]*TOC[^"]*)"[^>]*)>[\s\S]*?<\/w:fldSimple>/g,
    (_whole, attributes, instruction) => {
      const range = /\\o\s*(?:"|&quot;)(\d+)-(\d+)(?:"|&quot;)/.exec(instruction);
      const lower = Math.max(1, Number(range?.[1]) || 1);
      const upper = Math.max(lower, Number(range?.[2]) || 3);
      return `<w:fldSimple${attributes}>${docxTocCacheRuns(docxTocEntries(current, lower, upper, headingLevels), lower)}</w:fldSimple>`;
    }
  );
  if (next === current) return false;
  zip.file('word/document.xml', next);
  return true;
}

/** Tracked find-and-replace cuts only the matched characters out of their
 *  runs (deletion plus insertion in the run's own formatting). A match that
 *  crosses a run carrying a tab, break, field, or drawing falls back to
 *  rewriting that paragraph as one deletion plus one insertion, so every
 *  changed character still sits inside a wrapper for the redlining audit. */
export function replaceTrackedParagraphs(xml, find, replacement, author) {
  if (!find) throw new Error('replace_text requires non-empty find');
  let id = nextRevisionId(xml);
  let count = 0;
  let paragraphRewrites = 0;
  const next = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const joined = textNodes(paragraph, 'w:t')
      .map((node) => node.text)
      .join('');
    if (!joined.includes(find)) return paragraph;
    const cut = trackedParagraphReplace(paragraph, find, replacement, id, author);
    if (cut.count) {
      count += cut.count;
      id = cut.nextId;
      return cut.xml;
    }
    count += joined.split(find).length - 1;
    paragraphRewrites += 1;
    const runCount = (paragraph.match(/<w:r(?:\s[^>]*)?>/g) || []).length;
    const rewritten = trackedParagraphRewrite(paragraph, joined.split(find).join(replacement), id, author);
    id += runCount + 1;
    return rewritten;
  });
  return { xml: next, count, paragraphRewrites };
}

/** Word drops a comment together with the text it marked; after accepting a
 *  deletion that carried the whole anchor, the comment has no reference left
 *  in any story and is removed with its thread, id map, and timestamp. */
async function pruneOrphanComments(zip, parts) {
  const comments = await zipText(zip, 'word/comments.xml');
  if (!comments) return 0;
  const referenced = new Set();
  for (const part of parts.filter((name) => !/\/comments\.xml$/i.test(name))) {
    const xml = await zipText(zip, part);
    for (const match of xml.matchAll(/<w:commentReference\b[^>]*\bw:id="([^"]*)"/g)) referenced.add(match[1]);
  }
  let next = comments;
  const removedIds = [];
  for (const match of comments.matchAll(/<w:comment\b[^>]*\bw:id="([^"]*)"[^>]*>[\s\S]*?<\/w:comment>/g)) {
    if (referenced.has(match[1])) continue;
    next = next.replace(match[0], '');
    await forgetCommentIdentity(zip, match[0]);
    removedIds.push(match[1]);
  }
  if (!removedIds.length) return 0;
  zip.file('word/comments.xml', next);
  // The range markers are not runs, so a deletion never carried them away;
  // without their comment they would read as a marker mismatch.
  for (const part of parts.filter((name) => !/\/comments\.xml$/i.test(name))) {
    const xml = await zipText(zip, part);
    const stripped = removedIds.reduce(
      (value, id) =>
        value.replace(
          new RegExp(
            `<w:commentRange(?:Start|End)\\b[^>]*\\bw:id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*\\/>`,
            'g'
          ),
          ''
        ),
      xml
    );
    if (stripped !== xml) zip.file(part, stripped);
  }
  return removedIds.length;
}

/** Writes a footnote or endnote and anchors its mark on the phrase it cites. */
export async function addDocxNote(zip, op) {
  const text = String(op.text || '');
  if (!text) throw new Error('add_note requires text');
  const definition = await ensureNotePart(zip, op.kind || 'footnote');
  let current = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(current);
  const paragraphs = model.blocks.filter((block) => block.name === 'w:p');
  const find = String(op.find || '');
  const paragraph = op.paragraph
    ? paragraphs[Number(op.paragraph) - 1]
    : paragraphs.find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(find));
  if (!paragraph) {
    throw new Error(
      op.paragraph ? `DOCX paragraph ${op.paragraph} not found` : `DOCX text not found for note anchor: ${find}`
    );
  }
  const ids = [...definition.xml.matchAll(new RegExp(`<${definition.tag}\\b[^>]*\\bw:id="(-?\\d+)"`, 'g'))].map(
    (match) => Number(match[1])
  );
  const id = Math.max(0, ...ids) + 1;
  const entry =
    `<${definition.tag} w:id="${id}">` +
    `<w:p><w:pPr><w:pStyle w:val="${definition.textStyle}"/></w:pPr>` +
    `<w:r><w:rPr><w:rStyle w:val="${definition.style}"/><w:vertAlign w:val="superscript"/></w:rPr>` +
    `<w:${definition.reference === 'w:footnoteReference' ? 'footnoteRef' : 'endnoteRef'}/></w:r>` +
    `<w:r><w:t xml:space="preserve"> ${xmlEncode(text)}</w:t></w:r></w:p></${definition.tag}>`;
  zip.file(definition.part, definition.xml.replace(`</${definition.root}>`, `${entry}</${definition.root}>`));
  // The mark belongs right after the phrase it cites; a phrase split across
  // a tab, field, or drawing falls back to the end of its paragraph.
  const mark =
    `<w:r><w:rPr><w:rStyle w:val="${definition.style}"/><w:vertAlign w:val="superscript"/></w:rPr>` +
    `<${definition.reference} w:id="${id}"/></w:r>`;
  const phrase = find ? anchorPhraseInParagraph(paragraph.xml, find, id, { start: '', end: mark }) : null;
  const anchored = phrase || paragraph.xml.replace(/<\/w:p>$/, `${mark}</w:p>`);
  const nextInner = `${model.body.inner.slice(0, paragraph.start)}${anchored}${model.body.inner.slice(paragraph.end)}`;
  current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
  zip.file('word/document.xml', current);
  return {
    op: op.op,
    changed: true,
    kind: definition.tag === 'w:footnote' ? 'footnote' : 'endnote',
    note: id,
    anchor: phrase ? 'phrase' : 'paragraph',
  };
}

/** Page size, orientation, margins and text columns of one section, keeping what was not asked for. */
function pageRequest(properties) {
  const orientation = String(properties.orientation || '').toLowerCase();
  if (orientation && !['portrait', 'landscape'].includes(orientation)) {
    throw new Error('set_page orientation must be portrait or landscape');
  }
  const columnCount = properties.columns == null ? null : Number(properties.columns);
  if (columnCount !== null && (!Number.isInteger(columnCount) || columnCount < 1 || columnCount > 12)) {
    throw new Error('set_page columns must be a whole number from 1 to 12');
  }
  const columnSpacing = properties.columnSpacing == null ? null : Number(properties.columnSpacing);
  if (columnSpacing !== null && (!Number.isFinite(columnSpacing) || columnSpacing < 0)) {
    throw new Error('set_page columnSpacing must be a number of points');
  }
  return { orientation, columnCount, columnSpacing };
}

// One section's page size, margins and (when asked) column layout, each
// half of a pair the caller left out keeping what the section already said.
function sectionWithPage(section, properties, { orientation, columnCount, columnSpacing }) {
  const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
  let pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || A4_WIDTH_TWIPS;
  let pageHeight = Number(/\bw:h="(\d+)"/.exec(size)?.[1]) || A4_HEIGHT_TWIPS;
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
    ['type']
  );
  const withMargins = upsertSectionChild(
    withSize,
    'pgMar',
    `<w:pgMar w:top="${margin('top', 'topMargin', 1418)}" w:right="${margin('right', 'rightMargin', 1418)}"` +
      ` w:bottom="${margin('bottom', 'bottomMargin', 1418)}" w:left="${margin('left', 'leftMargin', 1418)}"` +
      ` w:header="${margin('header', 'headerMargin', 709)}" w:footer="${margin('footer', 'footerMargin', 709)}" w:gutter="0"/>`,
    ['pgSz']
  );
  if (columnCount === null && columnSpacing === null) return withMargins;
  // The text flows through the columns the section declares, so a brochure
  // page needs no text boxes.
  const declared = /<w:cols\b([^>]*)\/>/.exec(withMargins)?.[1] || '';
  const carriedCount = Number(/\bw:num="(\d+)"/.exec(declared)?.[1]) || 1;
  const count = columnCount ?? carriedCount;
  const carriedSpace = Number(/\bw:space="(\d+)"/.exec(declared)?.[1]) || 708;
  const space = columnSpacing === null ? carriedSpace : Math.round(columnSpacing * 20);
  return upsertSectionChild(
    withMargins,
    'cols',
    `<w:cols${count > 1 ? ` w:num="${count}" w:equalWidth="1"` : ''} w:space="${space}"/>`,
    ['pgMar', 'pgSz']
  );
}

export async function setDocxPage(zip, op) {
  const current = await zipText(zip, 'word/document.xml');
  const properties = op.properties || {};
  const request = pageRequest(properties);
  const { orientation, columnCount } = request;
  const next = writeSectionPropertiesAt(current, op.section, (section) =>
    sectionWithPage(section, properties, request)
  );
  zip.file('word/document.xml', next);
  return {
    op: op.op,
    changed: next !== current,
    orientation: orientation || 'unchanged',
    ...(columnCount === null ? {} : { columns: columnCount }),
  };
}

/** Rebalances a table across the text column, keeping each column's share and every cell's own properties. */
// The text column's width in twips: the trailing section's page width less
// its side margins.
function usableTextWidth(documentXml) {
  const section = trailingSectionProperties(documentXml).match?.[0] || '';
  const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
  const margins = /<w:pgMar\b([^>]*)\/>/.exec(section)?.[1] || '';
  const pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || A4_WIDTH_TWIPS;
  const marginLeft = Number(/\bw:left="(-?\d+)"/.exec(margins)?.[1]) || 1418;
  const marginRight = Number(/\bw:right="(-?\d+)"/.exec(margins)?.[1]) || 1418;
  return Math.max(720, pageWidth - marginLeft - marginRight);
}

// Every cell's width becomes the grid columns it spans; its span, merge,
// border, shading and alignment properties are kept.
function fitTableCells(tableXml, widths) {
  return tableXml.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) => {
    let index = 0;
    return row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (cell) => {
      const existing = /<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(cell)?.[1] || '';
      const keep = (pattern) => pattern.exec(existing)?.[0] || '';
      const span = Math.max(1, Number(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(existing)?.[1]) || 1);
      const width = widths.slice(index, index + span).reduce((sum, column) => sum + (column || 0), 0) || widths.at(-1);
      index += span;
      return replaceWordProperties(
        cell,
        'tc',
        'tcPr',
        `<w:tcW w:w="${width}" w:type="dxa"/>` +
          keep(/<w:gridSpan\b[^>]*\/>/) +
          keep(/<w:hMerge\b[^>]*\/>/) +
          keep(/<w:vMerge\b[^>]*\/>/) +
          keep(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/) +
          keep(/<w:shd\b[^>]*\/>/) +
          keep(/<w:vAlign\b[^>]*\/>/)
      );
    });
  });
}

export async function fitDocxTable(zip, op) {
  let current = await zipText(zip, 'word/document.xml');
  const table = docxTable(current, op.table);
  const usable = usableTextWidth(current);
  const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(table[0]);
  const columns = grid ? [...grid[0].matchAll(/<w:gridCol\b([^>]*)\/>/g)] : [];
  const count = Math.max(1, columns.length);
  const currentWidths = columns.map((column) => Number(/\bw:w="(\d+)"/.exec(column[1])?.[1]) || 0);
  const total = currentWidths.reduce((sum, width) => sum + width, 0);
  const widths =
    total > 0
      ? currentWidths.map((width) => Math.max(240, Math.round((width / total) * usable)))
      : Array.from({ length: count }, () => Math.round(usable / count));
  let nextTable = grid
    ? table[0].replace(
        grid[0],
        `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`
      )
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
  nextTable = fitTableCells(replaceWordProperties(nextTable, 'tbl', 'tblPr', tableProperties), widths);
  current = replaceDocxTable(current, table, nextTable);
  zip.file('word/document.xml', current);
  return { op: op.op, changed: true, table: Number(op.table), width: usable, columns: count };
}

/** Fills one named or numbered content control, in the body, a header, or a footer. */
// One run carries the value, the rest are dropped: a control filled across
// its old runs keeps fragments of the placeholder it replaced. A placeholder
// control shows grey prompt text until the flag goes.
function controlFilledWith(control, contentInner, text) {
  const first = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/.exec(contentInner);
  const runProperties = first ? /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/.exec(first[0])?.[0] || '' : '';
  const run = `<w:r>${runProperties}<w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r>`;
  const [firstParagraph] = contentInner.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/) || [];
  const paragraph = firstParagraph
    ? `${/^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(firstParagraph)?.[0] || '<w:p>'}${run}</w:p>`
    : run;
  const cleaned = control.replace(/<w:showingPlcHdr\b[^>]*\/>/g, '');
  return cleaned.replace(/<w:sdtContent\b[^>]*>[\s\S]*?<\/w:sdtContent>/, `<w:sdtContent>${paragraph}</w:sdtContent>`);
}

export async function fillDocxContentControl(zip, op) {
  const text = String(op.text ?? '');
  const tag = String(op.tag || '').trim();
  const wanted = Number(op.control);
  if (!tag && !Number.isInteger(wanted)) throw new Error('set_content_control requires tag or control');
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/i.test(name))
    .sort(documentPartFirst);
  let ordinal = 0;
  let filled = null;
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    let changed = false;
    const next = xml.replace(/<w:sdt\b[^>]*>[\s\S]*?<\/w:sdt>/g, (control) => {
      if (filled) return control;
      ordinal += 1;
      const properties = /<w:sdtPr\b[^>]*>([\s\S]*?)<\/w:sdtPr>/.exec(control)?.[1] || '';
      const controlTag = xmlDecode(/<w:tag\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || '');
      if (tag ? controlTag !== tag : ordinal !== wanted) return control;
      const lock = /<w:lock\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || '';
      if (/contentLocked|sdtContentLocked/i.test(lock)) {
        throw new Error(`DOCX content control ${tag || wanted} is locked for editing (lock: ${lock})`);
      }
      const body = /<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/.exec(control);
      if (!body) return control;
      changed = true;
      filled = { part, ordinal, tag: controlTag };
      return controlFilledWith(control, body[1], text);
    });
    if (changed) {
      zip.file(part, next);
      break;
    }
  }
  if (!filled) {
    throw new Error(
      tag ? `DOCX content control not found for tag: ${tag}` : `DOCX content control ${wanted} not found`
    );
  }
  return {
    op: op.op,
    changed: true,
    control: filled.ordinal,
    ...(filled.tag ? { tag: filled.tag } : {}),
    text,
  };
}

/** Rewrites, removes, or moves one body paragraph, tracked when the document tracks. */
// Moves the paragraph before the destination-th remaining paragraph, or to
// the end of the body when there is none.
function movedParagraphInner(inner, model, paragraph, destination) {
  const remaining = model.blocks.filter((block) => block !== paragraph);
  const paragraphBlocks = remaining.filter((block) => block.name === 'w:p');
  const anchor = paragraphBlocks[destination - 1];
  const without = `${inner.slice(0, paragraph.start)}${inner.slice(paragraph.end)}`;
  if (!anchor) return `${without}${paragraph.xml}`;
  const adjustedStart = anchor.start > paragraph.start ? anchor.start - paragraph.xml.length : anchor.start;
  return `${without.slice(0, adjustedStart)}${paragraph.xml}${without.slice(adjustedStart)}`;
}

// Untracked text edits: set_run_text replaces one run, set_paragraph_text
// keeps the first run and empties the rest, and an empty paragraph gains a run.
function paragraphWithText(paragraph, op) {
  const nodes = textNodes(paragraph.xml, 'w:t');
  if (!nodes.length) {
    if (op.op === 'set_run_text') throw new Error(`DOCX paragraph ${op.paragraph} has no editable text`);
    const run = `<w:r><w:t xml:space="preserve">${xmlEncode(String(op.text ?? ''))}</w:t></w:r>`;
    if (/<\/w:p>\s*$/.test(paragraph.xml)) return paragraph.xml.replace(/<\/w:p>\s*$/, `${run}</w:p>`);
    if (/\/>\s*$/.test(paragraph.xml)) return paragraph.xml.replace(/\/>\s*$/, `>${run}</w:p>`);
    throw new Error(`DOCX paragraph ${op.paragraph} is malformed`);
  }
  if (op.op === 'set_run_text') {
    const run = nodes[Number(op.run) - 1];
    if (!run) throw new Error(`DOCX run ${op.run} not found in paragraph ${op.paragraph}`);
    run.text = String(op.text ?? '');
    return rebuildTextNodes(paragraph.xml, 'w:t', nodes);
  }
  nodes[0].text = String(op.text ?? '');
  for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
  return rebuildTextNodes(paragraph.xml, 'w:t', nodes);
}

export async function editDocxParagraph(zip, op, tracking) {
  let current = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(current);
  const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
  let nextInner = model.body.inner;
  const splice = (replacement) =>
    `${nextInner.slice(0, paragraph.start)}${replacement}${nextInner.slice(paragraph.end)}`;
  if (op.op === 'remove_paragraph' && tracking) {
    const id = nextRevisionId(current);
    const marked = markRunsDeleted(paragraph.xml, id, op.author);
    const mark = `<w:del ${revisionAttributes(id + 900, op.author)}/>`;
    nextInner = splice(withParagraphMarkRevision(marked, mark));
  } else if (op.op === 'remove_paragraph') {
    nextInner = splice('');
  } else if (op.op === 'move_paragraph') {
    nextInner = movedParagraphInner(nextInner, model, paragraph, Math.max(1, Number(op.index)));
  } else if (tracking && op.op === 'set_paragraph_text') {
    nextInner = splice(
      trackedParagraphRewrite(paragraph.xml, String(op.text ?? ''), nextRevisionId(current), op.author)
    );
  } else {
    nextInner = splice(paragraphWithText(paragraph, op));
  }
  current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
  zip.file('word/document.xml', current);
  return {
    op: op.op,
    changed: true,
    ...(tracking && ['set_paragraph_text', 'remove_paragraph'].includes(op.op) ? { tracked: true } : {}),
  };
}

// The same properties the Word backend applies to the cell's range: a stat
// band's label row set at 9 pt under a 22 pt value row is one
// set_table_cell_style per cell, on either backend.
function styledDocxCell(cell, op) {
  let nextCell = mergeWordCellProperties(cell, op.properties);
  const cellSize = Number(op.properties?.fontSize);
  const cellFont = op.properties?.fontName ? xmlEncode(String(op.properties.fontName)) : '';
  const cellEastAsia = op.properties?.fontNameEastAsia ? xmlEncode(String(op.properties.fontNameEastAsia)) : '';
  const latinFontAttrs = cellFont ? ` w:ascii="${cellFont}" w:hAnsi="${cellFont}" w:cs="${cellFont}"` : '';
  const eastAsiaFontAttrs = cellEastAsia ? ` w:eastAsia="${cellEastAsia}"` : '';
  const runFormat = [
    cellFont || cellEastAsia ? `<w:rFonts${latinFontAttrs}${eastAsiaFontAttrs}/>` : '',
    op.properties?.bold ? '<w:b/>' : '',
    op.properties?.italic ? '<w:i/>' : '',
    op.properties?.color ? `<w:color w:val="${xmlEncode(String(op.properties.color).replace(/^#/, ''))}"/>` : '',
    Number.isFinite(cellSize) && cellSize > 0
      ? `<w:sz w:val="${Math.round(cellSize * 2)}"/><w:szCs w:val="${Math.round(cellSize * 2)}"/>`
      : '',
  ].join('');
  nextCell = applyWordRunFormat(nextCell, runFormat);
  // The cell's line pitch follows its new size (the table convention, 1.3× the size, at least): a 9 pt
  // label row under a 22 pt value row otherwise keeps the value row's 29 pt lines and floats the labels.
  if (Number.isFinite(cellSize) && cellSize > 0) {
    nextCell = nextCell.replace(
      /(<w:spacing\b[^>]*\bw:line=")(\d+)("[^>]*\bw:lineRule="atLeast")/g,
      (_, open, __, close) => `${open}${Math.round(cellSize * 1.3 * 20)}${close}`
    );
  }
  // A cell's horizontal alignment is its paragraphs' justification: a
  // centred metric that stays left-aligned reads as a different number
  // column from the header above it.
  const alignment = String(op.properties?.horizontalAlignment || '')
    .trim()
    .toLowerCase();
  if (alignment) {
    const justification = wordJustification(alignment);
    if (!justification)
      throw new Error(
        `set_table_cell_style horizontalAlignment must be left, center, right, or justify, not ${alignment}`
      );
    nextCell = justifyWordParagraphs(nextCell, justification);
  }
  return nextCell;
}

// Merges the located cell across colSpan columns (dropping the absorbed
// cells) and rowSpan rows (continuation cells become vMerge).
function mergedDocxTable({ table, rows, row, cells, cell }, op) {
  const colSpan = Math.max(1, Number(op.colSpan) || 1);
  const rowSpan = Math.max(1, Number(op.rowSpan) || 1);
  const merged = replaceWordProperties(
    cell[0],
    'tc',
    'tcPr',
    `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}${rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ''}`
  );
  let nextRow = row[0].replace(cell[0], merged);
  for (let index = Number(op.col); index < Number(op.col) + colSpan - 1; index += 1) {
    const remove = cells[index];
    if (remove) nextRow = nextRow.replace(remove[0], '');
  }
  let nextTable = table[0].replace(row[0], nextRow);
  if (rowSpan > 1) {
    for (let rowIndex = Number(op.row); rowIndex < Number(op.row) + rowSpan - 1; rowIndex += 1) {
      const continuationRow = rows[rowIndex];
      if (!continuationRow) break;
      const continuationCells = rowCellMatches(continuationRow[0]);
      const continuation = continuationCells[Number(op.col) - 1];
      if (!continuation) continue;
      const nextCell = replaceWordProperties(
        continuation[0],
        'tc',
        'tcPr',
        `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}<w:vMerge/>`
      );
      nextTable = nextTable.replace(continuation[0], nextCell);
    }
  }
  return nextTable;
}

/** Styles one table cell, or merges it across columns and rows. */
export async function styleOrMergeDocxTableCell(zip, op) {
  let current = await zipText(zip, 'word/document.xml');
  const table = docxTable(current, op.table);
  const rows = tableRowMatches(table[0]);
  const row = rows[Number(op.row) - 1];
  if (!row) throw new Error(`DOCX table row ${op.row} not found`);
  const cells = rowCellMatches(row[0]);
  const cell = cells[Number(op.col) - 1];
  if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
  const nextTable =
    op.op === 'set_table_cell_style'
      ? table[0].replace(cell[0], styledDocxCell(cell[0], op))
      : mergedDocxTable({ table, rows, row, cells, cell }, op);
  current = replaceDocxTable(current, table, nextTable);
  zip.file('word/document.xml', current);
  return {
    op: op.op,
    changed: nextTable !== table[0],
    table: Number(op.table),
    row: Number(op.row),
    col: Number(op.col),
  };
}

// Settles each story part in turn, adding its counts to `totals`. A single
// addressed revision (by ordinal or id) stops at the part that held it;
// ordinals run across the parts in the order given.
async function settleDocxStories(zip, stories, totals, { resolution, target, revisionId, author, single }) {
  const reviewers = new Set();
  let ordinalOffset = 0;
  let settled = false;
  for (const part of stories) {
    const current = await zipText(zip, part);
    if (!current) continue;
    const spans = target || author ? flattenDocxRevisions(docxRevisionTree(current)) : [];
    for (const span of spans) reviewers.add(span.author);
    let partTarget = 0;
    if (target) {
      const first = ordinalOffset + 1;
      ordinalOffset += spans.length;
      if (target < first || target > ordinalOffset) continue;
      partTarget = target - first + 1;
    }
    const story = settleDocxStory(current, { resolution, target: partTarget, id: revisionId, author });
    if (story.xml !== current) zip.file(part, story.xml);
    for (const key of Object.keys(totals)) totals[key] += story[key];
    if (single && story.resolved) {
      settled = true;
      break;
    }
  }
  return { reviewers, settled };
}

function revisionResolutionRequest(op) {
  const resolution = String(op.resolution || 'accept').toLowerCase();
  if (!['accept', 'reject'].includes(resolution)) {
    throw new Error(`${op.op} resolution must be accept or reject`);
  }
  // One revision is addressed by the snapshot ordinal or, portable only,
  // by its w:id; either way the paragraph marks and formatting records
  // stay untouched because they carry no ordinal.
  const revisionId = op.op === 'resolve_revision' && op.id != null && op.id !== '' ? String(op.id) : '';
  const target = op.op === 'resolve_revision' && !revisionId ? Math.max(1, Number(op.revision) || 1) : 0;
  // resolve_revisions may settle one reviewer only; the other reviewers'
  // wrappers, paragraph marks, rows, and formatting records stay tracked.
  const author = op.op === 'resolve_revisions' && op.author != null && op.author !== '' ? String(op.author) : '';
  return { resolution, target, revisionId, author, single: Boolean(target || revisionId) };
}

// A label that matches nobody is most often a misspelt reviewer; the
// names actually present let the caller correct it.
function unmatchedAuthorNote(author, reviewers) {
  return reviewers.size
    ? `No revision by "${author}"; the tracked changes are by ${[...reviewers].map((name) => `"${name}"`).join(', ')}.`
    : `No revision by "${author}"; the document carries no tracked change.`;
}

/** Accepts or rejects tracked changes across the body, headers, footers, and notes. */
export async function resolveDocxRevisions(zip, parts, op) {
  const request = revisionResolutionRequest(op);
  const { resolution, target, revisionId, author, single } = request;
  // Headers, footers, and notes carry tracked changes of their own, and
  // Word's accept-all settles them too. Snapshot ordinals run through the
  // story parts in name order, which is the order walked here.
  const stories = parts.filter((name) => !/\/comments\.xml$/i.test(name)).sort();
  const totals = {
    resolved: 0,
    merged: 0,
    cleared: 0,
    unmerged: 0,
    rowsRemoved: 0,
    rowsCleared: 0,
    propertyChanges: 0,
  };
  const { reviewers, settled } = await settleDocxStories(zip, stories, totals, request);
  if (single && !settled) {
    throw new Error(revisionId ? `DOCX revision id ${revisionId} not found` : `DOCX revision ${target} not found`);
  }
  const commentsRemoved = single ? 0 : await pruneOrphanComments(zip, parts);
  const paragraphMarks = totals.merged + totals.cleared + totals.unmerged;
  const tableRows = totals.rowsRemoved + totals.rowsCleared;
  const changed =
    totals.resolved > 0 || paragraphMarks > 0 || tableRows > 0 || totals.propertyChanges > 0 || commentsRemoved > 0;
  const note = author && !changed ? unmatchedAuthorNote(author, reviewers) : '';
  return {
    op: op.op,
    changed,
    resolution,
    resolved: totals.resolved,
    ...(revisionId ? { id: revisionId } : {}),
    ...(author ? { author } : {}),
    ...(note ? { note } : {}),
    ...(paragraphMarks ? { paragraphMarks, mergedParagraphs: totals.merged } : {}),
    ...(tableRows ? { tableRows: { removed: totals.rowsRemoved, cleared: totals.rowsCleared } } : {}),
    ...(totals.propertyChanges ? { propertyChanges: totals.propertyChanges } : {}),
    ...(commentsRemoved ? { commentsRemoved } : {}),
    ...(totals.unmerged
      ? {
          note: `${totals.unmerged} paragraph mark(s) could not join the next block (a table or the end of the body); the mark was cleared instead.`,
        }
      : {}),
  };
}
