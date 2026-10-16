// Where a local Chrome/Chromium/Edge lives and how puppeteer-core launches it.
// Shared by web scraping and by the pptx HTML authoring path, so both find the
// same browser and honour the same sandbox switch.
import fs from 'node:fs';

import { isWSL } from './wsl.mjs';

export const COMMON_BROWSER_PATHS = (() => {
  const platform = process.platform;
  if (platform === 'win32') {
    // Derive install roots from the environment so non-C: installs and the
    // per-user %LOCALAPPDATA% Chrome install are covered. Fall back to the
    // canonical C: paths (well-known locations, not guessed defaults) when an
    // env var is unset.
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
    // Native-Linux Chromium/Chrome binaries first. The /mnt/c Windows .exe
    // entries are reachable from WSL's filesystem but puppeteer-core CANNOT
    // drive a Windows GUI browser as a Linux child process (CDP over a pipe to
    // a Win32 binary launched from the Linux ABI does not work), so advertising
    // puppeteer-available off a Windows .exe yields launch failures at runtime.
    // Only offer the Windows .exe fallbacks on plain Linux (Wine/dual-mount
    // edge cases), never under WSL.
    const linuxNative = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    ];
    if (isWSL()) return linuxNative;
    return [
      ...linuxNative,
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ];
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
})();

export function localBrowserAvailable() {
  return Boolean(
    (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) ||
      COMMON_BROWSER_PATHS.some((item) => fs.existsSync(item))
  );
}

export function resolveBrowserLaunchOptions() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH };
  }

  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) {
      return { executablePath };
    }
  }

  return { channel: 'chrome' };
}

function puppeteerNoSandboxEnabled() {
  const raw = (process.env.PUPPETEER_NO_SANDBOX || process.env.MIXDOG_PUPPETEER_NO_SANDBOX || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function buildPuppeteerLaunchArgs(extra = []) {
  const args = ['--disable-dev-shm-usage', ...extra];
  if (puppeteerNoSandboxEnabled()) args.push('--no-sandbox');
  return args;
}

// A healthy headless launch answers in a few seconds; the observed CI failures
// are launches that never print the DevTools endpoint and hit puppeteer's 30 s
// TimeoutError (Windows runner, Linux runner). Puppeteer closes that child
// itself, so one fresh attempt is the remedy; a longer wait would only delay
// the same hang. Any other launch error (missing executable, bad args), or a
// timeout after `signal` aborted, is not retried.
export async function launchPuppeteerBrowser(puppeteer, options, { signal = null } = {}) {
  try {
    return await puppeteer.launch(options);
  } catch (error) {
    if (error?.name !== 'TimeoutError' || signal?.aborted) throw error;
    return puppeteer.launch(options);
  }
}
