// Static asset serving shared by the two phone-facing HTTP surfaces: the
// relay (apps/relay/server.mjs, plain node on the VPS) and the desktop LAN
// bridge (apps/desktop/src/main/remote-bridge.ts). Both serve the same
// renderer build behind the same pairing-token gate, so the MIME table, the
// path-escape guard, the SPA fallback rule, gzip negotiation and the pairing
// cookie live here once instead of drifting in two copies.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
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
  '.apk': 'application/vnd.android.package-archive',
};

export const PAIRING_COOKIE_NAME = 'mixdog_token';

// Text assets ship uncompressed otherwise: the renderer bundle alone is ~1.3MB
// over a phone link. Fonts/images/apk are already compressed, so they stay raw
// (gzip would only burn CPU).
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|wasm)|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;

/** Entry navigation carries ?token=; the cookie then authorizes the asset and
 *  APK requests that follow with no query string. */
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
 *  FILE route (an .apk must never fall back to index.html), else
 *  { status: 200, target }. */
export function resolveStaticTarget(rootDir, pathname) {
  const root = resolve(rootDir);
  let target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return { status: 403, target: '' };
  try {
    if (target === root || !statSync(target).isFile()) target = join(root, 'index.html');
  } catch {
    target = join(root, 'index.html');
  }
  // SPA fallback belongs to extension-less routes only: a missing FILE must
  // 404 instead of masquerading as the web app (an .apk download would
  // otherwise save index.html as the installer).
  const fellBack = target === join(root, 'index.html');
  if (fellBack && extname(pathname) && pathname !== '/index.html') return { status: 404, target: '' };
  if (!existsSync(target)) return { status: 404, target: '' };
  return { status: 200, target };
}

/** Stream a resolved file with cache/gzip/HEAD handling. */
export function sendStaticFile(request, response, target, extraHeaders = {}) {
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  const gzip = COMPRESSIBLE_TYPE.test(type)
    && size > COMPRESS_MIN_BYTES
    && /\bgzip\b/i.test(String(request.headers['accept-encoding'] || ''));
  const headers = {
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
  if (extname(target).toLowerCase() === '.apk') {
    Object.assign(headers, apkHeaders());
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const source = createReadStream(target).on('error', () => response.destroy());
  if (gzip) source.pipe(createGzip({ level: 6 })).pipe(response);
  else source.pipe(response);
}

/** Never cache the installer (a stale copy re-installs an old package) and
 *  force a download even in in-app browsers that would try to render it. */
export function apkHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="mixdog.apk"',
  };
}

/** Serve a staged APK from an absolute path; false when it is not staged. */
export function sendApkFile(request, response, apkPath, extraHeaders = {}) {
  if (!existsSync(apkPath) || !statSync(apkPath).isFile()) return false;
  response.writeHead(200, {
    'Content-Type': MIME_TYPES['.apk'],
    'Content-Length': statSync(apkPath).size,
    ...apkHeaders(),
    ...extraHeaders,
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  createReadStream(apkPath).on('error', () => response.destroy()).pipe(response);
  return true;
}
