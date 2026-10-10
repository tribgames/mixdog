// Full-window viewer for a remote local-page preview. The frame has
// `sandbox="allow-scripts"` and deliberately NOT `allow-same-origin`: an opaque
// origin with no access to this app's storage, pairing token or RPC socket.
// It loads the relay's /preview-frame page (own CSP permitting inline script)
// and receives the document by postMessage, so the page's scripts run. A
// srcdoc document inherits the relay page's CSP (no inline script), so that is
// only the fallback: markup, styles and images render, scripts stay inert.
import { t } from './i18n';

const PREVIEW_FRAME_PATH = '/preview-frame';
const PREVIEW_READY = 'mixdog-preview-ready';
const PREVIEW_DOCUMENT = 'mixdog-preview-document';
const PREVIEW_READY_TIMEOUT_MS = 3000;

export function openSandboxedPagePreview(srcdoc: string, title: string): () => void {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', title);
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#fff';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#222;color:#fff;font:13px sans-serif';
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
  const onMessage = (event: MessageEvent): void => {
    if (sent || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== PREVIEW_READY) return;
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
  frame.src = PREVIEW_FRAME_PATH;
  const dismiss = (): void => {
    clearTimeout(fallbackTimer);
    window.removeEventListener('message', onMessage);
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
