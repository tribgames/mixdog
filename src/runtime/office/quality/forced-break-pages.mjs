// Which rendered pages open with a deliberate forced page break. A page that ends short before such a break ends where
// the author ended it (page_bottom_empty reads this). The openings come from the authored source: the kept HTML
// (`break-before: page` / `page-break-before: always|page`, inline or from a stylesheet rule) or the DOCX body
// (`w:pageBreakBefore`, or a page-break run before the paragraph). They are matched against the first body text of
// each page of the preview PDF, ignoring the running head and folio bands.
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { extractPdfTextLayout } from '../pdf/pdf-analysis.mjs';

const OPENING_CHARS = 40;
const MIN_OPENING_CHARS = 3;
// Running head and folio bands, as a share of the page height.
const MARGIN_BAND = 0.06;
const SKIPPED_TAGS = new Set(['html', 'head', 'body', 'style', 'script', 'link', 'meta', 'title']);

const squash = (text) => String(text).replace(/\s+/g, '').toLowerCase();
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
const visibleText = (html) =>
  html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#39|[a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();

// A media query list reaches the printed page unless every query is screen-only.
const appliesToPrint = (queries) =>
  queries
    .split(',')
    .some((query) => !/^\s*(?:only\s+)?screen\b/i.test(query) && !/^\s*not\s+print\b/i.test(query));

// Style rules in source order, flattened out of @media blocks that do not apply in print.
function cssRules(css, active, rules) {
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    for (; close < css.length && depth > 0; close += 1) depth += css[close] === '{' ? 1 : css[close] === '}' ? -1 : 0;
    const head = css.slice(index, open).replace(/^(?:\s*@[^{;]*;)+/, '').trim();
    const inner = css.slice(open + 1, close - 1);
    if (/^@media\b/i.test(head)) cssRules(inner, active && appliesToPrint(head.slice(6)), rules);
    else if (active && head && !head.startsWith('@')) rules.push({ head, body: inner });
    index = close;
  }
  return rules;
}

/** The winning break-before declaration of a block: a value and its cascade rank, or null when it states none. */
function breakDeclaration(body, rank) {
  // Every declaration of the block, in source order; !important beats source order within the block too.
  const declarations = String(body)
    .split(';')
    .map((text) => /^\s*(?:page-)?break-before\s*:\s*(.*?)\s*$/i.exec(text))
    .filter(Boolean)
    .map(([, value]) => {
      const important = /!\s*important\s*$/i.test(value);
      return { value: value.replace(/\s*!\s*important\s*$/i, '').trim(), important };
    });
  if (!declarations.length) return null;
  const winner = declarations.findLast((entry) => entry.important) ?? declarations.at(-1);
  return { forced: /^(?:page|always)$/i.test(winner.value), rank: [winner.important ? 1 : 0, ...rank] };
}

const beats = (a, b) => {
  for (let index = 0; index < a.rank.length; index += 1) if (a.rank[index] !== b.rank[index]) return a.rank[index] > b.rank[index];
  return true;
};

function breakSelectors(html) {
  const selectors = [];
  let order = 0;
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const { head, body } of cssRules(css.replace(/\/\*[\s\S]*?\*\//g, ''), true, [])) {
      order += 1;
      for (const selector of head.split(',')) {
        const match = /^\s*([a-z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)\s*$/i.exec(selector);
        if (!match || (!match[1] && !match[2] && !match[3])) continue;
        const classes = match[3].split('.').filter(Boolean);
        const specificity = (match[2] ? 100 : 0) + classes.length * 10 + (match[1] ? 1 : 0);
        const declaration = breakDeclaration(body, [0, specificity, order]);
        if (declaration) selectors.push({ tag: (match[1] || '').toLowerCase(), id: match[2] || '', classes, declaration });
      }
    }
  }
  return selectors;
}

/** The first ~40 visible characters of every element the HTML forces onto a new page. */
export function htmlBreakOpenings(html) {
  const source = String(html || '');
  const selectors = breakSelectors(source);
  const openings = [];
  for (const tagMatch of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = tagMatch[1].toLowerCase();
    if (SKIPPED_TAGS.has(tag)) continue;
    const attributes = tagMatch[2];
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] || '';
    const classes = (/\bclass\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] || '').split(/\s+/).filter(Boolean);
    const declarations = selectors
      .filter(
        (rule) =>
          (!rule.tag || rule.tag === tag) &&
          (!rule.id || rule.id === id) &&
          rule.classes.every((name) => classes.includes(name))
      )
      .map((rule) => rule.declaration);
    const inline = breakDeclaration(style?.[1] ?? style?.[2] ?? '', [1, 0, 0]);
    if (inline) declarations.push(inline);
    const winner = declarations.reduce((best, entry) => (!best || beats(entry, best) ? entry : best), null);
    if (!winner?.forced) continue;
    const rest = source.slice(tagMatch.index + tagMatch[0].length);
    // The element's own text (up to its closing tag), whatever tags nest inside it.
    const end = rest.search(new RegExp(`</${tag}\\s*>`, 'i'));
    const opening = visibleText(end < 0 ? rest.slice(0, 2000) : rest.slice(0, end)).slice(0, OPENING_CHARS);
    if (squash(opening).length >= MIN_OPENING_CHARS) openings.push(opening);
  }
  return openings;
}

