// Browser client registration and the approval handoff (`POST /claim`,
// `GET /claim/<claimId>`). The relay routes and stores; it never authorizes:
// the desktop decides, and the pairing material it returns is sealed to the
// browser's throwaway public key, so this hop forwards a box it cannot open.
import { randomUUID } from 'node:crypto';

import { clientProfile } from './device-store.mjs';
import { isRoutingId } from './ids.mjs';
import { browserSocketOriginAllowed, clientIp } from './relay-http.mjs';
import { pairingCookieHeaders, parseCookieToken } from './static-http.mjs';

export const MAX_PENDING_CLAIMS = 64;
// The global pool is shared by every desktop on the box, so it also needs a
// per-target and per-source share: otherwise one caller (or one named device)
// fills all 64 slots and every other install gets `busy` until they expire.
export const MAX_PENDING_CLAIMS_PER_DEVICE = 8;
export const MAX_PENDING_CLAIMS_PER_SOURCE = 8;
// Long enough to walk to the desktop and answer the prompt there.
export const CLAIM_TTL_MS = 300_000;

function requestToken(request, url) {
  const authorization = String(request.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+([0-9a-f]{32,128})$/i)?.[1] || '';
  return bearer || url.searchParams.get('token') || parseCookieToken(request.headers.cookie);
}

function readBoundedJson(request, maxBytes = 8 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

export async function handleClientRegistration(store, unauthorizedLimiter, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  let url;
  let body;
  try {
    url = new URL(request.url || '/', 'http://localhost');
    body = await readBoundedJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const token = requestToken(request, url);
  const access = store.clientAccessForToken(token);
  const clientId = String(body?.clientId || '');
  if (!access || !isRoutingId(clientId)) {
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Retry-After': '60' }).end();
      return;
    }
    response.writeHead(401).end();
    return;
  }
  const profile = {
    name: body?.name,
    platform: body?.platform,
    browser: body?.browser,
  };
  if (access.clientId) {
    if (access.clientId !== clientId) {
      response.writeHead(401).end();
      return;
    }
    store.touchClient(access.deviceId, clientId, profile);
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      .end(JSON.stringify({ clientId }));
    return;
  }
  const registered = store.registerClient(access.deviceId, clientId, profile);
  if (!registered) {
    response.writeHead(409).end();
    return;
  }
  response
    .writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...pairingCookieHeaders(registered.token, request),
    })
    .end(JSON.stringify({ clientId, token: registered.token }));
}

export async function handleClaimRequest(context, request, response) {
  const { store, liveDesktops, claims, unauthorizedLimiter } = context;
  const json = (status, body) => {
    response
      .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(body));
  };
  let url;
  let pathname;
  try {
    url = new URL(request.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  for (const [id, pending] of claims) {
    if (pending.expiresAt <= Date.now()) claims.delete(id);
  }
  if (request.method === 'GET' && pathname.startsWith('/claim/')) {
    const claim = claims.get(pathname.slice('/claim/'.length));
    if (!claim) {
      json(200, { status: 'expired' });
      return;
    }
    if (claim.status !== 'approved') {
      json(200, { status: claim.status });
      return;
    }
    // One-shot: the credential leaves this relay exactly once.
    claims.delete(claim.id);
    json(200, {
      status: 'approved',
      clientId: claim.clientId,
      token: claim.token,
      sealed: claim.sealed,
    });
    return;
  }
  if (request.method !== 'POST' || pathname !== '/claim') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readBoundedJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const deviceId = String(body?.deviceId || '');
  const clientId = String(body?.clientId || '');
  const publicKey = String(body?.publicKey || '');
  if (
    !isRoutingId(deviceId) ||
    !isRoutingId(clientId) ||
    !/^[A-Za-z0-9_-]{86,88}$/.test(publicKey) ||
    !store.isKnown(deviceId)
  ) {
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Retry-After': '60' }).end();
      return;
    }
    response.writeHead(404).end();
    return;
  }
  const entry = liveDesktops.get(deviceId);
  if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
    json(503, { status: 'offline' });
    return;
  }
  // Idempotent: a phone that reloads mid-approval (a backgrounded web app is
  // discarded freely) resumes the request the user is already looking at
  // instead of raising a second prompt on the desktop. A different key is a
  // different container and does get its own request.
  for (const [id, pending] of claims) {
    if (
      pending.status === 'pending' &&
      pending.deviceId === deviceId &&
      pending.clientId === clientId &&
      pending.publicKey === publicKey
    ) {
      json(202, { claimId: id });
      return;
    }
  }
  const source = clientIp(request);
  let deviceClaims = 0;
  let sourceClaims = 0;
  for (const pending of claims.values()) {
    if (pending.deviceId === deviceId) deviceClaims += 1;
    if (pending.source === source) sourceClaims += 1;
  }
  if (
    claims.size >= MAX_PENDING_CLAIMS ||
    deviceClaims >= MAX_PENDING_CLAIMS_PER_DEVICE ||
    sourceClaims >= MAX_PENDING_CLAIMS_PER_SOURCE
  ) {
    json(503, { status: 'busy' });
    return;
  }
  const profile = clientProfile(body, 'Web app');
  const id = randomUUID();
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  claims.set(id, {
    id,
    deviceId,
    clientId,
    publicKey,
    profile,
    source,
    status: 'pending',
    token: '',
    sealed: null,
    expiresAt,
  });
  try {
    entry.socket.send(
      JSON.stringify({
        type: 'client-claim',
        claimId: id,
        clientId,
        publicKey,
        expiresAt,
        ...profile,
      })
    );
  } catch {
    claims.delete(id);
    json(503, { status: 'offline' });
    return;
  }
  json(202, { claimId: id });
}
