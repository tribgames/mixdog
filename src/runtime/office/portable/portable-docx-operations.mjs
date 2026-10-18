// Document-level operations the portable DOCX backend applies: TOC refresh,
// notes, page setup, table fitting, content controls, paragraph edits,
// table cells and revision resolution.
import { zipText } from './portable-opc.mjs';
import { docxBodyModel } from './portable-snapshot.mjs';
import { paragraphTexts, rebuildTextNodes, tagPattern, textNodes, xmlDecode, xmlEncode } from './portable-xml.mjs';
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
  mergeWordRunFonts,
  replaceDocxTable,
  missingDocxCellError,
  missingDocxRowError,
  replaceWordProperties,
  rowCellMatches,
  tableRowMatches,
  wordJustification,
  wordTableProperties,
  wordTextContent,
  wordTextElement,
  withFirstRunText,
} from './portable-docx-xml.mjs';
import { docxRevisionTree, flattenDocxRevisions } from './docx-revisions.mjs';
import { settleDocxStory } from './docx-runs.mjs';
import { patchParagraphFormat, patchWordStyle } from './docx-formatting.mjs';
import { documentStyleId } from './portable-docx-styles.mjs';
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

// The paragraph mark's own revision id sits clear of the ids the paragraph's
// runs take.
const PARAGRAPH_MARK_ID_OFFSET = 900;

