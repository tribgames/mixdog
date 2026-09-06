import { xmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';

const XML_EDGE_SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const EXCERPT_CHARS = 200;

/** Lookahead that pins a revision element to one reviewer. Word does not fix
 *  the attribute order, so the author is looked for anywhere in the tag; an
 *  apostrophe may be written raw or as an entity. Empty when every reviewer
 *  is meant. */
export function revisionOwner(author = '') {
  if (!author) return '';
  const encoded = xmlEncode(String(author))
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/&apos;/g, "(?:&apos;|')");
  return `(?=[^>]*\\bw:author="${encoded}")`;
}

/** The text Word draws for one `w:t` / `w:delText`: without
 *  `xml:space="preserve"` the edge whitespace never reaches the page. */
export function renderedWordText(attrs, raw) {
  const value = xmlDecode(raw);
  return /\bxml:space="preserve"/.test(String(attrs || '')) ? value : value.replace(XML_EDGE_SPACE, '');
}

function excerpt(text) {
  const value = String(text || '');
  return value.length > EXCERPT_CHARS ? `${value.slice(0, EXCERPT_CHARS)}…` : value;
}

/** Everything a tracked change carries, `w:t` and `w:delText` alike, so a
 *  deletion nested inside someone else's insertion leaves that insertion's
 *  identity (author, date, text) intact. */
function revisionText(fragment) {
  let text = '';
  for (const match of fragment.matchAll(/<w:(t|delText)\b([^>]*)>([\s\S]*?)<\/w:\1>/g)) {
    text += renderedWordText(match[2], match[3]);
  }
  return text;
}

/** Tracked-change wrappers of a WordprocessingML part as a tree with absolute
 *  offsets: `w:ins` / `w:del` and the move pair `w:moveTo` / `w:moveFrom`,
 *  which behave as an insertion and a deletion (`kind`). Self-closing
 *  `<w:ins/>` / `<w:del/>` are paragraph-mark markers inside `w:rPr`, not
 *  wrappers, and are skipped; an unclosed wrapper is dropped rather than
 *  guessed. */
export function docxRevisionTree(xml) {
  const source = String(xml || '');
  const roots = [];
  const stack = [];
  const tags = /<(\/?)w:(ins|del|moveTo|moveFrom)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tags.exec(source))) {
    if (match[4] === '/') continue;
    const tag = match[2];
    if (match[1] !== '/') {
      const attrs = match[3];
      const span = {
        tag,
        kind: tag === 'ins' || tag === 'moveTo' ? 'ins' : 'del',
        attrs,
        start: match.index,
        innerStart: match.index + match[0].length,
        innerEnd: -1,
        end: -1,
        id: xmlAttribute(attrs, 'w:id'),
        author: xmlDecode(xmlAttribute(attrs, 'w:author')),
        date: xmlAttribute(attrs, 'w:date'),
        text: '',
        children: [],
      };
      (stack.length ? stack.at(-1).children : roots).push(span);
      stack.push(span);
      continue;
    }
    let depth = stack.length - 1;
    while (depth >= 0 && stack[depth].tag !== tag) depth -= 1;
    if (depth < 0) continue;
    const span = stack[depth];
    span.innerEnd = match.index;
    span.end = match.index + match[0].length;
    span.text = revisionText(source.slice(span.innerStart, span.innerEnd));
    stack.length = depth;
  }
  const closed = (spans) => spans
    .filter((span) => span.end >= 0)
    .map((span) => ({ ...span, children: closed(span.children) }));
  return closed(roots);
}

/** Document order of the opening tags, parents before children — the order
 *  the snapshot numbers revisions in and `resolve_revision` addresses. */
export function flattenDocxRevisions(spans, into = []) {
  for (const span of spans) {
    into.push(span);
    flattenDocxRevisions(span.children, into);
  }
  return into;
}

function revisionKey(span) {
  return [span.tag, span.author, span.date, span.text].join('\u0000');
}

function revisionGroup(span) {
  return [span.tag, span.author, span.date].join('\u0000');
}

/** Modified-side wrappers that do not reproduce a tracked change of the
 *  original. A change is recognised by tag, author, date, and text; one the
 *  editor split into pieces (to reject part of it) still counts as the
 *  original as long as the pieces keep author and date and spell the same
 *  text in sequence. */
