// The static page of main's confirm surface (developer-risk-confirm.ts): the app's confirm card (title, muted body,
// quiet Cancel, danger action) as plain HTML and CSS. It carries no script and its CSP allows none; the surface's own
// preload binds the buttons.
import { HOST_CONFIRM_SURFACE_IDS as IDS } from '../shared/host-confirm-surface';

export interface HostConfirmText {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The app's dialog tokens (desktop/30-dialogs.css), in both schemes; the scheme follows the app's theme (nativeTheme).
const STYLE = `
:root { color-scheme: dark; --bg: #1c1c1e; --border: rgba(255,255,255,.08); --text: #ececec; --muted: #a1a1a6;
  --action: rgba(255,255,255,.07); --hover: rgba(255,255,255,.12); --danger: #ff6b61; --danger-bg: rgba(255,107,97,.14);
  --ring: #6aa1ff; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --bg: #ffffff; --border: rgba(0,0,0,.1);
  --text: #1d1d1f; --muted: #6e6e73; --action: rgba(0,0,0,.05); --hover: rgba(0,0,0,.09); --danger: #d93025;
  --danger-bg: rgba(217,48,37,.1); --ring: #2f6fe4; } }
html, body { margin: 0; background: var(--bg); color: var(--text); overflow: hidden;
  font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; user-select: none; }
#${IDS.card} { box-sizing: border-box; border: 1px solid var(--border); }
h3 { margin: 0; padding: 16px 20px 12px; font-size: 16px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
p { margin: 0; padding: 0 20px 18px; color: var(--muted); white-space: pre-line; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 20px; }
button { min-height: 32px; padding: 0 13px; border: 0; border-radius: 8px; font: inherit; color: var(--text);
  background: var(--action); cursor: pointer; }
button:hover { background: var(--hover); }
button.danger { color: var(--danger); background: var(--danger-bg); font-weight: 600; }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
`;

/** The page as a data URL: nothing loads from outside it. */
export function hostConfirmPageUrl(text: HostConfirmText): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(text.title)}</title><style>${STYLE}</style></head>
<body><section id="${IDS.card}" role="alertdialog" aria-modal="true" aria-labelledby="title" aria-describedby="body">
<h3 id="title">${escapeHtml(text.title)}</h3><p id="body">${escapeHtml(text.description)}</p>
<footer><button id="${IDS.cancel}" type="button" autofocus>${escapeHtml(text.cancelLabel)}</button>
<button id="${IDS.accept}" type="button"${text.danger ? ' class="danger"' : ''}>${escapeHtml(text.confirmLabel)}</button>
</footer></section></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
