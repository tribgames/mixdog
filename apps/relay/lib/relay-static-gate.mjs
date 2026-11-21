import {
  deviceCookieHeaders,
  mergeCookieHeaders,
  pairingCookieHeaders,
  parseCookieDevice,
  requestCookieToken,
  resolveStaticTarget,
  sendDeviceManifest,
  sendStaticFile,
} from './static-http.mjs';
import { isRoutingId } from './ids.mjs';
import { PREVIEW_FRAME_PATH, sendPreviewFrame } from './relay-preview-frame.mjs';
import { decodedRequestPath, endText, rejectUnauthorizedText } from './relay-http.mjs';
import { isNativeAppRequest, sendUpdatePcPage } from './update-pc-page.mjs';

// Browsers fetch these without credentials; a 401 would downgrade "install app"
// to an icon-less shortcut.
export const PUBLIC_APP_ASSETS = new Set([
  '/manifest.webmanifest',
  '/mixdog.svg',
  '/mixdog-logo-titanium.svg',
  '/mixdog-192.png',
  '/mixdog-512.png',
]);

const WORKER_SCRIPTS = new Set(['/sw.js', '/sw-shell.js', '/sw-media.js', '/ui-language.js']);

/** `/d/<deviceId>/...` — the install/approval entry for one desktop. The id
 *  is a routing label, never a credential: it opens the shell that asks for
 *  approval and nothing else. */
export function parseDeviceRoute(pathname) {
  const match = /^\/d\/([^/]+)(\/.*)?$/.exec(String(pathname || ''));
  if (!match || !isRoutingId(match[1])) return null;
  const rest = match[2] || '';
  return {
    deviceId: match[1],
    // Relative asset/manifest hrefs in index.html only resolve inside the
    // route when it ends in a slash.
    redirect: rest === '',
    rest: rest === '' || rest === '/' ? '/index.html' : rest,
  };
}

const SHARE_TARGET_PATH = /^\/(?:d\/[^/]+\/)?share-target$/;

export function shareTargetShell(requestUrl) {
  const parsed = decodedRequestPath({ url: requestUrl });
  if (!parsed) return '';
  const { pathname } = parsed;
  return SHARE_TARGET_PATH.test(pathname) ? pathname.replace(/share-target$/, '') : '';
}

function resolveStaticAccess(store, request, url, pathname) {
  const route = parseDeviceRoute(pathname);
  const queryToken = url.searchParams.get('token') || '';
  const token = queryToken || requestCookieToken(request);
  const tokenDevice = token ? store.deviceIdForClientToken(token) : null;
  const persistQueryToken = Boolean(queryToken) && Boolean(tokenDevice);
  const cookieDevice = parseCookieDevice(request.headers.cookie);
  const routeDevice = route?.deviceId || cookieDevice;
  const routeAllowed = Boolean(routeDevice) && store.isKnown(routeDevice);
  return {
    route,
    // Which desktop's renderer release answers this request: the route names
    // it, else the paired token does, else the device cookie of the container.
    releaseDevice: route?.deviceId || tokenDevice || cookieDevice,
    queryToken,
    persistQueryToken,
    routeDevice,
    routeAllowed,
    allowed: PUBLIC_APP_ASSETS.has(pathname) || routeAllowed || Boolean(tokenDevice),
  };
}

