import fs from 'node:fs';

const COMMON_BROWSER_PATHS = (() => {
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES || 'C:/Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
    return [
      `${programFiles}/Google/Chrome/Application/chrome.exe`,
      `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
      localAppData && `${localAppData}/Google/Chrome/Application/chrome.exe`,
      `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
      `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
      localAppData && `${localAppData}/Microsoft/Edge/Application/msedge.exe`,
    ].filter(Boolean);
  }
  if (platform === 'linux') {
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    ];
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
})();

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) return executablePath;
  }
  return null;
}

let _inflight = null;

export async function loginOpenCodeGoConsoleWithBrowser({ timeoutMs = 300_000, onStatus } = {}) {
  if (_inflight) return _inflight;
  _inflight = _run({ timeoutMs, onStatus }).finally(() => { _inflight = null; });
  return _inflight;
}

async function _run({ timeoutMs, onStatus }) {
  const status = (msg) => { try { if (typeof onStatus === 'function') onStatus(msg); } catch {} };
  const executablePath = resolveExecutablePath();
  if (!executablePath) {
    throw new Error('No Chrome/Edge browser found. Set PUPPETEER_EXECUTABLE_PATH to a Chrome or Edge executable.');
  }

  const puppeteer = (await import('puppeteer-core')).default;
  let browser = null;
  let closed = false;
  const closeBrowser = async () => {
    if (closed) return;
    closed = true;
    try { if (browser) await browser.close(); } catch {}
  };

  try {
    status('Launching browser…');
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      defaultViewport: null,
      args: ['--disable-dev-shm-usage'],
    });

    let disconnected = false;
    browser.on('disconnected', () => { disconnected = true; });

    const page = (await browser.pages())[0] || (await browser.newPage());
    status('Opening opencode.ai/auth — please sign in…');
    await page.goto('https://opencode.ai/auth', { waitUntil: 'domcontentloaded' }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (disconnected || page.isClosed()) {
        throw new Error('Browser was closed before login completed.');
      }
      let cookies;
      try {
        cookies = await page.cookies('https://opencode.ai');
      } catch {
        throw new Error('Browser was closed before login completed.');
      }
      const auth = cookies.find(c => c.name === 'auth');
      const url = page.url();
      const wsMatch = url.match(/\/workspace\/(wrk_[a-zA-Z0-9]+)/);
      // Only treat the login as complete on an authenticated console page.
      // A pre-existing/stale auth cookie on a marketing or docs page must not
      // short-circuit the flow with workspaceId:null.
      const onWorkspace = (() => {
        try {
          const parsed = new URL(url);
          return parsed.hostname.endsWith('opencode.ai') && /^\/(?:[a-z-]+\/)?workspace(\/|$)/.test(parsed.pathname);
        } catch {
          return false;
        }
      })();
      if (auth && auth.value && (wsMatch || onWorkspace)) {
        status('Auth cookie captured.');
        return { authCookie: auth.value, workspaceId: wsMatch?.[1] || null };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OpenCode Go login.`);
  } finally {
    await closeBrowser();
  }
}