/** The opening text of every DOCX paragraph that carries pageBreakBefore or follows a page-break run. */
export function docxBreakOpenings(documentXml) {
  const openings = [];
  let pending = false;
  for (const [paragraph] of String(documentXml || '').matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    if (/<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")[^>]*\/>/.test(paragraph)) pending = true;
    const parts = paragraph.split(/<w:br\b[^>]*w:type="page"[^>]*\/>/);
    parts.forEach((part, index) => {
      if (index > 0) pending = true;
      const text = [...part.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((entry) => entry[1]).join('');
      if (!pending || !text.trim()) return;
      pending = false;
      const opening = visibleText(text).slice(0, OPENING_CHARS);
      if (squash(opening).length >= MIN_OPENING_CHARS) openings.push(opening);
    });
  }
  return openings;
}

// A running head or folio repeats at the same position on several pages; a folio differs only by its number.
const runningKey = (item) =>
  `${/^[\s\d\-–/.()]+$/.test(item.text) ? '#' : String(item.text).trim()}@${Math.round(item.top)}`;

// Only the outer margin bands of a page hold running chrome; body text is never filtered, however often it repeats.
const inMargin = (page, item) => {
  const height = Number(page.height) || 0;
  return height > 0 && (item.top < height * MARGIN_BAND || item.top > height * (1 - MARGIN_BAND));
};

function runningItems(layoutPages) {
  const pagesByKey = new Map();
  for (const page of layoutPages) {
    for (const key of new Set((page.items || []).filter((item) => inMargin(page, item)).map(runningKey))) {
      pagesByKey.set(key, (pagesByKey.get(key) || 0) + 1);
    }
  }
  return new Set([...pagesByKey].filter(([, count]) => count > 1).map(([key]) => key));
}

/** Body text of a PDF layout page in reading order, without the running head and folio items. */
function bodyText(page, running) {
  const items = (page.items || []).filter((item) => !(inMargin(page, item) && running.has(runningKey(item))));
  items.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.x - b.x));
  return items.map((item) => item.text).join('');
}

/** 1-based pages whose body text begins with one of the openings. */
export function forcedBreakPagesFromTexts(openings, layoutPages) {
  const wanted = openings.map(squash);
  const pages = new Set();
  const running = runningItems(layoutPages);
  for (const page of layoutPages) {
    const text = squash(bodyText(page, running));
    if (wanted.some((opening) => text.startsWith(opening))) pages.add(page.page);
  }
  return pages;
}

/**
 * The forced-break page numbers of a docx or pdf session's preview, or null when the render has no
 * authored source to read the breaks from (page_bottom_empty then reports at its full severity).
 */
export async function forcedBreakPages(session, preview) {
  // A measure-only pass (`render: false`) has no rendered pages and no exported PDF to read.
  if (!['docx', 'pdf'].includes(session?.format) || !preview?._images?.length) return null;
  if (!/\.pdf$/i.test(preview.output || '') || preview.exportAvailable === false) return null;
  const openings = [];
  let known = false;
  if (session.format === 'docx') {
    const zip = await JSZip.loadAsync(await readFile(session.target));
    openings.push(...docxBreakOpenings(await zip.file('word/document.xml')?.async('string')));
    known = true;
  }
  if (session.htmlSource && !session.htmlSourceEdits) {
    openings.push(...htmlBreakOpenings(await readFile(session.htmlSource, 'utf8')));
    known = true;
  }
  if (!known) return null;
  const layout = await extractPdfTextLayout(preview.output, { shapes: false });
  return forcedBreakPagesFromTexts(openings, layout.pages);
}