function newRevisions(originalSpans, modifiedSpans) {
  const pool = new Map();
  for (const span of originalSpans) {
    const key = revisionKey(span);
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(span);
  }
  const matched = new Set();
  const leftover = [];
  for (const span of modifiedSpans) {
    const bucket = pool.get(revisionKey(span));
    if (bucket?.length) matched.add(bucket.pop());
    else leftover.push(span);
  }
  const groupText = (spans) => {
    const groups = new Map();
    for (const span of spans) {
      const group = revisionGroup(span);
      groups.set(group, `${groups.get(group) || ''}${span.text}`);
    }
    return groups;
  };
  const unmatchedOriginal = groupText(originalSpans.filter((span) => !matched.has(span)));
  const leftoverByGroup = new Map();
  for (const span of leftover) {
    const group = revisionGroup(span);
    if (!leftoverByGroup.has(group)) leftoverByGroup.set(group, []);
    leftoverByGroup.get(group).push(span);
  }
  const fresh = new Set();
  for (const [group, spans] of leftoverByGroup) {
    const rebuilt = spans.map((span) => span.text).join('');
    if (rebuilt && rebuilt === (unmatchedOriginal.get(group) || '')) continue;
    for (const span of spans) fresh.add(span);
  }
  return fresh;
}

function unwrapDeletion(inner) {
  return inner
    .replace(/<w:delText\b/g, '<w:t')
    .replace(/<\/w:delText>/g, '</w:t>')
    .replace(/<w:delInstrText\b/g, '<w:instrText')
    .replace(/<\/w:delInstrText>/g, '</w:instrText>');
}

/** Rebuilds `xml[from, to)` with the targeted wrappers undone: a targeted
 *  insertion disappears with its content, a targeted deletion gives its text
 *  back; every other wrapper is kept with its children rebuilt the same way. */
function withoutRevisions(xml, spans, from, to, isTarget) {
  let output = '';
  let cursor = from;
  for (const span of spans) {
    output += xml.slice(cursor, span.start);
    cursor = span.end;
    if (isTarget(span) && span.kind === 'ins') continue;
    const inner = withoutRevisions(xml, span.children, span.innerStart, span.innerEnd, isTarget);
    output += isTarget(span)
      ? unwrapDeletion(inner)
      : `${xml.slice(span.start, span.innerStart)}${inner}${xml.slice(span.innerEnd, span.end)}`;
  }
  return `${output}${xml.slice(cursor, to)}`;
}

function paragraphLines(xml) {
  const lines = [];
  for (const paragraph of String(xml || '').matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    let text = '';
    for (const node of paragraph[1].matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)) {
      text += renderedWordText(node[1], node[2]);
    }
    if (text) lines.push(text);
  }
  return lines;
}

function lineDiff(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1;
  return {
    paragraph: head + 1,
    removedLines: before.length - head - tail,
    addedLines: after.length - head - tail,
    before: before.slice(head, before.length - tail).slice(0, 6).map(excerpt),
    after: after.slice(head, after.length - tail).slice(0, 6).map(excerpt),
  };
}

const REDLINING_GUIDANCE = Object.freeze([
  'Turn track_changes on before editing; an edit made while it is off leaves no <w:ins>/<w:del> and reads as untracked.',
  'To reject another author\'s insertion, nest a <w:del> inside their <w:ins> instead of editing its text; to restore their deletion, add a new <w:ins> after their <w:del>.',
  'A tracked change from the source is recognised by author, date, and text; rewriting one of those turns it into a new change and reports the text it carried as missing.',
]);

/** Compares the current body with the source after undoing only the tracked
 *  changes that are new relative to the source: whatever text still differs
 *  was edited without being tracked. With `author`, every new change must
 *  carry that author. Only the document body is compared. */
