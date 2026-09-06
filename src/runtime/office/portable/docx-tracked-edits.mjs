import { markRunsDeleted, revisionAttributes } from './portable-docx-parts.mjs';
import { textNodes, xmlEncode } from './portable-xml.mjs';

const RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const RUN_OPEN = /^<w:r(?:\s[^>]*)?>/;
const RUN_PROPERTIES = /^\s*(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\/>)/;
const TEXT_ONLY_CONTENT = /^(?:\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)*$/;

/** Rewrites a paragraph's text as one tracked change: every existing run is
 *  marked deleted and one inserted run, wearing the first run's formatting,
 *  carries the new text. Revision ids run from `id` through `id + runCount`. */
export function trackedParagraphRewrite(paragraphXml, text, id, author) {
  const runCount = (paragraphXml.match(/<w:r(?:\s[^>]*)?>/g) || []).length;
  const properties = /<w:r(?:\s[^>]*)?>\s*(<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>)/.exec(paragraphXml)?.[1] || '';
  const deleted = markRunsDeleted(paragraphXml, id, author);
  const inserted = `<w:ins ${revisionAttributes(id + runCount, author)}><w:r>${properties}`
    + `<w:t xml:space="preserve">${xmlEncode(text)}</w:t></w:r></w:ins>`;
  if (/<\/w:p>\s*$/.test(deleted)) return deleted.replace(/<\/w:p>\s*$/, `${inserted}</w:p>`);
  if (/\/>\s*$/.test(deleted)) return deleted.replace(/\/>\s*$/, `>${inserted}</w:p>`);
  throw new Error('DOCX paragraph is malformed');
}

function paragraphRuns(paragraphXml) {
  const runs = [];
  const pattern = new RegExp(RUN.source, 'g');
  let match;
  while ((match = pattern.exec(paragraphXml))) {
    const open = RUN_OPEN.exec(match[0])[0];
    const inner = match[0].slice(open.length, match[0].length - '</w:r>'.length);
    const properties = RUN_PROPERTIES.exec(inner)?.[0] || '';
    const content = inner.slice(properties.length);
    // Only a run made of text elements can be cut at a character offset; a
    // run carrying a tab, a break, a field, or a drawing is left whole and
    // its text is not searched.
    const textOnly = TEXT_ONLY_CONTENT.test(content);
    runs.push({
      start: match.index,
      end: pattern.lastIndex,
      xml: match[0],
      open,
      properties,
      text: textOnly ? textNodes(content, 'w:t').map((node) => node.text).join('') : '',
      textOnly,
    });
  }
  return runs;
}

function textRun(run, text) {
  return `${run.open}${run.properties}<w:t xml:space="preserve">${xmlEncode(text)}</w:t></w:r>`;
}

/** Places comment range markers around exactly `find` inside a paragraph,
 *  cutting the runs it starts and ends in so Word highlights the phrase and
 *  not the whole paragraph. Returns null when the phrase is absent or one of
 *  its boundary runs cannot be cut (a tab, break, field, or drawing run);
 *  the caller then anchors the paragraph. */
export function anchorPhraseInParagraph(paragraphXml, find, id) {
  const runs = paragraphRuns(paragraphXml);
  const joined = runs.map((run) => run.text).join('');
  const start = find ? joined.indexOf(find) : -1;
  if (start < 0) return null;
  const end = start + find.length;
  const output = [];
  let sourceCursor = 0;
  let offset = 0;
  let opened = false;
  let closed = false;
  for (const run of runs) {
    output.push(paragraphXml.slice(sourceCursor, run.start));
    sourceCursor = run.end;
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    const holdsStart = !opened && start >= runStart && start < runEnd;
    const holdsEnd = !closed && end > runStart && end <= runEnd;
    if (!holdsStart && !holdsEnd) {
      output.push(run.xml);
      continue;
    }
    if (!run.textOnly) return null;
    let position = runStart;
    if (holdsStart) {
      const before = run.text.slice(0, start - runStart);
      if (before) output.push(textRun(run, before));
      output.push(`<w:commentRangeStart w:id="${id}"/>`);
      opened = true;
      position = start;
    }
    if (holdsEnd) {
      const inside = run.text.slice(position - runStart, end - runStart);
      if (inside) output.push(textRun(run, inside));
      output.push(`<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`);
      closed = true;
      const after = run.text.slice(end - runStart);
      if (after) output.push(textRun(run, after));
    } else {
      const rest = run.text.slice(position - runStart);
      if (rest) output.push(textRun(run, rest));
    }
  }
  if (!opened || !closed) return null;
  output.push(paragraphXml.slice(sourceCursor));
  return output.join('');
}

/** Tracked find-and-replace at run granularity: only the matched characters
 *  are wrapped in `w:del` and the replacement follows them in `w:ins`, both
 *  wearing the formatting of the run they cut, so the rest of the paragraph
 *  keeps its runs untouched. Returns `count: 0` when no match lies entirely
 *  inside text-only runs. */
export function trackedParagraphReplace(paragraphXml, find, replacement, id, author) {
  if (!find) throw new Error('replace_text requires non-empty find');
  const runs = paragraphRuns(paragraphXml);
  const joined = runs.map((run) => run.text).join('');
  const intervals = [];
  let cursor = 0;
  while (cursor <= joined.length - find.length) {
    const index = joined.indexOf(find, cursor);
    if (index < 0) break;
    intervals.push({ start: index, end: index + find.length });
    cursor = index + find.length;
  }
  if (!intervals.length) return { xml: paragraphXml, count: 0, nextId: id };
  let nextId = id;
  const output = [];
  let sourceCursor = 0;
  let offset = 0;
  for (const run of runs) {
    output.push(paragraphXml.slice(sourceCursor, run.start));
    sourceCursor = run.end;
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    const overlapping = run.textOnly
      ? intervals.filter((interval) => interval.start < runEnd && interval.end > runStart)
      : [];
    if (!overlapping.length) {
      output.push(run.xml);
      continue;
    }
    let position = runStart;
    for (const interval of overlapping) {
      const from = Math.max(interval.start, runStart);
      const to = Math.min(interval.end, runEnd);
      const kept = run.text.slice(position - runStart, from - runStart);
      if (kept) output.push(textRun(run, kept));
      const deleted = run.text.slice(from - runStart, to - runStart);
      if (deleted) {
        output.push(`<w:del ${revisionAttributes(nextId, author)}>${run.open}${run.properties}`
          + `<w:delText xml:space="preserve">${xmlEncode(deleted)}</w:delText></w:r></w:del>`);
        nextId += 1;
      }
      if (interval.end <= runEnd && replacement) {
        output.push(`<w:ins ${revisionAttributes(nextId, author)}>${textRun(run, replacement)}</w:ins>`);
        nextId += 1;
      }
      position = to;
    }
    const tail = run.text.slice(position - runStart);
    if (tail) output.push(textRun(run, tail));
  }
  output.push(paragraphXml.slice(sourceCursor));
  return { xml: output.join(''), count: intervals.length, nextId };
}
