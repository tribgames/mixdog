/**
 * Local web pages for the session browser pane. The pane admits http(s) only,
 * so a page a chat link names is served from a loopback server. A selected-file
 * grant serves exactly one HTML file; only an explicit project grant serves
 * relative web assets (including JSON/CSV). Each URL has its own bounded lease
 * and rechecks its originating permission before returning bytes.
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
// These are hard limits, not renewed by page traffic. Reopen the chat link to
// obtain a fresh URL. Old pages must not keep permission closures indefinitely.
export const LOCAL_PAGE_TTL_MS = 60 * 60_000;
export const MAX_LOCAL_PAGE_LEASES = 128;

export interface LocalPageAccess {
  scope: 'file' | 'project';
  /** Recheck the original grant/project registry; failure revokes this URL. */
  authorize(): Promise<void>;
  /** Desktop renderer that requested the preview, not the untrusted page. */
  owner?: object;
}

interface PageLease {
  root: string;
  page: string;
  scope: LocalPageAccess['scope'];
  owner?: object;
  authorize(): Promise<void>;
  expiresAt: number;
  timer: NodeJS.Timeout;
}
const leases = new Map<string, PageLease>();
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

function revokeLease(token: string): void {
  const lease = leases.get(token);
  if (!lease) return;
  leases.delete(token);
  clearTimeout(lease.timer);
}

/** A closed desktop renderer must not leave behind usable preview URLs. */
export function revokeLocalPagesFor(owner: object): void {
  for (const [token, lease] of leases) {
    if (lease.owner === owner) revokeLease(token);
  }
}

function activeLease(token: string, lease: PageLease): boolean {
  if (leases.get(token) !== lease) return false;
  if (Date.now() < lease.expiresAt) return true;
  revokeLease(token);
  return false;
}

async function pageLocation(root: string, rel: string): Promise<{ root: string; page: string }> {
  const realRoot = await realpath(root);
  const requested = resolve(realRoot, rel.replace(/\\/g, '/'));
  if (!pageAssetType(realRoot, requested)) {
    throw new TypeError('The page must be a visible HTML file inside its folder.');
  }
  const page = await realpath(requested);
  if (!pageAssetType(realRoot, page) || !['html', 'htm'].includes(fileExtension(page))
    || !(await stat(page)).isFile()) {
    throw new TypeError('The page must be a visible HTML file inside its folder.');
  }
  return { root: realRoot, page };
}

async function serve(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405);
  // Only this loopback origin: a rebound DNS name never reaches the files.
  if (request.headers.host !== `${LOOPBACK}:${port}`) return reply(response, 403);
  const [token = '', ...parts] = String(request.url || '/')
    .split(/[?#]/, 1)[0]
    .split('/')
    .slice(1);
  const lease = leases.get(token);
  if (!lease || !activeLease(token, lease)) return reply(response, 404);
  const { root } = lease;
  let segments: string[];
  try {
    segments = parts.map((part) => decodeURIComponent(part));
  } catch {
    return reply(response, 400);
  }
  const target = resolve(root, ...segments);
  if (!pageAssetType(root, target) || (lease.scope === 'file' && target !== lease.page)) {
    return reply(response, 404);
  }
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
  if (!type || (lease.scope === 'file' && file !== lease.page)) return reply(response, 404);
  try {
    await lease.authorize();
  } catch {
    revokeLease(token);
    return reply(response, 404);
  }
  // Expiry, capacity eviction or owner closure can happen while authorization
  // awaits the daemon. A late success must not resurrect an old lease.
  if (!activeLease(token, lease)) return reply(response, 404);
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Keep selected HTML scripts usable without sharing the project pages'
    // origin/storage/window authority on this loopback server.
    ...(lease.scope === 'file' ? { 'Content-Security-Policy': 'sandbox allow-scripts' } : {}),
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

/** The caller must choose scope from verified authority, not renderer input.
 * Single-file grants never inherit a project's wider lease for the same root. */
export async function localPageUrl(root: string, rel: string, access: LocalPageAccess): Promise<string> {
  if (!access || !['file', 'project'].includes(access.scope) || typeof access.authorize !== 'function') {
    throw new TypeError('An explicit local-page permission is required.');
  }
  // Copy policy fields; mutating the caller's options cannot widen a live URL.
  const { scope, authorize, owner } = access;
  await authorize();
  const location = await pageLocation(root, rel);
  const port = await serverPort();
  await authorize();
  for (const [token, lease] of leases) activeLease(token, lease);
  while (leases.size >= MAX_LOCAL_PAGE_LEASES) revokeLease(leases.keys().next().value!);
  const token = randomBytes(24).toString('base64url');
  const lease: PageLease = {
    ...location,
    scope,
    owner,
    async authorize() {
      await authorize();
      const current = await pageLocation(root, rel);
      if (current.root !== location.root || current.page !== location.page) {
        throw new Error('The preview path no longer matches its permission.');
      }
    },
    expiresAt: Date.now() + LOCAL_PAGE_TTL_MS,
    timer: setTimeout(() => revokeLease(token), LOCAL_PAGE_TTL_MS),
  };
  lease.timer.unref();
  leases.set(token, lease);
  const path = relative(location.root, location.page).split(sep).map(encodeURIComponent).join('/');
  return `http://${LOOPBACK}:${port}/${token}/${path}`;
}
