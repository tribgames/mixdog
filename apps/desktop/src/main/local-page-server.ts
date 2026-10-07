/**
 * Local web pages for the session browser pane. The pane admits http(s) only,
 * so a page a chat link names is served from a loopback server: every root
 * folder gets an unguessable path prefix, and only web assets under that root
 * are served (no dotfiles, no source or data files), so a page's own styles,
 * scripts, fonts and media load while the rest of the disk stays unreachable.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileExtension } from '../shared/file-extension';

const PAGE_ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
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
});

const LOOPBACK = '127.0.0.1';
const tokenRoots = new Map<string, string>();
const rootTokens = new Map<string, string>();
let listening: Promise<number> | null = null;

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(String(status));
}

function pageAssetType(root: string, file: string): string {
  if (
    !inside(root, file) ||
    relative(root, file)
      .split(sep)
      .some((part) => part.startsWith('.'))
  ) {
    return '';
  }
  const extension = fileExtension(file);
  return Object.hasOwn(PAGE_ASSET_TYPES, extension) ? PAGE_ASSET_TYPES[extension] : '';
}

async function serve(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405);
  // Only this loopback origin: a rebound DNS name never reaches the files.
  if (request.headers.host !== `${LOOPBACK}:${port}`) return reply(response, 403);
  const [token = '', ...parts] = String(request.url || '/')
    .split(/[?#]/, 1)[0]
    .split('/')
    .slice(1);
  const root = tokenRoots.get(token);
  if (!root) return reply(response, 404);
  let segments: string[];
  try {
    segments = parts.map((part) => decodeURIComponent(part));
  } catch {
    return reply(response, 400);
  }
  const target = resolve(root, ...segments);
  if (!pageAssetType(root, target)) return reply(response, 404);
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
  const type = pageAssetType(root, file);
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

function serverPort(): Promise<number> {
  listening ??= new Promise<number>((resolvePort, reject) => {
    const server = createServer((request, response) => {
      const { port } = server.address() as AddressInfo;
      serve(request, response, port).catch(() => response.destroy());
    });
    server.once('error', (error) => {
      listening = null;
      reject(error);
    });
    server.listen(0, LOOPBACK, () => {
      // Pages are served on demand; the server never keeps the app alive.
      server.unref();
      resolvePort((server.address() as AddressInfo).port);
    });
  });
  return listening;
}

/** Loopback address of the page `rel` under `root` (a Project or granted
 *  folder). Its relative assets resolve under the same root. */
export async function localPageUrl(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  const page = await realpath(resolve(realRoot, rel));
  if (!inside(realRoot, page) || !(await stat(page)).isFile()) {
    throw new TypeError('The page must be a file inside its folder.');
  }
  let token = rootTokens.get(realRoot);
  if (!token) {
    token = randomBytes(24).toString('base64url');
    rootTokens.set(realRoot, token);
    tokenRoots.set(token, realRoot);
  }
  const path = relative(realRoot, page).split(sep).map(encodeURIComponent).join('/');
  return `http://${LOOPBACK}:${await serverPort()}/${token}/${path}`;
}