export function auditDocxRedlining(currentXml, originalXml, { author = '' } = {}) {
  const originalSpans = flattenDocxRevisions(docxRevisionTree(originalXml));
  const modifiedTree = docxRevisionTree(currentXml);
  const modifiedSpans = flattenDocxRevisions(modifiedTree);
  const fresh = newRevisions(originalSpans, modifiedSpans);
  const undone = withoutRevisions(String(currentXml || ''), modifiedTree, 0, String(currentXml || '').length, (span) => fresh.has(span));
  const before = paragraphLines(originalXml);
  const after = paragraphLines(undone);
  const untrackedEdits = before.join('\n') === after.join('\n') ? null : lineDiff(before, after);
  const expected = String(author || '').trim();
  const foreignAuthors = expected
    ? [...fresh]
      .filter((span) => span.author !== expected)
      .slice(0, 10)
      .map((span) => ({
        type: span.tag === 'ins' ? 'insertion' : 'deletion',
        author: span.author,
        text: excerpt(span.text),
      }))
    : [];
  const reasons = [];
  if (untrackedEdits) {
    reasons.push(`${untrackedEdits.removedLines + untrackedEdits.addedLines} paragraph(s) differ from the source after undoing the new tracked changes: they were edited untracked, without <w:ins>/<w:del> (first at paragraph ${untrackedEdits.paragraph}).`);
  }
  if (foreignAuthors.length) {
    reasons.push(`${foreignAuthors.length} new tracked change(s) carry an author other than "${expected}".`);
  }
  return {
    requested: true,
    ok: reasons.length === 0,
    author: expected,
    existingChanges: originalSpans.length,
    newChanges: {
      insertions: [...fresh].filter((span) => span.kind === 'ins').length,
      deletions: [...fresh].filter((span) => span.kind === 'del').length,
    },
    untrackedEdits,
    foreignAuthors,
    reason: reasons.join(' '),
    ...(reasons.length ? { guidance: [...REDLINING_GUIDANCE] } : {}),
  };
}

/** The body audit applied to every story part the source has: a header,
 *  footer, or note edited untracked fails the same way, and a foreign author
 *  anywhere is reported with its part. A part the edit created (a footer for
 *  page numbers, say) is listed under addedParts rather than failed, since
 *  Word tracks no story's creation. */
export function auditDocxRedliningStories(currentParts, originalParts, { author = '' } = {}) {
  const audits = [...originalParts.keys()].sort().map((name) => ({
    name,
    ...auditDocxRedlining(currentParts.get(name) || '', originalParts.get(name) || '', { author }),
  }));
  const failing = audits.find((audit) => audit.untrackedEdits);
  const reasons = audits
    .filter((audit) => audit.reason)
    .map((audit) => (/^word\/document\.xml$/i.test(audit.name) ? audit.reason : `${audit.name}: ${audit.reason}`));
  const sum = (pick) => audits.reduce((total, audit) => total + pick(audit), 0);
  return {
    requested: true,
    ok: reasons.length === 0,
    author: String(author || '').trim(),
    existingChanges: sum((audit) => audit.existingChanges),
    newChanges: {
      insertions: sum((audit) => audit.newChanges.insertions),
      deletions: sum((audit) => audit.newChanges.deletions),
    },
    untrackedEdits: failing ? { part: failing.name, ...failing.untrackedEdits } : null,
    foreignAuthors: audits
      .flatMap((audit) => audit.foreignAuthors.map((entry) => ({ ...entry, part: audit.name })))
      .slice(0, 10),
    parts: audits.map((audit) => ({ part: audit.name, ok: audit.ok, newChanges: audit.newChanges })),
    addedParts: [...currentParts.keys()].filter((name) => !originalParts.has(name)).sort(),
    reason: reasons.join(' '),
    ...(reasons.length ? { guidance: [...REDLINING_GUIDANCE] } : {}),
  };
}

function count(fragment, pattern) {
  return (fragment.match(pattern) || []).length;
}

