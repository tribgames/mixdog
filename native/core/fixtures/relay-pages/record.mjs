// Records what the Node pages answer: node record.mjs <relay lib dir> > golden.json
// (the lib dir is apps/relay/lib of a Mixdog tree; nothing is written but stdout).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = process.argv[2];
const load = (name) => import(pathToFileURL(join(lib, name)).href);
const { createAppPageHandler, createLatestHandler, readAndroidUrl, ANDROID_FALLBACK_URL } = await load('app-page.mjs');
const { sendConnectPage } = await load('connect-page.mjs');
const { sendUpdatePcPage } = await load('update-pc-page.mjs');

const APK = 'https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/Mixdog-0.1.13.apk';

// Runs a Node handler against a recording response: what writeHead got, in order, and what end got.
const reply = (run) => {
  const out = { status: null, headers: [], body: null };
  const response = {
    writeHead(status, head) {
      out.status = status;
      out.headers = Object.entries(head ?? {});
      return this;
    },
    end(body) {
      out.body = body === undefined ? null : body;
    },
  };
  run(response);
  return out;
};
const request = (method, userAgent) => ({ method, headers: userAgent === undefined ? {} : { 'user-agent': userAgent } });

const agents = [
  undefined,
  '',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
  'MixdogApp/1.2.3 ANDROID',
  'Mozilla/5.0 (Windows NT 10.0)',
];
const methods = ['GET', 'HEAD', 'POST', 'get'];

const golden = { apkUrl: APK, fallbackUrl: ANDROID_FALLBACK_URL, app: [], latest: [], connect: [], updatePc: [], readAndroidUrl: [] };
for (const androidUrl of [APK, ANDROID_FALLBACK_URL]) {
  for (const method of methods) {
    for (const userAgent of agents) {
      const r = reply((res) => createAppPageHandler(androidUrl)(request(method, userAgent), res));
      golden.app.push({ androidUrl, method, userAgent: userAgent ?? null, reply: r });
    }
    golden.latest.push({ androidUrl, method, reply: reply((res) => createLatestHandler(androidUrl)(request(method), res)) });
  }
}
for (const method of methods) {
  golden.connect.push({ method, reply: reply((res) => sendConnectPage(request(method), res)) });
}
const details = [
  { current: '', min: '' },
  { current: '0.9.1', min: '1.0.0' },
  { current: '0.9.1', min: '' },
  { current: '', min: '1.0.0' },
  { current: `<b a="x" b='y'>&amp;</b> @@MIN@@ 한`, min: `"><script>alert(1)</script>` },
];
for (const method of ['GET', 'HEAD', 'POST']) {
  for (const detail of details) {
    golden.updatePc.push({ method, ...detail, reply: reply((res) => sendUpdatePcPage(request(method), res, detail)) });
  }
}

const contents = [
  null,
  JSON.stringify({ androidUrl: APK }),
  JSON.stringify({ androidUrl: ANDROID_FALLBACK_URL }),
  '{not json',
  '﻿' + JSON.stringify({ androidUrl: APK }),
  'null',
  '[]',
  '"x"',
  '{}',
  JSON.stringify({ androidUrl: 42 }),
  JSON.stringify({ androidUrl: 'javascript:alert(1)' }),
  JSON.stringify({ androidUrl: `${APK}"><script>` }),
  JSON.stringify({ androidUrl: `${APK}\n` }),
  JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/a.zip' }),
  JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/download/mobile-v1.2/a.apk' }),
  JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/tag/mobile-v0.1.13' }),
  JSON.stringify({ androidUrl: 'https://github.com/other/repo/releases/download/mobile-v0.1.13/a.apk' }),
  '{"androidUrl":"https://github.com/tribgames/mixdog/releases","androidUrl":' + JSON.stringify(APK) + '}',
];
const warn = console.warn;
for (const text of contents) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-app-page-'));
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const file = join(dir, 'mobile-release.json');
    if (text !== null) writeFileSync(file, text);
    golden.readAndroidUrl.push({ contents: text, url: readAndroidUrl(file), warned: lines.length > 0 });
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify(golden, null, 1)}\n`);
