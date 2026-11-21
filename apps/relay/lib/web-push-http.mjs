// Browser side of relay-owned Web Push (lib/web-push.mjs).
//   GET  /webpush/key                                   -> { publicKey }
//   POST /webpush/register   Bearer <client token>  { endpoint, sealed } -> { registered: true }
//                            409 { error: 'unsupported' } for a PC that never sent `webpush-ready`
//   POST /webpush/unregister Bearer <client token>  { endpoint }         -> { removed }
//   POST /webpush/status     Bearer <client token>  { endpoint? }        -> { registered, supported }
// register/unregister are rate limited per credential (429), write nothing when nothing changes, and answer 503 (retry) when the change could not be stored.
// The token is one PC's per-browser credential; only an explicit Bearer header counts, never the pairing cookie.
import { browserSocketOriginAllowed, clientIp, requestUrl } from './relay-http.mjs';
import { validSealedKeys, validWebPushEndpoint } from './web-push.mjs';

const MAX_BODY_BYTES = 4 * 1024;

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('invalid json'));
      }
    });
    request.on('error', rejectBody);
  });
}

function json(response, status, body) {
  response
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}

function bearer(request) {
  return /^Bearer\s+([0-9a-f]{32,128})$/iu.exec(String(request.headers.authorization || ''))?.[1] || '';
}

export function isWebPushRequest(url) {
  return url === '/webpush' || url.startsWith('/webpush/') || url.startsWith('/webpush?');
}

const ACTIONS = {
  '/webpush/register': registerSubscription,
  '/webpush/unregister': unregisterSubscription,
  '/webpush/status': subscriptionStatus,
};

const refuse = (response, status, headers) => response.writeHead(status, headers).end();

function authenticateBrowser({ store, unauthorizedLimiter }, request, response) {
  const access = store.clientAccessForToken(bearer(request));
  // Per-browser credentials only: a legacy shared desktop token names no
  // client, so nothing it could bind would ever be revocable on its own.
  if (access?.clientId && store.hasClient(access.deviceId, access.clientId) === true) return access;
  if (!unauthorizedLimiter.allow(clientIp(request))) refuse(response, 429, { 'Retry-After': '60' });
  else refuse(response, 401);
  return null;
}

/** The validated endpoint of a mutation, or '' after answering 400/429. Every
 *  mutation counts against the limit, an idempotent one included: each is a
 *  credential lookup and possibly a synchronous write of the whole registry. */
function mutationEndpoint({ webPush, response, deviceId, clientId, body }) {
  const endpoint = validWebPushEndpoint(body?.endpoint);
  if (!endpoint) {
    refuse(response, 400);
    return '';
  }
  if (webPush.mutationLimiter && !webPush.mutationLimiter.allow(`${deviceId}\n${clientId}`)) {
    refuse(response, 429, { 'Retry-After': '60' });
    return '';
  }
  return endpoint;
}

function subscriptionStatus({ webPush, response, deviceId, clientId, body, supported }) {
  // Status may be asked before there is a subscription at all.
  if (body?.endpoint === undefined || body?.endpoint === null) {
    json(response, 200, { registered: false, supported });
    return;
  }
  const endpoint = validWebPushEndpoint(body.endpoint);
  if (!endpoint) {
    refuse(response, 400);
    return;
  }
  json(response, 200, { registered: webPush.registry.has(deviceId, clientId, endpoint), supported });
}

function unregisterSubscription(context) {
  const { webPush, response, deviceId, clientId } = context;
  const endpoint = mutationEndpoint(context);
  if (!endpoint) return;
  const result = webPush.registry.unbind(deviceId, clientId, endpoint);
  if (result === 'store-failed') {
    // Not removed: reporting success would let it come back on restart.
    refuse(response, 503, { 'Retry-After': '30' });
    return;
  }
  if (result === 'removed') webPush.publish(deviceId);
  json(response, 200, { removed: result === 'removed' });
}

function registerSubscription(context) {
  const { webPush, response, deviceId, clientId, body, supported } = context;
  const endpoint = mutationEndpoint(context);
  if (!endpoint) return;
  const sealed = validSealedKeys(body?.sealed);
  if (!sealed) {
    refuse(response, 400);
    return;
  }
  if (!supported) {
    json(response, 409, { error: 'unsupported' });
    return;
  }
  const result = webPush.registry.bind(deviceId, clientId, endpoint, sealed);
  if (result === 'quota') {
    json(response, 409, { error: 'quota' });
    return;
  }
  if (result === 'store-failed') {
    refuse(response, 503, { 'Retry-After': '30' });
    return;
  }
  // Re-stating what the relay already holds writes and announces nothing.
  if (result === 'ok') webPush.publish(deviceId);
  json(response, 200, { registered: true });
}

export async function handleWebPushRequest(context, request, response) {
  const { webPush } = context;
  const pathname = requestUrl(request)?.pathname || '';
  // An older relay never answers here at all; this one without an identity
  // says so the same way, and the browser keeps its legacy per-PC path.
  if (!webPush) {
    refuse(response, 404);
    return;
  }
  if (pathname === '/webpush/key') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      refuse(response, 405);
      return;
    }
    json(response, 200, { publicKey: webPush.publicKey });
    return;
  }
  const handler = ACTIONS[pathname];
  if (!handler) {
    refuse(response, 404);
    return;
  }
  if (request.method !== 'POST') {
    refuse(response, 405);
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    refuse(response, 403);
    return;
  }
  const access = authenticateBrowser(context, request, response);
  if (!access) return;
  let body;
  try {
    body = await readJson(request);
  } catch {
    refuse(response, 400);
    return;
  }
  const { deviceId, clientId } = access;
  // `supported`: this PC delivers through the relay. A PC that never said so
  // (an older desktop) keeps its own legacy registration instead.
  handler({ webPush, response, deviceId, clientId, body, supported: webPush.registry.isCapable(deviceId) });
}
