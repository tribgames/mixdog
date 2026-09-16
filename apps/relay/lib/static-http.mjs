// Static asset serving for the relay (apps/relay/server.mjs). The MIME table,
// path-escape guard, SPA fallback rule, gzip negotiation and pairing cookie
// live here outside the server entrypoint.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';

import { HASHED_ASSET_NAME } from './hashed-asset-name.mjs';
export { HASHED_ASSET_NAME };

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export const PAIRING_COOKIE_NAME = 'mixdog_token';
// Device route cookie: the installed web app launches at /d/<deviceId>/, and
// the assets it pulls afterwards are plain root URLs. The cookie carries the
// route across those requests so the shell keeps its gate without rewriting
// every asset path per device.
export const DEVICE_COOKIE_NAME = 'mixdog_device';

// Text assets ship uncompressed otherwise: the renderer bundle alone is ~1.3MB
// over a phone link. Fonts and images are already compressed, so they stay raw
// (gzip would only burn CPU).
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|wasm)|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;
const NO_CACHE_SUFFIXES = ['index.html', 'manifest.webmanifest', 'sw.js', 'sw-shell.js', 'ui-language.js', 'boot.js'];
// Siblings written by `npm run stage:web` next to each text asset.
const PRECOMPRESSED_EXTENSIONS = new Set(['.br', '.gz']);
// Keep validators, not asset bodies, across requests. Release swaps and
// in-place edits invalidate the entry, including precompressed siblings.
const staticValidators = new Map();
function staticEtag(target, encoding) {
  const info = statSync(target);
  const stamp = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, encoding].join(':');
  const cached = staticValidators.get(target);
  if (cached?.stamp === stamp) return cached.etag;
  const etag = `W/"${createHash('sha256').update(encoding).update(readFileSync(target)).digest('hex')}"`;
  staticValidators.delete(target);
  staticValidators.set(target, { stamp, etag });
  while (staticValidators.size > 256) staticValidators.delete(staticValidators.keys().next().value);
  return etag;
}

function notModified(request, etag) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return String(request.headers['if-none-match'] || '')
    .split(',')
    .some((value) => {
      const candidate = value.trim();
      return candidate === '*' || candidate.replace(/^W\//, '') === etag.replace(/^W\//, '');
    });
}
export const BROWSER_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com",
    "media-src 'self' data: blob:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

/** The production renderer inlines boot.js to remove a parser-blocking relay
 *  round trip. Grant only that exact sibling source permission, and only when
 *  the served document actually contains it; every other response keeps the
 *  base self-only script policy. */
function browserSecurityHeadersForTarget(target) {
  if (!target.endsWith('index.html')) return BROWSER_SECURITY_HEADERS;
  try {
    const source = readFileSync(join(dirname(target), 'boot.js'), 'utf8');
    const document = readFileSync(target, 'utf8');
    if (!document.includes(`<script>${source}</script>`)) return BROWSER_SECURITY_HEADERS;
    const hash = createHash('sha256').update(source).digest('base64');
    return {
      ...BROWSER_SECURITY_HEADERS,
      'Content-Security-Policy': BROWSER_SECURITY_HEADERS['Content-Security-Policy'].replace(
        "script-src 'self'",
        `script-src 'self' 'sha256-${hash}'`
      ),
    };
  } catch {
    return BROWSER_SECURITY_HEADERS;
  }
}

function parseCookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Per-browser credentials ride Authorization/localStorage; the cookie is the
 *  fallback for asset requests a browser sends with no header of its own. */
export function parseCookieToken(header) {
  return parseCookieValue(header, PAIRING_COOKIE_NAME);
}

/** Which desktop this container was launched for: set by the /d/<id>/ entry
 *  navigation, read by every root asset request that follows. */
export function parseCookieDevice(header) {
  return parseCookieValue(header, DEVICE_COOKIE_NAME);
}

function cookieHeader(name, value, request, { httpOnly = false } = {}) {
  if (!value) return {};
  const secure = request?.socket?.encrypted ? '; Secure' : '';
  const flags = httpOnly ? 'HttpOnly; ' : '';
  return {
    'Set-Cookie': `${name}=${encodeURIComponent(value)}; Path=/; ` + `Max-Age=31536000; ${flags}SameSite=Lax${secure}`,
  };
}

