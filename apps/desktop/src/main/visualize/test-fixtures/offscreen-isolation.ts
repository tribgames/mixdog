/**
 * Real off-screen renders and snapshots in one Electron run: what a later or
 * an overlapping render of another artifact finds in origin-scoped storage,
 * and how many connections repeated renders open to the page server (here a
 * loopback stand-in for the core's page server: one origin, a token per page
 * folder). Prints one OFFSCREEN_ISOLATION_RESULT line.
 */
import { subscribe } from 'node:diagnostics_channel';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, session } from 'electron';

import { renderFileSnapshot } from '../../file-snapshot';
import { actPageOffscreen, inspectPageOffscreen, renderPageThumbnail } from '../export-render';

const directory = process.env.OFFSCREEN_ISOLATION_DIRECTORY as string;
app.setPath('userData', join(directory, 'user-data'));
app.on('window-all-closed', () => undefined);
// An external site on a name of its own, served from this process.
const EXTERNAL = 'cookies.test';
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${EXTERNAL} 127.0.0.1`);
// A self-signed test certificate for EXTERNAL (P-256, valid to 2126).
const EXTERNAL_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSwQZJpIAlCqcqhwz
uT+uxP1StopnjAo10tbsOUYn3H+hRANCAARvOl420e45ailgY+H+ohh/FlKNG1s8
ArzY9fzMO5vx/PAyaHqDPIgNuRD/0hGiZIP2SLUKU9WkZ+vjEnPkm5bV
-----END PRIVATE KEY-----`;
const EXTERNAL_CERT = `-----BEGIN CERTIFICATE-----
MIIBnjCCAUSgAwIBAgIUS2X7QZvK4gnpXF25UarZPxO8kxEwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMY29va2llcy50ZXN0MCAXDTI2MTEwNDIzMzYxNFoYDzIxMjYx
MDExMjMzNjE0WjAXMRUwEwYDVQQDDAxjb29raWVzLnRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARvOl420e45ailgY+H+ohh/FlKNG1s8ArzY9fzMO5vx/PAy
aHqDPIgNuRD/0hGiZIP2SLUKU9WkZ+vjEnPkm5bVo2wwajAdBgNVHQ4EFgQUukBY
fpgvcOB+h1oCINYJiRthxcUwHwYDVR0jBBgwFoAUukBYfpgvcOB+h1oCINYJiRth
xcUwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxjb29raWVzLnRlc3QwCgYI
KoZIzj0EAwIDSAAwRQIhAI2a5LMvW5HAubJOY2f3dnK+LiQi8LZOxilelabX6EpG
AiBMlJWsFiOBkDahMhXSFU2jA0JuJAwj0aHZG+xwXcn48A==
-----END CERTIFICATE-----`;

/** What the external site saw: each request's render tag and Cookie header. */
const externalSeen: Array<{ tag: string; path: string; cookie: string }> = [];

/** Sets a cookie named after the requesting render on every answer; a frame
 *  page also reports its script cookies and sets one more. */
