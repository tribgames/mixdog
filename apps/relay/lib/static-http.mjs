// Static asset serving shared by the two browser-facing HTTP surfaces: the
// relay (apps/relay/server.mjs, plain node on the VPS). The MIME table,
// path-escape guard, SPA fallback rule, gzip negotiation and pairing cookie
// live here outside the server entrypoint.
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
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

/** Resolve a request path inside `rootDir`.
 *  Returns { status: 403 } for an escape attempt, { status: 404 } for a missing
 *  file route, else
 *  { status: 200, target }. */
function pathIsWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveStaticTarget(rootDir, pathname) {
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

/** Stream a resolved file with cache/gzip/HEAD handling. */
export function sendStaticFile(request, response, target, extraHeaders = {}) {
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  const gzip = COMPRESSIBLE_TYPE.test(type)
    && size > COMPRESS_MIN_BYTES
    && /\bgzip\b/i.test(String(request.headers['accept-encoding'] || ''));
  const headers = {
    ...BROWSER_SECURITY_HEADERS,
    'Content-Type': type,
    'Cache-Control': target.endsWith('index.html')
      || target.endsWith('manifest.webmanifest')
      || target.endsWith('sw.js')
      ? 'no-cache'
      : 'public, max-age=86400',
    Vary: 'Accept-Encoding',
    ...extraHeaders,
  };
  // Content-Length only survives the uncompressed path — the gzipped byte
  // count is not known until the stream ends.
  if (gzip) headers['Content-Encoding'] = 'gzip';
  else headers['Content-Length'] = size;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const source = createReadStream(target).on('error', () => response.destroy());
  if (gzip) source.pipe(createGzip({ level: 6 })).pipe(response);
  else source.pipe(response);
}