// A deleted paragraph mark lives in the paragraph's own run properties: the
// mark joins an existing <w:rPr>, else opens one under <w:pPr>, else opens a
// <w:pPr> at the head of the paragraph. Inside <w:rPr> the schema puts an
// insertion before a deletion, so a mark another reviewer inserted keeps its
// place ahead of the deletion that rejects it.
function withParagraphMarkRevision(paragraphXml, mark) {
  if (!/<w:pPr(?:\s[^>]*)?>/.test(paragraphXml)) {
    return paragraphXml.replace(/^(<w:p(?:\s[^>]*)?>)/, (__m, __1) => `${__1}<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`);
  }
  if (/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>\s*<\/w:pPr>/.test(paragraphXml)) {
    return paragraphXml.replace(
      /(<w:rPr(?:\s[^>]*)?>)((?:<w:ins\b[^>]*\/>|<w:ins\b[^>]*>[\s\S]*?<\/w:ins>)?)/,
      (__m, __1, __2) => `${__1}${__2}${mark}`
    );
  }
  return paragraphXml.replace(/<\/w:pPr>/, () => `<w:rPr>${mark}</w:rPr></w:pPr>`);
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

// An entry carries its page after a tab once a render has measured it (numberDocxTableOfContents); the tab stop
// on the paragraph sets it on the right margin behind a dot leader, the way Word draws its own contents.
export function docxTocCacheRuns(entries, lower) {
  if (!entries.length) return '<w:r><w:t>Update this field in Word to build the table of contents.</w:t></w:r>';
  const pageRun = (entry) => (entry.page ? `<w:r><w:tab/></w:r><w:r><w:t>${Number(entry.page)}</w:t></w:r>` : '');
  return entries
    .map(
      (entry) =>
        `<w:r><w:t xml:space="preserve">${xmlEncode(`${'    '.repeat(entry.level - lower)}${entry.text}`)}</w:t></w:r>${pageRun(entry)}`
    )
    .join('<w:r><w:br/></w:r>');
}

const TOC_FIELD = /<w:fldSimple\b([^>]*\bw:instr="([^"]*TOC[^"]*)"[^>]*)>([\s\S]*?)<\/w:fldSimple>/g;

// The pages a cache already shows, by entry text: a save rebuilds the entries from the headings, and a heading
// that did not change keeps the page its last render measured.
function cachedTocPages(cache) {
  const pages = new Map();
  for (const line of String(cache).split(/<w:r><w:br\/><\/w:r>/)) {
    const texts = [...line.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => xmlDecode(match[1]));
    if (texts.length === 2 && /<w:tab\/>/.test(line) && /^\d+$/.test(texts[1]))
      pages.set(texts[0].trim(), Number(texts[1]));
  }
  return pages;
}

// The heading levels a contents field lists, by its \o switch (1-3 when it names none).
function tocFieldLevels(instruction) {
  const range = /\\o\s*(?:"|&quot;)(\d+)-(\d+)(?:"|&quot;)/.exec(instruction);
  const lower = Math.max(1, Number(range?.[1]) || 1);
  return { lower, upper: Math.max(lower, Number(range?.[2]) || 3) };
}

function rebuildTableOfContents(current, headingLevels, pageFor) {
  return current.replace(TOC_FIELD, (_whole, attributes, instruction, cache) => {
    const { lower, upper } = tocFieldLevels(instruction);
    const carried = cachedTocPages(cache);
    const entries = docxTocEntries(current, lower, upper, headingLevels).map((entry, index) => ({
      ...entry,
      page: pageFor ? pageFor(entry, index) : carried.get(entry.text),
    }));
    return `<w:fldSimple${attributes}>${docxTocCacheRuns(entries, lower)}</w:fldSimple>`;
  });
}

/** A table of contents is usually written before the sections it lists, so the
 *  cache captured at insert time would show an empty document forever. Every
 *  save rebuilds it from the body as it stands. */
export async function refreshDocxTableOfContents(zip) {
  const current = await zipText(zip, 'word/document.xml');
  if (!/<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC/.test(current)) return false;
  const next = rebuildTableOfContents(current, await docxHeadingLevels(zip));
  if (next === current) return false;
  zip.file('word/document.xml', next);
  return true;
}

/** The page every contents entry lands on, read from a rendered copy of the document: `pageTexts` is each page's
 *  text with the whitespace removed. The rendered text meets the headings in document order, and the contents list
 *  itself — each entry once more, on one page or across several — where the field stands; walked in that order, a
 *  heading is found past the list and past the heading before it. The walk takes the field's own levels: read as
 *  every level, a list of levels 1-2 in a document with level 3 headings was found on no page, and each entry was
 *  numbered with the contents page it is listed on. Returns whether the cache changed; the paragraph holding the
 *  field takes a right tab with a dot leader on the text edge so the numbers line up. */
export async function writeDocxTocPages(zip, pageTexts) {
  const current = await zipText(zip, 'word/document.xml');
  const field = /<w:fldSimple\b[^>]*\bw:instr="([^"]*TOC[^"]*)"/.exec(current);
  if (!field) return false;
  const headingLevels = await docxHeadingLevels(zip);
  const { lower, upper } = tocFieldLevels(field[1]);
  const squash = (value) => String(value).replace(/\s+/g, '');
  const entries = docxTocEntries(current, lower, upper, headingLevels);
  const above = docxTocEntries(current.slice(0, field.index), lower, upper, headingLevels).length;
  const text = pageTexts.join('');
  const pageStarts = [];
  for (let index = 0, offset = 0; index < pageTexts.length; offset += pageTexts[index].length, index += 1)
    pageStarts.push(offset);
  let cursor = 0;
  const pageOf = (entry) => {
    const needle = squash(entry.text);
    const at = needle ? text.indexOf(needle, cursor) : -1;
    if (at < 0) return undefined;
    cursor = at + needle.length;
    return pageStarts.findLastIndex((start) => start <= at) + 1;
  };
  const pages = entries.slice(0, above).map(pageOf);
  for (const entry of entries) pageOf(entry);
  pages.push(...entries.slice(above).map(pageOf));
  const pageFor = (_entry, index) => pages[index];
  let next = rebuildTableOfContents(current, headingLevels, pageFor);
  // The field's paragraph: a right tab at the text edge of its section, behind dots.
  next = next.replace(
    /<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC[\s\S]*?<\/w:p>/,
    (paragraph, offset) => {
      const section = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(next.slice(offset))?.[0] || '';
      const width = Number(/<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(section)?.[1]) || 11906;
      const left = Number(/<w:pgMar\b[^>]*\bw:left="(\d+)"/.exec(section)?.[1]) || 1440;
      const right = Number(/<w:pgMar\b[^>]*\bw:right="(\d+)"/.exec(section)?.[1]) || 1440;
      return patchParagraphFormat(paragraph, {
        tabStops: [{ position: (width - left - right) / 20, alignment: 'right', leader: 'dot' }],
      });
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

// The stories are the body, the headers, the footers, and the notes; the
// comments part carries no tracked text of its own.
const isStoryPart = (name) => !/\/comments\.xml$/i.test(name);

/** Word drops a comment together with the text it marked; after accepting a
 *  deletion that carried the whole anchor, the comment has no reference left
 *  in any story and is removed with its thread, id map, and timestamp. */
async function pruneOrphanComments(zip, parts) {
  const comments = await zipText(zip, 'word/comments.xml');
  if (!comments) return 0;
  const stories = parts.filter(isStoryPart);
  const referenced = new Set();
  for (const part of stories) {
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
  for (const part of stories) {
    const xml = await zipText(zip, part);
    const stripped = removedIds.reduce(
      (value, id) =>
        value.replace(new RegExp(`<w:commentRange(?:Start|End)\\b[^>]*\\bw:id="${tagPattern(id)}"[^>]*\\/>`, 'g'), ''),
      xml
    );
    if (stripped !== xml) zip.file(part, stripped);
  }
  return removedIds.length;
}

// The mark goes at the end of the word the cited phrase ends in: a phrase ending inside a word ("가장 크게 성장" in
// "성장했습니다") set the mark mid-word, "성장¹했습니다". A phrase cut inside a word — its last character and the next
// one both letters or digits — runs on to the word's end, stopping at a space or a punctuation mark; one that ends
// on a sign ("92.8%" before "로") is a whole figure and keeps its mark there.
function wholeWordPhrase(text, find) {
  const at = text.indexOf(find);
  if (at < 0 || !/[\p{L}\p{N}]$/u.test(find)) return find;
  let end = at + find.length;
  while (end < text.length && /[\p{L}\p{N}]/u.test(text[end])) end += 1;
  return text.slice(at, end);
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
  // The note is set in the face of the text it cites: a paragraph whose runs name Noto Serif KR had its source line
  // printed in the document default, a second typeface at the page foot.
  const faces = /<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?(<w:rFonts\b[^>]*\/>)/.exec(paragraph.xml)?.[1] || '';
  const noteRun = faces ? `<w:rPr>${faces}</w:rPr>` : '';
  const entry =
    `<${definition.tag} w:id="${id}">` +
    `<w:p><w:pPr><w:pStyle w:val="${definition.textStyle}"/></w:pPr>` +
    `<w:r><w:rPr><w:rStyle w:val="${definition.style}"/>${faces}<w:vertAlign w:val="superscript"/></w:rPr>` +
    `<w:${definition.reference === 'w:footnoteReference' ? 'footnoteRef' : 'endnoteRef'}/></w:r>` +
    `<w:r>${noteRun}<w:t xml:space="preserve"> ${xmlEncode(text)}</w:t></w:r></w:p></${definition.tag}>`;
  zip.file(
    definition.part,
    definition.xml.replace(`</${definition.root}>`, () => `${entry}</${definition.root}>`)
  );
  // The mark belongs right after the phrase it cites; a phrase split across
  // a tab, field, or drawing falls back to the end of its paragraph.
  const mark =
    `<w:r><w:rPr><w:rStyle w:val="${definition.style}"/><w:vertAlign w:val="superscript"/></w:rPr>` +
    `<${definition.reference} w:id="${id}"/></w:r>`;
  const cited = find ? wholeWordPhrase(paragraphTexts(paragraph.xml, 'w:t').join(''), find) : '';
  const phrase = cited ? anchorPhraseInParagraph(paragraph.xml, cited, id, { start: '', end: mark }) : null;
  const anchored = phrase || paragraph.xml.replace(/<\/w:p>$/, () => `${mark}</w:p>`);
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

/** The document's own face and size: the default run properties, and the Normal style's where it names its own. A
 *  composed report set every paragraph's face and left these at Calibri 11 pt, so a paragraph added later — by
 *  append_text or by hand in Word — came out in another face and size than the body around it. */
export async function setDocxDocumentFont(zip, op) {
  const properties = op.properties || {};
  const font = {
    name: String(properties.name || '').trim(),
    nameEastAsia: String(properties.nameEastAsia || '').trim(),
    size: Number(properties.size) || 0,
    color: String(properties.color || '')
      .replace(/^#/, '')
      .trim(),
  };
  if (!font.name && !font.nameEastAsia && !(font.size > 0) && !font.color) {
    throw new Error('set_document_font needs properties.name, nameEastAsia, size, or color');
  }
  let styles = await zipText(zip, 'word/styles.xml');
  if (!styles) throw new Error('DOCX package has no styles part (word/styles.xml)');
  const defaults = /<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<\/w:rPr>\s*<\/w:rPrDefault>/.exec(styles);
  const defaultRun = `<w:rPrDefault><w:rPr>${mergeWordRunFonts(defaults?.[1] || '', font)}</w:rPr></w:rPrDefault>`;
  if (defaults) styles = styles.replace(defaults[0], () => defaultRun);
  else if (/<w:docDefaults>/.test(styles))
    styles = styles.replace('<w:docDefaults>', () => `<w:docDefaults>${defaultRun}`);
  else styles = styles.replace(/<w:styles\b[^>]*>/, (open) => `${open}<w:docDefaults>${defaultRun}</w:docDefaults>`);
  // A Normal style that names its own face or size outranks the defaults; it takes the same values. Normal is the
  // default paragraph style — Korean Word writes it as styleId "a", so it is found by w:default, not by its id — and
  // it is cut out first, so a Normal without run properties never reaches into the style after it.
  styles = styles.replace(
    /<w:style\b(?=[^>]*\bw:type="paragraph")(?=[^>]*\bw:default="1")[^>]*>[\s\S]*?<\/w:style>/,
    (normal) =>
      normal.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/, (whole, inner) =>
        /<w:(rFonts|sz)\b/.test(inner) ? `<w:rPr>${mergeWordRunFonts(inner, font)}</w:rPr>` : whole
      )
  );
  zip.file('word/styles.xml', styles);
  return { op: op.op, changed: true, ...font };
}

// The fields one style takes in define_styles: its face, size, weight, ink, and its paragraph's flow.
const DOCX_STYLE_FIELDS = Object.freeze([
  'name',
  'nameEastAsia',
  'size',
  'bold',
  'italic',
  'color',
  'alignment',
  'spacingBefore',
  'spacingAfter',
  'lineSpacing',
  'lineSpacingRule',
  'keepWithNext',
  'keepTogether',
]);

/** The fields of every style asked for, checked before anything is written; one message lists every fault. */
export function docxStyleDefinitions(op) {
  const styles = op.styles;
  if (!styles || typeof styles !== 'object' || Array.isArray(styles) || !Object.keys(styles).length) {
    throw new Error(
      `define_styles needs styles: { "<style name>": { ${DOCX_STYLE_FIELDS.join(', ')} } }, e.g. { "Heading 1": { size: 15, bold: true } }`
    );
  }
  const faults = [];
  for (const [style, fields] of Object.entries(styles)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      faults.push(`${style}: needs an object of fields`);
      continue;
    }
    const unknown = Object.keys(fields).filter((field) => !DOCX_STYLE_FIELDS.includes(field));
    if (unknown.length) faults.push(`${style}: unknown fields ${unknown.join(', ')}`);
  }
  if (faults.length) throw new Error(`define_styles: ${faults.join('; ')}. Fields: ${DOCX_STYLE_FIELDS.join(', ')}.`);
  return Object.entries(styles);
}

/** Word's own styles defined once — the title, headings, body, caption a report is set in — so every paragraph that
 *  names the style takes them, and a paragraph the reader adds in Word under that style matches the rest. Set
 *  paragraph by paragraph instead, a heading added later came out in Word's blue Calibri. */
export async function defineDocxStyles(zip, op) {
  const definitions = docxStyleDefinitions(op);
  const defined = [];
  const notFound = [];
  for (const [requested, fields] of definitions) {
    const resolved = await documentStyleId(zip, requested);
    if (!resolved.found) {
      notFound.push(requested);
      continue;
    }
    const styles = await zipText(zip, 'word/styles.xml');
    const id = resolved.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<w:style\\b(?=[^>]*\\bw:styleId="${id}")[^>]*>[\\s\\S]*?<\\/w:style>`);
    const style = pattern.exec(styles)?.[0];
    if (!style) {
      notFound.push(requested);
      continue;
    }
    zip.file(
      'word/styles.xml',
      styles.replace(style, () => patchWordStyle(style, fields))
    );
    defined.push(requested);
  }
  return {
    op: op.op,
    changed: defined.length > 0,
    styles: defined,
    ...(notFound.length ? { styleNotFound: notFound } : {}),
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
  // pageSize arrives resolved to points (pageWidth, pageHeight) by the batch.
  const width = Number(properties.pageWidth);
  const height = Number(properties.pageHeight);
  const sized = properties.pageWidth != null || properties.pageHeight != null;
  if (sized && !(width > 0 && height > 0)) {
    throw new Error("set_page pageSize must be a named size ('a4', 'letter', ...) or [width, height] in points");
  }
  const size = sized ? [Math.round(width * 20), Math.round(height * 20)] : null;
  return { orientation, columnCount, columnSpacing, size };
}

// One section's page size, margins and (when asked) column layout, each
// half of a pair the caller left out keeping what the section already said.
// The sheet is named by pageSize and turned by orientation — or kept the way
// the section already lies when no orientation is asked for.
function sectionWithPage(section, properties, { orientation, columnCount, columnSpacing, size }) {
  const current = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
  let pageWidth = Number(/\bw:w="(\d+)"/.exec(current)?.[1]) || A4_WIDTH_TWIPS;
  let pageHeight = Number(/\bw:h="(\d+)"/.exec(current)?.[1]) || A4_HEIGHT_TWIPS;
  const landscape = orientation ? orientation === 'landscape' : pageWidth > pageHeight;
  if (size) [pageWidth, pageHeight] = size;
  if (landscape ? pageWidth < pageHeight : pageWidth > pageHeight) {
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
    `<w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"${landscape ? ' w:orient="landscape"' : ''}/>`
  );
  const withMargins = upsertSectionChild(
    withSize,
    'pgMar',
    `<w:pgMar w:top="${margin('top', 'topMargin', 1418)}" w:right="${margin('right', 'rightMargin', 1418)}"` +
      ` w:bottom="${margin('bottom', 'bottomMargin', 1418)}" w:left="${margin('left', 'leftMargin', 1418)}"` +
      ` w:header="${margin('header', 'headerMargin', 709)}" w:footer="${margin('footer', 'footerMargin', 709)}" w:gutter="0"/>`
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
    `<w:cols${count > 1 ? ` w:num="${count}" w:equalWidth="1"` : ''} w:space="${space}"/>`
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
// border, shading, margins and alignment properties are kept. The margins are the gutter a column of words takes
// after a column of figures and a layout grid's flush edges: dropped here, every preset table lost its gutter to the
// fit that follows it ("+45%" ran into "11월") while Word kept it.
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
          keep(/<w:tcMar>[\s\S]*?<\/w:tcMar>/) +
          keep(/<w:vAlign\b[^>]*\/>/)
      );
    });
  });
}

/** Rebalances a table across the text column, keeping each column's share and every cell's own properties. */
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
        () => `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`
      )
    : table[0];
  const declared = `<w:tblW w:w="${usable}" w:type="dxa"/>`;
  let tableProperties = op.properties
    ? wordTableProperties(op.properties)
    : /<w:tblPr>([\s\S]*?)<\/w:tblPr>/.exec(nextTable)?.[1] || '';
  if (/<w:tblW\b[^>]*\/>/.test(tableProperties)) {
    tableProperties = tableProperties.replace(/<w:tblW\b[^>]*\/>/, () => declared);
  } else if (/<w:tblStyle\b[^>]*\/>/.test(tableProperties)) {
    tableProperties = tableProperties.replace(/(<w:tblStyle\b[^>]*\/>)/, (__m, __1) => `${__1}${declared}`);
  } else {
    tableProperties = `${declared}${tableProperties}`;
  }
  nextTable = fitTableCells(replaceWordProperties(nextTable, 'tbl', 'tblPr', tableProperties), widths);
  current = replaceDocxTable(current, table, nextTable);
  zip.file('word/document.xml', current);
  return { op: op.op, changed: true, table: Number(op.table), width: usable, columns: count };
}

