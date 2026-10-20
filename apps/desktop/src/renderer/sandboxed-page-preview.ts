// Full-window viewer for a remote local-page preview. The frame has
// `sandbox="allow-scripts"` and deliberately NOT `allow-same-origin`: an opaque
// origin with no access to this app's storage, pairing token or RPC socket.
// It loads the relay's /preview-frame page (own CSP permitting inline script)
// and receives the document by postMessage, so the page's scripts run. A
// srcdoc document inherits the relay page's CSP (no inline script), so that is
// only the fallback: markup, styles and images render, scripts stay inert.
import { withHeadScript, withSandboxStorageShim } from '../shared/sandbox-storage-shim';
import { t } from './i18n';
import { registerMobileBack } from './mobile-back';

const PREVIEW_FRAME_PATH = '/preview-frame';
const PREVIEW_READY = 'mixdog-preview-ready';
const PREVIEW_DOCUMENT = 'mixdog-preview-document';
export const PREVIEW_LINK = 'mixdog-preview-link';
const PREVIEW_READY_TIMEOUT_MS = 3000;
const MAX_LINK_LENGTH = 8192;
/** Frames loadSandboxedPage navigated once already. */
const loadedFrames = new WeakSet<HTMLIFrameElement>();

/** The in-page half of link handling (plain ES5, no `</script`). A link
 *  click would navigate the frame itself away from the page, onto an address
 *  the app's frame policy refuses: the page went blank and stayed blank. The
 *  click is cancelled instead and the address handed to the app; in-page
 *  `#anchors`, `javascript:` links and clicks the page handles itself keep
 *  their own behaviour. */
const PREVIEW_LINK_SCRIPT = `(function () {
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;
  window.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var node = event.target;
    while (node && !(node.nodeType === 1 && /^(a|area)$/i.test(node.nodeName) && (node.hasAttribute('href') || node.hasAttribute('xlink:href')))) node = node.parentNode;
    if (!node) return;
    var raw = String(node.getAttribute('href') || node.getAttribute('xlink:href') || '').trim();
    if (/^javascript:/i.test(raw)) return;
    if (raw.charAt(0) === '#') {
      // Replaced, not pushed: an in-frame history entry would take the
      // phone's Back press meant for the app's panel. (A page that calls
      // history.pushState itself still adds one; its own Back/Forward needs it.)
      event.preventDefault();
      try { location.replace(raw); } catch (error) {}
      return;
    }
    event.preventDefault();
    var href;
    try { href = new URL(raw, document.baseURI).href; } catch (error) { return; }
    parentWindow.postMessage({ type: ${JSON.stringify(PREVIEW_LINK)}, href: href }, '*');
  });
})();`;

/** `html` as the sandboxed frame receives it: the storage shim first (the
 *  opaque origin makes localStorage/sessionStorage throw), then the link
 *  handler, then the page. */
export function sandboxedPageDocument(html: string): string {
  return withSandboxStorageShim(withHeadScript(html, PREVIEW_LINK_SCRIPT));
}

/** Opens a link the page handed over: an outside web address in a new tab
 *  of this browser, without an opener or referrer. Anything else (the app's
 *  own origin, which a relative link resolves to, or another scheme) stays
 *  unopened. */
function openPageLink(href: unknown): void {
  if (typeof href !== 'string' || href.length > MAX_LINK_LENGTH) return;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin === window.location.origin) return;
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

/** Loads `srcdoc` into a `sandbox="allow-scripts"` frame: through the relay's
 *  /preview-frame page when it answers, else as a plain srcdoc. Returns the
 *  cleanup. Shared by the full-window viewer and the visualize panel. */
export function loadSandboxedPage(frame: HTMLIFrameElement, page: string): () => void {
  const srcdoc = sandboxedPageDocument(page);
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; href?: unknown } | null;
    if (!data) return;
    if (data.type === PREVIEW_LINK) {
      openPageLink(data.href);
      return;
    }
    if (sent || data.type !== PREVIEW_READY) return;
    sent = true;
    clearTimeout(fallbackTimer);
    frame.contentWindow?.postMessage({ type: PREVIEW_DOCUMENT, html: srcdoc }, '*');
  };
  let sent = false;
  const fallbackTimer = setTimeout(() => {
    if (sent) return;
    sent = true;
    frame.removeAttribute('src');
    frame.srcdoc = srcdoc;
  }, PREVIEW_READY_TIMEOUT_MS);
  window.addEventListener('message', onMessage);
  // A frame that already shows a page reloads in place by replacing its
  // entry: a pushed in-frame entry would take the phone's next Back press
  // meant for the panel (the top window sees no popstate for it).
  const shown = frame.contentWindow && loadedFrames.has(frame);
  loadedFrames.add(frame);
  if (shown) frame.contentWindow?.location.replace(new URL(PREVIEW_FRAME_PATH, window.location.href).href);
  else frame.src = PREVIEW_FRAME_PATH;
  return () => {
    clearTimeout(fallbackTimer);
    window.removeEventListener('message', onMessage);
  };
}

export function openSandboxedPagePreview(srcdoc: string, title: string): () => void {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', title);
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#fff;box-sizing:border-box;padding-bottom:env(safe-area-inset-bottom)';
  const bar = document.createElement('div');
  // The bar clears the notch / status bar on a phone.
  bar.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:calc(6px + env(safe-area-inset-top)) calc(10px + env(safe-area-inset-right)) 6px calc(10px + env(safe-area-inset-left));background:#222;color:#fff;font:13px sans-serif';
  const label = document.createElement('span');
  label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  label.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = t('Close');
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.cssText = 'flex:1;border:0;width:100%;background:#fff';
  // Preferred: the relay's /preview-frame page (own CSP, scripts allowed in an
  // opaque origin) receives the document by postMessage once it says it is
  // ready. If it never does (route missing), fall back to a plain srcdoc.
  const unload = loadSandboxedPage(frame, srcdoc);
  // The phone's back gesture closes the page instead of leaving the app.
  const unregisterBack = registerMobileBack(() => dismiss());
  const dismiss = (): void => {
    unregisterBack();
    unload();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss();
  };
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey, true);
  bar.append(label, close);
  overlay.append(bar, frame);
  document.body.append(overlay);
  return dismiss;
}
