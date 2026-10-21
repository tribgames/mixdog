/** Bounded, all-frame observations. Missing frames are errors, never evidence
 * that text disappeared. Open shadow roots share the same extraction path. */
import type { WebContents } from 'electron';
import { createBrowserFrameCollector, type BrowserFrameHost } from './document-frames';
import { browserQueryMatchesLine, parseBrowserQuery } from './semantic-query';
import { browserRenderCheckpointEnd, browserRenderCheckpointPoll } from './render-checkpoint';
import { pause } from './settle';
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

const BROWSER_DOCUMENT_TEXT = `(() => {
  const parts = (${BROWSER_DOCUMENT_ROOTS})().map(root => {
    // A <frameset> body holds only the unseen <noframes> fallback; each
    // frame is collected as a document of its own.
    if (root === document) return document.body?.tagName === 'FRAMESET' ? '' : document.body?.innerText || '';
    const hostStyle = getComputedStyle(root.host);
    if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return '';
    return Array.from(root.childNodes).map(node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      const style = getComputedStyle(node);
      // innerText on an unrendered STYLE/SCRIPT node falls back to its source.
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      return node.innerText || '';
    }).join('\\n');
  });
  const text = parts.join('\\n');
  if (text.length > 1000000) throw new Error('document text exceeded observation limit');
  return text;
})()`;

/** Separate counters ride in a revision: `version` moves on any activity including
 *  the gesture itself (a pointer press, a key, a scroll), while `dom` moves
 *  only when the document or a control's value changes. Comparing `dom`
 *  across a gesture is how a reply can say the page did not react. `scroll`
 *  also tracks nested scrollers whose movement leaves scrollX/scrollY unchanged. */
export const BROWSER_OBSERVATION_REVISION = `(() => {
  let state = globalThis.__mixdogObservationRevision;
  if (!state) {
    state = { version: 0, dom: 0, scroll: 0, roots: new WeakSet() };
    globalThis.__mixdogObservationRevision = state;
    const positions = new WeakMap();
    state.recordScroll = node => {
      const scroller = node === document ? document.scrollingElement : node;
      if (!scroller) return;
      const position = [scroller.scrollLeft, scroller.scrollTop].join(':');
      if (positions.get(scroller) === position) return;
      positions.set(scroller, position);
      state.version++;
      state.scroll++;
    };
    const touched = () => { state.version++; };
    const mutated = () => { state.version++; state.dom++; };
    state.observer = new MutationObserver(mutated);
    for (const event of ['input', 'change']) document.addEventListener(event, mutated, true);
    for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, touched, true);
  }
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    if (!state.roots.has(root)) {
      state.observer.observe(root, {subtree: true, childList: true, attributes: true, characterData: true});
      root.addEventListener('scroll', event => state.recordScroll(event.target), true);
      state.roots.add(root);
    }
  }
  if (state.observer.takeRecords().length) { state.version++; state.dom++; }
  return [performance.timeOrigin, state.version, innerWidth, innerHeight, scrollX, scrollY, state.dom, state.scroll].join(':');
})()`;

/** Whether the documents behind two revisions differ: a new document, a DOM
 *  mutation, a control value, or (when asked) the scroll position. Pointer
 *  and key activity alone does not count. Unknown when a revision is missing
 *  or predates the counter. */
export function browserDocumentChanged(
  before: string | undefined,
  after: string | undefined,
  options: { includeScroll?: boolean } = {}
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
    if (options.includeScroll && a.length >= 8 && b.length >= 8 && a[7] !== b[7]) return true;
    if (options.includeScroll && a.length >= 9 && b.length >= 9 && a[8] !== b[8]) return true;
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
  return [...matches]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join('\n');
}

/** The old checkpoint settled within ~100ms; a frame that has not confirmed
 *  after ten times that is not going to run timers. The deadline bounds the
 *  whole checkpoint, including a read still outstanding when it passes. */
const CHECKPOINT_DEADLINE_MS = 1_000;
const CHECKPOINT_POLL_MS = 10;
let nextCheckpoint = 0;

