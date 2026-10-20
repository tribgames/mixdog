/**
 * Local web pages for the session browser pane. The pane admits http(s) only,
 * so a page a chat link names is served from a loopback server. A selected-file
 * grant serves exactly one HTML file; only an explicit project grant serves
 * relative web assets (styles, scripts, fonts, media, data and documents; no
 * dotfiles, no source files). Each URL has its own bounded lease and rechecks
 * its originating permission before returning bytes. A paired device's lease
 * (`remote`) also judges every request — the page and each asset it pulls in —
 * by name and by the opened file's real location, under the remote deny list.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileExtension } from '../shared/file-extension';
import { withSandboxStorageShim } from '../shared/sandbox-storage-shim';
import { isLocalAccessDenied, LocalAccessDeniedError } from './local-access-denied';
import { type AuthorizedFile, comparablePath, openAuthorizedFile } from './opened-file-authorization';
import { requiredSensitivePolicy, type SensitivePolicy } from './remote-sensitive-paths';

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
  // A glTF model's buffers (`model.gltf` + `model.bin`).
  bin: 'application/octet-stream',
});

const LOOPBACK = '127.0.0.1';
// These are hard limits, not renewed by page traffic. Reopen the chat link to
// obtain a fresh URL. Old pages must not keep permission closures indefinitely.
export const LOCAL_PAGE_TTL_MS = 60 * 60_000;
export const MAX_LOCAL_PAGE_LEASES = 128;

export interface LocalPageAccess {
  scope: 'file' | 'project';
  /** Recheck authority: explicit denial revokes; other failures remain retryable. */
  authorize(): Promise<void>;
  /** Desktop renderer that requested the preview, not the untrusted page. */
  owner?: object;
  /** A paired device's page: the deny policy of the process that authorized
   *  it. Every request of the lease — the page and each asset it references —
   *  is then opened first and served only from a handle whose real location
   *  is inside the root and not secret-bearing (openAuthorizedFile). */
  remote?: SensitivePolicy;
}

/** One in-memory file of a virtual page (nothing on disk). */
export interface VirtualPageFile {
  type: string;
  body: Buffer;
}

interface PageLease {
  root: string;
  page: string;
  /** In-memory page: exactly these files, by name, and nothing from disk. */
  virtual?: ReadonlyMap<string, VirtualPageFile>;
  scope: LocalPageAccess['scope'];
  owner?: object;
  remote?: SensitivePolicy;
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
    throw new LocalAccessDeniedError('The page must be a visible HTML file inside its folder.');
  }
  const page = await realpath(requested);
  if (
    !pageAssetType(realRoot, page) ||
    !['html', 'htm'].includes(fileExtension(page)) ||
    !(await stat(page)).isFile()
  ) {
    throw new LocalAccessDeniedError('The page must be a visible HTML file inside its folder.');
  }
  return { root: realRoot, page };
}

