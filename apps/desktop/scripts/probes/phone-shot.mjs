// Usage (from apps/desktop):
//   node scripts/probes/phone-shot.mjs --out=<dir> [--port=<cdpPort>] [--eval=<file.eval> ...]
//     [--width=412 --height=915 --scale=1] [--chrome=<exe>]
// Without --port, reuses a running phone-relay isolated instance or starts one with the supervisor's built-in relay.
// Writes <out>/phone-home.png, then for each --eval file (an async function body; its `return` value is
// printed under "results") writes <out>/phone-<file name>.png.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';

import {
  assignCaptureBrowser,
  ensureInstance,
  findLeaseByPort,
  isolatedRoot,
  releaseCaptureBrowser,
} from '../dev-isolated.mjs';

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
if (!values.out)
  throw new Error('usage: phone-shot.mjs --out=<dir> [--port=<cdpPort>] [--eval=<file.eval>]');
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

const root = isolatedRoot();
let cdpPort = values.port;
if (!cdpPort) {
  const info = await ensureInstance({ root, phoneRelay: true });
  cdpPort = String(info.cdpPort);
}
const lease = await findLeaseByPort(root, cdpPort).catch(() => null);
if (lease && !/^ws:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(lease.relayUrl || '')) {
  throw new Error(`Instance is not on a loopback relay (relayUrl=${lease.relayUrl}); start it with --phone-relay.`);
}
const profileParent = lease?.instanceDir ? join(lease.instanceDir, 'capture-profiles') : tmpdir();
await mkdir(profileParent, { recursive: true });

const desktop = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null });
const profile = await mkdtemp(join(profileParent, 'phone-shot-'));
let browser;
let browserProc = null;
let browserExited = Promise.resolve();
let browserPid = null;
let cleaned = false;

const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await browser?.close().catch(() => {});
  if (browserProc && browserProc.exitCode === null && browserProc.signalCode === null) {
    try {
      browserProc.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }
  await browserExited;
  if (browserPid) {
    await releaseCaptureBrowser(lease, browserPid).catch(() => {});
  }
  await desktop.disconnect().catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

const onSignal = (signal) => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  // The app page itself: a paired instance also hosts remote-transport-peer.html on the same origin.
  const home = (await desktop.pages()).find((page) =>
    /^(?:http:\/\/127\.0\.0\.1:\d+\/|file:\/\/.*\/renderer\/index\.html)(?:[?#].*)?$/.test(page.url())
  );
  if (!home) throw new Error(`No renderer page on CDP ${cdpPort}.`);
  // Purely event-driven wait on the core's `remote` section push (no polling, no arbitrary timers):
  // wait until the core pushes the `remote` section, call getRemoteAccessInfo() to activate remote access,
  // and if the relay leg is still registering, wait for the next `remote` section update carrying relayBrowserUrl.
  // Core link close or CDP disconnect rejects immediately.
  const url = await home.evaluate(async () => {
    const api = window.mixdogDesktop;
    const hasRemoteSection = (entries) =>
      Array.isArray(entries) && entries.some((entry) => entry.section === 'remote' && entry.key === null);
    const waitForRemoteSection = () =>
      new Promise((resolveWait, rejectWait) => {
        const done = (fn, value) => {
          off();
          fn(value);
        };
        const off = api.sections.subscribe((push) => {
          if (push.kind === 'status' && push.status === 'closed') {
            done(rejectWait, new Error(push.link?.closed?.message || 'Core connection closed before remote section arrived.'));
            return;
          }
          if (
            (push.kind === 'sections' && push.changes.some((c) => c.section === 'remote' && c.key === null)) ||
            (push.kind === 'replace' && push.stage === 'commit')
          ) {
            api.sections
              .snapshot()
              .then((snap) => {
                if (hasRemoteSection(snap.entries)) done(resolveWait);
              })
              .catch((err) => done(rejectWait, err));
          }
        });
        api.sections
          .snapshot()
          .then((snap) => {
            if (hasRemoteSection(snap.entries)) done(resolveWait);
          })
          .catch((err) => done(rejectWait, err));
      });

    await waitForRemoteSection();
    const initial = await api.getRemoteAccessInfo();
    if (initial?.relayBrowserUrl) return initial.relayBrowserUrl;
    if (initial?.enabled === false) {
      throw new Error('Remote access is disabled on this instance.');
    }

    return await new Promise((resolveUrl, rejectUrl) => {
      let checking = false;
      const done = (fn, value) => {
        off();
        fn(value);
      };
      const check = () => {
        if (checking) return;
        checking = true;
        api
          .getRemoteAccessInfo({ activate: false })
          .then((info) => {
            checking = false;
            if (info?.relayBrowserUrl) done(resolveUrl, info.relayBrowserUrl);
            else if (info?.enabled === false) done(rejectUrl, new Error('Remote access is disabled on this instance.'));
          })
          .catch((err) => {
            checking = false;
            done(rejectUrl, err);
          });
      };
      const off = api.sections.subscribe((push) => {
        if (push.kind === 'status' && push.status === 'closed') {
          done(rejectUrl, new Error(push.link?.closed?.message || 'Core connection closed while waiting for relay.'));
          return;
        }
        if (
          (push.kind === 'sections' && push.changes.some((c) => c.section === 'remote' && c.key === null)) ||
          (push.kind === 'replace' && push.stage === 'commit')
        ) {
          check();
        }
      });
      check();
    });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url || '')) {
    throw new Error(`Instance is not on a loopback relay (relayBrowserUrl=${url}); start it with --phone-relay.`);
  }

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
    args: [
      '--no-first-run',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--js-flags=--max-old-space-size=256',
    ],
  });
  browserProc = browser.process();
  browserPid = browserProc?.pid ?? null;
  if (browserProc) {
    browserExited = new Promise((resolveExit) => {
      if (browserProc.exitCode !== null || browserProc.signalCode !== null) resolveExit();
      else browserProc.once('exit', () => resolveExit());
    });
  }
  if (lease && browserPid) {
    await assignCaptureBrowser(lease, browserPid, { ownerPid: process.pid, profileDir: profile }).catch(() => {});
  }
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
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await cleanup();
}