function lintStoryRevisions(part, source, add) {
  let textInDeletion = 0;
  let instrInDeletion = 0;
  let deletedInInsertion = 0;
  for (const span of flattenDocxRevisions(docxRevisionTree(source))) {
    const inner = source.slice(span.innerStart, span.innerEnd);
    if (span.kind === 'del') {
      textInDeletion += count(inner, /<w:t\b/g);
      instrInDeletion += count(inner, /<w:instrText\b/g);
      continue;
    }
    let masked = inner;
    for (const child of [...span.children].filter((entry) => entry.kind === 'del').sort((a, b) => b.start - a.start)) {
      masked = `${masked.slice(0, child.start - span.innerStart)}${masked.slice(child.end - span.innerStart)}`;
    }
    deletedInInsertion += count(masked, /<w:delText\b/g);
  }
  if (textInDeletion) {
    add('error', 'text_in_deletion', `${textInDeletion} <w:t> element(s) sit inside <w:del>; deleted text must be <w:delText>.`, { count: textInDeletion, part });
  }
  if (instrInDeletion) {
    add('error', 'instr_text_in_deletion', `${instrInDeletion} <w:instrText> element(s) sit inside <w:del>; use <w:delInstrText>.`, { count: instrInDeletion, part });
  }
  if (deletedInInsertion) {
    add('error', 'deleted_text_in_insertion', `${deletedInInsertion} <w:delText> element(s) sit inside <w:ins> without a <w:del>; deleted text inside an insertion needs its own <w:del>.`, { count: deletedInInsertion, part });
  }
  let unpreserved = 0;
  for (const node of source.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)) {
    if (/^[ \t\r\n]|[ \t\r\n]$/.test(xmlDecode(node[2])) && !/\bxml:space="preserve"/.test(node[1])) unpreserved += 1;
  }
  if (unpreserved) {
    add('warning', 'whitespace_not_preserved', `${unpreserved} text element(s) start or end with a space but lack xml:space="preserve"; Word drops that space.`, { count: unpreserved, part });
  }
  const ids = (pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
  return {
    starts: ids(/<w:commentRangeStart\b[^>]*\bw:id="([^"]*)"/g),
    ends: ids(/<w:commentRangeEnd\b[^>]*\bw:id="([^"]*)"/g),
    references: ids(/<w:commentReference\b[^>]*\bw:id="([^"]*)"/g),
  };
}

/** Structural faults Word rejects or silently misreads across the story
 *  parts (body, headers, footers, notes): text elements inside the wrong
 *  revision wrapper, edge whitespace that is not preserved, and comment
 *  markers without a partner or a comment. `parts` is a list of
 *  `{ part, xml }` or the body XML alone. */
