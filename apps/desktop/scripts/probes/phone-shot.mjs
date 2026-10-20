// Pair a headless, phone-emulated Chromium with an isolated dev instance over
// the LOCAL relay (probes/phone-relay.mjs) and screenshot the phone UI.
//
// Usage (from apps/desktop):
//   node scripts/probes/phone-shot.mjs --port=<cdpPort> --out=<dir> [--eval=<file.js> ...]
//     [--width=412 --height=915 --scale=1] [--chrome=<exe>]
// Writes <out>/phone-home.png after pairing, then for each --eval file runs it
// in the phone page (an async function BODY, e.g. click a button; its `return`
// value is printed under "results"), waits for it to settle and writes
// <out>/phone-<file name>.png. The instance's
// own desktop window is only read (relay URL) and asked to approve the pairing.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    out: { type: 'string' },
    eval: { type: 'string', multiple: true, default: [] },
    width: { type: 'string', default: '412' },
    height: { type: 'string', default: '915' },
    scale: { type: 'string', default: '1' },
    chrome: { type: 'string' },
  },
});
if (!values.port || !values.out)
  throw new Error('usage: phone-shot.mjs --port=<cdpPort> --out=<dir> [--eval=<file.js>]');
const chrome =
  values.chrome ||
  process.env.CHROME ||
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!chrome) throw new Error('No Chrome/Edge found; pass --chrome=<exe>.');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const out = resolve(values.out);
await mkdir(out, { recursive: true });

const desktop = await puppeteer.connect({ browserURL: `http://127.0.0.1:${values.port}`, defaultViewport: null });
const profile = await mkdtemp(join(tmpdir(), 'phone-shot-'));
let browser;
try {
  const home = (await desktop.pages()).find((page) => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
  if (!home) throw new Error(`No renderer page on CDP ${values.port}.`);
  // The first call activates remote access; the route exists once the relay registered the PC.
  let url;
  for (let attempt = 0; attempt < 30 && !url; attempt += 1) {
    url = (await home.evaluate(() => window.mixdogDesktop.getRemoteAccessInfo()))?.relayBrowserUrl;
    if (!url) await sleep(1000);
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url || '')) {
    throw new Error(`Instance is not on a loopback relay (relayBrowserUrl=${url}); start it with --relay.`);
  }

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
    args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.emulate({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    viewport: {
      width: Number(values.width),
      height: Number(values.height),
      deviceScaleFactor: Number(values.scale),
      isMobile: true,
      hasTouch: true,
    },
  });
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The desktop must approve the new browser; do it over the instance's own IPC.
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const claims = (await home.evaluate(() => window.mixdogDesktop.listRemoteClientClaims())) || [];
    for (const claim of claims)
      await home.evaluate((id) => window.mixdogDesktop.resolveRemoteClientClaim(id, true), claim.claimId);
    // The page reloads once when the approval lands; a destroyed context just means "poll again".
    ready = await page
      .evaluate(
        () =>
          document.documentElement.hasAttribute('data-mixdog-mobile-tabs') &&
          Boolean(document.querySelector('.workspace-tab-home'))
      )
      .catch(() => false);
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error(`Phone UI never became ready.\n${problems.join('\n')}`);
  await sleep(1500);

  const files = [];
  const results = {};
  const shoot = async (name) => {
    const file = join(out, `phone-${name}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  };
  await shoot('home');
  for (const script of values.eval) {
    const name = basename(script).replace(/\.[^.]+$/, '');
    const body = `(async () => { ${await readFile(script, 'utf8')} \n})()`;
    // First pairing can reload the page once more; a destroyed context means "run it again".
    results[name] = await page.evaluate(body).catch(async (error) => {
      if (!/context was destroyed/.test(error.message)) throw error;
      await sleep(3000);
      return page.evaluate(body);
    });
    await sleep(1500);
    await shoot(name);
  }
  console.log(
    JSON.stringify({ viewport: await page.evaluate(() => [innerWidth, innerHeight]), files, results, problems })
  );
} finally {
  await browser?.close().catch(() => {});
  await desktop.disconnect();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