async function serveVirtual(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  lease: PageLease,
  file: VirtualPageFile | undefined
): Promise<void> {
  if (!file) return reply(response, 404);
  try {
    await lease.authorize();
  } catch (error) {
    if (isLocalAccessDenied(error)) revokeLease(token);
    return reply(response, activeLease(token, lease) ? 503 : 404);
  }
  if (!activeLease(token, lease)) return reply(response, 404);
  leases.delete(token);
  leases.set(token, lease);
  const body = file.type.startsWith('text/html') ? withShim(file.body) : file.body;
  response.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Like a single-file grant: scripts run, but in an opaque origin of their own.
    'Content-Security-Policy': 'sandbox allow-scripts',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** An HTML page of a sandboxed (opaque-origin) lease, with the in-memory
 *  storage shim first in its head: there the real storage throws. */
function withShim(body: Buffer): Buffer {
  return Buffer.from(withSandboxStorageShim(body.toString('utf8')), 'utf8');
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
  if (lease.virtual) return serveVirtual(request, response, token, lease, lease.virtual.get(segments.join('/')));
  const target = resolve(root, ...segments);
  if (!pageAssetType(root, target) || (lease.scope === 'file' && target !== lease.page)) {
    return reply(response, 404);
  }
  let file: string;
  let size: number;
  // A remote lease reads every response through the handle it authorized.
  let opened: AuthorizedFile | null = null;
  try {
    if (lease.remote) {
      opened = await openAuthorizedFile(target, root, lease.remote);
      file = opened.location;
      size = opened.size;
    } else {
      file = await realpath(target);
      const info = await stat(file);
      if (!info.isFile()) return reply(response, 404);
      size = info.size;
    }
  } catch {
    return reply(response, 404);
  }
  try {
    // A stream from the handle takes it over (and closes it).
    if (await serveFile(request, response, token, lease, file, size, opened)) opened = null;
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}

/** The response for `file` (canonical, `size` bytes) of a disk lease; read
 *  from `opened` when the lease is remote. True when it streams from
 *  `opened`, which the stream then closes. */
async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  lease: PageLease,
  file: string,
  size: number,
  opened: AuthorizedFile | null
): Promise<boolean> {
  const refuse = (status: number): false => {
    reply(response, status);
    return false;
  };
  const { root } = lease;
  const isPage = comparablePath(file) === comparablePath(lease.page);
  // A symlink or junction must obey the same boundary, hidden-path and
  // file-type restrictions as the requested path.
  const type = pageAssetType(root, file);
  if (!type || (lease.scope === 'file' && !isPage)) return refuse(404);
  try {
    await lease.authorize();
  } catch (error) {
    if (isLocalAccessDenied(error)) revokeLease(token);
    // A timeout or failed lookup denies this response, not future attempts.
    // Expiry, eviction and owner closure still win over a late failure.
    return refuse(activeLease(token, lease) ? 503 : 404);
  }
  // Expiry, capacity eviction or owner closure can happen while authorization
  // awaits the daemon. A late success must not resurrect an old lease.
  if (!activeLease(token, lease)) return refuse(404);
  // Successful GET/HEAD makes this lease most recently used. Bad paths and
  // failed authorization cannot keep a lease warm or renew its absolute TTL.
  leases.delete(token);
  leases.set(token, lease);
  // Only a sandboxed lease's page document is rewritten; assets stay streamed.
  let page: Buffer | undefined;
  if (lease.scope === 'file' && ['html', 'htm'].includes(fileExtension(file))) {
    try {
      page = withShim(opened ? await opened.handle.readFile() : await readFile(file));
    } catch {
      return refuse(404);
    }
    // Expiry or owner closure during the read must not still return the page.
    if (!activeLease(token, lease)) return refuse(404);
    size = page.length;
  }
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
  if (request.method === 'HEAD') {
    response.end();
    return false;
  }
  if (page) {
    response.end(page);
    return false;
  }
  (opened ? opened.handle.createReadStream({ start: 0 }) : createReadStream(file))
    .on('error', () => response.destroy())
    .pipe(response);
  return opened !== null;
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

/** `http://127.0.0.1:<port>`: the app renderer frames visualize pages from
 *  this origin only, so its CSP names it exactly. Starts the server. */
export async function localPageOrigin(): Promise<string> {
  return `http://${LOOPBACK}:${await serverPort()}`;
}

/** A page held in memory (`index.html` plus any sibling files), served like a
 *  single-file grant: its own lease, scripts allowed in an opaque origin, only
 *  the named files, the same TTL, capacity and owner revocation. The caller
 *  chooses the content; nothing is read from disk. */
export async function localVirtualPageUrl(
  files: Readonly<Record<string, VirtualPageFile>>,
  access: Pick<LocalPageAccess, 'authorize' | 'owner'>
): Promise<string> {
  if (!access || typeof access.authorize !== 'function') {
    throw new TypeError('An explicit local-page permission is required.');
  }
  if (!Object.hasOwn(files, 'index.html')) throw new TypeError('A virtual page needs an index.html.');
  const { authorize, owner } = access;
  await authorize();
  const port = await serverPort();
  for (const [token, lease] of leases) activeLease(token, lease);
  while (leases.size >= MAX_LOCAL_PAGE_LEASES) revokeLease(leases.keys().next().value!);
  const token = randomBytes(24).toString('base64url');
  const lease: PageLease = {
    root: '',
    page: 'index.html',
    virtual: new Map(Object.entries(files)),
    scope: 'file',
    owner,
    authorize,
    expiresAt: Date.now() + LOCAL_PAGE_TTL_MS,
    timer: setTimeout(() => revokeLease(token), LOCAL_PAGE_TTL_MS),
  };
  lease.timer.unref();
  leases.set(token, lease);
  return `http://${LOOPBACK}:${port}/${token}/index.html`;
}

/** The caller must choose scope from verified authority, not renderer input.
 * Single-file grants never inherit a project's wider lease for the same root. */
export async function localPageUrl(root: string, rel: string, access: LocalPageAccess): Promise<string> {
  if (!access || !['file', 'project'].includes(access.scope) || typeof access.authorize !== 'function') {
    throw new TypeError('An explicit local-page permission is required.');
  }
  // Copy policy fields; mutating the caller's options cannot widen a live URL.
  const { scope, authorize, owner } = access;
  const remote = access.remote === undefined ? undefined : requiredSensitivePolicy(access.remote);
  await authorize();
  const location = await pageLocation(root, rel);
  const port = await serverPort();
  await authorize();
  for (const [token, lease] of leases) activeLease(token, lease);
  // Map order is last successful use (or issuance for an unused URL).
  while (leases.size >= MAX_LOCAL_PAGE_LEASES) revokeLease(leases.keys().next().value!);
  const token = randomBytes(24).toString('base64url');
  const lease: PageLease = {
    ...location,
    scope,
    owner,
    ...(remote ? { remote } : {}),
    async authorize() {
      await authorize();
      const current = await pageLocation(root, rel);
      if (current.root !== location.root || current.page !== location.page) {
        throw new LocalAccessDeniedError('The preview path no longer matches its permission.');
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