export function lintDocxRevisions(parts, commentsXml = '') {
  const stories = typeof parts === 'string' ? [{ part: 'word/document.xml', xml: parts }] : parts;
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
  const starts = new Set();
  const ends = new Set();
  const references = new Set();
  for (const story of stories) {
    const markers = lintStoryRevisions(story.part, String(story.xml || ''), add);
    for (const id of markers.starts) starts.add(id);
    for (const id of markers.ends) ends.add(id);
    for (const id of markers.references) references.add(id);
  }
  const mismatches = [];
  for (const id of ends) if (!starts.has(id)) mismatches.push(`commentRangeEnd ${id} has no commentRangeStart`);
  for (const id of starts) if (!ends.has(id)) mismatches.push(`commentRangeStart ${id} has no commentRangeEnd`);
  const comments = String(commentsXml || '');
  if (comments) {
    const known = new Set([...comments.matchAll(/<w:comment\b[^>]*\bw:id="([^"]*)"/g)].map((match) => match[1]));
    for (const id of new Set([...starts, ...ends, ...references])) {
      if (!known.has(id)) mismatches.push(`marker ${id} references no comment`);
    }
    const unanchored = [...known].filter((id) => !references.has(id));
    if (unanchored.length) {
      add('warning', 'comment_not_anchored', `${unanchored.length} comment(s) have no commentReference in the document body and stay invisible in Word.`, { ids: unanchored.slice(0, 10) });
    }
  }
  if (mismatches.length) {
    add('error', 'comment_marker_mismatch', mismatches.slice(0, 5).join('; '), { count: mismatches.length });
  }
  return findings;
}

/** Accepts or rejects tracked-change wrappers: all of them, the one at
 *  `target` (1-based, document order of the opening tags) or with `id`, or
 *  every one by `author`. Nested wrappers resolve inside out, so accepting
 *  everything in an insertion that holds a later deletion keeps the inserted
 *  text minus the deleted part. */
export function resolveDocxRevisions(documentXml, { resolution = 'accept', target = 0, id = '', author = '' } = {}) {
  const source = String(documentXml || '');
  const tree = docxRevisionTree(source);
  const wanted = String(id || '');
  const owner = String(author || '');
  const single = Boolean(target || wanted);
  let ordinal = 0;
  let resolved = 0;
  const rebuild = (spans, from, to) => {
    let output = '';
    let cursor = from;
    for (const span of spans) {
      ordinal += 1;
      const mine = ordinal;
      output += source.slice(cursor, span.start);
      cursor = span.end;
      const inner = rebuild(span.children, span.innerStart, span.innerEnd);
      const addressed = wanted
        ? span.id === wanted
        : owner
          ? span.author === owner
          : (!target || target === mine);
      if (!addressed) {
        output += `${source.slice(span.start, span.innerStart)}${inner}${source.slice(span.innerEnd, span.end)}`;
        continue;
      }
      resolved += 1;
      const keep = (span.kind === 'ins') === (resolution === 'accept');
      if (!keep) continue;
      output += span.kind === 'del' ? unwrapDeletion(inner) : inner;
    }
    return `${output}${source.slice(cursor, to)}`;
  };
  let xml = rebuild(tree, 0, source.length);
  // Move range markers only delimit the wrappers; once every wrapper (or
  // every wrapper of the reviewer) is resolved they would point at nothing.
  if (!single) xml = xml.replace(new RegExp(`<w:move(?:From|To)Range(?:Start|End)\\b${revisionOwner(owner)}[^>]*\\/>`, 'g'), '');
  return { xml, resolved };
}

const PROPERTY_CHANGE = /<w:(rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid)Change\b/g;

function restoreProperties(xml, tag, owner = '') {
  // The change record is the last child of its properties element and holds
  // the previous properties; rejecting means the previous ones come back.
  // The head never crosses the element's own closing tag, so a properties
  // element without a change record is not stitched to the next one that
  // has one.
  const pattern = new RegExp(
    `<w:${tag}(\\s[^>]*)?>((?:(?!<\\/w:${tag}>)[\\s\\S])*?)<w:${tag}Change\\b${owner}[^>]*>\\s*(?:<w:${tag}\\/>|<w:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:${tag}>)\\s*<\\/w:${tag}Change>\\s*<\\/w:${tag}>`,
    'g',
  );
  return xml.replace(pattern, (_, attrs = '', head, previous = '') => {
    if (tag !== 'pPr') return `<w:${tag}${attrs}>${previous}</w:${tag}>`;
    // A paragraph's own rPr and sectPr precede the change record and belong
    // to the paragraph mark, not to the changed properties.
    const kept = [
      /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\/>/.exec(head)?.[0] || '',
      /<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/.exec(head)?.[0] || '',
    ].join('');
    return `<w:pPr${attrs}>${previous}${kept}</w:pPr>`;
  });
}

/** Formatting revisions (`w:rPrChange`, `w:pPrChange`, table and section
 *  property changes, `w:numberingChange`) are not wrappers around runs, so
 *  accept/reject of the wrappers alone leaves Word still showing a revised
 *  document. Accepting drops the records; rejecting restores the previous
 *  properties they carry. */
export function resolveDocxPropertyChanges(documentXml, { resolution = 'accept', author = '' } = {}) {
  let xml = String(documentXml || '');
  const owner = revisionOwner(author);
  const changes = count(xml, new RegExp(`${PROPERTY_CHANGE.source}${owner}`, 'g'))
    + count(xml, new RegExp(`<w:numberingChange\\b${owner}`, 'g'));
  if (!changes) return { xml, changes: 0 };
  if (resolution === 'reject') {
    // Run properties first: a paragraph mark's rPrChange sits inside the pPr
    // head that the pPr restoration keeps.
    for (const tag of ['rPr', 'tcPr', 'trPr', 'tblPr', 'tblGrid', 'sectPr', 'pPr']) xml = restoreProperties(xml, tag, owner);
  }
  xml = xml
    .replace(new RegExp(`<w:(rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid|numbering)Change\\b${owner}[^>]*>[\\s\\S]*?<\\/w:\\1Change>`, 'g'), '')
    .replace(new RegExp(`<w:(?:rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid|numbering)Change\\b${owner}[^>]*\\/>`, 'g'), '');
  return { xml, changes };
}

/** Number of formatting revisions a part carries; they are not wrappers, so
 *  the revision list does not number them, but a clean copy needs them gone. */
export function countDocxPropertyChanges(xml) {
  return count(String(xml || ''), PROPERTY_CHANGE) + count(String(xml || ''), /<w:numberingChange\b/g);
}
