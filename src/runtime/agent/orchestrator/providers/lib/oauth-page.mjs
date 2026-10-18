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

// The callback servers do not know the app language, so the default is
// bilingual (Korean first). A known language picks one copy.
const COPY = {
  ko: {
    successTitle: '로그인 완료',
    successBody: (name) => `${name} 로그인이 완료되었습니다. 이 탭을 닫고 Mixdog로 돌아가 주세요.`,
    failureTitle: '로그인 실패',
    failureBody: 'Mixdog로 돌아가 다시 시도해 주세요.',
    reason: '사유',
    close: '닫기',
  },
  en: {
    successTitle: 'Sign-in complete',
    successBody: (name) => `You are signed in to ${name}. You can close this tab and return to Mixdog.`,
    failureTitle: 'Sign-in failed',
    failureBody: 'Return to Mixdog and try again.',
    reason: 'Reason',
    close: 'Close',
  },
};

function renderPage({ kind, providerName, reason, lang }) {
  const langs = lang === 'ko' || lang === 'en' ? [lang] : ['ko', 'en'];
  const blocks = langs
    .map((code, index) => {
      const copy = COPY[code];
      const title = kind === 'success' ? copy.successTitle : copy.failureTitle;
      const body = kind === 'success' ? copy.successBody(providerName) : copy.failureBody;
      const tag = index === 0 ? 'h1' : 'h2';
      return `<section lang="${code}" class="${index === 0 ? 'primary' : 'secondary'}">
      <${tag}>${escapeHtml(title)}</${tag}>
      <p>${escapeHtml(body)}</p>
    </section>`;
    })
    .join('\n    ');
  const reasonBlock = reason
    ? `<div class="reason"><span>${langs.map((code) => COPY[code].reason).join(' / ')}</span>${escapeHtml(reason)}</div>`
    : '';
  const close = langs.map((code) => COPY[code].close).join(' · ');
  const documentTitle = escapeHtml(
    `${langs.map((code) => COPY[code][kind === 'success' ? 'successTitle' : 'failureTitle']).join(' / ')} · Mixdog`
  );
  return `<!doctype html>
<html lang="${langs[0]}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>${documentTitle}</title>
  <style>
    :root { --bg: #f6f7f9; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #d9dee6; --ok: #15803d; --bad: #b91c1c; --link: #1d4ed8; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #07080b; --fg: #f8fafc; --muted: #94a3b8; --card: #0f1116; --line: #232733; --ok: #4ade80; --bad: #f87171; --link: #93c5fd; }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg);
      color: var(--fg);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", Roboto, Arial, sans-serif;
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 520px;
      padding: 40px 32px 32px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .logo { width: 72px; height: 72px; margin-bottom: 20px; }
    .logo svg { width: 100%; height: 100%; display: block; }
    h1, h2 { margin: 0 0 6px; line-height: 1.2; font-weight: 650; }
    h1 { font-size: 28px; color: ${kind === 'success' ? 'var(--ok)' : 'var(--bad)'}; }
    h2 { font-size: 16px; color: var(--muted); font-weight: 600; }
    p { margin: 0; line-height: 1.7; color: var(--muted); font-size: 15px; }
    section.secondary { margin-top: 18px; }
    .reason {
      margin-top: 20px;
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      text-align: left;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      color: var(--fg);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .reason span { display: block; margin-bottom: 4px; color: var(--muted); font-family: inherit; font-size: 12px; }
    button {
      margin-top: 24px;
      min-width: 120px;
      height: 40px;
      padding: 0 20px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { border-color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    ${blocks}
    ${reasonBlock}
    <button type="button" onclick="window.close()">${escapeHtml(close)}</button>
  </main>
</body>
</html>`;
}

export const OAUTH_PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';

export function oauthSuccessHtml(providerName, { lang } = {}) {
  return renderPage({ kind: 'success', providerName, lang });
}

export function oauthErrorHtml(reason, { lang } = {}) {
  return renderPage({ kind: 'failure', reason, lang });
}
