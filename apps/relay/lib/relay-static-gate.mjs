// Pairing-gated static shell: device routes, public installability assets,
// share-target fallback, and the health probe. Branding files listed here are
// served without the pairing gate because browsers fetch them without
// credentials; a 401 would silently downgrade "install app" to an icon-less
// shortcut. These assets carry no user data.
import {
  deviceCookieHeaders,
  mergeCookieHeaders,
  pairingCookieHeaders,
  parseCookieDevice,
  parseCookieToken,
  resolveStaticTarget,
  sendDeviceManifest,
  sendStaticFile,
} from './static-http.mjs';
import { decodedRequestPath, endText, rejectUnauthorizedText } from './relay-http.mjs';

export const PUBLIC_APP_ASSETS = new Set([
  '/manifest.webmanifest',
  '/mixdog.svg',
  '/mixdog-192.png',
  '/mixdog-512.png',
]);

/** `/d/<deviceId>/...` — the install/approval entry for one desktop. The id
 *  is a routing label, never a credential: it opens the shell that asks for
 *  approval and nothing else. */
export function parseDeviceRoute(pathname) {
  const match = /^\/d\/([0-9a-f-]{8,64})(\/.*)?$/.exec(String(pathname || ''));
  if (!match) return null;
  const rest = match[2] || '';
  return {
    deviceId: match[1],
    // Relative asset/manifest hrefs in index.html only resolve inside the
    // route when it ends in a slash.
    redirect: rest === '',
    rest: rest === '' || rest === '/' ? '/index.html' : rest,
  };
}

// The installed app's share sheet posts to its service worker, which answers
// on the device. A share that still reaches the relay means no worker was
// active yet: reopening the app beats failing the share outright, even though
// the payload itself is lost with the request this relay never stores.
const SHARE_TARGET_PATH = /^\/(?:d\/[^/]+\/)?share-target$/;

export function shareTargetShell(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || '/', 'http://localhost').pathname);
  } catch {
    return '';
  }
  return SHARE_TARGET_PATH.test(pathname) ? pathname.replace(/share-target$/, '') : '';
}

// Gate: an approved browser presents its per-browser token (Authorization,
// or this cookie for plain asset requests). A container with no credential
// yet may still reach the shell through its device route — that shell can
// only show the install guide and ask the desktop for approval, and the
// bundle behind it holds no user data. Bots probing GET / see 401.
// Installability metadata is exempt: browsers fetch the manifest and its
// icons WITHOUT credentials, and a 401 there silently downgrades "install
// app" to an icon-less shortcut. These assets carry no user data.
function resolveStaticAccess(store, request, url, pathname) {
  const route = parseDeviceRoute(pathname);
  const queryToken = url.searchParams.get('token') || '';
  const token = queryToken || parseCookieToken(request.headers.cookie);
  const tokenDevice = token ? store.deviceIdForClientToken(token) : null;
  // Only a credential this relay actually knows is persisted as the pairing
  // cookie. A public asset carrying `?token=<attacker value>` would otherwise
  // plant an HttpOnly cookie the visitor cannot see or clear, and every later
  // request would ride the attacker's session.
  const persistQueryToken = Boolean(queryToken) && Boolean(tokenDevice);
  const cookieDevice = parseCookieDevice(request.headers.cookie);
  const routeDevice = route?.deviceId || cookieDevice;
  const routeAllowed = Boolean(routeDevice) && store.isKnown(routeDevice);
  return {
    route,
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

export function serveStatic(rendererDir, store, unauthorizedLimiter, request, response) {
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
  const access = resolveStaticAccess(store, request, url, pathname);
  if (!access.allowed) {
    rejectUnauthorizedText(unauthorizedLimiter, request, response);
    return;
  }
  if (!rendererDir) {
    endText(response, 404, 'Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.');
    return;
  }
  if (access.route) {
    serveDeviceRoute(rendererDir, access.route, request, response);
    return;
  }
  serveResolvedAsset(rendererDir, pathname, access, request, response);
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

function serveResolvedAsset(rendererDir, pathname, access, request, response) {
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
    )
  );
}
