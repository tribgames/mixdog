// The browser session every HTML authoring route (pptx, pdf, docx, xlsx) lays its document out in: launch, the
// deadline and abort wiring around the layout work, the failure result, and the photographs of captured elements.
import { join } from 'node:path';

import {
  buildPuppeteerLaunchArgs,
  launchPuppeteerBrowser,
  resolveBrowserLaunchOptions,
} from '../../shared/browser-launch.mjs';
import { startChildGuardian } from '../../shared/child-guardian.mjs';

/** Launches the local browser the HTML is laid out in, under a guardian that reaps it with this process. */
export async function launchHtmlBrowser(label, { signal = null } = {}) {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await launchPuppeteerBrowser(
    puppeteer,
    {
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: buildPuppeteerLaunchArgs(['--font-render-hinting=none']),
    },
    { signal }
  );
  try {
    startChildGuardian({ childPid: browser.process?.()?.pid, label });
  } catch {}
  return browser;
}

/** Runs `work` against the browser under a deadline and an abort signal, and closes the browser afterwards. */
export async function runInBrowser(browser, { signal, timeoutMs }, work) {
  const abort = () => browser.close().catch(() => {});
  // A cancel that landed while the browser was launching closes it at once.
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timer = null;
  const running = work();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HTML layout exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

/** The result of a route whose browser or layout failed. */
export function htmlFailure(error, startedAt, extra = {}) {
  return {
    ok: false,
    error: { message: error?.message || String(error) },
    elapsedMs: Math.round(performance.now() - startedAt),
    ...extra,
  };
}

/** Photographs each element the measure tagged `[attribute="1".."count"]` into `scratch`; index → png path. */
export async function photographCaptures(page, attribute, count, scratch) {
  const captures = new Map();
  for (let index = 1; index <= count; index += 1) {
    const element = await page.$(`[${attribute}="${index}"]`);
    if (!element) continue;
    const path = join(scratch, `capture-${index}.png`);
    await element.screenshot({ path, omitBackground: true });
    captures.set(index, path);
  }
  return captures;
}
