// Local-only phone preview: serve the CURRENT renderer into an Android
// emulator/device WebView WITHOUT deploying or touching the relay.
//
//   1. Build the renderer to a temp folder (does not touch out/):
//        $env:MIXDOG_ELECTRON_BUILD_TARGETS='renderer'
//        node node_modules/electron-vite/dist/cli.js build --outDir <tmp>/bundle
//   2. Run (keep it running; Ctrl+C stops it and the app goes back to the relay bundle on next reload):
//        node scripts/phone-local-bundle.mjs --bundle=<tmp>/bundle/renderer [--serial=emulator-5554] [--no-reload]
//
// It adb-forwards the Mixdog WebView devtools socket, then uses CDP
// Fetch.enable/fulfillRequest to answer the relay origin's GET requests
// (`/d/<id>/...`) from the local bundle. Nothing is uploaded; reloading the app
// without this script running shows the relay's bundle again. Re-attaches
// automatically when the app restarts (new devtools socket / page).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const root = resolve(args.bundle || '');
if (!args.bundle || !existsSync(join(root, 'index.html')))
  throw new Error('--bundle=<dir containing index.html> required');
const serial = args.serial || 'emulator-5554';
const port = Number(args.port || 9555);
const adb = process.env.ADB || join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adbRun = (...a) => execFileSync(adb, ['-s', serial, ...a], { encoding: 'utf8' });

function forwardWebView() {
  const sockets = [...adbRun('shell', 'cat /proc/net/unix').matchAll(/@(webview_devtools_remote_\d+)/g)].map(
    (m) => m[1]
  );
  if (!sockets.length) return false;
  adbRun('forward', `tcp:${port}`, `localabstract:${sockets[sockets.length - 1]}`);
  return true;
}

function bootHash() {
  const m = readFileSync(join(root, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/);
  return m ? `sha256-${createHash('sha256').update(m[1]).digest('base64')}` : null;
}

async function session(target, reload) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const n = ++id;
      waiting.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const origin = new URL(target.url).origin;
  const prefix = new URL(target.url).pathname.replace(/[^/]*$/, '');
  let csp = null;
  const hash = bootHash();
  const pattern = { urlPattern: `${origin}${prefix}*` };
  let served = 0;
  const handle = async (m) => {
    const { requestId, request } = m.params;
    const sessionId = m.sessionId;
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname.slice(prefix.length));
    const file = normalize(join(root, rel === '' ? 'index.html' : rel));
    if (request.method !== 'GET' || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      await send('Fetch.continueRequest', { requestId }, sessionId);
      return;
    }
    const headers = [
      { name: 'content-type', value: MIME[extname(file)] || 'application/octet-stream' },
      { name: 'cache-control', value: 'no-store' },
      { name: 'cross-origin-resource-policy', value: 'same-origin' },
    ];
    if (file.endsWith('index.html') && csp)
      headers.push({ name: 'content-security-policy', value: hash ? csp.replace(/'sha256-[^']+'/, `'${hash}'`) : csp });
    await send(
      'Fetch.fulfillRequest',
      { requestId, responseCode: 200, responseHeaders: headers, body: readFileSync(file).toString('base64') },
      sessionId
    );
    if (++served % 50 === 1) console.log(`served ${served}: ${rel || 'index.html'}`);
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m.result);
      waiting.delete(m.id);
      return;
    }
    if (m.method === 'Fetch.requestPaused') handle(m);
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      send('Fetch.enable', { patterns: [pattern] }, sid).then(() => send('Runtime.runIfWaitingForDebugger', {}, sid));
    }
  });
  const closed = new Promise((r) => ws.addEventListener('close', r, { once: true }));
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  const probe = await send('Runtime.evaluate', {
    expression: `fetch(location.href,{cache:'no-store'}).then(r=>r.headers.get('content-security-policy'))`,
    awaitPromise: true,
    returnByValue: true,
  });
  csp = probe?.result?.value || null;
  await send('Fetch.enable', { patterns: [pattern] });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  console.log(`intercepting ${origin}${prefix} from ${root}`);
  if (reload) await send('Page.reload', { ignoreCache: true });
  await closed;
}

let first = args['no-reload'] !== 'true';
process.on('SIGINT', () => {
  console.log('stopped; reload the app to see the relay bundle again');
  process.exit(0);
});
for (;;) {
  try {
    if (forwardWebView()) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && /^https?:/.test(t.url));
      if (page) {
        await session(page, first);
        first = false;
        console.log('detached; re-attaching');
      }
    }
  } catch (error) {
    console.log(`waiting: ${error.message}`);
  }
  await sleep(1500);
}
