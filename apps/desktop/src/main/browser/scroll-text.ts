/**
 * Bringing a phrase into view. The roots here are the ones the readers already
 * use — the top document, every open shadow root, and each attached frame —
 * so `scroll text` can reach a phrase that `read` and a text postcondition
 * can see. Matching and scrolling are separate passes: every frame reports its
 * own match, the host picks one, and only that frame scrolls.
 */
import { BROWSER_DOCUMENT_ROOTS } from './documents';

export interface BrowserScrollTextMatch {
  /** Identifies the frame holding the match; the scroll pass answers to it. */
  token: string;
  found: boolean;
  /** The matched line, for the reply. */
  text?: string;
}

/** Elements whose text never paints, so a match inside one is not a place a
 *  reader could scroll to. */
const NON_RENDERED_TAGS = 'script|style|noscript|template|title';

export function browserScrollTextMatchExpression(wanted: string): string {
  return `(() => {
    const wanted = ${JSON.stringify(String(wanted).toLowerCase())};
    const token = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
    globalThis.__mixdogScrollToken = token;
    globalThis.__mixdogScrollTarget = null;
    const skipped = /^(${NON_RENDERED_TAGS})$/;
    const rendered = (element) => {
      const view = element.ownerDocument.defaultView;
      if (!view) return false;
      const rect = element.getBoundingClientRect();
      // Either dimension at zero means the line has no place on the page.
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = view.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    };
    for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
      const scope = root === document ? (document.body || document.documentElement) : root;
      const owner = root === document ? document : root.ownerDocument;
      if (!scope || !owner) continue;
      const walker = owner.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = String(node.textContent || '');
        if (!value.toLowerCase().includes(wanted)) continue;
        const element = node.parentElement;
        if (!element || skipped.test(String(element.tagName || '').toLowerCase())) continue;
        if (!rendered(element)) continue;
        globalThis.__mixdogScrollTarget = element;
        return { token, found: true, text: value.replace(/\\s+/g, ' ').trim().slice(0, 120) };
      }
    }
    return { token, found: false };
  })()`;
}

export function browserScrollTextApplyExpression(token: string): string {
  return `(() => {
    const mine = globalThis.__mixdogScrollToken === ${JSON.stringify(token)};
    const target = globalThis.__mixdogScrollTarget;
    // Every frame clears its own candidate, so a match never outlives the
    // observation that found it.
    globalThis.__mixdogScrollToken = null;
    globalThis.__mixdogScrollTarget = null;
    if (!mine || !target || !target.isConnected) return { scrolled: false };
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { scrolled: true };
  })()`;
}
