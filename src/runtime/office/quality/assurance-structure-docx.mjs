// Word document structure review: heading hierarchy and body order.
import { issue } from './assurance-issue.mjs';

// A heading is read as a heading because its type leads the body's, and one
// level carries one type through the document. A heading set at the body size
// with no weight of its own, or a level set two ways, is a hierarchy the reader
// cannot see however correct the styles behind it are.
const HEADING_TYPE_TOLERANCE = 0.05;

function paragraphSize(paragraph) {
  return Number(paragraph?.font?.size) || 0;
}

function reviewDocxHeadingType(content, headings, issues) {
  const bodySizes = content
    .filter((paragraph) => headingLevel(paragraph) === null)
    .map(paragraphSize)
    .filter((size) => size > 0)
    .sort((left, right) => left - right);
  const body = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 0;
  const byLevel = new Map();
  for (const { paragraph, level } of headings) {
    const size = paragraphSize(paragraph);
    if (!size) continue;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push({ paragraph, size });
    if (body && size <= body && !paragraph.font?.bold) {
      issues.push(
        issue(
          'heading_not_distinct',
          paragraph.path || '/body',
          `Heading is set at ${size} pt against ${body} pt body text and carries no weight of its own; the hierarchy is not visible.`
        )
      );
    }
  }
  for (const [level, members] of byLevel) {
    const sizes = members.map((entry) => entry.size);
    if (members.length < 2 || Math.max(...sizes) <= Math.min(...sizes) * (1 + HEADING_TYPE_TOLERANCE)) continue;
    issues.push(
      issue(
        'heading_style_inconsistent',
        members[1].paragraph.path || '/body',
        `Level ${level} headings are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt; one level carries one type.`
      )
    );
  }
}

function headingLevel(paragraph) {
  const style = String(paragraph?.style || '');
  if (!/(?:title|heading|제목|표제)/i.test(style)) return null;
  if (/(?:title|제목|표제)/i.test(style) && !/(?:heading|제목\s*\d)/i.test(style)) return 0;
  const level = Number(/([1-9])/.exec(style)?.[1]);
  return Number.isInteger(level) ? level : 1;
}

function wordBlockOrder(document) {
  const blocks =
    Array.isArray(document?.blockOrder) && document.blockOrder.length
      ? document.blockOrder.map((entry) => ({ ...entry, start: Number(entry.start) }))
      : [
          ...(document?.paragraphs || []).map((entry) => ({
            type: 'paragraph',
            index: entry.index,
            path: entry.path,
            start: Number(entry.start),
          })),
          ...(document?.tables || []).map((entry) => ({
            type: 'table',
            index: entry.index,
            path: entry.path,
            start: Number(entry.start),
          })),
        ];
  if (blocks.every((entry) => Number.isFinite(entry.start))) {
    blocks.sort((left, right) => left.start - right.start);
  }
  return blocks;
}

function headingHierarchyIssues(content, headings, issues) {
  if (content.length >= 8 && headings.length === 0) {
    issues.push(
      issue(
        'heading_hierarchy_missing',
        '/body',
        'Document has substantial content but no visible title or heading hierarchy.'
      )
    );
  }
  let priorLevel = null;
  for (const { paragraph, level } of headings) {
    if (priorLevel !== null && level > priorLevel + 1) {
      issues.push(
        issue(
          'heading_hierarchy_jump',
          paragraph.path || '/body',
          `Heading level jumps from ${priorLevel} to ${level}.`
        )
      );
    }
    priorLevel = level;
  }
}

// A heading whose next content block starts on another page, or that nothing
// follows, introduces nothing the reader can see with it.
function orphanHeadingIssues(document, paragraphs, tables, issues) {
  const paragraphsByIndex = new Map(paragraphs.map((entry) => [Number(entry.index), entry]));
  const tablesByIndex = new Map(tables.map((entry) => [Number(entry.index), entry]));
  const order = wordBlockOrder(document);
  for (let index = 0; index < order.length; index += 1) {
    const block = order[index];
    if (block.type !== 'paragraph') continue;
    const paragraph = paragraphsByIndex.get(Number(block.index));
    if (paragraph?.inTable === true || headingLevel(paragraph) === null || !String(paragraph?.text || '').trim())
      continue;
    const nextBlock = order.slice(index + 1).find((entry) => {
      if (entry.type === 'table') return true;
      return String(paragraphsByIndex.get(Number(entry.index))?.text || '').trim();
    });
    const next =
      nextBlock?.type === 'table'
        ? tablesByIndex.get(Number(nextBlock.index))
        : paragraphsByIndex.get(Number(nextBlock?.index));
    const headingPage = Number(paragraph?.pageStart || paragraph?.page);
    const nextPage = Number(next?.pageStart || next?.page);
    if (!nextBlock || (headingPage > 0 && nextPage > 0 && headingPage !== nextPage)) {
      issues.push(
        issue('orphan_heading', paragraph.path || '/body', 'Heading is separated from the content it introduces.')
      );
    }
  }
}

// Machine tells: a bullet typed as text and a newline inside a paragraph
// both read as authoring by string instead of by structure.
function paragraphTextIssues(content, issues) {
  for (const paragraph of content) {
    if (String(paragraph.text || '').length > 900) {
      issues.push(
        issue('dense_paragraph', paragraph.path || '/body', 'Paragraph is too dense for fast document scanning.')
      );
    }
  }
  for (const paragraph of content) {
    const text = String(paragraph.text || '');
    if (/^[•·●▪◦■*-]\s/.test(text)) {
      issues.push(
        issue(
          'literal_bullet',
          paragraph.path || '/body',
          'Paragraph starts with a typed bullet character; a list marker comes from list formatting (listKind, set_list), never from text.'
        )
      );
    }
    // A soft break reads back as a newline too, and Word draws that one as a
    // line break; only the newlines beyond the paragraph's breaks are the typed
    // ones that collapse to a space.
    const newlines = (text.match(/\n/g) || []).length;
    if (newlines > (Number(paragraph.softBreaks) || 0)) {
      issues.push(
        issue(
          'newline_in_text',
          paragraph.path || '/body',
          'Paragraph text carries a newline character, which Word renders as a space; split it into separate paragraphs.'
        )
      );
    }
  }
}

function shortTableSplitIssues(tables, issues) {
  for (const table of tables) {
    const pageStart = Number(table.pageStart);
    const pageEnd = Number(table.pageEnd);
    const rows = Array.isArray(table.rows) ? table.rows.length : 0;
    if (rows > 0 && rows <= 6 && pageStart > 0 && pageEnd > 0 && pageStart !== pageEnd) {
      issues.push(
        issue(
          'short_table_split',
          table.path || '/body',
          `A ${rows}-row table is split across pages ${pageStart}-${pageEnd}.`
        )
      );
    }
  }
}

export function reviewDocxStructure(document) {
  const issues = [];
  const paragraphs = Array.isArray(document?.paragraphs) ? document.paragraphs : [];
  const tables = Array.isArray(document?.tables) ? document.tables : [];
  const content = paragraphs.filter((paragraph) => paragraph?.inTable !== true && String(paragraph.text || '').trim());
  const headings = content
    .map((paragraph) => ({ paragraph, level: headingLevel(paragraph) }))
    .filter((entry) => entry.level !== null);
  reviewDocxHeadingType(content, headings, issues);
  headingHierarchyIssues(content, headings, issues);
  orphanHeadingIssues(document, paragraphs, tables, issues);
  paragraphTextIssues(content, issues);
  shortTableSplitIssues(tables, issues);
  return issues;
}
