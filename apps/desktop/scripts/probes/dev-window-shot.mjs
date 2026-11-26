// Usage (from apps/desktop):
//   node scripts/probes/dev-window-shot.mjs <cdpPort> <out.png> [--url=<page-url>]
//   node scripts/probes/dev-window-shot.mjs --out=<out.png> [--url=<page-url>]   (reuses or starts an isolated instance)
// Page.captureScreenshot never answers on detached helper pages, which never composite a frame.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { optionValue } from '../cli-args.mjs';
import { ensureInstance, isolatedRoot } from '../dev-isolated.mjs';
import { selectDomTarget } from '../dom-eval-target.mjs';

const CAPTURE_TIMEOUT_MS = 10_000;
const positionals = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
let port = optionValue('port') || null;
let out = optionValue('out') || null;
if (!port && !out) {
  if (positionals.length >= 2) {
    [port, out] = positionals;
  } else if (positionals.length === 1) {
    [out] = positionals;
  }
}
if (!out) {
  throw new Error('usage: dev-window-shot.mjs [<cdpPort>] <out.png> [--out=<out.png>] [--url=<page-url>]');
}

const root = isolatedRoot();
if (!port) {
  const info = await ensureInstance({ root });
  port = String(info.cdpPort);
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = selectDomTarget(targets, optionValue('url'));
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', () => rejectOpen(new Error('CDP websocket failed.')), { once: true });
});
const result = await new Promise((resolveShot, rejectShot) => {
  const timer = setTimeout(
    () => rejectShot(new Error(`Page.captureScreenshot on ${target.url} timed out after ${CAPTURE_TIMEOUT_MS} ms.`)),
    CAPTURE_TIMEOUT_MS
  );
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) rejectShot(new Error(message.error.message));
    else resolveShot(message.result);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
}).finally(() => socket.close());
const outPath = resolve(out);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, Buffer.from(result.data, 'base64'));
console.log(target.url, outPath);
process.exit(0);
