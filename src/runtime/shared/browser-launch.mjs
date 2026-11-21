// Where a local Chrome/Chromium/Edge lives and how puppeteer-core launches it.
// Shared by web scraping and by the pptx HTML authoring path, so both find the
// same browser and honour the same sandbox switch.
import fs from 'node:fs';

import { isWSL } from './wsl.mjs';

function windowsBrowserPaths() {
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

const LINUX_NATIVE_BROWSER_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
];

// puppeteer-core cannot drive a Windows .exe as a Linux child process, so the
// /mnt/c entries are offered on plain Linux only, never under WSL.
function linuxBrowserPaths() {
  if (isWSL()) return LINUX_NATIVE_BROWSER_PATHS;
  return [
    ...LINUX_NATIVE_BROWSER_PATHS,
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
}

const MAC_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export const COMMON_BROWSER_PATHS = (() => {
  if (process.platform === 'win32') return windowsBrowserPaths();
  if (process.platform === 'linux') return linuxBrowserPaths();
  return MAC_BROWSER_PATHS;
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

// Observed CI failures: launches that never print the DevTools endpoint hit puppeteer's 30 s
// TimeoutError (it closes the child itself): retried once, never after `signal` aborted.
export async function launchPuppeteerBrowser(puppeteer, options, { signal = null } = {}) {
  try {
    return await puppeteer.launch(options);
  } catch (error) {
    if (error?.name !== 'TimeoutError' || signal?.aborted) throw error;
    return puppeteer.launch(options);
  }
}