function externalSite(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://x');
  const tag = url.searchParams.get('r') ?? '?';
  const secure = 'encrypted' in request.socket;
  externalSeen.push({ tag, path: `${secure ? 'https' : 'http'} ${url.pathname}`, cookie: request.headers.cookie ?? '' });
  response.setHeader('Set-Cookie', `site-${tag}=1; Path=/${secure ? '; SameSite=None; Secure' : ''}`);
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/frame') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<script>
      let cookies;
      try { cookies = document.cookie; document.cookie = 'script-${tag}=1; SameSite=None; Secure; Path=/'; }
      catch (error) { cookies = 'threw ' + error.name; }
      parent.postMessage({ frameCookies: cookies }, '*');
    </script>`);
    return;
  }
  response.setHeader('Content-Type', 'text/plain');
  response.end('ok');
}

/** Reads and writes every origin-scoped store a page can reach. */
const STORAGE = `<script>
const attempt = async (read) => { try { return await read(); } catch (error) { return 'threw ' + error.name; } };
const database = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('probe', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
window.storageState = async () => ({
  local: await attempt(() => localStorage.getItem('k')),
  idb: await attempt(async () => {
    const db = await database();
    return new Promise((resolve) => {
      const get = db.transaction('kv').objectStore('kv').get('k');
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => resolve('failed');
    });
  }),
  cookie: await attempt(() => document.cookie),
  caches: await attempt(async () => (await caches.keys()).join(',')),
  workers: await attempt(async () => (await navigator.serviceWorker.getRegistrations()).length),
});
window.writeStorage = async (tag) => {
  await attempt(() => localStorage.setItem('k', tag));
  await attempt(async () => {
    const db = await database();
    await new Promise((resolve) => {
      const put = db.transaction('kv', 'readwrite');
      put.objectStore('kv').put(tag, 'k');
      put.oncomplete = resolve;
      put.onerror = resolve;
    });
  });
  await attempt(() => { document.cookie = 'k=' + tag + '; max-age=3600; path=/'; });
  await attempt(async () => (await caches.open('c-' + tag)).put('/x', new Response(tag)));
  await attempt(() => navigator.serviceWorker.register('sw.js'));
};
</script>`;

const IMAGES = 12;

async function project(name: string): Promise<string> {
  const root = join(directory, name);
  await mkdir(root, { recursive: true });
  const images = Array.from({ length: IMAGES }, (_, i) => `<img src="a${i}.svg" width="8">`).join('');
  await writeFile(join(root, 'page.html'), `<!doctype html><title>${name}</title>${STORAGE}${images}`);
  // A snapshot cannot be asked anything: the page names what it found in
  // the URL of an image it requests.
  await writeFile(
    join(root, 'snap.html'),
    `<!doctype html><title>${name}</title>${STORAGE}<script>(async () => {
      const before = await storageState();
      await writeStorage(document.title);
      const after = await storageState();
      new Image().src = 'state-' + encodeURIComponent(JSON.stringify({ before, after })) + '.png';
    })();</script>`
  );
  await writeFile(join(root, 'sw.js'), '');
  // Workers that fetch the URL they are given and answer with the outcome.
  const fetchAndTell = `fetch(url).then((r) => r.status, (e) => 'refused ' + e.name)`;
  await writeFile(join(root, 'fetcher.js'), `onmessage = ({ data: url }) => ${fetchAndTell}.then(postMessage);`);
  await writeFile(
    join(root, 'shared-fetcher.js'),
    `onconnect = ({ ports: [port] }) => { port.onmessage = ({ data: url }) => ${fetchAndTell}.then((s) => port.postMessage(s)); };`
  );
  for (let i = 0; i < IMAGES; i++) {
    await writeFile(join(root, `a${i}.svg`), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  }
  return root;
}

const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const folders = new Map<string, string>();
let pageServer: ReturnType<typeof createHttpServer> | undefined;

/** The page server's stand-in: `/<token>/<file>` answers the file of the folder the token names. */
async function servePage(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const [, token = '', ...rest] = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).split('/');
  const folder = folders.get(token);
  const file = normalize(rest.join('/'));
  if (!folder || file.startsWith('..')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(folder, file));
    response.writeHead(200, { 'Content-Type': PAGE_TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}

const pageOf = (root: string) => {
  const token = `t${folders.size}`;
  folders.set(token, root);
  return `http://127.0.0.1:${(pageServer?.address() as AddressInfo).port}/${token}/page.html`;
};
const READ = 'storageState()';

/** A page's visit to the external site, as render `tag`: credentialed fetches
 *  over https and http, an image, and a frame that reports its cookies. */
const externalVisit = (tag: string, httpPort: number, httpsPort: number) => `(async () => {
  const query = '?r=${tag}';
  await fetch('https://${EXTERNAL}:${httpsPort}/fetch' + query, { credentials: 'include' }).catch(() => {});
  await fetch('http://${EXTERNAL}:${httpPort}/fetch' + query, { credentials: 'include' }).catch(() => {});
  await new Promise((done) => { const image = new Image(); image.onload = image.onerror = done; image.src = 'https://${EXTERNAL}:${httpsPort}/image' + query; });
  const frameCookies = await new Promise((done) => {
    addEventListener('message', (event) => done(event.data.frameCookies));
    const frame = document.createElement('iframe');
    frame.src = 'https://${EXTERNAL}:${httpsPort}/frame' + query;
    document.body.append(frame);
    setTimeout(() => done('no answer'), 5000);
  });
  return { frameCookies };
})()`;

/** What a page's workers get asking for `target`, and whether a service
 *  worker registers; `own` is a dedicated worker asking for the page itself. */
const workerProbe = (target: string) => `(async () => {
  const ask = (worker, port, url) => new Promise((done) => {
    port.onmessage = (event) => done(event.data);
    port.postMessage(url);
    setTimeout(() => done('no answer'), 5000);
  });
  const dedicated = new Worker('fetcher.js');
  const shared = new SharedWorker('shared-fetcher.js');
  shared.port.start();
  return {
    own: await ask(dedicated, dedicated, location.href),
    dedicated: await ask(dedicated, dedicated, ${JSON.stringify(target)}),
    shared: await ask(shared, shared.port, ${JSON.stringify(target)}),
    serviceWorker: await navigator.serviceWorker.register('sw.js').then(() => 'registered', (error) => 'rejected ' + error.name),
  };
})()`;
const writeThenRead = (tag: string) => `(async () => { await writeStorage(${JSON.stringify(tag)}); return storageState(); })()`;

async function run() {
  // The test certificate is trusted for EXTERNAL only, on the renders' session.
  session
    .fromPartition('visualize-offscreen', { cache: false })
    .setCertificateVerifyProc(({ hostname }, verified) => verified(hostname === EXTERNAL ? 0 : -3));
  const plain = createHttpServer(externalSite);
  const secure = createHttpsServer({ key: EXTERNAL_KEY, cert: EXTERNAL_CERT }, externalSite);
  await Promise.all([plain, secure].map((server) => new Promise<void>((done) => server.listen(0, '127.0.0.1', done))));
  const [httpPort, httpsPort] = [plain, secure].map((server) => (server.address() as AddressInfo).port);

  pageServer = createHttpServer((request, response) => void servePage(request, response));
  await new Promise<void>((done) => pageServer?.listen(0, '127.0.0.1', done));
  const [first, second] = await Promise.all([project('artifact-a'), project('artifact-b')]);
  const [pageA, pageB] = [pageOf(first), pageOf(second)];
  const port = (pageServer.address() as AddressInfo).port;
  let accepted = 0;
  subscribe('net.server.socket', (message) => {
    if ((message as { socket: Socket }).socket.localPort === port) accepted += 1;
  });

  // One after another: A writes, then B (another project) and A again read.
  const written = (await inspectPageOffscreen(pageA, false, writeThenRead('A'))).data;
  const laterOther = (await inspectPageOffscreen(pageB, false, READ)).data;
  const laterSame = (await inspectPageOffscreen(pageA, false, READ)).data;

  // At once: B reads while A, which has written, is still open.
  let wrote!: () => void;
  const hasWritten = new Promise<void>((resolve) => (wrote = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const writer = actPageOffscreen(
    pageA,
    false,
    async (exec) => {
      const state = await exec(writeThenRead('W'));
      wrote();
      await finished;
      return state;
    },
    { viewport: { width: 800, height: 600 }, capture: () => false }
  );
  await hasWritten;
  const overlapping = (await inspectPageOffscreen(pageB, false, READ)).data;
  finish();
  const overlapWritten = (await writer).data.result;

  // Two network-allowed renders visit the same external site in turn.
  const visitA = (await inspectPageOffscreen(pageA, true, externalVisit('A', httpPort, httpsPort))).data;
  const visitB = (await inspectPageOffscreen(pageB, true, externalVisit('B', httpPort, httpsPort))).data;
  const external = { visitA, visitB, seen: [...externalSeen] };

  // A network-allowed render's workers, given the URL of another render that is open.
  let opened!: (href: string) => void;
  const otherOpen = new Promise<string>((resolve) => (opened = resolve));
  let close!: () => void;
  const closing = new Promise<void>((resolve) => (close = resolve));
  const other = actPageOffscreen(
    pageB,
    false,
    async (exec) => {
      opened(String(await exec('location.href')));
      await closing;
    },
    { viewport: { width: 800, height: 600 }, capture: () => false }
  );
  const workers = (await inspectPageOffscreen(pageA, true, workerProbe(await otherOpen))).data;
  close();
  await other;

  // Repeated card pictures: connections the page server accepts meanwhile.
  accepted = 0;
  const renders = 12;
  for (let i = 0; i < renders; i++) await renderPageThumbnail(pageA, false);
  const thumbnailConnections = accepted;

  // Snapshots, one after another: B reports what it found, then wrote.
  const snapshot = (root: string) =>
    renderFileSnapshot({
      fileUrl: pathToFileURL(join(root, 'snap.html')).href,
      root,
      signal: new AbortController().signal,
    });
  await snapshot(first);
  const reported: string[] = [];
  const note = (details: { url: string }) => {
    if (details.url.includes('state-')) reported.push(details.url);
  };
  const snapshots = session.fromPartition('file-snapshot');
  snapshots.webRequest.onCompleted(note);
  snapshots.webRequest.onErrorOccurred(note);
  const picture = await snapshot(second);
  const match = /state-([^/?#]*)\.png/.exec(reported.at(-1) ?? '');
  const snapshotState = match ? JSON.parse(decodeURIComponent(match[1])) : null;

  return {
    written,
    laterOther,
    laterSame,
    overlapWritten,
    overlapping,
    external,
    workers,
    renders,
    thumbnailConnections,
    snapshotState,
    snapshotPicture: picture.slice(0, 22),
  };
}

app.whenReady().then(
  async () => {
    try {
      console.log(`OFFSCREEN_ISOLATION_RESULT ${JSON.stringify(await run())}`);
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  },
  () => app.exit(1)
);
