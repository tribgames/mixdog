// Browser side of relay-owned Web Push (lib/web-push.mjs).
//
//   GET  /webpush/key                                   -> { publicKey }
//   POST /webpush/register   Bearer <client token>  { endpoint, sealed } -> { registered: true }
//                            409 { error: 'unsupported' } for a PC that never sent `webpush-ready`
//   POST /webpush/unregister Bearer <client token>  { endpoint }         -> { removed }
//   POST /webpush/status     Bearer <client token>  { endpoint? }        -> { registered, supported }
//
// register/unregister are rate limited per credential (429), write nothing
// when nothing changes, and answer 503 (retry) when the change could not be
// stored — memory is rolled back so the relay never reports a state it would
// lose on restart.
//
// The token is ONE PC's per-browser credential, so every association is made
// (and removed) with that PC's own pairing: a browser paired with three PCs
// calls register three times. Only an explicit Bearer header counts — never
// the pairing cookie, which names whichever PC the browser opened last.
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

export async function handleWebPushRequest({ webPush, store, unauthorizedLimiter }, request, response) {
  const pathname = requestUrl(request)?.pathname || '';
  // An older relay never answers here at all; this one without an identity
  // says so the same way, and the browser keeps its legacy per-PC path.
  if (!webPush) {
    response.writeHead(404).end();
    return;
  }
  if (pathname === '/webpush/key') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    json(response, 200, { publicKey: webPush.publicKey });
    return;
  }
  const action = { '/webpush/register': 'register', '/webpush/unregister': 'unregister', '/webpush/status': 'status' }[
    pathname
  ];
  if (!action) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  const access = store.clientAccessForToken(bearer(request));
  // Per-browser credentials only: a legacy shared desktop token names no
  // client, so nothing it could bind would ever be revocable on its own.
  if (!access?.clientId || store.hasClient(access.deviceId, access.clientId) !== true) {
    if (!unauthorizedLimiter.allow(clientIp(request))) response.writeHead(429, { 'Retry-After': '60' }).end();
    else response.writeHead(401).end();
    return;
  }
  let body;
  try {
    body = await readJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const { deviceId, clientId } = access;
  // `supported`: this PC delivers through the relay. A PC that never said so
  // (an older desktop) keeps its own legacy registration instead.
  const supported = webPush.registry.isCapable(deviceId);
  // Status may be asked before there is a subscription at all.
  if (action === 'status' && (body?.endpoint === undefined || body?.endpoint === null)) {
    json(response, 200, { registered: false, supported });
    return;
  }
  const endpoint = validWebPushEndpoint(body?.endpoint);
  if (!endpoint) {
    response.writeHead(400).end();
    return;
  }
  if (action === 'status') {
    json(response, 200, { registered: webPush.registry.has(deviceId, clientId, endpoint), supported });
    return;
  }
  // Every mutation counts, an idempotent one included: each is a credential
  // lookup and possibly a synchronous write of the whole registry.
  if (webPush.mutationLimiter && !webPush.mutationLimiter.allow(`${deviceId}\n${clientId}`)) {
    response.writeHead(429, { 'Retry-After': '60' }).end();
    return;
  }
  if (action === 'unregister') {
    const result = webPush.registry.unbind(deviceId, clientId, endpoint);
    if (result === 'store-failed') {
      // Not removed: reporting success would let it come back on restart.
      response.writeHead(503, { 'Retry-After': '30' }).end();
      return;
    }
    if (result === 'removed') webPush.publish(deviceId);
    json(response, 200, { removed: result === 'removed' });
    return;
  }
  const sealed = validSealedKeys(body?.sealed);
  if (!sealed) {
    response.writeHead(400).end();
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
    response.writeHead(503, { 'Retry-After': '30' }).end();
    return;
  }
  // Re-stating what the relay already holds writes and announces nothing.
  if (result === 'ok') webPush.publish(deviceId);
  json(response, 200, { registered: true });
}