// One run carries the value, the rest are dropped: a control filled across
// its old runs keeps fragments of the placeholder it replaced. A placeholder
// control shows grey prompt text until the flag goes.
function controlFilledWith(control, contentInner, text) {
  const first = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/.exec(contentInner);
  const runProperties = first ? /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/.exec(first[0])?.[0] || '' : '';
  const run = `<w:r>${runProperties}${wordTextElement(text)}</w:r>`;
  const [firstParagraph] = contentInner.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/) || [];
  const paragraph = firstParagraph
    ? `${/^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(firstParagraph)?.[0] || '<w:p>'}${run}</w:p>`
    : run;
  const cleaned = control.replace(/<w:showingPlcHdr\b[^>]*\/>/g, '');
  return cleaned.replace(
    /<w:sdtContent\b[^>]*>[\s\S]*?<\/w:sdtContent>/,
    () => `<w:sdtContent>${paragraph}</w:sdtContent>`
  );
}

/** Fills one named or numbered content control, in the body, a header, or a footer. */
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
    const run = `<w:r>${wordTextContent(op.text, { preserve: true })}</w:r>`;
    if (/<\/w:p>\s*$/.test(paragraph.xml)) return paragraph.xml.replace(/<\/w:p>\s*$/, () => `${run}</w:p>`);
    if (/\/>\s*$/.test(paragraph.xml)) return paragraph.xml.replace(/\/>\s*$/, () => `>${run}</w:p>`);
    throw new Error(`DOCX paragraph ${op.paragraph} is malformed`);
  }
  if (op.op === 'set_run_text') {
    const run = nodes[Number(op.run) - 1];
    if (!run) throw new Error(`DOCX run ${op.run} not found in paragraph ${op.paragraph}`);
    run.text = String(op.text ?? '');
    return rebuildTextNodes(paragraph.xml, 'w:t', nodes);
  }
  return withFirstRunText(paragraph.xml, op.text);
}