// `/d/<deviceId>/...`: the shell scoped to one desktop. The install captures
// start_url, so the manifest under a device route must point back at that
// same route.
function serveDeviceRoute(rendererDir, route, request, response) {
  if (route.redirect) {
    response.writeHead(301, { Location: `/d/${route.deviceId}/` }).end();
    return;
  }
  if (route.rest === '/manifest.webmanifest') {
    const manifest = resolveStaticTarget(rendererDir, route.rest);
    if (manifest.status === 200 && sendDeviceManifest(request, response, manifest.target, route.deviceId)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  const scoped = resolveStaticTarget(rendererDir, route.rest);
  if (scoped.status !== 200) {
    response.writeHead(scoped.status === 403 ? 403 : 404).end();
    return;
  }
  sendStaticFile(request, response, scoped.target, deviceCookieHeaders(route.deviceId, request));
}

/** `renderer` is a plain directory (one release) or a catalog that picks the
 *  release matching the desktop version the device last reported. */
function rendererRoot(renderer, store, deviceId) {
  if (typeof renderer === 'string') return renderer;
  return renderer.dirFor(deviceId ? store.deviceVersion(deviceId) : undefined);
}

// For a top-level native navigation, the catalog can identify older PCs
// that should update. This never changes the renderer chosen for assets.
function serveUpdatePcPage(renderer, store, { route, releaseDevice }, request, response) {
  if (typeof renderer === 'string' || route.redirect || !isNativeAppRequest(request)) return false;
  // Fetch Metadata, when sent, must say top-level document: a fetch(), iframe
  // or worker request is not a page the phone is showing. A WebView navigation
  // may omit the header altogether.
  const dest = request.headers['sec-fetch-dest'];
  if (dest !== undefined && dest !== 'document') return false;
  const report = store.deviceVersion(releaseDevice);
  const legacy = renderer.legacyFor(report);
  if (!legacy) return false;
  sendUpdatePcPage(request, response, { current: report.appVersion, min: legacy.minVersion });
  return true;
}

function isShellDocument(rendererDir, rest, resolved) {
  return (
    rest === '/' ||
    rest === '/index.html' ||
    (resolved.status === 200 && resolved.target === resolveStaticTarget(rendererDir, '/index.html').target)
  );
}

function sendUnavailableShell(request, response) {
  response
    .writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    })
    .end(
      request.method === 'HEAD'
        ? undefined
        : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web client unavailable</title>' +
            '<h1>Web client unavailable</h1><p>The web client for this PC version is unavailable.</p>' +
            '<button type="button" onclick="location.reload()">Reload page</button>'
    );
}

export function serveStatic(renderer, store, unauthorizedLimiter, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    answerNonReadMethod(request, response);
    return;
  }
  const parsed = decodedRequestPath(request);
  if (!parsed) {
    response.writeHead(400).end();
    return;
  }
  const { url, pathname } = parsed;
  if (pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (pathname === PREVIEW_FRAME_PATH) {
    sendPreviewFrame(request, response);
    return;
  }
  const access = resolveStaticAccess(store, request, url, pathname);
  if (!access.allowed) {
    rejectUnauthorizedText(unauthorizedLimiter, request, response);
    return;
  }
  const selected = rendererRoot(renderer, store, access.releaseDevice);
  const rendererDir = selected ?? renderer.rendererDir;
  if (selected !== null && !rendererDir) {
    endText(response, 404, 'Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.');
    return;
  }
  const rest = access.route?.rest ?? pathname;
  if (access.route?.redirect) {
    serveDeviceRoute(rendererDir, access.route, request, response);
    return;
  }
  const classify = selected === null || (access.route && isNativeAppRequest(request));
  const resolved = classify && rendererDir ? resolveStaticTarget(rendererDir, rest) : { status: 404 };
  const document = classify && isShellDocument(rendererDir, rest, resolved);
  if (document && access.route && serveUpdatePcPage(renderer, store, access, request, response)) return;
  if (selected === null && document) {
    sendUnavailableShell(request, response);
    return;
  }
  if (!rendererDir || (selected === null && !PUBLIC_APP_ASSETS.has(pathname) && !WORKER_SCRIPTS.has(pathname))) {
    response.writeHead(resolved.status === 403 ? 403 : 404, { 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (access.route) {
    serveDeviceRoute(rendererDir, access.route, request, response);
    return;
  }
  serveResolvedAsset(rendererDir, pathname, access, request, response, typeof renderer !== 'string');
}

/** A share-target POST is redirected into the shell; every other non-read
 *  method is refused. */
function answerNonReadMethod(request, response) {
  const shell = request.method === 'POST' ? shareTargetShell(request.url) : '';
  if (shell) {
    response.writeHead(303, { Location: shell }).end();
    return;
  }
  response.writeHead(405).end();
}

function serveResolvedAsset(rendererDir, pathname, access, request, response, perDevice) {
  const resolved = resolveStaticTarget(rendererDir, pathname);
  if (resolved.status === 403) {
    response.writeHead(403).end();
    return;
  }
  if (resolved.status === 404) {
    endText(response, 404, 'Not found.');
    return;
  }
  const { queryToken, persistQueryToken, routeDevice, routeAllowed } = access;
  sendStaticFile(
    request,
    response,
    resolved.target,
    mergeCookieHeaders(
      persistQueryToken ? pairingCookieHeaders(queryToken, request) : {},
      // A root asset request proves the container still belongs to this route;
      // refreshing the cookie keeps a long-lived install from aging out of it.
      routeAllowed ? deviceCookieHeaders(routeDevice, request) : {}
    ),
    // A root URL is shared by every device, so with per-device releases the
    // same URL can carry different bytes: shared caches must key on the cookie.
    { varyOnCookie: perDevice }
  );
}