/** Headers that persist the entry token; empty when the request had none. */
export function pairingCookieHeaders(queryToken, request) {
  return cookieHeader(PAIRING_COOKIE_NAME, queryToken, request, { httpOnly: true });
}

/** Not HttpOnly on purpose: it names no secret, and the app shell reads it to
 *  recover its device route when a navigation lands outside /d/<id>/. */
export function deviceCookieHeaders(deviceId, request) {
  return cookieHeader(DEVICE_COOKIE_NAME, deviceId, request);
}

/** One response may set both cookies; a plain object spread would drop one. */
export function mergeCookieHeaders(...headerSets) {
  const cookies = [];
  for (const set of headerSets) {
    const value = set?.['Set-Cookie'];
    if (Array.isArray(value)) cookies.push(...value);
    else if (value) cookies.push(value);
  }
  return cookies.length > 0 ? { 'Set-Cookie': cookies } : {};
}

/** Device-scoped manifest for /d/<deviceId>/. start_url is what an install
 *  captures, so pointing it at the device route is what lets the installed web
 *  app say WHICH desktop it wants — the one thing an empty storage container
 *  cannot otherwise know. The route names a desktop and carries no secret; the
 *  approval on that desktop is what grants access. False when the manifest
 *  cannot be read, leaving the answer to the caller. */
export function sendDeviceManifest(request, response, target, deviceId) {
  let body;
  try {
    const manifest = JSON.parse(readFileSync(target, 'utf8'));
    const base = `/d/${deviceId}/`;
    manifest.id = base;
    manifest.start_url = base;
    manifest.scope = base;
    // An installer ignores a share_target whose action falls outside the
    // manifest scope, so the share sheet entry follows the device route
    // exactly like start_url does.
    if (manifest.share_target && typeof manifest.share_target.action === 'string') {
      manifest.share_target = {
        ...manifest.share_target,
        action: `${base}${manifest.share_target.action.replace(/^\/+/, '')}`,
      };
    }
    body = JSON.stringify(manifest);
  } catch {
    return false;
  }
  const etag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
  const unchanged = notModified(request, etag);
  response.writeHead(unchanged ? 304 : 200, {
    ...BROWSER_SECURITY_HEADERS,
    'Content-Type': MIME_TYPES['.webmanifest'],
    'Cache-Control': 'no-cache',
    ETag: etag,
    ...(unchanged ? {} : { 'Content-Length': Buffer.byteLength(body) }),
    ...deviceCookieHeaders(deviceId, request),
  });
  response.end(unchanged || request.method === 'HEAD' ? undefined : body);
  return true;
}

/** Resolve a request path inside `rootDir`.
 *  Returns { status: 403 } for an escape attempt, { status: 404 } for a missing
 *  file route, else
 *  { status: 200, target }. */
function pathIsWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveStaticTarget(rootDir, pathname) {
  // Precompressed siblings answer through content negotiation on the asset's
  // own URL; a direct request for one would hand back an encoded body with no
  // Content-Encoding and the wrong type.
  if (PRECOMPRESSED_EXTENSIONS.has(extname(pathname).toLowerCase())) {
    return { status: 404, target: '' };
  }
  const root = resolve(rootDir);
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { status: 404, target: '' };
  }
  let target = resolve(root, `.${pathname}`);
  if (!pathIsWithin(root, target)) return { status: 403, target: '' };
  try {
    if (target === root || !statSync(target).isFile()) target = join(root, 'index.html');
  } catch {
    target = join(root, 'index.html');
  }
  // SPA fallback belongs to extension-less routes only: a missing file must
  // 404 instead of masquerading as the web app.
  const fellBack = target === join(root, 'index.html');
  if (fellBack && extname(pathname) && pathname !== '/index.html') return { status: 404, target: '' };
  if (!existsSync(target)) return { status: 404, target: '' };
  try {
    const realTarget = realpathSync(target);
    if (!pathIsWithin(realRoot, realTarget)) return { status: 403, target: '' };
    if (!statSync(realTarget).isFile()) return { status: 404, target: '' };
    return { status: 200, target: realTarget };
  } catch {
    return { status: 404, target: '' };
  }
}

/** Accept-Encoding as a name -> quality table. q=0 is an explicit REFUSAL, not
 *  a preference: `gzip;q=0` or `*;q=0` means the client cannot decode that
 *  body, and answering it encoded anyway breaks the response outright. */
