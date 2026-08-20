// Static asset serving shared by the two browser-facing HTTP surfaces: the
// relay (apps/relay/server.mjs, plain node on the VPS). The MIME table,
// path-escape guard, SPA fallback rule, gzip negotiation and pairing cookie
// live here outside the server entrypoint.
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';

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

// Text assets ship uncompressed otherwise: the renderer bundle alone is ~1.3MB
// over a phone link. Fonts and images are already compressed, so they stay raw
// (gzip would only burn CPU).
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|wasm)|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;
// Siblings written by `npm run stage:web` next to each text asset.
const PRECOMPRESSED_EXTENSIONS = new Set(['.br', '.gz']);
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

/** Entry navigation carries ?token=; the cookie then authorizes asset
 *  requests that follow with no query string. */
export function parseCookieToken(header) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === PAIRING_COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

/** Headers that persist the entry token; empty when the request had none. */
export function pairingCookieHeaders(queryToken, request) {
  if (!queryToken) return {};
  const secure = request?.socket?.encrypted ? '; Secure' : '';
  return {
    'Set-Cookie': `${PAIRING_COOKIE_NAME}=${encodeURIComponent(queryToken)}; Path=/; `
      + `Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  };
}

/** Home Screen install handoff (iOS): an installed web app runs in its own
 *  storage container, so the pairing Safari holds never reaches it and the app
 *  opened on the scanner. A manifest WITHOUT start_url makes the install
 *  capture the LAUNCHING document URL instead, so an already-paired page can
 *  carry its pairing link into the install. Chromium keeps the canonical
 *  manifest — start_url is part of its installability criteria — so only this
 *  explicitly requested variant drops it. False when the manifest cannot be
 *  read, leaving the answer to the caller. */
export function sendInheritStartUrlManifest(request, response, target) {
  let body;
  try {
    const manifest = JSON.parse(readFileSync(target, 'utf8'));
    delete manifest.start_url;
    body = JSON.stringify(manifest);
  } catch {
    return false;
  }
  response.writeHead(200, {
    ...BROWSER_SECURITY_HEADERS,
    'Content-Type': MIME_TYPES['.webmanifest'],
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(request.method === 'HEAD' ? undefined : body);
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

/** Pick the precompressed sibling (`.br`/`.gz`) the client accepts.
 *  `npm run stage:web` writes them beside each text asset, so the relay ships
 *  brotli — well under on-the-fly gzip on a phone link — without spending CPU
 *  per request. Returns null when nothing suitable was staged, leaving the
 *  live gzip path in charge (LAN/dev servers run straight off a raw build). */
export function selectPrecompressed(target, acceptEncoding, fileExists = existsSync) {
  const accept = String(acceptEncoding || '');
  if (/\bbr\b/i.test(accept) && fileExists(`${target}.br`)) {
    return { path: `${target}.br`, encoding: 'br' };
  }
  if (/\bgzip\b/i.test(accept) && fileExists(`${target}.gz`)) {
    return { path: `${target}.gz`, encoding: 'gzip' };
  }
  return null;
}

/** Stream a resolved file with cache/compression/HEAD handling. */
export function sendStaticFile(request, response, target, extraHeaders = {}) {
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  const hashedAsset = target.split(sep).includes('assets')
    && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(target);
  const precompressed = COMPRESSIBLE_TYPE.test(type) && size > COMPRESS_MIN_BYTES
    ? selectPrecompressed(target, request.headers['accept-encoding'])
    : null;
  const gzip = !precompressed
    && COMPRESSIBLE_TYPE.test(type)
    && size > COMPRESS_MIN_BYTES
    && /\bgzip\b/i.test(String(request.headers['accept-encoding'] || ''));
  const headers = {
    ...BROWSER_SECURITY_HEADERS,
    'Content-Type': type,
    // boot.js carries no content hash yet is version-locked to index.html (it
    // picks the viewport projection and the first-paint theme). Under the
    // generic one-day rule a phone kept an OLD boot.js while index.html
    // (no-cache) handed it a NEW hashed bundle, and the mismatched pair
    // rendered the PWA shrunk to a fraction of the screen. It revalidates with
    // the document it belongs to.
    'Cache-Control': target.endsWith('index.html')
      || target.endsWith('manifest.webmanifest')
      || target.endsWith('sw.js')
      || target.endsWith('boot.js')
      ? 'no-cache'
      : hashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400',
    Vary: 'Accept-Encoding',
    ...extraHeaders,
  };
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
  const source = createReadStream(precompressed ? precompressed.path : target)
    .on('error', () => response.destroy());
  if (gzip) source.pipe(createGzip({ level: 6 })).pipe(response);
  else source.pipe(response);
}
