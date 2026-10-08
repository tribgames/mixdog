// Shared browser pages for the loopback OAuth callbacks (success / failure).

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="44 44 168 168" aria-hidden="true">
  <defs>
    <linearGradient id="titanium-a" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <linearGradient id="titanium-b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1"/><stop offset="50%" stop-color="#475569"/><stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="titanium-c" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/><stop offset="50%" stop-color="#334155"/><stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke-width="22" stroke-linecap="round">
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#titanium-a)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#titanium-b)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#titanium-c)"/>
  </g>
  <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="#cbd5e1"/>
  <circle cx="128" cy="128" r="3.5" fill="#07080b"/>
  <circle cx="128" cy="128" r="1.5" fill="#ffffff"/>
</svg>`;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPage({ heading, message, details }) {
  const title = escapeHtml(heading);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Mixdog</title>
  <style>
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #07080b;
      color: #f8fafc;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      text-align: center;
    }
    main { width: 100%; max-width: 560px; display: flex; flex-direction: column; align-items: center; }
    .logo { width: 72px; height: 72px; margin-bottom: 24px; }
    .logo svg { width: 100%; height: 100%; display: block; }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: #94a3b8; font-size: 15px; }
    .details {
      margin-top: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${title}</h1>
    <p>${escapeHtml(message)}</p>
    ${details ? `<div class="details">${escapeHtml(details)}</div>` : ''}
  </main>
</body>
</html>`;
}

export const OAUTH_PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';

export function oauthSuccessHtml(providerName) {
  return renderPage({
    heading: 'Authentication successful',
    message: `Signed in to ${providerName}. You can close this tab and return to Mixdog.`,
  });
}

export function oauthErrorHtml(message, details) {
  return renderPage({ heading: 'Authentication failed', message, details });
}