export function parseAcceptEncoding(header) {
  const table = new Map();
  for (const part of String(header || '').split(',')) {
    const [rawName, ...parameters] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(parameter);
      if (match) quality = Number(match[1]);
    }
    table.set(name, Number.isFinite(quality) ? quality : 0);
  }
  return table;
}

/** True only when the client actually accepts `encoding`. */
export function encodingAccepted(header, encoding) {
  const table = parseAcceptEncoding(header);
  const direct = table.get(encoding);
  if (direct !== undefined) return direct > 0;
  const wildcard = table.get('*');
  return wildcard !== undefined && wildcard > 0;
}

/** A negotiated sibling never passes through resolveStaticTarget, so it repeats
 *  that escape check here: the sibling's real path must be exactly the resolved
 *  asset's real path plus the suffix. A symlinked `.br` beside a public file
 *  would otherwise return bytes from outside the renderer root. */
function precompressedSibling(target, suffix, fileExists) {
  const path = `${target}${suffix}`;
  if (!fileExists(path)) return '';
  try {
    if (realpathSync(path) !== `${realpathSync(target)}${suffix}`) return '';
    if (!statSync(path).isFile()) return '';
  } catch {
    return '';
  }
  return path;
}

/** Pick the precompressed sibling (`.br`/`.gz`) the client accepts.
 *  `npm run stage:web` writes them beside each text asset, so the relay ships
 *  brotli — well under on-the-fly gzip on a phone link — without spending CPU
 *  per request. Returns null when nothing suitable was staged, leaving the
 *  live gzip path in charge (LAN/dev servers run straight off a raw build). */
export function selectPrecompressed(target, acceptEncoding, fileExists = existsSync) {
  if (encodingAccepted(acceptEncoding, 'br')) {
    const path = precompressedSibling(target, '.br', fileExists);
    if (path) return { path, encoding: 'br' };
  }
  if (encodingAccepted(acceptEncoding, 'gzip')) {
    const path = precompressedSibling(target, '.gz', fileExists);
    if (path) return { path, encoding: 'gzip' };
  }
  return null;
}

/** Stream a resolved file with cache/compression/HEAD handling. */
function cacheControlForTarget(target, hashedAsset) {
  if (NO_CACHE_SUFFIXES.some((suffix) => target.endsWith(suffix))) return 'no-cache';
  return hashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
}

export function sendStaticFile(request, response, target, extraHeaders = {}) {
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  const hashedAsset = target.split(sep).includes('assets') && HASHED_ASSET_NAME.test(target);
  const compressible = COMPRESSIBLE_TYPE.test(type) && size > COMPRESS_MIN_BYTES;
  const precompressed = compressible ? selectPrecompressed(target, request.headers['accept-encoding']) : null;
  const gzip = !precompressed && compressible && encodingAccepted(request.headers['accept-encoding'], 'gzip');
  const headers = {
    ...browserSecurityHeadersForTarget(target),
    'Content-Type': type,
    // boot.js carries no content hash yet is version-locked to index.html (it
    // picks the viewport projection and the first-paint theme). Under the
    // generic one-day rule a phone kept an OLD boot.js while index.html
    // (no-cache) handed it a NEW hashed bundle, and the mismatched pair
    // rendered the PWA shrunk to a fraction of the screen. It revalidates with
    // the document it belongs to.
    'Cache-Control': cacheControlForTarget(target, hashedAsset),
    Vary: 'Accept-Encoding',
    ETag: staticEtag(precompressed?.path || target, precompressed?.encoding || (gzip ? 'gzip' : 'identity')),
    ...extraHeaders,
  };
  if (notModified(request, headers.ETag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  // A precompressed file has a known length, so the browser gets a real
  // progress figure. Live gzip does not: its byte count is only settled when
  // the stream ends.
  if (precompressed) {
    headers['Content-Encoding'] = precompressed.encoding;
    headers['Content-Length'] = statSync(precompressed.path).size;
  } else if (gzip) {
    headers['Content-Encoding'] = 'gzip';
  } else {
    headers['Content-Length'] = size;
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const source = createReadStream(precompressed ? precompressed.path : target).on('error', () => response.destroy());
  if (gzip) source.pipe(createGzip({ level: 6 })).pipe(response);
  else source.pipe(response);
}
