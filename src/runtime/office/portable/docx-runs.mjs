import { renderedWordText, resolveDocxPropertyChanges, resolveDocxRevisions, revisionOwner } from './docx-revisions.mjs';
import { docxBodyModel } from './portable-snapshot.mjs';
import { containerInner, xmlEncode } from './portable-xml.mjs';

const RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const RUN_OPEN = /^<w:r(?:\s[^>]*)?>/;
const RUN_PROPERTIES = /^\s*(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\/>)/;
const EMPTY_RUN_PROPERTIES = /^\s*(?:<w:rPr\/>|<w:rPr>\s*<\/w:rPr>)?\s*$/;

function consolidateText(content, tag) {
  const pair = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>\\s*<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`);
  let result = content;
  let merged = 0;
  for (;;) {
    const match = pair.exec(result);
    if (!match) return { content: result, merged };
    const text = `${renderedWordText(match[1], match[2])}${renderedWordText(match[3], match[4])}`;
    const preserve = /^[ \t\r\n]|[ \t\r\n]$/.test(text)
      || /\bxml:space="preserve"/.test(match[1])
      || /\bxml:space="preserve"/.test(match[3]);
    result = `${result.slice(0, match.index)}<${tag}${preserve ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</${tag}>${result.slice(match.index + match[0].length)}`;
    merged += 1;
  }
}

/** Word fragments a paragraph into many runs (revision ids, proofing marks,
 *  editing history), so a phrase visible on the page often does not exist as
 *  one string in the XML. This coalesces adjacent runs whose formatting is
 *  identical, drops proofing markers and rsid attributes, and joins the text
 *  elements of each merged run. Rendering is unchanged; runs in different
 *  tracked-change wrappers are never merged because an element sits between
 *  them. */
export function normalizeDocxRuns(xml) {
  let proofErrRemoved = 0;
  let rsidStripped = 0;
  let working = String(xml || '').replace(/<w:proofErr\b[^>]*\/>/g, () => {
    proofErrRemoved += 1;
    return '';
  });
  working = working.replace(/<w:r(\s[^>]*)?>/g, (_, attrs = '') => {
    const stripped = attrs.replace(/\s+w:rsid\w*="[^"]*"/g, () => {
      rsidStripped += 1;
      return '';
    }).trim();
    return `<w:r${stripped ? ` ${stripped}` : ''}>`;
  });
  const output = [];
  let cursor = 0;
  let merged = 0;
  let textMerged = 0;
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const texts = consolidateText(pending.content, 'w:t');
    const deleted = consolidateText(texts.content, 'w:delText');
    textMerged += texts.merged + deleted.merged;
    output.push(`${pending.open}${pending.properties}${deleted.content}</w:r>`);
    pending = null;
  };
  const runs = new RegExp(RUN.source, 'g');
  let match;
  while ((match = runs.exec(working))) {
    const between = working.slice(cursor, match.index);
    const open = RUN_OPEN.exec(match[0])[0];
    const inner = match[0].slice(open.length, match[0].length - '</w:r>'.length);
    const rawProperties = RUN_PROPERTIES.exec(inner)?.[0] || '';
    const properties = EMPTY_RUN_PROPERTIES.test(rawProperties) ? '' : rawProperties.trim();
    const content = inner.slice(rawProperties.length);
    if (pending && !between.trim() && pending.properties === properties) {
      pending.content += content;
      merged += 1;
    } else {
      flush();
      output.push(between);
      pending = { open, properties, content };
    }
    cursor = runs.lastIndex;
  }
  flush();
  output.push(working.slice(cursor));
  return { xml: output.join(''), merged, textMerged, proofErrRemoved, rsidStripped };
}

/** The self-closing paragraph-mark or row marker of one kind, optionally
 *  pinned to one reviewer. */
function marker(tag, author = '') {
  return new RegExp(`<w:${tag}\\b${revisionOwner(author)}[^>]*\\/>`);
}

function paragraphParts(paragraphXml) {
  const inner = containerInner(paragraphXml, 'w:p');
  if (!inner) return { open: '<w:p>', properties: '', content: '', empty: true };
  const properties = /^\s*<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/.exec(inner.inner)?.[0] || '';
  return {
    open: paragraphXml.slice(0, inner.start),
    properties,
    content: inner.inner.slice(properties.length),
    empty: false,
  };
}

function markedParagraph(properties, tag, author = '') {
  const mark = /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/.exec(properties)?.[0] || '';
  return marker(tag, author).test(mark);
}

function clearedParagraph(paragraphXml, tag, author = '') {
  const parts = paragraphParts(paragraphXml);
  if (parts.empty) return paragraphXml;
  const properties = parts.properties.replace(
    /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/,
    (block) => block.replace(marker(tag, author), ''),
  );
  return `${parts.open}${properties}${parts.content}</w:p>`;
}

/** Every `<tag>` element of a part with depth-aware extents, in document
 *  order; a nested element is listed after the one that holds it. */
function elementExtents(xml, tag) {
  const opener = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  const found = [];
  let match;
  while ((match = opener.exec(xml))) {
    const inner = containerInner(xml, tag, match.index);
    if (!inner) continue;
    found.push({ start: match.index, innerStart: inner.start, innerEnd: inner.end, end: inner.end + `</${tag}>`.length });
  }
  return found;
}

function leftoverMarks(author = '') {
  return new RegExp(`(<w:rPr(?:\\s[^>]*)?>(?:(?!<\\/w:rPr>)[\\s\\S])*?)<w:(ins|del)\\b${revisionOwner(author)}[^>]*\\/>`, 'g');
}

/** Resolves paragraph-mark revisions the way Word does. A deleted mark that
 *  is accepted (or an inserted mark that is rejected) joins its paragraph to
 *  the next one, which keeps its own paragraph properties, so a paragraph
 *  whose runs were all deleted vanishes instead of surviving as an empty
 *  bullet. The other marker is simply cleared. A mark whose next block is a
 *  table, or that ends the body, is cleared and reported as unmerged. Table
 *  cells are resolved as small bodies of their own. Runs, wrappers, and
 *  contents must already be resolved. With `author` only that reviewer's
 *  marks are settled; the others stay tracked. */
export function resolveDocxParagraphMarks(documentXml, { resolution = 'accept', author = '' } = {}) {
  const clearTag = resolution === 'accept' ? 'ins' : 'del';
  const leftover = leftoverMarks(author);
  const body = resolveMarksInBody(String(documentXml || ''), resolution, author);
  let { xml, merged, cleared, unmerged } = body;
  // Each cell without a nested table is a paragraph sequence like the body;
  // the last cell goes first so earlier offsets stay valid.
  const cells = elementExtents(xml, 'w:tc')
    .filter((cell) => !/<w:tbl\b/.test(xml.slice(cell.innerStart, cell.innerEnd)))
    .reverse();
  for (const cell of cells) {
    const inner = xml.slice(cell.innerStart, cell.innerEnd);
    if (!new RegExp(leftover.source).test(inner)) continue;
    const resolved = resolveMarksInBody(`<w:body>${inner}</w:body>`, resolution, author);
    merged += resolved.merged;
    cleared += resolved.cleared;
    unmerged += resolved.unmerged;
    const next = containerInner(resolved.xml, 'w:body')?.inner ?? inner;
    xml = `${xml.slice(0, cell.innerStart)}${next}${xml.slice(cell.innerEnd)}`;
  }
  // A mark that survived (a cell inside a nested table) is cleared so Word
  // shows no revision; a merge it implied is reported as unmerged.
  xml = xml.replace(leftover, (_, head, tag) => {
    if (tag === clearTag) cleared += 1;
    else unmerged += 1;
    return head;
  });
  return { xml, merged, cleared, unmerged };
}

/** Tracked table rows: a deleted row that is accepted (or an inserted row
 *  that is rejected) disappears; the other marker is cleared. A row holding
 *  a nested table keeps its content and only loses the marker. */
export function resolveDocxRowMarks(documentXml, { resolution = 'accept', author = '' } = {}) {
  const removeTag = resolution === 'accept' ? 'del' : 'ins';
  let xml = String(documentXml || '');
  let removed = 0;
  let cleared = 0;
  for (const row of elementExtents(xml, 'w:tr').reverse()) {
    const rowXml = xml.slice(row.start, row.end);
    if (/<w:tbl\b/.test(rowXml)) continue;
    const properties = /^<w:tr(?:\s[^>]*)?>\s*(?:<w:tblPrEx(?:\s[^>]*)?>[\s\S]*?<\/w:tblPrEx>\s*)?(<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>)/.exec(rowXml)?.[1] || '';
    if (!properties) continue;
    const marks = { del: marker('del', author).test(properties), ins: marker('ins', author).test(properties) };
    if (!marks.del && !marks.ins) continue;
    if (marks[removeTag]) {
      xml = `${xml.slice(0, row.start)}${xml.slice(row.end)}`;
      removed += 1;
      continue;
    }
    const clearedProperties = properties.replace(marker('del', author), '').replace(marker('ins', author), '');
    xml = `${xml.slice(0, row.start)}${rowXml.replace(properties, clearedProperties)}${xml.slice(row.end)}`;
    cleared += 1;
  }
  xml = xml.replace(new RegExp(`(<w:trPr(?:\\s[^>]*)?>(?:(?!<\\/w:trPr>)[\\s\\S])*?)<w:(?:ins|del)\\b${revisionOwner(author)}[^>]*\\/>`, 'g'), (_, head) => {
    cleared += 1;
    return head;
  });
  return { xml, removed, cleared };
}

function resolveMarksInBody(documentXml, resolution, author = '') {
  const mergeTag = resolution === 'accept' ? 'del' : 'ins';
  const clearTag = resolution === 'accept' ? 'ins' : 'del';
  let xml = String(documentXml || '');
  let merged = 0;
  let cleared = 0;
  let unmerged = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const model = docxBodyModel(xml);
    if (!model.body) break;
    let replacement = null;
    for (let index = 0; index < model.blocks.length; index += 1) {
      const block = model.blocks[index];
      if (block.name !== 'w:p') continue;
      const { properties } = paragraphParts(block.xml);
      if (markedParagraph(properties, clearTag, author)) {
        replacement = { start: block.start, end: block.end, xml: clearedParagraph(block.xml, clearTag, author) };
        cleared += 1;
        break;
      }
      if (!markedParagraph(properties, mergeTag, author)) continue;
      const next = model.blocks[index + 1];
      if (!next || next.name !== 'w:p') {
        replacement = { start: block.start, end: block.end, xml: clearedParagraph(block.xml, mergeTag, author) };
        unmerged += 1;
        break;
      }
      const first = paragraphParts(block.xml);
      const second = paragraphParts(next.xml);
      replacement = {
        start: block.start,
        end: next.end,
        xml: `${second.open}${second.properties}${first.content}${second.content}</w:p>`,
      };
      merged += 1;
      break;
    }
    if (!replacement) break;
    const inner = `${model.body.inner.slice(0, replacement.start)}${replacement.xml}${model.body.inner.slice(replacement.end)}`;
    xml = `${xml.slice(0, model.body.start)}${inner}${xml.slice(model.body.end)}`;
  }
  return { xml, merged, cleared, unmerged };
}

/** Paragraph marks outside the main document part. A header or footer is
 *  one paragraph sequence like the body; each footnote or endnote is a
 *  sequence of its own, so a mark never joins a note to the next note. */
function resolveStoryParagraphMarks(xml, options) {
  if (/<w:body\b/.test(xml)) return resolveDocxParagraphMarks(xml, options);
  const root = /<w:(hdr|ftr|footnotes|endnotes)\b/.exec(xml)?.[1];
  if (!root) return { xml, merged: 0, cleared: 0, unmerged: 0 };
  const tag = { hdr: 'w:hdr', ftr: 'w:ftr', footnotes: 'w:footnote', endnotes: 'w:endnote' }[root];
  let output = xml;
  const totals = { merged: 0, cleared: 0, unmerged: 0 };
  for (const extent of elementExtents(output, tag).reverse()) {
    const inner = output.slice(extent.innerStart, extent.innerEnd);
    const resolved = resolveDocxParagraphMarks(`<w:body>${inner}</w:body>`, options);
    totals.merged += resolved.merged;
    totals.cleared += resolved.cleared;
    totals.unmerged += resolved.unmerged;
    const next = containerInner(resolved.xml, 'w:body')?.inner ?? inner;
    output = `${output.slice(0, extent.innerStart)}${next}${output.slice(extent.innerEnd)}`;
  }
  return { xml: output, ...totals };
}

/** Settles the tracked changes of one story part (document body, header,
 *  footer, footnotes, endnotes): wrappers first, then paragraph marks, table
 *  rows, and formatting records. A single revision (ordinal or id) settles
 *  its wrapper alone, since marks and records carry no ordinal; `author`
 *  limits every stage to one reviewer. */
export function settleDocxStory(xml, { resolution = 'accept', target = 0, id = '', author = '' } = {}) {
  const wrappers = resolveDocxRevisions(xml, { resolution, target, id, author });
  const counts = { resolved: wrappers.resolved, merged: 0, cleared: 0, unmerged: 0, rowsRemoved: 0, rowsCleared: 0, propertyChanges: 0 };
  if (target || id) return { xml: wrappers.xml, ...counts };
  const marks = resolveStoryParagraphMarks(wrappers.xml, { resolution, author });
  const rows = resolveDocxRowMarks(marks.xml, { resolution, author });
  const properties = resolveDocxPropertyChanges(rows.xml, { resolution, author });
  return {
    xml: properties.xml,
    ...counts,
    merged: marks.merged,
    cleared: marks.cleared,
    unmerged: marks.unmerged,
    rowsRemoved: rows.removed,
    rowsCleared: rows.cleared,
    propertyChanges: properties.changes,
  };
}
