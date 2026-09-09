/** Bounded, all-frame observations. Missing frames are errors, never evidence
 * that text disappeared. Open shadow roots share the same extraction path. */
import type { WebContents } from 'electron';
import { createBrowserFrameCollector, type BrowserFrameHost } from './document-frames';
import { browserQueryMatchesLine, parseBrowserQuery } from './semantic-query';
import { browserRenderCheckpoint } from './render-checkpoint';
import { observeBrowserDocumentChanges } from './document-changes';


export const BROWSER_DOCUMENT_ROOTS = `function() {
  const roots = [document];
  let scanned = 0;
  for (let index = 0; index < roots.length; index++) {
    const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (++scanned > 50000) throw new Error('document scan exceeded 50000 elements');
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  return roots;
}`;

export const BROWSER_DOCUMENT_TEXT = `(() => {
  const parts = (${BROWSER_DOCUMENT_ROOTS})().map(root => {
    if (root === document) return document.body?.innerText || '';
    const hostStyle = getComputedStyle(root.host);
    if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return '';
    return Array.from(root.childNodes).map(node => node.nodeType === 3
      ? node.textContent : (node.innerText || '')).join('\\n');
  });
  const text = parts.join('\\n');
  if (text.length > 1000000) throw new Error('document text exceeded observation limit');
  return text;
})()`;

/** Two counters ride in a revision: `version` moves on any activity including
 *  the gesture itself (a pointer press, a key, a scroll), while `dom` moves
 *  only when the document or a control's value changes. Comparing `dom`
 *  across a gesture is how a reply can say the page did not react. */
export const BROWSER_OBSERVATION_REVISION = `(() => {
  let state = globalThis.__mixdogObservationRevision;
  if (!state) {
    state = { version: 0, dom: 0, roots: new WeakSet() };
    globalThis.__mixdogObservationRevision = state;
    const touched = () => { state.version++; };
    const mutated = () => { state.version++; state.dom++; };
    state.observer = new MutationObserver(mutated);
    for (const event of ['input', 'change']) document.addEventListener(event, mutated, true);
    for (const event of ['scroll', 'pointerdown', 'keydown']) document.addEventListener(event, touched, true);
  }
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    if (!state.roots.has(root)) {
      state.observer.observe(root, {subtree: true, childList: true, attributes: true, characterData: true});
      state.roots.add(root);
    }
  }
  if (state.observer.takeRecords().length) { state.version++; state.dom++; }
  return [performance.timeOrigin, state.version, innerWidth, innerHeight, scrollX, scrollY, state.dom].join(':');
})()`;

/** Whether the documents behind two revisions differ: a new document, a DOM
 *  mutation, a control value, or (when asked) the scroll position. Pointer
 *  and key activity alone does not count. Unknown when a revision is missing
 *  or predates the counter. */
export function browserDocumentChanged(
  before: string | undefined,
  after: string | undefined,
  options: { includeScroll?: boolean } = {},
): boolean | undefined {
  if (!before || !after) return undefined;
  const left = before.split('|');
  const right = after.split('|');
  if (left.length !== right.length) return true;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index].split(':');
    const b = right[index].split(':');
    if (a.length < 7 || b.length < 7) return undefined;
    if (a[0] !== b[0] || a[6] !== b[6] || a[2] !== b[2] || a[3] !== b[3]) return true;
    if (options.includeScroll && (a[4] !== b[4] || a[5] !== b[5])) return true;
  }
  return false;
}

/** The lines of `text` that satisfy `query`, each with two lines of context.
 *  Keywords match with OR; `/pattern/i` is a regular expression. */
export function filterBrowserReadLines(text: string, query: string): string {
  const plan = parseBrowserQuery(query);
  if (!plan.regex && !plan.tokens.length) return text;
  const lines = text.split('\n');
  const matches = new Set<number>();
  lines.forEach((line, index) => {
    if (!browserQueryMatchesLine(plan, line)) return;
    for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) matches.add(i);
  });
  return [...matches].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
}

export function createBrowserDocuments(host: BrowserFrameHost) {
  const collect = createBrowserFrameCollector(host);

  async function pageText(guest: WebContents, signal?: AbortSignal): Promise<string> {
    const texts = await collect<string>(guest, BROWSER_DOCUMENT_TEXT, signal);
    if (texts.reduce((size, text) => size + text.length, 0) > 1_000_000) {
      throw new Error('combined frame text exceeded observation limit');
    }
    return texts.join('\n');
  }

  async function readPage(guest: WebContents, query: string, maxChars: number, offset: number, signal?: AbortSignal) {
    const full = (await pageText(guest, signal)).replace(/\n{3,}/g, '\n\n').trim();
    const text = query ? filterBrowserReadLines(full, query) : full;
    offset = Math.min(offset, text.length);
    return {
      url: guest.getURL(),
      title: guest.getTitle(),
      text: text.slice(offset, offset + maxChars),
      total: text.length,
      unfilteredTotal: full.length,
      offset,
    };
  }

  async function extractPage(guest: WebContents, selector: string, attributes: string[], limit: number, signal?: AbortSignal) {
    type Row = { text: string; name: string; attributes: Record<string, string> };
    const frames = await collect<{ rows: Row[]; total: number }>(guest, `(() => {
      const rows = [];
      let total = 0;
      const compact = (value, max) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
      for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
        let nodes;
        try { nodes = root.querySelectorAll(${JSON.stringify(selector)}); }
        catch { throw new Error('extract selector is not a valid CSS selector'); }
        total += nodes.length;
        for (const node of nodes) {
          if (rows.length >= ${limit}) break;
          const attributes = {};
          for (const name of ${JSON.stringify(attributes)}) {
            const raw = name === 'href' && node instanceof HTMLAnchorElement ? node.href : node.getAttribute(name);
            if (raw) attributes[name] = compact(raw, 300);
          }
          rows.push({text: compact(node.innerText || node.textContent, 400),
            name: compact(node.getAttribute('aria-label') || node.getAttribute('title'), 120), attributes});
        }
      }
      return {rows, total};
    })()`, signal);
    return { rows: frames.flatMap((frame) => frame.rows).slice(0, limit), total: frames.reduce((sum, frame) => sum + frame.total, 0) };
  }
  async function revision(guest: WebContents, signal?: AbortSignal) {
    return (await collect<string>(guest, BROWSER_OBSERVATION_REVISION, signal)).join('|');
  }
  async function renderCheckpoint(guest: WebContents, background: boolean, signal?: AbortSignal): Promise<void> {
    await collect<boolean>(guest, `(${browserRenderCheckpoint(background)}).then(() => true)`, signal);
  }
  const observeChanges = (guest: WebContents, signal?: AbortSignal) =>
    observeBrowserDocumentChanges(host, collect, BROWSER_DOCUMENT_ROOTS, guest, signal);
  return { collect, pageText, readPage, extractPage, revision, renderCheckpoint, observeChanges };
}