export function createBrowserDocuments(
  host: BrowserFrameHost,
  { checkpointDeadlineMs = CHECKPOINT_DEADLINE_MS }: { checkpointDeadlineMs?: number } = {}
) {
  const collect = createBrowserFrameCollector(host);
  const explicitScrolls = new WeakMap<WebContents, number>();
  const recordScroll = (guest: WebContents) => {
    explicitScrolls.set(guest, (explicitScrolls.get(guest) || 0) + 1);
  };

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

  async function extractPage(
    guest: WebContents,
    selector: string,
    attributes: string[],
    limit: number,
    signal?: AbortSignal
  ) {
    type Row = { text: string; name: string; attributes: Record<string, string> };
    const frames = await collect<{ rows: Row[]; total: number; columns: string }>(
      guest,
      `(() => {
      const rows = [];
      let total = 0;
      let columns = '';
      const compact = (value, max) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
      // A table row keeps its cell boundaries: collapsed into one run of
      // words, "Smith John" could be one cell or two.
      const cells = (row) => Array.from(row.cells, (cell) => compact(cell.innerText || cell.textContent, 200)).join(' | ');
      const isTableRow = (node) => String(node.tagName || '').toUpperCase() === 'TR' && Boolean(node.cells);
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
          const tableRow = isTableRow(node);
          if (tableRow && !columns) {
            const table = node.closest('table');
            const header = table && ((table.tHead && table.tHead.rows[0]) || Array.from(table.rows).find(
              (row) => row.cells.length && Array.from(row.cells).every((cell) => cell.tagName === 'TH')));
            if (header && header !== node) columns = cells(header).slice(0, 400);
          }
          rows.push({text: tableRow ? cells(node).slice(0, 400) : compact(node.innerText || node.textContent, 400),
            name: compact(node.getAttribute('aria-label') || node.getAttribute('title'), 120), attributes});
        }
      }
      return {rows, total, columns};
    })()`,
      signal
    );
    return {
      rows: frames.flatMap((frame) => frame.rows).slice(0, limit),
      total: frames.reduce((sum, frame) => sum + frame.total, 0),
      columns: frames.find((frame) => frame.columns)?.columns || '',
    };
  }
  async function revision(guest: WebContents, signal?: AbortSignal) {
    const frames = await collect<string>(guest, BROWSER_OBSERVATION_REVISION, signal);
    return frames.map((frame) => `${frame}:${explicitScrolls.get(guest) || 0}`).join('|');
  }
  /** Flushes pending rendering work in every frame. Each frame schedules the
   *  checkpoint and answers at once; the markers are then polled with
   *  synchronous reads, so a frame that can never run timers (sandboxed
   *  without allow-scripts, hidden) holds nothing and is only given until the
   *  deadline. Resolves false when some frame stayed unconfirmed: its pending
   *  work is unknown, so it must never count as proof that nothing changed. */
  async function renderCheckpoint(guest: WebContents, background: boolean, signal?: AbortSignal): Promise<boolean> {
    const id = ++nextCheckpoint;
    const deadline = AbortSignal.timeout(checkpointDeadlineMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Frames that reported done are not read again while they stay in the
    // context that confirmed (a navigation keeps the frame id, not the
    // context); a frame that appears mid-checkpoint is scheduled and awaited too.
    const done = new Map<string, number>();
    let confirmed = false;
    try {
      for (;;) {
        const polled = await collect.byFrame<boolean>(
          guest,
          browserRenderCheckpointPoll(id, background),
          bounded,
          done
        );
        for (const [frameId, finished, contextId] of polled)
          if (finished) done.set(frameId, contextId);
          else done.delete(frameId);
        if (polled.every(([, finished]) => finished)) {
          confirmed = true;
          return true;
        }
        await pause(CHECKPOINT_POLL_MS, bounded);
      }
    } catch (error) {
      // The deadline ends an outstanding read too, and only that rejection is
      // "unconfirmed"; the caller's cancellation or a real failure is an error.
      if (signal?.aborted || !deadline.aborted || error !== deadline.reason) throw error;
      return false;
    } finally {
      // Finished frames consumed their own marker; the rest are cleared so
      // none outlives the checkpoint and a late timer finds nothing to set.
      if (!confirmed) {
        await collect(guest, browserRenderCheckpointEnd(id), AbortSignal.timeout(500)).catch(() => undefined);
      }
    }
  }
  const observeChanges = (guest: WebContents, signal?: AbortSignal) =>
    observeBrowserDocumentChanges(host, collect, BROWSER_DOCUMENT_ROOTS, guest, signal);
  return { collect, pageText, readPage, extractPage, revision, recordScroll, renderCheckpoint, observeChanges };
}
