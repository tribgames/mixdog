// Screenshot the running dev app's main renderer page over CDP (no OS input).
// Usage (from apps/desktop): node scripts/probes/dev-window-shot.mjs <cdpPort> <out.png> [--url=<page-url>]
//
// The app also exposes detached helper pages (for example the browser cookie
// target at about:blank). They never composite a frame, so
// Page.captureScreenshot on them never answers; the shared target selector
// skips them instead of taking the first page in /json/list.
import { writeFile } from 'node:fs/promises';

import { optionValue } from '../cli-args.mjs';
import { selectDomTarget } from '../dom-eval-target.mjs';

const CAPTURE_TIMEOUT_MS = 10_000;
const [port = '9342', out] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (!out) throw new Error('usage: dev-window-shot.mjs <cdpPort> <out.png> [--url=<page-url>]');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = selectDomTarget(targets, optionValue('url'));
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('CDP websocket failed.')), { once: true });
});
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Page.captureScreenshot on ${target.url} timed out after ${CAPTURE_TIMEOUT_MS} ms.`)),
    CAPTURE_TIMEOUT_MS
  );
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
}).finally(() => socket.close());
await writeFile(out, Buffer.from(result.data, 'base64'));
console.log(target.url, out);
process.exit(0);