/** Rewrites, removes, or moves one body paragraph, tracked when the document tracks. */
export async function editDocxParagraph(zip, op, tracking) {
  let current = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(current);
  const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
  let nextInner = model.body.inner;
  let between = false;
  const splice = (replacement) =>
    `${nextInner.slice(0, paragraph.start)}${replacement}${nextInner.slice(paragraph.end)}`;
  if (op.op === 'remove_paragraph' && tracking) {
    const id = nextRevisionId(current);
    const marked = markRunsDeleted(paragraph.xml, id, op.author);
    const mark = `<w:del ${revisionAttributes(id + PARAGRAPH_MARK_ID_OFFSET, op.author)}/>`;
    nextInner = splice(withParagraphMarkRevision(marked, mark));
  } else if (op.op === 'remove_paragraph') {
    // The only paragraph between two tables is what keeps them two: removed, Word and LibreOffice read one table
    // with the second one's rows under the first. Its words go and an empty paragraph stays.
    between =
      /<\/w:tbl>\s*$/.test(nextInner.slice(0, paragraph.start)) &&
      /^\s*<w:tbl[\s>]/.test(nextInner.slice(paragraph.end));
    nextInner = splice(between ? '<w:p/>' : '');
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
    ...(between ? { keptBetweenTables: true } : {}),
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
  // bold:false and italic:false switch the weight off, as the Word backend's Font.Bold = 0 does: a data row inserted
  // before a total copies the total's bold, and asking for it back to regular changed nothing here.
  const toggled = (tag, value) => {
    if (value === undefined) return '';
    return value ? `<w:${tag}/><w:${tag}Cs/>` : `<w:${tag} w:val="0"/><w:${tag}Cs w:val="0"/>`;
  };
  const runFormat = [
    cellFont || cellEastAsia ? `<w:rFonts${latinFontAttrs}${eastAsiaFontAttrs}/>` : '',
    toggled('b', op.properties?.bold),
    toggled('i', op.properties?.italic),
    op.properties?.color ? `<w:color w:val="${xmlEncode(String(op.properties.color).replace(/^#/, ''))}"/>` : '',
    Number.isFinite(cellSize) && cellSize > 0
      ? `<w:sz w:val="${Math.round(cellSize * 2)}"/><w:szCs w:val="${Math.round(cellSize * 2)}"/>`
      : '',
  ].join('');
  nextCell = applyWordRunFormat(nextCell, runFormat);
  // The cell's line pitch follows its new size (the table convention, 1.3× the size): a 9 pt label row
  // under a 22 pt value row otherwise keeps the value row's 29 pt lines and floats the labels, and a
  // larger size under the exact pitch would be clipped.
  if (Number.isFinite(cellSize) && cellSize > 0) {
    nextCell = nextCell.replace(
      /(<w:spacing\b[^>]*\bw:line=")(\d+)("[^>]*\bw:lineRule="(?:atLeast|exact)")/g,
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

// A merged cell keeps what it carried (its shading, its borders, the bottom alignment a header row sits on, as Word
// keeps them) and takes the spans; its width becomes the widths it joins. The whole tcPr used to be replaced, and a
// two-level header's merged labels rose to the top of their cells on this backend only. Children stay in schema
// order: cnfStyle, tcW, gridSpan, vMerge, then the rest.
function mergedCellXml(joined, spans) {
  const existing = /<w:tcPr(?:\s[^>]*)?>([\s\S]*?)<\/w:tcPr>/.exec(joined[0])?.[1] || '';
  const kept = existing.replace(/<w:(tcW|gridSpan|hMerge|vMerge)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g, '');
  const conditional = /<w:cnfStyle\b[^>]*?(?:\/>|>[\s\S]*?<\/w:cnfStyle>)/.exec(kept)?.[0] || '';
  const rest = conditional ? kept.replace(conditional, '') : kept;
  const widths = joined.map((xml) => /<w:tcW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa"/.exec(xml)?.[1]);
  const width = widths.every(Boolean)
    ? `<w:tcW w:w="${widths.reduce((sum, value) => sum + Number(value), 0)}" w:type="dxa"/>`
    : '';
  return replaceWordProperties(joined[0], 'tc', 'tcPr', `${conditional}${width}${spans}${rest}`);
}

// Merges the located cell across colSpan columns (dropping the absorbed
// cells) and rowSpan rows (continuation cells become vMerge, spanning the same columns: a block merge left the
// continuation rows' absorbed cells in place, one grid column too many a cell).
function mergedDocxTable({ table, rows, row, cells }, op) {
  const colSpan = Math.max(1, Number(op.colSpan) || 1);
  const rowSpan = Math.max(1, Number(op.rowSpan) || 1);
  const gridSpan = colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : '';
  const first = Number(op.col) - 1;
  // By position: two cells of one row can read the same (empty, equally wide), and replacing by text took the first.
  const mergeRow = (rowXml, rowCells, spans) => {
    const joined = rowCells.slice(first, first + colSpan);
    const end = joined.at(-1).index + joined.at(-1)[0].length;
    const merged = mergedCellXml(
      joined.map((entry) => entry[0]),
      spans
    );
    return `${rowXml.slice(0, joined[0].index)}${merged}${rowXml.slice(end)}`;
  };
  let nextTable = table[0].replace(row[0], () =>
    mergeRow(row[0], cells, `${gridSpan}${rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ''}`)
  );
  if (rowSpan > 1) {
    for (let rowIndex = Number(op.row); rowIndex < Number(op.row) + rowSpan - 1; rowIndex += 1) {
      const continuationRow = rows[rowIndex];
      if (!continuationRow) break;
      const continuationCells = rowCellMatches(continuationRow[0]);
      if (!continuationCells[first]) continue;
      nextTable = nextTable.replace(continuationRow[0], () =>
        mergeRow(continuationRow[0], continuationCells, `${gridSpan}<w:vMerge/>`)
      );
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
  if (!row) throw missingDocxRowError(op, table[0]);
  const cells = rowCellMatches(row[0]);
  const cell = cells[Number(op.col) - 1];
  if (!cell) throw missingDocxCellError(op, cells);
  const nextTable =
    op.op === 'set_table_cell_style'
      ? table[0].replace(cell[0], () => styledDocxCell(cell[0], op))
      : mergedDocxTable({ table, rows, row, cells }, op);
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
  const stories = parts.filter(isStoryPart).sort();
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
