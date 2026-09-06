/** Bounded, all-frame observations. Missing frames are errors, never evidence
 * that text disappeared. Open shadow roots share the same extraction path. */
import type { WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}
interface DocumentsHost {
  cdp: BrowserCdpPort;
  sessions(guest: WebContents): Map<string, { type?: string; frameId?: string; ready?: Promise<unknown> }>;
}

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

export const BROWSER_OBSERVATION_REVISION = `(() => {
  let state = globalThis.__mixdogObservationRevision;
  if (!state) {
    state = { version: 0, roots: new WeakSet() };
    globalThis.__mixdogObservationRevision = state;
    const changed = () => { state.version++; };
    state.observer = new MutationObserver(changed);
    for (const event of ['input', 'change', 'scroll', 'pointerdown', 'keydown']) {
      document.addEventListener(event, changed, true);
    }
  }
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    if (!state.roots.has(root)) {
      state.observer.observe(root, {subtree: true, childList: true, attributes: true, characterData: true});
      state.roots.add(root);
    }
  }
  if (state.observer.takeRecords().length) state.version++;
  return [performance.timeOrigin, state.version, innerWidth, innerHeight, scrollX, scrollY].join(':');
})()`;

export function createBrowserDocuments(host: DocumentsHost) {
  async function collect<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T[]> {
    await host.cdp.guestDebugger(guest);
    const targets = [
      { sessionId: undefined as string | undefined, frameId: undefined as string | undefined },
      ...[...host.sessions(guest)].filter(([, target]) => target.type === 'iframe')
        .map(([sessionId, target]) => ({ sessionId, frameId: target.frameId, ready: target.ready })),
    ];
    if (targets.length > 32) throw new Error('too many frame targets for a complete observation');
    const frames = new Map<string, string | undefined>();
    for (const target of targets) {
      if ('ready' in target) await target.ready;
      const tree = await host.cdp.call<{ frameTree: FrameTree }>(
        guest, 'Page.getFrameTree', {}, signal, target,
      );
      const visit = (node: FrameTree) => {
        if (!frames.has(node.frame.id)) frames.set(node.frame.id, target.sessionId);
        for (const child of node.childFrames || []) visit(child);
      };
      visit(tree.frameTree);
      if (target.frameId) frames.set(target.frameId, target.sessionId);
    }
    if (frames.size > 64) throw new Error('too many frames for a complete observation');
    const output: T[] = [];
    for (const [frameId, sessionId] of frames) {
      const { executionContextId } = await host.cdp.call<{ executionContextId: number }>(
        guest, 'Page.createIsolatedWorld', { frameId, worldName: 'mixdog-observation' }, signal, { sessionId },
      );
      const result = await host.cdp.call<{
        result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(guest, 'Runtime.evaluate', {
        expression, contextId: executionContextId, returnByValue: true, awaitPromise: true,
      }, signal, { sessionId });
      if (result.exceptionDetails || result.result?.value === undefined) {
        throw new Error(`frame observation failed: ${result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || 'missing result'}`);
      }
      output.push(result.result.value);
    }
    return output;
  }

  async function pageText(guest: WebContents, signal?: AbortSignal): Promise<string> {
    const texts = await collect<string>(guest, BROWSER_DOCUMENT_TEXT, signal);
    if (texts.reduce((size, text) => size + text.length, 0) > 1_000_000) {
      throw new Error('combined frame text exceeded observation limit');
    }
    return texts.join('\n');
  }

  async function readPage(guest: WebContents, query: string, maxChars: number, offset: number, signal?: AbortSignal) {
    let text = (await pageText(guest, signal)).replace(/\n{3,}/g, '\n\n').trim();
    if (query) {
      const lines = text.split('\n');
      const matches = new Set<number>();
      lines.forEach((line, index) => {
        if (!line.toLowerCase().includes(query)) return;
        for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) matches.add(i);
      });
      text = [...matches].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
    }
    offset = Math.min(offset, text.length);
    return { url: guest.getURL(), title: guest.getTitle(), text: text.slice(offset, offset + maxChars), total: text.length, offset };
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
  return { collect, pageText, readPage, extractPage, revision };
}
