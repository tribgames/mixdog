/**
 * Local web pages for the session browser pane. The pane admits http(s) only,
 * so a page a chat link names is served from a loopback server: every root
 * folder gets its own unguessable `<token>.localhost` origin, and only web assets under that root
 * are served (no dotfiles, no source files). Data and document files are
 * served only inside the origin's data root, so a page's own styles, scripts,
 * fonts and media load while the rest of the disk stays unreachable.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileExtension } from '../shared/file-extension';

const PAGE_ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  wasm: 'application/wasm',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
});

/** Data and documents: served only inside an origin's `dataRoot`. */
const DATA_ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  pdf: 'application/pdf',
});

const LOOPBACK = '127.0.0.1';
interface PageOrigin {
  root: string;
  dataRoot: string;
}
const tokenOrigins = new Map<string, PageOrigin>();
const originTokens = new Map<string, string>();
let listening: Promise<number> | null = null;

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(String(status));
}

/** Mime of a web asset `file` that may be served from under `root` ('' when the
 *  path is outside it, hidden, or not a web asset). Presentation types are
 *  served anywhere under `root`; data and document types only under
 *  `dataRoot` (inside `root`, default `root`). Shared with the remote page
 *  preview so both surfaces expose the same files. */
export function pageAssetType(root: string, file: string, dataRoot: string = root): string {
  if (!inside(root, file)) return '';
  // Hidden segments are refused below the page's own folder chain: the folders
  // the user opened the page through may themselves be dot-named.
  let base = dataRoot;
  while (!inside(base, file) && base !== root) base = dirname(base);
  if (
    relative(base, file)
      .split(sep)
      .some((part) => part.startsWith('.'))
  ) {
    return '';
  }
  const extension = fileExtension(file);
  if (Object.hasOwn(PAGE_ASSET_TYPES, extension)) return PAGE_ASSET_TYPES[extension];
  if (Object.hasOwn(DATA_ASSET_TYPES, extension) && inside(dataRoot, file)) return DATA_ASSET_TYPES[extension];
  return '';
}

async function serve(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405);
  // Only `<token>.localhost:<port>`: a rebound DNS name never reaches the files.
  const token = /^([0-9a-f]+)\.localhost:(\d+)$/.exec(String(request.headers.host).toLowerCase());
  if (!token || token[2] !== String(port)) return reply(response, 403);
  const parts = String(request.url || '/')
    .split(/[?#]/, 1)[0]
    .split('/')
    .slice(1);
  const origin = tokenOrigins.get(token[1]);
  if (!origin) return reply(response, 404);
  const { root, dataRoot } = origin;
  let segments: string[];
  try {
    segments = parts.map((part) => decodeURIComponent(part));
  } catch {
    return reply(response, 400);
  }
  const target = resolve(root, ...segments);
  if (!pageAssetType(root, target, dataRoot)) return reply(response, 404);
  let file: string;
  let size: number;
  try {
    file = await realpath(target);
    const info = await stat(file);
    if (!info.isFile()) return reply(response, 404);
    size = info.size;
  } catch {
    return reply(response, 404);
  }
  // A symlink or junction must obey the same boundary, hidden-path and
  // file-type restrictions as the requested path.
  const type = pageAssetType(root, file, dataRoot);
  if (!type) return reply(response, 404);
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (request.method === 'HEAD') return void response.end();
  createReadStream(file)
    .on('error', () => response.destroy())
    .pipe(response);
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

const PORT_ATTEMPTS = 8;

/** One port on both loopbacks: Chromium may resolve `*.localhost` to ::1
 *  first, and that address must never reach another process holding the same
 *  port number. A host without IPv6 loopback serves IPv4 alone. */
async function bindBothLoopbacks(): Promise<number> {
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    serve(request, response, request.socket.localPort ?? 0).catch(() => response.destroy());
  };
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const v4 = createServer(handler);
    await listenOn(v4, 0, LOOPBACK);
    const { port } = v4.address() as AddressInfo;
    const v6 = createServer(handler);
    try {
      await listenOn(v6, port, '::1');
      v6.unref();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        v4.close();
        continue;
      }
    }
    // Pages are served on demand; the server never keeps the app alive.
    v4.unref();
    return port;
  }
  throw new Error('No loopback port is free on both IPv4 and IPv6.');
}

function serverPort(): Promise<number> {
  listening ??= bindBothLoopbacks().catch((error: unknown) => {
    listening = null;
    throw error;
  });
  return listening;
}

/** Loopback address of the page `rel` under `root` (a Project or granted
 *  folder). A Project page's assets resolve under that root. A page outside
 *  every Project (`outsideProject`) may reference presentation assets anywhere
 *  on its drive, while data files stay limited to its own folder. */
export async function localPageUrl(root: string, rel: string, outsideProject = false): Promise<string> {
  const realRoot = await realpath(root);
  const page = await realpath(resolve(realRoot, rel));
  if (!inside(realRoot, page) || !(await stat(page)).isFile()) {
    throw new TypeError('The page must be a file inside its folder.');
  }
  const origin: PageOrigin = outsideProject
    ? { root: parse(page).root, dataRoot: dirname(page) }
    : { root: realRoot, dataRoot: realRoot };
  const key = `${origin.root}\0${origin.dataRoot}`;
  let token = originTokens.get(key);
  if (!token) {
    token = randomBytes(24).toString('hex');
    originTokens.set(key, token);
    tokenOrigins.set(token, origin);
  }
  const path = relative(origin.root, page).split(sep).map(encodeURIComponent).join('/');
  return `http://${token}.localhost:${await serverPort()}/${path}`;
}
